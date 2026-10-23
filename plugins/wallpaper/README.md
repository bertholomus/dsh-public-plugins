# Wallpaper

Wallpaper and glass for DeepSeek Harness Desktop. It only changes how DSH looks: the wallpaper, colours, frosted
glass, motion and the headline. It adds one button and one panel, and nothing else. It never hides or rearranges
DSH's controls and never touches another plugin's UI or files.

## What it does

- **Wallpaper.** Full-bleed pictures with a 1.1 s crossfade. Collections are the folders in the plugin's
  `wallpapers/` folder; nothing else is ever shown as wallpaper, so screenshots never are. Add pictures (Add images,
  or drop them on the grid; big photos are scaled to 3840 px), move one to the macOS Trash, make or rename a collection.
- **Colours like macOS.** Ten presets with a light and a dark tone, your own colours from the **+** picker, a Gradient
  switch, and Both / Light / Dark to set the two modes separately.
- **Rotation.** Every 1, 5, 15 or 30 min, or 1, 2, 4, 8, 12 or 24 h, through the pictures of the collection or
  through the colours. **Off · keep this one** stops on what shows now; clicking a picture pins it.
- **Colour mode.** Dark / Light / System (System follows macOS). It is DSH's own appearance setting, written only
  when you click.
- **Glass.** DSH's sidebar, conversation, composer and right panel become frosted cards over the wallpaper. Sliders
  for wallpaper opacity and frost, glass blur and tint.
- **Motion.** The crossfade and the panel's animations. The Motion switch turns motion off everywhere on the page
  (macOS Reduce Motion always wins).
- **Headline.** Your own text over DSH's hero text, edited in the panel. Empty shows DSH's own headline. It is drawn
  with CSS; nothing writes DSH settings or the app bundle.

Open the panel with the picture button in the sidebar footer, next to Settings.

## For other plugins

Wallpaper publishes three things on `<body>` that other plugins may read (never write):

| What | Meaning |
| --- | --- |
| `--wp-blur` | the glass blur, for example `22px` |
| `--wp-tint` | the glass opacity, `0.1` to `0.95` |
| class `wp-still` | the Motion switch is off |

Fleet, for example, uses `background: rgba(14,18,17,var(--wp-tint,.55))` and
`backdrop-filter: blur(var(--wp-blur,22px))` on its cards, so they follow the sliders when Wallpaper is on and use
their own defaults when it is off.

## Config

Row `wallpaper` in the profile's `cordis.patch.yml`. Every key is optional.

| Key | Default | |
| --- | --- | --- |
| `dataDir` | `<DSH home>/wallpaper` | `state.json`, `wp-cache/` (resized pictures) and `wallpaper.log` |
| `wallpaperDir` | `<dataDir>/wallpapers` | one folder per collection |
| `importFrom` | `<DSH home>/fleet-shell` | read once, on the first start (see below) |

`<DSH home>` is `$DSH_HOME`, or `~/.dsh` when it is not set, so a test DSH keeps its own copy.

**First start.** When `<dataDir>/state.json` does not exist yet, Wallpaper copies Fleet Shell's look settings
(headline, wallpaper, colours, rotation, glass, motion) from `importFrom/state.json`, and its pictures from
`importFrom/wallpapers/` (APFS clones, so no extra disk until a file changes). Nothing else is read, and the
originals stay, so going back to Fleet Shell loses nothing. It never imports again.

## Files

- `lib/index.js`: tiny host entry that loads `impl.js` with a fresh URL on every enable.
- `lib/impl.js`: host side. Settings, the picture library and the first-start import; routes on `/api/wallpaper/*`.
- `lib/client.js`: the look and the panel, hand-written React (no build step). DSH hot-reloads it when it changes.
- `lib/impl.test.mjs`: offline test of the host in a temporary home: `node lib/impl.test.mjs`.
