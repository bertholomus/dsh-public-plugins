#!/usr/bin/env node
/**
 * Session Watch in a real DSH: its fold of every session's events, its
 * service as the suite's plugins call it, its window endpoints, its record
 * of running turns across a quit and a crash, its setting in Plugins, and
 * switching it off and on.
 *
 * DSH runs from a throwaway DSH_HOME (test/e2e/harness.mjs) with the
 * session bridge, Session Watch and a stand-in user of its service
 * (test/e2e/probe: it calls `sessionWatch` as Autopilot, Decisions and
 * Agent Terminals do, and serves what it gets to this test), a scripted
 * model (test/e2e/fake-model.mjs), and new sessions on Workspace Write, so
 * writing outside the workspace asks for approval. The message wait
 * (`deliveryTimeoutSeconds`) is 15 seconds here.
 *
 * - Served: the browser half parses; `status`, `sessions` and `wait`
 *   answer; `wait` answers at once when the window is behind and holds
 *   until its time when it is not.
 * - The fold, from DSH's own events: a todo list, a decision line with its
 *   pick, a goal that completes, a tool waiting for approval and a question
 *   waiting in DSH's question box (each with its state word, cleared when
 *   answered); listeners hear turn starts, states and turn ends in order;
 *   the window's view leaves the reply text out, and `fullState` has it.
 * - Delivery with proof: a message is queued, then delivered, and the
 *   session's own log (read through DSH) shows it inside the turn the
 *   delivery names; a steer goes into the running turn; a session that
 *   does not exist is refused in words; a message no turn reads in time is
 *   reported not delivered and taken back out of the queue, so the next
 *   turn never reads it.
 * - Cut off by a stop: DSH quit (SIGTERM) and crashed (SIGKILL to its
 *   process group) under running turns; the record of running turns names
 *   them; after each start `cutOffSessions` finds them (checked against
 *   their logs) and not the sessions that finished; a carry-on message to
 *   the cut-off session (not loaded) is delivered into a new turn.
 * - Sessions not loaded keep their state from DSH's saved values.
 * - Questions for a person: raised, answered once (the asker's handler gets
 *   the answer), refused a second time in words, and an answer's outcome told.
 * - An outside agent's state shows on its session's row, and goes.
 * - Its folder is 700, running.json and its journal (deliveries.jsonl) 600.
 * - A number in quotes in the profile (#32): Session Watch starts, works
 *   with its default, and `status` names the setting and the value. In the
 *   window, its page in Plugins flags the value as the form opens, says the
 *   quotes are what is wrong, and saving the number fixes it; a value out
 *   of range cannot be saved. Pictures light, dark and at 760 px.
 * - Switched off in Plugins: DSH reports no failure, its endpoints and its
 *   service go, its style sheet goes; on again, it serves at once.
 *
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node plugins/session-watch/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/; `node scripts/e2e.mjs
 * session-watch` runs it on each of those and on the installed app's own
 * DSH. SHOTS=<folder> keeps the window's pictures there (default
 * .e2e/shots/session-watch/<version>); KEEP=1 keeps the throwaway DSH_HOME.
 * Without Playwright the run fails, unless NO_WINDOW=1 says to run without
 * the window checks (the summary then says they were skipped).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { DshRun, checks, dshBin, findPlaywright, modeOf, openWindow, pluginsDir, repoRoot, setDark, shot, sleep, waitFor } from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from '../../../../test/e2e/fake-model.mjs';

const bin = dshBin();
if (!bin) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'session-watch', version);
console.log(`# DSH ${version}: ${bin}`);
console.log(`# pictures: ${shots}`);

const WAIT_SECONDS = 15;
/** How many sessions a chosen state lists at first, and how many more each "Show more" adds (lib/client.js). */
const SHOWN = 12;
const tally = checks();
const { check, step } = tally;
const model = await startFakeModel();
const rowsWith = ({ timeout = WAIT_SECONDS } = {}) => `- id: permission
  config:
    defaultPreset: workspace-write
- id: session-watch
  config:
    deliveryTimeoutSeconds: ${JSON.stringify(timeout)}
`;
const run = new DshRun({
    label: 'session-watch',
    bin,
    plugins: {
        'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge'),
        'dsh-plugin-session-watch': join(pluginsDir, 'session-watch'),
        'dsh-plugin-session-watch-probe': join(pluginsDir, 'session-watch', 'test', 'e2e', 'probe'),
    },
    rows: rowsWith(),
});
const outside = join(run.root, 'outside');
mkdirSync(outside, { recursive: true });

/** Start DSH again with other rows. */
async function restartWith(rows, what) {
    await run.stop();
    run.rows = rows;
    run.writeProfile(model.port);
    await run.boot(what);
}

/** Session Watch's own window endpoints, and the stand-in user's (its service, called in DSH). */
const watchApi = (method, args = {}) => run.api(`dsh-plugin-session-watch/${method}`, args);
const probeApi = async (method, args = {}) => {
    const r = await run.api(`dsh-plugin-session-watch-probe/${method}`, args);
    if (!r.ok) throw new Error(`probe ${method}: ${JSON.stringify(r.error)}`);
    return r.value;
};
const probeReady = () => waitFor(async () => (await run.api('dsh-plugin-session-watch-probe/ready')).value?.ready === true, 'the stand-in user to have the watcher', 30000, 200);
/** One session's row as the window's `sessions` endpoint gives it. */
const windowRow = async (sessionId) => {
    const r = await watchApi('sessions');
    if (!r.ok) throw new Error(`sessions: ${JSON.stringify(r.error)}`);
    return r.value.items.find((row) => row.sessionId === sessionId);
};
const call = (tool, args) => `E2E:call ${tool} ${JSON.stringify(args)}`;
const todos = (...items) => JSON.stringify(items.map(([content, status]) => ({ content, status })));
const idleSession = (sessionId) => waitFor(async () => {
    const s = await run.session(sessionId);
    return s.status !== 'running' && s.turns.started > 0 && s.turns.started === s.turns.ended ? s : null;
}, `${sessionId} to finish its turn`, 30000);
const runningSession = (sessionId) => waitFor(async () => (await run.session(sessionId)).status === 'running', `${sessionId} to run`, 30000);
/** Wait until the session's row (from the probe: the service's `get`) passes `test`. */
const rowWhen = (sessionId, test, what, timeout = 20000) => {
    let last;
    return waitFor(async () => {
        last = await probeApi('row', { sessionId });
        return test(last) ? last : null;
    }, `${sessionId}: ${what}`, timeout, 250).catch((error) => {
        throw new Error(`${error.message}; last row ${JSON.stringify(last)}`);
    });
};
/** A delivery from the probe once settled (delivered or failed). */
const settled = (id, timeout = 30000) => waitFor(async () => {
    const d = await probeApi('delivery', { id });
    return d && (d.state === 'delivered' || d.state === 'failed') ? d : null;
}, `delivery ${id} to settle`, timeout, 250);
/** Where `id`'s user/message sits in the log: its turn (the turn/start before it with no turn/end between), or undefined. */
function turnOf(log, id) {
    const at = log.findIndex((e) => e.type === 'user/message' && e.data?.id === id);
    if (at < 0) return undefined;
    const before = log.slice(0, at);
    const start = before.findLast((e) => e.type === 'turn/start');
    const end = before.findLast((e) => e.type === 'turn/end');
    if (!start || (end && end.seq > start.seq)) return undefined;
    return start.data?.turn;
}

/** What became of message `id` in the session's queue, from the log's own splices: 'queued', 'canceled', 'claimed' or undefined. */
function queueFate(log, id) {
    const lists = { 'next-turn': [], 'next-step': [] };
    let fate;
    for (const e of log) {
        if (e.type !== 'agent/inbox/spliced' || !lists[e.data?.target]) continue;
        const { target, start, removedCount = 0, inserted = [], outcome } = e.data;
        const removed = lists[target].splice(start, removedCount, ...inserted.map((m) => m.id));
        if (removed.includes(id)) fate = outcome === 'canceled' ? 'canceled' : 'claimed';
        if (inserted.some((m) => m.id === id)) fate = 'queued';
    }
    return fate;
}

const ids = {};
let window;
let pw = null;
try {
    pw = await findPlaywright();
    if (!pw && process.env.NO_WINDOW !== '1') throw new Error('Playwright is not installed (set NO_WINDOW=1 to run without the window checks)');
    run.writeProfile(model.port);
    await run.boot('first start');
    await probeReady();

    // ── Served ─────────────────────────────────────────────────────────
    await step('served: the browser half parses, and its window endpoints answer', async () => {
        const client = await run.clientOf('dsh-plugin-session-watch');
        let parsed = false;
        try {
            new Script(client.text);
            parsed = true;
        } catch {}
        check('DSH serves Session Watch\'s browser half, and it parses', client.status === 200 && parsed, `status ${client.status}`);
        const status = await watchApi('status');
        check('status: running, with no setting to fix', status.ok && status.value.running === true && !status.value.problem, JSON.stringify(status));
        const sessions = await watchApi('sessions');
        check('sessions: a list (empty in a new home)', sessions.ok && Array.isArray(sessions.value.items), JSON.stringify(sessions).slice(0, 300));
        const first = await watchApi('wait', { timeoutMs: 1000 });
        check('wait: a window with nothing seen gets the change numbers at once', first.ok && typeof first.value?.epoch === 'string' && typeof first.value?.versions === 'object', JSON.stringify(first));
        const t0 = Date.now();
        const held = await watchApi('wait', { since: first.value, timeoutMs: 800 });
        const took = Date.now() - t0;
        check('wait: a window that is up to date is held until something moves or its time is up', held.ok && took >= 700 && took < 10000, `${took} ms`);
    });

    // ── The fold ───────────────────────────────────────────────────────
    const prompts = await run.prompts();
    let since = (await probeApi('events', { since: 0 })).next;
    ids.todos = await run.newSession(`E2E:todos ${todos(['Read the brief', 'completed'], ['Write the code', 'in_progress'], ['Test it', 'pending'])}`, 'Todo list');
    ids.decision = await run.newSession('E2E:say Everything is ready for the release.\\nDECISION NEEDED: Ship the release today? — recommend: yes, after the smoke test', 'Release call');
    ids.goal = await run.newSession('E2E:goal Write three lines about rivers', 'River goal');
    await idleSession(ids.todos);
    await idleSession(ids.decision);
    await step('the fold: a todo list, a decision line and a goal, from DSH\'s own events', async () => {
        const row = await rowWhen(ids.todos, (r) => r.state?.todos?.total === 3, 'its todos');
        check('a todo list in counts, with the item to work on next', JSON.stringify(row.state.todos) === JSON.stringify({ open: 2, active: 1, done: 1, total: 3, next: 'Write the code' }), JSON.stringify(row.state.todos));
        check('its last turn ended, finished: the row reads idle, its title is DSH\'s', row.state.end?.kind === 'completed' && row.state.open === false && row.status === 'idle' && row.word === 'idle' && row.title === 'Todo list', JSON.stringify({ end: row.state.end, status: row.status, word: row.word, title: row.title }));
        const heard = (await probeApi('events', { since })).items.filter((e) => e.sessionId === ids.todos);
        const order = heard.map((e) => (e.type === 'state' ? `state:${e.change}` : e.type)).filter((t) => ['turn-start', 'state:todo/write', 'turn-end'].includes(t));
        check('listeners hear the turn start, the todo list and the turn end, in order', JSON.stringify(order) === JSON.stringify(['turn-start', 'state:todo/write', 'turn-end']), JSON.stringify(heard.map((e) => e.type + (e.change ? `:${e.change}` : ''))));
        check('the turn end names how it ended', heard.find((e) => e.type === 'turn-end')?.end?.kind === 'completed', JSON.stringify(heard.find((e) => e.type === 'turn-end')));
        const decision = await rowWhen(ids.decision, (r) => r.state?.ask, 'its ask');
        check('a DECISION NEEDED line: the question and the pick, with its turn', decision.state.ask.kind === 'decision' && decision.state.ask.question === 'Ship the release today?' && decision.state.ask.recommendation === 'yes, after the smoke test' && decision.state.ask.turn === 1, JSON.stringify(decision.state.ask));
        const view = await windowRow(ids.decision);
        check('the window\'s view of a session leaves the reply text out', view && view.state.ask?.question === 'Ship the release today?' && view.state.text === undefined && view.word === 'idle', JSON.stringify(view).slice(0, 400));
        const full = await probeApi('full', { sessionId: ids.decision });
        check('fullState has the reply text, for the plugins that read it', typeof full?.text === 'string' && full.text.includes('DECISION NEEDED: Ship the release today?'), JSON.stringify(full).slice(0, 300));
        const goal = await rowWhen(ids.goal, (r) => r.state?.goal && r.state.goal.phase !== 'active' && r.status !== 'running', 'its goal to finish', 40000);
        check('a goal: its objective, its phase when it completes, and its rounds', goal.state.goal.objective === 'Write three lines about rivers' && goal.state.goal.phase === 'complete' && goal.state.goal.rounds >= 1, JSON.stringify(goal.state.goal));
    });

    const sinceAsk = (await probeApi('events', { since: 0 })).next;
    ids.approval = await run.newSession(call('write', { file_path: join(outside, 'draft.txt'), content: 'The draft.', sandbox_permissions: 'danger-full-access', justification: 'It saves the draft next to the workspace.' }), 'Draft upload');
    ids.question = await run.newSession(call('ask_user_question', {
        questions: [{ id: 'env', question: 'Which environment should I deploy to?', header: 'Target', options: [{ label: 'staging' }, { label: 'production' }] }],
        timeout: -1,
    }), 'Deploy target');
    await step('the fold: a tool waiting for approval and a question in DSH\'s question box, each with its word, and cleared when answered', async () => {
        const approval = await rowWhen(ids.approval, (r) => r.word === 'waiting for approval', 'waiting for approval');
        check('a tool waiting for approval: the row says so, and names the tool', approval.status === 'running' && approval.state.approvals?.length === 1 && approval.state.approvals[0].tool === 'write', JSON.stringify(approval.state.approvals));
        const question = await rowWhen(ids.question, (r) => r.word === 'waiting for your answer', 'waiting for an answer');
        check('a question in DSH\'s question box: the row says so, with the question', question.state.asking?.question === 'Which environment should I deploy to?', JSON.stringify(question.state.asking));
        const prompt = await waitFor(() => prompts.find('approval/request', (r) => /the draft next to the workspace/.test(r.reason ?? '')), 'the window\'s prompt for the draft', 30000, 200);
        await prompts.answer(prompt, 'rejected');
        const after = await rowWhen(ids.approval, (r) => !r.state.approvals && r.status !== 'running', 'the approval answered', 30000);
        check('answered (rejected), the approval is cleared and the turn ends', !after.state.approvals && after.state.end !== undefined, JSON.stringify({ approvals: after.state.approvals, end: after.state.end }));
        check('the rejected tool never ran: no file was written', !existsSync(join(outside, 'draft.txt')));
        const ask = await waitFor(() => prompts.find('user-questions/request', (r) => JSON.stringify(r).includes('Which environment')), 'the window\'s prompt for the question', 30000, 200);
        await prompts.answer(ask, { answers: [{ id: 'env', selected: ['staging'] }] });
        const answered = await rowWhen(ids.question, (r) => !r.state.asking, 'the question answered', 30000).catch(() => null);
        check('answered, the question is cleared', answered && !answered.state.asking, JSON.stringify(answered?.state?.asking ?? answered));
        // Pushed, not polled: listeners (and through them the windows) hear the question box ask and get its answer.
        const pushed = await waitFor(async () => {
            const heard = (await probeApi('events', { since: sinceAsk })).items.filter((e) => e.sessionId === ids.question && e.type === 'state' && ['tool/call', 'tool/result'].includes(e.change));
            return heard.some((e) => e.change === 'tool/result') ? heard : null;
        }, 'the question box to be heard', 10000, 200).catch(() => []);
        check('listeners hear the question box ask, as a state change with the question, and hear its answer',
            JSON.stringify(pushed.map((e) => [e.change, e.asking])) === JSON.stringify([['tool/call', 'Which environment should I deploy to?'], ['tool/result', null]]), JSON.stringify(pushed));
    });

    // ── Delivery with proof ────────────────────────────────────────────
    await step('delivery: queued, then delivered, and the session\'s own log shows it inside the turn it names', async () => {
        since = (await probeApi('events', { since: 0 })).next;
        const first = await probeApi('deliver', { sessionId: ids.todos, text: 'Probe note: carry on with the tests.' });
        check('deliver returns as soon as the session\'s queue shows it (or a turn already read it)', first.state === 'queued' || first.state === 'delivered', JSON.stringify(first));
        const done = await settled(first.id);
        check('then delivered, naming the turn that read it', done.state === 'delivered' && Number.isSafeInteger(done.turn) && done.turn >= 2, JSON.stringify(done));
        const log = await probeApi('log', { sessionId: ids.todos });
        const spliced = log.findIndex((e) => e.type === 'agent/inbox/spliced' && (e.data?.inserted ?? []).some((m) => m.id === first.id));
        const read = log.findIndex((e) => e.type === 'user/message' && e.data?.id === first.id);
        check('the session\'s log has it in the queue first, then read in', spliced >= 0 && read > spliced, `spliced at ${spliced}, read at ${read}`);
        check('the message sits inside the very turn the delivery names', turnOf(log, first.id) === done.turn, `turn ${turnOf(log, first.id)} vs ${done.turn}`);
        const states = (await probeApi('events', { since })).items.filter((e) => e.type === 'delivery' && e.delivery?.id === first.id).map((e) => e.delivery.state);
        check('listeners hear queued, then delivered', JSON.stringify(states) === JSON.stringify(['queued', 'delivered']) || JSON.stringify(states) === JSON.stringify(['delivered']), JSON.stringify(states));
        check('the message is marked as a plugin\'s, not the person\'s', log[read]?.data?.source?.kind === 'cordis-host-runner', JSON.stringify(log[read]?.data?.source));
    });
    await step('delivery: a steer goes into the running turn; a session that does not exist is refused in words', async () => {
        ids.steer = await run.newSession('E2E:slow', 'Long run');
        await runningSession(ids.steer);
        await waitFor(() => model.held.size === 1, 'the long turn\'s reply to be held open', 20000, 100);
        const steer = await probeApi('deliver', { sessionId: ids.steer, text: 'Probe steer: also check the docs.', mode: 'steer' });
        model.release();
        const done = await settled(steer.id);
        const log = await probeApi('log', { sessionId: ids.steer });
        check('a steer is read into the turn that was running (turn 1), and its log proves it', done.state === 'delivered' && done.turn === 1 && turnOf(log, steer.id) === 1, JSON.stringify(done));
        const missing = await probeApi('deliver', { sessionId: 'no-such-session', text: 'Hello?' });
        check('a session that does not exist: not delivered, and why', missing.state === 'failed' && /^the session could not be opened: /.test(missing.reason ?? ''), JSON.stringify(missing));
    });
    await step(`delivery: a message no turn reads within ${WAIT_SECONDS} seconds is reported not delivered, and taken back out of the queue`, async () => {
        ids.late = await run.newSession('E2E:slow', 'Held turn');
        await runningSession(ids.late);
        const late = await probeApi('deliver', { sessionId: ids.late, text: 'Probe late note: this one must never be read.' });
        check('queued behind the running turn', late.state === 'queued', JSON.stringify(late));
        const done = await settled(late.id, (WAIT_SECONDS + 15) * 1000);
        check('past the wait: not delivered, and the reason says it was taken back', done.state === 'failed' && done.reason === `no turn read it within ${WAIT_SECONDS} seconds, so Session Watch took it back out of the session's queue`, JSON.stringify(done));
        model.release();
        await idleSession(ids.late);
        await sleep(1500);
        const log = await probeApi('log', { sessionId: ids.late });
        const removedAt = log.findIndex((e) => e.type === 'agent/inbox/spliced' && e.data?.removedCount === 1);
        check('the session\'s log records it taken out of the queue', removedAt >= 0, JSON.stringify(log.filter((e) => e.type === 'agent/inbox/spliced').map((e) => e.data)).slice(0, 600));
        check('and no turn ever read it: the claim "not delivered" holds', !log.some((e) => e.type === 'user/message' && e.data?.id === late.id));
    });

    // ── Cut off by a stop ──────────────────────────────────────────────
    ids.quit = await run.newSession('E2E:slow', 'Long migration');
    await runningSession(ids.quit);
    await step('the record of running turns names the turn running now', async () => {
        const file = join(run.home, 'session-watch', 'running.json');
        const named = await waitFor(() => {
            try {
                return Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')).sessions ?? {}, ids.quit);
            } catch {
                return false;
            }
        }, 'running.json to name the running turn', 10000, 200).catch(() => false);
        check('running.json names the session whose turn runs', named);
    });
    // A message on its way when DSH stops: queued behind the running turn.
    const noteQ = await probeApi('deliver', { sessionId: ids.quit, text: 'Probe note Q: sent while the migration ran.', from: 'probe' });
    check('a message sent while the turn runs waits in its queue', noteQ.state === 'queued' && noteQ.from === 'probe', JSON.stringify(noteQ));
    await run.stop();
    check('DSH quits (SIGTERM) under a running turn', !run.alive());
    prompts.close();
    await run.boot('after a quit');
    await probeReady();
    const cutAfterQuit = {};
    {
        cutAfterQuit.found = await probeApi('cutOff', { withinMs: 0 });
        cutAfterQuit.mine = cutAfterQuit.found.find((f) => f.sessionId === ids.quit);
        cutAfterQuit.row = await windowRow(ids.quit);
    }
    // DSH may take what is queued out of the queue as it quits (0.2's agents do when they close), or leave it queued:
    // the watcher must tell whichever the session's log shows.
    const letGo = queueFate(await probeApi('log', { sessionId: ids.quit }), noteQ.id) === 'canceled';
    if (letGo) await step('after a quit: DSH let the message on its way go unread as it quit (its log says so); the watcher told so, kept the record, and the carry-on goes alone', async () => {
        const told = await probeApi('deliveryOf', { id: noteQ.id });
        check('after the start, its record says not delivered, and why, as the log has it', told?.state === 'failed' && told.reason === 'the session let the message go without reading it' && told.from === 'probe', JSON.stringify(told));
        check('cutOffSessions names nothing as still waiting', cutAfterQuit.mine && !cutAfterQuit.mine.queued, JSON.stringify(cutAfterQuit.mine?.queued));
        ids.carryQ = await probeApi('deliver', { sessionId: ids.quit, text: 'Probe carry-on: DSH stopped while you were working; carry on.' });
        const done = await settled(ids.carryQ.id);
        const log = await probeApi('log', { sessionId: ids.quit });
        check('the carry-on goes into a new turn of its own, and the message DSH let go is never read', done.state === 'delivered' && done.mode === 'queue' && !done.waiting && turnOf(log, ids.carryQ.id) === done.turn && !log.some((e) => e.type === 'user/message' && e.data?.id === noteQ.id), JSON.stringify(done));
    });
    else await step('after a quit: the message on its way is followed again, named as waiting, and read with the carry-on, which goes first', async () => {
        const followed = await waitFor(async () => {
            const d = await probeApi('deliveryOf', { id: noteQ.id });
            return d?.restored === true && d.state === 'queued' ? d : null;
        }, 'the message to be followed again', 20000, 250).catch(async () => probeApi('deliveryOf', { id: noteQ.id }));
        check('after the start, the message sent before the quit is followed again: still queued, from its record', followed?.state === 'queued' && followed.restored === true && followed.from === 'probe', JSON.stringify(followed));
        const found = await probeApi('cutOff', { withinMs: 0 });
        const mine = found.find((f) => f.sessionId === ids.quit);
        check('cutOffSessions names it as still waiting in the cut-off session\'s queue, with its sender and first words',
            mine?.queued?.length === 1 && mine.queued[0].id === noteQ.id && mine.queued[0].from === 'probe' && mine.queued[0].preview === 'Probe note Q: sent while the migration ran.', JSON.stringify(mine?.queued));
        ids.carryQ = await probeApi('deliver', { sessionId: ids.quit, text: 'Probe carry-on: DSH stopped while you were working; carry on.' });
        const done = await settled(ids.carryQ.id);
        const q = await waitFor(async () => {
            const d = await probeApi('deliveryOf', { id: noteQ.id });
            return d?.state === 'delivered' || d?.state === 'failed' ? d : null;
        }, 'the message from before the quit to settle', 20000, 250).catch(() => null);
        const log = await probeApi('log', { sessionId: ids.quit });
        const turn = turnOf(log, ids.carryQ.id);
        const inTurn = log.filter((e) => e.type === 'user/message' && turnOf(log, e.data?.id) === turn).map((e) => e.data.id).filter((id) => id === ids.carryQ.id || id === noteQ.id);
        check('the carry-on (sent as Autopilot sends one) goes ahead of it, into the turn it starts', done.state === 'delivered' && done.mode === 'steer' && done.waiting === 1 && done.turn === turn, JSON.stringify(done));
        check('both are read in that one turn, the carry-on first: neither waits behind the other', q?.state === 'delivered' && q.turn === turn && JSON.stringify(inTurn) === JSON.stringify([ids.carryQ.id, noteQ.id]), JSON.stringify({ q, inTurn }));
        check('neither was taken back out of the queue', !log.some((e) => e.type === 'agent/inbox/spliced' && e.data?.outcome === 'canceled'), JSON.stringify(log.filter((e) => e.type === 'agent/inbox/spliced').map((e) => e.data)).slice(0, 400));
        const heard = (await probeApi('events', { since: 0 })).items.filter((e) => e.type === 'delivery' && e.delivery?.id === noteQ.id).map((e) => `${e.delivery.state}${e.delivery.restored ? ' (again)' : ''}`);
        check('listeners hear it followed again and then delivered', heard.includes('delivered (again)'), JSON.stringify(heard));
    });
    await step('after a quit: cutOffSessions found the cut-off session (checked against its log) and not the ones that finished', async () => {
        check('the session DSH quit under was found, with how its turn ended', Boolean(cutAfterQuit.mine) && typeof cutAfterQuit.mine.end?.kind === 'string' && cutAfterQuit.mine.title === 'Long migration', JSON.stringify(cutAfterQuit.found));
        check('sessions that finished their turns are not', !cutAfterQuit.found.some((f) => [ids.todos, ids.decision, ids.steer].includes(f.sessionId)), JSON.stringify(cutAfterQuit.found.map((f) => f.title)));
        check('its row read cut off, and it was not loaded', cutAfterQuit.row?.word === 'cut off' && cutAfterQuit.row.status === 'cold', JSON.stringify({ word: cutAfterQuit.row?.word, status: cutAfterQuit.row?.status }));
        const done = await settled(ids.carryQ.id);
        const log = await probeApi('log', { sessionId: ids.quit });
        check('the carry-on message to it (not loaded) loaded it and was delivered into a new turn, as its log shows', done.state === 'delivered' && done.turn >= 2 && turnOf(log, ids.carryQ.id) === done.turn, JSON.stringify(done));
    });
    await step('sessions not loaded keep their state from DSH\'s saved values', async () => {
        const row = await windowRow(ids.todos);
        check('a session not loaded since the start: status cold, its todos and its last turn still known', row?.status === 'cold' && row.state?.todos?.total === 3 && row.state?.end?.kind === 'completed', JSON.stringify({ status: row?.status, todos: row?.state?.todos, end: row?.state?.end }));
        const full = await probeApi('full', { sessionId: ids.decision });
        check('its reply text, which the saved value leaves out, is folded from its log', typeof full?.text === 'string' && full.text.includes('DECISION NEEDED'), JSON.stringify(full).slice(0, 200));
    });
    model.release();
    // The carry-on turn ends first, so the crash cuts off only the turn started for it.
    const carriedOn = await waitFor(async () => {
        if ((await run.session(ids.quit).catch(() => null))?.status === 'running') return false;
        try {
            return !Object.hasOwn(JSON.parse(readFileSync(join(run.home, 'session-watch', 'running.json'), 'utf8')).sessions ?? {}, ids.quit);
        } catch {
            return false;
        }
    }, 'the carry-on turn to end before the crash', 30000, 200).then(() => true, () => false);
    ids.crash = await run.newSession('E2E:slow', 'Long import');
    await runningSession(ids.crash);
    await waitFor(() => {
        try {
            return Object.hasOwn(JSON.parse(readFileSync(join(run.home, 'session-watch', 'running.json'), 'utf8')).sessions ?? {}, ids.crash);
        } catch {
            return false;
        }
    }, 'running.json to name the turn before the crash', 10000, 200).catch(() => {});
    const noteK = await probeApi('deliver', { sessionId: ids.crash, text: 'Probe note K: sent while the import ran.', from: 'probe' });
    check('a message sent while that turn runs waits in its queue', noteK.state === 'queued', JSON.stringify(noteK));
    await run.crash();
    check('DSH crashed (SIGKILL to its process group) under a running turn', !run.alive());
    await run.boot('after a crash');
    await probeReady();
    await step('after a crash: the cut-off session is found too, with the message it left waiting; the carry-on goes first and both are read in one turn', async () => {
        const found = await probeApi('cutOff', { withinMs: 0 });
        const mine = found.find((f) => f.sessionId === ids.crash);
        check('the session DSH crashed under is found', Boolean(mine), JSON.stringify(found.map((f) => f.title)));
        check('the one already carried on (its carry-on turn ended before the crash) is not found again', carriedOn && !found.some((f) => f.sessionId === ids.quit), JSON.stringify({ carriedOn, found: found.map((f) => f.title) }));
        check('a crash leaves the queue as it was: the log still has the message queued', queueFate(await probeApi('log', { sessionId: ids.crash }), noteK.id) === 'queued');
        const followed = await waitFor(async () => {
            const d = await probeApi('deliveryOf', { id: noteK.id });
            return d?.restored === true && d.state === 'queued' ? d : null;
        }, 'the message to be followed again', 20000, 250).catch(async () => probeApi('deliveryOf', { id: noteK.id }));
        check('the message sent before the crash is followed again from the journal: still queued', followed?.state === 'queued' && followed.restored === true && followed.from === 'probe', JSON.stringify(followed));
        check('cutOffSessions names it as still waiting there', mine?.queued?.length === 1 && mine.queued[0].id === noteK.id && mine.queued[0].from === 'probe', JSON.stringify(mine?.queued));
        const carry = await probeApi('deliver', { sessionId: ids.crash, text: 'Probe carry-on: DSH crashed while you were working; carry on.' });
        const done = await settled(carry.id);
        const k = await waitFor(async () => {
            const d = await probeApi('deliveryOf', { id: noteK.id });
            return d?.state === 'delivered' || d?.state === 'failed' ? d : null;
        }, 'the message from before the crash to settle', 20000, 250).catch(() => null);
        const log = await probeApi('log', { sessionId: ids.crash });
        const turn = turnOf(log, carry.id);
        const order = log.filter((e) => e.type === 'user/message' && turnOf(log, e.data?.id) === turn).map((e) => e.data.id).filter((id) => id === carry.id || id === noteK.id);
        check('after the crash too, the carry-on goes ahead of it and both are read in one turn, the carry-on first',
            done.state === 'delivered' && done.mode === 'steer' && k?.state === 'delivered' && k.turn === done.turn && done.turn === turn && JSON.stringify(order) === JSON.stringify([carry.id, noteK.id]), JSON.stringify({ done, k, order }));
        check('nothing was taken back out of its queue', !log.some((e) => e.type === 'agent/inbox/spliced' && e.data?.outcome === 'canceled'));
    });
    model.release();
    await waitFor(async () => (await run.session(ids.crash).catch(() => null))?.status !== 'running', 'the carry-on turn after the crash to end', 30000, 200).catch(() => {});

    // ── Questions, outside agents, files ───────────────────────────────
    await step('questions for a person: raised, answered once, refused a second time in words, and an answer\'s outcome told', async () => {
        since = (await probeApi('events', { since: 0 })).next;
        const raised = await probeApi('raise', { id: 'probe-q1', sessionId: ids.todos, question: 'Run the slow tests too?' });
        check('a raised question has its time and no handler on the wire', raised.id === 'probe-q1' && Number.isFinite(raised.at) && raised.onAnswer === undefined, JSON.stringify(raised));
        const waiting = await probeApi('asks');
        check('it waits', waiting.waiting.some((a) => a.id === 'probe-q1' && a.question === 'Run the slow tests too?'), JSON.stringify(waiting));
        const answered = await probeApi('answer', { id: 'probe-q1', answer: 'yes' });
        const after = await probeApi('asks');
        check('answered: the asker\'s handler gets the answer and who gave it, and it no longer waits', answered.ok === true && answered.told === true && after.answers.some((a) => a.id === 'probe-q1' && a.answer === 'yes' && a.by === 'test') && !after.waiting.some((a) => a.id === 'probe-q1'), JSON.stringify({ answered, after }));
        const again = await probeApi('answer', { id: 'probe-q1', answer: 'no' });
        check('a second answer is refused in words', again.ok === false && again.error === 'This question is no longer waiting.', JSON.stringify(again));
        check('an answer\'s outcome is told once its asker knows; a word that is not an outcome is refused', (await probeApi('outcome', { id: 'probe-q1', state: 'delivered' })) === true && (await probeApi('outcome', { id: 'probe-q1', state: 'sent' })) === false);
        const heard = (await probeApi('events', { since })).items.filter((e) => e.type === 'ask').map((e) => e.change);
        check('listeners hear raised, answered and the outcome', JSON.stringify(heard) === JSON.stringify(['raised', 'answered', 'outcome']), JSON.stringify(heard));
    });
    await step('an outside agent\'s state shows on its session\'s row, and goes', async () => {
        await probeApi('external', { sessionId: ids.todos, status: 'waiting on you' });
        const row = await windowRow(ids.todos);
        check('the row carries the outside agent\'s state as its word', row?.word === 'waiting on you' && row.external?.label === 'Probe agent', JSON.stringify({ word: row?.word, external: row?.external }));
        await probeApi('external', { sessionId: ids.todos, status: null });
        const cleared = await windowRow(ids.todos);
        check('cleared, the row reads as before', !cleared?.external && cleared?.word === 'idle', JSON.stringify({ word: cleared?.word, external: cleared?.external }));
    });
    await step('private folder and files', async () => {
        const dir = join(run.home, 'session-watch');
        const file = join(dir, 'running.json');
        const journal = join(dir, 'deliveries.jsonl');
        check('the watcher\'s folder is 700, and running.json and its journal deliveries.jsonl are 600', modeOf(dir) === 0o700 && modeOf(file) === 0o600 && modeOf(journal) === 0o600, `${modeOf(dir).toString(8)} ${modeOf(file).toString(8)} ${modeOf(journal).toString(8)}`);
        const lines = readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const quitNote = lines.find((l) => l.add?.delivery === noteQ.id)?.add;
        check('the journal holds each message put in, with its session, sender and first words', quitNote?.sessionId === ids.quit && quitNote.from === 'probe' && quitNote.preview === 'Probe note Q: sent while the migration ran.', JSON.stringify(quitNote));
    });

    // ── A number in quotes (#32) ───────────────────────────────────────
    await restartWith(rowsWith({ timeout: String(WAIT_SECONDS) }), 'a number in quotes');
    await probeReady();
    await step('a number in quotes in the profile: Session Watch starts, keeps working with its default, and names the setting with its value', async () => {
        const status = await watchApi('status');
        check('status names the setting, its range and the value as the profile has it', status.ok && status.value.running === true && status.value.problem?.text === `How long a message may wait to be read (deliveryTimeoutSeconds) must be a whole number of seconds from 10 to 86400 (it is "${WAIT_SECONDS}")` && status.value.problem?.live === true && status.value.problem?.key === 'deliveryTimeoutSeconds', JSON.stringify(status));
        const note = await probeApi('deliver', { sessionId: ids.todos, text: 'Probe note while a setting is wrong.' });
        const done = await settled(note.id);
        check('the watcher still delivers, with proof, while its setting waits', done.state === 'delivered', JSON.stringify(done));
    });
    if (pw) {
        await step('its page in Plugins: the value in quotes is flagged as the form opens, the quotes named; saving the number fixes it', async () => {
            window = await openWindow(run, pw, { entry: 'Plugins' });
            const { page } = window;
            await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
            const view = page.getByRole('button', { name: 'View Session Watch' });
            await view.waitFor({ state: 'visible', timeout: 20000 });
            await view.click();
            const form = page.locator('[data-suite-settings="dsh-plugin-session-watch"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            const field = form.getByLabel('How long a message may wait to be read, in seconds');
            const flagged = page.locator('[data-suite-setting="deliveryTimeoutSeconds"][data-suite-invalid]');
            await flagged.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const words = (await flagged.count()) ? (await flagged.innerText()).replace(/\n+/g, ' ') : '';
            check('the form shows the value with its quotes, flagged at once, and says the quotes are what is wrong',
                (await field.inputValue()) === `"${WAIT_SECONDS}"` && words.includes('It is saved as text, in quotes. Type a whole number from 10 to 86400, without the quotes, then save.'), `${await field.inputValue()} | ${words}`);
            check('the field is marked invalid for a screen reader too', (await field.getAttribute('aria-invalid')) === 'true', String(await field.getAttribute('aria-invalid')));
            await shot(page, shots, 'settings-in-quotes-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-in-quotes-dark');
            await setDark(page, false);
            // Under the form, on the same page: what it watches now.
            const watching = page.locator('[data-session-watch-watching]');
            await watching.waitFor({ state: 'visible', timeout: 15000 });
            const items = (await watchApi('sessions')).value.items;
            const counts = new Map();
            for (const row of items) counts.set(row.word, (counts.get(row.word) ?? 0) + 1);
            const seen = await waitFor(async () => {
                const text = (await watching.innerText()).replace(/\n+/g, ' ');
                return text.includes(`${items.length} sessions · ${counts.get('running') ?? 0} running`) ? text : null;
            }, 'the section to show the sessions', 15000, 300).catch(async () => (await watching.innerText()).replace(/\n+/g, ' '));
            const tags = await watching.locator('[aria-label="Sessions by state"] > li').allInnerTexts();
            check('under the form, what it watches: every session counted by its state word, as the watcher has them',
                seen.includes(`What it watches ${items.length} sessions · ${counts.get('running') ?? 0} running`) && tags.length === counts.size
                && [...counts].every(([word, n]) => tags.some((t) => t.replace(/\s+/g, ' ').trim() === `${word} ${n}`)), `${seen} | ${JSON.stringify([...counts])}`);
            check('which plugins read sessions through it, as DSH\'s plugin list has them',
                seen.includes('Autopilot, Decisions and Agent Terminals read sessions through it. Autopilot is not installed, Decisions is not installed and Agent Terminals is not installed.'), seen);
            check('and what the wrong setting means meanwhile', seen.includes('Until the setting above is fixed, a message may wait the default 10 minutes to be read.'), seen);
            const wronglyNew = [];
            for (const row of items.filter((r) => r.word === 'new')) {
                const summary = await run.session(row.sessionId).catch(() => null);
                if ((summary?.turns?.started ?? 0) > 0) wronglyNew.push({ title: row.title, status: row.status, blank: row.blank, state: row.state, turns: summary.turns });
            }
            check('no session that ran a turn reads "new", however many restarts ago it last ran', wronglyNew.length === 0, JSON.stringify(wronglyNew));
            await watching.scrollIntoViewIfNeeded();
            await shot(page, shots, 'watching-light', watching);
            await setDark(page, true);
            await shot(page, shots, 'watching-dark', watching);
            await setDark(page, false);
            ids.live = await run.newSession('E2E:say Counted live.', 'Live count');
            const grew = await waitFor(async () => (await watching.innerText()).includes(`${items.length + 1} sessions`), 'the new session in the count', 20000, 300).catch(() => false);
            check('a new session shows in the count by itself, without a reload', grew, (await watching.innerText()).replace(/\n+/g, ' '));
            // Choosing a state lists the sessions that read it, newest change first, each with when it changed and Open.
            const liveRow = await waitFor(async () => {
                const row = (await watchApi('sessions')).value.items.find((r) => r.sessionId === ids.live);
                return row && row.word !== 'running' && row.word !== 'new' ? row : null;
            }, 'the new session to finish its turn', 20000, 300).catch(() => null);
            const liveWord = liveRow?.word ?? 'idle';
            await watching.locator(`button[title$=" that read ${liveWord}"]`).click();
            const chip = watching.locator('button[aria-controls="dshsw-chosen"]');
            const chosen = watching.locator(`[data-session-watch-chosen="${liveWord}"]`);
            await chosen.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const listedRight = await waitFor(async () => {
                const expected = (await watchApi('sessions')).value.items.filter((r) => r.word === liveWord).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 12).map((r) => r.title || 'Untitled session');
                const shown = (await chosen.locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
                return shown.length === expected.length && expected.every((title, i) => shown[i].startsWith(`${title} `) && / Open$/.test(shown[i])) ? shown : null;
            }, 'the chosen state to list its sessions', 15000, 300).catch(async () => `not as the watcher has them: ${JSON.stringify((await chosen.locator('li').allInnerTexts().catch(() => [])))}`);
            check(`choosing a state ("${liveWord}") lists the sessions that read it, newest first, each with when it changed and Open`,
                Array.isArray(listedRight) && listedRight[0]?.startsWith('Live count ') && (await chip.count()) === 1 && (await chip.getAttribute('aria-expanded')) === 'true'
                && (await chip.innerText()).replace(/\s+/g, ' ').trim().startsWith(`${liveWord} `), JSON.stringify(listedRight));
            await shot(page, shots, 'watching-chosen-light', watching);
            await setDark(page, true);
            await shot(page, shots, 'watching-chosen-dark', watching);
            await setDark(page, false);
            await page.setViewportSize({ width: 760, height: 860 });
            const wide = await page.evaluate(() => document.documentElement.scrollWidth);
            check('at 760 px its page has no sideways scroll, with a state\'s sessions listed', wide <= 760, `${wide} px`);
            await shot(page, shots, 'settings-760-light');
            await page.setViewportSize({ width: 1280, height: 860 });
            // Open shows that session in the window, as a session in the sidebar does; Plugins brings the page back.
            const reply = page.getByText('Counted live.', { exact: true });
            const before = await reply.count();
            await chosen.locator('button[aria-label="Open Live count"]').click();
            const opened = await waitFor(async () => ((await reply.count()) > 0 ? true : null), 'the session to show', 20000, 300).catch(() => false);
            check('Open shows that session in the window', before === 0 && opened === true, `before ${before}, after ${await reply.count()}`);
            await shot(page, shots, 'opened-session-light');
            await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
            await Promise.race([form.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {}), view.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})]);
            if (!(await form.isVisible())) await view.click();
            await form.waitFor({ state: 'visible', timeout: 20000 });
            await watching.waitFor({ state: 'visible', timeout: 15000 });
            // The question box, pushed: the model asks 4 s into the turn, after the section has read the session as running.
            const asker = await run.prompts();
            ids.liveAsk = await run.newSession(`${call('ask_user_question', { questions: [{ id: 'size', question: 'Which size should the export be?', header: 'Size', options: [{ label: 'small' }, { label: 'large' }] }], timeout: -1 })}\n#delay=4000`, 'Live question');
            const askChip = watching.locator('button[title$=" that read waiting for your answer"]');
            const asked = await waitFor(() => asker.find('user-questions/request', (r) => JSON.stringify(r).includes('Which size should the export be?')), 'the question box to ask', 30000, 100).catch(() => null);
            const t0 = Date.now();
            const shown = await waitFor(async () => ((await askChip.count()) === 1 ? (await askChip.innerText()).replace(/\s+/g, ' ').trim() : null), 'the section to show the question', 6000, 100).catch(() => null);
            const took = Date.now() - t0;
            const headline = (await watching.innerText()).split('\n').find((l) => / sessions · /.test(l)) ?? '';
            check('a question asked in the question box shows in the open section by itself, within seconds, and the headline counts it as waiting on you',
                Boolean(asked) && shown === 'waiting for your answer 1' && / · 1 waiting on you$/.test(headline), `${shown} in ${took} ms | ${headline}`);
            await shot(page, shots, 'watching-question-light', watching);
            if (asked) await asker.answer(asked, { answers: [{ id: 'size', selected: ['small'] }] });
            const cleared = await waitFor(async () => ((await askChip.count()) === 0 ? true : null), 'the answered question to leave the section', 15000, 100).catch(() => false);
            check('answered, it leaves the section by itself', cleared === true, (await watching.innerText()).replace(/\n+/g, ' '));
            asker.close();
            // By keyboard: a chosen state whose last session leaves it stays, at 0, says so, and keeps the focus;
            // closed, its button goes and the focus moves to the first state left.
            ids.slowView = await run.newSession('E2E:slow', 'Slow view');
            await runningSession(ids.slowView);
            const runningChip = watching.locator('button[title$=" that read running"]');
            await runningChip.waitFor({ state: 'visible', timeout: 15000 });
            await runningChip.focus();
            await page.keyboard.press('Enter');
            const runningList = watching.locator('[data-session-watch-chosen="running"]');
            await runningList.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const listedRunning = (await runningList.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            // DSH says "running" before its request reaches the model: release the reply only once it is held.
            await waitFor(() => model.held.size >= 1, 'the slow turn\'s reply to be held open', 20000, 100).catch(() => {});
            model.release();
            const left = await waitFor(async () => ((await runningList.innerText()).includes('No session reads running now.') ? true : null), 'the running session to leave the list', 20000, 300).catch(() => false);
            const focused = () => page.evaluate(() => {
                const el = document.activeElement;
                return el && el !== document.body ? `${el.getAttribute('aria-expanded') ?? el.tagName}:${el.innerText.replace(/\s+/g, ' ').trim()}` : 'body';
            });
            const kept = await focused();
            check('by keyboard, a chosen state whose last session leaves it stays at 0, says so, and keeps the focus',
                listedRunning.startsWith('Slow view ') && left === true && kept === 'true:running 0', `${listedRunning} | ${left} | ${kept}`);
            // Away and back by keyboard: DSH's 2px ring shows on it (measured, then pictured light and dark).
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            const ring = await page.evaluate(() => {
                const el = document.activeElement;
                const style = el && el !== document.body ? getComputedStyle(el) : null;
                return style ? { on: el.getAttribute('aria-expanded'), text: el.innerText.replace(/\s+/g, ' ').trim(), outline: `${style.outlineStyle} ${style.outlineWidth}` } : null;
            });
            check('by keyboard, the chosen state shows DSH\'s 2px focus ring', ring?.on === 'true' && ring.text === 'running 0' && ring.outline === 'solid 2px', JSON.stringify(ring));
            await shot(page, shots, 'watching-at-0-focus-light', watching);
            await setDark(page, true);
            await shot(page, shots, 'watching-at-0-focus-dark', watching);
            await setDark(page, false);
            await page.keyboard.press('Enter');
            const firstChip = (await watching.locator('[aria-label="Sessions by state"] button').first().innerText()).replace(/\s+/g, ' ').trim();
            const moved = await focused();
            check('closed, its button goes and the focus moves to the first state left', (await runningList.count()) === 0 && (await runningChip.count()) === 0 && moved === `false:${firstChip}`, `${moved} | ${firstChip}`);
            // The state buttons are one tab stop: arrows, Home and End move among them, and one Tab leaves them all.
            const stateButtons = watching.locator('[aria-label="Sessions by state"] button');
            const texts = (await stateButtons.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
            await page.keyboard.press('End');
            const atEnd = await focused();
            await page.keyboard.press('ArrowLeft');
            const stepped = await focused();
            await page.keyboard.press('ArrowRight');
            const back = await focused();
            await page.keyboard.press('Home');
            const home = await focused();
            const tabStops = await stateButtons.evaluateAll((buttons) => buttons.filter((b) => b.tabIndex === 0).length);
            check('the state buttons are one tab stop: End, the arrows and Home move the focus among them',
                texts.length >= 2 && atEnd === `false:${texts.at(-1)}` && stepped === `false:${texts.at(-2)}` && back === atEnd && home === `false:${texts[0]}` && tabStops === 1, JSON.stringify({ texts, atEnd, stepped, back, home, tabStops }));
            // More than twelve in a state: twelve listed, then "Show N more", which keeps the focus.
            const newNow = (await watchApi('sessions')).value.items.filter((r) => r.word === 'new').length;
            for (let i = 1; i <= Math.max(0, SHOWN + 1 - newNow); i++) await run.newSession(undefined, `Blank ${String(i).padStart(2, '0')}`);
            const newChip = watching.locator('button[title$=" that read new"]');
            const newRows = await waitFor(async () => {
                const items = (await watchApi('sessions')).value.items.filter((r) => r.word === 'new').sort((x, y) => y.updatedAt - x.updatedAt);
                return items.length > SHOWN && (await newChip.count()) === 1 && (await newChip.innerText()).replace(/\s+/g, ' ').trim() === `new ${items.length}` ? items : null;
            }, 'the blank sessions to be counted', 20000, 300);
            await newChip.focus();
            await page.keyboard.press('Enter');
            const newList = watching.locator('[data-session-watch-chosen="new"]');
            await newList.waitFor({ state: 'visible', timeout: 10000 });
            await page.keyboard.press('Tab');
            const afterTab = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '');
            const titleOf = (row) => row.title || 'Untitled session';
            check('one Tab from the state buttons goes to the first session listed', afterTab === `Open ${titleOf(newRows[0])}`, afterTab);
            const moreButton = newList.locator('[data-session-watch-more]');
            const listedAtFirst = await newList.locator('li').count();
            const firstWords = (await newList.innerText()).replace(/\s+/g, ' ');
            check(`more than twelve in a state (${newRows.length}): twelve listed, newest first, then how many are shown and "Show ${Math.min(SHOWN, newRows.length - SHOWN)} more"`,
                listedAtFirst === SHOWN && (await moreButton.count()) === 1 && (await moreButton.innerText()) === `Show ${Math.min(SHOWN, newRows.length - SHOWN)} more` && firstWords.includes(`${SHOWN} of ${newRows.length} shown, newest first.`), `${listedAtFirst} | ${firstWords.slice(-200)}`);
            await moreButton.scrollIntoViewIfNeeded();
            await shot(page, shots, 'watching-more-light', watching);
            await setDark(page, true);
            await shot(page, shots, 'watching-more-dark', watching);
            await setDark(page, false);
            await moreButton.focus();
            await page.keyboard.press('Enter');
            const grown = Math.min(2 * SHOWN, newRows.length);
            const listedAfter = await waitFor(async () => ((await newList.locator('li').count()) === grown ? grown : null), 'the next sessions to be listed', 10000, 100).catch(async () => newList.locator('li').count());
            const focusAfter = await page.evaluate(() => {
                const el = document.activeElement;
                return el && el !== document.body ? (el.getAttribute('aria-label') ?? el.innerText.replace(/\s+/g, ' ').trim()) : 'body';
            });
            const expectFocus = newRows.length > 2 * SHOWN ? `Show ${Math.min(SHOWN, newRows.length - 2 * SHOWN)} more` : `Open ${titleOf(newRows[SHOWN])}`;
            check('"Show more" lists the next ones; the focus stays on it, or moves to the first one it showed once none are left',
                listedAfter === grown && focusAfter === expectFocus && (newRows.length > 2 * SHOWN || (await newList.innerText()).includes(`All ${newRows.length} shown.`)), `${listedAfter} | ${focusAfter} vs ${expectFocus}`);
            await page.setViewportSize({ width: 760, height: 860 });
            const wideMore = await page.evaluate(() => document.documentElement.scrollWidth);
            check('at 760 px, with every session of a state listed, no sideways scroll', wideMore <= 760, `${wideMore} px`);
            await shot(page, shots, 'watching-all-760-light', watching);
            await page.setViewportSize({ width: 1280, height: 860 });
            const save = form.getByRole('button', { name: 'Save' });
            await field.fill('5');
            const refused = (await page.locator('[data-suite-setting="deliveryTimeoutSeconds"]').innerText()).replace(/\n+/g, ' ');
            check('a value out of range cannot be saved, and the form says what fits', await save.isDisabled() && refused.includes('A whole number from 10 to 86400, or empty for the default (600).'), refused);
            await field.fill(String(WAIT_SECONDS));
            check('the number typed without the quotes can be saved', !(await save.isDisabled()));
            await save.click();
            const fixed = await waitFor(async () => {
                const r = await watchApi('status');
                return r.ok && !r.value.problem ? r.value : null;
            }, 'the setting to be fixed', 20000, 300).catch(() => null);
            check('saved, the setting is fixed at once', Boolean(fixed), JSON.stringify(fixed));
            const patch = readFileSync(join(run.profile, 'cordis.patch.yml'), 'utf8');
            check('the profile now holds the number, without quotes', new RegExp(`deliveryTimeoutSeconds: ${WAIT_SECONDS}\\b`).test(patch) && !patch.includes(`deliveryTimeoutSeconds: "${WAIT_SECONDS}"`), patch.split('\n').filter((l) => /deliveryTimeout/.test(l)).join(' | '));
            await page.waitForTimeout(500);
            check('the flag is gone once saved', (await page.locator('[data-suite-setting="deliveryTimeoutSeconds"][data-suite-invalid]').count()) === 0);
            const dropped = await waitFor(async () => (await page.locator('[data-session-watch-problem]').count()) === 0, 'the section to drop the setting line', 15000, 300).catch(() => false);
            check('and the section drops its line about the setting by itself', dropped);
            await shot(page, shots, 'settings-fixed-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-fixed-dark');
            await setDark(page, false);
            const ours = window.errors.filter((text) => /session-watch/i.test(text));
            check('no errors from Session Watch in the window', ours.length === 0, ours.join('\n'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-settings');
        });
        await step('switched off in Plugins: no failure from DSH, its endpoints, service and style sheet go; on again, it serves at once', async () => {
            const { page } = window;
            const styleCount = () => page.locator('style[data-plugin-css="dsh-plugin-session-watch/client.css"]').count();
            const styled = await styleCount();
            const failed = page.getByText(/Could not (disable|enable)/);
            const watchSwitch = page.getByRole('switch', { name: 'Enable Session Watch' });
            // A message on its way when it is switched off: queued behind a running turn, off for longer than the wait.
            ids.offSlow = await run.newSession('E2E:slow', 'Held over a switch-off');
            await runningSession(ids.offSlow);
            await waitFor(() => model.held.size === 1, 'the turn\'s reply to be held open', 20000, 100);
            const noteO = await probeApi('deliver', { sessionId: ids.offSlow, text: 'Probe note O: sent before Session Watch was switched off.', from: 'probe' });
            const sentAt = Date.now();
            check('a message sent before the switch-off waits in its queue', noteO.state === 'queued', JSON.stringify(noteO));
            await watchSwitch.click();
            await waitFor(async () => (await watchSwitch.getAttribute('aria-checked')) === 'false', 'Session Watch\'s switch to go off', 20000, 200);
            await waitFor(async () => (await watchApi('status')).ok === false, 'its endpoints to go', 20000, 300);
            await sleep(2000);
            const offWords = (await failed.count()) ? await failed.first().innerText() : '';
            check('switched off, DSH reports no failure', offWords === '', offWords);
            const gone = await watchApi('status');
            check('its window endpoints are gone, said in words', gone.ok === false, JSON.stringify(gone));
            const probe = await run.api('dsh-plugin-session-watch-probe/ready');
            check('its service is gone: the plugin that used it no longer has it', probe.ok && probe.value.ready === false, JSON.stringify(probe));
            check('it leaves nothing behind in the window: its style sheet and its section are gone', styled === 1 && (await styleCount()) === 0 && (await page.locator('[data-session-watch-watching]').count()) === 0, `${styled} then ${await styleCount()}`);
            await shot(page, shots, 'switched-off-light');
            await waitFor(() => Date.now() - sentAt > (WAIT_SECONDS + 5) * 1000, 'the wait to pass while it is off', (WAIT_SECONDS + 10) * 1000, 250);
            const offLog = await run.events(ids.offSlow);
            check(`off for longer than its ${WAIT_SECONDS}-second wait, it took nothing back out of the queue and the message is still unread`,
                !offLog.some((e) => e.type === 'agent/inbox/spliced' && e.data?.removedCount > 0 && e.data?.outcome === 'canceled') && !offLog.some((e) => e.type === 'user/message' && e.data?.id === noteO.id),
                JSON.stringify(offLog.filter((e) => e.type === 'agent/inbox/spliced').map((e) => e.data)).slice(0, 400));
            await watchSwitch.click();
            await waitFor(async () => (await watchApi('status')).ok === true, 'its endpoints to come back', 30000, 300);
            await probeReady();
            check('on again, it serves at once and its user has it again', true);
            const followed = await waitFor(async () => {
                const d = await probeApi('deliveryOf', { id: noteO.id });
                return d?.restored === true && d.state === 'queued' ? d : null;
            }, 'the message to be followed again', 15000, 250).catch(async () => probeApi('deliveryOf', { id: noteO.id }));
            check('on again, it follows the message it left on its way, still queued', followed?.state === 'queued' && followed.restored === true, JSON.stringify(followed));
            model.release();
            const read = await waitFor(async () => {
                const d = await probeApi('deliveryOf', { id: noteO.id });
                return d?.state === 'delivered' || d?.state === 'failed' ? d : null;
            }, 'the message to settle', 30000, 250).catch(() => null);
            const onLog = await probeApi('log', { sessionId: ids.offSlow });
            check('once the running turn ends, the next turn reads it and the watcher proves it from the log', read?.state === 'delivered' && read.turn === 2 && turnOf(onLog, noteO.id) === 2, JSON.stringify(read));
            const note = await probeApi('deliver', { sessionId: ids.todos, text: 'Probe note after switching on again.' });
            check('and it delivers with proof again', (await settled(note.id)).state === 'delivered');
            await waitFor(async () => (await styleCount()) === 1, 'its style sheet to come back once', 10000, 200).catch(() => {});
            check('its style sheet is back, once', (await styleCount()) === 1, String(await styleCount()));
            const back = await page.locator('[data-session-watch-watching]').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
            check('and its section comes back on its page by itself', back && (await page.locator('[data-session-watch-watching]').count()) === 1);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-switch');
        });
        await window?.browser?.close().catch(() => {});
        window = undefined;
    }
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
    if (window?.page) await shot(window.page, shots, 'failed').catch(() => {});
} finally {
    await window?.browser?.close().catch(() => {});
    model.release();
    await run.stop();
    await model.close();
    const warnings = run.logText().split('\n').filter((line) => /session-watch/i.test(line) && /warn|error|fail/i.test(line));
    if (warnings.length) console.log(`# DSH said about Session Watch:\n${warnings.slice(-20).map((l) => `#   ${l}`).join('\n')}`);
    run.cleanup();
}
console.log(`\n# DSH ${version}: ${tally.passed} passed, ${tally.failed} failed${pw ? '' : ', window checks skipped (no Playwright)'}`);
process.exit(tally.failed ? 1 : 0);
