import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { register } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, REQUIRED } from '../../lib/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * DSH gives its plugins `@deepseek-ai/schemastery`; outside DSH, take it from a DSH test runtime
 * (the same folders the real-DSH tests use), so the plugin's own entry loads here as it does in DSH.
 */
function schemastery() {
    for (const base of [process.env.DSH_E2E_DIR, join(root, '.e2e'), join(homedir(), 'Projects', 'dsh-plugin-suite', '.e2e')].filter(Boolean)) {
        let names = [];
        try {
            names = readdirSync(base).filter((n) => n.startsWith('dsh-')).sort().reverse();
        } catch {}
        for (const name of names) {
            const entry = join(base, name, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs');
            if (existsSync(entry)) return pathToFileURL(entry).href;
        }
    }
    return undefined;
}
const schemasteryUrl = schemastery();
if (schemasteryUrl) {
    register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
        if (specifier === '@deepseek-ai/schemastery') return { url: ${JSON.stringify(schemasteryUrl)}, shortCircuit: true };
        return next(specifier, context);
    }`)}`);
}
const SKIP = new Set(['.git', 'node_modules', '.e2e', 'evidence']);

/** Every text file of the repo (not dependencies, test runtimes or pictures). */
function files(dir = root, out = []) {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(d.name)) continue;
        const p = join(dir, d.name);
        if (d.isDirectory()) files(p, out);
        else if (/\.(js|mjs|json|md|sh|yml|svg)$/.test(d.name) || d.name === '.gitignore') out.push(p);
    }
    return out;
}

test('no assistant or vendor names anywhere in the repo', () => {
    const banned = new RegExp(['cl' + 'aude', 'anth' + 'ropic', 'open' + 'ai', 'co' + 'dex', 'chat' + 'gpt', 'co' + 'pilot', 'gem' + 'ini'].join('|'), 'i');
    for (const file of files()) {
        const text = readFileSync(file, 'utf8');
        const hit = banned.exec(text);
        assert.equal(hit, null, `${relative(root, file)}: "${hit?.[0]}"`);
    }
});

test('every script parses (node --check)', () => {
    const scripts = files().filter((f) => /\.(js|mjs)$/.test(f));
    assert.ok(scripts.length >= 15, `${scripts.length} scripts`);
    for (const file of scripts) execFileSync(process.execPath, ['--check', file]);
});

test('the README\'s settings table lists every setting with its default (or says it is required), and nothing else', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const rows = [...readme.matchAll(/^\| `([a-zA-Z]+)` \| [^|]+ \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].trim()]);
    assert.deepEqual(rows.map(([k]) => k).sort(), Object.keys(DEFAULTS).sort());
    for (const [key, shown] of rows) {
        if (REQUIRED.includes(key)) {
            assert.equal(shown, 'none: required', key);
            continue;
        }
        const want = typeof DEFAULTS[key] === 'string' ? (DEFAULTS[key] === '' ? '""' : DEFAULTS[key]) : String(DEFAULTS[key]);
        assert.equal(shown, `\`${want}\``, key);
    }
});

test('the plugin\'s entry loads; its schema has every setting, takes any value, fills in nothing, and passes unknown keys on', { skip: !schemasteryUrl && 'no DSH test runtime to take schemastery from' }, async () => {
    const { Config, apply, inject, name } = await import('../../lib/index.js');
    assert.equal(name, 'dsh-site');
    assert.deepEqual(inject, []);
    assert.equal(typeof apply, 'function');
    assert.deepEqual(Object.keys(Config.dict ?? {}).sort(), Object.keys(DEFAULTS).sort());
    // As DSH resolves a row (cordis calls the schema's standard validate).
    const resolve = (value) => Config['~standard'].validate(value).value;
    for (const empty of [undefined, null, {}]) assert.deepEqual(resolve(empty), {}, 'a row with no settings reaches the plugin empty, so it does not serve');
    assert.deepEqual(resolve({ enable: false, listenHost: '127.0.0.1' }), { enable: false, listenHost: '127.0.0.1' }, 'a misspelt key reaches the plugin, which names it');
    assert.doesNotThrow(() => resolve({ listenPort: 'abc', enabled: 'maybe', allowCIDRs: 7 }), 'a wrong type never stops the plugin');
    assert.deepEqual(resolve({ listenPort: 'abc' }), { listenPort: 'abc' });
});

test('the package is complete: its files exist, the patch row names this package, a title and a 36 px icon', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const f of pkg.files) assert.ok(existsSync(join(root, f)), f);
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /- id: dsh-site\n\s+name: dsh-plugin-dsh-site/);
    assert.equal(pkg.name, 'dsh-plugin-dsh-site');
    const locale = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'));
    assert.ok(locale.meta?.title && locale.meta?.description);
    const icon = readFileSync(join(root, 'icon.svg'), 'utf8');
    assert.match(icon, /viewBox="0 0 36 36"/);
    assert.match(icon, /currentColor/);
    assert.ok((statSync(join(root, 'verify.sh')).mode & 0o111) !== 0, 'verify.sh is executable');
});
