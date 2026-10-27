/**
 * Tests for dsh-plugin-categories' host half against a fake DSH host:
 * categories and their workspaces, DSH's workspace order kept in step, the
 * one-time move from the projects plugin's store, the old sidebar's import
 * and its preview. No DSH install needed; the peers
 * (@deepseek-ai/schemastery, @deepseek-ai/dsh-typert-protocol) come from the
 * newest DSH runtime under the repository's .e2e/ (test/peers.mjs).
 *
 * Run:  node --test plugins/categories/test/smoke.mjs   (npm test runs it too)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { dataPath } from '../lib/store.js';
import { clipName, slugify, longestRun } from '../lib/categories.js';
import { planFleetShellImport, planFromProjects } from '../lib/plan.js';

// DSH's own packages (the plugin's peers) come from the newest DSH runtime under .e2e/ when nothing else provides them.
register('./peers.mjs', import.meta.url);
// Never the DSH you use: DSH's data folder is a fresh one for these tests (the old sidebar's file is read from
// <DSH home>/fleet-shell, so without this the tests read your own and their results depend on this computer).
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'categories-home-'));
process.once('exit', () => rmSync(process.env.DSH_HOME, { recursive: true, force: true }));
const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol');
const plugin = await import('../lib/index.js');

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((r) => setTimeout(r, 10));
const mode = (path) => statSync(path).mode & 0o777;
/** The action log, '' before its first line. */
const logOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/**
 * DSH's workspace registry: get, list (DSH's order, a new workspace first)
 * and insertBefore, the call DSH's own workspace drag makes.
 */
function fakeWorkspaces(initial = []) {
    const spaces = new Map();
    const order = [];
    const add = (path, title = path.split('/').pop()) => {
        const id = `ws:${path}`;
        if (!spaces.has(id)) {
            spaces.set(id, { id, path, title });
            order.unshift(id);
        }
        return spaces.get(id);
    };
    // Listed in the order given.
    for (const path of [...initial].reverse()) add(path);
    /** Every insertBefore call, as [id, beforeId]. */
    const moves = [];
    return {
        add,
        moves,
        get: (id) => spaces.get(id),
        list: () => order.map((id) => spaces.get(id)),
        /** DSH's: move a workspace before another, or (no anchor) to the end. */
        async insertBefore(id, beforeId) {
            if (!order.includes(id) || (beforeId !== undefined && !order.includes(beforeId))) throw new Error('workspace order: unknown workspace');
            moves.push([id, beforeId]);
            order.splice(order.indexOf(id), 1);
            order.splice(beforeId === undefined ? order.length : order.indexOf(beforeId), 0, id);
            return [...order];
        },
    };
}

/** A fake Host with DSH's workspace registry and, with `gateway`, the window's gateway. */
function fakeHost({ workspaces = [], gateway = true, registry = fakeWorkspaces(workspaces) } = {}) {
    const services = gateway ? { typertGateway: {} } : {};
    const provided = new Map();
    const host = {
        provided,
        workspaceRegistry: registry,
        logger: { info() {}, warn() {} },
        provide(name, value) { provided.set(name, value); },
        inject(names, fn) {
            if (!names.every((name) => services[name])) return;
            fn(Object.assign(Object.create(host), Object.fromEntries(names.map((name) => [name, services[name]]))));
        },
        on() {},
        /** The plugin's disposers, run by switchOff as DSH does when the plugin is switched off or reloaded. */
        effects: [],
        effect(fn) { host.effects.push(fn()); },
    };
    return host;
}

/** Switch the plugin off, as DSH does (`disabled: true`, or a config reload): its disposers run. */
function switchOff(host) {
    for (const dispose of host.effects.splice(0)) dispose?.();
}

function setup(overrides = {}, dir = mkdtempSync(join(tmpdir(), 'categories-')), hostOptions = {}) {
    const host = fakeHost(hostOptions);
    const raw = {
        storeFile: join(dir, 'categories', 'categories.json'),
        logFile: join(dir, 'categories', 'categories.log'),
        projectsStoreFile: join(dir, 'projects', 'projects.json'),
        ...overrides,
    };
    plugin.apply(host, plugin.Config(raw));
    return { host, raw, dir, remote: host.provided.get('dshPluginCategoriesRemote') };
}

/** The same plugin started again (switched off and on, or DSH restarted), on the same workspaces. */
async function restart(host, raw) {
    switchOff(host);
    const again = fakeHost({ registry: host.workspaceRegistry });
    plugin.apply(again, plugin.Config(raw));
    await tick();
    return again.provided.get('dshPluginCategoriesRemote');
}

/** Run with DSH's data folder at `home`, as a DSH started with DSH_HOME does. */
async function withDshHome(home, run) {
    const was = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
        return await run();
    } finally {
        if (was === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = was;
    }
}

const refused = async (promise, pattern) => {
    await assert.rejects(promise, (error) => error.code === 'categories/refused' && pattern.test(error.message));
};
const tree = (list) => plain(list.categories).map((c) => [c.id, c.name, c.workspaces.map((w) => w.id.slice(9))]);

test('categories: the window\'s endpoints, as DSH\'s gateway finds them', async () => {
    const { remote } = setup();
    assert.equal(remote.typertRemote.namespace, 'dsh-plugin-categories');
    assert.equal(remote.typertRemote.serviceKey, 'dshPluginCategoriesRemote');
    assert.deepEqual(remoteMethods(remote).map((m) => m.method), ['list', 'createCategory', 'renameCategory', 'removeCategory', 'moveCategory', 'fileWorkspace']);
    assert.deepEqual(plain(await remote.list()), { categories: [], problems: [], store: null });
    // Off in its settings: the list says so (the window draws DSH's list as it is, and the page says why), a change is
    // refused in words, and nothing is written.
    const dir = mkdtempSync(join(tmpdir(), 'categories-'));
    const off = setup({ enabled: false }, dir);
    assert.deepEqual(plain(await off.remote.list()), { categories: [], off: true, problems: [], store: null });
    await assert.rejects(off.remote.createCategory('Lab'), (error) => error.code === 'categories/off'
        && error.message === 'Categories are switched off in the plugin\'s settings: set enabled: true in its row of the profile\'s cordis.patch.yml to switch them on.');
    await assert.rejects(off.remote.fileWorkspace('ws:/work/a', 'lab'), (error) => error.code === 'categories/off');
    await tick();
    assert.equal(existsSync(join(dir, 'categories')), false);
});

test('settings: a wrong type never stops the plugin; it counts as its default, the log warns, and the list names it', async () => {
    const { checkConfig } = await import('../lib/config.js');
    const { DEFAULTS } = plugin;
    assert.deepEqual({ ...DEFAULTS }, { enabled: true, storeFile: '~/.dsh/categories/categories.json', logFile: '~/.dsh/categories/categories.log', projectsStoreFile: '~/.dsh/projects/projects.json' });
    // Each wrong value in words: the key, what it must be, what it was, and what it counts as meanwhile. A word or a
    // number that plainly means off counts as off (YAML 1.2 reads an unquoted `no` as the text "no"); anything else as on.
    const { config, problems } = checkConfig({ enabled: 'no', storeFile: 12, logFile: '', projectsStoreFile: ['x'] }, DEFAULTS);
    assert.deepEqual(config, { ...DEFAULTS, enabled: false, logFile: '' });
    assert.deepEqual(problems.map((p) => p.key), ['enabled', 'storeFile', 'projectsStoreFile']);
    assert.equal(problems[0].text, 'enabled must be true or false, but it is "no"; it counts as false until you change it');
    for (const [value, counts] of [['Off', false], [' FALSE ', false], [0, false], ['0', false], ['yes', true], ['on', true], [1, true], ['maybe', true], [{}, true], [[], true]]) {
        const checked = checkConfig({ enabled: value }, DEFAULTS);
        assert.equal(checked.config.enabled, counts, `enabled: ${JSON.stringify(value)} counts as ${counts}`);
        assert.match(checked.problems[0]?.text ?? '', new RegExp(`; it counts as ${counts} until you change it$`));
    }
    assert.equal(problems[1].text, 'storeFile must be a file path, but it is 12; ~/.dsh/categories/categories.json is used until you change it');
    assert.equal(problems[2].text, 'projectsStoreFile must be a file path, or empty to skip the move from the projects plugin, but it is ["x"]; ~/.dsh/projects/projects.json is used until you change it');
    assert.equal(checkConfig({ storeFile: '  ' }, DEFAULTS).problems[0]?.text, 'storeFile must be a file path, but it is "  "; ~/.dsh/categories/categories.json is used until you change it');
    assert.deepEqual(checkConfig(undefined, DEFAULTS), { config: { ...DEFAULTS }, problems: [] });
    // In a running plugin: it starts and works, its log warns once per setting (DSH's logger and its own file), and the
    // window's list names them.
    const dir = mkdtempSync(join(tmpdir(), 'categories-'));
    const warnings = [];
    const host = fakeHost();
    host.logger = { info() {}, warn: (...parts) => { warnings.push(parts.slice(1).join(' ')); } };
    plugin.apply(host, plugin.Config({ enabled: 'yes', storeFile: join(dir, 'categories', 'categories.json'), logFile: join(dir, 'categories', 'categories.log'), projectsStoreFile: '' }));
    const remote = host.provided.get('dshPluginCategoriesRemote');
    await tick();
    assert.deepEqual(warnings, ['categories: a setting is wrong: enabled must be true or false, but it is "yes"; it counts as true until you change it']);
    const logged = readFileSync(join(dir, 'categories', 'categories.log'), 'utf8').split('\n').filter((l) => / warn /.test(l));
    assert.equal(logged.length, 1, 'DSH 0.2 writes no plugin\'s log lines out, so the warning is in the plugin\'s own log too');
    assert.match(logged[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z warn a setting is wrong: enabled must be true or false, but it is "yes"; it counts as true until you change it$/);
    assert.equal(statSync(join(dir, 'categories', 'categories.log')).mode & 0o777, 0o600);
    const list = plain(await remote.list());
    assert.deepEqual(list.problems, [{ key: 'enabled', text: 'enabled must be true or false, but it is "yes"; it counts as true until you change it' }]);
    assert.equal((await remote.createCategory('Lab')).category, 'lab');
    // "no" counts as off: the list says off and names the setting, a change is refused, and the log warns once (the one
    // line it writes; enabled: false writes nothing at all, above).
    const dirNo = mkdtempSync(join(tmpdir(), 'categories-'));
    const hostNo = fakeHost();
    plugin.apply(hostNo, plugin.Config({ enabled: 'no', storeFile: join(dirNo, 'categories', 'categories.json'), logFile: join(dirNo, 'categories', 'categories.log'), projectsStoreFile: '' }));
    const remoteNo = hostNo.provided.get('dshPluginCategoriesRemote');
    await tick();
    assert.deepEqual(plain(await remoteNo.list()), { categories: [], off: true, problems: [{ key: 'enabled', text: 'enabled must be true or false, but it is "no"; it counts as false until you change it' }], store: null });
    await assert.rejects(remoteNo.createCategory('Lab'), (error) => error.code === 'categories/off');
    const linesNo = readFileSync(join(dirNo, 'categories', 'categories.log'), 'utf8').split('\n').filter(Boolean);
    assert.equal(linesNo.length, 1);
    assert.match(linesNo[0], / warn a setting is wrong: enabled must be true or false, but it is "no"; it counts as false until you change it$/);
    assert.equal(existsSync(join(dirNo, 'categories', 'categories.json')), false, 'and no store is written');
});

test('endpoints: a failure that is not a refusal is answered in words and logged, never thrown as it came', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'categories-'));
    const { remote, host } = setup({}, dir);
    const warn = remote.warn;
    const warnings = [];
    remote.warn = (text) => { warnings.push(text); warn(text); };
    await tick();
    host.workspaceRegistry.insertBefore = async () => { throw new Error('the registry is closed'); };
    host.workspaceRegistry.add('/work/z');
    await remote.createCategory('Z');
    const failed = await remote.fileWorkspace('ws:/work/z', 'z').then(() => null, (error) => error);
    // The store took it (DSH's order is kept in step later), or the call says why in words: never a bare throw.
    if (failed) {
        assert.equal(failed.code, 'categories/failed');
        assert.match(failed.message, /^Categories could not do that: /);
        assert.ok(warnings.some((w) => w.startsWith('categories: a call failed: ')));
    }
    remote.manager.listCategories = () => { throw new Error('broken store'); };
    const listed = await remote.list().then(() => null, (error) => error);
    assert.equal(listed?.code, 'categories/failed');
    assert.equal(listed?.message, 'Categories could not do that: broken store');
    assert.deepEqual(warnings.at(-1), 'categories: a call failed: broken store');
    assert.match(readFileSync(join(dir, 'categories', 'categories.log'), 'utf8'), /Z warn a call failed: broken store\n$/, 'and its own log says so');
});

test('store: a file that can\'t be used never stops the plugin; the log says so, no one-time move runs over it, and it is kept before a change writes a new one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    await withDshHome(home, async () => {
        // The old sidebar's file is there: its import never runs over a store that was there.
        mkdirSync(join(home, 'fleet-shell'));
        writeFileSync(join(home, 'fleet-shell', 'state.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'Old' }], projectOf: { 'ws:/work/a': 'p1' } }));
        const dir = mkdtempSync(join(tmpdir(), 'categories-'));
        const storeFile = join(dir, 'categories', 'categories.json');
        const logFile = join(dir, 'categories', 'categories.log');
        mkdirSync(join(dir, 'categories'));
        const broken = '{"version": 1, "categories": {"shop": {"name": "Sh';
        writeFileSync(storeFile, broken);
        const warnings = [];
        const host = fakeHost({ workspaces: ['/work/a'] });
        host.logger = { info() {}, warn: (...parts) => { warnings.push(parts.slice(1).join(' ')); } };
        const raw = { storeFile, logFile, projectsStoreFile: '' };
        plugin.apply(host, plugin.Config(raw));
        const remote = host.provided.get('dshPluginCategoriesRemote');
        await tick();
        const said = `the store ${storeFile} is not JSON: the categories start empty, and the file as it was is kept beside it before a change writes a new one`;
        assert.deepEqual(warnings, [`categories: ${said}`]);
        assert.match(logOf(logFile), new RegExp(`Z warn ${said.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\n$`), 'in its own log too');
        assert.deepEqual(plain(await remote.list()).categories, [], 'it starts with none, and no import ran');
        assert.equal(readFileSync(storeFile, 'utf8'), broken, 'nothing is written over it yet');
        // The first change keeps the file as it was beside the store, then writes the new one.
        assert.equal((await remote.createCategory('Lab')).category, 'lab');
        const kept = readdirSync(join(dir, 'categories')).filter((name) => name.startsWith('categories.json.unreadable-'));
        assert.equal(kept.length, 1);
        assert.equal(readFileSync(join(dir, 'categories', kept[0]), 'utf8'), broken);
        assert.equal(mode(join(dir, 'categories', kept[0])), 0o600);
        assert.equal(warnings.at(-1), `categories: the store that couldn't be used is kept in ${join(dir, 'categories', kept[0])}`);
        const stored = JSON.parse(readFileSync(storeFile, 'utf8'));
        assert.equal(stored.categories.lab.name, 'Lab');
        assert.ok(stored.imports.unusable?.at, 'and it says the moves are past');
        // Started again: the new store reads, nothing is copied again, and the old sidebar still isn't imported.
        const again = await restart(host, raw);
        assert.deepEqual(tree(await again.list()), [['lab', 'Lab', []]]);
        assert.equal(readdirSync(join(dir, 'categories')).filter((name) => name.includes('.unreadable-')).length, 1);
        assert.doesNotMatch(logOf(logFile), /import fleet-shell/);
        // Another version is no store of this plugin's either: said, kept, and left as it is until a change.
        writeFileSync(storeFile, JSON.stringify({ version: 2, categories: {} }));
        const third = await restart(host, raw);
        assert.match(logOf(logFile), /warn the store .* is not a categories store of version 1 \(its version is 2\): the categories start empty/);
        assert.deepEqual(plain(await third.list()).categories, []);
    });
});

test('store: a change that can\'t be saved is undone and refused in words, the list says why, and the next change saves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'categories-'));
    const { remote, raw, host } = setup({}, dir, { workspaces: ['/work/a', '/work/b'] });
    await tick();
    await remote.createCategory('Lab', 'ws:/work/a');
    await remote.createCategory('Shop');
    const saved = readFileSync(raw.storeFile, 'utf8');
    const listed = plain(await remote.list());
    const orderBefore = host.workspaceRegistry.list().map((ws) => ws.id);
    // The atomic write's temporary file can't be made (a folder in its place): every kind of change is undone, refused
    // with the reason in words, and nothing reaches the file or DSH's order.
    mkdirSync(`${raw.storeFile}.tmp`, { recursive: true });
    const notSaved = /^not saved: .*categories\.json can't be written \(a folder is in the way\), so nothing changed\. Try again once it can be$/;
    await refused(remote.createCategory('Ops', 'ws:/work/b'), notSaved);
    await refused(remote.renameCategory('lab', 'Research'), notSaved);
    await refused(remote.removeCategory('lab'), notSaved);
    await refused(remote.moveCategory('shop', 'lab'), notSaved);
    await refused(remote.fileWorkspace('ws:/work/b', 'shop'), notSaved);
    await refused(remote.fileWorkspace('ws:/work/a', ''), notSaved);
    const now = plain(await remote.list());
    assert.deepEqual(now.categories, listed.categories, 'each change is undone: the list is as it was');
    assert.equal(readFileSync(raw.storeFile, 'utf8'), saved, 'and so is the file');
    assert.deepEqual(host.workspaceRegistry.list().map((ws) => ws.id), orderBefore, 'and DSH\'s order');
    assert.equal(now.store.problem, 'unsaved');
    assert.match(now.store.text, /^The categories can't be saved in .*categories\.json \(a folder is in the way\), so a change made now is undone\. Each change tries again\.$/);
    const lines = logOf(raw.logFile).split('\n').filter((line) => line.includes(' warn could not save '));
    assert.equal(lines.length, 6, 'each failed save is logged once');
    assert.match(lines[0], /warn could not save the categories in .*categories\.json \(EISDIR\): the change is undone, and the next change tries again$/);
    assert.doesNotMatch(logOf(raw.logFile), /category-new ops|category-rename|category-delete|category-move|workspace ws:\/work\/b/, 'nothing undone is logged as done');
    // Once the file can be written, the next change saves, and the list's note goes.
    rmSync(`${raw.storeFile}.tmp`, { recursive: true });
    const renamed = plain(await remote.renameCategory('lab', 'Research'));
    assert.equal(renamed.store, null, 'a change\'s answer says the store is well again');
    assert.equal(JSON.parse(readFileSync(raw.storeFile, 'utf8')).categories.lab.name, 'Research');
    assert.equal(plain(await remote.list()).store, null);
    // Restarted, it has what was saved: nothing undone comes back.
    const again = await restart(host, raw);
    assert.deepEqual(tree(await again.list()), [['lab', 'Research', ['a']], ['shop', 'Shop', []]]);
});

test('store: the list names a file that couldn\'t be used, and where the first change kept it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'categories-'));
    const storeFile = join(dir, 'categories', 'categories.json');
    mkdirSync(join(dir, 'categories'));
    writeFileSync(storeFile, '{"version": 1, "categories": {');
    const { remote } = setup({ storeFile }, dir);
    await tick();
    const first = plain(await remote.list()).store;
    assert.equal(first.problem, 'unusable');
    assert.match(first.text, /^.*categories\.json is not JSON, so the categories started empty\. The file is left as it is: the first change keeps it beside the new store, to put back by hand\.$/);
    const made = plain(await remote.createCategory('Lab'));
    assert.equal(made.store.problem, 'kept');
    assert.match(made.store.text, /^.*categories\.json is not JSON at the start, so the categories started empty\. It is kept as categories\.json\.unreadable-[\dTZ-]+ in the same folder: put it back by hand, with DSH stopped, to bring them back\.$/);
    assert.ok(existsSync(join(dir, 'categories', /kept as (\S+) in/.exec(made.store.text)[1])), 'the file it names is there');
});

test('names: no two categories share a name, in any case; a category may change its own name\'s case', async () => {
    const { remote } = setup();
    await tick();
    await remote.createCategory('Alpha');
    await refused(remote.createCategory('alpha'), /^there is a category named Alpha already$/);
    await refused(remote.createCategory('  ALPHA  '), /^there is a category named Alpha already$/);
    await remote.createCategory('Beta');
    await refused(remote.renameCategory('beta', 'alpha'), /^there is a category named Alpha already$/);
    await remote.renameCategory('alpha', 'ALPHA');
    assert.deepEqual(tree(await remote.list()).map(([, name]) => name), ['ALPHA', 'Beta']);
    // Names in other scripts compare as they read too.
    await remote.createCategory('Café');
    await refused(remote.createCategory('CAFÉ'), /^there is a category named Café already$/);
    await refused(remote.createCategory('Cafe\u0301'), /^there is a category named Café already$/);
});

test('categories: named sets of workspaces in their order, kept in step with DSH\'s own workspace order', async () => {
    const { host, raw, remote } = setup({}, undefined, { workspaces: ['/work/dsh', '/work/a', '/work/b', '/work/c', '/work/d'] });
    await tick();
    const registry = host.workspaceRegistry;
    const dshOrder = () => registry.list().map((ws) => ws.id.slice(9));
    assert.deepEqual(dshOrder(), ['dsh', 'a', 'b', 'c', 'd']);

    let list = await remote.createCategory('  Fleet Services ', 'ws:/work/c');
    assert.equal(list.category, 'fleet-services');
    assert.deepEqual(tree(list), [['fleet-services', 'Fleet Services', ['c']]]);
    // Each workspace as DSH has it.
    assert.deepEqual(plain(list.categories[0].workspaces), [{ id: 'ws:/work/c', path: '/work/c', title: 'c' }]);
    assert.equal(list.categories[0].source, 'page');
    // DSH's order follows: each category's workspaces together, in the categories' order, then the rest.
    assert.deepEqual(dshOrder(), ['c', 'dsh', 'a', 'b', 'd']);
    list = await remote.createCategory('Lab');
    assert.deepEqual(tree(list), [['fleet-services', 'Fleet Services', ['c']], ['lab', 'Lab', []]]);
    await remote.fileWorkspace('ws:/work/a', 'lab');
    list = await remote.fileWorkspace('ws:/work/b', 'lab', 'ws:/work/a');
    assert.deepEqual(tree(list), [['fleet-services', 'Fleet Services', ['c']], ['lab', 'Lab', ['b', 'a']]]);
    assert.deepEqual(dshOrder(), ['c', 'b', 'a', 'dsh', 'd']);
    // Filed with no anchor, a workspace goes last in its category; moving to another one takes it out of the first.
    list = await remote.fileWorkspace('ws:/work/b', 'lab', '');
    assert.deepEqual(tree(list)[1][2], ['a', 'b']);
    list = await remote.fileWorkspace('ws:/work/b', 'fleet-services', 'ws:/work/c');
    assert.deepEqual(tree(list), [['fleet-services', 'Fleet Services', ['b', 'c']], ['lab', 'Lab', ['a']]]);
    assert.deepEqual(dshOrder(), ['b', 'c', 'a', 'dsh', 'd']);

    // Categories move; DSH's order moves with them, as few workspaces as it takes.
    const before = registry.moves.length;
    list = await remote.moveCategory('lab', 'fleet-services');
    assert.deepEqual(tree(list).map(([id]) => id), ['lab', 'fleet-services']);
    assert.deepEqual(dshOrder(), ['a', 'b', 'c', 'dsh', 'd']);
    assert.equal(registry.moves.length - before, 1);
    list = await remote.moveCategory('lab', '');
    assert.deepEqual(tree(list).map(([id]) => id), ['fleet-services', 'lab']);

    // Rename; refusals.
    list = await remote.renameCategory('lab', 'Labs');
    assert.equal(tree(list)[1][1], 'Labs');
    await refused(remote.renameCategory('nope', 'X'), /"nope" is not a category here/);
    await refused(remote.renameCategory('lab', ' \n '), /a category needs a name/);
    await refused(remote.createCategory('   '), /a category needs a name/);
    await refused(remote.createCategory('Other', 'ws:/nope'), /DSH has no such workspace/);
    await refused(remote.fileWorkspace('ws:/nope', 'lab'), /DSH has no such workspace/);
    await refused(remote.fileWorkspace('', 'lab'), /workspace is required/);
    await refused(remote.fileWorkspace('ws:/work/a', 'nope'), /"nope" is not a category here/);
    await refused(remote.fileWorkspace('ws:/work/d', 'lab', 'ws:/work/b'), /that workspace is in another category/);
    await refused(remote.moveCategory('lab', 'nope'), /"nope" is not a category here/);
    await refused(remote.removeCategory('nope'), /"nope" is not a category here/);
    // Ids stay as made, and are unique; a long name is cut once, at a word.
    assert.equal((await remote.createCategory('Lab')).category, 'lab-2');
    await remote.removeCategory('lab-2');
    const long = await remote.createCategory(`${'Quarterly planning '.repeat(6)}notes`);
    const made = long.categories.find((c) => c.id === long.category);
    assert.ok(Buffer.byteLength(made.name) <= 80 && made.name.endsWith('planning…'), made.name);
    await remote.removeCategory(long.category);

    // Out of a category: last among the workspaces in none.
    list = await remote.fileWorkspace('ws:/work/b', '');
    assert.deepEqual(tree(list), [['fleet-services', 'Fleet Services', ['c']], ['lab', 'Labs', ['a']]]);
    assert.deepEqual(dshOrder(), ['c', 'a', 'dsh', 'd', 'b']);

    // Deleting a category leaves its workspaces where they are, in none.
    list = await remote.removeCategory('lab');
    assert.deepEqual(tree(list), [['fleet-services', 'Fleet Services', ['c']]]);
    assert.deepEqual(dshOrder(), ['c', 'a', 'dsh', 'd', 'b']);

    // A workspace DSH adds later (DSH lists it first) goes after the categories when the window lists, among the others in none.
    registry.add('/work/new');
    assert.equal(dshOrder()[0], 'new');
    await remote.list();
    await tick();
    assert.deepEqual(dshOrder(), ['c', 'new', 'a', 'dsh', 'd', 'b']);

    // After a restart: the same categories; DSH's order needs no moves.
    const moves = registry.moves.length;
    assert.deepEqual(tree(await (await restart(host, raw)).list()), [['fleet-services', 'Fleet Services', ['c']]]);
    assert.equal(registry.moves.length, moves);
    const saved = JSON.parse(readFileSync(raw.storeFile, 'utf8'));
    assert.deepEqual([saved.version, Object.keys(saved.categories), saved.categoryOf], [1, ['fleet-services'], { 'ws:/work/c': 'fleet-services' }]);
    // Private: the store and log are mode 600, their folder 700; the log holds ids and counts.
    assert.deepEqual([mode(raw.storeFile), mode(raw.logFile), mode(join(raw.storeFile, '..'))], [0o600, 0o600, 0o700]);
    const log = readFileSync(raw.logFile, 'utf8');
    for (const line of ['category-new fleet-services page', 'workspace ws:/work/c category=fleet-services', 'category-move lab before=fleet-services', 'category-rename lab', 'category-delete lab', 'workspace ws:/work/b category=none']) {
        assert.ok(log.includes(line), line);
    }
    assert.doesNotMatch(log, /Labs|Fleet Services/);
});

/**
 * The projects plugin's store as on the user's DSH after its duplicate categories were deleted and the
 * list rearranged: four categories in their places, one of them (General) with the same id as a ◆ project,
 * a placement of a workspace DSH no longer has (clef-quant), two ◆ projects whose groups from before
 * categories are still recorded for an older version, and the records of the old sidebar's import and of
 * the groups' move to categories.
 */
function projectsStoreWithCategories() {
    return {
        version: 1,
        projects: {
            'dsh-plugins': { settings: { goal: 'Ship it' }, threads: { t1: { sessionId: 's-t1', title: 'Fix CI' } }, pendingHandbacks: [], nextThread: 2, coordinatorSessionId: 's-dsh', home: 'ws:/work/dsh' },
            'testing-out-coordinator': { name: 'Testing out Coordinator', source: 'page', order: 0, coordinatorSessionId: 's-test', home: 'ws:/work/alice', threads: { t1: { sessionId: 's-n1' }, t2: { sessionId: 's-n2' } } },
        },
        workspaceOf: { 'ws:/work/dsh': 'dsh-plugins', 'ws:/work/d2': 'dsh-plugins', 'ws:/work/alice': 'testing-out-coordinator', 'ws:/work/c': 'testing-out-coordinator' },
        categories: {
            'local-model-recipe': { name: 'Local Model Recipe', order: 1, createdAt: '2026-10-10T08:13:00.000Z', source: 'import', importedFrom: 'p4' },
            'fleet-services': { name: 'Fleet Services', order: 2, createdAt: '2026-10-10T08:13:00.000Z', source: 'import', importedFrom: 'p3' },
            experimentation: { name: 'Experimentation', order: 3, createdAt: '2026-10-10T08:13:00.000Z', source: 'import', importedFrom: 'p2' },
            'testing-out-coordinator': { name: 'General', order: 0, createdAt: '2026-10-10T09:00:00.000Z', source: 'group' },
            broken: { order: 5 },
        },
        categoryOf: {
            'ws:/work/a': 'local-model-recipe', 'ws:/work/clef-quant': 'local-model-recipe', 'ws:/work/b': 'local-model-recipe', 'ws:/work/ops': 'fleet-services',
            'ws:/work/lab': 'experimentation', 'ws:/work/alice': 'testing-out-coordinator', 'ws:/work/dsh': 'testing-out-coordinator', 'ws:/work/x': 'broken',
        },
        imports: {
            fleetShell: { at: '2026-10-10T08:13:00.000Z', file: '/home/u/.dsh/fleet-shell/state.json', projects: 5, joined: 0, workspaces: 14, skipped: 0 },
            categories: { at: '2026-10-11T01:37:00.000Z', categories: 5, workspaces: 14, backup: '/home/u/.dsh/projects/projects.v1.json' },
        },
    };
}

/** The all-in-one mod's old sidebar file, still holding the projects the user deleted as categories. */
const OLD_SIDEBAR = {
    projects: [
        { id: 'p1', name: 'DSH Plugins' }, { id: 'p4', name: 'Local Model Recipe' }, { id: 'p3', name: 'Fleet Services' }, { id: 'p2', name: 'Experimentation' },
        { id: 'p5', name: 'General' }, { id: 'p6', name: 'Project Testing' }, { id: 'p7', name: 'Security' },
    ],
    projectOf: { 'ws:/work/dsh': 'p1', 'ws:/work/alice': 'p5', 'ws:/work/c': 'p6', 'ws:/work/new': 'p7', 'ws:/work/a': 'p4' },
};

test('move: at the first start, the projects plugin\'s categories come over exactly as they are, with a copy of its store; it and the old sidebar are only read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    mkdirSync(join(home, 'fleet-shell'));
    const oldText = JSON.stringify(OLD_SIDEBAR);
    writeFileSync(join(home, 'fleet-shell', 'state.json'), oldText);
    const dir = mkdtempSync(join(tmpdir(), 'categories-'));
    mkdirSync(join(dir, 'projects'));
    const projectsFile = join(dir, 'projects', 'projects.json');
    // Without the import's record too: a store with categories is never followed by the old sidebar.
    const source = projectsStoreWithCategories();
    delete source.imports.fleetShell;
    const text = `${JSON.stringify(source, null, 2)}\n`;
    writeFileSync(projectsFile, text, { mode: 0o600 });
    const options = { workspaces: ['/work/new', '/work/dsh', '/work/a', '/work/b', '/work/ops', '/work/lab', '/work/alice', '/work/c'] };
    await withDshHome(home, async () => {
        const { host, raw, remote } = setup({}, dir, options);
        await tick();
        const list = await remote.list();
        // The same ids (General keeps the id it shares with a ◆ project), names, sources and order; the workspaces
        // DSH has (clef-quant is gone). Nothing from the old sidebar or the old groups.
        assert.deepEqual(plain(list.categories).map((c) => [c.id, c.name, c.source, c.importedFrom ?? null, c.workspaces.map((w) => w.id.slice(9))]), [
            ['testing-out-coordinator', 'General', 'group', null, ['dsh', 'alice']],
            ['local-model-recipe', 'Local Model Recipe', 'import', 'p4', ['a', 'b']],
            ['fleet-services', 'Fleet Services', 'import', 'p3', ['ops']],
            ['experimentation', 'Experimentation', 'import', 'p2', ['lab']],
        ]);
        // The projects plugin imported these from the old sidebar long ago: none is named as this plugin's import, so
        // the page has no note about them.
        assert.ok(plain(list.categories).every((c) => c.imported === undefined), JSON.stringify(plain(list.categories)));
        const store = JSON.parse(readFileSync(raw.storeFile, 'utf8'));
        // Each category as it was, field for field; a placement DSH no longer lists is kept too; the one without a name isn't.
        assert.deepEqual(store.categories, Object.fromEntries(Object.entries(source.categories).filter(([id]) => id !== 'broken')));
        assert.deepEqual(store.categoryOf, Object.fromEntries(Object.entries(source.categoryOf).filter(([, id]) => id !== 'broken')));
        const copy = join(dir, 'categories', 'from-projects.json');
        assert.deepEqual({ ...store.imports.projects, at: 'x' }, { at: 'x', file: projectsFile, from: 'categories', categories: 4, workspaces: 7, backup: copy });
        assert.equal(store.imports.fleetShell, undefined);
        assert.equal(readFileSync(copy, 'utf8'), text, 'a copy of the projects store as it was');
        assert.equal(mode(copy), 0o600);
        assert.equal(readFileSync(projectsFile, 'utf8'), text, 'the projects store is only read');
        assert.equal(readFileSync(join(home, 'fleet-shell', 'state.json'), 'utf8'), oldText);
        assert.match(readFileSync(raw.logFile, 'utf8'), /move from projects from=categories categories=4 workspaces=7 backup=/);
        assert.doesNotMatch(readFileSync(raw.logFile, 'utf8'), /fleet-shell/);
        // DSH's order reads like the list: each category's workspaces together, then the rest in DSH's order.
        assert.deepEqual(host.workspaceRegistry.list().map((ws) => ws.id.slice(9)), ['dsh', 'alice', 'a', 'b', 'ops', 'lab', 'new', 'c']);

        // Once: the projects store changes, a category is renamed here; a restart moves and imports nothing.
        writeFileSync(projectsFile, JSON.stringify({ version: 1, projects: {}, categories: { other: { name: 'Other', order: 0 } }, categoryOf: {} }));
        await remote.renameCategory('experimentation', 'Experiments');
        const again = await restart(host, raw);
        assert.deepEqual(tree(await again.list()).map(([id, name]) => [id, name]), [
            ['testing-out-coordinator', 'General'], ['local-model-recipe', 'Local Model Recipe'], ['fleet-services', 'Fleet Services'], ['experimentation', 'Experiments'],
        ]);
        assert.equal(readFileSync(raw.logFile, 'utf8').match(/move from projects/g).length, 1);
        assert.doesNotMatch(readFileSync(raw.logFile, 'utf8'), /fleet-shell/);

        // The plugin's store gone (the user deleted it to move again): a second copy, the first kept, and still no import.
        const first = readFileSync(copy, 'utf8');
        writeFileSync(projectsFile, text);
        rmSync(raw.storeFile);
        await restart(host, raw);
        assert.equal(readFileSync(copy, 'utf8'), first);
        const moved = JSON.parse(readFileSync(raw.storeFile, 'utf8'));
        assert.deepEqual([moved.imports.projects.backup, Object.keys(moved.categories)], [join(dir, 'categories', 'from-projects-2.json'), ['local-model-recipe', 'fleet-services', 'experimentation', 'testing-out-coordinator']]);
        assert.doesNotMatch(readFileSync(raw.logFile, 'utf8'), /fleet-shell/);
    });
});

test('switched off and on, the plugin reads its store from the file as it is then, and a late call to the old one is refused', async () => {
    const { host, raw, remote } = setup({}, undefined, { workspaces: ['/work/a', '/work/b'] });
    await tick();
    await remote.createCategory('Alpha', 'ws:/work/a');
    await remote.createCategory('Beta', 'ws:/work/b');
    switchOff(host);
    // While it was off, the file was changed by hand: Beta deleted.
    const file = JSON.parse(readFileSync(raw.storeFile, 'utf8'));
    delete file.categories.beta;
    delete file.categoryOf['ws:/work/b'];
    writeFileSync(raw.storeFile, JSON.stringify(file));
    // A late call to the switched-off plugin changes nothing.
    await refused(remote.createCategory('Gamma'), /switched off or reloaded/);
    await refused(remote.fileWorkspace('ws:/work/b', 'beta'), /switched off or reloaded/);
    const on = fakeHost({ registry: host.workspaceRegistry });
    plugin.apply(on, plugin.Config(raw));
    await tick();
    const again = on.provided.get('dshPluginCategoriesRemote');
    assert.deepEqual(tree(await again.list()), [['alpha', 'Alpha', ['a']]]);
    // Its next change keeps the edit.
    await again.createCategory('Gamma', 'ws:/work/b');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(raw.storeFile, 'utf8')).categories), ['alpha', 'gamma']);
});

test('move: a projects store from before categories gives its groups, never a project that has a coordinator and only its own workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'categories-'));
    mkdirSync(join(dir, 'projects'));
    const projectsFile = join(dir, 'projects', 'projects.json');
    const old = {
        version: 1,
        projects: {
            // From the projects plugin's settings (no name in its store): a coordinator, its own workspace and two more.
            'dsh-plugins': { settings: {}, threads: {}, coordinatorSessionId: 's-dsh', home: 'ws:/work/dsh' },
            // From its settings too, with a coordinator and only its own workspace: a project, not a category.
            storefront: { coordinatorSessionId: 's-sf', home: 'ws:/work/sf' },
            // Made on the Projects page, with a coordinator added, holding only its own workspace (no home recorded).
            lab: { name: 'Lab', source: 'page', createdAt: '2026-10-09T08:30:00.000Z', order: 1, coordinatorSessionId: 's-lab' },
            // Groups without a coordinator, one of them empty.
            'local-model-recipe': { name: 'Local Model Recipe', source: 'import', createdAt: '2026-10-09T08:13:00.000Z', order: 0, importedFrom: 'p4' },
            empty: { name: 'Empty', source: 'page', createdAt: '2026-10-09T09:00:00.000Z', order: 2 },
            // From its settings, no coordinator yet, never held a workspace: never a group.
            docs: {},
        },
        workspaceOf: {
            'ws:/work/dsh': 'dsh-plugins', 'ws:/work/d': 'dsh-plugins', 'ws:/work/e': 'dsh-plugins', 'ws:/work/sf': 'storefront',
            'ws:/work/lab': 'lab', 'ws:/work/a': 'local-model-recipe',
        },
        imports: { fleetShell: { at: '2026-10-09T08:13:00.000Z', projects: 1, joined: 0, workspaces: 1, skipped: 0 } },
    };
    writeFileSync(projectsFile, JSON.stringify(old));
    const { raw, remote } = setup({}, dir, { workspaces: ['/work/dsh', '/work/d', '/work/e', '/work/sf', '/work/lab', '/work/a'] });
    await tick();
    assert.deepEqual(plain((await remote.list()).categories).map((c) => [c.id, c.name, c.source, c.workspaces.map((w) => w.id.slice(9))]), [
        ['dsh-plugins', 'dsh-plugins', 'group', ['dsh', 'd', 'e']],
        ['local-model-recipe', 'Local Model Recipe', 'import', ['a']],
        ['empty', 'Empty', 'group', []],
    ]);
    const store = JSON.parse(readFileSync(raw.storeFile, 'utf8'));
    assert.deepEqual({ ...store.imports.projects, at: 'x', backup: 'y' }, { at: 'x', file: projectsFile, from: 'groups', categories: 3, workspaces: 4, projects: ['storefront', 'lab'], backup: 'y' });
    assert.deepEqual(store.imports.fleetShell, old.imports.fleetShell);
    assert.equal(store.categories['local-model-recipe'].createdAt, '2026-10-09T08:13:00.000Z');
    assert.equal(store.categories['local-model-recipe'].importedFrom, 'p4');
    assert.match(readFileSync(raw.logFile, 'utf8'), /move from projects from=groups categories=3 workspaces=4 projects=2 backup=/);
});

test('move: no projects store is nothing to move, done once; one that can\'t be read waits for the next start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    await withDshHome(home, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'categories-'));
        const { host, raw, remote } = setup({}, dir);
        await tick();
        assert.deepEqual(plain(await remote.list()), { categories: [], problems: [], store: null });
        const store = JSON.parse(readFileSync(raw.storeFile, 'utf8'));
        assert.deepEqual({ ...store.imports.projects, at: 'x' }, { at: 'x', file: raw.projectsStoreFile, from: 'none', categories: 0, workspaces: 0 });
        assert.equal(existsSync(join(dir, 'categories', 'from-projects.json')), false);
        assert.equal(logOf(raw.logFile), '');
        // A projects store that turns up later doesn't move anything: the move ran.
        mkdirSync(join(dir, 'projects'));
        writeFileSync(raw.projectsStoreFile, JSON.stringify(projectsStoreWithCategories()));
        assert.deepEqual(plain(await (await restart(host, raw)).list()), { categories: [], problems: [], store: null });

        // Unreadable (not JSON): logged, nothing written, tried again at the next start.
        const dir2 = mkdtempSync(join(tmpdir(), 'categories-'));
        mkdirSync(join(dir2, 'projects'));
        writeFileSync(join(dir2, 'projects', 'projects.json'), '{ not json');
        const second = setup({}, dir2);
        await tick();
        assert.match(readFileSync(second.raw.logFile, 'utf8'), /error move from projects/);
        assert.equal(existsSync(second.raw.storeFile), false);
        writeFileSync(join(dir2, 'projects', 'projects.json'), JSON.stringify(projectsStoreWithCategories()));
        const later = await restart(second.host, second.raw);
        const moved = plain(await later.list()).categories;
        assert.equal(moved.length, 4);
        // With the projects plugin's record of its own import of the old sidebar carried over: still none named as ours.
        assert.ok(JSON.parse(readFileSync(second.raw.storeFile, 'utf8')).imports.fleetShell?.projects === 5);
        assert.ok(moved.every((c) => c.imported === undefined));
    });
});

test('move plan: categories as they are, groups from before them, and nothing from anything else', () => {
    const now = '2026-10-11T04:00:00.000Z';
    const plan = planFromProjects(projectsStoreWithCategories(), now);
    assert.deepEqual([plan.from, plan.order, plan.projects], ['categories', ['testing-out-coordinator', 'local-model-recipe', 'fleet-services', 'experimentation'], []]);
    // The old sidebar's import, when the projects store records it, is remembered here too.
    assert.deepEqual(plan.fleetShell, projectsStoreWithCategories().imports.fleetShell);
    // Order by their place in the list, then as listed.
    const shuffled = planFromProjects({ version: 1, categories: { b: { name: 'B', order: 1 }, a: { name: 'A', order: 0 }, c: { name: 'C' } }, categoryOf: { w: 'c', v: 'nope' } }, now);
    assert.deepEqual([shuffled.order, shuffled.categoryOf], [['a', 'b', 'c'], { w: 'c' }]);
    // An empty categories object is a store that made categories and had none.
    assert.deepEqual(plain(planFromProjects({ version: 1, projects: { x: { name: 'X' } }, workspaceOf: { w: 'x' }, categories: {} }, now)), { from: 'categories', categories: {}, categoryOf: {}, order: [], projects: [] });
    const none = { from: 'none', categories: {}, categoryOf: {}, order: [], projects: [] };
    for (const stored of [null, {}, { version: 2, categories: { a: { name: 'A' } } }, { version: 1, projects: {} }, 'text']) {
        assert.deepEqual(plain(planFromProjects(stored, now)), none, JSON.stringify(stored));
    }
    // The import's record comes along even with nothing else.
    assert.deepEqual(planFromProjects({ version: 1, projects: {}, imports: { fleetShell: { at: 't' } } }, now).fleetShell, { at: 't' });
});

test('import: the old sidebar\'s projects come in once, as categories in their order; only names and workspaces, and the old file is only read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    const file = join(home, 'fleet-shell', 'state.json');
    mkdirSync(join(home, 'fleet-shell'));
    const old = {
        prefs: { projectsSidebar: true, treeOrder: 'updated' },
        projects: [
            { id: 'p4', name: 'Local Model Recipe', instructions: '', files: [], defaults: {} },
            { id: 'p3', name: 'Fleet  Services', instructions: '', files: [], defaults: {} },
            { id: 'p1', name: 'dsh plugins', instructions: '', files: [], defaults: {} },
            { id: 'p9', name: 'Security' },
            { id: 'p8', name: '   ' },
        ],
        projectOf: {
            'ws:/work/a': 'p4', 'ws:/work/b': 'p3', 'ws:/work/gone': 'p3', 'ws:/work/c': '_none',
            'ws:/work/d': 'p1', 'ws:/work/dsh': 'p4', 'ws:/work/e': 'p-deleted',
        },
        agentOverride: { lane: 'x' },
    };
    const text = `${JSON.stringify(old, null, 2)}\n`;
    writeFileSync(file, text);
    const dir = mkdtempSync(join(tmpdir(), 'categories-'));
    const options = { workspaces: ['/work/dsh', '/work/a', '/work/b', '/work/c', '/work/d', '/work/e'] };
    await withDshHome(home, async () => {
        const { host, raw, remote } = setup({ storeFile: '~/.dsh/categories/categories.json', logFile: '~/.dsh/categories/categories.log' }, dir, options);
        await tick();
        const list = await remote.list();
        // Each marked as this plugin's own import, for the page's note.
        assert.deepEqual(plain(list.categories).map((c) => [c.id, c.name, c.source, c.importedFrom, c.imported, c.workspaces.map((w) => w.id.slice(9))]), [
            ['local-model-recipe', 'Local Model Recipe', 'import', 'p4', true, ['dsh', 'a']],
            ['fleet-services', 'Fleet Services', 'import', 'p3', true, ['b']],
            ['dsh-plugins', 'dsh plugins', 'import', 'p1', true, ['d']],
            ['security', 'Security', 'import', 'p9', true, []],
        ]);
        // Its data lives in DSH's data folder, as DSH_HOME says.
        assert.equal(raw.storeFile, '~/.dsh/categories/categories.json');
        const storeFile = join(home, 'categories', 'categories.json');
        const store = JSON.parse(readFileSync(storeFile, 'utf8'));
        assert.deepEqual({ ...store.imports.fleetShell, at: 'x' }, { at: 'x', file, categories: 4, joined: 0, workspaces: 4, skipped: 1, made: ['local-model-recipe', 'fleet-services', 'dsh-plugins', 'security'] });
        assert.equal(logOf(join(home, 'categories', 'categories.log')).split('\n').filter((line) => / category-new \S+ import$/.test(line)).length, 4, 'each category it made is logged');
        assert.doesNotMatch(JSON.stringify(store), /lane|agentOverride|instructions/);
        assert.match(readFileSync(join(home, 'categories', 'categories.log'), 'utf8'), /import fleet-shell categories=4 joined=0 workspaces=4 skipped=1/);
        assert.equal(readFileSync(file, 'utf8'), text, 'the old file is unchanged');
        assert.deepEqual(host.workspaceRegistry.list().map((ws) => ws.id.slice(9)), ['dsh', 'a', 'b', 'd', 'c', 'e']);

        // Once only: a later start with a changed old file imports nothing.
        writeFileSync(file, JSON.stringify({ ...old, projects: [...old.projects, { id: 'p7', name: 'Later' }], projectOf: { 'ws:/work/c': 'p7' } }));
        await remote.fileWorkspace('ws:/work/b', '');
        const after = await (await restart(host, { ...raw })).list();
        assert.deepEqual(plain(after.categories).map((c) => [c.id, c.workspaces.map((w) => w.id.slice(9))]), [
            ['local-model-recipe', ['dsh', 'a']], ['fleet-services', []], ['dsh-plugins', ['d']], ['security', []],
        ]);
        assert.equal(dataPath(raw.storeFile), storeFile);
    });
});

test('import: after groups from before categories, a name already here joins it; an unreadable old file is logged and tried again; none at all is quiet', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    await withDshHome(home, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'categories-'));
        mkdirSync(join(dir, 'projects'));
        // A projects store from before categories, with one group, that never imported the old sidebar.
        writeFileSync(join(dir, 'projects', 'projects.json'), JSON.stringify({ version: 1, projects: { fleet: { name: 'Fleet Services', source: 'page', order: 0 } }, workspaceOf: { 'ws:/work/a': 'fleet' } }));
        const options = { workspaces: ['/work/a', '/work/b', '/work/c'] };
        const { host, raw } = setup({}, dir, options);
        await tick();
        assert.doesNotMatch(logOf(raw.logFile), /import/);
        mkdirSync(join(home, 'fleet-shell'));
        writeFileSync(join(home, 'fleet-shell', 'state.json'), '{ not json');
        await restart(host, raw);
        assert.match(readFileSync(raw.logFile, 'utf8'), /error import fleet-shell/);
        assert.equal(JSON.parse(readFileSync(raw.storeFile, 'utf8')).imports.fleetShell, undefined);
        writeFileSync(join(home, 'fleet-shell', 'state.json'), JSON.stringify({ projects: [{ id: 'p3', name: ' fleet services' }], projectOf: { 'ws:/work/b': 'p3', 'ws:/work/a': 'p3' } }));
        const again = await restart(host, raw);
        assert.deepEqual(tree(await again.list()), [['fleet', 'Fleet Services', ['a', 'b']]]);
        assert.match(readFileSync(raw.logFile, 'utf8'), /import fleet-shell categories=0 joined=1 workspaces=1 skipped=0/);
    });
});

test('import plan: one group per name in the old order, a name already here joins it, and what stays where it is', () => {
    const state = {
        projects: [{ id: 'p1', name: ' Alpha  One ' }, { id: 'p2', name: 'beta' }, { id: 'p3', name: 'alpha one' }, { id: 'p4', name: ' ' }, { id: 5, name: 'No id' }],
        projectOf: { w1: 'p1', w2: 'p3', w3: 'p2', w4: '_none', w5: 'p-deleted', w6: 'p1', w7: 'p2' },
    };
    const plan = planFleetShellImport(state, { names: new Map([['beta', 'beta-here']]), known: (id) => id !== 'w6', placed: (id) => id === 'w7' });
    assert.deepEqual(plan, {
        groups: [{ name: 'Alpha One', from: 'p1', workspaces: ['w1', 'w2'] }, { name: 'beta', join: 'beta-here', from: 'p2', workspaces: ['w3'] }],
        kept: ['w7'], skipped: ['w6'], loose: ['w4', 'w5'],
    });
    const none = { groups: [], kept: [], skipped: [], loose: [] };
    const here = { names: new Map(), known: () => true, placed: () => false };
    assert.deepEqual(planFleetShellImport(null, here), none);
    assert.deepEqual(planFleetShellImport({ projects: 'p1', projectOf: null }, here), none);
});

test('import preview: says what the move from the projects store and the import will do, reading only, and that they ran once they have', () => {
    const state = { projects: [{ id: 'p1', name: 'Fleet Services' }, { id: 'p2', name: 'Security' }], projectOf: { w1: 'p1', w2: 'p1', w3: 'p2', w4: '_none', w9: 'p2' } };
    const workspaces = {
        w1: { path: '/work/fleet-ops', title: 'fleet-ops', sessionIds: ['s-chat'] },
        w2: { path: '/work/plugins', title: 'deepseek-plugins', sessionIds: ['s-coordinator'] },
        w3: { path: '/work/lab', title: 'Vulnerability Lab', sessionIds: [] },
        w4: { path: '/work/discord', title: 'DSH Discord', sessionIds: [] },
    };
    /** A DSH home with the old sidebar file, DSH's workspaces and this projects store; every file's text. */
    const homeWith = (projects) => {
        const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
        for (const dir of ['fleet-shell', 'storages', 'projects']) mkdirSync(join(home, dir));
        const files = {
            [join(home, 'fleet-shell', 'state.json')]: JSON.stringify(state),
            [join(home, 'storages', 'workspace.json')]: JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces } }),
            [join(home, 'projects', 'projects.json')]: JSON.stringify(projects),
        };
        for (const [file, text] of Object.entries(files)) writeFileSync(file, text);
        return { home, files };
    };
    const script = fileURLToPath(new URL('../scripts/import-preview.mjs', import.meta.url));
    const run = (home) => spawnSync(process.execPath, [script], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
    const unchanged = ({ home, files }) => {
        for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(file, 'utf8'), text, `${file} is unchanged`);
        assert.equal(existsSync(join(home, 'categories')), false, 'nothing of its own is made');
    };

    // The projects plugin has categories: those come over, and the old sidebar isn't read.
    const withCategories = homeWith({
        version: 1,
        projects: { 'dsh-plugins': { coordinatorSessionId: 's-coordinator', home: 'w2' } },
        workspaceOf: { w2: 'dsh-plugins' },
        categories: { 'fleet-services': { name: 'Fleet Services', order: 1, source: 'import' }, lab: { name: 'Lab', order: 2, source: 'page' } },
        categoryOf: { w1: 'fleet-services', w3: 'lab' },
    });
    let out = run(withCategories.home);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /From the projects plugin's store \(.*projects\.json, only read; copied to .*from-projects\.json first\), at the first start:\n\n1\. Fleet Services\n {5}fleet-ops \(\/work\/fleet-ops\)\n2\. Lab\n {5}Vulnerability Lab \(\/work\/lab\)\n/);
    assert.match(out.stdout, /The old sidebar \(.*state\.json\) isn't read: the projects plugin's store had categories, so those are your categories as you left them\./);
    assert.doesNotMatch(out.stdout, /a new category|Security|DSH Plugins/);
    unchanged(withCategories);

    // A projects store from before categories: its groups come over (not a project in only its own workspace), then the old sidebar.
    const before = homeWith({
        version: 1,
        projects: { 'dsh-plugins': { coordinatorSessionId: 's-coordinator', home: 'w2' }, lab: { name: 'Lab', source: 'page', order: 0 } },
        workspaceOf: { w2: 'dsh-plugins', w3: 'lab' },
    });
    out = run(before.home);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /at the first start:\n\n1\. Lab\n {5}Vulnerability Lab \(\/work\/lab\)\n\nThese were groups of workspaces, from before categories\.\nProjects with a coordinator in their own workspace stay projects only: dsh-plugins\n/);
    assert.match(out.stdout, /1\. Fleet Services, a new category\n {5}fleet-ops \(\/work\/fleet-ops\)\n {5}deepseek-plugins \(\/work\/plugins\)\n2\. Security, a new category\n {5}\(no workspaces\)\n/);
    assert.match(out.stdout, /names and workspaces only; its instructions, files and defaults stay behind/);
    assert.match(out.stdout, /Already in a category here, stays there: Vulnerability Lab \(\/work\/lab\) in "Lab"/);
    assert.match(out.stdout, /Ungrouped in the old sidebar, goes to Other workspaces: DSH Discord \(\/work\/discord\)/);
    // A workspace DSH no longer has is said in words, never by its id.
    assert.match(out.stdout, /Gone from DSH, skipped: a workspace DSH no longer has\n/);
    assert.doesNotMatch(out.stdout, /w9/);
    assert.match(out.stdout, /Result: 2 new categories, 0 joined, 2 workspaces placed, 1 skipped\./);
    unchanged(before);

    // Once they have run, it says so.
    const ran = (home, imports) => {
        mkdirSync(join(home, 'categories'));
        writeFileSync(join(home, 'categories', 'categories.json'), JSON.stringify({ version: 1, categories: {}, categoryOf: {}, imports }));
        return run(home).stdout;
    };
    out = ran(withCategories.home, { projects: { at: '2026-10-11T04:00:00.000Z', from: 'categories', categories: 3, workspaces: 5 } });
    assert.match(out, /The categories already came over from the projects plugin \(2026-10-11T04:00:00\.000Z\): 3 categories, 5 workspaces\./);
    assert.match(out, /isn't read: the projects plugin's store had categories/);
    out = ran(before.home, { projects: { at: '2026-10-11T04:00:00.000Z', from: 'groups', categories: 1, workspaces: 1 }, fleetShell: { at: '2026-10-11T04:00:01.000Z', categories: 2, joined: 0, workspaces: 2, skipped: 1 } });
    assert.match(out, /The categories already came over from the projects plugin \(2026-10-11T04:00:00\.000Z\): 1 category, 1 workspace\./);
    assert.match(out, /The old sidebar was already imported \(2026-10-11T04:00:01\.000Z\): 2 categories, 2 workspaces, 1 skipped\. It won't run again\./);
});

test('names and ids: one line within DSH\'s 80 bytes, ids in any script', () => {
    assert.equal(clipName('  Fleet \n Services '), 'Fleet Services');
    assert.equal(clipName('x'.repeat(80)), 'x'.repeat(80));
    assert.ok(Buffer.byteLength(clipName('前端'.repeat(30))) <= 80);
    assert.equal(slugify('Fleet Services'), 'fleet-services');
    assert.notEqual(slugify('前端'), slugify('后端'));
    assert.equal(slugify('Café'), 'cafe');
    assert.equal(slugify('!!!'), 'category');
    assert.deepEqual(longestRun([3, 0, 1, 4, 2]), [1, 2, 3]);
    assert.deepEqual(longestRun([]), []);
});
