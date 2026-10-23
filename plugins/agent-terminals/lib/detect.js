/**
 * The coding agents this computer has used, found by the conversations
 * they keep, never by a list of names: a program that keeps one JSON file
 * per conversation under `~/.<program>/projects/<folder>/` starts and
 * resumes like the `flags` style, and one that keeps dated event files under
 * `~/.<program>/sessions/<year>/<month>/<day>/` like the `subcommand` style.
 * The start form offers what it finds; the person may type any other
 * program. A folder named `~/.<name>-<more>` is most often a second folder
 * of the program `<name>` (a backup, another profile): it is offered only
 * when a program of that whole name is installed.
 *
 * @module dsh-plugin-agent-terminals/detect
 */
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const NAME = /^\.([a-z][\w-]{0,30})$/i;
/** Folders read at most per program: the scan stays quick on a big home folder. */
const LOOK = 40;

const dirs = (path) => {
    try {
        return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
};
const files = (path) => {
    try {
        return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
        return [];
    }
};

/** Whether a data folder holds conversations kept one file each, by folder (the flags style). */
export function keepsProjects(data) {
    let seen = 0;
    let latest = 0;
    for (const folder of dirs(join(data, 'projects')).slice(0, LOOK)) {
        for (const name of files(join(data, 'projects', folder)).filter((file) => file.endsWith('.jsonl')).slice(0, LOOK)) {
            seen += 1;
            try {
                latest = Math.max(latest, statSync(join(data, 'projects', folder, name)).mtimeMs);
            } catch {}
        }
    }
    return seen > 0 ? { conversations: seen, latest } : undefined;
}

/** Whether a data folder holds dated event files (the subcommand style). */
export function keepsSessions(data) {
    const years = dirs(join(data, 'sessions')).filter((name) => /^\d{4}$/.test(name)).sort().reverse();
    let seen = 0;
    let latest = 0;
    for (const year of years.slice(0, 3)) {
        for (const month of dirs(join(data, 'sessions', year)).sort().reverse().slice(0, 12)) {
            for (const day of dirs(join(data, 'sessions', year, month)).sort().reverse().slice(0, LOOK)) {
                for (const name of files(join(data, 'sessions', year, month, day)).filter((file) => /\.jsonl$/.test(file)).slice(0, LOOK)) {
                    seen += 1;
                    try {
                        latest = Math.max(latest, statSync(join(data, 'sessions', year, month, day, name)).mtimeMs);
                    } catch {}
                }
                if (seen >= LOOK) return { conversations: seen, latest };
            }
        }
    }
    return seen > 0 ? { conversations: seen, latest } : undefined;
}

/** Where a program is on the PATH DSH runs with (and a few usual places), or undefined. */
export function whereIs(program, { path = process.env.PATH ?? '', home } = {}) {
    const places = [...String(path).split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', ...(home ? [join(home, '.local', 'bin'), join(home, `.${program}`, 'local'), join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin')] : [])];
    for (const dir of [...new Set(places.filter(Boolean))]) {
        const file = join(dir, program);
        try {
            accessSync(file, constants.X_OK);
            if (statSync(file).isFile()) return file;
        } catch {}
    }
    return undefined;
}

/**
 * The coding agents found in a home folder, newest use first.
 * @param {string} home
 * @returns {Array<{ program: string, style: 'flags' | 'subcommand', data: string, conversations: number, latest: number, path?: string }>}
 */
export function detectAgents(home, { path } = {}) {
    const found = [];
    for (const name of dirs(home)) {
        const match = NAME.exec(name);
        if (!match) continue;
        const program = match[1];
        const data = join(home, name);
        const projects = keepsProjects(data);
        const sessions = projects ? undefined : keepsSessions(data);
        const kept = projects ?? sessions;
        if (!kept) continue;
        const where = whereIs(program, { path, home });
        if (program.includes('-') && !where) continue;
        found.push({ program, style: projects ? 'flags' : 'subcommand', data, conversations: kept.conversations, latest: kept.latest, ...(where ? { path: where } : {}) });
    }
    return found.sort((a, b) => b.latest - a.latest);
}
