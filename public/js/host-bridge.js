/**
 * The seam between the PC page and whatever is hosting it.
 *
 * Loaded from Firebase Hosting in a browser tab, `window.proxvocx` is absent
 * and this degrades to a read-only host: it can still pair and report status,
 * but it cannot fetch cross-origin, capture the screen without a picker, or
 * move the mouse. Loaded inside the desktop app, the preload script supplies
 * all three and the very same page becomes a full connector.
 *
 * Everything the page needs to know about its host is behind `hostBridge` so
 * there is exactly one place to look when adding a native capability.
 */

const native = typeof window !== 'undefined' ? window.proxvocx : undefined;

export const isDesktop = !!native;

export const hostBridge = {
  isDesktop,

  /** Version of the desktop shell, or null in a browser tab. */
  version: native?.version ?? null,
  platform: native?.platform ?? guessPlatform(),

  /** Falls back to a browser-friendly label so the machine list is readable. */
  async defaultName() {
    if (native?.hostname) {
      try { return await native.hostname(); } catch { /* fall through */ }
    }
    return `${guessPlatform()} (browser)`;
  },

  capabilities: {
    /** Cross-origin fetch without CORS — only the desktop shell can do this. */
    proxy: !!native?.fetch,
    /** Screen capture. Browsers can, but only behind a per-session picker. */
    capture: !!native?.listScreenSources || !!navigator?.mediaDevices?.getDisplayMedia,
    captureSilent: !!native?.listScreenSources,
    /** Synthetic mouse and keyboard. Impossible from a page. */
    input: !!native?.injectInput,
    /** A real, scripted browser tab on the PC's own network. Desktop-only. */
    scripts: !!native?.scriptedOpen,
  },

  /**
   * Refreshes the capability flags that can only be settled by asking the
   * host (the input backend may be missing its optional native module).
   */
  async probe() {
    if (native?.inputAvailable) {
      try {
        this.capabilities.input = await native.inputAvailable();
      } catch {
        this.capabilities.input = false;
      }
    }
    return this.capabilities;
  },

  /** Performs a proxied HTTP request. Rejects when there is no native host. */
  async fetch(request) {
    if (!native?.fetch) throw new Error('the desktop app is required to proxy requests');
    return native.fetch(request);
  },

  async listScreenSources() {
    if (native?.listScreenSources) return native.listScreenSources();
    return [];
  },

  /**
   * Returns a MediaStream of the screen. In the desktop app this picks the
   * requested source outright; in a browser it raises the native picker.
   */
  async captureScreen({ sourceId = null, maxHeight = 1080, frameRate = 60 } = {}) {
    if (native?.listScreenSources) {
      const sources = await native.listScreenSources();
      if (!sources.length) throw new Error('no screen sources were offered by the system');
      const chosen = sources.find((s) => s.id === sourceId) || sources[0];
      // Input arrives as 0..1 of *this* display, so main has to know which one.
      native.setActiveDisplay?.(chosen.displayId);
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: chosen.id,
            // The legacy `mandatory` path has no notion of "and keep the
            // aspect ratio". Given a height cap and nothing else it reaches
            // for Chromium's default 1920x1080 shape, so anything that is not
            // 16:9 — an ultrawide, a monitor in portrait — arrives with the
            // bars baked into the frame and the real pixels squeezed into
            // whatever is left. Deriving the width cap from the display's own
            // bounds leaves the height as the only real limit.
            maxWidth: widthCapFor(chosen, maxHeight),
            maxHeight,
            maxFrameRate: frameRate,
          },
        },
      });
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('this browser cannot capture the screen');
    }
    return navigator.mediaDevices.getDisplayMedia({
      audio: false,
      // `ideal` as well as `max`: a bare maximum is a permission to go slower,
      // and the picker will happily hand back 5 fps without one.
      video: { height: { max: maxHeight }, frameRate: { ideal: frameRate, max: frameRate } },
    });
  },

  /** Applies one input event on the real desktop. No-op without a host. */
  async injectInput(event) {
    if (!native?.injectInput) return false;
    return native.injectInput(event);
  },

  /** Durable key/value store. Survives a cleared browser profile in Electron. */
  async loadStore() {
    if (native?.loadStore) {
      try { return (await native.loadStore()) || {}; } catch { /* fall through */ }
    }
    try { return JSON.parse(localStorage.getItem('proxvocx.host') || '{}'); } catch { return {}; }
  },

  async saveStore(patch) {
    const merged = { ...(await this.loadStore()), ...patch };
    if (native?.saveStore) {
      try { await native.saveStore(merged); return merged; } catch { /* fall through */ }
    }
    try { localStorage.setItem('proxvocx.host', JSON.stringify(merged)); } catch { /* full or private */ }
    return merged;
  },

  async setAutoLaunch(enabled) {
    if (!native?.setAutoLaunch) return false;
    return native.setAutoLaunch(enabled);
  },

  async getAutoLaunch() {
    if (!native?.getAutoLaunch) return false;
    try { return await native.getAutoLaunch(); } catch { return false; }
  },

  /** Lets the shell reflect connector state in the tray icon and tooltip. */
  reportStatus(status) {
    native?.reportStatus?.(status);
  },

  /**
   * Opens a real, scripted browser tab on the PC and returns a live
   * MediaStream of its pixels — full JavaScript, full WebSocket support,
   * because it is a genuine Chromium tab, not a reconstruction. Frames
   * arrive over IPC as JPEGs and are painted onto a canvas whose
   * `captureStream()` is what actually gets handed to WebRTC; that canvas
   * indirection is the only way to turn "IPC delivers a still image
   * periodically" into something WebRTC can treat as a video track.
   */
  async openScriptedBrowser(sessionId, url, {
    width = 1600, height = 1000, frameRate = 20, quality = 92, onNavState,
  } = {}) {
    if (!native?.scriptedOpen) {
      throw new Error('the desktop app is required to run a scripted browser tab');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(frameRate);

    const offFrame = native.onScriptedFrame(({ sessionId: id, jpeg, width: w, height: h }) => {
      if (id !== sessionId) return;
      createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })).then((bitmap) => {
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      }).catch(() => { /* a dropped frame is not worth failing the session over */ });
    });

    const offNav = native.onScriptedNavState(({ sessionId: id, ...state }) => {
      if (id === sessionId) onNavState?.(state);
    });

    await native.scriptedOpen({ sessionId, url, width, height, frameRate, quality });

    return {
      stream,
      navigate: (action, navUrl) => native.scriptedNavigate(sessionId, action, navUrl),
      sendInput: (event) => native.scriptedInput(sessionId, event),
      close() {
        offFrame();
        offNav();
        native.scriptedClose(sessionId);
        for (const track of stream.getTracks()) track.stop();
      },
    };
  },
};

/**
 * The width that goes with `maxHeight` on this display, rounded to an even
 * number because video encoders work in 2x2 blocks and an odd dimension costs
 * a rescale. Falls back to 16:9 when the shell did not report bounds.
 */
function widthCapFor(source, maxHeight) {
  const { width, height } = source?.bounds || {};
  const aspect = width && height ? width / height : 16 / 9;
  return Math.round((maxHeight * aspect) / 2) * 2;
}

function guessPlatform() {
  const ua = navigator?.userAgent || '';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'PC';
}
