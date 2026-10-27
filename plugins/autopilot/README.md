# Autopilot

Keeps your sessions moving when nobody is watching. After DSH stops under a
running turn it tells the session to carry on; when a session goes quiet
with open todos it gives one nudge, and backs off if nudges bring no
progress; when a turn fails it tells the session to carry on, after a wait,
a few times, and starts a goal the error stopped once a turn ends without
an error. Every action says what it did and why, and is proven by the
session's own log, never reported on hope.

It needs Session Watch (it reads every session through it). While Session
Watch is off, Autopilot stays on but does nothing, and its page says so;
switching Session Watch off in Plugins reports no error, and Autopilot
carries on by itself once Session Watch runs again. With the notifications
plugin running, it also tells you outside the window when it backs off,
gives up or asks you something.

## What it does

| When | It | Proven by |
| --- | --- | --- |
| DSH restarted, crashed or reloaded under a running turn | Puts a short carry-on note in: which turn was cut off and when its last step was, what is still open. If a tool was waiting for approval, the note says it did not run and to make the call again; if a question waited in DSH's question box, it quotes the question and says to ask again. An active goal starts again once the turn that note started has ended without an error. | The note read into a turn; then a round of the goal's new revision |
| A session went quiet (`idleSeconds`) with open todos, and its last reply asked you nothing | One nudge naming the next todo. Two nudges in a row with no progress (no todo done, no goal round) and it backs off until you write there. | The note read into a turn |
| A session went quiet with an active goal that is not running (a restart or an error stops a goal) | Starts the goal again; its *Why* line says which round the start begins (*round 3 of 20*). A goal that has used all its rounds is never started (DSH would refuse): the log and the session's row say to raise its round limit. | A round carrying the revision this start wrote (DSH's start writes the goal's next revision, so another start's round never counts) |
| A turn failed with open work: open todos, an active goal, or the work a stop cut off (the turn was part of the carry-on after DSH stopped, as when DSH comes back before its gateway) | After `errorRetrySeconds` (2, 10 and 30 minutes by default) it tells the session to carry on, naming the error (and, after a stop, that it was carrying on). A note costs no goal round, so it always goes first: a goal the error stopped starts again only once a turn ends without an error, so an outage never spends the goal's rounds. When the last try fails it gives up at once, tells you, and tags the session *gave up*, with Try again. A carry-on after a stop is done once a turn of it ends without an error, or you write in the session. A failed turn with nothing open is yours: its row says so. | The note read into a turn; then the goal's round |

It leaves a session alone while its turn waits on you (a tool waiting for
approval, or a question in DSH's question box: its row says *waiting for
approval* or *waiting for your answer*), when its last reply waits on you
(below), when you paused its goal or the agent marked it blocked, when you
stopped its last turn, when anything was written in it since, and for
subagents' sessions; the session's row on its page says which.

A last reply waits on you when its last six lines ask you something (a
question at the end, `DECISION NEEDED`, `BLOCKED:`, *should I*, *do you
want*, *your call*, *please confirm*, *waiting for your …*) or hand the
next step to you: *let me know if you want me to …*, *tell me which …*,
*say the word and I'll …*, *… if you'd like*, *if you'd prefer X, I can …*,
*once you confirm, I'll …*, *I'll wait for your review*, *happy to try
another colour next*, *I can add retries too, if that's useful*, *I'm
holding off until you confirm*, *I'd like your review first*, *I need the
API token*, *Your pick.*, *Can you check whether the DB is up?*. An offer
that hands nothing over does not hold the note: *happy to keep going*,
*happy to report*, *feel free to review the diff*, *let me know if you have
any questions* or *if you hit any snags*, advice such as *If you want a
stricter check, use …* or *Run `npm run bench` if you want the raw
timings*, and where a thing is (*The logs are in /tmp if you want to
look.*). Nor does any offer when the reply's last sentence says what the
agent does next (*Next: the CLI.*, *Moving on to the docs.*, *I will carry
on with the remaining todos.*), unless that sentence waits on you itself
(*Let me know if this looks good, and I'll move on to the tests.*). The row
says which held it: *Waits for you: its last reply asks you something*, or,
for an offer, its words (*Waits for you: its last reply leaves the next
step to you (“Let me know if you want me to continue with steps 2 and
3.”).*).

Measured on 30 endings written after the rule was frozen and read once
(`test/autopilot-ends.test.js`, `test/fixtures/autopilot/endings.json`):
1 false hold among the 15 that do not wait on you (*Fixed. Feel free to
ping me if the error comes back.*: such a session waits for you with its
work open), and 3 misses among the 15 that do (*I don't have write access
to the `infra` repo, so the DNS change has to come from you.*, *There's a
trade-off between speed and memory here; I'll go with whatever you
decide.*, *I could split the module now or after the release — your
choice.*): such a session gets the nudge, which asks the agent to end with
a `DECISION NEEDED` line if it is blocked. Three earlier held-out sets were
each read once and then used to widen the rule: 44 endings (no false hold
among 22, 4 misses among 22), 32 (none among 16, 3 misses among 16) and 30
(1 among 15, 2 misses among 15); they all read right now, as do the 84 real
endings from the suite's DSH Test sessions, the round-5 judge's nine and 70
written ones. The suite's broader rule (any offer in the last six lines)
held 39 of the 167 endings that do not wait on you, and missed 49 of the
132 that do.

Every note starts with
`[Autopilot]` and asks the agent to end with a `DECISION NEEDED` line if it
is blocked, which Decisions picks up when it runs. In the chat, DSH shows
each note the way it shows any message a plugin sends: a collapsed *Plugin
status updated* card above the reply it started. Open the card to read the
note, or read it on Autopilot's page under *What it sent*.

## The page

**Autopilot** in DSH's sidebar:

- **The switch.** Off stops everything at once: nothing it scheduled runs,
  and its questions are withdrawn. On again, it looks at every session,
  the ones a stop cut off included (it reads their logs, as at a start).
  While it is off, Try again and answers are refused with what to do first,
  in the row you pressed, and the cursor moves to that line.
  The line beside it says how many sessions it watches, how many notes it
  sent this hour and the limit, and how long a session waits for a note.
- **The rule for sessions without their own**: Auto (act), Ask first, or
  Off. While the switch is off the line says the rule applies when
  Autopilot is on. A click applies a rule at once. With the keyboard, the
  arrow keys only show a choice (*Press Enter to apply Ask first.*): Enter
  applies it, Escape takes it back, and the cursor stays on the rule. A
  choice shown that way stays while the list redraws (a row moving as a
  session works), and the cursor comes back to it. A rule (a session's, or
  the default) that leaves Off looks at the sessions it now covers at once,
  cut-off ones included.
- **Waiting for you**: its questions (under Ask first), with the action,
  Leave it, and Open; and sessions it backed off from (*backed off*) or
  stopped retrying (*gave up*), with Try again. When Decisions runs, the
  same questions show there too, and an answer in either place counts
  once. A row you answered or tried again leaves, and the cursor moves to
  the row now in its place (else the card's heading), never off the page.
- **Sessions**: each with its state, its open work, when Autopilot looks
  next (*next: gives up at 6:24 PM* when the tries are spent) or why it
  leaves the session to you (*Waits for you: its last reply asks you
  something.*, *Waits for your answer: Autopilot asked whether to tell it to
  carry on.*, *Its last turn failed with nothing left open (no todos, no
  goal), so Autopilot leaves it to you.*), its last action as it ended (*DSH refused to start its
  goal*, *its note was not delivered*) with the time it ended, and its own
  rule. *Open work* lists the ones with todos or a goal open or a look
  coming, and every one cut off, failed, given up or backed off on; *All*
  lists every recent session.
- **What Autopilot did**: every action, every question, every settings
  change and every time it held back for a reason you would want to know,
  each with a *Why* line that says who acted (Autopilot, or you), its
  outcome (*in the queue*, *delivered*, *started*, *not delivered* with the
  reason), and *What it sent*. A question ends *answered*, or *withdrawn*
  with the reason (you switched Autopilot off, set the session's rule to
  Off, or wrote in the session). A question still open when DSH stops (a
  quit, a crash or a forced quit), or when Autopilot or Session Watch is
  switched off in Plugins, is marked *withdrawn* with that reason (after a
  crash or a forced quit, as Autopilot next starts, before it looks at any
  session); if it still applies, it is asked again under the same entry,
  with the time and the *Why* it was first asked, and with no second
  notification. At
  that start it also checks what a crash left open against each session's
  log: a note the session read is *delivered*; one still in the session's
  queue, which DSH keeps in that log, is *not proven* and never sent again;
  Autopilot reads that session's log again as it moves (for up to a week),
  and once the session reads the note, the entry turns *delivered*, with
  the turn that read it. One that never reached the session is
  *not delivered* (and sent again if it still applies). A goal start whose
  round began is *started*, one whose round never began is *not started*.
  Times such as *4 min ago* keep up while the page is open.

When Autopilot cannot work, the page says why and what to do, with a button
to the place to do it: *Autopilot needs Session Watch, which is not
running* (switch Session Watch on in Plugins), *Autopilot is not running*
(switch it off and on in Plugins, or restart DSH), or *Autopilot is waiting
for a setting to be fixed* (which setting, what it must be, and where to
change it). It comes back by itself once the cause is gone.

The sidebar icon shows a count while Autopilot waits on an answer, and dims
while it is off or not running.

## Settings

Plugins → Autopilot shows the settings you can change while it runs, in
DSH's own settings form: type a value, then **Save**. They apply at once,
and the event log notes each save with the new value and the one before
(*Settings changed: “Quiet time before a note” now 90 seconds (was 600
seconds)*). **Use the default** clears one. The form will not save a value
out of range and says what fits instead; a value saved in the profile that
does not fit is flagged the same way as soon as the form opens. A number
written in quotes in the profile (`idleSeconds: "90"`) shows with its
quotes, flagged as text in quotes: type the number without them and
**Save**. **Open Autopilot's settings** on its page puts the cursor in the
setting to fix.

| Setting | Default | Range | Where | What it does |
| --- | --- | --- | --- | --- |
| `idleSeconds` (Quiet time before a note) | `600` | 5 to 86400 seconds | Plugins | How long a session stays quiet, with work open, before a nudge. |
| `maxNudges` (Notes in a row without progress) | `2` | 1 to 10 | Plugins | Nudges in a row with no progress before it backs off. |
| `maxNotesPerHour` (Notes an hour, at most) | `20` | 1 to 500 | Plugins | The most notes and goal starts Autopilot sends in an hour, over all sessions. Past it, it holds back and says so once. Your own answer to its question, and Try again, always go at once and are not counted. |
| `resumeAfterRestart` (Resume after a restart) | `true` | on or off | Plugins | After DSH starts, tell the sessions a stop cut off to carry on. |
| `resumeWindowHours` (Resume sessions cut off within) | `6` | 1 to 168 hours | Plugins | Only sessions cut off within this many hours are resumed. |
| `idleWindowHours` (At start, look back) | `2` | 1 to 168 hours | Plugins | At start, idle sessions whose last turn ended within this many hours are looked at. |
| `errorRetrySeconds` (Waits before each try after an error) | `120, 600, 1800` | 1 to 10 waits, each 0 to 86400 seconds | Plugins | The wait before each try after a failed turn; one try (a carry-on note) per wait. When the last try fails it gives up at once. |
| `defaultRule` | `auto` | `auto`, `ask` or `off` | Profile | The rule for sessions without their own until you pick one on its page, which then wins. |
| `startDelaySeconds` | `20` | 0 to 600 seconds | Profile | How long after it starts it first looks: after DSH starts, after a wrong setting is fixed, or after it is turned back on (`enabled` set to `true` again, or Autopilot or Session Watch turned back on in DSH's Plugins; the switch on Autopilot's page looks at once); a row waiting for that look says which. |
| `enabled` | `true` | `true` or `false` | Profile | `false` keeps Autopilot loaded but idle: it watches nothing, and its page says so and how to change it. |

*Profile* settings go in the `autopilot` row of the profile's
`cordis.patch.yml` (see Setup) and apply after a restart. A wrong value
there never stops Autopilot from starting: it does no work, and its page
says which setting is wrong, what it must be, and where to change it. Once
you fix it, Autopilot looks at every session again.

## Files

In DSH's data folder (`$DSH_HOME`, else `~/.dsh`), folder mode 700, files
mode 600:

| File | What |
| --- | --- |
| `autopilot/state.json` | The switch, rules, what it already handled (so a restart never repeats an action), nudge and retry counts. |
| `autopilot/events.jsonl` | The event log; it keeps the last 400 entries and rewrites itself past 1 MB. |

## Setup

1. Install Session Watch and Autopilot as in the
   [root README](../../README.md#install-a-plugin):

   ```bash
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/session-watch
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/autopilot
   ```

   That adds `dsh-plugin-session-watch` and `dsh-plugin-autopilot` to the
   profile's `package.json` (`dependencies` and `dsh.profile.bundles`).
   Their bundles add their rows (`id: session-watch`, `id: autopilot`).

2. To change a default before the first start, address the row in the
   profile's `cordis.patch.yml` (the ones marked Plugins above can also be
   changed later in Plugins → Autopilot):

   ```yaml
   - id: autopilot
     config:
       idleSeconds: 900
       defaultRule: ask
   ```

3. Restart DSH Desktop once so it loads the new bundles.

## Switching it off

- **For a moment**: the switch on its page. Nothing it scheduled runs, and
  its questions are withdrawn.
- **For one session**: that session's rule, Off.
- **Entirely**: Plugins → Autopilot → off. Its sidebar entry and page go,
  and it leaves no marks in other plugins' views. (`enabled: false` in the
  profile instead keeps its page, which says it is off and how to turn it
  back on, and refuses its actions in words.)
- **With Session Watch**: Plugins → Session Watch → off also stops
  Autopilot's work, with no error from DSH: Autopilot stays on in Plugins,
  its page says it needs Session Watch, and it starts again by itself when
  Session Watch does.

## Rollback

DSH runs Autopilot from its folder in your clone (the profile links it). To
go back to a release, restore that folder from the release's tag and
restart DSH Desktop:

```bash
git -C ~/.dsh-plugins/dsh-public-plugins restore --source autopilot-v1.0.1 -- plugins/autopilot
```

To remove it, follow [Remove a plugin](../../README.md#remove-a-plugin) for
`dsh-plugin-autopilot` (row `autopilot`), and delete `autopilot/` in DSH's
data folder to forget its rules and log. Nothing else needs undoing: it
changes nothing in your sessions beyond the notes it sent, which stay in
their logs, signed `[Autopilot]`.

## Tests

From the repository root:

```sh
node --test test/autopilot.test.js   # the engine over the watcher and a stand-in DSH; the page; the browser half
node --test test/autopilot-ends.test.js  # what holds the nudge, measured on labelled reply endings
node scripts/e2e.mjs autopilot       # real DSH in a throwaway home, on every DSH build here
```

The real-DSH test (128 checks) starts DSH from each `.e2e/dsh-<version>`
install (`npm i --prefix .e2e/dsh-0.2.1-rc.1 @deepseek-ai/dsh@0.2.1-rc.1`)
and from the installed app's own DSH (run as Node by the app's binary, as a
separate process), each in a throwaway home, with a scripted model playing
the agent and a stand-in window that gets DSH's own prompts. It lets
sessions go quiet with work open (a nudge, back-off, progress, Ask first,
Off, a question left alone, an offer that goes on nudged and one that hands
over held, with its words on the row), stops and kills DSH under running
turns (one of them waiting for approval, one with a question in the
question box, and one with no todos and no goal whose carry-on fails, as
when DSH comes back before its gateway: two tries, then *gave up*),
and drives the page in a browser (`npm i --prefix .e2e/tools
playwright-core`, with Playwright's Chrome), light and dark, wide and
narrow: the buttons, the rule keys, where the cursor goes after an answer
and after Try again, a refusal in its row, the contrast of every state word
on the page, the cards' small text and the Waiting card's tags at
Wallpaper's tint .2 over a mid picture, a question open across a quit, a rule choice kept while the list
redraws, numbers in quotes for Autopilot and for Session Watch in the
profile (both named on the page with the value, and Autopilot's fixed
through the form, which shows it in quotes and flagged), a wrong setting
fixed through DSH's form in Plugins with the cursor in it, and Session
Watch switched off and on in Plugins with no error from DSH. It fails a
goal round (a carry-on note first, then the goal's next round), runs an
outage where every try fails (no goal round spent, then *gave up*), and
kills DSH under an open question and a goal start waiting for its round
(both settled from the logs at the next start). It also runs with Session
Watch off in the profile and with `enabled: false`, and checks the file
modes. Every claim is checked in the session's own log. It reads the
running DSH's fingerprint before and after and fails if it moved; pictures
go to `.e2e/shots/autopilot/<version>/`.
