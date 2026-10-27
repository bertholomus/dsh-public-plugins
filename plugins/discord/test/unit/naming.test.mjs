/**
 * The repository carries no third-party assistant branding: no code file,
 * doc, setting or test names an AI tool or its maker. The names are kept
 * encoded here so this file passes its own scan.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const names = ['Y2xhdWRl', 'YW50aHJvcGlj', 'Y2hhdGdwdA==', 'Y29waWxvdA=='].map((b) => Buffer.from(b, 'base64').toString());
const banned = new RegExp(names.join('|'), 'i');
const skip = new Set(['node_modules', '.git', '.e2e']);

test('no file names a third-party assistant or its maker', () => {
    const hits = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (/\.(m?js|json|md|ya?ml|html|css|svg|txt|sh)$|^\.gitignore$/.test(entry.name) && banned.test(readFileSync(path, 'utf8'))) hits.push(path.slice(root.length));
        }
    };
    walk(root);
    assert.deepEqual(hits, []);
});
