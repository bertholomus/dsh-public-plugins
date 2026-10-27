import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookieName, jarErrorWords, JAR_QUERY, pickCookie, readJar } from '../../lib/cookie.js';

test('the cookie name is DSH\'s own: dsh-auth- + base64url(sha256(host:port))', () => {
    // The same formula as DSH's client-connection (cookieName in 0.2.0-rc.2 and 0.2.1-rc.1).
    const dsh = (authority) => `dsh-auth-${Buffer.from(createHash('sha256').update(authority).digest()).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
    for (const a of ['127.0.0.1:52817', '127.0.0.1:40123', 'localhost:80']) assert.equal(cookieName(a), dsh(a));
    assert.notEqual(cookieName('127.0.0.1:52817'), cookieName('127.0.0.1:52818'), 'one cookie per port');
});

test('pickCookie takes the row for this authority only', () => {
    const mine = cookieName('127.0.0.1:52817');
    const other = cookieName('127.0.0.1:40000');
    const out = `${other}|old.value|0\n${mine}|v1.abc_DEF-123|0\n`;
    assert.deepEqual(pickCookie(out, '127.0.0.1:52817'), { status: 'found', cookie: `${mine}=v1.abc_DEF-123` });
    assert.deepEqual(pickCookie(out, '127.0.0.1:50000'), { status: 'missing', others: 2 }, 'another port\'s cookie is never sent');
    assert.deepEqual(pickCookie('', '127.0.0.1:52817'), { status: 'missing', others: 0 });
    assert.equal(pickCookie(`${mine}||64\n`, '127.0.0.1:52817').status, 'encrypted');
    assert.equal(pickCookie(`${mine}|bad value;x|0\n`, '127.0.0.1:52817').status, 'missing', 'a value that cannot be a cookie is not sent');
    assert.equal(pickCookie('garbage line\n', '127.0.0.1:52817').status, 'missing');
});

test('readJar opens the jar read-only, and only read-only: a failed read-only open is the answer, never a plain open', async () => {
    const calls = [];
    const name = cookieName('127.0.0.1:1234');
    const ok = (args, opts, cb) => cb(null, `${name}|val|0\n`, '');
    const run1 = (cmd, args, opts, cb) => { calls.push(args); ok(args, opts, cb); };
    const isFile = () => ({ isFile: () => true });
    assert.deepEqual(await readJar('/jar', '127.0.0.1:1234', run1, isFile), { status: 'found', cookie: `${name}=val` });
    assert.deepEqual(calls, [['-readonly', '/jar', JAR_QUERY]]);

    calls.length = 0;
    const run2 = (cmd, args, opts, cb) => {
        calls.push(args);
        if (args[0] === '-readonly') cb(Object.assign(new Error('Command failed'), { stderr: 'Error: unable to open database "/jar": unable to open database file' }), '', '');
        else ok(args, opts, cb);
    };
    const failed = await readJar('/jar', '127.0.0.1:1234', run2, isFile);
    assert.equal(failed.status, 'error');
    assert.match(failed.reason, /cannot be opened read-only/);
    assert.deepEqual(calls.map((a) => a[0]), ['-readonly'], 'no second, writable open');
    const run2b = (cmd, args, opts, cb) => cb(Object.assign(new Error('Command failed'), { stderr: 'Error: attempt to write a readonly database' }), '', '');
    assert.match((await readJar('/jar', '127.0.0.1:1234', run2b, isFile)).reason, /cannot be read without writing to it/);

    const run3 = (cmd, args, opts, cb) => cb(Object.assign(new Error('spawn sqlite3 ENOENT'), { code: 'ENOENT' }), '', '');
    assert.deepEqual(await readJar('/jar', '127.0.0.1:1234', run3, isFile), { status: 'error', reason: jarErrorWords(Object.assign(new Error('spawn sqlite3 ENOENT'), { code: 'ENOENT' })) });
    const run4 = () => { throw new Error('boom'); };
    assert.equal((await readJar('/jar', '127.0.0.1:1234', run4, isFile)).status, 'error', 'a throw is an answer, never a crash');
    assert.deepEqual(await readJar('/jar', '127.0.0.1:1234', run1, () => { throw new Error('ENOENT'); }), { status: 'error', reason: 'the cookie jar file (cookieJar) does not exist' });
    assert.deepEqual(await readJar('/jar', '127.0.0.1:1234', run1, () => ({ isFile: () => false })), { status: 'error', reason: 'the cookie jar (cookieJar) is not a file' });
});

test('jar errors in words, with no path or command line', () => {
    const cases = [
        [{ code: 'ENOENT', message: 'spawn sqlite3 ENOENT' }, /sqlite3 program is missing/],
        [{ stderr: 'Error: unable to open database "/Users/x/Cookies": unable to open database file' }, /does not exist or cannot be opened read-only/],
        [{ stderr: 'Error: in prepare, no such table: cookies' }, /not a browser cookie database/],
        [{ stderr: 'Error: database is locked' }, /busy/],
        [{ stderr: 'Error: file is not a database' }, /not a readable SQLite database/],
        [{ killed: true, message: 'Command failed' }, /more than 5 seconds/],
        [{ message: 'something else entirely /Users/x' }, /could not be read/],
    ];
    for (const [error, words] of cases) {
        const text = jarErrorWords(error);
        assert.match(text, words);
        assert.doesNotMatch(text, /\/Users|select /i);
    }
});

test('readJar against a real SQLite jar (the sqlite3 program), never writing it', { skip: !hasSqlite() && 'no sqlite3 program' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-site-jar-'));
    try {
        const jar = join(dir, 'Cookies');
        const authority = '127.0.0.1:41234';
        const name = cookieName(authority);
        execFileSync('sqlite3', [jar, `pragma journal_mode=wal; create table cookies(host_key text, name text, value text, encrypted_value blob);
            insert into cookies values('127.0.0.1','${name}','v2.signed-value_123', x'');
            insert into cookies values('127.0.0.1','${cookieName('127.0.0.1:1')}','other', x'');
            insert into cookies values('example.com','${name}','not-loopback', x'');`]);
        const before = readFileSync(jar);
        const mtime = statSync(jar).mtimeMs;
        assert.deepEqual(await readJar(jar, authority), { status: 'found', cookie: `${name}=v2.signed-value_123` });
        assert.deepEqual(await readJar(jar, '127.0.0.1:9'), { status: 'missing', others: 2 });
        assert.equal((await readJar(join(dir, 'nope'), authority)).status, 'error');
        assert.match((await readJar(join(dir, 'nope'), authority)).reason, /does not exist/);
        assert.deepEqual(readFileSync(jar), before, 'the jar is byte for byte the same');
        assert.equal(statSync(jar).mtimeMs, mtime);
        execFileSync('sqlite3', [join(dir, 'empty'), 'create table other(x);']);
        assert.match((await readJar(join(dir, 'empty'), authority)).reason, /not a browser cookie database/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

function hasSqlite() {
    try {
        execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
