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
 * browser half DSH serves, and a restart that changes nothing. Then a real
 * window (Chromium on the web profile, Playwright from .e2e/tools): the
 * session list by category with every workspace still there, folding by
 * click and by key, a running chat's dot on its folded workspace's own row
 * and on its folded category (and gone when the turn ends), a workspace
 * dragged onto another category's header and back, Add a workspace's
 * submenu with a name on every row, each dialog by the keyboard giving the
 * keyboard back to its header (or, after a delete, the one in its place), a
 * name in use refused, a long name cut at a word with DSH's tooltip, the
 * Categories page on its glass card, find, a change that can't be saved
 * refused with the page's note until the next change saves, a page row's
 * dialog, the chip at the top of a chat, light and dark, 760 px and
 * contrast, and switched off in Plugins it leaves no header, mark, class or
 * style sheet behind; on again, one of everything. DSH's first-run notices
 * are dismissed before each check, and one that opens late over a click is
 * put away and said in the output. Pictures go to SHOTS (default
 * .e2e/shots/categories/<DSH version>/); a run that stops early leaves a
 * picture of its window (failed-aborted) and names the dialogs open in it.
 * Then its row in the profile at DSH's next start: values of the wrong type
 * count as their defaults, each warned in its log and named for the page,
 * enabled: "no" counts as off, and enabled: false says off, refuses changes
 * in words and writes nothing;
 * and a store that can't be used starts it with none, said in its log and
 * on the page, the file kept beside the new store at the first change (made
 * on the page, which names it). Last, beside the Wallpaper plugin (its
 * commit copied read only, see wallpaperCopy): the page's root unpainted,
 * one glass card, one blur. Without Playwright the run fails, unless
 * NO_WINDOW=1 says to run without the window.
 *
 * With COORDINATOR=1 the coordinator plugin runs beside it: neither answers
 * for the other, the projects store stays as it was (rollback data), the
 * coordinator logs nothing about categories, and DSH's order stays the
 * categories'.
 *
 *   node scripts/e2e.mjs categories      every DSH under .e2e/ and the app's own, with the live fingerprint
 *   DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node plugins/categories/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/ (never one from PATH).
 * KEEP=1 keeps the temp folder.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { dismissNotices, dshBin, findPlaywright, openWindow, repoRoot, setDark, shot } from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from '../../../../test/e2e/fake-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = resolve(here, '../../..');
const WITH_COORDINATOR = process.env.COORDINATOR === '1';
/** Which DSH this is, for the pictures' folder (scripts/e2e.mjs names it). */
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(dshBin() ?? '')?.[1] ?? 'dsh');
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'categories', version);
const json = (value) => JSON.stringify(value);

/** DSH_BIN, else the newest test runtime under .e2e/ (harness.mjs); a bin.js runs under this Node (the app's binary, for the app's DSH). */
function findDsh() {
    const bin = dshBin();
    if (!bin) return null;
    return bin.endsWith('.js') ? [process.execPath, bin] : [bin];
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

/** The first line of each dialog open in the window, for a failure's output. */
async function openDialogs(page) {
    const texts = await page.getByRole('dialog').allInnerTexts().catch(() => []);
    return texts.map((text) => text.trim().split('\n')[0].slice(0, 120)).filter(Boolean);
}

/**
 * Clicks `target`. DSH's first-run dialogs (its Preview Notice; its model-key step, whose Configure later changes
 * nothing) can open late, over what a check clicks, when the machine is busy: one in the way is put away as a
 * person would, said in the output, and the click tried again. Past 30 s it fails, naming the dialogs left open.
 */
async function clickPast(page, target) {
    const end = Date.now() + 30000;
    for (;;) {
        try {
            await target.click({ timeout: 4000 });
            return;
        } catch (error) {
            const open = await openDialogs(page);
            if (Date.now() > end) throw new Error(`${error.message.split('\n')[0]}; dialogs open: ${json(open)}`);
            let putAway = await dismissNotices(page).catch(() => false);
            const later = page.getByRole('button', { name: 'Configure later', exact: true });
            if (await later.count().catch(() => 0)) {
                putAway = true;
                await later.first().click().catch(() => {});
                await page.waitForTimeout(300);
            }
            if (putAway) console.log(`# a dialog of DSH's (${json(open)}) opened late over a click and was put away`);
        }
    }
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

/**
 * The web profile with these of the repo's plugins linked in (a name, or {name, dir} for one from elsewhere), and its
 * patch (plus `rows`, more patch rows).
 */
function writeProfile(names, rows = '') {
    rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    const plugins = Object.fromEntries(names.map((one) => (typeof one === 'string' ? [`dsh-plugin-${one}`, join(pluginsDir, one)] : [`dsh-plugin-${one.name}`, one.dir])));
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: Object.fromEntries(Object.entries(plugins).map(([name, dir]) => [name, `link:${dir}`])),
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(plugins)] } },
    }, null, 2)}\n`);
    for (const [name, dir] of Object.entries(plugins)) symlinkSync(dir, join(profile, 'node_modules', name), 'dir');
    const q = JSON.stringify;
    // The categories plugin gets no config row: its defaults put its data in DSH's data folder.
    // The scripted model answers the one chat the window checks (E2E:say); a provider is named so DSH has a default.
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
        baseURL: http://127.0.0.1:${model.port}/v1
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
${rows}`);
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

/**
 * Wallpaper as the user's DSH runs it, copied (read only) from its commit into the test's folder: WALLPAPER_DIR, else
 * `git archive` of WALLPAPER_REV (default 5b4d1eb, the live DSH's) from WALLPAPER_REPO (default the live DSH's
 * checkout). Null when neither is there.
 */
function wallpaperCopy() {
    if (process.env.WALLPAPER_DIR) return existsSync(join(process.env.WALLPAPER_DIR, 'package.json')) ? process.env.WALLPAPER_DIR : null;
    const repo = process.env.WALLPAPER_REPO || join(homedir(), 'Projects', 'worktrees', 'dsh-split-plugins');
    const rev = process.env.WALLPAPER_REV || '5b4d1eb';
    const out = join(root, 'wallpaper-copy');
    try {
        const tar = execFileSync('git', ['-C', repo, 'archive', rev, 'plugins/wallpaper'], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        mkdirSync(out, { recursive: true });
        execFileSync('tar', ['-x', '-C', out], { input: tar });
        const dir = join(out, 'plugins', 'wallpaper');
        return existsSync(join(dir, 'package.json')) ? dir : null;
    } catch {
        return null;
    }
}

const dsh = findDsh();
if (!dsh) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}

mkdirSync(ws, { recursive: true });
const model = await startFakeModel();
let child;
let win;
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

    // 6. In a real window (Chromium on DSH's web profile): the session list by category, with every one of DSH's
    //    workspaces still there; folding by click and by key; the Categories page on its glass card; the chip at the
    //    top of a chat; light and dark, 760 px, contrast; and switched off in Plugins it leaves nothing behind, then
    //    on again draws one of everything. Pictures in .e2e/shots/categories/<DSH version>/.
    const pw = await findPlaywright();
    if (!pw && process.env.NO_WINDOW !== '1') throw new Error('Playwright is not installed: install it under .e2e/tools, or set NO_WINDOW=1');
    if (pw) {
        const titles = { a: 'work-a', b: 'work-b', c: 'work-c', d: 'work-d', e: 'work-e' };
        // A chat in a workspace of General, for the chip (a blank New Session shows none).
        const chat = (await bridge('POST', '/sessions', { workspacePath: dirs.a, title: 'Chip check', text: 'E2E:say Filed under General.' })).sessionId;
        await waitFor(async () => (await bridge('GET', `/sessions/${encodeURIComponent(chat)}`))?.status === 'idle', 'the chat to finish its turn', 60000).catch(() => {});
        const link = [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1];
        win = await openWindow({ signIn: async () => ({ link }) }, pw, { entry: 'Categories', width: 1280, height: 860 });
        const { page } = win;
        const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const section = async (name, fn) => {
            try {
                // DSH's first-run notices (its Preview Notice) can open late, over whatever a check points at.
                await dismissNotices(page).catch(() => {});
                await fn();
            } catch (error) {
                check(name, false, error?.stack ?? String(error));
                await shot(page, shots, `failed-${slug(name)}`).catch(() => {});
            }
        };
        const heads = () => page.locator('[data-categories-sb] [data-categories-title]').allInnerTexts();
        const listText = () => page.locator('[data-slot="sidebar.workspaces"]').innerText();
        /** The lowest text contrast in `selector`, each text's colour over its grounds layered down to DSH's body. */
        const lowestContrast = (selector) => page.evaluate((sel) => {
            const parse = (c) => {
                const m = /rgba?\(([^)]+)\)/.exec(c);
                if (!m) return null;
                const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
                return { r, g, b, a };
            };
            const lum = ({ r, g, b }) => {
                const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
                return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
            };
            const ground = (el) => {
                const layers = [];
                for (let node = el; node; node = node.parentElement) {
                    const c = parse(getComputedStyle(node).backgroundColor);
                    if (c && c.a > 0) layers.push(c);
                    if (c && c.a >= 1) break;
                }
                let base = document.body.hasAttribute('data-ds-dark-theme') ? { r: 21, g: 21, b: 23 } : { r: 255, g: 255, b: 255 };
                for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
                return base;
            };
            const out = [];
            for (const el of document.querySelectorAll(`${sel} *`)) {
                const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
                if (!own || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
                const fg = parse(getComputedStyle(el).color);
                if (!fg) continue;
                const bg = ground(el);
                const mixed = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
                const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
                out.push({ ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100, text: el.textContent.trim().slice(0, 40) });
            }
            return out.sort((x, y) => x.ratio - y.ratio).slice(0, 3);
        }, selector);

        /** Where the keyboard is: the header or page row that has it (and whether its ring shows), else what does. */
        const focusedOn = () => page.evaluate(() => {
            const el = document.activeElement;
            const head = el?.closest?.('[data-categories-sb]');
            if (head) return { sb: head.getAttribute('data-categories-sb'), self: head === el, ring: el.matches(':focus-visible') };
            const row = el?.closest?.('[data-categories-page] [role="treeitem"][data-categories-id]');
            if (row) return { row: row.getAttribute('data-categories-id'), self: row === el, ring: el.matches(':focus-visible') };
            return { tag: el?.tagName ?? null, name: (el?.getAttribute?.('aria-label') ?? el?.textContent ?? '').trim().slice(0, 40) };
        });
        /** Open a header's or a page row's ⋯ from the keyboard (Shift+F10) and choose `item` with it (Enter). */
        const choose = async (target, item) => {
            await target.focus();
            await page.keyboard.press('Shift+F10');
            const row = page.getByRole('menuitem', { name: item, exact: true });
            await row.waitFor({ state: 'visible', timeout: 5000 });
            await row.focus();
            await page.keyboard.press('Enter');
        };
        const nameField = page.locator('[data-categories-name-input]');
        const refusal = page.locator('.dshc-pg-dialog-error');
        const dialogGone = () => page.getByRole('dialog').first().waitFor({ state: 'hidden', timeout: 5000 });

        await section('the session list by category in a real window', async () => {
            await waitFor(async () => (await heads()).length >= 5, 'the headers in DSH\'s session list', 60000);
            check('the session list shows a header per category in their order, then Other workspaces', json(await heads()) === json(['General', 'Local Model Recipe', 'Fleet Services', 'Experimentation', 'Other workspaces']), json(await heads()));
            const text = await listText();
            check('every one of DSH\'s workspaces is still in its list, under its category (the plugin hides none)', Object.values(titles).every((t) => text.includes(t)), text.slice(0, 400));
            const general = page.locator('[data-categories-sb="testing-out-coordinator"]');
            check('a header says its name and count to a screen reader', (await general.getAttribute('aria-label')) === 'General, 2 workspaces' && (await general.getAttribute('aria-expanded')) === 'true', await general.getAttribute('aria-label'));
            await shot(page, shots, 'sidebar-light');
            await setDark(page, true);
            await shot(page, shots, 'sidebar-dark');
            await setDark(page, false);
            // A click folds it: its workspaces leave the list; Enter on the header opens it again, the keyboard staying there.
            await general.click();
            await waitFor(async () => (await general.getAttribute('aria-expanded')) === 'false', 'the fold', 5000);
            const foldedOut = !(await page.locator('[data-slot="sidebar.workspaces"]').getByText(titles.a, { exact: true }).first().isVisible());
            check('a click folds a category: its workspaces leave the list, the others stay', foldedOut && (await listText()).includes(titles.c), (await listText()).slice(0, 300));
            await shot(page, shots, 'sidebar-folded-light');
            await page.keyboard.press('Shift');
            await general.focus();
            await page.keyboard.press('Enter');
            await waitFor(async () => (await general.getAttribute('aria-expanded')) === 'true', 'the unfold by key', 5000);
            const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-categories-sb'));
            const ring = await general.evaluate((el) => getComputedStyle(el).boxShadow);
            check('Enter opens it again, the keyboard stays on the header, and its ring shows', focused === 'testing-out-coordinator' && /inset/.test(ring) && (await page.locator('[data-slot="sidebar.workspaces"]').getByText(titles.a, { exact: true }).first().isVisible()), json({ focused, ring }));
        });

        await section('a running chat shows on its folded workspace\'s row and on its folded category, in words too', async () => {
            // A turn that keeps running in work-c (the scripted model holds its reply open until it is let go).
            const long = (await bridge('POST', '/sessions', { workspacePath: dirs.c, title: 'Long run', text: 'E2E:slow' })).sessionId;
            await waitFor(async () => (await bridge('GET', `/sessions/${encodeURIComponent(long)}`))?.status === 'running', 'the long turn to run', 30000);
            const recipe = page.locator('[data-categories-sb="local-model-recipe"]');
            const row = page.locator(`[data-slot="sidebar.workspaces"] [data-row-key="workspace:${wsId.c}"]`);
            const seat = row.locator('[data-categories-ws-dot]');
            await row.waitFor({ timeout: 20000 });
            // A click on its row folds or opens a workspace, as DSH does it. Start from an open row, whichever DSH chose.
            const startedOpen = (await row.getAttribute('aria-expanded')) === 'true';
            if (!startedOpen) {
                await row.click({ position: { x: 24, y: 10 } });
                await waitFor(async () => (await row.getAttribute('aria-expanded')) === 'true', 'DSH to open work-c', 5000);
            }
            await waitFor(async () => (await seat.count()) === 0, 'no seat on the open row', 5000).catch(() => {});
            check('an open workspace with a running chat has no seat of the plugin\'s (DSH shows the chat\'s own)', (await seat.count()) === 0);
            // DSH's own fold of the workspace (a click on its row): the dot DSH no longer shows goes on the row.
            await row.click({ position: { x: 24, y: 10 } });
            await waitFor(async () => (await row.getAttribute('aria-expanded')) === 'false', 'DSH to fold work-c', 5000);
            const said = await waitFor(async () => ((await seat.count()) === 1 ? seat.textContent() : null), 'the dot on the folded workspace\'s row', 20000).catch(() => null);
            check('a folded workspace with a running chat shows the dot on its own row, said as "a chat is running"', said === ', a chat is running' && (await seat.locator('[aria-hidden="true"] *').count()) > 0, json({ said }));
            await shot(page, shots, 'sidebar-running-workspace-light');
            await setDark(page, true);
            await shot(page, shots, 'sidebar-running-workspace-dark');
            await setDark(page, false);
            await row.click({ position: { x: 24, y: 10 } });
            await waitFor(async () => (await row.getAttribute('aria-expanded')) === 'true', 'DSH to open work-c again', 5000);
            await waitFor(async () => (await seat.count()) === 0, 'the seat to go', 5000).catch(() => {});
            check('open again, the row\'s seat is gone', (await seat.count()) === 0);
            if (!startedOpen) {
                await row.click({ position: { x: 24, y: 10 } });
                await waitFor(async () => (await row.getAttribute('aria-expanded')) === 'false', 'DSH to fold work-c as it was', 5000);
            }
            // The category folded: its header shows the dot and says "running".
            await recipe.click();
            await waitFor(async () => (await recipe.getAttribute('aria-expanded')) === 'false', 'the fold', 5000);
            const label = await waitFor(async () => {
                const now = await recipe.getAttribute('aria-label');
                return /, running$/.test(now ?? '') ? now : null;
            }, 'the running mark on the folded header', 20000).catch(() => recipe.getAttribute('aria-label'));
            check('a folded category with a running chat shows its dot and says "running"', label === 'Local Model Recipe, 1 workspace, running' && (await recipe.locator('.dshc-sb-dot').count()) === 1, json({ label }));
            await shot(page, shots, 'sidebar-running-folded-light');
            await setDark(page, true);
            await shot(page, shots, 'sidebar-running-folded-dark');
            await setDark(page, false);
            // The turn ends: the dot goes from the folded header too.
            model.release();
            await waitFor(async () => (await bridge('GET', `/sessions/${encodeURIComponent(long)}`))?.status === 'idle', 'the long turn to end', 30000).catch(() => {});
            const after = await waitFor(async () => {
                const now = await recipe.getAttribute('aria-label');
                return now === 'Local Model Recipe, 1 workspace' ? now : null;
            }, 'the running mark to go', 20000).catch(() => recipe.getAttribute('aria-label'));
            check('when the chat stops running, the folded header loses its dot and its "running"', after === 'Local Model Recipe, 1 workspace' && (await recipe.locator('.dshc-sb-dot').count()) === 0, json({ after }));
            await recipe.click();
            await waitFor(async () => (await recipe.getAttribute('aria-expanded')) === 'true', 'the unfold', 5000);
        });

        await section('a workspace dragged onto another category\'s header is filed there; dragged back, it is as it was', async () => {
            const webDrag = await signInWeb();
            const holds = async () => Object.fromEntries(((await webApi(webDrag, 'dsh-plugin-categories/list', {})).value?.categories ?? []).map((c) => [c.name, c.workspaces.map((w) => w.id)]));
            const rowE = page.locator(`[data-slot="sidebar.workspaces"] [data-row-key="workspace:${wsId.e}"]`);
            const fleet = page.locator('[data-categories-sb="fleet-services"]');
            const experimentation = page.locator('[data-categories-sb="experimentation"]');
            const said = page.locator('[data-categories-sidebar-said]');
            await rowE.dragTo(fleet);
            // The store takes it at once; the list follows DSH's order, which the plugin puts in step a moment later.
            const moved = await waitFor(async () => { const now = await holds(); return now['Fleet Services']?.[0] === wsId.e ? now : null; }, 'work-e first in Fleet Services', 10000).catch(() => holds());
            // Said once the window has the answer (the store may have it a moment before).
            const heard = await waitFor(async () => (await said.textContent())?.trim() || null, 'the move said for screen readers', 5000).catch(() => '');
            const label = await fleet.getAttribute('aria-label');
            check('a workspace\'s row dragged onto another category\'s header is filed there, first in it, and that is said',
                json(moved['Fleet Services']) === json([wsId.e, wsId.d]) && json(moved.Experimentation) === json([])
                && label === 'Fleet Services, 2 workspaces' && heard === 'work-e moved to Fleet Services.',
            json({ fleet: moved['Fleet Services'], e: wsId.e, d: wsId.d, label, heard }));
            await shot(page, shots, 'sidebar-dragged-light');
            await rowE.dragTo(experimentation);
            const back = await waitFor(async () => { const now = await holds(); return now.Experimentation?.length === 1 ? now : null; }, 'work-e back in Experimentation', 10000).catch(() => holds());
            // The window has it too once its header counts it (the plugin answers once DSH's order is in step).
            const counted = await waitFor(async () => ((await experimentation.getAttribute('aria-label')) === 'Experimentation, 1 workspace' ? true : null), 'the window to count it back', 10000).catch(() => false);
            check('dragged back onto its own category\'s header, it is where it was', json(back['Fleet Services']) === json([wsId.d]) && json(back.Experimentation) === json([wsId.e]) && counted,
                json({ back, label: await experimentation.getAttribute('aria-label') }));
        });

        await section('Add a workspace names every row of its submenu, the ones in other categories with where they are now', async () => {
            const general = page.locator('[data-categories-sb="testing-out-coordinator"]');
            await choose(general, 'Add a workspace');
            // DSH draws a submenu's entries as menuitem rows with their labels: the last menu open is the submenu.
            const expected = [`${titles.c} · Local Model Recipe`, `${titles.d} · Fleet Services`, `${titles.e} · Experimentation`];
            let rows = null;
            await waitFor(async () => {
                const found = await page.evaluate(() => {
                    const menus = [...document.querySelectorAll('[role="menu"]')].filter((m) => m.getClientRects().length > 0);
                    const sub = menus.length > 1 ? menus.at(-1) : null;
                    if (!sub) return null;
                    const text = (node, skip) => [...node.childNodes].map((n) => (n.nodeType === 3 ? n.textContent : n.nodeType === 1 && !skip(n) ? text(n, skip) : '')).join('');
                    return [...sub.querySelectorAll('[role="menuitem"]')].map((item) => ({
                        shown: text(item, (n) => n.classList.contains('dshc-sr')).replace(/\s+/g, ' ').trim(),
                        spoken: text(item, (n) => n.getAttribute('aria-hidden') === 'true').replace(/\s+/g, ' ').trim(),
                    }));
                });
                rows = found && found.length > 0 ? found : rows;
                // DSH's own order of its workspaces can reach the window a moment after the plugin's answer.
                return rows && json(rows.slice(1).map((r) => r.shown)) === json(expected) ? rows : null;
            }, 'Add a workspace\'s submenu', 5000).catch(() => {});
            rows ??= [];
            await shot(page, shots, 'sidebar-add-a-workspace-light');
            await setDark(page, true);
            await shot(page, shots, 'sidebar-add-a-workspace-dark');
            await setDark(page, false);
            const taken = rows.slice(1);
            check('Add a workspace: no blank row; the workspace in no category first, then each in another category with where it is now, said aloud too',
                rows.length === 4 && rows.every((r) => r.shown && r.spoken) && !rows[0].shown.includes('·')
                && json(taken.map((r) => r.shown)) === json(expected)
                && json(taken.map((r) => r.spoken)) === json([`${titles.c}, now in Local Model Recipe`, `${titles.d}, now in Fleet Services`, `${titles.e}, now in Experimentation`]),
            json(rows));
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await waitFor(async () => (await page.locator('[role="menu"]').count()) === 0, 'the menu to close', 5000).catch(() => {});
        });

        await section('a dialog from a header\'s ⋯ gives the keyboard back to that header; a name in use is refused', async () => {
            const general = page.locator('[data-categories-sb="testing-out-coordinator"]');
            await choose(general, 'Rename…');
            await nameField.waitFor({ state: 'visible', timeout: 5000 });
            await page.keyboard.press('Escape');
            await dialogGone();
            const escaped = await focusedOn();
            check('Escape closes Rename… and the keyboard is back on its header, with its ring', escaped.sb === 'testing-out-coordinator' && escaped.self && escaped.ring, json(escaped));
            // A name another category has, in another case: refused under the field; the dialog and the keyboard stay.
            await choose(general, 'Rename…');
            await nameField.fill('fleet SERVICES');
            await nameField.press('Enter');
            await refusal.waitFor({ state: 'visible', timeout: 5000 });
            const words = await refusal.innerText();
            const inField = await page.evaluate(() => document.activeElement?.hasAttribute('data-categories-name-input') === true);
            check('a name another category has, in any case, is refused under the field, and the keyboard stays in it', words === 'There is a category named Fleet Services already.' && inField, json({ words, inField }));
            await shot(page, shots, 'sidebar-rename-refused-light');
            await setDark(page, true);
            await shot(page, shots, 'sidebar-rename-refused-dark');
            await setDark(page, false);
            // Renamed by the keyboard: the keyboard is back on the header, under its new name.
            await nameField.fill('General Ops');
            await nameField.press('Enter');
            await dialogGone();
            await waitFor(async () => (await heads())[0] === 'General Ops', 'the new name', 5000).catch(() => {});
            const renamed = await focusedOn();
            check('Rename… confirmed with Enter: renamed, and the keyboard is back on its header', (await heads())[0] === 'General Ops' && renamed.sb === 'testing-out-coordinator' && renamed.self, json({ heads: await heads(), renamed }));
            await choose(general, 'Rename…');
            await nameField.fill('General');
            await nameField.press('Enter');
            await dialogGone();
            await waitFor(async () => (await heads())[0] === 'General', 'the name back', 5000);
            // New category… from General's ⋯: made last of the categories, the keyboard back on General's header.
            await choose(general, 'New category…');
            await nameField.fill('Scratch');
            await nameField.press('Enter');
            await dialogGone();
            await waitFor(async () => (await heads()).includes('Scratch'), 'Scratch in the list', 5000);
            const made = await focusedOn();
            check('New category… confirmed with Enter: made, last of the categories, and the keyboard is back on the header it came from',
                json(await heads()) === json(['General', 'Local Model Recipe', 'Fleet Services', 'Experimentation', 'Scratch', 'Other workspaces']) && made.sb === 'testing-out-coordinator' && made.self,
            json({ heads: await heads(), made }));
            // Deleted by the keyboard: its header goes, and the keyboard is on the header now in its place.
            await choose(page.locator('[data-categories-sb="scratch"]'), 'Delete…');
            const remove = page.getByRole('button', { name: 'Delete category', exact: true });
            await remove.waitFor({ state: 'visible', timeout: 5000 });
            await remove.focus();
            await page.keyboard.press('Enter');
            await dialogGone();
            await waitFor(async () => !(await heads()).includes('Scratch'), 'Scratch gone', 5000);
            await page.waitForTimeout(300);
            const gone = await focusedOn();
            check('Delete… confirmed with Enter: gone, and the keyboard is on the header now in its place (Other workspaces)', gone.sb === '@others' && gone.self, json(gone));
        });

        await section('a long name is cut once, at a word, with the whole name in DSH\'s tooltip; 24 characters are never cut', async () => {
            const general = page.locator('[data-categories-sb="testing-out-coordinator"]');
            const long = 'Local Model Recipe Operations and Tensor Modulation Sweeps';
            const short = 'Experimentation and Labs';
            for (const name of [long, short]) {
                await choose(general, 'New category…');
                await nameField.fill(name);
                await nameField.press('Enter');
                await dialogGone();
            }
            const named = (name) => page.locator('[data-categories-sb]').filter({ has: page.locator(`[data-categories-title="${name}"]`) });
            await named(long).waitFor({ state: 'visible', timeout: 5000 });
            const cut = await named(long).locator('.dshc-sb-name').evaluate((el) => ({ text: el.textContent, mark: el.hasAttribute('data-categories-cut'), over: el.scrollWidth > el.clientWidth }));
            const start = cut.text.slice(0, -1);
            const atWord = cut.text.endsWith('…') && long.startsWith(start) && long[start.length] === ' ';
            await named(long).hover();
            const tip = page.getByRole('tooltip');
            const tipText = await waitFor(async () => ((await tip.count()) > 0 ? (await tip.first().innerText()).trim() : null), 'DSH\'s tooltip on the long name', 5000).catch(() => null);
            await shot(page, shots, 'sidebar-long-name-light');
            await setDark(page, true);
            await shot(page, shots, 'sidebar-long-name-dark');
            await setDark(page, false);
            const whole = await named(short).locator('.dshc-sb-name').evaluate((el) => ({ text: el.textContent, mark: el.hasAttribute('data-categories-cut'), over: el.scrollWidth > el.clientWidth }));
            check('a name too long for its header is cut once, at a word, with "…", the whole name in DSH\'s tooltip',
                atWord && cut.mark && !cut.over && tipText === long, json({ cut, tipText }));
            check('a name of 24 characters shows whole, uncut', short.length === 24 && whole.text === short && !whole.mark && !whole.over, json(whole));
            await page.mouse.move(5, 5);
            for (const name of [long, short]) {
                await choose(named(name), 'Delete…');
                const remove = page.getByRole('button', { name: 'Delete category', exact: true });
                await remove.click();
                await dialogGone();
            }
            await waitFor(async () => (await heads()).length === 5, 'the two gone', 5000);
        });

        await section('the Categories page on its glass card', async () => {
            // Its entry in DSH's sidebar panel list (a button named by its label, with or without the label showing).
            await clickPast(page, page.getByRole('button', { name: 'Categories', exact: true }).first());
            const pageRoot = page.locator('[data-categories-page]');
            await pageRoot.waitFor({ state: 'visible', timeout: 20000 });
            const heading = await pageRoot.locator('h1').innerText();
            const count = await pageRoot.locator('.dshc-pg-count').innerText();
            const rows = await pageRoot.locator('[role="treeitem"][data-categories-node="category"] > .dshc-tree-row .dshc-tree-title').allInnerTexts();
            check('the page: its heading, its count, each category in order with Other workspaces last', heading === 'Categories' && count === '4 categories' && json(rows) === json(['General', 'Local Model Recipe', 'Fleet Services', 'Experimentation', 'Other workspaces']), json({ heading, count, rows }));
            const grounds = await page.evaluate(() => {
                const root = getComputedStyle(document.querySelector('.dshc-page'));
                const card = getComputedStyle(document.querySelector('.dshc-pg-scroll'));
                return { root: root.backgroundColor, card: card.backgroundColor, blur: card.backdropFilter || card.webkitBackdropFilter, radius: card.borderTopLeftRadius };
            });
            check('its root is unpainted and its content sits on one glass card at tint + .2 (DESIGN.md)', grounds.root === 'rgba(0, 0, 0, 0)' && /, 0\.75\)$/.test(grounds.card) && /blur\(22px\)/.test(grounds.blur), json(grounds));
            await shot(page, shots, 'page-light');
            await setDark(page, true);
            const dark = await page.evaluate(() => getComputedStyle(document.querySelector('.dshc-pg-scroll')).backgroundColor);
            check('dark: the card takes the dark glass', /^rgba\(10, 13, 12, 0\.75\)$/.test(dark), dark);
            await shot(page, shots, 'page-dark');
            for (const theme of ['dark', 'light']) {
                await setDark(page, theme === 'dark');
                const worst = await lowestContrast('[data-categories-page]');
                check(`${theme}: every text on the page reaches 4.5:1`, worst.length > 0 && worst[0].ratio >= 4.5, json(worst));
            }
            // Find by name keeps the matches; the tree is one tab stop with ↓ from the box.
            const findBox = pageRoot.locator('input[data-categories-find], [data-categories-find] input').first();
            await findBox.fill('fleet');
            const found = await pageRoot.locator('[role="treeitem"][data-categories-node="category"] > .dshc-tree-row .dshc-tree-title').allInnerTexts();
            check('find by name keeps what matches', json(found) === json(['Fleet Services']), json(found));
            await shot(page, shots, 'page-find-light');
            await findBox.press('Escape');
        });

        await section('a change that can\'t be saved is refused in the window, the page says why, and a page row\'s dialog gives the keyboard back to it', async () => {
            const pageRoot = page.locator('[data-categories-page]');
            const row = pageRoot.locator('[role="treeitem"][data-categories-id="testing-out-coordinator"]');
            await row.waitFor({ state: 'visible', timeout: 5000 });
            check('all well: the page names no trouble with its store', (await pageRoot.locator('[data-categories-store-note]').count()) === 0);
            // Escape from a page row's dialog: the keyboard is back on that row.
            await choose(row, 'Rename…');
            await nameField.waitFor({ state: 'visible', timeout: 5000 });
            await page.keyboard.press('Escape');
            await dialogGone();
            const back = await focusedOn();
            check('on the page, Escape closes Rename… and the keyboard is back on that row', back.row === 'testing-out-coordinator' && back.self, json(back));
            // The store can't be written (a folder where its next copy goes): the rename is refused, and nothing changed.
            const blocker = `${storeFile}.tmp`;
            mkdirSync(blocker);
            try {
                await choose(row, 'Rename…');
                await nameField.fill('Not kept');
                await nameField.press('Enter');
                await refusal.waitFor({ state: 'visible', timeout: 5000 });
                const words = await refusal.innerText();
                const inField = await page.evaluate(() => document.activeElement?.hasAttribute('data-categories-name-input') === true);
                check('a rename that can\'t be saved is refused in the dialog in words, the keyboard in the field',
                    /^Not saved: \S*categories\.json can't be written \(a folder is in the way\), so nothing changed\. Try again once it can be\.$/.test(words) && inField, json({ words, inField }));
                await shot(page, shots, 'page-not-saved-dialog-light');
                await setDark(page, true);
                await shot(page, shots, 'page-not-saved-dialog-dark');
                await setDark(page, false);
                await nameField.focus();
                await page.keyboard.press('Escape');
                await dialogGone();
                const note = pageRoot.locator('[data-categories-store-note="unsaved"]');
                await note.waitFor({ state: 'visible', timeout: 5000 });
                const said = await note.innerText();
                const store = readJson(storeFile);
                check('… the page says it can\'t be saved, as an alert, and the name and the store are as they were',
                    (await note.getAttribute('role')) === 'alert' && /^Not saved: The categories can't be saved in \S*categories\.json \(a folder is in the way\), so a change made now is undone\. Each change tries again\.$/.test(said.replace(/\s+/g, ' ').trim())
                    && (await row.locator(':scope > .dshc-tree-row .dshc-tree-title').innerText()) === 'General' && store.categories?.['testing-out-coordinator']?.name === 'General',
                json({ said, store: store.categories?.['testing-out-coordinator']?.name }));
                await shot(page, shots, 'page-not-saved-light');
                await setDark(page, true);
                await shot(page, shots, 'page-not-saved-dark');
                await setDark(page, false);
            } finally {
                rmSync(blocker, { recursive: true, force: true });
            }
            // Once it can be written, the next change saves, the note goes, and the keyboard is back on the row.
            await choose(row, 'Rename…');
            await nameField.fill('General Ops');
            await nameField.press('Enter');
            await dialogGone();
            await waitFor(async () => (await pageRoot.locator('[data-categories-store-note]').count()) === 0, 'the note to go', 5000).catch(() => {});
            const saved = readJson(storeFile).categories?.['testing-out-coordinator']?.name;
            const after = await focusedOn();
            check('… the next change saves, the note goes, and the keyboard is back on the row', saved === 'General Ops' && (await pageRoot.locator('[data-categories-store-note]').count()) === 0 && after.row === 'testing-out-coordinator' && after.self,
                json({ saved, after }));
            await choose(row, 'Rename…');
            await nameField.fill('General');
            await nameField.press('Enter');
            await dialogGone();
            await waitFor(async () => readJson(storeFile).categories?.['testing-out-coordinator']?.name === 'General', 'the name back', 5000);
        });

        await section('a 760 px window', async () => {
            await page.setViewportSize({ width: 760, height: 900 });
            await page.waitForTimeout(600);
            const fit = await page.evaluate(() => {
                const card = document.querySelector('.dshc-pg-scroll');
                return card ? { scroll: card.scrollWidth, client: card.clientWidth, width: card.getBoundingClientRect().width } : null;
            });
            check('760 px: the page fits without a sideways scroll', Boolean(fit) && fit.scroll <= fit.client + 1, json(fit));
            await shot(page, shots, 'page-760-light');
            await setDark(page, true);
            await shot(page, shots, 'page-760-dark');
            await setDark(page, false);
            await page.setViewportSize({ width: 1280, height: 860 });
            await page.waitForTimeout(600);
        });

        await section('the chip at the top of a chat', async () => {
            // The chat by its title in DSH's list (DSH may have titled it from its reply instead).
            const list = page.locator('[data-slot="sidebar.workspaces"]');
            // Waits for either (the list may still be drawing its rows after the 760 px window).
            const row = list.getByText('Chip check', { exact: true }).or(list.getByText(/Filed under General/));
            await row.first().click();
            const chip = page.locator('[data-categories-chip]');
            await chip.first().waitFor({ state: 'visible', timeout: 20000 });
            const words = await chip.first().innerText();
            const label = await chip.first().getAttribute('aria-label');
            check('a chat in a category shows Category / workspace among DSH\'s header buttons, named for screen readers', /General\s*\/\s*work-a/.test(words) && (await chip.count()) === 1 && /General/.test(label ?? '') && /work-a/.test(label ?? ''), json({ words, label }));
            await shot(page, shots, 'chip-light');
            await setDark(page, true);
            await shot(page, shots, 'chip-dark');
            await setDark(page, false);
        });

        await section('switched off in Plugins it leaves nothing behind; on again, one of everything', async () => {
            const webNow = await signInWeb();
            const off = await webApi(webNow, 'pluginManager/setBundleEnabled', { name: 'dsh-plugin-categories', enabled: false });
            await waitFor(async () => (await page.locator('[data-categories-sb]').count()) === 0, 'the headers to go', 30000).catch(() => {});
            await page.waitForTimeout(800);
            const left = await page.evaluate(() => ({
                sheets: document.querySelectorAll('style[data-plugin="dsh-plugin-categories"]').length,
                marks: [...document.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('data-categories'))).map((el) => el.tagName).slice(0, 5),
                classes: document.querySelectorAll('[class*="dshc-"]').length,
            }));
            const text = await listText();
            check('switched off (as the Plugins page does): no header, mark, class or style sheet of its own is left', off.ok && left.sheets === 0 && left.marks.length === 0 && left.classes === 0, json({ off: off.ok, left }));
            check('… and DSH\'s list shows every workspace, as DSH draws it', Object.values(titles).every((t) => text.includes(t)), text.slice(0, 300));
            await shot(page, shots, 'off-light');
            const on = await webApi(webNow, 'pluginManager/setBundleEnabled', { name: 'dsh-plugin-categories', enabled: true });
            await waitFor(async () => (await heads()).length >= 5, 'the headers to come back', 60000);
            await page.waitForTimeout(800);
            const again = await page.evaluate(() => ({
                sheets: document.querySelectorAll('style[data-plugin="dsh-plugin-categories"]').length,
                general: document.querySelectorAll('[data-categories-sb="testing-out-coordinator"]').length,
            }));
            check('on again: its headers back as they were, one style sheet, nothing doubled', on.ok && again.sheets === 1 && again.general === 1 && json(await heads()) === json(['General', 'Local Model Recipe', 'Fleet Services', 'Experimentation', 'Other workspaces']), json({ on: on.ok, again, heads: await heads() }));
        });

        const ours = win.errors.filter((text) => /categor/i.test(text));
        check('no errors from the plugin in the window', ours.length === 0, ours.join('\n'));
        await win.browser?.close().catch(() => {});
        win = undefined;
    }

    // 7. Its row in the profile, as the user writes it, at DSH's next start. Values of the wrong type: each counts as
    //    its default (the categories still show), the plugin's log warns once for each, in words, and the list names
    //    them for the page. A word that plainly means off ("no", as YAML 1.2 reads an unquoted no) counts as off, said
    //    the same way. Then enabled: false: the list says off, a change is refused in words, and nothing is written
    //    (the store, the log, DSH's workspace order).
    const names = WITH_COORDINATOR ? ['categories', 'session-bridge', 'coordinator'] : ['categories', 'session-bridge'];
    await stopDsh(child);
    const logAt = readText(logFile).length;
    writeProfile(names, '- id: categories\n  config:\n    enabled: "yes"\n    projectsStoreFile: 7\n');
    child = await boot(dsh, 'wrong settings');
    const webWrong = await signInWeb();
    const wrong = await waitFor(async () => { const r = await webApi(webWrong, 'dsh-plugin-categories/list', {}); return r.ok ? r : null; }, 'the list with wrong settings', 30000);
    const warned = readText(logFile).slice(logAt).split('\n').filter(Boolean).map((line) => line.replace(/^\S+ /, ''));
    check('settings of the wrong type count as their defaults: the categories show, and the list names both for the page',
        json(wrong.value?.categories?.map((c) => c.name)) === json(['General', 'Local Model Recipe', 'Fleet Services', 'Experimentation']) && json((wrong.value?.problems ?? []).map((p) => p.key)) === json(['enabled', 'projectsStoreFile']),
        json({ categories: wrong.value?.categories?.map((c) => c.name), problems: wrong.value?.problems }));
    check('… and the plugin\'s log warns once for each, in words',
        warned.filter((line) => line.startsWith('warn a setting is wrong: ')).length === 2
        && warned.includes('warn a setting is wrong: enabled must be true or false, but it is "yes"; it counts as true until you change it')
        && warned.includes('warn a setting is wrong: projectsStoreFile must be a file path, or empty to skip the move from the projects plugin, but it is 7; ~/.dsh/projects/projects.json is used until you change it'),
        warned.join('\n'));
    const orderKept = await dshOrder();
    await stopDsh(child);
    const storeNo = readText(storeFile);
    const logNo = readText(logFile).length;
    writeProfile(names, '- id: categories\n  config:\n    enabled: "no"\n');
    child = await boot(dsh, 'enabled: no');
    const webNo = await signInWeb();
    const noList = await waitFor(async () => { const r = await webApi(webNo, 'dsh-plugin-categories/list', {}); return r.ok ? r : null; }, 'the list with enabled: no', 30000);
    const noLines = readText(logFile).slice(logNo).split('\n').filter(Boolean).map((line) => line.replace(/^\S+ /, ''));
    check('enabled: no (a word that means off) counts as off: the list says off and names it; the log warns once; the store and DSH\'s order untouched',
        noList.value?.off === true && noList.value.categories.length === 0 && json((noList.value.problems ?? []).map((p) => p.text)) === json(['enabled must be true or false, but it is "no"; it counts as false until you change it'])
        && json(noLines) === json(['warn a setting is wrong: enabled must be true or false, but it is "no"; it counts as false until you change it'])
        && readText(storeFile) === storeNo && json(await dshOrder()) === json(orderKept),
    json({ off: noList.value?.off, problems: noList.value?.problems, lines: noLines }));
    await stopDsh(child);
    const storeKept = readText(storeFile);
    const logKept = readText(logFile);
    writeProfile(names, '- id: categories\n  config:\n    enabled: false\n');
    child = await boot(dsh, 'switched off in its row');
    const webOff = await signInWeb();
    const offList = await waitFor(async () => { const r = await webApi(webOff, 'dsh-plugin-categories/list', {}); return r.ok ? r : null; }, 'the list switched off', 30000);
    const refused = await webApi(webOff, 'dsh-plugin-categories/createCategory', { name: 'Not now' });
    check('enabled: false: the list says off and shows no category; a change is refused in words',
        offList.value?.off === true && offList.value.categories.length === 0 && !refused.ok && refused.error?.code === 'categories/off' && /switched off/.test(refused.error?.message ?? ''),
        json({ off: offList.value, refused: refused.error }));
    await sleep(500);
    check('… and writes nothing: the store and the log as they were, DSH\'s workspace order untouched',
        readText(storeFile) === storeKept && readText(logFile) === logKept && json(await dshOrder()) === json(orderKept),
        json({ store: readText(storeFile) === storeKept, log: readText(logFile).slice(logKept.length), order: json(await dshOrder()) === json(orderKept) }));

    // 8. A store that can't be used (cut off mid-write by hand, say), at DSH's next start: the plugin starts with no
    //    categories, its log and the Categories page say so, the file stays as it was, and the first change (made on
    //    the page) keeps it beside the new store, which the page names.
    await stopDsh(child);
    writeProfile(names);
    const broken = '{"version": 1, "categories": {"cut-off';
    writeFileSync(storeFile, broken);
    const logBad = readText(logFile).length;
    child = await boot(dsh, 'an unusable store');
    const webBad = await signInWeb();
    const empty = await waitFor(async () => { const r = await webApi(webBad, 'dsh-plugin-categories/list', {}); return r.ok ? r : null; }, 'the list over an unusable store', 30000);
    const badLines = readText(logFile).slice(logBad).split('\n').filter(Boolean).map((line) => line.replace(/^\S+ /, ''));
    check('a store that can\'t be used: the plugin starts with no categories, its log says so, and the file is left as it was',
        empty.value?.categories?.length === 0 && readText(storeFile) === broken && empty.value?.store?.problem === 'unusable'
        && badLines.includes(`warn the store ${storeFile} is not JSON: the categories start empty, and the file as it was is kept beside it before a change writes a new one`),
        json({ categories: empty.value?.categories?.length, lines: badLines }));
    let made;
    if (pw) {
        const link = [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1];
        win = await openWindow({ signIn: async () => ({ link }) }, pw, { entry: 'Categories', width: 1280, height: 860 });
        const { page } = win;
        await dismissNotices(page).catch(() => {});
        await clickPast(page, page.getByRole('button', { name: 'Categories', exact: true }).first());
        const note = page.locator('[data-categories-page] [data-categories-store-note]');
        await note.waitFor({ state: 'visible', timeout: 20000 });
        const said = (await note.innerText()).replace(/\s+/g, ' ').trim();
        check('… and the Categories page says so, as an alert: the file, why, and that it is kept at the first change',
            (await note.getAttribute('data-categories-store-note')) === 'unusable' && (await note.getAttribute('role')) === 'alert'
            && /^The categories file couldn't be used: \S*categories\.json is not JSON, so the categories started empty\. The file is left as it is: the first change keeps it beside the new store, to put back by hand\.$/.test(said),
        json(said));
        await shot(page, shots, 'page-store-unusable-light');
        await setDark(page, true);
        await shot(page, shots, 'page-store-unusable-dark');
        await setDark(page, false);
        // The first change, made on the page: New category.
        await clickPast(page, page.locator('[data-categories-new]'));
        const field = page.locator('[data-categories-name-input]');
        await field.waitFor({ state: 'visible', timeout: 5000 });
        await field.fill('Fresh');
        await field.press('Enter');
        await page.getByRole('dialog').first().waitFor({ state: 'hidden', timeout: 5000 });
        await waitFor(async () => ((await note.getAttribute('data-categories-store-note').catch(() => null)) === 'kept' ? true : null), 'the note to name the kept file', 10000).catch(() => {});
        const keptSaid = (await note.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        const keptName = readdirSync(categoriesDir).find((name) => name.startsWith('categories.json.unreadable-')) ?? '(none)';
        check('… a category made on the page keeps the file beside the new store, and the page names it there',
            new RegExp(`^The categories file couldn't be used: \\S*categories\\.json is not JSON at the start, so the categories started empty\\. It is kept as ${keptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} in the same folder: put it back by hand, with DSH stopped, to bring them back\\.$`).test(keptSaid)
            && (await page.locator('[data-categories-page] [role="treeitem"][data-categories-node="category"] > .dshc-tree-row .dshc-tree-title').allInnerTexts()).includes('Fresh'),
        json({ keptSaid, keptName }));
        await shot(page, shots, 'page-store-kept-light');
        await setDark(page, true);
        await shot(page, shots, 'page-store-kept-dark');
        await setDark(page, false);
        const ours = win.errors.filter((text) => /categor/i.test(text));
        check('… no errors from the plugin in that window', ours.length === 0, ours.join('\n'));
        await win.browser?.close().catch(() => {});
        win = undefined;
        made = { ok: true };
    } else {
        made = await webApi(webBad, 'dsh-plugin-categories/createCategory', { name: 'Fresh' });
    }
    const keptFiles = readdirSync(categoriesDir).filter((name) => name.startsWith('categories.json.unreadable-'));
    check('… and the first change keeps it beside the new store (mode 600), then writes the new one',
        made.ok && keptFiles.length === 1 && readText(join(categoriesDir, keptFiles[0])) === broken && (statSync(join(categoriesDir, keptFiles[0])).mode & 0o777) === 0o600
        && JSON.parse(readText(storeFile)).categories?.fresh?.name === 'Fresh',
        json({ made: made.ok, keptFiles }));

    // 9. Beside Wallpaper, as on the user's DSH (its commit, copied read only): the Categories page keeps an
    //    unpainted root and one glass card with one blur; Wallpaper's glass for the page's old root class falls on
    //    nothing. Pictures light and dark.
    const wallpaper = pw ? wallpaperCopy() : null;
    if (!pw) console.log('skipped: beside Wallpaper (no window)');
    else if (!wallpaper) console.log('skipped: beside Wallpaper (not found: set WALLPAPER_DIR, or WALLPAPER_REPO and WALLPAPER_REV)');
    else {
        await stopDsh(child);
        writeProfile([...names, { name: 'wallpaper', dir: wallpaper }]);
        child = await boot(dsh, 'beside Wallpaper');
        const link = [...readText(dshLog).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1];
        win = await openWindow({ signIn: async () => ({ link }) }, pw, { entry: 'Categories', width: 1280, height: 860 });
        const { page } = win;
        await waitFor(() => page.evaluate(() => document.body.classList.contains('wp-on')), 'Wallpaper on', 30000);
        await dismissNotices(page).catch(() => {});
        await clickPast(page, page.getByRole('button', { name: 'Categories', exact: true }).first());
        await page.locator('[data-categories-page]').waitFor({ state: 'visible', timeout: 20000 });
        await page.waitForTimeout(600);
        const look = () => page.evaluate(() => {
            const root = document.querySelector('[data-categories-page]');
            const blurOf = (el) => { const cs = getComputedStyle(el); const f = cs.backdropFilter || cs.webkitBackdropFilter || 'none'; return f === 'none' ? null : f; };
            const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
            const inside = [root, ...root.querySelectorAll('*')].filter((el) => blurOf(el)).map(name);
            const above = [];
            for (let el = root.parentElement; el && el !== document.body; el = el.parentElement) if (blurOf(el)) above.push(name(el));
            const rs = getComputedStyle(root);
            const card = getComputedStyle(document.querySelector('.dshc-pg-scroll'));
            return {
                on: document.body.classList.contains('wp-on'), root: rs.backgroundColor, rootBorder: rs.borderTopWidth, rootRadius: rs.borderTopLeftRadius,
                inside, above, old: document.querySelectorAll('.dshc-pg').length, card: card.backgroundColor, cardBlur: card.backdropFilter || card.webkitBackdropFilter,
            };
        });
        const light = await look();
        await shot(page, shots, 'wallpaper-page-light');
        await setDark(page, true);
        await page.waitForTimeout(400);
        const dark = await look();
        await shot(page, shots, 'wallpaper-page-dark');
        await setDark(page, false);
        const one = (l) => l.on && l.root === 'rgba(0, 0, 0, 0)' && l.rootBorder === '0px' && l.old === 0 && l.inside.length === 1 && l.above.length === 0 && /blur\(/.test(l.cardBlur);
        check('beside Wallpaper: the page\'s root stays unpainted and unframed, its content on one glass card, blurred once (light and dark)', one(light) && one(dark), json({ light, dark }));
        const ours = win.errors.filter((text) => /categor/i.test(text));
        check('beside Wallpaper: no errors from the plugin in the window', ours.length === 0, ours.join('\n'));
        await win.browser?.close().catch(() => {});
        win = undefined;
    }
} catch (error) {
    failed += 1;
    console.log(`not ok - e2e aborted: ${error?.stack ?? error}`);
    // The window as it was (a picture, and the dialogs open in it), when one was open.
    if (win?.page) {
        console.log(`# dialogs open in the window: ${json(await openDialogs(win.page))}`);
        await shot(win.page, shots, 'failed-aborted').catch(() => {});
    }
    // DSH's last lines, without its sign-in links (they carry a token).
    console.log(readText(dshLog).split('\n').filter((l) => !l.includes('dsh web: ')).slice(-40).join('\n'));
} finally {
    await win?.browser?.close().catch(() => {});
    await stopDsh(child);
    await model.close?.();
    if (process.env.KEEP === '1') console.log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
