/**
 * A thread's shell-command edits, counted from the folder itself.
 *
 * DSH's file tools record what they changed (changes.js), but a shell
 * command's writes leave no record of their own. So the plugin snapshots
 * the thread's folder before its turn's first shell command runs
 * (projects.js aroundTool calls shellSnapshot), and diffs that snapshot at
 * the turn's end: every file that appeared, disappeared or changed counts
 * its lines as a diff does (changes.js lineDelta). No git is involved, so
 * this works where the folder is no repository, and the counts land in the
 * thread's change records like every other count (store.js), so they
 * outlive a DSH restart. The snapshot is the counting's whole memory of the
 * folder and lives in the running process only: a turn that was running
 * when DSH restarted counts no shell edits, and files past the caps below
 * are never counted.
 *
 * The folder diff sees every change in the window, whoever made it, so a
 * turn's shell edits count whole only when no other session's mutating
 * call (a shell command, or a file-tool edit) ran during it — the plugin
 * watches every session's calls as DSH runs them. When another session's
 * call did run in the window, the turn keeps only the files its own calls
 * alone could have written (ownWrite): the file's last change fell inside
 * one of the thread's own calls, and no other session's call ran between
 * the earliest the file could have changed and that change. A file gone in
 * such a window, or one another call could have touched, counts nothing
 * rather than guess. What no DSH session ran (the user's editor, another
 * app, another DSH on the same folder) the window cannot tell apart, and
 * counts as the thread's: that is the rule's limit, not a proof. File
 * times come from the folder's own file system, so a network folder whose
 * clock is off by more than the slack can be read wrong; one that stamps a
 * change in the future makes the turn count nothing.
 *
 * @module dsh-plugin-coordinator/shell
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CLOCK_SLACK_MS } from './deletes.js';
import { fileLines, lineDelta } from './changes.js';

/** DSH's shell tools, whose writes a folder snapshot counts. */
export const SHELL_TOOLS = new Set(['bash', 'pwsh']);

/** Every call that may write, so a shell window knows whose changes it may hold. */
export const MUTATING_TOOLS = new Set([...SHELL_TOOLS, 'write', 'edit', 'str_replace_editor']);

/** Folders the walk never enters: git's own store, and the caches installs and builds leave. */
export const SKIPPED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);

/** Most entries one walk visits, folders and files alike; past it the walk is partial and counts only what it covered. */
export const MAX_WALK_FILES = 20_000;
/** Largest file captured whole; a bigger one counts only that it changed. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Most content one snapshot keeps; past it the walk stops, partial. */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** Bytes probed for a NUL before content counts as binary, as DSH's own capture decides it. */
const BINARY_PROBE_BYTES = 8000;

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One file's captured side: its bytes (absent for an oversized file, which
 * counts only that it changed), whether they are binary, and the stat the
 * diff compares before reading anything.
 * @typedef {{bytes?: Buffer, binary?: true, oversized?: true, mtimeMs: number, size: number}} ShellSide
 */

/**
 * The folder as one walk saw it, breadth-first in sorted order, so a
 * partial walk covers the same shallow files both times. Each value's key
 * is the file's absolute path.
 * @param {string} root
 * @returns {Promise<{files: Map<string, ShellSide>, partial: boolean}>}
 */
export async function snapshotFolder(root) {
    const files = new Map();
    let partial = false;
    let total = 0;
    let visited = 0;
    const queue = [root];
    for (let head = 0; head < queue.length; head++) {
        const dir = queue[head];
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        entries.sort((a, b) => byName(a.name, b.name));
        for (const entry of entries) {
            if (++visited > MAX_WALK_FILES) {
                partial = true;
                queue.length = 0;
                break;
            }
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) queue.push(join(dir, entry.name));
                continue;
            }
            if (files.size >= MAX_WALK_FILES) {
                partial = true;
                queue.length = 0;
                break;
            }
            const at = join(dir, entry.name);
            const side = await captureAt(at, total);
            if (side === undefined) continue;
            if (side.stop === true) {
                partial = true;
                queue.length = 0;
                break;
            }
            total += side.bytes?.length ?? 0;
            delete side.stop;
            files.set(at, side);
        }
    }
    return { files, partial };
}

/**
 * One file now: its side for the snapshot, or undefined for anything that
 * is no readable file (a link to a folder, a file with no permission).
 * `stop` asks the walk to end: the content budget is spent.
 * @param {string} at
 * @param {number} kept - bytes of content the walk has already kept.
 * @returns {Promise<(ShellSide & {stop?: true})|undefined>}
 */
async function captureAt(at, kept) {
    let st;
    try {
        st = await stat(at);
    } catch {
        return undefined;
    }
    if (!st.isFile()) return undefined;
    const side = { mtimeMs: st.mtimeMs, size: st.size };
    if (st.size > MAX_FILE_BYTES) return { ...side, oversized: true };
    if (kept + st.size > MAX_SNAPSHOT_BYTES) return { ...side, stop: true };
    let bytes;
    try {
        bytes = await readFile(at);
    } catch {
        return undefined;
    }
    return { ...side, bytes, ...(bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) ? { binary: true } : {}) };
}

/**
 * A turn's shell edits: the folder now against `before`. Files that
 * appeared count as created, files that disappeared count their lines
 * deleted (but only when the second walk was complete — a partial one
 * cannot tell a deleted file from one it never reached), and a file whose
 * stat moved is read and counted as a diff counts lines. A file that went
 * binary, or past the caps, on either side counts only that it changed.
 * @param {string} root
 * @param {{files: Map<string, ShellSide>}} before - snapshotFolder's answer for the same root.
 * @param {Map<string, {changed: number, born: number}>} [times] - filled with each file the walk found: when it last
 *   changed and when it was born (ms, from its stat), for a shared window's attribution (ownWrite).
 * @returns {Promise<Array<{path: string, added: number, deleted: number, created?: true, binary?: true, oversized?: true}>>}
 *   paths absolute, resolved like the snapshot's.
 */
export async function diffFolder(root, before, times = undefined) {
    const edits = [];
    const seen = new Set();
    let partial = false;
    let visited = 0;
    const queue = [root];
    for (let head = 0; head < queue.length; head++) {
        const dir = queue[head];
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        entries.sort((a, b) => byName(a.name, b.name));
        for (const entry of entries) {
            if (++visited > MAX_WALK_FILES) {
                partial = true;
                queue.length = 0;
                break;
            }
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) queue.push(join(dir, entry.name));
                continue;
            }
            if (seen.size >= MAX_WALK_FILES) {
                partial = true;
                queue.length = 0;
                break;
            }
            const at = join(dir, entry.name);
            seen.add(at);
            const was = before.files.get(at);
            let st;
            try {
                st = await stat(at);
            } catch {
                continue;
            }
            if (!st.isFile()) continue;
            times?.set(at, { changed: st.mtimeMs, born: st.birthtimeMs });
            if (was === undefined) {
                // The after walk keeps nothing, so its reads cost the one file, never a budget.
                const side = await captureAt(at, 0);
                if (side === undefined || side.stop === true) continue;
                edits.push(side.oversized === true
                    ? { path: at, added: 0, deleted: 0, created: true, oversized: true }
                    : side.binary === true
                        ? { path: at, added: 0, deleted: 0, created: true, binary: true }
                        : { path: at, added: fileLines(side.bytes.toString('utf8')).length, deleted: 0, created: true });
                continue;
            }
            if (was.mtimeMs === st.mtimeMs && was.size === st.size) continue;
            if (was.oversized === true) {
                edits.push({ path: at, added: 0, deleted: 0, oversized: true });
                continue;
            }
            const after = await captureAt(at, 0);
            if (after === undefined || after.stop === true) continue;
            if (after.oversized === true) {
                edits.push({ path: at, added: 0, deleted: 0, oversized: true });
                continue;
            }
            // A side that was binary has no lines to compare, whichever way it went.
            if (was.binary === true || after.binary === true) {
                edits.push({ path: at, added: 0, deleted: 0, binary: true });
                continue;
            }
            if (was.bytes.equals(after.bytes)) continue;
            const delta = lineDelta(fileLines(was.bytes.toString('utf8')), fileLines(after.bytes.toString('utf8')));
            if (delta.added + delta.deleted > 0) edits.push({ path: at, ...delta });
        }
    }
    if (!partial) {
        for (const [at, was] of before.files) {
            if (seen.has(at)) continue;
            edits.push(was.oversized === true
                ? { path: at, added: 0, deleted: 0, oversized: true }
                : was.binary === true
                    ? { path: at, added: 0, deleted: 0, binary: true }
                    : { path: at, added: 0, deleted: fileLines(was.bytes.toString('utf8')).length });
        }
    }
    return edits;
}

/**
 * When each owner's mutating calls ran, so a turn's shell window knows
 * whose changes it may hold. An owner is a thread session (its own calls
 * and its subagents', projects.js threadOfCall) or any other session's id.
 * The manager begins every mutating call and ends it after; a window from
 * `from` to `to` is clean when no other owner's call ran in it, and the
 * thread's own ran in no turn but the one being counted. A window that is
 * not clean hands its calls to ownWrite (spansIn), file by file.
 */
export class Mutations {
    constructor() {
        /** owner → {running, since, turn, spans: [{from, to, turn}]} */
        this.owners = new Map();
        /** How near two times may be and still be told apart, ms. */
        this.slack = CLOCK_SLACK_MS;
    }

    /** A mutating call of `owner`, in `turn` when it is a thread's, is starting. */
    begin(owner, turn = null) {
        const entry = this.owners.get(owner) ?? { running: 0, since: 0, turn: null, spans: [] };
        if (entry.running === 0) {
            entry.since = Date.now();
            entry.turn = turn;
        }
        entry.running += 1;
        this.owners.set(owner, entry);
    }

    /** The owner's outermost mutating call ended; its interval is kept. */
    end(owner) {
        const entry = this.owners.get(owner);
        if (entry === undefined || entry.running === 0) return;
        entry.running -= 1;
        if (entry.running > 0) return;
        const span = { from: entry.since, to: Date.now(), turn: entry.turn };
        const last = entry.spans.at(-1);
        if (last && last.turn === span.turn && span.from - last.to <= this.slack) last.to = span.to;
        else entry.spans.push(span);
        if (entry.spans.length > 2000) entry.spans.splice(0, entry.spans.length - 2000);
        for (const key of [...this.owners.keys()].slice(0, -500)) {
            if (this.owners.get(key).running === 0) this.owners.delete(key);
        }
    }

    /**
     * Whether the window from `from` to `to` holds a change this turn
     * cannot claim: another owner's mutating call ran in it, or the
     * thread's own ran in another turn (the next turn may have started
     * while this one's diff was still due).
     * @param {string} own - the thread's session.
     * @param {number} from
     * @param {number} to
     * @param {number|null} turn - the turn being counted.
     */
    overlapped(own, from, to, turn) {
        for (const [owner, entry] of this.owners) {
            if (owner !== own) {
                if (entry.running > 0 && entry.since < to) return true;
                if (entry.spans.some((span) => span.from < to && span.to > from)) return true;
                continue;
            }
            if (entry.running > 0 && entry.since < to && entry.turn !== turn) return true;
            if (entry.spans.some((span) => span.turn !== turn && span.from < to && span.to > from)) return true;
        }
        return false;
    }

    /**
     * Every owner's calls that came near the window from `from` to `to`
     * (within the slack), a running one's until now, for ownWrite.
     * @returns {Array<{owner: string, from: number, to: number, turn: number|null}>}
     */
    spansIn(from, to) {
        const now = Date.now();
        const out = [];
        for (const [owner, entry] of this.owners) {
            const spans = entry.running > 0 ? [...entry.spans, { from: entry.since, to: now, turn: entry.turn }] : entry.spans;
            for (const span of spans) {
                if (span.from <= to + this.slack && span.to >= from - this.slack) out.push({ owner, from: span.from, to: span.to, turn: span.turn });
            }
        }
        return out;
    }
}

/** Whether a file's stat says when it was born: true on macOS and Windows; elsewhere a birth time can be the change time or 0. */
export const BIRTH_TIMES = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Whether one file's change in a shared window is the thread's own
 * (projects.js shellEdits): its last write, at `at`, fell inside one of
 * the thread's own calls of `turn`, and no other owner's call, nor the
 * thread's own in another turn, ran from `since` (the earliest the file
 * could have changed: the snapshot's start, or a new file's birth) to that
 * write. Each edge keeps the slack, so a write near another call's edge is
 * nobody's.
 * @param {Array<{owner: string, from: number, to: number, turn: number|null}>} spans - Mutations.spansIn's answer.
 * @param {string} own - the thread's session.
 * @param {number|null} turn
 * @param {number} since - ms.
 * @param {number} at - ms.
 * @param {number} [slack]
 */
export function ownWrite(spans, own, turn, since, at, slack = CLOCK_SLACK_MS) {
    if (!Number.isFinite(since) || !Number.isFinite(at)) return false;
    const lo = Math.min(since, at) - slack;
    const hi = at + slack;
    let inOwn = false;
    for (const span of spans) {
        if (span.owner === own && span.turn === turn) {
            if (span.from - slack <= at && at <= span.to + slack) inOwn = true;
        } else if (span.from <= hi && span.to >= lo) {
            return false;
        }
    }
    return inOwn;
}
