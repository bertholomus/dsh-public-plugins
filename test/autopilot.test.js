// Autopilot (plugins/autopilot): its engine over the real session watcher and a stand-in DSH, its notes, its
// page's view and its browser half. index.js and remote.js need DSH's own packages; they run end to end in
// DSH Test (scripts/e2e.mjs autopilot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Pilot, RULES, hasOpenWork, markOf, parseData, progressed } from '../plugins/autopilot/lib/pilot.js';
import { actionLabel, answerNote, carryOnNote, errorNote, nudgeNote, openWork, question, whyBackOff, whyResume } from '../plugins/autopilot/lib/notes.js';
import { lastWords, pageState } from '../plugins/autopilot/lib/page.js';
import { DEFAULTS as CONFIG_DEFAULTS, LIVE_SETTINGS, SETTING_TITLES, changedWords, checkConfig, savedEntry } from '../plugins/autopilot/lib/config.js';
import { SettingsCheck, liveSettings } from '../plugins/autopilot/lib/shared/settings.js';
import { JsonStore } from '../plugins/autopilot/lib/shared/files.js';
import { Journal } from '../plugins/autopilot/lib/shared/journal.js';
import { Hub } from '../plugins/autopilot/lib/shared/hub.js';
import { SessionWatch } from '../plugins/session-watch/lib/watch.js';
import { fakeDsh } from './helpers/fake-dsh.mjs';
import { manualClock, settle } from './helpers/clock.mjs';
import { OTHER_NAMES, loadClient, elementsOf, strictRemote, textIn } from './helpers/client.mjs';
import { tempDir } from './helpers/temp.mjs';

/** Autopilot's defaults (lib/index.js Config). */
const DEFAULTS = Object.freeze({
    enabled: true, defaultRule: 'auto', resumeAfterRestart: true, resumeWindowHours: 6, idleSeconds: 600, idleWindowHours: 2,
    maxNudges: 2, maxNotesPerHour: 20, errorRetrySeconds: [120, 600, 1800], startDelaySeconds: 20,
});

const TODOS = [
    { content: 'Write the lexer', status: 'completed' },
    { content: 'Write the parser', status: 'in_progress' },
    { content: 'Add tests', status: 'pending' },
];
const MIN = 60000;

/** Autopilot and the watcher over a stand-in DSH, all on one hand-moved clock. */
function setup({ config = {}, dir = tempDir('autopilot'), clock = manualClock(), dsh = fakeDsh({ now: clock.now }), start = true, settingsOk } = {}) {
    const warnings = [];
    const logger = { info: () => {}, warn: (line) => warnings.push(line) };
    const hub = new Hub();
    let n = 0;
    const watch = new SessionWatch({
        ctx: dsh.ctx, config: { deliveryTimeoutSeconds: 600 }, logger, hub, dir: join(dir, 'session-watch'), after: clock.after, now: clock.now,
        makeMessage: (body) => ({ id: `note-${dir.length}-${++n}`, role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'cordis-host-runner' } }),
    });
    dsh.attach(watch);
    const store = new JsonStore(join(dir, 'autopilot', 'state.json'), { parse: parseData, logger, delayMs: 5 });
    const journal = new Journal(join(dir, 'autopilot', 'events.jsonl'), { logger, now: clock.now, onChange: () => hub.bump('autopilot') });
    const notified = [];
    const merged = { ...DEFAULTS, ...config };
    const pilot = new Pilot({ watch, config: merged, store, journal, logger, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, notify: (item) => notified.push(item), ...(settingsOk ? { settingsOk } : {}) });
    if (start) pilot.start();
    return { dir, clock, dsh, watch, pilot, store, journal, notified, warnings, hub, config: merged };
}

/** The notes Autopilot put into a session, as the session's own log shows them. */
const notesIn = (dsh, id) => dsh.sessions.get(id).events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'cordis-host-runner').map((event) => event.data.content[0].text);
const entries = (journal, kind) => journal.list({ limit: 400 }).filter((entry) => !kind || entry.kind === kind);
/** The elements of a drawn tree that carry an attribute. */
const withAttr = (tree, name) => elementsOf(tree).filter((e) => e.props?.[name] !== undefined);

/** A session the person started, whose turn ended with open todos. */
function idleWithTodos(dsh, id = 's', { reply = 'Lexer done; the parser is next.', title = 'Build the parser' } = {}) {
    dsh.add(id, { title });
    dsh.write(id, 'Build the parser, with tests.');
    dsh.end(id, { kind: 'completed' }, { reply, todos: TODOS });
}

// ── Idle with open work ──────────────────────────────────────────────

test('idle with open todos: one note after the quiet time, proven delivered by the session\'s own log', async () => {
    const { dsh, clock, journal } = setup();
    idleWithTodos(dsh);
    await clock.advance(9 * MIN);
    assert.deepEqual(notesIn(dsh, 's'), [], 'nothing before the quiet time');
    await clock.advance(1 * MIN);
    const notes = notesIn(dsh, 's');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^\[Autopilot\] You stopped with 2 open todos \(next: “Write the parser”\)\. Carry on with the next one/);
    assert.match(notes[0], /DECISION NEEDED: <question> — recommend: <your pick>/);
    const [entry] = entries(journal, 'nudge');
    assert.equal(entry.state, 'delivered', 'the log shows it read into a turn, not just sent');
    assert.equal(entry.turn, 2);
    assert.equal(entry.note, notes[0]);
    assert.match(entry.why, /^It has been idle for 10 minutes after turn 1 with 2 open todos, and its last reply asked you nothing\.$/);
    assert.equal(dsh.agents.get('s').status, 'running', 'the note started a turn');
});

test('idle: two notes with no progress, then Autopilot backs off and says so; progress or the person resets it', async () => {
    const { dsh, clock, journal, notified, pilot } = setup();
    idleWithTodos(dsh);
    await clock.advance(10 * MIN);
    dsh.end('s', { kind: 'completed' }, { reply: 'Looked at it.' });
    await clock.advance(10 * MIN);
    assert.equal(notesIn(dsh, 's').length, 2);
    dsh.end('s', { kind: 'completed' }, { reply: 'Still looking.' });
    await clock.advance(30 * MIN);
    assert.equal(notesIn(dsh, 's').length, 2, 'no third note');
    const [backoff] = entries(journal, 'backoff');
    assert.equal(backoff.state, 'backed off');
    assert.equal(backoff.why, whyBackOff(2));
    assert.equal(notified.at(-1).title, 'Autopilot backed off: Build the parser');
    assert.ok(pilot.data.sessions.s.backedOff);
    // The person writes: Autopilot starts fresh there.
    dsh.write('s', 'Try the other grammar.');
    assert.equal(pilot.data.sessions.s.backedOff, undefined);
    assert.equal(pilot.data.sessions.s.nudges, 0);
    dsh.end('s', { kind: 'completed' }, { reply: 'Switched grammars.' });
    await clock.advance(10 * MIN);
    assert.equal(notesIn(dsh, 's').length, 3);
});

test('idle: a todo done after a note counts as progress, so the count starts again', async () => {
    const { dsh, clock, pilot } = setup();
    idleWithTodos(dsh);
    await clock.advance(10 * MIN);
    assert.equal(pilot.data.sessions.s.nudges, 1);
    dsh.end('s', { kind: 'completed' }, { reply: 'Parser done.', todos: [TODOS[0], { ...TODOS[1], status: 'completed' }, TODOS[2]] });
    assert.equal(pilot.data.sessions.s.nudges, 0);
    await clock.advance(10 * MIN);
    assert.equal(pilot.data.sessions.s.nudges, 1);
    assert.match(notesIn(dsh, 's')[1], /1 open todo \(next: “Add tests”\)/);
});

test('idle: no note when the last reply asks the person, an approval waits, nothing is open, or a goal is paused or blocked', async () => {
    const { dsh, clock, pilot } = setup();
    idleWithTodos(dsh, 'asks', { reply: 'I can drop the old tables or migrate them.\nShould I drop them?' });
    idleWithTodos(dsh, 'decision', { reply: 'Blocked on the schema.\nDECISION NEEDED: drop the old tables? — recommend: migrate' });
    // A tool waits for approval: its turn is still running until the person answers.
    dsh.add('approval');
    dsh.write('approval', 'Deploy it');
    dsh.commit('approval', 'todo/write', { todos: TODOS });
    dsh.commit('approval', 'approval/asked', { id: 'ap1', toolName: 'bash', reason: 'pushes to production' });
    dsh.add('done');
    dsh.write('done', 'One thing');
    dsh.end('done', { kind: 'completed' }, { reply: 'Done.', todos: TODOS.map((t) => ({ ...t, status: 'completed' })) });
    dsh.add('paused');
    dsh.setGoal('paused', 'Ship it', { phase: 'paused' });
    dsh.write('paused', 'Work');
    dsh.end('paused', { kind: 'completed' }, { todos: TODOS });
    await clock.advance(60 * MIN);
    for (const id of ['asks', 'decision', 'approval', 'done', 'paused']) assert.deepEqual(notesIn(dsh, id), [], id);
    assert.equal(pilot.plan('asks', 'idle', { force: true }).why, 'its last reply asks you something');
    assert.equal(pilot.plan('approval', 'idle', { force: true }).why, 'it is working');
    assert.equal(pilot.plan('done', 'idle', { force: true }).why, 'nothing is open');
    assert.equal(pilot.plan('paused', 'idle', { force: true }).why, 'its goal is paused');
});

test('idle: an offer holds the note only when it hands the next step to the person; one that says the agent goes on does not', async () => {
    const { dsh, clock, pilot, watch, journal, config } = setup();
    // Round 5's false holds: each gets its note now.
    const goesOn = {
        happy: 'All tests pass. Happy to keep going with the next todo.',
        report: 'I am happy to report the build is green. Moving on to the docs next.',
        free: 'Feel free to review the diff; I will carry on with the remaining two todos.',
        rename: 'If you would like a different name, say so. Next up: the README.',
        questions: 'The lexer is done.\nLet me know if you have any questions.',
    };
    for (const [id, reply] of Object.entries(goesOn)) idleWithTodos(dsh, id, { reply });
    // Hand-overs from the stack's own sessions: each is left alone, and its row quotes the words.
    const handsOver = {
        cont: 'Step 1 is done. Let me know if you want me to continue with steps 2 and 3.',
        word: 'The fix is ready but unverified. If you want confirmation, say the word and I\'ll run them.',
        colour: 'The blouse is now sage, with everything else unchanged. Happy to try another color, a print, or a fabric next.',
    };
    for (const [id, reply] of Object.entries(handsOver)) idleWithTodos(dsh, id, { reply });
    await clock.advance(10 * MIN);
    for (const id of Object.keys(goesOn)) assert.equal(notesIn(dsh, id).length, 1, id);
    for (const id of Object.keys(handsOver)) assert.deepEqual(notesIn(dsh, id), [], id);
    assert.match(entries(journal, 'nudge').find((e) => e.sessionId === 'happy').why, /and its last reply asked you nothing\.$/);
    assert.equal(pilot.plan('cont', 'idle', { force: true }).why, 'its last reply leaves the next step to you');
    const view = await pageState({ pilot, watch, journal, config });
    const holds = Object.fromEntries(view.sessions.filter((r) => Object.hasOwn(handsOver, r.sessionId)).map((r) => [r.sessionId, r.hold]));
    assert.deepEqual(holds, {
        cont: 'waits for you: its last reply leaves the next step to you (“Let me know if you want me to continue with steps 2 and 3.”)',
        word: 'waits for you: its last reply leaves the next step to you (“If you want confirmation, say the word and I\'ll run them.”)',
        colour: 'waits for you: its last reply leaves the next step to you (“Happy to try another color, a print, or a fabric next.”)',
    });
});

test('idle with an active goal that stopped: the goal starts again, proven by the round it begins', async () => {
    const { dsh, clock, journal, watch } = setup();
    dsh.add('g', { title: 'Goal session' });
    dsh.write('g', 'Go');
    dsh.setGoal('g', 'Ship the parser');
    dsh.end('g', { kind: 'completed' }, { reply: 'Round done.' });
    await settle();
    // The goal driver ran a round on its own: an armed goal needs nothing from Autopilot.
    const goalTurns = () => dsh.sessions.get('g').events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'goal').length;
    assert.equal(goalTurns(), 1);
    dsh.end('g', { kind: 'completed' }, { reply: 'Round two done.' });
    await settle();
    assert.equal(goalTurns(), 2);
    // A restart of the agent disarms the goal (as a DSH restart does); the session stays idle.
    dsh.sessions.get('g').goal.activation = 'disarmed';
    dsh.end('g', { kind: 'completed' }, { reply: 'Waiting.' });
    await settle();
    assert.equal(goalTurns(), 2);
    await clock.advance(10 * MIN);
    assert.equal(goalTurns(), 3, 'Autopilot started it again');
    const [rearm] = entries(journal, 'rearm');
    assert.equal(rearm.state, 'started');
    assert.equal(rearm.reason, 'round 3 of 20 began');
    assert.match(rearm.why, /^Its goal “Ship the parser” is active but stopped \(a DSH restart or an error stops a goal\), and it has been idle for 10 minutes\. This start begins round 3 of 20\.$/);
    assert.deepEqual(rearm.goal, { id: 'goal-g', rev: 2, round: 3, max: 20 }, 'proven by a round of the revision this start wrote');
    assert.equal(notesIn(dsh, 'g').length, 0, 'a goal start, not a note');
    assert.equal(watch.goals, dsh.goals);
});

// ── Cut off by a stop ─────────────────────────────────────────────────

test('after a restart: a cut-off session gets a carry-on note, and its goal starts again once the note is read', async () => {
    const dir = tempDir('autopilot');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const before = setup({ dir, clock, dsh });
    dsh.add('r', { title: 'Release build' });
    dsh.setGoal('r', 'Cut the release');
    dsh.write('r', 'Build and test the release.');
    dsh.commit('r', 'todo/write', { todos: TODOS });
    before.watch.running.flush();
    before.pilot.stop();
    before.store.close();
    dsh.stop({ crash: true });
    await clock.advance(2 * MIN);
    // DSH starts again: a new watcher and a new Autopilot over the same folder.
    const after = setup({ dir, clock, dsh });
    await clock.advance(19000);
    assert.deepEqual(notesIn(dsh, 'r'), [], 'nothing before the start delay');
    await clock.advance(1000);
    const notes = notesIn(dsh, 'r');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^\[Autopilot\] DSH stopped while you were working: turn 1 was cut off \(its last step was at .+\)\./);
    assert.match(notes[0], /Still open: 2 todos \(next: “Write the parser”\) and the goal “Cut the release” \(no round begun yet, up to 20\)\./);
    const [resume] = entries(after.journal, 'resume');
    assert.equal(resume.state, 'delivered');
    assert.match(resume.why, /^Turn 1 was cut off: DSH stopped before it finished \(a quit, a restart or a crash\)\. Its last step was at .+, and nobody has written in the session since\.$/);
    // The goal waits for the carry-on turn to end without an error (kept on disk), then goes on by itself.
    assert.equal(entries(after.journal, 'rearm').length, 0, 'no goal start while the note\'s turn runs');
    assert.equal(after.pilot.data.sessions.r.goalAfter.turn, 2);
    dsh.end('r', { kind: 'completed' }, { reply: 'Checked; the build had finished. Tests next.' });
    await settle();
    const [rearm] = entries(after.journal, 'rearm');
    assert.equal(rearm.state, 'started');
    assert.equal(rearm.reason, 'round 1 of 20 began');
    assert.equal(rearm.why, 'Its goal was active when DSH stopped, and the turn after its carry-on note has ended, so its goal goes on: this start begins round 1 of 20.');
    assert.equal(after.pilot.data.sessions.r.goalAfter, undefined);
    assert.equal(after.pilot.data.notes.length, 2, 'the goal start after the note counts toward the hour too, as the setting says');
    // The same cut is never handled twice, even by another restart.
    after.pilot.stop();
    dsh.end('r', { kind: 'completed' }, { reply: 'Tests pass.' });
    const again = setup({ dir, clock, dsh });
    await clock.advance(MIN);
    assert.equal(notesIn(dsh, 'r').length, 1);
    again.pilot.stop();
});

test('after a restart: a turn cut off while a tool waited for approval, or a question waited in the question box, gets its note, which says what did not happen', async () => {
    const dir = tempDir('autopilot');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const before = setup({ dir, clock, dsh });
    dsh.add('ap', { title: 'Deploy' });
    dsh.write('ap', 'Deploy it.');
    dsh.commit('ap', 'todo/write', { todos: TODOS });
    dsh.commit('ap', 'tool/call', { name: 'bash', callId: 'c1' });
    dsh.commit('ap', 'approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1', reason: 'escalate sandbox to danger-full-access: deploys' });
    dsh.add('qb', { title: 'Branch' });
    dsh.write('qb', 'Pick a branch.');
    dsh.commit('qb', 'tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ question: 'Which branch should I use?', options: [{ label: 'main' }, { label: 'dev' }] }] }) });
    // While DSH runs, the rows say who they wait on.
    const live = Object.fromEntries((await before.watch.list(undefined, { maxAgeMs: 0 })).map((row) => [row.sessionId, row]));
    assert.equal(live.ap.word, 'waiting for approval');
    assert.equal(live.qb.word, 'waiting for your answer');
    assert.equal(before.pilot.holdOf(live.ap), 'waits for you: a tool waits for you to allow or reject it');
    assert.equal(before.pilot.holdOf(live.qb), 'waits for you: a question in DSH\'s question box');
    before.watch.running.flush();
    before.pilot.stop();
    before.store.close();
    dsh.stop({ crash: true });
    await clock.advance(2 * MIN);
    const after = setup({ dir, clock, dsh });
    await clock.advance(20000);
    const [ap] = notesIn(dsh, 'ap');
    assert.match(ap, /When DSH stopped, your bash call was waiting for approval, so it did not run: make it again if you still need it, and DSH asks for approval again\./);
    assert.match(ap, /Still open: 2 todos \(next: “Write the parser”\)\./);
    const [qb] = notesIn(dsh, 'qb');
    assert.match(qb, /When DSH stopped, your question in DSH's question box \(“Which branch should I use\?”\) had no answer yet: ask it again if you still need the answer\./);
    const why = Object.fromEntries(entries(after.journal, 'resume').map((entry) => [entry.sessionId, entry.why]));
    assert.match(why.ap, /A tool was waiting for approval when it stopped; the note says it did not run\.$/);
    assert.match(why.qb, /Its question in DSH's question box had no answer; the note says to ask again\.$/);
    // Nothing waits on the old approval any more: once the note's turn ends, the session is Autopilot's to watch again.
    dsh.end('ap', { kind: 'completed' }, { reply: 'Asked for the deploy again.', todos: TODOS });
    await settle();
    assert.equal(after.watch.stateOf('ap').approvals, undefined);
    assert.equal(after.pilot.plan('ap', 'idle', { force: true }).action, 'note');
    after.pilot.stop();
});

test('Ask first: a withdrawn question says so in the log, with why; an answer marks only the question it answers', async () => {
    const { dsh, clock, pilot, watch, journal } = setup({ config: { defaultRule: 'ask' } });
    idleWithTodos(dsh, 'a');
    idleWithTodos(dsh, 'b');
    idleWithTodos(dsh, 'c');
    await clock.advance(10 * MIN);
    assert.equal(watch.asks().length, 3);
    pilot.setRule('a', 'off');
    dsh.write('b', 'I am on it.');
    await settle();
    pilot.setPaused(true);
    const asked = Object.fromEntries(entries(journal, 'ask').map((entry) => [entry.sessionId, entry]));
    assert.deepEqual([asked.a.state, asked.a.reason], ['withdrawn', 'withdrawn: you set its rule to Off']);
    assert.deepEqual([asked.b.state, asked.b.reason], ['withdrawn', 'withdrawn: you wrote in the session, so it no longer applies']);
    assert.deepEqual([asked.c.state, asked.c.reason], ['withdrawn', 'withdrawn: you switched Autopilot off']);
    // On again, it asks about c again; the answer marks that question, and the withdrawn one stays as it was.
    pilot.setPaused(false);
    await clock.advance(1000);
    const [again] = watch.asks();
    assert.equal(again.sessionId, 'c');
    await watch.answerAsk(again.id, 'skip', 'you');
    assert.deepEqual(entries(journal, 'ask').filter((entry) => entry.sessionId === 'c').map((entry) => entry.state), ['answered', 'withdrawn']);
});

test('Ask first across stops: an open question is set aside in the log when Autopilot stops, and comes back under the same entry and time if it still applies', async () => {
    const dir = tempDir('autopilot');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const config = { defaultRule: 'ask' };
    const first = setup({ dir, clock, dsh, config });
    idleWithTodos(dsh, 'q', { title: 'Parser' });
    idleWithTodos(dsh, 'gone', { title: 'Lexer' });
    await clock.advance(10 * MIN);
    const asked = first.watch.asks();
    assert.equal(asked.length, 2);
    const askedAt = asked.find((ask) => ask.sessionId === 'q').at;
    const firstWhy = asked.find((ask) => ask.sessionId === 'q').why;
    assert.match(firstWhy, /idle for 10 minutes/);
    assert.equal(first.notified.length, 2);
    // Autopilot stops (DSH quits, or Autopilot or Session Watch is switched off): the questions leave the cards, and the log says why, at once.
    first.watch.running.flush();
    first.pilot.stop();
    first.store.close();
    assert.equal(first.watch.asks().length, 0, 'nothing left on the cards');
    const stopped = new Journal(join(dir, 'autopilot', 'events.jsonl'), { now: clock.now });
    for (const entry of entries(stopped, 'ask')) {
        assert.equal(entry.state, 'withdrawn', 'saved before DSH exits');
        assert.equal(entry.reason, 'withdrawn: Autopilot stopped (DSH quit, or Autopilot or Session Watch was switched off); it asks again when it runs, if this still applies');
        assert.equal(lastWords(entry), 'its question was withdrawn');
    }
    dsh.stop({ crash: false });
    await clock.advance(5 * MIN);
    // While it was stopped, the person took one session over themselves.
    dsh.commit('gone', 'user/message', dsh.message('I will finish the lexer myself.'));
    const second = setup({ dir, clock, dsh, config });
    await clock.advance(MIN);
    const back = second.watch.asks();
    assert.deepEqual(back.map((ask) => ask.sessionId), ['q'], 'only the question that still applies comes back');
    assert.equal(back[0].at, askedAt, 'it keeps the time it was first asked, so its wait counts from then');
    assert.equal(back[0].why, firstWhy, 'and the Why it was first asked with, which its log entry shows, not one worked out 6 minutes later');
    const forQ = entries(second.journal, 'ask').filter((entry) => entry.sessionId === 'q');
    assert.equal(forQ.length, 1, 'one entry for one question, across the stop');
    assert.equal(forQ[0].state, 'asked you');
    assert.equal(forQ[0].reason, '', 'the stop no longer shows on it');
    assert.equal(forQ[0].why, `${firstWhy} Its rule is Ask first.`);
    assert.equal(lastWords(forQ[0]), 'asked you');
    assert.equal(second.notified.length, 0, 'no second notification for the same question');
    const forGone = entries(second.journal, 'ask').filter((entry) => entry.sessionId === 'gone');
    assert.deepEqual(forGone.map((entry) => entry.state), ['withdrawn'], 'one that no longer applies stays withdrawn, with why');
    // Answered after the restart: its one entry says so.
    await second.watch.answerAsk(back[0].id, 'skip', 'you');
    assert.deepEqual(entries(second.journal, 'ask').filter((entry) => entry.sessionId === 'q').map((entry) => entry.state), ['answered']);
    assert.equal(lastWords(entries(second.journal, 'ask').find((entry) => entry.sessionId === 'q')), 'you answered its question');
    second.pilot.stop();
});

test('after a crash or a forced quit: what the killed run left open is settled from the logs before the first look', async () => {
    const dir = tempDir('autopilot');
    const clock = manualClock();
    // Notes wait in the queue until the test lets a session read them.
    const dsh = fakeDsh({ now: clock.now, autoRead: false });
    const first = setup({ dir, clock, dsh, config: { defaultRule: 'ask' } });
    for (const id of ['n', 'm', 'p', 'g1', 'g2']) first.pilot.setRule(id, 'auto');
    idleWithTodos(dsh, 'q', { title: 'Parser' });
    idleWithTodos(dsh, 'n', { title: 'Queued' });
    idleWithTodos(dsh, 'm', { title: 'Read unseen' });
    idleWithTodos(dsh, 'p', { title: 'Never sent' });
    // p's note never reaches DSH: the kill comes while it is still on its way.
    const deliver = first.watch.deliver.bind(first.watch);
    first.watch.deliver = (sessionId, ...rest) => (sessionId === 'p' ? new Promise(() => {}) : deliver(sessionId, ...rest));
    for (const id of ['g1', 'g2']) {
        dsh.add(id, { title: `Goal ${id}` });
        dsh.write(id, 'Go');
        dsh.setGoal(id, `Ship ${id}`, { armed: false });
        dsh.end(id, { kind: 'completed' }, { reply: 'Stopped.' });
    }
    // DSH takes a goal start, but is killed before its driver begins the round.
    const resume = dsh.goals.resume;
    dsh.goals.resume = (agent) => {
        const g = dsh.sessions.get(agent.id).goal;
        g.activation = 'armed';
        g.revision += 1;
        dsh.commit(agent.id, 'goal/change', { operation: 'resume', goal: { id: g.id, revision: g.revision, objective: g.objective, phase: 'active', maxGoalRounds: g.maxGoalRounds }, roundsStarted: g.roundsStarted });
    };
    await clock.advance(10 * MIN);
    const askedAt = first.watch.asks().find((ask) => ask.sessionId === 'q').at;
    assert.equal(first.notified.length, 1);
    const open = Object.fromEntries(entries(first.journal).filter((e) => e.kind !== 'rule').map((e) => [e.sessionId, e.state]));
    assert.deepEqual(open, { q: 'asked you', n: 'in the queue', m: 'in the queue', p: 'sending', g1: 'waiting for a round', g2: 'waiting for a round' });
    // Two things happen that the run never hears of: m reads its note, and g1's round begins.
    const msg = dsh.agents.get('m').inbox.shift();
    dsh.commit('m', 'turn/start', { turn: 2 }, { quiet: true });
    dsh.commit('m', 'user/message', msg, { quiet: true });
    const g1 = dsh.sessions.get('g1').goal;
    g1.roundsStarted += 1;
    dsh.commit('g1', 'turn/start', { turn: 2 }, { quiet: true });
    dsh.commit('g1', 'user/message', dsh.message('Continue working toward the goal (round 1).', { kind: 'goal', goalId: g1.id, revision: g1.revision, round: 1 }), { quiet: true });
    // DSH's timer saves both sessions' values with their turns open.
    dsh.save('m');
    dsh.save('g1');
    // The kill: no stop handlers run, every timer of the run is gone, open turns stay open in the logs.
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const timer of clock.pending()) clock.clearTimer(timer);
    dsh.stop({ crash: true });
    dsh.goals.resume = resume;
    await clock.advance(2 * MIN);
    const second = setup({ dir, clock, dsh, config: { defaultRule: 'ask' } });
    await settle();
    const byId = (id) => entries(second.journal).find((e) => e.sessionId === id && e.kind !== 'rule');
    // Before the first look: the question is set aside to be reused, each note and start checked against its log.
    assert.equal(byId('q').state, 'withdrawn');
    assert.equal(byId('q').stopped, true);
    assert.equal(byId('q').reason, 'withdrawn: DSH stopped before it was answered (a crash or a forced quit); it asks again when it runs, if this still applies');
    // n's note is still in DSH's queue, which DSH keeps in the session's log: the session may still read it.
    assert.equal(byId('n').state, 'not proven');
    assert.equal(byId('n').reason, 'DSH stopped with it in the session\'s queue (a crash or a forced quit); the session may still read it when it next runs, and this entry says so when it does');
    assert.equal(byId('n').queued, true);
    assert.equal(byId('p').state, 'not delivered');
    assert.equal(byId('p').reason, 'DSH stopped before it reached the session (a crash or a forced quit)');
    assert.equal(byId('m').state, 'delivered');
    assert.equal(byId('m').turn, 2);
    assert.equal(byId('g1').state, 'started');
    assert.equal(byId('g1').reason, 'round 1 of 20 began');
    assert.equal(byId('g2').state, 'not started');
    assert.equal(byId('g2').reason, 'DSH stopped before a round began (a crash or a forced quit)');
    for (const id of ['q', 'n', 'm', 'p', 'g1', 'g2']) assert.equal(byId(id).settledAt, clock.now(), id);
    // The first look: the question comes back under its entry and first time, without a second notification;
    // the note that never arrived and the goal that never started get their turn; nothing is done twice.
    await clock.advance(MIN);
    const back = second.watch.asks();
    assert.deepEqual(back.map((ask) => ask.sessionId), ['q']);
    assert.equal(back[0].at, askedAt);
    assert.equal(entries(second.journal, 'ask').length, 1);
    assert.equal(entries(second.journal, 'ask')[0].state, 'asked you');
    assert.equal(second.notified.length, 0);
    assert.equal(entries(second.journal, 'nudge').filter((e) => e.sessionId === 'p').length, 2, 'p gets its note again');
    assert.equal(entries(second.journal, 'nudge').filter((e) => e.sessionId === 'n').length, 1, 'n\'s note may still be read: not sent twice');
    assert.equal(entries(second.journal, 'nudge').filter((e) => e.sessionId === 'm').length, 1, 'm read its note: not again');
    const starts = entries(second.journal, 'rearm').filter((e) => e.sessionId === 'g2');
    assert.equal(starts.length, 2);
    assert.equal(starts[0].state, 'started');
    assert.equal(starts[0].reason, 'round 1 of 20 began');
    assert.equal(entries(second.journal, 'rearm').filter((e) => e.sessionId === 'g1').length, 1, 'g1\'s round began: not started twice');
    // m's and g1's turns were cut off by the kill: each gets one carry-on note.
    assert.equal(entries(second.journal, 'resume').map((e) => e.sessionId).sort().join(), 'g1,m');
    // Later, n's session opens and reads the note DSH kept in its queue: its entry says delivered, with that turn.
    const nAgent = dsh.load('n');
    const kept = dsh.sessions.get('n').events.filter((e) => e.type === 'agent/inbox/spliced').at(-1).data.inserted[0];
    nAgent.inbox.push(kept);
    dsh.read('n');
    await clock.advance(1000);
    assert.equal(byId('n').state, 'not proven', 'read a moment after the session moves');
    await clock.advance(1000);
    await settle();
    assert.equal(byId('n').state, 'delivered');
    assert.equal(byId('n').turn, 2);
    assert.equal(byId('n').queued, false);
    assert.equal(byId('n').reason, '');
    assert.equal(byId('n').deliveredAt, dsh.sessions.get('n').events.findLast((e) => e.type === 'user/message').time);
    assert.equal(entries(second.journal, 'nudge').filter((e) => e.sessionId === 'n').length, 1, 'still never sent twice');
    second.pilot.stop();
    // A start after that leaves it delivered.
    const third = setup({ dir, clock, dsh, config: { defaultRule: 'ask' } });
    await settle();
    assert.equal(third.journal.get(byId('n').id).state, 'delivered');
    third.pilot.stop();
});

test('after a restart: sessions cut off too long ago, ones someone wrote in since, and Off sessions are left alone', async () => {
    const dir = tempDir('autopilot');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const before = setup({ dir, clock, dsh });
    for (const id of ['old', 'off', 'mine']) dsh.write(id, 'Work');
    before.pilot.setRule('off', 'off');
    before.watch.running.flush();
    before.pilot.stop();
    before.store.close();
    dsh.stop({ crash: false });
    dsh.sessions.get('old').events.at(-1).time = clock.now() - 7 * 3600000;
    dsh.save('old');
    await clock.advance(1000);
    dsh.commit('mine', 'user/message', dsh.message('I will finish this myself.'));
    const after = setup({ dir, clock, dsh });
    await clock.advance(MIN);
    for (const id of ['old', 'off', 'mine']) assert.deepEqual(notesIn(dsh, id), [], id);
    assert.equal(after.pilot.ruleOf('off'), 'off', 'rules survive the restart');
    after.pilot.stop();
});

test('a reload under a running turn (DSH still up): the cut-off session gets its note after a short wait', async () => {
    const { dsh, clock, journal } = setup();
    dsh.write('s', 'Work');
    dsh.end('s', { kind: 'aborted', reason: { kind: 'disposed' } });
    await clock.advance(14000);
    assert.equal(notesIn(dsh, 's').length, 0);
    await clock.advance(2000);
    assert.equal(notesIn(dsh, 's').length, 1);
    assert.match(entries(journal, 'resume')[0].why, /DSH shut down under it/);
});

// ── A failed turn ─────────────────────────────────────────────────────

test('a failed turn that stopped a goal: a carry-on note goes first and spends no goal round; the goal starts again once a turn ends without an error', async () => {
    const { dsh, clock, journal, pilot } = setup();
    dsh.add('e', { title: 'Flaky provider' });
    dsh.setGoal('e', 'Finish the migration', { max: 4 });
    dsh.write('e', 'Go');
    const rounds = () => dsh.sessions.get('e').goal.roundsStarted;
    dsh.end('e', { kind: 'error', error: { code: 'provider', message: '502 from the gateway' } });
    await clock.advance(119000);
    assert.equal(entries(journal, 'error').length, 0);
    await clock.advance(1000);
    const [note] = entries(journal, 'error');
    assert.equal(note.state, 'delivered', 'the first try, 2 minutes after the error, is a note');
    assert.equal(note.why, 'Turn 1 failed (502 from the gateway), which stops a goal; the goal “Finish the migration” is still active. A note costs no goal round, so it goes first; the goal starts again (round 1 of 4) once a turn ends without an error.');
    assert.match(notesIn(dsh, 'e')[0], /^\[Autopilot\] Your last turn \(turn 1\) failed: 502 from the gateway\./);
    assert.equal(rounds(), 0, 'no goal round spent');
    assert.equal(entries(journal, 'rearm').length, 0);
    // The note's turn ends cleanly: the goal goes on, and its start begins the next round.
    dsh.end('e', { kind: 'completed' }, { reply: 'Retried; the gateway answers again.' });
    await settle();
    const [rearm] = entries(journal, 'rearm');
    assert.equal(rearm.state, 'started');
    assert.equal(rearm.reason, 'round 1 of 4 began');
    assert.equal(rearm.why, 'The turn after its carry-on note ended without an error, so its goal goes on: this start begins round 1 of 4.');
    assert.equal(rearm.text, 'Started its goal again after an error');
    assert.equal(rounds(), 1);
    assert.equal(pilot.data.sessions.e.errorTries, 0);
    assert.equal(pilot.data.notes.length, 2, 'the note and the goal start after it both count toward the hour');
});

test('an outage: each carry-on note fails too, so no goal round is spent; the waits grow, then Autopilot gives up at once, tagged gave up', async () => {
    const { dsh, clock, journal, notified, pilot, watch, config } = setup();
    dsh.add('e', { title: 'Flaky provider' });
    dsh.setGoal('e', 'Finish the migration', { max: 4 });
    dsh.write('e', 'Go');
    const fail = () => dsh.end('e', { kind: 'error', error: { code: 'provider', message: '502 from the gateway' } });
    fail();
    await clock.advance(2 * MIN);
    assert.equal(entries(journal, 'error').length, 1, 'first note after 2 minutes');
    fail();
    await settle();
    assert.equal(pilot.pending().e.trigger, 'error');
    await clock.advance(10 * MIN - 1000);
    assert.equal(entries(journal, 'error').length, 1);
    await clock.advance(1000);
    assert.equal(entries(journal, 'error').length, 2, 'second after 10 more');
    fail();
    await clock.advance(30 * MIN);
    assert.equal(entries(journal, 'error').length, 3, 'third after 30 more');
    // The third note's turn fails: no fourth wait, the give-up comes at once.
    fail();
    await clock.advance(0);
    const [giveup] = entries(journal, 'giveup');
    assert.equal(giveup.state, 'gave up');
    assert.equal(giveup.text, 'Stopped retrying after errors');
    assert.equal(giveup.why, 'It failed again after 3 tries, so Autopilot stops retrying and leaves it to you.');
    assert.equal(giveup.at, clock.now());
    assert.equal(notified.at(-1).title, 'Autopilot stopped retrying: Flaky provider');
    assert.equal(dsh.sessions.get('e').goal.roundsStarted, 0, 'no goal round went to the outage');
    assert.equal(entries(journal, 'rearm').length, 0);
    assert.ok(pilot.data.sessions.e.gaveUp);
    const view = await pageState({ pilot, watch, journal, config });
    const row = view.sessions.find((r) => r.sessionId === 'e');
    assert.equal(row.word, 'gave up');
    assert.equal(row.last.text, 'stopped retrying after errors');
    assert.equal(row.next, undefined);
    // Try again from the page starts over, with a note again (a person's own action).
    const result = await pilot.retry('e');
    assert.equal(result.action, 'note');
    assert.equal(result.entry.by, 'you');
    assert.equal(pilot.data.sessions.e.gaveUp, undefined);
});

test('a goal start is proven only by a round of the revision it wrote: a turn that fails first leaves it not started, and a later start\'s round is not credited to it', async () => {
    const { dsh, clock, journal } = setup();
    dsh.add('g', { title: 'Goal' });
    dsh.write('g', 'Go');
    dsh.setGoal('g', 'Ship it', { armed: false, max: 4 });
    dsh.end('g', { kind: 'completed' }, { reply: 'Stopped.' });
    // DSH takes the start, but its driver has not begun the round when a turn of the person's starts and fails.
    const resume = dsh.goals.resume;
    dsh.goals.resume = (agent) => {
        const g = dsh.sessions.get(agent.id).goal;
        g.activation = 'armed';
        g.revision += 1;
        dsh.commit(agent.id, 'goal/change', { operation: 'resume', goal: { id: g.id, revision: g.revision, objective: g.objective, phase: 'active', maxGoalRounds: g.maxGoalRounds }, roundsStarted: g.roundsStarted });
    };
    await clock.advance(10 * MIN);
    const [first] = entries(journal, 'rearm');
    assert.equal(first.state, 'waiting for a round');
    assert.deepEqual(first.goal, { id: 'goal-g', rev: 2, round: 1, max: 4 });
    dsh.goals.resume = resume;
    dsh.write('g', 'Use the other gateway.');
    dsh.end('g', { kind: 'error', error: { message: '502 from the gateway' } });
    await settle();
    assert.equal(journal.get(first.id).state, 'not started');
    assert.equal(journal.get(first.id).reason, 'the turn running in the session failed before a round began (an error stops a goal)');
    // The next start writes revision 3 and begins round 1: credited to it alone.
    dsh.write('g', 'Carry on.');
    dsh.end('g', { kind: 'completed' }, { reply: 'Gateway fixed.' });
    await clock.advance(10 * MIN);
    const [second] = entries(journal, 'rearm');
    assert.notEqual(second.id, first.id);
    assert.equal(second.state, 'started');
    assert.equal(second.reason, 'round 1 of 4 began');
    assert.deepEqual(second.goal, { id: 'goal-g', rev: 3, round: 1, max: 4 });
    assert.equal(journal.get(first.id).state, 'not started');
});

test('a goal that used all its rounds is never started again: the skip and the row say to raise its round limit', async () => {
    const { dsh, clock, journal, pilot, watch } = setup();
    dsh.add('g', { title: 'Short goal' });
    dsh.write('g', 'Go');
    dsh.setGoal('g', 'Ship it', { max: 2 });
    dsh.end('g', { kind: 'completed' }, { reply: 'Round one.' });
    await settle();
    dsh.end('g', { kind: 'completed' }, { reply: 'Round two.' });
    await settle();
    // Two rounds of two: the driver stops; a restart of the agent leaves it disarmed.
    dsh.sessions.get('g').goal.activation = 'disarmed';
    dsh.end('g', { kind: 'completed' }, { reply: 'Out of rounds.' });
    await settle();
    assert.equal(dsh.sessions.get('g').goal.roundsStarted, 2);
    await clock.advance(10 * MIN);
    assert.equal(entries(journal, 'rearm').length, 0, 'no start DSH would refuse');
    const [skip] = entries(journal, 'skip');
    assert.equal(skip.why, 'Its goal used all 2 of its rounds; raise its round limit to let it go on.');
    const row = (await watch.list(undefined, { maxAgeMs: 0 })).find((r) => r.sessionId === 'g');
    assert.equal(pilot.holdOf(row), 'waits for you: its goal used all 2 of its rounds; raise its round limit to let it go on');
    // Try again says the same, without asking DSH.
    const result = await pilot.retry('g');
    assert.equal(result.action, 'none');
    assert.match(entries(journal, 'skip')[0].why, /^You pressed Try again, but its goal used all 2 of its rounds; raise its round limit to let it go on\.$/);
});

test('a failed turn with open todos and no goal gets a carry-on note naming the error', async () => {
    const { dsh, clock } = setup();
    dsh.add('e');
    dsh.write('e', 'Go');
    dsh.end('e', { kind: 'error', error: { message: 'context window exceeded' } }, { todos: TODOS });
    await clock.advance(2 * MIN);
    const [note] = notesIn(dsh, 'e');
    assert.match(note, /^\[Autopilot\] Your last turn \(turn 1\) failed: context window exceeded\. Carry on from where you stopped\./);
    assert.match(note, /If the same error comes back, stop/);
});

test('an error DSH ends with a full stop reads once in the note and its Why, which says what is still open in plain words', async () => {
    const { dsh, clock, journal } = setup();
    dsh.add('e');
    dsh.write('e', 'Go');
    dsh.end('e', { kind: 'error', error: { message: 'Connection error.' } }, { todos: TODOS });
    await clock.advance(2 * MIN);
    const [note] = notesIn(dsh, 'e');
    assert.match(note, /^\[Autopilot\] Your last turn \(turn 1\) failed: Connection error\. Carry on from where you stopped\. Still open: 2 todos \(next: “Write the parser”\)\. /);
    assert.doesNotMatch(note, /\.\./);
    assert.equal(entries(journal, 'error')[0].why, 'Turn 1 failed (Connection error) with 2 todos still open (next: “Write the parser”).');
    assert.equal(errorNote({ turn: 3, error: 'Gateway timed out!' }, {}), '[Autopilot] Your last turn (turn 3) failed: Gateway timed out! Carry on from where you stopped. If the same error comes back, stop and end your reply with one line: DECISION NEEDED: <question> — recommend: <your pick>.');
});

test('a carry-on after a restart that fails too (DSH came back before its gateway): tried again note-first like any failed turn with work open, then given up with Try again', async () => {
    const dir = tempDir('autopilot');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const before = setup({ dir, clock, dsh });
    // No todos and no goal: only the stop says work was cut off.
    dsh.add('pb', { title: 'Power blip' });
    dsh.write('pb', 'Rebuild the search index.');
    before.watch.running.flush();
    before.pilot.stop();
    before.store.close();
    dsh.stop({ crash: true });
    await clock.advance(2 * MIN);
    const { journal, pilot, watch, config, notified } = setup({ dir, clock, dsh });
    await clock.advance(20000);
    assert.equal(notesIn(dsh, 'pb').length, 1, 'the carry-on note');
    assert.equal(entries(journal, 'resume')[0].state, 'delivered');
    assert.deepEqual(pilot.data.sessions.pb.carry, { turn: 2, cut: 1, at: clock.now() });
    // The carry-on turn fails: the gateway is not back yet.
    const fail = () => dsh.end('pb', { kind: 'error', error: { code: 'provider', message: 'Connection error.' } });
    fail();
    await settle();
    assert.equal(pilot.pending().pb?.trigger, 'error', 'the work the stop cut off is still open: it is tried again');
    await clock.advance(2 * MIN);
    const [first] = entries(journal, 'error');
    assert.equal(first.state, 'delivered');
    assert.equal(first.why, 'Turn 2 failed (Connection error) while it carried on after DSH stopped under turn 1, so the work that stop cut off is still open.');
    assert.equal(notesIn(dsh, 'pb')[1], '[Autopilot] Your last turn (turn 2) failed: Connection error. You were carrying on after DSH stopped under turn 1: check what already finished (files, commands, todos), then carry on from where you stopped. If the same error comes back, stop and end your reply with one line: DECISION NEEDED: <question> — recommend: <your pick>.');
    // Still down: the waits grow, then Autopilot gives up, tagged gave up, with Try again.
    fail();
    await clock.advance(10 * MIN);
    assert.equal(entries(journal, 'error').length, 2);
    fail();
    await clock.advance(30 * MIN);
    assert.equal(entries(journal, 'error').length, 3);
    fail();
    await clock.advance(0);
    const [giveup] = entries(journal, 'giveup');
    assert.equal(giveup.state, 'gave up');
    assert.equal(giveup.why, 'It failed again after 3 tries, so Autopilot stops retrying and leaves it to you.');
    assert.equal(notified.at(-1).title, 'Autopilot stopped retrying: Power blip');
    const view = await pageState({ pilot, watch, journal, config });
    const row = view.sessions.find((r) => r.sessionId === 'pb');
    assert.equal(row.word, 'gave up');
    assert.ok(row.gaveUp, 'the Waiting card lists it, with Try again');
    // Try again: the same carry-on note again, by the person; a turn that ends well closes the carry-on.
    const result = await pilot.retry('pb');
    assert.equal(result.action, 'note');
    assert.equal(result.entry.by, 'you');
    await settle();
    assert.match(notesIn(dsh, 'pb').at(-1), /You were carrying on after DSH stopped under turn 1/);
    dsh.end('pb', { kind: 'completed' }, { reply: 'The index is rebuilt.' });
    await settle();
    assert.equal(pilot.data.sessions.pb.carry, undefined);
    // A failure after that, with nothing open, is the person's: no try, and the row says why instead of "failed" alone.
    dsh.write('pb', 'Now vacuum the database.');
    dsh.end('pb', { kind: 'error', error: { message: 'Connection error.' } });
    await clock.advance(2 * MIN);
    assert.equal(entries(journal, 'error').length, 4, 'nothing more after the try the person asked for');
    assert.equal(pilot.pending().pb, undefined);
    const after = (await pageState({ pilot, watch, journal, config })).sessions.find((r) => r.sessionId === 'pb');
    assert.equal(after.hold, 'its last turn failed with nothing left open (no todos, no goal), so Autopilot leaves it to you');
    pilot.stop();
});

test('a carry-on after a restart whose turn ends well, or that the person takes over, is no longer Autopilot\'s to retry', async () => {
    const dir = tempDir('autopilot');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const before = setup({ dir, clock, dsh });
    for (const id of ['ok', 'mine']) dsh.write(id, 'Rebuild the search index.');
    before.watch.running.flush();
    before.pilot.stop();
    before.store.close();
    dsh.stop({ crash: true });
    await clock.advance(2 * MIN);
    const { journal, pilot } = setup({ dir, clock, dsh });
    await clock.advance(20000);
    assert.equal(entries(journal, 'resume').length, 2);
    dsh.end('ok', { kind: 'completed' }, { reply: 'Done; the index is rebuilt.' });
    dsh.write('mine', 'Stop; I will do it myself.');
    await settle();
    assert.equal(pilot.data.sessions.ok.carry, undefined);
    assert.equal(pilot.data.sessions.mine.carry, undefined);
    for (const id of ['ok', 'mine']) dsh.end(id, { kind: 'error', error: { message: 'Connection error.' } });
    await clock.advance(5 * MIN);
    assert.equal(entries(journal, 'error').length, 0);
    pilot.stop();
});

test('the first look\'s words in a waiting row follow what Autopilot started after: DSH, a fixed setting, or a switch back on', async () => {
    for (const [after, words] of [[undefined, 'after DSH starts'], ['dsh', 'after DSH starts'], ['settings', 'after the setting was fixed'], ['again', 'after Autopilot starts again']]) {
        const { dsh, pilot, watch } = setup({ start: false });
        // A failed turn with work open, as in the settings restart the judge saw.
        dsh.add('c', { title: 'Colours' });
        dsh.write('c', 'Pick the colours.');
        dsh.end('c', { kind: 'error', error: { message: 'Connection error.' } }, { todos: TODOS });
        pilot.start(after ? { after } : undefined);
        await settle();
        const row = (await watch.list(undefined, { maxAgeMs: 0 })).find((r) => r.sessionId === 'c');
        assert.equal(pilot.holdOf(row), `Autopilot looks at it 20 seconds ${words}`, String(after));
        pilot.stop();
    }
});

// ── Rules, the switch, the limit ──────────────────────────────────────

test('Ask first: Autopilot asks in Decisions and on its page, and acts only on the answer', async () => {
    const { dsh, clock, journal, notified, watch, pilot } = setup({ config: { defaultRule: 'ask' } });
    idleWithTodos(dsh, 'a');
    await clock.advance(10 * MIN);
    assert.deepEqual(notesIn(dsh, 'a'), [], 'nothing sent before the answer');
    const [ask] = watch.asks();
    assert.equal(ask.source, 'Autopilot');
    assert.equal(ask.sessionId, 'a');
    assert.equal(ask.question, '“Build the parser” stopped with 2 open todos (next: “Write the parser”). Tell it to carry on?');
    assert.equal(ask.recommendation, 'Tell it to carry on');
    assert.deepEqual(ask.options.map((option) => option.id), ['go', 'skip']);
    assert.equal(ask.freeText, true);
    assert.equal(entries(journal, 'ask')[0].state, 'asked you');
    assert.equal(entries(journal, 'ask')[0].text, 'Asked you whether to tell it to carry on', 'the log says what was asked; its row names the session');
    assert.equal(notified.at(-1).kind, 'decision');
    // Looking again while the question waits asks nothing new.
    assert.equal((await pilot.check('a', 'idle')).again, true);
    assert.equal(watch.asks().length, 1);
    const answer = await watch.answerAsk(ask.id, 'go', 'you');
    assert.equal(answer.ok, true);
    assert.equal(answer.action, 'note');
    await settle();
    assert.equal(notesIn(dsh, 'a').length, 1);
    assert.equal(entries(journal, 'ask')[0].state, 'answered');
    assert.equal(entries(journal, 'nudge')[0].by, 'you');
});

test('Ask first: Leave it does nothing, and the person\'s own words go into the session', async () => {
    const { dsh, clock, journal, watch } = setup({ config: { defaultRule: 'ask' } });
    idleWithTodos(dsh, 'skip');
    idleWithTodos(dsh, 'words');
    await clock.advance(10 * MIN);
    const asks = Object.fromEntries(watch.asks().map((ask) => [ask.sessionId, ask]));
    await watch.answerAsk(asks.skip.id, 'skip', 'you');
    await watch.answerAsk(asks.words.id, 'Use the Pratt parser and skip the old tests.', 'you');
    await settle();
    assert.deepEqual(notesIn(dsh, 'skip'), []);
    assert.equal(entries(journal, 'answer')[0].text, 'Left it alone');
    assert.deepEqual(notesIn(dsh, 'words'), [answerNote('Use the Pratt parser and skip the old tests.')]);
});

test('rules: Off leaves a session alone, a session\'s own rule beats the default, and Use the default goes back', async () => {
    const { dsh, clock, pilot, journal } = setup();
    idleWithTodos(dsh, 'off');
    pilot.setRule('off', 'off');
    await clock.advance(30 * MIN);
    assert.deepEqual(notesIn(dsh, 'off'), []);
    assert.equal(pilot.ruleOf('off'), 'off');
    assert.equal(entries(journal, 'rule')[0].text, 'Rule set to Off.');
    pilot.setRule('off', undefined);
    assert.equal(pilot.ruleOf('off'), 'auto');
    assert.equal(entries(journal, 'rule')[0].text, 'Rule set to Auto (the default).');
    await clock.advance(MIN);
    assert.equal(notesIn(dsh, 'off').length, 1, 'going back to a rule that acts looks again at once');
    pilot.setDefaultRule('off');
    assert.equal(pilot.ruleOf('anything'), 'off');
    assert.throws(() => pilot.setRule('x', 'sometimes'), /The rule must be one of auto, ask, off/);
    assert.deepEqual(RULES, ['auto', 'ask', 'off']);
});

test('the kill switch stops every pending action at once, and switching back on looks again', async () => {
    const { dsh, clock, pilot, journal } = setup();
    idleWithTodos(dsh);
    assert.ok(pilot.pending().s);
    pilot.setPaused(true);
    assert.deepEqual(pilot.pending(), {});
    await clock.advance(30 * MIN);
    assert.deepEqual(notesIn(dsh, 's'), []);
    assert.equal((await pilot.check('s', 'idle')).why, 'Autopilot is off');
    assert.equal(entries(journal, 'switch')[0].text, 'Autopilot is off: no notes, no resumes, no goal starts.');
    pilot.setPaused(false);
    await clock.advance(1000);
    assert.equal(notesIn(dsh, 's').length, 1);
    assert.equal(pilot.store.data.paused, false);
});

test('the hourly limit holds notes back, says so once, and tries again later', async () => {
    const { dsh, clock, journal } = setup({ config: { maxNotesPerHour: 1 } });
    idleWithTodos(dsh, 'a');
    idleWithTodos(dsh, 'b');
    await clock.advance(10 * MIN);
    assert.equal(notesIn(dsh, 'a').length + notesIn(dsh, 'b').length, 1);
    const held = entries(journal, 'held');
    assert.equal(held.length, 1);
    assert.match(held[0].why, /already sent 1 note in the last hour/);
    await clock.advance(60 * MIN);
    assert.equal(notesIn(dsh, 'a').length + notesIn(dsh, 'b').length, 2, 'the held one goes once the hour has room');
});

test('the hourly limit stops Autopilot, not the person: an answer goes at once with the hour full, and is not counted', async () => {
    const { dsh, clock, journal, pilot, watch } = setup({ config: { defaultRule: 'ask', maxNotesPerHour: 1 } });
    pilot.setRule('a', 'auto');
    idleWithTodos(dsh, 'a');
    idleWithTodos(dsh, 'b');
    await clock.advance(10 * MIN);
    assert.equal(notesIn(dsh, 'a').length, 1, 'the hour is full');
    const ask = watch.asks().find((item) => item.sessionId === 'b');
    const result = await watch.answerAsk(ask.id, 'go', 'you');
    assert.equal(result.ok, true);
    await settle();
    assert.equal(notesIn(dsh, 'b').length, 1, 'the person\'s answer goes at once');
    assert.equal(pilot.data.notes.length, 1, 'and is not counted');
    assert.equal(entries(journal, 'held').length, 0);
    assert.equal(entries(journal, 'nudge').find((entry) => entry.sessionId === 'b').by, 'you');
    // So is Try again; Autopilot's own next note still waits for the hour.
    dsh.write('a', 'More');
    dsh.end('a', { kind: 'completed' }, { todos: TODOS });
    await clock.advance(10 * MIN);
    assert.equal(notesIn(dsh, 'a').length, 1);
    assert.equal(entries(journal, 'held').length, 1);
});

test('a cut-off session Autopilot has not looked at since its start is offered when the switch comes on, its rule leaves Off, or the default rule changes', async () => {
    const dir = tempDir('autopilot');
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    const before = setup({ dir, clock, dsh, config: { defaultRule: 'off' } });
    before.pilot.setRule('c', 'off');
    before.pilot.setRule('e', 'auto');
    before.pilot.setPaused(true);
    for (const id of ['c', 'd', 'e']) {
        dsh.add(id, { title: `Draft ${id}` });
        dsh.write(id, 'Draft it.');
        dsh.commit(id, 'todo/write', { todos: TODOS });
    }
    before.watch.running.flush();
    dsh.save('c');
    before.pilot.stop();
    before.store.close();
    // A forced quit: the turns stay open in the logs.
    dsh.stop({ crash: true });
    await clock.advance(2 * MIN);
    const after = setup({ dir, clock, dsh, config: { defaultRule: 'off' } });
    await clock.advance(MIN);
    assert.deepEqual(after.watch.asks(), []);
    assert.equal(entries(after.journal, 'resume').length, 0, 'off, and every rule Off: nothing');
    // The switch comes on: e (Auto) gets its note.
    after.pilot.setPaused(false);
    await clock.advance(1000);
    assert.equal(notesIn(dsh, 'e').length, 1);
    // c's own rule leaves Off: its log is read, and it is asked about.
    after.pilot.setRule('c', 'ask');
    await clock.advance(1000);
    assert.deepEqual(after.watch.asks().map((ask) => ask.sessionId), ['c']);
    // The default leaves Off: d is asked about too.
    after.pilot.setDefaultRule('ask');
    await clock.advance(1000);
    assert.deepEqual(after.watch.asks().map((ask) => ask.sessionId).sort(), ['c', 'd']);
    after.pilot.stop();
});

test('subagent sessions are left to their parent', async () => {
    const { dsh, pilot } = setup();
    dsh.add('child', { parentSessionId: 'p' });
    dsh.write('child', 'Sub work');
    dsh.end('child', { kind: 'completed' }, { todos: TODOS });
    await pilot.watch.list(undefined, { maxAgeMs: 0 });
    assert.equal(pilot.plan('child', 'idle', { force: true }).why, 'a subagent\'s session; its parent carries it');
});

test('Autopilot\'s state file is private and survives a broken write', async () => {
    const { pilot, dir, store } = setup();
    pilot.setRule('x', 'ask');
    store.flush();
    const file = join(dir, 'autopilot', 'state.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).rules.x, 'ask');
    assert.deepEqual(parseData('junk'), parseData(undefined));
    assert.deepEqual(parseData({ rules: { a: 'auto', b: 'never' }, notes: [1, 'x', 2], paused: 'yes' }).rules, { a: 'auto' });
    assert.equal(parseData({ paused: 'yes' }).paused, false);
});

test('progress and open work, in the engine\'s terms', () => {
    const mark = markOf({ todos: { done: 1, open: 2 }, goal: { rounds: 3 } });
    assert.deepEqual(mark, { done: 1, open: 2, rounds: 3, tools: 0 });
    assert.equal(progressed(mark, { todos: { done: 1, open: 2 }, goal: { rounds: 3 } }), false);
    assert.equal(progressed(mark, { todos: { done: 2, open: 2 } }), true);
    assert.equal(progressed(mark, { todos: { done: 1, open: 1 } }), true);
    assert.equal(progressed(mark, { todos: { done: 1, open: 2 }, goal: { rounds: 4 } }), true);
    assert.equal(progressed(undefined, {}), false);
    assert.equal(hasOpenWork({ todos: { open: 1 } }), true);
    assert.equal(hasOpenWork({ goal: { phase: 'active' } }), true);
    assert.equal(hasOpenWork({ goal: { phase: 'completed' }, todos: { open: 0 } }), false);
});

// ── Words ─────────────────────────────────────────────────────────────

test('notes and questions in plain words, each signed [Autopilot]', () => {
    const now = Date.UTC(2026, 9, 17, 4, 30);
    const state = { todos: { open: 1, next: 'Add tests' }, goal: { phase: 'active', objective: 'Ship', rounds: 2, max: 5 } };
    assert.equal(openWork(state), '1 open todo (next: “Add tests”) and the goal “Ship” (round 2 of 5)');
    assert.equal(openWork({}), '');
    // A goal cut off before its first round: no "round 0".
    assert.equal(openWork({ goal: { phase: 'active', objective: 'Ship', rounds: 0, max: 5 } }), 'the goal “Ship” (no round begun yet, up to 5)');
    assert.equal(openWork({ goal: { phase: 'active', objective: 'Ship', rounds: 0 } }), 'the goal “Ship” (no round begun yet)');
    assert.equal(openWork({ goal: { phase: 'active', objective: 'Ship', rounds: 3 } }), 'the goal “Ship”');
    for (const note of [carryOnNote({ turn: 3, at: now - 60000 }, state, now), nudgeNote(state), errorNote({ turn: 3, error: 'boom' }, state), answerNote('yes')]) {
        assert.match(note, /^\[Autopilot\] /);
    }
    assert.match(whyResume({ kind: 'aborted', turn: 2, at: now }, now), /DSH shut down under it/);
    assert.equal(question({ kind: 'rearm' }, ''), 'This session has an active goal that stopped. Start the goal again?');
    assert.equal(question({ kind: 'resume' }, 'A very long title that keeps going and going and going past sixty characters'), '“A very long title that keeps going and going and going…” was cut off when DSH stopped. Tell it to carry on?');
    assert.equal(actionLabel({ action: 'rearm' }), 'Start the goal again');
    assert.equal(actionLabel({ action: 'note' }), 'Tell it to carry on');
});

// ── The page's view ───────────────────────────────────────────────────

test('page view: sessions with their rule, work, next check and last action; questions; settings; the log', async () => {
    const { dsh, clock, pilot, watch, journal, config } = setup({ config: { defaultRule: 'ask' } });
    idleWithTodos(dsh, 'a', { title: 'Parser' });
    dsh.add('blank', { blank: true });
    dsh.add('child', { parentSessionId: 'a' });
    pilot.setRule('a', 'ask');
    await clock.advance(10 * MIN);
    const view = await pageState({ pilot, watch, journal, config });
    assert.equal(view.enabled, true);
    assert.equal(view.paused, false);
    assert.equal(view.defaultRule, 'ask');
    assert.deepEqual(view.sessions.map((s) => s.sessionId), ['a'], 'no blank or subagent sessions');
    const [row] = view.sessions;
    assert.equal(row.title, 'Parser');
    assert.equal(row.folder, 'a');
    assert.equal(row.word, 'idle');
    assert.equal(row.work, '2 open todos (next: “Write the parser”)');
    assert.equal(row.rule, 'ask');
    assert.equal(row.own, true);
    assert.equal(row.last.text, 'asked you', 'a question reads as two words in its row');
    assert.equal(row.last.state, 'asked you');
    assert.equal(view.asks.length, 1);
    assert.equal(view.asks[0].onAnswer, undefined);
    assert.equal(view.watching, 1, 'the count matches the sessions listed');
    assert.deepEqual(Object.keys(view.settings).sort(), ['idleSeconds', 'maxNotesPerHour', 'maxNudges', 'resumeAfterRestart', 'resumeWindowHours']);
    assert.ok(view.log.length >= 2);
    JSON.stringify(view);
});

// ── The browser half ──────────────────────────────────────────────────

test('browser half: loads as DSH loads it, adds its entry (order 3) and page, and one style sheet', () => {
    const heads = [];
    const document = {
        querySelector: () => null,
        createElement: (type) => ({ type, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
        head: { appendChild: (tag) => { heads.push(tag); } },
    };
    const { id, client } = loadClient(new URL('../plugins/autopilot/lib/client.js', import.meta.url), { document });
    assert.equal(id, 'dsh-plugin-autopilot');
    assert.equal(heads.length, 0, 'styles wait for apply');
    const registered = [];
    const effects = [];
    const injected = [];
    const scope = {
        slots: { inject: (name, fn) => { fn(); }, register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        uiWorkspace: { openSession: (sessionId) => { injected.push(sessionId); } },
        effect: (fn) => { effects.push(fn); },
    };
    const ctx = { ...scope, inject: (names, fn) => { if (names[0] === 'uiWorkspace') fn(scope); }, effect: (fn) => effects.push(fn) };
    client.apply(ctx);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].attributes['data-plugin'], 'dsh-plugin-autopilot');
    assert.equal(heads[0].attributes['data-plugin-css'], 'dsh-plugin-autopilot/client.css');
    assert.match(heads[0].textContent, /\.dshap-card\{/);
    assert.match(heads[0].textContent, /body\.wp-still/);
    assert.match(heads[0].textContent, /prefers-reduced-motion/);
    assert.match(heads[0].textContent, /prefers-reduced-transparency/);
    const entry = registered.find((r) => r.spec.name === 'sidebar.panellist');
    assert.deepEqual({ ...entry.spec }, { name: 'sidebar.panellist', id: 'dsh-plugin-autopilot:page', order: 3, label: 'Autopilot' });
    const page = registered.find((r) => r.spec.name === 'main');
    assert.equal(page.spec.key, 'dsh-plugin-autopilot:page');
    page.spec.inject().autopilot.openSession('s1');
    assert.deepEqual(injected, ['s1']);
});

test('browser half: the page\'s cards say what to do next, in plain words', () => {
    const { client } = loadClient(new URL('../plugins/autopilot/lib/client.js', import.meta.url));
    const { HeaderCard, SessionsCard, LogCard, WaitingCard, AutopilotPage, TEXT, CSS } = client.internals;
    const base = { enabled: true, paused: false, defaultRule: 'auto', settings: { idleSeconds: 600, maxNotesPerHour: 20 }, notesLastHour: 3, watching: 4, sessions: [], asks: [], log: [] };
    const acts = [];
    const act = (method, args) => acts.push(JSON.parse(JSON.stringify([method, args])));
    // Loading, before the first read.
    assert.match(textIn(AutopilotPage({ autopilot: {} })), /Reading the sessions/);
    const head = HeaderCard({ data: base, busy: false, act });
    assert.match(textIn(head), /Watching 4 sessions · 3 notes this hour; the limit is 20 · a session with open work gets a note after 10 minutes of quiet/);
    // The quiet time reads as the log says it: 90 seconds is not "2 minutes".
    const quiet = (idleSeconds) => /gets a note after (.+) of quiet/.exec(textIn(HeaderCard({ data: { ...base, settings: { ...base.settings, idleSeconds } }, busy: false, act })))[1];
    assert.deepEqual([90, 119, 150, 300, 600, 5400, 7200, 86400].map(quiet), ['90 seconds', '119 seconds', '2 minutes 30 seconds', '5 minutes', '10 minutes', '1 hour 30 minutes', '2 hours', '24 hours']);
    // The Ask first line names Decisions only when DSH says it runs (the page never calls it to find out).
    assert.match(textIn(HeaderCard({ data: { ...base, defaultRule: 'ask' }, busy: false, act, decisions: true })), /on this page and in Decisions/);
    assert.doesNotMatch(textIn(HeaderCard({ data: { ...base, defaultRule: 'ask' }, busy: false, act, decisions: false })), /Decisions/);
    const toggle = elementsOf(head).find((e) => e.type === 'Switch');
    assert.equal(toggle.props.checked, true);
    toggle.props.onChange(false);
    assert.deepEqual(acts.at(-1), ['setPaused', { paused: true }]);
    // The default rule: an arrow key only moves (nothing is sent); a click on a value sends it.
    const rules = elementsOf(head).find((e) => e.type === 'SegmentedControl');
    assert.equal(rules.props.disabled, undefined, 'never disabled, so focus stays on it');
    const sent = acts.length;
    rules.props.onChange('ask');
    assert.equal(acts.length, sent, 'an arrow key sends nothing');
    const choice = elementsOf(head).find((e) => e.props?.['data-suite-choice'] === 'dshap-default-rule');
    choice.props.onClickCapture({ target: { closest: () => ({ id: 'dshap-default-rule-ask' }) } });
    assert.deepEqual(acts.at(-1), ['setDefaultRule', { rule: 'ask' }]);
    assert.match(textIn(HeaderCard({ data: { ...base, paused: true }, busy: false, act })), /Off: no notes, no resumes, no goal starts/);
    assert.match(textIn(HeaderCard({ data: { ...base, enabled: false }, busy: false, act })), /Autopilot is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\), so it watches nothing\. To use it, set enabled to true there and restart DSH\./);
    // Empty states that say what to do.
    assert.match(textIn(SessionsCard({ data: base, busy: false, act, onOpen: () => {} })), /Start a chat in DSH/);
    assert.match(textIn(LogCard({ data: base, onOpen: () => {} })), /When Autopilot acts, asks or holds back, it says what and why here/);
    assert.equal(WaitingCard({ data: base, busy: false, act, onOpen: () => {} }), null);
    // A session row and a log line.
    const opened = [];
    const data = {
        ...base,
        sessions: [{ sessionId: 's', title: 'Parser', folder: 'work', word: 'idle', work: '2 open todos', rule: 'auto', own: false, updatedAt: 1, backedOff: 5 }],
        asks: [{ id: 'q', sessionId: 's', question: 'Tell it to carry on?', recommendation: 'Tell it to carry on', why: 'It has been idle.', at: Date.now() }],
        log: [{ id: 'e', kind: 'nudge', sessionId: 's', title: 'Parser', text: 'Told it to carry on with its todos', why: 'It has been idle.', note: '[Autopilot] Carry on.', state: 'delivered', at: Date.now() }],
    };
    const sessions = SessionsCard({ data, busy: false, act, onOpen: (id) => opened.push(id) });
    assert.match(textIn(sessions), /Parser/);
    assert.match(textIn(sessions), /work · 2 open todos/);
    elementsOf(sessions).find((e) => e.type === 'button' && textIn(e) === 'Parser').props.onClick();
    assert.deepEqual(opened, ['s']);
    const waiting = WaitingCard({ data, busy: false, act, onOpen: () => {} });
    assert.match(textIn(waiting), /Tell it to carry on\?/);
    assert.match(textIn(waiting), /Autopilot backed off: its notes brought no progress\./);
    const tagIn = (tree) => textIn(elementsOf(tree).find((e) => e.type === 'Tag'));
    assert.equal(tagIn(waiting), 'backed off');
    // A give-up is tagged with its own word, and a row whose tries are spent says it gives up next, not that it retries.
    const gave = WaitingCard({ data: { ...data, asks: [], sessions: [{ ...data.sessions[0], backedOff: undefined, gaveUp: 5 }] }, busy: false, act, onOpen: () => {} });
    assert.match(textIn(gave), /Autopilot stopped retrying: it kept failing\./);
    assert.equal(tagIn(gave), 'gave up');
    const at = Date.now() + 10 * MIN;
    const nextOf = (trigger) => /next: ([^·]+)/.exec(textIn(SessionsCard({ data: { ...data, sessions: [{ ...data.sessions[0], next: { trigger, at } }] }, busy: false, act, onOpen: () => {} })))[1].trim();
    assert.match(nextOf('giveup'), /^gives up at /);
    assert.match(nextOf('error'), /^retry at /);
    elementsOf(waiting).find((e) => e.type === 'Button' && textIn(e) === 'Try again').props.onClick();
    assert.deepEqual(acts.at(-1), ['retry', { sessionId: 's' }]);
    elementsOf(waiting).find((e) => e.type === 'Button' && textIn(e) === 'Leave it').props.onClick();
    assert.deepEqual(acts.at(-1), ['answer', { id: 'q', answer: 'skip' }]);
    // The card people act on is the main glass, and its buttons stay focusable while a change runs.
    assert.match(waiting.props.className, /dshap-main/);
    assert.ok(elementsOf(waiting).filter((e) => e.type === 'Button').every((e) => e.props.disabled === undefined), 'no button is disabled (that drops the focus)');
    // A refusal shows under the control that was pressed, in its card, as one alert that takes the focus.
    const refused = WaitingCard({ data, act, onOpen: () => {}, failure: { where: 'backed:s', text: 'Autopilot is off: switch it on at the top of its page first.', n: 1 } });
    const alert = withAttr(refused, 'data-autopilot-refusal');
    assert.equal(alert.length, 1);
    assert.equal(alert[0].props['data-autopilot-refusal'], 'backed:s');
    assert.equal(alert[0].props.role, 'alert');
    assert.equal(alert[0].props.tabIndex, -1);
    assert.equal(textIn(alert[0]), 'Not changed. Autopilot is off: switch it on at the top of its page first.');
    const backedRow = elementsOf(refused).find((e) => e.props?.['data-autopilot-backed'] === 's');
    assert.equal(withAttr(backedRow, 'data-autopilot-refusal').length, 1, 'inside the row whose button was pressed');
    assert.equal(withAttr(WaitingCard({ data, act, onOpen: () => {}, failure: { where: 'head', text: 'x', n: 2 } }), 'data-autopilot-refusal').length, 0, 'not on another card');
    // The host's own "Not changed:" is not said twice; the header holds its refusals and a failed refresh.
    const headRefused = HeaderCard({ data: base, busy: false, act, failure: { where: 'head', text: 'Not changed: Autopilot is switched off in DSH\'s profile (enabled: false), so it watches nothing.', n: 3 }, refresh: { error: 'socket closed', retry: () => {} } });
    assert.equal(textIn(withAttr(headRefused, 'data-autopilot-refusal')[0]), 'Not changed. Autopilot is switched off in DSH\'s profile (enabled: false), so it watches nothing.');
    assert.match(textIn(headRefused), /Couldn't refresh: socket closedRetry/);
    assert.equal(HeaderCard({ data: { ...base, enabled: false }, busy: false, act }).props['data-autopilot-header'], 'disabled');
    // A rule change refused on a session's row says so on that row.
    const rowRefused = SessionsCard({ data, busy: false, act, onOpen: () => {}, failure: { where: 'session:s', text: 'Name the session.', n: 4 } });
    assert.equal(textIn(withAttr(rowRefused, 'data-autopilot-refusal')[0]), 'Not changed. Name the session.');
    const log = LogCard({ data, onOpen: () => {} });
    assert.match(textIn(log), /Why: It has been idle\./);
    assert.match(textIn(log), /What it sent\[Autopilot\] Carry on\./);
    // No other product's name anywhere in what it shows.
    const words = JSON.stringify(TEXT) + CSS.join('');
    assert.doesNotMatch(words, OTHER_NAMES);
});

test('page: a session\'s last action in a few words, names kept as written', () => {
    assert.equal(lastWords({ kind: 'rule', text: 'Rule set to Off.' }), 'rule set to Off');
    assert.equal(lastWords({ kind: 'nudge', text: 'Told it to carry on with its todos' }), 'told it to carry on with its todos');
    assert.equal(lastWords({ kind: 'ask', text: '“Config cleanup” stopped with 1 open todo. Tell it to carry on?' }), 'asked you');
    assert.equal(lastWords({ kind: 'skip', text: '' }), '');
    // What happened, by the entry's state: a refused or unproven start, a note that never arrived.
    const start = { kind: 'rearm', text: 'Started its goal again after an error' };
    assert.equal(lastWords({ ...start, state: 'started' }), 'started its goal again after an error');
    assert.equal(lastWords({ ...start, state: 'not started', reason: 'DSH refused to start it: goal "g" exhausted 4 goal rounds; increase maxGoalRounds before resuming' }), 'DSH refused to start its goal');
    assert.equal(lastWords({ ...start, state: 'not started', reason: 'DSH stopped before a round began (a crash or a forced quit)' }), 'its goal did not start');
    assert.equal(lastWords({ ...start, state: 'waiting for a round' }), 'starting its goal');
    const note = { kind: 'nudge', text: 'Told it to carry on with its todos', note: '[Autopilot] Carry on.' };
    assert.equal(lastWords({ ...note, state: 'not delivered' }), 'its note was not delivered');
    assert.equal(lastWords({ ...note, state: 'not proven' }), 'its note may not have arrived');
    assert.equal(lastWords({ ...note, state: 'in the queue' }), 'its note waits in the queue');
    assert.equal(lastWords({ ...note, state: 'delivered' }), 'told it to carry on with its todos');
    assert.equal(lastWords({ kind: 'giveup', text: 'Stopped retrying after errors', state: 'gave up' }), 'stopped retrying after errors');
});

// ── Round 1 findings: holds, a wrong setting, the switch, settings in Plugins ──

test('holds: a quiet session with open work that Autopilot leaves alone says why on its row', async () => {
    const clock = manualClock();
    const dsh = fakeDsh({ now: clock.now });
    // Long before this start: one session cut off by a stop, one that went quiet with open todos.
    dsh.write('old-cut', 'Work');
    dsh.stop({ crash: false });
    idleWithTodos(dsh, 'old-quiet');
    await clock.advance(7 * 3600000);
    const { pilot, watch, journal, config } = setup({ clock, dsh, config: { defaultRule: 'ask' } });
    idleWithTodos(dsh, 'asks', { reply: 'Two ways to go.\nShould I drop the old tables?' });
    dsh.add('approval');
    dsh.write('approval', 'Deploy it');
    dsh.commit('approval', 'todo/write', { todos: TODOS });
    dsh.commit('approval', 'approval/asked', { id: 'ap1', toolName: 'bash', reason: 'pushes to production' });
    dsh.add('question');
    dsh.write('question', 'Pick a branch');
    dsh.commit('question', 'todo/write', { todos: TODOS });
    dsh.commit('question', 'tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] }) });
    dsh.add('paused');
    dsh.setGoal('paused', 'Ship it', { phase: 'paused' });
    dsh.write('paused', 'Work');
    dsh.end('paused', { kind: 'completed' }, { todos: TODOS });
    dsh.add('blocked-goal');
    dsh.setGoal('blocked-goal', 'Ship it', { phase: 'blocked' });
    dsh.write('blocked-goal', 'Work');
    dsh.end('blocked-goal', { kind: 'completed' }, { todos: TODOS });
    dsh.write('stopped', 'Work');
    dsh.end('stopped', { kind: 'aborted', reason: { kind: 'user' } }, { todos: TODOS });
    idleWithTodos(dsh, 'left');
    idleWithTodos(dsh, 'fresh');
    await clock.advance(10 * MIN);
    // The person chose Leave it for one; another waits on its question.
    const left = watch.asks().find((ask) => ask.sessionId === 'left');
    await watch.answerAsk(left.id, 'skip', 'you');
    const rows = Object.fromEntries((await watch.list(undefined, { maxAgeMs: 0 })).map((row) => [row.sessionId, row]));
    const holds = Object.fromEntries(Object.keys(rows).map((id) => [id, pilot.holdOf(rows[id])]));
    assert.deepEqual(holds, {
        'old-cut': 'cut off more than 6 h ago, so Autopilot leaves it to you',
        'old-quiet': 'quiet for over 2 h, longer than Autopilot looks back; it acts again after the session\'s next turn',
        asks: 'waits for you: its last reply asks you something',
        approval: 'waits for you: a tool waits for you to allow or reject it',
        question: 'waits for you: a question in DSH\'s question box',
        paused: 'waits for you: its goal is paused',
        'blocked-goal': 'waits for you: its goal is blocked',
        stopped: 'you stopped its last turn, so Autopilot leaves it to you',
        left: 'Autopilot already handled its last turn; it looks again after the next one',
        fresh: 'waits for your answer: Autopilot asked whether to tell it to carry on',
    });
    // The page puts the reason on the row (a question of Autopilot's waiting says so); a check pending needs none.
    const view = await pageState({ pilot, watch, journal, config });
    const byId = Object.fromEntries(view.sessions.map((row) => [row.sessionId, row]));
    assert.equal(byId.asks.hold, 'waits for you: its last reply asks you something');
    assert.equal(byId.fresh.hold, 'waits for your answer: Autopilot asked whether to tell it to carry on');
    assert.equal(view.asks.map((ask) => ask.sessionId).join(), 'fresh');
    // Off, or a rule of Off, says it in the switch and the rule: no hold on top.
    pilot.setRule('asks', 'off');
    assert.equal(pilot.holdOf(rows.asks), undefined);
    pilot.setPaused(true);
    assert.equal(pilot.holdOf(rows.approval), undefined);
});

test('a wrong setting: Autopilot does no work, keeps its question but takes no answer, and looks again once it is fixed', async () => {
    let ok = true;
    const { dsh, clock, pilot, watch, journal } = setup({ config: { defaultRule: 'ask' }, settingsOk: () => ok });
    idleWithTodos(dsh, 'a');
    await clock.advance(10 * MIN);
    const [ask] = watch.asks();
    assert.equal(ask.sessionId, 'a');
    ok = false;
    assert.equal(pilot.active(), false);
    const refused = await watch.answerAsk(ask.id, 'go', 'you');
    assert.deepEqual(refused, { ok: false, error: 'Autopilot is waiting for a setting to be fixed: see the top of its page.', refused: true });
    assert.deepEqual(watch.asks().map((item) => item.id), [ask.id], 'the question stays for later');
    await assert.rejects(pilot.retry('a'), { message: 'Autopilot is waiting for a setting to be fixed: see the top of its page.' });
    idleWithTodos(dsh, 'b');
    await clock.advance(30 * MIN);
    assert.deepEqual(notesIn(dsh, 'a'), []);
    assert.equal(watch.asks().length, 1, 'no new questions while a setting is wrong');
    // Fixed: it looks at every session again, as when it is switched back on.
    ok = true;
    pilot.settingsChanged({ fixed: true });
    await clock.advance(1000);
    assert.deepEqual(watch.asks().map((item) => item.sessionId).sort(), ['a', 'b']);
    const answered = await watch.answerAsk(ask.id, 'go', 'you');
    assert.equal(answered.ok, true);
    await settle();
    assert.equal(notesIn(dsh, 'a').length, 1);
    assert.equal(entries(journal, 'nudge')[0].why, 'You chose “Tell it to carry on”.');
    assert.equal(entries(journal, 'nudge')[0].by, 'you');
});

test('off and Off: the switch withdraws questions, an Off session\'s question goes, and Try again says what to change first', async () => {
    const { dsh, clock, pilot, watch, journal } = setup({ config: { defaultRule: 'ask' } });
    idleWithTodos(dsh, 'a');
    idleWithTodos(dsh, 'b');
    await clock.advance(10 * MIN);
    assert.equal(watch.asks().length, 2);
    pilot.setRule('a', 'off');
    assert.deepEqual(watch.asks().map((ask) => ask.sessionId), ['b'], 'an Off session\'s question goes');
    await assert.rejects(pilot.retry('a'), { message: 'This session\'s rule is Off: set it to Auto or Ask first, then try again.' });
    pilot.setPaused(true);
    assert.deepEqual(watch.asks(), []);
    assert.equal(entries(journal, 'switch')[0].why, 'You switched it off. Its question is withdrawn; it asks again when it is on.');
    await assert.rejects(pilot.retry('b'), { message: 'Autopilot is off: switch it on at the top of its page first.' });
    pilot.setPaused(false);
    await clock.advance(1000);
    assert.deepEqual(watch.asks().map((ask) => ask.sessionId), ['b'], 'once on, it asks again');
    // Try again, when it may: the Why line says who pressed it.
    pilot.setRule('a', 'auto');
    await clock.advance(1000);
    const off = setup({ config: { enabled: false } });
    assert.equal(off.pilot.refusal('x'), 'Autopilot is switched off in DSH\'s profile (enabled: false).');
    off.pilot.stop();
    assert.equal(off.pilot.refusal('x'), 'Autopilot is not running.');
});

test('Try again: the log says the person pressed it, and why nothing happened when nothing could', async () => {
    const { dsh, clock, pilot, journal } = setup();
    idleWithTodos(dsh);
    await clock.advance(10 * MIN);
    dsh.end('s', { kind: 'completed' }, { reply: 'Looked.' });
    await clock.advance(10 * MIN);
    dsh.end('s', { kind: 'completed' }, { reply: 'Still looking.' });
    await clock.advance(10 * MIN);
    assert.ok(pilot.data.sessions.s.backedOff);
    const result = await pilot.retry('s');
    assert.equal(result.action, 'note');
    const [latest] = entries(journal, 'nudge');
    assert.equal(latest.why, 'You pressed Try again on Autopilot\'s page.');
    assert.equal(latest.by, 'you');
    dsh.add('done');
    dsh.write('done', 'One thing');
    dsh.end('done', { kind: 'completed' }, { reply: 'Done.' });
    await pilot.retry('done');
    assert.equal(entries(journal, 'skip')[0].why, 'You pressed Try again, but nothing is open.');
});

test('settings: a quiet time saved in Plugins moves pending checks at once', async () => {
    const { dsh, clock, pilot, config } = setup();
    idleWithTodos(dsh);
    await clock.advance(2 * MIN);
    assert.equal(pilot.pending().s.trigger, 'idle');
    config.idleSeconds = 60;
    pilot.settingsChanged();
    await clock.advance(1000);
    assert.equal(notesIn(dsh, 's').length, 1, 'the new quiet time has already passed');
});

test('settings: each wrong value is named, with what it must be; the defaults pass', () => {
    assert.doesNotThrow(() => checkConfig(CONFIG_DEFAULTS));
    assert.deepEqual({ ...CONFIG_DEFAULTS, errorRetrySeconds: [...CONFIG_DEFAULTS.errorRetrySeconds] }, DEFAULTS, 'the tests run with the plugin\'s own defaults');
    const wrong = (patch) => {
        try {
            checkConfig({ ...CONFIG_DEFAULTS, ...patch });
            return undefined;
        } catch (error) {
            return { key: error.key, text: error.message };
        }
    };
    assert.deepEqual(wrong({ idleSeconds: 2 }), { key: 'idleSeconds', text: 'Quiet time before a note (idleSeconds) must be a whole number of seconds from 5 to 86400 (it is 2)' });
    assert.equal(wrong({ idleSeconds: 1.5 }).key, 'idleSeconds');
    assert.equal(wrong({ idleSeconds: '60' }).text, 'Quiet time before a note (idleSeconds) must be a whole number of seconds from 5 to 86400 (it is "60")');
    assert.equal(wrong({ defaultRule: 'sometimes' }).text, 'The rule for sessions without their own (defaultRule) must be "auto", "ask" or "off" (it is "sometimes")');
    assert.equal(wrong({ errorRetrySeconds: [] }).text, 'Waits before each try after an error (errorRetrySeconds) must list 1 to 10 whole numbers of seconds, each from 0 to 86400 (it is [])');
    assert.equal(wrong({ enabled: 'yes' }).text, 'Autopilot on (enabled) must be true or false (it is "yes")');
    for (const [key, value] of [['maxNudges', 0], ['maxNotesPerHour', 501], ['resumeWindowHours', 200], ['idleWindowHours', 0], ['startDelaySeconds', -1], ['resumeAfterRestart', 1]]) {
        assert.equal(wrong({ [key]: value })?.key, key, key);
    }
    for (const key of LIVE_SETTINGS) assert.ok(SETTING_TITLES[key], key);
    assert.deepEqual(Object.keys(SETTING_TITLES).sort(), Object.keys(CONFIG_DEFAULTS).sort());
    assert.equal(changedWords([['idleSeconds'], ['maxNudges']]), '“Quiet time before a note”, “Notes in a row without progress”');
    assert.equal(changedWords([['idleSeconds'], ['idleSeconds']]), '“Quiet time before a note”');
    assert.equal(changedWords(undefined), '');
});

test('settings: read live, checked once per change, and a save says in the log what it changed or fixed', () => {
    let current = 2;
    // DSH hands a setting its page can change as a live reference.
    const settings = liveSettings({ ...CONFIG_DEFAULTS, idleSeconds: { get: () => current } });
    assert.equal(settings.idleSeconds, 2);
    const logged = [];
    const logger = { warn: (line) => logged.push(['warn', line]), info: (line) => logged.push(['info', line]) };
    const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'autopilot', logger });
    assert.equal(check.run(), false);
    assert.deepEqual(check.problem, { text: 'Quiet time before a note (idleSeconds) must be a whole number of seconds from 5 to 86400 (it is 2)', key: 'idleSeconds', live: true });
    check.run();
    assert.equal(logged.length, 1, 'the same problem is logged once');
    current = 60;
    // DSH sends the same notice for a save in Plugins and an edit of its profile: the entry names neither.
    assert.deepEqual(savedEntry(check, [['idleSeconds']]), { kind: 'settings', text: 'Settings fixed: Autopilot is working again', why: 'The change to “Quiet time before a note” fixed it.', state: 'done' });
    assert.equal(check.ok, true);
    assert.equal(logged.at(-1)[0], 'info');
    current = 90;
    assert.deepEqual(savedEntry(check, [['idleSeconds']]), { kind: 'settings', text: 'Settings changed: “Quiet time before a note”', why: 'They apply now.', state: 'done' });
    // With the values before and after (index.js keeps them), each change says its new value and the old one.
    assert.equal(savedEntry(check, [['idleSeconds']], { before: { idleSeconds: 600 }, after: { idleSeconds: 90 } }).text, 'Settings changed: “Quiet time before a note” now 90 seconds (was 600 seconds)');
    assert.equal(savedEntry(check, [['idleSeconds'], ['maxNudges'], ['errorRetrySeconds'], ['resumeAfterRestart']], { before: { idleSeconds: 600, maxNudges: 2, errorRetrySeconds: [120, 600, 1800], resumeAfterRestart: true }, after: { idleSeconds: 90, maxNudges: 3, errorRetrySeconds: [30, 90], resumeAfterRestart: false } }).text,
        'Settings changed: “Quiet time before a note” now 90 seconds (was 600 seconds), “Notes in a row without progress” now 3 (was 2), “Waits before each try after an error” now 30, 90 seconds (was 120, 600, 1800 seconds), “Resume after a restart” now off (was on)');
    assert.equal(savedEntry(check, [['resumeWindowHours']], { before: { resumeWindowHours: 6 }, after: { resumeWindowHours: 1 } }).text, 'Settings changed: “Resume sessions cut off within” now 1 hour (was 6 hours)');
    // A value in quotes keeps them, so the log shows it was text; the fix says what it is now.
    current = '90';
    const quoted = savedEntry(check, [['idleSeconds']], { before: { idleSeconds: 90 }, after: { idleSeconds: '90' } });
    assert.equal(quoted.text, 'Settings changed: “Quiet time before a note” now "90" (was 90 seconds); Autopilot waits until a wrong one is fixed');
    current = 90;
    const fixed = savedEntry(check, [['idleSeconds']], { before: { idleSeconds: '90' }, after: { idleSeconds: 90 } });
    assert.equal(fixed.text, 'Settings fixed: Autopilot is working again');
    assert.equal(fixed.why, 'The change to “Quiet time before a note” now 90 seconds (was "90") fixed it.');
    assert.equal(savedEntry(check, []), undefined, 'nothing changed, nothing logged');
    current = 1;
    const broke = savedEntry(check, [['idleSeconds']]);
    assert.equal(broke.text, 'Settings changed: “Quiet time before a note”; Autopilot waits until a wrong one is fixed');
    assert.equal(broke.state, 'waiting on a setting');
    // One only the profile sets is to be changed there.
    const profile = new SettingsCheck({ settings: { ...CONFIG_DEFAULTS, startDelaySeconds: 9999 }, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'autopilot' });
    profile.run();
    assert.equal(profile.problem.key, 'startDelaySeconds');
    assert.equal(profile.problem.live, false);
});

/** DSH's settings form model, enough to draw the form and see what it stages. */
function standInForm() {
    const models = [];
    const edits = [];
    class SettingsFormModel {
        constructor(scope, specs) {
            this.scope = scope;
            this.specs = specs;
            models.push(this);
        }
        bind(project) { return { subscribe: () => () => {}, getSnapshot: () => project() }; }
        shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }; }
        field(name) {
            const spec = this.specs.find((item) => item.field === name);
            return { text: spec.format(this.scope.values[name]), overridden: Object.hasOwn(this.scope.user, name), invalid: false };
        }
        actions() { return { edit: (field, text) => edits.push([field, text]), resetField: (field) => edits.push([field, null]), save: () => edits.push(['save']), discard: () => edits.push(['discard']) }; }
        dispose() { this.disposed = true; }
    }
    const SettingsForm = (props) => ({ type: 'SettingsForm', props, children: props.children });
    return { models, edits, ui: { SettingsFormModel, SettingsForm, SettingsSecretField: () => null } };
}

test('settings in Plugins: Autopilot\'s page there has its live settings, drawn with DSH\'s own form, only while DSH serves them', () => {
    const form = standInForm();
    const { client } = loadClient(new URL('../plugins/autopilot/lib/client.js', import.meta.url), { ui: form.ui });
    const { SETTINGS } = client.internals;
    // What the client builds lives in its own realm: compared as plain data.
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(SETTINGS.map((f) => f.name)).sort(), [...LIVE_SETTINGS].sort(), 'the form has exactly the live settings');
    for (const f of SETTINGS) {
        assert.deepEqual(plain(f.default), plain(CONFIG_DEFAULTS[f.name]), `${f.name}: the form's default is the config's`);
        if (f.kind !== 'number') continue;
        // The form takes exactly what the check takes.
        assert.doesNotThrow(() => checkConfig({ ...CONFIG_DEFAULTS, [f.name]: f.min }), f.name);
        assert.doesNotThrow(() => checkConfig({ ...CONFIG_DEFAULTS, [f.name]: f.max }), f.name);
        assert.throws(() => checkConfig({ ...CONFIG_DEFAULTS, [f.name]: f.min - 1 }), f.name);
        assert.throws(() => checkConfig({ ...CONFIG_DEFAULTS, [f.name]: f.max + 1 }), f.name);
    }
    const registered = [];
    const effects = [];
    const served = [];
    const scope = {
        configForms: {
            get: (entry) => ({ entry, values: { ...CONFIG_DEFAULTS, idleSeconds: 120 }, user: { idleSeconds: 120 } }),
            whileServed: (entries, fn) => { served.push(entries); return fn(); },
        },
        slots: { inject: (_name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        // As in DSH: Autopilot injects no key store, and reading one it did not inject throws.
        remote: strictRemote(),
        effect: (fn) => { effects.push(fn); },
        inject: (names, fn) => { if (names[0] === 'configForms') fn(scope); },
    };
    client.apply(scope);
    const disposers = effects.map((fn) => fn());
    assert.deepEqual(plain(served), [['autopilot']], 'it is drawn only while DSH serves Autopilot\'s settings');
    assert.equal(form.models[0].scope.entry, 'autopilot');
    const entry = registered.find((item) => item.spec.name === 'plugins.bundle.config');
    assert.equal(entry.spec.key, 'dsh-plugin-autopilot');
    assert.match(entry.component({ view: 'summary' }), /^How long a session waits before a note/);
    const page = entry.component({});
    const text = textIn(page);
    assert.match(text, /After a restart/);
    assert.match(text, /After an error/);
    assert.match(text, /Changes apply as soon as you save\./);
    const fields = Object.fromEntries(elementsOf(page).filter((e) => e.type === 'SettingsValueField').map((e) => [e.props.label, e.props]));
    const idle = fields['Quiet time before a note, in seconds'];
    assert.equal(idle.text, '120');
    assert.equal(idle.overridden, true);
    assert.equal(idle.overriddenLabel, 'Changed');
    assert.equal(idle.resetLabel, 'Use the default');
    assert.equal(idle.invalidLabel, 'A whole number from 5 to 86400, or empty for the default (600).');
    idle.onEdit('90');
    idle.onReset();
    assert.equal(fields['Waits before each try after an error, in seconds'].text, '120, 600, 1800');
    const resume = elementsOf(page).find((e) => e.type === 'Switch');
    assert.equal(resume.props.checked, true);
    resume.props.onChange(false);
    assert.deepEqual(form.edits, [['idleSeconds', '90'], ['idleSeconds', null], ['resumeAfterRestart', 'off']]);
    const shell = elementsOf(page).find((e) => e.type === 'SettingsForm');
    assert.match(shell.props.labels.unavailable, /^Autopilot is not running, so its settings cannot be changed right now\./);
    // Each field turns typed text into a value only when it fits.
    const spec = (name) => client.internals.kit.fieldSpec(SETTINGS.find((f) => f.name === name));
    assert.deepEqual(plain(spec('idleSeconds').parse(' 90 ')), { kind: 'set', value: 90 });
    assert.deepEqual(plain(spec('idleSeconds').parse('')), { kind: 'clear' });
    for (const bad of ['2', '1.5', 'ten', '-5', '86401']) assert.equal(spec('idleSeconds').parse(bad), undefined, bad);
    assert.deepEqual(plain(spec('errorRetrySeconds').parse('60, 300 900')), { kind: 'set', value: [60, 300, 900] });
    assert.equal(spec('errorRetrySeconds').parse('60, x'), undefined);
    assert.equal(spec('errorRetrySeconds').parse(Array(11).fill('1').join(',')), undefined);
    assert.equal(spec('resumeAfterRestart').format(false), 'off');
    assert.equal(spec('resumeAfterRestart').parse('maybe'), undefined);
    // Its effects let the model go when the plugin stops.
    for (const dispose of disposers) if (typeof dispose === 'function') dispose();
    assert.equal(form.models[0].disposed, true);
});

test('browser half: when Autopilot cannot work, the page says why and what to do, with a way there', () => {
    const { client } = loadClient(new URL('../plugins/autopilot/lib/client.js', import.meta.url));
    const { kit, HeaderCard, SessionsCard, ruleHint, RULE_HINT } = client.internals;
    const opened = [];
    kit.setNavigation({ openBundle: (name) => opened.push(name) });
    const down = kit.Trouble({ name: 'Autopilot', packageName: 'dsh-plugin-autopilot', code: 'not-running', text: 'Autopilot is not running in DSH.', onRetry: () => {} });
    assert.equal(down.props['data-suite-trouble'], 'not-running');
    assert.equal(down.props.role, 'alert');
    assert.equal(textIn(down), 'Autopilot is not running.Open Autopilot in Plugins and switch it off and on again. If it still does not start, restart DSH.Open Autopilot in PluginsCheck again');
    elementsOf(down).find((e) => e.type === 'Button' && textIn(e) === 'Open Autopilot in Plugins').props.onClick();
    assert.deepEqual(opened, ['dsh-plugin-autopilot']);
    const away = kit.Trouble({ name: 'Autopilot', packageName: 'dsh-plugin-autopilot', code: 'unreachable', text: 'DSH did not answer. Check that DSH is still running, then try again.', onRetry: () => {} });
    assert.equal(away.props['data-suite-trouble'], 'unreachable');
    assert.equal(textIn(away), 'Couldn\'t read Autopilot.DSH did not answer. Check that DSH is still running, then try again.Check again');
    const problem = kit.SettingsProblem({ name: 'Autopilot', packageName: 'dsh-plugin-autopilot', problem: { text: 'Quiet time before a note (idleSeconds) must be a whole number of seconds from 5 to 86400 (it is 2)', key: 'idleSeconds', live: true } });
    assert.equal(textIn(problem), 'Autopilot is waiting for a setting to be fixed.Quiet time before a note (idleSeconds) must be a whole number of seconds from 5 to 86400 (it is 2).Change it in Autopilot\'s settings in Plugins. Autopilot starts working again as soon as you save.Open Autopilot\'s settings');
    elementsOf(problem).find((e) => e.type === 'Button').props.onClick();
    assert.equal(opened.at(-1), 'dsh-plugin-autopilot');
    const profileOnly = kit.SettingsProblem({ name: 'Autopilot', packageName: 'dsh-plugin-autopilot', problem: { text: 'Wait after DSH starts (startDelaySeconds) must be a whole number of seconds from 0 to 600 (it is 9999)', key: 'startDelaySeconds', live: false } });
    assert.match(textIn(profileOnly), /Change it in Autopilot's entry in DSH's profile \(cordis\.patch\.yml\), then restart DSH\.$/);
    assert.equal(elementsOf(profileOnly).find((e) => e.type === 'Button'), undefined);
    kit.setNavigation(undefined);
    assert.equal(kit.openPlugin('dsh-plugin-autopilot'), false, 'no button and no throw on a DSH without that navigation');
    // The rule line follows the switch, and names Decisions only when it runs.
    const base = { enabled: true, paused: false, defaultRule: 'ask', settings: { idleSeconds: 600, maxNotesPerHour: 20 }, notesLastHour: 0, watching: 1, sessions: [], asks: [], log: [] };
    assert.equal(ruleHint('ask', { paused: false, decisions: false }), RULE_HINT.ask);
    assert.equal(ruleHint('ask', { paused: false, decisions: true }), 'Autopilot asks you first, on this page and in Decisions.');
    assert.equal(ruleHint('auto', { paused: true, decisions: true }), 'Applies when Autopilot is on.');
    assert.match(textIn(HeaderCard({ data: { ...base, paused: true }, busy: false, act: () => {}, decisions: false })), /Applies when Autopilot is on\./);
    assert.doesNotMatch(textIn(HeaderCard({ data: base, busy: false, act: () => {}, decisions: false })), /Decisions/);
    assert.match(textIn(HeaderCard({ data: { ...base, watchProblem: { text: 'How long a message may wait to be read (deliveryTimeoutSeconds) must be a whole number of seconds from 10 to 86400 (it is 5)' } }, busy: false, act: () => {} })), /Session Watch uses its default for a wrong setting: .*\(it is 5\)\. Change it in Session Watch's settings in Plugins\./);
    // A held session says why on its row.
    const rows = SessionsCard({ data: { ...base, sessions: [{ sessionId: 's', title: 'Parser', folder: 'work', word: 'idle', work: '1 open todo', rule: 'auto', own: false, updatedAt: 1, hold: 'waits for you: its last reply asks you something' }] }, busy: false, act: () => {}, onOpen: () => {} });
    assert.match(textIn(rows), /Waits for you: its last reply asks you something\./);
    // Open work keeps a session Autopilot gave up on, todos or not (a failed carry-on after a stop has none), and a
    // failed one with nothing open, which says why it is left to the person.
    const gaveUp = { sessionId: 'pb', title: 'Power blip', folder: 'work', word: 'gave up', work: '', rule: 'auto', own: false, updatedAt: 1, gaveUp: 5 };
    const failedAlone = { sessionId: 'f', title: 'Vacuum', folder: 'work', word: 'failed', work: '', rule: 'auto', own: false, updatedAt: 1, hold: 'its last turn failed with nothing left open (no todos, no goal), so Autopilot leaves it to you' };
    const quiet = { sessionId: 'q', title: 'Done', folder: 'work', word: 'idle', work: '', rule: 'auto', own: false, updatedAt: 1 };
    const openWork = textIn(SessionsCard({ data: { ...base, sessions: [gaveUp, failedAlone, quiet] }, busy: false, act: () => {}, onOpen: () => {} }));
    assert.match(openWork, /Power blip/);
    assert.match(openWork, /Its last turn failed with nothing left open \(no todos, no goal\), so Autopilot leaves it to you\./);
    assert.doesNotMatch(openWork, /Done/);
});
