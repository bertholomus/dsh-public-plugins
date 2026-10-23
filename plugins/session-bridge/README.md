# dsh-plugin-session-bridge

A small JSON API for the running DSH Desktop Host. Scripts, cron jobs and other agents use it to create, prompt, steer, cancel and read DSH sessions.

It drives the Host's own `sessionController`, the same code path the GUI uses. A session that you create or prompt through the bridge shows up live in the DSH window, and you can watch it and take over there.

## Security

- The API listens on a **Unix socket only**. It opens no TCP port.
- The socket directory is mode `700` and the socket is mode `600`. Only your user can connect.
- Anyone who can connect has full control of DSH sessions, including their tools. Do not forward the socket to a network.
- The log records actions and sizes (for example `prompt <id> mode=followup chars=812`), never prompt text.

## Config

Install the plugin as in the [root README](../../README.md#install-a-plugin), then address its row in `cordis.patch.yml`:

```yaml
- id: session-bridge
  config:
    socketPath: "~/.dsh/session-bridge/bridge.sock"
    logFile: "~/.dsh/session-bridge/bridge.log"
    maxBodyBytes: 1048576
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the plugin off without removing the row. |
| `socketPath` | `~/.dsh/session-bridge/bridge.sock` | Unix socket path. |
| `logFile` | `~/.dsh/session-bridge/bridge.log` | Action log, mode 600. Empty string turns it off. |
| `maxBodyBytes` | `1048576` | Largest request body accepted. |

## API

All requests and replies are JSON.

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /health` | | `{ok, plugin, pid, socket}` |
| `GET /workspaces` | | `[{id, path, title, sessions}]` |
| `GET /models` | | The Host's model catalog |
| `GET /sessions` | | Session list |
| `POST /sessions` | `{workspacePath` or `workspaceId, title?, provider?, model?, reasoningEffort?, agentPreset?, text?}` | `{sessionId, workspace, model?, title?, prompt?}` |
| `GET /sessions/:id` | | `{sessionId, cwd, title, attached, status, turns, lastSeq, lastAssistant}` |
| `GET /sessions/:id/events` | query `after`, `limit` (max 2000), `full=1`, `types=a,b` | `{lastSeq, more, events}` |
| `POST /sessions/:id/prompt` | `{text, mode?: "followup" or "steer"}` | `{accepted, mode, requestId, chars}` |
| `POST /sessions/:id/model` | `{provider, model, reasoningEffort?}` | The Host's reply |
| `POST /sessions/:id/cancel` | | The Host's reply |
| `POST /sessions/:id/rename` | `{title}` | The Host's reply |

`steer` sends the text into the running turn. `followup` queues it for after the turn ends.

Each `user/message` event carries its `source`: `{kind: "user"}` for the user (or this bridge), `{kind: "agent-message", senderSessionId}` for a message another session sent, and a plugin's own kind for plugin notes.

Errors come back as `{error: {code, message}}` with status 400, 404, 405, 409, 413 or 500.

## Examples

```bash
S=~/.dsh/session-bridge/bridge.sock

curl -s --unix-socket $S http://bridge/health

# New session in a workspace, with a first prompt
curl -s --unix-socket $S -X POST http://bridge/sessions \
  -H 'content-type: application/json' \
  -d '{"workspacePath":"~/projects/demo","title":"lint pass","text":"Run the linter and fix what it finds."}'

# Poll it
curl -s --unix-socket $S http://bridge/sessions/<id>
curl -s --unix-socket $S "http://bridge/sessions/<id>/events?after=-1&types=assistant/message"

# Change direction mid-turn
curl -s --unix-socket $S -X POST http://bridge/sessions/<id>/prompt \
  -H 'content-type: application/json' -d '{"text":"Skip the tests folder.","mode":"steer"}'
```

From a remote machine, run the same `curl` over SSH on the DSH machine. The socket stays local.
