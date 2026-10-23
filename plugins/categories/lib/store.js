/**
 * The categories' durable state. One JSON file, atomic writes, mode 600, in
 * a folder of mode 700. Shape:
 *
 * { version: 1,
 *   categories: { [categoryId]: { name, order: its place in the list, createdAt, source: 'page' | 'import' | 'group',
 *     importedFrom?: the old sidebar project's id } }: named sets of DSH workspaces, above them in the session list,
 *   categoryOf: { [DSH workspace id]: categoryId }: the category each workspace is in, one at most,
 *   imports: { projects?: { at, file, categories, workspaces, backup? }: the categories moved over from the projects
 *       plugin's store, once (move.js),
 *     fleetShell?: { at, file, categories, joined, workspaces, skipped }: the all-in-one mod's old sidebar, imported once } }
 *
 * The file is written at the plugin's first start, so `exists` says
 * whether that start (and its one-time move) has happened.
 *
 * @module dsh-plugin-categories/store
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Resolve a '~'-prefixed path. */
export function expand(p) {
    return p.startsWith('~/') || p === '~' ? `${homedir()}${p.slice(1)}` : p;
}

/** DSH's own data folder: `$DSH_HOME`, else ~/.dsh, as DSH resolves it. */
export function dshHome() {
    const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    return env === '' ? join(homedir(), '.dsh') : resolve(expand(env));
}

/**
 * Resolve one of the plugin's data paths. One under ~/.dsh lives in DSH's
 * data folder, so a DSH run with its own DSH_HOME (a test copy) keeps its
 * own categories instead of sharing the main one's.
 */
export function dataPath(p) {
    if (p === '~/.dsh' || p.startsWith('~/.dsh/')) return `${dshHome()}${p.slice('~/.dsh'.length)}`;
    return expand(p);
}

/**
 * Create a folder (and missing parents) as mode 700, one level at a time,
 * whatever the process umask is (another plugin may have narrowed it). An
 * existing folder keeps its mode, unless its owner (us) cannot use it; that
 * one gets the owner bits back.
 * @param {string} dir
 */
export function ensurePrivateDir(dir) {
    const missing = [];
    for (let d = dir; !existsSync(d); d = dirname(d)) {
        missing.unshift(d);
        if (dirname(d) === d) break;
    }
    if (missing.length === 0) {
        const st = statSync(dir);
        if ((st.mode & 0o700) !== 0o700 && st.uid === process.getuid?.()) chmodSync(dir, (st.mode & 0o777) | 0o700);
        return;
    }
    for (const d of missing) {
        try { mkdirSync(d, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        chmodSync(d, 0o700);
    }
}

/** Write a file atomically as mode 600, its folder made private first. */
export function writePrivate(file, text) {
    ensurePrivateDir(dirname(file));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
}

const plain = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

/**
 * Each start of the plugin reads the file as it is then: a store is never
 * kept in memory across a switch-off or a config reload, so an edit to the
 * file while the plugin was off is what the next start sees and keeps.
 */
export class CategoryStore {
    /** @param {string} file - store path. */
    constructor(file) {
        this.file = dataPath(file);
        /** @type {Record<string, object>} category id → its definition */
        this.categories = {};
        /** @type {Record<string, string>} workspace id → category id */
        this.categoryOf = {};
        /** @type {Record<string, object>} */
        this.imports = {};
        /** Whether the file was there when it was read, or has been written since. */
        this.exists = false;
        this.load();
    }

    load() {
        this.categories = {};
        this.categoryOf = {};
        this.imports = {};
        this.exists = existsSync(this.file);
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            if (parsed?.version !== 1) return;
            this.categories = cleanCategories(parsed.categories);
            this.categoryOf = cleanPlacements(parsed.categoryOf);
            this.imports = plain(parsed.imports);
        } catch {
            // Missing or corrupt: start clean, never crash. A corrupt file still counts as there,
            // so the one-time move doesn't run over categories the user has made since.
        }
    }

    /** Persist atomically; the store must survive crashes mid-write. */
    save() {
        try {
            writePrivate(this.file, `${JSON.stringify({ version: 1, categories: this.categories, categoryOf: this.categoryOf, imports: this.imports }, null, 2)}\n`);
            this.exists = true;
        } catch {
            // Best-effort for availability; the next change retries.
        }
    }

    /** The workspaces in a category, in the order they were filed. */
    workspacesInCategory(categoryId) {
        return Object.keys(this.categoryOf).filter((id) => this.categoryOf[id] === categoryId);
    }

    /** Merge fields into a category, made on first use, and persist. */
    putCategory(categoryId, fields) {
        this.categories[categoryId] = { ...this.categories[categoryId], ...fields };
        this.save();
        return this.categories[categoryId];
    }

    /** Forget a category; its workspaces go back to none. */
    removeCategory(categoryId) {
        delete this.categories[categoryId];
        for (const id of this.workspacesInCategory(categoryId)) delete this.categoryOf[id];
        this.save();
    }

    /** Put a workspace in a category, or (categoryId null) in none. A workspace is in one category at most. */
    fileWorkspace(workspaceId, categoryId) {
        if (categoryId === null) delete this.categoryOf[workspaceId];
        else this.categoryOf[workspaceId] = categoryId;
        this.save();
    }

    /** Record a one-time import or move as made. */
    putImport(key, record) {
        this.imports[key] = record;
        this.save();
    }
}

/** The categories in a parsed file: each one an object with a name. */
export function cleanCategories(value) {
    return Object.fromEntries(Object.entries(plain(value))
        .filter(([, c]) => plain(c) === c && typeof c.name === 'string' && c.name.trim() !== ''));
}

/** The placements in a parsed file: workspace id → category id. */
export function cleanPlacements(value) {
    return Object.fromEntries(Object.entries(plain(value)).filter(([, id]) => typeof id === 'string'));
}
