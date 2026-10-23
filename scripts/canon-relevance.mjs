#!/usr/bin/env node
/**
 * Which notes Canon gives a prompt, on its labelled sets, as the README
 * reports it (test/helpers/canon-relevance.mjs measures):
 *
 *     node scripts/canon-relevance.mjs                # a table per set
 *     node scripts/canon-relevance.mjs --misses       # and each prompt it got wrong
 *     node scripts/canon-relevance.mjs --set dev      # one set only (dev or holdout)
 */
import { existsSync } from 'node:fs';
import { DEV, HOLDOUT, belowFloors, groups, loadSet, measure, missText, table } from '../test/helpers/canon-relevance.mjs';

const args = process.argv.slice(2);
const only = args.includes('--set') ? args[args.indexOf('--set') + 1] : '';
if (only && !['dev', 'holdout'].includes(only)) {
    console.error('--set takes dev or holdout');
    process.exit(2);
}
const sets = [['dev', 'Dev set (tuned on)', DEV], ['holdout', 'Hold-out (never tuned on)', HOLDOUT]]
    .filter(([key, , file]) => (!only || only === key) && existsSync(file));
if (sets.length === 0) {
    console.error(only ? `There is no ${only} set yet.` : 'There is no set yet.');
    process.exit(1);
}
for (const [, name, file] of sets) {
    const m = await measure(loadSet(file));
    console.log(table(name, m));
    const by = [...groups(m)].map(([key, g]) => (g.answerable
        ? `${key}: ${g.first} of ${g.answerable} first, ${g.inBlock} in the block, ${g.extra} that do not answer`
        : `${key}: ${g.noBlock} of ${g.n} no block, ${g.extra} notes added`));
    console.log(`\nBy the letters of the ids: ${by.join('; ')}.`);
    const below = belowFloors(m);
    console.log(below.length ? `Below the floors: ${below.join('; ')}.` : 'Every floor met.');
    if (m.problems.length) console.log(`\nProblems with the set:\n  ${m.problems.join('\n  ')}`);
    if (args.includes('--misses')) {
        console.log(m.misses.length ? `\nMisses (${m.misses.length}):` : '\nNo misses.');
        for (const r of m.misses) console.log(missText(r));
    }
    console.log('');
}
