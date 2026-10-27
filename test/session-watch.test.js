// The session watcher (plugins/session-watch): its fold, and the watcher over a stand-in DSH.
// index.js needs DSH's own packages, so its wiring is checked end to end in DSH Test (scripts/e2e.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INITIAL, KEY, STATE_VERSION, TEXT_MAX, applyEvent, endOf, foldAll, goalOf, inboxOf, parseState, readIn, sessionWatchProjection, todoSummary, viewOf } from '../plugins/session-watch/lib/fold.js';
import { SessionWatch } from '../plugins/session-watch/lib/watch.js';
import { Hub } from '../plugins/session-watch/lib/shared/hub.js';
import { DEFAULTS, LIVE_SETTINGS, checkConfig, usableSettings } from '../plugins/session-watch/lib/config.js';
import { SettingsCheck, liveSettings } from '../plugins/session-watch/lib/shared/settings.js';
import { loadClient, elementsOf, strictRemote, textIn } from './helpers/client.mjs';
import { fakeDsh } from './helpers/fake-dsh.mjs';
import { manualClock, settle } from './helpers/clock.mjs';
import { tempDir } from './helpers/temp.mjs';

const ev = (type, data = {}, time = 1000) => ({ type, time, data });
const text = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

// ── The fold ───────────────────────────────────────────────────────────

test('fold: turns, replies, tools, todos, goal, approvals and title, from events', () => {
    let s = foldAll([
        ev('session/title', { title: '  Build   the parser ' }, 900),
        ev('turn/start', { turn: 1 }, 1000),
        ev('user/message', { id: 'u1', source: { kind: 'user' } }, 1001),
        ev('tool/call', { name: 'bash' }, 1002),
        ev('todo/write', { todos: [{ content: 'Lexer', status: 'completed' }, { content: 'Parser', status: 'in_progress' }, { content: 'Tests', status: 'pending' }] }, 1003),
        ev('goal/change', { operation: 'create', goal: { id: 'g1', revision: 2, objective: 'Ship the parser', phase: 'active', maxGoalRounds: 10 }, roundsStarted: 1 }, 1004),
        ev('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1', reason: 'writes outside the folder' }, 1005),
        ev('assistant/message', { turn: 1, message: text('Halfway there.') }, 1006),
    ]);
    assert.equal(s.title, 'Build the parser');
    assert.equal(s.turn, 1);
    assert.equal(s.open, true);
    assert.equal(s.startedAt, 1000);
    assert.equal(s.userAt, 1001);
    assert.equal(s.inKind, 'user');
    assert.equal(s.tools, 1);
    assert.equal(s.steps, 1);
    assert.deepEqual(s.todos, { open: 2, active: 1, done: 1, total: 3, next: 'Parser' });
    assert.deepEqual(s.goal, { id: 'g1', rev: 2, phase: 'active', objective: 'Ship the parser', rounds: 1, max: 10 });
    assert.deepEqual(s.approvals, [{ id: 'a1', tool: 'bash', call: 'c1', reason: 'writes outside the folder', at: 1005 }]);
    assert.equal(s.text, 'Halfway there.');
    s = applyEvent(s, ev('approval/decided', { id: 'a1', outcome: 'approved' }, 1007));
    assert.equal(s.approvals, undefined);
    s = applyEvent(s, ev('user/message', { id: 'r2', source: { kind: 'goal', goalId: 'g1', round: 2 } }, 1008));
    assert.equal(s.goal.rounds, 2, 'a goal round message moves the round count');
    assert.equal(s.userAt, 1001, 'only a person\'s message is a person writing');
    s = applyEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'provider', message: '502 from the gateway' } } }, 1009));
    assert.equal(s.open, false);
    assert.deepEqual(s.end, { turn: 1, kind: 'error', at: 1009, code: 'provider', error: '502 from the gateway' });
    assert.equal(s.errors, 1);
    s = applyEvent(s, ev('turn/start', { turn: 2 }, 1010));
    s = applyEvent(s, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 1011));
    assert.equal(s.errors, undefined, 'a completed turn clears the error count');
    s = applyEvent(s, ev('goal/change', { operation: 'clear' }, 1012));
    assert.equal(s.goal, undefined);
});

test('fold: never throws, and gives the same object back when nothing changed', () => {
    const s = foldAll([ev('turn/start', { turn: 1 })]);
    assert.equal(applyEvent(s, ev('assistant/message', { message: text('   ') })), s, 'an empty reply changes nothing');
    assert.equal(applyEvent(s, ev('something/else')), s);
    assert.equal(applyEvent(s, null), s);
    assert.equal(applyEvent(s, { type: 42 }), s);
    assert.equal(applyEvent(s, ev('approval/decided', { id: 'never-asked' })), s);
    assert.equal(applyEvent(s, ev('turn/start', { turn: 1 }, 1000)), s, 'the same turn start again is no change');
    assert.deepEqual(applyEvent(undefined, ev('turn/start', { turn: 3 })).turn, 3, 'a missing state starts from the beginning');
    assert.doesNotThrow(() => applyEvent(s, { type: 'todo/write', data: { todos: [null, 7, { status: 'completed' }] } }));
    assert.doesNotThrow(() => applyEvent(s, { type: 'goal/change', data: { goal: 'nope' } }));
});

test('fold: long replies keep their end, where agents ask; the window view leaves the text out', () => {
    const long = `${'x'.repeat(4000)}\nDECISION NEEDED: ship it? — recommend: yes`;
    const s = foldAll([ev('turn/start', { turn: 1 }), ev('assistant/message', { message: text(long) })]);
    assert.equal(s.text.length, TEXT_MAX);
    assert.ok(s.text.startsWith('…'));
    assert.ok(s.text.endsWith('recommend: yes'));
    const view = viewOf(s);
    assert.equal(view.text, undefined);
    assert.equal(view.turn, 1);
    assert.equal(viewOf(null), null);
});

test('fold: an approval belongs to its turn; a turn cut off under one keeps what it left', () => {
    const asked = [
        ev('turn/start', { turn: 1 }, 1000),
        ev('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1', reason: 'escalate sandbox to danger-full-access: deploys' }, 1001),
    ];
    // DSH stopped under it: on its next start it closes the turn as interrupted. Nothing waits on the approval now.
    const cut = foldAll([...asked, ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 1002)]);
    assert.equal(cut.approvals, undefined);
    assert.deepEqual(cut.end, { turn: 1, kind: 'interrupted', at: 1002, left: { kind: 'approval', tool: 'bash', reason: 'escalate sandbox to danger-full-access: deploys' } });
    // A graceful stop (aborted, disposed) is a cut-off too; the person stopping it is not, and keeps no note.
    assert.equal(foldAll([...asked, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, 1002)]).end.left.kind, 'approval');
    const stopped = foldAll([...asked, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1002)]);
    assert.equal(stopped.approvals, undefined);
    assert.equal(stopped.end.left, undefined);
    // Two waiting: the newest is named, with how many more.
    const two = foldAll([...asked, ev('approval/asked', { id: 'a2', toolName: 'write' }, 1002), ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 1003)]);
    assert.deepEqual(two.end.left, { kind: 'approval', tool: 'write', more: 1 });
    // A turn that starts with an approval left over from a log without its end starts clean.
    assert.equal(applyEvent(foldAll(asked), ev('turn/start', { turn: 2 }, 1005)).approvals, undefined);
    // A graceful stop cancels the approval first, then ends the turn: the end still says what was left.
    const graceful = foldAll([...asked, ev('approval/decided', { id: 'a1', outcome: 'cancelled' }, 1002), ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, 1003)]);
    assert.deepEqual(graceful.end.left, { kind: 'approval', tool: 'bash', reason: 'escalate sandbox to danger-full-access: deploys' });
    assert.equal(graceful.cancelled, undefined, 'the turn is over: nothing is kept past its end');
    // Answered (allowed or rejected) before the cut: nothing was left.
    assert.equal(foldAll([...asked, ev('approval/decided', { id: 'a1', outcome: 'rejected' }, 1002), ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 1003)]).end.left, undefined);
});

test('fold: a question waiting in DSH\'s question box is tracked until its result, and named when a cut-off leaves it', () => {
    const args = { questions: [{ question: '  Which   branch should I use? ', options: [{ label: 'main' }, { label: 'dev' }] }, { question: 'Tag it?', options: [] }] };
    let s = foldAll([
        ev('turn/start', { turn: 1 }, 1000),
        ev('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify(args) }, 1001),
    ]);
    assert.deepEqual(s.asking, { call: 'q1', question: 'Which branch should I use?', more: 1, at: 1001 });
    assert.equal(s.tools, 1, 'still a tool call');
    // Another tool's result changes nothing; its own result means the person answered (or it timed out).
    assert.equal(applyEvent(s, ev('tool/result', { message: { toolCallId: 'other' } }, 1002)), s);
    assert.equal(applyEvent(s, ev('tool/result', { message: { toolCallId: 'q1' } }, 1002)).asking, undefined);
    // Arguments as an object work too; unreadable ones keep the call without a question.
    assert.equal(applyEvent(s, ev('tool/call', { name: 'ask_user_question', callId: 'q2', arguments: { questions: [{ question: 'Ship?' }] } }, 1003)).asking.question, 'Ship?');
    assert.deepEqual(applyEvent(s, ev('tool/call', { name: 'ask_user_question', callId: 'q3', arguments: '{nope' }, 1003)).asking, { call: 'q3', at: 1003 });
    // A stop cancels the box first (its call ends in an error), then ends the turn; answered, nothing was left.
    const cancelled = applyEvent(s, ev('tool/result', { message: { toolCallId: 'q1', isError: true } }, 1002));
    assert.equal(cancelled.asking, undefined);
    assert.equal(applyEvent(cancelled, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, 1003)).end.left.question, 'Which branch should I use?');
    assert.equal(foldAll([ev('turn/start', { turn: 1 }, 1000), ev('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify(args) }, 1001), ev('tool/result', { message: { toolCallId: 'q1' } }, 1002), ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 1003)]).end.left, undefined);
    // DSH stopped before the answer: the end says what was asked.
    s = applyEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 1004));
    assert.equal(s.asking, undefined);
    assert.deepEqual(s.end.left, { kind: 'question', question: 'Which branch should I use?', more: 1 });
    // Saved and read back.
    const saved = parseState({ turn: 1, open: true, tools: 1, at: 5, asking: { call: 'q1', question: 'Which?', more: 2, at: 4, junk: true } });
    assert.deepEqual(saved.asking, { call: 'q1', question: 'Which?', more: 2, at: 4 });
    assert.deepEqual(parseState({ end: { kind: 'interrupted', turn: 1, at: 3, left: { kind: 'question', question: 'Which?' } } }).end.left, { kind: 'question', question: 'Which?' });
    // States saved before this shape fold again from their logs (4: the sender of another session's message, and markers read anywhere in a reply's end).
    assert.equal(STATE_VERSION, 4);
    // An offer is kept as one, so Decisions can leave it out.
    assert.deepEqual(parseState({ ask: { kind: 'question', question: 'Let me know.', soft: true, turn: 2 } }).ask, { kind: 'question', question: 'Let me know.', soft: true, turn: 2 });
});

test('fold: another session\'s message keeps its sender, so a reply to a coordinator\'s relay can be told apart', () => {
    let s = foldAll([ev('turn/start', { turn: 1 }, 1000), ev('user/message', { source: { kind: 'agent-message', form: 'relay', senderSessionId: 'thread-1' } }, 1001)]);
    assert.deepEqual([s.inKind, s.inFrom, s.inAt], ['agent-message', 'thread-1', 1001]);
    s = applyEvent(s, ev('user/message', { source: { kind: 'user' } }, 1002));
    assert.deepEqual([s.inKind, s.inFrom, s.userAt], ['user', undefined, 1002], 'the person wrote last: no sender');
    assert.equal('inFrom' in s, false);
    s = applyEvent(s, ev('user/message', { source: { kind: 'agent-message', senderSessionId: 42 } }, 1003));
    assert.equal(s.inFrom, undefined, 'only a session id is kept');
    assert.equal(parseState({ inKind: 'agent-message', inFrom: `t${'x'.repeat(300)}` }).inFrom.length, 128);
    assert.equal(parseState({ inFrom: 7 }).inFrom, undefined);
});

test('fold: a saved state is made safe; the projection is registered under one key', () => {
    assert.deepEqual(parseState(undefined), INITIAL);
    assert.deepEqual(parseState({ turn: -3, open: 'yes', tools: 2.5, at: 'soon' }), { turn: 0, open: false, tools: 0, at: 0 });
    const kept = parseState({ turn: 4, open: true, tools: 9, at: 77, end: { kind: 'completed', turn: 4, at: 70 }, todos: { open: 1 }, goal: { id: 'g' }, approvals: [{ id: 'a' }, 'junk'], text: 'hi', title: 'T', inKind: 'user' });
    assert.equal(kept.turn, 4);
    assert.equal(kept.end.kind, 'completed');
    assert.deepEqual(kept.approvals, [{ id: 'a' }]);
    const projection = sessionWatchProjection();
    assert.equal(projection.key, KEY);
    assert.equal(KEY, 'sessionWatch');
    assert.equal(projection.stateVersion, STATE_VERSION);
    assert.equal(projection.init(), INITIAL);
    assert.equal(projection.apply, applyEvent);
    assert.equal(projection.wire.view({ text: 'x', turn: 1 }).text, undefined);
    assert.equal(projection.wire.viewSchema.parse('junk'), null);
});

test('fold: the ask at the end of a reply, with its turn; a later reply without one clears it; saved and shown without the text', () => {
    const reply = (turn, text) => ({ type: 'assistant/message', time: 10 * turn, data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } } });
    let state = foldAll([{ type: 'turn/start', time: 1, data: { turn: 1 } }, reply(1, 'Both work.\nDECISION NEEDED: Postgres or SQLite? — recommend: SQLite'), { type: 'turn/end', time: 12, data: { turn: 1, reason: { kind: 'completed' } } }]);
    assert.deepEqual(state.ask, { kind: 'decision', question: 'Postgres or SQLite?', recommendation: 'SQLite', turn: 1 });
    assert.deepEqual(viewOf(state).ask, state.ask, 'cold sessions keep it in DSH\'s saved value');
    assert.equal(viewOf(state).text, undefined);
    assert.deepEqual(parseState(viewOf(state)).ask, state.ask);
    state = applyEvent(state, reply(2, 'Done: SQLite it is.'));
    assert.equal(state.ask, undefined);
    assert.equal(parseState({ ask: { kind: 'other', question: 'x', turn: 1 } }).ask, undefined, 'a saved ask is checked');
    assert.equal(parseState({ ask: { kind: 'blocked', question: 'x'.repeat(500), turn: 1 } }).ask.question.length, 400, 'kept short');
});

test('fold: turn ends, goals and todo lists in the watcher\'s words', () => {
    assert.deepEqual(endOf({ turn: 3, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, 5), { turn: 3, kind: 'aborted', at: 5, cause: 'disposed' });
    assert.deepEqual(endOf({}, 'x'), { turn: 0, kind: 'unknown', at: 0 });
    const g = goalOf({ goal: { id: 'g', revision: 1, objective: 'O', phase: 'active' }, roundsStarted: 5 });
    assert.equal(goalOf({ goal: { id: 'g', revision: 2, objective: 'O' }, roundsStarted: 3 }, g).rounds, 5, 'rounds never go back for the same goal');
    assert.equal(goalOf({ operation: 'clear' }, g), undefined);
    assert.equal(goalOf('junk', g), g);
    assert.equal(goalOf({ goal: { id: 'g', blockedReason: { message: 'needs a key' } } }).blocked, 'needs a key');
    assert.deepEqual(todoSummary([]), { open: 0, active: 0, done: 0, total: 0 });
    assert.deepEqual(todoSummary([{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }]), { open: 2, active: 0, done: 0, total: 2, next: 'A' });
    assert.equal(todoSummary('junk'), undefined);
});

// ── The watcher over a stand-in DSH ───────────────────────────────────

let notes = 0;
function setup({ config = {}, dir = tempDir('session-watch'), clock = manualClock(), dsh = fakeDsh({ now: clock.now }) } = {}) {
    const warnings = [];
    const infos = [];
    const logger = { info: (line) => infos.push(line), warn: (line) => warnings.push(line) };
    const hub = new Hub();
    const watch = new SessionWatch({
        ctx: dsh.ctx,
        config: { deliveryTimeoutSeconds: 600, ...config },
        logger,
        // Message ids are unique across watchers, as DSH's are.
        makeMessage: (body) => ({ id: `note-${++notes}`, role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'cordis-host-runner' } }),
        hub,
        dir,
        after: clock.after,
        cancel: clock.clearTimer,
        now: clock.now,
    });
    dsh.attach(watch);
    const events = [];
    watch.on((event) => events.push(event));
    return { dir, clock, dsh, watch, hub, events, warnings, infos };
}

test('watcher: lists every session with its state, live when loaded and saved when not', async () => {
    const { dsh, watch } = setup();
    dsh.add('cold', { title: 'Old work', cwd: '/work/old' });
    dsh.commit('cold', 'turn/start', { turn: 1 });
    dsh.commit('cold', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    dsh.add('child', { parentSessionId: 'cold' });
    dsh.add('new', { blank: true });
    dsh.write('live', 'Start the build');
    const rows = await watch.list();
    const byId = Object.fromEntries(rows.map((row) => [row.sessionId, row]));
    assert.equal(byId.cold.title, 'Old work');
    assert.equal(byId.cold.cwd, '/work/old');
    assert.equal(byId.cold.status, 'cold');
    assert.equal(byId.cold.word, 'idle');
    assert.equal(byId.cold.state.end.kind, 'completed');
    assert.equal(byId.child.parentSessionId, 'cold');
    assert.equal(byId.child.origin, 'subagent');
    assert.equal(byId.new.word, 'new');
    assert.equal(byId.live.status, 'running');
    assert.equal(byId.live.word, 'running');
    assert.equal(byId.live.state.open, true);
    assert.equal(byId.live.state.text, undefined, 'rows never carry reply text');
    assert.deepEqual((await watch.get('cold')).sessionId, 'cold');
});

test('watcher: DSH\'s list is read once for a burst of window reads, and a failed read keeps what it knew', async () => {
    const { dsh, watch, clock, warnings } = setup();
    dsh.add('a', { title: 'A' });
    let reads = 0;
    const list = dsh.ctx.sessionController.list;
    dsh.ctx.sessionController.list = async (...args) => { reads += 1; return list(...args); };
    await watch.list();
    await watch.list();
    assert.equal(reads, 1);
    await clock.advance(2000);
    await watch.list();
    assert.equal(reads, 2);
    dsh.ctx.sessionController.list = async () => { throw new Error('the store is busy'); };
    await clock.advance(2000);
    const rows = await watch.list();
    assert.deepEqual(rows.map((row) => row.sessionId), ['a']);
    assert.match(warnings.join('\n'), /could not be read: the store is busy/);
});

test('watcher: another projection\'s value, live while loaded and as DSH saved it otherwise; a new session is listed at once', async () => {
    const { dsh, watch } = setup();
    dsh.add('cold', { title: 'Old', values: { userQuestions: { active: [{ callId: 'c', questions: [], state: 'continued' }], settled: [] } } });
    await watch.list();
    assert.deepEqual(watch.projection('cold', 'userQuestions'), { live: false, value: { active: [{ callId: 'c', questions: [], state: 'continued' }], settled: [] } });
    assert.equal(watch.projection('cold', 'coordinatorSession'), undefined);
    dsh.extra.userQuestions = () => ({ timed: true, questions: { active: [], settled: [] } });
    dsh.write('cold', 'Go on.');
    assert.deepEqual(watch.projection('cold', 'userQuestions'), { live: true, value: { timed: true, questions: { active: [], settled: [] } } });
    assert.equal(watch.projection('none', 'userQuestions'), undefined);
    // A session the cached list does not have yet makes the next list read DSH's again.
    dsh.write('fresh', 'Hello');
    assert.ok((await watch.list()).some((row) => row.sessionId === 'fresh'));
});

test('watcher: a delivery is queued, then delivered when the session reads it into a turn', async () => {
    const { dsh, watch, events, infos } = setup();
    dsh.add('s', { title: 'Parser' });
    dsh.commit('s', 'turn/start', { turn: 1 });
    dsh.commit('s', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const delivery = await watch.deliver('s', 'Carry on.');
    assert.equal(delivery.state, 'queued', 'the session\'s inbox shows it before deliver returns');
    assert.deepEqual(dsh.flushed, ['s'], 'the inbox is saved at once, so a stop now keeps the message');
    const done = await delivery.done;
    assert.equal(done.state, 'delivered');
    assert.equal(done.turn, 2, 'the turn that read it');
    const msg = dsh.sessions.get('s').events.find((event) => event.type === 'user/message');
    assert.equal(msg.data.id, delivery.id);
    assert.equal(msg.data.source.kind, 'cordis-host-runner');
    assert.deepEqual(events.filter((event) => event.type === 'delivery').map((event) => event.delivery.state), ['queued', 'delivered']);
    assert.deepEqual(Object.keys(delivery.toJSON()).sort(), ['at', 'deliveredAt', 'id', 'mode', 'preview', 'queuedAt', 'sessionId', 'state', 'turn']);
    assert.equal(delivery.toJSON().mode, 'queue');
    assert.equal(delivery.toJSON().preview, 'Carry on.');
    // Each side effect is logged: the message put in, and the turn that read it.
    assert.deepEqual(infos.filter((line) => line.includes(delivery.id)), [
        `session-watch: a message ${delivery.id} went into s (its queue); a turn has 10 minutes to read it`,
        `session-watch: the message ${delivery.id} to s was read into turn 2`,
    ]);
});

test('watcher: a running session is steered when asked, and gets a follow-up otherwise', async () => {
    const { dsh, watch } = setup();
    dsh.write('s', 'Do the work');
    const steered = await watch.deliver('s', 'Also check the tests.', { mode: 'steer' });
    assert.equal(dsh.agents.get('s').steered, 1);
    assert.equal((await steered.done).state, 'delivered');
    assert.equal(steered.turn, 1, 'read into the running turn');
    const queued = await watch.deliver('s', 'Then write the docs.');
    assert.equal(queued.state, 'queued');
    assert.equal(dsh.agents.get('s').steered, 1);
});

test('watcher: a delivery that cannot happen says why, and one never read times out as not delivered', async () => {
    const { dsh, watch, clock, warnings } = setup({ config: { deliveryTimeoutSeconds: 30 } });
    const missing = await watch.deliver('nope', 'Hello');
    assert.equal(missing.state, 'failed');
    assert.match(missing.reason, /^the session could not be opened: Session nope not found/);
    dsh.add('s');
    dsh.refuse = 'the inbox is closed';
    const refused = await watch.deliver('s', 'Hello');
    assert.equal(refused.state, 'failed');
    assert.equal(refused.reason, 'DSH refused the message: the inbox is closed');
    assert.match(warnings.join('\n'), /a message to nope was not delivered: the session could not be opened/);
    assert.match(warnings.join('\n'), /a message to s was not delivered: DSH refused the message: the inbox is closed/);
    dsh.refuse = undefined;
    // A running turn that never reaches its next step leaves a follow-up in the queue.
    dsh.write('s', 'Long job');
    const stuck = await watch.deliver('s', 'When you can.');
    assert.equal(stuck.state, 'queued');
    await clock.advance(31000);
    assert.equal(stuck.state, 'failed');
    assert.equal(stuck.reason, 'no turn read it within 30 seconds, so Session Watch took it back out of the session\'s queue');
    assert.equal(watch.onTheWay.size, 0);
    // Taken back for real: the queue no longer holds it, the log records the removal, and the next turn never reads it.
    assert.equal(dsh.agents.get('s').inbox.some((m) => m.id === stuck.id), false);
    assert.equal(dsh.sessions.get('s').events.at(-1).type, 'agent/inbox/spliced');
    assert.equal(dsh.sessions.get('s').events.at(-1).data.removedCount, 1);
    dsh.commit('s', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.equal(dsh.sessions.get('s').events.some((e) => e.type === 'user/message' && e.data.id === stuck.id), false);
});

test('watcher: at the timeout, a message a turn has just taken is left for its turn to prove; one left in a session that is not loaded is said to wait there', async () => {
    const { dsh, watch, clock, warnings } = setup({ config: { deliveryTimeoutSeconds: 120 } });
    dsh.write('s', 'Long job');
    const taken = await watch.deliver('s', 'When you can.');
    // The turn's step boundary takes it from the queue just before the timeout; its user/message comes after.
    dsh.agents.get('s').inbox.splice(0);
    await clock.advance(121000);
    assert.equal(taken.state, 'queued', 'not reported failed while its turn may still prove it');
    dsh.commit('s', 'user/message', { id: taken.id, role: 'user', content: [{ type: 'text', text: 'When you can.' }], source: { kind: 'cordis-host-runner' } });
    assert.equal(taken.state, 'delivered');
    // Taken, then never shown: a last look a minute on says so.
    const lost = await watch.deliver('s', 'And this.');
    dsh.agents.get('s').inbox.splice(0);
    await clock.advance(121000 + 61000);
    assert.equal(lost.state, 'failed');
    assert.equal(lost.reason, 'a turn took it from the session\'s queue, but the session\'s log never showed it read');
    // The session is let go before the timeout: the message stays in its saved queue, and that is what is said.
    const left = await watch.deliver('s', 'Last one.');
    dsh.agents.delete('s');
    await clock.advance(121000);
    assert.equal(left.state, 'failed');
    assert.equal(left.reason, 'no turn read it within 2 minutes; it is still in the session\'s queue, which the session reads when it runs again');
    assert.ok(warnings.some((line) => /was not delivered: no turn read it within 2 minutes/.test(line)), 'each one is logged');
});

test('watcher: a queued message DSH lets go unread fails the delivery', async () => {
    const { dsh, watch } = setup();
    dsh.write('s', 'Long job');
    const delivery = await watch.deliver('s', 'Next.');
    watch.onDiscarded(dsh.agents.get('s'), { id: delivery.id });
    assert.equal(delivery.state, 'failed');
    assert.equal(delivery.reason, 'the session let the message go without reading it');
});

test('fold: a session\'s queue from its log, as DSH folds it: one next-turn message per turn, what was claimed and what was let go', () => {
    const msg = (id, text, kind = 'cordis-host-runner') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind } });
    const splice = (data, time = 5) => ({ type: 'agent/inbox/spliced', time, data });
    const events = [
        splice({ target: 'next-turn', start: 0, inserted: [msg('a', 'First   note'), msg('b', 'Second', 'user')] }, 10),
        splice({ target: 'next-step', start: 0, inserted: [msg('c', 'Steer')] }, 11),
        // A turn claims every next-step message and one next-turn message (no outcome); a removal is a let-go.
        splice({ target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 12),
        splice({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }, 12),
        splice({ target: 'next-turn', start: 0, inserted: [msg('d', 'x'.repeat(300))] }, 13),
        splice({ target: 'next-turn', start: 1, removedCount: 1, inserted: [], outcome: 'canceled' }, 14),
        // What DSH would refuse is skipped, never thrown.
        splice({ target: 'next-turn', start: 9, removedCount: 1, inserted: [] }),
        splice({ target: 'elsewhere', start: 0, inserted: [msg('e', 'nope')] }),
        { type: 'agent/inbox/spliced', data: 'junk' },
        null,
    ];
    const inbox = inboxOf(events);
    assert.deepEqual(inbox['next-turn'].map((m) => m.id), ['d']);
    assert.deepEqual(inbox['next-step'], []);
    assert.equal(inbox['next-turn'][0].preview.length, 120, 'a preview is kept short');
    assert.deepEqual(Object.fromEntries([...inbox.gone].map(([id, g]) => [id, g.how])), { c: 'claimed', a: 'claimed', b: 'canceled' });
    assert.deepEqual(inboxOf(events.slice(0, 2))['next-turn'].map((m) => [m.id, m.kind, m.preview, m.at]), [['a', 'cordis-host-runner', 'First note', 10], ['b', 'user', 'Second', 10]]);
    assert.deepEqual(inboxOf(undefined), { 'next-turn': [], 'next-step': [], gone: new Map() });
    // Where a message was read: its index and its turn; none when no turn read it.
    const log = [{ type: 'turn/start', data: { turn: 3 } }, { type: 'user/message', seq: 9, data: { id: 'a' } }, { type: 'turn/end', data: { turn: 3 } }, { type: 'user/message', data: { id: 'z' } }];
    assert.deepEqual(readIn(log, 'a'), { index: 1, turn: 3, seq: 9 });
    assert.deepEqual(readIn(log, 'z'), { index: 3 }, 'outside a turn: no turn named');
    assert.equal(readIn(log, 'nope'), undefined);
    assert.equal(readIn('junk', 'a'), undefined);
});

test('watcher: a message on its way when DSH quits is followed again after the start; a note sent then is read first, with it, in one turn', async () => {
    const dir = tempDir('session-watch');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now, dshQueue: true });
    const first = setup({ dir, clock, dsh });
    dsh.write('s', 'Long migration');
    const noteC = await first.watch.deliver('s', 'Note C: also check the docs.', { from: 'Decisions' });
    assert.deepEqual([noteC.state, noteC.mode, noteC.from], ['queued', 'queue', 'Decisions'], 'queued behind the running turn');
    first.watch.running.flush();
    // DSH quits under the turn: the turn is cut off, and note C stays in the queue DSH saves with the session.
    dsh.stop();
    first.watch.close();
    assert.equal(statSync(join(dir, 'deliveries.jsonl')).mode & 0o777, 0o600, 'the journal is private');
    const second = setup({ dir, clock, dsh });
    await settle();
    await second.watch.restoring;
    const restored = second.watch.deliveryOf(noteC.id);
    assert.deepEqual([restored.state, restored.restored, restored.from, restored.preview], ['queued', true, 'Decisions', 'Note C: also check the docs.']);
    assert.ok(second.events.some((e) => e.type === 'delivery' && e.delivery.id === noteC.id && e.delivery.state === 'queued' && e.delivery.restored === true), 'listeners hear it is followed again');
    assert.ok(second.infos.some((line) => /following a message an earlier run left on its way/.test(line)));
    // cutOffSessions names what still waits in the session's queue, and who sent it.
    const [cut] = await second.watch.cutOffSessions({ withinMs: 0 });
    assert.equal(cut.sessionId, 's');
    assert.deepEqual(cut.queued.map((m) => [m.id, m.preview, m.from, m.kind]), [[noteC.id, 'Note C: also check the docs.', 'Decisions', 'cordis-host-runner']]);
    // The carry-on goes in as Autopilot sends it (no mode): ahead of note C, into the turn that reads them both.
    const carry = await second.watch.deliver('s', 'Turn 1 was cut off: DSH quit. Carry on.');
    assert.deepEqual([carry.mode, carry.waiting], ['steer', 1]);
    assert.ok(second.infos.some((line) => line.includes(`a message ${carry.id} went into s (its next turn, ahead of the message a stop left in its queue)`)), 'logged, with where it went');
    assert.equal((await carry.done).state, 'delivered');
    assert.equal(carry.turn, 2);
    const after = second.watch.deliveryOf(noteC.id);
    assert.deepEqual([after.state, after.turn], ['delivered', 2], 'note C is proven too, in the same turn');
    const log = dsh.sessions.get('s').events;
    const turn2 = log.slice(log.findIndex((e) => e.type === 'turn/start' && e.data.turn === 2));
    assert.deepEqual(turn2.filter((e) => e.type === 'user/message').map((e) => e.data.id), [carry.id, noteC.id], 'the carry-on first, then note C');
    assert.equal(log.some((e) => e.type === 'agent/inbox/spliced' && e.data.outcome === 'canceled'), false, 'nothing taken back');
    await clock.advance(700000);
    assert.deepEqual([second.watch.deliveryOf(carry.id).state, second.watch.deliveryOf(noteC.id).state], ['delivered', 'delivered'], 'no timer undoes either later');
    // The journal keeps both through the next start, newest first.
    second.watch.close();
    const third = setup({ dir, clock, dsh });
    assert.deepEqual(third.watch.deliveries({ sessionId: 's' }).map((d) => [d.id, d.state, d.turn]), [[carry.id, 'delivered', 2], [noteC.id, 'delivered', 2]]);
    assert.equal(third.watch.deliveries({ sessionId: 'other' }).length, 0);
    assert.equal(third.watch.deliveryOf('no-such-id'), undefined);
});

test('watcher: after a crash, each message left on its way is settled from its session\'s log, and listeners hear each one', async () => {
    const dir = tempDir('session-watch');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now, dshQueue: true });
    const first = setup({ dir, clock, dsh });
    const sent = {};
    for (const id of ['read', 'claimed', 'canceled', 'waiting']) {
        dsh.write(id, 'Long work');
        sent[id] = await first.watch.deliver(id, `For ${id}.`);
    }
    const quiet = { quiet: true };
    const inserted = (id) => dsh.sessions.get(id).events.find((e) => e.type === 'agent/inbox/spliced' && e.data.inserted?.[0]?.id === sent[id].id).data.inserted[0];
    // Before the crash, unheard by the watcher: a turn read one; a turn took one and was cut before reading it; one was let go.
    for (const id of ['read', 'claimed']) {
        dsh.commit(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, quiet);
        dsh.commit(id, 'turn/start', { turn: 2 }, quiet);
        dsh.commit(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }, quiet);
        dsh.sessions.get(id).queue['next-turn'].splice(0, 1);
    }
    dsh.commit('read', 'user/message', inserted('read'), quiet);
    dsh.commit('canceled', 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }, quiet);
    dsh.sessions.get('canceled').queue['next-turn'].splice(0, 1);
    // And one the crash came before it went in at all.
    appendFileSync(join(dir, 'deliveries.jsonl'), `${JSON.stringify({ add: { delivery: 'never-in', sessionId: 'waiting', state: 'pending', mode: 'queue', id: 'x-1', at: clock.now() } })}\n`);
    dsh.stop({ crash: true });
    const second = setup({ dir, clock, dsh });
    await settle();
    await second.watch.restoring;
    const now = (id) => second.watch.deliveryOf(id);
    assert.deepEqual([now(sent.read.id).state, now(sent.read.id).turn, now(sent.read.id).restored], ['delivered', 2, true], 'read before the crash: delivered, naming its turn');
    assert.deepEqual([now(sent.claimed.id).state, now(sent.claimed.id).reason], ['failed', 'a turn took it from the session\'s queue, but DSH stopped before that turn read it']);
    assert.deepEqual([now(sent.canceled.id).state, now(sent.canceled.id).reason], ['failed', 'it was taken out of the session\'s queue unread when DSH stopped']);
    assert.deepEqual([now('never-in').state, now('never-in').reason], ['failed', 'DSH stopped before it reached the session\'s queue']);
    assert.equal(now(sent.waiting.id).state, 'queued', 'still in its queue: followed');
    const told = second.events.filter((e) => e.type === 'delivery').map((e) => `${e.delivery.id}:${e.delivery.state}`);
    for (const id of [sent.read.id, sent.claimed.id, sent.canceled.id, 'never-in']) assert.ok(told.some((t) => t.startsWith(`${id}:`)), `${id} is told`);
    assert.ok(second.warnings.some((line) => line.includes('was not delivered (followed again after a stop): it was taken out of the session\'s queue unread when DSH stopped')), 'each one is logged');
    assert.equal(dsh.agents.size, 0, 'nothing was loaded to find out');
    // Nobody runs the waiting one: past its wait it is reported, and where it still is.
    await clock.advance(601000);
    assert.deepEqual([now(sent.waiting.id).state, now(sent.waiting.id).reason], ['failed', 'no turn read it within 10 minutes; it is still in the session\'s queue, which the session reads when it runs again']);
});

test('watcher: switched off, it stops its timers, so nothing is taken back or reported later; on again, it follows the message to its proof', async () => {
    const dir = tempDir('session-watch');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now, dshQueue: true });
    const first = setup({ dir, clock, dsh, config: { deliveryTimeoutSeconds: 30 } });
    dsh.write('s', 'Long job');
    const note = await first.watch.deliver('s', 'When you can.');
    assert.ok(clock.pending().length > 0);
    first.watch.close();
    assert.equal(clock.pending().length, 0, 'every timer stopped');
    await clock.advance(31000);
    assert.equal(note.state, 'queued', 'a watcher switched off reports nothing');
    assert.ok(dsh.sessions.get('s').queue['next-turn'].some((m) => m.id === note.id), 'and takes nothing back');
    // On again in the same DSH, the session still loaded and its turn still running: the new watcher follows it.
    const second = setup({ dir, clock, dsh, config: { deliveryTimeoutSeconds: 30 } });
    await settle();
    await second.watch.restoring;
    assert.equal(second.watch.deliveryOf(note.id).state, 'queued');
    dsh.end('s');
    await settle();
    const proven = second.watch.deliveryOf(note.id);
    assert.deepEqual([proven.state, proven.turn, proven.restored], ['delivered', 2, true]);
});

test('watcher: a question in DSH\'s question box is told to listeners and windows when it is asked and when it is answered', () => {
    const { dsh, watch, events, hub } = setup();
    dsh.write('s', 'Deploy it');
    const from = events.length;
    dsh.commit('s', 'tool/call', { name: 'bash', callId: 'b1' });
    dsh.commit('s', 'tool/result', { message: { toolCallId: 'b1' } });
    assert.equal(events.slice(from).filter((e) => e.type === 'state').length, 0, 'another tool changes no state word: nothing to tell');
    const bumps = hub.snapshot().versions.sessions;
    dsh.commit('s', 'tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ question: 'Which environment?' }] }) });
    const asked = events.filter((e) => e.type === 'state' && e.change === 'tool/call');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].sessionId, 's');
    assert.equal(asked[0].state.asking.question, 'Which environment?');
    assert.equal(watch.rowOf('s').word, 'waiting for your answer');
    assert.ok(hub.snapshot().versions.sessions > bumps, 'the windows are told');
    dsh.commit('s', 'tool/call', { name: 'bash', callId: 'b2' });
    assert.equal(events.filter((e) => e.type === 'state' && e.change === 'tool/call').length, 1, 'told once while it waits');
    dsh.commit('s', 'tool/result', { message: { toolCallId: 'q1' } });
    const answered = events.filter((e) => e.type === 'state' && e.change === 'tool/result');
    assert.equal(answered.length, 1);
    assert.equal(answered[0].state.asking, undefined);
    assert.equal(watch.rowOf('s').word, 'running');
});

test('watcher: a graceful stop and a crash both leave sessions it finds as cut off, checked against their logs', async () => {
    const dir = tempDir('session-watch');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const first = setup({ dir, clock, dsh });
    dsh.write('graceful', 'Long build');
    dsh.write('crash', 'Long test run');
    dsh.write('child', 'Subagent work');
    dsh.sessions.get('child').parentSessionId = 'crash';
    dsh.write('answered', 'Some work');
    dsh.write('old', 'Old work');
    first.watch.running.flush();
    const running = JSON.parse(readFileSync(join(dir, 'running.json'), 'utf8'));
    assert.deepEqual(Object.keys(running.sessions).sort(), ['answered', 'child', 'crash', 'graceful', 'old']);
    assert.equal(statSync(join(dir, 'running.json')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    // The crash: DSH dies under every running turn; then a graceful quit ends 'graceful' (as DSH does at a later stop).
    dsh.stop({ crash: true });
    dsh.commit('graceful', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } });
    // Someone answered in 'answered' after the cut; 'old' was cut off long ago.
    dsh.commit('answered', 'turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    await clock.advance(1000);
    dsh.commit('answered', 'user/message', dsh.message('I will take it from here.'));
    dsh.commit('old', 'turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    dsh.sessions.get('old').events.at(-1).time = clock.now() - 8 * 3600000;
    // A new process: a new watcher over the same folder and sessions.
    const second = setup({ dir, clock, dsh });
    assert.deepEqual(Object.keys(second.watch.leftRunning).sort(), ['answered', 'child', 'crash', 'graceful', 'old']);
    const found = await second.watch.cutOffSessions({ withinMs: 6 * 3600000 });
    const ids = found.map((item) => item.sessionId).sort();
    assert.deepEqual(ids, ['crash', 'graceful']);
    const crash = found.find((item) => item.sessionId === 'crash');
    assert.equal(crash.end.kind, 'interrupted', 'a cold read closes the open turn as interrupted');
    assert.equal(found.find((item) => item.sessionId === 'graceful').end.cause, 'disposed');
    assert.equal(crash.title, '');
    assert.equal(crash.cwd, '/work/crash');
    // Nothing loaded the agents to find them.
    assert.equal(dsh.agents.size, 0);
});

test('watcher: after a stop, a session the last run left running reads as its log has it, not as DSH saved it before the stop', async () => {
    const dir = tempDir('session-watch');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const first = setup({ dir, clock, dsh });
    dsh.write('quit', 'Long migration');
    dsh.write('crash', 'Long import');
    first.watch.running.flush();
    // A quit ends both turns in the log (aborted, disposed); then the crash's end is lost, as SIGKILL loses it.
    dsh.stop();
    dsh.sessions.get('crash').events.pop();
    // What DSH's list still has for them is from before their turns: nothing saved, and "blank".
    for (const id of ['quit', 'crash']) Object.assign(dsh.sessions.get(id), { saved: undefined, blank: true });
    const second = setup({ dir, clock, dsh });
    const bumps = second.hub.versions.sessions ?? 0;
    await second.watch.list();
    await second.watch.readLeftRunning();
    const rows = await second.watch.list(undefined, { maxAgeMs: 0 });
    const quit = rows.find((row) => row.sessionId === 'quit');
    const crash = rows.find((row) => row.sessionId === 'crash');
    assert.equal(quit.word, 'cut off');
    assert.equal(quit.state.end.kind, 'aborted');
    assert.equal(quit.status, 'cold');
    assert.equal(crash.word, 'cut off');
    assert.equal(crash.state.end.kind, 'interrupted', 'a cold read closes the open turn as interrupted');
    assert.ok(second.hub.versions.sessions > bumps, 'the windows are told');
    // Read once per start, without loading the agents; cutOffSessions finds both from those reads.
    const found = await second.watch.cutOffSessions({ withinMs: 0 });
    assert.deepEqual(found.map((item) => item.sessionId).sort(), ['crash', 'quit']);
    assert.equal(dsh.agents.size, 0);
    // Another start, with nothing run in between: DSH's values are still from before; the rows still read as the logs have them.
    second.watch.close();
    const third = setup({ dir, clock, dsh });
    await third.watch.list();
    await third.watch.readLeftRunning();
    assert.deepEqual((await third.watch.list(undefined, { maxAgeMs: 0 })).filter((row) => ['quit', 'crash'].includes(row.sessionId)).map((row) => row.word), ['cut off', 'cut off']);
    assert.deepEqual(Object.keys(third.watch.leftRunning), [], 'only the last run\'s turns are candidates for a carry-on');
    // Once a turn ends there, DSH saves its values again, and it is no longer kept to fold.
    dsh.write('quit', 'Carry on.');
    dsh.end('quit');
    third.watch.close();
    const kept = JSON.parse(readFileSync(join(dir, 'running.json'), 'utf8'));
    assert.deepEqual(Object.keys(kept.unsaved), ['crash']);
    assert.deepEqual(kept.sessions, {});
});

test('watcher: running.json follows turns, so a clean stop leaves nothing to resume', async () => {
    const { dsh, watch, dir } = setup();
    dsh.write('s', 'Work');
    assert.ok(watch.running.data.sessions.s);
    dsh.end('s');
    assert.equal(watch.running.data.sessions.s, undefined);
    watch.close();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'running.json'), 'utf8')).sessions, {});
});

test('watcher: tells listeners of turns, states and status, and a listener that throws stops nothing', async () => {
    const { dsh, watch, events, warnings, hub } = setup();
    watch.on(() => { throw new Error('boom'); });
    watch.on(async () => { throw new Error('async boom'); });
    dsh.write('s', 'Work');
    dsh.end('s', { kind: 'completed' }, { todos: [{ content: 'A', status: 'pending' }] });
    await settle();
    const types = events.map((event) => event.type);
    assert.ok(types.includes('agent'));
    assert.ok(types.includes('turn-start'));
    assert.ok(types.includes('turn-end'));
    assert.ok(types.includes('status'));
    const end = events.find((event) => event.type === 'turn-end');
    assert.equal(end.end.kind, 'completed');
    assert.equal(end.state.todos.open, 1, 'the turn end carries the state after the turn');
    assert.ok(events.some((event) => event.type === 'state' && event.change === 'todo/write'));
    assert.match(warnings.join('\n'), /a listener failed on turn-start: boom/);
    assert.match(warnings.join('\n'), /async boom/);
    assert.ok(hub.snapshot().versions.sessions > 0, 'windows hear of it through the hub');
});

test('watcher: questions for a person are raised, answered once, and dropped', async () => {
    const { watch, hub, warnings } = setup();
    const answers = [];
    const ask = watch.raiseAsk({ id: 'q1', sessionId: 's', source: 'Test', question: 'Go?', recommendation: 'Yes', onAnswer: (answer, by) => { answers.push([answer, by]); return { sent: true }; } });
    assert.equal(ask.onAnswer, undefined, 'windows never see the handler');
    assert.equal(watch.asks().length, 1);
    assert.ok(hub.snapshot().versions.asks >= 1);
    assert.deepEqual(await watch.answerAsk('q1', 'yes', 'you'), { ok: true, sent: true });
    assert.deepEqual(answers, [['yes', 'you']]);
    assert.deepEqual(await watch.answerAsk('q1', 'yes'), { ok: false, error: 'This question is no longer waiting.' });
    watch.raiseAsk({ id: 'q2', question: 'Again?', onAnswer: () => { throw new Error('the session is gone'); } });
    assert.deepEqual(await watch.answerAsk('q2', 'go'), { ok: false, error: 'the session is gone' });
    assert.match(warnings.join('\n'), /the answer to q2 failed/);
    watch.raiseAsk({ id: 'q3', question: 'Third?' });
    assert.equal(watch.dropAsk('q3'), true);
    assert.equal(watch.dropAsk('q3'), false);
    assert.throws(() => watch.raiseAsk({ question: 'No id' }), /needs an id and a question/);
});

test('watcher: what became of an answer is told once its asker knows', () => {
    const { watch } = setup();
    const events = [];
    watch.on((event) => events.push(event));
    assert.equal(watch.askOutcome('q1', { state: 'delivered', text: 'Its transcript shows it.', by: 'Agent Terminals', sessionId: 's' }), true);
    const [told] = events;
    assert.deepEqual({ ...told, outcome: { ...told.outcome, at: 0 } }, { type: 'ask', change: 'outcome', id: 'q1', sessionId: 's', outcome: { state: 'delivered', text: 'Its transcript shows it.', by: 'Agent Terminals', at: 0 } });
    assert.ok(told.outcome.at > 0);
    for (const state of ['not proven', 'not delivered', 'typed in']) assert.equal(watch.askOutcome('q1', { state }), true, state);
    assert.equal(watch.askOutcome('q1', { state: 'sent' }), false, 'a word Decisions would not know');
    assert.equal(watch.askOutcome(7, { state: 'delivered' }), false);
    assert.equal(watch.askOutcome('q1', null), false);
    assert.equal(events.length, 4);
    assert.equal(watch.askOutcome('q1', { state: 'delivered', text: 'x'.repeat(900) }) && events.at(-1).outcome.text.length, 600, 'its words are kept short');
});

test('watcher: an outside agent\'s state shows with its session', async () => {
    const { dsh, watch } = setup();
    dsh.add('t', { title: 'Terminal' });
    watch.setExternal('t', { status: 'waiting on you', label: 'coding agent' });
    assert.equal((await watch.get('t')).word, 'waiting on you');
    watch.setExternal('t', null);
    assert.equal(watch.rowOf('t').external, undefined);
});

test('watcher: a question its plugin refuses for now (switched off, a setting to fix) stays, and the refusal is said', async () => {
    const { watch } = setup();
    let refuse = true;
    watch.raiseAsk({ id: 'q', sessionId: 's', source: 'Test', question: 'Go?', onAnswer: () => { if (refuse) throw Object.assign(new Error('Test is off: switch it on first.'), { refused: true }); return { sent: true }; } });
    const changes = [];
    watch.on((event) => { if (event.type === 'ask') changes.push(event.change); });
    assert.deepEqual(await watch.answerAsk('q', 'go'), { ok: false, error: 'Test is off: switch it on first.', refused: true });
    assert.deepEqual(watch.asks().map((ask) => ask.id), ['q'], 'still waiting');
    assert.deepEqual(changes, ['answered', 'kept']);
    refuse = false;
    assert.deepEqual(await watch.answerAsk('q', 'go'), { ok: true, sent: true });
    assert.deepEqual(watch.asks(), []);
});

test('settings: a wrong delivery wait is named in words, and the watcher keeps its default until it is fixed', () => {
    assert.doesNotThrow(() => checkConfig(DEFAULTS));
    assert.throws(() => checkConfig({ deliveryTimeoutSeconds: 5 }), (error) => error.key === 'deliveryTimeoutSeconds'
        && error.message === 'How long a message may wait to be read (deliveryTimeoutSeconds) must be a whole number of seconds from 10 to 86400 (it is 5)');
    assert.deepEqual([...LIVE_SETTINGS], ['deliveryTimeoutSeconds']);
    let value = 5;
    const settings = liveSettings({ deliveryTimeoutSeconds: { get: () => value } });
    const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'session-watch' });
    check.run();
    assert.equal(check.problem.live, true);
    const usable = usableSettings(settings, check);
    assert.equal(usable.deliveryTimeoutSeconds, 600, 'the default while it is wrong: every suite plugin needs the watcher');
    value = 120;
    check.run();
    assert.equal(usable.deliveryTimeoutSeconds, 120);
});

test('settings in Plugins: Session Watch\'s page there has its one setting, in DSH\'s own form', () => {
    const edits = [];
    class SettingsFormModel {
        constructor(scope, specs) { this.scope = scope; this.specs = specs; }
        bind(project) { return { subscribe: () => () => {}, getSnapshot: () => project() }; }
        shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }; }
        field(name) { return { text: this.specs.find((spec) => spec.field === name).format(600), overridden: false, invalid: false }; }
        actions() { return { edit: (field, text) => edits.push([field, text]), resetField: () => {}, save: () => {}, discard: () => {} }; }
        dispose() {}
    }
    const ui = { SettingsFormModel, SettingsForm: (props) => ({ type: 'SettingsForm', props, children: props.children }), SettingsSecretField: () => null };
    const { id, client } = loadClient(new URL('../plugins/session-watch/lib/client.js', import.meta.url), { ui });
    assert.equal(id, 'dsh-plugin-session-watch');
    const registered = [];
    const effects = [];
    const scope = {
        configForms: { get: (entry) => ({ entry }), whileServed: (entries, fn) => (entries[0] === 'session-watch' ? fn() : undefined) },
        // As in DSH: Session Watch injects no key store, and reading one it did not inject throws.
        remote: strictRemote(),
        slots: { inject: (_name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        effect: (fn) => { effects.push(fn); },
        inject: (names, fn) => { if (names[0] === 'configForms') fn(scope); },
    };
    client.apply(scope);
    for (const fn of effects) fn();
    const entry = registered.find((r) => r.spec.name === 'plugins.bundle.config');
    assert.equal(entry.spec.key, 'dsh-plugin-session-watch');
    // Under it, on the same page only: what it watches.
    const section = registered.find((r) => r.spec.name === 'plugins.detail.section');
    assert.equal(section.spec.id, 'dsh-plugin-session-watch:watching');
    const own = { name: 'dsh-plugin-session-watch', enabled: true, installed: true, official: false, rows: [] };
    assert.equal(section.component({ subject: { kind: 'bundle', pkg: { ...own, name: 'dsh-plugin-autopilot' } } }), null);
    assert.equal(section.component({ subject: { kind: 'row', pkg: own, row: { rowId: 'session-watch', moduleName: 'dsh-plugin-session-watch', enabled: true } } }), null);
    assert.equal(section.component({ subject: { kind: 'item', id: 'x' } }), null);
    assert.match(textIn(section.component({ subject: { kind: 'bundle', pkg: own } })), /^What it watchesReading the sessions/);
    assert.match(entry.component({ view: 'summary' }), /^How long a message from Autopilot, Decisions or Agent Terminals may wait to be read/);
    const page = entry.component({});
    const [field] = elementsOf(page).filter((e) => e.type === 'SettingsValueField');
    assert.equal(field.props.label, 'How long a message may wait to be read, in seconds');
    assert.equal(field.props.text, '600');
    assert.equal(field.props.invalidLabel, 'A whole number from 10 to 86400, or empty for the default (600).');
    field.props.onEdit('120');
    assert.deepEqual(edits, [['deliveryTimeoutSeconds', '120']]);
    assert.match(textIn(page), /they stop working while it is off/);
    const spec = client.internals.kit.fieldSpec(client.internals.SETTINGS[0]);
    assert.equal(spec.parse('5'), undefined);
    assert.equal(JSON.stringify(spec.parse('86400')), '{"kind":"set","value":86400}');
});

test('its page in Plugins: what it watches, by state word, which plugins read through it, and what a wrong setting means meanwhile', async () => {
    const { client } = loadClient(new URL('../plugins/session-watch/lib/client.js', import.meta.url));
    const { kit, wordCounts, usersOf, readWatching, WatchingView } = client.internals;
    // Values made in the client's own realm, compared as plain data.
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const rows = [{ word: 'idle' }, { word: 'running' }, { word: 'cut off' }, { word: 'idle' }, { word: 'waiting for approval' }, { word: 'new' }, {}];
    // What waits on a person first, then what runs, then the rest; a row without a word is counted, not dropped.
    assert.deepEqual(plain(wordCounts(rows)), [
        { word: 'waiting for approval', count: 1 }, { word: 'cut off', count: 1 }, { word: 'running', count: 1 },
        { word: 'idle', count: 2 }, { word: 'new', count: 1 }, { word: 'unknown', count: 1 },
    ]);
    const list = [
        { moduleName: 'dsh-plugin-autopilot', enabled: true, fiberPhase: 'active' },
        { moduleName: 'dsh-plugin-decisions', enabled: false, fiberPhase: 'pending' },
        { moduleName: 'dsh-plugin-agent-terminals', enabled: true, fiberPhase: 'failed' },
    ];
    assert.deepEqual(plain(usersOf(list).map((u) => `${u.name}: ${u.state}`)), ['Autopilot: on', 'Decisions: off', 'Agent Terminals: not running']);
    assert.deepEqual(plain(usersOf(list.slice(0, 1)).map((u) => u.state)), ['on', 'not installed', 'not installed']);
    assert.equal(usersOf(undefined), undefined, 'a DSH that cannot say: the line is left out');
    // Read from its own endpoints and DSH's plugin list, over the window's connection.
    const calls = [];
    let pluginsAnswer = { ok: true, value: list };
    kit.setConnection({ rpc: { call: async (_api, method) => {
        calls.push(method);
        if (method === 'dsh-plugin-session-watch/sessions') return { ok: true, value: { items: rows } };
        if (method === 'dsh-plugin-session-watch/status') return { ok: true, value: { running: true, problem: { text: 'How long a message may wait to be read (deliveryTimeoutSeconds) must be a whole number of seconds from 10 to 86400 (it is "600")', key: 'deliveryTimeoutSeconds', live: true } } };
        return pluginsAnswer;
    } } });
    const data = await readWatching();
    assert.deepEqual(calls.sort(), ['dsh-plugin-session-watch/sessions', 'dsh-plugin-session-watch/status', 'pluginManager/listPlugins']);
    assert.equal(data.total, 7);
    assert.equal(data.problem.key, 'deliveryTimeoutSeconds');
    const view = WatchingView({ data });
    const text = textIn(view);
    assert.match(text, /^What it watches7 sessions · 1 running/);
    assert.deepEqual(plain(elementsOf(view).filter((e) => e.type === 'Tag').map((e) => `${e.props.tone}:${textIn(e)}`).slice(0, 3)), ['warning:waiting for approval', 'warning:cut off', 'info:running']);
    assert.match(text, /Autopilot, Decisions and Agent Terminals read sessions through it\. Autopilot is on, Decisions is off and Agent Terminals is not running\./);
    assert.match(text, /Until the setting above is fixed, a message may wait the default 10 minutes to be read\./);
    assert.equal(elementsOf(view)[0].props['aria-labelledby'], 'dshsw-watching-title');
    // DSH's plugin list not there: the users line is left out, the rest stays.
    pluginsAnswer = { ok: false, error: { code: 'x', message: 'no list' } };
    const without = await readWatching();
    assert.equal(without.users, undefined);
    assert.doesNotMatch(textIn(WatchingView({ data: without })), /read sessions through it/);
    // None yet, loading, and an error with what to do.
    assert.match(textIn(WatchingView({ data: { total: 0, words: [], users: undefined } })), /^What it watchesnone yetNo sessions yet\. Each new session shows here as soon as DSH makes it\.$/);
    assert.match(textIn(WatchingView({})), /Reading the sessions/);
    const failed = WatchingView({ error: 'Session Watch is not running in DSH.', onRetry: () => {} });
    assert.match(textIn(failed), /Couldn't read the sessions: Session Watch is not running in DSH\.Retry/);
    kit.setConnection(undefined);
});

test('its page in Plugins: past twelve, "Show N more" lists the next twelve; the headline counts what waits on you; the states are one tab stop with arrow keys', () => {
    const { client } = loadClient(new URL('../plugins/session-watch/lib/client.js', import.meta.url));
    const { WatchingView, ChosenView, SHOWN, moveAmong } = client.internals;
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const at = Date.now() - 60000;
    const rows = Array.from({ length: 2 * SHOWN + 3 }, (_, i) => ({ sessionId: `s${i}`, title: `Session ${i}`, word: 'idle', updatedAt: at - i * 1000 }));
    // Twelve first, then "Show 12 more", then the last three, then all.
    const more = [];
    const first = ChosenView({ word: 'idle', rows, onOpen: () => {}, onMore: (next, from) => more.push([next, from]) });
    assert.equal(elementsOf(first).filter((e) => e.type === 'li').length, SHOWN);
    const button = (view) => elementsOf(view).find((e) => e.type === 'button' && e.props['data-session-watch-more'] !== undefined);
    assert.equal(textIn(button(first)), `Show ${SHOWN} more`);
    const status = (view) => elementsOf(view).find((e) => e.props?.role === 'status');
    assert.equal(textIn(status(first)), `12 of ${rows.length} shown, newest first.`, 'said in a status line, so a screen reader hears it');
    button(first).props.onClick();
    assert.deepEqual(plain(more), [[2 * SHOWN, SHOWN]], 'it asks for twelve more and says where the new ones start, for the focus');
    const second = ChosenView({ word: 'idle', rows, onOpen: () => {}, limit: 2 * SHOWN, onMore: () => {} });
    assert.equal(elementsOf(second).filter((e) => e.type === 'li').length, 2 * SHOWN);
    assert.equal(textIn(button(second)), 'Show 3 more', 'the last press names how many are left');
    const all = ChosenView({ word: 'idle', rows, onOpen: () => {}, limit: 3 * SHOWN, onMore: () => {} });
    assert.equal(elementsOf(all).filter((e) => e.type === 'li').length, rows.length);
    assert.equal(button(all), undefined, 'none left: the button goes');
    assert.equal(textIn(status(all)), `All ${rows.length} shown.`);
    assert.equal(elementsOf(ChosenView({ word: 'idle', rows: rows.slice(0, SHOWN), onMore: () => {} })).some((e) => e.props?.role === 'status'), false, 'twelve or fewer: no line about it');
    // The section passes its limit to the chosen list.
    const data = { total: rows.length + 3, words: [{ word: 'waiting for approval', count: 1 }, { word: 'waiting for your answer', count: 1 }, { word: 'running', count: 1 }, { word: 'idle', count: rows.length }], rows };
    const view = WatchingView({ data, chosen: 'idle', limit: 2 * SHOWN, onMore: () => {} });
    assert.equal(elementsOf(view).filter((e) => e.type === 'li' && e.props.className === 'dshsw-session').length, 2 * SHOWN);
    // The headline: how many run, and how many wait on a person (approval, an answer, an outside agent's "waiting on you").
    assert.match(textIn(view), new RegExp(`^What it watches${rows.length + 3} sessions · 1 running · 2 waiting on you`));
    assert.match(textIn(WatchingView({ data: { ...data, words: data.words.slice(2) } })), new RegExp(`^What it watches${rows.length + 3} sessions · 1 running(?! ·)`), 'nobody waited on: the part is left out');
    // One tab stop for the state buttons: the one last focused, else the chosen one, else the first.
    const chips = (v) => elementsOf(v).filter((e) => e.type === 'button' && e.props.className === 'dshsw-word');
    const stops = (v) => plain(chips(v).map((b) => b.props.tabIndex));
    assert.deepEqual(stops(WatchingView({ data })), [0, -1, -1, -1]);
    assert.deepEqual(stops(WatchingView({ data, chosen: 'idle' })), [-1, -1, -1, 0]);
    assert.deepEqual(stops(WatchingView({ data, chosen: 'idle', current: 'running' })), [-1, -1, 0, -1]);
    assert.deepEqual(stops(WatchingView({ data, current: 'gone' })), [0, -1, -1, -1], 'a word no longer shown: the first');
    const toolbar = elementsOf(view).find((e) => e.props?.['aria-label'] === 'Sessions by state');
    assert.equal(toolbar.props.role, 'toolbar');
    assert.deepEqual(plain(elementsOf(toolbar).filter((e) => e.type === 'li').map((e) => e.props.role)), ['none', 'none', 'none', 'none']);
    const moved = [];
    chips(WatchingView({ data, onMove: (word) => moved.push(word) }))[2].props.onFocus();
    assert.deepEqual(moved, ['running'], 'a button that takes the focus holds the tab stop');
    // Arrows, Home and End move the focus among them, around the ends; other keys are left alone.
    const focused = [];
    const buttons = [0, 1, 2, 3].map((i) => ({ focus: () => focused.push(i) }));
    const press = (key, from, extra = {}) => {
        let prevented = false;
        moveAmong({ key, target: buttons[from], currentTarget: { querySelectorAll: () => buttons }, preventDefault: () => { prevented = true; }, ...extra });
        return prevented;
    };
    assert.equal(press('ArrowRight', 0), true);
    press('ArrowDown', 3);
    press('ArrowLeft', 0);
    press('ArrowUp', 2);
    press('Home', 2);
    press('End', 1);
    assert.deepEqual(focused, [1, 0, 3, 1, 0, 3]);
    assert.equal(press('Enter', 1), false);
    assert.equal(press('a', 1), false);
    assert.equal(press('ArrowRight', 1, { altKey: true }), false);
    assert.deepEqual(focused, [1, 0, 3, 1, 0, 3], 'Enter, letters and modified arrows do not move it');
    assert.equal(toolbar.props.onKeyDown, moveAmong);
});

test('its page in Plugins: choosing a state lists the sessions that read it, newest first, each with Open; choosing it again closes the list', async () => {
    const { client } = loadClient(new URL('../plugins/session-watch/lib/client.js', import.meta.url));
    const { kit, readWatching, WatchingView, SHOWN, views } = client.internals;
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const at = Date.now() - 5 * 60000;
    const idle = Array.from({ length: SHOWN + 2 }, (_, i) => ({ sessionId: `idle-${i}`, title: `Idle ${i}`, word: 'idle', updatedAt: at - i * 1000 }));
    // DSH's list order is not the newest change first: the list sorts by when each session last changed.
    const items = [{ sessionId: 'cut', title: '', word: 'cut off', updatedAt: at }, ...idle, { sessionId: 'late', title: 'Late', word: 'idle', updatedAt: at + 1000 }, { title: 'no id', word: 'idle' }];
    kit.setConnection({ rpc: { call: async (_api, method) => (method === 'dsh-plugin-session-watch/sessions' ? { ok: true, value: { items } }
        : method === 'dsh-plugin-session-watch/status' ? { ok: true, value: { running: true } } : { ok: true, value: [] }) } });
    const data = await readWatching();
    kit.setConnection(undefined);
    // A row without a session id is counted but cannot be listed or opened.
    assert.equal(data.total, items.length);
    assert.equal(data.rows.length, items.length - 1);
    const chips = (view) => elementsOf(view).filter((e) => e.type === 'button' && e.props.className === 'dshsw-word');
    const picks = [];
    const closed = WatchingView({ data, onChoose: (word) => picks.push(word) });
    assert.deepEqual(plain(chips(closed).map((b) => `${textIn(b)}:${b.props['aria-expanded']}`)), ['cut off1:false', `idle${SHOWN + 4}:false`]);
    assert.equal(chips(closed)[1].props.title, `Show the ${SHOWN + 4} sessions that read idle`);
    assert.equal(chips(closed)[1].props['aria-controls'], undefined);
    assert.equal(elementsOf(closed).some((e) => e.props?.['data-session-watch-chosen'] !== undefined), false, 'nothing listed until a state is chosen');
    chips(closed)[1].props.onClick();
    assert.deepEqual(picks, ['idle']);
    // Chosen: its button says so and names the list; the list shows the newest, each with when and Open.
    const opened = [];
    const chosen = WatchingView({ data, chosen: 'idle', onChoose: (word) => picks.push(word), onOpen: (id) => opened.push(id) });
    const [, button] = chips(chosen);
    assert.equal(button.props['aria-expanded'], 'true');
    assert.equal(button.props['aria-controls'], 'dshsw-chosen');
    assert.equal(button.props.title, 'Hide these sessions');
    const list = elementsOf(chosen).find((e) => e.props?.['data-session-watch-chosen'] === 'idle');
    assert.equal(list.props.id, 'dshsw-chosen');
    assert.equal(elementsOf(list).find((e) => e.type === 'ul').props['aria-label'], 'Sessions that read idle');
    const rows = elementsOf(list).filter((e) => e.type === 'li');
    assert.equal(rows.length, SHOWN);
    assert.deepEqual(plain(rows.slice(0, 3).map(textIn)), ['Late5 min agoOpen', 'Idle 05 min agoOpen', 'Idle 15 min agoOpen']);
    assert.equal(elementsOf(rows[1]).find((e) => e.type === 'time').props.dateTime, new Date(at).toISOString());
    // Past twelve: how many are shown, and a button for the next twelve (here the last three).
    assert.match(textIn(list), /12 of 15 shown, newest first\.$/, 'without a way to show more, it says how many are shown');
    const open = elementsOf(rows[2]).find((e) => e.type === 'button');
    assert.equal(open.props['aria-label'], 'Open Idle 1');
    open.props.onClick();
    assert.deepEqual(opened, ['idle-1']);
    button.props.onClick();
    assert.deepEqual(picks, ['idle', undefined], 'choosing the open state again closes it');
    const hows = [];
    chips(WatchingView({ data, chosen: 'running', onChoose: (word, how) => hows.push([word, how?.gone]) }))[1].props.onClick();
    chips(WatchingView({ data, chosen: 'idle', onChoose: (word, how) => hows.push([word, how?.gone]) }))[1].props.onClick();
    assert.deepEqual(plain(hows), [[null, true], [null, false]], 'closing a state at 0 says its button goes, so the focus can move');
    // An untitled session says so; without DSH's workspace there is no Open.
    const cutList = elementsOf(WatchingView({ data, chosen: 'cut off' })).find((e) => e.props?.['data-session-watch-chosen'] === 'cut off');
    assert.equal(textIn(cutList), 'Untitled session5 min ago');
    assert.equal(elementsOf(cutList).some((e) => e.type === 'button'), false);
    // A chosen state whose last session left it stays in its place, at 0, and says so (the focus stays on it).
    const gone = WatchingView({ data, chosen: 'running' });
    assert.deepEqual(plain(chips(gone).map((b) => `${textIn(b)}:${b.props['aria-expanded']}`)), ['cut off1:false', 'running0:true', `idle${SHOWN + 4}:false`]);
    const none = elementsOf(gone).find((e) => e.props?.['data-session-watch-chosen'] === 'running');
    assert.equal(textIn(none), 'No session reads running now.');
    assert.equal(elementsOf(none).find((e) => e.type === 'p').props.role, 'status');
    assert.deepEqual(plain(client.internals.wordsWith([{ word: 'idle', count: 2 }], 'odd').map((w) => w.word)), ['idle', 'odd'], 'a word the section does not know goes last');
    assert.equal(elementsOf(WatchingView({ data: { total: 0, words: [], rows: [] }, chosen: 'idle' })).some((e) => e.props?.['data-session-watch-chosen'] !== undefined), false, 'no sessions at all: only "No sessions yet"');
    // Open goes through DSH's workspace, from the time it is there until it goes.
    const shown = [];
    const cleanups = [];
    const scope = {
        uiWorkspace: { openSession: (id) => { shown.push(id); if (id === 'bad') throw new Error('no such session'); } },
        slots: { inject: () => {}, register: () => () => {} },
        effect: (fn) => { const undo = fn(); if (typeof undo === 'function') cleanups.push(undo); },
        inject: (names, fn) => { if (names[0] === 'uiWorkspace') fn(scope); },
    };
    const warned = [];
    const { client: wired } = loadClient(new URL('../plugins/session-watch/lib/client.js', import.meta.url), { console: { ...console, warn: (...args) => warned.push(args.map(String).join(' ')) } });
    assert.equal(wired.internals.views.openSession, undefined);
    wired.apply(scope);
    wired.internals.views.openSession('s1');
    wired.internals.views.openSession('');
    wired.internals.views.openSession('bad');
    assert.deepEqual(shown, ['s1', 'bad']);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /could not open the session/);
    for (const undo of cleanups) undo();
    assert.equal(wired.internals.views.openSession, undefined);
    assert.equal(views.openSession, undefined, 'each window load has its own');
});
