# Notifications

System notifications for DSH while you are not using it. Other plugins send
their news through it — the coordinator when a thread hands back, ends a
turn without a handback, waits for approval, or fails or is stopped after a
nudge; Decisions for each new card; Agent Terminals when an agent waits on
you; Autopilot when it backs off; Fleet when a finding on an Ascent starts or
clears. It is built for long unattended runs: you leave DSH working, and the
news finds you.

- **It shows with DSH's icon**, from DSH's own window, while you are not
  using DSH: its window hidden, minimised, behind other windows, or left in
  front with nobody at it (no click, key, scroll or pointer move in it for 2
  minutes). While you use it, no notification is needed.
- **A click brings DSH's window up on the chat** the news is about, also
  when the Desktop app's window was hidden with its close button or
  minimised: the plugin asks the app to bring its window up, as a click on
  its Dock icon does, and opens the chat in it. News that names a place
  opens that place instead: Fleet's findings open Fleet's page.
- **Many at once** (more than three in one look) show as the newest two and
  one summary of the rest; a click on the summary opens this plugin's page at
  the recent list.
- **Nothing is lost**: the settings page lists the last notifications with
  what became of each — shown, not shown and why, failed and why — with
  **Open chat** or **Open** for the ones that have a place. Its log file has
  a line for every one.
- **Only a window that can show it takes it**: a window with notifications
  blocked, not yet allowed, or with no support leaves the news for one that
  can, and two windows never show the same one.
- **A restart loses nothing and repeats nothing**: news still waiting for a
  window is kept on disk and shows after the restart, once, also when the
  window comes back in front (until you use it).

## How it sends

Each notification goes through the first sender that is around:

| Where | Sender | Notes |
| --- | --- | --- |
| A DSH that provides `desktopRuntime` | DSH's own desktop notifications | used as they are; they skip while the window is focused |
| The Desktop app (no `desktopRuntime`, as in DeepSeek Harness 0.2.1-rc.3 here) | the app's window, through the Web Notifications API | queued even while the window is hidden or minimised; macOS shows them as DeepSeek Harness's, with its icon |
| DSH's `web` profile in a browser tab | the same browser half, in the tab | the browser asks once (the **Allow notifications** button); used while a tab that may show them checked in within 90 s |
| No window around, Linux | `notify-send` | with the whale as `--icon` |
| No window around, Windows | a PowerShell toast | with the whale as its logo |
| No window around, macOS | nothing | see below |

**Why macOS has no command-line sender.** `osascript`, macOS's only one,
cannot set a notification's icon: its notifications show Script Editor's
icon, as if another app sent them. So with no DSH window around, macOS gets
none, the recent list says so, and the news is still there when you look.

**Which window shows it.** Each DSH window looks at the queue every 15 s,
and at once when it gains or loses focus, and says what it can do: show
notifications (allowed in the browser, or the Desktop app's window), not
allowed yet, blocked, or no support. Only a window that can show them takes
news; the others leave it in the queue. In the Desktop app, a browser tab on
the same DSH leaves the news to the app's window while that window has
looked within the last 3 minutes. A window that takes an item holds it for
30 s, so a second window does not show it too. News that no window can show
waits 5 minutes, then is listed as not shown, with why: no window, a window
with notifications blocked, a browser not allowed yet (with where to allow
it), or no support.

**How a click brings the Desktop app's window up.** A window's own `focus()`
cannot do it: the app check below found it leaves a window behind other
windows where it is, and the app gives its window no call to show itself
when its close button hid it or it is minimised. What the app does offer:
opened again while it runs, it hands over to the running app, which
restores, shows and focuses its window — the same as a click on its Dock
icon or a `dsh://open` link. So on a click:

1. A hidden or minimised window asks the plugin's host half — which the app
   runs as its own child process — to open the app once more with the
   running app's own user-data folder, and then opens the chat. The new
   process finds the app running, hands over, and quits.
2. A window that is only behind other windows gets 0.4 s to come up by
   itself; if it has not, it is brought up the same way.

The host does this only where it can prove it is the app's child: its entry
is DSH's desktop host, and its parent's command line is the same app's
executable with switches only. It does it on macOS and Linux, at most once
every 2 s. Its log says what happened: `#12 clicked: brought DSH's window up
(…)`, `#12 clicked: DSH's window came up by itself`, or a warning with the
reason it could not.

**How a "shown" is proven.** A window that takes news off the queue tells
the plugin what it did with each: shown (the system's own show event came),
not needed (you were using DSH), dropped (it waited more than 5 minutes, or
notifications are blocked), failed (with the reason), or handed over with no
confirmation (macOS's Focus or Do Not Disturb can hold one back). Each is a
line in its log file and an entry in the recent list. The caller's answer
(`'browser'`, below) means queued; the log and the list say what came of it.

**Proven and untested.**

- Proven by the real-DSH test (below), in a real DSH window whose system
  notifications are replaced by a recorder, on DSH 0.2.0-rc.2, 0.2.1-rc.1
  and the installed app's 0.2.1-rc.3: the queue and the show; a window left
  in front with nobody at it shows the news and one in use does not; a
  blocked tab beside a window that can show them takes nothing, and two
  windows show one item once; a click opens the chat or a named plugin
  page, Fleet's findings name Fleet's page, and the summary's click opens
  the recent list; bursts; the
  settings page; a restart into a window in front; a misspelt setting. The
  last build runs DSH under the app's own binary, as the app does, so the
  plugin takes the Desktop app's path.
- Proven in the installed app (DeepSeek Harness 0.2.1-rc.3), in a DSH Test
  instance's own window (`test/app/raise-check.mjs`): with the window hidden
  by its close button, minimised, and behind another window, a click brought
  it up in front on the right chat each time, and the log said the plugin
  brought it up: in 0.4 to 1.3 s each time over six runs but once, when the
  minimised window took over 10 s while this machine ran at a load average
  of about 75 (the app started again to hand over is what takes the time).
  A recorder stood in for the banner (the click is its `onclick`, the
  handler a banner's click calls), so the system did not bring the app
  forward as it does for a real click; that makes the check the harder case.
- Proven by reading the app's code: its window may show notifications
  without an ask; a second launch hands over to the running app, which
  restores a minimised window, shows it and focuses it.
- Untested: a banner on the screen itself, and a person's click on one;
  Fleet's page opening on a click (the tests have no Fleet: they check the
  notification names its page, `fs-fleet`); bringing the window up on Linux (the same code as on macOS, unit-tested;
  no Linux desktop here); the Windows PowerShell toast and `notify-send`
  (their commands are unit-tested, not run); DSH's own `desktopRuntime` (no
  DSH here provides it).

## The settings page

DSH → Plugins → Notifications:

- **Send system notifications**, and one switch per kind of news (below).
  Saved with DSH's own form, in the profile's `cordis.patch.yml`; a save
  applies at once. While **Send system notifications** is off, the kinds'
  switches are inactive, with a note that they apply once it is on.
- **Where they go now**, in a sentence: this window, the app's window, a
  browser tab, a command, or nowhere (and what to do about it).
- **This window**: whether it may show notifications, and the **Allow
  notifications** button where the browser has not been asked yet. In the
  Desktop app, macOS decides how they show: System Settings → Notifications
  → DeepSeek Harness.
- **Send a test notification**: shows one now, even while you use DSH, and
  says whether the system showed it.
- **Recent notifications**: the newest ten (the plugin keeps thirty), each
  with its time and what became of it, **Open chat** for the ones from a
  chat, **Open** for the ones that name a page, and where the log file with
  every one is.
- **A setting is wrong**, when one is (below): which setting, what it counts
  as, and how to fix it — also a key that is not a setting, with the setting
  it most likely meant.

## Settings

The row's id is `notifications`. Every setting is a switch, and every one
is live: DSH serves the settings page for live settings only, and a save
there (or an edit of the profile) changes them in place, with no restart.
The plugin checks them again, and its log says what changed, by title and
value: `settings changed: “Fleet findings” off (notifications on; sender:
window)`.

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | true or false | `true` | Off: no notification at all; callers are told `'off'` and the list says so. |
| `notifyHandback` | true or false | `true` | The coordinator: a thread handed back to its chat (`kind: 'handback'`). |
| `notifyFinished` | true or false | `true` | The coordinator: a thread ended a turn without a handback (`'finished'`). |
| `notifyApproval` | true or false | `true` | The coordinator: a thread waits on a permission prompt (`'approval'`). |
| `notifyFailed` | true or false | `true` | The coordinator: a thread failed again after its nudge (`'failed'`). |
| `notifyStopped` | true or false | `true` | The coordinator: a thread was stopped again after its nudge (`'stopped'`). |
| `notifyFleet` | true or false | `true` | Fleet: a finding on an Ascent starts, gets worse or clears (`'fleet'`). |

News of any other kind follows `enabled` alone: Decisions' cards, Agent
Terminals' agents that wait on you and Autopilot's questions
(`kind: 'decision'`), and Autopilot backing off (`'autopilot'`). Decisions
and Agent Terminals also have a switch for theirs in their own settings.

A value that is not true or false (`"yes"`, `0`) never stops the plugin: it
counts as the default, its log file warns (at start, or when a change makes
it wrong), and the settings page names the setting until it is fixed. A key
that is not a setting (`notifyFleeet`) does nothing: the log warns and the
page lists it, with the setting it most likely meant (`notifyFleet`) and how
to fix it.

```yaml
# In the profile's cordis.patch.yml (a patch row replaces the whole config: list every key you set)
- id: notifications
  config:
    enabled: true
    notifyFleet: false
```

## For other plugins

```js
ctx.inject(['notifications'], (scope) => {
    const notifications = scope.notifications;
    notifications.notify({
        title: '“Fix CI” handed back',   // one line; cut at 200 characters
        body: '',                         // optional; cut at 400
        kind: 'handback',                 // optional: gates on that kind's switch
        sessionId,                        // optional: a click opens this chat
        // open: { panel: 'fs-fleet' },   // optional, without sessionId: a click opens this DSH page
        // open: { bundle: 'dsh-plugin-x' }, // … or this plugin's settings page
    });
});
```

The service is there while the plugin runs (also while `enabled` is false,
so callers hear `'off'`), and absent while the plugin is switched off in
Plugins or not installed: take it with `ctx.inject` as above. `notify`
never throws and answers at once:

| Answer | Meaning |
| --- | --- |
| `'desktop'` | handed to DSH's own desktop notifications |
| `'browser'` | queued for a DSH window, which shows it while you are not using DSH (the log and the list say what came of it) |
| `'cli'` | handed to `notify-send` or a PowerShell toast |
| `'none'` | nothing could show it (no window on macOS, or a sender failed); listed with the reason |
| `'off'` | switched off in its settings (all, or that kind) |

A click goes to the chat when there is a `sessionId`; otherwise to `open`
(a page id, or a plugin's package name for its settings page; anything else
is ignored); news of kind `'fleet'` with neither opens Fleet's page. A
notification with nothing to open just brings DSH's window up.

## Where it keeps things

- `DSH_HOME/notifications/state.json` (`~/.dsh` when `DSH_HOME` is unset):
  news waiting for a window, the last thirty notifications with what became
  of each, and the next id. The folder is 700 and the file 600 (titles name
  your chats). Written whole and renamed, so a crash leaves the old file or
  the new one. Deleting it starts the list over; nothing else depends on it.
- `DSH_HOME/notifications/notifications.log`: its log, one line per
  notification (`2026-10-26T10:02:13-07:00 info #12 (handback) “Thread
  handed back” waiting: …`), one per outcome (`… info #12 shown: …`), one
  per click (`… info #12 clicked: …`), and a warning for a setting that is
  wrong or a file it could not write. Past 1 MB it moves to
  `notifications.log.1` (one older file kept). File 600, like the state.
  The plugin writes its own because DSH 0.2 keeps a plugin's log lines in
  memory only; they go to DSH's logger too.
- In each window's local storage, `dsh-plugin-notifications/shown`: the last
  hundred items that window showed, so a reload never shows one twice.

## Switching it off

- Just the notifications: switch off **Send system notifications** on its
  settings page and save (or set `enabled: false`). The plugin keeps
  running, so callers hear `'off'` and the list still shows what came.
- One kind: its switch on the settings page.
- The whole plugin: its switch on DSH's Plugins page. Its service, its
  endpoints, its page and its style sheet go; callers find no service and
  carry on without it. Switched on again, it starts from what it kept.

## Setup and rollback

- It is a DSH bundle with no dependencies beyond DSH's own packages: add
  `dsh-plugin-notifications` to the profile's bundles (DSH's Plugins page or
  `package.json` `dsh.profile.bundles`), linked from this folder.
- In a browser profile, open the settings page once and press **Allow
  notifications**. The Desktop app allows them by itself; macOS asks once,
  as for any app.
- Rollback: point the profile back at the earlier checkout of this folder
  (or `git checkout <earlier commit> -- plugins/notifications`) and restart
  DSH. An earlier version ignores `state.json`; delete
  `DSH_HOME/notifications/` if you want nothing left behind. The profile's
  `notifications` row keeps working (the keys did not change).

## Limits

- **Reading without touching counts as away after 2 minutes**: with DSH's
  window in front and no click, key, scroll or pointer move in it for 2
  minutes, news shows as a banner. Any of those in the window counts as
  using it again.
- **A hidden or minimised window may delay a notification by up to about a
  minute**: its timers are throttled, so its look at the queue lands late.
  It looks again the moment the window gains or loses focus.
- **Bringing the window up needs the Desktop app's own DSH**: on macOS and
  Linux, at most once every 2 s (a second click within 2 s is only logged).
  On Windows the plugin does not start the app again: a click only asks the
  window to focus, which may leave a hidden window down (untested there). A
  DSH started another way (in a terminal, with a browser tab) has no app
  window to bring up; a click asks the browser to focus its tab.
- **To bring the window up, the app's executable starts once more** for a
  moment: it hands over to the running app and quits. That takes about a
  second, and can take several on a heavily loaded machine. The DSH Test
  instances here run it with their own user-data folder, so it reaches
  their window, never another DSH.
- **No DSH window open** (a DSH in a terminal with no tab for more than
  90 s): on macOS nothing shows the news; it waits 5 minutes, then is listed
  as not shown.
- **A browser tab beside the Desktop app** leaves the news to the app's
  window, and takes it only when that window has not looked at the queue
  for 3 minutes.
- **The command-line senders are best effort**: a missing `notify-send` or
  a failing toast is listed as failed, with the reason.
- **"Shown" is the system's own word**: the notification's show event. With
  DeepSeek Harness's notifications turned off in System Settings, macOS may
  take one without putting it on screen, and no app can tell; the settings
  page's **This window** row says where to look.

## Tests

```sh
npm test                                                   # the whole repository, these tests included
node --test plugins/notifications/test/notifications.test.js
node scripts/e2e.mjs notifications                          # real DSH, every build under .e2e/ and the app's
node plugins/notifications/test/app/raise-check.mjs --instance <DSH Test name>   # macOS, the installed app
```

- The unit tests (55) cover the senders and their quoting, the settings
  check (wrong values, keys that are not settings and the one meant) and
  live changes to it, the state file (modes, a broken file, ids across
  restarts), the log file (its lines, modes, the move to `.1`, a folder it
  cannot write), every outcome the notifier records and logs, which window
  may take news (blocked, not allowed, no support, the app's window before a
  tab, claims), the places a click opens, bringing the app's window up (when
  the host may, the command it starts, the 2 s gap, failures in words), the
  endpoints (the Remote markers the gateway needs, failures in words), the
  host wiring, the coordinator's news contract, and the browser half: in
  use only with recent input, shown, stale, blocked, failed, unconfirmed,
  bursts, a click that asks for the window first when it is hidden, a
  reload that does not show twice. DSH's packages come from the newest
  runtime under `.e2e/` (`test/peers.mjs`); link `.e2e` into a fresh copy.
- The real-DSH test (`test/e2e/run.mjs`, 68 checks on each build) runs DSH
  in a throwaway home with a stand-in caller plugin (`test/e2e/caller`) and
  real windows whose Web Notifications are replaced by a recorder, so
  nothing reaches the screen: everything listed at the top of that file,
  with pictures in `.e2e/shots/notifications/<DSH version>/`: the settings
  page light, dark and at 760 px, the recent list, the permission ask, a
  test sent, a wrong setting, the kinds inactive while off, a blocked tab,
  the chat a click opened, and the recent list a summary's click opened.
- The app check (`test/app/raise-check.mjs`, three cases) runs in a DSH
  Test instance with the plugin and `test/e2e/caller` loaded: it starts the
  instance again with a local debugging port, hides its window with its
  close button, minimises it, and puts a window of its own in front, and
  each time sends news with a chat, clicks it (a recorder stands in for the
  banner) and checks the window came up in front on that chat. It presses
  the window's buttons through the accessibility API (the terminal needs
  that access), reads the window's place from the window server's list (no
  pixels), and keeps pictures of the window's own page and a report in
  `.e2e/shots/notifications/app-window/`. Each chat is in a folder named for
  its case (`raise-hidden-…`, `raise-minimised-…`, `raise-behind-…`): DSH
  lists a chat with no turns as "New Session", so the folder's name, shown
  above the open chat's message box and picked out in the sidebar, is what
  tells the pictures apart. It stops the instance at the end.
- By hand, in a DSH Test instance with the plugin and `test/e2e/caller`
  loaded: `node plugins/notifications/test/e2e/send.mjs "$(dsh-test url)"`
  sends one the way another plugin does and prints the answer and what came
  of it. That one is real: with the window hidden it shows on your screen.
