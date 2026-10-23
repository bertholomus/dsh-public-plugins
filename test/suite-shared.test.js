// The suite's shared code (shared/): words, the change hub, the event log, files and guards, the window kit,
// and the check that every plugin's copy is current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askIn, asksForAnswer, asksSomeone, blockedIn, count, cutOff, decisionIn, plainError, recommendationIn, spanWords, stateWord, timeWords } from '../shared/host/words.js';
import { Hub } from '../shared/host/hub.js';
import { Journal } from '../shared/host/journal.js';
import { JsonStore, ensurePrivateDir, readJson, writeAtomic } from '../shared/host/files.js';
import { clip, errorText, guard, later } from '../shared/host/safe.js';
import { SUITE, kitBlock, plannedCopies } from '../scripts/sync-shared.mjs';
import { suiteKit } from '../shared/client-kit.js';
import { OTHER_NAMES, standInReact, statefulReact, elementsOf, textIn } from './helpers/client.mjs';
import { settle } from './helpers/clock.mjs';
import { tempDir } from './helpers/temp.mjs';

const temp = () => tempDir('suite-shared');

/** Every .js file under a folder of the repo, by walking it (no git needed, so a copy without .git tests the same). */
function jsFilesUnder(relative) {
    const root = new URL('..', import.meta.url).pathname;
    const out = [];
    const walk = (dir) => {
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.e2e' || entry.name.startsWith('.')) continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith('.js')) out.push(path);
        }
    };
    walk(relative);
    return out.sort();
}

// ── Words ─────────────────────────────────────────────────────────────

test('words: a session\'s state in one set of words', () => {
    assert.equal(stateWord({ status: 'running', state: {} }), 'running');
    assert.equal(stateWord({ status: 'running', state: { approvals: [{ id: 'a' }] } }), 'waiting for approval');
    assert.equal(stateWord({ status: 'running', state: { asking: { call: 'q1', question: 'Which branch?' } } }), 'waiting for your answer');
    assert.equal(stateWord({ status: 'idle', state: { asking: { call: 'q1' }, end: { kind: 'completed' } } }), 'idle', 'only a running turn waits on the question box');
    assert.equal(stateWord({ status: 'cold', state: { open: true } }), 'cut off');
    assert.equal(stateWord({ status: 'cold', state: { end: { kind: 'interrupted' } } }), 'cut off');
    assert.equal(stateWord({ status: 'idle', state: { end: { kind: 'aborted', cause: 'disposed' } } }), 'cut off');
    assert.equal(stateWord({ status: 'idle', state: { end: { kind: 'aborted', cause: 'user' } } }), 'stopped');
    assert.equal(stateWord({ status: 'idle', state: { end: { kind: 'error' } } }), 'failed');
    assert.equal(stateWord({ status: 'idle', state: { end: { kind: 'blocked' } } }), 'blocked');
    assert.equal(stateWord({ status: 'idle', state: { end: { kind: 'max-tokens' } } }), 'cut short');
    assert.equal(stateWord({ status: 'idle', state: { end: { kind: 'completed' } } }), 'idle');
    assert.equal(stateWord({ status: 'cold', blank: true, state: null }), 'new');
    assert.equal(stateWord({ external: { status: 'waiting on you' }, status: 'idle' }), 'waiting on you');
    assert.equal(stateWord(undefined), 'unknown');
    assert.equal(cutOff(undefined), false);
});

test('words: decision lines, in every way agents write them', () => {
    assert.deepEqual(decisionIn('Done.\nDECISION NEEDED: ship the parser? — recommend: yes, behind a flag'), { question: 'ship the parser?', recommendation: 'yes, behind a flag' });
    assert.deepEqual(decisionIn('**DECISION NEEDED: pick a port -- recommend: 8080**'), { question: 'pick a port', recommendation: '8080' });
    assert.deepEqual(decisionIn('> DECISION NEEDED: which branch? - recommendation: main'), { question: 'which branch?', recommendation: 'main' });
    assert.deepEqual(decisionIn('DECISION NEEDED: drop the cache?'), { question: 'drop the cache?' });
    assert.deepEqual(decisionIn('DECISION NEEDED: first? — recommend: a\nmore text\nDECISION NEEDED: second? — recommend: b'), { question: 'second?', recommendation: 'b' }, 'the last line wins');
    assert.equal(decisionIn('No decision here.'), undefined);
    assert.equal(decisionIn(42), undefined);
    assert.equal(decisionIn('DECISION NEEDED:   '), undefined);
    // Bold and code marks the way models write them, and a recommendation on its own line.
    assert.deepEqual(decisionIn('**DECISION NEEDED:** Ship today or Monday? — recommend: Monday'), { question: 'Ship today or Monday?', recommendation: 'Monday' });
    assert.deepEqual(decisionIn('**DECISION NEEDED**: Ship today or Monday? — **recommend:** *Monday*'), { question: 'Ship today or Monday?', recommendation: 'Monday' });
    assert.deepEqual(decisionIn('DECISION NEEDED: keep `file_name.py`? — recommend: __keep it__'), { question: 'keep file_name.py?', recommendation: 'keep it' });
    assert.deepEqual(decisionIn('DECISION NEEDED: Ship today or Monday?\n\n**Recommendation:** Monday'), { question: 'Ship today or Monday?', recommendation: 'Monday' });
    assert.deepEqual(decisionIn('DECISION NEEDED: Ship today or Monday?\nThe rest of the notes.'), { question: 'Ship today or Monday?' });
    assert.deepEqual(blockedIn('**BLOCKED:** the staging password expired'), 'the staging password expired');
});

test('words: markers after a sentence\'s end, in list items and with closing stops, as real replies put them', () => {
    // From a real reply in DSH Test (Decisions round 1): the marker closes the last sentence of the last line.
    const real = 'I checked the deploy script and the staging host.\n\nThe SSH key in `deploy/.env` is rejected (Permission denied (publickey)), and the database URL points at a host that does not resolve, so I cannot proceed without valid credentials. BLOCKED: working staging credentials (or an approved SSH/database login) for the staging server.';
    assert.equal(blockedIn(real), 'working staging credentials (or an approved SSH/database login) for the staging server.');
    assert.deepEqual(askIn(real), { kind: 'blocked', question: 'working staging credentials (or an approved SSH/database login) for the staging server.' });
    assert.equal(asksForAnswer(real), true, 'it waits on an answer');
    assert.equal(blockedIn('Tried twice. **BLOCKED:** the bucket refuses writes.'), 'the bucket refuses writes.');
    assert.equal(blockedIn('Done what I can! BLOCKED: need the API key'), 'need the API key');
    assert.equal(blockedIn('"It says no." BLOCKED: no access'), 'no access', 'after a closing quote');
    assert.equal(blockedIn('1. BLOCKED: waiting for the vendor'), 'waiting for the vendor', 'a numbered list item');
    assert.equal(blockedIn('### BLOCKED: no staging access'), 'no staging access', 'a heading');
    // Inline decision lines keep their recommendation.
    assert.deepEqual(decisionIn('Both work. DECISION NEEDED: Postgres or SQLite? — recommend: SQLite.'), { question: 'Postgres or SQLite?', recommendation: 'SQLite' });
    assert.deepEqual(decisionIn('Compared them. **DECISION NEEDED:** ship today or Monday? Recommend: Monday.'), { question: 'ship today or Monday?', recommendation: 'Monday' });
    assert.deepEqual(decisionIn('Two options. Decision needed: keep the cache or drop it? I\'d recommend dropping it.'), { question: 'keep the cache or drop it?', recommendation: 'dropping it' });
    assert.deepEqual(decisionIn('- DECISION NEEDED: which port? — recommend: 8080'), { question: 'which port?', recommendation: '8080' }, 'a list item');
    assert.deepEqual(decisionIn('2) DECISION NEEDED: retry now? My recommendation: wait an hour.'), { question: 'retry now?', recommendation: 'wait an hour' });
    assert.deepEqual(askIn('Plan ready. DECISION NEEDED: run the migration tonight? — recommend: yes, after 10 PM'), { kind: 'decision', question: 'run the migration tonight?', recommendation: 'yes, after 10 PM' });
    // Not markers: inside a sentence, lowercase blocked, or an inline mention far above the end.
    assert.equal(blockedIn('The request was BLOCKED: by the firewall, so I used the mirror.'), undefined);
    assert.equal(blockedIn('Two tasks are done. blocked: none.'), undefined);
    assert.equal(blockedIn(`Earlier I wrote "Stop. BLOCKED: x" as an example.\n${'More notes.\n'.repeat(8)}All done.`), undefined, 'inline only in the last lines');
    assert.equal(blockedIn(`BLOCKED: the old blocker\n${'More notes.\n'.repeat(8)}All done.`), 'the old blocker', 'a line that starts with it counts anywhere, as before');
    assert.equal(decisionIn('The decision needed: none, it is done.'), undefined);
    assert.equal(asksForAnswer('All good. The request was BLOCKED: by the firewall, so I used the mirror.'), false);
});

test('words: a recommendation at the end of free text, as a thread hands back, split from what it asks', () => {
    assert.deepEqual(recommendationIn('Two ports are free. Which should the dev server use? Recommendation: 8080 — it matches the docs.'),
        { question: 'Two ports are free. Which should the dev server use?', recommendation: '8080 — it matches the docs' });
    assert.deepEqual(recommendationIn('Found both configs (src/a.yml, src/b.yml).\nWhich one wins? I recommend src/a.yml.'),
        { question: 'Found both configs (src/a.yml, src/b.yml).\nWhich one wins?', recommendation: 'src/a.yml' });
    assert.deepEqual(recommendationIn('Keep the old API or remove it?\n**Recommend:** remove it'), { question: 'Keep the old API or remove it?', recommendation: 'remove it' });
    assert.deepEqual(recommendationIn('Ship tonight or Monday — recommend: Monday'), { question: 'Ship tonight or Monday', recommendation: 'Monday' });
    assert.equal(recommendationIn('Which port should it use?'), undefined, 'no recommendation');
    assert.equal(recommendationIn('Recommendation: 8080'), undefined, 'nothing asked before it');
    assert.equal(recommendationIn('I recommend 8080 in the README.\nWhich port should it use?'), undefined, 'only the last line');
    assert.equal(recommendationIn('We followed the recommended setup and it works.'), undefined, 'a word in a sentence');
    assert.equal(recommendationIn(undefined), undefined);
});

test('words: whether a reply ends by asking a person, read from its last lines', () => {
    for (const ask of [
        'I can do either.\nWhich do you prefer?',
        'Ready.\nDECISION NEEDED: deploy? — recommend: yes',
        'BLOCKED: the token expired.',
        'Tests pass. Let me know if you want the docs too.',
        'Should I push the branch.',
        'Waiting for your go before the migration.',
        'Shall I continue with **the next step?**',
    ]) assert.equal(asksSomeone(ask), true, ask);
    for (const statement of [
        'Is it fast? Yes: 40 ms.\nAll tests pass; next I write the docs.',
        'Done. 12 tests pass.',
        '',
        undefined,
    ]) assert.equal(asksSomeone(statement), false, String(statement));
    assert.equal(asksSomeone(`Should I start?\n${'line\n'.repeat(10)}All done.`), false, 'only the end of the reply counts');
});

test('words: an offer leaves the next step to the person without waiting on them', () => {
    const offer = 'Locked in: the release ships Monday. Let me know when you\'re ready to prep any of those.';
    assert.equal(asksSomeone(offer), true, 'Autopilot still leaves the session to the person');
    assert.equal(asksForAnswer(offer), false);
    assert.deepEqual(askIn(offer), { kind: 'question', question: 'Locked in: the release ships Monday. Let me know when you\'re ready to prep any of those.', soft: true });
    assert.equal(askIn('Done. If you want, I can also add the docs.').soft, true);
    // A real question, or a request that waits on them, is not an offer.
    assert.equal(askIn('Done. Let me know: should I push it?').soft, undefined);
    assert.equal(askIn('Ready to migrate. Please confirm the window.').soft, undefined);
    assert.equal(asksForAnswer('Waiting for your go before the migration.'), true);
});

test('words: what a reply asks a person: a decision line, then a BLOCKED line, then the last question', () => {
    assert.deepEqual(askIn('Compared both.\nDECISION NEEDED: Postgres or SQLite? — recommend: SQLite'), { kind: 'decision', question: 'Postgres or SQLite?', recommendation: 'SQLite' });
    assert.deepEqual(askIn('BLOCKED: no key\nDECISION NEEDED: wait or skip?'), { kind: 'decision', question: 'wait or skip?' }, 'a decision line wins');
    assert.deepEqual(askIn('Tried twice.\n\n**BLOCKED: the staging bucket refuses writes**'), { kind: 'blocked', question: 'the staging bucket refuses writes' });
    assert.deepEqual(askIn('The parser is done. Tests pass. Should I also write the docs? I can start now.'), { kind: 'question', question: 'Should I also write the docs?' });
    assert.deepEqual(askIn('Done with step 1.\n\n- Which port do you want: 8080 or 3000?'), { kind: 'question', question: 'Which port do you want: 8080 or 3000?' });
    assert.deepEqual(askIn('Ready to migrate. Waiting for your go.'), { kind: 'question', question: 'Ready to migrate. Waiting for your go.' }, 'a request without a question mark: its last line');
    // A coordinating chat's relay ends with how to answer; the card shows the line that asks.
    const relay = 'Thread “Port check” handed back: it needs your decision on the dev server port, 8080 or 3000.\nReply here with your choice and I\'ll pass it on.';
    assert.deepEqual(askIn(relay), { kind: 'question', question: 'Thread “Port check” handed back: it needs your decision on the dev server port, 8080 or 3000.' });
    assert.equal(askIn('All tests pass; next I write the docs.'), undefined);
    assert.equal(askIn(''), undefined);
    assert.equal(askIn(null), undefined);
    assert.equal(askIn(`DECISION NEEDED: ${'why '.repeat(200)}?`).question.length, 400, 'kept short');
    assert.equal(blockedIn('BLOCKED: one\ntext\nBLOCKED: two'), 'two');
    assert.equal(blockedIn('Not blocked at all.'), undefined);
    assert.equal(blockedIn('UNBLOCKED: fine'), undefined);
});

test('words: a provider\'s error in plain words, its JSON reduced to the message', () => {
    assert.equal(plainError('400: {"message":"The model refused this request.","type":"invalid_request_error"}'), '400: The model refused this request.');
    assert.equal(plainError('429 {"error":{"message":"Rate limit reached for requests","type":"requests"}}'), '429: Rate limit reached for requests');
    assert.equal(plainError('{"error":"overloaded"}'), 'overloaded');
    assert.equal(plainError('500 Internal Server Error'), '500 Internal Server Error', 'plain text stays as it is');
    assert.equal(plainError('503: {not json}'), '503: {not json}', 'broken JSON stays as it came');
    assert.equal(plainError('{"code":7}'), '{"code":7}', 'JSON without a message stays as it came');
    assert.equal(plainError(undefined), '');
});

test('words: times and spans in plain words', () => {
    const now = new Date(2026, 9, 16, 22, 15).getTime();
    assert.match(timeWords(new Date(2026, 9, 16, 21, 41).getTime(), now), /^9:41\s?PM$/);
    assert.match(timeWords(new Date(2026, 9, 15, 21, 41).getTime(), now), /^yesterday 9:41\s?PM$/);
    assert.match(timeWords(new Date(2026, 9, 3, 9, 5).getTime(), now), /^Oct 3, 9:05\s?AM$/);
    assert.equal(timeWords(0, now), 'an unknown time');
    assert.equal(spanWords(45000), '45 seconds');
    assert.equal(spanWords(1000), '1 second');
    assert.equal(spanWords(10 * 60000), '10 minutes');
    assert.equal(spanWords(3 * 3600000), '3 hours');
    assert.equal(spanWords(3 * 86400000), '3 days');
    assert.equal(count(1, 'open todo'), '1 open todo');
    assert.equal(count(2, 'try', 'tries'), '2 tries');
});

// ── The change hub ────────────────────────────────────────────────────

test('hub: a window waits until a channel moves, gets the change at once when behind, and a new start reads everything', async (t) => {
    // The hub's timers never keep DSH running, so the test keeps itself alive while it waits.
    const keep = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keep));
    const hub = new Hub();
    const first = await hub.wait(undefined, 1000);
    assert.deepEqual(first, { epoch: hub.epoch, versions: {} }, 'a window with nothing yet gets the snapshot at once');
    let woke;
    const waiting = hub.wait(first, 10000).then((value) => { woke = value; });
    await settle(3);
    assert.equal(woke, undefined);
    hub.bump('autopilot');
    await waiting;
    assert.deepEqual(woke.versions, { autopilot: 1 });
    assert.equal(hub.behind(woke), false);
    assert.equal(hub.behind({ epoch: 'old', versions: woke.versions }), true);
    const timedOut = await hub.wait(woke, 5);
    assert.deepEqual(timedOut, woke);
    const controller = new AbortController();
    const aborted = hub.wait(woke, 10000, controller.signal);
    controller.abort();
    assert.deepEqual(await aborted, woke);
    const closing = hub.wait(woke, 10000);
    hub.close();
    assert.deepEqual(await closing, woke);
    assert.equal(hub.waiters.size, 0);
});

// ── The event log ─────────────────────────────────────────────────────

test('journal: entries and their later outcomes survive a restart, newest first, and the file is private', () => {
    const dir = temp();
    const file = join(dir, 'log', 'events.jsonl');
    let t = 1000;
    let changes = 0;
    const log = new Journal(file, { now: () => t++, onChange: () => { changes += 1; } });
    const a = log.add({ kind: 'nudge', sessionId: 's1', text: 'Told it to carry on', state: 'sending' });
    log.add({ kind: 'nudge', sessionId: 's2', text: 'Other' });
    log.set(a.id, { state: 'delivered', turn: 4 });
    assert.equal(changes, 3);
    assert.equal(log.set('missing', { state: 'x' }), undefined);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'log')).mode & 0o777, 0o700);
    appendFileSync(file, 'not json\n{"add":{"no":"id"}}\n');
    const again = new Journal(file);
    assert.deepEqual(again.list().map((entry) => entry.sessionId), ['s2', 's1']);
    assert.equal(again.get(a.id).state, 'delivered');
    assert.equal(again.get(a.id).turn, 4);
    assert.deepEqual(again.list({ sessionId: 's1' }).map((entry) => entry.id), [a.id]);
    assert.equal(again.list({ limit: 1 }).length, 1);
});

test('journal: keeps a bounded number of entries and rewrites itself when the file grows past its size', () => {
    const dir = temp();
    const file = join(dir, 'events.jsonl');
    const log = new Journal(file, { keep: 5, maxBytes: 2000 });
    for (let i = 0; i < 40; i += 1) log.add({ kind: 'x', text: `entry ${i} ${'.'.repeat(40)}` });
    assert.equal(log.list().length, 5);
    assert.ok(statSync(file).size <= 2000 + 200, 'rewritten from memory');
    assert.deepEqual(new Journal(file, { keep: 5 }).list().map((entry) => entry.text.split(' ')[1]), ['39', '38', '37', '36', '35']);
});

test('journal: a write that fails is logged, never thrown', () => {
    const dir = temp();
    writeFileSync(join(dir, 'blocker'), 'a file where a folder should be');
    const warnings = [];
    const log = new Journal(join(dir, 'blocker', 'events.jsonl'), { logger: { warn: (line) => warnings.push(line) } });
    assert.doesNotThrow(() => log.add({ kind: 'x' }));
    assert.equal(log.list().length, 1, 'kept in memory');
    assert.match(warnings[0], /could not write the event log/);
});

// ── Files ─────────────────────────────────────────────────────────────

test('files: private folders and atomic writes; the store gathers changes into one write', async () => {
    const dir = temp();
    const deep = join(dir, 'a', 'b', 'c');
    ensurePrivateDir(deep);
    for (const d of [join(dir, 'a'), join(dir, 'a', 'b'), deep]) assert.equal(statSync(d).mode & 0o777, 0o700);
    writeAtomic(join(deep, 'f.json'), '{"x":1}');
    assert.equal(statSync(join(deep, 'f.json')).mode & 0o777, 0o600);
    assert.deepEqual(readJson(join(deep, 'f.json')), { x: 1 });
    writeFileSync(join(deep, 'broken.json'), '{');
    assert.equal(readJson(join(deep, 'broken.json')), undefined);
    assert.equal(readJson(join(deep, 'missing.json')), undefined);
    const seen = [];
    const store = new JsonStore(join(deep, 'broken.json'), { parse: (value) => { seen.push(value); return { n: value?.n ?? 0 }; }, delayMs: 5 });
    assert.deepEqual(seen, [undefined], 'a broken file reads as nothing, never throws');
    store.data.n = 1;
    store.change();
    store.data.n = 2;
    store.change();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(readJson(join(deep, 'broken.json')), { n: 2 });
    writeFileSync(join(dir, 'file'), 'x');
    const warnings = [];
    const stuck = new JsonStore(join(dir, 'file', 'state.json'), { parse: () => ({}), logger: { warn: (line) => warnings.push(line) } });
    assert.equal(stuck.flush(), false);
    assert.match(warnings[0], /could not save/);
});

test('files: no suite plugin builds DSH\'s data folder path itself; DSH\'s dshHomePath does, so DSH_HOME and DSH Test move it', () => {
    let seen = 0;
    for (const plugin of SUITE) {
        let index;
        try {
            index = readFileSync(new URL(`../plugins/${plugin}/lib/index.js`, import.meta.url), 'utf8');
        } catch {
            continue;
        }
        seen += 1;
        const libFiles = jsFilesUnder(`plugins/${plugin}/lib`);
        assert.ok(libFiles.includes(`plugins/${plugin}/lib/index.js`), `${plugin}: its files are found without git`);
        for (const file of libFiles) {
            const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            assert.doesNotMatch(text, /homedir\(\)[^\n]*['"`]\.dsh['"`/]/, `${file} builds a ~/.dsh path`);
        }
        if (/pluginDir|dshHomePath/.test(index)) assert.match(index, /from '@deepseek-ai\/dsh-home-paths'/, `${plugin} takes its folder from DSH`);
    }
    assert.ok(seen >= 2);
});

// ── Guards ────────────────────────────────────────────────────────────

test('guards: nothing a handler throws reaches DSH; errors read as one short line', async () => {
    const warnings = [];
    const logger = { warn: (line) => warnings.push(line) };
    assert.doesNotThrow(() => guard(logger, 'sync', () => { throw new Error('bad\n  stack'); })());
    guard(logger, 'async', async () => { throw new Error('later'); })();
    await settle(3);
    assert.deepEqual(warnings, ['sync: bad stack', 'async: later']);
    assert.equal(errorText('x'.repeat(500)).length, 300);
    assert.equal(errorText({ code: 1 }), '{"code":1}');
    assert.equal(errorText(undefined), 'unknown error');
    assert.equal(clip('alpha beta gamma delta', 15), 'alpha beta…', 'at a word when one is near');
    assert.equal(clip('one two three four five', 12), 'one two thr…', 'mid-word when no word ends near the cut');
    assert.equal(clip('short', 12), 'short');
    assert.equal(clip(5, 3), '');
    let ran = false;
    const timer = later(logger, 'timer', 1, () => { ran = true; throw new Error('in a timer'); });
    assert.equal(typeof timer.hasRef === 'function' ? timer.hasRef() : false, false, 'never keeps DSH running');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ran, true);
    assert.equal(warnings.at(-1), 'timer: in a timer');
});

// ── Copies ────────────────────────────────────────────────────────────

test('endpoints: every suite plugin marks each window endpoint, since DSH\'s gateway serves only marked methods', () => {
    let seen = 0;
    for (const plugin of SUITE) {
        let text;
        try {
            text = readFileSync(new URL(`../plugins/${plugin}/lib/remote.js`, import.meta.url), 'utf8');
        } catch {
            continue;
        }
        seen += 1;
        const methods = [...text.matchAll(/^ {4}async (\w+)\(/gm)].map((m) => m[1]).filter((name) => name !== 'run').sort();
        const marked = /markRemote\(\w+, \[([^\]]*)\]\)/.exec(text)?.[1];
        assert.ok(marked, `${plugin}: remote.js marks its methods with markRemote`);
        const names = [...marked.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
        assert.deepEqual(names, methods, `${plugin}: every endpoint is marked, and only endpoints`);
    }
    assert.ok(seen >= 2, 'session-watch and autopilot have endpoints');
});

test('copies: every suite plugin carries the current shared code', () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['scripts/sync-shared.mjs', '--check'], { stdio: 'pipe' }));
    const copies = plannedCopies();
    for (const plugin of ['session-watch', 'autopilot']) {
        assert.ok(copies.some((copy) => copy.target.includes(`/plugins/${plugin}/lib/shared/words.js`)), plugin);
        assert.ok(SUITE.includes(plugin));
    }
    const client = readFileSync('plugins/autopilot/lib/client.js', 'utf8');
    assert.equal(kitBlock(client), kitBlock(readFileSync('shared/client-kit.js', 'utf8')));
    assert.equal(kitBlock('no markers'), undefined);
});

// ── The window kit ────────────────────────────────────────────────────

function kitWith({ document, window = {}, react } = {}) {
    const saved = { window: globalThis.window, document: globalThis.document };
    globalThis.window = window;
    if (document) globalThis.document = document;
    try {
        const React = react ?? standInReact();
        const ui = new Proxy({}, { get: (_t, name) => (typeof name === 'string' ? name : undefined) });
        return suiteKit({ prefix: 'dshx', bundle: 'dsh-plugin-x', React, ui, h: React.createElement });
    } finally {
        globalThis.window = saved.window;
        if (document) globalThis.document = saved.document;
    }
}

test('kit: endpoints answer in words, and a broken answer never reaches a view as a throw', async () => {
    const kit = kitWith();
    const api = kit.link('dsh-plugin-x', { name: 'X' });
    const calls = [];
    kit.setConnection({ rpc: { call: async (path, method, payload) => {
        calls.push([path, method, payload]);
        if (method.endsWith('/broken')) return 'junk';
        if (method.endsWith('/down')) throw new Error('socket closed');
        if (method.endsWith('/gone')) throw new Error('transport failure for /api/dsh-plugin-x/gone: HTTP 404');
        if (method.endsWith('/gone2')) return { ok: false, error: { code: 'transport', message: 'transport failure for /api/dsh-plugin-x/gone2: HTTP 404' } };
        if (method.endsWith('/refused')) return { ok: false, error: { code: 'x/refused', message: 'Room 404 is full.' } };
        return { ok: true, value: 7 };
    } } });
    assert.deepEqual(await api.call('state', { a: 1 }), { ok: true, value: 7 });
    assert.deepEqual(calls[0], ['/api', 'dsh-plugin-x/state', { args: { a: 1 } }]);
    assert.equal(await api.read('state'), 7);
    assert.deepEqual(await api.call('broken'), { ok: false, error: { code: 'unreadable', message: 'X sent an answer this window cannot read. Reload the window.' } });
    assert.deepEqual((await api.call('down')).error, { code: 'unreachable', message: 'DSH did not answer. Check that DSH is still running, then try again.' });
    await assert.rejects(api.read('broken'), /cannot read/);
    // A plugin whose host half is not running: said in words, never as a path or an HTTP status.
    for (const method of ['gone', 'gone2']) {
        const result = await api.call(method);
        assert.deepEqual(result, { ok: false, error: { code: 'not-running', message: 'X is not running in DSH.' } });
    }
    await assert.rejects(api.read('gone'), (error) => error.code === 'not-running' && !/404|\/api/.test(error.message));
    // The plugin's own refusal stays its own, whatever its words hold.
    assert.deepEqual((await api.call('refused')).error, { code: 'x/refused', message: 'Room 404 is full.' });
});

test('kit: one hub request per window serves every plugin, and moves only the views whose channel changed', async () => {
    const shared = {};
    const kitA = kitWith({ window: shared });
    const kitB = kitWith({ window: shared });
    let version = 0;
    const waits = [];
    const connection = { rpc: { call: async (_path, method, payload) => {
        waits.push([method, payload.args.since?.versions?.autopilot ?? null]);
        if (waits.length > 3) return new Promise(() => {});
        version += 1;
        return { ok: true, value: { epoch: 'e1', versions: { autopilot: version, recall: 1 } } };
    } } };
    kitA.setConnection(connection);
    kitA.hub.attach();
    kitB.hub.attach();
    const heard = { a: 0, b: 0 };
    kitA.hub.subscribe(['autopilot'], () => { heard.a += 1; });
    kitB.hub.subscribe(['recall'], () => { heard.b += 1; });
    await settle(10);
    assert.ok(shared['dsh-plugin-session-watch/hub/v1'], 'the hub lives on the window, shared');
    assert.equal(waits.filter(([method]) => method !== 'dsh-plugin-session-watch/wait').length, 0);
    assert.ok(waits.length >= 3, 'one long request after another, never in parallel');
    assert.equal(heard.b, 1, 'recall moved once (the first answer); autopilot\'s changes never wake it');
    assert.ok(heard.a >= 3);
});

test('kit: times, tones and the parts every page uses', () => {
    const kit = kitWith();
    assert.equal(kit.toneOf('delivered'), 'success');
    assert.equal(kit.toneOf('not delivered'), 'danger');
    assert.equal(kit.toneOf('asked you'), 'warning');
    assert.equal(kit.toneOf('waiting for a round'), 'info');
    assert.equal(kit.toneOf('idle'), 'quiet');
    const now = Date.now();
    assert.equal(kit.agoText(now - 10000, now), 'just now');
    assert.equal(kit.agoText(now - 5 * 60000, now), '5 min ago');
    assert.equal(kit.agoText(now - 3 * 3600000, now), '3 h ago');
    assert.equal(kit.timeText(0), '');
    assert.equal(kit.spanText(5), '5 seconds');
    assert.equal(kit.spanText(1), '1 second');
    assert.equal(kit.spanText(60), '1 minute');
    assert.equal(kit.spanText(600), '10 minutes');
    assert.equal(kit.spanText(7200), '2 hours');
    assert.equal(kit.spanText(5400), '1.5 hours');
    assert.equal(kit.spanText(-1), '');
    const card = kit.Card({ title: 'Title', sub: 'Sub', actions: 'Act', main: true, children: 'Body' });
    assert.equal(card.props.className, 'dshx-card dshx-main');
    assert.equal(textIn(card), 'TitleSubActBody');
    const empty = kit.Empty({ title: 'Nothing yet', text: 'Do this next.' });
    assert.equal(empty.props.role, 'status');
    const error = kit.ErrorLine({ text: 'socket closed', onRetry: () => {} });
    assert.equal(textIn(error), 'Couldn\'t refresh: socket closedRetry');
    assert.equal(elementsOf(error).find((e) => e.type === 'Button').props.variant, 'ghost');
    assert.equal(kit.StateTag({ word: 'failed' }).props.tone, 'danger');
    assert.equal(kit.TimeText({ at: 0 }), null);
    assert.ok(kit.css.some((rule) => rule.includes('prefers-reduced-motion')));
    assert.ok(kit.css.some((rule) => rule.includes('body.wp-still')));
    assert.ok(kit.css.some((rule) => rule.includes('prefers-reduced-transparency')));
    assert.ok(kit.css.every((rule) => !OTHER_NAMES.test(rule)));
});

// DSH's own colours (dsh-client-ui-theme), light and dark, and the page grounds under a suite card.
const DSH = {
    light: { label: '#0f1115', warning: '#f59e0b', danger: '#ec1313', success: '#22c55e', info: '#4176e6', ground: '#fafaf6' },
    dark: { label: '#f9fafb', warning: '#f59e0b', danger: '#f25a5a', success: '#22c55e', info: '#7aaaff', ground: '#0e1211' },
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, share) => a.map((v, i) => v * share + b[i] * (1 - share));
const luminance = (c) => {
    const [r, g, b] = c.map((v) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

test('kit: state tags write their words at 4.5:1 or more on DSH\'s tag fill, in light and dark (DSH\'s own read 1.8 to 3.5)', () => {
    const kit = kitWith();
    const tag = kit.StateTag({ word: 'waiting for your answer' });
    assert.equal(tag.props.className, 'dshx-tag');
    assert.equal(tag.props.tone, 'warning');
    assert.equal(kit.toneOf('withdrawn'), 'neutral');
    const TOKEN = { warning: 'warn', danger: 'error', success: 'success', info: 'business' };
    // DSH's fills: 12% of the state colour for warning, 10% for the others.
    const FILL = { warning: 0.12, danger: 0.1, success: 0.1, info: 0.1 };
    for (const tone of Object.keys(TOKEN)) {
        const rule = kit.css.find((r) => r.includes(`.dshx-tag[data-tone="${tone}"]`));
        assert.ok(rule, tone);
        const share = Number(new RegExp(`--dsw-alias-state-${TOKEN[tone]}-primary\\) (\\d+)%,var\\(--dsw-alias-label-primary\\)`).exec(rule)?.[1]) / 100;
        assert.ok(share > 0 && share < 1, rule);
        for (const mode of ['light', 'dark']) {
            const colours = DSH[mode];
            const fill = mix(rgb(colours[tone]), rgb(colours.ground), FILL[tone]);
            const ours = contrast(mix(rgb(colours[tone]), rgb(colours.label), share), fill);
            assert.ok(ours >= 4.5, `${tone} in ${mode}: ${ours.toFixed(2)}:1`);
            if (mode === 'light' && tone !== 'danger') assert.ok(contrast(rgb(colours[tone]), fill) < 4.5, `DSH's own ${tone} words fall short in light`);
        }
    }
    // Quiet and neutral words ("idle", "stopped", "withdrawn"): DSH draws them in its glyph colour (tertiary), 3.6:1 in
    // light; the suite writes them in its secondary text colour (DSH's secondary label, 20% toward the primary).
    const LABELS = { light: { secondary: '#61666b', tertiary: '#81858c' }, dark: { secondary: '#cfd3d6', tertiary: '#adb2b8' } };
    const quiet = kit.css.find((r) => r.includes('.dshx-tag:is([data-tone="quiet"],[data-tone="neutral"])'));
    assert.match(quiet ?? '', /\{color:var\(--dshx-text-2\)\}/);
    const text2 = kit.css.find((r) => r.includes('--dshx-text-2:'));
    const textShare = Number(/--dshx-text-2:color-mix\(in srgb,var\(--dsw-alias-label-secondary\) (\d+)%,var\(--dsw-alias-label-primary\)\)/.exec(text2)?.[1]) / 100;
    assert.ok(textShare > 0 && textShare < 1, text2);
    assert.equal(kit.toneOf('idle'), 'quiet');
    for (const mode of ['light', 'dark']) {
        const colours = DSH[mode];
        const fill = mix(rgb(LABELS[mode].tertiary), rgb(colours.ground), 0.12);
        const ours = contrast(mix(rgb(LABELS[mode].secondary), rgb(colours.label), textShare), fill);
        assert.ok(ours >= 4.5, `quiet in ${mode}: ${ours.toFixed(2)}:1`);
    }
    assert.ok(contrast(rgb(LABELS.light.tertiary), rgb(DSH.light.ground)) < 4.5, 'DSH\'s glyph colour falls short for words in light');
});

test('kit: amber and secondary words on a card people read hold 4.5:1 at Wallpaper\'s tint .2 over a mid picture, light and dark', () => {
    const kit = kitWith();
    const tokens = kit.css.find((r) => r.includes('--dshx-warn:'));
    const warnShare = Number(/--dshx-warn:color-mix\(in srgb,var\(--dsw-alias-state-warn-primary\) (\d+)%,var\(--dsw-alias-label-primary\)\)/.exec(tokens)?.[1]) / 100;
    const textShare = Number(/--dshx-text-2:color-mix\(in srgb,var\(--dsw-alias-label-secondary\) (\d+)%,var\(--dsw-alias-label-primary\)\)/.exec(tokens)?.[1]) / 100;
    assert.ok(warnShare > 0 && textShare > 0, tokens);
    assert.match(kit.css.find((r) => r.includes(`.dshx-card.dshx-main{`)) ?? '', /background:var\(--dshx-conv\)/);
    // The main card's glass at tint .2 is .4 of its colour; the picture under it here is a mid grey (DESIGN's check).
    const SECONDARY = { light: '#61666b', dark: '#cfd3d6' };
    const CARD = { light: { glass: '#fafaf6', ground: '#b4b4b4' }, dark: { glass: '#0a0d0c', ground: '#8c8c8c' } };
    for (const mode of ['light', 'dark']) {
        const card = mix(rgb(CARD[mode].glass), rgb(CARD[mode].ground), 0.4);
        const warn = contrast(mix(rgb(DSH[mode].warning), rgb(DSH[mode].label), warnShare), card);
        const text2 = contrast(mix(rgb(SECONDARY[mode]), rgb(DSH[mode].label), textShare), card);
        assert.ok(warn >= 4.5, `amber words in ${mode}: ${warn.toFixed(2)}:1`);
        assert.ok(text2 >= 4.5, `secondary words in ${mode}: ${text2.toFixed(2)}:1`);
        // The plain tint (.2) there falls short: why dense text sits on the main card.
        const plain = mix(rgb(CARD[mode].glass), rgb(CARD[mode].ground), 0.2);
        assert.ok(contrast(mix(rgb(SECONDARY[mode]), rgb(DSH[mode].label), textShare), plain) < 4.5, `plain tint in ${mode}`);
    }
});

test('kit: the sidebar badge writes its count at 4.5:1 or more in light and dark (DSH\'s red in dark read 3.3:1 under white)', () => {
    const kit = kitWith();
    const rule = kit.css.find((r) => r.includes('.dshx-badge{'));
    // Static tokens: DSH gives them the same values in both themes (red-600 #ec1313, bluish-1000 #0f1115, bluish-00 #fff).
    const m = /background:color-mix\(in srgb,var\(--dsw-static-red-600,(#[0-9a-f]{6})\) (\d+)%,var\(--dsw-static-neutral-bluish-1000,(#[0-9a-f]{6})\)\);color:var\(--dsw-static-neutral-bluish-00,(#[0-9a-f]{6})\)/.exec(rule);
    assert.ok(m, rule);
    const fill = mix(rgb(m[1]), rgb(m[3]), Number(m[2]) / 100);
    const ours = contrast(rgb(m[4]), fill);
    assert.ok(ours >= 4.5, `${ours.toFixed(2)}:1`);
    assert.ok(contrast(rgb('#ffffff'), rgb(DSH.dark.danger)) < 3.5, 'white on DSH\'s dark error colour');
    assert.ok(contrast(rgb('#ffffff'), rgb(DSH.light.danger)) < 4.5, 'white on DSH\'s light error colour is just short too');
});

test('kit: a choice commits on a click or on Enter, never on an arrow key; Escape and leaving go back; it is never disabled', async () => {
    const { react, mount } = statefulReact();
    const kit = kitWith({ react });
    const OPTIONS = [{ value: 'auto', label: 'Auto' }, { value: 'ask', label: 'Ask first' }, { value: 'off', label: 'Off' }];
    const chosen = [];
    let answer = true;
    const view = mount(kit.Choice, { id: 'rule', label: 'Rule', value: 'auto', options: OPTIONS, busy: false, onChoose: (value) => { chosen.push(value); return answer; } });
    const control = () => elementsOf(view.tree).find((e) => e.type === 'SegmentedControl');
    const root = () => view.tree;
    const key = (k) => {
        let prevented = false;
        root().props.onKeyDownCapture({ key: k, preventDefault: () => { prevented = true; } });
        return prevented;
    };
    const click = (value) => root().props.onClickCapture({ target: { closest: () => ({ id: `rule-${value}` }) } });
    assert.equal(control().props.disabled, undefined);
    // An arrow key: DSH's control moves to the next value; nothing is sent, and the line under it says how to apply it.
    control().props.onChange('ask');
    assert.equal(control().props.value, 'ask');
    assert.deepEqual(chosen, []);
    assert.equal(root().props['data-suite-pending'], 'ask');
    assert.match(textIn(view.tree), /Press Enter to apply Ask first\./);
    // Enter applies it.
    assert.equal(key('Enter'), true);
    assert.deepEqual(chosen, ['ask']);
    view.update({ value: 'ask' });
    assert.equal(root().props['data-suite-pending'], undefined);
    assert.doesNotMatch(textIn(view.tree), /Press Enter/);
    // Enter on the saved value sends nothing again; Space applies as Enter does.
    assert.equal(key('Enter'), false);
    control().props.onChange('off');
    key(' ');
    assert.deepEqual(chosen, ['ask', 'off']);
    view.update({ value: 'off' });
    // Escape, or leaving the control, goes back to the saved value.
    control().props.onChange('auto');
    key('Escape');
    assert.equal(control().props.value, 'off');
    control().props.onChange('auto');
    root().props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null });
    assert.equal(control().props.value, 'off');
    // Moving between its own values keeps the choice open.
    control().props.onChange('auto');
    root().props.onBlurCapture({ currentTarget: { contains: () => true }, relatedTarget: {} });
    assert.equal(control().props.value, 'auto');
    key('Escape');
    // A click applies at once (DSH's control ignores a click on the value it shows, so the click is read here).
    click('ask');
    assert.deepEqual(chosen, ['ask', 'off', 'ask']);
    view.update({ value: 'ask' });
    // While a change is on its way the control stays as it is (busy, not disabled); a choice made then goes next.
    view.update({ busy: true });
    assert.equal(root().props['aria-busy'], 'true');
    assert.equal(control().props.disabled, undefined);
    click('off');
    assert.deepEqual(chosen, ['ask', 'off', 'ask'], 'held while busy');
    view.update({ busy: false });
    assert.deepEqual(chosen, ['ask', 'off', 'ask', 'off'], 'sent once the last change is done');
    // A change that did not go through: the saved value shows again.
    answer = Promise.resolve(false);
    control().props.onChange('auto');
    key('Enter');
    assert.equal(control().props.value, 'auto');
    await settle();
    assert.equal(control().props.value, 'ask');
});

test('kit: "4 min ago" stays current: one 30-second clock per window, running only while a time shows and the window is in view', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const listeners = new Map();
    const document = { visibilityState: 'visible', addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type) };
    const window = {};
    const kitA = kitWith({ window, document });
    const kitB = kitWith({ window, document });
    kitA.useMinute();
    kitB.useMinute();
    const clock = window['dsh-plugin-suite/minute/v1'];
    assert.ok(clock, 'one clock, on the window, for every suite plugin');
    let ticks = 0;
    const off = clock.subscribe(() => { ticks += 1; });
    const offToo = clock.subscribe(() => {});
    t.mock.timers.tick(30000);
    assert.equal(ticks, 1);
    t.mock.timers.tick(60000);
    assert.equal(ticks, 3);
    // Out of view: the clock stops; back in view: it reads the time at once, then goes on.
    document.visibilityState = 'hidden';
    listeners.get('visibilitychange')();
    t.mock.timers.tick(120000);
    assert.equal(ticks, 3);
    document.visibilityState = 'visible';
    listeners.get('visibilitychange')();
    assert.equal(ticks, 4);
    t.mock.timers.tick(30000);
    assert.equal(ticks, 5);
    // Nothing shows a time any more: no clock runs, nothing listens.
    off();
    offToo();
    t.mock.timers.tick(90000);
    assert.equal(ticks, 5);
    assert.equal(listeners.size, 0);
});

test('kit: the settings form flags a saved value that does not fit, with what fits', () => {
    const kit = kitWith();
    const fields = [
        { name: 'idle', kind: 'number', title: 'Quiet time', hint: '', default: 600, min: 5, max: 86400 },
        { name: 'waits', kind: 'numbers', title: 'Waits', hint: '', default: [120, 600], min: 0, max: 86400 },
        { name: 'mode', kind: 'choice', title: 'Mode', hint: '', default: 'a', options: [{ value: 'a', label: 'Auto' }, { value: 'b', label: 'Ask first' }, { value: 'c', label: 'Off' }] },
        { name: 'resume', kind: 'switch', title: 'Resume', hint: '', default: true },
        { name: 'fine', kind: 'number', title: 'Fine', hint: '', default: 2, min: 1, max: 10 },
    ];
    // What DSH's form shows for values typed into the profile: each stored value as text, wrong ones included.
    assert.equal(kit.fieldSpec(fields[0]).format(2), '2');
    assert.equal(kit.fieldSpec(fields[0]).format('soon'), 'soon');
    assert.equal(kit.fieldSpec(fields[1]).format('120'), '120');
    assert.equal(kit.fieldSpec(fields[2]).format(7), '7');
    assert.equal(kit.fieldSpec(fields[3]).format('yes'), 'yes');
    assert.equal(kit.fieldSpec(fields[3]).format(undefined), '');
    const snap = {
        writable: true, saving: false,
        idle: { text: '2', overridden: true, invalid: false },
        waits: { text: '1, x', overridden: true, invalid: false },
        mode: { text: 'maybe', overridden: true, invalid: false },
        resume: { text: 'yes', overridden: true, invalid: false },
        fine: { text: '3', overridden: true, invalid: false },
    };
    const form = { subscribe: () => () => {}, getSnapshot: () => snap, actions: { edit() {}, resetField() {}, save() {}, discard() {} } };
    const body = kit.SettingsBody({ form, name: 'X', fields });
    const row = (name) => elementsOf(body).find((e) => e.props?.['data-suite-setting'] === name);
    const field = (name) => elementsOf(row(name)).find((e) => e.type === 'SettingsValueField');
    assert.equal(field('idle').props.invalid, true);
    assert.equal(field('idle').props.invalidLabel, 'A whole number from 5 to 86400, or empty for the default (600).');
    assert.equal(field('waits').props.invalid, true);
    assert.equal(field('fine').props.invalid, false);
    assert.equal(row('idle').props['data-suite-invalid'], '');
    assert.equal(row('fine').props['data-suite-invalid'], undefined);
    assert.match(textIn(row('mode')), /The saved value is not one of the choices\. Choose Auto, Ask first or Off, then save\./);
    assert.match(textIn(row('resume')), /The saved value is neither on nor off\. Switch it to the one you want, then save\./);
    // A saved choice that is not an option selects none: DSH's control would draw its pill outside its box, over "Use the default".
    const control = elementsOf(row('mode')).find((e) => e.type === 'SegmentedControl');
    assert.equal(control.props.value, '');
    assert.equal(control.props.className, 'dshx-seg-none');
    assert.ok(kit.css.some((rule) => rule.includes('.dshx-seg-none>[aria-hidden="true"]{visibility:hidden}')), 'its pill is hidden');
});

test('kit: a choice with no valid saved value can still be reached with Tab; once fixed, DSH\'s selection takes the focus again', () => {
    const { react, mount } = statefulReact();
    const kit = kitWith({ react });
    const f = { name: 'mode', title: 'Mode', options: [{ value: 'a', label: 'Auto' }, { value: 'b', label: 'Off' }] };
    const tab = (selected, tabIndex = -1) => ({ tabIndex, getAttribute: (name) => (name === 'aria-selected' ? String(selected) : null) });
    let tabs = [tab(false), tab(false)];
    const part = mount(kit.ChoiceControl, { id: 'x', f, value: 'maybe', disabled: false, onChange() {} });
    part.tree.props.ref.current = { querySelectorAll: () => tabs };
    part.update({});
    assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1], 'DSH leaves every tab at -1 when none is selected: the first one takes the focus');
    assert.equal(part.tree.props['data-suite-unset'], '');
    tabs = [tab(false, 0), tab(true)];
    part.update({ value: 'b' });
    assert.deepEqual(tabs.map((t) => t.tabIndex), [-1, 0]);
    const control = elementsOf(part.tree).find((e) => e.type === 'SegmentedControl');
    assert.equal(control.props.value, 'b');
    assert.equal(control.props.className, undefined);
});

test('kit: with no valid value chosen, the arrows walk from the choice that has the cursor, as they do once one is chosen', () => {
    const { react, mount } = statefulReact();
    const kit = kitWith({ react });
    const f = { name: 'mirror', title: 'Send to', options: [{ value: 'off', label: 'Nowhere' }, { value: 'webhook', label: 'Webhook' }, { value: 'command', label: 'Command' }] };
    const tabs = [0, 1, 2].map(() => ({ tabIndex: -1, getAttribute: () => 'false' }));
    for (const t of tabs) t.closest = () => t;
    const chosen = [];
    const part = mount(kit.ChoiceControl, { id: 'x', f, value: 'slack', disabled: false, onChange: (v) => chosen.push(v) });
    part.tree.props.ref.current = { querySelectorAll: () => tabs };
    const press = (key, target = tabs[0]) => {
        const done = { prevented: false, stopped: false };
        part.tree.props.onKeyDownCapture({ key, target, preventDefault: () => { done.prevented = true; }, stopPropagation: () => { done.stopped = true; } });
        return done;
    };
    // DSH's control walks from "before the first" here: right picks Nowhere, left the one before the last.
    assert.deepEqual(press('ArrowRight'), { prevented: true, stopped: true }, 'DSH\'s own walk does not run');
    press('ArrowLeft');
    press('ArrowDown', tabs[1]);
    press('Home', tabs[2]);
    press('End');
    assert.deepEqual(chosen, ['webhook', 'command', 'command', 'off', 'command']);
    assert.deepEqual(press('Tab'), { prevented: false, stopped: false }, 'other keys are left alone');
    // Once a value is chosen, DSH's own walk does it.
    part.update({ value: 'webhook' });
    assert.deepEqual(press('ArrowRight'), { prevented: false, stopped: false });
    assert.equal(chosen.length, 5);
});

test('kit: "Open X\'s settings" for a choice with no valid value puts the cursor on its first choice, not on "Use the default"', async () => {
    const { react, mount } = statefulReact();
    const window = {};
    const kit = kitWith({ react, window });
    kit.setNavigation({ openBundle: () => {} });
    const focused = [];
    // As the row draws it: "Use the default", then the choices, none selected, the first one taking the keys.
    const children = [
        { tag: 'button', focus: () => focused.push('Use the default') },
        { tag: 'button', role: 'tab', tabindex: '0', focus: () => focused.push('Nowhere') },
        { tag: 'button', role: 'tab', tabindex: '-1', focus: () => focused.push('Webhook') },
    ];
    const one = (child, selector) => {
        const [, tag = '', attrs = ''] = /^([a-z]*)((?:\[[^\]]+\])*)/.exec(selector.trim()) ?? [];
        if (tag && tag !== child.tag) return false;
        if (!tag && !attrs) return false;
        return [...attrs.matchAll(/\[([\w-]+)="([^"]*)"\]/g)].every(([, name, value]) => (name === 'role' ? child.role : name === 'tabindex' ? child.tabindex : name === 'aria-selected' ? String(child.selected === true) : undefined) === value);
    };
    const row = {
        getAttribute: () => 'mirror',
        getClientRects: () => [{}],
        scrollIntoView: () => {},
        querySelector: (selector) => children.find((child) => !/:not|type=/.test(selector) && one(child, selector)) ?? null,
    };
    const fields = [{ name: 'mirror', kind: 'choice', title: 'Send to', hint: '', default: 'off', options: [] }];
    const form = { subscribe: () => () => {}, getSnapshot: () => ({ writable: true, saving: false, mirror: { text: 'slack', overridden: true, invalid: true } }), actions: { edit() {}, resetField() {}, save() {}, discard() {} } };
    const view = mount(kit.SettingsBody, { form, name: 'X', fields });
    elementsOf(view.tree).find((e) => e.props?.['data-suite-settings']).props.ref.current = { querySelectorAll: () => [row] };
    kit.openPlugin('dsh-plugin-x', { focus: 'mirror' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(focused, ['Nowhere']);
    view.unmount();
});

test('kit: its style sheet is the one it marked itself; a sheet DSH marked with its name is neither taken nor removed', () => {
    const sheets = [];
    const style = () => {
        const attrs = new Map();
        const el = {
            textContent: '',
            setAttribute: (name, value) => attrs.set(name, String(value)),
            getAttribute: (name) => attrs.get(name) ?? null,
            remove: () => { const i = sheets.indexOf(el); if (i >= 0) sheets.splice(i, 1); },
        };
        return el;
    };
    const matching = (selector) => {
        const m = /^style\[([\w-]+)="([^"]*)"\]$/.exec(selector);
        return m ? sheets.filter((el) => el.getAttribute(m[1]) === m[2]) : [];
    };
    const document = {
        head: { appendChild: (el) => { sheets.push(el); return el; } },
        createElement: () => style(),
        querySelector: (selector) => matching(selector)[0] ?? null,
        querySelectorAll: (selector) => matching(selector),
    };
    // Another plugin's sheet, added while this plugin started: DSH gave it this plugin's name.
    const nest = style();
    nest.setAttribute('data-plugin', 'dsh-plugin-x');
    nest.textContent = '.nest{}';
    sheets.push(nest);
    const kit = kitWith({ document });
    kit.injectStyle(['.own{}']);
    assert.equal(sheets.length, 2, 'its own sheet is added beside the other');
    assert.equal(nest.textContent, '.nest{}', 'the other sheet is not written over');
    const own = sheets.find((el) => el !== nest);
    assert.equal(own.getAttribute('data-plugin'), 'dsh-plugin-x', 'marked as its own from the start, so DSH gives it to no one else');
    assert.equal(own.getAttribute('data-plugin-css'), 'dsh-plugin-x/client.css');
    assert.match(own.textContent, /\.own\{\}/);
    kit.injectStyle(['.own2{}']);
    assert.equal(sheets.length, 2, 'drawn again in place');
    assert.match(own.textContent, /\.own2\{\}/);
    kit.removeStyle();
    assert.deepEqual(sheets, [nest], 'switched off: its own sheet goes, the other stays');
});

test('kit: "Open X\'s settings" brings the setting the problem is about into view, with the cursor in it', async () => {
    const { react, mount } = statefulReact();
    const window = {};
    const kit = kitWith({ react, window });
    const opened = [];
    kit.setNavigation({ openBundle: (name) => opened.push(name) });
    const focused = [];
    const fakeRow = (key) => {
        // As DSH's own field draws it: "Use the default" comes before the input.
        const children = [
            { tag: 'button', focus: () => focused.push(`focus ${key} reset button`) },
            { tag: 'input', focus: () => focused.push(`focus ${key}`) },
        ];
        const matches = (child, selector) => selector.split(',').some((one) => one.trim().split(/[:[]/)[0] === child.tag);
        return {
            getAttribute: () => key,
            getClientRects: () => [{}],
            scrollIntoView: () => focused.push(`scroll ${key}`),
            // Like the DOM: the first child, in order, that any of the selectors matches.
            querySelector: (selector) => children.find((child) => matches(child, selector)) ?? null,
        };
    };
    const fakeRoot = { querySelectorAll: () => [fakeRow('mode'), fakeRow('idle')] };
    const fields = [{ name: 'idle', kind: 'number', title: 'Quiet time', hint: '', default: 600, min: 5, max: 86400 }];
    const form = { subscribe: () => () => {}, getSnapshot: () => ({ writable: true, saving: false, idle: { text: '2', overridden: true, invalid: false } }), actions: { edit() {}, resetField() {}, save() {}, discard() {} } };
    // The form is already showing (DSH's Plugins page in view): the button's ask reaches it.
    const view = mount(kit.SettingsBody, { form, name: 'X', fields });
    elementsOf(view.tree).find((e) => e.props?.['data-suite-settings']).props.ref.current = fakeRoot;
    const problem = kit.SettingsProblem({ name: 'X', packageName: 'dsh-plugin-x', problem: { text: 'Quiet time (idle) must be from 5 to 86400 (it is 2)', key: 'idle', live: true } });
    elementsOf(problem).find((e) => e.type === 'Button' && textIn(e) === 'Open X\'s settings').props.onClick();
    assert.deepEqual(opened, ['dsh-plugin-x']);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(focused, ['scroll idle', 'focus idle']);
    view.unmount();
    // Asked before the form shows: the form takes the ask when it comes, once.
    kit.openPlugin('dsh-plugin-x', { focus: 'idle' });
    focused.length = 0;
    const later = mount(kit.SettingsBody, { form, name: 'X', fields });
    elementsOf(later.tree).find((e) => e.props?.['data-suite-settings']).props.ref.current = fakeRoot;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(focused, ['scroll idle', 'focus idle']);
    assert.equal(window['dsh-plugin-suite/focus/v1'].asks.size, 0, 'taken once');
    later.unmount();
    assert.equal(window['dsh-plugin-suite/focus/v1'].subs.size, 0, 'a form that left listens no more');
    // Without DSH's Plugins page, there is no button to press.
    const bare = kitWith();
    assert.equal(bare.openPlugin('dsh-plugin-x', { focus: 'idle' }), false);
});
