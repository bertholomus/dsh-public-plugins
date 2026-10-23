/**
 * Decisions' browser half: loaded as DSH loads it, its page's parts drawn
 * as plain element trees, and its settings form with the webhook address
 * kept in DSH's key store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, LIVE_SETTINGS, checkConfig } from '../plugins/decisions/lib/config.js';
import { OTHER_NAMES, elementsOf, loadClient, statefulReact, textIn } from './helpers/client.mjs';

const CLIENT = new URL('../plugins/decisions/lib/client.js', import.meta.url);
// What the client builds lives in its own realm: compared as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('browser half: loads as DSH loads it, adds its entry (order 2) and page, and one style sheet', () => {
    const heads = [];
    const document = {
        querySelector: () => null,
        createElement: (type) => ({ type, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
        head: { appendChild: (tag) => { heads.push(tag); } },
    };
    const { id, client } = loadClient(CLIENT, { document });
    assert.equal(id, 'dsh-plugin-decisions');
    assert.equal(heads.length, 0, 'styles wait for apply');
    const registered = [];
    const opened = [];
    const scope = {
        slots: { inject: (_name, fn) => { fn(); }, register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        uiWorkspace: { openSession: (sessionId) => { opened.push(sessionId); } },
        effect: () => {},
    };
    client.apply({ ...scope, inject: (names, fn) => { if (names[0] === 'uiWorkspace') fn(scope); } });
    assert.equal(heads.length, 1);
    assert.equal(heads[0].attributes['data-plugin'], 'dsh-plugin-decisions');
    assert.equal(heads[0].attributes['data-plugin-css'], 'dsh-plugin-decisions/client.css');
    assert.match(heads[0].textContent, /\.dshdc-card\{/);
    assert.match(heads[0].textContent, /body\.wp-still/);
    assert.match(heads[0].textContent, /prefers-reduced-motion/);
    assert.match(heads[0].textContent, /prefers-reduced-transparency/);
    const entry = registered.find((r) => r.spec.name === 'sidebar.panellist');
    assert.deepEqual(plain(entry.spec), { name: 'sidebar.panellist', id: 'dsh-plugin-decisions:page', order: 2, label: 'Decisions' });
    const page = registered.find((r) => r.spec.name === 'main');
    assert.equal(page.spec.key, 'dsh-plugin-decisions:page');
    page.spec.inject().decisions.openSession('s1');
    page.spec.inject().decisions.openSession('');
    assert.deepEqual(opened, ['s1'], 'an empty id opens nothing');
});

const base = {
    enabled: true,
    sources: { approvals: true, questions: true, replies: true, threads: true },
    notify: true,
    notifications: true,
    windowHours: 72,
    waiting: [],
    dismissed: [],
    history: [],
    mirror: { mode: 'off', perHour: 30, lastHour: 0 },
};

const at = Date.now() - 4 * 60000;
const CARDS = {
    approval: { id: 'approval:s:c1', kind: 'approval', sessionId: 's', title: 'Deploy', tool: 'bash', question: 'Allow this command with Full access?', detail: 'It pushes the release.', what: 'git push origin main', lines: ['timeout: 120000'], at, running: true, live: true, answer: 'approval' },
    decision: { id: 'decision:t:3', kind: 'decision', sessionId: 't', title: 'Schema', question: 'Drop the old tables?', recommendation: 'Keep them a week', at, running: false, answer: 'text' },
    question: { id: 'question:q:c2', kind: 'question', sessionId: 'q', title: 'Release', questions: [{ id: 'env', question: 'Which environment?', header: 'Target', options: [{ label: 'staging', description: 'safe' }, { label: 'production' }], multiSelect: false }], question: 'Which environment?', at, running: true, live: true, answer: 'questions' },
    ask: { id: 'ask:a1', kind: 'ask', askId: 'a1', sessionId: 's', title: 'Parser', source: 'Autopilot', question: 'Tell it to carry on?', recommendation: 'Tell it to carry on', detail: 'It has been idle.', options: [{ id: 'go', label: 'Tell it to carry on' }, { id: 'skip', label: 'Leave it' }], freeText: false, at, running: false, answer: 'ask' },
    thread: { id: 'thread:th:1', kind: 'thread', sessionId: 'th', title: 'Fix the parser', via: { sessionId: 'co', title: 'Coordinator' }, status: 'needs_decision', question: 'Which branch?', at, running: false, answer: 'text' },
    open: { id: 'approval:o:c9', kind: 'approval', sessionId: 'o', title: 'Old', tool: 'bash', question: 'Allow this command with Full access?', at, running: true, answer: 'open' },
};

test('browser half: the header says what waits, what it lists, and where else new cards go', () => {
    const { client } = loadClient(CLIENT);
    const { kit, HeaderCard, DecisionsPage, TEXT } = client.internals;
    const acts = [];
    const act = (method, args) => { acts.push(plain([method, args])); };
    assert.match(textIn(DecisionsPage({ decisions: {} })), /Reading what waits on you/);
    const quiet = textIn(HeaderCard({ data: base, busy: false, act }));
    // The list's empty state says nothing waits: the header does not say it again.
    assert.doesNotMatch(quiet, /Nothing waits on you/);
    // Everything listed: the summary says what, once.
    assert.doesNotMatch(quiet, /Not listed/);
    assert.equal((quiet.match(/tools waiting for approval/g) ?? []).length, 1, quiet);
    assert.match(quiet, /Each new card notifies you\./);
    assert.doesNotMatch(quiet, /New cards also go/);
    const busy = textIn(HeaderCard({ data: { ...base, waiting: [CARDS.approval, CARDS.decision] }, busy: false, act }));
    assert.match(busy, /2 waiting on you · 1 holding a running turn/);
    const off = textIn(HeaderCard({ data: { ...base, sources: { ...base.sources, replies: false, threads: false }, notify: false }, busy: false, act }));
    assert.match(off, /Not listed, as its settings say: replies that ask you something and threads that need a decision\. DECISION NEEDED and BLOCKED lines and other plugins' questions always are\./);
    assert.match(off, /Notifications are off in its settings\./);
    assert.match(textIn(HeaderCard({ data: { ...base, notifications: false }, busy: false, act })), /the Notifications plugin is not running: switch it on in Plugins to get them\./);
    assert.match(textIn(HeaderCard({ data: { ...base, enabled: false }, busy: false, act })), /Decisions is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\)/);
    // The mirror: where it sends, with a test; or what is missing, with the way to its settings.
    const hook = HeaderCard({ data: { ...base, mirror: { mode: 'webhook', place: 'hooks.example.com', perHour: 30, lastHour: 2 } }, busy: false, act });
    assert.match(textIn(hook), /New cards also go to the webhook at hooks\.example\.com: 2 of 30 this hour\./);
    elementsOf(hook).find((e) => e.type === 'Button' && textIn(e) === 'Send a test').props.onClick();
    assert.deepEqual(acts.at(-1), ['testMirror', {}]);
    const saidTest = HeaderCard({ data: { ...base, mirror: { mode: 'webhook', place: 'hooks.example.com', perHour: 30, lastHour: 3 } }, busy: false, act, said: { text: 'Test message sent to hooks.example.com.', where: 'mirror', n: 1 } });
    assert.equal(elementsOf(saidTest).find((e) => e.props?.['data-decisions-test-said'] !== undefined).props.role, 'status');
    assert.match(textIn(saidTest), /Test message sent to hooks\.example\.com\./);
    // A newer send of a new card says more than the test did: the test line goes; a failed one is said, with why and when.
    const failedAt = Date.now();
    const failed = HeaderCard({ data: { ...base, mirror: { mode: 'webhook', place: 'hooks.example.com', perHour: 30, lastHour: 3, last: { at: failedAt, ok: false, reason: 'hooks.example.com answered 500.' } } }, busy: false, act, said: { text: 'Test message sent to hooks.example.com.', where: 'mirror', n: 1, at: failedAt - 1000 } });
    assert.doesNotMatch(textIn(failed), /Test message sent/);
    const failedLine = elementsOf(failed).find((e) => e.props?.['data-decisions-mirror-failed'] !== undefined);
    assert.match(failedLine.props.className, /dshdc-warn/);
    assert.match(textIn(failedLine), /^The last new card was not sent: hooks\.example\.com answered 500 \(/);
    assert.equal(elementsOf(failedLine).find((e) => e.type === 'time')?.props.dateTime, new Date(failedAt).toISOString(), 'with when');
    // A test's own failure, the hourly limit, or a send that worked: no such line.
    for (const last of [{ at: failedAt, ok: false, test: true, reason: 'x' }, { at: failedAt, ok: false, held: true, reason: 'the hourly limit is reached' }, { at: failedAt, ok: true }]) {
        assert.equal(elementsOf(HeaderCard({ data: { ...base, mirror: { mode: 'webhook', place: 'hooks.example.com', perHour: 30, lastHour: 3, last } }, busy: false, act })).find((e) => e.props?.['data-decisions-mirror-failed'] !== undefined), undefined, JSON.stringify(last));
    }
    // A test sent after the last new card still says so.
    assert.match(textIn(HeaderCard({ data: { ...base, mirror: { mode: 'webhook', place: 'hooks.example.com', perHour: 30, lastHour: 3, last: { at: failedAt - 5000, ok: true } } }, busy: false, act, said: { text: 'Test message sent to hooks.example.com.', where: 'mirror', n: 1, at: failedAt } })), /Test message sent/);
    const opened = [];
    kit.setNavigation({ openBundle: (name) => opened.push(name) });
    const missing = HeaderCard({ data: { ...base, mirror: { mode: 'webhook', perHour: 30, lastHour: 0, problem: 'No webhook address is set yet: add it in Decisions\' settings in Plugins' } }, busy: false, act });
    assert.match(textIn(missing), /New cards cannot go elsewhere: No webhook address is set yet: add it in Decisions' settings in Plugins\./);
    assert.equal(elementsOf(missing).find((e) => e.type === 'Button' && textIn(e) === 'Send a test'), undefined, 'no test while something is missing');
    elementsOf(missing).find((e) => e.type === 'Button' && textIn(e) === 'Open Decisions\' settings').props.onClick();
    elementsOf(missing).find((e) => e.type === 'Button' && textIn(e) === TEXT.settings).props.onClick();
    assert.deepEqual(opened, ['dsh-plugin-decisions', 'dsh-plugin-decisions']);
    // Notifications not running: the way to switch them on.
    const noNotes = HeaderCard({ data: { ...base, notifications: false }, busy: false, act });
    assert.equal(elementsOf(noNotes).find((e) => e.props?.['data-decisions-notify'] !== undefined).props['data-decisions-notify'], 'not running');
    elementsOf(noNotes).find((e) => e.type === 'Button' && textIn(e) === 'Open Notifications in Plugins').props.onClick();
    assert.equal(opened.at(-1), 'dsh-plugin-notifications');
    assert.equal(elementsOf(HeaderCard({ data: base, busy: false, act })).find((e) => e.type === 'Button' && textIn(e) === 'Open Notifications in Plugins'), undefined, 'not while they run');
    kit.setNavigation(undefined);
    assert.equal(elementsOf(HeaderCard({ data: base, busy: false, act })).find((e) => e.type === 'Button'), undefined, 'no settings button on a DSH that cannot open it');
    assert.match(textIn(HeaderCard({ data: { ...base, mirror: { mode: 'command', place: 'notify', perHour: 30, lastHour: 0 } }, busy: false, act })), /New cards also go to notify: 0 of 30 this hour\./);
    assert.match(textIn(HeaderCard({ data: { ...base, watchProblem: { text: 'How long a message may wait to be read (deliveryTimeoutSeconds) must be a whole number of seconds from 10 to 86400 (it is 5)' } }, busy: false, act })), /Session Watch uses its default for a wrong setting: .*\(it is 5\)\. Change it in Session Watch's settings in Plugins\./);
});

test('browser half: with notifications not running, the header offers Notifications in Plugins only when it is installed', async () => {
    for (const [bundles, words, button] of [
        [[{ name: 'dsh-plugin-notifications', installed: true, enabled: false }], /not running: switch it on in Plugins to get them\./, true],
        [[{ name: 'dsh-plugin-decisions', installed: true, enabled: true }], /not installed: add it in Plugins to get them\./, false],
    ]) {
        const { react, mount } = statefulReact();
        const { client } = loadClient(CLIENT, { react });
        const { kit, HeaderCard } = client.internals;
        const asked = [];
        kit.setConnection({ rpc: { call: async (_path, method) => { asked.push(method); return { ok: true, value: bundles }; } } });
        kit.setNavigation({ openBundle: () => {} });
        const header = mount(HeaderCard, { data: { ...base, notifications: false }, busy: false, act() {} });
        await settle();
        const line = elementsOf(header.tree).find((e) => e.props?.['data-decisions-notify'] !== undefined);
        assert.match(textIn(line), words);
        assert.equal(elementsOf(line).some((e) => e.type === 'Button' && textIn(e) === 'Open Notifications in Plugins'), button);
        assert.deepEqual(asked, ['pluginManager/listBundles'], 'DSH\'s own list, read once');
        header.unmount();
    }
});

test('browser half: the answer box is one line until you start answering, and what your last answer did stays true', () => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { DecisionCard } = client.internals;
    const { WaitingCard } = loadClient(CLIENT).client.internals;
    const act = async () => undefined;
    // One line, so a list of questions stays short; room to write once you are in it, and it stays open.
    const card = mount(DecisionCard, { card: CARDS.decision, onOpen() {}, act, busyId: undefined, now: Date.now() });
    const box = () => elementsOf(card.tree).find((e) => e.type === 'textarea');
    assert.equal(box().props.rows, 1);
    assert.match(box().props.className, /dshdc-textarea-closed/);
    box().props.onFocus();
    assert.equal(box().props.rows, 3);
    assert.doesNotMatch(box().props.className, /closed/);
    card.unmount();
    assert.ok(client.internals.CSS.some((rule) => rule.includes('.dshdc-textarea.dshdc-textarea-closed{resize:none;min-height:0')), 'the closed box is one line high');

    // "Waits in its queue" until the session has it, then says it reached it; a failure is said on the card instead.
    const now = Date.now();
    const said = { text: 'Your answer to “Schema” waits in its queue. What happened says when the session reads it.', where: 'list', n: 1, at: now, cardId: CARDS.decision.id, title: 'Schema' };
    const line = (history, at = now) => textIn(elementsOf(WaitingCard({ data: { ...base, history }, onOpen() {}, act, busyId: undefined, now: at, said })).find((e) => e.props?.['data-decisions-said'] !== undefined) ?? '');
    const entry = (state) => ({ id: 'j1', kind: 'answer', cardId: CARDS.decision.id, state, at: now });
    assert.match(line([entry('in the queue')]), /waits in its queue/);
    assert.equal(line([entry('delivered'), entry('in the queue')]), 'Your answer reached “Schema”.', 'the newest entry for the card counts');
    assert.equal(line([entry('not delivered')]), '');
    assert.equal(line([entry('in the queue')], now + 121000), '', 'gone after two minutes');

    // A plugin's question: "answered" says what the plugin does with it; "reached" only once it is proven.
    const asked = { ...said, text: 'Answered. It goes into “Parser agent”\'s terminal when the agent is ready.', title: 'Parser agent' };
    const askLine = (state) => {
        const tree = WaitingCard({ data: { ...base, history: [{ id: 'j2', kind: 'answer', cardKind: 'ask', cardId: CARDS.decision.id, state, at: now }] }, onOpen() {}, act, busyId: undefined, now, said: asked });
        return elementsOf(tree).find((e) => e.props?.['data-decisions-said'] !== undefined);
    };
    assert.match(textIn(askLine('answered')), /^Answered\. It goes into/);
    assert.equal(textIn(askLine('delivered')), 'Your answer reached “Parser agent”.');
    assert.equal(textIn(askLine('typed in')), 'Your answer was typed into “Parser agent”\'s terminal.');
    assert.match(textIn(askLine('not confirmed')), /its transcript has not shown it: look at its terminal/);
    assert.match(askLine('not confirmed').props.className, /dshdc-warn/, 'not proven is said as a warning');
    assert.match(askLine('delivered').props.className, /dshdc-ok/);
});

test('browser half: each card has the controls its kind takes, and sends what the host expects', async () => {
    const { client } = loadClient(CLIENT);
    const { DecisionCard, WaitingCard, TEXT } = client.internals;
    const acts = [];
    const act = async (method, args) => { acts.push(plain([method, args])); return undefined; };
    const opened = [];
    const onOpen = (id) => opened.push(id);
    const draw = (card) => DecisionCard({ card, onOpen, act, busyId: undefined, now: Date.now() });
    const buttons = (tree) => elementsOf(tree).filter((e) => e.type === 'Button');
    const button = (tree, label) => buttons(tree).find((e) => textIn(e) === label);

    // Empty: says what shows here and how it is answered.
    const empty = WaitingCard({ data: base, onOpen, act, busyId: undefined, now: Date.now() });
    assert.match(textIn(empty), new RegExp(TEXT.nothing));
    assert.match(textIn(empty), /a tool that needs approval/);

    // An approval Decisions holds: Allow once, Reject; the command shown, never the tool's name.
    const approval = draw(CARDS.approval);
    const approvalText = textIn(approval);
    assert.match(approvalText, /waiting for approval/);
    assert.match(approvalText, /Allow this command with Full access\?/);
    assert.match(approvalText, /git push origin main/);
    assert.match(approvalText, /waiting 4 minutes/);
    assert.match(approvalText, /The session waits on this\. Answer here or in the session: the first answer counts\./);
    assert.doesNotMatch(approvalText, /\bbash\b/);
    await button(approval, 'Allow once').props.onClick();
    assert.deepEqual(acts.at(-1), ['answer', { id: CARDS.approval.id, answer: { decision: 'allow' } }]);
    await button(approval, 'Reject').props.onClick();
    assert.deepEqual(acts.at(-1), ['answer', { id: CARDS.approval.id, answer: { decision: 'reject' } }]);
    elementsOf(approval).find((e) => e.type === 'button' && textIn(e) === 'Deploy').props.onClick();
    assert.deepEqual(opened, ['s'], 'the session title opens it');

    // A DECISION NEEDED line: words, or the recommendation.
    const decision = draw(CARDS.decision);
    assert.match(textIn(decision), /needs a decision/);
    assert.match(textIn(decision), /Recommended: Keep them a week/);
    assert.match(textIn(decision), /It goes into the session as your next message\./);
    assert.equal(elementsOf(decision).find((e) => e.type === 'textarea').props.placeholder, 'Write your answer, or go with the recommendation');
    assert.equal(elementsOf(decision).find((e) => e.type === 'label').props.htmlFor, elementsOf(decision).find((e) => e.type === 'textarea').props.id, 'the box has its label');
    assert.equal(button(decision, 'Send').props.disabled, true, 'nothing to send yet');
    await button(decision, 'Go with the recommendation').props.onClick();
    assert.deepEqual(acts.at(-1), ['answer', { id: CARDS.decision.id, answer: { recommended: true } }]);
    assert.match(textIn(draw({ ...CARDS.decision, running: true })), /The session is running: your answer steers its current turn\./);
    assert.equal(button(draw({ ...CARDS.decision, recommendation: undefined }), 'Go with the recommendation'), undefined);

    // A question-box question: its choices, and its own answer.
    const question = draw(CARDS.question);
    assert.match(textIn(question), /asks you/);
    assert.match(textIn(question), /Target: Which environment\?/);
    const radios = elementsOf(question).filter((e) => e.type === 'input' && e.props.type === 'radio');
    assert.deepEqual(radios.map((e) => e.props.name), ['dshdc-q-question_q_c2-0', 'dshdc-q-question_q_c2-0']);
    assert.match(textIn(question), /safe/);
    assert.equal(button(question, 'Send answer').props.disabled, true, 'nothing chosen yet');
    assert.equal(elementsOf(question).filter((e) => e.type === 'fieldset').length, 1);
    assert.match(textIn(draw({ ...CARDS.question, late: true, live: false })), /its wait ran out; your answer reaches it as a new message/);
    // The question first, then what the session waits on.
    const said = textIn(question);
    assert.ok(said.indexOf('Which environment?') < said.indexOf('The session waits on this.'), said);

    // A plugin's question: its own options.
    const ask = draw(CARDS.ask);
    assert.match(textIn(ask), /from Autopilot/);
    assert.match(textIn(ask), /It has been idle\./);
    await button(ask, 'Leave it').props.onClick();
    assert.deepEqual(acts.at(-1), ['answer', { id: CARDS.ask.id, answer: { option: 'skip' } }]);

    // A thread that handed back: which coordinator's, and the answer goes into the thread.
    const thread = draw(CARDS.thread);
    assert.match(textIn(thread), /a thread of “Coordinator”/);
    assert.match(textIn(thread), /It goes into the thread as your next message\./);
    assert.match(textIn(thread), /needs a decision/);
    assert.match(textIn(draw({ ...CARDS.thread, status: 'blocked' })), /blocked/);

    // A plugin's question with nothing to pick or write: answered in the session, as the plugin says.
    const elsewhere = draw({ ...CARDS.ask, options: [], answer: 'session', hint: 'Answer in its terminal: open the session, then the agent\'s terminal tab.' });
    assert.match(textIn(elsewhere), /Answer in its terminal: open the session, then the agent's terminal tab\./);
    button(elsewhere, 'Answer in the session').props.onClick();
    assert.deepEqual(opened.at(-1), 's');
    // A card seen a moment ago: one form for "just now".
    assert.match(textIn(draw({ ...CARDS.decision, at: Date.now() - 50000 })), /waiting less than a minute/);
    assert.doesNotMatch(textIn(draw({ ...CARDS.decision, at: Date.now() - 10000 })), /just now/);

    // One only the session can answer: the way there.
    const open = draw(CARDS.open);
    assert.match(textIn(open), /Decisions was not holding this request when DSH asked, so answer it in the session\./);
    button(open, 'Answer in the session').props.onClick();
    assert.deepEqual(opened.at(-1), 'o');

    // Dismiss on every card.
    await button(decision, 'Dismiss').props.onClick();
    assert.deepEqual(acts.at(-1), ['dismiss', { id: CARDS.decision.id }]);

    // A failure is said as a failure, on the card, and takes the keyboard.
    const failed = draw({ ...CARDS.decision, error: 'Not delivered: the session was closed.' });
    const alert = elementsOf(failed).find((e) => e.props?.role === 'alert');
    assert.equal(textIn(alert), 'Not delivered: the session was closed.');
    assert.equal(alert.props.tabIndex, -1);
    assert.equal(textIn(elementsOf(draw({ ...CARDS.decision, error: 'the box is full' })).find((e) => e.props?.role === 'alert')), 'Not sent: the box is full');
    const sending = draw({ ...CARDS.decision, sending: true });
    assert.match(textIn(sending), /Sending your answer/);
    assert.equal(button(sending, 'Dismiss').props.disabled, true);
});

test('browser half: what you dismissed comes back, and the history says what happened in words', async () => {
    const { client } = loadClient(CLIENT);
    const { DismissedCard, HistoryCard, CSS, TEXT, SETTINGS } = client.internals;
    const acts = [];
    const act = async (method, args) => { acts.push(plain([method, args])); };
    assert.equal(DismissedCard({ data: base, onOpen: () => {}, act }), null, 'nothing dismissed, no card');
    const dismissed = DismissedCard({ data: { ...base, dismissed: [CARDS.decision] }, onOpen: () => {}, act });
    assert.match(textIn(dismissed), /Dismissed \(1\)/);
    assert.match(textIn(dismissed), /still waits in the session/);
    await elementsOf(dismissed).find((e) => e.type === 'Button' && textIn(e) === 'Bring back').props.onClick();
    assert.deepEqual(acts.at(-1), ['undismiss', { id: CARDS.decision.id }]);

    assert.match(textIn(HistoryCard({ data: base, onOpen: () => {} })), new RegExp(TEXT.noHistoryText));
    const now = Date.now();
    const history = HistoryCard({
        data: {
            ...base,
            history: [
                { id: 'e3', kind: 'answer', sessionId: 't', title: 'Schema', text: 'Answered: keep them', question: 'Drop the old tables?', note: '[Decisions] The person answered your DECISION NEEDED line', state: 'not delivered', reason: 'the session was closed', by: 'you', at: now },
                { id: 'e2', kind: 'mirror', text: 'Sent to hooks.example.com', state: 'sent', at: now },
                { id: 'e1', kind: 'new', sessionId: 't', title: 'Schema', text: 'Needs a decision', question: 'Drop the old tables?', at: now },
            ],
        },
        onOpen: () => {},
    });
    const text = textIn(history);
    assert.match(text, /Answered: keep them · You/);
    assert.match(text, /To: Drop the old tables\?/);
    assert.match(text, /Not delivered: the session was closed\./);
    assert.match(text, /What it sent\[Decisions\] The person answered/);
    assert.match(text, /Sent to hooks\.example\.com/);
    assert.doesNotMatch(text, /To: Drop the old tables\?[^]*To: Drop/, 'only an answer says what it answered');
    const tags = elementsOf(history).filter((e) => e.type === 'Tag').map((e) => [textIn(e), e.props.tone]);
    assert.deepEqual(plain(tags), [['not delivered', 'danger'], ['sent', 'success']]);
    // No other product's name anywhere in what it shows.
    assert.doesNotMatch(JSON.stringify(TEXT) + CSS.join('') + JSON.stringify(SETTINGS), OTHER_NAMES);
});

test('browser half: state words and their tones are the suite\'s, and the address check matches the host\'s', () => {
    const { client } = loadClient(CLIENT);
    const { kit, wordOf, webhookProblem, mirrorText } = client.internals;
    assert.deepEqual(Object.values(CARDS).map(wordOf), ['waiting for approval', 'needs a decision', 'asks you', 'asks you', 'needs a decision', 'waiting for approval']);
    assert.equal(wordOf({ kind: 'reply' }), 'asked you');
    assert.equal(wordOf({ kind: 'blocked' }), 'blocked');
    for (const word of ['waiting for approval', 'needs a decision', 'asks you', 'asked you']) assert.equal(kit.toneOf(word), 'warning', word);
    assert.equal(kit.toneOf('blocked'), 'danger');
    for (const good of ['https://hooks.example.com/x', 'http://127.0.0.1:8080/hook', 'http://localhost/hook', 'http://[::1]:9/hook']) assert.equal(webhookProblem(good), '', good);
    assert.match(webhookProblem('http://hooks.example.com/x'), /must start with https:\/\//);
    assert.match(webhookProblem('ftp://hooks.example.com/x'), /must start with https:\/\//);
    assert.match(webhookProblem('hooks.example.com'), /not a web address/);
    assert.equal(mirrorText({ mode: 'off' }), '');
    assert.equal(mirrorText(undefined), '');
});

/** DSH's settings form model with its write-only fields, enough to draw the form and see what it stages and stores. */
function standInForm() {
    const models = [];
    const edits = [];
    class SettingsFormModel {
        constructor(scope, specs, secrets = []) {
            this.scope = scope;
            this.specs = specs;
            this.secrets = secrets;
            models.push(this);
        }
        bind(project) {
            let value = project();
            return { subscribe: () => () => {}, getSnapshot: () => value, set: (next) => { value = next; } };
        }
        shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }; }
        field(name) {
            if (this.secrets.some((item) => item.field === name)) return { text: '', overridden: false, invalid: false };
            const spec = this.specs.find((item) => item.field === name);
            return { text: spec.format(this.scope.getSnapshot().value[name]), overridden: false, invalid: false };
        }
        actions() { return { edit: (field, text) => edits.push([field, text]), resetField: (field) => edits.push([field, null]), save: () => edits.push(['save']), discard: () => edits.push(['discard']) }; }
        dispose() { this.disposed = true; }
    }
    const SettingsForm = (props) => ({ type: 'SettingsForm', props, children: props.children });
    const SettingsSecretField = (props) => ({ type: 'SettingsSecretField', props, children: [] });
    return { models, edits, ui: { SettingsFormModel, SettingsForm, SettingsSecretField } };
}

/** DSH's key store as the window reaches it. */
function standInKeys(stored = {}) {
    const calls = [];
    const listeners = [];
    return {
        calls,
        stored,
        credentials: {
            describe: async (refs) => { calls.push(['describe', ...refs]); return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, stored[ref] ?? { configured: false, writable: true }])) }; },
            set: async (ref, value) => { calls.push(['set', ref, value]); stored[ref] = { configured: true, source: 'file', writable: true }; return { ok: true }; },
            unset: async (ref) => { calls.push(['unset', ref]); delete stored[ref]; return { ok: true }; },
        },
        $on: (name, fn) => { listeners.push([name, fn]); return () => {}; },
        emit: (name, value) => { for (const [n, fn] of listeners) if (n === name) fn(value); },
    };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('settings in Plugins: Decisions\' page there has its live settings, and the webhook address goes to DSH\'s key store', async () => {
    const form = standInForm();
    const { client } = loadClient(CLIENT, { ui: form.ui });
    const { SETTINGS } = client.internals;
    // Everything live is on the form, except the key's name (the profile's), which the address field writes under.
    const names = SETTINGS.filter((f) => f.kind !== 'secret').map((f) => f.name);
    assert.deepEqual([...names].sort(), LIVE_SETTINGS.filter((name) => name !== 'mirrorUrlEnv').sort());
    const secret = SETTINGS.find((f) => f.kind === 'secret');
    assert.equal(secret.keyFrom, 'mirrorUrlEnv');
    assert.equal(secret.defaultKey, DEFAULTS.mirrorUrlEnv);
    for (const f of SETTINGS.filter((item) => item.kind !== 'secret')) {
        assert.deepEqual(plain(f.default), plain(DEFAULTS[f.name]), `${f.name}: the form's default is the config's`);
        if (f.kind === 'choice') {
            for (const o of f.options) assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: o.value }), `${f.name}=${o.value}`);
        }
        if (f.kind !== 'number') continue;
        // The form takes exactly what the check takes.
        assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: f.min }), f.name);
        assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: f.max }), f.name);
        assert.throws(() => checkConfig({ ...DEFAULTS, [f.name]: f.min - 1 }), f.name);
        assert.throws(() => checkConfig({ ...DEFAULTS, [f.name]: f.max + 1 }), f.name);
    }

    const keys = standInKeys({ TEAM_HOOK: { configured: true, source: 'env', writable: false } });
    const registered = [];
    const effects = [];
    const served = [];
    let snapshot = { status: 'ready', writable: true, value: { ...DEFAULTS, mirror: 'webhook' } };
    const subscribers = [];
    const scope = {
        configForms: {
            get: (entry) => ({ entry, getSnapshot: () => snapshot, subscribe: (fn) => { subscribers.push(fn); return () => {}; } }),
            whileServed: (entries, fn) => { served.push(entries); return fn(); },
        },
        remote: keys,
        slots: { inject: (_name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        effect: (fn) => { effects.push(fn); },
        inject: (names, fn) => { if (names[0] === 'configForms') fn(scope); },
    };
    client.apply(scope);
    const disposers = effects.map((fn) => fn());
    await settle();
    assert.deepEqual(plain(served), [['decisions']], 'drawn only while DSH serves Decisions\' settings');
    assert.equal(form.models[0].scope.entry, 'decisions');
    assert.deepEqual(plain(form.models[0].secrets.map((s) => s.field)), ['webhookAddress']);
    assert.deepEqual(plain(keys.calls), [['describe', 'DECISIONS_WEBHOOK_URL']], 'it asks whether the key is set, never its value');
    const entry = registered.find((item) => item.spec.name === 'plugins.bundle.config');
    assert.equal(entry.spec.key, 'dsh-plugin-decisions');
    assert.match(entry.component({ view: 'summary' }), /^What Decisions lists/);
    let page = entry.component({});
    assert.match(textIn(page), /What it lists/);
    assert.match(textIn(page), /Somewhere else/);
    assert.match(textIn(page), /mirrorCommand in Decisions' entry/);
    let field = elementsOf(page).find((e) => e.type === 'SettingsSecretField');
    assert.equal(field.props.label, 'Webhook address');
    assert.equal(field.props.configured, false);
    assert.equal(field.props.stateLabel, 'No address yet');
    assert.equal(field.props.disabled, false);
    assert.equal(elementsOf(page).find((e) => e.type === 'button' && textIn(e) === 'Remove the address'), undefined, 'nothing to remove yet');
    // A typed address: one that cannot work is not staged; one that can is.
    field.props.onEdit('http://hooks.example.com/x');
    field.props.onEdit('https://hooks.example.com/x');
    assert.deepEqual(form.edits, [['webhookAddress', ''], ['webhookAddress', 'https://hooks.example.com/x']]);
    // What happened notes a set or removed address (never the address): the page's call to Decisions.
    const told = [];
    client.internals.kit.setConnection({ rpc: { call: async (_path, method, payload) => { told.push(plain([method, payload])); return { ok: true, value: { ok: true } }; } } });
    // Save writes it to the key store, under the key the settings name.
    assert.equal(await form.models[0].secrets[0].write('https://hooks.example.com/x'), true);
    assert.deepEqual(plain(keys.calls.at(-2)), ['set', 'DECISIONS_WEBHOOK_URL', 'https://hooks.example.com/x']);
    await settle();
    assert.deepEqual(told, [['dsh-plugin-decisions/addressChanged', { args: { change: 'set' } }]]);
    page = entry.component({});
    field = elementsOf(page).find((e) => e.type === 'SettingsSecretField');
    assert.equal(field.props.configured, true);
    assert.equal(field.props.stateLabel, 'An address is set');
    assert.equal(field.props.text, '', 'the field never shows a stored value');
    elementsOf(page).find((e) => e.type === 'button' && textIn(e) === 'Remove the address').props.onClick();
    await settle();
    assert.deepEqual(plain(keys.calls.find((c) => c[0] === 'unset')), ['unset', 'DECISIONS_WEBHOOK_URL']);
    assert.equal(elementsOf(entry.component({})).find((e) => e.type === 'SettingsSecretField').props.configured, false);
    await settle();
    assert.deepEqual(told.at(-1), ['dsh-plugin-decisions/addressChanged', { args: { change: 'removed' } }]);
    assert.ok(told.every(([, payload]) => !JSON.stringify(payload).includes('hooks.example.com')), 'the address never goes to Decisions');
    client.internals.kit.setConnection(undefined);
    // The profile names another key, set where DSH starts: it says so and cannot be changed here.
    snapshot = { ...snapshot, value: { ...snapshot.value, mirrorUrlEnv: 'TEAM_HOOK' } };
    for (const fn of subscribers) fn();
    await settle();
    field = elementsOf(entry.component({})).find((e) => e.type === 'SettingsSecretField');
    assert.equal(field.props.stateLabel, 'Set where DSH starts');
    assert.equal(field.props.disabled, true);
    assert.match(field.props.hint, /Set in the environment DSH started in/);
    // A key stored from elsewhere is read again.
    const before = keys.calls.length;
    keys.emit('credentials/reference-updated', 'TEAM_HOOK');
    await settle();
    assert.equal(keys.calls.length, before + 1);
    for (const dispose of disposers) if (typeof dispose === 'function') dispose();
    assert.equal(form.models[0].disposed, true);
});

test('settings in Plugins: on a DSH without a key store in the window, the form has its other settings and no address field', () => {
    const form = standInForm();
    const { client } = loadClient(CLIENT, { ui: form.ui });
    const registered = [];
    const scope = {
        configForms: { get: (entry) => ({ entry, getSnapshot: () => ({ status: 'ready', writable: true, value: { ...DEFAULTS } }), subscribe: () => () => {} }), whileServed: (_entries, fn) => fn() },
        remote: {},
        slots: { inject: (_name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        effect: (fn) => fn(),
        inject: (names, fn) => { if (names[0] === 'configForms') fn(scope); },
    };
    client.apply(scope);
    const page = registered.find((item) => item.spec.name === 'plugins.bundle.config').component({});
    assert.equal(elementsOf(page).find((e) => e.type === 'SettingsSecretField'), undefined);
    assert.ok(elementsOf(page).some((e) => e.type === 'Switch'));
    assert.deepEqual(plain(form.models[0].secrets), []);
});

test('browser half: a question\'s earlier lines fold after two, a BLOCKED line says what it waits for, and a thread\'s approval names its chat', () => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { DecisionCard, originWords } = client.internals;
    const act = async () => undefined;
    const reply = { id: 'reply:n:2', kind: 'reply', sessionId: 'n', title: 'Names', question: 'Which one do you prefer?', context: 'Here are three names:\n1. tidy\n2. sweep\n3. pare', at, running: false, answer: 'text' };
    const card = mount(DecisionCard, { card: reply, onOpen() {}, act, busyId: undefined, now: Date.now() });
    const before = () => elementsOf(card.tree).find((e) => e.props?.['data-decisions-context'] !== undefined);
    const toggle = () => elementsOf(before()).find((e) => e.type === 'Button');
    assert.equal(textIn(elementsOf(before()).find((e) => e.type === 'p')), 'Here are three names:\n1. tidy');
    assert.equal(textIn(toggle()), 'Show 2 more lines of the reply');
    assert.equal(toggle().props['aria-expanded'], 'false');
    toggle().props.onClick();
    assert.equal(textIn(elementsOf(before()).find((e) => e.type === 'p')), 'Here are three names:\n1. tidy\n2. sweep\n3. pare');
    assert.equal(textIn(toggle()), 'Show less of the reply');
    assert.equal(toggle().props['aria-expanded'], 'true');
    card.unmount();
    // Two lines or fewer: shown whole, nothing to unfold.
    const short = mount(DecisionCard, { card: { ...reply, context: 'Options: tidy or sweep.' }, onOpen() {}, act, busyId: undefined, now: Date.now() });
    assert.equal(elementsOf(short.tree).filter((e) => e.type === 'Button' && /of the reply/.test(textIn(e))).length, 0);
    short.unmount();
    const blocked = mount(DecisionCard, { card: { ...reply, id: 'blocked:n:2', kind: 'blocked', head: 'Blocked on:', question: 'valid staging credentials.', context: undefined }, onOpen() {}, act, busyId: undefined, now: Date.now() });
    assert.equal(textIn(elementsOf(blocked.tree).find((e) => /-ask$/.test(e.props?.className ?? ''))), 'Blocked on: valid staging credentials.');
    // Its own class: the kit's card head is a flex row and would put the words on a line of their own.
    const lead = elementsOf(blocked.tree).find((e) => e.type === 'span' && textIn(e) === 'Blocked on:');
    assert.ok(lead && !/-head$/.test(lead.props.className), lead?.props?.className);
    blocked.unmount();
    assert.equal(originWords({ ...CARDS.approval, via: { sessionId: 'co', title: 'Status page work' } }), 'in a thread of “Status page work”');
    assert.equal(originWords(CARDS.thread), 'a thread of “Coordinator”');
    assert.equal(originWords(CARDS.approval), '');
});
