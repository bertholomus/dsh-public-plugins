/**
 * Agent Terminals' browser half: loaded as DSH loads it, its page's parts
 * drawn as plain element trees, its settings form, the session rows' mark,
 * hover line and menu item, and the way it keeps each agent's terminal in a
 * tab beside its session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, LIVE_SETTINGS, SETTING_TITLES, checkConfig } from '../plugins/agent-terminals/lib/config.js';
import { STYLE_CHOICES } from '../plugins/agent-terminals/lib/page.js';
import { OTHER_NAMES, elementsOf, loadClient, statefulReact, strictRemote, textIn } from './helpers/client.mjs';

const CLIENT = new URL('../plugins/agent-terminals/lib/client.js', import.meta.url);
// What the client builds lives in its own realm: compared as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const buttons = (tree) => elementsOf(tree).filter((e) => e.type === 'Button');
const button = (tree, label) => buttons(tree).find((e) => textIn(e) === label);
const withAttr = (tree, name) => elementsOf(tree).filter((e) => e.props?.[name] !== undefined);

const now = Date.now();
/** An agent as the host's page state lists it (lib/agents.js view()). */
const view = (over = {}) => ({
    key: 'k1',
    sessionId: 's1',
    name: 'helper · app',
    program: 'helper',
    args: ['--fast'],
    style: 'flags',
    folder: '/Users/me/app',
    terminalId: 'agent-k1-1',
    terminal: { state: 'running', title: 'helper' },
    status: 'working',
    detail: 'Running a tool: npm test',
    wanted: 'running',
    ready: true,
    launching: false,
    canResume: true,
    keepsTranscript: true,
    turns: 2,
    createdAt: now - 3600000,
    launchedAt: now - 600000,
    launches: 1,
    typing: 'direct',
    controlTakenAt: 0,
    deliveries: [],
    ...over,
});
const WORKING = view();
const ASKING = view({
    key: 'k2', sessionId: 's2', name: 'reviewer', terminalId: 'agent-k2-1', status: 'waiting on you', detail: 'It asks you: Ship the release now?',
    ask: { question: 'Ship the release now?', recommendation: 'Ship it after the tests pass' },
    lastReply: { at: now - 120000, text: 'All checks pass.\n\nDECISION NEEDED: Ship the release now? — recommend: Ship it after the tests pass' },
});
const APPROVAL = view({ key: 'k3', sessionId: 's3', name: 'deployer', terminalId: 'agent-k3-1', status: 'waiting on you', detail: 'Its terminal asks for approval', call: { tool: 'Bash', summary: 'git push origin main', approval: true } });
const STOPPED = view({
    key: 'k4', sessionId: 's4', name: 'plain tool', program: 'tool', args: [], style: 'plain', terminalId: 'agent-k4-2', terminal: null, status: 'stopped', detail: 'Stopped by you.',
    wanted: 'stopped', canResume: false, keepsTranscript: false, launches: 2, ended: { why: 'stopped', text: 'You stopped it; its conversation stays.', at: now - 60000 },
});
const STATE = {
    enabled: true,
    terminals: true,
    agents: [],
    recent: [],
    detected: [],
    workspaces: [{ path: '/Users/me/app', title: 'app' }],
    styles: STYLE_CHOICES,
    settings: { resumeAfterRestart: true, listNewSessions: true, openTabs: true, typeWhileWorking: false, proofSeconds: 8, enterRetries: 2, askAfterSeconds: 20, notify: true, typing: 'auto' },
    history: [],
};

test('browser half: loads as DSH loads it; its entry (order 4), page, row mark, hover line and menu item, and one style sheet', () => {
    const heads = [];
    const document = {
        querySelector: () => null,
        createElement: (type) => ({ type, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
        head: { appendChild: (tag) => { heads.push(tag); } },
    };
    const { id, client } = loadClient(CLIENT, { document });
    assert.equal(id, 'dsh-plugin-agent-terminals');
    assert.equal(heads.length, 0, 'styles wait for apply');
    const registered = [];
    const opened = [];
    const panels = [];
    const scope = {
        slots: { inject: (_name, fn) => { fn(); }, register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        uiWorkspace: { openSession: (sessionId) => { opened.push(sessionId); } },
        get: (name) => (name === 'layout' ? { selectPanel: (panel) => panels.push(panel) } : undefined),
        effect: () => {},
    };
    client.apply({ ...scope, inject: (names, fn) => { if (names[0] === 'uiWorkspace') fn(scope); } });
    assert.equal(heads.length, 1);
    assert.equal(heads[0].attributes['data-plugin'], 'dsh-plugin-agent-terminals');
    const css = heads[0].textContent;
    assert.match(css, /\.dshat-card\{/);
    assert.match(css, /body\.wp-still/);
    assert.match(css, /prefers-reduced-motion/);
    // The session list: one mark in DSH's seat, giving way to a mark drawn before it there; every rule there ends in the plugin's own mark.
    assert.match(css, /\[data-row-key\^="session:"\]>\* \.dshat-mark:not\(:first-child\)\{position:absolute/);
    const listRules = css.split('\n').filter((line) => line.includes('data-row-key'));
    assert.ok(listRules.length > 0);
    for (const rule of listRules) {
        const selector = rule.slice(0, rule.indexOf('{'));
        assert.doesNotMatch(selector, /:has\(|~|\+/, selector);
        assert.match(selector.trim(), /\.dshat-mark(:not\(:first-child\))?$/, selector);
    }
    const spec = (name) => plain(registered.find((r) => r.spec.name === name).spec);
    assert.deepEqual(spec('sidebar.panellist'), { name: 'sidebar.panellist', id: 'dsh-plugin-agent-terminals:page', order: 4, label: 'Coding agents' });
    assert.deepEqual(spec('sidebar.session.row.leading'), { name: 'sidebar.session.row.leading', id: 'dsh-plugin-agent-terminals:mark', order: 15 });
    assert.deepEqual(spec('sidebar.session.row.hover'), { name: 'sidebar.session.row.hover', id: 'dsh-plugin-agent-terminals:hover', order: 15 });
    const menu = registered.find((r) => r.spec.name === 'sidebar.workspaces.session.menu.item');
    assert.equal(menu.spec.id, 'dsh-plugin-agent-terminals:menu');
    assert.equal(menu.spec.order, 60, 'after Full view (50), before Thread settings (250)');
    const page = registered.find((r) => r.spec.name === 'main');
    assert.equal(page.spec.key, 'dsh-plugin-agent-terminals:page');
    const views = page.spec.inject().agents;
    assert.equal(menu.spec.inject().agents, views, 'the menu item and the page share one way to open things');
    views.openSession('s1');
    views.openSession('');
    assert.deepEqual(opened, ['s1'], 'an empty id opens nothing');
    // An agent's terminal: its session opens, and its tab is asked for.
    const { reveal, preset, spotlight } = client.internals;
    views.openTerminal({ sessionId: 's2', terminalId: 'agent-k2-1' });
    assert.deepEqual(opened, ['s1', 's2']);
    assert.equal(reveal.get().sessionId, 's2');
    assert.equal(reveal.get().terminalId, 'agent-k2-1');
    views.openTerminal({ sessionId: 's2' });
    assert.deepEqual(opened, ['s1', 's2'], 'nothing to open without its terminal');
    views.startHere('s3', 'Fix the parser');
    assert.deepEqual(plain(preset.get()), { sessionId: 's3', title: 'Fix the parser', n: 1 });
    views.showAgent('k2');
    assert.deepEqual(plain(spotlight.get()), { key: 'k2', n: 1 });
    assert.deepEqual(panels, ['dsh-plugin-agent-terminals:page', 'dsh-plugin-agent-terminals:page'], 'both open the Coding agents page');
});

test('browser half: its words name no other assistant or maker, and say what to do next', () => {
    const { client } = loadClient(CLIENT);
    const { TEXT, SETTINGS, SETTINGS_SUMMARY, SETTINGS_NOTE, STATUS_WORDS, DELIVERY_WORDS } = client.internals;
    const words = [...Object.values(TEXT), ...SETTINGS.flatMap((f) => [f.title, f.hint, f.group ?? '']), SETTINGS_SUMMARY, SETTINGS_NOTE, ...Object.values(STATUS_WORDS), ...Object.values(DELIVERY_WORDS)];
    for (const text of words) assert.doesNotMatch(text, OTHER_NAMES, text);
    const source = readFileSync(CLIENT, 'utf8');
    assert.doesNotMatch(source.slice(source.indexOf('// </suite-kit>')), OTHER_NAMES);
    // Each empty state and error line ends in what to do.
    assert.match(TEXT.noneText, /Start one below/);
    assert.match(TEXT.disabled, /set enabled to true there and restart DSH/);
    assert.match(TEXT.noTerminals, /Restart DSH/);
    assert.match(TEXT.noHistoryText, /show here/);
});

test('the header: what runs and waits, why nothing can run, and where its settings are', () => {
    const { client } = loadClient(CLIENT);
    const { kit, HeaderCard, TEXT, countText } = client.internals;
    const starts = [];
    const onStart = () => starts.push(1);
    assert.equal(countText([]), '');
    assert.equal(countText([WORKING, ASKING, APPROVAL, STOPPED]), '3 running, 2 of them waiting on you · 1 stopped', 'the ones waiting on you are among the running');
    assert.equal(countText([ASKING]), '1 running, waiting on you');
    assert.equal(countText([ASKING, APPROVAL]), '2 running, both waiting on you');
    assert.equal(countText([ASKING, APPROVAL, { ...ASKING, key: 'k9' }]), '3 running, all 3 waiting on you');
    assert.equal(countText([STOPPED]), '1 stopped');
    const quiet = HeaderCard({ data: STATE, onStart });
    assert.equal(withAttr(quiet, 'data-agent-terminals-count').length, 0, 'no count line without agents');
    assert.equal(button(quiet, TEXT.settings), undefined, 'no settings button on a DSH that cannot open it');
    button(quiet, TEXT.start).props.onClick();
    assert.equal(starts.length, 1);
    assert.match(textIn(HeaderCard({ data: { ...STATE, agents: [WORKING, STOPPED] }, onStart })), /1 running · 1 stopped/);
    const off = HeaderCard({ data: { ...STATE, enabled: false }, onStart });
    assert.match(textIn(off), /Agent Terminals is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\)/);
    assert.equal(button(off, TEXT.start), undefined, 'nothing to start while it is off');
    const noTerminals = HeaderCard({ data: { ...STATE, terminals: false }, onStart });
    assert.equal(withAttr(noTerminals, 'data-agent-terminals-no-terminals')[0].props.role, 'alert');
    assert.match(textIn(noTerminals), /DSH's terminals are not running, so no agent can start or be reached\. Restart DSH/);
    assert.match(textIn(HeaderCard({ data: { ...STATE, watchProblem: { text: 'How often it reads (pollSeconds) must be a whole number (it is 0).' } }, onStart })),
        /Session Watch uses its default for a wrong setting: How often it reads \(pollSeconds\) must be a whole number \(it is 0\)\. Change it in Session Watch's settings in Plugins\./);
    const opened = [];
    kit.setNavigation({ openBundle: (name) => opened.push(name) });
    button(HeaderCard({ data: STATE, onStart }), TEXT.settings).props.onClick();
    assert.deepEqual(opened, ['dsh-plugin-agent-terminals']);
    kit.setNavigation(undefined);
});

test('an agent\'s card: its state, its session, what it does, and the actions its state takes', async () => {
    const { client } = loadClient(CLIENT);
    const { AgentCard } = client.internals;
    const acts = [];
    const act = async (method, args) => { acts.push(plain([method, args])); return undefined; };
    const opened = [];
    const draw = (agent) => AgentCard({ agent, act, busyKey: undefined, onOpen: (id) => opened.push(id), openTerminal: (a) => opened.push(`terminal:${a.key}`), spot: undefined });

    const working = draw(WORKING);
    const text = textIn(working);
    assert.match(text, /working/);
    assert.match(text, /helper --fast · in app · started 10 min ago/);
    assert.match(text, /Running a tool: npm test/);
    assert.equal(elementsOf(working).find((e) => e.type === 'h3').props.tabIndex, -1, 'a heading the page can bring into view');
    elementsOf(working).find((e) => e.type === 'button' && textIn(e) === 'helper · app').props.onClick();
    assert.deepEqual(opened, ['s1'], 'its name opens its session');
    button(working, 'Open its terminal').props.onClick();
    assert.deepEqual(opened, ['s1', 'terminal:k1']);
    await button(working, 'Stop').props.onClick();
    assert.deepEqual(acts.at(-1), ['stop', { key: 'k1' }]);
    assert.equal(button(working, 'Start again'), undefined);
    assert.equal(button(draw({ ...WORKING, launching: true }), 'Stop').props.disabled, true, 'not while it starts');

    // Idle after a reply: the reply shows once, whole, not again as the detail line above it.
    const idle = draw(view({ status: 'idle', detail: 'Done: the tests pass.', lastReply: { at: now - 30000, text: 'Done: the tests pass.\n\n12 of 12 green.' } }));
    assert.equal(withAttr(idle, 'data-agent-terminals-detail').length, 0, 'no detail line that repeats the reply');
    assert.equal(textIn(idle).split('Done: the tests pass.').length - 1, 1, 'the reply\'s words appear once');
    assert.match(textIn(draw(view({ status: 'idle', detail: 'Ready for its first message.' }))), /Ready for its first message\./, 'without a reply the detail says what it waits for');

    // It asks a question: the question, the recommendation, one click to go with it, or an answer of your own.
    const asking = draw(ASKING);
    const askText = textIn(asking);
    assert.match(askText, /waiting on you/);
    assert.match(askText, /Ship the release now\?/);
    assert.match(askText, /Recommended: Ship it after the tests pass/);
    assert.doesNotMatch(askText, /It asks you: Ship the release now\?/, 'the detail line does not say the question twice');
    assert.equal(withAttr(asking, 'data-agent-terminals-reply')[0].props['data-agent-terminals-reply'], 'folded', 'the whole reply is folded under the question it asks');
    await button(asking, 'Go with the recommendation').props.onClick();
    assert.deepEqual(acts.at(-1), ['send', { key: 'k2', text: 'Go with your recommendation: Ship it after the tests pass' }]);
    assert.equal(elementsOf(asking).find((e) => e.type === 'label' && /answer/.test(textIn(e))).children[0], 'Your answer');

    // Its terminal asks for approval: the way there is the card's one main action.
    const approval = draw(APPROVAL);
    assert.match(textIn(approval), /It asks to run “git push origin main”\./);
    assert.match(textIn(approval), /It asks for your approval in its terminal: answer there\./);
    const opens = buttons(approval).filter((e) => textIn(e) === 'Open its terminal');
    assert.equal(opens.length, 1, 'one "Open its terminal" per card');
    assert.equal(opens[0].props.variant, 'primary');

    // Stopped: start it again (resuming where its program can), anew, or forget it.
    const stopped = draw(STOPPED);
    assert.match(textIn(stopped), /stopped/);
    assert.match(textIn(stopped), /You stopped it; its conversation stays\./);
    assert.doesNotMatch(textIn(stopped), /started \d+ min ago/);
    assert.equal(button(stopped, 'Start anew'), undefined, 'a program that cannot resume has only Start again');
    await button(stopped, 'Start again').props.onClick();
    assert.deepEqual(acts.at(-1), ['startAgain', { key: 'k4', fresh: false }]);
    await button(draw({ ...STOPPED, canResume: true }), 'Start anew').props.onClick();
    assert.deepEqual(acts.at(-1), ['startAgain', { key: 'k4', fresh: true }]);
    assert.equal(button(stopped, 'Open its terminal'), undefined);
    assert.match(textIn(stopped), /This program keeps no transcript Agent Terminals can read, so a message counts as typed in, not proven read\./);

    // Busy: its buttons wait; its message box stays where the keyboard is.
    const busy = AgentCard({ agent: WORKING, act, busyKey: 'k1', onOpen: () => {}, openTerminal: () => {}, spot: undefined });
    assert.equal(button(busy, 'Stop').props.disabled, true);
    assert.equal(elementsOf(busy).find((e) => e.type === 'textarea').props.readOnly, true);
    assert.equal(elementsOf(busy).find((e) => e.type === 'textarea').props.disabled, undefined);
});

test('an agent\'s card: Forget asks first and says what stays; the program by its name, its path on hover', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { AgentCard, shortCommand } = client.internals;
    const acts = [];
    const act = async (method, args) => { acts.push(plain([method, args])); return undefined; };
    const card = mount(AgentCard, { agent: STOPPED, act, busyKey: undefined, onOpen() {}, openTerminal() {}, spot: undefined });
    t.after(() => card.unmount());
    button(card.tree, 'Forget').props.onClick();
    assert.match(textIn(card.tree), /Forget “plain tool”\? Its session and its conversation files stay\./);
    assert.equal(button(card.tree, 'Start again'), undefined, 'the question is the card\'s only business');
    assert.equal(acts.length, 0, 'nothing forgotten yet');
    button(card.tree, 'Keep it').props.onClick();
    assert.ok(button(card.tree, 'Start again'), 'Keep it goes back');
    button(card.tree, 'Forget').props.onClick();
    await button(card.tree, 'Forget it').props.onClick();
    assert.deepEqual(acts, [['forget', { key: 'k4' }]]);

    // A program given by its path: its name on the card, the whole command on hover.
    const long = { ...WORKING, program: '/Users/me/tools/bin/helper', programName: 'helper' };
    assert.equal(shortCommand(long), 'helper --fast');
    const code = elementsOf(AgentCard({ agent: long, act, busyKey: undefined, onOpen() {}, openTerminal() {}, spot: undefined })).find((e) => e.props?.className === 'dshat-code');
    assert.deepEqual([textIn(code), code.props.title], ['helper --fast', '/Users/me/tools/bin/helper --fast']);
    assert.equal(shortCommand({ program: '/opt/x/agent', args: [] }), 'agent', 'a host that sends no short name');
});

test('an agent\'s card while Agent Terminals does not follow its agents: no buttons that would act, no message box', () => {
    const { client } = loadClient(CLIENT);
    const { AgentCard } = client.internals;
    const draw = (agent) => AgentCard({ agent, act: async () => undefined, busyKey: undefined, onOpen() {}, openTerminal() {}, spot: undefined });
    const running = draw({ ...WORKING, status: 'running', followed: false, detail: 'Running in its terminal, not followed: Agent Terminals waits for a setting to be fixed (see the top of this page), then picks it up where it is.' });
    assert.match(textIn(running), /Running in its terminal, not followed/);
    for (const label of ['Stop', 'Start again', 'Start anew', 'Forget']) assert.equal(button(running, label), undefined, label);
    assert.ok(button(running, 'Open its terminal'), 'its terminal can still be opened');
    assert.equal(elementsOf(running).find((e) => e.type === 'textarea'), undefined, 'no message box');
    const stopped = draw({ ...STOPPED, followed: false });
    assert.deepEqual(['Start again', 'Forget', 'Open its terminal'].map((label) => button(stopped, label)), [undefined, undefined, undefined]);
});

test('the list\'s line follows a message you sent: typed in, delivered, or not proven', () => {
    const { client } = loadClient(CLIENT);
    const { saidLine } = client.internals;
    const said = { text: 'Queued for “helper · app”. It is typed in when the agent is ready, and marked delivered once its transcript shows it.', n: 1, at: now, delivery: 'm1', key: 'k1' };
    const data = (state, more = {}) => ({ agents: [{ ...WORKING, deliveries: [{ id: 'm1', text: 'Run the linter', by: 'you', at: now, state, ...more }] }] });
    assert.equal(saidLine(said, data('queued'), now).text, said.text);
    assert.equal(saidLine(said, data('waiting', { why: 'The agent is working; this is typed in when it is idle.' }), now).text, 'Queued for “helper · app”: The agent is working; this is typed in when it is idle.');
    assert.equal(saidLine(said, data('typed'), now).text, 'Typed into “helper · app”\'s terminal; waiting for its transcript to show it.');
    assert.deepEqual(plain(saidLine(said, data('delivered'), now)), { text: '“helper · app” has your message: its transcript shows it.' });
    assert.deepEqual(plain(saidLine(said, data('not proven'), now)), { text: 'Typed into “helper · app”\'s terminal, but its transcript has not shown it: look at its terminal.', warn: true });
    assert.deepEqual(plain(saidLine(said, data('failed', { why: 'Not typed in: its terminal was closed.' }), now)), { text: 'Your message was not typed in: its terminal was closed.', warn: true });
    assert.equal(saidLine(said, data('cancelled'), now).text, 'Taken back before it was typed in.');
    assert.equal(saidLine(said, data('delivered'), now + 121000).text, '', 'gone two minutes later');
    assert.equal(saidLine({ text: 'Stopped “x”.', n: 2, at: now }, data('queued'), now).text, 'Stopped “x”.', 'other actions say what they did');
    assert.equal(saidLine(said, { agents: [] }, now).text, said.text, 'a message whose agent is gone keeps its words');
});

test('an agent\'s messages: each one\'s state in words, why it waits, and Take back while it can', async () => {
    const { client } = loadClient(CLIENT);
    const { AgentCard, deliveryWord, kit } = client.internals;
    const acts = [];
    const act = async (method, args) => { acts.push(plain([method, args])); return undefined; };
    const item = (id, state, more = {}) => ({ id, text: `message ${id}`, by: 'you', at: now - 30000, state, ...more });
    const agent = view({
        deliveries: [
            item('m6', 'queued'),
            item('m5', 'waiting', { why: 'It is working; the message is typed in once it is idle.' }),
            item('m4', 'typed', { by: 'Decisions' }),
            item('m3', 'delivered', { enters: 2 }),
            item('m2', 'not proven', { why: 'Its transcript never showed it.' }),
            item('m1', 'cancelled', { why: 'You took it back before it was typed in.' }),
        ],
    });
    assert.equal(deliveryWord({ state: 'typed' }), 'typed in');
    assert.equal(deliveryWord({ state: 'cancelled' }), 'taken back');
    assert.equal(kit.toneOf('typed in'), 'info');
    assert.equal(kit.toneOf('typing'), 'info');
    assert.equal(kit.toneOf('not proven'), 'warning');
    assert.equal(kit.toneOf('taken back'), 'neutral');
    const card = AgentCard({ agent, act, busyKey: undefined, onOpen: () => {}, openTerminal: () => {}, spot: undefined });
    const rows = withAttr(card, 'data-agent-terminals-message');
    assert.deepEqual(rows.map((r) => r.props['data-agent-terminals-message']), ['queued', 'waiting', 'typed', 'delivered'], 'the newest four, then Show all');
    assert.match(textIn(card), /Messages \(6\)/);
    assert.ok(button(card, 'Show all 6'));
    assert.match(textIn(rows[1]), /It is working; the message is typed in once it is idle\./);
    assert.match(textIn(rows[2]), /from Decisions/);
    assert.match(textIn(rows[3]), /Enter pressed 2 times/);
    assert.deepEqual(rows.map((r) => elementsOf(r).find((e) => e.type === 'Tag').children[0]), ['queued', 'waiting', 'typed in', 'delivered']);
    // Only a message not typed in yet can be taken back.
    assert.ok(button(rows[0], 'Take back'));
    assert.ok(button(rows[1], 'Take back'));
    assert.equal(button(rows[2], 'Take back'), undefined);
    await button(rows[1], 'Take back').props.onClick();
    assert.deepEqual(acts.at(-1), ['cancel', { key: 'k1', id: 'm5' }]);
});

test('the page: reads the agents, shows each, and says what an action did, in words and where the keyboard is', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, AgentsPage } = client.internals;
    const calls = [];
    let state = { ...STATE, agents: [ASKING, WORKING, STOPPED], history: [] };
    kit.setConnection({ rpc: { call: async (_path, method, payload) => {
        calls.push([method.replace('dsh-plugin-agent-terminals/', ''), plain(payload.args)]);
        if (method.endsWith('/state')) return { ok: true, value: state };
        if (method.endsWith('/send')) return { ok: true, value: { delivery: { id: 'm9', state: 'queued', text: payload.args.text } } };
        if (method.endsWith('/stop')) return { ok: true, value: { agent: { ...WORKING, status: 'stopped' } } };
        if (method.endsWith('/startAgain')) return { ok: true, value: { agent: STOPPED, problem: 'There is no program named tool where DSH looks for programs.' } };
        if (method.endsWith('/forget')) return { ok: false, error: { code: 'agent-terminals/refused', message: 'That agent is not in the list any more.' } };
        return new Promise(() => {});
    } } });
    const views = { opened: [], openSession: (id) => views.opened.push(id), openTerminal: (agent) => views.opened.push(`terminal:${agent.key}`) };
    const page = mount(AgentsPage, { agents: views });
    // A page that leaves stops following the hub (whose wait would otherwise keep going).
    t.after(() => page.unmount());
    assert.match(textIn(page.tree), /Reading the coding agents/);
    await settle(5);
    const text = textIn(page.tree);
    assert.match(text, /2 running, 1 of them waiting on you · 1 stopped/);
    assert.deepEqual(withAttr(page.tree, 'data-agent-terminals-agent').map((e) => e.props['data-agent-terminals-agent']), ['k2', 'k1', 'k4'], 'in the order the host sorts them: waiting on you first');
    assert.match(text, /Closing an agent's terminal tab ends the agent; Start again brings it back\./);
    assert.ok(withAttr(page.tree, 'data-agent-terminals-start').length === 1, 'the start form');
    assert.match(text, /Nothing yet/, 'an empty history says what will show');

    // Send from a card: queued in words on the list's status line, and the page reads the agents again.
    const box = elementsOf(withAttr(page.tree, 'data-agent-terminals-agent')[1]).find((e) => e.type === 'textarea');
    box.props.onChange({ target: { value: 'Run the linter too.' } });
    const card = () => withAttr(page.tree, 'data-agent-terminals-agent')[1];
    await button(card(), 'Send').props.onClick();
    await settle(5);
    assert.deepEqual(calls.find(([m]) => m === 'send'), ['send', { key: 'k1', text: 'Run the linter too.' }]);
    const said = () => withAttr(page.tree, 'data-agent-terminals-said')[0];
    assert.equal(said().props.role, 'status');
    assert.equal(textIn(said()), 'Queued for “helper · app”. It is typed in when the agent is ready, and marked delivered once its transcript shows it.');
    assert.equal(elementsOf(card()).find((e) => e.type === 'textarea').props.value, '', 'the box empties once it is queued');
    assert.ok(calls.filter(([m]) => m === 'state').length >= 2, 'read again after acting');

    // Start again fails to start: the card says so, in an alert that takes the keyboard.
    await button(withAttr(page.tree, 'data-agent-terminals-agent')[2], 'Start again').props.onClick();
    await settle(5);
    const failed = withAttr(withAttr(page.tree, 'data-agent-terminals-agent')[2], 'data-agent-terminals-error')[0];
    assert.equal(failed.props.role, 'alert');
    assert.equal(failed.props.tabIndex, -1);
    assert.equal(textIn(failed), 'Not done: It could not start: There is no program named tool where DSH looks for programs.');
    // A refusal: the host's words (Forget asks first).
    await button(withAttr(page.tree, 'data-agent-terminals-agent')[2], 'Forget').props.onClick();
    await button(withAttr(page.tree, 'data-agent-terminals-agent')[2], 'Forget it').props.onClick();
    await settle(5);
    assert.equal(textIn(withAttr(withAttr(page.tree, 'data-agent-terminals-agent')[2], 'data-agent-terminals-error')[0]), 'Not done: That agent is not in the list any more.');

    // A setting is wrong: the page says which, and still lists the agents and what happened.
    state = { ...state, problem: { key: 'proofSeconds', text: 'Seconds without proof before Enter is pressed again (proofSeconds) must be a whole number of seconds from 2 to 120 (it is 1)', live: true } };
    const problemPage = mount(AgentsPage, { agents: views });
    t.after(() => problemPage.unmount());
    await settle(5);
    assert.match(textIn(problemPage.tree), /Agent Terminals is waiting for a setting to be fixed\./);
    assert.match(textIn(problemPage.tree), /\(it is 1\)\.Change it in Agent Terminals' settings in Plugins\./);
    assert.equal(withAttr(problemPage.tree, 'data-agent-terminals-start').length, 0, 'nothing new starts until it is fixed');
    assert.equal(withAttr(problemPage.tree, 'data-agent-terminals-agent').length, 3);
});

test('the page: when Agent Terminals is not running it says so and what to do, never old data', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, AgentsPage } = client.internals;
    kit.setConnection({ rpc: { call: async (_path, method) => {
        if (method === 'dsh-plugin-session-watch/status') return { ok: true, value: {} };
        throw new Error(`transport failure for /api/${method}: HTTP 404`);
    } } });
    const page = mount(AgentsPage, { agents: {} });
    t.after(() => page.unmount());
    await settle(5);
    const trouble = withAttr(page.tree, 'data-suite-trouble')[0];
    assert.equal(trouble.props['data-suite-trouble'], 'not-running');
    assert.match(textIn(trouble), /Agent Terminals is not running\./);
    assert.match(textIn(trouble), /switch it off and on again/);
    assert.ok(button(trouble, 'Check again'));
});

test('the start form: programs found and used before, how it resumes, where it works; it sends what the host checks', async () => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, StartCard, preset } = client.internals;
    const calls = [];
    let answer = { ok: true, value: { agent: view({ key: 'k9', name: 'helper · app' }) } };
    kit.setConnection({ rpc: { call: async (_path, method, payload) => {
        calls.push([method.replace('dsh-plugin-agent-terminals/', ''), plain(payload.args)]);
        return answer;
    } } });
    const data = {
        ...STATE,
        detected: [
            { program: 'helper', style: 'flags', conversations: 12, latest: now - 3600000, path: '/usr/local/bin/helper' },
            { program: 'worker', style: 'subcommand', data: '~/.worker', conversations: 1, latest: 0 },
        ],
        recent: [{ program: 'tool', args: ['--model', 'small one'], style: 'plain' }],
    };
    const started = [];
    const form = mount(StartCard, { data, onStarted: (agent, problem) => started.push([agent?.key, problem]), formRef: { current: undefined } });
    const find = (pred) => elementsOf(form.tree).find(pred);
    const input = (id) => find((e) => (e.type === 'input' || e.type === 'textarea') && e.props.id === `dshat-${id}`);
    const startButton = () => buttons(form.tree).find((e) => e.props.type === 'submit');
    const text = textIn(form.tree);
    assert.match(text, /Found on this computer/);
    assert.match(text, /12 conversations · last 1 h ago/);
    assert.match(text, /1 conversation · not found where DSH looks for programs/);
    assert.match(text, /Used here before/);
    assert.match(text, /tool --model small one/);
    // Nothing to start yet: the button waits and says what is missing.
    assert.equal(startButton().props.disabled, true);
    assert.match(textIn(form.tree), /Name the program first\./);
    // A program found on this computer: its path, and how it resumes.
    find((e) => e.props?.['data-agent-terminals-found'] === 'helper').props.onClick();
    assert.equal(input('program').props.value, '/usr/local/bin/helper');
    assert.equal(find((e) => e.type === 'input' && e.props.type === 'radio' && e.props.value === 'flags').props.checked, true);
    assert.ok(input('data'), 'a program with transcripts: where it keeps them');
    assert.match(textIn(form.tree), /Choose the folder it works in\./);
    // Used before: its arguments, quoted where a part has spaces.
    find((e) => e.props?.['data-agent-terminals-recent'] === '0').props.onClick();
    assert.equal(input('program').props.value, 'tool');
    assert.equal(input('args').props.value, '--model "small one"');
    assert.equal(input('data'), undefined, 'no transcripts, no folder for them');
    // Typed in: a known program's way, until one is chosen.
    const fresh = mount(StartCard, { data, onStarted: () => {}, formRef: { current: undefined } });
    const freshInput = (id) => elementsOf(fresh.tree).find((e) => e.type === 'input' && e.props.id === `dshat-${id}`);
    freshInput('program').props.onChange({ target: { value: 'worker' } });
    assert.equal(elementsOf(fresh.tree).find((e) => e.props?.type === 'radio' && e.props.value === 'subcommand').props.checked, true);
    assert.equal(freshInput('data').props.value, '~/.worker');
    elementsOf(fresh.tree).find((e) => e.props?.type === 'radio' && e.props.value === 'plain').props.onChange();
    freshInput('program').props.onChange({ target: { value: 'helper' } });
    assert.equal(elementsOf(fresh.tree).find((e) => e.props?.type === 'radio' && e.props.value === 'plain').props.checked, true, 'a chosen way stays');

    // A folder, a name, a first message: what goes to the host.
    input('folder').props.onChange({ target: { value: '~/Projects/app' } });
    assert.deepEqual(plain(find((e) => e.type === 'datalist').children.map((o) => o.props.value)), ['/Users/me/app'], 'the folders DSH knows, offered');
    assert.equal(input('name').props.placeholder, 'tool · app', 'the name it gets when left empty');
    input('task').props.onChange({ target: { value: 'Read the README first.' } });
    assert.equal(startButton().props.disabled, false);
    await startButton().props.onClick({ preventDefault() {} });
    await settle(5);
    assert.deepEqual(calls.at(-1), ['start', { input: { program: 'tool', args: '--model "small one"', style: 'plain', folder: '~/Projects/app', task: 'Read the README first.' } }]);
    assert.deepEqual(started, [['k9', undefined]]);
    assert.equal(input('program').props.value, '', 'the form starts over');

    // From a session's ⋯ menu: in that session, no folder to choose.
    preset.set({ sessionId: 's7', title: 'Parser work', n: 1 });
    const here = mount(StartCard, { data, onStarted: () => {}, formRef: { current: undefined } });
    const hereText = textIn(here.tree);
    assert.match(hereText, /In the session “Parser work”/);
    assert.equal(elementsOf(here.tree).find((e) => e.props?.id === 'dshat-folder'), undefined);
    elementsOf(here.tree).find((e) => e.props?.id === 'dshat-program').props.onChange({ target: { value: 'helper' } });
    answer = { ok: false, error: { code: 'agent-terminals/refused', message: 'The program is one word (put its options under Arguments), or a full path.' } };
    await buttons(here.tree).find((e) => e.props.type === 'submit').props.onClick({ preventDefault() {} });
    await settle(5);
    assert.deepEqual(calls.at(-1), ['start', { input: { program: 'helper', args: '', style: 'flags', sessionId: 's7' } }]);
    const alert = elementsOf(here.tree).find((e) => e.props?.['data-agent-terminals-start-error'] !== undefined);
    assert.equal(alert.props.role, 'alert');
    assert.equal(textIn(alert), 'Not started: The program is one word (put its options under Arguments), or a full path.');
    assert.equal(elementsOf(here.tree).find((e) => e.props?.id === 'dshat-program').props.value, 'helper', 'a refused start keeps what you typed');
    preset.set(undefined);
});

test('what happened: each entry with its agent, its words, why, and its outcome', () => {
    const { client } = loadClient(CLIENT);
    const { HistoryCard } = client.internals;
    const opened = [];
    const entry = (id, over) => ({ id, at: now - 60000, sessionId: 's1', agent: 'k1', by: 'Agent Terminals', ...over });
    const card = HistoryCard({
        data: {
            ...STATE,
            agents: [WORKING],
            history: [
                entry('e5', { kind: 'proof', text: 'No proof that helper · app read a message', why: 'Its transcript never showed “x”.', state: 'failed' }),
                entry('e4', { kind: 'message', text: 'Message for helper · app', why: 'You sent it: “x”', state: 'not proven', reason: 'Its transcript never showed it.', by: 'you' }),
                entry('e3', { kind: 'ask', text: 'helper · app waits on you', why: 'Ship it?', state: 'waiting on you' }),
                entry('e2', { kind: 'message', text: 'Message for helper · app', why: 'You sent it: “y”', state: 'cancelled', reason: 'You took it back before it was typed in.', by: 'you' }),
                entry('e1', { kind: 'start', text: 'Started helper · app', why: 'You started helper in /Users/me/app, in a new session.', state: 'done', by: 'you' }),
            ],
        },
        onOpen: (id) => opened.push(id),
    });
    const rows = withAttr(card, 'data-agent-terminals-entry');
    assert.equal(rows.length, 5);
    const tag = (row) => elementsOf(row).find((e) => e.type === 'Tag')?.children[0];
    assert.deepEqual(rows.map(tag), ['failed', 'not proven', undefined, 'taken back', undefined], 'an ask\'s entry and a done one carry no tag');
    assert.match(textIn(rows[1]), /Not proven: Its transcript never showed it\./);
    assert.match(textIn(rows[1]), / · You/);
    assert.match(textIn(rows[3]), /You took it back before it was typed in\./);
    assert.doesNotMatch(textIn(rows[3]), /Taken back:/);
    assert.match(textIn(rows[4]), /Why: You started helper in \/Users\/me\/app, in a new session\./);
    elementsOf(rows[0]).find((e) => e.type === 'button' && textIn(e) === 'helper · app').props.onClick();
    assert.deepEqual(opened, ['s1'], 'an entry\'s agent opens its session');
});

test('session rows: the mark says what the agent does (in DSH\'s dots, and in words), the hover card adds what it does, the menu item fits', () => {
    const { client } = loadClient(CLIENT);
    const { AgentMark, AgentHover, AgentMenuItem, AgentsIcon, marks } = client.internals;
    const mark = (over) => ({ key: 'k1', sessionId: 's1', name: 'helper · app', terminalId: 'agent-k1-1', running: true, status: 'working', controlTakenAt: 0, ...over });
    marks.set({ off: false, openTabs: true, agents: [mark(), mark({ key: 'k2', sessionId: 's2', status: 'waiting on you', detail: 'It asks you: Ship it?' }), mark({ key: 'k3', sessionId: 's3', status: 'idle' }), mark({ key: 'k4', sessionId: 's4', status: 'stopped', running: false })] });
    const dotIn = (tree) => elementsOf(tree).find((e) => e.type === 'StateDot')?.props.state;
    assert.equal(AgentMark({ sessionId: 'nope' }), null, 'a session with no agent: no mark');
    assert.equal(dotIn(AgentMark({ sessionId: 's1' })), 'ongoing');
    assert.equal(textIn(AgentMark({ sessionId: 's1' })), 'Coding agent: working.');
    assert.equal(dotIn(AgentMark({ sessionId: 's2' })), 'warning');
    assert.equal(textIn(AgentMark({ sessionId: 's2' })), 'Coding agent: waiting on you.');
    const idle = AgentMark({ sessionId: 's3' });
    assert.equal(dotIn(idle), undefined);
    assert.ok(elementsOf(idle).some((e) => e.type === 'svg' && e.props['aria-hidden'] === 'true'), 'idle: the terminal glyph, hidden from screen readers');
    const stopped = AgentMark({ sessionId: 's4' });
    assert.equal(stopped.props['data-agent-terminals-mark'], 'stopped');
    assert.ok(elementsOf(stopped).some((e) => e.type === 'rect' && e.props.fill === 'currentColor'), 'stopped: the glyph with a stop square');
    assert.equal(stopped.props.title, undefined, 'said once: in words and in the hover card, not in a tooltip too');
    // The hover card: in words, on DSH's dark card.
    const hover = AgentHover({ sessionId: 's2' });
    assert.equal(textIn(hover), 'Coding agent in its terminal: waiting on youIt asks you: Ship it?');
    assert.equal(AgentHover({ sessionId: 'nope' }), null);
    // The panel entry: how many wait on you, in a badge and in words.
    const icon = AgentsIcon({});
    assert.equal(icon.props['data-agent-terminals-icon'], '1');
    assert.match(textIn(icon), /1 coding agent waiting on you/);
    // The ⋯ menu: start one where there is none; open its terminal while it runs; show it when it does not.
    const closed = [];
    const calls = [];
    const views = { startHere: (...args) => calls.push(['startHere', ...args]), openTerminal: (agent) => calls.push(['openTerminal', agent.key]), showAgent: (key) => calls.push(['showAgent', key]) };
    const item = (sessionId) => AgentMenuItem({ sessionId, displayTitle: 'Parser work', useMenuOpenState: () => [true, (open) => closed.push(open)], agents: views });
    assert.equal(textIn(item('s9')), 'Start a coding agent here');
    item('s9').props.onSelect();
    assert.equal(textIn(item('s1')), 'Open the coding agent\'s terminal');
    item('s1').props.onSelect();
    assert.equal(textIn(item('s4')), 'Show its coding agent');
    item('s4').props.onSelect();
    assert.deepEqual(plain(calls), [['startHere', 's9', 'Parser work'], ['openTerminal', 'k1'], ['showAgent', 'k4']]);
    assert.deepEqual(closed, [false, false, false], 'each choice closes the menu');
    // Off (switched off, a wrong setting, no terminals): no marks, no menu item, no count.
    marks.set({ off: true, openTabs: true, agents: [] });
    assert.equal(AgentMark({ sessionId: 's1' }), null);
    assert.equal(item('s9'), null);
    assert.equal(AgentsIcon({}).props['data-agent-terminals-icon'], 'off');
});

test('the marks follow the agents: one read for changes close together, and off when Agent Terminals cannot answer', async () => {
    const { client } = loadClient(CLIENT);
    const { kit, marks, followMarks } = client.internals;
    const calls = [];
    let answer = { ok: true, value: { off: false, openTabs: false, agents: [{ key: 'k1', sessionId: 's1', name: 'helper', terminalId: 'agent-k1-1', running: true, status: 'working', controlTakenAt: 0 }, 'junk'] } };
    kit.setConnection({ rpc: { call: async (_path, method) => {
        calls.push(method);
        return method === 'dsh-plugin-agent-terminals/marks' ? answer : new Promise(() => {});
    } } });
    let bump;
    kit.hub.subscribe = (channels, fn) => {
        assert.deepEqual(plain(channels), ['agent-terminals', 'sessions', 'settings']);
        bump = fn;
        return () => { bump = undefined; };
    };
    const stop = followMarks();
    await settle(5);
    assert.equal(marks.get().off, false);
    assert.equal(marks.get().openTabs, false);
    assert.deepEqual(plain(marks.get().agents.map((a) => a.key)), ['k1'], 'what is not an agent is dropped');
    answer = { ok: false, error: { code: 'not-running', message: 'Agent Terminals is not running in DSH.' } };
    bump();
    bump();
    bump();
    await settle(380);
    assert.equal(calls.length, 2, 'three changes close together: one read');
    assert.equal(marks.get().off, true);
    assert.equal(marks.get().code, 'not-running');
    stop();
    assert.equal(bump, undefined, 'stops listening');
    assert.equal(marks.get().agents.length, 0);
});

/** DSH's right sidebar as Agent Terminals uses it: the on-screen session, its tabs, and opening, focusing and expanding. */
function standInSidebar() {
    const subs = new Set();
    let n = 0;
    const sidebar = {
        calls: [],
        current: 's1',
        expanded: true,
        refuse: false,
        tabs: { s1: [] },
        mounted: { getSnapshot: () => sidebar.current, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } },
        openTabs: { getSnapshot: () => Object.values(sidebar.tabs).flat(), subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } },
        tabsIn: (sessionId) => [...(sidebar.tabs[sessionId] ?? [])],
        tabDomain: {
            occurrence: (sessionId, { id }) => {
                const tab = (sidebar.tabs[sessionId] ?? []).find((t) => t.id === id);
                if (!tab?.params) throw new Error('no occurrence');
                return { navigation: { getSnapshot: () => ({ address: tab.contentId, params: tab.params }) } };
            },
        },
        openTab(kind, options) {
            sidebar.calls.push(['openTab', kind, plain(options)]);
            if (sidebar.refuse) throw new Error('sidebarRight: no session surface is mounted');
            n += 1;
            const list = sidebar.tabs[sidebar.current] ?? (sidebar.tabs[sidebar.current] = []);
            const tab = { id: `t${n}`, kind, contentId: `dsh-resource://page/terminal/${n}`, title: 'Terminal', params: options.params };
            const at = options.replaceTab ? list.findIndex((t) => t.id === options.replaceTab) : -1;
            if (at >= 0) list.splice(at, 1, tab);
            else list.push(tab);
        },
        focus: (tabId) => sidebar.calls.push(['focus', tabId]),
        isExpanded: () => sidebar.expanded,
        toggleExpanded: () => {
            sidebar.calls.push(['toggleExpanded']);
            sidebar.expanded = !sidebar.expanded;
        },
        moved: () => { for (const fn of [...subs]) fn(); },
    };
    return sidebar;
}

/** DSH's terminal views: one per tab, with its state, a retry and a way to take the keyboard back. */
function standInTerminals() {
    const terminals = {
        calls: [],
        states: new Map(),
        view(sessionId, tabId, contentId, terminalId) {
            return {
                state: { getSnapshot: () => terminals.states.get(tabId) ?? { phase: 'ready', info: { id: terminalId }, writable: true } },
                refresh: () => terminals.calls.push(['refresh', tabId, terminalId]),
                connect: () => terminals.calls.push(['connect', tabId, terminalId]),
            };
        },
    };
    return terminals;
}

function standInStorage(items = {}) {
    return {
        items,
        getItem: (key) => (Object.hasOwn(items, key) ? items[key] : null),
        setItem: (key, value) => { items[key] = String(value); },
    };
}

test('terminal tabs: each agent\'s terminal opens once beside its session, swaps in place when it starts again, and stays usable', async () => {
    const { client, window } = loadClient(CLIENT);
    const { marks, reveal, followTabs } = client.internals;
    window.localStorage = standInStorage();
    const sidebar = standInSidebar();
    const terminals = standInTerminals();
    const agent = (over) => ({ key: 'k1', sessionId: 's1', name: 'helper', terminalId: 'agent-k1-1', running: true, status: 'working', controlTakenAt: 0, ...over });
    const look = async () => {
        sidebar.moved();
        await settle(90);
    };
    marks.set({ off: false, openTabs: true, agents: [agent({ running: false, status: 'starting' })] });
    const stop = followTabs(sidebar, terminals);
    await look();
    assert.deepEqual(sidebar.calls, [], 'not while it starts');

    // It runs, and its session is on screen: its terminal opens in a tab beside it, once.
    marks.set({ off: false, openTabs: true, agents: [agent()] });
    await look();
    assert.deepEqual(sidebar.calls, [['openTab', 'terminal', { params: { terminalId: 'agent-k1-1' } }]]);
    assert.deepEqual(JSON.parse(window.localStorage.items['dsh-plugin-agent-terminals/opened/v1']), ['agent-k1-1'], 'remembered in this window');
    await look();
    assert.equal(sidebar.calls.length, 1, 'open already: nothing more');
    // You close the tab: it stays closed (the agent's next start opens its new terminal).
    sidebar.tabs.s1 = [];
    await look();
    assert.equal(sidebar.calls.length, 1);
    // Open its terminal from the page or a menu: asked for, it opens again, in front, with the column expanded.
    sidebar.expanded = false;
    reveal.set({ sessionId: 's1', terminalId: 'agent-k1-1', at: Date.now() });
    await look();
    assert.deepEqual(sidebar.calls.slice(1, 2), [['openTab', 'terminal', { params: { terminalId: 'agent-k1-1' } }]]);
    await look();
    assert.deepEqual(sidebar.calls.slice(2), [], 'the ask is used up once its tab is open');
    reveal.set({ sessionId: 's1', terminalId: 'agent-k1-1', at: Date.now() });
    await look();
    assert.deepEqual(sidebar.calls.slice(2), [['focus', 't2'], ['toggleExpanded']], 'an open tab comes to the front');
    assert.equal(reveal.get(), undefined);

    // Started again in a new terminal: the new one takes the old tab's place.
    marks.set({ off: false, openTabs: true, agents: [agent({ terminalId: 'agent-k1-2' })] });
    await look();
    assert.deepEqual(sidebar.calls.at(-1), ['openTab', 'terminal', { params: { terminalId: 'agent-k1-2' }, replaceTab: 't2' }]);
    assert.deepEqual(sidebar.tabs.s1.map((t) => t.params.terminalId), ['agent-k1-2']);

    // After DSH restarts: a restored tab has no parameters, only DSH's own record of its terminal, and it looked before
    // the agent's terminal was listed again; it reads again (not more than once in 2.5 seconds).
    const restored = { id: 'r1', kind: 'terminal', contentId: 'dsh-resource://page/terminal/r1', title: 'Terminal' };
    sidebar.tabs.s1 = [restored];
    window.localStorage.items[`dsh.terminal.binding.v1.${JSON.stringify(['s1', restored.contentId])}`] = JSON.stringify('agent-k1-2');
    terminals.states.set('r1', { phase: 'error', issue: 'missingTerminal' });
    const openedBefore = sidebar.calls.length;
    await look();
    await look();
    assert.equal(sidebar.calls.length, openedBefore, 'the restored tab is the agent\'s: no second tab');
    assert.deepEqual(terminals.calls, [['refresh', 'r1', 'agent-k1-2']]);

    // Agent Terminals typed through the window's way in: the tab takes its keyboard back, once per time.
    terminals.states.set('r1', { phase: 'ready', info: { id: 'agent-k1-2' }, writable: false });
    marks.set({ off: false, openTabs: true, agents: [agent({ terminalId: 'agent-k1-2', controlTakenAt: 1000 })] });
    await look();
    await look();
    assert.deepEqual(terminals.calls.slice(1), [['connect', 'r1', 'agent-k1-2']]);
    marks.set({ off: false, openTabs: true, agents: [agent({ terminalId: 'agent-k1-2', controlTakenAt: 2000 })] });
    await look();
    assert.deepEqual(terminals.calls.slice(2), [['connect', 'r1', 'agent-k1-2']]);

    // The session's surface is not ready yet: tried again on the next look, never thrown.
    sidebar.current = 's2';
    sidebar.tabs.s2 = [];
    sidebar.refuse = true;
    marks.set({ off: false, openTabs: true, agents: [agent({ key: 'k2', sessionId: 's2', terminalId: 'agent-k2-1' })] });
    await look();
    sidebar.refuse = false;
    await look();
    assert.deepEqual(sidebar.calls.slice(-2).map((c) => c[2].params.terminalId), ['agent-k2-1', 'agent-k2-1']);
    assert.equal(sidebar.tabs.s2.length, 1);

    // Switched off in its settings: no tab opens by itself (asked for, it still does).
    sidebar.current = 's3';
    sidebar.tabs.s3 = [];
    marks.set({ off: false, openTabs: false, agents: [agent({ key: 'k3', sessionId: 's3', terminalId: 'agent-k3-1' })] });
    await look();
    assert.equal(sidebar.tabs.s3.length, 0);
    reveal.set({ sessionId: 's3', terminalId: 'agent-k3-1', at: Date.now() });
    await look();
    assert.equal(sidebar.tabs.s3.length, 1);

    // Stopped following: nothing moves any more.
    stop();
    const calls = sidebar.calls.length;
    marks.set({ off: false, openTabs: true, agents: [agent({ key: 'k4', sessionId: 's3', terminalId: 'agent-k4-1' })] });
    await look();
    assert.equal(sidebar.calls.length, calls);
});

test('terminal tabs: a tab is the agent\'s only when it shows the agent\'s own terminal', () => {
    const { client, window } = loadClient(CLIENT);
    const { earlierTerminal, boundTerminal } = client.internals;
    assert.equal(earlierTerminal({ terminalId: 'agent-k1-3' }, 'agent-k1-2'), true);
    assert.equal(earlierTerminal({ terminalId: 'agent-k1-3' }, 'agent-k1-3'), false);
    assert.equal(earlierTerminal({ terminalId: 'agent-k1-3' }, 'agent-k2-1'), false, 'another agent\'s');
    assert.equal(earlierTerminal({ terminalId: 'agent-k1-3' }, 'term-abc'), false, 'a terminal you opened yourself');
    assert.equal(earlierTerminal({ terminalId: 'agent-k1-1' }, undefined), false);
    window.localStorage = standInStorage({ [`dsh.terminal.binding.v1.${JSON.stringify(['s1', 'c1'])}`]: JSON.stringify('agent-k1-1'), [`dsh.terminal.binding.v1.${JSON.stringify(['s1', 'c2'])}`]: '{bad' });
    const sidebar = { tabDomain: { occurrence: () => ({ navigation: { getSnapshot: () => ({ params: { terminalId: 'agent-k1-2' } }) } }) } };
    assert.equal(boundTerminal(sidebar, 's1', { id: 't', contentId: 'c1' }), 'agent-k1-2', 'its parameters first');
    const noParams = { tabDomain: { occurrence: () => { throw new Error('no occurrence'); } } };
    assert.equal(boundTerminal(noParams, 's1', { id: 't', contentId: 'c1' }), 'agent-k1-1', 'else DSH\'s record');
    assert.equal(boundTerminal(noParams, 's1', { id: 't', contentId: 'c2' }), undefined, 'a broken record is no terminal');
    assert.equal(boundTerminal(noParams, 's1', { id: 't', contentId: 'c3' }), undefined);
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

test('settings in Plugins: its page there has exactly its live settings, with the config\'s titles, defaults and ranges', () => {
    const form = standInForm();
    const { client } = loadClient(CLIENT, { ui: form.ui });
    const { SETTINGS, SETTINGS_SUMMARY } = client.internals;
    assert.deepEqual(plain(SETTINGS.map((f) => f.name)).sort(), [...LIVE_SETTINGS].sort(), 'the form has exactly the live settings');
    for (const f of SETTINGS) {
        assert.equal(f.title, SETTING_TITLES[f.name], `${f.name}: the title its errors use`);
        assert.deepEqual(plain(f.default), plain(DEFAULTS[f.name]), `${f.name}: the form's default is the config's`);
        if (f.kind !== 'number') continue;
        // The form takes exactly what the check takes.
        assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: f.min }), f.name);
        assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: f.max }), f.name);
        assert.throws(() => checkConfig({ ...DEFAULTS, [f.name]: f.min - 1 }), f.name);
        assert.throws(() => checkConfig({ ...DEFAULTS, [f.name]: f.max + 1 }), f.name);
    }
    const registered = [];
    const effects = [];
    const served = [];
    const scope = {
        configForms: {
            get: (entry) => ({ entry, values: { ...DEFAULTS, proofSeconds: 12 }, user: { proofSeconds: 12 } }),
            whileServed: (entries, fn) => { served.push(entries); return fn(); },
        },
        slots: { inject: (_name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        // As in DSH: Agent Terminals injects no key store, and reading one it did not inject throws.
        remote: strictRemote(),
        effect: (fn) => { effects.push(fn); },
        inject: (names, fn) => { if (names[0] === 'configForms') fn(scope); },
    };
    client.apply(scope);
    const disposers = effects.map((fn) => fn());
    assert.deepEqual(plain(served), [['agent-terminals']], 'drawn only while DSH serves its settings');
    const entry = registered.find((item) => item.spec.name === 'plugins.bundle.config');
    assert.equal(entry.spec.key, 'dsh-plugin-agent-terminals');
    assert.equal(entry.component({ view: 'summary' }), SETTINGS_SUMMARY);
    const page = entry.component({});
    const text = textIn(page);
    assert.match(text, /Starting/);
    assert.match(text, /Typing messages in/);
    assert.match(text, /Telling you/);
    assert.match(text, /How messages are typed in \(typing\) and switching Agent Terminals off \(enabled\) are set in its entry in DSH's profile\./);
    const fields = Object.fromEntries(elementsOf(page).filter((e) => e.type === 'SettingsValueField').map((e) => [e.props.label, e.props]));
    const proof = fields['Seconds without proof before Enter is pressed again'];
    assert.equal(proof.text, '12');
    assert.equal(proof.overridden, true);
    assert.equal(proof.invalidLabel, 'A whole number from 2 to 120, or empty for the default (8).');
    proof.onEdit('20');
    const switches = elementsOf(page).filter((e) => e.type === 'Switch');
    assert.equal(switches.length, 5);
    switches.find((s) => s.props.label === 'Type messages in while the agent works').props.onChange(true);
    assert.deepEqual(form.edits, [['proofSeconds', '20'], ['typeWhileWorking', 'on']]);
    for (const dispose of disposers) if (typeof dispose === 'function') dispose();
    assert.equal(form.models[0].disposed, true);
});
