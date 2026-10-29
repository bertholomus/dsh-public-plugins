import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucket } from '../src/limits.js';

test('a burst passes, then the bucket is empty', () => {
    const b = bucket({ perMinute: 60, burst: 3 });
    assert.deepEqual([1, 2, 3, 4].map(() => b.take('a', 0)), [true, true, true, false]);
});
test('the bucket fills again over time', () => {
    const b = bucket({ perMinute: 60, burst: 1 });
    assert.equal(b.take('a', 0), true);
    assert.equal(b.take('a', 500), false);
    assert.equal(b.take('a', 1000), true);
});
test('each client has its own bucket', () => {
    const b = bucket({ perMinute: 60, burst: 1 });
    assert.equal(b.take('a', 0), true);
    assert.equal(b.take('b', 0), true);
});
test('a full bucket never holds more than its burst', () => {
    const b = bucket({ perMinute: 6000, burst: 2 });
    assert.deepEqual([1, 2, 3].map(() => b.take('a', 60000)), [true, true, false]);
});
