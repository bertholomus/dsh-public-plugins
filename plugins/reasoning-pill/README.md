# Reasoning pill

One place to set reasoning in DeepSeek Harness Desktop. A **Reasoning: …** control sits beside the model name in
the composer and changes the session's reasoning effort. While it runs, DSH's own Effort row in the model menu and
the effort caption on the model button are hidden, so there is one reasoning control and nothing to disagree with
it. The plugin keeps no data, has no settings and adds no routes.

![The control in an open chat's composer, with its menu open above it](../../screenshots/reasoning-pill/chat-menu-open-light.png)

## What it does

- **Shows the level the next turn goes out with.** "Reasoning: High" sits just before the model button, in the
  new-chat composer and in every open chat (not in a subagent's chat, where DSH shows no model button and allows no
  model change). It reads the session's model from DSH (the session's model directory,
  which DSH's model button reads too), so it follows a change of model and a reload.
- **Changes it.** A click opens DSH's own menu with the model's levels in DSH's words (for example Default, Low,
  Medium, High, Xhigh, Max: whatever the model's provider row lists), with DSH's check on the current one. The menu
  opens above the control, as DSH's model menu opens above its button, so it never covers the control, the message
  box's right edge or the status line. A second click on the control closes it without a pick, and a click anywhere
  else closes it and leaves the focus where you clicked (the message box takes your typing; DSH's model button opens
  its menu at once). A pick shows at once and goes to DSH through the same call as DSH's Effort row; the next request
  to the model carries it (`reasoning_effort`), and the session's log records it. **Default** sends no level, so the
  model uses its own; it is listed only for a model that names no default level of its own.
- **One level per chat.** Each chat keeps its own level: switch chats and the control shows that chat's level, and
  its next turn goes out at it. A pick in one chat leaves the others alone.
- **New chats start at your last pick.** DSH keeps every model pick, its Effort row's too, as its default for new
  chats (the `agent-default-model` row of the profile). So a pick here also sets the level the next new chat starts
  with. That is DSH's rule, not this plugin's, and it is the same with the plugin off.
- **One place for reasoning.** While the plugin runs, the Effort row in DSH's model menu and the effort caption on
  the model button are hidden. The Model row and picking a model work as before. Switched off, both come back at
  once. [DSH's own look](#dshs-own-look) says why this is allowed.
- **Says when it can't.**
  - A model with no reasoning levels shows **Reasoning: None**. It opens nothing, but it still takes the keyboard
    focus, and its tooltip and name say "<model> has no reasoning levels." The levels come from the model's provider
    row (`reasoningEfforts` in the profile); a row without them shows None. For a Bertnet Gateway row that lost its
    levels, Fleet's Repair puts them back.
  - When the session's model is no longer in DSH's model list, the control keeps showing the session's level, and
    its tooltip says to pick a model with the model button first.
  - While a pick is on its way, the control ignores clicks and screen readers hear "changing".
  - When DSH refuses a pick, it says so the way DSH says a model pick was refused: DSH's banner at the top of the
    window, read out at once, held long enough to read (5 to 12 seconds by length). The words are plain and say what
    to do next: "Reasoning not changed: DSH isn't reachable. Try again when it reconnects." when DSH is cut off; DSH's
    own sentence when another running DSH holds the session ("This session is already in use, … Quit other running DSH
    instances and try again."); "The model isn't available now. Pick a model with the model button, then try again."
    when the model is gone; and "DSH didn't take the change. Try again." for anything else. DSH's raw reason goes to
    the window's console, never on screen. The control keeps showing the level still in force, with a small warning
    mark and the same words in its tooltip and name, until the next pick, a switch to another chat, or DSH clearing
    the error (as when it reconnects).
- **Fits the composer.** It looks like DSH's model button (DSH's type, colour, height and corners, no ground of its
  own) in light and dark. When the composer is too narrow for words, DSH shows its controls as icons, and the
  control shows a gauge icon; the level stays in its tooltip and name.

## Keyboard and screen readers

- Tab reaches the control just before the model button, in the order you see them. Enter or Space opens the menu,
  the arrow keys move, Enter picks, Escape closes without a change. DSH's menu gives the focus back to the control
  after a pick or Escape, as all of DSH's menus do (DSH hides the ring until the next key that moves the focus). A
  click outside the menu only closes it: the focus stays where you clicked.
- The control's name reads "Reasoning effort: High". In the menu, the current level reads "High, current". A pick
  is announced ("Reasoning effort: Low") once DSH confirms it; a refusal is announced at once by DSH's banner (an
  alert), and the control's name keeps the reason ("Reasoning effort: High. Reasoning not changed: …").
- The only motion is DSH's hover fade. It stops under the system's Reduce motion and under Wallpaper's Motion off
  (`body.wp-still`). The control paints no translucent ground, so Reduce transparency changes nothing on it; DSH's
  menu keeps its own material.

## Config

None. The profile row has no keys (`cordis.patch.yml` in this folder):

```yaml
- id: reasoning-pill
  name: dsh-plugin-reasoning-pill
```

## Switch it off, remove it, roll back

- **Off:** switch it off on DSH's Plugins page, or add `disabled: true` to its row. DSH applies it live: the
  control, its style sheet and its marks on DSH's menu go, and DSH's Effort row and caption come back. On again,
  nothing is doubled.
- **Remove:** quit DSH, run `scripts/uninstall.sh reasoning-pill` (it takes only this plugin out of the desktop
  profile: its package entry and links; it refuses while DSH runs, and with no name it would remove all three plugins
  of this repo), then delete the `reasoning-pill` row from the profile's `cordis.patch.yml` and start DSH. The plugin
  writes no files, so nothing else is left behind. Levels you picked stay in DSH's sessions and default, as they
  would after using DSH's own Effort row.
- **Roll back:** the plugin is code only, so going back is checking out the earlier commit in the checkout the live
  DSH loads and restarting DSH.

## Try it in DSH Test

Nothing else to load and no config to add:

```bash
dsh-test --name rp load plugins/reasoning-pill
dsh-test --name rp up && dsh-test --name rp doctor
```

DSH Test's seed models have levels (glm-5.3-flash lists Low to Max), so the menu shows them. To see **None**,
pick a model whose provider row has no `reasoningEfforts`.

## Tests

```bash
node plugins/reasoning-pill/test/unit.test.mjs   # offline, under a second (or: cd plugins/reasoning-pill && npm test)
node scripts/e2e.mjs reasoning-pill              # real DSH, every build, 80 to 160 s each
```

**Unit** (`test/unit.test.mjs`, 27 checks): the file loads as DSH loads it (one script, a factory given `require`)
and never throws without DSH's parts; what the control shows for every model state (levels with and without a
default of their own, a saved level, a pick on its way, no levels, a model gone from the list, levels from the
catalog, malformed levels); no control in a subagent's chat; the selection sent to DSH (Default sends no level), one
selection a pick and none for the level already in force; the refusal words for each kind of refusal (DSH cut off,
the session held by another DSH, the model gone, anything else), never DSH's raw text, and how long DSH's banner
holds them; DSH's menu part set up as DSH's model button sets up its own (above the control, at its right edge, in
the page's body), with a close that only closes; the Effort-row label in both of DSH's languages; the row hider and
when its observer looks; the style sheet against DESIGN.md (own prefix, DSH tokens only, no ground, no DSH hash,
nothing on `:root`, `html` or `body`, motion stops); setup and switch-off (style sheet, observer and slot entry added
once and removed); a setup step that throws is caught; the host half is empty; the manifest, locale and README agree;
and no assistant or vendor names in the plugin's files or the test bench.

**Real DSH** (`test/e2e/run.mjs`, 70 checks a build): DSH runs in a throwaway home with a scripted model server
(`test/e2e/model.mjs`: the repository's stand-in, plus a call to DSH's subagent tool) that records the reasoning
effort DSH sends, and a Chromium works its window as a person would. Each claim above is checked where it lands: in
the window, in the request the model gets, in the session's own log and in DSH's profile. It covers one control and
its place, DSH's look, the hidden caption, the Tab order, the keyboard menu (arrows, Enter, Escape, focus back) and a
pick reaching the model as `low`. Then, in the open chat: the menu above the control, clear of the control and the
status line, as DSH's model menu is (in light and dark); a second click closing it with nothing picked; a click in the
message box with the menu open (the focus stays there and typing lands there); one click on DSH's model button with
the menu open opening DSH's menu. Then the hidden Effort row (hidden as soon as the menu shows) with a working Model
row, None for a model without levels, a pointer pick of Max on a two-level model reaching the model as `max`, DSH's
default save, contrast of 4.5:1 or more in dark and light, a reload, two chats switched back and forth (each shows its
own level and its next turn goes out at it), a subagent's chat (no control), reduced motion, Wallpaper's Motion off,
reduced transparency, a 760 px window, DSH's icon-only composer, switching off and on live (the Effort row back, then
hidden again), and no errors in the window or DSH's log. Last, DSH's host is stopped: a pick brings DSH's banner with
the plain words, the level in force stays with the warning mark and the reason in its name and tooltip, no raw text
shows, nothing reaches the session's log, and once DSH is back the mark goes (the window reconnects; when DSH leaves
its window blank after the restart, as it sometimes does with no plugin at all, the bench reloads it as a person would
and says so).

- **Builds:** the npm builds 0.2.0-rc.2 and 0.2.1-rc.1, and the DSH inside the installed app (0.2.1-rc.3), which
  runs as a separate process in its own throwaway home; the running app is never touched. `--dsh 0.2.1-rc.1` or
  `--dsh app` runs one.
- **Setup:** the runtimes are found in `<repo>/.e2e` (a link to `~/Projects/dsh-plugin-suite/.e2e` is fine), else
  `DSH_E2E_DIR`, else `~/Projects/dsh-plugin-suite/.e2e`; Playwright is `playwright-core` under `.e2e/tools` (or
  `PLAYWRIGHT_MODULE`). An npm build installs with `npm i --prefix .e2e/dsh-<version> @deepseek-ai/dsh@<version>`.
- **Pictures:** `.shots/reasoning-pill/<build>/` (`E2E_SHOTS=<dir>` elsewhere, `NO_SHOTS=1` for none): the
  new-chat composer and its menu open in light and in reduced transparency, an open chat with the menu open in light
  and dark, DSH's model menu with and without the plugin, a model with no levels, a chat in light and dark, two chats
  switched back, a subagent's chat, 760 px in light and dark, the icon-only composer, and a refused pick with DSH's
  banner.
  A set from the app's DSH is in [`screenshots/reasoning-pill/`](../../screenshots/reasoning-pill).
- **Safety:** the runner reads the live DSH's fingerprint (pid, start time, profile hash) before and after, and
  fails when it moved. `KEEP=1` keeps the throwaway folder.

## DSH's own look

Hiding DSH's Effort row and effort caption changes DSH's own look, which [DESIGN.md](../../DESIGN.md) allows only
with the user's OK and a line there. Albert asked for exactly this: "keep Fleet Shell's Reasoning pill beside the
model name; hide the Effort row inside DSH's model menu" ([bug batch, item 9](../../docs/NEXT-2026-10-08-bug-batch.md)),
and DESIGN.md lists it under Mods. How it is done:

- The Effort row is found by its label in DSH's words ("Effort", "推理等级") inside a menu, and gets one attribute,
  `data-reasoning-pill-hidden`; one rule hides what carries it. One MutationObserver looks only when a menu or a menu
  row is added, and marks the row before the menu is painted.
- The caption is `[class*="_triggerEffort"]` inside DSH's model slot, hidden only in a composer that holds the
  control (`[data-slot="conversation.composer.bar"]:has(.rp-root)`), so a composer without it keeps DSH's caption.
- Nothing of DSH's is moved, removed or rewritten. Switching off removes the mark, the rule and the control.

## Limits

- DSH ships its menus in English and Chinese. In a language whose Effort label is neither "Effort" nor "推理等级",
  the Effort row would show again beside the control; both still work and agree.
- A pick also becomes DSH's default for new chats (DSH's rule, above).
- The control is in composers (DSH's `conversation.input.right` slot): the new chat and open chats, except a
  subagent's chat, as with DSH's model button.
- While DSH is cut off from its host, a pick can't reach it: DSH's banner says so, the level in force stays, and the
  control keeps a warning mark until DSH is back or the next pick.
- Until the session has a model (a DSH with no provider yet), the control doesn't show; the model button comes first.
- It shows the levels the provider row lists; it can't offer a level the row lacks.

## Files

- `lib/client.js`: the control, the Effort-row hider and the style sheet, hand-written React (no build step).
- `lib/index.js`: an empty host half, so DSH can load the plugin.
- `locale/en.json`, `icon.svg`: the name, description and icon in DSH's Plugins page.
- `cordis.patch.yml`: the profile row.
- `test/unit.test.mjs`, `test/e2e/run.mjs`: the tests above; `test/e2e/model.mjs`: their scripted model.
