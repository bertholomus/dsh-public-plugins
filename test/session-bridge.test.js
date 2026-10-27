// The session bridge (plugins/session-bridge): its settings in words, its reading of a session's log, and the
// bridge itself on a real Unix socket over a stand-in DSH. lib/index.js needs DSH's own packages, so its wiring
// is proven in a real DSH by plugins/session-bridge/test/e2e/run.mjs (node scripts/e2e.mjs session-bridge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    BridgeError, CREATES_FILE, EVENTS_LIMIT_MAX, LOG_MAX_BYTES, MAX_BODY_DEFAULT, MAX_BODY_RANGE, PROMPT_MS, READ_MS, SOCKET_PATH_MAX, WAIT_MAX_SECONDS, answers, attemptOf,
    checkSettings, codeOf, createBridge, createsRecord, endState, expandHome, isNotFound, lastAssistantText, prepareSocket, requestState, rpcIdFor, sentText, sessionSummary, statusFor, summarize, withDeadline,
} from '../plugins/session-bridge/lib/bridge.js';
import { OTHER_NAMES } from './helpers/client.mjs';
import { tempDir } from './helpers/temp.mjs';

const PLUGIN_DIR = new URL('../plugins/session-bridge/', import.meta.url).pathname;
const modeOf = (file) => statSync(file).mode & 0o777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Settings ──────────────────────────────────────────────────────────

const DEFAULTS = { socketPath: '/home/x/.data/session-bridge/bridge.sock', logFile: '/home/x/.data/session-bridge/bridge.log' };

test('settings: nothing set gives the defaults in DSH\'s data folder, and no problems', () => {
    const { values, problems } = checkSettings({}, DEFAULTS);
    assert.deepEqual(values, { enabled: true, socketPath: DEFAULTS.socketPath, logFile: DEFAULTS.logFile, maxBodyBytes: MAX_BODY_DEFAULT });
    assert.deepEqual(problems, []);
    assert.deepEqual(checkSettings(undefined, DEFAULTS).problems, []);
});

test('settings: good values are taken; ~/ is the home folder; "" turns the log off', () => {
    const { values, problems } = checkSettings({ socketPath: '~/b/bridge.sock', logFile: '', maxBodyBytes: 4096 }, DEFAULTS);
    assert.deepEqual(problems, []);
    assert.equal(values.enabled, true);
    assert.equal(values.socketPath, join(homedir(), 'b', 'bridge.sock'));
    assert.equal(values.logFile, '');
    assert.equal(values.maxBodyBytes, 4096);
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('/abs/x'), '/abs/x');
});

test('settings: a wrong value never stops the bridge: that setting keeps its default, and the problem is said in words', () => {
    const { values, problems } = checkSettings({ enabled: 'maybe', socketPath: 42, logFile: 'relative.log', maxBodyBytes: '1MB', socketpath: '/x' }, DEFAULTS);
    assert.deepEqual(values, { enabled: true, socketPath: DEFAULTS.socketPath, logFile: DEFAULTS.logFile, maxBodyBytes: MAX_BODY_DEFAULT });
    assert.equal(problems.length, 5, problems.join('\n'));
    assert.match(problems[0], /^enabled is no longer a setting of the session bridge and is ignored \(it was "maybe"\); the bridge is on\. Take it out of its row: its switch in Plugins turns the bridge off and on\.$/);
    assert.match(problems[1], /^socketPath must be a file path, not 42; the bridge uses \/home\/x\/\.data\/session-bridge\/bridge\.sock\.$/);
    assert.match(problems[2], /^logFile must be a full path \(starting with \/ or ~\/\), not "relative\.log"; the bridge logs to /);
    assert.match(problems[3], /^maxBodyBytes must be a whole number of bytes from 1024 to 67108864, not "1MB"; the bridge takes up to 1048576\.$/);
    assert.match(problems[4], /^socketpath is not a setting of the session bridge and is ignored \(its settings: socketPath, logFile, maxBodyBytes\)\.$/);
});

test('settings: enabled is no longer a setting (DSH\'s switch in Plugins is): a row that says off keeps the bridge from starting, and is said; on is ignored, and said', () => {
    // An off DSH lists as "Running" is the wrong word, so the switch is DSH's own; a row that still says off is never taken as on.
    for (const off of [false, 'false', 0, 'off', 'No']) {
        const r = checkSettings({ enabled: off }, DEFAULTS);
        assert.equal(r.values.enabled, false, JSON.stringify(off));
        assert.equal(r.problems.length, 1);
        assert.match(r.problems[0], /^enabled is no longer a setting of the session bridge, and while its row says enabled: \S+ the bridge does not start\. To switch it off, use its switch in Plugins \(DSH then shows it Off\); to have it listen, take enabled out of its row \(if Plugins still shows it failed, switch it off and on there\)\.$/);
    }
    for (const on of [true, 'yes', 1]) {
        const r = checkSettings({ enabled: on }, DEFAULTS);
        assert.equal(r.values.enabled, true, JSON.stringify(on));
        assert.match(r.problems[0], /^enabled is no longer a setting of the session bridge and is ignored/);
    }
    // A row without it has no problem: the key has no default any more.
    assert.deepEqual(checkSettings({ enabled: undefined }, DEFAULTS).problems, []);
    const index = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
    assert.doesNotMatch(index, /enabled: z\.any\(\)\.default/, 'no default, or every row would read as having it');
    assert.match(index, /if \(!settings\.values\.enabled\) \{[\s\S]*?throw new Error\(`Session Bridge is not listening on \$\{bridge\.socketPath\}: \$\{why\}/, 'off in its row: the start fails with the reason, so DSH never shows it Running');
});

test('settings: a socket path the system cannot take is refused', () => {
    let r;
    const long = `/tmp/${'x'.repeat(SOCKET_PATH_MAX)}/bridge.sock`;
    r = checkSettings({ socketPath: long }, DEFAULTS);
    assert.equal(r.values.socketPath, DEFAULTS.socketPath);
    assert.match(r.problems[0], new RegExp(`^socketPath is ${Buffer.byteLength(long)} bytes long; the system takes at most ${SOCKET_PATH_MAX}\\.`));
    r = checkSettings({ socketPath: 'bridge.sock', maxBodyBytes: 10 }, DEFAULTS);
    assert.match(r.problems[0], /^socketPath must be a full path/);
    assert.match(r.problems[1], /^maxBodyBytes must be a whole number of bytes from 1024/);
    r = checkSettings('socket', DEFAULTS);
    assert.match(r.problems[0], /^The settings must be a map of keys/);
});

// ── Errors in HTTP terms ──────────────────────────────────────────────

test('errors: DSH\'s codes become HTTP statuses: not found 404, a bad request 400, too slow 504, a refusal 409, else 500', () => {
    const remote = (code, message = 'x') => Object.assign(new Error(message), { code });
    assert.equal(statusFor(remote('session/not-found')), 404);
    assert.equal(statusFor(remote('workspace/not-found')), 404);
    assert.equal(statusFor(remote('gateway/bad-request')), 400);
    assert.equal(statusFor(remote('gateway/cancelled')), 504);
    assert.equal(statusFor(remote('session/model-unavailable')), 409);
    assert.equal(statusFor(remote('gateway/internal')), 500);
    assert.equal(statusFor(new Error('plain')), 500);
    assert.equal(statusFor(Object.assign(new Error('t'), { name: 'TimeoutError' })), 504);
    assert.equal(statusFor(new BridgeError(413, 'too-large', 'x')), 413);
    assert.equal(codeOf({ remote: { code: 'session/x' } }), 'session/x');
    assert.equal(codeOf(new Error('x')), 'internal');
});

// ── Reading a session's log ───────────────────────────────────────────

const ev = (seq, type, data = {}) => ({ seq, type, time: 1000 + seq, data });
const said = (text, role = 'assistant') => ({ message: { role, content: [{ type: 'text', text }] } });
const asked = (text, rpcId) => ({ message: { role: 'user', content: [{ type: 'text', text }] }, source: { kind: 'user', rpcId } });

test('log: a prompt is waiting until a turn reads it, read while that turn runs, answered when it ends, with its reply', () => {
    const log = [ev(0, 'session/title', { title: 'First' }), ev(1, 'turn/start', { turn: 1 }), ev(2, 'user/message', asked('one', 'r1')), ev(3, 'assistant/message', said('Reply one')), ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
    assert.deepEqual(requestState(log, 'r2'), { requestId: 'r2', state: 'waiting' });
    assert.deepEqual(requestState(log.slice(0, 4), 'r1'), { requestId: 'r1', state: 'read', seq: 2, turn: 1 });
    assert.deepEqual(requestState(log, 'r1'), { requestId: 'r1', state: 'answered', seq: 2, turn: 1, end: { seq: 4, kind: 'completed' }, reply: { seq: 3, text: 'Reply one' } });
    // A message steered into a running turn is answered by that turn's end, with the reply after it.
    const steered = [ev(1, 'turn/start', { turn: 1 }), ev(2, 'user/message', asked('go', 'a')), ev(3, 'assistant/message', said('Working')), ev(4, 'user/message', asked('also this', 'b')), ev(5, 'assistant/message', said('Did both')), ev(6, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })];
    assert.deepEqual(requestState(steered, 'b'), { requestId: 'b', state: 'answered', seq: 4, turn: 1, end: { seq: 6, kind: 'aborted', reason: { kind: 'user' } }, reply: { seq: 5, text: 'Did both' } });
    assert.equal(requestState([ev(1, 'turn/start', { turn: 1 }), ev(2, 'user/message', asked('x', 'c')), ev(3, 'turn/end', { turn: 1, reason: { kind: 'error' } })], 'c').reply, null, 'a turn that ended without a reply says so');
});

test('log: a prompt not yet saved as a message: queued in DSH\'s inbox, taken by a running turn, or dropped when that turn was cut off or failed first', () => {
    const msg = (rpcId, id = rpcId) => ({ id, role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId } });
    const splice = (seq, target, start, removedCount, inserted = []) => ev(seq, 'agent/inbox/spliced', { target, start, removedCount, inserted });
    const queued = [splice(4, 'next-turn', 0, 0, [msg('other'), msg('r1')])];
    assert.deepEqual(requestState(queued, 'r1'), { requestId: 'r1', state: 'queued', seq: 4, target: 'next-turn' });
    // A turn takes the first queued message; ours is still queued.
    const firstTaken = [...queued, ev(5, 'turn/start', { turn: 3 }), splice(6, 'next-turn', 0, 1)];
    assert.equal(requestState(firstTaken, 'r1').state, 'queued');
    const taken = [...firstTaken, ev(7, 'turn/end', { turn: 3, reason: { kind: 'completed' } }), ev(8, 'turn/start', { turn: 4 }), splice(9, 'next-turn', 0, 1)];
    assert.deepEqual(requestState(taken, 'r1'), { requestId: 'r1', state: 'read', seq: 9, turn: 4 });
    // DSH stopped mid-step: the turn closed as interrupted on the next start, and the message never reached the log.
    assert.deepEqual(requestState([...taken, ev(10, 'turn/end', { turn: 4, reason: { kind: 'interrupted' } })], 'r1'), { requestId: 'r1', state: 'dropped', seq: 9, turn: 4, end: { seq: 10, kind: 'interrupted' } });
    // The turn that took it failed before DSH saved it (seen when a prompt came while DSH loaded its agent loop again).
    const failed = { kind: 'error', error: { message: 'cannot create effect on inactive context', code: 'UNKNOWN' } };
    assert.deepEqual(requestState([...taken, ev(10, 'turn/end', { turn: 4, reason: failed })], 'r1'), { requestId: 'r1', state: 'dropped', seq: 9, turn: 4, end: { seq: 10, ...failed } });
    // A steer waits in the next-step list until the running turn's next step takes it.
    const steer = [ev(1, 'turn/start', { turn: 1 }), splice(2, 'next-step', 0, 0, [msg('s1')])];
    assert.equal(requestState(steer, 's1').state, 'queued');
    assert.equal(requestState([...steer, splice(3, 'next-step', 0, 1)], 's1').state, 'read');
    // The queue cleared with no turn running: dropped, with no turn.
    assert.deepEqual(requestState([splice(1, 'next-turn', 0, 0, [msg('c1')]), splice(2, 'next-turn', 0, 1)], 'c1'), { requestId: 'c1', state: 'dropped', seq: 2 });
    // Sent again after it was dropped: the new attempt counts, queued anew.
    const dropped = [...taken, ev(10, 'turn/end', { turn: 4, reason: { kind: 'interrupted' } })];
    assert.deepEqual(requestState([...dropped, splice(11, 'next-turn', 0, 0, [msg('r1', 'second')])], 'r1'), { requestId: 'r1', state: 'queued', seq: 11, target: 'next-turn' });
    // Once saved as a message, the log's message wins.
    assert.equal(requestState([...taken, ev(10, 'user/message', asked('x', 'r1')), ev(11, 'turn/end', { turn: 4, reason: { kind: 'completed' } })], 'r1').state, 'answered');
});

test('log: a session\'s summary takes its latest title, counts turns and gives the last reply; events go out compact', () => {
    const log = [ev(0, 'session/title', { title: 'First' }), ev(1, 'turn/start', { turn: 1 }), ev(2, 'assistant/message', said('x'.repeat(5000))), ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), ev(4, 'session/title', { title: 'Renamed' })];
    const s = sessionSummary('s1', { cwd: '/w', title: 'First' }, log, { status: 'idle' });
    assert.deepEqual({ ...s, lastAssistant: s.lastAssistant.seq }, { sessionId: 's1', cwd: '/w', title: 'Renamed', attached: true, status: 'idle', turns: { started: 1, ended: 1, lastEnd: { kind: 'completed' } }, lastSeq: 4, lastAssistant: 2 });
    assert.equal(sessionSummary('s1', {}, [], undefined).status, 'cold');
    const short = summarize(log[2], false);
    assert.equal(short.text.length, 4000 + '…(+1000)'.length);
    assert.equal(summarize(log[2], true).text.length, 5000);
    assert.equal(short.role, 'assistant');
    assert.deepEqual(summarize(ev(5, 'user/message', asked('hi', 'r9')), false).source, { kind: 'user', rpcId: 'r9' });
    assert.deepEqual(summarize(ev(6, 'turn/end', { turn: 2, reason: { kind: 'error' } }), false), { seq: 6, type: 'turn/end', time: 1006, turn: 2, reason: { kind: 'error' } });
    assert.deepEqual(summarize(ev(7, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] } }), false).toolCalls, ['bash']);
    assert.equal(lastAssistantText([]), null);
});

// ── A stand-in DSH ────────────────────────────────────────────────────

function remoteError(code, message) {
    return Object.assign(new Error(message), { code });
}

/** DSH's session controller, workspaces and agents, as the bridge uses them; events pushed by the test. */
function fakeDsh() {
    const sessions = new Map();
    const workspaces = new Map();
    const calls = [];
    let n = 0;
    let bridge;
    const live = (id) => {
        const s = sessions.get(id);
        if (!s) throw remoteError('session/not-found', `session "${id}" not found`);
        return s;
    };
    const dsh = {
        calls,
        sessions,
        /** Hold every prompt until let go (DSH slow to accept), or fail the next call of a kind. */
        hold: null,
        holdCreate: null,
        afterInspect: null,
        failNext: {},
        attach: (b) => { bridge = b; },
        push(id, type, data = {}) {
            const s = live(id);
            s.events.push({ seq: s.events.length, type, time: Date.now(), data });
            bridge?.onSessionEvent(id, s.events.at(-1));
        },
        controller: {
            inspect: async (id) => {
                if (dsh.failNext.inspect) throw dsh.failNext.inspect;
                const s = live(id);
                const copy = { meta: s.header, events: [...s.events] };
                // An event that lands just after this read (before the caller's wait is registered).
                const after = dsh.afterInspect;
                dsh.afterInspect = null;
                if (after) queueMicrotask(after);
                return copy;
            },
            list: async () => ({ items: [...sessions.keys()].map((sessionId) => ({ sessionId })) }),
            create: async ({ workspaceId, agentPreset }) => {
                calls.push(['create', workspaceId, agentPreset]);
                if (dsh.holdCreate) await dsh.holdCreate;
                const id = `session-${++n}`;
                sessions.set(id, { header: { cwd: workspaces.get(workspaceId)?.path, title: 'New session' }, events: [], agent: { status: 'idle' } });
                return { sessionId: id };
            },
            prompt: async (req, signal) => {
                calls.push(['prompt', req]);
                assert.ok(signal instanceof AbortSignal, 'every prompt has a deadline');
                if (dsh.failNext.prompt) throw dsh.failNext.prompt;
                live(req.sessionId);
                if (dsh.hold) await dsh.hold;
                const late = dsh.failLate;
                dsh.failLate = undefined;
                if (late) throw late;
                // DSH queues a prompt in the session's inbox at once; the stand-in does when a test asks it to.
                if (dsh.recordSteps) {
                    dsh.push(req.sessionId, 'agent/inbox/spliced', { target: req.mode === 'steer' ? 'next-step' : 'next-turn', start: 0, removedCount: 0, inserted: [{ id: req.requestId, role: 'user', content: req.content, source: { kind: 'user', rpcId: req.requestId } }] });
                }
                return { accepted: true };
            },
            selectModel: async (req) => {
                calls.push(['model', req]);
                const failure = dsh.failNext.model;
                dsh.failNext.model = undefined;
                if (failure) throw failure;
                live(req.sessionId);
                // DSH records the choice in the session's log; the stand-in does when a test asks it to.
                if (dsh.recordSteps) dsh.push(req.sessionId, 'model/selection', { provider: req.provider, model: req.model, ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}) });
                return { provider: req.provider, model: req.model };
            },
            rename: async (req) => {
                calls.push(['rename', req]);
                live(req.sessionId);
                if (dsh.recordSteps) dsh.push(req.sessionId, 'session/title', { title: req.title });
                return { title: req.title, seq: 1 };
            },
            cancel: async (req) => {
                calls.push(['cancel', req]);
                live(req.sessionId);
                return { accepted: true };
            },
            modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, groups: [] }),
        },
        registry: {
            list: () => [...workspaces.values()],
            get: (id) => workspaces.get(id),
            create: (path) => {
                const found = [...workspaces.values()].find((w) => w.path === path);
                if (found) return found;
                const ws = { id: `ws-${workspaces.size + 1}`, path, title: path.split('/').at(-1), sessionIds: [] };
                workspaces.set(ws.id, ws);
                return ws;
            },
        },
        agents: { get: (id) => sessions.get(id)?.agent },
    };
    return dsh;
}

/** A bridge over a stand-in DSH on a real socket in a temp folder. */
async function bridgeOn(t, { raw = {}, folder = tempDir('sb'), logger, logMaxBytes, promptMs, readMs, dsh: given } = {}) {
    const dsh = given ?? fakeDsh();
    const settings = checkSettings(raw, { socketPath: join(folder, 'sock', 'bridge.sock'), logFile: join(folder, 'sock', 'bridge.log') });
    const lines = [];
    const bridge = createBridge({
        host: { sessionController: () => dsh.controller, workspaceRegistry: () => dsh.registry, agents: () => dsh.agents },
        settings,
        logger: logger ?? { info: (...a) => lines.push(['info', ...a]), warn: (...a) => lines.push(['warn', ...a]), error: (...a) => lines.push(['error', ...a]) },
        version: '9.9.9',
        sent: new Map(),
        ...(logMaxBytes ? { logMaxBytes } : {}),
        ...(promptMs ? { promptMs } : {}),
        ...(readMs ? { readMs } : {}),
    });
    dsh.attach(bridge);
    const ok = await bridge.start();
    t.after(() => bridge.stop());
    return { dsh, bridge, ok, folder, sock: settings.values.socketPath, logFile: settings.values.logFile, lines };
}

/** One HTTP call over a Unix socket: { status, headers, body }. */
function call(sock, method, path, body, { raw, headers = {} } = {}) {
    return new Promise((resolvePromise, reject) => {
        const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
        const req = request({ socketPath: sock, path, method, headers: { ...(data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json;
                try { json = JSON.parse(text); } catch {}
                resolvePromise({ status: res.statusCode, headers: res.headers, body: json, text });
            });
        });
        req.on('error', reject);
        if (data !== undefined) req.write(data);
        req.end();
    });
}

// ── The socket, its folder and the log ────────────────────────────────

test('socket: owner only: its folder is made 700 and the socket 600; the log is 600, even one that was 644', async (t) => {
    const folder = tempDir('sb');
    mkdirSync(join(folder, 'sock'), { mode: 0o755 });
    writeFileSync(join(folder, 'sock', 'bridge.log'), 'an older line\n', { mode: 0o644 });
    chmodSync(join(folder, 'sock', 'bridge.log'), 0o644);
    const { ok, sock, logFile } = await bridgeOn(t, { folder });
    assert.equal(ok, true);
    assert.equal(modeOf(join(folder, 'sock')), 0o700);
    assert.equal(modeOf(sock), 0o600);
    assert.ok(statSync(sock).isSocket());
    assert.equal(modeOf(logFile), 0o600);
    // The folder it closed is said, with the mode it had.
    assert.match(readFileSync(logFile, 'utf8'), /^an older line\n\S+ closed \S+\/sock to mode 700 for the socket \(it was 755\); it stays 700\n\S+ listening \S+bridge\.sock pid=\d+\n$/);
    const health = await call(sock, 'GET', '/health');
    assert.deepEqual({ ...health.body, pid: 0 }, { ok: true, plugin: 'session-bridge', version: '9.9.9', pid: 0, socket: sock, problems: [] });
});

test('socket: a folder that does not exist yet is made 700, parents too, and the log says which folders it made', async (t) => {
    const folder = tempDir('sb');
    const logFile = join(folder, 'logs', 'bridge.log');
    const { ok } = await bridgeOn(t, { folder, raw: { socketPath: join(folder, 'a', 'b', 'bridge.sock'), logFile } });
    assert.equal(ok, true);
    assert.equal(modeOf(join(folder, 'a', 'b')), 0o700);
    assert.equal(modeOf(join(folder, 'logs')), 0o700);
    // Each folder the bridge made is said once: the log's own first, as its first line goes in.
    assert.match(readFileSync(logFile, 'utf8'), /^\S+ made \S+\/logs \(mode 700\) for the log\n\S+ made \S+\/a\/b \(mode 700\) for the socket\n\S+ listening /);
});

test('socket: a socket left by a crash (nobody answers) is replaced; a live one is never taken over', async (t) => {
    const folder = tempDir('sb');
    const dir = join(folder, 'sock');
    mkdirSync(dir, { mode: 0o700 });
    const sock = join(dir, 'bridge.sock');
    // A crash leaves the socket file behind: a process that listened there and was killed.
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(child.stdout, 'data');
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.ok(statSync(sock).isSocket(), 'the crashed process left its socket file');
    assert.equal(await answers(sock), false, 'nobody answers on it');
    const first = await bridgeOn(t, { folder });
    assert.equal(first.ok, true, 'the stale socket was replaced');
    assert.equal((await call(sock, 'GET', '/health')).body.ok, true);
    assert.match(readFileSync(join(dir, 'bridge.log'), 'utf8'), /replaced the old socket \S+bridge\.sock, which nobody answered on\n/, 'and its log says so');
    // A second bridge on the same socket (another DSH, a second row) leaves the live one alone.
    const second = await bridgeOn(t, { folder });
    assert.equal(second.ok, false);
    assert.match(second.bridge.refused, /^another program answers on \S+bridge\.sock \(another DSH, or a second session-bridge row\); the bridge does not take it over$/);
    assert.ok(second.lines.some(([level, , , why]) => level === 'error' && why === second.bridge.refused), 'DSH\'s log says why');
    assert.match(readFileSync(join(dir, 'bridge.log'), 'utf8'), /not listening on \S+bridge\.sock: another program answers on/);
    assert.equal((await call(sock, 'GET', '/health')).body.ok, true, 'the first bridge still answers');
    await second.bridge.stop();
    assert.equal((await call(sock, 'GET', '/health')).body.ok, true, 'stopping the refused one does not remove the live socket');
});

test('socket: a file that is not a socket is never deleted; a shared folder is never closed; a path too long is refused', async (t) => {
    const folder = tempDir('sb');
    mkdirSync(join(folder, 'sock'), { mode: 0o700 });
    const file = join(folder, 'sock', 'bridge.sock');
    writeFileSync(file, 'precious');
    const r = await bridgeOn(t, { folder });
    assert.equal(r.ok, false);
    assert.match(r.bridge.refused, /is a file that is not a socket, and the bridge never deletes one; move it or choose another socketPath$/);
    assert.equal(readFileSync(file, 'utf8'), 'precious');
    // A sticky folder (as /tmp is) belongs to everyone: the bridge refuses it instead of closing it.
    const shared = join(folder, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    assert.match(await prepareSocket(join(shared, 'bridge.sock')), /^its folder \S+shared is shared, and the bridge closes its folder to everyone else; give the socket a folder of its own/);
    assert.equal(statSync(shared).mode & 0o7777, 0o1777, 'the shared folder is left as it was');
    // The home folder too.
    const home = process.env.HOME;
    process.env.HOME = join(folder, 'home');
    mkdirSync(process.env.HOME, { mode: 0o755 });
    try {
        assert.match(await prepareSocket(join(process.env.HOME, 'bridge.sock')), /is shared/);
        assert.equal(modeOf(process.env.HOME), 0o755);
    } finally {
        process.env.HOME = home;
    }
    assert.match(await prepareSocket(`/tmp/${'y'.repeat(120)}.sock`), /^the socket path is \d+ bytes; the system takes at most 103\. Choose a shorter socketPath\.$/);
    assert.match(await prepareSocket('relative.sock'), /full path/);
    writeFileSync(join(folder, 'plain'), '');
    assert.match(await prepareSocket(join(folder, 'plain', 'bridge.sock')), /is not a folder$/);
});

test('socket: stopping closes it and removes its file; a new bridge then starts there', async (t) => {
    const folder = tempDir('sb');
    const a = await bridgeOn(t, { folder });
    await a.bridge.stop();
    assert.equal(existsSync(a.sock), false);
    assert.match(readFileSync(a.logFile, 'utf8'), /stopped\n$/);
    const b = await bridgeOn(t, { folder });
    assert.equal(b.ok, true);
    assert.equal((await call(b.sock, 'GET', '/health')).status, 200);
});

test('log: actions and sizes only: a prompt\'s text and a title never reach it; it starts a new part past its size', async (t) => {
    const SECRET = 'TEXT-THAT-MUST-NOT-BE-LOGGED-7f3a';
    const TITLE = 'TITLE-THAT-MUST-NOT-BE-LOGGED-91c2';
    const { dsh, sock, logFile, folder } = await bridgeOn(t, { logMaxBytes: 2000 });
    const ws = join(folder, 'ws');
    mkdirSync(ws);
    const made = await call(sock, 'POST', '/sessions', { workspacePath: ws, title: TITLE, text: `${SECRET} one`, provider: 'p', model: 'm', reasoningEffort: 'high' });
    assert.equal(made.status, 200, made.text);
    const id = made.body.sessionId;
    dsh.sessions.get(id).agent.status = 'running';
    await call(sock, 'POST', `/sessions/${id}/prompt`, { text: `${SECRET} two`, mode: 'steer' });
    await call(sock, 'POST', `/sessions/${id}/rename`, { title: TITLE });
    await call(sock, 'POST', `/sessions/${id}/cancel`, {});
    await call(sock, 'POST', `/sessions/${id}/prompt`, { text: SECRET, mode: 'nonsense' });
    const text = readFileSync(logFile, 'utf8');
    assert.ok(!text.includes(SECRET) && !text.includes(TITLE), text);
    for (const line of [
        new RegExp(`create ${id} ws=${ws}\\n`),
        new RegExp(`model ${id} p/m high\\n`),
        new RegExp(`rename ${id} chars=${TITLE.length}\\n`),
        new RegExp(`prompt ${id} mode=followup chars=${SECRET.length + 4} request=bridge-[0-9a-f-]{36}\\n`),
        new RegExp(`prompt ${id} mode=steer chars=${SECRET.length + 4} request=bridge-`),
        new RegExp(`cancel ${id}\\n`),
        new RegExp(`error POST /sessions/${id}/prompt 400 bad-request mode must be`),
    ]) assert.match(text, line);
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 2);
    // Past its size the log starts a new part, keeping the old one once; both stay 600.
    for (let i = 0; i < 60; i++) await call(sock, 'POST', `/sessions/${id}/cancel`, {});
    assert.ok(existsSync(`${logFile}.1`));
    assert.ok(statSync(logFile).size <= 2000 && statSync(`${logFile}.1`).size <= 2000);
    assert.equal(modeOf(logFile), 0o600);
    assert.equal(modeOf(`${logFile}.1`), 0o600);
    const files = readdirSync(join(folder, 'sock')).sort();
    assert.deepEqual(files, ['bridge.log', 'bridge.log.1', 'bridge.sock']);
});

test('log: "" writes no log at all; a log that cannot be written never stops the bridge, and is said in GET /health and once in DSH\'s log', async (t) => {
    const folder = tempDir('sb');
    const off = await bridgeOn(t, { folder, raw: { logFile: '' } });
    assert.equal(off.ok, true);
    assert.deepEqual(readdirSync(join(folder, 'sock')), ['bridge.sock']);
    assert.deepEqual((await call(off.sock, 'GET', '/health')).body.problems, [], 'no log asked for: nothing to say');
    const folder2 = tempDir('sb');
    writeFileSync(join(folder2, 'not-a-folder'), '');
    const logFile = join(folder2, 'not-a-folder', 'x.log');
    const broken = await bridgeOn(t, { folder: folder2, raw: { logFile } });
    assert.equal(broken.ok, true);
    // Known from the bridge's first line (at its start), before any request.
    const health = await call(broken.sock, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.problems.length, 1, health.text);
    // The reason in words; the code is ENOTDIR or EEXIST, as the system says it.
    assert.equal(health.body.problems[0].replace(/\((ENOTDIR|EEXIST): /, '(CODE: '), `logFile ${logFile} cannot be written (CODE: a part of its path is a file, not a folder), so the bridge's actions are not logged. Give logFile a folder you can write to, or "" for no log.`);
    for (let i = 0; i < 3; i++) await call(broken.sock, 'POST', '/sessions', { workspacePath: folder2 });
    assert.equal(broken.lines.filter(([level, , problem]) => level === 'warn' && /^logFile .* cannot be written/.test(problem)).length, 1, 'DSH\'s log says it once, not for every line');
    // Writable again (the folder is there now): the next line goes in, and the problem is gone.
    rmSync(join(folder2, 'not-a-folder'));
    mkdirSync(join(folder2, 'not-a-folder'));
    await call(broken.sock, 'POST', '/sessions', { workspacePath: folder2 });
    assert.match(readFileSync(logFile, 'utf8'), /create session-4 /);
    assert.deepEqual((await call(broken.sock, 'GET', '/health')).body.problems, []);
    assert.ok(broken.lines.some(([level, words]) => level === 'info' && /is written again/.test(words)));
});

// ── The API over the stand-in ─────────────────────────────────────────

test('api: health names wrong settings in words; workspaces, models and the session list come from DSH', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t, { raw: { maxBodyBytes: 'lots', extra: 1 } });
    const health = (await call(sock, 'GET', '/health')).body;
    assert.equal(health.ok, true);
    assert.equal(health.problems.length, 2);
    assert.match(health.problems[0], /^maxBodyBytes must be a whole number/);
    dsh.registry.create(join(folder, 'w1'));
    assert.deepEqual((await call(sock, 'GET', '/workspaces')).body, [{ id: 'ws-1', path: join(folder, 'w1'), title: 'w1', sessions: 0 }]);
    assert.deepEqual((await call(sock, 'GET', '/models')).body, { default: { provider: 'p', model: 'm' }, groups: [] });
    assert.deepEqual((await call(sock, 'GET', '/sessions')).body, []);
});

test('api: a new session in a folder, with its model, title and first prompt; it reads back with its status', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const ws = join(folder, 'ws');
    mkdirSync(ws);
    const made = await call(sock, 'POST', '/sessions', { workspacePath: ws, title: 'Lint pass', provider: 'p', model: 'm', text: 'Run the linter.', agentPreset: 'coder' });
    assert.equal(made.status, 200, made.text);
    const id = made.body.sessionId;
    assert.deepEqual(made.body.workspace, { id: 'ws-1', path: ws });
    assert.deepEqual(made.body.model, { provider: 'p', model: 'm' });
    assert.deepEqual(made.body.title, { title: 'Lint pass', seq: 1 });
    assert.equal(made.body.prompt.accepted, true);
    assert.equal(made.body.prompt.mode, 'followup');
    assert.equal(made.body.prompt.chars, 'Run the linter.'.length);
    assert.deepEqual(dsh.calls.map(([k]) => k), ['create', 'model', 'rename', 'prompt']);
    assert.equal(dsh.calls[0][2], 'coder');
    assert.deepEqual(dsh.calls[3][1].content, [{ type: 'text', text: 'Run the linter.' }]);
    assert.equal(dsh.calls[3][1].requestId, made.body.prompt.requestId);
    // An existing workspace by its id, and the same folder again, reuse it.
    assert.equal((await call(sock, 'POST', '/sessions', { workspaceId: 'ws-1' })).body.workspace.id, 'ws-1');
    assert.equal((await call(sock, 'POST', '/sessions', { workspacePath: `${ws}/` })).body.workspace.id, 'ws-1');
    dsh.push(id, 'turn/start', { turn: 1 });
    dsh.push(id, 'user/message', asked('Run the linter.', made.body.prompt.requestId));
    dsh.push(id, 'assistant/message', said('Two warnings fixed.'));
    dsh.push(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const s = (await call(sock, 'GET', `/sessions/${id}`)).body;
    assert.deepEqual(s, { sessionId: id, cwd: ws, title: 'New session', attached: true, status: 'idle', turns: { started: 1, ended: 1, lastEnd: { kind: 'completed' } }, lastSeq: 3, lastAssistant: { seq: 2, text: 'Two warnings fixed.' } });
    const r = (await call(sock, 'GET', `/sessions/${id}/requests/${made.body.prompt.requestId}`)).body;
    assert.equal(r.state, 'answered');
    assert.deepEqual(r.reply, { seq: 2, text: 'Two warnings fixed.' });
});

test('api: what is wrong with a request is said in words, before anything is made', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const cases = [
        [{}, /^workspacePath \(a folder\) or workspaceId \(from GET \/workspaces\) is required\.$/],
        [{ workspacePath: 'relative/dir' }, /^workspacePath must be a full path \(starting with \/ or ~\/\), not "relative\/dir"\.$/],
        [{ workspacePath: join(folder, 'missing') }, /is not a folder on this computer; make it first\.$/],
        [{ workspacePath: 7 }, /^workspacePath must be a folder path, as a string\.$/],
        [{ workspacePath: folder, model: 'm' }, /^provider and model go together/],
        [{ workspacePath: folder, title: 3 }, /^title must be a string\.$/],
        [{ workspacePath: folder, text: '   ' }, /^text must hold more than spaces/],
        [{ workspacePath: folder, text: 'x', requestId: 'has space' }, /^requestId must be 1 to 128 letters/],
    ];
    for (const [body, words] of cases) {
        const r = await call(sock, 'POST', '/sessions', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.error.code, 'bad-request');
        assert.match(r.body.error.message, words);
    }
    assert.equal((await call(sock, 'POST', '/sessions', { workspaceId: 'nope' })).status, 404);
    assert.equal(dsh.calls.length, 0, 'nothing was made');
    assert.equal((await call(sock, 'POST', '/sessions', undefined, { raw: '{not json' })).body.error.code, 'bad-json');
    const list = await call(sock, 'POST', '/sessions', undefined, { raw: '[1,2]' });
    assert.equal(list.status, 400);
    assert.match(list.body.error.message, /^The body must be a JSON object/);
    assert.equal((await call(sock, 'POST', '/sessions', undefined, { raw: 'null' })).status, 400);
});

test('api: a step that fails after the session was made says which, with the session\'s id', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    dsh.failNext.model = remoteError('session/model-unavailable', 'Select an available model before sending a message.');
    const r = await call(sock, 'POST', '/sessions', { workspacePath: folder, provider: 'p', model: 'gone', text: 'hello' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'session/model-unavailable');
    assert.match(r.body.error.message, /^Session session-1 was made, but setting its model failed: Select an available model before sending a message\.$/);
    assert.equal(r.body.sessionId, 'session-1');
    assert.equal(r.body.failedStep, 'model');
    assert.deepEqual(r.body.workspace, { id: 'ws-1', path: folder });
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 0, 'the prompt was not sent after the failure');
});

test('api: prompts: followup and steer; a wrong mode or no text is refused; an unknown session is a 404', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    const one = await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Skip the tests folder.', mode: 'steer' });
    assert.equal(one.status, 200);
    assert.equal(one.body.mode, 'steer');
    assert.match(one.body.requestId, /^bridge-[0-9a-f-]{36}$/);
    assert.equal(dsh.calls.at(-1)[1].mode, 'steer');
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Later.' })).body.mode, 'followup');
    const wrong = await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'x', mode: 'queue' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error.message, /^mode must be "followup" \(after the running turn\) or "steer" \(into it\), not "queue"\.$/);
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, {})).status, 400);
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 5 })).status, 400);
    const unknown = await call(sock, 'POST', '/sessions/nope/prompt', { text: 'x' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'session/not-found');
    assert.equal((await call(sock, 'GET', '/sessions/nope')).status, 404);
    assert.equal((await call(sock, 'POST', `/sessions/${id}/rename`, {})).status, 400);
    assert.equal((await call(sock, 'POST', `/sessions/${id}/rename`, { title: 'x'.repeat(501) })).status, 400);
    assert.equal((await call(sock, 'POST', `/sessions/${id}/model`, { provider: 'p' })).status, 400);
    // Open but idle: no turn to stop, said so (DSH itself would answer "accepted" and stop nothing).
    const calls = dsh.calls.length;
    const idle = await call(sock, 'POST', `/sessions/${id}/cancel`);
    assert.equal(idle.status, 409);
    assert.deepEqual(idle.body.error, { code: 'session/not-running', message: `Session ${id} has no turn running, so there is nothing to cancel.` });
    assert.equal(dsh.calls.length, calls, 'DSH was not asked');
    dsh.sessions.get(id).agent.status = 'running';
    assert.deepEqual((await call(sock, 'POST', `/sessions/${id}/cancel`)).body, { accepted: true });
    // A session that is not open in DSH has no turn to cancel: said so, not "not found".
    dsh.sessions.get(id).agent = undefined;
    const cold = await call(sock, 'POST', `/sessions/${id}/cancel`, {});
    assert.equal(cold.status, 409);
    assert.deepEqual(cold.body.error, { code: 'session/not-running', message: `Session ${id} is not open in DSH, so no turn runs to cancel.` });
    assert.equal((await call(sock, 'POST', '/sessions/nope/cancel', {})).status, 404);
    assert.equal((await call(sock, 'GET', `/sessions/${id}`)).body.status, 'cold');
});

test('api: a dropped prompt (DSH stopped before saving it) may be sent again with its request id; a queued one may not', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    const msg = (rpcId) => ({ id: rpcId, role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId } });
    dsh.push(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [msg('q-1')] });
    const queued = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'x', requestId: 'q-1' })).body;
    assert.equal(queued.alreadySent, true);
    assert.equal(queued.state, 'queued');
    dsh.push(id, 'turn/start', { turn: 1 });
    dsh.push(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    assert.equal((await call(sock, 'GET', `/sessions/${id}/requests/q-1`)).body.state, 'read');
    dsh.push(id, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    const dropped = (await call(sock, 'GET', `/sessions/${id}/requests/q-1?wait=30`)).body;
    assert.deepEqual({ state: dropped.state, end: dropped.end?.kind, timedOut: dropped.timedOut }, { state: 'dropped', end: 'interrupted', timedOut: false });
    const again = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'x', requestId: 'q-1' })).body;
    assert.equal(again.alreadySent, undefined, 'sent again');
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 1);
});

test('api: a retried prompt with the caller\'s own request id is sent once, even when the retry comes while the first is on its way', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    let release;
    dsh.hold = new Promise((r) => { release = r; });
    const first = call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy.', requestId: 'cron-2026-10-26-0900' });
    await sleep(50);
    const retry = await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy.', requestId: 'cron-2026-10-26-0900' });
    assert.deepEqual(retry.body, { accepted: true, alreadySent: true, state: 'waiting', mode: 'followup', requestId: 'cron-2026-10-26-0900', chars: 7 });
    release();
    dsh.hold = null;
    assert.equal((await first).body.alreadySent, undefined);
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 1);
    // One in the session's log (sent before this bridge started, say) is not sent again either.
    dsh.push(id, 'user/message', asked('Old.', 'sent-by-an-earlier-run'));
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Old.', requestId: 'sent-by-an-earlier-run' })).body.alreadySent, true);
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 1);
    // A prompt DSH refuses is not remembered, so its retry goes through.
    dsh.failNext.prompt = remoteError('gateway/bad-request', 'prompt content must include non-whitespace text or an attachment');
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'x', requestId: 'r-fail' })).status, 400);
    dsh.failNext.prompt = undefined;
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'x', requestId: 'r-fail' })).body.alreadySent, undefined);
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 3);
});

test('api: what became of a prompt, from the session\'s log; with wait it answers when the turn ends', async (t) => {
    const { sock, dsh, bridge, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    const rid = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Go.' })).body.requestId;
    assert.deepEqual((await call(sock, 'GET', `/sessions/${id}/requests/${rid}`)).body, { sessionId: id, requestId: rid, state: 'waiting' });
    const notOurs = await call(sock, 'GET', `/sessions/${id}/requests/someone-elses`);
    assert.equal(notOurs.status, 404);
    assert.match(notOurs.body.error.message, /has no message with request id someone-elses: none is in its log, and the bridge sent none to it since DSH started\.$/);
    assert.equal((await call(sock, 'GET', `/sessions/${id}/requests/${encodeURIComponent('bad id')}`)).status, 400);
    const waiting = call(sock, 'GET', `/sessions/${id}/requests/${rid}?wait=30`);
    await sleep(100);
    assert.equal(bridge.waiting, 1);
    dsh.push(id, 'turn/start', { turn: 1 });
    dsh.push(id, 'user/message', asked('Go.', rid));
    await sleep(50);
    assert.equal(bridge.waiting, 1, 'read but not answered: it keeps waiting');
    dsh.push(id, 'assistant/message', said('Gone.'));
    dsh.push(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const done = (await waiting).body;
    assert.deepEqual(done, { sessionId: id, requestId: rid, state: 'answered', seq: 1, turn: 1, end: { seq: 3, kind: 'completed' }, reply: { seq: 2, text: 'Gone.' }, timedOut: false });
    assert.equal(bridge.waiting, 0);
    const quick = await call(sock, 'GET', `/sessions/${id}/requests/${rid}?wait=5`);
    assert.equal(quick.body.timedOut, false, 'answered already: no wait');
    assert.equal((await call(sock, 'GET', `/sessions/${id}/requests/${rid}?wait=-1`)).status, 400);
});

test('api: events page by seq and type; with wait the page comes when DSH commits a matching event, or empty when the wait runs out', async (t) => {
    const { sock, dsh, bridge, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    for (let i = 0; i < 5; i++) dsh.push(id, i % 2 ? 'assistant/message' : 'step/start', i % 2 ? said(`r${i}`) : {});
    let page = (await call(sock, 'GET', `/sessions/${id}/events?after=-1&limit=2`)).body;
    assert.deepEqual(page.events.map((e) => e.seq), [0, 1]);
    assert.equal(page.more, true);
    assert.equal(page.lastSeq, 4);
    assert.equal(page.timedOut, undefined, 'no wait asked, none said');
    page = (await call(sock, 'GET', `/sessions/${id}/events?after=1&types=assistant/message`)).body;
    assert.deepEqual(page.events.map((e) => [e.seq, e.text]), [[3, 'r3']]);
    assert.equal(page.more, false);
    assert.equal((await call(sock, 'GET', `/sessions/${id}/events?after=-1&limit=999999`)).status, 200, 'a limit above the most is the most');
    for (const q of ['after=abc', 'limit=0', 'limit=x', `wait=${'9'.repeat(3)}x`, 'after=1.5']) {
        const r = await call(sock, 'GET', `/sessions/${id}/events?${q}`);
        assert.equal(r.status, 400, q);
        assert.match(r.body.error.message, /^(after|limit|wait) must be /);
    }
    // Waiting: nothing yet, then a matching event arrives; an event of another type does not end the wait.
    const started = Date.now();
    const waited = call(sock, 'GET', `/sessions/${id}/events?after=4&types=turn/end&wait=30`);
    await sleep(100);
    dsh.push(id, 'step/start');
    await sleep(50);
    assert.equal(bridge.waiting, 1);
    dsh.push(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const got = (await waited).body;
    assert.deepEqual(got.events.map((e) => [e.seq, e.type]), [[6, 'turn/end']]);
    assert.equal(got.timedOut, false);
    assert.ok(Date.now() - started < 5000);
    // The wait runs out: an empty page that says so.
    const t0 = Date.now();
    const empty = (await call(sock, 'GET', `/sessions/${id}/events?after=6&wait=1`)).body;
    assert.deepEqual({ events: empty.events, timedOut: empty.timedOut, lastSeq: empty.lastSeq }, { events: [], timedOut: true, lastSeq: 6 });
    assert.ok(Date.now() - t0 >= 900);
    assert.equal(bridge.waiting, 0);
    assert.equal(WAIT_MAX_SECONDS, 600);
    assert.equal(EVENTS_LIMIT_MAX, 2000);
});

test('api: a caller that goes away stops its wait; stopping answers every wait at once', async (t) => {
    const { sock, dsh, bridge, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    const req = request({ socketPath: sock, path: `/sessions/${id}/events?after=99&wait=60`, method: 'GET' });
    req.on('error', () => {});
    req.end();
    await sleep(150);
    assert.equal(bridge.waiting, 1);
    req.destroy();
    await sleep(150);
    assert.equal(bridge.waiting, 0, 'the wait ended with its caller');
    const waits = [call(sock, 'GET', `/sessions/${id}/events?after=99&wait=60`), call(sock, 'GET', `/sessions/${id}/events?after=99&wait=60`)];
    await sleep(150);
    assert.equal(bridge.waiting, 2);
    const t0 = Date.now();
    await bridge.stop();
    const answered = await Promise.all(waits);
    assert.ok(Date.now() - t0 < 3000, 'stopping did not wait for the waits to run out');
    for (const r of answered) assert.equal(r.body.timedOut, true);
    void dsh;
});

test('api: an unknown path names the routes; a wrong method is a 405 with Allow; too large a body is a 413', async (t) => {
    const { sock, folder } = await bridgeOn(t, { raw: { maxBodyBytes: 2048 } });
    const unknown = await call(sock, 'GET', '/nope');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error.message, /^No such path\. The bridge answers GET \/health/);
    assert.equal((await call(sock, 'GET', '/sessions/a/b/c/d')).status, 404);
    assert.equal((await call(sock, 'GET', '/sessions/a/frobnicate')).status, 404);
    const wrong = await call(sock, 'DELETE', '/sessions');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.allow, 'GET, POST');
    assert.equal((await call(sock, 'POST', '/health', {})).status, 405);
    assert.equal((await call(sock, 'GET', '/sessions/x/prompt')).headers.allow, 'POST');
    const big = await call(sock, 'POST', '/sessions', { workspacePath: folder, text: 'x'.repeat(3000) });
    assert.equal(big.status, 413);
    assert.match(big.body.error.message, /^The request body is \d+ bytes; the bridge takes at most 2048 \(maxBodyBytes\)\.$/);
    // Without a length up front (sent in chunks), it is cut off at the limit too.
    const chunked = await new Promise((resolvePromise, reject) => {
        const req = request({ socketPath: sock, path: '/sessions', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolvePromise({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        req.write('{"text":"');
        req.write('y'.repeat(4000));
        req.end('"}');
    });
    assert.equal(chunked.status, 413, chunked.text);
    assert.equal((await call(sock, 'GET', '/health')).status, 200, 'the bridge still answers');
});

test('api: DSH too slow, or failing, is said as such and never stops the bridge', async (t) => {
    const { sock, dsh } = await bridgeOn(t, { readMs: 300 });
    dsh.controller.list = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
    const slow = await call(sock, 'GET', '/sessions');
    assert.equal(slow.status, 504);
    // DSH that never answers the list: the bridge's own deadline answers.
    dsh.controller.list = () => new Promise(() => {});
    const t0 = Date.now();
    const hung = await call(sock, 'GET', '/sessions');
    assert.equal(hung.status, 504);
    assert.match(hung.body.error.message, /^DSH did not list its sessions in 0\.3 s; try again\.$/);
    assert.ok(Date.now() - t0 < 3000);
    dsh.controller.modelCatalog = async () => { throw new Error('catalog exploded'); };
    const failed = await call(sock, 'GET', '/models');
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: { code: 'internal', message: 'catalog exploded' } });
    dsh.controller.inspect = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
    const reading = await call(sock, 'GET', '/sessions/s1');
    assert.equal(reading.status, 504);
    assert.match(reading.body.error.message, /^DSH did not read session s1 in 0\.3 s; try again\.$/);
    assert.equal((await call(sock, 'GET', '/health')).status, 200);
});

// ── Round 2: retried creates, cut-off turns, deadlines, read errors ──

test('log: a turn cut off after DSH saved the message (interrupted) or that failed (error) leaves it unfinished; one stopped on purpose is answered, one DSH tore down is not', () => {
    const base = [ev(1, 'turn/start', { turn: 1 }), ev(2, 'user/message', asked('job', 'j1'))];
    const endedBy = (reason, extra = []) => [...base, ...extra, ev(9, 'turn/end', { turn: 1, reason })];
    const ended = (kind, extra = []) => endedBy({ kind }, extra);
    assert.deepEqual(requestState(ended('interrupted'), 'j1'), { requestId: 'j1', state: 'unfinished', seq: 2, turn: 1, end: { seq: 9, kind: 'interrupted' }, reply: null });
    assert.equal(requestState(ended('error'), 'j1').state, 'unfinished');
    assert.equal(requestState(ended('interrupted', [ev(3, 'assistant/message', said('Half way'))]), 'j1').reply.text, 'Half way', 'a reply it gave before the cut is kept');
    // DSH's cancel causes, as dsh-agent-loop records them: a person (user), the session above it (parent), a plugin (hook), and DSH itself (disposed).
    const aborted = (by) => endedBy({ kind: 'aborted', reason: by }, [ev(3, 'assistant/message', { ...said('Work'), interrupted: true })]);
    for (const by of [{ kind: 'user' }, { kind: 'parent' }, { kind: 'hook', reason: 'budget' }]) {
        assert.equal(requestState(aborted(by), 'j1').state, 'answered', `stopped on purpose (${by.kind}) is not resent`);
    }
    const torn = requestState(aborted({ kind: 'disposed' }), 'j1');
    assert.deepEqual(torn, { requestId: 'j1', state: 'unfinished', seq: 2, turn: 1, end: { seq: 9, kind: 'aborted', reason: { kind: 'disposed' } }, reply: { seq: 3, text: 'Work', interrupted: true } },
        'a turn DSH tore down (a plugin or setting loaded again under it) is unfinished, and its cut-off reply says so');
    assert.equal(requestState(aborted({ kind: 'hook', reason: 'deepseek-account/signed-out' }), 'j1').state, 'unfinished', 'stopped because the account signed out: not done');
    assert.equal(requestState(aborted({ kind: 'user' }), 'j1').reply.interrupted, true, 'a reply cut where a person stopped the turn says so');
    // Ends of the turn's own are answered; an end the bridge does not know is never taken as done.
    for (const kind of ['completed', 'max-tokens', 'blocked']) assert.equal(requestState(ended(kind), 'j1').state, 'answered', kind);
    for (const reason of [{ kind: 'aborted' }, { kind: 'aborted', reason: { kind: 'later-cause' } }, { kind: 'paused' }, 'odd']) {
        assert.equal(requestState(endedBy(reason), 'j1').state, 'unfinished', JSON.stringify(reason));
    }
    assert.equal(endState({ kind: 'completed' }), 'answered');
    assert.equal(endState(undefined), 'unfinished');
    assert.equal(requestState(ended('completed'), 'j1').state, 'answered');
    // Sent again as the next attempt: the newest attempt counts, and says which it is.
    const again = [...ended('interrupted'), ev(10, 'turn/start', { turn: 2 }), ev(11, 'user/message', asked('job', 'j1~2')), ev(12, 'assistant/message', said('Done')), ev(13, 'turn/end', { turn: 2, reason: { kind: 'completed' } })];
    assert.deepEqual(requestState(again, 'j1'), { requestId: 'j1', state: 'answered', seq: 11, turn: 2, end: { seq: 13, kind: 'completed' }, reply: { seq: 12, text: 'Done' }, attempt: 2 });
    assert.deepEqual(requestState(ended('interrupted'), 'j1', 2), { requestId: 'j1', state: 'waiting', attempt: 2 }, 'an attempt the bridge sent and DSH has not shown yet is waiting');
    assert.equal(attemptOf('j1', 'j1'), 1);
    assert.equal(attemptOf('j1~3', 'j1'), 3);
    assert.equal(attemptOf('j1~x', 'j1'), 0);
    assert.equal(attemptOf('j10', 'j1'), 0);
    assert.equal(rpcIdFor('j1', 1), 'j1');
    assert.equal(rpcIdFor('j1', 2), 'j1~2');
});

test('log: a queued prompt taken out of DSH\'s queue (outcome canceled) is dropped at once, removed, even while a turn runs', () => {
    const msg = (rpcId) => ({ id: rpcId, role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId } });
    const log = [ev(1, 'turn/start', { turn: 1 }), ev(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('q')] }), ev(3, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })];
    assert.deepEqual(requestState(log, 'q'), { requestId: 'q', state: 'dropped', seq: 3, removed: true });
    // Moved from the queue into the running turn (the window's "steer now"): removed, then queued anew as a steer.
    const moved = [...log, ev(4, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [msg('q')] })];
    assert.deepEqual(requestState(moved, 'q'), { requestId: 'q', state: 'queued', seq: 4, target: 'next-step' });
});

test('api: a create retried with its request id makes one session and sends one message, also while the first is on its way', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    dsh.recordSteps = true;
    const body = { workspacePath: folder, title: 'Nightly', provider: 'p', model: 'm', text: 'Run the nightly job.', requestId: 'cron-nightly-1026' };
    let release;
    dsh.holdCreate = new Promise((r) => { release = r; });
    const first = call(sock, 'POST', '/sessions', body);
    await sleep(50);
    const overlap = call(sock, 'POST', '/sessions', body);
    await sleep(50);
    release();
    dsh.holdCreate = null;
    const [a, b] = [await first, await overlap];
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    assert.equal(b.body.sessionId, a.body.sessionId, 'one session');
    assert.equal(b.body.alreadyCreated, true);
    assert.equal(b.body.prompt.alreadySent, true);
    assert.equal(b.body.model, undefined, 'the model was not set again');
    assert.equal(b.body.title, undefined, 'nor the title (DSH has it)');
    assert.deepEqual(dsh.calls.map(([k]) => k), ['create', 'model', 'rename', 'prompt'], 'each step once');
    const later = await call(sock, 'POST', '/sessions', body);
    assert.equal(later.body.sessionId, a.body.sessionId);
    assert.equal(dsh.calls.filter(([k]) => k === 'create' || k === 'prompt').length, 2, 'still one create and one prompt');
    // The same id for another folder is refused in words.
    const elsewhere = join(folder, 'other');
    mkdirSync(elsewhere);
    const conflict = await call(sock, 'POST', '/sessions', { ...body, workspacePath: elsewhere });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'request/conflict');
    assert.match(conflict.body.error.message, /^Request id cron-nightly-1026 already made session session-1 in \S+; use a new request id for a session in \S+other\.$/);
    // The record beside the socket: 600, ids only, never the text or the title.
    const record = join(folder, 'sock', CREATES_FILE);
    assert.equal(modeOf(record), 0o600);
    const text = readFileSync(record, 'utf8');
    assert.ok(!text.includes('Run the nightly job') && !text.includes('Nightly'), text);
    assert.deepEqual(JSON.parse(text.trim()), { ...JSON.parse(text.trim()), requestId: 'cron-nightly-1026', sessionId: a.body.sessionId });
});

test('creates record: a bridge finds a create that another bridge on the same folder added after it read the file', () => {
    const folder = tempDir('sb');
    const file = join(folder, CREATES_FILE);
    const a = createsRecord(file);
    const b = createsRecord(file);
    assert.equal(b.get('job-1'), undefined, 'nothing there yet');
    a.add({ requestId: 'job-1', sessionId: 'session-1', workspace: { id: 'ws-1', path: folder } });
    assert.equal(b.get('job-1')?.sessionId, 'session-1', 'read again, because the file grew');
    b.add({ requestId: 'job-2', sessionId: 'session-2', workspace: { id: 'ws-1', path: folder } });
    assert.equal(a.get('job-2')?.sessionId, 'session-2');
    assert.deepEqual([a.size, b.size], [2, 2]);
    assert.equal(modeOf(file), 0o600);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2, 'one line each');
});

test('api: a create still on its way when the bridge starts again (a settings change) is waited for by a retry on the new bridge: one session, one message', async (t) => {
    const folder = tempDir('sb');
    const dsh = fakeDsh();
    dsh.recordSteps = true;
    const ws = join(folder, 'ws');
    mkdirSync(ws);
    const body = { workspacePath: ws, title: 'Backup', text: 'Back up the folder.', requestId: 'backup-2026-10-26' };
    const one = await bridgeOn(t, { folder, dsh });
    let release;
    dsh.holdCreate = new Promise((r) => { release = r; });
    const first = call(one.sock, 'POST', '/sessions', body).then(() => 'answered', (error) => error.code ?? error.message);
    await sleep(50);
    // The bridge stops (it closes the first caller's connection after 2 s) while DSH is still making that session.
    await one.bridge.stop();
    assert.notEqual(await first, 'answered', 'the first caller lost its connection');
    const two = await bridgeOn(t, { folder, dsh });
    const retry = call(two.sock, 'POST', '/sessions', body);
    await sleep(50);
    release();
    dsh.holdCreate = null;
    const got = await retry;
    assert.equal(got.status, 200, got.text);
    assert.equal(got.body.alreadyCreated, true);
    assert.equal(got.body.prompt.alreadySent, true, 'the first try had sent it');
    assert.deepEqual(dsh.calls.map(([k]) => k), ['create', 'rename', 'prompt'], 'each step once');
    assert.equal(dsh.sessions.size, 1, 'one session');
});

test('api: a create retried after DSH restarts finds its session from the record beside the socket, and finishes only what was not done', async (t) => {
    const folder = tempDir('sb');
    const dsh = fakeDsh();
    const ws = join(folder, 'ws');
    mkdirSync(ws);
    // The first create's model step fails after DSH made the session.
    dsh.failNext.model = remoteError('session/model-unavailable', 'Select an available model before sending a message.');
    const body = { workspacePath: ws, title: 'Report', provider: 'p', model: 'm', text: 'Write the report.', requestId: 'report-2026-10-26' };
    const one = await bridgeOn(t, { folder, dsh });
    const failed = await call(one.sock, 'POST', '/sessions', body);
    assert.equal(failed.status, 409);
    assert.equal(failed.body.failedStep, 'model');
    await one.bridge.stop();
    // DSH restarted: a new bridge with nothing in memory (its own empty map), the same socket folder.
    const two = await bridgeOn(t, { folder, dsh });
    const retried = await call(two.sock, 'POST', '/sessions', body);
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.body.sessionId, failed.body.sessionId, 'the session the first try made');
    assert.equal(retried.body.alreadyCreated, true);
    assert.deepEqual(retried.body.model, { provider: 'p', model: 'm' }, 'the step that failed is done now');
    assert.equal(retried.body.prompt.alreadySent, undefined, 'and the prompt is sent, once');
    assert.deepEqual(dsh.calls.map(([k]) => k), ['create', 'model', 'model', 'rename', 'prompt']);
    // Its message reached the log; a third try after another restart sends nothing.
    dsh.push(retried.body.sessionId, 'user/message', asked('Write the report.', 'report-2026-10-26'));
    await two.bridge.stop();
    const three = await bridgeOn(t, { folder, dsh });
    const third = await call(three.sock, 'POST', '/sessions', body);
    assert.equal(third.body.prompt.alreadySent, true);
    assert.equal(dsh.calls.filter(([k]) => k === 'create' || k === 'prompt').length, 2);
    // A session DSH no longer has is said so, never made again silently.
    dsh.sessions.delete(retried.body.sessionId);
    const gone = await call(three.sock, 'POST', '/sessions', body);
    assert.equal(gone.status, 409);
    assert.equal(gone.body.error.code, 'request/session-gone');
});

test('api: an unfinished prompt (its turn cut off after DSH saved it) is sent once more under the next attempt, which DSH takes as new', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    const first = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Migrate.', requestId: 'mig-1' })).body;
    assert.equal(first.requestId, 'mig-1');
    assert.equal(dsh.calls.at(-1)[1].requestId, 'mig-1', 'the first attempt is the id itself');
    dsh.push(id, 'turn/start', { turn: 1 });
    dsh.push(id, 'user/message', asked('Migrate.', 'mig-1'));
    dsh.push(id, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    const cut = (await call(sock, 'GET', `/sessions/${id}/requests/mig-1?wait=5`)).body;
    assert.deepEqual({ state: cut.state, end: cut.end.kind, timedOut: cut.timedOut }, { state: 'unfinished', end: 'interrupted', timedOut: false }, 'a wait ends on it');
    const again = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Migrate.', requestId: 'mig-1' })).body;
    assert.deepEqual(again, { accepted: true, mode: 'followup', requestId: 'mig-1', chars: 8, attempt: 2, resent: true });
    assert.equal(dsh.calls.at(-1)[1].requestId, 'mig-1~2', 'DSH gets a new rpcId, so it does not take it as the old one');
    // While it is on its way, and once it is read, a retry is not sent a third time.
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Migrate.', requestId: 'mig-1' })).body.alreadySent, true);
    dsh.push(id, 'turn/start', { turn: 2 });
    dsh.push(id, 'user/message', asked('Migrate.', 'mig-1~2'));
    dsh.push(id, 'assistant/message', said('Migrated.'));
    dsh.push(id, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    const done = (await call(sock, 'GET', `/sessions/${id}/requests/mig-1`)).body;
    assert.deepEqual({ state: done.state, attempt: done.attempt, reply: done.reply.text }, { state: 'answered', attempt: 2, reply: 'Migrated.' });
    const third = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Migrate.', requestId: 'mig-1' })).body;
    assert.deepEqual({ alreadySent: third.alreadySent, state: third.state, attempt: third.attempt }, { alreadySent: true, state: 'answered', attempt: 2 });
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 2);
    // A queued prompt someone takes out of DSH's queue reads dropped (removed), and may be sent again.
    const msg = (rpcId) => ({ id: rpcId, role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId } });
    dsh.push(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('later-1')] });
    dsh.push(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' });
    assert.deepEqual((await call(sock, 'GET', `/sessions/${id}/requests/later-1`)).body, { sessionId: id, requestId: 'later-1', state: 'dropped', seq: 8, removed: true });
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'x', requestId: 'later-1' })).body.alreadySent, undefined);
});

test('api: DSH holding a prompt past the deadline gets a 504 in words at the deadline; a retry meanwhile is not sent; a late refusal frees the id', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t, { promptMs: 300 });
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    let release;
    dsh.hold = new Promise((r) => { release = r; });
    const t0 = Date.now();
    const slow = await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy.', requestId: 'deploy-7' });
    const took = Date.now() - t0;
    assert.equal(slow.status, 504);
    assert.ok(took >= 280 && took < 2000, `answered at the deadline (${took} ms)`);
    assert.equal(slow.body.error.code, 'dsh/timeout');
    assert.match(slow.body.error.message, new RegExp(`^DSH did not take the prompt in 0\\.3 s\\. It may still take it: ask GET /sessions/${id}/requests/deploy-7 before you send it again\\.$`));
    assert.equal(slow.body.requestId, 'deploy-7');
    const retry = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy.', requestId: 'deploy-7' })).body;
    assert.deepEqual({ alreadySent: retry.alreadySent, state: retry.state }, { alreadySent: true, state: 'waiting' });
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 1);
    // DSH refuses it late: the id is free again, and a retry goes through.
    dsh.failLate = remoteError('session/agent-busy', 'prompt rejected');
    release();
    dsh.hold = null;
    await sleep(50);
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy.', requestId: 'deploy-7' })).body.alreadySent, undefined);
    assert.equal(PROMPT_MS, 60000);
    assert.equal(READ_MS, 20000);
});

test('api: a read DSH fails for another reason than "not found" is a 500 in words, never a 404; DSH\'s own not-found stays a 404', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    dsh.failNext.inspect = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    const io = await call(sock, 'GET', `/sessions/${id}`);
    assert.equal(io.status, 500);
    assert.equal(io.body.error.code, 'session/read-failed');
    assert.match(io.body.error.message, new RegExp(`^DSH could not read session ${id}: EIO: i/o error, read\\. The session may still be there: try again; DSH's log says more\\.$`));
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'x', requestId: 'r-io' })).status, 500, 'a prompt with an id is not sent blind');
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 0);
    class ApiSessionNotFound extends Error {}
    dsh.failNext.inspect = new ApiSessionNotFound(`session "${id}" not found`);
    assert.equal((await call(sock, 'GET', `/sessions/${id}`)).status, 404);
    dsh.failNext.inspect = undefined;
    assert.equal(isNotFound(Object.assign(new Error('x'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })), true);
    assert.equal(isNotFound(new Error('session "a" not found')), true);
    assert.equal(isNotFound(new Error('disk full')), false);
    // A deadline that DSH would not keep is kept by the bridge, and a late failure is never unhandled.
    const late = withDeadline(new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30)), 10, () => new Error('deadline'));
    await assert.rejects(late, /deadline/);
    await sleep(40);
});

test('api: reasoningEffort goes with a model: alone, or not a string, it is refused in words before anything is made', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const alone = await call(sock, 'POST', '/sessions', { workspacePath: folder, reasoningEffort: 'max' });
    assert.equal(alone.status, 400);
    assert.match(alone.body.error.message, /^reasoningEffort goes with provider and model: give all three \(GET \/models lists them\), or none for DSH's default model and effort\.$/);
    const number = await call(sock, 'POST', '/sessions', { workspacePath: folder, provider: 'p', model: 'm', reasoningEffort: 7 });
    assert.equal(number.status, 400);
    assert.match(number.body.error.message, /^reasoningEffort must be a string/);
    assert.equal(dsh.calls.length, 0, 'nothing was made');
    const ok = await call(sock, 'POST', '/sessions', { workspacePath: folder, provider: 'p', model: 'm', reasoningEffort: 'high' });
    assert.equal(ok.status, 200);
    assert.equal(dsh.calls[1][1].reasoningEffort, 'high');
});

test('api: an event that lands between a wait\'s first read and its start is not missed; a wait the bridge\'s stop ends says stopped', async (t) => {
    const { sock, dsh, bridge, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    dsh.afterInspect = () => dsh.push(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const t0 = Date.now();
    const page = (await call(sock, 'GET', `/sessions/${id}/events?after=-1&types=turn/end&wait=5`)).body;
    assert.equal(page.timedOut, false);
    assert.deepEqual(page.events.map((e) => e.type), ['turn/end']);
    assert.ok(Date.now() - t0 < 2000, 'answered at once, not at the deadline');
    const waiting = call(sock, 'GET', `/sessions/${id}/events?after=99&wait=60`);
    await sleep(100);
    await bridge.stop();
    assert.deepEqual(pickKeys((await waiting).body, ['timedOut', 'stopped']), { timedOut: true, stopped: true });
});

test('socket: the home folder is refused however it is spelt: through a symlink, or in another letter case on a disk that ignores case', async () => {
    const folder = tempDir('sb');
    const home = process.env.HOME;
    process.env.HOME = join(folder, 'home');
    mkdirSync(process.env.HOME, { mode: 0o755 });
    try {
        symlinkSync(process.env.HOME, join(folder, 'link'));
        assert.match(await prepareSocket(join(folder, 'link', 'bridge.sock')), /is shared/);
        const upper = join(folder, 'HOME');
        if (existsSync(upper)) assert.match(await prepareSocket(join(upper, 'bridge.sock')), /is shared/);
        assert.equal(modeOf(process.env.HOME), 0o755, 'left as it was');
    } finally {
        process.env.HOME = home;
    }
});

test('log: its size counts bytes; a symlink at its path is never written through', async (t) => {
    const folder = tempDir('sb');
    const ws = join(folder, 'wé-ü-漢字');
    mkdirSync(ws);
    const { sock, logFile } = await bridgeOn(t, { folder, logMaxBytes: 1200 });
    for (let i = 0; i < 12; i++) await call(sock, 'POST', '/sessions', { workspacePath: ws });
    assert.ok(statSync(logFile).size <= 1200, `${statSync(logFile).size} bytes`);
    assert.ok(statSync(`${logFile}.1`).size <= 1200);
    const folder2 = tempDir('sb');
    mkdirSync(join(folder2, 'sock'), { mode: 0o700 });
    const target = join(folder2, 'elsewhere.txt');
    writeFileSync(target, 'keep\n');
    symlinkSync(target, join(folder2, 'sock', 'bridge.log'));
    const linked = await bridgeOn(t, { folder: folder2 });
    assert.equal(linked.ok, true, 'the bridge still listens');
    const health = (await call(linked.sock, 'GET', '/health')).body;
    assert.equal(readFileSync(target, 'utf8'), 'keep\n', 'nothing written through the link');
    assert.ok(lstatSync(join(folder2, 'sock', 'bridge.log')).isSymbolicLink());
    assert.match(health.problems[0] ?? '', /^logFile \S+bridge\.log cannot be written \(ELOOP: it is a symlink, which the bridge never writes through\), so the bridge's actions are not logged\./, 'and it says so');
});

// ── Pass 2: a turn DSH tears down, a retry with another text ──────────

test('api: a prompt whose turn DSH tore down (aborted, disposed) is unfinished, never answered with the cut-off text, and a retry sends it once more', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Rebuild the index.', requestId: 'rebuild-1' });
    dsh.push(id, 'turn/start', { turn: 1 });
    dsh.push(id, 'user/message', asked('Rebuild the index.', 'rebuild-1'));
    const waiting = call(sock, 'GET', `/sessions/${id}/requests/rebuild-1?wait=30`);
    await sleep(50);
    // DSH saves the stream it cut as an interrupted message, then ends the turn: the agent loop's row was changed under it.
    dsh.push(id, 'assistant/message', { ...said('Working'), interrupted: true });
    dsh.push(id, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } });
    const cut = (await waiting).body;
    assert.deepEqual({ state: cut.state, end: cut.end, reply: cut.reply, timedOut: cut.timedOut },
        { state: 'unfinished', end: { seq: 3, kind: 'aborted', reason: { kind: 'disposed' } }, reply: { seq: 2, text: 'Working', interrupted: true }, timedOut: false });
    const events = (await call(sock, 'GET', `/sessions/${id}/events?types=assistant/message`)).body.events;
    assert.equal(events[0].interrupted, true, 'the events route marks the cut-off reply too');
    const again = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Rebuild the index.', requestId: 'rebuild-1' })).body;
    assert.deepEqual(again, { accepted: true, mode: 'followup', requestId: 'rebuild-1', chars: 18, attempt: 2, resent: true });
    assert.equal(dsh.calls.at(-1)[1].requestId, 'rebuild-1~2');
    // Stopped by a person instead: answered, never sent again.
    const id2 = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    await call(sock, 'POST', `/sessions/${id2}/prompt`, { text: 'Rebuild.', requestId: 'rebuild-2' });
    dsh.push(id2, 'turn/start', { turn: 1 });
    dsh.push(id2, 'user/message', asked('Rebuild.', 'rebuild-2'));
    dsh.push(id2, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    const stopped = (await call(sock, 'POST', `/sessions/${id2}/prompt`, { text: 'Rebuild.', requestId: 'rebuild-2' })).body;
    assert.deepEqual({ alreadySent: stopped.alreadySent, state: stopped.state }, { alreadySent: true, state: 'answered' });
    assert.equal(dsh.calls.filter(([k]) => k === 'prompt').length, 3);
});

test('api: a retry with the same request id but another text is refused (409, request/conflict), never dropped without a word; a resend may carry a new text', async (t) => {
    const { sock, dsh, folder } = await bridgeOn(t);
    dsh.recordSteps = true;
    const id = (await call(sock, 'POST', '/sessions', { workspacePath: folder })).body.sessionId;
    const prompts = () => dsh.calls.filter(([k]) => k === 'prompt').length;
    // On its way into DSH (held): the bridge knows the text only by its fingerprint.
    let release;
    dsh.hold = new Promise((r) => { release = r; });
    const first = call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy build 41.', requestId: 'deploy-41' });
    await sleep(50);
    const inFlight = await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy build 42.', requestId: 'deploy-41' });
    assert.equal(inFlight.status, 409);
    assert.deepEqual(inFlight.body, { error: { code: 'request/conflict', message: `Request id deploy-41 already went to session ${id} with another text (it is waiting); it is not sent again. Use a new request id for another prompt.` }, requestId: 'deploy-41', state: 'waiting' });
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy build 41.', requestId: 'deploy-41' })).body.alreadySent, true, 'the same text is a plain retry');
    release();
    dsh.hold = null;
    assert.equal((await first).status, 200);
    // Queued in DSH's inbox, then read and answered: compared with the text DSH holds.
    const queued = await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy build 43.', requestId: 'deploy-41' });
    assert.deepEqual([queued.status, queued.body.error.code, queued.body.state], [409, 'request/conflict', 'queued']);
    dsh.push(id, 'turn/start', { turn: 1 });
    dsh.push(id, 'user/message', asked('Deploy build 41.', 'deploy-41'));
    dsh.push(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const answered = await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'deploy build 41.', requestId: 'deploy-41' });
    assert.deepEqual([answered.status, answered.body.state], [409, 'answered']);
    assert.equal((await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Deploy build 41.', requestId: 'deploy-41' })).body.alreadySent, true);
    assert.equal(prompts(), 1, 'sent once');
    assert.equal(sentText([ev(1, 'user/message', asked('x', 'a'))], 'b'), undefined);
    // Cut off (unfinished): a retry is a new attempt, and the text given now is the one sent.
    dsh.push(id, 'user/message', asked('Migrate.', 'mig-9'));
    dsh.push(id, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } });
    const resent = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'Migrate, from step 3.', requestId: 'mig-9' })).body;
    assert.deepEqual({ attempt: resent.attempt, resent: resent.resent }, { attempt: 2, resent: true });
    assert.deepEqual(dsh.calls.at(-1)[1].content, [{ type: 'text', text: 'Migrate, from step 3.' }]);
    // A create retried with another first text says the same, with the session it made.
    const body = { workspacePath: folder, text: 'Nightly run.', requestId: 'nightly-7' };
    const made = (await call(sock, 'POST', '/sessions', body)).body;
    const other = await call(sock, 'POST', '/sessions', { ...body, text: 'Nightly run, again.' });
    assert.deepEqual([other.status, other.body.error.code, other.body.sessionId, other.body.failedStep], [409, 'request/conflict', made.sessionId, 'prompt']);
    assert.equal(dsh.calls.filter(([k]) => k === 'create').length, 2, 'no second session');
});

test('events: a reply DSH cut off is marked interrupted in the events page and the session summary', () => {
    const log = [ev(1, 'turn/start', { turn: 1 }), ev(2, 'assistant/message', { ...said('Half'), interrupted: true }), ev(3, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })];
    assert.equal(summarize(log[1], false).interrupted, true);
    assert.equal(summarize(ev(4, 'assistant/message', said('Whole')), false).interrupted, undefined);
    assert.deepEqual(sessionSummary('s', {}, log, { status: 'idle' }).lastAssistant, { seq: 2, text: 'Half', interrupted: true });
});

const pickKeys = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));

// ── The plugin's files ────────────────────────────────────────────────

test('files: the plugin\'s code parses, its real-DSH test parses, and no file names another vendor\'s assistant', () => {
    for (const file of ['lib/index.js', 'lib/bridge.js', 'test/e2e/run.mjs']) execFileSync(process.execPath, ['--check', join(PLUGIN_DIR, file)]);
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
    for (const file of walk(PLUGIN_DIR)) assert.doesNotMatch(readFileSync(file, 'utf8'), OTHER_NAMES, file);
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'dsh-plugin-session-bridge');
    // Presented as DSH presents its own plugins: a title, one plain sentence and a 36 by 36 icon.
    const meta = JSON.parse(readFileSync(join(PLUGIN_DIR, 'locale', 'en.json'), 'utf8')).meta;
    assert.equal(meta.title, 'Session Bridge');
    assert.match(meta.description, /^[A-Z][^.]+\.$/);
    assert.equal(pkg.description, meta.description);
    assert.equal(pkg.icon, './icon.svg');
    assert.match(readFileSync(join(PLUGIN_DIR, 'icon.svg'), 'utf8'), /^<svg width="36" height="36" viewBox="0 0 36 36"/);
    assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
    assert.equal(pkg.exports['.'], './lib/index.js');
    for (const file of ['lib', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md']) assert.ok(pkg.files.includes(file), file);
    assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-home-paths'], 'it takes its folder from DSH');
    const index = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
    assert.match(index, /from '@deepseek-ai\/dsh-home-paths'/);
    assert.doesNotMatch(index.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\.dsh\//, 'no data folder path built by hand');
});

test('readme: its settings, limits, routes and states are the code\'s', async (t) => {
    const readme = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8');
    // Every setting the bridge has is in the settings table, and no other.
    const table = [...readme.matchAll(/^\| `(\w+)` \| [^|]+ \| [^|]+ \| [^|]+ \|$/gm)].map((m) => m[1]);
    assert.deepEqual(table, ['socketPath', 'logFile', 'maxBodyBytes']);
    const { problems } = checkSettings(Object.fromEntries(table.map((k) => [k, 'x'])), { socketPath: '/s', logFile: '/l' });
    assert.ok(problems.every((p) => !/is not a setting/.test(p)), 'each one is a setting of the bridge');
    assert.ok(checkSettings({ enabled: true }, { socketPath: '/s', logFile: '/l' }).problems[0].startsWith('enabled is no longer a setting'), 'and enabled, which the README says is retired, is not');
    // The limits the README gives are the code's.
    for (const text of [`\`${MAX_BODY_DEFAULT}\``, `${MAX_BODY_RANGE[0]} to ${MAX_BODY_RANGE[1]}`, `at most ${SOCKET_PATH_MAX} bytes`, `Past ${LOG_MAX_BYTES / 1048576} MB`,
        `(0 to ${WAIT_MAX_SECONDS}; more reads as ${WAIT_MAX_SECONDS})`, `\`limit\` is 1 to ${EVENTS_LIMIT_MAX}`, 'at most 500 characters', '1 to 128 letters, digits or `. _ : -`',
        `${READ_MS / 1000} s to read a session or the list, ${PROMPT_MS / 1000} s to take a prompt`, `\`${CREATES_FILE}\``]) {
        assert.ok(readme.includes(text), `the README says ${text}`);
    }
    // How each turn end leaves a prompt is the code's: the end kinds and stop causes its states table names.
    const row = (state) => readme.split('\n').find((l) => l.startsWith(`| \`${state}\` |`)) ?? '';
    const named = (line) => new Set([...line.matchAll(/`([a-z][a-z-]*(?:\/[a-z-]+)?)`/g)].map((m) => m[1]));
    const answeredRow = named(row('answered'));
    const unfinishedRow = named(row('unfinished'));
    for (const kind of ['completed', 'max-tokens', 'blocked']) assert.ok(answeredRow.has(kind) && endState({ kind }) === 'answered', kind);
    for (const by of ['user', 'parent', 'hook']) assert.ok(answeredRow.has(by) && endState({ kind: 'aborted', reason: { kind: by, reason: 'budget' } }) === 'answered', by);
    for (const kind of ['interrupted', 'error']) assert.ok(unfinishedRow.has(kind) && endState({ kind }) === 'unfinished', kind);
    assert.ok(unfinishedRow.has('disposed') && !answeredRow.has('disposed') && endState({ kind: 'aborted', reason: { kind: 'disposed' } }) === 'unfinished');
    assert.ok(unfinishedRow.has('deepseek-account/signed-out') && endState({ kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } }) === 'unfinished');
    // Every route in its table is one the bridge answers, with that method.
    const routes = [...readme.matchAll(/^\| `(GET|POST) (\/[^`]*)` \|/gm)].map((m) => [m[1], m[2]]);
    assert.equal(routes.length, 12);
    const { sock, dsh } = await bridgeOn(t);
    const ws = tempDir('sbws');
    const made = await call(sock, 'POST', '/sessions', { workspacePath: ws });
    const id = made.body.sessionId;
    const sent = (await call(sock, 'POST', `/sessions/${id}/prompt`, { text: 'hello', requestId: 'readme-1' })).body;
    assert.equal(sent.requestId, 'readme-1');
    dsh.sessions.get(id).agent.status = 'running'; // a turn runs, so cancel has one to stop
    for (const [method, path] of routes) {
        const real = path.replace(':id', id).replace(':requestId', 'readme-1');
        const body = { '/sessions': { workspacePath: ws }, prompt: { text: 'again' }, model: { provider: 'p', model: 'm' }, rename: { title: 'T' } };
        const r = await call(sock, method, real, method === 'POST' ? (body[real.split('/').at(-1)] ?? body[real] ?? {}) : undefined);
        assert.equal(r.status, 200, `${method} ${path}: ${r.text.slice(0, 200)}`);
    }
    assert.ok(dsh.calls.some(([kind]) => kind === 'cancel'));
    // The states it lists are the ones requestState gives, and the status codes the ones the bridge answers with.
    const states = [...readme.matchAll(/^\| `(\w+)` \| (?!Meaning)/gm)].map((m) => m[1]).filter((s) => !table.includes(s));
    assert.deepEqual(states, ['waiting', 'queued', 'read', 'answered', 'unfinished', 'dropped']);
    const codes = [...readme.matchAll(/^\| (\d{3}) \|/gm)].map((m) => Number(m[1]));
    assert.deepEqual(codes, [400, 404, 405, 409, 413, 500, 503, 504]);
});
