/**
 * Recall's index: one SQLite file (node:sqlite, built into Node) with an
 * FTS5 table of turns. Only the index's worker thread opens it.
 *
 * - `files`: every file read (a session's log, a transcript, a note): where
 *   it is, how far it was read (`offset`, `state`), and its facts (session
 *   id, title, folder, model, times, turns, problem).
 * - `docs`: one row per turn (or note section): its file, turn number, the
 *   seq of its start, its time, kind, folder and model, for the filters.
 * - `fts`: the turn's text in four columns (title, prompt, reply, tools),
 *   with the same rowid as its `docs` row.
 *
 * The index holds nothing that is not in the files: a broken or older
 * index is set aside and built again.
 *
 * @module dsh-plugin-recall/store
 */
import { chmodSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { plainText } from './plain.js';

/** Bump when the tables change: an index of another version is built again. */
export const SCHEMA_VERSION = 4;

/** bm25 weights of the columns: title, prompt, reply, tools. */
const WEIGHTS = [4.0, 2.0, 1.0, 0.7];
/**
 * The same without the title: a row's own text. Every row of a file holds
 * its file's title, so a word only in the title matches every turn of it;
 * with the title's weight 0 such a row scores exactly 0 (bm25 adds nothing
 * for a word it does not find in a weighted column), and a row whose own
 * text has a hit scores below 0.
 */
const OWN_WEIGHTS = [0, 2.0, 1.0, 0.7];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  root TEXT NOT NULL,
  own INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT -1,
  mtime REAL NOT NULL DEFAULT 0,
  ino INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  state TEXT,
  session TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  skip TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS files_root ON files(root);
CREATE INDEX IF NOT EXISTS files_session ON files(session);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  file INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  time INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 1,
  ended TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL DEFAULT 0,
  UNIQUE (file, turn)
);
CREATE INDEX IF NOT EXISTS docs_time ON docs(time);
CREATE INDEX IF NOT EXISTS docs_folder ON docs(folder);
CREATE INDEX IF NOT EXISTS docs_model ON docs(model);
CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind, time);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, prompt, reply, tools, tokenize = 'porter unicode61 remove_diacritics 2', prefix = '3');
`;

/** Escape a folder for LIKE (its subfolders: folder || '/%'). */
const likePrefix = (folder) => `${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;

export class Store {
    /**
     * Open (or make) the index at `file`. A damaged index is set aside
     * (`<file>.old`, one copy: the next replaces it) and an index of another
     * version deleted (it holds only copies of what the files say), and a new
     * one made.
     * @param {string} file
     * @param {{ DatabaseSync: Function }} sqlite - node:sqlite.
     * @param {{ log?: (level: string, text: string) => void }} [options]
     */
    constructor(file, sqlite, { log } = {}) {
        this.file = file;
        this.log = log ?? (() => {});
        this.db = this.open(sqlite);
        this.statements = new Map();
        /** Rows taken out since the index last gave its space back: the search index keeps their words until it is. */
        this.taken = 0;
    }

    /**
     * Open the index. Its full check (SQLite's quick_check: about 2 seconds
     * for 10k sessions) runs only when the index was not closed cleanly last
     * time (DSH stopped without closing it), which a marker file beside it
     * says: an index closed cleanly opens in milliseconds.
     */
    open(sqlite) {
        const marker = `${this.file}.open`;
        const unclean = existsSync(marker);
        const tryOpen = () => {
            const db = new sqlite.DatabaseSync(this.file);
            // The index holds what sessions said: only its owner reads it (SQLite gives its -wal and -shm files the same mode).
            try { chmodSync(this.file, 0o600); } catch { /* the folder is private anyway */ }
            try {
                db.exec('PRAGMA busy_timeout = 5000');
                const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n === 0;
                // A new index can give pages back to the disk a few at a time (after a folder is taken out, a rebuild).
                // SQLite takes this only before the first write, and switching to its write-ahead log is one.
                if (empty) db.exec('PRAGMA auto_vacuum = INCREMENTAL');
                db.exec('PRAGMA journal_mode = WAL');
                db.exec('PRAGMA synchronous = NORMAL');
                const version = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
                if (!empty && version !== SCHEMA_VERSION) throw Object.assign(new Error(`the index is version ${version}, not ${SCHEMA_VERSION}`), { stale: true });
                db.exec(SCHEMA);
                db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
                if (unclean && !empty) {
                    const check = db.prepare('PRAGMA quick_check').get();
                    const ok = Object.values(check ?? {})[0];
                    if (ok !== 'ok') throw new Error(`the index failed its check (${String(ok).slice(0, 120)})`);
                }
                return db;
            } catch (error) {
                try { db.close(); } catch { /* closing a broken file */ }
                throw error;
            }
        };
        const opened = (db) => {
            try { writeFileSync(marker, `${process.pid}\n`, { mode: 0o600 }); } catch { /* the next open checks the index in full */ }
            return db;
        };
        try {
            return opened(tryOpen());
        } catch (error) {
            if (!existsSync(this.file)) throw error;
            // A broken index is set aside for a look; one of another version goes, so its space goes back to the disk.
            // Either way a new one is built: the files are the truth.
            this.log(error.stale ? 'info' : 'warn', `${error.stale ? 'An index from another version of Recall' : 'The index could not be opened'} (${String(error?.message ?? error).slice(0, 200)}); ${error.stale ? 'it was deleted' : 'it was set aside'} and a new one is built.`);
            for (const tail of ['-wal', '-shm']) rmSync(`${this.file}${tail}`, { force: true });
            if (error.stale) rmSync(this.file, { force: true });
            else renameSync(this.file, `${this.file}.old`);
            /** Why a new index was made: 'stale' (another version's, deleted) or 'damaged' (set aside). */
            this.setAside = error.stale ? 'stale' : 'damaged';
            return opened(tryOpen());
        }
    }

    /** A prepared statement, made once. */
    sql(text) {
        let statement = this.statements.get(text);
        if (!statement) {
            statement = this.db.prepare(text);
            this.statements.set(text, statement);
        }
        return statement;
    }

    /** Run `fn` in one transaction (nested calls join the outer one). */
    transaction(fn) {
        if (this.inTransaction) return fn();
        this.db.exec('BEGIN');
        this.inTransaction = true;
        try {
            const out = fn();
            this.db.exec('COMMIT');
            return out;
        } catch (error) {
            try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
            throw error;
        } finally {
            this.inTransaction = false;
        }
    }

    /** Close the index cleanly: the next open skips the full check. */
    close() {
        try {
            this.db.close();
            rmSync(`${this.file}.open`, { force: true });
        } catch { /* already closed */ }
    }

    /** Pages of the index file, and how many of them are free inside it (left by rows taken out). */
    space() {
        const one = (name) => Number(Object.values(this.db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
        return { free: one('freelist_count'), pages: one('page_count'), vacuum: one('auto_vacuum') === 2 };
    }

    /**
     * One slice of giving space back to the disk after many rows were taken out. First the search index's own
     * leftovers: FTS5 keeps a deleted row's words until its segments are merged, so they are merged a few pages at
     * a time. Then the free pages, moved off the end of the file a thousand at a time, and the write-ahead log cut
     * to nothing. Each slice takes a few milliseconds, so a search waits at most that long.
     * @param {'merge' | 'vacuum'} phase
     * @returns {'merge' | 'vacuum' | 'done'} the next phase.
     */
    shrinkSlice(phase) {
        const changes = () => this.sql('SELECT total_changes() AS n').get().n;
        if (phase === 'merge') {
            this.taken = 0;
            const before = changes();
            this.sql("INSERT INTO fts (fts, rank) VALUES ('merge', -16)").run();
            return changes() - before >= 2 ? 'merge' : 'vacuum';
        }
        const { free, vacuum } = this.space();
        if (free > 0 && vacuum) {
            this.db.exec('PRAGMA incremental_vacuum(1000)');
            if (this.space().free < free) return 'vacuum';
        }
        try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a reader holds it: the next checkpoint */ }
        return 'done';
    }

    /** The index file's size on disk, its write-ahead log included. */
    bytes() {
        let total = 0;
        for (const tail of ['', '-wal']) {
            try { total += statSync(`${this.file}${tail}`).size; } catch { /* not there */ }
        }
        return total;
    }

    // ── Files ─────────────────────────────────────────────────────────

    fileByPath(path) {
        return this.sql('SELECT * FROM files WHERE path = ?').get(path);
    }

    fileById(id) {
        return this.sql('SELECT * FROM files WHERE id = ?').get(id);
    }

    /** A DSH session's file in this DSH's own folder, by its id. */
    ownSession(sessionId) {
        return this.sql("SELECT * FROM files WHERE session = ? AND kind = 'session' AND own = 1 ORDER BY id DESC LIMIT 1").get(sessionId);
    }

    /** Every file of a folder Recall searches: path, size, mtime, inode, id, why it is skipped. */
    filesOf(root, kind) {
        return this.sql('SELECT id, path, size, mtime, ino, skip FROM files WHERE root = ? AND kind = ?').all(root, kind);
    }

    /** The folders the index holds rows from. */
    roots() {
        return this.sql('SELECT root, kind, count(*) AS files, sum(turns) AS turns FROM files GROUP BY root, kind').all();
    }

    /** Add a file (or give the one there): its id. */
    addFile({ path, kind, root, own }) {
        const found = this.fileByPath(path);
        if (found) {
            if (found.root !== root || found.kind !== kind || found.own !== (own ? 1 : 0)) {
                this.sql('UPDATE files SET root = ?, kind = ?, own = ? WHERE id = ?').run(root, kind, own ? 1 : 0, found.id);
            }
            return found.id;
        }
        return Number(this.sql('INSERT INTO files (path, kind, root, own) VALUES (?, ?, ?, ?)').run(path, kind, root, own ? 1 : 0).lastInsertRowid);
    }

    /** Save how far a file was read, and its facts. */
    saveFile(id, f) {
        this.sql(`UPDATE files SET size = ?, mtime = ?, ino = ?, offset = ?, state = ?, session = ?, title = ?, folder = ?, model = ?,
            created = ?, updated = ?, turns = ?, skip = ?, error = ? WHERE id = ?`).run(
            f.size ?? -1, f.mtime ?? 0, f.ino ?? 0, f.offset ?? 0, f.state === undefined ? null : JSON.stringify(f.state),
            f.session ?? '', f.title ?? '', f.folder ?? '', f.model ?? '', Math.round(f.created ?? 0), Math.round(f.updated ?? 0),
            f.turns ?? 0, f.skip ?? '', f.error ?? '', id,
        );
    }

    /** Mark a file as not read (a problem, or skipped on purpose) without losing its rows' place. */
    fileProblem(id, { size, mtime, ino, error = '', skip = '' }) {
        this.sql('UPDATE files SET size = ?, mtime = ?, ino = ?, error = ?, skip = ? WHERE id = ?').run(size ?? -1, mtime ?? 0, ino ?? 0, error, skip, id);
    }

    /** A file's title changed: its rows' title column too. */
    retitle(id, title) {
        this.sql('UPDATE files SET title = ? WHERE id = ?').run(title, id);
        const docs = this.sql('SELECT id FROM docs WHERE file = ?').all(id);
        const read = this.sql('SELECT prompt, reply, tools FROM fts WHERE rowid = ?');
        for (const { id: docId } of docs) {
            const text = read.get(docId);
            if (!text) continue;
            this.sql('DELETE FROM fts WHERE rowid = ?').run(docId);
            this.sql('INSERT INTO fts (rowid, title, prompt, reply, tools) VALUES (?, ?, ?, ?, ?)').run(docId, title, text.prompt, text.reply, text.tools);
        }
    }

    /** How many rows (turns, sections) a file has in the index. */
    rowCount(fileId) {
        return this.sql('SELECT count(*) AS n FROM docs WHERE file = ?').get(fileId)?.n ?? 0;
    }

    /** Forget a file's rows (it is read again from the start). */
    clearRows(fileId) {
        const rows = this.sql('SELECT id FROM docs WHERE file = ?').all(fileId);
        for (const { id } of rows) this.sql('DELETE FROM fts WHERE rowid = ?').run(id);
        this.sql('DELETE FROM docs WHERE file = ?').run(fileId);
        this.taken += rows.length;
    }

    /** How many rows (turns, note sections) the index holds. */
    rowTotal() {
        return this.sql('SELECT count(*) AS n FROM docs').get()?.n ?? 0;
    }

    /** Forget a file and its rows. */
    removeFile(fileId) {
        this.clearRows(fileId);
        this.sql('DELETE FROM files WHERE id = ?').run(fileId);
    }

    /** Forget every file of a folder no longer searched. @returns {number} the files forgotten. */
    removeRoot(root, kind) {
        const ids = this.sql('SELECT id FROM files WHERE root = ? AND kind = ?').all(root, kind).map((r) => r.id);
        for (const id of ids) this.removeFile(id);
        return ids.length;
    }

    /** Every file is read again (its rows replaced as it is): the rebuild. */
    staleAll() {
        this.sql("UPDATE files SET size = -1, mtime = 0, ino = 0, offset = 0, state = NULL, error = '', skip = ''").run();
    }

    // ── Rows ──────────────────────────────────────────────────────────

    /**
     * Put a turn's row (a new one, or the same turn again as it grew).
     * @param {number} fileId
     * @param {{ kind: string, title: string }} file
     * @param {object} row - from turns.rowOf or handoffs.readNote.
     */
    putRow(fileId, file, row) {
        const found = this.sql('SELECT id FROM docs WHERE file = ? AND turn = ?').get(fileId, row.turn);
        // How the turn ended, when it did not end as it should: DSH's reason (aborted, error, interrupted, …) and why.
        const ended = ['running', 'done', 'completed'].includes(row.status) || typeof row.status !== 'string' ? '' : row.status.slice(0, 40);
        const values = [row.seq ?? 0, Math.round(row.time ?? 0), row.status === 'running' ? 0 : 1, ended, ended ? String(row.why ?? '').slice(0, 300) : '', file.kind, file.folder ?? '', row.model ?? '', row.label ?? '', row.line ?? 0];
        let id;
        if (found) {
            id = found.id;
            this.sql('UPDATE docs SET seq = ?, time = ?, done = ?, ended = ?, why = ?, kind = ?, folder = ?, model = ?, label = ?, line = ? WHERE id = ?').run(...values, id);
            this.sql('DELETE FROM fts WHERE rowid = ?').run(id);
        } else {
            id = Number(this.sql('INSERT INTO docs (seq, time, done, ended, why, kind, folder, model, label, line, file, turn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...values, fileId, row.turn).lastInsertRowid);
        }
        this.sql('INSERT INTO fts (rowid, title, prompt, reply, tools) VALUES (?, ?, ?, ?, ?)').run(id, file.title ?? '', row.prompt ?? '', row.reply ?? '', row.tools ?? '');
        return id;
    }

    /** The rows of a file past its last turn (a note that got shorter). */
    trimRows(fileId, lastTurn) {
        for (const { id } of this.sql('SELECT id FROM docs WHERE file = ? AND turn > ?').all(fileId, lastTurn)) {
            this.sql('DELETE FROM fts WHERE rowid = ?').run(id);
            this.sql('DELETE FROM docs WHERE id = ?').run(id);
        }
    }

    // ── Reading ───────────────────────────────────────────────────────

    /** Filters as SQL on `docs d`. */
    static where({ kind, folder, model, from, to, file } = {}) {
        const parts = [];
        const args = [];
        if (kind) { parts.push('d.kind = ?'); args.push(kind); }
        if (folder) { parts.push("(d.folder = ? OR d.folder LIKE ? ESCAPE '\\')"); args.push(folder, likePrefix(folder)); }
        if (model) { parts.push('d.model = ?'); args.push(model); }
        if (Number.isSafeInteger(file)) { parts.push('d.file = ?'); args.push(file); }
        if (Number.isFinite(from)) { parts.push('d.time >= ?'); args.push(Math.round(from)); }
        if (Number.isFinite(to)) { parts.push('d.time < ?'); args.push(Math.round(to)); }
        return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', args };
    }

    /**
     * The best-matching rows for an FTS5 query (or the newest rows with no
     * query), at most `cap`, with their file's facts. Each row has `own`,
     * its score on its own text (below 0 when its request, reply or tools
     * say the words; 0 when only its file's title does), and `score`, on
     * its title too (below `own` when the title says some of them). Best
     * first: the rows whose own text matches come first, by `own`, then the
     * rows that match by their title alone. Newest first: by time (the
     * engine puts the rows that say the words first).
     * @param {{ match?: string, sort?: 'best'|'newest', cap?: number, filters?: object }} q
     */
    candidates({ match = '', sort = 'best', cap = 400, filters = {} }) {
        const w = Store.where(filters);
        const cols = 'd.id, d.file, d.turn, d.seq, d.time, d.done, d.kind, d.folder, d.model, d.label, d.line';
        if (!match) {
            return this.db.prepare(`SELECT ${cols}, -1 AS own, 0 AS score FROM docs d WHERE 1 = 1${w.sql} ORDER BY d.time DESC LIMIT ?`).all(...w.args, cap);
        }
        // Only what the order needs is scored for every matching row: SQLite scores the other column for the rows
        // it keeps (sorting newest first by own text too took 45 ms instead of 15 on 10k sessions).
        const order = sort === 'newest' ? 'd.time DESC' : 'own';
        // CROSS JOIN keeps the full-text match as the outer loop: led by a filter's index instead (kind and date,
        // say), SQLite would run the match again for every row the filter lets through (8.7 s instead of 19 ms on
        // 10k sessions, measured by scripts/recall-bench.mjs).
        return this.db.prepare(`SELECT ${cols}, bm25(fts, ${OWN_WEIGHTS.join(', ')}) AS own, bm25(fts, ${WEIGHTS.join(', ')}) AS score
            FROM fts CROSS JOIN docs d ON d.id = fts.rowid WHERE fts MATCH ?${w.sql} ORDER BY ${order} LIMIT ?`).all(match, ...w.args, cap);
    }

    /**
     * How many rows match an FTS5 query (the engine gives query.js's `own`,
     * so a row that matches only by its file's title is not counted), or
     * how many rows there are with no query, counting up to `cap` (more is
     * said as "cap+").
     */
    count({ match = '', filters = {}, cap = 5000 }) {
        const w = Store.where(filters);
        const inner = match
            ? `SELECT 1 FROM fts CROSS JOIN docs d ON d.id = fts.rowid WHERE fts MATCH ?${w.sql} LIMIT ?`
            : `SELECT 1 FROM docs d WHERE 1 = 1${w.sql} LIMIT ?`;
        return this.db.prepare(`SELECT count(*) AS n FROM (${inner})`).get(...(match ? [match] : []), ...w.args, cap + 1).n;
    }

    /** A file's first row (where a file that matches by its title alone opens). */
    firstRow(fileId) {
        return this.sql('SELECT id, file, turn, seq, time, done, kind, folder, model, label, line FROM docs WHERE file = ? ORDER BY turn LIMIT 1').get(fileId);
    }

    /**
     * Snippets for some rows of a match: rowid → text with \u0002…\u0003
     * around each hit. The reply's hits first (where answers are), then the
     * tools', then the request's; the title only when nothing else has one
     * (a result shows its title anyway).
     */
    snippets(match, ids) {
        const out = new Map();
        if (!match || ids.length === 0) return out;
        const marks = ids.map(() => '?').join(', ');
        const cut = (col) => `snippet(fts, ${col}, char(2), char(3), '…', 28)`;
        const rows = this.db.prepare(`SELECT rowid AS id, ${cut(2)} AS reply, ${cut(3)} AS tools, ${cut(1)} AS prompt, ${cut(0)} AS title
            FROM fts WHERE fts MATCH ? AND rowid IN (${marks})`).all(match, ...ids);
        for (const r of rows) {
            const best = [r.reply, r.tools, r.prompt, r.title].find((text) => typeof text === 'string' && text.includes('\u0002'));
            out.set(r.id, plainText(best ?? ''));
        }
        return out;
    }

    /** How each row ended (`done`, DSH's reason when it ended early, and why), for the page's rows. */
    endsOf(ids) {
        const out = new Map();
        if (ids.length === 0) return out;
        const marks = ids.map(() => '?').join(', ');
        for (const r of this.db.prepare(`SELECT id, done, ended, why FROM docs WHERE id IN (${marks})`).all(...ids)) out.set(r.id, r);
        return out;
    }

    /** This DSH's session file for a session id (the tool leaves out the turn that asks), or undefined. */
    ownSessionFile(sessionId) {
        if (typeof sessionId !== 'string' || !sessionId) return undefined;
        return this.sql('SELECT id FROM files WHERE session = ? AND own = 1 AND kind = \'session\' LIMIT 1').get(sessionId)?.id;
    }

    /** A file's open turn (a session's turn still going: the one that asks, for the tool), or undefined. */
    openTurnOf(fileId) {
        return this.sql('SELECT id FROM docs WHERE file = ? AND done = 0 ORDER BY turn DESC LIMIT 1').get(fileId)?.id;
    }

    /** Whether one row matches an FTS5 query. */
    says(match, id) {
        return Boolean(match) && this.sql('SELECT 1 AS hit FROM fts WHERE fts MATCH ? AND rowid = ?').get(match, id) !== undefined;
    }

    /** The start of each row's prompt, for "what was asked". */
    asked(ids, chars = 240) {
        const out = new Map();
        if (ids.length === 0) return out;
        const marks = ids.map(() => '?').join(', ');
        for (const r of this.db.prepare(`SELECT rowid AS id, substr(prompt, 1, ?) AS text FROM fts WHERE rowid IN (${marks})`).all(chars, ...ids)) out.set(r.id, plainText(r.text));
        return out;
    }

    /** Files by id, their facts for a result. */
    filesByIds(ids) {
        const out = new Map();
        if (ids.length === 0) return out;
        const marks = ids.map(() => '?').join(', ');
        for (const f of this.db.prepare(`SELECT id, path, kind, root, own, session, title, folder, model, updated, mtime, turns FROM files WHERE id IN (${marks})`).all(...ids)) out.set(f.id, f);
        return out;
    }

    /** One row in full: its text and facts. */
    doc(fileId, turn) {
        const d = this.sql('SELECT * FROM docs WHERE file = ? AND turn = ?').get(fileId, turn);
        if (!d) return undefined;
        const text = this.sql('SELECT title, prompt, reply, tools FROM fts WHERE rowid = ?').get(d.id) ?? {};
        return { ...d, ...text };
    }

    /** The turn numbers of a file's rows, in order (for "earlier" and "later"). */
    turnsOf(fileId) {
        return this.sql('SELECT turn FROM docs WHERE file = ? ORDER BY turn').all(fileId).map((r) => r.turn);
    }

    /** What the filters can choose from: folders, models and kinds, with counts, the most recent first. */
    facets({ limit = 200 } = {}) {
        const folders = this.sql(`SELECT folder, count(*) AS turns, count(DISTINCT file) AS files, max(time) AS last FROM docs WHERE folder != '' GROUP BY folder ORDER BY last DESC LIMIT ${limit}`).all();
        const models = this.sql(`SELECT model, count(*) AS turns, max(time) AS last FROM docs WHERE model != '' GROUP BY model ORDER BY last DESC LIMIT ${limit}`).all();
        const kinds = this.sql('SELECT kind, count(*) AS turns, count(DISTINCT file) AS files FROM docs GROUP BY kind').all();
        return { folders, models, kinds };
    }

    /** Counts for the page. */
    totals() {
        const docs = this.sql('SELECT count(*) AS n, max(time) AS last FROM docs').get();
        const files = this.sql("SELECT count(*) AS n, sum(CASE WHEN error != '' THEN 1 ELSE 0 END) AS problems, sum(CASE WHEN skip != '' THEN 1 ELSE 0 END) AS skipped FROM files").get();
        return { turns: docs.n, last: docs.last ?? 0, files: files.n, problems: files.problems ?? 0, skipped: files.skipped ?? 0 };
    }

    /** Files that could not be read, with why: the newest first. */
    problems(limit = 20) {
        return this.sql("SELECT id, path, kind, root, error, updated FROM files WHERE error != '' ORDER BY id DESC LIMIT ?").all(limit);
    }

    /** Per folder searched: files, turns, problems. */
    rootTotals() {
        return this.sql("SELECT root, kind, count(*) AS files, sum(turns) AS turns, sum(CASE WHEN error != '' THEN 1 ELSE 0 END) AS problems, max(updated) AS last FROM files WHERE skip = '' GROUP BY root, kind").all();
    }
}
