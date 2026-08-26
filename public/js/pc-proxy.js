/**
 * The proxy half of the connector: drains `machines/{id}/requests`, hands each
 * one to the native host to fetch, and writes the result back to
 * `machines/{id}/responses`.
 *
 * The page never fetches anything itself — it has no way around CORS. All it
 * does is move work between Firebase and the desktop shell, with a small
 * concurrency window so a burst of subresource requests from the mini browser
 * cannot swamp the machine.
 */
import { ref, set, remove, onChildAdded } from './firebase.js';
import { paths } from './paths.js';

const DEFAULTS = {
  maxConcurrent: 4,
  requestMaxAgeMs: 120_000,
};

export function startProxyServer({ db, machineId, bridge, log, onStat, getSettings, options = {} }) {
  const settings = { ...DEFAULTS, ...options };
  const queue = [];
  const inFlight = new Set();
  let stopped = false;

  const requestsRef = ref(db, paths.requests(machineId));

  const stopListening = onChildAdded(requestsRef, (snapshot) => {
    if (stopped) return;
    queue.push({ id: snapshot.key, payload: snapshot.val() });
    pump();
  }, (err) => {
    log?.(`request listener failed: ${err.message}`, 'error');
  });

  function pump() {
    while (!stopped && inFlight.size < settings.maxConcurrent && queue.length) {
      const job = queue.shift();
      const task = handle(job).finally(() => {
        inFlight.delete(task);
        pump();
      });
      inFlight.add(task);
    }
  }

  async function handle({ id, payload }) {
    // Whatever happens the request node goes away, so a malformed entry can
    // never loop the connector.
    const finish = async (response) => {
      try {
        await set(ref(db, paths.response(machineId, id)), response);
      } catch (err) {
        log?.(`could not write response ${id}: ${err.message}`, 'error');
      }
      try {
        await remove(ref(db, paths.request(machineId, id)));
      } catch { /* already gone */ }
    };

    if (!payload?.url) {
      onStat?.('errors', 1);
      return finish(failure('request had no url', 'ERR_URL_REJECTED'));
    }

    const age = Date.now() - Number(payload.createdAt || 0);
    if (settings.requestMaxAgeMs && age > settings.requestMaxAgeMs) {
      log?.(`dropped stale request for ${short(payload.url)}`, 'warn');
      onStat?.('errors', 1);
      return finish(failure('request was too old to be worth fetching', 'ERR_STALE'));
    }

    if (getSettings?.().allowProxy === false) {
      log?.(`refused ${short(payload.url)} — serving browser traffic is switched off`, 'warn');
      return finish(failure(
        'The PC is not serving browser traffic. Turn it back on in the connector settings.',
        'ERR_REFUSED',
      ));
    }

    if (!bridge.capabilities.proxy) {
      onStat?.('errors', 1);
      return finish(failure(
        'this connector is running as a browser tab and cannot fetch on your behalf — ' +
        'install the desktop app on the PC',
        'ERR_NO_HOST',
      ));
    }

    const started = performance.now();
    try {
      const result = await bridge.fetch({
        url: payload.url,
        method: payload.method || 'GET',
        headers: payload.headers || {},
        body: payload.body || null,
      });
      const durationMs = Math.round(performance.now() - started);
      onStat?.('requests', 1);
      onStat?.('bytes', Number(result.bytes) || 0);
      log?.(`${result.status} ${short(payload.url)} · ${durationMs}ms`, result.ok ? 'good' : 'warn');
      return finish({ ...result, durationMs, completedAt: Date.now() });
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      onStat?.('errors', 1);
      log?.(`failed ${short(payload.url)}: ${err.message}`, 'error');
      return finish({
        ...failure(err.message, err.code || 'ERR_UNREACHABLE'),
        durationMs,
      });
    }
  }

  return {
    stop() {
      stopped = true;
      queue.length = 0;
      stopListening();
    },
    get pending() { return queue.length + inFlight.size; },
  };
}

function failure(message, errorCode) {
  return {
    ok: false,
    status: 0,
    statusText: '',
    error: message,
    errorCode,
    body: '',
    bodyEncoding: 'utf8',
    bytes: 0,
    headers: {},
    completedAt: Date.now(),
  };
}

function short(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 27)}…` : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return String(url).slice(0, 48);
  }
}
