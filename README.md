# dsh-public-plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Desktop.

Each plugin is a normal DSH plugin package. You add it to a DSH profile's bundles and set it up in the profile's `cordis.patch.yml`. Setup changes apply without a restart when the profile uses `patchReload: live`.

| Plugin | What it does |
| --- | --- |
| [`dsh-site`](plugins/dsh-site) | Serves the running DSH Desktop GUI to other devices on a private network (for example a Tailscale tailnet). Same sessions, same workspaces, same tools as the machine itself. |
| [`discord`](plugins/discord) | Connects a Discord bot to DSH sessions. Each Discord thread is one persistent agent session, and the agent answers through Discord tools. Full bot setup steps are in its README. |
| [`categories`](plugins/categories) | Categories of workspaces in DSH's session list: a header per category over its workspaces, Other workspaces for the rest, made and arranged from the list or the Categories page. |
| [`coordinator`](plugins/coordinator) | Any chat can run its work in threads. The chat starts thread sessions for focused work, each thread reports back to it, and threads keep their own model, effort and permission. |
| [`calendar`](plugins/calendar) | Your calendars, for you and your agents: iCloud, Google, Microsoft 365 and Exchange Online, Fastmail, Nextcloud and other CalDAV servers, subscribed `.ics` feeds, and calendars on this computer. Agents read them and, as their permission allows, change them. |
| [`session-bridge`](plugins/session-bridge) | A local JSON API on a Unix socket that drives the Host's own session controller. Scripts and other agents can create, prompt, steer, cancel and read DSH sessions, and you watch them live in the DSH window. |
| [`session-watch`](plugins/session-watch) | The shared watcher behind Autopilot, Decisions and Agent Terminals: every session's state from DSH's own events, and delivery of a message proven by the session's own log. No page of its own. |
| [`autopilot`](plugins/autopilot) | Keeps sessions moving when nobody is watching: after a restart it tells cut-off sessions to carry on, nudges quiet sessions with open todos once and backs off, and restarts goals an error stopped. Every action has a Why line and a kill switch. |
| [`decisions`](plugins/decisions) | One inbox for everything waiting on you: decision lines, tools waiting for approval, questions in the question box, threads that need a decision. Each card shows the question, the recommendation, the session and the wait; an answer goes into the session, proven by its log. Optional note to a webhook or a command. |
| [`agent-terminals`](plugins/agent-terminals) | Command-line coding agents as part of DSH: each in a terminal tab beside its own session, started again after a restart and resuming its conversation, with your messages typed in one at a time and proven read from its transcript, and what it is doing (working, idle, waiting on you) on its session's row and in Decisions. |
| [`proof`](plugins/proof) | Checks every claim of done, passed, fixed or deployed against what its turn ran, flags the ones nothing shows, and keeps a ledger you can export. An independent read-only check on a local model, when you want one. |
| [`canon`](plugins/canon) | Shared long-term memory: before a turn, the few active notes of your canon vault (an Obsidian folder) that fit the session's folder and prompt, as one short block that names each note's path. Reads the vault only, unless you allow draft notes; only you can promote a draft. |
| [`recall`](plugins/recall) | Searches everything already done: a local full-text index of DSH sessions, transcript folders and handoff notes, with filters by folder, model, date and kind. A result opens its session at that exact turn, and agents search the same index with the `recall_search` tool. |
| [`wallpaper`](plugins/wallpaper) | Wallpaper and glass for DSH Desktop: a wallpaper library with rotation and colours, frosted glass on the sidebar, conversation, composer and right panel, motion, and an editable headline. Visual only. |
| [`reasoning-pill`](plugins/reasoning-pill) | One reasoning control: a Reasoning pill beside the model name in the composer, in place of DSH's Effort row in the model menu. |

Session Watch, Autopilot, Decisions, Agent Terminals, Proof, Canon and Recall make up the DSH Plugin Suite: how they fit together, how to install all of them, and how each was tested and judged are in [SUITE.md](SUITE.md).

These plugins are independent work. They are not made or endorsed by DeepSeek.

## Install a plugin

DSH loads a plugin only when the profile lists its package in `dsh.profile.bundles`. The plugin's bundle then adds the plugin's row, and you configure that row in the profile's `cordis.patch.yml`. The examples use the default desktop profile at `~/.dsh/profiles/desktop` and the `coordinator` plugin.

| Plugin | Package | Row id |
| --- | --- | --- |
| dsh-site | `dsh-plugin-dsh-site` | `dsh-site` |
| discord | `dsh-plugin-discord` | `discord` |
| categories | `dsh-plugin-categories` | `categories` |
| coordinator | `dsh-plugin-coordinator` | `coordinator` |
| calendar | `dsh-plugin-calendar` | `calendar` |
| session-bridge | `dsh-plugin-session-bridge` | `session-bridge` |
| session-watch | `dsh-plugin-session-watch` | `session-watch` |
| autopilot | `dsh-plugin-autopilot` | `autopilot` |
| decisions | `dsh-plugin-decisions` | `decisions` |
| agent-terminals | `dsh-plugin-agent-terminals` | `agent-terminals` |
| proof | `dsh-plugin-proof` | `proof` |
| canon | `dsh-plugin-canon` | `canon` |
| recall | `dsh-plugin-recall` | `recall` |
| wallpaper | `dsh-plugin-wallpaper` | `wallpaper` |
| reasoning-pill | `dsh-plugin-reasoning-pill` | `reasoning-pill` |

1. Clone this repository:

   ```bash
   git clone https://github.com/bertholomus/dsh-public-plugins ~/.dsh-plugins/dsh-public-plugins
   ```

2. Back up the two profile files:

   ```bash
   cd ~/.dsh/profiles/desktop
   ts=$(date -u +%Y%m%dT%H%M%SZ)
   cp cordis.patch.yml cordis.patch.yml.bak-$ts
   cp package.json package.json.bak-$ts
   ```

3. Add the plugin to the profile with the `dsh` command that DSH Desktop installs. The `dsh` from npm refuses to change the desktop profile.

   ```bash
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/coordinator
   ```

   This links the package into the profile and adds it to `dsh.profile.bundles`. To do the same by hand, in `~/.dsh/profiles/desktop`:

   - In `package.json`, add `"dsh-plugin-coordinator": "link:/Users/<you>/.dsh-plugins/dsh-public-plugins/plugins/coordinator"` to `dependencies`.
   - In the same file, add `"dsh-plugin-coordinator"` to the end of `dsh.profile.bundles`.
   - Link it into `node_modules`: `ln -s ~/.dsh-plugins/dsh-public-plugins/plugins/coordinator node_modules/dsh-plugin-coordinator`

   Nothing else needs installing. The plugins list `@deepseek-ai/schemastery` and the DSH packages they use as `peerDependencies`, and DSH gives them its own copies. Keep them as peers in your own copy of a plugin. DSH doesn't look in the profile's `node_modules` for a linked plugin's `dependencies`, so a plugin that lists them there fails to import unless its own folder has them installed.

4. Configure the plugin in `cordis.patch.yml`. Its bundle already adds the row, so address the row by its id and give it a `config`. Each plugin README gives its config.

   ```yaml
   - id: coordinator
     config:
       # the plugin's settings
   ```

5. Restart DSH Desktop. A running DSH does not load new bundles. After that, changes to the row apply live when the profile uses `patchReload: live`.

A row added with `insert` while the bundle is also listed still works, because the configured row is the one that runs. The address form above avoids the duplicate row.

## Remove a plugin

1. Delete its row from `cordis.patch.yml`.
2. In `package.json`, delete the package from `dsh.profile.bundles` and its dependency.
3. Remove the `node_modules/dsh-plugin-*` symlink.
4. Restart DSH Desktop.

Or restore the backups from step 2 of the install.

## Tests

```bash
npm test                                  # dsh-site, session-bridge, coordinator (pure logic), the categories window, calendar, session-watch, autopilot, decisions
npm install --no-save @deepseek-ai/schemastery @deepseek-ai/dsh-llm@next @deepseek-ai/dsh-brand@next @deepseek-ai/dsh-tools@next
node plugins/discord/test/smoke.mjs       # discord (no token needed)
node plugins/coordinator/test/smoke.mjs   # coordinator (fake DSH host)
node plugins/coordinator/test/client.mjs  # coordinator's window half
node plugins/categories/test/smoke.mjs    # categories (fake DSH host)

# coordinator + session-bridge on a real DSH, with a scripted model server
npm install --prefix /tmp/dsh @deepseek-ai/dsh
DSH_BIN=/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js npm run test:e2e

# categories + session-bridge on a real DSH
DSH_BIN=/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js npm run test:e2e:categories

# calendar + session-bridge on a real DSH (RADICALE_VENV, a virtualenv with radicale, adds a CalDAV account)
DSH_BIN=/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js npm run test:e2e:calendar

# autopilot + session-watch on a real DSH in a throwaway home: every DSH under .e2e/ and the installed app's (see plugins/autopilot/README.md)
npm run test:e2e:autopilot

# decisions + session-watch + autopilot on a real DSH in a throwaway home, with a stand-in webhook on this machine (see plugins/decisions/README.md)
npm run test:e2e:decisions

# any suite plugin (autopilot, decisions, agent-terminals, proof, canon, recall) on every DSH under .e2e/ and the installed app's
node scripts/e2e.mjs proof
```

## License

MIT
