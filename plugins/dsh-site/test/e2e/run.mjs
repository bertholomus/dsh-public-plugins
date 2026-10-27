#!/usr/bin/env node
/**
 * dsh-site on a real DSH, in a throwaway home.
 *
 * DSH (DSH_BIN, else the newest test runtime) runs with a scripted model and
 * dsh-site loaded, its edge on 127.0.0.1 and a free port only: nothing in
 * this test is reachable from the network, and nothing touches the DSH you
 * use (its home, port or cookie jar). The desktop window's cookie jar is a
 * stand-in SQLite file this test writes, as Electron would.
 *
 * It proves, on that DSH:
 *   - the edge finds the DSH it runs in by itself (no targetOrigin), waits
 *     for it quietly while it starts, and listens on loopback only;
 *   - before the window has signed in, a browser gets the "waiting" page (a
 *     stale cookie for another port is never used); once the jar has the
 *     cookie, a device with no cookie gets DSH's window;
 *   - through the edge, as the window does: a session is made and prompted,
 *     the scripted model gets the prompt and DSH writes its reply to the
 *     session's log; DSH's events socket opens through the edge;
 *   - verify.sh (the deployed checks) passes against the edge;
 *   - a real browser on made-up names mapped to 127.0.0.1 (so it sends what it
 *     sends to a tailnet name over plain HTTP: no Sec-Fetch-* marks, no Origin
 *     on frames) cannot show DSH in another website's frame, load it as that
 *     site's image, post to it or open its events socket, in both sign-in modes;
 *   - a page on another site, a rebinding name and an upgrade to another
 *     protocol are refused before DSH sees them; a listed name is served;
 *   - this Mac's own programs (allowThisMac false) get the "This is the Mac
 *     DSH runs on" page and never DSH, for pages, health and the events
 *     socket; a loopback range in allowCIDRs without allowThisMac keeps the
 *     port closed and says why; verify.sh run on the Mac says the Mac is
 *     turned away;
 *   - off cuts the open socket and closes the port; on again serves again;
 *   - a wrong setting, a misspelt key and a row with no settings keep the
 *     port closed and say why (the last in the default log, inside DSH's own
 *     home); taking the plugin out of the profile's bundles (DSH's Plugins
 *     page) closes the port;
 *   - a cookie jar it cannot read gets a page that says why and what to do;
 *   - a DSH restart and a crash bring the edge back once, repeating nothing;
 *   - injectAuthCookie off: a browser that is not signed in gets the sign-in
 *     page; DSH's own sign-in link works through the edge, and the device stays
 *     signed in when DSH restarts on a new port; health tells a device that is
 *     not signed in only ok and the version; no sign-in token, also from a
 *     refused link, reaches the edge's log;
 *   - pictures (Playwright, when there): the window through the edge light,
 *     dark and at 760 px, the waiting, sign-in, cookie-problem, refused-name and
 *     this-Mac pages light and dark, and another website's page with DSH refused.
 *
 * The DSH process runs with a throwaway HOME as well, so no default path (the
 * plugin's own log, the desktop cookie jar) can reach the owner's files.
 *
 *   DSH_BIN=…/@deepseek-ai/dsh/lib/bin.js node test/e2e/run.mjs
 *   SHOTS=<folder> keeps the pictures there; KEEP=1 keeps the temporary folder.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer, request } from 'node:http';
import { basename, join } from 'node:path';
import { connect } from 'node:net';
import { checks, dismissNotices, DshRun, dshBin, findPlaywright, freePort, httpGet, launchChromium, openWindow, repoRoot, setDark, shot, sleep, waitFor } from './harness.mjs';
import { startFakeModel } from './fake-model.mjs';

const bin = dshBin();
const label = process.env.DSH_LABEL ?? 'dsh';
if (!bin) {
    console.log('not ok - no DSH to run (set DSH_BIN or install a test runtime)\n# 0 passed, 1 failed');
    process.exit(1);
}
const shots = process.env.SHOTS ? join(process.env.SHOTS, label) : join(repoRoot, 'evidence', 'e2e', label);
const t = checks();
const { check, step } = t;
const q = JSON.stringify;

const model = await startFakeModel();
const dshPort = await freePort();
const edgePort = await freePort();
const run = new DshRun({ label: 'dsh-site', bin, port: dshPort, plugins: { 'dsh-plugin-dsh-site': repoRoot } });
const jar = join(run.root, 'Cookies');
const siteLog = join(run.root, 'site.log');
const edge = `http://127.0.0.1:${edgePort}`;
const edgeWs = `ws://127.0.0.1:${edgePort}`;
// A throwaway HOME for the DSH process as well, so no default path (the desktop cookie jar) can reach the owner's
// files. A row with no settings logs to the default log, dsh-site/site.log inside DSH's own home (DSH_HOME).
const fakeHome = join(run.root, 'user-home');
mkdirSync(fakeHome, { recursive: true });
run.env = { ...run.env, HOME: fakeHome };
const defaultLog = join(run.home, 'dsh-site', 'site.log');
const homeLog = join(fakeHome, '.dsh', 'dsh-site', 'site.log');
// Made-up names, mapped to 127.0.0.1 in the test browser only (never a real tailnet name).
const siteName = 'dsh.site.test';
const named = `http://${siteName}:${edgePort}`;

/**
 * The dsh-site row: loopback only, the stand-in jar, the log in the throwaway folder. Every request of this test
 * comes from this Mac, so the row lets this Mac in (allowThisMac) except where a step says otherwise.
 */
function row(extra = {}) {
    const config = {
        listenHost: '127.0.0.1',
        listenPort: edgePort,
        allowCIDRs: '127.0.0.0/8',
        allowThisMac: true,
        injectAuthCookie: true,
        cookieJar: jar,
        logFile: siteLog,
        ...extra,
    };
    return `- id: dsh-site\n  config:\n${Object.entries(config).map(([k, v]) => `    ${k}: ${q(v)}`).join('\n')}\n`;
}

/** Change the row while DSH runs (DSH applies a changed patch live), and wait for the log line that shows it took. */
async function setRow(extra, waitLine) {
    const before = logText().length;
    run.rows = row(extra);
    run.writeProfile(model.port);
    if (waitLine) await waitFor(() => waitLine.test(logText().slice(before)), `the log line ${waitLine}`, 30000);
}

const logText = () => (existsSync(siteLog) ? readFileSync(siteLog, 'utf8') : '');
const count = (re, text = logText()) => (text.match(new RegExp(re, 'g')) ?? []).length;

function get(url, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = request(url, { method, headers: { connection: 'close', ...headers } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.setTimeout(30000, () => req.destroy(new Error(`no answer from ${url}`)));
        req.on('error', reject);
        req.end();
    });
}
const health = async (headers = {}) => JSON.parse((await get(`${edge}/.dsh-site/health`, headers)).text);

/** Raw bytes to the edge: what came back within `ms`. */
function raw(text, ms = 3000) {
    return new Promise((resolve) => {
        let got = '';
        const s = connect(edgePort, '127.0.0.1', () => s.write(text));
        s.on('data', (d) => { got += d; });
        s.on('error', () => {});
        const timer = setTimeout(() => { s.destroy(); resolve(got); }, ms);
        s.on('close', () => { clearTimeout(timer); resolve(got); });
    });
}

/**
 * The stand-in jar, as the desktop window's Electron keeps it: a stale cookie from an
 * earlier DSH start on another port (which must never be sent), plus `cookie` when given.
 */
function writeJar(cookie) {
    const rows = [`('127.0.0.1','${cookieNameFor('127.0.0.1:1')}','stale-from-another-start', x'')`];
    if (cookie) {
        const [name, ...rest] = cookie.split('=');
        rows.push(`('127.0.0.1','${name}','${rest.join('=')}', x'')`);
    }
    execFileSync('sqlite3', [jar, `create table if not exists cookies(host_key text, name text, value text, encrypted_value blob);
        delete from cookies; insert into cookies values ${rows.join(', ')};`]);
}
const cookieNameFor = (authority) => `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;

/** DSH's events socket (/api/remote.mux) opened through the edge with `origin`: its first frame, or why it did not open. */
function openMux(origin, keep = false) {
    return new Promise((resolve) => {
        const socket = new WebSocket(`${edgeWs}/api/remote.mux`, { headers: { origin } });
        const timer = setTimeout(() => resolve({ ok: false, why: 'no frame in 15 s', socket }), 15000);
        socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })));
        socket.addEventListener('message', ({ data }) => {
            clearTimeout(timer);
            let frame;
            try { frame = JSON.parse(String(data)); } catch {}
            resolve({ ok: frame?.value?.type === 'ready', frame, socket });
            if (!keep) socket.close();
        });
        socket.addEventListener('error', () => { clearTimeout(timer); resolve({ ok: false, why: 'refused', socket }); });
    });
}

/**
 * One of DSH's session endpoints through `via`, as the window calls it. DSH names the argument
 * `request` on most endpoints and `_request` on some (session/list on 0.2.1); its error says which.
 */
async function sessionApi(endpoint, request, via) {
    const first = await run.api(endpoint, { request }, via);
    if (first?.ok === false && /arguments-invalid/.test(first.error?.code ?? '') && /missing "_request"/.test(first.error?.message ?? '')) {
        return run.api(endpoint, { _request: request }, via);
    }
    return first;
}
const listSessions = (via) => sessionApi('session/list', {}, via);

/**
 * Another website (evil.example) and a header echo (echo.site.test), both on 127.0.0.1 under made-up names
 * that only the test browser resolves.
 */
async function startSites() {
    const seen = [];
    const server = createServer((req, res) => {
        const port = server.address().port;
        if (String(req.headers.host ?? '').startsWith('echo.site.test')) {
            seen.push({ url: req.url, headers: req.headers });
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><p>echo</p>');
            return;
        }
        const pages = {
            '/frame': `<!doctype html><meta charset="utf-8"><title>Another website</title>
<style>body{font:14px system-ui;margin:16px;color:#222;background:#fff} iframe{border:2px dashed #b33;display:block;margin:6px 0 14px}</style>
<h1>evil.example: a page on another website</h1>
<p>DSH by name, in a frame (the edge's answer carries X-Frame-Options and frame-ancestors):</p>
<iframe id="byname" src="${named}/" width="700" height="220"></iframe>
<p>DSH by 127.0.0.1, in a frame (the browser marks this one as a frame from another site):</p>
<iframe id="byip" src="http://127.0.0.1:${edgePort}/" width="700" height="120"></iframe>
<iframe id="echo" src="http://echo.site.test:${port}/echo-frame" width="60" height="30"></iframe>
<img id="img" src="${named}/" width="30" height="30" alt="">
<script>
window.__ws = 'pending';
try {
  const s = new WebSocket('ws://${siteName}:${edgePort}/api/remote.mux');
  s.onopen = () => { window.__ws = 'open'; };
  s.onerror = () => { if (window.__ws === 'pending') window.__ws = 'refused'; };
  s.onclose = () => { if (window.__ws === 'pending') window.__ws = 'closed'; };
} catch (e) { window.__ws = 'threw'; }
</script>`,
            '/form': `<!doctype html><meta charset="utf-8"><title>Another website</title>
<form method="POST" action="${named}/api/session/list" enctype="text/plain"><input name="x" value="1"><button>Send</button></form>`,
            '/link': `<!doctype html><meta charset="utf-8"><title>Another website</title><a id="go" href="${named}/">Open DSH</a>`,
        };
        const page = pages[req.url];
        res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page ?? 'not here');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Another website's page in `context`: which of DSH's answers it could frame, embed, post to or open, and what the browser said. */
async function attackFrom(context, label) {
    const page = await context.newPage();
    const said = [];
    const failed = [];
    page.on('console', (m) => said.push(m.text()));
    page.on('requestfailed', (r) => failed.push(`${r.resourceType()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
    const echoed = sites.seen.length;
    await page.goto(`${evil}/frame`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ws !== 'pending', null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const frames = [];
    for (const frame of page.frames()) {
        if (frame === page.mainFrame() || frame.url().includes('echo.site.test')) continue;
        const shown = await frame.evaluate(() => document.documentElement.outerHTML.includes('__DSH_BOOT__')).catch(() => false);
        frames.push({ url: frame.url(), shown });
    }
    const ws = await page.evaluate(() => window.__ws);
    await shot(page, shots, `attack-frame-refused-${label}-light-760`);
    await page.close();
    const form = await context.newPage();
    await form.goto(`${evil}/form`, { waitUntil: 'load' });
    const [posted] = await Promise.all([
        form.waitForResponse((r) => r.url().startsWith(`${named}/api/`), { timeout: 15000 }).catch(() => null),
        form.click('button'),
    ]);
    await form.waitForLoadState('load').catch(() => {});
    const formText = await form.evaluate(() => document.body.innerText).catch(() => '');
    if (label === 'cookie-mode') await shot(form, shots, 'attack-form-post-refused-light-760');
    await form.close();
    const echo = sites.seen.slice(echoed).find((r) => r.url === '/echo-frame');
    return { frames, ws, said, failed, posted: posted?.status(), formText, echo };
}

function attackChecks(seen, mode) {
    const marks = seen.echo ? ['sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-mode', 'origin'].filter((h) => h in seen.echo.headers) : ['no request reached the echo'];
    check(`${mode}: to a made-up name the browser marks a frame with nothing (no Sec-Fetch-*, no Origin), as it does a tailnet name`, marks.length === 0, marks.join(', '));
    check(`${mode}: no frame on another website shows DSH (by name or by 127.0.0.1)`, seen.frames.length > 0 && seen.frames.every((f) => !f.shown), JSON.stringify(seen.frames));
    check(`${mode}: the browser refused to show the edge's answer inside the other site's page`, seen.said.some((l) => /Refused to (display|frame)/.test(l) && /X-Frame-Options|frame-ancestors/.test(l)) || seen.failed.some((l) => /^document .*ERR_BLOCKED_BY_RESPONSE/.test(l)), [...seen.said, ...seen.failed].join(' | ').slice(0, 600));
    check(`${mode}: DSH as another website's image is blocked by Cross-Origin-Resource-Policy`, seen.failed.some((l) => l.startsWith(`image ${named}/`) && /ERR_BLOCKED_BY_RESPONSE\.NotSameOrigin/.test(l)), seen.failed.join(' | ').slice(0, 400));
    check(`${mode}: DSH's events socket does not open from another website`, seen.ws === 'refused' || seen.ws === 'closed', String(seen.ws));
    check(`${mode}: a form post from another website gets 403 and the edge's words`, seen.posted === 403 && /Refused a request from another website/.test(seen.formText), `${seen.posted} ${seen.formText.slice(0, 160)}`);
}

const lanIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const via = { base: `${edge}/` }; // the edge, with no cookie of the device's own

let sessionId;
let pw;
const marker = `Hello through the edge ${randomUUID().slice(0, 8)}`;
const sites = await startSites();
const evil = `http://evil.example:${sites.port}`;
let shellToken = '';
let shellCookie = '';
let shellContext;
try {
    pw = await findPlaywright();
} catch {}

try {
    writeJar();
    run.rows = row();
    run.writeProfile(model.port);
    await run.boot('first start');
    await waitFor(() => /listening on 127\.0\.0\.1:/.test(logText()), 'the edge to listen', 30000);

    await step('the edge finds the DSH it runs in by itself and listens on loopback only', async () => {
        const h = await waitFor(async () => { const x = await health(); return x.target ? x : undefined; }, 'health with a target', 20000);
        check('health names this DSH\'s own window server, found through DSH itself', h.target === `http://127.0.0.1:${dshPort}` && h.foundBy === 'dsh', JSON.stringify(h));
        check('health: listening, this DSH\'s cookie not in the jar yet (a stale one for another port is not used)', h.ok === true && h.cookie === 'missing' && h.authInjected === false, JSON.stringify(h));
        check('nothing said about DSH not being found while it was starting', !/not found yet/.test(logText()), logText());
        const pids = execFileSync('lsof', ['-nP', `-iTCP:${edgePort}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
        check('the edge listens on 127.0.0.1 only, inside DSH\'s own process', /TCP 127\.0\.0\.1:\d+ \(LISTEN\)/.test(pids) && !/TCP \*:/.test(pids) && pids.includes(String(run.child.pid)), pids);
        if (lanIp) {
            const lan = await get(`http://${lanIp}:${edgePort}/`).then((r) => r.status, (e) => e.code);
            check(`not reachable from the network (this Mac's ${lanIp.split('.').slice(0, 2).join('.')}.x address is refused at connect)`, lan === 'ECONNREFUSED', String(lan));
        }
    });

    let pageShots;
    if (pw) {
        try {
            const browser = await pw.chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-gpu-rasterization', `--host-resolver-rules=MAP rebind.attacker.example 127.0.0.1, MAP ${siteName} 127.0.0.1, MAP evil.example 127.0.0.1, MAP echo.site.test 127.0.0.1`] });
            pageShots = { browser };
        } catch (error) {
            console.log(`# no pictures: ${error.message}`);
        }
    }
    const pagePicture = async (url, name) => {
        if (!pageShots) return;
        for (const dark of [false, true]) {
            const context = await pageShots.browser.newContext({ viewport: { width: 760, height: 560 }, colorScheme: dark ? 'dark' : 'light' });
            const page = await context.newPage();
            await page.goto(url, { waitUntil: 'load' }).catch(() => {});
            await shot(page, shots, `${name}-${dark ? 'dark' : 'light'}-760`);
            await context.close();
        }
    };

    await step('before the desktop window signed in: a browser gets a page that waits and retries', async () => {
        const res = await get(`${edge}/`, { accept: 'text/html' });
        check('GET / is 503 with the waiting page and Retry-After', res.status === 503 && /Waiting for DSH on this Mac to sign in/.test(res.text) && res.headers['retry-after'] === '5', `${res.status} ${res.text.slice(0, 200)}`);
        check('the log says why, in words', /no sign-in cookie for 127\.0\.0\.1:\d+ in the cookie jar yet/.test(logText()), logText());
        await pagePicture(`${edge}/`, 'page-waiting-for-sign-in');
    });

    const web = await run.signIn();
    await step('once the jar has the window\'s cookie, a device with no cookie gets DSH\'s window', async () => {
        writeJar(web.cookie);
        await sleep(3200); // a miss is kept 3 s
        const res = await get(`${edge}/`, { accept: 'text/html' });
        check('GET / through the edge, no cookie of its own: 200 and DSH\'s window', res.status === 200 && res.text.includes('__DSH_BOOT__'), `${res.status} ${res.text.slice(0, 200)}`);
        const h = await health();
        check('health: the cookie found and used', h.cookie === 'found' && h.authInjected === true, JSON.stringify(h));
        check('the cookie\'s value is never in the edge\'s log', !logText().includes(web.cookie.split('=').slice(1).join('=')));
        const direct = await httpGet(`http://127.0.0.1:${dshPort}/`);
        check('DSH itself still asks for its own sign-in (the edge changed nothing in DSH)', direct.status === 401, String(direct.status));
    });

    await step('through the edge, as the window does: a session is made, prompted, and answered', async () => {
        const made = await sessionApi('session/create', { cwd: run.ws }, via);
        sessionId = made?.value?.sessionId;
        check('session/create through the edge', made?.ok === true && typeof sessionId === 'string', JSON.stringify(made));
        const text = `E2E:say ${marker}`;
        const sent = await sessionApi('session/prompt', { sessionId, content: [{ type: 'text', text }], mode: 'queue', requestId: `e2e-${randomUUID()}` }, via);
        check('session/prompt through the edge', sent?.ok === true, JSON.stringify(sent));
        await waitFor(() => model.requests.some((r) => r.fresh.includes(text)), 'the scripted model to get the prompt', 60000);
        check('the scripted model got the prompt sent through the edge', true);
        const want = text.slice('E2E:say '.length);
        const replied = await waitFor(() => run.savedEvents(sessionId).find((e) => JSON.stringify(e).includes(want) && /assistant/.test(JSON.stringify(e))), 'the reply in the session\'s log', 60000).catch(() => undefined);
        check('DSH wrote the reply to the session\'s own log', Boolean(replied), JSON.stringify(run.savedEvents(sessionId).map((e) => e.type)).slice(0, 400));
        const listed = await listSessions(via);
        check('the session is in DSH\'s list as read through the edge', JSON.stringify(listed).includes(sessionId), JSON.stringify(listed).slice(0, 300));
        const mux = await openMux(edge);
        check('DSH\'s events socket opens through the edge (its ready frame)', mux.ok, JSON.stringify(mux.frame ?? mux.why));
    });

    if (pw) {
        await step('pictures: the session made through the edge, open in the window through the edge (1280 and 760 px, light and dark)', async () => {
            const visitor = { signIn: async () => ({ link: `${edge}/` }) };
            const w = await openWindow(visitor, pw, { width: 1280, height: 860, colorScheme: 'light' });
            try {
                // Open the session from the window's list (its workspace group may be folded). On a busy machine
                // DSH's first-run notice can come late and take every click, so each round puts it away first.
                const row = w.page.getByText('Hello through the edge').first();
                const conversation = async () => {
                    const body = await w.page.evaluate(() => document.body.innerText).catch(() => '');
                    return body.split(marker).length - 1 >= 2 ? body : undefined;
                };
                let shown;
                const until = Date.now() + 60000;
                while (!shown && Date.now() < until) {
                    await dismissNotices(w.page);
                    if (!(await row.isVisible().catch(() => false))) {
                        for (const group of ['Ungrouped', 'Default workspace', basename(run.ws)]) {
                            const g = w.page.getByText(group, { exact: true }).first();
                            if (await g.isVisible().catch(() => false)) await g.click({ timeout: 3000 }).catch(() => {});
                        }
                        await w.page.waitForTimeout(800);
                        continue;
                    }
                    await row.click({ timeout: 3000 }).catch(() => {});
                    shown = await waitFor(conversation, 'the conversation in the window', 6000).catch(() => undefined);
                }
                await dismissNotices(w.page);
                check('the window through the edge shows the session made through the edge: the prompt and the model\'s reply', Boolean(shown), (await w.page.evaluate(() => document.body.innerText)).slice(0, 300));
                for (const [width, dark] of [[1280, false], [1280, true], [760, false], [760, true]]) {
                    await w.page.setViewportSize({ width, height: 860 });
                    await setDark(w.page, dark);
                    // The pointer to empty space, so no tooltip of the last click shows in the picture.
                    await w.page.mouse.move(width - 24, 420).catch(() => {});
                    await w.page.waitForTimeout(500);
                    await shot(w.page, shots, `window-${dark ? 'dark' : 'light'}-${width}`);
                }
                check('no page errors in the window through the edge', w.errors.length === 0, w.errors.join(' | ').slice(0, 300));
            } finally {
                await w.browser.close();
            }
        });
    }

    await step('a real browser: another website cannot frame DSH, embed it, post to it or open its socket (signed in by the desktop window\'s cookie)', async () => {
        if (!pageShots) {
            check('a real browser for this check', false, 'no Playwright: install the e2e tools');
            return;
        }
        await setRow({ allowHosts: siteName }, /names: dsh\.site\.test\)/);
        const context = await pageShots.browser.newContext({ viewport: { width: 760, height: 700 } });
        try {
            const typed = await context.newPage();
            const res = await typed.goto(`${named}/`, { waitUntil: 'load' });
            check('cookie mode: the edge by a made-up name, opened directly: DSH\'s window, signed in', res?.status() === 200 && (await typed.content()).includes('__DSH_BOOT__'), String(res?.status()));
            await typed.close();
            attackChecks(await attackFrom(context, 'cookie-mode'), 'cookie mode');
            const log = logText();
            check('cookie mode: the marked frame and the cross-site requests were refused at the edge, before DSH, and logged', /refused 127\.0\.0\.1 GET \/: a frame or embed from another page \(iframe/.test(log) && /cross-site request from http:\/\/evil\.example:\d+/.test(log), log.split('\n').filter((l) => /refused/.test(l)).slice(-6).join('\n'));
            const linkPage = await context.newPage();
            await linkPage.goto(`${evil}/link`, { waitUntil: 'load' });
            const [nav] = await Promise.all([linkPage.waitForNavigation({ timeout: 15000 }).catch(() => null), linkPage.click('#go')]);
            check('cookie mode: a link on another website opens DSH as a page of its own, not inside that page', nav?.status() === 200 && linkPage.url().startsWith(named), `${nav?.status()} ${linkPage.url()}`);
            await linkPage.close();
        } finally {
            await context.close();
        }
        await setRow({}, /listening on 127\.0\.0\.1:\d+ for 127\.0\.0\.0\/8;/);
    });

    await step('refused before DSH sees it: another site, a rebinding name', async () => {
        const evil = await openMux('http://evil.example');
        check('a page on another site cannot open DSH\'s events socket through the edge', !evil.ok && evil.why === 'refused', JSON.stringify(evil.frame ?? evil.why));
        const post = await run.api('session/list', { request: {} }, { base: `${edge}/`, origin: 'http://evil.example' });
        check('a cross-site POST is refused (403, the edge\'s words)', post?.ok === false && /http\/403/.test(post.error?.code ?? '') && /refused cross-site request from http:\/\/evil\.example/.test(post.error?.message ?? ''), JSON.stringify(post));
        const rebound = await get(`${edge}/`, { host: `rebind.attacker.example:${edgePort}`, accept: 'text/html' });
        check('a rebinding name gets 421 and the page that names allowHosts', rebound.status === 421 && /add the name to allowHosts/.test(rebound.text), `${rebound.status}`);
        const h2c = await raw(`GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:${edgePort}\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n`);
        check('an upgrade to another protocol than WebSocket gets 400 and the edge\'s words, not DSH', /^HTTP\/1\.1 400 /.test(h2c) && /the edge passes WebSocket upgrades only/.test(h2c), h2c.slice(0, 160));
        check('each refusal is in the log, in words', /refused 127\.0\.0\.1 GET \(WebSocket\) \/api\/remote\.mux: cross-site request from http:\/\/evil\.example/.test(logText()) && /Host rebind\.attacker\.example:\d+ is not an IP address and not in allowHosts/.test(logText()) && /an upgrade to "h2c"; the edge passes WebSockets only/.test(logText()), logText().split('\n').slice(-8).join('\n'));
        await pagePicture(`http://rebind.attacker.example:${edgePort}/`, 'page-refused-name');
    });

    await step('verify.sh, the deployed checks, pass against this edge', async () => {
        const out = spawnSync('bash', [join(repoRoot, 'verify.sh'), '127.0.0.1', 'localhost', String(edgePort)], { encoding: 'utf8', timeout: 90000 });
        const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
        check('verify.sh exits 0 with no failed check', out.status === 0 && /pass=\d+ fail=0/.test(text), text.trim().split('\n').slice(-8).join(' | '));
        check('it checked health, the window, another site, an unlisted name and the name given', ['health', "DSH's window over 127.0.0.1", 'frame headers on the answer', 'another site refused', 'unlisted name refused', 'name localhost served'].every((c) => text.includes(`PASS  ${c}`)), text.trim().split('\n').join(' | '));
    });

    await step('a name listed in allowHosts is served', async () => {
        await setRow({ allowHosts: 'mymac.example.ts.net' }, /listening on 127\.0\.0\.1:\d+ for 127\.0\.0\.0\/8 \(names: mymac\.example\.ts\.net\)/);
        const res = await get(`${edge}/`, { host: `mymac.example.ts.net:${edgePort}`, accept: 'text/html' });
        check('Host mymac.example.ts.net (listed) gets DSH\'s window', res.status === 200 && res.text.includes('__DSH_BOOT__'), String(res.status));
    });

    await step('this Mac\'s own programs (allowThisMac false) get a page, never DSH; a loopback range needs allowThisMac', async () => {
        await setRow({ allowThisMac: false }, /not serving until a setting is fixed: allowCIDRs has "127\.0\.0\.0\/8", which is this Mac itself/);
        const closed = await get(`${edge}/`).then((r) => r.status, (e) => e.code);
        check('allowCIDRs 127.0.0.0/8 without allowThisMac: the port is closed and the log says why', closed === 'ECONNREFUSED', String(closed));
        await setRow({ allowThisMac: false, allowCIDRs: '100.64.0.0/10' }, /this machine's own programs refused/);
        const mark = logText().length;
        const page = await get(`${edge}/`, { accept: 'text/html' });
        check('a browser on this Mac gets 403 and "This is the Mac DSH runs on", not DSH\'s window', page.status === 403 && /This is the Mac DSH runs on/.test(page.text) && /set allowThisMac to true/.test(page.text) && !page.text.includes('__DSH_BOOT__'), `${page.status} ${page.text.slice(0, 160)}`);
        const api = await run.api('session/list', { request: {} }, { base: `${edge}/` });
        check('a program on this Mac cannot use DSH\'s API through the edge (403, the edge\'s words)', api?.ok === false && /http\/403/.test(api.error?.code ?? '') && /this is the Mac DSH runs on/.test(api.error?.message ?? ''), JSON.stringify(api).slice(0, 200));
        const h = await get(`${edge}/.dsh-site/health`).then((r) => r.status, (e) => e.code);
        check('health is turned away too', h === 403, String(h));
        const mux = await openMux(edge);
        check('the events socket does not open', !mux.ok, JSON.stringify(mux.frame ?? mux.why));
        const log = logText().slice(mark);
        check('logged once a minute, in words; nothing passed on', /refused 127\.0\.0\.1 GET \/: this machine's own address \(allowThisMac is false\); the edge serves other devices/.test(log) && !/websocket 127\.0\.0\.1 \/api\/remote\.mux opened/.test(log), log.trim().split('\n').slice(-6).join('\n'));
        const out = spawnSync('bash', [join(repoRoot, 'verify.sh'), '127.0.0.1', '', String(edgePort)], { encoding: 'utf8', timeout: 90000 });
        const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
        check('verify.sh run on the Mac says the Mac is turned away, and passes', out.status === 0 && /PASS  this Mac turned away \(allowThisMac is false\)/.test(text), text.trim().split('\n').join(' | '));
        await pagePicture(`${edge}/`, 'page-this-mac');
        await setRow({}, /listening on 127\.0\.0\.1:\d+ for 127\.0\.0\.0\/8;.*let in \(allowThisMac\)/);
        check('allowThisMac true: DSH\'s window again', (await get(`${edge}/`, { accept: 'text/html' })).status === 200);
    });

    await step('off cuts the open socket and closes the port; on again serves again', async () => {
        const mux = await openMux(edge, true);
        check('a socket is open through the edge', mux.ok);
        let closedAt = 0;
        mux.socket.addEventListener('close', () => { closedAt = Date.now(); });
        const offAt = Date.now();
        await setRow({ enabled: false }, /off \(enabled is false\): the port stays closed/);
        await waitFor(() => closedAt > 0, 'the open socket to close', 10000).catch(() => {});
        check('the open socket was closed when the plugin went off', closedAt > 0 && closedAt - offAt < 10000, `closed ${closedAt ? closedAt - offAt : 'never'} ms after`);
        const refused = await get(`${edge}/`).then((r) => r.status, (e) => e.code);
        check('the port is closed', refused === 'ECONNREFUSED', String(refused));
        check('the log says it stopped and how many connections it closed', /stopped; closed the port and \d+ connections?/.test(logText()));
        const listeningBefore = count('listening on 127');
        await setRow({}, /listening on 127\.0\.0\.1:/);
        const back = await get(`${edge}/`, { accept: 'text/html' });
        check('on again: DSH\'s window through the edge', back.status === 200 && back.text.includes('__DSH_BOOT__'), String(back.status));
        check('on again: one new listening line, nothing repeated', count('listening on 127') === listeningBefore + 1);
    });

    await step('a wrong setting keeps the port closed and says why; fixed, it serves', async () => {
        await setRow({ listenPort: 'abc' }, /not serving until a setting is fixed: listenPort must be a whole number from 1 to 65535, such as 8443 \(it is "abc"\)/);
        const refused = await get(`${edge}/`).then((r) => r.status, (e) => e.code);
        check('the port is closed while listenPort is wrong', refused === 'ECONNREFUSED', String(refused));
        check('DSH itself keeps running', (await httpGet(`http://127.0.0.1:${dshPort}/`)).status === 401);
        await setRow({ listenPort: String(edgePort) }, /listening on 127\.0\.0\.1:/);
        const back = await get(`${edge}/`, { accept: 'text/html' });
        check('a port in quotes is taken as meant: serving again', back.status === 200, String(back.status));
    });

    await step('a misspelt key keeps the port closed and names the key meant', async () => {
        await setRow({ enable: false }, /not serving until a setting is fixed: "enable" is not a dsh-site setting: did you mean "?enabled"?\?/);
        const refused = await get(`${edge}/`).then((r) => r.status, (e) => e.code);
        check('enable: false (meant enabled): the port is closed, not left serving', refused === 'ECONNREFUSED', String(refused));
        await setRow({}, /listening on 127\.0\.0\.1:/);
        check('the key fixed: serving again', (await get(`${edge}/`, { accept: 'text/html' })).status === 200);
    });

    await step('a row with no settings does not serve, and its log says what to add', async () => {
        const start = existsSync(defaultLog) ? readFileSync(defaultLog, 'utf8').length : 0;
        const mark = logText().length;
        run.rows = '';
        run.writeProfile(model.port);
        await waitFor(() => /stopped; closed the port/.test(logText().slice(mark)), 'the edge to stop', 30000);
        const said = await waitFor(() => {
            const text = existsSync(defaultLog) ? readFileSync(defaultLog, 'utf8').slice(start) : '';
            return /has no settings in this profile/.test(text) ? text : undefined;
        }, 'the no-settings line in the default log', 30000).catch(() => '');
        const refused = await get(`${edge}/`).then((r) => r.status, (e) => e.code);
        check('no row: the port is closed', refused === 'ECONNREFUSED', String(refused));
        check('its log (the default file, dsh-site/site.log inside DSH\'s own home) says it has no settings and what to add', /dsh-site has no settings in this profile \(its row has no config\), so it does not serve/.test(said) && /give its row at least listenHost/.test(said), said.slice(0, 400));
        check('nothing was written under the HOME folder\'s ~/.dsh (the default log follows DSH\'s home, not HOME)', !existsSync(homeLog), homeLog);
        check('it did not fall back to listening anywhere (no default port, no every-interface listener)', !/listening on|already in use/.test(said), said.slice(0, 400));
        await setRow({}, /listening on 127\.0\.0\.1:/);
        check('the row back: serving again', (await get(`${edge}/`, { accept: 'text/html' })).status === 200);
    });

    await step('switched off on DSH\'s Plugins page (taken out of the profile\'s bundles): the port closes, DSH keeps running', async () => {
        const mux = await openMux(edge, true);
        check('a socket is open through the edge', mux.ok);
        let closedAt = 0;
        mux.socket.addEventListener('close', () => { closedAt = Date.now(); });
        run.unbundled = ['dsh-plugin-dsh-site'];
        run.writeProfile(model.port);
        const live = await waitFor(async () => ((await get(`${edge}/`).then(() => false, (e) => e.code === 'ECONNREFUSED')) ? true : undefined), 'the port to close while DSH runs', 20000).catch(() => false);
        if (!live) {
            console.log('# DSH did not apply the bundles change while running; restarting it');
            await run.stop();
            await run.boot('with the plugin out of bundles');
        }
        const refused = await get(`${edge}/`).then((r) => r.status, (e) => e.code);
        check(`out of bundles: the port is closed (${live ? 'DSH applied it while running' : 'after a DSH restart'})`, refused === 'ECONNREFUSED', String(refused));
        check('the open socket was cut', closedAt > 0);
        check('DSH itself keeps running', (await httpGet(`http://127.0.0.1:${run.port}/`)).status === 401);
        const before = count('listening on 127');
        run.unbundled = [];
        run.writeProfile(model.port);
        const back = await waitFor(() => (count('listening on 127') > before ? true : undefined), 'the edge back in bundles', 20000).catch(() => false);
        if (!back) {
            await run.stop();
            await run.boot('with the plugin back in bundles');
            await waitFor(() => count('listening on 127') > before, 'the edge after the restart', 30000);
        }
        const res = await get(`${edge}/`, { accept: 'text/html' });
        check('back in bundles: DSH\'s window through the edge again', res.status === 200 && res.text.includes('__DSH_BOOT__'), String(res.status));
    });

    await step('a cookie jar the edge cannot read: the page says why and how to fix it', async () => {
        await setRow({ cookieJar: join(run.root, 'no-such-jar') }, /listening on 127\.0\.0\.1:/);
        const res = await get(`${edge}/`, { accept: 'text/html' });
        check('503 and the page names the problem and both ways out', res.status === 503 && /The edge cannot sign this device in/.test(res.text) && /does not exist/.test(res.text) && /set injectAuthCookie to false/.test(res.text) && res.headers['retry-after'] === '30', `${res.status} ${res.text.slice(0, 120)}`);
        check('no path in the page', !res.text.includes(run.root), 'the page names the setting, not the file');
        check('the log says it in words', /cannot read the sign-in cookie: the cookie jar file \(cookieJar\) does not exist/.test(logText()));
        await pagePicture(`${edge}/`, 'page-cookie-problem');
        await setRow({}, /listening on 127\.0\.0\.1:/);
    });

    await step('a DSH restart and a crash bring the edge back once, repeating nothing', async () => {
        const before = count('listening on 127');
        await run.stop();
        check('DSH stopped: the edge stopped with it', await get(`${edge}/`).then(() => false, (e) => e.code === 'ECONNREFUSED'));
        await run.boot('restart');
        await waitFor(() => count('listening on 127') === before + 1, 'the edge after the restart', 30000);
        const res = await get(`${edge}/`, { accept: 'text/html' });
        check('after a restart: DSH\'s window through the edge, with the jar\'s cookie', res.status === 200 && res.text.includes('__DSH_BOOT__'), String(res.status));
        await run.crash();
        await run.boot('after a crash');
        await waitFor(() => count('listening on 127') === before + 2, 'the edge after the crash', 30000);
        const res2 = await get(`${edge}/`, { accept: 'text/html' });
        check('after a crash: the same', res2.status === 200 && res2.text.includes('__DSH_BOOT__'), String(res2.status));
        check('one listening line per start, no more', count('listening on 127') === before + 2, String(count('listening on 127')));
        const listed = await listSessions(via);
        check('the session made through the edge is still there', Boolean(sessionId) && JSON.stringify(listed).includes(sessionId), JSON.stringify(listed).slice(0, 200));
        const h = await health();
        check('after a crash, DSH\'s own window server is named again (not a guess from its ports)', h.foundBy === 'dsh' && h.target === `http://127.0.0.1:${dshPort}`, JSON.stringify(h));
        check('no "not found" line at any start: the edge waits for DSH quietly', !/not found yet/.test(logText()), logText().split('\n').filter((l) => /not found/.test(l)).join('\n'));
    });

    await step('injectAuthCookie off: a browser that is not signed in gets a page that says how; DSH\'s own link signs it in through the edge', async () => {
        await setRow({ injectAuthCookie: false, allowHosts: siteName }, /devices sign in with DSH's own link/);
        const res = await get(`${edge}/`);
        check('a program with no cookie gets DSH\'s own 401, passed on', res.status === 401 && /dsh web authentication required/.test(res.text), `${res.status} ${res.text.slice(0, 80)}`);
        const page = await get(`${edge}/`, { accept: 'text/html' });
        check('a browser with no cookie gets the sign-in page (401), which says where the link comes from', page.status === 401 && /Sign in to DSH on this device/.test(page.text) && /dsh web printed/.test(page.text) && /desktop app does not show its sign-in link/.test(page.text), `${page.status} ${page.text.slice(0, 160)}`);
        await pagePicture(`${named}/`, 'page-sign-in');
        shellToken = new URL(run.signInLink()).search;
        const signIn = await get(`${edge}/${shellToken}`);
        shellCookie = String(signIn.headers['set-cookie']?.[0] ?? '').split(';')[0];
        check('the sign-in link through the edge gives the device its cookie, named for the edge\'s fixed loopback address', signIn.status === 303 && shellCookie.startsWith(`${cookieNameFor(`127.0.0.1:${edgePort}`)}=`), `${signIn.status} ${shellCookie.slice(0, 24)}`);
        const after = await get(`${edge}/`, { cookie: shellCookie, accept: 'text/html' });
        check('with that cookie, the window', after.status === 200 && after.text.includes('__DSH_BOOT__'), String(after.status));
        const bare = await health();
        check('health tells a device that is not signed in only that the edge serves, and its version', JSON.stringify(Object.keys(bare).sort()) === JSON.stringify(['ok', 'plugin', 'signedIn', 'version']) && bare.ok === true && bare.signedIn === false, JSON.stringify(bare));
        const h = await health({ cookie: shellCookie });
        check('health tells a signed-in device the rest: devices sign in with DSH\'s own link', h.auth === 'shell' && h.cookie === 'off' && h.authInjected === false && h.target === `http://127.0.0.1:${run.port}`, JSON.stringify(h));
    });

    await step('a real browser: another website cannot frame DSH, embed it, post to it or open its socket (signed in with DSH\'s own link)', async () => {
        if (!pageShots) {
            check('a real browser for this check', false, 'no Playwright: install the e2e tools');
            return;
        }
        shellContext = await pageShots.browser.newContext({ viewport: { width: 760, height: 700 } });
        const page = await shellContext.newPage();
        const res = await page.goto(`${named}/${new URL(run.signInLink()).search}`, { waitUntil: 'load' });
        check('shell mode: DSH\'s sign-in link by a made-up name, in a real browser: signed in, the window', res?.status() === 200 && (await page.content()).includes('__DSH_BOOT__'), `${res?.status()} ${page.url()}`);
        await page.close();
        attackChecks(await attackFrom(shellContext, 'shell-mode'), 'shell mode');
    });

    await step('a device signed in with DSH\'s own link stays signed in when DSH restarts on a new port', async () => {
        const before = count('listening on 127');
        const oldPort = run.port;
        await run.stop();
        run.port = await freePort();
        await run.boot('restart on a new port');
        await waitFor(() => count('listening on 127') === before + 1, 'the edge after the restart', 30000);
        const h = await waitFor(async () => { const x = await health({ cookie: shellCookie }); return x.target === `http://127.0.0.1:${run.port}` ? x : undefined; }, 'the edge to follow DSH to its new port', 20000);
        check(`DSH came back on a new port (${oldPort} to ${run.port}) and the edge follows it`, run.port !== oldPort && h.foundBy === 'dsh', JSON.stringify(h));
        const res = await get(`${edge}/`, { cookie: shellCookie, accept: 'text/html' });
        check('the device\'s cookie from before the restart still opens the window', res.status === 200 && res.text.includes('__DSH_BOOT__'), String(res.status));
        if (shellContext) {
            const page = await shellContext.newPage();
            const again = await page.goto(`${named}/`, { waitUntil: 'load' });
            check('the real browser signed in before the restart gets the window, with no new link', again?.status() === 200 && (await page.content()).includes('__DSH_BOOT__'), String(again?.status()));
            await shot(page, shots, 'window-after-restart-signed-in-light-760');
            await page.close();
        }
        const old = await get(`${edge}/${shellToken}`, { accept: 'text/html' });
        check('the old sign-in link gets the sign-in page, which says the link is from an earlier start', old.status === 401 && /from an earlier start of DSH/.test(old.text), `${old.status} ${old.text.slice(0, 160)}`);
        check('DSH made a new sign-in link at this start', Boolean(shellToken) && new URL(run.signInLink()).search !== shellToken);
    });

    await step('no sign-in token reaches the edge\'s log, also from refused sign-in links', async () => {
        const link = new URL(run.signInLink()).search;
        const byName = await get(`${edge}/${link}`, { host: `unlisted.example:${edgePort}`, accept: 'text/html' });
        const crossSite = await get(`${edge}/${link}`, { host: `127.0.0.2:${edgePort}`, 'sec-fetch-site': 'cross-site' });
        check('a sign-in link by an unlisted name, and one sent cross-site, are refused', byName.status === 421 && crossSite.status === 403, `${byName.status} ${crossSite.status}`);
        const tokens = [...run.logText().matchAll(/[?&]token=([^&\s]+)/g)].map((m) => m[1]);
        const log = logText();
        check(`none of DSH's ${tokens.length} sign-in tokens of this run is in the edge's log`, tokens.length >= 2 && tokens.every((x) => !log.includes(x)), `${tokens.filter((x) => log.includes(x)).length} found`);
        check('the refused links are logged by their path only', /refused 127\.0\.0\.1 GET \/\?…: Host unlisted\.example:\d+ is not an IP address and not in allowHosts/.test(log) && /refused 127\.0\.0\.1 GET \/\?…: cross-site request/.test(log), log.split('\n').filter((l) => /\?…/.test(l)).slice(-4).join('\n'));
        check('no cookie value in the edge\'s log', [web.cookie, shellCookie].every((c) => !c || !log.includes(c.split('=').slice(1).join('='))));
    });

    if (shellContext) await shellContext.close().catch(() => {});
    if (pageShots) await pageShots.browser.close();
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
    console.log(run.logText().split('\n').slice(-30).join('\n'));
} finally {
    await run.stop().catch(() => {});
    await model.close().catch(() => {});
    await sites.close().catch(() => {});
    if (t.failed) {
        console.log('# dsh-site log:');
        console.log(logText().split('\n').slice(-40).map((l) => `#   ${l}`).join('\n'));
    }
    run.cleanup();
    console.log(`# pictures: ${pw ? shots : 'none (no Playwright)'}`);
    console.log(`# ${t.passed} passed, ${t.failed} failed`);
    process.exit(t.failed ? 1 : 0);
}
