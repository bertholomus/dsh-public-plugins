/**
 * The real-DSH test bench for the Discord plugin.
 *
 * A DSH from the test runtimes (`.e2e/dsh-<version>`, DSH_E2E_DIR, or the
 * suite's), or the installed app's own DSH, runs in a throwaway DSH_HOME with
 * this repository linked into its web profile and a scripted model on this
 * computer (fake-model.mjs). The plugin talks to a fake Discord on 127.0.0.1
 * (test/support/fake-discord.mjs) with a made-up token: nothing here reaches
 * the real Discord, reads the live bot token, or reads or writes ~/.dsh, and
 * nothing stops a process this bench did not start (it signals only its own
 * DSH's process group).
 *
 * @module test/e2e/harness
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Where test runtimes may live: this repository's .e2e, DSH_E2E_DIR, then the plugin suite's (the same layout). */
export function runtimeDirs() {
    return [join(repoRoot, '.e2e'), process.env.DSH_E2E_DIR, join(homedir(), 'Projects', 'dsh-plugin-suite', '.e2e')].filter(Boolean);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn` returns something truthy; throws, naming `what`, after `timeout` ms. */
export async function waitFor(fn, what, timeout = 30000, every = 150) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        await sleep(every);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

/**
 * The DSH builds to test on: the runtimes installed for these tests
 * (`npm i --prefix .e2e/dsh-<v> @deepseek-ai/dsh@<v>`, see
 * scripts/e2e-install.mjs), oldest first, from the first folder of
 * runtimeDirs() that has any, then the DSH inside the installed app
 * (DSH_APP, else /Applications/DeepSeek Harness.app), which its own binary
 * runs as Node (`node` and `env` say how). The app's DSH runs as a separate
 * process in a throwaway home, as the test runtimes do; the running app is
 * never touched.
 */
export function runtimes() {
    let found = [];
    for (const base of runtimeDirs()) {
        let names = [];
        try {
            names = readdirSync(base).filter((n) => /^dsh-\d/.test(n)).sort();
        } catch {}
        found = names
            .map((n) => ({ version: n.slice(4), bin: join(base, n, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') }))
            .filter((r) => existsSync(r.bin));
        if (found.length > 0) break;
    }
    const app = appRuntime();
    return app ? [...found, app] : found;
}

/** The installed app's DSH, or undefined when there is no app (or its DSH cannot be read). */
function appRuntime() {
    const app = process.env.DSH_APP || '/Applications/DeepSeek Harness.app';
    const node = join(app, 'Contents', 'MacOS', 'DeepSeek Harness');
    const asar = join(app, 'Contents', 'Resources', 'app.asar');
    if (!existsSync(node) || !existsSync(asar)) return undefined;
    const pkg = join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh');
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    try {
        const version = execFileSync(node, ['-p', `require(${JSON.stringify(join(pkg, 'package.json'))}).version`], {
            encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return version ? { version: `app-${version}`, bin: join(pkg, 'lib', 'bin.js'), node, env } : undefined;
    } catch {
        return undefined;
    }
}

/** The DSH to run: DSH_BIN, else the newest test runtime (the app's DSH needs its own binary, so only with DSH_BIN). */
export function dshBin() {
    return process.env.DSH_BIN || runtimes().filter((r) => !r.node).at(-1)?.bin;
}

/** Pass and fail lines in TAP's words, and a step that turns a throw into a failed check. */
export function checks({ redact = (text) => text } = {}) {
    const out = { passed: 0, failed: 0, failures: [] };
    out.check = (name, ok, detail = '') => {
        if (ok) {
            out.passed += 1;
            console.log(`ok - ${name}`);
        } else {
            out.failed += 1;
            out.failures.push(name);
            console.log(`not ok - ${name}${detail ? `\n    ${redact(String(detail)).slice(0, 2000)}` : ''}`);
        }
        return Boolean(ok);
    };
    out.step = async (name, run, onFail) => {
        try {
            await run();
        } catch (error) {
            out.check(name, false, error?.stack ?? error);
            try {
                await onFail?.(error);
            } catch {}
        }
    };
    return out;
}

const readText = (file) => {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return '';
    }
};

export const modeOf = (file) => statSync(file).mode & 0o777;

/** The frames of a zstd file: DSH appends one frame per write, and Node's decoder reads only the first. */
function zstdFrames(buf) {
    const out = [];
    let at = 0;
    while (at + 4 <= buf.length) {
        const magic = buf.readUInt32LE(at);
        if ((magic & 0xfffffff0) === 0x184d2a50) {
            at += 8 + buf.readUInt32LE(at + 4);
            continue;
        }
        if (magic !== 0xfd2fb528) break;
        const fhd = buf[at + 4];
        const single = (fhd >> 5) & 1;
        let p = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [single ? 1 : 0, 2, 4, 8][fhd >> 6];
        for (;;) {
            const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
            p += 3 + (((header >> 1) & 3) === 1 ? 1 : header >>> 3);
            if (header & 1) break;
        }
        if ((fhd >> 2) & 1) p += 4;
        out.push(buf.subarray(at, p));
        at = p;
    }
    return out;
}

/**
 * The environment DSH gets: this process's, without any Discord variable
 * (so no live bot token can reach the test DSH by inheritance), plus the
 * throwaway home and the scripted model's key.
 */
export function dshEnv(home, extra = {}) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!/discord/i.test(key)) env[key] = value;
    const local = '127.0.0.1,localhost';
    return { ...env, DSH_HOME: home, FAKE_LLM_KEY: 'sk-fake', DSH_TELEMETRY_DISABLED: '1', NO_PROXY: local, no_proxy: local, ...extra };
}

/**
 * One DSH under test: its throwaway home, web profile and process.
 *
 *     const run = new DshRun({ label: 'discord', bin, plugins: { 'dsh-plugin-discord': repoRoot }, rows });
 *     run.writeProfile(model.port);
 *     await run.boot('first start');
 */
export class DshRun {
    /**
     * @param {{ label: string, bin: string, plugins: Record<string, string>, rows?: string, env?: Record<string, string>, port?: number }} options
     *   plugins: package name → folder, linked into the web profile; rows: more cordis.patch.yml rows (YAML, one level in);
     *   port: the window's port, the same after each restart; any free one without.
     */
    constructor({ label, bin, plugins, rows = '', env = {}, port = 0 }) {
        this.label = label;
        this.dsh = bin.endsWith('.js') ? [process.execPath, bin] : [bin];
        this.plugins = plugins;
        this.rows = rows;
        this.env = env;
        this.port = port;
        this.root = mkdtempSync(join(tmpdir(), `dsh-${label}-e2e-`));
        this.home = join(this.root, 'home');
        this.ws = join(this.root, 'ws');
        mkdirSync(this.ws, { recursive: true });
        this.log = join(this.root, 'dsh.log');
        this.child = undefined;
        this.web = undefined;
        this.starts = 0;
        // Never into the DSH you use: the bench's home is its own.
        const live = join(homedir(), '.dsh');
        if (this.home === live || this.home.startsWith(`${live}/`)) throw new Error('the test home may not be ~/.dsh');
        process.once('exit', () => this.killTree());
    }

    get profile() {
        return join(this.home, 'profiles', 'web');
    }

    /** The web profile with the plugins linked in, and its patch: the scripted model and `rows`. */
    writeProfile(modelPort, { models = ['fake-model'] } = {}) {
        const profile = this.profile;
        rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
        mkdirSync(join(profile, 'node_modules'), { recursive: true });
        writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
            name: 'dsh-profile-web',
            private: true,
            dependencies: Object.fromEntries(Object.entries(this.plugins).map(([name, dir]) => [name, `link:${dir}`])),
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(this.plugins)] } },
        }, null, 2)}\n`);
        for (const [name, dir] of Object.entries(this.plugins)) symlinkSync(dir, join(profile, 'node_modules', name), 'dir');
        const modelRows = models.map((id) => `          - id: ${id}
            name: ${id}
            contextWindow: 131072
            reasoningEfforts: false`).join('\n');
        writeFileSync(join(profile, 'cordis.patch.yml'), `- id: agent-default-model
  config:
    provider: fake
    model: ${models[0]}
- id: llm-pi-ai
  config:
    providers:
      fake:
        displayName: Fake
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        apiKeyEnv: FAKE_LLM_KEY
        models:
${modelRows}
${this.rows}`);
    }

    /** The profile's patch as written (for a check that it points only at this computer). */
    patchText() {
        return readText(join(this.profile, 'cordis.patch.yml'));
    }

    /** Start DSH in its own process group (so a crash can take its whole tree, as a power cut would). */
    start() {
        const out = openSync(this.log, 'a');
        this.child = spawn(this.dsh[0], [...this.dsh.slice(1), '--profile', 'web', '--no-open', '--port', String(this.port)], {
            cwd: this.ws,
            env: dshEnv(this.home, this.env),
            stdio: ['ignore', out, out],
            detached: true,
        });
        closeSync(out);
        this.starts += 1;
        return this.child;
    }

    signIns() {
        return [...readText(this.log).matchAll(/dsh web: (\S+)/g)].length;
    }

    signInLink() {
        return [...readText(this.log).matchAll(/dsh web: (\S+)/g)].at(-1)?.[1] ?? '';
    }

    /** Start DSH and wait until its window is up, and `ready` when given (a line in DSH's log, or a function that turns true). */
    async boot(what = 'start', ready) {
        const before = this.signIns();
        const logBefore = readText(this.log).length;
        this.start();
        try {
            await waitFor(() => this.signIns() > before, `the web sign-in link (${what})`, 120000);
            if (typeof ready === 'function') await waitFor(ready, `the plugin to be ready (${what})`, 60000);
            else if (ready) await waitFor(() => ready.test(readText(this.log).slice(logBefore)), `${ready} in DSH's log (${what})`, 60000);
        } catch (error) {
            await this.stop();
            throw error;
        }
        this.web = undefined;
        return this.child;
    }

    /** DSH's log since `from` (a length of logText()). */
    logSince(from = 0) {
        return readText(this.log).slice(from);
    }

    alive() {
        return Boolean(this.child) && this.child.exitCode === null && this.child.signalCode === null;
    }

    /** Stop DSH the way a person quits it: SIGTERM, then SIGKILL after 20 s. */
    async stop() {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        const timer = setTimeout(() => this.killTree(), 20000);
        await exited;
        clearTimeout(timer);
        this.killTree();
    }

    /** A crash: SIGKILL to DSH's whole process group, with no chance to save anything. */
    async crash() {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((r) => child.once('exit', r));
        this.killTree();
        await exited;
    }

    /** SIGKILL to the process group this bench started (and only that one). */
    killTree() {
        const pid = this.child?.pid;
        if (!pid) return;
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {}
    }

    logText() {
        return readText(this.log);
    }

    /** The sessions DSH lists in its window (the window's own call). */
    async sessions() {
        const r = await this.api('session/list', { _request: {} }); // the window's call: its one argument is named _request
        if (!r?.ok) throw new Error(`session/list: ${JSON.stringify(r?.error ?? r).slice(0, 300)}`);
        const value = r.value;
        return Array.isArray(value) ? value : value?.sessions ?? value?.items ?? [];
    }

    /** A session's events as DSH saved them in its log on disk (readable while DSH runs, too). */
    savedEvents(sessionId) {
        const found = [];
        const walk = (dir, depth) => {
            let names = [];
            try {
                names = readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const d of names) {
                const p = join(dir, d.name);
                if (d.isDirectory() && depth < 3) walk(p, depth + 1);
                else if (/^session\.v\d+\.jsonl\.zstd$/.test(d.name) && dir.endsWith(sessionId)) found.push(p);
            }
        };
        walk(join(this.home, 'sessions'), 0);
        const out = [];
        for (const file of found) {
            try {
                const text = zstdFrames(readFileSync(file)).map((frame) => zstdDecompressSync(frame).toString('utf8')).join('');
                for (const line of text.split('\n')) if (line.trim()) out.push(JSON.parse(line));
            } catch {}
        }
        return out;
    }

    /** Signed in to the window: its base address and cookie. */
    async signIn() {
        if (this.web) return this.web;
        const link = this.signInLink();
        const got = await httpGet(link);
        const cookie = String(got.headers['set-cookie']?.[0] ?? '').split(';')[0];
        this.web = { base: new URL('./', link), cookie, link };
        return this.web;
    }

    /**
     * DSH's prompts as an open window gets them: its events stream on
     * /api/remote.mux brings each approval and question-box request, and
     * $events/result answers one, as the window's own card does. With no
     * window open, DSH answers an approval "unavailable" at once, so a test
     * that needs one to wait opens this first.
     */
    async prompts() {
        const web = await this.signIn();
        const url = new URL('api/remote.mux', web.base);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url, { headers: { cookie: web.cookie, origin: web.base.origin } });
        const asked = [];
        let clientId;
        let failure;
        socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })));
        socket.addEventListener('error', (event) => { failure = event.message ?? 'socket error'; });
        socket.addEventListener('message', ({ data }) => {
            let frame;
            try { frame = JSON.parse(String(data)); } catch { return; }
            if (frame.streamId !== 'events') return;
            if (frame.type === 'error') failure = JSON.stringify(frame.error);
            const value = frame.type === 'item' ? frame.value : undefined;
            if (value?.type === 'ready') clientId = value.clientId;
            else if (value?.type === 'waterfall') asked.push(value);
        });
        await waitFor(() => {
            if (failure) throw new Error(failure);
            return clientId;
        }, 'the stand-in window\'s events stream');
        return {
            asked,
            /** The window's prompt for a request that matches. */
            find: (event, match) => asked.find((a) => a.event === event && match(a.request ?? {})),
            answer: (prompt, outcome) => this.api('$events/result', { clientId, eventId: prompt.eventId, outcome: { kind: 'result', value: outcome } }),
            close: () => socket.close(),
        };
    }

    /** Call a window endpoint (`<namespace>/<method>`) as the window does: `{ ok, value }` or `{ ok: false, error }`. */
    async api(endpoint, args = {}) {
        const web = await this.signIn();
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
                    try {
                        result = JSON.parse(text).result;
                    } catch {}
                    resolvePromise(result ?? { ok: false, error: { code: `http/${res.statusCode}`, message: text.slice(0, 300) } });
                });
            });
            req.setTimeout(60000, () => req.destroy(new Error(`${endpoint}: no answer in 60 s`)));
            req.on('error', reject);
            req.end(body);
        });
    }

    /** The browser half DSH serves for `bundle`: its address, status and text. */
    async clientOf(bundle) {
        const web = await this.signIn();
        const app = await httpGet(web.base.href, { cookie: web.cookie });
        const url = new RegExp(`"id":"${bundle}","url":"([^"]+)"`).exec(app.text)?.[1];
        if (!url) return { url: undefined, status: 0, text: '' };
        const client = await httpGet(new URL(url, web.base).href, { cookie: web.cookie });
        return { url, status: client.status, text: client.text };
    }

    /** Remove the throwaway folders (KEEP=1 keeps them, and says where). */
    cleanup() {
        if (process.env.KEEP === '1') {
            console.log(`# kept ${this.root}`);
            return;
        }
        rmSync(this.root, { recursive: true, force: true });
    }
}

/** A port no one listens on now, for a DshRun that must keep its address across restarts. */
export async function freePort() {
    const server = createServer();
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const { port } = server.address();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    return port;
}

export function httpGet(url, headers = {}) {
    return new Promise((resolvePromise, reject) => {
        const req = request(url, { headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, text }));
        });
        req.setTimeout(60000, () => req.destroy(new Error(`GET ${url}: no answer in 60 s`)));
        req.on('error', reject);
        req.end();
    });
}

// ── The window ────────────────────────────────────────────────────────

/** Playwright: PLAYWRIGHT_MODULE, else a copy in a runtime folder's tools/, else an installed playwright or playwright-core; null without. */
export async function findPlaywright() {
    const tries = [
        process.env.PLAYWRIGHT_MODULE,
        ...runtimeDirs().map((dir) => join(dir, 'tools', 'node_modules', 'playwright-core', 'index.mjs')),
        'playwright',
        'playwright-core',
    ].filter(Boolean);
    for (const name of tries) {
        try {
            if (name.startsWith('/') && !existsSync(name)) continue;
            const spec = name.startsWith('/') || name.startsWith('.') ? pathToFileURL(resolve(name)).href : name;
            const mod = await import(spec);
            const pw = mod.chromium ? mod : mod.default;
            if (pw?.chromium) return pw;
        } catch {}
    }
    return null;
}

/** A Chromium: CHROMIUM, else Playwright's own. */
export function launchChromium(pw) {
    const args = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-gpu-rasterization'];
    return pw.chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args });
}

/** DSH's first-run notices, out of the way: whether there was one. */
export async function dismissNotices(page) {
    let found = false;
    for (const label of ['Continue', 'Got it', 'OK']) {
        const button = page.getByRole('button', { name: label, exact: true });
        if (await button.count()) {
            found = true;
            await button.first().click().catch(() => {});
            await page.waitForTimeout(300);
        }
    }
    return found;
}

/**
 * The window signed in, with `entry` (a sidebar entry's name) showing and the
 * first-run notices out of the way (they can come seconds late, so the
 * window is watched until none has come for a few seconds).
 */
export async function openWindow(run, pw, { entry, width = 1280, height = 860, colorScheme = 'light', timezoneId = 'America/Los_Angeles' } = {}) {
    const web = await run.signIn();
    const browser = await launchChromium(pw);
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', colorScheme, timezoneId });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(web.link, { waitUntil: 'domcontentloaded' });
    if (entry) await page.getByRole('button', { name: entry, exact: true }).first().waitFor({ state: 'visible', timeout: 90000 });
    const end = Date.now() + 30000;
    let calm = Date.now();
    while (Date.now() < end && Date.now() - calm < 4000) {
        if (await dismissNotices(page)) calm = Date.now();
        await page.waitForTimeout(400);
    }
    return { browser, context, page, errors };
}

/** DSH's light or dark theme, as the system setting would choose it. */
export async function setDark(page, dark) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await waitFor(() => page.evaluate((want) => document.body.hasAttribute('data-ds-dark-theme') === want, dark), `DSH's ${dark ? 'dark' : 'light'} theme`, 10000).catch(() => {});
}

/** A picture of the window (or of `locator`) once its animations have settled; nothing without a folder. */
export async function shot(page, folder, name, locator) {
    if (!folder) return undefined;
    mkdirSync(folder, { recursive: true });
    await page.waitForTimeout(250);
    await Promise.race([
        page.evaluate(() => Promise.all(document.getAnimations()
            .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})))),
        page.waitForTimeout(2000),
    ]).catch(() => {});
    const path = join(folder, `${name}.png`);
    await (locator ?? page).screenshot({ path, ...(locator ? {} : { fullPage: false }) });
    return path;
}

/** The live DSH's fingerprint (pid, start, patch hash), read-only, from the DSH Test tool; undefined without it. */
export function liveFingerprint() {
    const tool = join(homedir(), '.local', 'bin', 'dsh-test');
    if (!existsSync(tool)) return undefined;
    try {
        const text = execFileSync(tool, ['fingerprint'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
        const json = /\{[\s\S]*\}/.exec(text)?.[0];
        return json ? JSON.parse(json) : undefined;
    } catch {
        return undefined;
    }
}
