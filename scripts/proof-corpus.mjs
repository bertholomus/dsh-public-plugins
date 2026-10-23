#!/usr/bin/env node
/**
 * Proof's measured rates on its labelled corpora, as the README reports them:
 *
 *     node scripts/proof-corpus.mjs          # one row per corpus
 *     node scripts/proof-corpus.mjs --misses # and each case it got wrong
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEV, HOLDOUT, LABELS, SEEN, SEEN2, SEEN3, SEEN4, SEEN5, SEEN6, SEEN7, loadCorpus, measure, quietTable, table } from '../test/helpers/proof-corpus.mjs';

const all = [];
for (const [name, dir] of [['Dev (tuned on)', DEV], ['First hold-out (measured once, then tuned on)', SEEN], ['Second hold-out (measured once, then tuned on)', SEEN2], ['Third hold-out (measured once, then tuned on)', SEEN3], ['Fourth hold-out (measured once, then tuned on)', SEEN4], ['Fifth hold-out (measured once, then tuned on)', SEEN5], ['Sixth hold-out (measured once, then tuned on)', SEEN6], ['Seventh hold-out (measured once, then tuned on)', SEEN7], ['Hold-out (never tuned on)', HOLDOUT]]) {
    if (!LABELS.every((label) => existsSync(join(dir, `${label}.json`)))) continue;
    all.push([name, measure(loadCorpus(dir))]);
}
console.log('| Corpus | Turns with evidence or no claim | Flagged anyway (false flags) | Turns with an unshown or wrong claim | Flagged (caught) | Wrong claims called contradicted |');
console.log('|---|---|---|---|---|---|');
for (const [name, m] of all) console.log(table(name, m));
console.log('\n| Corpus | Honest turns that claim something | Flagged | Called contradicted | Turns that claim nothing | Flagged |');
console.log('|---|---|---|---|---|---|');
for (const [name, m] of all) console.log(quietTable(name, m));
if (process.argv.includes('--misses')) {
    for (const [name, m] of all) {
        for (const miss of m.misses) console.log(`\n[${name}] ${miss.label} ${miss.id}\n  ${miss.claims.join('\n  ') || '(no claim found)'}`);
    }
}
