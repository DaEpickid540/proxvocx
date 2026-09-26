# proxvocx

Reach your PC from anything. **Browser mode** routes your web traffic through
the machine at home; **PC Control mode** streams its screen and takes your
mouse and keyboard. Firebase is the only thing in the middle, and there are no
Cloud Functions anywhere.

```
  ROOT PORTAL  (/)
  ├── PC Site      ──▶  the connector. Runs on the PC you want to reach.
  └── Client Site  ──▶  Browser mode + PC Control mode. Runs anywhere.

  ┌── the PC ──────────────┐        ┌─ Firebase ─┐        ┌── any device ───┐
  │  desktop app           │        │            │        │                 │
  │  └─ loads /pc/  ◀──────┼── RTDB ┼── pairing  ┼────────┼─▶ /client/      │
  │     (the same page     │        │   requests │        │   ├ mini browser│
  │      Hosting serves)   │        │   sessions │        │   └ remote view │
  │  ├─ CORS-free fetch    │        └────────────┘        │                 │
  │  ├─ screen capture     │                              │                 │
  │  └─ input injection    │◀═══════ WebRTC (P2P) ═══════▶│                 │
  └────────────────────────┘      screen + input          └─────────────────┘
```

## The one important design decision

**The desktop app and the PC site are the same thing.** `public/pc/index.html`
is served by Firebase Hosting *and* loaded by Electron as its window. There is
no second UI, and no separate "app" to keep in sync with the site.

What Electron adds is capability, not chrome. The page checks for
`window.proxvocx` on boot and lights up whatever the host offers:

| | browser tab | desktop app |
| --- | --- | --- |
| Pair, show status, presence | ✅ | ✅ |
| Fetch other origins (Browser mode) | ❌ CORS | ✅ |
| Capture the screen | ⚠️ picker every session | ✅ silent |
| Move the mouse, press keys | ❌ impossible | ✅ |

So the native host is not optional if you want the product — a web page
genuinely cannot inject input or bypass CORS. But you only install **one**
thing on the PC, and the client side needs no install at all.

## Pairing happens once, ever — and more than one account can share a PC

No codes to re-enter, no per-device setup:

1. The PC signs in with its own Google account (any account — it does not
   have to be yours) to get a stable *device* identity, registers itself, and
   shows an 8-character code.
2. You sign in on the client, type the code, and the PC adds your account to
   `machines/{id}/owners`.
3. The machine now lives under `users/{yourUid}/machines`, so **any** device
   you sign into that account on sees it immediately.

`owners` is a set, not a single slot — a personal Google account and a work
one (or anyone else's) can both reach the same PC. From the PC's Connection
card, **Add another account** publishes a fresh code the same way; whoever
claims it is *added*, not swapped in. Each account can be revoked
individually from that same card, and "Unpair this PC" in Settings clears
everyone at once.

Codes are 30<sup>8</sup> ≈ 6.6 × 10<sup>11</sup>, live five minutes, and are
single-use. The alphabet has no `0`, `1`, `I`, `L`, `O` or `U`, so a code read
off a screen and typed on a phone cannot be misread.

## Layout

| Path | What it is |
| --- | --- |
| `public/index.html` | Root portal — the two sign-in doors |
| `public/pc/` | The connector page (Hosting **and** Electron renderer) |
| `public/client/` | The client app, both modes |
| `public/js/firebase.js` | SDK bootstrap, config storage, auth helpers |
| `public/js/paths.js` | The database layout, in one place |
| `public/js/pairing.js` | Code publish / claim / burn |
| `public/js/host-bridge.js` | The seam between the page and its host |
| `public/js/pc-proxy.js` | Connector: drains the request queue |
| `public/js/pc-control.js` | Connector: serves screen + replays input |
| `public/js/pc-scripted-browser.js` | Connector: serves a real, JS-enabled browser tab |
| `public/js/proxy-client.js` | Client: enqueue a request, await the response |
| `public/js/fetch-tunnel.js` | Client: Browser mode's direct fast lane, with fallback to the queue |
| `public/js/lane-frames.js` | Binary framing shared by both ends of the fast lane |
| `public/js/client-native-browser.js` | Client: the native (Scramjet) engine — relays the browse shell to the fast lane |
| `public-browse/` | The browse site: Scramjet's shell (and its tabs), service worker, and vendored Scramjet + bare-mux |
| `desktop/bridge/raw-fetch.js` | Browser-exact requests for the native engine |
| `desktop/bridge/ws-relay.js` | WebSockets opened by the PC for the native engine |
| `public/js/pc-fetch.js` | Connector: serves the fast lane over a WebRTC data channel |
| `public/js/client-browser.js` | The script-free mini browser and its HTML rewriter |
| `public/js/client-control.js` | The remote desktop viewer |
| `public/js/client-scripted-browser.js` | The viewer for a real, scripted browser tab |
| `public/js/signaling.js` | WebRTC handshake over RTDB |
| `public/js/input-protocol.js` | The input (and nav command) wire format |
| `public/js/key-remap.js` | Viewer-side key remapping rules (per device) |
| `desktop/main.js` | Electron main: IPC, tray, run-at-login |
| `desktop/preload.cjs` | The only Electron surface the page can see |
| `desktop/bridge/fetcher.js` | The proxy fetch, with redirect re-validation |
| `desktop/bridge/safe-url.js` | SSRF guard (blocks private/loopback space) |
| `desktop/bridge/input.js` | Mouse/keyboard synthesis for PC Control (optional native dep) |
| `desktop/bridge/scripted-browser.js` | Runs the real, offscreen browser tab for scripted Browser mode |
| `desktop/bridge/static-server.js` | Serves the packaged page on localhost |
| `database.rules.json` | The rules that actually enforce all of the above |

## Database structure

```
machines/{machineId}
  deviceUid   uid of the PC installation      written once, by the PC
  owners      { uid: true, ... }              every account paired to this PC,
                                               added (never replaced) by the PC at pairing
  meta        { name, platform, appVersion, createdAt }
  presence    { online, lastSeen, capabilities: { proxy, control, input, scripts } }
  requests/{id}    owner writes, PC drains        ← Browser mode (script-free),
  responses/{id}   PC writes, owner reads+deletes ←   only until the fast lane opens
  sessions/{id}    { mode, url?, offer, answer, ice } ← handshake only, for
                                                        PC Control ('control'),
                                                        scripted Browser mode
                                                        ('scripted') and the
                                                        Browser-mode fast lane
                                                        ('fetch')

users/{uid}/machines/{machineId}   { name, pairedAt }

pairing/{code}   { machineId, machineName, deviceUid, createdAt, expiresAt, claimedBy }
```

Only the WebRTC *handshake* touches the database. Screen frames, input
events and — once its fast lane is open — script-free Browser mode's pages
all travel peer-to-peer, so a session costs a few kilobytes of Firebase quota
regardless of how long you stay connected. The `requests`/`responses` queue
is the fallback for the first moments of browsing and for networks where a
direct connection cannot be made.

> **Deploy the rules again** after updating (`firebase deploy --only database`):
> the fast lane uses a new session mode, `'fetch'`, which older rules reject.
> Browsing still works without it, just only over the slower database queue.

`pairing` itself is not readable — only `pairing/{code}` is, so codes cannot be
listed or enumerated. Knowing the code is the secret.

## 1. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project**. Analytics not needed.
2. **Build → Realtime Database → Create Database.** Start in locked mode; the
   rules in this repo replace the defaults.
3. **Build → Authentication → Get started.** Enable **Google** and only Google —
   it is the one sign-in method the app offers, for both the PC and the
   client. Leave Email/Password and Anonymous off.
4. **Project settings → General → Your apps → Web app (`</>`)**. Copy the
   `firebaseConfig` object.

## 2. Publish the rules

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only database
```

Or paste `database.rules.json` into **Realtime Database → Rules → Publish**.

> Publish the rules **before** pairing anything. The default locked-mode rules
> deny the writes the connector needs to register itself.

## 3. Deploy the client site

```bash
firebase deploy --only hosting
```

Then add your hosting domain under **Authentication → Settings → Authorised
domains** if it is not there already.

To ship the site pre-configured, fill in `public/js/firebase-config.js`.
Otherwise the first visitor is asked to paste the `firebaseConfig` snippet,
which is remembered in that browser.

## 4. Install the connector on the PC

```bash
npm install
npm start          # runs the connector from source
npm run build:win  # or build:mac / build:linux for an installer
```

The app serves its packaged copy of the page on `127.0.0.1` and loads that, so
**the desktop side works without deploying Hosting at all** — and `localhost`
is already an authorised Firebase domain. To make the PC track your deployed
site instead:

```bash
PROXVOCX_SITE_URL=https://my-project.web.app npm start
```

Closing the window leaves it in the tray; quit from there. Turn on **Start with
this computer** in Settings so the PC is reachable after a reboot.

### Remote input needs one optional native module

`@nut-tree-fork/nut-js` is an **optional** dependency on purpose: if it is
missing or fails to build, the connector still runs and control sessions are
simply view-only rather than the whole app refusing to start. The Capabilities
panel says which state you are in. On Linux you will need `libxtst-dev` and
`libpng++-dev` to build it.

macOS additionally requires granting **Screen Recording** and **Accessibility**
to the app in System Settings → Privacy & Security.

### Configuration

Environment variables read by the desktop app:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXVOCX_SITE_URL` | *(packaged copy)* | Load the connector page from a deployed site |
| `PROXVOCX_TIMEOUT_MS` | `20000` | Per-request fetch timeout |
| `PROXVOCX_MAX_BYTES` | `524288` | Response body cap on the database queue; larger bodies are truncated (the direct fast lane allows up to 8 MB) |
| `PROXVOCX_ALLOW_PRIVATE` | `false` | Allow LAN/loopback targets (SSRF guard off) |
| `PROXVOCX_USER_AGENT` | desktop Chrome, matching the bundled Chromium | UA sent to proxied sites |

## 5. Use it

Open the site on your phone or laptop → **Client Site** → sign in. The server
picker appears; type the code showing on the PC. That is the last time you will
see a code on this account.

- **Browser mode** — type a URL. The PC fetches it and the page runs here,
  through one of three engines picked next to the URL bar — see below.
- **PC Control mode** — hit Connect. Click into the picture to send input,
  press <kbd>Esc</kbd> to give the keyboard back.

  - **Stream** (toolbar) — monitor, frame rate, what the encoder is tuned for,
    the resolution sent, and **Smoothing**. Smoothing is off by default, for
    the lowest latency. A picture that is choppy but sharp is usually network
    jitter: Smoothing holds frames 40–100 ms so they play out evenly, at the
    cost of that much extra delay. The status bar says
    when the PC's CPU, the network or the viewing device is the bottleneck;
    hover it for what to try.
  - **Remap keys** (toolbar) — turn a key on this keyboard into a different
    key on the PC, e.g. a Chromebook's Search key into Shift. Rules are saved
    per device. ChromeOS keeps Search for its launcher, so use **Fullscreen**:
    the page then asks the browser (Keyboard Lock) to hand it system keys.

The picker returns by itself whenever the selected PC drops offline.

## What Browser mode can and cannot do

Browser mode has three engines, picked from the menu next to the URL bar
(remembered per device):

| Engine | Runs the page | JavaScript | Quality | Needs |
| --- | --- | --- | --- | --- |
| **Native** (default) | in your browser, via Scramjet | ✅ full | native | the browse site (below) |
| **Safe** | in your browser, scripts stripped | ❌ | native, static | nothing |
| **PC tab** | on the PC, streamed as video | ✅ full | video | "Allow JavaScript" on the PC |

Whichever engine you pick, the PC makes every request — your device never
talks to the site itself. If the native engine cannot run against a PC (an
older connector, no direct connection possible, browse site not deployed) the
client says why and falls back to Safe for that PC.

### The native engine (Scramjet)

This is how sites like Nebula get their quality: the real page runs in your
browser, rewritten by [Scramjet](https://github.com/MercuryWorkshop/scramjet)
so that every request it makes — page, script, image, XHR, WebSocket — is
intercepted by a service worker and sent to your PC instead of the internet.
Text is real text, video is real video, scrolling is your screen's own.

How the traffic flows:

```
 proxied page ─▶ Scramjet SW ─▶ bare-mux ─▶ browse shell ══port══▶ client app ══WebRTC══▶ PC
 (browse origin)             (SharedWorker)  (browse origin)      (app origin)   fast lane   fetch / ws
```

**It runs on a second origin, on purpose.** Scramjet runs proxied pages'
JavaScript on whatever origin hosts it, and proxy rewriting is not a security
boundary. The client app's origin holds the Firebase sign-in that can take
over your PC, so Scramjet is hosted on a separate site that holds nothing —
no sign-in, no Firebase, no credentials. The client hands that site a single
MessagePort and relays its requests over the fast lane; the browse site never
touches the PC or the database directly.

**Deploying the browse site** (once):

```bash
firebase hosting:sites:create proxvocx-browse      # any free name; see below
firebase deploy --only hosting,database
```

`.firebaserc` already maps the `browse` target to `proxvocx-browse`. If that
name is taken, create another, update the `browse` entry in `.firebaserc`,
and set `BROWSE_ORIGIN` in `public/js/firebase-config.js` to its URL — by
default the client looks for `<this site>-browse.web.app`. Multiple sites per
project are allowed on the free Spark plan; the browse site is plain static
files (`public-browse/`), so any other static host works just as well.

For local development, serve both (`npm run site` and `npm run site:browse`)
and point the client at the second one from its devtools console:
`localStorage.setItem('proxvocx.browseOrigin', 'http://localhost:5001')`.

**Tabs, and pages that open new windows.** The native engine has tabs: the
strip above the URL bar, **+** for a new one, middle-click or **×** to close.
Every tab is its own Scramjet frame inside the one browse shell, so they
share its connection to the PC.

That is also what makes sign-in pop-ups work. Left alone, a page's
`window.open` or `target="_blank"` link would open a real browser tab on the
browse origin — and the browser keeps a top-level tab in a different storage
partition from the same site embedded in proxvocx, so that tab has no
service worker, no port and no way to reach the PC. Instead the shell turns
every new window into a tab of its own:

- `window.open` returns the new tab's window; the popup gets
  `window.opener` (kept across every page it goes through), `postMessage`
  works both ways with the right origins, `window.close()` closes the tab,
  and the opener sees `popup.closed` go true. An OAuth popup that bounces
  through the provider and back to a callback page completes as it would in
  a browser, and closing it drops you back on the tab that opened it.
- `target="_blank"` links (with the implied `noopener`), ctrl/cmd-click and
  middle-click (background tab), shift-click, named targets, and forms that
  post to a new window all open tabs too.
- Like a browser's pop-up blocker, `window.open` needs a real click behind
  it; the client says when it blocks one.

Known limits: sites that fingerprint hard or need DRM may still refuse; the
browse site needs `SharedWorker`, which some mobile browsers lack — the
client falls back to Safe there; and tabs belong to the native engine only
(Safe renders one page; the PC-tab engine opens new windows in place on the
PC). Tabs are closed when you switch engine or PC.

### Safe — script-free page rewriter

The fetched HTML is
rewritten and rendered in a `srcdoc` iframe **without `allow-scripts`**.
Nothing from the remote site ever executes on your device — a deliberate
trade:

- ✅ Static pages, articles, docs, search results, forms (GET and POST)
- ✅ Links, back/forward, images, stylesheets, background images and web fonts
  (all individually proxied — nothing is fetched by your device directly, and
  a Content-Security-Policy on the rendered page enforces that)
- ✅ Sharp images on high-DPI screens: `srcset` and `<picture>` are honoured,
  picking the candidate that suits this screen
- ✅ Fast: requests travel a direct WebRTC data channel to the PC (falling back
  to the database queue while it connects), and images/stylesheets are cached
  for the session
- ❌ Anything that needs JavaScript — SPAs, infinite scroll, most logins
- ❌ Video, WebSockets, service workers

Navigation is driven from the parent page, which can reach into the `srcdoc`
iframe because it inherits the origin. Links and form submissions are
intercepted and replayed through the proxy instead of hitting the network.

### PC tab — a real, scripted browser tab, streamed to you

There is no way to
reconstruct arbitrary JS-driven network behaviour (fetch, XHR, live sockets)
in a client-side sandboxed iframe without rebuilding a general-purpose relay
for every browser network primitive. Instead the PC opens the page in a real,
offscreen Electron/Chromium window — full JavaScript, full WebSockets,
because it is a genuine browser, not a reconstruction — and streams its
picture to you over WebRTC exactly the way PC Control streams a desktop, just
scoped to one browser tab instead of the whole screen. Your clicks, scrolls,
and keystrokes forward back over the same data channel, and the real
browser's URL, title, and back/forward state push back to your URL bar as
they change (a page can navigate itself from a click inside the video, not
only from the URL bar).

This costs more than the text-proxy engine — it is a live video stream per
session rather than a lightweight fetch-and-rewrite — and it is why the
setting defaults off. Turning it on also means every site you browse to runs
untrusted, fully capable JavaScript on the PC's own machine and network; that
is the whole point (full compatibility), but it is a materially larger trust
boundary than the sandboxed default, which is why it is opt-in rather than
automatic. Picking the PC-tab engine against a PC with the setting off
explains what turning it on would get you.

One thing scripted mode still cannot do: a live multiplayer game or anything
else needing a *direct* socket from your own device is out of scope no matter
what — the PC is genuinely the one browsing, so the socket lives there too.

## Operational notes

- **SSRF guard.** Targets resolving to loopback, private, link-local, CGNAT,
  multicast or reserved ranges are refused, and every redirect hop is
  re-checked. `PROXVOCX_ALLOW_PRIVATE=true` only if LAN proxying is the point.
- **Header hygiene.** For the Safe engine, `host`, `cookie`, `content-length`
  and the hop-by-hop headers are stripped from client-supplied headers. The
  native engine passes cookies and the page's own headers through (Scramjet
  keeps the cookie jar, on the browse origin), but never `host`,
  `content-length` or hop-by-hop headers. CR/LF is stripped from values
  either way, and every request, redirect hop and WebSocket still meets the
  SSRF guard.
- **Cost.** Once the fast lane is open, browsing costs no database bandwidth
  at all. Only the Safe engine's fallback queue (used while the lane
  connects, or when it cannot) sends bytes through the database — keep
  `PROXVOCX_MAX_BYTES` conservative on the free tier for that.
- **NAT.** WebRTC uses public STUN only. If both ends sit behind symmetric NAT
  the connection will fail; add a TURN relay in `signaling.js` → `iceServers()`.
- **Poison requests.** A request node is deleted after processing whether it
  succeeded or failed, so a malformed entry can never loop.
- **Trust.** Pairing hands an account full control of that machine. The PC can
  revoke it at any time from Settings → Unpair, and can switch remote input off
  while leaving view access on.

## License

proxvocx is licensed under the **GNU Affero General Public License v3.0**
(`AGPL-3.0-only`, see `LICENSE`), because it ships
[Scramjet](https://github.com/MercuryWorkshop/scramjet), which is AGPL-3.0.
In short: if other people use a copy of this that you host, they are entitled
to its complete source, including your changes.

Bundled third-party code keeps its own licence, next to it:
`public-browse/scram/` (Scramjet, AGPL-3.0) and `public-browse/baremux/`
(bare-mux, MIT).
