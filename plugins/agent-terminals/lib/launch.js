/**
 * How a coding agent is started, resumed and read, by the way its CLI
 * works, never by who makes it. The person names the program; the style
 * says which arguments start and resume a conversation and where the CLI
 * keeps its transcripts (under its data folder, `~/.<program>` unless set).
 *
 * @module dsh-plugin-agent-terminals/launch
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * The styles. `start(id)` and `resume(id)` give the arguments; `first`
 * says whether they go before the person's own arguments (a subcommand
 * must).
 */
export const STYLES = Object.freeze({
    flags: Object.freeze({
        label: 'Starts with --session-id, resumes with --resume',
        detail: 'A new conversation gets an id from Agent Terminals (--session-id <id>), resumed with --resume <id>. Its transcript: one JSON line per message, in <data folder>/projects/<folder>/<id>.jsonl.',
        format: 'messages',
        idAtStart: true,
        start: (id) => ['--session-id', id],
        resume: (id) => ['--resume', id],
        first: false,
    }),
    subcommand: Object.freeze({
        label: 'Resumes with the resume subcommand',
        detail: 'Agent Terminals reads the conversation\'s id from its new transcript (one JSON line per event, in <data folder>/sessions/<year>/<month>/<day>/), and resumes with resume <id>.',
        format: 'events',
        idAtStart: false,
        start: () => [],
        resume: (id) => ['resume', id],
        first: true,
    }),
    continue: Object.freeze({
        label: 'Resumes the folder\'s latest conversation with --continue',
        detail: 'Started again with --continue, which picks up the latest conversation in its folder. No transcript is read, so its status is only running or stopped, and a message typed in cannot be proven read.',
        format: 'none',
        idAtStart: false,
        start: () => [],
        resume: () => ['--continue'],
        first: false,
    }),
    plain: Object.freeze({
        label: 'Runs the command; nothing to resume',
        detail: 'For any other program. After a restart it is not started again by itself: Start again runs it anew. No transcript is read.',
        format: 'none',
        idAtStart: false,
        start: () => [],
        resume: undefined,
        first: false,
    }),
});

export const STYLE_IDS = Object.freeze(Object.keys(STYLES));

/** The name of the program, without its folder. */
export const programName = (program) => basename(String(program ?? '').trim()) || 'agent';

/** The folder a CLI keeps its conversations in: the agent's own setting, else ~/.<program>. */
export function dataFolder(agent, home) {
    if (typeof agent.data === 'string' && agent.data.trim()) return expandHome(agent.data.trim(), home);
    return join(home, `.${programName(agent.program)}`);
}

export function expandHome(path, home) {
    return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

/** A folder as the messages style names it in its projects folder: every character but letters and digits becomes "-". */
export const folderKey = (path) => String(path).replace(/[^A-Za-z0-9]/g, '-');

/**
 * The transcript's path, when it can be known without looking.
 * @returns {string | undefined}
 */
export function transcriptPath(agent, home) {
    const style = STYLES[agent.style];
    if (!style || style.format === 'none' || !agent.conversationId) return undefined;
    if (agent.style !== 'flags') return agent.transcript;
    // Where the CLI keeps it: under its folder as given, or as the system resolves it (/tmp is /private/tmp on a Mac).
    const name = `${agent.conversationId}.jsonl`;
    const projects = join(dataFolder(agent, home), 'projects');
    const given = join(projects, folderKey(agent.folder), name);
    if (agent.transcript && existsSync(agent.transcript)) return agent.transcript;
    if (existsSync(given)) return given;
    try {
        const real = realpathSync(agent.folder);
        const resolved = join(projects, folderKey(real), name);
        if (real !== agent.folder && existsSync(resolved)) return resolved;
    } catch {}
    return given;
}

/** A flags-style transcript wherever the CLI put it: any folder under its projects folder (the id is unique). */
export function findFlagsTranscript(agent, home) {
    if (!agent.conversationId) return undefined;
    const projects = join(dataFolder(agent, home), 'projects');
    let folders = [];
    try {
        folders = readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return undefined;
    }
    for (const folder of folders) {
        const path = join(projects, folder, `${agent.conversationId}.jsonl`);
        if (existsSync(path)) return path;
    }
    return undefined;
}

/** Every events-style transcript under a data folder, with when it was last written. */
export function eventTranscripts(data) {
    const found = [];
    const walk = (dir, depth) => {
        let names = [];
        try {
            names = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of names) {
            const path = join(dir, entry.name);
            if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
            else if (entry.isFile() && /\.jsonl$/.test(entry.name)) {
                try {
                    const stat = statSync(path);
                    found.push({ path, birth: stat.birthtimeMs || stat.ctimeMs, at: stat.mtimeMs });
                } catch {}
            }
        }
    };
    walk(join(data, 'sessions'), 0);
    return found;
}

/** The id and folder an events-style transcript starts with. */
export function eventsMeta(path) {
    try {
        const head = readFileSync(path, 'utf8').slice(0, 64 * 1024).split('\n')[0];
        const line = JSON.parse(head);
        if (line?.type !== 'session_meta' || typeof line.payload !== 'object' || line.payload === null) return undefined;
        return { id: typeof line.payload.id === 'string' ? line.payload.id : undefined, cwd: typeof line.payload.cwd === 'string' ? line.payload.cwd : undefined };
    } catch {
        return undefined;
    }
}

/**
 * The transcript a just-started events-style agent began: the newest one
 * created since `since` whose first line names the agent's folder, and not
 * one another agent already has.
 */
export function findNewTranscript(agent, home, since, taken = new Set()) {
    const candidates = eventTranscripts(dataFolder(agent, home))
        .filter((file) => file.birth >= since - 2000 && !taken.has(file.path))
        .sort((a, b) => b.birth - a.birth);
    for (const file of candidates) {
        const meta = eventsMeta(file.path);
        if (meta?.id && (!meta.cwd || samePath(meta.cwd, agent.folder))) return { path: file.path, id: meta.id };
    }
    return undefined;
}

/** An events-style transcript by its conversation id. */
export function findTranscriptById(agent, home, id) {
    const file = eventTranscripts(dataFolder(agent, home)).filter((f) => f.path.endsWith(`-${id}.jsonl`) || f.path.endsWith(`/${id}.jsonl`)).sort((a, b) => b.at - a.at)[0];
    return file?.path;
}

/** The same folder, also when one path goes through a link (such as /tmp and /private/tmp). */
function samePath(a, b) {
    const trim = (path) => String(path).replace(/\/+$/, '');
    const real = (path) => {
        try {
            return trim(realpathSync(path));
        } catch {
            return trim(path);
        }
    };
    return trim(a) === trim(b) || real(a) === real(b);
}

/**
 * The program and its arguments for a start or a resume.
 * @param {{ program: string, args?: string[], style: string, conversationId?: string }} agent
 * @param {{ resume?: boolean }} [options]
 * @returns {string[] | undefined} undefined when the style cannot resume.
 */
export function argvOf(agent, { resume = false } = {}) {
    const style = STYLES[agent.style] ?? STYLES.plain;
    const own = Array.isArray(agent.args) ? agent.args.map(String) : [];
    let extra;
    if (resume) {
        if (!style.resume) return undefined;
        if (style.idAtStart || agent.style === 'subcommand') {
            if (!agent.conversationId) return undefined;
            extra = style.resume(agent.conversationId);
        } else {
            extra = style.resume();
        }
    } else {
        extra = style.start(agent.conversationId);
    }
    return style.first ? [agent.program, ...extra, ...own] : [agent.program, ...own, ...extra];
}

/** One word for a POSIX shell, quoted only when it must be. */
export function shellWord(word) {
    const text = String(word);
    if (text !== '' && /^[\w@%+=:,./~-]+$/.test(text) && !text.startsWith('~')) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line typed into the terminal's shell: `exec` replaces the shell with
 * the agent, so the terminal ends when the agent does, and says so. A shell
 * that stays when `exec` cannot run the program (bash, when interactive)
 * exits with its code too.
 */
export function launchLine(argv) {
    return `exec ${argv.map(shellWord).join(' ')} || exit $?`;
}

/** The shells a launch line works in. */
export const POSIX_SHELLS = Object.freeze(['zsh', 'bash', 'sh', 'dash', 'ksh']);

/** The first POSIX shell DSH offers for terminals. */
export function pickShell(shells) {
    const list = Array.isArray(shells) ? shells : [];
    for (const name of POSIX_SHELLS) {
        const found = list.find((shell) => basename(String(shell?.path ?? '')).replace(/\.exe$/i, '') === name);
        if (found) return found;
    }
    return undefined;
}
