#!/usr/bin/env node
/**
 * Real-host end-to-end test for the categories plugin.
 *
 * Boots a real DSH (the shipped web profile, in a temporary DSH_HOME) with
 * this repo's categories and session-bridge plugins. A first start without
 * categories makes DSH's workspaces; then, as on the user's DSH, the
 * projects plugin's store holds categories from before this plugin and the
 * all-in-one mod's old sidebar file is there. At the next start the plugin
 * moves the categories over once, exactly as they are (reading the projects
 * store only), doesn't read the old sidebar file (that store had
 * categories), and keeps DSH's own workspace order in step. Then the
 * window's endpoints (list, make, file, move, rename, delete, refusals), the
 * browser half DSH serves, and a restart that changes nothing.
 *
 * With COORDINATOR=1 the coordinator plugin runs beside it: neither answers
 * for the other, the projects store stays as it was (rollback data), the
 * coordinator logs nothing about categories, and DSH's order stays the
 * categories'.
 *
 *   DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node plugins/categories/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs `dsh` from PATH. KEEP=1 keeps the temp folder.
 */
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = resolve(here, '../../..');
const WITH_COORDINATOR = process.env.COORDINATOR === '1';

function findDsh() {
    const bin = process.env.DSH_BIN;
    if (bin) return bin.endsWith('.js') ? [process.execPath, bin] : [bin];
    try {
        const found = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
        if (found) return [found];
    } catch {}
    return null;
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) {
        passed += 1;
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.log(`not ok - ${name}${detail ? `\n    ${detail}` : ''}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 30000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'dsh-categories-e2e-'));
const home = join(root, 'home');
const ws = join(root, 'ws');
const sock = join(root, 'bridge.sock');
const dshLog = join(root, 'dsh.log');
// The plugins' default places, in DSH's data folder (DSH_HOME).
const categoriesDir = join(home, 'categories');
const storeFile = join(categoriesDir, 'categories.json');
const logFile = join(categoriesDir, 'categories.log');
const projectsFile = join(home, 'projects', 'projects.json');
const oldFile = join(home, 'fleet-shell', 'state.json');

function bridge(method, path, body) {
    return new Promise((resolvePromise, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = request({
            socketPath: sock, path, method,
            headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error(`${method} ${path}: ${res.statusCode} ${text.slice(0, 300)}`));
                else resolvePromise(text ? JSON.parse(text) : null);
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/** GET from the DSH web server. */
function httpGet(url, headers = {}) {
    return new Promise((resolvePromise, reject) => {
        const req = request(url, { headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end();
    });
}

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const modeOf = (file) => statSync(file).mode & 0o777;
const octal = (mode) => mode.toString(8);

/** Sign in to DSH's web server as a browser does, from the newest sign-in link in its log. */
async function signInWeb() {
    const signIn = [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1] ?? '';
    const cookie = String((await httpGet(signIn)).headers['set-cookie']?.[0] ?? '').split(';')[0];
    return { base: new URL('./', signIn), cookie };
}

/** Call a Remote endpoint the way the window does: POST /api/<endpoint> with a client-request envelope. */
function webApi(web, endpoint, args) {
    return new Promise((resolvePromise, reject) => {
        const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } });
        const req = request(new URL(`api/${endpoint}`, web.base), {
            method: 'POST',
            headers: { cookie: web.cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let result;
                try { result = JSON.parse(text).result; } catch {}
                resolvePromise(result ?? { ok: false, error: { code: `http/${res.statusCode}`, message: text.slice(0, 300) } });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

const profile = join(home, 'profiles', 'web');

/** The web profile with these of the repo's plugins linked in, and its patch. */
function writeProfile(names) {
    rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    const plugins = Object.fromEntries(names.map((name) => [`dsh-plugin-${name}`, join(pluginsDir, name)]));
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: Object.fromEntries(Object.entries(plugins).map(([name, dir]) => [name, `link:${dir}`])),
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(plugins)] } },
    }, null, 2)}\n`);
    for (const [name, dir] of Object.entries(plugins)) symlinkSync(dir, join(profile, 'node_modules', name), 'dir');
    const q = JSON.stringify;
    // The categories plugin gets no config row: its defaults put its data in DSH's data folder.
    // The model is never called; a provider is named so DSH has a default.
    writeFileSync(join(profile, 'cordis.patch.yml'), `- id: agent-default-model
  config:
    provider: fake
    model: fake-model
- id: llm-pi-ai
  config:
    providers:
      fake:
        displayName: Fake
        api: openai-completions
        baseURL: http://127.0.0.1:9/v1
        apiKeyEnv: FAKE_LLM_KEY
        models:
          - id: fake-model
            name: Fake Model
            contextWindow: 131072
            reasoningEfforts: false
- id: session-bridge
  config:
    socketPath: ${q(sock)}
    logFile: ${q(join(root, 'bridge.log'))}
`);
}

function startDsh(dsh) {
    const out = openSync(dshLog, 'a');
    const local = '127.0.0.1,localhost';
    const child = spawn(dsh[0], [...dsh.slice(1), '--profile', 'web', '--no-open', '--port', '0'], {
        cwd: ws,
        env: { ...process.env, DSH_HOME: home, FAKE_LLM_KEY: 'sk-fake', DSH_TELEMETRY_DISABLED: '1', NO_PROXY: local, no_proxy: local },
        stdio: ['ignore', out, out],
    });
    closeSync(out);
    return child;
}

async function stopDsh(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    await exited;
    clearTimeout(timer);
}

const signIns = () => [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].length;

/** Start DSH and wait for the bridge and a new web sign-in link. */
async function boot(dsh, what) {
    const before = signIns();
    const child = startDsh(dsh);
    await waitFor(async () => existsSync(sock) && (await bridge('GET', '/health')).ok, `the session bridge (${what})`, 90000);
    await waitFor(() => signIns() > before, `the web sign-in link (${what})`, 30000);
    return child;
}

const dsh = findDsh();
if (!dsh) {
    console.log('skipped: set DSH_BIN to a DSH bin.js (or put dsh on PATH) to run the real-host test');
    process.exit(0);
}

mkdirSync(ws, { recursive: true });
let child;
try {
    // 1. A DSH without categories: its workspaces are made.
    writeProfile(['session-bridge']);
    child = await boot(dsh, 'first start');
    const dirs = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, join(root, `work-${k}`)]));
    const wsId = {};
    for (const [k, dir] of Object.entries(dirs)) {
        mkdirSync(dir);
        wsId[k] = (await bridge('POST', '/sessions', { workspacePath: dir })).workspace.id;
    }
    // DSH's own folder as a workspace too, the one the projects plugin's ◆ project works in.
    const homeWs = (await bridge('POST', '/sessions', { workspacePath: ws })).workspace.id;
    await stopDsh(child);

    // 2. As on the user's DSH: the projects plugin's store has four categories in their places, one (General)
    // with the same id as a ◆ project and one placement of a workspace DSH no longer has; groups from before
    // categories are still recorded; the old sidebar was never imported. The old sidebar file still names
    // projects the user deleted as categories.
    const projectsStore = {
        version: 1,
        projects: {
            'e2e-project': { settings: { goal: 'Keep it' }, threads: {}, pendingHandbacks: [], nextThread: 1, home: homeWs },
            'testing-out-coordinator': { name: 'Testing out Coordinator', source: 'page', order: 0, settings: {}, threads: {}, pendingHandbacks: [], nextThread: 3, home: wsId.a },
        },
        workspaceOf: { [wsId.b]: 'dsh-plugins', [wsId.a]: 'testing-out-coordinator' },
        categories: {
            'local-model-recipe': { name: 'Local Model Recipe', order: 1, createdAt: '2026-10-10T08:13:00.000Z', source: 'import', importedFrom: 'p4' },
            'fleet-services': { name: 'Fleet Services', order: 2, createdAt: '2026-10-10T08:13:00.000Z', source: 'import', importedFrom: 'p3' },
            experimentation: { name: 'Experimentation', order: 3, createdAt: '2026-10-10T08:13:00.000Z', source: 'import', importedFrom: 'p2' },
            'testing-out-coordinator': { name: 'General', order: 0, createdAt: '2026-10-10T09:00:00.000Z', source: 'group' },
        },
        categoryOf: { [wsId.c]: 'local-model-recipe', 'clef-quant-gone': 'local-model-recipe', [wsId.d]: 'fleet-services', [wsId.e]: 'experimentation', [wsId.a]: 'testing-out-coordinator', [wsId.b]: 'testing-out-coordinator' },
        imports: { categories: { at: '2026-10-11T01:37:00.000Z', categories: 5, workspaces: 14 } },
    };
    mkdirSync(dirname(projectsFile), { recursive: true });
    const projectsText = `${JSON.stringify(projectsStore, null, 2)}\n`;
    writeFileSync(projectsFile, projectsText, { mode: 0o600 });
    mkdirSync(dirname(oldFile), { recursive: true });
    writeFileSync(oldFile, `${JSON.stringify({
        prefs: { projectsSidebar: true },
        projects: [
            { id: 'p1', name: 'DSH Plugins', instructions: 'not read', files: [], defaults: {} },
            { id: 'p4', name: 'Local Model Recipe' }, { id: 'p5', name: 'General' }, { id: 'p6', name: 'Project Testing' }, { id: 'p7', name: 'Security' },
        ],
        projectOf: { [wsId.b]: 'p1', [wsId.c]: 'p4', [wsId.a]: 'p5', [homeWs]: 'p6', [wsId.e]: 'p7' },
        agentOverride: { lane: 'not read' },
    }, null, 2)}\n`);
    const oldText = readText(oldFile);

    // 3. The plugin's first start: the categories move over once, exactly as they are; the old sidebar isn't read.
    writeProfile(WITH_COORDINATOR ? ['categories', 'session-bridge', 'coordinator'] : ['categories', 'session-bridge']);
    child = await boot(dsh, 'categories\' first start');
    await waitFor(() => readText(logFile).includes('move from projects'), 'the move from the projects store', 30000);
    const web = await signInWeb();
    const api = (method, args) => webApi(web, `dsh-plugin-categories/${method}`, args);
    let lists = await waitFor(async () => { const r = await api('list', {}); return r.ok ? r : null; }, 'the categories endpoint', 30000);
    const category = (name) => lists.value?.categories?.find((c) => c.name === name);
    const holds = (name) => category(name)?.workspaces?.map((w) => w.id) ?? [];
    const store = readJson(storeFile);
    check('the projects plugin\'s categories come over exactly as they are, General keeping the id it shares with a ◆ project',
        JSON.stringify(store.categories) === JSON.stringify(projectsStore.categories) && JSON.stringify(store.categoryOf) === JSON.stringify(projectsStore.categoryOf),
        JSON.stringify({ categories: store.categories, categoryOf: store.categoryOf }));
    check('the list shows them in their order, each with the workspaces DSH has', JSON.stringify(lists.value?.categories?.map((c) => [c.id, c.name])) === JSON.stringify([
        ['testing-out-coordinator', 'General'], ['local-model-recipe', 'Local Model Recipe'], ['fleet-services', 'Fleet Services'], ['experimentation', 'Experimentation'],
    ]) && holds('General').length === 2 && holds('General').includes(wsId.a) && holds('General').includes(wsId.b) && holds('Local Model Recipe').join() === wsId.c
        && holds('Fleet Services').join() === wsId.d && holds('Experimentation').join() === wsId.e, JSON.stringify(lists.value?.categories));
    check('the move is logged once, with a copy of the projects store', readText(logFile).split('\n').filter((l) => l.includes(' move from projects ')).length === 1
        && readText(logFile).includes('move from projects from=categories categories=4 workspaces=6 backup=') && readText(join(categoriesDir, 'from-projects.json')) === projectsText,
    readText(logFile));
    check('the projects store is only read', readText(projectsFile) === projectsText);
    check('the old sidebar isn\'t read: nothing deleted comes back', !readText(logFile).includes('fleet-shell') && store.imports?.fleetShell === undefined
        && !['DSH Plugins', 'Project Testing', 'Security'].some((name) => category(name)) && readText(oldFile) === oldText && !/not read|agentOverride/.test(readText(storeFile)),
    readText(logFile));
    check('the plugin\'s folder is 700, its store, log and copy 600', modeOf(categoriesDir) === 0o700 && modeOf(storeFile) === 0o600 && modeOf(logFile) === 0o600
        && modeOf(join(categoriesDir, 'from-projects.json')) === 0o600,
    [categoriesDir, storeFile, logFile].map((f) => octal(modeOf(f))).join(' '));
    const dshOrder = async () => (await bridge('GET', '/workspaces')).map((w) => w.id);
    const together = (order, ids) => ids.length === 0 || order.slice(order.indexOf(ids[0]), order.indexOf(ids[0]) + ids.length).join() === ids.join();
    let order = await waitFor(async () => {
        const now = await dshOrder();
        return together(now, holds('General')) && now.indexOf(holds('General')[0]) === 0 ? now : null;
    }, 'DSH\'s order in category order', 15000).catch(async () => dshOrder());
    check('DSH\'s own workspace order holds each category together, in their order, then the rest', together(order, holds('General')) && order.indexOf(holds('General')[0]) === 0
        && order.indexOf(wsId.c) === 2 && order.indexOf(wsId.d) === 3 && order.indexOf(wsId.e) === 4 && order.indexOf(homeWs) === 5, JSON.stringify(order));

    // The browser half: DSH serves it, and it parses (DSH sends browser halves in batches, so one that does not parse breaks others).
    const app = await httpGet(web.base.href, { cookie: web.cookie });
    const clientUrl = /"id":"dsh-plugin-categories","url":"([^"]+)"/.exec(app.text)?.[1];
    const client = clientUrl ? await httpGet(new URL(clientUrl, web.base).href, { cookie: web.cookie }) : { status: 0, text: '' };
    let parses = false;
    try { new Script(client.text); parses = true; } catch {}
    check('DSH serves the browser half and it parses', client.status === 200 && parses, `${clientUrl ?? 'not in the boot graph'}: ${client.status}`);

    // 4. The window's endpoints.
    lists = await api('createCategory', { name: 'Later', workspace: homeWs });
    const laterId = lists.value?.category;
    check('a new category is last, with the workspace it was made with', lists.ok && laterId === 'later' && lists.value.categories.at(-1)?.id === laterId && holds('Later').join() === homeWs,
        JSON.stringify(lists));
    lists = await api('fileWorkspace', { workspace: wsId.d, category: laterId, before: homeWs });
    order = await dshOrder();
    check('a workspace filed before another lands there, in DSH\'s order too', lists.ok && holds('Later').join() === `${wsId.d},${homeWs}` && holds('Fleet Services').length === 0
        && together(order, [wsId.d, homeWs]), `${JSON.stringify(lists.value?.categories)} ${JSON.stringify(order)}`);
    lists = await api('moveCategory', { category: laterId, before: 'testing-out-coordinator' });
    order = await dshOrder();
    check('a category moves, and DSH\'s order with it', lists.ok && lists.value.categories[0]?.id === laterId && order.indexOf(homeWs) < order.indexOf(wsId.a),
        `${JSON.stringify(lists.value?.categories?.map((c) => c.id))} ${JSON.stringify(order)}`);
    lists = await api('renameCategory', { category: laterId, name: 'Later On' });
    check('a category is renamed', lists.ok && category('Later On')?.id === laterId);
    const refusals = [
        [await api('fileWorkspace', { workspace: wsId.a, category: 'nope' }), /"nope" is not a category here/],
        [await api('createCategory', { name: '   ' }), /a category needs a name/],
        [await api('fileWorkspace', { workspace: 'no-such-workspace', category: laterId }), /DSH has no such workspace/],
        [await api('fileWorkspace', { workspace: wsId.c, category: laterId, before: wsId.a }), /that workspace is in another category/],
    ];
    check('what can\'t be done is refused, saying why', refusals.every(([r, pattern]) => !r.ok && r.error?.code === 'categories/refused' && pattern.test(r.error.message)),
        JSON.stringify(refusals.map(([r]) => r.error ?? r)));
    lists = await api('removeCategory', { category: laterId });
    order = await dshOrder();
    check('deleting a category leaves its workspaces in DSH, in none', lists.ok && !category('Later On') && order.includes(wsId.d) && order.includes(homeWs)
        && order.indexOf(wsId.e) < order.indexOf(wsId.d) && order.indexOf(wsId.e) < order.indexOf(homeWs), JSON.stringify(order));
    lists = await api('fileWorkspace', { workspace: wsId.d, category: 'fleet-services' });
    check('a workspace goes back into a moved-over category', lists.ok && holds('Fleet Services').join() === wsId.d, JSON.stringify(lists.value?.categories));

    if (WITH_COORDINATOR) {
        // Beside the coordinator plugin: each answers for its own, and the projects store stays as it was.
        const coordinating = await webApi(web, 'dsh-plugin-coordinator/list', {});
        check('the coordinator plugin answers for its coordinating chats only', coordinating.ok && Array.isArray(coordinating.value?.projects)
            && coordinating.value.categories === undefined, JSON.stringify(coordinating).slice(0, 300));
        check('the projects store is still only read', readText(projectsFile) === projectsText);
        const coordinatorLog = readText(join(home, 'coordinator', 'coordinator.log'));
        check('the coordinator plugin logs nothing about categories or DSH\'s workspace order', !/categor|workspace-order|fleet-shell/.test(coordinatorLog),
            coordinatorLog.split('\n').filter((l) => /categor|workspace-order|fleet-shell/.test(l)).join('\n'));
    }

    // 5. A restart: nothing moves or comes in again; the categories and DSH's order are as they were.
    const before = { categories: lists.value?.categories, order: await dshOrder(), store: readText(storeFile) };
    const orderLines = () => readText(logFile).split('\n').filter((l) => l.includes(' workspace-order ')).length;
    const linesBefore = orderLines();
    await stopDsh(child);
    child = await boot(dsh, 'restart');
    const webAgain = await signInWeb();
    const again = await waitFor(async () => { const r = await webApi(webAgain, 'dsh-plugin-categories/list', {}); return r.ok ? r : null; }, 'the categories after the restart', 30000);
    await sleep(500);
    check('after a restart the categories are as they were, nothing moved or imported again', JSON.stringify(again.value?.categories) === JSON.stringify(before.categories)
        && readText(logFile).split('\n').filter((l) => / move from projects /.test(l)).length === 1 && !readText(logFile).includes('fleet-shell') && readText(storeFile) === before.store,
    readText(logFile));
    check('DSH\'s order needed no moves', JSON.stringify(await dshOrder()) === JSON.stringify(before.order) && orderLines() === linesBefore, `${orderLines()} vs ${linesBefore}`);
} catch (error) {
    failed += 1;
    console.log(`not ok - e2e aborted: ${error?.stack ?? error}`);
    console.log(readText(dshLog).split('\n').slice(-40).join('\n'));
} finally {
    await stopDsh(child);
    if (process.env.KEEP === '1') console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
