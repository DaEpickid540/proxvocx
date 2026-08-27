/**
 * proxvocx desktop shell.
 *
 * There is deliberately no UI in this process. The window loads the very same
 * PC connector page that Firebase Hosting serves, and everything visible is
 * that page. Main's whole job is to supply the three things a web page cannot
 * do for itself:
 *
 *   1. fetch other origins without CORS   (the proxy)
 *   2. capture a display without a picker (the screen stream)
 *   3. synthesise mouse and keyboard      (remote control)
 *
 * plus the usual desktop furniture: a tray icon, run-at-login, single instance.
 */
import { app, BrowserWindow, ipcMain, desktopCapturer, screen, Tray, Menu, nativeImage, shell, dialog, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { fetchThroughProxy, FetchFailedError } from './bridge/fetcher.js';
import { UrlRejectedError } from './bridge/safe-url.js';
import { injectInput, inputAvailable, inputStatus } from './bridge/input.js';
import { startStaticServer, packagedPublicDir } from './bridge/static-server.js';
import {
  openScriptedBrowser, navigateScriptedBrowser, sendScriptedBrowserInput,
  closeScriptedBrowser, closeAllScriptedBrowsers,
} from './bridge/scripted-browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = packagedPublicDir();

const FETCH_CONFIG = {
  requestTimeoutMs: Number(process.env.PROXVOCX_TIMEOUT_MS) || 20_000,
  maxResponseBytes: Number(process.env.PROXVOCX_MAX_BYTES) || 512 * 1024,
  maxRedirects: 5,
  allowPrivateNetwork: process.env.PROXVOCX_ALLOW_PRIVATE === 'true',
  userAgent: process.env.PROXVOCX_USER_AGENT
    || 'Mozilla/5.0 (compatible; proxvocx/1.0; +https://github.com/proxvocx)',
};

const log = {
  debug: () => {},
  info: (...args) => console.log('[proxvocx]', ...args),
  warn: (...args) => console.warn('[proxvocx]', ...args),
  error: (...args) => console.error('[proxvocx]', ...args),
};

let mainWindow = null;
let tray = null;
let staticServer = null;
let quitting = false;
/** Bounds of the display currently being shared, in real desktop pixels. */
let activeDisplayBounds = null;

/**
 * Google's OAuth consent screen hard-refuses any user agent that contains an
 * "Electron/" token ("disallowed_useragent") — it does not matter how recent
 * the underlying Chromium is. Sign-in is the one Google-only auth method this
 * app has, so this is not optional: strip the token everywhere Chromium would
 * otherwise send it, both for the main window and the OAuth popup it opens.
 */
const CHROME_LIKE_USER_AGENT = process.versions.chrome
  ? `Mozilla/5.0 (${process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'}) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
  : undefined;

/** Google's own consent flow and Firebase's redirect-back page for it. */
function isAuthPopupUrl(url) {
  try {
    const host = new URL(url).host;
    return host === 'accounts.google.com' || /\.firebaseapp\.com$/.test(host);
  } catch {
    return false;
  }
}

/* ── persistent store ────────────────────────────────────────── */

const storePath = () => path.join(app.getPath('userData'), 'connector.json');

async function loadStore() {
  try {
    return JSON.parse(await fs.readFile(storePath(), 'utf8'));
  } catch {
    return {};
  }
}

async function saveStore(value) {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(value, null, 2), 'utf8');
  return value;
}

/* ── window ──────────────────────────────────────────────────── */

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#1a1a1e',
    autoHideMenuBar: true,
    title: 'proxvocx connector',
    icon: nativeImage.createFromDataURL(TRAY_ICON_DATA_URL),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Either the hosted site (so the PC tracks whatever you deploy) or the copy
  // packaged with the app, served over localhost.
  const target = process.env.PROXVOCX_SITE_URL
    ? new URL('pc/', process.env.PROXVOCX_SITE_URL).toString()
    : `${staticServer.origin}/pc/`;

  if (CHROME_LIKE_USER_AGENT) mainWindow.webContents.setUserAgent(CHROME_LIKE_USER_AGENT);

  log.info(`loading connector from ${target}`);
  await mainWindow.loadURL(target);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Google's sign-in popup has to open as a real Electron window sharing this
  // one's session, or the OAuth callback can never post its result back to
  // the page that opened it. Everything else opens in the real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopupUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 480,
          height: 640,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (popup) => {
    if (CHROME_LIKE_USER_AGENT) popup.webContents.setUserAgent(CHROME_LIKE_USER_AGENT);
  });

  // Closing the window keeps the connector running in the tray — the whole
  // point is that the PC stays reachable.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('proxvocx — starting');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open connector', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { quitting = true; app.quit(); },
    },
  ]));
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else { mainWindow?.show(); mainWindow?.focus(); }
  });
}

/* ── IPC: the bridge the page talks to ───────────────────────── */

function registerIpc() {
  ipcMain.handle('proxvocx:hostname', () => {
    const label = process.platform === 'win32' ? 'Windows'
      : process.platform === 'darwin' ? 'Mac' : 'Linux';
    return `${os.hostname()} (${label})`;
  });

  ipcMain.handle('proxvocx:fetch', async (_event, request) => {
    try {
      return await fetchThroughProxy(request, FETCH_CONFIG, log);
    } catch (err) {
      // Re-thrown across IPC as a plain message, so tag the code onto it for
      // the page to classify.
      const code = err instanceof UrlRejectedError ? 'ERR_URL_REJECTED'
        : err instanceof FetchFailedError ? err.code
        : 'ERR_FETCH_FAILED';
      const wrapped = new Error(err.message);
      wrapped.name = code;
      throw wrapped;
    }
  });

  ipcMain.handle('proxvocx:screenSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const displays = screen.getAllDisplays();
    return sources.map((source) => {
      const display = displays.find((d) => String(d.id) === String(source.display_id))
        || screen.getPrimaryDisplay();
      return {
        id: source.id,
        name: source.name,
        displayId: String(source.display_id || display.id),
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
      };
    });
  });

  ipcMain.handle('proxvocx:inputAvailable', () => inputAvailable());

  ipcMain.handle('proxvocx:injectInput', async (_event, event) => {
    const bounds = boundsForEvent(event);
    try {
      await injectInput(event, bounds);
      return true;
    } catch (err) {
      throw new Error(err.message || inputStatus());
    }
  });

  ipcMain.handle('proxvocx:loadStore', () => loadStore());
  ipcMain.handle('proxvocx:saveStore', (_event, value) => saveStore(value));

  ipcMain.handle('proxvocx:getAutoLaunch', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('proxvocx:setAutoLaunch', (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.on('proxvocx:status', (_event, status) => {
    tray?.setToolTip(`proxvocx — ${status?.text || 'idle'}`);
  });

  ipcMain.on('proxvocx:activeDisplay', (_event, displayId) => {
    const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
    activeDisplayBounds = display?.bounds || null;
  });

  /* ── scripted browser: a real, JS-enabled tab for one 'scripted' session ── */

  ipcMain.handle('proxvocx:scriptedOpen', (event, { sessionId, url, width, height, frameRate }) => {
    openScriptedBrowser(sessionId, url, {
      width, height, frameRate,
      onFrame: (jpeg, w, h) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send('proxvocx:scriptedFrame', { sessionId, jpeg, width: w, height: h });
      },
      onNavState: (state) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send('proxvocx:scriptedNavState', { sessionId, ...state });
      },
    });
    return true;
  });

  ipcMain.on('proxvocx:scriptedNavigate', (_event, { sessionId, action, url }) => {
    navigateScriptedBrowser(sessionId, { action, url });
  });

  ipcMain.on('proxvocx:scriptedInput', (_event, { sessionId, inputEvent }) => {
    sendScriptedBrowserInput(sessionId, inputEvent);
  });

  ipcMain.on('proxvocx:scriptedClose', (_event, { sessionId }) => {
    closeScriptedBrowser(sessionId);
  });
}

/**
 * Normalised coordinates need a rectangle to land in. Prefer the display the
 * page told us it is sharing; fall back to the primary one.
 */
function boundsForEvent(event) {
  if (activeDisplayBounds) return activeDisplayBounds;
  if (event?.screen?.width && event?.screen?.height) {
    const primary = screen.getPrimaryDisplay();
    return primary.bounds;
  }
  return screen.getPrimaryDisplay().bounds;
}

/* ── lifecycle ───────────────────────────────────────────────── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    try {
      if (CHROME_LIKE_USER_AGENT) session.defaultSession.setUserAgent(CHROME_LIKE_USER_AGENT);
      staticServer = await startStaticServer(PUBLIC_DIR);
      registerIpc();
      createTray();
      await createWindow();
      log.info(`input backend: ${(await inputAvailable()) ? 'ready' : inputStatus()}`);
    } catch (err) {
      log.error(err);
      dialog.showErrorBox('proxvocx could not start', err.message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    // Deliberately does nothing: the tray keeps the connector alive.
  });

  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
  });

  app.on('before-quit', async () => {
    quitting = true;
    closeAllScriptedBrowsers();
    await staticServer?.close().catch(() => {});
  });
}

/* A 16px red dot — matches the site's logo mark. */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAoklEQVR42mNkQAX/GYgEjIx' +
  'IGpgY6AhGLRi1YNSCUQtGLRi1YNSCUQuGgQX/8eD/pFrwn5D8fzIt+E9I/j+ZFvwnJP+fTAv+E5L/T6YF/wnJ/yfTgv' +
  '+E5P+TacF/QvL/ybTgPyH5/2Ra8J+Q/H8yLfhPSP4/mRb8JyT/n0wL/hOS/0+mBf8Jyf8n04L/hOT/k2nBf0Ly/8m04' +
  'D8h+f8AI2wjAV8XQ2gAAAAASUVORK5CYII=';
