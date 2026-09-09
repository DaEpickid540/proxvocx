/**
 * The only thing the connector page can see of Electron.
 *
 * Nothing here takes a function or a path from the page — every call is a
 * fixed-shape message to a named handler in main. `window.proxvocx` existing
 * at all is what tells the page it is running inside the desktop app, which
 * is how one codebase serves both the hosted site and this window.
 */
const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('../package.json');

contextBridge.exposeInMainWorld('proxvocx', {
  version,
  platform: process.platform === 'win32' ? 'Windows'
    : process.platform === 'darwin' ? 'macOS' : 'Linux',

  hostname: () => ipcRenderer.invoke('proxvocx:hostname'),

  /** Cross-origin HTTP, SSRF-guarded, performed in the main process. */
  fetch: (request) => ipcRenderer.invoke('proxvocx:fetch', request),

  listScreenSources: () => ipcRenderer.invoke('proxvocx:screenSources'),

  inputAvailable: () => ipcRenderer.invoke('proxvocx:inputAvailable'),
  injectInput: (event) => ipcRenderer.invoke('proxvocx:injectInput', event),

  loadStore: () => ipcRenderer.invoke('proxvocx:loadStore'),
  saveStore: (value) => ipcRenderer.invoke('proxvocx:saveStore', value),

  getAutoLaunch: () => ipcRenderer.invoke('proxvocx:getAutoLaunch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('proxvocx:setAutoLaunch', enabled),

  /** Fire-and-forget: keeps the tray tooltip honest. */
  reportStatus: (status) => ipcRenderer.send('proxvocx:status', status),

  /** Tells main which display input events should land on. */
  setActiveDisplay: (displayId) => ipcRenderer.send('proxvocx:activeDisplay', displayId),

  /**
   * A real, scripted browser tab running on the PC for one 'scripted'
   * session — Browser mode with JavaScript turned on. Frames and navigation
   * state arrive as events rather than return values, since they change
   * continuously for as long as the session is open.
   */
  scriptedOpen: (opts) => ipcRenderer.invoke('proxvocx:scriptedOpen', opts),
  scriptedResize: (sessionId, width, height) =>
    ipcRenderer.send('proxvocx:scriptedResize', { sessionId, width, height }),
  scriptedNavigate: (sessionId, action, url) =>
    ipcRenderer.send('proxvocx:scriptedNavigate', { sessionId, action, url }),
  scriptedInput: (sessionId, inputEvent) =>
    ipcRenderer.send('proxvocx:scriptedInput', { sessionId, inputEvent }),
  scriptedClose: (sessionId) => ipcRenderer.send('proxvocx:scriptedClose', { sessionId }),

  onScriptedFrame: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('proxvocx:scriptedFrame', listener);
    return () => ipcRenderer.removeListener('proxvocx:scriptedFrame', listener);
  },
  onScriptedNavState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('proxvocx:scriptedNavState', listener);
    return () => ipcRenderer.removeListener('proxvocx:scriptedNavState', listener);
  },
});
