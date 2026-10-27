#!/usr/bin/env node
/**
 * Proof's measured rates on its labelled corpora, as the README reports them:
 *
 *     node scripts/proof-corpus.mjs          # one row per corpus, per turn and per claim
 *     node scripts/proof-corpus.mjs --misses # and each case it got wrong
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEV, HOLDOUT, HOLDOUT9, HOLDOUT10, HOLDOUT11, HOLDOUT12, JUDGE4, SEEN12, LABELS, LIVE, PROBES, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7, SEEN9, SEEN10, claimTable, loadCorpus, measure, measureClaims, quietTable, table } from '../test/helpers/proof-corpus.mjs';

const CORPORA = [
    ['Dev (tuned on)', DEV],
    ['First hold-out (measured once, then tuned on)', SEEN],
    ['Second hold-out (measured once, then tuned on)', SEEN2],
    ['Third hold-out (measured once, then tuned on)', SEEN3],
    ['Fourth hold-out (measured once, then tuned on)', SEEN4],
    ['Fifth hold-out (measured once, then tuned on)', SEEN5],
    ['Sixth hold-out (measured once, then tuned on)', SEEN6],
    ['Seventh hold-out (measured once, then tuned on)', SEEN7],
    ['Ninth hold-out (measured once, then tuned on)', SEEN9],
    ['Tenth hold-out (measured once, then tuned on)', SEEN10],
    ['Real model turns in DSH Test (tuned on)', LIVE],
    ['Probes written apart from the code (tuned on)', PROBES],
    ["The round-4 judge's turns (measured once at 7cc66ef, then tuned on)", JUDGE4],
    ['Twelfth hold-out, tuned half: look-only turns (measured once at 2252a96, then tuned on)', SEEN12],
    ['Eighth hold-out (never tuned on)', HOLDOUT],
    ['Ninth hold-out (never tuned on)', HOLDOUT9],
    ['Tenth hold-out (never tuned on)', HOLDOUT10],
    ['Eleventh hold-out (never tuned on)', HOLDOUT11],
    ['Twelfth hold-out, guard half: look-only turns (never tuned on)', HOLDOUT12],
];
const all = [];
for (const [name, dir] of CORPORA) {
    if (!LABELS.every((label) => existsSync(join(dir, `${label}.json`)))) continue;
    const corpus = loadCorpus(dir);
    all.push([name, measure(corpus), measureClaims(corpus)]);
}
console.log('| Corpus | Turns with evidence or no claim | Flagged anyway (false flags) | Turns with an unshown or wrong claim | Flagged (caught) | Wrong claims called contradicted |');
console.log('|---|---|---|---|---|---|');
for (const [name, m] of all) console.log(table(name, m));
console.log('\n| Corpus | Honest turns that claim something | Flagged | Called contradicted | Turns that claim nothing | Flagged |');
console.log('|---|---|---|---|---|---|');
for (const [name, m] of all) console.log(quietTable(name, m));
// Per claim, for the corpora whose bad turns list their claims: the flag must fall on the claim that is unshown or wrong.
console.log('\n| Corpus | Turns with an unshown or wrong claim | Caught for the right claim | With a flag on another claim | True claims called contradicted |');
console.log('|---|---|---|---|---|');
for (const [name, , c] of all) {
    const row = claimTable(name, c);
    if (row) console.log(row);
}
if (process.argv.includes('--misses')) {
    for (const [name, m] of all) {
        for (const miss of m.misses) console.log(`\n[${name}] ${miss.label} ${miss.id}\n  ${miss.claims.join('\n  ') || '(no claim found)'}`);
    }
}
