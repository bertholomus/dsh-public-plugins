#!/usr/bin/env node
/**
 * The session bridge in a real DSH: every route against DSH's own session
 * controller, with each claim checked in the session's own log (through the
 * bridge, and on disk where it matters); its security claims (a Unix socket
 * only, 700 and 600, no prompt text in the log); creates and prompts retried
 * with their request ids, across restarts too; settings changed while DSH
 * runs, wrong ones too; a socket another program holds, which it never takes
 * over and which shows as failed in Plugins; its Plugins face; switched off
 * and on in Plugins; and a bridged session in a real window, light and dark,
 * taking a prompt live.
 *
 * DSH runs from a throwaway DSH_HOME (test/e2e/harness.mjs) with this repo's
 * session bridge and a scripted model (test/e2e/fake-model.mjs). The socket,
 * its folder, the create record and the log are inside the throwaway folder.
 *
 * - Security: the socket's folder is made 700 and the socket 600; the log is
 *   600 and holds actions and sizes, never a prompt's text or a title; the
 *   DSH process listens on no TCP port but its own window's, the same with
 *   the bridge on and off.
 * - Sessions: made in a folder with a title, a model and a first prompt;
 *   followup, steer into a running turn, cancel (and a 409 with no turn
 *   running), rename, model; what became of each prompt (queued, read,
 *   answered) matches the session's log; a retried prompt and a retried
 *   create (two at once, then a third) are sent once and make one session,
 *   and a retry with another text is a 409; waits answer when DSH commits
 *   the event, or say they ran out.
 * - Refusals in words: bad JSON, a body over maxBodyBytes, an unknown
 *   session, path or method, a relative folder, a model DSH does not have
 *   (the session's id comes back with the failed step), a create's request
 *   id used for another folder.
 * - Restarts under a running turn (DSH's SIGTERM): the old socket is
 *   replaced; the turn reads as interrupted; its prompt reads as the log on
 *   disk says (dropped, or unfinished) and is sent again once; one restart
 *   waits until DSH saved the prompt, so that the unfinished path is always
 *   run: attempt 2 goes as `<id>~2`, is answered, and the log on disk holds
 *   each attempt once. A crash (SIGKILL): the stale socket is replaced.
 * - A turn DSH tears down under its prompt (the agent loop's row changed:
 *   aborted, reason disposed, on disk): unfinished, its cut-off reply marked
 *   interrupted, sent once more as attempt 2 and answered; on disk once each.
 * - Settings while DSH runs: a new log file; wrong values named in
 *   GET /health and the bridge's log while it keeps working; a log that
 *   cannot be written (said in GET /health, gone once it can be written);
 *   enabled: false (the start fails with the reason: failed in Plugins,
 *   never running, nothing listens), then the row without it (and off and
 *   on, if DSH left it failed: running); a socket path another program
 *   answers on is refused and left alone, failed in Plugins, still failed
 *   with the row that last ran, running again once switched off and on,
 *   and at once with a row that differs from the one that last ran.
 * - Plugins: its title, sentence and icon; switched off (no socket left)
 *   and on again.
 * - The window: the bridged session in DSH's sidebar, and a prompt sent
 *   through the bridge showing in the open chat live; light, dark, 760 px.
 *
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node plugins/session-bridge/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/; `node scripts/e2e.mjs
 * session-bridge` runs it on each of those and on the installed app's own
 * DSH. SHOTS=<folder> keeps the window's pictures there (default
 * .e2e/shots/session-bridge/<version>); KEEP=1 keeps the throwaway home.
 * Without Playwright the run fails, unless NO_WINDOW=1 says to run without
 * the window checks.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { DshRun, checks, dismissNotices, dshBin, findPlaywright, modeOf, openWindow, pluginsDir, repoRoot, setDark, shot, sleep, waitFor } from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from '../../../../test/e2e/fake-model.mjs';

const bin = dshBin();
if (!bin) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'session-bridge', version);
console.log(`# DSH ${version}: ${bin}`);
console.log(`# pictures: ${shots}`);

const tally = checks();
const { check, step } = tally;
const json = (value) => JSON.stringify(value);
const model = await startFakeModel();
const run = new DshRun({ label: 'session-bridge', bin, plugins: { 'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge') } });
// The socket in a folder of its own that the bridge makes, inside the throwaway folder (a socket path must be short).
let base = run.sockDir;
let ownBase = false;
if (Buffer.byteLength(join(base, 'own', 'bridge.sock')) > 100) {
    base = mkdtempSync('/tmp/dshb-');
    ownBase = true;
}
const ownDir = join(base, 'own');
run.sock = join(ownDir, 'bridge.sock');
const logFile = join(run.root, 'logs', 'bridge.log');
const MARK = `e2e-secret-${randomUUID().slice(0, 8)}`;
/** A prompt sent again after a cut-off turn, and the scripted model's answer to it (a todo list written, then a reply). */
const AGAIN = 'E2E:todos [{"content":"Sent again after the restart","status":"completed"}]';
const REPLIED = /^(Done with todo_write\. Working through the list\.|MISSING TOOL todo_write)$/;
const TITLE = `Bridge title ${randomUUID().slice(0, 8)}`;

/** The bridge's row: its socket and log in the throwaway folder, a small body limit, and `extra` keys. */
function rowWith(extra = {}) {
    const config = { socketPath: run.sock, logFile, maxBodyBytes: 65536, ...extra };
    return `- id: session-bridge\n  config:\n${Object.entries(config).map(([k, v]) => `    ${k}: ${json(v)}`).join('\n')}\n`;
}
/** The profile, with the harness's bridge row replaced by this test's. DSH applies a saved change while it runs. */
function writeRow(extra) {
    run.writeProfile(model.port);
    const patch = join(run.profile, 'cordis.patch.yml');
    const text = readFileSync(patch, 'utf8');
    const start = text.indexOf('- id: session-bridge');
    const end = text.indexOf('\n- id:', start + 1);
    writeFileSync(patch, `${text.slice(0, start)}${rowWith(extra)}${end < 0 ? '' : text.slice(end + 1)}`);
}

/** A raw call: { status, headers, body, text } (the harness's bridge() throws on 4xx). */
function call(method, path, body, { raw, sock = run.sock, timeout = 90000 } = {}) {
    return new Promise((resolvePromise, reject) => {
        const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
        const req = request({ socketPath: sock, path, method, headers: data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(text); } catch {}
                resolvePromise({ status: res.statusCode, headers: res.headers, body: parsed, text });
            });
        });
        req.setTimeout(timeout, () => req.destroy(new Error(`${method} ${path}: no answer in ${timeout / 1000} s`)));
        req.on('error', reject);
        if (data !== undefined) req.write(data);
        req.end();
    });
}
const answers = async (sock = run.sock) => {
    try {
        return (await call('GET', '/health', undefined, { sock, timeout: 3000 })).status === 200;
    } catch {
        return false;
    }
};
const read = (file) => {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return '';
    }
};
/** Whether an rpcId is one attempt of a request id: the id itself, or `<id>~<n>` when the bridge sent it again. */
const ofRequest = (rpcId, rid) => rpcId === rid || (typeof rpcId === 'string' && rpcId.startsWith(`${rid}~`) && /^\d+$/.test(rpcId.slice(rid.length + 1)));
/** The user messages in a session's own log sent with one request id (each attempt). */
const sentWith = async (sessionId, rid) => (await run.events(sessionId, 'user/message')).filter((e) => ofRequest(e.source?.rpcId, rid));
/** The same, read from the session's log on disk, as DSH saved it (not through the bridge). */
const savedWith = (sessionId, rid) => run.savedEvents(sessionId).filter((e) => e.type === 'user/message' && ofRequest(e.data?.source?.rpcId, rid));
const turnEnds = (sessionId) => run.events(sessionId, 'turn/end');

/** The TCP addresses DSH's process listens on (lsof), or null when lsof cannot say. */
function tcpListeners() {
    try {
        const out = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(run.child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
        return [...new Set(out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)))].sort();
    } catch (error) {
        return error.status === 1 ? [] : null;
    }
}
const windowPort = () => Number(new URL(run.signInLink()).port);
/** The bridge's entry in DSH's plugin inventory (what its Plugins page shows): phase, switch and meta. */
const bridgeEntry = async () => (await run.api('pluginInventory/list', {}))?.value?.entries?.find((e) => e.moduleName === 'dsh-plugin-session-bridge');

/** Start DSH again without clearing the socket first (the harness's boot() removes it): the bridge must replace a stale one itself. */
async function startKeepingSocket(what) {
    const before = run.signIns();
    run.start();
    await waitFor(async () => existsSync(run.sock) && (await run.bridge('GET', '/health')).ok, `the session bridge (${what})`, 120000);
    await waitFor(() => run.signIns() > before, `the web sign-in link (${what})`, 60000);
    run.web = undefined;
}

let window;
const ids = {};
/** More logs the run wrote to, read at the end for prompt text. */
const logs = [];
try {
    writeRow();
    await run.boot('first start');

    // ── Security ──────────────────────────────────────────────────────
    await step('security: a Unix socket only, owner-only, and a log without prompt text', async () => {
        const health = await run.bridge('GET', '/health');
        check('GET /health answers: the plugin, its version, DSH\'s pid, the socket, no problems', health.ok === true && health.plugin === 'session-bridge' && /^\d+\.\d+\.\d+$/.test(health.version)
            && health.pid === run.child.pid && health.socket === run.sock && Array.isArray(health.problems) && health.problems.length === 0, json(health));
        check('the socket\'s folder was made by the bridge, mode 700, and its log says so', modeOf(ownDir) === 0o700 && read(logFile).includes(`made ${ownDir} (mode 700) for the socket\n`), `${modeOf(ownDir).toString(8)} ${read(logFile).slice(0, 300)}`);
        check('the socket is a socket, mode 600', statSync(run.sock).isSocket() && modeOf(run.sock) === 0o600, modeOf(run.sock).toString(8));
        check('the log is mode 600 and says where the bridge listens', modeOf(logFile) === 0o600 && read(logFile).includes(`listening ${run.sock} pid=${run.child.pid}`), read(logFile).slice(0, 300));
        const tcp = tcpListeners();
        check('DSH listens on no TCP port but its own window\'s', Array.isArray(tcp) && tcp.length > 0 && tcp.every((a) => a.endsWith(`:${windowPort()}`)), json({ tcp, window: windowPort() }));
    });

    // ── Sessions ──────────────────────────────────────────────────────
    await step('a new session: in a folder, with a title, a model and a first prompt, answered and proven in its log', async () => {
        const rid = `e2e-first-${randomUUID().slice(0, 8)}`;
        const made = await call('POST', '/sessions', { workspacePath: run.ws, title: TITLE, provider: 'fake', model: 'fake-model', text: `E2E:say First reply ${MARK}`, requestId: rid });
        check('POST /sessions makes the session, sets its model and title, and sends the prompt', made.status === 200 && /^session-/.test(made.body.sessionId) && made.body.workspace?.path && made.body.model && made.body.title
            && made.body.prompt?.accepted === true && made.body.prompt.requestId === rid, made.text);
        ids.first = made.body.sessionId;
        ids.firstRid = rid;
        const done = (await call('GET', `/sessions/${ids.first}/requests/${rid}?wait=60`)).body;
        check('what became of the prompt: answered, its turn completed, with the reply', done.state === 'answered' && done.end?.kind === 'completed' && done.reply?.text === `First reply ${MARK}` && done.timedOut === false, json(done));
        const sent = await sentWith(ids.first, rid);
        check('the session\'s log has the message once, with that request id, where the bridge says', sent.length === 1 && sent[0].text === `E2E:say First reply ${MARK}` && sent[0].seq === done.seq, json(sent));
        const s = await run.session(ids.first);
        check('GET /sessions/:id: its title, idle, one turn started and ended, the last reply, its folder', s.title === TITLE && s.status === 'idle' && s.turns.started === 1 && s.turns.ended === 1
            && s.lastAssistant?.text === `First reply ${MARK}` && s.cwd === made.body.workspace.path, json(s));
        const listed = await run.bridge('GET', '/sessions');
        const workspaces = await run.bridge('GET', '/workspaces');
        const models = await run.bridge('GET', '/models');
        check('GET /sessions lists it; GET /workspaces its folder; GET /models DSH\'s models', listed.some((x) => x.sessionId === ids.first) && workspaces.some((w) => w.id === made.body.workspace.id && w.sessions >= 1)
            && models.groups?.some((g) => g.models?.some((m) => m.id === 'fake-model')), json({ workspaces, models }).slice(0, 300));
        const page = (await call('GET', `/sessions/${ids.first}/events?after=-1&types=assistant/message`)).body;
        check('GET /sessions/:id/events by type: the reply', page.events.length === 1 && page.events[0].text === `First reply ${MARK}` && page.more === false, json(page).slice(0, 300));
        const retry = (await call('POST', `/sessions/${ids.first}/prompt`, { text: `E2E:say First reply ${MARK}`, requestId: rid })).body;
        check('a retry with the same request id is not sent again: said so, and the log still has it once', retry.alreadySent === true && (await sentWith(ids.first, rid)).length === 1, json(retry));
        const other = await call('POST', `/sessions/${ids.first}/prompt`, { text: 'E2E:say Another text', requestId: rid });
        check('a retry with the same request id but another text: 409 request/conflict in words, with its state, and nothing sent', other.status === 409 && other.body?.error?.code === 'request/conflict' && other.body.state === 'answered'
            && /already went to session \S+ with another text \(it is answered\); it is not sent again\. Use a new request id/.test(other.body.error.message) && (await sentWith(ids.first, rid)).length === 1, other.text);
    });

    await step('a create retried with its request id: one session and one message, also when the retry overlaps the first', async () => {
        const rid = `e2e-create-${randomUUID().slice(0, 8)}`;
        const body = { workspacePath: run.ws, title: `${TITLE} once`, text: 'E2E:say Made once', requestId: rid };
        const before = (await run.bridge('GET', '/sessions')).length;
        const [a, b] = await Promise.all([call('POST', '/sessions', body), call('POST', '/sessions', body)]);
        check('both answered 200 with the same session; the second says it was already made and already sent', a.status === 200 && b.status === 200 && a.body.sessionId === b.body.sessionId
            && [a.body, b.body].filter((x) => x.alreadyCreated === true && x.prompt?.alreadySent === true).length === 1, json([a.body, b.body]));
        ids.once = a.body.sessionId;
        const done = (await call('GET', `/sessions/${ids.once}/requests/${rid}?wait=60`)).body;
        const third = await call('POST', '/sessions', body);
        check('a third try after it was answered: the same session, nothing sent', third.status === 200 && third.body.sessionId === ids.once && third.body.alreadyCreated === true && third.body.prompt?.alreadySent === true && third.body.prompt.state === 'answered', third.text);
        const after = (await run.bridge('GET', '/sessions')).length;
        const sent = await sentWith(ids.once, rid);
        check('DSH has one more session, not two, and its log has the message once, answered', done.state === 'answered' && done.reply?.text === 'Made once' && sent.length === 1 && after === before + 1, json({ done, sent: sent.length, before, after }));
        const record = join(ownDir, 'creates.jsonl');
        check('the record beside the socket is 600 and holds ids, never the text or the title', modeOf(record) === 0o600 && read(record).includes(rid) && !read(record).includes('Made once') && !read(record).includes(TITLE), read(record).slice(0, 300));
        const other = await call('POST', '/sessions', { ...body, workspacePath: run.root });
        check('the same request id for another folder: 409 in words, and nothing made', other.status === 409 && other.body?.error?.code === 'request/conflict' && other.body.sessionId === ids.once, other.text);
    });

    await step('steer into a running turn, and a followup after it: each read where it should be, and answered', async () => {
        ids.slow = (await run.bridge('POST', '/sessions', { workspacePath: run.ws, title: 'Steered', text: 'E2E:slow' })).sessionId;
        await waitFor(async () => (await run.session(ids.slow)).status === 'running' && model.held.size > 0, 'the slow turn to run', 30000, 200);
        const steerRid = `e2e-steer-${randomUUID().slice(0, 8)}`;
        const steer = await run.bridge('POST', `/sessions/${ids.slow}/prompt`, { text: 'E2E:say Steered in', mode: 'steer', requestId: steerRid });
        const follow = await run.bridge('POST', `/sessions/${ids.slow}/prompt`, { text: 'E2E:say After the turn', mode: 'followup' });
        check('both accepted, each with its mode and request id', steer.accepted && steer.mode === 'steer' && steer.requestId === steerRid && follow.accepted && follow.mode === 'followup', json([steer, follow]));
        const before = (await call('GET', `/sessions/${ids.slow}/requests/${follow.requestId}`)).body;
        check('the followup waits in DSH\'s queue for the next turn while this one runs', before.state === 'queued' && before.target === 'next-turn', json(before));
        model.release();
        const steered = (await call('GET', `/sessions/${ids.slow}/requests/${steerRid}?wait=60`)).body;
        const followed = (await call('GET', `/sessions/${ids.slow}/requests/${follow.requestId}?wait=60`)).body;
        check('the steered message was read into the running turn and answered by it', steered.state === 'answered' && steered.turn === 1 && steered.reply?.text === 'Steered in' && steered.end?.kind === 'completed', json(steered));
        check('the followup was read by the next turn and answered', followed.state === 'answered' && followed.turn === 2 && followed.reply?.text === 'After the turn', json(followed));
        const ends = await turnEnds(ids.slow);
        check('the session\'s log: two turns, both completed', ends.length === 2 && ends.every((e) => e.reason?.kind === 'completed'), json(ends));
        const idleRid = `e2e-idle-${randomUUID().slice(0, 8)}`;
        await run.bridge('POST', `/sessions/${ids.slow}/prompt`, { text: 'E2E:say Steered while idle', mode: 'steer', requestId: idleRid });
        const idle = (await call('GET', `/sessions/${ids.slow}/requests/${idleRid}?wait=60`)).body;
        check('a steer with no turn running starts a turn of its own, and is answered', idle.state === 'answered' && idle.turn === 3 && idle.reply?.text === 'Steered while idle' && (await turnEnds(ids.slow)).length === 3, json(idle));
    });

    await step('cancel a running turn; rename; a model; DSH\'s refusals come back in its words', async () => {
        const id = await run.newSession('E2E:slow', 'To cancel');
        await waitFor(async () => (await run.session(id)).status === 'running', 'the turn to run', 30000, 200);
        const cancelled = await run.bridge('POST', `/sessions/${id}/cancel`, {});
        const s = await waitFor(async () => {
            const x = await run.session(id);
            return x.status === 'idle' && x.turns.ended === 1 ? x : null;
        }, 'the turn to end', 30000, 200);
        check('POST cancel: DSH accepts, and the session\'s log ends the turn as aborted by the user', cancelled.accepted === true && s.turns.lastEnd?.kind === 'aborted' && (await turnEnds(id)).at(-1)?.reason?.reason?.kind === 'user', json(s.turns));
        check('the log has the cancel', read(logFile).includes(`cancel ${id}\n`));
        const idle = await call('POST', `/sessions/${id}/cancel`, {});
        check('cancel again, with no turn running: 409 session/not-running in words, and DSH is not asked (the log has one cancel)', idle.status === 409 && idle.body?.error?.code === 'session/not-running'
            && idle.body.error.message === `Session ${id} has no turn running, so there is nothing to cancel.` && read(logFile).split(`cancel ${id}\n`).length === 2 && (await turnEnds(id)).length === 1, idle.text);
        const renamed = await call('POST', `/sessions/${id}/rename`, { title: `${TITLE} renamed` });
        check('POST rename: the new title reads back, and the log has its length only', renamed.status === 200 && (await run.session(id)).title === `${TITLE} renamed` && read(logFile).includes(`rename ${id} chars=${TITLE.length + 8}\n`), renamed.text);
        const chosen = await call('POST', `/sessions/${id}/model`, { provider: 'fake', model: 'fake-model' });
        check('POST model: DSH takes a model it has', chosen.status === 200, chosen.text);
        const refused = await call('POST', `/sessions/${id}/model`, { provider: 'fake', model: 'no-such-model' });
        check('a model DSH does not have: 409, with DSH\'s code and words', refused.status === 409 && refused.body.error.code === 'session/model-unavailable' && /model/i.test(refused.body.error.message), refused.text);
        const partial = await call('POST', '/sessions', { workspacePath: run.ws, provider: 'fake', model: 'no-such-model', text: 'E2E:say never' });
        check('POST /sessions whose model step fails: the session\'s id and the failed step come back, and no prompt went', partial.status === 409 && /^session-/.test(partial.body.sessionId ?? '') && partial.body.failedStep === 'model'
            && (await run.events(partial.body.sessionId, 'user/message')).length === 0, partial.text);
    });

    await step('refusals in words: bad input never reaches DSH, and the bridge keeps answering', async () => {
        const r = {
            badJson: await call('POST', `/sessions/${ids.first}/prompt`, undefined, { raw: '{"text":' }),
            notObject: await call('POST', `/sessions/${ids.first}/prompt`, undefined, { raw: '"hello"' }),
            noText: await call('POST', `/sessions/${ids.first}/prompt`, { text: '   ' }),
            badMode: await call('POST', `/sessions/${ids.first}/prompt`, { text: 'x', mode: 'later' }),
            tooBig: await call('POST', `/sessions/${ids.first}/prompt`, { text: 'x'.repeat(70000) }),
            unknownSession: await call('POST', '/sessions/session-nope/prompt', { text: 'x' }),
            unknownGet: await call('GET', '/sessions/session-nope'),
            unknownPath: await call('GET', '/sessionz'),
            wrongMethod: await call('PUT', '/sessions'),
            relative: await call('POST', '/sessions', { workspacePath: 'some/folder' }),
            badAfter: await call('GET', `/sessions/${ids.first}/events?after=soon`),
            noRequest: await call('GET', `/sessions/${ids.first}/requests/never-sent`),
        };
        const want = { badJson: [400, 'bad-json'], notObject: [400, 'bad-json'], noText: [400, 'bad-request'], badMode: [400, 'bad-request'], tooBig: [413, 'too-large'], unknownSession: [404, 'session/not-found'], unknownGet: [404, 'session/not-found'], unknownPath: [404, 'not-found'], wrongMethod: [405, 'method'], relative: [400, 'bad-request'], badAfter: [400, 'bad-request'], noRequest: [404, 'request/not-found'] };
        const wrong = Object.entries(want).filter(([k, [status, code]]) => r[k].status !== status || r[k].body?.error?.code !== code || typeof r[k].body?.error?.message !== 'string' || r[k].body.error.message.length < 10);
        check('each refusal has its status, its code and a sentence', wrong.length === 0, json(wrong.map(([k]) => [k, r[k].status, r[k].text.slice(0, 160)])));
        check('the words say what to do: a full path; the two modes; the size limit', /full path/.test(r.relative.body?.error?.message) && /"followup".*"steer"/.test(r.badMode.body?.error?.message) && /65536 \(maxBodyBytes\)/.test(r.tooBig.body?.error?.message), json([r.relative.body, r.badMode.body, r.tooBig.body]).slice(0, 400));
        check('a wrong method names the right ones', r.wrongMethod.headers.allow === 'GET, POST', json(r.wrongMethod.headers));
        check('none of them reached the session\'s log', (await run.events(ids.first, 'user/message')).filter((e) => e.source?.kind === 'user').length === 1);
        check('the bridge still answers', await answers());
    });

    await step('waits: one for an event answers as DSH commits it; one with nothing new runs out and says so', async () => {
        const s = await run.session(ids.first);
        const t0 = Date.now();
        const empty = (await call('GET', `/sessions/${ids.first}/events?after=${s.lastSeq}&wait=2`)).body;
        const took = Date.now() - t0;
        check('a wait with nothing new runs out after its seconds: empty, timedOut', empty.timedOut === true && empty.events.length === 0 && took >= 1800 && took < 10000, json({ empty, took }));
        const waiting = call('GET', `/sessions/${ids.first}/events?after=${s.lastSeq}&types=turn/end&wait=60`);
        await sleep(300);
        const t1 = Date.now();
        await run.bridge('POST', `/sessions/${ids.first}/prompt`, { text: 'E2E:say Second' });
        const got = (await waiting).body;
        check('a wait for turn/end answers with that event as the turn ends, long before its deadline', got.timedOut === false && got.events.length === 1 && got.events[0].type === 'turn/end' && Date.now() - t1 < 30000, json(got));
    });

    // ── The window ────────────────────────────────────────────────────
    if (process.env.NO_WINDOW !== '1') {
        await step('the window: the bridged session in DSH\'s session list, and a prompt through the bridge showing live in the open chat', async () => {
            const pw = await findPlaywright();
            if (!pw) throw new Error('Playwright not found (NO_WINDOW=1 runs without the window)');
            window = await openWindow(run, pw, { width: 1280, height: 820 });
            const { page } = window;
            const row = page.getByText(TITLE, { exact: true }).first();
            await row.waitFor({ state: 'visible', timeout: 60000 });
            check('the session made through the bridge is in DSH\'s session list, by its title', await row.isVisible());
            // DSH's first-run notices (its Preview Notice) can come late, over the window: closed before a click or a picture.
            for (let i = 0; i < 4 && !(await row.click({ timeout: 5000 }).then(() => true, () => false)); i++) await dismissNotices(page);
            const first = await page.getByText(`First reply ${MARK}`, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false);
            check('opened, it shows the reply the bridge\'s prompt got', first);
            const live = `Live reply ${randomUUID().slice(0, 6)}`;
            await run.bridge('POST', `/sessions/${ids.first}/prompt`, { text: `E2E:say ${live}` });
            const shown = await page.getByText(live, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false);
            check('a prompt sent through the bridge shows in the open chat as it is answered, with no reload', shown);
            await dismissNotices(page);
            await page.mouse.move(700, 300);
            await shot(page, shots, 'bridged-session-light');
            await setDark(page, true);
            await shot(page, shots, 'bridged-session-dark');
            await page.setViewportSize({ width: 760, height: 820 });
            await sleep(500);
            await shot(page, shots, 'bridged-session-760-dark');
            await setDark(page, false);
            await shot(page, shots, 'bridged-session-760-light');
            check('the window raised no errors', window.errors.length === 0, json(window.errors.slice(0, 3)));
            await window.browser.close();
            window = undefined;
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-window');
        });
    }

    // ── Restart and crash ─────────────────────────────────────────────
    await step('a restart under a running turn: the old socket is replaced, the turn reads as interrupted, its prompt is sent again once', async () => {
        const rid = `e2e-restart-${randomUUID().slice(0, 8)}`;
        ids.restarted = (await run.bridge('POST', '/sessions', { workspacePath: run.ws, title: 'Restarted', text: 'E2E:slow', requestId: rid })).sessionId;
        await waitFor(async () => (await run.session(ids.restarted)).status === 'running', 'the slow turn to run', 30000, 200);
        await run.stop();
        // DSH saves a session's events about 200 ms after they happen: what reached the disk before it quit decides the path.
        const saved = savedWith(ids.restarted, rid).length;
        const left = existsSync(run.sock) && statSync(run.sock).isSocket() ? statSync(run.sock).ino : undefined;
        check('DSH quit: nobody answers on the socket', !(await answers()));
        await startKeepingSocket('restart under a running turn');
        check('started again, the bridge answers on its socket, mode 600', (await answers()) && modeOf(run.sock) === 0o600 && (left === undefined || statSync(run.sock).ino !== left), json({ left, now: statSync(run.sock).ino }));
        const s = await waitFor(async () => {
            const x = await run.session(ids.restarted);
            return x.turns.ended >= 1 ? x : null;
        }, 'the interrupted turn to be closed', 30000, 300);
        check('the turn that was running reads as interrupted', s.turns.lastEnd?.kind === 'interrupted' && s.turns.started === 1, json(s.turns));
        const state = (await call('GET', `/sessions/${ids.restarted}/requests/${rid}`)).body;
        const expected = saved ? 'unfinished' : 'dropped';
        check(`what became of its prompt matches the log on disk: ${expected} (${saved ? 'DSH saved it before it quit' : 'DSH quit before it saved it'}), with the turn's interrupted end`, state.state === expected && state.end?.kind === 'interrupted', json({ state, saved }));
        // The cut-off turn's "E2E:slow" may still be in the model's view, so the retry asks for a tool call, which the scripted model puts first.
        const retry = (await call('POST', `/sessions/${ids.restarted}/prompt`, { text: AGAIN, requestId: rid })).body;
        const answered = (await call('GET', `/sessions/${ids.restarted}/requests/${rid}?wait=60`)).body;
        check('a retry with its request id is sent (nothing is lost) and answered', retry.accepted === true && !retry.alreadySent && answered.state === 'answered' && answered.end?.kind === 'completed' && REPLIED.test(answered.reply?.text ?? ''), json({ retry, answered }));
        const again = (await call('POST', `/sessions/${ids.restarted}/prompt`, { text: AGAIN, requestId: rid })).body;
        check('once answered, the same id is not sent a third time', again.alreadySent === true && again.state === 'answered', json(again));
        check('the log has the message once per attempt: the first only if DSH saved it, then the one sent again', (await sentWith(ids.restarted, rid)).length === saved + 1, json(await sentWith(ids.restarted, rid)));
        check('the restart sent nothing by itself: the first prompt is in its session\'s log once', (await sentWith(ids.first, ids.firstRid)).length === 1);
        const cold = await call('POST', `/sessions/${ids.first}/cancel`, {});
        check('cancel on a session not open in DSH since the restart: 409, said in words', cold.status === 409 && cold.body?.error?.code === 'session/not-running' && /is not open in DSH, so no turn runs to cancel/.test(cold.body.error.message), cold.text);
    });

    await step('a restart after DSH saved the prompt and while its turn still ran: unfinished, then sent once more as a new attempt, answered, and on disk once each', async () => {
        const rid = `e2e-saved-${randomUUID().slice(0, 8)}`;
        ids.saved = (await run.bridge('POST', '/sessions', { workspacePath: run.ws, title: 'Saved then cut off', text: 'E2E:slow', requestId: rid })).sessionId;
        await waitFor(async () => (await run.session(ids.saved)).status === 'running', 'the slow turn to run', 30000, 200);
        await waitFor(() => savedWith(ids.saved, rid).length === 1, 'DSH to save the message on disk', 30000, 100);
        const taken = (await call('GET', `/sessions/${ids.saved}/requests/${rid}`)).body;
        check('before the restart: read by the running turn', taken.state === 'read' && taken.turn === 1, json(taken));
        await run.stop();
        await startKeepingSocket('restart after the message was saved');
        await waitFor(async () => (await run.session(ids.saved)).turns.ended >= 1, 'the interrupted turn to be closed', 30000, 300);
        const cut = (await call('GET', `/sessions/${ids.saved}/requests/${rid}?wait=30`)).body;
        check('after it: unfinished, the turn interrupted, and a wait ends on it at once', cut.state === 'unfinished' && cut.end?.kind === 'interrupted' && cut.timedOut === false && cut.seq === taken.seq, json(cut));
        const resent = (await call('POST', `/sessions/${ids.saved}/prompt`, { text: AGAIN, requestId: rid })).body;
        check('a retry with the same id is sent once more, as attempt 2', resent.accepted === true && !resent.alreadySent && resent.resent === true && resent.attempt === 2 && resent.requestId === rid, json(resent));
        const done = (await call('GET', `/sessions/${ids.saved}/requests/${rid}?wait=60`)).body;
        check('attempt 2 is answered by a turn of its own, completed', done.state === 'answered' && done.attempt === 2 && done.turn === 2 && done.end?.kind === 'completed' && REPLIED.test(done.reply?.text ?? ''), json(done));
        const third = (await call('POST', `/sessions/${ids.saved}/prompt`, { text: AGAIN, requestId: rid })).body;
        check('a third try sends nothing', third.alreadySent === true && third.state === 'answered' && third.attempt === 2, json(third));
        await waitFor(() => savedWith(ids.saved, rid).length === 2, 'both attempts on disk', 10000, 100).catch(() => {});
        const disk = savedWith(ids.saved, rid).map((e) => e.data.source.rpcId);
        check('the session\'s log on disk: the first attempt once and the second once, nothing more', json(disk) === json([rid, `${rid}~2`]), json(disk));
    });

    await step('a crash (SIGKILL to DSH\'s process group): the bridge comes back on the same socket', async () => {
        await run.crash();
        const left = existsSync(run.sock) ? statSync(run.sock).ino : undefined;
        check('after the crash the socket file is there and nobody answers', left !== undefined && !(await answers()));
        await startKeepingSocket('after a crash');
        check('started again, the bridge replaced the stale socket and answers', (await answers()) && statSync(run.sock).ino !== left);
        check('the log says it listened again at each start', (read(logFile).match(/ listening /g) ?? []).length >= 3, read(logFile).slice(-600));
    });

    // ── A turn DSH tears down ─────────────────────────────────────────
    await step('a turn DSH tears down under its prompt (the agent loop\'s row changed): unfinished, its cut-off reply marked, sent once more, answered, and on disk once each', async () => {
        const rid = `e2e-torn-${randomUUID().slice(0, 8)}`;
        ids.torn = (await run.bridge('POST', '/sessions', { workspacePath: run.ws, title: 'Torn down', text: 'E2E:slow', requestId: rid })).sessionId;
        await waitFor(async () => (await run.session(ids.torn)).status === 'running' && model.held.size > 0, 'the slow turn to run', 30000, 200);
        await waitFor(() => savedWith(ids.torn, rid).length === 1, 'DSH to save the message on disk', 30000, 100);
        const taken = (await call('GET', `/sessions/${ids.torn}/requests/${rid}`)).body;
        check('before: read by the running turn', taken.state === 'read' && taken.turn === 1, json(taken));
        // A declarative agent added to the agent loop's row: DSH loads the loop again and tears down the live agents
        // under their turns (the row stays from here on, so later saves do not load it again).
        run.rows = `- id: agent-loop\n  config:\n    agents:\n      - id: e2e-extra\n        cwd: ${json(run.ws)}\n`;
        writeRow();
        await waitFor(async () => (await run.session(ids.torn).catch(() => ({ turns: {} }))).turns.ended >= 1, 'the torn-down turn to end', 30000, 300);
        model.release();
        await waitFor(() => answers(), 'the bridge to answer', 30000, 300);
        await waitFor(() => run.savedEvents(ids.torn).some((e) => e.type === 'turn/end'), 'the turn\'s end on disk', 10000, 100).catch(() => {});
        // DSH loads its agent loop again after the teardown; a prompt that comes before it is back fails inside DSH
        // ("cannot create effect on inactive context": dropped, end error). A throwaway session answering shows it is back.
        await waitFor(async () => {
            const probe = await call('POST', '/sessions', { workspacePath: run.ws, title: 'Agent loop back', text: 'E2E:say back', requestId: `e2e-probe-${randomUUID().slice(0, 8)}` });
            if (probe.status !== 200) return false;
            const r = (await call('GET', `/sessions/${probe.body.sessionId}/requests/${probe.body.prompt.requestId}?wait=10`)).body;
            return r.state === 'answered' && r.reply?.text === 'back';
        }, 'DSH\'s agent loop to take turns again', 60000, 500);
        const ends = run.savedEvents(ids.torn).filter((e) => e.type === 'turn/end').map((e) => e.data?.reason);
        check('on disk, DSH ended the turn aborted, reason disposed: torn down, not stopped by anyone', ends.length === 1 && ends[0]?.kind === 'aborted' && ends[0]?.reason?.kind === 'disposed', json(ends));
        const cut = (await call('GET', `/sessions/${ids.torn}/requests/${rid}?wait=30`)).body;
        check('what became of it: unfinished (not answered), with that end, and a wait ends on it at once', cut.state === 'unfinished' && cut.end?.kind === 'aborted' && cut.end?.reason?.kind === 'disposed' && cut.timedOut === false && cut.seq === taken.seq, json(cut));
        check('the reply it was writing is marked interrupted, never given as the answer', cut.reply?.interrupted === true && cut.reply.text === 'Working', json(cut.reply));
        const page = (await call('GET', `/sessions/${ids.torn}/events?after=-1&types=assistant/message`)).body;
        const s = await run.session(ids.torn);
        check('the events page and the session\'s last reply mark it interrupted too', page.events.length === 1 && page.events[0].interrupted === true && s.lastAssistant?.interrupted === true, json({ page: page.events, last: s.lastAssistant }));
        const resent = (await call('POST', `/sessions/${ids.torn}/prompt`, { text: AGAIN, requestId: rid })).body;
        check('a retry with the same id is sent once more, as attempt 2', resent.accepted === true && !resent.alreadySent && resent.resent === true && resent.attempt === 2 && resent.requestId === rid, json(resent));
        const done = (await call('GET', `/sessions/${ids.torn}/requests/${rid}?wait=60`)).body;
        check('attempt 2 is answered by a turn of its own, completed, with a whole reply', done.state === 'answered' && done.attempt === 2 && done.turn === 2 && done.end?.kind === 'completed' && REPLIED.test(done.reply?.text ?? '') && done.reply.interrupted === undefined, json(done));
        const third = (await call('POST', `/sessions/${ids.torn}/prompt`, { text: AGAIN, requestId: rid })).body;
        check('a third try sends nothing', third.alreadySent === true && third.state === 'answered' && third.attempt === 2, json(third));
        await waitFor(() => savedWith(ids.torn, rid).length === 2, 'both attempts on disk', 10000, 100).catch(() => {});
        const disk = savedWith(ids.torn, rid).map((e) => e.data.source.rpcId);
        check('the session\'s log on disk: the first attempt once and the second once, nothing more', json(disk) === json([rid, `${rid}~2`]), json(disk));
    });

    // ── Settings while DSH runs ───────────────────────────────────────
    const newLog = join(run.root, 'logs', 'bridge-2.log');
    await step('settings while DSH runs: a new log file takes effect at once, on the same socket', async () => {
        writeRow({ logFile: newLog });
        await waitFor(() => / listening /.test(read(newLog)), 'the bridge to start again with the new log', 30000, 200);
        check('the bridge started again with the new log, which is 600, and answers', (await answers()) && modeOf(newLog) === 0o600);
        await run.bridge('POST', `/sessions/${ids.first}/rename`, { title: TITLE });
        check('actions now go to the new log', read(newLog).includes(`rename ${ids.first} chars=${TITLE.length}`));
    });

    await step('wrong settings: the bridge keeps working on its defaults and names each problem, in GET /health and its own log', async () => {
        writeRow({ logFile: newLog, maxBodyBytes: 'lots', socketpath: '/tmp/typo.sock' });
        const health = await waitFor(async () => {
            const h = (await call('GET', '/health', undefined, { timeout: 3000 }).catch(() => ({}))).body;
            return h?.problems?.length === 2 ? h : null;
        }, 'the problems in GET /health', 30000, 300);
        check('GET /health names both problems in words', /^maxBodyBytes must be a whole number of bytes from 1024 to 67108864, not "lots"; the bridge takes up to 1048576\.$/.test(health.problems[0])
            && /^socketpath is not a setting of the session bridge and is ignored/.test(health.problems[1]), json(health.problems));
        check('the bridge\'s log names them too', /setting: maxBodyBytes must be a whole number/.test(read(newLog)) && /setting: socketpath is not a setting/.test(read(newLog)));
        const big = await call('POST', `/sessions/${ids.first}/prompt`, { text: 'x'.repeat(70000), mode: 'nonsense' });
        check('the default limit is in force: a 70 kB body is read (and refused for its mode, not its size)', big.status === 400 && big.body?.error?.code === 'bad-request', big.text.slice(0, 200));
    });

    // DSH's logger keeps a plugin's lines in memory, not in its output, so this reads GET /health and the bridge's log;
    // that DSH's logger is told once is the unit test's.
    await step('a log that cannot be written: the bridge keeps working and says so in GET /health; once it can be written, the problem is gone', async () => {
        const blocked = join(run.root, 'blocked');
        writeFileSync(blocked, 'a file where the log\'s folder should be\n');
        const badLog = join(blocked, 'bridge.log');
        writeRow({ logFile: badLog });
        const health = await waitFor(async () => {
            const h = (await call('GET', '/health', undefined, { timeout: 3000 }).catch(() => ({}))).body;
            return h?.problems?.some((x) => x.startsWith(`logFile ${badLog} `)) ? h : null;
        }, 'the log\'s problem in GET /health', 30000, 300);
        check('GET /health says the log cannot be written, why in words, and what to do', health.problems.length === 1
            && health.problems[0].replace(/\((ENOTDIR|EEXIST): /, '(CODE: ') === `logFile ${badLog} cannot be written (CODE: a part of its path is a file, not a folder), so the bridge's actions are not logged. Give logFile a folder you can write to, or "" for no log.`, json(health.problems));
        for (let i = 0; i < 3; i++) await run.bridge('POST', `/sessions/${ids.first}/rename`, { title: TITLE });
        check('the bridge keeps working: its actions go through', (await run.session(ids.first)).title === TITLE);
        rmSync(blocked);
        mkdirSync(blocked);
        await run.bridge('POST', `/sessions/${ids.first}/rename`, { title: TITLE });
        check('once its folder is there, the next action goes in, mode 600, and GET /health has no problem', read(badLog).includes(`rename ${ids.first} chars=${TITLE.length}\n`) && modeOf(badLog) === 0o600
            && (await run.bridge('GET', '/health')).problems.length === 0, read(badLog));
        logs.push(badLog);
        writeRow({ logFile: newLog });
        await waitFor(async () => (await answers()) && (await run.bridge('GET', '/health')).problems.length === 0, 'the bridge on its own log again', 30000, 300);
    });

    await step('enabled: false (no longer a setting) while DSH runs: the start fails with the reason, so DSH shows it failed, never running; without it in the row (and off and on, if still failed), it runs again', async () => {
        const before = read(newLog).length;
        writeRow({ logFile: newLog, enabled: false });
        await waitFor(() => !existsSync(run.sock), 'the socket to go', 30000, 200);
        const failed = await waitFor(async () => ((await bridgeEntry())?.fiberPhase === 'failed' ? bridgeEntry() : null), 'the plugin to read as failed', 30000, 300).catch(() => bridgeEntry());
        check('nothing listens: no socket file, and nobody answers', !existsSync(run.sock) && !(await answers()));
        check('DSH shows the plugin as failed (its page in Plugins reads Problem), not running, its switch on', failed?.fiberPhase === 'failed' && failed.enabled === true, json({ ...failed, meta: undefined }));
        const added = read(newLog).slice(before);
        check('the bridge\'s log says why and what to do', /setting: enabled is no longer a setting of the session bridge, and while its row says enabled: false the bridge does not start\. To switch it off, use its switch in Plugins/.test(added)
            && added.includes(`not listening on ${run.sock}: its row says enabled: false, and enabled is no longer a setting. To switch it off, use its switch in Plugins (DSH then shows it Off); to have it listen, take enabled out of its row`), added);
        // The row without enabled is the row that last ran: DSH may start the plugin on it or leave it failed (seen both
        // ways), so, as the README and the problem say, it is switched off and on when it still reads failed.
        writeRow({ logFile: newLog });
        const saved = await waitFor(() => answers(), 'the bridge back on its own socket', 10000, 300).then(() => true, () => false);
        let toggled = false;
        if (!saved) {
            toggled = (await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-bridge', enabled: false })).ok === true
                && (await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-bridge', enabled: true })).ok === true;
            await waitFor(() => answers(), 'the bridge back after off and on', 30000, 300).catch(() => {});
        }
        console.log(`#   saving the row without enabled ${saved ? 'started it at once' : 'left it failed; off and on started it'}`);
        const entry = await waitFor(async () => ((await bridgeEntry())?.fiberPhase === 'active' ? bridgeEntry() : null), 'the plugin to run', 30000, 300).catch(() => bridgeEntry());
        check('enabled taken out of the row (then off and on, if DSH left it failed): it answers on its own socket, with no problems, and DSH shows it running', (saved || toggled) && (await answers()) && (await run.bridge('GET', '/health')).problems.length === 0 && entry?.fiberPhase === 'active',
            json({ startedBySavingTheRow: saved, switchedOffAndOn: toggled, phase: entry?.fiberPhase }));
    });

    await step('a socket another program answers on is never taken over: refused in words, failed in Plugins; still failed with the row that last ran; running again once switched off and on, and at once with a row that differs from the one that last ran; that program keeps its socket', async () => {
        const otherDir = mkdtempSync(join(base, 'o-'));
        const otherSock = join(otherDir, 'bridge.sock');
        const other = createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"other":true}');
        });
        await new Promise((r) => other.listen(otherSock, r));
        try {
            writeRow({ logFile: newLog, socketPath: otherSock });
            await waitFor(() => read(newLog).includes(`not listening on ${otherSock}: another program answers on ${otherSock}`), 'the refusal in the log', 30000, 300);
            const still = await call('GET', '/health', undefined, { sock: otherSock });
            check('the bridge refused it, in its log, and the other program still answers there', still.body?.other === true, still.text);
            const failed = await waitFor(async () => ((await bridgeEntry())?.fiberPhase === 'failed' ? bridgeEntry() : null), 'the plugin to read as failed', 30000, 300).catch(() => bridgeEntry());
            check('DSH shows the plugin as failed (its page in Plugins reads Problem), not running', failed?.fiberPhase === 'failed' && failed.enabled === true, json({ ...failed, meta: undefined }));
            // The row put back as it last ran (undoing the change that failed): DSH leaves the failed plugin as it is.
            const logged = read(newLog).length;
            writeRow({ logFile: newLog });
            const back = await waitFor(() => answers(), 'the bridge back on its own socket', 15000, 300).then(() => true, () => false);
            const added = read(newLog).slice(logged).trim();
            const entry = await bridgeEntry();
            check('the row put back as it last ran: DSH does not start the failed plugin again (nothing new in its log), so it stays failed, as the README says', !back && added === '' && entry?.fiberPhase === 'failed', json({ back, added, phase: entry?.fiberPhase }));
            const off = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-bridge', enabled: false });
            const on = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-bridge', enabled: true });
            await waitFor(() => answers(), 'the bridge back after off and on', 30000, 300).catch(() => {});
            const active = await waitFor(async () => ((await bridgeEntry())?.fiberPhase === 'active' ? bridgeEntry() : null), 'the plugin to run', 30000, 300).catch(() => bridgeEntry());
            check('switched off and on in Plugins: it answers on its own socket again, and DSH shows it running', off.ok === true && on.ok === true && (await answers()) && active?.fiberPhase === 'active', json({ off, on, phase: active?.fiberPhase }));
            // Refused once more; then a fixed row that differs from the row that last ran (its body limit too): DSH starts it at once.
            const refusedAt = read(newLog).length;
            writeRow({ logFile: newLog, socketPath: otherSock });
            await waitFor(async () => read(newLog).slice(refusedAt).includes(`not listening on ${otherSock}`) && (await bridgeEntry())?.fiberPhase === 'failed', 'the second refusal', 30000, 300);
            const differsAt = read(newLog).length;
            writeRow({ logFile: newLog, maxBodyBytes: 65537 });
            const again = await waitFor(() => answers(), 'the bridge back with the new row', 30000, 300).then(() => true, () => false);
            const running = await waitFor(async () => ((await bridgeEntry())?.fiberPhase === 'active' ? bridgeEntry() : null), 'the plugin to run', 30000, 300).catch(() => bridgeEntry());
            const otherStill = await call('GET', '/health', undefined, { sock: otherSock });
            check('refused again, then a fixed row that differs from the row that last ran: DSH starts it at once, it answers on its own socket, and DSH shows it running', again && running?.fiberPhase === 'active' && read(newLog).slice(differsAt).includes(`listening ${run.sock} pid=`), json({ again, phase: running?.fiberPhase }));
            check('the other program still answers on its socket, untouched', otherStill.body?.other === true, otherStill.text);
        } finally {
            await new Promise((r) => other.close(r));
        }
    });

    // ── Plugins ───────────────────────────────────────────────────────
    await step('the Plugins page presents it as DSH presents its own: a title, a plain sentence and an icon', async () => {
        const entry = await bridgeEntry();
        // DSH hands the meta on per language ({en: …}), from locale/en.json.
        const words = (v) => (typeof v === 'string' ? v : v?.en);
        check('its title and sentence, not the package id', words(entry?.meta?.title) === 'Session Bridge' && /^Lets scripts and scheduled jobs/.test(words(entry?.meta?.description) ?? ''), json({ ...entry?.meta, icon: undefined }));
        check('its icon is its own SVG', /svg/.test(json(entry?.meta?.icon ?? '')), json(entry?.meta?.icon ?? null).slice(0, 200));
    });

    await step('switched off in Plugins: no socket left, the same TCP ports; on again, it answers', async () => {
        const tcpOn = tcpListeners();
        const off = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-bridge', enabled: false });
        await waitFor(() => !existsSync(run.sock), 'the socket to go', 30000, 200);
        check('off from Plugins: DSH applies it, and the socket file is gone', off.ok === true && off.value?.application === 'applied' && !existsSync(run.sock), json(off));
        const tcpOff = tcpListeners();
        check('DSH listens on the same TCP ports with the bridge off as on: only its window\'s', Array.isArray(tcpOn) && json(tcpOn) === json(tcpOff) && tcpOn.every((a) => a.endsWith(`:${windowPort()}`)), json({ tcpOn, tcpOff }));
        const on = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-bridge', enabled: true });
        await waitFor(() => answers(), 'the bridge back on', 30000, 300);
        check('on again from Plugins: DSH applies it, and the bridge answers', on.ok === true && on.value?.application === 'applied' && (await answers()), json(on));
    });

    const text = [logFile, newLog, ...logs].map(read).join('');
    check('the logs never held a prompt\'s text or a title', !text.includes(MARK) && !text.includes(TITLE) && !text.includes('Steered in') && !text.includes('E2E:') && !text.includes('Another text'), 'found in the log');
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
    console.log(run.logText().slice(-3000));
} finally {
    if (window) await window.browser.close().catch(() => {});
    await run.stop();
    await model.close();
    run.cleanup();
    if (ownBase && process.env.KEEP !== '1') rmSync(base, { recursive: true, force: true });
}

console.log(`\n# ${tally.passed} passed, ${tally.failed} failed`);
if (tally.failed) console.log(`# failed: ${tally.failures.join('; ')}`);
process.exit(tally.failed ? 1 : 0);
