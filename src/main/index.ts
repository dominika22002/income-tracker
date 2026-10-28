import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import {
  getIpcChannels,
  handleOAuthCallback,
  registerIpcHandlers,
} from './ipc';

let mainWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const protocolName = 'income-tracker';

if (!app.isDefaultProtocolClient(protocolName)) {
  app.setAsDefaultProtocolClient(protocolName);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: 'Income Tracker',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  registerIpcHandlers(window);

  window.once('ready-to-show', () => {
    window.show();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../../dist/index.html'));
  }

  return window;
}

app.whenReady().then(() => {
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('open-url', (event, callbackUrl) => {
  event.preventDefault();
  if (!mainWindow) {
    return;
  }
  handleOAuthCallback(mainWindow, callbackUrl);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const callbackUrl = argv.find((arg) =>
      arg.startsWith(`${protocolName}://`),
    );
    if (callbackUrl && mainWindow) {
      handleOAuthCallback(mainWindow, callbackUrl);
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

process.on('uncaughtException', (error) => {
  if (mainWindow) {
    mainWindow.webContents.send(getIpcChannels().oauthCallback, {
      ok: false,
      error: `Unhandled main process error: ${error.message}`,
    });
  }
});
