/**
 * dsh-plugin-notifications, the host-side notifier. One `notify()` call is
 * gated by the plugin's settings, then delivered through the first sender
 * that is around (see backends.js):
 *
 * 1. DSH's own desktopRuntime, where DSH provides it.
 * 2. The plugin's browser half in a DSH window: the queue for a window that
 *    has polled recently (the `web` profile served to a browser), or — on a
 *    Desktop host — always, since its window exists even hidden or
 *    minimised and macOS attributes the Web Notifications API's posts to
 *    the app itself.
 * 3. The platform's command line, when no window is watching (a terminal
 *    DSH, or a closed browser tab). macOS has no such sender: osascript
 *    would show Script Editor's icon, never DSH's, so macOS sends nothing
 *    rather than the wrong app's notification.
 *
 * Every notification gets an id and a line in the log, and stays in a short
 * recent list with what became of it — sent, shown (the window reports the
 * system's own show event), not shown and why, failed and why — so a
 * "delivered" is never a guess and the settings page can say what was
 * missed. The queue, the recent list and the next id are kept on disk
 * (state.js), so a restart loses nothing still worth showing and repeats
 * nothing already shown.
 *
 * Nothing here throws into a caller: a sender that fails is a "failed"
 * entry and a log line.
 *
 * @module dsh-plugin-notifications/notifier
 */
import { randomUUID } from 'node:crypto';
import { cliSend, desktopSend, iconFor, oneLine } from './backends.js';
import { TITLES } from './config.js';
import { emptyState } from './state.js';

/** How long after a browser half's last poll the queue is still used for it. */
export const BROWSER_TTL_MS = 90_000;
/**
 * How long the Desktop app's own window counts as there after its last
 * poll. A hidden or minimised window's timers are throttled to about one
 * poll a minute, so it gets longer than a browser tab; while it counts as
 * there, a browser tab on the same DSH leaves the news to it (DSH's icon).
 */
export const APP_WINDOW_TTL_MS = 3 * 60_000;
/** How long a window that took items holds them before another window may take them (it reports at once). */
export const CLAIM_MS = 30_000;
/** The most windows remembered at once (each a tab or the app's window). */
export const MAX_WINDOWS = 20;
/** The most notifications kept waiting for a window. */
export const MAX_QUEUED = 20;
/** How long a queued item stays worth showing; older ones are dropped, not shown late. */
export const QUEUE_STALE_MS = 5 * 60_000;
/** How many notifications the recent list keeps. */
export const RECENT_MAX = 30;
/** The longest title and body kept (a notification is one short line). */
export const TITLE_MAX = 200;
export const BODY_MAX = 400;

/** The settings field each news kind is gated by. */
export const EVENT_FIELDS = {
    handback: 'notifyHandback',
    finished: 'notifyFinished',
    approval: 'notifyApproval',
    failed: 'notifyFailed',
    stopped: 'notifyStopped',
    fleet: 'notifyFleet',
};

/** What a window can report about an item it took, in the words the page and the log use. */
export const WINDOW_OUTCOMES = {
    shown: { state: 'shown', detail: 'Shown on screen by DSH\'s window (the system reported it).' },
    summary: { state: 'shown', detail: 'Shown on screen in one notification with others that came at once.' },
    watching: { state: 'not shown', detail: 'You were using DSH (its window was in front and in use), so no notification was needed.' },
    stale: { state: 'not shown', detail: 'It waited more than 5 minutes for a window, so it was dropped rather than shown late.' },
    denied: { state: 'not shown', detail: 'Notifications are blocked for DSH in the window that took it.' },
    failed: { state: 'failed', detail: 'DSH\'s window could not show it.' },
    unconfirmed: { state: 'sent', detail: 'Handed to the system, which did not confirm showing it (Focus or Do Not Disturb can hold one back).' },
};

const clipText = (text, max) => {
    const flat = oneLine(text);
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const errorWords = (error) => clipText(error instanceof Error ? error.message || error.name : String(error ?? 'unknown error'), 200);

/** Fleet's own page in DSH (its panel id): where a Fleet finding opens when Fleet names no place itself. */
export const FLEET_PANEL = 'fs-fleet';

/**
 * Where a click on a notification goes, besides a chat: a DSH page (`panel`,
 * the id of a page in DSH's panel list, as Fleet's 'fs-fleet') or a plugin's
 * page in DSH's Plugins (`bundle`, its package name). Fleet's findings open
 * Fleet's page unless they name another place.
 */
export function openTarget(open, kind) {
    if (open !== null && typeof open === 'object') {
        if (typeof open.panel === 'string' && /^[\w:.-]{1,100}$/.test(open.panel)) return { panel: open.panel };
        if (typeof open.bundle === 'string' && /^[@\w./-]{1,120}$/.test(open.bundle)) return { bundle: open.bundle };
    }
    return kind === 'fleet' ? { panel: FLEET_PANEL } : undefined;
}

/**
 * What a window says of itself when it looks at the queue: its id, its
 * notification permission ('granted', 'denied', 'default' = not asked yet,
 * 'none' = no notification support, 'desktop' = the Desktop app's window,
 * which may show them without an ask), and whether it is the app's window.
 * A window that says nothing (an older browser half) counts as one that may
 * show them, as before.
 */
export function windowInfo(window) {
    const given = window !== null && typeof window === 'object' ? window : {};
    return {
        id: typeof given.id === 'string' && /^[\w-]{1,64}$/.test(given.id) ? given.id : 'a-window',
        permission: ['granted', 'denied', 'default', 'none', 'desktop'].includes(given.permission) ? given.permission : 'granted',
        app: given.app === true,
    };
}

/** Whether a window can put a notification on the screen now. */
export const canShow = (window) => window.permission === 'granted' || window.permission === 'desktop';

export class Notifier {
    /**
     * @param {object} [options]
     * @param {() => object} [options.settings] - the plugin's settings (checked: every field a boolean).
     * @param {object} [options.logger] - a cordis logger: one line per notification and per outcome.
     * @param {NodeJS.Platform} [options.platform] - the platform's CLI sender.
     * @param {boolean} [options.desktopHost] - this host is the Desktop app
     *   (Electron), so its window's browser half exists even while the window
     *   is hidden or minimised: keep the queue for it regardless of the poll
     *   TTL, because a hidden window's timers are throttled and may skip
     *   polls for minutes.
     * @param {(notification: {title: string, body: string}, onError: (error: unknown) => void) => boolean} [options.send] -
     *   the CLI sender; defaults to cliSend on this machine.
     * @param {() => number} [options.now] - the clock, for tests.
     * @param {{ load(): object, save(state: object): boolean }} [options.store] - where the state is kept (state.js); memory only without.
     * @param {{ key: string, text: string }[] | (() => { key: string, text: string }[])} [options.problems] - settings
     *   that are wrong (config.js), for the page; a function when a save can change them.
     * @param {string} [options.logFile] - where the log lines can be read, as the page names it ('' when nowhere).
     * @param {{ raise(): { raised: boolean, reason?: string }, available(): { ok: boolean, reason?: string } }} [options.raiser] -
     *   brings the Desktop app's window up after a click (raise.js).
     */
    constructor({ settings = () => ({}), logger = { warn() {}, info() {} }, platform = process.platform, desktopHost = false, send, now = Date.now, store, problems = [], logFile = '', raiser } = {}) {
        this.settings = settings;
        this.logger = logger;
        this.logFile = logFile;
        this.platform = platform;
        this.desktopHost = Boolean(desktopHost);
        this.send = send ?? ((notification, onError) => cliSend(platform, notification, { icon: iconFor(platform), onError }));
        this.now = now;
        this.store = store;
        /** The settings that are wrong now. */
        this.problemsNow = typeof problems === 'function' ? problems : () => problems;
        /** DSH's desktopRuntime, set once its inject lands; absent elsewhere. */
        this.desktop = undefined;
        const saved = store?.load?.() ?? emptyState();
        /** Ids count up across restarts; the epoch tells this state's ids from an earlier, deleted one's. */
        this.seq = saved.seq;
        this.epoch = typeof saved.epoch === 'string' && saved.epoch ? saved.epoch : randomUUID().slice(0, 8);
        /** Items waiting for a browser window. */
        this.queue = saved.queue;
        /** The newest RECENT_MAX notifications, newest last, with what became of each. */
        this.recent = saved.recent;
        /** When a browser half last polled (this.now()); 0 until one did. */
        this.lastBrowserSeen = 0;
        /** The windows that looked at the queue (windowInfo, with seenAt), by id. */
        this.windows = new Map();
        /** Which window holds which queued item for now (id → { window, until }), so two windows never show one twice. */
        this.claims = new Map();
        /** Brings the Desktop app's window up after a click (raise.js); absent elsewhere. */
        this.raiser = raiser;
        if (this.queue.length > 0) this.info(`${this.queue.length} notification(s) still waiting for DSH's window from before the restart`);
    }

    info(text) {
        // '%s' so a title with a % in it is never read as a format.
        try { this.logger.info?.('%s', `notifications: ${text}`); } catch { /* a logger never fails a send */ }
    }

    warn(text) {
        try { this.logger.warn?.('%s', `notifications: ${text}`); } catch { /* a logger never fails a send */ }
    }

    save() {
        if (!this.store) return;
        this.store.save({ seq: this.seq, epoch: this.epoch, queue: this.queue, recent: this.recent });
    }

    /** A window looked at the queue: remember it and what it can do (windowInfo). */
    checkIn(window) {
        const info = windowInfo(window);
        const now = this.now();
        this.windows.delete(info.id);
        this.windows.set(info.id, { ...info, seenAt: now });
        this.lastBrowserSeen = now;
        for (const [id, seen] of this.windows) if (now - seen.seenAt > QUEUE_STALE_MS * 2) this.windows.delete(id);
        while (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value);
        return this.windows.get(info.id);
    }

    /** A window that may show notifications looked at the queue (for callers that say no more). */
    markBrowserSeen() {
        this.checkIn(undefined);
    }

    /** The windows that looked within their time (a tab BROWSER_TTL_MS, the app's window APP_WINDOW_TTL_MS) and pass `test`. */
    windowsSeen(test = () => true, { tab = BROWSER_TTL_MS, app = APP_WINDOW_TTL_MS } = {}) {
        const now = this.now();
        return [...this.windows.values()].filter((seen) => now - seen.seenAt < (seen.app ? app : tab) && test(seen));
    }

    /** A window is around that shows news now, or will once its browser is allowed to ('default'). */
    browserAlive() {
        return this.windowsSeen((seen) => canShow(seen) || seen.permission === 'default').length > 0;
    }

    /** The Desktop app's own window is around and may show news. */
    appWindowAlive() {
        return this.windowsSeen((seen) => seen.app && canShow(seen)).length > 0;
    }

    /**
     * Whether this window gets the queue: only a window that can show news
     * takes it (a blocked one, one with no notification support, or one not
     * allowed yet leaves it for another window or for later), and in the
     * Desktop app a browser tab leaves it to the app's window while that is
     * around, so news shows with DSH's icon.
     */
    mayTake(seen) {
        if (!canShow(seen)) return false;
        if (!this.desktopHost || seen.app) return true;
        return !this.appWindowAlive();
    }

    /** The recent entry for an id. */
    entry(id) {
        return this.recent.find((item) => item.id === id);
    }

    /** Record what became of a notification, in the recent list and in the log. */
    settle(id, state, detail, { via } = {}) {
        const entry = this.entry(id);
        if (!entry) return false;
        entry.state = state;
        entry.detail = detail;
        if (via) entry.via = via;
        entry.settledAt = new Date(this.now()).toISOString();
        this.info(`#${id} ${state}: ${detail}`);
        return true;
    }

    /**
     * What a window should take: whether the Desktop app already sends
     * natively, and the queued items this window may show. Each item given
     * is held for this window for CLAIM_MS, so another window does not show
     * it too; the window reports what it did at once (acknowledge). A window
     * that may not take any (mayTake) gets none, and the items wait.
     * @param {object} [window] - what the window says of itself (windowInfo).
     */
    pending(window) {
        const seen = this.checkIn(window);
        this.pruneQueue();
        const answer = { desktop: this.desktop !== undefined, epoch: this.epoch };
        if (answer.desktop || !this.mayTake(seen)) return { ...answer, items: [], waiting: this.queue.length };
        const now = this.now();
        const items = [];
        for (const item of this.queue) {
            const claim = this.claims.get(item.id);
            if (claim && claim.window !== seen.id && claim.until > now) continue;
            this.claims.set(item.id, { window: seen.id, until: now + CLAIM_MS });
            items.push({ ...item });
        }
        return { ...answer, items };
    }

    /** Why an item waited 5 minutes and no window showed it, from the windows that looked meanwhile. */
    staleWords() {
        const seen = this.windowsSeen(() => true, { tab: QUEUE_STALE_MS, app: QUEUE_STALE_MS });
        if (seen.length === 0 || seen.some(canShow)) return 'No DSH window that can show notifications took it within 5 minutes, so it was dropped rather than shown late.';
        if (seen.some((window) => window.permission === 'default')) return 'It waited 5 minutes for this browser to be allowed to show notifications (Allow notifications on the settings page), so it was dropped rather than shown late.';
        if (seen.some((window) => window.permission === 'denied')) return 'The DSH window that is open has notifications blocked in its browser\'s settings, so it was dropped after 5 minutes.';
        return 'The DSH window that is open has no notification support, so it was dropped after 5 minutes.';
    }

    /** Drop queued items no window would still show, and say so. */
    pruneQueue() {
        const cutoff = this.now() - QUEUE_STALE_MS;
        const stale = this.queue.filter((item) => !(Date.parse(item.at) > cutoff));
        if (stale.length === 0) return;
        this.queue = this.queue.filter((item) => Date.parse(item.at) > cutoff);
        const words = this.staleWords();
        for (const item of stale) {
            this.claims.delete(item.id);
            this.settle(item.id, 'not shown', words);
        }
        this.save();
    }

    /**
     * The window took these queued items, and says what it did with each.
     * @param {number[]} ids - the items it took off the queue.
     * @param {{ id: number, outcome: string, detail?: string }[]} [results] - what became of them
     *   (WINDOW_OUTCOMES); a show it reports later (the system's show event) comes as results alone.
     * @returns {number} how many items left the queue.
     */
    acknowledge(ids, results) {
        const taken = new Set((Array.isArray(ids) ? ids : []).filter((id) => Number.isInteger(id)));
        const before = this.queue.length;
        if (taken.size > 0) this.queue = this.queue.filter((item) => !taken.has(item.id));
        for (const id of taken) this.claims.delete(id);
        const removed = before - this.queue.length;
        let changed = removed > 0;
        const reported = new Set();
        for (const result of Array.isArray(results) ? results : []) {
            if (result === null || typeof result !== 'object' || !Number.isInteger(result.id)) continue;
            const known = WINDOW_OUTCOMES[result.outcome];
            if (!known) continue;
            const reason = typeof result.detail === 'string' && result.detail.trim() ? clipText(result.detail, 200) : '';
            const detail = result.outcome === 'failed' && reason ? `DSH's window could not show it: ${reason}.` : known.detail;
            if (this.settle(result.id, known.state, detail)) changed = true;
            reported.add(result.id);
        }
        // Taken with no word yet: the window is showing it, and reports the system's answer next.
        for (const id of taken) {
            if (reported.has(id)) continue;
            const entry = this.entry(id);
            if (entry && entry.state === 'waiting') {
                this.settle(id, 'sent', 'Handed to DSH\'s window to show.');
                changed = true;
            }
        }
        if (changed) this.save();
        return removed;
    }

    /** A test notification from the settings page, shown by the window itself: logged, and listed with the rest. */
    noteTest(outcome, detail) {
        const reason = typeof detail === 'string' && detail.trim() ? clipText(detail, 200) : '';
        const known = ['shown', 'denied', 'unconfirmed'].includes(outcome) ? WINDOW_OUTCOMES[outcome] : WINDOW_OUTCOMES.failed;
        const words = known === WINDOW_OUTCOMES.failed && reason ? `DSH's window could not show it: ${reason}.` : known.detail;
        const id = this.record({ title: 'Notifications test', body: '', kind: 'test', via: 'window', state: known.state, detail: words });
        this.save();
        return id;
    }

    /** Add a notification to the recent list (and the log); its id. */
    record({ title, body, kind, sessionId, open, via, state, detail }) {
        this.seq += 1;
        const id = this.seq;
        const at = new Date(this.now()).toISOString();
        this.recent.push({ id, at, title, body, ...(kind ? { kind } : {}), ...(sessionId ? { sessionId } : {}), ...(open && !sessionId ? { open } : {}), via, state, detail });
        if (this.recent.length > RECENT_MAX) this.recent.splice(0, this.recent.length - RECENT_MAX);
        this.info(`#${id} ${kind ? `(${kind}) ` : ''}“${clipText(title, 80)}” ${state}: ${detail}`);
        return id;
    }

    /**
     * Send one notification through the first sender that is around. Never throws.
     * @param {{title?: string, body?: string, kind?: string, sessionId?: string, open?: { panel?: string, bundle?: string }}} notification -
     *   kind, when given, gates on that event's settings switch; sessionId lets a click open that chat, and
     *   `open` another place (openTarget) when there is no chat.
     * @returns {'off'|'desktop'|'browser'|'cli'|'none'} what happened: 'browser' means queued for DSH's window,
     *   which reports later whether the system showed it (the log and the settings page say).
     */
    notify(notification = {}) {
        try {
            return this.deliver(notification !== null && typeof notification === 'object' ? notification : {});
        } catch (error) {
            this.warn(`a notification could not be handled: ${errorWords(error)}`);
            return 'none';
        }
    }

    deliver(notification) {
        const settings = this.settings() ?? {};
        const kind = typeof notification.kind === 'string' && notification.kind ? notification.kind.slice(0, 40) : undefined;
        const title = clipText(notification.title, TITLE_MAX) || 'DSH';
        const body = clipText(notification.body, BODY_MAX);
        const sessionId = typeof notification.sessionId === 'string' && notification.sessionId && notification.sessionId.length <= 200 ? notification.sessionId : undefined;
        const open = sessionId ? undefined : openTarget(notification.open, kind);
        const base = { title, body, kind, sessionId, open };
        if (settings.enabled === false) {
            this.record({ ...base, via: 'none', state: 'not shown', detail: 'Notifications are switched off in its settings.' });
            this.save();
            return 'off';
        }
        const field = EVENT_FIELDS[kind];
        if (field !== undefined && settings[field] === false) {
            this.record({ ...base, via: 'none', state: 'not shown', detail: `“${TITLES[field]}” is switched off in its settings.` });
            this.save();
            return 'off';
        }
        if (this.desktop !== undefined) {
            const id = this.record({ ...base, via: 'desktop', state: 'sent', detail: 'Handed to DSH\'s own desktop notifications (they skip while you look at DSH).' });
            try {
                desktopSend(this.desktop, { title, body });
            } catch (error) {
                this.settle(id, 'failed', `DSH's desktop notifications refused it: ${errorWords(error)}.`);
                this.save();
                return 'none';
            }
            this.save();
            return 'desktop';
        }
        // On the Desktop host the window's browser half is the DSH-icon sender,
        // and its window exists even hidden or minimised, so the queue is for
        // it whatever the polls are doing. Elsewhere (a browser profile) the
        // queue is only worth filling while a tab has polled recently.
        if (this.desktopHost || this.browserAlive()) {
            const id = this.record({ ...base, via: 'window', state: 'waiting', detail: 'Waiting for DSH\'s window to show it.' });
            this.queue.push({ id, title, body, ...(sessionId ? { sessionId } : {}), ...(open ? { open } : {}), at: new Date(this.now()).toISOString() });
            if (this.queue.length > MAX_QUEUED) {
                for (const dropped of this.queue.splice(0, this.queue.length - MAX_QUEUED)) {
                    this.settle(dropped.id, 'not shown', `More than ${MAX_QUEUED} waited for a window at once, so the oldest were dropped.`);
                }
            }
            this.save();
            return 'browser';
        }
        const command = this.platform === 'linux' ? 'notify-send' : this.platform === 'win32' ? 'a PowerShell toast' : '';
        const id = this.record({ ...base, via: command ? 'command' : 'none', state: command ? 'sent' : 'not shown', detail: command ? `No DSH window that can show notifications was open, so it went to ${command}.` : this.noSenderWords() });
        if (!command) {
            this.save();
            return 'none';
        }
        let started = false;
        try {
            started = this.send({ title, body }, (error) => {
                this.settle(id, 'failed', `${command} failed: ${errorWords(error)}.`);
                this.save();
            });
        } catch (error) {
            this.settle(id, 'failed', `${command} failed: ${errorWords(error)}.`);
        }
        if (!started && this.entry(id)?.state === 'sent') this.settle(id, 'failed', `${command} could not be started.`);
        this.save();
        return started ? 'cli' : 'none';
    }

    noSenderWords() {
        const open = this.windowsSeen((window) => !canShow(window) && window.permission !== 'default');
        const why = open.some((window) => window.permission === 'denied') ? 'The DSH window that is open has notifications blocked in its browser\'s settings'
            : open.length > 0 ? 'The DSH window that is open has no notification support'
            : 'No DSH window was open to show it';
        return this.platform === 'darwin'
            ? `${why}, and macOS has no other sender that shows DSH's icon.`
            : `${why}, and this system has no notification command DSH can use.`;
    }

    /**
     * A person clicked a notification in a window: log it, and when the
     * window could not come up by itself (hidden or minimised in the Desktop
     * app), bring it up (raise.js). Never throws.
     * @param {number} id - the notification's id (0 for the settings page's test).
     * @param {boolean} raise - the window asks to be brought up.
     * @returns {{ raised: boolean, reason?: string }}
     */
    clicked(id, raise) {
        const entry = Number.isInteger(id) && id > 0 ? this.entry(id) : undefined;
        const what = entry ? `#${entry.id} clicked` : 'a notification was clicked';
        if (!raise) {
            this.info(`${what}: DSH's window came up by itself`);
            return { raised: false };
        }
        let result;
        try {
            result = this.raiser?.raise?.() ?? { raised: false, reason: 'no way to raise the window here' };
        } catch (error) {
            result = { raised: false, reason: errorWords(error) };
        }
        if (result.raised) this.info(`${what}: brought DSH's window up (the app was asked to open again, as a click on its Dock icon does)`);
        else this.warn(`${what}: could not bring DSH's window up (${result.reason})`);
        return result;
    }

    /** Where notifications go right now, in a word: 'desktop', 'window', 'command' or 'none'. */
    sender() {
        if (this.desktop !== undefined) return 'desktop';
        if (this.desktopHost || this.browserAlive()) return 'window';
        if (this.platform === 'linux' || this.platform === 'win32') return 'command';
        return 'none';
    }

    /** What the settings page shows: where they go, settings that were wrong, and the recent ones (newest first). */
    status() {
        this.pruneQueue();
        let raise = { ok: false, reason: 'no way to raise the window here' };
        try { raise = this.raiser?.available?.() ?? raise; } catch { /* as above */ }
        return {
            enabled: this.settings()?.enabled !== false,
            sender: this.sender(),
            desktopHost: this.desktopHost,
            appWindow: this.appWindowAlive(),
            raise: raise.ok === true,
            platform: this.platform,
            windowSeenAt: this.lastBrowserSeen ? new Date(this.lastBrowserSeen).toISOString() : '',
            waiting: this.queue.length,
            problems: (this.problemsNow() ?? []).map((problem) => ({ key: problem.key, text: problem.text, ...(problem.fix ? { fix: problem.fix } : {}) })),
            logFile: this.logFile,
            recent: this.recent.slice().reverse(),
        };
    }
}
