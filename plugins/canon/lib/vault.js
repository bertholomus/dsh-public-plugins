/**
 * The canon vault as Canon reads it: a walk of the vault folder that skips
 * hidden folders (.obsidian, .trash, .git), links and anything not
 * Markdown; each note read once and again only when its time or size
 * changes; the active notes in the search index (search.js); the drafts
 * folder's notes listed for the page, never indexed.
 *
 * Reading never writes and never throws at its callers: a folder that is
 * missing or may not be read is a state with words for the page, and a
 * folder inside the vault that may not be listed is named on it. Nothing
 * blocks DSH: every read is asynchronous, a recall waits at most a moment
 * for a fresh read and otherwise uses the index it has.
 *
 * @module dsh-plugin-canon/vault
 */
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { displayPath } from './config.js';
import { field, noteOf, parseNote } from './frontmatter.js';
import { Index, folderKeys, projectsOf } from './search.js';
import { EVERYDAY, distinctTerms, terms } from './text.js';

/** The most notes Canon reads; past it the page says the vault was cut short. */
export const MAX_NOTES = 20000;
/** The most of one note Canon reads. */
export const MAX_NOTE_BYTES = 256 * 1024;
/** A read older than this is refreshed before a recall. */
export const STALE_MS = 5000;
/** How long a recall waits for a fresh read before it uses the index it has. */
export const WAIT_MS = 800;
/** Folders inside the vault that may not be listed, named at most (all are counted). */
export const MAX_CLOSED_NAMED = 20;
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

/**
 * What What happened says about the folders inside the vault Canon may not
 * list, against the set it said last (Canon keeps that set across
 * restarts): nothing when the set is the same, so a restart, a fixed
 * setting or another read that finds the same folders adds nothing; once
 * when every folder reads again. `kept` is the set to keep from now on.
 * @param {{ vault: string, names: string[], count: number } | undefined} last - the set said last.
 * @param {object} after - the vault's status now (Vault.status()).
 * @returns {{ kept: { vault: string, names: string[], count: number }, entry?: object } | undefined}
 */
export function closedChange(last, after) {
    const same = last?.vault !== undefined && last.vault === after.path;
    const was = same ? last.names ?? [] : [];
    const wasCount = same ? last.count ?? 0 : 0;
    const now = after.closed ?? [];
    const count = after.counts?.closed ?? now.length;
    const kept = { vault: after.path, names: now, count };
    if (was.join('\n') === now.join('\n') && wasCount === count) return same || count > 0 ? undefined : { kept };
    if (count === 0) return { kept, ...(wasCount > 0 ? { entry: { kind: 'vault', state: 'done', text: 'Every folder in the vault can be read again' } } : {}) };
    return { kept, entry: { kind: 'vault', state: 'failed', text: closedText(now, count), why: closedWhat(count) } };
}

/** closedChange's entry, against the vault's state before a read (as Vault.read() keeps it). */
export function closedEntry(before, after) {
    const last = before?.vault !== undefined ? { vault: before.vault, names: before.closed ?? [], count: before.closedCount ?? 0 } : undefined;
    return closedChange(last, after)?.entry;
}

/** "1 folder Canon may not read: Projects/osprey-mobile" (the first few named). */
export function closedText(names, count = names.length) {
    const shown = names.slice(0, 5);
    const more = count - shown.length;
    return `${count} folder${count === 1 ? '' : 's'} Canon may not read: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

/** What to do about folders Canon may not read. */
export const closedWhat = (count) => `${count === 1 ? 'Its' : 'Their'} notes are never added to turns. Give DSH access to ${count === 1 ? 'it' : 'them'} (${count === 1 ? 'its' : 'their'} permissions, or on a Mac System Settings, Privacy & Security, Files and Folders), then read the vault again.`;

/** Whether a vault path is in the drafts folder (compared without case: a Mac's disk ignores it). */
const inFolder = (rel, folder) => Boolean(folder) && (rel.toLowerCase() === folder.toLowerCase() || rel.toLowerCase().startsWith(`${folder.toLowerCase()}/`));

/** How much of a draft's words the page shows: in its row, and when a person opens the whole draft. */
const PREVIEW_CHARS = 240;
export const DRAFT_BODY_CHARS = 8000;
/** A note shares a draft's subject when it covers this much of what the draft says (search.js's share). */
const RELATED_SHARE = 1 / 3;

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
        // The whole draft as written, for a person to read before Promote or Discard (its title line is the row's title).
        body: cut(String(body ?? '').replace(/^\s*#\s+[^\n]*\n?/, '').trim(), DRAFT_BODY_CHARS),
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
        const counts = { notes: 0, active: 0, drafts: 0, other: 0, unreadable: 0, closed: 0, addressed: 0 };
        const addressed = [];
        if (own) {
            Object.assign(counts, { notes: this.files.size, active: this.index.size, drafts: this.draftsByPath.size, closed: this.state.closedCount ?? 0 });
            for (const [rel, f] of this.files) {
                if (f.kind === 'other') counts.other += 1;
                else if (f.kind === 'unreadable') counts.unreadable += 1;
                else if (f.addressed) addressed.push(rel);
            }
            counts.addressed = addressed.length;
            addressed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        }
        return {
            ...(own ? this.state : { state: 'reading' }),
            // The folders inside the vault it may not list, by their vault paths (the first few).
            closed: own ? this.state.closed ?? [] : [],
            // The active notes with a line addressed to agents, which turns leave out (the first few).
            addressed: addressed.slice(0, MAX_CLOSED_NAMED),
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
        let closed;
        try {
            root = await realpath(where.vault);
            const st = await stat(root);
            if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
            // A folder that can be looked up may still refuse its listing (no access, a Mac's privacy rules).
            ({ files: listed, truncated, closed } = await this.walk(root));
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
                const addressed = addressedLines(note.body);
                this.files.set(file.rel, { mtimeMs: file.mtimeMs, size: file.size, kind: 'note', ...(addressed ? { addressed } : {}) });
            } else {
                this.index.remove(file.rel);
                this.files.set(file.rel, { mtimeMs: file.mtimeMs, size: file.size, kind: 'other' });
            }
        });
        if (generation !== this.generation) return;
        const named = closed.slice(0, MAX_CLOSED_NAMED);
        const closedNow = (before.closed ?? []).join('\n') !== named.join('\n') || (before.closedCount ?? 0) !== closed.length;
        this.state = { state: 'ok', readAt: this.now(), took: this.now() - started, truncated, changed: stale.length, vault: where.vault, closed: named, closedCount: closed.length };
        if (before.state !== 'ok' || stale.length > 0 || before.truncated !== truncated || closedNow) this.changed(before.state === 'ok' ? 'changed' : 'ok', before);
    }

    changed(kind, before) {
        try { this.onChange?.({ kind, before, after: this.status() }); } catch { /* a listener never stops a read */ }
    }

    /**
     * The vault's Markdown files (vault paths), skipping hidden folders,
     * links and other files, at most MAX_NOTES; and the folders inside it
     * that may not be listed (no permission, a Mac's privacy rules), by
     * their vault paths, sorted. The vault's own folder not listing throws.
     */
    async walk(root) {
        const files = [];
        const closed = [];
        const folders = [''];
        let truncated = false;
        while (folders.length && !truncated) {
            const rel = folders.pop();
            let entries;
            try {
                entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
            } catch (error) {
                if (!rel) throw error;
                // Gone since it was listed: nothing to say. Anything else keeps its notes out, so the page names it.
                if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') closed.push(rel);
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
        closed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return { files, truncated, closed };
    }

    /** The drafts folder's notes, newest first. */
    drafts() {
        return [...this.draftsByPath.values()].sort((a, b) => b.created - a.created || a.path.localeCompare(b.path)).slice(0, MAX_DRAFTS);
    }

    /**
     * The active notes a draft shares its subject with: what a turn with the
     * draft's words, in the folder it was saved from, would get.
     * @param {{ title?: string, body?: string, folder?: string }} draft
     * @returns {{ path: string, title: string }[]}
     */
    related(draft, limit = 2) {
        const words = `${draft?.title ?? ''}\n\n${plainText(draft?.body ?? '').slice(0, 1500)}`.trim();
        if (!words) return [];
        try {
            // Named only when it shares the subject, not just a project's name: two words of its own and a third of
            // what the draft says.
            const names = this.index.projectWords();
            return this.search(words, { folder: draft.folder ?? '', limit: 10 }).results
                .filter((r) => r.share >= RELATED_SHARE && new Set(r.matched.filter((t) => !names.has(t))).size >= 2)
                .slice(0, limit).map((r) => ({ path: r.path, title: r.title }));
        } catch {
            return [];
        }
    }

    /**
     * The active notes that fit a prompt (search.js), for a session's folder.
     * @param {string} prompt
     * @param {{ folder?: string, limit?: number }} [options]
     */
    search(prompt, { folder = '', limit = 10 } = {}) {
        const keys = folderKeys(folder, this.home, (name) => this.index.projects.has(name));
        return { ...this.index.search(prompt, { folder: keys, limit }), folder: keys };
    }

    /** How many lines of an active note are addressed to agents (0 when none, or not an active note). */
    addressedIn(rel) {
        const f = this.files.get(rel);
        return f?.kind === 'note' ? f.addressed ?? 0 : 0;
    }

    /**
     * The quote of a note for the prompt's terms (bestPassage), read fresh
     * from the file, at most `budget` characters; undefined when the note
     * cannot be read or is no longer active.
     * @param {string} rel - the note's vault path.
     * @param {string[]} queryTerms
     * @param {number} budget
     */
    async passage(rel, queryTerms, budget) {
        const note = await this.quotable(rel);
        return note === undefined ? undefined : bestPassage(note.body, queryTerms, budget);
    }

    /**
     * An active note as a turn may quote it, read fresh from the file: its
     * body, its frontmatter, its projects and when the file last changed;
     * undefined when it cannot be read or is no longer active.
     * @param {string} rel - the note's vault path.
     */
    async quotable(rel) {
        if (!this.root || !this.index.has(rel)) return undefined;
        const file = join(this.root, rel);
        let text;
        let mtimeMs = 0;
        try {
            text = await readHead(file);
            mtimeMs = (await stat(file)).mtimeMs;
        } catch {
            return undefined;
        }
        const note = noteOf(rel, text);
        if (!note.active) return undefined;
        return { body: note.body, data: note.data, projects: projectsOf(note), mtimeMs };
    }
}

/**
 * The paragraphs of a body, each with the heading it sits under, that
 * heading's level and its section (a number that changes at each heading);
 * code fences stay whole.
 */
export function paragraphs(body) {
    const out = [];
    let heading = '';
    let level = 0;
    let section = 0;
    let current = [];
    let fenced = false;
    const flush = () => {
        const text = current.join('\n').trim();
        if (text) out.push({ heading, level, section, text });
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
            level = /^#+/.exec(line)[0].length;
            heading = line.replace(/^#{1,6}\s+/, '').replace(/[\s#]+$/, '').trim();
            section += 1;
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

/** Whether a text ends on a line that introduces what follows ("Today:", "Steps:"). */
const opens = (text) => /:\s*$/.test(String(text ?? ''));

/** Cut text to at most `max` characters, at a line or word end when one is near, with "…". */
export function cut(text, max) {
    const t = String(text ?? '').trim();
    if (t.length <= max) return t;
    if (max <= 1) return '';
    const head = t.slice(0, max - 1);
    const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
    let kept = (at > max * 0.6 ? head.slice(0, at) : head).trimEnd();
    // Never on a line that introduces what it leaves out ("Today:…"): back to the line before it, when there is one.
    if (opens(kept) && kept.includes('\n')) kept = kept.slice(0, kept.lastIndexOf('\n')).trimEnd();
    return `${kept}…`;
}

/** The characters a text takes as the block's quoted lines: "> " before each line, ">" alone for an empty one. */
export function quotedLength(text) {
    const lines = String(text ?? '').split('\n');
    return lines.reduce((n, line) => n + (line.trim() ? line.length + 2 : 1), 0) + lines.length - 1;
}

/** `text` cut so that `size(text)` is at most `budget` (cut()'s rules). */
function cutTo(text, budget, size) {
    let max = Math.min(String(text ?? '').trim().length, budget);
    let out = cut(text, max);
    while (out && size(out) > budget && max > 1) {
        max -= Math.max(1, size(out) - budget);
        out = cut(text, max);
    }
    return size(out) <= budget ? out : '';
}

/**
 * The quote of a note for a prompt's terms, at most `budget` characters
 * as `size` measures them (plain length by default; the block measures
 * quoted lines, quotedLength):
 * - the whole note when it fits (its title heading aside: the block's
 *   citation names the note), so a question that asks two things gets
 *   both;
 * - else the paragraph that fits the prompt best, and then, while there is
 *   room, the paragraph that adds the most of the prompt's words not quoted
 *   yet (so each half of a question that asks two things gets the
 *   paragraph that answers it), in the note's own order;
 * - the note's start when no paragraph has a prompt word.
 * A paragraph that ends on a line introducing what follows ("Today:")
 * always brings the next one. The first paragraph quoted from a section
 * says its heading ("Changing a port: Edit …"). The words that say what
 * the prompt is about choose; its everyday request words ("run",
 * "check") only when it has no others. Lines addressed to agents are
 * never in it.
 */
export function bestPassage(body, queryTerms, budget, size = (text) => text.length) {
    const about = queryTerms.filter((t) => !EVERYDAY.has(t));
    const wanted = new Set(about.length ? about : queryTerms);
    // A paragraph keeps its other lines when one is addressed to agents; one with nothing else is gone.
    const parts = paragraphs(body).map((p) => ({ ...p, text: unaddressed(p.text) })).filter((p) => p.text);
    if (parts.length === 0 || budget < 20) return '';
    // The note's own title heading says nothing the citation does not.
    const titleSection = parts[0].level === 1 ? parts[0].section : -1;
    const write = (chosen) => {
        const order = [...new Set(chosen)].sort((a, b) => a - b);
        return order.map((i, k) => {
            const p = parts[i];
            const first = k === 0 || parts[order[k - 1]].section !== p.section;
            return first && p.heading && p.section !== titleSection ? `${p.heading}: ${p.text}` : p.text;
        }).join('\n');
    };
    const every = parts.map((_, i) => i);
    if (size(write(every)) <= budget) return write(every);
    const scores = parts.map((p) => {
        const hits = distinctTerms(`${p.heading} ${p.text}`).filter((t) => wanted.has(t)).length;
        const all = terms(p.text).filter((t) => wanted.has(t)).length;
        return hits * 2 + Math.min(all, 6) * 0.25;
    });
    // A prompt word in a section's own heading says the section is about it (the note's title heading says that of
    // the whole note, not of one paragraph).
    const headed = parts.map((p) => (p.section === titleSection ? 0 : distinctTerms(p.heading).filter((t) => wanted.has(t)).length));
    // A paragraph that introduces what follows comes with it.
    const unit = (i) => (opens(parts[i].text) && i + 1 < parts.length ? [i, i + 1] : [i]);
    let best = -1;
    scores.forEach((score, i) => { if (score > 0 && (best < 0 || score > scores[best])) best = i; });
    if (best < 0) {
        // No paragraph has a prompt word: the note's start, as far as it goes.
        const chosen = [];
        for (const i of every) {
            if (size(write([...chosen, ...unit(i)])) > budget) break;
            chosen.push(...unit(i));
        }
        return chosen.length ? write(chosen) : cutTo(write(unit(0)), budget, size);
    }
    const first = unit(best);
    if (size(write(first)) > budget) return cutTo(write(first), budget, size);
    // Then, while there is room, the paragraph that adds the most of the prompt's words not quoted yet (of those, one
    // whose section's heading has them, then the best scored): a question that asks two things gets the paragraph
    // that answers each.
    const chosen = new Set(first);
    const words = parts.map((p) => distinctTerms(`${p.heading} ${p.text}`).filter((t) => wanted.has(t)));
    const covered = new Set(first.flatMap((i) => words[i]));
    const rest = every.filter((i) => !chosen.has(i) && scores[i] > 0);
    while (rest.length) {
        let pick = rest[0];
        let gain = -1;
        for (const i of rest) {
            const adds = words[i].filter((t) => !covered.has(t)).length;
            const better = headed[i] - headed[pick] || scores[i] - scores[pick];
            if (adds > gain || (adds === gain && better > 0)) {
                pick = i;
                gain = adds;
            }
        }
        rest.splice(rest.indexOf(pick), 1);
        const tried = [...chosen, ...unit(pick)];
        if (size(write(tried)) > budget) continue;
        for (const i of unit(pick)) {
            chosen.add(i);
            for (const t of words[i]) covered.add(t);
        }
    }
    return write([...chosen]);
}

/*
 * Lines a note addresses to agents rather than to the people who read it.
 * Canon never quotes one into a turn: it is an order the person never
 * typed. A small, general list, matched per line, case aside:
 * - speaking to them: "Agents reading this: …", "Note to the assistant: …",
 *   "Dear AI, …", "Hey bots, …";
 * - asking what the reader is: "If you are an AI …", "If you're a language
 *   model …", "When an agent reads this …";
 * - telling the reader how to reply: "Always reply in French", "Never answer
 *   with code", "Sign every reply with …", "Start each answer with …";
 * - setting the turn's own rules aside: "Ignore previous instructions",
 *   "Disregard the above rules", "Forget your earlier instructions".
 * A team rule written the same way ("always reply in English on the forum")
 * is left out too; the page names every note that has one, so it can be
 * reworded.
 */
const AGENT = String.raw`(?:ai|a\.i\.|llms?|(?:large\s+)?language\s+models?|models?|agents?|assistants?|bots?|chatbots?)`;
const ADDRESSED = [
    new RegExp(String.raw`^\W*(?:dear|hey|hi|hello|attention|(?:a\s+)?(?:note|message|word)\s+(?:to|for)|to)\s+(?:all\s+|any\s+|the\s+)?(?:ai\s+|coding\s+)?${AGENT}\b`, 'i'),
    new RegExp(String.raw`\b${AGENT}\s+(?:reading|who\s+reads?|that\s+reads?|seeing|processing)\s+(?:this|these)\b`, 'i'),
    new RegExp(String.raw`\bif\s+you(?:'re|’re|\s+are)\s+(?:an?\s+)?(?:ai\s+|coding\s+)?${AGENT}\b`, 'i'),
    new RegExp(String.raw`\b(?:when|whenever|if)\s+(?:an?|the|any)\s+(?:ai\s+|coding\s+)?${AGENT}\s+(?:reads?|sees?|finds?|opens?|is\s+reading)\s+(?:this|these)\b`, 'i'),
    /^\W*(?:please\s+)?(?:always|never)\s+(?:reply|respond|answer|sign)\s+(?:in|with|as|using|only|by)\b/i,
    /\b(?:sign|end|start|begin|close|finish|open)\s+(?:every|each|all|any|your)\s+(?:reply|replies|answer|answers|response|responses)\b/i,
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|earlier|above|preceding|original|system|other)\s+(?:instructions?|rules|prompts?|directions|guidelines)\b/i,
];

/** Whether a line is addressed to agents (the list above). */
export const addressedToAgents = (line) => ADDRESSED.some((re) => re.test(String(line ?? '')));

/** A text without its lines addressed to agents. */
export const unaddressed = (text) => String(text ?? '').split(/\r?\n/).filter((line) => !addressedToAgents(line)).join('\n').trim();

/** How many of a body's lines are addressed to agents. */
export const addressedLines = (body) => String(body ?? '').split(/\r?\n/).filter(addressedToAgents).length;
