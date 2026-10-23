/**
 * Which notes Canon gives a prompt, measured on labelled sets over the
 * fixture vault (frozen: the sets' answers are its paths), with Canon's own
 * recall exactly as a turn runs it (test/helpers/canon-relevance.mjs).
 *
 * The dev set is tuned on and held to the figures it reached; the hold-out
 * is written by fresh writers who never saw Canon's code or the dev set,
 * measured once, and held to the floors of OPEN-QUESTIONS #29.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DEV, FLOORS, HOLDOUT, belowFloors, loadSet, measure, missText } from './helpers/canon-relevance.mjs';

/**
 * The dev set's figures as reached (README, "How well it picks notes"):
 * held so a change that makes them worse fails here.
 */
const DEV_REACHED = Object.freeze({ first: 43, inBlock: 45, extra: 15, noBlock: 25 });

const kindOf = (id) => id.replace(/\d+$/, '');

test('dev set: 48 or more prompts of the four kinds, every answer an active note, every folder a full path or none', async () => {
    const set = loadSet(DEV);
    assert.ok(set.length >= 48, `${set.length} prompts`);
    const count = (kind) => set.filter((e) => kindOf(e.id) === kind).length;
    assert.ok(set.filter((e) => e.answers.length > 0).length >= 24, 'at least 24 prompts a note answers');
    assert.ok(set.filter((e) => kindOf(e.id) === 'a').every((e) => e.answers.length > 0), 'every a-prompt has an answer');
    for (const kind of ['p', 'f', 'v']) {
        assert.ok(count(kind) >= 8, `at least 8 ${kind}-prompts`);
        assert.ok(set.filter((e) => kindOf(e.id) === kind).every((e) => e.answers.length === 0), `no note answers a ${kind}-prompt`);
    }
    // Sessions in a project's folder, in an unrelated one, and with none.
    const folders = new Set(set.map((e) => e.folder));
    assert.ok(folders.has(''), 'some prompts come from a session with no folder');
    assert.ok([...folders].filter(Boolean).length >= 5, 'and from several folders');
    const { problems } = await measure(set);
    assert.deepEqual(problems, []);
});

test('dev set: the figures reached are held (the block\'s first note answers, an answering note in it, notes that do not answer, no block)', async () => {
    const m = await measure(loadSet(DEV));
    const a = m.summary.answerable;
    const u = m.summary.unanswerable;
    const misses = m.misses.map(missText).join('\n');
    assert.ok(a.first >= DEV_REACHED.first, `first note answers ${a.first} of ${a.n}\n${misses}`);
    assert.ok(a.inBlock >= DEV_REACHED.inBlock, `an answering note in the block ${a.inBlock} of ${a.n}\n${misses}`);
    assert.ok(a.extra <= DEV_REACHED.extra, `${a.extra} notes that do not answer in ${a.blocks} blocks\n${misses}`);
    assert.ok(u.noBlock >= DEV_REACHED.noBlock, `no block for ${u.noBlock} of ${u.n}\n${misses}`);
});

test('hold-out: well formed, apart from the dev set, and within the floors of OPEN-QUESTIONS #29', async (t) => {
    if (!existsSync(HOLDOUT)) {
        t.skip('the hold-out set is not there yet');
        return;
    }
    const set = loadSet(HOLDOUT);
    const dev = loadSet(DEV);
    const said = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');
    const devPrompts = new Set(dev.map((e) => said(e.prompt)));
    for (const e of set) assert.ok(!devPrompts.has(said(e.prompt)), `hold-out ${e.id} repeats a dev prompt`);
    const m = await measure(set);
    assert.deepEqual(m.problems, []);
    const a = m.summary.answerable;
    const u = m.summary.unanswerable;
    t.diagnostic(`hold-out: first note answers ${a.first} of ${a.n}; an answering note in the block ${a.inBlock} of ${a.n}; ${a.extra} notes that do not answer in ${a.blocks} blocks; no block for ${u.noBlock} of ${u.n}`);
    assert.ok(a.n > 0 && u.n > 0, 'the hold-out has prompts a note answers and prompts none does');
    assert.deepEqual(belowFloors(m), [], `floors ${JSON.stringify(FLOORS)}\n${m.misses.map(missText).join('\n')}`);
});
