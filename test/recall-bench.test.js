/**
 * Recall's bench (scripts/recall-bench.mjs) on a small synthetic history:
 * it runs end to end through Recall's own index thread, each search of the
 * page answers well inside the 300 ms target (its median over three rounds:
 * on a busy computer one round can stall, as one did at 305 ms with the
 * load at 60), the rare word's result opens at its exact turn, a new turn
 * and a new session are found, and long notes are searched where they
 * should be while searches go on. The 10k numbers in
 * plugins/recall/README.md come from the same script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUERIES, percentile, runBench } from '../scripts/recall-bench.mjs';

test('bench: a small history, end to end through the index thread: fast searches, the exact turn, new turns found, long notes', async () => {
    const r = await runBench({ sessions: 200, rounds: 3, log: () => {} });
    assert.equal(r.corpus.files, 201, '200 sessions and the one still being written to');
    assert.equal(r.build.files, 201);
    assert.equal(r.build.turns, r.corpus.turns, 'every turn indexed');
    assert.equal(r.rare.total, 1);
    assert.deepEqual({ sessionId: r.rare.sessionId, turn: r.rare.turn, seq: r.rare.seq }, r.rare.expected, 'the result opens at its exact turn');
    assert.equal(r.queries.length, QUERIES.length);
    for (const q of r.queries) {
        assert.equal(q.roundTrip.n, 3, q.name);
        assert.ok(q.roundTrip.median < 300, `${q.name}: median ${q.roundTrip.median} ms (slowest ${q.roundTrip.max} ms)`);
        assert.ok(q.inIndex.median <= q.roundTrip.median + 1, `${q.name}: the time in the index is part of the round trip`);
    }
    assert.ok(r.queries.find((q) => q.name === 'nothing typed (newest turns)').total > 0);
    assert.equal(r.search.n, QUERIES.length * 3);
    assert.ok(r.search.median < 300, `all searches: median ${r.search.median} ms`);
    assert.ok(r.turn.median < 300, `reading a turn: median ${r.turn.median} ms (slowest ${r.turn.max} ms)`);
    assert.equal(r.newTurn.found, true);
    assert.equal(r.newSession.found, true);
    assert.ok(Number.isFinite(r.build.mainThreadDelayMs.max));
    assert.ok(r.restart.readyMs >= 0 && r.restart.afterUncleanStopReadyMs >= 0);
    assert.equal(r.restart.reread, 0, 'a restart reads nothing again when nothing changed');
    // Long notes: every section of the daily log, the big log's newest, the 60,000-section note's ends, not its middle.
    assert.equal(r.notes.files, 3);
    assert.equal(r.notes.partial, 2, 'the 9 MB log and the 60,000-section note are read in part; the daily log is not');
    assert.equal(r.notes.sections, 602 + 50_000 + 50_000);
    assert.deepEqual(r.notes.found, { walrus: 1, tapir: 1, word4999: 1, word59999: 1, word10000: 0, platypus: 1, quokka: 1 });
    assert.ok(r.notes.first.searchesMeanwhile.n > 0 && r.notes.first.searchesMeanwhile.median < 300, `searches while notes are read: median ${r.notes.first.searchesMeanwhile.median} ms`);
});

test('bench: percentiles are nearest-rank', () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    assert.equal(percentile(values, 50), 5);
    assert.equal(percentile(values, 95), 10);
    assert.equal(percentile(values, 0), 1);
    assert.equal(percentile([], 95), 0);
});
