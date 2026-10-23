/**
 * The browser half's tests: lib/client.js loaded the way DSH loads it (a
 * classic script that hands its factory to DSH's module loader), with
 * stand-ins for React and DSH's primitives, and its views drawn as plain
 * element trees.
 *
 *   node --test plugins/categories/test/client.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Load the browser half the way DSH does. The primitives are stand-ins: an
 * icon or a component is its own name.
 * @param storage - a Map behind the window's localStorage, or none.
 * @param globals - more of the window's globals (Element, requestAnimationFrame, a clock…).
 */
function loadClient({ storage, document, globals = {}, console: log = console, loader = true } = {}) {
    let loaded;
    const localStorage = storage ? { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); } } : undefined;
    const window = { ...(loader ? { __ModuleLoader__: { load: (m) => { loaded = m; } } } : {}), localStorage, addEventListener: () => {}, removeEventListener: () => {} };
    runInNewContext(SOURCE, {
        window, ...(document ? { document } : {}),
        URL, console: log, setInterval, clearInterval, setTimeout, clearTimeout, queueMicrotask, ...globals,
    });
    if (!loaded) return { window };
    const base = { Toast: 'Toast', Menu: 'Menu', Modal: 'Modal', Button: 'Button', Input: 'Input', StateDot: 'StateDot', Tooltip: 'Tooltip' };
    const ui = new Proxy(base, { get: (target, name) => (name in target ? target[name] : typeof name === 'string' && name.startsWith('Icon') ? name : undefined) });
    const modules = {
        react: {
            createElement: (type, props, ...children) => ({ type, props, children }), Fragment: 'Fragment',
            useSyncExternalStore: (_subscribe, get) => get(),
            // Enough of React's hooks to call a component once and read what it draws.
            useState: (init) => [typeof init === 'function' ? init() : init, () => {}], useRef: (current) => ({ current }),
            useEffect: () => {}, useLayoutEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
        },
        'react-dom': { createPortal: (node) => node }, '@deepseek-ai/dsh-client-ui-primitives': ui,
    };
    return { id: loaded.id, client: loaded.factory((name) => modules[name]), window, react: modules.react };
}

/**
 * Draw a component again and again with state and refs that hold between
 * draws (the stand-in React's forget), so a click can open what it opens.
 * With `effects`, its effects run after a draw, again when their inputs
 * change, as React runs them.
 * @returns a function that draws it once more.
 */
function mount(react, render, { effects = false } = {}) {
    const cells = [];
    const ran = [];
    return () => {
        let at = 0;
        let fx = 0;
        const queue = [];
        react.useState = (init) => {
            const k = at++;
            if (!(k in cells)) cells[k] = typeof init === 'function' ? init() : init;
            return [cells[k], (next) => { cells[k] = typeof next === 'function' ? next(cells[k]) : next; }];
        };
        react.useRef = (current) => {
            const k = at++;
            if (!(k in cells)) cells[k] = { current };
            return cells[k];
        };
        react.useEffect = !effects ? () => {} : (fn, deps) => {
            const k = fx++;
            const before = ran[k];
            if (before && deps && before.deps && deps.length === before.deps.length && deps.every((d, i) => Object.is(d, before.deps[i]))) return;
            queue.push(() => {
                if (typeof before?.cleanup === 'function') before.cleanup();
                ran[k] = { deps, cleanup: fn() };
            });
        };
        const out = render();
        for (const run of queue) run();
        return out;
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
const byHook = (tree, hook) => elementsOf(tree).find((e) => e.props?.[hook] !== undefined);

/** Values made inside the script's context, copied so they compare as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A facts store for a view: the categories as `categories()` gives them, and what the views ask of it. */
function factsOf(categories, { failed = () => false, answer = () => ({ ok: true, value: {} }) } = {}) {
    const calls = [];
    return {
        calls,
        subscribe: () => () => {}, getSnapshot: () => 0, watch: () => () => {},
        categories, listFailed: failed,
        list: async (maxAge) => { calls.push(['list', maxAge]); },
        act: async (method, args) => { calls.push([method, plain(args)]); return answer(method, args); },
    };
}

/** DSH's workspaces as its `useWorkspaces` gives them. */
const workspacesOf = (items, more = {}) => ({ phase: 'ready', archivedSessionIds: [], items, ...more });

test('browser half: loads as DSH loads it, registers the session list, the page and its entry, and adds its styles once', async () => {
    const heads = [];
    const warnings = [];
    let present = null;
    const document = {
        querySelector: () => present,
        createElement: (type) => ({ type, dataset: {} }),
        head: { appendChild: (tag) => { heads.push(tag); } },
    };
    const { id, client } = loadClient({ document, console: { ...console, warn: (...parts) => { warnings.push(parts.join(' ')); } } });
    assert.equal(id, 'dsh-plugin-categories');
    assert.deepEqual(plain(client.inject), ['slots']);
    const { CSS, SidebarTree, CategoriesPage, CategoriesIcon, CategoryChip } = client.internals;
    // Its styles once, under its own prefix, and the session list's rules read DSH's own indent.
    assert.equal(heads.length, 1);
    assert.deepEqual(plain(heads[0].dataset), { plugin: 'dsh-plugin-categories', pluginCss: 'dsh-plugin-categories/client.css' });
    assert.equal(heads[0].textContent, CSS);
    assert.match(CSS, /\.dshc-sb-head\{/);
    assert.match(CSS, /\.dshc-tree-row\{/);
    assert.doesNotMatch(CSS, /dshp-|data-projects-/);
    present = {};
    loadClient({ document });
    assert.equal(heads.length, 1, 'a second load adds no second sheet');

    // Each part waits for its own DSH services; the categories are read as soon as the window can ask.
    const registered = [];
    const injected = [];
    const effects = [];
    const rpc = [];
    const opened = [];
    const panels = [];
    const connection = { rpc: { call: async (path, method, payload) => { rpc.push([path, method, plain(payload)]); return { ok: true, value: { categories: [] } }; } } };
    const ctx = {
        effect: (fn, label) => { effects.push(label); return fn(); },
        inject: (names, fn) => { injected.push(plain(names)); fn(ctx); },
        slots: { inject: (_name, fn) => fn(), register: (slot, component) => { registered.push([slot, component]); return () => {}; } },
        connection, uiWorkspace: { openSession: (sessionId) => { opened.push(sessionId); } },
        get: (name) => (name === 'layout' ? { selectPanel: (panel) => { panels.push(panel); } } : undefined),
    };
    client.apply(ctx);
    assert.deepEqual(injected, [['connection'], ['uiWorkspace']]);
    assert.deepEqual(registered.map(([slot, component]) => [slot.name, slot.id ?? slot.key, slot.order, slot.label, component]), [
        ['shell.overlay', 'dsh-plugin-categories:sidebar', undefined, undefined, SidebarTree],
        ['main', 'dsh-plugin-categories:page', undefined, undefined, CategoriesPage],
        ['sidebar.panellist', 'dsh-plugin-categories:page', 6, 'Categories', CategoriesIcon],
        // Just before the projects plugin's Threads menu (-25) when that plugin is on.
        ['conversation.session.header.actions', 'dsh-plugin-categories:chip', -27, undefined, CategoryChip],
    ]);
    await tick();
    assert.deepEqual(rpc, [['/api', 'dsh-plugin-categories/list', { args: {} }]]);

    // The views share one window API: the categories, opening a session as DSH's list does, DSH's own Add workspace.
    const { plugin } = registered[0][0].inject();
    assert.equal(registered[1][0].inject().plugin, plugin);
    // The chip shares it too, and opens the page DSH's sidebar entry opens, through DSH's layout.
    const chip = registered[3][0].inject();
    assert.equal(chip.plugin, plugin);
    chip.openPage()();
    assert.deepEqual(panels, ['dsh-plugin-categories:page']);
    assert.equal(plugin.facts.categories().length, 0);
    plugin.openSession('s1');
    plugin.openSession('');
    assert.deepEqual(opened, ['s1']);
    ctx.uiWorkspace.openSession = () => { throw new Error('no such session'); };
    plugin.openSession('s2');
    assert.deepEqual(warnings, ['[categories] could not open the session: no such session']);
    // No Add workspace where DSH's list doesn't hand one out.
    assert.equal(plugin.addWorkspace.state(), null);

    // The entry's icon is drawn like DSH's own: a 16 px grid, a 1 px stroke in the text colour, folders.
    const icon = CategoriesIcon({ size: 20 });
    assert.equal(icon.type, 'svg');
    assert.deepEqual([icon.props.width, icon.props.height, icon.props.viewBox, icon.props.fill, icon.props.stroke, icon.props.strokeWidth, icon.props['aria-hidden']],
        [20, 20, '0 0 16 16', 'none', 'currentColor', 1, true]);
    assert.deepEqual(icon.children.map((child) => child.type), ['path', 'path']);
    assert.equal(CategoriesIcon({}).props.width, 16);

    // Loading never throws: without DSH's loader it does nothing, and styles that can't be added are only a warning.
    assert.doesNotThrow(() => loadClient({ loader: false }));
    assert.doesNotThrow(() => runInNewContext(SOURCE, {}));
    warnings.length = 0;
    const loose = loadClient({ document: { querySelector: () => { throw new Error('no head'); } }, console: { ...console, warn: (...parts) => { warnings.push(parts.join(' ')); } } });
    assert.equal(loose.id, 'dsh-plugin-categories');
    assert.deepEqual(warnings, ['[categories] could not add the plugin\'s styles: no head']);
});

test('browser half: the endpoints go over DSH\'s connection, and a failed call reads as one sentence', async () => {
    const { client } = loadClient();
    const { hostLink, errorText, TEXT } = client.internals;
    const seen = [];
    let answer = { ok: true, value: { categories: [] } };
    let connection;
    const link = hostLink(() => connection);
    assert.deepEqual(plain(await link.call('list', {})), { ok: false, error: { code: 'categories/unreachable', message: 'the window is not connected to DSH yet' } });
    connection = { rpc: { call: async (...args) => { seen.push(plain(args)); if (answer instanceof Error) throw answer; return answer; } } };
    assert.deepEqual(plain(await link.call('moveCategory', { category: 'a', before: '' })), { ok: true, value: { categories: [] } });
    assert.deepEqual(seen, [['/api', 'dsh-plugin-categories/moveCategory', { args: { category: 'a', before: '' } }]]);
    answer = { ok: false, error: { code: 'categories/refused', message: 'a category needs a name' } };
    assert.deepEqual(plain(await link.call('createCategory', { name: '' })), answer);
    answer = 'nonsense';
    assert.deepEqual(plain(await link.call('list', {})), { ok: false, error: { code: 'categories/unreadable', message: 'The plugin sent an answer this window can\'t read.' } });
    answer = { ok: false };
    assert.equal((await link.call('list', {})).error.code, 'categories/unreadable');
    answer = new Error('socket closed');
    assert.deepEqual(plain(await link.call('list', {})), { ok: false, error: { code: 'categories/unreachable', message: 'socket closed' } });

    // The plugin's own refusal as a sentence; anything else says the change didn't go through, or that the plugin didn't answer.
    assert.equal(errorText({ code: 'categories/refused', message: 'a category needs a name' }), 'A category needs a name.');
    assert.equal(errorText({ code: 'categories/refused', message: 'No such category!' }), 'No such category!');
    assert.equal(errorText({ code: 'categories/unreachable', message: 'socket closed' }), TEXT.unreachable);
    assert.equal(errorText({ code: 'rpc/timeout', message: 'late' }), TEXT.unreachable);
    assert.equal(errorText({ code: 'gateway/not-found', message: 'gone' }), TEXT.unreachable);
    assert.equal(errorText({ code: 'categories/unreadable', message: 'odd answer' }), 'The change didn\'t go through: odd answer');
    assert.equal(errorText(undefined), TEXT.unreachable);
    assert.equal(TEXT.unreachable, 'The categories plugin didn\'t answer. If it was just updated, restart DSH so the new version loads.');
});

test('browser half: one store of the categories for both views, read at start and while one watches, and changed by the endpoints', async () => {
    let clock = 1_000_000;
    const timers = [];
    const cleared = [];
    const document = { visibilityState: 'visible', querySelector: () => ({}) };
    const { client } = loadClient({
        document,
        globals: { Date: { now: () => clock }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: (id) => { cleared.push(id); } },
    });
    const { categoryFacts } = client.internals;
    const calls = [];
    let listed = [{ id: 'a', name: 'Alpha', source: 'group', workspaces: [{ id: 'w1', path: '/w/one', title: 'one' }] }];
    let down = false;
    let gate = null;
    const hold = () => {
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        gate = { promise, release: () => { gate = null; release(); } };
    };
    const link = {
        async call(method, args) {
            calls.push(method);
            if (method === 'list') {
                // The answer as it is when the read is made, however long it takes to come.
                const answer = down ? { ok: false, error: { code: 'categories/unreachable', message: 'down' } } : { ok: true, value: { categories: listed } };
                if (gate) await gate.promise;
                return answer;
            }
            if (method === 'renameCategory' && args.category === 'a') {
                listed = [{ ...listed[0], name: args.name }];
                return { ok: true, value: { category: 'a', categories: listed } };
            }
            return { ok: false, error: { code: 'categories/refused', message: 'no such category' } };
        },
    };
    const lists = () => calls.filter((method) => method === 'list').length;
    const facts = categoryFacts(link);
    let emitted = 0;
    const off = facts.subscribe(() => { emitted += 1; });
    assert.deepEqual([facts.categories(), facts.listFailed(), facts.getSnapshot()], [null, false, 0]);
    // A failed read: still nothing known, said once.
    down = true;
    await facts.list();
    assert.deepEqual([facts.categories(), facts.listFailed(), emitted], [null, true, 1]);
    await facts.list();
    assert.equal(emitted, 1);
    // Read again: the categories in their order.
    down = false;
    await facts.list();
    assert.deepEqual(plain(facts.categories()), listed);
    assert.equal(facts.listFailed(), false);
    // A read under maxAge old isn't repeated.
    const n = lists();
    await facts.list(5000);
    assert.equal(lists(), n);
    clock += 6000;
    await facts.list(5000);
    assert.equal(lists(), n + 1);

    // A change answers with the new list, which every view shows at once; a refusal changes nothing.
    const before = emitted;
    assert.equal((await facts.act('renameCategory', { category: 'a', name: 'Fleet' })).ok, true);
    assert.equal(facts.categories()[0].name, 'Fleet');
    assert.ok(emitted > before);
    const refused = await facts.act('removeCategory', { category: 'zz' });
    assert.deepEqual(plain(refused.error), { code: 'categories/refused', message: 'no such category' });
    assert.equal(facts.categories()[0].name, 'Fleet');

    // A read sent before a change answered may predate it: its answer is let go.
    hold();
    const stale = facts.list();
    await tick();
    await facts.act('renameCategory', { category: 'a', name: 'Ops' });
    gate.release();
    await stale;
    assert.equal(facts.categories()[0].name, 'Ops');

    // A read asked for while one runs runs once more after it, so nothing that changed meanwhile is missed.
    hold();
    const first = lists();
    const running = facts.list();
    await tick();
    void facts.list();
    void facts.list(5000);
    assert.equal(lists(), first + 1);
    listed = [{ ...listed[0], name: 'Later' }];
    gate.release();
    await running;
    await tick();
    await tick();
    assert.equal(lists(), first + 2);
    assert.equal(facts.categories()[0].name, 'Later');

    // A watch reads now (unless a read is fresh) and every 15 s while the window shows; the last unwatch stops it.
    const fresh = categoryFacts(link);
    const stop = fresh.watch();
    const also = fresh.watch();
    await tick();
    assert.equal(fresh.categories()[0].name, 'Later');
    assert.deepEqual(timers.map((t) => t.ms), [15000]);
    const count = lists();
    document.visibilityState = 'hidden';
    timers[0].fn();
    await tick();
    assert.equal(lists(), count);
    document.visibilityState = 'visible';
    timers[0].fn();
    await tick();
    assert.equal(lists(), count, 'a read under 10 s old is fresh enough');
    clock += 11000;
    timers[0].fn();
    await tick();
    assert.equal(lists(), count + 1);
    stop();
    stop();
    assert.deepEqual(cleared, []);
    also();
    assert.deepEqual(cleared, [1]);
    off();
});

test('browser half: the Categories page is the whole tree, Category › Workspace › session, in DSH\'s order', () => {
    const { client } = loadClient();
    const { pageModel, visibleItems, OTHERS } = client.internals;
    const sessions = {
        byId: {
            c: { id: 'c', title: '◆ Storefront' }, t1: { id: 't1', title: 'Fix cart' }, t2: { id: 't2', title: 'Hero images' }, x: { id: 'x', title: 'A chat' },
            y: { id: 'y', title: 'Old' }, z: { id: 'z', title: 'Notes' }, e: { id: 'e', title: 'New Session', blank: true }, u: { id: 'u', title: '  ' },
        },
    };
    const items = [
        { workspaceId: 'w-sf', title: 'storefront', path: '/home/u/storefront', sessionIds: ['c', 't1', 'x', 'y', 'e', 'gone'] },
        { workspaceId: 'w-assets', title: '', path: '/home/u/storefront-assets', sessionIds: ['t2', 'u'] },
        { workspaceId: 'w-notes', title: 'notes', path: '/home/u/notes', sessionIds: ['z', 'x'] },
    ];
    const tree = pageModel({
        categories: [{ id: 'shop', name: 'Shop', workspaces: [{ id: 'w-assets' }, { id: 'w-sf' }] }, { id: 'later', name: '', workspaces: [] }, { name: 'no id' }],
        items, sessions, archived: new Set(['y']),
    });
    const shape = (nodes) => nodes.map((n) => [n.kind, n.title, ...(n.children.length ? [shape(n.children)] : [])]);
    // DSH's workspace order inside a category, each workspace's sessions in DSH's order whatever they are to another
    // plugin (a ◆ coordinator is a session by its DSH title); archived, empty and unknown ones left out, a session
    // once; an unnamed category by its id; Other workspaces last.
    assert.deepEqual(plain(shape(tree)), [
        ['category', 'Shop', [
            ['workspace', 'storefront', [['session', '◆ Storefront'], ['session', 'Fix cart'], ['session', 'A chat']]],
            ['workspace', 'storefront-assets', [['session', 'Hero images'], ['session', 'New chat']]],
        ]],
        ['category', 'later'],
        ['category', 'Other workspaces', [['workspace', 'notes', [['session', 'Notes']]]]],
    ]);
    assert.deepEqual(plain(tree[0].children[0].children.map((node) => node.id)), ['c', 't1', 'x']);
    assert.equal(tree[2].id, OTHERS);
    assert.equal(tree[0].children[0].path, '/home/u/storefront');
    // Levels 1-3, positions among siblings, and closed items hide what is in them.
    const shown = visibleItems(tree, new Set());
    assert.deepEqual(plain(shown.map((x) => [x.node.title, x.level, `${x.pos}/${x.size}`, x.open])), [
        ['Shop', 1, '1/3', true], ['storefront', 2, '1/2', true], ['◆ Storefront', 3, '1/3', false], ['Fix cart', 3, '2/3', false], ['A chat', 3, '3/3', false],
        ['storefront-assets', 2, '2/2', true], ['Hero images', 3, '1/2', false], ['New chat', 3, '2/2', false],
        ['later', 1, '2/3', false], ['Other workspaces', 1, '3/3', true], ['notes', 2, '1/1', true], ['Notes', 3, '1/1', false],
    ]);
    assert.deepEqual(plain(visibleItems(tree, new Set(['workspace:w-sf', `category:${OTHERS}`])).map((x) => x.node.title)),
        ['Shop', 'storefront', 'storefront-assets', 'Hero images', 'New chat', 'later', 'Other workspaces']);
    // Nothing listed yet, or no workspaces: an empty tree.
    assert.deepEqual(plain(pageModel({ categories: null, items: [], sessions: undefined, archived: new Set() })), []);
});

test('browser half: the Categories page is headed Categories, each row says what it is, and New category makes one', async () => {
    const { client, react } = loadClient();
    const { CategoriesPage, PageTree, treeMeta, listText, TEXT } = client.internals;
    const sessions = {
        byId: { c: { id: 'c', title: '◆ DSH Plugins' }, t1: { id: 't1', title: 'Fix the page' }, x: { id: 'x', title: 'A chat' }, n: { id: 'n', title: 'Notes' } },
    };
    let workspaces = workspacesOf([
        { workspaceId: 'w-dsh', title: 'deepseek-plugins', path: '/home/u/deepseek-plugins', sessionIds: ['c', 't1', 'x'] },
        { workspaceId: 'w-notes', title: 'notes', path: '/Users/u/notes', sessionIds: ['n'] },
        { workspaceId: 'w-loose', title: 'loose', path: '/tmp/loose', sessionIds: [] },
    ]);
    let categories = [{ id: 'plugins', name: 'Plugins', source: 'page', workspaces: [{ id: 'w-dsh' }] }, { id: 'general', name: 'General', source: 'group', workspaces: [{ id: 'w-notes' }] }];
    let answer = { ok: true };
    let failed = false;
    const facts = factsOf(() => categories, { failed: () => failed, answer: () => answer });
    const props = {
        useSessions: (select) => select(sessions), useSessionStatus: (select) => select(new Map()), useWorkspaces: (select) => select(workspaces),
        plugin: { facts, openSession: () => {} },
    };
    const draw = mount(react, () => CategoriesPage(props));
    const classed = (tree, name) => textIn(byClass(tree, name));
    const newButton = (tree) => byHook(tree, 'data-categories-new');
    let page = draw();
    assert.equal(page.props['data-categories-page'], '');
    // The heading speaks of categories; Other workspaces holds the workspaces in none, so it isn't counted.
    assert.equal(textIn(elementsOf(page).filter((e) => e.type === 'h1')), 'Categories');
    assert.equal(classed(page, 'dshc-pg-count'), '2 categories');
    assert.equal(textIn(newButton(page)), 'New category');
    assert.doesNotMatch(textIn(page), /project|thread/i);
    // Each level says what it is: a category with its count, a workspace by its folder, a session by its DSH title.
    const treeEl = elementsOf(page).find((e) => e.type === PageTree);
    assert.equal(treeEl.props.label, 'Categories');
    const rows = elementsOf(mount(react, () => PageTree(treeEl.props))()).filter((e) => e.props?.role === 'treeitem')
        .map((li) => [li.props['aria-level'], li.props['data-categories-node'], classed(li.children[0], 'dshc-tree-title'), classed(li.children[0], 'dshc-tree-meta')]);
    assert.deepEqual(plain(rows), [
        [1, 'category', 'Plugins', 'Category · 1 workspace'],
        [2, 'workspace', 'deepseek-plugins', '~/deepseek-plugins'],
        [3, 'session', '◆ DSH Plugins', ''],
        [3, 'session', 'Fix the page', ''],
        [3, 'session', 'A chat', ''],
        [1, 'category', 'General', 'Category · 1 workspace'],
        [2, 'workspace', 'notes', '~/notes'],
        [3, 'session', 'Notes', ''],
        [1, 'category', 'Other workspaces', '1 workspace'],
        [2, 'workspace', 'loose', '/tmp/loose'],
    ]);
    assert.deepEqual([treeMeta({ kind: 'category', id: 'new', children: [] }), treeMeta({ kind: 'workspace', id: 'w', path: '', children: [] }), treeMeta({ kind: 'session', id: 's', children: [] })],
        ['Category · 0 workspaces', null, null]);

    // New category asks for a name, in the sidebar's words; a refusal shows under the field, and the dialog stays.
    newButton(page).props.onClick();
    page = draw();
    const dialog = elementsOf(page).find((e) => typeof e.props?.onSubmit === 'function');
    assert.deepEqual([dialog.props.title, dialog.props.label, dialog.props.action], ['New category', 'Category name', 'Create']);
    assert.match(dialog.props.description, /Add workspaces from its ⋯ menu, here or in DSH's sidebar/);
    answer = { ok: false, error: { code: 'categories/refused', message: 'a category needs a name' } };
    assert.equal(await dialog.props.onSubmit('Work'), 'A category needs a name.');
    assert.ok(elementsOf(draw()).some((e) => typeof e.props?.onSubmit === 'function'));
    // Made through the endpoint the sidebar uses, in no workspace; the dialog closes and the page says so.
    answer = { ok: true, value: { category: 'work', categories: [] } };
    assert.equal(await dialog.props.onSubmit('Work'), null);
    assert.deepEqual(facts.calls, [['createCategory', { name: 'Work', workspace: '' }], ['createCategory', { name: 'Work', workspace: '' }]]);
    page = draw();
    assert.equal(elementsOf(page).some((e) => typeof e.props?.onSubmit === 'function'), false);
    assert.equal(textIn(byHook(page, 'data-categories-page-said')), 'Work created.');

    // Nothing yet: loading while DSH's list has no workspaces yet, then the empty state says how the levels fit.
    categories = [];
    workspaces = { ...workspaces, items: [], phase: 'pending' };
    page = draw();
    assert.equal(classed(page, 'dshc-pg-state'), 'Loading categories…');
    workspaces = { ...workspaces, phase: 'ready' };
    page = draw();
    const empty = byHook(page, 'data-categories-empty');
    assert.equal(textIn(elementsOf(empty).filter((e) => e.type === 'h2')), 'No workspaces yet');
    const said = textIn(elementsOf(empty).filter((e) => e.type === 'p'));
    assert.equal(said, 'Add a workspace in DSH\'s sidebar and it shows up here. Categories group workspaces, and each workspace holds its chats.');
    assert.equal(elementsOf(empty).find((e) => e.type === client.internals.CategoriesIcon)?.props.size, 28);
    assert.equal(classed(page, 'dshc-pg-count'), '');
    assert.equal(textIn(newButton(page)), 'New category');
    // Still loading the plugin's list: no heading button yet, and the page says it is loading.
    categories = null;
    page = draw();
    assert.equal(newButton(page), undefined);
    assert.equal(classed(page, 'dshc-pg-state'), 'Loading categories…');
    // The list couldn't be read: said, with Retry, which reads it now.
    failed = true;
    page = draw();
    const error = elementsOf(page).find((e) => e.props?.role === 'alert');
    assert.equal(textIn(error), `${TEXT.unreachable} Retry`);
    elementsOf(error).find((e) => e.type === 'button').props.onClick();
    assert.deepEqual(facts.calls.at(-1), ['list', 0]);
    // The note on imported names lists them as a sentence does.
    assert.deepEqual([listText([]), listText(['A']), listText(['A', 'B']), listText(['A', 'B', 'C'])], ['', 'A', 'A and B', 'A, B and C']);
});

test('browser half: the Categories page shows DSH\'s dot on a session, names what was imported, and a chevron folds a workspace', () => {
    const storage = new Map();
    const { client, react } = loadClient({ storage });
    const { CategoriesPage, PageTree } = client.internals;
    const titles = { run: 'Upgrade the payments SDK', wait: 'Write outside', idle: 'Not started', busy: 'Busy elsewhere', x: 'A chat' };
    const sessions = { byId: Object.fromEntries(Object.entries(titles).map(([id, title]) => [id, { id, title, ...(id === 'busy' ? { running: true } : {}) }])) };
    const workspaces = workspacesOf([
        { workspaceId: 'w-sf', title: 'storefront', path: '/home/u/storefront', sessionIds: ['run', 'wait', 'idle', 'busy'] },
        { workspaceId: 'w-dp', title: 'data-pipeline', path: '/home/u/data-pipeline', sessionIds: ['x'] },
    ]);
    // Two categories the old sidebar's import made, and one made since.
    const categories = [
        { id: 'shop', name: 'Shop', source: 'import', importedFrom: 'fleet-shell', workspaces: [{ id: 'w-sf' }] },
        { id: 'data', name: 'Data', source: 'import', workspaces: [{ id: 'w-dp' }] },
        { id: 'later', name: 'Later', source: 'page', workspaces: [] },
    ];
    // DSH's own status: one session runs, one waits on the user's approval; another runs by its row's word.
    const statuses = new Map([['run', { running: true }], ['wait', { running: true, pendingInteraction: { kind: 'approval' } }]]);
    const opened = [];
    const props = {
        useSessions: (select) => select(sessions), useSessionStatus: (select) => select(statuses), useWorkspaces: (select) => select(workspaces),
        plugin: { facts: factsOf(() => categories), openSession: (id) => opened.push(id) },
    };
    const drawPage = mount(react, () => CategoriesPage(props), { effects: true });
    let page = drawPage();
    // The note names the imported categories, and says what didn't come with them; dismissed, it stays away.
    const note = byHook(page, 'data-categories-imported');
    assert.equal(textIn(note), 'Imported from your old sidebar: Shop and Data, with their workspaces. Their old instructions, files and defaults for new sessions weren\'t carried over.');
    const dismiss = elementsOf(note).find((e) => e.type === 'button');
    assert.equal(dismiss.props['aria-label'], `Dismiss: ${textIn(note)}`);
    dismiss.props.onClick();
    page = drawPage();
    assert.equal(byHook(page, 'data-categories-imported'), undefined);
    assert.equal(storage.get('dsh-plugin-categories/page-notes'), '["imported"]');

    const treeEl = elementsOf(page).find((e) => e.type === PageTree);
    const drawTree = mount(react, () => PageTree(treeEl.props), { effects: true });
    const items = (tree) => elementsOf(tree).filter((e) => e.props?.role === 'treeitem');
    const row = (tree, id) => items(tree).find((li) => li.props['data-categories-id'] === id);
    let tree = drawTree();
    // Each session with DSH's own dot, named for screen readers: waiting on the user, running, or none.
    const dot = (id) => {
        const mark = elementsOf(row(tree, id).children[0]).find((e) => e.props?.role === 'img');
        return mark ? [mark.props['aria-label'], mark.children[0]?.props.state] : null;
    };
    assert.deepEqual(plain(['run', 'wait', 'idle', 'busy', 'x'].map(dot)), [['Running', 'ongoing'], ['Needs you', 'warning'], null, ['Running', 'ongoing'], null]);
    statuses.set('x', { running: false, pendingInteraction: { kind: 'question' } });
    tree = drawTree();
    assert.deepEqual(plain(dot('x')), ['Needs you', 'warning']);
    // A row that holds something has a chevron; a session has none.
    const chevron = (li) => elementsOf(li.children[0]).find((e) => e.props?.['data-categories-chevron'] !== undefined);
    assert.equal(chevron(row(tree, 'x')), undefined);
    assert.ok(chevron(row(tree, 'shop')));
    // The chevron folds a workspace's sessions and stays on the page; the page remembers it.
    assert.equal(row(tree, 'w-sf').props['aria-expanded'], true);
    let stopped = 0;
    chevron(row(tree, 'w-sf')).props.onClick({ stopPropagation: () => { stopped += 1; } });
    tree = drawTree();
    assert.equal(row(tree, 'w-sf').props['aria-expanded'], false);
    assert.equal(row(tree, 'run'), undefined);
    assert.deepEqual([opened, stopped], [[], 1]);
    assert.equal(storage.get('dsh-plugin-categories/page-closed'), '["workspace:w-sf"]');
    // A click on the rest of a workspace's row opens and closes it too; a click on a session opens it.
    row(tree, 'w-sf').props.onClick({ stopPropagation: () => {} });
    tree = drawTree();
    assert.equal(row(tree, 'w-sf').props['aria-expanded'], true);
    assert.equal(storage.get('dsh-plugin-categories/page-closed'), '[]');
    row(tree, 'x').props.onClick({ stopPropagation: () => {} });
    assert.deepEqual(opened, ['x']);
    // A category that holds nothing has no chevron and nothing to open.
    assert.equal(row(tree, 'later').props['aria-expanded'], undefined);
    assert.equal(chevron(row(tree, 'later')), undefined);
    // A page opened again keeps what was closed, from the window's own storage only.
    storage.set('dsh-plugin-categories/page-closed', '["category:data"]');
    storage.set('dsh-plugin-projects/page-closed', '["category:shop"]');
    tree = mount(react, () => PageTree(treeEl.props))();
    assert.deepEqual([row(tree, 'shop').props['aria-expanded'], row(tree, 'data').props['aria-expanded']], [true, false]);
});

test('browser half: the Categories page\'s tree is one tab stop that the arrow keys, Home, End and Enter walk', () => {
    const { client, react } = loadClient();
    const { pageModel, PageTree } = client.internals;
    const sessions = { byId: { a: { id: 'a', title: 'Fix cart' }, b: { id: 'b', title: 'A chat' }, n: { id: 'n', title: 'Notes' } } };
    const tree = pageModel({
        categories: [{ id: 'shop', name: 'Shop', workspaces: [{ id: 'w-sf' }] }],
        items: [{ workspaceId: 'w-sf', title: 'storefront', path: '/w/sf', sessionIds: ['a', 'b'] }, { workspaceId: 'w-n', title: 'notes', path: '/w/n', sessionIds: ['n'] }],
        sessions, archived: new Set(),
    });
    const opened = [];
    const focused = [];
    const draw = mount(react, () => PageTree({ tree, label: 'Categories', statuses: new Map(), onOpenSession: (id) => opened.push(id) }));
    const items = (t) => elementsOf(t).filter((e) => e.props?.role === 'treeitem');
    // Draw it, with each item's element (React's ref) one that records its focus.
    const drawn = () => {
        const t = draw();
        for (const li of items(t)) li.props.ref({ focus: () => focused.push(li.props['data-categories-id']) });
        return t;
    };
    let t = drawn();
    const ul = elementsOf(t).find((e) => e.props?.role === 'tree');
    assert.deepEqual([ul.props['aria-label'], ul.props.className], ['Categories', 'dshc-tree']);
    const stops = (x) => items(x).filter((li) => li.props.tabIndex === 0).map((li) => li.props['data-categories-id']);
    // One tab stop, on the first item; levels and places as a screen reader reads them.
    assert.deepEqual(stops(t), ['shop']);
    assert.deepEqual(plain(items(t).map((li) => [li.props['data-categories-id'], li.props['aria-level'], li.props['aria-posinset'], li.props['aria-setsize'], li.props['aria-expanded']])), [
        ['shop', 1, 1, 2, true], ['w-sf', 2, 1, 1, true], ['a', 3, 1, 2, null], ['b', 3, 2, 2, null],
        ['@others', 1, 2, 2, true], ['w-n', 2, 1, 1, true], ['n', 3, 1, 1, null],
    ]);
    let prevented = 0;
    const press = (key, extra = {}) => {
        const tree = elementsOf(t).find((e) => e.props?.role === 'tree');
        tree.props.onKeyDown({ key, preventDefault: () => { prevented += 1; }, ...extra });
        t = drawn();
    };
    press('ArrowDown');
    assert.deepEqual([focused.at(-1), stops(t)], ['w-sf', ['w-sf']]);
    press('End');
    assert.deepEqual([focused.at(-1), stops(t)], ['n', ['n']]);
    press('ArrowDown');
    assert.equal(focused.at(-1), 'n', 'nothing after the last');
    press('Home');
    assert.deepEqual([focused.at(-1), stops(t)], ['shop', ['shop']]);
    press('ArrowUp');
    assert.equal(focused.at(-1), 'shop', 'nothing before the first');
    // ← closes an open item, then goes to its parent; → opens a closed item, then goes into it.
    press('ArrowLeft');
    assert.deepEqual(plain(items(t).map((li) => li.props['data-categories-id'])), ['shop', '@others', 'w-n', 'n']);
    press('ArrowRight');
    assert.equal(items(t).length, 7);
    press('ArrowRight');
    assert.deepEqual([focused.at(-1), stops(t)], ['w-sf', ['w-sf']]);
    press('ArrowLeft');
    assert.equal(items(t).find((li) => li.props['data-categories-id'] === 'w-sf').props['aria-expanded'], false);
    press('ArrowLeft');
    assert.deepEqual([focused.at(-1), stops(t)], ['shop', ['shop']]);
    // Enter or Space opens and closes a category or a workspace, and opens a session.
    press('Enter');
    assert.equal(items(t)[0].props['aria-expanded'], false);
    press(' ');
    assert.equal(items(t)[0].props['aria-expanded'], true);
    press('ArrowDown');
    press('ArrowRight');
    press('ArrowDown');
    assert.equal(focused.at(-1), 'a');
    press('Enter');
    assert.deepEqual(opened, ['a']);
    // Keys with Alt, Ctrl or Meta are the window's.
    const before = prevented;
    press('ArrowDown', { altKey: true });
    press('End', { ctrlKey: true });
    press('Home', { metaKey: true });
    assert.deepEqual([prevented, focused.at(-1)], [before, 'a']);
    // A click on an item takes the tab stop there.
    items(t).find((li) => li.props['data-categories-id'] === 'n').props.onClick({ stopPropagation: () => {} });
    t = drawn();
    assert.deepEqual([stops(t), opened], [['n'], ['a', 'n']]);
});

test('browser half: Alt+↑ and Alt+↓ on the Categories page move a category or a workspace, keep the focus there and say it', async () => {
    const storage = new Map();
    const { client, react } = loadClient({ storage });
    const { pageModel, pageMove, PageTree, CategoriesPage, OTHERS } = client.internals;
    const sessions = { byId: { a: { id: 'a', title: 'Fix cart' }, n: { id: 'n', title: 'Notes' } } };
    const items = [
        { workspaceId: 'w1', title: 'storefront', path: '/w/1', sessionIds: ['a'] }, { workspaceId: 'w2', title: 'assets', path: '/w/2', sessionIds: [] },
        { workspaceId: 'w3', title: 'fleet', path: '/w/3', sessionIds: [] }, { workspaceId: 'w4', title: 'notes', path: '/w/4', sessionIds: ['n'] },
    ];
    const categories = [
        { id: 'shop', name: 'Shop', workspaces: [{ id: 'w1' }, { id: 'w2' }] },
        { id: 'ops', name: 'Ops', workspaces: [{ id: 'w3' }] },
        { id: 'empty', name: 'Empty', workspaces: [] },
    ];
    const tree = pageModel({ categories, items, sessions, archived: new Set() });
    const move = (key, by) => plain(pageMove(tree, key, by));
    // A category past its neighbour (before the one after it, or to the end); none past the ends, and Other workspaces stays last.
    assert.deepEqual(move('category:ops', -1), { method: 'moveCategory', args: { category: 'ops', before: 'shop' }, said: 'Ops moved up.' });
    assert.deepEqual(move('category:shop', 1), { method: 'moveCategory', args: { category: 'shop', before: 'empty' }, said: 'Shop moved down.' });
    assert.deepEqual(move('category:ops', 1), { method: 'moveCategory', args: { category: 'ops', before: '' }, said: 'Ops moved down.' });
    assert.deepEqual(move('category:shop', -1), { refuse: 'Shop is first already.' });
    assert.deepEqual(move('category:empty', 1), { refuse: 'Empty is last already.' });
    assert.deepEqual(move(`category:${OTHERS}`, -1), { refuse: 'Other workspaces stays last: it holds the workspaces in no category.' });
    // A workspace past its neighbour in its category; from an end into the next category, nearest that end.
    assert.deepEqual(move('workspace:w2', -1), { method: 'fileWorkspace', args: { workspace: 'w2', category: 'shop', before: 'w1' }, said: 'assets moved up.' });
    assert.deepEqual(move('workspace:w1', 1), { method: 'fileWorkspace', args: { workspace: 'w1', category: 'shop', before: '' }, said: 'storefront moved down.' });
    assert.deepEqual(move('workspace:w2', 1), { method: 'fileWorkspace', args: { workspace: 'w2', category: 'ops', before: 'w3' }, said: 'assets moved to Ops.', open: 'category:ops' });
    assert.deepEqual(move('workspace:w3', -1), { method: 'fileWorkspace', args: { workspace: 'w3', category: 'shop', before: '' }, said: 'fleet moved to Shop.', open: 'category:shop' });
    assert.deepEqual(move('workspace:w3', 1), { method: 'fileWorkspace', args: { workspace: 'w3', category: 'empty', before: '' }, said: 'fleet moved to Empty.', open: 'category:empty' });
    // Into Other workspaces is into no category; out of it, into the last category.
    assert.deepEqual(move('workspace:w4', -1), { method: 'fileWorkspace', args: { workspace: 'w4', category: 'empty', before: '' }, said: 'notes moved to Empty.', open: 'category:empty' });
    assert.deepEqual(move('workspace:w4', 1), { refuse: 'notes is last already.' });
    assert.deepEqual(move('workspace:w1', -1), { refuse: 'storefront is first already.' });
    const alone = pageModel({ categories: [{ id: 'shop', name: 'Shop', workspaces: [{ id: 'w1' }] }], items: items.slice(0, 1), sessions, archived: new Set() });
    assert.deepEqual(plain(pageMove(alone, 'workspace:w1', 1)), { method: 'fileWorkspace', args: { workspace: 'w1', category: '', before: '' }, said: 'storefront moved to Other workspaces.', open: `category:${OTHERS}` });
    // A session's place is DSH's: nothing to do.
    assert.equal(pageMove(tree, 'session:a', 1), null);
    assert.equal(pageMove(tree, 'workspace:gone', 1), null);

    // The tree: Alt+↑ and Alt+↓ go to onMove with the item that has the focus; a target that is closed opens.
    storage.set('dsh-plugin-categories/page-closed', '["category:ops"]');
    const asked = [];
    let answer = null;
    const draw = mount(react, () => PageTree({ tree, label: 'Categories', statuses: new Map(), onOpenSession: () => {}, onMove: (key, by) => { asked.push([key, by]); return answer; } }), { effects: true });
    const lis = (t) => elementsOf(t).filter((e) => e.props?.role === 'treeitem');
    let t = draw();
    assert.deepEqual(plain(lis(t).filter((li) => li.props['aria-keyshortcuts']).map((li) => li.props['data-categories-id'])), ['shop', 'w1', 'w2', 'ops', 'empty', 'w4']);
    let prevented = 0;
    const press = (key, extra = {}) => {
        elementsOf(t).find((e) => e.props?.role === 'tree').props.onKeyDown({ key, preventDefault: () => { prevented += 1; }, ...extra });
        t = draw();
    };
    lis(t).find((li) => li.props['data-categories-id'] === 'w2').props.onFocus({ target: 1, currentTarget: 1 });
    t = draw();
    press('ArrowDown', { altKey: true });
    assert.deepEqual([plain(asked), prevented], [[['workspace:w2', 1]], 0], 'an item that doesn\'t move leaves the key alone');
    answer = { open: 'category:ops' };
    press('ArrowDown', { altKey: true });
    assert.equal(prevented, 1);
    assert.equal(lis(t).find((li) => li.props['data-categories-id'] === 'ops').props['aria-expanded'], true);
    assert.equal(storage.get('dsh-plugin-categories/page-closed'), '[]');
    press('ArrowUp', { altKey: true });
    assert.deepEqual(plain(asked.at(-1)), ['workspace:w2', -1]);
    // With Shift, Ctrl or Meta too, the keys are the window's.
    press('ArrowUp', { altKey: true, shiftKey: true });
    press('ArrowDown', { altKey: true, ctrlKey: true });
    assert.equal(asked.length, 3);

    // The page makes the move on the whole tree and says it once it's done; a refusal is said at once.
    const facts = factsOf(() => categories);
    const props = { useSessions: (select) => select(sessions), useSessionStatus: (select) => select(new Map()), useWorkspaces: (select) => select(workspacesOf(items)), plugin: { facts, openSession: () => {} } };
    const drawPage = mount(react, () => CategoriesPage(props));
    let page = drawPage();
    const onMove = elementsOf(page).find((e) => e.type === PageTree).props.onMove;
    assert.deepEqual(plain(onMove('workspace:w2', 1)), { open: 'category:ops' });
    await tick();
    page = drawPage();
    assert.deepEqual(plain(facts.calls.at(-1)), ['fileWorkspace', { workspace: 'w2', category: 'ops', before: 'w3' }]);
    assert.equal(textIn(byHook(page, 'data-categories-page-said')), 'assets moved to Ops.');
    assert.deepEqual(plain(onMove('category:shop', -1)), {});
    page = drawPage();
    assert.equal(textIn(byHook(page, 'data-categories-page-said')), 'Shop is first already.');
    assert.equal(onMove('session:a', 1), null);
    const refused = factsOf(() => categories, { answer: () => ({ ok: false, error: { code: 'categories/refused', message: 'DSH has no such workspace' } }) });
    const drawRefused = mount(react, () => CategoriesPage({ ...props, plugin: { facts: refused, openSession: () => {} } }));
    elementsOf(drawRefused()).find((e) => e.type === PageTree).props.onMove('workspace:w1', 1);
    await tick();
    assert.match(textIn(byHook(drawRefused(), 'data-categories-page-said')), /no such workspace/i);
});

test('browser half: on the Categories page a category\'s row has the sidebar\'s ⋯ menu and a workspace\'s has its own', async () => {
    const storage = new Map();
    const { client, react } = loadClient({ storage });
    const { PageTree, CategoriesPage, CategoryMenu, WorkspaceMenu, OTHERS } = client.internals;
    const sessions = { byId: { a: { id: 'a', title: 'Fix cart' } } };
    const items = [
        { workspaceId: 'w1', title: 'storefront', path: '/w/1', sessionIds: ['a'] }, { workspaceId: 'w2', title: 'assets', path: '/w/2', sessionIds: [] },
        { workspaceId: 'w3', title: 'fleet', path: '/w/3', sessionIds: [] }, { workspaceId: 'w4', title: 'notes', path: '/w/4', sessionIds: [] },
    ];
    const categories = [{ id: 'shop', name: 'Shop', workspaces: [{ id: 'w1' }, { id: 'w2' }] }, { id: 'ops', name: 'Ops', workspaces: [{ id: 'w3' }] }];
    let answer = { ok: true, value: {} };
    const facts = factsOf(() => categories, { answer: () => answer });
    const started = [];
    const addWorkspace = { state: () => ({ busy: false }), start: (made) => { started.push(made); return true; } };
    const props = {
        useSessions: (select) => select(sessions), useSessionStatus: (select) => select(new Map()), useWorkspaces: (select) => select(workspacesOf(items)),
        plugin: { facts, openSession: () => {}, addWorkspace },
    };
    const drawPage = mount(react, () => CategoriesPage(props));
    const said = () => textIn(byHook(drawPage(), 'data-categories-page-said'));
    const treeProps = () => elementsOf(drawPage()).find((e) => e.type === PageTree).props;
    const { menu } = treeProps();
    // Categories, Other workspaces and workspaces have a menu; a session has DSH's own.
    assert.deepEqual(plain([['category', 'shop'], ['category', OTHERS], ['workspace', 'w4'], ['session', 'a']].map(([kind, id]) => menu.has({ kind, id }))), [true, true, true, false]);
    const reveals = [];
    let keeps = 0;
    const open = (kind, id, title) => menu.draw({ node: { kind, id, title, children: [] }, open: true, setOpen: () => {}, reveal: (key) => reveals.push(key), keep: () => { keeps += 1; } });
    // A category's: the sidebar's own menu, at the end of its row on the page.
    const shopEl = open('category', 'shop', 'Shop');
    assert.equal(shopEl.type, CategoryMenu);
    assert.deepEqual(plain([shopEl.props.page, shopEl.props.first, shopEl.props.last]), [true, true, false]);
    const shop = CategoryMenu(shopEl.props);
    assert.deepEqual(plain([shop.props.anchor.props.className, shop.props.anchor.props['data-categories-page-menu'], shop.props.anchor.props['data-categories-menu'], shop.props.anchor.props['aria-label']]),
        ['dshc-tree-more', 'shop', null, 'Category actions: Shop']);
    assert.deepEqual(plain(shop.props.items.map((i) => i.id ?? i.type)), ['add', 'newWorkspace', 's1', 'up', 'down', 's2', 'rename', 'new', 'delete']);
    assert.deepEqual(plain(shop.props.items.find((i) => i.id === 'add').submenu.map((i) => i.id ?? i.text)), ['free', 'w:w4', 'taken', 'w:w3']);
    assert.deepEqual(plain(shop.props.items.filter((i) => i.disabled).map((i) => i.id)), ['up']);
    // Move down: said once done, and the category keeps the focus.
    shop.props.onSelect('down');
    await tick();
    assert.deepEqual(plain(facts.calls.at(-1)), ['moveCategory', { category: 'shop', before: '' }]);
    assert.equal(said(), 'Shop moved down.');
    assert.equal(keeps, 1);
    // Add a workspace files it last there, said; the category opens.
    shop.props.onSelect('w:w4');
    await tick();
    assert.deepEqual(plain(facts.calls.at(-1)), ['fileWorkspace', { workspace: 'w4', category: 'shop', before: '' }]);
    assert.equal(said(), 'notes moved to Shop.');
    assert.deepEqual(reveals, ['category:shop']);
    // New workspace… runs DSH's own Add workspace and files what it makes.
    shop.props.onSelect('newWorkspace');
    assert.equal(started.length, 1);
    started[0]({ workspaceId: 'w5', title: 'fresh' });
    await tick();
    assert.deepEqual(plain(facts.calls.at(-1)), ['fileWorkspace', { workspace: 'w5', category: 'shop', before: '' }]);
    assert.equal(said(), 'fresh added to Shop.');
    // Rename and Delete ask first, in the sidebar's dialogs.
    shop.props.onSelect('rename');
    let dialog = elementsOf(drawPage()).find((e) => typeof e.props?.onSubmit === 'function');
    assert.deepEqual(plain([dialog.props.title, dialog.props.initial]), ['Rename category', 'Shop']);
    assert.equal(await dialog.props.onSubmit('Store'), null);
    assert.deepEqual(plain(facts.calls.at(-1)), ['renameCategory', { category: 'shop', name: 'Store' }]);
    assert.equal(said(), 'Renamed to Store.');
    shop.props.onSelect('delete');
    dialog = elementsOf(drawPage()).find((e) => typeof e.props?.onSubmit === 'function');
    assert.match(dialog.props.text, /This deletes “Shop”\. Its 2 workspaces move to Other workspaces\./);
    answer = { ok: false, error: { code: 'categories/refused', message: 'no such category' } };
    assert.equal(await dialog.props.onSubmit(), 'No such category.');
    answer = { ok: true, value: {} };
    assert.equal(await dialog.props.onSubmit(), null);
    assert.deepEqual(plain(facts.calls.at(-1)), ['removeCategory', { category: 'shop' }]);
    assert.equal(said(), 'Shop deleted.');
    // Other workspaces': New workspace… and New category….
    const others = CategoryMenu(open('category', OTHERS, 'Other workspaces').props);
    assert.deepEqual(plain([others.props.items.map((i) => i.id), others.props.anchor.props['data-categories-page-menu']]), [['newWorkspace', 'new'], OTHERS]);

    // A workspace's: Move to another category or none, New category with it, Move up and down in its category.
    const assetsEl = open('workspace', 'w2', 'assets');
    assert.equal(assetsEl.type, WorkspaceMenu);
    const assets = WorkspaceMenu(assetsEl.props);
    assert.deepEqual(plain([assets.props.anchor.props.className, assets.props.anchor.props['data-categories-page-menu'], assets.props.anchor.props['aria-label']]),
        ['dshc-tree-more', 'w2', 'Workspace actions: assets']);
    assert.deepEqual(plain(assets.props.items.map((i) => [i.id ?? i.type, i.label ?? null, i.disabled === true])), [
        ['to', 'Move to', false], ['new', 'New category with it…', false], ['s1', null, false], ['up', 'Move up', false], ['down', 'Move down', true],
    ]);
    assert.deepEqual(plain(assets.props.items[0].submenu.map((i) => [i.id, i.label])), [['c:ops', 'Ops'], ['c:', 'Other workspaces']]);
    assets.props.onSelect('c:ops');
    await tick();
    assert.deepEqual(plain(facts.calls.at(-1)), ['fileWorkspace', { workspace: 'w2', category: 'ops', before: '' }]);
    assert.equal(said(), 'assets moved to Ops.');
    assets.props.onSelect('c:');
    await tick();
    assert.deepEqual(plain(facts.calls.at(-1)), ['fileWorkspace', { workspace: 'w2', category: '', before: '' }]);
    assert.equal(said(), 'assets moved to Other workspaces.');
    assert.deepEqual(reveals.slice(-2), ['category:ops', `category:${OTHERS}`]);
    assets.props.onSelect('up');
    await tick();
    assert.deepEqual(plain(facts.calls.at(-1)), ['fileWorkspace', { workspace: 'w2', category: 'shop', before: 'w1' }]);
    assets.props.onSelect('new');
    dialog = elementsOf(drawPage()).find((e) => typeof e.props?.onSubmit === 'function');
    assert.deepEqual(plain([dialog.props.title, dialog.props.description]), ['New category', 'assets moves into it.']);
    assert.equal(await dialog.props.onSubmit('Media'), null);
    assert.deepEqual(plain(facts.calls.at(-1)), ['createCategory', { name: 'Media', workspace: 'w2' }]);
    // In none, with no categories: nowhere to move it yet.
    const loose = WorkspaceMenu({ ...open('workspace', 'w4', 'notes').props, group: null, categories: [] });
    assert.deepEqual(plain(loose.props.items[0].submenu), [{ id: 'none', label: 'No categories yet', disabled: true }]);

    // The tree: ⋯ at the end of each row that has a menu; Shift+F10, the context-menu key or a right-click opens it.
    const drawTree = mount(react, () => PageTree(treeProps()), { effects: true });
    const lis = (t) => elementsOf(t).filter((e) => e.props?.role === 'treeitem');
    const li = (t, id) => lis(t).find((e) => e.props['data-categories-id'] === id);
    const opened = (t) => lis(t).filter((e) => elementsOf(e.children[0]).some((m) => m.props?.open === true)).map((e) => e.props['data-categories-id']);
    let t = drawTree();
    assert.deepEqual(plain(lis(t).map((e) => [e.props['data-categories-id'], e.props['aria-keyshortcuts'] ?? null, elementsOf(e.children[0]).some((m) => m.type === CategoryMenu || m.type === WorkspaceMenu)])), [
        ['shop', 'Alt+ArrowUp Alt+ArrowDown Shift+F10', true], ['w1', 'Alt+ArrowUp Alt+ArrowDown Shift+F10', true], ['a', null, false],
        ['w2', 'Alt+ArrowUp Alt+ArrowDown Shift+F10', true], ['ops', 'Alt+ArrowUp Alt+ArrowDown Shift+F10', true], ['w3', 'Alt+ArrowUp Alt+ArrowDown Shift+F10', true],
        [OTHERS, 'Shift+F10', true], ['w4', 'Alt+ArrowUp Alt+ArrowDown Shift+F10', true],
    ]);
    const keyOn = (id, key, extra = {}) => {
        li(t, id).props.onFocus({ target: 1, currentTarget: 1 });
        t = drawTree();
        let prevented = 0;
        elementsOf(t).find((e) => e.props?.role === 'tree').props.onKeyDown({ key, preventDefault: () => { prevented += 1; }, ...extra });
        t = drawTree();
        return prevented;
    };
    assert.equal(keyOn('ops', 'F10', { shiftKey: true }), 1);
    assert.deepEqual(opened(t), ['ops']);
    elementsOf(li(t, 'ops').children[0]).find((m) => m.type === CategoryMenu).props.setOpen(false);
    t = drawTree();
    assert.deepEqual(opened(t), []);
    assert.equal(keyOn('w4', 'ContextMenu'), 1);
    assert.deepEqual(opened(t), ['w4']);
    assert.equal(keyOn('a', 'ContextMenu'), 0, 'a session has no menu here');
    // A right-click on a workspace's row opens its menu; on a session inside it, nothing (the browser's own).
    let stopped = 0;
    const row = { closest: () => null };
    const right = (id, target) => li(drawTree(), id).props.onContextMenu?.({ target, currentTarget: { contains: () => true }, preventDefault: () => { stopped += 1; }, stopPropagation: () => {} });
    const w1 = li(t, 'w1');
    row.closest = () => w1;
    w1.props.onContextMenu({ target: row, currentTarget: w1, preventDefault: () => { stopped += 1; }, stopPropagation: () => {} });
    t = drawTree();
    assert.deepEqual([opened(t), stopped], [['w1'], 1]);
    assert.equal(right('a', row), undefined, 'no handler on a session');
    // Keys and clicks from an open menu (drawn elsewhere) don't move or open anything in the tree.
    const outside = { currentTarget: { contains: () => false }, target: {} };
    let moved = 0;
    elementsOf(t).find((e) => e.props?.role === 'tree').props.onKeyDown({ key: 'ArrowDown', preventDefault: () => { moved += 1; }, ...outside });
    li(t, 'w1').props.onClick({ stopPropagation: () => { moved += 1; }, ...outside });
    assert.equal(moved, 0);
    assert.equal(li(drawTree(), 'w1').props['aria-expanded'], true);
});

test('browser half: Find by name on the Categories page keeps each match where it lives, and its folds are its own', () => {
    const { client, react } = loadClient();
    const { CategoriesPage, PageTree, findInTree, withHit, treeMeta } = client.internals;
    const sessions = {
        byId: { c: { id: 'c', title: '◆ Storefront' }, t1: { id: 't1', title: 'Fix the cart' }, w: { id: 'w', title: 'Landing page' }, x: { id: 'x', title: 'Fleet power budget' }, n: { id: 'n', title: 'Lane restarts' } },
    };
    const workspaces = workspacesOf([
        { workspaceId: 'w-sf', title: 'storefront', path: '/home/u/storefront', sessionIds: ['c', 't1', 'x'] },
        { workspaceId: 'w-web', title: 'website', path: '/home/u/website', sessionIds: ['w'] },
        { workspaceId: 'w-ops', title: 'fleet-ops', path: '/home/u/fleet-ops', sessionIds: ['n'] },
    ]);
    const categories = [{ id: 'shop', name: 'Shop', workspaces: [{ id: 'w-sf' }, { id: 'w-web' }] }, { id: 'fleet', name: 'Fleet Services', workspaces: [{ id: 'w-ops' }] }];
    const props = {
        useSessions: (select) => select(sessions), useSessionStatus: (select) => select(new Map()), useWorkspaces: (select) => select(workspaces),
        plugin: { facts: factsOf(() => categories), openSession: () => {} },
    };
    const draw = mount(react, () => CategoriesPage(props));
    const find = (page) => byHook(page, 'data-categories-find');
    const clear = (page) => byHook(page, 'data-categories-find-clear');
    const treeOf = (page) => elementsOf(page).find((e) => e.type === PageTree);
    const titles = (tree) => elementsOf(tree).filter((e) => e.props?.role === 'treeitem').map((li) => textIn(byClass(li.children[0], 'dshc-tree-title')));
    let page = draw();
    assert.deepEqual([find(page).type, find(page).props['aria-label'], find(page).props.placeholder, find(page).props.role, find(page).props.value, clear(page)],
        ['Input', 'Find by name', 'Find by name', 'searchbox', '', undefined]);
    assert.equal(treeOf(page).props.find, '');
    const whole = treeOf(page).props.tree;
    // A session's name: its workspace and category stay around it, and nothing else; the category still counts all.
    find(page).props.onChange({ target: { value: 'cart' } });
    page = draw();
    let tree = mount(react, () => PageTree(treeOf(page).props))();
    assert.deepEqual(plain(titles(tree)), ['Shop', 'storefront', 'Fix the cart']);
    assert.equal(textIn(byClass(elementsOf(tree).find((e) => e.props?.['data-categories-node'] === 'category').children[0], 'dshc-tree-meta')), 'Category · 2 workspaces');
    // The words are marked in the title, which keeps its whole name for the hooks.
    const hit = elementsOf(tree).find((e) => e.type === 'mark');
    assert.deepEqual([textIn(hit), hit.props.className], ['cart', 'dshc-tree-hit']);
    assert.equal(byClass(tree, 'dshc-tree-title').find((e) => e.props['data-categories-title'] === 'Fix the cart')?.props['data-categories-title'], 'Fix the cart');
    assert.deepEqual(plain(withHit('Fix the cart', 'CART').map((part) => (typeof part === 'string' ? part : `[${textIn(part)}]`))), ['Fix the ', '[cart]']);
    assert.deepEqual(plain(withHit('Fix', 'zz')), ['Fix']);
    // The box shows its × while it holds something.
    assert.equal(find(page).props.className, 'dshc-pg-find-box dshc-pg-find-query');
    assert.equal(clear(page).props['aria-label'], 'Clear the find');
    // A category's name keeps the whole category; any case matches; a session's name keeps only it in its workspace.
    assert.deepEqual(plain(findInTree(whole, 'FLEET').map((n) => [n.title, n.children.map((w) => [w.title, w.children.map((c) => c.title)])])), [
        ['Shop', [['storefront', ['Fleet power budget']]]],
        ['Fleet Services', [['fleet-ops', ['Lane restarts']]]],
    ]);
    assert.equal(findInTree(whole, '  '), whole);
    // Closing an item while finding is the find's own: the page's kept folds don't change, and a new find starts open.
    find(page).props.onChange({ target: { value: 'storefront' } });
    let treeProps = treeOf(draw()).props;
    const drawTree = mount(react, () => PageTree(treeProps));
    const workspace = (t) => elementsOf(t).find((e) => e.props?.['data-categories-id'] === 'w-sf');
    const fold = (t) => elementsOf(workspace(t).children[0]).find((e) => e.props?.['data-categories-chevron'] !== undefined).props.onClick({ stopPropagation: () => {} });
    fold(drawTree());
    assert.equal(workspace(drawTree()).props['aria-expanded'], false);
    find(page).props.onChange({ target: { value: 'store' } });
    treeProps = treeOf(draw()).props;
    assert.equal(workspace(drawTree()).props['aria-expanded'], true);
    find(page).props.onChange({ target: { value: '' } });
    treeProps = treeOf(draw()).props;
    assert.equal(workspace(drawTree()).props['aria-expanded'], true);
    // Without a find, a fold is the page's own again.
    fold(drawTree());
    assert.equal(workspace(drawTree()).props['aria-expanded'], false);
    find(page).props.onChange({ target: { value: 'storefront' } });
    treeProps = treeOf(draw()).props;
    assert.equal(workspace(drawTree()).props['aria-expanded'], true);
    find(page).props.onChange({ target: { value: '' } });
    treeProps = treeOf(draw()).props;
    assert.equal(workspace(drawTree()).props['aria-expanded'], false);
    fold(drawTree());
    // ↓ in the box goes into the tree, at its tab stop.
    page = draw();
    const asked = [];
    treeOf(page).props.treeRef.current = { querySelector: (selector) => { asked.push(selector); return { focus: () => asked.push('focus') }; } };
    let prevented = 0;
    find(page).props.onKeyDown({ key: 'ArrowDown', preventDefault: () => { prevented += 1; }, stopPropagation: () => {} });
    assert.deepEqual([asked, prevented], [['[role="treeitem"][tabindex="0"]', 'focus'], 1]);
    // Nothing found: said in words, and Escape empties the box.
    find(page).props.onChange({ target: { value: 'zzz' } });
    page = draw();
    assert.equal(treeOf(page), undefined);
    const none = byHook(page, 'data-categories-find-none');
    assert.deepEqual([none.props.role, textIn(none)], ['status', 'Nothing matches “zzz”.']);
    // Its × empties the box too.
    clear(page).props.onClick();
    assert.equal(find(draw()).props.value, '');
    find(page).props.onChange({ target: { value: 'zzz' } });
    page = draw();
    prevented = 0;
    let stopped = 0;
    find(page).props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; } });
    page = draw();
    assert.deepEqual([find(page).props.value, prevented, stopped, titles(mount(react, () => PageTree(treeOf(page).props))()).length], ['', 1, 1, 10]);
    // Escape in an empty box is the window's.
    find(page).props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented += 1; }, stopPropagation: () => {} });
    assert.equal(prevented, 1);
    assert.equal(treeMeta({ kind: 'category', id: 'c', children: [{}], whole: [{}, {}] }), 'Category · 2 workspaces');
});

test('browser half: DSH\'s session list is grouped by category, foldable, with Other workspaces last', () => {
    const { client } = loadClient();
    const { sidebarGroups, sidebarRules, groupDot, OTHERS } = client.internals;
    const items = ['w2', 'w1', 'w4', 'w3', 'w5'].map((workspaceId) => ({ workspaceId, sessionIds: [] }));
    const categories = [
        { id: 'a', name: 'Alpha', workspaces: [{ id: 'w2' }, { id: 'gone' }] },
        { id: 'b', name: 'Beta', workspaces: [{ id: 'w4' }, { id: 'w1' }, { id: 'w2' }] },
        { id: 'c', name: 'Empty', workspaces: [] },
    ];
    // In the plugin's order, empty ones too; each holds its workspaces in DSH's order, a workspace once; DSH's
    // deleted ones drop out; Other workspaces holds the rest.
    assert.deepEqual(plain(sidebarGroups(categories, items)), [
        { id: 'a', name: 'Alpha', category: true, workspaces: ['w2'] },
        { id: 'b', name: 'Beta', category: true, workspaces: ['w1', 'w4'] },
        { id: 'c', name: 'Empty', category: true, workspaces: [] },
        { id: OTHERS, name: 'Other workspaces', category: false, workspaces: ['w3', 'w5'] },
    ]);
    // Other workspaces shows while it holds one, or while a workspace is dragged (somewhere to drop it).
    const filed = [{ id: 'a', name: 'All', workspaces: items.map((ws) => ({ id: ws.workspaceId })) }];
    assert.deepEqual(plain(sidebarGroups(filed, items)).map((g) => g.id), ['a']);
    assert.deepEqual(plain(sidebarGroups(filed, items, true)).map((g) => [g.id, g.workspaces.length]), [['a', 5], [OTHERS, 0]]);
    // Not known yet: DSH's list as it is. No categories: Other workspaces over them all (see the test after this one).
    assert.deepEqual(plain(sidebarGroups([], items)).map((g) => [g.id, g.workspaces.length]), [[OTHERS, 5]]);
    assert.equal(sidebarGroups(null, items), null);
    assert.equal(sidebarGroups(categories, undefined), null);
    // An unnamed category goes by its id.
    assert.equal(sidebarGroups([{ id: 'x', name: '', workspaces: [] }], [])[0].name, 'x');

    const groups = sidebarGroups(categories, items);
    const rules = sidebarRules(groups, new Set(['b'])).split('\n');
    // The rules find the list and its sections by the plugin's marks (markList), never by what an element holds, so
    // a change in one workspace restyles that workspace, not the whole list.
    const on = '[data-slot="sidebar.workspaces"] [role="tree"][data-categories-list]';
    const section = (id) => `[data-categories-ws="${id}"]`;
    for (const rule of rules) assert.doesNotMatch(rule.slice(0, rule.indexOf('{')), /:has\(|~|\+/, rule);
    assert.ok(rules.includes(`${on}{display:flex;flex-direction:column}`));
    // Each workspace's section right after its category's header (headers take the even places), a folded category's hidden.
    assert.ok(rules.includes(`${on}>${section('w2')}{order:1}`));
    assert.ok(rules.includes(`${on}>${section('w1')}{order:3;display:none!important}`));
    assert.ok(rules.includes(`${on}>${section('w3')}{order:7}`));
    // Sections a step in, as DSH's own indent; a folder's nested workspaces in Workspace Tree a step further each.
    assert.ok(rules.includes(`${on}>[data-categories-ws]{margin-top:4px!important;--dsh-workspace-indent:12px!important}`));
    assert.ok(rules.includes(`${on} [data-categories-depth="1"]{--dsh-workspace-indent:24px!important}`));
    assert.ok(rules.includes(`${on} [data-categories-depth="4"]{--dsh-workspace-indent:60px!important}`));
    // DSH's Ungrouped bucket last, level with the headers; anything else in the list with Other workspaces, and so is
    // a section DSH just added until the plugin's next pass marks it (DSH measures it for its row animation first).
    assert.ok(rules.includes(`${on}>[data-categories-ws=""]{order:8;margin-top:10px!important;--dsh-workspace-indent:0px!important}`));
    assert.ok(rules.includes(`${on}>*{flex-shrink:0;order:7}`));
    // Headers hide where DSH shows no workspaces (In one list, search).
    assert.ok(rules.includes('[data-slot="sidebar.workspaces"] [role="tree"]:not([data-categories-list])>[data-categories-sb]{display:none}'));
    // An id that could break out of a selector gets no rule.
    const odd = sidebarRules([{ id: 'x', name: 'X', category: true, workspaces: ['a"] *{display:none} [x="'] }], new Set()).split('\n');
    for (const rule of odd) assert.doesNotMatch(rule, /display:none\} \[x=/);

    // A folded category's dot: waiting on you if one of its chats is, else running if one runs.
    const byId = new Map([['w1', { sessionIds: ['s1', 's2'] }], ['w4', { sessionIds: ['s3'] }]]);
    const beta = groups[1];
    assert.equal(groupDot(beta, byId, new Map()), null);
    assert.equal(groupDot(beta, byId, new Map([['s3', { running: true }]])), 'ongoing');
    assert.equal(groupDot(beta, byId, new Map([['s3', { running: true }], ['s2', { pendingInteraction: { kind: 'approval' } }]])), 'warning');

    // The headers sit in DSH's list just before their category's first section, an empty category's before the
    // next header, DSH's Ungrouped bucket last: the list reads in the order it is drawn. A second pass moves nothing.
    const { placeHeaders, describeWorkspaces } = client.internals;
    let moves = 0;
    const fakeTree = (kids) => {
        const tree = {
            children: kids,
            insertBefore(node, ref) {
                moves += 1;
                this.children.splice(this.children.indexOf(node), 1);
                this.children.splice(ref === null ? this.children.length : this.children.indexOf(ref), 0, node);
            },
        };
        for (const kid of kids) Object.defineProperty(kid, 'nextElementSibling', { get: () => tree.children[tree.children.indexOf(kid) + 1] ?? null });
        return tree;
    };
    const head = (id) => ({ id: `H:${id}`, getAttribute: (name) => (name === 'data-categories-sb' ? id : null), contains: () => false });
    const sec = (ws) => ({ id: ws === '' ? 'strays' : ws, getAttribute: () => null, querySelector: () => ({ getAttribute: () => `workspace:${ws}` }) });
    const tree = fakeTree([sec('w2'), sec('w1'), sec('w4'), sec('w3'), sec('w5'), sec(''), head('a'), head('b'), head('c'), head(OTHERS)]);
    placeHeaders(tree, groups);
    assert.deepEqual(tree.children.map((e) => e.id), ['H:a', 'w2', 'H:b', 'w1', 'w4', 'H:c', `H:${OTHERS}`, 'w3', 'w5', 'strays']);
    const before = moves;
    placeHeaders(tree, groups);
    assert.equal(moves, before);

    // Each workspace row names its category to a screen reader; the plugin's words go when the categories do.
    const attrs = new Map();
    const wsRow = (id, own = {}) => {
        const a = new Map(Object.entries({ 'data-row-key': `workspace:${id}`, ...own }));
        attrs.set(id, a);
        return { getAttribute: (n) => a.get(n) ?? null, setAttribute: (n, v) => a.set(n, String(v)), hasAttribute: (n) => a.has(n), removeAttribute: (n) => a.delete(n) };
    };
    const rows = [wsRow('w2'), wsRow('w1'), wsRow('w3'), wsRow('new', { 'aria-description': 'DSH\'s own' })];
    const list = { querySelectorAll: () => rows };
    describeWorkspaces(list, groups);
    assert.deepEqual(['w2', 'w1', 'w3'].map((id) => [attrs.get(id).get('aria-description'), attrs.get(id).get('data-categories-in')]),
        [['in Alpha', ''], ['in Beta', ''], ['in Other workspaces', '']]);
    assert.equal(attrs.get('new').get('aria-description'), 'DSH\'s own');
    describeWorkspaces(list, null);
    assert.deepEqual(['w2', 'w1', 'w3'].map((id) => attrs.get(id).has('aria-description') || attrs.get(id).has('data-categories-in')), [false, false, false]);
    assert.equal(attrs.get('new').get('aria-description'), 'DSH\'s own', 'a description the plugin didn\'t give stays');
});

/**
 * DSH's session list as the plugin draws it, with what DSH's stand-ins
 * give it: the list's workspaces, the categories, DSH's statuses and its own
 * Add workspace (`adding`: its state, or null where DSH has none). Its
 * headers and their menus draw as they would in the list.
 * @param answer - what an endpoint answers ({ok: true} by default).
 */
function drawSidebar({ items, categories, adding = { busy: false }, statuses = new Map(), storage, answer = () => ({ ok: true, value: {} }), sessions }) {
    const tree = { id: 'dsh-list' };
    const { client, react } = loadClient({ storage, document: { querySelector: () => tree, head: { id: 'head' } } });
    const facts = factsOf(categories, { answer });
    const calls = facts.calls;
    const flow = { made: null };
    const addWorkspace = adding === null ? undefined : {
        state: () => adding,
        start(made) { calls.push(['start']); flow.made = made; return true; },
        stop() {},
    };
    const props = {
        useWorkspaces: (select) => select({ items, archivedSessionIds: [], pinnedSessionIds: [] }), useSessionStatus: (select) => select(statuses),
        ...(sessions ? { useSessions: (select) => select(sessions) } : {}),
        plugin: { facts, addWorkspace },
    };
    const draw = mount(react, () => client.internals.SidebarTree(props));
    /** A header as drawn now ({type: CategoryHeader, props}), by its group's id. */
    const header = (id) => elementsOf(draw()).find((e) => e.props?.menu?.actions && e.props.group.id === id);
    /** A header drawn on its own, with state that holds; `menu()` draws its ⋯ menu. */
    const open = (id) => {
        const el = header(id);
        const again = mount(react, () => el.type(el.props));
        return {
            again,
            menu: () => {
                const m = elementsOf(again()).find((e) => typeof e.props?.setOpen === 'function');
                return m.type(m.props);
            },
        };
    };
    const said = () => textIn(byHook(draw(), 'data-categories-sidebar-said'));
    const dialog = () => elementsOf(draw()).find((e) => typeof e.props?.onSubmit === 'function');
    return { client, react, tree, draw, header, open, said, dialog, calls, flow };
}

test('browser half: with no categories, Other workspaces heads DSH\'s list, and its ⋯ makes the first category', async () => {
    const { client } = loadClient();
    const { sidebarGroups, OTHERS } = client.internals;
    const items = [{ workspaceId: 'w-a', title: 'alpha', sessionIds: [] }, { workspaceId: 'w-b', title: 'beta', sessionIds: [] }];
    // Every workspace under Other workspaces, in DSH's order, as on the Categories page; nothing to head without workspaces.
    assert.deepEqual(plain(sidebarGroups([], items)), [{ id: OTHERS, name: 'Other workspaces', category: false, workspaces: ['w-a', 'w-b'] }]);
    assert.equal(sidebarGroups([], []), null);

    let categories = [];
    const { draw, header, open, said, dialog, calls, tree } = drawSidebar({ items, categories: () => categories });
    // One header, over both workspaces, drawn into DSH's list, with the CSS that sets DSH's rows under it (and hides
    // it in In one list and search).
    const heads = elementsOf(draw()).filter((e) => e.props?.menu?.actions);
    assert.deepEqual(plain(heads.map((e) => [e.props.group.id, e.props.count])), [[OTHERS, 2]]);
    const style = elementsOf(draw()).find((e) => e.type === 'style');
    assert.equal(style.props['data-categories-sidebar'], '');
    const css = textIn(style);
    assert.match(css, /\[data-categories-ws="w-a"\]\{order:1\}/);
    assert.match(css, /\[role="tree"\]:not\(\[data-categories-list\]\)>\[data-categories-sb\]\{display:none\}/);
    assert.ok(tree);

    // Its ⋯ menu opens as a category's does: the ⋯ button, a right-click, Shift+F10 and the context-menu key.
    const others = open(OTHERS);
    let head = others.again();
    assert.equal(head.props['aria-keyshortcuts'], 'Shift+F10');
    assert.equal(head.props['data-categories-sb'], OTHERS);
    assert.equal(head.props.draggable, false);
    assert.deepEqual(plain(head.props.style), { order: 0, marginTop: 0 });
    let menu = others.menu();
    assert.equal(menu.props.open, false);
    const button = menu.props.anchor;
    assert.deepEqual([button.props['aria-label'], button.props['data-categories-others-menu'], button.props['data-categories-menu'], button.props.tabIndex],
        ['Actions for Other workspaces', '', undefined, -1]);
    let stopped = 0;
    button.props.onClick({ stopPropagation() { stopped += 1; } });
    assert.deepEqual([others.menu().props.open, stopped], [true, 1]);
    head = others.again();
    assert.equal(head.props['data-categories-menu-open'], '');
    others.menu().props.onClose();
    assert.equal(others.menu().props.open, false);
    let prevented = 0;
    head.props.onContextMenu({ currentTarget: { contains: () => true }, target: {}, preventDefault() { prevented += 1; } });
    assert.deepEqual([others.menu().props.open, prevented], [true, 1]);
    const key = (name, extra = {}) => {
        const el = {};
        return { key: name, target: el, currentTarget: el, preventDefault() { prevented += 1; }, stopPropagation() {}, ...extra };
    };
    for (const press of [key('F10', { shiftKey: true }), key('ContextMenu')]) {
        others.menu().props.onClose();
        head = others.again();
        head.props.onKeyDown(press);
        assert.equal(others.menu().props.open, true, press.key);
    }
    // Alt+↑ and Alt+↓ move nothing: it is no category. The keys are still taken, so DSH's list doesn't move either.
    prevented = 0;
    head.props.onKeyDown(key('ArrowUp', { altKey: true }));
    head.props.onKeyDown(key('ArrowDown', { altKey: true }));
    assert.equal(prevented, 2);
    await tick();
    assert.deepEqual(calls, []);
    // From its ⋯, where DSH's menu gives the keyboard back when it closes: the header's keys while the menu is
    // closed, but for Enter and Space (the button's own); none while it is open, as the menu walks its items.
    const more = { closest: (sel) => (sel === '.dshc-sb-more' ? more : null) };
    const fromMore = (name, extra = {}) => ({ key: name, target: more, currentTarget: { contains: () => true }, preventDefault() { prevented += 1; }, stopPropagation() {}, ...extra });
    others.menu().props.onClose();
    head = others.again();
    prevented = 0;
    head.props.onKeyDown(fromMore('Enter'));
    head.props.onKeyDown(fromMore(' '));
    assert.equal(prevented, 0);
    head.props.onKeyDown(fromMore('ArrowDown', { altKey: true }));
    assert.equal(prevented, 1);
    head.props.onKeyDown(fromMore('F10', { shiftKey: true }));
    assert.equal(others.menu().props.open, true);
    head = others.again();
    head.props.onKeyDown(fromMore('ArrowDown'));
    assert.equal(prevented, 2, 'the open menu walks its own items');
    // A key from somewhere else inside the header (not its ⋯) is not the header's.
    head.props.onKeyDown({ key: 'ArrowDown', target: { closest: () => null }, currentTarget: { contains: () => true }, preventDefault() { prevented += 1; } });
    assert.equal(prevented, 2);

    // New workspace… (DSH's own Add workspace) and New category…; no Add a workspace, Move, Rename or Delete.
    menu = others.menu();
    assert.deepEqual(plain(menu.props.items.map((item) => item.label)), ['New workspace…', 'New category…']);
    // New category… makes the first category, in no workspace, and says so.
    menu.props.onSelect('new');
    const made = dialog();
    assert.deepEqual([made.props.title, made.props.action, made.props.description], ['New category', 'Create', 'It starts empty and goes last. Drag workspaces onto it, or add them from its ⋯ menu.']);
    assert.equal(await made.props.onSubmit('Work'), null);
    assert.deepEqual(calls, [['createCategory', { name: 'Work', workspace: '' }]]);
    assert.equal(said(), 'Work created.');
    assert.equal(dialog(), undefined);
    // Once there is one, it heads its (empty) group and Other workspaces still holds both.
    categories = [{ id: 'work', name: 'Work', workspaces: [] }];
    assert.deepEqual(plain(elementsOf(draw()).filter((e) => e.props?.menu?.actions).map((e) => [e.props.group.id, e.props.count])), [['work', 0], [OTHERS, 2]]);
    assert.ok(header('work'));

    // Where DSH has no Add workspace (no folder picker, or another plugin draws the list), only New category….
    const bare = drawSidebar({ items, categories: () => [], adding: null });
    assert.deepEqual(plain(bare.open(OTHERS).menu().props.items.map((item) => item.label)), ['New category…']);
    // Nothing known yet, or DSH's list not drawn: nothing added to it.
    assert.equal(elementsOf(drawSidebar({ items, categories: () => null }).draw()).some((e) => e.props?.menu?.actions || e.type === 'style'), false);
});

test('browser half: a category\'s header folds, moves, and its ⋯ adds, renames and deletes, each said or refused aloud', async () => {
    const items = [
        { workspaceId: 'w-a', title: 'alpha', sessionIds: ['s1', 's2'] },
        { workspaceId: 'w-b', title: 'beta', sessionIds: ['s3'] },
        { workspaceId: 'w-c', title: '', path: '/work/gamma', sessionIds: [] },
    ];
    const storage = new Map([['dsh-plugin-projects/sidebar-folded', '["fleet","shop"]']]);
    const statuses = new Map();
    let answer = () => ({ ok: true, value: {} });
    const side = drawSidebar({
        items, statuses, storage, answer: (method, args) => answer(method, args),
        categories: () => [{ id: 'fleet', name: 'Fleet Services', workspaces: [{ id: 'w-a' }] }, { id: 'shop', name: 'Shop', workspaces: [{ id: 'w-b' }] }],
    });
    const { OTHERS } = side.client.internals;
    const { header, open, said, dialog, calls } = side;
    // Every header, in order, each with its count; none folded (another plugin's folds are its own).
    assert.deepEqual(plain(elementsOf(side.draw()).filter((e) => e.props?.menu?.actions).map((e) => [e.props.group.id, e.props.count, e.props.folded, e.props.index])),
        [['fleet', 1, false, 0], ['shop', 1, false, 1], [OTHERS, 1, false, 2]]);
    const fleet = open('fleet');
    let head = fleet.again();
    assert.deepEqual([head.props.role, head.props.tabIndex, head.props['aria-level'], head.props['aria-expanded'], head.props['aria-label'], head.props['aria-keyshortcuts'], head.props.draggable, head.props.className],
        ['treeitem', 0, 1, true, 'Fleet Services, 1 workspace', 'Alt+ArrowUp Alt+ArrowDown Shift+F10', true, 'dshc-sb-head']);
    assert.deepEqual(plain(header('shop').type(header('shop').props).props.style), { order: 2 });
    // The header's own parts: a hidden node for the hooks, its name, its count, its ⋯.
    const hidden = elementsOf(head).find((e) => e.props?.hidden);
    assert.deepEqual([hidden.props['data-categories-node'], hidden.props['data-categories-id']], ['category', 'fleet']);
    assert.equal(textIn(byClass(head, 'dshc-sb-name')), 'Fleet Services');
    assert.equal(textIn(byClass(head, 'dshc-sb-count')), '1');
    assert.equal(fleet.menu().props.anchor.props['data-categories-menu'], 'fleet');
    assert.equal(fleet.menu().props.anchor.props['aria-label'], 'Category actions: Fleet Services');

    // A click folds it (a click on its ⋯ doesn't); the CSS hides its sections, and the window's storage keeps it.
    const click = (target = { closest: () => null }) => ({ currentTarget: { contains: () => true }, target });
    header('fleet').props.onToggle();
    assert.equal(header('fleet').props.folded, true);
    assert.match(textIn(elementsOf(side.draw()).find((e) => e.type === 'style')), /\[data-categories-ws="w-a"\]\{order:1;display:none!important\}/);
    head = mount(side.react, () => header('fleet').type(header('fleet').props))();
    assert.equal(head.props['aria-expanded'], false);
    head.props.onClick(click({ closest: (selector) => (selector === '.dshc-sb-more' ? {} : null) }));
    assert.equal(header('fleet').props.folded, true);
    head.props.onClick(click());
    assert.equal(header('fleet').props.folded, false);
    // A folded category shows a dot when one of its chats runs, or waits on you, and says so.
    statuses.set('s2', { running: true });
    header('fleet').props.onToggle();
    assert.equal(header('fleet').props.dot, 'ongoing');
    assert.equal(header('fleet').type(header('fleet').props).props['aria-label'], 'Fleet Services, 1 workspace, running');
    statuses.set('s1', { running: true, pendingInteraction: { kind: 'approval' } });
    assert.equal(header('fleet').props.dot, 'warning');
    head = header('fleet').type(header('fleet').props);
    assert.equal(head.props['aria-label'], 'Fleet Services, 1 workspace, a chat is waiting on you');
    assert.equal(elementsOf(byClass(head, 'dshc-sb-dot')).find((e) => e.type === 'StateDot').props.state, 'warning');
    // Open, it shows none: its rows show their own.
    header('fleet').props.onToggle(true);
    assert.deepEqual([header('fleet').props.folded, header('fleet').props.dot], [false, null]);

    // The keys: Enter or Space folds and opens it, → opens, ← folds, ↑ and ↓ go to the next header.
    let prevented = 0;
    const focused = [];
    const heads = ['fleet', 'shop', OTHERS].map((id) => ({ id, focus: () => focused.push(id) }));
    const key = (name, extra = {}) => {
        const el = heads[0];
        el.parentElement = { querySelectorAll: (selector) => (selector === ':scope>[data-categories-sb]' ? heads : []) };
        return { key: name, target: el, currentTarget: el, preventDefault() { prevented += 1; }, stopPropagation() {}, ...extra };
    };
    const pressOn = (id, press) => {
        const el = header(id);
        mount(side.react, () => el.type(el.props))().props.onKeyDown(press);
    };
    pressOn('fleet', key('Enter'));
    assert.equal(header('fleet').props.folded, true);
    pressOn('fleet', key(' '));
    assert.equal(header('fleet').props.folded, false);
    pressOn('fleet', key('ArrowLeft'));
    assert.equal(header('fleet').props.folded, true);
    pressOn('fleet', key('ArrowLeft'));
    assert.equal(header('fleet').props.folded, true);
    pressOn('fleet', key('ArrowRight'));
    assert.equal(header('fleet').props.folded, false);
    pressOn('fleet', key('ArrowDown'));
    pressOn('fleet', key('ArrowUp'));
    assert.deepEqual(focused, ['shop']);
    assert.equal(storage.get('dsh-plugin-categories/sidebar-folded'), undefined, 'the stand-in runs no effects: kept by the window, tested on the page');
    // A key pressed inside the header (its ⋯) is its own.
    prevented = 0;
    pressOn('fleet', { ...key('Enter'), target: {} });
    assert.equal(prevented, 0);

    // Alt+↑ and Alt+↓ move a category, through the plugin's endpoint; the first can't go up.
    pressOn('fleet', key('ArrowDown', { altKey: true }));
    pressOn('shop', key('ArrowUp', { altKey: true }));
    pressOn('fleet', key('ArrowUp', { altKey: true }));
    await tick();
    assert.deepEqual(calls, [['moveCategory', { category: 'fleet', before: '' }], ['moveCategory', { category: 'shop', before: 'fleet' }]]);
    assert.equal(said(), 'Shop moved.');
    calls.length = 0;

    // Its ⋯: Add a workspace (those in no category first, then the others with where they are), New workspace…,
    // Move up and down (as far as they go), Rename…, New category… and Delete….
    let menu = fleet.menu();
    assert.deepEqual(plain(menu.props.items.map((item) => [item.label ?? item.type, item.disabled ?? false])), [
        ['Add a workspace', false], ['New workspace…', false], ['separator', false], ['Move up', true], ['Move down', false],
        ['separator', false], ['Rename…', false], ['New category…', false], ['Delete…', false],
    ]);
    assert.deepEqual(plain(open('shop').menu().props.items.filter((item) => /^Move/.test(item.label ?? '')).map((item) => [item.label, item.disabled])), [['Move up', false], ['Move down', true]]);
    assert.equal(menu.props.items.find((item) => item.label === 'Delete…').danger, true);
    assert.deepEqual(plain(menu.props.items[0].submenu.map((item) => [item.id, item.type ?? '', item.text ?? textIn(item.label)])), [
        ['free', 'label', 'In no category'], ['w:w-c', '', 'gamma'], ['taken', 'label', 'In other categories'], ['w:w-b', '', 'beta · Shop'],
    ]);
    menu.props.onSelect('w:w-c');
    await tick();
    assert.deepEqual(calls, [['fileWorkspace', { workspace: 'w-c', category: 'fleet', before: '' }]]);
    assert.equal(said(), 'gamma moved to Fleet Services.');
    menu.props.onSelect('down');
    open('shop').menu().props.onSelect('up');
    await tick();
    assert.deepEqual(calls.slice(1), [['moveCategory', { category: 'fleet', before: '' }], ['moveCategory', { category: 'shop', before: 'fleet' }]]);
    calls.length = 0;

    // Rename… asks with the name as it is; Delete… asks first, and says where its workspaces go.
    menu.props.onSelect('rename');
    let ask = dialog();
    assert.deepEqual([ask.props.title, ask.props.initial, ask.props.action, ask.props.label], ['Rename category', 'Fleet Services', 'Rename', 'Category name']);
    assert.equal(await ask.props.onSubmit('Fleet'), null);
    assert.deepEqual(calls, [['renameCategory', { category: 'fleet', name: 'Fleet' }]]);
    assert.equal(said(), 'Renamed to Fleet.');
    fleet.menu().props.onSelect('delete');
    ask = dialog();
    assert.deepEqual([ask.props.title, ask.props.text, ask.props.action], ['Delete category', 'This deletes “Fleet Services”. Its workspace moves to Other workspaces. No chats or folders are deleted.', 'Delete category']);
    // A refusal shows in the dialog, which stays.
    answer = () => ({ ok: false, error: { code: 'categories/refused', message: 'no such category' } });
    assert.equal(await ask.props.onSubmit(), 'No such category.');
    assert.ok(dialog());
    answer = () => ({ ok: true, value: {} });
    assert.equal(await ask.props.onSubmit(), null);
    assert.deepEqual(calls.slice(1), [['removeCategory', { category: 'fleet' }], ['removeCategory', { category: 'fleet' }]]);
    assert.equal(said(), 'Fleet Services deleted.');
    assert.equal(dialog(), undefined);
    const { SIDEBAR } = side.client.internals;
    assert.deepEqual([SIDEBAR.deleteText('Empty', 0), SIDEBAR.deleteText('Big', 3)], [
        'This deletes “Empty”. It holds no workspaces. No chats or folders are deleted.',
        'This deletes “Big”. Its 3 workspaces move to Other workspaces. No chats or folders are deleted.',
    ]);
    // New category… from a category's ⋯ makes one in no workspace.
    fleet.menu().props.onSelect('new');
    assert.equal(dialog().props.title, 'New category');

    // A move the plugin refuses shows DSH's toast with the reason; nothing is said.
    answer = () => ({ ok: false, error: { code: 'categories/refused', message: 'that workspace is in another category' } });
    open('shop').menu().props.onSelect('w:w-a');
    await tick();
    const toast = elementsOf(side.draw()).find((e) => e.type === 'Toast');
    // At the top of the window: anchored to the narrow list, it would run off the window's left edge.
    assert.deepEqual([toast.props.text, toast.props.anchor, toast.props.holdMs], ['That workspace is in another category.', undefined, 4000]);
    toast.props.onDone();
    assert.equal(elementsOf(side.draw()).some((e) => e.type === 'Toast'), false);
    // An unreachable plugin says so.
    answer = () => ({ ok: false, error: { code: 'categories/unreachable', message: 'socket closed' } });
    open('shop').menu().props.onSelect('w:w-a');
    await tick();
    assert.equal(elementsOf(side.draw()).find((e) => e.type === 'Toast').props.text, side.client.internals.TEXT.unreachable);

    // A category every workspace is in already has nothing to add.
    const full = drawSidebar({ items: items.slice(0, 1), categories: () => [{ id: 'all', name: 'All', workspaces: [{ id: 'w-a' }] }] });
    assert.deepEqual(plain(full.open('all').menu().props.items[0].submenu), [{ id: 'none', label: 'Every workspace is already here', disabled: true }]);
    // What was folded comes back from the window's own storage.
    const kept = drawSidebar({ items, storage: new Map([['dsh-plugin-categories/sidebar-folded', '["shop"]']]), categories: () => [{ id: 'fleet', name: 'Fleet', workspaces: [] }, { id: 'shop', name: 'Shop', workspaces: [] }] });
    assert.deepEqual([kept.header('fleet').props.folded, kept.header('shop').props.folded], [false, true]);
});

test('browser half: New workspace… in a header\'s ⋯ runs DSH\'s own Add workspace and files the workspace it makes there', async () => {
    const items = [{ workspaceId: 'w-a', title: 'alpha', sessionIds: [] }, { workspaceId: 'w-b', title: 'beta', sessionIds: [] }];
    const adding = { busy: false };
    const side = drawSidebar({ items, categories: () => [{ id: 'fleet', name: 'Fleet', workspaces: [{ id: 'w-a' }] }], adding });
    const { OTHERS } = side.client.internals;
    // A category's menu: New workspace… right under Add a workspace, the rest as before.
    let menu = side.open('fleet').menu();
    assert.deepEqual(plain(menu.props.items.map((item) => item.label ?? item.type)),
        ['Add a workspace', 'New workspace…', 'separator', 'Move up', 'Move down', 'separator', 'Rename…', 'New category…', 'Delete…']);
    assert.equal(menu.props.anchor.props['data-categories-menu'], 'fleet');
    // It starts DSH's flow; the workspace DSH makes is filed last in the category, which opens, and the list says so.
    menu.props.onSelect('newWorkspace');
    assert.deepEqual(side.calls, [['start']]);
    side.flow.made({ workspaceId: 'w-new', title: 'gamma', path: '/work/gamma' });
    await tick();
    assert.deepEqual(side.calls.slice(1), [['fileWorkspace', { workspace: 'w-new', category: 'fleet', before: '' }]]);
    assert.equal(side.said(), 'gamma added to Fleet.');

    // From Other workspaces it stays in no category; the list is read again, which puts DSH's order back in category order.
    side.calls.length = 0;
    side.open(OTHERS).menu().props.onSelect('newWorkspace');
    side.flow.made({ workspaceId: 'w-new2', title: '', path: '/work/delta' });
    await tick();
    assert.deepEqual(side.calls, [['start'], ['list', undefined]]);
    assert.equal(side.said(), 'delta added to Other workspaces.');

    // While DSH's flow runs already, the item is there but greyed.
    adding.busy = true;
    menu = side.open('fleet').menu();
    assert.equal(menu.props.items.find((item) => item.id === 'newWorkspace').disabled, true);
});

test('browser half: DSH\'s own Add workspace, as its session list hands it to its +, and the workspace it makes', () => {
    const { client } = loadClient();
    const { workspaceAdder, dshAddFlow } = client.internals;
    // DSH's stores tell their subscribers at once (zustand underneath).
    const store = (value) => {
        const listeners = new Set();
        return {
            listeners,
            getSnapshot: () => value,
            subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
            set(next) { value = next; for (const fn of [...listeners]) fn(); },
        };
    };
    // ui-workspace's controls: its + asks for the flow (not while it runs), and the flow says while it runs.
    const state = store({ addRequested: false, directoryBusy: false, searchRequest: 0 });
    const request = () => {
        const s = state.getSnapshot();
        state.set(s.directoryBusy ? s : { ...s, addRequested: true });
    };
    const pickers = store(true);
    const face = { requestAddWorkspace: request, closeAddWorkspace: () => {}, hooks: { workspaceShortcuts: state, directoryFlow: pickers } };
    let entries = [{ component: () => null, options: {}, inject: () => face }];
    const slots = { entriesOfSlot: (name) => (name === 'sidebar.workspaces' ? entries : []) };
    const flow = dshAddFlow(slots);
    assert.equal(flow.request, request);
    assert.equal(flow.state, state);
    // No folder picker (DSH hides its + then), another plugin's list, or none at all: no flow.
    pickers.set(false);
    assert.equal(dshAddFlow(slots), undefined);
    pickers.set(true);
    entries = [{ component: () => null, options: {}, inject: () => ({ hooks: {} }) }];
    assert.equal(dshAddFlow(slots), undefined);
    entries = [{ component: () => null, options: {}, inject: () => { throw new Error('needs its scope'); } }];
    assert.equal(dshAddFlow(slots), undefined);
    entries = [];
    assert.equal(dshAddFlow(slots), undefined);
    assert.equal(dshAddFlow(undefined), undefined);
    assert.equal(dshAddFlow({ entriesOfSlot: () => { throw new Error('no such slot'); } }), undefined);
    // An older DSH's slots without entriesOfSlot: its entries.
    assert.equal(dshAddFlow({ entries: () => [{ component: () => null, options: {}, inject: () => face }] })?.request, request);

    // What DSH's list does with a request: closes it, opens its folder dialog (busy) and makes the workspace picked.
    const list = store({ items: [{ workspaceId: 'w1', title: 'one' }] });
    const set = (change) => state.set({ ...state.getSnapshot(), ...change });
    const opens = () => { set({ addRequested: false }); set({ directoryBusy: true }); };
    const gains = (ws) => list.set({ items: [ws, ...list.getSnapshot().items] });
    const picks = (ws) => { gains(ws); set({ directoryBusy: false }); };
    const made = [];
    const adder = workspaceAdder(() => ({ request, state }), () => list);
    const quiet = () => state.listeners.size === 0 && list.listeners.size === 0;
    assert.deepEqual(plain(adder.state()), { busy: false });
    assert.equal(adder.start((ws) => made.push(ws.workspaceId)), true);
    assert.equal(state.getSnapshot().addRequested, true);
    opens();
    picks({ workspaceId: 'w2', title: 'two' });
    assert.deepEqual(made, ['w2']);
    assert.ok(quiet(), 'done waiting');

    // Cancelled, then Choose again after a folder DSH couldn't open: the same run. A workspace made meanwhile some
    // other way (DSH's empty chat's own picker, another window) isn't it.
    assert.equal(adder.start((ws) => made.push(ws.workspaceId)), true);
    opens();
    set({ directoryBusy: false });
    gains({ workspaceId: 'w3', title: 'three' });
    set({ directoryBusy: true });
    // A folder that was a workspace already: DSH's list gains none.
    list.set({ items: [...list.getSnapshot().items] });
    assert.deepEqual(made, ['w2']);
    picks({ workspaceId: 'w4', title: 'four' });
    assert.deepEqual(made, ['w2', 'w4']);

    // Cancelled, then DSH's own + (or its shortcut) starts the flow: that one is DSH's, and nothing is filed.
    assert.equal(adder.start((ws) => made.push(ws.workspaceId)), true);
    opens();
    set({ directoryBusy: false });
    request();
    assert.ok(quiet(), 'DSH\'s own run ends the wait');
    opens();
    picks({ workspaceId: 'w5', title: 'five' });
    assert.deepEqual(made, ['w2', 'w4']);

    // While DSH's flow runs it can't start again; where DSH has none, or doesn't take the request, it doesn't start.
    set({ directoryBusy: true });
    assert.deepEqual(plain(adder.state()), { busy: true });
    assert.equal(adder.start(() => made.push('no')), false);
    set({ directoryBusy: false });
    const none = workspaceAdder(() => undefined, () => list);
    assert.equal(none.state(), null);
    assert.equal(none.start(() => made.push('no')), false);
    const deaf = workspaceAdder(() => ({ request: () => {}, state }), () => list);
    assert.equal(deaf.start(() => made.push('no')), false);
    assert.ok(quiet(), 'nothing left waiting');
    // Stopping (the plugin stops) drops a wait.
    adder.start(() => made.push('no'));
    adder.stop();
    assert.ok(quiet());
    assert.deepEqual(made, ['w2', 'w4']);
});

/** Just enough of the DOM for the drags: attributes, parents and children, boxes, and attribute selectors. */
class FakeElement {
    constructor(attrs = {}, ...children) {
        this.attrs = new Map(Object.entries(attrs));
        this.children = [];
        this.parentElement = null;
        this.box = { top: 0, bottom: 0, left: 0, width: 0, height: 0 };
        this.style = {};
        this.hidden = false;
        for (const child of children) this.append(child);
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() {
        if (!this.parentElement) return;
        this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
        this.parentElement = null;
    }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    removeAttribute(name) { this.attrs.delete(name); }
    hasAttribute(name) { return this.attrs.has(name); }
    matches(selector) {
        return selector.split(',').some((one) => {
            const m = /^\[([\w-]+)(?:(\^?=)"([^"]*)")?\]$/.exec(one.trim());
            if (!m) throw new Error(`the test DOM can't match ${one}`);
            const value = this.getAttribute(m[1]);
            return value !== null && (!m[2] || (m[2] === '=' ? value === m[3] : value.startsWith(m[3])));
        });
    }
    closest(selector) {
        for (let e = this; e; e = e.parentElement) if (e.matches(selector)) return e;
        return null;
    }
    contains(el) {
        for (let e = el; e; e = e.parentElement) if (e === this) return true;
        return false;
    }
    querySelector(selector) {
        for (const one of selector.split(',').map((part) => part.trim())) {
            const m = /^:scope>(\*>)?(.+)$/.exec(one);
            if (!m) throw new Error(`the test DOM can't find ${one}`);
            const pool = m[1] ? this.children.flatMap((child) => child.children) : this.children;
            const found = pool.find((e) => e.matches(m[2]));
            if (found) return found;
        }
        return null;
    }
    querySelectorAll(selector) {
        const out = [];
        const walk = (el) => { for (const child of el.children) { if (child.matches(selector)) out.push(child); walk(child); } };
        walk(this);
        return out;
    }
    getBoundingClientRect() { return this.box; }
}

test('browser half: the plugin marks DSH\'s list for its rules: the list, each section\'s workspace, and how deep a nested one is', () => {
    const { client } = loadClient();
    const { markList, OTHERS } = client.internals;
    const head = (id) => new FakeElement({ 'data-categories-sb': id });
    // A workspace's section: its row's wrapper, its chats' wrapper, and in Workspace Tree a group of its folder's workspaces.
    const section = (ws, ...more) => new FakeElement({}, new FakeElement({}, new FakeElement({ 'data-row-key': `workspace:${ws}` })), new FakeElement({}), ...more);
    const w6 = section('w6');
    const w5 = section('w5', new FakeElement({ role: 'group' }, w6));
    const w3 = section('w3', new FakeElement({ role: 'group' }, w5));
    // DSH's Ungrouped bucket (its row may be the section's child), and anything else DSH draws in the list.
    const strays = new FakeElement({}, new FakeElement({ 'data-row-key': 'workspace:' }));
    const more = new FakeElement({ 'data-row-key': 'overflow:list' });
    const tree = new FakeElement({ role: 'tree' }, head('a'), section('w1'), section('w2'), head('b'), w3, head(OTHERS), section('w4'), strays, more);
    const groups = [
        { id: 'a', name: 'Alpha', category: true, workspaces: ['w1', 'w2'] },
        { id: 'b', name: 'Beta', category: true, workspaces: ['w3'] },
        { id: OTHERS, name: 'Other workspaces', category: false, workspaces: ['w4'] },
    ];
    const marks = () => plain(tree.children.map((el) => el.getAttribute('data-categories-ws')));
    const depths = () => plain([w3, w5, w6].map((el) => el.getAttribute('data-categories-depth')));
    markList(tree, groups);
    assert.equal(tree.getAttribute('data-categories-list'), '');
    assert.deepEqual(marks(), [null, 'w1', 'w2', null, 'w3', null, 'w4', '', null]);
    assert.deepEqual(depths(), [null, '1', '2']);
    // A second pass changes nothing.
    let writes = 0;
    for (const el of [tree, ...tree.querySelectorAll('[data-categories-ws],[data-categories-depth]')]) {
        const set = el.setAttribute.bind(el);
        el.setAttribute = (name, value) => { writes += 1; set(name, value); };
    }
    markList(tree, groups);
    assert.equal(writes, 0);
    // A folder's workspace drawn at the top of the list is no longer nested.
    w5.children[2].remove();
    tree.append(w6);
    markList(tree, groups);
    assert.deepEqual(depths(), [null, '1', null]);
    assert.equal(w6.getAttribute('data-categories-ws'), 'w6');
    // In one list or search (no workspace's section in it): the list isn't marked, so the headers hide.
    const flat = new FakeElement({ role: 'tree' }, head('a'), new FakeElement({}, new FakeElement({ 'data-row-key': 'session:s1' })));
    markList(flat, groups);
    assert.equal(flat.hasAttribute('data-categories-list'), false);
    // Neither without the plugin's headers.
    const bare = new FakeElement({ role: 'tree' }, section('w1'));
    markList(bare, groups);
    assert.equal(bare.hasAttribute('data-categories-list'), false);
    // No categories (or the plugin gone): every mark goes.
    markList(tree, null);
    assert.equal(tree.hasAttribute('data-categories-list'), false);
    assert.deepEqual(marks(), tree.children.map(() => null));
    assert.deepEqual(depths(), [null, null, null]);
});

test('browser half: the chip marks DSH\'s header actions while it is among them, for the CSS that lets it give way first', () => {
    const { client, react } = loadClient();
    const { useChipHost, CSS } = client.internals;
    // DSH's header: the title's nav, then the actions box holding the slot the chip is drawn in.
    const el = (tag, attrs = {}) => ({
        tag, attrs: new Map(Object.entries(attrs)), parentElement: null, previousElementSibling: null,
        hasAttribute(name) { return this.attrs.has(name); }, setAttribute(name, value) { this.attrs.set(name, String(value)); }, removeAttribute(name) { this.attrs.delete(name); },
        matches(selector) { if (selector !== 'nav[aria-label]') throw new Error(`not faked: ${selector}`); return this.tag === 'nav' && this.attrs.has('aria-label'); },
    });
    const nav = el('nav', { 'aria-label': 'Session' });
    const box = el('div');
    const slot = el('div', { 'data-slot': 'conversation.session.header.actions' });
    const chip = el('button');
    const span = el('span');
    box.previousElementSibling = nav;
    slot.parentElement = box;
    chip.parentElement = slot;
    span.parentElement = chip;
    // The hook's refs hold between draws; its first effect runs after every draw, the second's cleanup when the chip goes.
    const refs = [];
    let r = 0;
    let effects = [];
    react.useRef = (current) => { const k = r++; if (!(k in refs)) refs[k] = { current }; return refs[k]; };
    react.useLayoutEffect = (fn, deps) => { effects.push({ fn, deps }); };
    const text = { current: span };
    const draw = () => { r = 0; effects = []; useChipHost(text); effects[0].fn(); };
    draw();
    assert.equal(box.attrs.get('data-categories-chip-host'), '');
    assert.deepEqual(plain(effects[1].deps), []);
    draw();
    assert.equal(box.attrs.get('data-categories-chip-host'), '');
    // No chip (an archived session, a workspace in no category): no mark.
    text.current = null;
    draw();
    assert.equal(box.hasAttribute('data-categories-chip-host'), false);
    // Back, then gone with the session's header.
    text.current = span;
    draw();
    effects[1].fn()();
    assert.equal(box.hasAttribute('data-categories-chip-host'), false);
    // A box that isn't right after the title's nav, or a chip outside a slot, is DSH's to lay out.
    box.previousElementSibling = el('div');
    draw();
    assert.equal(box.hasAttribute('data-categories-chip-host'), false);
    box.previousElementSibling = nav;
    slot.attrs.delete('data-slot');
    draw();
    assert.equal(box.hasAttribute('data-categories-chip-host'), false);
    // The CSS names the mark, after the nav, rather than finding the box by what it holds.
    assert.ok(CSS.includes('@container (width>600px){nav[aria-label]+[data-categories-chip-host]{flex-shrink:1000}}'));
    assert.ok(CSS.includes('@container (width>600px){nav[aria-label]+[data-categories-chip-host]>[data-slot]>:not([data-categories-chip]){flex-shrink:0}}'));
    assert.doesNotMatch(CSS, /:has\(/);
});

test('browser half: a category\'s header and a workspace\'s row drag in DSH\'s list, with DSH\'s line, and the plugin makes the move', () => {
    const listeners = new Map();
    const body = new FakeElement();
    const document = {
        querySelector: () => ({}),
        createElement: () => new FakeElement(),
        body,
        addEventListener: (type, fn, capture) => { assert.equal(capture, true); listeners.set(type, fn); },
        removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    };
    const { client, react } = loadClient({ document, globals: { Element: FakeElement, requestAnimationFrame: (fn) => { fn(); return 1; } } });
    const { useCategoryDrags, OTHERS } = client.internals;
    // DSH's list: each workspace's section (its row, then its chats), a header before each category's.
    const at = (el, top, height) => { el.box = { top, bottom: top + height, left: 10, width: 200, height }; return el; };
    const rowsOf = {};
    const head = (id, top) => at(new FakeElement({ 'data-categories-sb': id }), top, 30);
    const section = (ws, top, chats = [], ...more) => {
        const row = rowsOf[ws] = at(new FakeElement({ 'data-row-key': `workspace:${ws}` }), top, 30);
        const chatRows = chats.map((id, i) => (rowsOf[id] = at(new FakeElement({ 'data-row-key': `session:${id}` }), top + 30 * (i + 1), 30)));
        return at(new FakeElement({}, new FakeElement({}, row), new FakeElement({}, ...chatRows), ...more), top, 30 * (chats.length + 1));
    };
    // Workspace Tree nests a folder's workspaces in a group of their own, inside its section.
    const nested = new FakeElement({ role: 'group' }, section('w5', 210));
    const tree = new FakeElement({ role: 'tree' },
        head('a', 0), section('w1', 30, ['s1']), section('w2', 90),
        head('b', 120), section('w3', 150, [], nested),
        head(OTHERS, 180), section('w4', 210),
        section('', 240, ['stray']));
    const headOf = (id) => tree.children.find((el) => el.getAttribute('data-categories-sb') === id);
    const sectionOf = (ws) => rowsOf[ws].parentElement.parentElement;
    const groups = [
        { id: 'a', name: 'Alpha', category: true, workspaces: ['w1', 'w2'] },
        { id: 'b', name: 'Beta', category: true, workspaces: ['w3'] },
        { id: OTHERS, name: 'Other workspaces', category: false, workspaces: ['w4'] },
    ];
    const dragging = [];
    const filed = [];
    const moved = [];
    const read = {
        current: {
            groups, folded: new Set(), titleOf: (id) => id.toUpperCase(), dragging: (on) => dragging.push(on),
            file: (ws, group, before) => filed.push([ws, group.id, before]), moveCategory: (id, before) => moved.push([id, before]),
        },
    };
    let cleanup;
    react.useEffect = (fn) => { cleanup = fn(); };
    useCategoryDrags(tree, read);
    // DSH's drop line, drawn by the plugin over the list, hidden until a drag shows where.
    assert.equal(body.children.length, 1);
    const line = body.children[0];
    assert.deepEqual([line.className, line.hidden, line.getAttribute('aria-hidden')], ['dshc-sb-drop-line', true, 'true']);
    const fire = (type, target, clientY = 0) => {
        const event = {
            type, target, clientY, stopped: 0, prevented: 0,
            dataTransfer: { data: {}, setData(kind, value) { this.data[kind] = value; } },
            stopPropagation() { this.stopped += 1; }, preventDefault() { this.prevented += 1; },
        };
        listeners.get(type)(event);
        return event;
    };
    const lineAt = () => (line.hidden ? null : [line.style.top, line.style.left, line.style.width]);
    const lit = () => tree.children.filter((el) => el.hasAttribute('data-categories-drop')).map((el) => el.getAttribute('data-categories-sb'));

    // DSH keeps its own drags: a chat's row, a folder's nested workspace, Other workspaces' header, DSH's Ungrouped
    // bucket, and anything outside the list.
    for (const target of [rowsOf.s1, rowsOf.w5, headOf(OTHERS), rowsOf[''], body, { not: 'an element' }]) {
        const start = fire('dragstart', target);
        assert.equal(start.stopped, 0);
        assert.equal(fire('dragover', rowsOf.w3).stopped, 0);
    }
    assert.deepEqual(dragging, []);

    // A workspace's row: claimed before DSH sees it, dimmed, and Other workspaces shown as somewhere to drop it.
    let start = fire('dragstart', rowsOf.w1);
    assert.equal(start.stopped, 1);
    assert.deepEqual([start.dataTransfer.effectAllowed, start.dataTransfer.data['text/plain']], ['move', 'W1']);
    assert.equal(sectionOf('w1').getAttribute('data-categories-dragging'), '');
    assert.deepEqual(dragging, [true]);
    // Onto a category's header: the header is lit, and no line.
    let over = fire('dragover', headOf('b'), 130);
    assert.deepEqual([over.prevented, over.dataTransfer.dropEffect, lit(), lineAt()], [1, 'move', ['b'], null]);
    // A chat's row is no place for it: nothing lit, no line, and the "no" pointer.
    over = fire('dragover', rowsOf.s1, 70);
    assert.deepEqual([over.prevented, lit(), lineAt()], [0, [], null]);
    // Where it already is: taken, but no line.
    assert.deepEqual([fire('dragover', rowsOf.w1, 35).prevented, lineAt()], [1, null]);
    assert.deepEqual([fire('dragover', rowsOf.w2, 95).prevented, lineAt()], [1, null]);
    // Below the next workspace: DSH's line under its section.
    over = fire('dragover', rowsOf.w2, 115);
    assert.deepEqual([over.prevented, lineAt()], [1, ['116px', '10px', '200px']]);
    // Above a workspace of another category: the line over its section; dropped, it is filed there.
    over = fire('dragover', rowsOf.w3, 155);
    assert.deepEqual(lineAt(), ['142px', '10px', '200px']);
    const drop = fire('drop', rowsOf.w3, 155);
    assert.deepEqual([drop.stopped, drop.prevented], [1, 1]);
    assert.deepEqual(filed, [['w1', 'b', 'w3']]);
    assert.deepEqual([dragging, sectionOf('w1').hasAttribute('data-categories-dragging'), lineAt(), lit()], [[true, false], false, null, []]);

    // Onto a header: first in that category; onto its own category's header while first there, nothing.
    fire('dragstart', rowsOf.w4);
    fire('drop', headOf('a'), 10);
    fire('dragstart', rowsOf.w1);
    assert.equal(fire('dragover', headOf('a'), 10).prevented, 1);
    assert.deepEqual(lit(), []);
    fire('drop', headOf('a'), 10);
    assert.deepEqual(filed, [['w1', 'b', 'w3'], ['w4', 'a', 'w1']]);
    // Onto Other workspaces' header: out of its category.
    fire('dragstart', rowsOf.w2);
    fire('drop', headOf(OTHERS), 190);
    assert.deepEqual(filed.at(-1), ['w2', OTHERS, 'w4']);

    // A category's header: above another's, or below all it shows; onto Other workspaces', last of the categories.
    start = fire('dragstart', headOf('a'));
    assert.deepEqual([start.stopped, start.dataTransfer.data['text/plain'], headOf('a').getAttribute('data-categories-dragging'), dragging.at(-1)], [1, 'Alpha', '', false]);
    assert.deepEqual([fire('dragover', headOf('b'), 125).prevented, lineAt()], [1, null], 'just above the next is where it is');
    fire('dragover', headOf('b'), 145);
    assert.deepEqual(lineAt(), ['176px', '10px', '200px']);
    read.current.folded = new Set(['b']);
    fire('dragover', headOf('b'), 145);
    assert.deepEqual(lineAt(), ['146px', '10px', '200px'], 'a folded category ends with its header');
    read.current.folded = new Set();
    fire('dragover', headOf(OTHERS), 185);
    assert.deepEqual(lineAt(), ['172px', '10px', '200px']);
    // Only headers take it.
    assert.deepEqual([fire('dragover', rowsOf.w3, 155).prevented, lineAt()], [0, null]);
    fire('drop', headOf(OTHERS), 185);
    assert.deepEqual(moved, [['a', null]]);
    assert.equal(headOf('a').hasAttribute('data-categories-dragging'), false);
    fire('dragstart', headOf('b'));
    fire('drop', headOf('a'), 5);
    assert.deepEqual(moved, [['a', null], ['b', 'a']]);
    // Dropped on itself, or the drag ended elsewhere: nothing moves, and nothing stays lit or dimmed.
    fire('dragstart', headOf('b'));
    assert.equal(fire('drop', headOf('b'), 125).stopped, 1);
    fire('dragstart', rowsOf.w3);
    fire('dragover', headOf('a'), 10);
    assert.deepEqual(lit(), ['a']);
    assert.equal(fire('dragend', rowsOf.w3).stopped, 1);
    assert.deepEqual([moved.length, filed.length, lit(), sectionOf('w3').hasAttribute('data-categories-dragging'), lineAt()], [2, 3, [], false, null]);
    assert.equal(fire('dragend', rowsOf.w3).stopped, 0, 'a drag the plugin didn\'t claim is DSH\'s');

    // Gone with the list: no listeners, no line.
    cleanup();
    assert.deepEqual([listeners.size, body.children.length], [0, 0]);
});

test('browser half: an empty Other workspaces shows once the browser has started a workspace\'s drag, held at the list\'s lower edge', () => {
    const listeners = new Map();
    const body = new FakeElement();
    const document = {
        querySelector: () => ({}),
        createElement: () => new FakeElement(),
        body,
        addEventListener: (type, fn) => { listeners.set(type, fn); },
        removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    };
    // The browser draws its next frame after it has handled dragstart and started the drag: here, when the test says.
    const frames = [];
    const frame = () => { for (const fn of frames.splice(0)) fn(); };
    const { client, react } = loadClient({ document, globals: { Element: FakeElement, requestAnimationFrame: (fn) => frames.push(fn) } });
    const { useCategoryDrags, CategoryHeader, CSS, OTHERS } = client.internals;
    // Every workspace is in a category, so the list has no Other workspaces until one is dragged.
    const rows = { w1: new FakeElement({ 'data-row-key': 'workspace:w1' }), w2: new FakeElement({ 'data-row-key': 'workspace:w2' }) };
    const section = (ws) => new FakeElement({}, new FakeElement({}, rows[ws]), new FakeElement({}));
    const head = new FakeElement({ 'data-categories-sb': 'a' });
    const tree = new FakeElement({ role: 'tree' }, head, section('w1'), section('w2'));
    const dimmed = (el) => el.hasAttribute('data-categories-dragging');
    const sectionOf = (ws) => rows[ws].parentElement.parentElement;
    const dragging = [];
    const read = {
        current: {
            groups: [{ id: 'a', name: 'Alpha', category: true, workspaces: ['w1', 'w2'] }], folded: new Set(), titleOf: (id) => id,
            dragging: (on) => dragging.push(on), file() {}, moveCategory() {},
        },
    };
    react.useEffect = (fn) => { fn(); };
    useCategoryDrags(tree, read);
    const fire = (type, target) => listeners.get(type)({ type, target, clientY: 0, dataTransfer: { setData() {} }, stopPropagation() {}, preventDefault() {} });

    // Nothing in the list changes while the browser still handles dragstart: Other workspaces added then could scroll
    // the list, or cover the row where the drag was pressed, and the browser would call the drag off.
    fire('dragstart', rows.w2);
    assert.deepEqual([dragging, dimmed(sectionOf('w2'))], [[], false]);
    // Once it has started the drag: the row is dimmed, and Other workspaces shows as somewhere to drop it.
    frame();
    assert.deepEqual([dragging, dimmed(sectionOf('w2'))], [[true], true]);
    fire('dragend', rows.w2);
    assert.deepEqual([dragging, dimmed(sectionOf('w2'))], [[true, false], false]);
    // A drag the browser ends before its first frame shows nothing at all.
    fire('dragstart', rows.w1);
    fire('dragend', rows.w1);
    frame();
    assert.deepEqual([dragging, dimmed(sectionOf('w1'))], [[true, false, false], false]);
    // A category's drag is dimmed the same way, and asks for no Other workspaces.
    fire('dragstart', head);
    frame();
    assert.deepEqual([dragging.at(-1), dimmed(head)], [false, true]);
    fire('dragend', head);

    // The empty Other workspaces goes last in DSH's list, which scrolls: it is held at the list's lower edge, on the
    // sidebar's own fill, so it is in sight wherever the list is scrolled. One that holds workspaces, and a category
    // (even an empty one), sit in their own places.
    const drawn = (group) => CategoryHeader({
        group, index: 1, count: group.workspaces.length, folded: false, dot: null, onToggle() {}, onMove() {},
        menu: { workspaces: [], actions: {}, first: true, last: true },
    }).props;
    const others = drawn({ id: OTHERS, name: 'Other workspaces', category: false, workspaces: [] });
    assert.deepEqual([others.className, others['data-categories-sb'], others['aria-label']], ['dshc-sb-head dshc-sb-pinned', OTHERS, 'Other workspaces, 0 workspaces']);
    assert.equal(drawn({ id: OTHERS, name: 'Other workspaces', category: false, workspaces: ['w1'] }).className, 'dshc-sb-head');
    assert.equal(drawn({ id: 'e', name: 'Empty', category: true, workspaces: [] }).className, 'dshc-sb-head');
    assert.ok(CSS.includes('.dshc-sb-head.dshc-sb-pinned{position:sticky;bottom:0;z-index:1;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base))}'));
    // Lit as somewhere to drop, it keeps that fill under DSH's hover colour, so the rows under it still don't show through.
    assert.match(CSS, /\.dshc-sb-head\.dshc-sb-pinned:is\(:hover,\[data-categories-drop\]\)\{background:linear-gradient\([^)]*\)[^}]*var\(--dsw-specific-sidebar-fill/);
});

test('browser half: every session in a category names its category and workspace at its top, and a click opens the Categories page', () => {
    const warnings = [];
    const { client, react } = loadClient({ console: { ...console, warn: (...parts) => { warnings.push(parts.join(' ')); } } });
    const { CategoryChip, chipLine, categoryHolding, pageOpener, workspaceOfSession, CSS } = client.internals;
    // DSH's sessions: plain chats, a coordinator and its thread as another plugin's projections decorate them, a
    // subagent under a chat, a blank New Session, an archived chat, and parents that loop.
    const state = {
        byId: {
            chat: { id: 'chat', title: 'Tensor modulation sweep status' },
            c1: { id: 'c1', title: '◆ Shop', projectionValues: { projectSession: { role: 'coordinator', project: { name: 'Shop' }, threads: [] } } },
            t1: { id: 't1', title: 'Fix cart', projectionValues: { projectSession: { role: 'thread', coordinator: 'c1', thread: { id: 't1' } } } },
            sub: { id: 'sub', title: 'Look around', parentId: 'chat', origin: 'subagent' },
            fresh: { id: 'fresh', title: '', blank: true }, old: { id: 'old', title: 'Old notes' }, loose: { id: 'loose', title: 'Scratch pad' },
            a: { id: 'a', title: 'A', parentId: 'b' }, b: { id: 'b', title: 'B', parentId: 'a' },
        },
    };
    const workspaces = workspacesOf([
        { workspaceId: 'w-tm', path: '/u/tensor-modulation', title: 'tensor-modulation', sessionIds: ['chat', 'fresh', 'old'] },
        { workspaceId: 'w-shop', path: '/u/shop', title: '', sessionIds: ['c1', 't1'] },
        { workspaceId: 'w-scratch', path: '/u/scratch', title: 'scratch', sessionIds: ['loose'] },
    ], { archivedSessionIds: ['old'] });
    let categories = [
        { id: 'local-model-recipe', name: 'Local Model Recipe', source: 'import', workspaces: [{ id: 'w-tm', path: '/u/tensor-modulation', title: 'tensor-modulation' }] },
        { id: 'shop', name: 'Shop', source: 'page', workspaces: [{ id: 'w-shop', path: '/u/shop', title: 'shop' }] },
    ];
    const plugin = { facts: factsOf(() => categories) };
    const opened = [];
    const dsh = { get: (name) => (name === 'layout' ? { selectPanel: (id) => opened.push(id) } : undefined) };
    const props = (sessionId, ctx = dsh) => ({
        sessionId, plugin, openPage: () => pageOpener(ctx), useSessions: (select) => select(state), useWorkspaces: (select) => select(workspaces),
    });
    const chip = (sessionId, ctx) => CategoryChip(props(sessionId, ctx));
    const button = (tree) => byHook(tree, 'data-categories-chip');
    // A plain chat: the category and the workspace, named for screen readers, and a click opens the Categories page.
    const plainChat = chip('chat');
    assert.deepEqual([plainChat.type, plainChat.props.label, plainChat.props.side], ['Tooltip', 'Local Model Recipe / tensor-modulation · Open Categories', 'bottom']);
    const own = button(plainChat);
    assert.deepEqual([own.type, own.props.type, own.props.className], ['button', 'button', 'dshc-chip']);
    assert.equal(own.props['data-categories-chip'], 'local-model-recipe');
    assert.equal(own.props['aria-label'], 'Category: Local Model Recipe, workspace tensor-modulation');
    assert.equal(textIn(own), 'Local Model Recipe/tensor-modulation');
    assert.equal(byClass(own, 'dshc-chip-sep').length, 1, 'DSH\'s crumb mark between them');
    assert.equal(elementsOf(own).find((e) => e.type === 'IconFolderCloseRegular')?.props.className, 'dshc-chip-glyph');
    own.props.onClick();
    assert.deepEqual(opened, ['dsh-plugin-categories:page'], 'the panel DSH\'s sidebar entry opens');
    // A coordinator and its thread are sessions in their workspace like any other (a workspace without a title shows
    // its folder, as DSH's list does), and a subagent shows its parent's.
    for (const id of ['c1', 't1']) assert.equal(button(chip(id)).props['aria-label'], 'Category: Shop, workspace shop', id);
    assert.equal(button(chip('sub')).props['aria-label'], 'Category: Local Model Recipe, workspace tensor-modulation');
    // Nothing for a blank, archived or unknown session, nor for one whose workspace is in no category.
    for (const id of ['fresh', 'old', 'nowhere', 'loose', 'a', '']) assert.equal(chip(id), null, id);
    assert.deepEqual(plain(chipLine(state, 'sub')), ['sub', 'chat'], 'nearest first');
    assert.deepEqual(plain(chipLine(state, 'a')), ['a', 'b'], 'a loop of parents ends');
    assert.deepEqual(plain(chipLine(state, 'fresh')), []);
    assert.deepEqual([workspaceOfSession(workspaces, 't1'), workspaceOfSession(workspaces, 'sub'), workspaceOfSession(undefined, 'chat')], ['w-shop', undefined, undefined]);
    assert.equal(categoryHolding(null, 'w-tm'), undefined, 'none until the plugin has listed its categories');
    assert.equal(CategoryChip({ sessionId: 'chat', plugin }), null, 'nothing where DSH hands it no sessions or workspaces');

    // Live: it reads the categories as they are now, so a rename or a workspace filed elsewhere shows at the next draw.
    categories = [
        { ...categories[0], name: 'Local Models', workspaces: [] },
        { ...categories[1], workspaces: [...categories[1].workspaces, { id: 'w-scratch', path: '/u/scratch', title: 'scratch' }, { id: 'w-tm', path: '/u/tensor-modulation', title: 'tensor-modulation' }] },
    ];
    assert.equal(button(chip('chat')).props['aria-label'], 'Category: Shop, workspace tensor-modulation');
    assert.equal(button(chip('loose')).props['aria-label'], 'Category: Shop, workspace scratch');
    categories = [{ ...categories[1], name: 'Storefront' }];
    assert.equal(textIn(button(chip('c1'))), 'Storefront/shop');
    // It keeps the categories read while it shows, as the session list and the page do.
    let watching = 0;
    const watched = { ...plugin.facts, watch: () => { watching += 1; return () => { watching -= 1; }; } };
    mount(react, () => CategoryChip({ ...props('chat'), plugin: { facts: watched } }), { effects: true })();
    assert.equal(watching, 1);

    // A DSH that offers plugins no way to its panels: plain text, named for screen readers by text of its own.
    const text = chip('chat', {});
    assert.equal(text.type, 'span');
    assert.equal(text.props['data-categories-chip'], 'shop');
    assert.equal(text.props.onClick, undefined);
    assert.equal(textIn(byClass(text, 'dshc-sr')), 'Category: Storefront, workspace tensor-modulation');
    assert.equal(byClass(text, 'dshc-chip-text')[0].props['aria-hidden'], true);
    assert.equal(pageOpener({ get: () => { throw new Error('no such service'); } }), undefined);
    assert.equal(pageOpener({ get: () => ({}) }), undefined);
    // DSH refusing the panel is a warning, never a throw into DSH's header.
    const refused = pageOpener({ get: () => ({ selectPanel: () => { throw new Error('main panel is not registered'); } }) });
    assert.doesNotThrow(() => refused());
    assert.deepEqual(warnings, ['[categories] could not open the Categories page: main panel is not registered']);
    // An unnamed category goes by its id, as in the session list.
    categories = [{ ...categories[0], name: '' }];
    assert.equal(textIn(button(chip('c1'))), 'shop/shop');

    // One line, ending in "…" when it doesn't fit, and gone where the header is narrow.
    assert.match(CSS, /\.dshc-chip-text\{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;/);
    assert.match(CSS, /@container \(width<=600px\)\{\.dshc-chip\{display:none\}\}/);
});

test('browser half: the projects plugin\'s data changes nothing here: the same page, the same list, only this plugin\'s endpoints', async () => {
    // DSH's sessions as the projects plugin's projections make them: a coordinator and its threads, in two workspaces.
    const value = (v) => ({ values: { projectSession: v } });
    const titles = { c: '◆ Storefront', t1: 'Fix cart', t2: 'Hero images', x: 'A chat' };
    const bare = { byId: Object.fromEntries(Object.entries(titles).map(([id, title]) => [id, { id, title }])) };
    const decorated = {
        byId: Object.fromEntries(Object.entries(titles).map(([id, title]) => [id, { id, title, projectionValues: { projectSession: { role: id === 'c' ? 'coordinator' : 'thread' } } }])),
        projectionsBySession: {
            c: value({ role: 'coordinator', project: { id: 'storefront', name: 'Storefront' }, threads: [{ id: 't1', session: 't1' }, { id: 't2', session: 't2' }] }),
            t1: value({ role: 'thread', coordinator: 'c', thread: { id: 't1' } }),
            t2: value({ role: 'thread', coordinator: 'c', thread: { id: 't2' } }),
        },
    };
    const items = [
        { workspaceId: 'w-sf', title: 'storefront', path: '/home/u/storefront', sessionIds: ['t1', 'c', 'x'] },
        { workspaceId: 'w-assets', title: 'storefront-assets', path: '/home/u/storefront-assets', sessionIds: ['t2'] },
    ];
    const categories = [{ id: 'shop', name: 'Shop', source: 'page', workspaces: [{ id: 'w-sf' }] }];
    const { client, react } = loadClient();
    const { CategoriesPage, PageTree } = client.internals;
    const pageRows = (sessions) => {
        const props = {
            useSessions: (select) => select(sessions), useSessionStatus: (select) => select(new Map()), useWorkspaces: (select) => select(workspacesOf(items)),
            plugin: { facts: factsOf(() => categories), openSession: () => {} },
        };
        const page = mount(react, () => CategoriesPage(props))();
        const tree = mount(react, () => PageTree(elementsOf(page).find((e) => e.type === PageTree).props))();
        return plain(elementsOf(tree).filter((e) => e.props?.role === 'treeitem')
            .map((li) => [li.props['aria-level'], li.props['data-categories-node'], li.props['data-categories-id'], textIn(li.children[0])]));
    };
    const rows = pageRows(decorated);
    assert.deepEqual(rows, pageRows(bare));
    // Each session in the workspace DSH lists it in, in DSH's order, by its DSH title: no ◆ node, no nesting.
    assert.deepEqual(rows, [
        [1, 'category', 'shop', 'ShopCategory · 1 workspace'],
        [2, 'workspace', 'w-sf', 'storefront~/storefront'],
        [3, 'session', 't1', 'Fix cart'], [3, 'session', 'c', '◆ Storefront'], [3, 'session', 'x', 'A chat'],
        [1, 'category', '@others', 'Other workspaces1 workspace'],
        [2, 'workspace', 'w-assets', 'storefront-assets~/storefront-assets'],
        [3, 'session', 't2', 'Hero images'],
    ]);
    // The session list draws the same with or without them.
    const sidebar = (sessions) => {
        const side = drawSidebar({ items, categories: () => categories, sessions });
        const drawn = side.draw();
        return [plain(elementsOf(drawn).filter((e) => e.props?.menu?.actions).map((e) => [e.props.group.id, e.props.count])), textIn(elementsOf(drawn).find((e) => e.type === 'style'))];
    };
    assert.deepEqual(sidebar(decorated), sidebar(bare));
    // And the chip at a session's top: a ◆ coordinator and its threads are sessions in their workspaces.
    const chip = (sessions, id) => plain(client.internals.CategoryChip({
        sessionId: id, plugin: { facts: factsOf(() => categories) }, useSessions: (select) => select(sessions), useWorkspaces: (select) => select(workspacesOf(items)),
    }));
    for (const id of ['c', 't1', 't2', 'x']) assert.deepEqual(chip(decorated, id), chip(bare, id), id);
    assert.equal(textIn(byClass(chip(decorated, 'c'), 'dshc-sr')), 'Category: Shop, workspace storefront');
    assert.equal(chip(decorated, 't2'), null, 'its workspace is in no category');
    // It calls only its own endpoints, over DSH's connection.
    const rpc = [];
    const ctx = {
        effect: (fn) => fn(),
        inject: (_names, fn) => fn(ctx),
        slots: { inject: (_name, fn) => fn(), register: (slot) => { rpc.registered = [...(rpc.registered ?? []), slot]; return () => {}; } },
        connection: { rpc: { call: async (_path, method) => { rpc.push(method); return { ok: true, value: { category: 'x', categories: [] } }; } } },
        uiWorkspace: { openSession() {} },
    };
    client.apply(ctx);
    const { plugin } = rpc.registered[0].inject();
    await plugin.facts.act('createCategory', { name: 'X', workspace: '' });
    await plugin.facts.act('fileWorkspace', { workspace: 'w-sf', category: '', before: '' });
    await tick();
    assert.ok(rpc.length >= 3);
    for (const method of rpc) assert.match(method, /^dsh-plugin-categories\/(list|createCategory|fileWorkspace)$/);
    // Nothing of the projects plugin's is named in the browser half: its projection, its endpoints, its hooks, its styles.
    assert.doesNotMatch(SOURCE, /projectSession|dsh-plugin-projects|data-projects-|dshp-/);
});
