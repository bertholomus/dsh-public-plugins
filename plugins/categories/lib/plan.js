/**
 * The plugin's two one-time moves, planned purely: the plugin applies them
 * at its first start (categories.js), and scripts/import-preview.mjs prints
 * them without changing anything.
 *
 * 1. From the projects plugin's store. Until this plugin, categories lived
 *    there (`categories`, `categoryOf`), and before that its projects were
 *    also groups of workspaces (`workspaceOf`). Whatever categories that
 *    store holds come over as they are; a store from before categories
 *    gives its groups instead, except a project with a coordinator that
 *    holds only its own workspace: that one is a project, not a category.
 * 2. From the all-in-one mod's old sidebar (`<DSH home>/fleet-shell/state.json`):
 *    its projects come in as categories, names and workspaces only.
 *
 * @module dsh-plugin-categories/plan
 */
import { cleanCategories, cleanPlacements } from './store.js';

const plain = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isPlain = (value) => plain(value) === value;

/** A category's place in the list; one without a number goes after the numbered ones. */
const rank = (c) => (Number.isFinite(c?.order) ? c.order : Infinity);

/**
 * @param {object} stored - the projects plugin's store, as parsed.
 * @param {string} now - the time to stamp categories without one.
 * @returns {{ from: 'categories' | 'groups' | 'none', categories: Record<string, object>, categoryOf: Record<string, string>,
 *   order: string[], projects: string[], fleetShell?: object }}
 *   `from`: what the store held (categories, groups from before them, or
 *   neither); `categories` and `categoryOf` as this plugin keeps them,
 *   `order` their ids in the list's order; `projects`: groups left out
 *   because they are projects with a coordinator in their own workspace;
 *   `fleetShell`: the store's record of the old sidebar's import, so it
 *   doesn't run again.
 */
export function planFromProjects(stored, now) {
    const s = plain(stored);
    const imported = plain(s.imports).fleetShell;
    const fleetShell = isPlain(imported) ? { fleetShell: { ...imported } } : {};
    const none = { from: 'none', categories: {}, categoryOf: {}, order: [], projects: [], ...fleetShell };
    if (s.version !== 1) return none;

    // Since categories: every one comes over as it is, with its workspaces.
    if (isPlain(s.categories)) {
        const categories = cleanCategories(s.categories);
        const order = Object.keys(categories).map((id, i) => ({ id, i })).sort((a, b) => rank(categories[a.id]) - rank(categories[b.id]) || a.i - b.i).map(({ id }) => id);
        const categoryOf = Object.fromEntries(Object.entries(cleanPlacements(s.categoryOf)).filter(([, id]) => categories[id]));
        return { from: 'categories', categories: structuredClone(categories), categoryOf, order, projects: [], ...fleetShell };
    }

    // Before categories: each group of workspaces, in the order the projects plugin listed them.
    const projects = plain(s.projects);
    const workspaceOf = cleanPlacements(s.workspaceOf);
    if (Object.keys(workspaceOf).length === 0 && !Object.values(projects).some((p) => named(p))) return none;
    const members = (id) => Object.keys(workspaceOf).filter((ws) => workspaceOf[ws] === id);
    // A project from the projects plugin's settings keeps no name in its store; those came first.
    const unnamed = Object.keys(projects).filter((id) => !named(projects[id]));
    const others = Object.keys(projects).filter((id) => named(projects[id]))
        .map((id, i) => ({ id, i, at: rank(projects[id]) }))
        .sort((a, b) => a.at - b.at || a.i - b.i)
        .map(({ id }) => id);
    const categories = {};
    const categoryOf = {};
    const order = [];
    const left = [];
    for (const id of [...unnamed, ...others]) {
        const entry = plain(projects[id]);
        const held = members(id);
        // Never a group: a project from the settings that held no workspace.
        if (held.length === 0 && !named(entry)) continue;
        if (isProjectOnly(entry, held)) {
            left.push(id);
            continue;
        }
        categories[id] = {
            name: named(entry) ? entry.name.trim() : id,
            order: order.length,
            createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : now,
            source: entry.source === 'import' ? 'import' : 'group',
            ...(typeof entry.importedFrom === 'string' ? { importedFrom: entry.importedFrom } : {}),
        };
        order.push(id);
        for (const ws of held) if (categoryOf[ws] === undefined) categoryOf[ws] = id;
    }
    return { from: 'groups', categories, categoryOf, order, projects: left, ...fleetShell };
}

function named(project) {
    return typeof project?.name === 'string' && project.name.trim() !== '';
}

/**
 * Whether a group from before categories is only a project: it has a
 * coordinator and holds no workspace but its own (the one its coordinator
 * works in, when the store says which; else at most one).
 */
function isProjectOnly(project, held) {
    if (typeof project.coordinatorSessionId !== 'string' || project.coordinatorSessionId === '') return false;
    if (typeof project.home === 'string' && project.home !== '') return held.every((ws) => ws === project.home);
    return held.length <= 1;
}

/**
 * The old sidebar's projects, as categories here. The old file lists them
 * in sidebar order (`projects: [{ id, name }]`) and files DSH workspaces
 * under them (`projectOf: { [workspace id]: project id }`, "_none" for
 * Ungrouped).
 * @param {object} state - the old file's contents.
 * @param {object} here - what this DSH has.
 * @param {Map<string, string>} here.names - each category's name, trimmed and lower-cased, to its id.
 * @param {(workspaceId: string) => boolean} here.known - whether DSH has the workspace.
 * @param {(workspaceId: string) => boolean} here.placed - whether a category here holds it already.
 * @returns {{ groups: { name: string, join?: string, from: string, workspaces: string[] }[], kept: string[], skipped: string[], loose: string[] }}
 *   `groups`: one per name, in the old order, each a new category or one it
 *   joins (`join`, by name), with the workspaces it takes; `kept`:
 *   workspaces a category here already holds; `skipped`: ones DSH no longer
 *   has; `loose`: Ungrouped in the old sidebar, or under an old project
 *   that is gone.
 */
export function planFleetShellImport(state, { names, known, placed }) {
    const old = Array.isArray(state?.projects) ? state.projects : [];
    const projectOf = state?.projectOf !== null && typeof state?.projectOf === 'object' ? state.projectOf : {};
    const groups = [];
    const byName = new Map();
    const into = new Map();
    for (const entry of old) {
        const name = typeof entry?.name === 'string' ? entry.name.replace(/\s+/g, ' ').trim() : '';
        if (name === '' || typeof entry.id !== 'string') continue;
        const key = name.toLowerCase();
        let group = byName.get(key);
        if (!group) {
            group = { name, ...(names.has(key) ? { join: names.get(key) } : {}), from: entry.id, workspaces: [] };
            byName.set(key, group);
            groups.push(group);
        }
        into.set(entry.id, group);
    }
    const kept = [];
    const skipped = [];
    const loose = [];
    for (const [workspaceId, oldId] of Object.entries(projectOf)) {
        const group = into.get(oldId);
        if (!group) loose.push(workspaceId);
        else if (!known(workspaceId)) skipped.push(workspaceId);
        else if (placed(workspaceId)) kept.push(workspaceId);
        else group.workspaces.push(workspaceId);
    }
    return { groups, kept, skipped, loose };
}
