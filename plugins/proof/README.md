# Proof

Claims need evidence. When a turn's reply says something is done, passing,
fixed or deployed, Proof reads what that turn ran (tool output, exit codes,
test counts, metric changes, file hashes) and judges each claim:

- **shown**: something in the turn shows it. Proof stays quiet.
- **no evidence**: nothing in the turn shows it ("all tests pass" when no
  test ran). A short card after the turn says so.
- **contradicted**: the turn's own output says otherwise ("pushed to main"
  when the push was rejected). The card quotes what the turn shows.

<!-- showcase:hero -->
![A chat in dark mode where the reply says all tests pass. Proof's card below it says the turn's own test run exited 1, with 6 passed and 1 failed.](../../docs/screenshots/proof/flag-dark.png)
<!-- /showcase:hero -->

Every claim, quiet or flagged, goes into the session's **claims ledger**
(claim, evidence, verdict, check), which its page shows and exports as
Markdown, CSV or JSON. When you want a second opinion, the **independent
check** opens a short, fresh, read-only thread on a cheap local model that
re-runs or re-reads the evidence and answers VERIFIED or NOT VERIFIED, with
its reason.

Proof reads the claims inside DSH's own session log as each event is
committed, so it costs no model call, it never sends anything to the
session, and the card is there the moment the turn ends. It needs nothing
else running. With Session Watch running, its page updates through the
suite's one open request per window; without it, the page reads again every
few seconds.

<!-- showcase:screenshots -->
## Screenshots

![A chat in light mode where the reply says all tests pass. Proof's card below it says the turn's own test run exited 1, with 6 passed and 1 failed.](../../docs/screenshots/proof/flag-light.png)

*The same card in light mode.*

![A chat where the reply says v2.3.1 is deployed to staging. Proof's card says no deploy ran in the turn, and an independent check found v2.3.1 not even tagged.](../../docs/screenshots/proof/checked-light.png)

*A claim with no evidence, after an independent read-only check.*

![Proof's page: four sessions with claims, and the ledger of Report decimals with its contradicted claim and buttons to export it.](../../docs/screenshots/proof/ledger-dark.png)

*The ledger: every claim of a session, flagged or shown, with export to Markdown, CSV or JSON.*

Made by `npm run showcase` in a demo home; [docs/site.json](../../docs/site.json) lists them, with their words.
<!-- /showcase:screenshots -->

## What counts as a claim

A claim is a plain statement of success in the turn's last reply, read
sentence by sentence and clause by clause ("Pushed to main — CI should
pick it up" claims the push, not the CI run). A comma splits a sentence
only before a joining word (*and*, *but*, *so*, *then* and the like), so
"Pushed to main, CI should pick it up" is one clause, and its *should*
makes it claim nothing. These claim nothing, so they are never flagged:

- questions, conditions and promises ("once the tests pass I'll merge"),
  and plans: a plan's heading or lead ("Next steps:", "Proposed fix (not
  started): …", "Here is how I would do it:") and every item under it;
- instructions ("Run it on staging first"), definitions ("What green means
  here: …", "A green build means the checks job finished"), and headings
  or descriptions led by a question word ("How it works", "Why an export
  can run twice"; "How I fixed it" still claims the fix);
- failure reports: failures ("3 tests still fail"), negations ("No files
  were changed", "I made no edits", "left `config/` untouched", "zero
  modified, staged, or untracked entries"), a pass by accident ("the
  others pass only by accident"), and a pass count that reports a failure
  ("The suite ran 3 tests and only 1 passed", "1 of 3 tests passed", or
  "1 test passed" when the run printed 1 passed and 2 failed);
- a heading over a list ("Passing tests:", "Failing tests (2):", "What
  passes:"): the items under it say what they say;
- descriptions: how a build is set up, what a pipeline does ("The plan is
  uploaded as the `plan-prod` artifact", "It is deployed on every merge"),
  what code does ("`LRU.Get` released the mutex"), what a commit once did,
  where a thing came from ("The lock file was made with Node 22");
- answers to a message that only asks to look ("Why does the header check
  fail?", "How is the discount documented? Just look, do not change
  anything", "Run the export tests once so I can see where they stand"),
  in a turn that changed nothing: a clause led by code ("`parse_header`
  built its pattern before the loop"), a plan's items ("`aws_s3_bucket.logs`
  — replaced along with the rename"), a list of what each named thing does
  ("- `build` — compiles the TypeScript"), how a thing is ("Retries are
  configured in `config/retry.yml`"; "every migration is applied on
  staging" after `alembic current` or another status read of that place),
  how it behaves ("passes when it runs alone", "passes on retry", "builds
  fine on Node 20 but fails on Node 18", "the rollout completes in about
  four minutes", "changes to `main` are deployed automatically", "each shard
  is merged into the index", "deployed behind the gateway"), history
  ("Already fixed — `b72e0d4` switches the test to a frozen clock", "the fix
  landed in 3.1.0", "is fixed in its next major"), and the
  cause of what a why question takes as given ("It works locally because
  your `.env` sets `API_URL`" after "Why does it work locally but fail on
  CI?"). A status question ("Is it deployed?", "Did the tests pass?"), a
  run or a count of the turn ("I ran the suite: all 212 examples pass"),
  and the turn's own work ("I fixed the import") are still claims, and a
  message that asks for a change or a ship ("Fix it", "then deploy") is
  not a look. In any turn, "the port is fixed at 8080" means set, and
  "locks are released in the `finally` block" is code at work;
- code blocks, `>` quotes, and reports of what something else says ("the
  README says the build passes"). *Claims* is reported speech only with a
  speaker, so "Fixed the double-claim bug" is a claim.

A claim about the tests other than the failing ones ("That's also why the
other tests pass", "the rest are green", "everything else passes") after a
run that failed some and passed others is about the part that passed, so
the failure does not count against it. So is a claim that names a test the
run printed as passing by its whole name ("`sum of one number is that
number` — pass"), or that gives as many as passed ("Both green tests
pass", "11 of 12"). When the reply itself says what fails ("One test still
fails, `rounds totals`, which failed before my change", "the third fails",
"One lint error is left in src/b.js"), and that fits the run (its count,
and the test it names among the run's failing lines), a fix or a pass
beside it is held against the rest of the run: "Fixed the date parsing
test" is shown, unless a failing test's name shares two of its words with
what it fixed ("parses ISO dates" and "the ISO date parsing"); a lint or
build fix is shown when every file the failing run names is another one
than the files the fix names. "Fixed the failing tests", "all tests pass"
and "the suite is green" are still contradicted. A build claim is shown by
the build that ran, whatever a test run after it printed, and a run whose
every test passed and that failed on a coverage threshold shows the tests
(not the coverage). A deploy whose health check then failed is shown when
the reply reports that check's answer ("The health check answers 503 for
now") and does not say it is up. A reply that says itself that it did not
check its fix ("Tests were not run, per your instruction", "I didn't run
the tests") is not flagged for the fix having no run after it; it still is
when the fix's edit failed or a run after it failed. A bare label
("**Fixed** — `add` now sums every argument") claims what the clause after
it says.

A results table with before and after columns is read row by row: a row
whose figure went down ("| p50 | 310 ms | 120 ms |") claims that change,
and the turn must have printed both figures.

| Kind | Examples | Shown by | Contradicted by |
| --- | --- | --- | --- |
| **passed** | "all 42 tests pass", "the build is green", "lint is clean", "CI is green on PR #214", "a final grep for `oldName` finds nothing" | The last run of that kind (tests, a build, lint) passing, after the last change to code; a count in the claim must match the run's. A claim about part of the suite ("the invoice tests pass") is shown by a run limited to that part; one about the whole suite ("the rest of the suite is still green", "all packages pass") is not. A CI claim is shown only by a CI read (`gh pr checks`, `gh run view`, `glab ci status` and the like) after the last push; after a local run alone it says "A local test run passed; no CI result was read in this turn." A search said to find nothing is shown by the turn's last search for that term finding nothing. A claim that a script, command, job or benchmark ran ("Both runs complete with 0 errors") is shown by that run passing. Two suites named in one sentence ("Unit tests pass (40), and the Playwright checkout tests pass too") are two claims. | The last run of that kind failing, exiting non-zero or timing out, unless the run passed other parts and every failure it printed is in a part the claim does not name (another package, another model, other code, only a doc example); a count that does not match; "no warnings" when the run printed some; a search that still finds lines (a count such as `grep -c` or `wc -l` is read as the number it prints); "passes reliably" or "green every time" when one round of a loop of runs failed; a coverage figure ("statement coverage is 95%") when the turn's coverage report shows another one for that measure. |
| **deployed** | "deployed to staging", "pushed to main", "published 1.2.0", "uploaded build 213 to App Store Connect", "upgraded the `payments-api` release", "the health endpoint returns 200" (or "is returning 200") | A push, publish, release or deploy command that went through, to the place the claim names (a claim about production is not shown by deploys that all ran on staging); a Helm upgrade or rollback by its own output; a request to that address that answered as claimed. | A rejected push, a failed publish or Helm upgrade, a rollout that timed out, a health check that answered otherwise afterwards; "all three hosts serve the new config" after the deploy of it failed. |
| **fixed** | "fixed the crash", "no longer panics", "p50 310 ms → 120 ms", "mean latency dropped from 200 ms to 50 ms", "2.6x faster at the median" | A change to the code that went through in the turn (a failed edit, a commit, or an edit of docs alone is none), then a passing run of the right kind after it. A build alone shows only a fix to the build (a compile or type error, an import, a warning). With no change it says "Nothing in this turn changed the code; a passing run alone does not show a fix." A fix of a doc's words ("Fixed the typo in the README") is its doc edit, with nothing to run. A fix of one part ("fixed only the first reported problem") is shown when the same check fails on fewer things after the change than before it; a fix of a build after a failing build, by a passing build. For a figure, the turn printing it: both figures of "from X to Y" (also "from X down to Y") and "X, down from Y" as they are, as with an arrow, unless your message gave the figure (a reply you dictated, figures and all, still needs them printed); only an amount or a factor ("40% lower", "3x faster") may follow from one metric's before and after. | Every edit in the turn failing, with nothing else changed; the last run after the change failing (for a flaky test, any test run after it failing, or any round of a loop of runs); a benchmark that moved the wrong way, that printed another figure for the measure claimed ("avg went to 50 ms" when it printed avg=181.2ms), or whose change is far from the percentage or factor claimed. |
| **done** | "I added the endpoint", "edited `sum.js`", "renamed the files", "migrated the dev database", "Done." after "add the flag" | A change that went through (an edit, a write, a command that changes files; a failed edit is none) for a claim that says it changed something: *edited*, *modified*, *tweaked*, *adjusted*, *amended* and the like are change words. A new endpoint needs a change to a route or a handler; "applied" or "migrated" needs an apply or a migration that ran, on the place it names (production is not shown by a migration that ran on `$DEV_DB` and database "shop_dev"); a finished run ("Backfill complete") needs that run and its exit, and any count it quotes printed. A commit that printed its record ("[main 1a2b3c4] …") went through, whatever a later step such as a rejected push did; `git revert` and `git cherry-pick` are changes. Git options before the subcommand (`git -C app commit`, `git -c k=v push`) do not hide it. | The change, commit, apply or run it names failing; "removed every use of `moment`" when a search for it after the last change still finds it in code (not in docs or lock files). |

What a claim names, the turn must show: a command in inline code
("`go test -race ./...` is clean"), a figure ("41/41 passing, and
coverage is at 92%"), a hash. A turn that ran nothing may lean on the turn
before it, but only when you asked for no new work in between: "all tests
pass" after "thanks, summarize" is shown by the test run one turn back;
"renamed it" after "now rename it" is not. A turn that asked for no change
("run the tests once more and say what you fixed") may take its fix or
change from the turn before, with its own run after it. A turn that ended
without a reply (DSH cut it, or the model stopped before it wrote one)
passes its runs and changes on to the next turn, so "I changed it to add
the two arguments" after a cut turn that made the change is shown.

Proof reads DSH's own tool outputs: a shell command's stdout, `[stderr]`,
and the `[exit code: N]` / `[timed out after …ms]` markers DSH adds, and
other tools by their words ("exit=0", "12 passed"). It knows the summaries
of the common runners (node's test runner, jest, vitest, pytest, go test,
cargo test, mocha, rspec, phpunit, dotnet, gradle, xcodebuild, flutter,
mix, deno, bun, ctest and more), deploy tools (git push, npm publish,
docker push, kubectl, helm, fly, vercel, netlify, gcloud, aws, terraform,
ansible and more), database migrations and checksums.

## How well it reads

**Now** (pass 2, rules at 93edc1a). The fair figures are the guards, whose
cases nobody working on Proof has opened, and each fresh set's first
measure; `node scripts/proof-corpus.mjs` prints every row.

| Set | Quiet turns flagged | Of them, turns that claim nothing | Bad turns caught | Caught for the right claim | True claims called contradicted |
|---|---|---|---|---|---|
| Eighth hold-out (guard, never tuned on) | 3 of 60 (5.0%) | 1 of 20 | 47 of 50 (94.0%) | — | — |
| Eleventh hold-out (guard, never tuned on) | 3 of 60 (5.0%) | 0 of 20 | 45 of 50 (90.0%) | 45 of 50 (90.0%) | 2 |
| Twelfth hold-out: 40 look-only turns by a fresh writer, measured whole once at 2252a96 | 10 of 36 (27.8%) | 9 of 32 | 4 of 4 | 3 of 4 | 1 |
| Twelfth hold-out, guard half (20 turns never opened, never tuned on) | 5 of 18 (27.8%) | 5 of 16 | 2 of 2 | 2 of 2 | 0 |
| The round-4 judge's own turns (`judge4/`), measured once at 7cc66ef | 6 of 44 (13.6%) | 6 of 22 | 22 of 26 (84.6%) | 21 of 26 (80.8%) | 2 |
| Every tuned set (dev, the first seven hold-outs, the ninth, tenth, `live/`, `probes/`, `judge4/`, the twelfth's tuned half) | 0 | 0 | all | all | 0 |

The weak figure is the look-only one. Floors were fixed for the twelfth
before its writer started (at most 5% of quiet turns flagged, at least 80%
of bad turns caught, at most 1 true claim called contradicted): measured
whole, it met the last two and missed the first by far. It was then split
by label into two halves of 20. The rules learned from the tuned half
(`seen12/`, now 0 of 18) are the look-only readings listed under
[What counts as a claim](#what-counts-as-a-claim); on the guard half
(`holdout12/`), whose cases stay unread, they flag 5 of its 16 turns that
claim nothing, at each of the last four commits of rules (60ab17a,
82a9161, 834bba4, 93edc1a). So more than one plain explanation in four,
written the way that writer writes, can still get a card when it says what
code or a service does in words the rules have not met. (Batches of
explanation sentences the builder wrote, each measured once: 9 of 36, 3 of
22, 3 of 25 and 4 of 25 flagged before the rules they led to, and a last
batch kept out of the rules, 3 of 20 at 93edc1a, about one in seven; not a
fair figure, as the builder knows the rules.)

Measured on labelled corpora of coding-agent turns: real tool-output
formats and replies, each turn labelled by the person who wrote it as
honest (every claim shown), no claim, unbacked or contradicted. Each
hold-out was written by four writers who never saw Proof's rules or the
other corpora, and was measured once before any rule saw it. Since the
ninth, each case also lists its reply's success claims, each labelled
shown, unshown or wrong, so a turn is scored per claim as well (below).
Dev grew in round 3 to 310 turns: the round-2 judge's probes and 54
everyday turns of the judge's shapes with their honest twins.

| Corpus | Turns with evidence or no claim | Flagged anyway (false flags) | Turns with an unshown or wrong claim | Flagged (caught) | Wrong claims called contradicted |
|---|---|---|---|---|---|
| Dev (tuned on) | 174 | 0 (0.0%) | 136 | 136 (100.0%) | 56 of 56 |
| First hold-out, measured once before tuning | 60 | 12 (20.0%) | 50 | 43 (86.0%) | — |
| Second hold-out, measured once before tuning | 60 | 6 (10.0%) | 50 | 45 (90.0%) | 20 of 25 |
| Third hold-out, measured once before tuning | 60 | 7 (11.7%) | 50 | 41 (82.0%) | 19 of 25 |
| Fourth hold-out, measured once before tuning | 60 | 10 (16.7%) | 50 | 44 (88.0%) | 23 of 25 |
| Fifth hold-out, measured once before tuning | 60 | 6 (10.0%) | 50 | 41 (82.0%) | 19 of 25 |
| Sixth hold-out, measured once before tuning | 60 | 10 (16.7%) | 50 | 43 (86.0%) | 21 of 25 |
| Seventh hold-out, measured once before tuning | 60 | 8 (13.3%) | 50 | 39 (78.0%) | 17 of 25 |
| Eighth hold-out, measured once, never tuned on | 60 | 5 (8.3%) | 50 | 46 (92.0%) | 21 of 25 |
| Ninth hold-out, measured once before tuning | 60 | 7 (11.7%) | 50 | 41 (82.0%) | 16 of 25 |
| Tenth hold-out, measured once before tuning | 60 | 9 (15.0%) | 50 | 43 (86.0%) | 22 of 25 |
| Eleventh hold-out, measured once, never tuned on | 60 | 5 (8.3%) | 50 | 45 (90.0%) | 20 of 25 |
| Real model turns in DSH Test, with round 3's rules (341ff4e) | 45 | 13 (28.9%) | 3 | 3 (100.0%) | 1 of 1 |
| Real model turns in DSH Test, tuned on since | 45 | 0 (0.0%) | 3 | 3 (100.0%) | 1 of 1 |
| Probes written apart from the code, with round 3's rules (341ff4e) | 80 | 9 (11.3%) | 43 | 37 (86.0%) | 17 of 22 |
| Probes written apart from the code, tuned on since | 80 | 0 (0.0%) | 43 | 43 (100.0%) | 22 of 22 |

Where the false flags fall, first recorded for the fifth hold-out:

| Corpus | Honest turns that claim something | Flagged | Called contradicted | Turns that claim nothing | Flagged |
|---|---|---|---|---|---|
| Fifth hold-out, measured once before tuning | 40 | 6 (15.0%) | 3 | 20 | 0 (0.0%) |
| Sixth hold-out, measured once before tuning | 40 | 8 (20.0%) | 2 | 20 | 2 (10.0%) |
| Seventh hold-out, measured once before tuning | 40 | 4 (10.0%) | 0 | 20 | 4 (20.0%) |
| Eighth hold-out, measured once, never tuned on | 40 | 4 (10.0%) | 1 | 20 | 1 (5.0%) |
| Ninth hold-out, measured once before tuning | 40 | 4 (10.0%) | 1 | 20 | 3 (15.0%) |
| Tenth hold-out, measured once before tuning | 40 | 4 (10.0%) | 1 | 20 | 5 (25.0%) |
| Eleventh hold-out, measured once, never tuned on | 40 | 3 (7.5%) | 1 | 20 | 2 (10.0%) |
| Real model turns in DSH Test, with round 3's rules (341ff4e) | 35 | 10 (28.6%) | 5 | 10 | 3 (30.0%) |
| Probes written apart from the code, with round 3's rules (341ff4e) | 54 | 7 (13.0%) | 5 | 26 | 2 (7.7%) |

Per claim, first recorded for the ninth hold-out: a bad turn is *caught
for the right claim* when a flag falls on one of its unshown or wrong
claims, and has *a flag on another claim* when its flags fall on none of
them; a *true claim called contradicted* is a shown or unlisted claim
flagged as contradicted, in any turn. A flag falls on a listed claim when,
lower-cased and without Markdown marks, quotes and brackets, the flagged
clause contains the listed text, the listed text contains it, or at least
60% of the listed text's words of two letters or more are in it.

| Corpus | Turns with an unshown or wrong claim | Caught for the right claim | A flag on another claim | True claims called contradicted |
|---|---|---|---|---|
| Dev (tuned on) | 136 | 136 (100.0%) | 0 (0.0%) | 0 |
| Sixth hold-out, tuned on since | 50 | 50 (100.0%) | 0 (0.0%) | 0 |
| Seventh hold-out, tuned on since | 50 | 50 (100.0%) | 0 (0.0%) | 0 |
| Ninth hold-out, measured once before tuning | 50 | 40 (80.0%) | 6 (12.0%) | 9 |
| Ninth hold-out, tuned on since | 50 | 50 (100.0%) | 1 (2.0%) | 0 |
| Tenth hold-out, measured once before tuning | 50 | 43 (86.0%) | 7 (14.0%) | 8 |
| Tenth hold-out, tuned on since | 50 | 50 (100.0%) | 0 (0.0%) | 0 |
| Eleventh hold-out, measured once, never tuned on | 50 | 45 (90.0%) | 1 (2.0%) | 2 |
| Real model turns in DSH Test, with round 3's rules (341ff4e) | 3 | 3 (100.0%) | 0 (0.0%) | 8 |
| Real model turns in DSH Test, tuned on since | 3 | 3 (100.0%) | 0 (0.0%) | 0 |
| Probes written apart from the code, with round 3's rules (341ff4e) | 43 | 36 (83.7%) | 1 (2.3%) | 6 |
| Probes written apart from the code, tuned on since | 43 | 43 (100.0%) | 0 (0.0%) | 0 |

The sixth and seventh got their claim lists (for their bad turns) after
they were tuned on, so they have no first per-claim figure. The first five
hold-outs and the eighth have no per-claim labels at all: the eighth stays
in `npm test` with its four per-turn floors.

The first seven hold-outs were tuned on after that one measurement (the
fixes were general rules, never a case's own words) and are now part of
the tests, at 0% false flags and 100% caught, so none of them is a fair
figure any more. The fourth one's writers were asked for set kinds of
turns (claims shown earlier in the turn, summaries that lean on the turn
before, hashes, metrics and CI reads, subtle misses) and added hard ones
of their own (results only on stderr, a failed run fixed later in the
turn, success-looking output the reply never claims). The fifth met the
floors Proof promised then (at most 10% of quiet turns flagged, at least
80% of unshown or wrong claims caught), the first just, but every one of
its false flags fell on an honest turn that claims something: 6 of 40,
and 3 of them were called contradicted, which accuses an honest agent of
being wrong. An independent judge met the same shapes in live use (a fix
claim that names the fault, a question read as a request for new work, a
count of runs read as a test count). So the floors are now stricter and
split: at most 10% of quiet turns flagged, at most 10% of honest turns
that claim something flagged, at most one honest turn called
contradicted, and at least 80% caught. The sixth hold-out, written by
fresh writers who never saw the rules or the corpora, was measured once
against them with the rules frozen: it caught 86.0%, but it flagged 16.7%
of quiet turns and 20.0% of honest turns that claim something, and called
2 honest turns contradicted, so it missed three of the four floors. As
was settled before it was measured, it was then tuned on like the others
(plan labels, nouns and present-tense descriptions read as work, worked
examples read as figures, counts borrowed from another clause, a doc edit
after the last test run; and on the missed side, runs sent to the
background, "the rest of the suite" after a run limited to new tests,
factors far from the turn's own benchmark, bars given as a bare figure,
results tables and uploads to an app store). The seventh hold-out, from
four more fresh writers, was measured once against the same floors with
the rules frozen (at e4d59f6): it flagged 10.0% of honest turns that claim
something and called none of them contradicted, so it met those two
floors, but it flagged 4 of its 20 turns that claim nothing (13.3% of
quiet turns in all) and caught 78.0%, so it missed the other two. It was
then tuned on in turn (what an approval or a review says, how a build is
set up, "whether" a run passed, a figure named as a budget, a "Live
check" heading, a request that "goes through" a pipeline; and on the
missed side, crashes behind a pipe, failures a loop prints, dry runs,
test files counted as tests, "all 4 pass" with no test run, a named
command's flags, the command a done claim names, a benchmark table with
the runs as columns, a figure the turn's own benchmark contradicts, a
file whose edit failed, cloud status reads that show a failed rollout,
and a symptom said to be removed). The eighth hold-out, from four more
fresh writers, was measured once against the same floors with the rules
frozen (at dd03b86): it flagged 8.3% of quiet turns (4 of its 40 honest
turns that claim something, 10.0%, one of them called contradicted, and 1
of its 20 turns that claim nothing) and caught 92.0%, so it met all four
floors. It is not tuned on: it stays in `npm test`
(`test/fixtures/proof/holdout/`), which holds Proof to the four floors on
it. Its round-2 judge read its cases, so it is a guard now, not a fair
figure.

Round 3 scores per claim as well, against seven floors fixed before the
ninth hold-out was written: the four above, and at least 85% of bad turns
caught for the right claim, at most 10% of bad turns with a flag on
another claim, and at most 1 true claim called contradicted in the whole
hold-out. The ninth hold-out, from four fresh writers asked for the
round-2 judge's shapes among everyday work, was measured once with the
rules frozen (at 6945092). It met three floors (10.0% of honest turns that
claim something flagged, 1 honest turn called contradicted, 82.0% caught)
and missed four: it flagged 11.7% of quiet turns, caught 80.0% for the
right claim, put a flag on another claim in 12.0% of bad turns, and called
9 true claims contradicted. As was settled before it was measured, it was
then tuned on (`test/fixtures/proof/seen9/`: a count of none in a CI read,
a status the claim names, a commit id on a push, package names in a
workspace run, per-test lines and filters of more runners; on the missed
side, changelog section names, browser-test runners a claim names,
figures read to their last digit, factors and allocations held to the
benchmark's own words, flaky tests, skipped tests in a count). The tenth
hold-out, written at the same time and never seen, was measured once (at
1cea064). It met four floors (10.0% of honest turns that claim something
flagged, 1 honest turn called contradicted, 86.0% caught, 86.0% caught for
the right claim) and missed three: it flagged 15.0% of quiet turns, put a
flag on another claim in 14.0% of bad turns, and called 8 true claims
contradicted. It was tuned on in turn (`seen10/`). Most of its misses were
one shape: a failing part of a run made claims about other parts
contradicted, so a failure now contradicts a claim only when the output is
about what the claim names (a part's own count, code a failure does not
name, a lint fix judged by the lint run, a doc example that failed); and
on the missed side, hedged from/to figures, ns/op, Helm release upgrades,
roll-outs to hosts, production claimed after staging deploys, a build
alone after a fix, and repeated runs.

The eleventh hold-out, from four more fresh writers, was measured once
with the rules frozen (at c276436) and is never tuned on: its figure is the
fair one for everyday work. **It missed one of the seven
floors**: it called 2 true claims contradicted, where the floor is at most
1. It met the other six: it flagged 8.3% of quiet turns (3 of its 40
honest turns that claim something, 7.5%, and 2 of its 20 turns that claim
nothing), called 1 honest turn contradicted, caught 90.0% of bad turns,
each of them for the right claim (90.0%), and put a flag on another claim
in 1 of 50 (2.0%); it called 20 of its 25 wrong claims contradicted. It
stays as measured (`test/fixtures/proof/holdout11/`): `npm test` checks
its shape and runs its seven floors as a known miss, which prints the miss
and does not fail the run.

Round 4 looked at the real model. In 44 sessions of GLM-5.3 Flash in a DSH
Test instance (48 finished turns: fixes, commits and pushes, lint, builds,
benchmarks, coverage, repeated runs, read-only checks, and three replies
the person dictated; two of the sessions were cut by a busy gateway before
a turn ended), round 3's rules flagged 13 of the 45 quiet turns, 10 of them
honest turns that claim something and 5 of those called contradicted. The
last 12 turns came in after the first fixes and were measured once with
the rules of that time (66fbac0): they flagged one, an accurate failure
report whose three true claims ("`sum of an empty list is 0` — pass")
were called contradicted. Late in round 4 a fresh writer who never saw the
rules wrote 18 more turns outside the repo (12 honest, 9 of them failure
or partial reports; 4 that claim nothing; 2 bad), measured once: no quiet
turn flagged; the contradicted one caught for its claim (a "Fixed" in the
same reply, whose function's test that run broke, was called contradicted
too, as the rule says); and the unbacked one ("`go test ./...` — all
packages pass" after a run of one package) missed, so "all packages" now
speaks of the whole suite. The model writes
Markdown: headings over lists ("**Passing tests:**"), ✅ and ❌, bold labels
("**Fixed** —"), "No files were changed.", `git -C app commit`, an echoed
`[exit 1]`, and accurate failure reports that say why the other tests
pass. Those turns are now a tuned set (`test/fixtures/proof/live/`, paths
and names made neutral, labelled by the builder), and so are 123 probes
written apart from the code (`test/fixtures/proof/probes/`: 30 by a fresh
writer who never saw it, 93 by the round-3 judge; two that repeat a reply
of another corpus are left out). Both are held to the dev bar in `npm
test`. The fixes are general rules, listed under
[What counts as a claim](#what-counts-as-a-claim).

Pass 2 took the round-4 judge's turns (its everyday set, its probes, its
description probes and three look-only real-model replies: 70 turns in
`judge4/`) as a tuned set, after the one measure above, and the twelfth
hold-out as described at the top of this section. The two older guards
were not tuned on in round 4 or pass 2 and their cases are still unread.
Measured again with pass 2's rules, the eighth flags 3 of its 60 quiet
turns (5.0%), catches 47 of 50 (94.0%) and calls 22 of its 25 wrong claims
contradicted; the eleventh flags 3 of 60 (5.0%: 3 of its 40 honest turns
that claim something, one of them called contradicted, and none of the 20
that claim nothing; round 4's rules flagged one of those), catches 45 of
50 (90.0%), each for the right claim, puts a flag on another claim in 1,
and still calls 2 true claims contradicted, so it still misses that floor.
To measure again:

```sh
node scripts/proof-corpus.mjs           # one row per corpus
node scripts/proof-corpus.mjs --misses  # and each case it got wrong
```

### What it still misses

On the tuned sets, two turns:

- A fix made to another copy of the code is flagged as *no evidence*
  (nothing ran after the change), not as *contradicted*: "Fixed the signup
  crash" after an edit of `src/utils/user.ts`, when the crash is in
  `src/models/user.ts`, which a read shows unchanged. Proof does not hold
  a read of the code against the claim.
- A fix is judged against the turn's last change to the code, not against
  the change that was the fix: "Fixed the off-by-one in
  `RateLimiter.allow`", with a passing run after it, is flagged when a
  second change with no run after it follows. Proof keeps which file a
  change touched, not its text, so it cannot tell which change a fix was.

On the guards, whose cases nobody working on Proof has read, with pass 2's
rules: on the twelfth's guard half, 5 of its 16 look-only turns that claim
nothing get a card; on the eleventh, 5 of its 50 bad turns are not caught,
1 has a flag on another claim, 2 true claims are called contradicted (at
least one in an honest turn), 3 of its 60 quiet turns are flagged, and 4
of its 25 wrong claims are not called contradicted. Which shapes these are
is not known; reading their cases would end them as fair figures.

Some ways of putting a claim are not read as claims at all, so nothing
checks them: a comma before a clause with no joining word ("Pushed to
main, CI should pick it up" claims nothing) and some figures in words
("Peak memory dropped 40%", "Coverage is up to 92%"). See also
[Limits](#limits).

## On the turn

A turn with a flagged claim gets a card after its reply: **Proof ·
Nothing in this turn shows this**, **Proof · This turn's own output says
otherwise**, or, for several, **Proof · 3 claims this turn does not show
(1 contradicted)**. Once the independent check has answered, its answer
heads the card instead: **Proof · Verified by an independent check** (a
green shield) or **Proof · Not verified by an independent check**. For
each flagged claim it shows:

- the claim's own clause, quoted (its whole sentence shows on hover), and
  why it was flagged ("No test ran in this turn.", "The last push in this
  turn did not go through: … rejected …"), with commands drawn as code (a
  program run by its full path is named by its own name wherever it starts
  a command, after `&&`, `|` or a loop's `do` too, so
  `/opt/tools/node-v22/bin/node --test a.test.mjs` shows as
  `node --test a.test.mjs`); for a claim the check verified, the check's
  reason instead;
- for a contradiction, **What the turn shows**: the line of output that
  says otherwise, when the why does not quote it already;
- the independent check's line when there is one: its state (*waiting to
  check*, *checking*, *unclear*, *could not check*, *stopped*; *verified*
  and *not verified* are said by the head), its reason, and **Open the
  check**. While a check runs, its line says what it waits on: the
  model's answers, and on a busy shared gateway a request can wait and be
  sent again;
- **Check it** (or **Check again**) when the independent check is on.
  The focus then moves to the check's line, which stays in place while
  the check waits, runs and answers;
- **Open in Proof**, which opens the page at that session.

A turn whose claims are all shown gets no card. In a check thread, while
its check waits or runs, a bar above the message box (where DSH shows a
goal) says what it checks (the whole claim, wrapped over as many lines as
it needs), from which turn of which session, that nothing it runs can
write a file, and offers **Open the checked session**. Once
the check ends, the thread's first turn gets a note with the same words and
how it ended (and no **Open the check**: you are in it).

## The page

Proof has its own entry in the sidebar. Its page shows:

- **The header**: how many sessions have claims, how many claims are
  flagged and how many an independent check verified, whether flags are
  on, and **Settings**.
- **Sessions with claims**, the one flagged last first, each timed by its
  latest flag (a session with no flag, by when it last changed) and with
  its one state (*contradicted*, *no evidence*, *verified* or *shown*).
  Pick one to see its ledger. Opening the page from a flag picks that
  session. The list is one Tab stop: the up and down arrows (and Home and
  End) move between its sessions, and Enter or Space picks one.
- **Ledger**: the session's claims, newest turn first and a reply's claims
  in the order it made them, **Flagged** or **All claims**, and their
  counts. A flagged claim the independent check verified is counted
  apart (*1 verified by an independent check*), here, on its session's
  row, in the header and in the exports, and leaves **Flagged**; one you
  check from **Flagged** stays there with its answer until you choose the
  view again. Each claim shows its turn and time, its own clause (its
  whole sentence on hover), why, what showed it or what says otherwise,
  **What the turn ran** (the commands and reads, folded), the check, and
  **Check** when the check is on; after **Check** the focus moves to the
  check's line. **Export**: Markdown, CSV or JSON downloads the whole
  ledger (quiet claims too), named for the session and your local day
  (`proof-ledger-queue-race-2026-10-17.md`, even at 11 PM); **Copy** puts
  the Markdown on the clipboard, and What happened logs it as a copy. CSV
  fields that a spreadsheet would read as a formula get a leading
  apostrophe.
- **Independent checks**: how checks run (the model as DSH's model menu
  names it, and the minutes a check may take), then the latest checks over
  all sessions, newest first by the time each row shows, each with the
  claim, its turn and session, whether you asked or it ran by itself, its
  state and reason, and **Open the check**. While the check is off, the
  card says so and offers **Open Proof's settings**, whether or not checks
  were made before.
- **What happened**: checks asked for and their answers, exports, copies
  and setting changes (each with what it was: *“Minutes a check may take”
  45 → 60*), newest first.

Every empty state says what to do next, and every refusal says why in
words ("The independent check is off. Turn it on in Proof's settings").

## The independent check

When the check is on, a flagged claim can be checked (**Check it** on the
card, **Check** in the ledger), or, with *By itself*, each new flagged
claim is checked as it is flagged (claims flagged before you chose *By
itself* are left for you). A check:

1. Opens an ordinary DSH session beside the checked one (in its workspace,
   or its folder), titled **Proof check · …**, so you can open it and read
   what it ran.
2. Makes it read-only before its first turn, with DSH's own controls:
   - the read-only file policy: nothing it runs can write a file, not even
     in `/tmp`;
   - approvals that never ask: an action that would need one is refused,
     so a check never waits on you;
   - its model is offered only tools that read or run (`read`, `grep`,
     `glob`, `bash`, `web_fetch` and the like), plus DSH's own `subagent`
     tool, which DSH adds to every thread and no plugin can take away;
   - a guard that refuses any other tool, `subagent` included, and any
     command that sends
     something elsewhere (a push, a publish, a deploy, a request that does
     more than read, a command on another machine) or changes the work (a
     commit, a reset, an install, a killed process, a container). The
     thread is told why, so it can check by reading instead.
3. Picks the model Proof's settings name for that thread only (by default
   GLM-5.3 Flash through the local gateway), at low effort when the model
   offers it (else minimal, else the model's own default), through DSH's
   own model choice: a check re-runs a command or reads a file, and a busy
   gateway answers a low-effort request sooner. DSH's default model is
   never changed.
4. Asks it to re-run or re-read what would show the claim (the same
   command, the file, git, the hash, the address) and to end with a line
   that starts with VERIFIED or NOT VERIFIED and the reason.

The last such line is the verdict. A reply with neither is *unclear*; a
turn that ended in an error, or a check still running after its minutes
(it is stopped), is *could not check* or *unclear*, with the reason in
words. A check keeps the minutes it was given when it started: change the
setting while it runs and it still stops at its own ("It took longer than
the 45 minutes it was given, so Proof stopped it."). The default is 45
minutes because on a busy shared gateway a request can wait and be sent
again: in round 2's live check two checks given 30 minutes ran out on cut
requests, and one given 60 answered after 30 min 11 s. One check runs at a
time, and at most `verifierPerHour` start in an hour; the rest wait their
turn ("Waits until 3:40 PM: 12 checks have started in the last hour, the
most Proof's settings allow"). Turning the check off ends the ones still
waiting as *stopped* ("The independent check was switched off before it
started."), not as an error; a check already running carries on.

When DSH restarts while a check runs, DSH ends the thread's cut-off turn,
and Proof reads the thread as soon as it starts again: an answer the
thread gave before the restart counts, and a check it cut off settles at
once as *unclear*: "DSH restarted while it ran, so it ended before it
answered." **Check again** asks for a new one.

## Settings

Plugins → Proof shows the settings you can change while it runs, in DSH's
own settings form: change a value, then **Save**. They apply at once, and
What happened notes each save and what it changed (*Settings changed:
“Minutes a check may take”*, then *“Minutes a check may take” 45 → 60.
They apply now.*). **Use the default** clears one. The form will not save
a value out of range and says what fits instead.

| Setting | Default | Range | Where | What it does |
| --- | --- | --- | --- | --- |
| `flags` (Flag claims with no evidence on their turn) | `true` | on or off | Plugins | The card after a turn with a flagged claim. The ledger keeps every claim either way. |
| `verifier` (Independent check) | `ask` | `off`, `ask` (When I press Check) or `auto` (By itself) | Plugins | When a check runs. |
| `verifierProvider` (Check with the model from) | `local-gateway` | a provider's id in DSH's profile | Plugins | Where the check model runs. The page names it as DSH's model menu does. |
| `verifierModel` (Check with the model) | `glm-5.3-flash` | a model's id in DSH's profile | Plugins | The check model: a cheap local one, asked for low effort when it offers that. |
| `verifierMinutes` (Minutes a check may take) | `45` | 1 to 60 | Plugins | A check still running then is stopped, and its answer is unclear. A quiet local model answers in a minute or two; a busy shared gateway can take half an hour to answer one check: allow 60 then. |
| `verifierPerHour` (Checks an hour, at most) | `12` | 1 to 120 | Plugins | More wait their turn and start when the hour allows. |
| `enabled` | `true` | `true` or `false` | Profile | `false` keeps Proof loaded but idle: it reads no claims, and its page says so and how to change it. |

A wrong value never stops Proof from starting: it flags and checks
nothing, and its page says which setting is wrong, what it must be, and
**Open Proof's settings** puts the cursor in it. Once you fix it, Proof
works again at once. When the wrong value is one of the settings in
Plugins, a number or on/off in quotes that would be right without them
(`verifierMinutes: "45"` in the profile), the page also says "Without the quotes it is right: Proof can
save it as 45 for you, as the settings form would." and offers **Save it
as 45**, which saves it through DSH's own settings call and then says
"Saved “Minutes a check may take” as 45, without quotes. Proof works
again." If DSH does not save it, the page says so and points to Proof's
settings in Plugins.

## Files

In DSH's data folder (`$DSH_HOME`, else `~/.dsh`), folder mode 700, files
mode 600:

| File | What |
| --- | --- |
| `proof/checks.json` | The independent checks: which claim, which thread, state, verdict and reason (the last 400). |
| `proof/events.jsonl` | What happened: checks, exports, setting changes. It keeps the last 400 entries and rewrites itself past 1 MB. |

The claims themselves live in each session's own state in DSH (the
`proofClaims` projection, the last 60 claims a session made, the last 20
flagged on its list row), and the page folds a whole ledger from the
session's log when you open it. A session saved while Proof was off has no
claims on DSH's list until Proof reads them: a few seconds after it starts,
and as the list shows such sessions, Proof reads their logs (newest first,
one at a time, at most 200 each time it starts), so they are listed again
and nothing is lost while Proof is off.

## Setup

1. Install Proof as in the [root README](../../README.md#install-a-plugin):

   ```bash
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/proof
   ```

   That adds `dsh-plugin-proof` to the profile's `package.json`
   (`dependencies` and `dsh.profile.bundles`). Its bundle adds its row
   (`id: proof`).

2. To change a default before the first start, address the row in the
   profile's `cordis.patch.yml`:

   ```yaml
   - id: proof
     config:
       verifier: auto
       verifierPerHour: 6
   ```

3. Restart DSH Desktop once so it loads the new bundle.

The check model must be one DSH's model list offers. If it is not, a check
ends as *could not check*: "DSH has no model … to check with. Pick one DSH
lists in Proof's settings (“Check with the model”)".

## Switching it off

- **The cards only**: Plugins → Proof → *Flag claims with no evidence on
  their turn* off. The ledger and the page carry on.
- **The independent check**: *Independent check* → Off. Checks still
  waiting end as *stopped*, and one already running carries on to its
  answer; nothing else changes.
- **Entirely**: Plugins → Proof → off. Its sidebar entry, page and cards
  go, and it leaves no marks in other plugins' views. Nothing in your
  sessions changes. (`enabled: false` in the profile instead keeps its
  page, which says it is off and how to turn it back on.)

## Rollback

DSH runs Proof from its folder in your clone (the profile links it). No
release of Proof is tagged yet: to go back to an earlier version, find its
commit (`git -C ~/.dsh-plugins/dsh-public-plugins log --oneline --
plugins/proof`), restore that folder from it and restart DSH Desktop:

```bash
git -C ~/.dsh-plugins/dsh-public-plugins restore --source <commit> -- plugins/proof
```

To remove it, follow [Remove a plugin](../../README.md#remove-a-plugin) for
`dsh-plugin-proof` (row `proof`), and delete `proof/` in DSH's data folder
to forget its checks and log. Check threads it opened stay as ordinary
sessions; delete them in DSH if you like. It changes nothing else: it never
writes into a session it judges.

## Limits

- Proof reads one turn (and, for a turn that asked for no new work, the
  one before). A claim about work done earlier in the session, outside that
  window, is flagged as *no evidence*: the ledger shows where it was, and
  the independent check can confirm it.
- It reads what the tools printed, not the world: "deployed" is shown by a
  deploy that went through, not by the site being up a minute later. A
  health check in the turn covers that.
- Long outputs are kept by their head (4,000 characters) and tail (12,000),
  where runners print their summaries. Before they are read, runs that say
  nothing are made short (more than two blank lines, one character over
  and over past 64, numbers past 64 digits), so reading a tool's output
  takes milliseconds whatever it printed.
- Check threads stay in DSH's session list as ordinary sessions, titled
  **Proof check · …**. DSH can archive a session, but an archived thread
  cannot be opened in the window any more, and DSH offers plugins no way to
  group sessions, so Proof leaves them where they are; delete the ones you
  no longer need.
- The check model is named by its ids in DSH's profile: DSH's settings form
  offers plugins no list to pick from. Proof's page names it as DSH's model
  menu does.
- Sessions saved while Proof was off are read from their logs at most 200
  each time it starts; any more are listed once they are opened or used.

## Tests

From the repository root:

```sh
node --test test/proof*.test.js       # claims, evidence, the ledger, the check, the page, the browser half, the corpora
node scripts/e2e.mjs proof            # real DSH in a throwaway home, on every DSH build here
```

The real-DSH test (143 checks, three to six minutes a build)
starts DSH from each `.e2e/dsh-<version>` install and from the installed
app's own DSH, each in a throwaway home, with Session Watch and Proof and
a scripted model (`test/e2e/fake-model.mjs`) that plays both the agent and
the check model (which offers a low and a high effort).
From real sessions it shows that a claim its turn's run shows stays quiet
(in a summary turn, the turn before shows it), that a claim with nothing
behind it is flagged, that one the run's own output denies is called
contradicted with the run's words (said once, commands drawn as code), and
that a reply that only asks makes no claim. It asks for checks from the
flag, the page and the endpoint: the focus moves to the check's line; each
runs in a new "Proof check · …" thread on the check model alone, at low
effort, and DSH's own log shows the read-only file policy and approvals
that never ask before its first message; its model is offered only tools
that read or run (and DSH's `subagent`), Proof's guard refuses the
subagent and a commit, DSH's file policy stops a write (the check's
`touch` is tried and refused, so no file is made), the checked
session gets nothing and DSH's default model is unchanged. A NOT VERIFIED
and a VERIFIED head their cards, and the verified claim is counted apart on
the ledger, its session's row, the header and the exports. While a slow
check runs, its thread says what it checks above the message box; the
limit is raised meanwhile, and the check is still stopped at the minute it
was given, and says so. A new flagged claim is checked by itself, a fifth
check in the hour waits and says until when, and switching checks off ends
it. It restarts DSH in the middle of a check (it settles at once: "DSH
restarted while it ran …"), runs with Session Watch off, starts with a
wrong setting (named with its range, and fixed by saving a good value)
and with a number in quotes in the profile (named with the value, saved
without the quotes in one press on the page, and still right after a
restart), checks Proof's file modes, loads it with `enabled: false`, and
then shows that a session made and one used meanwhile are listed again
once it is back on. Last, it reads replies of the kinds the round-3
corpora hold: an accurate "only 1 passed" claims nothing, while "All 3
tests pass." after the same run is contradicted with the run's count; a
fix after only a passing run and a CI claim after a local run are flagged
with their reasons, each named on the card by its own clause; figures no
output printed are flagged, naming them. Then it reads the real model's
own shapes: a failure report under "**Passing tests:**" and "**Failing
tests:**" headings with ✅ and ❌ and "No files were changed." stays quiet,
and so do a bold "**Fixed** —" label, a list of passing tests and a typo
fixed in the README after the fix and a passing run; "Fixed the flaky
coupon test; it passes reliably now." after a loop of three runs in which
the second failed is called contradicted, saying a round failed and
naming the program the loop ran by its own name, and it is the only card
in that chat; a look-only answer ("How is the discount documented? Just
look, do not change anything.") claims nothing; and a change claim with
" - " in its code ("Changed `x - 1` to `x + 1` in calc.mjs.", with no edit)
is flagged and quoted as written in the ledger and on its card, never as
"undefined". Proof's page, open all the while, lists that
new session by itself once its claims come. The sessions list puts the one
flagged last first, timed by that flag, and the ledger lists the newest
turn first and a reply's claims in order. It drives the page and Proof's
settings in Plugins in a browser, light and dark, wide and narrow: the
header, the sessions, the ledger and its filter, What the turn ran, the
checks in time order with their times in one column, the exports to
Markdown, CSV, JSON and the clipboard (a copy logged as a copy), and Proof
switched off and on in Plugins, its entry and flags gone and back; an
export is named for the local day, the check bar wraps a long claim at
1000 px, and a check switched off before it starts ends as *stopped*, not
in the error colour. Pictures go to `.e2e/shots/proof/<build>/`.
