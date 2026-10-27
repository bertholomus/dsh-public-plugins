/**
 * The plugin's endpoints for its browser half. DSH's window reaches the
 * Host through Remote namespaces its gateway serves on the window's
 * connection (`/api/<namespace>/<method>`, the same carrier in the desktop
 * app and in a browser). This module adds one, `dsh-plugin-notifications`:
 *
 * - `pending`: what the window should show (and whether the Desktop app
 *   sends natively instead, so the window stands down).
 * - `acknowledge`: what the window took off the queue, and what became of
 *   each — shown (the system's own show event), not needed (you were
 *   looking at DSH), dropped (too old, or blocked), or failed and why.
 * - `status`: what the settings page shows — where notifications go now,
 *   settings that were wrong, and the recent ones with what became of each.
 * - `noteTest`: the settings page's test notification, logged with the rest.
 * - `clicked`: a click on a notification, logged; where the window could not
 *   come up by itself (the Desktop app's window hidden or minimised), the
 *   host brings it up (raise.js).
 *
 * The gateway finds a Remote service by its `typertRemote` binding and the
 * method markers on its prototype; parameters are plain names, since the
 * gateway reads them from the method source. Every method answers in words
 * or a RemoteError the window can show; none throws a raw error at it.
 *
 * @module dsh-plugin-notifications/remote
 */
import { Remote, RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';

/** Wire namespace: the client calls `/api/dsh-plugin-notifications/<method>`. */
export const NAMESPACE = 'dsh-plugin-notifications';
/** Cordis service key the gateway looks the service up by. */
export const SERVICE = 'dshPluginNotificationsRemote';

export class NotificationsRemote {
    /**
     * @param {object} notifier - the host-side Notifier (notifier.js).
     */
    constructor(notifier) {
        this.notifier = notifier;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: NAMESPACE });
    }

    /** Run one endpoint: what it throws reaches the window as its message, in words. */
    async run(work) {
        try {
            return await work();
        } catch (error) {
            this.notifier?.warn?.(`a window call failed: ${String(error?.message ?? error).slice(0, 200)}`);
            throw new RemoteError('notifications/failed', `Notifications could not answer: ${String(error?.message ?? error).slice(0, 200)}`, {});
        }
    }

    /** What this window should show: whether the desktop app already sends natively, and what is queued for it (it says what it can do: Notifier.pending). */
    async pending(window) {
        return this.run(() => this.notifier.pending(window));
    }

    /** The window took these queued notifications, and says what became of each (see Notifier.acknowledge). */
    async acknowledge(ids, results) {
        return this.run(() => this.notifier.acknowledge(ids, results));
    }

    /** Where notifications go now, settings that were wrong, and the recent ones (newest first). */
    async status() {
        return this.run(() => this.notifier.status());
    }

    /** The settings page's test notification: 'shown', 'denied' or 'failed', with the window's reason. */
    async noteTest(outcome, detail) {
        return this.run(() => this.notifier.noteTest(outcome, detail));
    }

    /** A notification was clicked; `raise` when the window could not come up by itself (Notifier.clicked). */
    async clicked(id, raise) {
        return this.run(() => this.notifier.clicked(id, raise === true));
    }
}

/** Mark methods the way the `@Remote` decorator does in DSH's TypeScript. Without
 * these markers the gateway answers "not found" for every method here, and the
 * browser half never reaches the queue (it fell back to the command line). */
function markRemote(Class, names) {
    for (const name of names) {
        Remote(Class.prototype[name], {
            kind: 'method', name, static: false, private: false,
            addInitializer(init) { init.call(Object.create(Class.prototype)); },
        });
    }
}
markRemote(NotificationsRemote, ['pending', 'acknowledge', 'status', 'noteTest', 'clicked']);
