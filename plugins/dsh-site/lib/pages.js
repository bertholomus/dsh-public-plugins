/**
 * What the edge answers when it does not pass a request on: a short page in
 * plain words for a browser (light and dark, readable on a phone), and one
 * line of text for a program. Each says what happened and what to do next,
 * and none shows a path, a cookie or DSH's own text.
 *
 * @module dsh-plugin-dsh-site/pages
 */

// Text goes only into element content, never into an attribute, so these four are enough.
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * The pages, by kind. A source outside allowCIDRs gets none: its connection
 * is closed before it is answered (lib/edge.js).
 */
const KINDS = {
    'this-mac': () => ({
        status: 403,
        title: 'This is the Mac DSH runs on',
        lines: [
            'You opened the edge from this Mac itself. The edge serves DSH to your other devices; on this Mac, use DSH\'s own window.',
            'The edge turns away this Mac\'s own programs so that no other program or account on this Mac can use DSH through it. If a proxy on this Mac (such as tailscale serve) sends your devices to the edge, set allowThisMac to true in the dsh-site settings.',
        ],
        text: 'dsh-site: refused: this is the Mac DSH runs on (allowThisMac is false); the edge serves other devices',
    }),
    'not-websocket': () => ({
        status: 400,
        title: 'The edge passes WebSockets only',
        lines: ['This request asked to switch to a protocol that is not a WebSocket. DSH\'s window uses WebSockets only.'],
        text: 'dsh-site: refused: the edge passes WebSocket upgrades only',
    }),
    host: (f) => ({
        status: 421,
        title: 'This address is not one this DSH answers to',
        lines: [
            `You opened it as ${f.host}. To keep other websites from reaching DSH through a name they control, the edge answers only its IP address and the names its owner lists.`,
            'Open it by this Mac\'s IP address, or add the name to allowHosts in the dsh-site settings.',
        ],
        text: `dsh-site: refused host ${f.host}: not an IP address and not in allowHosts`,
    }),
    'bad-host': () => ({
        status: 400,
        title: 'This request has no usable address',
        lines: ['The request did not say which address it was for. Open the page again from its link.'],
        text: 'dsh-site: refused: missing or malformed Host header',
    }),
    framed: () => ({
        status: 403,
        title: 'DSH cannot be shown inside another page',
        lines: [
            'Another page tried to show DSH inside itself. DSH opens only as a page of its own, so that no other site can steer your clicks.',
            'Open DSH\'s address directly.',
        ],
        text: 'dsh-site: refused: DSH cannot be shown inside another page',
    }),
    'sign-in': (f) => ({
        status: 401,
        title: 'Sign in to DSH on this device',
        lines: [
            ...(f.stale ? ['This sign-in link is from an earlier start of DSH: each start of DSH makes a new one.'] : []),
            `DSH lets a device in once it has opened DSH's sign-in link. On this device, open the link that dsh web printed when DSH started (it begins http://127.0.0.1:…/?token=), with its start changed to http://${f.host || 'this address'}/. This device then stays signed in, also when DSH restarts, for up to 30 days.`,
            'The DSH desktop app does not show its sign-in link. To sign devices in with the desktop window instead, set injectAuthCookie to true in the dsh-site settings on the Mac.',
            `Signed in on this device before? Open http://${f.host || 'this address'}/ directly: DSH does not send its sign-in along with a link from another site.`,
        ],
        text: `dsh-site: this device is not signed in to DSH: open DSH's sign-in link through this address once, or set injectAuthCookie to true`,
    }),
    'cross-site': (f) => ({
        status: 403,
        title: 'Refused a request from another website',
        lines: [
            `A page from ${f.origin || 'another website'} tried to use DSH. DSH takes requests only from its own pages.`,
            'If you meant to open DSH, open its address directly.',
        ],
        text: `dsh-site: refused cross-site request from ${f.origin || 'another site'}`,
    }),
    upstream: () => ({
        status: 502,
        title: 'DSH is not answering on this Mac right now',
        lines: [
            'The edge is running, but DSH\'s window server did not answer. It may be starting or restarting.',
            'This page tries again by itself every few seconds.',
        ],
        retry: 5,
        text: 'dsh-site: DSH is not answering; try again in a few seconds',
    }),
    'no-shell': () => ({
        status: 503,
        title: 'DSH\'s window server was not found',
        lines: [
            'The edge could not find the DSH it runs in. It looks again at each request.',
            'This page tries again by itself every few seconds. If it keeps showing, restart DSH on the Mac.',
        ],
        retry: 5,
        text: 'dsh-site: DSH window server not found; try again in a few seconds',
    }),
    'signing-in': () => ({
        status: 503,
        title: 'Waiting for DSH on this Mac to sign in',
        lines: [
            'DSH has started, but its window on the Mac has not signed in yet, so the edge has nothing to sign you in with.',
            'This page tries again by itself every few seconds. If it keeps showing, open the DSH window on the Mac once.',
        ],
        retry: 5,
        text: 'dsh-site: waiting for the DSH window on this Mac to sign in; try again in a few seconds',
    }),
    'cookie-problem': (f) => ({
        status: 503,
        title: 'The edge cannot sign this device in',
        lines: [
            f.encrypted
                ? 'DSH\'s window on this Mac keeps its sign-in cookie encrypted, so the edge cannot read it to sign you in.'
                : `The edge could not read the sign-in cookie of DSH's window on this Mac: ${f.reason || 'the cookie jar could not be read'}.`,
            'On the Mac, if cookieJar points at the wrong file, fix it in the dsh-site settings. Otherwise set injectAuthCookie to false and sign each device in once with DSH\'s own sign-in link (the one dsh web prints when DSH starts; the desktop app does not show its link).',
        ],
        retry: 30,
        text: `dsh-site: cannot sign devices in: ${f.encrypted ? 'the cookie jar is encrypted' : f.reason || 'the cookie jar could not be read'}; set injectAuthCookie to false or fix cookieJar`,
    }),
};

/** The page for `kind` with its facts: `{ status, title, lines, text, retry? }`. */
export function pageFor(kind, facts = {}) {
    const make = KINDS[kind] ?? KINDS.upstream;
    return make(facts);
}

/** True when the request's Accept header asks for HTML (a browser navigation). */
export function wantsHtml(headers) {
    const accept = String(headers?.accept ?? '');
    return /text\/html/i.test(accept);
}

/** The HTML page: DSH's system font and colours, light and dark, readable at 320 px. */
export function renderHtml(page) {
    const retry = page.retry ? `<meta http-equiv="refresh" content="${page.retry}">` : '';
    const lines = page.lines.map((line) => `<p>${escape(line)}</p>`).join('\n      ');
    const again = page.retry ? '<p class="more"><a href="">Try again now</a></p>' : '<p class="more"><a href="">Reload</a></p>';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${retry}
<title>${escape(page.title)} · DSH</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --card: #f6f7f8; --line: #0000001f; --text: #0f1115; --text-2: #4f5358; --link: #2f5fc4; --ring: #4176e6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151517; --card: #232324; --line: #ffffff24; --text: #f9fafb; --text-2: #cfd3d6; --link: #7aaaff; --ring: #7aaaff; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
    font: 400 16px/24px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { width: 100%; max-width: 34rem; padding: 24px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); }
  h1 { margin: 0 0 12px; font-size: 20px; line-height: 28px; font-weight: 600; }
  p { margin: 0 0 8px; color: var(--text-2); }
  p.more { margin-top: 16px; }
  a { color: var(--link); font-weight: 500; border-radius: 4px; }
  a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .from { margin-top: 16px; font-size: 13px; line-height: 20px; }
</style>
</head>
<body>
  <main>
    <h1>${escape(page.title)}</h1>
      ${lines}
      ${again}
    <p class="from">From dsh-site, the private-network edge of DSH on this Mac.</p>
  </main>
</body>
</html>
`;
}

/** What every page of the edge's own says to the browser: no scripts, no frames, no loads by other sites. */
export const PAGE_HEADERS = Object.freeze({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'cross-origin-resource-policy': 'same-origin',
});

/** Send the page for `kind`: HTML to a browser, one line of text to anything else. */
export function sendPage(req, res, kind, facts = {}) {
    const page = pageFor(kind, facts);
    const html = req.method !== 'HEAD' && wantsHtml(req.headers);
    const body = html ? renderHtml(page) : `${page.text}\n`;
    const headers = {
        'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        ...PAGE_HEADERS,
        ...(page.retry ? { 'retry-after': String(page.retry) } : {}),
    };
    if (res.headersSent) {
        res.end();
        return page;
    }
    res.writeHead(page.status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return page;
}

/** The raw HTTP answer that refuses a WebSocket upgrade, for a socket that has not been answered. */
export function upgradeRefusal(kind, facts = {}) {
    const page = pageFor(kind, facts);
    const body = `${page.text}\n`;
    const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 421: 'Misdirected Request', 502: 'Bad Gateway', 503: 'Service Unavailable' }[page.status] ?? 'Error';
    return `HTTP/1.1 ${page.status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}
