// Macro Maha — Electron main process.
// Owns the window and all HTTP calls to Yahoo Finance (the renderer cannot
// fetch query1.finance.yahoo.com directly because Yahoo sends no CORS headers).
// The realtime websocket lives in the renderer — websockets are CORS-exempt.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const yahoo = require('./src/yahoo');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1180,
    minHeight: 700,
    backgroundColor: '#05080f',
    title: 'Macro Maha',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open target=_blank / external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---- IPC: Yahoo Finance data plane -----------------------------------------

function wrap(fn) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };
}

ipcMain.handle('yahoo:quote', wrap((symbols) => yahoo.quote(symbols)));
ipcMain.handle('yahoo:history', wrap((symbol, range, interval) => yahoo.history(symbol, range, interval)));
ipcMain.handle('yahoo:search', wrap((query) => yahoo.search(query)));
ipcMain.handle('yahoo:summary', wrap((symbol) => yahoo.quoteSummary(symbol)));
ipcMain.handle('app:openExternal', wrap((url) => {
  if (!/^https?:/i.test(String(url))) throw new Error('Only http(s) URLs may be opened');
  return shell.openExternal(String(url));
}));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
