#!/usr/bin/env node
/**
 * Real-host browser test for the calendar plugin's window (lib/client.js).
 *
 * Boots a real DSH (the shipped web profile, in a temporary DSH_HOME) with
 * this repo's calendar and session-bridge plugins and a scripted model
 * (fake-model.mjs), checks that DSH serves the calendar's browser half and
 * that it parses, then drives the window with Playwright's Chromium:
 *
 * - the Calendar page from its entry in DSH's sidebar, in Week view; its
 *   quiet notice that a settings file it couldn't read was set aside;
 * - at 1280 px, the side column folded behind its button, which shows it
 *   beside the view (the focus going into it, and back on folding it);
 *   and, as the profile has askBeforeEmails off, its note that chats can
 *   email guests without asking (with nothing to change it);
 * - a timed event, an all-day event and a weekly repeating event made
 *   through the event dialog (each checked through the plugin's endpoints);
 *   a toast shown while the event dialog is open, clear of its buttons; an
 *   event's details, which take the focus and close on Escape;
 * - one occurrence of the repeating event changed (scope 'one') and another
 *   deleted (scope 'one'), the rest of the series as it was;
 * - Month, Day and Agenda views, the choice kept by the plugin, N and T;
 *   a narrow month's timed events without their times in front; where Week
 *   and Day open their hours, again after Next, Previous and Week to Day;
 * - a calendar hidden and shown again from the side column;
 * - a change the host says would email six guests ('calendar/needs-notify',
 *   played here, as the calendars kept in DSH email no one): the question
 *   names all six on screen, with what they get and why; nothing sent on
 *   Don't save; notify only after Save and email, with approved: the six,
 *   and the same change otherwise (the host holds a yes to it); who was
 *   emailed in the toast;
 * - a delete the host says would email twelve: the list in the question
 *   takes the focus with Shift+Tab from No, End and Home show its ends, and
 *   Escape is Don't delete;
 * - an event moved to another calendar with other changes: the move on its
 *   own first, the rest on the moved event; no email offered for a guest on
 *   a calendar that can't send it;
 * - no default calendar (the host's own state: every calendar hidden, none
 *   chosen): the event dialog shows none chosen and asks for one;
 * - dragging: an event in Week to another time and day (Escape first,
 *   leaving it), by its bottom edge to another end, and on with Alt and an
 *   arrow key; in Month to another day at the same time; a repeating one,
 *   asked which occurrences move; Alt and an arrow key twice on a meeting:
 *   shown where it goes, then one question naming it and one save (Escape
 *   dropping a move, Enter saving it at once);
 * - search: / to the field, the events found by day, one opened with its
 *   way to the calendar, Escape to clear it;
 * - Accounts: the account list and every Add account choice up to its form,
 *   and a new calendar kept in DSH;
 * - Microsoft, against stand-ins on this computer for its sign-in page and
 *   Graph (standins/microsoft.mjs; the plugin's microsoftLoginBase and
 *   microsoftGraphBase): the app registration's steps, its sign-in page in a
 *   new tab, the wait with the page to open again, and the sign-in finished
 *   by the address the page ended on, pasted (as when DSH runs on another
 *   computer);
 * - Google, against its stand-in (standins/google.mjs): its sign-in page in
 *   a new tab, the wait with the address to paste, then the browser back to
 *   DSH on this computer, which the dialog notices by itself;
 * - the title never cut, at 1280 px (side column folded and shown) and 420
 *   px, in every view, with week numbers on and the sync button there;
 * - a Google meeting made, changed and deleted without emailing its guest:
 *   the dialog says it still reaches their calendars, each is made only
 *   once the user has seen whose calendar it reaches (the host refuses it
 *   until then: 'calendar/needs-approval'), and each toast says whose
 *   calendars it was put on, changed on or taken off (Google told
 *   sendUpdates=none); and a meeting there an agent deletes without asking
 *   (askBeforeEmails off); someone else's invitation there, whose
 *   organizer's fields the dialog keeps as they are, and Show me as saved;
 *   one whose guests may change it, where Show me as asks first, naming its
 *   organizer and the other guest; a move that made its copy but couldn't
 *   take the meeting out of Google ('calendar/half-moved'): a notice that
 *   stays until closed, and the move not made again;
 * - a series with an occurrence changed on its own moved to Microsoft: the
 *   host refuses ('calendar/drops-changes'), Don't move it keeps it, Move
 *   anyway moves it without that occurrence;
 * - a Microsoft meeting changed while the question before its email waits:
 *   a guest added on Microsoft's side meanwhile, which DSH doesn't read, its
 *   yes makes nothing (Graph refuses the change sent with the meeting's old
 *   etag: 412; 'calendar/changed') and the question comes again naming
 *   both, the new one marked; Don't save says so at the top of the dialog,
 *   in view and with the focus, with Look at it again; saved again, it goes
 *   to both; changed there so that it reaches nobody new, its yes makes
 *   nothing and Look at it again shows it as it is now;
 * - a save Microsoft answers with 500, said at the top of the dialog, in
 *   view and with the focus, at 1280 px and at 420 px; an edited event
 *   asks before Escape, Cancel or the close button drops it (Keep editing,
 *   or Discard), an unchanged one closes at once;
 * - a change whose every yes comes back naming someone new (played): four
 *   questions, then it stops, saying it keeps changing, with Look at it
 *   again;
 * - the Microsoft account removed, with the page to withdraw DSH's access
 *   there; "Sign in with a code instead", showing the code; the Google
 *   account removed, its access withdrawn at Google;
 * - chat cards for an agent's calendar_events, calendar_create_event, a
 *   delete that reached a guest's calendar (calendar_delete_event) and a
 *   move (calendar_update_event), and the button that opens an event on the
 *   page; a read and an answer that didn't work, each in the plugin's own
 *   row saying what wasn't done and why; an agent's change to a Microsoft
 *   meeting that didn't say to tell its guests, refused, in the window's
 *   words (whom it would email, why, and what to do); the cards' faint fill
 *   and no blur, light and dark;
 * - the Agenda pane in DSH's right sidebar: an event's details beside it,
 *   the chat staying, and Open in Calendar to the event on the page; at the
 *   sidebar's narrowest (300 px) nothing cut or scrolled sideways; no fill
 *   or blur of its own, light and dark;
 * - light and dark, with and without a stand-in wallpaper: the side column
 *   at the wallpaper's tint, the view at tint + .2, both blurred by its
 *   blur, and the same fallbacks without them;
 * - a narrow window (420 px): the side column folds, Week shows 3 days,
 *   search fits; the event dialog's dates and times in full;
 * - the settings menu's Show weekends and Show week numbers, each checked
 *   as it is: Week from Monday to Friday with its ISO week number by the
 *   title, Month in five columns with each week's number, the small month's
 *   numbers; at 420 px three weekdays, the number under the title; both
 *   kept after a reload, then turned off again from the menu.
 *
 *   DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js \
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   node plugins/calendar/test/e2e/ui.mjs
 *
 * DSH_BIN: a DSH bin.js (else `dsh` from PATH; skipped without either).
 * PLAYWRIGHT_MODULE: Playwright's module (else the playwright or
 * playwright-core package; skipped without). CHROMIUM: a Chromium to launch
 * (else Playwright's own). SHOTS: a folder outside this repository for
 * screenshots (week and month, light and dark, with and without a stand-in
 * wallpaper; the event dialog, with no calendar chosen too, the question
 * before an email, the one before a move that drops part of a series, a
 * change stopped because the event changed, a save refused at the top of
 * the dialog (changed, nobody new, failed, narrow, stopped), the question
 * before changes are discarded, the long list at its end, Accounts,
 * Microsoft's and Google's sign-ins, a removal's notice, the Agenda pane
 * (at its narrowest too) and an event's details beside it, chat cards (a
 * refused one, one in dark), the side column folded, a drag, search
 * results, a narrow window; Week and Month with weekends hidden and week
 * numbers, light, dark and narrow, and the settings menu; a toast over the
 * event dialog, Day opened at an early event (narrow too), a move by the
 * keys and its question, the title in Day and Agenda, and the narrow event
 * dialog; and the window whenever a step fails). KEEP=1 keeps the temporary
 * folder.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { start as startGoogle } from '../standins/google.mjs';
import { start as startGraph } from '../standins/microsoft.mjs';
import { startFakeModel } from './fake-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = resolve(here, '../../..');
const repoDir = resolve(pluginsDir, '..');
const ZONE = 'America/Los_Angeles';

function findDsh() {
    const bin = process.env.DSH_BIN;
    if (bin) return bin.endsWith('.js') ? [process.execPath, bin] : [bin];
    try {
        const found = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
        if (found) return [found];
    } catch {}
    return null;
}

async function findPlaywright() {
    const tries = process.env.PLAYWRIGHT_MODULE ? [process.env.PLAYWRIGHT_MODULE] : ['playwright', 'playwright-core'];
    for (const name of tries) {
        try {
            const spec = name.startsWith('/') || name.startsWith('.') ? pathToFileURL(resolve(name)).href : name;
            const mod = await import(spec);
            const pw = mod.chromium ? mod : mod.default;
            if (pw?.chromium) return pw;
        } catch {}
    }
    return null;
}

/** A Chromium Playwright can launch: CHROMIUM, else its own, else one under PLAYWRIGHT_BROWSERS_PATH. */
async function launch(pw) {
    const args = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-gpu-rasterization'];
    if (process.env.CHROMIUM) return pw.chromium.launch({ executablePath: process.env.CHROMIUM, args });
    try {
        return await pw.chromium.launch({ args });
    } catch (error) {
        const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
        const found = base && existsSync(base) ? readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()
            .map((n) => join(base, n, 'chrome-linux', 'chrome')).find((p) => existsSync(p)) : undefined;
        if (!found) throw error;
        return pw.chromium.launch({ executablePath: found, args });
    }
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) {
        passed += 1;
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.log(`not ok - ${name}${detail ? `\n    ${String(detail).slice(0, 1500)}` : ''}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 30000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

/** Run a step; a failure is a failed check, and the test goes on. */
let failedShots = 0;
async function step(name, run) {
    try {
        await run();
    } catch (error) {
        check(name, false, error?.stack ?? error);
        // What the window showed when the step failed.
        if (shots && page) await page.screenshot({ path: join(shots, `failed-${++failedShots}.png`) }).catch(() => {});
        // A dialog left open would cover the page for the steps after this one (an edited event's asks first: Discard).
        for (let i = 0; page && i < 4 && (await page.locator('[role="dialog"]').count().catch(() => 0)) > 0; i++) {
            const discard = page.locator('[data-calendar-discard]');
            if (await discard.count().catch(() => 0)) await discard.click().catch(() => {});
            else await page.keyboard.press('Escape').catch(() => {});
            await sleep(400);
        }
    }
}

// Days in the plugin's zone.
const dayIn = (ms, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (day, n) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const compact = (day, time) => `${day.replaceAll('-', '')}T${time.replace(':', '')}00`;

const root = mkdtempSync(join(tmpdir(), 'dsh-calendar-ui-'));
const home = join(root, 'home');
const ws = join(root, 'ws');
// A Unix socket's path must be short (about 100 bytes): under a long temporary folder, the socket gets a short folder of its own.
const sockDir = Buffer.byteLength(join(root, 'bridge.sock')) <= 100 ? root : mkdtempSync('/tmp/dcal-');
const sock = join(sockDir, 'bridge.sock');
const dshLog = join(root, 'dsh.log');
const calendarLog = join(home, 'calendar', 'calendar.log');
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : '';
if (shots && (shots === repoDir || shots.startsWith(`${repoDir}${sep}`))) {
    console.log('SHOTS must be a folder outside the repository: screenshots never go into it.');
    process.exit(1);
}

function bridge(method, path, body) {
    return new Promise((resolvePromise, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = request({
            socketPath: sock, path, method,
            headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error(`${method} ${path}: ${res.statusCode} ${text.slice(0, 300)}`));
                else resolvePromise(text ? JSON.parse(text) : null);
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function httpGet(url, headers = {}) {
    return new Promise((resolvePromise, reject) => {
        const req = request(url, { headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** The application (client) id the Microsoft stand-in knows. */
const MS_CLIENT = '0e2e0000-0000-4000-8000-00000000c1d5';
/** The Google scopes the plugin asks for, and the broad one Google's stand-in checks for. */
const GOOGLE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const GOOGLE_BROAD = 'https://www.googleapis.com/auth/calendar';

/**
 * Stand-ins on 127.0.0.1: Google's sign-in and Calendar API
 * (standins/google.mjs), Microsoft Graph and its sign-in service
 * (standins/microsoft.mjs), and in front of them what those don't have:
 * Microsoft's sign-in page and its code trade, and Google's revoke
 * endpoint. Microsoft's sign-in page doesn't send the browser back: it shows
 * the address it would go to, as the browser does when DSH runs on another
 * computer. Its code is traded once, with PKCE, for a token Graph's
 * stand-in takes; a sign-in with a code stays pending. Graph has one
 * calendar, its default, and no events; Google, the user's own calendar.
 */
async function startProviders() {
    const graph = await startGraph();
    graph.store.clientId = MS_CLIENT;
    graph.store.devicePlan = ['authorization_pending'];
    graph.store.deviceInterval = 5;
    graph.store.addCalendar({ id: 'e2e-ms-cal', name: 'Calendar', hexColor: '#2f6fd6', isDefaultCalendar: true });
    const google = await startGoogle({ user: { email: 'sam@example.com', name: 'Sam Example' } });
    // The stand-in knows only Google's broad calendar scope: a token with both narrow ones passes as if it had it.
    google.store.accessTokens = new (class extends Map {
        set(token, record) {
            const scopes = String(record?.scope ?? '').split(' ');
            return super.set(token, scopes.includes(GOOGLE_EVENTS) && scopes.includes(GOOGLE_LIST) ? { ...record, scope: `${record.scope} ${GOOGLE_BROAD}` } : record);
        }
    })();
    const seen = { authorize: [], grants: [], devicecodes: 0, revoked: 0 };
    const codes = new Map();
    let origin = '';
    const server = createServer((req, res) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const url = new URL(req.url ?? '/', origin);
            const form = new URLSearchParams(raw);
            const json = (status, body) => {
                res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(body));
            };
            const login = '/login/common/oauth2/v2.0';
            if (req.method === 'GET' && url.pathname === `${login}/authorize`) {
                const asked = Object.fromEntries(url.searchParams);
                seen.authorize.push(asked);
                const code = `e2e-code-${seen.authorize.length}`;
                codes.set(code, { challenge: asked.code_challenge, redirect: asked.redirect_uri });
                const back = new URL(asked.redirect_uri);
                back.searchParams.set('code', code);
                back.searchParams.set('state', asked.state ?? '');
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(`<!doctype html><meta charset="utf-8"><title>Sign in</title><p>Signed in. The browser goes back to:</p><p id="back">${back.href.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</p>`);
                return;
            }
            if (req.method === 'POST' && url.pathname === `${login}/token` && form.get('grant_type') === 'authorization_code') {
                seen.grants.push('authorization_code');
                const known = codes.get(form.get('code') ?? '');
                codes.delete(form.get('code') ?? '');
                const verifier = createHash('sha256').update(form.get('code_verifier') ?? '', 'ascii').digest('base64url');
                if (!known || verifier !== known.challenge || form.get('redirect_uri') !== known.redirect || form.get('client_id') !== MS_CLIENT) {
                    return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: The code is not valid.' });
                }
                return json(200, graph.store.tokens(true));
            }
            if (req.method === 'POST' && url.pathname === '/google/revoke') {
                seen.revoked += 1;
                return json(200, {});
            }
            if (url.pathname.startsWith('/login/')) {
                // The rest of the sign-in service (a code to enter, refreshes): Graph's stand-in.
                if (url.pathname === `${login}/devicecode`) seen.devicecodes += 1;
                else seen.grants.push(form.get('grant_type'));
                const ahead = request(`${graph.origin}${req.url}`, {
                    method: req.method,
                    headers: { 'content-type': req.headers['content-type'] ?? 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(raw) },
                }, (answer) => {
                    res.writeHead(answer.statusCode ?? 502, { 'content-type': answer.headers['content-type'] ?? 'application/json' });
                    answer.pipe(res);
                });
                ahead.on('error', () => json(502, { error: 'temporarily_unavailable' }));
                ahead.end(raw);
                return;
            }
            return json(404, { error: 'not_found' });
        });
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        seen, graph, google, loginBase: `${origin}/login`, revokeUrl: `${origin}/google/revoke`,
        close: async () => {
            await new Promise((done) => {
                server.closeAllConnections?.();
                server.close(() => done());
            });
            await graph.close();
            await google.close();
        },
    };
}

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const signInLink = () => [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1] ?? '';

async function signInWeb() {
    const signIn = signInLink();
    const cookie = String((await httpGet(signIn)).headers['set-cookie']?.[0] ?? '').split(';')[0];
    return { base: new URL('./', signIn), cookie };
}

/** Call a Remote endpoint the way the window does. */
function webApi(web, endpoint, args) {
    return new Promise((resolvePromise, reject) => {
        const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } });
        const req = request(new URL(`api/${endpoint}`, web.base), {
            method: 'POST',
            headers: { cookie: web.cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let result;
                try { result = JSON.parse(text).result; } catch {}
                resolvePromise(result ?? { ok: false, error: { code: `http/${res.statusCode}`, message: text.slice(0, 300) } });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

const profile = join(home, 'profiles', 'web');

function writeProfile(modelPort, providers) {
    rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    const plugins = { 'dsh-plugin-calendar': join(pluginsDir, 'calendar'), 'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge') };
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: Object.fromEntries(Object.entries(plugins).map(([name, dir]) => [name, `link:${dir}`])),
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(plugins)] } },
    }, null, 2)}\n`);
    for (const [name, dir] of Object.entries(plugins)) symlinkSync(dir, join(profile, 'node_modules', name), 'dir');
    const q = JSON.stringify;
    writeFileSync(join(profile, 'cordis.patch.yml'), `- id: agent-default-model
  config:
    provider: fake
    model: fake-model
- id: llm-pi-ai
  config:
    providers:
      fake:
        displayName: Fake
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        apiKeyEnv: FAKE_LLM_KEY
        models:
          - id: fake-model
            name: Fake Model
            contextWindow: 131072
            reasoningEfforts: false
- id: session-bridge
  config:
    socketPath: ${q(sock)}
    logFile: ${q(join(root, 'bridge.log'))}
- id: calendar
  config:
    timeZone: ${q(ZONE)}
    askBeforeEmails: false
    microsoftLoginBase: ${q(providers.loginBase)}
    microsoftGraphBase: ${q(providers.graph.graphBase)}
    googleApiBase: ${q(providers.google.apiBase)}
    googleAuthorizeUrl: ${q(providers.google.authorizeUrl)}
    googleTokenUrl: ${q(providers.google.tokenUrl)}
    googleUserinfoUrl: ${q(providers.google.userinfoUrl)}
    googleRevokeUrl: ${q(providers.revokeUrl)}
`);
}

function startDsh(dsh) {
    const out = openSync(dshLog, 'a');
    const local = '127.0.0.1,localhost';
    const child = spawn(dsh[0], [...dsh.slice(1), '--profile', 'web', '--no-open', '--port', '0'], {
        cwd: ws,
        env: {
            ...process.env, DSH_HOME: home, FAKE_LLM_KEY: 'sk-fake', DSH_TELEMETRY_DISABLED: '1', NO_PROXY: local, no_proxy: local,
            DSH_PERMISSION_MODE: 'danger-full-access',
        },
        stdio: ['ignore', out, out],
    });
    closeSync(out);
    return child;
}

async function stopDsh(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    await exited;
    clearTimeout(timer);
}

const dsh = findDsh();
if (!dsh) {
    console.log('skipped: set DSH_BIN to a DSH bin.js (or put dsh on PATH) to run the browser test');
    process.exit(0);
}
const pw = await findPlaywright();
if (!pw) {
    console.log('skipped: set PLAYWRIGHT_MODULE to Playwright\'s module (or install playwright) to run the browser test');
    process.exit(0);
}

mkdirSync(ws, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });
const model = await startFakeModel();
const providers = await startProviders();
let child;
let browser;
let page;
const pageErrors = [];

/** Prompt a new session as the user, to have an agent call a tool: {sessionId}. */
async function agentCall(tool, args, words) {
    const { sessionId } = await bridge('POST', '/sessions', { workspacePath: ws, text: `${words}\nE2E:call ${tool} ${JSON.stringify(args)}` });
    await waitFor(async () => {
        const s = await bridge('GET', `/sessions/${sessionId}`);
        return s.turns?.started > 0 && s.turns.started === s.turns.ended && s.status !== 'running';
    }, `the ${tool} turn`, 60000);
    return { sessionId };
}

/** DSH's first-run notices, out of the way: whether there was one. */
async function dismissNotices(page) {
    let found = false;
    for (const label of ['Continue', 'Got it', 'OK']) {
        const button = page.getByRole('button', { name: label, exact: true });
        if (await button.count()) {
            found = true;
            await button.first().click().catch(() => {});
            await page.waitForTimeout(300);
        }
    }
    return found;
}

/**
 * DSH's window up (its Calendar entry showing), and its first-run notices out
 * of the way: they can come seconds late on a busy machine, so they're looked
 * for until none has come for a few seconds.
 */
async function settleWindow(page) {
    await page.getByRole('button', { name: 'Calendar', exact: true }).first().waitFor({ state: 'visible', timeout: 60000 });
    const end = Date.now() + 30000;
    let calm = Date.now();
    while (Date.now() < end && Date.now() - calm < 4000) {
        if (await dismissNotices(page)) calm = Date.now();
        await page.waitForTimeout(400);
    }
}

/** The stand-in for the wallpaper plugin, on this test page only: its public contract on <body>, a picture behind DSH. */
async function wallpaperOn(page) {
    await page.evaluate(() => {
        const b = document.body;
        b.classList.add('wp-on');
        b.style.setProperty('--wp-blur', '22px');
        b.style.setProperty('--wp-tint', '0.55');
        if (!document.getElementById('test-wall')) {
            const wall = document.createElement('div');
            wall.id = 'test-wall';
            wall.style.cssText = 'position:fixed;inset:0;z-index:0;background:radial-gradient(circle at 20% 25%,#f59e0b 0,transparent 38%),'
                + 'radial-gradient(circle at 75% 30%,#06b6d4 0,transparent 40%),radial-gradient(circle at 55% 85%,#db2777 0,transparent 45%),linear-gradient(135deg,#1e3a8a,#065f46)';
            document.body.prepend(wall);
            const style = document.createElement('style');
            style.id = 'test-wall-style';
            // What the wallpaper plugin does to DSH's frame: transparent, so the picture shows through.
            style.textContent = 'body.wp-on #root{position:relative;z-index:1}'
                + 'body.wp-on [class*="_frame"],body.wp-on [class*="_centerCol"],body.wp-on [class*="_sidebarCol"],body.wp-on [class*="_rightbarCol"],'
                + 'body.wp-on [data-slot="main"],body.wp-on [data-slot="main.conversation"]>div{background:transparent!important;border:0!important;box-shadow:none!important}';
            document.head.append(style);
        }
    });
    await page.waitForTimeout(300);
}

async function wallpaperOff(page) {
    await page.evaluate(() => {
        document.body.classList.remove('wp-on');
        document.getElementById('test-wall')?.remove();
        document.getElementById('test-wall-style')?.remove();
    });
}

async function shot(page, name) {
    if (!shots) return;
    await page.waitForTimeout(250);
    // Dialogs and toasts as they settle: their opening animations done (not a spinner's, which goes on).
    await Promise.race([
        page.evaluate(() => Promise.all(document.getAnimations()
            .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})))),
        page.waitForTimeout(2000),
    ]).catch(() => {});
    await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function setDark(page, dark) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await waitFor(() => page.evaluate((want) => document.body.hasAttribute('data-ds-dark-theme') === want, dark), `DSH's ${dark ? 'dark' : 'light'} theme`, 10000).catch(() => {});
}

try {
    // A settings file the plugin can't read: it sets the file aside, starts without it, and the page says so.
    mkdirSync(join(home, 'calendar'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'calendar', 'calendar.json'), '{"version": 1, "accounts": ', { mode: 0o600 });
    writeProfile(model.port, providers);
    child = startDsh(dsh);
    await waitFor(async () => existsSync(sock) && (await bridge('GET', '/health')).ok, 'the session bridge', 90000);
    await waitFor(() => signInLink(), 'the web sign-in link', 30000);
    await waitFor(() => readText(calendarLog).includes('account added local'), 'the calendar plugin to start', 30000);
    const web = await signInWeb();
    const api = (method, args = {}) => webApi(web, `dsh-plugin-calendar/${method}`, args);
    /**
     * A new event made as the window makes one that emails or reaches people: refused first, naming them all
     * ('calendar/needs-approval'), then the same input again with approved: them (the host holds a yes to that
     * very change, once).
     */
    const createAsked = async (input) => {
        const first = await api('createEvent', { input });
        const people = first.error?.details?.people;
        return first.ok || !Array.isArray(people) ? first : api('createEvent', { input: { ...input, approved: people } });
    };
    const state = await waitFor(async () => { const r = await api('state'); return r.ok ? r.value : null; }, 'the calendar endpoints', 30000);
    const defaultCalendar = state.defaultCalendar ?? state.calendars.find((c) => c.accountId === 'local')?.id;
    const today = dayIn(Date.now(), ZONE);
    const events = async (from, toDay) => {
        const r = await api('events', { from: Date.parse(`${addDays(from, -1)}T00:00:00Z`), to: Date.parse(`${addDays(toDay, 2)}T00:00:00Z`) });
        return r.ok ? r.value.occurrences : [];
    };

    // The browser half: DSH serves it, and it parses (DSH sends browser halves together: one that doesn't parse breaks the others).
    const app = await httpGet(web.base.href, { cookie: web.cookie });
    const clientUrl = /"id":"dsh-plugin-calendar","url":"([^"]+)"/.exec(app.text)?.[1];
    const client = clientUrl ? await httpGet(new URL(clientUrl, web.base).href, { cookie: web.cookie }) : { status: 0, text: '' };
    let parses = false;
    try {
        new Script(client.text);
        parses = true;
    } catch {}
    check('DSH serves the calendar\'s browser half and it parses', client.status === 200 && parses && client.text.includes('dsh-plugin-calendar'),
        `${clientUrl ?? 'not in the boot graph'}: ${client.status}`);

    // A second calendar with an event, to hide; agents' calls for the chat cards (and a session for the Agenda pane).
    const side = (await api('createCalendar', { name: 'E2E Side', color: '#12a594' })).value?.calendar;
    await api('createEvent', { input: { calendarId: side?.id, title: 'E2E Side event', start: `${addDays(today, 1)}T07:00`, end: `${addDays(today, 1)}T07:30`, timeZone: ZONE } });
    const listCall = await agentCall('calendar_events', { from: today, to: addDays(today, 6) }, 'What is on my calendar?');
    const createCall = await agentCall('calendar_create_event', { title: 'E2E From agent', start: `${addDays(today, 2)}T13:00`, end: `${addDays(today, 2)}T13:45` }, 'Add it please');

    browser = await launch(pw);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: ZONE, locale: 'en-US', colorScheme: 'light' });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (m) => { if (m.type() === 'error' && /calendar/i.test(m.text())) pageErrors.push(m.text()); });
    await page.goto(signInLink(), { waitUntil: 'domcontentloaded' });
    await settleWindow(page);

    const calendarEntry = page.getByRole('button', { name: 'Calendar', exact: true }).first();
    const openPage = async () => {
        await calendarEntry.click();
        await page.locator('[data-calendar-page]').waitFor({ state: 'visible', timeout: 15000 });
    };
    const grid = page.locator('[data-calendar-main]');
    const eventOnPage = (title) => grid.locator('[data-calendar-event]', { hasText: title }).first();
    const dialogGone = () => page.locator('[data-calendar-event-form]').waitFor({ state: 'detached', timeout: 15000 });

    // 1. The page.
    await step('the Calendar page opens from DSH\'s sidebar, in Week view', async () => {
        await openPage();
        const view = await page.locator('[data-calendar-page]').getAttribute('data-calendar-view-now');
        await page.locator('[data-calendar-day-column]').first().waitFor({ state: 'visible' });
        const columns = await page.locator('[data-calendar-day-column]').count();
        check('the Calendar page opens from DSH\'s sidebar, in Week view', view === 'week' && columns === 7, `${view} ${columns}`);
    });
    await step('the settings file that couldn\'t be read', async () => {
        const note = page.locator('[data-calendar-store-issue]');
        await note.waitFor({ state: 'visible' });
        const text = await note.textContent();
        const aside = readdirSync(join(home, 'calendar')).filter((n) => n.startsWith('calendar.json.unreadable-'));
        await shot(page, 'store-notice');
        await note.getByRole('button', { name: 'Close this notice' }).click();
        await note.waitFor({ state: 'detached' });
        check('a settings file the plugin couldn\'t read: the page says quietly that it was set aside and nothing was deleted, until closed',
            aside.length === 1 && text.includes(`“${aside[0]}”`) && /Nothing was deleted/.test(text), JSON.stringify({ aside, text }));
    });
    // The side column at 1280 px: beside DSH's sidebar the page is narrower than 1100 px, so it starts folded; its
    // button shows it beside the view (and it stays shown for the steps below).
    await step('the side column at 1280 px', async () => {
        const side = page.locator('[data-calendar-side]');
        const toggle = page.locator('[data-calendar-side-toggle]');
        const width = await page.locator('[data-calendar-page]').evaluate((el) => el.clientWidth);
        const foldedFirst = !(await side.isVisible());
        const newInHeader = await page.locator('[data-calendar-new]').isVisible();
        await shot(page, 'side-folded');
        await toggle.click();
        await side.waitFor({ state: 'visible' });
        const shown = await page.evaluate(() => {
            const s = document.querySelector('[data-calendar-side]').getBoundingClientRect();
            const m = document.querySelector('[data-calendar-main]').getBoundingClientRect();
            const root = document.querySelector('[data-calendar-page]');
            return { beside: s.right <= m.left, over: root.hasAttribute('data-side-open'), focusIn: Boolean(document.activeElement?.closest('[data-calendar-side]')) };
        });
        const expanded = await toggle.getAttribute('aria-expanded');
        await toggle.click();
        await side.waitFor({ state: 'hidden' });
        const focusBack = await page.evaluate(() => document.activeElement?.hasAttribute('data-calendar-side-toggle') === true);
        await toggle.click();
        await side.waitFor({ state: 'visible' });
        check('at 1280 px the side column starts folded behind its button, which shows it beside the view, the focus going into it and back to the button on folding it',
            width < 1100 && foldedFirst && newInHeader && shown.beside && !shown.over && shown.focusIn && expanded === 'true' && focusBack,
            JSON.stringify({ width, foldedFirst, newInHeader, shown, expanded, focusBack }));
    });
    await step('chats may email guests without asking', async () => {
        // askBeforeEmails is off in this profile: said quietly in the side column, with nothing there to change it.
        const note = page.locator('[data-calendar-side] [data-calendar-ask-off]');
        await note.waitFor({ state: 'visible' });
        const text = (await note.textContent()) ?? '';
        const controls = await note.locator('button, a, input').count();
        const off = (await api('state')).value?.askBeforeEmails;
        check('with askBeforeEmails off, the side column says that chats can email guests without asking, and where it is set, with no control for it',
            off === false && /^Chats can email your guests without asking you first/.test(text) && text.includes('“Ask before emails” is off')
            && text.includes('cordis.patch.yml') && controls === 0, JSON.stringify({ off, text, controls }));
    });
    await shot(page, 'week-light');

    // 2. Events through the dialog.
    const day1 = addDays(today, 1);
    const day2 = addDays(today, 2);
    await step('a timed event made in the dialog', async () => {
        await page.locator('[data-calendar-side-new]').click();
        const form = page.locator('[data-calendar-event-form="new"]');
        await form.waitFor({ state: 'visible' });
        await form.locator('[data-calendar-title]').fill('E2E Planning');
        await form.locator('[data-calendar-start-day]').fill(day1);
        await form.locator('[data-calendar-start-time]').fill('10:00');
        await form.locator('[data-calendar-end-time]').fill('10:30');
        await shot(page, 'event-dialog');
        await page.locator('[data-calendar-save]').click();
        await dialogGone();
        await eventOnPage('E2E Planning').waitFor({ state: 'visible', timeout: 10000 });
        const made = (await events(day1, day1)).find((o) => o.title === 'E2E Planning');
        check('a timed event made in the dialog is in the calendar at its time, and on the page', made && made.startLocal === `${day1}T10:00` && made.endLocal === `${day1}T10:30`
            && made.timeZone === ZONE && made.calendarId === defaultCalendar, JSON.stringify(made));
    });
    await step('an event\'s details and the keyboard', async () => {
        // Opened, the details take the focus; Escape closes them (not the page under them), and the focus goes back.
        await eventOnPage('E2E Planning').click();
        const details = page.locator('[data-calendar-details]');
        await details.waitFor({ state: 'visible' });
        const inside = await page.waitForFunction(() => document.querySelector('[data-calendar-details]')?.contains(document.activeElement), null, { timeout: 5000 })
            .then(() => true, () => false);
        await page.keyboard.press('Escape');
        await details.waitFor({ state: 'detached', timeout: 5000 });
        const back = await page.evaluate(() => document.activeElement?.closest?.('[data-calendar-event]')?.textContent ?? '');
        check('an event\'s details take the focus when they open; Escape closes them and the focus goes back to the event', inside && /E2E Planning/.test(back),
            JSON.stringify({ inside, back }));
    });
    await step('an all-day event made in the dialog', async () => {
        await page.locator('[data-calendar-side-new]').click();
        const form = page.locator('[data-calendar-event-form="new"]');
        await form.waitFor({ state: 'visible' });
        await form.locator('[data-calendar-title]').fill('E2E Offsite');
        await form.locator('[data-calendar-allday] .dshcal-switch-text, label:has([data-calendar-allday])').first().click();
        await form.locator('[data-calendar-start-day]').fill(day2);
        await form.locator('[data-calendar-end-day]').fill(addDays(day2, 1));
        await page.locator('[data-calendar-save]').click();
        await dialogGone();
        await grid.locator('.dshcal-bar', { hasText: 'E2E Offsite' }).first().waitFor({ state: 'visible', timeout: 10000 });
        const made = (await events(day2, addDays(day2, 1))).find((o) => o.title === 'E2E Offsite');
        check('an all-day event made in the dialog spans its days, in the all-day row', made?.allDay === true && made.startDay === day2 && made.lastDay === addDays(day2, 1),
            JSON.stringify(made));
    });
    let weekly;
    await step('a weekly repeating event made in the dialog', async () => {
        await page.locator('[data-calendar-side-new]').click();
        const form = page.locator('[data-calendar-event-form="new"]');
        await form.waitFor({ state: 'visible' });
        await form.locator('[data-calendar-title]').fill('E2E Weekly sync');
        await form.locator('[data-calendar-start-day]').fill(day1);
        await form.locator('[data-calendar-start-time]').fill('15:00');
        await form.locator('[data-calendar-end-time]').fill('16:00');
        await form.locator('[data-calendar-repeat]').selectOption('weekly');
        await page.locator('[data-calendar-save]').click();
        await dialogGone();
        const list = (await events(day1, addDays(day1, 28))).filter((o) => o.title === 'E2E Weekly sync');
        weekly = list[0];
        check('a weekly repeating event made in the dialog repeats every week', list.length >= 4 && list.every((o) => o.recurring && /FREQ=WEEKLY/.test(o.repeat ?? ''))
            && list.every((o, i) => o.startLocal === `${addDays(day1, 7 * i)}T15:00`), JSON.stringify(list.map((o) => [o.id, o.startLocal])));
    });

    await step('a toast while the event dialog is open', async () => {
        // An event saved, its toast showing: the next event dialog opened under it keeps its buttons clear (the toast goes to the top).
        await page.locator('[data-calendar-side-new]').click();
        const form = page.locator('[data-calendar-event-form="new"]');
        await form.waitFor({ state: 'visible' });
        await form.locator('[data-calendar-title]').fill('E2E Toast');
        await page.locator('[data-calendar-save]').click();
        await dialogGone();
        await page.locator('.dshcal-toast').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('[data-calendar-side-new]').click();
        await form.waitFor({ state: 'visible' });
        const geo = await page.evaluate(() => {
            const box = (el) => {
                const r = el?.getBoundingClientRect();
                return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) } : null;
            };
            const toast = document.querySelector('.dshcal-toast');
            return { toast: box(toast), text: toast?.textContent ?? '', footer: box(document.querySelector('[data-calendar-save]')?.parentElement) };
        });
        await shot(page, 'event-dialog-toast');
        await page.keyboard.press('Escape');
        await dialogGone();
        const made = (await events(today, addDays(today, 2))).find((o) => o.title === 'E2E Toast');
        if (made) await api('deleteEvent', { id: made.id, scope: 'all' });
        const apart = (a, b) => a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
        check('a toast shown while the event dialog is open stays off the dialog\'s buttons', Boolean(geo.toast && geo.footer) && /E2E Toast/.test(geo.text) && apart(geo.toast, geo.footer),
            JSON.stringify(geo));
    });

    /** Show the week that has a day (next/previous until its column is there). */
    const showDay = async (day) => {
        for (let i = 0; i < 8 && !(await page.locator(`[data-calendar-day-column="${day}"]`).count()); i++) {
            const first = await page.locator('[data-calendar-day-column]').first().getAttribute('data-calendar-day-column');
            await page.locator(first < day ? '[data-calendar-next]' : '[data-calendar-prev]').click();
            await page.waitForTimeout(400);
        }
    };
    const occurrenceOn = (day) => page.locator(`[data-calendar-main] [data-calendar-event="${weekly?.eventId}.${compact(day, '15:00')}"]`);

    // 3. One occurrence changed, another deleted.
    await step('one occurrence of a repeating event changed', async () => {
        const day = addDays(day1, 7);
        await showDay(day);
        await occurrenceOn(day).click();
        await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
        await page.locator('[data-calendar-edit]').click();
        const form = page.locator('[data-calendar-event-form="edit"]');
        await form.waitFor({ state: 'visible' });
        await form.locator('[data-calendar-title]').fill('E2E Weekly sync (moved)');
        await form.locator('[data-calendar-start-time]').fill('16:00');
        await page.locator('[data-calendar-save]').click();
        await page.locator('[data-calendar-scope="one"]').click();
        await page.locator('[data-calendar-submit]').click();
        await dialogGone();
        const list = await events(day1, addDays(day1, 21));
        const moved = list.find((o) => o.title === 'E2E Weekly sync (moved)');
        const rest = list.filter((o) => o.title === 'E2E Weekly sync').map((o) => o.startLocal);
        check('one occurrence of a repeating event changed (scope one), the others as they were', moved?.startLocal === `${day}T16:00` && moved.changed === true
            && rest.includes(`${day1}T15:00`) && rest.includes(`${addDays(day1, 14)}T15:00`) && !rest.includes(`${day}T15:00`), JSON.stringify({ moved, rest }));
    });
    await step('one occurrence of a repeating event deleted', async () => {
        const day = addDays(day1, 14);
        await showDay(day);
        await occurrenceOn(day).click();
        await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
        await page.locator('[data-calendar-delete]').click();
        await page.locator('[data-calendar-scope="one"]').click();
        await page.locator('[data-calendar-submit]').click();
        await occurrenceOn(day).waitFor({ state: 'detached', timeout: 10000 });
        const rest = (await events(day1, addDays(day1, 28))).filter((o) => o.title === 'E2E Weekly sync').map((o) => o.startLocal);
        check('one occurrence of a repeating event deleted (scope one), the series goes on', !rest.includes(`${day}T15:00`) && rest.includes(`${day1}T15:00`)
            && rest.includes(`${addDays(day1, 21)}T15:00`), JSON.stringify(rest));
    });

    // 4. Views.
    await step('Month, Day and Agenda views', async () => {
        await page.keyboard.press('Escape');
        await page.locator('[data-calendar-today]').click();
        await page.locator(`[data-calendar-day-column="${today}"]`).waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('[data-calendar-view="month"]').click();
        await page.locator('[data-calendar-grid="month"]').waitFor({ state: 'visible' });
        const kept = await waitFor(async () => (await api('state')).value?.prefs?.view === 'month', 'the view kept', 5000).catch(() => false);
        await page.locator('[data-calendar-view="day"]').click();
        await page.locator('[data-calendar-grid="day"]').waitFor({ state: 'visible' });
        const dayColumns = await page.locator('[data-calendar-day-column]').count();
        await page.locator('[data-calendar-view="agenda"]').click();
        await page.locator('[data-calendar-grid="agenda"]').waitFor({ state: 'visible' });
        const agendaHas = await page.locator('[data-calendar-grid="agenda"] [data-calendar-event]', { hasText: 'E2E Planning' }).first()
            .waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
        await page.locator('[data-calendar-view="week"]').click();
        await page.locator('[data-calendar-grid="week"]').waitFor({ state: 'visible' });
        // Keys: N twice (two weeks on), then T (today).
        await page.keyboard.press('n');
        await page.keyboard.press('n');
        await page.locator(`[data-calendar-day-column="${addDays(today, 14)}"]`).waitFor({ state: 'visible', timeout: 5000 });
        await page.keyboard.press('t');
        await page.locator(`[data-calendar-day-column="${today}"]`).waitFor({ state: 'visible', timeout: 5000 });
        check('Month, Day and Agenda views show, the choice is kept, and the keys N and T move the page', kept && dayColumns === 1 && agendaHas,
            JSON.stringify({ kept, dayColumns, agendaHas }));
    });
    await step('month view screenshot', async () => {
        await page.locator('[data-calendar-view="month"]').click();
        await page.locator('[data-calendar-grid="month"]').waitFor({ state: 'visible' });
        await shot(page, 'month-light');
        // Beside the side column the month is narrow: a timed event's title alone, without its time in front.
        const month = await page.locator('[data-calendar-grid="month"]').evaluate((el) => ({
            width: el.clientWidth,
            times: [...el.querySelectorAll('.dshcal-line-time')].map((t) => getComputedStyle(t).display),
        }));
        await page.locator('[data-calendar-view="week"]').click();
        check('a narrow month shows timed events by their titles, without their times in front', month.width < 910 && month.times.length > 0 && month.times.every((d) => d === 'none'),
            JSON.stringify(month));
    });

    // 4b. Where the hours open, placed again whenever the days shown change: an early event (6:00, before 7:30) whole after Next,
    // Previous and Week to Day, and in a narrow window, on a grid made anew (Month and back) and not scrolled since.
    await step('the hours open on the first event again on other days', async () => {
        const dayE = addDays(today, 21);
        const early = (await api('createEvent', { input: { title: 'E2E Early', start: `${dayE}T06:00`, end: `${dayE}T06:45`, timeZone: ZONE } })).value?.occurrence;
        try {
            await page.locator('[data-calendar-view="month"]').click();
            await page.locator('[data-calendar-grid="month"]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-today]').click();
            await page.locator('[data-calendar-view="week"]').click();
            await page.locator(`[data-calendar-day-column="${today}"]`).waitFor({ state: 'visible' });
            /** Whether the early event shows whole in the hours, once its days are read. */
            const whole = async () => {
                const ev = grid.locator(`.dshcal-ev[data-calendar-event="${early?.id}"]`);
                await ev.waitFor({ state: 'visible', timeout: 10000 });
                await page.waitForTimeout(400);
                return ev.evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    const box = el.closest('[data-calendar-scroll]').getBoundingClientRect();
                    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
                });
            };
            await showDay(dayE);
            const next = await whole();
            await page.locator('[data-calendar-next]').click();
            await page.waitForTimeout(400);
            await page.locator('[data-calendar-prev]').click();
            const back = await whole();
            const columns = await page.locator('[data-calendar-day-column]').evaluateAll((els) => els.map((el) => el.getAttribute('data-calendar-day-column')));
            await page.locator('.dshcal-wk-dayhead').nth(columns.indexOf(dayE)).click();
            await page.locator('[data-calendar-grid="day"]').waitFor({ state: 'visible' });
            const day = await whole();
            await shot(page, 'day-opening');
            await page.setViewportSize({ width: 420, height: 820 });
            await page.waitForTimeout(500);
            await page.locator('[data-calendar-prev]').click();
            await page.waitForTimeout(400);
            await page.locator('[data-calendar-next]').click();
            const narrow = await whole();
            await shot(page, 'narrow-day-opening');
            check('Week and Day open their hours on the first event again when the days shown change: after Next, Previous and Week to Day, and narrow',
                next && back && day && narrow, JSON.stringify({ next, back, day, narrow }));
        } finally {
            await page.setViewportSize({ width: 1280, height: 800 });
            await api('deleteEvent', { id: early?.id, scope: 'all' }).catch(() => {});
            await page.locator('[data-calendar-view="week"]').click();
            await page.locator('[data-calendar-today]').click();
        }
    });

    // 5. A calendar hidden and shown again.
    await step('a calendar hidden from the side column', async () => {
        await showDay(day1);
        const toggle = page.locator(`[data-calendar-cal="${side?.id}"] .dshcal-cal-toggle`);
        await eventOnPage('E2E Side event').waitFor({ state: 'visible', timeout: 10000 });
        await toggle.click();
        await eventOnPage('E2E Side event').waitFor({ state: 'detached', timeout: 10000 });
        const hidden = (await api('state')).value?.calendars?.find((c) => c.id === side?.id)?.hidden;
        const checked = await toggle.getAttribute('aria-checked');
        await toggle.click();
        await eventOnPage('E2E Side event').waitFor({ state: 'visible', timeout: 10000 });
        check('a calendar hidden from the side column takes its events off the page, and comes back', hidden === true && checked === 'false', `${hidden} ${checked}`);
    });

    /**
     * The question before a change that emails or reaches people, as it shows: its title and words, everyone it
     * names (with what each gets, the new ones, and those on screen), its buttons, and the way to answer it.
     */
    const consent = async () => {
        const send = page.locator('[data-calendar-send]');
        await send.waitFor({ state: 'visible', timeout: 10000 });
        const dialog = send.locator('xpath=ancestor::*[@role="dialog"][1]');
        const rows = dialog.locator('[data-calendar-person]');
        const names = (els) => els.map((el) => el.getAttribute('data-calendar-person'));
        return {
            title: await dialog.evaluate((el) => {
                const id = (el.closest('[aria-labelledby]') ?? el.querySelector('[aria-labelledby]'))?.getAttribute('aria-labelledby');
                return ((id && el.ownerDocument.getElementById(id)) || el.querySelector('h1, h2, h3, [role=heading]'))?.textContent ?? '';
            }),
            text: (await dialog.textContent()) ?? '',
            people: await rows.evaluateAll(names),
            gets: await dialog.locator('.dshcal-gets').allTextContents(),
            fresh: await rows.evaluateAll((els) => els.filter((el) => el.querySelector('[data-calendar-person-new]')).map((el) => el.getAttribute('data-calendar-person'))),
            // Whole on screen: inside the list's box (it scrolls past about eight) and the window.
            onScreen: await dialog.locator('[data-calendar-people]').evaluate((ul) => {
                const box = ul.getBoundingClientRect();
                return [...ul.querySelectorAll('[data-calendar-person]')].filter((li) => {
                    const r = li.getBoundingClientRect();
                    return r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.top >= 0 && r.bottom <= ul.ownerDocument.documentElement.clientHeight;
                }).map((li) => li.getAttribute('data-calendar-person'));
            }).catch(() => []),
            no: (await dialog.locator('[data-calendar-keep]').textContent()) ?? '',
            yes: (await send.textContent()) ?? '',
            answer: async (yes) => {
                await dialog.locator(yes ? '[data-calendar-send]' : '[data-calendar-keep]').click();
                await send.waitFor({ state: 'detached' });
            },
        };
    };

    // 6. Email: the question names everyone the change emails, with what they get and why; made only on its yes,
    // held to them.
    /** Whether two calls make the same change: the same event, scope and fields, notify and approved aside. */
    const sameChange = (a, b) => {
        const fields = (call) => JSON.stringify(Object.entries(call?.patch ?? call?.input ?? {}).filter(([k]) => k !== 'notify' && k !== 'approved').sort());
        return a?.id === b?.id && a?.scope === b?.scope && fields(a) === fields(b);
    };
    const updateCalls = '**/api/dsh-plugin-calendar/updateEvent';
    await step('a change that would email people', async () => {
        await page.locator('[data-calendar-today]').click();
        await showDay(day1);
        const sent = [];
        let refusals = 2;
        const six = ['ann@example.com', 'bob@example.com', 'cy@example.com', 'dee@example.com', 'eve@example.com', 'fay@example.com'];
        const why = 'Microsoft emails a meeting\'s guests about each change to it';
        // The calendars here email no one, so the host's answer is played: it would email six guests an update (twice), then
        // the change sent with notify is made for real (without it) and answered as if it had emailed them.
        await page.route(updateCalls, async (route) => {
            const body = JSON.parse(route.request().postData() ?? '{}');
            const args = body.payload?.args ?? {};
            sent.push(args);
            if (args.patch?.notify !== true && refusals > 0) {
                refusals -= 1;
                return route.fulfill({
                    status: 200, contentType: 'application/json',
                    body: JSON.stringify({
                        type: 'server-response', rpcId: body.rpcId,
                        result: {
                            ok: false,
                            error: {
                                code: 'calendar/needs-notify', message: `This would email an update to ${six.slice(0, 5).join(', ')} and 1 more (${why}), so it's made only when they are to be told.`,
                                details: { people: six, mail: { emailed: { what: 'an update', to: six }, why } },
                            },
                        },
                    }),
                });
            }
            // Made for real without notify; approved goes to the host as sent (the event names nobody, so it holds).
            const patch = { ...args.patch };
            delete patch.notify;
            const response = await route.fetch({ postData: JSON.stringify({ ...body, payload: { args: { ...args, patch } } }) });
            const real = await response.json();
            if (real.result?.ok && real.result.value?.occurrence) real.result.value.occurrence.emailed = { what: 'an update', to: six };
            return route.fulfill({ response, body: JSON.stringify(real) });
        });
        try {
            await eventOnPage('E2E Planning').click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-edit]').click();
            const form = page.locator('[data-calendar-event-form="edit"]');
            await form.waitFor({ state: 'visible' });
            await form.locator('[data-calendar-title]').fill('E2E Planning review');
            await page.locator('[data-calendar-save]').click();
            const question = await consent();
            await shot(page, 'send-question');
            await question.answer(false);
            const stillOpen = await form.isVisible();
            const unchanged = (await events(day1, day1)).some((o) => o.title === 'E2E Planning');
            await page.locator('[data-calendar-save]').click();
            await (await consent()).answer(true);
            await dialogGone();
            const toast = await page.locator('.dshcal-toast').first().textContent();
            const saved = (await events(day1, day1)).find((o) => o.title === 'E2E Planning review');
            check('a change that would email six guests asks first, naming all six on screen with what they get and why; Don\'t save sends nothing, Save and email repeats it with notify and approved: the six, and the toast says who was emailed',
                question.title === 'Email an update to 6 guests?' && question.text.includes(`${why}.`) && !question.text.includes('so it\'s made only when')
                && JSON.stringify(question.people) === JSON.stringify(six) && JSON.stringify(question.onScreen) === JSON.stringify(six)
                && question.gets.length === 6 && question.gets.every((g) => g === 'An update') && question.no === 'Don\'t save' && question.yes === 'Save and email'
                && stillOpen && unchanged && saved !== undefined
                && sent.length === 3 && sent[0].patch?.notify === undefined && sent[1].patch?.notify === undefined && sent[0].patch?.approved === undefined
                && sent[2].patch?.notify === true && JSON.stringify(sent[2].patch?.approved) === JSON.stringify(six)
                && sameChange(sent[0], sent[2]) && sameChange(sent[0], sent[1])
                && /Emailed an update to ann@example\.com, bob@example\.com, cy@example\.com and 3 others\./.test(toast ?? ''),
                JSON.stringify({ question: { ...question, answer: undefined }, stillOpen, unchanged, sent, toast, saved: saved?.title }));
        } finally {
            await page.unroute(updateCalls);
        }
    });

    // A question naming twelve: its list scrolls, and takes the keys. Played as above (the host's answer), for a delete
    // answered No, so nothing is deleted.
    const deleteCalls = '**/api/dsh-plugin-calendar/deleteEvent';
    await step('the long list in the question, by keyboard', async () => {
        const twelve = Array.from({ length: 12 }, (_, i) => `guest${i + 1}@example.com`);
        const why = 'Microsoft emails a meeting\'s guests when it is cancelled';
        const sent = [];
        await page.route(deleteCalls, async (route) => {
            const body = JSON.parse(route.request().postData() ?? '{}');
            sent.push(body.payload?.args ?? {});
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({
                    type: 'server-response', rpcId: body.rpcId,
                    result: {
                        ok: false,
                        error: {
                            code: 'calendar/needs-notify', message: `This would email a cancellation to ${twelve.slice(0, 5).join(', ')} and 7 more (${why}), so it's made only when they are to be told.`,
                            details: { people: twelve, mail: { emailed: { what: 'a cancellation', to: twelve }, why } },
                        },
                    },
                }),
            });
        });
        try {
            await eventOnPage('E2E Planning review').click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-delete]').click();
            await page.locator('[data-calendar-submit]').click();
            const question = await consent();
            const list = page.locator('[data-calendar-people]');
            await waitFor(() => page.evaluate(() => document.activeElement?.hasAttribute('data-calendar-keep') === true), 'the focus on Don\'t delete', 5000).catch(() => {});
            // Which of its people are whole in view, inside the list's box.
            const inView = () => list.evaluate((ul) => {
                const box = ul.getBoundingClientRect();
                return [...ul.querySelectorAll('[data-calendar-person]')].filter((li) => {
                    const r = li.getBoundingClientRect();
                    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
                }).map((li) => li.getAttribute('data-calendar-person'));
            });
            await page.keyboard.press('Shift+Tab');
            const listFocused = await list.evaluate((ul) => ul.ownerDocument.activeElement === ul);
            const top = await inView();
            await page.keyboard.press('End');
            await page.waitForTimeout(300);
            const end = await inView();
            await shot(page, 'question-12-end');
            await page.keyboard.press('Home');
            await page.waitForTimeout(300);
            const home = await inView();
            await page.keyboard.press('Escape');
            await page.locator('[data-calendar-send]').waitFor({ state: 'detached' });
            await page.locator('[data-calendar-submit]').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
            const still = (await events(day1, day1)).some((o) => o.title === 'E2E Planning review');
            check('a question naming twelve: the list takes the focus from No with Shift+Tab, End shows its last people and Home its first; Escape is Don\'t delete',
                question.title === 'Email a cancellation to 12 guests?' && question.people.length === 12 && listFocused
                && top.includes(twelve[0]) && !top.includes(twelve[11]) && end.includes(twelve[11]) && !end.includes(twelve[0])
                && home.includes(twelve[0]) && !home.includes(twelve[11]) && sent.length === 1 && still,
                JSON.stringify({ title: question.title, listFocused, top, end, home, sent: sent.length, still }));
        } finally {
            await page.unroute(deleteCalls);
        }
    });

    // 7. A move to another calendar: on its own first, then the other changes on the moved event; a guest the calendar can't email.
    await step('an event moved to another calendar with other changes', async () => {
        const calls = [];
        const onRequest = (request) => {
            if (request.url().endsWith('/api/dsh-plugin-calendar/updateEvent')) calls.push(JSON.parse(request.postData() ?? '{}').payload?.args);
        };
        page.on('request', onRequest);
        try {
            await eventOnPage('E2E Planning review').click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-edit]').click();
            const form = page.locator('[data-calendar-event-form="edit"]');
            await form.waitFor({ state: 'visible' });
            await form.locator('[data-calendar-calendar]').selectOption(side.id);
            await form.locator('[data-calendar-title]').fill('E2E Planning moved');
            await form.locator('[data-calendar-guest-input]').fill('ann@example.com');
            await form.locator('[data-calendar-guest-input]').press('Enter');
            await form.locator('[data-calendar-guests]').waitFor({ state: 'visible' });
            const never = await form.locator('[data-calendar-mail="never"]').isVisible();
            const box = await form.locator('[data-calendar-notify]').count();
            await page.locator('[data-calendar-save]').click();
            await dialogGone();
            const moved = (await events(day1, day1)).find((o) => o.title === 'E2E Planning moved');
            const [first, second] = calls;
            check('a move goes first on its own (the whole event), the other changes then go to the moved event; no email offered where the calendar can\'t send it',
                never && box === 0 && moved?.calendarId === side.id && (moved.attendees ?? []).some((a) => a.email === 'ann@example.com')
                && calls.length === 2 && JSON.stringify(Object.keys(first?.patch ?? {})) === '["calendarId"]' && first.scope === 'all'
                && !('calendarId' in (second?.patch ?? {})) && second?.patch?.title === 'E2E Planning moved' && second.patch.notify === undefined
                && String(second.id).startsWith(moved.eventId), JSON.stringify({ never, box, calls, moved: moved && { id: moved.id, calendarId: moved.calendarId } }));
        } finally {
            page.off('request', onRequest);
        }
    });

    // 8. No default calendar: the host's own state, with none chosen and every calendar hidden (a hidden one is never the default).
    await step('with no default calendar, the event dialog asks for one', async () => {
        const creates = [];
        const onRequest = (request) => {
            if (request.url().endsWith('/api/dsh-plugin-calendar/createEvent')) creates.push(JSON.parse(request.postData() ?? '{}').payload?.args?.input);
        };
        const tagged = () => page.locator('[data-calendar-side] .dshcal-tag', { hasText: 'default' }).count();
        const shown = ((await api('state')).value?.calendars ?? []).filter((c) => !c.readOnly && !c.hidden);
        for (const c of shown) await api('updateCalendar', { id: c.id, patch: { hidden: true } });
        page.on('request', onRequest);
        let made;
        try {
            const none = (await api('state')).value?.defaultCalendar;
            await waitFor(async () => (await tagged()) === 0, 'the page to read state without a default', 15000);
            await page.locator('[data-calendar-side-new]').click();
            const form = page.locator('[data-calendar-event-form="new"]');
            await form.waitFor({ state: 'visible' });
            const select = form.locator('[data-calendar-calendar]');
            const before = { value: await select.inputValue(), shown: await select.evaluate((el) => el.options[el.selectedIndex]?.textContent ?? ''), dot: await form.locator('.dshcal-dot[data-none]').count() };
            await form.locator('[data-calendar-title]').fill('E2E No default');
            await page.locator('[data-calendar-save]').click();
            await form.locator('.dshcal-field-error', { hasText: 'Choose the calendar it goes to.' }).waitFor({ state: 'visible', timeout: 5000 });
            const invalid = await select.getAttribute('aria-invalid');
            await shot(page, 'no-default');
            const refusedLocally = creates.length === 0;
            await select.selectOption(defaultCalendar);
            const after = { dot: await form.locator('.dshcal-dot[data-none]').count(), placeholder: await select.locator('option[value=""]').count() };
            await page.locator('[data-calendar-save]').click();
            await dialogGone();
            made = await waitFor(async () => {
                const r = await api('events', { from: Date.parse(`${addDays(today, -1)}T00:00:00Z`), to: Date.parse(`${addDays(today, 3)}T00:00:00Z`), calendars: [defaultCalendar] });
                return r.value?.occurrences?.find((o) => o.title === 'E2E No default');
            }, 'the event', 10000);
            check('with no default calendar (none chosen, none shown) the event dialog shows none chosen, asks for one before saving, and saves to the one picked',
                none === null && shown.length >= 2 && before.value === '' && before.shown === 'Choose a calendar' && before.dot === 1 && invalid === 'true' && refusedLocally
                && after.dot === 0 && after.placeholder === 0 && creates.length === 1 && creates[0]?.calendarId === defaultCalendar && made?.calendarId === defaultCalendar,
                JSON.stringify({ none, shown: shown.length, before, invalid, after, creates: creates.map((c) => c?.calendarId), made: made?.calendarId }));
        } finally {
            page.off('request', onRequest);
            for (const c of shown) await api('updateCalendar', { id: c.id, patch: { hidden: false } });
            if (made) await api('deleteEvent', { id: made.id, scope: 'all' });
            await waitFor(async () => (await tagged()) === 1, 'the default calendar back', 15000).catch(() => {});
        }
    });

    // 8b. Dragging, with the mouse as a person drags (a few steps on the way); updateEvent's calls counted.
    /** Press at one point, move to another in steps (Escape on the way when asked), let go. */
    const dragMouse = async (from, to, { escape = false, steps = 12 } = {}) => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + (to.x - from.x) / 4, from.y + (to.y - from.y) / 4, { steps: 3 });
        await page.mouse.move(to.x, to.y, { steps });
        if (escape) await page.keyboard.press('Escape');
        await page.mouse.up();
    };
    /** A point in a day's column of the week, minutes into the day (and dy pixels on). */
    const pointIn = async (day, minutes, dy = 0) => {
        const box = await page.locator(`[data-calendar-day-column="${day}"]`).boundingBox();
        return { x: box.x + box.width / 2, y: box.y + (minutes / 60) * 48 + dy };
    };
    const updates = [];
    const onUpdate = (request) => {
        if (request.url().endsWith('/api/dsh-plugin-calendar/updateEvent')) updates.push(JSON.parse(request.postData() ?? '{}').payload?.args);
    };
    let dragged;
    let draggedTo;
    await step('an event dragged in Week', async () => {
        dragged = (await api('createEvent', { input: { title: 'E2E Drag me', start: `${day1}T11:00`, end: `${day1}T12:00`, timeZone: ZONE } })).value?.occurrence;
        await page.locator('[data-calendar-view="week"]').click();
        await showDay(day1);
        const columns = await page.locator('[data-calendar-day-column]').evaluateAll((els) => els.map((e) => e.getAttribute('data-calendar-day-column')));
        const target = columns[columns.indexOf(day1) + 1] ?? columns[columns.indexOf(day1) - 1];
        draggedTo = target;
        await page.locator('[data-calendar-scroll]').evaluate((el) => { el.scrollTop = 9 * 48; });
        const ev = () => grid.locator(`.dshcal-ev[data-calendar-event="${dragged?.id}"]`);
        await ev().waitFor({ state: 'visible', timeout: 10000 });
        updates.length = 0;
        page.on('request', onUpdate);
        try {
            // Escape on the way: it stays where it was, nothing is saved, nothing opens.
            const box = await ev().boundingBox();
            const grab = { x: box.x + box.width / 2, y: box.y + 10 };
            const to = await pointIn(target, 13.5 * 60, 11);
            await dragMouse(grab, to, { escape: true });
            await page.waitForTimeout(500);
            const cancelled = updates.length === 0 && (await page.locator('[data-calendar-ghost]').count()) === 0 && (await page.locator('[data-calendar-details]').count()) === 0;
            // Held over the next day at 13:30: the ghost says where; let go, it's there, an hour long.
            await page.mouse.move(grab.x, grab.y);
            await page.mouse.down();
            await page.mouse.move(grab.x, grab.y + 20, { steps: 3 });
            await page.mouse.move(to.x, to.y, { steps: 12 });
            const ghost = (await page.locator('[data-calendar-ghost="move"]').textContent().catch(() => '')) ?? '';
            await shot(page, 'drag-week');
            await page.mouse.up();
            const moved = await waitFor(async () => (await events(target, target)).find((o) => o.id === dragged.id && o.startLocal === `${target}T13:30`), 'the moved event', 10000);
            const toast = (await page.locator('.dshcal-toast').first().textContent().catch(() => '')) ?? '';
            const opened = await page.locator('[data-calendar-details]').count();
            // Its bottom edge an hour lower: it ends at 15:30.
            await page.waitForTimeout(400);
            const after = await ev().boundingBox();
            const edge = { x: after.x + after.width / 2, y: after.y + after.height - 3 };
            await dragMouse(edge, { x: edge.x, y: edge.y + 48 });
            const longer = await waitFor(async () => (await events(target, target)).find((o) => o.id === dragged.id && o.endLocal === `${target}T15:30`), 'the longer event', 10000);
            // Alt with the down arrow: a quarter hour later, still in focus.
            await page.waitForTimeout(400);
            await ev().focus();
            await page.keyboard.press('Alt+ArrowDown');
            const nudged = await waitFor(async () => (await events(target, target)).find((o) => o.id === dragged.id && o.startLocal === `${target}T13:45`), 'the nudged event', 10000);
            const focused = await waitFor(() => page.evaluate((id) => document.activeElement?.getAttribute('data-calendar-event') === id, dragged.id), 'the focus on it', 5000).catch(() => false);
            check('an event dragged in Week goes to another time and day, by its bottom edge to another end, and on a quarter hour with Alt and an arrow; Escape on the way leaves it',
                cancelled && /1:30|13:30/.test(ghost) && /E2E Drag me/.test(ghost) && moved.endLocal === `${target}T14:30` && /^Moved “E2E Drag me” to /.test(toast) && opened === 0
                && longer.startLocal === `${target}T13:30` && nudged.endLocal === `${target}T15:45` && focused
                && updates.length === 3 && updates.every((u) => u.id === dragged.id && u.scope === 'all' && u.patch?.notify === undefined),
                JSON.stringify({ cancelled, ghost, moved: moved?.startLocal, toast, opened, longer: longer?.endLocal, nudged: nudged?.startLocal, focused, updates }));
        } finally {
            page.off('request', onUpdate);
        }
    });
    await step('an event dragged in Month', async () => {
        await page.locator('[data-calendar-view="month"]').click();
        await page.locator('[data-calendar-grid="month"]').waitFor({ state: 'visible' });
        for (let i = 0; i < 3 && !(await page.locator(`[data-calendar-cell="${draggedTo}"]`).count()); i++) {
            const first = await page.locator('[data-calendar-cell]').first().getAttribute('data-calendar-cell');
            await page.locator(first < draggedTo ? '[data-calendar-next]' : '[data-calendar-prev]').click();
            await page.waitForTimeout(400);
        }
        const cells = await page.locator('[data-calendar-cell]').evaluateAll((els) => els.map((e) => e.getAttribute('data-calendar-cell')));
        const toDay = cells.includes(addDays(draggedTo, 2)) ? addDays(draggedTo, 2) : addDays(draggedTo, -2);
        const piece = grid.locator(`.dshcal-line[data-calendar-event="${dragged?.id}"]`);
        await piece.waitFor({ state: 'visible', timeout: 10000 });
        const box = await piece.boundingBox();
        const cell = await page.locator(`[data-calendar-cell="${toDay}"]`).boundingBox();
        await page.mouse.move(box.x + 12, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 3 });
        await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height - 10, { steps: 12 });
        const marked = await page.locator('[data-calendar-cell][data-drop]').evaluateAll((els) => els.map((e) => e.getAttribute('data-calendar-cell')));
        await shot(page, 'drag-month');
        await page.mouse.up();
        const moved = await waitFor(async () => (await events(toDay, toDay)).find((o) => o.id === dragged?.id && o.startLocal === `${toDay}T13:45`), 'the event on its new day', 10000);
        await page.locator('[data-calendar-view="week"]').click();
        check('an event dragged in Month goes to another day at the same time of day, the day it would go to marked on the way',
            moved.endLocal === `${toDay}T15:45` && JSON.stringify(marked) === JSON.stringify([toDay]), JSON.stringify({ toDay, marked, moved: moved && [moved.startLocal, moved.endLocal] }));
    });
    await step('a repeating event dragged asks which occurrences move', async () => {
        const series = (await api('createEvent', { input: { title: 'E2E Drag series', start: `${day1}T08:00`, end: `${day1}T08:30`, timeZone: ZONE, repeat: 'FREQ=WEEKLY' } })).value?.occurrence;
        await showDay(day1);
        await page.locator('[data-calendar-scroll]').evaluate((el) => { el.scrollTop = 6 * 48; });
        const ev = grid.locator(`.dshcal-ev[data-calendar-event="${series?.eventId}.${compact(day1, '08:00')}"]`);
        await ev.waitFor({ state: 'visible', timeout: 10000 });
        const box = await ev.boundingBox();
        await dragMouse({ x: box.x + box.width / 2, y: box.y + 8 }, { x: box.x + box.width / 2, y: box.y + 8 + 48 });
        const one = page.locator('[data-calendar-scope="one"]');
        await one.waitFor({ state: 'visible' });
        const question = (await one.locator('xpath=ancestor::*[@role="dialog"][1]').textContent()) ?? '';
        const shownThere = await page.evaluate((id) => {
            const el = document.querySelector(`[data-calendar-main] .dshcal-ev[data-calendar-event="${id}"]`);
            return el ? Math.round(el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top) : -1;
        }, `${series?.eventId}.${compact(day1, '08:00')}`);
        await shot(page, 'drag-series');
        await one.click();
        await page.locator('[data-calendar-submit]').click();
        await one.waitFor({ state: 'detached' });
        const list = await waitFor(async () => {
            const found = (await events(day1, addDays(day1, 14))).filter((o) => o.title === 'E2E Drag series');
            return found.some((o) => o.startLocal === `${day1}T09:00`) ? found : null;
        }, 'the occurrence moved', 10000);
        const starts = list.map((o) => o.startLocal);
        check('a repeating event dragged asks which occurrences move, shows it where it goes meanwhile, and moves the one chosen',
            /Move “E2E Drag series”\?/.test(question) && /This event/.test(question) && shownThere === 9 * 48 + 1
            && starts.includes(`${day1}T09:00`) && starts.includes(`${addDays(day1, 7)}T08:00`) && !starts.includes(`${day1}T08:00`),
            JSON.stringify({ question, shownThere, starts }));
        await api('deleteEvent', { id: series?.id, scope: 'all' }).catch(() => {});
    });

    // 8b'. Alt and an arrow key on a meeting: the presses gathered, shown where they take it, then one question naming where, and
    // one save (the host's answer played as in 6); Escape drops a move, Enter saves it at once.
    await step('Alt and an arrow key twice on a meeting: one question, naming where it goes, and one save', async () => {
        const made = (await api('createEvent', { input: { title: 'E2E Key meeting', start: `${day1}T09:00`, end: `${day1}T09:30`, timeZone: ZONE } })).value?.occurrence;
        await page.locator('[data-calendar-view="week"]').click();
        await showDay(day1);
        const ev = grid.locator(`.dshcal-ev[data-calendar-event="${made?.id}"]`);
        await ev.waitFor({ state: 'visible', timeout: 10000 });
        const guests = ['ann@example.com', 'bob@example.com'];
        const why = 'Microsoft emails a meeting\'s guests about each change to it';
        const sent = [];
        await page.route(updateCalls, async (route) => {
            const body = JSON.parse(route.request().postData() ?? '{}');
            const args = body.payload?.args ?? {};
            sent.push(args);
            if (args.patch?.notify !== true) {
                return route.fulfill({
                    status: 200, contentType: 'application/json',
                    body: JSON.stringify({
                        type: 'server-response', rpcId: body.rpcId,
                        result: { ok: false, error: { code: 'calendar/needs-notify', message: 'It would email its guests.', details: { people: guests, mail: { emailed: { what: 'an update', to: guests }, why } } } },
                    }),
                });
            }
            const patch = { ...args.patch };
            delete patch.notify;
            return route.fulfill({ response: await route.fetch({ postData: JSON.stringify({ ...body, payload: { args: { ...args, patch } } }) }) });
        });
        try {
            const tip = (await ev.getAttribute('title')) ?? '';
            // Escape drops a move before it's saved.
            await ev.focus();
            await page.keyboard.press('Alt+ArrowDown');
            const first = (await page.locator('[data-calendar-ghost]').textContent().catch(() => '')) ?? '';
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2500);
            const dropped = sent.length === 0 && (await page.locator('[data-calendar-ghost]').count()) === 0;
            // Twice, quickly: shown at 9:30, then one question naming it, one save there.
            await ev.focus();
            await page.keyboard.press('Alt+ArrowDown');
            await page.keyboard.press('Alt+ArrowDown');
            const ghost = (await page.locator('[data-calendar-ghost]').textContent().catch(() => '')) ?? '';
            const live = (await page.locator('[data-calendar-keys]').textContent()) ?? '';
            await shot(page, 'keys-move');
            const question = await consent();
            await shot(page, 'keys-move-question');
            await question.answer(true);
            const moved = await waitFor(async () => (await events(day1, day1)).find((o) => o.id === made?.id && o.startLocal === `${day1}T09:30`), 'the meeting at 9:30', 10000);
            // The page has its answer once it says so: the played call is done before the next one (and before the route goes).
            const saidMoved = (at) => page.locator('.dshcal-toast', { hasText: new RegExp(`Moved “E2E Key meeting” to .*${at}`) }).first().waitFor({ state: 'visible', timeout: 10000 });
            await saidMoved('9:30');
            const twice = sent.splice(0);
            // Enter saves at once, without opening the event.
            await ev.focus();
            await page.keyboard.press('Alt+ArrowUp');
            await page.keyboard.press('Enter');
            const ghostAfterEnter = await page.locator('[data-calendar-ghost]').count();
            const again = await consent();
            const opened = await page.locator('[data-calendar-details]').count();
            await again.answer(true);
            const back = await waitFor(async () => (await events(day1, day1)).find((o) => o.id === made?.id && o.startLocal === `${day1}T09:15`), 'the meeting at 9:15', 10000);
            await saidMoved('9:15');
            const at = (o) => new Date(o.start).toISOString();
            check('Alt and an arrow key pressed twice on a meeting: shown where it goes, then one question naming it and one save there; Escape drops a move, Enter saves at once; the keys in its tooltip',
                /Alt/.test(tip) && /9:15/.test(first) && dropped && /E2E Key meeting/.test(ghost) && /9:30/.test(ghost) && /9:30/.test(live)
                && question.title === 'Email an update to 2 guests?' && /Moving “E2E Key meeting” to .*9:30/.test(question.text)
                && twice.length === 2 && twice.every((u) => u.id === made?.id && u.patch?.start === at(moved)) && twice[0].patch.notify === undefined && twice[1].patch.notify === true
                && ghostAfterEnter === 0 && opened === 0 && /9:15/.test(again.text) && sent.length === 2 && sent.every((u) => u.patch?.start === at(back)),
                JSON.stringify({ tip, first, dropped, ghost, live, question: { title: question.title, text: question.text }, twice, ghostAfterEnter, opened, again: again.text, sent }));
        } finally {
            await page.unroute(updateCalls);
            await api('deleteEvent', { id: made?.id, scope: 'all' }).catch(() => {});
        }
    });

    // 8c. Search.
    await step('search', async () => {
        await page.locator('[data-calendar-range]').click();
        await page.keyboard.press('/');
        const focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-calendar-search') === true);
        await page.keyboard.type('offsite');
        const results = page.locator('[data-calendar-grid="search"]');
        const hit = results.locator('[data-calendar-event]', { hasText: 'E2E Offsite' }).first();
        await hit.waitFor({ state: 'visible', timeout: 10000 });
        const text = (await results.textContent()) ?? '';
        await shot(page, 'search');
        await hit.click();
        const details = page.locator('[data-calendar-details]');
        await details.waitFor({ state: 'visible' });
        const detailsText = (await details.textContent()) ?? '';
        const show = (await details.locator('[data-calendar-open-page]').textContent()) ?? '';
        await page.keyboard.press('Escape');
        await details.waitFor({ state: 'detached' });
        // Nothing found, said so; Escape in the field clears it, and the week is back.
        await page.locator('[data-calendar-search]').fill('nothing-is-called-this');
        await results.getByText('Nothing matches').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('[data-calendar-search]').press('Escape');
        await results.waitFor({ state: 'detached' });
        const cleared = (await page.locator('[data-calendar-search]').inputValue()) === '' && (await page.locator('[data-calendar-grid="week"]').count()) === 1;
        check('search: / goes to the field, the events found show by day, one opens with a way to it in the calendar, and Escape clears it',
            focused && /1 event found/.test(text) && /E2E Offsite/.test(detailsText) && /Show in calendar/.test(show) && cleared,
            JSON.stringify({ focused, text: text.slice(0, 200), detailsText: detailsText.slice(0, 100), show, cleared }));
    });

    // 9. Accounts.
    await step('Accounts and the Add account choices', async () => {
        await page.locator('[data-calendar-accounts-open]').click();
        await page.locator('[data-calendar-accounts]').waitFor({ state: 'visible' });
        const local = await page.locator('[data-calendar-account="local"]').count();
        await shot(page, 'accounts');
        await page.locator('[data-calendar-add-account]').click();
        await page.locator('[data-calendar-providers]').waitFor({ state: 'visible' });
        const ids = await page.locator('[data-calendar-provider]').evaluateAll((els) => els.map((e) => e.getAttribute('data-calendar-provider')));
        const forms = {};
        const open = async (id, selector) => {
            await page.locator(`[data-calendar-provider="${id}"]`).click();
            forms[id] = await page.locator(selector).first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
            await page.locator('.dshcal-dlg .dshcal-back').click();
            await page.locator('[data-calendar-providers]').waitFor({ state: 'visible' });
        };
        await open('google', '[data-calendar-google-setup] [data-calendar-google-id]');
        await open('microsoft', '[data-calendar-microsoft-setup] [data-calendar-microsoft-id]');
        await open('icloud', '[data-calendar-caldav] [data-calendar-dav-pass][type="password"]');
        await open('nextcloud', '[data-calendar-caldav] [data-calendar-dav-url]');
        await open('other', '[data-calendar-caldav] [data-calendar-dav-url]');
        await open('subscribe', '[data-calendar-subscribe] [data-calendar-sub-url]');
        await page.locator('[data-calendar-provider="local"]').click();
        await page.locator('[data-calendar-local-name]').fill('E2E Trips');
        await page.locator('[data-calendar-local-add]').click();
        const trips = await waitFor(async () => (await api('state')).value?.calendars?.find((c) => c.name === 'E2E Trips'), 'the new calendar', 10000).catch(() => undefined);
        await page.keyboard.press('Escape');
        await page.locator('[data-calendar-accounts-page]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        const want = ['icloud', 'google', 'microsoft', 'fastmail', 'nextcloud', 'yahoo', 'other', 'subscribe', 'local'];
        check('Accounts lists the accounts, and Add account offers each kind with its form (no sign-in tried)', local === 1 && want.every((id) => ids.includes(id))
            && Object.values(forms).every(Boolean) && Object.keys(forms).length === 6 && trips?.kind === 'local',
        JSON.stringify({ local, ids, forms, trips: trips?.name }));
    });

    /** The toast that says these words, as it shows. */
    const toastWith = async (words) => {
        const toast = page.locator('.dshcal-toast', { hasText: words }).first();
        await toast.waitFor({ state: 'visible', timeout: 10000 });
        return (await toast.textContent()) ?? '';
    };
    /** The window's calls to an endpoint while `run` runs: their arguments. */
    const callsTo = async (endpoint, run) => {
        const calls = [];
        const onRequest = (request) => {
            if (request.url().endsWith(`/api/dsh-plugin-calendar/${endpoint}`)) calls.push(JSON.parse(request.postData() ?? '{}').payload?.args);
        };
        page.on('request', onRequest);
        try {
            await run(calls);
        } finally {
            page.off('request', onRequest);
        }
        return calls;
    };
    const openAccounts = async () => {
        await page.locator('[data-calendar-accounts-open]').click();
        await page.locator('[data-calendar-accounts]').waitFor({ state: 'visible' });
    };
    const closeAccounts = async () => {
        await page.keyboard.press('Escape');
        await page.locator('[data-calendar-accounts-page]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    };

    // 10. Microsoft, against its stand-in: its page in a new tab, finished by the pasted address.
    let msAccount;
    let msCalendar;
    await step('Microsoft: sign in on its page, finished by the address', async () => {
        await openAccounts();
        await page.locator('[data-calendar-add-account]').click();
        await page.locator('[data-calendar-provider="microsoft"]').click();
        const setup = page.locator('[data-calendar-microsoft-setup]');
        await setup.waitFor({ state: 'visible' });
        const steps = (await setup.locator('.dshcal-steps').textContent()) ?? '';
        const codeNote = (await setup.locator('[data-calendar-microsoft-code-note]').textContent()) ?? '';
        await shot(page, 'microsoft-setup');
        await page.locator('[data-calendar-microsoft-id]').fill(MS_CLIENT);
        await page.locator('[data-calendar-microsoft-save]').click();
        const start = page.locator('[data-calendar-microsoft-start]');
        await start.waitFor({ state: 'visible' });
        const signIn = page.locator('[data-calendar-microsoft-signin]');
        const method = await signIn.getAttribute('data-calendar-microsoft-signin');
        const label = (await start.textContent())?.trim();

        // Start: Microsoft's page opens in a new tab. It ends on an address that can't come back, as on another computer.
        const [tab] = await Promise.all([page.context().waitForEvent('page', { timeout: 15000 }), start.click()]);
        await tab.waitForLoadState('domcontentloaded');
        const tabUrl = tab.url();
        const asked = new URL(tabUrl);
        const back = ((await tab.locator('#back').textContent()) ?? '').trim();
        await tab.close();
        const paste = page.locator('[data-calendar-microsoft-paste]');
        await paste.waitFor({ state: 'visible' });
        const again = await page.locator('[data-calendar-microsoft-open]').getAttribute('href');
        const waiting = (await signIn.textContent()) ?? '';
        const placeholder = await paste.getAttribute('placeholder');
        const redirect = asked.searchParams.get('redirect_uri') ?? '';
        await shot(page, 'microsoft-waiting');
        const startedRight = method === 'browser' && label === 'Sign in with Microsoft' && asked.pathname === '/login/common/oauth2/v2.0/authorize'
            && asked.searchParams.get('client_id') === MS_CLIENT && /^http:\/\/localhost:\d+$/.test(redirect) && asked.searchParams.get('code_challenge_method') === 'S256'
            && (asked.searchParams.get('code_challenge') ?? '').length >= 43 && asked.searchParams.get('prompt') === 'select_account'
            && (asked.searchParams.get('scope') ?? '').split(' ').includes('Calendars.ReadWrite') && again === tabUrl;
        const waitShown = /Waiting for you to finish on Microsoft's page/.test(waiting) && /Open Microsoft's page again/.test(waiting)
            && waiting.includes(`it starts with ${redirect}`) && placeholder === `${redirect}/?code=…` && back.startsWith(`${redirect}/?code=`)
            && (await page.locator('[data-calendar-microsoft-code]').isVisible());
        await paste.fill(back);
        await page.locator('[data-calendar-microsoft-finish]').click();
        msAccount = await waitFor(async () => (await api('state')).value?.accounts?.find((a) => a.kind === 'microsoft'), 'the Microsoft account', 20000).catch(() => undefined);
        await page.locator(`[data-calendar-account="${msAccount?.id}"]`).waitFor({ state: 'visible', timeout: 10000 });
        msCalendar = await waitFor(async () => (await api('state')).value?.calendars?.find((c) => c.accountId === msAccount?.id), 'its calendar', 20000).catch(() => undefined);
        const traded = providers.seen.grants.includes('authorization_code');
        check('Microsoft signs in on its page in a new tab, with PKCE and http://localhost to come back to; the wait offers the page again and the address to paste, which finishes it',
            startedRight && waitShown && traded && msAccount?.email === providers.graph.store.user.mail && msCalendar?.name === 'Calendar'
            && steps.includes('Mobile and desktop applications') && steps.includes('http://localhost')
            && !steps.includes('Allow public client flows') && /Only to sign in with a code/.test(codeNote) && codeNote.includes('Allow public client flows'),
            JSON.stringify({ method, label, asked: asked.href, again, waiting, placeholder, back, traded, account: msAccount?.email, calendar: msCalendar?.name, steps, codeNote }));
        await closeAccounts();
    });

    // 11. Google, against its stand-in: its page in a new tab, the wait with the address to paste, then the browser back to DSH here.
    let googleAccount;
    let googleCalendar;
    await step('Google: sign in on its page, and the dialog notices by itself', async () => {
        const google = providers.google;
        // Google's page sends the browser straight back: held here first, to see the wait, then let go.
        let back = '';
        const isAuthorize = (url) => url.href.startsWith(google.authorizeUrl);
        await page.context().route(isAuthorize, async (route) => {
            const response = await route.fetch({ maxRedirects: 0 });
            back = response.headers().location ?? '';
            await route.fulfill({
                status: 200, contentType: 'text/html; charset=utf-8',
                body: `<!doctype html><meta charset="utf-8"><title>Sign in</title><p>Signed in. The browser goes back to:</p><p id="back">${back.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</p>`,
            });
        });
        try {
            await openAccounts();
            await page.locator('[data-calendar-add-account]').click();
            await page.locator('[data-calendar-provider="google"]').click();
            await page.locator('[data-calendar-google-id]').fill(google.clientId);
            await page.locator('[data-calendar-google-secret]').fill(google.clientSecret);
            await page.locator('[data-calendar-google-save]').click();
            const start = page.locator('[data-calendar-google-start]');
            await start.waitFor({ state: 'visible' });
            const [tab] = await Promise.all([page.context().waitForEvent('page', { timeout: 15000 }), start.click()]);
            await tab.waitForLoadState('domcontentloaded');
            const tabUrl = tab.url();
            const paste = page.locator('[data-calendar-google-paste]');
            await paste.waitFor({ state: 'visible' });
            const redirect = new URL(tabUrl).searchParams.get('redirect_uri') ?? '';
            const home = redirect.replace(/\/$/, '');
            const again = await page.locator('[data-calendar-google-open]').getAttribute('href');
            const text = (await page.locator('[data-calendar-google-signin]').textContent()) ?? '';
            const placeholder = await paste.getAttribute('placeholder');
            const secretShown = (await page.content()).includes(google.clientSecret);
            await shot(page, 'google-waiting');
            // The browser goes back to DSH on this computer: the dialog notices by itself.
            await tab.goto(back);
            googleAccount = await waitFor(async () => (await api('state')).value?.accounts?.find((a) => a.kind === 'google'), 'the Google account', 20000).catch(() => undefined);
            await tab.close();
            await page.locator(`[data-calendar-account="${googleAccount?.id}"]`).waitFor({ state: 'visible', timeout: 15000 });
            googleCalendar = await waitFor(async () => (await api('state')).value?.calendars?.find((c) => c.accountId === googleAccount?.id && !c.readOnly), 'its calendar', 20000)
                .catch(() => undefined);
            const traded = google.store.tokenRequests.some((r) => r.grantType === 'authorization_code');
            await shot(page, 'google-added');
            check('Google signs in on its page in a new tab; the wait offers the page again and the address to paste; back on this computer the dialog notices by itself, and the client secret is nowhere on the page',
                tabUrl.startsWith(google.authorizeUrl) && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(redirect) && back.startsWith(`${home}/?`) && again === tabUrl
                && placeholder === `${home}/?code=…` && /Waiting for you to finish on Google's page/.test(text) && /Open Google's page again/.test(text)
                && text.includes(`it starts with ${home}`) && !secretShown && traded && googleAccount?.email === 'sam@example.com' && googleCalendar !== undefined,
                JSON.stringify({ tabUrl, back, again, text, placeholder, secretShown, traded, account: googleAccount?.email, calendar: googleCalendar?.name }));
        } finally {
            await page.context().unroute(isAuthorize);
            await closeAccounts();
        }
    });

    // 11b. The title in its room, never cut: at 1280 px with the side column folded and shown, and at 420 px; every view (Day for a
    // week of days); with week numbers on and, as accounts elsewhere are added now, the sync button in the header.
    await step('the title has its room in every view', async () => {
        const side = page.locator('[data-calendar-side]');
        const toggle = page.locator('[data-calendar-side-toggle]');
        const cut = [];
        let measured = 0;
        try {
            await api('setPrefs', { patch: { weekNumbers: true } });
            await page.locator('[data-calendar-view="week"]').click();
            await page.locator('[data-calendar-week-tag]').waitFor({ state: 'visible', timeout: 10000 });
            const sync = await page.locator('[data-calendar-sync]').isVisible();
            for (const [width, folded] of [[1280, true], [1280, false], [420, true]]) {
                await page.setViewportSize({ width, height: width === 420 ? 820 : 800 });
                await page.waitForTimeout(500);
                if (width === 1280 && (await side.isVisible()) === folded) {
                    await toggle.click();
                    await page.waitForTimeout(400);
                }
                for (const view of ['month', 'week', 'day', 'agenda']) {
                    await page.locator(`[data-calendar-view="${view}"]`).click();
                    await page.locator(`[data-calendar-grid="${view}"]`).waitFor({ state: 'visible' });
                    for (let i = 0; i < (view === 'day' ? 7 : 1); i++) {
                        if (i > 0) await page.locator('[data-calendar-next]').click();
                        await page.waitForTimeout(300);
                        const now = await page.evaluate(() => {
                            const title = document.querySelector('[data-calendar-range]');
                            const root = document.querySelector('[data-calendar-page]');
                            return {
                                shown: title.firstElementChild?.textContent ?? '', full: title.querySelector('.dshcal-sr')?.textContent ?? '', tip: title.getAttribute('title'),
                                sw: title.scrollWidth, cw: title.clientWidth, overflow: root.scrollWidth - root.clientWidth,
                            };
                        });
                        measured += 1;
                        if (now.shown === '' || now.sw > now.cw || now.overflow > 1 || (now.shown !== now.full && now.tip !== now.full)) cut.push({ width, folded, view, ...now });
                    }
                    if (view === 'day' || view === 'agenda') await shot(page, `${width === 420 ? 'narrow-' : ''}title-${view}${width === 1280 && !folded ? '-side' : ''}`);
                    if (view === 'day') await page.locator('[data-calendar-today]').click();
                }
            }
            check('the title is never cut, a shorter form where the long one doesn\'t fit (all of it in its tooltip): at 1280 px with the side column folded and shown and at 420 px, in every view, with week numbers on and the sync button there',
                sync && measured === 30 && cut.length === 0, JSON.stringify({ sync, measured, cut }));
        } finally {
            await api('setPrefs', { patch: { weekNumbers: false } });
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.waitForTimeout(400);
            if (!(await side.isVisible())) await toggle.click();
            await page.locator('[data-calendar-view="week"]').click();
        }
    });

    // 12. A Google meeting made, changed and deleted without emailing its guest: Google still shows it on the guest's calendar.
    let reachCall;
    await step('a Google meeting reaches its guest\'s calendar without email, and the toasts say so', async () => {
        const google = providers.google;
        const day = day2;
        await showDay(day);
        const tick = () => page.locator('[data-calendar-event-form] [data-calendar-notify]');
        const hint = () => page.locator('[data-calendar-event-form] [data-calendar-mail="reach"]');

        // Made with the box unticked: the dialog says it still goes on their calendar.
        await page.locator('[data-calendar-side-new]').click();
        let form = page.locator('[data-calendar-event-form="new"]');
        await form.waitFor({ state: 'visible' });
        await form.locator('[data-calendar-title]').fill('E2E Lunch with Ann');
        await form.locator('[data-calendar-start-day]').fill(day);
        await form.locator('[data-calendar-start-time]').fill('12:00');
        await form.locator('[data-calendar-end-time]').fill('12:30');
        await form.locator('[data-calendar-calendar]').selectOption(googleCalendar.id);
        await form.locator('[data-calendar-guest-input]').fill('ann@example.com');
        await form.locator('[data-calendar-guest-input]').press('Enter');
        await hint().waitFor({ state: 'visible' });
        const addHint = (await hint().textContent()) ?? '';
        const unticked = !(await tick().isChecked());
        await tick().check();
        const hiddenWhenTicked = (await hint().count()) === 0;
        await tick().uncheck();
        await hint().waitFor({ state: 'visible' });
        await shot(page, 'google-reach-hint');
        await page.locator('[data-calendar-save]').click();
        // Saved only once the user has seen whose calendars it goes on.
        const addQuestion = await consent();
        await shot(page, 'google-reach-question');
        await addQuestion.answer(true);
        await dialogGone();
        const added = await toastWith('Put on the calendars of');
        const made = (await events(day, day)).find((o) => o.title === 'E2E Lunch with Ann');

        // Changed: once something changes, the dialog says it changes on their calendar too.
        await eventOnPage('E2E Lunch with Ann').click();
        await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
        await page.locator('[data-calendar-edit]').click();
        form = page.locator('[data-calendar-event-form="edit"]');
        await form.waitFor({ state: 'visible' });
        const hintBefore = await hint().count();
        await form.locator('[data-calendar-title]').fill('E2E Lunch with Ann and Bo');
        await hint().waitFor({ state: 'visible' });
        const changeHint = (await hint().textContent()) ?? '';
        await page.locator('[data-calendar-save]').click();
        const changeQuestion = await consent();
        await changeQuestion.answer(true);
        await dialogGone();
        const changed = await toastWith('Changed on the calendars of');

        // Deleted, the box unticked: the dialog says it still goes off their calendar.
        await eventOnPage('E2E Lunch with Ann and Bo').click();
        await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
        await page.locator('[data-calendar-delete]').click();
        const confirm = page.locator('[data-calendar-submit]');
        await confirm.waitFor({ state: 'visible' });
        const deleteDialog = confirm.locator('xpath=ancestor::*[@role="dialog"][1]');
        const deleteHint = (await deleteDialog.locator('[data-calendar-mail="reach"]').textContent()) ?? '';
        const deleteBox = (await deleteDialog.locator('label:has([data-calendar-notify])').textContent()) ?? '';
        await shot(page, 'google-delete-hint');
        await confirm.click();
        const deleteQuestion = await consent();
        await deleteQuestion.answer(true);
        const deleted = await toastWith('Taken off the calendars of');
        const gone = !(await events(day, day)).some((o) => o.title.startsWith('E2E Lunch with Ann'));
        // What Google was told: not to email anyone, each time.
        const writes = google.store.requests.filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method) && /^\/calendar\/v3\/calendars\/[^/]+\/events/.test(r.path));
        const quiet = writes.map((r) => r.method).join(' ') === 'POST PATCH DELETE' && writes.every((r) => r.query.sendUpdates === 'none');
        const asked = [addQuestion, changeQuestion, deleteQuestion].map((q) => [q.title, q.no, q.yes, q.people.join(), q.gets.join()]);
        const want = [
            ['Also put it on ann@example.com\'s Google calendar?', 'Don\'t add', 'Add', 'ann@example.com', 'Added to their calendar, no email'],
            ['Also change it on ann@example.com\'s Google calendar?', 'Don\'t save', 'Save', 'ann@example.com', 'Changed on their calendar, no email'],
            ['Also take it off ann@example.com\'s Google calendar?', 'Don\'t delete', 'Delete', 'ann@example.com', 'Taken off their calendar, no email'],
        ];
        check('a Google meeting made, changed and deleted without email: the dialogs say it still reaches the guest\'s calendar (not when the box is ticked), each is made once the user has seen whose calendar it reaches, and each toast says whose calendars it was put on, changed on and taken off',
            JSON.stringify(asked) === JSON.stringify(want)
            && unticked && addHint === 'Unticked, Google still puts it on the guests\' Google calendars, without an email.' && hiddenWhenTicked
            && made?.calendarId === googleCalendar.id && (made.attendees ?? []).some((a) => a.email === 'ann@example.com')
            && /^Added “E2E Lunch with Ann” on .+\. Put on the calendars of ann@example\.com, without emailing anyone\.$/.test(added)
            && hintBefore === 0 && changeHint === 'Unticked, Google still changes it on the guests\' Google calendars, without an email.'
            && changed === 'Saved. Changed on the calendars of ann@example.com, without emailing anyone.'
            && deleteBox === 'Tell ann@example.com by email' && deleteHint === 'Unticked, Google still removes it from the guests\' Google calendars, without an email.'
            && deleted === 'Deleted “E2E Lunch with Ann and Bo”. Taken off the calendars of ann@example.com, without emailing anyone.' && gone && quiet,
            JSON.stringify({ asked, unticked, addHint, hiddenWhenTicked, made: made && { calendarId: made.calendarId, attendees: made.attendees }, added, hintBefore, changeHint, changed,
                deleteBox, deleteHint, deleted, gone, writes: writes.map((r) => `${r.method} ${r.path} ${r.query.sendUpdates}`) }));

        // An agent deletes a meeting there: askBeforeEmails is off, so a chat takes it off the guest's calendar without asking.
        const lunch = (await createAsked({
            calendarId: googleCalendar.id, title: 'E2E Agent lunch', start: `${day}T14:00`, end: `${day}T14:30`, timeZone: ZONE, attendees: ['ann@example.com'],
        })).value?.occurrence;
        reachCall = await agentCall('calendar_delete_event', { id: lunch?.id }, 'Cancel my lunch with Ann');
        const left = (await events(day, day)).some((o) => o.title === 'E2E Agent lunch');
        const last = google.store.requests.filter((r) => r.method === 'DELETE').at(-1);
        check('with askBeforeEmails off, an agent deletes a meeting on a Google calendar, taking it off its guest\'s, without asking first',
            lunch?.calendarId === googleCalendar.id && !left && last?.query?.sendUpdates === 'none', JSON.stringify({ lunch: lunch?.calendarId, left, last }));
    });

    // 12b. Someone else's invitation: its organizer's fields can't be changed in the dialog; the user's own can.
    await step('someone else\'s invitation: the organizer\'s fields read-only, Show me as the user\'s own', async () => {
        const google = providers.google;
        const day = addDays(today, 2);
        google.store.insert('sam@example.com', {
            summary: 'E2E Vendor review', description: 'Bring the plans.', location: 'Room 4', iCalUID: 'e2e-vendor-review@example.com',
            start: { dateTime: `${day}T15:00:00`, timeZone: ZONE }, end: { dateTime: `${day}T16:00:00`, timeZone: ZONE },
            organizer: { email: 'olga@example.com', displayName: 'Olga Example' },
            attendees: [{ email: 'olga@example.com', organizer: true, responseStatus: 'accepted' }, { email: 'sam@example.com', responseStatus: 'needsAction' }],
        });
        await api('syncNow', { accountId: googleAccount?.id });
        await waitFor(async () => (await events(day, day)).find((o) => o.title === 'E2E Vendor review'), 'the invitation', 15000);
        await showDay(day);
        await eventOnPage('E2E Vendor review').click();
        await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
        await page.locator('[data-calendar-edit]').click();
        const form = page.locator('[data-calendar-event-form="edit"]');
        await form.waitFor({ state: 'visible' });
        const locked = {};
        for (const key of ['title', 'start-day', 'start-time', 'location', 'url', 'notes']) locked[key] = await form.locator(`[data-calendar-${key}]`).isDisabled();
        const own = { busy: await form.locator('[data-calendar-busy]').isEnabled(), private: await form.locator('[data-calendar-private]').isEnabled() };
        const note = (await form.locator('[data-calendar-invitation-note]').textContent()) ?? '';
        await shot(page, 'invitation-dialog');
        const patches = () => google.store.requests.filter((r) => r.method === 'PATCH').length;
        const before = patches();
        await form.locator('[data-calendar-busy]').selectOption('free');
        await page.locator('[data-calendar-save]').click();
        await dialogGone();
        const now = (await events(day, day)).find((o) => o.title === 'E2E Vendor review');
        check('someone else\'s invitation: title, time, place, link and notes can\'t be changed in the dialog, which says why; Show me as and Private can, and saving Free goes to Google',
            Object.values(locked).every(Boolean) && own.busy && own.private && /its organizer sets its title, time, place, link and notes/.test(note)
            && patches() === before + 1 && now?.busy === false && now.title === 'E2E Vendor review' && now.location === 'Room 4',
            JSON.stringify({ locked, own, note, patches: patches() - before, now: now && { busy: now.busy, title: now.title, location: now.location } }));

        // One whose organizer lets guests change it: Google makes a change to it for everyone on it, so Show me as asks first.
        google.store.insert('sam@example.com', {
            summary: 'E2E Design review', iCalUID: 'e2e-design-review@example.com', guestsCanModify: true,
            start: { dateTime: `${day}T17:00:00`, timeZone: ZONE }, end: { dateTime: `${day}T17:30:00`, timeZone: ZONE },
            organizer: { email: 'olga@example.com', displayName: 'Olga Example' },
            attendees: [
                { email: 'olga@example.com', organizer: true, responseStatus: 'accepted' }, { email: 'sam@example.com', responseStatus: 'accepted' },
                { email: 'pat@example.com', responseStatus: 'accepted' },
            ],
        });
        await api('syncNow', { accountId: googleAccount?.id });
        await waitFor(async () => (await events(day, day)).find((o) => o.title === 'E2E Design review'), 'the invitation its guests may change', 15000);
        await showDay(day);
        await eventOnPage('E2E Design review').click();
        await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
        await page.locator('[data-calendar-edit]').click();
        await form.waitFor({ state: 'visible' });
        const first = patches();
        let asked = {};
        const calls = await callsTo('updateEvent', async () => {
            await form.locator('[data-calendar-busy]').selectOption('free');
            await page.locator('[data-calendar-save]').click();
            const question = await consent();
            await shot(page, 'invitation-question');
            asked = { ...question, answer: undefined, sentBefore: patches() - first };
            await question.answer(true);
            await dialogGone();
        });
        const design = (await events(day, day)).find((o) => o.title === 'E2E Design review');
        check('someone else\'s meeting whose guests may change it: Show me as asks first, naming its organizer and the other guest, and is saved on yes as the same change',
            asked.title === 'Also change it on 2 people\'s Google calendars?' && asked.text?.includes('Its organizer lets guests change it')
            && JSON.stringify([...(asked.people ?? [])].sort()) === JSON.stringify(['olga@example.com', 'pat@example.com'])
            && asked.gets?.length === 2 && asked.gets.every((g) => g === 'Changed on their calendar, no email') && asked.no === 'Don\'t save' && asked.yes === 'Save'
            && asked.sentBefore === 0 && patches() === first + 1 && design?.busy === false
            && calls.length === 2 && sameChange(calls[0], calls[1]) && JSON.stringify([...(calls[1]?.patch?.approved ?? [])].sort()) === JSON.stringify(['olga@example.com', 'pat@example.com']),
            JSON.stringify({ asked, patches: patches() - first, busy: design?.busy, calls }));
    });

    // 12c. A move that made its copy but couldn't take the event out of its old calendar: said until closed, never made again.
    await step('a move that stopped halfway', async () => {
        const google = providers.google;
        const day = addDays(today, 5);
        const made = (await api('createEvent', { input: { calendarId: googleCalendar.id, title: 'E2E Halfway', start: `${day}T10:00`, end: `${day}T10:30`, timeZone: ZONE } })).value?.occurrence;
        // Google won't take it out: the copy is made in the side calendar, and the event stays where it was too.
        google.store.failNext({ method: 'DELETE', status: 403, reason: 'forbidden', message: 'The stand-in keeps this one.' });
        let notice = '';
        let buttons = [];
        let stays = 0;
        const calls = await callsTo('updateEvent', async () => {
            await showDay(day);
            await eventOnPage('E2E Halfway').click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-edit]').click();
            const form = page.locator('[data-calendar-event-form="edit"]');
            await form.waitFor({ state: 'visible' });
            await form.locator('[data-calendar-calendar]').selectOption(side.id);
            await page.locator('[data-calendar-save]').click();
            await dialogGone();
            const kept = page.locator('[data-calendar-kept-notice]');
            await kept.waitFor({ state: 'visible', timeout: 10000 });
            notice = (await kept.textContent()) ?? '';
            buttons = await kept.locator('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') || el.textContent));
            await shot(page, 'half-moved');
            // Still there after a toast would have gone, and nothing tried again.
            await sleep(8000);
            stays = await kept.count();
        });
        const copies = (await events(day, day)).filter((o) => o.title === 'E2E Halfway').map((o) => o.calendarId).sort();
        await page.locator('[data-calendar-kept-notice] button').click();
        await page.locator('[data-calendar-kept-notice]').waitFor({ state: 'detached' });
        check('a move that made its copy but couldn\'t take the event out of its old calendar: the dialog closes, a notice says what was done and what is left to do until it is closed, and the move isn\'t made again',
            made?.calendarId === googleCalendar.id && calls.length === 1 && stays === 1
            && notice.includes(`It was copied to E2E Side, but not taken out of ${googleCalendar.name}`) && notice.includes('moving it again would make a second copy')
            && JSON.stringify(buttons) === JSON.stringify(['Close this notice']) && JSON.stringify(copies) === JSON.stringify([googleCalendar.id, side.id].sort()),
            JSON.stringify({ made: made?.calendarId, calls: calls.length, notice, buttons, stays, copies }));
        // The one left in Google goes, for the steps after this one.
        const left = (await events(day, day)).find((o) => o.title === 'E2E Halfway' && o.calendarId === googleCalendar.id);
        if (left) await api('deleteEvent', { id: left.id, scope: 'all' });
    });

    // 13. A series with an occurrence changed on its own, moved to Microsoft, which would drop that occurrence: asked first.
    await step('a series that would lose part of itself on a move asks first', async () => {
        const day = addDays(today, 3);
        const byDay = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${day}T12:00:00Z`).getUTCDay()];
        const series = (await api('createEvent', {
            input: { calendarId: defaultCalendar, title: 'E2E Standup', start: `${day}T08:00`, end: `${day}T08:15`, timeZone: ZONE, repeat: `FREQ=WEEKLY;BYDAY=${byDay};COUNT=4` },
        })).value?.occurrence;
        const changedOne = await api('updateEvent', { id: `${series?.eventId}.${compact(addDays(day, 7), '08:00')}`, patch: { title: 'E2E Standup (longer)' }, scope: 'one' });
        let question = '';
        let kept = {};
        const calls = await callsTo('updateEvent', async () => {
            await showDay(day);
            await page.locator(`[data-calendar-main] [data-calendar-event="${series?.eventId}.${compact(day, '08:00')}"]`).click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-edit]').click();
            const form = page.locator('[data-calendar-event-form="edit"]');
            await form.waitFor({ state: 'visible' });
            await form.locator('[data-calendar-calendar]').selectOption(msCalendar.id);
            await page.locator('[data-calendar-save]').click();
            const anyway = page.locator('[data-calendar-move-anyway]');
            await anyway.waitFor({ state: 'visible' });
            question = (await anyway.locator('xpath=ancestor::*[@role="dialog"][1]').textContent()) ?? '';
            await shot(page, 'drops-question');
            // Don't move it: nothing moves, and the dialog stays.
            await page.locator('[data-calendar-dont-move]').click();
            await anyway.waitFor({ state: 'detached' });
            kept = { open: await form.isVisible(), calendarId: (await events(day, day)).find((o) => o.title === 'E2E Standup')?.calendarId };
            // Move anyway: the same move, told to drop what can't go.
            await page.locator('[data-calendar-save]').click();
            await anyway.waitFor({ state: 'visible' });
            await anyway.click();
            await dialogGone();
        });
        const after = (await events(day, addDays(day, 21))).filter((o) => o.title.startsWith('E2E Standup'));
        const posted = providers.graph.store.requestsTo('/v1.0/me/calendars/e2e-ms-cal/events', 'POST').map((r) => r.body);
        const patches = calls.map((c) => JSON.stringify(c?.patch));
        const to = JSON.stringify(msCalendar.id);
        check('a series with an occurrence changed on its own, moved to Microsoft: asked first in the host\'s words; Don\'t move it keeps it; Move anyway moves it without that occurrence',
            changedOne.ok && question.includes('Moving this series to Calendar would drop 1 occurrence changed on its own') && /Move anyway/.test(question)
            && kept.open && kept.calendarId === defaultCalendar && after.length === 4 && after.every((o) => o.calendarId === msCalendar.id && o.title === 'E2E Standup')
            && posted.some((b) => b?.subject === 'E2E Standup' && b.recurrence?.pattern?.type === 'weekly')
            && patches.length === 3 && patches[0] === `{"calendarId":${to}}` && patches[1] === patches[0] && patches[2] === `{"calendarId":${to},"dropChanges":true}`,
            JSON.stringify({ changedOne: changedOne.ok, question, kept, after: after.map((o) => [o.title, o.calendarId]), posted: posted.length, patches }));
    });

    /** The event form's end in view, as after changing something there: its dialog's content scrolled to the bottom. → how far it scrolled. */
    const toFormEnd = (form) => form.evaluate((el) => {
        let box = el.parentElement;
        while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
        if (box) box.scrollTop = box.scrollHeight;
        return box ? box.scrollTop : 0;
    });
    /**
     * The event dialog's refusal, once it has the focus: its words, and whether it and its Look at it again are whole inside
     * the window and inside the dialog's scrolling box (Playwright counts an element scrolled out of its box as visible).
     */
    const refusalShown = async () => {
        const focused = await page.waitForFunction(() => document.querySelector('[data-calendar-refusal]')?.contains(document.activeElement), null, { timeout: 15000 })
            .then(() => true, () => false);
        return page.locator('[data-calendar-refusal]').evaluate((el, focus) => {
            let box = el.parentElement;
            while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
            const frame = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
            const whole = (node) => {
                const r = node.getBoundingClientRect();
                return r.height > 0 && r.top >= Math.max(0, frame.top) - 1 && r.bottom <= Math.min(window.innerHeight, frame.bottom) + 1;
            };
            const look = el.querySelector('[data-calendar-look-again]');
            return {
                text: el.querySelector('.dshcal-alert')?.textContent ?? '', note: whole(el), look: look ? whole(look) : null, lookText: look?.textContent ?? '',
                focus, scrolled: box ? box.scrollTop : null, viewport: [window.innerWidth, window.innerHeight],
            };
        }, focused);
    };
    /** Graph's reads of its calendar view (the delta query): DSH syncing it. */
    const graphSyncs = () => providers.graph.store.requests.filter((r) => r.method === 'GET' && r.path.includes('/delta')).length;

    // 14. A Microsoft meeting that changes on Microsoft's side while the question before its email waits, without DSH
    // reading it: its yes makes nothing (Graph refuses the change made on the meeting as DSH had it, 412), and the question
    // comes again naming everyone it reaches now.
    await step('a change held to the people it named: the meeting changed meanwhile, so it asks again', async () => {
        const graph = providers.graph;
        const day = addDays(today, 4);
        const person = (address, name) => ({ emailAddress: { address, name }, type: 'required' });
        const synced = graphSyncs();
        const made = await createAsked({
            calendarId: msCalendar.id, title: 'E2E Review', start: `${day}T11:00`, end: `${day}T11:30`, timeZone: ZONE,
            attendees: [{ email: 'ann@example.com', name: 'Ann Example' }], notify: true,
        });
        const graphId = [...graph.store.events.values()].find((e) => e.subject === 'E2E Review')?.id;
        // DSH reads the calendar once soon after making it; nothing tells it of what changes there after that.
        await waitFor(() => graphSyncs() > synced, 'the read after it was made', 15000);
        const patches = () => graph.store.requestsTo(`/v1.0/me/events/${graphId}`, 'PATCH');
        let first = {};
        let again = {};
        let third = {};
        let refused = {};
        let place = {};
        let endScroll = 0;
        let still = '';
        let toast = '';
        const calls = await callsTo('updateEvent', async () => {
            await showDay(day);
            await eventOnPage('E2E Review').click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-edit]').click();
            const form = page.locator('[data-calendar-event-form="edit"]');
            await form.waitFor({ state: 'visible' });
            await form.locator('[data-calendar-title]').fill('E2E Review (agenda)');
            // Saved from the end of the form, its top out of view.
            endScroll = await toFormEnd(form);
            await page.locator('[data-calendar-save]').click();
            first = await consent();
            // Meanwhile Bob is added on Microsoft's side, which DSH doesn't read.
            const held = graph.store.json(graphId)?.['@odata.etag'];
            graph.store.updateEvent(graphId, { attendees: [person('ann@example.com', 'Ann Example'), person('bob@example.com', 'Bob Example')] });
            const before = patches().length;
            await first.answer(true);
            // Asked again, naming both, Bob as new: the one change sent went with the meeting's old etag, and Microsoft refused it.
            again = await consent();
            await shot(page, 'changed-meanwhile');
            const sent = patches().slice(before);
            refused = { count: sent.length, status: sent[0]?.status, stale: sent[0]?.ifMatch !== undefined && sent[0].ifMatch === held, title: graph.store.json(graphId)?.subject };
            await again.answer(false);
            // Not saved, said at the top of the dialog, in view and with the focus, and the way to look at it again with it.
            place = await refusalShown();
            await shot(page, 'event-dialog-changed-top');
            still = (await events(day, day)).find((o) => o.title.startsWith('E2E Review'))?.title ?? '';
            // Saved again: asked about both, and made, held to both.
            await page.locator('[data-calendar-save]').click();
            third = await consent();
            await third.answer(true);
            await dialogGone();
            toast = await toastWith('Emailed');
        });
        const now = (await events(day, day)).find((o) => o.title.startsWith('E2E Review'));
        const names = (q) => JSON.stringify(q.people);
        check('a Microsoft meeting that gained a guest while the question waited, unread by DSH: its yes makes nothing (Microsoft refuses the change sent with the meeting\'s old etag) and asks again, naming both with the new one marked; Don\'t save says so at the top of the dialog, in view with the focus, with a way to look again; saved again, it goes to both',
            made.ok && first.title === 'Email an update to ann@example.com?' && names(first) === '["ann@example.com"]' && first.yes === 'Save and email'
            && again.title === 'Email an update to 2 guests?' && names(again) === '["ann@example.com","bob@example.com"]' && JSON.stringify(again.fresh) === '["bob@example.com"]'
            && again.text.includes('It changed meanwhile') && refused.count === 1 && refused.status === 412 && refused.stale && refused.title === 'E2E Review'
            && /^Not saved: it changed meanwhile/.test(place.text) && place.lookText === 'Look at it again' && endScroll > 0 && place.note && place.look && place.focus
            && still === 'E2E Review'
            && names(third) === '["ann@example.com","bob@example.com"]' && third.fresh.length === 0
            && calls.length === 4 && calls[0]?.patch?.notify === undefined && calls[0]?.patch?.approved === undefined
            && calls[1]?.patch?.notify === true && JSON.stringify(calls[1]?.patch?.approved) === '["ann@example.com"]'
            && calls[2]?.patch?.notify === undefined && calls[2]?.patch?.approved === undefined
            && calls[3]?.patch?.notify === true && JSON.stringify(calls[3]?.patch?.approved) === '["ann@example.com","bob@example.com"]'
            && now?.title === 'E2E Review (agenda)' && /Emailed an update to ann@example\.com and bob@example\.com\./.test(toast),
            JSON.stringify({ made: made.ok, first: first.title, again: { title: again.title, people: again.people, fresh: again.fresh }, third: third.people, refused,
                calls: calls.map((c) => c?.patch), endScroll, place, still, now: now?.title, toast }));
    });

    // 14b. The meeting changed on Microsoft's side meanwhile in a way that reaches nobody new: nothing is made, the dialog says
    // so at its top, and Look at it again shows the event as it is now.
    await step('a change stopped because the meeting changed meanwhile, with nobody new to ask about', async () => {
        const graph = providers.graph;
        const day = addDays(today, 4);
        const synced = graphSyncs();
        const made = await createAsked({
            calendarId: msCalendar.id, title: 'E2E Retro', start: `${day}T14:00`, end: `${day}T14:30`, timeZone: ZONE,
            attendees: [{ email: 'ann@example.com', name: 'Ann Example' }], notify: true,
        });
        const graphId = [...graph.store.events.values()].find((e) => e.subject === 'E2E Retro')?.id;
        await waitFor(() => graphSyncs() > synced, 'the read after it was made', 15000);
        const patches = () => graph.store.requestsTo(`/v1.0/me/events/${graphId}`, 'PATCH');
        let question = {};
        let sent = [];
        let place = {};
        let endScroll = 0;
        let details = '';
        const calls = await callsTo('updateEvent', async () => {
            await showDay(day);
            await eventOnPage('E2E Retro').click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-edit]').click();
            const form = page.locator('[data-calendar-event-form="edit"]');
            await form.waitFor({ state: 'visible' });
            await form.locator('[data-calendar-location]').fill('Room 4');
            endScroll = await toFormEnd(form);
            await page.locator('[data-calendar-save]').click();
            question = await consent();
            // Meanwhile its notes change on Microsoft's side: the same guest, nobody new.
            graph.store.updateEvent(graphId, { body: { contentType: 'text', content: 'Bring the plans.' } });
            const before = patches().length;
            await question.answer(true);
            place = await refusalShown();
            sent = patches().slice(before).map((r) => r.status);
            await shot(page, 'event-dialog-nobody-new');
            await page.locator('[data-calendar-look-again]').click();
            await dialogGone();
            const shown = page.locator('[data-calendar-details]');
            await shown.waitFor({ state: 'visible', timeout: 10000 });
            await waitFor(async () => /Bring the plans/.test((await shown.textContent()) ?? ''), 'the event as it is now', 10000).catch(() => {});
            details = (await shown.textContent()) ?? '';
            await page.keyboard.press('Escape');
            await shown.waitFor({ state: 'detached' });
        });
        const now = (await events(day, day)).find((o) => o.title === 'E2E Retro');
        check('a Microsoft meeting changed meanwhile so that its change reaches nobody new: its yes makes nothing, the dialog says so at its top, in view with the focus, with Look at it again, which shows the event as it is now',
            made.ok && question.title === 'Email an update to ann@example.com?' && JSON.stringify(sent) === '[412]'
            && place.text === 'The event changed on its server meanwhile (in another app, or by someone else), so nothing was done. Look at it again first.'
            && place.lookText === 'Look at it again' && endScroll > 0 && place.note && place.look && place.focus
            && calls.length === 2 && calls[1]?.patch?.notify === true && JSON.stringify(calls[1]?.patch?.approved) === '["ann@example.com"]'
            && /Bring the plans/.test(details) && !details.includes('Room 4') && now?.location !== 'Room 4' && (now?.description ?? '').includes('Bring the plans'),
            JSON.stringify({ made: made.ok, question: question.title, sent, endScroll, place, calls: calls.map((c) => c?.patch), details: details.slice(0, 300),
                now: now && { location: now.location, description: now.description } }));
    });

    // 14c. A save that fails for another reason (Microsoft answers 500): said at the top of the dialog, in view and with the
    // focus, at 1280 px and at 420 px. Then the edited dialog asks before it drops the changes; unchanged, it closes at once.
    await step('a save that didn\'t work, and an edited event that asks before it is dropped', async () => {
        const graph = providers.graph;
        const day = addDays(today, 4);
        await api('createEvent', { input: { calendarId: msCalendar.id, title: 'E2E Dentist', start: `${day}T16:00`, end: `${day}T16:30`, timeZone: ZONE } });
        const graphId = [...graph.store.events.values()].find((e) => e.subject === 'E2E Dentist')?.id;
        const path = `/v1.0/me/events/${graphId}`;
        const form = page.locator('[data-calendar-event-form="edit"]');
        const discard = page.locator('[data-calendar-discard]');
        const open = async () => {
            await showDay(day);
            await eventOnPage('E2E Dentist').click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-edit]').click();
            await form.waitFor({ state: 'visible' });
        };
        // Unchanged: Escape closes it at once.
        await open();
        await page.keyboard.press('Escape');
        await dialogGone();
        const askedUnchanged = await discard.count();
        // Show me as changed at the end of the form, and Microsoft answers 500.
        await open();
        await form.locator('[data-calendar-busy]').selectOption('free');
        const endScroll = await toFormEnd(form);
        graph.store.failNext({ method: 'PATCH', path, status: 500 });
        await page.locator('[data-calendar-save]').click();
        const wide = await refusalShown();
        await shot(page, 'event-dialog-failed');
        // At 420 px, from the end of the form again.
        let narrow = {};
        let narrowEnd = 0;
        await page.setViewportSize({ width: 420, height: 820 });
        try {
            await page.waitForTimeout(600);
            narrowEnd = await toFormEnd(form);
            graph.store.failNext({ method: 'PATCH', path, status: 500 });
            await page.locator('[data-calendar-save]').click();
            narrow = await refusalShown();
            await shot(page, 'narrow-event-dialog-failed');
        } finally {
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.waitForTimeout(600);
        }
        const tries = graph.store.requestsTo(path, 'PATCH').map((r) => r.status);
        // Escape asks first, Keep editing has the focus; Escape there keeps editing.
        await page.keyboard.press('Escape');
        await discard.waitFor({ state: 'visible', timeout: 5000 });
        const question = await discard.locator('xpath=ancestor::*[@role="dialog"][1]').evaluate((el) => ({
            title: el.getAttribute('aria-label'),
            buttons: [...el.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
            focus: el.ownerDocument.activeElement?.hasAttribute('data-calendar-keep-editing') === true,
        }));
        await shot(page, 'discard-question');
        await page.keyboard.press('Escape');
        await discard.waitFor({ state: 'detached' });
        const keptByEscape = { open: await form.isVisible(), busy: await form.locator('[data-calendar-busy]').inputValue() };
        // Cancel asks too; Enter on Keep editing keeps it.
        await page.locator('[data-calendar-cancel]').click();
        await discard.waitFor({ state: 'visible', timeout: 5000 });
        await page.keyboard.press('Enter');
        await discard.waitFor({ state: 'detached' });
        const keptByEnter = { open: await form.isVisible(), busy: await form.locator('[data-calendar-busy]').inputValue() };
        // So does the close button; Discard closes the dialog, nothing saved.
        await form.locator('xpath=ancestor::*[@role="dialog"][1]').getByRole('button', { name: 'Close', exact: true }).click();
        await discard.waitFor({ state: 'visible', timeout: 5000 });
        await discard.click();
        await dialogGone();
        const now = (await events(day, day)).find((o) => o.title === 'E2E Dentist');
        check('a save that didn\'t work says why at the top of the dialog, in view with the focus, at 1280 px and at 420 px',
            /^Saving the event on Microsoft: the server answered HTTP 500\b/.test(wide.text) && endScroll > 0 && wide.note && wide.focus && wide.look === null
            && narrow.text === wide.text && narrowEnd > 0 && narrow.note && narrow.focus && JSON.stringify(narrow.viewport) === '[420,820]'
            && JSON.stringify(tries) === '[500,500]', JSON.stringify({ endScroll, wide, narrowEnd, narrow, tries }));
        check('an edited event asks before Escape, Cancel or the close button drops it: Keep editing first, keeping the edits; Discard closes it unsaved; unchanged, it closes at once',
            askedUnchanged === 0 && question.title === 'Discard your changes?' && JSON.stringify(question.buttons) === '["Keep editing","Discard"]' && question.focus
            && keptByEscape.open && keptByEscape.busy === 'free' && keptByEnter.open && keptByEnter.busy === 'free'
            && now?.busy !== false && graph.store.json(graphId)?.showAs !== 'free' && graph.store.requestsTo(path, 'PATCH').length === 2,
            JSON.stringify({ askedUnchanged, question, keptByEscape, keptByEnter, busy: now?.busy, showAs: graph.store.json(graphId)?.showAs }));
    });

    // 14d. A host whose every yes comes back naming someone new (the event keeps changing): asked four times, then it stops,
    // saying why at the top of the dialog with Look at it again. The host's answers are played here.
    await step('a change that comes back naming someone new after every yes stops after five calls, saying why', async () => {
        const day = addDays(today, 3);
        const made = (await api('createEvent', { input: { calendarId: defaultCalendar, title: 'E2E Busy room', start: `${day}T13:00`, end: `${day}T13:30`, timeZone: ZONE } })).value?.occurrence;
        const people = ['p1@example.com', 'p2@example.com', 'p3@example.com', 'p4@example.com', 'p5@example.com', 'p6@example.com'];
        const sent = [];
        await page.route(updateCalls, async (route) => {
            const body = JSON.parse(route.request().postData() ?? '{}');
            sent.push(body.payload?.args ?? {});
            const named = people.slice(0, sent.length);
            const mail = { emailed: { what: 'an update', to: named } };
            const error = sent.length === 1
                ? { code: 'calendar/needs-approval', message: `This would email an update to ${named[0]}, so it's made only once you've seen who.`, details: { people: named, mail } }
                : { code: 'calendar/changed', message: `The event changed since this change was looked at (on its server, or in another app): it would now also email an update to ${named.at(-1)}, so nothing was done. Look at it again first.`, details: { people: named, mail } };
            // A host takes a moment: each question goes before the next one comes.
            await sleep(300);
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error } }) });
        });
        const asked = [];
        let place = {};
        let open = -1;
        let details = '';
        try {
            await showDay(day);
            await eventOnPage('E2E Busy room').click();
            await page.locator('[data-calendar-details]').waitFor({ state: 'visible' });
            await page.locator('[data-calendar-edit]').click();
            const form = page.locator('[data-calendar-event-form="edit"]');
            await form.waitFor({ state: 'visible' });
            await form.locator('[data-calendar-title]').fill('E2E Busy room (moved)');
            await toFormEnd(form);
            await page.locator('[data-calendar-save]').click();
            for (let i = 0; i < 4; i++) {
                const question = await consent();
                asked.push([question.people.length, question.fresh.length]);
                await question.answer(true);
            }
            place = await refusalShown();
            open = await page.locator('[data-calendar-send]').count();
            await shot(page, 'event-dialog-cap');
            await page.locator('[data-calendar-look-again]').click();
            await dialogGone();
            const shown = page.locator('[data-calendar-details]');
            await shown.waitFor({ state: 'visible', timeout: 10000 });
            details = (await shown.textContent()) ?? '';
            await page.keyboard.press('Escape');
            await shown.waitFor({ state: 'detached' });
        } finally {
            await page.unroute(updateCalls);
        }
        const now = (await events(day, day)).find((o) => o.title.startsWith('E2E Busy room'));
        check('a change whose every yes comes back naming someone new is asked about four times, then stops after the fifth call, saying it keeps changing at the top of the dialog, in view with the focus, with Look at it again',
            sent.length === 5 && JSON.stringify(asked) === '[[1,0],[2,1],[3,1],[4,1]]' && open === 0
            && JSON.stringify(sent.map((a) => a.patch?.approved ?? null)) === JSON.stringify([null, ...[1, 2, 3, 4].map((n) => people.slice(0, n))])
            && place.text === 'Not saved: it keeps changing on its server or in another app. Look at it again to see it as it is now.'
            && place.lookText === 'Look at it again' && place.note && place.look && place.focus
            && /E2E Busy room/.test(details) && now?.title === 'E2E Busy room',
            JSON.stringify({ sent: sent.map((a) => a.patch), asked, open, place, details: details.slice(0, 120), now: now?.title }));
        if (made) await api('deleteEvent', { id: made.id, scope: 'all' });
    });

    // 14e. The meeting from 14, changed by an agent that didn't say to tell its guests: Microsoft would email them, so it
    // isn't changed (its row is read with the other chat rows, below).
    let emailRefused;
    await step('an agent\'s change that would email a meeting\'s guests, not told to', async () => {
        const day = addDays(today, 4);
        const review = (await events(day, day)).find((o) => o.title.startsWith('E2E Review'));
        emailRefused = await agentCall('calendar_update_event', { id: review?.id, location: 'Room 4' }, 'Put the review in room 4');
        // The fake model names every session after its tool, so this one gets its own name to be found by (once DSH
        // has named it).
        const titled = async (want) => {
            const title = (await bridge('GET', '/sessions')).find((s) => s.sessionId === emailRefused.sessionId)?.projections?.values?.title;
            return want === undefined ? title : title === want;
        };
        await waitFor(() => titled(), 'the session\'s title', 30000);
        await bridge('POST', `/sessions/${emailRefused.sessionId}/rename`, { title: 'E2E room 4 refused' });
        await waitFor(() => titled('E2E room 4 refused'), 'the session\'s new title', 15000);
        const after = (await events(day, day)).find((o) => o.title.startsWith('E2E Review'));
        check('an agent\'s change to a Microsoft meeting that didn\'t say to tell its guests isn\'t made', review !== undefined && after !== undefined && after.location !== 'Room 4',
            JSON.stringify({ review: review?.title, location: after?.location }));
    });

    // 15. The Microsoft account removed, with the page to withdraw DSH's access there; then a sign-in with a code instead.
    await step('Microsoft: the account removed, and a code instead', async () => {
        await openAccounts();
        await page.locator(`[data-calendar-account-menu="${msAccount?.id}"]`).click();
        await page.locator('.dshcal-menu').getByText('Remove…', { exact: true }).click();
        const confirm = page.locator('[data-calendar-submit]');
        await confirm.waitFor({ state: 'visible' });
        const question = (await confirm.locator('xpath=ancestor::*[@role="dialog"][1]').textContent()) ?? '';
        await confirm.click();
        const notice = page.locator('[data-calendar-removed]');
        await notice.waitFor({ state: 'visible', timeout: 10000 });
        const noticeText = (await notice.textContent()) ?? '';
        const manage = await notice.locator('a').getAttribute('href');
        const gone = !((await api('state')).value?.accounts ?? []).some((a) => a.kind === 'microsoft');
        await shot(page, 'microsoft-removed');
        check('a removed Microsoft account leaves, and a notice links the page where DSH\'s access is withdrawn',
            gone && manage === 'https://account.live.com/consent/Manage' && /Microsoft doesn't let an app withdraw its own access/.test(noticeText)
            && /with the copy DSH keeps of them/.test(question), JSON.stringify({ gone, manage, noticeText, question }));
        await notice.getByRole('button', { name: 'Close this notice' }).click();
        await notice.waitFor({ state: 'detached' });

        // A code instead: no new tab, the code to enter, and the way back to the browser.
        await page.locator('[data-calendar-add-account]').click();
        await page.locator('[data-calendar-provider="microsoft"]').click();
        const tabs = page.context().pages().length;
        await page.locator('[data-calendar-microsoft-code]').click();
        const code = page.locator('[data-calendar-user-code]');
        await code.waitFor({ state: 'visible', timeout: 10000 });
        const codeText = (await code.textContent()) ?? '';
        const enterAt = await page.locator('[data-calendar-verification]').getAttribute('href');
        const browserWay = await page.locator('[data-calendar-microsoft-browser]').isVisible();
        const codeMethod = await page.locator('[data-calendar-microsoft-signin]').getAttribute('data-calendar-microsoft-signin');
        await shot(page, 'microsoft-code');
        check('"Sign in with a code instead" starts a sign-in with a code: the code, where to enter it, and the way back to the page in the browser',
            /^[0-9A-F]{9}$/.test(codeText) && enterAt === 'https://microsoft.com/devicelogin' && browserWay && codeMethod === 'code' && providers.seen.devicecodes === 1
            && page.context().pages().length === tabs, JSON.stringify({ codeText, enterAt, browserWay, codeMethod, devicecodes: providers.seen.devicecodes }));
        await closeAccounts();
    });

    // 16. The Google account removed: DSH's access withdrawn at Google.
    await step('Google: the account removed, its access withdrawn there', async () => {
        await openAccounts();
        await page.locator(`[data-calendar-account-menu="${googleAccount?.id}"]`).click();
        await page.locator('.dshcal-menu').getByText('Remove…', { exact: true }).click();
        const confirm = page.locator('[data-calendar-submit]');
        await confirm.waitFor({ state: 'visible' });
        await confirm.click();
        const toast = await toastWith('withdrawn at Google');
        const gone = await waitFor(async () => !((await api('state')).value?.accounts ?? []).some((a) => a.kind === 'google'), 'the Google account to leave', 10000).catch(() => false);
        const notice = await page.locator('[data-calendar-removed]').count();
        check('a removed Google account leaves, and the toast says DSH\'s access was withdrawn at Google (no page to go to)',
            gone && toast === `Removed ${googleAccount?.name}. DSH's access was withdrawn at Google.` && providers.seen.revoked === 1 && notice === 0,
            JSON.stringify({ gone, toast, revoked: providers.seen.revoked, notice }));
        await closeAccounts();
    });

    // 17. Chat cards, and the page opened at an event from one.
    /** A session's title in DSH's list (DSH names a session once its first turn is done). */
    const titleOf = (sessionId) => waitFor(async () => (await bridge('GET', '/sessions')).find((s) => s.sessionId === sessionId)?.projections?.values?.title,
        'the session\'s title', 30000);
    const openSession = async (title) => {
        const row = page.getByText(title, { exact: false }).first();
        // An older session can be folded under "Show N more sessions" in DSH's sidebar.
        if (!(await row.isVisible().catch(() => false))) {
            const more = page.getByText(/^Show \d+ more sessions?$/).first();
            if (await more.count()) await more.click().catch(() => {});
        }
        await row.click();
        await page.waitForTimeout(1500);
        for (const words of [/^Completed in/, /^Called tools?$/]) {
            const group = page.getByText(words);
            if (await group.count()) {
                await group.first().click().catch(() => {});
                await page.waitForTimeout(400);
            }
        }
    };
    await step('chat cards for the calendar tools', async () => {
        const listTitle = await titleOf(listCall.sessionId);
        const createTitle = await titleOf(createCall.sessionId);
        await openSession(listTitle);
        const listCard = page.locator('.dshcal-chat[data-calendar-chat="calendar_events"][data-phase="result"]').first();
        await listCard.waitFor({ state: 'attached', timeout: 10000 });
        const listText = await listCard.textContent();
        const hasDays = await listCard.locator('[data-calendar-chat-card="events"] .dshcal-chat-day').count();
        if (shots) await listCard.screenshot({ path: join(shots, 'chat-events.png') }).catch(() => {});
        await openSession(createTitle);
        const createCard = page.locator('.dshcal-chat[data-calendar-chat="calendar_create_event"][data-phase="result"]').first();
        await createCard.waitFor({ state: 'attached', timeout: 10000 });
        const createText = await createCard.textContent();
        if (shots) await createCard.screenshot({ path: join(shots, 'chat-created.png') }).catch(() => {});
        await createCard.locator('[data-calendar-open-event]').click();
        const details = page.locator('[data-calendar-details]');
        await details.waitFor({ state: 'visible', timeout: 10000 });
        const detailsText = await details.textContent();
        check('chat cards: events by day for calendar_events, a confirmation for calendar_create_event whose button opens it on the page',
            /E2E Side event/.test(listText ?? '') && hasDays >= 1 && /Added “E2E From agent”/.test(createText ?? '') && /E2E From agent/.test(detailsText ?? ''),
            JSON.stringify({ listText: listText?.slice(0, 200), hasDays, createText: createText?.slice(0, 200), detailsText: detailsText?.slice(0, 120) }));
        await page.keyboard.press('Escape');
    });
    // The glass contract for what the plugin draws in a chat: a faint fill of its own, no blur (the conversation behind
    // it is DSH's or the wallpaper's to blur), in light and dark.
    /** A computed colour's alpha: 1 for rgb(), 0 for transparent. */
    const alphaOf = (color) => {
        if (color === 'transparent') return 0;
        const m = /^rgba?\(([^)]*)\)$/.exec(String(color));
        const parts = m ? m[1].split(/[,\s/]+/).filter(Boolean) : [];
        return parts.length >= 4 ? Number(parts[3]) : parts.length === 3 ? 1 : NaN;
    };
    await step('chat cards on glass: a faint fill and no blur, in light and dark', async () => {
        await openSession(await titleOf(listCall.sessionId));
        const card = page.locator('.dshcal-chat[data-calendar-chat="calendar_events"][data-phase="result"] .dshcal-chat-card').first();
        await card.waitFor({ state: 'attached', timeout: 10000 });
        const look = () => card.evaluate((el) => {
            const css = getComputedStyle(el);
            const row = getComputedStyle(el.closest('.dshcal-chat'));
            return { fill: css.backgroundColor, blur: css.backdropFilter, row: row.backgroundColor, rowBlur: row.backdropFilter };
        });
        const light = await look();
        await setDark(page, true);
        const dark = await look();
        if (shots) await card.screenshot({ path: join(shots, 'chat-events-dark.png') }).catch(() => {});
        await setDark(page, false);
        const faint = (c) => alphaOf(c.fill) > 0 && alphaOf(c.fill) <= 0.06 && c.blur === 'none' && alphaOf(c.row) === 0 && c.rowBlur === 'none';
        check('a chat card has a faint fill of its own (4 % in dark) and no blur, its row no background, in light and dark',
            faint(light) && faint(dark) && Math.abs(alphaOf(dark.fill) - 0.04) < 0.005 && light.fill !== dark.fill, JSON.stringify({ light, dark }));
    });

    await step('chat cards for a meeting that reached a guest, and for a move', async () => {
        // The meeting an agent deleted on Google (step 12): its card says whose calendars it was taken off.
        await openSession(await titleOf(reachCall.sessionId));
        const reachCard = page.locator('.dshcal-chat[data-calendar-chat="calendar_delete_event"][data-phase="result"]', { hasText: 'E2E Agent lunch' }).first();
        await reachCard.waitFor({ state: 'attached', timeout: 10000 });
        const told = (await reachCard.locator('[data-calendar-told]').textContent()) ?? '';
        if (shots) await reachCard.screenshot({ path: join(shots, 'chat-reached.png') }).catch(() => {});
        // An agent moves an event to another calendar: its card says where to.
        const fromAgent = (await events(day2, day2)).find((o) => o.title === 'E2E From agent');
        const moveCall = await agentCall('calendar_update_event', { id: fromAgent?.id, calendar_id: side?.id }, 'Move the agent event to the side calendar');
        await openSession(await titleOf(moveCall.sessionId));
        const moveCard = page.locator('.dshcal-chat[data-calendar-chat="calendar_update_event"][data-phase="result"]').first();
        await moveCard.waitFor({ state: 'attached', timeout: 10000 });
        const moveText = (await moveCard.textContent()) ?? '';
        const moveKind = await moveCard.locator('[data-calendar-chat-card]').getAttribute('data-calendar-chat-card');
        const moved = (await events(day2, day2)).find((o) => o.title === 'E2E From agent');
        if (shots) await moveCard.screenshot({ path: join(shots, 'chat-moved.png') }).catch(() => {});
        check('chat cards: a meeting an agent deleted on a Google calendar says whose calendars it was taken off; a move says where the event went',
            told === 'Taken off the calendars of ann@example.com, without emailing anyone.' && moveKind === 'moved' && moveText.includes('Moved “E2E From agent” to E2E Side')
            && moved?.calendarId === side?.id, JSON.stringify({ told, moveKind, moveText: moveText.slice(0, 200), moved: moved?.calendarId }));
    });

    await step('chat rows for calls that didn\'t work', async () => {
        // An agent reads an event that isn't there, and answers an invitation that isn't there: each says, in the
        // plugin's own row, what it didn't do and why, without what the error tells the agent to do next.
        const rowOf = async (call, tool) => {
            await openSession(await titleOf(call.sessionId));
            const row = page.locator(`.dshcal-chat[data-calendar-chat="${tool}"][data-calendar-failed]`).first();
            await row.waitFor({ state: 'attached', timeout: 10000 });
            return row;
        };
        const readRow = await rowOf(await agentCall('calendar_get_event', { id: 'ev-not-there' }, 'What is the offsite about?'), 'calendar_get_event');
        const readText = (await readRow.textContent()) ?? '';
        const answerRow = await rowOf(await agentCall('calendar_respond', { id: 'ev-not-there', answer: 'accepted' }, 'Say yes to the offsite'), 'calendar_respond');
        const answerText = (await answerRow.textContent()) ?? '';
        const answerWhy = (await answerRow.locator('[data-calendar-chat-card="failed"]').textContent()) ?? '';
        if (shots) await answerRow.screenshot({ path: join(shots, 'chat-not-done.png') }).catch(() => {});
        check('a call that didn\'t work shows as not done in the plugin\'s own row, with why in view: "Didn\'t work: …" for a read, "Not answered: …" for an answer',
            /Didn't work: \S/.test(readText) && /^Not answered: \S/.test(answerWhy.trim()) && !/Error:|Not done:|calendar_[a-z_]+|notify_guests/.test(`${readText} ${answerText}`),
            JSON.stringify({ readText, answerText }));
        // The change refused for its email (above): who it would email, why, and what the user can do, in the window's words.
        const emailRow = emailRefused ? await rowOf(emailRefused, 'calendar_update_event') : null;
        const emailWhy = emailRow ? ((await emailRow.locator('[data-calendar-chat-card="failed"]').textContent()) ?? '').trim() : '(the call before didn\'t run)';
        if (shots && emailRow) await emailRow.screenshot({ path: join(shots, 'chat-refused.png') }).catch(() => {});
        check('a change refused for its email says, in the window\'s words, whom it would email, why, and what to do',
            emailWhy === 'Not changed: It would email an update to ann@example.com and bob@example.com (Microsoft emails a meeting\'s guests about each change to it). Ask again to send it, or change it in Calendar.',
            emailWhy);
    });

    // 18. The Agenda pane.
    await step('the Agenda pane in the right sidebar', async () => {
        await openSession(await titleOf(listCall.sessionId));
        const opener = page.getByRole('button', { name: 'Open right sidebar' });
        if (await opener.count()) await opener.first().click();
        await page.waitForTimeout(800);
        if (!(await page.locator('[data-calendar-pane]').count())) await page.locator('button', { hasText: 'Today and the next days' }).first().click();
        const pane = page.locator('[data-calendar-pane]');
        await pane.waitFor({ state: 'visible', timeout: 10000 });
        await pane.locator('[data-calendar-event]', { hasText: 'E2E Planning' }).first().waitFor({ state: 'visible', timeout: 10000 });
        const text = await pane.textContent();
        await shot(page, 'agenda-pane');
        // An event's details open beside the pane; the chat stays. Open in Calendar shows it on the page.
        const row = pane.locator('[data-calendar-event]', { hasText: 'E2E Planning' }).first();
        await row.locator('.dshcal-pane-what').click();
        const details = page.locator('[data-calendar-details]');
        await details.waitFor({ state: 'visible', timeout: 10000 });
        const detailsText = await details.textContent();
        const beside = await page.evaluate(() => {
            const pop = document.querySelector('[data-calendar-details]').getBoundingClientRect();
            const pane = document.querySelector('[data-calendar-pane]').getBoundingClientRect();
            return pop.right <= pane.left + 12 && pop.left < pane.left;
        });
        const stayed = (await page.locator('[data-calendar-page]').count()) === 0;
        await shot(page, 'agenda-pane-details');
        await details.locator('[data-calendar-open-page]').click();
        await page.locator('[data-calendar-page]').waitFor({ state: 'visible', timeout: 10000 });
        await details.waitFor({ state: 'visible', timeout: 10000 });
        const pageText = await details.textContent();
        check('the Agenda pane lists today and the next days; an event\'s details open beside it, the chat staying, and Open in Calendar shows it on the page',
            /Today/.test(text ?? '') && /E2E Offsite/.test(text ?? '') && /E2E Planning/.test(detailsText ?? '') && beside && stayed && /E2E Planning/.test(pageText ?? ''),
            JSON.stringify({ text: (text ?? '').slice(0, 300), beside, stayed, pageText: (pageText ?? '').slice(0, 100) }));
        await page.keyboard.press('Escape');
    });

    // 18b. The pane at its narrowest (DSH's right sidebar dragged as far as it goes, 300 px), and on DSH's panel: no fill
    // or blur of its own, in light and dark.
    await step('the Agenda pane at its narrowest, and its glass', async () => {
        await openSession(await titleOf(listCall.sessionId));
        const opener = page.getByRole('button', { name: 'Open right sidebar' });
        if (await opener.count()) await opener.first().click();
        await page.waitForTimeout(800);
        if (!(await page.locator('[data-calendar-pane]').count())) await page.locator('button', { hasText: 'Today and the next days' }).first().click();
        const pane = page.locator('[data-calendar-pane]');
        await pane.waitFor({ state: 'visible', timeout: 10000 });
        const look = () => pane.evaluate((el) => {
            const css = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            // Anything inside wider than the pane, or a row whose content runs past it.
            const over = [...el.querySelectorAll('[data-calendar-event], .dshcal-pane *')].filter((child) => {
                const r = child.getBoundingClientRect();
                return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
            }).length;
            return { width: Math.round(box.width), fill: css.backgroundColor, blur: css.backdropFilter, sideways: el.scrollWidth > el.clientWidth + 1, over };
        });
        const before = await look();
        await setDark(page, true);
        const dark = await look();
        await setDark(page, false);
        const handle = page.locator('[data-side="rightbar"]').first();
        const box = await handle.boundingBox();
        let narrow = null;
        if (box) {
            const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            await page.mouse.move(at.x, at.y);
            await page.mouse.down();
            // As far right as the window goes: DSH stops the sidebar at its narrowest.
            const right = (page.viewportSize()?.width ?? 1280) - 8;
            await page.mouse.move(Math.min(at.x + 200, right), at.y, { steps: 6 });
            await page.mouse.move(right, at.y, { steps: 6 });
            await page.mouse.up();
            await page.waitForTimeout(600);
            narrow = await look();
            await pane.locator('[data-calendar-event]', { hasText: 'E2E Planning' }).first().scrollIntoViewIfNeeded().catch(() => {});
            await shot(page, 'agenda-pane-narrowest');
            // Back to the width it had.
            const back = await handle.boundingBox();
            if (back) {
                await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
                await page.mouse.down();
                await page.mouse.move(at.x, at.y, { steps: 8 });
                await page.mouse.up();
                await page.waitForTimeout(400);
            }
        }
        const glass = (c) => alphaOf(c.fill) === 0 && c.blur === 'none';
        check('the Agenda pane on DSH\'s narrowest right sidebar fits, with nothing cut or scrolled sideways; it has no fill or blur of its own, in light and dark',
            box !== null && narrow !== null && narrow.width <= 300 && narrow.width < before.width && !narrow.sideways && narrow.over === 0 && !before.sideways
            && glass(before) && glass(dark), JSON.stringify({ before, dark, narrow }));
    });

    // 19. Light and dark, with and without a wallpaper.
    await step('light and dark, with and without a wallpaper', async () => {
        await openPage();
        await page.locator('[data-calendar-view="week"]').click();
        await showDay(day1);
        const glass = async () => page.evaluate(() => {
            const main = document.querySelector('[data-calendar-main]');
            const side = document.querySelector('[data-calendar-side]');
            const root = document.querySelector('[data-calendar-page]');
            const css = getComputedStyle(main);
            const sideCss = getComputedStyle(side);
            return {
                blur: css.backdropFilter, background: css.backgroundColor, sideBlur: sideCss.backdropFilter, side: sideCss.backgroundColor,
                root: getComputedStyle(root).backgroundColor, dark: document.body.hasAttribute('data-ds-dark-theme'),
            };
        });
        // The wallpaper's numbers: the side column at its tint, the view at tint + .2, both blurred by its blur; DSH's
        // own fallbacks (22px, .55) without them.
        const follows = (g, tint, blur) => Math.abs(alphaOf(g.side) - tint) < 0.005 && Math.abs(alphaOf(g.background) - Math.min(1, tint + 0.2)) < 0.005
            && g.blur === `blur(${blur}) saturate(1.4)` && g.sideBlur === g.blur;
        await wallpaperOn(page);
        const light = await glass();
        const other = await page.evaluate(() => {
            document.body.style.setProperty('--wp-blur', '10px');
            document.body.style.setProperty('--wp-tint', '0.3');
        }).then(glass);
        const none = await page.evaluate(() => {
            document.body.style.removeProperty('--wp-blur');
            document.body.style.removeProperty('--wp-tint');
        }).then(glass);
        await wallpaperOn(page);
        await shot(page, 'week-light-wallpaper');
        await page.locator('[data-calendar-view="month"]').click();
        await shot(page, 'month-light-wallpaper');
        await setDark(page, true);
        const dark = await glass();
        await shot(page, 'month-dark-wallpaper');
        await page.locator('[data-calendar-view="week"]').click();
        await shot(page, 'week-dark-wallpaper');
        await wallpaperOff(page);
        await shot(page, 'week-dark');
        await page.locator('[data-calendar-view="month"]').click();
        await shot(page, 'month-dark');
        await page.locator('[data-calendar-view="week"]').click();
        await setDark(page, false);
        const clear = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
        check('the page keeps no background of its own and its cards are glass, in light and dark: the side column at the wallpaper\'s tint, the view at tint + .2, both blurred by its blur, with the same fallbacks without it',
            clear(light.root) && clear(dark.root) && follows(light, 0.55, '22px') && follows(dark, 0.55, '22px') && follows(other, 0.3, '10px') && follows(none, 0.55, '22px')
            && light.background !== dark.background && dark.dark === true, JSON.stringify({ light, dark, other, none }));
    });

    // 20. A narrow window.
    await step('a narrow window', async () => {
        await page.setViewportSize({ width: 420, height: 820 });
        await page.waitForTimeout(600);
        const toggle = await page.locator('[data-calendar-side-toggle]').isVisible();
        const sideShown = await page.locator('[data-calendar-side]').isVisible().catch(() => false);
        const columns = await page.locator('[data-calendar-day-column]').count();
        const overflow = await page.evaluate(() => {
            const root = document.querySelector('[data-calendar-page]');
            return root.scrollWidth - root.clientWidth;
        });
        const search = await page.locator('[data-calendar-search]').boundingBox();
        const searchFits = search !== null && search.x >= 0 && search.x + search.width <= 420 && search.width >= 200;
        await shot(page, 'narrow-week');
        await page.locator('[data-calendar-side-toggle]').click();
        await page.locator('[data-calendar-side]').waitFor({ state: 'visible', timeout: 5000 });
        const focusIn = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-calendar-side]')));
        await shot(page, 'narrow-side');
        await page.keyboard.press('Escape');
        await page.locator('[data-calendar-side]').waitFor({ state: 'hidden', timeout: 5000 });
        const focusBack = await page.evaluate(() => document.activeElement?.hasAttribute('data-calendar-side-toggle') === true);
        check('in a narrow window the side column folds behind a button (the focus going in and back), Week shows three days, search fits, nothing sticking out',
            toggle && !sideShown && columns === 3 && overflow <= 1 && searchFits && focusIn && focusBack,
            JSON.stringify({ toggle, sideShown, columns, overflow, search, focusIn, focusBack }));
        await page.setViewportSize({ width: 1280, height: 800 });
    });

    // 20b. The event dialog in a narrow window: Ends under Starts, each date and time as wide as its whole text needs.
    await step('the event dialog in a narrow window', async () => {
        await page.setViewportSize({ width: 420, height: 820 });
        await page.waitForTimeout(600);
        try {
            await page.locator('[data-calendar-new]').click();
            const form = page.locator('[data-calendar-event-form="new"]');
            await form.waitFor({ state: 'visible' });
            await page.waitForTimeout(300);
            const fields = await form.evaluate((el) => [...el.querySelectorAll('[data-calendar-start-day],[data-calendar-start-time],[data-calendar-end-day],[data-calendar-end-time]')].map((input) => {
                // The same field at its own width, out of the row: what it needs to show all of its text.
                const free = input.cloneNode();
                free.style.cssText = 'position:absolute;visibility:hidden;width:auto;min-width:0;flex:none';
                input.parentElement.append(free);
                const need = free.getBoundingClientRect().width;
                free.remove();
                const r = input.getBoundingClientRect();
                return { width: Math.round(r.width * 10) / 10, need: Math.round(need * 10) / 10, top: Math.round(r.top) };
            }));
            const overflow = await page.evaluate(() => { const c = document.querySelector('.dshcal-dlg-content'); return c.scrollWidth - c.clientWidth; });
            await shot(page, 'narrow-event-dialog');
            await page.keyboard.press('Escape');
            await dialogGone();
            const [startDay, startTime, endDay, endTime] = fields;
            check('in a narrow window the event dialog shows its dates and times in full, Ends under Starts',
                fields.length === 4 && fields.every((f) => f.width + 0.5 >= f.need) && endDay.top > startDay.top && startTime.top === startDay.top && endTime.top === endDay.top && overflow <= 1,
                JSON.stringify({ fields, overflow }));
        } finally {
            await page.setViewportSize({ width: 1280, height: 800 });
        }
    });

    // 21. Weekends hidden and week numbers shown, from the settings menu at the foot of the side column; kept after a
    // reload, then turned off again (as the steps before had them).
    await step('weekends hidden and week numbers, from the settings menu', async () => {
        const settings = page.locator('[data-calendar-settings]');
        const item = (pref) => page.getByRole('menuitem').filter({ has: page.locator(`[data-calendar-pref="${pref}"]`) });
        const openMenu = async () => {
            await settings.click();
            await page.locator('[data-calendar-pref]').first().waitFor({ state: 'visible' });
        };
        /** An on/off item as the open menu shows it: what it says it is, and whether DSH's menu checks it. */
        const itemNow = async (pref) => ({
            on: await page.locator(`[data-calendar-pref="${pref}"]`).getAttribute('data-on'),
            checked: (await item(pref).locator('svg').count()) > 0,
        });
        const prefsNow = async () => (await api('state')).value?.prefs ?? {};
        /** One of the two chosen from the menu, and the host's prefs once they say it. */
        const choose = async (pref, key, on) => {
            await openMenu();
            await item(pref).click();
            await page.locator('[data-calendar-pref]').first().waitFor({ state: 'detached' });
            return waitFor(async () => ((await prefsNow())[key] === true) === on, `${key} ${on ? 'on' : 'off'}`, 10000).then(() => true, () => false);
        };
        const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
        const weekend = (day) => weekday(day) === 0 || weekday(day) === 6;
        // ISO 8601: weeks from Monday, a year's week 1 the one with its first Thursday.
        const isoWeek = (day) => {
            const thursday = new Date(`${day}T12:00:00Z`);
            thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
            const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4, 12));
            return 1 + Math.round(((thursday - jan4) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
        };
        /** Week view as it shows: its days, the week's number by the title (beside it or under it), and whether the title has its room. */
        const weekNow = async () => {
            await page.locator('[data-calendar-view="week"]').click();
            await page.locator('[data-calendar-grid="week"]').waitFor({ state: 'visible' });
            await page.waitForTimeout(300);
            return page.evaluate(() => {
                const title = document.querySelector('[data-calendar-range]');
                const tag = document.querySelector('[data-calendar-week-tag]');
                const root = document.querySelector('[data-calendar-page]');
                const [a, b] = [title?.getBoundingClientRect(), tag?.getBoundingClientRect()];
                return {
                    days: [...document.querySelectorAll('[data-calendar-day-column]')].map((el) => el.getAttribute('data-calendar-day-column')),
                    tag: tag?.textContent ?? '',
                    beside: Boolean(a && b) && b.left >= a.right && b.left - a.right < 16 && Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 4,
                    under: Boolean(a && b) && b.top >= a.bottom - 2 && b.top - a.bottom < 8 && Math.abs(b.left - a.left) < 6,
                    titleFits: Boolean(title) && title.scrollWidth <= title.clientWidth + 1,
                    overflow: root.scrollWidth - root.clientWidth,
                };
            });
        };
        /** Month view as it shows: its columns, each row's days and number, and the small month's numbers. */
        const monthNow = async () => {
            await page.locator('[data-calendar-view="month"]').click();
            await page.locator('[data-calendar-grid="month"]').waitFor({ state: 'visible' });
            await page.waitForTimeout(300);
            const month = await page.evaluate(() => {
                const grid = document.querySelector('[data-calendar-grid="month"]');
                const root = document.querySelector('[data-calendar-page]');
                const mini = [];
                for (const el of document.querySelector('[data-calendar-mini] .dshcal-mini-grid')?.children ?? []) {
                    if (el.hasAttribute('data-calendar-mini-week')) mini.push({ number: el.textContent, days: [] });
                    else if (el.hasAttribute('data-calendar-mini-day') && mini.length) mini[mini.length - 1].days.push(el.getAttribute('data-calendar-mini-day'));
                }
                return {
                    cols: grid.getAttribute('data-cols'),
                    heads: [...grid.querySelectorAll('.dshcal-mo-wd')].map((el) => el.textContent),
                    rows: [...grid.querySelectorAll('[role=row]')].map((row) => ({
                        days: [...row.querySelectorAll('[data-calendar-cell]')].map((c) => c.getAttribute('data-calendar-cell')),
                        number: row.querySelector('[data-calendar-week-number]')?.textContent ?? '',
                    })),
                    mini,
                    overflow: root.scrollWidth - root.clientWidth,
                };
            });
            month.firstNamed = month.rows.length ? await page.getByRole('rowheader', { name: month.rows[0].number || 'none', exact: true }).count() : 0;
            return month;
        };
        const fiveDays = (days) => days.length === 5 && days.every((day, i) => weekday(day) === i + 1);
        const numbered = (rows) => rows.every((row) => row.number === `Week ${isoWeek(row.days.find((day) => weekday(day) === 1) ?? row.days[0])}`);
        /** The side column shown, as the steps before have it (its foot has the settings menu). */
        const sideShown = async () => {
            if (await page.locator('[data-calendar-side]').isVisible()) return;
            await page.locator('[data-calendar-side-toggle]').click();
            await page.locator('[data-calendar-side]').waitFor({ state: 'visible' });
        };
        try {
            await openPage();
            await sideShown();
            await page.locator('[data-calendar-today]').click();
            // As they start: weekends shown (checked), week numbers off.
            await openMenu();
            const first = { weekends: await itemNow('weekends'), numbers: await itemNow('week-numbers') };
            await page.keyboard.press('Escape');
            await page.locator('[data-calendar-pref]').first().waitFor({ state: 'detached' });
            const hidden = await choose('weekends', 'hideWeekends', true);
            const numbers = await choose('week-numbers', 'weekNumbers', true);
            await openMenu();
            const then = { weekends: await itemNow('weekends'), numbers: await itemNow('week-numbers') };
            await shot(page, 'prefs-menu');
            await page.keyboard.press('Escape');
            check('the settings menu says weekends are shown and week numbers off at first, checked as they are, and turns each the other way',
                hidden && numbers && first.weekends.on === 'true' && first.weekends.checked && first.numbers.on === 'false' && !first.numbers.checked
                && then.weekends.on === 'false' && !then.weekends.checked && then.numbers.on === 'true' && then.numbers.checked, JSON.stringify({ first, then, hidden, numbers }));

            const week = await weekNow();
            await shot(page, 'prefs-week-light');
            const month = await monthNow();
            await shot(page, 'prefs-month-light');
            await setDark(page, true);
            await shot(page, 'prefs-month-dark');
            await weekNow();
            await shot(page, 'prefs-week-dark');
            await setDark(page, false);
            check('weekends hidden: Week shows Monday to Friday with its week number by the title; Month five columns, each row with its ISO week number (a row header, "Week N"), and the small month too',
                fiveDays(week.days) && week.tag === `Week ${isoWeek(week.days[0])}` && week.beside && week.titleFits && month.cols === '5' && month.heads.length === 6
                && month.rows.length >= 4 && month.rows.every((row) => fiveDays(row.days)) && numbered(month.rows) && month.firstNamed === 1
                && month.mini.length === 6 && month.mini.every((row) => row.days.length === 7 && row.number === `Week ${isoWeek(row.days.find((day) => weekday(day) === 1))}`),
                JSON.stringify({ week, month }).slice(0, 1500));

            // A narrow window: three weekdays, the week's number under the title (which keeps its room), Month still in five.
            await page.setViewportSize({ width: 420, height: 820 });
            await page.waitForTimeout(600);
            const narrowWeek = await weekNow();
            await shot(page, 'prefs-narrow-week');
            const narrowMonth = await monthNow();
            await shot(page, 'prefs-narrow-month');
            await page.locator('[data-calendar-side-toggle]').click();
            await page.locator('[data-calendar-side]').waitFor({ state: 'visible', timeout: 5000 });
            await shot(page, 'prefs-narrow-side');
            await page.keyboard.press('Escape');
            await page.locator('[data-calendar-side]').waitFor({ state: 'hidden', timeout: 5000 });
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.waitForTimeout(600);
            check('in a narrow window Week shows three weekdays and the week\'s number under the title, which keeps its room, and Month five columns, nothing sticking out',
                narrowWeek.days.length === 3 && !narrowWeek.days.some(weekend) && /^Weeks? \d+(–\d+)?$/.test(narrowWeek.tag) && narrowWeek.under
                && narrowWeek.titleFits && narrowWeek.overflow <= 1 && narrowMonth.cols === '5' && numbered(narrowMonth.rows) && narrowMonth.overflow <= 1,
                JSON.stringify({ narrowWeek, narrowMonth: { cols: narrowMonth.cols, rows: narrowMonth.rows.length, overflow: narrowMonth.overflow } }));

            // Kept: after a reload (the page as the steps before had it: its side column shown, the notice closed).
            await page.reload({ waitUntil: 'domcontentloaded' });
            await settleWindow(page);
            await openPage();
            await sideShown();
            const notice = page.locator('[data-calendar-store-issue]');
            if (await notice.count()) {
                await notice.getByRole('button', { name: 'Close this notice' }).click();
                await notice.waitFor({ state: 'detached' });
            }
            const keptWeek = await weekNow();
            const keptMonth = await monthNow();
            check('weekends hidden and week numbers are kept after a reload', fiveDays(keptWeek.days) && keptWeek.tag === `Week ${isoWeek(keptWeek.days[0])}`
                && keptMonth.cols === '5' && numbered(keptMonth.rows), JSON.stringify({ keptWeek, keptMonth: { cols: keptMonth.cols, rows: keptMonth.rows } }).slice(0, 1500));

            // Off again from the menu: seven days, no numbers, and neither kept.
            const shownAgain = await choose('weekends', 'hideWeekends', false);
            const numbersOff = await choose('week-numbers', 'weekNumbers', false);
            const offMonth = await monthNow();
            const offWeek = await weekNow();
            const prefs = await prefsNow();
            check('turned off again from the menu: Week has its seven days and no week number, Month seven columns without numbers, and neither is kept',
                shownAgain && numbersOff && offWeek.days.length === 7 && offWeek.tag === '' && offMonth.cols === '7' && offMonth.heads.length === 7
                && offMonth.rows.every((row) => row.days.length === 7 && row.number === '') && offMonth.mini.length === 0
                && !('hideWeekends' in prefs) && !('weekNumbers' in prefs), JSON.stringify({ offWeek, prefs, cols: offMonth.cols, mini: offMonth.mini.length }));
        } finally {
            // Whatever happened above, the steps after this one find the page as it was.
            await api('setPrefs', { patch: { hideWeekends: false, weekNumbers: false } });
            await setDark(page, false);
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.locator('[data-calendar-view="week"]').click().catch(() => {});
        }
    });

    check('the window threw nothing', pageErrors.length === 0, pageErrors.join('\n'));
} catch (error) {
    check('the browser test ran to its end', false, error?.stack ?? error);
} finally {
    await browser?.close().catch(() => {});
    await stopDsh(child);
    await model.close?.();
    await providers.close();
    if (process.env.KEEP === '1') console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
    if (sockDir !== root) rmSync(sockDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
