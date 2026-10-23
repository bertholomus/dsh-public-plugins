#!/usr/bin/env node
/**
 * Real-host end-to-end test for the calendar plugin's host half.
 *
 * Boots a real DSH (the shipped web profile, in a temporary DSH_HOME) with
 * this repo's calendar and session-bridge plugins and a scripted model
 * (fake-model.mjs), then:
 *
 * - the plugin starts with its calendar on this computer, its folder 700
 *   and its files 600;
 * - the window's endpoints add, read, change and delete events, subscribe
 *   to a private feed served here (its address goes to DSH's credential
 *   store, never into the plugin's files or log), and refuse what they
 *   should, with messages for the user;
 * - with a CalDAV server (Radicale, when RADICALE_VENV points at a
 *   virtualenv that has it), a CalDAV account is added: its password goes
 *   to DSH's credential store, never into the plugin's files or log, and
 *   removing the account removes it there too;
 * - agents' calendar tools, under each of DSH's permissions: Full access
 *   changes calendars without asking, Read Only reads but can't change
 *   them, Workspace Write asks the user first (allowed, the change is made;
 *   rejected or unanswered, it isn't), and the plugin's agentChanges: off
 *   refuses every change; one occurrence isn't moved to another calendar,
 *   and a change that says to tell guests where they can't be told is
 *   refused before anyone is asked;
 * - with the CalDAV server, a delete decided on an event that changed on
 *   the server meanwhile stops and says so;
 * - a restart keeps the calendars and their events.
 *
 *   DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node plugins/calendar/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs `dsh` from PATH, and skips when there is none.
 * KEEP=1 keeps the temporary folder.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { startFakeModel } from './fake-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = resolve(here, '../../..');

function findDsh() {
    const bin = process.env.DSH_BIN;
    if (bin) return bin.endsWith('.js') ? [process.execPath, bin] : [bin];
    try {
        const found = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
        if (found) return [found];
    } catch {}
    return null;
}

// The subscribed feed's address is a private one, like Google's secret address: its key is in the path.
const feedKey = `private-${randomUUID().replaceAll('-', '')}`;
const feedPath = `/calendar/ical/me%40example.com/${feedKey}/basic.ics`;
/** What this test prints never holds the feed's key. */
const redact = (text) => String(text).replaceAll(feedKey, '(the feed\'s key)');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) {
        passed += 1;
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.log(`not ok - ${name}${detail ? `\n    ${redact(detail).slice(0, 1500)}` : ''}`);
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

const root = mkdtempSync(join(tmpdir(), 'dsh-calendar-e2e-'));
const home = join(root, 'home');
const ws = join(root, 'ws');
// A Unix socket's path must be short (about 100 bytes): under a long temporary folder, the socket gets a short folder of its own.
const sockDir = Buffer.byteLength(join(root, 'bridge.sock')) <= 100 ? root : mkdtempSync('/tmp/dcal-');
const sock = join(sockDir, 'bridge.sock');
const dshLog = join(root, 'dsh.log');
const calendarDir = join(home, 'calendar');
const storeFile = join(calendarDir, 'calendar.json');
const logFile = join(calendarDir, 'calendar.log');
const credentialsFile = join(home, '.credentials.yaml');

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

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const modeOf = (file) => statSync(file).mode & 0o777;

/** One record in DSH's credentials file (YAML): its key's line and the lines under it. */
function recordIn(text, key) {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => [`${key}:`, `"${key}":`, `'${key}':`].includes(line.trim()));
    if (at < 0) return '';
    const depth = (line) => line.length - line.trimStart().length;
    const end = lines.findIndex((line, i) => i > at && line.trim() !== '' && depth(line) <= depth(lines[at]));
    return lines.slice(at, end < 0 ? lines.length : end).join('\n');
}

async function signInWeb() {
    const signIn = [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1] ?? '';
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

/**
 * DSH's approval prompts as the window gets them: its events stream on /api/remote.mux brings each request, and
 * $events/result answers one, as the prompt's Allow once and Reject do.
 */
async function approvalsOf(web) {
    const url = new URL('api/remote.mux', web.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: web.cookie, origin: web.base.origin } });
    const asked = [];
    const taken = new Set();
    let clientId;
    let failure;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })));
    socket.addEventListener('error', (event) => { failure = event.message ?? 'socket error'; });
    socket.addEventListener('message', ({ data }) => {
        let frame;
        try { frame = JSON.parse(String(data)); } catch { return; }
        if (frame.streamId !== 'events') return;
        if (frame.type === 'error') failure = JSON.stringify(frame.error);
        const value = frame.type === 'item' ? frame.value : undefined;
        if (value?.type === 'ready') clientId = value.clientId;
        else if (value?.type === 'waterfall' && value.event === 'approval/request') asked.push(value);
    });
    await waitFor(() => {
        if (failure) throw new Error(failure);
        return clientId;
    }, 'the window\'s events stream');
    return {
        /** The next prompt whose request matches, not taken before. */
        next: (what, match) => waitFor(() => {
            const found = asked.find((a) => !taken.has(a.eventId) && match(a.request ?? {}));
            if (found) taken.add(found.eventId);
            return found;
        }, what, 60000),
        answer: (prompt, outcome) => webApi(web, '$events/result', { clientId, eventId: prompt.eventId, outcome: { kind: 'result', value: outcome } }),
        close: () => socket.close(),
    };
}

const profile = join(home, 'profiles', 'web');

/** The web profile with the calendar and the session bridge linked in, and its patch. */
function writeProfile(modelPort, calendarConfig = {}) {
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
    const calendarRows = Object.entries({ timeZone: 'Europe/Berlin', ...calendarConfig }).map(([k, v]) => `    ${k}: ${q(v)}`).join('\n');
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
${calendarRows}
`);
}

function startDsh(dsh, permission) {
    const out = openSync(dshLog, 'a');
    const local = '127.0.0.1,localhost';
    const child = spawn(dsh[0], [...dsh.slice(1), '--profile', 'web', '--no-open', '--port', '0'], {
        cwd: ws,
        env: {
            ...process.env, DSH_HOME: home, FAKE_LLM_KEY: 'sk-fake', DSH_TELEMETRY_DISABLED: '1', NO_PROXY: local, no_proxy: local,
            DSH_PERMISSION_MODE: permission,
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

const signIns = () => [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].length;

async function boot(dsh, permission, what) {
    const before = signIns();
    const child = startDsh(dsh, permission);
    try {
        await waitFor(async () => existsSync(sock) && (await bridge('GET', '/health')).ok, `the session bridge (${what})`, 90000);
        await waitFor(() => signIns() > before, `the web sign-in link (${what})`, 30000);
    } catch (error) {
        // A DSH that didn't come up isn't left running: the caller never gets it to stop.
        await stopDsh(child);
        throw error;
    }
    return child;
}

/** The frames of a zstd file: DSH appends one frame per write, and Node's decoder reads only the first. */
function zstdFrames(buf) {
    const out = [];
    let at = 0;
    while (at + 4 <= buf.length) {
        const magic = buf.readUInt32LE(at);
        if ((magic & 0xfffffff0) === 0x184d2a50) {
            at += 8 + buf.readUInt32LE(at + 4);
            continue;
        }
        if (magic !== 0xfd2fb528) break;
        const fhd = buf[at + 4];
        const single = (fhd >> 5) & 1;
        let p = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [single ? 1 : 0, 2, 4, 8][fhd >> 6];
        for (;;) {
            const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
            p += 3 + (((header >> 1) & 3) === 1 ? 1 : header >>> 3);
            if (header & 1) break;
        }
        if ((fhd >> 2) & 1) p += 4;
        out.push(buf.subarray(at, p));
        at = p;
    }
    return out;
}

/** A session's events as DSH saved them in its log (zstd-compressed JSON lines). */
function sessionEvents(sessionId) {
    const found = [];
    const walk = (dir, depth) => {
        let names = [];
        try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of names) {
            const p = join(dir, d.name);
            if (d.isDirectory() && depth < 3) walk(p, depth + 1);
            else if (d.name === 'session.v4.jsonl.zstd' && dir.endsWith(sessionId)) found.push(p);
        }
    };
    walk(join(home, 'sessions'), 0);
    const out = [];
    for (const file of found) {
        try {
            const text = zstdFrames(readFileSync(file)).map((frame) => zstdDecompressSync(frame).toString('utf8')).join('');
            for (const line of text.split('\n')) {
                if (line.trim()) out.push(JSON.parse(line));
            }
        } catch {}
    }
    return out;
}

/** A python that can run Radicale 3 or later, or undefined. */
function findRadicale() {
    const candidates = [];
    if (process.env.RADICALE_PYTHON) candidates.push(process.env.RADICALE_PYTHON);
    if (process.env.RADICALE_VENV) candidates.push(join(process.env.RADICALE_VENV, 'bin', 'python'));
    for (const python of candidates) {
        try {
            const version = execFileSync(python, ['-c', 'import radicale; print(radicale.VERSION)'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
            if (Number.parseInt(version, 10) >= 3) return python;
        } catch {}
    }
    return undefined;
}

async function startRadicale(python, user, password) {
    const dir = join(root, 'radicale');
    mkdirSync(dir);
    writeFileSync(join(dir, 'users'), `${user}:${password}\n`);
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const server = spawn(python, ['-m', 'radicale', '--config', '--server-hosts', `127.0.0.1:${port}`,
        '--storage-filesystem-folder', join(dir, 'collections'), '--auth-type', 'htpasswd', '--auth-htpasswd-filename', join(dir, 'users'),
        '--auth-htpasswd-encryption', 'plain', '--auth-delay', '0', '--rights-type', 'owner_only', '--logging-level', 'warning'], { stdio: 'ignore' });
    process.once('exit', () => server.kill());
    const base = `http://127.0.0.1:${port}/`;
    await waitFor(async () => (await fetch(base)).status > 0, 'Radicale', 20000);
    const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    const made = await fetch(new URL(`${user}/home/`, base), {
        method: 'MKCALENDAR', headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8' },
        body: '<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Home</d:displayname></d:prop></d:set></c:mkcalendar>',
    });
    if (made.status !== 201) throw new Error(`MKCALENDAR: ${made.status}`);
    return { server, base };
}

const dsh = findDsh();
if (!dsh) {
    console.log('skipped: set DSH_BIN to a DSH bin.js (or put dsh on PATH) to run the real-host test');
    process.exit(0);
}

mkdirSync(ws, { recursive: true });
const model = await startFakeModel();
let child;
let radicale;
const feed = createServer((req, res) => {
    if (req.url !== feedPath) {
        res.writeHead(404);
        return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Feed//EN', 'X-WR-CALNAME:Team', 'BEGIN:VEVENT', 'UID:offsite@test', 'DTSTAMP:20260101T000000Z',
        'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261107', 'SUMMARY:Team offsite', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
});
await new Promise((r) => feed.listen(0, '127.0.0.1', r));

/** Prompt a new session as the user; its first reply after the tool result. */
async function agentCall(tool, args) {
    const text = `E2E:call ${tool} ${JSON.stringify(args)}`;
    const mark = model.requests.length;
    const { sessionId } = await bridge('POST', '/sessions', { workspacePath: ws, text });
    await waitFor(async () => {
        const s = await bridge('GET', `/sessions/${sessionId}`);
        return s.turns.started > 0 && s.turns.started === s.turns.ended && s.status !== 'running';
    }, `the ${tool} turn`, 60000);
    const reqs = model.requests.slice(mark);
    const result = reqs.find((r) => r.action.text?.startsWith('TOOL-RESULT:'))?.action.text ?? '';
    return { sessionId, result, offered: reqs[0]?.tools ?? [] };
}

try {
    // 1. Full access: the plugin's first start, its endpoints, and agents' changes without asking.
    writeProfile(model.port);
    child = await boot(dsh, 'danger-full-access', 'first start');
    await waitFor(() => readText(logFile).includes('account added local'), 'the calendar plugin to start', 30000);
    const web = await signInWeb();
    const api = (method, args = {}) => webApi(web, `dsh-plugin-calendar/${method}`, args);
    const state = await waitFor(async () => { const r = await api('state'); return r.ok ? r.value : null; }, 'the calendar endpoints', 30000);
    const personal = state.calendars?.[0];
    check('the plugin starts with a calendar on this computer', state.calendars?.length === 1 && personal.name === 'Personal' && state.defaultCalendar === personal.id
        && state.zone === 'Europe/Berlin' && state.accounts?.[0]?.kind === 'local', JSON.stringify(state).slice(0, 600));
    check('the window is told what signing in to Google and Microsoft needs', state.signIn?.google?.ready === false && state.signIn?.microsoft?.ready === false
        && Array.isArray(state.presets) && state.presets.some((p) => p.id === 'icloud'), JSON.stringify(state.signIn));
    check('its folder is 700, its store and log 600', modeOf(calendarDir) === 0o700 && modeOf(storeFile) === 0o600 && modeOf(logFile) === 0o600);

    let r = await api('createEvent', { input: { title: 'Dentist', start: '2026-10-13T09:30', end: '2026-10-13T10:15', location: 'Main St 1' } });
    const dentist = r.value?.occurrence;
    check('the window adds an event', r.ok && dentist?.title === 'Dentist' && dentist.startLocal === '2026-10-13T09:30' && dentist.timeZone === 'Europe/Berlin', JSON.stringify(r));
    r = await api('createEvent', { input: { title: 'Standup', start: '2026-10-12T09:00', end: '2026-10-12T09:15', repeat: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' } });
    check('and a repeating one', r.ok && r.value?.occurrence?.repeats === 'Every week on Monday, Wednesday and Friday', JSON.stringify(r));
    const from = Date.parse('2026-10-12T00:00:00+02:00');
    const to = Date.parse('2026-10-19T00:00:00+02:00');
    r = await api('events', { from, to });
    const week = r.value?.occurrences ?? [];
    check('the week shows them', r.ok && week.length === 4 && week.filter((o) => o.title === 'Standup').length === 3, JSON.stringify(week.map((o) => `${o.startLocal} ${o.title}`)));
    const wednesday = week.find((o) => o.title === 'Standup' && o.startLocal.startsWith('2026-10-14'));
    r = await api('updateEvent', { id: wednesday.id, patch: { start: '2026-10-14T10:00' }, scope: 'one' });
    check('one occurrence moves', r.ok && r.value?.occurrence?.startLocal === '2026-10-14T10:00' && r.value.occurrence.changed === true, JSON.stringify(r));
    r = await api('updateEvent', { id: dentist.id, patch: { end: '2026-10-13T08:00' }, scope: 'all' });
    check('a change that can\'t be is refused with a message for the user', !r.ok && r.error?.code === 'calendar/refused' && /end is before the start/.test(r.error?.message), JSON.stringify(r));
    r = await api('search', { query: 'dentist' });
    check('search finds it', r.ok && r.value?.occurrences?.[0]?.id === dentist.id, JSON.stringify(r).slice(0, 300));

    r = await api('addAccount', { input: { kind: 'ics', url: `http://127.0.0.1:${feed.address().port}${feedPath}` } });
    const feedAccount = r.value?.account;
    check('a subscribed feed is added and named by the feed, its account showing the host only', r.ok && feedAccount?.name === 'Team' && feedAccount.kind === 'ics'
        && feedAccount.host === `127.0.0.1:${feed.address().port}` && !('url' in feedAccount), JSON.stringify(r));
    r = await api('events', { from: Date.parse('2026-11-01T00:00:00+01:00'), to: Date.parse('2026-11-10T00:00:00+01:00') });
    const offsite = r.value?.occurrences?.find((o) => o.title === 'Team offsite');
    check('its events show, read only', offsite?.allDay === true && offsite.startDay === '2026-11-05' && offsite.lastDay === '2026-11-06' && offsite.readOnly === true, JSON.stringify(offsite));
    const feedRecord = recordIn(readText(credentialsFile), `calendar/${feedAccount?.id}`);
    const feedLeaks = [storeFile, logFile].filter((f) => readText(f).includes(feedPath) || readText(f).includes(feedKey));
    check('the feed\'s address is in DSH\'s credential store under its account\'s record, and not in the plugin\'s files or log',
        feedAccount !== undefined && feedRecord.includes(feedPath) && feedLeaks.length === 0, `in the record: ${feedRecord.includes(feedPath)}; in ${feedLeaks.join(', ') || 'no file'}`);
    r = await api('deleteEvent', { id: offsite?.id, scope: 'all' });
    check('and can\'t be deleted here', !r.ok && /read only/.test(r.error?.message ?? ''), JSON.stringify(r));
    r = await api('addAccount', { input: { kind: 'ics', url: 'https://' } });
    check('a bad address is refused', !r.ok && r.error?.code === 'calendar/refused', JSON.stringify(r));
    r = await api('startSignIn', { kind: 'google' });
    check('Google sign-in without a client says what is missing', !r.ok && /client/i.test(r.error?.message ?? ''), JSON.stringify(r));
    r = await api('setGoogleClient', { clientId: 'not-a-client', clientSecret: 'x' });
    check('a wrong Google client id is refused', !r.ok && /apps\.googleusercontent\.com/.test(r.error?.message ?? ''), JSON.stringify(r));
    r = await api('setMicrosoftClient', { clientId: '11111111-2222-3333-4444-555555555555', tenant: '' });
    check('a Microsoft client id makes its sign-in ready', r.ok && r.value?.signIn?.microsoft?.ready === true && r.value.signIn.microsoft.tenant === 'common', JSON.stringify(r));
    r = await api('exportCalendar', { id: personal.id });
    check('a calendar exports as iCalendar', r.ok && /BEGIN:VCALENDAR/.test(r.value?.ics ?? '') && r.value.events === 3, JSON.stringify(r).slice(0, 300));

    // CalDAV: the password lives in DSH's credential store only.
    const python = findRadicale();
    let caldavAccount;
    if (python) {
        const password = `pw-${randomUUID()}`;
        radicale = await startRadicale(python, 'alice', password);
        r = await api('addAccount', { input: { kind: 'caldav', url: radicale.base, username: 'alice', password, preset: 'other', name: 'Home server', allowHttp: true } });
        caldavAccount = r.value?.account;
        check('a CalDAV account is added', r.ok && caldavAccount?.kind === 'caldav', JSON.stringify(r));
        const homeCal = await waitFor(async () => {
            const s = (await api('state')).value;
            return s?.calendars?.find((c) => c.accountId === caldavAccount?.id && c.name === 'Home');
        }, 'the CalDAV calendar', 20000).catch(() => undefined);
        r = await api('createEvent', { input: { calendarId: homeCal?.id, title: 'Plumber', start: '2026-10-15T08:00' } });
        const plumber = r.value?.occurrence;
        check('an event is written to the CalDAV server', r.ok && plumber?.calendarId === homeCal?.id, JSON.stringify(r));
        const davAuth = { Authorization: `Basic ${Buffer.from(`alice:${password}`).toString('base64')}` };
        const listed = await (await fetch(new URL('alice/home/', radicale.base), { method: 'PROPFIND', headers: { Depth: '1', ...davAuth } })).text();
        check('the server has it', listed.includes('.ics'));
        // Someone moves it in another app meanwhile: a delete decided on the event as it was stops, and says so.
        const resource = new URL([...listed.matchAll(/<(?:[\w-]+:)?href>([^<]+\.ics)<\/(?:[\w-]+:)?href>/g)][0]?.[1] ?? 'missing.ics', radicale.base);
        const elsewhere = (await (await fetch(resource, { headers: davAuth })).text()).replace('SUMMARY:Plumber', 'SUMMARY:Plumber (now at 9)');
        const moved = await fetch(resource, { method: 'PUT', headers: { ...davAuth, 'Content-Type': 'text/calendar; charset=utf-8' }, body: elsewhere });
        r = await api('deleteEvent', { id: plumber?.id, scope: 'all' });
        const kept = await fetch(resource, { headers: davAuth });
        check('a delete stops when the event changed on its server meanwhile, and says so', moved.ok && !r.ok && /changed on its server meanwhile/.test(r.error?.message ?? '')
            && kept.status === 200 && (await kept.text()).includes('Plumber (now at 9)'), `${moved.status} ${JSON.stringify(r)} ${kept.status}`);
        r = await api('deleteEvent', { id: plumber?.id, scope: 'all' });
        check('looked at again, it is deleted', r.ok && (await fetch(resource, { headers: davAuth })).status === 404, JSON.stringify(r));
        const creds = readText(credentialsFile);
        check('the password is in DSH\'s credential store under the plugin\'s record', creds.includes(`calendar/${caldavAccount?.id}`) && creds.includes(password));
        const leaks = [storeFile, logFile, join(calendarDir, 'events', `${homeCal?.id}.json`)].filter((f) => readText(f).includes(password));
        check('and nowhere in the plugin\'s files or log', leaks.length === 0, leaks.join(', '));
        r = await api('removeAccount', { id: caldavAccount?.id });
        check('removing the account removes its password', r.ok && !readText(credentialsFile).includes(password), JSON.stringify(r));
    } else {
        console.log('# skipped the CalDAV account: set RADICALE_VENV to a virtualenv with radicale installed');
    }

    // Agents' tools, on Full access.
    let call = await agentCall('calendar_events', { from: '2026-10-12', to: '2026-10-18' });
    check('agents are offered the calendar tools', ['calendar_list_calendars', 'calendar_events', 'calendar_search', 'calendar_get_event', 'calendar_free_time',
        'calendar_create_event', 'calendar_update_event', 'calendar_delete_event', 'calendar_respond'].every((t) => call.offered.includes(t)), call.offered.join(', '));
    check('calendar_events lists the week in the user\'s zone', /Times are in Europe\/Berlin/.test(call.result) && /09:30–10:15 {2}Dentist/.test(call.result)
        && /10:00–10:15 {2}Standup/.test(call.result) && /repeats: Every week on Monday, Wednesday and Friday \(this one changed\)/.test(call.result), call.result);
    call = await agentCall('calendar_create_event', { title: 'Haircut', start: '2026-10-16T17:00', end: '2026-10-16T17:45' });
    check('on Full access an agent adds an event without asking', /^TOOL-RESULT: Added:/.test(call.result) && /17:00–17:45 {2}Haircut/.test(call.result), call.result);
    check('the write rule is logged, without the event', /policy calendar_create_event access=danger-full-access allow/.test(readText(logFile)) && !readText(logFile).includes('Haircut'));
    const haircut = (await api('search', { query: 'haircut' })).value?.occurrences?.[0];
    call = await agentCall('calendar_update_event', { id: haircut?.id ?? 'missing', location: 'Main Street 5' });
    check('an agent changes an event', /^TOOL-RESULT: Changed:/.test(call.result) && /Haircut · Personal · Main Street 5/.test(call.result), call.result);
    call = await agentCall('calendar_update_event', { id: haircut?.id ?? 'missing', title: '', location: '', clear: ['location'] });
    check('and empties a field with clear (an empty string changes nothing)', /^TOOL-RESULT: Changed:/.test(call.result) && /Haircut/.test(call.result) && !/Main Street/.test(call.result), call.result);
    call = await agentCall('calendar_update_event', { id: wednesday.id, title: 'Standup (moved)' });
    check('a change to a repeating event without a scope is sent back to ask the user', /scope "one"/.test(call.result) && /Ask the user/.test(call.result), call.result);
    const feedCalendar = (await api('state')).value?.calendars?.find((c) => c.accountId === feedAccount?.id);
    call = await agentCall('calendar_update_event', { id: wednesday.id, scope: 'one', calendar_id: feedCalendar?.id ?? 'missing', start: '2026-10-14T11:00' });
    const standups = (await api('events', { from: Date.parse('2026-10-12T00:00:00+02:00'), to: Date.parse('2026-10-19T00:00:00+02:00') })).value?.occurrences?.filter((o) => o.title.startsWith('Standup')) ?? [];
    check('one occurrence isn\'t moved to another calendar, and the series stays whole where it is', /Only a whole event or series moves to another calendar/.test(call.result)
        && standups.length === 3 && standups.every((o) => o.calendarId === personal.id), `${call.result} ${JSON.stringify(standups.map((o) => o.calendarId))}`);
    call = await agentCall('calendar_create_event', { title: 'Party', start: '2026-10-17T19:00', guests: ['ann@example.com'], notify_guests: true });
    check('telling guests from a calendar that can\'t email is refused before anything is made', /Calendars kept in DSH can't email anyone/.test(call.result)
        && (await api('search', { query: 'party' })).value?.occurrences?.length === 0, call.result);
    call = await agentCall('calendar_free_time', { from: '2026-10-13', to: '2026-10-13', minutes: 60 });
    check('free time leaves out busy times', /Free slots:/.test(call.result) && /10:15–17:00/.test(call.result), call.result);
    await stopDsh(child);

    // 2. Read Only: agents read, but can't change calendars.
    child = await boot(dsh, 'read-only', 'Read Only');
    call = await agentCall('calendar_create_event', { title: 'Sneaky', start: '2026-10-17T10:00' });
    check('on Read Only an agent can\'t add an event, and is told why', /Read Only/.test(call.result) && /can read the user's calendars but not change them/.test(call.result), call.result);
    call = await agentCall('calendar_get_event', { id: haircut?.id ?? 'missing' });
    check('but reads them', /Haircut/.test(call.result) && /calendar: Personal/.test(call.result), call.result);
    await stopDsh(child);

    // 3. Workspace Write: a change asks the user first, saying what would change; stopped unanswered, it doesn't happen.
    child = await boot(dsh, 'workspace-write', 'Workspace Write');
    const { sessionId: askingSession } = await bridge('POST', '/sessions', { workspacePath: ws, text: `E2E:call calendar_delete_event ${JSON.stringify({ id: haircut?.id ?? 'missing' })}` });
    const question = await waitFor(async () => {
        const got = (await bridge('GET', `/sessions/${askingSession}/events?types=approval/asked&limit=20&full=1`)).events ?? [];
        return got.find((e) => e.type === 'approval/asked');
    }, 'the approval question', 60000).catch(() => undefined);
    check('on Workspace Write a change asks the user first', question !== undefined && /policy calendar_delete_event access=workspace-write ask/.test(readText(logFile)));
    await bridge('POST', `/sessions/${askingSession}/cancel`, {});
    await waitFor(async () => (await bridge('GET', `/sessions/${askingSession}`)).status !== 'running', 'the stopped turn', 30000).catch(() => {});
    check('unanswered, the change doesn\'t happen', (await webApi(await signInWeb(), 'dsh-plugin-calendar/search', { query: 'haircut' })).value?.occurrences?.length === 1);
    // Answered as the prompt's Allow once and Reject do.
    const asking = await signInWeb();
    const prompts = await approvalsOf(asking);
    const titleNow = async () => (await webApi(asking, 'dsh-plugin-calendar/search', { query: 'haircut' })).value?.occurrences?.[0]?.title;
    try {
        const ofRename = (from) => (q) => q.toolName === 'calendar_update_event' && String(q.reason ?? '').includes(`Change “${from}” (2026-10-16 17:00, Personal): title?`);
        let pending = agentCall('calendar_update_event', { id: haircut?.id ?? 'missing', title: 'Haircut at 5' });
        let prompt = await prompts.next('the rename prompt', ofRename('Haircut')).catch(() => undefined);
        const allowed = prompt ? await prompts.answer(prompt, 'allowed-once') : undefined;
        call = await pending;
        check('allowed, the change is made', allowed?.ok === true && /^TOOL-RESULT: Changed:/.test(call.result) && await titleNow() === 'Haircut at 5',
            `${JSON.stringify(prompt?.request)} ${JSON.stringify(allowed)} ${call.result}`);
        pending = agentCall('calendar_update_event', { id: haircut?.id ?? 'missing', title: 'Haircut, cancelled' });
        prompt = await prompts.next('the second rename prompt', ofRename('Haircut at 5')).catch(() => undefined);
        const rejected = prompt ? await prompts.answer(prompt, 'rejected') : undefined;
        call = await pending;
        check('rejected, it isn\'t, and the model hears so', rejected?.ok === true && !/^TOOL-RESULT: Changed:/.test(call.result) && await titleNow() === 'Haircut at 5',
            `${JSON.stringify(rejected)} ${call.result}`);
    } finally {
        prompts.close();
    }
    await stopDsh(child);
    const reason = sessionEvents(askingSession).find((e) => e.type === 'approval/asked')?.data?.reason ?? '';
    check('the question says what would change', reason === 'Calendar: Delete “Haircut” (2026-10-16 17:00, Personal)?', reason);

    // 4. agentChanges: off, even on Full access; and the restart kept everything.
    writeProfile(model.port, { agentChanges: 'off' });
    child = await boot(dsh, 'danger-full-access', 'agentChanges off');
    call = await agentCall('calendar_delete_event', { id: haircut?.id ?? 'missing' });
    check('with agentChanges off no agent changes calendars', /switched off/.test(call.result) && /Haircut/.test(JSON.stringify((await webApi(await signInWeb(), 'dsh-plugin-calendar/search', { query: 'haircut' })).value)), call.result);
    const web2 = await signInWeb();
    r = await webApi(web2, 'dsh-plugin-calendar/events', { from, to });
    check('a restart keeps the calendars and their events', r.ok && r.value?.occurrences?.length === 5 && r.value.occurrences.some((o) => o.id === wednesday.id && o.startLocal === '2026-10-14T10:00'),
        JSON.stringify(r.value?.occurrences?.map((o) => `${o.startLocal} ${o.title}`)));
    r = await webApi(web2, 'dsh-plugin-calendar/state', {});
    check('with the subscription', r.ok && r.value?.accounts?.some((a) => a.id === feedAccount?.id), JSON.stringify(r.value?.accounts));
    check('no event text in the log', !/Dentist|Standup|Haircut|Main Street|Plumber|Team offsite|Party|ann@example/.test(readText(logFile)), readText(logFile).slice(-800));
} catch (error) {
    failed += 1;
    console.log(`not ok - the run stopped: ${redact(error?.stack ?? error)}`);
} finally {
    await stopDsh(child);
    radicale?.server.kill();
    feed.close();
    await model.close();
    if (failed > 0) console.log(redact(`# DSH log tail:\n${readText(dshLog).split('\n').slice(-40).join('\n')}\n# calendar log tail:\n${readText(logFile).split('\n').slice(-20).join('\n')}`));
    if (process.env.KEEP === '1') console.log(`# kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
    if (sockDir !== root) rmSync(sockDir, { recursive: true, force: true });
}

console.log(`\n# ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
