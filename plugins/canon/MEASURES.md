# Canon: how well it picks notes, measured

The README's [How well it picks notes](README.md#how-well-it-picks-notes)
gives the figures as they are now. This file says how they are measured,
what each set is, and how the figures moved from round to round.

## How it is measured

Labelled sets of prompts over the fixture vault (`test/fixtures/canon/vault`:
42 notes, 35 of them active, for five projects, people, decisions, runbooks
and ideas). Each prompt goes through Canon's own recall exactly as a turn
does, with the default settings (3 notes, 2,000 characters), given only the
prompt and the session's folder (a test takes every label away and gets the
same blocks). The floors were fixed before anything was measured
(OPEN-QUESTIONS #29 and #33):

- the block's first note answers at least 80% of the prompts a note answers;
- an answering note is in the block for at least 90% of them;
- at most 1.0 notes per block do not answer;
- at least 70% of the prompts no note answers get no block;
- and so do at least 90% of the everyday coding requests no note answers.

To measure again, with each prompt that got a wrong note, an extra one or a
block it should not have:

```sh
node scripts/canon-relevance.mjs --set dev --misses
node scripts/canon-relevance.mjs --set probes --misses
```

## The sets

- **The dev set** (tuned on; 1,225 prompts, 655 that a note answers, 570
  that none does, 445 of those everyday coding requests): `dev.json` (922,
  rounds 2 and 3, from sessions in a project's folder, in a folder inside
  one, in an unrelated folder and in none, in many forms), `dev-fresh.json`
  (72 by two fresh writers in round 3), `dev-judge.json` (the round-3
  judge's 129, casually typed coding requests among them) and
  `dev-casual.json` (102: round 4's 90 casually typed prompts and decisions
  to record, and 12 decisions that also say how to save them, added after
  the round-4 judge's rm2).
- **The probe sets** (`probes.json`, tuned on, kept apart from the dev set;
  220 prompts, 96 that a note answers, 110 everyday coding requests): two
  fresh writers who read only the fixture vault and never saw Canon wrote
  them in round 5, one typing as people type to a coding agent in a hurry
  (`w1-`: "postgres: total of entries per account per month, include months
  with nothing in them") and one with care (`w3-`). They were measured at
  53646c8 and 341ff4e before any rule changed for them.
- **The first hold-out** (`holdout.json`, 48 prompts, 24 that a note
  answers; no kinds): a guard. Its prompts and misses are never read and no
  rule is chosen on it; only its figures print.
- **The second hold-out** (`holdout2.json`, 72 prompts with kinds, 24 that a
  note answers, 40 everyday coding requests): measured once at 638044e,
  tuned on from round 4 (OPEN-QUESTIONS #41).

## The figures, round by round

Round 3 is its frozen rules (638044e, as in 341ff4e); round 4 is the commit
the round-4 judge scored (b98506f, the rules frozen at 41b4130); now is
this commit. The dev set had 12 fewer prompts before now (647 a note
answers, 566 none does).

| Dev set | Round 3 | Round 4 | Now |
| --- | --- | --- | --- |
| The block's first note answers | 599 of 647 (92.6%) | 595 (92.0%) | 605 of 655 (92.4%) |
| An answering note is in the block | 614 (94.9%) | 610 (94.3%) | 620 (94.7%) |
| Notes per block that do not answer | 0.38 (233 in 620 blocks) | 0.26 (159 in 616) | 0.25 (156 in 626) |
| No block, for a prompt no note answers | 478 of 566 (84.5%) | 533 (94.2%) | 537 of 570 (94.2%) |
| No block, for an everyday coding request | 383 of 445 (86.1%) | 432 (97.1%) | 432 (97.1%) |

| Probe sets (tuned on) | Round 3 | Round 4 | Now |
| --- | --- | --- | --- |
| The block's first note answers | 74 of 96 (77.1%) | 71 (74.0%) | 73 (76.0%) |
| An answering note is in the block | 81 (84.4%) | 76 (79.2%) | 78 (81.3%) |
| Notes per block that do not answer | 0.59 (49 in 83 blocks) | 0.38 (30 in 78) | 0.39 (31 in 80) |
| No block, for a prompt no note answers | 74 of 124 (59.7%) | 113 (91.1%) | 113 (91.1%) |
| No block, for an everyday coding request | 71 of 110 (64.5%) | 101 (91.8%) | 101 (91.8%) |

| Second hold-out | Round 3 (measured once) | Round 4 | Now |
| --- | --- | --- | --- |
| The block's first note answers | 20 of 24 (83.3%) | 20 (83.3%) | 20 (83.3%) |
| An answering note is in the block | 20 (83.3%): missed | 20 (83.3%): missed | 20 (83.3%): missed |
| Notes per block that do not answer | 0.35 (7 in 20 blocks) | 0.15 (3 in 20) | 0.15 (3 in 20) |
| No block, for a prompt no note answers | 37 of 48 (77.1%) | 48 (100%) | 48 (100%) |
| No block, for an everyday coding request | 29 of 40 (72.5%): missed | 40 (100%) | 40 (100%) |

| First hold-out (guard) | Round 3 | Round 4 | Now |
| --- | --- | --- | --- |
| The block's first note answers | 22 of 24 (91.7%) | 18 (75.0%): missed | 18 (75.0%): missed |
| An answering note is in the block | 24 (100%) | 19 (79.2%): missed | 19 (79.2%): missed |
| Notes per block that do not answer | 0.71 (17 in 24 blocks) | 0.37 (7 in 19) | 0.37 (7 in 19) |
| No block, for a prompt no note answers | 21 of 24 (87.5%) | 21 (87.5%) | 21 (87.5%) |

Since round 4, the dev set gained two first notes and lost three notes that
do not answer, from reading everyday operations words as the notes' own
("bounce" as restart, "wipe" as flush, "who looks after" as owner, "get it
live" and "ship a new build" as deploy); the probe sets gained one note
that does not answer from the same change ("do i need to bounce the
gateway" after the TLS certificates are renewed now also gets Gateway
ports), and two first notes from leaving a decision's "last night" or
"today" out of what it is about ("fyi we moved the health check to 8081
last night, update the notes" gets Gateway ports). The twelve decisions
that say how to save them each get the note they change, or no block when
no note covers them, and no other prompt's block changed with that rule.

Round 4's rules keep notes off everyday coding requests (on the probe sets
about one in three got a block with round 3's rules, one in twelve since),
at a cost in recall: on the guard, two of its floors are missed since
53646c8, and nothing chosen since on the other sets moved it. `npm test`
holds the guard to no worse than that, with the floors it meets, and runs
its four floors as a known miss (a `todo` test, the way OPEN-QUESTIONS #40
set for the second hold-out). The round-4 builder also kept a hold-out of
their own, a third writer's 55 prompts on the fixture vault with a sixth
project added (not in the repo), measured once when those rules were
frozen: the block's first note answered 9 of 21 (42.9%), an answering note
was in the block for 10 (47.6%), 0.50 notes per block did not answer, and
28 of 34 prompts no note answers got no block (82.4%; everyday coding
requests 26 of 29, 89.7%). With round 3's rules the same prompts got 11 of
21 (52.4%) first and 21 of 34 (61.8%) without a block. No fresh hold-out
has been written since: on prompts in words unlike the notes', Canon still
misses many notes that bear on them.
