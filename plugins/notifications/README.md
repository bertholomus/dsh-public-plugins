# Notifications

System notifications for DSH when its window is hidden or unfocused. A plugin
(the coordinator first) asks for one; this plugin sends it through the first
sender around — DSH's own desktop sender in the Desktop app, a browser
window's own notifications in the `web` profile, or a command-line sender
when no window is watching. Nothing shows while the window is focused: if
you're looking at DSH, you don't need a toast over it.

## How it works

DSH's Desktop app already has the whole mechanism: its own notifications
plugin and its launcher send attention through `desktopRuntime.notifyAttention`,
which sends nothing while the window is focused, flashes the taskbar on
Windows, badges the dock on macOS and Linux, and brings the window up when a
notification is clicked. The plugin uses exactly that path in the Desktop app
— it adds nothing to DSH's own flow.

Everywhere else it picks the smallest sender that works:

| Where | Sender | Notes |
| --- | --- | --- |
| Desktop app (macOS, Windows, Linux) | DSH's own `desktopRuntime` | the app's own notifications; also skipped while the window is focused |
| `web` profile, tab open | Web Notifications API, in the plugin's browser half | permission asked once, from a click; the queue is polled every 15 s |
| No window watching | a command: `osascript` (macOS), `notify-send` (Linux), a PowerShell toast (Windows) | fire and forget; a missing command is logged, never thrown |

The browser half stands down by itself when the host answers that the Desktop
app sends natively, so nothing ever sends twice.

**The icon.** The plugin's icon is the DeepSeek whale (`icon.svg`, with a
256 px `icon.png` beside it). `notify-send` shows it on Linux (`--icon`), and
a Windows toast carries the PNG as its logo; macOS's `osascript` cannot set a
per-notification icon, so there the notification shows the posting app's own
— DSH's, when the Desktop app is the one sending.

**Proven and guessed.** Proven by reading DSH's source: the desktop path is
the app's own (`lib/notifications.js`, `host-process-entry.js` — a plugin
injects `desktopRuntime` the same way DSH's own notifications plugin does).
**Proven on this machine:** the macOS `osascript` command and the
`desktopRuntime` call shape. **Untested (guess):** the Windows PowerShell
toast and its logo image, `notify-send` on Linux and its `--icon`, the
browser profile end to end in a real browser, and the Web Notification
click-to-focus. None of it has run on Windows or Linux, and the web profile
was not driven in a real browser.

## For other plugins

```js
ctx.inject(['notifications'], (notifications) => {
    notifications.notify({
        title: '“Fix CI” handed back',
        body: '',
        kind: 'handback',     // optional: gates on that event's switch
        sessionId,            // optional; no platform can open a session yet
    });
});
```

The service is absent when the plugin is off or not installed, so wrap the
call the way DSH's own optional injections work (`ctx.inject` waits for it).
`notify` returns what happened: `'desktop'`, `'browser'`, `'cli'`, `'none'`
(no sender around), or `'off'` (the settings gate it). Senders take one line
each; whitespace collapses.

The coordinator calls it on its news: a handback, a thread that ended a turn
without a handback, one waiting for your approval, and one that failed or was
stopped again after the plugin's nudge. Its words for these are in its
`lib/index.js`; the kinds gate here, one switch each.

## Settings

On DSH's Plugins page, under Notifications: a master switch, and one switch
per event (handbacks; ended without a handback; waiting for approval; failed
after a nudge; stopped after a nudge). A save lands in the profile's
`cordis.patch.yml` and the plugin restarts with it — a restart costs a
notifier nothing, so its config is ordinary config, not live.

The same page names where this browser stands: notifications are on, blocked
for the site in the browser's settings, or waiting for your OK once — the
**Allow** button asks. The browser profile only shows notifications the
browser has allowed.

## Limits

- **A click brings DSH's window up; it does not open the chat.** DSH's own
  desktop sender does that, and DSH offers plugins no way to open a session
  (no deep link a plugin may use).
- **The Desktop app with its window closed** (destroyed, not hidden) sends
  nothing: DSH's own sender returns early then. Hidden and unfocused windows
  do send.
- **A hidden browser tab** may delay a notification: browsers throttle
  timers in hidden tabs to about once a minute. The notification is not
  lost — the queue keeps it until a poll takes it, and items older than five
  minutes are dropped rather than shown late.
- **The browser profile only runs while a tab is open.** A closed tab stops
  the browser sender; the next news goes to the command-line sender instead.
- **The command-line senders are best effort.** A machine without
  `notify-send` gets a logged failure and no notification.
- The plugin sends no notifications itself while it is off, and it leaves
  nothing behind: no marks, no style tag, no queue.

## Tests

```sh
node plugins/notifications/test/notifications.test.js   # offline, no DSH needed
node --check plugins/notifications/lib/client.js         # the browser half parses
```
