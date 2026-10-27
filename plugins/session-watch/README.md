# Session Watch

The shared watcher behind Autopilot, Decisions and Agent Terminals. It
reads every session's state once, from DSH's own events, and serves it to
the other suite plugins, so they never read session logs or poll on their
own. It has no page of its own: you see it through the plugins that use
it. Its page in Plugins has its one setting and, under it, **What it
watches**: how many sessions there are, how many run and how many wait on
you, how many are in each state (*running*, *waiting for approval*,
*waiting for your answer*, *cut off*, *idle* and so on), which of
Autopilot, Decisions and Agent Terminals are on, and what a wrong setting
means meanwhile. Choose a state to list its sessions, the latest change
first: the twelve newest, then twelve more at each **Show 12 more** (the
last press names how many are left; the focus stays on the button, and
moves to the first session it showed once none are left). Each has when
it last changed and **Open**, which shows that session in the window as
the sidebar does. The states are one tab stop: the arrow keys, Home and
End move between them. It follows the sessions as they change, without a
reload, a question in DSH's question box included: a chosen state stays
open when its last session leaves it, and says so.

## What it knows about every session

| | From |
| --- | --- |
| Whether a turn runs, how the last one ended (finished, failed, stopped, cut off by a stop, cut short) and when | `turn/start` and `turn/end` |
| The last reply's closing text (for `DECISION NEEDED` lines and questions) | `assistant/message` |
| Its todos: open, in progress, done, and the next one | `todo/write` |
| Its goal: objective, phase, rounds | `goal/change` and goal-round messages |
| What a running turn waits on you for: a tool waiting for approval, a question in DSH's question box (the state reads *waiting for approval* or *waiting for your answer*). Listeners and open windows hear each as it is asked and answered. Both end with their turn; a turn a stop cut off keeps what was left waiting, so Autopilot's carry-on note can say it did not run. | `approval/asked`, `approval/decided`, and the question box's `tool/call` and `tool/result` |
| When a person last wrote, and when anything last went in | `user/message` |

DSH folds every committed event into this state (a registered session
projection, key `sessionWatch`), keeps it with the session, and hands it
back for sessions that are not loaded. A session's state is read live while
it is loaded, from the saved value when it is not, and from its whole log
when a plugin needs the reply text of a session that is not loaded.

DSH's saved value for a session whose turn a stop cut off can be from
before that turn (after a quit or a crash, DSH's list may even call the
session blank). After a restart the watcher reads those sessions' logs
once, so they read *cut off*, not *new* or *idle*; it keeps doing so at each
start until a turn ends there again.

## What it does for other plugins

- **Delivery with proof.** `deliver(sessionId, text)` puts a message into a
  session (loading it first when needed) and follows it through the
  session's own log: *queued* once the session's inbox shows it, *delivered*
  once a turn reads it, naming that turn, *not delivered* with the reason
  when DSH refuses it, lets it go unread, or no turn reads it within the
  delivery timeout. It never reports a message as sent on hope. Each
  message it puts in, and what became of it, goes into its private
  journal (`deliveries.jsonl`, see Files) as it happens, and into DSH's
  plugin logger.
- **Not delivered means never read.** Past the delivery timeout, the
  watcher takes the message back out of the session's queue (DSH's
  `inbox.remove`; the session's log records it), so no later turn reads a
  message it reported as not delivered. A message a turn took from the
  queue at that very moment is left for that turn to prove, for one more
  minute. Where DSH cannot take it back (the session is not loaded), the
  reason says the message still waits in the queue and is read when the
  session runs again.
- **A message on its way when DSH stops.** At each start (after a quit, a
  crash, or Session Watch switched off and on again) the watcher reads
  every message its journal still has on its way against that session's
  log: read into a turn, it is *delivered*, naming the turn; still in the
  queue, it is followed again for the rest of its wait (at least a
  minute); taken out unread, or never queued, it is *not delivered*, with
  the reason. When DSH 0.2 closes a session as it quits (SIGTERM), it
  takes the queued messages out of its queue unread, and says so in the
  log: such a message reads *not delivered* ("the session let the message
  go without reading it"). A crash, or a stop that does not close the
  sessions, leaves the queue as it was, and those messages are followed
  again. Listeners hear each outcome as a `delivery` event (with
  `restored: true`), and `deliveryOf(id)` gives any message's record, from
  this run or an earlier one. Switched off, the watcher stops its timers,
  so it never takes a message back while it is off.
- **A queue a stop left.** DSH reads one queued message per turn, so a
  carry-on queued behind messages a stop left in a session would wait a
  turn for each, or be taken back unread. When a session is not running
  and has messages waiting, `deliver` puts the new message in as a steer
  instead: it starts the next turn, and DSH reads it there with the oldest
  message waiting for a turn, the new one first (a message a stop left for
  a running turn's next step is read in that same turn, ahead of both).
  `cutOffSessions` names what still waits in each cut-off session
  (`queued`).
- **Cut off by a stop.** It keeps a small record of turns running now
  (`running.json`). After DSH restarts, crashes or reloads, it finds the
  sessions whose turn the stop cut off, from that record and from DSH's
  saved values, and checks each against its log. Subagents' sessions are
  left to their parents.
- **Questions for a person.** Any suite plugin can raise a question
  (Autopilot's Ask first rule, an agent in a terminal); Decisions shows them
  all, and an answer goes back to the plugin that asked. When the answer's
  fate is known only later (typed into a terminal, then seen in the agent's
  transcript or not), the asking plugin says so, and Decisions shows it.
- **One request per window.** Suite pages keep a single request open to the
  watcher (`/api/dsh-plugin-session-watch/wait`) that answers when anything
  they show moved, and read their own state only then. Nothing polls, and a
  hidden window stops asking. While Session Watch is off, a window asks
  DSH's own plugin list every four seconds instead of the watcher's
  endpoint, and the pages come back by themselves once it runs. Requests
  that are open at the moment it goes fail once (the browser's console
  shows them); after that, none do.

## For plugin authors

Other plugins use the `sessionWatch` service, doing their work under its
scope (`ctx.inject(['sessionWatch'], (scope) => ...)`, as Autopilot does), so
they stop with it. `list`, `get`, `readLog`, `deliver` and `cutOffSessions`
never throw for a session they cannot read: `readLog` gives nothing, and
`deliver` a failed delivery with the reason in words. `resolveAgent` throws
with DSH's reason.

| Call | What it gives |
| --- | --- |
| `list()` | Every session DSH lists, newest first: `sessionId`, `title`, `cwd`, `status` (`running`, `idle`, or `cold`: not loaded), `word` (its state in the suite's words), `state` (the table above, without the reply text), `external` when an outside agent set one. |
| `get(sessionId)` | One row, as `list()` gives them. |
| `stateOf(sessionId)`, `fullState(sessionId)` | Its state; `fullState` with the last reply's text, folded from the log when the session is not loaded. |
| `readLog(sessionId)` | Its log through DSH, without loading it: `{ state, events }`. |
| `projection(sessionId, key)` | Another projection's value (DSH's question box, a coordinator's threads): `{ live, value }`. |
| `on(listener)` | Events: `turn-start`, `turn-end` (with `end`), `state` (with the event type as `change`), `status`, `agent`, `delivery`, `ask`, `external`. Returns a function that stops listening. |
| `deliver(sessionId, text, { mode, from })` | A delivery: `id`, `state` (`pending`, `queued`, `delivered` or `failed`), `turn` once delivered, `reason` once failed, `mode` (how it went in: `queue` or `steer`), `waiting` (how many messages were already waiting, when it went ahead of them), and `done`, a promise that settles then. `mode: 'steer'` puts it into the running turn's next step (a session that is not running gets it as its next turn). `from` names the sender in the journal and in `cutOffSessions`. |
| `deliveryOf(id)` | A delivery's record as the journal has it, from this run or an earlier one (without `done`); `restored: true` when it was followed again after a stop. Undefined when it is not known. |
| `deliveries({ sessionId, limit })` | The newest records (all sessions, or one), newest first; `limit` up to 1000 (default 50). |
| `cutOffSessions({ withinMs })` | Sessions whose last turn a stop cut off and that nothing went into since, checked against their logs (only cuts within `withinMs`; `0` for any): `sessionId`, `title`, `cwd`, `end`, `state`, and `queued` when messages still wait in its queue (each with `id`, `at`, its first words as `preview`, and `from` when the watcher put it in). Subagents' sessions are left to their parents. |
| `raiseAsk(ask)`, `answerAsk(id, answer, by)`, `dropAsk(id)`, `askOutcome(id, outcome)`, `asks()` | Questions for a person: raised with an `onAnswer` handler, answered once (a second answer is refused in words), and what became of an answer. |
| `setExternal(sessionId, external)` | An outside agent's state on its session's row (`null` clears it). |
| `resolveAgent(sessionId)` | The live agent, loading the session when it is cold. |

Window endpoints, at `/api/dsh-plugin-session-watch/<name>`: `wait` (`since`,
`timeoutMs`: answers when a channel moved, or after at most 25 seconds),
`sessions` (the rows, without the reply text), `deliveries` (`sessionId`,
`limit`: the newest delivery records, up to 200) and `status` (`running`,
and `problem` naming a wrong setting and its value).

## Settings

Plugins → Session Watch, in DSH's own settings form: type a value, then
**Save**; it applies at once. The form will not save a value out of range.

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| `deliveryTimeoutSeconds` (How long a message may wait to be read) | `600` | 10 to 86400 seconds | How long a message from Autopilot, Decisions or Agent Terminals may wait to be read into a turn before it is reported as not delivered. |

A wrong value set in the profile never stops the watcher, which every suite
plugin needs: it uses the default, its `status` names the setting and the
value, and Autopilot's page says which setting to fix. A number typed in
the profile in quotes (`deliveryTimeoutSeconds: "600"`) is text, not a
number: the form shows it in its quotes, flagged at once with what to
type, and saving the number without them fixes it.

## Files

In DSH's data folder (`$DSH_HOME`, else `~/.dsh`), folder mode 700, file
mode 600:

| File | What |
| --- | --- |
| `session-watch/running.json` | Sessions with a turn running now, so the next start knows what a stop cut off; and the sessions a stop cut off that have not ended a turn since (the newest 50), whose rows it reads from their logs at each start. |
| `session-watch/deliveries.jsonl` | Its journal: one JSON line for each message it puts in (session, sender, mode, first words) and one for each change of its state (queued, delivered with the turn, not delivered with the reason). It reads back the newest 1000 deliveries at each start; past 1 MB it writes the file again with only those. |

## Setup

Install it as in the [root README](../../README.md#install-a-plugin), before
the plugins that use it, and restart DSH Desktop once:

```bash
dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/session-watch
```

That adds `dsh-plugin-session-watch` to the profile's `package.json`
(`dependencies` and `dsh.profile.bundles`); its bundle adds its row
(`id: session-watch`).

## Switching it off

Plugins → Session Watch → off. The plugins that use it stop their work with
it, with no error from DSH: Autopilot and Decisions stay on in Plugins, do
nothing, and their pages say they need Session Watch; they start again by
themselves when it does (an open page comes back within about ten seconds).
Its section and its style sheet leave the window with it. It leaves nothing
else behind: its projection's saved values go when DSH drops them, and
`running.json` and `deliveries.jsonl` can be deleted. While it is off it
takes nothing back out of a queue; on again, it follows what it left on
its way.

## Rollback

DSH runs it from its folder in your clone. To go back to a release, restore
that folder from the release's tag and restart DSH Desktop:

```bash
git -C ~/.dsh-plugins/dsh-public-plugins restore --source session-watch-v1.0.1 -- plugins/session-watch
```

This build is 1.1.0 (Plugins shows the version). The saved state carries a
version number, so an older or newer copy folds again from the log instead
of misreading it; 1.0.1 never reads `deliveries.jsonl` and leaves it be. To remove it, remove the
plugins that use it first, then follow
[Remove a plugin](../../README.md#remove-a-plugin) for
`dsh-plugin-session-watch` (row `session-watch`).

## Tests

From the repository root:

```sh
node --test test/session-watch.test.js   # the fold, the watcher over a stand-in DSH (its journal across stops), its page in Plugins
node --test test/suite-shared.test.js    # the window kit: the settings form, one request per window
node scripts/e2e.mjs session-watch       # in real DSH, on every DSH build
```

`scripts/e2e.mjs session-watch` runs `test/e2e/run.mjs` on each DSH under
`.e2e/` and on the installed app's DSH, each in a throwaway home with a
scripted model, and checks that the DSH you use was not touched. A stand-in
user of the service (`test/e2e/probe`, a test-only plugin) calls
`sessionWatch` as Autopilot does and serves what it gets to the test. It
proves, from each session's own log:

- the fold: a todo list, a `DECISION NEEDED` line, a goal, a tool waiting
  for approval and a question in DSH's question box, each cleared when
  answered; listeners hear turns in order, and hear the question box ask
  and get its answer;
- delivery with proof: queued, then read inside the very turn the delivery
  names; a steer read into the running turn; a session that does not exist
  refused in words; a message past the wait taken back out of the queue and
  never read;
- a quit (SIGTERM) and a crash (SIGKILL) under running turns, each with a
  message queued behind the turn: the cut-off sessions are found and the
  finished ones are not, their rows read *cut off*, and a carry-on message
  to one that is not loaded is delivered into a new turn. The queued
  message is told as the log has it: let go unread at the quit (every
  build here does that on SIGTERM), so the carry-on goes alone; still
  queued after the crash, so it is followed again, named in
  `cutOffSessions`, and read with the carry-on, in one turn, the carry-on
  first, with nothing taken back; no session that ran a turn reads *new*
  after later restarts;
- questions for a person, outside agents, and the folder (700) and file
  (600) modes;
- a number in quotes in the profile: `status` names it, delivery still
  works, and its page in Plugins flags it, refuses a value out of range,
  and fixes it on Save; **What it watches** counts every session by state,
  follows a new session and a question in the question box without a
  reload (and counts it as waiting on you), lists a chosen state's
  sessions as the watcher has them, opens one with **Open**, keeps a
  chosen state (at 0) and the keyboard focus when its last session leaves
  it, moves between states by arrow keys, Home and End as one tab stop,
  lists past twelve with **Show 12 more** and keeps the focus, and drops
  its setting line once fixed; pictures light, dark and at 760 px;
- switched off in Plugins with a message queued behind a running turn: no
  failure from DSH, its endpoints, service, section and style sheet go,
  and past its wait it has taken nothing back; on again, it serves at
  once, follows that message again, and proves it read in the next turn.

Autopilot's, Decisions' and Agent Terminals' own real-DSH tests run with it
too (`node scripts/e2e.mjs autopilot`, and so on).
