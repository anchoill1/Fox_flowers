const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs   = require('fs');
const https = require('https');
const Store = require('electron-store');
const XLSX  = require('xlsx');

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

// ── Today and today+30 in DD/MM/YYYY ─────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return String(d.getDate()).padStart(2,'0') + '/' +
         String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}
function dueDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return String(d.getDate()).padStart(2,'0') + '/' +
         String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
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

Extract the data and return it as a JSON array containing EXACTLY ONE object — one row per invoice, always.

Return ONLY the raw JSON array. No markdown, no code fences, no explanation.

CRITICAL RULES:
- NEVER invent or guess items, prices, or delivery charges not visible on the invoice
- NEVER split one invoice into multiple rows
- Handwritten annotations always override printed text (e.g. handwritten "Delivery 8" overrides printed "TBC")

Use these EXACT field names:

"Customer"
  - The customer or company name being billed
  - Look at: "Account To", "Deliver To", "Ordered By", "Address", any reference on the invoice
  - "Musgrave" anywhere → customer is "Musgrave"
  - "@hse.ie" email or "HSE" mentioned → customer is "HSE"
  - "@ucc.ie" email or "UCC" mentioned → customer is "UCC"
  - For email orders look at From: or sender name

"InvoiceNo"
  - Any PO#, order number, or invoice number visible
  - Leave blank if not visible

"InvoiceDate"
  - Always use today: ${today}

"DueDate"
  - Always use: ${dueDate}

"Terms"
  - Always: "Due on receipt"

"ItemDescription"
  - Combine everything into ONE string using this format:
    [item name and price]; [delivery and price if charged] — [who it went to], [who ordered it if different]
  - ITEM NAME RULES:
    - H/T, HT, H11, H1T, or anything resembling those = "Hand-tied Bouquet"
    - Always include the price of the item next to it
    - CURRENCY: € £ $ G C before or after a number all mean euros — strip the symbol
    - "G75" = €75 = 75.00, "C75" = €75 = 75.00, "€75" = 75.00
    - If "+VAT" is written next to a price, note it: "Hand-tied Bouquet 75.00 +VAT"
  - DELIVERY RULES:
    - Only include delivery if a number is actually written next to "DELIVERY" on the form
    - A plain number beside the DELIVERY line means that amount in euros e.g. "8" = Delivery 8.00
    - Handwritten delivery amount overrides any printed "TBC"
    - "+7 Dly" or "Dly 7" or "DLY 7" all mean Delivery 7.00
  - WHO IT WENT TO:
    - "FAO [name]" = For the Attention Of — that person is the recipient
    - Use "DELIVER TO" or "ACCOUNT TO" fields for recipient name and location
  - WHO ORDERED IT:
    - Only include if different from recipient
    - Found in "Ordered By", "Invoice [name]", or address/signature at bottom
  - Examples:
    - "Hand-tied Bouquet 75.00; Delivery 8.00 — Julie Durel, Fiachra Restaurant Douglas, ordered by Julie Durel Staff Musgrave"
    - "Bouquet 60.00; Delivery 7.00 — Margaret McKiernan, Mercy Hospital, ordered by Sinead Goggin"
    - "Reception Array 45.00 — Citco"
    - "Hand-tied Bouquet 60.00; Bright colours 7.00 — FAO Grainne, Bishopstown Comm School"

"ItemQuantity"
  - Always 1

"ItemRate"
  - The total of ALL items plus delivery
  - CURRENCY: € £ $ G C before or after a number = euros, strip the symbol
  - "G75" = 75.00, "C83" = 83.00
  - Add items + delivery yourself if no total is written
  - If "+VAT" is on the invoice, use the VAT-inclusive total (REMAINING TO PAY or price x 1.135)
  - Format: plain number, two decimal places e.g. "83.00"

"ItemAmount"
  - Same value as ItemRate
  - Format: plain number, two decimal places

"TaxCode"
  - If "+VAT", "+vat", or "VAT" is written on the invoice: "13.5% S"
  - Otherwise: ""

Examples of correct output:

Handwritten (H/T = Hand-tied Bouquet, G75 = €75, delivery 8 beside DELIVERY line, total 83):
[{"Customer":"Musgrave","InvoiceNo":"","InvoiceDate":"${today}","DueDate":"${dueDate}","Terms":"Due on receipt","ItemDescription":"Hand-tied Bouquet 75.00; Delivery 8.00 — Julie Durel, Fiachra Restaurant Douglas, ordered by Julie Durel Staff Musgrave","ItemQuantity":"1","ItemRate":"83.00","ItemAmount":"83.00","TaxCode":""}]

Email order (2 items @ €100ea + Dly 7 = 207 total):
[{"Customer":"UCC","InvoiceNo":"10540802","InvoiceDate":"${today}","DueDate":"${dueDate}","Terms":"Due on receipt","ItemDescription":"Hand-tied Bouquet x2 100.00ea; Delivery 7.00 — Prof Aideen Sullivan and Mary McNicholas, ordered by Mary McNicholas UCC","ItemQuantity":"1","ItemRate":"207.00","ItemAmount":"207.00","TaxCode":""}]

Invoice with VAT (150 + 13.5% VAT = 170.25 remaining to pay):
[{"Customer":"UCC","InvoiceNo":"","InvoiceDate":"${today}","DueDate":"${dueDate}","Terms":"Due on receipt","ItemDescription":"Vibrant Wow Colours arrangement 150.00 +VAT; pedestal stand — Westgate, ordered by Catherine Nevin UCC","ItemQuantity":"1","ItemRate":"170.25","ItemAmount":"170.25","TaxCode":"13.5% S"}]`;

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

// ── Save XLSX — one tab per month, new file per year ──────────────────────────
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const QB_COLS = ['*InvoiceNo','*Customer','*InvoiceDate','*DueDate','Terms',
                 'Location','Memo','Item(Product/Service)','ItemDescription',
                 'ItemQuantity','ItemRate','*ItemAmount','Service Date','PONumber','TaxCode'];

ipcMain.handle('save-xlsx', async (e, { rows, year }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save QuickBooks Excel File',
    defaultPath: path.join(app.getPath('documents'), `fox_flowers_${year}.xlsx`),
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
  });
  if (!filePath) return false;

  const wb = XLSX.utils.book_new();

  MONTHS.forEach((monthName, monthIdx) => {
    const monthStr = String(monthIdx + 1).padStart(2, '0');
    const monthRows = rows.filter(r => {
      // InvoiceDate is DD/MM/YYYY — check MM/YYYY
      const parts = (r.InvoiceDate || '').split('/');
      return parts[1] === monthStr && parts[2] === String(year);
    });

    const sheetRows = [QB_COLS];
    monthRows.forEach(r => {
      sheetRows.push([
        r.InvoiceNo     || '',
        r.Customer      || '',
        r.InvoiceDate   || '',
        r.DueDate       || '',
        r.Terms         || 'Due on receipt',
        '',                          // Location
        '',                          // Memo
        '',                          // Item(Product/Service)
        r.ItemDescription || '',
        r.ItemQuantity  || 1,
        parseFloat(r.ItemRate)   || 0,
        parseFloat(r.ItemAmount) || 0,
        r.DueDate       || '',       // Service Date = DueDate
        r.PONumber      || '',
        r.TaxCode       || ''
      ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    ws['!cols'] = [
      {wch:12},{wch:22},{wch:14},{wch:14},{wch:16},
      {wch:8},{wch:8},{wch:8},{wch:50},
      {wch:10},{wch:12},{wch:12},{wch:14},{wch:14},{wch:10}
    ];
    XLSX.utils.book_append_sheet(wb, ws, monthName);
  });

  // Summary sheet
  const summaryRows = [
    ['Fox Flowers — ' + year], [],
    ['Month', 'No. of Invoices', 'Total (€)']
  ];
  let yearTotal = 0;
  MONTHS.forEach((monthName, monthIdx) => {
    const monthStr = String(monthIdx + 1).padStart(2, '0');
    const mo = rows.filter(r => {
      const parts = (r.InvoiceDate || '').split('/');
      return parts[1] === monthStr && parts[2] === String(year);
    });
    const total = mo.reduce((s, r) => s + (parseFloat(r.ItemAmount) || 0), 0);
    yearTotal += total;
    summaryRows.push([monthName, mo.length, total]);
  });
  summaryRows.push([]);
  summaryRows.push(['YEAR TOTAL', rows.length, yearTotal]);

  const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows);
  summaryWs['!cols'] = [{wch:18},{wch:16},{wch:14}];
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary ' + year);

  XLSX.writeFile(wb, filePath);
  shell.showItemInFolder(filePath);
  return true;
});

// ── Save CSV (kept for backwards compatibility) ───────────────────────────────
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
