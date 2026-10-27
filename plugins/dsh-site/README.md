# dsh-site

A private-network front door to the DSH window on this Mac. Your phone, tablet
or laptop on your tailnet opens `http://<this Mac's tailnet address>:8443` and
gets the same DSH: the same sessions, workspaces and tools as the window on the
Mac. Nothing is copied or synced; every request goes to the DSH that is running
here.

DSH serves its window on `127.0.0.1` only, and answers only requests that carry
its sign-in cookie and a loopback address. dsh-site runs inside DSH as a plugin,
opens a second port, lets in only the devices you list, checks every request the
way DSH itself does, and passes it on to DSH's loopback server.

## What it does

- **Finds the DSH it runs in.** DSH's own window server first (its `webServer`
  service, with the port DSH picked at this start); then `targetOrigin` if you set
  one; then this process's own listening ports. It never serves another DSH, and
  it follows DSH to a new port after a restart. While DSH is still starting, it
  waits quietly (up to 20 seconds) instead of logging that DSH is missing.
- **Lets in only your devices.** `allowCIDRs` lists the devices let in: their
  tailnet addresses one by one (on a tailnet each device keeps its own address,
  so the list is a list of devices), or, while DSH's own sign-in is the gate, a
  private range (the default, `100.64.0.0/10`, is the whole tailnet). With
  `injectAuthCookie: true` it must be devices one by one: a range keeps the port
  closed, since every device in it would be signed in. A connection from any
  other address is closed before the edge reads a byte of it, and the log says
  so; nothing reaches DSH.
- **Turns away this Mac's own programs.** A request from this Mac itself
  (loopback, or any of its addresses, its tailnet address included) gets a page
  that says to use DSH's own window here, never DSH: through the edge, with the
  desktop window's cookie, any program or other account on this Mac would get
  DSH with no sign-in. `allowThisMac: true` lets them in, for a proxy on this Mac
  (such as `tailscale serve`) in front of the edge.
- **Keeps DSH's own browser checks at the edge.** DSH refuses a request whose
  Host is not loopback or whose Origin is another site. The edge rewrites those
  headers for DSH, so it checks them first, against the address the device used:
  - the Host must be an IP address, a loopback name, or a name in `allowHosts`
    (this stops DNS rebinding: a website that points its own name at your Mac);
  - a request marked cross-site (`Sec-Fetch-Site: cross-site`), or whose Origin is
    not the address the device used, is refused (a page on another site cannot
    open DSH's events socket or post to its API through the edge);
  - `X-Forwarded-*` and `Forwarded` headers from a device are dropped.
- **Keeps DSH out of other websites' pages.** Every answer the edge passes on
  carries `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy: frame-ancestors
  'self'` (beside DSH's own policy, which stays) and
  `Cross-Origin-Resource-Policy: same-origin`, so a browser does not show DSH in a
  frame on another site or hand DSH's answers to it. A frame or embed that a
  browser marks as coming from another site is refused before DSH sees it. The
  edge's own pages cannot be framed at all. See
  [What the edge cannot see](#what-the-edge-cannot-see-over-plain-http).
- **Signs devices in**, one of two ways (`injectAuthCookie`):
  - `false` (the default): DSH's own sign-in stays the gate. Each device opens
    DSH's sign-in link through the edge once (see [Sign in a device](#sign-in-a-device)),
    then stays signed in for as long as DSH's cookie lasts (30 days by default),
    also when DSH restarts on a new port.
  - `true`: the edge adds the desktop window's own sign-in cookie, read from its
    cookie jar (always opened read-only). A device needs no sign-in; the devices
    listed in `allowCIDRs`, one by one, are the only gate. If the cookie is stale,
    the edge reads the jar again and retries a read once.
- **Passes everything the window uses:** pages, API posts of any size, streamed
  replies as they come, and WebSockets (DSH's `remote.mux` events socket). An
  answer DSH ends part-way is ended part-way on the device too, so the device
  sees it cut instead of waiting on it for good (and the log says so). Only
  WebSocket upgrades pass, and nothing a device sends after its upgrade request
  reaches DSH until DSH has accepted the upgrade.
- **Says what is wrong, in words**, on a page for a browser and in one line for a
  program (see [What a device can see](#what-a-device-can-see)).
- **Fails closed.** With no settings (no row, or a row with no `config`) it does
  not serve. A wrong value or a key it does not know (a misspelt `enable: false`)
  keeps the port closed, and the log names the key and what to change.
- **Switches off cleanly.** `enabled: false`, a changed setting, or DSH stopping
  closes the port and cuts every open connection at once.

## Setup

1. Put the plugin in a folder DSH can read, for example `~/.dsh-plugins/dsh-site`.
2. Link it into your DSH profile (here the desktop profile). In
   `~/.dsh/profiles/desktop/package.json`, add to `dependencies`:

   ```json
   "dsh-plugin-dsh-site": "link:/Users/<you>/.dsh-plugins/dsh-site"
   ```

   and link the folder:
   `ln -s ~/.dsh-plugins/dsh-site ~/.dsh/profiles/desktop/node_modules/dsh-plugin-dsh-site`.
   If the profile's `package.json` has a `dsh.profile.bundles` list (DSH's
   Plugins page keeps one), `dsh-plugin-dsh-site` goes in that list too
   (switching DSH Site on there puts it in); the plugin's own patch then adds
   its row, and step 3 gives the row its settings.
3. Give the row its settings in `~/.dsh/profiles/desktop/cordis.patch.yml`. For a
   tailnet, listening on the Mac's tailnet address only (`tailscale ip -4` prints
   it), letting in your own two devices (`tailscale status` lists each device's
   address), with the Mac's tailnet name allowed and devices signed in by the
   desktop window:

   ```yaml
   - id: dsh-site
     config:
       listenHost: 100.101.102.103
       listenPort: 8443
       allowCIDRs: "100.101.102.104,100.101.102.105"
       allowHosts: "mymac.example.ts.net"
       injectAuthCookie: true
   ```

   With `injectAuthCookie: true`, `allowCIDRs` lists devices one by one: a range
   such as `100.64.0.0/10` (every device on the tailnet, see
   [Security](#security-read-before-widening-access) for who that is) keeps the
   port closed, and the log says so. A range works with `injectAuthCookie: false`,
   where each device still signs in with DSH's own link. On a
   profile with no `bundles` list, the row goes inside an `- insert:` block with
   `name: dsh-plugin-dsh-site`, as other rows there do. DSH applies a changed
   patch while it runs; no restart is needed. If the tailnet is not connected yet
   when DSH starts, the edge says so in its log and tries the address again
   every 30 seconds.
4. Check it from one of your devices (the Mac itself gets the "This is the Mac
   DSH runs on" page): `curl -s http://100.101.102.103:8443/.dsh-site/health`
   (`"ok":true`), then open `http://100.101.102.103:8443` in its browser.
   `./verify.sh <tailnet address> [name] [port]` on a device runs the deployed
   checks listed under [Tests](#tests); on the Mac it checks that the Mac itself
   is turned away.

Names: a device that opens the edge by a name (MagicDNS, or your own DNS record
pointing at the tailnet address) is refused until that name is in `allowHosts`.
IP addresses always work.

`listenHost: 0.0.0.0` (every interface) also works, still gated by `allowCIDRs`;
the edge then logs which of this Mac's addresses fall inside `allowCIDRs`. Prefer
the tailnet address: some carrier and hotspot networks use `100.64.0.0/10` too.

`tailscale serve` in front of the edge (HTTPS on the tailnet name) sends every
device to the edge from this Mac's own loopback address, so it needs
`listenHost: 127.0.0.1` and `allowThisMac: true`; the edge then cannot tell your
devices from this Mac's programs, and `allowCIDRs` no longer picks devices
(Tailscale's own access rules do).

## Sign in a device

With `injectAuthCookie: false`, a device that is not signed in gets a page,
"Sign in to DSH on this device", instead of DSH's window. To sign it in:

1. Take DSH's sign-in link. `dsh web` prints it when DSH starts:
   `dsh web: http://127.0.0.1:<port>/?token=<token>`.
2. On the device, open that link with its start changed to the edge's address:
   `http://<tailnet address>:8443/?token=<token>`. DSH sets its cookie for that
   address and opens the window.

The device then stays signed in for as long as DSH's cookie lasts (30 days by
default), also when DSH restarts: the edge always presents itself to DSH as
`127.0.0.1:<listenPort>`, so DSH's new port at each start does not sign devices
out (changing `listenPort` does). The token in the link is new at each start of
DSH; an old link gets the same page, saying the link is from an earlier start. A
browser keeps one cookie per address, so a device that uses both the tailnet
address and a name signs in once for each.

The DSH desktop app does not show its sign-in link. With the desktop app, use
`injectAuthCookie: true` (devices are then signed in by the desktop window).

## Settings

`listenHost` is required; every other key is optional. A wrong value never stops
the plugin from loading: the edge keeps its port closed and its log says which
setting to change and to what, for example `not serving until a setting is
fixed: listenPort must be a whole number from 1 to 65535, such as 8443 (it is
"abc")`. A key that is not in this table keeps the port closed too
(`"enable" is not a dsh-site setting: did you mean enabled?`). Numbers and
switches typed in quotes (`"8443"`, `"true"`) are taken as meant. DSH's Plugins
page shows DSH Site as running either way, on purpose: DSH counts a plugin that
fails to start against the profile change that caused it, so dsh-site stays
loaded with its port closed instead. The log is where a wrong setting shows.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | true or false | `true` | `false` keeps the plugin loaded and the port closed; turning it off cuts every open connection. With `false`, no other setting is needed. |
| `listenHost` | IP address | none: required | Where the edge listens: the Mac's tailnet address (only that network reaches the edge), `127.0.0.1`, or `0.0.0.0` / `::` (every interface, still gated by `allowCIDRs`). An address the Mac does not have yet is tried again every 30 seconds. |
| `listenPort` | 1 to 65535 | `8443` | The edge's port (plain HTTP). If another program holds it, the edge says so and tries again every 30 seconds. |
| `allowCIDRs` | addresses or ranges, list or comma text | `100.64.0.0/10` | The devices let in: their addresses one by one (`100.101.102.104`), or private ranges (`100.64.0.0/10` is the whole tailnet; also `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local, `fc00::/7`). An empty list, a `/0` or a public range is refused. A loopback range (`127.0.0.0/8`, `::1`) is this Mac itself and needs `allowThisMac: true`. With `injectAuthCookie: true`, devices one by one only: a range is refused (unless `listenHost` is loopback, which only this Mac reaches). |
| `allowHosts` | names, list or comma text | `""` | Names devices may use for this Mac besides its IP addresses, such as `mymac.example.ts.net` or `dsh.example.com:8443`. No wildcards. |
| `allowThisMac` | true or false | `false` | `false`: a request from this Mac itself (loopback or any of its addresses) gets a page, never DSH. `true`: this Mac's programs are let in, whatever `allowCIDRs` says; only for a proxy on this Mac, such as `tailscale serve`, in front of the edge. |
| `targetOrigin` | loopback origin or `""` | `""` | Empty: the DSH this plugin runs in. Only for a DSH that does not say where its window server is: `http://127.0.0.1:<port>`. Ignored, with a log line, when DSH says otherwise. |
| `discoverTarget` | true or false | `true` | When DSH does not say where its window server is, look among this process's own listening ports (uses `lsof`). |
| `rewriteHost` | true or false | `true` | Send DSH the loopback Host it requires. Leave on. |
| `rewriteOrigin` | true or false | `true` | Send DSH a loopback Origin and Referer, after the edge has checked them. Leave on. |
| `injectAuthCookie` | true or false | `false` | `true`: sign in the devices listed in `allowCIDRs` with the desktop window's cookie (that list, one device at a time, is the only gate). `false`: each device signs in once with DSH's own link. |
| `cookieJar` | path | `~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies` | The desktop window's cookie file, always opened read-only (`sqlite3 -readonly`). Used only with `injectAuthCookie: true`. |
| `logFile` | path or `""` | `dsh-site/site.log` | dsh-site's own log: listening, refusals, connections and problems. A relative path is inside DSH's home (`DSH_HOME`, else `~/.dsh`), so the default is `~/.dsh/dsh-site/site.log` for the DSH you use and stays inside a test DSH's own home; `~/` is your home folder. Never a cookie, and never the part of an address after `?` (where a sign-in token travels). Kept under 2 MB (one older file, `.1`). `""` for none. |

## What a device can see

| When | Status | A browser sees |
| --- | --- | --- |
| Its address is outside `allowCIDRs` | none | the browser's own "connection was reset" error: the edge closes the connection unread |
| It is this Mac itself (`allowThisMac: false`) | 403 | "This is the Mac DSH runs on": use DSH's own window here, and the setting for a proxy |
| It used a name not in `allowHosts` | 421 | "This address is not one this DSH answers to", and how to add the name |
| A page on another site sent the request | 403 | "Refused a request from another website" |
| A page on another site framed DSH | 403, or not shown | "DSH cannot be shown inside another page" when the browser marks the frame; otherwise the browser itself refuses to show DSH there |
| It is not signed in (`injectAuthCookie: false`) | 401 | "Sign in to DSH on this device", and where the sign-in link comes from |
| DSH's window has not signed in yet (`injectAuthCookie: true`) | 503 | "Waiting for DSH on this Mac to sign in"; retries every 5 s |
| The cookie jar is encrypted or cannot be read | 503 | "The edge cannot sign this device in", the reason, and both ways out |
| DSH's window server is not running or not found | 503 or 502 | a page that retries every 5 s |
| Everything is right | DSH's answer | DSH's window |

A program (no `Accept: text/html`) gets one line of text instead, such as
`dsh-site: refused cross-site request from http://evil.example`, and DSH's own
answer where DSH answered (its 401 when not signed in). A refused WebSocket gets
the same line as a plain HTTP answer; an upgrade to anything but a WebSocket gets
400 (`the edge passes WebSocket upgrades only`). Pages work light and dark and at
phone width, and never show a path, a cookie or DSH's own text.

## What the edge cannot see over plain HTTP

Browsers say where a request comes from (`Sec-Fetch-Site`, and `Origin` on page
loads) only to secure destinations. To a plain-HTTP tailnet address or name they
leave links, page loads, images and frames unmarked, so the edge cannot tell a
link on another site from an address you typed. What that means:

- A link on another site opens DSH as a page of its own, as a bookmark would.
  With `injectAuthCookie: true` it opens signed in. With `false` the device sees
  the sign-in page: DSH does not send its own sign-in along with a link from
  another site, and opening the address directly opens the window.
- A frame or image on another site does reach DSH, but the answer headers above
  make the browser refuse to show it inside that page or give it to that page.
- Posts and WebSockets carry an Origin, so the edge refuses them from another
  site whatever the browser marks.

## Health and log

`GET /.dsh-site/health` (from a device let in) answers what the edge is doing
now, looked up again on each call:

```json
{"ok":true,"plugin":"dsh-site","version":"0.2.0","pid":4242,"listen":"100.101.102.103:8443",
 "target":"http://127.0.0.1:52817","foundBy":"dsh","discovered":false,"auth":"cookie",
 "authInjected":true,"cookie":"found","allowCIDRs":["100.101.102.104","100.101.102.105"],
 "allowHosts":[],"allowThisMac":false,"connections":2,"since":"2026-10-26T16:23:48.441Z"}
```

`foundBy` is `dsh`, `targetOrigin` or `listeners`; `cookie` is `found`, `missing`,
`encrypted`, `error` (with `cookieProblem` in words) or `off`. With
`injectAuthCookie: false`, a device that DSH has not signed in gets only
`{"ok":true,"plugin":"dsh-site","version":"0.2.0","signedIn":false}`; the rest is
for signed-in devices.

The log (`logFile`) has one line per event: `listening on …`, `serving DSH at …
(found by …)`, `not serving until a setting is fixed: …`, `deny <ip>: not in
allowCIDRs; connection closed`, `refused <ip> GET /: this machine's own address
(allowThisMac is false)`, `refused <ip> GET /?…: cross-site request from …`,
`websocket <ip> … opened/closed`, `DSH's window server ended its answer to <ip>
GET … part-way`, `stopped; closed the port and N connections`. An address is
written without its query (`/?…`), so a sign-in link's token never reaches the
log. Repeated refusals from one source are written once a minute with a count.
DSH 0.2 keeps a plugin's own log lines in memory only, so this file is where to
look.

## Security: read before widening access

- With `injectAuthCookie: true`, the edge signs in every device it lets in:
  each gets full use of DSH (its sessions, files and tools) with no secret, as if
  at the Mac. Who that is: the devices whose addresses `allowCIDRs` lists. In
  this mode it takes them one by one: a range such as the default
  `100.64.0.0/10` would be every device on your tailnet (servers that run
  unattended jobs and machines shared into the tailnet as well as your phone and
  laptop), so a range keeps the port closed. A device's address on a tailnet is
  its own (the tailnet checks each packet against the device's key), so the list
  cannot be borrowed by another device. On a LAN an address is not tied to a
  device that way: anyone on that network who takes a listed address gets DSH.
  Keep the tailnet's access rules tight as well.
- This Mac's own programs are turned away unless `allowThisMac` is true. Without
  that, through the edge every program on this Mac would get DSH with no sign-in,
  including other macOS accounts and the commands DSH's own sessions run (DSH's
  sandbox does not limit the network). With `allowThisMac: true` (for
  `tailscale serve`), they do.
- With `injectAuthCookie: false`, DSH's own sign-in stays the gate: a device let
  in still needs DSH's cookie, from DSH's sign-in link.
- The edge speaks plain HTTP. On a tailnet the traffic is inside WireGuard; on any
  other network it is not encrypted. Do not add a range you do not control.
- `allowCIDRs` takes private ranges only; never expose the port with
  `tailscale funnel` or a port forward.
- The cookie jar is only ever opened read-only; if it cannot be read that way,
  the edge says why and does not sign devices in. The cookie is never written to
  the log, and a cookie for another port is never sent.

## Switch it off

- For a while: set `enabled: false` in the row. The port closes and every open
  connection is cut at once; the plugin stays loaded.
- For good: switch DSH Site off on DSH's Plugins page, which takes
  `dsh-plugin-dsh-site` out of the profile's `dsh.profile.bundles`. On a profile
  with no `bundles` list, remove the `dsh-site` row instead. DSH applies both
  without a restart.

Removing only the row's settings is not "off for good" on a profile that lists
the plugin in `bundles`: DSH still loads it (its own patch adds its row). It then
does not serve, and its log says it has no settings.

## Roll back

1. Switch DSH Site off on DSH's Plugins page (or take `"dsh-plugin-dsh-site"` out
   of `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`).
2. Remove the `dsh-site` row from `~/.dsh/profiles/desktop/cordis.patch.yml`.
3. Remove `"dsh-plugin-dsh-site"` from `dependencies` in the same `package.json`.
4. Remove the link `~/.dsh/profiles/desktop/node_modules/dsh-plugin-dsh-site`.

To go back to 0.1 instead (commit `5abe228`), point the profile's link at a copy
of that commit. 0.1 has none of the checks above.

### From 0.1 to 0.2

- `listenHost` is required (0.1 listened on `0.0.0.0` when it was not set). A
  row with no settings, or with a key 0.2 does not know, does not serve.
- This Mac's own programs are turned away (0.1 let them in). `allowCIDRs` no
  longer has loopback by default, and a row that lists `127.0.0.0/8` or `::1`
  does not serve until they are taken out (or `allowThisMac: true` is added).
- A name such as `mymac.example.ts.net` is refused until it is in `allowHosts`
  (0.1 answered any name). Add the names your devices use.
- `allowCIDRs` takes private ranges only.
- `injectAuthCookie` now defaults to `false`. A row that sets `true` lists its
  devices one by one in `allowCIDRs`; with a range (0.1's `100.64.0.0/10`) it
  does not serve, and the log says so.
- `targetOrigin` is no longer needed: the edge asks DSH. A stale one is ignored
  and the log says so.
- An address outside `allowCIDRs` gets a closed connection instead of a page.
- The default log is `dsh-site/site.log` inside DSH's home (the same file for
  the DSH you use); a row that names `logFile` keeps it.

## Tests

```bash
npm test         # unit tests (no DSH needed), about 15 s
npm run e2e      # dsh-site on real DSH builds, each in a throwaway home
npm run check    # both
```

- **Unit tests** (`test/unit/`): address ranges, the Host/Origin/frame fence,
  settings in words (unknown keys, no settings, private ranges, loopback only
  with `allowThisMac`, devices one by one with `injectAuthCookie`, paths inside
  DSH's home), the cookie jar (a real SQLite
  file, opened read-only, proved unchanged), pages (contrast computed from the
  colours), the log, and the edge itself with real sockets against a stand-in
  DSH that has DSH's own gate and sign-in: rewriting, a sign-in that lasts across
  a restart on a new port, a stale cookie, DNS rebinding, cross-site and frame
  refusals for HTTP and WebSocket, the frame headers on every answer, no query
  in the log, refused sources closed unread, this Mac's own programs turned
  away, an answer DSH drops part-way ended on the device too, upgrades other
  than WebSocket refused and nothing passed before DSH's 101, health for a
  device not signed in, streaming, a port in use, an address not here yet, DSH
  moving port, the startup wait, and off cutting connections.
- **Real-DSH tests** (`test/e2e/run.mjs`, run by `scripts/e2e.mjs`): each DSH
  build in `.e2e/dsh-<version>` (this repo's `.e2e`, `DSH_E2E_DIR`, or
  `~/Projects/dsh-plugin-suite/.e2e`) and the installed app's DSH, started with a
  scripted model in a throwaway home on free ports, with the edge on `127.0.0.1`
  only. It proves the edge finds that DSH by itself; a session is made and
  answered through the edge and shows in DSH's window opened through the edge;
  DSH's events socket opens through it; refusals happen before DSH sees them; a
  real browser on made-up names mapped to 127.0.0.1 (so it sends what it sends to
  a tailnet name) cannot frame DSH, post to it or open its socket from another
  site, in either sign-in mode; this Mac's own programs get the "This is the Mac
  DSH runs on" page and never DSH, and a loopback range without `allowThisMac`
  keeps the port closed; no sign-in token reaches the log; a misspelt key and a
  row with no settings keep the port closed, and the no-settings line lands in
  DSH's own home; taking the plugin out of the profile's `bundles` closes the
  port; a device signed in with DSH's own link stays signed in when DSH restarts
  on a new port, and health tells a device that is not signed in only `ok` and
  the version; `verify.sh` passes against it; off cuts an open socket; wrong
  settings keep the port closed; an unreadable cookie jar gets a page that says
  how to fix it; and a restart and a crash bring the edge back once. It reads
  the live DSH's fingerprint before and
  after (`~/.local/bin/dsh-test fingerprint`): it fails if the live DSH's process
  changed or its dsh-site row changed, and names any other row that changed
  (someone else's edit). Pictures go to `SHOTS=<folder>`; the last full run's
  set and output are kept in `evidence/e2e/`.
- **Deployed checks** (`./verify.sh <tailnet address> [name] [port]`). On a
  device: health, DSH's window over the tailnet address, the frame headers on
  its answer, another site's Origin refused, a foreign name refused, and the
  name in `allowHosts` served. On the Mac where the edge runs: the Mac itself
  turned away (unless `allowThisMac` is true, when it runs the device checks),
  and a LAN address refused (its connection closed).

DSH Test refuses dsh-site on purpose (it would serve beyond loopback), so it is
tested only in throwaway homes, never in DSH Test or against the DSH you use.

## Limits

- Plain HTTP only; it does not terminate TLS. For HTTPS on a tailnet name, put
  `tailscale serve` in front of the edge's port (with `allowThisMac: true`, see
  [Setup](#setup)).
- Over plain HTTP the window is not a secure context in the device's browser, so
  three browser features are off there: the microphone (voice input), the
  clipboard API (DSH's own Copy button falls back and works; a copy button that
  calls the clipboard API directly does not), and service workers. Through
  `tailscale serve` (HTTPS) they work.
- `injectAuthCookie: true` needs the `sqlite3` program (macOS has it) and a jar
  that keeps the sign-in cookie unencrypted, as DSH Desktop's has so far. If yours
  is encrypted, the edge says so and you use `injectAuthCookie: false`.
- With `injectAuthCookie: false`, a device needs DSH's sign-in link, which only
  `dsh web` prints; the desktop app does not show it.
- Looking among this process's ports (`discoverTarget`) needs `lsof`; it is only a
  fallback when DSH does not say where its window server is.
