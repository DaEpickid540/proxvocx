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
});
