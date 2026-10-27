/**
 * A thread's code changes: per turn, the files it changed and lines added
 * and deleted, counted from its own file-tool records (below), in the
 * shape of DSH's per-turn change summaries (the `workspaceChanges` service
 * behind DSH's "Edited N files +a -d" card). The plugin stores them with
 * the thread, so the totals outlive a DSH restart; DSH keeps its own
 * summary, which Review opens, only while the session lives in the
 * running Host. Pure functions.
 *
 * @module dsh-plugin-coordinator/changes
 */

/** Records kept per thread (older turns fold into one) and files kept per record. */
export const MAX_TURNS = 40;
export const MAX_FILES = 100;

const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

/**
 * One turn's summary as the store keeps it.
 * @param {number} seq - the `workspace/changes` event that announced it.
 * @param {object} summary - DSH's summary: {turn, files: [{path, display, added, deleted, binary?, oversized?}], total, added, deleted};
 *   or the plugin's own (editSummary), whose files say which the thread `created`, for the delete check.
 * @returns {{turn, seq, added, deleted, total, files: Array<{path, added, deleted, binary?, oversized?, created?}>}|null}
 */
export function changeRecord(seq, summary) {
    if (!Number.isSafeInteger(seq) || summary === null || typeof summary !== 'object' || !Number.isSafeInteger(summary.turn)) return null;
    const files = (Array.isArray(summary.files) ? summary.files : []).slice(0, MAX_FILES).map((f) => ({
        path: String(f?.display ?? f?.path ?? '').slice(0, 300),
        added: count(f?.added),
        deleted: count(f?.deleted),
        ...(f?.binary === true ? { binary: true } : {}),
        ...(f?.oversized === true ? { oversized: true } : {}),
        ...(f?.created === true ? { created: true } : {}),
        ...(f?.created === true && identityOf(f?.identity) ? { identity: identityOf(f.identity) } : {}),
    }));
    return { turn: summary.turn, seq, added: count(summary.added), deleted: count(summary.deleted), total: Math.max(count(summary.total), files.length), files };
}

/**
 * Which file a created file was when its turn was kept ({dev, ino, birth},
 * deletes.js identityOf), so the delete check knows it is still the one
 * the thread made; undefined for anything else.
 */
function identityOf(value) {
    if (!isObject(value) || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino) || !Number.isFinite(value.birth)) return undefined;
    return { dev: value.dev, ino: value.ino, birth: value.birth };
}

/**
 * A thread's records with one turn's newest summary in place of an earlier
 * one (DSH announces a turn again when its changes change); a summary
 * without files drops the turn. Past MAX_TURNS the two oldest records fold
 * into one, so the totals still count every turn.
 */
export function withChange(records, record) {
    const rest = (Array.isArray(records) ? records : []).filter((r) => r?.turn !== record.turn);
    if (record.total > 0) rest.push(record);
    rest.sort((a, b) => a.seq - b.seq);
    while (rest.length > MAX_TURNS) rest.splice(0, 2, folded(rest[0], rest[1]));
    return rest;
}

/** Two records as one, in the later one's place: lines summed, files merged by path, `turns` counting both. */
function folded(a, b) {
    const byPath = new Map();
    for (const f of [...(Array.isArray(a.files) ? a.files : []), ...(Array.isArray(b.files) ? b.files : [])]) {
        const was = byPath.get(f?.path);
        byPath.set(f?.path, was ? {
            ...was, added: count(was.added) + count(f.added), deleted: count(was.deleted) + count(f.deleted), ...(f?.created === true ? { created: true } : {}),
            ...(identityOf(f?.identity) ? { identity: f.identity } : {}),
        } : f);
    }
    const files = [...byPath.values()].slice(0, MAX_FILES);
    const unlisted = (r) => Math.max(0, count(r.total) - (Array.isArray(r.files) ? r.files.length : 0));
    return {
        turn: b.turn, seq: b.seq, added: count(a.added) + count(b.added), deleted: count(a.deleted) + count(b.deleted),
        total: byPath.size + unlisted(a) + unlisted(b), files, turns: turnsIn(a) + turnsIn(b),
    };
}

/** How many turns a record stands for (more than one once older turns fold into it). */
const turnsIn = (r) => (Number.isSafeInteger(r?.turns) && r.turns > 1 ? r.turns : 1);

/**
 * A thread's changes over all its turns: lines added and deleted (summed
 * over the turns, as each turn's card counts them), how many files, and
 * the newest turn that changed files (`last`, what DSH's Review tab opens).
 * null when it changed nothing.
 */
export function changeTotals(records) {
    const list = Array.isArray(records) ? records.filter((r) => r && Number.isSafeInteger(r.seq) && Number.isSafeInteger(r.turn)) : [];
    if (list.length === 0) return null;
    const paths = new Set();
    let added = 0;
    let deleted = 0;
    let unlisted = 0;
    let turns = 0;
    for (const r of list) {
        turns += turnsIn(r);
        added += count(r.added);
        deleted += count(r.deleted);
        const files = Array.isArray(r.files) ? r.files : [];
        for (const f of files) paths.add(f?.path);
        unlisted += Math.max(0, count(r.total) - files.length);
    }
    const last = list[list.length - 1];
    return { added, deleted, files: paths.size + unlisted, turns, last: { seq: last.seq, turn: last.turn } };
}

/** "changed 2 files (+18 -3)", or '' when there is nothing to say. */
export function changesLine(totals) {
    if (!totals || !(totals.files > 0)) return '';
    return `changed ${totals.files} file${totals.files === 1 ? '' : 's'} (+${totals.added} -${totals.deleted})`;
}

/**
 * A thread's own edits. DSH's per-turn summary diffs the whole folder, so
 * threads sharing a folder would be credited with each other's edits: the
 * plugin counts a thread's changes from its own file-tool records (and its
 * subagents') instead, and keeps them in the records above, one per turn.
 * A shell command's edits leave no record; they are counted from a folder
 * snapshot instead (shell.js), and folded in here like the rest.
 */

/** DSH's file tools whose records say what they changed. */
export const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

/** Past this many cells (lines × lines), a hunk's middle counts whole instead of being matched line by line. */
const MATCH_CELLS = 4_000_000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/** A file's text as lines, the way git counts them: '' has none, and a final newline ends the last line. */
export function fileLines(text) {
    if (typeof text !== 'string' || text === '') return [];
    const body = text.replace(/\r\n?/g, '\n');
    return (body.endsWith('\n') ? body.slice(0, -1) : body).split('\n');
}

/** A hunk's side as lines (DSH joins them with '\n'); null or '' has none. */
const hunkLines = (text) => (typeof text === 'string' && text !== '' ? text.split('\n') : []);

/** How many lines two lists share in order (a longest common subsequence), in two rows. */
function commonLines(a, b) {
    let prev = new Uint32Array(b.length + 1);
    let row = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
        [prev, row] = [row, prev];
    }
    return prev[b.length];
}

/**
 * Lines added and deleted from one list of lines to another, as a diff
 * counts them: the lines both keep in order stay, the rest of the old
 * ones are deleted and the rest of the new ones added.
 */
export function lineDelta(before, after) {
    const a = Array.isArray(before) ? before : [];
    const b = Array.isArray(after) ? after : [];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const x = a.slice(start, a.length - end);
    const y = b.slice(start, b.length - end);
    const same = x.length > 0 && y.length > 0 && x.length * y.length <= MATCH_CELLS ? commonLines(x, y) : 0;
    return { added: y.length - same, deleted: x.length - same };
}

/**
 * What one successful file-tool call changed: its file, and lines added
 * and deleted. DSH's `write` and `edit` keep their hunks (with three lines
 * of context) in the result's `meta.diffs`, and a new file's text is the
 * call's `content`; `str_replace_editor` keeps only its arguments.
 * @returns {{path: string, added: number, deleted: number, created?: true}|null} null when it changed nothing countable.
 */
export function editOf(name, args, meta) {
    const a = isObject(args) ? args : {};
    const m = isObject(meta) ? meta : {};
    const pathOf = (...values) => values.map((v) => (typeof v === 'string' ? v.trim() : '')).find((v) => v !== '') ?? '';
    if (name === 'write' || name === 'edit') {
        const path = pathOf(m.path, a.file_path);
        if (!path) return null;
        if (name === 'write' && m.operation === 'create') return { path, added: fileLines(textOf(a.content)).length, deleted: 0, created: true };
        if (!Array.isArray(m.diffs)) return null;
        let added = 0;
        let deleted = 0;
        for (const hunk of m.diffs) {
            if (!isObject(hunk)) continue;
            const n = lineDelta(hunkLines(hunk.oldText), hunkLines(hunk.newText));
            added += n.added;
            deleted += n.deleted;
        }
        return { path, added, deleted };
    }
    if (name === 'str_replace_editor') {
        const path = pathOf(a.path);
        if (!path) return null;
        switch (a.command) {
            case 'create': return { path, added: fileLines(textOf(a.file_text)).length, deleted: 0, created: true };
            case 'str_replace': return { path, ...lineDelta(fileLines(textOf(a.old_str)), fileLines(textOf(a.new_str))) };
            case 'insert': return { path, added: fileLines(textOf(a.new_str)).length, deleted: 0 };
            default: return null;
        }
    }
    return null;
}

/** A tool call's arguments, which DSH may keep as JSON text. */
function argsOf(value) {
    if (typeof value !== 'string') return isObject(value) ? value : {};
    try { return JSON.parse(value); } catch { return {}; }
}

/**
 * The edits in a session's records, in order: each successful file-tool
 * call (its `tool/call` and then its `tool/result`) as an edit with the
 * turn it ran in and its result's seq. Failed calls changed nothing.
 * @param {{hunks?: boolean}} [options] - `hunks`: keep each edit's hunks (hunksOf) for a diff view.
 * @returns {Array<{turn: number, seq: number, path: string, added: number, deleted: number, created?: true, hunks?: object[]}>}
 */
export function editsIn(events, { hunks = false } = {}) {
    const calls = new Map();
    const out = [];
    for (const event of Array.isArray(events) ? events : []) {
        if (event?.type === 'tool/call') {
            const d = event.data;
            if (FILE_TOOLS.has(d?.name) && typeof d.callId === 'string') calls.set(d.callId, { name: d.name, args: d.arguments, turn: d.turn });
            continue;
        }
        if (event?.type !== 'tool/result') continue;
        const message = event.data?.message;
        const callId = message?.toolCallId ?? message?.source?.callId;
        const call = calls.get(callId);
        if (!call) continue;
        calls.delete(callId);
        if (message?.isError === true || event.data?.error !== undefined) continue;
        const args = argsOf(call.args);
        const edit = editOf(call.name, args, event.data?.meta);
        if (!edit || !(edit.added + edit.deleted > 0 || edit.created)) continue;
        const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : call.turn;
        if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(event.seq)) continue;
        out.push({ turn, seq: event.seq, call: callId, ...edit, ...(hunks ? { hunks: hunksOf(call.name, args, event.data?.meta) } : {}) });
    }
    return out;
}

/**
 * Edits as one summary in the shape of DSH's per-turn summary, which
 * `changeRecord` keeps: each file once, its lines summed over its edits,
 * a path inside the folder written relative to it, and `created` when an
 * edit created it.
 * @param {string} [folder] - the thread's folder.
 * @returns {{turn, files: Array<{path, added, deleted, created?}>, total, added, deleted}|null} null when nothing changed.
 */
export function editSummary(turn, edits, folder = '') {
    const byPath = new Map();
    for (const e of Array.isArray(edits) ? edits : []) {
        if (typeof e?.path !== 'string' || e.path === '') continue;
        const path = placeIn(folder, e.path);
        const was = byPath.get(path) ?? { path, added: 0, deleted: 0 };
        byPath.set(path, {
            path,
            added: was.added + count(e.added),
            deleted: was.deleted + count(e.deleted),
            ...(was.created || e.created ? { created: true } : {}),
            ...(was.binary === true || e.binary === true ? { binary: true } : {}),
            ...(was.oversized === true || e.oversized === true ? { oversized: true } : {}),
        });
    }
    if (byPath.size === 0) return null;
    const files = [...byPath.values()];
    return { turn, files, total: files.length, added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0) };
}

/** A path inside the folder written relative to it, as the records keep it; any other path as it is. */
export function placeIn(folder, path) {
    const root = typeof folder === 'string' ? folder.replace(/\/+$/, '') : '';
    const within = (r, p) => (r !== '' && p.startsWith(`${r}/`) ? p.slice(r.length + 1) : undefined);
    // On macOS /var, /tmp and /etc are links into /private, and DSH 0.2.0 names a folder there by its real path
    // while a tool names a file by the path it was given: one place, two spellings.
    const p = within(root, path) ?? within(unprivate(root), unprivate(path)) ?? path;
    return p.replace(/^(\.\/)+/, '');
}

/** A path under macOS's /private/var, /private/tmp or /private/etc, as its usual spelling (/var, /tmp, /etc). */
const unprivate = (path) => path.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, '');

/**
 * A thread's changes as its Changes tab shows them: each file with its
 * edits' hunks, in the shape DSH's DiffBlock draws (`oldText` null for a
 * file the edit created). Text past these limits is left out, its lines
 * still counted.
 */
export const MAX_HUNK_CHARS = 64 * 1024;
export const MAX_VIEW_CHARS = 1024 * 1024;

/**
 * One successful file-tool call's hunks: `write` and `edit` keep theirs,
 * with three lines of context, in the result's `meta.diffs`, and a new
 * file's text is the call's `content`; `str_replace_editor` has only its
 * arguments, so its hunk is the text it replaced, without context.
 * @returns {Array<{oldText: string|null, newText: string}>}
 */
export function hunksOf(name, args, meta) {
    const a = isObject(args) ? args : {};
    const m = isObject(meta) ? meta : {};
    if (name === 'write' || name === 'edit') {
        if (name === 'write' && m.operation === 'create') return [{ oldText: null, newText: textOf(a.content) }];
        if (!Array.isArray(m.diffs)) return [];
        return m.diffs.filter(isObject).map((d) => ({ oldText: typeof d.oldText === 'string' ? d.oldText : null, newText: textOf(d.newText) }));
    }
    if (name === 'str_replace_editor') {
        switch (a.command) {
            case 'create': return [{ oldText: null, newText: textOf(a.file_text) }];
            case 'str_replace': return [{ oldText: textOf(a.old_str), newText: textOf(a.new_str) }];
            case 'insert': return [{ oldText: '', newText: textOf(a.new_str) }];
            default: return [];
        }
    }
    return [];
}

/**
 * The subagents a session started, from DSH's `subagent/catalog` facts in
 * its log: each child session once, with its label and the turn of the
 * session it started in. An external child has no session here.
 * @returns {Array<{id: string, label: string, turn: number|null}>}
 */
export function subagentsIn(events) {
    const out = [];
    const seen = new Set();
    let turn = null;
    for (const event of Array.isArray(events) ? events : []) {
        if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn;
        if (event?.type !== 'subagent/catalog') continue;
        const d = event.data;
        if (!isObject(d) || typeof d.childId !== 'string' || d.childId === '' || d.mode === 'external' || seen.has(d.childId)) continue;
        seen.add(d.childId);
        out.push({ id: d.childId, label: typeof d.label === 'string' ? d.label.trim().slice(0, 80) : '', turn });
    }
    return out;
}

/**
 * Edits grouped by file for the Changes tab, in the order the files were
 * first changed: lines added and deleted over every edit, whether the
 * first edit created the file, and each edit with its turn, who made it
 * (`by`, a subagent) and its hunks. Past MAX_VIEW_CHARS of text in all, and
 * for any hunk past MAX_HUNK_CHARS, the hunks are left out (`clipped`)
 * while their lines still count.
 * @param {Array} edits - from editsIn with hunks, a subagent's carrying `by`.
 * @param {string} [folder] - the thread's folder: paths inside it are written relative to it.
 * @returns {Array<{path, added, deleted, created?, edits: Array<{turn, seq, by?, added, deleted, created?, hunks, clipped?}>}>}
 */
export function diffFiles(edits, folder = '') {
    const byPath = new Map();
    let budget = MAX_VIEW_CHARS;
    for (const e of Array.isArray(edits) ? edits : []) {
        if (typeof e?.path !== 'string' || e.path === '') continue;
        const path = placeIn(folder, e.path);
        let file = byPath.get(path);
        if (!file) {
            if (byPath.size >= MAX_FILES) continue;
            file = { path, added: 0, deleted: 0, ...(e.created ? { created: true } : {}), edits: [] };
            byPath.set(path, file);
        }
        file.added += count(e.added);
        file.deleted += count(e.deleted);
        const hunks = [];
        let clipped = false;
        for (const hunk of Array.isArray(e.hunks) ? e.hunks : []) {
            if (!isObject(hunk)) continue;
            const size = (typeof hunk.oldText === 'string' ? hunk.oldText.length : 0) + textOf(hunk.newText).length;
            if (size > MAX_HUNK_CHARS || size > budget) {
                clipped = true;
                continue;
            }
            budget -= size;
            hunks.push({ oldText: typeof hunk.oldText === 'string' ? hunk.oldText : null, newText: textOf(hunk.newText) });
        }
        file.edits.push({
            turn: Number.isSafeInteger(e.turn) ? e.turn : null, seq: Number.isSafeInteger(e.seq) ? e.seq : null,
            ...(typeof e.by === 'string' && e.by !== '' ? { by: e.by } : {}),
            added: count(e.added), deleted: count(e.deleted), ...(e.created ? { created: true } : {}),
            hunks, ...(clipped ? { clipped: true } : {}),
        });
    }
    return [...byPath.values()];
}

/**
 * A file's net change over a thread's edits, from its text before the
 * thread's first edit (null: the file was new) to its text after the last:
 * lines added and deleted, and hunks in DiffBlock's shape with three lines
 * of context, at most MAX_HUNK_CHANGES changed lines each, so one diff
 * shows what the thread's edits came to. Texts with the same lines give no
 * hunks: the edits undid each other, or changed only line endings or a
 * last newline (net.js view tells these apart).
 * @param {string|null} before
 * @param {string} after
 * @returns {{added: number, deleted: number, created?: true, hunks: Array<{oldText: string|null, newText: string}>}|null}
 *   null past MAX_NET_DISTANCE differing lines, too many to line up.
 */
export function netHunks(before, after) {
    const b = fileLines(after);
    if (typeof before !== 'string') return { added: b.length, deleted: 0, created: true, hunks: b.length > 0 ? [{ oldText: null, newText: b.join('\n') }] : [] };
    const a = fileLines(before);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    if (start === a.length && start === b.length) return { added: 0, deleted: 0, hunks: [] };
    // The lines between the common start and end, as numbers, so the edit script compares numbers.
    const ids = new Map();
    const idOf = (line) => {
        let id = ids.get(line);
        if (id === undefined) ids.set(line, id = ids.size);
        return id;
    };
    const x = Int32Array.from(a.slice(start, a.length - end), idOf);
    const y = Int32Array.from(b.slice(start, b.length - end), idOf);
    const ops = editScript(x, y, MAX_NET_DISTANCE);
    if (!ops) return null;
    // Each run of changed lines, as old [i0, i1) and new [j0, j1) in the whole files.
    const runs = [];
    let i = start;
    let j = start;
    for (let k = 0; k < ops.length;) {
        if (ops[k] === SAME) {
            i++;
            j++;
            k++;
            continue;
        }
        const run = { i0: i, j0: j };
        for (; k < ops.length && ops[k] !== SAME; k++) {
            if (ops[k] === DELETE) i++;
            else j++;
        }
        runs.push({ ...run, i1: i, j1: j });
    }
    // A run with more changed lines than a hunk takes goes in pieces, one after another (MAX_HUNK_CHANGES).
    const size = (run) => run.i1 - run.i0 + run.j1 - run.j0;
    const pieces = [];
    for (const run of runs) {
        let { i0, j0 } = run;
        while (run.i1 - i0 + run.j1 - j0 > MAX_HUNK_CHANGES) {
            const i = Math.min(run.i1 - i0, Math.max(MAX_HUNK_CHANGES / 2, MAX_HUNK_CHANGES - (run.j1 - j0)));
            const j = Math.min(MAX_HUNK_CHANGES - i, run.j1 - j0);
            pieces.push({ i0, j0, i1: i0 + i, j1: j0 + j });
            i0 += i;
            j0 += j;
        }
        pieces.push({ i0, j0, i1: run.i1, j1: run.j1 });
    }
    // Runs close together share a hunk while it has room; each hunk's context is unchanged lines no other hunk shows.
    const hunks = [];
    let added = 0;
    let deleted = 0;
    let shown = 0;
    for (let r = 0; r < pieces.length;) {
        let last = r;
        let changes = size(pieces[r]);
        while (last + 1 < pieces.length && pieces[last + 1].i0 - pieces[last].i1 <= 2 * NET_CONTEXT && changes + size(pieces[last + 1]) <= MAX_HUNK_CHANGES) {
            changes += size(pieces[++last]);
        }
        const first = pieces[r];
        const before0 = Math.min(NET_CONTEXT, first.i0 - shown);
        const after0 = Math.min(NET_CONTEXT, (last + 1 < pieces.length ? pieces[last + 1].i0 : a.length) - pieces[last].i1);
        hunks.push({
            oldText: a.slice(first.i0 - before0, pieces[last].i1 + after0).join('\n'),
            newText: b.slice(first.j0 - before0, pieces[last].j1 + after0).join('\n'),
        });
        for (let k = r; k <= last; k++) {
            deleted += pieces[k].i1 - pieces[k].i0;
            added += pieces[k].j1 - pieces[k].j0;
        }
        shown = pieces[last].i1 + after0;
        r = last + 1;
    }
    return { added, deleted, hunks };
}

/** Lines of context around each change in a net diff, and the most differing lines matched line by line. */
const NET_CONTEXT = 3;
export const MAX_NET_DISTANCE = 1000;
/**
 * The most changed lines (added and deleted) in one hunk of a net diff:
 * DSH's diff view gives up on a hunk with more than 256 changes and draws
 * it all as replaced.
 */
export const MAX_HUNK_CHANGES = 200;
/** The most text one file's net diff shows in a Changes tab; past it, its counts only. */
export const MAX_NET_CHARS = 256 * 1024;

const SAME = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * The shortest edit script from one list of numbers to another (Myers'
 * O(ND) diff): SAME, DELETE (the next old line) and INSERT (the next new
 * line), in order; null when more than `limit` lines differ. Each round
 * keeps only the diagonals it can reach, so memory grows with the square
 * of the lines that differ, not with the files.
 */
function editScript(x, y, limit) {
    const n = x.length;
    const m = y.length;
    const max = Math.min(n + m, limit);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice(off - d - 1, off + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
            let j = i - k;
            while (i < n && j < m && x[i] === y[j]) {
                i++;
                j++;
            }
            v[off + k] = i;
            if (i >= n && j >= m) return walkBack(trace, n, m);
        }
    }
    return null;
}

/** The edit script from the rounds editScript kept, walked back from the end of both lists. */
function walkBack(trace, n, m) {
    const ops = [];
    let i = n;
    let j = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const v = trace[d];
        const at = (k) => v[k + d + 1];
        const k = i - j;
        const prev = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const pi = at(prev);
        const pj = pi - prev;
        while (i > pi && j > pj) {
            ops.push(SAME);
            i--;
            j--;
        }
        if (d > 0) ops.push(i === pi ? INSERT : DELETE);
        i = pi;
        j = pj;
    }
    return ops.reverse();
}
