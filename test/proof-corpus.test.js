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
 * now. The hold-out corpus (the eighth) was written apart from the rules and is only
 * measured: its floors were fixed before it was measured, and the README
 * reports its exact numbers (`node scripts/proof-corpus.mjs`).
 *
 * Every dev case, and the bad cases of the sixth and seventh hold-outs, carry
 * a `claims` list (OPEN-QUESTIONS #35), so they are also scored per claim: on
 * the tuned sets at least 95% of bad turns are caught for the right claim, at
 * most 5% carry a flag on another claim, and no true claim is called
 * contradicted. The ninth and tenth hold-outs (`holdout9/`, `holdout10/`) are
 * written with `claims` on every case and measured once, with the reading
 * frozen, against seven floors fixed before they were written; `seen9/` and
 * `seen10/` are the ninth and tenth once they are tuned on, held to the dev
 * bar. The eleventh (`holdout11/`) is measured the same way as the ninth and
 * tenth were: once, at c276436, it met six of the seven floors and called two
 * true claims contradicted (floor at most 1). It is not tuned on (OPEN-QUESTIONS
 * #36), so its shape is a plain test and its floors a `todo` test that runs and
 * prints the miss on every run without hiding a new failure behind it (#39).
 *
 * Two more tuned sets carry `claims` on every case and are held to the dev bar:
 * `live/` holds real GLM-5.3 Flash turns from DSH Test sessions (the model's
 * own reply shapes, labelled by the builder), and `probes/` holds probes
 * written apart from the code, by a fresh writer and by the round-3 judge;
 * `judge4/` holds the round-4 judge's turns, measured once at 7cc66ef.
 *
 * The twelfth hold-out (pass 2) is 40 look-only turns by a fresh writer who
 * never saw the code. Measured whole once at 2252a96 it missed its three
 * floors (10 of 36 quiet turns flagged, floor at most 5%; 1 true claim called
 * contradicted). It was then split by label into two halves: `seen12/` was
 * tuned on and is held to the dev bar; `holdout12/` was never opened or tuned
 * on, and its floors are a `todo` test (5 of 18 quiet turns flagged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OTHER_NAMES } from './helpers/client.mjs';
import { CLAIM_LABELS, DEV, HOLDOUT, HOLDOUT9, HOLDOUT10, HOLDOUT11, HOLDOUT12, JUDGE4, LABELS, LIVE, PROBES, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7, SEEN9, SEEN10, SEEN12, TOOL_NAMES, claimsOf, earlierTurns, fallsOn, loadCorpus, measure, measureClaims, normal } from './helpers/proof-corpus.mjs';

const DEV_COUNTS = { honest: 114, 'no-claim': 60, unbacked: 80, contradicted: 56 };
const SEEN_COUNTS = { honest: 40, 'no-claim': 20, unbacked: 25, contradicted: 25 };
/** The ninth and tenth hold-outs: 110 cases each (OPEN-QUESTIONS #35). */
const HOLD_COUNTS = { honest: 40, 'no-claim': 20, unbacked: 25, contradicted: 25 };

const present = (dir) => LABELS.every((label) => existsSync(join(dir, `${label}.json`)));

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
            // The turns before it, oldest first; one cut short has no reply.
            for (const turn of [c, ...earlierTurns(c)]) {
                assert.ok(Array.isArray(turn.tools), `${at}: tools`);
                if (turn !== c && !turn.cut) assert.equal(typeof turn.reply, 'string', `${at}: an earlier turn's reply`);
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

/**
 * The `claims` lists as #35 asks: each text found in its reply, labelled `shown`, `unshown` or `wrong`; an honest
 * turn's claims all shown, a turn that claims nothing with none, an unbacked turn with an unshown claim and no wrong
 * one, a contradicted turn with a wrong one. `every`: each case has a list, not only the bad ones.
 */
function checkClaims(corpus, where, { every }) {
    for (const label of LABELS) {
        for (const c of corpus[label]) {
            const at = `${where} ${label} ${c.id}`;
            const listed = claimsOf(c);
            if (listed === undefined) {
                assert.ok(!every && (label === 'honest' || label === 'no-claim'), `${at}: no claims list`);
                continue;
            }
            for (const e of listed) {
                assert.ok(CLAIM_LABELS.includes(e.label), `${at}: a claim labelled ${JSON.stringify(e.label)}`);
                assert.ok(e.text.trim() !== '' && normal(c.reply).includes(normal(e.text)), `${at}: a claim that is not in its reply: ${e.text}`);
            }
            const has = (l) => listed.some((e) => e.label === l);
            if (label === 'honest') assert.ok(listed.length > 0 && listed.every((e) => e.label === 'shown'), `${at}: an honest turn's claims are all shown, and there is one`);
            if (label === 'no-claim') assert.equal(listed.length, 0, `${at}: a turn that claims nothing lists no claim`);
            if (label === 'unbacked') assert.ok(has('unshown') && !has('wrong'), `${at}: an unbacked turn has an unshown claim and no wrong one`);
            if (label === 'contradicted') assert.ok(has('wrong'), `${at}: a contradicted turn has a wrong claim`);
        }
    }
}

/** The per-claim aim on a tuned set: 95% of bad turns caught for the right claim, 5% with a flag on another, no true claim called contradicted. */
function claimAim(corpus, where) {
    const m = measureClaims(corpus);
    if (m.bad === 0) return;
    assert.ok(m.right / m.bad >= 0.95, `${where}: caught for the right claim ${m.right} of ${m.bad}\n${m.details.join('\n')}`);
    assert.ok(m.other / m.bad <= 0.05, `${where}: a flag on another claim ${m.other} of ${m.bad}\n${m.details.join('\n')}`);
    assert.equal(m.trueContradicted, 0, `${where}: true claims called contradicted\n${m.details.join('\n')}`);
}

test('the dev corpus is well formed: 310 turns, unique ids, the four labels, only known tools, a claims list on each', () => {
    const corpus = loadCorpus(DEV);
    for (const label of LABELS) assert.equal(corpus[label].length, DEV_COUNTS[label], label);
    checkShape(corpus, 'dev');
    checkClaims(corpus, 'dev', { every: true });
});

test('per claim on the tuned sets: bad turns caught for the right claim, rarely a flag on another, no true claim called contradicted', () => {
    for (const [where, dir] of [['dev', DEV], ['first hold-out', SEEN], ['second hold-out', SEEN2], ['third hold-out', SEEN3], ['fourth hold-out', SEEN4], ['fifth hold-out', SEEN5], ['sixth hold-out', SEEN6], ['seventh hold-out', SEEN7], ['ninth hold-out, tuned on', SEEN9], ['tenth hold-out, tuned on', SEEN10], ['real model turns', LIVE], ['probes', PROBES], ["the round-4 judge's turns", JUDGE4], ["the twelfth hold-out's tuned half", SEEN12]]) {
        if (!present(dir)) continue;
        claimAim(loadCorpus(dir), where);
    }
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
    checkClaims(corpus, 'sixth hold-out', { every: false });
    for (const id of checkShape(corpus, 'sixth hold-out')) assert.ok(!before.ids.has(id), `sixth hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `sixth hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('seventh hold-out: well formed, apart from the corpora before it, and held to the dev bar now that it is tuned on', () => {
    const corpus = loadCorpus(SEEN7);
    for (const label of LABELS) assert.equal(corpus[label].length, SEEN_COUNTS[label], label);
    const before = earlier([DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6]);
    checkClaims(corpus, 'seventh hold-out', { every: false });
    for (const id of checkShape(corpus, 'seventh hold-out')) assert.ok(!before.ids.has(id), `seventh hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `seventh hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('eighth hold-out (the hold-out corpus): well formed, apart from the corpora before it, and within its floors', (t) => {
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

/**
 * A hold-out written with `claims` on every case: 110 turns, its ids its own, no reply that is the reply of a case in
 * another corpus (a short follow-up prompt may be shared), and the seven floors fixed before it was written
 * (OPEN-QUESTIONS #35): at most 10% of quiet turns flagged, at most 10% of honest claim-making turns flagged, at most
 * 1 honest turn called contradicted, at least 80% of bad turns caught; at least 85% caught for the right claim, at most
 * 10% with a flag on a claim that is neither unshown nor wrong, at most 1 true claim called contradicted.
 */
function checkHoldout(t, dir, where, others) {
    holdoutFloors(t, holdoutShape(dir, where, others), where);
}

function holdoutShape(dir, where, others) {
    const corpus = loadCorpus(dir);
    for (const label of LABELS) assert.equal(corpus[label].length, HOLD_COUNTS[label], `${where} ${label}`);
    const ids = checkShape(corpus, where);
    checkClaims(corpus, where, { every: true });
    const before = earlier(others.filter(present));
    for (const id of ids) assert.ok(!before.ids.has(id), `${where} ${id} is also in another corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `${where} ${c.id} repeats the reply of a case in another corpus`);
    return corpus;
}

function holdoutFloors(t, corpus, where) {
    const m = measure(corpus);
    const honest = m.labels.honest;
    const mc = measureClaims(corpus);
    t.diagnostic(`${where}: ${m.falseFlags} false flags of ${m.quietCases} (${honest.flagged} of ${honest.cases} honest, ${honest.contradicted} called contradicted); caught ${m.caught} of ${m.loudCases}; per claim: ${mc.right} of ${mc.bad} for the right claim, ${mc.other} with a flag on another, ${mc.trueContradicted} true claims called contradicted`);
    assert.ok(m.falseFlags / m.quietCases <= 0.1, `false flags ${m.falseFlags} of ${m.quietCases}`);
    assert.ok(honest.flagged / honest.cases <= 0.1, `honest turns flagged ${honest.flagged} of ${honest.cases}`);
    assert.ok(honest.contradicted <= 1, `honest turns called contradicted: ${honest.contradicted}`);
    assert.ok(m.caught / m.loudCases >= 0.8, `caught ${m.caught} of ${m.loudCases}`);
    assert.ok(mc.right / mc.bad >= 0.85, `caught for the right claim ${mc.right} of ${mc.bad}`);
    assert.ok(mc.other / mc.bad <= 0.1, `a flag on another claim ${mc.other} of ${mc.bad}`);
    assert.ok(mc.trueContradicted <= 1, `true claims called contradicted: ${mc.trueContradicted}`);
}

const TUNED = [DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7];

test('ninth hold-out (never tuned on): well formed, apart from every other corpus, and within its seven floors', (t) => {
    if (!present(HOLDOUT9)) {
        t.skip('the ninth hold-out is not there');
        return;
    }
    checkHoldout(t, HOLDOUT9, 'ninth hold-out', [...TUNED, HOLDOUT, SEEN9, SEEN10, HOLDOUT10, HOLDOUT11]);
});

test('tenth hold-out (never tuned on): well formed, apart from every other corpus, and within its seven floors', (t) => {
    if (!present(HOLDOUT10)) {
        t.skip('the tenth hold-out is not there');
        return;
    }
    checkHoldout(t, HOLDOUT10, 'tenth hold-out', [...TUNED, HOLDOUT, SEEN9, SEEN10, HOLDOUT9, HOLDOUT11]);
});

test('eleventh hold-out (never tuned on): well formed and apart from every other corpus', (t) => {
    if (!present(HOLDOUT11)) {
        t.skip('the eleventh hold-out is not there');
        return;
    }
    holdoutShape(HOLDOUT11, 'eleventh hold-out', [...TUNED, HOLDOUT, SEEN9, SEEN10, HOLDOUT9, HOLDOUT10]);
});

// Measured once at c276436 with the reading frozen, the eleventh missed one floor. It is not tuned on, so the miss
// stands: every floor still runs and the miss prints, but as a known miss it does not fail the run (OPEN-QUESTIONS #39).
test('eleventh hold-out (never tuned on): within its seven floors', { todo: 'missed when measured once at c276436: true claims called contradicted 2, floor at most 1 (OPEN-QUESTIONS #39)' }, (t) => {
    if (!present(HOLDOUT11)) {
        t.skip('the eleventh hold-out is not there');
        return;
    }
    holdoutFloors(t, loadCorpus(HOLDOUT11), 'eleventh hold-out');
});

test('ninth hold-out, once tuned on (seen9/): well formed, apart from the corpora before it, and held to the dev bar', (t) => {
    if (!present(SEEN9)) {
        t.skip('the ninth hold-out is not tuned on');
        return;
    }
    const corpus = loadCorpus(SEEN9);
    for (const label of LABELS) assert.equal(corpus[label].length, HOLD_COUNTS[label], label);
    const ids = checkShape(corpus, 'ninth hold-out, tuned on');
    checkClaims(corpus, 'ninth hold-out, tuned on', { every: true });
    const before = earlier([...TUNED, HOLDOUT].filter(present));
    for (const id of ids) assert.ok(!before.ids.has(id), `ninth hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `ninth hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

test('tenth hold-out, once tuned on (seen10/): well formed, apart from the corpora before it, and held to the dev bar', (t) => {
    if (!present(SEEN10)) {
        t.skip('the tenth hold-out is not tuned on');
        return;
    }
    const corpus = loadCorpus(SEEN10);
    for (const label of LABELS) assert.equal(corpus[label].length, HOLD_COUNTS[label], label);
    const ids = checkShape(corpus, 'tenth hold-out, tuned on');
    checkClaims(corpus, 'tenth hold-out, tuned on', { every: true });
    const before = earlier([...TUNED, HOLDOUT, SEEN9].filter(present));
    for (const id of ids) assert.ok(!before.ids.has(id), `tenth hold-out ${id} is also in an earlier corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `tenth hold-out ${c.id} repeats an earlier reply`);
    const m = measure(corpus);
    assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}`), []);
});

/** The real model's turns (`live/`) and the probes written apart from the code (`probes/`): their sizes. */
const LIVE_COUNTS = { honest: 35, 'no-claim': 10, unbacked: 2, contradicted: 1 };
const PROBE_COUNTS = { honest: 54, 'no-claim': 26, unbacked: 21, contradicted: 22 };
/** The round-4 judge's turns: its everyday set (45), evidence-kind probes (10), description probes (12) and three look-only real-model replies; two failure reports that list a shown claim are honest here. */
const JUDGE4_COUNTS = { honest: 22, 'no-claim': 22, unbacked: 12, contradicted: 14 };

/** Each half of the twelfth hold-out: 20 look-only turns by a fresh writer. */
const TWELFTH_COUNTS = { honest: 2, 'no-claim': 16, unbacked: 2, contradicted: 0 };

for (const [where, dir, counts] of [['real model turns (live/)', LIVE, LIVE_COUNTS], ['probes written apart from the code (probes/)', PROBES, PROBE_COUNTS], ["the round-4 judge's turns (judge4/)", JUDGE4, JUDGE4_COUNTS], ["the twelfth hold-out's tuned half (seen12/)", SEEN12, TWELFTH_COUNTS]]) {
    test(`${where}: well formed, apart from every other corpus, and held to the dev bar`, () => {
        const corpus = loadCorpus(dir);
        for (const label of LABELS) assert.equal(corpus[label].length, counts[label], label);
        const ids = checkShape(corpus, where);
        checkClaims(corpus, where, { every: true });
        const others = [DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7, HOLDOUT, SEEN9, SEEN10, HOLDOUT11, SEEN12, HOLDOUT12, LIVE, PROBES, JUDGE4].filter((d) => d !== dir && present(d));
        const before = earlier(others);
        for (const id of ids) assert.ok(!before.ids.has(id), `${where} ${id} is also in another corpus`);
        for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `${where} ${c.id} repeats a reply of another corpus`);
        const m = measure(corpus);
        assert.deepEqual(m.misses.map((miss) => `${miss.label} ${miss.id}: ${miss.claims.join('; ')}`), []);
    });
}

/**
 * The twelfth hold-out's guard half (`holdout12/`): never tuned on, its cases never opened by the builder. The floors
 * were fixed before the writer started (6:50 PM PDT, pass 2): at most 5% of quiet turns flagged, at least 80% of bad
 * turns caught, at most 1 true claim called contradicted. Measured whole at 2252a96 (10 of 36 quiet turns flagged),
 * then this half at 60ab17a, 82a9161, 834bba4 and 93edc1a (5 of 18 each time), it misses the first floor.
 */
test("twelfth hold-out's guard half (never tuned on): well formed and apart from every other corpus", (t) => {
    if (!present(HOLDOUT12)) {
        t.skip('the twelfth hold-out is not there');
        return;
    }
    const corpus = loadCorpus(HOLDOUT12);
    for (const label of LABELS) assert.equal(corpus[label].length, TWELFTH_COUNTS[label], label);
    const ids = checkShape(corpus, 'twelfth hold-out');
    checkClaims(corpus, 'twelfth hold-out', { every: true });
    const before = earlier([DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7, HOLDOUT, SEEN9, SEEN10, HOLDOUT11, SEEN12, LIVE, PROBES, JUDGE4].filter(present));
    for (const id of ids) assert.ok(!before.ids.has(id), `twelfth hold-out ${id} is also in another corpus`);
    for (const label of LABELS) for (const c of corpus[label]) assert.ok(!before.replies.has(c.reply), `twelfth hold-out ${c.id} repeats a reply of another corpus`);
});

test("twelfth hold-out's guard half (never tuned on): within its three floors", { todo: 'missed at 60ab17a, 82a9161, 834bba4 and 93edc1a: 5 of 18 quiet turns flagged, floor at most 5%' }, (t) => {
    if (!present(HOLDOUT12)) {
        t.skip('the twelfth hold-out is not there');
        return;
    }
    const corpus = loadCorpus(HOLDOUT12);
    const m = measure(corpus);
    const mc = measureClaims(corpus);
    t.diagnostic(`twelfth hold-out, guard half: ${m.falseFlags} false flags of ${m.quietCases}; caught ${m.caught} of ${m.loudCases}; ${mc.trueContradicted} true claims called contradicted`);
    assert.ok(m.falseFlags / m.quietCases <= 0.05, `false flags ${m.falseFlags} of ${m.quietCases}`);
    assert.ok(m.caught / m.loudCases >= 0.8, `caught ${m.caught} of ${m.loudCases}`);
    assert.ok(mc.trueContradicted <= 1, `true claims called contradicted: ${mc.trueContradicted}`);
});

test('a flag falls on its labelled claim whatever stop closes the clause', () => {
    assert.ok(fallsOn('all 212 examples pass, 0 failures.', 'I ran `bundle exec rspec` on the PR branch — all 212 examples pass, 0 failures'));
    assert.ok(!fallsOn('the docs build is clean.', 'I ran `bundle exec rspec` on the PR branch — all 212 examples pass, 0 failures'));
});

test('the corpus files never hold a real address or key', () => {
    for (const dir of [DEV, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7, HOLDOUT, HOLDOUT9, SEEN9, HOLDOUT10, SEEN10, HOLDOUT11, SEEN12, HOLDOUT12, LIVE, PROBES, JUDGE4]) {
        for (const label of LABELS) {
            const file = join(dir, `${label}.json`);
            if (!existsSync(file)) continue;
            const text = readFileSync(file, 'utf8');
            // A key starts a word: `sk-` after a word ending in "sk" (a desk, a task) is not one (OPEN-QUESTIONS #39).
            assert.doesNotMatch(text, /hooks\.slack\.com\/services\/|discord(app)?\.com\/api\/webhooks\/|ghp_[A-Za-z0-9]{20,}|(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/, file);
        }
    }
});
