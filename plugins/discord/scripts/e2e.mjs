#!/usr/bin/env node
/**
 * Run the plugin's real-DSH test (test/e2e/run.mjs) on every DSH build
 * there is: the test runtimes (.e2e/dsh-<version>, DSH_E2E_DIR, or the
 * plugin suite's) and the installed app's own DSH, with the live DSH's
 * fingerprint read before and after. The tests run DSH in throwaway homes
 * against a fake Discord and must leave the DSH you use untouched.
 *
 *   npm run e2e                       every build
 *   npm run e2e -- --dsh 0.2.1-rc.1   one build
 *   npm run e2e -- --dsh app          the app's DSH only
 *   SHOTS=<folder> npm run e2e        also take the pictures (light, dark, narrow)
 *
 * Exits 1 when a run fails or the fingerprint moved. Prints one summary
 * line per build, and one for the fingerprint.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { liveFingerprint, repoRoot, runtimeDirs, runtimes } from '../test/e2e/harness.mjs';

const args = process.argv.slice(2);
const only = args.includes('--dsh') ? args[args.indexOf('--dsh') + 1] : undefined;
const script = join(repoRoot, 'test', 'e2e', 'run.mjs');
const targets = runtimes().filter((r) => !only || r.version === only || r.version.startsWith(`${only}-`));
if (targets.length === 0) {
    console.error(only ? `no DSH ${only} found` : `no DSH found (looked in ${runtimeDirs().join(', ')} and the app); install the test builds with: npm run e2e:install`);
    process.exit(2);
}

const short = (f) => (f ? `pid ${f.pid}, started ${f.started}, patch ${String(f.patchSha256).slice(0, 16)}` : 'unknown (no dsh-test tool)');
const before = liveFingerprint();
console.log(`# live DSH before: ${short(before)}`);

const results = [];
for (const target of targets) {
    console.log(`\n# ── discord on DSH ${target.version} ──`);
    const started = Date.now();
    await new Promise((resolve) => {
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
            resolve();
        });
    });
}

const after = liveFingerprint();
// The live DSH's process must be the same one (pid and start). Its profile may be edited by its owner meanwhile:
// a moved patch hash is reported for a look at the diff, and fails nothing by itself.
const sameProcess = Boolean(before && after) && before.pid === after.pid && before.started === after.started;
const samePatch = Boolean(before && after) && before.patchSha256 === after.patchSha256;
console.log('\n# summary');
for (const r of results) console.log(`# discord on DSH ${r.version}: ${r.passed} passed, ${r.failed} failed (${r.seconds} s)${r.exit === 0 ? '' : ` — exit ${r.exit}`}`);
const verdict = !before || !after ? 'not checked'
    : !sameProcess ? 'CHANGED: a different process (pid or start time)'
        : samePatch ? 'unchanged' : 'same process; its profile patch was edited meanwhile (not by these tests: they never open it), look at the diff';
console.log(`# live DSH after: ${short(after)} — ${verdict}`);
process.exit(results.every((r) => r.exit === 0) && (sameProcess || !before) ? 0 : 1);
