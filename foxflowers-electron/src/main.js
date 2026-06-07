const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs   = require('fs');
const https = require('https');
const Store = require('electron-store');

const store = new Store({ encryptionKey: 'foxflowers-2024-secure' });

const uploadsDir = path.join(app.getPath('userData'), 'uploads');
const archiveDir = path.join(uploadsDir, 'archived');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

let doneFilenames = [];
let mainWindow;

function createWindow() {
  nativeTheme.themeSource = 'light';
  mainWindow = new BrowserWindow({
    width: 1100, height: 820, minWidth: 800, minHeight: 600,
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
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', () => archiveDonePhotos());
}

function archiveDonePhotos() {
  const exts = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif']);
  let files = [];
  try {
    files = fs.readdirSync(uploadsDir).filter(f => {
      const full = path.join(uploadsDir, f);
      return fs.statSync(full).isFile() && exts.has(path.extname(f).toLowerCase());
    });
  } catch(e) { return; }
  for (const file of files) {
    const src = path.join(uploadsDir, file);
    let dest  = path.join(archiveDir, file);
    try {
      if (fs.existsSync(dest)) {
        const ext = path.extname(file), base = path.basename(file, ext);
        dest = path.join(archiveDir, `${base}_${Date.now()}${ext}`);
      }
      fs.renameSync(src, dest);
    } catch(e) { console.error('Archive error', file, e.message); }
  }
  doneFilenames = [];
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('get-setting',     (e, key)        => store.get(key));
ipcMain.handle('set-setting',     (e, key, value) => { store.set(key, value); return true; });
ipcMain.handle('get-uploads-dir', ()              => uploadsDir);

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
        return { filename: f, path: full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch(e) { return []; }
});

ipcMain.handle('save-image', (e, { name, base64, mimeType }) => {
  const ext      = path.extname(name) || '.jpg';
  const base     = path.basename(name, ext).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
  const filename = `${Date.now()}_${base}${ext}`;
  const fullPath = path.join(uploadsDir, filename);
  const raw = base64.includes(',') ? base64.split(',')[1] : base64;
  fs.writeFileSync(fullPath, Buffer.from(raw, 'base64'));
  return { filename, path: fullPath };
});

ipcMain.handle('delete-image', (e, filename) => {
  const safe = path.basename(filename);
  const full = path.join(uploadsDir, safe);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  doneFilenames = doneFilenames.filter(f => f !== filename);
  return true;
});

ipcMain.handle('read-image-base64', (e, filename) => {
  const safe = path.basename(filename);
  const full = path.join(uploadsDir, safe);
  if (!fs.existsSync(full)) throw new Error('File not found: ' + safe);
  return fs.readFileSync(full).toString('base64');
});

ipcMain.handle('mark-done', (e, filenames) => {
  doneFilenames = [...new Set([...doneFilenames, ...filenames])];
  return true;
});

// ── Helper: today and today+30 in DD/MM/YYYY ─────────────────────────────────
function todayStr() {
  const d = new Date();
  return String(d.getDate()).padStart(2,'0') + '/' +
         String(d.getMonth()+1).padStart(2,'0') + '/' +
         d.getFullYear();
}
function dueDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return String(d.getDate()).padStart(2,'0') + '/' +
         String(d.getMonth()+1).padStart(2,'0') + '/' +
         d.getFullYear();
}

// ── Scan invoice ──────────────────────────────────────────────────────────────
ipcMain.handle('scan-invoice', async (e, { filename, model, apiKey }) => {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png',
    '.gif':'image/gif',  '.webp':'image/webp', '.heic':'image/jpeg', '.heif':'image/jpeg'
  };
  const mediaType = mimeMap[ext] || 'image/jpeg';
  const imgBase64 = fs.readFileSync(path.join(uploadsDir, path.basename(filename))).toString('base64');

  const today   = todayStr();
  const dueDate = dueDateStr();

  const prompt = `You are reading a handwritten invoice or order form for Fox Flowers, a flower shop in Ireland.

Extract the data and return it as a JSON array containing EXACTLY ONE object — one row per invoice, always, no matter how many items are listed.

Return ONLY the raw JSON array. No markdown, no code fences, no explanation.

Use these EXACT field names and rules:

"Customer"
  - The customer or company name being billed
  - Look across the whole invoice: "Account To", "Deliver To", "Ordered By", "Address", and any reference noted
  - Common customers:
    - "Musgrave" anywhere on the invoice → customer is "Musgrave"
    - Email ending in "@hse.ie" or text mentioning "HSE" → customer is "HSE"
    - Email ending in "@ucc.ie" or text mentioning "UCC" → customer is "UCC"
  - For printed email orders, look at "From:", the sender name, or "Dear [name]"
  - Use your best read of the handwriting; if truly unreadable write "[unclear]"

"InvoiceNo"
  - Look for any order number, invoice number, or PO number written on the invoice
  - May be labelled "PO#", "P.O.", "Order No", "Inv#", or written in a circled/boxed number
  - Strip any prefix, return just the number (e.g. "PO# 10540802" → "10540802")
  - If not visible, leave blank ""

"InvoiceDate"
  - Always set to today's date: ${today}

"DueDate"
  - Always set to: ${dueDate}

"Terms"
  - Always set to exactly: "Due on receipt"

"ItemDescription"
  - List EVERY item on the invoice with its price, one per line using semicolons to separate
  - Format each item as: [item name] [quantity if shown] [price]
  - CURRENCY SYMBOLS: € £ $ G C written before or after a number all mean euros — strip the symbol, keep the number
    - "€45", "G45", "C45", "45€", "£45" all mean 45.00 euros
  - CRITICAL RULE — handwritten annotations always override printed text:
    - If the printed invoice says "Delivery Fee: TBC" but a handwritten number appears next to "Delivery" → use the handwritten number
    - If the printed invoice says one price but a handwritten number is written beside it → use the handwritten number
    - Always look for handwritten corrections or additions on top of the printed form
  - If delivery is charged, include it as a line item too: "Delivery [amount]"
  - Example: "Hand-tied Bouquet x2 100.00ea; Delivery 7.00"
  - Example: "Reception Array 45.00; Delivery 8.00"
  - Example: "Altar piece x1 150.00; Windowsills x8 65.00ea; Side table x1; Delivery 60.00"
  - Product abbreviations: "H/T" or "HT" = Hand-tied Bouquet
  - Who ordered it and who it went to should also be included at the end
  - Never split into multiple rows

"ItemQuantity"
  - Always set to 1 (we combine everything into one row)

"ItemRate"
  - The subtotal of ALL items combined including delivery
  - CURRENCY SYMBOLS: € £ $ G C written before or after a number all mean euros — always strip them
    - "€100", "G100", "C100", "£100" all mean 100.00
  - Add up all items + delivery to get this number
  - Example: 2 x 100.00 + delivery 7.00 = 207.00
  - Example: 45.00 + delivery 8.00 = 53.00
  - If a TOTAL is written on the invoice, use that
  - Format as a plain number, no symbols (e.g. "207.00")
  - Two decimal places always

"ItemAmount"
  - Same value as ItemRate (total before any VAT)
  - Format as a plain number, no symbols
  - Two decimal places always

"TaxCode"
  - If "+VAT", "+vat", or "VAT" is written next to any price on the invoice, set this to "13.5% S"
  - Otherwise leave blank ""
  - When VAT is noted, the ItemAmount should be the VAT-inclusive total (e.g. REMAINING TO PAY, or price x 1.135)

CRITICAL RULES TO AVOID MISTAKES:
  - NEVER invent items, prices, or delivery charges that are not clearly visible on the invoice
  - If a field is blank or unreadable, leave it blank — do not guess or fill in imaginary values
  - Only include delivery in ItemDescription if a delivery charge is actually written on the invoice
  - The description should only contain what is literally written under "Flowers and Decoration Required" or equivalent

Examples of correct output:

Handwritten invoice with delivery:
[{"Customer":"Musgrave","InvoiceNo":"","InvoiceDate":"${today}","DueDate":"${dueDate}","Terms":"Due on receipt","ItemDescription":"Hand-tied Bouquet x1 75.00; Delivery 8.00 — ordered by Julie Durel, for Teresa at Fiachra Restaurant Douglas","ItemQuantity":"1","ItemRate":"83.00","ItemAmount":"83.00","TaxCode":""}]

Email order with 2 items and delivery:
[{"Customer":"UCC","InvoiceNo":"10540802","InvoiceDate":"${today}","DueDate":"${dueDate}","Terms":"Due on receipt","ItemDescription":"Hand-tied Bouquet x2 100.00ea; Delivery 7.00 — ordered by Mary McNicholas, for Prof Aideen Sullivan and Mary McNicholas","ItemQuantity":"1","ItemRate":"207.00","ItemAmount":"207.00","TaxCode":""}]`;

  const body = JSON.stringify({
    model: model || 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imgBase64 } },
        { type: 'text',  text: prompt }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         apiKey,
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
          const clean  = aiText.replace(/^```[a-z]*/m, '').replace(/```/g, '').trim();
          const rows   = JSON.parse(clean);
          resolve(Array.isArray(rows) ? rows : [rows]);
        } catch(e) {
          reject(new Error('Could not parse AI response: ' + data.slice(0, 120)));
        }
      });
    });
    req.on('error', e => reject(new Error('Network error: ' + e.message)));
    req.write(body);
    req.end();
  });
});

// ── Save CSV ──────────────────────────────────────────────────────────────────
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
