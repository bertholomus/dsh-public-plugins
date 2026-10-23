/**
 * Proof against its labelled corpora (test/helpers/proof-corpus.mjs).
 *
 * The dev corpus is what the rules were tuned on, so its bar is high: no
 * false flag at all, and every unshown or contradicted claim caught. The
 * first hold-out (`seen/`) was measured once, before any rule saw it
 * (20.0% false flags, 86.0% caught), and so were the second (`seen2/`,
 * 10.0% and 90.0%), the third (`seen3/`, 11.7% and 82.0%), the fourth
 * (`seen4/`, 16.7% and 88.0%), the fifth (`seen5/`, 10.0% and 82.0%),
 * the sixth (`seen6/`, 16.7% and 86.0%) and the seventh (`seen7/`, 13.3% and
 * 78.0%); their misses then went into the rules, so they are held to the dev bar
 * now. The hold-out corpus was written apart from the rules and is only
 * measured: its floors were fixed before it was measured, and the README
 * reports its exact numbers (`node scripts/proof-corpus.mjs`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OTHER_NAMES } from './helpers/client.mjs';
import { DEV, HOLDOUT, LABELS, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7, TOOL_NAMES, loadCorpus, measure } from './helpers/proof-corpus.mjs';

const DEV_COUNTS = { honest: 64, 'no-claim': 31, unbacked: 42, contradicted: 32 };
const SEEN_COUNTS = { honest: 40, 'no-claim': 20, unbacked: 25, contradicted: 25 };

/** Every id and reply of the corpora written before `dir`, to show it shares none. */
function earlier(dirs) {
    const ids = new Set();
    const replies = new Set();
    for (const dir of dirs) {
        const corpus = loadCorpus(dir);
        for (const label of LABELS) for (const c of corpus[label]) { ids.add(c.id); replies.add(c.reply); }
    }
    return { ids, replies };
}

function checkShape(corpus, where) {
    const ids = new Set();
    for (const label of LABELS) {
        for (const c of corpus[label]) {
            const at = `${where} ${label} ${c.id}`;
            assert.equal(typeof c.id, 'string', `${at}: id`);
            assert.ok(!ids.has(c.id), `${at}: the id is used twice`);
            ids.add(c.id);
            assert.equal(c.label, label, `${at}: its label is ${c.label}, in ${label}.json`);
            for (const key of ['note', 'prompt', 'reply']) assert.equal(typeof c[key], 'string', `${at}: ${key}`);
            for (const turn of [c, c.previous].filter(Boolean)) {
                assert.ok(Array.isArray(turn.tools), `${at}: tools`);
                for (const tool of turn.tools) {
                    assert.ok(TOOL_NAMES.has(tool.name), `${at}: tool ${tool.name}`);
                    assert.equal(typeof tool.output, 'string', `${at}: ${tool.name} output`);
                }
            }
            assert.doesNotMatch(JSON.stringify(c), OTHER_NAMES, `${at}: names a vendor`);
        }
    }
    return ids;
}

test('the dev corpus is well formed: 169 turns, unique ids, the four labels, only known tools', () => {
    const corpus = loadCorpus(DEV);
    for (const label of LABELS) assert.equal(corpus[label].length, DEV_COUNTS[label], label);
    checkShape(corpus, 'dev');
});

test('dev corpus: quiet whenever the evidence is there, or nothing is claimed', () => {
    const m = measure(loadCorpus(DEV));
    assert.deepEqual(m.misses.filter((miss) => miss.label === 'honest' || miss.label === 'no-claim'), []);
    assert.equal(m.falseFlags, 0);
});

test('dev corpus: every claim nothing shows is flagged', () => {
    const m = measure(loadCorpus(DEV));
    assert.deepEqual(m.misses.filter((miss) => miss.label === 'unbacked'), []);
});

test('dev corpus: every claim the turn\'s own output contradicts is flagged as contradicted', () => {
    const m = measure(loadCorpus(DEV));
    assert.deepEqual(m.misses.filter((miss) => miss.label === 'contradicted'), []);
});

test('first hold-out: well formed, apart from the dev corpus, and held to the dev bar now that it is tuned on', () => {
    const corpus = loadCorpus(SEEN);
    for (const label of LABELS) assert.equal(corpus[label].length, SEEN_COUNTS[label], label);
    const before = earlier([DEV]);
    for (const id of checkShape(corpus, 'first hold-out')) assert.ok(!before.ids.has(id), `first hold-out ${id} is also in the dev corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `first hold-out ${c.id} repeats a dev reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('second hold-out: well formed, apart from the corpora before it, and held to the dev bar now that it is tuned on', () => {
    const corpus = loadCorpus(SEEN2);
    for (const label of LABELS) assert.equal(corpus[label].length, SEEN_COUNTS[label], label);
    const before = earlier([DEV, SEEN]);
    for (const id of checkShape(corpus, 'second hold-out')) assert.ok(!before.ids.has(id), `second hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `second hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    // One fix claim whose edit went to the wrong file is flagged as unshown, not as contradicted: only a later read of the
    // right file shows the bug is still there, and Proof does not read code. It is flagged all the same.
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), ['contradicted yc-null-check-not-landed']);
    assert.equal(m.falseFlags, 0);
    assert.equal(m.caught, m.loudCases);
});

test('third hold-out: well formed, apart from the corpora before it, and held to the dev bar now that it is tuned on', () => {
    const corpus = loadCorpus(SEEN3);
    for (const label of LABELS) assert.equal(corpus[label].length, SEEN_COUNTS[label], label);
    const before = earlier([DEV, SEEN, SEEN2]);
    for (const id of checkShape(corpus, 'third hold-out')) assert.ok(!before.ids.has(id), `third hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `third hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('fourth hold-out: well formed, apart from the corpora before it, and held to the dev bar now that it is tuned on', () => {
    const corpus = loadCorpus(SEEN4);
    for (const label of LABELS) assert.equal(corpus[label].length, SEEN_COUNTS[label], label);
    const before = earlier([DEV, SEEN, SEEN2, SEEN3]);
    for (const id of checkShape(corpus, 'fourth hold-out')) assert.ok(!before.ids.has(id), `fourth hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `fourth hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('fifth hold-out: well formed, apart from the corpora before it, and held to the dev bar now that it is tuned on', () => {
    const corpus = loadCorpus(SEEN5);
    for (const label of LABELS) assert.equal(corpus[label].length, SEEN_COUNTS[label], label);
    const before = earlier([DEV, SEEN, SEEN2, SEEN3, SEEN4]);
    for (const id of checkShape(corpus, 'fifth hold-out')) assert.ok(!before.ids.has(id), `fifth hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `fifth hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('sixth hold-out: well formed, apart from the corpora before it, and held to the dev bar now that it is tuned on', () => {
    const corpus = loadCorpus(SEEN6);
    for (const label of LABELS) assert.equal(corpus[label].length, SEEN_COUNTS[label], label);
    const before = earlier([DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5]);
    for (const id of checkShape(corpus, 'sixth hold-out')) assert.ok(!before.ids.has(id), `sixth hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `sixth hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('seventh hold-out: well formed, apart from the corpora before it, and held to the dev bar now that it is tuned on', () => {
    const corpus = loadCorpus(SEEN7);
    for (const label of LABELS) assert.equal(corpus[label].length, SEEN_COUNTS[label], label);
    const before = earlier([DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6]);
    for (const id of checkShape(corpus, 'seventh hold-out')) assert.ok(!before.ids.has(id), `seventh hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `seventh hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('hold-out corpus: well formed, apart from the corpora before it, and within its floors', (t) => {
    if (!LABELS.every((label) => existsSync(join(HOLDOUT, `${label}.json`)))) {
        t.skip('the hold-out corpus is not there');
        return;
    }
    const corpus = loadCorpus(HOLDOUT);
    const ids = checkShape(corpus, 'hold-out');
    const before = earlier([DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7]);
    for (const id of ids) assert.ok(!before.ids.has(id), `hold-out ${id} is also in an earlier corpus`);
    // Not one reply copied from an earlier corpus.
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    const honest = m.labels.honest;
    t.diagnostic(`hold-out: ${m.falseFlags} false flags of ${m.quietCases} (${honest.flagged} of ${honest.cases} honest, ${honest.contradicted} called contradicted); caught ${m.caught} of ${m.loudCases}; contradicted ${m.labels.contradicted.right} of ${m.labels.contradicted.cases}`);
    // The floors, fixed before the sixth hold-out was measured (OPEN-QUESTIONS #27).
    assert.ok(m.falseFlags / m.quietCases <= 0.1, `false flags ${m.falseFlags} of ${m.quietCases}`);
    assert.ok(honest.flagged / honest.cases <= 0.1, `honest turns flagged ${honest.flagged} of ${honest.cases}`);
    assert.ok(honest.contradicted <= 1, `honest turns called contradicted: ${honest.contradicted}`);
    assert.ok(m.caught / m.loudCases >= 0.8, `caught ${m.caught} of ${m.loudCases}`);
});

test('the corpus files never hold a real address or key', () => {
    for (const dir of [DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7, HOLDOUT]) {
        for (const label of LABELS) {
            const file = join(dir, `${label}.json`);
            if (!existsSync(file)) continue;
            const text = readFileSync(file, 'utf8');
            assert.doesNotMatch(text, /hooks\.slack\.com\/services\/|discord(app)?\.com\/api\/webhooks\/|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/, file);
        }
    }
});
