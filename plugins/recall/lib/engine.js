/**
 * The index's one owner: the store, the indexer, and the answers to what
 * the plugin asks (search, a turn in full, the filters' choices, status).
 * It runs inside the worker thread (lib/worker.js); tests and the bench
 * run it in their own thread.
 *
 * Search: the words become an FTS5 query (lib/query.js); the best 400 or
 * so matching turns are ranked by bm25 over their own text (the request,
 * the reply, the tools), lifted a fifth when their session's title says
 * the words too and a little when recent, and grouped by session (or
 * file), so one long session does not fill the page: each result is a
 * session's best turn, with how many of its other turns match and which.
 * A title's words are in every turn of its session, so a turn that matches
 * by its title alone is never a hit of its own: a session that matches
 * only by its title is one result, after every turn that says the words,
 * at its first turn.
 *
 * @module dsh-plugin-recall/engine
 */
import { homedir } from 'node:os';
import { Indexer } from './indexer.js';
import { parseQuery, spanOf } from './query.js';
import { Store } from './store.js';

const DAY = 86_400_000;
/** Bounds on a search. */
export const SEARCH_LIMITS = Object.freeze({ results: 50, offset: 1000, candidates: 4000, count: 5000, others: 8 });
/** The kinds of files Recall reads. */
export const KINDS = Object.freeze(['session', 'transcript', 'handoff']);

const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback);
const words = (value, max = 300) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

/** A folder as the index keeps it: absolute, `~/` expanded, no trailing slash. */
export function folderOf(value, home = homedir()) {
    const text = words(value, 1000);
    if (!text) return undefined;
    const full = text === '~' ? home : text.startsWith('~/') ? `${home}${text.slice(1)}` : text;
    return full.length > 1 ? full.replace(/\/+$/, '') : full;
}

/** How much more a recent turn counts: up to 30% for today, about half that after two weeks. */
const lift = (time, now) => 1 + 0.3 * Math.exp(-Math.max(0, now - time) / (20 * DAY));
/** How much more a turn that says the words counts when its session's title says them too. */
const TITLE_LIFT = 1.2;
/** A candidate row whose own text matches (its request, reply or tools say the words), not only its file's title. */
const ownHit = (r) => r.own < 0;

/** A transcript has no end-of-turn mark: its last turn is still running only while the transcript was written to lately. */
export const TRANSCRIPT_QUIET_MS = 10 * 60_000;
/** After DSH says a session stopped running, how long its log may still show the turn open (its end is read a moment later). */
export const END_GRACE_MS = 30_000;
/**
 * When rows taken out leave this share of the index file free (and at least 10 MB at 4 KB pages), or were this share
 * of its rows (and at least 4,000: the search index keeps a row's words until its parts are merged), it is made smaller.
 */
const SHRINK_SHARE = 0.2;
const SHRINK_PAGES = 2560;
const SHRINK_ROWS = 4000;
/** How often an idle index looks at whether it is worth making smaller. */
const SHRINK_LOOK_MS = 5000;
/** How a turn that ended early ended, from DSH's reason for its end; any other reason reads as stopped. */
export const END_STATES = Object.freeze({ aborted: 'stopped', error: 'failed', interrupted: 'cut-off', 'max-tokens': 'cut-short', blocked: 'blocked' });

export class Engine {
    /**
     * @param {object} options
     * @param {string} options.file - the index file.
     * @param {object} options.sqlite - node:sqlite.
     * @param {(level: string, text: string) => void} [options.log]
     * @param {(note: object) => void} [options.note]
     * @param {() => number} [options.now]
     * @param {() => number} [options.clock] - a fine clock, for how long a search took.
     */
    constructor({ file, sqlite, log = () => {}, note = () => {}, now = Date.now, clock = () => performance.now() }) {
        this.now = now;
        this.clock = clock;
        this.note = note;
        this.store = new Store(file, sqlite, { log });
        if (this.store.setAside) note({ kind: 'set-aside', stale: this.store.setAside === 'stale' });
        this.indexer = new Indexer({ store: this.store, log, note, now });
        this.facetCache = undefined;
        this.busySince = 0;
        this.busyRead = 0;
        this.busyRows = 0;
        this.busySections = 0;
        /** This DSH's sessions running now, as DSH says (`running`); until it says, a session's log moving tells. */
        this.live = new Set();
        this.liveKnown = false;
        /** When each session last stopped running, as DSH said (its turn's end is read a moment after). */
        this.stoppedAt = new Map();
        /** Giving space back to the disk: undefined, or the phase it is in ('merge', 'vacuum'); and after a rebuild. */
        this.shrinking = undefined;
        this.shrinkAfter = false;
        this.shrinkLooked = 0;
        this.shrinkFrom = 0;
        /** Why it gives space back: 'taken-out' (a folder no longer searched, files gone) or 'rebuild'. */
        this.shrinkCause = 'taken-out';
    }

    /** One request from the plugin. Throws a message in words. */
    handle(op, args = {}) {
        switch (op) {
            case 'configure': {
                const size = this.store.bytes();
                const taken = this.store.taken;
                this.indexer.configure(Array.isArray(args.sources) ? args.sources : []);
                // The size the page showed before a folder was taken out is the one What happened starts from (taking it
                // out writes to the write-ahead log, so the files are briefly bigger).
                if (this.store.taken > taken && !this.shrinkFrom) this.shrinkFrom = size;
                this.facetCache = undefined;
                // A folder no longer searched is taken out at once: look at the space it left on the next slice.
                this.shrinkLooked = 0;
                return this.status();
            }
            case 'touch':
                for (const id of Array.isArray(args.sessionIds) ? args.sessionIds.slice(0, 500) : []) this.indexer.touchSession(id);
                return true;
            case 'running': {
                // DSH's word on which of its sessions run now (sent again whenever one starts or stops).
                const live = new Set((Array.isArray(args.sessions) ? args.sessions : []).filter((id) => typeof id === 'string').slice(0, 5000));
                for (const id of this.live) if (!live.has(id)) this.stoppedAt.set(id, this.now());
                for (const id of live) this.stoppedAt.delete(id);
                if (this.stoppedAt.size > 5000) this.stoppedAt.clear();
                this.live = live;
                this.liveKnown = args.known === true;
                return true;
            }
            case 'rescan':
                this.indexer.scan();
                return this.status();
            case 'rebuild':
                this.indexer.rebuild();
                this.facetCache = undefined;
                // Every row is replaced: once it has read every file again, the index gives back what the old rows held.
                this.shrinkAfter = true;
                return this.status();
            case 'search':
                return this.search(args);
            case 'facets':
                return this.facets();
            case 'status':
                return this.status();
            case 'turn':
                return this.turn(args.id);
            default:
                throw new Error(`Recall's index has no "${String(op).slice(0, 40)}".`);
        }
    }

    /**
     * Index for about `budgetMs`.
     * @returns {{ more: boolean, idle?: { read: number, rows: number, sections: number, ms: number } }} `idle`: the index just caught up (`rows` of which `sections` are a note's sections, the rest turns).
     */
    work(budgetMs = 40) {
        const was = this.indexer.busy;
        if (!was) return this.shrinkWork(budgetMs);
        if (!this.busySince) {
            this.busySince = this.now();
            this.busyRead = this.indexer.read;
            this.busyRows = this.indexer.rowsPut;
            this.busySections = this.indexer.sectionsPut;
        }
        const more = this.indexer.step(budgetMs);
        if (this.indexer.rowsPut !== this.busyRowsSeen) {
            this.busyRowsSeen = this.indexer.rowsPut;
            this.facetCache = undefined;
        }
        if (more) return { more };
        const idle = { read: this.indexer.read - this.busyRead, rows: this.indexer.rowsPut - this.busyRows, sections: this.indexer.sectionsPut - this.busySections, ms: this.now() - this.busySince };
        this.busySince = 0;
        // Caught up: after a rebuild, or when rows taken out left much of the file free, it gives that space back next.
        if (this.shrinkAfter || (this.shrinking === undefined && this.worthShrinking())) {
            this.shrinking = 'merge';
            this.shrinkCause = this.shrinkAfter ? 'rebuild' : 'taken-out';
        }
        this.shrinkAfter = false;
        return { more: this.shrinking !== undefined, idle };
    }

    /** Whether rows taken out (a folder no longer searched, files gone) left enough of the index file free to give back. */
    worthShrinking() {
        const { free, pages, vacuum } = this.store.space();
        if (!vacuum) return false;
        if (free >= SHRINK_PAGES && free >= pages * SHRINK_SHARE) return true;
        const taken = this.store.taken;
        return taken >= SHRINK_ROWS && taken >= (this.store.rowTotal() + taken) * SHRINK_SHARE;
    }

    /**
     * While the index is idle: give space back to the disk, a slice at a time within `budgetMs` (searches are
     * answered between slices), and say so once it is done (`shrunk`: the size before and after).
     */
    shrinkWork(budgetMs) {
        if (this.shrinking === undefined) {
            // A folder taken out at once (no longer in the settings) is seen here, at most every few seconds.
            if (this.now() - this.shrinkLooked < SHRINK_LOOK_MS) return { more: false };
            this.shrinkLooked = this.now();
            if (!this.worthShrinking()) {
                // Not worth a pass yet: a later one starts from the size it finds then.
                this.shrinkFrom = 0;
                return { more: false };
            }
            this.shrinking = 'merge';
            this.shrinkCause = 'taken-out';
        }
        if (!this.shrinkFrom) this.shrinkFrom = this.store.bytes();
        const started = this.clock();
        do {
            this.shrinking = this.store.shrinkSlice(this.shrinking);
        } while (this.shrinking !== 'done' && this.clock() - started < budgetMs);
        if (this.shrinking !== 'done') return { more: true };
        this.shrinking = undefined;
        const shrunk = { before: this.shrinkFrom, after: this.store.bytes() };
        this.shrinkFrom = 0;
        this.shrinkLooked = this.now();
        if (shrunk.before - shrunk.after >= 5 * 1048576) this.note({ kind: 'shrunk', ...shrunk, cause: this.shrinkCause });
        return { more: false, shrunk };
    }

    /**
     * Search.
     * @param {object} q
     * @param {string} [q.text] - words, "phrases", -left-out words, OR; empty lists the newest turns.
     * @param {string} [q.kind] - session, transcript or handoff.
     * @param {string} [q.folder] - a folder; its subfolders count.
     * @param {string} [q.model]
     * @param {string} [q.since] - see query.momentOf.
     * @param {string} [q.until]
     * @param {'best'|'newest'} [q.sort]
     * @param {number} [q.limit] - results (sessions) on the page, 1 to 50.
     * @param {number} [q.offset]
     * @param {boolean} [q.prefix] - the last word may be cut short (typing).
     * @param {number} [q.file] - only this file's turns, one result each.
     */
    search(q = {}) {
        const started = this.clock();
        const text = typeof q.text === 'string' ? q.text.slice(0, 500) : '';
        const parsed = parseQuery(text, { prefix: q.prefix === true });
        const span = spanOf({ since: words(q.since, 60), until: words(q.until, 60), now: this.now() });
        const file = Number.isSafeInteger(q.file) && q.file > 0 ? q.file : undefined;
        const filters = {
            kind: KINDS.includes(q.kind) ? q.kind : undefined,
            folder: folderOf(q.folder),
            model: words(q.model, 200),
            from: span.from,
            to: span.to,
            file,
        };
        const limit = clamp(q.limit, 1, SEARCH_LIMITS.results, 20);
        const offset = clamp(q.offset, 0, SEARCH_LIMITS.offset, 0);
        const sort = q.sort === 'newest' ? 'newest' : 'best';
        const base = { text, words: parsed.words, excluded: parsed.excluded, sort, filters: { ...filters, from: span.from ?? null, to: span.to ?? null } };
        if (text.trim() && !parsed.match) return { ...base, total: 0, totalMore: false, sessions: 0, results: [], more: false, took: this.took(started), nothing: 'no-words' };
        // The tool's search leaves out the turn that asks (its session's open turn): it says its own words.
        const leaveFile = typeof q.leave?.session === 'string' ? this.store.ownSessionFile(q.leave.session) : undefined;
        const asking = leaveFile !== undefined ? this.store.openTurnOf(leaveFile) : undefined;
        const look = (cap) => {
            const got = this.store.candidates({ match: parsed.match, sort: parsed.match ? sort : 'newest', cap, filters });
            const rows = asking === undefined ? got : got.filter((r) => r.id !== asking);
            return { rows, got: got.length, cap, ordered: this.groupsOf(rows, { parsed, sort, file }) };
        };
        let found = look(Math.min(SEARCH_LIMITS.candidates, Math.max(400, (offset + limit) * 10)));
        // A few sessions hold most of the matching turns: look through more of them before a page comes up short.
        if (found.got >= found.cap && found.ordered.length <= offset + limit && found.cap < SEARCH_LIMITS.candidates) found = look(SEARCH_LIMITS.candidates);
        const { rows, cap, ordered } = found;
        const capped = found.got >= cap;
        // A list goes as far as its 1,000th result, and as far as the files of the turns it looked through.
        const end = Math.min(offset + limit, SEARCH_LIMITS.offset);
        const page = ordered.slice(offset, end);
        const more = ordered.length > end && end < SEARCH_LIMITS.offset;
        const cut = more ? undefined : ordered.length > end ? 'length' : capped ? 'cap' : undefined;
        // A file that matches by its title alone opens at its first turn: no turn of it says the words.
        for (const g of page) {
            if (g.titleOnly) g.best = this.store.firstRow(g.best.file) ?? g.best;
        }
        const ids = page.filter((g) => !g.titleOnly).map((g) => g.best.id);
        const snippets = this.store.snippets(parsed.match, ids);
        const asked = this.store.asked(page.map((g) => g.best.id));
        const ends = this.store.endsOf(page.map((g) => g.best.id));
        const files = this.store.filesByIds([...new Set(page.map((g) => g.best.file))]);
        // Every row that says the words is here unless the cap cut them short: then the index counts them.
        const all = !capped || (sort === 'best' && parsed.match && !ownHit(rows.at(-1)));
        const counted = () => this.store.count({ match: parsed.own, filters, cap: SEARCH_LIMITS.count }) - (asking !== undefined && parsed.own && this.store.says(parsed.own, asking) ? 1 : 0);
        const total = all ? rows.filter(ownHit).length : Math.max(0, counted());
        const results = page.map((g) => this.resultOf(g, files.get(g.best.file), snippets.get(g.best.id), asked.get(g.best.id), ends.get(g.best.id)));
        const titled = ordered.filter((g) => g.titleOnly).length;
        return {
            ...base,
            total: Math.min(total, SEARCH_LIMITS.count),
            totalMore: total > SEARCH_LIMITS.count,
            sessions: ordered.length - titled,
            sessionsMore: capped,
            titled,
            titledMore: capped && titled > 0,
            results,
            more,
            ...(cut ? { cut, looked: cap } : {}),
            took: this.took(started),
        };
    }

    /**
     * The candidate rows ranked and sorted (the rows that say the words first, best or newest first; then those
     * that match by their file's title alone), as one group per file: its best turn that says the words, with its
     * other turns that do. Within one file (`file`), one group per turn.
     */
    groupsOf(rows, { parsed, sort, file }) {
        if (parsed.match && sort === 'best') {
            const now = this.now();
            for (const r of rows) r.rank = (ownHit(r) ? r.own * (r.score < r.own ? TITLE_LIFT : 1) : r.score) * lift(r.time, now);
        }
        if (parsed.match) {
            const byTime = (a, b) => b.time - a.time || b.id - a.id;
            rows.sort((a, b) => (ownHit(a) !== ownHit(b) ? (ownHit(a) ? -1 : 1) : sort === 'best' ? a.rank - b.rank : byTime(a, b)));
        }
        // A file that matches only by its title is one result, after all of those.
        const groups = new Map();
        for (const r of rows) {
            const own = ownHit(r);
            const key = file === undefined ? r.file : own ? r.id : `title:${r.file}`;
            const g = groups.get(key);
            if (!g) groups.set(key, own ? { best: r, hits: 1, others: [] } : { best: r, hits: 0, others: [], titleOnly: true });
            // With nothing typed every turn is listed, not matched: no "other turns here match".
            else if (own && parsed.match) {
                g.hits += 1;
                if (g.others.length < SEARCH_LIMITS.others) g.others.push({ turn: r.turn, seq: r.seq });
            }
        }
        const ordered = [...groups.values()];
        // One file's turns (the reading view's list): its title alone counts only when no turn says the words.
        return file !== undefined && ordered.some((g) => !g.titleOnly) ? ordered.filter((g) => !g.titleOnly) : ordered;
    }

    took(started) {
        return Math.round((this.clock() - started) * 10) / 10;
    }

    resultOf(g, f = {}, snippet = '', asked = '', end = undefined) {
        const d = g.best;
        const state = this.stateOf(d, f, end);
        return {
            id: `${d.file}.${d.turn}`,
            file: d.file,
            kind: d.kind,
            own: f.own === 1,
            sessionId: f.session || undefined,
            path: d.kind === 'session' && f.own === 1 ? undefined : f.path,
            title: f.title || '',
            turn: d.turn,
            seq: d.seq,
            line: d.line,
            label: d.label,
            time: d.time,
            folder: d.folder,
            model: d.model,
            state,
            running: state === 'running',
            ...(state && end?.why ? { why: end.why } : {}),
            snippet: snippet ?? '',
            asked: String(asked ?? '').replace(/\s+/g, ' ').trim(),
            hits: g.hits,
            others: g.others.sort((a, b) => a.turn - b.turn),
            ...(g.titleOnly ? { titleOnly: true } : {}),
        };
    }

    /**
     * A turn's state in one word: '' when it ended as it should (and for a note's section), 'running', or how it
     * ended early: 'stopped' (someone or something stopped it), 'failed', 'cut-short' (the model's length
     * limit), 'blocked' (a plugin's check), or 'cut-off' (DSH stopped under it, by a crash or a restart).
     * @param {object} d - the row: kind, done.
     * @param {object} [f] - its file: own, session, updated, mtime.
     * @param {{ ended?: string }} [end] - how it ended (the row's own `ended`, when it has one).
     */
    stateOf(d, f = {}, end = d) {
        if (d.kind === 'handoff') return '';
        if (d.done !== 0) return end?.ended ? END_STATES[end.ended] ?? 'stopped' : '';
        // This DSH's session runs only while DSH says so; its end is read a moment after DSH says it stopped.
        if (d.kind === 'session' && f.own === 1 && this.liveKnown) {
            if (this.live.has(f.session)) return 'running';
            const stopped = this.stoppedAt.get(f.session);
            return stopped !== undefined && this.now() - stopped < END_GRACE_MS ? '' : 'cut-off';
        }
        // A transcript has no end mark: its last turn runs while it is written to (its own last time, else its
        // file's). So does another DSH's session, and when that log is quiet with a turn open, its DSH stopped under it.
        const last = Number(f.updated) > 0 ? Number(f.updated) : Number(f.mtime) || 0;
        if (this.now() - last < TRANSCRIPT_QUIET_MS) return 'running';
        return d.kind === 'session' ? 'cut-off' : '';
    }

    /** A row's state for an answer: its word, whether it runs, and why it ended early when DSH said. */
    stateFields(d, f) {
        const state = this.stateOf(d, f);
        return { state, running: state === 'running', ...(state && d.why ? { why: d.why } : {}) };
    }

    /** One turn (or note section) in full, by its result id ("12.4"). */
    turn(id) {
        const m = /^(\d{1,12})\.(\d{1,9})$/.exec(String(id ?? '').trim());
        if (!m) throw new Error('Name a result by its id, such as 12.4.');
        const d = this.store.doc(Number(m[1]), Number(m[2]));
        if (!d) throw new Error('That result is no longer in the index (its file changed or went). Search again.');
        const f = this.store.fileById(d.file) ?? {};
        const turns = this.store.turnsOf(d.file);
        const at = turns.indexOf(d.turn);
        return {
            id: `${d.file}.${d.turn}`,
            file: d.file,
            kind: d.kind,
            own: f.own === 1,
            sessionId: f.session || undefined,
            path: f.path,
            title: d.title || f.title || '',
            turn: d.turn,
            seq: d.seq,
            line: d.line,
            label: d.label,
            time: d.time,
            folder: d.folder,
            model: d.model,
            ...this.stateFields(d, f),
            prompt: d.prompt ?? '',
            reply: d.reply ?? '',
            tools: d.tools ?? '',
            prev: at > 0 ? turns[at - 1] : undefined,
            next: at >= 0 && at < turns.length - 1 ? turns[at + 1] : undefined,
            count: turns.length,
        };
    }

    /** The filters' choices (kept a few seconds; read again after new rows). */
    facets() {
        if (this.facetCache && this.now() - this.facetCache.at < 5000) return this.facetCache.value;
        const value = this.store.facets();
        this.facetCache = { at: this.now(), value };
        return value;
    }

    /** Where the index is. */
    status() {
        const ix = this.indexer.status();
        const byRoot = new Map(this.store.rootTotals().map((r) => [`${r.kind}:${r.root}`, r]));
        // How far this catch-up has read: files read since it began, files left, and whether a folder is still being looked through (more may come).
        const batch = ix.busy ? { read: this.busySince ? Math.max(0, this.indexer.read - this.busyRead) : 0, left: ix.queued, looking: Boolean(ix.walking) || this.indexer.walks.length > 0 } : undefined;
        return {
            ...ix,
            ...(batch ? { batch } : {}),
            totals: this.store.totals(),
            bytes: this.store.bytes(),
            problems: this.store.problems(10),
            roots: ix.roots.map((r) => {
                const t = byRoot.get(`${r.kind}:${r.root}`);
                return { ...r, indexed: t?.files ?? 0, turns: t?.turns ?? 0, problems: t?.problems ?? 0, last: t?.last ?? 0 };
            }),
        };
    }

    close() {
        this.store.close();
    }
}
