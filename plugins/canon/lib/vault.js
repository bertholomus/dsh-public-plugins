/**
 * The canon vault as Canon reads it: a walk of the vault folder that skips
 * hidden folders (.obsidian, .trash, .git), links and anything not
 * Markdown; each note read once and again only when its time or size
 * changes; the active notes in the search index (search.js); the drafts
 * folder's notes listed for the page, never indexed.
 *
 * Reading never writes and never throws at its callers: a folder that is
 * missing or may not be read is a state with words for the page. Nothing
 * blocks DSH: every read is asynchronous, a recall waits at most a moment
 * for a fresh read and otherwise uses the index it has.
 *
 * @module dsh-plugin-canon/vault
 */
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { displayPath } from './config.js';
import { field, noteOf, parseNote } from './frontmatter.js';
import { Index, folderKeys } from './search.js';
import { distinctTerms, terms } from './text.js';

/** The most notes Canon reads; past it the page says the vault was cut short. */
export const MAX_NOTES = 20000;
/** The most of one note Canon reads. */
export const MAX_NOTE_BYTES = 256 * 1024;
/** A read older than this is refreshed before a recall. */
export const STALE_MS = 5000;
/** How long a recall waits for a fresh read before it uses the index it has. */
export const WAIT_MS = 800;
/** Drafts listed on the page, at most. */
const MAX_DRAFTS = 200;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read at most `max` bytes of a file as text. */
export async function readHead(path, max = MAX_NOTE_BYTES) {
    const handle = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(max);
        const { bytesRead } = await handle.read(buffer, 0, max, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await handle.close();
    }
}

/** Run `fn` over `items`, `limit` at a time. */
async function each(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next;
            next += 1;
            await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A folder problem in words: what is wrong and what to do. */
export function folderProblem(error, display) {
    const code = error?.code;
    if (code === 'ENOENT') return { code: 'missing', text: `The vault folder ${display} does not exist. Check the folder in Canon's settings, or create it.` };
    if (code === 'ENOTDIR') return { code: 'not-a-folder', text: `${display} is a file, not a folder. Set Canon's vault to the vault's folder.` };
    if (code === 'EACCES' || code === 'EPERM') {
        return { code: 'no-access', text: `DSH may not read ${display}. Give DSH access to it (on a Mac: System Settings, Privacy & Security, Files and Folders), or choose another folder.` };
    }
    return { code: 'unreadable', text: `Canon could not read ${display} (${String(error?.message ?? error).slice(0, 160)}). Check the folder, then read it again.` };
}

/** Whether a vault path is in the drafts folder (compared without case: a Mac's disk ignores it). */
const inFolder = (rel, folder) => Boolean(folder) && (rel.toLowerCase() === folder.toLowerCase() || rel.toLowerCase().startsWith(`${folder.toLowerCase()}/`));

/** How much of a draft's words the page shows. */
const PREVIEW_CHARS = 240;

/**
 * Markdown as the plain words a person reads in a preview: no title line,
 * heading signs, emphasis, code marks, fences, quote or list signs, link
 * addresses or HTML tags; one line.
 */
export function plainText(markdown) {
    return String(markdown ?? '')
        .replace(/^\s*#{1,6}\s+.*$/m, '')
        .replace(/^\s*(?:```|~~~).*$/gm, '')
        .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
        .replace(/^\s*#{1,6}\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>\n]+>/g, '')
        .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
        .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
        .replace(/`+([^`\n]*)`+/g, '$1')
        .replace(/\s*\|\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** A draft as the page lists it: title, kind, when, from which session, and its status. */
function draftOf(rel, text, file) {
    const { data, body } = parseNote(text);
    const note = noteOf(rel, text);
    const source = isRecord(field(data, 'source')) ? field(data, 'source') : {};
    const created = Date.parse(String(field(data, 'created') ?? ''));
    const kind = field(data, 'kind');
    return {
        path: rel,
        title: note.title,
        kind: typeof kind === 'string' ? kind.toLowerCase().slice(0, 30) : '',
        status: note.status || 'draft',
        created: Number.isFinite(created) ? created : file.mtimeMs,
        sessionId: typeof source.session === 'string' ? source.session.slice(0, 200) : '',
        turn: Number.isSafeInteger(source.turn) ? source.turn : undefined,
        folder: typeof source.folder === 'string' ? source.folder.slice(0, 400) : '',
        preview: cut(plainText(body), PREVIEW_CHARS),
        mtimeMs: file.mtimeMs,
    };
}

export class Vault {
    /**
     * @param {object} options
     * @param {() => { vault: string, draftsFolder: string }} options.where - the vault and its drafts folder now ('' when
     *   none is set, or Canon is not working).
     * @param {{ warn?: Function, info?: Function }} [options.logger]
     * @param {(change: { kind: string, before?: object, after: object }) => void} [options.onChange] - the state moved.
     * @param {() => number} [options.now]
     * @param {string} [options.home] - for paths in words.
     */
    constructor({ where, logger, onChange, now = Date.now, home }) {
        this.where = where;
        this.logger = logger;
        this.onChange = onChange;
        this.now = now;
        this.home = home;
        this.reset('');
        this.running = undefined;
        this.generation = 0;
        this.state = { state: 'unset' };
    }

    /** Forget everything read (another vault, or another drafts folder). */
    reset(key) {
        this.key = key;
        this.index = new Index();
        /** Vault path → { mtimeMs, size, kind: 'note' | 'draft' | 'other' | 'unreadable' }. */
        this.files = new Map();
        this.draftsByPath = new Map();
    }

    /**
     * The vault's state for the page: unset, reading, ok or error, with
     * counts and when it was read. A state belongs to the folder it was
     * read from: after the vault folder changes, the earlier folder's words
     * and counts are not shown for the new one, which is "reading" until
     * its own read ends.
     */
    status() {
        const where = this.where();
        const own = this.state.state === 'unset' ? !where.vault : this.state.vault === where.vault;
        const counts = { notes: 0, active: 0, drafts: 0, other: 0, unreadable: 0 };
        if (own) {
            Object.assign(counts, { notes: this.files.size, active: this.index.size, drafts: this.draftsByPath.size });
            for (const f of this.files.values()) {
                if (f.kind === 'other') counts.other += 1;
                else if (f.kind === 'unreadable') counts.unreadable += 1;
            }
        }
        return {
            ...(own ? this.state : { state: 'reading' }),
            path: where.vault,
            display: displayPath(where.vault, this.home),
            draftsFolder: where.draftsFolder,
            counts,
            reading: Boolean(this.running) || !own,
        };
    }

    /** Read the vault again now (one read at a time; a second caller shares the first's). */
    refresh() {
        if (!this.running) {
            this.running = this.read().catch((error) => {
                this.logger?.warn?.(`canon: reading the vault: ${error?.message ?? error}`);
            }).finally(() => {
                this.running = undefined;
            });
        }
        return this.running;
    }

    /**
     * Read again after something changed the vault (a draft Canon wrote, a
     * promote, a person's "Read again"): a read already under way may have
     * listed the folder before the change, so a new one follows it.
     */
    async again() {
        if (this.running) await this.running;
        return this.refresh();
    }

    /**
     * A fresh enough index: read again when the last read is older than
     * `staleMs`, waiting at most `waitMs` for it (else the index as it is).
     */
    async ready({ staleMs = STALE_MS, waitMs = WAIT_MS } = {}) {
        const where = this.where();
        if (!where.vault) {
            if (this.state.state !== 'unset') await this.refresh();
            return;
        }
        if (this.wanted === `${where.vault}\0${where.draftsFolder}` && this.state.readAt && this.now() - this.state.readAt < staleMs) return;
        const reading = this.refresh();
        let timer;
        await Promise.race([reading, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); })]);
        clearTimeout(timer);
    }

    /**
     * The vault or its drafts folder changed: a read under way stops
     * keeping what it finds, and a new one starts after it.
     */
    settingsChanged() {
        this.generation += 1;
        const again = () => this.refresh();
        if (this.running) void this.running.then(again);
        else void again();
    }

    /** One read: walk, stat, read what changed, index it. */
    async read() {
        const generation = (this.generation += 1);
        const where = this.where();
        const before = this.state;
        this.wanted = `${where.vault}\0${where.draftsFolder}`;
        if (!where.vault) {
            this.reset('');
            this.state = { state: 'unset' };
            if (before.state !== 'unset') this.changed('unset', before);
            return;
        }
        const display = displayPath(where.vault, this.home);
        const started = this.now();
        let root;
        let listed;
        let truncated;
        try {
            root = await realpath(where.vault);
            const st = await stat(root);
            if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
            // A folder that can be looked up may still refuse its listing (no access, a Mac's privacy rules).
            ({ files: listed, truncated } = await this.walk(root));
        } catch (error) {
            if (generation !== this.generation) return;
            this.reset('');
            this.root = undefined;
            this.state = { state: 'error', error: folderProblem(error, display), readAt: this.now(), vault: where.vault };
            if (before.state !== 'error' || before.error?.text !== this.state.error.text) this.changed('error', before);
            return;
        }
        if (generation !== this.generation) return;
        const key = `${root}\0${where.draftsFolder}`;
        if (key !== this.key) this.reset(key);
        this.root = root;
        const seen = new Set();
        const stale = [];
        await each(listed, 32, async (rel) => {
            seen.add(rel);
            let st;
            try {
                st = await stat(join(root, rel));
            } catch {
                return;
            }
            const known = this.files.get(rel);
            if (!known || known.mtimeMs !== st.mtimeMs || known.size !== st.size) stale.push({ rel, mtimeMs: st.mtimeMs, size: st.size });
        });
        if (generation !== this.generation) return;
        for (const rel of [...this.files.keys()]) {
            if (seen.has(rel)) continue;
            this.files.delete(rel);
            this.index.remove(rel);
            this.draftsByPath.delete(rel);
        }
        await each(stale, 8, async (file) => {
            let text;
            try {
                text = await readHead(join(root, file.rel));
            } catch {
                this.files.set(file.rel, { mtimeMs: file.mtimeMs, size: file.size, kind: 'unreadable' });
                this.index.remove(file.rel);
                this.draftsByPath.delete(file.rel);
                return;
            }
            if (generation !== this.generation) return;
            if (inFolder(file.rel, where.draftsFolder)) {
                this.index.remove(file.rel);
                this.draftsByPath.set(file.rel, draftOf(file.rel, text, file));
                this.files.set(file.rel, { mtimeMs: file.mtimeMs, size: file.size, kind: 'draft' });
                return;
            }
            this.draftsByPath.delete(file.rel);
            const note = noteOf(file.rel, text);
            if (note.active) {
                this.index.add(note, file);
                this.files.set(file.rel, { mtimeMs: file.mtimeMs, size: file.size, kind: 'note' });
            } else {
                this.index.remove(file.rel);
                this.files.set(file.rel, { mtimeMs: file.mtimeMs, size: file.size, kind: 'other' });
            }
        });
        if (generation !== this.generation) return;
        this.state = { state: 'ok', readAt: this.now(), took: this.now() - started, truncated, changed: stale.length, vault: where.vault };
        if (before.state !== 'ok' || stale.length > 0 || before.truncated !== truncated) this.changed(before.state === 'ok' ? 'changed' : 'ok', before);
    }

    changed(kind, before) {
        try { this.onChange?.({ kind, before, after: this.status() }); } catch { /* a listener never stops a read */ }
    }

    /** The vault's Markdown files (vault paths), skipping hidden folders, links and other files; at most MAX_NOTES. */
    async walk(root) {
        const files = [];
        const folders = [''];
        let truncated = false;
        while (folders.length && !truncated) {
            const rel = folders.pop();
            let entries;
            try {
                entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
            } catch (error) {
                if (!rel) throw error;
                continue;
            }
            entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
                const path = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) folders.push(path);
                else if (entry.isFile() && /\.md$/i.test(entry.name)) {
                    if (files.length >= MAX_NOTES) {
                        truncated = true;
                        break;
                    }
                    files.push(path);
                }
            }
        }
        return { files, truncated };
    }

    /** The drafts folder's notes, newest first. */
    drafts() {
        return [...this.draftsByPath.values()].sort((a, b) => b.created - a.created || a.path.localeCompare(b.path)).slice(0, MAX_DRAFTS);
    }

    /**
     * The active notes that fit a prompt (search.js), for a session's folder.
     * @param {string} prompt
     * @param {{ folder?: string, limit?: number }} [options]
     */
    search(prompt, { folder = '', limit = 10 } = {}) {
        const keys = folderKeys(folder, this.home);
        return { ...this.index.search(prompt, { folder: keys, limit }), folder: keys };
    }

    /**
     * The passage of a note that best fits the prompt's terms, read fresh
     * from the file: its best paragraph (and the next, when there is room),
     * under the heading it sits in; the note's start when no paragraph has
     * a prompt word. At most `budget` characters; undefined when the note
     * cannot be read or is no longer active.
     * @param {string} rel - the note's vault path.
     * @param {string[]} queryTerms
     * @param {number} budget
     */
    async passage(rel, queryTerms, budget) {
        if (!this.root || !this.index.has(rel)) return undefined;
        let text;
        try {
            text = await readHead(join(this.root, rel));
        } catch {
            return undefined;
        }
        const note = noteOf(rel, text);
        if (!note.active) return undefined;
        return bestPassage(note.body, queryTerms, budget);
    }
}

/**
 * The paragraphs of a body, each with the heading it sits under; code
 * fences stay whole.
 */
export function paragraphs(body) {
    const out = [];
    let heading = '';
    let current = [];
    let fenced = false;
    const flush = () => {
        const text = current.join('\n').trim();
        if (text) out.push({ heading, text });
        current = [];
    };
    for (const line of String(body ?? '').split(/\r?\n/)) {
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            current.push(line);
            if (!fenced) flush();
            continue;
        }
        if (!fenced && /^#{1,6}\s+\S/.test(line)) {
            flush();
            heading = line.replace(/^#{1,6}\s+/, '').replace(/[\s#]+$/, '').trim();
            continue;
        }
        if (!fenced && line.trim() === '') {
            flush();
            continue;
        }
        current.push(line);
    }
    flush();
    return out;
}

/** Cut text to at most `max` characters, at a line or word end when one is near, with "…". */
export function cut(text, max) {
    const t = String(text ?? '').trim();
    if (t.length <= max) return t;
    if (max <= 1) return '';
    const head = t.slice(0, max - 1);
    const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
    return `${(at > max * 0.6 ? head.slice(0, at) : head).trimEnd()}…`;
}

/** The best passage of a body for a prompt's terms, at most `budget` characters. */
export function bestPassage(body, queryTerms, budget) {
    const wanted = new Set(queryTerms);
    const parts = paragraphs(body);
    if (parts.length === 0 || budget < 20) return '';
    let best = -1;
    let bestScore = 0;
    parts.forEach((p, i) => {
        const hits = distinctTerms(`${p.heading} ${p.text}`).filter((t) => wanted.has(t)).length;
        const all = terms(p.text).filter((t) => wanted.has(t)).length;
        const score = hits * 2 + Math.min(all, 6) * 0.25;
        if (score > bestScore) {
            best = i;
            bestScore = score;
        }
    });
    const start = best < 0 ? 0 : best;
    const chosen = parts[start];
    let text = chosen.heading && best >= 0 ? `${chosen.heading}: ${chosen.text}` : chosen.text;
    const next = parts[start + 1];
    if (next && next.heading === chosen.heading && text.length + next.text.length + 1 <= budget) text = `${text}\n${next.text}`;
    return cut(text, budget);
}
