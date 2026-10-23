# Proof

Claims need evidence. When a turn's reply says something is done, passing,
fixed or deployed, Proof reads what that turn ran (tool output, exit codes,
test counts, metric changes, file hashes) and judges each claim:

- **shown**: something in the turn shows it. Proof stays quiet.
- **no evidence**: nothing in the turn shows it ("all tests pass" when no
  test ran). A short card after the turn says so.
- **contradicted**: the turn's own output says otherwise ("pushed to main"
  when the push was rejected). The card quotes what the turn shows.

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

## What counts as a claim

A claim is a plain statement of success in the turn's last reply, read
sentence by sentence and clause by clause ("Pushed to main, CI should pick
it up" claims the push, not the CI run). Questions, plans, conditions
("once the tests pass I'll merge"), work labelled as not started
("Proposed fix (not started): …", "Next steps: …"), failures ("3 tests
still fail"), negations, code blocks, `>` quotes and reports of what a
document says ("the README says the build passes") are not claims, so they
are never flagged. A results table with before and after columns is read
row by row: a row whose figure went down ("| p50 | 310 ms | 120 ms |")
claims that change, and the turn must have printed both figures.

| Kind | Examples | Shown by | Contradicted by |
| --- | --- | --- | --- |
| **passed** | "all 42 tests pass", "the build is green", "lint is clean", "CI is green" | A run of that kind (tests, a build, lint, a CI read) whose last run passed, after the last change to code. A count in the claim must match the run's. | The last run of that kind failing, exiting non-zero or timing out; a count that does not match. |
| **deployed** | "deployed to staging", "pushed to main", "published 1.2.0", "uploaded build 213 to App Store Connect", "the health endpoint returns 200" | A push, publish, release or deploy command that went through, to the place the claim names, or a request to that address that answered as claimed. | A rejected push, a failed publish, a rollout that timed out, a health check that answered otherwise afterwards. |
| **fixed** | "fixed the crash", "no longer panics", "p50 310 ms → 120 ms", "2.6x faster at the median" | A change, then a run of the right kind that passed; for a figure, the turn printing it (for an amount such as "40% less", the two figures it follows from). | The run after the fix still failing; a benchmark that moved the wrong way, or whose change is far from the percentage or factor claimed. |
| **done** | "I added the endpoint", "renamed the files", "Done." after "add the flag" | A change to files (an edit, a write, a command that changes files) for a claim that says it changed something; for a finished run ("Backfill complete"), that run and its exit. | — |

What a claim names, the turn must show: a command in inline code
("`go test -race ./...` is clean"), a figure ("coverage is at 92%"), a
hash. A turn that ran nothing may lean on the turn before it, but only
when you asked for no new work in between: "all tests pass" after "thanks,
summarize" is shown by the test run one turn back; "renamed it" after
"now rename it" is not.

Proof reads DSH's own tool outputs: a shell command's stdout, `[stderr]`,
and the `[exit code: N]` / `[timed out after …ms]` markers DSH adds, and
other tools by their words ("exit=0", "12 passed"). It knows the summaries
of the common runners (node's test runner, jest, vitest, pytest, go test,
cargo test, mocha, rspec, phpunit, dotnet, gradle, xcodebuild, flutter,
mix, deno, bun, ctest and more), deploy tools (git push, npm publish,
docker push, kubectl, helm, fly, vercel, netlify, gcloud, aws, terraform,
ansible and more), database migrations and checksums.

## How well it reads

Measured on labelled corpora of coding-agent turns: real tool-output
formats and replies, each turn labelled by the person who wrote it as
honest (every claim shown), no claim, unbacked or contradicted. Each
hold-out was written by four writers who never saw Proof's rules or the
other corpora, and was measured once before any rule saw it.

| Corpus | Turns with evidence or no claim | Flagged anyway (false flags) | Turns with an unshown or wrong claim | Flagged (caught) | Wrong claims called contradicted |
|---|---|---|---|---|---|
| Dev (tuned on) | 95 | 0 (0.0%) | 74 | 74 (100.0%) | 32 of 32 |
| First hold-out, measured once before tuning | 60 | 12 (20.0%) | 50 | 43 (86.0%) | — |
| Second hold-out, measured once before tuning | 60 | 6 (10.0%) | 50 | 45 (90.0%) | 20 of 25 |
| Third hold-out, measured once before tuning | 60 | 7 (11.7%) | 50 | 41 (82.0%) | 19 of 25 |
| Fourth hold-out, measured once before tuning | 60 | 10 (16.7%) | 50 | 44 (88.0%) | 23 of 25 |
| Fifth hold-out, measured once before tuning | 60 | 6 (10.0%) | 50 | 41 (82.0%) | 19 of 25 |
| Sixth hold-out, measured once before tuning | 60 | 10 (16.7%) | 50 | 43 (86.0%) | 21 of 25 |
| Seventh hold-out, measured once before tuning | 60 | 8 (13.3%) | 50 | 39 (78.0%) | 17 of 25 |
| Eighth hold-out, measured once, never tuned on | 60 | 5 (8.3%) | 50 | 46 (92.0%) | 21 of 25 |

Where the false flags fall, first recorded for the fifth hold-out:

| Corpus | Honest turns that claim something | Flagged | Called contradicted | Turns that claim nothing | Flagged |
|---|---|---|---|---|---|
| Fifth hold-out, measured once before tuning | 40 | 6 (15.0%) | 3 | 20 | 0 (0.0%) |
| Sixth hold-out, measured once before tuning | 40 | 8 (20.0%) | 2 | 20 | 2 (10.0%) |
| Seventh hold-out, measured once before tuning | 40 | 4 (10.0%) | 0 | 20 | 4 (20.0%) |
| Eighth hold-out, measured once, never tuned on | 40 | 4 (10.0%) | 1 | 20 | 1 (5.0%) |

The first seven hold-outs were tuned on after that one measurement (the
fixes were general rules, never a case's own words) and are now part of
the tests, at 0% false flags and 100% caught, so none of them is a fair
figure any more; the eighth is. The fourth one's writers were asked for set kinds of
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
floors. It is not tuned on: it stays the hold-out
(`test/fixtures/proof/holdout/`), and `npm test` holds Proof to the floors
on it. To measure again:

```sh
node scripts/proof-corpus.mjs           # one row per corpus
node scripts/proof-corpus.mjs --misses  # and each case it got wrong
```

## On the turn

A turn with a flagged claim gets a card after its reply: **Proof ·
Nothing in this turn shows this**, **Proof · This turn's own output says
otherwise**, or, for several, **Proof · 3 claims this turn does not show
(1 contradicted)**. Once the independent check has answered, its answer
heads the card instead: **Proof · Verified by an independent check** (a
green shield) or **Proof · Not verified by an independent check**. For
each flagged claim it shows:

- the claim, quoted, and why it was flagged ("No test ran in this turn.",
  "The last push in this turn did not go through: … rejected …"), with
  commands drawn as code; for a claim the check verified, the check's
  reason instead;
- for a contradiction, **What the turn shows**: the line of output that
  says otherwise, when the why does not quote it already;
- the independent check's line when there is one: its state (*waiting to
  check*, *checking*, *unclear*, *could not check*; *verified* and *not
  verified* are said by the head), its reason, and **Open the check**;
- **Check it** (or **Check again**) when the independent check is on.
  The focus then moves to the check's line, which stays in place while
  the check waits, runs and answers;
- **Open in Proof**, which opens the page at that session.

A turn whose claims are all shown gets no card. In a check thread, while
its check waits or runs, a bar above the message box (where DSH shows a
goal) says what it checks, from which turn of which session, that nothing
it runs can write a file, and offers **Open the checked session**. Once
the check ends, the thread's first turn gets a note with the same words and
how it ended (and no **Open the check**: you are in it).

## The page

Proof has its own entry in the sidebar. Its page shows:

- **The header**: how many sessions have claims, how many claims are
  flagged and how many an independent check verified, whether flags are
  on, and **Settings**.
- **Sessions with claims**, newest first, each with its one state
  (*contradicted*, *no evidence*, *verified* or *shown*). Pick one to see
  its ledger. Opening the page from a flag picks that session.
- **Ledger**: the session's claims, **Flagged** or **All claims**, and
  their counts. A flagged claim the independent check verified is counted
  apart (*1 verified by an independent check*), here, on its session's
  row, in the header and in the exports, and leaves **Flagged**; one you
  check from **Flagged** stays there with its answer until you choose the
  view again. Each claim shows its turn and time, the claim, why, what
  showed it or what says otherwise, **What the turn ran** (the commands
  and reads, folded), the check, and **Check** when the check is on; after
  **Check** the focus moves to the check's line. **Export**: Markdown, CSV
  or JSON downloads the whole ledger (quiet claims too); **Copy** puts the
  Markdown on the clipboard, and What happened logs it as a copy. CSV
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
  and setting changes, newest first.

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
the 15 minutes it was given, so Proof stopped it."). One check runs at a
time, and at most `verifierPerHour` start in an hour; the rest wait their
turn ("Waits until 3:40 PM: 12 checks have started in the last hour, the
most Proof's settings allow"). Turning the check off ends the ones still
waiting as *could not check*.

When DSH restarts while a check runs, DSH ends the thread's cut-off turn,
and Proof reads the thread as soon as it starts again: an answer the
thread gave before the restart counts, and a check it cut off settles at
once as *unclear*: "DSH restarted while it ran, so it ended before it
answered." **Check again** asks for a new one.

## Settings

Plugins → Proof shows the settings you can change while it runs, in DSH's
own settings form: change a value, then **Save**. They apply at once, and
What happened notes each save (*Settings changed: “Minutes a check may
take”*). **Use the default** clears one. The form will not save a value out
of range and says what fits instead.

| Setting | Default | Range | Where | What it does |
| --- | --- | --- | --- | --- |
| `flags` (Flag claims with no evidence on their turn) | `true` | on or off | Plugins | The card after a turn with a flagged claim. The ledger keeps every claim either way. |
| `verifier` (Independent check) | `ask` | `off`, `ask` (When I press Check) or `auto` (By itself) | Plugins | When a check runs. |
| `verifierProvider` (Check with the model from) | `local-gateway` | a provider's id in DSH's profile | Plugins | Where the check model runs. The page names it as DSH's model menu does. |
| `verifierModel` (Check with the model) | `glm-5.3-flash` | a model's id in DSH's profile | Plugins | The check model: a cheap local one, asked for low effort when it offers that. |
| `verifierMinutes` (Minutes a check may take) | `15` | 1 to 60 | Plugins | A check still running then is stopped, and its answer is unclear. A quiet local model answers in a minute or two; on a busy shared gateway, where each answer can wait several minutes, allow 30. |
| `verifierPerHour` (Checks an hour, at most) | `12` | 1 to 120 | Plugins | More wait their turn and start when the hour allows. |
| `enabled` | `true` | `true` or `false` | Profile | `false` keeps Proof loaded but idle: it reads no claims, and its page says so and how to change it. |

A wrong value never stops Proof from starting: it flags and checks
nothing, and its page says which setting is wrong, what it must be, and
**Open Proof's settings** puts the cursor in it. Once you fix it, Proof
works again at once.

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
  waiting end as *could not check*; nothing else changes.
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
  where runners print their summaries.
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

The real-DSH test (113 checks, about two minutes a build) starts DSH from
each `.e2e/dsh-<version>` install and from the installed app's own DSH,
each in a throwaway home, with Session Watch and Proof and a scripted model
(`test/e2e/fake-model.mjs`) that plays both the agent and the check model
(which offers a low and a high effort).
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
subagent and a commit, DSH's file policy stops a write, the checked
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
and with a number in quotes in the profile (named with the value),
checks Proof's file modes, loads it with `enabled: false`, and then shows
that a session made and one used meanwhile are listed again once it is
back on. It drives the page and Proof's settings in Plugins in a browser,
light and dark, wide and narrow: the header, the sessions, the ledger and
its filter, What the turn ran, the checks in time order with their times
in one column, the exports to Markdown, CSV, JSON and the clipboard (a
copy logged as a copy), and Proof switched off and on in Plugins, its
entry and flags gone and back. Pictures go to `.e2e/shots/proof/<build>/`.
