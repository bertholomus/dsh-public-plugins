#!/usr/bin/env node
/**
 * Run a suite plugin's real-DSH test on every DSH under .e2e/ and the
 * installed app's own DSH (or the one named), with the live DSH's
 * fingerprint read before and after: the tests run DSH in throwaway homes
 * and must leave the DSH you use untouched.
 *
 *   node scripts/e2e.mjs autopilot              every DSH
 *   node scripts/e2e.mjs autopilot --dsh 0.2.1-rc.1
 *   node scripts/e2e.mjs autopilot --dsh app    the app's DSH only
 *
 * Exits 1 when a run fails or the fingerprint moved. Prints one summary
 * line per DSH, and one for the fingerprint, for PROGRESS.md.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { liveFingerprint, pluginsDir, runtimes } from '../test/e2e/harness.mjs';

const [plugin, ...rest] = process.argv.slice(2);
if (!plugin) {
    console.error('usage: node scripts/e2e.mjs <plugin> [--dsh <version>]');
    process.exit(2);
}
const script = join(pluginsDir, plugin, 'test', 'e2e', 'run.mjs');
if (!existsSync(script)) {
    console.error(`no real-DSH test for ${plugin} (looked for ${script})`);
    process.exit(2);
}
const only = rest.includes('--dsh') ? rest[rest.indexOf('--dsh') + 1] : undefined;
const targets = runtimes().filter((r) => !only || r.version === only || r.version.startsWith(`${only}-`));
if (targets.length === 0) {
    console.error(only ? `no DSH ${only} under .e2e/` : 'no DSH under .e2e/ (install one: npm i --prefix .e2e/dsh-<version> @deepseek-ai/dsh@<version>)');
    process.exit(2);
}

const short = (f) => (f ? `pid ${f.pid}, patch ${String(f.patchSha256).slice(0, 16)}` : 'unknown (no dsh-test)');
const before = liveFingerprint();
console.log(`# live DSH before: ${short(before)}`);

const results = [];
for (const target of targets) {
    console.log(`\n# ── ${plugin} on DSH ${target.version} ──`);
    const started = Date.now();
    const code = await new Promise((resolve) => {
        // The app's DSH runs under the app's own binary as Node; so does the test, so the DSH it starts is that build.
        const env = { ...process.env, ...target.env, DSH_BIN: target.bin, DSH_LABEL: target.version };
        const child = spawn(target.node ?? process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'], env });
        let tail = '';
        child.stdout.on('data', (chunk) => {
            process.stdout.write(chunk);
            tail = (tail + chunk.toString('utf8')).slice(-400);
        });
        child.on('exit', (exit) => {
            const counts = /(\d+) passed, (\d+) failed/.exec(tail);
            results.push({ version: target.version, exit, passed: Number(counts?.[1] ?? 0), failed: Number(counts?.[2] ?? 0), seconds: Math.round((Date.now() - started) / 1000) });
            resolve(exit);
        });
    });
    void code;
}

const after = liveFingerprint();
const same = Boolean(before && after) && before.pid === after.pid && before.patchSha256 === after.patchSha256 && before.started === after.started;
console.log('\n# summary');
for (const r of results) console.log(`# ${plugin} on DSH ${r.version}: ${r.passed} passed, ${r.failed} failed (${r.seconds} s)${r.exit === 0 ? '' : ` — exit ${r.exit}`}`);
console.log(`# live DSH after: ${short(after)} — ${same ? 'unchanged' : before && after ? 'CHANGED' : 'not checked'}`);
process.exit(results.every((r) => r.exit === 0) && (same || !before) ? 0 : 1);
