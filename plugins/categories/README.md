# Categories

Categories group your DSH workspaces in DSH's session list: a header for each category over its workspaces, then **Other workspaces** for the rest. The plugin works on its own; with the coordinator plugin on too, each decorates DSH's own rows, so a coordinating chat and its threads stay in their workspace and the workspace sits in its category.

## In the window

- **Session list.** DSH's list is grouped by category: a header for each category (its name and how many workspaces it holds) over its workspaces, then **Other workspaces** for the rest. With no categories yet, Other workspaces heads the whole list, so its **⋯** can make the first. Click a header, or press Enter or Space on it, to fold it; → opens it, ← folds it, and ↑ and ↓ go to the next header. A folded category shows a dot when one of its chats waits on you or runs. A header's **⋯** (or a right-click, Shift+F10 or the context-menu key on the header) opens its menu; opened by a key, the keyboard goes to its ⋯, so ↓ walks the menu and Escape gives the keyboard back there, where the header's keys still work. A category's menu adds a workspace to it (those in no category first, then those in other categories, with where each is now), makes a new workspace in it, moves it up or down, renames or deletes it, or makes a new category; Alt+↑ and Alt+↓ move it too. Other workspaces' menu makes a new workspace or a new category. **New workspace…** runs DSH's own Add workspace (the folder dialog of its button over the list) and files the workspace DSH makes in that category, or in none from Other workspaces; a folder DSH already has adds no workspace, so nothing is filed. Drag a header to move its category, or a workspace's row onto a header or another workspace's row to file it there; DSH's own drop line shows where it goes. Delete asks first, and the category's workspaces go to Other workspaces. A change the plugin refuses says why: in DSH's banner at the top of the window, or under the field of the dialog that asked for it. A screen reader hears each workspace's category (*in Shop*) and what each change did.

  DSH has no seat for a header in its list, so the headers are the plugin's own elements, and CSS sets each workspace's section under its category, one step in by DSH's own workspace indent (`sidebarRules` in `lib/client.js`). The CSS goes by attributes the plugin puts on DSH's list and its sections, kept in step at every change to the list (`markList`), never by what an element holds, so a change in one workspace restyles that workspace, even in a list of hundreds of chats. DSH's rows, their order within a workspace, its view options and its search stay its own; **In one list** and search results show no headers, and a folder's nested workspaces in Workspace Tree keep DSH's own drag.
- **Categories page.** **Categories** in DSH's sidebar, next to Plugins and Automation tasks, opens a page with the whole tree: each category with its workspaces in DSH's order, each workspace with its sessions in DSH's order, and last **Other workspaces**, the ones in no category. Every session DSH lists is there, except archived ones and an empty **New Session**, each by its DSH title and with DSH's own dot when it runs or waits on you (named for screen readers). Each row says what it is: a category reads *Category · 3 workspaces*, and a workspace shows its folder, so a category and a workspace can share a name and still look apart. **Find by name**, above the tree, keeps every category, workspace or session whose name holds what you type (in any case), each where it lives and with what's in it, the words in bold; ↓ goes into the tree, Escape or its **×** clears it, and what you close while finding is forgotten when the find changes. The heading counts the categories, and **New category** makes one, last in the list; you file workspaces into it in the session list. A note names the categories the one-time import made from the old sidebar, and says their old instructions, files and defaults for new sessions weren't carried over, until you dismiss it. The tree is one tab stop: ↑ and ↓ go through it as drawn, → opens a row or goes into it, ← closes it or goes to its parent, Home and End go to the ends, and Enter or a click opens a session, or opens and closes a category or a workspace; a row's chevron opens and closes it. Alt+↑ and Alt+↓ move the category or workspace that has the focus, and the focus stays on it: a workspace moves past its neighbour, and from the top or bottom of its category into the one above (at its end) or below (at its start), opening it, or into Other workspaces past the last category. Each move is said, and so is the reason when an item can't go further (the first or last already, or Other workspaces, which always comes last). A session's place stays DSH's. A category's row has the session list's **⋯** menu, and Other workspaces' row makes a new workspace or a new category. A workspace's row has a menu of its own, which DSH's session list has no place for: **Move to** another category or Other workspaces, **New category with it…**, and Move up and Move down in its category. ⋯ shows while a row is pointed at, has the focus or has its menu open; a right-click, Shift+F10 or the context-menu key opens it too, with the keyboard on the menu's button as in the session list. Each change is said, or refused with the reason, as in the session list.
- **At the top of a session.** A session whose workspace is in a category shows *Category / workspace* among DSH's header buttons, just before the coordinator plugin's **Threads** menu when that plugin is on; a subagent's or a teammate's shows its parent's. It follows the categories, so a rename or a workspace filed elsewhere shows there too. A click opens the Categories page; where DSH offers no way to it, it is plain text. A screen reader hears *Category: Shop, workspace storefront*. A long name stays on one line and ends in "…", giving way before the session's title does, and the chip hides where the header is narrow (a pane open beside the session). Nothing shows for a blank, archived or unknown session, or one whose workspace is in no category.
- **What the window keeps.** The folded categories, the rows closed on the page and a dismissed note are kept in the window's own storage, under `dsh-plugin-categories/`, so they hold across restarts. They start fresh: what the projects plugin kept for its own categories isn't read.

Every control the plugin draws shows DSH's focus ring when you reach it with the keyboard. The browser half reads only DSH's own lists (workspaces, sessions and their status) and this plugin's endpoints; it reads no other plugin's data or marks.

## How it works

The plugin keeps its own store, `~/.dsh/categories/categories.json` (in `$DSH_HOME` when DSH runs with one): each category's name and place in the list, and which category each workspace is in. A workspace is in one category at most. The store and the log beside it are mode 600, in a folder of mode 700. The log holds ids and counts.

DSH keeps one workspace order for every window, and its session list draws it. The plugin keeps that order in step with the categories, through the same call DSH's own workspace drag makes: each category's workspaces together, the categories in their order, then the workspaces in none. It moves as few workspaces as it can. A workspace DSH adds later (DSH puts a new one first) goes back among the ones in none the next time the window lists the categories.

Deleting a category deletes nothing in DSH: its workspaces and their chats go to Other workspaces.

### Once, at the first start

Two moves run once, when the plugin starts in a DSH for the first time (before its store exists):

1. **Categories from the projects plugin.** Before this plugin, the projects plugin kept the categories, in its store (`~/.dsh/projects/projects.json`). Whatever categories that store holds when the plugin first starts come over exactly as they are: the same ids, names, order and workspaces. None is renamed or left out, including one with the same id as a ◆ project. A workspace placed in one that DSH no longer has stays recorded and isn't shown. The projects store is only read; it is copied first to `~/.dsh/categories/from-projects.json` (a later move never overwrites that copy).
2. **Your old sidebar, only when there were no categories yet.** The all-in-one mod's old sidebar kept projects of workspaces in `~/.dsh/fleet-shell/state.json`. When the projects store has categories, they are your categories as you left them (some made from this file, perhaps deleted since), so the old file isn't read at all. Otherwise (no projects store, or one from before categories) each old project becomes a category, in the same order, holding the same workspaces. Only names and which workspaces each held come over: the old instructions, files and defaults stay behind. A name that is already a category here joins it; a workspace already in a category, or one DSH no longer has, stays where it is. The old file is only read, and an import the projects plugin already made isn't made again.

A projects store from before categories, where projects were also groups of workspaces, gives its groups as categories, except a project that has a coordinator and holds only its own workspace: that one stays a project, not a category.

A store that can't be read (other than missing) is logged, and its move is tried again at the next start.

To see what both will do before the first start, without changing anything:

```bash
node plugins/categories/scripts/import-preview.mjs
```

It reads `$DSH_HOME` (else `~/.dsh`); once the moves have run, it says when.

The projects plugin keeps its old categories in its own store as they were, so an older version of it still finds them. Neither plugin reads or writes the other's data after this one move.

Each start reads the store from its file. Switched off in DSH's Plugins page (or reloaded by a config change), the plugin stops changing anything, and switched on again it starts from the file as it is then.

## Setup

1. Install the plugin as in the [root README](../../README.md#install-a-plugin):

   ```bash
   dsh plugin --profile desktop add ~/.dsh-plugins/dsh-public-plugins/plugins/categories
   ```

   That adds `dsh-plugin-categories` to the profile's `package.json` (`dependencies` and `dsh.profile.bundles`). The plugin's bundle adds its row (`id: categories`); it needs no config.

2. Restart DSH Desktop once so it loads the new bundle. The categories you had come over at that start (see above), and the session list shows them.

### Config

Optional, in the profile's `cordis.patch.yml`, addressing the plugin's row by id:

```yaml
- id: categories
  config:
    storeFile: ~/.dsh/categories/categories.json
    logFile: ~/.dsh/categories/categories.log
    projectsStoreFile: ~/.dsh/projects/projects.json
```

| Key | Default | What it is |
| --- | --- | --- |
| `enabled` | `true` | Off: no headers, no endpoints; DSH's list as it is. |
| `storeFile` | `~/.dsh/categories/categories.json` | The categories and their workspaces. |
| `logFile` | `~/.dsh/categories/categories.log` | Action log (ids and counts). Empty turns it off. |
| `projectsStoreFile` | `~/.dsh/projects/projects.json` | The projects plugin's store, read once at the first start. Empty skips that move. |

A path under `~/.dsh` follows `$DSH_HOME`.

## Tests

```bash
node plugins/categories/test/smoke.mjs
node plugins/categories/test/client.mjs
```

The smoke tests run the host half against a fake Host: categories and their workspaces in DSH's order, the refusals, the one-time move from the projects store (its categories exactly as they are with the old sidebar left unread, groups from before them without a project that has a coordinator in its own workspace, nothing to move, a store that can't be read yet), a switch-off and on that reads the file again, the old sidebar's import and the preview script.

The browser half's tests load `lib/client.js` the way DSH does, with stand-ins for React and DSH's own parts, and draw its views: the session list by category with its headers' menus, keys and drags, New workspace… through DSH's own Add workspace, the Categories page with its tree, keys, moves and find, the chip at the top of a session, the endpoints over DSH's connection, and that the projects plugin's data changes nothing here. They need no DSH, and `npm test` runs them too.

The end-to-end test boots a real DSH (the web profile, in a temporary `DSH_HOME`) with this plugin and session-bridge. A first start makes DSH's workspaces; then a projects store shaped like the user's (four categories, one with a ◆ project's id, a placement of a workspace that's gone) and an old sidebar file still naming deleted categories are put where the user's are, and the next start moves the categories over once, exactly as they are, without reading the old file (the projects store and the old file untouched, a copy kept, the files private). It checks DSH's own workspace order, that DSH serves the browser half and it parses, the endpoints as the window calls them (make, file before another, move, rename, delete, the refusals) and a restart that changes nothing. With `COORDINATOR=1` the coordinator plugin runs beside it: each answers only for its own, the projects store stays as it was, and the coordinator logs nothing about categories.

```bash
npm install --prefix /tmp/dsh @deepseek-ai/dsh
DSH_BIN=/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js node plugins/categories/test/e2e/run.mjs
DSH_BIN=/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js COORDINATOR=1 node plugins/categories/test/e2e/run.mjs
```
