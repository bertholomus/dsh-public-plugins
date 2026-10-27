/**
 * Keeping the index up to date, a little at a time: walk the folders
 * Recall searches for new, changed and deleted files, and read each
 * changed file from where the last pass stopped.
 *
 * Work comes in slices (`step(budgetMs)`): the worker runs one, answers
 * the searches that came in meanwhile, and runs the next. A big file is
 * read in parts across slices, its place saved after each part, so a
 * restart goes on where it was.
 *
 * - DSH session logs (`<sessions>/<project>/<session>/session.v4.jsonl.zstd`):
 *   append-only zstd frames, read on from the byte after the last whole frame.
 * - Coding-agent transcripts (`*.jsonl` anywhere under a folder): append-only
 *   lines, read on from the byte after the last whole line.
 * - Handoff notes (Markdown anywhere under a folder): read again whole when
 *   they change.
 *
 * A file that shrank or was replaced (another inode) is read again from the
 * start. A file that cannot be read keeps its rows and says why. A file
 * gone from a folder that is still there loses its rows; a folder that is
 * gone (an unplugged disk) keeps them, and its status says so.
 *
 * @module dsh-plugin-recall/indexer
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { NOTE_LIMITS, cutWords, isNote, readNote } from './handoffs.js';
import { SessionLog, newSessionState } from './sessionlog.js';
import { TranscriptLog, newTranscriptState } from './transcripts.js';
import { canDecode, readFrames, readLines } from './zstd.js';

/** A DSH session log's file name; the highest version in a folder wins. */
export const SESSION_FILE = /^session\.v(\d+)\.jsonl\.zstd$/;
/** Folders never walked into. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'dist', 'build', 'target', 'vendor', 'Library']);
/** How deep and how wide a walk goes. */
export const WALK_LIMITS = Object.freeze({ depth: 8, sessionDepth: 3, files: 20000 });
/** How much of a file one part reads. */
const PART_BYTES = 2 << 20;
/** Past this many bytes of a big note's middle, its lines are not counted (its last part's lines are not given). */
const COUNT_LINES_BYTES = 512 << 20;

const breaksIn = (buf) => {
    let n = 0;
    for (let at = buf.indexOf(10); at >= 0; at = buf.indexOf(10, at + 1)) n += 1;
    return n;
};

/**
 * A note's ends: the whole file up to `NOTE_LIMITS.fileBytes`. Past that, its first `headBytes` and the rest of
 * the cap from its end (`tail`), each cut at a line break, and its middle (`middle`), whose line breaks
 * `countMiddle` counts for the line the last part starts on (none past `COUNT_LINES_BYTES`: its line is 0).
 * @returns {{ text: string, tail?: { text: string, line: number }, middle?: { from: number, to: number, breaks: number } }}
 */
export function noteEnds(path, size) {
    const fd = openSync(path, 'r');
    try {
        const read = (from, bytes) => {
            const buf = Buffer.alloc(Math.max(0, bytes));
            const got = readSync(fd, buf, 0, buf.length, from);
            return got < buf.length ? buf.subarray(0, got) : buf;
        };
        if (size <= NOTE_LIMITS.fileBytes) return { text: read(0, size).toString('utf8') };
        let head = read(0, NOTE_LIMITS.headBytes);
        const headCut = head.lastIndexOf(10);
        if (headCut >= 0) head = head.subarray(0, headCut + 1);
        const tailFrom = size - (NOTE_LIMITS.fileBytes - NOTE_LIMITS.headBytes);
        let tail = read(tailFrom, size - tailFrom);
        const tailCut = tail.indexOf(10);
        const tailStart = tailFrom + (tailCut >= 0 ? tailCut + 1 : 0);
        if (tailCut >= 0) tail = tail.subarray(tailCut + 1);
        const out = { text: head.toString('utf8'), tail: { text: tail.toString('utf8'), line: 0 } };
        if (tailStart - head.length <= COUNT_LINES_BYTES) out.middle = { from: head.length, to: tailStart, breaks: breaksIn(head) };
        return out;
    } finally {
        closeSync(fd);
    }
}

/**
 * Count the line breaks of a big note's middle a part (`PART_BYTES`) at a time, never holding it whole, until
 * `until`: so a note of hundreds of megabytes never holds a search up.
 * @returns {boolean} whether all of it is counted (then `middle.line` is the line its last part starts on).
 */
export function countMiddle(path, middle, until = Infinity, now = Date.now) {
    if (middle.from < middle.to) {
        const fd = openSync(path, 'r');
        try {
            while (middle.from < middle.to) {
                const buf = Buffer.alloc(Math.min(PART_BYTES, middle.to - middle.from));
                const got = readSync(fd, buf, 0, buf.length, middle.from);
                // Shorter than it was: the next look reads the changed note again.
                if (got === 0) break;
                middle.breaks += breaksIn(got < buf.length ? buf.subarray(0, got) : buf);
                middle.from += got;
                if (middle.from < middle.to && now() >= until) return false;
            }
        } finally {
            closeSync(fd);
        }
    }
    middle.from = middle.to;
    middle.line = middle.breaks + 1;
    return true;
}

/** A note's text, as `noteEnds` gives it, with its middle counted in one go. */
export function noteText(path, size) {
    const { middle, ...ends } = noteEnds(path, size);
    if (middle && countMiddle(path, middle)) ends.tail.line = middle.line;
    return ends;
}

const errorWords = (error) => {
    const code = error?.code;
    if (code === 'EACCES' || code === 'EPERM') return 'DSH may not read it (permission denied)';
    if (code === 'ENOENT') return 'it is gone';
    if (code === 'EISDIR') return 'it is a folder';
    return String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);
};

/** Why a searched folder cannot be read, as whole sentences that say what to do (it is looked at again every minute). */
export const folderWords = (error) => {
    const code = error?.code;
    if (code === 'EACCES' || code === 'EPERM') return 'DSH may not read this folder (permission denied). Give DSH access to it, or name another folder in Recall\'s settings.';
    if (code === 'ENOTDIR') return 'Part of this path is a file, not a folder. Check the folder\'s path in Recall\'s settings.';
    if (code === 'ELOOP') return 'This path goes round in a loop of links. Name the folder itself in Recall\'s settings.';
    if (code === 'EIO') return 'Its disk could not be read (an input/output error). Check the disk; Recall looks again every minute.';
    return `Recall cannot read this folder (${errorWords(error).replace(/\.$/, '')}). Check that DSH may read it; Recall looks again every minute.`;
};

/** The folder a source's walk starts from: a DSH home's `sessions` folder when given the home. */
export function walkRoot(source) {
    if (source.kind !== 'session') return source.root;
    try {
        if (statSync(join(source.root, 'sessions')).isDirectory()) return join(source.root, 'sessions');
    } catch { /* the folder itself */ }
    return source.root;
}

/** One walk of a folder, a directory at a time. */
class Walk {
    constructor(source, known) {
        this.source = source;
        this.known = known;
        this.seen = new Set();
        this.changed = [];
        this.stack = [];
        this.count = 0;
        this.capped = false;
        this.missing = false;
        this.notFolder = false;
        this.error = '';
        const top = walkRoot(source);
        try {
            const st = statSync(top);
            if (!st.isDirectory()) {
                this.notFolder = true;
                this.error = 'This is a file, not a folder. Name the folder that holds it in Recall\'s settings.';
            }
            else this.stack.push({ dir: top, depth: 0 });
        } catch (error) {
            if (error?.code === 'ENOENT') this.missing = true;
            else this.error = folderWords(error);
        }
    }

    get done() {
        return this.stack.length === 0;
    }

    /** Read one directory: its files that changed go to `changed`, its folders onto the stack. */
    step() {
        const { dir, depth } = this.stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            if (depth === 0) this.error = folderWords(error);
            return;
        }
        const kind = this.source.kind;
        const files = [];
        if (kind === 'session') {
            // One log per session folder: the highest version.
            let best;
            for (const e of entries) {
                const m = SESSION_FILE.exec(e.name);
                if (m && (e.isFile() || e.isSymbolicLink()) && (!best || Number(m[1]) > best.v)) best = { v: Number(m[1]), name: e.name };
            }
            if (best) files.push(join(dir, best.name));
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                const limit = kind === 'session' ? WALK_LIMITS.sessionDepth : WALK_LIMITS.depth;
                if (depth + 1 <= limit && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) this.stack.push({ dir: join(dir, e.name), depth: depth + 1 });
                continue;
            }
            if (kind === 'transcript' && /\.jsonl$/i.test(e.name)) files.push(join(dir, e.name));
            else if (kind === 'handoff' && isNote(e.name) && !e.name.startsWith('.')) files.push(join(dir, e.name));
        }
        for (const path of files) {
            if (this.count >= WALK_LIMITS.files) {
                this.capped = true;
                this.stack.length = 0;
                return;
            }
            let st;
            try {
                st = statSync(path);
            } catch {
                continue;
            }
            if (!st.isFile()) continue;
            this.count += 1;
            this.seen.add(path);
            const known = this.known.get(path);
            if (known && known.skip === 'subagent' && known.ino === st.ino) continue;
            if (known && known.size === st.size && known.mtime === st.mtimeMs && known.ino === st.ino) continue;
            this.changed.push(path);
        }
    }
}

export class Indexer {
    /**
     * @param {object} options
     * @param {import('./store.js').Store} options.store
     * @param {(level: string, text: string) => void} [options.log]
     * @param {(note: object) => void} [options.note] - things the person's log should say (a folder forgotten, files that could not be read).
     * @param {() => number} [options.now]
     */
    constructor({ store, log = () => {}, note = () => {}, now = Date.now }) {
        this.store = store;
        this.log = log;
        this.note = note;
        this.now = now;
        /** @type {{ kind: string, root: string, own: boolean }[]} */
        this.sources = [];
        this.walks = [];
        this.walking = undefined;
        /** Files to read: touched sessions first, then what walks found. path → source */
        this.urgent = new Map();
        this.queue = new Map();
        this.current = undefined;
        /** `${kind}:${root}` → { state, files, capped, error, scanned } */
        this.rootState = new Map();
        this.read = 0;
        this.rowsPut = 0;
        /** Of those, a note's sections (the rest are turns), so the log can say which it read. */
        this.sectionsPut = 0;
        this.lastRead = 0;
        /** Sessions DSH named that no walk found yet: id → when last looked for. */
        this.missed = new Map();
    }

    static key(source) {
        return `${source.kind}:${source.root}`;
    }

    /** The folders to search. Folders no longer listed are forgotten, with their rows; new ones are walked. */
    configure(sources) {
        const next = new Map(sources.map((s) => [Indexer.key(s), s]));
        for (const r of this.store.roots()) {
            if (next.has(`${r.kind}:${r.root}`)) continue;
            const n = this.store.removeRoot(r.root, r.kind);
            if (n > 0) this.note({ kind: 'forgot', root: r.root, sourceKind: r.kind, files: n, turns: r.turns ?? 0 });
        }
        const before = new Set(this.sources.map(Indexer.key));
        this.sources = [...next.values()];
        for (const map of [this.urgent, this.queue]) {
            for (const [path, source] of map) if (!next.has(Indexer.key(source))) map.delete(path);
        }
        if (this.current && !next.has(Indexer.key(this.current.source))) this.current = undefined;
        this.walks = this.walks.filter((w) => next.has(Indexer.key(w.source)));
        if (this.walking && !next.has(Indexer.key(this.walking.source))) this.walking = undefined;
        for (const key of [...this.rootState.keys()]) if (!next.has(key)) this.rootState.delete(key);
        for (const source of this.sources) {
            if (!before.has(Indexer.key(source))) {
                this.rootState.set(Indexer.key(source), { state: 'waiting', files: 0, capped: false, error: '', scanned: 0 });
                this.scan(source);
            }
        }
    }

    /** Walk one folder (or every one) again for new, changed and deleted files. */
    scan(source) {
        for (const s of source ? [source] : this.sources) {
            const key = Indexer.key(s);
            if (this.walks.some((w) => Indexer.key(w.source) === key)) continue;
            if (this.walking && Indexer.key(this.walking.source) === key) continue;
            this.walks.push({ source: s });
        }
    }

    /** DSH says a session moved: read its log soon (or walk this DSH's sessions for a new one). */
    touchSession(sessionId) {
        const own = this.sources.find((s) => s.kind === 'session' && s.own);
        if (!own || typeof sessionId !== 'string' || !sessionId) return;
        const found = this.store.ownSession(sessionId);
        if (found) {
            if (found.skip !== 'subagent') this.urgent.set(found.path, own);
            return;
        }
        // A session not in the index yet: walk this DSH's sessions, at most once a minute for the same one.
        const missed = this.missed.get(sessionId);
        if (missed !== undefined && this.now() - missed < 60_000) return;
        this.missed.set(sessionId, this.now());
        if (this.missed.size > 500) this.missed.delete(this.missed.keys().next().value);
        this.scan(own);
    }

    /** Every file is read again, its rows replaced as it is; searches keep working meanwhile. */
    rebuild() {
        this.store.staleAll();
        this.current = undefined;
        this.scan();
    }

    get busy() {
        return Boolean(this.current || this.urgent.size || this.queue.size || this.walking || this.walks.length);
    }

    /**
     * Work for about `budgetMs`, in one transaction.
     * @returns {boolean} whether work is left.
     */
    step(budgetMs = 40) {
        const until = this.now() + budgetMs;
        this.store.transaction(() => {
            while (this.now() < until) {
                if (this.current) {
                    this.readPart(this.current, until);
                    continue;
                }
                const next = this.take(this.urgent) ?? this.take(this.queue);
                if (next) {
                    this.current = this.start(next.path, next.source);
                    continue;
                }
                if (this.walking) {
                    this.walkStep(this.walking);
                    continue;
                }
                const job = this.walks.shift();
                if (!job) break;
                const known = new Map(this.store.filesOf(job.source.root, job.source.kind).map((f) => [f.path, f]));
                this.walking = new Walk(job.source, known);
                const st = this.rootState.get(Indexer.key(job.source));
                if (st) st.state = 'walking';
            }
        });
        return this.busy;
    }

    take(map) {
        const first = map.entries().next();
        if (first.done) return undefined;
        map.delete(first.value[0]);
        return { path: first.value[0], source: first.value[1] };
    }

    walkStep(walk) {
        if (!walk.done) walk.step();
        for (const path of walk.changed.splice(0)) if (!this.urgent.has(path)) this.queue.set(path, walk.source);
        if (!walk.done) return;
        this.walking = undefined;
        const key = Indexer.key(walk.source);
        const st = this.rootState.get(key) ?? { state: 'waiting', files: 0, capped: false, error: '', scanned: 0 };
        st.scanned = this.now();
        st.files = walk.count;
        st.capped = walk.capped;
        st.error = walk.error;
        // This DSH's own sessions folder is made with its first session: not there yet is not a folder gone.
        st.state = walk.missing ? (walk.source.own ? 'ok' : 'missing') : walk.notFolder ? 'file' : walk.error ? 'unreadable' : 'ok';
        this.rootState.set(key, st);
        if (walk.missing || walk.error) return;
        // Files gone from a folder that is still there: their rows go too.
        let gone = 0;
        for (const [path, f] of walk.known) {
            if (walk.seen.has(path) || (walk.capped && !walk.seen.has(path))) continue;
            this.store.removeFile(f.id);
            this.urgent.delete(path);
            this.queue.delete(path);
            gone += 1;
        }
        if (gone > 0) this.log('info', `${gone} file${gone === 1 ? '' : 's'} gone from ${walk.source.root}: their turns were taken out of the index.`);
    }

    /** Begin reading one file: where to start, and how. */
    start(path, source) {
        const id = this.store.addFile({ path, kind: source.kind, root: source.root, own: source.own });
        return { path, source, id, begun: false };
    }

    /** Read a part of the current file; it stays current while more is left. */
    readPart(job, until) {
        let left = false;
        try {
            if (job.source.kind === 'session') left = this.readSession(job, until);
            else if (job.source.kind === 'transcript') left = this.readTranscript(job, until);
            else left = this.readHandoff(job, until);
        } catch (error) {
            this.problem(job, error);
            left = false;
        }
        if (!left) {
            this.current = undefined;
            this.read += 1;
            this.lastRead = this.now();
        }
    }

    /** A file that could not be read: its rows stay, and it says why. */
    problem(job, error) {
        if (error?.code === 'ENOENT') {
            this.store.removeFile(job.id);
            return;
        }
        let st;
        try { st = statSync(job.path); } catch { st = undefined; }
        const words = errorWords(error);
        this.store.fileProblem(job.id, { size: st?.size, mtime: st?.mtimeMs, ino: st?.ino, error: `Could not be read: ${words}.` });
        this.note({ kind: 'problem', path: job.path, sourceKind: job.source.kind, error: words, rows: this.store.rowCount(job.id) });
    }

    /** Where a file's read goes on from: its saved place when the file only grew, else the start. */
    resume(job, st, fresh) {
        const row = this.store.fileById(job.id);
        const grown = row && row.size >= 0 && row.ino === st.ino && st.size >= row.offset && row.state && row.skip === '';
        if (grown) {
            try {
                const state = JSON.parse(row.state);
                if (state && state.v === 1) return { row, offset: row.offset, state };
            } catch { /* read it again whole */ }
        }
        this.store.clearRows(job.id);
        return { row, offset: 0, state: fresh() };
    }

    /** Put a pass's rows and save the file's place. */
    save(job, row, { rows, meta, size, mtime, ino, offset, state, error = '', skip = '' }) {
        const file = { kind: job.source.kind, title: meta.title, folder: meta.folder };
        for (const r of rows) {
            this.store.putRow(job.id, file, r);
            this.rowsPut += 1;
        }
        if (file.kind === 'handoff') this.sectionsPut += rows.length;
        if ((row?.title ?? '') !== meta.title) this.store.retitle(job.id, meta.title);
        this.store.saveFile(job.id, { size, mtime, ino, offset, state, ...meta, skip, error });
    }

    readSession(job, until) {
        if (!canDecode()) {
            const st = statSync(job.path);
            this.store.fileProblem(job.id, { size: st.size, mtime: st.mtimeMs, ino: st.ino, error: 'Could not be read: this DSH runs on a Node without zstd (Node 22.15 or newer has it).' });
            return false;
        }
        for (;;) {
            if (!job.begun) {
                const st = statSync(job.path);
                Object.assign(job, this.resume(job, st, newSessionState), { begun: true });
                // Broken bytes found before stay said while the file is read on from where it was.
                job.broken = job.offset > 0 && /^Part of it/.test(job.row?.error ?? '') ? job.row.error : '';
            }
            const r = readFrames(job.path, job.offset, { maxBytes: PART_BYTES });
            if (r.shrunk) {
                job.begun = false;
                this.store.saveFile(job.id, { size: -1, offset: 0 });
                continue;
            }
            const log = new SessionLog(job.state);
            for (const text of r.texts) {
                for (const line of text.split('\n')) if (line) log.line(line);
            }
            const { rows, meta } = log.take();
            if (meta.subagent) {
                this.store.clearRows(job.id);
                this.store.saveFile(job.id, { size: r.size, mtime: r.mtime, ino: r.ino, offset: r.size, ...meta, skip: 'subagent' });
                return false;
            }
            let next = r.next;
            if (r.bad) {
                next = r.bad.resume ?? r.size;
                job.broken = `Part of it could not be read (${r.bad.why} at byte ${r.bad.at}); Recall read on from the next whole write.`;
                this.note({ kind: 'problem', path: job.path, sourceKind: 'session', error: `${r.bad.why} at byte ${r.bad.at}`, part: true });
            }
            this.save(job, job.row, { rows, meta, size: r.size, mtime: r.mtime, ino: r.ino, offset: next, state: log.state, error: job.broken });
            job.row = { ...(job.row ?? {}), title: meta.title };
            job.offset = next;
            job.state = log.state;
            const more = r.more || (r.bad !== undefined && next < r.size);
            if (!more) return false;
            if (this.now() >= until) return true;
        }
    }

    readTranscript(job, until) {
        for (;;) {
            if (!job.begun) {
                const st = statSync(job.path);
                Object.assign(job, this.resume(job, st, newTranscriptState), { begun: true });
            }
            const r = readLines(job.path, job.offset, { maxBytes: PART_BYTES });
            if (r.shrunk) {
                job.begun = false;
                this.store.saveFile(job.id, { size: -1, offset: 0 });
                continue;
            }
            const log = new TranscriptLog(job.state);
            const lines = r.text.split('\n');
            if (lines.at(-1) === '') lines.pop();
            const first = (job.state.lines ?? 0) + 1;
            lines.forEach((line, i) => log.line(line, first + i));
            log.state.lines = (job.state.lines ?? 0) + lines.length + (r.skipped ? 1 : 0);
            const { rows, meta } = log.take();
            // A transcript that gives no times (plain role lines): its turns are dated by when the file was written.
            for (const row of rows) if (!(row.time > 0)) row.time = Math.round(r.mtime);
            if (!meta.session) meta.session = basename(job.path).replace(/\.jsonl$/i, '');
            if (!meta.folder) meta.folder = dirname(job.path);
            this.save(job, job.row, { rows, meta, size: r.size, mtime: r.mtime, ino: r.ino, offset: r.next, state: log.state });
            job.row = { ...(job.row ?? {}), title: meta.title };
            job.offset = r.next;
            job.state = log.state;
            if (!r.more) return false;
            if (this.now() >= until) return true;
        }
    }

    /**
     * A note: read whole (its two ends past 4 MB, see `noteEnds`), a slice at a time: a big note's middle counted
     * for its lines, its rows put, and the rows it no longer has taken out, so a note of hundreds of megabytes or
     * thousands of sections never holds a search up. Its place is saved once all of that is done: a restart reads
     * it again whole.
     */
    readHandoff(job, until) {
        if (!job.note) {
            if (!job.ends) {
                const st = statSync(job.path);
                job.ends = { st, ...noteEnds(job.path, st.size) };
            }
            const { st, text, tail, middle } = job.ends;
            if (middle) {
                if (!countMiddle(job.path, middle, until, this.now)) return true;
                tail.line = middle.line;
            }
            job.ends = undefined;
            job.note = { ...readNote(text, { name: basename(job.path), mtime: st.mtimeMs, tail }), st, at: 0, cutBytes: tail ? st.size : 0 };
        }
        const n = job.note;
        const file = { kind: 'handoff', title: n.title, folder: dirname(job.path) };
        while (n.at < n.rows.length) {
            this.store.putRow(job.id, file, n.rows[n.at]);
            n.at += 1;
            this.rowsPut += 1;
            this.sectionsPut += 1;
            if (n.at % 100 === 0 && n.at < n.rows.length && this.now() >= until) return true;
        }
        // Rows no longer in it: past its end when it got shorter, and those of the middle when only its ends are kept.
        n.drop ??= this.store.rowsBut(job.id, n.rows.map((r) => r.turn));
        while (n.drop.length > 0) {
            this.store.dropRow(n.drop.pop());
            if (n.drop.length % 200 === 0 && n.drop.length > 0 && this.now() >= until) return true;
        }
        const st = n.st;
        const meta = { session: '', title: n.title, folder: dirname(job.path), model: '', created: Math.round(st.birthtimeMs || st.ctimeMs), updated: Math.round(st.mtimeMs), turns: n.rows.length, subagent: false };
        this.store.saveFile(job.id, { size: st.size, mtime: st.mtimeMs, ino: st.ino, offset: st.size, state: undefined, ...meta, skip: '', error: cutWords({ bytes: n.cutBytes, rows: n.cut?.rows }) });
        return false;
    }

    /** Where the index is: per folder, and what is left to read. */
    status() {
        return {
            busy: this.busy,
            queued: this.urgent.size + this.queue.size + (this.current ? 1 : 0),
            reading: this.current ? { path: this.current.path, kind: this.current.source.kind } : undefined,
            walking: this.walking ? this.walking.source.root : undefined,
            read: this.read,
            lastRead: this.lastRead,
            roots: this.sources.map((s) => ({ kind: s.kind, root: s.root, own: s.own, ...(this.rootState.get(Indexer.key(s)) ?? { state: 'waiting', files: 0, capped: false, error: '', scanned: 0 }) })),
        };
    }
}
