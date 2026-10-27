# Session Bridge

`dsh-plugin-session-bridge`: a small JSON API for the running DSH. Scripts, cron jobs and other agents on this Mac use it to create, prompt, steer, cancel and read DSH sessions, and to wait for a reply without polling.

It drives DSH's own `sessionController`, the same code path the window uses. A session you create or prompt through the bridge shows up live in the DSH window, where you can watch it and take over.

What it does for this stack: it lets work on local models run unattended, driven from outside the window. A cron job or a coordinator makes a session and sends a prompt, waits for its turn to end in one call, and reads the reply. After a timeout or a DSH restart it asks what became of the prompt and simply tries again with the same request id: a create retried that way makes one session, a prompt DSH already has is not sent again, and a prompt that DSH dropped, or whose turn was cut off before it finished, is sent again once. DSH Test (`dsh-test prompt`, `dsh-test bridge`), scripts that speak this API (such as `dshb --sock <socket>`) and this repository's real-DSH tests all drive DSH through it.

## Security

- The API listens on a **Unix socket only**. It opens no TCP port.
- The socket's folder is mode `700` and the socket mode `600`, so only your user can connect. The bridge will not put its socket in a shared folder (your home folder, a sticky one such as `/tmp`, or another user's): it would have to close that folder to everyone else, so it says so and does not listen.
- Anyone who can connect has full control of DSH sessions, including their tools. Do not forward the socket to a network.
- The log records actions and sizes (for example `prompt <id> mode=followup chars=812 request=<id>`), never a prompt's text or a title (a rename is logged as `chars=<n>`). It is mode `600`, even if it was there before with wider rights, and a symlink at its path is never written through. An error line holds the error's own message, cut at 300 characters. Request ids are logged as you give them, so keep secrets out of them. A log that cannot be written (a folder that cannot be made, no write access, a symlink) never stops the bridge, and is never silent: `GET /health` names it in `problems` while it lasts, and DSH's logger says it once.
- Which session each create's request id made is kept beside the socket, in `creates.jsonl` (mode `600`; request ids, session ids and folders, never a text or a title; the last 5000).
- The bridge never takes over a socket another program answers on (another DSH, or a second row of this plugin), and never deletes a file at the socket path that is not a socket. A socket left by a crash, which nobody answers on, is replaced. The log says what it changed: a folder it made, a folder it closed to `700` (with the mode it had; it stays `700`), an old socket it replaced.

The tests prove each of these: `test/session-bridge.test.js` the modes, the refusals and the log, and the real-DSH test the same in a running DSH, plus the TCP ports (DSH listens on the same ones with the bridge on as off: only its window's).

## Install and set up

Install the plugin as in the [root README](../../README.md#install-a-plugin). It needs no settings: the socket and the log go in DSH's data folder (`DSH_HOME` when it is set, else `~/.dsh`), under `session-bridge/`. To change them, address its row in `cordis.patch.yml`:

```yaml
- id: session-bridge
  config:
    socketPath: "~/.dsh/session-bridge/bridge.sock"
    logFile: "~/.dsh/session-bridge/bridge.log"
    maxBodyBytes: 1048576
```

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `socketPath` | a full path (`/…` or `~/…`), at most 103 bytes | `<DSH data folder>/session-bridge/bridge.sock` | The Unix socket. Its folder is made, or closed, to mode 700: give the socket a folder of its own. |
| `logFile` | a full path, or `""` | `<DSH data folder>/session-bridge/bridge.log` | The action log, mode 600; `""` for none. Past 5 MB it starts again and keeps the last part as `<logFile>.1`. |
| `maxBodyBytes` | a whole number, 1024 to 67108864 | `1048576` | The largest request body taken; a larger one gets a 413. |

A wrong value never stops the bridge (a row that still says `enabled: false` does, on purpose: see below). That setting keeps its default, and the problem is said in words in `GET /health` (`problems`) and in the bridge's log (`setting: …`). The bridge also hands it to DSH's logger, which may keep it in memory only, so read the bridge's log. A key the bridge does not have (a typo such as `socketpath`) is named the same way.

`enabled` is no longer a setting (it was until 0.3.0): DSH's own switch in Plugins turns the bridge off, and DSH then shows it Off, where `enabled: false` left it reading "Running". A row that still has the key is named in `problems`; one that says `enabled: false` is never taken as on: the bridge does not start (see [When the bridge does not listen](#when-the-bridge-does-not-listen)).

DSH applies a saved change to the row at once: the bridge stops, and starts again with the new settings. (A bridge that failed to start: see [When the bridge does not listen](#when-the-bridge-does-not-listen).)

In DSH Test, `dsh-test load <this folder>` keeps the test home's own socket and log (DSH Test sets `DSH_HOME` to its home), so `dsh-test prompt` and `dsh-test bridge` reach it there.

## Switch it off, roll it back

- To switch it off, turn **Session Bridge** off on DSH's Plugins page; DSH then shows it Off. Its socket file goes away, so scripts that use it (`dsh-test prompt`, for one) get "no such file" (`ENOENT`) until it is on again. To remove it, see [Remove a plugin](../../README.md#remove-a-plugin).
- To roll back, check out the earlier version of `plugins/session-bridge` in your clone (`git log -- plugins/session-bridge` lists them) and restart DSH. For the same request, 0.4.0 answers with the same fields as 0.1.0, 0.2.0 and 0.3.0 (some replies have more), except where they let input through, guessed at it, or answered as done what they did not do (a cancel with no turn running, a retry with another text): 0.4.0 refuses those in words. See [What changed](#what-changed). An older version ignores `creates.jsonl`; 0.3.0 reads a prompt whose turn DSH tore down as `answered`, and older ones every unfinished prompt.

## API

All requests and replies are JSON. An error comes back as `{"error": {"code", "message"}}`, and its message says what to do.

| Method and path | Body or query | Returns |
| --- | --- | --- |
| `GET /health` | | `{ok, plugin, version, pid, socket, problems}` |
| `GET /workspaces` | | `[{id, path, title, sessions}]` |
| `GET /models` | | DSH's model catalog |
| `GET /sessions` | | DSH's session list |
| `POST /sessions` | `{workspacePath` or `workspaceId, title?, provider?, model?, reasoningEffort?, agentPreset?, text?, requestId?}` | `{sessionId, workspace, model?, title?, prompt?, alreadyCreated?}` |
| `GET /sessions/:id` | | `{sessionId, cwd, title, attached, status, turns, lastSeq, lastAssistant}` |
| `GET /sessions/:id/events` | `after`, `limit`, `full=1`, `types=a,b`, `wait` | `{lastSeq, more, events, timedOut?, stopped?}` |
| `GET /sessions/:id/requests/:requestId` | `wait` | What became of one prompt (below) |
| `POST /sessions/:id/prompt` | `{text, mode?: "followup" or "steer", requestId?}` | `{accepted, mode, requestId, chars, alreadySent?, state?, attempt?, resent?}` |
| `POST /sessions/:id/model` | `{provider, model, reasoningEffort?}` | DSH's reply |
| `POST /sessions/:id/cancel` | | DSH's reply |
| `POST /sessions/:id/rename` | `{title}`, at most 500 characters | DSH's reply |

- `workspacePath` is a full path (`/…` or `~/…`) to a folder that exists. DSH reuses the workspace it has for that folder.
- `provider` and `model` go together, and `reasoningEffort` goes with them. With none of them, the session gets DSH's default model and effort.
- `POST /sessions` makes the session, then sets its model, then its title, then sends `text` (`prompt` holds that prompt's reply, with its `requestId`). If a step after the first fails, the error also carries `sessionId`, `workspace` and `failedStep` (`model`, `title` or `prompt`), so you can carry on with that session.
- With a `requestId`, a create is safe to retry, after a timeout or a DSH restart: the same id makes one session. A retry answers with that session and `alreadyCreated: true`, and does only the steps the first try did not finish (a model or title DSH does not have yet; the prompt, unless DSH already has it, when `prompt.alreadySent` is `true`). Retries that overlap run one after another, also when a settings change starts the bridge again while the first is on its way. The same id for another folder is a 409 (`request/conflict`); one whose session DSH no longer has is a 409 (`request/session-gone`): use a new id for a new session.
- `status` is `running` or `idle` for a session open in DSH, and `cold` for one DSH has not opened since it started.
- `followup` (the default) queues the text for after the running turn; `steer` sends it into the running turn at its next step. With no turn running, either one starts a turn.
- `cancel` stops the running turn. With no turn running (the session is idle, or DSH has not opened it since it started) there is nothing to stop: a 409, `session/not-running`, and DSH is not asked.
- Events: `after` is the last `seq` you have (default -1, the start); `limit` is 1 to 2000 (default 200; more reads as 2000), and `more` says there are more; each text is cut at 4000 characters unless `full=1`; `types` keeps only those event types. A reply DSH cut off in the middle (its turn was stopped or torn down while it was written) carries `interrupted: true`, here, in `lastAssistant` and in a prompt's `reply`: its text is only the part that came.
- Each `user/message` event carries its `source`: `{kind: "user", …}` for the user or this bridge (a bridge prompt carries its request id as `rpcId`, and an attempt sent again after a cut-off turn `<requestId>~2`), `{kind: "agent-message", senderSessionId}` for a message from another session, and a plugin's own kind for a plugin's note.

### What became of a prompt

Every prompt has a request id: yours (`requestId`: 1 to 128 letters, digits or `. _ : -`, starting with a letter or digit), or one the bridge makes (`bridge-<uuid>`). `GET /sessions/:id/requests/:requestId` reads the session's own log and answers `{sessionId, requestId, state, seq?, turn?, target?, end?, reply?, removed?, attempt?}` (and `timedOut`, `stopped` with `wait`):

| `state` | Meaning |
| --- | --- |
| `waiting` | Not in the session's log yet: on its way into DSH. |
| `queued` | In DSH's queue; `target` is `next-turn` (a followup) or `next-step` (a steer). |
| `read` | A turn took it and is still running. |
| `answered` | The turn that read it ended by itself (`end.kind` `completed`; `max-tokens`, at its token limit; `blocked`, a plugin's check refused it) or was stopped on purpose (`aborted`, with `end.reason.kind` `user`: a cancel or the window's stop; `parent`: the session above it stopped; `hook`: a plugin stopped it). `reply` is the turn's last reply after it (`{seq, text}`, with `interrupted: true` when the stop cut it off; or `null`). |
| `unfinished` | The turn that read it ended without finishing it: DSH stopped or crashed under it (`interrupted`); DSH tore the session's agent down under it, as when a plugin or setting is loaded again (`aborted` with `end.reason.kind` `disposed`), or stopped it because the DeepSeek account signed out (`hook`, `deepseek-account/signed-out`); it failed (`error`); or it ended in a way this version does not know. `reply` holds any reply it gave first (`interrupted: true` when cut off), never as the answer. Send it again with the same request id to have it done. |
| `dropped` | It left DSH's queue but never reached the log: DSH stopped mid-step before it saved the message (`end.kind` is then `interrupted`), the turn that took it failed first (`error`, as when a prompt comes while DSH loads its agent loop again), or it was taken out of the queue (`removed: true`), in the window or by DSH clearing the queue as it tore the agent down. Send it again with the same request id. |

With `wait=<seconds>` (0 to 600; more reads as 600), the answer comes when the state is `answered`, `unfinished` or `dropped`, or when the wait runs out (`timedOut: true`). A request id that is not in the session's log, and that the bridge has not sent to that session since DSH started, is a 404 (`request/not-found`).

A retry with your own `requestId` is safe. If DSH already has that message (`queued`, `read` or `answered`), or the bridge is still handing it over, it is not sent again, and the reply says `alreadySent: true` with its `state`. A retry whose text differs from the one DSH has (or the one on its way) is a 409 (`request/conflict`, with its `state`): it would not be sent, so the bridge says so instead of dropping it; use a new request id for another prompt. A `dropped` one is sent again. An `unfinished` one is sent once more as the next attempt (`attempt: 2`, `resent: true`), with the text you give now: DSH takes each message id once per session, so the bridge gives that attempt the id `<requestId>~2` (then `~3`), and reads it back under your id. The turn it cut off may have done part of the work (its tool calls are in the session's log); the new attempt asks again from where the session is. `GET …/requests/<requestId>` follows the newest attempt and names it in `attempt` when it is not the first. A failure that lasts (a turn that ends in `error` each time) gives a new attempt for each retry: cap your retries by `attempt`.

### Waiting without polling

`wait=<seconds>` (0 to 600; more reads as 600) on `events` answers as soon as the session has an event after `after` (of `types`, when given), or with an empty page and `timedOut: true` when the wait runs out. DSH's own session events wake a waiting request; the bridge does not poll. A caller that hangs up ends its wait. When the bridge stops (a settings change, switched off), every wait is answered at once with what it has, `timedOut: true` and `stopped: true`. When DSH itself quits, a wait in flight gets no answer: the connection closes. Ask again when DSH is back.

### Status codes

| Status | When |
| --- | --- |
| 400 | Bad input (`bad-request`, `bad-json`), refused before DSH is asked. |
| 404 | An unknown path (`not-found`), workspace (`workspace/not-found`) or request id (`request/not-found`), or a session DSH says it does not have (`session/not-found`). |
| 405 | A wrong method; the `Allow` header names the right ones. |
| 409 | DSH refused, in its own words (for example `session/model-unavailable`); `session/not-running` (no turn to cancel); a request id used again for another folder or another text (`request/conflict`); or a create's request id whose session is gone (`request/session-gone`). |
| 413 | A body over `maxBodyBytes`. |
| 500 | Anything else, such as `session/read-failed`: DSH could not read the session for another reason than "not found", so it may still be there; try again before you make a new one. |
| 503 | The bridge is stopping. |
| 504 | DSH did not answer in time, by the bridge's own clock: 20 s to read a session or the list, 60 s to take a prompt. A prompt's 504 carries its `requestId`: DSH may still take it, so ask `GET …/requests/<requestId>` before you send it again (a retry with that id is not sent again while DSH has it). |

## Examples

```bash
S=~/.dsh/session-bridge/bridge.sock

curl -s --unix-socket $S http://bridge/health

# A new session in a folder, with a first prompt under your own request id
curl -s --unix-socket $S -X POST http://bridge/sessions \
  -H 'content-type: application/json' \
  -d '{"workspacePath":"~/projects/demo","title":"lint pass","text":"Run the linter and fix what it finds.","requestId":"lint-2026-10-26"}'

# Wait up to 10 minutes for that prompt's turn to end; the reply is in .reply.text
curl -s --unix-socket $S "http://bridge/sessions/<id>/requests/lint-2026-10-26?wait=600"

# Change direction mid-turn
curl -s --unix-socket $S -X POST http://bridge/sessions/<id>/prompt \
  -H 'content-type: application/json' -d '{"text":"Skip the tests folder.","mode":"steer"}'

# Read new events as they come: after the last seq you have, waiting up to a minute
curl -s --unix-socket $S "http://bridge/sessions/<id>/events?after=41&wait=60"
```

From another machine, run the same `curl` over SSH on the DSH machine. The socket stays local.

## When the bridge does not listen

DSH shows the plugin as failed on its page in Plugins: its part reads "Problem", not "Running", and the count says "1 failed" (the list of plugins itself shows no mark; the plugin's start fails with `Session Bridge is not listening on <socket>: <why>`). DSH's page has no place for a plugin's reason, so read it in the bridge's log (`<DSH data folder>/session-bridge/bridge.log` unless `logFile` says otherwise; `dsh-test logs` in DSH Test): `not listening on <socket>: <why>`.

Fix the cause, then switch Session Bridge off and on in Plugins, or restart DSH: either always starts it again. Saving the fixed row alone starts it at once when that row differs from the row that last ran. When it is the row that last ran again (as when you undo the change that failed), DSH may leave the plugin failed, as it does after a refused socket. Then switch it off and on.

- `another program answers on <socket>`: another DSH, or a second row of this plugin, has it. Give each DSH its own `socketPath`.
- `<socket> is a file that is not a socket`: the bridge never deletes it. Move it, or choose another `socketPath`.
- `its folder … is shared` or `… belongs to another user`: give the socket a folder of its own.
- `the socket path is N bytes`: DSH's data folder is too deep for a socket path; set a shorter `socketPath`.
- `its row says enabled: false`: `enabled` is no longer a setting, and a row that says off is never taken as on. To keep the bridge off, switch it off in Plugins (DSH then shows it Off); to have it listen, take `enabled` out of its row (if Plugins still shows it failed, switch it off and on there).

## Tests

```bash
npm test                               # from the repository root; test/session-bridge.test.js is among them
node scripts/e2e.mjs session-bridge    # the real-DSH test, on every DSH under .e2e/ and the installed app's
```

- `test/session-bridge.test.js` needs no DSH. It covers the settings in words (and the retired `enabled`: a row that says off is read as off and said, anything else is ignored and said); the session's log read as prompt states, from DSH's queue to the reply (each turn end and stop cause as the states table says; unfinished after a cut-off turn or one DSH tore down, never answered with the cut-off text, which is marked `interrupted`; dropped when taken out of the queue; each attempt); the socket (700 and 600; a stale one replaced and said in the log; a live one, a plain file, a shared folder, the home folder however it is spelt, a long path refused); the log (no prompt text or titles, 600, bytes, a new part past its size, a symlink never followed; one that cannot be written said in `GET /health` and once in DSH's logger, until it can be written again); and every route over a stand-in DSH, with its refusals (among them a cancel with no turn running and a retry with another text), retries (a create retried while the first is on its way, while the bridge starts again, and after a restart; a prompt sent again after a cut-off or torn-down turn), deadlines kept by the bridge, waits (one woken by an event that landed before it started) and errors.
- `plugins/session-bridge/test/e2e/run.mjs` runs a real DSH in a throwaway home, with a scripted model. It checks the security claims (modes, the folder it made said in its log, no TCP port of its own, no text in the log); a session made with a model, a title and a prompt, answered and found in its log, and a retry with its request id but another text refused (409); a create retried with its request id (one session, one message, the record 600); a steer into a running turn, a followup after it and a steer with nothing running; cancel (and a 409 once no turn runs), rename, a model and DSH's refusals; refusals in words; waits; a restart under a running turn (its prompt reads as the log on disk says, `dropped` or `unfinished`, and is sent again once) and a restart after DSH saved the prompt (`unfinished`, sent once more as attempt 2, answered, both attempts on disk once each); a crash (the stale socket replaced); a turn DSH tears down under its prompt by loading its agent loop again (`aborted`, `disposed` on disk: `unfinished`, its cut-off reply marked `interrupted`, sent once more as attempt 2, answered, both attempts on disk once each); settings changed while DSH runs, wrong ones too; a log that cannot be written (said in `GET /health` while the bridge works on, gone once it can be written; DSH's logger keeps plugin lines in memory, so that it is told once is the unit test's); `enabled: false` (failed in Plugins with the reason in the log, nothing listening; the row without it, and off and on if DSH left it failed, runs it again); and a socket another program holds (refused, failed in Plugins, still failed with the row that last ran, running again once switched off and on, and at once with a row that differs from the one that last ran; that program's socket untouched); its Plugins page title, sentence and icon; switching it off and on in Plugins; and in a real window, the bridged session in the list and a prompt through the bridge showing live in the open chat, with pictures light and dark, wide and at 760 px, under `.e2e/shots/session-bridge/<DSH version>/`. `NO_WINDOW=1` skips the window, `KEEP=1` keeps the throwaway home, and `--dsh <version>` runs one DSH only.

## What changed

### 0.4.0

- A prompt whose turn DSH tore down (`aborted` with reason `disposed`, as when a plugin or setting is loaded again under it) or stopped at a sign-out is `unfinished`, and a retry sends it once more; 0.3.0 read every `aborted` turn as `answered`, gave its cut-off text as the reply, and never sent it again. An end the bridge does not know is `unfinished` too.
- A reply DSH cut off carries `interrupted: true` (in a prompt's `reply`, `lastAssistant` and the events page).
- A retry with a request id DSH already has but another text is a 409 (`request/conflict`); 0.3.0 answered `alreadySent` and dropped the new text.
- `cancel` with no turn running is a 409 (`session/not-running`); 0.3.0 passed it to DSH, which answered `accepted` and stopped nothing.
- A log that cannot be written is said in `GET /health` and once in DSH's logger; 0.3.0 said nothing. The log also says which folder the bridge made or closed to 700, and which old socket it replaced.
- `enabled` is no longer a setting: DSH's switch in Plugins does its job and shows the bridge Off. A row that says `enabled: false` fails the start, with the reason, so the bridge is never listed as "Running" while nothing listens.
- A file the bridge cannot write or make (the log, the socket's folder) is said with its error code and what it means, such as `EACCES: permission denied`.
- [When the bridge does not listen](#when-the-bridge-does-not-listen) says how DSH starts a failed plugin again, as the real-DSH test shows it: off and on in Plugins always does; a saved row does when it differs from the row that last ran, and may not when it is that row again. 0.3.0 said a saved row never does.

### 0.3.0

- Creates are safe to retry: one session per `requestId`, also across DSH restarts (`creates.jsonl` beside the socket) and a settings change while one is on its way; a retry answers `alreadyCreated: true` and finishes only what the first try did not.
- A new state, `unfinished`: a prompt whose turn was cut off after DSH saved it (or that failed) is sent once more with the same request id, as the next attempt; `dropped` says `removed: true` for a prompt taken out of DSH's queue.
- The bridge keeps its own deadlines (DSH checks a call's deadline only as it starts): a prompt DSH holds gets a 504 at 60 s, with its `requestId`.
- A read that fails for another reason than "not found" is a 500 (`session/read-failed`), no longer a 404.
- `reasoningEffort` without a model, or not a string, is refused in words (0.2.0 dropped it silently).
- A bridge that cannot listen shows as failed on its page in Plugins (0.2.0 read "Running"), with the reason in the bridge's log; the plugin has its title, sentence and icon there.
- Waits: an event that lands just before a wait starts wakes it; a wait the bridge's stop ends says `stopped: true`.
- The home folder is recognised by device and inode, however its path is spelt; the log counts bytes and never follows a symlink.

### 0.2.0

- New: `GET /sessions/:id/requests/:requestId`; `wait` on events and requests; your own `requestId`, for safe retries; `version` and `problems` in `GET /health`; `sessionId`, `workspace` and `failedStep` when `POST /sessions` fails after it made the session.
- The defaults follow DSH's data folder (`DSH_HOME`), so a second DSH gets its own socket and log without settings.
- The socket: a shared folder is refused (0.1.0 closed even the home folder to mode 700, and did not load at all for one in `/tmp`); a live socket or a file that is not a socket is left alone (0.1.0 deleted either).
- Settings: a wrong type or value no longer stops the plugin from loading; it is named, and its default used.
- The log: mode 600 even for a log that was there before, its folder made, a new part past 5 MB, renames logged by length.
- Stricter input, refused with a 400 before DSH is asked: a `mode` other than `followup` or `steer` (0.1.0 read it as `followup`); an `after` or `limit` that is not a whole number (0.1.0 answered an empty page); a title over 500 characters; a `provider` without a `model` (0.1.0 skipped the model); a relative or missing `workspacePath`; a body that is not a JSON object.
- Errors: DSH's "not found" is a 404 (0.1.0 answered a prompt to an unknown session with a 409); a wrong method on any path is a 405 with `Allow`; cancel on a session DSH has not opened is a 409, `session/not-running`.
