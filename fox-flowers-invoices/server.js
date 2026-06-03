require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Uploads folder ────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── Multer: save uploaded files to disk with original extension ───────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname) || '.jpg';
    const base = path.basename(file.originalname, ext)
                   .replace(/[^a-zA-Z0-9_\-]/g, '_')
                   .slice(0, 80);
    const name = `${Date.now()}_${base}${ext}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },   // 20 MB per file
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|gif|webp|heic|heif)/.test(file.mimetype)
            || /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(file.originalname);
    cb(null, ok);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded images so the browser can display thumbnails
app.use('/uploads', express.static(UPLOADS_DIR));

// ── GET /api/images — list all saved invoice images ───────────────────────────
app.get('/api/images', (req, res) => {
  const exts = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif']);
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => exts.has(path.extname(f).toLowerCase()))
      .map(f => {
        const stat = fs.statSync(path.join(UPLOADS_DIR, f));
        return { filename: f, url: `/uploads/${f}`, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);   // newest first
    res.json({ files });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/upload — save one or more images to disk ────────────────────────
app.post('/api/upload', upload.array('images', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files received' });
  }
  const saved = req.files.map(f => ({ filename: f.filename, url: `/uploads/${f.filename}`, size: f.size }));
  res.json({ saved });
});

// ── DELETE /api/images/:filename — remove an image from disk ──────────────────
app.delete('/api/images/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);   // prevent path traversal
  const full = path.join(UPLOADS_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(full);
    res.json({ deleted: safe });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/scan — proxy to Anthropic, reads image from disk ────────────────
app.post('/api/scan', async (req, res) => {
  const { filename, model } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' });

  const safe = path.basename(filename);
  const full = path.join(UPLOADS_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Image not found on disk' });

  let base64, mediaType;
  try {
    base64    = fs.readFileSync(full).toString('base64');
    const ext = path.extname(safe).toLowerCase();
    const map = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp' };
    mediaType = map[ext] || 'image/jpeg';
  } catch(e) {
    return res.status(500).json({ error: 'Could not read image file: ' + e.message });
  }

  const prompt = `You are helping a flower shop called Fox Flowers read their handwritten order forms and invoices.

Look at this handwritten invoice or order form and extract the data into a JSON array ready to import into QuickBooks Online.

Return ONLY a valid JSON array of objects. Use these EXACT JSON keys (these are the QuickBooks column names):
- "InvoiceNo": invoice or order number if visible, otherwise leave blank
- "Customer": the name of the person or company being billed
- "InvoiceDate": the order or invoice date in DD/MM/YYYY format
- "DueDate": delivery date if shown in DD/MM/YYYY format, otherwise leave blank
- "Terms": payment terms if shown (e.g. "Due on receipt"), otherwise "Due on receipt"
- "Memo": delivery time, special instructions, or any notes (e.g. "Delivery between 11am - 1pm")
- "ItemDescription": describe what was ordered combined with who it is for and who ordered it if a company. Example: "Vibrant bouquet for wedding at Westside, ordered by Catherine Nevin/UCC". Be descriptive but concise.
- "ItemQuantity": quantity if shown, otherwise 1
- "ItemRate": price per unit if shown, otherwise leave blank
- "ItemAmount": the REMAINING TO PAY amount if shown, otherwise the total amount

If there are multiple line items on one invoice, return one object per line item. Repeat the InvoiceNo and Customer on each row.
Return ONLY the raw JSON array. No markdown. No code fences. No explanation.`;

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-5-20250929',
        max_tokens: 1000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt }
        ]}]
      })
    });

    const data = await apiRes.json();

    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ error: data?.error?.message || 'Anthropic API error ' + apiRes.status });
    }

    const textBlock = Array.isArray(data.content) && data.content.find(b => b.type === 'text');
    if (!textBlock) return res.status(500).json({ error: 'No text in Anthropic response' });

    const aiText = textBlock.text.trim();
    let rows;
    try {
      const clean = aiText.replace(/^```[\w]*\n?/m,'').replace(/```$/m,'').trim();
      const parsed = JSON.parse(clean);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch(e) {
      return res.status(500).json({ error: 'Could not parse AI output: ' + aiText.slice(0, 120) });
    }

    res.json({ rows });
  } catch(e) {
    res.status(500).json({ error: 'Network error calling Anthropic: ' + e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌸 Fox Flowers Invoice Scanner running at http://localhost:${PORT}`);
  console.log(`   Invoices saved to: ${UPLOADS_DIR}`);
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY.startsWith('sk-ant-your')) {
    console.warn('\n⚠  Add your Anthropic API key to .env (ANTHROPIC_API_KEY=sk-ant-...)\n');
  }
});
