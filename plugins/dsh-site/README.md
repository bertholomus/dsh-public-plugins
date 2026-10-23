# dsh-plugin-dsh-site

Serves the running DSH Desktop GUI to other devices on a private network. A device on the network gets the **same** desktop: the same sessions, workspaces and tools as the machine that runs DSH. It is not a new UI. It is a second front door to the UI that DSH already serves.

Built and tested on macOS with Tailscale. The source gate is a CIDR list, so any private network works.

## Why it is needed

DSH Desktop is an Electron window around a local web server. That server:

- binds `127.0.0.1` only, on a port that can change between restarts;
- accepts a request only if it has the shell's `dsh-auth-*` cookie **and** a loopback `Host` header.

So you cannot open it from another device. Do not start the shell with `--host 0.0.0.0`: DSH refuses that at startup, and it would send the auth cookie in plain text.

## How it works

The plugin runs inside the DSH Host process. It:

1. Opens a second listener (default `0.0.0.0:8443`) and refuses any source address outside `allowCIDRs` with `403`.
2. Finds the shell. It tries `targetOrigin` first. If that fails, it looks through the Host process's own loopback listeners for the shell's `dsh web authentication required` reply.
3. Rewrites `Host`, `Origin` and `Referer` to the loopback origin, so the shell's local-origin checks pass.
4. Optionally adds the shell's live auth cookie (see "Auth modes").
5. Proxies requests, streamed responses (SSE) and WebSocket upgrades.

It answers one path itself: `GET /.dsh-site/health`.

## Auth modes

| `injectAuthCookie` | Who gets in |
| --- | --- |
| `false` (default) | A device in `allowCIDRs` **and** with the shell's cookie. Open the desktop's `?token=` URL once on each device to get the cookie. |
| `true` | Any device in `allowCIDRs`. The plugin reads the live cookie from the Electron cookie jar (`cookieJar`) and adds it. It refreshes the cookie on a `401`. |

With `true`, **network membership is the only gate**. Any device that can reach the port gets full control of DSH, including its shell tools. Use it only on a network you control, and limit access with your network ACLs (for example Tailscale ACLs on the listen port) and a narrow `allowCIDRs`.

`injectAuthCookie: true` needs the `sqlite3` CLI (macOS has it).

## Config

Install the plugin as in the [root README](../../README.md#install-a-plugin), then address its row in `cordis.patch.yml`:

```yaml
- id: dsh-site
  config:
    listenHost: 0.0.0.0
    listenPort: 8443
    targetOrigin: "http://127.0.0.1:19387"
    allowCIDRs: "100.64.0.0/10,127.0.0.0/8,::1/128"
    injectAuthCookie: false
    logFile: "~/.dsh/dsh-site/site.log"
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the plugin off without removing the row. |
| `listenHost` | `0.0.0.0` | Listen address. `0.0.0.0` keeps working if the tailnet IP changes; the CIDR gate still applies. |
| `listenPort` | `8443` | Listen port. Plain HTTP. |
| `targetOrigin` | `http://127.0.0.1:19387` | First place to look for the shell. |
| `discoverTarget` | `true` | If `targetOrigin` does not answer as the shell, search the Host's loopback listeners (uses `lsof`). |
| `allowCIDRs` | `100.64.0.0/10,127.0.0.0/8,::1/128` | Source addresses allowed in. `100.64.0.0/10` is the Tailscale range. IPv4 CIDRs plus `::1/128`. |
| `rewriteHost` | `true` | Send the loopback `Host` upstream. |
| `rewriteOrigin` | `true` | Send loopback `Origin`/`Referer` upstream. |
| `injectAuthCookie` | `false` | See "Auth modes". |
| `cookieJar` | `~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies` | Electron cookie database (macOS path). |
| `logFile` | `~/.dsh/dsh-site/site.log` | Listen, deny and upstream lines. Mode 600. Never logs cookies. |

## A name for it (optional)

To use a name such as `dsh.example.com` instead of an IP, add a DNS **A** record that points to the machine's tailnet IP. If you use Cloudflare, set it to **DNS only** (grey cloud). Cloudflare's proxy cannot reach a `100.64.0.0/10` address. The record is public, but the address is only reachable from your tailnet.

The edge is plain HTTP on its own port, so open `http://dsh.example.com:8443`. A bare `https://dsh.example.com` goes to port 443, which this plugin does not serve. Traffic on a tailnet is already encrypted by WireGuard.

Never expose this port to the public internet. Do not use `tailscale funnel` for it.

## Check it

```bash
./verify.sh <tailnet-ip> [hostname] [port]
```

It checks the health endpoint, the GUI over the tailnet IP, that a LAN source gets `403`, and (if you give a hostname) the DNS name. Exit 0 means all checks passed.

```bash
curl -s http://<tailnet-ip>:8443/.dsh-site/health
# {"ok":true,"plugin":"dsh-site","pid":…,"listen":"0.0.0.0:8443","target":"http://127.0.0.1:…","discovered":false,"authInjected":false}
```

## Limits

- macOS paths by default. On other systems set `cookieJar`, or keep `injectAuthCookie: false`.
- IPv6 sources other than `::1` are refused.
- HTTP only on the listen port.
