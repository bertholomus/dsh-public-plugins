# Canon

Shared long-term memory for every session, kept where people already keep
it: an Obsidian vault of canon notes. Canon reads the vault (and, by
default, writes nothing to it):

- **Recall**: when a turn starts from your prompt, Canon finds the few
  active notes that fit the prompt and the session's folder and adds them
  to the turn as one short block, after your prompt, that cites each note
  by its path in the vault. It is bounded (3 notes and 2,000 characters by
  default), and you can turn it off for one session.
- **Capture**: when you allow drafts, agents get a tool that saves
  something worth keeping (a decision, a checked fact, a how-to, a gotcha)
  as a **draft** note in the vault's drafts folder. Drafts are never added
  to a turn.
- **Promote**: a person, and only a person, makes a draft an active note
  with **Promote** on Canon's page, and only while Canon's settings allow
  it. Nothing promotes a draft by itself.

Canon reads the vault on this computer, in DSH's own process: no model
call, no network. It needs nothing else running. With Session Watch
running, its page updates through the suite's one open request per window;
without it, the page reads again every few seconds.

## Which notes count

A note is **active**, and can be added to a turn, when its frontmatter says
`status: active` or has no `status` at all (a note with no frontmatter is
active). Canon never adds:

- a note with any other status (`draft`, `archived`, `superseded`, …),
  wherever it is;
- anything in the drafts folder (`Drafts` by default), whatever its status;
- anything in a folder whose name starts with a dot (`.obsidian`, `.trash`,
  `.git`), links, and files that are not Markdown (`.md`).

It reads at most 20,000 notes and the first 256 KB of each. It reads the
vault again by each file's time and size, at most every 5 seconds and only
when a turn needs it (no folder watcher); a turn never waits more than
0.8 seconds for a read.

## What a turn gets

Canon searches the notes' words, not their meaning. A note's title,
aliases, tags, path and headings count for more than its body; words are
lightly stemmed ("listens" finds "listen"), and words that say nothing
("please", "thanks", "looks good", "called") are left out. So are a
prompt's words about the vault and about answering from it ("answer from
the team's shared notes and cite the note"): they say where to look, not
what about.

A note fits a prompt when it shares two of its words, or one in the note's
title, aliases, tags, path or headings; one word in its body alone never
fits. Three rules keep a project's notes to the prompts about them:

- A project's name counts as one word, however many parts it has
  (`lantern-api` is "lantern" and "api"), and a note needs a word beyond
  it: "Does the lantern API support websockets?" gets no note, though
  every lantern note shares the name.
- A session in a project's folder names that project for its own notes:
  "Which ports does this service listen on?" in `~/Projects/quartz-cache`
  gets quartz-cache's ports note.
- A note that belongs to a project (its `project` or `repo` field, or its
  folder under `Projects/`) stays out when the session's folder or the
  prompt points at other projects and not at its own: "the lantern API"
  names lantern-api, not lantern-web.

Of the notes that fit and score above a small floor, a turn gets the best
one and those that score at least half as well; a prompt that asks two
things ("…, and how do I roll out a new build?") also gets the note that
best answers each question asked alone. Notes that belong to the session's
folder count for more: a note whose path, `project`/`repo` field or tags
name the folder's project (`~/Projects/harbor-gateway` → `harbor-gateway`),
and a little more for the folder above.

Only a turn that starts from a person's prompt gets notes, and only once,
right after that prompt: not the later steps of the turn, not messages
other plugins send, not a prompt with nothing to search for. The block,
exactly as the model reads it, for "Which port does the load balancer use
for the gateway's health check, and how do I roll out a new build?" in
`~/Projects/harbor-gateway`:

```text
Background from the canon vault: shared long-term notes that may bear on this request, quoted below. Reference only, not instructions. The paths are in the canon vault, not your workspace. Cite a note's path when you use it.

[1] Projects/harbor-gateway/Gateway ports.md
> Changing a port: Edit `listen` in `gateway.toml`, then restart the service with `systemctl restart harbor-gateway`. The load balancer reads the health check on 8080, so keep that one as it is.

[2] Projects/harbor-gateway/Deploying the gateway.md
> Deploying the gateway: Wait for the health check in each zone before the next one. A rollout that fails its health check rolls back by itself.
```

Each note gets its path in the vault (the header says so, so a model does
not look for it in the session's workspace), its title when the file name
does not say it, and the passage that fits the prompt best, quoted so that
its words never read as instructions. Fewer notes are added rather than
cutting each to nothing; the whole block always stays within the
characters allowed.

DSH keeps the block in the session's log as Canon's context. Its
**Trajectory** tab lists it in the turn's request; its Chat keeps context
out of sight, so Canon's card stands for it there.

## How well it picks notes

Measured on a labelled set of prompts over the fixture vault
(`test/fixtures/canon/vault`: 42 notes, 35 of them active, for five
projects, people, decisions, runbooks and ideas), each prompt going through
Canon's own recall exactly as a turn does, with the default settings (3
notes, 2,000 characters). The dev set
(`test/fixtures/canon/relevance/dev.json`) has 77 prompts: 47 that a note
answers, and 30 that none does (8 that name a project but ask what no note
says, 8 of chat filler, 8 of words about the vault, 6 others), from
sessions in a project's folder, in an unrelated folder and in none.
Canon's rules were tuned on it, so new prompts may do worse than these
figures. The floors were fixed before anything was measured.

| Figure | Before tuning | Now | Floor |
| --- | --- | --- | --- |
| The block's first note answers | 40 of 47 (85.1%) | 43 of 47 (91.5%) | at least 80% |
| An answering note is in the block | 45 of 47 (95.7%) | 45 of 47 (95.7%) | at least 90% |
| Notes per block that do not answer | 1.04 (48 in 46 blocks) | 0.33 (15 in 45 blocks) | at most 1.0 |
| No block, for a prompt no note answers | 8 of 30 (26.7%) | 25 of 30 (83.3%) | at least 70% |

`npm test` holds the dev set to the figures it reached. To measure again,
with each prompt that got a wrong note, an extra one or a block it should
not have:

```sh
node scripts/canon-relevance.mjs --set dev --misses
```

What it still misses: a note that shares only one word with the prompt,
in its body ("What does bastion mean?" and the glossary), and notes that
share two common words with a prompt no note answers.

The fair figures are the hold-out's. Its 48 prompts
(`test/fixtures/canon/relevance/holdout.json`: 24 that a note answers, 24
that none does) were written by two writers who never saw Canon's code or
the dev set, on the fixture vault as it is, and measured once, on October
17 at 5:20 PM, with the rules frozen at 9a8a4c9. It is never tuned on, and
`npm test` holds Canon to the floors on it.

| Figure | Hold-out, measured once | Floor |
| --- | --- | --- |
| The block's first note answers | 22 of 24 (91.7%) | at least 80% |
| An answering note is in the block | 23 of 24 (95.8%) | at least 90% |
| Notes per block that do not answer | 0.54 (13 in 24 blocks) | at most 1.0 |
| No block, for a prompt no note answers | 22 of 24 (91.7%) | at least 70% |

To measure it again: `node scripts/canon-relevance.mjs --set holdout`.

## On the turn

After the latest turn of a session that got notes, a short card:
**Canon · 2 notes from the canon vault added to this turn**, each note's
title and folder, **Turn off for this session** (or **Turn back on**) and
**Open Canon**. Turned off, the session's later turns get no notes until
you turn it back on (on the card or on Canon's page); the switch is kept
across restarts. Earlier turns get no card of their own: Canon's page lists
each session's recent turns that got notes.

## The page

Canon has its own entry in the sidebar. Its page shows:

- **The header**: which vault Canon reads and what it holds ("The vault
  ~/Obsidian/Canon holds 35 active notes and 2 drafts."), when it was read
  (**Read again** reads it now), the notes left out, what Canon may write,
  how much a turn gets, and **Settings**. While a read is under way it says
  "Reading the vault ~/Obsidian/Canon…". A vault folder that is missing, a
  file, or one DSH may not read (its permissions, or a Mac's privacy rules)
  says so, what to do and when it was tried, and What happened notes it;
  no turn gets notes until the folder can be read.
- **Try a prompt**: type a prompt and, if you like, a session's folder (a
  full path, or one starting with `~/`, as a session has it; anything else
  is refused and says why), and see which notes a turn in that folder would
  get, why each fits ("Shares the words “port” and “gateway”. It belongs to
  this folder's project, so it counts for more."), the near misses and why
  each stayed out, and **the exact text the turn gets**. It says which
  folder it used, and sends nothing to any session.
- **Sessions that got notes**, newest first: each with its last turns'
  notes and a switch that turns Canon off or on for that session (a screen
  reader hears it as "Add notes to <the session's title>"). The title opens
  the session.
- **Drafts**: the notes in the drafts folder, each with when and where it
  was saved (the session and turn) and **Promote**, and a line that says
  whether Promote does anything now.
- **What happened**: drafts saved and refused, drafts promoted and
  refused, sessions switched off and on, setting changes and vault
  problems, newest first.

Every empty state says what to do next, and every refusal says why in
words: "Not promoted: promoting is off (“Allow promoting drafts” in
Canon's settings). Turn it on to promote drafts; until then Promote
changes nothing." The switches, **Read again**, **Try it** and
**Promote** keep the keyboard's focus while they work; after Promote it
moves to the line that says what happened.

## Drafts and Promote

With **What Canon may write** set to **Drafts**, agents are offered
`canon_capture` (title, body, kind, tags). In the default **Read only**, the
model is never offered it. A capture writes one new file,
`<drafts folder>/<YYYY-MM-DD> <title>.md`:

```markdown
---
title: Gateway keepalive
status: draft
kind: gotcha
tags: [harbor-gateway, keepalive]
project: harbor-gateway
created: "2026-10-17T20:59:51.802Z"
source:
  session: session-3b09dbf4-…
  turn: 5
  folder: "/Users/you/Projects/harbor-gateway"
  by: "canon_capture"
---

# Gateway keepalive

Set the harbor gateway's upstream keepalive to 30 seconds. …
```

Canon never writes over a note (a name already taken gets " 2", " 3"),
never outside the drafts folder, and never through a link: the drafts
folder and every folder on the way to it must be plain folders inside the
vault. A session whose files are **Read Only** saves nothing. Every save
and refusal goes in What happened.

**Promote** works only from Canon's page, only when a person presses it,
and only while **What Canon may write** is **Drafts** and **Allow promoting
drafts** is on; otherwise it changes nothing and says which setting to
change. It moves the draft out of the drafts folder into **Promoted notes
go to** (the vault's top level by default) with `status: active` and the
time it was promoted; every other line stays as written. The next turn it
fits can get it.

### What Read only covers

*What Canon may write* binds Canon, not the agents: in **Read only**,
Canon offers no tool to save a note and promotes nothing. An agent's own
tools are another matter. An agent asked to record something can still
find the vault on disk, read its notes and write one itself with its shell
or file tools, like any other file. What keeps those tools out of the
vault is DSH's sandbox: on **Read Only** a session writes no file; on
**Workspace Write** a write outside the session's workspace (a vault
outside it, for one) asks you first; on **Full access** nothing asks.
Keep the vault outside your workspaces, and turn down a write into it you
did not ask for.

## Settings

Plugins → Canon shows the settings you can change while it runs, in DSH's
own settings form: change a value, then **Save**. They apply at once, and
What happened notes each save (*Settings changed: “What Canon may write”*).
**Use the default** clears one. The form will not save a value out of range,
or a promote folder inside the drafts folder, and says what fits instead.

| Setting | Default | Range | Where | What it does |
| --- | --- | --- | --- | --- |
| `vault` (Vault folder) | empty | a full path, or one starting with `~/` | Plugins | The Obsidian vault Canon reads. Empty: Canon does nothing until it is set. Never the home folder, `/`, or DSH's own data folder. |
| `access` (What Canon may write) | `read-only` | `read-only` (Read only) or `drafts` (Drafts) | Plugins | Read only: Canon writes nothing, ever (agents' own tools: see [What Read only covers](#what-read-only-covers)). Drafts: agents may save new drafts in the drafts folder. |
| `draftsFolder` (Drafts folder) | `Drafts` | a folder inside the vault | Plugins | Where drafts go. Its notes are never added to turns. |
| `promote` (Allow promoting drafts) | `false` | on or off | Plugins | Whether Promote on Canon's page does anything. Needs `access: drafts`. |
| `promoteFolder` (Promoted notes go to) | empty | empty, or a folder inside the vault outside the drafts folder | Plugins | Where promoted notes go. Empty: the vault's top level. |
| `recall` (Add notes to turns) | `true` | on or off | Plugins | Off: no turn gets notes; the page, drafts and Promote carry on. |
| `maxNotes` (Notes a turn, at most) | `3` | 1 to 10 | Plugins | The most notes one turn gets. |
| `maxChars` (Characters a turn, at most) | `2000` | 400 to 8000 | Plugins | The most characters the block may have. |
| `enabled` | `true` | `true` or `false` | Profile | `false` keeps Canon loaded but idle: it reads no vault, and its page says so and how to change it. |

A folder inside the vault is letters, digits, spaces and `- _ ( ) . , ' & +`,
parts joined by `/`, none starting with a dot and none `..`.

A wrong value never stops Canon from starting, whatever its type: it adds
and writes nothing, and its page says which setting is wrong, what it must
be, and **Open Canon's settings** puts the cursor in it. A number, or true
or false, in quotes in the profile is text, and the page says so:
"Characters a turn, at most (maxChars) must be a whole number of characters
from 400 to 8000, written without quotes (it is “900”, which is text)." Once
you fix it, Canon works again at once. A vault folder that cannot be read is
not a wrong setting: the page says what is wrong with the folder, and Canon
tries it again at the next turn, or when you press **Read again**.

## Files

In DSH's data folder (`$DSH_HOME`, else `~/.dsh`), folder mode 700, files
mode 600:

| File | What |
| --- | --- |
| `canon/recall.jsonl` | Each block added: session, turn, the notes and their size (the last 300). |
| `canon/events.jsonl` | What happened: drafts, promotes, refusals, switches, settings, vault problems. It keeps the last 400 entries and rewrites itself past 1 MB. |
| `canon/state.json` | The sessions turned off. |

Which notes each session's latest recall cited also lives in the session's
own state in DSH (the `canonRecall` projection), for the card after the
turn. In the vault, Canon writes only drafts (with **Drafts** allowed) and
promoted notes (with Promote allowed and pressed).

## Setup

1. Install Canon as in the [root README](../../README.md#install-a-plugin):

   ```bash
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/canon
   ```

   That adds `dsh-plugin-canon` to the profile's `package.json`
   (`dependencies` and `dsh.profile.bundles`). Its bundle adds its row
   (`id: canon`).

2. Restart DSH Desktop once so it loads the new bundle.

3. Open **Canon** in the sidebar, then **Open Canon's settings**, and set
   **Vault folder** to your vault (for example `~/Obsidian/Canon`). Canon
   reads it at once. To set it before the first start instead, address the
   row in the profile's `cordis.patch.yml`:

   ```yaml
   - id: canon
     config:
       vault: ~/Obsidian/Canon
   ```

4. To let agents save drafts, set **What Canon may write** to **Drafts**.
   To let yourself promote them, also turn on **Allow promoting drafts**.

On a Mac, DSH needs access to the vault's folder: a vault in Documents,
Desktop or iCloud Drive may need DSH allowed in System Settings → Privacy &
Security → Files and Folders. The page says so when it cannot read it.

## Switching it off

- **For one session**: **Turn off for this session** on the card after a
  turn, or the session's switch on Canon's page. Its later turns get no
  notes; nothing else changes.
- **Notes for every turn**: Plugins → Canon → *Add notes to turns* off. The
  page, drafts and Promote carry on.
- **Writing**: *What Canon may write* → Read only. Agents lose the capture
  tool and Promote changes nothing; drafts already saved stay in the vault.
  It stops Canon's writes, not an agent's own tools (see
  [What Read only covers](#what-read-only-covers)).
- **Entirely**: Plugins → Canon → off. Its sidebar entry, page, card and
  tool go, and no turn gets notes. Nothing in your sessions or your vault
  changes. (`enabled: false` in the profile instead keeps its page, which
  says it is off and how to turn it back on.)

## Rollback

DSH runs Canon from its folder in your clone (the profile links it). To go
back to a release, restore that folder from the release's tag and restart
DSH Desktop:

```bash
git -C ~/.dsh-plugins/dsh-public-plugins restore --source canon-v1.0.0 -- plugins/canon
```

To remove it, follow [Remove a plugin](../../README.md#remove-a-plugin) for
`dsh-plugin-canon` (row `canon`), and delete `canon/` in DSH's data folder
to forget its logs and switches. Notes it wrote stay in your vault as
ordinary notes: drafts in the drafts folder, promoted notes where they were
promoted to. Earlier turns keep the blocks they got in their logs.

## Limits

- Canon matches words, not meaning: a note that says "listener" for a
  prompt that says "port" is not found. Titles, aliases and tags are the
  way to make a note easy to find.
- It reads the vault on this computer. A vault that syncs (iCloud,
  Obsidian Sync) is read as it is on disk at the moment.
- One block per prompt: a long turn does not get new notes at later steps,
  and a steered message gets none.
- The card stands on the session's latest turn that got notes; earlier
  turns' notes are on Canon's page (the last few per session) and in the
  Trajectory tab.

## Tests

From the repository root:

```sh
node --test test/canon*.test.js       # the vault, search, which notes a prompt gets, the block, drafts and Promote, the page, the browser half
node scripts/canon-relevance.mjs      # the figures in "How well it picks notes"
node scripts/e2e.mjs canon            # real DSH in a throwaway home, on every DSH build here
```

The unit tests read a synthetic vault (`test/fixtures/canon/vault`: 42
notes for five projects, people, decisions, runbooks and ideas; active
notes, superseded decisions, an archived runbook, ideas that are proposed
or drafts, drafts in and out of the drafts folder, notes with no
frontmatter, `.obsidian`, `.trash` and an attachment) and always work on a
copy of it in a temporary folder. They cover a vault folder DSH may not
list, the try-out's `~/` folder, numbers in quotes in the profile, the
form's promote-folder check, and where the focus goes after each switch,
Read again and Promote. `test/canon-relevance.test.js` holds the dev set to
the figures it reached, and the hold-out to the floors.

The real-DSH test (about one minute a build) starts DSH from each
`.e2e/dsh-<version>` install and from the installed app's own DSH, each in
a throwaway home, with Session Watch and Canon and a scripted model
(`test/e2e/fake-model.mjs`) that records what each request carried. It
copies the fixture vault into its temporary folder, and checks at the end
that only the copy changed. From real sessions it shows that a prompt gets
one block right after it that says its paths are in the canon vault and
cites the note that fits first, that DSH's log keeps it as Canon's context
and its Trajectory tab lists it, that the page's try-out shows exactly the
block the model got (with a full path or `~/`, and a folder that is
neither refused in words), that a thank-you gets nothing, and that the
session's folder brings in its project's note. In a browser, light and
dark, wide and narrow, it turns a session off from the card (its next
prompt gets nothing, and the focus stays on the switch) and back on from
the page (the switch named for the session keeps the focus), saves Drafts
in Canon's settings, lets the model save a draft (status draft, with its
session, turn and folder, never recalled), presses Promote with promoting
off (nothing changes, and the page says why) and with it on (an active
note the next turn gets; the focus goes to the line that says so), and
switches Canon off and on in Plugins (its card, entry and style go and
come back; a turn in between gets nothing). It restarts DSH (a session
switched off stays off), runs without Session Watch (the page still
follows), with sessions on Read Only (notes, but no draft), with a number
in quotes in the profile (`maxChars: "900"`: named with its range and as
text, and fixed by saving a good value), with a copy of the vault made
unreadable (`chmod 000` in its own folder: the page says DSH may not read
it, What happened notes it and a turn gets nothing; readable again,
**Read again** reads it and keeps the focus) and with `enabled: false`, and
checks Canon's file modes. Pictures go to `.e2e/shots/canon/<build>/`.
