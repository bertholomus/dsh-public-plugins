/**
 * A thread's net changes: each file's text from before the thread's first
 * edit of it and after its latest, so its Changes tab can show one diff per
 * file, what its edits (and its subagents') came to. DSH's records keep
 * each edit's hunks only, and its own whole-file captures last a turn and
 * go with the session, so the plugin keeps its own, around each file-tool
 * call of a thread or of a subagent working for one (the manager's
 * `tools/execute` hook). They live in the plugin's folder, one folder per
 * thread session (net/<session>/, mode 700, files 600): index.json says
 * what each side of each file is, and each kept text is a file of its own.
 *
 * What is kept: only files in the thread's folder or its project's
 * workspace (real paths, links resolved), never one in DSH's own folder,
 * never one whose name says it may hold secrets (notKept), and nothing for
 * a call that fails. A thread keeps at most MAX_NET_FILES files and
 * MAX_NET_THREAD_BYTES. How long: a thread's texts go NET_KEEP_MS after it
 * last changed a file or its Changes tab last showed them, when the store
 * no longer has the thread or DSH no longer has its chat, and, past
 * MAX_NET_TOTAL_BYTES in all, the threads used longest ago go first; the
 * plugin sweeps at start and every NET_SWEEP_MS (prune).
 *
 * A side is 'text' (kept), 'absent' (no file: the thread created it),
 * 'large' (past MAX_NET_BYTES), 'full' (the thread's MAX_NET_THREAD_BYTES
 * used up), 'binary', 'encoding' (not UTF-8 text) or 'unreadable'. A file
 * that anything else changed between two of the thread's calls on it
 * (another thread, the user, a command), or while one ran (it isn't what
 * the call should have left), is `mixed`: a diff from its first text to its
 * last would credit the thread with that change too. Each entry names the
 * calls that changed the file, so a file the thread edited before the
 * plugin kept texts (an older version's edits) is `partial`: its first kept
 * text isn't the thread's first.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { dshHome, ensurePrivateDir } from './store.js';
import { netHunks } from './changes.js';

/** The largest file kept, each side. */
export const MAX_NET_BYTES = 1024 * 1024;
/** The most files one thread keeps texts of. */
export const MAX_NET_FILES = 100;
/** The most text one thread keeps in all. */
export const MAX_NET_THREAD_BYTES = 32 * 1024 * 1024;
/** The most text all threads keep; past it, the threads used longest ago lose theirs first (NetTexts.prune). */
export const MAX_NET_TOTAL_BYTES = 512 * 1024 * 1024;
/** How long a thread's texts are kept after it last changed a file or its Changes tab last showed them. */
export const NET_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** How often a running plugin sweeps the kept texts (NetTexts.prune). */
export const NET_SWEEP_MS = 60 * 60 * 1000;
/** A view marks a thread's texts as used at most this often (one write of its index). */
const USED_EVERY_MS = 24 * 60 * 60 * 1000;
/** Bytes looked at for a NUL before a file counts as binary, as git does. */
const BINARY_PROBE = 8000;
/** Threads whose index stays in memory. */
const INDEXES = 50;
/** The most calls one file's entry names; past them it stops checking for edits it missed. */
const MAX_NET_CALLS = 500;
/** Net diffs worked out lately, by the hashes of their two texts. */
const DIFFS = 100;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Names of files that may hold secrets, whose texts are never kept: .env
 * files, keys and certificates, credential and password files.
 */
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.pgpass|\.htpasswd|id_[a-z0-9]+(?:\.pub)?)$|credential|secret|\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i;
/** Folders whose files are never kept, wherever they are: keys, cloud and cluster logins. */
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', 'gcloud']);

/** Whether a path is inside a folder (not the folder itself). */
const inside = (path, root) => typeof root === 'string' && root !== '' && path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * The path a file-tool call is about to change, as the call names it:
 * `write`, `edit` and the changing `str_replace_editor` commands. Other
 * calls, and incomplete arguments, give undefined.
 */
export function changedPath(name, args) {
    if (!isObject(args)) return undefined;
    const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
    switch (name) {
        case 'write': return typeof args.content === 'string' ? text(args.file_path) : undefined;
        case 'edit': return typeof args.old_string === 'string' && typeof args.new_string === 'string' ? text(args.file_path) : undefined;
        case 'str_replace_editor': return ['create', 'str_replace', 'insert'].includes(args.command) ? text(args.path) : undefined;
        default: return undefined;
    }
}

/** Whether a text's lines end in CRLF, as DSH's edit tool decides it (dsh-fs-local detectLineEndings). */
function crlf(text) {
    const sample = text.slice(0, 4096);
    const pairs = sample.split('\r\n').length - 1;
    return pairs > sample.split('\n').length - 1 - pairs;
}

/**
 * What a file-tool call should leave, from the file's text just before it,
 * as DSH's own tools work it out (dsh-fs-local, dsh-tool-str-replace-editor):
 * write and the editor's create keep their text as it is; the others read
 * the file without a UTF-8 byte-order mark; edit reads CRLF as LF, replaces
 * its one match (or every match) and puts the file's line endings back;
 * str_replace replaces its one match; insert puts lines in after a line. A
 * function of the text before (a string, or null for no file), giving
 * undefined when that can't be told; undefined for any other call.
 */
export function expectedAfter(name, args) {
    if (!isObject(args)) return undefined;
    if (name === 'write' && typeof args.content === 'string') return () => args.content;
    if (name !== 'edit' && name !== 'str_replace_editor') return undefined;
    if (name === 'str_replace_editor' && args.command === 'create') return typeof args.file_text === 'string' ? () => args.file_text : undefined;
    const read = (before) => (typeof before === 'string' ? (before.startsWith('\uFEFF') ? before.slice(1) : before) : undefined);
    if (name === 'edit') {
        if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string' || args.old_string === '') return undefined;
        return (before) => {
            const raw = read(before);
            if (raw === undefined) return undefined;
            const parts = raw.replaceAll('\r\n', '\n').split(args.old_string.replaceAll('\r\n', '\n'));
            if (parts.length < 2 || (parts.length > 2 && args.replace_all !== true)) return undefined;
            const edited = parts.join(args.new_string.replaceAll('\r\n', '\n'));
            return crlf(raw) ? edited.split('\n').join('\r\n') : edited;
        };
    }
    if (args.command === 'str_replace') {
        if (typeof args.old_str !== 'string' || args.old_str === '') return undefined;
        return (before) => {
            const raw = read(before);
            const at = raw?.indexOf(args.old_str) ?? -1;
            if (at < 0 || raw.indexOf(args.old_str, at + args.old_str.length) >= 0) return undefined;
            return raw.slice(0, at) + (typeof args.new_str === 'string' ? args.new_str : '') + raw.slice(at + args.old_str.length);
        };
    }
    if (args.command === 'insert') {
        if (typeof args.new_str !== 'string' || !Number.isInteger(args.insert_line)) return undefined;
        return (before) => {
            const raw = read(before);
            if (raw === undefined) return undefined;
            const lines = raw.split('\n');
            if (args.insert_line < 0 || args.insert_line > lines.length) return undefined;
            return [...lines.slice(0, args.insert_line), ...args.new_str.split('\n'), ...lines.slice(args.insert_line)].join('\n');
        };
    }
    return undefined;
}

/**
 * A path as the file system has it, links resolved, so one file has one
 * key whichever way a call or a record names it. A file that isn't there
 * yet takes the real path of the nearest folder above it that is.
 */
export function canonicalPath(path) {
    try { return realpathSync(path); } catch {}
    const rest = [];
    let at = String(path);
    for (let depth = 0; depth < 64; depth++) {
        const up = dirname(at);
        if (up === at) break;
        rest.unshift(basename(at));
        try { return join(realpathSync(up), ...rest); } catch {}
        at = up;
    }
    return path;
}

/**
 * Why the plugin doesn't keep a file's texts, or undefined when it does:
 * 'outside' for a file whose real path isn't in one of `roots` (the
 * thread's folder and its project's workspace), or is in DSH's own folder
 * (DSH's credentials, other plugins' data); 'secret' for one whose name, or
 * a folder on its way, says it may hold secrets.
 * @param {string} file - an absolute path.
 * @param {string[]} roots - absolute folders.
 */
export function notKept(file, roots) {
    const real = canonicalPath(file);
    if (inside(real, canonicalPath(dshHome()))) return 'outside';
    const root = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && r !== '').map(canonicalPath).find((r) => inside(real, r));
    if (root === undefined) return 'outside';
    const parts = real.slice(root.length).split(sep).filter(Boolean);
    if (SECRET_NAME.test(parts.at(-1) ?? '') || parts.slice(0, -1).some((part) => SECRET_DIRS.has(part))) return 'secret';
    return undefined;
}

/**
 * A file as one side: {kind, text?, hash?}. 'encoding' is text that isn't
 * UTF-8: UTF-16 (a byte-order mark), or bytes that don't decode. Never throws.
 */
export async function readSide(file, maxBytes = MAX_NET_BYTES) {
    let handle;
    try {
        handle = await open(file, 'r');
    } catch (error) {
        return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unreadable' };
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) return { kind: 'unreadable' };
        if (stat.size > maxBytes) return { kind: 'large' };
        const bytes = await handle.readFile();
        if (bytes.length > maxBytes) return { kind: 'large' };
        const hash = hashOf(bytes);
        if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return { kind: 'encoding', hash };
        if (bytes.subarray(0, BINARY_PROBE).includes(0)) return { kind: 'binary', hash };
        let text;
        try {
            // A byte-order mark stays in the text, so the text kept is the file byte for byte.
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
            return { kind: 'encoding', hash };
        }
        return { kind: 'text', text, hash };
    } catch {
        return { kind: 'unreadable' };
    } finally {
        await handle.close().catch(() => {});
    }
}

/** A kept text, if it is still the one its hash names; undefined otherwise. */
async function readKept(file, hash) {
    try {
        const bytes = await readFile(file);
        return hashOf(bytes) === hash ? bytes.toString('utf8') : undefined;
    } catch {
        return undefined;
    }
}

/** Keepers by folder, so two managers on one folder (a config reload) share one index. */
const opened = new Map();

export class NetTexts {
    /** The keeper of a folder, shared within the process; `log` gets its error lines. */
    static open(root, log) {
        let net = opened.get(root);
        if (!net) {
            net = new NetTexts(root);
            opened.set(root, net);
        }
        if (typeof log === 'function') net.log = log;
        return net;
    }

    constructor(root) {
        this.root = root;
        this.log = () => {};
        /** Thread session → its index {files: {path: entry}, bytes, used}, the newest last. */
        this.indexes = new Map();
        /** `${thread}\n${path}` → the tail of the calls on that file, so each call's sides are its own. */
        this.files = new Map();
        /** Thread session → the tail of its index's writes. */
        this.writes = new Map();
        /** The keys of the calls this async context is already inside (around), so a call inside one runs as it is. */
        this.held = new AsyncLocalStorage();
        /** `${before hash}|${after hash}` → its net diff (netHunks), the newest last. */
        this.diffs = new Map();
        /** Folders made private this process. */
        this.tight = new Set();
        /** The caps, as the module's (a test lowers them). */
        this.limits = { files: MAX_NET_FILES, threadBytes: MAX_NET_THREAD_BYTES, totalBytes: MAX_NET_TOTAL_BYTES };
    }

    /**
     * Sweep the kept texts (at start, then every NET_SWEEP_MS): remove the
     * folders of threads not in `keep` (the session of every thread the
     * store has, archived projects' too, whose chat DSH still has; with none,
     * as from a store that failed to load, it leaves every folder as it is),
     * then those not used for NET_KEEP_MS (index.json's `used`, else its
     * time), then, while all of them keep more than MAX_NET_TOTAL_BYTES,
     * those used longest ago. A thread this process is keeping texts for
     * right now stays, and a sweep that comes while one runs waits for it.
     * Never throws; returns the folders it removed.
     */
    prune(keep) {
        const run = () => this.sweep(keep);
        const next = (this.pruning ?? Promise.resolve()).then(run, run);
        this.pruning = next;
        void next.finally(() => {
            if (this.pruning === next) this.pruning = undefined;
        });
        return next;
    }

    async sweep(keep) {
        const removed = [];
        let names;
        try {
            names = (await readdir(this.root)).sort();
        } catch {
            return removed;
        }
        const nameOf = (id) => basename(this.dir(id));
        const kept = new Set([...keep].map(nameOf));
        if (kept.size === 0) return removed;
        const busy = new Set([...this.writes.keys(), ...[...this.files.keys()].map((key) => key.split('\n')[0])].map(nameOf));
        const drop = async (name, why) => {
            if (busy.has(name)) return;
            try {
                await rm(join(this.root, name), { recursive: true, force: true });
                for (const id of [...this.indexes.keys()]) if (nameOf(id) === name) this.indexes.delete(id);
                removed.push(name);
                this.log(`net-prune ${name} ${why}`);
            } catch (error) {
                this.log(`error net-prune ${String(error?.message ?? error).slice(0, 200)}`);
            }
        };
        const sized = [];
        const now = Date.now();
        for (const name of names) {
            if (!/^[\w-]{1,128}$/.test(name) || busy.has(name)) continue;
            if (!kept.has(name)) {
                await drop(name, 'gone');
                continue;
            }
            try {
                const index = join(this.root, name, 'index.json');
                const [text, info] = await Promise.all([readFile(index, 'utf8'), stat(index)]);
                const parsed = JSON.parse(text);
                const live = [...this.indexes].find(([id]) => nameOf(id) === name)?.[1];
                const used = Math.max(Number.isSafeInteger(parsed?.used) ? parsed.used : info.mtimeMs, Number.isSafeInteger(live?.used) ? live.used : 0);
                if (now - used > NET_KEEP_MS) {
                    await drop(name, 'unused');
                    continue;
                }
                sized.push({ name, bytes: Number.isSafeInteger(parsed?.bytes) && parsed.bytes > 0 ? parsed.bytes : 0, at: used });
            } catch {}
        }
        let total = sized.reduce((n, entry) => n + entry.bytes, 0);
        for (const entry of sized.sort((a, b) => a.at - b.at)) {
            if (total <= this.limits.totalBytes) break;
            await drop(entry.name, 'oldest');
            total -= entry.bytes;
        }
        return removed;
    }

    /** A thread session's folder: its id, or a hash of an id that isn't a plain name. */
    dir(thread) {
        const id = String(thread);
        return join(this.root, /^[\w-]{1,128}$/.test(id) ? id : hashOf(id).slice(0, 32));
    }

    /** Make a thread's folder (and net/) if missing, and private (700) even if it was there with a wider mode. */
    ensureDir(thread) {
        const dir = this.dir(thread);
        ensurePrivateDir(dir);
        for (const folder of [this.root, dir]) {
            if (this.tight.has(folder)) continue;
            try {
                const st = lstatSync(folder);
                if (st.isDirectory() && (st.mode & 0o077) !== 0 && st.uid === process.getuid?.()) chmodSync(folder, 0o700);
                this.tight.add(folder);
            } catch {}
        }
        return dir;
    }

    /** A thread's index, read once. */
    async index(thread) {
        const cached = this.indexes.get(thread);
        if (cached) {
            this.indexes.delete(thread);
            this.indexes.set(thread, cached);
            return cached;
        }
        let index = { files: {}, bytes: 0, used: 0 };
        try {
            const parsed = JSON.parse(await readFile(join(this.dir(thread), 'index.json'), 'utf8'));
            if (isObject(parsed?.files)) index = { files: parsed.files, bytes: Number.isSafeInteger(parsed.bytes) ? parsed.bytes : 0, used: Number.isSafeInteger(parsed.used) ? parsed.used : 0 };
        } catch {}
        // Another call read it meanwhile: keep the copy that one may have changed.
        const raced = this.indexes.get(thread);
        if (raced) return raced;
        this.indexes.set(thread, index);
        // The least used go, but never one a call still holds or a write still has to save.
        const busy = new Set([...this.files.keys()].map((key) => key.slice(0, key.indexOf('\n'))));
        for (const key of [...this.indexes.keys()].slice(0, -INDEXES)) {
            if (!this.writes.has(key) && !busy.has(key)) this.indexes.delete(key);
        }
        return index;
    }

    /** Write a thread's index, after any write of it still running, as it is when its turn comes; it counts as used now. */
    save(thread) {
        const index = this.indexes.get(thread);
        if (index) index.used = Date.now();
        const write = async () => {
            const now = this.indexes.get(thread);
            if (!now) return;
            const dir = this.ensureDir(thread);
            const temp = join(dir, `index.json.${process.pid}.tmp`);
            try {
                await writeFile(temp, JSON.stringify({ version: 1, bytes: now.bytes, used: now.used, files: now.files }), { mode: 0o600 });
                await rename(temp, join(dir, 'index.json'));
            } catch (error) {
                await unlink(temp).catch(() => {});
                throw error;
            }
        };
        const tail = (this.writes.get(thread) ?? Promise.resolve()).then(write).catch((error) => {
            this.log(`error net-index ${String(error?.message ?? error).slice(0, 200)}`);
        });
        this.writes.set(thread, tail);
        void tail.then(() => {
            if (this.writes.get(thread) === tail) this.writes.delete(thread);
        });
        return tail;
    }

    /** Keep one text in a thread's folder, whole or not at all: a write that fails leaves nothing behind. */
    async keep(thread, name, text) {
        const dir = this.ensureDir(thread);
        const temp = join(dir, `${name}.${process.pid}.tmp`);
        try {
            await writeFile(temp, text, { mode: 0o600 });
            await rename(temp, join(dir, name));
        } catch (error) {
            await unlink(temp).catch(() => {});
            throw error;
        }
    }

    /**
     * Run one file-tool call (`run`: the rest of DSH's chain; `call`: its id)
     * on `file` for `thread`, keeping the file's text before the thread's
     * first call on it and after each call that succeeds; a call that fails
     * (throws, or returns an error, as DSH's refusals do) keeps nothing.
     * `expect`: what the file should be after the call, from its text before
     * (expectedAfter); when it isn't, something else changed it while the
     * call ran, and the file is mixed. Calls on one file wait for each
     * other, and a call made inside another on the same file runs as it is.
     * The call's own outcome is returned or thrown as it is.
     */
    async around(thread, file, run, call = undefined, expect = undefined) {
        const key = `${thread}\n${file}`;
        const held = this.held.getStore();
        if (held?.has(key)) return run();
        const prev = this.files.get(key) ?? Promise.resolve();
        let done;
        const gate = new Promise((resolve) => { done = resolve; });
        const mine = prev.then(() => gate);
        this.files.set(key, mine);
        await prev;
        let was;
        let ok = false;
        try {
            was = await this.before(thread, file);
            const result = await this.held.run(new Set([...(held ?? []), key]), run);
            ok = !(isObject(result) && result.isError === true);
            return result;
        } finally {
            let expected;
            try { expected = ok && typeof expect === 'function' && was?.side ? expect(was.side.kind === 'text' ? was.side.text : was.side.kind === 'absent' ? null : undefined) : undefined; } catch {}
            if (ok) await this.after(thread, file, call, expected);
            else await this.undo(thread, file, was);
            done();
            if (this.files.get(key) === mine) this.files.delete(key);
        }
    }

    /**
     * Before a call: the file's first text, or whether anything else changed
     * it since the thread's last call. The file's slot and its bytes are
     * counted before the text is written, so calls at once can't pass the
     * caps. Returns {fresh: whether this call made the entry, side: the file
     * now}, or undefined.
     */
    async before(thread, file) {
        try {
            const index = await this.index(thread);
            const entry = index.files[file];
            if (isObject(entry)) {
                const now = await readSide(file);
                if (entry.mixed !== true && (typeof entry.hash === 'string' || entry.after === 'absent') && (now.kind !== entry.after || (now.hash ?? null) !== (entry.hash ?? null))) {
                    entry.mixed = true;
                    await this.save(thread);
                }
                return { fresh: false, side: now };
            }
            if (Object.keys(index.files).length >= this.limits.files) return undefined;
            const key = hashOf(file).slice(0, 32);
            const fresh = { key, before: 'unreadable', after: null, hash: null, calls: [] };
            index.files[file] = fresh;
            const side = await readSide(file);
            fresh.before = side.kind;
            if (side.kind === 'text') {
                const size = Buffer.byteLength(side.text);
                if (index.bytes + size > this.limits.threadBytes) fresh.before = 'full';
                else {
                    index.bytes += size;
                    try {
                        await this.keep(thread, `${key}.before`, side.text);
                        Object.assign(fresh, { beforeHash: side.hash, beforeBytes: size });
                    } catch (error) {
                        index.bytes -= size;
                        fresh.before = 'unreadable';
                        this.log(`error net-before ${String(error?.message ?? error).slice(0, 200)}`);
                    }
                }
            }
            await this.save(thread);
            return { fresh: true, side };
        } catch (error) {
            this.log(`error net-before ${String(error?.message ?? error).slice(0, 200)}`);
            return undefined;
        }
    }

    /** After a call that failed: the entry this call made goes, with its text, as if the call never came. */
    async undo(thread, file, was) {
        if (!was?.fresh) return;
        try {
            const index = await this.index(thread);
            const entry = index.files[file];
            if (!isObject(entry) || (Array.isArray(entry.calls) && entry.calls.length > 0)) return;
            delete index.files[file];
            if (Number.isSafeInteger(entry.beforeBytes)) index.bytes = Math.max(0, index.bytes - entry.beforeBytes);
            await unlink(join(this.dir(thread), `${entry.key}.before`)).catch(() => {});
            await this.save(thread);
        } catch (error) {
            this.log(`error net-undo ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /**
     * After a call: the file's text now, the thread's latest, and the call
     * that made it; mixed when it isn't what the call should have left
     * (`expected`, when known). The entry names the new text only once it is
     * written.
     */
    async after(thread, file, call, expected = undefined) {
        try {
            const index = await this.index(thread);
            const entry = index.files[file];
            if (!isObject(entry)) return;
            const side = await readSide(file);
            if (typeof expected === 'string' && side.kind === 'text' && side.text !== expected && entry.mixed !== true) entry.mixed = true;
            if (side.kind === entry.after && side.hash !== undefined && side.hash === entry.hash) {
                if (entry.mixed === true) await this.save(thread);
                return;
            }
            if (typeof call === 'string' && call !== '' && Array.isArray(entry.calls)) {
                if (entry.calls.length < MAX_NET_CALLS) entry.calls.push(call);
                else entry.callsFull = true;
            }
            const was = Number.isSafeInteger(entry.afterBytes) ? entry.afterBytes : 0;
            let kind = side.kind;
            if (side.kind === 'text') {
                const size = Buffer.byteLength(side.text);
                if (index.bytes - was + size > this.limits.threadBytes) kind = 'full';
                else {
                    index.bytes += size - was;
                    try {
                        await this.keep(thread, `${entry.key}.after`, side.text);
                        entry.afterBytes = size;
                    } catch (error) {
                        index.bytes -= size - was;
                        kind = 'unreadable';
                        this.log(`error net-after ${String(error?.message ?? error).slice(0, 200)}`);
                    }
                }
            }
            entry.after = kind;
            entry.hash = kind === 'text' || kind === 'binary' || kind === 'encoding' ? side.hash ?? null : null;
            await this.save(thread);
        } catch (error) {
            this.log(`error net-after ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /**
     * What a thread's calls on a file came to: {net} (netHunks; `since` when
     * the file changed after the thread's last call; `unlisted` when the
     * diff has edits that `calls` doesn't name, such as a subagent's whose
     * log can't be read; with no hunks, `undone` when the file is byte for
     * byte as it was, `empty` for a new empty file, else `endings`: only line
     * endings or a last newline changed), or {why}: 'none' (nothing kept:
     * the thread's edits came before the plugin kept texts), 'many' (past
     * MAX_NET_FILES), 'partial' (one of `calls`, the ids of the thread's edits
     * of the file in its records, isn't one the plugin kept texts around),
     * 'mixed', 'large', 'full', 'big' (too many lines changed), 'binary' or
     * 'encoding'. Each view counts as using the thread's texts.
     */
    async view(thread, file, calls = undefined) {
        const index = await this.index(thread);
        if (Date.now() - (index.used ?? 0) > USED_EVERY_MS && Object.keys(index.files).length > 0) void this.save(thread);
        const entry = index.files[file];
        if (!isObject(entry)) return { why: Object.keys(index.files).length >= this.limits.files ? 'many' : 'none' };
        let unlisted = false;
        if (Array.isArray(calls) && calls.length > 0 && Array.isArray(entry.calls) && entry.callsFull !== true) {
            const seen = new Set(entry.calls);
            if (calls.some((call) => !seen.has(call))) return { why: 'partial' };
            const listed = new Set(calls);
            unlisted = entry.calls.some((call) => !listed.has(call));
        }
        if (entry.mixed === true) return { why: 'mixed' };
        // 'big' from an older version: a file over 1 MB, or a thread's texts used up.
        for (const why of ['large', 'full', 'big', 'binary', 'encoding']) {
            if (entry.before === why || entry.after === why) return { why: why === 'big' ? 'large' : why };
        }
        if ((entry.before !== 'text' && entry.before !== 'absent') || entry.after !== 'text') return { why: 'none' };
        // Worked out once for each pair of texts (their hashes name them), so a view reads the kept texts only then.
        const id = `${entry.before === 'text' ? entry.beforeHash : 'new'}|${entry.hash}`;
        let seen = this.diffs.get(id);
        if (seen === undefined) {
            const dir = this.dir(thread);
            const before = entry.before === 'text' ? await readKept(join(dir, `${entry.key}.before`), entry.beforeHash) : null;
            const after = await readKept(join(dir, `${entry.key}.after`), entry.hash);
            if (before === undefined || after === undefined) return { why: 'none' };
            const net = netHunks(before, after);
            seen = !net ? null : net.hunks.length > 0 ? net
                : { ...net, ...(before === null ? { empty: true } : before === after ? { undone: true } : { endings: true }) };
            this.diffs.set(id, seen);
            for (const key of [...this.diffs.keys()].slice(0, -DIFFS)) this.diffs.delete(key);
        } else {
            this.diffs.delete(id);
            this.diffs.set(id, seen);
        }
        if (!seen) return { why: 'big' };
        const now = await readSide(file);
        return {
            net: {
                ...seen,
                ...(now.kind === entry.after && now.hash === entry.hash ? {} : { since: true }),
                ...(unlisted ? { unlisted: true } : {}),
            },
        };
    }
}
