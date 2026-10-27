import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_HEADERS, pageFor, renderHtml, sendPage, upgradeRefusal, wantsHtml } from '../../lib/pages.js';

const KINDS = ['host', 'bad-host', 'framed', 'cross-site', 'sign-in', 'upstream', 'no-shell', 'signing-in', 'cookie-problem', 'this-mac', 'not-websocket'];

test('each page has a status, a title, what to do next, and one line for programs', () => {
    const expect = { host: 421, 'bad-host': 400, framed: 403, 'cross-site': 403, 'sign-in': 401, upstream: 502, 'no-shell': 503, 'signing-in': 503, 'cookie-problem': 503, 'this-mac': 403, 'not-websocket': 400 };
    for (const kind of KINDS) {
        const page = pageFor(kind, { ip: '192.168.1.5', host: 'evil.example:8443', origin: 'http://evil.example' });
        assert.equal(page.status, expect[kind], kind);
        assert.ok(page.title.length > 10, kind);
        assert.ok(page.lines.length >= 1, kind);
        assert.match(page.text, /^dsh-site: /, kind);
        assert.doesNotMatch(`${page.title} ${page.lines.join(' ')}`, /ECONN|undefined|null|\[object/, kind);
    }
    assert.equal(pageFor('no-such-kind').status, 502, 'an unknown kind falls back to a page, never a throw');
    assert.match(pageFor('host', { host: 'evil.example:8443' }).lines.join(' '), /add the name to allowHosts/);
    assert.equal(pageFor('upstream').retry, 5);
});

test("a device not signed in (DSH's own sign-in is the gate): how to sign in, where the link comes from, and the other way", () => {
    const page = pageFor('sign-in', { host: '100.101.102.103:8443' });
    const words = page.lines.join(' ');
    assert.equal(page.status, 401);
    assert.match(words, /open the link that dsh web printed when DSH started \(it begins http:\/\/127\.0\.0\.1:…\/\?token=\), with its start changed to http:\/\/100\.101\.102\.103:8443\//);
    assert.match(words, /stays signed in, also when DSH restarts, for up to 30 days/);
    assert.match(words, /The DSH desktop app does not show its sign-in link/);
    assert.match(words, /set injectAuthCookie to true/);
    assert.match(pageFor('sign-in', { host: 'x', stale: true }).lines[0], /from an earlier start of DSH/);
    assert.match(pageFor('sign-in', { host: 'mac:8443' }).lines.at(-1), /Signed in on this device before\? Open http:\/\/mac:8443\/ directly: DSH does not send its sign-in along with a link from another site\./);
    assert.doesNotMatch(renderHtml(pageFor('sign-in', { host: '"><script>x</script>' })), /<script>x/, 'the address is escaped');
});

test('this Mac\'s own programs: the page says where DSH is on this Mac and the one setting that lets a proxy in', () => {
    const page = pageFor('this-mac');
    const words = page.lines.join(' ');
    assert.equal(page.status, 403);
    assert.equal(page.title, 'This is the Mac DSH runs on');
    assert.match(words, /on this Mac, use DSH's own window/);
    assert.match(words, /no other program or account on this Mac can use DSH through it/);
    assert.match(words, /set allowThisMac to true in the dsh-site settings/);
    assert.match(upgradeRefusal('this-mac'), /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.match(upgradeRefusal('not-websocket'), /^HTTP\/1\.1 400 Bad Request\r\n[\s\S]*the edge passes WebSocket upgrades only\n$/);
});

test('a cookie the edge cannot read: the page says why and both ways out, never a path', () => {
    const encrypted = pageFor('cookie-problem', { encrypted: true });
    assert.match(encrypted.lines.join(' '), /keeps its sign-in cookie encrypted/);
    assert.match(encrypted.lines.join(' '), /set injectAuthCookie to false and sign each device in once with DSH's own sign-in link \(the one dsh web prints when DSH starts; the desktop app does not show its link\)/);
    assert.equal(encrypted.text, 'dsh-site: cannot sign devices in: the cookie jar is encrypted; set injectAuthCookie to false or fix cookieJar');
    const missing = pageFor('cookie-problem', { reason: 'the cookie jar file (cookieJar) does not exist' });
    assert.match(missing.lines.join(' '), /could not read the sign-in cookie of DSH's window on this Mac: the cookie jar file \(cookieJar\) does not exist\./);
    assert.match(missing.lines.join(' '), /On the Mac, if cookieJar points at the wrong file, fix it in the dsh-site settings\. Otherwise set injectAuthCookie to false/);
    assert.equal(missing.retry, 30, 'it looks again, but not every few seconds');
    assert.match(pageFor('cookie-problem', {}).text, /the cookie jar could not be read/);
});

test('HTML is escaped: an Origin a page sends cannot inject markup', () => {
    const html = renderHtml(pageFor('cross-site', { origin: 'http://x"><script>alert(1)</script>' }));
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
});

/** Contrast of two #rrggbb colours (WCAG 2.1). */
function contrast(a, b) {
    const lum = (hex) => {
        const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
    };
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
}

test('text, secondary text and links reach 4.5:1 on the card in light and dark; the focus ring 3:1', () => {
    const html = renderHtml(pageFor('upstream'));
    const vars = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+): (#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
    const light = vars(/:root \{([^}]+)\}/.exec(html)[1]);
    const dark = vars(/prefers-color-scheme: dark\) \{ :root \{([^}]+)\}/.exec(html)[1]);
    for (const [name, theme] of [['light', light], ['dark', dark]]) {
        for (const ground of ['card', 'bg']) {
            for (const fg of ['text', 'text-2', 'link']) {
                const ratio = contrast(theme[fg], theme[ground]);
                assert.ok(ratio >= 4.5, `${name} ${fg} on ${ground}: ${ratio.toFixed(2)}`);
            }
            assert.ok(contrast(theme.ring, theme[ground]) >= 3, `${name} ring on ${ground}`);
        }
    }
});

test('the HTML page is complete: language, viewport, colour schemes, a heading, a retry link that keeps focus visible', () => {
    const html = renderHtml(pageFor('signing-in'));
    assert.match(html, /<html lang="en">/);
    assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
    assert.match(html, /name="color-scheme" content="light dark"/);
    assert.match(html, /<main>[\s\S]*<h1>Waiting for DSH on this Mac to sign in<\/h1>/);
    assert.match(html, /http-equiv="refresh" content="5"/);
    assert.match(html, /<a href="">Try again now<\/a>/);
    assert.match(html, /a:focus-visible \{ outline: 2px solid var\(--ring\)/);
    assert.match(renderHtml(pageFor('host', { host: 'x.example' })), /<a href="">Reload<\/a>/);
    assert.doesNotMatch(renderHtml(pageFor('host', { host: 'x.example' })), /http-equiv="refresh"/, 'a refusal does not reload by itself');
});

function fakeRes() {
    const res = { headersSent: false, status: 0, headers: {}, body: undefined };
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    res.end = (body) => { res.body = body; };
    return res;
}

test('sendPage: HTML to a browser, text to a program, nothing for HEAD; no caching, a Retry-After where it retries', () => {
    const browser = fakeRes();
    sendPage({ method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } }, browser, 'upstream');
    assert.equal(browser.status, 502);
    assert.match(browser.headers['content-type'], /text\/html/);
    assert.equal(browser.headers['retry-after'], '5');
    assert.equal(browser.headers['cache-control'], 'no-store');
    assert.equal(browser.headers['content-length'], Buffer.byteLength(browser.body));
    for (const [name, value] of Object.entries(PAGE_HEADERS)) assert.equal(browser.headers[name], value, name);
    assert.equal(browser.headers['x-frame-options'], 'DENY');
    assert.match(browser.headers['content-security-policy'], /frame-ancestors 'none'/);
    const program = fakeRes();
    sendPage({ method: 'GET', headers: { accept: '*/*' } }, program, 'cross-site', { origin: 'http://evil.example' });
    assert.equal(program.status, 403);
    assert.equal(program.body, 'dsh-site: refused cross-site request from http://evil.example\n');
    const head = fakeRes();
    sendPage({ method: 'HEAD', headers: { accept: 'text/html' } }, head, 'host', { host: 'x.example' });
    assert.equal(head.status, 421);
    assert.equal(head.body, undefined);
    const late = fakeRes();
    late.headersSent = true;
    sendPage({ method: 'GET', headers: {} }, late, 'upstream');
    assert.equal(late.status, 0, 'a reply already started is ended, not answered twice');
    assert.equal(wantsHtml({ accept: 'application/json' }), false);
});

test('a refused WebSocket gets a real HTTP answer, then the socket closes', () => {
    const raw = upgradeRefusal('cross-site', { origin: 'http://evil.example' });
    assert.match(raw, /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.match(raw, /Connection: close\r\n/);
    const body = raw.split('\r\n\r\n')[1];
    assert.equal(Number(/Content-Length: (\d+)/.exec(raw)[1]), Buffer.byteLength(body));
    assert.match(upgradeRefusal('host', { host: 'a.example' }), /^HTTP\/1\.1 421 Misdirected Request/);
    assert.match(upgradeRefusal('no-shell'), /^HTTP\/1\.1 503 /);
});
