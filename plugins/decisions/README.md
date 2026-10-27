# Decisions

One inbox for everything waiting on you. When a session needs you (a
decision line at the end of a reply, a tool waiting for approval, a
question in DSH's question box, a thread that handed back needing a
decision, a plugin's question), it shows here as a card: what is asked,
what the agent recommends, which session (one click opens it) and how long
it has waited. Answer on the card and the answer goes into the session: it
steers a running turn, starts the next turn of an idle one, or settles the
approval or question DSH is holding. The session's own log proves it
arrived, and the card says so, or says why not.

It needs Session Watch (it reads every session through it). While Session
Watch is off, Decisions stays on but lists and holds nothing (DSH's own
cards work as always), and its page says so; switching Session Watch off in
Plugins reports no error, and Decisions comes back by itself once Session
Watch runs again. With the notifications plugin running, each new card
also notifies you outside the window.

## What it lists

| Card | Where it comes from | Answer it with | Proven by |
| --- | --- | --- | --- |
| **Needs a decision** | A reply with a `DECISION NEEDED: <question> — recommend: <your pick>` marker (see below) | Your own words, or **Go with the recommendation** | The answer read into a turn of that session |
| **Blocked** | A reply with a `BLOCKED: <what is needed>` marker; the card reads *Blocked on: <what is needed>* | Your own words | As above |
| **Asked you** | A reply that ends by asking you something (`replies`) | Your own words | As above |
| **Waiting for approval** | A tool that asks to run with more access (`approvals`) | **Allow once** or **Reject** | The tool's call in the session's log: it ran, or it was rejected |
| **Asks you** (question box) | A question the agent asks in DSH's question box (`questions`) | Its choices, and your own words where it allows them | The tool's result in the session's log (on a DSH that does not name the call with the question, the call the session's state says it waits on) |
| **Needs a decision** (thread) | A coordinator's thread that handed back needing a decision, or blocked (`threads`) | Your own words, sent to the thread | As for replies |
| **Asks you** (a plugin) | A suite plugin's question, such as Autopilot's Ask first | The plugin's own choices | The plugin carries it out and logs it on its own page |

A running turn's cards come first (a tool or a question holds it), then the
oldest. A card's wait counts from when Decisions first saw it: a restart,
or a plugin raising the same question again, does not start it over.

One decision makes one card. A thread's handback, the thread's own last
reply, and the coordinating chat's reply to that handback (the chat relays
it to you) are one card, the thread's, one per thread turn: from its first
sight, whichever comes first. A thread's question in a turn that handed
back shows at once, and when its chat takes the handback later (a chat
busy in a turn of its own takes it when that turn ends), the same card
shows the handback's words: one *new* line in *What happened*, one note
elsewhere, one wait, and the pick the thread's reply gave stays. The
coordinator notifies you of a handback itself, so Decisions does not. A
thread's question in a turn that did not hand back is listed after five
seconds, and Decisions notifies you of it (the coordinator nudges such a
thread to hand back at once, and the handback that follows is the card).
A recommendation in any of them shows under *Recommended*, with
**Go with the recommendation**, and a link in the question
(`[Port pick](.dsh-thread/t1)`, also one whose address holds brackets)
reads as its words. A handback reads in plain words, every line of it,
as a reply's lines do (bold and code marks dropped, a code span's words
whole: `` `release/v2` or **rel-2** `` reads "release/v2 or rel-2").
Its pick counts wherever it is said (`Recommend 9090 for the status page.`,
`9090 (recommended)`), and a handback that asks no question is headed
*The thread needs your decision:* (or *The thread is blocked:*). An
approval or a question from inside a thread says whose thread it is (*in a
thread of “Release”*). Once the thread's card is answered (here or in the
thread), the chat's relay of that question does not come back as a card
of its own, also after a restart; a new question in the chat does. A reply
that only offers more ("Let me know if you'd like me to update the docs")
asks nothing, so it is not listed. A subagent's replies are left out: the
session that started it reads them. A reply's question leaves the list
after `windowHours`; the session still has it.

**How a marker is read.** A `DECISION NEEDED:` or `BLOCKED:` marker counts
at the start of any line of a reply, after a quote mark, a bullet, a list
number or a heading mark (bold and code marks are dropped first; what a
code span holds stays as written, so `__init__.py`, `my__var` and `a**b`
keep their marks in the question, the pick and the lines, and a dash in
one, as in `--force`, is not the dash before the pick; a marker line
written whole in code counts as one). In the reply's last six lines it
also counts right after the end of a sentence: "…so I cannot go on
without valid credentials. BLOCKED: working staging credentials." A
marker inside a sentence ("the request was BLOCKED: by policy") is not
one, and a line inside a fenced code block (```` ``` ```` or `~~~`) is
shown, not said: a marker, a question or a recommendation there counts
for nothing, so a rule quoted from a rules file makes no card and gives
no pick (its code still shows among the lines before the question).
`DECISION NEEDED` is read in any case, `BLOCKED` only in capitals; with
both, the decision wins. The recommendation follows the
question after a dash (`— recommend: …`, or `— recommend …` without the
colon), in a sentence of its own (`Recommend: …`, `I'd recommend …`, `My
recommendation: …`), or on the next line (`Recommend: …`). A reply
without a marker that ends by asking you something shows its last
question, or else its last line that asks for your word. A sentence ends
at a full stop, ! or ? followed by a space and a capital letter (or a
quote, a bracket or a mark), never inside a code span: so a dot in a file
name (`parser.py`), a version (`v1.2`, 2.0.0), an address, a number (2.5)
or "e.g." ends nothing, and "I found two failing tests. Should I fix the
bug in `parser.py` first?" gives *Should I fix the bug in parser.py
first?*, in plain words like its lines. A question that leans on the one
before it keeps that one ("Should I merge now? Or wait for the review?"
reads whole). Its card also
carries the reply's lines just before the question (up to four lines or
400 characters, folded after two), so a list of choices comes with "Which
one do you prefer?" and you can answer in place;
a pick the reply states there shows under *Recommended*, in its own words
without its reason: "I would recommend **release/v2** because the prefix
is the convention" gives *release/v2* (a bold or code span the pick starts
with), "Recommendation: 9090, as it is unused" gives *9090* (it ends at
*because*, *since*, *, as*, *, which*, *: …* or a dash), a dot inside a
word (`v2.0`) does not end it, and a longer one is cut at a word, with
"…". A card keeps all this through a restart: for a session DSH has not
loaded, Decisions reads the reply once from the session's log (its saved
state leaves the text out), and a card that came meanwhile is announced
once its lines are read.

**How answers reach the session.** Words go in as the session's next
message, starting `[Decisions] The person answered …` and quoting the
question; a running turn reads them at its next step. Allow once and Reject
go to DSH as its own approval card's answer would, and so does an answer to
a question in the question box. A question whose wait ran out (a profile
that runs the question box in its timed mode) still takes a late answer,
through DSH's question service. A plugin's question goes back to the
plugin.

**Holding DSH's own requests.** For approvals and the question box,
Decisions sits first in DSH's chain for that request: it makes the card and
passes the request on at once, so DSH's own card shows in the session as
always. Answer in either place; the first answer wins, and the other card
goes. Decisions never answers on anyone's behalf: when no window answers
and the turn stops, DSH's own outcome stands. A kind switched off, a wrong
setting or any failure passes the request on untouched. A tool that asked
before Decisions started can only be answered in the session; its card
says so and opens it. A request Decisions was holding when it stopped, or
when its kind was switched off, goes back to DSH's own card: *What
happened* says so and why (*Handed back to the session's own card*), and
if it still waits when Decisions lists it again, its card says it was
handed back, still first in the list, with a button to the session.

## The page

**Decisions** in DSH's sidebar, with a count of what waits on you:

- **The header**: what waits and what Decisions lists, whether it notifies
  you (with **Open Notifications in Plugins** when that plugin is
  installed but not running; *not running: it is not installed* when it
  is not there), and where else new cards go (with **Send a test**, or
  what is missing and where to change it). How a test went is said under
  its button (*Test message sent to …*, or *Not sent: …* as an alert),
  and the focus stays on the button; a success is said for a minute,
  and neither is said again once the page has had to say why it cannot
  work (nor is an action that failed meanwhile, *Not done: …*). When the
  last new card could not be sent there, it says so, with the reason and
  when.
- **Waiting on you**: each card with its state word (*needs a decision*,
  *blocked*, *waiting for approval*, *asks you*, *asked you*), the session
  (one click opens it), how long it has waited, the question, the
  recommendation, and the controls its kind takes; an answer box is one
  line until you click into it. **Dismiss** hides a card without answering
  it: a session that still waits still waits in the session. After you
  answer, a line says what your answer did and keeps it true (*waits in
  its queue* until the session reads it, then *Your answer reached …*). A
  failed answer stays on its card with the reason, and the card takes the
  focus.
- **Dismissed**, with **Bring back**.
- **What happened**, newest first: new cards; your answers and whether the
  session got them (*in the queue*, *delivered*, *answered*, *not
  delivered* with the reason); each notification (*shown*, and where, or
  *not shown* and why, said once an hour while the reason stays the same);
  each note sent elsewhere (*Sent to* the host or program, or *Not sent to*
  it, with its answer); what became of a request Decisions was holding
  when it was answered in the session, or when a restart or a stop ended
  its turn first (*The turn stopped before anyone answered*), or that it
  handed back to the session's own card; and each change of its settings,
  the webhook address set or removed included (named by its key, never
  the address).

When nothing waits, the page says what would show there (only the kinds
it lists). A card that has waited two days or more says so in days. When Decisions
cannot work, the page says why and what to do, with a button to the place
to do it: *Decisions needs Session Watch, which is not running*, *Decisions
is not running*, or *Decisions is waiting for a setting to be fixed* (which
setting, what it must be, and where to change it). It comes back by itself
once the cause is gone. A wrong setting of Session Watch's own (it then
works on with its default) is named in the header, with **Open Session
Watch's settings**, which puts the cursor in it.

## Settings

Plugins → Decisions shows the settings you can change while it runs, in
DSH's own settings form: change them, then **Save**. They apply at once,
and *What happened* notes each save. A kind switched off leaves the list,
and the requests Decisions was holding for it go back to DSH's own card
alone. The form will not save a value out of range and says what fits; a
value saved in the profile that does not fit is flagged as soon as the form
opens (a number saved in quotes shows in its quotes: *It is saved as text,
in quotes. Type a whole number from 1 to 720, without the quotes, then
save.*, and typed without them one **Save** stores the number), and
**Open Decisions' settings** on its page puts the cursor in it
(for a choice with no valid value, on its first choice; the arrow keys go
on from there). An error names the choice as the form shows it, with the
value the profile holds: *must be Nowhere ("off"), Webhook ("webhook") or
Command ("command")*.

| Setting | Default | Range | Where | What it does |
| --- | --- | --- | --- | --- |
| `approvals` (Tools waiting for approval) | on | on or off | Plugins | List tools that ask to run with more access, with Allow once and Reject. |
| `questions` (Questions in the question box) | on | on or off | Plugins | List the agent's questions in DSH's question box, with their choices. |
| `replies` (Replies that end with a question) | on | on or off | Plugins | List a reply that ends by asking you something. Replies with a `DECISION NEEDED` or `BLOCKED` marker are listed whatever this says. |
| `threads` (Threads that need a decision) | on | on or off | Plugins | List a coordinator's thread that handed back needing a decision, or blocked. |
| `windowHours` (Keep a reply's question for) | `72` | 1 to 720 hours | Plugins | An older reply's question leaves the list. |
| `notify` (A notification for each new card) | on | on or off | Plugins | Through DSH's notifications, while that plugin runs. A plugin's own questions notify through that plugin. |
| `mirror` (Also send new cards to) | `off` | Nowhere (`off`), Webhook (`webhook`) or Command (`command`) | Plugins | A short note for each new card, sent elsewhere (see below). |
| Webhook address | none | `https://…`, or `http://` to this machine | Plugins | Kept in DSH's key store, never in the settings file. |
| `mirrorPerHour` (Messages sent an hour, at most) | `30` | 1 to 500 | Plugins | Counts the notes that went (not failures), across restarts. Past it, Decisions holds back and says so once; it still lists everything. |
| `mirrorUrlEnv` | `DECISIONS_WEBHOOK_URL` | a key name | Profile | The key in DSH's key store (or the environment DSH starts in) that holds the webhook address. |
| `mirrorCommand` | none | the program's full path, then its arguments | Profile | The command `command` runs. Checked only while `mirror` is `command`; a wrong one (or a program that is not there) stops only the sending, and the page's line says what is wrong and where to change it. |
| `enabled` | `true` | `true` or `false` | Profile | `false` keeps Decisions loaded but idle: it lists and holds nothing, and its page says so and how to change it. |

*Profile* settings go in the `decisions` row of the profile's
`cordis.patch.yml` (see Setup). DSH reads the file again when you save it
and applies them then (Decisions starts again with them), and *What
happened* says which settings changed (*Settings changed in DSH's profile:
“The command”*), and what is wrong when one is; `enabled` is said as what
it did (*Switched off in DSH's profile (enabled: false)*, *paused*, and
*Switched on again in DSH's profile (enabled: true)*). A wrong value
there never stops Decisions from starting: it lists and holds nothing, and
its page says which setting is wrong, what it must be, and where to change
it.

### Sending new cards elsewhere

Off by default. Each new card can also go, as a short note (what waits and
where, the question, the recommendation, and "Answer it in DSH:
Decisions."), to:

- **A webhook**: a POST of `{"content": "…"}`, the shape a Discord channel
  webhook takes, with mentions switched off so an agent's text can never
  ping anyone. The address must be `https://` (or `http://` to this
  machine, for a local sink). Enter it in the **Webhook address** field in
  Plugins → Decisions: it goes to DSH's key store under `mirrorUrlEnv`, is
  read again for each message, and is never written to the settings file
  or a log. A webhook address set in the environment DSH starts in works
  too, and the field says so.
- **A command**: `mirrorCommand` in the profile, the program's full path
  then its arguments, run without a shell, with the card as one line of
  JSON on its input (`text`, `kind`, `title`, `question`, `context`,
  `recommendation`, `sessionId`). It has 15 seconds. The page and the log
  name it by its program, or by its script when the program is a shell or
  an interpreter (`[/bin/sh, /Users/me/bin/cmdsink.sh]` is *cmdsink.sh*).

```yaml
- id: decisions
  config:
    mirror: command
    mirrorCommand: [/usr/local/bin/notify-me, --from, dsh]
```

Every send and every failure goes in *What happened*, naming the host or
the program, never the address. **Send a test** on the page sends one now.
When nothing can be sent (no address yet, a program that is not there),
that is said once an hour, or when the reason changes, not for every card;
so is the hourly limit (*Held back new cards: 30 went to the webhook at
… in the last hour*). These once-an-hour notes are kept in its state, so
a restart does not say them again.

## Files

In DSH's data folder (`$DSH_HOME`, else `~/.dsh`), folder mode 700, files
mode 600:

| File | What |
| --- | --- |
| `decisions/state.json` | The cards already announced and when each was first seen (so a restart notifies nothing twice and keeps each wait), what you dismissed and answered, the requests it is holding (so after a restart it can say what became of them), the threads' handbacks it has seen (so a chat's relay of one you answered stays folded), when the last hour's notes went elsewhere, when each once-an-hour note was last said, and a short hash of each setting as it last ran (so its log can say what an edit of the profile changed; no value is kept). |
| `decisions/events.jsonl` | *What happened*; it keeps the last 400 entries and rewrites itself past 1 MB. |

On the first start, what already waits is listed but not announced.

## Setup

1. Install Session Watch and Decisions as in the
   [root README](../../README.md#install-a-plugin):

   ```bash
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/session-watch
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/decisions
   ```

   That adds `dsh-plugin-session-watch` and `dsh-plugin-decisions` to the
   profile's `package.json` (`dependencies` and `dsh.profile.bundles`).
   Their bundles add their rows (`id: session-watch`, `id: decisions`).

2. To change a default before the first start, address the row in the
   profile's `cordis.patch.yml` (the ones marked Plugins above can also be
   changed later in Plugins → Decisions):

   ```yaml
   - id: decisions
     config:
       replies: false
       windowHours: 24
   ```

3. Restart DSH Desktop once so it loads the new bundles.

Agents write decision lines on their own when their instructions ask for
it, for example: "If you stop for anything a person must decide, end with
one line: `DECISION NEEDED: <question> — recommend: <your pick>`."
Autopilot's notes ask for the same line.

## Switching it off

- **One kind of card**: its switch in Plugins → Decisions. Its held
  requests go back to DSH's own card alone.
- **Entirely**: Plugins → Decisions → off. Its sidebar entry and page go,
  every held request goes back to DSH's own card, and it leaves no marks in
  other plugins' views. (`enabled: false` in the profile instead keeps its
  page, which says it is off and how to turn it back on, and refuses its
  actions in words.)
- **With Session Watch**: Plugins → Session Watch → off also stops
  Decisions, with no error from DSH: Decisions stays on in Plugins, its
  page says it needs Session Watch, and it starts again by itself when
  Session Watch does.

## Rollback

DSH runs Decisions from its folder in your clone (the profile links it). To
go back to a release, restore that folder from the release's tag and
restart DSH Desktop:

```bash
git -C ~/.dsh-plugins/dsh-public-plugins restore --source decisions-v1.0.0 -- plugins/decisions
```

To remove it, follow [Remove a plugin](../../README.md#remove-a-plugin) for
`dsh-plugin-decisions` (row `decisions`), and delete `decisions/` in DSH's
data folder to forget what it announced and its log. To forget the webhook
address too, press **Remove the address** in Plugins → Decisions first, or
remove the key `DECISIONS_WEBHOOK_URL` in DSH's key store. Nothing else
needs undoing: the answers it sent stay in their sessions' logs.

## Tests

From the repository root:

```sh
node --test test/decisions.test.js test/decisions-client.test.js   # the card rules, holds, inbox and mirror over a stand-in DSH; the page
node --test test/suite-shared.test.js                              # the suite's shared words: how a marker and a question are read
node scripts/e2e.mjs decisions                                     # real DSH in a throwaway home, on every DSH build here
```

The real-DSH test starts DSH from each `.e2e/dsh-<version>` install and
from the installed app's own DSH, each in a throwaway home, with Session
Watch, Autopilot and Decisions, a scripted model playing the agent, and a
stand-in window that gets DSH's own prompts. From real sessions it makes
decision, BLOCKED and question cards (markers at a line's start and inline
after a sentence), approvals, a question-box question and Autopilot's Ask
first, and answers each from Decisions: words and the recommendation read
into a turn, Allow once (the file is written) and Reject (it is not), an
approval answered in the window instead, a question-box answer as the
tool's result (checked in the session's log), and Autopilot's Ask first
carried out by Autopilot. With the coordinator loaded, a thread hands back
needing a decision and its chat relays it with a DECISION NEEDED line: one
card, the thread's; answered from Decisions, the answer goes into the
thread, and while the thread works on it neither card comes back and
nothing is announced. A second thread hands back while its chat is held in
a turn of its own, and its reply asks: the thread's card shows at once,
and when the chat takes the handback after its turn it is the same card
(same id, same wait, announced once, its Markdown read as plain words),
answered into the thread. A decision
line written `— recommend …` without the colon, with lines before it,
keeps its pick and its lines, also after the restart below. Questions in
a coding model's shapes keep their words: a plain question with a file
name in it, one with versions, and a decision line with `__init__.py` in
code, on the card, in its lines, its pick and its log, and in the answer
the session reads back (in words, and through Go with the
recommendation); a DECISION NEEDED line quoted in a fenced code block
makes no card and gives no pick, and the question after it is the card.
Notifications are covered by the unit tests over a stand-in DSH.

In a browser, the real-DSH test drives the page and its settings in
Plugins, light and dark, wide and narrow: the one-line answer box, the line
that says your answer reached the session, a kind switched off, the
webhook address kept in DSH's key store and never in a log (its setting and
removal noted by key), a test message and new cards sent to a stand-in
webhook on this machine, a failing webhook said as a failure in the log
and on the page, a failed **Send a test** said under its button with the
focus kept, a command instead, and Decisions switched off and on in
Plugins beside the coordinator (each keeps its own style sheet). It
restarts DSH with an approval waiting (nothing repeats, the log says the
turn stopped before anyone answered, and a waiting card keeps its lines and
its pick), starts DSH with a wrong type (`notify: 'yes'`) and with a number
in quotes (`windowHours: "72"`: named on the page with the value, flagged
in the form in its quotes, fixed with one **Save**, and the profile then
holds the number), sets a wrong value and fixes it in the form, starts
Session Watch with a number in quotes (named in Decisions' header, whose
button puts the cursor in Session Watch's field, flagged there; one
**Save** fixes it), switches Session Watch off and on in Plugins and in the
profile (while it is off, the open page asks no endpoint that is not
there), checks `enabled: false` (its log and its page say it was switched off),
sets it back to true in the profile while DSH runs (DSH applies the file,
and the log says it was switched on again), and checks the file modes.
It reads the running DSH's fingerprint before and after and fails if it
moved; pictures go to `.e2e/shots/decisions/<version>/` (or to the folder
in `SHOTS`).
