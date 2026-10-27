// The coordinator's two big suites, run by `npm test`: its host half against a fake DSH Host
// (plugins/coordinator/test/smoke.mjs) on the packages of every DSH under .e2e/, and its window half
// (plugins/coordinator/test/client.mjs), which needs no DSH. Each suite runs in its own process, as it does
// on its own, and has to pass whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(repo, 'plugins', 'coordinator', 'test');
const hook = join(repo, 'test', 'helpers', 'dsh-packages.mjs');

/** The DSH builds installed for the tests (.e2e/dsh-<version>), oldest first. */
function builds() {
    const base = join(repo, '.e2e');
    try {
        return readdirSync(base).filter((n) => /^dsh-\d/.test(n)).sort()
            .map((n) => ({ version: n.slice(4), root: join(base, n) }))
            .filter((b) => existsSync(join(b.root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')));
    } catch {
        return [];
    }
}

/** Run one suite file; its TAP counts and output. */
function run(file, env = {}) {
    // Without the parent runner's context, so the child reports in plain TAP as it does on its own.
    const { NODE_TEST_CONTEXT, ...rest } = process.env;
    void NODE_TEST_CONTEXT;
    const out = spawnSync(process.execPath, ['--import', hook, '--test-reporter=tap', file], {
        cwd: repo, encoding: 'utf8', timeout: 300000, env: { ...rest, ...env }, maxBuffer: 64 * 1024 * 1024,
    });
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
    const count = (word) => Number(new RegExp(`^# ${word} (\\d+)$`, 'm').exec(text)?.[1] ?? Number.NaN);
    return { status: out.status, text, tests: count('tests'), pass: count('pass'), fail: count('fail') };
}

const failures = (text) => text.split('\n').filter((line) => /^\s*not ok /.test(line)).slice(0, 20).join('\n');

const found = builds();
if (found.length === 0) {
    test('coordinator host suite: no DSH under .e2e/, so it cannot run (link or install one: npm i --prefix .e2e/dsh-<version> @deepseek-ai/dsh@<version>)', { skip: true }, () => {});
}
for (const build of found) {
    test(`coordinator host suite (fake Host) on DSH ${build.version}'s packages`, () => {
        const result = run(join(plugin, 'smoke.mjs'), { DSH_PACKAGES: build.root });
        assert.equal(result.status, 0, `smoke.mjs failed on DSH ${build.version}:\n${failures(result.text) || result.text.slice(-3000)}`);
        assert.ok(result.tests >= 90 && result.fail === 0 && result.pass === result.tests, `counts: ${result.tests} tests, ${result.pass} pass, ${result.fail} fail`);
    });
}

test('coordinator window suite (lib/client.js with DSH\'s parts stood in)', () => {
    const result = run(join(plugin, 'client.mjs'));
    assert.equal(result.status, 0, `client.mjs failed:\n${failures(result.text) || result.text.slice(-3000)}`);
    assert.ok(result.tests >= 30 && result.fail === 0 && result.pass === result.tests, `counts: ${result.tests} tests, ${result.pass} pass, ${result.fail} fail`);
});
