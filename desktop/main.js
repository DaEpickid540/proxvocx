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
import fsSync from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { fetchThroughProxy, FetchFailedError } from './bridge/fetcher.js';
import { UrlRejectedError } from './bridge/safe-url.js';
import { injectInput, inputAvailable, inputStatus, releaseAll } from './bridge/input.js';
import { startStaticServer, packagedPublicDir } from './bridge/static-server.js';
import {
  openScriptedBrowser, navigateScriptedBrowser, sendScriptedBrowserInput,
  closeScriptedBrowser, closeAllScriptedBrowsers, resizeScriptedBrowser,
} from './bridge/scripted-browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = packagedPublicDir();

/**
 * The user agent proxied requests go out with: an ordinary desktop Chrome,
 * matching the Chromium this app actually ships. The old self-describing
 * "compatible; proxvocx" string read as a bot, and plenty of sites answer a
 * bot with a stripped-down page, a challenge, or nothing at all — a large
 * part of why pages looked worse here than through other proxies.
 */
function browserUserAgent() {
  const major = String(process.versions.chrome || '126').split('.')[0];
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'linux' ? 'X11; Linux x86_64'
      : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const FETCH_CONFIG = {
  requestTimeoutMs: Number(process.env.PROXVOCX_TIMEOUT_MS) || 20_000,
  maxResponseBytes: Number(process.env.PROXVOCX_MAX_BYTES) || 512 * 1024,
  maxRedirects: 5,
  allowPrivateNetwork: process.env.PROXVOCX_ALLOW_PRIVATE === 'true',
  userAgent: process.env.PROXVOCX_USER_AGENT || browserUserAgent(),
};
/** Hard ceiling for the direct fast lane's per-response size (see pc-fetch.js). */
const FAST_LANE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Nothing launches this app from a terminal — it is started by the installer,
 * by Windows at login, or from the Start menu, and console output goes
 * nowhere in all three cases. A rolling file in userData is the only way to
 * find out afterwards why a start that produced no window also produced no
 * error.
 */
const logPath = () => path.join(app.getPath('userData'), 'connector.log');

function toFile(level, args) {
  try {
    const line = `${new Date().toISOString()} [${level}] ${args.map(String).join(' ')}\n`;
    // Keep it from growing without bound across months of daily launches.
    try {
      if (fsSync.statSync(logPath()).size > 512 * 1024) fsSync.unlinkSync(logPath());
    } catch { /* no log yet */ }
    fsSync.appendFileSync(logPath(), line);
  } catch { /* logging must never be the thing that breaks startup */ }
}

const log = {
  debug: () => {},
  info: (...args) => { console.log('[proxvocx]', ...args); toFile('info', args); },
  warn: (...args) => { console.warn('[proxvocx]', ...args); toFile('warn', args); },
  error: (...args) => { console.error('[proxvocx]', ...args); toFile('error', args); },
};

// A renderer that throws on boot is exactly the failure that leaves the tray
// icon sitting there with nothing behind it, so it has to reach the log too.
process.on('uncaughtException', (err) => log.error('uncaught:', err?.stack || err));
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err?.stack || err));

/**
 * The connector spends most of its life hidden in the tray, and Chromium
 * treats a hidden or covered window as one nobody is watching: it lowers the
 * renderer's priority and slows its timers. `backgroundThrottling: false` on
 * the window only covers the timers. The screen share's capture and encoder
 * run in that same renderer, so a demoted renderer shows up on the viewer as
 * frames that arrive late and in bursts. These switches keep it at full speed
 * whether the window is visible or not. They only take effect when set before
 * `ready`.
 */
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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

/**
 * On the first start after the installer has replaced a running copy of the
 * app, Firebase's stored session comes back empty and the connector waits at
 * a Google prompt — on a machine nobody is sitting at, which is the whole
 * point of a background connector, that means it silently never comes back
 * online after an update. Reloading the page does not help; the session only
 * reappears in a freshly started process, so start one.
 *
 * Only for a PC that was already set up (it has a machineId): a genuinely
 * new install has no session to lose and should just ask. The timestamp is
 * persisted so a PC that really is signed out relaunches once and then leaves
 * the prompt up instead of restarting forever.
 */
async function recoverStalledSignIn() {
  try {
    const store = await loadStore();
    if (!store.machineId) return;

    const since = Date.now() - (Number(store.authRelaunchAt) || 0);
    if (since < 5 * 60 * 1000) {
      log.warn('sign-in still not restored after a relaunch — leaving the prompt for the user');
      return;
    }

    await saveStore({ ...store, authRelaunchAt: Date.now() });
    log.warn('stored session did not restore on this start — relaunching once');
    app.relaunch();
    app.exit(0);
  } catch (err) {
    log.error('could not recover the stalled sign-in:', err.message);
  }
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
    icon: appIcon(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // This window IS the connector: its timers are the presence heartbeat
      // and its WebRTC peer connections are the sessions. Chromium throttles
      // both to a crawl in a hidden or minimised window, which for an app
      // whose whole job is to sit in the tray and stay reachable means going
      // silently offline the moment you close it to the tray.
      backgroundThrottling: false,
    },
  });

  // Either the hosted site (so the PC tracks whatever you deploy) or the copy
  // packaged with the app, served over localhost.
  const target = process.env.PROXVOCX_SITE_URL
    ? new URL('pc/', process.env.PROXVOCX_SITE_URL).toString()
    : `${staticServer.origin}/pc/`;

  if (CHROME_LIKE_USER_AGENT) mainWindow.webContents.setUserAgent(CHROME_LIKE_USER_AGENT);

  // Registered before the load, not after: 'ready-to-show' usually fires while
  // loadURL() is still awaiting, so attaching afterwards loses the race and a
  // window created with `show: false` then stays invisible forever — the
  // connector running with no way to reach its own UI.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('render-process-gone', (_e, d) =>
    log.error('renderer gone:', d?.reason, d?.exitCode));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log.error('did-fail-load:', code, desc, url));
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log.warn('renderer:', message);
  });

  // Records where boot actually got to. A connector that registers and
  // heartbeats reaches 'paired'/'pairing'; anything else stalled, and this is
  // the only trace of it on a launch that had no console attached.
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      let parsed;
      try {
        const state = await mainWindow.webContents.executeJavaScript(
          `JSON.stringify({
             url: location.href,
             status: document.querySelector('#statusPill')?.textContent,
             signInGateShown: document.querySelector('#signInGate') &&
               !document.querySelector('#signInGate').hidden,
             booting: document.querySelector('#boot') &&
               !document.querySelector('#boot').hidden,
           })`);
        log.info('boot state:', state);
        parsed = JSON.parse(state);
      } catch (err) {
        log.warn('boot state unavailable:', err.message);
        return;
      }
      if (parsed.signInGateShown) await recoverStalledSignIn();
    }, 25000);
  });

  log.info(`loading connector from ${target}`);
  await mainWindow.loadURL(target);

  // Belt and braces, in case the event fired before the listener attached.
  if (!mainWindow.isVisible()) mainWindow.show();

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
  tray = new Tray(appIcon('tray.png'));
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
    // The database lane keeps the configured cap — its responses are written
    // into Firebase whole. The direct fast lane (pc-fetch.js) asks for more,
    // up to a hard ceiling, since its bytes never touch the database.
    const asked = Number(request?.maxBytes);
    const config = Number.isFinite(asked) && asked > FETCH_CONFIG.maxResponseBytes
      ? { ...FETCH_CONFIG, maxResponseBytes: Math.min(asked, FAST_LANE_MAX_BYTES) }
      : FETCH_CONFIG;
    try {
      return await fetchThroughProxy(request, config, log);
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

  ipcMain.handle('proxvocx:scriptedOpen', (event, { sessionId, url, width, height, frameRate, quality }) => {
    openScriptedBrowser(sessionId, url, {
      width, height, frameRate, quality,
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

  ipcMain.on('proxvocx:scriptedResize', (_event, { sessionId, width, height }) => {
    resizeScriptedBrowser(sessionId, width, height);
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
      // A fixed port keeps http://localhost:<port> the same origin across
      // restarts — everything the page persists (the pasted Firebase config,
      // the signed-in auth session, this machine's id) lives in that origin's
      // localStorage/IndexedDB. A random port meant a fresh, empty origin on
      // almost every launch: config and sign-in silently vanished and the
      // page bounced back to the unconfigured portal before doing anything
      // visibly wrong. Falls back to a random port only if this one is
      // somehow already taken (e.g. a previous instance still shutting down).
      staticServer = await startStaticServer(PUBLIC_DIR, { port: 51820 }).catch((err) => {
        log.warn(`fixed port 51820 unavailable (${err.message}), falling back to a random port — sign-in may not persist across restarts`);
        return startStaticServer(PUBLIC_DIR);
      });
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
    // Quitting with a remote key still held would leave it held on this
    // desktop with nothing left running that could ever release it.
    await releaseAll().catch(() => {});
    await staticServer?.close().catch(() => {});
  });
}

/**
 * The app mark, from the packaged `public/icons`.
 *
 * This has to be a real, multi-resolution file rather than the single 16px
 * bitmap that used to live here: Windows draws the window and taskbar icon at
 * 32 and 48px, and handed a 16px source it upscales into mush. The .ico
 * carries every size from 16 to 256 so each surface gets one rendered for it,
 * and `nativeImage` picks up `tray@2x.png` on its own next to `tray.png` for
 * HiDPI trays.
 *
 * Note this only covers a *running* app. The icon on the .exe itself, the
 * installer, and the Start-menu shortcut come from electron-builder's `icon`
 * settings in package.json — without those, Windows shows Electron's default
 * atom no matter what this function returns.
 */
function appIcon(name) {
  const image = nativeImage.createFromPath(path.join(PUBLIC_DIR, 'icons', name));
  // An unreadable asset yields an empty image, and `new Tray()` throws on one.
  // Starting with a poor icon beats not starting.
  return image.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL) : image;
}

/* Last resort only: a 16px red dot, inline so it cannot itself go missing. */
const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAoklEQVR42mNkQAX/GYgEjIx' +
  'IGpgY6AhGLRi1YNSCUQtGLRi1YNSCUQuGgQX/8eD/pFrwn5D8fzIt+E9I/j+ZFvwnJP+fTAv+E5L/T6YF/wnJ/yfTgv' +
  '+E5P+TacF/QvL/ybTgPyH5/2Ra8J+Q/H8yLfhPSP4/mRb8JyT/n0wL/hOS/0+mBf8Jyf8n04L/hOT/k2nBf0Ly/8m04' +
  'D8h+f8AI2wjAV8XQ2gAAAAASUVORK5CYII=';
