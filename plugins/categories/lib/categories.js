/**
 * Categories: named sets of DSH workspaces, in the user's order, drawn
 * above their workspaces in DSH's session list. A workspace is in one
 * category at most; the ones in none are "Other workspaces". The manager
 * keeps them in the plugin's own store (store.js) and keeps DSH's own
 * workspace order in step, so DSH's list holds each category's workspaces
 * together. At its first start it makes two one-time moves (plan.js): the
 * categories the projects plugin kept before this plugin, and the all-in-one
 * mod's old sidebar projects. It reads the projects plugin's store that
 * once, and never writes it.
 *
 * @module dsh-plugin-categories/categories
 */
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CategoryStore, dataPath, dshHome, ensurePrivateDir } from './store.js';
import { planFleetShellImport, planFromProjects } from './plan.js';

/** DSH keeps a session title to 80 bytes of UTF-8; a category name is held to the same. */
const NAME_BYTES = 80;

/** A refusal the user can act on: the window shows its message. */
export class CategoryError extends Error {}

/** A path for people to read: the home folder as ~. */
export function shownPath(path) {
    const home = homedir();
    return typeof path === 'string' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : String(path);
}

/** Why a file can't be written, in words (store.js keeps the code: EACCES, ENOSPC, …). */
export function saveReason(code) {
    const words = {
        EACCES: 'no permission to write it', EPERM: 'no permission to write it', ENOSPC: 'the disk is full', EDQUOT: 'the disk quota is used up',
        EROFS: 'the disk is read-only', EISDIR: 'a folder is in the way', ENOTDIR: 'a file is in the way of its folder', EBUSY: 'it is busy',
    };
    return words[code] ?? String(code ?? 'unknown').slice(0, 120);
}

/** A name compared as people read it: one line, any case. */
const nameKey = (name) => String(name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One line in the plugin's log file: its time, then the line. The folder is
 * made 700 and the file 600; a log that cannot be written never fails the
 * plugin. It is the plugin's own because DSH 0.2 writes no plugin's log
 * lines out (they stay in its logger's memory).
 * @param {string} file - the log's path ('' for no log).
 * @param {string} line - one line (line breaks become spaces).
 * @returns whether the line reached the file.
 */
export function appendLog(file, line) {
    if (!file) return false;
    try {
        ensurePrivateDir(dirname(file));
        appendFileSync(file, `${new Date().toISOString()} ${String(line).replace(/[\r\n]+/g, ' ')}\n`, { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}

/** A name as the user typed it: one line, cut after the last whole word within 80 bytes, with "…". */
export function clipName(value) {
    const line = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (Buffer.byteLength(line) <= NAME_BYTES) return line;
    const room = NAME_BYTES - Buffer.byteLength('…');
    let fit = '';
    let bytes = 0;
    for (const char of line) {
        bytes += Buffer.byteLength(char);
        if (bytes > room) break;
        fit += char;
    }
    // Back up to the end of the last whole word, unless that would leave less than half.
    if (line[fit.length] !== ' ') {
        const space = fit.lastIndexOf(' ');
        if (space >= fit.length / 2) fit = fit.slice(0, space);
    }
    const end = fit.replace(/[\s.,;:!?…–—-]+$/u, '');
    return `${end === '' ? fit : end}…`;
}

/**
 * Lower-kebab id from a name. Letters in any script are kept (前端 and 后端
 * stay apart); accents are dropped.
 */
export function slugify(name) {
    const slug = String(name ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    return [...slug].slice(0, 48).join('').replace(/-+$/, '') || 'category';
}

/**
 * The indexes of a longest increasing run (not necessarily adjacent) in a
 * list of numbers: the items that can stay where they are while the others
 * move.
 */
export function longestRun(values) {
    const len = values.map(() => 1);
    const prev = values.map(() => -1);
    let best = -1;
    for (let i = 0; i < values.length; i += 1) {
        for (let j = 0; j < i; j += 1) {
            if (values[j] < values[i] && len[j] + 1 > len[i]) {
                len[i] = len[j] + 1;
                prev[i] = j;
            }
        }
        if (best < 0 || len[i] > len[best]) best = i;
    }
    const out = [];
    for (let i = best; i >= 0; i = prev[i]) out.unshift(i);
    return out;
}

/**
 * Write a copy as `<dir>/<name>.json`, mode 600, or `<name>-2.json` and so on
 * when one is there already: a copy is never overwritten. @returns its path.
 */
export function keepCopy(dir, name, text) {
    ensurePrivateDir(dir);
    for (let n = 1; ; n += 1) {
        const file = join(dir, `${name}${n === 1 ? '' : `-${n}`}.json`);
        try {
            writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (error?.code === 'EEXIST') continue;
            throw error;
        }
        chmodSync(file, 0o600);
        return file;
    }
}

/** One pass over DSH's workspace order at a time, for every manager in this process. */
let ordering = Promise.resolve();

export class CategoryManager {
    /**
     * @param {object} options
     * @param {object} options.ctx - the plugin's context: workspaceRegistry, logger.
     * @param {object} options.config - the plugin's config (index.js).
     */
    constructor({ ctx, config, warn }) {
        this.ctx = ctx;
        this.config = config;
        this.logFile = config.logFile ? dataPath(config.logFile) : '';
        /** A warning in words: DSH's logger and the plugin's own log (index.js), else its log alone. */
        this.warn = typeof warn === 'function' ? warn : (text) => this.log(`warn ${text}`);
        /** Read from the file now: a switch-off or config reload left nothing in memory. */
        this.store = new CategoryStore(config.storeFile, { warn: (text) => this.warn(text) });
        this.disposed = false;
    }

    /** One line in the action log (mode 600): ids and counts, and what went wrong, in words. */
    log(line) {
        appendLog(this.logFile, line);
    }

    /** The one-time moves, then DSH's workspace order in step with the categories. */
    async start() {
        this.moveFromProjects();
        this.importFleetShell();
        await this.syncWorkspaceOrder();
    }

    /**
     * Switched off, or replaced by a config reload: this manager changes
     * nothing more. The next start reads the store from its file again.
     */
    dispose() {
        this.disposed = true;
    }

    /** DSH's workspace with this id, or undefined. */
    workspace(workspaceId) {
        try {
            return typeof workspaceId === 'string' && workspaceId !== '' ? this.ctx.workspaceRegistry?.get?.(workspaceId) : undefined;
        } catch {
            return undefined;
        }
    }

    /** DSH's workspaces in its own (sidebar) order. */
    workspaceList() {
        try {
            const list = this.ctx.workspaceRegistry?.list?.();
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    /**
     * Once, at the first start (before this plugin's store exists): the
     * categories the projects plugin kept come over, with the same ids,
     * names, order and workspaces (plan.js). Its store is read, never
     * written; it is copied here first (from-projects.json, never
     * overwritten) when it holds anything to move. A store that can't be read (other than missing)
     * leaves the move for the next start.
     */
    moveFromProjects() {
        if (this.disposed || this.store.exists) return;
        const file = this.config.projectsStoreFile ? dataPath(this.config.projectsStoreFile) : '';
        let text = '';
        if (file) {
            try {
                text = readFileSync(file, 'utf8');
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    this.log(`error move from projects ${String(error?.message ?? error).slice(0, 200)}`);
                    return;
                }
            }
        }
        let stored = {};
        if (text !== '') {
            try {
                stored = JSON.parse(text);
            } catch (error) {
                this.log(`error move from projects ${String(error?.message ?? error).slice(0, 200)}`);
                return;
            }
        }
        const now = new Date().toISOString();
        const plan = planFromProjects(stored, now);
        const made = plan.order.length;
        const filed = Object.keys(plan.categoryOf).length;
        let backup = '';
        if (made > 0 || plan.fleetShell) {
            try {
                backup = keepCopy(dirname(this.store.file), 'from-projects', text);
            } catch (error) {
                this.log(`error move from projects backup ${String(error?.message ?? error).slice(0, 200)}`);
                return;
            }
        }
        this.store.categories = plan.categories;
        this.store.categoryOf = plan.categoryOf;
        if (plan.fleetShell) this.store.imports.fleetShell = plan.fleetShell;
        this.store.putImport('projects', {
            at: now, file, from: plan.from, categories: made, workspaces: filed,
            ...(plan.projects.length > 0 ? { projects: plan.projects } : {}),
            ...(backup ? { backup } : {}),
        });
        if (made > 0 || plan.fleetShell) this.log(`move from projects from=${plan.from} categories=${made} workspaces=${filed}${plan.projects.length > 0 ? ` projects=${plan.projects.length}` : ''} backup=${backup}`);
    }

    /**
     * Once, bring in the projects of the all-in-one mod's old sidebar
     * (`<DSH home>/fleet-shell/state.json`): each old project becomes a
     * category here, in the same order, holding the same DSH workspaces.
     * Only names and which workspaces each held come over: the old file's
     * instructions, files and defaults are not read. A name that is already
     * a category here joins it. A workspace DSH no longer has, or one
     * already in a category here, stays where it is. The old file is only
     * read. A file that can't be read (other than missing) is tried again at
     * the next start.
     *
     * Only for a DSH whose categories never lived in the projects plugin's
     * store: when that store had categories, they are the user's as they
     * left them (some made from this same file, perhaps deleted since), so
     * the old file is not read at all.
     */
    importFleetShell() {
        if (this.disposed || this.store.imports.fleetShell || this.store.imports.projects?.from === 'categories' || this.store.imports.unusable) return;
        const file = join(dshHome(), 'fleet-shell', 'state.json');
        let state;
        try {
            state = JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
            if (error?.code !== 'ENOENT') this.log(`error import fleet-shell ${String(error?.message ?? error).slice(0, 200)}`);
            return;
        }
        const plan = planFleetShellImport(state, {
            names: new Map(this.categoryEntries().map(([id, c]) => [String(c.name).trim().toLowerCase(), id])),
            known: (workspaceId) => Boolean(this.workspace(workspaceId)),
            placed: (workspaceId) => Boolean(this.store.categories[this.store.categoryOf[workspaceId]]),
        });
        let made = 0;
        let placed = 0;
        const ids = [];
        for (const group of plan.groups) {
            let id = group.join;
            if (!id) {
                id = this.makeCategory(group.name, 'import', { importedFrom: group.from });
                this.log(`category-new ${id} import`);
                ids.push(id);
                made += 1;
            }
            for (const workspaceId of group.workspaces) {
                this.store.categoryOf[workspaceId] = id;
                placed += 1;
            }
        }
        const joined = plan.groups.length - made;
        const skipped = plan.skipped.length;
        // `made`: the categories this import made, which the Categories page names in its note (a record the projects
        // plugin kept of its own import has none, so categories it imported weeks ago aren't named as new here).
        this.store.putImport('fleetShell', { at: new Date().toISOString(), file, categories: made, joined, workspaces: placed, skipped, made: ids });
        this.log(`import fleet-shell categories=${made} joined=${joined} workspaces=${placed} skipped=${skipped}`);
    }

    /** The categories in their order, as [id, definition]. */
    categoryEntries() {
        const at = (c) => (Number.isFinite(c?.order) ? c.order : Infinity);
        return Object.entries(this.store.categories).map(([id, c], i) => ({ id, c, i }))
            .sort((a, b) => at(a.c) - at(b.c) || a.i - b.i)
            .map(({ id, c }) => [id, c]);
    }

    /** A refusal once this manager is stopped: a late call must not write over the store a new start read. */
    requireLive() {
        if (this.disposed) throw new CategoryError('the categories plugin was switched off or reloaded; try again');
    }

    /** A category the window names, or a refusal. */
    requireCategory(categoryId) {
        const category = typeof categoryId === 'string' ? this.store.categories[categoryId] : undefined;
        if (!category) throw new CategoryError(`"${String(categoryId ?? '').slice(0, 80)}" is not a category here`);
        return category;
    }

    /**
     * Every category in its order, with the workspaces it holds in DSH's
     * order (only ones DSH has), for the session list and the Categories page.
     * `imported` marks the ones this plugin's own import of the old sidebar
     * made, which the page names in a note.
     */
    listCategories() {
        const order = this.workspaceList();
        const made = this.store.imports.fleetShell?.made;
        const mine = new Set(Array.isArray(made) ? made.filter((id) => typeof id === 'string') : []);
        return this.categoryEntries().map(([id, c]) => ({
            id,
            name: c.name,
            source: typeof c.source === 'string' ? c.source : 'page',
            ...(typeof c.importedFrom === 'string' ? { importedFrom: c.importedFrom } : {}),
            ...(mine.has(id) ? { imported: true } : {}),
            workspaces: order.filter((ws) => this.store.categoryOf[ws.id] === id).map((ws) => ({ id: ws.id, path: ws.path, title: ws.title })),
        }));
    }

    /**
     * What the Categories page says about the store, or null while all is
     * well: a save that failed (each change is undone until one can be
     * written), a file that couldn't be used at the start, and where the
     * first change after that kept it.
     * @returns {{problem: 'unsaved' | 'unusable' | 'kept', text: string} | null}
     */
    storeNote() {
        const { unsaved, unusable, kept } = this.store;
        const file = shownPath(this.store.file);
        if (unsaved) return { problem: 'unsaved', text: `The categories can't be saved in ${file} (${saveReason(unsaved.reason)}), so a change made now is undone. Each change tries again.` };
        if (unusable) return { problem: 'unusable', text: `${file} ${unusable.what}, so the categories started empty. The file is left as it is: the first change keeps it beside the new store, to put back by hand.` };
        if (kept) return { problem: 'kept', text: `${file} ${kept.what} at the start, so the categories started empty. It is kept as ${basename(kept.file)} in the same folder: put it back by hand, with DSH stopped, to bring them back.` };
        return null;
    }

    /**
     * One change to the categories, written to the store at once. When the
     * store can't be written, the change is undone and refused in words, so
     * neither the window nor the log claims what the next start would lose.
     * @param change - makes the change in memory (the store's methods); its result is returned.
     */
    commit(change) {
        const before = this.store.snapshot();
        const result = change();
        if (!this.store.save('the change is undone, and the next change tries again')) {
            this.store.restore(before);
            throw new CategoryError(`not saved: ${shownPath(this.store.file)} can't be written (${saveReason(this.store.unsaved?.reason)}), so nothing changed. Try again once it can be`);
        }
        return result;
    }

    /** A new category, last in the list (in memory: the caller saves it). @returns its id. */
    makeCategory(name, source, extra = {}) {
        const base = slugify(name);
        let id = base;
        for (let n = 2; this.store.categories[id] !== undefined; n += 1) id = `${base}-${n}`;
        const orders = Object.values(this.store.categories).map((c) => (Number.isFinite(c?.order) ? c.order : -1));
        this.store.putCategory(id, { name, order: Math.max(-1, ...orders) + 1, createdAt: new Date().toISOString(), source, ...extra });
        return id;
    }

    /**
     * A category name as the user typed it: one line, at most 80 bytes, and
     * no other category's name (in any case).
     * @param self - the category being renamed, which may keep its own name in another case.
     */
    categoryName(value, self = null) {
        const name = clipName(typeof value === 'string' ? value : '');
        if (name === '') throw new CategoryError('a category needs a name');
        const twin = this.categoryEntries().find(([id, c]) => id !== self && nameKey(c.name) === nameKey(name));
        if (twin) throw new CategoryError(`there is a category named ${twin[1].name} already`);
        return name;
    }

    /**
     * A new category, last in the list, optionally holding a workspace from
     * the start. @returns its id.
     */
    async createCategory(name, workspaceId) {
        this.requireLive();
        const clean = this.categoryName(name);
        if (workspaceId !== undefined && !this.workspace(workspaceId)) throw new CategoryError('DSH has no such workspace');
        const id = this.commit(() => {
            const made = this.makeCategory(clean, 'page');
            if (workspaceId !== undefined) this.store.fileWorkspace(workspaceId, made);
            return made;
        });
        this.log(`category-new ${id} page`);
        if (workspaceId !== undefined) {
            this.log(`workspace ${workspaceId} category=${id}`);
            await this.syncWorkspaceOrder({ move: workspaceId });
        }
        return id;
    }

    renameCategory(categoryId, name) {
        this.requireLive();
        const category = this.requireCategory(categoryId);
        const clean = this.categoryName(name, categoryId);
        if (clean === category.name) return;
        this.commit(() => this.store.putCategory(categoryId, { name: clean }));
        this.log(`category-rename ${categoryId}`);
    }

    /** Delete a category: its workspaces and their chats stay in DSH, in Other workspaces. */
    async removeCategory(categoryId) {
        this.requireLive();
        this.requireCategory(categoryId);
        this.commit(() => this.store.removeCategory(categoryId));
        this.log(`category-delete ${categoryId}`);
        await this.syncWorkspaceOrder();
    }

    /** Move a category before another one, or (before null) to the end. */
    async moveCategory(categoryId, beforeId) {
        this.requireLive();
        this.requireCategory(categoryId);
        const before = typeof beforeId === 'string' && beforeId !== '' ? beforeId : null;
        if (before !== null) this.requireCategory(before);
        if (before === categoryId) return;
        const ids = this.categoryEntries().map(([id]) => id).filter((id) => id !== categoryId);
        ids.splice(before === null ? ids.length : ids.indexOf(before), 0, categoryId);
        this.commit(() => ids.forEach((id, i) => { this.store.categories[id].order = i; }));
        this.log(`category-move ${categoryId} before=${before ?? 'end'}`);
        await this.syncWorkspaceOrder();
    }

    /**
     * Put a DSH workspace in a category, or (categoryId null) in none,
     * before another workspace there or (beforeId null) after the last. A
     * workspace is in one category at most. DSH's own workspace order is
     * kept in step, so its list holds each category's workspaces together.
     */
    async fileWorkspace(workspaceId, categoryId, beforeId = null) {
        this.requireLive();
        if (!this.workspace(workspaceId)) throw new CategoryError('DSH has no such workspace');
        if (categoryId !== null) this.requireCategory(categoryId);
        const before = typeof beforeId === 'string' && beforeId !== '' && beforeId !== workspaceId ? beforeId : null;
        if (before !== null) {
            if (!this.workspace(before)) throw new CategoryError('DSH has no such workspace');
            if ((this.store.categoryOf[before] ?? null) !== categoryId) throw new CategoryError('that workspace is in another category');
        }
        if ((this.store.categoryOf[workspaceId] ?? null) !== categoryId) {
            this.commit(() => this.store.fileWorkspace(workspaceId, categoryId));
            this.log(`workspace ${workspaceId} category=${categoryId ?? 'none'}`);
        }
        await this.syncWorkspaceOrder({ move: workspaceId, before: before ?? undefined });
    }

    /**
     * Keep DSH's workspace order (one list for every window, which DSH's
     * session list draws) in category order: each category's workspaces
     * together, the categories in their order, then the workspaces in none.
     * Within each, DSH's order holds, except for `move`, which lands before
     * `before` or last. So DSH's list reads in the order the session list
     * shows it, with the categories' headers among it, and a screen reader
     * hears each workspace after its category. Moves as few workspaces as it
     * can, through the call DSH's own workspace drag makes.
     */
    async syncWorkspaceOrder({ move, before } = {}) {
        const registry = this.ctx.workspaceRegistry;
        if (typeof registry?.insertBefore !== 'function') return;
        const run = async () => {
            if (this.disposed) return;
            const current = this.workspaceList().map((ws) => ws.id);
            const bucket = (id) => (this.store.categories[this.store.categoryOf[id]] ? this.store.categoryOf[id] : null);
            const groups = new Map(this.categoryEntries().map(([id]) => [id, []]));
            const loose = [];
            const listOf = (id) => (bucket(id) === null ? loose : groups.get(bucket(id)));
            for (const id of current) if (id !== move) listOf(id).push(id);
            if (move !== undefined && current.includes(move)) {
                const list = listOf(move);
                const at = before === undefined ? -1 : list.indexOf(before);
                list.splice(at < 0 ? list.length : at, 0, move);
            }
            const wanted = [...[...groups.values()].flat(), ...loose];
            const keep = new Set(longestRun(wanted.map((id) => current.indexOf(id))).map((k) => wanted[k]));
            let moves = 0;
            // From the end, each moved workspace lands before the one that follows it.
            for (let k = wanted.length - 1; k >= 0; k -= 1) {
                if (keep.has(wanted[k])) continue;
                await registry.insertBefore(wanted[k], wanted[k + 1]);
                moves += 1;
            }
            if (moves > 0) this.log(`workspace-order moves=${moves}`);
        };
        // One pass at a time; a call during one runs once it ends.
        const next = ordering.then(run).catch((error) => {
            this.log(`error workspace-order ${String(error?.message ?? error).slice(0, 200)}`);
        });
        ordering = next;
        return next;
    }
}
