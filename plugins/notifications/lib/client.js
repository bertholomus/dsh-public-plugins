/**
 * dsh-plugin-notifications, browser half. Two parts:
 *
 * - The settings on the plugin's page in DSH (Plugins → Notifications), in
 *   DSH's `plugins.bundle.config` slot: a master switch and one per event,
 *   written through DSH's own settings form, plus whether this browser
 *   allows the Web Notifications API (asked once, from a click).
 * - The sender for the `web` profile: the browser half polls the plugin's
 *   endpoints (remote.js) for its queue and shows each item through the
 *   Web Notifications API when the window is unfocused, then acknowledges.
 *   In the Desktop app the host half sends through DSH's own
 *   desktopRuntime instead, and the answer's `desktop` flag tells this
 *   half to stand down.
 *
 * Hand-written in the module format DSH serves to the browser, so the
 * plugin needs no build step. Each part waits for the DSH services it
 * uses, and nothing here may throw at load: DSH joins every plugin's
 * browser half into one script, and one error would stop the others.
 *
 * @module dsh-plugin-notifications/client
 */
// DSH serves browser halves in one script; never throw here, or the others stop loading too.
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-notifications',
    factory: (require) => {
        const module = { exports: {} };
        Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const ui = require('@deepseek-ai/dsh-client-ui-primitives');
        const h = React.createElement;

        /** The plugin's row id in the profile; DSH serves its settings under it. */
        const ENTRY = 'notifications';
        /** The package whose page shows the form, and the wire namespace's other half. */
        const BUNDLE = 'dsh-plugin-notifications';
        /** How often the browser half polls the queue. */
        const POLL_MS = 15000;
        /** Queued items older than this are dropped, not shown (notifier.js QUEUE_STALE_MS). */
        const STALE_MS = 5 * 60_000;

        /** The events the settings page offers, in the window notice's words. */
        const EVENTS = [
            { field: 'notifyHandback', title: 'Handbacks', hint: 'A thread reported back to its coordinating chat.' },
            { field: 'notifyFinished', title: 'Ended without a handback', hint: 'A thread ended a turn without reporting back.' },
            { field: 'notifyApproval', title: 'Waiting for approval', hint: 'A thread waits on a permission prompt.' },
            { field: 'notifyFailed', title: 'Failed after a nudge', hint: 'A thread failed again after the plugin nudged it once.' },
            { field: 'notifyStopped', title: 'Stopped after a nudge', hint: 'A thread was stopped again after the plugin nudged it once.' },
        ];

        const TEXT = {
            summary: 'System notifications when DSH\'s window is hidden or unfocused.',
            enabled: 'Send system notifications',
            enabledHint: 'When DSH\'s window is hidden or unfocused: plugin news, through the Desktop app\'s own notifications, a browser window\'s, or a command when no window is around.',
            note: 'A click brings DSH\'s window up; it does not open the chat, because DSH offers plugins no way to open one.',
            permTitle: 'This browser',
            permGranted: 'System notifications are on in this browser.',
            permDenied: 'Blocked for this site in this browser\'s settings. Allow them there to hear news in the browser profile.',
            permDefault: 'Browser notifications need your OK once.',
            permAsk: 'Allow',
            desktopRow: 'The Desktop app sends its own notifications.',
        };

        const CSS = [
            '.dshn-page{color:var(--dsw-alias-label-primary)}',
            '.dshn-section{padding:8px 0}',
            '.dshn-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:4px 0}',
            '.dshn-row-text{min-width:0}',
            '.dshn-title{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary)}',
            '.dshn-hint{margin:2px 0 0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}',
            '.dshn-note{margin:8px 0 0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}',
            '.dshn-link{padding:0;border:0;background:none;font:var(--dsw-font-s-14);color:color-mix(in srgb,var(--dsw-alias-link,var(--dsw-alias-state-business-primary)) 85%,var(--dsw-alias-label-primary));text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
            `.dshn-link:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-radius:2px}`,
            'body.wp-still .dshn-page,body.wp-still .dshn-page *,body.wp-still .dshn-page *::before,body.wp-still .dshn-page *::after{animation:none!important;transition:none!important}',
            '@media (prefers-reduced-motion:reduce){.dshn-page,.dshn-page *,.dshn-page *::before,.dshn-page *::after{animation:none!important;transition:none!important}}',
        ].join('\n');

        /** One style sheet for the whole plugin, appended to <head> once. */
        function injectStyle(doc = document) {
            if (doc.querySelector('style[data-plugin="dsh-plugin-notifications"]')) return;
            const style = doc.createElement('style');
            style.setAttribute('data-plugin', 'dsh-plugin-notifications');
            style.setAttribute('data-plugin-css', 'dsh-plugin-notifications/client.css');
            style.textContent = CSS;
            doc.head.appendChild(style);
        }

        const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

        /** Web Notifications in this window: 'granted', 'denied', 'default', 'desktop' (the Desktop app), or 'none' where the API is missing. */
        function permissionState(scope = globalThis) {
            const Notification = scope.Notification;
            if (typeof Notification !== 'function') return 'none';
            if (scope.navigator?.userAgent?.includes('Electron')) return 'desktop';
            return Notification.permission === 'granted' || Notification.permission === 'denied' ? Notification.permission : 'default';
        }

        /** Ask once, from a click; resolves to the permission after the user answers. */
        async function askPermission(scope = globalThis) {
            const Notification = scope.Notification;
            if (typeof Notification?.requestPermission !== 'function') return 'none';
            try {
                return await Notification.requestPermission();
            } catch {
                return 'denied';
            }
        }

        const permissionLine = (kind) => (kind === 'granted' ? TEXT.permGranted
            : kind === 'denied' ? TEXT.permDenied
            : kind === 'desktop' ? TEXT.desktopRow
            : kind === 'none' ? TEXT.desktopRow
            : TEXT.permDefault);

        /** The permission row: state in words, and the one-time ask as a button. */
        function PermissionRow({ permState = permissionState, askFor = askPermission }) {
            const [kind, setKind] = React.useState(() => permState());
            const ask = async () => setKind(await askFor());
            return h('section', { className: 'dshn-section', 'data-notifications-permission': kind },
                h('div', { className: 'dshn-row' },
                    h('div', { className: 'dshn-row-text' },
                        h('div', { className: 'dshn-title' }, TEXT.permTitle),
                        h('div', { className: 'dshn-hint' }, permissionLine(kind))),
                    kind === 'default' ? h('button', { type: 'button', className: 'dshn-link', onClick: ask }, TEXT.permAsk) : null));
        }

        /** The settings page's field specs: DSH's form stages drafts as text, so on/off are the words. */
        const boolSpec = (field) => ({
            field,
            format: (value) => (value === true ? 'on' : 'off'),
            parse: (text) => (text === 'on' ? { kind: 'set', value: true } : text === 'off' ? { kind: 'set', value: false } : undefined),
        });

        const FIELDS = ['enabled', ...EVENTS.map((event) => event.field)];

        const LABELS = {
            unavailable: 'The notifications plugin is not running, so its settings cannot be changed right now.',
            readOnly: 'This DSH stores settings read-only.',
            saveFailed: 'DSH did not save these. Your choices are still here, so you can try again.',
            save: 'Save',
            saving: 'Saving…',
        };

        /** The plugin page's switches, written through DSH's settings form on Save. */
        function SettingsPage({ form }) {
            const snapshot = React.useSyncExternalStore(form.subscribe, form.getSnapshot);
            const disabled = !snapshot.writable || snapshot.saving;
            const on = (name) => snapshot[name]?.text === 'on';
            const toggle = (name) => (next) => form.actions.edit(name, next ? 'on' : 'off');
            return h('div', { className: 'dshn-page', 'data-notifications-settings': true },
                h(ui.SettingsForm, { labels: LABELS, state: snapshot, onSave: form.actions.save, onDiscard: form.actions.discard },
                    h('section', { className: 'dshn-section', 'data-notifications-master': '' },
                        h('div', { className: 'dshn-row' },
                            h('div', { className: 'dshn-row-text' },
                                h('div', { className: 'dshn-title' }, TEXT.enabled),
                                h('div', { className: 'dshn-hint' }, TEXT.enabledHint)),
                            h(ui.Switch, { checked: on('enabled'), label: TEXT.enabled, disabled, onChange: toggle('enabled') }))),
                    ...EVENTS.map((event) => h('section', { key: event.field, className: 'dshn-section', 'data-notifications-event': event.field },
                        h('div', { className: 'dshn-row' },
                            h('div', { className: 'dshn-row-text' },
                                h('div', { className: 'dshn-title' }, event.title),
                                h('div', { className: 'dshn-hint' }, event.hint)),
                            h(ui.Switch, { checked: on(event.field), label: event.title, disabled, onChange: toggle(event.field) })))),
                    h('p', { className: 'dshn-note' }, TEXT.note)),
                h(PermissionRow));
        }

        /** The plugin page on DSH's Plugins page, served while the plugin runs. */
        function applySettingsForm(scope) {
            const configScope = scope.configForms.get(ENTRY);
            const model = new ui.SettingsFormModel(configScope, FIELDS.map(boolSpec));
            const store = model.bind(() => ({
                ...model.shell(),
                ...Object.fromEntries(FIELDS.map((name) => [name, model.field(name)])),
            }));
            const form = {
                subscribe: (listener) => store.subscribe(listener),
                getSnapshot: () => store.getSnapshot(),
                actions: model.actions(),
            };
            const Page = (props) => (props?.view === 'summary' ? TEXT.summary : h(SettingsPage, { form }));
            scope.effect(() => () => model.dispose(), 'notifications: settings form');
            scope.effect(() => scope.configForms.whileServed([ENTRY], () => scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
                name: 'plugins.bundle.config',
                key: BUNDLE,
            }, Page))), 'notifications: settings page');
        }

        /** The window's link to the plugin's endpoints (remote.js), like DSH's own panels use. */
        function hostLink(connectionOf) {
            return {
                async call(method, args) {
                    const connection = connectionOf();
                    if (!connection) return { ok: false, error: { code: 'notifications/unreachable', message: 'the window is not connected to DSH yet' } };
                    const result = await connection.rpc.call('/api', `${BUNDLE}/${method}`, { args });
                    return isRecord(result) && (result.ok === true || (result.ok === false && isRecord(result.error))) ? result
                        : { ok: false, error: { code: 'notifications/unreadable', message: 'the plugin sent an answer this window cannot read' } };
                },
            };
        }

        /** Show one notification, and bring the window up when it is clicked. */
        function showNotification(item, Notification = globalThis.Notification, win = globalThis.window) {
            const notification = new Notification(item.title, { body: item.body, tag: `${BUNDLE}:${item.id}` });
            notification.onclick = () => {
                try { win?.focus?.(); } catch { /* the window may be gone */ }
                notification.close();
            };
            return notification;
        }

        /**
         * The sender for the `web` profile: poll the queue, show what is new
         * while the window is unfocused, and take the rest (a focused window
         * is watching already). When the answer says the Desktop app sends
         * natively, stand down entirely.
         */
        function applyPoller(scope, link, { now = Date.now, Notification = globalThis.Notification, win = typeof window === 'undefined' ? undefined : window, doc = typeof document === 'undefined' ? undefined : document } = {}) {
            const seen = new Set();
            const state = { stopped: false, desktopHandled: false };
            const stop = () => {
                state.stopped = true;
            };
            const read = async () => {
                if (state.stopped) return 0;
                const result = await link.call('pending', {});
                if (state.stopped || !isRecord(result) || result.ok !== true || !isRecord(result.value)) return 0;
                if (result.value.desktop === true) {
                    state.desktopHandled = true;
                    stop();
                    return 0;
                }
                const items = Array.isArray(result.value.items) ? result.value.items.filter(isRecord) : [];
                if (items.length === 0) return 0;
                let shown = 0;
                for (const item of items) {
                    if (typeof item.id !== 'number' || seen.has(item.id)) continue;
                    seen.add(item.id);
                    const at = typeof item.at === 'string' ? Date.parse(item.at) : NaN;
                    if (Number.isFinite(at) && now() - at > STALE_MS) continue;
                    if (typeof Notification === 'function' && Notification.permission === 'granted' && doc && !doc.hasFocus()) {
                        try {
                            showNotification(item, Notification, win);
                            shown += 1;
                        } catch { /* a browser that refuses one notification still takes the rest */ }
                    }
                }
                void link.call('acknowledge', { ids: items.map((item) => item.id).filter((id) => typeof id === 'number') });
                return shown;
            };
            const timer = setInterval(() => { void read(); }, POLL_MS);
            const wake = () => { void read(); };
            if (doc) {
                doc.addEventListener('visibilitychange', wake);
                win?.addEventListener?.('focus', wake);
            }
            scope.effect(() => () => {
                stop();
                clearInterval(timer);
                if (doc) {
                    doc.removeEventListener('visibilitychange', wake);
                    win?.removeEventListener?.('focus', wake);
                }
            }, 'notifications: browser sender');
            return { read, state };
        }

        const inject = ['slots'];

        function apply(ctx) {
            // One part failing must not stop the others (DESIGN.md §8).
            try {
                injectStyle();
            } catch (error) {
                console?.warn?.('dsh-plugin-notifications: style:', error);
            }
            ctx.inject(['configForms', 'remote', 'remote.session'], (scope) => {
                try {
                    applySettingsForm(scope);
                } catch (error) {
                    console?.warn?.('dsh-plugin-notifications: settings page:', error);
                }
            });
            ctx.inject(['connection'], (scope) => {
                try {
                    applyPoller(scope, hostLink(() => scope.connection));
                } catch (error) {
                    console?.warn?.('dsh-plugin-notifications: browser sender:', error);
                }
            });
        }

        module.exports.inject = inject;
        module.exports.apply = apply;
        // For the plugin's own tests: the pure helpers the parts are built on.
        module.exports.internals = {
            FIELDS, EVENTS, TEXT, LABELS, CSS, boolSpec, injectStyle, permissionState, askPermission, permissionLine, hostLink, showNotification, isRecord, applyPoller, applySettingsForm,
        };
        return module.exports;
    },
});
