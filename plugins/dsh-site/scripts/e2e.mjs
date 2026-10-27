#!/usr/bin/env node
/**
 * Run dsh-site's real-DSH test (test/e2e/run.mjs) on every DSH test runtime
 * and on the installed app's own DSH, each in a throwaway home with the edge
 * on 127.0.0.1 only, and read the live DSH's fingerprint before and after:
 * the tests must leave the DSH you use untouched (the same process; its
 * profile patch may be edited by its owner meanwhile, and the summary names
 * the rows that changed).
 *
 *   node scripts/e2e.mjs                    every DSH (npm run e2e)
 *   node scripts/e2e.mjs --dsh 0.2.1-rc.1   one of them
 *   node scripts/e2e.mjs --dsh app          the app's DSH only
 *
 * SHOTS=<folder> saves the pictures there (one folder per DSH). Exits 1 when
 * a run fails or the fingerprint moved.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { e2eDir, liveFingerprint, livePatchText, patchRowsChanged, repoRoot, runtimes } from '../test/e2e/harness.mjs';

const rest = process.argv.slice(2);
const script = join(repoRoot, 'test', 'e2e', 'run.mjs');
const only = rest.includes('--dsh') ? rest[rest.indexOf('--dsh') + 1] : undefined;
const targets = runtimes().filter((r) => !only || r.version === only || r.version.startsWith(`${only}-`));
if (targets.length === 0) {
    console.error(only ? `no DSH ${only} in ${e2eDir()}` : `no DSH in ${e2eDir()} (install one: npm i --prefix .e2e/dsh-<version> @deepseek-ai/dsh@<version>, or set DSH_E2E_DIR)`);
    process.exit(2);
}

const short = (f) => (f ? `pid ${f.pid}, started ${f.started}, patch ${String(f.patchSha256).slice(0, 16)}` : 'unknown (no dsh-test)');
const before = liveFingerprint();
const patchBefore = livePatchText();
console.log(`# live DSH before: ${short(before)}`);

const results = [];
for (const target of targets) {
    console.log(`\n# ── dsh-site on DSH ${target.version} ──`);
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

// The live DSH must be the same process (pid and start time). Its profile patch may be edited by its owner
// while the tests run; the tests never write it, so a change there fails the run only if it touches this
// plugin's own row.
const after = liveFingerprint();
const sameProcess = Boolean(before && after) && before.pid === after.pid && before.started === after.started;
let patchNote = 'patch unchanged';
let patchOk = true;
if (before && after && before.patchSha256 !== after.patchSha256) {
    const rows = patchRowsChanged(patchBefore, livePatchText());
    patchOk = !rows.includes('dsh-site');
    patchNote = `patch edited during the run, in the rows ${rows.join(', ') || '(unknown)'}${patchOk ? ' (not dsh-site\'s row; these tests write only inside their throwaway homes)' : ' — dsh-site\'s own row changed'}`;
}
console.log('\n# summary');
for (const r of results) console.log(`# dsh-site on DSH ${r.version}: ${r.passed} passed, ${r.failed} failed (${r.seconds} s)${r.exit === 0 ? '' : ` — exit ${r.exit}`}`);
console.log(`# live DSH after: ${short(after)} — ${!before || !after ? 'not checked' : sameProcess ? 'same process' : 'CHANGED PROCESS'}; ${patchNote}`);
process.exit(results.every((r) => r.exit === 0) && ((sameProcess && patchOk) || !before) ? 0 : 1);
