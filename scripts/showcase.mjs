#!/usr/bin/env node
/**
 * The plugins' showcase pictures, made again from scratch: each plugin's
 * scene (scripts/showcase/scenes/<plugin>.mjs) stages a believable demo in a
 * real DSH from the test bench, with the demo model and the demo projects
 * (scripts/showcase/stage.mjs), and takes its views, dark and light, into
 * docs/screenshots/<plugin>/<view>-<theme>.png. Nothing reads or writes your
 * own ~/.dsh, and the live DSH's fingerprint is read before and after.
 *
 *   npm run showcase                       every plugin
 *   npm run showcase -- autopilot proof    those plugins only
 *   npm run showcase -- --dsh 0.2.1-rc.1   on that DSH (default: the installed app's, else the newest under .e2e/)
 *
 * KEEP=1 keeps each throwaway folder. SHOWCASE_PRIVATE=name,name adds words
 * that must never show, such as the names of your other machines. Exits 1 when a scene fails, a picture
 * shows a word that must never show (see FORBIDDEN in stage.mjs), the demo
 * model met a message its script does not cover, or the live DSH moved.
 */
import { spawn } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPlaywright, liveFingerprint, pluginsDir, runtimes } from '../test/e2e/harness.mjs';
import { startDemoModel } from './showcase/demo-model.mjs';
import { capture, dropOthers, here, openShowcaseWindow, repoRoot, setTheme, shotsDir, ShowcaseRun } from './showcase/stage.mjs';

const args = process.argv.slice(2);
const only = args.includes('--dsh') ? args[args.indexOf('--dsh') + 1] : undefined;
const sceneNames = readdirSync(join(here, 'scenes')).filter((n) => n.endsWith('.mjs')).map((n) => n.slice(0, -4)).sort();
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--dsh');
for (const name of wanted) {
    if (!sceneNames.includes(name)) {
        console.error(`no scene for ${name} (scenes: ${sceneNames.join(', ')})`);
        process.exit(2);
    }
}

async function main() {
    const bin = process.env.DSH_BIN;
    const version = process.env.DSH_LABEL ?? 'DSH_BIN';
    const pw = await findPlaywright();
    if (!pw) {
        console.error('no Playwright: npm i --prefix .e2e/tools playwright-core (or set PLAYWRIGHT_MODULE)');
        process.exit(2);
    }
    const script = JSON.parse(readFileSync(join(here, 'demo.json'), 'utf8'));
    const short = (f) => (f ? `pid ${f.pid}, patch ${String(f.patchSha256).slice(0, 16)}` : 'unknown (no dsh-test)');
    const before = liveFingerprint();
    console.log(`# DSH ${version}\n# live DSH before: ${short(before)}`);

    const report = [];
    const results = [];
    for (const name of wanted.length ? wanted : sceneNames) {
        const started = Date.now();
        const scene = new Scene({ name, bin, pw, script, report });
        let error;
        try {
            const { default: play } = await import(join(here, 'scenes', `${name}.mjs`));
            await play(scene);
        } catch (e) {
            error = e;
            console.log(`# ${name}: FAILED: ${e?.stack ?? e}`);
        } finally {
            await scene.close();
        }
        const gone = error ? [] : dropOthers(name, scene.files);
        results.push({ name, ok: !error, pictures: scene.files.length, misses: scene.misses, gone, seconds: Math.round((Date.now() - started) / 1000) });
    }

    const after = liveFingerprint();
    const same = Boolean(before && after) && before.pid === after.pid && before.patchSha256 === after.patchSha256 && before.started === after.started;
    const flagged = report.filter((r) => r.hits.length > 0);
    console.log('\n# summary');
    for (const r of results) {
        console.log(`# ${r.name}: ${r.ok ? 'ok' : 'FAILED'}, ${r.pictures} pictures (${r.seconds} s)${r.misses.length ? `, unscripted: ${r.misses.join(' | ')}` : ''}${r.gone.length ? `, removed ${r.gone.join(', ')}` : ''}`);
    }
    for (const r of flagged) console.log(`# check ${r.file}: ${r.hits.map((h) => h.what).join(', ')}`);
    const big = report.filter((r) => r.bytes > 700 * 1024);
    for (const r of big) console.log(`# over 700 KB: ${r.file} (${Math.round(r.bytes / 1024)} KB)`);
    const total = report.reduce((s, r) => s + r.bytes, 0);
    console.log(`# ${report.length} pictures, ${(total / 1024 / 1024).toFixed(1)} MB this run`);
    console.log(`# live DSH after: ${short(after)} — ${same ? 'unchanged' : before && after ? 'CHANGED' : 'not checked'}`);
    writeFileSync(join(shotsDir, '.last-run.json'), `${JSON.stringify({ version, results, report }, null, 2)}\n`);
    const ok = results.every((r) => r.ok && r.misses.length === 0) && flagged.length === 0 && big.length === 0 && (same || !before);
    process.exit(ok ? 0 : 1);
}

/** What a scene works with: its DSH and model, its window, and its pictures. */
class Scene {
    constructor({ name, bin, pw, script, report }) {
        Object.assign(this, { name, bin, pw, script, report });
        this.files = [];
        this.misses = [];
        this.run = undefined;
        this.model = undefined;
        this.window = undefined;
    }

    /**
     * DSH with these plugins (folder names under plugins/; the session bridge
     * is always there) and profile rows. `files` maps a path in the demo home
     * to a file or folder of this repo, copied there before DSH starts;
     * `before(run)` runs after that, before DSH starts. `vars` fills each
     * `{{name}}` in this scene's demo script (a day the scene picked, an id).
     */
    async start({ plugins, rows = '', model = {}, env = {}, files = {}, before, vars = {} }) {
        const names = ['session-bridge', ...plugins.filter((p) => p !== 'session-bridge')];
        const linked = Object.fromEntries(names.map((p) => [JSON.parse(readFileSync(join(pluginsDir, p, 'package.json'), 'utf8')).name, join(pluginsDir, p)]));
        this.run = new ShowcaseRun({ label: this.name, bin: this.bin, plugins: linked, rows, model, env });
        for (const [to, from] of Object.entries(files)) cpSync(join(repoRoot, from), join(this.run.user, to), { recursive: true });
        await before?.(this.run);
        this.vars = vars;
        const own = (list = []) => list.filter((x) => !x.scene || x.scene === this.name);
        const script = JSON.parse(this.fill(JSON.stringify({ turns: own(this.script.turns), notes: own(this.script.notes), titles: own(this.script.titles) }), true));
        this.model = await startDemoModel({ script, home: this.run.user, models: [this.run.model, ...(this.run.model.more ?? [])].map((m) => m.id) });
        this.run.writeProfile(this.model.port);
        await this.run.boot(`${this.name} showcase`);
        return this.run;
    }

    /** `text` with each `{{name}}` of the scene's `vars` filled in (`json`: inside a JSON string). */
    fill(text, json = false) {
        return text.replace(/\{\{(\w+)\}\}/g, (all, name) => {
            if (!(name in (this.vars ?? {}))) return all;
            const value = String(this.vars[name]);
            return json ? JSON.stringify(value).slice(1, -1) : value;
        });
    }

    /** The prompt of this scene's demo turn that starts with `start`. */
    say(start) {
        const turn = this.script.turns.find((t) => t.scene === this.name && this.fill(t.prompt).startsWith(start));
        if (!turn) throw new Error(`no ${this.name} turn starts with “${start}”`);
        return this.fill(turn.prompt);
    }

    /** DSH again, with other rows: what a person would change in the profile. */
    async restart(rows) {
        await this.closeWindow();
        await this.run.stop();
        if (rows !== undefined) this.run.rows = rows;
        this.run.writeProfile(this.model.port);
        await this.run.boot(`${this.name} showcase again`);
    }

    /** A plugin's window endpoint, as its page calls it: the value, or a throw. */
    async api(endpoint, args = {}) {
        const r = await this.run.api(endpoint, args);
        if (!r.ok) throw new Error(`${endpoint}: ${JSON.stringify(r.error)}`);
        return r.value;
    }

    /** The window, signed in (once), dark first. */
    async open(options = {}) {
        if (!this.window) this.window = await openShowcaseWindow(this.run, this.pw, options);
        return this.window.page;
    }

    /**
     * One view in each of `themes` ('dark', 'light'); `prepare` runs before each, with the page and whether it is
     * dark. `still`: the pointer and the keyboard stay where `prepare` left them (for a menu it opened). `page`: another
     * page than the window's (one the scene drew).
     */
    async shoot(view, { themes = ['dark', 'light'], prepare, still = false, page = this.window.page } = {}) {
        for (const theme of themes) {
            const dark = theme === 'dark';
            await setTheme(page, dark);
            if (prepare) await prepare(page, dark);
            this.files.push(await capture(page, { plugin: this.name, view, dark, report: this.report, still }));
        }
    }

    async closeWindow() {
        await this.window?.browser.close().catch(() => {});
        this.window = undefined;
    }

    async close() {
        await this.closeWindow();
        if (this.model) {
            this.misses.push(...this.model.misses);
            this.model.release();
        }
        if (this.run) {
            await this.run.stop().catch(() => {});
            this.run.cleanup();
        }
        await this.model?.close();
    }
}

// Run under the DSH's own Node: the app's DSH needs the app's binary, as scripts/e2e.mjs does it.
if (!process.env.DSH_BIN) {
    const all = runtimes();
    const target = only ? all.find((r) => r.version === only || r.version.startsWith(`${only}-`)) : all.find((r) => r.node) ?? all.at(-1);
    if (!target) {
        console.error(only ? `no DSH ${only}` : 'no DSH to run (install one under .e2e/dsh-<version>, or the app)');
        process.exit(2);
    }
    const child = spawn(target.node ?? process.execPath, [process.argv[1], ...args], {
        stdio: 'inherit',
        env: { ...process.env, ...target.env, DSH_BIN: target.bin, DSH_LABEL: target.version },
    });
    child.on('exit', (code) => process.exit(code ?? 1));
} else {
    await main();
}
