# dsh-plugin-discord

Connects a Discord bot to DSH Desktop agent sessions.

- You post a message in an allowed channel. The bot opens a public thread on that message.
- Each thread is one agent session, with its own history. The session survives DSH restarts.
- The agent replies through Discord tools (`discord_send`, `discord_send_file`). Text that the agent does not send through a tool never reaches Discord.
- One thread runs one turn at a time. New messages in a busy thread wait in a queue. Different threads run at the same time.
- The sessions show up in the DSH window, so you can watch them there.

The Discord REST and Gateway client is built on Node 22 `fetch` and `WebSocket`. The plugin has no runtime dependencies except the DSH host packages.

## Setup

### 1. Create the bot

1. Open <https://discord.com/developers/applications> and click **New Application**.
2. Open **Bot**. Click **Reset Token** and copy the token. Keep it secret.
3. On the same page, under **Privileged Gateway Intents**, turn on **Message Content Intent**. If it is off, Discord closes the connection with code `4014`.
4. Copy the **Application ID** from **General Information**.

### 2. Invite the bot to your server

Open this URL. Replace `<APPLICATION_ID>`.

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=377957248064
```

You need **both** scopes. `applications.commands` makes the slash commands appear. If you invited the bot before without it, open the URL again; Discord adds the missing scope.

The permission number gives: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions, Manage Messages, Create Public Threads, Create Private Threads, Send Messages in Threads.

### 3. Get the IDs

1. In Discord, open **User Settings → Advanced** and turn on **Developer Mode**.
2. Right-click the channel the bot will use and click **Copy Channel ID**.
3. Right-click your own name and click **Copy User ID**.

### 4. Store the token

Put the token in the DSH credential store, `~/.dsh/.credentials.yaml`:

```yaml
version: 1
refs:
  DISCORD_BOT_TOKEN: <your bot token>
```

Then set owner-only permissions:

```bash
chmod 600 ~/.dsh/.credentials.yaml
```

You can also give the token as an environment variable with the same name. Do not put the token in `cordis.patch.yml`.

### 5. Install the plugin

Use the steps in the [top-level README](../../README.md#install-a-plugin) with the name `dsh-plugin-discord`, or the `dsh` command that DSH Desktop installs:

```bash
dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/discord
```

### 6. Configure the row

The bundle adds the `discord` row. Address it in `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: discord
  config:
    workspacePath: /path/where/discord/agents/work
    tokenRef: DISCORD_BOT_TOKEN
    allowedChannelIds: ["<channel id>"]
    allowedUserIds: ["<your user id>"]
    permissionPreset: workspace-write
    requireMention: false
    autoThread: true
    threadArchiveMinutes: 1440
    # models: ["provider:model", "other:model"]   # menu for /model
    # titleModel: "provider:model"                # model for thread titles
```

### 7. Check that it runs

Restart DSH Desktop once so it loads the new bundle. Later changes to the row apply live when the profile uses `patchReload: live`. Then:

1. Look in the DSH log for `discord: gateway connected; listening for messages`.
2. Post a message in the allowed channel. The bot opens a thread and answers there.

If nothing happens, read `~/.dsh/discord-plugin-trace.log`. It has one JSON line for each event, with the reason a message was dropped.

## Permission preset — choose this with care

Discord messages are **remote input** to an agent that can run tools on your machine.

- `workspace-write` (the default) asks for approval in the DSH window before risky actions. An agent that waits for approval stops the thread until you approve it in DSH. Use this if you watch the DSH window.
- `danger-full-access` never asks. The bot works unattended, but anyone in `allowedUserIds` can make the agent do anything your user account can do.

Whatever preset you use:

- Always set `allowedUserIds`. If it is empty, **every user** in the allowed channels can drive the agent.
- Keep `allowedChannelIds` to channels you control.
- Point `workspacePath` at a folder for this work, not your home folder.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the bot off without removing the row. |
| `workspacePath` | (required) | Folder where Discord sessions work. Without it the bot stays idle. |
| `tokenRef` | `DISCORD_BOT_TOKEN` | Name of the credential that holds the bot token. |
| `allowedChannelIds` | `[]` | Parent channels the bot works in, plus their threads. Empty means no channels: the bot stays silent. |
| `allowedUserIds` | `[]` | Users who may talk to the bot. Empty means everyone. |
| `agentPreset` | `standard` | Agent preset for new sessions. |
| `permissionPreset` | `workspace-write` | Permission preset for new sessions. See above. |
| `requireMention` | `false` | If `true`, a top-level message must @mention the bot. |
| `autoThread` | `true` | Open a thread for each top-level message. |
| `threadArchiveMinutes` | `1440` | Thread auto-archive time: 60, 1440, 4320 or 10080. |
| `models` | `[]` | Models offered by `/model`. Free text is also accepted. |
| `titleModel` | (deployment route) | Model for thread titles: `provider:model`, `provider/model` or a bare id. |
| `titleTimeoutMs` | `20000` | Time limit for the title call. |
| `maxPromptChars` | `8000` | Longest Discord message passed to the agent. |
| `requestTimeoutMs` | `15000` | Time limit for each Discord REST call. |
| `traceFile` | `~/.dsh/discord-plugin-trace.log` | Event trace. Empty string turns it off. |
| `storeFile` | `~/.dsh/discord-plugin-sessions.json` | Thread-to-session map. |

## Slash commands

These are registered once, for all servers.

| Command | What it does |
| --- | --- |
| `/rename [title]` | Rename the thread. With no title, make a new one from the conversation. |
| `/model [spec]` | Show or change the thread's model. The change applies from the next turn. `/new` clears it. |
| `/effort [level]` | Show or set the reasoning effort, for example `low`, `medium` or `high`. `clear` removes it. |
| `/stop` | Stop the running turn. Queued messages stay. |
| `/new`, `/reset` | Clear this thread's session only. |

## How it behaves

- **Gates.** It ignores bots, including itself. It drops users outside `allowedUserIds` and channels outside `allowedChannelIds`, and writes the reason to the trace.
- **Threads.** A top-level message gets a public thread with a temporary name (the first ~80 characters). The bot posts nothing in the parent channel, except one error line if it cannot create the thread after two tries.
- **Sessions.** The thread ID is the session key. The map is saved in `storeFile` with atomic writes. After a restart, the next message in a known thread resumes its session with full history.
- **Titles.** After the first reply, one short model call names the thread. Bad or failed titles fall back to a title made from your own words. Titles are unique (`#2`, `#3` on a clash). The bot renames only threads that still have the temporary name, so a manual rename stays.
- **Output.** Replies split at 2000 characters on paragraph or code-fence borders, never inside a code block. A typing indicator shows while a turn runs.
- **Archived threads.** A message in an archived thread opens it again and continues the same session.
- **Logging.** The trace file is mode 600 and is cleared at each start. Message text in it is cut to 80 characters. The token is never logged.

## Tools for the agent

| Tool | What it does |
| --- | --- |
| `discord_send(channel_id, content, reply_to?, silent?)` | Send a message. Markdown. Long text is split safely. |
| `discord_send_file(channel_id, path, caption?)` | Upload a local file, up to 10 MiB. |
| `discord_typing(channel_id)` | Show the typing indicator for about 10 s. |
| `discord_create_thread(channel_id, name, message_id?)` | Open a thread and return its ID. |
| `discord_react(channel_id, message_id, emoji)` | Add a reaction: a unicode emoji or `name:id`. |
| `discord_user(user_id)` | Look up a user's public profile. |

## Remove

1. Delete the `discord` row from `cordis.patch.yml`.
2. Remove the plugin as in the top-level README.
3. Optional: delete `~/.dsh/discord-plugin-sessions.json` and `~/.dsh/discord-plugin-trace.log`, and remove `DISCORD_BOT_TOKEN` from the credential store.
4. Optional: delete the bot in the Discord developer portal.

## Tests

From the repository root:

```bash
npm install --no-save @deepseek-ai/schemastery @deepseek-ai/dsh-llm@next @deepseek-ai/dsh-brand@next @deepseek-ai/dsh-tools@next
node plugins/discord/test/smoke.mjs
```

The tests need no Discord token. To test against the host packages inside a DSH app bundle instead, set `APP_MODULES` to that bundle's `node_modules` folder.

## Layout

```
plugins/discord/
├── package.json        bundle manifest
├── cordis.patch.yml    the row the bundle inserts
├── lib/index.js        plugin entry: name, inject, Config, apply
├── lib/client.js       Discord REST + gateway (identify, heartbeat, resume, slash commands, files)
├── lib/router.js       gates, threads, sessions, queues, typing, renames
├── lib/store.js        thread-to-session map (atomic JSON)
├── lib/llm.js          one-shot title call
├── lib/titles.js       title cleaning, fallback, uniqueness
├── lib/split.js        fence-aware 2000-character split
├── lib/tools.js        the six agent tools
├── lib/trace.js        event trace
└── test/smoke.mjs      unit tests, no token needed
```
