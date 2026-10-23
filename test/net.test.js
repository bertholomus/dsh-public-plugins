import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { netHunks, lineDelta, MAX_NET_DISTANCE, MAX_HUNK_CHANGES } from '../plugins/coordinator/lib/changes.js';
import { NetTexts, canonicalPath, changedPath, expectedAfter, notKept, readSide, MAX_NET_BYTES, NET_KEEP_MS } from '../plugins/coordinator/lib/net.js';

// A thread's net diff per file (plugins/coordinator/lib/changes.js netHunks, net.js): what its edits came to, from the
// file's text before its first edit to its text after its last. The manager's hook and the Changes tab are in
// plugins/coordinator/test/smoke.mjs.

/** A file's lines, as a diff counts them: a last newline ends the last line. */
const lines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
/** A hunk's side as lines, as DSH's diff reads it: '' (or none) has none. */
const sideLines = (text) => (typeof text === 'string' && text !== '' ? text.split('\n') : []);
/** Lines as a file's text. */
const fileText = (list) => (list.length > 0 ? `${list.join('\n')}\n` : '');

/** Put a net diff's hunks back into the old text: each hunk's old side, context and all, is where the diff says. */
function apply(before, hunks) {
    const out = lines(before);
    let at = 0;
    for (const hunk of hunks) {
        const old = sideLines(hunk.oldText);
        const start = old.length === 0 ? at : out.findIndex((_, i) => i >= at && old.every((line, k) => out[i + k] === line));
        assert.ok(start >= 0, `hunk ${JSON.stringify(hunk.oldText)} is in the old text`);
        const fresh = sideLines(hunk.newText);
        out.splice(start, old.length, ...fresh);
        at = start + fresh.length;
    }
    return out;
}

test('net diff: one hunk per run of changes, three lines of context, runs six or fewer lines apart in one', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after = before.replace('l2\n', 'L2\n').replace('l8\n', 'L8\n').replace('l17\n', '');
    const net = netHunks(before, after);
    assert.deepEqual(net, {
        added: 2, deleted: 3,
        hunks: [
            { oldText: 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11', newText: 'l0\nl1\nL2\nl3\nl4\nl5\nl6\nl7\nL8\nl9\nl10\nl11' },
            { oldText: 'l14\nl15\nl16\nl17\nl18\nl19', newText: 'l14\nl15\nl16\nl18\nl19' },
        ],
    });
    assert.deepEqual(apply(before, net.hunks), lines(after));
});

test('net diff: a new file is one hunk of its text; equal texts none; line endings and a last newline don\'t count', () => {
    assert.deepEqual(netHunks(null, 'a\nb\n'), { added: 2, deleted: 0, created: true, hunks: [{ oldText: null, newText: 'a\nb' }] });
    assert.deepEqual(netHunks(null, ''), { added: 0, deleted: 0, created: true, hunks: [] });
    assert.deepEqual(netHunks('a\nb\n', 'a\nb\n'), { added: 0, deleted: 0, hunks: [] });
    assert.deepEqual(netHunks('a\r\nb\r\n', 'a\nb'), { added: 0, deleted: 0, hunks: [] });
    assert.deepEqual(netHunks('', 'x\n'), { added: 1, deleted: 0, hunks: [{ oldText: '', newText: 'x' }] });
    assert.deepEqual(netHunks('x\n', ''), { added: 0, deleted: 1, hunks: [{ oldText: 'x', newText: '' }] });
});

test('net diff: past MAX_NET_DISTANCE differing lines there is none', () => {
    const many = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');
    assert.equal(netHunks(many('a', MAX_NET_DISTANCE), many('b', 1)), null);
    assert.equal(netHunks(many('a', 400), many('b', 400)).added, 400);
});

test('net diff: random edits come back whole, counted as a line diff counts them', () => {
    let seed = 7;
    const random = (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
    };
    let fresh = 0;
    // `few` draws lines from a handful of words, so many lines repeat (the counts must still be a shortest diff's);
    // otherwise each line is its own, so each hunk's old side is found in one place only and the hunks can be put back.
    for (const few of [false, true]) {
        for (let round = 0; round < 300; round++) {
            const word = () => (few ? `w${random(4)}` : `n${fresh++}`);
            const before = Array.from({ length: random(30) }, word);
            const after = [...before];
            for (let k = random(6); k > 0; k--) {
                const at = random(after.length + 1);
                if (random(2) === 0 && after.length > 0) after.splice(Math.min(at, after.length - 1), 1);
                else after.splice(at, 0, word());
            }
            const net = netHunks(fileText(before), fileText(after));
            const text = `${JSON.stringify(before)} → ${JSON.stringify(after)}`;
            assert.deepEqual({ added: net.added, deleted: net.deleted }, lineDelta(before, after), text);
            if (!few) assert.deepEqual(apply(fileText(before), net.hunks), after, text);
        }
    }
});

test('net texts: the path a file-tool call changes, and a file as one side', async () => {
    assert.equal(changedPath('write', { file_path: ' a.md ', content: '' }), 'a.md');
    assert.equal(changedPath('write', { file_path: 'a.md' }), undefined);
    assert.equal(changedPath('edit', { file_path: 'a.md', old_string: 'x', new_string: 'y' }), 'a.md');
    assert.equal(changedPath('str_replace_editor', { command: 'view', path: 'a.md' }), undefined);
    assert.equal(changedPath('str_replace_editor', { command: 'insert', path: 'a.md', new_str: 'x' }), 'a.md');
    assert.equal(changedPath('read', { file_path: 'a.md' }), undefined);
    const dir = mkdtempSync(join(tmpdir(), 'net-side-'));
    assert.deepEqual(await readSide(join(dir, 'none')), { kind: 'absent' });
    writeFileSync(join(dir, 'text'), 'hi\n');
    assert.equal((await readSide(join(dir, 'text'))).text, 'hi\n');
    writeFileSync(join(dir, 'bin'), Buffer.from([104, 0, 105]));
    assert.equal((await readSide(join(dir, 'bin'))).kind, 'binary');
    writeFileSync(join(dir, 'big'), Buffer.alloc(MAX_NET_BYTES + 1, 97));
    assert.deepEqual(await readSide(join(dir, 'big')), { kind: 'large' });
    assert.deepEqual(await readSide(dir), { kind: 'unreadable' });
    // Text that isn't UTF-8: UTF-16 (its byte-order mark) and Latin-1 bytes that don't decode.
    writeFileSync(join(dir, 'utf16'), Buffer.from([0xff, 0xfe, 104, 0, 105, 0]));
    assert.equal((await readSide(join(dir, 'utf16'))).kind, 'encoding');
    writeFileSync(join(dir, 'latin1'), Buffer.from('caf\xe9\n', 'latin1'));
    assert.equal((await readSide(join(dir, 'latin1'))).kind, 'encoding');
    // UTF-8 with a byte-order mark keeps it, so the text kept is the file byte for byte.
    writeFileSync(join(dir, 'bom'), '\uFEFFhi\n');
    assert.equal((await readSide(join(dir, 'bom'))).text, '\uFEFFhi\n');
});

test('net texts: calls on one file run one at a time, each seeing the file as the last one left it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-order-'));
    const net = new NetTexts(join(dir, 'net'));
    const file = join(dir, 'f.txt');
    const seen = [];
    const slow = (text, ms) => net.around('t', file, async () => {
        seen.push(`start ${text}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        writeFileSync(file, `${text}\n`);
        seen.push(`end ${text}`);
    });
    await Promise.all([slow('one', 30), slow('two', 1), slow('three', 1)]);
    assert.deepEqual(seen, ['start one', 'end one', 'start two', 'end two', 'start three', 'end three']);
    assert.deepEqual(await net.view('t', file), { net: { added: 1, deleted: 0, created: true, hunks: [{ oldText: null, newText: 'three' }] } });
    // A big file, or one that isn't text, has no net diff, and says why.
    const big = join(dir, 'big.txt');
    writeFileSync(big, Buffer.alloc(MAX_NET_BYTES + 10, 97));
    await net.around('t', big, async () => writeFileSync(big, 'small\n'));
    assert.deepEqual(await net.view('t', big), { why: 'large' });
});

test('net texts: a file the thread edited before the plugin kept texts has no net diff, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-calls-'));
    const net = new NetTexts(join(dir, 'net'));
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'a\n');
    await net.around('t', file, async () => writeFileSync(file, 'b\n'), 'c1');
    // A call that changed nothing names no edit, and isn't needed for one.
    await net.around('t', file, async () => {}, 'c2');
    await net.around('t', file, async () => writeFileSync(file, 'c\n'), 'c3');
    const whole = { net: { added: 1, deleted: 1, hunks: [{ oldText: 'a', newText: 'c' }] } };
    assert.deepEqual(await net.view('t', file, ['c1', 'c3']), whole);
    assert.deepEqual(await net.view('t', file), whole, 'no records to check against');
    assert.deepEqual(await net.view('t', file, ['c0', 'c1', 'c3']), { why: 'partial' });
    // Read from disk by a new process, the same.
    assert.deepEqual(await new NetTexts(join(dir, 'net')).view('t', file, ['c0', 'c1', 'c3']), { why: 'partial' });
});

test('net texts: a sweep drops threads the store no longer has, those unused for 30 days, then the oldest past the limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-prune-'));
    const root = join(dir, 'net');
    const lines = [];
    const net = new NetTexts(root);
    net.log = (line) => lines.push(line);
    const day = 86400 * 1000;
    const folder = (name, bytes, ageDays, usedDays = undefined) => {
        mkdirSync(join(root, name), { recursive: true });
        const index = join(root, name, 'index.json');
        writeFileSync(index, JSON.stringify({ version: 1, bytes, files: {}, ...(usedDays === undefined ? {} : { used: Date.now() - usedDays * day }) }));
        const at = (Date.now() - ageDays * day) / 1000;
        utimesSync(index, at, at);
    };
    folder('stale', 10, 40);
    folder('viewed', 10, 40, 2);
    folder('old', 300 * 1024 * 1024, 20);
    folder('mid', 200 * 1024 * 1024, 10);
    folder('new', 100 * 1024 * 1024, 1);
    folder('gone', 10, 1);
    writeFileSync(join(root, 'not.a.thread'), 'x');
    // A store with no threads (as one that failed to load) leaves them all.
    assert.deepEqual(await new NetTexts(root).prune(new Set()), []);
    assert.ok(NET_KEEP_MS === 30 * day);
    // Gone from the store; unused for over 30 days (its index's `used`, else its time: a view counts as use); then,
    // past 512 MB in all, the one used longest ago.
    assert.deepEqual(await net.prune(new Set(['stale', 'viewed', 'old', 'mid', 'new'])), ['gone', 'stale', 'old']);
    assert.deepEqual(readdirSync(root).sort(), ['mid', 'new', 'not.a.thread', 'viewed']);
    assert.deepEqual(lines, ['net-prune gone gone', 'net-prune stale unused', 'net-prune old oldest']);
    // A sweep runs again whenever it is called (every hour), one after another.
    const [one, two] = [net.prune(new Set(['viewed', 'new'])), net.prune(new Set(['viewed']))];
    assert.deepEqual(await one, ['mid']);
    assert.deepEqual(await two, ['new']);
    assert.deepEqual(readdirSync(root).sort(), ['not.a.thread', 'viewed']);
});

test('net texts: a thread whose call is still running keeps its index in memory, however many threads come after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-lru-'));
    const net = new NetTexts(join(dir, 'net'));
    const file = join(dir, 'f.txt');
    let finish;
    const held = new Promise((resolve) => { finish = resolve; });
    const slow = net.around('a', file, async () => { await held; writeFileSync(file, 'a\n'); }, 'ca');
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 60; i++) await net.around(`t${i}`, join(dir, `g${i}.txt`), async () => writeFileSync(join(dir, `g${i}.txt`), 'x\n'), `c${i}`);
    assert.ok(net.indexes.has('a'));
    assert.ok(net.indexes.size <= 51, `${net.indexes.size} indexes`);
    finish();
    await slow;
    assert.deepEqual(await net.view('a', file, ['ca']), { net: { added: 1, deleted: 0, created: true, hunks: [{ oldText: null, newText: 'a' }] } });
});

test('net diff: a hunk has at most MAX_HUNK_CHANGES changed lines, as DSH\'s diff view draws them line by line', () => {
    const many = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    // One run of 300 lines replaced: in pieces, one after another, with no line shown twice.
    const before = fileText([...many('a', 10), ...many('x', 300), ...many('z', 10)]);
    const after = fileText([...many('a', 10), ...many('y', 300), ...many('z', 10)]);
    const net = netHunks(before, after);
    assert.deepEqual([net.added, net.deleted, net.hunks.length], [300, 300, 3]);
    for (const hunk of net.hunks) assert.deepEqual(lineDelta(sideLines(hunk.oldText), sideLines(hunk.newText)).added + lineDelta(sideLines(hunk.oldText), sideLines(hunk.newText)).deleted <= MAX_HUNK_CHANGES, true);
    assert.deepEqual(apply(before, net.hunks), lines(after));
    // Many small changes close together share hunks only while they have room.
    const rows = many('l', 400);
    const net2 = netHunks(fileText(rows), fileText(rows.map((l, i) => (i % 2 ? l.toUpperCase() : l))));
    assert.deepEqual([net2.added, net2.deleted], [200, 200]);
    assert.ok(net2.hunks.length >= 2);
    assert.deepEqual(apply(fileText(rows), net2.hunks), rows.map((l, i) => (i % 2 ? l.toUpperCase() : l)));
    // Mostly deletes: still at most 200 a hunk.
    const net3 = netHunks(fileText(many('d', 500)), fileText(many('e', 10)));
    assert.deepEqual([net3.added, net3.deleted], [10, 500]);
    assert.ok(net3.hunks.every((hunk) => sideLines(hunk.oldText).length + sideLines(hunk.newText).length <= MAX_HUNK_CHANGES));
});

test('net texts: what a call should leave, as DSH\'s write, edit and editor work it out', () => {
    const left = (name, args, before) => expectedAfter(name, args)?.(before);
    assert.equal(left('write', { file_path: 'a', content: 'x\r\n' }, 'old'), 'x\r\n');
    assert.equal(left('str_replace_editor', { command: 'create', path: 'a', file_text: 'new' }, null), 'new');
    // edit: CRLF read as LF, its one match replaced, the file's line endings put back; a UTF-8 mark dropped.
    assert.equal(left('edit', { old_string: 'b\r\nc', new_string: 'B\nC' }, 'a\r\nb\r\nc\r\n'), 'a\r\nB\r\nC\r\n');
    assert.equal(left('edit', { old_string: 'b', new_string: 'B' }, '﻿a\nb\n'), 'a\nB\n');
    assert.equal(left('edit', { old_string: 'a', new_string: 'A' }, 'a a'), undefined, 'two matches: DSH refuses it');
    assert.equal(left('edit', { old_string: 'a', new_string: 'A', replace_all: true }, 'a a'), 'A A');
    assert.equal(left('edit', { old_string: 'q', new_string: 'Q' }, 'a'), undefined);
    assert.equal(left('edit', { old_string: 'a', new_string: 'A' }, null), undefined);
    assert.equal(left('str_replace_editor', { command: 'str_replace', old_str: 'x', new_str: 'y' }, 'axb'), 'ayb');
    assert.equal(left('str_replace_editor', { command: 'str_replace', old_str: 'x' }, 'axb'), 'ab');
    assert.equal(left('str_replace_editor', { command: 'insert', insert_line: 1, new_str: 'NEW' }, 'one\ntwo\n'), 'one\nNEW\ntwo\n');
    assert.equal(expectedAfter('str_replace_editor', { command: 'view', path: 'a' }), undefined);
    assert.equal(expectedAfter('bash', { command: 'true' }), undefined);
});

test('net texts: only files in the thread\'s folders are kept, never DSH\'s own folder or a likely secret', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'net-scope-')));
    const work = join(dir, 'work');
    const other = join(dir, 'other');
    mkdirSync(join(work, 'src'), { recursive: true });
    mkdirSync(other);
    const home = process.env.DSH_HOME;
    process.env.DSH_HOME = join(work, '.dsh');
    try {
        assert.equal(notKept(join(work, 'src', 'a.js'), [work]), undefined);
        assert.equal(notKept(join(work, 'new', 'deeper', 'b.md'), [work]), undefined, 'a file in folders not made yet');
        assert.equal(notKept(join(other, 'a.js'), [work]), 'outside');
        assert.equal(notKept(join(work, '..', 'other', 'a.js'), [work]), 'outside', '.. resolved');
        assert.equal(notKept(work, [work]), 'outside', 'the folder itself');
        assert.equal(notKept(join(work, 'a.js'), []), 'outside');
        // A link inside the folder to a file outside it is the file outside it; a folder opened through a link is the folder.
        writeFileSync(join(other, 'target.txt'), 'x');
        symlinkSync(join(other, 'target.txt'), join(work, 'link.txt'));
        assert.equal(notKept(join(work, 'link.txt'), [work]), 'outside');
        symlinkSync(work, join(dir, 'work-link'));
        assert.equal(notKept(join(dir, 'work-link', 'src', 'new.js'), [work]), undefined);
        assert.equal(notKept(join(work, 'src', 'new.js'), [join(dir, 'work-link')]), undefined);
        // DSH's own folder, even inside the workspace.
        assert.equal(notKept(join(work, '.dsh', 'credentials.yaml'), [work]), 'outside');
        // Names and folders that may hold secrets.
        for (const name of ['.env', '.env.local', '.envrc', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'tls.key', 'keystore.p12', 'cert.pfx',
            '.npmrc', '.netrc', '.pgpass', 'aws-credentials.json', 'client_secret.json', 'vault.kdbx']) {
            assert.equal(notKept(join(work, name), [work]), 'secret', name);
        }
        for (const path of [['.ssh', 'config'], ['.aws', 'config'], ['deploy', '.kube', 'config'], ['.gnupg', 'pubring.kbx']]) {
            assert.equal(notKept(join(work, ...path), [work]), 'secret', path.join('/'));
        }
        for (const name of ['environment.md', 'keys.js', 'monkey.txt', 'README.md', 'src/env.ts']) assert.equal(notKept(join(work, name), [work]), undefined, name);
        // A new file under a link to a folder not made yet keys as the call and the view both see it.
        assert.equal(canonicalPath(join(dir, 'work-link', 'fresh', 'sub', 'n.txt')), join(work, 'fresh', 'sub', 'n.txt'));
    } finally {
        if (home === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = home;
    }
});

test('net texts: a call that fails, or that DSH refuses, keeps nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-fail-'));
    const net = new NetTexts(join(dir, 'net'));
    const file = join(dir, 'plan.md');
    writeFileSync(file, 'plan\n');
    // Refused (DSH's result is an error, as for an edit of a file not read first), and thrown: no entry, no text.
    const refused = await net.around('t', file, async () => ({ isError: true, content: [{ type: 'text', text: 'read it first' }] }), 'c1');
    assert.deepEqual(refused, { isError: true, content: [{ type: 'text', text: 'read it first' }] });
    await assert.rejects(net.around('t', file, async () => { throw new Error('disk full'); }, 'c2'), /disk full/);
    assert.deepEqual(readdirSync(join(net.root, 't')), ['index.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(net.root, 't', 'index.json'), 'utf8')).files, {});
    assert.equal(JSON.parse(readFileSync(join(net.root, 't', 'index.json'), 'utf8')).bytes, 0);
    assert.deepEqual(await net.view('t', file), { why: 'none' });
    // Once the thread has changed it, a failed call leaves its texts as they were.
    await net.around('t', file, async () => writeFileSync(file, 'plan B\n'), 'c3', expectedAfter('write', { content: 'plan B\n' }));
    await net.around('t', file, async () => ({ isError: true }), 'c4');
    assert.deepEqual(await net.view('t', file, ['c3']), { net: { added: 1, deleted: 1, hunks: [{ oldText: 'plan', newText: 'plan B' }] } });
});

test('net texts: a file another writer changes while the thread\'s call runs is mixed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-race-'));
    const net = new NetTexts(join(dir, 'net'));
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'one\ntwo\nthree\n');
    const args = { file_path: file, old_string: 'one', new_string: 'ONE' };
    await net.around('a', file, async () => {
        writeFileSync(file, 'ONE\ntwo\nthree\n');
        // Another thread writes line 3 before this call is done.
        writeFileSync(file, 'ONE\ntwo\nTHREE-by-B\n');
    }, 'a1', expectedAfter('edit', args));
    assert.deepEqual(await net.view('a', file, ['a1']), { why: 'mixed' });
    // What the call should have left: its one diff.
    const clean = join(dir, 'g.txt');
    writeFileSync(clean, 'one\r\ntwo\r\n');
    await net.around('a', clean, async () => writeFileSync(clean, 'ONE\r\ntwo\r\n'), 'a2', expectedAfter('edit', { ...args, file_path: clean }));
    assert.deepEqual(await net.view('a', clean, ['a2']), { net: { added: 1, deleted: 1, hunks: [{ oldText: 'one\ntwo', newText: 'ONE\ntwo' }] } });
});

test('net texts: a diff with no lines changed says why: undone, a new empty file, or only line endings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-same-'));
    const net = new NetTexts(join(dir, 'net'));
    const undone = join(dir, 'u.txt');
    writeFileSync(undone, 'a\n');
    await net.around('t', undone, async () => writeFileSync(undone, 'b\n'), 'c1');
    await net.around('t', undone, async () => writeFileSync(undone, 'a\n'), 'c2');
    assert.deepEqual(await net.view('t', undone, ['c1', 'c2']), { net: { added: 0, deleted: 0, hunks: [], undone: true } });
    const empty = join(dir, '__init__.py');
    await net.around('t', empty, async () => writeFileSync(empty, ''), 'c3');
    assert.deepEqual(await net.view('t', empty, ['c3']), { net: { added: 0, deleted: 0, created: true, hunks: [], empty: true } });
    const endings = join(dir, 'e.txt');
    writeFileSync(endings, 'a\nb\n');
    await net.around('t', endings, async () => writeFileSync(endings, 'a\r\nb'), 'c4');
    assert.deepEqual(await net.view('t', endings, ['c4']), { net: { added: 0, deleted: 0, hunks: [], endings: true } });
});

test('net texts: a diff with edits the records don\'t list says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-unlisted-'));
    const net = new NetTexts(join(dir, 'net'));
    const file = join(dir, 'f.txt');
    await net.around('t', file, async () => writeFileSync(file, 'a\n'), 'mine');
    await net.around('t', file, async () => writeFileSync(file, 'a\nb\n'), 'deep-subagent');
    const whole = { added: 2, deleted: 0, created: true, hunks: [{ oldText: null, newText: 'a\nb' }] };
    assert.deepEqual(await net.view('t', file, ['mine', 'deep-subagent']), { net: whole });
    assert.deepEqual(await net.view('t', file, ['mine']), { net: { ...whole, unlisted: true } });
    assert.deepEqual(await net.view('t', file, []), { net: whole }, 'no call ids to check against');
});

test('net texts: the caps hold for calls at once, and say which was reached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-caps-'));
    const net = new NetTexts(join(dir, 'net'));
    net.limits = { ...net.limits, files: 3, threadBytes: 40 };
    const files = Array.from({ length: 6 }, (_, i) => join(dir, `f${i}.txt`));
    for (const file of files) writeFileSync(file, '0123456789\n');
    await Promise.all(files.map((file, i) => net.around('t', file, async () => writeFileSync(file, '0123456789\nmore\n'), `c${i}`)));
    const index = JSON.parse(readFileSync(join(net.root, 't', 'index.json'), 'utf8'));
    assert.equal(Object.keys(index.files).length, 3, 'no more files than the cap');
    assert.ok(index.bytes <= 40, `${index.bytes} bytes`);
    const views = await Promise.all(files.map((file) => net.view('t', file)));
    assert.equal(views.filter((v) => v.why === 'many').length, 3);
    assert.ok(views.some((v) => v.why === 'full'), JSON.stringify(views));
});

test('net texts: a call inside another on the same file runs as it is; folders are private even when they were there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-nest-'));
    const root = join(dir, 'net');
    mkdirSync(join(root, 't'), { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    chmodSync(join(root, 't'), 0o755);
    const net = new NetTexts(root);
    const file = join(dir, 'f.txt');
    const outcome = await Promise.race([
        net.around('t', file, () => net.around('t', file, async () => { writeFileSync(file, 'x\n'); return 'inner'; }, 'in'), 'out'),
        new Promise((resolve) => setTimeout(() => resolve('stuck'), 1500)),
    ]);
    assert.equal(outcome, 'inner');
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, 't')).mode & 0o777, 0o700);
    assert.ok(existsSync(join(root, 't', 'index.json')));
});
