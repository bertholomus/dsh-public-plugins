/**
 * Recall's browser half: loaded as DSH loads it, its page (search, filters,
 * results, the reading view, the index, what happened), opening a session
 * at a turn and the mark on that turn, the search tool's card in a chat,
 * and its settings form, drawn as plain element trees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, LIVE_SETTINGS, SETTING_TITLES, checkConfig } from '../plugins/recall/lib/config.js';
import { OTHER_NAMES, elementsOf, loadClient, standInReact, statefulReact, textIn } from './helpers/client.mjs';

const CLIENT = new URL('../plugins/recall/lib/client.js', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const buttons = (tree) => elementsOf(tree).filter((e) => e.type === 'Button' || e.type === 'button');
const button = (tree, label) => buttons(tree).find((e) => textIn(e) === label);
const withAttr = (tree, name) => elementsOf(tree).filter((e) => e.props?.[name] !== undefined);

const HOME = '/Users/me';
const now = Date.now();
const OWN = {
    id: '3.4', file: 3, kind: 'session', own: true, sessionId: 'sess-own-1', title: 'Fix the gateway', turn: 4, seq: 40, time: now - 3_600_000,
    folder: `${HOME}/work/gateway`, model: 'glm-5.3', snippet: 'we \u0002deploy\u0003ed the gateway to …', asked: 'please deploy the gateway to staging', hits: 4,
    others: [{ turn: 2, seq: 20 }, { turn: 7, seq: 70 }],
};
const TRANSCRIPT = {
    id: '9.2', file: 9, kind: 'transcript', own: false, path: `${HOME}/agent-logs/run.jsonl`, title: '', turn: 2, seq: 0, line: 14, time: now - 86_400_000 * 3,
    folder: `${HOME}/work/parser`, model: 'glm-5.3-flash', snippet: '\u0002rollback\u0003 of the parser', asked: 'roll back the parser', hits: 1, others: [],
};
const NOTE = {
    id: '12.3', file: 12, kind: 'handoff', own: false, path: `${HOME}/notes/HANDOFF.md`, title: 'Gateway handoff', label: 'Next steps', turn: 3, line: 40, time: now - 86_400_000,
    folder: `${HOME}/notes`, model: '', snippet: '… \u0002deploy\u0003 after the review', asked: '', hits: 2, others: [{ turn: 5, seq: 0 }],
};
const STATUS = {
    busy: false, queued: 0, read: 30, lastRead: now - 60_000, totals: { turns: 1234, files: 56, problems: 1, skipped: 0 }, bytes: 7 * 1048576,
    problems: [{ id: 77, path: `${HOME}/notes/broken.md`, kind: 'handoff', root: `${HOME}/notes`, error: 'Permission denied.', updated: now }],
    roots: [
        { kind: 'session', root: `${HOME}/.dsh/sessions`, own: true, state: 'ok', files: 50, capped: false, error: '', scanned: now - 20_000, indexed: 50, turns: 1200, problems: 0, last: now },
        { kind: 'handoff', root: `${HOME}/notes`, own: false, state: 'ok', files: 6, capped: false, error: '', scanned: now - 20_000, indexed: 6, turns: 34, problems: 1, last: now },
        { kind: 'transcript', root: '/Volumes/Backup/logs', own: false, state: 'missing', files: 0, capped: false, error: '', scanned: now - 20_000, indexed: 0, turns: 0, problems: 0, last: 0 },
    ],
    stale: false,
};
const STATE = {
    enabled: true, tool: true, sessions: true, thread: { state: 'running', problem: '' }, index: STATUS,
    left: [{ kind: 'handoff', root: `${HOME}/notes/old`, why: `Inside ${HOME}/notes, which is already searched.` }],
    history: [{ id: 'e1', at: now - 5000, kind: 'caught-up', text: 'Caught up with what changed', why: 'Read 30 files in 1.2 seconds: 320 turns and 20 note sections indexed.', state: 'done' }],
    home: HOME,
};
const FOUND = { text: 'deploy', words: ['deploy'], excluded: [], sort: 'best', filters: {}, total: 7, totalMore: false, sessions: 3, sessionsMore: false, results: [OWN, TRANSCRIPT, NOTE], more: true, took: 12.4 };

/** DSH's connection as the window has it: answers by method name; anything else never answers (the hub's wait). */
function connect(kit, answers) {
    const calls = [];
    kit.setConnection({ rpc: { call: async (_path, method, payload) => {
        if (!method.startsWith('dsh-plugin-recall/')) return new Promise(() => {});
        const name = method.replace('dsh-plugin-recall/', '');
        calls.push([name, plain(payload.args)]);
        const answer = answers[name];
        if (answer === undefined) return new Promise(() => {});
        const value = typeof answer === 'function' ? await answer(payload.args) : answer;
        return value?.ok === false ? value : { ok: true, value };
    } } });
    return calls;
}

/** A chat as DSH draws it, enough for Recall to find a turn's rows and scroll its view. */
function fakeChat(turnTops) {
    const body = { tag: 'body' };
    const scroller = {
        scrollTop: 2000, scrollHeight: 9000, clientHeight: 600, parentElement: body, style: { overflowY: 'auto' }, listeners: {},
        addEventListener(name, fn) { (this.listeners[name] ??= new Set()).add(fn); },
        removeEventListener(name, fn) { this.listeners[name]?.delete(fn); },
        fire(name) { for (const fn of [...(this.listeners[name] ?? [])]) fn(); },
        getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
    };
    const rows = new Map();
    for (const [turn, tops] of Object.entries(turnTops)) {
        rows.set(Number(turn), tops.map((top) => ({
            turn: Number(turn), top, attrs: {},
            setAttribute(name, value) { this.attrs[name] = value; },
            removeAttribute(name) { delete this.attrs[name]; },
            getBoundingClientRect() { return { top: 100 + this.top - scroller.scrollTop }; },
        })));
    }
    const flow = {
        parentElement: scroller,
        querySelectorAll: (selector) => {
            const m = /data-chat-turn="(\d+)"/.exec(selector);
            return m ? rows.get(Number(m[1])) ?? [] : [];
        },
        querySelector: (selector) => flow.querySelectorAll(selector)[0] ?? null,
    };
    const document = { body, querySelectorAll: (selector) => (selector === '[data-chat-flow]' ? [flow] : []), querySelector: () => null };
    const getComputedStyle = (el) => el.style ?? { overflowY: 'visible' };
    return { body, scroller, rows, flow, document, getComputedStyle, markEl: { closest: (selector) => (selector === '[data-chat-flow]' ? flow : null) } };
}

test('browser half: loads as DSH loads it, adds its page, its entry (order 9), its mark (order 50), its tool card and one style sheet', () => {
    const heads = [];
    const document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (type) => ({ type, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
        head: { appendChild: (tag) => { heads.push(tag); } },
    };
    const { id, client } = loadClient(CLIENT, { document });
    assert.equal(id, 'dsh-plugin-recall');
    assert.equal(heads.length, 0, 'styles wait for apply');
    const registered = [];
    const opened = [];
    const panels = [];
    const effects = [];
    const sessions = { binding: () => undefined };
    const scope = {
        slots: { inject: (_name, fn) => { fn(); }, register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        uiWorkspace: { openSession: (sessionId) => { opened.push(sessionId); } },
        sessions,
        get: (name) => (name === 'layout' ? { selectPanel: (key) => panels.push(key) } : undefined),
        effect: (fn) => { effects.push(fn); },
    };
    client.apply({ ...scope, inject: (names, fn) => { if (names[0] === 'uiWorkspace' || names[0] === 'sessions') fn(scope); } });
    assert.equal(heads.length, 1);
    assert.equal(heads[0].attributes['data-plugin'], 'dsh-plugin-recall');
    assert.equal(heads[0].attributes['data-plugin-css'], 'dsh-plugin-recall/client.css');
    const css = heads[0].textContent;
    assert.match(css, /\.dshrc-mark\{[^}]*background:var\(--dsw-alias-bg-layer-1\);border:\.5px solid var\(--dsw-alias-border-l4\);border-radius:var\(--dsw-radius-lg\)/, 'the mark in a chat is drawn as DSH draws its own cards there');
    const chatRules = css.split('\n').filter((rule) => /^\.dshrc-(mark|tool)/.test(rule)).join('\n');
    assert.doesNotMatch(chatRules, /backdrop-filter|background:var\(--dshrc-(glass|conv)/, 'no glass and no blur inside a chat');
    assert.match(css, /\[data-recall-found="line"\]::before\{content:"";position:absolute;top:0;bottom:0;left:-14px;width:2px/, 'the found turn\'s rows get a line beside them, by Recall\'s own mark');
    assert.match(css, /\[data-recall-found="inset"\]\{box-shadow:inset 2px 0 0 /, 'a row DSH positions itself keeps the line inside its edge');
    assert.match(css, /body\.wp-still/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /prefers-reduced-transparency/);
    assert.doesNotMatch(css, /:has\(/);
    assert.doesNotMatch(css, /(^|\})\s*(:root|html|body)\s*\{/m, 'nothing on the page root');
    const entry = registered.find((r) => r.spec.name === 'sidebar.panellist');
    assert.deepEqual(plain(entry.spec), { name: 'sidebar.panellist', id: 'dsh-plugin-recall:page', order: 9, label: 'Recall' });
    assert.equal(registered.find((r) => r.spec.name === 'main').spec.key, 'dsh-plugin-recall:page');
    const mark = registered.find((r) => r.spec.name === 'conversation.chat.turnTail');
    assert.deepEqual(plain(mark.spec), { name: 'conversation.chat.turnTail', id: 'dsh-plugin-recall:mark', order: 50, label: 'Recall' });
    const tool = registered.find((r) => r.spec.name === 'tool.call.toolview');
    assert.deepEqual(plain(tool.spec), { name: 'tool.call.toolview', key: 'recall_search', locale: 'conversation' });
    // The views it opens: a session in DSH's workspace, its own page through DSH's layout.
    const { views } = client.internals;
    assert.equal(views.openSession('s1'), true);
    assert.equal(views.openSession(''), false);
    views.openPage();
    assert.deepEqual(opened, ['s1'], 'an empty id opens nothing');
    assert.deepEqual(panels, ['dsh-plugin-recall:page']);
    assert.equal(views.sessions, sessions, 'DSH\'s sessions, for the turn jump');
    // Switched off: its style sheet goes, and so do its marks.
    const removed = [];
    document.querySelectorAll = (selector) => (selector.includes('dsh-plugin-recall/client.css') ? [{ remove: () => removed.push('sheet') }] : []);
    for (const fn of effects) fn()?.();
    assert.deepEqual(removed, ['sheet']);
    assert.match(readFileSync(CLIENT, 'utf8'), /^\/\*\*/, 'a plain script DSH can join with the others');
});

test('words: a result says what it is, where, when and which turn; hits are marked; counts; the agent\'s words become the person\'s', () => {
    const { client } = loadClient(CLIENT, { react: standInReact() });
    const { metaParts, titleOf, snippetParts, askedLine, countLine, homeless, failureText, runningTitle, doneTitle, indexLine } = client.internals;
    assert.deepEqual(plain(metaParts(OWN, HOME)), ['Session', '~/work/gateway', 'glm-5.3', 'turn 4']);
    assert.deepEqual(plain(metaParts({ ...OWN, own: false, running: true }, HOME)), ['Session from another DSH', '~/work/gateway', 'glm-5.3', 'turn 4', 'still running']);
    assert.deepEqual(plain(metaParts(NOTE, HOME)), ['Handoff note', '~/notes', 'section “Next steps”, line 40']);
    assert.deepEqual(plain(metaParts(TRANSCRIPT, HOME)), ['Coding-agent transcript', '~/work/parser', 'glm-5.3-flash', 'turn 2']);
    // One state per turn, one word for it everywhere: the rows, the tool's card, the reading view (after "of N").
    const word = (state, extra = {}) => plain(metaParts({ ...OWN, state, ...extra }, HOME)).slice(3).join(' · ');
    assert.deepEqual(['running', 'stopped', 'failed', 'cut-off', 'cut-short', 'blocked', ''].map((st) => word(st)),
        ['turn 4 · still running', 'turn 4 · stopped', 'turn 4 · failed', 'turn 4 · cut off by a restart', 'turn 4 · cut short', 'turn 4 · blocked', 'turn 4']);
    assert.equal(plain(metaParts({ ...OWN, state: 'running' }, HOME, { of: 1 })).slice(3).join(' · '), 'turn 4 of 1 · still running', 'not "still running of 1"');
    assert.equal(plain(metaParts(NOTE, HOME, { of: 3 })).at(-1), 'section “Next steps”, line 40', 'a note\'s section has no count');
    const { stateSentence } = client.internals;
    assert.deepEqual([
        stateSentence({ state: 'stopped', why: 'user' }), stateSentence({ state: 'stopped', why: 'parent' }), stateSentence({ state: 'stopped', why: 'disposed' }),
        stateSentence({ state: 'stopped', why: 'hook: account/signed-out' }), stateSentence({ state: 'stopped' }),
        stateSentence({ state: 'failed', why: 'The model provider did not answer (503)' }), stateSentence({ state: 'failed' }),
        stateSentence({ state: 'cut-off' }), stateSentence({ state: 'cut-short' }), stateSentence({ state: 'blocked' }), stateSentence({ state: 'running' }), stateSentence({ state: '' }),
    ], [
        'This turn was stopped from the chat before it finished.', 'The session that started this turn stopped it before it finished.', 'This turn stopped when DSH closed its session.',
        'A plugin stopped this turn before it finished (account/signed-out).', 'This turn was stopped before it finished.',
        'This turn failed: The model provider did not answer (503).', 'This turn failed.',
        'This turn was cut off by a restart: DSH stopped before it finished.', 'This turn was cut short: its reply reached the model\'s output limit.', 'A plugin blocked this turn before it could go on.', 'This turn is still running.', '',
    ]);
    assert.equal(homeless('/Users/me', HOME), '~');
    assert.equal(homeless('/Users/meg/x', HOME), '/Users/meg/x', 'only the home folder itself');
    assert.equal(titleOf(TRANSCRIPT), 'Untitled transcript');
    assert.equal(titleOf({ kind: 'handoff', path: '/n/plan.md' }), 'plan.md');
    assert.equal(titleOf({ kind: 'session', title: '  ' }), 'Untitled session');
    const parts = snippetParts(OWN.snippet);
    assert.equal(parts[0], 'we ');
    assert.equal(parts[1].type, 'mark');
    assert.equal(textIn(parts[1]), 'deploy');
    assert.equal(parts[2], 'ed the gateway to …');
    assert.deepEqual(plain(snippetParts('')), []);
    assert.equal(askedLine(OWN), 'please deploy the gateway to staging');
    assert.equal(askedLine({ ...OWN, snippet: '\u0002please\u0003 deploy the gateway' }), '', 'not twice when the snippet is the request');
    assert.equal(askedLine(NOTE), '');
    assert.equal(countLine(FOUND, 'any'), '7 matching turns in 3 sessions and files · 12 ms');
    assert.equal(countLine({ ...FOUND, total: 1, sessions: 1, took: 0.4 }, 'handoff'), '1 matching section in 1 note · <1 ms', 'a note is read in sections');
    assert.equal(countLine({ ...FOUND, total: 3, sessions: 1 }, 'handoff'), '3 matching sections in 1 note · 12 ms');
    assert.equal(countLine({ ...FOUND, total: 5000, totalMore: true, sessions: 400, sessionsMore: true }, 'session'), '5,000+ matching turns in 400+ sessions · 12 ms');
    // Sessions whose title alone has the words are counted apart: no turn of theirs says them.
    assert.equal(countLine({ ...FOUND, total: 2, sessions: 2, titled: 1 }, 'any'), '2 matching turns in 2 sessions and files, and 1 more by title only · 12 ms');
    assert.equal(countLine({ ...FOUND, total: 0, sessions: 0, titled: 1 }, 'handoff'), 'No section says it; 1 note matches by title only · 12 ms');
    assert.equal(countLine({ ...FOUND, total: 0, sessions: 0, titled: 3 }, 'any'), 'No turn says it; 3 sessions and files match by title only · 12 ms');
    assert.equal(failureText('Give words to search for in query, or a result id in open.'), 'the agent gave no words to search for.');
    assert.equal(failureText('Error: Recall\'s index is starting. Try again in a moment.'), 'Recall\'s index is starting. Try again in a moment.');
    assert.equal(runningTitle({ query: 'deploy gateway' }), 'Searching past work for “deploy gateway”');
    assert.equal(runningTitle({ open: '3.4' }), 'Reading a past turn');
    assert.equal(doneTitle({ kind: 'results', query: 'deploy', total: 7, sessions: 3 }, {}), 'Searched past work for “deploy”: 7 turns in 3 sessions and files');
    assert.equal(doneTitle({ kind: 'results', query: 'zzz', total: 0, sessions: 0 }, {}), 'Searched past work for “zzz”: nothing found');
    assert.equal(doneTitle({ kind: 'results', query: 'deploy', total: 1, sessions: 1 }, { kind: 'session' }), 'Searched past work for “deploy”: 1 turn in 1 session');
    assert.equal(doneTitle({ kind: 'results', query: 'quokka', total: 3, sessions: 1 }, { kind: 'handoff' }), 'Searched past work for “quokka”: 3 sections in 1 note');
    assert.equal(doneTitle({ kind: 'results', query: 'kestrel', total: 0, sessions: 0, titled: 1 }, {}), 'Searched past work for “kestrel”: 1 session or file by title only');
    assert.equal(doneTitle({ kind: 'turn', turn: OWN }, {}), 'Read a past turn: “Fix the gateway”');
    assert.equal(indexLine({ index: STATUS }), 'Recall has 1,234 turns from 56 sessions and files. Up to date.');
    // How far a catch-up has read: of a total once every folder was looked through, else so far and where it looks.
    assert.equal(indexLine({ index: { ...STATUS, busy: true, queued: 12, batch: { read: 30, left: 12, looking: false } } }), 'Recall has 1,234 turns from 56 sessions and files. Reading new and changed files: 30 of 42 read…');
    assert.equal(indexLine({ index: { ...STATUS, busy: true, queued: 9992, batch: { read: 10, left: 9992, looking: false } } }), 'Recall has 1,234 turns from 56 sessions and files. Reading new and changed files: 10 of 10,002 read…');
    assert.equal(indexLine({ home: HOME, index: { ...STATUS, busy: true, queued: 5, walking: `${HOME}/big`, batch: { read: 1200, left: 5, looking: true } } }), 'Recall has 1,234 turns from 56 sessions and files. Reading new and changed files: 1,200 read so far, still looking through ~/big for more…');
    assert.equal(indexLine({ home: HOME, index: { ...STATUS, busy: true, queued: 0, walking: `${HOME}/big`, totals: { turns: 0, files: 0 }, batch: { read: 0, left: 0, looking: true } } }), 'Recall has nothing indexed yet. Looking through ~/big for new and changed files…');
    assert.equal(indexLine({ index: { ...STATUS, busy: true, queued: 1, batch: { read: 0, left: 1, looking: false } } }), 'Recall has 1,234 turns from 56 sessions and files. Reading 1 new or changed file…');
    assert.equal(indexLine({ index: { ...STATUS, busy: true, queued: 12 } }), 'Recall has 1,234 turns from 56 sessions and files. Reading new and changed files: 0 of 12 read…', 'an index thread from before the batch count');
    assert.equal(indexLine({}), 'Starting the index.');
    const source = readFileSync(CLIENT, 'utf8');
    assert.doesNotMatch(source, OTHER_NAMES);
});

test('the page: not running, a wrong setting, switched off, the index stopped (with a way to start it), starting and running each say what to do', async (t) => {
    const states = {
        problem: { problem: { key: 'handoffFolders', text: 'Handoff note folders (handoffFolders) must list folders by their full path or a path from ~/, such as ~/notes ("notes" is not one)', live: true }, enabled: true, tool: true, sessions: true, thread: { state: 'idle', problem: '' }, left: [], history: [], home: HOME },
        off: { enabled: false, tool: true, sessions: true, thread: { state: 'idle', problem: '' }, left: [], history: [], home: HOME },
        failed: { ...STATE, thread: { state: 'failed', problem: 'Recall\'s index stopped 3 times in a row: out of memory.' }, index: undefined, left: [] },
        starting: { ...STATE, thread: { state: 'starting', problem: '' }, index: undefined, left: [] },
        running: STATE,
    };
    const page = async (state, setup) => {
        const { react, mount } = statefulReact();
        const { client } = loadClient(CLIENT, { react });
        const calls = connect(client.internals.kit, { state, restart: { state: 'starting' }, search: FOUND, ...setup });
        client.internals.kit.setNavigation({ openBundle: () => {} });
        const mounted = mount(client.internals.RecallPage, {});
        t.after(() => { mounted.unmount(); client.internals.kit.setConnection(undefined); });
        await settle(5);
        mounted.update({});
        return { mounted, calls, client };
    };
    let { mounted } = await page(states.problem);
    let text = textIn(mounted.tree);
    assert.match(text, /Recall is waiting for a setting to be fixed\./);
    assert.match(text, /\("notes" is not one\)\.Change it in Recall's settings in Plugins\. Recall starts working again as soon as you save\./);
    assert.ok(button(mounted.tree, 'Open Recall\'s settings'));
    assert.equal(withAttr(mounted.tree, 'data-recall-search').length, 0, 'no search while a setting is wrong');
    assert.equal(withAttr(mounted.tree, 'data-recall-history').length, 1, 'what happened still shows');

    ({ mounted } = await page(states.off));
    text = textIn(mounted.tree);
    assert.match(text, /switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\), so it keeps no index\. To use it, set enabled to true there; DSH applies it when you save the file\. To take its page out of the sidebar as well, switch Recall off in Plugins\./);
    assert.doesNotMatch(text, /To remove it/, 'switching it off in Plugins removes nothing');
    assert.equal(withAttr(mounted.tree, 'data-recall-search').length, 0);

    let calls;
    ({ mounted, calls } = await page(states.failed));
    text = textIn(mounted.tree);
    assert.match(text, /Recall's index stopped, so searches are refused\.Recall's index stopped 3 times in a row: out of memory\./);
    assert.equal(withAttr(mounted.tree, 'data-recall-search').length, 0);
    button(mounted.tree, 'Start the index again').props.onClick();
    await settle(5);
    assert.ok(calls.some(([name]) => name === 'restart'));
    assert.match(textIn(mounted.tree), /Starting the index again\./);

    ({ mounted } = await page(states.starting));
    assert.match(textIn(mounted.tree), /startingStarting the index\. Searches work in a moment\./);

    ({ mounted, calls } = await page(states.running));
    text = textIn(mounted.tree);
    assert.match(text, /Recall has 1,234 turns from 56 sessions and files\. Up to date\./);
    assert.equal(withAttr(mounted.tree, 'data-recall-search').length, 1);
    assert.equal(withAttr(mounted.tree, 'data-recall-index').length, 1);
    assert.deepEqual(calls.find(([name]) => name === 'search'), ['search', { query: { text: '', sort: 'best', limit: 20, offset: 0, prefix: true } }], 'the newest turns first, before anything is typed');
    assert.match(text, /Caught up with what changed/);

    const { react: r2, mount: m2 } = statefulReact();
    const down = loadClient(CLIENT, { react: r2 }).client;
    down.internals.kit.setConnection({ rpc: { call: async () => { throw new Error('404 Not Found'); } } });
    const gone = m2(down.internals.RecallPage, {});
    t.after(() => { gone.unmount(); down.internals.kit.setConnection(undefined); });
    await settle(5);
    gone.update({});
    text = textIn(gone.tree);
    assert.match(text, /Recall is not running\./);
    assert.doesNotMatch(text, /Session Watch/, 'Recall needs nothing else');
});

test('the page: while Recall does not answer, it says what DSH\'s plugin list says of it and what to do, never "switch it off and on"', async (t) => {
    const show = async (rows) => {
        const { react, mount } = statefulReact();
        const { client } = loadClient(CLIENT, { react });
        const asked = [];
        client.internals.kit.setConnection({ rpc: { call: async (_path, method) => {
            asked.push(method);
            if (method === 'pluginManager/listPlugins') return rows === undefined ? new Promise(() => {}) : { ok: true, value: rows };
            throw new Error('404 Not Found');
        } } });
        const opened = [];
        client.internals.kit.setNavigation({ openBundle: (name) => opened.push(name) });
        const mounted = mount(client.internals.RecallPage, {});
        t.after(() => { mounted.unmount(); client.internals.kit.setConnection(undefined); });
        await settle(5);
        mounted.update({});
        await settle(5);
        mounted.update({});
        return { tree: mounted.tree, text: textIn(mounted.tree), opened, asked };
    };
    const row = (patch) => ({ entryId: 'e-9', moduleName: 'dsh-plugin-recall', enabled: true, fiberPhase: 'active', ...patch });
    const other = { entryId: 'e-1', moduleName: 'dsh-plugin-canon', enabled: true, fiberPhase: 'failed' };
    const cases = [
        [[other, row({ fiberPhase: 'failed' })], 'failed', /SettingsRecall could not start\.DSH stopped it as it started, so it searches nothing, and Plugins shows Problem for it\. Restart DSH; if Recall stops again, DSH's log says why\./],
        [[row({ fiberPhase: 'loading' })], 'starting', /Recall is starting\.This page comes back by itself in a moment\./],
        [[row({ enabled: false, fiberPhase: null })], 'off', /Recall is switched off in Plugins\.To search again, switch it on there\./],
        [[row({ fiberPhase: 'unloading' })], 'stopping', /Recall is stopping\./],
        [[row({ fiberPhase: 'active' })], 'on', /Recall runs, but this page cannot reach it\.DSH did not pass this page's request on to Recall\. Reload the window; if this stays, restart DSH\./],
        [[other], 'unknown', /Recall is not running\.Open Recall in Plugins to see why: Off there means it is switched off \(switch it on\), and Problem means it could not start \(restart DSH\)\./],
    ];
    for (const [rows, state, words] of cases) {
        const { tree, text, opened, asked } = await show(rows);
        assert.equal(withAttr(tree, 'data-recall-down')[0]?.props['data-recall-down'], state, state);
        assert.match(text, words, state);
        assert.doesNotMatch(text, /off and on/, `${state}: switching it off and on mends none of these`);
        assert.ok(asked.includes('pluginManager/listPlugins'), 'it reads DSH\'s plugin list');
        assert.ok(!asked.some((m) => m.startsWith('pluginManager/') && m !== 'pluginManager/listPlugins'), 'and never changes it');
        assert.ok(button(tree, 'Check again'), state);
        const open = button(tree, 'Open Recall in Plugins');
        assert.equal(Boolean(open), !['starting', 'on'].includes(state), state);
        if (open) {
            open.props.onClick();
            assert.deepEqual(opened, ['dsh-plugin-recall']);
        }
    }
    // While DSH's list has not answered: a line that says so, not a guess.
    const waiting = await show(undefined);
    assert.match(waiting.text, /Asking DSH about Recall/);
});

test('search: typing waits for a pause, Enter and filters search at once with what they say, more pages add on, and a refusal keeps the results', async (t) => {
    const { client } = loadClient(CLIENT, { react: standInReact() });
    const { kit, finder } = client.internals;
    let answer = FOUND;
    const calls = connect(kit, { search: () => answer, facets: { folders: [{ folder: `${HOME}/work/gateway`, turns: 40 }], models: [{ model: 'glm-5.3' }], kinds: [] } });
    t.after(() => kit.setConnection(undefined));
    finder.type('dep');
    finder.type('deplo');
    finder.type('deploy');
    await settle(30);
    assert.equal(calls.length, 0, 'still typing');
    await settle(250);
    assert.deepEqual(calls, [['search', { query: { text: 'deploy', sort: 'best', limit: 20, offset: 0, prefix: true } }]], 'one search for the pause, the last word a prefix');
    let s = finder.store.get();
    assert.equal(s.results.length, 3);
    assert.equal(s.more, true);
    finder.choose({ kind: 'session' });
    finder.choose({ when: 'week' });
    await settle(5);
    assert.deepEqual(calls.at(-1), ['search', { query: { text: 'deploy', kind: 'session', since: 'week', sort: 'best', limit: 20, offset: 0, prefix: true } }]);
    finder.choose({ folder: `${HOME}/work/gateway`, model: 'glm-5.3', sort: 'newest' });
    await settle(5);
    assert.deepEqual(calls.at(-1)[1].query, { text: 'deploy', kind: 'session', folder: `${HOME}/work/gateway`, model: 'glm-5.3', since: 'week', sort: 'newest', limit: 20, offset: 0, prefix: true });
    answer = { ...FOUND, results: [{ ...OWN, id: '20.1', file: 20, turn: 1 }], more: false };
    await finder.more();
    assert.equal(calls.at(-1)[1].query.offset, 3, 'the next page starts after what is shown');
    s = finder.store.get();
    assert.deepEqual(plain(s.results.map((r) => `${r.file}.${r.turn}`)), ['3.4', '9.2', '12.3', '20.1']);
    assert.equal(s.more, false);
    let card = client.internals.SearchCard({ data: STATE });
    assert.equal(withAttr(card, 'data-recall-more').length + withAttr(card, 'data-recall-end').length, 0, 'the whole list: no more, and nothing to say');
    // A list cut short (the files of the 4,000 turns a search looks through, or its 1,000th result) says so where it stops.
    finder.store.set({ ...finder.store.get(), found: { ...finder.store.get().found, sort: 'newest', cut: 'cap', looked: 4000 } });
    card = client.internals.SearchCard({ data: STATE });
    assert.equal(withAttr(card, 'data-recall-more').length, 0);
    assert.equal(textIn(withAttr(card, 'data-recall-end')), 'These are the sessions and files of the 4,000 newest matching turns. Add a word or a filter to find others.');
    const { endLine } = client.internals;
    assert.equal(endLine({ text: 'deploy', sort: 'best', cut: 'cap', looked: 4000 }, 312), 'These are the sessions and files of the 4,000 best-matching turns. Add a word or a filter to find others.');
    assert.equal(endLine({ text: '', sort: 'best', cut: 'cap', looked: 4000 }, 312), 'These are the sessions and files of the 4,000 newest turns. Add a word or a filter to find others.');
    assert.equal(endLine({ text: 'deploy', sort: 'best', cut: 'length', looked: 4000 }, 1000), 'The list stops at 1,000 results. Add a word or a filter to find others.');
    answer = { ok: false, error: { code: 'recall/refused', message: 'Recall\'s index is starting. Try again in a moment.' } };
    await finder.search();
    s = finder.store.get();
    assert.equal(s.problem, 'Recall\'s index is starting. Try again in a moment.');
    assert.equal(s.results.length, 4, 'the results stay');
    finder.clearFilters();
    await settle(5);
    assert.deepEqual(plain(finder.store.get().query), { text: 'deploy', kind: 'any', when: 'any', folder: '', model: '', sort: 'newest' }, 'the words and the order stay');
    // The tool's card starts a search over.
    answer = FOUND;
    finder.set({ text: 'rollback', kind: 'transcript' });
    await settle(5);
    assert.deepEqual(calls.at(-1)[1].query, { text: 'rollback', kind: 'transcript', sort: 'best', limit: 20, offset: 0, prefix: true });
    // The filters' choices are read when a menu opens, once in a while.
    await finder.loadFacets();
    await finder.loadFacets();
    assert.equal(calls.filter(([name]) => name === 'facets').length, 1);
    assert.equal(finder.facets.get().data.folders.length, 1);

    // Drawn: the box, the filters (kind only when more than one kind is searched; order only with words), the count, the results.
    const tree = client.internals.SearchCard({ data: STATE });
    const text = textIn(tree);
    assert.equal(withAttr(tree, 'data-recall-query')[0].props.value, 'rollback');
    assert.equal(withAttr(tree, 'data-recall-query')[0].props.role, 'searchbox');
    assert.match(text, /^Search past work/);
    assert.match(text, /7 matching turns in 3 transcripts · 12 ms/);
    assert.equal(withAttr(tree, 'data-recall-result').length, 3);
    assert.ok(elementsOf(tree).some((e) => e.props?.['data-suite-choice'] === 'dshrc-kind'), 'kind, as three kinds are searched');
    assert.ok(elementsOf(tree).some((e) => e.props?.['data-suite-choice'] === 'dshrc-sort'), 'the order, as words are typed');
    const menus = elementsOf(tree).filter((e) => e.type === 'Menu');
    assert.deepEqual(menus.map((m) => m.props.anchor.props['data-recall-filter']), ['when', 'folder', 'model']);
    assert.deepEqual(plain(menus[1].props.items.map((i) => i.label ?? i.text)), ['Any folder', '~/work/gateway']);
    assert.equal(menus[1].props.selectedId, 'any');
    menus[1].props.onSelect(`v:${HOME}/work/gateway`);
    assert.equal(finder.store.get().query.folder, `${HOME}/work/gateway`);
    assert.ok(withAttr(client.internals.SearchCard({ data: STATE }), 'data-recall-clear').length === 1, 'a way to clear the filters');
    const one = client.internals.SearchCard({ data: { ...STATE, index: { ...STATUS, roots: [STATUS.roots[0]] } } });
    assert.ok(!elementsOf(one).some((e) => e.props?.['data-suite-choice'] === 'dshrc-kind'), 'one kind searched: no kind filter');
});

test('filters: a long folder is cut in the middle at whole folders, so folders that differ at the end look different; its whole path is its name', () => {
    const { client } = loadClient(CLIENT, { react: standInReact() });
    const { cutPath, folderLabel, finder, kit } = client.internals;
    const notes = '~/Projects/dsh-plugin-suite-judge/recall-r1/data/notes';
    const osprey = '~/Projects/dsh-plugin-suite-judge/recall-r1/data/notes/projects/osprey';
    assert.equal(cutPath(notes), '~/Projects/…/recall-r1/data/notes');
    assert.equal(cutPath(osprey), '~/Projects/…/data/notes/projects/osprey');
    assert.equal(cutPath('/Volumes/Backup/agent-logs/2026/october/week-three/run-forty-two'), '/Volumes/…/october/week-three/run-forty-two');
    assert.equal(cutPath('~/short/path'), '~/short/path', 'short paths stay whole');
    assert.equal(cutPath(`~/a/${'x'.repeat(70)}`), `~/a/…${'x'.repeat(41)}`, 'a last folder too long by itself keeps its end');
    assert.equal(cutPath(`/${'y'.repeat(80)}`).length, 46);
    for (const path of [notes, osprey]) assert.ok(cutPath(path).length <= 46);
    const label = folderLabel(osprey);
    assert.equal(label.props.title, osprey);
    assert.deepEqual(plain(label.children.map((c) => [c.props['aria-hidden'] ?? null, textIn(c)])), [['true', '~/Projects/…/data/notes/projects/osprey'], [null, osprey]], 'the cut words are hidden from screen readers, which read the whole path');
    assert.equal(folderLabel('~/notes'), '~/notes');

    // In the menu, and on its button once chosen: the button's name is the whole path.
    const HOME_LONG = `${HOME}/Projects/dsh-plugin-suite-judge/recall-r1/data/notes/projects/osprey`;
    finder.facets.set({ loading: false, data: { folders: [{ folder: HOME_LONG, turns: 3 }], models: [] } });
    finder.store.set({ ...finder.store.get(), query: { ...finder.store.get().query, folder: HOME_LONG } });
    const menus = elementsOf(client.internals.SearchCard({ data: STATE })).filter((e) => e.type === 'Menu');
    const folder = menus.find((m) => m.props.anchor.props['data-recall-filter'] === 'folder');
    assert.equal(folder.props.anchor.props['aria-label'], `Folder: ${osprey}`);
    assert.equal(folder.props.items[1].full, osprey);
    assert.equal(textIn(folder.props.items[1].label), `~/Projects/…/data/notes/projects/osprey${osprey}`);
    void kit;
});

test('results: each says where it is and opens at its turn (this DSH) or in the reading view; its other turns too; empty states say what to do next', async (t) => {
    const { client } = loadClient(CLIENT, { react: standInReact() });
    const { ResultRow, NoResults, finder, views, jump, endJump } = client.internals;
    t.after(() => endJump());
    const opened = [];
    views.openSession = (id) => { opened.push(id); return true; };
    const loads = [];
    views.sessions = { binding: (id) => ({ session: { loadThrough: async (seq) => { loads.push([id, seq]); } } }) };
    finder.store.set({ ...finder.store.get(), query: { ...finder.store.get().query, text: 'deploy' } });
    const row = ResultRow({ r: OWN, home: HOME });
    const text = textIn(row);
    assert.match(text, /^Fix the gatewaySession · ~\/work\/gateway · glm-5\.3 · turn 4 · 1 h ago/);
    assert.match(text, /we deployed the gateway to …Asked: please deploy the gateway to staging/);
    assert.match(text, /3 other turns here match:turn 2turn 7and 1 more/);
    assert.equal(elementsOf(row).find((e) => e.type === 'mark').props.className, 'dshrc-hit');
    withAttr(row, 'data-recall-open')[0].props.onClick();
    await settle(5);
    assert.deepEqual(opened, ['sess-own-1']);
    assert.deepEqual(loads, [['sess-own-1', 40]], 'its history pages back to the turn\'s start');
    assert.deepEqual(plain(jump.get()), { sessionId: 'sess-own-1', turn: 4, seq: 40, query: 'deploy', n: 1, landed: false });
    withAttr(row, 'data-recall-other')[1].props.onClick();
    await settle(5);
    assert.deepEqual(loads.at(-1), ['sess-own-1', 70], 'another turn of the same session');
    assert.equal(jump.get().turn, 7);
    button(row, 'Read here').props.onClick();
    assert.deepEqual(plain(finder.store.get().reading), { id: '3.4', from: '[data-recall-peek="3.4"]' }, 'Read here: the reading view, not the session; Back comes to it again');
    // Every button is named with what it opens, not only "Read here" or "turn 2".
    assert.equal(withAttr(row, 'data-recall-open')[0].props['aria-label'], 'Open “Fix the gateway” at turn 4');
    assert.deepEqual(withAttr(row, 'data-recall-other').map((e) => e.props['aria-label']), ['Open “Fix the gateway” at turn 2', 'Open “Fix the gateway” at turn 7']);
    assert.equal(button(row, 'Read here').props['aria-label'], 'Read “Fix the gateway”, turn 4 here');

    const transcript = ResultRow({ r: TRANSCRIPT, home: HOME });
    assert.match(textIn(transcript), /^Untitled transcriptCoding-agent transcript · ~\/work\/parser · glm-5\.3-flash · turn 2/);
    assert.equal(button(transcript, 'Read here'), undefined, 'it opens here anyway');
    assert.equal(withAttr(transcript, 'data-recall-open')[0].props['aria-label'], 'Read “Untitled transcript”, turn 2 here');
    withAttr(transcript, 'data-recall-open')[0].props.onClick();
    assert.deepEqual(plain(finder.store.get().reading), { id: '9.2', from: '[data-recall-open="9.2"]' });
    const note = ResultRow({ r: NOTE, home: HOME });
    assert.match(textIn(note), /1 other section of this note matches:section 5/);
    assert.equal(withAttr(note, 'data-recall-other')[0].props['aria-label'], 'Read “Gateway handoff”, section 5 here');
    withAttr(note, 'data-recall-other')[0].props.onClick();
    assert.deepEqual(plain(finder.store.get().reading), { id: '12.5', from: '[data-recall-other="12.5"]' });
    const two = ResultRow({ r: { ...NOTE, hits: 3, others: [{ turn: 5, seq: 0 }, { turn: 6, seq: 0 }] }, home: HOME });
    assert.match(textIn(two), /2 other sections of this note match:section 5section 6/);
    // A session whose title alone has the words: said so, it opens at its first turn, and no other turn is offered.
    const titled = ResultRow({ r: { ...OWN, id: '5.1', file: 5, turn: 1, seq: 4, snippet: '', hits: 0, others: [], titleOnly: true, asked: 'Check the build' }, home: HOME });
    assert.match(textIn(titled), /Only its title matches: it opens at its first turn\.Asked: Check the build/);
    assert.equal(withAttr(titled, 'data-recall-other').length, 0);
    const titledNote = ResultRow({ r: { ...NOTE, turn: 1, snippet: '', hits: 0, others: [], titleOnly: true }, home: HOME });
    assert.match(textIn(titledNote), /Only its title matches: it opens at its first section\./);
    // A window that cannot open sessions shows the turn in Recall instead.
    views.openSession = () => false;
    withAttr(row, 'data-recall-open')[0].props.onClick();
    await settle(5);
    assert.equal(finder.store.get().reading.id, '3.4');

    const empty = (state, data = STATE) => textIn(NoResults({ state: { query: { text: '', kind: 'any', when: 'any', folder: '', model: '', sort: 'best' }, ...state }, data }));
    assert.match(empty({}, { ...STATE, index: { ...STATUS, roots: [] } }), /^Recall searches nothing nowSwitch on “Search this DSH's sessions”, or add folders/);
    assert.match(empty({}, { ...STATE, index: { ...STATUS, busy: true, totals: { turns: 0, files: 0 } } }), /Reading your sessions for the first time/);
    assert.match(empty({}, { ...STATE, index: { ...STATUS, totals: { turns: 0, files: 0 } } }), /^Nothing to search yet/);
    assert.match(empty({ query: { text: '-staging', kind: 'any', when: 'any', folder: '', model: '', sort: 'best' }, found: { nothing: 'no-words' } }), /^Type a word to search for/);
    const none = NoResults({ state: { query: { text: 'kubernetes', kind: 'any', when: 'week', folder: '', model: '', sort: 'best' }, found: { total: 0 } }, data: STATE });
    assert.match(textIn(none), /^Nothing matches “kubernetes”Try fewer or other words, or the start of a word .* The filters may also leave it out\./);
    assert.ok(button(none, 'Search again without the filters'), 'one "Clear the filters" in the filter row; the empty state says what its button does from there');
    assert.equal(button(none, 'Clear the filters'), undefined);
    const noTurns = NoResults({ state: { query: { text: '', kind: 'transcript', when: 'week', folder: '', model: '', sort: 'best' }, found: { total: 0 } }, data: STATE });
    assert.match(textIn(noTurns), /^No turns with these filtersTry another time, folder or model\.Search again without the filters$/);
});

test('reading view: the turn in full, the turns beside it, the way into its session, and back', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, ReadingView, finder, views, jump, endJump } = client.internals;
    const TURN = { ...OWN, path: `${HOME}/.dsh/sessions/w/sess-own-1/session.v4.jsonl.zstd`, prompt: 'please deploy the gateway to staging', reply: 'Deployed: 3 pods ready.', tools: 'bash: make deploy ENV=staging', prev: 3, next: 5, count: 9 };
    const turns = {
        '3.4': TURN,
        '3.6': { ...TURN, id: '3.6', turn: 6, reply: '', tools: '', state: 'cut-off' },
        '3.9': { ...TURN, id: '3.9', turn: 9, reply: '', tools: '', state: 'running', running: true, next: undefined },
        '3.7': { ...TURN, id: '3.7', turn: 7, reply: 'Half an answer', state: 'failed', why: 'The model provider did not answer (503)' },
        '9.2': { ...TRANSCRIPT, prompt: 'roll back', reply: 'Rolled back.', tools: '', prev: undefined, next: 3, count: 3 },
    };
    const calls = connect(kit, { turn: ({ id }) => turns[id] ?? { ok: false, error: { code: 'recall/refused', message: 'That result is no longer in the index (its file changed or went). Search again.' } } });
    t.after(() => { kit.setConnection(undefined); endJump(); });
    let backs = 0;
    const view = mount(ReadingView, { id: '3.4', home: HOME, onBack: () => { backs += 1; } });
    t.after(() => view.unmount());
    assert.match(textIn(view.tree), /Reading the turn/);
    await settle(5);
    let text = textIn(view.tree);
    assert.deepEqual(calls[0], ['turn', { id: '3.4' }]);
    assert.match(text, /^Back to the resultsFix the gatewaySession · ~\/work\/gateway · glm-5\.3 · turn 4 of 9 · 1 h ago/);
    assert.match(text, /Askedplease deploy the gateway to stagingReplyDeployed: 3 pods ready\.Commands and files it usedbash: make deploy ENV=staging/);
    assert.doesNotMatch(text, /sess-own-1|session\.v4/, 'no ids or log files where people read');
    finder.read('3.4', '[data-recall-peek="3.4"]');
    button(view.tree, 'Turn after').props.onClick();
    assert.deepEqual(plain(finder.store.get().reading), { id: '3.5', from: '[data-recall-peek="3.4"]' }, 'Back still goes to what opened it');
    button(view.tree, 'Turn before').props.onClick();
    assert.deepEqual(plain(finder.store.get().reading), { id: '3.3', from: '[data-recall-peek="3.4"]' });
    const opened = [];
    views.openSession = (id) => { opened.push(id); return true; };
    const loads = [];
    views.sessions = { binding: () => ({ session: { loadThrough: async (seq) => { loads.push(seq); } } }) };
    button(view.tree, 'Open the session at this turn').props.onClick();
    await settle(5);
    assert.deepEqual(opened, ['sess-own-1']);
    assert.deepEqual(loads, [40]);
    assert.equal(jump.get().turn, 4);
    withAttr(view.tree, 'data-recall-back')[0].props.onClick();
    assert.equal(backs, 1);

    // How a turn ended, when not as it should: in its meta line after "of 9", and in a sentence.
    view.update({ id: '3.6' });
    await settle(5);
    text = textIn(view.tree);
    assert.match(text, /turn 6 of 9 · cut off by a restart · 1 h agoThis turn was cut off by a restart: DSH stopped before it finished\.Asked/);
    assert.match(text, /ReplyThis turn has no reply text\./);
    assert.equal(withAttr(view.tree, 'data-recall-state')[0].props['data-recall-state'], 'cut-off');
    view.update({ id: '3.9' });
    await settle(5);
    text = textIn(view.tree);
    assert.match(text, /turn 9 of 9 · still running · 1 h agoThis turn is still running\.Asked/);
    assert.match(text, /ReplyNo reply yet\./);
    view.update({ id: '3.7' });
    await settle(5);
    assert.match(textIn(view.tree), /turn 7 of 9 · failed · 1 h agoThis turn failed: The model provider did not answer \(503\)\.Asked.*ReplyHalf an answer/);
    view.update({ id: '3.4' });
    await settle(5);
    assert.equal(withAttr(view.tree, 'data-recall-state').length, 0, 'a turn that ended as it should says nothing more');
    view.update({ id: '9.2' });
    await settle(5);
    text = textIn(view.tree);
    assert.match(text, /File: ~\/agent-logs\/run\.jsonl, line 14/);
    assert.equal(button(view.tree, 'Open the session at this turn'), undefined, 'not a session of this DSH');
    assert.equal(button(view.tree, 'Turn before'), undefined);
    assert.ok(button(view.tree, 'Turn after'));
    view.update({ id: '99.1' });
    await settle(5);
    assert.match(textIn(view.tree), /Couldn't read it: That result is no longer in the index \(its file changed or went\)\. Search again\./);
});

test('reading view: Back puts the focus on the button that opened it, even after Turn before or after; else on its row, else the search box', async () => {
    const focused = [];
    const present = new Set(['[data-recall-other="9.3"]', '[data-recall-open="9.2"]']);
    const document = { querySelector: (sel) => (present.has(sel) ? { focus: () => focused.push(sel) } : null) };
    const { client } = loadClient(CLIENT, { document });
    const { SearchCard, finder } = client.internals;
    const back = () => withAttr(SearchCard({ data: STATE }), 'data-recall-back')[0].props.onClick();
    finder.read('9.3', '[data-recall-other="9.3"]');
    finder.read('9.2', finder.store.get().reading.from);
    back();
    await settle(5);
    assert.equal(finder.store.get().reading, undefined, 'the list again');
    assert.deepEqual(focused, ['[data-recall-other="9.3"]'], 'the "turn 3" link that opened it, though the view moved to turn 2');
    finder.read('9.2', '[data-recall-peek="9.2"]');
    back();
    await settle(5);
    assert.deepEqual(focused.at(-1), '[data-recall-open="9.2"]', 'what opened it is gone: its row');
});

test('opening a session at a turn: the mark shows on that turn only, brings it into view, marks its rows, stops when the person scrolls, and goes when done', async (t) => {
    const chat = fakeChat({ 4: [1500, 1700], 5: [2600] });
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react, document: chat.document, globals: { getComputedStyle: chat.getComputedStyle } });
    const { RecallMark, jump, views, openAt, endJump, land, landWithoutMark } = client.internals;
    t.after(() => endJump());
    // No workspace: nothing opens, and the caller shows the turn in Recall.
    assert.equal(await openAt({ sessionId: 'sess-own-1', turn: 4, seq: 40 }), false);
    assert.equal(jump.get(), undefined);
    views.openSession = () => true;
    let ask = 0;
    views.sessions = { binding: () => (++ask < 3 ? undefined : { session: { loadThrough: async () => {} } }) };
    assert.equal(await openAt({ sessionId: 'sess-own-1', turn: 4, seq: 40, query: 'deploy the gateway' }), true);
    assert.equal(ask, 3, 'it waits for DSH to hold the session');
    // A session opened just now is still reading its first page, and DSH's jump loader does nothing until it is in: Recall waits for it.
    let state = { openState: 'loading', loadingOlder: false };
    const jumps = [];
    views.sessions = { binding: () => ({ session: { getSnapshot: () => state, loadThrough: async (seq) => { jumps.push([state.openState, seq]); } } }) };
    const opening = openAt({ sessionId: 'sess-own-1', turn: 4, seq: 40, query: 'deploy the gateway' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(jumps, [], 'not while its first page loads');
    state = { openState: 'open', loadingOlder: false };
    assert.equal(await opening, true);
    assert.deepEqual(jumps, [['open', 40]]);

    const elsewhere = [mount(RecallMark, { turn: { turn: 5 }, sessionId: 'sess-own-1' }), mount(RecallMark, { turn: { turn: 4 }, sessionId: 'other' })];
    t.after(() => { for (const m of elsewhere) m.unmount(); });
    assert.equal(elsewhere[0].tree, null, 'another turn: nothing');
    assert.equal(elsewhere[1].tree, null, 'another session: nothing');
    const mark = mount(RecallMark, { turn: { turn: 4 }, sessionId: 'sess-own-1' });
    t.after(() => mark.unmount());
    assert.equal(mark.tree.props['aria-label'], 'Found by Recall');
    assert.match(mark.tree.props.className, /dshrc-pane dshrc-mark/);
    assert.equal(textIn(mark.tree), 'Found by Recall · turn 4, for “deploy the gateway”Back to the resultsDone');

    // DSH draws the mark in the turn's chat: the mark finds its flow, scrolls the turn's first row to the top, marks its rows.
    land(chat.flow, 4, jump.get().n);
    await settle(10);
    assert.equal(chat.scroller.scrollTop, 1500 - 24);
    assert.deepEqual(chat.rows.get(4).map((row) => row.attrs['data-recall-found']), ['line', 'line']);
    assert.equal(chat.rows.get(5)[0].attrs['data-recall-found'], undefined);
    assert.equal(jump.get().landed, true);
    // DSH lands the chat at its end a moment later; Recall tries again, until the person scrolls.
    chat.scroller.scrollTop = 8000;
    await settle(140);
    assert.equal(chat.scroller.scrollTop, 1500 - 24, 'brought back');
    chat.scroller.fire('wheel');
    chat.scroller.scrollTop = 3000;
    await settle(400);
    assert.equal(chat.scroller.scrollTop, 3000, 'the person scrolled: Recall stops');
    assert.equal(chat.scroller.listeners.wheel.size, 0, 'and stops listening');
    // A turn with no mark (still open) is found in the one chat that holds it.
    landWithoutMark(5, jump.get().n);
    await settle(10);
    assert.equal(chat.scroller.scrollTop, 2600 - 24);

    // Done: the mark and the line go.
    button(mark.tree, 'Done').props.onClick();
    assert.equal(jump.get(), undefined);
    assert.deepEqual(chat.rows.get(4).map((row) => row.attrs['data-recall-found']), [undefined, undefined]);
    mark.update({});
    assert.equal(mark.tree, null, 'the mark goes');
    let pages = 0;
    views.openPage = () => { pages += 1; };
    await openAt({ sessionId: 'sess-own-1', turn: 4, seq: 40 });
    mark.update({});
    button(mark.tree, 'Back to the results').props.onClick();
    assert.equal(pages, 1);
});

test('the tool\'s card: running, what it found (each a press from its turn), nothing, a turn read in full, and a refusal, in words', async (t) => {
    const { client } = loadClient(CLIENT, { react: standInReact() });
    const { RecallToolView, finder, views, jump, endJump, kit } = client.internals;
    const calls = connect(kit, { search: FOUND });
    t.after(() => { endJump(); kit.setConnection(undefined); });
    const args = (values) => ({ text: (key) => values[key] });
    let tree = RecallToolView({ phase: 'preparing', block: { args: args({ query: 'deploy gate' }) } });
    assert.equal(tree.props['data-recall-tool'], 'preparing');
    let row = elementsOf(tree).find((e) => e.type === 'DisclosureRow');
    assert.equal(row.props.title, 'Searching past work for “deploy gate”');
    assert.equal(row.props.running, true);
    tree = RecallToolView({ phase: 'preparing', block: {}, useToolCallArgumentsPartial: () => '{"query":"roll ba' });
    assert.equal(elementsOf(tree).find((e) => e.type === 'DisclosureRow').props.title, 'Searching past work for “roll ba”', 'from the arguments as they stream in');
    tree = RecallToolView({ phase: 'start', block: { argsRaw: '{"open":"3.4"}' } });
    assert.equal(elementsOf(tree).find((e) => e.type === 'DisclosureRow').props.title, 'Reading a past turn');

    const opened = [];
    views.openSession = (id) => { opened.push(id); return true; };
    views.sessions = { binding: () => ({ session: { loadThrough: async () => {} } }) };
    let pages = 0;
    views.openPage = () => { pages += 1; };
    const results = { kind: 'results', query: 'deploy', total: 7, totalMore: false, sessions: 3, took: 4, results: [OWN, TRANSCRIPT] };
    tree = RecallToolView({ phase: 'result', home: HOME, useDisclosure: () => ({ expanded: true, toggle() {} }), block: { isError: false, content: [{ type: 'text', text: 'Recall found 7 matching turns …' }], meta: results, call: { argsRaw: '{"query":"deploy","kind":"session"}' } } });
    assert.equal(tree.props['data-recall-tool'], 'results');
    row = elementsOf(tree).find((e) => e.type === 'DisclosureRow');
    assert.equal(row.props.title, 'Searched past work for “deploy”: 7 turns in 3 sessions', 'the call asked for sessions: its places are named so');
    assert.equal(row.props.expandable, true);
    let text = textIn(tree);
    assert.match(text, /Fix the gatewaySession · ~\/work\/gateway · glm-5\.3 · turn 4 · .*we deployed the gateway to …Open/);
    assert.match(text, /Untitled transcriptCoding-agent transcript · ~\/work\/parser · glm-5\.3-flash · turn 2 · .*rollback of the parserRead/);
    assert.doesNotMatch(text, /recall_search|sess-own-1|3\.4|Recall found/, 'no tool name, ids or the agent\'s text where people read');
    button(tree, 'Open').props.onClick();
    await settle(5);
    assert.deepEqual(opened, ['sess-own-1']);
    assert.equal(jump.get().query, 'deploy');
    button(tree, 'Read').props.onClick();
    assert.equal(finder.store.get().reading.id, '9.2');
    assert.equal(pages, 1, 'the reading view is on Recall\'s page');
    withAttr(tree, 'data-recall-tool-page')[0].props.onClick();
    assert.deepEqual(plain(finder.store.get().query), { text: 'deploy', kind: 'session', when: 'any', folder: '', model: '', sort: 'best' }, 'the same search, on the page');
    assert.equal(pages, 2);
    await settle(5);
    assert.deepEqual(calls.at(-1), ['search', { query: { text: 'deploy', kind: 'session', sort: 'best', limit: 20, offset: 0, prefix: true } }]);

    tree = RecallToolView({ phase: 'result', useDisclosure: () => ({ expanded: true, toggle() {} }), block: { isError: false, meta: { kind: 'results', query: 'zzz', total: 0, sessions: 0, results: [] } } });
    assert.match(textIn(tree), /Nothing matched\. The agent may try other words\./);
    assert.equal(elementsOf(tree).find((e) => e.type === 'DisclosureRow').props.title, 'Searched past work for “zzz”: nothing found');

    tree = RecallToolView({ phase: 'result', home: HOME, useDisclosure: () => ({ expanded: true, toggle() {} }), block: { isError: false, meta: { kind: 'turn', turn: { ...NOTE, prompt: '', reply: 'Deploy after the review is done.' } } } });
    assert.equal(elementsOf(tree).find((e) => e.type === 'DisclosureRow').props.title, 'Read a past turn: “Gateway handoff”');
    assert.match(textIn(tree), /Handoff note · ~\/notes · section “Next steps”, line 40 · .*Reply: Deploy after the review is done\.Read it in Recall/);

    tree = RecallToolView({ phase: 'result', block: { isError: true, error: { code: 'tool-error', reason: 'Recall is switched off in DSH\'s profile (enabled: false), so it keeps no index.' }, call: { argsRaw: '{"query":"x"}' } } });
    assert.equal(tree.props['data-recall-tool'], 'failed');
    assert.equal(elementsOf(tree).find((e) => e.type === 'DisclosureRow').props.title, 'Didn\'t search past work: Recall is switched off in DSH\'s profile (enabled: false), so it keeps no index.');
    tree = RecallToolView({ phase: 'result', block: { isError: true, error: { code: 'interrupted' }, call: { argsRaw: '{"open":"3.4"}' } } });
    assert.equal(elementsOf(tree).find((e) => e.type === 'DisclosureRow').props.title, 'Didn\'t read the past turn: stopped before it finished.');
    tree = RecallToolView({ phase: 'result', block: { isError: false, content: [], call: { argsRaw: '{"query":"deploy"}' } } });
    assert.equal(elementsOf(tree).find((e) => e.type === 'DisclosureRow').props.title, 'Searched past work for “deploy”', 'an older result with no card: its line');
});

test('the tool\'s card shows paths from ~ too: it asks Recall once for the home folder', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { RecallToolView, kit } = client.internals;
    const calls = connect(kit, { state: STATE });
    const props = { phase: 'result', useDisclosure: () => ({ expanded: true, toggle() {} }), block: { isError: false, meta: { kind: 'results', query: 'deploy', total: 1, sessions: 1, results: [OWN] } } };
    const card = mount(RecallToolView, props);
    const again = mount(RecallToolView, props);
    t.after(() => { card.unmount(); again.unmount(); kit.setConnection(undefined); });
    assert.match(textIn(card.tree), /Session · \/Users\/me\/work\/gateway · glm-5\.3/, 'before it knows: the full path');
    await settle(5);
    card.update({});
    again.update({});
    assert.match(textIn(card.tree), /Session · ~\/work\/gateway · glm-5\.3/);
    assert.match(textIn(again.tree), /~\/work\/gateway/);
    assert.equal(calls.filter(([name]) => name === 'state').length, 1, 'asked once for every card');
});

test('index: each folder\'s state in words, files it could not read, folders left out, and its actions', async (t) => {
    const { client } = loadClient(CLIENT, { react: standInReact() });
    const { IndexCard, rootWords } = client.internals;
    const actions = [];
    const tree = IndexCard({ data: STATE, busy: false, said: { text: '', bad: false }, onAction: (m) => actions.push(m) });
    const text = textIn(tree);
    assert.match(text, /^Index1,234 turns from 56 files · 7 MB on this computer · read 1 min ago/);
    assert.match(text, /This DSH's sessions~\/\.dsh\/sessions · 50 files · 1,200 turns · looked just nowup to date/);
    assert.match(text, /Handoff notes~\/notes · 6 notes · 34 sections · 1 file could not be read · looked just nowup to date/);
    assert.match(text, /Coding-agent transcripts\/Volumes\/Backup\/logs · looked just nowThis folder is not there now \(a disk may be unplugged\)\. What Recall read from it stays searchable, and it looks again every minute\.not there/);
    assert.match(text, /Files Recall could not readbroken\.md~\/notes\/broken\.mdPermission denied\. Recall reads it again when it changes\./);
    assert.match(text, /Folders left out~\/notes\/oldInside \/Users\/me\/notes, which is already searched\./);
    button(tree, 'Look for changes now').props.onClick();
    button(tree, 'Rebuild the index').props.onClick();
    assert.deepEqual(actions, ['rescan', 'rebuild']);
    assert.equal(rootWords({ kind: 'session', root: '/s', state: 'ok', indexed: 2, turns: 3 }, { busy: true, reading: { kind: 'session', path: '/s/p/x/session.v4.jsonl.zstd' } }).word, 'reading');
    assert.equal(rootWords({ kind: 'session', root: '/s', state: 'ok', indexed: 2, turns: 3 }, { busy: true, reading: { kind: 'session', path: '/sx/p' } }).word, 'up to date', 'another folder is being read');
    // The index's words for a folder it cannot read say what to do, once: the card adds nothing to them.
    const folderWords = 'DSH may not read this folder (permission denied). Give DSH access to it, or name another folder in Recall\'s settings.';
    assert.deepEqual(plain(rootWords({ kind: 'handoff', root: '/n', state: 'unreadable', error: folderWords, indexed: 0 }, {})), { word: 'cannot read', counts: '', why: folderWords });
    assert.equal(rootWords({ kind: 'handoff', root: '/n', state: 'unreadable', error: 'This is a file, not a folder. Name the folder that holds it in Recall\'s settings.' }, {}).why, 'This is a file, not a folder. Name the folder that holds it in Recall\'s settings.');
    assert.equal(rootWords({ kind: 'handoff', root: '/n', state: 'unreadable', error: '' }, {}).why, 'Recall cannot read this folder. Check that DSH may read it.');
    assert.match(rootWords({ kind: 'transcript', root: '/t', state: 'ok', capped: true, files: 50000, indexed: 50000, turns: 9 }, {}).why, /only the first 50,000 are searched/);
    assert.equal(rootWords({ kind: 'transcript', root: '/t', state: 'waiting' }, {}).why, 'Not read yet.');
    const empty = IndexCard({ data: { ...STATE, index: { ...STATUS, roots: [], problems: [] }, left: [] }, busy: false, said: {}, onAction: () => {} });
    assert.match(textIn(empty), /No folders to searchSwitch on “Search this DSH's sessions”, or add folders, in Recall's settings\./);
    assert.equal(button(empty, 'Look for changes now'), undefined);

    // The page asks, and says what happened.
    const { react, mount } = statefulReact();
    const { client: c2 } = loadClient(CLIENT, { react });
    const calls = connect(c2.internals.kit, { state: STATE, search: FOUND, rescan: STATUS, rebuild: { ok: false, error: { code: 'recall/refused', message: 'Recall\'s index is starting. Try again in a moment.' } } });
    const page = mount(c2.internals.RecallPage, {});
    t.after(() => { page.unmount(); c2.internals.kit.setConnection(undefined); });
    await settle(5);
    page.update({});
    withAttr(page.tree, 'data-recall-action').find((e) => e.props['data-recall-action'] === 'rescan').props.onClick();
    await settle(5);
    assert.ok(calls.some(([name]) => name === 'rescan'));
    assert.match(textIn(page.tree), /Looking through every folder for new, changed and deleted files\./);
    withAttr(page.tree, 'data-recall-action').find((e) => e.props['data-recall-action'] === 'rebuild').props.onClick();
    await settle(5);
    assert.match(textIn(page.tree), /Not rebuilt: Recall's index is starting\. Try again in a moment\./);
    assert.equal(withAttr(page.tree, 'data-recall-said')[0].props.role, 'alert');
});

test('settings in Plugins: every live setting, with the config\'s words, folder lists of full or ~/ paths, saved through DSH', async () => {
    const { client } = loadClient(CLIENT);
    const { SETTINGS, TEXT, CSS, SETTINGS_NOTE, SETTINGS_SUMMARY, folderList, folderSpec, specOf } = client.internals;
    assert.deepEqual(plain(SETTINGS.map((f) => f.name).sort()), [...LIVE_SETTINGS].sort());
    for (const f of SETTINGS) {
        assert.equal(f.title, SETTING_TITLES[f.name], `${f.name}: the form and the config use the same words`);
        assert.deepEqual(plain(f.default), plain(DEFAULTS[f.name]), `${f.name}: the form's default is the config's`);
        if (f.kind !== 'folders') continue;
        for (const text of ['~/notes', '/Users/me/a, ~/b', '~', '/a\n/b\n', `${'/x,'.repeat(20)}`]) {
            const list = folderList(text);
            assert.ok(list, text);
            assert.equal(f.accepts(text), true, text);
            assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: list }), text);
            assert.deepEqual(plain(specOf(f).parse(text)), { kind: 'set', value: plain(list) });
        }
        for (const text of ['notes', '~/a, b', './x', `${'/x,'.repeat(21)}`, '~user/x']) {
            assert.equal(folderList(text), undefined, text);
            assert.equal(f.accepts(text), false, text);
            assert.equal(specOf(f).parse(text), undefined, `${text}: never saved`);
        }
        assert.deepEqual(plain(specOf(f).parse('  ')), { kind: 'clear' }, 'empty: none (the default)');
        assert.match(f.invalid, /full path or a path from ~\//);
    }
    assert.deepEqual(plain(folderList('/a, ~/b\n/c')), ['/a', '~/b', '/c']);
    const spec = folderSpec({ name: 'handoffFolders' });
    assert.equal(spec.format(['~/a', '/b']), '~/a, /b');
    assert.equal(spec.format(undefined), '');
    assert.equal(spec.format('~/x'), '"~/x"', 'one folder saved without the brackets shows as the profile has it, so the form flags it');
    assert.equal(spec.format(3), '3');
    assert.equal(specOf(SETTINGS.find((f) => f.name === 'handoffFolders')).parse('"~/x"'), undefined, 'the quoted text never saves as it is');
    assert.deepEqual(plain(specOf(SETTINGS.find((f) => f.name === 'handoffFolders')).parse('~/x')), { kind: 'set', value: ['~/x'] }, 'without the quotes it saves as a list');
    assert.equal(specOf(SETTINGS.find((f) => f.name === 'tool')).parse('off').value, false, 'switches as the kit does them');
    assert.doesNotMatch(JSON.stringify(TEXT) + CSS.join('') + JSON.stringify(SETTINGS) + SETTINGS_NOTE + SETTINGS_SUMMARY, OTHER_NAMES);
    assert.doesNotMatch(JSON.stringify(SETTINGS) + SETTINGS_NOTE + SETTINGS_SUMMARY + JSON.stringify(TEXT), /recall_search/, 'no tool name where people read');

    // Drawn through DSH's own settings form while DSH serves Recall's settings.
    const models = [];
    class SettingsFormModel {
        constructor(scope, specs, secrets) { this.scope = scope; this.specs = specs; this.secrets = secrets; models.push(this); }
        bind(project) { const value = project(); return { subscribe: () => () => {}, getSnapshot: () => value, set() {} }; }
        shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }; }
        field(name) { const s = this.specs.find((x) => x.field === name); return { text: s.format(this.scope.getSnapshot().value[name]), overridden: false, invalid: false }; }
        actions() { return { edit() {}, resetField() {}, save() {}, discard() {} }; }
        dispose() { this.disposed = true; }
    }
    const { client: formClient } = loadClient(CLIENT, { ui: { SettingsFormModel, SettingsForm: (props) => ({ type: 'SettingsForm', props, children: props.children }) } });
    const registered = [];
    const served = [];
    const effects = [];
    const scope = {
        configForms: {
            get: (entry) => ({ entry, getSnapshot: () => ({ status: 'ready', writable: true, value: { ...DEFAULTS, handoffFolders: ['~/notes', '/srv/handoffs'], transcriptFolders: '~/agent-logs', tool: 'yes' } }), subscribe: () => () => {} }),
            whileServed: (entries, fn) => { served.push(entries); return fn(); },
        },
        slots: { inject: (_name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        effect: (fn) => { effects.push(fn); },
        inject: (names, fn) => { if (names[0] === 'configForms') fn(scope); },
    };
    formClient.apply(scope);
    for (const fn of effects) fn();
    await settle();
    assert.deepEqual(plain(served), [['recall']]);
    assert.equal(models[0].scope.entry, 'recall');
    assert.deepEqual(plain(models[0].specs.map((s) => s.field).sort()), [...LIVE_SETTINGS].sort());
    assert.deepEqual(plain(models[0].secrets), []);
    const entry = registered.find((item) => item.spec.name === 'plugins.bundle.config');
    assert.equal(entry.spec.key, 'dsh-plugin-recall');
    assert.equal(entry.component({ view: 'summary' }), SETTINGS_SUMMARY);
    const form = entry.component({});
    const page = textIn(form);
    assert.match(page, /What Recall searches/);
    assert.match(page, /Everything stays on this computer\./);
    const fields = elementsOf(form).filter((e) => e.type === 'SettingsValueField');
    assert.deepEqual(plain(fields.map((e) => e.props.label)), plain(SETTINGS.filter((f) => f.kind === 'folders').map((f) => SETTING_TITLES[f.name])), 'each folder list in a field of DSH\'s form');
    const handoffs = fields.find((e) => e.props.label === 'Handoff note folders');
    assert.equal(handoffs.props.text, '~/notes, /srv/handoffs');
    assert.equal(handoffs.props.invalid, false);
    // The judge's shapes, typed into the profile: one folder without the brackets, and "yes" for a switch.
    const transcripts = fields.find((e) => e.props.label === 'Coding-agent transcript folders');
    assert.equal(transcripts.props.text, '"~/agent-logs"', 'shown as the profile has it');
    assert.equal(transcripts.props.invalid, true, 'a saved value that is not a folder list is flagged');
    assert.match(transcripts.props.invalidLabel, /full path or a path from ~\//);
    const tool = elementsOf(form).find((e) => e.props?.['data-suite-setting'] === 'tool');
    assert.ok(tool.props['data-suite-invalid'] !== undefined, 'a switch saved as "yes" is flagged');
    assert.match(textIn(tool), /The saved value is neither on nor off\. Switch it to the one you want, then save\./);
});
