const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs   = require('fs');
const https = require('https');
const Store = require('electron-store');

// ── Persistent settings ───────────────────────────────────────────────────────
const store = new Store({
  encryptionKey: 'foxflowers-2024-secure'
});

// ── Folders ───────────────────────────────────────────────────────────────────
const uploadsDir = path.join(app.getPath('userData'), 'uploads');
const archiveDir = path.join(uploadsDir, 'archived');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

// Track which filenames the UI has marked as done
let doneFilenames = [];

let mainWindow;

function createWindow() {
  nativeTheme.themeSource = 'light';

  mainWindow = new BrowserWindow({
    width:  1100,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'Fox Flowers — Invoice Scanner',
    backgroundColor: '#f5f2ee',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 }
    } : {
      autoHideMenuBar: true
    })
  });

  // ── Archive done photos when the window is about to close ──────────────────
  mainWindow.on('close', () => {
    archiveDonePhotos();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function archiveDonePhotos() {
  // Archive ALL image files currently in uploads — everything gets archived on close
  const exts = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif']);
  let files = [];
  try {
    files = fs.readdirSync(uploadsDir).filter(f => {
      const full = path.join(uploadsDir, f);
      return fs.statSync(full).isFile() && exts.has(path.extname(f).toLowerCase());
    });
  } catch(e) { return; }

  for (const file of files) {
    const src  = path.join(uploadsDir, file);
    let   dest = path.join(archiveDir, file);
    try {
      // If a file with same name already exists in archive, add timestamp
      if (fs.existsSync(dest)) {
        const ext  = path.extname(file);
        const base = path.basename(file, ext);
        dest = path.join(archiveDir, `${base}_${Date.now()}${ext}`);
      }
      fs.renameSync(src, dest);
    } catch(e) {
      console.error('Archive error for', file, e.message);
    }
  }
  doneFilenames = [];
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC: settings ─────────────────────────────────────────────────────────────
ipcMain.handle('get-setting', (e, key)        => store.get(key));
ipcMain.handle('set-setting', (e, key, value) => { store.set(key, value); return true; });
ipcMain.handle('get-uploads-dir', ()          => uploadsDir);

// ── IPC: UI tells us which files are done (called after each successful scan) ─
ipcMain.handle('mark-done', (e, filenames) => {
  doneFilenames = [...new Set([...doneFilenames, ...filenames])];
  return true;
});

// ── IPC: list saved images (only from uploads root, not archived subfolder) ───
ipcMain.handle('list-images', () => {
  const exts = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif']);
  try {
    return fs.readdirSync(uploadsDir)
      .filter(f => {
        const full = path.join(uploadsDir, f);
        return fs.statSync(full).isFile() && exts.has(path.extname(f).toLowerCase());
      })
      .map(f => {
        const full = path.join(uploadsDir, f);
        const stat = fs.statSync(full);
        return { filename: f, path: full, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch(e) { return []; }
});

// ── IPC: save uploaded image to disk ─────────────────────────────────────────
ipcMain.handle('save-image', (e, { name, base64, mimeType }) => {
  const ext  = path.extname(name) || '.jpg';
  const base = path.basename(name, ext).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
  const filename = `${Date.now()}_${base}${ext}`;
  const fullPath = path.join(uploadsDir, filename);
  fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'));
  return { filename, path: fullPath };
});

// ── IPC: delete image ─────────────────────────────────────────────────────────
ipcMain.handle('delete-image', (e, filename) => {
  const safe = path.basename(filename);
  const full = path.join(uploadsDir, safe);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  // Remove from done list too
  doneFilenames = doneFilenames.filter(f => f !== filename);
  return true;
});

// ── IPC: read image as base64 ─────────────────────────────────────────────────
ipcMain.handle('read-image-base64', (e, filename) => {
  const safe = path.basename(filename);
  const full = path.join(uploadsDir, safe);
  if (!fs.existsSync(full)) throw new Error('File not found: ' + safe);
  return fs.readFileSync(full).toString('base64');
});

// ── IPC: call Anthropic API ───────────────────────────────────────────────────
ipcMain.handle('scan-invoice', async (e, { filename, model, apiKey }) => {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp' };
  const mediaType = mimeMap[ext] || 'image/jpeg';
  const imgBase64 = fs.readFileSync(path.join(uploadsDir, path.basename(filename))).toString('base64');

  const prompt = `You are helping a flower shop called Fox Flowers read their handwritten order forms and invoices.

Look at this handwritten invoice or order form and extract the data into a JSON array ready to import into QuickBooks Online.

IMPORTANT: Always return exactly ONE row per invoice, no matter how many items are listed on it.

Return ONLY a valid JSON array containing a single object with these EXACT JSON keys:
- "InvoiceNo": invoice or order number if visible, otherwise leave blank
- "Customer": the name of the person or company being billed
- "InvoiceDate": the order or invoice date in DD/MM/YYYY format
- "DueDate": delivery date if shown in DD/MM/YYYY format, otherwise leave blank
- "Terms": payment terms if shown (e.g. "Due on receipt"), otherwise "Due on receipt"
- "Memo": delivery time, special instructions, address or any notes
- "ItemDescription": list ALL items ordered in one single comma-separated description. Include who the order is for and who ordered it if a company. Example: "Vibrant wedding bouquet, cow rug centrepiece, smudge bundle for Westside Hotel, ordered by Catherine Nevin"
- "ItemQuantity": total quantity of all items combined, otherwise 1
- "ItemRate": leave blank
- "ItemAmount": the TOTAL or REMAINING TO PAY amount for the whole invoice

Never split one invoice into multiple rows. One invoice = one row, always.
Return ONLY the raw JSON array. No markdown. No code fences. No explanation.`;

  const body = JSON.stringify({
    model: model || 'claude-sonnet-4-5-20250929',
    max_tokens: 1000,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: imgBase64 } },
      { type: 'text', text: prompt }
    ]}]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'API error'));
          const textBlock = Array.isArray(parsed.content) && parsed.content.find(b => b.type === 'text');
          if (!textBlock) return reject(new Error('No text in response'));
          const aiText = textBlock.text.trim();
          const clean  = aiText.replace(/^```[\w]*\n?/m,'').replace(/```$/m,'').trim();
          const rows   = JSON.parse(clean);
          resolve(Array.isArray(rows) ? rows : [rows]);
        } catch(e) { reject(new Error('Could not parse response: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', e => reject(new Error('Network error: ' + e.message)));
    req.write(body);
    req.end();
  });
});

// ── IPC: save CSV ─────────────────────────────────────────────────────────────
ipcMain.handle('save-csv', async (e, csvContent) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save QuickBooks CSV',
    defaultPath: path.join(app.getPath('documents'), 'fox_flowers_quickbooks.csv'),
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (!filePath) return false;
  fs.writeFileSync(filePath, csvContent, 'utf8');
  shell.showItemInFolder(filePath);
  return true;
});
