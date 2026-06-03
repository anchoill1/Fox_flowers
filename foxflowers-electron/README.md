# 🌸 Fox Flowers Invoice Scanner

A desktop app for Mac and Windows that reads handwritten invoices using AI and exports a QuickBooks CSV.

---

## PART 1 — Setting up on your Mac (one time only)

### Step 1 — Install Node.js
Go to https://nodejs.org and download the LTS version. Install it like any normal Mac app.

To check it worked, open Terminal and type:
```
node -v
```
You should see a version number like `v20.11.0`.

### Step 2 — Open the project folder in Terminal
Open Terminal, then type `cd ` (with a space after it), then drag the `foxflowers-electron` folder onto the Terminal window. Press Enter.

### Step 3 — Fix permissions (if needed) and install
If you get a permissions error, run this first:
```
sudo chown -R $(whoami) ~/.npm
```
Then install the project dependencies:
```
npm install
```
This takes a minute or two — it's downloading everything the app needs.

### Step 4 — Test it works
```
npm start
```
The app should open on your screen. Close it when you're happy it works.

---

## PART 2 — Building the app to distribute

### Build for Mac
In Terminal, inside the project folder, run:
```
npm run build:mac
```
When it finishes, open the `dist/` folder inside the project. You'll find a `.dmg` file — this is the Mac installer you send to Mac users.

### Build for Windows
In the same Terminal, run:
```
npm run build:win
```
When it finishes, look in the `dist/` folder again. You'll find a `.exe` file — this is the Windows installer.

You can build both at once with:
```
npm run build:all
```

---

## PART 3 — Sending the app to someone

**For Mac users:**
Send them the `.dmg` file (via Google Drive, Dropbox, or USB stick). They:
1. Open the `.dmg`
2. Drag the app to their Applications folder
3. Double-click to open it

**For Windows users:**
Send them the `.exe` file (via Google Drive, Dropbox, or USB stick — avoid email as `.exe` files often get blocked). They:
1. Double-click the `.exe`
2. It installs automatically with a desktop shortcut
3. Open it from the desktop shortcut

**First time the app opens (Mac or Windows):**
It will ask for an Anthropic API key. Each user needs their own — they get one free at https://console.anthropic.com → API Keys. The key is saved securely on their device and never asked for again.

---

## PART 4 — Making changes and rebuilding

If you update the app code, just run the build command again:
```
npm run build:mac
npm run build:win
```
The new installers will replace the old ones in the `dist/` folder. Send the new installer to your users.

---

## Where invoice photos are saved on each user's computer

- **Mac**: `~/Library/Application Support/fox-flowers-invoices/uploads/`
- **Windows**: `C:\Users\YourName\AppData\Roaming\fox-flowers-invoices\uploads\`

Photos stay there permanently and reload every time the app opens.

---

## Project files (for reference)
```
foxflowers-electron/
├── src/
│   ├── main.js       ← handles file saving and API calls
│   ├── preload.js    ← connects the UI to the system
│   └── index.html    ← the app interface
├── assets/
│   ├── icon.icns     ← Mac app icon
│   └── icon.ico      ← Windows app icon
├── dist/             ← built installers go here (created after you build)
└── package.json
```
