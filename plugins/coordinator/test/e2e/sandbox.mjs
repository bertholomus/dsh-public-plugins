#!/usr/bin/env node
/**
 * Real-host test: where a thread on Workspace Write can write, and what
 * happens when it tries to write outside its folder.
 *
 * Boots a real DSH (the shipped web profile, a temporary DSH_HOME, no MCP
 * servers) with this repo's coordinator and session-bridge plugins and a
 * scripted model, with DSH's default set to Full access (approvals
 * "never"), as in the user's DSH. A chat runs /coordinate and starts a
 * thread, which writes one file inside its folder and one just outside it,
 * first plainly and then with DSH's wider
 * access retry, with DSH's write tool and then in its shell (which DSH runs
 * under the system's sandbox: sandbox-exec on macOS, bubblewrap or Landlock
 * on Linux, and refuses to run without one); a plain session on DSH's
 * default writes outside as a control. It prints which approval policy the
 * thread runs on and what DSH did with each write.
 *
 *   DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node plugins/coordinator/test/e2e/sandbox.mjs
 *
 * Without DSH_BIN it runs `dsh` from PATH; DSH_BIN may also be a program
 * that runs DSH (a script around an app's own runtime, say). It runs on
 * Linux and macOS.
 * Workspace Write also lets a session write /tmp and the system temp folder,
 * so the test folder is made in the home folder (a hidden folder, removed at
 * the end; KEEP=1 keeps it) and DSH gets a temp folder inside it.
 */
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeModel } from './fake-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = resolve(here, '../../..');
/** The chat that runs /coordinate. */
const CHAT = 'Sandbox Check';

function findDsh() {
    const bin = process.env.DSH_BIN;
    if (bin) return bin.endsWith('.js') ? [process.execPath, bin] : [bin];
    try {
        const found = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
        if (found) return [found];
    } catch {}
    return null;
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? 'ok' : 'not ok'} - ${name}${!ok && detail ? `\n    ${detail}` : ''}`);
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

const dsh = findDsh();
if (!dsh) {
    console.log('skipped: set DSH_BIN to a DSH bin.js (or put dsh on PATH) to run the real-host test');
    process.exit(0);
}

// Not under /tmp or the system temp folder: Workspace Write lets a session write there.
const root = mkdtempSync(join(homedir(), '.dsh-sandbox-e2e-'));
const home = join(root, 'home');
const ws = join(root, 'ws');
const plain = join(root, 'plain');
const tmp = join(root, 'tmp');
const stateDir = join(root, 'state');
const storeFile = join(stateDir, 'coordinator.json');
const logFile = join(stateDir, 'coordinator.log');
const sock = join(root, 'bridge.sock');
const dshLog = join(root, 'dsh.log');
const inside = join(ws, 'inside.txt');
/** Just outside the thread's folder: next to it. */
const beside = join(root, 'beside.txt');
/** Where the control session (on DSH's default) writes, also outside its folder. */
const control = join(root, 'control.txt');
for (const dir of [ws, plain, tmp]) mkdirSync(dir, { recursive: true });

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

/** GET from the DSH web server. */
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

/** Sign in to DSH's web server as a browser does, from the sign-in link in its log. */
async function signInWeb() {
    const signIn = [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1] ?? '';
    const cookie = String((await httpGet(signIn)).headers['set-cookie']?.[0] ?? '').split(';')[0];
    return { base: new URL('./', signIn), cookie };
}

/** Call a Remote endpoint the way the window does: POST /api/<endpoint> with a client-request envelope. */
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

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const store = () => { try { return JSON.parse(readFileSync(storeFile, 'utf8')); } catch { return {}; } };
/** The chat's session id, once the test made it: the store keeps a coordinating chat under it. */
let chat;
const project = () => (chat ? store().projects?.[chat] ?? {} : {});
/** The model sees "E2E:call <tool> <json>" and calls that tool (fake-model.mjs). */
const call = (tool, args) => `E2E:call ${tool} ${JSON.stringify(args)}`;
const events = async (sessionId, types) => (await bridge('GET', `/sessions/${sessionId}/events?types=${types}&limit=500&full=1`)).events;
/**
 * A session's permission state as DSH records it ({preset, sandbox, approval}), from the projection
 * cache DSH writes when a session is made and after every turn ends.
 */
function permissionsOf(sessionId) {
    try {
        const doc = JSON.parse(readFileSync(join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), 'utf8'));
        return doc?.record?.rows?.permissions?.val ?? null;
    } catch {
        return null;
    }
}

function writeProfile(modelPort) {
    const profile = join(home, 'profiles', 'web');
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    const plugins = { 'dsh-plugin-coordinator': join(pluginsDir, 'coordinator'), 'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge') };
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: Object.fromEntries(Object.entries(plugins).map(([name, dir]) => [name, `link:${dir}`])),
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(plugins)] } },
    }, null, 2)}\n`);
    for (const [name, dir] of Object.entries(plugins)) symlinkSync(dir, join(profile, 'node_modules', name), 'dir');
    const q = JSON.stringify;
    // DSH's default is Full access with approvals "never", as in the user's DSH; the presets are DSH's own.
    writeFileSync(join(profile, 'cordis.patch.yml'), `- id: permission
  config:
    defaultPreset: danger-full-access
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
- id: agent-default-model
  config:
    provider: fake
    model: fake-model
- id: llm-pi-ai
  config:
    providers:
      fake:
        displayName: Fake
        api: openai-completions
        baseURL: ${q(`http://127.0.0.1:${modelPort}/v1`)}
        apiKeyEnv: FAKE_LLM_KEY
        models:
          - id: fake-model
            name: Fake Model
            contextWindow: 131072
            reasoningEfforts: false
- id: coordinator
  config:
    approvalNoticeSeconds: 1
    storeFile: ${q(storeFile)}
    memoryDir: ${q(join(stateDir, 'memory'))}
    logFile: ${q(logFile)}
- id: session-bridge
  config:
    socketPath: ${q(sock)}
    logFile: ${q(join(root, 'bridge.log'))}
`);
}

function startDsh() {
    const out = openSync(dshLog, 'a');
    const local = '127.0.0.1,localhost';
    const child = spawn(dsh[0], [...dsh.slice(1), '--profile', 'web', '--no-open', '--port', '0'], {
        cwd: ws,
        // DSH's temp folder is inside the test folder, so it doesn't open up the place "outside" is checked.
        env: { ...process.env, DSH_HOME: home, TMPDIR: tmp, FAKE_LLM_KEY: 'sk-fake', DSH_TELEMETRY_DISABLED: '1', NO_PROXY: local, no_proxy: local },
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

const model = await startFakeModel({ models: ['fake-model'] });
writeProfile(model.port);
const resultsSince = (mark, needle) => model.requests.slice(mark).map((r) => r.action.text ?? '').filter((t) => t.startsWith('TOOL-RESULT:') && (!needle || t.includes(needle)));
/** Tool results the thread (not its chat) saw since `mark`. */
const threadResultsSince = (mark) => model.requests.slice(mark).filter((r) => r.system.includes('You are thread t1, '))
    .map((r) => r.action.text ?? '').filter((t) => t.startsWith('TOOL-RESULT:'));
const coordinatorSaw = (mark, reply) => model.requests.slice(mark).some((r) => r.action.text === reply && r.system.includes('# Coordinating threads'));

async function waitIdle(sessionId, timeout = 30000) {
    await waitFor(async () => {
        const s = await bridge('GET', `/sessions/${sessionId}`);
        return s.status === 'idle' && s.turns.started === s.turns.ended;
    }, `session ${sessionId} to be idle`, timeout);
}

let child;
const summary = {};
try {
    child = startDsh();
    await waitFor(async () => existsSync(sock) && (await bridge('GET', '/health')).ok, 'the session bridge', 120000);
    // A chat in the folder runs /coordinate, typed as the window sends it.
    chat = (await bridge('POST', '/sessions', { workspacePath: ws, title: CHAT, text: 'Hello.' })).sessionId;
    await waitFor(() => model.requests.some((r) => r.fresh.includes('Hello.')), 'the chat\'s first turn', 60000);
    await waitIdle(chat);
    const web = await signInWeb();
    const answer = await webApi(web, 'commands/execute', { agentId: chat, line: '/coordinate', submittedAttachments: [] });
    check('the chat coordinates after /coordinate', answer.ok && answer.value?.result?.kind === 'success' && project().coordinatorSessionId === chat,
        JSON.stringify(answer).slice(0, 300));

    // 1. The chat starts a thread whose brief writes inside its folder.
    let mark = model.requests.length;
    await bridge('POST', `/sessions/${chat}/prompt`, {
        text: call('thread_start', { ask: 'Write a note in the project folder.', title: 'Notes', brief: call('write', { file_path: inside, content: 'inside\n' }) }),
    });
    const thread = await waitFor(() => project().threads?.t1?.sessionId, 'the thread session');
    await waitFor(() => resultsSince(mark).some((t) => t.includes(inside) || /wrote|created|written/i.test(t)), 'the inside write', 60000).catch(() => null);
    await waitIdle(thread);
    // DSH writes the cache after the turn ends, so an earlier record (the one from the thread's creation) can still be there.
    let mine = null;
    await waitFor(() => (mine = permissionsOf(thread))?.preset === 'workspace-write', 'the thread\'s permission record', 15000).catch(() => null);
    const theirs = permissionsOf(chat);
    summary.thread = mine;
    summary.chat = theirs;
    check('the thread runs on Workspace Write with approvals "ask", though DSH\'s default here is Full access with approvals "never"',
        mine?.preset === 'workspace-write' && mine.sandbox === 'workspace-write' && mine.approval === 'ask', JSON.stringify(mine));
    check('its chat keeps its own permission, DSH\'s default here', theirs?.preset === 'danger-full-access' && theirs.sandbox === 'danger-full-access', JSON.stringify(theirs));
    const order = (await events(thread, 'permission/preset,user/message')).map((e) => e.type);
    check('the thread is on Workspace Write before it reads its brief', order.indexOf('permission/preset') >= 0 && order.indexOf('permission/preset') < order.indexOf('user/message'), JSON.stringify(order));
    check('a write inside its folder goes through', readText(inside) === 'inside\n', JSON.stringify(resultsSince(mark)).slice(0, 400));

    // 2. The chat sends the thread on to a file just outside its folder.
    const send = (text) => bridge('POST', `/sessions/${chat}/prompt`, { text: call('thread_send', { thread: 't1', text }) });
    await waitIdle(chat);
    mark = model.requests.length;
    await send(call('write', { file_path: beside, content: 'outside\n' }));
    const refused = await waitFor(() => resultsSince(mark).find((t) => t.includes('sandbox')), 'the outside write\'s result', 60000);
    await waitIdle(thread);
    summary.plainWriteOutside = refused.replace('TOOL-RESULT: ', '').slice(0, 300);
    check('a plain write just outside its folder is refused by DSH\'s sandbox, and nothing is written', !existsSync(beside)
        && refused.includes('[sandbox: file access denied under workspace-write mode]'), refused.slice(0, 400));
    check('DSH tells the model it may retry once with wider access, which asks the user', refused.includes('the approval prompt asks the user'), refused.slice(0, 400));
    check('the refusal itself asks nothing', (await events(thread, 'approval/asked')).length === 0);

    // 3. The retry with wider access, as DSH's note says: DSH asks the user, and nothing is written meanwhile.
    await waitIdle(chat);
    mark = model.requests.length;
    await send(call('write', { file_path: beside, content: 'outside\n', sandbox_permissions: 'danger-full-access', justification: 'The user asked for a note next to the project folder.' }));
    await waitFor(async () => (await events(thread, 'approval/asked')).length > 0, 'DSH\'s approval request', 60000);
    summary.retryWithWiderAccess = 'DSH asks the user (approval/asked) and the turn waits for the answer';
    const waiting = await bridge('GET', `/sessions/${thread}`);
    check('the retry raises DSH\'s approval request, the thread waits on it, and nothing is written yet', waiting.turns.started > waiting.turns.ended && !existsSync(beside), JSON.stringify(waiting.turns));
    await waitFor(() => coordinatorSaw(mark, 'SAW-APPROVAL'), 'the chat\'s approval note', 30000).catch(() => null);
    const note = model.requests.slice(mark).find((r) => r.action.text === 'SAW-APPROVAL');
    check('the chat is told the thread waits on the user\'s approval of the write', note?.fresh.includes('[Thread waiting for approval: t1 · "Notes"]') === true
        && note.fresh.includes('It asked to use write') && note.fresh.includes('The user asked for a note next to the project folder.'), note?.fresh.slice(0, 400) ?? 'no note');

    // 4. The user stops it instead of answering: nothing is written.
    await bridge('POST', `/sessions/${thread}/cancel`, {});
    await waitIdle(thread);
    await sleep(500);
    check('stopped without an answer, nothing is written outside', !existsSync(beside));

    // 5. The same in the thread's shell, which DSH confines with a sandbox backend (sandbox-exec on macOS,
    //    bubblewrap or Landlock on Linux); without one it refuses to run the command at all.
    const shell = (command, extra = {}) => call('bash', { command, description: 'Write a note', ...extra });
    const insideShell = join(ws, 'inside-shell.txt');
    const besideShell = join(root, 'beside-shell.txt');
    await waitIdle(chat);
    mark = model.requests.length;
    await send(shell(`printf 'inside\\n' > ${JSON.stringify(insideShell)}`));
    const ran = await waitFor(() => threadResultsSince(mark)[0], 'the shell write inside', 60000);
    await waitIdle(thread);
    const unavailable = /no sandbox backend is usable/.test(ran);
    summary.shellInside = unavailable ? ran.replace('TOOL-RESULT: ', '').slice(0, 400) : (readText(insideShell) === 'inside\n' ? 'written' : ran.slice(0, 300));
    check('the thread\'s shell runs on Workspace Write (DSH has a sandbox backend here) and writes inside its folder', !unavailable && readText(insideShell) === 'inside\n', ran.slice(0, 500));
    if (!unavailable) {
        await waitIdle(chat);
        mark = model.requests.length;
        await send(shell(`printf 'outside\\n' > ${JSON.stringify(besideShell)}`));
        const denied = await waitFor(() => threadResultsSince(mark)[0], 'the shell write outside', 60000);
        await waitIdle(thread);
        summary.shellOutside = denied.replace('TOOL-RESULT: ', '').slice(0, 400);
        check('the thread\'s shell can\'t write just outside its folder, and DSH says a retry asks the user', !existsSync(besideShell)
            && denied.includes('the approval prompt asks the user'), denied.slice(0, 500));
        const before = (await events(thread, 'approval/asked')).length;
        await waitIdle(chat);
        mark = model.requests.length;
        await send(shell(`printf 'outside\\n' > ${JSON.stringify(besideShell)}`, { sandbox_permissions: 'danger-full-access', justification: 'The user asked for a note next to the project folder.' }));
        await waitFor(async () => (await events(thread, 'approval/asked')).length > before, 'DSH\'s approval request for the shell', 60000).catch(() => null);
        const asked = (await events(thread, 'approval/asked')).length > before;
        const held = await bridge('GET', `/sessions/${thread}`);
        check('the shell\'s retry with wider access raises DSH\'s approval request, and nothing is written', asked && held.turns.started > held.turns.ended && !existsSync(besideShell),
            JSON.stringify({ asked, turns: held.turns, results: threadResultsSince(mark) }).slice(0, 500));
        await bridge('POST', `/sessions/${thread}/cancel`, {});
        await waitIdle(thread);
        await sleep(500);
        check('stopped without an answer, the shell wrote nothing outside', !existsSync(besideShell));
    }

    // 6. Control: a session on DSH's default (Full access, approvals "never") writes outside its folder without asking,
    //    with the write tool and with its shell.
    mark = model.requests.length;
    const own = await bridge('POST', '/sessions', { workspacePath: plain, text: call('write', { file_path: control, content: 'control\n' }) });
    await waitFor(() => resultsSince(mark)[0], 'the control write', 60000);
    await waitIdle(own.sessionId);
    check('a session on DSH\'s default writes outside its folder without asking', readText(control) === 'control\n'
        && (await events(own.sessionId, 'approval/asked')).length === 0, JSON.stringify(resultsSince(mark)).slice(0, 300));
    const controlShell = join(root, 'control-shell.txt');
    mark = model.requests.length;
    await bridge('POST', `/sessions/${own.sessionId}/prompt`, { text: shell(`printf 'control\\n' > ${JSON.stringify(controlShell)}`) });
    await waitFor(() => resultsSince(mark)[0], 'the control shell write', 60000);
    await waitIdle(own.sessionId);
    check('its shell does too', readText(controlShell) === 'control\n' && (await events(own.sessionId, 'approval/asked')).length === 0, JSON.stringify(resultsSince(mark)).slice(0, 300));
} catch (error) {
    failed += 1;
    console.log(`not ok - scenario aborted: ${error.message}`);
    console.log(readText(dshLog).split('\n').slice(-30).join('\n'));
} finally {
    await stopDsh(child);
    await model.close();
    console.log(`\nWhat DSH did: ${JSON.stringify(summary, null, 2)}`);
    console.log(`\n${passed} passed, ${failed} failed (${process.platform})`);
    if (process.env.KEEP) console.log(`kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
