# Session Watch

The shared watcher behind Autopilot, Decisions and Agent Terminals. It
reads every session's state once, from DSH's own events, and serves it to
the other suite plugins, so they never read session logs or poll on their
own. It has no page of its own: you see it through the plugins that use
it, and its one setting is on its page in Plugins.

## What it knows about every session

| | From |
| --- | --- |
| Whether a turn runs, how the last one ended (finished, failed, stopped, cut off by a stop, cut short) and when | `turn/start` and `turn/end` |
| The last reply's closing text (for `DECISION NEEDED` lines and questions) | `assistant/message` |
| Its todos: open, in progress, done, and the next one | `todo/write` |
| Its goal: objective, phase, rounds | `goal/change` and goal-round messages |
| What a running turn waits on you for: a tool waiting for approval, a question in DSH's question box (the state reads *waiting for approval* or *waiting for your answer*). Both end with their turn; a turn a stop cut off keeps what was left waiting, so Autopilot's carry-on note can say it did not run. | `approval/asked`, `approval/decided`, and the question box's `tool/call` and `tool/result` |
| When a person last wrote, and when anything last went in | `user/message` |

DSH folds every committed event into this state (a registered session
projection, key `sessionWatch`), keeps it with the session, and hands it
back for sessions that are not loaded. A session's state is read live while
it is loaded, from the saved value when it is not, and from its whole log
when a plugin needs the reply text of a session that is not loaded.

## What it does for other plugins

- **Delivery with proof.** `deliver(sessionId, text)` puts a message into a
  session (loading it first when needed) and follows it through the
  session's own log: *queued* once the session's inbox shows it, *delivered*
  once a turn reads it, *not delivered* with the reason when DSH refuses it,
  lets it go unread, or no turn reads it within the delivery timeout. It
  never reports a message as sent on hope.
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
  hidden window stops asking.

## Settings

Plugins → Session Watch, in DSH's own settings form: type a value, then
**Save**; it applies at once. The form will not save a value out of range.

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| `deliveryTimeoutSeconds` (How long a message may wait to be read) | `600` | 10 to 86400 seconds | How long a message from Autopilot, Decisions or Agent Terminals may wait to be read into a turn before it is reported as not delivered. |

A wrong value set in the profile never stops the watcher, which every suite
plugin needs: it uses the default and Autopilot's page says which setting to
fix.

## Files

In DSH's data folder (`$DSH_HOME`, else `~/.dsh`), folder mode 700, file
mode 600:

| File | What |
| --- | --- |
| `session-watch/running.json` | Sessions with a turn running now, so the next start knows what a stop cut off. |

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
It leaves nothing behind: its projection's saved values go when DSH drops
them, and `running.json` can be deleted.

## Rollback

DSH runs it from its folder in your clone. To go back to a release, restore
that folder from the release's tag and restart DSH Desktop:

```bash
git -C ~/.dsh-plugins/dsh-public-plugins restore --source session-watch-v1.0.0 -- plugins/session-watch
```

The saved state carries a version number, so an older or newer copy folds
again from the log instead of misreading it. To remove it, remove the
plugins that use it first, then follow
[Remove a plugin](../../README.md#remove-a-plugin) for
`dsh-plugin-session-watch` (row `session-watch`).

## Tests

From the repository root:

```sh
node --test test/session-watch.test.js   # the fold and the watcher over a stand-in DSH
node scripts/e2e.mjs autopilot           # with Autopilot, in real DSH in a throwaway home
```
