/**
 * The desktop window's sign-in cookie, read from its cookie jar.
 *
 * DSH's server names its sign-in cookie after the address the browser used:
 * `dsh-auth-` + base64url(sha256(host:port)) (both 0.2.0 and 0.2.1). The
 * desktop window signs in on 127.0.0.1 at each start, and its Electron
 * cookie jar (an SQLite file) keeps the cookie. The edge reads it with the
 * `sqlite3` program, read-only, and never writes the jar, logs the value or
 * sends it to a device: it goes upstream, to DSH, only.
 *
 * @module dsh-plugin-dsh-site/cookie
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

/** The sign-in cookie's name for one authority (`127.0.0.1:52817`). */
export function cookieName(authority) {
    return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;
}

/** The query: every DSH sign-in cookie for loopback, with whether its value is kept encrypted. */
export const JAR_QUERY = "select name, value, length(encrypted_value) from cookies where host_key in ('127.0.0.1','localhost') and name like 'dsh-auth-%';";

/**
 * What the jar holds for `authority`, from sqlite3's output (`name|value|n` lines).
 * @returns {{ status: 'found', cookie: string } | { status: 'missing' | 'encrypted', others: number }}
 */
export function pickCookie(stdout, authority) {
    const wanted = cookieName(authority);
    const rows = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const first = line.indexOf('|');
        const last = line.lastIndexOf('|');
        if (first <= 0 || last <= first) return undefined;
        return { name: line.slice(0, first), value: line.slice(first + 1, last), encrypted: Number(line.slice(last + 1)) > 0 };
    }).filter(Boolean);
    const row = rows.find((r) => r.name === wanted);
    if (!row) return { status: 'missing', others: rows.length };
    if (!row.value && row.encrypted) return { status: 'encrypted', others: rows.length - 1 };
    if (!row.value || !/^[\x21-\x7e]+$/.test(row.value) || row.value.includes(';')) return { status: 'missing', others: rows.length - 1 };
    return { status: 'found', cookie: `${row.name}=${row.value}` };
}

/** sqlite3's error text in plain words (no paths, no command lines). */
export function jarErrorWords(error) {
    const text = String(error?.stderr || error?.message || error || '');
    if (error?.code === 'ENOENT' && /spawn/i.test(text)) return 'the sqlite3 program is missing (it comes with macOS; on other systems install it, or set injectAuthCookie to false)';
    if (/attempt to write a readonly|readonly database|SQLITE_READONLY/i.test(text)) return 'the cookie jar cannot be read without writing to it (dsh-site opens it read-only only); quit and reopen DSH, then try again';
    if (/unable to open|no such file|cannot open/i.test(text)) return 'the cookie jar file (cookieJar) does not exist or cannot be opened read-only';
    if (/no such table/i.test(text)) return 'the cookie jar file (cookieJar) is not a browser cookie database (it has no cookies table)';
    if (/locked|busy/i.test(text)) return 'the cookie jar is busy; dsh-site tries again at the next request';
    if (/not a database|malformed|encrypted/i.test(text)) return 'the cookie jar file (cookieJar) is not a readable SQLite database';
    if (error?.killed || /timed out|ETIMEDOUT/i.test(text)) return 'reading the cookie jar took more than 5 seconds';
    return 'the cookie jar could not be read';
}

/**
 * Read the jar (sqlite3 -readonly, 5 s at most). Never any other way: a plain
 * open can write the file (it rolls back a journal Electron left), so when the
 * read-only open fails, that is the answer, in words.
 * @param {string} jar - the jar's path.
 * @param {string} authority - DSH's loopback host:port.
 * @param {typeof execFile} [run] - for tests.
 * @returns {Promise<object>} found (with the cookie), missing, encrypted, or error (with the reason in words)
 */
export async function readJar(jar, authority, run = execFile, stat = statSync) {
    // sqlite3 opens a missing file as an empty database, which would read as "no cookies table".
    try {
        if (!stat(jar).isFile()) return { status: 'error', reason: 'the cookie jar (cookieJar) is not a file' };
    } catch {
        return { status: 'error', reason: 'the cookie jar file (cookieJar) does not exist' };
    }
    const once = (args) => new Promise((resolve) => {
        try {
            run('sqlite3', [...args, jar, JAR_QUERY], { timeout: 5000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
                if (error && stderr && !error.stderr) error.stderr = stderr;
                resolve({ error, stdout });
            });
        } catch (error) {
            resolve({ error, stdout: '' });
        }
    });
    const got = await once(['-readonly']);
    if (got.error) return { status: 'error', reason: jarErrorWords(got.error) };
    return pickCookie(got.stdout, authority);
}
