// docs/site.json, the manifest the website reads: an entry for each plugin folder and none for a folder that is
// not there, each entry's version the one in its package.json, every picture it names on disk with words for it,
// the hero among its pictures (in dark and in light), and the READMEs showing the same pictures with the same words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { galleryBlock, heroBlock, screenshotsBlock } from '../scripts/showcase/readmes.mjs';

const root = new URL('..', import.meta.url).pathname;
const site = JSON.parse(readFileSync(join(root, 'docs', 'site.json'), 'utf8'));
const folders = readdirSync(join(root, 'plugins'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, 'plugins', d.name, 'package.json')))
    .map((d) => d.name)
    .sort();
const entries = new Map(site.plugins.map((p) => [p.name, p]));
const filled = (value) => typeof value === 'string' && value.trim().length > 0;

test('every plugin folder has an entry in docs/site.json', () => {
    assert.deepEqual(folders.filter((name) => !entries.has(name)), []);
});

test('every entry in docs/site.json has a plugin folder, once', () => {
    assert.deepEqual([...entries.keys()].filter((name) => !folders.includes(name)), []);
    assert.equal(entries.size, site.plugins.length, 'a plugin has two entries');
});

for (const p of site.plugins) {
    test(`${p.name}: its version, words and pictures`, () => {
        const pkg = JSON.parse(readFileSync(join(root, 'plugins', p.name, 'package.json'), 'utf8'));
        assert.equal(p.version, pkg.version, `${p.name}: docs/site.json says ${p.version}, its package.json ${pkg.version}`);
        for (const key of ['title', 'tagline', 'summary']) assert.ok(filled(p[key]), `${p.name}: no ${key}`);
        assert.ok(Array.isArray(p.features) && p.features.length >= 3 && p.features.length <= 6 && p.features.every(filled), `${p.name}: features must be 3 to 6 lines`);
        assert.ok(Array.isArray(p.requires) && p.requires.every(filled), `${p.name}: requires must be a list of lines`);
        assert.ok(Array.isArray(p.platforms) && p.platforms.length > 0 && p.platforms.every(filled), `${p.name}: no platforms`);
        assert.ok(Array.isArray(p.screenshots) && p.screenshots.length > 0, `${p.name}: no screenshots`);
        for (const s of p.screenshots) {
            assert.ok(s.file.startsWith(`docs/screenshots/${p.name}/`), `${p.name}: ${s.file} is not in docs/screenshots/${p.name}/`);
            assert.ok(existsSync(join(root, s.file)), `${p.name}: ${s.file} is missing`);
            assert.ok(filled(s.alt), `${p.name}: ${s.file} has no alt text`);
            assert.ok(filled(s.caption), `${p.name}: ${s.file} has no caption`);
            assert.ok(['dark', 'light'].includes(s.theme) && s.file.endsWith(`-${s.theme}.png`), `${p.name}: ${s.file} is not marked with its theme`);
        }
        const files = p.screenshots.map((s) => s.file);
        assert.equal(new Set(files).size, files.length, `${p.name}: a picture is listed twice`);
        assert.ok(files.includes(p.hero), `${p.name}: its hero ${p.hero} is not in its screenshots`);
        const twin = p.hero.replace(/-(dark|light)\.png$/, (all, theme) => `-${theme === 'dark' ? 'light' : 'dark'}.png`);
        assert.ok(files.includes(twin), `${p.name}: its hero has no ${twin.endsWith('-dark.png') ? 'dark' : 'light'} picture (${twin})`);
        // The pictures the generator left are the pictures the site shows: none left out, none stale.
        const onDisk = readdirSync(join(root, 'docs', 'screenshots', p.name)).filter((f) => f.endsWith('.png')).map((f) => `docs/screenshots/${p.name}/${f}`);
        assert.deepEqual(onDisk.filter((f) => !files.includes(f)), [], `${p.name}: pictures on disk that docs/site.json does not list`);
    });

    test(`${p.name}: its README shows the hero and the screenshots of docs/site.json`, () => {
        const readme = readFileSync(join(root, 'plugins', p.name, 'README.md'), 'utf8');
        assert.ok(readme.includes(heroBlock(p)), `${p.name}: README has no hero, or another one (node scripts/showcase/readmes.mjs)`);
        assert.ok(readme.includes(screenshotsBlock(p)), `${p.name}: README's Screenshots differ from docs/site.json (node scripts/showcase/readmes.mjs)`);
    });
}

test('the root README shows every plugin\'s hero', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    assert.ok(readme.includes(galleryBlock(site)), 'the gallery differs from docs/site.json (node scripts/showcase/readmes.mjs)');
});
