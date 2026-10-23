/**
 * The plugin's endpoints for its browser half. DSH's window reaches the
 * Host through Remote namespaces its gateway serves on the window's
 * connection (`/api/<namespace>/<method>`, the same carrier in the desktop
 * app and in a browser). This module adds one, `dsh-plugin-notifications`,
 * with two methods: the browser half polls `pending` for what it should
 * show (and learns when the Desktop app sends natively instead), and
 * acknowledges what it took.
 *
 * The gateway finds a Remote service by its `typertRemote` binding and the
 * method markers on its prototype; parameters are plain names, since the
 * gateway reads them from the method source.
 *
 * @module dsh-plugin-notifications/remote
 */
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';

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

    /** What this window should show: whether the desktop app already sends natively, and what is queued. */
    async pending() {
        this.notifier.markBrowserSeen();
        return this.notifier.pending();
    }

    /** The window showed (or dropped) these queued notifications. */
    async acknowledge(ids) {
        return this.notifier.acknowledge(ids);
    }
}
