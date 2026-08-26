# proxvocx

A Firebase Realtime Database backed HTTP proxy. Your phone never talks to the target
site: it drops a request into Firebase, a Node.js server on your PC fetches the URL,
and the response comes back through the same database.

```
 phone (web client)                Firebase RTDB                PC server (Node)
 ──────────────────                ─────────────                ────────────────
 push  requests/{uid}/{id}  ──────▶  requests/{uid}  ──────────▶  child_added
                                                                  fetch(url)
 onValue responses/{uid}/{id} ◀────  responses/{uid} ◀──────────  set(response)
 remove response after display                       ◀──────────  remove(request)
```

- **PC server** authenticates with a service account key (`serviceAccountKey.json`).
- **Phone client** authenticates with the Firebase Web SDK and uses the same uid.
- Requests are deleted as soon as they are answered; responses are deleted by the
  client once shown, with a server-side sweeper as a backstop.

## Layout

| Path                   | What it is                                                        |
| ---------------------- | ----------------------------------------------------------------- |
| `server/index.js`      | Entry point: Firebase listeners, work queue, cleanup, shutdown     |
| `server/fetcher.js`    | Performs the HTTP(S) fetch, caps size, follows redirects safely    |
| `server/safe-url.js`   | URL validation and the SSRF guard (blocks private/loopback space)  |
| `server/config.js`     | Environment configuration and validation (reads `.env` if present) |
| `server/logger.js`     | Structured JSON logging (pretty output on a TTY)                   |
| `client/index.html`    | The entire phone client — one self-contained file                  |
| `database.rules.json`  | Realtime Database security rules                                   |

## Database structure

```
requests/{userId}/{requestId}
  url        "https://example.com"      required
  method     "GET"                      optional, defaults to GET
  headers    { "accept": "…" }          optional
  body       "raw body"                 optional, non-GET/HEAD only
  createdAt  1735689600000              server timestamp
  client     "web"

responses/{userId}/{requestId}
  ok            true
  status        200
  statusText    "OK"
  url           "https://example.com/"  final URL after redirects
  redirects     0
  headers       { "content-type": "text/html; charset=utf-8", … }
  contentType   "text/html; charset=utf-8"
  body          "<!doctype html>…"      utf8 text, or base64 for binary
  bodyEncoding  "utf8" | "base64"
  bytes         1256
  truncated     false                   true if the body hit MAX_RESPONSE_BYTES
  durationMs    412
  completedAt   1735689601000
```

On failure the response node carries `ok: false`, `status: 0`, plus `error`
(human readable) and `errorCode`, one of:

| Code                     | Meaning                                            |
| ------------------------ | -------------------------------------------------- |
| `ERR_URL_REJECTED`       | Bad URL, blocked scheme/port/method, private target |
| `ERR_TIMEOUT`            | Target did not answer within `REQUEST_TIMEOUT_MS`   |
| `ERR_UNREACHABLE`        | DNS/TCP/TLS failure reaching the target             |
| `ERR_TOO_MANY_REDIRECTS` | Redirect chain longer than `MAX_REDIRECTS`          |
| `ERR_BAD_REDIRECT`       | Redirect pointed at an unparseable location         |

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project**. Analytics is not needed.
2. **Build → Realtime Database → Create Database.** Pick a region and start in
   **locked mode** — the rules in this repo replace the defaults.
   Note the database URL, e.g. `https://my-project-default-rtdb.firebaseio.com`
   (regional instances look like `…-default-rtdb.europe-west1.firebasedatabase.app`).
3. **Build → Authentication → Get started.** Enable **Email/Password**, and
   **Anonymous** if you want the one-tap option in the client.
   Then **Authentication → Users → Add user** to create the account the phone signs in with.
4. **Project settings → Service accounts → Generate new private key.** Save the
   downloaded file as `serviceAccountKey.json` in the repo root. It is already
   in `.gitignore` — never commit it.
5. **Project settings → General → Your apps → Web app (`</>`).** Register an app and
   copy the `firebaseConfig` object; the phone client needs it.

## 2. Publish the security rules

Paste the contents of `database.rules.json` into **Realtime Database → Rules → Publish**,
or with the Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only database
```

The rules give each signed-in user read/write access to their own `requests/{uid}`
subtree and read/delete access to `responses/{uid}` — nobody can see anyone else's
traffic. The server bypasses rules because a service account has admin credentials.

## 3. Run the PC server

```bash
npm install
cp .env.example .env          # then set FIREBASE_DATABASE_URL
npm start
```

Expected startup output:

```
2026-01-01T00:00:00.000Z INFO  proxy server starting projectId=my-project …
2026-01-01T00:00:00.400Z INFO  watching every user under /requests
2026-01-01T00:00:00.550Z INFO  connected to realtime database
```

### Configuration

All settings are environment variables (`.env` in the repo root is read automatically).

| Variable                         | Default                 | Purpose                                              |
| -------------------------------- | ----------------------- | ---------------------------------------------------- |
| `GOOGLE_APPLICATION_CREDENTIALS` | `./serviceAccountKey.json` | Path to the service account key                   |
| `FIREBASE_DATABASE_URL`          | *(required)*            | Realtime Database URL                                |
| `PROXY_USER_ID`                  | *(all users)*           | Serve only this uid                                   |
| `REQUEST_TIMEOUT_MS`             | `20000`                 | Per-request timeout                                   |
| `MAX_RESPONSE_BYTES`             | `262144`                | Body cap; larger bodies are truncated, not failed     |
| `MAX_REDIRECTS`                  | `5`                     | Redirect hops, each re-checked by the SSRF guard      |
| `MAX_CONCURRENT_REQUESTS`        | `4`                     | Parallel fetches; the rest queue                      |
| `ALLOW_PRIVATE_NETWORK`          | `false`                 | Allow loopback/LAN targets (SSRF guard off)           |
| `REQUEST_MAX_AGE_MS`             | `120000`                | Requests older than this are rejected, not fetched    |
| `RESPONSE_TTL_MS`                | `300000`                | Sweep responses the client never collected (`0` = off)|
| `LOG_LEVEL`                      | `info`                  | `trace`…`error`                                       |
| `LOG_FORMAT`                     | auto                    | `pretty` for human output; JSON when not a TTY        |

### Keeping it running

```bash
# systemd (Linux)
sudo tee /etc/systemd/system/proxvocx.service >/dev/null <<'UNIT'
[Unit]
Description=proxvocx Firebase proxy
After=network-online.target

[Service]
WorkingDirectory=/opt/proxvocx
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
User=proxvocx

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now proxvocx

# or with pm2, on any platform
npx pm2 start server/index.js --name proxvocx
```

`SIGINT`/`SIGTERM` detach the listeners, let in-flight fetches finish (up to 15s),
and close the Firebase app before exiting.

## 4. Open the phone client

`client/index.html` is self-contained — no build step. Either:

- **Serve it:** `npx serve client` on the PC, then open `http://<pc-ip>:3000` on the
  phone (same Wi-Fi), or deploy it with `firebase deploy --only hosting`.
- **Open the file directly** on the phone (e.g. from Files). ES modules load from
  `file://` in most mobile browsers; if yours refuses, serve it instead.

Firebase Auth requires the serving domain to be listed under
**Authentication → Settings → Authorized domains**. `localhost` is there by default;
add your LAN IP or hosting domain if you serve from one.

First launch asks for the Firebase web config — paste the `firebaseConfig` snippet
from step 1.5 and it is stored in that browser's `localStorage`. To ship the page
pre-configured, fill in the `FIREBASE_CONFIG` object near the top of the `<script>`
block instead.

Then sign in with the account from step 1.3, type a URL, and hit **Send**. HTML
responses render in a sandboxed iframe (scripts disabled), images preview inline,
everything else shows as raw text, and headers get their own tab.

The web API key in the config is not a secret — it identifies the project, and the
security rules are what actually protect the data.

## Operational notes

- **SSRF guard.** Targets resolving to loopback, private, link-local, CGNAT,
  multicast or reserved ranges are refused, and every redirect hop is re-checked.
  Set `ALLOW_PRIVATE_NETWORK=true` only if proxying to your own LAN is the point.
- **Header hygiene.** `host`, `cookie`, `content-length`, and other hop-by-hop
  headers are stripped from client-supplied headers; CR/LF is stripped from values.
- **Body size.** Realtime Database rejects very large writes, so bodies are capped at
  `MAX_RESPONSE_BYTES` and flagged with `truncated: true` rather than failing.
- **Cost.** Every proxied byte crosses the database twice (server write, phone read)
  and counts against the Realtime Database bandwidth quota. Keep
  `MAX_RESPONSE_BYTES` conservative on the free tier.
- **Poison requests.** A request is deleted after processing whether it succeeded or
  failed, so a malformed entry can never loop.
