/**
 * The Scramjet service worker for the browse origin.
 *
 * Every request a proxied page makes under /scramjet/ comes through here and
 * is fetched through bare-mux — whose transport, in this app, is the shell
 * page's MessagePort to the proxvocx client, and from there the direct fast
 * lane to the PC. Nothing is fetched from this device's own network.
 */
importScripts('/scram/scramjet.all.js');

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

/*
 * Work around a deadlock in Scramjet 1.1.0.
 *
 * For every `set-cookie` on a subresource (a stylesheet, a script), the
 * worker tells the page about the cookie and *waits for the page to answer*
 * before finishing that response. But a page's service-worker messages are
 * held by the browser until the page reaches DOMContentLoaded — and a page
 * cannot reach DOMContentLoaded while its parser is blocked on that very
 * stylesheet or script. So any site whose CSS or JS sets a cookie (Wikipedia,
 * most sites with analytics) froze half-loaded forever.
 *
 * The worker's own cookie jar is updated right after the notification either
 * way, so every later request carries the cookie regardless; only the page's
 * `document.cookie` view waits, and the browser still delivers the message
 * once the page is ready. Capping the wait keeps the notification and drops
 * the deadlock.
 */
const COOKIE_NOTIFY_WAIT_MS = 50;
const dispatch = scramjet.dispatch.bind(scramjet);
scramjet.dispatch = (client, message) => (message?.scramjet$type === 'cookie'
  ? Promise.race([dispatch(client, message), new Promise((resolve) => setTimeout(resolve, COOKIE_NOTIFY_WAIT_MS))])
  : dispatch(client, message));

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function handleRequest(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) return scramjet.fetch(event);
  return fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});
