/**
 * Recall's bench (scripts/recall-bench.mjs) on a small synthetic history:
 * it runs end to end through Recall's own index thread, every search of the
 * page answers well inside the 300 ms target, the rare word's result opens
 * at its exact turn, and a new turn and a new session are found. The 10k
 * numbers in plugins/recall/README.md come from the same script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUERIES, percentile, runBench } from '../scripts/recall-bench.mjs';

test('bench: a small history, end to end through the index thread: fast searches, the exact turn, new turns found', async () => {
    const r = await runBench({ sessions: 200, rounds: 2, log: () => {} });
    assert.equal(r.corpus.files, 201, '200 sessions and the one still being written to');
    assert.equal(r.build.files, 201);
    assert.equal(r.build.turns, r.corpus.turns, 'every turn indexed');
    assert.equal(r.rare.total, 1);
    assert.deepEqual({ sessionId: r.rare.sessionId, turn: r.rare.turn, seq: r.rare.seq }, r.rare.expected, 'the result opens at its exact turn');
    assert.equal(r.queries.length, QUERIES.length);
    for (const q of r.queries) {
        assert.equal(q.roundTrip.n, 2, q.name);
        assert.ok(q.roundTrip.p95 < 300, `${q.name}: ${q.roundTrip.p95} ms`);
        assert.ok(q.inIndex.median <= q.roundTrip.median + 1, `${q.name}: the time in the index is part of the round trip`);
    }
    assert.ok(r.queries.find((q) => q.name === 'nothing typed (newest turns)').total > 0);
    assert.equal(r.search.n, QUERIES.length * 2);
    assert.ok(r.turn.p95 < 300);
    assert.equal(r.newTurn.found, true);
    assert.equal(r.newSession.found, true);
    assert.ok(Number.isFinite(r.build.mainThreadDelayMs.max));
    assert.ok(r.restart.readyMs >= 0 && r.restart.afterUncleanStopReadyMs >= 0);
    assert.equal(r.restart.reread, 0, 'a restart reads nothing again when nothing changed');
});

test('bench: percentiles are nearest-rank', () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    assert.equal(percentile(values, 50), 5);
    assert.equal(percentile(values, 95), 10);
    assert.equal(percentile(values, 0), 1);
    assert.equal(percentile([], 95), 0);
});
