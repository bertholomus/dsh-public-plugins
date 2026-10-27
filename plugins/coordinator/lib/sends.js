/**
 * What a command sends outside the workspace, read before it runs: a web
 * request that does more than read (a method other than GET, HEAD or
 * OPTIONS, or a body), a push, a publish, a deploy or another change made
 * through a service's command-line tool, a command run or a file copied on
 * another machine, an email; a script or a task that does one of these,
 * known by its name or by what it runs; code given inline that posts. A
 * read (a GET, a clone, an install, a list or a view) is not a send.
 *
 * It reads a command line the way the shell would, closely enough for the
 * commands a model writes. It is a check against a well-meant mistake, not
 * a sandbox: a program it doesn't know, or a send inside a library the
 * command runs, goes through.
 *
 * A send that reaches only machines the user trusts (`trustedHosts`, such as
 * their own NAS) is left out: ssh, mosh or autossh to one, scp or rsync whose
 * other side is one, a web request to one. It counts every machine on the
 * way, a jump host or a proxy too, and one it can't tell is never trusted.
 *
 * @module dsh-plugin-coordinator/sends
 */
import { dirname, isAbsolute, resolve } from 'node:path';

/** How deep scripts that run scripts are followed. */
const MAX_DEPTH = 3;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'CONNECT']);

// ── Reading a command line ────────────────────────────────────────────────

/**
 * The index of the `)` that closes the `(` at `open`, quotes and nesting
 * kept; the end of the text when none does. A here-document's body is text,
 * so an apostrophe in it opens no quote. A quote that nothing closes is
 * read as a plain character.
 */
function closeParen(s, open) {
    let depth = 0;
    // In `$((…))`, `<<` shifts.
    const docs = s[open + 1] === '(' ? null : [];
    for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') { i++; continue; }
        if (c === '\n' && docs?.length > 0) { i = bodiesAt(s, i + 1, docs.splice(0)).end - 1; continue; }
        if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && docs) {
            const doc = heredocAt(s, i + 2);
            if (doc) { docs.push(doc); i = doc.end - 1; continue; }
        }
        if (c === '#' && /[\s;(|&]/.test(s[i - 1] ?? ' ')) { const end = s.indexOf('\n', i); i = (end < 0 ? s.length : end) - 1; continue; }
        if (c === "'") { const end = s.indexOf("'", i + 1); if (end >= 0) i = end; continue; }
        if (c === '"') { const end = closeDouble(s, i + 1); if (end < s.length) i = end; continue; }
        if (c === '`') { i = closeBacktick(s, i + 1); continue; }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return i;
    }
    return s.length;
}

/** The here-document `<<WORD` or `<<-WORD` names after `at`: its delimiter with quotes taken off, whether tabs are stripped, and where the word ends. */
function heredocAt(s, at) {
    let i = at;
    const strip = s[i] === '-';
    if (strip) i++;
    while (s[i] === ' ' || s[i] === '\t') i++;
    let delim = '';
    while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
        const c = s[i];
        if (c === "'" || c === '"') {
            const end = s.indexOf(c, i + 1);
            if (end < 0) return null;
            delim += s.slice(i + 1, end);
            i = end + 1;
        } else if (c === '\\') {
            delim += s[i + 1] ?? '';
            i += 2;
        } else {
            delim += c;
            i++;
        }
    }
    return delim === '' ? null : { delim, strip, end: i };
}

/** The bodies of here-documents, which start on the line at `at`: each one's lines up to its delimiter, and where the last one ends. */
function bodiesAt(s, at, docs) {
    let i = at;
    const bodies = [];
    for (const doc of docs) {
        const lines = [];
        while (i < s.length) {
            const end = s.indexOf('\n', i);
            const line = s.slice(i, end < 0 ? s.length : end);
            i = end < 0 ? s.length : end + 1;
            // `<<-` takes the tabs off each line, the last one's too.
            const bare = doc.strip ? line.replace(/^\t+/, '') : line;
            if (bare === doc.delim) break;
            lines.push(bare);
        }
        bodies.push(lines.join('\n'));
    }
    return { bodies, end: i };
}

/** The index of the `"` that closes a double-quoted text starting at `from`. */
function closeDouble(s, from) {
    for (let i = from; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') { i++; continue; }
        if (c === '"') return i;
        if (c === '$' && s[i + 1] === '(') { i = closeParen(s, i + 1); continue; }
        if (c === '`') i = closeBacktick(s, i + 1);
    }
    return s.length;
}

function closeBacktick(s, from) {
    for (let i = from; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '`') return i;
    }
    return s.length;
}

function closeBrace(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) return i;
    }
    return s.length;
}

/**
 * A command line in simple commands, as bash splits it: each with its
 * words (quotes taken off), the here-documents and here-strings it reads,
 * and whether its output goes on to the next one (`|`). `$(…)`, backquotes
 * and `<(…)` are command lines of their own (`nested`).
 * @returns {{commands: {words: string[], inputs: string[], pipe: boolean}[], nested: string[]}}
 */
export function splitShell(text) {
    const s = String(text ?? '');
    const commands = [];
    const nested = [];
    let words = [];
    let inputs = [];
    let word = null;
    let redirect = null;
    let strip = false;
    let pending = [];
    const add = (part) => { word = (word ?? '') + part; };
    const endWord = () => {
        if (word === null) return;
        const done = word;
        word = null;
        if (redirect === 'heredoc') pending.push({ delim: done, strip, into: inputs });
        else if (redirect === 'here') inputs.push(done);
        else if (redirect !== 'target') words.push(done);
        redirect = null;
    };
    const endCommand = (pipe) => {
        endWord();
        if (words.length > 0 || inputs.length > 0) commands.push({ words, inputs, pipe });
        words = [];
        inputs = [];
    };
    // Here-documents start on the line after the one that names them.
    const readBodies = (at) => {
        const { bodies, end } = bodiesAt(s, at, pending);
        pending.forEach((doc, k) => doc.into.push(bodies[k]));
        pending = [];
        return end;
    };
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        const next = s[i + 1];
        if (c === '\\') {
            if (next !== '\n' && i + 1 < s.length) add(next);
            i += 2;
        } else if (c === "'" || (c === '"' && closeDouble(s, i + 1) >= s.length)) {
            // A quote that nothing closes is a plain character, so what follows it is still read.
            const end = c === "'" ? s.indexOf("'", i + 1) : -1;
            add(end < 0 ? c : s.slice(i + 1, end));
            i = end < 0 ? i + 1 : end + 1;
        } else if (c === '"') {
            const end = closeDouble(s, i + 1);
            const inner = s.slice(i + 1, end);
            for (let k = 0; k < inner.length; k++) {
                if (inner[k] === '$' && inner[k + 1] === '(' && inner[k + 2] !== '(') {
                    const close = closeParen(inner, k + 1);
                    nested.push(inner.slice(k + 2, close));
                    k = close;
                } else if (inner[k] === '`') {
                    const close = closeBacktick(inner, k + 1);
                    nested.push(inner.slice(k + 1, close));
                    k = close;
                }
            }
            add(inner.replace(/\\(["\\$`])/g, '$1'));
            i = end + 1;
        } else if (c === '$' && next === "'") {
            let k = i + 2;
            let text = '';
            for (; k < s.length && s[k] !== "'"; k++) {
                if (s[k] === '\\' && k + 1 < s.length) { k++; text += ({ n: '\n', t: '\t' })[s[k]] ?? s[k]; } else text += s[k];
            }
            add(text);
            i = k + 1;
        } else if (c === '$' && next === '(') {
            const close = closeParen(s, i + 1);
            if (s[i + 2] !== '(') nested.push(s.slice(i + 2, close));
            add(s.slice(i, close + 1));
            i = close + 1;
        } else if (c === '$' && next === '{') {
            const close = closeBrace(s, i + 1);
            add(s.slice(i, close + 1));
            i = close + 1;
        } else if (c === '`') {
            const close = closeBacktick(s, i + 1);
            nested.push(s.slice(i + 1, close));
            add(s.slice(i, close + 1));
            i = close + 1;
        } else if ((c === '<' || c === '>') && next === '(') {
            const close = closeParen(s, i + 1);
            nested.push(s.slice(i + 2, close));
            add(s.slice(i, close + 1));
            i = close + 1;
        } else if (c === '#' && word === null) {
            const end = s.indexOf('\n', i);
            i = end < 0 ? s.length : end;
        } else if (c === ' ' || c === '\t' || c === '\r') {
            endWord();
            i++;
        } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
            // A file descriptor's number before the operator is no word.
            if (word !== null && /^\d+$/.test(word)) word = null;
            else endWord();
            const op = ['<<<', '<<-', '&>>', '<<', '&>', '>>', '>&', '<&', '>|', '<>'].find((o) => s.startsWith(o, i)) ?? c;
            i += op.length;
            redirect = op === '<<<' ? 'here' : op.startsWith('<<') ? 'heredoc' : 'target';
            strip = op === '<<-';
        } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
            const op = ['&&', '||', '|&', ';;'].find((o) => s.startsWith(o, i)) ?? c;
            endCommand(op === '|' || op === '|&');
            i += op.length;
            if (c === '\n' && pending.length > 0) i = readBodies(i);
        } else {
            add(c);
            i++;
        }
    }
    endCommand(false);
    if (pending.length > 0) readBodies(s.length);
    return { commands, nested };
}

/** What a backtick stands for in PowerShell text: `` `n `` is a newline, and any other character stands for itself. */
const PWSH_ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };

/**
 * Where PowerShell text that runs nothing itself ends: a quoted string (a
 * doubled quote inside is a quote, and in `"…"` a backtick escapes), a
 * here-string (`@"` to a line that starts with `"@`) or a block comment.
 * `i` is its first character; -1 when none starts there or nothing closes it.
 */
function pwshTextEnd(s, i) {
    const c = s[i];
    if (c === '@' && (s[i + 1] === '"' || s[i + 1] === "'") && /^[ \t]*\r?\n/.test(s.slice(i + 2, i + 66))) {
        const close = s.indexOf(`\n${s[i + 1]}@`, i + 2);
        return close < 0 ? -1 : close + 2;
    }
    if (c === "'" || c === '"') {
        for (let k = i + 1; k < s.length; k++) {
            if (c === '"' && s[k] === '`') k++;
            else if (c === '"' && s[k] === '$' && s[k + 1] === '(') k = pwshClose(s, k + 1);
            else if (s[k] === c && s[k + 1] === c) k++;
            else if (s[k] === c) return k;
        }
        return -1;
    }
    if (c === '<' && s[i + 1] === '#') {
        const close = s.indexOf('#>', i + 2);
        return close < 0 ? s.length - 1 : close + 1;
    }
    return -1;
}

const PWSH_PAIRS = { '(': ')', '{': '}', '[': ']' };

/** The index of the bracket that closes the `(`, `{` or `[` at `open` in PowerShell text; the end of the text when none does. */
function pwshClose(s, open) {
    const want = [];
    for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (c === '`') { i++; continue; }
        const textEnd = pwshTextEnd(s, i);
        if (textEnd >= 0) { i = textEnd; continue; }
        if (c === '#' && /[\s;({|]/.test(s[i - 1] ?? ' ')) {
            const end = s.indexOf('\n', i);
            i = (end < 0 ? s.length : end) - 1;
            continue;
        }
        const close = PWSH_PAIRS[c];
        if (close) want.push(close);
        else if ((c === ')' || c === '}' || c === ']') && want.length > 0) {
            want.pop();
            if (want.length === 0) return i;
        }
    }
    return s.length;
}

/**
 * A PowerShell command line in statements, as PowerShell splits it: each
 * with its words (quotes taken off, and a group `( )`, `$( )` or `@( )`, a
 * hashtable `@{ }`, a script block `{ }` or a type `[ ]` kept whole as one
 * word), the character each word starts with in the text (`marks`: a quote
 * or a `$` makes an expression of a statement), its text with what the
 * groups hold blanked (`code`), and whether its output goes on to the next
 * one (`|`). A backtick at a line's end goes on to the next line, `\` is a
 * path's own, and `$x=1` is `$x = 1`. What a group, a script block or a
 * string's `$( )` runs is split too, into statements of their own that come
 * before the one they are in; a hashtable's `Key = value` lines are marked
 * `table`.
 * @returns {{words: string[], marks: string[], code: string, pipe: boolean, table: boolean}[]}
 */
function splitPwsh(text, out = [], table = false) {
    const s = String(text ?? '');
    const blanks = [];
    const mine = [];
    let words = [];
    let marks = [];
    let word = null;
    let mark = '';
    let from = -1;
    let redirect = false;
    const add = (part, at) => {
        if (from < 0) from = at;
        if (word === null) mark = s[at];
        word = (word ?? '') + part;
    };
    const endWord = () => {
        if (word === null) return;
        if (!redirect) {
            words.push(word);
            marks.push(mark);
        }
        redirect = false;
        word = null;
    };
    const end = (at, pipe) => {
        endWord();
        if (words.length > 0) {
            const statement = { words, marks, code: '', pipe, table, from, to: at };
            mine.push(statement);
            out.push(statement);
        }
        words = [];
        marks = [];
        from = -1;
        redirect = false;
    };
    // What a group runs is split first; the group stays one word of this statement, blanked in its code.
    const inside = (at, close, isTable = false) => {
        splitPwsh(s.slice(at, close), out, isTable);
        blanks.push([at, close]);
    };
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        const next = s[i + 1];
        const textEnd = c === '#' ? -1 : pwshTextEnd(s, i);
        if (c === '`') {
            if (next === '\n' || (next === '\r' && s[i + 2] === '\n')) {
                endWord();
                i += next === '\r' ? 3 : 2;
            } else {
                if (i + 1 < s.length) add(PWSH_ESCAPES[next] ?? next, i);
                i += 2;
            }
        } else if (textEnd >= 0 && c === '<') {
            i = textEnd + 1;
        } else if (textEnd >= 0) {
            // A string: what its `$( )` runs is read, and its quotes and escapes are taken off.
            const here = c === '@';
            const quote = here ? next : c;
            const start = here ? s.indexOf('\n', i) + 1 : i + 1;
            const stop = here ? textEnd - 2 : textEnd;
            if (quote === '"') {
                for (let k = start; k < stop; k++) {
                    if (s[k] === '`') k++;
                    else if (s[k] === '$' && s[k + 1] === '(') {
                        const close = pwshClose(s, k + 1);
                        inside(k + 2, close);
                        k = close;
                    }
                }
            }
            const body = s.slice(start, stop).replace(/\r$/, '');
            add(quote === "'" ? (here ? body : body.replace(/''/g, "'"))
                : body.replace(here ? /`(.)/gs : /`(.)|""/gs, (m, x) => (x === undefined ? '"' : PWSH_ESCAPES[x] ?? x)), i);
            i = textEnd + 1;
        } else if (((c === '$' || c === '@') && next === '(') || (c === '@' && next === '{')) {
            const close = pwshClose(s, i + 1);
            inside(i + 2, close, next === '{');
            add(s.slice(i, close + 1), i);
            i = close + 1;
            if (next === '{') endWord();
        } else if (c === '$' && next === '{') {
            // `${env:PATH}`: a variable.
            const close = s.indexOf('}', i);
            const stop = close < 0 ? s.length : close + 1;
            add(s.slice(i, stop), i);
            i = stop;
        } else if (c === '(' || c === '{' || c === '[') {
            // A keyword's or a command's own name ends before its group: `if($x){…}`, `ForEach-Object{…}`.
            if (c !== '[' && /^[A-Za-z][\w-]*$/.test(word ?? '')) endWord();
            const close = pwshClose(s, i);
            if (c !== '[') inside(i + 1, close);
            add(s.slice(i, close + 1), i);
            i = close + 1;
            if (c === '{') endWord();
        } else if (c === '#' && word === null) {
            const stop = s.indexOf('\n', i);
            i = stop < 0 ? s.length : stop;
        } else if (c === ' ' || c === '\t' || c === '\r' || c === '\u00a0') {
            endWord();
            i++;
        } else if (c === '>' || ((c === '*' || (c >= '0' && c <= '9')) && word === null && next === '>')) {
            // Where output goes (`> out.txt`, `2>&1`, `*> $null`): no word.
            endWord();
            let k = c === '>' ? i + 1 : i + 2;
            if (s[k] === '>') k++;
            if (s[k] === '&' && /\d/.test(s[k + 1] ?? '')) k += 2;
            else redirect = true;
            i = k;
        } else if (c === '\n' || c === ';') {
            end(i, false);
            i++;
        } else if (c === '|') {
            end(i, next !== '|');
            i += next === '|' ? 2 : 1;
        } else if (c === '&' && next !== '&' && word === null && words.length === 0) {
            // The call operator, a word of its own: `& .\build.ps1`.
            add('&', i);
            endWord();
            i++;
        } else if (c === '&') {
            // `&&`, or a job's `&`.
            end(i, false);
            i += next === '&' ? 2 : 1;
        } else if (c === '=' && /^(?:\[[^\]]*\])*\$[^\s=]+$/.test(word ?? '')) {
            // An assignment written without spaces: `$x=1`, `$n+=1`.
            const [, target, op] = /^(.+?)((?:[-+*/%]|\?\?)?)$/s.exec(word);
            word = target;
            endWord();
            add(`${op}=`, i);
            endWord();
            i++;
        } else {
            add(c, i);
            i++;
        }
    }
    end(s.length, false);
    const bare = s.split('');
    for (const [at, close] of blanks) for (let k = at; k < close; k++) if (bare[k] !== '\n') bare[k] = ' ';
    const code = bare.join('');
    for (const statement of mine) {
        statement.code = code.slice(statement.from, statement.to);
        delete statement.from;
        delete statement.to;
    }
    return out;
}

/** A program's name as its path ends: `/usr/bin/curl`, `C:\tools\curl.exe` and `curl.exe` are `curl`. */
function programOf(word) {
    return String(word ?? '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** Its own words, where a scope or a version doesn't name the program: `@vercel/cli@1` is `vercel`. */
const PACKAGE_BINS = {
    'netlify-cli': 'netlify', 'firebase-tools': 'firebase', 'aws-cdk': 'cdk', 'cdktf-cli': 'cdktf', '@railway/cli': 'railway', '@vercel/cli': 'vercel',
    '@changesets/cli': 'changeset', '@vscode/vsce': 'vsce', '@cloudflare/wrangler': 'wrangler', 'serverless': 'serverless', '@nestjs/cli': 'nest',
};
function packageBin(spec) {
    const plain = String(spec).replace(/^(@[^/@]+\/[^@]+|[^@]+)@.*$/, '$1');
    return PACKAGE_BINS[plain] ?? programOf(plain.replace(/^@[^/]+\//, ''));
}

/**
 * Options before a command's own words: `takes` names the options whose
 * value is the next word (a set of short letters and long names).
 * @returns the index of the first word that is no option.
 */
function skipOptions(args, takes, from = 0) {
    let i = from;
    while (i < args.length) {
        const a = args[i];
        if (a === '--') return i + 1;
        if (!a.startsWith('-') || a === '-') return i;
        if (a.startsWith('--')) {
            i += !a.includes('=') && takes.has(a) ? 2 : 1;
            continue;
        }
        // Short options together: one that takes a value takes the rest of the word, or the next word.
        let k = 1;
        for (; k < a.length; k++) if (takes.has(a[k])) break;
        i += k < a.length && k === a.length - 1 ? 2 : 1;
    }
    return i;
}

/** The words that aren't options, values of `takes` skipped. */
function positionals(args, takes = new Set()) {
    const out = [];
    let i = 0;
    while (i < args.length) {
        const a = args[i];
        if (a === '--') { out.push(...args.slice(i + 1)); break; }
        if (a.startsWith('-') && a !== '-') {
            if (a.startsWith('--')) i += !a.includes('=') && takes.has(a) ? 2 : 1;
            else {
                let k = 1;
                for (; k < a.length; k++) if (takes.has(a[k])) break;
                i += k < a.length && k === a.length - 1 ? 2 : 1;
            }
            continue;
        }
        out.push(a);
        i++;
    }
    return out;
}

/** An option's value: `--name=value`, `--name value`, `-Xvalue` or `-X value`. */
function optionValue(args, names) {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') break;
        for (const name of names) {
            if (a === name) return args[i + 1] ?? '';
            if (name.startsWith('--') && a.startsWith(`${name}=`)) return a.slice(name.length + 1);
            if (!name.startsWith('--') && name.length === 2 && a.startsWith(name) && a.length > 2 && !a.startsWith('--')) return a.slice(2);
        }
    }
    return undefined;
}

const has = (args, ...names) => args.some((a) => names.includes(a) || names.some((n) => n.startsWith('--') && a.startsWith(`${n}=`)));
const dryRun = (args) => args.some((a) => a === '--dry-run' || a.startsWith('--dry-run=') || a === '--dryrun');
/** A one-letter option, alone or with others: `-n`, `-avzn`. */
const hasShort = (args, letter) => args.some((a) => !a.startsWith('--') && new RegExp(`^-[a-zA-Z]*${letter}[a-zA-Z]*$`).test(a));

// Commands that only run the command after them.
const WRAP = {
    sudo: new Set(['u', 'g', 'h', 'p', 'C', 'D', 'r', 't', 'T', 'U', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user']),
    doas: new Set(['u', 'C']),
    command: new Set(), builtin: new Set(), exec: new Set(['a']), nohup: new Set(), setsid: new Set(), unbuffer: new Set(), chronic: new Set(),
    time: new Set(['f', 'o', '--format', '--output']), nice: new Set(['n', '--adjustment']), ionice: new Set(['c', 'n', 'p', '--class', '--classdata']),
    stdbuf: new Set(['i', 'o', 'e', '--input', '--output', '--error']), caffeinate: new Set(['t', 'w']),
    strace: new Set(['e', 'o', 'p', 's', 'u', 'E', 'a', 'b', 'I', 'O', 'P', 'S', 'X']), ltrace: new Set(['e', 'o', 'p', 's', 'u', 'n', 'a']),
    torsocks: new Set(['u', 'p', 'a', 'P']), proxychains: new Set(['f']), proxychains4: new Set(['f']), tsocks: new Set(),
    xargs: new Set(['I', 'n', 'P', 'L', 's', 'd', 'E', 'a', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--eof', '--arg-file', '--replace']),
    'aws-vault': null, op: null, doppler: null, infisical: null, dotenv: null, chamber: null, direnv: null, envchain: null, teller: null,
};

/** Runners whose command follows `--`, or a fixed number of words: `aws-vault exec PROFILE -- cmd`, `op run -- cmd`. */
function afterRunner(name, args) {
    const dash = args.indexOf('--');
    if (dash >= 0) return args.slice(dash + 1);
    if (name === 'aws-vault' && args[0] === 'exec') return args.slice(skipOptions(args, new Set(['d', '--duration', '--region', '--mfa-token']), 1) + 1);
    if (name === 'direnv' && args[0] === 'exec') return args.slice(2);
    if (name === 'chamber' && args[0] === 'exec') return args.slice(2);
    if (name === 'envchain') return args.slice(skipOptions(args, new Set()) + 1);
    return [];
}

/**
 * The command a line runs once what only wraps it is taken off: `sudo env X=1 timeout 5 curl …` runs curl.
 * @param {Map<string, string|null>} [assigned] - gets the variables set for it (`X=1 cmd`, `env X=1 cmd`; null: `env -u X`).
 * @param {string[]} [wraps] - gets the names of the WRAP commands taken off (`sudo`, `xargs`).
 */
function commandOf(words, assigned, wraps) {
    let w = words;
    for (let guard = 0; guard < 16 && w.length > 0; guard++) {
        const first = w[0];
        if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(first)) { setFrom(assigned, first); w = w.slice(1); continue; }
        if (['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'coproc', 'fi', 'done', 'esac'].includes(first)) { w = w.slice(1); continue; }
        if (['for', 'case', 'select', 'function', 'in'].includes(first)) return [];
        const name = programOf(first);
        // cross-env sets them the same way, on any system: `cross-env NODE_ENV=production npm publish`.
        if (name === 'env' || name === 'cross-env') {
            const args = w.slice(1);
            let i = 0;
            while (i < args.length) {
                const a = args[i];
                if (a === '--') { i++; break; }
                if (a === '-S' || a === '--split-string') return [...splitWords(args[i + 1] ?? ''), ...args.slice(i + 2)];
                if (a.startsWith('--split-string=')) return [...splitWords(a.slice(15)), ...args.slice(i + 1)];
                if (a === '-u' || a === '--unset') assigned?.set(args[i + 1], null);
                if (a === '-u' || a === '-C' || a === '--unset' || a === '--chdir') { i += 2; continue; }
                if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) setFrom(assigned, a);
                if (a.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { i++; continue; }
                break;
            }
            w = args.slice(i);
            continue;
        }
        if (name === 'timeout') {
            const args = w.slice(1);
            const at = skipOptions(args, new Set(['s', 'k', '--signal', '--kill-after']));
            w = args.slice(at + 1);
            continue;
        }
        if (name === 'flock') {
            const args = w.slice(1);
            const at = skipOptions(args, new Set(['w', 'E', '--timeout', '--conflict-exit-code']));
            const c = optionValue(args, ['-c', '--command']);
            if (c !== undefined) return splitWords(c);
            w = args.slice(at + 1);
            continue;
        }
        if (name === 'watch') {
            const args = w.slice(1);
            w = args.slice(skipOptions(args, new Set(['n', 'q', '--interval', '--equexit', '--differences'])));
            if (w.length === 1) w = splitWords(w[0]);
            continue;
        }
        if (!(name in WRAP)) break;
        wraps?.push(name);
        const args = w.slice(1);
        if (WRAP[name] === null) {
            w = afterRunner(name, args);
            continue;
        }
        if (name === 'command' && (args.includes('-v') || args.includes('-V'))) return [];
        w = args.slice(skipOptions(args, WRAP[name]));
    }
    return w;
}

/** `NAME=value` (or `NAME+=more`) into a map of variables; a name that holds a secret, or a value that isn't known, is left out. */
function setFrom(vars, word) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=(.*)$/s.exec(word);
    if (!vars || !m) return;
    if (m[2] === '' || vars.get(m[1])) vars.set(m[1], m[2] === '' ? m[3] : vars.get(m[1]) + m[3]);
    else vars.delete(m[1]);
}

/** A variable whose value is a password, a key or a token: it is never filled in, so its value is shown nowhere. */
const SECRET_NAME = /TOKEN|SECRET|PASS|PWD|KEY|CRED|AUTH|COOKIE|SESSION|SIGN|PRIVATE|BEARER/i;

/**
 * A word with the variables it names filled in where their values are known
 * (`$X`, `${X}`, `${X:-default}`), so the prompt names the place a command
 * really sends to; the others stay as they are.
 */
function expand(word, vars) {
    if (!word.includes('$') || !vars || vars.size === 0 && !word.includes('${')) return word;
    return word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-=])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced, op, fallback, bare) => {
        const name = braced ?? bare;
        if (SECRET_NAME.test(name)) return m;
        const value = vars.get(name);
        if (op === undefined) return typeof value === 'string' ? value : m;
        // `${X:-default}`: the default when X is unset or (with the colon) empty.
        return typeof value === 'string' && !(op.startsWith(':') && value === '') ? value : expand(fallback, vars);
    });
}

/** A string's words as the shell would split it, quotes taken off. */
function splitWords(text) {
    return splitShell(text).commands.flatMap((c) => c.words);
}

// ── What each program sends ───────────────────────────────────────────────

/** Where a URL points, short: host, port and path, without its scheme, user or query. */
export function placeOf(url) {
    const s = String(url ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '').replace(/[?#].*$/, '');
    return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/** Text with the user and password taken out of each URL in it: `https://bot:TOKEN@host/x` reads `https://host/x`. */
export function withoutCredentials(text) {
    return String(text ?? '').replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1');
}

const looksLikeUrl = (a) => /^(https?|ftps?|sftp|scp|smtps?|wss?|tftp|dict|ldaps?|telnet|mqtt|gopher):\/\//i.test(a) || /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/|$)/i.test(a);

/** A host name or an IP address, as a machine is written (an IPv6 one with its zone). */
const HOST_NAME = /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/;
const IPV6 = /^[0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*(?:%[\w.-]+)?$/;

/**
 * The machine in `host`, `host:port`, `host:path`, `[v6]:port` or a bare IPv6
 * address, in lower case; '' for anything that isn't a plain name or address
 * (a variable, a pattern, a quote), which is never a machine the user trusts.
 */
function machine(text) {
    const s = String(text ?? '').toLowerCase();
    const bracketed = /^\[([^\]]*)\](?::.*)?$/s.exec(s);
    if (bracketed) return IPV6.test(bracketed[1]) ? bracketed[1] : '';
    if (IPV6.test(s)) return s;
    const name = s.replace(/:.*$/s, '');
    return HOST_NAME.test(name) ? name : '';
}

/** The machine a URL reaches, read as curl reads one (`http://` when it names no scheme): its host, without a user or a port. */
function urlHost(url) {
    const authority = String(url ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/s, '');
    // A character no URL's authority has (a backslash, a space, a `{` of curl's lists) leaves where it goes to the program.
    return /^[\w.~%!$&'()*+,;=:@[\]-]*$/.test(authority) ? machine(authority.slice(authority.lastIndexOf('@') + 1)) : '';
}

/**
 * The machine ssh reaches for a destination: `[user@]host`, or an `ssh://`
 * URL. A trustedHosts entry is read the same way, so `me@nas`,
 * `NAS:22` and `[fd7a::1]` name `nas` and `fd7a::1`.
 */
export function hostOf(place) {
    const s = String(place ?? '').trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? urlHost(s) : machine(s.slice(s.lastIndexOf('@') + 1));
}

/** The machine of a place on another machine, as scp and rsync read it: `[user@]host:path`, `host::module`, or a URL. */
function pathHost(place) {
    const s = String(place ?? '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return urlHost(s);
    // The machine ends at the first `:` outside brackets, and its user at the last `@` before that.
    const m = /^(?:[^:[/]*@)?(\[[^\]/]*\]|[^:/]*):/.exec(s);
    return m ? machine(m[1]) : '';
}

/**
 * The machines a send reaches, kept on it only when every one is known and
 * nothing around the command sends it elsewhere (ctx.unrouted): a send
 * without them is never a trusted one.
 */
const reaching = (hosts, ctx) => (!ctx?.unrouted && Array.isArray(hosts) && hosts.length > 0 && hosts.every((h) => h !== '') ? { hosts: [...new Set(hosts)] } : {});

/**
 * A command's options and its other words, as getopt reads them: short ones
 * together (`-avz`), one in `takes` taking the rest of its word or the next
 * word, long ones as `--name=value` or, in `takes`, `--name value`.
 * `more(n)` says whether options still come once n other words have (getopt
 * stops at the first; ssh reads them again after its destination).
 * @returns {{options: [string, string|undefined][], words: string[]}}
 */
function optionsOf(args, takes, more = () => true) {
    const options = [];
    const words = [];
    for (let i = 0; i < args.length; i++) {
        const a = String(args[i]);
        if (!more(words.length)) { words.push(a); continue; }
        if (a === '--') { words.push(...args.slice(i + 1)); break; }
        if (!a.startsWith('-') || a === '-') { words.push(a); continue; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = eq > 0 ? a.slice(0, eq) : a;
            options.push([name, eq > 0 ? a.slice(eq + 1) : takes.has(name) ? args[++i] : undefined]);
            continue;
        }
        for (let k = 1; k < a.length; k++) {
            if (!takes.has(a[k])) { options.push([`-${a[k]}`, undefined]); continue; }
            options.push([`-${a[k]}`, k + 1 < a.length ? a.slice(k + 1) : args[++i]]);
            break;
        }
    }
    return { options, words };
}

/** A long option that only starts one of `names` (`--prox` for `--proxy`): a program that takes a shortened name reads it as that one. */
const shortens = (option, names) => option.startsWith('--') && option.length > 2 && !names.includes(option) && names.some((name) => name.startsWith(option));

/** Variables that point a web client at a config file of their own, where a proxy or more URLs can be. */
const CONFIG_VARS = /^(?:home|xdg_config_home|curl_home|wgetrc|system_wgetrc|httpie_config_dir|xh_config_dir)$/i;

/**
 * The machines a web request reaches: its URLs', its proxies' (`-x`, and
 * the ones the command line sets in variables, `HTTPS_PROXY=… curl …`);
 * null when they can't be told (`unsure`: an option that sends it elsewhere
 * or reads more from a file).
 */
function webHosts(urls, proxies, unsure, ctx) {
    const env = [...(ctx?.env ?? [])];
    if (unsure || env.some(([name]) => CONFIG_VARS.test(name))) return null;
    const inEnv = env.filter(([name, value]) => /^(?:https?|all|ftp)_proxy$/i.test(name) && value).map(([, value]) => value);
    return [...urls, ...proxies, ...inEnv].map(urlHost);
}

/** A web request; `hosts`, the machines it reaches (webHosts), or null when they can't be told. */
function request(method, url, program, hosts, ctx) {
    const where = placeOf(url);
    return { kind: 'request', program, what: `sends a ${method} to ${where || 'a server'} (${program})`, ...reaching(hosts, ctx) };
}

const CURL_TAKES = new Set([...'AbcCdDeEFHKmoPQrtTuUwxXyYz',
    '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--json', '--form', '--form-string', '--upload-file', '--request', '--header',
    '--proxy-header', '--output', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar', '--config', '--proxy', '--proxy-user', '--write-out',
    '--range', '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '--cert', '--cert-type', '--key', '--key-type', '--cacert',
    '--capath', '--crlfile', '--pinnedpubkey', '--continue-at', '--dump-header', '--resolve', '--connect-to', '--limit-rate', '--max-filesize', '--max-redirs',
    '--output-dir', '--interface', '--dns-servers', '--oauth2-bearer', '--aws-sigv4', '--variable', '--trace', '--trace-ascii', '--stderr', '--unix-socket',
    '--abstract-unix-socket', '--local-port', '--pass', '--proto', '--proto-redir', '--proto-default', '--mail-from', '--mail-rcpt', '--mail-auth', '--url',
    '--url-query', '--time-cond', '--tls-max', '--ciphers', '--curves', '--netrc-file', '--noproxy', '--preproxy', '--socks4', '--socks4a', '--socks5',
    '--socks5-hostname', '--login-options', '--service-name', '--telnet-option', '--keepalive-time', '--expect100-timeout', '--speed-limit', '--speed-time',
    '--rate', '--parallel-max', '--request-target', '--doh-url', '--etag-save', '--etag-compare', '--create-file-mode', '--ftp-port', '--ftp-method']);

/** curl's options that send through another machine: a proxy. */
const CURL_PROXIES = ['--proxy', '--preproxy', '--proxy1.0', '--socks4', '--socks4a', '--socks5', '--socks5-hostname'];
/** And the ones after which where it goes can't be told: its own names for hosts, a socket, options or URLs from a file. */
const CURL_ELSEWHERE = ['--resolve', '--connect-to', '--doh-url', '--dns-servers', '--unix-socket', '--abstract-unix-socket', '--config'];

function curl(args, ctx) {
    let method;
    let body = false;
    let upload = false;
    let head = false;
    let get = false;
    let mail = false;
    let url;
    // Every URL it is given, and its proxies, for the machines it reaches.
    const urls = [];
    const proxies = [];
    let unsure = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { url ??= args[i + 1]; urls.push(...args.slice(i + 1)); break; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = eq > 0 ? a.slice(0, eq) : a;
            const value = () => (eq > 0 ? a.slice(eq + 1) : args[++i]);
            if (name === '--request') method = value();
            else if (['--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--json', '--form', '--form-string'].includes(name)) { value(); body = true; }
            else if (name === '--upload-file') { value(); upload = true; }
            else if (name === '--head') head = true;
            else if (name === '--get') get = true;
            else if (name === '--mail-rcpt' || name === '--mail-from') { value(); mail = true; }
            else if (name === '--url') { const u = value(); url ??= u; urls.push(u); }
            else if (CURL_PROXIES.includes(name)) proxies.push(value());
            else if (CURL_ELSEWHERE.includes(name) || name.startsWith('--expand-') || shortens(name, [...CURL_PROXIES, ...CURL_ELSEWHERE])) {
                unsure = true;
                // `--expand-url` takes a value as `--url` does, its variables filled in.
                if (eq < 0 && CURL_TAKES.has(name.replace(/^--expand-/, '--'))) i++;
            } else if (eq < 0 && CURL_TAKES.has(name)) i++;
            continue;
        }
        if (a.startsWith('-') && a.length > 1) {
            for (let k = 1; k < a.length; k++) {
                const f = a[k];
                if (f === 'I') head = true;
                else if (f === 'G') get = true;
                if (!CURL_TAKES.has(f)) continue;
                const value = k + 1 < a.length ? a.slice(k + 1) : args[++i];
                if (f === 'X') method = value;
                else if (f === 'd' || f === 'F') body = true;
                else if (f === 'T') upload = true;
                else if (f === 'x') proxies.push(value);
                else if (f === 'K') unsure = true;
                break;
            }
            continue;
        }
        url ??= a;
        urls.push(a);
    }
    if (mail || /^smtps?:/i.test(url ?? '')) return mail || upload ? { kind: 'email', program: 'curl', what: 'sends email (curl)' } : null;
    const verb = method ? String(method).toUpperCase() : body ? (get ? 'GET' : 'POST') : upload ? 'PUT' : head ? 'HEAD' : 'GET';
    if (READ_METHODS.has(verb)) return null;
    // `--url @file` reads its URLs from the file.
    return request(verb, url, 'curl', webHosts(urls, proxies, unsure || urls.some((u) => String(u ?? '').startsWith('@')), ctx), ctx);
}

const WGET_TAKES = new Set([...'OoaiBtTwQPUelARDIX', '--output-document', '--output-file', '--append-output', '--input-file', '--base', '--tries', '--timeout',
    '--wait', '--quota', '--directory-prefix', '--user-agent', '--execute', '--level', '--accept', '--reject', '--domains', '--include-directories',
    '--exclude-directories', '--header', '--user', '--password', '--http-user', '--http-password', '--load-cookies', '--save-cookies', '--post-data',
    '--post-file', '--body-data', '--body-file', '--method', '--referer', '--ca-certificate', '--certificate', '--private-key', '--limit-rate']);

/** wget's options after which where it goes can't be told: URLs from a file, its own settings (a proxy), other hosts' links. */
const WGET_ELSEWHERE = ['--input-file', '--input-metalink', '--config', '--span-hosts'];

function wget(args, ctx) {
    const method = optionValue(args, ['--method']);
    const body = has(args, '--post-data', '--post-file', '--body-data', '--body-file');
    const verb = method ? method.toUpperCase() : body ? 'POST' : 'GET';
    if (READ_METHODS.has(verb)) return null;
    const urls = positionals(args, WGET_TAKES);
    const unsure = optionsOf(args, WGET_TAKES).options.some(([name, value]) => name === '-i' || name === '-H' || WGET_ELSEWHERE.includes(name)
        || shortens(name, [...WGET_ELSEWHERE, '--execute']) || ((name === '-e' || name === '--execute') && /proxy|input/i.test(value ?? '')));
    return request(verb, urls[0], 'wget', webHosts(urls, [], unsure, ctx), ctx);
}

const HTTPIE_TAKES = new Set([...'aAovs', '--auth', '--auth-type', '--output', '--verify', '--cert', '--cert-key', '--timeout', '--proxy', '--session',
    '--session-read-only', '--style', '--print', '--pretty', '--format-options', '--max-redirects', '--max-headers', '--boundary', '--raw', '--ssl', '--ciphers', '--default-scheme']);

/** HTTPie (`http`, `https`) and xh: `http [METHOD] URL [items]`; a data item makes it a POST. */
function httpie(args, program, ctx) {
    const pos = positionals(args, HTTPIE_TAKES);
    let at = 0;
    let method;
    if (pos.length > 1 && HTTP_METHODS.has(pos[0].toUpperCase()) && /^[A-Za-z]+$/.test(pos[0])) method = pos[at++].toUpperCase();
    const url = pos[at];
    const data = pos.slice(at + 1).some((item) => {
        const m = /(==|:=@|:=|=@|=|@|:)/.exec(item);
        return m !== null && m[1] !== '==' && m[1] !== ':';
    }) || has(args, '--raw') || has(args, '-f', '--form', '--multipart');
    const verb = method ?? (data ? 'POST' : 'GET');
    if (READ_METHODS.has(verb)) return null;
    // `:3000/x` is localhost's; a proxy is `--proxy=http:http://host:port`; xh has its own names for hosts and sockets.
    const options = optionsOf(args, HTTPIE_TAKES).options;
    const proxies = options.filter(([name]) => name === '--proxy').map(([, value]) => String(value ?? '').replace(/^[a-z]+:(?!\/\/)/i, ''));
    const unsure = options.some(([name]) => name === '--resolve' || name === '--unix-socket' || shortens(name, ['--proxy', '--resolve', '--unix-socket']));
    return request(verb, url, program, webHosts([String(url ?? '').startsWith(':') ? `localhost${url}` : url], proxies, unsure, ctx), ctx);
}

/** PowerShell's web cmdlets: `-Method Post`, or a body. */
function webCmdlet(args, program, ctx) {
    const lower = args.map((a) => a.toLowerCase());
    const valueOf = (name) => {
        const at = lower.findIndex((a) => a === name || a.startsWith(`${name}:`));
        if (at < 0) return undefined;
        return lower[at].includes(':') ? args[at].slice(args[at].indexOf(':') + 1) : args[at + 1];
    };
    const method = valueOf('-method');
    const body = ['-body', '-infile', '-form'].some((name) => valueOf(name) !== undefined);
    const verb = method ? method.toUpperCase() : body ? 'POST' : 'GET';
    if (READ_METHODS.has(verb)) return null;
    const url = valueOf('-uri') ?? args.find((a) => looksLikeUrl(a));
    const proxy = valueOf('-proxy');
    // `-UnixSocket` (PowerShell 7.4) sends to a socket here, not to the URL's host.
    return request(verb, url, program, webHosts([url], proxy === undefined ? [] : [proxy], lower.some((a) => a.startsWith('-un')), ctx), ctx);
}

const GIT_TAKES = new Set(['C', 'c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix', '--list-cmds']);

function git(args) {
    const at = skipOptions(args, GIT_TAKES);
    const sub = args[at];
    const rest = args.slice(at + 1);
    // `git subtree push --prefix dist origin gh-pages` pushes a folder's history.
    const subtree = sub === 'subtree' && rest[0] === 'push';
    if (sub === 'push' || subtree) {
        const words = subtree ? rest.slice(1) : rest;
        if (dryRun(words) || words.includes('-n')) return null;
        const remote = positionals(words, subtree ? new Set(['P', '--prefix', 'm', '--message']) : new Set(['o', '--push-option', '--repo', '--receive-pack', '--exec']))[0];
        // A remote given as a URL is shown as a place, so a token in it isn't.
        const where = remote === undefined ? 'its remote' : /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ? placeOf(remote) : remote;
        return { kind: 'push', program: 'git', what: `pushes to ${where} (git ${subtree ? 'subtree push' : 'push'})` };
    }
    if (sub === 'send-email') return { kind: 'email', program: 'git', what: 'sends patches by email (git send-email)' };
    if ((sub === 'svn' && rest[0] === 'dcommit') || (sub === 'lfs' && rest[0] === 'push')) return { kind: 'push', program: 'git', what: `pushes to its remote (git ${sub} ${rest[0]})` };
    return null;
}

/** What `gh` and `glab` change on the host, by command group. */
const FORGE_WRITES = {
    gh: {
        pr: ['create', 'merge', 'close', 'reopen', 'comment', 'edit', 'review', 'ready', 'lock', 'unlock', 'update-branch', 'revert'],
        issue: ['create', 'close', 'reopen', 'comment', 'edit', 'delete', 'transfer', 'pin', 'unpin', 'lock', 'unlock', 'develop'],
        release: ['create', 'delete', 'delete-asset', 'edit', 'upload'],
        repo: ['create', 'delete', 'edit', 'fork', 'rename', 'archive', 'unarchive', 'sync'],
        gist: ['create', 'edit', 'delete', 'rename'], label: ['create', 'edit', 'delete', 'clone'],
        secret: ['set', 'delete', 'remove'], variable: ['set', 'delete', 'remove'],
        workflow: ['run', 'enable', 'disable'], run: ['rerun', 'cancel', 'delete'], cache: ['delete'],
        codespace: ['create', 'delete', 'edit', 'stop', 'ssh', 'cp', 'rebuild'],
        project: ['create', 'delete', 'edit', 'close', 'copy', 'field-create', 'field-delete', 'item-add', 'item-archive', 'item-create', 'item-delete', 'item-edit', 'link', 'unlink', 'mark-template'],
        'ssh-key': ['add', 'delete'], 'gpg-key': ['add', 'delete'],
    },
    glab: {
        mr: ['create', 'merge', 'close', 'reopen', 'note', 'approve', 'revoke', 'update', 'delete', 'rebase', 'subscribe', 'unsubscribe', 'todo'],
        issue: ['create', 'close', 'reopen', 'note', 'delete', 'update', 'subscribe', 'unsubscribe'],
        release: ['create', 'delete', 'upload'], repo: ['create', 'delete', 'fork', 'archive', 'transfer', 'mirror'],
        ci: ['run', 'retry', 'cancel', 'delete', 'trigger'], variable: ['set', 'delete', 'update', 'import'],
        label: ['create', 'delete'], snippet: ['create'], schedule: ['create', 'delete', 'run'],
    },
};
const FORGE_HOST = { gh: 'GitHub', glab: 'GitLab', hub: 'GitHub' };

function forge(args, program) {
    const at = skipOptions(args, new Set(['R', '--repo', '--hostname']));
    const [group, verb, third] = args.slice(at);
    const where = FORGE_HOST[program];
    if (group === 'api') {
        const rest = args.slice(at + 1);
        const endpoint = positionals(rest, new Set(['X', 'f', 'F', 'H', 'q', 't', 'p', '--method', '--field', '--raw-field', '--header', '--input', '--jq', '--template', '--preview', '--hostname', '--cache']))[0] ?? '';
        if (endpoint === 'graphql') return rest.some((a) => /\bmutation\b/.test(a)) ? { kind: 'request', program, what: `makes a change on ${where} (${program} api graphql mutation)` } : null;
        const method = optionValue(rest, ['-X', '--method']);
        const fields = has(rest, '-f', '-F', '--field', '--raw-field', '--input') || rest.some((a) => /^-[fF]./.test(a));
        const verbOf = method ? method.toUpperCase() : fields ? 'POST' : 'GET';
        return READ_METHODS.has(verbOf) ? null : { kind: 'request', program, what: `sends a ${verbOf} to the ${where} API (${program} api ${endpoint.slice(0, 50)})` };
    }
    if (program === 'gh' && group === 'repo' && verb === 'deploy-key') return ['add', 'delete'].includes(third) ? { kind: 'request', program, what: `makes a change on ${where} (gh repo deploy-key ${third})` } : null;
    if (program === 'hub') {
        const writes = { 'pull-request': true, create: true, fork: true, delete: true, release: ['create', 'edit', 'delete'], issue: ['create', 'update', 'transfer'] };
        const w = writes[group];
        return w === true || (Array.isArray(w) && w.includes(verb)) ? { kind: 'request', program, what: `makes a change on GitHub (hub ${[group, Array.isArray(w) ? verb : ''].join(' ').trim()})` } : null;
    }
    return FORGE_WRITES[program]?.[group]?.includes(verb) ? { kind: 'request', program, what: `makes a change on ${where} (${program} ${group} ${verb})` } : null;
}

/**
 * Publishing and deploying tools, by subcommand: `true` for any use of it,
 * a list for the second word it needs, or a function of the words after it.
 */
const PUBLISH = {
    npm: { publish: true, unpublish: true, deprecate: true, undeprecate: true, 'dist-tag': ['add', 'rm', 'remove'], owner: ['add', 'rm', 'remove'], access: ['set', 'grant', 'revoke', 'public', 'restricted'], star: true, unstar: true },
    pnpm: { publish: true }, yarn: { publish: true, npm: ['publish'] }, bun: { publish: true },
    cargo: { publish: true, yank: true, owner: true }, twine: { upload: true, register: true }, poetry: { publish: true }, flit: { publish: true },
    hatch: { publish: true }, uv: { publish: true }, pdm: { publish: true }, gem: { push: true, yank: true, owner: true },
    dotnet: { nuget: ['push', 'delete'] }, pod: { trunk: ['push', 'delete', 'deprecate', 'add-owner', 'remove-owner'], repo: ['push'] },
    vsce: { publish: true, unpublish: true }, ovsx: { publish: true }, flutter: { pub: ['publish'] }, dart: { pub: ['publish'] },
    mix: { 'hex.publish': true, 'hex.retire': true, 'hex.owner': true }, swift: { 'package-registry': ['publish'] },
    changeset: { publish: true }, lerna: { publish: true }, eas: { submit: true, update: true },
};
const DEPLOY = {
    docker: {
        push: true, stack: ['deploy', 'rm', 'remove', 'up'], service: ['create', 'update', 'rm', 'remove', 'scale', 'rollback'], compose: ['push'],
        image: ['push'], manifest: ['push'], trust: ['sign'],
        build: (rest, args) => imagePush(args), buildx: (rest, args) => ['build', 'bake'].includes(rest[0]) && imagePush(args),
    },
    'docker-compose': { push: true },
    podman: { push: true, manifest: ['push'], build: (rest, args) => imagePush(args) }, buildah: { push: true, manifest: ['push'] },
    skopeo: { copy: true, delete: true, sync: true },
    crane: { push: true, copy: true, cp: true, delete: true, tag: true, append: true, mutate: true, rebase: true, flatten: true },
    oras: { push: true, attach: true, tag: true, copy: true, cp: true },
    helm: { install: true, upgrade: true, uninstall: true, delete: true, del: true, rollback: true, push: true, test: true },
    kubectl: { apply: true, create: true, delete: true, patch: true, replace: true, scale: true, autoscale: true, rollout: ['restart', 'undo', 'pause', 'resume'], set: true, edit: true, label: true, annotate: true, drain: true, cordon: true, uncordon: true, taint: true, expose: true, run: true, cp: true, exec: true, attach: true, certificate: true },
    terraform: { apply: true, destroy: true, import: true, taint: true, untaint: true, state: ['rm', 'mv', 'push', 'replace-provider'], 'force-unlock': true, workspace: ['new', 'delete'] },
    terragrunt: { apply: true, destroy: true, import: true, 'run-all': ['apply', 'destroy', 'import'], 'apply-all': true, 'destroy-all': true, run: ['apply', 'destroy'] },
    pulumi: { up: true, update: true, destroy: true, import: true, refresh: true, cancel: true, stack: ['rm'] },
    cdk: { deploy: true, destroy: true, bootstrap: true, import: true, watch: true }, cdktf: { deploy: true, destroy: true },
    sam: { deploy: true, delete: true, sync: true, publish: true, remote: ['invoke'] },
    serverless: { deploy: true, remove: true, rollback: true, invoke: (rest) => rest[0] !== 'local' },
    netlify: { deploy: true, 'sites:create': true, 'sites:delete': true, 'env:set': true, 'env:unset': true, 'env:import': true, 'functions:invoke': true },
    wrangler: {
        deploy: true, publish: true, delete: true, rollback: true, secret: ['put', 'delete', 'bulk'], 'kv:key': ['put', 'delete'], 'kv:bulk': ['put', 'delete'],
        kv: (rest) => ['put', 'delete'].includes(rest[1]) || (rest[0] === 'namespace' && ['create', 'delete'].includes(rest[1])),
        r2: (rest) => ['put', 'delete', 'create'].includes(rest[1]), d1: (rest, args) => args.includes('--remote') && ['execute', 'migrations'].includes(rest[0]),
        pages: ['deploy', 'publish'], versions: ['deploy', 'upload'], triggers: ['deploy'], queues: ['create', 'delete'],
    },
    railway: { up: true, deploy: true, down: true, delete: true, redeploy: true, variables: ['set', 'delete'] },
    eb: { deploy: true, create: true, terminate: true, setenv: true, scale: true, restart: true, swap: true, abort: true, upgrade: true },
    nomad: { run: true, stop: true, job: ['run', 'stop', 'dispatch', 'revert', 'scale', 'promote'], deployment: ['promote', 'fail', 'pause', 'resume', 'unblock'], alloc: ['stop', 'restart', 'exec', 'signal'] },
    supabase: { db: (rest, args) => rest[0] === 'push' || (rest[0] === 'reset' && args.includes('--linked')), functions: ['deploy', 'delete'], secrets: ['set', 'unset'], storage: ['cp', 'mv', 'rm'] },
    surge: () => true, 'gh-pages': () => true, np: () => true,
};
const ALIASES = { tofu: 'terraform', oc: 'kubectl', k: 'kubectl', sls: 'serverless', vc: 'vercel', flyctl: 'fly', ncat: 'nc', netcat: 'nc', 'release-it': 'releaseIt', mutt: 'mail', neomutt: 'mail', mailx: 'mail', 's-nail': 'mail' };

const KUBE_TAKES = new Set(['n', 's', '--namespace', '--context', '--kubeconfig', '--server', '--cluster', '--user', '--token', '--as', '--as-group', '--request-timeout', '--certificate-authority', '--client-certificate', '--client-key', '--kube-context', '--kube-token', '--kube-apiserver', '--repository-config', '--registry-config']);
const NPM_TAKES = new Set(['C', 'w', 'F', '--prefix', '--cwd', '--dir', '--directory', '--registry', '--tag', '--access', '--otp', '--workspace', '--userconfig', '--cache', '--loglevel', '--filter', '--scope']);
/** Per program, the options before a subcommand that take the next word as their value. */
const TAKES = {
    default: new Set(['C', '--prefix', '--cwd', '--dir', '--directory']),
    npm: NPM_TAKES, pnpm: NPM_TAKES, yarn: NPM_TAKES, bun: NPM_TAKES,
    kubectl: KUBE_TAKES, helm: KUBE_TAKES,
    terraform: new Set(['-chdir']), terragrunt: new Set(['-chdir', '--terragrunt-working-dir']),
    pulumi: new Set(['C', 's', '--cwd', '--stack']),
    docker: new Set(['c', 'H', 'l', 't', 'f', 'o', '--context', '--host', '--config', '--log-level', '--tlscacert', '--tlscert', '--tlskey', '--tag', '--file', '--platform',
        '--build-arg', '--target', '--output', '--cache-from', '--cache-to', '--label', '--secret', '--ssh', '--progress', '--network', '--builder', '--project-name', 'p']),
    'docker-compose': new Set(['f', 'p', 'H', '--file', '--project-name', '--project-directory', '--env-file', '--profile', '--host', '--context', '--log-level', '--ansi']),
    podman: new Set(['c', '--connection', '--url', '--root', '--runroot', '--log-level']),
    cargo: new Set(['C', 'Z', '--manifest-path', '--config', '--color']),
};
/** A build that pushes its image: `--push`, or an output of type registry. */
const imagePush = (args) => has(args, '--push') || args.some((a, i) => /type=registry/.test(a) && (a.startsWith('--output') || /^(-o|--output)$/.test(args[i - 1] ?? '')));

/** A tool from PUBLISH or DEPLOY: its subcommand (and the word after) decides. */
function table(entries, args, program, kind) {
    if (typeof entries === 'function') return entries(args) ? { kind, program, what: `${kind === 'publish' ? 'publishes' : 'deploys'} (${program})` } : null;
    const pos = positionals(args, TAKES[program] ?? TAKES.default);
    const sub = pos[0];
    const rule = sub !== undefined && Object.hasOwn(entries, sub) ? entries[sub] : undefined;
    const rest = pos.slice(1);
    const hit = rule === true || (Array.isArray(rule) && rule.includes(rest[0])) || (typeof rule === 'function' && rule(rest, args));
    if (!hit || dryRun(args)) return null;
    // An image's push says which image: `docker push ghcr.io/acme/web:1.4.2`.
    if (sub === 'push' && ['docker', 'podman', 'buildah'].includes(program) && rest[0] !== undefined) return { kind, program, what: `pushes ${rest[0]} (${program} push)` };
    const words = [program, sub, Array.isArray(rule) || (typeof rule === 'function' && /^[a-z][a-z0-9:-]*$/.test(rest[0] ?? '')) ? rest[0] : ''].join(' ').trim();
    if (kind === 'publish') return { kind, program, what: `publishes (${words})` };
    return { kind, program, what: `makes a change with ${program} (${words})` };
}

const CLOUD_VERBS = /^(create|delete|deploy|update|patch|set|add|remove|import|start|stop|restart|reset|resize|rollback|publish|submit|cancel|enable|disable|undelete|restore|attach|detach|apply|upload|ssh|scp|purge|invoke|send|assign|scale|swap|sync|execute|run|move|rename|promote|failover|revoke|grant|rotate|resume|suspend|reboot|terminate|destroy|associate|disassociate|register|deregister|tag|untag|up)([-_]|$)/;
/** Commands that only read. */
const CLOUD_READS = /^(list|describe|get|show|read|tail|wait|browse|check|search|print|explain|diff|validate|download)([-_]|$)/;
const CLOUD_READ_GROUPS = { gcloud: ['config', 'auth', 'components', 'info', 'help', 'topic', 'version', 'init', 'feedback', 'survey', 'cheat-sheet'], az: ['login', 'logout', 'account', 'config', 'extension', 'version', 'find', 'upgrade', 'interactive', 'init', 'cloud', 'feedback', 'survey'], doctl: ['auth', 'version', 'completion'] };

/**
 * gcloud, az and doctl: a command whose verb changes something, said with
 * what it changes (`gcloud run deploy api`, `az webapp up --name acme-web`).
 * The first word names a group, even one named like a verb, so the command
 * is the first verb after it: `gcloud run services list` and `gcloud deploy
 * releases list` read, and so does `gcloud functions describe send-email`.
 */
function cloud(args, program) {
    const all = positionals(args, new Set(['--project', '--region', '--zone', '--subscription', '--resource-group', 'g', '--output', 'o', '--format', '--query', '--account', '--configuration', '--context', 't', '--access-token']));
    // A release track comes before the group: `gcloud beta run deploy`.
    const pos = program === 'gcloud' && ['alpha', 'beta', 'preview'].includes(all[0]) ? all.slice(1) : all;
    if (pos.length === 0 || CLOUD_READ_GROUPS[program].includes(pos[0])) return null;
    // gcloud storage copies and removes as gsutil does.
    if (program === 'gcloud' && pos[0] === 'storage' && ['cp', 'mv', 'rsync', 'rm'].includes(pos[1])) {
        const found = remote('gsutil', args.slice(args.indexOf('storage') + 1), 'gcloud storage');
        return found && { ...found, program };
    }
    const at = pos.findIndex((w, i) => i > 0 && i < 5 && (CLOUD_VERBS.test(w) || CLOUD_READS.test(w)));
    if (at < 0 || !CLOUD_VERBS.test(pos[at])) return null;
    // What it changes: a --name, or the word right after the verb (not an option's value).
    const next = args[args.indexOf(pos[at]) + 1];
    const target = optionValue(args, ['--name', '-n']) ?? (next !== undefined && !next.startsWith('-') ? next : undefined);
    return { kind: 'deploy', program, what: `makes a change in the cloud (${[program, ...pos.slice(0, at + 1), target ?? ''].join(' ').trim().slice(0, 60)})` };
}

const AWS_TAKES = new Set(['--profile', '--region', '--output', '--endpoint-url', '--query', '--cli-input-json', '--cli-input-yaml', '--color', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout', '--page-size', '--max-items', '--starting-token', '--cli-binary-format',
    // aws s3's own.
    '--acl', '--cache-control', '--content-type', '--content-encoding', '--content-disposition', '--content-language', '--exclude', '--include', '--storage-class',
    '--metadata', '--metadata-directive', '--expires', '--grants', '--website-redirect', '--sse-c', '--sse-c-key', '--sse-kms-key-id', '--source-region', '--expected-size', '--request-payer', '--checksum-algorithm']);
const AWS_VERBS = /^(create|delete|put|update|modify|start|stop|terminate|run|invoke|publish|send|deploy|register|deregister|attach|detach|associate|disassociate|reboot|restore|tag|untag|enable|disable|import|cancel|reset|set|add|remove|replace|accept|reject|authorize|revoke|copy|upload|execute|apply|batch|transact|purge|complete|abort|change|rotate|restart|promote|failover|initiate|respond|resume|suspend|signal|subscribe|unsubscribe|confirm|allocate|release|assign|unassign|activate|deactivate)(-|$)/;

function aws(args) {
    const pos = positionals(args, AWS_TAKES);
    const [service, op] = pos;
    if (!service || service === 'configure' || service === 'help' || has(args, '--dryrun', '--dry-run')) return null;
    if (service === 's3') {
        if (['rm', 'mb', 'rb'].includes(op)) return { kind: 'deploy', program: 'aws', what: `changes S3 (aws s3 ${op} ${placeOf(pos[2] ?? '')})` };
        if (!['cp', 'mv', 'sync'].includes(op)) return null;
        // Source, then destination: an option's value after them (an option it doesn't know) is no destination.
        const s3 = (a) => /^s3:\/\//i.test(a ?? '');
        const to = pos.slice(3).find(s3);
        if (to) return { kind: 'deploy', program: 'aws', what: `copies to S3 (aws s3 ${op} → ${placeOf(to)})` };
        return op === 'mv' && s3(pos[2]) ? { kind: 'deploy', program: 'aws', what: `changes S3 (aws s3 mv ${placeOf(pos[2])})` } : null;
    }
    // `aws eks update-kubeconfig` writes this machine's kubeconfig only.
    if (service === 'eks' && op === 'update-kubeconfig') return null;
    return AWS_VERBS.test(op ?? '') ? { kind: 'deploy', program: 'aws', what: `makes a change in AWS (aws ${service} ${op})` } : null;
}

const HEROKU_VERBS = /(^|:)(create|destroy|delete|set|unset|add|remove|push|release|restart|run|promote|rollback|scale|update|transfer|attach|detach|reset|enable|disable|cancel|rename|upgrade|downgrade|kill|stop|start|import|clear)$/;
const FLY_WRITES = new Set(['create', 'destroy', 'delete', 'set', 'unset', 'import', 'deploy', 'run', 'start', 'stop', 'update', 'restart', 'clone', 'kill', 'cordon', 'extend', 'fork', 'attach', 'detach', 'allocate-v4', 'allocate-v6', 'release', 'add', 'remove', 'failover', 'move', 'console', 'sftp']);
const VERCEL_READS = new Set(['dev', 'build', 'pull', 'link', 'login', 'logout', 'whoami', 'ls', 'list', 'inspect', 'logs', 'help', 'init', 'switch', 'bisect', 'telemetry', 'git', 'project', 'projects', 'teams', 'team', 'env', 'certs', 'dns', 'domains', 'alias', 'secrets', 'integration']);
const STRIPE_VERBS = new Set(['create', 'update', 'delete', 'refund', 'cancel', 'capture', 'pay', 'send', 'void', 'finalize', 'approve', 'decline', 'close', 'reject', 'verify', 'resend', 'mark_uncollectible', 'mark-uncollectible', 'trigger', 'post']);

function deployTool(name, args) {
    const pos = positionals(args, new Set(['a', 'app', '--app', 'r', '--remote', 'c', '--config', '--team', '--scope', '--token', '--project', '--profile']));
    if (name === 'heroku') return pos[0] && (HEROKU_VERBS.test(pos[0]) || ['create', 'destroy', 'run', 'restart', 'rollback', 'promote'].includes(pos[0])) ? { kind: 'deploy', program: name, what: `makes a change on Heroku (heroku ${pos[0]})` } : null;
    if (name === 'fly') return ['deploy', 'launch', 'destroy', 'scale'].includes(pos[0]) || FLY_WRITES.has(pos[1]) ? { kind: 'deploy', program: name, what: `makes a change on Fly (fly ${pos.slice(0, 2).join(' ')})` } : null;
    if (name === 'vercel') {
        // Bare, or with a folder, it deploys.
        const sub = pos[0];
        const writes = { env: ['add', 'rm', 'remove'], alias: ['set', 'rm', 'remove'], domains: ['add', 'rm', 'remove', 'move', 'transfer-in', 'buy'], dns: ['add', 'rm', 'remove', 'import'], secrets: ['add', 'rm', 'remove', 'rename'], certs: ['add', 'issue', 'rm', 'remove'], project: ['add', 'rm', 'remove'], projects: ['add', 'rm', 'remove'] };
        if (sub === undefined || !(VERCEL_READS.has(sub) || ['deploy', 'redeploy', 'rm', 'remove', 'promote', 'rollback'].includes(sub)) || ['deploy', 'redeploy', 'rm', 'remove', 'promote', 'rollback'].includes(sub)) {
            if (sub !== undefined && VERCEL_READS.has(sub)) return writes[sub]?.includes(pos[1]) ? { kind: 'deploy', program: name, what: `makes a change on Vercel (vercel ${sub} ${pos[1]})` } : null;
            return { kind: 'deploy', program: name, what: `deploys (vercel${sub && !sub.includes('/') && sub !== '.' ? ` ${sub}` : ''})` };
        }
        return writes[sub]?.includes(pos[1]) ? { kind: 'deploy', program: name, what: `makes a change on Vercel (vercel ${sub} ${pos[1]})` } : null;
    }
    if (name === 'firebase') return pos[0] && (pos[0] === 'deploy' || /:(delete|set|push|update|remove|import|deploy|rollback|disable|clone|distribute|create)$/.test(pos[0])) ? { kind: 'deploy', program: name, what: `makes a change on Firebase (firebase ${pos[0]})` } : null;
    if (name === 'stripe') return pos.slice(0, 3).some((w) => STRIPE_VERBS.has(w)) ? { kind: 'deploy', program: name, what: `makes a change in Stripe (stripe ${pos.slice(0, 3).join(' ')})` } : null;
    if (name === 'goreleaser') return (pos[0] ?? 'release') === 'release' && !has(args, '--snapshot', '--skip-publish') && !args.some((a) => /^--skip=.*publish/.test(a)) ? { kind: 'publish', program: name, what: 'publishes a release (goreleaser)' } : null;
    if (name === 'semantic-release' || name === 'releaseIt') return dryRun(args) || has(args, '-d') ? null : { kind: 'publish', program: name, what: `publishes a release (${name === 'releaseIt' ? 'release-it' : name})` };
    if (name === 'ansible-playbook') return has(args, '--check', '-C', '--syntax-check', '--list-hosts', '--list-tasks', '--list-tags') ? null : { kind: 'remote', program: name, what: 'runs a playbook on other machines (ansible-playbook)' };
    if (name === 'ansible') return has(args, '--list-hosts') || ['ping', 'setup', 'gather_facts', 'debug'].includes(optionValue(args, ['-m', '--module-name'])) ? null : { kind: 'remote', program: name, what: 'runs commands on other machines (ansible)' };
    return null;
}

const SSH_TAKES = new Set([...'bcDEeFIiJLlmOoPpQRSWw', 'B']);
const AUTOSSH_TAKES = new Set([...SSH_TAKES, 'M']);
const SCP_TAKES = new Set([...'cDFiJlMPoSX']);
const RSYNC_TAKES = new Set(['e', 'f', 'T', 'B', 'M', '@', '--rsh', '--rsync-path', '--exclude', '--include', '--filter', '--exclude-from', '--include-from', '--files-from', '--password-file',
    '--log-file', '--partial-dir', '--temp-dir', '--backup-dir', '--suffix', '--chmod', '--chown', '--timeout', '--contimeout', '--port', '--bwlimit',
    '--usermap', '--groupmap', '--out-format', '--log-file-format', '--remote-option', '--address', '--sockopts', '--info', '--debug', '--compare-dest', '--copy-dest',
    '--link-dest', '--block-size', '--modify-window', '--max-size', '--min-size', '--max-delete', '--max-alloc', '--checksum-choice', '--compress-choice',
    '--compress-level', '--skip-compress', '--iconv', '--outbuf', '--write-batch', '--only-write-batch', '--read-batch', '--protocol', '--copy-as', '--early-input',
    '--stop-after', '--stop-at', '--checksum-seed']);
const MOSH_TAKES = new Set(['p', '--port', '--ssh', '--server', '--client', '--predict', '--family', '--bind-server', '--experimental-remote-ip']);
/** mosh's options that leave where it connects as it is. */
const MOSH_PLAIN = new Set(['-a', '-n', '-4', '-6', '-p', '--port', '--predict', '--family', '--bind-server', '--experimental-remote-ip', '--server', '--ssh-pty', '--no-ssh-pty', '--init', '--no-init']);

/** `[user@]host:path`, `host::module`, `scp://…`: a place on another machine. */
const remotePath = (a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a) || (/^[^/\s:]+:/.test(a) && !/^[a-z]:[\\/]/i.test(a));

/** `-J`, `ProxyJump`: jump hosts, by commas, into `via`; `none` is none, and no value can't be told. */
function jumps(value, via) {
    const list = String(value ?? '').trim();
    if (list === '') return false;
    if (list.toLowerCase() !== 'none') via.push(...list.split(',').map(hostOf));
    return true;
}

/**
 * One `-o` option (`Key=value`, `Key value`): a jump host or a host name
 * goes into `via`; false when where ssh goes can't be told (a proxy, local
 * or known-hosts command, a shared connection, names it completes itself).
 */
function sshOption(text, via) {
    const m = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*?)\s*$/s.exec(String(text ?? ''));
    if (!m) return false;
    const value = m[2].replace(/^"(.*)"$/s, '$1').toLowerCase();
    switch (m[1].toLowerCase()) {
        case 'proxyjump': return jumps(value, via);
        case 'hostname': via.push(hostOf(value)); return true;
        case 'proxycommand': case 'controlpath': case 'knownhostscommand': return value === 'none';
        case 'permitlocalcommand': case 'canonicalizehostname': return value === 'no' || value === 'false' || value === 'none';
        case 'localcommand': case 'canonicaldomains': case 'host': case 'match': case 'include': return false;
        default: return true;
    }
}

/**
 * The machines an ssh connection reaches besides its destination, from its
 * options (ssh's, autossh's, scp's): jump hosts, a host name given for it,
 * where `-W` forwards to. Null when they can't be told: a config file of
 * its own (`-F`), a shared connection (`-S`), another program run as ssh
 * or as the server (scp's `-S` and `-D`), or an `-o` that can't be told.
 */
function sshVia(options, program) {
    const via = [];
    for (const [name, value] of options) {
        const known = name === '-J' ? jumps(value, via)
            : name === '-o' ? sshOption(value, via)
            : name === '-F' ? value === 'none'
            : name === '-S' ? value === 'none' && program !== 'scp'
            : name !== '-D' || program !== 'scp';
        if (!known) return null;
        if (name === '-W' && program !== 'scp') via.push(machine(value));
    }
    return via;
}

/** Where a remote shell given as a command line goes besides the destination (rsync's `-e`, mosh's `--ssh`): ssh's options; null for another program, or a destination of its own. */
function shellRoute(command) {
    const [first, ...rest] = splitWords(String(command ?? ''));
    if (programOf(first) !== 'ssh') return null;
    const { options, words } = optionsOf(rest, SSH_TAKES);
    return words.length === 0 ? sshVia(options, 'ssh') : null;
}

/**
 * The machines ssh, autossh or mosh reaches: its destination and what its
 * options send it through; null when they can't be told. ssh reads options
 * before its destination and again after it, up to the command; autossh
 * may read them anywhere, and mosh takes only the ones it knows.
 */
function shellHosts(name, args, env) {
    if (name === 'ssh' || name === 'autossh') {
        if (name === 'autossh' && env?.has('AUTOSSH_PATH')) return null;
        const { options, words } = name === 'ssh' ? optionsOf(args, SSH_TAKES, (n) => n < 2) : optionsOf(args, AUTOSSH_TAKES);
        const via = sshVia(options, name);
        return via && [hostOf(words[0]), ...via];
    }
    if (name !== 'mosh') return null;
    const { options, words } = optionsOf(args, MOSH_TAKES);
    const via = [];
    for (const [option, value] of options) {
        const more = option === '--ssh' ? shellRoute(value) : MOSH_PLAIN.has(option) ? [] : null;
        if (!more) return null;
        via.push(...more);
    }
    return [hostOf(words[0]), ...via];
}

/**
 * The machines scp or rsync reaches: each place on another machine it names
 * (it copies from or to it), and what its remote shell goes through; null
 * when they can't be told. scp reads options only before its first path,
 * so a word after it counts as a path too; rsync reads them anywhere, and
 * takes its remote shell from `-e` or RSYNC_RSH.
 */
function copyHosts(name, args, env) {
    if (name === 'scp') {
        const loose = optionsOf(args, SCP_TAKES);
        const via = sshVia(loose.options, name);
        return via && [...[...loose.words, ...optionsOf(args, SCP_TAKES, (n) => n === 0).words].filter(remotePath).map(pathHost), ...via];
    }
    if (env?.get('RSYNC_PROXY') || env?.get('RSYNC_CONNECT_PROG')) return null;
    const { options, words } = optionsOf(args, RSYNC_TAKES);
    const shells = options.filter(([option]) => option === '-e' || option === '--rsh').map(([, value]) => value);
    const via = [];
    for (const shell of shells.length > 0 ? shells : env?.get('RSYNC_RSH') ? [env.get('RSYNC_RSH')] : []) {
        const more = shellRoute(shell);
        if (!more) return null;
        via.push(...more);
    }
    return [...words.filter(remotePath).map(pathHost), ...via];
}

/** ssh and the programs that copy files to another machine or a bucket; `label` names the command (`gcloud storage`). */
function remote(name, args, label = name, ctx = {}) {
    if (name === 'ssh' || name === 'mosh' || name === 'autossh' || name === 'rsh') {
        if (has(args, '-G', '-V', '-Q')) return null;
        const [host, ...command] = positionals(args, name === 'autossh' ? AUTOSSH_TAKES : name === 'mosh' ? MOSH_TAKES : SSH_TAKES);
        // A git host's shell only greets: `ssh -T git@github.com` checks a key.
        if (command.length === 0 && /^git@/.test(host ?? '')) return null;
        return { kind: 'remote', program: name, what: `runs commands on ${placeOf(host) || 'another machine'} (${name})`, ...reaching(shellHosts(name, args, ctx.env), ctx) };
    }
    if (name === 'scp' || name === 'rsync') {
        // A dry run copies nothing: `rsync -n`, `--dry-run`.
        if (name === 'rsync' && (dryRun(args) || hasShort(args, 'n'))) return null;
        // scp's paths as it reads them, its options all before them; rsync's options can come anywhere.
        const pos = name === 'scp' ? optionsOf(args, SCP_TAKES, (n) => n === 0).words : positionals(args, RSYNC_TAKES);
        // The last place on another machine after the first path is where the files go: an option's value after it is not.
        const dest = pos.slice(1).filter(remotePath).at(-1);
        return dest ? { kind: 'remote', program: name, what: `copies files to ${placeOf(dest.replace(/:.*$/, '')) || 'another machine'} (${name})`, ...reaching(copyHosts(name, args, ctx.env), ctx) } : null;
    }
    if (name === 'rclone') {
        const pos = positionals(args, new Set(['--config', '--include', '--exclude', '--filter', '--transfers', '--checkers', '--bwlimit', '--log-file', '--log-level', '--max-age', '--min-age']));
        const [sub, ...paths] = pos;
        const writes = ['copy', 'copyto', 'sync', 'move', 'moveto', 'delete', 'deletefile', 'purge', 'mkdir', 'rmdir', 'rmdirs', 'rcat', 'touch', 'settier', 'bisync', 'cleanup', 'dedupe', 'copyurl'];
        if (!writes.includes(sub)) return null;
        const target = ['copy', 'copyto', 'sync', 'move', 'moveto', 'bisync', 'copyurl'].includes(sub) ? paths.at(-1) : paths[0];
        return target && /^[^/\s:]+:/.test(target) ? { kind: 'remote', program: name, what: `changes files on ${target.replace(/:.*$/, '')} (rclone ${sub})` } : null;
    }
    if (name === 's3cmd' || name === 'gsutil' || name === 'azcopy') {
        const pos = positionals(args, new Set(['-c', '--config', 'o', 'h']));
        const sub = pos[0];
        const writes = { s3cmd: ['put', 'del', 'rm', 'mb', 'rb', 'setacl', 'setpolicy', 'delpolicy', 'modify', 'restore'], gsutil: ['rm', 'mb', 'rb', 'setmeta', 'acl', 'iam', 'defacl', 'retention'], azcopy: ['remove', 'make', 'rm'] };
        const bucket = (a) => /^(s3|gs|https?):\/\//i.test(a ?? '');
        // A bucket keeps its scheme, which says whose it is; any URL loses its query, where a token can be.
        const where = (url) => `${/^(s3|gs):\/\//i.test(url) ? url.slice(0, 5).toLowerCase() : ''}${placeOf(url)}`;
        // Sources, then the destination: a bucket after the first source is where the files go.
        const to = ['cp', 'mv', 'sync', 'rsync', 'copy'].includes(sub) ? pos.slice(2).find(bucket) : undefined;
        if (to) return { kind: 'remote', program: name, what: `copies files to ${where(to)} (${label} ${sub})` };
        if (!writes[name].includes(sub)) return null;
        const at = pos.slice(1).find(bucket);
        return { kind: 'remote', program: name, what: `changes files in ${at ? where(at) : 'the cloud'} (${label} ${sub})` };
    }
    if (['sftp', 'ftp', 'lftp', 'tftp'].includes(name)) return { kind: 'remote', program: name, what: `opens a file transfer to ${placeOf(positionals(args, new Set([...'bBDFiJlPRSoe'])).at(-1) ?? '') || 'another machine'} (${name})` };
    if (name === 'nc') {
        if (args.some((a) => /^-[a-zA-Z]*[zl]/.test(a))) return null;
        return { kind: 'remote', program: name, what: `opens a raw connection to ${positionals(args, new Set([...'ipsswWxXqI']))[0] ?? 'another machine'} (nc)` };
    }
    if (['socat', 'telnet', 'websocat', 'wscat'].includes(name)) return { kind: 'remote', program: name, what: `opens a connection that can send anything (${name})` };
    // OpenSSL's TLS client is a raw connection too (what it reads in goes out); its other commands work on files here.
    if (name === 'openssl') {
        if (args[0] !== 's_client') return null;
        return { kind: 'remote', program: name, what: `opens a raw connection to ${placeOf(optionValue(args, ['-connect']) ?? '') || 'another machine'} (openssl s_client)` };
    }
    if (name === 'grpcurl') return args.some((a) => a === 'list' || a === 'describe') ? null : { kind: 'request', program: name, what: 'calls a remote service (grpcurl)' };
    return null;
}

function mail(name, args) {
    if (name === 'sendmail' && args.some((a) => /^-b[vtp]$/.test(a))) return null;
    if (name === 'mail' && !args.some((a) => a.includes('@')) && !has(args, '-s')) return null;
    return { kind: 'email', program: name, what: `sends email (${name})` };
}

// ── Code ──────────────────────────────────────────────────────────────────

const CODE_SENDS = [
    [/\.\s*(?:request|open)\s*\(\s*['"](POST|PUT|PATCH|DELETE)['"]/i, (m) => `a ${m[1].toUpperCase()}`],
    [/\bhttp\.(Post|PostForm)\s*\(|\bNet::HTTP\.(post|post_form|put|patch|delete)\b/, (m) => `a ${(m[1] ?? m[2]).replace(/_form$|Form$/, '').toUpperCase()}`],
    [/\$fetch\s*\.\s*(post|put|patch|delete)\s*\(/i, (m) => `a ${m[1].toUpperCase()}`],
    [/\bNet::HTTP::(Post|Put|Patch|Delete)\b|\b(?:HTTParty|Faraday|RestClient)\s*\.\s*(post|put|patch|delete)\b/, (m) => `a ${(m[1] ?? m[2]).toUpperCase()}`],
    [/\bHTTP::Request->new\(\s*['"]?(POST|PUT|PATCH|DELETE)/, (m) => `a ${m[1]}`],
    // Perl's web clients: `LWP::UserAgent->new->post(…)`, HTTP::Tiny's `->request('POST', …)`, HTTP::Request::Common's `->request(POST $url, …)`.
    [/\b(?:LWP::UserAgent|HTTP::Tiny|Mojo::UserAgent|Furl)\b[^]{0,4000}?->\s*(post|put|patch|delete)(?:_form)?\s*\(/, (m) => `a ${m[1].toUpperCase()}`],
    [/->\s*request\s*\(\s*(?:['"](POST|PUT|PATCH|DELETE)['"]|(POST|PUT|PATCH|DELETE)\b)/, (m) => `a ${m[1] ?? m[2]}`],
    [/\bCURLOPT_(?:POST|POSTFIELDS|UPLOAD|CUSTOMREQUEST)\b/, () => 'a request that changes something'],
    [/\bInvoke-(?:WebRequest|RestMethod)\b[^\n]*-Method\s+['"]?(Post|Put|Patch|Delete)\b/i, (m) => `a ${m[1].toUpperCase()}`],
    // .NET's WebClient, from PowerShell: `(New-Object System.Net.WebClient).UploadFile(…)`.
    [/\.\s*Upload(?:File|String|Data|Values)(?:Async|TaskAsync)?\s*\(/i, () => 'a POST'],
];
/** A request's method in code: it counts where the code calls a web client (CALLS_CLIENT), not in a route table or other data. */
const METHOD_OPTION = /\bmethod\s*[:=]\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i;
const CALLS_CLIENT = /\b(?:fetch|axios|got|ky|superagent|needle|ofetch|request|urlopen|Request)\s*\(|\$fetch\s*\(|\.ajax\s*\(|\bhttps?\.request\b|\b(?:requests|httpx|urllib3|aiohttp|urllib|undici|XMLHttpRequest|HttpClient|WebClient|WebRequest|HttpURLConnection|HTTParty|Faraday|RestClient|Invoke-WebRequest|Invoke-RestMethod)\b/i;
/** Python's web clients, and what each makes its sessions or clients with. */
const PY_CLIENTS = { requests: ['Session', 'session'], httpx: ['Client', 'AsyncClient'], aiohttp: ['ClientSession'], urllib3: ['PoolManager'] };
/** JavaScript's, and what each makes a client of its own with (`const api = axios.create(…)`). */
const JS_CLIENTS = { axios: ['create'], got: ['extend'], ky: ['create', 'extend'], superagent: [], needle: [], ofetch: ['create'], undici: [] };
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CODE_MAIL = /\b(?:smtplib|nodemailer|Net::SMTP|Mail::Sendmail|PHPMailer|Send-MailMessage)\b/;

/** Code that runs commands: then its strings and lists of strings are read as command lines. */
const SPAWNS = /\b(?:subprocess|os\.system|os\.popen|os\.exec\w*|pexpect|child_process|execSync|execFileSync|spawnSync|spawn|execFile|execa|execaSync|Bun\.spawn|Bun\.\$|Deno\.Command|Deno\.run|Open3|shell_exec|passthru|proc_open|popen|system|exec|IO\.popen|Process\.(?:spawn|start)|ProcessBuilder|Runtime\.getRuntime)\b|\$`|%x[({[]|\bqx[({[/]/;

/**
 * What code sends: a web request with a method that changes something, or
 * an email; or a command line it runs (a string that starts with a known
 * program, or a list of its words) that sends. `ctx.trustedHosts` and
 * `ctx.trustedSends` are sendOf's options of those names.
 * @returns {{kind: string, what: string, program: string}|null}
 */
export function codeSendOf(code, ctx = { depth: 0 }, program = 'code') {
    return shown(codeFound(String(code ?? ''), trusting(ctx, ctx), program));
}

function codeFound(text, ctx, program) {
    const method = clientMethod(text) ?? urllibMethod(text);
    if (method) return { kind: 'request', program, what: `runs code that sends a ${method} (${program})` };
    for (const [re, said] of CODE_SENDS) {
        const m = re.exec(text);
        if (m) return { kind: 'request', program, what: `runs code that sends ${said(m)} (${program})` };
    }
    const option = CALLS_CLIENT.test(text) ? METHOD_OPTION.exec(text) : null;
    if (option) return { kind: 'request', program, what: `runs code that sends a ${option[1].toUpperCase()} (${program})` };
    if (CODE_MAIL.test(text)) return { kind: 'email', program, what: `runs code that sends email (${program})` };
    // Its strings are read as commands only where it runs commands, so a message that mentions one is no send.
    if ((ctx.depth ?? 0) >= MAX_DEPTH || !SPAWNS.test(text)) return null;
    const deeper = { ...ctx, depth: (ctx.depth ?? 0) + 1 };
    const said = (found) => (found ? { ...found, what: `runs code that ${found.what}` } : null);
    // A program and its words as a list: `spawn('git', ['push'])`, `subprocess.run(['git', 'push'])`.
    for (const m of text.matchAll(/(['"])([^'"\n]{1,200})\1\s*,\s*\[([^\]]{0,600})\]/g)) {
        const found = wordsSendOf([m[2], ...[...m[3].matchAll(/(['"])([^'"\n]*)\1/g)].map((w) => w[2])], deeper);
        if (found) return said(found);
    }
    for (const m of text.matchAll(/\[\s*((?:(['"])[^'"\n]{0,200}\2\s*,\s*){1,30}(['"])[^'"\n]{0,200}\3)\s*,?\s*\]/g)) {
        const found = wordsSendOf([...m[1].matchAll(/(['"])([^'"\n]*)\1/g)].map((w) => w[2]), deeper);
        if (found) return said(found);
    }
    // A command line as one string: `execSync('git push')`, `os.system("curl -X POST …")`.
    for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.){3,400})\1/g)) {
        if (!/\s/.test(m[2])) continue;
        const found = lineSendOf(m[2].replace(/\$\{[^}]*\}/g, 'X'), deeper);
        if (found) return said(found);
    }
    return null;
}

/**
 * A method that changes something, called on a web client: a client module
 * (`requests.post(`, `axios.delete(`), a name code imports one as (`import
 * requests as r`), a session or a client it makes from one (`s =
 * requests.Session()`, `async with aiohttp.ClientSession() as s`,
 * `httpx.Client().post(`, `require('axios').post(`), or a function it
 * imports from one (`from requests import post`). An ORM's session changes a
 * database, not a web resource: with SQLAlchemy, `db.session.delete(row)` is
 * none.
 * @returns the method ("POST"), or undefined.
 */
function clientMethod(text) {
    const receivers = new Set(['client', ...Object.keys(PY_CLIENTS), ...Object.keys(JS_CLIENTS)]);
    if (!/\b(?:sqlalchemy|flask_sqlalchemy|sqlmodel)\b/.test(text)) receivers.add('session');
    const makers = [];
    const functions = new Map();
    for (const [module, made] of Object.entries(PY_CLIENTS)) {
        for (const name of [module, ...[...text.matchAll(new RegExp(`\\bimport\\s+${module}\\s+as\\s+(\\w+)`, 'g'))].map((m) => m[1])]) {
            receivers.add(name);
            makers.push(...made.map((maker) => `${escaped(name)}\\s*\\.\\s*${maker}`));
        }
        for (const m of text.matchAll(new RegExp(`\\bfrom\\s+${module}\\s+import\\s+(?:\\(([^)]*)\\)|([^\\n;#]+))`, 'g'))) {
            for (const part of (m[1] ?? m[2]).split(',')) {
                const [name, as = name] = part.trim().split(/\s+as\s+/);
                if (made.includes(name)) makers.push(escaped(as));
                if (/^(post|put|patch|delete)$/.test(name)) functions.set(as, name.toUpperCase());
            }
        }
    }
    for (const [module, made] of Object.entries(JS_CLIENTS)) makers.push(...made.map((maker) => `${module}\\s*\\.\\s*${maker}`));
    const maker = `(?:${makers.join('|')})`;
    for (const m of text.matchAll(new RegExp(`(?:^|[^\\w.])((?:self\\.|this\\.)?[A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${maker}\\s*\\(`, 'gm'))) receivers.add(m[1]);
    for (const m of text.matchAll(new RegExp(`\\bwith\\s+${maker}\\s*\\([^\\n]*?\\)\\s+as\\s+(\\w+)`, 'g'))) receivers.add(m[1]);
    const call = new RegExp(`(?<![\\w$])(?:${[...receivers].map(escaped).join('|')})\\s*\\.\\s*(post|put|patch|delete)\\s*\\(`
        + `|${maker}\\s*\\([^\\n]*?\\)\\s*\\.\\s*(post|put|patch|delete)\\s*\\(`
        + `|\\brequire\\s*\\(\\s*['"](?:${Object.keys(JS_CLIENTS).join('|')})['"]\\s*\\)\\s*\\.\\s*(post|put|patch|delete)\\s*\\(`, 'i').exec(text);
    if (call) return (call[1] ?? call[2] ?? call[3]).toUpperCase();
    for (const [name, method] of functions) if (new RegExp(`(?:^|[^\\w.])${escaped(name)}\\s*\\(`, 'm').test(text)) return method;
    return undefined;
}

/**
 * Python's standard library sending a body: `urllib.request.Request(url,
 * data)` or `urlopen(url, data)`, the data given by position or as `data=`,
 * unless `method=` names a read.
 * @returns the method, or undefined.
 */
function urllibMethod(text) {
    if (!/\burllib\b/.test(text)) return undefined;
    for (const m of text.matchAll(/\b(?:Request|urlopen)\s*\(/g)) {
        const args = callArgs(text, m.index + m[0].length - 1);
        const named = (key) => args.find((a) => new RegExp(`^${key}\\s*=`).test(a))?.replace(/^\w+\s*=\s*/, '');
        const method = /^['"]([A-Za-z]+)['"]$/.exec(named('method') ?? '')?.[1].toUpperCase();
        const data = named('data') ?? (args[1] !== undefined && !/^\w+\s*=/.test(args[1]) ? args[1] : undefined);
        if (method ? !READ_METHODS.has(method) : data !== undefined && data !== 'None') return method ?? 'POST';
    }
    return undefined;
}

/** The arguments of the call whose `(` is at `open`, as written: split at its own commas, with quotes and brackets kept. */
function callArgs(text, open) {
    const args = [];
    let depth = 0;
    let from = open + 1;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            let k = i + 1;
            while (k < text.length && text[k] !== c) k += text[k] === '\\' ? 2 : 1;
            i = k;
        } else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c) && --depth === 0) {
            args.push(text.slice(from, i).trim());
            break;
        } else if (c === ',' && depth === 1) {
            args.push(text.slice(from, i).trim());
            from = i + 1;
        }
    }
    return args.filter((a) => a !== '');
}

// ── Scripts and tasks ─────────────────────────────────────────────────────

/** Words in a name that say it sends: always, or only when what it runs can't be read. */
const STRONG = new Set(['deploy', 'deploys', 'deployment', 'deployments', 'redeploy', 'undeploy', 'publish', 'upload', 'uploads', 'ship', 'rollout', 'promote', 'notify', 'announce', 'broadcast']);
const WEAK = new Set(['release', 'releases', 'push', 'send', 'submit']);
/**
 * Words that say a name only tries or checks what it names (`deploy:dry`,
 * `deploy_check`, `release:plan`), and so sends nothing; `test` too, before
 * the sending word: `test:deploy` tests a deploy, `deploy:test` deploys.
 */
const DRY = new Set(['dry', 'dryrun', 'check', 'checks', 'plan', 'diff', 'lint', 'validate']);

/** The words of a name: `scripts/publish-npm.mjs` and `pushImage` give [scripts, publish, npm, mjs] and [push, image]. */
function nameWords(name) {
    return String(name).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}
function sendingName(name, known) {
    const words = nameWords(name);
    const at = words.findIndex((w) => STRONG.has(w) || (!known && WEAK.has(w)));
    return at >= 0 && !words.some((w, i) => DRY.has(w) || ((w === 'test' || w === 'tests') && i < at));
}

/** A test's file: `test/x.mjs`, `x.test.js`, `test_x.py`, `x_test.go`, `spec/x_spec.rb`. */
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.[a-z]+$/i;
const SCRIPT_EXT = /\.(sh|bash|zsh|ksh|py|js|mjs|cjs|ts|mts|rb|pl|php|ps1|lua|r)$/i;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php', 'rscript', 'lua', 'ts-node', 'tsx', 'osascript', 'pwsh', 'powershell']);
const isPython = (name) => /^python(\d+(\.\d+)?)?$/.test(name);
/** An interpreter's own options that take the next word: a shell's, Python's, and the others' (code, a module, a folder). */
const SHELL_TAKES = new Set(['o', 'O', '--init-file', '--rcfile']);
const PYTHON_TAKES = new Set(['W', 'X', 'Q', 'c', 'm']);
const RUNTIME_TAKES = new Set(['r', 'e', 'p', 'E', 'I', 'C', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--conditions', '--eval', '--print']);

/** A folder named from another, or null when it can't be told (the other is unknown, the name has a variable or a ~). */
function within(cwd, dir) {
    if (typeof dir !== 'string' || dir.includes('$') || dir.startsWith('~')) return null;
    if (isAbsolute(dir)) return dir;
    return typeof cwd === 'string' ? resolve(cwd, dir) : null;
}

/** A file a command names, read through the caller (only files in the workspace are given). */
function readScript(ctx, named) {
    const path = ctx.shell === 'pwsh' && typeof named === 'string' ? named.replace(/\\/g, '/') : named;
    if (typeof ctx.read !== 'function' || typeof path !== 'string' || path === '' || path.includes('$') || path.startsWith('~')) return undefined;
    if (!isAbsolute(path) && (ctx.cwd === null || ctx.cwd === undefined)) return undefined;
    const full = isAbsolute(path) ? path : resolve(ctx.cwd, path);
    try {
        const text = ctx.read(full);
        return typeof text === 'string' ? { text, full } : undefined;
    } catch {
        return undefined;
    }
}

/** Code or a shell script, by its first line, else by the program or the file's name. */
function contentSendOf(text, how, ctx, label) {
    const first = text.slice(0, 200).split('\n')[0];
    // `#!/usr/bin/env -S node --flag` runs node.
    const shebang = first.startsWith('#!') ? programOf(first.slice(2).trim().split(/\s+/).find((w, i) => !(i === 0 && /\/env$/.test(w)) && !w.startsWith('-')) ?? '') : undefined;
    const kind = shebang ?? how;
    if (SHELLS.has(kind) || (kind === undefined && /\.(sh|bash|zsh|ksh)$/i.test(label))) return lineSendOf(text, ctx);
    // A PowerShell script by its statements, and by its code where they find nothing.
    if (kind === 'pwsh' || kind === 'powershell' || (kind === undefined && /\.ps1$/i.test(label))) return pwshLineSendOf(text, ctx) ?? codeSendOf(text, ctx, 'pwsh');
    return codeSendOf(text, ctx, kind ?? 'code');
}

/** A script run from a file: by its name, and by what it runs when it can be read. */
function scriptSendOf(path, how, ctx) {
    const shown = String(path);
    const name = shown.split(ctx.shell === 'pwsh' ? /[\\/]/ : '/').pop();
    if (TEST_FILE.test(ctx.shell === 'pwsh' ? shown.replace(/\\/g, '/') : shown)) return null;
    const file = (ctx.depth ?? 0) < MAX_DEPTH ? readScript(ctx, shown) : undefined;
    if (file) {
        const deeper = { ...ctx, depth: (ctx.depth ?? 0) + 1, cwd: dirname(file.full) };
        const trusted = ctx.trustedSends?.length ?? 0;
        const inside = contentSendOf(file.text, how, deeper, shown);
        if (inside) return runs(shown, inside);
        // Its sends all reach machines the user trusts: they are what its name says it does.
        if ((ctx.trustedSends?.length ?? 0) > trusted) return null;
    }
    return sendingName(name, file !== undefined) ? byName(shown, name, file !== undefined, name) : null;
}

/**
 * What something does, as what a script that holds it can do: "sends a POST" → "can send a POST". A script may
 * not reach the line (a guard test that exits first, behaviour review 5), so the prompt doesn't say it will.
 */
export function canDo(what) {
    const [verb, ...rest] = String(what).split(' ');
    const base = /(?:sh|ch|ss|x|z)es$/.test(verb) ? verb.slice(0, -2) : /ies$/.test(verb) ? `${verb.slice(0, -3)}y` : verb.replace(/s$/, '');
    return ['can', base, ...rest].join(' ');
}

/** A send inside what a command runs, said through it: "runs ./deploy.sh, which can send a POST to …". */
function runs(label, inside) {
    return { kind: 'script', program: inside.program, what: `runs ${label}, which ${canDo(inside.what)}`, ...(inside.unread ? { unread: inside.unread } : {}) };
}

/**
 * A send known by a name only, the last thing the plugin goes by: a script, a
 * package script, a make target or a task whose name says it sends. `read`:
 * the plugin read what it runs and found no send it knows there; else it
 * couldn't see what it runs, and the prompt says so (described).
 */
function byName(label, name, read, program) {
    return read
        ? { kind: 'script', program, what: `runs ${label}: the plugin found no send in it, but its name says it ${nameVerb(name)}` }
        : { kind: 'script', program, what: `runs ${label}, whose name says it ${nameVerb(name)}`, unread: [label] };
}

/** The sending word a name holds, for the user: "deploys", "publishes". */
function nameVerb(name) {
    const word = nameWords(name).find((w) => STRONG.has(w) || WEAK.has(w)) ?? 'sends';
    const verbs = { deploy: 'deploys', deploys: 'deploys', deployment: 'deploys', deployments: 'deploys', redeploy: 'deploys', undeploy: 'undeploys', publish: 'publishes', upload: 'uploads', uploads: 'uploads', ship: 'ships', rollout: 'rolls out', promote: 'promotes', notify: 'notifies', announce: 'announces', broadcast: 'broadcasts', release: 'releases', releases: 'releases', push: 'pushes', send: 'sends', submit: 'submits' };
    return verbs[word] ?? 'sends';
}

/** `npm run X`, `yarn X`, `pnpm X`, `bun run X`: the script in package.json, and the ones npm runs around it. */
function packageScript(program, name, ctx, prefix, label = `${program} run ${name}`, extra = []) {
    const pkg = readScript({ ...ctx, cwd: prefix ? within(ctx.cwd, prefix) : ctx.cwd }, 'package.json');
    let scripts;
    try { scripts = pkg ? JSON.parse(pkg.text)?.scripts : undefined; } catch { scripts = undefined; }
    if (scripts && typeof scripts === 'object' && (ctx.depth ?? 0) < MAX_DEPTH) {
        const deeper = { ...ctx, depth: (ctx.depth ?? 0) + 1, cwd: dirname(pkg.full) };
        // The script runs with the words given after it: `npm run release -- --dry-run`.
        const line = (key) => (key === name && extra.length > 0 ? `${scripts[key]} ${extra.map(shellWord).join(' ')}` : scripts[key]);
        const trusted = ctx.trustedSends?.length ?? 0;
        const inside = combined([`pre${name}`, name, `post${name}`].map((key) => (typeof scripts[key] === 'string' ? lineSendOf(line(key), deeper) : null)));
        if (inside) return runs(label, inside);
        if ((ctx.trustedSends?.length ?? 0) > trusted) return null;
    }
    const known = scripts !== undefined && typeof scripts?.[name] === 'string';
    return sendingName(name, known) ? byName(label, name, known, program) : null;
}

/** A make target's rule: its recipe lines and its prerequisites (all the rules for it, joined). */
function makeRule(text, target) {
    const recipes = [];
    const needs = [];
    let inRule = false;
    for (const line of text.replace(/\\\n/g, ' ').split('\n')) {
        if (line.startsWith('\t')) {
            if (inRule) recipes.push(line.slice(1).replace(/^[@+-]+/, ''));
            continue;
        }
        const m = /^([^:#=\t][^:=]*?)\s*::?(?!=)(.*)$/.exec(line);
        if (m) {
            inRule = m[1].trim().split(/\s+/).includes(target);
            if (inRule) {
                const [deps, recipe] = m[2].split(';');
                needs.push(...deps.split('|').join(' ').trim().split(/\s+/).filter((d) => d !== '' && !d.includes('$') && !d.includes('%')));
                if (recipe !== undefined && recipe.trim() !== '') recipes.push(recipe.trim());
            }
        } else if (line.trim() !== '' && !line.startsWith('#')) inRule = false;
    }
    return { recipes, needs };
}

/**
 * A Makefile's own variables (`DOCKER ?= docker`, `IMAGE := …`, `FLAGS += -v`),
 * then the ones the command line sets (`make image DOCKER=podman`), which win.
 * One set from a shell command's output (`!=`) is unknown.
 */
function makeVars(text, given) {
    const vars = new Map([['MAKE', 'make']]);
    for (const line of text.replace(/\\\n/g, ' ').split('\n')) {
        const m = /^(?:(?:export|override)\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(\?=|\+=|!=|:{0,3}=)\s*(.*)$/.exec(line);
        if (!m) continue;
        const [, name, op] = m;
        const value = m[3].replace(/(^|[^\\])#.*$/, '$1').trim();
        if (op === '?=' && vars.has(name)) continue;
        if (op === '!=') vars.delete(name);
        else vars.set(name, op === '+=' && vars.has(name) ? `${vars.get(name)} ${value}` : value);
    }
    for (const word of given) {
        const at = word.indexOf('=');
        vars.set(word.slice(0, at), word.slice(at + 1));
    }
    return vars;
}

/** A recipe line as make hands it to the shell: `$(NAME)` and `${NAME}` filled in where known, `$$` a `$`. */
function expandMake(text, vars, depth = 0) {
    return text.replace(/\$(?:\$|\(([^()$\s]+)\)|\{([^{}$\s]+)\})/g, (whole, round, curly) => {
        if (whole === '$$') return '$';
        const value = vars.get(round ?? curly);
        if (value === undefined) return whole;
        return depth < 5 ? expandMake(value, vars, depth + 1) : value;
    });
}

/** What a make target sends, its prerequisites first (each once). */
function makeSendOf(makefile, target, ctx, vars, seen = new Set()) {
    if (seen.has(target) || seen.size > 40) return null;
    seen.add(target);
    const { recipes, needs } = makeRule(makefile.text, target);
    return combined([
        ...needs.map((need) => makeSendOf(makefile, need, ctx, vars, seen)),
        ...recipes.map((recipe) => lineSendOf(expandMake(recipe, vars), ctx)),
    ]);
}

function make(args, ctx) {
    // Only says what it would run.
    if (args.some((a) => /^-[a-zA-Z]*[nqp]/.test(a) && !a.startsWith('--')) || has(args, '--dry-run', '--just-print', '--recon', '--question', '--print-data-base')) return null;
    const dir = optionValue(args, ['-C', '--directory']);
    const file = optionValue(args, ['-f', '--file', '--makefile']);
    const where = { ...ctx, cwd: dir ? within(ctx.cwd, dir) : ctx.cwd };
    const words = positionals(args, new Set(['C', 'f', 'I', 'o', 'W', 'j', 'l', '--directory', '--file', '--makefile', '--include-dir', '--old-file', '--what-if', '--jobs', '--load-average']));
    const targets = words.filter((t) => !t.includes('='));
    const makefile = file ? readScript(where, file) : (readScript(where, 'GNUmakefile') ?? readScript(where, 'makefile') ?? readScript(where, 'Makefile'));
    let wanted = targets;
    if (wanted.length === 0 && makefile) {
        const first = makefile.text.split('\n').map((l) => /^([^.:#=\t\s][^:=\s]*)\s*::?(?!=)/.exec(l)).find(Boolean);
        wanted = first ? [first[1]] : [];
    }
    const vars = makefile ? makeVars(makefile.text, words.filter((w) => /^[A-Za-z_][A-Za-z0-9_.-]*=/.test(w))) : undefined;
    return combined(wanted.map((target) => {
        if (makefile && (ctx.depth ?? 0) < MAX_DEPTH) {
            const trusted = ctx.trustedSends?.length ?? 0;
            const inside = makeSendOf(makefile, target, { ...where, depth: (ctx.depth ?? 0) + 1, cwd: dirname(makefile.full) }, vars);
            if (inside) return runs(`make ${target}`, inside);
            if ((ctx.trustedSends?.length ?? 0) > trusted) return null;
        }
        return sendingName(target, makefile !== undefined) ? byName(`make ${target}`, target, makefile !== undefined, 'make') : null;
    }));
}

/** Task runners whose tasks the plugin doesn't read: by the task's name. */
const RUNNERS = new Set(['just', 'task', 'rake', 'gulp', 'grunt', 'invoke', 'inv', 'nox', 'tox', 'mage', 'fab', 'poe', 'fastlane', 'cake']);

/** npm, pnpm, yarn and bun: publishing, running a package's binary, or running a script. */
const YARN_OWN = new Set(['add', 'install', 'remove', 'upgrade', 'up', 'init', 'info', 'why', 'list', 'config', 'cache', 'workspaces', 'workspace', 'set', 'plugin', 'version', 'pack', 'bin', 'link', 'unlink', 'audit', 'outdated', 'global', 'import', 'licenses', 'login', 'logout', 'owner', 'tag', 'team', 'create', 'node', 'patch', 'patch-commit', 'rebuild', 'constraints', 'dedupe', 'explain', 'search', 'stage', 'unplug', 'check']);
const PNPM_OWN = new Set(['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'init', 'list', 'ls', 'why', 'outdated', 'audit', 'config', 'store', 'link', 'unlink', 'prune', 'rebuild', 'import', 'pack', 'patch', 'patch-commit', 'env', 'setup', 'server', 'root', 'bin', 'licenses', 'fetch', 'dedupe', 'create', 'deploy', 'doctor', 'cache']);

function packageManager(name, args, ctx) {
    const rest = args.slice(skipOptions(args, NPM_TAKES));
    const prefix = optionValue(args, ['--prefix', '-C', '--dir', '--cwd']);
    const [sub, ...more] = rest;
    if (sub === undefined) return null;
    const fromTable = table(PUBLISH[name] ?? {}, rest, name, 'publish');
    if (fromTable) return fromTable;
    if ((name === 'npm' && (sub === 'exec' || sub === 'x')) || ((name === 'pnpm' || name === 'yarn') && (sub === 'exec' || sub === 'dlx')) || (name === 'bun' && sub === 'x')) {
        const words = more.slice(skipOptions(more, new Set(['p', '--package', 'c', '--call'])));
        const call = optionValue(more, ['-c', '--call']);
        if (call !== undefined) return lineSendOf(call, ctx);
        return words.length > 0 ? wordsSendOf([packageBin(words[0]), ...words.slice(1)], ctx) : null;
    }
    // pnpm's own `deploy` copies a package to a folder: no send.
    if (name === 'pnpm' && sub === 'deploy') return null;
    if (sub === 'run' || sub === 'run-script' || sub === 'rum' || sub === 'urn') {
        const at = more.findIndex((w) => !w.startsWith('-'));
        return at >= 0 ? packageScript(name, more[at], ctx, prefix, undefined, scriptArgs(name, more.slice(at + 1))) : null;
    }
    // `npm version` runs preversion, version and postversion (a push, often).
    if (name === 'npm' && ['start', 'test', 't', 'restart', 'stop', 'version'].includes(sub)) return packageScript(name, sub === 't' ? 'test' : sub, ctx, prefix, `npm ${sub}`, scriptArgs(name, more));
    if ((name === 'yarn' && !YARN_OWN.has(sub)) || (name === 'pnpm' && !PNPM_OWN.has(sub))) return packageScript(name, sub, ctx, prefix, `${name} ${sub}`, scriptArgs(name, more));
    if (name === 'bun' && !['install', 'i', 'add', 'remove', 'rm', 'update', 'upgrade', 'init', 'create', 'link', 'unlink', 'pm', 'build', 'test', 'outdated', 'patch', 'repl', 'exec'].includes(sub)) {
        if (SCRIPT_EXT.test(sub) || sub.includes('/')) return scriptSendOf(sub, 'bun', ctx);
        return packageScript(name, sub, ctx, prefix, `bun ${sub}`, scriptArgs(name, more));
    }
    return null;
}

/** The words a package manager hands on to a script: npm's after `--`, the others' after the script's name. */
function scriptArgs(program, words) {
    const dash = words.indexOf('--');
    if (program === 'npm') return dash < 0 ? [] : words.slice(dash + 1);
    return dash === 0 ? words.slice(1) : words;
}

/** A word as the shell reads it back. */
const shellWord = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** Python run as `python -m twine upload` or on a file or on code. */
function interpreter(name, args, ctx, inputs) {
    const deeper = { ...ctx, depth: (ctx.depth ?? 0) + 1 };
    const shell = SHELLS.has(name) || name === 'source' || name === '.';
    // Its own options come before the script's name, and the words after it are the script's: the -n in
    // `bash deploy.sh -n prod` and the -c in `node publish.mjs -c release.json` are no syntax check.
    const takes = shell ? SHELL_TAKES : isPython(name) ? PYTHON_TAKES : RUNTIME_TAKES;
    const own = args.slice(0, skipOptions(args, takes));
    // A syntax check runs nothing: `bash -n`, `node --check`, `ruby -c`, `perl -c`, `php -l`.
    if ((SHELLS.has(name) && (hasShort(own, 'n') || has(own, '--no-execute'))) || ((name === 'node' || name === 'nodejs') && (has(own, '--check') || own.includes('-c')))
        || ((name === 'ruby' || name === 'perl') && own.includes('-c')) || (name === 'php' && own.includes('-l'))) return null;
    if (shell) {
        const c = name === 'source' || name === '.' ? undefined : own.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a) && !a.startsWith('--'));
        if (c !== undefined && c >= 0) return args[c + 1] !== undefined && (ctx.depth ?? 0) < MAX_DEPTH ? lineSendOf(args[c + 1], deeper) : null;
        const file = positionals(args, takes)[0];
        if (file !== undefined && file !== '-') return scriptSendOf(file, name === 'source' || name === '.' ? 'bash' : name, ctx);
        for (const input of inputs) { const found = (ctx.depth ?? 0) < MAX_DEPTH ? lineSendOf(input, deeper) : null; if (found) return found; }
        return null;
    }
    if (name === 'pwsh' || name === 'powershell') {
        const command = optionValue(args.map((a) => (/^-(c|command)$/i.test(a) ? '-Command' : a)), ['-Command']);
        if (command !== undefined) return (ctx.depth ?? 0) < MAX_DEPTH ? pwshLineSendOf(command, deeper) : null;
        const file = optionValue(args.map((a) => (/^-(f|file)$/i.test(a) ? '-File' : a)), ['-File']);
        return file !== undefined ? scriptSendOf(file, 'pwsh', ctx) : null;
    }
    let code = optionValue(own, isPython(name) ? ['-c'] : name === 'php' ? ['-r'] : name === 'osascript' ? ['-e'] : ['-e', '--eval', '-p', '--print', '-E']);
    if (name === 'osascript') {
        const script = args.filter((_, i) => args[i - 1] === '-e').join('\n');
        if (script && /\bsend\b|tell application "(Messages|Mail|Microsoft Outlook|Slack)"/i.test(script)) return { kind: 'message', program: name, what: 'sends a message (osascript)' };
        code = undefined;
        if (script) return null;
    }
    if (code !== undefined) return codeSendOf(code, deeper, name);
    if (isPython(name)) {
        const m = optionValue(own, ['-m']);
        if (m !== undefined) return wordsSendOf([m, ...args.slice(args.indexOf(m) + 1)], ctx);
    }
    if (name === 'deno' && args[0] === 'eval') return codeSendOf(args[1] ?? '', deeper, name);
    const pos = positionals(args, takes);
    const file = name === 'deno' && pos[0] === 'run' ? pos[1] : pos[0];
    if (file !== undefined && file !== '-') return scriptSendOf(file, name, ctx);
    for (const input of inputs) { const found = codeSendOf(input, deeper, name); if (found) return found; }
    return null;
}

// ── One command, one line ─────────────────────────────────────────────────

/** What runs a command and adds words to it or sends what it sends through a proxy: `xargs curl …`, `torsocks ssh …`. */
const UNROUTED = new Set(['xargs', 'torsocks', 'proxychains', 'proxychains4', 'tsocks']);

/**
 * What one simple command (its words) sends, or null. A send that reaches
 * only machines the user trusts (ctx.trusted, from trustedHosts) is none:
 * it goes on ctx.trustedSends, for the log.
 */
function wordsSendOf(rawWords, ctx, inputs = []) {
    const found = commandSendOf(rawWords, ctx, inputs);
    if (!found?.hosts || !(ctx.trusted instanceof Set) || !found.hosts.every((host) => ctx.trusted.has(host))) return found;
    ctx.trustedSends?.push(found);
    return null;
}

/** What one simple command sends, with the machines it reaches (`hosts`) where they can be told. */
function commandSendOf(rawWords, ctx, inputs) {
    const assigned = new Map();
    const wraps = [];
    const words = commandOf(rawWords, assigned, wraps);
    if (words.length === 0) return null;
    // Run by something that adds words to it, sends it through a proxy or sets variables from elsewhere (`op run --`):
    // the machines what it runs reaches can't be told, so none is trusted.
    if (wraps.some((name) => UNROUTED.has(name) || WRAP[name] === null)) ctx = { ...ctx, unrouted: true };
    // A script it runs sees the variables set for it: `DEPLOY_URL=http://… ./deploy.sh`.
    if (assigned.size > 0) {
        const env = new Map(ctx.env ?? []);
        for (const [name, value] of assigned) {
            if (value === null) env.delete(name);
            else env.set(name, value);
        }
        ctx = { ...ctx, env };
    }
    const first = words[0];
    let name = programOf(first);
    name = ALIASES[name] ?? name;
    const args = words.slice(1);
    // Help and version text only. `--version` is that alone: after a command's other words it's often an option's
    // name (`helm upgrade … --version 4.10.1`, `gcloud app deploy --version v2`) or a script's own.
    if (args.includes('--help') || (args.length === 1 && args[0] === '--version')) return null;
    if (name === 'eval') return (ctx.depth ?? 0) < MAX_DEPTH ? lineSendOf(args.join(' '), { ...ctx, depth: (ctx.depth ?? 0) + 1 }) : null;
    if (['npx', 'bunx', 'pnpx'].includes(name)) {
        const call = optionValue(args, ['-c', '--call']);
        if (call !== undefined) return lineSendOf(call, ctx);
        const rest = args.slice(skipOptions(args, new Set(['p', '--package'])));
        return rest.length > 0 ? wordsSendOf([packageBin(rest[0]), ...rest.slice(1)], ctx) : null;
    }
    // Runners of a tool or a project's command: `uvx twine upload`, `poetry run python x.py`, `uv tool run …`,
    // `bundle exec rake release`.
    const from = name === 'uvx' ? 0
        : (name === 'pipx' || ['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'conda', 'mamba', 'micromamba'].includes(name)) && args[0] === 'run' ? 1
        : name === 'bundle' && args[0] === 'exec' ? 1
        : name === 'uv' && args[0] === 'tool' && args[1] === 'run' ? 2 : -1;
    if (from >= 0) {
        const rest = args.slice(from);
        const command = rest.slice(skipOptions(rest, new Set(['n', 'p', 'e', '--with', '--python', '--project', '--directory', '--from', '--name', '--prefix', '--env', '--spec', '--package'])));
        return command.length > 0 ? wordsSendOf(command, ctx) : null;
    }
    // What `find` runs on each file: `find . -exec curl -T {} … \;`.
    if (name === 'find') {
        for (let i = 0; i < args.length; i++) {
            if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i])) continue;
            const end = args.findIndex((a, k) => k > i && (a === ';' || a === '+'));
            const found = wordsSendOf(args.slice(i + 1, end < 0 ? args.length : end), ctx);
            if (found) return found;
        }
        return null;
    }
    switch (name) {
        case 'curl': return ctx.shell === 'pwsh' && args.some((a) => /^-(method|body|uri|infile)(:|$)/i.test(a)) ? webCmdlet(args, 'curl', ctx) : curl(args, ctx);
        case 'wget': return ctx.shell === 'pwsh' && args.some((a) => /^-(method|body|uri|infile)(:|$)/i.test(a)) ? webCmdlet(args, 'wget', ctx) : wget(args, ctx);
        case 'http': case 'https': case 'xh': case 'xhs': return httpie(args, name, ctx);
        case 'invoke-webrequest': case 'invoke-restmethod': case 'iwr': case 'irm': return webCmdlet(args, name, ctx);
        case 'send-mailmessage': return { kind: 'email', program: name, what: 'sends email (Send-MailMessage)' };
        case 'git': return git(args);
        case 'gh': case 'glab': case 'hub': return forge(args, name);
        case 'aws': return aws(args);
        case 'gcloud': case 'az': case 'doctl': return cloud(args, name);
        case 'npm': case 'pnpm': case 'yarn': case 'bun': return packageManager(name, args, ctx);
        case 'make': case 'gmake': case 'bmake': return make(args, ctx);
        case 'mvn': case 'mvnw': return args.some((a) => /^(deploy|release:perform|site-deploy|deploy:deploy-file|jib:build)$/.test(a)) ? { kind: 'publish', program: name, what: 'publishes (mvn deploy)' } : null;
        case 'gradle': case 'gradlew': {
            // publishToMavenLocal publishes to this machine's own repository.
            const task = args.find((a) => /^(:[\w-]+)*:?(publish|upload|deploy|release|jib|pushImage|bintrayUpload|artifactoryPublish)\w*$/i.test(a) && !/ToMavenLocal$/i.test(a));
            return task ? { kind: 'publish', program: name, what: `publishes (gradle ${task})` } : null;
        }
        case 'twine': case 'poetry': case 'flit': case 'hatch': case 'pdm': case 'uv': case 'gem': case 'cargo': case 'dotnet': case 'pod': case 'vsce': case 'ovsx':
        case 'flutter': case 'dart': case 'mix': case 'swift': case 'changeset': case 'lerna': case 'eas':
            return table(PUBLISH[name], args, name, 'publish');
        case 'ssh': case 'mosh': case 'autossh': case 'rsh': case 'scp': case 'rsync': case 'rclone': case 's3cmd': case 'gsutil': case 'azcopy':
        case 'sftp': case 'ftp': case 'lftp': case 'tftp': case 'nc': case 'socat': case 'telnet': case 'websocat': case 'wscat': case 'grpcurl': case 'openssl':
            return remote(name, args, name, ctx);
        case 'sendmail': case 'mail': case 'msmtp': case 'swaks': case 'ssmtp': case 'esmtp': return mail(name, args);
        case 'heroku': case 'fly': case 'vercel': case 'firebase': case 'stripe': case 'goreleaser': case 'semantic-release': case 'releaseIt':
        case 'ansible-playbook': case 'ansible':
            return deployTool(name, args);
        default: break;
    }
    if (Object.hasOwn(DEPLOY, name)) return table(DEPLOY[name], args, name, 'deploy');
    if (RUNNERS.has(name)) {
        const task = positionals(args, new Set(['f', 'd', '--justfile', '--taskfile', '--dir', '-t'])).find((t) => sendingName(t, false));
        return task ? byName(`${name} ${task}`, task, false, name) : null;
    }
    if (SHELLS.has(name) || INTERPRETERS.has(name) || isPython(name) || name === 'source' || name === '.') return interpreter(name, args, ctx, inputs);
    if (first.includes('/') || SCRIPT_EXT.test(first) || (ctx.shell === 'pwsh' && first.includes('\\'))) return scriptSendOf(first, undefined, ctx);
    return null;
}

/** What a command line sends: each of its commands, then the command lines inside it, every send named. */
function lineSendOf(text, outer) {
    const ctx = { ...outer, shell: 'bash' };
    const { commands, nested } = splitShell(text);
    const found = [];
    let here = ctx;
    // The shell's variables as the line sets them, the ones it was given first; the exported ones go on to what it runs.
    const vars = new Map(ctx.env ?? []);
    const exported = new Set(vars.keys());
    for (let i = 0; i < commands.length; i++) {
        const words = commands[i].words.map((w) => expand(w, vars));
        const { inputs } = commands[i];
        if (words.length > 0 && words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w))) {
            for (const w of words) setFrom(vars, w);
            continue;
        }
        if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(words[0])) {
            const exports = words[0] === 'export' || words.some((w) => /^-[a-zA-Z]*x/.test(w));
            for (const w of words.slice(1)) {
                setFrom(vars, w);
                if (exports && /^[A-Za-z_]/.test(w)) exported.add(w.replace(/\+?=.*$/s, ''));
            }
            continue;
        }
        if (words[0] === 'unset') {
            for (const w of words.slice(1)) vars.delete(w);
            continue;
        }
        // A later command runs where `cd` went: `cd web && npm run deploy`.
        // Somewhere it can't tell (`cd "$DIR"`, `cd ~/x`, `cd -`), no file is read: names alone count.
        if (words[0] === 'cd' || words[0] === 'pushd' || words[0] === 'popd') {
            const to = words.length === 2 ? words[1] : undefined;
            here = { ...here, cwd: to === undefined || /^[~$-]/.test(to) || to.includes('$') ? null : within(here.cwd, to) };
            continue;
        }
        // Text piped into an interpreter is its code: `cat <<EOF | python3`, `echo '…' | node`.
        const before = i > 0 && commands[i - 1].pipe ? commands[i - 1] : undefined;
        const fed = before ? [...before.inputs, ...(['echo', 'printf'].includes(before.words[0]) ? [before.words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(' ')] : [])] : [];
        found.push(wordsSendOf(words, { ...here, env: new Map([...vars].filter(([name]) => exported.has(name))) }, [...inputs, ...fed]));
    }
    if ((ctx.depth ?? 0) < MAX_DEPTH) {
        for (const inner of nested) found.push(lineSendOf(inner, { ...ctx, depth: (ctx.depth ?? 0) + 1 }));
    }
    return combined(found);
}

/** PowerShell's words that start a statement but run no command; what their conditions and blocks run was split out. */
const PWSH_KEYWORDS = new Set(['if', 'elseif', 'else', 'switch', 'foreach', 'for', 'while', 'do', 'until', 'try', 'catch', 'finally', 'trap', 'function', 'filter',
    'workflow', 'configuration', 'param', 'begin', 'process', 'end', 'clean', 'dynamicparam', 'class', 'enum', 'data', 'using', 'parallel', 'sequence', 'inlinescript']);
/** An assignment's target and operator in PowerShell: `$resp =`, `[int]$n +=`, `$x.y =`. */
const PWSH_TARGET = /^(?:\[[^\]]*\])*\$[^\s=]*$/;
const PWSH_ASSIGN = /^(?:[-+*/%]|\?\?)?=$/;

/**
 * What a PowerShell command line sends: each statement's command, with what
 * an assignment runs (`$resp = Invoke-RestMethod …`), a splatted hashtable's
 * options (`Invoke-RestMethod @params`), and what script blocks and groups
 * run; then the code of statements that are no command (`(New-Object
 * System.Net.WebClient).UploadFile(…)`).
 */
function pwshLineSendOf(text, outer) {
    let here = { ...outer, shell: 'pwsh' };
    const tables = new Map();
    const found = [];
    const code = [];
    for (const { words: all, marks, code: source, table } of splitPwsh(text)) {
        if (table) continue;
        let k = 0;
        let target;
        while (k + 1 < all.length && PWSH_TARGET.test(all[k]) && PWSH_ASSIGN.test(all[k + 1])) {
            target = all[k];
            k += 2;
        }
        if (/^\$\w+$/.test(target ?? '') && k === all.length - 1 && all[k].startsWith('@{')) tables.set(target.slice(1).toLowerCase(), splatted(all[k]));
        // `$env:HTTPS_PROXY = '…'`: a variable what it runs next sees (a proxy, for the trusted-host check); a value that isn't one word is unknown.
        const variable = /^\$(?:\{env:([^}]+)\}|env:(\w+))$/i.exec(target ?? '');
        if (variable) here = { ...here, env: new Map([...(here.env ?? []), [variable[1] ?? variable[2], k === all.length - 1 && marks[k] !== '$' ? all[k] : '$?']]) };
        while (k < all.length && PWSH_KEYWORDS.has(all[k].toLowerCase())) {
            k += ['function', 'filter', 'workflow', 'configuration', 'class', 'enum', 'data'].includes(all[k].toLowerCase()) ? 2 : 1;
            // Its condition, its types, its switches (`switch -Regex`) and its blocks.
            while (k < all.length && (/^[([{]/.test(marks[k]) || /^-\w+$/.test(all[k]))) k++;
        }
        const head = all[k]?.toLowerCase();
        if (head === undefined || ['throw', 'exit', 'break', 'continue'].includes(head)) continue;
        // The call and dot-source operators run what follows, even a quoted path.
        const called = head === '&' || head === '.';
        if (called || head === 'return') k++;
        if (k >= all.length) continue;
        // Not a command but an expression (a string, a variable, a group): read as code once the line is read.
        if (!called && /^[$@([{'"]/.test(marks[k])) {
            code.push(source);
            continue;
        }
        let words = all.slice(k);
        // A later command runs where `cd` went; somewhere it can't tell, no file is read.
        if (['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location', 'popd', 'pop-location'].includes(words[0].toLowerCase())) {
            const to = words.length === 2 ? words[1] : words.length === 3 && /^-(literal)?path$/i.test(words[1]) ? words[2] : undefined;
            here = { ...here, cwd: to === undefined || /^[~$-]/.test(to) || to.includes('$') ? null : within(here.cwd, to.replace(/\\/g, '/')) };
            continue;
        }
        words = words.flatMap((w) => (/^@\w+$/.test(w) && tables.has(w.slice(1).toLowerCase()) ? tables.get(w.slice(1).toLowerCase()) : [w]));
        found.push(wordsSendOf(words, here));
    }
    if (code.length > 0) found.push(codeFound(code.join('\n'), here, 'pwsh'));
    return combined(found);
}

/** A hashtable's keys and values as the options it splats: `@{ Uri = 'https://…'; Method = 'Post'; UseBasicParsing = $true }`. */
function splatted(table) {
    const options = [];
    for (const { words } of splitPwsh(table.slice(2, -1), [], true).filter((statement) => statement.table)) {
        const glued = /^([\w-]+)=(.*)$/s.exec(words[0]);
        const [key, value] = words[1] === '=' ? [words[0], words[2]]
            : glued ? [glued[1], glued[2] || words[1]]
                : words[1]?.startsWith('=') ? [words[0], words[1].slice(1) || words[2]] : [];
        if (key === undefined || /^\$false$/i.test(value ?? '')) continue;
        options.push(`-${key}`, ...(value === undefined || /^\$true$/i.test(value) ? [] : [value]));
    }
    return options;
}

/**
 * Sends said as one, in the order they run, each once: the user allows all
 * of them with one answer, so the prompt names every one.
 */
function combined(list) {
    const seen = new Set();
    const all = list.filter((f) => f && !seen.has(f.what) && seen.add(f.what));
    if (all.length < 2) return all[0] ?? null;
    const whats = all.length > 6 ? [...all.slice(0, 5).map((f) => f.what), `${all.length - 5} more`] : all.map((f) => f.what);
    const unread = [...new Set(all.flatMap((f) => f.unread ?? []))];
    return {
        kind: [...new Set(all.map((f) => f.kind))].join('+'),
        program: [...new Set(all.map((f) => f.program))].join('+'),
        what: listOf(whats),
        ...(unread.length > 0 ? { unread } : {}),
    };
}

/** "A and B", "A, B and C"; with semicolons when one already has a comma ("runs x, which …; and B"). */
function listOf(items) {
    if (items.length < 2) return items[0] ?? '';
    const sep = items.some((w) => w.includes(',')) ? ';' : ',';
    return `${items.slice(0, -1).join(`${sep} `)}${sep === ';' ? ';' : ''} and ${items.at(-1)}`;
}

/**
 * What a shell command sends outside the workspace, or null.
 * @param {string} command - the command line, as the shell tool gets it.
 * @param {object} [options]
 * @param {'bash'|'pwsh'} [options.shell] - which shell runs it.
 * @param {string} [options.cwd] - the folder it runs in, for the files it names.
 * @param {(path: string) => string|undefined} [options.read] - a file's text by its full path, or undefined (only files the caller lets it read).
 * @param {string[]} [options.trustedHosts] - machines the user trusts (`nas`, `user@nas`, `100.64.0.7`, `[fd7a::1]:22`): a send
 *   that reaches only these is none (the user's config.trustedHosts).
 * @param {object[]} [options.trustedSends] - gets each send left out for that, for the caller's log.
 * @returns {{kind: string, what: string, program: string, unread?: string[]}|null} what it sends, said after "it": "sends a POST to
 *   127.0.0.1:8787/deploy (curl)"; `unread` names what it runs that the plugin couldn't see into, when the send rests on a name.
 */
export function sendOf(command, options = {}) {
    if (typeof command !== 'string' || command.trim() === '') return null;
    const ctx = trusting({ depth: 0, cwd: options.cwd, read: options.read }, options);
    return shown(options.shell === 'pwsh' ? pwshLineSendOf(command, ctx) : lineSendOf(command, ctx));
}

/** A context that knows the machines the user trusts (trustedHosts, read as hostOf reads them) and keeps the sends to them (trustedSends). */
function trusting(ctx, { trustedHosts, trustedSends } = {}) {
    if (ctx.trusted || !Array.isArray(trustedHosts)) return ctx;
    const trusted = new Set(trustedHosts.map(hostOf).filter(Boolean));
    return trusted.size === 0 ? ctx : { ...ctx, trusted, trustedSends: Array.isArray(trustedSends) ? trustedSends : [] };
}

/** A send as the user and the coordinator read it: no password or token from a URL, and not the machines it reaches. */
function shown(found) {
    if (!found) return found;
    const send = {
        ...found, program: withoutCredentials(found.program), what: withoutCredentials(found.what),
        ...(found.unread ? { unread: found.unread.map(withoutCredentials) } : {}),
    };
    delete send.hosts;
    return send;
}

/**
 * A send as the prompt says it: what it sends, then, when that rests on a
 * name, that the plugin couldn't see what it runs ("runs ./deploy.sh, whose
 * name says it deploys. The plugin couldn't see what ./deploy.sh runs").
 */
export function described(found) {
    const unread = found?.unread ?? [];
    return unread.length === 0 ? found.what : `${found.what}. The plugin couldn't see what ${listOf(unread)} ${unread.length > 1 ? 'run' : 'runs'}`;
}
