/**
 * Serves the packaged `public/` tree on http://localhost.
 *
 * The PC page is loaded over http://localhost rather than file:// or
 * 127.0.0.1 for two reasons: Firebase's authorised-domains list contains the
 * literal string `localhost` out of the box — `127.0.0.1` is a *different*
 * domain as far as that check is concerned, even though it is the same
 * loopback interface, and gets `auth/unauthorized-domain` rejected. `file://`
 * origins are opaque, which breaks auth persistence and the Web Crypto calls
 * the pairing code generator relies on.
 *
 * It also means the desktop app works with no Firebase Hosting deploy at all —
 * hosting is only needed for the client side.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function startStaticServer(rootDir, { host = 'localhost', port = 0 } = {}) {
  const root = path.resolve(rootDir);

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    const target = path.join(root, pathname);
    // Never serve outside the packaged tree, whatever the URL claims.
    if (!target.startsWith(root + path.sep) && target !== root) {
      res.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      }).end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        origin: `http://${host}:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * `public/` relative to *this file's own* location (desktop/bridge/), not the
 * caller's — a caller-supplied `import.meta.url` is one level shallower for
 * anything in desktop/ directly, and silently walking past the repo root
 * turns every request into a 404 instead of an obvious error.
 */
export const packagedPublicDir = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
