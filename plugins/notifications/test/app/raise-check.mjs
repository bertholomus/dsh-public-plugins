#!/usr/bin/env node
/**
 * The click on a notification in DSH's Desktop app, checked in a DSH Test
 * instance's own app window (macOS): the window hidden by its close button,
 * minimised, and behind another window. For each, news with a chat goes out
 * through the stand-in caller plugin, the window shows it, the click runs,
 * and the check reads whether the window came up in front, on that chat,
 * and what the plugin's log says.
 *
 *   node plugins/notifications/test/app/raise-check.mjs --instance <name> [--port 19648] [--shots DIR]
 *
 * Before: `dsh-test --name <name> up`, `load plugins/notifications`,
 * `load plugins/notifications/test/e2e/caller`, `restart`. The check stops
 * the instance and starts it again the way dsh-test does, with a local
 * debugging port added; at the end it stops it (`dsh-test up` starts it
 * again as before).
 *
 * What stands in for a person:
 * - No banner reaches the screen: the window's Web Notifications are a
 *   recorder, and the click is the recorder's onclick (the handler a real
 *   banner's click calls), run with a user gesture as that click is. A real
 *   click also makes the system bring the app forward; this one does not,
 *   so the check is the harder case.
 * - The close and minimise buttons are pressed through the accessibility
 *   API on that window only (it needs accessibility access for the
 *   terminal); "behind" is a browser window of the check's own in front.
 * - The window is read over a bare debugging connection (no automation
 *   emulation, so its visibility and focus are its own), and its place from
 *   the window server's list (metadata of that one app's windows: no pixels).
 *   Pictures are of that window's own page, never of the screen.
 *
 * Exit 0 when all three come up on the right chat.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(here, '..', '..', '..', '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const instance = option('instance');
const port = Number(option('port', '19648'));
const shots = resolve(option('shots', join(repoRoot, '.e2e', 'shots', 'notifications', 'app-window')));
if (!instance || process.platform !== 'darwin') {
    console.error('usage (macOS): node plugins/notifications/test/app/raise-check.mjs --instance <DSH Test name> [--port 19648] [--shots DIR]');
    process.exit(2);
}
const DSH_TEST = process.env.DSH_TEST_BIN ?? join(homedir(), '.local', 'bin', 'dsh-test');
const APP = process.env.DSH_TEST_APP ?? '/Applications/DeepSeek Harness.app';
const APP_BIN = join(APP, 'Contents', 'MacOS', basename(APP, '.app'));
const testHome = join(homedir(), `.dsh-test-${instance}`);
const userData = `${testHome}-electron`;
if (!existsSync(testHome)) {
    console.error(`no DSH Test instance "${instance}" (${testHome}); make it with dsh-test --name ${instance} up, load the plugin and the caller, restart`);
    process.exit(2);
}
const dshTest = (...args) => execFileSync(DSH_TEST, ['--name', instance, ...args], { encoding: 'utf8' });

mkdirSync(shots, { recursive: true });
const report = [];
const say = (line) => {
    const stamp = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
    report.push(`${stamp} ${line}`);
    console.log(`${stamp} ${line}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, every = 200) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await fn().catch(() => undefined);
        if (value) return value;
        if (Date.now() > end) return undefined;
        await sleep(every);
    }
}
const portOpen = (p) => new Promise((done) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/', timeout: 1500 }, (res) => { res.resume(); done(true); });
    req.on('error', () => done(false));
    req.on('timeout', () => { req.destroy(); done(false); });
});

// 1. Start the instance again with a local debugging port, as dsh-test starts it.
say(`stopping DSH Test "${instance}": ${dshTest('down').trim().split('\n').at(-1)}`);
const logs = join(testHome, 'logs');
mkdirSync(logs, { recursive: true });
for (const log of ['desktop.out.log', 'desktop.err.log']) if (existsSync(join(logs, log))) renameSync(join(logs, log), join(logs, `${log}.1`));
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING', 'SSH_AUTH_SOCK']) if (process.env[key] !== undefined) env[key] = process.env[key];
const opened = spawnSync('/usr/bin/open', [
    '-n', '-g', '-a', APP,
    '--env', `DSH_HOME=${testHome}`,
    '--env', 'DSH_TELEMETRY_DISABLED=1',
    '--env', 'DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS=2147483647',
    '--env', 'DSH_TEST_INSTANCE=1',
    '--stdout', join(logs, 'desktop.out.log'), '--stderr', join(logs, 'desktop.err.log'),
    '--args', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`,
], { encoding: 'utf8', env });
if (opened.status !== 0) throw new Error(`open failed: ${opened.stderr}`);
const appPid = await waitFor(async () => {
    const table = execFileSync('ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8' }).split('\n');
    const line = table.find((row) => row.trim().split(/\s+/).length > 1 && row.includes(`${APP_BIN} `) && row.includes(`--user-data-dir=${userData} `) && row.includes(`--remote-debugging-port=${port}`) && !row.includes('--type='));
    return line ? line.trim().split(/\s+/)[0] : undefined;
}, 30000, 500);
if (!appPid) throw new Error('the DSH Test app did not start');
const link = await waitFor(async () => { const url = dshTest('url').trim().split('\n').find((l) => /^https?:\/\//.test(l)); return url && (await portOpen(new URL(url).port)) ? url : undefined; }, 120000, 1000);
if (!link) throw new Error('DSH Test did not come up');
const order = () => { try { return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', join(here, 'window-order.jxa'), appPid], { encoding: 'utf8', timeout: 5000 })); } catch (e) { return { error: String(e.message).slice(0, 80) }; } };
const buttons = (action) => execFileSync('osascript', ['-l', 'JavaScript', join(here, 'window-buttons.jxa'), appPid, action], { encoding: 'utf8' }).trim();
// The app shows its window once DSH is ready; wait until it has stayed on screen for 2 s, with its DSH window listed.
let steady = 0;
await waitFor(async () => {
    steady = order().onScreen && /DeepSeek Harness/.test(buttons('list')) ? steady + 1 : 0;
    return steady >= 4;
}, 90000, 500);
say(`DSH Test "${instance}" is up again: pid ${appPid}, debugging port ${port} (127.0.0.1 only); its window: ${JSON.stringify(order())}`);

// 2. DSH's own API, signed in with the instance's link (kept in memory only).
function request(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((done, fail) => {
        const req = http.request(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', fail);
        req.end(body);
    });
}
const signIn = await request(new URL(link));
const cookie = String(signIn.headers['set-cookie']?.[0] ?? '').split(';')[0];
if (!cookie) throw new Error(`sign-in refused (HTTP ${signIn.status})`);
const base = new URL('./', link);
async function call(endpoint, args = {}) {
    const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } });
    const res = await request(new URL(`api/${endpoint}`, base), { method: 'POST', headers: { cookie }, body });
    try { return JSON.parse(res.text).result ?? { ok: false }; } catch { return { ok: false }; }
}
const status = async () => (await call('dsh-plugin-notifications/status')).value;
const logFile = join(testHome, 'notifications', 'notifications.log');
const logLines = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '').split('\n').filter(Boolean);
const first = await waitFor(status, 30000, 500);
if (!first) throw new Error('the notifications plugin does not answer: load plugins/notifications and test/e2e/caller, then restart');
say(`the plugin in DSH Test's app: sender ${first.sender}, can bring the window up: ${JSON.stringify(first.raise)}`);

// Three chats with no turns (no model is asked anything), each in a throwaway folder named for its case. DSH lists
// a chat with no turns as "New Session", so the folder's name, which DSH shows above the chat's message box, is what
// tells the pictures apart.
const folders = {};
const chat = (file, title) => {
    folders[file] = mkdtempSync(join(tmpdir(), `raise-${file}-`));
    return JSON.parse(dshTest('bridge', 'POST', '/sessions', JSON.stringify({ workspacePath: folders[file], title }))).sessionId;
};
const chats = { hidden: chat('hidden', 'Raise hidden'), minimised: chat('minimised', 'Raise minimised'), behind: chat('behind', 'Raise behind') };

// 3. A bare debugging connection to the app's window.
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === 'page' && t.url.startsWith('dsh-app://app/'));
if (!target) throw new Error('no app window page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const replies = new Map();
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && replies.has(m.id)) { replies.get(m.id)(m); replies.delete(m.id); }
});
const send = (method, params = {}) => new Promise((done, fail) => {
    const id = nextId++;
    replies.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : done(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression, { gesture = false } = {}) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
}
async function picture(file) {
    const shot = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(8000).then(() => undefined)]);
    if (!shot) return false;
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return true;
}
const state = async () => JSON.parse(await evaluate('JSON.stringify({ visibility: document.visibilityState, focused: document.hasFocus(), title: document.title, notes: (window.__notes || []).length })'));
// DSH keeps its route in memory: an open chat shows in the window's title ("<chat title> — DeepSeek Harness").
const chatOpen = (s, title) => s.title.startsWith(`${title} —`);

// The recorder goes in without a reload (the app shows its window only after its own start); then the
// plugin is switched off and on as the Plugins page does, so its window half starts again and takes it.
say(`recorder: ${await evaluate(`(() => {
    window.__notes = [];
    class RecordedNotification {
        constructor(title, options = {}) {
            this.title = title; this.body = options.body; this.tag = options.tag;
            window.__notes.push(this);
            setTimeout(() => { try { this.onshow && this.onshow(); } catch (e) {} }, 50);
        }
        close() { this.closed = true; }
        static requestPermission() { return Promise.resolve('granted'); }
    }
    RecordedNotification.permission = 'granted';
    Object.defineProperty(window, 'Notification', { value: RecordedNotification, configurable: true, writable: true });
    return 'in place of the window\\'s notifications';
})()`)}`);
const sheets = () => evaluate('document.querySelectorAll(\'style[data-plugin="dsh-plugin-notifications"]\').length');
await call('pluginManager/setBundleEnabled', { name: 'dsh-plugin-notifications', enabled: false });
await waitFor(async () => (await sheets()) === 0, 10000, 300);
await call('pluginManager/setBundleEnabled', { name: 'dsh-plugin-notifications', enabled: true });
const restarted = await waitFor(async () => (await sheets()) === 1 && (await call('dsh-plugin-notifications/status')).ok, 30000, 300);
if (!restarted) throw new Error('the plugin did not start again in the window');
if (!(await evaluate('window.Notification.name === "RecordedNotification"'))) throw new Error('the recorder is not in place');

let n = 0;
async function clickCase(name, file, title) {
    n += 1;
    const news = `Raise check ${n}: ${name}`;
    const before = await state();
    say(`[${name}] before: visibility ${before.visibility}, focused ${before.focused}, window ${JSON.stringify(order())}, chat "${title}" open: ${chatOpen(before, title)}`);
    const sent = await call('dsh-plugin-notifications-e2e-caller/notify', { notification: { title: news, body: 'The window should come up on this chat.', kind: 'handback', sessionId: chats[file] } });
    say(`[${name}] sent through the caller plugin: ${JSON.stringify(sent.value ?? sent.error)}`);
    await evaluate("window.dispatchEvent(new Event('blur'))");
    const shown = await waitFor(async () => (await evaluate(`window.__notes.length > ${before.notes} && window.__notes.at(-1).title`)), 40000, 500);
    say(`[${name}] the window showed it (recorder): ${JSON.stringify(shown)}`);
    if (!shown) return { name, ok: false };
    const entry = await waitFor(async () => (await status()).recent.find((item) => item.title === news), 10000, 300);
    const t0 = Date.now();
    await evaluate('(() => { const note = window.__notes.at(-1); note.onclick && note.onclick(); return true; })()', { gesture: true });
    // Up = on screen, visible, and in front of every other window or the focused one. On a quiet machine it takes
    // about a second; the app started again to hand over can take much longer on a busy one, so the wait is 30 s.
    const up = await waitFor(async () => { const w = order(); const s = await state(); return w.onScreen && s.visibility === 'visible' && (w.inFrontOfIt === 0 || s.focused) ? { w, s } : undefined; }, 30000, 50);
    const took = up ? Date.now() - t0 : undefined;
    await sleep(700);
    const after = await state();
    say(`[${name}] after the click: ${up ? `up in ${took} ms (window ${JSON.stringify(up.w)}, visibility ${up.s.visibility}, focused ${up.s.focused})` : `not up within 30 s (${JSON.stringify(order())})`}; chat "${title}" open: ${chatOpen(after, title)}`);
    const logged = await waitFor(async () => logLines().filter((line) => line.includes(`#${entry?.id} clicked`)).at(-1), 5000, 200);
    say(`[${name}] the plugin's log: ${logged ? logged.replace(/^\S+ /, '') : '(no click line)'}`);
    if (up) {
        // The sidebar lists every folder once; the open chat's folder shows a second time, above its message box.
        const folder = basename(folders[file]);
        const seen = await evaluate(`document.body.innerText.split(${JSON.stringify(folder)}).length - 1`).catch(() => undefined);
        say(`[${name}] the page names the chat's folder ${folder} ${seen ?? '?'} time(s) (twice when its chat is open)`);
        const path = join(shots, `${n}-${file}.png`);
        say(`[${name}] ${(await picture(path)) ? `picture of the DSH Test window's page: ${path}` : 'no picture (the page drew no frame in 8 s)'}`);
    }
    return { name, ok: Boolean(up) && chatOpen(after, title) && !chatOpen(before, title) && Boolean(logged?.includes("brought DSH's window up")) };
}
const down = () => waitFor(async () => { const w = order(); const s = await state(); return !w.onScreen && s.visibility === 'hidden' ? { w, s } : undefined; }, 6000, 150);
const results = [];

// 4. Hidden by its close button (the app hides its window on close; it keeps running).
const closed = buttons('close');
say(`[hidden] close button: ${closed}`);
const hidden = closed === 'pressed: ok' ? await down() : undefined;
say(`[hidden] the window is down: ${hidden ? `visibility ${hidden.s.visibility}, window ${JSON.stringify(hidden.w)}` : `no (${JSON.stringify(order())})`}`);
if (hidden) results.push(await clickCase('hidden by its close button', 'hidden', 'Raise hidden'));

// 5. Minimised: its yellow button.
const minimised = buttons('minimise');
say(`[minimised] minimise button: ${minimised}`);
const mini = minimised === 'pressed: ok' ? await down() : undefined;
say(`[minimised] the window is down: ${mini ? `visibility ${mini.s.visibility}, window ${JSON.stringify(mini.w)}, ${buttons('list')}` : `no (${JSON.stringify(order())})`}`);
if (mini) results.push(await clickCase('minimised', 'minimised', 'Raise minimised'));

// 6. Behind another window: a browser window of the check's own opens in front and takes the focus.
const pwPath = join(repoRoot, '.e2e', 'tools', 'node_modules', 'playwright-core', 'index.mjs');
const pw = await import(existsSync(pwPath) ? pathToFileURL(pwPath).href : 'playwright-core');
const cover = await (pw.chromium ?? pw.default.chromium).launch({ headless: false, args: ['--window-position=700,300', '--window-size=1500,1000'] });
const coverPage = await cover.newPage();
await coverPage.setContent('<title>Raise check: another window</title><body style="font:20px system-ui;padding:40px">A window of the raise check, in front of DSH Test\'s window.</body>');
await coverPage.bringToFront();
const behind = await waitFor(async () => { const w = order(); const s = await state(); return w.onScreen && w.inFrontOfIt > 0 && !s.focused ? { w, s } : undefined; }, 8000, 200);
say(`[behind] the window is behind another and not focused: ${behind ? `window ${JSON.stringify(behind.w)}, visibility ${behind.s.visibility}` : `no (${JSON.stringify(order())})`}`);
if (behind) results.push(await clickCase('behind another window', 'behind', 'Raise behind'));
await cover.close().catch(() => {});

say(`results: ${results.map((r) => `${r.name} ${r.ok ? 'PASS' : 'FAIL'}`).join('; ') || 'none ran'}`);
writeFileSync(join(shots, 'report.txt'), `${report.join('\n')}\n`);
ws.close();
say(`stopping DSH Test "${instance}" (start it again with dsh-test --name ${instance} up): ${dshTest('down').trim().split('\n').at(-1)}`);
writeFileSync(join(shots, 'report.txt'), `${report.join('\n')}\n`);
process.exit(results.length === 3 && results.every((r) => r.ok) ? 0 : 1);
