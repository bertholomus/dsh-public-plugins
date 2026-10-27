/**
 * Durable state of the coordinating chats. One JSON file, atomic writes,
 * mode 600. Each chat that ran /coordinate is kept under its own session id
 * (still called a project here) with its threads. Shape:
 *
 * { version: 1, projects: { [the chat's session id]: {
 *     coordinatorSessionId: the same id, name: the chat's title, folder: where its threads work (the chat's folder),
 *     createdAt, off?: true once the user ran /coordinate off, gone?: true while DSH no longer has the chat,
 *     settings: { threadModel?, threadEffort?, paused?, yourTools?, threadPermission? },
 *     nextThread, pendingHandbacks: [text | {text, from: thread session}], threadStarts: [ms],
 *     threads: { [threadId]: { sessionId, title, model?, effort?, resolved, createdAt,
 *       ask?: the user's words it started with, tools?: the user's tools (guardedTools names) the user's words gave it,
 *       permission?: the DSH permission preset it started on or was moved to,
 *       lastHandback?: { status, summary, at }, lastDirect?: { at, reply }, handbackTimes: [ms],
 *       busy?: true while a turn runs, seenTurn?: key of the last turn reviewed,
 *       lastEnding?: { text, kind, at }: that turn, when it failed or stopped without a handback (prompts.js describeEnding),
 *       lastAnswer?: { outcome: 'allowed' | 'declined', what, at }: how the user answered its last prompt (its roster line until it hands back),
 *       changes?: [{ turn, seq, added, deleted, total, files: [{ path, added, deleted, binary?, oversized?, created? }], turns? }] (changes.js; a shell command's via shell.js) } },
 *     home?: id of the DSH workspace the chat and its threads work in,
 *     archived?: { at, via: 'window' | 'dsh' | 'start' | 'hand', sessions?: the chat's and its threads' sessions the archive
 *       saw to, archived in DSH or gone from it }: the chat is archived with its threads (projects.js archiveProject),
 *     dshArchive?: { coordinator, archived }: whether DSH had the chat archived when the plugin last looked,
 *     news?: { seq, seen, items }: what the user hears about from anywhere in the window (projects.js noteNews),
 *     awaiting?: [{ to: a chat's session id, name: as the coordinator named it, from: the coordinator's session id,
 *       after: the chat's last event seq before the message, at }]: messages to other chats (chat_message)
 *       whose reply hasn't come back yet,
 *     answering?: 'sent' once the plugin sent the chat a message, 'taken' while a turn that started after it runs
 *       (cleared when it ends), raisedCut?: the seq of the chat's turn that DSH closing cut off, whose messages were sent
 *       to it again (both projects.js raiseCutOff) } } }
 *
 * The file is this plugin's own (~/.dsh/coordinator): the projects plugin
 * it grew from kept its own file, which stays as it was, so going back to
 * that plugin finds its projects and the categories it held.
 *
 * Settings here are the chat's own for its threads: set in its Thread
 * settings dialog, or by the chat with thread_settings (never access,
 * which only the user sets). They sit above the plugin's defaults;
 * deleting a key means "use default".
 *
 * The plugin's managers in one process share one copy of the file while
 * any of them runs (ProjectStore.open). When the last one stops (the plugin
 * is switched off), the copy is let go (ProjectStore.release), so the next
 * start reads the file again.
 *
 * A file that is there but can't be read as this store (cut short, edited
 * by hand, a newer format) is never written over: it is moved aside as
 * `<file>.unreadable-<UTC time>` and the plugin starts with no chats; if it
 * can't be moved or copied aside, nothing is saved over it. That, and every
 * save that fails, is reported once (store-unreadable, store-save-failed,
 * then store-saved when a save goes through again) to the newest manager's
 * log, and `problems` says it for the plugin's page.
 *
 * @module dsh-plugin-coordinator/store
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DSH_HOME_DIR } from './config.js';

/** Resolve a '~'-prefixed path. */
export function expand(p) {
    return p.startsWith('~/') || p === '~' ? `${homedir()}${p.slice(1)}` : p;
}

/** DSH's own data folder: `$DSH_HOME`, else ~/.dsh, as DSH resolves it. */
export function dshHome() {
    const DSH_HOME = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    return DSH_HOME === '' ? expand(DSH_HOME_DIR) : resolve(expand(DSH_HOME));
}

/**
 * Resolve one of the plugin's data paths. One under ~/.dsh lives in DSH's
 * data folder, so a DSH run with its own DSH_HOME (a test copy) keeps its
 * own projects instead of sharing the main one's.
 */
export function dataPath(p) {
    if (p === DSH_HOME_DIR || p.startsWith(`${DSH_HOME_DIR}/`)) return `${dshHome()}${p.slice(DSH_HOME_DIR.length)}`;
    return expand(p);
}

/**
 * Create a folder (and missing parents) as mode 700. The mode is set
 * explicitly because the process umask is shared: another plugin that
 * narrows it while we create folders would otherwise leave them without
 * the execute bit, and nothing inside could be opened. An existing folder
 * keeps its mode, unless its owner (us) cannot use it; that one gets the
 * owner bits back.
 * @param {string} dir
 */
export function ensurePrivateDir(dir) {
    // One level at a time, chmod before descending: a recursive mkdir under a
    // narrowed umask (e.g. 0177) makes the parent 600 and then cannot enter it
    // to create the child (EACCES on macOS; root skips the check, so CI as root passes).
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

/** Open stores by file, so every manager in this process shares one copy. */
const opened = new Map();

/** Why a file couldn't be read or written, in words. */
function errorWords(error) {
    switch (error?.code) {
        case 'ENOSPC': return 'the disk is full';
        case 'EACCES': case 'EPERM': return 'the plugin may not write or read there';
        case 'EROFS': return 'the disk is read-only';
        case 'EISDIR': return 'a folder has its name';
        case 'ENOTDIR': return 'a file stands where its folder should be';
        default: return typeof error?.code === 'string' ? `error ${error.code}` : String(error?.message ?? error).slice(0, 120);
    }
}

export class ProjectStore {
    /**
     * The store for a file, shared within the process. A manager left over
     * from a config reload may still be finishing a tool call; sharing the
     * copy means its writes and the new manager's never overwrite each other.
     * @param {string} file - store path.
     */
    static open(file, report = undefined) {
        const path = dataPath(file);
        let store = opened.get(path);
        if (!store) {
            store = new ProjectStore(path);
            opened.set(path, store);
        }
        if (typeof report === 'function' && store.report !== report) store.reportTo(report);
        return store;
    }

    /**
     * Forget the shared copy of a file: the next open reads the file again.
     * For when no manager runs on it (the plugin was switched off), since the
     * file may change before the next one starts.
     * @param {string} file - store path.
     */
    static release(file) {
        opened.delete(dataPath(file));
    }

    /** @param {string} file - store path. */
    constructor(file) {
        this.file = dataPath(file);
        /** @type {Record<string, object>} */
        this.projects = {};
        /**
         * What went wrong with the file, for the plugin's page: `unreadable`
         * ({at, kept?: the copy's file name, reason}) since the file was found
         * unreadable, `saveFailed` ({at, reason}) while the last save failed.
         */
        this.problems = {};
        /** Lines for the log not yet given to a manager (reportTo). */
        this.unsent = [];
        /** Set when an unreadable file could be neither moved nor copied aside: then nothing is saved over it. */
        this.keepOff = false;
        this.load();
    }

    /** Where the store's own lines go from now on (the newest manager's log); lines from before it go there first. */
    reportTo(report) {
        this.report = report;
        for (const line of this.unsent.splice(0)) this.say(line);
    }

    /** One line for the plugin's log, kept until a manager takes them. */
    say(line) {
        if (typeof this.report !== 'function') {
            this.unsent.push(line);
            return;
        }
        try { this.report(line); } catch { /* the log is best-effort */ }
    }

    load() {
        let text;
        try {
            text = readFileSync(this.file, 'utf8');
        } catch (error) {
            // None yet: start clean. One that can't be opened (its mode) is left as it is, and said.
            this.projects = {};
            if (error?.code !== 'ENOENT') this.unreadable(errorWords(error), { move: false });
            return;
        }
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        if (parsed?.version === 1 && parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)) {
            this.projects = parsed.projects;
            return;
        }
        // Cut short, edited by hand, or another format: start clean, and keep the file aside so no save writes over it.
        this.projects = {};
        this.unreadable(parsed === undefined ? 'it is not whole JSON' : 'it is not this plugin\'s record', { move: true });
    }

    /** The file is there but can't be used: move (or copy) it aside, or else keep every save off it. */
    unreadable(reason, { move }) {
        const at = new Date();
        let kept;
        if (move) {
            const copy = `${this.file}.unreadable-${at.toISOString().replace(/[:.]/g, '-')}`;
            try {
                renameSync(this.file, copy);
                kept = copy;
                try { chmodSync(copy, 0o600); } catch { /* it keeps the mode it had */ }
            } catch {
                try {
                    copyFileSync(this.file, copy);
                    chmodSync(copy, 0o600);
                    kept = copy;
                } catch { /* neither: keep saves off the file below */ }
            }
        }
        if (!kept) this.keepOff = true;
        this.problems.unreadable = { at: at.toISOString(), reason, ...(kept ? { kept: basename(kept) } : {}) };
        this.say(`store-unreadable ${this.file} (${reason}) ${kept ? `kept as ${kept}` : 'left as it is; nothing is saved over it'}`);
    }

    /** Persist atomically; the store must survive crashes mid-write. A failed save is said once, and again when one goes through. */
    save() {
        if (this.keepOff) {
            this.saveFailed('the unreadable file is still in its place');
            return;
        }
        try {
            ensurePrivateDir(dirname(this.file));
            const tmp = `${this.file}.tmp`;
            const state = { version: 1, projects: this.projects };
            writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
            chmodSync(tmp, 0o600);
            renameSync(tmp, this.file);
        } catch (error) {
            // Kept running on the copy in memory; the next change tries again.
            this.saveFailed(errorWords(error));
            return;
        }
        if (this.problems.saveFailed) {
            this.say(`store-saved ${this.file} (after failing since ${this.problems.saveFailed.at})`);
            delete this.problems.saveFailed;
        }
    }

    saveFailed(reason) {
        if (this.problems.saveFailed) return;
        this.problems.saveFailed = { at: new Date().toISOString(), reason };
        this.say(`store-save-failed ${this.file} (${reason})`);
    }

    /** The project entry, created empty on first use. */
    project(projectId) {
        const p = this.projects[projectId] ??= {};
        p.settings ??= {};
        p.threads ??= {};
        p.pendingHandbacks ??= [];
        p.nextThread ??= 1;
        return p;
    }

    /** Merge fields into a project entry and persist. */
    putProject(projectId, fields) {
        Object.assign(this.project(projectId), fields);
        this.save();
    }

    /** Set or clear (value undefined) runtime setting overrides. */
    putSettings(projectId, changes) {
        const settings = this.project(projectId).settings;
        for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) delete settings[key];
            else settings[key] = value;
        }
        this.save();
    }

    /** Reserve the next short thread id ("t1", "t2", ...). Never reused. */
    reserveThreadId(projectId) {
        const p = this.project(projectId);
        const id = `t${p.nextThread}`;
        p.nextThread += 1;
        this.save();
        return id;
    }

    thread(projectId, threadId) {
        return this.projects[projectId]?.threads?.[threadId] ?? null;
    }

    putThread(projectId, threadId, fields) {
        const threads = this.project(projectId).threads;
        threads[threadId] = { ...threads[threadId], ...fields };
        this.save();
        return threads[threadId];
    }

    /** Forget a coordinating chat and its threads' state. */
    removeProject(projectId) {
        delete this.projects[projectId];
        this.save();
    }

    /** Find which project and role a session belongs to. */
    lookup(sessionId) {
        for (const [projectId, p] of Object.entries(this.projects)) {
            if (p.coordinatorSessionId === sessionId) return { projectId, role: 'coordinator' };
            for (const [threadId, t] of Object.entries(p.threads ?? {})) {
                if (t.sessionId === sessionId) return { projectId, role: 'thread', threadId };
            }
        }
        return null;
    }
}
