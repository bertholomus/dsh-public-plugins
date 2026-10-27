#!/usr/bin/env node
/**
 * Real-host end-to-end test for the coordinator plugin.
 *
 * Boots a real DSH (the shipped web profile, in a temporary DSH_HOME) with
 * this repo's coordinator and session-bridge plugins and a scripted model
 * server. An ordinary chat runs /coordinate; the test then drives it and its
 * threads through the bridge socket and the window's own endpoints, and
 * checks what reached the model: models and efforts on the wire, tool
 * scoping, handbacks, the plugin's nudges and automatic notes (idle,
 * failed, stopped, waiting on approval, cut off by a DSH crash), queued
 * turns, a message that reaches a thread's running turn, direct talk,
 * settings, memory, pause, /coordinate off and on again, a restart, the
 * window's record of the chat that DSH folds from the command, the browser
 * half DSH serves for the plugin's page, a saved default that applies
 * without a restart, the Thread settings endpoints the window calls, picks
 * in DSH's own model picker, a thread's code changes as DSH records them and
 * its Changes tab reads them (a subagent's too), failed and stopped threads
 * as the window shows them, with Retry and Resume, a second chat that
 * coordinates from its Coordinate button with threads of its own, chats that
 * coordinate before their first message, from DSH's new-chat screen, a chat's
 * message to a chat that doesn't coordinate and to one that does, archive,
 * and the user's tools and permissions: an MCP server named as one of the
 * user's tools that a coordinating chat has, as any chat does, and a thread
 * gets only from the user's words, threads on Workspace Write, and a
 * thread's command that sends outside the workspace waiting for the user's
 * Allow once each time, answered as the window does, while the chat's own
 * runs as DSH decides.
 *
 *   DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node plugins/coordinator/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs `dsh` from PATH. KEEP=1 keeps the temp folder.
 * A DSH to test against: npm install --prefix /tmp/dsh @deepseek-ai/dsh
 * (then DSH_BIN=/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js).
 */
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { startFakeModel } from './fake-model.mjs';
import { STATE_VERSION } from '../../lib/projection.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = resolve(here, '../../..');
/** The chat that runs /coordinate, and a second one that coordinates from its Coordinate button. */
const CHAT = 'E2E Chat';
const SECOND = 'Second Chat';
/** What DSH shows under /coordinate once a chat coordinates. */
const COORDINATING = 'Coordinating. Ask for work here as usual: what runs long or splits into parts goes to threads that report back to this chat.';

// ── harness ─────────────────────────────────────────────────────────────────

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
    if (ok) {
        passed += 1;
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.log(`not ok - ${name}${detail ? `\n    ${detail}` : ''}`);
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

const root = mkdtempSync(join(tmpdir(), 'dsh-coordinator-e2e-'));
const home = join(root, 'home');
const ws = join(root, 'ws');
const stateDir = join(root, 'state');
const storeFile = join(stateDir, 'coordinator.json');
const logFile = join(stateDir, 'coordinator.log');
const memoryDir = join(stateDir, 'memory');
const sock = join(root, 'bridge.sock');
const dshLog = join(root, 'dsh.log');
/** Every call that reaches the stand-in for the user's lane-catalog MCP server (fake-mcp.mjs). */
const mcpCalls = join(root, 'mcp-calls.log');

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

/** Sign in to DSH's web server as a browser does, from the newest sign-in link in its log. */
async function signInWeb() {
    const signIn = [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1] ?? '';
    const cookie = String((await httpGet(signIn)).headers['set-cookie']?.[0] ?? '').split(';')[0];
    return { base: new URL('./', signIn), cookie };
}

/** How many web sign-in links DSH has printed: one each time it starts. */
const signIns = () => [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].length;

/** Sign in again once DSH, started again, has printed a new sign-in link. */
async function signInAgain(before) {
    await waitFor(() => signIns() > before, 'the new web sign-in link', 30000);
    return signInWeb();
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
        }, what),
        answer: (prompt, outcome) => webApi(web, '$events/result', { clientId, eventId: prompt.eventId, outcome: { kind: 'result', value: outcome } }),
        close: () => socket.close(),
    };
}

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const store = () => { try { return JSON.parse(readFileSync(storeFile, 'utf8')); } catch { return {}; } };
/** The session ids of the two coordinating chats, once the test made them. */
let coord;
let second;
/** What the store keeps for the chat: the store keys a coordinating chat by its session id. */
const project = () => (coord ? store().projects?.[coord] ?? {} : {});
const threadSession = (id) => project().threads?.[id]?.sessionId;
const secondThreads = () => Object.values((second ? store().projects?.[second]?.threads : undefined) ?? {});
const modeOf = (file) => statSync(file).mode & 0o777;
const octal = (mode) => mode.toString(8);
/** Lines of the stand-in MCP server's call log. */
const mcpCount = () => readText(mcpCalls).split('\n').filter(Boolean).length;

/** The model sees "E2E:call <tool> <json>" and calls that tool. */
const call = (tool, args) => `E2E:call ${tool} ${JSON.stringify(args)}`;

const profile = join(home, 'profiles', 'web');

function writeProfile(modelPort) {
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    const plugins = {
        'dsh-plugin-coordinator': join(pluginsDir, 'coordinator'), 'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge'),
        // A tool another plugin marks as the user's own, which no guardedTools entry names.
        'dsh-e2e-personal-tool': join(here, 'personal-tool'),
    };
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: Object.fromEntries(Object.entries(plugins).map(([name, dir]) => [name, `link:${dir}`])),
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(plugins)] } },
    }, null, 2)}\n`);
    for (const [name, dir] of Object.entries(plugins)) symlinkSync(dir, join(profile, 'node_modules', name), 'dir');
    writePatch(modelPort, { threadEffort: 'high' });
}

/**
 * Write the profile's cordis.patch.yml with these plugin-wide defaults. DSH
 * watches the file, so a rewrite while it runs is a config save, the same
 * write the defaults form on the plugin's page makes.
 */
function writePatch(modelPort, defaults) {
    const q = JSON.stringify;
    // The DSH default effort is "low", so a thread setting that is missed shows on the wire. lane-catalog
    // stands in for one of the user's MCP servers; new sessions get Full access, as in the user's DSH.
    writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:
    - id: mcp-lane-catalog
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: lane-catalog
        command: ${q(process.execPath)}
        args: [${q(join(here, 'fake-mcp.mjs'))}, ${q(mcpCalls)}]
        failOnStartupError: true
- id: permission
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
    reasoningEffort: low
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
            reasoningEfforts:
              off:
              low: low
              high: high
              max: max
          - id: fake-flash
            name: Fake Flash
            contextWindow: 131072
            reasoningEfforts: false
          - id: fake-mini
            name: Fake Mini
            contextWindow: 131072
            reasoningEfforts:
              off:
              high: high
- id: coordinator
  config:
${Object.entries(defaults).map(([key, value]) => `    ${key}: ${q(value)}\n`).join('')}    storeFile: ${q(storeFile)}
    memoryDir: ${q(memoryDir)}
    logFile: ${q(logFile)}
    guardedTools:
      lane-catalog:
        - lanes
- id: session-bridge
  config:
    socketPath: ${q(sock)}
    logFile: ${q(join(root, 'bridge.log'))}
`);
}

function startDsh(dsh) {
    const out = openSync(dshLog, 'a');
    const local = '127.0.0.1,localhost';
    const child = spawn(dsh[0], [...dsh.slice(1), '--profile', 'web', '--no-open', '--port', '0'], {
        cwd: ws,
        env: { ...process.env, DSH_HOME: home, FAKE_LLM_KEY: 'sk-fake', DSH_TELEMETRY_DISABLED: '1', NO_PROXY: local, no_proxy: local },
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

// ── scenario ────────────────────────────────────────────────────────────────

const dsh = findDsh();
if (!dsh) {
    console.log('skipped: set DSH_BIN to a DSH bin.js (or put dsh on PATH) to run the real-host test');
    process.exit(0);
}

mkdirSync(ws, { recursive: true });
mkdirSync(join(root, 'outside'));
const model = await startFakeModel();
writeProfile(model.port);

/** The chat's folder as its rules name it ("Threads work in: …"), which tells its requests from the second chat's. */
let coordFolder = ws;
/**
 * Who sent a request: a thread of the chat (t3), a thread of the second chat ("Second Chat/t1"), the chat while it
 * coordinates ('coordinator'), the second chat ('second'), or any other session ('other'), the chat after
 * /coordinate off among them.
 */
const whoOf = (r) => {
    const thread = /You are thread (t\d+), ".*", started by the DSH chat "(.*)", your coordinator\./.exec(r.system);
    if (thread) return thread[2] === CHAT ? thread[1] : `${thread[2]}/${thread[1]}`;
    if (!r.system.includes('# Coordinating threads')) return 'other';
    return r.system.includes(`\nThreads work in: ${coordFolder}\n`) ? 'coordinator' : 'second';
};
const since = (mark, who) => model.requests.slice(mark).filter((r) => !who || whoOf(r) === who);
const resultOf = (reqs) => reqs.find((r) => r.action.text?.startsWith('TOOL-RESULT:'))?.action.text ?? '';
const describe = (reqs) => reqs.map((r) => `${r.n} ${whoOf(r)} ${r.model} effort=${r.effort ?? '-'}`).join('; ');

async function waitIdle(sessionId) {
    await waitFor(async () => {
        const s = await bridge('GET', `/sessions/${sessionId}`);
        return s.status === 'idle' && s.turns.started === s.turns.ended;
    }, `session ${sessionId} to be idle`);
}

/** Prompt a session as the user and wait until its turn is over. */
async function say(sessionId, text) {
    const mark = model.requests.length;
    await bridge('POST', `/sessions/${sessionId}/prompt`, { text });
    await waitFor(() => since(mark).some((r) => r.fresh.includes(text)), `the model to see "${text.slice(0, 60)}"`);
    await waitIdle(sessionId);
    return since(mark);
}

/**
 * A session's `coordinatorSession` value (what the DSH window draws, projection.js)
 * as DSH last saved it in its projection cache, which it writes at every turn end.
 */
function windowView(sessionId) {
    try {
        const doc = JSON.parse(readFileSync(join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), 'utf8'));
        return doc?.record?.rows?.coordinatorSession?.val?.v ?? null;
    } catch {
        return null;
    }
}

/** A session's saved `coordinatorSession` row's state version, or null. */
function savedVersion(sessionId) {
    try {
        return JSON.parse(readFileSync(join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), 'utf8'))?.record?.rows?.coordinatorSession?.ver ?? null;
    } catch {
        return null;
    }
}

/** Give sessions' saved `coordinatorSession` rows an older state version, as an older version of the plugin left them (DSH stopped). */
function ageViews(ids, ver) {
    const aged = [];
    for (const id of ids) {
        const file = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
        try {
            const doc = JSON.parse(readFileSync(file, 'utf8'));
            if (!doc?.record?.rows?.coordinatorSession) continue;
            doc.record.rows.coordinatorSession.ver = ver;
            writeFileSync(file, JSON.stringify(doc));
            aged.push(id);
        } catch {}
    }
    return aged;
}

/** Wait for the coordinating chat to answer an automatic message, then for it to be idle. */
async function coordinatorSaw(mark, reply, what) {
    const req = await waitFor(() => since(mark, 'coordinator').find((r) => r.action.text === reply), what);
    await waitIdle(coord);
    return req;
}

let child;
/** The window's signed-in connection to DSH; a new one after each start. */
let web;
/** Type a command in a chat, as DSH's composer sends it (its commands remote). */
const command = (sessionId, line) => webApi(web, 'commands/execute', { agentId: sessionId, line, submittedAttachments: [] });
/**
 * A session's `coordinatorSession` value as the running DSH has it now, which it sends the window. DSH saves its
 * projection cache at a turn's end, so a command's result is read here.
 */
async function viewOf(sessionId) {
    const read = await webApi(web, 'session/projections', { request: { sessionId } });
    const value = read.ok ? read.value?.values?.coordinatorSession : undefined;
    return value?.role ? value : value?.v;
}
/** Each user message in a session: who sent it (its `source`) and its text. */
async function messagesOf(sessionId) {
    const { events } = await bridge('GET', `/sessions/${sessionId}/events?types=user/message&limit=2000&full=1`);
    return events.map((e) => ({ source: e.source, text: e.text ?? '' }));
}
const startingWith = (msgs, prefix) => msgs.findLast((m) => m.text.startsWith(prefix));
const fromPlugin = (m) => m?.source?.kind === 'cordis-host-runner';
const fromSession = (m, sessionId) => m?.source?.kind === 'agent-message' && m.source.form === 'relay' && m.source.senderSessionId === sessionId;
const sourcesText = (msgs) => JSON.stringify(msgs.map((m) => [m.source?.kind, m.source?.senderSessionId?.slice(0, 8), m.text.slice(0, 40)]));

try {
    // 1. Boot. An ordinary chat runs /coordinate, typed as the window sends it: from then on it coordinates
    // threads, kept under its own session id, with private state. DSH logs the command and its result in the
    // chat, and folds the window's record of the chat from them.
    child = startDsh(dsh);
    await waitFor(async () => existsSync(sock) && (await bridge('GET', '/health')).ok, 'the session bridge', 90000);
    coord = (await bridge('POST', '/sessions', { workspacePath: ws, title: CHAT, text: 'Hello, chat.' })).sessionId;
    const plainTurn = await waitFor(() => model.requests.find((r) => r.fresh.includes('Hello, chat.')), 'the chat\'s first turn');
    await waitIdle(coord);
    check('a chat that hasn\'t run /coordinate is a plain chat: no thread tools or rules, nothing in the store', !plainTurn.tools.includes('thread_start')
        && !plainTurn.system.includes('# Coordinating threads') && store().projects?.[coord] === undefined, plainTurn.tools.join(','));
    web = await signInWeb();
    let mark = model.requests.length;
    let answer = await command(coord, '/coordinate');
    check('/coordinate makes it coordinate, and DSH shows the plugin\'s answer under the command', answer.ok && answer.value?.result?.kind === 'success'
        && answer.value.result.text === COORDINATING, JSON.stringify(answer).slice(0, 300));
    coordFolder = project().folder ?? ws;
    check('the store keeps the chat under its session id, with its folder and title', project().coordinatorSessionId === coord && [ws, realpathSync(ws)].includes(project().folder)
        && project().name === CHAT && readText(logFile).includes(`attach coordinator ${coord} ${coord}\n`) && readText(logFile).includes(`coordinate ${coord} on\n`),
        `${JSON.stringify(project()).slice(0, 300)} | ${readText(logFile).slice(0, 400)}`);
    await sleep(1000);
    const ran = (await bridge('GET', `/sessions/${coord}/events?types=command/run,command/done,user/message,turn/start&limit=50`)).events.map((e) => e.type);
    check('/coordinate sends the chat nothing and starts no turn; its title stays the user\'s', since(mark).length === 0
        && ran.slice(ran.indexOf('command/run')).join() === 'command/run,command/done' && (await bridge('GET', `/sessions/${coord}`)).title === CHAT, `${ran.join()} | ${describe(since(mark))}`);
    const folded = await viewOf(coord);
    check('the window\'s record of the chat, folded by DSH from the command and its result, says it coordinates, by its title', folded?.role === 'coordinator'
        && folded.project?.id === coord && folded.project.name === CHAT && folded.off === undefined, JSON.stringify(folded));
    answer = await command(coord, '/coordinate');
    check('/coordinate again says so and changes nothing', answer.ok && answer.value?.result?.text === 'This chat already coordinates threads.'
        && !readText(logFile).includes(`coordinate ${coord} on again`), JSON.stringify(answer).slice(0, 300));
    mkdirSync(join(root, 'plain'));
    const blankSession = (await bridge('POST', '/sessions', { workspacePath: join(root, 'plain') })).sessionId;
    const listed = await bridge('GET', '/sessions');
    check('DSH lists the chat; a session without a turn stays hidden',
        listed.find((s) => s.sessionId === coord)?.blank === false && listed.find((s) => s.sessionId === blankSession)?.blank === true,
        JSON.stringify(listed.map((s) => [s.sessionId === coord ? 'chat' : s.sessionId === blankSession ? 'blank' : 'other', s.blank])));
    check('state folder is 700', modeOf(stateDir) === 0o700, octal(modeOf(stateDir)));
    check('store file is 600', modeOf(storeFile) === 0o600, octal(modeOf(storeFile)));
    check('log file is 600', modeOf(logFile) === 0o600, octal(modeOf(logFile)));
    // The browser half: DSH serves it for the plugin's page, and it parses
    // (DSH sends browser halves in batches, so one that does not parse breaks others).
    const app = await httpGet(web.base.href, { cookie: web.cookie });
    const clientUrl = /"id":"dsh-plugin-coordinator","url":"([^"]+)"/.exec(app.text)?.[1];
    const client = clientUrl ? await httpGet(new URL(clientUrl, web.base).href, { cookie: web.cookie }) : { status: 0, text: '' };
    let parses = false;
    try { new Script(client.text); parses = true; } catch {}
    check('DSH serves the browser half and it parses', client.status === 200 && client.text.includes("'plugins.bundle.config'")
        && client.text.includes("'conversation.chat.turnTail'") && parses,
        `${clientUrl ?? 'not in the boot graph'}: ${client.status}`);

    // 2. Thread start and handback.
    mark = model.requests.length;
    await say(coord, call('thread_start', {
        ask: 'Check the Alpha work and report.',
        title: 'Alpha',
        brief: `Do the work, then report. ${call('thread_handback', { status: 'done', summary: 'Alpha finished: nothing to change.' })}`,
    }));
    let saw = await coordinatorSaw(mark, 'SAW-HANDBACK', 'the Alpha handback');
    const firstCoord = since(mark, 'coordinator')[0];
    check('the chat keeps its own model and effort', firstCoord.model === 'fake-model' && firstCoord.effort === 'low', describe(since(mark, 'coordinator')));
    check('the chat has the tools that run threads, not a thread\'s', firstCoord.tools.includes('thread_start') && !firstCoord.tools.includes('thread_handback'));
    const t1Reqs = since(mark, 't1');
    check('thread asks with effort high', t1Reqs.length > 0 && t1Reqs.every((r) => r.model === 'fake-model' && r.effort === 'high'), describe(t1Reqs));
    check('thread has thread tools only', t1Reqs[0]?.tools.includes('thread_handback') && !t1Reqs[0]?.tools.includes('thread_start'));
    check('the chat keeps all of DSH\'s tools, goals too, and so does a thread', firstCoord.tools.includes('create_goal') && firstCoord.tools.includes('bash')
        && t1Reqs[0]?.tools.includes('create_goal'), `${firstCoord.tools.join(',')} | ${t1Reqs[0]?.tools.join(',')}`);
    check('thread gets the brief, the user\'s words first', t1Reqs[0]?.fresh.includes(`[Brief from the chat "${CHAT}" · you are thread t1, "Alpha"]\n\nThe user asked: "Check the Alpha work and report."\n\nDo the work`), t1Reqs[0]?.fresh.slice(0, 300));
    check('handback reaches the chat', saw.fresh.includes('[Handback from thread t1 · "Alpha" · status: done]') && saw.fresh.includes('Alpha finished'), saw.fresh.slice(0, 300));
    check('the handback says how to answer it: now, the thread\'s link first, then the result', saw.fresh.includes('(The user has not seen this. Reply now. First line: the link [Alpha](.dsh-thread/t1), a colon, and the result in one sentence.'), saw.fresh.slice(-400));
    const t1 = threadSession('t1');
    check('thread session is titled "Alpha"', (await bridge('GET', `/sessions/${t1}`)).title === 'Alpha');
    check('roster shows the handback', saw.system.includes('- t1 · "Alpha" · ') && saw.system.includes('last handback: done'));
    // The window's view, folded by DSH from the real session events.
    const view = await waitFor(() => (windowView(coord)?.threads?.some((t) => t.id === 't1' && t.handback?.status === 'done') ? windowView(coord) : null),
        'the chat view with the Alpha handback', 15000).catch(() => windowView(coord));
    check('the window view lists the thread, its handback and its cards', view?.role === 'coordinator' && view.project?.id === coord && view.project.name === CHAT
        && view.threads?.[0]?.session === t1 && view.threads[0].title === 'Alpha'
        && ['start', 'handback'].every((kind) => view.cards?.some((c) => c.kind === kind && c.thread === 't1' && Number.isSafeInteger(c.turn))),
        JSON.stringify(view)?.slice(0, 400));
    // DSH folds the thread's own view from its events; it can trail the chat's by a moment.
    const threadView = await waitFor(() => (windowView(t1)?.cards?.some((c) => c.kind === 'handback') ? windowView(t1) : null),
        'the thread view with its handback card', 15000).catch(() => windowView(t1));
    check('the window view of a thread names its chat', threadView?.role === 'thread' && threadView.coordinator === coord && threadView.project?.name === CHAT
        && threadView.thread?.id === 't1' && threadView.cards?.some((c) => c.kind === 'handback'), JSON.stringify(threadView)?.slice(0, 300));
    await sleep(1000);
    check('a turn that handed back sends no idle note', !readText(logFile).includes(`idle-note ${coord}/t1 `) && since(mark, 'coordinator').every((r) => r.action.text !== 'SAW-IDLE'), describe(since(mark)));

    // 3. A thread that ends its turn without a handback: the plugin nudges it once, from its chat, which takes
    // no turn for it; when it ends that way again, the chat gets the idle note.
    mark = model.requests.length;
    await say(coord, call('thread_start', { ask: 'Please do this.', title: 'Beta', brief: 'Just answer.' }));
    saw = await coordinatorSaw(mark, 'SAW-IDLE', 'the Beta idle note');
    check('idle note reaches the chat', saw.fresh.includes('[Thread idle without a handback: t2 · "Beta"]') && saw.fresh.includes('Plain reply.'), saw.fresh.slice(0, 300));
    const t2 = threadSession('t2');
    const beta = since(mark, 't2');
    check('a turn that ends without a handback gets one nudge from its chat, sent by the plugin, and the note comes when it ends that way again', beta.length === 2
        && beta[1].fresh.includes('[From the coordinator]\n\nFinish the task and call thread_handback.') && readText(logFile).includes(`nudge ${coord}/t2 idle`)
        && saw.fresh.includes('(It was nudged once already to finish and hand back') && since(mark, 'coordinator').filter((r) => r.fresh.includes('t2 · "Beta"')).length === 1
        && fromSession(startingWith(await messagesOf(t2), '[From the coordinator]'), coord), `${describe(since(mark))} | ${saw.fresh.slice(-300)}`);

    // 4. The user talks to a thread directly: the chat is not woken.
    mark = model.requests.length;
    await say(t2, 'Hello from the user.');
    await sleep(1500);
    check('direct talk does not wake the chat', since(mark, 'coordinator').length === 0, describe(since(mark)));
    check('direct talk is logged', readText(logFile).includes(`direct-turn ${coord}/t2`));
    // Who DSH shows as the sender: a brief or a handback comes from the session
    // that sent it (DSH draws a "Task message received" notice), a note from the
    // plugin ("Plugin status updated"); the user's own words stay the user's.
    const coordMsgs = await messagesOf(coord);
    check('the idle note comes from the plugin', fromPlugin(startingWith(coordMsgs, '[Thread idle without a handback: t2')), sourcesText(coordMsgs));
    check('a handback comes from its thread', fromSession(startingWith(coordMsgs, '[Handback from thread t1'), t1), sourcesText(coordMsgs));
    const t1Msgs = await messagesOf(t1);
    check('a brief comes from the chat', fromSession(startingWith(t1Msgs, '[Brief from the chat'), coord), sourcesText(t1Msgs));
    const t2Msgs = await messagesOf(t2);
    check('the user\'s own words stay the user\'s', startingWith(t2Msgs, 'Hello from the user.')?.source?.kind === 'user', sourcesText(t2Msgs));

    // 5. A failed turn: the plugin nudges it once, from its chat; when it fails again, the note says so.
    // The roster now notes the direct talk.
    mark = model.requests.length;
    await say(coord, call('thread_start', { ask: 'Please do this.', title: 'Gamma', brief: 'E2E:fail' }));
    check('roster notes the direct talk', since(mark, 'coordinator')[0]?.system.includes('- t2 · "Beta" · idle · no handback yet · the user talked to it directly; its reply: "Plain reply."'),
        since(mark, 'coordinator')[0]?.system.split('\n').filter((l) => l.startsWith('- t')).join(' | '));
    saw = await coordinatorSaw(mark, 'SAW-IDLE', 'the Gamma failure note');
    check('failure note says the turn failed, in the provider\'s words', saw.fresh.includes('[Thread idle without a handback: t3 · "Gamma"]') && saw.fresh.includes('The turn failed (HTTP 400): fake model rejected the request'), saw.fresh.slice(0, 300));
    const gamma = since(mark, 't3');
    check('a failed turn gets one nudge from its chat, sent by the plugin, and the note comes when it fails again', gamma.length >= 2
        && gamma.at(-1).fresh.includes('[From the coordinator]\n\nCarry on from where you left off and finish the task.') && readText(logFile).includes(`nudge ${coord}/t3 ended=error`)
        && saw.fresh.includes('that its turn failed again after a nudge') && !since(mark, 'coordinator').some((r) => r.fresh.includes('Nudge it once'))
        && fromSession(startingWith(await messagesOf(threadSession('t3')), '[From the coordinator]'), coord), describe(since(mark)));

    // 6. A thread waiting on a permission prompt, then stopped.
    mark = model.requests.length;
    const probe = join(root, 'outside', 'approval-probe.txt');
    await say(coord, call('thread_start', {
        ask: 'Please do this.',
        title: 'Delta',
        brief: call('write', { file_path: probe, content: 'x', sandbox_permissions: 'danger-full-access', justification: 'E2E approval check.' }),
    }));
    saw = await coordinatorSaw(mark, 'SAW-APPROVAL', 'the Delta approval note');
    check('approval note names the tool and the session', saw.fresh.includes('[Thread waiting for approval: t4 · "Delta"]')
        && saw.fresh.includes('It asked to use write: ') && saw.fresh.includes('E2E approval check.') && saw.fresh.includes('in the "Delta" session'), saw.fresh.slice(0, 400));
    // At once, as the plugin's default has it: the thread asked for the write in its first request.
    const deltaAsked = since(mark, 't4')[0];
    check('the approval note comes at once', deltaAsked !== undefined && saw.at - deltaAsked.at < 5000, `${deltaAsked ? saw.at - deltaAsked.at : '?'} ms after the thread's request`);
    // A person's stop stays a stop: no note goes to the chat (so it can't send the thread on by
    // itself), and its roster says the user stopped it.
    mark = model.requests.length;
    await bridge('POST', `/sessions/${threadSession('t4')}/cancel`, {});
    await waitFor(() => readText(logFile).includes(`user-stop ${coord}/t4`) && project().threads?.t4?.lastEnding, 'the Delta user-stop log');
    await waitIdle(threadSession('t4'));
    await sleep(1500);
    check('a person\'s stop sends the chat no note', since(mark, 'coordinator').length === 0
        && project().threads.t4.lastEnding.text === 'The turn was stopped by the user before it finished.', `${describe(since(mark, 'coordinator'))} ${JSON.stringify(project().threads.t4.lastEnding)}`);
    check('nothing was written without approval', !existsSync(probe));

    // 7. A thread model without efforts, and a bad effort.
    let reqs = await say(coord, call('thread_settings', { thread_model: 'fake-flash' }));
    check('settings note the dropped effort', resultOf(reqs).includes('has no effort levels'), resultOf(reqs));
    mark = model.requests.length;
    reqs = await say(coord, call('thread_start', { ask: 'Please do this.', title: 'Epsilon', brief: 'Just answer.' }));
    await coordinatorSaw(mark, 'SAW-IDLE', 'the Epsilon idle note');
    const t5Reqs = since(mark, 't5');
    check('flash thread asks without effort', t5Reqs.length > 0 && t5Reqs.every((r) => r.model === 'fake-flash' && r.effort === undefined), describe(t5Reqs));
    reqs = await say(coord, call('thread_settings', { thread_effort: 'ultra' }));
    check('bad effort is refused', /ultra/.test(resultOf(reqs)) && project().settings?.threadEffort !== 'ultra', resultOf(reqs));

    // 8. One thread's effort, then a message from the chat to it.
    reqs = await say(coord, call('thread_update', { thread: 't1', effort: 'max' }));
    check('thread update reports the change', /effort/.test(resultOf(reqs)), resultOf(reqs));
    mark = model.requests.length;
    await say(coord, call('thread_send', { thread: 't1', text: 'One more check, please.' }));
    saw = await coordinatorSaw(mark, 'SAW-IDLE', 'the t1 idle note');
    const t1More = since(mark, 't1');
    check('thread override reaches the wire', t1More.length > 0 && t1More.every((r) => r.effort === 'max'), describe(t1More));
    check('thread gets the chat\'s message', t1More[0]?.fresh.includes('[From the coordinator]\n\nOne more check, please.'));
    check('a message from the chat comes from the chat', fromSession(startingWith(await messagesOf(t1), '[From the coordinator]'), coord));

    // 9. Memory reaches the chat's next request and new threads.
    reqs = await say(coord, call('shared_notes', { action: 'append', text: '- E2E memory fact.' }));
    check('memory is written', resultOf(reqs).includes('appended') && readText(join(memoryDir, `${coord}.md`)).includes('E2E memory fact.'));
    check('memory is in the chat\'s rules', reqs.at(-1)?.system.includes('E2E memory fact.'));
    check('memory folder is 700', modeOf(memoryDir) === 0o700, octal(modeOf(memoryDir)));

    // 10. List and read.
    reqs = await say(coord, call('thread_list', { include_resolved: true }));
    check('list shows every thread', ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].every((t) => resultOf(reqs).includes(t)), resultOf(reqs));
    reqs = await say(coord, call('thread_read', { thread: 't2' }));
    check('read shows what the user said, not injected context', resultOf(reqs).includes('Hello from the user.') && !resultOf(reqs).includes('Current runtime context'), resultOf(reqs));

    // 11. Resolve.
    await say(coord, call('thread_update', { thread: 't2', resolved: true }));
    reqs = await say(coord, call('thread_list', {}));
    check('resolved threads leave the list', !resultOf(reqs).includes('Beta') && resultOf(reqs).includes('Alpha'), resultOf(reqs));
    // A title longer than DSH keeps (80 bytes) is cut once, at a word, with "…", and DSH keeps exactly that.
    reqs = await say(coord, call('thread_update', { thread: 't2', title: 'Draft the spring launch announcement with product highlights, pricing tiers and a wholesale FAQ' }));
    const longTitle = 'Draft the spring launch announcement with product highlights, pricing tiers…';
    check('a long title is cut once, at a word, and DSH keeps it whole', resultOf(reqs).includes(`renamed to "${longTitle}"`)
        && (await bridge('GET', `/sessions/${t2}`)).title === longTitle, `${resultOf(reqs).slice(0, 200)} / ${(await bridge('GET', `/sessions/${t2}`)).title}`);

    // 12. Pause holds a handback; resume delivers it.
    reqs = await say(coord, call('thread_settings', { paused: true }));
    check('pause is on', resultOf(reqs).includes('Paused: yes'), resultOf(reqs));
    mark = model.requests.length;
    reqs = await say(t1, call('thread_handback', { status: 'done', summary: 'Held while paused.' }));
    await sleep(500);
    check('handback is held while paused', resultOf(reqs).includes('Handback saved') && since(mark, 'coordinator').length === 0, resultOf(reqs));
    mark = model.requests.length;
    reqs = await say(coord, call('thread_settings', { paused: false }));
    check('resume delivers the held handback', resultOf(reqs).includes('delivered 1 held handback'), resultOf(reqs));
    saw = await coordinatorSaw(mark, 'SAW-HANDBACK', 'the held handback');
    check('held handback arrives', saw.fresh.includes('Held while paused.'));
    const held = (await messagesOf(coord)).findLast((m) => m.text.includes('Held while paused.'));
    check('a held handback still comes from its thread', fromSession(held, t1), JSON.stringify(held?.source));

    // 13. /coordinate off: the chat is a plain chat again, and the window's record of it says it stopped. Its
    // threads keep running, and what they hand back waits; /coordinate again brings its tools back and
    // delivers what waited, after DSH logs the command's result.
    mark = model.requests.length;
    await say(coord, call('thread_send', { thread: 't1', text: `E2E:slow 5000\n${call('thread_handback', { status: 'done', summary: 'Finished while the chat was off.' })}` }));
    answer = await command(coord, '/coordinate off');
    const stoppedView = await viewOf(coord);
    const openNow = Object.values(project().threads ?? {}).filter((t) => t.resolved !== true).length;
    check('/coordinate off stops it, says how many of its threads stay open and how many run (t1 alone), and the window\'s record of the chat says it stopped', answer.ok
        && answer.value?.result?.text === `Stopped coordinating. Its ${openNow} threads stay open (1 running); what they hand back waits until you run /coordinate here again.`
        && project().off === true && readText(logFile).includes(`coordinate ${coord} off\n`) && stoppedView?.role === 'coordinator' && stoppedView.off === true,
        `${JSON.stringify(answer).slice(0, 300)} ${JSON.stringify(stoppedView)}`);
    const heldBack = await waitFor(() => resultOf(since(mark, 't1')), 't1\'s handback while the chat is off', 30000);
    await waitIdle(t1);
    await sleep(1000);
    check('its thread keeps running, and what it hands back waits', heldBack === 'TOOL-RESULT: Handback saved; the coordinator gets it when it takes reports again.'
        && since(mark).every((r) => r.action.text !== 'SAW-HANDBACK') && project().pendingHandbacks?.length === 1, `${heldBack} | ${describe(since(mark))}`);
    reqs = await say(coord, 'Are you still coordinating?');
    check('meanwhile the chat is a plain chat: no thread tools or rules', reqs.length > 0
        && reqs.every((r) => !r.tools.includes('thread_start') && !r.system.includes('# Coordinating threads')), reqs[0]?.tools.join(','));
    mark = model.requests.length;
    answer = await command(coord, '/coordinate');
    saw = await coordinatorSaw(mark, 'SAW-HANDBACK', 'the handback that waited');
    const chatLog = (await bridge('GET', `/sessions/${coord}/events?types=command/done,user/message&limit=2000&full=1`)).events;
    const doneAt = chatLog.findLast((e) => e.type === 'command/done')?.seq ?? Infinity;
    const waited = chatLog.find((e) => e.type === 'user/message' && e.text?.startsWith('[Handback from thread t1') && e.text.includes('Finished while the chat was off.'));
    check('/coordinate again brings its tools back and delivers what waited, after the command\'s result', answer.ok && answer.value?.result?.text === COORDINATING
        && saw.fresh.includes('[Handback from thread t1 · "Alpha" · status: done]') && saw.tools.includes('thread_start') && waited?.seq > doneAt && fromSession(waited, t1)
        && readText(logFile).includes(`coordinate ${coord} on again\n`) && project().pendingHandbacks?.length === 0,
        `${JSON.stringify(answer).slice(0, 200)} done=${doneAt} handback=${waited?.seq} ${JSON.stringify(waited?.source)}`);
    const onAgain = await viewOf(coord);
    check('and the window\'s record of the chat says it coordinates again', onAgain?.role === 'coordinator' && onAgain.off === undefined && onAgain.project?.name === CHAT, JSON.stringify(onAgain));

    // 14. A stop the chat asks for is not echoed back to it.
    mark = model.requests.length;
    await say(coord, call('thread_start', {
        ask: 'Please do this.',
        title: 'Zeta',
        brief: call('write', { file_path: probe, content: 'x', sandbox_permissions: 'danger-full-access', justification: 'E2E stop check.' }),
    }));
    await coordinatorSaw(mark, 'SAW-APPROVAL', 'the Zeta approval note');
    mark = model.requests.length;
    reqs = await say(coord, call('thread_update', { thread: 't6', stop: true }));
    check('the chat can stop a thread', resultOf(reqs).includes('current turn stopped'), resultOf(reqs));
    await waitIdle(threadSession('t6'));
    await sleep(1500);
    check('its own stop is not echoed back to it', !since(mark, 'coordinator').some((r) => r.fresh.includes('t6 · "Zeta"')), describe(since(mark, 'coordinator')));

    // 15. Queued turns: the chat queues a second message (steer=false)
    // while the first turn runs; DSH runs both before going idle. The first
    // hands back, the second fails, and the chat hears about both.
    mark = model.requests.length;
    await say(coord, call('thread_start', {
        ask: 'Please do this.',
        title: 'Eta',
        brief: `E2E:slow 4000\n${call('thread_handback', { status: 'done', summary: 'Eta part one done.' })}`,
    }));
    const sent = await say(coord, call('thread_send', { thread: 't7', text: 'E2E:fail', steer: false }));
    saw = await coordinatorSaw(mark, 'SAW-IDLE', 'the Eta failure note');
    const t7Reqs = since(mark, 't7');
    check('the second message was queued while the first turn ran, and the chat heard so', sent[0].at < (t7Reqs[1]?.at ?? 0)
        && resultOf(sent.filter((r) => whoOf(r) === 'coordinator')) === 'TOOL-RESULT: Queued: t7 sees this when its turn ends; steer=true redirects it now.',
        `${describe(since(mark))} | ${resultOf(sent.filter((r) => whoOf(r) === 'coordinator'))}`);
    check('the first turn handed back', since(mark, 'coordinator').some((r) => r.fresh.includes('Eta part one done.')));
    check('the queued turn that failed gets its note', saw.fresh.includes('[Thread idle without a handback: t7 · "Eta"]') && saw.fresh.includes('The turn failed (HTTP 400):'), saw.fresh.slice(0, 300));

    // 16. DSH dies mid-turn, with a thread at work and the chat in the middle
    // of answering a handback. At the next start the chat hears once that the
    // thread was cut off, and nothing sends the thread on: it waits for the
    // user's Resume; and the handback the chat never answered is sent to it
    // again, once, from its thread. Then: the same chat still coordinates,
    // threads still wired.
    mark = model.requests.length;
    await say(coord, call('thread_start', { ask: 'Please do this.', title: 'Theta', brief: 'E2E:slow 120000\nWork for a long time.' }));
    await waitFor(() => since(mark, 't8').length > 0, 'the Theta request');
    // t1 hands back; the chat's answer to it is slow (the summary's E2E:slow line), so DSH dies while its turn runs.
    await bridge('POST', `/sessions/${coord}/prompt`, { text: call('thread_send', { thread: 't1', text: call('thread_handback', { status: 'done', summary: 'Alpha re-checked the notes.\nE2E:slow 120000' }) }) });
    await waitFor(() => since(mark, 'coordinator').some((r) => r.fresh.includes('Alpha re-checked the notes.')), 'the chat to take the Alpha handback', 60000);
    await sleep(500);
    const resumes = () => readText(logFile).split('\n').filter((l) => l.endsWith(` coordinator ${coord} ${coord} resumed`)).length;
    const resumedBefore = resumes();
    let signInsBefore = signIns();
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    mark = model.requests.length;
    child = startDsh(dsh);
    await waitFor(async () => existsSync(sock) && (await bridge('GET', '/health')).ok, 'the session bridge after restart', 90000);
    await waitFor(() => resumes() > resumedBefore, 'the plugin to bring the chat up again');
    check('a restart keeps the chat coordinating', project().coordinatorSessionId === coord && project().off === undefined, JSON.stringify(project()).slice(0, 200));
    saw = await waitFor(() => since(mark, 'coordinator').find((r) => r.fresh.includes('t8 · "Theta"')), 'the Theta note after the restart');
    await waitFor(() => since(mark, 'coordinator').some((r) => r.fresh.includes('Alpha re-checked the notes.')), 'the Alpha handback again', 30000).catch(() => {});
    await waitIdle(coord);
    await sleep(1000);
    const againReqs = since(mark, 'coordinator').filter((r) => r.fresh.includes('Alpha re-checked the notes.'));
    const againLog = (await bridge('GET', `/sessions/${coord}/events?types=user/message&limit=2000&full=1`)).events
        .filter((e) => e.text?.startsWith('[Handback from thread t1') && e.text.includes('Alpha re-checked the notes.'));
    check('the handback the chat was answering when DSH died is sent to it again, once, from its thread, saying why', againReqs.length === 1
        && againReqs[0].fresh.includes('(DSH closed before you answered this, so the plugin sends it again, once. The user has not seen this.')
        && againLog.length === 2 && fromSession(againLog[1], t1) && new RegExp(` raise-cut ${coord} turn=\\d+ messages=1\n`).test(readText(logFile))
        && project().raisedCut !== undefined && project().answering !== 'taken',
        `${describe(since(mark, 'coordinator'))} | log=${againLog.length} ${JSON.stringify(againLog[1]?.source)}`);
    check('a turn cut off by the crash is told once at the next start, and the thread is not sent on', saw.fresh.includes('[Thread idle without a handback: t8 · "Theta"]')
        && saw.fresh.includes('The turn was cut off because DSH closed while it ran.') && saw.fresh.includes('its card has Resume')
        && since(mark, 'coordinator').filter((r) => r.fresh.includes('t8 · "Theta"')).length === 1
        && since(mark, 't8').length === 0 && !readText(logFile).includes(`nudge ${coord}/t8 `), `${describe(since(mark))} | ${saw.fresh.slice(0, 300)}`);
    mark = model.requests.length;
    await say(coord, call('thread_send', { thread: 't1', text: 'After the restart.' }));
    saw = await coordinatorSaw(mark, 'SAW-IDLE', 'the t1 idle note after restart');
    check('after a restart the chat still coordinates, on its own model', since(mark, 'coordinator').every((r) => r.tools.includes('thread_start') && r.effort === 'low'),
        describe(since(mark, 'coordinator')));
    const t1After = since(mark, 't1');
    check('thread keeps its effort and tools after restart', t1After.length > 0 && t1After.every((r) => r.effort === 'max' && r.tools.includes('thread_handback')), describe(t1After));
    web = await signInAgain(signInsBefore);

    // 17. New defaults saved while DSH runs (the form on the plugin's page
    // writes the same file) apply without restarting the plugin, to whatever
    // follows the defaults. The chat's own choice (thread model fake-flash)
    // stays: a chat's choice comes first.
    const starts = () => readText(logFile).split('\n').filter((l) => l.includes(` coordinator ${coord} `)).length;
    const saves = () => readText(logFile).split('\n').filter((l) => l.endsWith(' defaults saved')).length;
    const startsBefore = starts();
    const savesBefore = saves();
    writePatch(model.port, { threadModel: 'fake:fake-model', threadEffort: 'max' });
    await waitFor(() => saves() > savesBefore, 'the plugin to see the saved defaults');
    check('saved defaults leave the chat\'s own choices', project().settings?.threadModel === 'fake:fake-flash' && !readText(logFile).includes(' replaced '), JSON.stringify(project().settings));
    check('the plugin was not restarted', starts() === startsBefore, `${startsBefore} → ${starts()}`);

    // 18. The Thread settings dialog's endpoints, called as the window calls them.
    answer = await webApi(web, 'dsh-plugin-coordinator/describe', { target: threadSession('t1') });
    check('the window reads a chat through one of its threads, with the defaults saved meanwhile', answer.ok && answer.value.project.id === coord && answer.value.project.coordinator === coord
        && answer.value.project.name === CHAT && answer.value.settings.threadModel.value === 'fake:fake-flash' && answer.value.settings.threadModel.inherited.value === 'fake:fake-model'
        && answer.value.settings.threadEffort.value === 'max' && answer.value.settings.threadEffort.source === 'plugin default'
        && answer.value.threads.some((t) => t.id === 't5' && t.model === 'fake:fake-flash'), JSON.stringify(answer).slice(0, 500));
    answer = await webApi(web, 'dsh-plugin-coordinator/update', { target: coord, changes: { threadModel: null } });
    check('"Use default" in the window hands the threads back to the saved default', answer.ok && answer.value.settings.threadModel.source === 'plugin default'
        && answer.value.settings.threadModel.value === 'fake:fake-model' && project().settings?.threadModel === undefined, JSON.stringify(answer).slice(0, 300));
    answer = await webApi(web, 'dsh-plugin-coordinator/update', { target: coord, changes: { threadEffort: 'ultra' } });
    check('the window gets the plugin\'s refusal', answer.ok === false && answer.error?.code === 'coordinator/refused' && /ultra/.test(answer.error.message), JSON.stringify(answer));
    mark = model.requests.length;
    await say(coord, call('thread_start', { ask: 'Please do this.', title: 'Iota', brief: 'Just answer.' }));
    await coordinatorSaw(mark, 'SAW-IDLE', 'the Iota idle note');
    // Models and efforts are settings: neither the chat's rules nor its start result names them unless it chose one.
    const iota = since(mark, 'coordinator');
    const policyOf = (r) => { const at = r.system.indexOf('# Coordinating threads'); return at < 0 ? '' : r.system.slice(at, r.system.indexOf('\n## Threads', at)); };
    check('the chat\'s rules and its start result name no model', iota.length > 0 && iota.every((r) => policyOf(r) !== '' && !/fake-|effort (max|high)|## Settings/.test(policyOf(r)))
        && resultOf(iota) === 'TOOL-RESULT: Started t9 "Iota". It reports back when done. Link it as [Iota](.dsh-thread/t9).',
        `${resultOf(iota)} || ${iota.map((r) => policyOf(r).split('\n').filter((l) => /fake-|effort|Settings/.test(l)).join(' | ')).join(' ;; ')}`);
    const t9Reqs = since(mark, 't9');
    check('a new thread starts on the defaults saved while DSH ran', t9Reqs.length > 0 && t9Reqs.every((r) => r.model === 'fake-model' && r.effort === 'max'), describe(t9Reqs));

    // Scope: a start that would use a guarded tool the user's words don't name is refused, and one without their words never runs.
    reqs = await say(coord, call('thread_start', { ask: 'Write a haiku about rain.', title: 'Lanes', brief: 'Use mcp__lane-catalog__lanes_status to list the lanes.' }));
    check('a start that would use a guarded tool the user did not ask for is refused', resultOf(reqs).startsWith('TOOL-RESULT: Failed: this would use lane-catalog, and the user\'s words do not ask for it.')
        && readText(logFile).includes(`guard ${coord} start lane-catalog`), resultOf(reqs));
    check('the chat\'s rules name the user\'s tools a thread gets only from their words', reqs.some((r) => r.system.includes(' Here those are: lane-catalog, notes-app; a thread gets the ones the user\'s words in `ask` name. Leave them out of briefs, even to forbid them.\n')),
        reqs.at(-1)?.system.split('\n').filter((l) => /those are|briefs/.test(l)).join(' | '));
    reqs = await say(coord, call('thread_start', { title: 'No ask', brief: 'Just answer.' }));
    check('a start without the user\'s words is rejected before it runs', resultOf(reqs) !== '' && /\bask\b/.test(resultOf(reqs))
        && !Object.values(project().threads ?? {}).some((t) => t.title === 'No ask' || t.title === 'Lanes'), resultOf(reqs).slice(0, 300));

    // 19. DSH's own model picker (the composer's model menu). A pick in the chat is the chat's own, as in any
    // chat: it changes no setting. A pick in a thread's own picker becomes that thread's model.
    const settingsBefore = JSON.stringify(project().settings);
    answer = await webApi(web, 'session/selectModel', { request: { sessionId: coord, provider: 'fake', model: 'fake-model', reasoningEffort: 'max' } });
    await sleep(1000);
    check('a pick in the chat\'s picker changes no setting', answer.ok && !/ picked /.test(readText(logFile)) && JSON.stringify(project().settings) === settingsBefore,
        `${JSON.stringify(answer).slice(0, 200)} ${JSON.stringify(project().settings)}`);
    mark = model.requests.length;
    await say(coord, call('thread_send', { thread: 't5', text: 'After the new defaults.' }));
    await coordinatorSaw(mark, 'SAW-IDLE', 'the t5 idle note after the new defaults');
    check('the chat runs on its pick', since(mark, 'coordinator').every((r) => r.model === 'fake-model' && r.effort === 'max'), describe(since(mark, 'coordinator')));
    const t5After = since(mark, 't5');
    check('a thread keeps the model it started with', t5After.length > 0 && t5After.every((r) => r.model === 'fake-flash' && r.effort === undefined), describe(t5After));
    answer = await webApi(web, 'session/selectModel', { request: { sessionId: threadSession('t5'), provider: 'fake', model: 'fake-model', reasoningEffort: 'high' } });
    await waitFor(() => readText(logFile).includes(`picked ${coord}/t5 fake:fake-model effort=high`), 'the thread\'s pick to reach the plugin', 10000).catch(() => {});
    check('a pick in a thread\'s own picker becomes its model', answer.ok && project().threads?.t5?.model === 'fake:fake-model' && project().threads.t5.effort === 'high',
        `${JSON.stringify(answer).slice(0, 200)} ${JSON.stringify(project().threads?.t5 ?? {}).slice(0, 200)}`);
    check('selections the plugin makes itself are not taken for picks', readText(logFile).split('\n').filter((l) => / picked /.test(l)).length === 1,
        readText(logFile).split('\n').filter((l) => / picked | select /.test(l)).join('\n'));

    // 20. An effort the thread model lacks never stops a start: the thread runs at the nearest level it offers.
    answer = await webApi(web, 'dsh-plugin-coordinator/update', { target: coord, changes: { threadModel: 'fake:fake-mini' } });
    check('the window says the inherited effort is fitted', answer.ok && (answer.value?.notes ?? []).some((n) => /fake:fake-mini doesn't offer effort "max", so it runs at "high"/.test(n)),
        JSON.stringify(answer).slice(0, 400));
    mark = model.requests.length;
    await say(coord, call('thread_start', { ask: 'Please do this.', title: 'Kappa', brief: 'Just answer.' }));
    await coordinatorSaw(mark, 'SAW-IDLE', 'the Kappa idle note');
    const kappa = since(mark, 't10');
    check('a thread whose model lacks the default effort starts at the nearest one', kappa.length > 0 && kappa.every((r) => r.model === 'fake-mini' && r.effort === 'high'), describe(kappa));

    // 21. The plugin's page lists every coordinating chat with its thread settings and where each comes from.
    answer = await webApi(web, 'dsh-plugin-coordinator/list', {});
    const row = answer.ok ? answer.value.projects.find((p) => p.id === coord) : undefined;
    check('the plugin page lists the chat, its settings and where each comes from', row?.coordinator === coord && row.name === CHAT && row.paused === false && row.off === false
        && row.settings.threadModel.value === 'fake:fake-mini' && row.settings.threadModel.source === 'chat setting' && row.settings.threadEffort.source === 'plugin default'
        && row.access.threadPermission.value === 'workspace-write' && row.threads.open > 0 && Object.keys(answer.value).sort().join() === 'guarded,permissions,problems,projects,store'
        && answer.value.problems.length === 0 && answer.value.store.length === 0,
        JSON.stringify(answer).slice(0, 600));

    // 21b. News: what threads hand back or finish waits for the user, from anywhere in the window, until they open the chat.
    answer = await webApi(web, 'dsh-plugin-coordinator/news', {});
    const newsHere = answer.ok ? answer.value.news.find((n) => n.coordinator === coord) : undefined;
    check('the window hears what threads finished, newest last, until the user opens the chat', newsHere?.project === coord && newsHere.name === CHAT && newsHere.unread.length > 0
        && newsHere.unread.at(-1).thread === 't10' && newsHere.unread.at(-1).kind === 'finished' && newsHere.unread.at(-1).title === 'Kappa'
        && readText(logFile).includes(`news ${coord}/t10 finished`), JSON.stringify(answer).slice(-600));
    answer = await webApi(web, 'dsh-plugin-coordinator/seeNews', { target: coord, seq: newsHere?.seq });
    check('opening the chat sees its news', answer.ok && answer.value.news.find((n) => n.coordinator === coord)?.unread.length === 0, JSON.stringify(answer).slice(0, 300));

    // 22. Code changes: a thread's edits show as +a -d · N files, as DSH's own
    // "Edited N files" card counts them, with the turn DSH's Review tab opens.
    // The totals outlive a DSH restart; DSH's diff of them does not.
    const git = (...args) => execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', ...args], { cwd: ws, stdio: 'ignore' });
    let gitReady = true;
    try {
        writeFileSync(join(ws, 'README.md'), '# E2E\n');
        git('init', '-q');
        git('add', 'README.md');
        git('commit', '-q', '-m', 'Start');
    } catch {
        gitReady = false;
    }
    check('git makes the workspace a repository, so DSH records each turn\'s changes', gitReady);
    mark = model.requests.length;
    await say(coord, call('thread_start', { ask: 'Please do this.', title: 'Lambda', brief: call('write', { file_path: join(ws, 'notes.md'), content: 'one\ntwo\nthree\n' }) }));
    await coordinatorSaw(mark, 'SAW-IDLE', 'the Lambda idle note');
    const lambdaId = Object.entries(project().threads ?? {}).find(([, t]) => t.title === 'Lambda')?.[0];
    const lambda = threadSession(lambdaId);
    const turnsKept = (n) => waitFor(() => (project().threads?.[lambdaId]?.changes?.length === n ? true : null), `${n} Lambda turn(s) with changes in the store`, 15000).catch(() => false);
    await turnsKept(1);
    const changesOf = async (web) => {
        const read = await webApi(web, 'dsh-plugin-coordinator/describe', { target: coord });
        return read.ok ? read.value.threads.find((t) => t.id === lambdaId)?.changes : undefined;
    };
    const dshCard = async (web, seq) => {
        const res = await httpGet(new URL(`api/changes.summary?${new URLSearchParams({ sessionId: lambda, seq: String(seq) })}`, web.base).href, { cookie: web.cookie });
        let value = null;
        try { value = JSON.parse(res.text); } catch {}
        return { status: res.status, value };
    };
    let lc = await changesOf(web);
    const firstSeq = lc?.last.seq;
    let card = lc ? await dshCard(web, lc.last.seq) : { status: 0, value: null };
    check('a thread\'s edit shows as +a -d · N files, as DSH\'s own card counts it', lc?.added === 3 && lc.deleted === 0 && lc.files === 1 && lc.turns === 1 && lc.reviewable === true
        && card.status === 200 && card.value?.added === 3 && card.value.deleted === 0 && card.value.total === 1 && card.value.turn === lc.last.turn,
        `${JSON.stringify(lc)} ${card.status} ${JSON.stringify(card.value)?.slice(0, 200)}`);
    // The window's live copy: DSH writes its projection cache at the turn's
    // end, before it announces the turn's changes, so ask the running Host.
    const lambdaView = await viewOf(lambda);
    check('the thread\'s own view marks the turn, so the window reads its changes again', lambdaView?.role === 'thread'
        && lambdaView.changes?.some((c) => c.seq === lc?.last.seq && c.turn === lc?.last.turn), JSON.stringify(lambdaView)?.slice(0, 400));
    // A second turn (the user talking to the thread) edits the file it wrote: lines add up, the file counts once.
    await say(lambda, call('edit', { file_path: join(ws, 'notes.md'), old_string: 'two', new_string: 'TWO' }));
    await turnsKept(2);
    lc = await changesOf(web);
    check('changes add up over the thread\'s turns, and Review opens the newest', lc?.added === 4 && lc.deleted === 1 && lc.files === 1 && lc.turns === 2
        && lc.reviewable === true && lc.last.seq > firstSeq && lc.last.seq === project().threads[lambdaId].changes[1].seq, JSON.stringify(lc));
    // 22b. Two threads of the chat in one folder (the changes study's P1): A only waits while B
    // edits, so DSH's summary of each of A's turns lists B's edits. The plugin counts each thread's
    // own: A changed nothing, B the file it wrote (its shell edit isn't counted until shell edits are).
    const quietThread = async (title) => {
        const at = model.requests.length;
        await say(coord, call('thread_start', { ask: 'Please do this.', title, brief: 'Wait for the next message.' }));
        await coordinatorSaw(at, 'SAW-IDLE', `the ${title} idle note`);
        return Object.entries(project().threads ?? {}).find(([, t]) => t.title === title)?.[0];
    };
    const waitsId = await quietThread('Waits');
    const writesId = await quietThread('Writes');
    const sessionA = threadSession(waitsId);
    const sessionB = threadSession(writesId);
    const wait6 = call('bash', { command: 'sleep 6; echo A-done', description: 'wait' });
    const overlap = async (aText, bText) => {
        const at = model.requests.length;
        await bridge('POST', `/sessions/${sessionA}/prompt`, { text: aText });
        await waitFor(() => since(at).some((r) => r.fresh.includes(aText)), 'A to start waiting');
        await say(sessionB, bText);
        await waitIdle(sessionA);
    };
    await overlap(wait6, call('write', { file_path: join(ws, 'b-new.txt'), content: 'from B\n' }));
    await overlap(wait6, call('bash', { command: "printf 'from B shell\\n' >> README.md", description: 'append' }));
    const marksOf = async (sessionId) => (await viewOf(sessionId))?.changes ?? [];
    const filesIn = async (sessionId, seq) => {
        const res = await httpGet(new URL(`api/changes.summary?${new URLSearchParams({ sessionId, seq: String(seq) })}`, web.base).href, { cookie: web.cookie });
        try { return (JSON.parse(res.text)?.files ?? []).map((f) => f.display ?? f.path); } catch { return []; }
    };
    const dshForA = async () => (await Promise.all((await marksOf(sessionA)).map((m) => filesIn(sessionA, m.seq)))).flat();
    const seenByDsh = await waitFor(async () => { const files = await dshForA(); return files.some((f) => f.endsWith('b-new.txt')) ? files : null; }, 'DSH announcing A\'s turn with B\'s file', 20000).catch(() => null);
    check('DSH credits a thread that only waited with what another thread changed in its folder', seenByDsh !== null, JSON.stringify(await dshForA()));
    await waitFor(() => (project().threads?.[writesId]?.changes?.length === 1 ? true : null), 'B\'s write in the store', 15000).catch(() => false);
    const readThreads = await webApi(web, 'dsh-plugin-coordinator/describe', { target: coord });
    const changesFor = (id) => (readThreads.ok ? readThreads.value.threads.find((t) => t.id === id)?.changes : undefined);
    const filesOfB = (project().threads?.[writesId]?.changes ?? []).flatMap((r) => r.files.map((f) => f.path));
    check('each thread counts only its own edits: none for the one that waited, its file for the one that wrote', changesFor(waitsId) === null
        && (project().threads?.[waitsId]?.changes ?? []).length === 0 && changesFor(writesId)?.files === 1 && changesFor(writesId).added === 1 && changesFor(writesId).deleted === 0
        && filesOfB.join() === 'b-new.txt', `A ${JSON.stringify(changesFor(waitsId))} B ${JSON.stringify(changesFor(writesId))} ${filesOfB.join()}`);
    // 22c. A thread's Changes tab (remote.js `changes`): its own edits with each one's hunks, read from its
    // log and its subagents' logs, and the turns DSH can still review; another thread in the folder shows only its own.
    const tabOf = (web, target, thread) => webApi(web, 'dsh-plugin-coordinator/changes', thread ? { target, thread } : { target });
    let tab = await tabOf(web, lambda);
    const notesIn = (read) => (read.ok ? read.value.files.find((f) => f.path === 'notes.md') : undefined);
    let notes = notesIn(tab);
    check('a thread\'s Changes tab reads its file and each edit\'s hunks from its log, and the turns DSH can review', tab.ok && tab.value.files.length === 1
        && notes?.added === 4 && notes.deleted === 1 && notes.created === true && notes.edits.length === 2
        && notes.edits[0].hunks[0]?.oldText === null && notes.edits[0].hunks[0].newText === 'one\ntwo\nthree\n'
        && notes.edits[1].hunks.some((hunk) => hunk.oldText?.includes('two') && hunk.newText.includes('TWO'))
        && tab.value.turns.length === 2 && tab.value.turns.every((t) => t.reviewable === true), JSON.stringify(tab).slice(0, 700));
    // The one diff of what the file's edits came to (it wrote the file, then edited a line), from the texts the plugin
    // kept around them, in its folder, for the thread alone.
    const netDir = join(stateDir, 'net', lambda);
    const keptPrivate = () => existsSync(netDir) && modeOf(netDir) === 0o700 && readdirSync(netDir).length > 0 && readdirSync(netDir).every((name) => modeOf(join(netDir, name)) === 0o600);
    check('a thread\'s Changes tab has one diff of what each file\'s edits came to, kept privately for that thread',
        JSON.stringify(notes?.net) === JSON.stringify({ added: 3, deleted: 0, created: true, hunks: [{ oldText: null, newText: 'one\nTWO\nthree' }] }) && keptPrivate(),
        `${JSON.stringify(notes?.net ?? null)} ${existsSync(netDir) ? readdirSync(netDir).map((name) => `${name}:${octal(modeOf(join(netDir, name)))}`).join(' ') : 'no folder'}`);
    // An edit DSH refuses (the thread never read the file) keeps nothing of the file (net diffs review: the Mac's check).
    const unread = join(ws, 'unread.md');
    writeFileSync(unread, 'left alone\n');
    const keptBefore = readdirSync(netDir).sort().join();
    const refusedEdit = await say(lambda, call('edit', { file_path: unread, old_string: 'left', new_string: 'changed' }));
    const keptIndex = (() => { try { return JSON.parse(readFileSync(join(netDir, 'index.json'), 'utf8')); } catch { return null; } })();
    check('an edit DSH refuses keeps nothing of the file', refusedEdit.some((r) => /has not been read|requires reading/.test(r.action?.text ?? ''))
        && readFileSync(unread, 'utf8') === 'left alone\n' && readdirSync(netDir).sort().join() === keptBefore
        && keptIndex !== null && !Object.keys(keptIndex.files ?? {}).some((path) => path.endsWith('unread.md')),
        `${refusedEdit.map((r) => r.action?.text ?? r.action?.tool).join(' | ').slice(0, 300)} ${readdirSync(netDir).join(' ')} ${JSON.stringify(Object.keys(keptIndex?.files ?? {}))}`);
    const tabA = await tabOf(web, coord, waitsId);
    const tabB = await tabOf(web, sessionB);
    check('each thread\'s Changes tab shows only its own edits, whatever DSH says of the folder', tabA.ok && tabA.value.files.length === 0
        && tabB.ok && tabB.value.files.map((f) => f.path).join() === 'b-new.txt' && tabB.value.files[0].edits[0].hunks[0]?.newText === 'from B\n',
        `${JSON.stringify(tabA).slice(0, 200)} ${JSON.stringify(tabB).slice(0, 300)}`);
    // B delegates to a subagent, which writes a file in its own session: B's tab shows it, by the subagent, at that turn.
    // (A line of its own: DSH 0.2.1 adds its own words to a child's prompt, right after it.)
    await say(sessionB, call('subagent', { description: 'Write a file', prompt: `${call('write', { file_path: join(ws, 'from-sub.txt'), content: 'sub one\nsub two\n' })}\n`, run_in_background: false }));
    const subIn = (read) => (read?.ok ? read.value.files.find((f) => f.path === 'from-sub.txt') : undefined);
    const tabSub = await waitFor(async () => { const got = await tabOf(web, sessionB); return subIn(got) ? got : null; }, 'the subagent\'s file in B\'s Changes tab', 20000).catch(() => null);
    const sub = subIn(tabSub);
    const bNew = tabSub?.value.files.find((f) => f.path === 'b-new.txt');
    check('a subagent\'s edit shows in its thread\'s Changes tab, by the subagent, at the turn that started it', sub?.added === 2 && sub.created === true
        && sub.edits[0]?.by === 'Write a file' && sub.edits[0].hunks[0]?.newText === 'sub one\nsub two\n' && sub.edits[0].turn > bNew?.edits[0].turn,
        JSON.stringify(tabSub?.value ?? null).slice(0, 700));
    check('a subagent\'s edit is in its thread\'s one diff of the file', sub?.net?.created === true && sub.net.hunks[0]?.newText === 'sub one\nsub two'
        && bNew?.net?.hunks[0]?.newText === 'from B', `${JSON.stringify(sub?.net ?? null)} ${JSON.stringify(bNew?.net ?? null)}`);

    // 22d. A message to a thread in the middle of a turn reaches that turn, so an answer the user gives the
    // chat gets there now, not when the turn ends (behaviour review 4, S3); steer=false queues it (15).
    mark = model.requests.length;
    await say(coord, call('thread_start', {
        ask: 'Please do this.',
        title: 'Xi',
        brief: `E2E:slow 4000\n${call('thread_handback', { status: 'done', summary: 'Xi done.' })}`,
    }));
    const xiId = Object.entries(project().threads ?? {}).find(([, t]) => t.title === 'Xi')?.[0];
    const steered = (await say(coord, call('thread_send', { thread: xiId, text: 'XI-ANSWER: the user picked the blue theme.' }))).filter((r) => whoOf(r) === 'coordinator');
    await coordinatorSaw(mark, 'SAW-HANDBACK', 'the Xi handback');
    await waitIdle(threadSession(xiId));
    const xiReqs = since(mark, xiId);
    check('a message to a thread in the middle of a turn goes into that turn, and the chat hears so', resultOf(steered) === `TOOL-RESULT: Steered into ${xiId}'s running turn.`
        && xiReqs.length === 2 && xiReqs[1].fresh.includes('XI-ANSWER') && readText(logFile).includes(`thread-send ${coord}/${xiId} mode=steer `),
        `${describe(xiReqs)} | ${resultOf(steered)} | ${xiReqs[1]?.fresh.slice(0, 200)}`);

    // 22e. The user quits DSH while a thread waits on a permission prompt. At the next start the
    // chat hears once that DSH closed while it ran, and nothing sends the thread on, so it
    // asks for nothing again.
    mark = model.requests.length;
    const quitProbe = join(root, 'outside', 'quit-probe.txt');
    await say(coord, call('thread_start', {
        ask: 'Please do this.',
        title: 'Nu',
        brief: call('write', { file_path: quitProbe, content: 'x', sandbox_permissions: 'danger-full-access', justification: 'E2E quit check.' }),
    }));
    await coordinatorSaw(mark, 'SAW-APPROVAL', 'the Nu approval note');
    const nuId = Object.entries(project().threads ?? {}).find(([, t]) => t.title === 'Nu')?.[0];

    // DSH restarts: the totals stay with the plugin, and Review is no longer offered.
    const lastSeq = lc?.last.seq;
    signInsBefore = signIns();
    const quitMark = model.requests.length;
    await stopDsh(child);
    // Views saved by an older version of the plugin, which DSH drops until the session is next loaded.
    const agedViews = ageViews([coord, threadSession('t1')], STATE_VERSION - 1);
    child = startDsh(dsh);
    await waitFor(async () => existsSync(sock) && (await bridge('GET', '/health')).ok, 'the session bridge after the second restart', 90000);
    const nuNote = await coordinatorSaw(quitMark, 'SAW-IDLE', 'the Nu note after the quit');
    // A prompt asked again would have been told by now (the plugin tells the chat at once).
    await sleep(3000);
    check('a thread waiting on a prompt when DSH quits is told once at the next start, is not sent on, and its prompt is not told again',
        nuNote.fresh.includes(`[Thread idle without a handback: ${nuId} · "Nu"]`) && nuNote.fresh.includes('The turn was cut off because DSH closed while it ran.')
        && since(quitMark, 'coordinator').filter((r) => r.fresh.includes(`${nuId} · "Nu"`)).length === 1 && since(quitMark, nuId).length === 0
        && !readText(logFile).includes(`nudge ${coord}/${nuId} `) && !existsSync(quitProbe), `${describe(since(quitMark))} | ${nuNote.fresh.slice(0, 300)}`);
    const viewsBack = await waitFor(() => agedViews.length === 2 && agedViews.every((id) => savedVersion(id) === STATE_VERSION), 'the old views read again', 30000).catch(() => false);
    // The two aged views, and any DSH hadn't saved yet when it quit (the thread cut off above).
    const refreshed = Number([...readText(logFile).matchAll(/records refreshed=(\d+)/g)].at(-1)?.[1] ?? 0);
    check('views an older version of the plugin saved are read again at start, from the store', viewsBack && refreshed >= 2
        && windowView(threadSession('t1'))?.role === 'thread' && windowView(threadSession('t1'))?.coordinator === coord && windowView(coord)?.role === 'coordinator',
        `${agedViews.length} aged; ${agedViews.map((id) => savedVersion(id)).join(',')}; records refreshed=${refreshed}`);
    web = await signInAgain(signInsBefore);
    lc = await waitFor(() => changesOf(web), 'the chat after the second restart', 30000).catch(() => undefined);
    card = lastSeq !== undefined ? await dshCard(web, lastSeq) : { status: 0, value: null };
    check('after a restart the thread\'s changes stay, without a diff to review', lc?.added === 4 && lc.deleted === 1 && lc.files === 1 && lc.reviewable === false && card.status === 404,
        `${JSON.stringify(lc)} ${card.status}`);
    tab = await tabOf(web, lambda);
    notes = notesIn(tab);
    const subAgain = subIn(await tabOf(web, coord, writesId));
    check('after a restart the Changes tab still shows the diffs, its subagent\'s too, and no turn to review in DSH', notes?.added === 4 && notes.edits.length === 2
        && tab.value.turns.length === 2 && tab.value.turns.every((t) => t.reviewable !== true) && subAgain?.edits[0]?.by === 'Write a file',
        `${JSON.stringify(tab).slice(0, 500)} ${JSON.stringify(subAgain ?? null).slice(0, 200)}`);
    check('after a restart each file\'s one diff is still there', notes?.net?.added === 3 && notes.net.hunks[0]?.newText === 'one\nTWO\nthree' && subAgain?.net?.created === true,
        `${JSON.stringify(notes?.net ?? null)} ${JSON.stringify(subAgain?.net ?? null)}`);
    mark = model.requests.length;
    await say(coord, 'Which threads changed files?');
    const lambdaLine = since(mark, 'coordinator')[0]?.system.split('\n').find((l) => l.startsWith(`- ${lambdaId} · "Lambda" · `)) ?? '';
    check('the chat\'s roster says what the thread changed', lambdaLine.startsWith(`- ${lambdaId} · "Lambda" · idle · no handback yet · the user talked to it directly`)
        && lambdaLine.endsWith(' · changed 1 file (+4 -1)'), lambdaLine);

    // 23. Failed and stopped threads: each thread's own view says how its
    // last turn ended (read cold after the restart; the crash cut Theta off),
    // the roster tells the chat, and Retry and Resume from the window
    // send the thread on.
    const endings = {};
    for (const id of ['t1', 't3', 't4', 't6', 't7', 't8']) endings[id] = (await viewOf(threadSession(id)))?.ending;
    const shape = (e) => (e ? [e.state, e.kind, e.cause ?? null] : null);
    check('a thread\'s own view says how its last turn ended', JSON.stringify(['t1', 't3', 't4', 't6', 't7', 't8'].map((id) => shape(endings[id])))
        === JSON.stringify([null, ['failed', 'error', null], ['stopped', 'aborted', 'user'], ['stopped', 'aborted', 'user'], ['failed', 'error', null], ['stopped', 'interrupted', null]]),
        JSON.stringify(endings));
    check('a failure reads as the provider\'s message', endings.t3?.message === 'fake model rejected the request' && typeof endings.t3?.code === 'string', JSON.stringify(endings.t3));
    mark = model.requests.length;
    await say(coord, 'Which threads failed?');
    const roster = since(mark, 'coordinator')[0]?.system.split('\n').filter((l) => l.startsWith('- t')) ?? [];
    const lineOf = (id) => roster.find((l) => l.startsWith(`- ${id} · `)) ?? '';
    check('the roster tells the chat which threads failed or stopped', lineOf('t3').includes('· its last turn failed (HTTP 400): fake model rejected the request')
        && lineOf('t4').includes('· stopped by the user (they can resume it) ·') && lineOf('t8').includes('· its last turn was cut off because DSH closed while it ran.')
        && lineOf('t7').includes('last handback: done') && lineOf('t7').includes('its last turn failed') && !lineOf('t1').includes('its last turn'), roster.join('\n'));
    check('the chat is told to leave a thread the user stopped stopped', since(mark, 'coordinator')[0]?.system.includes('A thread the user stopped stays stopped: when you mention it, say the user stopped it and it can be resumed.'));
    // Retry: the thread hears it from its chat, runs, and its failure clears.
    const refusedWhy = (answer) => (answer.ok ? 'ok' : `${answer.error?.code}: ${answer.error?.message}`);
    answer = await webApi(web, 'dsh-plugin-coordinator/continueThread', { target: coord, thread: 't1' });
    check('a thread whose last turn finished has nothing to retry', !answer.ok && answer.error?.code === 'coordinator/refused' && /nothing to retry/.test(answer.error.message), refusedWhy(answer));
    answer = await webApi(web, 'dsh-plugin-coordinator/continueThread', { target: coord, thread: 't2' });
    check('a resolved thread is not retried', !answer.ok && /is resolved/.test(answer.error?.message ?? ''), refusedWhy(answer));
    mark = model.requests.length;
    answer = await webApi(web, 'dsh-plugin-coordinator/continueThread', { target: threadSession('t3'), thread: 't3' });
    saw = await coordinatorSaw(mark, 'SAW-IDLE', 'the Gamma retry\'s idle note');
    const retried = since(mark, 't3')[0];
    check('Retry sends the thread on from its chat', answer.ok && answer.value?.project?.id === coord
        && retried?.fresh.includes('[From the coordinator]\n\nThe user asked you to try again. Your last turn failed (HTTP 400): fake model rejected the request. Carry on from where you left off.') && retried.action.text === 'RESUMED'
        && fromSession(startingWith(await messagesOf(threadSession('t3')), '[From the coordinator]'), coord), `${refusedWhy(answer)} ${retried?.fresh.slice(0, 300)}`);
    // Retry starts the count again, so the plugin nudges the retried turn that ended without a handback, and the chat hears after that.
    check('the chat hears how the retry went, after the plugin\'s nudge', saw.fresh.includes('[Thread idle without a handback: t3 · "Gamma"]')
        && since(mark, 't3').length === 2 && since(mark, 't3')[1].fresh.includes('Finish the task and call thread_handback.'), `${describe(since(mark))} | ${saw.fresh.slice(0, 300)}`);
    check('a turn that finishes clears the failure', (await viewOf(threadSession('t3')))?.ending === undefined, JSON.stringify(await viewOf(threadSession('t3'))));
    // Resume: the same for a stopped thread.
    mark = model.requests.length;
    answer = await webApi(web, 'dsh-plugin-coordinator/continueThread', { target: coord, thread: 't4' });
    await coordinatorSaw(mark, 'SAW-IDLE', 'the Delta resume\'s idle note');
    check('Resume continues a stopped thread', answer.ok && since(mark, 't4')[0]?.fresh.includes('The user asked you to continue. Your last turn was stopped by the user before it finished.')
        && (await viewOf(threadSession('t4')))?.ending === undefined, `${refusedWhy(answer)} ${since(mark, 't4')[0]?.fresh.slice(0, 300)}`);
    check('the plugin logs each retry', readText(logFile).includes(`thread-continue ${coord}/t3 after=error`) && readText(logFile).includes(`thread-continue ${coord}/t4 after=aborted`));

    // 24. Another chat, in another folder, coordinates too: its Coordinate button (the plugin's coordinate
    // endpoint) runs /coordinate there, so DSH shows it in that chat and folds the chat's record from it. Its
    // threads are its own, numbered from t1, and work in its folder. A thread can't coordinate.
    const secondDir = join(root, 'second');
    mkdirSync(secondDir);
    second = (await bridge('POST', '/sessions', { workspacePath: secondDir, title: SECOND, text: 'Hello, second chat.' })).sessionId;
    await waitFor(() => model.requests.some((r) => r.fresh.includes('Hello, second chat.')), 'the second chat\'s first turn');
    await waitIdle(second);
    const api = (method, args) => webApi(web, `dsh-plugin-coordinator/${method}`, args);
    answer = await api('coordinate', { target: second, on: true });
    check('Coordinate in another chat makes it coordinate, as /coordinate does', answer.ok && answer.value.coordinating === true && answer.value.session === second
        && answer.value.text === COORDINATING && answer.value.projects.map((p) => p.id).sort().join() === [coord, second].sort().join(), JSON.stringify(answer).slice(0, 400));
    const secondRan = (await bridge('GET', `/sessions/${second}/events?types=command/run,command/done&limit=20`)).events.map((e) => e.type);
    const secondView = await viewOf(second);
    check('DSH runs it as the command in that chat, and the window\'s record of the chat names it by its title', secondRan.join() === 'command/run,command/done'
        && secondView?.role === 'coordinator' && secondView.project?.id === second && secondView.project.name === SECOND, `${secondRan.join()} ${JSON.stringify(secondView)}`);
    answer = await api('coordinate', { target: threadSession('t1'), on: true });
    check('a thread can\'t coordinate: it reports to its chat', !answer.ok && answer.error?.code === 'coordinator/refused'
        && (answer.error.message ?? '').includes(`This chat is a thread: it reports to "${CHAT}", which coordinates it.`), JSON.stringify(answer).slice(0, 300));
    mark = model.requests.length;
    await say(second, call('thread_start', { ask: 'Please do this.', title: 'Elsewhere', brief: 'Just answer.' }));
    await waitFor(() => since(mark, 'second').some((r) => r.action.text === 'SAW-IDLE'), 'the Elsewhere idle note');
    await waitIdle(second);
    const elsewhere = store().projects?.[second]?.threads?.t1;
    const elsewhereView = elsewhere ? await bridge('GET', `/sessions/${elsewhere.sessionId}`) : null;
    check('its threads are its own, numbered from t1, and work in its folder', elsewhere?.title === 'Elsewhere' && elsewhereView?.cwd === realpathSync(secondDir)
        && since(mark, `${SECOND}/t1`)[0]?.fresh.includes(`[Brief from the chat "${SECOND}" · you are thread t1, "Elsewhere"]`)
        && !Object.values(project().threads ?? {}).some((t) => t.title === 'Elsewhere'), `${JSON.stringify(elsewhereView).slice(0, 200)} | ${describe(since(mark))}`);

    // 24b. A chat that coordinates before its first message. DSH's new-chat screen is a chat DSH makes when the user
    // picks a folder there, shown as that screen until it has a message; a command run there gives it none. /coordinate
    // typed there, or the switch there (the coordinate endpoint), makes it coordinate, and the user's first message
    // starts its first turn as a coordinating chat's.
    const startDir = join(root, 'start');
    mkdirSync(startDir);
    const newChat = async () => {
        const made = await webApi(web, 'session/create', { request: { cwd: startDir } });
        if (!made.ok) throw new Error(`session/create: ${JSON.stringify(made.error).slice(0, 200)}`);
        return made.value.sessionId;
    };
    /** Whether DSH shows a chat as its new-chat screen: its list record says the chat has no turn yet. */
    const isNew = async (sessionId) => (await webApi(web, 'session/projections', { request: { sessionId } })).value?.values?.sessionListMetadata?.blank;
    const typedIn = await newChat();
    answer = await command(typedIn, '/coordinate');
    check('/coordinate as a new chat\'s first input makes it coordinate', answer.ok && answer.value?.result?.kind === 'success' && answer.value.result.text === COORDINATING
        && (await viewOf(typedIn))?.role === 'coordinator' && store().projects?.[typedIn]?.coordinatorSessionId === typedIn, JSON.stringify(answer).slice(0, 300));
    check('and DSH still shows that chat as its new-chat screen, where the switch shows it', await isNew(typedIn) === true, String(await isNew(typedIn)));
    const switched = await newChat();
    check('a chat on the new-chat screen can coordinate', await isNew(switched) === true && (await viewOf(switched)) == null, JSON.stringify(await viewOf(switched)));
    answer = await api('coordinate', { target: switched, on: true });
    check('the switch there makes it coordinate before its first message', answer.ok && answer.value.coordinating === true && answer.value.session === switched
        && answer.value.text === COORDINATING && (await viewOf(switched))?.role === 'coordinator', JSON.stringify(answer).slice(0, 300));
    mark = model.requests.length;
    const opening = 'Hello from a chat that started coordinating.';
    await say(switched, opening);
    const firstTurn = since(mark).find((r) => r.fresh.includes(opening));
    const startFolder = store().projects?.[switched]?.folder;
    check('the user\'s first message there starts its first turn with the coordinating chat\'s rules and tools', typeof startFolder === 'string'
        && firstTurn?.system.includes('# Coordinating threads') === true && firstTurn.system.includes(`\nThreads work in: ${startFolder}\n`) && firstTurn.tools.includes('thread_start'),
    `${startFolder} | ${firstTurn?.tools.join(',')} | ${firstTurn?.system.slice(0, 200)}`);
    check('and from then on DSH shows it as a chat', await isNew(switched) === false, String(await isNew(switched)));

    // 25. The user's tools and permissions. lane-catalog, one of the user's own tools in this profile
    // (guardedTools), runs as an MCP server for every session. A coordinating chat has it, as any chat does;
    // under "Your tools: Only when asked", the default, a thread has it only when the user's own words for it
    // name it. Threads run on Workspace Write; DSH's default here is Full access, as in the user's own DSH,
    // and a coordinating chat keeps its own permission.
    const LANES = 'mcp__lane-catalog__lanes_status';
    const plainId = (await bridge('POST', '/sessions', { workspacePath: join(root, 'plain'), text: 'Hello plain session.' })).sessionId;
    await waitIdle(plainId);
    const plainReq = model.requests.find((r) => r.fresh.includes('Hello plain session.'));
    check('the user\'s MCP server reaches an ordinary session', plainReq?.tools.includes(LANES) === true, plainReq?.tools.join(','));
    // notes_read comes from a plugin that marks it as the user's own (personal-tool/), and no list names it.
    const NOTES = 'notes_read';
    check('a tool another plugin marks as the user\'s own reaches an ordinary session too', plainReq?.tools.includes(NOTES) === true, plainReq?.tools.join(','));
    reqs = await say(coord, `E2E:force ${LANES} {}`);
    check('a coordinating chat has the user\'s tools, as any chat does, the one another plugin marks too', reqs[0]?.tools.includes(LANES) && reqs[0].tools.includes(NOTES)
        && reqs[0].tools.includes('thread_start'), reqs[0]?.tools.join(','));
    check('and its call reaches the server', resultOf(reqs).includes('alpha up, beta up') && mcpCount() === 1, `${resultOf(reqs)} | ${mcpCount()}`);
    // The second chat: the user hasn't named the tool there. The start's arguments go as JSON with every "l"
    // escaped, so the message that carries them (the user's words, here) names no tool, nor "lanes", while the ask does.
    const s4 = 'Use lane-catalog to check which of my model lanes are up right now.';
    const lanesStart = `E2E:call thread_start ${JSON.stringify({ ask: s4, title: 'Lanes up', brief: `Report which are up. E2E:force ${LANES} {}` }).replace(/l/g, '\\u006c').replace(/L/g, '\\u004c')}`;
    reqs = await say(second, lanesStart);
    check('an ask that names the user\'s tool when the user never did is refused', resultOf(reqs).startsWith('TOOL-RESULT: Failed: ask names lane-catalog, but the user\'s messages don\'t.')
        && readText(logFile).includes(` guard ${second} ask-unsaid lane-catalog`) && !secondThreads().some((t) => t.title === 'Lanes up'), resultOf(reqs));
    await say(second, s4);
    mark = model.requests.length;
    reqs = await say(second, lanesStart);
    check('once the user asks for it by name, the thread starts with it', /^TOOL-RESULT: Started t\d+ "Lanes up"\. It reports back when done\. The user's words give it lane-catalog\./.test(resultOf(reqs.filter((r) => whoOf(r) === 'second'))),
        resultOf(reqs.filter((r) => whoOf(r) === 'second')));
    await waitFor(() => since(mark, 'second').some((r) => r.action.text === 'SAW-IDLE'), 'the Lanes up idle note');
    await waitIdle(second);
    const lanesReqs = since(mark).filter((r) => /You are thread t\d+, "Lanes up", started by the DSH chat "Second Chat"/.test(r.system));
    check('the thread is offered the tool the user\'s words name, and its call reaches the server', lanesReqs[0]?.tools.includes(LANES) && resultOf(lanesReqs).includes('alpha up, beta up')
        && mcpCount() === 2 && new RegExp(` wall ${second}/t\\d+ \\S+ hid=\\d+ allowed=lane-catalog\\n`).test(readText(logFile)),
        `${lanesReqs[0]?.tools.filter((t) => t.startsWith('mcp__')).join(',')} | ${resultOf(lanesReqs)} | ${mcpCount()}`);
    check('and not the marked tool its words don\'t ask for', lanesReqs.length > 0 && lanesReqs.every((r) => !r.tools.includes(NOTES)), lanesReqs[0]?.tools.join(','));
    // The user's own words give the marked tool's group to a thread, by the words its plugin set ("my notes app").
    const notesAsk = 'Read my notes app and tell me the first line.';
    await say(second, notesAsk);
    mark = model.requests.length;
    reqs = await say(second, call('thread_start', { ask: notesAsk, title: 'Notes', brief: `Read them. E2E:force ${NOTES} {}` }));
    await waitFor(() => since(mark, 'second').some((r) => r.action.text === 'SAW-IDLE'), 'the Notes idle note');
    await waitIdle(second);
    const notesReqs = since(mark).filter((r) => /You are thread t\d+, "Notes", started by the DSH chat "Second Chat"/.test(r.system));
    check('the user\'s own words give a thread the marked tool, and its call reaches it', /The user's words give it notes-app\./.test(resultOf(reqs.filter((r) => whoOf(r) === 'second')))
        && notesReqs[0]?.tools.includes(NOTES) && resultOf(notesReqs).includes('NOTES: buy milk'), `${resultOf(reqs).slice(0, 200)} | ${resultOf(notesReqs).slice(0, 200)}`);
    // The user writes to a thread directly: the tools their words there name are its own from that turn on.
    mark = model.requests.length;
    await say(t2, `Please ask lane-catalog which are up. E2E:force ${LANES} {}`);
    const direct = since(mark, 't2');
    check('the user\'s own words in a thread give it that tool for the same turn', direct[0]?.tools.includes(LANES) && resultOf(direct).includes('alpha up, beta up')
        && readText(logFile).includes(`tools ${coord}/t2 +lane-catalog from the user in the thread`), `${direct[0]?.tools.filter((t) => t.startsWith('mcp__')).join(',')} | ${resultOf(direct)}`);
    // Permissions, as DSH itself holds them.
    let described = await webApi(web, 'dsh-plugin-coordinator/describe', { target: second });
    const lanesRow = described.value?.threads?.find((t) => t.title === 'Lanes up');
    const secondValues = await webApi(web, 'session/projections', { request: { sessionId: second } });
    check('a thread runs on Workspace Write, its chat keeps its own permission (DSH\'s default here), and the window shows both', described.ok && lanesRow?.permission === 'workspace-write'
        && lanesRow.tools?.join() === 'lane-catalog' && secondValues.value?.values?.permissions?.currentValue === 'danger-full-access'
        && described.value.permissions?.options?.map((o) => o.value).join() === 'read-only,workspace-write,danger-full-access',
        `${JSON.stringify(described.value ?? described).slice(0, 500)} ${JSON.stringify(secondValues.value?.values?.permissions ?? secondValues).slice(0, 200)}`);
    const lanesThread = secondThreads().find((t) => t.title === 'Lanes up');
    const lanesEvents = (await bridge('GET', `/sessions/${lanesThread?.sessionId}/events?types=permission/preset,user/message&limit=50`)).events;
    const presetAt = lanesEvents.findLastIndex((e) => e.type === 'permission/preset');
    check('it is on Workspace Write before it reads its brief', presetAt > 0 && lanesEvents.findIndex((e) => e.type === 'user/message') > presetAt, JSON.stringify(lanesEvents.map((e) => e.type)));
    described = await webApi(web, 'dsh-plugin-coordinator/describe', { target: coord });
    check('every thread the plugin started ran on Workspace Write', described.ok && described.value.threads.length > 3 && described.value.threads.every((t) => t.permission === 'workspace-write'),
        JSON.stringify(described.value?.threads?.map((t) => [t.id, t.permission])));
    // Thread settings puts new threads on another permission.
    let changed = await webApi(web, 'dsh-plugin-coordinator/update', { target: second, changes: { threadPermission: 'read-only' } });
    check('Thread settings puts the chat\'s new threads on another permission', changed.ok && changed.value.access.threadPermission.value === 'read-only'
        && changed.value.access.threadPermission.source === 'chat setting', JSON.stringify(changed).slice(0, 400));
    const readOnlyFile = join(secondDir, 'read-only-probe.txt');
    mark = model.requests.length;
    await say(second, call('thread_start', { ask: 'Please do this.', title: 'Read only', brief: call('write', { file_path: readOnlyFile, content: 'x' }) }));
    // DSH's sandbox refuses the write, or asks the user; either way nothing is written.
    await waitFor(() => since(mark, 'second').some((r) => /^SAW-(IDLE|APPROVAL)$/.test(r.action.text ?? '')), 'the Read only note');
    described = await webApi(web, 'dsh-plugin-coordinator/describe', { target: second });
    check('a thread on Read Only can\'t write even in its own folder', described.value?.threads?.find((t) => t.title === 'Read only')?.permission === 'read-only' && !existsSync(readOnlyFile),
        resultOf(since(mark).filter((r) => /You are thread t\d+, "Read only", started by the DSH chat/.test(r.system))));

    // 25b. Rule 6, held by the plugin: a thread's command that sends outside the workspace waits for the user in DSH's
    // prompt, which says what it sends, and its chat hears so; Allow once runs it once, and the same command
    // again, as a retry, asks again (a Reject sends nothing); a read runs; two sends in one step ask once; a send that
    // asks for a wider sandbox is asked about before DSH asks to widen it; a thread whose approvals never ask is refused,
    // with what the user can do. The coordinating chat's own sends and deletes run as DSH decides for any chat. The
    // test answers the prompt as the window does.
    const hits = [];
    const sink = createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        req.resume();
        req.on('end', () => res.end(req.method === 'GET' ? 'SINK-UP' : 'SINK-RECEIVED'));
    });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    const sinkAt = `127.0.0.1:${sink.address().port}`;
    const posted = () => hits.filter((h) => !h.startsWith('GET ')).length;
    const prompts = await approvalsOf(web);
    try {
        const deploy = { command: `curl -sS -X POST --data '{"v":1}' http://${sinkAt}/deploy`, description: 'Deploy the build' };
        const sends = `sends a POST to ${sinkAt}/deploy (curl)`;
        const ofDeploy = (r) => r.toolName === 'bash' && r.reason === `the command ${sends}. The thread says: "Deploy the build"`;
        mark = model.requests.length;
        await say(coord, call('thread_start', { ask: 'Deploy the build to staging.', title: 'Send', brief: call('bash', deploy) }));
        const first = await prompts.next('the Send prompt', ofDeploy);
        saw = await coordinatorSaw(mark, 'SAW-APPROVAL', 'the Send approval note');
        const sendId = Object.entries(project().threads ?? {}).find(([, t]) => t.title === 'Send')?.[0];
        const asks = () => readText(logFile).split('\n').filter((line) => line.endsWith(` send-ask ${coord}/${sendId} request curl`)).length;
        check('a thread\'s command that sends waits for the user in DSH\'s prompt, which says what it sends, then the thread\'s own words for it',
            first.request.displayReason?.en === `This command ${sends}. A thread asks you before each command that sends outside the workspace.\nThe thread says: "Deploy the build"`
            && posted() === 0 && asks() === 1, JSON.stringify(first.request));
        check('its chat hears what it waits on', saw.fresh.includes(`[Thread waiting for approval: ${sendId} · "Send"]`)
            && saw.fresh.includes(`It asked to use bash: the command ${sends}`), saw.fresh.slice(0, 400));
        mark = model.requests.length;
        const allowed = await prompts.answer(first, 'allowed-once');
        const allowSaw = await coordinatorSaw(mark, 'SAW-IDLE', 'the Send idle note');
        // Round-1 finding 5: the chat's roster line says how the user answered the thread's prompt, and when.
        const rosterOf = (req) => (req?.system ?? '').split('\n').find((line) => line.includes(' · "Send" · ')) ?? '';
        check('the chat\'s roster line says the user allowed the thread\'s command, and when',
            rosterOf(allowSaw).includes(`· the user allowed its command that ${sends} at `) && / at \d{1,2}:\d\d\s[AP]M$/.test(rosterOf(allowSaw)), rosterOf(allowSaw));
        check('Allow once runs it, once', allowed?.ok === true && hits.filter((h) => h === 'POST /deploy').length === 1 && resultOf(since(mark, sendId)).includes('SINK-RECEIVED'),
            `${JSON.stringify(allowed)} ${hits.join()} ${resultOf(since(mark, sendId))}`);
        mark = model.requests.length;
        await say(coord, call('thread_send', { thread: sendId, text: call('bash', deploy) }));
        const again = await prompts.next('the retry\'s prompt', ofDeploy);
        await prompts.answer(again, 'rejected');
        const retrySaw = await coordinatorSaw(mark, 'SAW-IDLE', 'the retry\'s idle note');
        check('the same command again, as a retry, asks again, and a Reject sends nothing', again.eventId !== first.eventId && asks() === 2 && posted() === 1,
            `${asks()} ${hits.join()}`);
        check('after the Reject, the roster line says the user declined it, and that the thread was told to hand back needs_decision',
            rosterOf(retrySaw).includes(`· the user declined its command that ${sends} at `) && / at \d{1,2}:\d\d\s[AP]M \(it was told to hand back needs_decision\)$/.test(rosterOf(retrySaw)), rosterOf(retrySaw));
        // Behaviour review 5, S3 r4: the thread reads what the user declined and to hand back needs_decision, and its
        // chat hears it with the thread's next note, so its reply says so.
        check('after a Reject, the thread reads what the user declined, and its chat hears it',
            resultOf(since(mark, sendId)).includes(`Error: the user declined this command at the prompt: it ${sends}. Don't run it`)
            && retrySaw.fresh.includes(`The user declined its prompt for a command that ${sends}.`), `${resultOf(since(mark, sendId))} ${retrySaw.fresh.slice(0, 600)}`);
        // Its first turn used up its nudge, and the chat's retry starts no new count; the user's answer does, so
        // the retry's turn that ended without a handback was nudged before the chat heard.
        const retryLog = readText(logFile).split('\n').filter((line) => line.includes(` ${coord}/${sendId} `) && / (prompt-answered|nudge|idle-note) /.test(line)).slice(-3).map((line) => line.split(' ')[1]);
        check('after the user answers its prompt, a turn that ends without a handback gets its own nudge', retryLog.join() === 'prompt-answered,nudge,idle-note', retryLog.join());
        mark = model.requests.length;
        await say(coord, call('thread_start', { ask: 'Check that staging is up.', title: 'Read', brief: call('bash', { command: `curl -sS http://${sinkAt}/health`, description: 'Check staging' }) }));
        await coordinatorSaw(mark, 'SAW-IDLE', 'the Read idle note');
        const readId = Object.entries(project().threads ?? {}).find(([, t]) => t.title === 'Read')?.[0];
        const readAsked = (await bridge('GET', `/sessions/${threadSession(readId)}/events?types=approval/asked&limit=20`)).events ?? [];
        check('a read runs without asking', hits.includes('GET /health') && readAsked.length === 0, `${hits.join()} ${readAsked.length}`);
        // Two sends in one step: DSH asks about them one after another, so the plugin puts the first in front of the user
        // and refuses the second unasked; the thread reads the answer before it sends again.
        mark = model.requests.length;
        const both = [call('bash', { command: `curl -sS -X POST http://${sinkAt}/first`, description: 'Send the first' }), call('bash', { command: `curl -sS -X POST http://${sinkAt}/second`, description: 'Send the second' })];
        await say(coord, call('thread_start', { ask: 'Send both.', title: 'Both', brief: both.join('\n') }));
        const firstOfTwo = await prompts.next('the Both prompt', (r) => r.toolName === 'bash' && r.reason?.startsWith(`the command sends a POST to ${sinkAt}/first (curl)`));
        await prompts.answer(firstOfTwo, 'rejected');
        await coordinatorSaw(mark, 'SAW-IDLE', 'the Both idle note');
        const bothId = Object.entries(project().threads ?? {}).find(([, t]) => t.title === 'Both')?.[0];
        const bothAsked = (await bridge('GET', `/sessions/${threadSession(bothId)}/events?types=approval/asked&limit=20`)).events ?? [];
        check('two sends in one step put one prompt in front of the user; the other is refused unasked, with what to do', bothAsked.length === 1 && posted() === 1
            && resultOf(since(mark, bothId)).includes(`the command sends a POST to ${sinkAt}/second (curl). Another command of yours that sends, from the same step, went to the user first`)
            && readText(logFile).includes(`send-refused ${coord}/${bothId} request curl one-at-a-time`), `${bothAsked.length} ${hits.join()} ${resultOf(since(mark, bothId))}`);
        // A send that asks for a wider sandbox: the plugin's prompt comes first, and DSH asks to widen the sandbox only
        // once that one is allowed, in the tool itself. A Reject there sends nothing.
        mark = model.requests.length;
        const wide = { command: `curl -sS -X POST http://${sinkAt}/wide`, description: 'Send it wide', sandbox_permissions: 'danger-full-access', justification: 'E2E escalation check.' };
        await say(coord, call('thread_start', { ask: 'Send it with wider access.', title: 'Wide', brief: call('bash', wide) }));
        const ours = await prompts.next('the Wide prompt', (r) => r.toolName === 'bash' && r.reason?.startsWith(`the command sends a POST to ${sinkAt}/wide (curl)`));
        await prompts.answer(ours, 'allowed-once');
        const widen = await prompts.next('DSH\'s prompt to widen the Wide sandbox', (r) => r.toolName === 'bash' && r.reason === 'escalate sandbox to danger-full-access: E2E escalation check.');
        await prompts.answer(widen, 'rejected');
        await coordinatorSaw(mark, 'SAW-IDLE', 'the Wide idle note');
        check('a send that asks for a wider sandbox shows the plugin\'s prompt first, and DSH asks to widen it only after that Allow once',
            ours.request.displayReason?.en === `This command sends a POST to ${sinkAt}/wide (curl). A thread asks you before each command that sends outside the workspace.\nThe thread says: "Send it wide" and, for wider access, "E2E escalation check."`
            && posted() === 1, `${JSON.stringify(ours.request)} ${JSON.stringify(widen.request)} ${hits.join()}`);
        // The coordinating chat keeps the user's own access: on Full access its send and its delete run without a prompt,
        // and the plugin holds neither.
        const coordAsked = async () => ((await bridge('GET', `/sessions/${coord}/events?types=approval/asked&limit=50`)).events ?? []).length;
        const askedBefore = await coordAsked();
        const holds = () => readText(logFile).split('\n').filter((line) => / (send|delete)-(ask|refused) /.test(line)).length;
        const holdsBefore = holds();
        reqs = await say(coord, call('bash', { command: `curl -sS -X POST http://${sinkAt}/deploy`, description: 'Deploy' }));
        check('a coordinating chat\'s own send runs as DSH decides: here, on Full access, without a prompt', resultOf(reqs).includes('SINK-RECEIVED')
            && posted() === 2 && (await coordAsked()) === askedBefore && holds() === holdsBefore, `${resultOf(reqs).slice(0, 300)} ${hits.join()} ${holds() - holdsBefore}`);
        const chatOld = join(ws, 'chat-old');
        mkdirSync(chatOld);
        writeFileSync(join(chatOld, 'notes.txt'), 'the user\'s notes\n');
        reqs = await say(coord, call('bash', { command: `rm -rf ${JSON.stringify(chatOld)}`, description: 'Remove the old notes' }));
        check('and so does its delete of files it didn\'t create', !existsSync(chatOld) && (await coordAsked()) === askedBefore && holds() === holdsBefore,
            `${existsSync(chatOld)} ${resultOf(reqs).slice(0, 300)} ${holds() - holdsBefore}`);
        changed = await webApi(web, 'dsh-plugin-coordinator/update', { target: second, changes: { threadPermission: 'danger-full-access' } });
        mark = model.requests.length;
        await say(second, call('thread_start', { ask: 'Please do this.', title: 'Never asks', brief: call('bash', { command: `curl -sS -X POST http://${sinkAt}/deploy`, description: 'Deploy' }) }));
        await waitFor(() => since(mark, 'second').some((r) => r.action.text === 'SAW-IDLE'), 'the Never asks idle note');
        await waitIdle(second);
        const neverReqs = since(mark).filter((r) => /You are thread t\d+, "Never asks", started by the DSH chat "Second Chat"/.test(r.system));
        check('a thread whose approvals never ask can\'t send, and hears what the user can do', changed.ok && resultOf(neverReqs).includes('this thread\'s permission never asks')
            && resultOf(neverReqs).includes('the user can put this thread on Workspace Write') && posted() === 2 && new RegExp(` send-refused ${second}/t\\d+ request curl never-asks`).test(readText(logFile)), resultOf(neverReqs));
        await webApi(web, 'dsh-plugin-coordinator/update', { target: second, changes: { threadPermission: 'read-only' } });

        // 25c. Deletes (batch 5 review M1, M2): a folder a thread's command made is its own with what it put there, but
        // not with the user's folder moved into it (B1); on DSH 0.2.1 a relative path is from the thread's working
        // directory (M2). The threads above do these. The test rejects each prompt, so nothing goes.
        const deleteAsks = (id) => readText(logFile).split('\n').filter((line) => line.endsWith(` delete-ask ${coord}/${id} rm`)).length;
        mkdirSync(join(ws, 'legacy'), { recursive: true });
        writeFileSync(join(ws, 'legacy', 'notes.txt'), 'the user\'s notes\n');
        // The user's folder is from before the thread's command, past the clock's slack the plugin allows.
        await sleep(2500);
        const tidyId = sendId;
        mark = model.requests.length;
        await say(coord, call('thread_send', { thread: tidyId, text: call('bash', { command: `cd ${ws} && mkdir old && mv legacy old/ && mkdir -p scratch && echo hi > scratch/a.txt`, description: 'Move the old notes' }) }));
        await coordinatorSaw(mark, 'SAW-IDLE', 'the Tidy idle note');
        check('a thread\'s command that makes folders keeps them as its own', existsSync(join(ws, 'old', 'legacy', 'notes.txt')) && readText(logFile).includes(`made-dirs ${coord}/${tidyId} 2`),
            readText(logFile).split('\n').filter((line) => line.includes('made-dirs')).join(' | '));
        mark = model.requests.length;
        await say(coord, call('thread_send', { thread: tidyId, text: call('bash', { command: `cd ${ws} && rm -rf scratch`, description: 'Clean up the scratch folder' }) }));
        await coordinatorSaw(mark, 'SAW-IDLE', 'the scratch idle note');
        check('what a thread\'s command made, it deletes without asking', !existsSync(join(ws, 'scratch')) && deleteAsks(tidyId) === 0, `${deleteAsks(tidyId)}`);
        mark = model.requests.length;
        await say(coord, call('thread_send', { thread: tidyId, text: call('bash', { command: `cd ${ws} && rm -rf old`, description: 'Remove the old folder' }) }));
        const tidyAsk = await prompts.next('the Tidy delete prompt', (r) => r.toolName === 'bash' && r.reason?.startsWith('the command deletes old (rm)'));
        await prompts.answer(tidyAsk, 'rejected');
        await coordinatorSaw(mark, 'SAW-IDLE', 'the Tidy delete idle note');
        check('B1: the user\'s folder moved into one the thread made still asks before it goes, and a Reject keeps it',
            existsSync(join(ws, 'old', 'legacy', 'notes.txt')) && deleteAsks(tidyId) === 1
            && tidyAsk.request.displayReason?.en === 'This command deletes old (rm). A thread asks you before each command that deletes files it didn\'t create.', JSON.stringify(tidyAsk.request));
        // Round-1 finding 6: a move out of its folder asks as a delete does and says where it goes; a Reject keeps the file.
        mark = model.requests.length;
        await say(coord, call('thread_send', { thread: tidyId, text: call('bash', { command: `cd ${ws} && mv old/legacy/notes.txt /tmp/`, description: 'Move the notes away' }) }));
        const moveAsk = await prompts.next('the Tidy move prompt', (r) => r.toolName === 'bash' && r.reason?.startsWith('the command moves old/legacy/notes.txt to /tmp/ (mv)'));
        await prompts.answer(moveAsk, 'rejected');
        await coordinatorSaw(mark, 'SAW-IDLE', 'the Tidy move idle note');
        check('a thread\'s move out of its folder asks, saying what goes where, and a Reject keeps the file',
            existsSync(join(ws, 'old', 'legacy', 'notes.txt'))
            && moveAsk.request.displayReason?.en === 'This command moves old/legacy/notes.txt to /tmp/ (mv). A thread asks you before each command that deletes files it didn\'t create or moves them out of its folder.', JSON.stringify(moveAsk.request));
        mkdirSync(join(ws, 'packages', 'web', 'src'), { recursive: true });
        writeFileSync(join(ws, 'packages', 'web', 'src', 'main.js'), 'console.log(1);\n');
        const webId = readId;
        if (model.requests.some((r) => whoOf(r) === webId && r.tools.includes('working_directory'))) {
            mark = model.requests.length;
            await say(coord, call('thread_send', { thread: webId, text: call('working_directory', { cd: join(ws, 'packages', 'web') }) }));
            await coordinatorSaw(mark, 'SAW-IDLE', 'the working directory idle note');
            mark = model.requests.length;
            await say(coord, call('thread_send', { thread: webId, text: call('bash', { command: 'rm -rf src', description: 'Remove the old sources' }) }));
            // Said from the thread's folder (round-1 finding 4), so which src goes is plain.
            const webAsk = await prompts.next('the Web delete prompt', (r) => r.toolName === 'bash' && r.reason?.startsWith('the command deletes packages/web/src (rm)'));
            await prompts.answer(webAsk, 'rejected');
            await coordinatorSaw(mark, 'SAW-IDLE', 'the Web delete idle note');
            check('M2: after working_directory, a relative delete is judged where it runs: it asks, says the path from the thread\'s folder, and a Reject keeps it',
                existsSync(join(ws, 'packages', 'web', 'src', 'main.js')) && deleteAsks(webId) === 1
                && webAsk.request.displayReason?.en?.startsWith('This command deletes packages/web/src (rm). '), `${deleteAsks(webId)} ${JSON.stringify(webAsk.request)}`);
        } else {
            console.log('  (this DSH has no working_directory tool: the M2 check is for DSH 0.2.1)');
        }
    } finally {
        prompts.close();
        sink.close();
    }

    // 26. A coordinating chat's message to another chat (chat_message): to a chat that doesn't coordinate, and to
    // one that does. The chat that gets it stays as it is: no thread tools or rules, no role in the window. Its
    // answer comes back once, and a turn the message started can't send one on.
    const plainName = (await bridge('GET', `/sessions/${plainId}`)).title || plainId;
    const ours = (r) => whoOf(r) === 'coordinator';
    mark = model.requests.length;
    reqs = await say(coord, call('chat_message', { to: plainId, ask: 'Say hello to my plain chat for me.', text: 'Hello from the e2e chat.' }));
    check('a coordinating chat sends another chat the message the user asked for', resultOf(reqs) === `TOOL-RESULT: Sent to "${plainName}". Its reply comes back to you once, as a note.`, resultOf(reqs));
    const plainSaw = await waitFor(() => since(mark).find((r) => r.fresh.includes(`[Message from the chat "${CHAT}"]`)), 'the chat\'s turn on the message');
    check('the chat reads it as from the coordinating chat, with the user\'s words, and has no thread tools or rules', plainSaw.fresh.includes('The user asked: "Say hello to my plain chat for me."')
        && plainSaw.fresh.includes('Hello from the e2e chat.') && !plainSaw.tools.some((t) => t.startsWith('thread_')) && whoOf(plainSaw) === 'other',
    `${plainSaw.tools.filter((t) => t.startsWith('thread_')).join(',')} | ${plainSaw.fresh.slice(0, 300)}`);
    const replyReq = await waitFor(() => since(mark).find((r) => ours(r) && r.fresh.includes(`[Reply from "${plainName}"]`)), 'the reply note');
    await waitIdle(coord);
    check('its answer comes back to the coordinating chat as a note', replyReq.fresh.includes('SAW-MESSAGE') && replyReq.action.text === 'SAW-REPLY'
        && readText(logFile).includes(`message-reply ${coord} ${plainId} delivered`), replyReq.fresh.slice(0, 300));
    check('the window shows no role on that chat', !(await viewOf(plainId)), JSON.stringify(await viewOf(plainId)));
    mark = model.requests.length;
    await say(plainId, 'Second hello.');
    await sleep(1500);
    check('a later turn of that chat sends the coordinating chat nothing', !since(mark).some((r) => ours(r)), describe(since(mark)));
    mark = model.requests.length;
    const bounce = call('chat_message', { to: CHAT, ask: 'Tell the E2E chat hello.', text: 'Hello back.' });
    reqs = await say(coord, call('chat_message', { to: SECOND, ask: 'Ask Second Chat to say hello back.', text: bounce }));
    check('a coordinating chat sends another coordinating chat a message', resultOf(reqs.filter((r) => ours(r))) === `TOOL-RESULT: Sent to "${SECOND}". Its reply comes back to you once, as a note.`,
        resultOf(reqs.filter((r) => ours(r))));
    const back = await waitFor(() => since(mark).find((r) => ours(r) && r.fresh.includes(`[Reply from "${SECOND}"]`)), 'the second chat\'s reply');
    await waitIdle(coord);
    check('that chat can\'t send one on in a turn the message started, and its answer comes back', back.fresh.includes('TOOL-RESULT: Failed: a message goes to another chat only in a turn the user started')
        && readText(logFile).includes(` guard ${second} message-not-asked`) && !readText(logFile).includes(`message ${second} `), back.fresh.slice(0, 400));

    // 27. Archive: the chat goes with its threads, and comes back with them. A new start leaves it archived and wakes
    // nothing of it, and DSH's own Archive and Unarchive on the chat's row take the threads too.
    // DSH's archive set, read through its own endpoint: unarchiving an id it doesn't hold changes nothing and answers with the set.
    const archivedNow = async () => (await webApi(web, 'workspace/unarchiveSession', { request: { sessionId: 'e2e-none' } })).value?.archivedSessionIds ?? [];
    const chatSessions = [coord, ...Object.values(project().threads ?? {}).map((t) => t.sessionId).filter(Boolean)];
    let archiveAnswer = await webApi(web, 'dsh-plugin-coordinator/archive', { project: coord });
    let inArchive = await archivedNow();
    check('Archive archives the chat and every thread of it in DSH', archiveAnswer.ok && archiveAnswer.value.archived === chatSessions.length
        && chatSessions.every((id) => inArchive.includes(id)), `${JSON.stringify(archiveAnswer).slice(0, 200)} ${chatSessions.length} ${inArchive.length}`);
    check('the list says the chat is archived', archiveAnswer.value?.projects?.find((p) => p.id === coord)?.archived === true
        && project().archived?.via === 'window', JSON.stringify(project().archived));
    mark = model.requests.length;
    signInsBefore = signIns();
    await stopDsh(child);
    const logBefore = readText(logFile).length;
    child = startDsh(dsh);
    await waitFor(async () => existsSync(sock) && (await bridge('GET', '/health')).ok, 'the session bridge after the archive', 90000);
    // The second chat comes up as usual: the plugin's start is past this one by then.
    await waitFor(() => readText(logFile).slice(logBefore).includes(`coordinator ${second} `), 'the plugin to start again', 60000);
    await sleep(1500);
    web = await signInAgain(signInsBefore);
    const heldAfter = await archivedNow();
    check('a new start keeps it archived and wakes nothing of it', project().coordinatorSessionId === coord && project().archived
        && chatSessions.every((id) => heldAfter.includes(id)) && !readText(logFile).slice(logBefore).includes(` coordinator ${coord} `)
        && since(mark).every((r) => whoOf(r) !== 'coordinator'), readText(logFile).slice(logBefore).slice(0, 600));
    archiveAnswer = await webApi(web, 'dsh-plugin-coordinator/restore', { project: coord });
    inArchive = await archivedNow();
    check('Restore brings the chat and every thread of it back', archiveAnswer.ok && archiveAnswer.value.restored === chatSessions.length
        && chatSessions.every((id) => !inArchive.includes(id)) && project().archived === undefined
        && readText(logFile).slice(logBefore).includes(`coordinator ${coord} ${coord} resumed`), JSON.stringify(archiveAnswer).slice(0, 200));
    // DSH's own Archive on the chat's idle row, as its menu or shortcut does it: the plugin takes the threads.
    let own = await webApi(web, 'workspace/archiveSession', { request: { sessionId: coord } });
    if (!own.ok && own.error?.code === 'workspace/session-active') {
        // Something of the chat still runs, so DSH asks first; its dialog's Stop and archive does this.
        own = await webApi(web, 'workspace/archiveSession', { request: { sessionId: coord, stopActivity: true } });
    }
    const followed = await waitFor(async () => {
        const ids = await archivedNow();
        return chatSessions.every((id) => ids.includes(id)) ? ids : null;
    }, 'the threads following the chat\'s row into the archive', 15000).catch(() => null);
    check('DSH\'s own Archive on the chat\'s row archives its threads too', own.ok && followed !== null && project().archived?.via === 'dsh', JSON.stringify(own).slice(0, 200));
    await webApi(web, 'workspace/unarchiveSession', { request: { sessionId: coord } });
    const cameBack = await waitFor(async () => {
        const ids = await archivedNow();
        return chatSessions.every((id) => !ids.includes(id)) ? true : null;
    }, 'the threads coming back with the chat\'s row', 15000).catch(() => false);
    check('DSH\'s own Unarchive on the chat\'s row brings them back', cameBack === true && project().archived === undefined
        && new RegExp(`archive ${coord} via=dsh sessions=\\d+\\n[^]*restore ${coord} via=dsh sessions=\\d+`).test(readText(logFile)),
        readText(logFile).split('\n').filter((l) => /archive|restore/.test(l)).join('\n'));

    // 31. Wrong settings never stop the plugin. Saved while DSH runs, DSH starts the plugin again with them: each
    // falls back to its default, its page lists them in words, its log names them, and the chat still coordinates.
    // (DSH keeps what a plugin's logger says in memory and prints none of it, so its own output is not read here.)
    // Put right, the page has nothing to fix again.
    const startsBad = starts();
    writePatch(model.port, { threadEffort: 'high', maxHandbacksPerHour: 0, autoHandback: 'sometimes', trustedHosts: { nas: true } });
    await waitFor(() => starts() > startsBad && /config-problem autoHandback\n/.test(readText(logFile)), 'the plugin to start again with the wrong settings', 30000);
    answer = await waitFor(async () => {
        const got = await webApi(web, 'dsh-plugin-coordinator/list', {});
        return got.ok && (got.value.problems ?? []).length === 3 ? got : null;
    }, 'the page to name the wrong settings', 30000).catch(() => null);
    const badWords = answer?.value.problems ?? [];
    const named = {
        'the page: maxHandbacksPerHour': badWords.includes('maxHandbacksPerHour must be a whole number of handbacks from 1 to 1000 (it is 0), so the plugin uses 30 until you fix it.'),
        'the page: autoHandback': badWords.includes('autoHandback must be "idle" or "off" (it is "sometimes"), so the plugin uses "idle" until you fix it.'),
        'the page: trustedHosts': badWords.includes('trustedHosts must be a list of host names or addresses (it is {"nas":true}), so the plugin trusts no machine (every send asks) until you fix it.'),
        'the plugin\'s log': /config-problem maxHandbacksPerHour\n/.test(readText(logFile)) && /config-problem autoHandback\n/.test(readText(logFile)),
    };
    const unnamed = Object.keys(named).filter((where) => !named[where]);
    check('wrong settings don\'t stop the plugin: its page names each one, what it must be and what the plugin uses meanwhile',
        unnamed.length === 0, `not named in ${unnamed.join(', ')}; the page says ${JSON.stringify(badWords).slice(0, 900)}; the log says ${readText(logFile).split('\n').filter((line) => / config-problem /.test(line)).join(' | ').slice(0, 300)}`);
    mark = model.requests.length;
    await say(coord, 'Are threads still on?');
    check('with wrong settings the chat still coordinates and has its thread tools', since(mark, 'coordinator').length > 0
        && since(mark, 'coordinator').every((r) => r.tools.includes('thread_start')), describe(since(mark)));
    writePatch(model.port, { threadEffort: 'high' });
    answer = await waitFor(async () => {
        const got = await webApi(web, 'dsh-plugin-coordinator/list', {});
        return got.ok && Array.isArray(got.value.problems) && got.value.problems.length === 0 ? got : null;
    }, 'the page with nothing to fix', 30000).catch(() => null);
    check('put right, the page has nothing to fix', answer !== null, JSON.stringify(answer).slice(0, 300));

    // 32. enabled: false switches it off: the chat keeps its record but is offered no thread tools, the window hears
    // the plugin is off (so it offers no Coordinate), and a click that comes anyway is answered in words. Set true
    // again, the chat coordinates as before, with nothing lost.
    // Switched off, the plugin writes nothing, so its log can't tell it restarted: its answer does.
    writePatch(model.port, { threadEffort: 'high', enabled: false });
    answer = await waitFor(async () => {
        const got = await webApi(web, 'dsh-plugin-coordinator/sessions', {});
        return got.ok && got.value?.off === true ? got : null;
    }, 'the plugin to say it is switched off', 30000).catch(() => null);
    check('enabled: false: the window hears the plugin is switched off, and knows no chat', answer?.value?.off === true && Object.keys(answer.value.sessions ?? {}).length === 0, JSON.stringify(answer).slice(0, 300));
    const offClick = await webApi(web, 'dsh-plugin-coordinator/coordinate', { target: coord, on: true });
    check('enabled: false: Coordinate is answered in words, and nothing changes', offClick.ok === false && offClick.error?.code === 'coordinator/refused'
        && /^The coordinator is switched off: its row in your profile's cordis\.patch\.yml says enabled: false\./.test(offClick.error?.message ?? ''), JSON.stringify(offClick).slice(0, 300));
    mark = model.requests.length;
    await say(coord, 'Is the plugin off now?');
    check('enabled: false: the chat is offered no thread tools', since(mark).length > 0 && since(mark).every((r) => !r.tools.includes('thread_start')), since(mark).map((r) => r.tools.join(',')).join(' | '));
    const startsOn = starts();
    writePatch(model.port, { threadEffort: 'high' });
    await waitFor(async () => {
        const got = await webApi(web, 'dsh-plugin-coordinator/sessions', {});
        return starts() > startsOn && got.ok && got.value?.off !== true && got.value?.sessions?.[coord] ? got : null;
    }, 'the plugin to run again', 30000).catch(() => null);
    mark = model.requests.length;
    await say(coord, 'And on again?');
    check('set true again, the chat coordinates as before, its threads kept', since(mark, 'coordinator').length > 0 && since(mark, 'coordinator').every((r) => r.tools.includes('thread_start'))
        && Object.keys(project().threads ?? {}).length > 0, describe(since(mark)));
    check('no errors in the coordinator log', !/ error /.test(readText(logFile)), readText(logFile).split('\n').filter((l) => / error /.test(l)).join('\n'));
} catch (error) {
    failed += 1;
    console.log(`not ok - ${error.message}`);
    console.log('--- requests');
    for (const r of model.requests.slice(-12)) console.log(`${r.n} ${whoOf(r)} ${r.model} effort=${r.effort ?? '-'} ${JSON.stringify(r.action).slice(0, 160)}`);
    console.log('--- coordinator.log (tail)');
    console.log(readText(logFile).split('\n').slice(-25).join('\n'));
    console.log('--- dsh.log (tail)');
    console.log(readText(dshLog).split('\n').slice(-40).join('\n'));
} finally {
    await stopDsh(child);
    await model.close();
    if (process.env.KEEP) console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
}

// The window: what DSH draws for the plugin, looked at in a Chromium (window.mjs), on the same DSH build. Its own
// summary line is relayed in other words ("# window: 32 ok, 0 not ok"), so the last line below, with both counts in
// it, stays the only one that scripts/e2e.mjs reads.
if (process.env.WINDOW !== '0') {
    const windowRun = spawn(process.execPath, [join(here, 'window.mjs')], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    let rest = '';
    let counts;
    const relay = (line) => {
        const summary = /^(\d+) passed, (\d+) failed$/.exec(line);
        if (summary) counts = summary;
        console.log(summary ? `# window: ${summary[1]} ok, ${summary[2]} not ok` : line);
    };
    windowRun.stdout.setEncoding('utf8');
    windowRun.stdout.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) relay(line);
    });
    const exit = await new Promise((resolveExit) => windowRun.on('exit', resolveExit));
    if (rest) relay(rest);
    if (counts) {
        passed += Number(counts[1]);
        failed += Number(counts[2]);
    } else {
        failed += 1;
        console.log(`not ok - the window test ran to its end (exit ${exit})`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
