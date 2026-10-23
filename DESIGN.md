# Design rules for DSH plugins

These are the rules for building or changing a DSH plugin in this repository, and for a mod: a plugin that changes how DSH itself looks. They keep every plugin looking like part of DSH, and they keep the Wallpaper plugin's glass whole across DSH and every other plugin.

They come from what already works:

- DSH 0.2.0-rc.2 and 0.2.1-alpha.2: their token sheets, their parts (`@deepseek-ai/dsh-client-ui-primitives`), their layout and their slots. Unless a line says otherwise, every token, part and slot named here is the same in both.
- The Wallpaper and Fleet plugins, which live on the user's Mac, outside this repository (read at their commit c14deb5).
- The coordinator, categories and calendar plugins here, and the reviews of their windows.
- A check on 2026-10-12 in real DSH windows of both versions, with Wallpaper's rules applied over a test picture.

[Where things stand](#where-things-stand) lists what doesn't follow these rules yet. Don't copy it; fix it in that plugin's own change.

## The rules on one page

1. **Own only your own.** A plugin reads and writes only its own data and its own elements. It styles nothing of DSH's or another plugin's, except DSH elements that carry its own mark (an attribute it set, or a link to one of its own items). Only a mod restyles DSH, and Wallpaper is the only one.
2. **Wallpaper changes grounds, not content.** It turns DSH's backgrounds into glass and leaves DSH's text, icons and controls as they are. Do the same: glass under your content, DSH's tokens and parts for everything on it.
3. **Know which surface you are on.** Inside one of DSH's surfaces (the session list, a chat, the composer, a header, a right-sidebar tab, a DSH dialog or menu), paint no ground of your own. On a surface you own whole (a page in `main`, a pane you lay out), leave the root unpainted and put your content on glass cards.
4. **Read only Wallpaper's public values**: `--wp-blur`, `--wp-tint` and `body.wp-still`, always with their fallbacks, and DSH's `data-ds-dark-theme` on `<body>` for dark.
5. **Blur once.** Nothing inside glass blurs again: a card inside your own glass card gets a faint fill, and a card inside DSH's surfaces draws like DSH's own cards.
6. **Text needs a ground.** Dense text sits on glass at tint + .2, secondary text and icons on glass are deepened toward DSH's label colour, and no text sits on the bare wall. Text reaches 4.5:1 and icons and lines 3:1, in both themes.
7. **Floating layers are DSH's**: its Menu, MenuSurface, Modal, Toast, Tooltip, HoverCard and RiskConfirmation, at DSH's stacking levels.
8. **Reach DSH by its public structure**: slots, `data-slot` outlets, row keys, roles and your own marks. Never by a generated class name.
9. **Scope everything under your prefix**: tokens on your own root classes (never `:root`, `html` or `body`), and one prefix for classes, attributes, storage keys and entry ids.
10. **Respect the user's settings.** Stop motion under `body.wp-still` and `prefers-reduced-motion`, pseudo-elements too. Make glass near-opaque under `prefers-reduced-transparency`.
11. **Leave nothing behind.** Switched off, a plugin leaves no entry, mark, header or rule. Switched on again, it repeats no one-time work.
12. **Check it before you call it done**: both DSH versions, both themes, Wallpaper on and off over a light and a dark picture at a low tint, at the sizes in section 10. Never on the user's live DSH.

## 1. How the window is built

A ground, here, is what something is drawn on: a fill, with or without a blur. From the bottom up:

| Layer | What it is | Drawn by |
| --- | --- | --- |
| Ground | `body`'s background, `--dsw-alias-bg-base` (#fff light, #151517 dark) | DSH |
| Wall | `#wp-wall`: fixed, `inset:0`, `z-index:0`; the picture or colour, its frost and its scrim | Wallpaper, while it is on |
| Frame | `#root` (lifted to `z-index:1` by Wallpaper), DSH's frame and its three columns | DSH; Wallpaper makes them transparent |
| DSH's surfaces | The sidebar, the open chat, the right dock and the composer | DSH; Wallpaper turns them into glass |
| Content | DSH's rows, messages and headers, and what plugins put in DSH's slots. No ground of its own, so it shows the surface under it | DSH and plugins |
| A plugin's own surface | A page in `main`, or a pane the plugin lays out: an unpainted root with glass cards | the plugin |
| Floating | Menus, hover cards and tooltips at `z-index` 100, dialogs at 1000, toasts and portaled menus and tooltips at 1100 | DSH's parts |

DSH's own layout keeps its in-page layers low (its resize handle at 11, the row seat at 15, its overlay layer at 20). Stay within these levels: content under 100, and floating layers only through DSH's parts.

### How the glass reaches everything

1. Wallpaper paints the wall, then clears DSH's frame and columns.
2. It turns four DSH surfaces into glass. The glass ground is `rgba(14,18,17,…)` in dark and `rgba(250,250,246,…)` in light:

   | Surface | Opacity | Blur | Corner |
   | --- | --- | --- | --- |
   | The sidebar | the tint | the blur, `saturate(140%)` | 18px |
   | The open chat | tint + .2 | the blur | DSH's own |
   | The right dock | the tint | the blur, `saturate(140%)` | 18px |
   | The composer | the tint, with a 1px line | the blur, `saturate(140%)` | 22px |

3. Everything inside those surfaces that paints no ground shows the glass: DSH's rows and messages, and any plugin content in DSH's slots. That is why the coordinator and the categories sidebar read right on glass without one line of Wallpaper code.
4. A card that paints its own ground stays a card on the glass, as DSH's message bubbles and cards do.
5. What Wallpaper doesn't touch stays as DSH draws it. Pages in `main` get no glass: DSH's own Plugins page shows its text straight on the wall, and a plugin page must bring its own cards. Menus, dialogs and toasts keep DSH's own material.

### DSH's own translucency

DSH has some glass of its own, which Wallpaper builds on:

- On macOS (`html[data-platform=darwin]`) DSH leaves its frame clear and draws the sidebar column as a translucent fill of `--dsw-specific-sidebar-fill`. Under `prefers-reduced-transparency: reduce` it raises that fill to 90%.
- DSH's menus are a material: `--dsw-menu-surface-fill` (light #f8f9fa94, dark #43454a73) behind `--dsw-menu-backdrop-filter` (`blur(40px) saturate(150%)`), near-opaque on macOS through `--dsw-specific-menu` (#f8f9faf0, #303136f0).

## 2. Two kinds of surface

| You are drawing | Its ground | Its colours and controls | Examples |
| --- | --- | --- | --- |
| Something inside a DSH surface: a row mark, a header control, a bar above the message box, a card in a chat, a right-sidebar tab, a settings form | None. A card draws like DSH's own cards there | DSH's tokens and parts | the coordinator; the categories sidebar |
| A surface you own whole: a page in `main`, a pane you lay out | The root unpainted; content on glass cards | DSH's tokens and parts | the calendar page; Fleet's page |
| A floating layer | DSH's own material | DSH's parts | menus, dialogs, toasts, tooltips |

- Inside a DSH surface the glass reaches you for free. A ground of your own would cover it.
- A card in a chat draws like DSH's own cards there: `--dsw-alias-bg-layer-1`, a `.5px` line in `--dsw-alias-border-l4`, `--dsw-radius-lg`. It never blurs, because the chat is already glass.
- A pane in DSH's right sidebar sits on the dock's glass: no fill and no blur (the calendar's Agenda pane).
- A bar above the message box goes in `conversation.input.dock`, drawn like DSH's goal bar: DSH's menu material (`--dsw-specific-menu` with `--dsw-menu-backdrop-filter`) and `--dsw-elevation-panel`.

## 3. Glass

### What Wallpaper publishes

| On `<body>` | Meaning | Read it as |
| --- | --- | --- |
| `--wp-blur` | The glass blur, 0 to 40px, default 22px | `var(--wp-blur,22px)` |
| `--wp-tint` | The glass opacity, .10 to .95, default .55 | `var(--wp-tint,.55)` |
| `body.wp-still` | Motion is off | stop every animation and transition |
| `body.wp-on` | Wallpaper is on | rarely needed: write rules that look right either way |
| `data-ds-dark-theme` | Dark is on (set by DSH, not Wallpaper) | `body:not([data-ds-dark-theme])` for light |

Don't read anything else of Wallpaper's. `--wp-op`, `--wp-frost` and `--wp-headline` only change the wall. Its colour tokens (`--wp-glass`, `--wp-text`, `--wp-accent` and the rest) are its own and exist only while it is on. A solid-colour wallpaper colours the wall, never the UI.

### Recipes

Define the grounds once, on your own root classes. Replace `x` with your prefix and list every root you have, portaled ones included:

```css
:is(.x-page,.x-pane){
  --x-glass:rgba(14,18,17,var(--wp-tint,.55));            /* side columns, navigation */
  --x-conv:rgba(10,13,12,calc(var(--wp-tint,.55) + .2));   /* the main view, dense text */
  --x-fill:rgba(255,255,255,.04);                           /* a card inside glass */
  /* DSH's text colours, deepened for glass (see "Text on glass") */
  --x-text-2:color-mix(in srgb,var(--dsw-alias-label-secondary) 80%,var(--dsw-alias-label-primary));
  --x-glyph:color-mix(in srgb,var(--dsw-alias-label-tertiary) 75%,var(--dsw-alias-label-primary));
}
body:not([data-ds-dark-theme]) :is(.x-page,.x-pane){
  --x-glass:rgba(250,250,246,var(--wp-tint,.55));
  --x-conv:rgba(250,250,246,calc(var(--wp-tint,.55) + .2));
  --x-fill:rgba(20,26,22,.035);
}
@media (prefers-reduced-transparency:reduce){
  :is(.x-page,.x-pane){--x-glass:rgba(14,18,17,.9);--x-conv:rgba(10,13,12,.95)}
  body:not([data-ds-dark-theme]) :is(.x-page,.x-pane){--x-glass:rgba(250,250,246,.9);--x-conv:rgba(250,250,246,.95)}
}
```

The page and its cards:

```css
.x-page{box-sizing:border-box;height:100%;padding:12px;color:var(--dsw-alias-label-primary)} /* no background, no blur */
[data-platform=darwin] .x-page{padding-top:calc(12px + var(--dsh-frame-top-clearance,0px))}
.x-card{
  background:var(--x-glass);
  -webkit-backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);
  backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-lg);
}
.x-card.x-main{background:var(--x-conv)}                          /* the card people read */
.x-card .x-card{background:var(--x-fill);-webkit-backdrop-filter:none;backdrop-filter:none}
```

With Wallpaper off the same rules apply through the fallbacks, so the page reads as a frosted card on DSH's own background. Fleet's page and the calendar's work this way.

### Text on glass

- What people read for long (a calendar's grid, a list, a document) sits at tint + .2, the open chat's formula. Navigation and side columns sit at the tint. At the default .55 that is .75 and .55.
- Small text on the plain tint fell under 3:1 in reviews (at a low tint, or over a light picture in dark). Tint + .2 fixed it. Keep small secondary text off the plain tint.
- DSH's secondary and tertiary colours are tuned for its opaque grounds. On glass, use them deepened toward the label colour (`--x-text-2` and `--x-glyph` above). Computed over a mid-grey picture at .75 (the default tint + .2):

  | | Light | Dark |
  | --- | --- | --- |
  | `--dsw-alias-label-secondary` as it is | 4.2:1 | 9.2:1 |
  | Wallpaper's own secondary colour (`--wp-meta`) | 4.7:1 | 6.1:1 |
  | `--x-text-2` (secondary, deepened) | 5.5:1 | 9.9:1 |
  | `--dsw-alias-label-tertiary` as it is (icons) | 2.7:1 | 6.5:1 |
  | `--x-glyph` (tertiary, deepened) | 4.1:1 | 7.9:1 |

- Light glass over a dark picture is the hard case: at the default tint only primary text passes there. The tint is the user's lever, so check it, and see the open questions.
- Never put text straight on the wall. A heading or a sentence outside a card reads only on some pictures.
- DSH's hover card is dark in both themes. Colours drawn on it are tuned for dark in both.

## 4. Colour

DSH's token sheets are its colour authority: DSH says the nearest semantic token wins. Glass gives you grounds; every colour on them comes from these:

| Use | Token | Light | Dark |
| --- | --- | --- | --- |
| Text | `--dsw-alias-label-primary` | #0f1115 | #f9fafb |
| Secondary text: summaries, meta | `--dsw-alias-label-secondary` | #61666b | #cfd3d6 |
| Glyphs, never small text | `--dsw-alias-label-tertiary` | #81858c | #adb2b8 |
| Lines, faint to strong | `--dsw-alias-border-l1` to `-l4` | #0000000a to #00000029 | #ffffff0f to #fff3 |
| Hover and pressed fills | `--dsw-alias-interactive-bg-hover`, `-active` | #2631480f, #2631481a | #ffffff14, #ffffff24 |
| Accent, links, the focus ring | `--dsw-alias-state-business-primary`, `--dsw-alias-link` | #4176e6 | #7aaaff |
| Done, warning, error | `--dsw-alias-state-success-primary`, `-warn-primary`, `-error-primary` | #22c55e, #f59e0b, #ec1313 | #22c55e, #f59e0b, #f25a5a |
| Card grounds | `--dsw-alias-bg-layer-1`, `-2`, `-3` | #fff | #232324, #2c2c2e, #353638 |
| Menu material | `--dsw-specific-menu`, `--dsw-menu-backdrop-filter` | see section 1 | see section 1 |

- On glass, secondary text and icons take the deepened forms in section 3.
- Some state colours are too light for small text on white. Deepen them with DSH's own label colour, as the coordinator does:
  - error: `color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary))`
  - link: the same with `--dsw-alias-link`
  - green (2.3:1 on white as it is): `color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-label-primary))`
- Use a token only if DSH defines it, and check the name in both versions: a name DSH doesn't define falls back silently, every time. `--dsh-font-mono` and `--dsh-color-bg-hover` are not DSH tokens.
- Light or dark comes from DSH. With DSH's tokens you need no code for it; for your own grounds use `body:not([data-ds-dark-theme])`.
- Don't define colours on `:root`, `html` or `body`. Changing a DSH token is a mod's job, through DSH's theme runtime (section 8).

## 5. Shape and type

- **Corners.** DSH's scale is `--dsw-radius-xs` 4px, `-sm` 8, `-md` 12, `-lg` 16, `-xl` 20 and `-panel` 28. Use the tokens.
  - Glass cards are `-lg`. Wallpaper's frosted DSH surfaces are 18px and 22px, set by Wallpaper.
  - DSH's parts carry their own: buttons 12 (36px high) and 8 (28px high), menu rows 12, toasts 16, tooltips 8, dialogs 28.
  - DSH draws every corner as a superellipse where the browser can (`corner-shape`, set on every element). Don't reset it.
- **Lines.** Inside DSH's surfaces, `.5px` in DSH's border tokens, as DSH draws them. On your own glass, `1px` in `--dsw-alias-border-l2`.
- **Type.** DSH's system font (`--dsw-font-family`), never a web font. Sizes from DSH's ladder:

  | Token | Size and line | Weight |
  | --- | --- | --- |
  | `--dsw-font-xl-24` | 24/32 | 600 |
  | `--dsw-font-l-20` | 20/28 | 500 |
  | `--dsw-font-m-18` | 16/28 | 500 |
  | `--dsw-font-base-16` | 16/24 | 400 |
  | `--dsw-font-s-14` | 14/22 | 400 |
  | `--dsw-font-xs-13` | 13/20 | 400 |
  | `--dsw-font-xxs-12` | 12/18 | 400 |
  | `--dsw-font-xxxs-11` | 11/14 | 400 |

  Each has a `-strong-` form at 500 (for example `--dsw-font-xs-strong-13`). Text in a chat follows the user's size, `--dsh-content-font-size` (10 to 22px, default 14); 0.2.1 adds `--dsh-code-font-size`. Code uses `--ds-font-family-code`. Counts and times use `font-variant-numeric:tabular-nums`.
- **Room for DSH's chrome.** On macOS a page clears the title bar with `--dsh-frame-top-clearance` (48px there, unset elsewhere). Anything pinned to the top of the window starts at `--dsh-frame-overlay-top`.

## 6. Motion and the user's settings

- DSH's durations are `--ds-transition-duration-fast` .1s, `--ds-transition-duration` .2s and `--ds-transition-duration-slow` .3s, on `--ds-ease-in-out`.
- Stop everything while `body.wp-still` is set or the system asks for less motion. `:is(<roots>) *` doesn't reach pseudo-elements, so name them (a loading bar's `::after` kept sliding once):

  ```css
  body.wp-still :is(.x-page,.x-pane),body.wp-still :is(.x-page,.x-pane)::before,body.wp-still :is(.x-page,.x-pane)::after,
  body.wp-still :is(.x-page,.x-pane) *,body.wp-still :is(.x-page,.x-pane) *::before,body.wp-still :is(.x-page,.x-pane) *::after{animation:none!important;transition:none!important}
  @media (prefers-reduced-motion:reduce){ /* the same selectors without body.wp-still */ }
  ```

- Under `prefers-reduced-transparency: reduce`, glass goes to at least 90% (the recipe above), as DSH does with its sidebar.
- Nothing flashes: hold DSH's view until a swap is done.
- DSH's own motion is DSH's: it scrolls a cut title on hover and glides rows when they reorder. Don't fight it, and never place anything by its position among DSH's rows while they move.

## 7. Where things go

DSH renders every slot entry inside an outlet, `<div data-slot="<key>" style="display:contents">`, which you can address but which has no box of its own. 0.2.1-alpha.2 has every slot key 0.2.0-rc.2 has, plus five. Use the slot DSH made for the job:

| Slot | For | Orders in use |
| --- | --- | --- |
| `sidebar.panellist`, with a page in `main` | an entry in DSH's panel list and the page it opens | Plugins 0, Categories 6, Calendar 7, Automation tasks 10 |
| `conversation.session.header.actions` | controls in a chat's header | DSH's subagents -30, Categories -27, Threads -25, Coordinate -24 |
| `conversation.input.left` | a control in the composer row | Coordinate 30 |
| `conversation.input.dock` | a bar above the message box | the coordinator's paused bar 15, its ending bar 16 |
| `conversation.chat.turnTail` | cards after a turn | thread cards 30 |
| `conversation.chat.node` | a view for one kind of chat node; the lowest priority wins | the coordinator's notice, -1 (DSH's own is 0) |
| `tool.call.toolview` | how your own tool's call shows in a chat | one entry per tool |
| `sidebar.session.row.leading` | the 16px seat before a session's title: one mark | DSH's automation mark 10, the coordinator 20 |
| `sidebar.workspaces.session.menu.item` | an item in a session's ⋯ menu | Full view 50, Thread settings 250 |
| `sidebar.right.pane.tab` | the body of your right-sidebar tab; a guide order puts a tile on its Start pane | Agenda, guide order 40 |
| `plugins.bundle.config` | your settings on DSH's Plugins page | the coordinator |
| `shell.overlay` | dialogs and passes that need no seat | the coordinator, categories |

- Pick an order nobody uses: DSH sorts by order and leaves ties to load order. An entry above Plugins needs an order below 0 (other plugins may sit there). Don't depend on DSH's own entries: not every DSH has Automation tasks.
- One seat, one mark. `sidebar.session.row.leading` holds one 16px mark, and DSH puts its status dot there while a row runs. Give way when the seat is taken, never widen it, keep 2px off the title, and put anything that must always show on the row instead.
- Leave DSH's single seats alone (`sidebar.toggle.badge` is its update badge).
- Toasts are DSH's `ui.Toast` without an anchor: DSH's banner at the top of the window. Never one that covers a dialog's buttons.
- Add only your own items to DSH's menus, and decorate DSH's lists without replacing them: DSH keeps its rows, order, width, search and "In one list".
- Never set the sidebar's width.

### Sizes to hold

- DSH's sidebar is 280px by default, and people widen it (seen at 342 and 418px). Below 1024px DSH folds it into a rail of icons, so nothing may depend on reaching session rows there.
- DSH's right sidebar is at least 300px, which leaves a pane about 280px. A pane works at 280px with no sideways scroll.
- Two chats side by side only while the main one keeps 400px and the pane 300px; below 768px, one at a time.
- A row you mark keeps at least 75% of a DSH row's room for its title (172px at 280px). A title of 24 characters or fewer is never cut; anything cut is cut once, at a word, with "…" and the whole text in a tooltip.
- Wallpaper's margins take room: a chat measured about 400px in a 1280px window with it, 424px without. Lay out for the narrower one.

## 8. Names, isolation and mods

### Names

| | Coordinator | Categories | Calendar | Pattern |
| --- | --- | --- | --- | --- |
| Classes | `dshp-` | `dshc-` | `dshcal-` | one short prefix of your own |
| Attributes | `data-projects-*` | `data-categories-*` | `data-calendar-*` | `data-<plugin>-*` |
| Style sheet | `<style data-plugin="dsh-plugin-coordinator" data-plugin-css="dsh-plugin-coordinator/client.css">` | the same, its package | the same, its package | one, appended to `<head>` once |
| Window storage | `dsh-plugin-coordinator/…` | `dsh-plugin-categories/…` | none | `<package>/<name>` |
| Slot entry ids | `dsh-plugin-coordinator/<name>` | `dsh-plugin-categories:<name>` | `dsh-plugin-calendar:<name>` | `<package>:<name>` |

The coordinator keeps `dshp-` and `data-projects-` from its first name; a prefix only has to be its own.

### Isolation

- No plugin names another plugin's classes, attributes, data or files.
- A plugin may mark DSH's elements with its own attributes, so that its CSS can find them. Remove every mark when it unmounts. Insert your own elements only where DSH has no slot for them, and never move, remove or rewrite DSH's nodes or text.
- Every rule that reaches DSH's session list ends in your own mark or a row key, with no `:has()`, `~` or `+`. A descendant step inside `:has()` cost about 1.8s of style work per update at 330 rows, and any `:has()` that finds the list restyles all of it. The budget is 100ms per update at about 330 rows.
- Watch DSH's DOM with one MutationObserver that does nothing while nothing it cares about changed.
- One rule per class name: two rules for one class stacked one's accent on the other's border once.
- DSH joins every plugin's browser half into one script. Wrap your style injection and setup so nothing throws at load, and run `node --check` on the client file: one plugin's error stops the others loading.
- Turning a plugin off removes every entry, mark, header and rule it added. Turning it on again repeats no import and no side effect.

### Mods: changing DSH's own look

A mod is a plugin that restyles DSH itself. Wallpaper is the only one, and it owns DSH's grounds. A new mod that wants to change some other part of DSH's look needs the user's OK and a line in this file first.

- **Prefer DSH's theme runtime.** `ctx.theme.overrideTokens(source, { '--dsw-alias-…': { light: '…', dark: '…' } })` stacks a token layer over the active theme and returns a function that removes it; DSH forces `source` to your package id. `ctx.theme.register` adds a whole theme. Both are in 0.2.0-rc.2 and 0.2.1-alpha.2. A token change reaches DSH and every plugin built on its tokens at once.
- **Use CSS only for what tokens can't do** (making a surface transparent or glass), every rule under your on-class (`body.wp-on …`), so switching off removes it all.
- **Anchor on a `data-slot` outlet, then step by structure.** Name a DSH element by the word of its class (`[class*="_panel"]`), never its hash, and never by a component name (DSH ships minified). Hashes differ between DSH's builds: Wallpaper's dock rule names `irMxjq_panel`, which matches in the Desktop app it was written against, while the npm builds of both versions call that panel `P3OORG_panel`. These anchors matched on both npm builds:

  | DSH surface | Selector |
  | --- | --- |
  | The frame | `[data-slot="root"] > [class*="_frame"]` |
  | Its columns | `[data-slot="root"] > [class*="_frame"] > :is([class*="_sidebarCol"],[class*="_centerCol"],[class*="_rightbarCol"])` |
  | The sidebar | `[data-slot="sidebar"] > div` |
  | The open chat | `[data-slot="main.conversation"] > div` |
  | The right dock | `[data-slot="rightbar.session"] > [class*="_panel"]` |
  | The composer | `[data-slot="conversation.composer.bar"] :is([class$="_card"],[class*="_card "])` |

- **Never match broadly.** `[class*="_frame"]` alone matches 11 classes in 7 of DSH's packages, not just the frame. `[class*="_card"]` also matches the composer's `_cardWorkspaceTrigger`.
- **Watch for DSH drawing that assumes an opaque ground.** The session list fades its last 24px with a gradient to `--dsw-specific-sidebar-fill`; on glass over a bright picture that shows as a dark band.
- **Never patch DSH's installed files**, and never write into the install of a DSH that is running: it reloads its browser files on any change, even of a file's times, and its window goes blank.
- **Test your selectors on every DSH you support** (the Desktop app and the npm builds), with a check that fails when a rule matches nothing.

## 9. Words, keyboard and states

### Words

- No ids, raw paths, tool names, bracketed tags or raw JSON where people read. Give a provider's reason in plain words.
- No third-party assistant names in any plugin file, UI text or commit message. `npm test` scans every text file for them; check commit messages yourself.
- Use DSH's words for DSH's things (Read Only, Workspace Write, Full access), and one set of state words on every surface.
- Say each thing once: one state per card, one explanatory note per page.
- A question names what will happen and to whom ("Email an update to 7 guests?"), its buttons name the action (Don't save, Save and email), and it lists everyone affected. Risky choices go through DSH's `RiskConfirmation`, with its tick box.
- A refusal says why and what to do next. A failure looks like a failure ("Not changed: …"), and a report of side effects is honest about who was reached.
- Errors never show secrets: name a host, never a private path or raw server text.
- Present the plugin as DSH presents its own: a title, one plain sentence and an icon (`locale/en.json` `meta`, and a 36 by 36 SVG).
- The README and the window agree.

### Keyboard, focus and screen readers

- Every tab stop shows DSH's 2px ring: `outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))` on `:focus-visible`. Draw it inset where a scrolling list would clip it. Focus never looks like hover.
- A composite widget is one tab stop with arrows inside (roving tabindex). A tree is a real `role="tree"` with levels, set sizes and positions.
- Screen readers meet things in the order they are drawn: header before items in the DOM, or `aria-owns`.
- Row menus open by right-click, Shift+F10 and the context-menu key; Escape closes them and gives focus back to the row.
- When something closes, focus goes back where it was. A confirmation opens on the safe choice, and Escape means no.
- Errors show where the person is looking and take the focus.
- Single-letter keys work only with focus in your page. Every drag has a way that needs no dragging, and each move is announced in a `role="status"` region.
- DSH's `StateDot` is hidden from screen readers: say the state in words where you draw it.

### States

- Every state has a word, not just a colour: running, waiting for approval, needs a decision, blocked, done, idle, failed (with the reason and Retry), stopped (with Resume), paused, resolved.
- Failed and stopped never read as idle. The action sits where the state shows.
- An empty state explains itself and offers a next step. A failed refresh keeps the old data and adds one "Couldn't refresh … Retry" line.
- Loading is a state of its own, and obeys `wp-still`.
- Live data stays live: poll a cheap version number, read state only when it moves, stop while hidden.

## 10. Checking the look

- Run the real DSH web window with a scripted model, on 0.2.0-rc.2 and 0.2.1-alpha.2.
- Shoot light and dark at 1440×900, 1024×768 and 1280×820, wide at 1713×1100 and 2346×1300 with the sidebar dragged to 418px, a 420px window and a 280px pane.
- Shoot with Wallpaper on and off, over a light and a dark picture, at a low tint (10 to 30%). A stand-in that copies only Wallpaper's transparency rules shows no glass behind DSH's surfaces: copy its glass rules too, and check with the real plugin before calling the look done.
- Headless Chromium draws translucent layers without their blur. For shots that match the app, run full Chromium with `--enable-unsafe-swiftshader --use-angle=swiftshader --enable-gpu-rasterization`.
- Measure rather than look: contrast for every text style (layering grounds down to an opaque one), the ring on every stop in a keyboard sweep started by a key press, `scrollWidth` against width for every state word, the computed animation under `wp-still`, the style time at about 330 rows.
- Prove you coexist: a stub neighbour plugin with panel entries, a leading mark, a session-menu item and a footer button, with your plugin on, off and on again.
- Give each run its own DSH install (`cp -a`, never `cp -al`), and never touch it while it runs.
- Never test on the user's live DSH. Loading anything into it needs the user's own yes.

## Where things stand

Checked 2026-10-12. Each of these is for the plugin's own next change.

**Wallpaper** (on the user's Mac)

- Its dock rule names `irMxjq_panel`, a Desktop-app hash. On the npm builds of both versions it matches nothing, so the right dock stays opaque. Anchor it as in section 8.
- `[class*="_frame"]` also clears image attachments' frames, the subagent card's border and fill, and the grounds of the browser pane and document previews. `[data-slot="root"] > [class*="_frame"]` keeps it to the frame.
- Its composer rule also matches the composer's workspace chip (`_cardWorkspaceTrigger`, from the same module), so that chip takes the composer's glass and 22px corners.
- The session list's bottom fade shows as a band on the glass sidebar over a bright picture.
- DSH's own pages in `main` (its Plugins page) get no glass, so their text sits on the wall.
- The open-chat rule uses `:has()` with a descendant step. Its style cost during a long streaming reply hasn't been measured.

**Fleet** (on the user's Mac)

- It uses the Geist font and its own colours copied from Wallpaper, not DSH's font and tokens.

**Categories**

- Its page paints `--dsw-alias-bg-base` (`.dshc-pg`), so with Wallpaper on it covers the wall with DSH's plain background. Drop the ground and put its content on a glass card at tint + .2.
- Its tree rows use `--dsh-color-bg-hover`, which DSH doesn't define, and their ring falls back to `Highlight`.
- Its drop line sits at `z-index:2147483000`.
- Its chevron ignores `wp-still`.

**Coordinator**

- No motion rule for `wp-still`, and reduced motion covers only its spinner and notice (its chevrons and meter still move).
- One `:has()` on DSH's header (the title crumb), where the categories plugin uses a mark for the same job.
- Its style injection has no `try`/`catch`.
- Its slot entry ids use `/` where the others use `:`.

**Calendar**

The calendar follows the earlier glass note, which copied Fleet. Its glass grounds are right; the rest predates these rules:

- Its own colours (`--cal-text`, `--cal-accent`, `--cal-line` and the rest, copied from Wallpaper) where DSH's tokens would do. DSH's, deepened as section 3 shows, read better on glass in both themes. The change is in its token block; the grounds stay.
- Its own toasts, at the bottom and `z-index:1200`, where DSH's Toast shows at the top.
- Its own popover (`z-index:990`) and DSH's Menu and Modal restyled with glass fills and its own radii.
- Its chat cards take a faint glass fill where DSH's own cards in a chat are opaque.
- `--dsh-font-mono`, which isn't a DSH token (use `--ds-font-family-code`), and `--cal-chip-ring`, which is read but never set.

## Open questions

- **Colours on glass.** These rules keep DSH's colours on glass (deepened for small text), as DSH's own text keeps them under Wallpaper. The other choice is Wallpaper's own palette for glass pages, which Fleet and the calendar carry now; by the numbers in section 3 it reads worse than DSH's deepened colours in both themes. If the user prefers that look, this file changes.
- **DSH's own text under Wallpaper.** Wallpaper could deepen DSH's secondary and tertiary labels while it is on, through `ctx.theme.overrideTokens`: computed, light #51555a and #64686e, dark #d7dbdd and #c0c4c9. DSH's own sidebar and every plugin built on its tokens would then read as well on glass as section 3's recipe does.
- **A floor for the tint slider.** At a tint of .10, even tint + .2 leaves dense text at .30. A floor such as `max(.75, calc(var(--wp-tint,.55) + .2))` for dense text would hold contrast; no plugin has one yet.
- **DSH's own pages under Wallpaper**: give them a glass card, or leave them on the wall.
- **Touch**: drags don't work by touch anywhere yet; desktop only is accepted for now but not decided.

## Before you push

- [ ] Your surfaces sit right: no ground inside DSH's surfaces, glass cards on your own pages.
- [ ] Only DSH tokens that exist in both versions, and only `--wp-blur`, `--wp-tint` and `body.wp-still` from Wallpaper.
- [ ] No selector with a DSH hash; nothing on `:root`, `html` or `body`; no `:has()` reaching DSH's list.
- [ ] Motion stops under `wp-still` and reduced motion, pseudo-elements included; glass thickens under reduced transparency.
- [ ] `node --check` on the client, and `npm test` passes (it includes the naming scan).
- [ ] Checked on both DSH versions, both themes, Wallpaper on and off.
- [ ] Off leaves nothing behind; on again repeats nothing.
