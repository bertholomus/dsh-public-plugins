#!/usr/bin/env node
/**
 * The READMEs' pictures, from docs/site.json: in each plugin's README its hero
 * after the first paragraph and a short Screenshots section before its first
 * section, and in the root README a gallery with each plugin's hero.
 *
 *   node scripts/showcase/readmes.mjs      (npm run showcase:readmes)
 *
 * Run it after `npm run showcase` and a change to docs/site.json. It changes
 * only the parts between its own <!-- showcase:… --> marks, and
 * test/site-manifest.test.js fails while a README differs from what it writes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const md = (text) => String(text).replace(/([\\[\]])/g, '\\$1');
const html = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const block = (name, body) => `<!-- showcase:${name} -->\n${body}\n<!-- /showcase:${name} -->`;

/** The hero, for the plugin's own README. */
export function heroBlock(p) {
    const hero = p.screenshots.find((s) => s.file === p.hero);
    return block('hero', `![${md(hero.alt)}](../../${p.hero})`);
}

/** The other pictures, each with its caption, for the plugin's own README. */
export function screenshotsBlock(p) {
    const rest = p.screenshots.filter((s) => s.file !== p.hero);
    const pictures = rest.map((s) => `![${md(s.alt)}](../../${s.file})\n\n*${s.caption}*`).join('\n\n');
    const note = 'Made by `npm run showcase` in a demo home; [docs/site.json](../../docs/site.json) lists them, with their words.';
    return block('screenshots', `## Screenshots\n\n${pictures ? `${pictures}\n\n` : ''}${note}`);
}

/** Every plugin's hero, two to a row, for the root README. */
export function galleryBlock(site) {
    const cell = (p) => {
        const hero = p.screenshots.find((s) => s.file === p.hero);
        const link = `plugins/${p.name}`;
        return `<td width="50%" valign="top"><a href="${link}"><img src="${p.hero}" alt="${html(hero.alt)}"></a><br><a href="${link}"><b>${html(p.title)}</b></a> ${html(p.version)}: ${html(p.tagline)}</td>`;
    };
    const rows = [];
    for (let i = 0; i < site.plugins.length; i += 2) rows.push(`<tr>\n${site.plugins.slice(i, i + 2).map(cell).join('\n')}\n</tr>`);
    return block('gallery', `## Gallery\n\nOne picture of each plugin, from a demo home. Each plugin's README has more.\n\n<table>\n${rows.join('\n')}\n</table>`);
}

/** `text` without the block `name` and the blank line after it. */
function without(text, name) {
    return text.replace(new RegExp(`<!-- showcase:${name} -->[\\s\\S]*?<!-- /showcase:${name} -->\\n\\n?`), '');
}

/** The line where the first paragraph ends: one that ends with ":" goes on through the list after it. */
function afterFirstParagraph(lines) {
    let at = lines.findIndex((l) => /^# /.test(l)) + 1;
    while (at < lines.length && !lines[at].trim()) at += 1;
    for (;;) {
        while (at < lines.length && lines[at].trim()) at += 1;
        let next = at;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (next < lines.length && lines[at - 1].trimEnd().endsWith(':') && /^\s*([-*]|\d+\.)\s/.test(lines[next])) {
            at = next;
            continue;
        }
        return at;
    }
}

/** A plugin's README with its hero and its Screenshots section from `p`. */
export function pluginReadme(text, p) {
    const lines = without(without(text, 'hero'), 'screenshots').split('\n');
    const at = afterFirstParagraph(lines);
    lines.splice(at, 0, '', ...heroBlock(p).split('\n'));
    const section = lines.findIndex((l, i) => i > at && /^## /.test(l));
    if (section === -1) lines.push('', ...screenshotsBlock(p).split('\n'));
    else lines.splice(section, 0, ...screenshotsBlock(p).split('\n'), '');
    return lines.join('\n');
}

/** The root README with the gallery before "Install a plugin". */
export function rootReadme(text, site) {
    const lines = without(text, 'gallery').split('\n');
    const at = lines.findIndex((l) => l === '## Install a plugin');
    if (at === -1) throw new Error('the root README has no "## Install a plugin" section');
    lines.splice(at, 0, ...galleryBlock(site).split('\n'), '');
    return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const site = JSON.parse(readFileSync(join(root, 'docs', 'site.json'), 'utf8'));
    const write = (file, next) => {
        const before = readFileSync(file, 'utf8');
        if (next !== before) writeFileSync(file, next);
        console.log(`${next === before ? 'same' : 'wrote'} ${file.slice(root.length + 1)}`);
    };
    for (const p of site.plugins) write(join(root, 'plugins', p.name, 'README.md'), pluginReadme(readFileSync(join(root, 'plugins', p.name, 'README.md'), 'utf8'), p));
    write(join(root, 'README.md'), rootReadme(readFileSync(join(root, 'README.md'), 'utf8'), site));
}
