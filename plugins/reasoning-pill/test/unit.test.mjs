// Unit tests of the Reasoning pill's browser half, offline: the file runs the way DSH runs it (one script that hands
// DSH's module loader a factory given `require`), with a stand-in React, DSH parts and page, and its pure logic and
// its wiring are checked. The control itself is tested in real DSH by test/e2e/run.mjs.
//
//   node plugins/reasoning-pill/test/unit.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const clientFile = join(dir, '..', 'lib', 'client.js');
const source = readFileSync(clientFile, 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Run client.js as one script with this `window` (in this realm, so the page stand-ins below are its globals). */
const run = (window) => new Function('window', source)(window);

/** Load client.js as DSH does; `parts` stands in for @deepseek-ai/dsh-client-ui-primitives (null: a require that throws). */
function load(parts = { Menu() {}, IconChevronDownOutlineRegular() {} }) {
    let registered;
    const React = {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {},
        useRef: (v) => ({ current: v }),
        useCallback: (f) => f,
        useSyncExternalStore: (_s, get) => get(),
    };
    run({ __ModuleLoader__: { load: (m) => { registered = m; } } });
    assert.equal(registered.id, 'dsh-plugin-reasoning-pill');
    const require = (name) => {
        if (name === 'react') return React;
        if (name === '@deepseek-ai/dsh-client-ui-primitives') {
            if (parts === null) throw new Error('no such module');
            return parts;
        }
        throw new Error(`unexpected require ${name}`);
    };
    return registered.factory(require);
}

const parts = { Menu() {}, Toast() {}, IconChevronDownOutlineRegular() {}, IconWarningOutlineRegular() {} };
const plugin = load(parts);
const { viewOf, selectionFor, refusalOf, failureText, holdFor, wordsFor, isEffortLabel, isSubagent, hideEffortRows, addsMenu, MARK, CSS, DEFAULT_ID } = plugin.logic;

/** The control's component as DSH gets it from the composer slot, and a stand-in session for it. */
function control() {
    let comp;
    plugin.apply({ effect: () => {}, slots: { inject: (_n, fn) => fn(), register: (_o, c) => { comp = c; return () => {}; } } });
    return comp;
}
const find = (node, pred) => {
    if (!node || typeof node !== 'object') return undefined;
    if (pred(node)) return node;
    for (const child of [...(node.children ?? []), node.props?.anchor].flat()) {
        const hit = find(child, pred);
        if (hit) return hit;
    }
    return undefined;
};
const sessionCtx = (state, select = () => Promise.resolve({ ok: true })) => {
    const directory = { store: { getSnapshot: () => state, subscribe: () => () => {} }, select, load: () => Promise.resolve() };
    return {
        get: (name) => (name === 'modelDirectories'
            ? { directoryFor: () => directory, catalog: { store: { getSnapshot: () => null, subscribe: () => () => {} }, reasoningFor: () => undefined } }
            : name === 'sessions' ? { subagentAddress: () => undefined } : undefined),
    };
};
const levels = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
const snap = (over = {}) => ({
    current: { provider: 'gw', model: 'glm' },
    routable: true,
    groups: [{ id: 'gw', models: [{ id: 'glm', name: 'GLM Flash', reasoning: { efforts: levels } }, { id: 'plain', name: 'Plain', reasoning: { efforts: [] } }] }],
    status: 'ready', pending: null, error: null, ...over,
});

test('the file passes node --check (one plugin\'s syntax error would stop every plugin loading)', () => {
    execFileSync(process.execPath, ['--check', clientFile]);
});

test('loading needs no window parts and never throws without a module loader', () => {
    run({});
    run(undefined);
});

test('a DSH without the primitives part still loads (the fallback menu is used)', () => {
    const p = load(null);
    assert.equal(typeof p.apply, 'function');
});

test('nothing to show until the session has a model', () => {
    assert.equal(viewOf(null), null);
    assert.equal(viewOf({ current: null }), null);
    assert.equal(viewOf({ current: { provider: 'gw' } }), null);
});

test('a model with levels and no default of its own: Default first, then its levels in DSH\'s words', () => {
    const v = viewOf(snap());
    assert.equal(v.state, 'ready');
    assert.equal(v.label, 'Default');
    assert.deepEqual(v.efforts.map((e) => e.name), ['Default', 'Low', 'Medium', 'High']);
    assert.equal(v.selectedId, DEFAULT_ID);
    assert.equal(v.busy, false);
});

test('the session\'s saved level shows by its name', () => {
    const v = viewOf(snap({ current: { provider: 'gw', model: 'glm', reasoningEffort: 'medium' } }));
    assert.equal(v.label, 'Medium');
    assert.equal(v.selectedId, 'medium');
});

test('a model with a default level of its own: no "Default" entry, its default shows by name', () => {
    const s = snap();
    s.groups[0].models[0].reasoning = { efforts: levels, defaultEffort: 'high' };
    const v = viewOf(s);
    assert.deepEqual(v.efforts.map((e) => e.id), ['low', 'medium', 'high']);
    assert.equal(v.label, 'High');
    assert.equal(v.selectedId, 'high');
});

test('a pick on its way shows at once and marks the control busy', () => {
    const v = viewOf(snap({ status: 'selecting', pending: { provider: 'gw', model: 'glm', reasoningEffort: 'low' } }));
    assert.equal(v.label, 'Low');
    assert.equal(v.busy, true);
    assert.match(wordsFor(v).aria, /changing/);
});

test('a model with no levels: "None", with the reason in words', () => {
    const v = viewOf(snap({ current: { provider: 'gw', model: 'plain' } }));
    assert.equal(v.state, 'none');
    assert.equal(v.label, 'None');
    assert.deepEqual(v.efforts, []);
    assert.equal(wordsFor(v).title, 'Plain has no reasoning levels.');
});

test('a model that left the model list keeps its saved level and says why it can\'t change', () => {
    const v = viewOf(snap({ routable: false, retainedEffort: 'High' }));
    assert.equal(v.state, 'unavailable');
    assert.equal(v.label, 'High');
    assert.match(wordsFor(v).title, /isn't in the model list now/);
});

test('levels come from the catalog when the groups have not loaded, and a failing catalog is not fatal', () => {
    const s = snap({ groups: [] });
    const v = viewOf(s, () => ({ efforts: [{ id: 'max', name: 'Max' }] }));
    assert.deepEqual(v.efforts.map((e) => e.id), [DEFAULT_ID, 'max']);
    const w = viewOf(s, () => { throw new Error('boom'); });
    assert.equal(w.state, 'none');
});

test('malformed levels are skipped, and a level without a name shows its id', () => {
    const s = snap();
    s.groups[0].models[0].reasoning = { efforts: [null, { name: 'no id' }, { id: 'xhigh' }, { id: 'low', name: 'Low' }] };
    assert.deepEqual(viewOf(s).efforts.map((e) => e.name), ['Default', 'xhigh', 'Low']);
});

test('the selection sent to DSH keeps the provider and model; Default sends no effort', () => {
    const cur = { provider: 'gw', model: 'glm', reasoningEffort: 'high' };
    assert.deepEqual(selectionFor(cur, 'low'), { provider: 'gw', model: 'glm', reasoningEffort: 'low' });
    const d = selectionFor(cur, DEFAULT_ID);
    assert.deepEqual(d, { provider: 'gw', model: 'glm' });
    assert.ok(!('reasoningEffort' in d));
});

test('a refused pick reads as a failure in plain words with a next step, never DSH\'s raw text', () => {
    // What DSH's session call gives back (dsh-api-gateway folds a call that never reached DSH into gateway/internal).
    const offline = { ok: false, error: { code: 'gateway/internal', message: 'client api: session/selectModel failed: Failed to fetch' } };
    assert.equal(failureText(offline), 'Reasoning not changed: DSH isn\'t reachable. Try again when it reconnects.');
    assert.equal(refusalOf({ ok: false, error: { code: 'gateway/cancelled', message: 'client api: Remote invocation "session/selectModel" was aborted' } }).kind, 'unreachable');
    assert.equal(refusalOf(new TypeError('Failed to fetch')).kind, 'unreachable');
    // DSH's own sentence for a session another DSH holds (the one its model button shows).
    assert.equal(failureText({ ok: false, error: { code: 'session/writer-held', message: 'session "s1" is held by another writer' } }),
        'Reasoning not changed: This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.');
    assert.equal(failureText({ ok: false, error: { code: 'session/model-unavailable', message: 'Select an available model before sending a message.' } }),
        'Reasoning not changed: The model isn\'t available now. Pick a model with the model button, then try again.');
    for (const other of [{ ok: false }, { ok: false, error: { code: 'gateway/internal', message: 'session "s1": EACCES /Users/x/.dsh/sessions' } }, new Error('boom'), 'nope', undefined]) {
        assert.equal(failureText(other), 'Reasoning not changed: DSH didn\'t take the change. Try again.', JSON.stringify(other));
    }
    for (const raw of ['client api', 'EACCES', 'session "s1"', 'gateway/', 'boom']) assert.ok(!failureText(offline).includes(raw) && !failureText({ ok: false, error: { code: 'gateway/internal', message: `${raw} x` } }).includes(raw), raw);
    const v = viewOf(snap());
    const words = wordsFor(v, failureText(offline));
    assert.equal(words.title, 'Reasoning effort: Default. Reasoning not changed: DSH isn\'t reachable. Try again when it reconnects.');
    assert.equal(words.aria, words.title);
});

test('DSH\'s banner holds a refusal long enough to read it, longer for a longer sentence', () => {
    const short = holdFor(failureText({ ok: false, error: { code: 'gateway/cancelled' } }));
    const long = holdFor(failureText({ ok: false, error: { code: 'session/writer-held' } }));
    assert.ok(short >= 5000 && long > short && long <= 12000, `${short} ${long}`);
});

test('the menu is DSH\'s Menu, opening above the control at its right edge; closing it only closes (no focus moved)', async () => {
    const tree = control()({ ctx: sessionCtx(snap()), sessionId: 's1' });
    const menu = find(tree, (n) => n.type === parts.Menu);
    assert.ok(menu, 'DSH\'s Menu part');
    assert.equal(menu.props.side, 'top');
    assert.equal(menu.props.align, 'end');
    assert.equal(menu.props.portal, true);
    assert.equal(menu.props.listClassName, 'rp-menu');
    assert.deepEqual(menu.props.items.map((i) => i.id), [DEFAULT_ID, 'low', 'medium', 'high']);
    const moved = [];
    globalThis.requestAnimationFrame = (f) => { moved.push('frame'); return 1; };
    try {
        menu.props.onClose(); // DSH calls it on an outside press, Escape or a blur into a frame
        assert.deepEqual(moved, [], 'onClose schedules no focus change');
    } finally {
        delete globalThis.requestAnimationFrame;
    }
    const trigger = find(tree, (n) => n.type === 'button' && n.props.className === 'rp-trigger');
    assert.equal(trigger.props['aria-haspopup'], 'menu');
    assert.equal(trigger.props['aria-label'], 'Reasoning effort: Default');
    assert.equal(find(tree, (n) => n.type === parts.Toast), undefined, 'no banner without a refusal');
});

test('a pick goes to DSH as one selection; the same level again sends nothing', async () => {
    const sent = [];
    const comp = control();
    const tree = comp({ ctx: sessionCtx(snap({ current: { provider: 'gw', model: 'glm', reasoningEffort: 'medium' } }), (s) => { sent.push(s); return Promise.resolve({ ok: true }); }), sessionId: 's1' });
    const menu = find(tree, (n) => n.type === parts.Menu);
    globalThis.requestAnimationFrame = () => 1;
    try {
        menu.props.onSelect('medium');
        menu.props.onSelect('high');
        menu.props.onSelect(DEFAULT_ID);
    } finally {
        delete globalThis.requestAnimationFrame;
    }
    assert.deepEqual(sent, [{ provider: 'gw', model: 'glm', reasoningEffort: 'high' }, { provider: 'gw', model: 'glm' }]);
});

test('no control in a subagent\'s chat, where DSH shows no model button; any other session, or no sessions service, has one', () => {
    const ctx = (address) => ({ get: (name) => (name === 'sessions' ? { subagentAddress: (id) => (id === 'sub' ? address : undefined) } : undefined) });
    assert.equal(isSubagent(ctx({ mode: 'continuable' }), 'sub'), true);
    assert.equal(isSubagent(ctx({ mode: 'continuable' }), 'main'), false);
    assert.equal(isSubagent({ get: () => undefined }, 'sub'), false);
    assert.equal(isSubagent({ get: () => { throw new Error('no service'); } }, 'sub'), false);
    assert.equal(isSubagent(undefined, 'sub'), false);
});

test('DSH\'s Effort row is known by its label in both of DSH\'s languages, and nothing else is', () => {
    for (const label of ['Effort', ' effort ', '推理等级', 'Reasoning effort', '推理强度']) assert.ok(isEffortLabel(label), label);
    for (const label of ['Model', '模型', '', null, undefined, 'Effortless']) assert.ok(!isEffortLabel(label), String(label));
});

test('the row hider marks only Effort rows inside a menu, once', () => {
    const row = (label) => {
        const attrs = new Map();
        return { attrs, hasAttribute: (k) => attrs.has(k), setAttribute: (k, v) => attrs.set(k, v), querySelector: () => ({ textContent: label }) };
    };
    const rows = [row('Model'), row('Effort'), row('推理等级')];
    const doc = { querySelectorAll: (sel) => (sel === '[role="menu"] [role="menuitem"]' ? rows : []) };
    hideEffortRows(doc);
    hideEffortRows(doc);
    assert.deepEqual(rows.map((r) => r.attrs.has(MARK)), [false, true, true]);
    assert.equal(MARK, 'data-reasoning-pill-hidden');
});

test('the observer looks only when a menu or a menu row was added, not on other changes (a streaming reply)', () => {
    const el = (role, inner) => ({ nodeType: 1, matches: (sel) => role !== null && sel.includes(`[role="${role}"]`), querySelector: () => inner ?? null });
    const text = { nodeType: 3 };
    assert.equal(addsMenu([{ addedNodes: [el('menu')] }]), true, 'a menu');
    assert.equal(addsMenu([{ addedNodes: [el('menuitem')] }]), true, 'a row added to an open menu');
    assert.equal(addsMenu([{ addedNodes: [el(null, {})] }]), true, 'a portal holding a menu');
    assert.equal(addsMenu([{ addedNodes: [el(null), text] }, { addedNodes: [] }]), false, 'reply text and paragraphs');
    assert.equal(addsMenu([]), false);
});

test('styles follow DESIGN.md: own prefix, DSH tokens, no ground, no hash, nothing on :root/html/body, motion stops', () => {
    const rules = CSS.split('\n').filter((l) => l.includes('{'));
    for (const r of rules) {
        const sel = r.slice(0, r.indexOf('{'));
        if (sel.startsWith('@media')) continue;
        assert.ok(/^(\.rp-|\[data-reasoning-pill-hidden\]|\[data-slot="conversation\.composer\.bar"\]:has\(\.rp-root\)|body\.wp-still \.rp-)/.test(sel.trim()), `selector outside the plugin's own: ${sel}`);
    }
    assert.ok(!/(^|[\s,}]):root|(^|[\s,}])html[\s{.[]|(^|[\s,}])body\{/.test(CSS), 'no rule on :root, html or body');
    assert.ok(!/\[class\*="[A-Za-z0-9]{6}_/.test(CSS) && !/\.[A-Za-z0-9]{6}_[a-z]/.test(CSS), 'no DSH hash in a selector');
    const trigger = rules.find((r) => r.startsWith('.rp-trigger{'));
    assert.match(trigger, /background:transparent/);
    for (const token of ['--dsw-alias-label-secondary', '--dsw-font-xs-13', '--dsw-radius-sm']) assert.ok(trigger.includes(token), token);
    assert.match(CSS, /\.rp-trigger:focus-visible\{outline:2px solid var\(--dsw-focus-ring-color,var\(--dsw-alias-state-business-primary\)\)/);
    assert.match(CSS, /body\.wp-still \.rp-trigger\{transition:none!important\}/);
    assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)\{\.rp-trigger\{transition:none!important\}\}/);
    assert.match(CSS, /:has\(\.rp-root\) \[data-slot="conversation\.input\.model"\] \[class\*="_triggerEffort"\]\{display:none!important\}/, 'DSH\'s caption hides only where the control is');
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(CSS.replace(/rgba?\([^)]*\)/g, '')), 'no colour of its own: DSH\'s tokens only');
});

test('apply registers the styles, the row hider and one composer entry, and undoes them', () => {
    const effects = [];
    const slots = [];
    const ctx = {
        effect: (fn, label) => effects.push({ label, dispose: fn() }),
        slots: {
            inject: (name, fn) => fn(),
            register: (opts, comp) => { slots.push({ opts, comp }); return () => {}; },
        },
    };
    const head = [];
    const body = { observers: 0 };
    const fakeDoc = {
        createElement: () => { const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, remove() { head.splice(head.indexOf(el), 1); } }; return el; },
        head: { appendChild: (el) => head.push(el) },
        body,
        querySelectorAll: () => [],
    };
    const marks = [];
    globalThis.document = fakeDoc;
    globalThis.MutationObserver = class { observe() { body.observers += 1; } disconnect() { body.observers -= 1; } };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    try {
        plugin.apply(ctx);
        assert.deepEqual(effects.map((e) => e.label), ['reasoning-pill: styles', 'reasoning-pill: one reasoning control']);
        assert.equal(head.length, 1);
        assert.equal(head[0].attrs['data-plugin'], 'dsh-plugin-reasoning-pill');
        assert.equal(body.observers, 1);
        assert.equal(slots.length, 1);
        assert.equal(slots[0].opts.name, 'conversation.input.right');
        assert.equal(slots[0].opts.id, 'dsh-plugin-reasoning-pill:control');
        assert.deepEqual(slots[0].opts.inject('s1'), { ctx, sessionId: 's1' });
        for (const e of effects) e.dispose?.();
        assert.equal(head.length, 0, 'style sheet removed');
        assert.equal(body.observers, 0, 'observer stopped');
        void marks;
    } finally {
        delete globalThis.document;
        delete globalThis.MutationObserver;
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;
    }
});

test('a setup step that throws is caught, so the rest of DSH keeps loading', () => {
    const effects = [];
    const ctx = { effect: (fn) => effects.push(fn()), slots: { inject: () => {}, register: () => {} } };
    globalThis.document = { createElement: () => { throw new Error('no DOM'); } };
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.doesNotThrow(() => plugin.apply(ctx));
    } finally {
        console.warn = warn;
        delete globalThis.document;
    }
});

test('the plugin keeps no data and adds no host routes', async () => {
    const host = await import('../lib/index.js');
    assert.equal(host.name, 'reasoning-pill');
    assert.deepEqual(host.inject, []);
    assert.equal(host.apply(), undefined);
});

test('README, manifest and locale agree on the names', () => {
    const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf8'));
    const locale = JSON.parse(readFileSync(join(dir, '..', 'locale', 'en.json'), 'utf8'));
    const readme = readFileSync(join(dir, '..', 'README.md'), 'utf8');
    assert.equal(pkg.name, 'dsh-plugin-reasoning-pill');
    assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'), 'the Menu part is injected');
    assert.equal(locale.meta.title, 'Reasoning pill');
    assert.match(readme, /^# Reasoning pill/);
    assert.match(readFileSync(join(dir, '..', 'cordis.patch.yml'), 'utf8'), /id: reasoning-pill\n\s+name: dsh-plugin-reasoning-pill/);
});

test('no assistant or vendor names in the plugin\'s files or the test bench (house rule)', () => {
    // The words are put together here so this file doesn't match itself. Lower-case DSH identifiers such as the
    // `openai-completions` provider kind are DSH's own names and are not prose.
    const words = new RegExp([['cla', 'ude'], ['anthr', 'opic'], ['chat', 'gpt'], ['co', 'pilot'], ['gem', 'ini']].map((w) => w.join('')).join('|'), 'i');
    const prose = new RegExp(['Open', 'AI'].join(' ?'));
    const repo = join(dir, '..', '..', '..');
    const files = [];
    const walk = (folder) => {
        for (const e of readdirSync(folder, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const p = join(folder, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(m?js|json|md|ya?ml|css|html|sh|txt)$/.test(e.name)) files.push(p);
        }
    };
    walk(join(dir, '..'));
    for (const f of readdirSync(join(repo, 'test', 'e2e'), { withFileTypes: true })) if (f.isFile()) files.push(join(repo, 'test', 'e2e', f.name));
    files.push(join(repo, 'scripts', 'e2e.mjs'));
    const hits = [];
    for (const f of files) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (words.test(line) || prose.test(line)) hits.push(`${relative(repo, f)}:${i + 1}`);
        });
    }
    assert.deepEqual(hits, []);
    assert.ok(files.length >= 9, `scanned ${files.length} files`);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
    try {
        await fn();
        passed += 1;
        console.log(`ok - ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`not ok - ${name}\n    ${String(error.stack).split('\n').slice(0, 4).join('\n    ')}`);
    }
}
console.log(`\n# ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
