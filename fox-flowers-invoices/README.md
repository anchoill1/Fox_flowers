# 🌸 Fox Flowers — Invoice Scanner

Bulk invoice scanner that reads handwritten invoices with AI and exports a QuickBooks CSV.

## Setup (one time only)

**1. Install Node.js** (if you don't have it)
Download from https://nodejs.org — install the LTS version.

**2. Install dependencies**
Open a terminal in this folder and run:
```
npm install
```

**3. Add your Anthropic API key**
Open the `.env` file in this folder and replace the placeholder:
```
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
```
Get your key from: https://console.anthropic.com → API Keys

---

## Running the app

Every time you want to use it, open a terminal in this folder and run:
```
npm start
```

Then open your browser and go to:
```
http://localhost:3000
```

To stop the server: press `Ctrl + C` in the terminal.

---

## Where are my invoice photos saved?

In the `uploads/` folder inside this project folder. They stay there permanently — every time you start the app they'll be loaded automatically.

---

## Folder structure

```
fox-flowers-invoices/
├── server.js          ← the local server
├── package.json
├── .env               ← your API key (keep this private)
├── uploads/           ← invoice photos saved here (created automatically)
└── public/
    └── index.html     ← the app UI
```
