# Agent Terminals

Command-line coding agents as part of DSH. Name a program (any coding agent
you run in a terminal) and the folder it works in: Agent Terminals gives it
a DSH session of its own, starts it in a terminal of that session, and shows
that terminal in a tab beside the session. From then on:

- **You see what it does.** For a program that keeps a transcript Agent
  Terminals can read, the agent is *working*, *idle*, *waiting on you* or
  *stopped*, on the Coding agents page, on its session's row in the
  sidebar, and, when it waits on you, in Decisions.
- **Your messages go in, and are proven read.** One at a time, only while
  the agent is ready for one, pasted as one message when the program asked
  for pasted text, and *delivered* only once the agent's own transcript
  shows it. A program that swallowed the Enter after a paste gets Enter
  again. Agent Terminals reads the transcript just before it types, and
  presses no key at all while a tool call or an approval prompt is open in
  it, so it never answers a prompt for you.
- **It comes back after DSH restarts.** DSH ends every terminal when it
  quits. On the next start each agent that was running starts again in a
  new terminal under the same name, so the window's tab finds it, and
  resumes its conversation (one that has no conversation yet starts again
  without a resume its program would refuse). A job the restart cut off
  ends there: the agent comes back idle, *What happened* says which job
  was cut off, and your next message carries on.

It needs Session Watch, which carries each agent's state to its session's
row and to Decisions. While Session Watch is off, Agent Terminals stays on
but starts, reads and types nothing; its page says so, and switching
Session Watch off reports no error.

## How a program starts and resumes

Agent Terminals knows a program by the way it works, never by its name.
There are four ways:

| Way | A new conversation | Resumed with | Transcript it reads |
| --- | --- | --- | --- |
| `flags` | `--session-id <id>`, with an id Agent Terminals makes | `--resume <id>`, once its transcript is there; before its first message there is no conversation, so it starts again with `--session-id <id>` | One JSON line per message: `<conversations folder>/projects/<folder>/<id>.jsonl` |
| `subcommand` | Nothing added | `resume <id>`, before your arguments, once the id is read; before that, a new conversation | One JSON line per event: `<conversations folder>/sessions/<year>/<month>/<day>/rollout-…-<id>.jsonl`; the id is read from the file the program makes |
| `continue` | Nothing added | `--continue` (the folder's latest conversation) | None |
| `plain` | Nothing added | Not started again by itself: **Start again** runs it anew | None |

The conversations folder is `~/.<program>` unless you name another. The
start form lists the programs this computer has used, found by the
conversations they keep in such folders (never from a list of names), with
their way of resuming and where DSH finds them. You can type any other
program.

Without a transcript (`continue`, `plain`) an agent is only *running* or
*stopped* (*running* shows the steady terminal glyph, never the working
spinner: nobody knows whether it works), a message counts as *typed in*,
not proven read, and what it asks shows only in its terminal.

Agent Terminals resumes only a conversation it can see: a `flags` program
writes its transcript with its first message, so one that never got a
message (or whose transcript is not where Agent Terminals looks) starts
again under its id, and its card says *Start again starts it again (it
has no conversation to resume yet)*.

## What it does

**Starting.** **Start a coding agent** on the Coding agents page, or
**Start a coding agent here** in a session's ⋯ menu. A new agent gets a new
session in its folder, named after it, and the session gets one message
(`listNewSessions`): DSH lists a session in its sidebar only once a turn
ran in it. The message tells its model that a coding agent runs in the
session's terminal tab, that there is no task and no answer is needed,
and the one line to reply with; it asks nothing, and its words keep clear
of what Session Watch reads as asking, so the reply makes no card in
Decisions. A model that asks something all the same is said in
*What happened* (Decisions may list it: dismiss it there). In the session, Agent Terminals opens a terminal
with zsh or bash, as DSH's terminals do (your shell's startup files run as
in any terminal), and types `exec <program> <arguments>`, so the terminal
ends when the agent does. The first message, if you wrote one, goes in once
the agent's screen settles. One agent per session.

A program given as a path must be an executable file there, or the start
is refused before any session is made; `~/` is your home folder, and the
agent keeps the full path. Words on the page show a path under your home
folder as `~/…`; the card's command and each **Used here before** chip show
the whole of it on hover. Agent Terminals then watches the first moments:
a program that ends at once (a name the shell cannot find, say) is *Could
not start*, with why and what to do, and its session gets no first turn.
The form keeps what you wrote, so you can fix it and start again (forget
the card that could not start), and **Used here before** lists only
programs that ran. The first turn is noted in *What happened* when it ends;
one that DSH quit on is settled at its next start, from the session's own
last turn (*cut off*, or how it ended), so none stays *sending*.

**Its state.** From the agent's transcript: *working* while it answers or
runs a tool, *idle* once its reply settles, *waiting on you* when its last
reply asks you (a `DECISION NEEDED: <question> — recommend: <pick>` line,
or a question in its last lines) or when a tool call has waited
`askAfterSeconds` for its result (its terminal most likely asks for
approval), and *stopped* when its program ended or you stopped it, with
why. Each state shows on the page, on its session's row, and in Session
Watch, so the other suite plugins see it too.

**When it asks you.** A reply that asks makes a Decisions card: the agent's
name, the question, the recommendation, **Go with the recommendation** and
room for your own words. The answer is typed into its terminal like any
message, and proven the same way: Decisions says where the answer went,
then marks it *delivered* once the agent's transcript shows it (or *not
confirmed*, with where to look). An answer that does not go in (its
terminal is gone, or you take it back on the agent's card) brings the
question back in Decisions, saying why. A tool call that waits makes a card that
says what the agent asks to run and to answer in its terminal: a terminal
prompt has no answer that could safely be typed in for you. Messages wait
until you answered there. With `notify` on and DSH's notifications plugin
running, you also get a notification.

**Typing a message in.** A message is *queued*, then *waiting* (with why:
the agent works, runs a tool, waits on you in its terminal, is starting or
is stopped), *typing*, *typed in*, and *delivered* once the transcript
shows it. **Take back** removes one that is not typed in yet. A message of
several lines goes in as one paste when the program asked for pasted text;
otherwise its line breaks go in as spaces, and the message says so. With
`typeWhileWorking` on, a message is typed in while the agent works, and the
program keeps it until it reads it. When an idle agent's transcript does
not show the message after `proofSeconds`, Enter goes again, up to
`enterRetries` times; after that the message is *not proven*, with where to
look. If the transcript shows it later (within a day), it turns
*delivered*, and *What happened* says so. A message that *failed* or is
*not proven* has **Send again**, which sends its whole text once more as a
new message (look at its terminal first: a message not proven may still
be in the program's input box). Control keys in a message (Ctrl-C, Ctrl-D,
Escape) are left out; tabs and line breaks stay.

**Nothing goes into a prompt.** Just before it types, Agent Terminals reads
the transcript again: while a tool call or an approval prompt is open, the
message waits, and says why. While one is open after a message was typed
(with `typeWhileWorking` on, a job can ask for approval after the message
went in), no key is pressed, not even Enter again, and the wait for proof
pauses until the call ends. Answer the prompt in its terminal; the message
is read after it.

**After a restart.** With `resumeAfterRestart` on, each agent that was
running starts again in a new terminal with the same id and resumes its
conversation (or, with none yet, starts again under its id, or anew for a
`subcommand` program whose id was never read). *What happened* says
*Started … again after DSH restarted*, and why, once the program holds
(its screen settles and it still runs); a program that ends at once is
*Could not start … again after DSH restarted* instead, with what it
printed last (*It exited with code 1: “…”*), and after a resume that
failed that way its card offers **Start anew** too. A `plain` program is
not started again, since it cannot resume, and its card says so. A start
that fails after a restart (a setting this DSH cannot do, say) says why on
its card and is tried again the next time DSH starts; **Start again**
tries now. Switching Agent Terminals off and on, or saving its settings, leaves
running agents running: it picks them up where they are (a job a restart
cut off stays cut off), and a message it typed just before still gets its
proof.

**A message DSH quit on.** A message typed in that the program had not read
yet (its Enter swallowed, or kept while it worked, with `typeWhileWorking`
on) sat in the input line of the program that ended. If the transcript
does not show it, it is typed in again, once, when the agent runs again
(after **Start again**, if the agent is not started again by itself), and
proven as usual. Lost to a second restart before it was read, it is
*failed*, with why: send it again (an answer's question comes back in
Decisions).

**A job cut off by a restart.** The program that resumes writes nothing
until it gets a message, so a tool call, an approval prompt or a request
left open in its transcript by the old program would hold the agent as
*working* or *waiting on you* for ever. Agent Terminals reads the
transcript before each start: whatever was open then is over. The agent
reads *idle*, any question it left in Decisions goes away, held messages
go in once, and *What happened* says which job was cut off and that a
message carries on: once, however many restarts follow before the next
message.

**While Agent Terminals is switched off or waits for a setting.** Nobody
follows the agents then, but they keep running in their terminals. With
`enabled: false` in the profile or a wrong setting, its page still lists
them: each card says *running*, not followed, and why (switched off in the
profile, or which setting to fix), and offers only **Open its terminal**,
which still opens its session with its terminal tab; nothing can be
started, and their session rows show no mark (nothing follows them to say
what they do). Switched off in Plugins, or with Session Watch off, it does
nothing at all: its marks leave the rows, and the agents keep running.
*What happened* says when it stopped following its agents and why, from
DSH's own state as it stopped (it was switched off; its settings changed
in DSH's profile; Session Watch stopped; DSH's terminals stopped; DSH is
quitting, which ends the agents' terminals too), and when it followed them
again and why (it started with DSH; it was switched on; DSH started it
again with the profile's settings; Session Watch or DSH's terminals are
running now), picking each up where it was: the same terminal and
program, nothing typed twice.

**Closing its tab ends it.** Closing an agent's terminal tab closes the
terminal, which ends the program in it. Its card says so, and **Start
again** brings it back in a new terminal and tab, resuming its
conversation where it has one. **Stop** on the page does the same as
closing the tab, and *What happened* says who stopped it.

## The page

**Coding agents** in DSH's sidebar, with a count of agents waiting on you:

- **The header**: how many agents run, how many of those wait on you, and
  how many are stopped (*3 running, 2 of them waiting on you · 1
  stopped*), **Start a coding agent** and **Settings**.
- **Agents**: each with its state, its name (one click opens its session),
  its program's name (the whole command on hover) and folder and when it
  started; what it does now; what it
  asks you, with **Go with the recommendation**, or **Open its terminal**
  when its terminal asks; its last reply; its messages with their states
  and why (the newest four, then **Show all**); a message box; and **Its
  screen now**, what its terminal shows. While it runs: **Open its
  terminal** and **Stop**. Stopped: **Start again** (its card says what it
  does: resume its conversation, start it again under its id, or run it
  anew), **Start anew** (a new conversation; offered only where there is
  one to resume) and **Forget**, which asks first (**Forget it** takes it
  off the list and closes its messages not typed in; its session and its
  own conversation files stay; **Keep it** changes nothing). A line under
  the list follows your last message: typed in, delivered, or not proven
  with where to look.
- **Start a coding agent**: the programs found on this computer and the
  ones used here before (one click fills the form; each once, with its
  conversations folder when it is not the default one), then Program,
  Arguments, How it resumes a conversation, Its conversations folder, Where
  it works (a new session in a folder, or the session whose menu you came
  from), Name and First message.
- **What happened**, newest first: starts and stops, restarts, each
  session's first turn, each message and whether it was proven read,
  questions to you, and each change of its settings, each with why.

Its cards are glass, in DSH's own colours: with Wallpaper on, each one
stands on the reading glass (Wallpaper's tint + .2), so its small text
never sits on the plain tint.

When it cannot work, the page says why and what to do, with a button to
the place to do it: *Agent Terminals needs Session Watch, which is not
running*, *Agent Terminals is waiting for a setting to be fixed* (which
setting, what it must be, and where to change it), switched off in the
profile, or DSH's terminals not running. It comes back by itself once the
cause is gone.

## On a session's row

- **A mark** in the row's leading seat (none while nobody follows the
  agents): DSH's state dot while the agent
  works or waits on you, a terminal glyph when it is idle, only running
  (no transcript) or stopped, and
  its state in words for screen readers. When another plugin's mark comes
  first, Agent Terminals leaves the seat to it and says its state in words
  only.
- **A hover line**: *Coding agent in its terminal: idle* (or its state),
  and what it last did. DSH's own state for the session (its model's
  turns) stays beside it.
- **The ⋯ menu**: **Open the coding agent's terminal** while it runs,
  **Show its coding agent** when it is stopped, and **Start a coding agent
  here** for a session without one.
- **Its terminal tab**: opening the session opens the agent's terminal tab
  beside it, once per agent and window (`openTabs`), and **Open its
  terminal** brings that tab to the front.

## Settings

Plugins → Agent Terminals shows the settings you can change while it runs,
in DSH's own settings form: change them, then **Save**. They apply at once,
and *What happened* notes each save. The form will not save a value out of
range and says what fits. An edit of DSH's profile is noted too, once, when
Agent Terminals starts with it: *Settings changed in DSH's profile: “How
messages are typed in”*, and why (it started again with them, it is
switched off there, or which one is wrong).

| Setting | Default | Range | Where | What it does |
| --- | --- | --- | --- | --- |
| `resumeAfterRestart` (Start agents again after DSH restarts) | on | on or off | Plugins | Each agent that was running starts again, resuming its conversation where its program can. |
| `listNewSessions` (List a new agent's session in the sidebar) | on | on or off | Plugins | A new agent's session gets one short turn by its model, so DSH lists it. |
| `openTabs` (Open an agent's terminal tab with its session) | on | on or off | Plugins | Opening an agent's session opens its terminal tab beside it, once per agent and window. |
| `typeWhileWorking` (Type messages in while the agent works) | off | on or off | Plugins | Off: a message waits until the agent is idle. On: it is typed in while the agent works, and the program keeps it. Either way, no key is pressed while a tool call or an approval prompt is open. |
| `proofSeconds` (Seconds without proof before Enter is pressed again) | `8` | 2 to 120 | Plugins | How long an idle agent has to show a message in its transcript. |
| `enterRetries` (Press Enter again, at most) | `2` | 0 to 5 | Plugins | For programs that swallow the Enter after a paste. |
| `askAfterSeconds` (Seconds before a waiting tool call counts as asking you) | `20` | 5 to 600 | Plugins | A tool call that waits this long for its result most likely waits for your approval in its terminal. |
| `notify` (A notification when an agent waits on you) | on | on or off | Plugins | Through DSH's notifications, while that plugin runs. |
| `typing` (How messages are typed in) | `auto` | `auto`, `direct` or `attached` | Profile | `auto` types straight into the terminal's program, and where a DSH does not let it, through DSH's terminal input. `attached` always uses that input (DSH 0.2.0 has one for plugins): Agent Terminals takes the terminal's keyboard for a moment and gives it back to your tab. On a DSH without it, no agent starts, and each says to set `auto`. |
| `enabled` | `true` | `true` or `false` | Profile | `false` keeps Agent Terminals loaded but idle: it starts, reads and types nothing, and its page says so and how to change it. |

*Profile* settings go in the `agent-terminals` row of the profile's
`cordis.patch.yml` (see Setup). DSH applies the file when you save it:
Agent Terminals starts again with them, with no restart of DSH, and picks
up its agents where they are. A wrong value there, of the wrong type too (a number in quotes such as
`proofSeconds: "8"`, or `yes` for a switch), never stops Agent Terminals
from starting: every key of its schema takes any value, its own check
names the setting and the value as the profile has it, and it starts no agent and
types nothing, agents already running keep running unfollowed and say so,
and the page says which setting is wrong, what it must be, and where to
change it. Fixed, it picks the agents up where they are.

## Files

In DSH's data folder (`$DSH_HOME`, else `~/.dsh`), folder mode 700, files
mode 600:

| File | What |
| --- | --- |
| `agent-terminals/state.json` | The agents: program, arguments, way of resuming, folder, session, terminal id, conversation id, whether you want it running, why it last ended, the job a restart cut last (so it is logged once), and its last 30 messages; the six programs used most recently; and the settings it last ran with (so an edit of DSH's profile is noted once, when it starts with it). |
| `agent-terminals/events.jsonl` | *What happened*; it keeps the last 400 entries and rewrites itself past 1 MB. |

Agent Terminals only reads a program's own conversation files; it never
writes to them.

## Setup

1. Install Session Watch and Agent Terminals (and Decisions, for its
   cards) as in the [root README](../../README.md#install-a-plugin):

   ```bash
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/session-watch
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/agent-terminals
   ```

   That adds `dsh-plugin-session-watch` and `dsh-plugin-agent-terminals` to
   the profile's `package.json` (`dependencies` and `dsh.profile.bundles`).
   Their bundles add their rows (`id: session-watch`, `id: agent-terminals`).

2. To change a default before the first start, address the row in the
   profile's `cordis.patch.yml` (the ones marked Plugins above can also be
   changed later in Plugins → Agent Terminals):

   ```yaml
   - id: agent-terminals
     config:
       typeWhileWorking: true
       askAfterSeconds: 30
   ```

3. Restart DSH Desktop once so it loads the new bundles. Then open
   **Coding agents** in the sidebar and start one.

## Switching it off

- **One agent**: **Stop** on its card (or close its terminal tab), or
  **Forget** to drop it from the list.
- **Entirely**: Plugins → Agent Terminals → off. Its page, marks and menu
  items go, and it leaves other plugins' views as they were. An agent
  running then keeps running in its terminal, untended; switched on again,
  Agent Terminals picks it up where it is. (`enabled: false` in the profile
  instead keeps its page, which says it is off and how to turn it back on,
  lists the agents that still run, not followed, and refuses its actions in
  words.)
- **With Session Watch**: Plugins → Session Watch → off also stops Agent
  Terminals, with no error from DSH: its page says it needs Session Watch,
  and it starts again by itself when Session Watch does.

## Rollback

DSH runs Agent Terminals from its folder in your clone (the profile links
it). To go back to a release, restore that folder from the release's tag
and restart DSH Desktop:

```bash
git -C ~/.dsh-plugins/dsh-public-plugins restore --source agent-terminals-v1.0.0 -- plugins/agent-terminals
```

To remove it, stop its agents first (or they stay in their terminals until
DSH quits), then follow [Remove a plugin](../../README.md#remove-a-plugin)
for `dsh-plugin-agent-terminals` (row `agent-terminals`), and delete
`agent-terminals/` in DSH's data folder to forget its agents and its log.
The agents' sessions stay in DSH, and their programs keep their own
conversations, so you can resume one by hand.

## Limits

- One agent per session; start another in a new session.
- DSH's terminal needs a POSIX shell (zsh or bash; sh, dash and ksh work
  too) to start the program.
- A session holds as many terminals as DSH allows; past that, a start says
  to close one of its terminal tabs.
- Proof needs a transcript: for `continue` and `plain` programs, a message
  is typed in, not proven read.
- A `continue` program resumes its folder's latest conversation, whatever
  started it; a program of that kind that has none may refuse to start, and
  its card then shows what it printed.
- It leans on parts of DSH that are not a plugin interface. The direct way
  of typing uses the terminal controller's own terminals (their owners,
  handle and screen modes), and the page reads DSH's
  `dsh.terminal.binding.v1.` window storage to find a session's terminal
  tab. The real-DSH test covers every build here (0.2.0, 0.2.1 and the
  app's own); a later DSH can break either without notice. When the direct
  way is not there, `auto` types through DSH's terminal input instead, and
  the test above is the way to check a new build.

## Tests

From the repository root:

```sh
node --test test/agent-terminals.test.js test/agent-terminals-client.test.js   # the engine over a stand-in DSH and a real stand-in agent; the page
node scripts/e2e.mjs agent-terminals                                           # real DSH in a throwaway home, on every DSH build here
```

The real-DSH test (173 checks, four to ten minutes a build here, with the Mac's load) starts DSH from
each `.e2e/dsh-<version>` install and from the installed app's own DSH, each in a throwaway home with a throwaway
home folder for its shell, with Session Watch, Decisions, Agent Terminals
and a stand-in neighbour plugin that draws in the same places. Stand-in
coding agents (`test/e2e/fake-agent.mjs`) keep transcripts in the `flags`
and `subcommand` ways, or none. It finds them by the conversations they
kept; refuses bad starts in words; starts an agent in a new session (named
after it, listed by one turn of its model) and proves its first message
from its transcript; holds the next message while the agent works and
takes one back; pastes two lines as one message; presses Enter again for a
program that swallows it; carries a question to Decisions and types the
recommendation and an answer in your words back in (Decisions turns the
answer *delivered* from the transcript's proof); types to a program with no
transcript (typed in, not proven); refuses a program path that is not
there before any session is made, says how to fix a program name the
shell cannot find (*Could not start*, no first turn, not offered again),
and starts a program given as `~/…`. With
`typeWhileWorking` on and a job that asks for approval after the message
went in, it presses no Enter into the prompt, and the message is read once
the prompt is answered in the terminal. In a browser, light and dark, wide
and narrow, it
checks the page; pictures it with a Wallpaper stand-in (Wallpaper's values
on the page and its glass on DSH's sidebar and dock) over a light and a
dark picture at tint .2, and with Wallpaper off; checks that every card
stands on tint + .2 there; and measures the page's small text (4.5:1 or
more with Wallpaper off, and for its secondary text over a mid picture at
tint .2; the lowest over each picture's far end is logged); then the row's mark, hover line and menu beside a neighbour's
(which keeps its seat), the terminal tab beside the session, a tool call
answered in that tab (the held message goes in after), a start from the
page with a found program, Stop, Start again, Start anew and Forget (it
asks first; Keep it changes nothing),
closing a tab (the agent ends; Start again brings it back), **Start a
coding agent here**, a setting saved in Plugins that applies at once, and
a wrong value saved while DSH runs (the agents keep running, read *not
followed*, offer only **Open its terminal**, and are picked up where they
are once it is fixed). An agent started without a message is stopped,
started again, has its tab closed and is started again: each time it comes
back running and idle under its id, never with a resume its program would
refuse, and its card offers no **Start anew**. A `continue` stand-in is
typed to. It restarts DSH (agents resume under the same terminal id, each
logged as started again once it holds; the agent without a message starts
again under its id;
the `continue` one is resumed with `--continue`; a `plain` one says why it
was not started again; a session's first turn the restart cut is settled,
not left *sending*, and the session is listed; the window's tab shows the
resumed agent), restarts it again in the middle of a job and
of an approval prompt (both agents come back idle, each cut job is logged
once, the held messages go in once and are proven, no question is left in
Decisions), restarts it while a message typed during a job and an answer
whose Enter was swallowed wait for their proof (each is typed in again once
and proven; Decisions hears the answer delivered), picks agents up after a
restart cut a job and an approval prompt (restarted twice in a row: each
cut job is logged once; then a wrong setting saved and fixed: both stay
idle, hold nothing and leave nothing in Decisions), types through DSH's
terminal input on 0.2.0 and checks the words on later builds, starts DSH
with a number in quotes in the profile (`proofSeconds: "8"`: named on the
page with its value, the form flags it as it opens, and typed without its
quotes one **Save** stores the number and brings the agents back),
switches Session Watch off in the profile, checks `enabled: false` and the
file modes; while DSH runs, it switches Session Watch off and on, then
Agent Terminals itself (as the Plugins switch writes it, beside the
neighbour, whose mark stays), then `enabled: false` and back: each time
the agent keeps running (the same process), *What happened* names the
cause both ways, the not-followed card still opens the terminal, and the
agent is picked up in place with nothing typed twice; a DSH restart is
logged as DSH quitting and starting it; sets `enabled` back to true in the profile while DSH runs (DSH
applies it with no restart, *What happened* says what the edit changed,
and the agents it ended start again, resumed),
and ends every process it started. Every quit of DSH in the
run must end by itself within its grace (20 s), never by a kill, and the
window must log no error from the suite's browser halves (DSH's own
errors are printed, not counted). It reads
the running DSH's fingerprint before and after and fails if it moved;
pictures go to `.e2e/shots/agent-terminals/<version>/`.

The unit tests (`test/agent-terminals.test.js`) run the engine over a
stand-in DSH terminal controller whose shell really starts the stand-in
agent: among them, an agent without a message through Stop, a closed
terminal and a restart; a program that fails as it starts again after a
restart (logged as not started, with what it printed); three restarts in a
row after a cut job (logged once); the log entries an earlier run left
open; Forget closing an agent's messages; **Send again**; a wrong type
for every setting, named with its value; an edit of DSH's profile,
said once at the start that has it; the same words sent twice (each needs
its own transcript line, the oldest first, through a restart too); the
listing note and its replies read by Session Watch's own `askIn` (none
asks); the cause of each stop and start of following, from stand-ins of
DSH's parts; and an agent that still runs under `enabled: false`, listed
on the page, not followed. The page's own tests
(`test/agent-terminals-client.test.js`) draw its parts as plain element
trees: among them, every card on the reading glass, the cards under
`enabled: false`, the row's mark and hover card, and the terminal tabs.
