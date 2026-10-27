// Autopilot's reading of a reply's end (plugins/autopilot/lib/ends.js): whether it waits on the person, so a
// nudge would talk over them. Measured on labelled endings (test/fixtures/autopilot/endings.json):
//
// - real: the last lines of 84 final replies from the suite's DSH Test sessions on 2026-10-26 (the stack's local
//   models, a few from the scripted model), labelled by hand;
// - judge-round-5: the nine endings round 5's judge probed;
// - written: 40 endings written for the rule, 20 that hand over and 20 that do not; written-2: 30 more, written
//   after held-out-3 was read;
// - held-out-1, -2 and -3: 44, 32 and 30 endings, each written after the rule of its day was frozen and measured
//   once (ends.js fa671cc…: 0 false holds, 4 misses; f22a4e0…: 0 and 3; a5fa8b4…: 1 and 2), then used to widen the
//   rule, so they count as development endings now;
// - held-out-4: 30 endings written after the rule was frozen and measured once (ends.js dcb96ff…): 1 false hold,
//   3 misses. One guard came after ("until you tell me to stop" is no hand-over) and changes none of the 30, so
//   they are the shipped rule's numbers; the README gives them.
//
// A false hold is an ending that does not wait on the person but holds the nudge (the session is left idle with
// its work open); a miss is one that waits on the person but gets the nudge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { goesOn, handOverIn, handsOver, waitsOnPerson } from '../plugins/autopilot/lib/ends.js';
import { asksSomeone } from '../plugins/autopilot/lib/shared/words.js';

const sets = JSON.parse(readFileSync(new URL('./fixtures/autopilot/endings.json', import.meta.url), 'utf8'));

/** False holds and misses of a rule over a set of labelled endings. */
function measure(items, rule) {
    const out = { endings: items.length, waits: 0, falseHolds: [], misses: [] };
    for (const item of items) {
        if (item.hold) out.waits += 1;
        const held = rule(item.text);
        if (held && !item.hold) out.falseHolds.push(item.text);
        if (!held && item.hold) out.misses.push(item.text);
    }
    return out;
}

const rate = (n, of) => `${n} of ${of} (${of ? Math.round((100 * n) / of) : 0}%)`;

test('the corpus: real endings from DSH Test, the judge\'s nine, written ones and four held-out sets, each labelled', () => {
    assert.deepEqual(Object.keys(sets), ['real', 'judge', 'written', 'written2', 'heldOut1', 'heldOut2', 'heldOut3', 'heldOut4']);
    assert.equal(sets.real.length, 84);
    assert.equal(sets.judge.length, 9);
    assert.equal(sets.heldOut2.length, 32);
    assert.equal(sets.heldOut3.length, 30);
    assert.equal(sets.heldOut4.length, 30);
    for (const [name, items] of Object.entries(sets)) {
        for (const item of items) {
            assert.equal(typeof item.text, 'string', name);
            assert.ok(item.text.trim().length > 0, name);
            assert.equal(typeof item.hold, 'boolean', name);
            assert.ok(item.text.split('\n').length <= 6, `${name}: the rule reads the last 6 lines, the corpus keeps no more`);
        }
    }
    // Both kinds in every set, so each rate means something.
    for (const items of Object.values(sets)) assert.ok(items.some((i) => i.hold) && items.some((i) => !i.hold));
});

test('the development endings: no false hold and no miss', (t) => {
    for (const name of ['real', 'judge', 'written', 'written2', 'heldOut1', 'heldOut2', 'heldOut3']) {
        const m = measure(sets[name], waitsOnPerson);
        t.diagnostic(`${name}: false holds ${rate(m.falseHolds.length, m.endings - m.waits)}, misses ${rate(m.misses.length, m.waits)}`);
        assert.deepEqual(m.falseHolds, [], `${name}: false holds`);
        assert.deepEqual(m.misses, [], `${name}: misses`);
    }
});

test('the held-out endings, measured once with the rule as shipped: 1 false hold of 15 and 3 misses of 15, as the README says', (t) => {
    const m = measure(sets.heldOut4, waitsOnPerson);
    t.diagnostic(`held-out-4: false holds ${rate(m.falseHolds.length, m.endings - m.waits)}, misses ${rate(m.misses.length, m.waits)}`);
    // A false hold leaves the session idle with its work open; a miss sends the nudge, which the agent can answer
    // with a DECISION NEEDED line.
    assert.deepEqual(m.falseHolds, ['Fixed. Feel free to ping me if the error comes back.']);
    assert.deepEqual(m.misses, [
        'I don\'t have write access to the `infra` repo, so the DNS change has to come from you.',
        'There\'s a trade-off between speed and memory here; I\'ll go with whatever you decide.',
        'I could split the module now or after the release — your choice.',
    ]);
});

test('the suite\'s broad rule (asksSomeone: any offer in the last 6 lines) holds what this one does not, on the same endings', (t) => {
    let falseHolds = 0;
    let misses = 0;
    for (const [name, items] of Object.entries(sets)) {
        const m = measure(items, asksSomeone);
        falseHolds += m.falseHolds.length;
        misses += m.misses.length;
        t.diagnostic(`asksSomeone on ${name}: false holds ${rate(m.falseHolds.length, m.endings - m.waits)}, misses ${rate(m.misses.length, m.waits)}`);
    }
    // Round 5's four false holds among them.
    const judge = measure(sets.judge, asksSomeone);
    assert.deepEqual(judge.falseHolds, [
        'All tests pass. Happy to keep going with the next todo.',
        'I am happy to report the build is green. Moving on to the docs next.',
        'Feel free to review the diff; I will carry on with the remaining two todos.',
        'If you would like a different name, say so. Next up: the README.',
    ]);
    assert.equal(falseHolds, 39);
    assert.equal(misses, 49);
});

test('the judge\'s nine endings, one by one', () => {
    const want = {
        'Done with step 1 of 3. Next I will write the parser.': false,
        'Step 1 is done. Let me know if you want me to continue with steps 2 and 3.': true,
        'All tests pass. Happy to keep going with the next todo.': false,
        'I am happy to report the build is green. Moving on to the docs next.': false,
        'Wrote `a?b` regex in parse.js and the tests. Next: the CLI.': false,
        'Should I use Postgres or SQLite?': true,
        'DECISION NEEDED: which port? — recommend: 8080': true,
        'Feel free to review the diff; I will carry on with the remaining two todos.': false,
        'If you would like a different name, say so. Next up: the README.': false,
    };
    for (const [text, waits] of Object.entries(want)) assert.equal(waitsOnPerson(text), waits, text);
});

test('the parts: which sentence hands over, what says the agent goes on, and what is only a courtesy', () => {
    assert.equal(handOverIn('Step 1 is done. Let me know if you want me to continue with steps 2 and 3.'), 'Let me know if you want me to continue with steps 2 and 3.');
    assert.equal(handOverIn('Wrote the parser.\n\n**Say the word** and I\'ll run the tests.'), 'Say the word and I\'ll run the tests.');
    assert.equal(handOverIn('- Want me to apply it? No: plain words only.'), undefined, 'a question is asksForAnswer\'s, not a hand-over');
    assert.equal(handOverIn('Let me know if you want me to keep the flag.\nNext: the README.'), undefined, 'the last line goes on');
    assert.equal(handOverIn('Let me know if this looks good, and I\'ll move on to the tests.'), 'Let me know if this looks good, and I\'ll move on to the tests.', 'a last line that goes on only after the person');
    assert.equal(handsOver('Let me know if you have any questions.'), false);
    assert.equal(handsOver('Let me know if you want me to fix anything else.'), true, 'a courtesy that still asks about the next step');
    assert.equal(handsOver('If you want a stricter check, use ==.'), false, 'advice');
    assert.equal(handsOver('If you want, I can add the check.'), true);
    assert.equal(handsOver('Happy to try another colour next.'), true);
    assert.equal(handsOver('Happy to keep going with the next todo.'), false);
    assert.equal(goesOn('Next up: the README.'), true);
    assert.equal(goesOn('I will carry on with the remaining two todos.'), true);
    assert.equal(goesOn('Moving on to the docs next.'), true);
    assert.equal(goesOn('The build is green.'), false);
    assert.equal(handsOver('Run make bench if you want more numbers.'), false, 'advice to the person');
    assert.equal(handsOver('You can rerun it with --verbose if you like.'), false);
    assert.equal(handsOver('I can add retries if you want.'), true, 'an offer');
    assert.equal(handsOver('The logs are in /tmp/run if you want to look.'), false, 'where a thing is');
    assert.equal(handsOver('I can add retries as well, if that\'s useful.'), true);
    assert.equal(handsOver('If it helps, I can draft the release notes too.'), true);
    assert.equal(handsOver('I\'m holding off on the deploy until you confirm the maintenance window.'), true);
    assert.equal(handsOver('I\'ll keep going until you tell me to stop.'), false, 'the agent goes on');
    assert.equal(handsOver('I need the API token for the sandbox before I can go on.'), true);
    assert.equal(handsOver('Your pick.'), true);
    assert.equal(handsOver('Can you check whether the staging DB is up?'), true);
    assert.equal(handOverIn('Can you check whether the staging DB is up? I can\'t reach it from here.'), 'Can you check whether the staging DB is up?');
    assert.equal(handsOver('Let me know if you hit any snags.'), false, 'a courtesy');
    assert.equal(handsOver('Let me know if you see anything odd in the output.'), false);
    for (const empty of [undefined, null, '', '   ', 42]) {
        assert.equal(waitsOnPerson(empty), false);
        assert.equal(handOverIn(empty), undefined);
    }
});
