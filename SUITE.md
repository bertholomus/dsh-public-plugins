# The DSH Plugin Suite

Six plugins that make DeepSeek Harness (DSH) Desktop a place where agent work keeps going, stays honest, and is
remembered. Each one stands alone; together they share one watcher and feed each other.

| Plugin | What it does for you | Judged (version) | README |
| --- | --- | --- | --- |
| Autopilot | Keeps sessions moving when nobody is watching: after a restart it tells cut-off sessions to carry on, nudges quiet sessions with open todos once and backs off, and restarts goals an error stopped. Every action has a Why line and a kill switch. | 8.5, round 4 (1.0.1) | [plugins/autopilot](plugins/autopilot/README.md) |
| Decisions | One inbox for everything waiting on you: decision lines, approvals, questions, threads that need a decision. Each card shows the question, the recommendation, the session and the wait; your answer goes into the session, proven by its log. | 8.5, round 4 (1.0.1) | [plugins/decisions](plugins/decisions/README.md) |
| Agent Terminals | Command-line coding agents as part of DSH: each in a terminal tab beside its own session, started again after a restart, your messages typed in one at a time and proven read, and its state on the session's row and in Decisions. | 8.5, round 3 (1.0.0) | [plugins/agent-terminals](plugins/agent-terminals/README.md) |
| Proof | Checks every claim of done, passed, fixed or deployed against what its turn ran, flags the ones nothing shows, and keeps a ledger you can export. An independent read-only check on a local model when you want one. | round 3 building (round 2: 7.5) | [plugins/proof](plugins/proof/README.md) |
| Canon | Shared long-term memory: recalls the notes of your canon vault that fit the session's folder and prompt, as one short block with the notes' paths, before a turn. Captures draft notes; only you can promote one. | round 3 building (round 2: 8.0) | [plugins/canon](plugins/canon/README.md) |
| Recall | Searches everything already done: a local index of DSH sessions, transcript folders and handoff notes, with filters, results that open the exact turn, and a `recall_search` tool for agents. | 8.8, round 2 (1.0.0) | [plugins/recall](plugins/recall/README.md) |

Session Watch ([plugins/session-watch](plugins/session-watch/README.md)) is the shared core under Autopilot, Decisions
and Agent Terminals: every session's state from DSH's own events, and delivery of a message proven by the session's
own log. It has no page of its own; install it with any of those three.

## How they fit together

- **Session Watch** sees every session once and tells the others what changed, so the three plugins that act on
  sessions never disagree about what a session is doing.
- **Autopilot** keeps work going; when a session needs you instead, **Decisions** holds the question. Agent
  Terminals' agents ask through Decisions too, so there is one place to answer.
- **Proof** reads each turn's reply against the turn's own runs. A summary that leans on the turn before is read
  against that turn. Canon's recalled notes are read as background that DSH added, never as a request from you.
- **Canon** brings what the stack already decided into a new turn, and **Recall** finds what was done before, for
  you on its page and for agents through its tool.

## Install the suite

Follow [Install a plugin](README.md#install-a-plugin) once per plugin, Session Watch first:

```bash
for p in session-watch autopilot decisions agent-terminals proof canon recall; do
  dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/$p
done
```

Back up the profile first (step 2 of the install), then restart DSH Desktop once. What each one does from the
start: Autopilot acts on every session that has no rule of its own (`defaultRule: auto`; set `ask` or `off` to hold
it back) and sends at most 20 notes an hour; Decisions sends nothing outside DSH until you set a mirror; Proof flags
claims on the turn and runs its independent check only when you press Check; Canon reads nothing until you name a
vault, and never writes to it unless you allow drafts; Recall indexes this DSH's own sessions, and other folders only
when you add them. Each README has its full config table.

## Switch it off

Every plugin has its own switch in DSH's Plugins page, and its README says what switching it off leaves behind
(nothing is deleted). To take the whole suite out, follow [Remove a plugin](README.md#remove-a-plugin) for each one.

## Roll back

Each plugin is tagged on a commit that holds exactly the code its last judge scored: `autopilot-v1.0.1`,
`session-watch-v1.0.1`, `decisions-v1.0.1` (their 1.0.0 tags mark their first passing round), `agent-terminals-v1.0.0`,
`proof-v1.0.0`, `canon-v1.0.0`, `recall-v1.0.0`, and the whole suite at `suite-v1.0.0`. To go back, check out the tag in your clone (`git -C ~/.dsh-plugins/dsh-public-plugins checkout
suite-v1.0.0`) and restart DSH, or restore the profile backups from the install.

## How it was tested

- Every plugin was built and tested only in throwaway DSH Test homes, never in a DSH someone was using. Before and
  after every test run the live DSH's process and profile hash were compared; they never changed.
- Each plugin has host unit tests, window tests, and a real-DSH test that starts DSH from each installed build
  (0.2.0-rc.2, 0.2.1-rc.1 and the desktop app's own 0.2.1-rc.2) with a scripted model, and takes light and dark
  pictures. `npm test` runs the unit tests; `node scripts/e2e.mjs <plugin>` runs a plugin's real-DSH test.
- Each plugin was then scored by a fresh judge that had not seen it before, in its own DSH Test instance with a
  real local model, on five criteria (useful, reliable, design, tests, docs). A plugin passes at 8.5 or more with no
  criterion under 8. The review records stay in the private development repository.
