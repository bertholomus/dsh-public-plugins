#!/usr/bin/env node
/**
 * What the plugin does once at its first start in this DSH, shown before it
 * runs: the categories the projects plugin kept come over, or, when that
 * store never had categories, the all-in-one mod's old sidebar projects come
 * in as categories (only their names and which workspaces each held). It
 * only reads: the plugin's store
 * (the default <DSH home>/categories/categories.json, or the path given),
 * the projects plugin's store (<DSH home>/projects/projects.json, or the
 * second path given), DSH's workspaces (<DSH home>/storages/workspace.json)
 * and <DSH home>/fleet-shell/state.json. DSH home is $DSH_HOME, else ~/.dsh.
 *
 *   node plugins/categories/scripts/import-preview.mjs [store file] [projects store file]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CategoryStore, dataPath, dshHome } from '../lib/store.js';
import { planFleetShellImport, planFromProjects } from '../lib/plan.js';

const home = dshHome();
const read = (file) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        return error;
    }
};
const short = (path) => (typeof path === 'string' && path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

console.log(`Preview for ${short(home)}. Read-only: nothing changes.`);
const workspaceFile = join(home, 'storages', 'workspace.json');
const registry = read(workspaceFile);
if (registry instanceof Error) {
    console.log(`Can't read DSH's workspaces (${short(workspaceFile)}): ${registry.message}`);
    process.exit(1);
}
const workspaces = registry?.tables?.workspaces ?? {};
/** A workspace as people know it: DSH's title and folder; one DSH no longer has is said as that, never by its id. */
const GONE = 'a workspace DSH no longer has';
const label = (id) => {
    const ws = workspaces[id];
    return ws ? `${ws.title === 'default-workspace' ? 'Default workspace' : ws.title || id} (${short(ws.path)})` : GONE;
};
const store = new CategoryStore(process.argv[2] ?? '~/.dsh/categories/categories.json');
let { categories, categoryOf } = store;
let fleetShell = store.imports.fleetShell;
/** Whether the categories came from the projects plugin's store, which had them: then the old sidebar is never read. */
let fromCategories = store.imports.projects?.from === 'categories';

// 1. The categories the projects plugin kept, once.
if (store.exists) {
    const moved = store.imports.projects;
    console.log(moved ? `\nThe categories already came over from the projects plugin (${moved.at}): ${count(moved.categories, 'category', 'categories')}, ${count(moved.workspaces, 'workspace')}.` : '\nThis plugin already has its store; nothing comes over from the projects plugin.');
} else {
    const projectsFile = dataPath(process.argv[3] ?? '~/.dsh/projects/projects.json');
    const stored = read(projectsFile);
    if (stored instanceof Error && stored.code !== 'ENOENT') {
        console.log(`\nThe move would log an error and wait for the next start: ${short(projectsFile)} can't be read (${stored.message}).`);
    }
    const plan = planFromProjects(stored instanceof Error ? {} : stored, new Date().toISOString());
    ({ categories, categoryOf } = plan);
    fleetShell = plan.fleetShell;
    fromCategories = plan.from === 'categories';
    const copy = join(dirname(store.file), 'from-projects.json');
    if (plan.from === 'none') console.log(`\nNothing comes over from the projects plugin: ${short(projectsFile)} ${stored instanceof Error ? "isn't there" : 'has no categories or groups'}.`);
    else {
        console.log(`\nFrom the projects plugin's store (${short(projectsFile)}, only read; copied to ${short(copy)} first), at the first start:\n`);
        plan.order.forEach((id, i) => {
            const held = Object.keys(categoryOf).filter((ws) => categoryOf[ws] === id);
            const name = categories[id].name;
            console.log(`${i + 1}. ${name}${plan.from === 'groups' && name === id && stored.projects?.[id]?.name === undefined ? ' (a project from the projects plugin\'s settings: its store keeps no name, so the category takes its id)' : ''}`);
            for (const ws of held) console.log(`     ${workspaces[ws] ? label(ws) : `${GONE} (kept in the store, not shown)`}`);
            if (held.length === 0) console.log('     (no workspaces)');
        });
        if (plan.order.length === 0) console.log('No categories.');
        if (plan.from === 'groups') console.log('\nThese were groups of workspaces, from before categories.');
        if (plan.projects.length > 0) console.log(`Projects with a coordinator in their own workspace stay projects only: ${plan.projects.join(', ')}`);
    }
}

// 2. The old sidebar's projects come in as categories, once, unless the projects plugin already had categories.
const oldFile = join(home, 'fleet-shell', 'state.json');
if (fromCategories) {
    console.log(`\nThe old sidebar (${short(oldFile)}) isn't read: the projects plugin's store had categories, so those are your categories as you left them.`);
    process.exit(0);
}
if (fleetShell) {
    const made = fleetShell.categories ?? fleetShell.projects;
    console.log(`\nThe old sidebar was already imported (${fleetShell.at}): ${made} ${fleetShell.categories === undefined ? 'groups' : 'categories'}, ${fleetShell.workspaces} workspaces, ${fleetShell.skipped} skipped. It won't run again.`);
    process.exit(0);
}
const state = read(oldFile);
if (state instanceof Error) {
    console.log(state.code === 'ENOENT' ? `\nNothing to import: ${short(oldFile)} doesn't exist.` : `\nThe import would log an error and do nothing: ${short(oldFile)} can't be read (${state.message}).`);
    process.exit(0);
}
const holder = (workspaceId) => (categories[categoryOf[workspaceId]] ? categoryOf[workspaceId] : undefined);
const names = new Map(Object.entries(categories).map(([id, c]) => [String(c.name).trim().toLowerCase(), id]));
const plan = planFleetShellImport(state, { names, known: (id) => Boolean(workspaces[id]), placed: (id) => holder(id) !== undefined });

console.log(`\nFrom ${short(oldFile)}, once, at the first DSH start with this plugin (names and workspaces only; its instructions, files and defaults stay behind):\n`);
plan.groups.forEach((group, i) => {
    console.log(`${i + 1}. ${group.name}${group.join ? ` joins the category "${categories[group.join]?.name ?? group.join}" (same name)` : ', a new category'}`);
    for (const id of group.workspaces) console.log(`     ${label(id)}`);
    if (group.workspaces.length === 0) console.log('     (no workspaces)');
});
const list = (ids, what) => console.log(`\n${what}: ${ids.length === 0 ? 'none' : ids.map((id) => (holder(id) ? `${label(id)} in "${categories[holder(id)].name}"` : label(id))).join(', ')}`);
list(plan.kept, 'Already in a category here, stays there');
list(plan.loose, 'Ungrouped in the old sidebar, goes to Other workspaces');
console.log(`\nGone from DSH, skipped: ${plan.skipped.length === 0 ? 'none' : plan.skipped.length === 1 ? GONE : `${plan.skipped.length} workspaces DSH no longer has`}`);
const made = plan.groups.filter((g) => !g.join).length;
console.log(`\nResult: ${made} new categories, ${plan.groups.length - made} joined, ${plan.groups.reduce((n, g) => n + g.workspaces.length, 0)} workspaces placed, ${plan.skipped.length} skipped.`);
