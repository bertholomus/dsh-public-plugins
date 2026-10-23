/**
 * Tests for the browser half of dsh-plugin-coordinator (lib/client.js),
 * loaded the way DSH loads it, with stand-ins for React and DSH's
 * primitives. No DSH install needed.
 *
 * Run:  node plugins/coordinator/test/client.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { handbackMessage, idleMessage, approvalMessage, outsideMessage, replyMessage, briefMessage, coordinatorMessage } from '../lib/prompts.js';

// No test reads or writes the real ~/.dsh: DSH's data folder is this run's own, as a DSH
// started with DSH_HOME has. Set before anything resolves a default path; removed at exit.
const tempDshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'));
process.env.DSH_HOME = tempDshHome;
process.on('exit', () => { try { rmSync(tempDshHome, { recursive: true, force: true }); } catch {} });

const tick = () => new Promise((r) => setTimeout(r, 10));
/** Values made inside the script's context, copied so they compare as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * Load the browser half the way DSH does: a classic script that hands its
 * factory to the module loader, which calls it with DSH's module require.
 * The primitives are stand-ins; an icon is its own name.
 */
function loadClient({ storage, document, innerWidth, primitives = {} } = {}) {
    let loaded;
    const localStorage = storage ? { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); } } : undefined;
    const window = { __ModuleLoader__: { load: (m) => { loaded = m; } }, localStorage, addEventListener: () => {}, removeEventListener: () => {}, innerWidth };
    runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
        window, ...(document ? { document } : {}),
        URL, console, setInterval, clearInterval, setTimeout, clearTimeout, queueMicrotask,
    });
    const base = {
        SettingsFormModel: class {
            constructor(scope) { this.scope = scope; }
            bind(project) { return { getSnapshot: project, subscribe: () => () => {} }; }
            shell() { return { available: this.scope.getSnapshot().status === 'ready', writable: true, dirty: false, invalid: false, saving: false, failed: false }; }
            field(name) { return { text: this.scope.getSnapshot().value?.[name] ?? '', overridden: false, invalid: false }; }
            actions() { return {}; }
            dispose() {}
        },
        settingsTextField: (field) => ({ field }),
        Toast: () => null,
        ...primitives,
    };
    const ui = new Proxy(base, { get: (target, name) => (name in target ? target[name] : typeof name === 'string' && name.startsWith('Icon') ? name : undefined) });
    const modules = {
        react: {
            createElement: (type, props, ...children) => ({ type, props, children }), useSyncExternalStore: (_subscribe, get) => get(),
            // Enough of React's hooks to call a component once and read what it draws.
            useState: (init) => [typeof init === 'function' ? init() : init, () => {}], useRef: (current) => ({ current }),
            useEffect: () => {}, useLayoutEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useId: () => ':r0:',
        },
        'react-dom': { createPortal: (node) => node }, '@deepseek-ai/dsh-client-ui-primitives': ui,
    };
    return { id: loaded.id, client: loaded.factory((name) => modules[name]), window, react: modules.react };
}

/**
 * Draw a component again and again with state that holds between draws
 * (the stand-in React's useState forgets), so a click can open what it opens.
 * @returns a function that draws it once more.
 */
function mount(react, render) {
    const cells = [];
    return () => {
        let at = 0;
        react.useState = (init) => {
            const k = at++;
            if (!(k in cells)) cells[k] = typeof init === 'function' ? init() : init;
            return [cells[k], (next) => { cells[k] = typeof next === 'function' ? next(cells[k]) : next; }];
        };
        return render();
    };
}

/** Every element in a tree a component returned (the test React's {type, props, children}), depth first. */
function elementsOf(node, out = []) {
    if (Array.isArray(node)) { for (const child of node) elementsOf(child, out); return out; }
    if (node === null || typeof node !== 'object') return out;
    out.push(node);
    elementsOf(node.children, out);
    return out;
}
/** The text an element tree shows. */
const textIn = (node) => (Array.isArray(node) ? node.map(textIn).join('') : node === null || node === undefined || node === false ? ''
    : typeof node === 'object' ? textIn(node.children) : String(node));
const byClass = (tree, name) => elementsOf(tree).filter((e) => String(e.props?.className ?? '').split(' ').includes(name));

/** Just enough of the DOM for the session list's passes: attributes, children, and the selectors they use. */
class FakeEl {
    constructor(tag, attrs = {}, children = []) {
        this.tagName = tag.toUpperCase();
        this.attrs = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
        this.children = children;
        this.parentElement = null;
        for (const child of children) child.parentElement = this;
    }
    get id() { return this.attrs.get('id') ?? ''; }
    set id(value) { this.attrs.set('id', String(value)); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    hasAttribute(name) { return this.attrs.has(name); }
    removeAttribute(name) { this.attrs.delete(name); }
    /** `[a]`, `[a="v"]`, `[a^="v"]`, lists of them, and the one compound selector the passes use, `[role="tree"] div`. */
    matches(selector) {
        if (selector.includes(',')) return selector.split(',').some((one) => this.matches(one));
        if (selector === '[role="tree"] div') {
            if (this.tagName !== 'DIV') return false;
            for (let e = this.parentElement; e; e = e.parentElement) if (e.getAttribute('role') === 'tree') return true;
            return false;
        }
        const m = /^\[([\w-]+)(?:(\^?=)"([^"]*)")?\]$/.exec(selector);
        if (!m) throw new Error(`selector not faked: ${selector}`);
        const value = this.getAttribute(m[1]);
        return value !== null && (!m[2] || (m[2] === '=' ? value === m[3] : value.startsWith(m[3])));
    }
    querySelectorAll(selector) {
        const out = [];
        const walk = (el) => { for (const child of el.children) { if (child.matches(selector)) out.push(child); walk(child); } };
        walk(this);
        return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) {
        for (let e = this; e; e = e.parentElement) if (e.matches(selector)) return e;
        return null;
    }
}

/**
 * Draw a component again and again with state, refs and effects that hold
 * between draws, effects running after each draw (their dependencies are
 * the component's own business), so a fetch it starts can land.
 */
function liveMount(react, render) {
    const cells = [];
    const refs = [];
    return () => {
        let at = 0;
        let ref = 0;
        const effects = [];
        react.useState = (init) => {
            const k = at++;
            if (!(k in cells)) cells[k] = typeof init === 'function' ? init() : init;
            return [cells[k], (next) => { cells[k] = typeof next === 'function' ? next(cells[k]) : next; }];
        };
        react.useRef = (init) => {
            const k = ref++;
            if (!(k in refs)) refs[k] = { current: init };
            return refs[k];
        };
        react.useEffect = (fn) => { effects.push(fn); };
        const out = render();
        for (const fn of effects) fn();
        return out;
    };
}

test('browser half: a session DSH lists without the plugin\'s value is placed by what the plugin\'s store knows, never by its title', async () => {
    const { client } = loadClient();
    const { rowPlace, isThreadRow, takeKnown, projectFacts } = client.internals;
    // DSH dropped the saved values of an older version: no title says what a session is, a "◆ " one included.
    const state = { byId: { c: { id: 'c', title: '◆ DSH Plugins' }, t: { id: 't', title: 'DSH Plugins › Smoke test' }, x: { id: 'x', title: 'A chat' }, n: { id: 'n', title: 'Pricing' } } };
    assert.deepEqual(['c', 't', 'x', 'n'].map((id) => rowPlace(state, id)), ['', '', '', '']);
    assert.equal(isThreadRow(state, 't'), false);
    // The plugin's store: c and its thread t; n another coordinating chat.
    const link = { calls: 0, async call(method) { this.calls += 1; assert.equal(method, 'sessions'); return { ok: true, value: { sessions: {
        c: { role: 'coordinator', project: 'c', name: 'DSH Plugins' },
        t: { role: 'thread', project: 'c', name: 'DSH Plugins', thread: 't1', coordinator: 'c' },
        n: { role: 'coordinator', project: 'n', name: 'Pricing' },
        bad: { role: 'chat' },
    } } }; } };
    const facts = projectFacts(link);
    await facts.sessions();
    await facts.sessions();
    assert.equal(link.calls, 1, 'once per window');
    assert.deepEqual(['c', 't', 'x', 'n'].map((id) => rowPlace(state, id)), ['coordinator:c', 'thread:c', '', 'coordinator:n']);
    assert.deepEqual([isThreadRow(state, 't'), isThreadRow(state, 'x')], [true, false]);
    // DSH's own value wins once it has one: a thread nests under the session its value names.
    const folded = { ...state, projectionsBySession: { t: { values: { coordinatorSession: { role: 'thread', coordinator: 'c2', project: { id: 'c2', name: 'Q' } } } } } };
    assert.equal(rowPlace(folded, 't'), 'thread:c2');
    // A chat that stopped coordinating keeps its place while it has threads, and is a plain chat without.
    const stopped = (threads) => ({ ...state, projectionsBySession: { n: { values: { coordinatorSession: { role: 'coordinator', project: { id: 'n', name: 'Pricing' }, off: true, threads } } } } });
    assert.equal(rowPlace(stopped([{ id: 't1', session: 's1', title: 'Deploy', resolved: true }]), 'n'), 'coordinator:n');
    assert.equal(rowPlace(stopped([]), 'n'), '');
    takeKnown({});
    assert.equal(rowPlace(state, 't'), '');
});

test('browser half: the defaults form registers on the plugin page, read-only when the profile adds the row twice', () => {
    const { id, client } = loadClient();
    assert.equal(id, 'dsh-plugin-coordinator');
    // Each part waits for its own DSH services, so only the slots are required.
    assert.deepEqual([...client.inject], ['slots']);
    let snapshot = { status: 'ready', value: { threadEffort: 'max' }, base: {}, user: { threadEffort: 'max' }, writable: true, revision: 1 };
    const registered = [];
    const groups = [];
    const ctx = {
        effect: (fn) => fn(),
        // This DSH serves the settings services only; the threads part keeps waiting.
        inject: (names, fn) => { groups.push([...names]); if (names.includes('configForms')) fn(ctx); },
        configForms: {
            get: (ns) => (assert.equal(ns, 'coordinator'), { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }),
            whileServed: (names, fn) => (assert.deepEqual([...names], ['coordinator']), fn()),
        },
        slots: {
            inject: (_name, fn) => fn(),
            register: (slot, component) => { registered.push({ slot, component }); return () => {}; },
        },
    };
    client.apply(ctx);
    // The shared services first (model catalog, connection, sessions), then the three parts.
    assert.deepEqual(groups, [['remote', 'remote.session'], ['connection'], ['sessions'],
        ['configForms', 'remote', 'remote.session'], ['connection', 'remote', 'remote.session'], ['sessions', 'uiWorkspace', 'sidebarRight']]);
    assert.deepEqual(registered.map((r) => ({ ...r.slot })), [{ name: 'plugins.bundle.config', key: 'dsh-plugin-coordinator' }]);
    const page = registered[0].component;
    assert.equal(page({ view: 'summary' }), 'Default models, effort and access for threads.');
    // The page: the defaults form, then the Threads switch, and nothing more.
    const parts = page({ view: 'page' }).children;
    assert.deepEqual(parts.map((part) => part.type.name), ['DefaultsForm', 'ThreadOptions']);
    const form = parts[0].props.form;
    // The form sets what new threads run on and can reach; a coordinating chat keeps the user's own.
    assert.deepEqual(Object.keys(form.getSnapshot()).filter((key) => /^(thread|coordinator|your)/.test(key)).sort(), ['threadEffort', 'threadModel', 'threadPermission', 'yourTools']);
    const drawn = parts[0].type(parts[0].props);
    assert.deepEqual(elementsOf(drawn).filter((e) => e.type?.name === 'RouteSection').map((e) => e.props.route.id), ['thread']);
    assert.doesNotMatch(textIn(drawn), /project|coordinator|◆/i);
    assert.equal(form.getSnapshot().threadEffort.text, 'max');
    assert.equal(form.getSnapshot().insertedTwice, false);
    // The older setup adds the row with insert: the value the plugin runs with comes from neither layer a save edits.
    snapshot = { ...snapshot, user: {} };
    assert.equal(form.getSnapshot().insertedTwice, true);
    snapshot = { ...snapshot, base: { threadEffort: 'max' } };
    assert.equal(form.getSnapshot().insertedTwice, false);
    snapshot = { status: 'loading', value: undefined, base: undefined, user: undefined, writable: true, revision: undefined };
    assert.equal(form.getSnapshot().insertedTwice, false);
});

test('browser half: threads add a header menu and Coordinate (in the composer\'s row on DSH\'s new-chat screen), turn cards, sidebar marks and right-sidebar tabs', () => {
    const { client } = loadClient();
    const registered = [];
    const types = [];
    const protocols = [];
    const ctx = {
        effect: (fn) => fn(),
        inject: (names, fn) => { if (!names.includes('configForms')) fn(ctx); },
        slots: { inject: (_name, fn) => fn(), register: (slot) => { registered.push({ ...slot }); return () => {}; } },
        resources: { register: (provider) => { protocols.push(provider.protocol); return () => {}; } },
        sidebarRightTabs: { register: (type) => { types.push(type); return () => {}; } },
        sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }), subscribe: () => () => {} } },
        uiWorkspace: {},
        sidebarRight: {},
    };
    client.apply(ctx);
    assert.deepEqual(registered.map((r) => [r.name, r.id ?? r.key ?? null, r.order ?? null]), [
        ['shell.overlay', 'dsh-plugin-coordinator/project-settings', null],
        ['sidebar.workspaces.session.menu.item', 'dsh-plugin-coordinator/project-settings-item', 250],
        ['shell.overlay', 'dsh-plugin-coordinator/rename', null],
        ['conversation.session.header.actions', 'dsh-plugin-coordinator/threads-menu', -25],
        ['conversation.session.header.actions', 'dsh-plugin-coordinator/coordinate', -24],
        ['conversation.input.left', 'dsh-plugin-coordinator/start-coordinating', 30],
        ['conversation.chat.turnTail', 'dsh-plugin-coordinator/thread-cards', 30],
        ['conversation.chat.node', 'turn-trigger', null],
        ['sidebar.session.row.leading', 'dsh-plugin-coordinator/thread-mark', 20],
        ['sidebar.workspaces.session.row.action', 'dsh-plugin-coordinator/row-place', 900],
        ['conversation.input.dock', 'dsh-plugin-coordinator/paused-bar', 15],
        ['conversation.input.dock', 'dsh-plugin-coordinator/ending-bar', 16],
        ['sidebar.session.row.hover', 'dsh-plugin-coordinator/thread-hover', 20],
        ['sidebar.workspaces.session.menu.item', 'dsh-plugin-coordinator/full-view-item', 50],
        ['shell.overlay', 'dsh-plugin-coordinator/news-notice', null],
        ['shell.overlay', 'dsh-plugin-coordinator/session-list', null],
        ['sidebar.right.pane.tab', 'dsh-plugin-coordinator/thread-chat', null],
        ['sidebar.right.pane.tab.title', 'dsh-plugin-coordinator/thread-chat', null],
        ['projects.thread.conversation', null, null],
        ['sidebar.right.pane.tab', 'dsh-plugin-coordinator/threads-pane', null],
        ['sidebar.right.pane.tab', 'dsh-plugin-coordinator/thread-link', null],
        ['sidebar.right.pane.tab', 'dsh-plugin-coordinator/thread-changes', null],
        ['sidebar.right.pane.tab.title', 'dsh-plugin-coordinator/thread-changes', null],
    ]);
    // The thread chat tab hosts the conversation slot it renders.
    const chatTab = registered.find((r) => r.name === 'sidebar.right.pane.tab' && r.key === 'dsh-plugin-coordinator/thread-chat');
    assert.deepEqual(plain(chatTab.children), { 'projects.thread.conversation': { kind: 'single', scope: 'session' } });
    assert.deepEqual(protocols, ['projectthread']);
    assert.deepEqual(types.map((t) => [t.id, t.kind, t.patterns ? [...t.patterns] : null]), [
        ['dsh-plugin-coordinator/thread-chat', 'projectthread', ['dsh-resource://projectthread/session/**']],
        ['dsh-plugin-coordinator/threads-pane', 'projectthreads', null],
        ['dsh-plugin-coordinator/thread-link', 'projectthreadlink', ['dsh-resource://file/session/**/.dsh-thread/*', 'dsh-resource://file/session/*/.t*']],
        ['dsh-plugin-coordinator/thread-changes', 'projectchanges', ['dsh-resource://projectchanges/session/**']],
    ]);
    const [chat, pane, link, changes] = types;
    assert.equal(chat.canOpen('dsh-resource://projectthread/session/s%2F1'), true);
    assert.equal(chat.canOpen('dsh-resource://projectthread/other/s1'), false);
    assert.equal(chat.title('dsh-resource://projectthread/session/s1'), 'Thread');
    assert.equal(pane.title(), 'Threads');
    // `[title](.dsh-thread/t3)` in a reply opens the thread, not DSH's file viewer.
    assert.equal(link.canOpen('dsh-resource://file/session/s%2F1/.dsh-thread/t3'), true);
    assert.equal(link.canOpen('dsh-resource://file/session/s1/.dsh-thread/notes.md'), false);
    assert.equal(link.title('dsh-resource://file/session/s1/.dsh-thread/T12'), 'Thread t12');
    // So does the short `[title](.t3)`; a file whose name only starts with `.t` stays DSH's.
    assert.equal(link.canOpen('dsh-resource://file/session/s%2F1/.t3'), true);
    assert.equal(link.title('dsh-resource://file/session/s1/.t12'), 'Thread t12');
    for (const name of ['.tmp', '.tool-versions', '.t', '.t3x', '.t3.md', '.T3', 'docs/.t3']) {
        assert.equal(link.canOpen(`dsh-resource://file/session/s1/${name}`), false, name);
    }
    assert.equal(link.priority, undefined, 'the extension band ranks above the builtin file viewer');
    // A thread's Changes tab, addressed by its session.
    assert.equal(changes.canOpen('dsh-resource://projectchanges/session/s%2F1'), true);
    assert.equal(changes.canOpen('dsh-resource://projectchanges/session/'), false);
    assert.equal(changes.canOpen('dsh-resource://projectthread/session/s1'), false);
    assert.equal(changes.title('dsh-resource://projectchanges/session/s1'), 'Changes · Thread');
});

test('browser half: Thread settings opens per session, calls the plugin\'s endpoints and reads models as DSH does', async () => {
    const { client } = loadClient();
    const { settingsDialog, hostLink, errorText, noteText, catalogView, resolveRoute, effortNote, liveNote } = client.internals;
    // The dialog opens only once its part is running, and closes when that part stops.
    const dialog = settingsDialog();
    let changes = 0;
    dialog.subscribe(() => { changes += 1; });
    dialog.open('s1');
    assert.equal(dialog.getSnapshot().target, null);
    const disconnect = dialog.connect();
    dialog.open('s1');
    assert.deepEqual(plain(dialog.getSnapshot()), { target: 's1', seq: 1, available: true, pick: null });
    dialog.open('s1', { pick: 'thread' });
    assert.deepEqual(plain(dialog.getSnapshot()), { target: 's1', seq: 2, available: true, pick: 'thread' }, 'opening again starts fresh, here with the New threads menu open');
    dialog.open('s1', { pick: 'nope' });
    assert.equal(dialog.getSnapshot().pick, null);
    // A coordinating chat runs on the user's own model, so there is no coordinator menu to open.
    dialog.open('s1', { pick: 'coordinator' });
    assert.equal(dialog.getSnapshot().pick, null);
    dialog.close();
    dialog.open('');
    assert.equal(dialog.getSnapshot().target, null);
    disconnect();
    assert.deepEqual(plain(dialog.getSnapshot()), { target: null, seq: 4, available: false, pick: null });
    assert.equal(changes, 7);

    // Calls go over the window's connection to /api/dsh-plugin-coordinator/<method>.
    const sent = [];
    let reply = { ok: true, value: { project: { id: 'p' } } };
    const link = hostLink(() => ({ rpc: { call: async (channel, endpoint, payload) => { sent.push([channel, endpoint, payload]); if (reply instanceof Error) throw reply; return reply; } } }));
    assert.deepEqual(plain(await link.call('describe', { target: 's1' })), { ok: true, value: { project: { id: 'p' } } });
    assert.deepEqual(plain(sent), [['/api', 'dsh-plugin-coordinator/describe', { args: { target: 's1' } }]]);
    reply = { ok: false, error: { code: 'coordinator/refused', message: 'effort "ultra" is not offered by a:b. Choose one of: off, high' } };
    const refused = await link.call('update', { target: 's1', changes: {} });
    assert.equal(errorText(refused.error), 'Effort "ultra" is not offered by a:b. Choose one of: off, high.');
    reply = new Error('transport failure for /api/dsh-plugin-coordinator/update: HTTP 404');
    assert.match(errorText((await link.call('update', {})).error), /didn't answer\. If it was just updated, restart DSH/);
    reply = 'garbage';
    assert.equal((await link.call('describe', {})).error.code, 'projects/unreadable');
    // Before DSH has given the window its connection, a call says the plugin can't be reached.
    const early = await hostLink(() => undefined).call('list', {});
    assert.equal(early.error.code, 'projects/unreachable');
    assert.match(errorText(early.error), /didn't answer/);

    // Only the notes that change what the user sees are shown.
    // Efforts a model can't use show on the row, so the notes about them are not repeated.
    assert.equal(noteText(['Threads: other:big has no effort levels, so effort "high" is not used.']), '');
    assert.equal(noteText(['t1: route a:b · effort high from the next request.']), '');
    assert.equal(noteText(['t1: route a:b · effort default from the next request; but the model could not be set, so it keeps its current one (details in the projects log).']),
        'The model could not be set, so it keeps its current one (details in the projects log).');

    // What a setting runs on, named as DSH's picker names it.
    const catalog = {
        default: { provider: 'deepseek-account', model: 'deepseek-v4', reasoningEffort: 'low' },
        groups: [
            { id: 'other', name: 'Other', models: [{ id: 'big-model', name: 'Big' }] },
            { id: 'deepseek-account', name: 'DeepSeek', models: [
                { id: 'deepseek-v4', name: 'V4', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' } },
                { id: 'deepseek-v4-flash', name: 'V4 Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }] } },
            ] },
        ],
    };
    const cv = catalogView(catalog);
    assert.deepEqual(plain(cv.groups.map((g) => g.provider)), ['deepseek-account', 'other'], 'DSH\'s own account comes first');
    const shown = (model, effort, view = cv) => { const r = resolveRoute(view, model, effort); return [r.name, r.effortName ?? null]; };
    assert.deepEqual(shown(undefined, undefined), ['V4', 'Low'], 'nothing set: the DSH default selection');
    assert.deepEqual(shown('deepseek-account:deepseek-v4', undefined), ['V4', 'Max'], 'a model set: its own default effort');
    assert.deepEqual(shown('deepseek-v4', 'low'), ['V4', 'Low']);
    assert.deepEqual(shown('other:big-model', 'max'), ['Big', null], 'a model without efforts shows none');
    assert.deepEqual(shown('deepseek-account:deepseek-v4-flash', undefined), ['V4 Flash', 'Default'], 'a model without a default effort: the provider\'s');
    assert.deepEqual(shown('deepseek:deepseek-v4-pro', 'max', catalogView(undefined)), ['deepseek-v4-pro', 'max'], 'before the catalog arrives, the stored values');
    assert.equal(noteText(['Threads: deepseek:deepseek-v4-flash doesn\'t offer effort "max", so it runs at "high".']), '');

    // An effort the model lacks shows what runs, as the plugin fits it, and says why.
    const note = (model, effort) => effortNote(cv, resolveRoute(cv, model, effort)) ?? null;
    assert.deepEqual(shown('deepseek-account:deepseek-v4-flash', 'max'), ['V4 Flash', 'Off'], 'max on a model with only off runs at off');
    assert.equal(note('deepseek-account:deepseek-v4-flash', 'max'), 'V4 Flash doesn\'t offer Max, so it runs at Off.');
    assert.equal(note('other:big-model', 'low'), 'Big has no effort levels, so Low isn\'t used.');
    assert.equal(effortNote(cv, resolveRoute(cv, 'other:big-model', 'low'), false) ?? null, null, 'an inherited effort on a model without levels goes unsaid');
    assert.match(effortNote(cv, resolveRoute(cv, 'deepseek-account:deepseek-v4-flash', 'max'), false), /runs at Off/, 'a fitted one is said even when inherited');
    assert.equal(note('deepseek-account:deepseek-v4', 'low'), null);
    assert.equal(note('other:big-model', undefined), null);
    assert.deepEqual(shown('deepseek-account:deepseek-v4', 'medium'), ['V4', 'Max'], 'an effort no model offers runs at the model\'s default');
    // What a loaded session really runs, when it differs from its setting.
    const live = (model, effort, running) => liveNote(cv, resolveRoute(cv, model, effort), running) ?? null;
    assert.equal(live(undefined, undefined, { provider: 'deepseek-account', model: 'deepseek-v4', reasoningEffort: 'low' }), null);
    assert.equal(live(undefined, undefined, { provider: 'deepseek-account', model: 'deepseek-v4-flash', reasoningEffort: 'off' }), 'It runs on V4 Flash · Off right now.');
    assert.equal(live('deepseek-account:deepseek-v4', 'max', { provider: 'deepseek-account', model: 'deepseek-v4', reasoningEffort: 'low' }), 'It runs on V4 · Low right now.');
    assert.equal(live('deepseek-account:deepseek-v4', 'max', null), null);
    assert.equal(live('other:big-model', undefined, { provider: 'other', model: 'big-model' }), null);
});

test('browser half: rows, cards and Thread settings name what each session runs on, as DSH\'s model menu does', () => {
    const { client } = loadClient();
    const { selectionIn, selectionText, summaryModels, sourceLine, toldText, catalogView } = client.internals;
    const cv = catalogView({
        default: { provider: 'deepseek-account', model: 'deepseek-v4', reasoningEffort: 'low' },
        groups: [
            { id: 'other', name: 'Other', models: [{ id: 'big-model', name: 'Big' }] },
            { id: 'deepseek-account', name: 'DeepSeek', models: [
                { id: 'deepseek-v4', name: 'V4', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' } },
                { id: 'deepseek-v4-flash', name: 'V4 Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }] } },
            ] },
        ],
    });
    // DSH's own modelSelection projection: the next request's selection, else the last one used.
    const picked = { provider: 'deepseek-account', model: 'deepseek-v4', reasoningEffort: 'low' };
    const state = {
        byId: { a: { projectionValues: { modelSelection: { lastUsed: { provider: 'other', model: 'big-model' }, next: picked } } } },
        projectionsBySession: {
            b: { values: { modelSelection: { lastUsed: { provider: 'other', model: 'big-model' }, next: null } } },
            c: { values: { modelSelection: { lastUsed: null, next: null } } },
        },
    };
    assert.deepEqual(plain(selectionIn(state, 'a')), picked);
    assert.deepEqual(plain(selectionIn(state, 'b')), { provider: 'other', model: 'big-model' });
    assert.equal(selectionIn(state, 'c'), undefined);
    assert.equal(selectionIn(state, 'nope'), undefined);
    // Named as DSH's composer names them.
    assert.equal(selectionText(cv, picked), 'V4 · Low');
    assert.equal(selectionText(cv, { provider: 'deepseek-account', model: 'deepseek-v4' }), 'V4 · Max', 'no effort: the model\'s default');
    assert.equal(selectionText(cv, { provider: 'deepseek-account', model: 'deepseek-v4-flash' }), 'V4 Flash · Default', 'no default either: the provider\'s');
    assert.equal(selectionText(cv, { provider: 'other', model: 'big-model', reasoningEffort: 'high' }), 'Big', 'a model without levels shows none');
    assert.equal(selectionText(catalogView(undefined), { provider: 'x', model: 'm1', reasoningEffort: 'high' }), 'm1 · High', 'before the catalog arrives');
    assert.equal(selectionText(cv, undefined), undefined);
    // The menu's summary: what new threads start on; the coordinating chat runs on the user's own pick.
    const info = { settings: { threadModel: { value: 'other:big-model', source: 'chat setting' }, threadEffort: { value: 'high', source: 'plugin default' } } };
    assert.deepEqual(plain(summaryModels(cv, info)), { thread: 'Big' });
    assert.deepEqual(plain(summaryModels(cv, { settings: { threadModel: { value: null, source: 'DSH default' }, threadEffort: { value: 'max', source: 'plugin default' } } })), { thread: 'V4 · Max' });
    assert.deepEqual(plain(summaryModels(cv, null)), {});
    // Where a chat's thread setting comes from, in Thread settings.
    assert.equal(sourceLine({ value: 'a:b', source: 'chat setting' }, { value: 'max', source: 'chat setting' }), 'Set for this chat');
    assert.equal(sourceLine({ value: 'a:b', source: 'plugin default' }, { value: 'max', source: 'chat setting' }), 'Model from Default models · effort set for this chat');
    assert.equal(sourceLine({ value: null, source: 'DSH default' }, { value: 'max', source: 'plugin default' }), 'Model follows DSH · effort from Default models');
    assert.equal(sourceLine({ value: null, source: 'DSH default' }, { value: null, source: 'DSH default' }), 'Follows DSH\'s default model');
    assert.equal(sourceLine({ value: null, source: 'DSH default' }, { value: null, source: 'DSH default' }, { long: true }), 'Follows DSH\'s default model, the one last picked in any DSH chat');
    assert.equal(sourceLine({ value: 'a:b', source: 'chat setting' }, { value: null, source: 'DSH default' }), 'Set for this chat', 'an effort set nowhere is the model\'s own');
    // Sources of the older plugin are not named.
    assert.equal(sourceLine({ value: 'a:b', source: 'project setting' }), '');
    // A handback that starts with its own state doesn't say it twice.
    assert.equal(toldText({ status: 'blocked', summary: 'Blocked: the token expired.' }), 'Blocked: the token expired.');
    assert.equal(toldText({ status: 'done', summary: 'done.' }), 'done.');
    assert.equal(toldText({ status: 'done', summary: 'Doneness checks pass.' }), 'Done · Doneness checks pass.');
    assert.equal(toldText({ status: 'needs_decision', summary: 'Pick A or B.' }), 'Needs your decision · Pick A or B.');
    assert.equal(toldText({ status: 'progress' }), 'Progress update');
});

test('browser half: Thread settings holds this chat\'s pause, new threads\' model and access, and its threads, with no coordinator or goal, and says which are set for this chat', async () => {
    const { client, react } = loadClient({ primitives: { Modal: 'Modal', Switch: 'Switch' } });
    const { ThreadSettings, Section, SettingRow } = client.internals;
    const permissions = { defaultPreset: 'danger-full-access', options: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'Workspace Write' }] };
    // describe's answer for a coordinating chat: each setting with where it comes from, and what it would be without this chat's own.
    const described = {
        project: { id: 'c', name: 'Shop', workspace: '/work/shop', homeFolder: false, coordinator: 'c', archived: false, off: false },
        settings: {
            threadModel: { value: 'deepseek-account:deepseek-v4', source: 'chat setting', inherited: { value: null, source: 'DSH default' } },
            threadEffort: { value: 'max', source: 'plugin default', inherited: { value: 'max', source: 'plugin default' } },
        },
        access: {
            yourTools: { value: 'always', source: 'chat setting', inherited: { value: 'asked', source: 'plugin default' } },
            threadPermission: { value: 'workspace-write', source: 'plugin default', inherited: { value: 'workspace-write', source: 'plugin default' } },
        },
        guarded: ['lane-catalog'], permissions,
        paused: { value: false, source: 'chat setting', inherited: false, held: 0 },
        threads: [{ id: 't1', session: 's-t1', title: 'Deploy', resolved: false, model: 'deepseek-account:deepseek-v4', effort: 'max', permission: 'workspace-write', tools: [] }],
    };
    const calls = [];
    const link = {
        catalog: { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', value: undefined }), load: () => {} },
        async call(method, args) { calls.push([method, plain(args)]); return { ok: true, value: described }; },
    };
    const put = [];
    // State and refs hold between draws; the effects run once, after the first draw, as when the dialog opens, and are undone when it closes.
    const refs = [];
    const undo = [];
    let opened = false;
    const draw = mount(react, () => {
        let at = 0;
        const effects = [];
        react.useRef = (init) => {
            const k = at++;
            if (!(k in refs)) refs[k] = { current: init };
            return refs[k];
        };
        react.useEffect = (fn) => { effects.push(fn); };
        const out = ThreadSettings({ target: 'c', pick: null, link, facts: { put: (target) => put.push(target) }, dialog: { close() {} }, openDefaults: () => true, useSessionStatus: (select) => select(new Map()) });
        if (!opened) {
            opened = true;
            for (const fn of effects) { const done = fn(); if (typeof done === 'function') undo.push(done); }
        }
        return out;
    });
    try {
        draw();
        await tick();
        const tree = draw();
        assert.deepEqual(plain([calls[0], put]), [['describe', { target: 'c' }], ['c']]);
        // Titled for threads, with the chat's name and folder under it.
        const sub = tree.props.description;
        assert.deepEqual(plain([tree.type, tree.props.title, sub.props['data-projects-settings'], textIn(sub.children[0]), byClass(sub, 'dshp-ps-path').map((e) => [e.props.title, textIn(e)])]),
            ['Modal', 'Thread settings', 'c', 'Shop', [['/work/shop', 'shop']]]);
        // This chat's pause, the model new threads start on, their access, and each thread: no coordinator's model, no goal.
        const all = elementsOf(tree);
        assert.deepEqual(plain(all.filter((e) => e.type === Section).map((e) => [e.props.id, e.props.heading])),
            [['project', 'This chat'], ['models', 'Models'], ['access', 'Access'], ['threads', 'Threads']]);
        const rows = all.filter((e) => e.type === SettingRow);
        assert.deepEqual(plain(rows.map((e) => [e.props.id, e.props.title])),
            [['paused', 'Pause threads'], ['thread', 'New threads'], ['yourTools', 'Your tools'], ['threadPermission', 'New threads\' permission'], ['thread:t1', 'Deploy']]);
        // Set for this chat, with the way back to the default; or where the value comes from.
        const row = (id) => rows.find((e) => e.props.id === id).props;
        assert.deepEqual(plain(['thread', 'yourTools', 'threadPermission'].map((id) => textIn(row(id).source))), ['Set for this chatUse default', 'Set for this chatUse default', 'From Default access']);
        // The pickers' Default rows name what the chat would follow without its own.
        const picker = row('thread').control.props;
        assert.deepEqual(plain([picker.own, picker.fallback.modelLabel, picker.fallback.effortLabel]), [{ model: true, effort: false }, 'DSH default', 'Default models']);
        assert.equal(row('threadPermission').control.props.fallback.label, 'Default access');
        // Nothing in it speaks of a project, a coordinator or a goal.
        const words = [textIn(tree), ...rows.map((e) => textIn(SettingRow(e.props))), ...all.filter((e) => e.type === Section).map((e) => textIn(Section(e.props)))].join(' ');
        assert.doesNotMatch(words, /project|coordinator|goal|◆/i);
        assert.match(words, /Defaults for all chats/);

        // Use default sends only what this chat set; the pause goes to the plugin as it changes.
        calls.length = 0;
        row('thread').source[1].props.onClick();
        await tick();
        elementsOf(draw()).find((e) => e.type === SettingRow && e.props.id === 'paused').props.control.props.onChange(true);
        await tick();
        assert.deepEqual(calls, [['update', { target: 'c', changes: { threadModel: null } }], ['update', { target: 'c', changes: { paused: true } }]]);
    } finally {
        for (const done of undo) done();
    }
});

test('browser half: New threads follows DSH\'s default after a pick in any chat; a row names a model the menu already names only on hover', async () => {
    const { client } = loadClient();
    const { catalogSource, picksIn, followDefault, ThreadRow } = client.internals;
    // DSH saves a composer pick as its default in the background, so the catalog is read again.
    let def = { provider: 'p', model: 'old' };
    let reads = 0;
    let answer;
    const remote = { session: { modelCatalog: () => { reads += 1; return new Promise((resolve) => { answer = () => resolve({ ok: true, value: { default: def, groups: [] } }); }); } } };
    const catalog = catalogSource(() => remote);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    catalog.ensure();
    await tick();
    assert.equal(reads, 1);
    // A reload asked for mid-read waits for that read, then reads once more.
    catalog.reload();
    catalog.reload();
    await tick();
    assert.equal(reads, 1);
    def = { provider: 'p', model: 'new' };
    answer();
    await tick();
    assert.equal(reads, 2);
    assert.equal(catalog.getSnapshot().status, 'loading');
    answer();
    await tick();
    assert.deepEqual(plain([catalog.getSnapshot().status, catalog.getSnapshot().value.default.model, reads]), ['ready', 'new', 2]);

    // Picks per loaded session; one DSH has not sent is left out.
    const pick = (model, effort) => ({ lastUsed: null, next: { provider: 'p', model, ...(effort ? { reasoningEffort: effort } : {}) } });
    let state = {
        byId: { a: {}, b: {}, cold: {} },
        projectionsBySession: { a: { values: { modelSelection: pick('m1', 'high') } }, b: { values: { modelSelection: { lastUsed: null, next: null } } } },
    };
    assert.deepEqual(plain([...picksIn(state)]), [['a', 'p:m1:high'], ['b', '']]);
    const listeners = new Set();
    const sessions = { list: { getSnapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } } };
    const frames = [];
    const timers = [];
    const fake = { reloads: 0, status: 'idle', value: { default: { provider: 'p', model: 'm1', reasoningEffort: 'high' } } };
    const watched = { reload: () => { fake.reloads += 1; }, getSnapshot: () => ({ status: fake.status, value: fake.value }) };
    const stop = followDefault(sessions, watched, {
        frame: (fn) => frames.push(fn), cancel: () => {}, later: (fn, ms) => (timers.push({ fn, ms }), timers.length), clear: () => {},
    });
    const emit = (next) => { state = next; for (const fn of listeners) fn(); while (frames.length) frames.shift()(); };
    // While nothing has read the catalog, a pick leaves it for the first view that needs it.
    emit({ ...state, projectionsBySession: { ...state.projectionsBySession, a: { values: { modelSelection: pick('m1', 'max') } } } });
    emit({ ...state, projectionsBySession: { ...state.projectionsBySession, a: { values: { modelSelection: pick('m1', 'high') } } } });
    assert.deepEqual([fake.reloads, timers.length], [0, 0]);
    fake.status = 'ready';
    // A session DSH sends for the first time is not a pick.
    emit({ ...state, projectionsBySession: { ...state.projectionsBySession, cold: { values: { modelSelection: pick('m9') } } } });
    assert.equal(fake.reloads, 0);
    // A pick in a session that had none (a new chat), then a changed pick: each reads the catalog again.
    emit({ ...state, projectionsBySession: { ...state.projectionsBySession, b: { values: { modelSelection: pick('m2') } } } });
    assert.equal(fake.reloads, 1);
    // The save had not landed by the first read: more reads a moment later, while the catalog names another default.
    assert.deepEqual(timers.map((x) => x.ms), [300]);
    timers.at(-1).fn();
    assert.deepEqual([fake.reloads, ...timers.map((x) => x.ms)], [2, 300, 700]);
    timers.at(-1).fn();
    timers.at(-1).fn();
    assert.deepEqual([fake.reloads, ...timers.map((x) => x.ms)], [4, 300, 700, 1500], 'at most three more reads');
    // A changed effort is a pick too; once a read names it, no more reads.
    timers.length = 0;
    emit({ ...state, projectionsBySession: { ...state.projectionsBySession, a: { values: { modelSelection: pick('m1', 'low') } } } });
    assert.equal(fake.reloads, 5);
    fake.value = { default: { provider: 'p', model: 'm1', reasoningEffort: 'low' } };
    timers.at(-1).fn();
    assert.deepEqual([fake.reloads, timers.length], [5, 1]);
    // Changes that are not picks: a turn using the pick, an unrelated session update.
    emit({ ...state, byId: { ...state.byId, a: { title: 'renamed' } } });
    emit({ ...state, projectionsBySession: { ...state.projectionsBySession, a: { values: { modelSelection: { lastUsed: pick('m1', 'low').next, next: pick('m1', 'low').next } } } } });
    assert.equal(fake.reloads, 5);
    stop();
    assert.equal(listeners.size, 0);

    // The menu names New threads' model at its top, so a row on the same model names it in a tooltip only.
    const row = { id: 't1', title: 'Fix login', line: 'Running', dot: 'ongoing', session: 's1' };
    const bodyOf = (el) => (el.props.className === 'dshp-t-row' ? el : el.children[0]);
    const mainOf = (el) => bodyOf(el).children.find((c) => c?.props?.className === 'dshp-t-main');
    const meta = (props) => {
        const text = mainOf(ThreadRow({ row, now: 0, onOpen() {}, ...props })).children.find((c) => c?.props?.className === 'dshp-t-text');
        const second = text.children.find((c) => c?.props?.className === 'dshp-t-second');
        return second.children.find((c) => c?.props?.className === 'dshp-t-meta');
    };
    const modelOf = (props) => meta(props).children.find((c) => c?.props?.className === 'dshp-t-model');
    const quiet = ThreadRow({ row, now: 0, model: 'V4 · High', quietModel: 'V4 · High', onOpen() {} });
    assert.deepEqual(plain([quiet.props.label, quiet.props.delayMs > 0, bodyOf(quiet).props['data-projects-runs-on'], mainOf(quiet).props['aria-label']]),
        ['Runs on V4 · High', true, 'V4 · High', 'Fix login. Running. Runs on V4 · High']);
    assert.equal(modelOf({ model: 'V4 · High', quietModel: 'V4 · High' }), undefined);
    assert.equal(modelOf({ model: 'V4 · Low', quietModel: 'V4 · High' }).children[0], 'V4 · Low');
    assert.equal(ThreadRow({ row, now: 0, model: 'V4 · Low', quietModel: 'V4 · High', onOpen() {} }).props.className, 'dshp-t-row', 'no tooltip when the row shows its model');
    assert.equal(modelOf({}), undefined);
    // The code changes sit on the second line with the model and the time, not beside the name.
    const counted = meta({ changes: { added: 18, deleted: 3, files: 2 }, model: 'V4 · Low' }).children.filter(Boolean).map((c) => c.props.className);
    assert.deepEqual(counted, ['dshp-t-row-changes', 'dshp-t-model']);

    // No control sits inside another: the row's open button holds its text, and Retry and its ⋯ are the button's siblings.
    const opened = [];
    const action = { label: 'Open beside', icon: () => null, run() {} };
    const failed = ThreadRow({ row: { ...row, ending: { state: 'failed' } }, now: 0, onOpen: (r) => opened.push(r.id), action, projects: {}, slots: 2 });
    const main = mainOf(failed);
    const acts = bodyOf(failed).children.find((c) => c?.props?.className === 'dshp-t-row-acts');
    assert.equal(main.type, 'button');
    assert.equal(bodyOf(failed).props.role, undefined, 'the row itself is no button');
    assert.deepEqual(elementsOf(main.children).filter((e) => e.type === 'button' || e.props?.['aria-label'] !== undefined), [], 'nothing pressable inside the open button');
    assert.equal(acts.children.length, 2, 'Retry and the ⋯ sit beside the open button');
    assert.deepEqual(plain([main.props['data-dshp-item'], main.props.tabIndex, bodyOf(failed).props['data-acts'], bodyOf(failed).props.style]), ['', 0, '', { '--dshp-t-acts': '56px' }]);
    main.props.onClick();
    assert.deepEqual(opened, ['t1']);
    // The current chat's row: read out as current, left out of arrow keys, and opening it does nothing.
    const here = mainOf(ThreadRow({ row, current: true, now: 0, onOpen: (r) => opened.push(r.id) }));
    assert.deepEqual(plain([here.props['aria-current'], here.props['aria-disabled'], here.props.tabIndex]), ['true', 'true', -1]);
    here.props.onClick();
    assert.deepEqual(opened, ['t1']);
    // Focusing the row itself focuses its open button.
    let focused = '';
    const rowEl = { firstElementChild: { focus: () => { focused = 'main'; } } };
    bodyOf(failed).props.onFocus({ target: rowEl, currentTarget: rowEl });
    assert.equal(focused, 'main');
});

test('browser half: a thread row\'s ⋯ holds the other way to open it, its changes, Stop, and Mark resolved or Reopen', async () => {
    const { client, react } = loadClient();
    const { ThreadRow, ThreadMore, ThreadList, threadMenuItems, rowMenuItems, runThreadItem, inMoreList } = client.internals;
    const row = { id: 't1', title: 'Fix login', line: 'Done · Fixed it', dot: 'done', session: 's1', group: 'done', running: false };
    const did = [];
    const facts = { change: async (target, changes) => { did.push(['change', target, plain(changes)]); return { ok: true, value: {} }; } };
    const projects = { facts, hasChanges: () => true, openChanges: (id) => did.push(['changes', id]) };
    const action = { label: 'Open in full view', icon: 'IconRightUpOutlineRegular', run: (r) => did.push(['full', r.session]) };
    const changes = { added: 18, deleted: 3, files: 2, turns: 2, reviewable: true, last: { seq: 9, turn: 2 } };
    const ids = (items) => plain(items.map((item) => item.id));
    // A finished thread: the other way to open it, its changes, Mark resolved.
    assert.deepEqual(plain(rowMenuItems({ row, action, changes, projects }).map((i) => [i.id, i.label])),
        [['open', 'Open in full view'], ['changes', 'See what this thread changed'], ['resolve', 'Mark resolved']]);
    // Running, with no changes yet: Stop instead, and no changes to see.
    assert.deepEqual(ids(rowMenuItems({ row: { ...row, running: true, group: 'running' }, action, projects })), ['open', 'stop']);
    // Resolved: Reopen. The chat you're in has no other way to open it.
    assert.deepEqual(ids(rowMenuItems({ row: { ...row, group: 'resolved' }, current: true, action, projects })), ['reopen']);
    // A DSH without the Changes tab offers DSH's Review, as the cards do; without the plugin to change it, only the ways to open it.
    assert.deepEqual(plain(rowMenuItems({ row, action, changes, projects: { hasChanges: () => false, openReview() {} } }).map((i) => i.label)), ['Open in full view', 'Review the latest changes']);
    // A thread with no session yet has no ⋯; its items alone (threadMenuItems) have Stop while it runs.
    assert.deepEqual(plain(rowMenuItems({ row: { ...row, session: undefined }, action, changes, projects })), []);
    assert.deepEqual(ids(threadMenuItems({ thread: { running: true, resolved: false }, live: true })), ['stop']);
    assert.deepEqual(ids(threadMenuItems({ thread: { running: false, resolved: false }, live: false })), []);

    // The row: its ⋯ sits at its end, and a right-click on the row or Shift+F10 on its button opens it.
    const draw = mount(react, () => ThreadRow({ row, now: 0, onOpen() {}, action, changes, projects, onLeave: () => did.push(['leave']) }));
    const moreOf = (el) => el.children.find((c) => c?.props?.className === 'dshp-t-row-acts').children.find((c) => c?.type === ThreadMore);
    let el = draw();
    assert.deepEqual([ids(moreOf(el).props.items), moreOf(el).props.open, el.children[0].props['aria-keyshortcuts']], [['open', 'changes', 'resolve'], false, 'Shift+F10']);
    const event = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, ...extra });
    el.props.onContextMenu(event());
    el = draw();
    assert.equal(moreOf(el).props.open, true);
    moreOf(el).props.setOpen(false);
    el = draw();
    el.children[0].props.onKeyDown(event({ key: 'F10' }));
    assert.equal(moreOf(draw()).props.open, false, 'F10 alone is DSH\'s');
    el.children[0].props.onKeyDown(event({ key: 'ContextMenu' }));
    assert.equal(moreOf(draw()).props.open, true);
    // Its items: the other way to open it, its Changes tab (the list closes first), and the change through the plugin.
    await moreOf(el).props.run('open');
    await moreOf(el).props.run('changes');
    assert.equal(await moreOf(el).props.run('resolve'), '');
    assert.deepEqual(did, [['full', 's1'], ['leave'], ['changes', 's1'], ['change', 's1', { thread: 't1', resolved: true }]]);

    // What each change sends, and the plugin's refusal or a failure as a sentence.
    did.length = 0;
    await runThreadItem('stop', { target: 'c', thread: 't2', facts });
    await runThreadItem('reopen', { target: 'c', thread: 't2', facts });
    assert.deepEqual(did, [['change', 'c', { thread: 't2', stop: true }], ['change', 'c', { thread: 't2', resolved: false }]]);
    const refusing = { change: async () => ({ ok: false, error: { code: 'coordinator/refused', message: 'the turn could not be stopped (busy)' } }) };
    assert.equal(await runThreadItem('stop', { target: 'c', thread: 't2', facts: refusing }), 'The turn could not be stopped (busy).');
    assert.equal(await runThreadItem('stop', { target: 'c', thread: 't2', facts: { change: async () => { throw new Error('gone'); } } }), 'Couldn\'t change the thread.');

    // The ⋯ itself: named for its thread, and a refusal shows on it as Retry's does.
    const drawMore = mount(react, () => ThreadMore({ title: 'Fix login', items: [{ id: 'stop', label: 'Stop' }], run: async () => 'The turn could not be stopped (busy).', open: false, setOpen() {} }));
    let menu = drawMore();
    assert.deepEqual(plain([menu.props.anchor.props['aria-label'], menu.props.anchor.props['data-projects-row-menu'], menu.props.anchor.props['aria-haspopup'], /^dshp-t-more-list dshp-menu-\d+$/.test(menu.props.listClassName), menu.props.autoFocus === true]),
        ['Thread actions: Fix login', '', 'menu', true, false]);
    // Its keys reach DSH's menu: nothing on the ⋯ stops them on their way.
    assert.equal(menu.props.anchor.props.onKeyDown, undefined);
    menu.props.onSelect('stop');
    await tick();
    menu = drawMore();
    assert.deepEqual([menu.props.anchor.props.className, menu.props.anchor.props['aria-label']], ['dshp-t-icon dshp-t-error', 'Thread actions: Fix login. The turn could not be stopped (busy).']);

    // Its list is drawn in the page's body, and the Threads menu counts a click there as its own.
    const list = { nodeType: 1, closest: (sel) => (sel === '.dshp-t-more-list' ? {} : null) };
    assert.deepEqual([inMoreList(list), inMoreList({ nodeType: 3, parentElement: list }), inMoreList({ nodeType: 1, closest: () => null }), inMoreList(null)], [true, true, false, false]);

    // Every row with a session has its ⋯, so a list keeps one button's room for it, two with Retry.
    const room = (rows) => elementsOf(ThreadList({ rows, now: 0, onOpen() {}, action, projects })).find((e) => e.type === ThreadRow).props.slots;
    assert.equal(room([row]), 1);
    assert.equal(room([row, { ...row, id: 't2', session: 's2', group: 'waiting', ending: { state: 'failed' } }]), 2);
});

test('browser half: a thread\'s ⋯ has Rename…, which renames it through the plugin in a dialog, and Model and permission…, which opens Thread settings at its row', async () => {
    const { client, react } = loadClient();
    const { ThreadRow, ThreadMore, rowMenuItems, threadMenuItems, runThreadItem, renameFlow, RenameThread, RenameOverlay, settingsDialog } = client.internals;
    const rename = renameFlow();
    const settings = settingsDialog();
    const row = { id: 't1', title: 'Fix login', line: 'Done · Fixed it', dot: 'done', session: 's1', group: 'done', running: false };
    const did = [];
    let answer = { ok: true, value: { notes: ['t1: renamed to "Sign-in fix".'] } };
    const facts = { change: async (target, changes) => { did.push(['change', target, plain(changes)]); return answer; } };
    const projects = { facts, rename, settings };
    const action = { label: 'Open in full view', icon: 'IconRightUpOutlineRegular', run: () => {} };
    const ids = (items) => plain(items.map((item) => item.id));
    // Neither shows until its dialog is drawn in this window.
    assert.deepEqual(ids(rowMenuItems({ row, action, projects })), ['open', 'resolve']);
    const offRename = rename.connect();
    const offSettings = settings.connect();
    // After the ways to open it, before Stop, Mark resolved or Reopen.
    assert.deepEqual(plain(rowMenuItems({ row, action, projects }).map((i) => [i.id, i.label, i.icon.type])), [
        ['open', 'Open in full view', 'IconRightUpOutlineRegular'], ['rename', 'Rename…', 'IconEditOutlineRegular'],
        ['thread-settings', 'Model and permission…', 'IconSlidersTwoOutlineRegular'], ['resolve', 'Mark resolved', 'IconCheckCircleOutlineRegular'],
    ]);
    assert.deepEqual(ids(rowMenuItems({ row: { ...row, running: true, group: 'running' }, action, projects })), ['open', 'rename', 'thread-settings', 'stop']);
    // Without the plugin to rename it, only its row in Thread settings.
    assert.deepEqual(ids(threadMenuItems({ thread: { running: false, resolved: false }, live: false, rename, settings })), ['thread-settings']);

    // Each opens elsewhere, so the Threads menu closes first; neither changes anything by itself.
    const left = [];
    const draw = mount(react, () => ThreadRow({ row, now: 0, onOpen() {}, action, projects, onLeave: () => left.push('leave') }));
    const moreOf = (el) => el.children.find((c) => c?.props?.className === 'dshp-t-row-acts').children.find((c) => c?.type === ThreadMore);
    assert.equal(await moreOf(draw()).props.run('rename'), '');
    assert.deepEqual(plain(rename.getSnapshot().ask), { target: 's1', thread: 't1', title: 'Fix login' });
    assert.equal(await moreOf(draw()).props.run('thread-settings'), '');
    assert.deepEqual([settings.getSnapshot().target, settings.getSnapshot().pick], ['s1', 'thread:t1']);
    assert.deepEqual([left, did], [['leave', 'leave'], []]);
    // Through the chat that started the thread, as through the thread's own session.
    rename.close();
    await runThreadItem('rename', { target: 'c', thread: 't2', title: 'Old copy', rename, settings });
    assert.deepEqual(plain(rename.getSnapshot().ask), { target: 'c', thread: 't2', title: 'Old copy' });
    // Thread settings takes a thread's own row (thread:<id>), and nothing else that looks like one.
    settings.open('c', { pick: 'thread:t2' });
    assert.equal(settings.getSnapshot().pick, 'thread:t2');
    settings.open('c', { pick: 'thread:../t2' });
    assert.equal(settings.getSnapshot().pick, null);

    // The dialog: the name now, ready to type over.
    rename.close();
    assert.equal(RenameOverlay({ flow: rename, facts }), null);
    rename.open({ target: 's1', thread: 't1', title: 'Fix login' });
    const shown = RenameOverlay({ flow: rename, facts });
    assert.equal(shown.type, RenameThread);
    const drawDialog = mount(react, () => RenameThread(shown.props));
    const input = (d) => elementsOf(d.children).find((e) => e.props?.['data-projects-rename-input'] !== undefined);
    const saveOf = (d) => elementsOf(d.props.footer).find((e) => e.props?.['data-projects-rename-save'] !== undefined);
    const submit = (d) => elementsOf(d.children).find((e) => e.type === 'form').props.onSubmit({ preventDefault() {} });
    let dialog = drawDialog();
    assert.deepEqual(plain([dialog.props.title, dialog.props.className, input(dialog).props.value, input(dialog).props['aria-label'], input(dialog).props['data-modal-autofocus'], saveOf(dialog).props.variant, textIn(saveOf(dialog))]),
        ['Rename thread', 'dshp-rn', 'Fix login', 'Thread name', '', 'primary', 'Rename']);
    // Only spaces can't be saved; the same name, spaces aside, closes it with no change.
    input(dialog).props.onChange({ target: { value: '   ' } });
    assert.equal(saveOf(drawDialog()).props.disabled, true);
    input(dialog).props.onChange({ target: { value: '  Fix   login ' } });
    submit(drawDialog());
    await tick();
    assert.deepEqual([did, rename.getSnapshot().ask], [[], null]);

    // A new name goes to the plugin with its spaces tidied; a refusal shows in the dialog, which stays open.
    rename.open({ target: 's1', thread: 't1', title: 'Fix login' });
    const again = mount(react, () => RenameThread(RenameOverlay({ flow: rename, facts }).props));
    dialog = again();
    input(dialog).props.onChange({ target: { value: '  Sign-in   fix ' } });
    answer = { ok: false, error: { code: 'coordinator/refused', message: 'no thread t1 in this chat' } };
    submit(again());
    await tick();
    dialog = again();
    const alert = byClass(dialog.children, 'dshp-ar-error')[0];
    assert.deepEqual([alert.props.role, textIn(alert), rename.getSnapshot().ask?.thread], ['alert', 'No thread t1 in this chat.', 't1']);
    // While the plugin answers: Renaming…, and nothing to press twice.
    let finish;
    facts.change = (target, changes) => { did.push(['change', target, plain(changes)]); return new Promise((resolve) => { finish = resolve; }); };
    saveOf(dialog).props.onClick();
    dialog = again();
    assert.deepEqual([saveOf(dialog).props.disabled, input(dialog).props.disabled, textIn(byClass(dialog.children, 'dshp-ar-line')[0])], [true, true, 'Renaming…']);
    finish({ ok: true, value: { notes: ['t1: renamed to "Sign-in fix".'] } });
    await tick();
    assert.deepEqual(did, [['change', 's1', { thread: 't1', title: 'Sign-in fix' }], ['change', 's1', { thread: 't1', title: 'Sign-in fix' }]]);
    assert.equal(rename.getSnapshot().ask, null, 'renamed: the dialog closes');

    // Gone from this window (its overlay unmounted): nothing opens, and the ⋯ doesn't offer it.
    offRename();
    rename.open({ target: 's1', thread: 't1', title: 'Fix login' });
    assert.equal(rename.getSnapshot().ask, null);
    assert.deepEqual(ids(rowMenuItems({ row, action, projects })), ['open', 'thread-settings', 'resolve']);
    offSettings();
    assert.deepEqual(ids(rowMenuItems({ row, action, projects })), ['open', 'resolve']);
});

test('browser half: over 8 threads, Find a thread keeps the rows whose name holds the words, resolved ones too, with the words marked', () => {
    const { client, react } = loadClient();
    const { ThreadFind, ThreadList, ThreadRow, findRows, withHit, FIND_FROM } = client.internals;
    const rows = ['Fix login', 'Hero images', 'Cart totals', 'Login copy'].map((title, i) => ({
        id: `t${i + 1}`, title, line: 'Done', dot: 'done', session: `s${i + 1}`, group: i === 3 ? 'resolved' : 'done', running: false,
    }));
    assert.equal(FIND_FROM, 8);
    assert.deepEqual(plain(findRows(rows, ' LOGIN ').map((r) => r.id)), ['t1', 't4']);
    assert.equal(findRows(rows, '  '), rows);
    // The list passes the words to its rows, and while finding the Resolved group's matches show unfolded.
    const listed = (props) => elementsOf(mount(react, () => ThreadList({ now: 0, onOpen() {}, ...props }))()).filter((e) => e.type === ThreadRow).map((e) => [e.props.row.id, e.props.find]);
    assert.deepEqual(plain(listed({ rows: findRows(rows, 'login'), find: 'login', fold: [] })), [['t1', 'login'], ['t4', 'login']]);
    // Without words, Resolved stays folded behind its count.
    assert.deepEqual(plain(listed({ rows })), [['t1', ''], ['t2', ''], ['t3', '']]);
    // A row marks the words in its name, which keeps its whole name for its label.
    const drawn = mount(react, () => ThreadRow({ row: rows[3], now: 0, onOpen() {}, find: 'login' }))();
    const name = byClass(drawn, 'dshp-t-name')[0];
    assert.deepEqual(plain([textIn(name), name.children.map((c) => (typeof c === 'string' ? c : `[${textIn(c)}]`)), byClass(name, 'dshp-t-hit').length]), ['Login copy', ['[Login]', ' copy'], 1]);
    assert.match(drawn.children[0].props['aria-label'], /^Login copy\. /);
    assert.deepEqual(plain(withHit('Fix the cart', 'CART').map((part) => (typeof part === 'string' ? part : `[${textIn(part)}]`))), ['Fix the ', '[cart]']);
    assert.deepEqual(plain(withHit('Fix', 'zz')), ['Fix']);

    // The box: one of the panel's items, so the arrows go on to the rows; Home and End stay in its words, and Escape clears them.
    const said = [];
    const inputRef = { current: { focus: () => said.push('focus') } };
    const box = (find) => ThreadFind({ find, setFind: (value) => said.push(value), inputRef });
    const inputOf = (el) => elementsOf(el).find((e) => e.props?.['data-projects-thread-find'] !== undefined);
    const clearOf = (el) => elementsOf(el).find((e) => e.props?.['data-projects-thread-find-clear'] !== undefined);
    assert.deepEqual(plain([inputOf(box('')).props.role, inputOf(box('')).props['aria-label'], inputOf(box('')).props.placeholder, inputOf(box('')).props['data-dshp-item'], inputOf(box('')).props.className, clearOf(box(''))]),
        ['searchbox', 'Find a thread', 'Find a thread', '', 'dshp-t-find-box', null]);
    inputOf(box('')).props.onChange({ target: { value: 'log' } });
    const press = (key, find) => {
        const event = { key, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
        inputOf(box(find)).props.onKeyDown(event);
        return [event.stopped, event.prevented];
    };
    assert.deepEqual([press('Home', 'log'), press('End', 'log'), press('ArrowDown', 'log'), press('ArrowUp', 'log'), press('Escape', 'log'), press('Escape', '')],
        [[true, false], [true, false], [false, false], [false, false], [true, true], [false, false]]);
    // Its × clears the words and hands the keyboard back to the box.
    assert.deepEqual([inputOf(box('log')).props.className, clearOf(box('log')).props['aria-label']], ['dshp-t-find-box dshp-t-find-query', 'Clear the find']);
    clearOf(box('log')).props.onClick();
    assert.deepEqual(said, ['log', '', '', 'focus']);
});

test('browser half: the arrows leave a row\'s open ⋯ to DSH\'s menu, and go on from a row\'s ⋯ when it is closed', () => {
    const focused = [];
    const doc = {
        activeElement: null,
        addEventListener: () => {}, removeEventListener: () => {}, createElement: () => ({ dataset: {} }), head: { appendChild: () => {} }, querySelector: () => null,
    };
    const { client } = loadClient({ document: doc });
    const { arrowKeys } = client.internals;
    const item = (name) => ({ name, focus() { focused.push(name); doc.activeElement = this; }, closest: () => null });
    const rows = [item('a'), item('b'), item('c')];
    const row = (main) => ({ contains: (node) => node === main });
    const more = (main, open) => ({ name: `${main.name}-more`, closest: (sel) => (sel === '.dshp-t-row' ? row(main) : sel === '[data-projects-row-menu][aria-expanded="true"]' && open ? {} : null) });
    const root = { querySelectorAll: () => rows };
    const press = (key, target) => {
        let prevented = false;
        doc.activeElement = target;
        arrowKeys({ key, target, preventDefault: () => { prevented = true; } }, root);
        return prevented;
    };
    // From b's ⋯ (closed), Down goes to c and Up to a, not to the list's ends.
    assert.equal(press('ArrowDown', more(rows[1], false)), true);
    assert.equal(press('ArrowUp', more(rows[1], false)), true);
    // From a row's button, as before.
    press('ArrowDown', rows[2]);
    assert.deepEqual(focused, ['c', 'a', 'a']);
    // With b's list open, the keys are DSH's menu's: nothing moves and nothing is prevented.
    assert.equal(press('ArrowDown', more(rows[1], true)), false);
    assert.deepEqual(focused, ['c', 'a', 'a']);
});

test('browser half: the Threads menu opens when the pointer moves onto its trigger, not when the header moves the trigger under a still pointer', async () => {
    const doc = { body: 'body', addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => ({}) };
    const { client, react } = loadClient({ document: doc, primitives: { useAnchoredPosition: () => null, useDismissOnOutsidePointer: () => {}, MenuSurface: 'MenuSurface' } });
    const { ThreadsMenu } = client.internals;
    const state = { projectionsBySession: { 's-c': { values: { coordinatorSession: { role: 'coordinator', project: { name: 'Shop' }, threads: [] } } } } };
    const quiet = { subscribe: () => () => {} };
    const projects = {
        facts: { ...quiet, getSnapshot: () => 0, watch: () => () => {}, paused: () => false, info: () => undefined, describe: async () => {} },
        settings: { ...quiet, getSnapshot: () => ({ available: false }) },
        catalog: { ...quiet, getSnapshot: () => ({ status: 'ready', value: undefined }), ensure: () => {} },
        refresh: () => {}, hasPane: () => false, hasChanges: () => false,
    };
    // State and refs hold between draws, as React's do; effects don't run.
    const refs = [];
    const draw = mount(react, () => {
        let at = 0;
        react.useRef = (init) => {
            const k = at++;
            if (!(k in refs)) refs[k] = { current: init };
            return refs[k];
        };
        return ThreadsMenu({ sessionId: 's-c', useSessions: (select) => select(state), useSessionStatus: (select) => select(new Map()), projects });
    });
    const shown = () => {
        const tree = draw();
        const all = elementsOf(tree);
        const trigger = all.find((e) => e.props?.['data-projects-threads-trigger'] === '').props;
        const menu = all.find((e) => e.props?.['data-projects-threads-menu'] === '')?.props;
        return { root: tree.props, trigger, menu, open: trigger['aria-expanded'] };
    };
    const later = () => new Promise((r) => setTimeout(r, 200));
    // What the browser sends the trigger, in its order, to whichever of these the trigger listens to.
    const send = (props, ...events) => { for (const [name, event] of events) props[name]?.(event); };
    const mouse = (x, y) => ({ pointerType: 'mouse', movementX: x, movementY: y });
    const enter = [['onPointerEnter', mouse(0, 0)], ['onMouseEnter', {}]];
    const move = (x, y) => [['onPointerMove', mouse(x, y)], ['onMouseMove', {}]];
    let at = shown();
    assert.equal(at.open, false);

    // Opening the Changes tab from the pill re-flows the header and puts the trigger under the pointer, which
    // doesn't move: the browser says the pointer came in, and no more. The menu stays closed.
    send(at.trigger, ...enter);
    await later();
    at = shown();
    assert.deepEqual([at.open, at.menu], [false, undefined]);
    // A move of nothing (as a browser may send after a re-flow), or a finger's: still closed.
    send(at.trigger, ...move(0, 0), ['onPointerMove', { pointerType: 'touch', movementX: 6, movementY: 2 }]);
    await later();
    at = shown();
    assert.equal(at.open, false);
    // The pointer moves there: it opens, a moment later.
    send(at.trigger, ...move(3, -1));
    assert.equal(shown().open, false);
    await later();
    at = shown();
    assert.equal(at.open, true);
    assert.equal(at.menu.role, 'dialog');

    // From the open menu back onto the trigger (the menu's leave comes between the pointer's and the mouse's
    // enter), it stays open.
    send(at.trigger, enter[0]);
    at.menu.onMouseLeave({});
    send(at.trigger, enter[1], ...move(-2, 0));
    await later();
    at = shown();
    assert.equal(at.open, true);
    // Out of the header, it closes; a move on the trigger after that (still there once Escape closed it, say)
    // doesn't open it again until the pointer comes onto it anew.
    at.root.onMouseLeave({});
    await later();
    at = shown();
    assert.equal(at.open, false);
    send(at.trigger, ...move(2, 2));
    await later();
    assert.equal(shown().open, false);
    // Passing over the trigger and out of the header doesn't open it.
    send(at.trigger, ...enter, ...move(4, 0));
    at.root.onMouseLeave({});
    await later();
    assert.equal(shown().open, false);
    // Coming onto it and moving there, it opens.
    send(at.trigger, ...enter, ...move(1, 0));
    await later();
    assert.equal(shown().open, true);
});

test('browser half: Coordinate shows in the header of a plain top-level chat that isn\'t coordinating, and makes it coordinate', async () => {
    const Toast = () => null;
    const { client, react } = loadClient({ primitives: { Tooltip: 'Tooltip', Toast } });
    const { CoordinateAction, canCoordinate, takeKnown, projectFacts } = client.internals;
    const thread = { role: 'thread', project: { id: 'c', name: 'Shop' }, coordinator: 'c', thread: { id: 't1' } };
    const coordinating = (id, more) => ({ role: 'coordinator', project: { id, name: 'Shop' }, threads: [], ...more });
    const state = {
        byId: {
            p: { id: 'p', title: 'Pricing' },
            n: { id: 'n', title: 'Notes', projectionValues: { coordinatorSession: coordinating('n', { off: true }) } },
            c: { id: 'c', title: 'Shop', projectionValues: { coordinatorSession: coordinating('c') } },
            t: { id: 't', title: 'Fix login', projectionValues: { coordinatorSession: thread } },
            sa: { id: 'sa', title: 'Explore the code', parentId: 'p', origin: 'subagent' },
            sb: { id: 'sb', title: 'Review', origin: 'subagent' },
            f: { id: 'f', title: 'Pricing, another way', parentSessionId: 'p' },
            old: { id: 'old', title: 'Storefront' },
            cold: { id: 'cold', title: 'Not read yet' },
        },
        projectionsBySession: { cold: { state: 'loading', values: {} } },
    };
    takeKnown({ old: { role: 'coordinator', project: 'old', name: 'Storefront' } });
    // A plain chat of the user's own, or one that stopped coordinating; not a thread, a subagent's session, a chat that
    // coordinates, one the plugin's store knows as either, or one whose value DSH is still reading.
    // A chat the user forked (DSH lists it under its source, with no origin) is theirs, so it can coordinate.
    assert.deepEqual(['p', 'n', 'c', 't', 'sa', 'sb', 'f', 'old', 'cold', 'missing'].map((id) => canCoordinate(state, id)),
        [true, true, false, false, false, false, true, false, false, false]);

    const calls = [];
    const refreshed = [];
    let answer;
    const link = {
        async call(method, args) {
            calls.push([method, plain(args)]);
            await null;
            // As the plugin does: once it answers, the chat's value says it coordinates.
            if (answer.ok && args.on) state.byId[args.target] = { ...state.byId[args.target], projectionValues: { coordinatorSession: coordinating(args.target) } };
            return answer;
        },
    };
    const projects = { facts: projectFacts(link), refresh: (id, now) => refreshed.push([id, now]) };
    const draw = (sessionId) => mount(react, () => CoordinateAction({ sessionId, useSessions: (select) => select(state), projects }));
    const buttonOf = (tree) => elementsOf(tree).find((e) => e.props?.['data-projects-coordinate-button'] !== undefined);
    const toastOf = (tree) => elementsOf(tree).find((e) => e.type === Toast);
    for (const id of ['c', 't', 'sa', 'old', 'cold']) assert.equal(draw(id)(), null, id);

    // The button names what it does; its tooltip says why.
    const chat = draw('p');
    let tree = chat();
    const tip = elementsOf(tree).find((e) => e.type === 'Tooltip');
    assert.deepEqual(plain([textIn(tree), buttonOf(tree).props['aria-label'], buttonOf(tree).props['aria-description'], tip.props.label]),
        ['Coordinate', 'Coordinate', 'Run work from this chat in threads that report back here', 'Run work from this chat in threads that report back here']);
    // A click asks the plugin to make this session coordinate, and reads its value again at once; while it asks, nothing to press twice.
    answer = { ok: true, value: { coordinating: true, session: 'p', text: 'This chat now runs work in threads.', projects: [{ id: 'p', coordinator: 'p', paused: false }] } };
    buttonOf(tree).props.onClick();
    assert.equal(buttonOf(chat()).props.disabled, true);
    await tick();
    assert.deepEqual(calls, [['coordinate', { target: 'p', on: true }]]);
    assert.deepEqual(refreshed, [['p', true]]);
    // Coordinating now: the button leaves the header, and what the plugin said shows as DSH's banner.
    tree = chat();
    assert.equal(buttonOf(tree), undefined);
    assert.deepEqual(plain([toastOf(tree).props.text, toastOf(tree).props.tone]), ['This chat now runs work in threads.', 'success']);
    assert.equal(canCoordinate(state, 'p'), false);

    // A refusal shows as DSH's banner, as a warning, and the button stays.
    answer = { ok: false, error: { code: 'coordinator/refused', message: 'this chat is still answering; try again when its turn ends' } };
    const stopped = draw('n');
    buttonOf(stopped()).props.onClick();
    await tick();
    assert.deepEqual(calls.at(-1), ['coordinate', { target: 'n', on: true }]);
    tree = stopped();
    assert.deepEqual(plain([toastOf(tree).props.text, toastOf(tree).props.tone ?? null, toastOf(tree).props.icon.type, toastOf(tree).props.holdMs, buttonOf(tree).props.disabled]),
        ['This chat is still answering; try again when its turn ends.', null, 'IconWarningOutlineRegular', 8000, false]);
    assert.equal(refreshed.length, 1, 'nothing changed, so nothing to read again');
    // The banner goes when DSH is done with it.
    toastOf(tree).props.onDone();
    assert.equal(toastOf(stopped()), undefined);
});

test('browser half: on DSH\'s new-chat screen Coordinate sits in the composer\'s row, and what /coordinate typed there said shows as a banner', async () => {
    const Toast = () => null;
    const { client, react } = loadClient({ primitives: { Tooltip: 'Tooltip', Toast } });
    const { StartCoordinating, startState, isNewChat, commandSaid, projectFacts } = client.internals;
    const coordinating = (id, more) => ({ role: 'coordinator', project: { id, name: '' }, threads: [], ...more });
    const thread = { role: 'thread', project: { id: 'c', name: 'Shop' }, coordinator: 'c', thread: { id: 't1' } };
    const state = {
        byId: {
            n: { id: 'n', cwd: '/w', blank: true },
            on: { id: 'on', cwd: '/w', blank: true, projectionValues: { coordinatorSession: coordinating('on') } },
            off: { id: 'off', cwd: '/w', blank: true, projectionValues: { coordinatorSession: coordinating('off', { off: true }) } },
            t: { id: 't', cwd: '/w', projectionValues: { coordinatorSession: thread } },
            sa: { id: 'sa', cwd: '/w', origin: 'subagent' },
            bare: { id: 'bare', blank: true },
            cold: { id: 'cold', cwd: '/w', blank: true },
        },
        projectionsBySession: { cold: { state: 'loading', values: {} } },
    };
    // On while the chat coordinates, off while it can start; no switch on a thread, a subagent's session, a chat
    // with no folder for threads, or one whose value DSH is still reading.
    assert.deepEqual(['n', 'on', 'off', 't', 'sa', 'bare', 'cold', 'missing'].map((id) => startState(state, id) ?? null),
        ['off', 'on', 'off', null, null, null, null, null]);
    // DSH's new-chat screen: nothing sent in the chat and nothing running there.
    assert.deepEqual([{ blank: true }, { blank: true, running: true }, { blank: true, promptAttempted: true }, { blank: true, awaitingFirstTurn: true }, { blank: false }, undefined]
        .map(isNewChat), [true, false, false, false, false, false]);

    const calls = [];
    const refreshed = [];
    let answer;
    const link = {
        async call(method, args) {
            calls.push([method, plain(args)]);
            await null;
            // As the plugin does: once it answers, the chat's value says whether it coordinates.
            if (answer.ok) state.byId[args.target] = { ...state.byId[args.target], projectionValues: { coordinatorSession: coordinating(args.target, args.on ? {} : { off: true }) } };
            return answer;
        },
    };
    const said = commandSaid();
    const projects = { facts: projectFacts(link), refresh: (id, now) => refreshed.push([id, now]), said };
    let session = { blank: true };
    let shown = { activeTargets: new Set() };
    const draw = (sessionId) => mount(react, () => StartCoordinating({
        sessionId, useSession: (select) => select(session), useSessions: (select) => select(state), useConversation: (select) => select(shown), projects,
    }));
    const buttonOf = (tree) => elementsOf(tree).find((e) => e.props?.['data-coordinator-start-button'] !== undefined);
    const toastOf = (tree) => elementsOf(tree).find((e) => e.type === Toast);
    for (const id of ['t', 'sa', 'bare', 'cold']) assert.equal(draw(id)(), null, id);

    // Off: named as in the header, and its tooltip says why.
    const chat = draw('n');
    let tree = chat();
    const tip = () => elementsOf(chat()).find((e) => e.type === 'Tooltip').props.label;
    assert.deepEqual(plain([tree.props['data-coordinator-start'], textIn(tree), buttonOf(tree).props['aria-label'], buttonOf(tree).props.className, tip()]),
        ['off', 'Coordinate', 'Coordinate', 'dshp-start-btn', 'Run work from this chat in threads that report back here']);
    // A click makes the chat coordinate before its first message; what the plugin said shows as DSH's banner.
    answer = { ok: true, value: { coordinating: true, session: 'n', text: 'Coordinating. Ask for work here as usual.', projects: [{ id: 'n', coordinator: 'n', paused: false }] } };
    buttonOf(tree).props.onClick();
    assert.equal(buttonOf(chat()).props.disabled, true);
    await tick();
    assert.deepEqual(calls, [['coordinate', { target: 'n', on: true }]]);
    assert.deepEqual(refreshed, [['n', true]]);
    tree = chat();
    assert.deepEqual(plain([tree.props['data-coordinator-start'], textIn(tree), buttonOf(tree).props['aria-label'], buttonOf(tree).props.className, tip()]),
        ['on', 'Coordinating', 'Coordinating, press to stop', 'dshp-start-btn dshp-start-on', 'This chat runs work in threads that report back here. Click to stop (/coordinate off)']);
    assert.deepEqual(plain([toastOf(tree).props.text, toastOf(tree).props.tone]), ['Coordinating. Ask for work here as usual.', 'success']);
    // On, a click stops it again, with nothing more to say.
    answer = { ok: true, value: { coordinating: false, session: 'n', text: 'Stopped coordinating.', projects: [] } };
    buttonOf(tree).props.onClick();
    await tick();
    assert.deepEqual(calls.at(-1), ['coordinate', { target: 'n', on: false }]);
    assert.equal(chat().props['data-coordinator-start'], 'off');

    // Past the new-chat screen (something sent, running, or shown besides a command), DSH's header has it instead.
    for (const [now, showing] of [[{ blank: false }, new Set()], [{ blank: true, running: true }, new Set()], [{ blank: true }, new Set(['chat'])]]) {
        session = now;
        shown = { activeTargets: showing };
        assert.equal(buttonOf(draw('n')()), undefined, JSON.stringify(now));
    }
    session = { blank: true };
    shown = { activeTargets: new Set() };

    // /coordinate typed there: DSH draws its answer only once the chat has a message, so the banner says it.
    said.put('on', { kind: 'success', text: ' Coordinating. Ask for work here as usual. ' });
    const typed = draw('on');
    tree = typed();
    assert.deepEqual(plain([tree.props['data-coordinator-start'], toastOf(tree).props.text, toastOf(tree).props.tone, toastOf(tree).props.holdMs]),
        ['on', 'Coordinating. Ask for work here as usual.', 'success', 5000]);
    toastOf(tree).props.onDone();
    assert.equal(said.get('on'), undefined);
    assert.equal(toastOf(typed()), undefined);
    // A refusal shows as a warning, and stays longer.
    said.put('n', { kind: 'error', text: 'This chat has no folder for threads to work in.' });
    tree = draw('n')();
    assert.deepEqual(plain([toastOf(tree).props.text, toastOf(tree).props.tone ?? null, toastOf(tree).props.icon.type, toastOf(tree).props.holdMs]),
        ['This chat has no folder for threads to work in.', null, 'IconWarningOutlineRegular', 8000]);
    // A banner already replaced by a newer answer is not the one taken away.
    const first = said.get('n').seq;
    said.put('n', { kind: 'success', text: 'Coordinating.' });
    said.take('n', first);
    assert.equal(said.get('n')?.text, 'Coordinating.');
    said.put('n', { kind: 'success', text: '   ' });
    assert.equal(said.get('n')?.text, 'Coordinating.', 'nothing said, nothing to show');

    // DSH's note that this window ran a command: /coordinate's answer is kept for a chat still on the new-chat screen.
    const listeners = {};
    const registered = [];
    const list = { ids: ['b', 'x'], byId: { b: { id: 'b', blank: true }, x: { id: 'x', blank: false } }, phase: 'ready', projectionsBySession: {} };
    const ctx = {
        effect: (fn) => fn(),
        inject: (names, fn) => { if (!names.includes('configForms')) fn(ctx); },
        on: (name, fn) => { listeners[name] = fn; return () => { delete listeners[name]; }; },
        slots: { inject: (_name, fn) => fn(), register: (slot) => { registered.push(slot); return () => {}; } },
        resources: { register: () => () => {} },
        sidebarRightTabs: { register: () => () => {} },
        sessions: { list: { getSnapshot: () => list, subscribe: () => () => {} } },
        uiWorkspace: {},
        sidebarRight: {},
    };
    client.apply(ctx);
    const api = registered.find((slot) => slot.name === 'conversation.input.left').inject().projects;
    listeners['command/executed']('b', 'coordinate', { kind: 'success', text: 'Coordinating.' });
    listeners['command/executed']('x', 'coordinate', { kind: 'success', text: 'Coordinating.' });
    listeners['command/executed']('b', 'plan', { kind: 'success', text: 'Plan mode on.' });
    assert.deepEqual(plain([api.said.get('b'), api.said.get('x') ?? null]), [{ text: 'Coordinating.', failed: false, seq: 1 }, null]);
});

test('browser half: while a chat coordinates, its Threads menu ends with Stop coordinating; one that stopped keeps the menu while it has threads, beside Coordinate', async () => {
    const doc = { body: 'body', addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => ({}) };
    const Toast = () => null;
    const { client, react } = loadClient({ document: doc, primitives: { useAnchoredPosition: () => null, useDismissOnOutsidePointer: () => {}, MenuSurface: 'MenuSurface', Toast } });
    const { ThreadsMenu, CoordinateAction, canCoordinate, stoppedEmpty, projectContext } = client.internals;
    const threads = [{ id: 't1', session: 's-t1', title: 'Deploy', resolved: false, created: '2026-10-10T10:00:00.000Z' }];
    const chat = (id, more) => ({ id, title: id, projectionValues: { coordinatorSession: { role: 'coordinator', project: { id, name: id }, threads, ...more } } });
    const state = {
        byId: {
            c: chat('c'), n: chat('n', { off: true }), e: chat('e', { off: true, threads: [] }),
            's-t1': { id: 's-t1', title: 'Deploy', projectionValues: { coordinatorSession: { role: 'thread', project: { id: 'c', name: 'c' }, coordinator: 'c', thread: { id: 't1' } } } },
        },
    };
    const quiet = { subscribe: () => () => {} };
    const calls = [];
    const refreshed = [];
    let answer = { ok: true, value: { coordinating: false, session: 'c', text: 'This chat stopped coordinating.', projects: [] } };
    const projects = {
        facts: {
            ...quiet, getSnapshot: () => 0, watch: () => () => {}, paused: () => false, info: () => undefined, describe: async () => {},
            coordinate: async (target, on) => {
                calls.push([target, on]);
                if (answer.ok) state.byId[target] = chat(target, { off: true });
                return answer;
            },
        },
        settings: { ...quiet, getSnapshot: () => ({ available: false }) },
        catalog: { ...quiet, getSnapshot: () => ({ status: 'ready', value: undefined }), ensure: () => {} },
        refresh: (id, now) => refreshed.push([id, now]), hasPane: () => false, hasChanges: () => false,
    };
    // State and refs hold between draws, as React's do; effects don't run.
    const drawn = (component, sessionId) => {
        const refs = [];
        return mount(react, () => {
            let at = 0;
            react.useRef = (init) => {
                const k = at++;
                if (!(k in refs)) refs[k] = { current: init };
                return refs[k];
            };
            return component({ sessionId, useSessions: (select) => select(state), useSessionStatus: (select) => select(new Map()), projects });
        });
    };
    const menuOf = (sessionId) => {
        const draw = drawn(ThreadsMenu, sessionId);
        return () => {
            const tree = draw();
            const all = elementsOf(tree);
            const trigger = all.find((e) => e.props?.['data-projects-threads-trigger'] === '')?.props;
            return { tree, trigger, open: trigger?.['aria-expanded'] === true, stop: all.find((e) => e.props?.['data-projects-stop-coordinating'] === ''), toast: all.find((e) => e.type === Toast) };
        };
    };
    const coordinateShown = (sessionId) => drawn(CoordinateAction, sessionId)() !== null;

    // The coordinating chat's own menu ends with Stop coordinating; Coordinate isn't there.
    const menu = menuOf('c');
    menu().trigger.onClick();
    let at = menu();
    assert.equal(at.open, true);
    assert.deepEqual(plain([textIn(at.stop), at.stop.children[0].type, at.stop.props.disabled]), ['Stop coordinating', 'IconCloseOutlineRegular', false]);
    assert.equal(coordinateShown('c'), false);
    // A thread's menu has no such item.
    const own = menuOf('s-t1');
    own().trigger.onClick();
    assert.deepEqual([own().open, own().stop], [true, undefined]);
    // A click closes the menu and asks the plugin to stop, with no confirmation; done, it needs no banner.
    at.stop.props.onClick();
    assert.deepEqual(calls, [['c', false]]);
    await tick();
    assert.deepEqual(refreshed, [['c', true]]);
    at = menu();
    assert.deepEqual([at.open, at.toast], [false, undefined]);

    // Stopped with threads: the menu stays, without Stop coordinating, and Coordinate is back beside it.
    assert.equal(stoppedEmpty(projectContext(state, 'c')), false);
    at.trigger.onClick();
    at = menu();
    assert.deepEqual([at.open, at.trigger['aria-label'], at.stop], [true, 'Threads: 1 open', undefined]);
    assert.equal(coordinateShown('c'), true);
    assert.equal(canCoordinate(state, 'n'), true);
    // Stopped with no threads: a chat like any other, with Coordinate alone.
    assert.equal(stoppedEmpty(projectContext(state, 'e')), true);
    assert.equal(menuOf('e')().tree, null);
    assert.equal(coordinateShown('e'), true);

    // A refusal shows as DSH's banner where the menu was.
    state.byId.c = chat('c');
    answer = { ok: false, error: { code: 'coordinator/refused', message: 'a thread is still running' } };
    menu().trigger.onClick();
    menu().stop.props.onClick();
    await tick();
    at = menu();
    assert.deepEqual(plain([at.toast.props.text, at.toast.props.icon.type]), ['A thread is still running.', 'IconWarningOutlineRegular']);
    assert.deepEqual(calls, [['c', false], ['c', false]]);
});

test('browser half: Rename, Mark resolved or Reopen from a row shows at once, and the coordinating chat\'s own later change wins', () => {
    const { client } = loadClient();
    const { newestRoster: resolvedRoster } = client.internals;
    const seen = new Map();
    const roster = (t1, t2 = true) => [{ id: 't1', resolved: t1 }, { id: 't2', resolved: t2 }];
    const answer = (t1, t2 = true) => [{ id: 't1', resolved: t1 }, { id: 't2', resolved: t2 }];
    const shown = (r, a) => plain(resolvedRoster(r, a, seen, 'c').map((e) => e.resolved));
    // Agreeing, the roster itself comes back.
    const same = roster(false);
    assert.equal(resolvedRoster(same, answer(false), seen, 'c'), same);
    // Mark resolved in the window: the plugin's answer changed last.
    assert.deepEqual(shown(roster(false), answer(true)), [true, true]);
    // The coordinating chat's next thread tool records it too.
    assert.deepEqual(shown(roster(true), answer(true)), [true, true]);
    // The chat reopens it with its tool: the roster changed last, before the plugin is read again.
    assert.deepEqual(shown(roster(false), answer(true)), [false, true]);
    assert.deepEqual(shown(roster(false), answer(false)), [false, true]);
    // After a reload the first look takes the plugin's answer (the roster waits on the chat's next tool).
    assert.deepEqual(plain(resolvedRoster(roster(false), answer(true), new Map(), 'c').map((e) => e.resolved)), [true, true]);
    // Threads the plugin hasn't named, or no answer yet: the roster as it is.
    assert.deepEqual(plain(resolvedRoster(roster(false), [{ id: 't9', resolved: true }], new Map(), 'c').map((e) => e.resolved)), [false, true]);
    assert.equal(resolvedRoster(same, undefined, new Map(), 'c'), same);
    // A name works the same way: Rename in the window shows at once, and the chat's own rename after it wins.
    const names = new Map();
    const named = (r, a) => plain(resolvedRoster([{ id: 't1', title: r }], [{ id: 't1', title: a }], names, 'c').map((e) => e.title));
    assert.deepEqual(named('Fix login', 'Fix login'), ['Fix login']);
    assert.deepEqual(named('Fix login', 'Fix the login loop'), ['Fix the login loop']);
    assert.deepEqual(named('Fix the login loop', 'Fix the login loop'), ['Fix the login loop']);
    assert.deepEqual(named('Login loop', 'Fix the login loop'), ['Login loop']);
    // An answer without a name leaves the roster's.
    assert.deepEqual(plain(resolvedRoster([{ id: 't1', title: 'Fix login' }], [{ id: 't1', title: '' }], new Map(), 'c').map((e) => e.title)), ['Fix login']);
});

test('browser half: access reads as DSH names it, and each thread row says what it can reach', () => {
    const { client } = loadClient();
    const { permissionName, permissionShown, permissionIn, toolsText, accessOf, accessSummary, ThreadRow, ModelsSummary } = client.internals;
    const catalog = {
        defaultPreset: 'danger-full-access',
        options: [
            { value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'Workspace Write' }, { value: 'danger-full-access', name: 'danger-full-access' },
            { value: 'team-review', name: 'team-review' }, { value: 'night', name: 'Night shift' },
        ],
    };
    // DSH's own labels for its presets; another kebab-case name title-cased, any other as given.
    assert.deepEqual(['read-only', 'workspace-write', 'danger-full-access', 'team-review', 'night', 'custom', 'not-offered'].map((v) => permissionName(v, catalog)),
        ['Read Only', 'Workspace Write', 'Full access', 'Team Review', 'Night shift', 'Custom', 'Not Offered']);
    assert.equal(permissionName('', catalog), undefined);
    assert.equal(permissionName('read-only', { options: [{ value: 'read-only', name: 'Look only' }] }), 'Look only', 'a preset the profile renamed keeps its name');
    // "default" is DSH's default for new sessions.
    assert.deepEqual(plain(permissionShown('default', catalog)), { preset: 'danger-full-access', name: 'Full access' });
    assert.deepEqual(plain(permissionShown('default', null)), { name: 'DSH default' });
    assert.deepEqual(plain(permissionShown('workspace-write', null)), { preset: 'workspace-write', name: 'Workspace Write' });
    assert.deepEqual([toolsText('all'), toolsText(['cua', 'lane-catalog']), toolsText([]), toolsText(undefined)], ['all of them', 'cua, lane-catalog', 'none', 'none']);
    // DSH's permissions projection, from either place the window's store keeps it.
    assert.equal(permissionIn({ projectionsBySession: { s1: { values: { permissions: { currentValue: 'read-only' } } } } }, 's1'), 'read-only');
    assert.equal(permissionIn({ byId: { s1: { projectionValues: { permissions: { currentValue: 'workspace-write' } } } } }, 's1'), 'workspace-write');
    assert.equal(permissionIn({ byId: { s1: {} } }, 's1'), undefined);
    assert.equal(permissionIn(undefined, 's1'), undefined);

    // What each thread can reach: the preset DSH shows now wins over the one the plugin last saw.
    const info = {
        access: { yourTools: { value: 'asked' }, threadPermission: { value: 'workspace-write' } }, guarded: ['lane-catalog', 'cua'], permissions: catalog,
        threads: [{ id: 't1', session: 's1', permission: 'workspace-write', tools: ['lane-catalog'] }, { id: 't2', session: 's2', permission: 'workspace-write', tools: [] }, { id: 't3', tools: [] }],
    };
    assert.deepEqual(plain(accessOf(info, { s2: 'read-only' })), { s1: { permission: 'workspace-write', tools: ['lane-catalog'] }, s2: { permission: 'read-only', tools: [] } });
    assert.deepEqual(plain(accessOf(null, {})), {});
    // The menu's access rows: what new threads start on, and the user's tools once any are listed.
    assert.deepEqual(plain(accessSummary(info)), { permission: { preset: 'workspace-write', name: 'Workspace Write' }, tools: 'Only when asked' });
    assert.equal(accessSummary({ ...info, access: { ...info.access, yourTools: { value: 'always' } } }).tools, 'Always');
    assert.deepEqual(plain(accessSummary({ ...info, guarded: [] })), { permission: { preset: 'workspace-write', name: 'Workspace Write' } });
    assert.deepEqual(plain(accessSummary({ ...info, permissions: null })), { tools: 'Only when asked' });
    assert.deepEqual(plain(accessSummary({ ...info, guarded: [], permissions: null })), {});
    assert.deepEqual(plain(accessSummary(null)), {});

    // A row names the user's tools it has, and a permission other than new threads' default.
    const row = { id: 't1', title: 'Check lanes', line: 'Running', dot: 'ongoing', session: 's1' };
    const bodyOf = (el) => (el.props.className === 'dshp-t-row' ? el : el.children[0]);
    const mainOf = (el) => bodyOf(el).children.find((c) => c?.props?.className === 'dshp-t-main');
    const chips = (access) => {
        const main = mainOf(ThreadRow({ row, now: 0, onOpen() {}, access, quietPermission: 'workspace-write', permissions: catalog }));
        return { label: main.props['aria-label'], tools: textIn(byClass(main, 'dshp-t-tools')), permission: byClass(main, 'dshp-t-perm').map((e) => [e.props['data-projects-thread-permission'], textIn(e)]) };
    };
    assert.deepEqual(plain(chips({ permission: 'workspace-write', tools: ['lane-catalog'] })),
        { label: 'Check lanes. Running. Your tools: lane-catalog', tools: 'lane-catalog', permission: [] });
    assert.deepEqual(plain(chips({ permission: 'read-only', tools: [] })),
        { label: 'Check lanes. Running. Read Only', tools: '', permission: [['read-only', 'Read Only']] });
    assert.deepEqual(plain(chips({ permission: 'danger-full-access', tools: 'all' })),
        { label: 'Check lanes. Running. Full access. Your tools: all of them', tools: 'all of them', permission: [['danger-full-access', 'Full access']] });
    assert.deepEqual(plain(chips(undefined)), { label: 'Check lanes. Running', tools: '', permission: [] });

    // The menu's top: rows for new threads' permission and the user's tools, each opening Thread settings at Access.
    const picked = [];
    const summary = ModelsSummary({ thread: 'V4 · High', access: accessSummary(info), onPick: (id) => picked.push(id) });
    const rows = summary.children.filter(Boolean);
    assert.deepEqual(rows.map((r) => r.props['data-projects-models']), ['thread', 'access', 'tools']);
    assert.deepEqual(rows.slice(1).map((r) => r.props['aria-label']),
        ['Thread access: Workspace Write. Change it in Thread settings', 'Your tools: Only when asked. Change it in Thread settings']);
    rows[1].props.onClick();
    rows[2].props.onClick();
    assert.deepEqual(picked, ['access', 'access']);
    assert.equal(ModelsSummary({ thread: 'V4 · High' }).children.filter(Boolean).length, 1);
    assert.equal(ModelsSummary({ thread: 'V4 · High', access: {} }).children.filter(Boolean).length, 1);
});

test('browser half: thread rows, cards and links read the projection as DSH sends it', () => {
    const { client } = loadClient();
    const { projectContext, rowsOf, countsOf, summaryText, cardsOf, cardView, resolveLink, linkTarget, chatAddress, chatSessionOf, isThreadRow } = client.internals;
    const coordValue = { role: 'coordinator', project: { id: 'p', name: 'DSH Plugins' }, threads: [
        { id: 't1', session: 's-t1', title: 'Add CI', resolved: false, created: '2026-10-09T10:00:00.000Z', handback: { status: 'done', summary: 'CI added.', at: '2026-10-09T11:00:00.000Z' } },
        { id: 't2', session: 's-t2', title: 'Fix login', resolved: false, created: '2026-10-09T12:00:00.000Z', handback: { status: 'needs_decision', summary: 'Pick A or B.', at: '2026-10-09T13:00:00.000Z' } },
        { id: 't3', session: 's-t3', title: 'Write docs', resolved: false, created: '2026-10-09T14:00:00.000Z' },
        { id: 't4', session: 's-t4', title: 'Old spike', resolved: true, created: '2026-10-08T14:00:00.000Z' },
    ], cards: [
        { turn: 2, seq: 10, kind: 'start', thread: 't3' },
        { turn: 2, seq: 11, kind: 'send', thread: 't3', status: 'steer' },
        { turn: 2, seq: 12, kind: 'start', thread: 't4' },
        { turn: 3, seq: 20, kind: 'handback', thread: 't2', status: 'needs_decision' },
    ] };
    const threadValue = { role: 'thread', project: { name: 'DSH Plugins' }, coordinator: 's-c', thread: { id: 't3', title: 'Write docs' },
        cards: [{ turn: 1, seq: 5, kind: 'handback', thread: 't3', status: 'progress' }] };
    // The session list as DSH's store holds it: values on rows (cached) or loaded per session.
    const state = {
        ids: ['s-c', 's-t1', 's-t3', 's-plain'],
        phase: 'ready',
        byId: {
            's-c': { id: 's-c', title: 'DSH Plugins', projectionValues: { coordinatorSession: coordValue } },
            's-t1': { id: 's-t1', title: 'Add CI' },
            's-t3': { id: 's-t3', title: 'Write docs', running: true, updatedAt: Date.parse('2026-10-09T15:00:00.000Z') },
            's-plain': { id: 's-plain', title: 'Something else' },
        },
        projectionsBySession: { 's-t3': { state: 'ready', values: { coordinatorSession: threadValue } } },
    };
    const statuses = new Map([['s-t3', { running: true }]]);

    // The coordinator's roster, newest activity first, each with what it needs.
    const coord = projectContext(state, 's-c');
    const rows = rowsOf(coord.roster, statuses, state.byId);
    assert.deepEqual(plain(rows.map((r) => [r.id, r.group, r.dot, r.line])), [
        ['t3', 'running', 'ongoing', 'Working…'],
        ['t2', 'waiting', 'warning', 'Needs your decision · Pick A or B.'],
        ['t1', 'done', 'done', 'Done · CI added.'],
        ['t4', 'resolved', 'done', 'Resolved'],
    ]);
    assert.deepEqual(plain(countsOf(rows)), { open: 3, running: 1, waiting: 1, resolved: 1, failed: 0 });
    assert.equal(summaryText(countsOf(rows)), '3 open · 1 waiting on you · 1 running · 1 resolved');
    // A thread reads the roster from its coordinator, and knows it is still loading before then.
    const thread = projectContext(state, 's-t3');
    assert.equal(thread.coordinator, 's-c');
    assert.equal(thread.roster, coord.roster);
    const early = projectContext({ ...state, byId: { ...state.byId, 's-c': { id: 's-c' } }, projectionsBySession: { ...state.projectionsBySession, 's-c': { state: 'loading', values: {} } } }, 's-t3');
    assert.deepEqual([early.roster, early.load], [null, 'loading']);
    assert.equal(projectContext(state, 's-plain'), undefined);

    // Cards: one per thread in a turn, the first action wins.
    assert.deepEqual(plain(cardsOf(coordValue, 2).map((c) => [c.kind, c.thread])), [['start', 't3'], ['start', 't4']]);
    assert.equal(cardsOf(coordValue, 9).length, 0);
    const [handback] = cardsOf(coordValue, 3).map((card) => cardView(card, coord, statuses, state.byId, 's-c'));
    // A card says its thread's state once, beside the name: while the handback's state is the thread's, its line says only "Handback".
    assert.deepEqual(plain([handback.verb, handback.title, handback.session, handback.state.label, handback.icon]), ['Handback', 'Fix login', 's-t2', 'Needs a decision', 'IconTreeCornerRegular']);
    const steer = cardView({ turn: 2, seq: 11, kind: 'send', thread: 't3', status: 'steer' }, coord, statuses, state.byId, 's-c');
    assert.deepEqual(plain([steer.verb, steer.state.label]), ['Steered a thread', 'Running']);
    const verbOf = (card) => { const v = cardView({ turn: 2, seq: 1, ...card }, coord, statuses, state.byId, 's-c'); return [v.verb, v.state.label]; };
    assert.deepEqual(plain([
        verbOf({ kind: 'update', thread: 't4', status: 'resolved' }), verbOf({ kind: 'update', thread: 't3', status: 'resolved' }),
        verbOf({ kind: 'handback', thread: 't3', status: 'done' }), verbOf({ kind: 'handback', thread: 't3', status: 'progress' }),
        verbOf({ kind: 'approval', thread: 't3' }),
    ]), [
        ['Updated a thread', 'Resolved'], ['Resolved a thread', 'Running'],
        // Once the thread moved on, the line keeps what the event said.
        ['Handback · Done', 'Running'], ['Progress update', 'Running'],
        ['Asked for your approval', 'Running'],
    ]);
    // In a thread, its own handback card points back at the chat that started it, by that chat's name.
    const own = cardView(threadValue.cards[0], thread, statuses, state.byId, 's-t3');
    assert.deepEqual(plain([own.verb, own.title, own.session]), ['Handed back · Progress update', 'DSH Plugins', 's-c']);
    // While threads are paused, the thread's own card says its handback waits, and the coordinating chat's cards
    // read a held handback as the Threads menu does.
    const heldOwn = cardView(threadValue.cards[0], thread, statuses, state.byId, 's-t3', undefined, [{ thread: 't3', status: 'progress' }]);
    assert.deepEqual(plain([heldOwn.verb, heldOwn.note, heldOwn.icon]),
        ['Handback held · Progress update', 'Threads are paused, so the chat that started this thread gets this handback when you resume.', 'IconPauseOutlineRegular']);
    assert.equal(cardView(threadValue.cards[0], thread, statuses, state.byId, 's-t3', undefined, [{ thread: 't9', status: 'done' }]).verb, 'Handed back · Progress update');
    const heldCard = cardView({ turn: 2, seq: 12, kind: 'send', thread: 't2' }, coord, statuses, state.byId, 's-c', undefined, [{ thread: 't2', status: 'blocked' }]);
    assert.deepEqual(plain([heldCard.state.label, heldCard.state.dot, heldCard.row.line, heldCard.row.held]), ['Blocked', 'warning', 'Blocked · held until you resume', true]);

    // A thread link as DSH resolves `.dsh-thread/t3` against the coordinator's session.
    const target = linkTarget(`dsh-resource://file/session/${encodeURIComponent('s-c')}/.dsh-thread/T3`);
    assert.deepEqual(plain(target), { sessionId: 's-c', threadId: 't3' });
    assert.deepEqual(plain(resolveLink(state, target)), { state: 'found', session: 's-t3', coordinator: 's-c' });
    assert.equal(resolveLink(state, { sessionId: 's-c', threadId: 't9' }).state, 'missing');
    assert.equal(resolveLink(state, { sessionId: 's-t3', threadId: 't3' }).state, 'found');
    assert.equal(resolveLink(state, { sessionId: 'not-loaded', threadId: 't1' }).state, 'loading');
    assert.equal(resolveLink(state, undefined).state, 'invalid');
    assert.equal(linkTarget('dsh-resource://file/session/s-c/.dsh-thread/notes.md'), undefined);
    // The short `.t3` names the same thread; `.tmp` names a file.
    assert.deepEqual(plain(linkTarget('dsh-resource://file/session/s-c/.t3')), plain(target));
    assert.deepEqual(plain(resolveLink(state, linkTarget('dsh-resource://file/session/s-c/.t3'))), { state: 'found', session: 's-t3', coordinator: 's-c' });
    assert.equal(linkTarget('dsh-resource://file/session/s-c/.tmp'), undefined);

    // A sidebar chat address keeps any session id intact.
    assert.equal(chatSessionOf(chatAddress('sess/with ?#%')), 'sess/with ?#%');
    assert.equal(chatSessionOf('dsh-resource://subagentchat/session/x'), undefined);

    // Sidebar marks: from the projection, or from what the plugin's store knows; never from a title.
    assert.deepEqual(['s-t3', 's-t1', 's-c', 's-plain'].map((id) => isThreadRow(state, id)), [true, false, false, false]);
    assert.equal(isThreadRow({ ...state, byId: { ...state.byId, 's-t1': { id: 's-t1', title: 'DSH Plugins › Add CI' } } }, 's-t1'), false);
});

test('browser half: a failed or stopped thread reads Failed or Stopped everywhere, with its reason and Retry or Resume', () => {
    const { client } = loadClient();
    const { projectContext, rowsOf, countsOf, cardView, rowState, endingIn, endingLine, openSessions, markState, hoverLine, withHeld, continueError, GROUPS } = client.internals;
    const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00.000Z`;
    const failed = { state: 'failed', kind: 'error', message: 'The model rejected the request.', turn: 1, seq: 9, at: at(10) };
    const stopped = { state: 'stopped', kind: 'aborted', cause: 'user', turn: 1, seq: 7, at: at(10) };
    const coordValue = { role: 'coordinator', project: { id: 'p', name: 'Storefront' }, threads: [
        { id: 't6', session: 's-t6', title: 'Refactor cart state', resolved: false, created: at(8) },
        { id: 't7', session: 's-t7', title: 'Generate size-guide tables', resolved: false, created: at(8) },
        // A done handback after a stop: the handback is the news.
        { id: 't8', session: 's-t8', title: 'Caching spike', resolved: false, created: at(8), handback: { status: 'done', summary: 'Spike done.', at: at(11) } },
        // A failure after a decision handback: the failure is the news.
        { id: 't9', session: 's-t9', title: 'Fix the login loop', resolved: false, created: at(8), handback: { status: 'needs_decision', summary: 'A or B?', at: at(9) } },
        { id: 't10', session: 's-t10', title: 'Old', resolved: true, created: at(7) },
    ], cards: [
        { turn: 4, seq: 30, kind: 'start', thread: 't7' },
        { turn: 5, seq: 40, kind: 'idle', thread: 't7', status: 'failed' },
        { turn: 5, seq: 41, kind: 'idle', thread: 't6', status: 'stopped' },
        { turn: 5, seq: 42, kind: 'idle', thread: 't8' },
    ] };
    const thread = (id, ending) => ({ role: 'thread', project: { name: 'Storefront' }, coordinator: 's-c', thread: { id }, ...(ending ? { ending } : {}) });
    const state = {
        byId: { 's-c': { id: 's-c', title: 'Storefront', projectionValues: { coordinatorSession: coordValue } } },
        projectionsBySession: {
            's-t6': { values: { coordinatorSession: thread('t6', stopped) } },
            's-t7': { values: { coordinatorSession: thread('t7', failed) } },
            's-t8': { values: { coordinatorSession: thread('t8', stopped) } },
            's-t9': { values: { coordinatorSession: thread('t9', { ...failed, at: at(12) }) } },
            's-t10': { values: { coordinatorSession: thread('t10', failed) } },
        },
    };
    const coord = projectContext(state, 's-c');
    assert.deepEqual(plain(openSessions(coord.roster)), ['s-t6', 's-t7', 's-t8', 's-t9'], 'resolved threads need no ending');
    const endings = Object.fromEntries(openSessions(coord.roster).map((id) => [id, endingIn(state, id)]).filter(([, e]) => e));
    const rows = rowsOf(coord.roster, new Map(), state.byId, endings);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual(plain(['t7', 't6', 't8', 't9', 't10'].map((id) => [id, byId[id].group, byId[id].dot, byId[id].stateLabel, byId[id].line])), [
        ['t7', 'waiting', 'error', 'Failed', 'Failed · The model rejected the request.'],
        // A stop DSH counts as the user's is named as theirs.
        ['t6', 'idle', 'idle', 'Stopped', 'Stopped by you'],
        ['t8', 'done', 'done', 'Done', 'Done · Spike done.'],
        ['t9', 'waiting', 'error', 'Failed', 'Failed · The model rejected the request.'],
        ['t10', 'resolved', 'done', 'Resolved', 'Resolved'],
    ]);
    assert.deepEqual(plain(countsOf(rows)), { open: 4, running: 0, waiting: 2, resolved: 1, failed: 2 });
    assert.deepEqual(plain(GROUPS.map((g) => g.label)), ['Waiting on you', 'Running', 'Done', 'Idle', 'Resolved']);
    // Running, a prompt and resolved win over an old ending; a held handback is newer than any.
    assert.equal(rowState({ running: true, ending: failed }).label, 'Running');
    assert.equal(rowState({ pending: { kind: 'approval' }, ending: failed }).label, 'Needs you');
    assert.equal(rowState({ resolved: true, ending: failed }).label, 'Resolved');
    assert.equal(rowState({ hb: { status: 'blocked' } }).label, 'Blocked');
    assert.deepEqual(plain(withHeld([byId.t7], [{ thread: 't7', status: 'done' }]).map((r) => [r.group, r.stateLabel, r.line, r.ending])),
        [['done', 'Done', 'Done · held until you resume', null]]);
    // Why, for each way a turn ends.
    assert.deepEqual(plain([
        { state: 'failed', kind: 'blocked' }, { state: 'failed', kind: 'signed-out' }, { state: 'failed', kind: 'error' },
        { state: 'stopped', kind: 'interrupted' }, { state: 'stopped', kind: 'max-tokens' }, { state: 'stopped', kind: 'aborted', cause: 'hook', hook: 'budget' },
        { state: 'stopped', kind: 'aborted', cause: 'disposed' }, { state: 'stopped', kind: 'aborted', cause: 'user' }, { state: 'stopped', kind: 'aborted' },
    ].map(endingLine)), [
        'Failed · A DSH plugin blocked the turn.', 'Failed · You signed out of DeepSeek.', 'Failed · DSH couldn\'t finish the turn.',
        'Stopped · DSH closed while it ran.', 'Stopped · It reached the output token limit.', 'Stopped · A DSH plugin stopped it (budget).',
        'Stopped · Its session closed while it ran.', 'Stopped by you', 'Stopped before it finished',
    ]);

    // Cards: the idle note's card names the failure; every card of the thread says its state now.
    const statuses = new Map();
    const views = coordValue.cards.map((card) => cardView(card, coord, statuses, state.byId, 's-c', endings));
    assert.deepEqual(plain(views.map((v) => [v.threadId, v.verb, v.tone ?? null, v.state.label, v.row.ending?.state ?? null])), [
        ['t7', 'Started a thread', null, 'Failed', 'failed'],
        ['t7', 'Ended without a handback', 'error', 'Failed', 'failed'],
        ['t6', 'Ended without a handback', null, 'Stopped', 'stopped'],
        ['t8', 'Went idle without a handback', null, 'Done', null],
    ]);
    // No word twice on a card: the state is said beside the name, not again in its line.
    for (const v of views) assert.ok(!v.verb.split(/\W+/).includes(v.state.label), `${v.verb} / ${v.state.label}`);
    assert.deepEqual(plain(views.slice(0, 3).map((v) => v.icon)), ['IconBranchOutlineRegular', 'IconWarningTriangleOutlineRegular', 'IconStopFillRegular']);

    // The session list: a failed thread's mark is red, a waiting one's amber; DSH draws running ones.
    const marked = { ...state, projectionsBySession: { ...state.projectionsBySession, 's-t11': { values: { coordinatorSession: thread('t11') } } } };
    marked.byId = { ...state.byId, 's-c': { ...state.byId['s-c'], projectionValues: { coordinatorSession: { ...coordValue, threads: [...coordValue.threads,
        { id: 't11', session: 's-t11', title: 'CDN', resolved: false, handback: { status: 'blocked', summary: 'Token expired.', at: at(9) } }] } } } };
    assert.deepEqual(plain(['s-t7', 's-t6', 's-t8', 's-t11', 's-t10', 's-c', 'nope'].map((id) => markState(marked, id))),
        ['error:Failed', '', '', 'warning:Blocked', '', '', '']);
    // What a screen reader hears after each row's title (DSH's own status can take the mark's seat, never these words).
    const { RowPlace, rowWords } = client.internals;
    const useMarked = (select) => select(marked);
    assert.deepEqual(plain(['s-t7', 's-t11', 's-t8', 's-c', 'nope'].map((id) => RowPlace({ sessionId: id, useSessions: useMarked })?.props['data-projects-words'] ?? null)),
        ['Thread: Failed', 'Thread: Blocked', 'Thread', 'Coordinating', null]);
    assert.equal(rowWords({ role: 'coordinator', paused: true }), 'Threads paused');
    assert.equal(rowWords({ role: 'coordinator', paused: true, news: { unread: [{ kind: 'failed', title: 'Deploy' }] } }), 'Threads paused, New: “Deploy” failed');
    assert.equal(rowWords({ role: 'coordinator', off: true }), 'Stopped coordinating');
    assert.equal(rowWords({ role: '' }), '');

    // The hover card says what the thread last did; DSH ends it with the session's own status.
    assert.deepEqual(plain(['t7', 't6', 't8', 't9'].map((id) => hoverLine(byId[id]))), [
        'Last turn failed · The model rejected the request.', 'Last turn stopped by you', 'Last handback · Done · Spike done.', 'Last turn failed · The model rejected the request.',
    ]);
    assert.equal(hoverLine({ ...byId.t7, pending: true }), undefined);
    assert.equal(hoverLine(rowsOf([{ id: 't1', session: 's1', title: 'x', resolved: false }], new Map(), {}, {})[0]), 'No handback yet');

    // A refusal reads as the plugin's sentence.
    assert.equal(continueError({ code: 'coordinator/refused', message: 't7 is running already' }), 'T7 is running already.');
    assert.equal(continueError({ code: 'projects/unreachable', message: 'socket' }), 'Couldn\'t reach the thread.');
});

test('browser half: each session list row says its place by the chat its value names, never by a title, and the CSS nests each chat\'s threads under it', () => {
    const { client } = loadClient();
    const { rowPlace, nestingCss, nestedPlaces, takeKnown } = client.internals;
    takeKnown({});
    const coord = (id, name) => ({ role: 'coordinator', project: { id, name }, threads: [] });
    const thread = (coordinator, id) => ({ role: 'thread', project: { id: coordinator, name: 'DSH Plugins' }, coordinator, thread: { id } });
    const state = {
        byId: {
            c: { title: 'DSH Plugins', projectionValues: { coordinatorSession: coord('c', 'DSH Plugins') } },
            t2: { title: 'Fix login', projectionValues: { coordinatorSession: thread('c', 't2') } },
            t3: { title: 'Renamed by hand', projectionValues: { coordinatorSession: thread('c', 't3') } },
            // Another chat with the same name: its thread goes under it, not under c.
            t4: { title: 'DSH Plugins › Deploy', projectionValues: { coordinatorSession: thread('d', 't4') } },
            o: { title: '◆ Other' },
            ot: { title: 'Other › Its thread' },
            t1: { title: 'DSH Plugins › Add CI' },
            plain: { title: 'Release notes' },
            lost: { title: 'x', projectionValues: { coordinatorSession: { role: 'thread', thread: { id: 't9' } } } },
        },
        projectionsBySession: { d: { values: { coordinatorSession: coord('d', 'DSH Plugins') } } },
    };
    // A coordinating chat by its value; a thread by the chat id its value names, whatever either is called.
    assert.deepEqual(['c', 't2', 't3', 'd', 't4'].map((id) => rowPlace(state, id)), ['coordinator:c', 'thread:c', 'thread:c', 'coordinator:d', 'thread:d']);
    // No title places a row: not a "◆ " one, not a "<name> › " one; nor a thread value that names no chat.
    assert.deepEqual(['o', 'ot', 't1', 'plain', 'lost', 'missing'].map((id) => rowPlace(state, id)), ['', '', '', '', '', '']);
    assert.equal(rowPlace(undefined, 'c'), '');
    // Each row's mark says its role and the id of the chat it nests under, which the CSS and DSH's drags go by.
    const { RowPlace } = client.internals;
    const markOfRow = (id) => {
        const el = RowPlace({ sessionId: id, useSessions: (select) => select(state) });
        return el && [el.props['data-projects-row'], el.props['data-projects-of']];
    };
    assert.deepEqual(plain(['c', 't2', 'd', 't4', 'o', 't1'].map(markOfRow)), [['coordinator', 'c'], ['thread', 'c'], ['coordinator', 'd'], ['thread', 'd'], null, null]);

    // The groups drawn in a section, read from the marks in its rows: each coordinating chat there with its threads
    // there, at its wrapper's place (from 1), its threads in DSH's order; a chat without threads here, or a
    // thread whose chat is elsewhere, nests nothing.
    const { sectionGroups } = client.internals;
    const markOf = (mark) => (mark ? { getAttribute: (name) => ({ 'data-projects-row': mark[0], 'data-projects-of': mark[1] })[name] ?? null } : null);
    const rowEl = (key, mark) => ({ getAttribute: (name) => (name === 'data-row-key' ? key : null), querySelector: (sel) => (sel === '[data-projects-row]' ? markOf(mark) : null) });
    const wrap = (key, mark) => ({ children: [rowEl(key, mark)] });
    const section = {
        children: [
            wrap('workspace:w'), wrap('session:x'), wrap('session:t2', ['thread', 'c']), wrap('session:c', ['coordinator', 'c']),
            wrap('session:d', ['coordinator', 'd']), wrap('session:e', ['coordinator', 'e']), wrap('session:t1', ['thread', 'c']),
            wrap('session:et', ['thread', 'e']), wrap('session:far', ['thread', 'elsewhere']), { children: [] }, wrap('overflow:w'),
        ],
    };
    assert.deepEqual(plain(sectionGroups(section)), [
        { coordinator: 'c', at: 4, threads: ['t2', 't1'] },
        { coordinator: 'e', at: 6, threads: ['et'] },
    ]);
    assert.deepEqual(plain(sectionGroups(null)), []);

    // The rules find a section, each child's place and the nested threads by the plugin's marks (markNesting), never
    // by what an element holds: each ends in a mark or DSH's row key, so one row's change restyles that row, not the
    // list (1.8 s to 0.1 s at 300 chats with :has() rules that looked no deeper than a section's grandchildren; the
    // marks take the rest).
    const rules = nestingCss().split('\n');
    const S = '[role="tree"] div[data-projects-nests]';
    const T = `${S}>[data-projects-nested]`;
    for (const rule of rules) {
        assert.ok(rule.startsWith(S), rule);
        assert.doesNotMatch(rule.slice(0, rule.indexOf('{')), /:has\(|~|\+/, rule);
    }
    assert.ok(rules.includes(`${S}{display:flex;flex-direction:column}`));
    // Each order a mark can say has its rule, ten coordinating chats' worth; a section with more gets more.
    assert.equal(rules.filter((rule) => rule.includes('[data-projects-order=')).length, 30);
    assert.ok(rules.includes(`${S}>[data-projects-order="3"]{order:3}`));
    assert.equal(nestingCss(33).split('\n').filter((rule) => rule.includes('[data-projects-order=')).length, 33);
    assert.equal(nestingCss(12), nestingCss());
    // A child DSH adds goes last until the plugin's next pass gives it its place: DSH measures its rows for their
    // animation before that pass, and the rows Show more adds belong at the end.
    assert.ok(rules.includes(`${S}>:not([data-projects-order]){order:31}`));
    assert.ok(nestingCss(33).split('\n').includes(`${S}>:not([data-projects-order]){order:34}`));
    assert.ok(rules.includes(`${T}>[data-row-key]{padding-inline-start:calc(var(--dshp-nest,24px) + var(--dsh-workspace-indent,0px))}`));
    // The corner is drawn in the indent, not in the row's leading seat; the branch mark leaves the seat but is still read aloud.
    assert.ok(rules.some((rule) => rule.startsWith(`${T}::before{content:"";position:absolute;`)));
    assert.ok(rules.includes(`${T} .dshp-t-mark[data-projects-thread-mark=""]{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}`));
    // DSH's time (the row's third child, before its actions) leaves the row too, still read aloud, so the indent
    // doesn't cost the title its room; a status DSH writes there instead ("Approval") and the actions stay.
    assert.ok(rules.includes(`${T}>[data-row-key]>:nth-child(3):not(:last-child,[aria-hidden="true"]){position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}`));
    // Where each child is drawn: what DSH lists before the first coordinating chat stays first, then each such chat
    // where it is (the chat, its threads, what DSH lists after it), so two of them in one workspace stay apart.
    const keys = ['', 'x', 'a', 'y', 'at2', 'bt', 'b', 'z', 'at1'];
    assert.deepEqual(plain(nestedPlaces([{ coordinator: 'b', at: 7, threads: ['bt'] }, { coordinator: 'a', at: 3, threads: ['at1', 'at2'] }], keys)), {
        order: [0, 0, 1, 3, 2, 5, 4, 6, 2],
        nested: [false, false, false, false, true, true, false, false, true],
    });
    // Nothing to nest, or no place yet: nothing; a thread with no id is left out.
    assert.equal(nestedPlaces([], keys), null);
    assert.equal(nestedPlaces(undefined, keys), null);
    assert.equal(nestedPlaces([{ coordinator: 'a', at: 3, threads: [] }], keys), null);
    assert.equal(nestedPlaces([{ coordinator: 'a', at: 0, threads: ['at1'] }], keys), null);
    assert.equal(nestedPlaces([{ coordinator: '', at: 3, threads: ['at1'] }], keys), null);
    assert.equal(nestedPlaces([{ coordinator: 'a', at: 3, threads: ['at1'] }], []), null);
    assert.deepEqual(plain(nestedPlaces([{ coordinator: 'a', at: 3, threads: ['', 'at1'] }], keys).nested), [false, false, false, false, false, false, false, false, true]);
});

test('browser half: the plugin\'s mark gives way to any other mark in a row\'s leading seat, which never widens', () => {
    let css = '';
    const document = {
        addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null,
        createElement: () => ({ dataset: {} }), head: { appendChild: (tag) => { css = tag.textContent; } },
    };
    loadClient({ document });
    // Beside DSH's Automation task mark or another plugin's, in DSH's slot or in the seat itself, the plugin's mark
    // is hidden the screen-reader way (the row's description still says what it shows); alone, it is drawn. It is
    // the only rule that reaches into DSH's row, so nothing widens the seat or moves the other marks in it.
    const intoRow = css.split('}').filter((rule) => rule.includes('[data-row-key^="session:"]>'));
    assert.deepEqual(intoRow, [
        '[data-row-key^="session:"]>* .dshp-t-mark:not(:only-child),[data-row-key^="session:"]>* [data-slot]:not(:only-child)>.dshp-t-mark'
        + '{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0',
    ]);
});

test('browser half: a screen reader meets each coordinating chat\'s rows in drawn order, and hears the plugin\'s words after each title', () => {
    const { client } = loadClient();
    const { nestedPlaces, nestedOrder, markNesting, readInOrder, describeRows, markUnread, undoRows } = client.internals;
    // The order the CSS draws a section in: what DSH lists before the first coordinating chat, then each such chat,
    // its threads in DSH's order, and what DSH lists after it, by the orders the plugin's marks give.
    const groups = [{ coordinator: 'b', at: 6, threads: ['bt'] }, { coordinator: 'a', at: 2, threads: ['at1', 'at2'] }];
    const keys = ['x', 'a', 'y', 'at2', 'bt', 'b', 'z', 'at1', ''];
    assert.deepEqual(plain(nestedOrder(groups, keys)), [1, 2, 4, 8, 3, 6, 5, 7, 9]);
    assert.deepEqual(plain(nestedPlaces(groups, keys).order), [0, 1, 3, 2, 5, 4, 6, 2, 6]);
    // Nothing to nest, or DSH's own order already: nothing to reorder.
    assert.equal(nestedOrder([], keys), null);
    assert.equal(nestedOrder([{ coordinator: 'a', at: 1, threads: ['t'] }], ['a', 't', 'x']), null);
    assert.equal(nestedOrder(groups, []), null);

    // DSH's list: a section of wrappers, each holding a row; RowPlace's mark inside each coordinating chat's and thread's row.
    const place = (role, of, words) => new FakeEl('span', { 'data-projects-row': role, 'data-projects-of': of, 'data-projects-words': words });
    const row = (key, mark, attrs = {}) => new FakeEl('div', { 'data-row-key': key, role: 'treeitem', ...attrs }, mark ? [new FakeEl('span', {}, [mark])] : []);
    const wrap = (r, attrs = {}) => new FakeEl('span', attrs, [r]);
    const rows = {
        head: row('workspace:w'), chat: row('session:chat'),
        t2: row('session:t2', place('thread', 'c', 'Thread: Failed')), c: row('session:c', place('coordinator', 'c', 'Coordinating')),
        late: row('session:late'), t1: row('session:t1', place('thread', 'c', 'Thread')),
        old: row('session:old', place('thread', 'c', 'Thread'), { 'aria-description': 'Archived' }),
    };
    const kids = [wrap(rows.head), wrap(rows.chat), wrap(rows.t2), wrap(rows.c, { id: 'dsh-own' }), wrap(rows.late), wrap(rows.t1), wrap(rows.old)];
    const section = new FakeEl('div', {}, kids);
    const tree = new FakeEl('div', { role: 'tree' }, [section]);
    // The CSS's marks: the section nests; each child its order (0 for what DSH lists before the coordinating chat, so only a
    // child DSH added since the last pass has none); the threads' wrappers nested. The highest order sizes the sheet.
    const marks = () => plain(kids.map((k) => [k.getAttribute('data-projects-order'), k.hasAttribute('data-projects-nested')]));
    assert.equal(markNesting(tree), 3);
    assert.equal(section.getAttribute('data-projects-nests'), '');
    assert.deepEqual(marks(), [['0', false], ['0', false], ['2', true], ['1', false], ['3', false], ['2', true], ['2', true]]);
    assert.equal(markNesting(tree), 3, 'a second pass changes nothing');
    assert.deepEqual(marks(), [['0', false], ['0', false], ['2', true], ['1', false], ['3', false], ['2', true], ['2', true]]);
    // A chat DSH adds after the coordinating chat has no order until the next pass, which puts it after that chat's threads.
    const fresh = wrap(row('session:fresh'));
    section.children = [...kids, fresh];
    assert.equal(fresh.getAttribute('data-projects-order'), null);
    markNesting(tree);
    assert.equal(fresh.getAttribute('data-projects-order'), '3');
    section.children = kids;
    markNesting(tree);
    assert.deepEqual(marks(), [['0', false], ['0', false], ['2', true], ['1', false], ['3', false], ['2', true], ['2', true]]);
    readInOrder(tree);
    // The section owns its children in drawn order: the coordinating chat, its threads, then the chat DSH lists after it.
    // A child keeps an id it has; the others get the plugin's.
    const ids = section.getAttribute('aria-owns').split(' ');
    assert.deepEqual(plain(ids.map((id) => kids.findIndex((k) => k.id === id))), [0, 1, 3, 2, 5, 6, 4]);
    assert.equal(kids[3].id, 'dsh-own');
    assert.ok(kids.filter((k, i) => i !== 3).every((k) => k.id.startsWith('dshp-o-')));
    assert.ok(section.hasAttribute('data-projects-owns'));
    // Each coordinating chat's and thread's row says its words as its description; a description DSH gave a row is DSH's and stays.
    describeRows(tree);
    assert.equal(rows.t2.getAttribute('aria-description'), 'Thread: Failed');
    assert.equal(rows.c.getAttribute('aria-description'), 'Coordinating');
    assert.equal(rows.old.getAttribute('aria-description'), 'Archived');
    assert.equal(rows.chat.getAttribute('aria-description'), null);
    // The words change with the row; DSH taking a row's description back keeps its own; words gone, description gone.
    rows.t2.children[0].children[0].setAttribute('data-projects-words', 'Thread');
    rows.c.setAttribute('aria-description', 'Archived');
    rows.t1.children[0].children[0].setAttribute('data-projects-words', '');
    describeRows(tree);
    assert.equal(rows.t2.getAttribute('aria-description'), 'Thread');
    assert.equal(rows.c.getAttribute('aria-description'), 'Archived');
    assert.equal(rows.c.getAttribute('data-projects-said'), null);
    assert.equal(rows.t1.getAttribute('aria-description'), null);
    // A coordinating chat with news the user hasn't seen: its row is marked (the CSS makes it bold), and unmarked when it's read.
    const news = rows.c.children[0].children[0];
    news.setAttribute('data-projects-unread', '2');
    markUnread(tree);
    assert.deepEqual([rows.c.getAttribute('data-projects-unread-row'), rows.t2.getAttribute('data-projects-unread-row')], ['', null]);
    news.removeAttribute('data-projects-unread');
    markUnread(tree);
    assert.equal(rows.c.hasAttribute('data-projects-unread-row'), false);
    news.setAttribute('data-projects-unread', '1');
    markUnread(tree);
    // A thread that leaves the section (or DSH drawing the chat and its threads in its own order) ends the plugin's order there.
    section.children = section.children.filter((k) => k !== kids[2] && k !== kids[5] && k !== kids[6]);
    readInOrder(tree);
    assert.equal(section.getAttribute('aria-owns'), null);
    assert.equal(section.hasAttribute('data-projects-owns'), false);
    assert.equal(kids[3].id, 'dsh-own');
    assert.equal(kids[1].id, '');
    assert.equal(markNesting(tree), 0);
    assert.equal(section.hasAttribute('data-projects-nests'), false);
    assert.ok(section.children.every((k) => !k.hasAttribute('data-projects-order') && !k.hasAttribute('data-projects-nested')));
    // A list drawn as one flat list (the rows' section is the list itself) is never reordered: the CSS doesn't nest it.
    const flat = new FakeEl('div', { role: 'tree' }, [wrap(row('session:x')), wrap(row('session:t9', place('thread', 'c9', 'Thread'))), wrap(row('session:c9', place('coordinator', 'c9', 'Coordinating')))]);
    readInOrder(flat);
    assert.equal(flat.getAttribute('aria-owns'), null);
    assert.equal(markNesting(flat), 0);
    assert.equal(flat.hasAttribute('data-projects-nests'), false);
    assert.ok(flat.children.every((k) => !k.hasAttribute('data-projects-order') && !k.hasAttribute('data-projects-nested')));
    // Switched off: the list as DSH draws it, DSH's own descriptions kept, none of the plugin's marks.
    section.children = kids;
    markNesting(tree);
    readInOrder(tree);
    describeRows(tree);
    assert.ok(section.hasAttribute('aria-owns'));
    assert.ok(section.hasAttribute('data-projects-nests'));
    undoRows(tree);
    assert.equal(section.getAttribute('aria-owns'), null);
    assert.ok(kids.every((k, i) => i === 3 || k.id === ''));
    assert.equal(rows.t2.getAttribute('aria-description'), null);
    assert.equal(rows.old.getAttribute('aria-description'), 'Archived');
    assert.equal(rows.c.getAttribute('aria-description'), 'Archived');
    assert.equal(section.hasAttribute('data-projects-nests'), false);
    assert.deepEqual(marks(), kids.map(() => [null, false]));
    assert.equal(rows.c.hasAttribute('data-projects-unread-row'), false);
});

test('browser half: the session list overlay looks only for DSH\'s own list, and draws nothing but a refusal\'s toast', () => {
    const asked = [];
    const document = {
        addEventListener: () => {}, removeEventListener: () => {}, createElement: () => ({ dataset: {} }), head: { appendChild: () => {} },
        querySelector: (selector) => { asked.push(selector); return null; },
    };
    const { client, react } = loadClient({ document });
    asked.length = 0;
    react.useLayoutEffect = () => {};
    const { SessionList, SIDEBAR } = client.internals;
    // No list in the window yet: nothing to watch or nest, and nothing drawn.
    assert.equal(mount(react, () => SessionList({ useWorkspaces: (select) => select({ pinnedSessionIds: ['c'] }) }))(), null);
    assert.equal(mount(react, () => SessionList({}))(), null);
    assert.deepEqual([...new Set(asked)], ['[data-slot="sidebar.workspaces"] [role="tree"]']);
    // What it says when it refuses a drag speaks of threads and chats only.
    assert.deepEqual(Object.keys(SIDEBAR), ['threadStays', 'chatOut', 'coordinatorIn', 'chatStays', 'coordinatorStays']);
    for (const text of Object.values(SIDEBAR)) assert.doesNotMatch(text, /categor|project|◆/i);
});

test('browser half: a thread opens beside its coordinator, and in full view where the window is too narrow or when asked', async () => {
    const { client } = loadClient();
    const { roomFor } = client.internals;
    // DSH's own rule: a 400 px main chat and a 300 px right sidebar beside the left sidebar; under 768 px it covers the window.
    assert.equal(roomFor(1280, 280), true);
    assert.equal(roomFor(980, 280), true);
    assert.equal(roomFor(979, 280), false);
    assert.equal(roomFor(1100, 418), false);
    assert.equal(roomFor(1118, 418), true);
    assert.equal(roomFor(1713, 418), true);
    assert.equal(roomFor(768, 0), true);
    assert.equal(roomFor(767, 0), false);

    const coordValue = { role: 'coordinator', project: { name: 'P' }, threads: [] };
    const threadValue = { role: 'thread', coordinator: 'c', thread: { id: 't1' } };
    const row = (value, main = 0) => ({ title: 'x', ...(value ? { projectionValues: { coordinatorSession: value } } : {}), retainedBy: { mainView: main } });
    let snapshot = { ids: ['c', 't', 'p'], byId: { c: row(coordValue), t: row(threadValue), p: row(null, 1) }, phase: 'ready', projectionsBySession: {} };
    const listeners = new Set();
    const set = (byId) => { snapshot = { ...snapshot, byId: { ...snapshot.byId, ...byId } }; for (const fn of [...listeners]) fn(); };
    const opened = [];
    const beside = [];
    const holds = [];
    const registered = [];
    const ctx = {
        effect: (fn) => fn(),
        inject: (names, fn) => { if (!names.includes('configForms')) fn(ctx); },
        slots: { inject: (_name, fn) => fn(), register: (slot) => { registered.push(slot); return () => {}; } },
        resources: { register: () => () => {} },
        sidebarRightTabs: { register: () => () => {} },
        sessions: {
            list: { getSnapshot: () => snapshot, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
            retain: (id, options) => { holds.push([id, options.source]); set({ [id]: { ...snapshot.byId[id], retainedBy: { mainView: (snapshot.byId[id].retainedBy.mainView ?? 0) + 1 } } }); return { release: () => holds.push(['release', id]) }; },
        },
        // DSH's main view: the chat it opens takes the hold, the one before lets go.
        uiWorkspace: {
            openSession: (id) => {
                opened.push(id);
                const byId = {};
                for (const [key, value] of Object.entries(snapshot.byId)) byId[key] = { ...value, retainedBy: { mainView: key === id ? 1 : 0 } };
                set(byId);
            },
        },
        sidebarRight: { mounted: { getSnapshot: () => 'c' }, openResource: (address, options) => beside.push([decodeURIComponent(address.split('/').pop()), options.kind]) },
    };
    client.apply(ctx);
    const { projects } = registered.find((r) => r.id === 'dsh-plugin-coordinator/threads-menu').inject();
    // A thread from a card or a row: the chat that started it as the main chat, the thread beside it.
    projects.openThread('t');
    assert.deepEqual(opened, ['c']);
    assert.deepEqual(beside, [['t', 'projectthread']]);
    // Any other chat opens as itself; Full view opens the thread as the main chat.
    projects.openThread('p');
    projects.openFull('t');
    assert.deepEqual(opened, ['c', 'p', 't']);
    assert.equal(beside.length, 1);

    // DSH opening a thread itself (its session list, its search): the plugin holds the coordinator while DSH switches,
    // then the coordinator takes the thread's place and the thread opens beside it.
    ctx.uiWorkspace.openSession('p');
    opened.length = 0;
    beside.length = 0;
    set({ t: { ...snapshot.byId.t, retainedBy: { mainView: 1 } } });
    assert.deepEqual(holds, [['c', 'mainView']]);
    set({ p: { ...snapshot.byId.p, retainedBy: { mainView: 0 } } });
    assert.deepEqual(opened, ['c']);
    assert.deepEqual(holds, [['c', 'mainView'], ['release', 'c']]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(beside, [['t', 'projectthread']]);
    // A thread opened in full view stays the main chat.
    holds.length = 0;
    opened.length = 0;
    beside.length = 0;
    projects.openFull('t');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([opened, holds, beside], [['t'], [], []]);
});

test('browser half: a thread opened beside its coordinator, or from the Threads panel, takes the place of the thread tab already there', () => {
    const { client } = loadClient();
    const coordValue = { role: 'coordinator', project: { name: 'P' }, threads: [] };
    const thread = (id) => ({ role: 'thread', coordinator: 'c', thread: { id } });
    const row = (value, main = 0) => ({ title: 'x', ...(value ? { projectionValues: { coordinatorSession: value } } : {}), retainedBy: { mainView: main } });
    const snapshot = { ids: ['c', 't1', 't2', 't3'], byId: { c: row(coordValue, 1), t1: row(thread('t1')), t2: row(thread('t2')), t3: row(thread('t3')) }, phase: 'ready', projectionsBySession: {} };
    const address = (id) => `dsh-resource://projectthread/session/${encodeURIComponent(id)}`;
    let tabs = [];
    let front;
    const placed = [];
    const registered = [];
    const ctx = {
        effect: (fn) => fn(),
        inject: (names, fn) => { if (!names.includes('configForms')) fn(ctx); },
        slots: { inject: (_name, fn) => fn(), register: (slot) => { registered.push(slot); return () => {}; } },
        resources: { register: () => () => {} },
        sidebarRightTabs: { register: () => () => {} },
        sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} }, retain: () => ({ release() {} }) },
        uiWorkspace: { openSession: () => {} },
        sidebarRight: {
            mounted: { getSnapshot: () => 'c' },
            tabsIn: (id) => (id === 'c' ? tabs : []),
            active: () => front,
            openResource: (at, options) => placed.push([decodeURIComponent(at.split('/').pop()), options.kind, options.replaceTab ?? null]),
        },
    };
    client.apply(ctx);
    const { projects } = registered.find((r) => r.id === 'dsh-plugin-coordinator/threads-menu').inject();
    // The first thread gets a tab; opened again, DSH brings that tab to the front.
    projects.openThread('t1');
    tabs = [{ id: 'a', kind: 'projectthread', contentId: address('t1') }];
    projects.openThread('t1');
    // Another thread takes the place of the thread tab in front, else of the newest one (here the Threads panel is in front).
    projects.openThread('t2');
    tabs = [{ id: 'a', kind: 'projectthread', contentId: address('t1') }, { id: 'p', kind: 'projectthreads', contentId: 'dsh-resource://page/projectthreads' },
        { id: 'b', kind: 'projectthread', contentId: address('t2') }];
    front = { id: 'a' };
    projects.openThread('t3');
    front = { id: 'p' };
    projects.openThread('t3');
    assert.deepEqual(placed, [['t1', 'projectthread', null], ['t1', 'projectthread', null], ['t2', 'projectthread', 'a'], ['t3', 'projectthread', 'a'], ['t3', 'projectthread', 'b']]);

    // From the Threads panel (in front, in the coordinator's sidebar): the newest thread tab gives way and the panel stays.
    placed.length = 0;
    assert.equal(projects.replaceThreadTab('c', 't3'), true);
    assert.deepEqual(placed, [['t3', 'projectthread', 'b']]);
    // The panel opens the thread its own way when there's none to replace, the thread is there already, or its sidebar isn't on screen.
    assert.equal(projects.replaceThreadTab('c', 't2'), false);
    assert.equal(projects.replaceThreadTab('t1', 't3'), false);
    tabs = [{ id: 'p', kind: 'projectthreads', contentId: 'dsh-resource://page/projectthreads' }];
    assert.equal(projects.replaceThreadTab('c', 't3'), false);
    assert.equal(placed.length, 1);
});

test('browser half: with "Open threads beside their coordinator" off, a thread opens on its own and its menus pair it', async () => {
    const storage = new Map([['dsh-plugin-coordinator/open-beside', 'off']]);
    const { client } = loadClient({ storage });
    const { besidePref } = client.internals;
    assert.equal(besidePref.get(), false);
    const coordValue = { role: 'coordinator', project: { name: 'P' }, threads: [] };
    const threadValue = { role: 'thread', coordinator: 'c', thread: { id: 't1' } };
    const row = (value, main = 0) => ({ title: 'x', ...(value ? { projectionValues: { coordinatorSession: value } } : {}), retainedBy: { mainView: main } });
    let snapshot = { ids: ['c', 't', 'p'], byId: { c: row(coordValue), t: row(threadValue), p: row(null, 1) }, phase: 'ready', projectionsBySession: {} };
    const listeners = new Set();
    const set = (byId) => { snapshot = { ...snapshot, byId: { ...snapshot.byId, ...byId } }; for (const fn of [...listeners]) fn(); };
    const opened = [];
    const beside = [];
    const holds = [];
    const registered = [];
    const ctx = {
        effect: (fn) => fn(),
        inject: (names, fn) => { if (!names.includes('configForms')) fn(ctx); },
        slots: { inject: (_name, fn) => fn(), register: (slot, component) => { registered.push({ slot, component }); return () => {}; } },
        resources: { register: () => () => {} },
        sidebarRightTabs: { register: () => () => {} },
        sessions: {
            list: { getSnapshot: () => snapshot, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
            retain: (id, options) => { holds.push([id, options.source]); return { release: () => holds.push(['release', id]) }; },
        },
        uiWorkspace: {
            openSession: (id) => {
                opened.push(id);
                const byId = {};
                for (const [key, value] of Object.entries(snapshot.byId)) byId[key] = { ...value, retainedBy: { mainView: key === id ? 1 : 0 } };
                set(byId);
            },
        },
        sidebarRight: { mounted: { getSnapshot: () => 'c' }, openResource: (address, options) => beside.push([decodeURIComponent(address.split('/').pop()), options.kind]) },
    };
    client.apply(ctx);
    const { projects } = registered.find((r) => r.slot.id === 'dsh-plugin-coordinator/threads-menu').slot.inject();
    // A thread from a row or a card's name opens as the main chat, as before the setting.
    projects.openThread('t');
    assert.deepEqual([opened, beside], [['t'], []]);
    // The card's Open, and "Open beside its coordinator", still pair it.
    projects.openPaired('t');
    assert.deepEqual([opened, beside], [['t', 'c'], [['t', 'projectthread']]]);
    // DSH opening a thread itself (its session list, its search): it stays as DSH opened it.
    ctx.uiWorkspace.openSession('p');
    opened.length = 0;
    beside.length = 0;
    set({ t: { ...snapshot.byId.t, retainedBy: { mainView: 1 } } });
    set({ p: { ...snapshot.byId.p, retainedBy: { mainView: 0 } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([opened, holds, beside], [[], [], []]);
    // A thread's menu in the session list offers to pair it, even while it is the main chat.
    const item = registered.find((r) => r.slot.id === 'dsh-plugin-coordinator/full-view-item');
    const menuItem = () => item.component({ sessionId: 't', useMenuOpenState: () => [true, () => {}], useSessions: (select) => select(snapshot), ...item.slot.inject() });
    let shown = menuItem();
    assert.deepEqual(shown.children, ['Open beside its coordinator']);
    shown.props.onSelect();
    assert.deepEqual([opened, beside], [['c'], [['t', 'projectthread']]]);

    // Turned on (the plugin page's switch): kept for the next start, and threads pair again.
    besidePref.set(true);
    assert.equal(storage.get('dsh-plugin-coordinator/open-beside'), 'on');
    shown = menuItem();
    assert.deepEqual(shown.children, ['Open in full view']);
    opened.length = 0;
    beside.length = 0;
    projects.openThread('t');
    assert.deepEqual([opened, beside], [['c'], [['t', 'projectthread']]]);
    besidePref.set(false);
    assert.equal(storage.get('dsh-plugin-coordinator/open-beside'), 'off');
    // No storage at all (a locked-down window): on.
    assert.equal(loadClient().client.internals.besidePref.get(), true);
});

test('browser half: a click on a thread row in DSH\'s session list opens the pair straight away, so DSH never shows the thread first', () => {
    let onClick;
    const document = {
        addEventListener: (type, fn, capture) => { if (type === 'click' && capture === true) onClick = fn; },
        removeEventListener: () => {}, querySelector: () => null,
        createElement: () => ({ dataset: {} }), head: { appendChild: () => {} },
    };
    const storage = new Map();
    const { client, window } = loadClient({ document, innerWidth: 1440, storage });
    const coordValue = { role: 'coordinator', project: { name: 'P' }, threads: [] };
    const threadValue = { role: 'thread', coordinator: 'c', thread: { id: 't1' } };
    const row = (value, main = 0) => ({ title: 'x', ...(value ? { projectionValues: { coordinatorSession: value } } : {}), retainedBy: { mainView: main } });
    const snapshot = { ids: ['c', 't', 'p'], byId: { c: row(coordValue), t: row(threadValue), p: row(null, 1) }, phase: 'ready', projectionsBySession: {} };
    const opened = [];
    const beside = [];
    const ctx = {
        effect: (fn) => fn(),
        inject: (names, fn) => { if (!names.includes('configForms')) fn(ctx); },
        slots: { inject: (_name, fn) => fn(), register: () => () => {} },
        resources: { register: () => () => {} },
        sidebarRightTabs: { register: () => () => {} },
        sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} }, retain: () => ({ release: () => {} }) },
        uiWorkspace: { openSession: (id) => opened.push(id) },
        sidebarRight: { mounted: { getSnapshot: () => 'c' }, openResource: (address, options) => beside.push([decodeURIComponent(address.split('/').pop()), options.kind]) },
    };
    client.apply(ctx);
    assert.equal(typeof onClick, 'function', 'one capturing listener for the whole window');
    // A click on a row of DSH's list (data-row-key="session:<id>"), or on a button inside it.
    const click = (id, { inButton = false, ...event } = {}) => {
        const rowEl = { getAttribute: (name) => (name === 'data-row-key' ? `session:${id}` : null), contains: () => true };
        const target = { closest: (selector) => (selector.includes('data-row-key') ? rowEl : inButton ? { button: true } : null) };
        const e = { button: 0, defaultPrevented: false, target, prevented: false, stopped: false, ...event };
        e.preventDefault = () => { e.prevented = true; };
        e.stopPropagation = () => { e.stopped = true; };
        onClick(e);
        return e.prevented && e.stopped;
    };
    // A thread: its coordinator as the main chat and the thread beside it, without DSH opening the thread first.
    assert.equal(click('t'), true);
    assert.deepEqual([opened, beside], [['c'], [['t', 'projectthread']]]);
    // DSH's as before: another chat, the row's own buttons, a modifier key, another mouse button, a click already handled.
    opened.length = 0;
    beside.length = 0;
    assert.deepEqual([click('p'), click('t', { inButton: true }), click('t', { metaKey: true }), click('t', { button: 1 }), click('t', { defaultPrevented: true })],
        [false, false, false, false, false]);
    // Also when the window has no room for both, or the setting is off.
    window.innerWidth = 700;
    assert.equal(click('t'), false);
    window.innerWidth = 1440;
    client.internals.besidePref.set(false);
    assert.equal(click('t'), false);
    client.internals.besidePref.set(true);
    // And for the thread that is already the main chat (full view).
    snapshot.byId = { ...snapshot.byId, t: row(threadValue, 1), p: row(null, 0) };
    assert.equal(click('t'), false);
    assert.deepEqual([opened, beside], [[], []]);
});

test('browser half: a thread\'s newest card says when its last turn ended, and how many times in a row', () => {
    const { client } = loadClient();
    const { ThreadCard, clockOf, againText } = client.internals;
    const now = Date.parse('2026-10-10T18:30:00');
    assert.deepEqual([clockOf(Date.parse('2026-10-10T14:58:00'), now), clockOf(Date.parse('2026-10-09T09:05:00'), now), clockOf(Date.parse('2025-12-31T23:59:00'), now), clockOf(NaN, now)],
        ['14:58', 'Oct 9, 09:05', 'Dec 31, 2025, 23:59', '']);
    assert.deepEqual([1, 2, 3, undefined].map(againText), ['', 'twice', '3 times', '']);
    const at = new Date(Date.now() - 60000);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const projects = { openThread: () => {}, openPaired: () => {}, openFull: () => {}, openReview: () => {}, facts: { continueThread: async () => ({ ok: true }) } };
    const view = (ending, state) => ({
        key: 't7', kind: 'idle', threadId: 't7', seq: 5, newest: true, title: 'Generate size-guide tables', session: 's-t7', verb: 'Ended without a handback', icon: 'IconWarningTriangleOutlineRegular',
        state, row: { id: 't7', session: 's-t7', title: 'Generate size-guide tables', ending },
    });
    const failed = { state: 'failed', kind: 'error', message: 'The model rejected the request.', turn: 3, seq: 9, at: at.toISOString() };
    // Failed once: the state once, beside the name; the time and the reason under it; Retry.
    let card = ThreadCard({ view: view(failed, { dot: 'error', label: 'Failed' }), projects });
    assert.deepEqual([textIn(byClass(card, 'dshp-t-card-state-label')), textIn(byClass(card, 'dshp-t-card-state-text')), textIn(byClass(card, 'dshp-t-card-why'))],
        ['Failed', 'Failed', `${hhmm} · The model rejected the request.`]);
    assert.equal(elementsOf(card).find((e) => e.props?.['data-projects-continue'])?.props['data-projects-continue'], 'retry');
    // Retried and failed again: it says so, and the time moves on.
    card = ThreadCard({ view: view({ ...failed, times: 2, turn: 4 }, { dot: 'error', label: 'Failed' }), projects });
    assert.deepEqual([textIn(byClass(card, 'dshp-t-card-state-label')), textIn(byClass(card, 'dshp-t-card-state-text'))], ['Failed', 'Failed twice']);
    // Stopped by the user: when, and that they did.
    card = ThreadCard({ view: view({ state: 'stopped', kind: 'aborted', cause: 'user', turn: 3, seq: 9, at: at.toISOString() }, { dot: 'idle', label: 'Stopped' }), projects });
    assert.equal(textIn(byClass(card, 'dshp-t-card-why')), `${hhmm} · You stopped it.`);
    // Stopped with no reason to give: just when.
    card = ThreadCard({ view: view({ state: 'stopped', kind: 'aborted', turn: 3, seq: 9, at: at.toISOString() }, { dot: 'idle', label: 'Stopped' }), projects });
    assert.equal(textIn(byClass(card, 'dshp-t-card-why')), hhmm);
    // A card that isn't the thread's newest says none of it.
    card = ThreadCard({ view: { ...view(failed, { dot: 'error', label: 'Failed' }), newest: false }, projects });
    assert.deepEqual([byClass(card, 'dshp-t-card-why').length, textIn(byClass(card, 'dshp-t-card-state-text'))], [0, 'Failed']);
});

test('browser half: a thread\'s newest card says what it is doing (its step, how far along, how long) or what it reported, never its state twice', () => {
    const { client } = loadClient();
    const { ThreadCard, CardDetail, progressOf, elapsedText, handbackGist, cardDetail, threadRow, pendingAsk } = client.internals;
    const todos = [
        { content: 'Build the fr-FR glossary', status: 'completed' }, { content: 'Translate pages 1–120', status: 'completed' },
        { content: 'Translate   pages 121–240', status: 'in_progress' }, { content: 'Review size names', status: 'pending' },
    ];
    // DSH's to-do list: how many are done, and the step in progress.
    assert.deepEqual(plain(progressOf(todos)), { done: 2, total: 4, current: 'Translate pages 121–240' });
    assert.deepEqual(plain(progressOf([{ content: 'A', status: 'completed' }, { content: ' ', status: 'pending' }, null, { status: 'pending' }])), { done: 1, total: 1 });
    assert.deepEqual([progressOf(null), progressOf([]), progressOf('x')], [undefined, undefined, undefined]);
    assert.deepEqual([0, 45000, 192000, 3840000, -1, NaN].map(elapsedText), ['0s', '45s', '3m 12s', '1h 4m', '', '']);
    // A handback's summary without its state ahead of it.
    assert.deepEqual([
        handbackGist({ status: 'blocked', summary: 'Blocked: the CDN token\n expired.' }), handbackGist({ status: 'done', summary: 'Done' }),
        handbackGist({ status: 'done', summary: 'Doneness checks pass.' }), handbackGist({ status: 'needs_decision', summary: 'Fix A or fix B?' }), handbackGist({}),
    ], ['The CDN token expired.', '', 'Doneness checks pass.', 'Fix A or fix B?', '']);

    const T = Date.parse('2026-10-11T12:00:00Z');
    const row = (extra) => ({ id: 't10', session: 's10', title: 'Translate product pages', entry: { id: 't10' }, ...extra });
    const view = (r, extra = {}) => ({ key: 't10', kind: 'start', threadId: 't10', seq: 4, newest: true, title: r.title, session: 's10', verb: 'Started a thread', icon: 'IconBranchOutlineRegular', state: { dot: 'ongoing', label: 'Running' }, row: r, ...extra });
    // Running: its step, how far along and how long its turn has run.
    const running = row({ running: true });
    assert.deepEqual(plain(cardDetail(view(running), { todos, turnAt: T - 192000 }, T)), { kind: 'running', progress: { done: 2, total: 4, current: 'Translate pages 121–240' }, step: 'Translate pages 121–240', elapsed: '3m 12s' });
    // Without a list: its progress handback, else only the time; with nothing at all, no line.
    const progressing = row({ running: true, entry: { id: 't10', handback: { status: 'progress', summary: 'Progress update: halfway, 120 of 240.' } } });
    assert.deepEqual(plain(cardDetail(view(progressing), { turnAt: T - 5000 }, T)), { kind: 'running', step: 'Halfway, 120 of 240.', elapsed: '5s' });
    assert.deepEqual(plain(cardDetail(view(running), { turnAt: T }, T)), { kind: 'running', elapsed: '0s' });
    assert.equal(cardDetail(view(running), undefined, T), undefined);
    // Reported: what it said. Waiting on you: what it asks, and that it waits unless the card says so already. A failed or stopped turn has its own line.
    const told = row({ entry: { id: 't10', handback: { status: 'blocked', summary: 'Blocked: the CDN token expired.' } } });
    assert.deepEqual(plain(cardDetail(view(told), undefined, T)), { kind: 'told', text: 'The CDN token expired.' });
    const waiting = row({ running: true, pending: true, pendingInteraction: { kind: 'approval' } });
    assert.deepEqual(plain(cardDetail(view(waiting), { todos, turnAt: T }, T)), { kind: 'pending', text: 'Waiting for your approval' });
    assert.equal(cardDetail(view(waiting, { kind: 'approval' }), undefined, T), undefined);
    // What it asks is what DSH's prompt says: an approval's reason, a question.
    const reason = { kind: 'approval', toolName: 'shell', reason: 'escalate sandbox', displayReason: { en: 'Allow this operation with\n full access: npm install stripe', zh: '…' } };
    const asking = row({ running: true, pending: true, pendingInteraction: reason });
    assert.deepEqual(plain(cardDetail(view(asking), undefined, T)), { kind: 'pending', text: 'Waiting for your approval · Allow this operation with full access: npm install stripe' });
    assert.deepEqual(plain(cardDetail(view(asking, { kind: 'approval' }), undefined, T)), { kind: 'pending', text: 'Allow this operation with full access: npm install stripe' });
    assert.deepEqual([
        pendingAsk({ kind: 'approval', reason: ' tool "shell" requires approval ' }), pendingAsk({ kind: 'question', questions: [{ id: 'a', question: ' ' }, { id: 'b', question: 'Ship fix A or fix B?' }] }),
        pendingAsk({ kind: 'question', questions: [] }), pendingAsk({ kind: 'approval' }), pendingAsk(undefined),
    ], ['tool "shell" requires approval', 'Ship fix A or fix B?', '', '', '']);
    assert.equal(cardDetail(view(row({ ending: { state: 'failed' }, entry: told.entry })), undefined, T), undefined);

    // Drawn: a meter with how many steps are done, the step, and the clock; the reader hears it as words.
    const line = CardDetail({ detail: cardDetail(view(running), { todos, turnAt: T - 192000 }, T) });
    const meter = elementsOf(line).find((e) => e.props?.role === 'progressbar');
    assert.deepEqual(plain([line.props['data-projects-card-detail'], line.props.title, meter.props['aria-valuenow'], meter.props['aria-valuemax'], meter.props['aria-valuetext'], meter.children[0].props.style.width]),
        ['running', '2 of 4 steps done · Translate pages 121–240 · running 3m 12s', 2, 4, '2 of 4', '50%']);
    assert.deepEqual([textIn(byClass(line, 'dshp-t-card-count')), textIn(byClass(line, 'dshp-t-card-step')), textIn(byClass(line, 'dshp-t-card-elapsed'))], ['2/4', 'Translate pages 121–240', '3m 12s']);
    assert.equal(textIn(line), '2/4·Translate pages 121–240·3m 12s');
    // On the card: under its name, only on the thread's newest card; no word twice.
    const projects = { openThread: () => {}, openPaired: () => {}, openFull: () => {}, facts: { continueThread: async () => ({ ok: true }) } };
    const detailOf = (c) => elementsOf(c).find((e) => e.type === CardDetail);
    let card = ThreadCard({ view: { ...view(told, { state: { dot: 'blocked', label: 'Blocked' } }) }, projects });
    const drawn = CardDetail(detailOf(card).props);
    assert.deepEqual([textIn(drawn), drawn.props['data-projects-card-detail']], ['The CDN token expired.', 'told']);
    const words = `${textIn(card)} ${textIn(drawn)}`.toLowerCase().match(/[a-z]+/g);
    assert.equal(new Set(words).size, words.length, `a word twice: ${words.join(' ')}`);
    card = ThreadCard({ view: { ...view(told), newest: false }, projects });
    assert.equal(detailOf(card), undefined);
    // A failed turn's own line wins over it.
    card = ThreadCard({ view: view(row({ ending: { state: 'failed', kind: 'error', message: 'No key.', at: new Date().toISOString() }, entry: told.entry }), { state: { dot: 'error', label: 'Failed' } }), projects });
    assert.deepEqual([detailOf(card), byClass(card, 'dshp-t-card-why').length], [undefined, 1]);

    // The Threads menu and panel: a running row with a list says how far along it is.
    const statuses = new Map([['s10', { running: true }]]);
    const live = { s10: { todos, turnAt: T } };
    assert.equal(threadRow({ id: 't10', session: 's10', title: 'Translate' }, statuses, {}, {}, live).line, '2/4 · Translate pages 121–240');
    assert.equal(threadRow({ id: 't10', session: 's10', title: 'Translate' }, statuses, {}, {}, { s10: { todos: [{ content: 'A', status: 'completed' }] } }).line, '1 of 1 steps done');
    assert.equal(threadRow({ id: 't10', session: 's10', title: 'Translate' }, statuses, {}, {}, undefined).line, 'Working…');
    // And a row waiting on you says what it asks.
    const asked = new Map([['s10', { running: true, pendingInteraction: { kind: 'question', questions: [{ id: 'q', question: 'Which locale first?' }] } }]]);
    assert.equal(threadRow({ id: 't10', session: 's10', title: 'Translate' }, asked, {}, {}, live).line, 'Has a question for you · Which locale first?');
});

test('browser half: the plugin\'s messages get a notice that names them, without the note to the coordinator', () => {
    const { client } = loadClient();
    const { noticeOf } = client.internals;
    const data = (text, kind = 'agent-message') => ({ content: [{ type: 'text', text }], source: { kind }, time: 1 });
    const handback = handbackMessage('t1', 'Add CI', 'done', 'CI added.', { last: true });
    assert.deepEqual(plain(noticeOf(data(handback))), { kind: 'handback', thread: 't1', name: 'Add CI', status: 'done', body: 'CI added.' });
    assert.deepEqual(plain(noticeOf(data(idleMessage('t3', 'Flaky', '', 'The turn failed (HTTP 500): boom'), 'cordis-host-runner'))),
        { kind: 'idle', thread: 't3', name: 'Flaky', status: 'failed', body: 'The turn failed (HTTP 500): boom\n\nIt produced no reply text.' });
    assert.equal(noticeOf(data(approvalMessage('t4', 'Deploy', 'Deploy', 'shell', 'rm -rf build'), 'cordis-host-runner')).body,
        'It asked to use shell: rm -rf build\n\nThe user approves or rejects it in the "Deploy" session.');
    // A welcome an earlier version sent when it made a coordinator keeps DSH's own notice: nothing sends one now.
    assert.equal(noticeOf(data('[Project created: "Recipes"]\n\nThis is the first message in this coordinator session.', 'cordis-host-runner')), undefined);
    // A message from another coordinating chat, and the answer it brings back.
    assert.deepEqual(plain(noticeOf(data(outsideMessage('DSH Plugins', 'Tell Fix login.', 'Main is green.')))),
        { kind: 'message', project: 'DSH Plugins', body: 'The user asked: "Tell Fix login."\n\nMain is green.' });
    // A thread's brief names its chat, and what that chat sends it later is the coordinator's.
    const brief = noticeOf(data(briefMessage('DSH Plugins', 't2', 'Docs', 'Write the docs.', 'Please write the docs.')));
    assert.deepEqual([brief.kind, brief.project, brief.thread, brief.name], ['brief', 'DSH Plugins', 't2', 'Docs']);
    assert.equal(noticeOf(data(coordinatorMessage('Also the README.', 'Please also do the README.'))).kind, 'coordinator');
    assert.deepEqual(plain(noticeOf(data(replyMessage('"Fix login"', 'Thanks.')))), { kind: 'reply', name: 'Fix login', status: '', body: 'Thanks.' });
    // A chat an earlier version named with its "◆ " mark reads by its name alone.
    assert.deepEqual(plain(noticeOf(data(replyMessage('◆ Storefront', '', 'The turn failed (HTTP 500): down')))),
        { kind: 'reply', name: 'Storefront', status: 'failed', body: 'The turn failed (HTTP 500): down\n\nIt answered without text.' });
    // The user's own words, and other agents' messages, keep DSH's own notice.
    assert.equal(noticeOf(data(handback, 'user')), undefined);
    assert.equal(noticeOf(data('A message from another agent.')), undefined);
});

test('browser half: one store of what the plugin says about each coordinating chat, shared by the views and read while they watch', async () => {
    const { client } = loadClient();
    const { projectFacts, pausedText, withHeld } = client.internals;
    const calls = [];
    let paused = true;
    let others = [{ id: 'c2', coordinator: 'c2', paused: false }];
    // A coordinating chat's description: its id is its session's.
    const chat = () => ({
        project: { id: 'c1', name: 'P', coordinator: 'c1' }, settings: {},
        paused: { value: paused, source: 'chat setting', inherited: false, held: paused ? 2 : 0 },
        threads: [{ id: 't1', session: 's1' }],
    });
    const listed = () => [{ id: 'c1', coordinator: 'c1', paused }, ...others];
    const link = {
        async call(method, args) {
            calls.push(method);
            if (method === 'describe') return { ok: true, value: chat() };
            if (method === 'list') return { ok: true, value: { projects: listed() } };
            if (method === 'update' && args.target === 'c1') { paused = args.changes.paused; return { ok: true, value: chat() }; }
            if (method === 'coordinate' && args.target === 'c3') {
                others = args.on ? [...others, { id: 'c3', coordinator: 'c3', paused: true }] : others.filter((p) => p.id !== 'c3');
                return { ok: true, value: { coordinating: args.on, session: 'c3', text: '', projects: listed() } };
            }
            return { ok: false, error: { code: 'coordinator/refused', message: 'no' } };
        },
    };
    const facts = projectFacts(link);
    let changes = 0;
    facts.subscribe(() => { changes += 1; });
    assert.equal(facts.paused('c1'), undefined, 'unknown until read');
    // A thread's session reads its chat's description; the chat and its other threads share it.
    await facts.describe('s1');
    assert.equal(facts.info('s1').project.id, 'c1');
    assert.equal(facts.info('c1'), facts.info('s1'));
    assert.equal(facts.paused('c1'), true);
    await facts.describe('s1', 60000);
    assert.deepEqual(calls, ['describe'], 'a fresh read is not repeated');
    // The list covers every coordinating chat, the session list's paused marks.
    await facts.list();
    assert.deepEqual([facts.paused('c1'), facts.paused('c2'), facts.paused('c3')], [true, false, undefined]);
    // A change answers with the chat's description, and every view shows it at once.
    const before = changes;
    assert.equal((await facts.change('c1', { paused: false })).ok, true);
    assert.equal(facts.paused('c1'), false);
    assert.equal(facts.info('s1').paused.held, 0);
    assert.ok(changes > before);
    assert.equal((await facts.change('c2', { paused: false })).ok, false);
    // Coordinate answers with every coordinating chat, which the views take at once; a refusal changes nothing.
    calls.length = 0;
    assert.equal((await facts.coordinate('c3', true)).ok, true);
    assert.deepEqual([plain(facts.projects().map((p) => p.id)), facts.paused('c3')], [['c1', 'c2', 'c3'], true]);
    assert.equal((await facts.coordinate('c9', true)).ok, false);
    assert.deepEqual(plain(facts.projects().map((p) => p.id)), ['c1', 'c2', 'c3']);
    await facts.coordinate('c3', false);
    assert.deepEqual(plain(facts.projects().map((p) => p.id)), ['c1', 'c2']);
    assert.deepEqual(calls, ['coordinate', 'coordinate', 'coordinate']);
    // A watch reads now (unless just read) and every 15 s; the last unwatch stops the timer, so this test can end.
    const fresh = projectFacts(link);
    const stop = fresh.watch('list');
    const again = fresh.watch('list');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fresh.paused('c2'), false);
    stop();
    again();
    assert.equal(typeof fresh.watch(''), 'function');
    // What a pause means where it shows.
    assert.equal(pausedText('coordinator', 0), 'New threads and handbacks wait until you resume.');
    assert.equal(pausedText('coordinator', 1), '1 message held until you resume. New threads wait too.');
    assert.equal(pausedText('coordinator', 2, 2), '2 handbacks held until you resume. New threads wait too.');
    assert.equal(pausedText('thread', 3), 'This thread\'s handbacks wait until you resume.');
    // A thread whose handback the pause holds says so, instead of "No handback yet"; running and resolved rows keep theirs.
    const rows = [{ id: 't1', group: 'idle', line: 'No handback yet' }, { id: 't2', group: 'running', line: 'Working…' }, { id: 't3', group: 'idle', line: 'No handback yet' }];
    assert.equal(withHeld(rows, []), rows);
    assert.deepEqual(plain(withHeld(rows, [{ thread: 't1', status: 'done' }, { thread: 't2', status: 'blocked' }]).map((r) => r.line)),
        ['Done · held until you resume', 'Working…', 'No handback yet']);
    // And sits where that handback puts it: Done, or Waiting on you for a decision or a block.
    assert.deepEqual(plain(withHeld(rows, [{ thread: 't1', status: 'done' }, { thread: 't3', status: 'needs_decision' }]).map((r) => [r.group, r.dot, r.stateLabel])),
        [['done', 'done', 'Done'], ['running', null, null], ['waiting', 'warning', 'Needs a decision']]);
});

test('browser half: news from threads marks their chat\'s row and shows one notice for the newest, until that chat is opened', async () => {
    const { client } = loadClient();
    const { projectFacts, NewsNotice, ThreadMark, RowPlace, newsLine, newsDot, takeKnown } = client.internals;
    takeKnown({});
    let seq = 1;
    let seen = 0;
    let items = [{ seq: 1, kind: 'handback', thread: 't1', title: 'Old news', status: 'done', at: '2026-10-11T01:00:00Z' }];
    const calls = [];
    const answer = () => ({ ok: true, value: { news: [
        { project: 'c1', name: 'Shop', coordinator: 'c1', seq, seen, unread: items.filter((i) => i.seq > seen) },
        { project: 'c2', name: 'Quiet', coordinator: 'c2', seq: 0, seen: 0, unread: [] },
    ] } });
    const link = {
        async call(method, args) {
            calls.push([method, args]);
            if (method === 'news') return answer();
            if (method === 'seeNews') { seen = args.seq; return answer(); }
            return { ok: false, error: { code: 'coordinator/refused', message: 'no' } };
        },
    };
    const facts = projectFacts(link);
    const closed = () => false;
    // The first read only learns where each coordinating chat is: what was already waiting marks the row, with no notice.
    await facts.news(closed);
    assert.equal(facts.notice(), null);
    assert.deepEqual(plain(facts.newsOf('c1').unread.map((i) => i.seq)), [1]);
    assert.equal(facts.newsOf('c2'), undefined);
    // What comes next, while the user looks elsewhere, is the notice: the newest, and how many more.
    seq = 3;
    items = [...items, { seq: 2, kind: 'finished', thread: 't2', title: 'Docs', at: '2026-10-11T01:05:00Z' },
        { seq: 3, kind: 'approval', thread: 't1', title: 'Deploy', at: '2026-10-11T01:06:00Z' }];
    await facts.news(closed);
    assert.deepEqual(plain(facts.notice()), { key: 'c1:3', coordinator: 'c1', name: 'Shop', item: items[2], more: 1 });
    // A notice the same read already showed is not shown twice; one the user dismissed stays gone.
    facts.dropNotice('c1:3');
    await facts.news(closed);
    assert.equal(facts.notice(), null);
    // With that chat open, news arrives in front of the user: no notice.
    seq = 4;
    items = [...items, { seq: 4, kind: 'failed', thread: 't1', title: 'Deploy', at: '2026-10-11T01:07:00Z' }];
    await facts.news((id) => id === 'c1');
    assert.equal(facts.notice(), null);

    // The row: a dot in the leading seat that says what came, and a mark the CSS reads to make the title bold.
    const state = { byId: { c1: { title: 'Shop', projectionValues: { coordinatorSession: { role: 'coordinator', project: { id: 'c1', name: 'Shop' }, threads: [] } } } } };
    const useSessions = (select) => select(state);
    const projects = { facts, refresh() {} };
    const mark = ThreadMark({ sessionId: 'c1', useSessions, projects });
    assert.equal(mark.props['data-projects-news-mark'], 4);
    assert.equal(mark.props.title, '4 new, latest: “Deploy” failed');
    assert.equal(mark.children[0].props.state, 'error');
    // The dot is drawn only; a screen reader hears the news after the title, from the row's words.
    assert.equal(mark.props['aria-hidden'], true);
    assert.equal(mark.props['aria-label'], undefined);
    assert.equal(RowPlace({ sessionId: 'c1', useSessions, projects }).props['data-projects-unread'], 4);
    assert.equal(RowPlace({ sessionId: 'c1', useSessions, projects }).props['data-projects-words'], 'Coordinating, 4 new, latest: “Deploy” failed');
    // Opening the chat sees everything the window knew of, at once, and the plugin keeps it seen.
    await facts.seeNews('c1');
    assert.deepEqual(plain(calls.at(-1)), ['seeNews', { target: 'c1', seq: 4 }]);
    assert.equal(facts.newsOf('c1'), undefined);
    assert.equal(ThreadMark({ sessionId: 'c1', useSessions, projects }), null);
    assert.equal(RowPlace({ sessionId: 'c1', useSessions, projects }).props['data-projects-unread'], undefined);
    assert.equal(RowPlace({ sessionId: 'c1', useSessions, projects }).props['data-projects-words'], 'Coordinating');
    await facts.seeNews('c1');
    assert.equal(calls.filter(([m]) => m === 'seeNews').length, 1, 'nothing unread: no call');

    // The notice is DSH's own banner, with Open, and names the chat; a thread waiting on the user reads as a warning, a result as done.
    seq = 5;
    items = [...items, { seq: 5, kind: 'handback', thread: 't2', title: 'Docs', status: 'done', at: '2026-10-11T01:08:00Z' }];
    await facts.news(closed);
    const opened = [];
    const toast = NewsNotice({ projects: { facts, openSession: (id) => opened.push(id) } });
    assert.equal(toast.props.text, 'Shop: “Docs” handed back.');
    assert.equal(toast.props.tone, 'success');
    assert.equal(toast.props.actions[0].label, 'Open');
    toast.props.actions[0].onClick();
    assert.deepEqual(opened, ['c1']);
    assert.equal(facts.notice(), null);
    assert.equal(NewsNotice({ projects: { facts } }), null);
    assert.deepEqual(['blocked', 'needs_decision', 'done'].map((status) => newsLine({ kind: 'handback', title: 'X', status })),
        ['“X” is blocked', '“X” needs a decision', '“X” handed back']);
    assert.deepEqual([[{ kind: 'handback', status: 'done' }], [{ kind: 'finished' }, { kind: 'stopped' }], [{ kind: 'approval' }, { kind: 'failed' }]].map(newsDot),
        ['done', 'warning', 'error']);
});

test('browser half: a thread\'s changes read as DSH\'s card counts them, and its projection says when to read them again', () => {
    const { client } = loadClient();
    const { changesOf, changesText, lastChange, REVIEW_PREFIX } = client.internals;
    const changes = { added: 18, deleted: 3, files: 2, turns: 1, last: { seq: 12, turn: 2 }, reviewable: true };
    assert.equal(changesOf(changes), changes);
    for (const bad of [null, undefined, 'x', { added: 1, deleted: 0, files: 0 }, { added: '1', deleted: 0, files: 1 }]) assert.equal(changesOf(bad), undefined);
    assert.equal(changesText(changes), '2 files changed: 18 lines added, 3 deleted');
    assert.equal(changesText({ ...changes, files: 1, added: 1 }), '1 file changed: 1 line added, 3 deleted');
    assert.equal(lastChange({ role: 'thread', changes: [{ turn: 1, seq: 9 }, { turn: 2, seq: 15 }] }), '15');
    assert.equal(lastChange({ role: 'thread' }), '');
    assert.equal(lastChange(undefined), '');
    // DSH's own Review tab, as its "Edited N files" card opens it.
    assert.equal(REVIEW_PREFIX, 'dsh-resource://changes-review/session/');
});

test('browser half: a file in a Changes tab shows what its edits came to, each edit a click away', () => {
    const { client } = loadClient({ primitives: { DiffBlock: 'DiffBlock', PathLabel: 'PathLabel', FileTypeIcon: 'FileTypeIcon', Tooltip: 'Tooltip' } });
    const { ChangedFile, shownCounts } = client.internals;
    const edits = [
        { turn: 1, seq: 3, added: 3, deleted: 0, created: true, hunks: [{ oldText: null, newText: 'one\ntwo\nthree\n' }] },
        { turn: 2, seq: 7, added: 1, deleted: 1, hunks: [{ oldText: 'two', newText: 'TWO' }] },
    ];
    const file = { path: 'notes.md', added: 4, deleted: 1, created: true, edits, net: { added: 3, deleted: 0, created: true, hunks: [{ oldText: null, newText: 'one\nTWO\nthree' }] } };
    let asked = 0;
    const draw = (f, each = false) => ChangedFile({ file: f, open: true, onToggle() {}, each, onEach: () => { asked += 1; } });
    const find = (tree, attr, value = '') => elementsOf(tree).find((e) => e.props?.[attr] === value);
    let out = draw(file);
    // Its head, and the tab's totals, count what the edits came to; the edits' own sum is theirs.
    assert.equal(find(out, 'className', 'dshp-ch-file-toggle').props['aria-label'], 'notes.md (new): 3 lines added, 0 deleted');
    assert.deepEqual(plain(shownCounts(file)), plain(file.net));
    assert.equal(shownCounts({ ...file, net: undefined }).added, 4);
    // One diff, of what the edits came to; the edits fold under "Each edit (2)".
    assert.deepEqual(plain(elementsOf(find(out, 'data-projects-changes-net')).find((e) => e.type === 'DiffBlock').props.diffs), [{ path: 'notes.md', oldText: null, newText: 'one\nTWO\nthree' }]);
    assert.equal(elementsOf(out).filter((e) => e.type === 'DiffBlock').length, 1);
    const each = find(out, 'data-projects-changes-each');
    assert.deepEqual([textIn(each), each.props['aria-expanded'], each.props['aria-controls']], ['Each edit (2)', false, undefined]);
    each.props.onClick();
    assert.equal(asked, 1);
    out = draw(file, true);
    const opened = find(out, 'data-projects-changes-edits');
    assert.equal(find(out, 'data-projects-changes-each').props['aria-controls'], opened.props.id);
    assert.deepEqual(plain(elementsOf(opened).filter((e) => e.type === 'DiffBlock').map((d) => d.props.diffs.map((x) => x.newText))), [['one\ntwo\nthree\n'], ['TWO']]);
    assert.deepEqual(byClass(opened, 'dshp-ch-edit-head').map(textIn), ['Edit 1 · Turn 1+3-0', 'Edit 2 · Turn 2+1-1']);
    // Edits that undid each other, and a file changed since, say so.
    out = draw({ ...file, created: false, net: { added: 0, deleted: 0, hunks: [], undone: true, since: true } });
    assert.equal(find(out, 'className', 'dshp-ch-file-toggle').props['aria-label'], 'notes.md: 0 lines added, 0 deleted');
    assert.deepEqual(byClass(find(out, 'data-projects-changes-net'), 'dshp-ch-note').map(textIn), [
        'Its edits undid each other: the file is as it was before.',
        'The file has changed since these edits. This is how they left it.',
    ]);
    // No lines changed for another reason: only line endings or the last newline, or a new, empty file; one edit.
    const sameOf = (f) => byClass(find(draw(f), 'data-projects-changes-net'), 'dshp-ch-note').map(textIn);
    assert.deepEqual(sameOf({ ...file, created: false, net: { added: 0, deleted: 0, hunks: [], endings: true } }), ['Only line endings or the last newline changed.']);
    assert.deepEqual(sameOf({ ...file, net: { added: 0, deleted: 0, created: true, hunks: [], empty: true } }), ['A new, empty file.']);
    assert.deepEqual(sameOf({ ...file, created: false, edits: [edits[1]], net: { added: 0, deleted: 0, hunks: [], undone: true } }), ['Its edit left the file as it was.']);
    // A diff with edits the list doesn't have says so.
    assert.deepEqual(sameOf({ ...file, net: { ...file.net, unlisted: true } }), ['This also has edits by subagents that aren\'t listed here.']);
    // Too much for the tab: its counts, and why there's no diff.
    out = draw({ ...file, net: { ...file.net, hunks: [], clipped: true } });
    assert.deepEqual(byClass(find(out, 'data-projects-changes-net'), 'dshp-ch-note').map(textIn), ['Part of this is too large to show here. Its lines are still counted.']);
    // No one diff: the edits one by one, and why (nothing to say for edits from before the plugin kept texts).
    out = draw({ ...file, net: undefined, netWhy: 'mixed' });
    assert.equal(textIn(find(out, 'data-projects-changes-why', 'mixed')), 'Shown edit by edit: the file also changed some other way between or during these edits.');
    assert.deepEqual([find(out, 'data-projects-changes-each'), elementsOf(out).filter((e) => e.type === 'DiffBlock').length], [undefined, 2]);
    assert.equal(find(out, 'className', 'dshp-ch-file-toggle').props['aria-label'], 'notes.md (new): 4 lines added, 1 deleted');
    for (const why of ['big', 'large', 'full', 'many', 'binary', 'encoding', 'outside', 'secret']) assert.ok(find(draw({ ...file, net: undefined, netWhy: why }), 'data-projects-changes-why', why), why);
    assert.equal(textIn(find(draw({ ...file, net: undefined, netWhy: 'outside' }), 'data-projects-changes-why', 'outside')), 'Shown edit by edit: no copies are kept of files outside the thread\'s folders.');
    // One edit: its diff is the file's one diff, so there's no "Each edit".
    out = draw({ ...file, edits: [edits[1]], net: { added: 1, deleted: 1, hunks: [{ oldText: 'two', newText: 'TWO' }] } }, true);
    assert.deepEqual([find(out, 'data-projects-changes-each'), find(out, 'data-projects-changes-edits'), elementsOf(out).filter((e) => e.type === 'DiffBlock').length], [undefined, undefined, 1]);
    assert.equal(elementsOf(draw({ ...file, net: undefined, netWhy: 'none' })).some((e) => e.props?.['data-projects-changes-why'] !== undefined), false);
});

test('browser half: a thread\'s Changes tab lists its files with their diffs, and its counts open it', async () => {
    const { client, react } = loadClient({ primitives: { DiffBlock: 'DiffBlock', PathLabel: 'PathLabel', FileTypeIcon: 'FileTypeIcon', Tooltip: 'Tooltip' } });
    const { ThreadChangesTab, ThreadChangesTitle, ChangedFile, editsText, listText, fileAddress, readFailure, changesOpener, CardChanges, changesAddress, changesSessionOf, DIFF_LABELS } = client.internals;
    // The tab's address names the thread's session.
    assert.equal(changesAddress('s/1'), 'dsh-resource://projectchanges/session/s%2F1');
    assert.equal(changesSessionOf(changesAddress('s/1')), 's/1');
    assert.equal(changesSessionOf('dsh-resource://projectthread/session/s1'), undefined);
    // DSH's own file tab reads a file through the thread's session: inside its folder relative to it, else absolute.
    assert.equal(fileAddress('s1', 'src/a b.js'), 'dsh-resource://file/session/s1/src/a%20b.js');
    assert.equal(fileAddress('s1', './x.md'), 'dsh-resource://file/session/s1/x.md');
    assert.equal(fileAddress('s1', '/elsewhere/c:d.md'), 'dsh-resource://file/session/s1//elsewhere/c:d.md');
    assert.equal(editsText([{ turn: 2 }, { turn: 1 }, { turn: 2, by: 'Docs helper' }]), 'Turns 1, 2 · by this thread and Docs helper');
    assert.equal(editsText([{ turn: 3, by: 'A' }, { turn: 3, by: 'B' }]), 'Turn 3 · by A and B');
    assert.equal(editsText([{ turn: 1 }]), 'Turn 1');
    assert.deepEqual([listText([]), listText(['A']), listText(['A', 'B']), listText(['A', 'B', 'C'])], ['', 'A', 'A and B', 'A, B and C']);
    assert.equal(readFailure({ code: 'coordinator/refused', message: 'couldn\'t read t1\'s records: read timed out' }), 'Couldn\'t read t1\'s records: read timed out.');
    assert.match(readFailure({ code: 'projects/unreachable', message: 'socket closed' }), /didn't answer/);
    assert.equal(readFailure({ code: 'x', message: 'boom' }), 'Couldn\'t read this thread\'s changes. boom');
    assert.equal(DIFF_LABELS.expand(4), '… 4 more lines');

    // The tab: reading, then each file with its counts and DSH's diff of its edits' hunks.
    const value = {
        project: 'p', thread: 't1', title: 'Edit docs', session: 's-t1', folder: '/w',
        files: [
            { path: 'a.md', added: 4, deleted: 2, created: true, edits: [
                { turn: 1, seq: 3, added: 2, deleted: 0, created: true, hunks: [{ oldText: null, newText: 'one\ntwo\n' }] },
                { turn: 2, seq: 2, by: 'Docs helper', added: 1, deleted: 1, hunks: [{ oldText: 'two', newText: 'TWO' }], clipped: true },
            ], alsoBy: [{ thread: 't2', title: 'Other', session: 's-t2' }] },
            { path: 'src/b.js', added: 1, deleted: 1, edits: [{ turn: 1, seq: 5, added: 1, deleted: 1, hunks: [{ oldText: 'x = 1', newText: 'x = 2' }] }] },
        ],
        turns: [{ turn: 1, seq: 6, reviewable: true }, { turn: 2, seq: 9 }],
        unread: 1,
    };
    const calls = [];
    let answer = { ok: true, value };
    const opened = [];
    const projects = {
        link: { call: async (method, args) => { calls.push([method, { ...args }]); return answer; } },
        openThread: (id) => opened.push(['thread', id]), openChanges: (id) => opened.push(['changes', id]), openReview: (id, last) => opened.push(['review', id, last.seq, last.turn]),
    };
    const tab = { contentId: changesAddress('s-t1'), visible: true, actions: { openResource: (address) => opened.push(['file', address]) } };
    let marks = [{ turn: 1, seq: 6 }];
    const state = () => ({
        byId: { 's-t1': { displayTitle: 'Edit docs (DSH)' } },
        projectionsBySession: { 's-t1': { values: { coordinatorSession: { role: 'thread', coordinator: 's-c', thread: { id: 't1', title: 'Edit docs' }, changes: marks } } } },
    });
    const draw = liveMount(react, () => ThreadChangesTab({ useTabInfo: () => ({ tab }), useSessions: (select) => select(state()), projects }));
    let tree = draw();
    assert.equal(tree.props['data-state'], 'loading');
    assert.equal(textIn(byClass(tree, 'dshp-t-empty')), 'Reading changes…');
    assert.deepEqual(plain(calls), [['changes', { target: 's-t1' }]]);
    await tick();
    tree = draw();
    assert.equal(tree.props['data-state'], 'ready');
    assert.equal(textIn(byClass(tree, 'dshp-ch-name')), 'Edit docs');
    assert.equal(textIn(byClass(tree, 'dshp-ch-sub')), '+5-3· 2 files');
    const files = elementsOf(tree).filter((e) => e.type === ChangedFile);
    assert.deepEqual(files.map((f) => [f.props.file.path, f.props.open]), [['a.md', true], ['src/b.js', true]]);
    // A file: its name, "new", its counts; DSH's diff of each edit under its place, turn, author and counts; when, by
    // whom, and who else.
    let file = files[0].type(files[0].props);
    assert.equal(file.props['data-projects-changes-file'], 'a.md');
    const head = elementsOf(file).find((e) => e.props?.className === 'dshp-ch-file-toggle');
    assert.equal(head.props['aria-expanded'], true);
    assert.equal(head.props['aria-label'], 'a.md (new): 4 lines added, 2 deleted');
    assert.deepEqual([elementsOf(head).find((e) => e.type === 'PathLabel').props.path, textIn(head)], ['a.md', 'new+4-2']);
    const diffs = elementsOf(file).filter((e) => e.type === 'DiffBlock');
    assert.deepEqual(plain(diffs.map((d) => d.props.diffs)), [[{ path: 'a.md', oldText: null, newText: 'one\ntwo\n' }], [{ path: 'a.md', oldText: 'two', newText: 'TWO' }]]);
    assert.deepEqual(diffs.map((d) => d.props.maxLines), [40, 40]);
    assert.deepEqual(elementsOf(file).filter((e) => e.props?.['data-projects-changes-edit'] !== undefined).map((e) => e.props['data-projects-changes-edit']), ['1', '2']);
    assert.deepEqual(byClass(file, 'dshp-ch-note').map(textIn), [
        'Turns 1, 2 · by this thread and Docs helper',
        'Edit 1 · Turn 1+2-0',
        'Edit 2 · Turn 2 · by Docs helper+1-1',
        'Part of this is too large to show here. Its lines are still counted.',
        'Also changed by Other.',
    ]);
    // Its "open" button opens DSH's own file tab; another thread's name opens that thread's Changes.
    elementsOf(file).find((e) => e.props?.['data-projects-changes-open'] === '').props.onClick();
    elementsOf(file).find((e) => e.props?.className === 'dshp-ch-link').props.onClick();
    assert.deepEqual(opened.splice(0), [['file', 'dsh-resource://file/session/s-t1/a.md'], ['changes', 's-t2']]);
    // DSH's review of a turn it still holds, what couldn't be read, and what isn't shown yet.
    assert.deepEqual(byClass(tree, 'dshp-ch-note').map(textIn), [
        'DSH\'s review of the whole folder: Turn 1',
        'What 1 subagent changed couldn\'t be read.',
        'Edits made by commands the thread ran in its shell aren\'t shown yet.',
    ]);
    elementsOf(tree).find((e) => e.props?.['data-projects-changes-review'] === '1').props.onClick();
    elementsOf(tree).find((e) => e.props?.className === 'dshp-ch-name').props.onClick();
    assert.deepEqual(opened.splice(0), [['review', 's-t1', 6, 1], ['thread', 's-t1']]);
    // A click on a file's name folds it.
    files[0].props.onToggle();
    tree = draw();
    assert.deepEqual(elementsOf(tree).filter((e) => e.type === ChangedFile).map((f) => f.props.open), [false, true]);
    file = ChangedFile(elementsOf(tree).find((e) => e.type === ChangedFile).props);
    assert.equal(byClass(file, 'dshp-ch-file-body').length, 0);
    // Drawn again, nothing is read again until the thread's records gain a turn, or on Read again.
    draw();
    assert.equal(calls.length, 1);
    marks = [...marks, { turn: 2, seq: 9 }];
    tree = draw();
    assert.equal(calls.length, 2);
    assert.equal(tree.props['data-state'], 'ready', 'what it showed stays while it reads');
    await tick();
    // A read that fails keeps what it showed, and says so; Read again tries once more.
    answer = { ok: false, error: { code: 'coordinator/refused', message: 'couldn\'t read t1\'s records: read timed out' } };
    elementsOf(draw()).find((e) => e.props?.['data-projects-changes-read'] === '').props.onClick();
    tree = draw();
    await tick();
    tree = draw();
    assert.equal(calls.length, 3);
    assert.equal(byClass(tree, 'dshp-ch-file').length + elementsOf(tree).filter((e) => e.type === ChangedFile).length, 2);
    assert.equal(textIn(byClass(tree, 'dshp-t-error')), 'Couldn\'t read t1\'s records: read timed out.');
    // A thread that changed nothing says so; a hidden tab reads nothing.
    const quiet = liveMount(react, () => ThreadChangesTab({ useTabInfo: () => ({ tab: { ...tab, contentId: changesAddress('s-t9'), visible: false } }), useSessions: (select) => select(state()), projects }));
    quiet();
    assert.equal(calls.length, 3);
    answer = { ok: true, value: { ...value, files: [], turns: [], unread: undefined } };
    const none = liveMount(react, () => ThreadChangesTab({ useTabInfo: () => ({ tab: { ...tab, contentId: changesAddress('s-t9') } }), useSessions: (select) => select(state()), projects }));
    none();
    await tick();
    tree = none();
    assert.equal(textIn(byClass(tree, 'dshp-t-empty')), 'This thread hasn\'t changed any files yet.');
    // Many files start folded.
    answer = { ok: true, value: { ...value, files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.md`, added: 1, deleted: 0, edits: [] })) } };
    const many = liveMount(react, () => ThreadChangesTab({ useTabInfo: () => ({ tab: { ...tab, contentId: changesAddress('s-t8') } }), useSessions: (select) => select(state()), projects }));
    many();
    await tick();
    tree = many();
    assert.ok(elementsOf(tree).filter((e) => e.type === ChangedFile).every((f) => f.props.open === false));
    assert.equal(textIn(byClass(tree, 'dshp-ch-note')[0]), '9 files folded. Open one to see its diff.');
    // The tab's title names the thread.
    assert.equal(textIn(ThreadChangesTitle({ useTabInfo: () => ({ tab }), useSessions: (select) => select(state()) })), 'Changes · Edit docs');

    // A card's counts open the thread's Changes tab; a DSH without it opens DSH's Review while it can; else they only say.
    const counts = { added: 5, deleted: 3, files: 2, turns: 2, last: { seq: 9, turn: 2 }, reviewable: false };
    const withTab = { ...projects, hasChanges: () => true };
    let card = CardChanges({ changes: counts, ...changesOpener(withTab, 's-t1', counts) });
    const button = elementsOf(card).find((e) => e.type === 'button');
    assert.equal(button.props['aria-label'], 'See what this thread changed. 2 files changed: 5 lines added, 3 deleted');
    assert.equal(button.props['data-projects-changes'], '');
    button.props.onClick();
    assert.deepEqual(opened.splice(0), [['changes', 's-t1']]);
    const noTab = { ...projects, hasChanges: () => false };
    card = CardChanges({ changes: { ...counts, reviewable: true }, ...changesOpener(noTab, 's-t1', { ...counts, reviewable: true }) });
    assert.equal(elementsOf(card).find((e) => e.type === 'button').props['data-projects-changes'], 'review');
    card = CardChanges({ changes: counts, ...changesOpener(noTab, 's-t1', counts) });
    assert.equal(card.props['data-projects-changes'], 'gone');
    assert.deepEqual(plain(changesOpener(withTab, undefined, counts)), {}, 'a card whose thread has no session opens nothing');
});
