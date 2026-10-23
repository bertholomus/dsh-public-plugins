/**
 * dsh-plugin-notifications, the host-side notifier. One `notify()` call is
 * gated by the plugin's settings, then delivered through the first backend
 * that is around (see backends.js):
 *
 * 1. DSH's own desktopRuntime when this is the Desktop app.
 * 2. The plugin's browser half, when a DSH window has polled recently
 *    (the `web` profile served to a browser).
 * 3. The platform's command line, when no window is watching — a terminal
 *    DSH, or a browser tab that is closed.
 *
 * The queue for the browser half is small and short-lived: ids so a window
 * shows each item once, `at` so a window that comes back late drops stale
 * ones, and an acknowledge from the window clears what it took.
 *
 * @module dsh-plugin-notifications/notifier
 */
import { desktopSend, cliSend, iconFor, oneLine } from './backends.js';

/** How long after a browser half's last poll the queue is still used for it. */
export const BROWSER_TTL_MS = 90_000;
/** The most notifications kept for browser windows. */
export const MAX_QUEUED = 20;
/** How long a queued item stays worth showing; the browser drops older ones. */
export const QUEUE_STALE_MS = 5 * 60_000;

/** The settings field each news kind is gated by. */
export const EVENT_FIELDS = {
    handback: 'notifyHandback',
    finished: 'notifyFinished',
    approval: 'notifyApproval',
    failed: 'notifyFailed',
    stopped: 'notifyStopped',
};

export class Notifier {
    /**
     * @param {object} [options]
     * @param {() => object} [options.settings] - the plugin's live config.
     * @param {object} [options.logger] - a cordis logger for send failures.
     * @param {NodeJS.Platform} [options.platform] - the platform's CLI sender.
     * @param {(notification: {title: string, body: string}) => boolean} [options.send] -
     *   the CLI sender; defaults to cliSend on this machine.
     * @param {() => number} [options.now] - the clock, for tests.
     */
    constructor({ settings = () => ({}), logger = { warn() {}, info() {} }, platform = process.platform, send, now = Date.now } = {}) {
        this.settings = settings;
        this.logger = logger;
        this.platform = platform;
        this.send = send ?? ((notification) => cliSend(platform, notification, {
            icon: iconFor(platform),
            onError: (error) => this.logger.warn?.('notifications: %s', String(error?.message ?? error)),
        }));
        this.now = now;
        /** DSH's desktopRuntime, set once its inject lands; absent elsewhere. */
        this.desktop = undefined;
        /** Monotonic id for queued items. */
        this.seq = 0;
        /** Items waiting for a browser window. */
        this.queue = [];
        /** When a browser half last polled (this.now()); 0 until one did. */
        this.lastBrowserSeen = 0;
    }

    /** A browser half polled: its window is around, so the queue is for it. */
    markBrowserSeen() {
        this.lastBrowserSeen = this.now();
    }

    /** What a browser window should take: whether the Desktop app already sends natively, and the queue. */
    pending() {
        return { desktop: this.desktop !== undefined, items: this.queue.slice() };
    }

    /** The window took (showed or dropped) these queued items. */
    acknowledge(ids) {
        const taken = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'number'));
        if (taken.size === 0) return 0;
        const before = this.queue.length;
        this.queue = this.queue.filter((item) => !taken.has(item.id));
        return before - this.queue.length;
    }

    /**
     * Send one notification through the first backend that is around.
     * @param {{title?: string, body?: string, kind?: string}} notification -
     *   kind, when given, gates on that event's settings switch.
     * @returns {'off'|'desktop'|'browser'|'cli'|'none'} what happened.
     */
    notify(notification = {}) {
        const settings = this.settings() ?? {};
        if (settings.enabled === false) return 'off';
        const field = EVENT_FIELDS[notification.kind];
        if (field !== undefined && settings[field] === false) return 'off';
        const item = { title: oneLine(notification.title) || 'DSH', body: oneLine(notification.body) };
        if (this.desktop !== undefined) {
            desktopSend(this.desktop, item);
            return 'desktop';
        }
        if (this.browserAlive()) {
            this.queue.push({ id: ++this.seq, title: item.title, body: item.body, at: new Date(this.now()).toISOString() });
            if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
            return 'browser';
        }
        return this.send(item) ? 'cli' : 'none';
    }

    browserAlive() {
        return this.lastBrowserSeen !== 0 && this.now() - this.lastBrowserSeen < BROWSER_TTL_MS;
    }
}
