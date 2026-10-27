/**
 * What a command deletes, read before it runs: rm, rmdir, unlink, shred,
 * `git clean`, `git rm`, `find … -delete` or `-exec rm`, rimraf and
 * PowerShell's Remove-Item; code that deletes (Python's os.remove,
 * os.unlink, shutil.rmtree and Path.unlink, Node's fs.rm, rmSync, unlink
 * and unlinkSync, and the like); a command line or code a shell or an
 * interpreter is given (`bash -c`, a here-document, `python -c`); a script
 * the caller lets it read; and a package script, make target or script
 * whose name says it cleans. Each thing it deletes comes back with where
 * it is, when that can be told, and the caller decides which are free to
 * delete.
 *
 * It reads a command line with the send check's shell reader (sends.js),
 * closely enough for the commands a model writes. Like the send check, it
 * is a check against a well-meant mistake, not a sandbox.
 *
 * @module dsh-plugin-coordinator/deletes
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { canDo, splitShell } from './sends.js';

/** How deep command lines inside command lines, code and scripts are followed. */
const MAX_DEPTH = 3;

/**
 * One thing a command deletes.
 * @typedef {object} Deleted
 * @property {string} program - what deletes it: "rm", "git clean", "python".
 * @property {string} path - what it deletes, as the command names it: "build/", "untracked files".
 * @property {string|null} full - where, as an absolute path; null when it can't be told (a variable, what a pattern or the input names).
 * @property {true} [within] - only some of what is in `full` (`find … -delete`, `git clean`): free when all of `full` is.
 * @property {string} [glob] - for a pattern: the absolute path its matches all start with.
 * @property {true} [temp] - made by mktemp, or inside something mktemp made.
 * @property {string} [said] - how to say it, when "deletes PATH (PROGRAM)" doesn't fit.
 * @property {true} [moved] - moved away (mv, rsync --remove-source-files), not deleted: it leaves its place for `to`.
 * @property {string|null} [to] - for a move: where it goes, as an absolute path; 'temp' for something mktemp made; null when it can't be told.
 * @property {string} [toPath] - for a move: where it goes, as the command names it.
 */

/** A program's name as its path ends: `/bin/rm` and `rm.exe` are `rm`. */
function programOf(word) {
    return basename(String(word ?? '')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** Where the options end: the index of the first word that isn't one (`takes` lists the options that take the next word). */
function skipOptions(args, takes = [], from = 0) {
    let i = from;
    while (i < args.length) {
        const a = args[i];
        if (a === '--') return i + 1;
        if (!a.startsWith('-') || a === '-') return i;
        if (a.startsWith('--')) {
            i += !a.includes('=') && takes.includes(a) ? 2 : 1;
            continue;
        }
        // `-u root` takes the next word; `-uroot` and `-rf` don't.
        i += takes.includes(a.slice(1)) ? 2 : 1;
    }
    return i;
}

/** Commands that only run the command after them, with the options of each that take a value. */
const WRAP = {
    sudo: ['u', 'g', 'h', 'p', 'C', 'D', 'r', 't', 'T', 'U', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user'],
    doas: ['u', 'C'], nohup: [], setsid: [], command: [], builtin: [], exec: ['a'], chronic: [], unbuffer: [],
    time: ['f', 'o', '--format', '--output'], nice: ['n', '--adjustment'], ionice: ['c', 'n', 'p', '--class', '--classdata'],
    stdbuf: ['i', 'o', 'e', '--input', '--output', '--error'],
};
const XARGS_TAKES = ['I', 'n', 'P', 'L', 's', 'd', 'E', 'a', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--eof', '--arg-file', '--replace'];
/** Words that only set up the command after them. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac']);
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=(.*)$/s;

/**
 * The command words run once what only wraps them is taken off (`sudo env
 * X=1 timeout 5 rm …` runs rm), and whether `xargs` gives it more words
 * from its input.
 */
function unwrap(words) {
    let w = words;
    let input = false;
    for (let guard = 0; guard < 16 && w.length > 0; guard++) {
        const first = w[0];
        if (ASSIGN.test(first) || KEYWORDS.has(first)) {
            w = w.slice(1);
            continue;
        }
        if (['for', 'case', 'select', 'function', 'in'].includes(first)) return { words: [], input };
        const name = programOf(first);
        const args = w.slice(1);
        if (name === 'env') {
            let i = 0;
            while (i < args.length) {
                const a = args[i];
                if (a === '--') { i++; break; }
                if (a === '-S' || a === '--split-string') return { words: [...splitWords(args[i + 1] ?? ''), ...args.slice(i + 2)], input };
                if (a === '-u' || a === '-C' || a === '--unset' || a === '--chdir') { i += 2; continue; }
                if (a.startsWith('-') || ASSIGN.test(a)) { i++; continue; }
                break;
            }
            w = args.slice(i);
            continue;
        }
        if (name === 'timeout') {
            w = args.slice(skipOptions(args, ['s', 'k', '--signal', '--kill-after']) + 1);
            continue;
        }
        if (name === 'xargs') {
            input = true;
            w = args.slice(skipOptions(args, XARGS_TAKES));
            if (w.length === 0) w = ['echo'];
            continue;
        }
        if (name === 'command' && (args.includes('-v') || args.includes('-V'))) return { words: [], input };
        if (!Object.hasOwn(WRAP, name)) break;
        w = args.slice(skipOptions(args, WRAP[name]));
    }
    return { words: w, input };
}

/** A string's words as the shell would split it, quotes taken off. */
function splitWords(text) {
    return splitShell(text).commands.flatMap((c) => c.words);
}

// ── Where a path is ───────────────────────────────────────────────────────

/**
 * A path or word cut to `max` characters in its middle, so the end (the
 * file's name) stays whole: "/Users/al…/coordinator-r1/ws/README.md". The
 * cut falls at a "/" where one is near.
 */
export function middleCut(word, max = 60) {
    const text = String(word ?? '');
    if (text.length <= max) return text;
    const room = max - 1;
    let tail = text.slice(-Math.ceil(room * 0.6));
    const slash = tail.indexOf('/');
    if (slash > 0 && slash < tail.length - 8) tail = tail.slice(slash);
    let head = text.slice(0, room - tail.length);
    const end = head.lastIndexOf('/');
    if (end > head.length / 2) head = head.slice(0, end + 1);
    return `${head}…${tail}`;
}

/** `$(mktemp …)` or `` `mktemp …` ``: a new file or folder the command made. */
const MKTEMP = /^(\$\(|`)\s*mktemp\b/;
/** The variables that name the OS temp folder. */
const TEMP_VARS = new Set(['TMPDIR', 'TMP', 'TEMP', 'env:TEMP', 'env:TMP', 'env:TMPDIR']);

/**
 * One thing a command names to delete: where it is, or why that can't be
 * told. A relative path is taken from the folder the command runs in.
 * @returns {Deleted}
 */
function target(word, ctx, program) {
    const shown = middleCut(word);
    const unknown = { program, path: shown, full: null };
    if (MKTEMP.test(word)) return { program, path: shown, full: null, temp: true };
    // `$d`, `${d}/x`, `$TMPDIR/x`, `${TMPDIR:-/tmp}/x`, PowerShell's `$env:TEMP\x`.
    const v = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?-[^}]*)?\}|(env:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*))(.*)$/s.exec(word);
    if (v) {
        const name = v[1] ?? v[2];
        const rest = v[3].replace(/\\/g, '/');
        if (rest !== '' && !rest.startsWith('/')) return unknown;
        if (rest.split('/').includes('..')) return unknown;
        if (ctx.vars?.get(name) === 'temp') return { program, path: shown, full: null, temp: true };
        if (TEMP_VARS.has(name) && rest !== '' && rest !== '/') return checked({ program, path: shown }, `${tmpdir()}${rest}`);
        return unknown;
    }
    if (word.includes('$') || word.includes('`')) return unknown;
    let path = word;
    if (path === '~' || path.startsWith('~/')) path = `${homedir()}${path.slice(1)}`;
    else if (path.startsWith('~')) return unknown;
    if (!isAbsolute(path)) {
        if (ctx.tempCwd && !path.split('/').includes('..')) return { program, path: shown, full: null, temp: true };
        if (typeof ctx.cwd !== 'string') return unknown;
    }
    if (path.split(/[\\/]/).includes('..') && backThroughLink(path, ctx.cwd)) return unknown;
    return checked({ program, path: shown }, isAbsolute(path) ? path : resolve(ctx.cwd, path));
}

/**
 * Whether a path's `..` steps back out of a link: `link/../x` is beside
 * where the link leads, not beside the link, so where it is can't be told
 * from its words.
 */
function backThroughLink(path, cwd) {
    let at = isAbsolute(path) ? sep : cwd;
    for (const part of path.split(/[\\/]+/)) {
        if (part === '' || part === '.') continue;
        if (part !== '..') {
            at = join(at, part);
            continue;
        }
        try {
            if (lstatSync(at).isSymbolicLink()) return true;
        } catch {}
        at = dirname(at);
    }
    return false;
}

/** A path, or for a pattern the part of it before the first wildcard, which every match starts with. */
function checked(item, path) {
    const wild = path.search(/[*?[]/);
    if (wild < 0) return { ...item, full: resolve(path) };
    return { ...item, full: null, glob: path.slice(0, wild) };
}

// ── What each program deletes ─────────────────────────────────────────────

/** rm, rmdir, unlink, shred, rimraf: every word that isn't an option (`takes`: the options that take a value). */
function operands(args, program, ctx, takes = []) {
    const out = [];
    let ended = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!ended && a === '--') { ended = true; continue; }
        if (!ended && a.startsWith('-') && a !== '-') {
            if (takes.includes(a)) i++;
            continue;
        }
        out.push(target(a, ctx, program));
    }
    return out;
}

/**
 * mv, and rsync --remove-source-files: each source leaves its place for the
 * destination (the last operand, or `-t DIR`). Where it goes decides whether
 * it counts (isFree): a move inside the thread's folders is a rename.
 * `takes`: the options that take a value.
 */
function moves(args, ctx, program, takes = [], input = false) {
    let dest;
    const ops = [];
    let ended = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!ended && a === '--') { ended = true; continue; }
        if (!ended && a.startsWith('-') && a !== '-') {
            if (a === '-t' || a === '--target-directory') { dest = args[++i]; continue; }
            if (a.startsWith('--target-directory=')) { dest = a.slice('--target-directory='.length); continue; }
            if (takes.includes(a)) i++;
            continue;
        }
        ops.push(a);
    }
    if (dest === undefined) dest = ops.pop();
    if (dest === undefined || (ops.length === 0 && !input)) return [];
    // Another machine's path (rsync's host:path) is outside every folder here.
    const remote = program === 'rsync' && /^[^/]*:/.test(dest);
    const to = remote ? { path: middleCut(dest), full: null } : target(dest, ctx, program);
    const where = to.temp ? 'temp' : typeof to.full === 'string' ? to.full : null;
    const moved = { moved: true, to: where, toPath: to.path };
    // `xargs mv -t DIR`, `xargs -I{} mv {} DIR`: what moves comes on its input, from wherever it is.
    if (input) return [{ program: `xargs ${program}`, path: 'the files named on its input', full: null, ...moved }];
    return ops.map((word) => ({ ...target(word, ctx, program), ...moved }));
}

/** rsync's options that take a value. */
const RSYNC_TAKES = ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from', '--exclude-from', '--include-from', '--rsync-path', '--log-file', '--partial-dir', '--temp-dir', '-T', '--backup-dir', '--suffix', '--chmod', '--chown', '--password-file', '--port', '--timeout', '--contimeout', '--max-size', '--min-size', '--bwlimit', '--compare-dest', '--copy-dest', '--link-dest', '-B', '--block-size'];

/** git clean and git rm; any other git command deletes nothing here. */
function git(args, ctx) {
    let i = 0;
    let where = ctx;
    while (i < args.length && args[i].startsWith('-')) {
        const a = args[i];
        if (a === '-C' && args[i + 1] !== undefined) {
            where = { ...where, cwd: typeof where.cwd === 'string' || isAbsolute(args[i + 1]) ? resolve(where.cwd ?? '/', args[i + 1]) : null };
            i += 2;
            continue;
        }
        i += a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' ? 2 : 1;
    }
    const [sub, ...rest] = args.slice(i);
    if (sub === 'clean') {
        if (rest.some((a) => a === '--dry-run' || (/^-[a-zA-Z]*n/.test(a) && !a.startsWith('--')))) return [];
        const ignored = rest.some((a) => /^-[a-zA-Z]*[xX]/.test(a) && !a.startsWith('--'));
        // From the folder it runs in down, or only the paths it is given.
        const paths = rest.slice(skipOptions(rest, ['e', '--exclude'])).filter((a) => a !== '');
        const places = paths.length > 0 ? paths.map((p) => target(p, where, 'git clean')) : [typeof where.cwd === 'string' ? { full: where.cwd } : where.tempCwd ? { temp: true } : { full: null }];
        return places.map((p) => ({ ...p, program: 'git clean', path: ignored ? 'untracked and ignored files' : 'untracked files', within: true }));
    }
    if (sub === 'rm') {
        if (rest.some((a) => a === '--cached' || a === '--dry-run' || a === '-n')) return [];
        if (rest.some((a) => a.startsWith('--pathspec-from-file'))) return [{ program: 'git rm', path: 'the files a list names', full: null }];
        return operands(rest, 'git rm', where);
    }
    return [];
}

/** `find PLACES … -delete`, or `-exec rm …`: some of what is in each place. */
function find(args, ctx) {
    let i = 0;
    while (i < args.length && /^-[HLP]$|^-D$|^-O\d*$/.test(args[i])) i += args[i] === '-D' ? 2 : 1;
    const places = [];
    for (; i < args.length && !args[i].startsWith('-') && args[i] !== '(' && args[i] !== '!' && args[i] !== '\\('; i++) places.push(args[i]);
    let how;
    if (args.includes('-delete')) how = 'find -delete';
    for (let k = 0; k < args.length && how === undefined; k++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[k])) continue;
        const end = args.findIndex((a, j) => j > k && (a === ';' || a === '+'));
        const { words } = unwrap(args.slice(k + 1, end < 0 ? args.length : end));
        if (DELETERS.has(programOf(words[0])) || (programOf(words[0]) === 'git' && ['rm', 'clean'].includes(words[1]))) how = `find -exec ${programOf(words[0])}`;
    }
    if (how === undefined) return [];
    return (places.length > 0 ? places : ['.']).map((p) => ({ ...target(p, ctx, how), path: `what it finds in ${middleCut(p)}`, within: true }));
}

/** PowerShell's Remove-Item and its aliases: `-Path`, `-LiteralPath` and the words without an option; `-Include` and the like make it a pattern. */
function removeItem(args, ctx, program) {
    if (args.some((a) => /^-whatif(:\$true)?$/i.test(a))) return [];
    const out = [];
    let pattern = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (/^-(path|literalpath|lp|pspath)$/i.test(a)) {
            out.push(...String(args[++i] ?? '').split(',').filter(Boolean));
            continue;
        }
        if (/^-(include|exclude|filter)$/i.test(a)) {
            pattern = true;
            i++;
            continue;
        }
        if (/^-(erroraction|ea|warningaction|wa|informationaction|infa|credential|stream|outvariable|ov|errorvariable|ev)$/i.test(a)) {
            i++;
            continue;
        }
        // cmd's `del /s /q x` and `rd /s /q x` too.
        if (a.startsWith('-') || /^\/[a-z]$/i.test(a)) continue;
        out.push(...a.split(',').filter(Boolean));
    }
    return out.map((p) => {
        const item = target(p.replace(/\\/g, '/'), ctx, program);
        return pattern && item.full !== null ? { program, path: item.path, full: null, glob: `${item.full}/` } : item;
    });
}

/** Programs that delete the files they name. */
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'rimraf', 'del-cli', 'remove-item', 'ri', 'del', 'erase', 'rd', 'srm', 'trash-put']);
/** Words in a script's, a target's or a task's name that say it deletes files. */
const CLEANS = new Set(['clean', 'cleanup', 'clear', 'purge', 'wipe', 'nuke', 'clobber', 'distclean', 'realclean', 'mrproper', 'scrub', 'prune', 'rm', 'rimraf', 'remove', 'delete', 'del', 'erase']);
/** The words of a name: `scripts/clean-all.sh` and `cleanCache` give [scripts, clean, all, sh] and [clean, cache]. */
const nameWords = (name) => String(name).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
const cleaning = (name) => nameWords(name).some((w) => CLEANS.has(w));
const byName = (label, program) => ({ program, path: label, full: null, said: `runs ${label}, whose name says it deletes files` });
/** Build tools, and the goal or subcommand that deletes their output: `cargo clean`, `mvn clean install`, `./gradlew :app:clean`, `mix deps.clean`. */
const BUILDERS = new Set(['cargo', 'go', 'dotnet', 'mvn', 'mvnw', 'gradle', 'gradlew', 'ant', 'sbt', 'lein', 'mix', 'cabal', 'stack', 'swift', 'flutter', 'bazel', 'bazelisk', 'xcodebuild', 'ninja', 'cmake', 'scons']);
const BUILD_CLEAN = /(^|[:.])(clean|distclean|realclean|clobber|mrproper)([A-Z]\w*)?$/;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh']);
const isPython = (name) => /^python(\d+(\.\d+)?)?$/.test(name);
const CODE_RUNNERS = new Set(['node', 'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php', 'ts-node', 'tsx']);
const SCRIPT_EXT = /\.(sh|bash|zsh|ksh|py|js|mjs|cjs|ts|mts|rb|pl|php|ps1)$/i;
const RUNNERS = new Set(['just', 'task', 'rake', 'gulp', 'grunt', 'invoke', 'inv', 'nox', 'tox', 'mage', 'fab', 'poe']);
/** The package managers' own subcommands, which no script of the package's shadows. */
const PM_OWN = new Set(['add', 'install', 'i', 'ci', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'init', 'create', 'info', 'why', 'list', 'ls', 'config', 'cache', 'outdated', 'audit', 'link', 'unlink', 'pack', 'publish', 'prune', 'dedupe', 'rebuild', 'bin', 'root', 'store', 'import', 'patch', 'version', 'login', 'logout', 'whoami', 'exec', 'dlx', 'x', 'test', 't', 'start', 'build', 'pm', 'workspaces', 'workspace', 'global', 'set', 'plugin', 'node', 'env', 'setup', 'fetch', 'help']);

/** A script run from a file: what it deletes when the caller lets it be read, else by its name. */
function script(path, how, ctx) {
    const full = isAbsolute(path) ? path : typeof ctx.cwd === 'string' ? resolve(ctx.cwd, path) : undefined;
    let text;
    if (full !== undefined && typeof ctx.read === 'function' && (ctx.depth ?? 0) < MAX_DEPTH) {
        try { text = ctx.read(full); } catch { text = undefined; }
    }
    if (typeof text === 'string') {
        const deeper = { ...ctx, depth: (ctx.depth ?? 0) + 1, cwd: dirname(full), vars: new Map() };
        const first = text.slice(0, 200).split('\n')[0];
        const shebang = first.startsWith('#!') ? programOf(first.slice(2).trim().split(/\s+/).find((w, i) => !(i === 0 && /\/env$/.test(w)) && !w.startsWith('-')) ?? '') : undefined;
        const kind = shebang ?? how;
        const inside = SHELLS.has(kind) || (kind === undefined && /\.(sh|bash|zsh|ksh)$/i.test(path)) ? lineDeletes(text, deeper)
            : kind === 'pwsh' || kind === 'powershell' || /\.ps1$/i.test(path) ? lineDeletes(text, { ...deeper, shell: 'pwsh' })
                : codeDeletes(text, deeper, kind ?? 'code');
        // What it does counts, not what it is called.
        return inside.map((d) => ({ ...d, said: `runs ${path}, which ${canDo(said(d))}` }));
    }
    return cleaning(basename(path)) ? [byName(path, 'script')] : [];
}

/** `npm run X`, `yarn X`, `make X`, `just X`: by the name of the script, target or task. */
function named(name, args) {
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
        const rest = args.slice(skipOptions(args, ['C', 'w', '--prefix', '--cwd', '--dir', '--filter', '--workspace']));
        const [sub, ...more] = rest;
        if (sub === undefined) return [];
        const run = ['run', 'run-script', 'rum', 'urn'].includes(sub) ? more.find((w) => !w.startsWith('-')) : name !== 'npm' && !PM_OWN.has(sub) ? sub : undefined;
        return run !== undefined && cleaning(run) ? [byName(`${name} ${sub === run ? '' : `${sub} `}${run}`, name)] : [];
    }
    const tasks = args.filter((a) => !a.startsWith('-') && !a.includes('='));
    const task = tasks.find(cleaning);
    return task !== undefined ? [byName(`${name} ${task}`, name)] : [];
}

/** An interpreter given code or a command line: `bash -c`, a here-document, `python -c`, `node -e`, `pwsh -Command`, or a script file. */
function interpreter(name, args, ctx, inputs) {
    const deeper = { ...ctx, depth: (ctx.depth ?? 0) + 1, vars: new Map(ctx.vars ?? []) };
    if ((ctx.depth ?? 0) >= MAX_DEPTH) return [];
    if (SHELLS.has(name) || name === 'source' || name === '.') {
        if (SHELLS.has(name) && args.some((a) => /^-[a-z]*n[a-z]*$/.test(a))) return [];
        const c = SHELLS.has(name) ? args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a) && !a.startsWith('--')) : -1;
        if (c >= 0) return args[c + 1] !== undefined ? lineDeletes(args[c + 1], deeper) : [];
        const file = args.slice(skipOptions(args, ['o', 'O', '--init-file', '--rcfile']))[0];
        if (file !== undefined && file !== '-') return script(file, name === 'source' || name === '.' ? 'bash' : name, ctx);
        return inputs.flatMap((input) => lineDeletes(input, deeper));
    }
    if (name === 'pwsh' || name === 'powershell') {
        const at = args.findIndex((a) => /^-(c|command)$/i.test(a));
        if (at >= 0) return lineDeletes(args.slice(at + 1).join(' '), { ...deeper, shell: 'pwsh' });
        const f = args.findIndex((a) => /^-(f|file)$/i.test(a));
        return f >= 0 && args[f + 1] !== undefined ? script(args[f + 1], 'pwsh', ctx) : [];
    }
    const flags = isPython(name) ? ['-c'] : name === 'php' ? ['-r'] : ['-e', '--eval', '-p', '--print', '-E'];
    const at = args.findIndex((a) => flags.includes(a));
    if (at >= 0) return codeDeletes(args[at + 1] ?? '', deeper, name);
    if (isPython(name) && args.includes('-m')) return [];
    if (name === 'deno' && args[0] === 'eval') return codeDeletes(args[1] ?? '', deeper, name);
    const pos = args.slice(skipOptions(args, isPython(name) ? ['W', 'X', 'Q'] : ['r', '--require', '--import', '--loader', '--env-file', 'C', '--conditions']));
    const file = name === 'deno' && pos[0] === 'run' ? pos[1] : pos[0];
    if (file !== undefined && file !== '-') return script(file, name, ctx);
    return inputs.flatMap((input) => codeDeletes(input, deeper, name));
}

/** What one simple command (its words) deletes. */
function wordsDeletes(rawWords, ctx, inputs = []) {
    const { words, input } = unwrap(rawWords);
    if (words.length === 0) return [];
    const first = words[0];
    const name = programOf(first);
    const args = words.slice(1);
    if (args.includes('--help') || args.includes('--version')) return [];
    // `xargs rm`: what it deletes comes on its input too.
    const fromInput = (found) => (input ? [...found, { program: `xargs ${found[0]?.program ?? name}`, path: 'the files named on its input', full: null }] : found);
    const pwsh = ctx.shell === 'pwsh';
    if (name === 'remove-item' || name === 'ri' || (pwsh && ['rm', 'rmdir'].includes(name)) || name === 'del' || name === 'erase' || name === 'rd') {
        return fromInput(removeItem(args, ctx, pwsh || name === 'remove-item' || name === 'ri' ? 'Remove-Item' : name));
    }
    switch (name) {
        case 'rm': case 'srm': case 'rmdir': case 'unlink': case 'trash-put': case 'rimraf': case 'del-cli':
            return fromInput(operands(args, name, ctx));
        case 'shred': return fromInput(operands(args, 'shred', ctx, ['-n', '-s', '--iterations', '--size', '--random-source']));
        case 'mv': return moves(args, ctx, 'mv', ['-S', '--suffix'], input);
        case 'rsync': return args.includes('--remove-source-files') ? moves(args, ctx, 'rsync', RSYNC_TAKES, input) : [];
        case 'git': return args.includes('rm') || args.includes('clean') ? fromInput(git(args, ctx)) : [];
        case 'find': return find(args, ctx);
        case 'eval': return (ctx.depth ?? 0) < MAX_DEPTH ? lineDeletes(args.join(' '), { ...ctx, depth: (ctx.depth ?? 0) + 1 }) : [];
        case 'npx': case 'bunx': case 'pnpx': {
            const rest = args.slice(skipOptions(args, ['p', '--package']));
            return rest.length > 0 ? wordsDeletes(rest, ctx) : [];
        }
        default: break;
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
        const rest = args.slice(skipOptions(args, ['C', 'w', '--prefix', '--cwd', '--dir', '--filter', '--workspace']));
        if (['exec', 'x', 'dlx'].includes(rest[0])) {
            const more = rest.slice(1);
            return wordsDeletes(more.slice(skipOptions(more, ['p', '--package', 'c', '--call'])), ctx);
        }
        return named(name, args);
    }
    if (['make', 'gmake', 'bmake'].includes(name) || RUNNERS.has(name)) return named(name, args);
    if (BUILDERS.has(name)) {
        const goal = args.find((a) => !a.startsWith('-') && BUILD_CLEAN.test(a));
        return goal !== undefined ? [byName(`${name} ${goal}`, name)] : [];
    }
    if (SHELLS.has(name) || CODE_RUNNERS.has(name) || isPython(name) || name === 'source' || name === '.' || name === 'pwsh' || name === 'powershell') return interpreter(name, args, ctx, inputs);
    if (first.includes('/') || SCRIPT_EXT.test(first)) return script(first, undefined, ctx);
    return [];
}

/**
 * What a command line deletes: each of its commands, then the command
 * lines inside it. `cd` moves where later paths are taken from, and a
 * variable set from mktemp names something the command line made.
 */
function lineDeletes(text, ctx) {
    // PowerShell's paths keep their backslashes (it escapes with a backquote): `$env:TEMP\x` is `$env:TEMP/x`.
    const { commands, nested } = splitShell(ctx.shell === 'pwsh' ? String(text).replace(/\\/g, '/') : text);
    const out = [];
    let here = { ...ctx, vars: new Map(ctx.vars ?? []) };
    for (let i = 0; i < commands.length; i++) {
        const { words, inputs } = commands[i];
        // `d=$(mktemp -d)`, `local d=$(mktemp)`, `export d="$(mktemp -d)"`.
        const sets = ['local', 'export', 'declare', 'readonly', 'typeset'].includes(words[0]) ? words.slice(1).filter((w) => !w.startsWith('-')) : words;
        if (sets.length > 0 && sets.every((w) => ASSIGN.test(w))) {
            for (const w of sets) {
                const [, name, , value] = ASSIGN.exec(w);
                if (MKTEMP.test(value) || here.vars.get(value.replace(/^\$\{?|\}$/g, '')) === 'temp') here.vars.set(name, 'temp');
                else here.vars.delete(name);
            }
            continue;
        }
        // PowerShell's `$d = New-TemporaryFile`; what the right side runs still counts.
        if (here.shell === 'pwsh' && words.length >= 3 && /^\$[A-Za-z_]\w*$/.test(words[0]) && words[1] === '=') {
            if (/New-TemporaryFile|GetTempFileName|GetTempPath/i.test(words.slice(2).join(' '))) here.vars.set(words[0].slice(1), 'temp');
            out.push(...wordsDeletes(words.slice(2), here, inputs));
            continue;
        }
        // A later command runs where `cd` went: `cd /tmp/x && rm -rf y`. Somewhere it can't tell, no path is known.
        if (['cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir'].includes(words[0]?.toLowerCase())) {
            const to = words.length === 2 ? words[1] : undefined;
            const made = to !== undefined && (MKTEMP.test(to) || here.vars.get(to.replace(/^\$\{?|\}$/g, '')) === 'temp');
            const known = to !== undefined && !/^[~$-]/.test(to) && !to.includes('$') && !to.includes('`');
            here = { ...here, tempCwd: made, cwd: made || !known ? null : isAbsolute(to) ? to : typeof here.cwd === 'string' ? resolve(here.cwd, to) : null };
            continue;
        }
        // Text piped into an interpreter is what it runs: `cat <<EOF | sh`, `echo 'rm -rf x' | bash`.
        const before = i > 0 && commands[i - 1].pipe ? commands[i - 1] : undefined;
        const fed = before ? [...before.inputs, ...(['echo', 'printf'].includes(before.words[0]) ? [before.words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(' ')] : [])] : [];
        out.push(...wordsDeletes(words, here, [...inputs, ...fed]));
    }
    if ((ctx.depth ?? 0) < MAX_DEPTH) {
        for (const inner of nested) out.push(...lineDeletes(inner, { ...ctx, depth: (ctx.depth ?? 0) + 1 }));
    }
    // PowerShell's .NET calls: [System.IO.File]::Delete('x').
    if (ctx.shell === 'pwsh') out.push(...codeDeletes(text, { ...ctx, depth: MAX_DEPTH }, 'pwsh').filter((d) => d.dotnet));
    return out;
}

// ── Code ──────────────────────────────────────────────────────────────────

/** Calls that delete a file or a folder, in Python, JavaScript, Ruby, Go, Perl, PHP and .NET. */
const CODE_DELETES = [
    /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(/g,
    /\bshutil\s*\.\s*rmtree\s*\(/g,
    /\b(?:fs|fsp|fse|fsExtra|promises)\s*\.\s*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|remove|removeSync|emptyDir|emptyDirSync)\s*\(/g,
    /\brequire\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)\s*(?:\.\s*promises\s*)?\.\s*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/g,
    /\.\s*(?:rmSync|unlinkSync|rmdirSync)\s*\(/g,
    /(?<![\w.])(?:rmSync|unlinkSync|rmdirSync|rimraf|rimrafSync|removeSync)\s*\(/g,
    /\bDeno\s*\.\s*(?:remove|removeSync)\s*\(/g,
    /\.\s*(?:unlink|rmdir)\s*\(/g,
    /\bFileUtils\s*\.\s*(?:rm|rm_r|rm_rf|rm_f|remove|remove_dir|remove_entry|remove_entry_secure|rmdir|rmtree)\b\s*\(?/g,
    /\b(?:File|Dir)\s*\.\s*(?:delete|unlink|rmdir)\b\s*\(?/g,
    /\bos\s*\.\s*(?:Remove|RemoveAll)\s*\(/g,
    /(?<![\w.])unlink\s*\(?(?=\s*['"$])/g,
    /(?<![\w.])(?:rmtree|remove_tree)\s*\(/g,
];
const DOTNET_DELETE = /\[(?:System\.)?IO\.(?:File|Directory|FileInfo|DirectoryInfo)\]\s*::\s*Delete\s*\(/gi;
const FS_IMPORT = /\{[^}]*\b(?:rm|unlink|rmdir)\b[^}]*\}\s*(?:=\s*(?:await\s+)?(?:require|import)\s*\(\s*|from\s*)['"](?:node:)?fs(?:\/promises)?['"]/;
/** Code that runs commands: then its strings and lists of strings are read as command lines. */
const SPAWNS = /\b(?:subprocess|os\.system|os\.popen|os\.exec\w*|pexpect|child_process|execSync|execFileSync|spawnSync|spawn|execFile|execa|execaSync|Bun\.spawn|Bun\.\$|Deno\.Command|Deno\.run|Open3|shell_exec|passthru|proc_open|popen|system|exec|IO\.popen|Process\.(?:spawn|start)|ProcessBuilder|Runtime\.getRuntime)\b|\$`|%x[({[]|\bqx[({[/]/;

/** The literal text of a string that starts at `at` (a quote), or undefined when there is none or it has a value in it. */
function literalAt(text, at) {
    const prefix = /^[rRbBuU]?/.exec(text.slice(at))[0];
    const q = text[at + prefix.length];
    if (q !== '"' && q !== "'" && q !== '`') return undefined;
    let out = '';
    for (let i = at + prefix.length + 1; i < text.length && i < at + 2000; i++) {
        const c = text[i];
        if (c === '\\' && prefix === '') { out += text[i + 1] ?? ''; i++; continue; }
        if (c === q) return q === '`' && out.includes('${') ? undefined : out;
        if (c === '\n' && q !== '`') return undefined;
        out += c;
    }
    return undefined;
}

/** What a call deletes: `Path('x').unlink()`, or its first argument when that is a plain string. */
function calledOn(text, m) {
    const before = text.slice(Math.max(0, m.index - 300), m.index);
    const path = /(?:Path|PurePath|PosixPath|WindowsPath)\s*\(\s*(['"])([^'"\n]*)\1\s*\)\s*$/.exec(before);
    if (path && /^\s*\.\s*(unlink|rmdir)/.test(m[0])) return path[2];
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '(') i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    return literalAt(text, i);
}

/**
 * What code deletes: its delete calls, each with the path it names when
 * that is a plain string; and a command line it runs (a string, or a list
 * of a program's words) that deletes.
 * @returns {Deleted[]}
 */
export function codeDeletes(code, ctx = { depth: 0 }, program = 'code') {
    const text = String(code ?? '');
    const out = [];
    const seen = new Set();
    // `import { rm } from 'node:fs/promises'`, `const { unlink } = require('fs')`: then a bare `rm(` deletes too.
    const bare = FS_IMPORT.test(text) ? [/(?<![\w.])(?:rm|unlink|rmdir)\s*\(/g] : [];
    for (const re of [...CODE_DELETES, ...bare, DOTNET_DELETE]) {
        for (const m of text.matchAll(re)) {
            if (seen.has(m.index)) continue;
            seen.add(m.index);
            const path = calledOn(text, m);
            const item = path === undefined || path === '' ? { program, path: 'a path the code works out', full: null } : target(path, ctx, program);
            out.push({ ...item, said: `runs code that deletes ${item.path} (${program})`, ...(re === DOTNET_DELETE ? { dotnet: true } : {}) });
        }
    }
    // Its strings are read as commands only where it runs commands, so a message that mentions one deletes nothing.
    if ((ctx.depth ?? 0) >= MAX_DEPTH || !SPAWNS.test(text)) return out;
    const deeper = { ...ctx, depth: (ctx.depth ?? 0) + 1 };
    const inCode = (found) => found.map((d) => ({ ...d, said: `runs code that ${said(d)}` }));
    // A program and its words as a list: `subprocess.run(['rm', '-rf', 'build'])`, `spawn('rm', ['-rf', 'build'])`.
    for (const m of text.matchAll(/(['"])([^'"\n]{1,200})\1\s*,\s*\[([^\]]{0,600})\]/g)) {
        out.push(...inCode(wordsDeletes([m[2], ...[...m[3].matchAll(/(['"])([^'"\n]*)\1/g)].map((w) => w[2])], deeper)));
    }
    for (const m of text.matchAll(/\[\s*((?:(['"])[^'"\n]{0,200}\2\s*,\s*){1,30}(['"])[^'"\n]{0,200}\3)\s*,?\s*\]/g)) {
        out.push(...inCode(wordsDeletes([...m[1].matchAll(/(['"])([^'"\n]*)\1/g)].map((w) => w[2]), deeper)));
    }
    // A command line as one string: `execSync('rm -rf build')`, `os.system("rm -rf build")`.
    for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.){3,400})\1/g)) {
        if (/\s/.test(m[2])) out.push(...inCode(lineDeletes(m[2].replace(/\$\{[^}]*\}/g, '$X'), deeper)));
    }
    return out;
}

// ── What is free to delete ────────────────────────────────────────────────

/** The OS temp folder and the usual others, as written and as they really are (macOS's /tmp is /private/tmp). */
function tempRoots() {
    const roots = new Set([tmpdir(), '/tmp', '/var/tmp']);
    for (const root of [...roots]) {
        try { roots.add(realpathSync(root)); } catch {}
    }
    return [...roots].filter((root) => isAbsolute(root) && resolve(root) !== resolve('/'));
}

/** The folder a pattern's matches are in: "/ws/notes/old-" → "/ws/notes". */
const globFolder = (glob) => (glob.endsWith('/') || glob.endsWith(sep) ? resolve(glob) : dirname(resolve(glob)));

/** Whether a path is inside a folder (not the folder itself). */
const inside = (path, root) => path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * A path with its links resolved, as far as it exists: the real path of its
 * deepest folder that exists, then the rest as written. Never throws.
 */
function realOf(path) {
    const rest = [];
    let at = String(path);
    for (let depth = 0; depth < 64; depth++) {
        try {
            return rest.length === 0 ? realpathSync(at) : join(realpathSync(at), ...rest);
        } catch {}
        const up = dirname(at);
        if (up === at) break;
        rest.unshift(basename(at));
        at = up;
    }
    return String(path);
}

/** How far a file's times may be from the clock that read them: a file system stamps them with a coarse clock (FAT's is 2 s). */
export const CLOCK_SLACK_MS = 2000;
/** How many things on the disk the check reads for one thing a command deletes, at most; past that it asks. */
const MAX_ENTRIES = 2000;

/** When lstat says a file was made, or undefined where the file system doesn't keep that. */
export function bornOf(stat) {
    const birth = stat?.birthtimeMs;
    return Number.isFinite(birth) && birth > 0 ? birth : undefined;
}

/**
 * Which file lstat shows, as the delete check keeps it: {dev, ino, birth},
 * or undefined where the file system keeps no birth time, so a file made
 * again in its place couldn't be told from it.
 */
export function identityOf(stat) {
    const birth = bornOf(stat);
    return birth === undefined || !Number.isSafeInteger(stat.ino) || !Number.isSafeInteger(stat.dev) ? undefined : { dev: stat.dev, ino: stat.ino, birth };
}

/** Whether lstat shows the file `id` names (identityOf), not another made in its place. */
export function isSame(stat, id) {
    return id !== null && typeof id === 'object' && stat.dev === id.dev && stat.ino === id.ino && bornOf(stat) === id.birth;
}

/**
 * What a thread can be shown to have made, for the delete check.
 * @typedef {object} Mine
 * @property {Map<string, {dev: number, ino: number, birth: number}>} [made] - by absolute path, the files it created and
 *   the folders its commands made, each as the file it was then (identityOf): one removed and made again, or saved over
 *   by someone else, isn't its own.
 * @property {number[][]} [spans] - when it was running calls, as [start, end] (end Infinity while one runs): what was
 *   born in a folder it made while it ran is its own; what was born there at another time (moved in, or someone
 *   else's) isn't.
 * @property {(path: string) => boolean} [foreign] - whether another session wrote the path with DSH's file tools: then it never is.
 */

/** Whether a birth time falls while the thread ran (`spans`). */
function whileRan(birth, spans) {
    return birth !== undefined && spans.some(([start, end]) => birth >= start - CLOCK_SLACK_MS && birth <= end + CLOCK_SLACK_MS);
}

/**
 * Whether a path is in a folder the thread made, still that folder, and
 * reached from it through real folders only: a link on the way leads
 * anywhere (`ln -s ~/Documents made/docs`, then `rm made/docs/report.txt`).
 */
function inMadeFolder(path, mine) {
    for (let up = dirname(path); up !== dirname(up); up = dirname(up)) {
        const id = mine.made.get(up);
        if (id === undefined) continue;
        try {
            for (let at = dirname(path); at !== up; at = dirname(at)) {
                if (!lstatSync(at).isDirectory()) return false;
            }
            return isSame(lstatSync(up), id);
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Whether a path holds only what the thread can be shown to have made,
 * read from the disk: a file or folder it made, still the same one; in a
 * folder it made, what was born there while it ran (a clone's .git
 * included); a folder of only those; or nothing at all. Never a link, any
 * other .git, what another session wrote with DSH's file tools, an empty
 * folder it didn't make, or anything past MAX_ENTRIES: who made them
 * can't be told.
 * @param {boolean} [within] - whether the path is in a folder the thread made, as the walk found it.
 */
function owned(path, mine, budget = { left: MAX_ENTRIES }, within = undefined) {
    let stat;
    try {
        stat = lstatSync(path);
    } catch (error) {
        return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
    }
    if (--budget.left < 0 || stat.isSymbolicLink() || mine.foreign?.(path)) return false;
    // Its own: a file or folder it made, still that one; or, in a folder it made, born while it ran.
    let own = isSame(stat, mine.made.get(path));
    if (!own && (within ?? inMadeFolder(path, mine))) {
        if (!whileRan(bornOf(stat), mine.spans)) return false;
        own = true;
    }
    if (!own && basename(path) === '.git') return false;
    if (!stat.isDirectory()) return own;
    let names;
    try { names = readdirSync(path); } catch { return false; }
    if (names.length === 0) return own;
    for (const name of names) {
        if (!owned(join(path, name), mine, budget, own)) return false;
    }
    return true;
}

/**
 * Whether one thing a command deletes is free to delete without asking:
 * something mktemp made; something in the OS temp folder, outside the
 * workspace and not holding it; or what the thread can be shown to have
 * made (`mine`, owned): for a folder, all of what is in it. Nothing in the
 * workspace's .git is, and nothing that can't be told (a variable, what
 * the input names, a pattern outside the temp folder over files the
 * thread didn't all make).
 * @param {Deleted} d
 * @param {{work?: string[], mine?: Mine}} [where] - `work`: the workspace's folders, absolute.
 */
export function isFree(d, { work = [], mine: given = {} } = {}) {
    if (d.temp) return true;
    const mine = { made: given.made ?? new Map(), spans: Array.isArray(given.spans) ? given.spans : [], foreign: given.foreign };
    const roots = tempRoots();
    // The workspace by the path it was given and by its real one: a folder reached through a link (macOS's /var is
    // /private/var) is still the workspace, never a temp folder outside it.
    const works = [...new Set(work.flatMap((w) => [w, realOf(w)]))];
    const inWork = (path) => [path, realOf(path)].some((p) => works.some((w) => p === w || inside(p, w)));
    const holdsWork = (path) => [path, realOf(path)].some((p) => works.some((w) => w === p || inside(w, p)));
    const inGit = (path) => path.split(sep).includes('.git');
    // A move from the thread's folders to a place in them (not into or out of a .git) is a rename: nothing leaves.
    // One out of them, or to where it can't be told, is a delete of what moves, by the rules below.
    if (d.moved && typeof d.to === 'string' && d.to !== 'temp' && inWork(d.to) && !inGit(d.to)) {
        if (typeof d.glob === 'string' ? inWork(globFolder(d.glob)) && !inGit(globFolder(d.glob))
            : typeof d.full === 'string' && inWork(d.full) && !holdsWork(d.full) && !inGit(d.full)) return true;
    }
    if (typeof d.glob === 'string') {
        // The folder its matches are in, and the start of their names there.
        const folder = globFolder(d.glob);
        const start = d.glob.endsWith('/') || d.glob.endsWith(sep) ? '' : basename(resolve(d.glob));
        const mayMatchWork = [folder, realOf(folder)].some((f) => works.some((w) => w === f || inside(w, f) && (start === '' || resolve(w).slice(f.length + 1).startsWith(start))));
        if (!inWork(folder) && !mayMatchWork && roots.some((r) => inside(folder, r) || (folder === r && start !== ''))) return true;
        return !folder.split(sep).includes('.git') && owned(folder, mine);
    }
    if (typeof d.full !== 'string') return false;
    const path = d.full;
    if (inWork(path)) return !path.split(sep).includes('.git') && owned(path, mine);
    if (roots.some((r) => inside(path, r))) return !holdsWork(path);
    return owned(path, mine);
}

// ── Saying it ─────────────────────────────────────────────────────────────

/** One thing deleted, said after "it": "deletes build/ (rm)", "moves README.md to /tmp/ (mv)". */
export function said(d) {
    return d.said ?? (d.moved ? `moves ${d.path} to ${d.toPath || UNTOLD_PLACE} (${d.program})` : `deletes ${d.path} (${d.program})`);
}

/** Where a move goes, when the command doesn't say it in a way the check can read. */
const UNTOLD_PLACE = 'a place it can\'t tell';

/** Several, as a list: "a", "a and b", "a, b and c". */
const listed = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '');

/**
 * What a command deletes, said after "the command": "deletes build/ and
 * dist/ (rm)", "deletes build/ (rm) and untracked files (git clean)".
 * @param {Deleted[]} items
 */
export function deletesWhat(items, { folders = [] } = {}) {
    const byProgram = new Map();
    const other = [];
    for (const d of items) {
        if (d.said) {
            if (!other.includes(d.said)) other.push(d.said);
            continue;
        }
        const key = d.moved ? `moves\u0000${d.program}\u0000${d.toPath ?? ''}` : `deletes\u0000${d.program}`;
        const paths = byProgram.get(key) ?? [];
        const shown = pathWords(d, folders);
        if (!paths.includes(shown)) paths.push(shown);
        byProgram.set(key, paths);
    }
    let verb = '';
    const parts = [...byProgram].map(([key, paths]) => {
        const [said, program, to] = key.split('\u0000');
        const lead = said !== verb ? `${said} ` : '';
        verb = said;
        const list = paths.length > 3 ? `${paths.slice(0, 2).join(', ')} and ${paths.length - 2} more` : listed(paths);
        return `${lead}${list}${said === 'moves' ? ` to ${to || UNTOLD_PLACE}` : ''} (${program})`;
    });
    const all = [...parts, ...other];
    return all.length > 3 ? `${all.slice(0, 3).join(', ')} and more` : listed(all);
}

/**
 * Where one thing is, as a prompt says it: relative to the first of the
 * thread's folders that holds it ("notes/old.txt"), else as the command
 * names it, cut in the middle so its name stays whole.
 */
function pathWords(d, folders) {
    // `within`: some of what is in a place, said in words of its own ("untracked files", "what it finds in .").
    if (typeof d.full === 'string' && !d.within) {
        // By the paths as given and by their real ones (macOS's /var is /private/var).
        const fulls = [...new Set([d.full, realOf(d.full)])];
        for (const folder of folders) {
            if (typeof folder !== 'string' || folder === '') continue;
            for (const base of new Set([resolve(folder), realOf(resolve(folder))])) {
                const full = fulls.find((f) => f === base || inside(f, base));
                if (full === undefined) continue;
                if (full === base) return `the whole folder ${basename(base)}`;
                const rel = relative(base, full);
                // As the command names it when that is already the same ("build/"), else from the folder.
                return middleCut(d.path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') === rel ? d.path : rel);
            }
        }
    }
    return middleCut(d.path);
}

/**
 * What a shell command deletes, each thing with where it is when that can
 * be told; [] when it deletes nothing.
 * @param {string} command - the command line, as the shell tool gets it.
 * @param {object} [options]
 * @param {'bash'|'pwsh'} [options.shell] - which shell runs it.
 * @param {string} [options.cwd] - the folder it runs in.
 * @param {(path: string) => string|undefined} [options.read] - a script's text by its full path, or undefined (only scripts the caller lets it follow).
 * @returns {Deleted[]}
 */
export function deletesOf(command, options = {}) {
    if (typeof command !== 'string' || command.trim() === '') return [];
    return lineDeletes(command, { depth: 0, shell: options.shell ?? 'bash', cwd: options.cwd, read: options.read, vars: new Map() });
}

// ── What a command makes ──────────────────────────────────────────────────

/** A folder a mkdir names, as an absolute path, or undefined when it can't be told (a variable, a pattern, `~user`). */
function madePath(word, here) {
    let path = String(word).replace(/^\$(?:PWD|\{PWD\})(?=\/|$)/, typeof here === 'string' ? here : '$PWD');
    if (path === '~' || path.startsWith('~/')) path = `${homedir()}${path.slice(1)}`;
    if (path === '' || /[$`*?[~]/.test(path)) return undefined;
    if (isAbsolute(path)) return resolve(path);
    return typeof here === 'string' ? resolve(here, path) : undefined;
}

/**
 * The folders a shell command line makes: mkdir in bash, and New-Item
 * -ItemType Directory, md and mkdir in PowerShell, as absolute paths, with
 * their parents when the command makes those too (`mkdir -p`; PowerShell
 * always does). The caller keeps the ones missing before the command and,
 * after it, a real folder born while it ran: the folders the thread made
 * itself, which the delete check lets it delete with what it put in them
 * (behaviour review 5, S1 r1: a scratch folder of a headless browser's
 * profile was held). A path that can't be told is left out, and so is what
 * comes after a `cd` it can't follow.
 * @param {string} command - the command line, as the shell tool gets it.
 * @param {{shell?: 'bash'|'pwsh', cwd?: string}} [options] - which shell, and the folder it runs in.
 * @returns {string[]}
 */
export function madeDirsOf(command, { shell = 'bash', cwd } = {}) {
    const out = new Set();
    const pwsh = shell === 'pwsh';
    const add = (word, here, parents) => {
        const path = madePath(word, here);
        if (path === undefined) return;
        out.add(path);
        if (!parents) return;
        for (let up = dirname(path); up !== dirname(up); up = dirname(up)) out.add(up);
    };
    const walk = (text, start, depth) => {
        let here = start;
        const { commands, nested } = splitShell(pwsh ? String(text).replace(/\\/g, '/') : text);
        for (const { words: raw } of commands) {
            if (['cd', 'pushd', 'set-location', 'sl', 'chdir'].includes(raw[0]?.toLowerCase())) {
                here = raw.length === 2 ? madePath(raw[1], here) ?? null : null;
                continue;
            }
            const { words } = unwrap(raw);
            const name = programOf(words[0] ?? '');
            const args = words.slice(1);
            if (SHELLS.has(name) && args.includes('-c') && depth < MAX_DEPTH) {
                walk(args[args.indexOf('-c') + 1] ?? '', here, depth + 1);
            } else if (name === 'mkdir' && !pwsh) {
                let parents = false;
                const dirs = [];
                for (let i = 0; i < args.length; i++) {
                    const a = args[i];
                    if (a === '-m' || a === '--mode') { i++; continue; }
                    if (/^--(parents)$/.test(a) || /^-[a-zA-Z]*p/.test(a)) parents = true;
                    if (a.startsWith('-') && a !== '-') continue;
                    dirs.push(a);
                }
                for (const d of dirs) add(d, here, parents);
            } else if (pwsh && ['mkdir', 'md', 'new-item', 'ni'].includes(name)) {
                const lower = args.map((a) => a.toLowerCase());
                const type = lower.findIndex((a) => /^-(itemtype|type|it)$/.test(a));
                if ((name === 'new-item' || name === 'ni') && !(type >= 0 && /^(directory|dir)$/i.test(args[type + 1] ?? ''))) continue;
                const named = lower.findIndex((a) => /^-(path|literalpath|name)$/.test(a));
                const dirs = named >= 0 ? [args[named + 1]] : args.filter((a, i) => !a.startsWith('-') && !(i > 0 && /^-(itemtype|type|it|value)$/i.test(args[i - 1])));
                for (const d of dirs) if (typeof d === 'string') for (const one of d.split(',')) add(one.trim().replace(/^['"]|['"]$/g, ''), here, true);
            }
        }
        if (depth < MAX_DEPTH) for (const inner of nested) walk(inner, here, depth + 1);
    };
    try {
        walk(command, typeof cwd === 'string' && isAbsolute(cwd) ? cwd : null, 0);
    } catch {
        return [];
    }
    return [...out].slice(0, 50);
}

/** What code run as it is (DSH's run_code) deletes. */
export function codeDeletesOf(code, options = {}) {
    return codeDeletes(code, { depth: 0, cwd: options.cwd, read: options.read, vars: new Map() }, options.program ?? 'run_code');
}
