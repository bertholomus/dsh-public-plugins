import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLog } from '../../lib/log.js';

test('the log is owner-only, makes its folder, and stamps each line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-site-log-'));
    try {
        const file = join(dir, 'deep', 'site.log');
        const log = createLog(file, { now: () => Date.parse('2026-10-26T16:00:00Z') });
        log.write('listening on 127.0.0.1:1');
        assert.equal(readFileSync(file, 'utf8'), '2026-10-26T16:00:00.000Z listening on 127.0.0.1:1\n');
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(join(dir, 'deep')).mode & 0o777, 0o700);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the log keeps under its cap: past maxBytes it moves to .1 and starts again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-site-log-'));
    try {
        const file = join(dir, 'site.log');
        const log = createLog(file, { maxBytes: 300 });
        for (let i = 0; i < 40; i++) log.write(`line ${i} ${'x'.repeat(20)}`);
        assert.ok(statSync(file).size <= 300, 'the live file stays under the cap');
        assert.ok(existsSync(`${file}.1`), 'the older lines are kept once');
        assert.ok(statSync(`${file}.1`).size <= 300);
        assert.match(readFileSync(file, 'utf8'), /line 39/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('often(): a repeated refusal is written once, then once a minute with how many were skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-site-log-'));
    try {
        const file = join(dir, 'site.log');
        let t = 0;
        const log = createLog(file, { now: () => t });
        assert.equal(log.often('deny-1.2.3.4', 'deny 1.2.3.4'), true);
        for (let i = 0; i < 500; i++) {
            t += 10;
            log.often('deny-1.2.3.4', 'deny 1.2.3.4');
        }
        log.often('deny-5.6.7.8', 'deny 5.6.7.8');
        t = 61000;
        log.often('deny-1.2.3.4', 'deny 1.2.3.4');
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        assert.equal(lines.length, 3, lines.join('\n'));
        assert.match(lines[2], /deny 1\.2\.3\.4 \(and 500 more like it in the last minute\)$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('no file: nothing is written and nothing throws; an unwritable file never throws', () => {
    const log = createLog('');
    log.write('x');
    log.often('k', 'x');
    const bad = createLog('/dev/null/not-a-dir/site.log');
    assert.doesNotThrow(() => bad.write('x'));
});
