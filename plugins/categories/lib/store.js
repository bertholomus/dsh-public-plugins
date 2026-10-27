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
 *     fleetShell?: { at, file, categories, joined, workspaces, skipped }: the all-in-one mod's old sidebar, imported once,
 *     unusable?: { at }: the store was there but couldn't be used at a start, so neither one-time move runs after it } }
 *
 * The file is written at the plugin's first start, so `exists` says
 * whether that start (and its one-time move) has happened. A file that is
 * there but can't be used (not JSON, another version, unreadable) counts as
 * there: the categories start empty, the log says so, and the file as it
 * was is kept beside the store before a change writes a new one. Its
 * methods change the categories in memory; `save` writes them, and a change
 * that can't be written is undone by the manager (categories.js `commit`).
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
    const DSH_HOME = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    return DSH_HOME === '' ? join(homedir(), '.dsh') : resolve(expand(DSH_HOME));
}

/**
 * Resolve one of the plugin's data paths. One under ~/.dsh lives in DSH's
 * data folder, so a DSH run with its own DSH_HOME (a test copy) keeps its
 * own categories instead of sharing the main one's.
 */
export function dataPath(p) {
    if (p === '~/.dsh' || p.startsWith('~/.dsh/')) return `${dshHome()}${p.slice('~/.dsh'.length)}`; // ~/.dsh is DSH_HOME's default
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
/** Why a file call failed, in a few words: its code (EACCES, ENOSPC, …), else its message. */
const reason = (error) => String(error?.code ?? error?.message ?? error).slice(0, 200);

/**
 * Each start of the plugin reads the file as it is then: a store is never
 * kept in memory across a switch-off or a config reload, so an edit to the
 * file while the plugin was off is what the next start sees and keeps.
 */
export class CategoryStore {
    /**
     * @param {string} file - store path.
     * @param {{ warn?: (text: string) => void }} [options] - warn: the plugin's log, told when the file is there
     *   but can't be used, or can't be written.
     */
    constructor(file, { warn = () => {} } = {}) {
        this.file = dataPath(file);
        this.warn = warn;
        /**
         * A file that was there but couldn't be used: {what: why, in words; text: as read (undefined when it couldn't
         * be read)}, else null.
         */
        this.unusable = null;
        /** Where that file was kept beside the store by the first change after it ({file, what}), else null. */
        this.kept = null;
        /** The last save that failed ({at, reason}: a code such as EACCES, else a message), null since one succeeded. */
        this.unsaved = null;
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
        this.unusable = null;
        this.exists = existsSync(this.file);
        if (!this.exists) return;
        let text;
        let parsed;
        try {
            text = readFileSync(this.file, 'utf8');
            parsed = JSON.parse(text);
        } catch (error) {
            this.unusableFile(text === undefined ? `can't be read (${reason(error)})` : 'is not JSON', text);
            return;
        }
        if (parsed?.version !== 1) {
            this.unusableFile(`is not a categories store of version 1 (its version is ${JSON.stringify(parsed?.version ?? null)})`, text);
            return;
        }
        this.categories = cleanCategories(parsed.categories);
        this.categoryOf = cleanPlacements(parsed.categoryOf);
        this.imports = plain(parsed.imports);
    }

    /**
     * A store file that is there but can't be used. The plugin never stops for it: the categories start empty, and
     * the log says so. It still counts as there, so neither one-time move runs over categories the user made; and
     * before a change writes a new store over it, the file as it was is kept beside it (save).
     */
    unusableFile(what, text) {
        this.unusable = { what, text };
        this.imports = { unusable: { at: new Date().toISOString() } };
        this.warn(`the store ${this.file} ${what}: the categories start empty${text === undefined ? ', and a change writes a new store over it' : ', and the file as it was is kept beside it before a change writes a new one'}`);
    }

    /**
     * Persist atomically; the store must survive crashes mid-write. A file that couldn't be used is first kept beside
     * the store as it was (`<store>.unreadable-<time>`); if that copy can't be made, the store isn't written over it.
     * A write that fails is logged and kept in `unsaved` (for the window); `after` says in the log what happens to the
     * change (the manager undoes a change it can't write; a one-time move runs again at the next start).
     * @returns whether the store was written.
     */
    save(after = 'the next start tries again') {
        try {
            if (this.unusable?.text !== undefined) {
                const copy = `${this.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
                writePrivate(copy, this.unusable.text);
                this.kept = { file: copy, what: this.unusable.what };
                this.warn(`the store that couldn't be used is kept in ${copy}`);
            }
            this.unusable = null;
            writePrivate(this.file, `${JSON.stringify({ version: 1, categories: this.categories, categoryOf: this.categoryOf, imports: this.imports }, null, 2)}\n`);
            this.exists = true;
            this.unsaved = null;
            return true;
        } catch (error) {
            this.unsaved = { at: new Date().toISOString(), reason: reason(error) };
            this.warn(`could not save the categories in ${this.file} (${reason(error)}): ${after}`);
            return false;
        }
    }

    /** What is in memory now, to put back when a change can't be written (`restore`). */
    snapshot() {
        return structuredClone({ categories: this.categories, categoryOf: this.categoryOf, imports: this.imports });
    }

    /** Put back what `snapshot` took. */
    restore({ categories, categoryOf, imports }) {
        this.categories = categories;
        this.categoryOf = categoryOf;
        this.imports = imports;
    }

    /** The workspaces in a category, in the order they were filed. */
    workspacesInCategory(categoryId) {
        return Object.keys(this.categoryOf).filter((id) => this.categoryOf[id] === categoryId);
    }

    /** Merge fields into a category, made on first use (in memory: `save` writes it). */
    putCategory(categoryId, fields) {
        this.categories[categoryId] = { ...this.categories[categoryId], ...fields };
        return this.categories[categoryId];
    }

    /** Forget a category; its workspaces go back to none (in memory). */
    removeCategory(categoryId) {
        delete this.categories[categoryId];
        for (const id of this.workspacesInCategory(categoryId)) delete this.categoryOf[id];
    }

    /** Put a workspace in a category, or (categoryId null) in none (in memory). A workspace is in one category at most. */
    fileWorkspace(workspaceId, categoryId) {
        if (categoryId === null) delete this.categoryOf[workspaceId];
        else this.categoryOf[workspaceId] = categoryId;
    }

    /** Record a one-time import or move as made, and persist it with what it brought (a failure: the next start runs it again). */
    putImport(key, record) {
        this.imports[key] = record;
        return this.save();
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
