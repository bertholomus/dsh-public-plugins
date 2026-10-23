/**
 * dsh-plugin-notifications — system notifications when DSH's window is
 * hidden or unfocused, for other plugins to call.
 *
 * The host half gates every notification on the plugin's settings and sends
 * it through the first backend that is around (see notifier.js and
 * backends.js): DSH's own desktopRuntime in the Desktop app, the plugin's
 * browser half in a browser profile, and a command-line sender when no
 * window is watching.
 *
 * Other plugins call it through the notifications service
 * (`ctx.inject(['notifications'], (notifications) => …)`):
 *
 *     notifications.notify({ title: '“Fix CI” handed back', body: '', kind: 'handback', sessionId });
 *
 * `kind` is optional and gates on that event's switch; `sessionId` is kept
 * for callers whose platform can open a session (none can yet — a click
 * brings DSH's window up, see the README).
 *
 * @module dsh-plugin-notifications
 */
import z from '@deepseek-ai/schemastery';
import { Notifier } from './notifier.js';
import { NotificationsRemote, SERVICE } from './remote.js';

export const name = 'notifications';

/** Host services the plugin drives: none required, everything is probed. */
export const inject = [];

export const Config = z.object({
    /** Master switch: no notification at all when off. */
    enabled: z.boolean().default(true),
    /** A thread's handback. */
    notifyHandback: z.boolean().default(true),
    /** A thread that ended a turn without a handback. */
    notifyFinished: z.boolean().default(true),
    /** A thread waiting on a permission prompt. */
    notifyApproval: z.boolean().default(true),
    /** A thread that failed after the plugin nudged it once. */
    notifyFailed: z.boolean().default(true),
    /** A thread that was stopped after the plugin nudged it once. */
    notifyStopped: z.boolean().default(true),
});

export function apply(ctx, config) {
    if (!config.enabled) return;
    const notifier = new Notifier({
        settings: () => config,
        logger: ctx.logger,
        platform: process.platform,
    });

    // DSH's own sender (Electron main), in the Desktop app only. It already
    // skips while the window is focused and shows the window on a click.
    ctx.inject(['desktopRuntime'], (scope) => {
        const runtime = scope.desktopRuntime;
        notifier.desktop = runtime;
        return () => { if (notifier.desktop === runtime) notifier.desktop = undefined; };
    });

    // The browser half polls this: the queue for a browser window, and the
    // desktop flag that tells it to stand down.
    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new NotificationsRemote(notifier));
    });

    // What other plugins call, e.g. the coordinator on its news.
    ctx.provide('notifications', {
        notify: (notification) => notifier.notify(notification),
    });

    ctx.effect(() => () => {
        notifier.queue.length = 0;
    }, 'notifications: notifier');
}
