/**
 * dsh-plugin-recall, browser half: Recall's page in DSH's sidebar, the mark
 * on the turn a result opened at, the search tool's card in a chat, and its
 * settings.
 *
 * - The entry in DSH's panel list (`sidebar.panellist`, order 9) and the
 *   page in `main`: a search box with filters (kind, date, folder, model,
 *   order), results with the words that matched, a reading view of any turn
 *   or note section, how far the index has read and what happened.
 * - A result from this DSH opens its session at the exact turn: DSH opens
 *   the session, pages its history back to the turn (the session's own
 *   `loadThrough`, as DSH's turn jump does), and the turn gets a short
 *   "Found by Recall" card (`conversation.chat.turnTail`, order 50) with a
 *   line down its rows, until the person is done with it. Transcripts, notes
 *   and other DSH homes' sessions open in Recall's reading view.
 * - The search tool's card (`tool.call.toolview`): what the agent searched
 *   for and what it found, each result one press from its turn.
 * - Its settings on its page in Plugins (DSH's `plugins.bundle.config`),
 *   folder lists included, saved through DSH's own settings form.
 *
 * Hand-written in the module format DSH serves to the browser (no build
 * step). Nothing here may throw at load: DSH joins every plugin's browser
 * half into one script, and one error would stop the others.
 *
 * @module dsh-plugin-recall/client
 */
// DSH serves browser halves in one script; never throw here, or the others stop loading too.
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-recall',
    factory: (require) => {
        const module = { exports: {} };
        Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const ui = require('@deepseek-ai/dsh-client-ui-primitives');
        const h = React.createElement;

        // <suite-kit>
// The suite's window kit (source: shared/client-kit.js; copied by scripts/sync-shared.mjs, checked by npm test).
function suiteKit({ prefix: P, bundle, React, ui, h }) {
    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const win = typeof window === 'undefined' ? undefined : window;
    const doc = typeof document === 'undefined' ? undefined : document;

    const css = [
        `:is(.${P}-page,.${P}-pane,.${P}-pop){--${P}-glass:rgba(14,18,17,var(--wp-tint,.55));--${P}-conv:rgba(10,13,12,calc(var(--wp-tint,.55) + .2));--${P}-fill:rgba(255,255,255,.04);--${P}-text-2:color-mix(in srgb,var(--dsw-alias-label-secondary) 80%,var(--dsw-alias-label-primary));--${P}-glyph:color-mix(in srgb,var(--dsw-alias-label-tertiary) 75%,var(--dsw-alias-label-primary));--${P}-error:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary));--${P}-link:color-mix(in srgb,var(--dsw-alias-link,var(--dsw-alias-state-business-primary)) 85%,var(--dsw-alias-label-primary));--${P}-ok:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-label-primary));--${P}-warn:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-label-primary));--${P}-ring:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}`,
        `body:not([data-ds-dark-theme]) :is(.${P}-page,.${P}-pane,.${P}-pop){--${P}-glass:rgba(250,250,246,var(--wp-tint,.55));--${P}-conv:rgba(250,250,246,calc(var(--wp-tint,.55) + .2));--${P}-fill:rgba(20,26,22,.035)}`,
        `@media (prefers-reduced-transparency:reduce){:is(.${P}-page,.${P}-pane,.${P}-pop){--${P}-glass:rgba(14,18,17,.9);--${P}-conv:rgba(10,13,12,.95)}body:not([data-ds-dark-theme]) :is(.${P}-page,.${P}-pane,.${P}-pop){--${P}-glass:rgba(250,250,246,.9);--${P}-conv:rgba(250,250,246,.95)}}`,
        `.${P}-page{box-sizing:border-box;height:100%;overflow:auto;padding:12px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}`,
        `[data-platform=darwin] .${P}-page{padding-top:calc(12px + var(--dsh-frame-top-clearance,0px))}`,
        `.${P}-stack{display:flex;flex-direction:column;gap:12px;max-width:1040px;margin:0 auto;min-width:0}`,
        `.${P}-card{box-sizing:border-box;min-width:0;background:var(--${P}-glass);-webkit-backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:14px 16px}`,
        `.${P}-card.${P}-main{background:var(--${P}-conv)}`,
        `.${P}-card .${P}-card{background:var(--${P}-fill);-webkit-backdrop-filter:none;backdrop-filter:none}`,
        `.${P}-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}`,
        `.${P}-head-text{min-width:0;flex:1 1 240px}`,
        `.${P}-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}`,
        `.${P}-h1{margin:0;font:var(--dsw-font-l-20);color:var(--dsw-alias-label-primary)}`,
        `.${P}-h2{margin:0;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}`,
        `.${P}-sub{margin:2px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
        `.${P}-note{margin:8px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
        `.${P}-num{font-variant-numeric:tabular-nums}`,
        `.${P}-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column}`,
        `.${P}-item{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}`,
        `.${P}-item:first-child{border-top:0}`,
        `.${P}-item-main{min-width:0;flex:1 1 auto}`,
        `.${P}-item-side{flex:0 0 auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}`,
        `.${P}-title{font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}`,
        `.${P}-meta{margin-top:2px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2);overflow-wrap:anywhere}`,
        `.${P}-why{margin-top:4px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
        `.${P}-quote{margin:6px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}`,
        `.${P}-link{padding:0;border:0;background:none;font:inherit;color:var(--${P}-link);text-decoration:underline;text-underline-offset:2px;cursor:pointer;text-align:left;overflow-wrap:anywhere}`,
        `.${P}-error{color:var(--${P}-error)}`,
        `.${P}-ok{color:var(--${P}-ok)}`,
        `.${P}-alert{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-error)}`,
        `.${P}-empty{padding:18px 4px;text-align:left}`,
        `.${P}-empty-title{font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}`,
        `.${P}-empty-text{margin:4px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2);max-width:60ch}`,
        `.${P}-loading{padding:18px 4px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
        `.${P}-loading::after{content:"";display:inline-block;width:1.2em;text-align:left;animation:${P}-dots 1.2s steps(4,end) infinite}`,
        `@keyframes ${P}-dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}`,
        `.${P}-page :is(button,a,input,select,textarea,[tabindex]):focus-visible,.${P}-pane :is(button,a,input,select,textarea,[tabindex]):focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px;border-radius:var(--dsw-radius-xs)}`,
        `.${P}-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}`,
        `.${P}-glyph{color:var(--${P}-glyph)}`,
        `.${P}-badge{position:absolute;top:-5px;right:-7px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:color-mix(in srgb,var(--dsw-static-red-600,#ec1313) 90%,var(--dsw-static-neutral-bluish-1000,#0f1115));color:var(--dsw-static-neutral-bluish-00,#ffffff);font:600 10px/14px var(--dsw-font-family,system-ui);font-variant-numeric:tabular-nums;text-align:center}`,
        `.${P}-icon{position:relative;display:inline-flex;align-items:center;justify-content:center}`,
        `.${P}-trouble-title{margin:10px 0 0;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}`,
        `.${P}-trouble-text{margin:4px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2);max-width:68ch}`,
        `.${P}-trouble .${P}-actions{margin-top:10px}`,
        `.${P}-settings{display:flex;flex-direction:column;gap:0;min-width:0;color:var(--dsw-alias-label-primary)}`,
        `.${P}-set-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2);min-width:0}`,
        `.${P}-set-row:first-child{border-top:0}`,
        `.${P}-set-text{min-width:0;flex:1 1 auto}`,
        `.${P}-set-title{font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}`,
        `.${P}-set-hint{margin-top:2px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}`,
        `.${P}-set-control{flex:0 0 auto;display:flex;align-items:center;gap:10px}`,
        `.${P}-choice{display:inline-flex}.${P}-seg-none>[aria-hidden="true"]{visibility:hidden}`,
        `.${P}-set-reset{padding:0;border:0;background:none;font:var(--dsw-font-xs-13);color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));text-decoration:underline;text-underline-offset:2px;cursor:pointer}`,
        `.${P}-set-reset:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-radius:var(--dsw-radius-xs)}`,
        `.${P}-set-note{margin:10px 0 0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);max-width:72ch}`,
        `.${P}-set-group{margin:14px 0 2px;font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-secondary)}`,
        `.${P}-set-error{margin:4px 0 0;font:var(--dsw-font-xs-13);color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary))}`,
        `@media (max-width:560px){.${P}-set-row{flex-wrap:wrap}.${P}-set-control{width:100%;justify-content:flex-start}}`,
        // DSH's tags write a state in its own colour on a 10–12% fill of it: amber, green and blue read at 2–3.5:1 on a
        // light page. The suite's tags deepen the words toward the label colour (lighter in dark mode), 4.5:1 or more in both.
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag[data-tone="warning"]{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-label-primary))}`,
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag[data-tone="danger"]{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 75%,var(--dsw-alias-label-primary))}`,
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag[data-tone="success"]{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-label-primary))}`,
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag[data-tone="info"]{color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 65%,var(--dsw-alias-label-primary))}`,
        // Quiet and neutral words ("idle", "stopped") would be drawn in DSH's glyph colour, which is for glyphs, not small text.
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag:is([data-tone="quiet"],[data-tone="neutral"]){color:var(--${P}-text-2)}`,
        `.${P}-choice{display:inline-flex;flex-direction:column;align-items:inherit;gap:4px;min-width:0}`,
        `.${P}-choice-hint{font:var(--dsw-font-xxs-12);color:var(--${P}-text-2)}`,
        `.${P}-choice[aria-busy="true"]{cursor:progress}`,
        `body.wp-still :is(.${P}-page,.${P}-pane,.${P}-pop),body.wp-still :is(.${P}-page,.${P}-pane,.${P}-pop)::before,body.wp-still :is(.${P}-page,.${P}-pane,.${P}-pop)::after,body.wp-still :is(.${P}-page,.${P}-pane,.${P}-pop) *,body.wp-still :is(.${P}-page,.${P}-pane,.${P}-pop) *::before,body.wp-still :is(.${P}-page,.${P}-pane,.${P}-pop) *::after{animation:none!important;transition:none!important}`,
        `@media (prefers-reduced-motion:reduce){:is(.${P}-page,.${P}-pane,.${P}-pop),:is(.${P}-page,.${P}-pane,.${P}-pop)::before,:is(.${P}-page,.${P}-pane,.${P}-pop)::after,:is(.${P}-page,.${P}-pane,.${P}-pop) *,:is(.${P}-page,.${P}-pane,.${P}-pop) *::before,:is(.${P}-page,.${P}-pane,.${P}-pop) *::after{animation:none!important;transition:none!important}}`,
    ];

    /** Append the plugin's one style sheet to <head>, once: the kit's rules and the plugin's own. */
    /*
     * The plugin's own style sheet is found by the mark only this kit writes.
     * DSH writes data-plugin="<bundle>" on every unmarked sheet added while a
     * plugin starts, another plugin's included (and removes those with the
     * plugin), so that mark cannot say which sheet is this one.
     */
    const SHEET = `style[data-plugin-css="${bundle}/client.css"]`;
    function injectStyle(own = [], target = doc) {
        if (!target?.head) return;
        const text = [...css, ...own].join('\n');
        const found = target.querySelector?.(SHEET);
        if (found) {
            if (found.textContent !== text) found.textContent = text;
            return;
        }
        const style = target.createElement('style');
        // Marked as this plugin's from the start, so DSH never gives it to another plugin.
        style.setAttribute('data-plugin', bundle);
        style.setAttribute('data-plugin-css', `${bundle}/client.css`);
        style.textContent = text;
        target.head.appendChild(style);
    }

    /** Remove the plugin's style sheet (the plugin is switched off): its own only, never a sheet DSH marked with its name. */
    function removeStyle(target = doc) {
        const all = target?.querySelectorAll?.(SHEET);
        if (all) for (const el of [...all]) el.remove();
        else target?.querySelector?.(SHEET)?.remove();
    }

    /** The window's DSH connection, as the plugin's parts receive it. */
    const connections = { current: undefined, waiting: new Set() };
    function setConnection(connection) {
        connections.current = connection;
        if (connection) for (const done of [...connections.waiting]) done(connection);
    }
    function whenConnected(ms = 10000) {
        if (connections.current) return Promise.resolve(connections.current);
        return new Promise((resolve) => {
            const done = (value) => {
                connections.waiting.delete(done);
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => done(connections.current), ms);
            connections.waiting.add(done);
        });
    }

    /** DSH's gateway answers 404 for a plugin whose host half is not running (switched off, or it needs a plugin that is). */
    const missing = (text) => /\b404\b/.test(text);

    /**
     * A plugin's endpoints over DSH's connection: `call(method, args)` gives
     * `{ ok, value }` or `{ ok: false, error: { code, message } }`, the
     * message in words. Code `not-running`: DSH runs no such plugin now.
     */
    function link(namespace, { name = 'This plugin' } = {}) {
        const notRunning = { ok: false, error: { code: 'not-running', message: `${name} is not running in DSH.` } };
        return {
            async call(method, args = {}) {
                const connection = connections.current ?? await whenConnected();
                if (!connection) return { ok: false, error: { code: 'unreachable', message: 'This window is not connected to DSH yet.' } };
                let result;
                try {
                    result = await connection.rpc.call('/api', `${namespace}/${method}`, { args });
                } catch (error) {
                    if (missing(String(error?.message ?? error))) return notRunning;
                    return { ok: false, error: { code: 'unreachable', message: 'DSH did not answer. Check that DSH is still running, then try again.' } };
                }
                // A plugin's own refusals carry its code ("autopilot/refused"); the gateway's transport failures do not.
                if (isRecord(result) && result.ok === false && isRecord(result.error) && !String(result.error.code ?? '').includes('/') && missing(String(result.error.message ?? ''))) return notRunning;
                return isRecord(result) && (result.ok === true || (result.ok === false && isRecord(result.error))) ? result
                    : { ok: false, error: { code: 'unreadable', message: `${name} sent an answer this window cannot read. Reload the window.` } };
            },
            /** The value, or a thrown Error with the plugin's words (and its `code`). */
            async read(method, args) {
                const result = await this.call(method, args);
                if (result.ok) return result.value;
                throw Object.assign(new Error(result.error?.message || `${name} did not answer.`), { code: result.error?.code });
            },
        };
    }

    // ── DSH's Plugins page ────────────────────────────────────────────
    const nav = { current: undefined };
    /** DSH's `pluginNavigation` service, as the plugin's parts receive it. */
    function setNavigation(service) {
        nav.current = service;
    }
    /** Whether this DSH can open a plugin's page in Plugins (draw a button for it only then). */
    const canOpenPlugin = () => typeof nav.current?.openBundle === 'function';

    // A setting to bring into view when a plugin's settings next show: one per plugin, for 15 seconds, shared by
    // every suite plugin in the window (a page may open another plugin's settings).
    const FOCUS_KEY = 'dsh-plugin-suite/focus/v1';
    function focusBoard() {
        const scope = win ?? globalThis;
        if (!scope[FOCUS_KEY]) scope[FOCUS_KEY] = { asks: new Map(), subs: new Set() };
        return scope[FOCUS_KEY];
    }
    /** The setting the person was sent to look at in `packageName`'s settings, once; undefined when none. */
    function takeFocusAsk(packageName) {
        const board = focusBoard();
        const ask = board.asks.get(packageName);
        board.asks.delete(packageName);
        return ask && ask.until > Date.now() ? ask.key : undefined;
    }

    /**
     * Open a plugin's page in DSH's Plugins page (its switch and its settings);
     * false when this DSH cannot. `focus` names a setting to bring into view
     * and put the cursor in (the one a problem is about).
     */
    function openPlugin(packageName, { focus } = {}) {
        try {
            if (typeof nav.current?.openBundle !== 'function') return false;
            if (typeof focus === 'string' && focus) {
                const board = focusBoard();
                board.asks.set(packageName, { key: focus, until: Date.now() + 15000 });
                for (const fn of [...board.subs]) {
                    try { fn(packageName); } catch { /* one form never stops another */ }
                }
            }
            nav.current.openBundle(packageName);
            return true;
        } catch {
            return false;
        }
    }

    // ── One open request per window, for every suite plugin ───────────
    const HUB_KEY = 'dsh-plugin-session-watch/hub/v1';
    const HUB_NS = 'dsh-plugin-session-watch';

    function createHub() {
        const state = { providers: new Set(), subs: new Set(), since: undefined, running: false, failures: 0 };
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const hidden = () => Boolean(doc && doc.visibilityState === 'hidden');
        const visible = () => new Promise((resolve) => {
            if (!doc || !hidden()) return resolve();
            const on = () => {
                if (hidden()) return;
                doc.removeEventListener('visibilitychange', on);
                resolve();
            };
            doc.addEventListener('visibilitychange', on);
        });
        const connection = () => {
            for (const provider of state.providers) {
                try {
                    const c = provider();
                    if (c) return c;
                } catch { /* a plugin that left gives none */ }
            }
            return undefined;
        };
        const notify = (changed) => {
            for (const sub of [...state.subs]) {
                if (changed === 'all' || sub.channels.some((channel) => changed.has(channel))) {
                    try { sub.fn(); } catch { /* one window part never stops the others */ }
                }
            }
        };
        async function loop() {
            if (state.running) return;
            state.running = true;
            try {
                while (state.subs.size > 0) {
                    if (hidden()) {
                        await visible();
                        // Back in view: everything may have moved.
                        notify('all');
                        continue;
                    }
                    const c = connection();
                    if (!c) {
                        await sleep(1000);
                        continue;
                    }
                    let result;
                    try {
                        result = await c.rpc.call('/api', `${HUB_NS}/wait`, { args: { since: state.since, timeoutMs: 25000 } });
                    } catch {
                        result = undefined;
                    }
                    if (isRecord(result) && result.ok === true && isRecord(result.value)) {
                        const next = result.value;
                        const prev = state.since;
                        state.since = next;
                        state.failures = 0;
                        if (!prev || prev.epoch !== next.epoch) notify('all');
                        else {
                            const changed = new Set();
                            const was = prev.versions ?? {};
                            for (const [channel, n] of Object.entries(next.versions ?? {})) if ((was[channel] ?? 0) !== n) changed.add(channel);
                            if (changed.size) notify(changed);
                        }
                        continue;
                    }
                    // The watcher is not running (or failed): read again every few seconds (at most 10), so a page that
                    // says so comes back soon after it runs again.
                    state.failures += 1;
                    notify('all');
                    await sleep(Math.min(10000, 2000 * 2 ** Math.min(state.failures, 3)));
                }
            } finally {
                state.running = false;
            }
        }
        return {
            /** A plugin offers its connection; the hub uses any one that works. */
            attach(provider) {
                state.providers.add(provider);
                return () => state.providers.delete(provider);
            },
            /** Call `fn` when any of `channels` moves (and once at the start). */
            subscribe(channels, fn) {
                const sub = { channels, fn };
                state.subs.add(sub);
                void loop();
                return () => state.subs.delete(sub);
            },
            get since() { return state.since; },
        };
    }

    function sharedHub() {
        const scope = win ?? globalThis;
        if (!scope[HUB_KEY]) scope[HUB_KEY] = createHub();
        return scope[HUB_KEY];
    }

    const hub = {
        attach: () => sharedHub().attach(() => connections.current),
        subscribe: (channels, fn) => sharedHub().subscribe(channels, fn),
    };

    /**
     * Data from `read`, read again whenever the hub moves on one of `channels`
     * (gathered over `delayMs`). A failed read keeps the last good data and
     * says so in `error`.
     */
    function useLive(read, channels, { delayMs = 250 } = {}) {
        const [state, setState] = React.useState({ data: undefined, error: undefined, code: undefined, loading: true });
        const readRef = React.useRef(read);
        readRef.current = read;
        const timer = React.useRef(undefined);
        const alive = React.useRef(true);
        const refresh = React.useCallback(async () => {
            try {
                const data = await readRef.current();
                if (alive.current) setState({ data, error: undefined, code: undefined, loading: false });
            } catch (error) {
                if (alive.current) setState((s) => ({ data: s.data, error: String(error?.message ?? error), code: typeof error?.code === 'string' ? error.code : undefined, loading: false }));
            }
        }, []);
        const key = channels.join(',');
        React.useEffect(() => {
            alive.current = true;
            void refresh();
            const off = hub.subscribe(channels, () => {
                clearTimeout(timer.current);
                timer.current = setTimeout(() => { void refresh(); }, delayMs);
            });
            return () => {
                alive.current = false;
                clearTimeout(timer.current);
                off();
            };
        }, [key]);
        return { ...state, refresh };
    }

    // ── Words ─────────────────────────────────────────────────────────
    const clock = (at) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    /** "9:41 PM" today, "yesterday 9:41 PM", else "Oct 3, 9:41 PM". */
    function timeText(at, now = Date.now()) {
        if (!Number.isFinite(at) || at <= 0) return '';
        const when = new Date(at);
        if (sameDay(when, new Date(now))) return clock(at);
        if (sameDay(when, new Date(now - 86400000))) return `yesterday ${clock(at)}`;
        return `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${clock(at)}`;
    }

    /** "just now", "4 min ago", "2 h ago", then the date. */
    function agoText(at, now = Date.now()) {
        if (!Number.isFinite(at) || at <= 0) return '';
        const s = Math.round((now - at) / 1000);
        if (s < 45) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m} min ago`;
        const hrs = Math.round(m / 60);
        if (hrs < 24) return `${hrs} h ago`;
        return timeText(at, now);
    }

    /** A length of time in words: "5 seconds", "1 minute", "10 minutes", "2 hours", "1.5 hours". */
    function spanText(seconds) {
        const n = Number(seconds);
        if (!Number.isFinite(n) || n < 0) return '';
        const unit = (value, word) => `${value} ${word}${value === 1 ? '' : 's'}`;
        if (n < 60) return unit(Math.round(n), 'second');
        if (n < 3600) return unit(Math.round(n / 60), 'minute');
        const hours = Math.round(n / 360) / 10;
        return unit(hours, 'hour');
    }

    /** DSH's tag tone for one of the suite's state words. */
    function toneOf(word) {
        switch (word) {
            case 'running': case 'working': case 'queued': case 'in the queue': case 'sending': case 'starting': case 'waiting for a round': case 'waiting': case 'typing': case 'typed in': return 'info';
            case 'waiting for approval': case 'waiting for your answer': case 'waiting on you': case 'needs a decision': case 'asked you': case 'asks you': case 'cut off': case 'cut short': case 'backed off': case 'gave up': case 'held': case 'not confirmed': case 'waiting on a setting': case 'not proven': return 'warning';
            case 'failed': case 'blocked': case 'not delivered': case 'not started': case 'not sent': return 'danger';
            case 'delivered': case 'started': case 'done': case 'answered': case 'read': case 'sent': case 'shown': return 'success';
            case 'not shown': return 'warning';
            case 'stopped': case 'paused': case 'withdrawn': case 'taken back': return 'neutral';
            default: return 'quiet';
        }
    }

    // ── Parts ─────────────────────────────────────────────────────────

    /** A page the plugin owns in DSH's main view: unpainted root, glass cards inside. */
    function Page({ label, children, attrs = {} }) {
        return h('section', { className: `${P}-page`, 'aria-label': label, ...attrs }, h('div', { className: `${P}-stack` }, children));
    }

    /** A glass card; `main` for the card people read (tint + .2). */
    function Card({ title, sub, actions, main = false, children, className = '', attrs = {}, headingLevel = 2 }) {
        const heading = title ? h(headingLevel === 1 ? 'h1' : 'h2', { className: headingLevel === 1 ? `${P}-h1` : `${P}-h2` }, title) : null;
        return h('section', { className: `${P}-card${main ? ` ${P}-main` : ''}${className ? ` ${className}` : ''}`, ...(title ? { 'aria-label': typeof title === 'string' ? title : undefined } : {}), ...attrs },
            title || sub || actions ? h('div', { className: `${P}-head` },
                h('div', { className: `${P}-head-text` }, heading, sub ? h('p', { className: `${P}-sub` }, sub) : null),
                actions ? h('div', { className: `${P}-actions` }, actions) : null) : null,
            children);
    }

    /** An empty state that says what it means and what to do next. */
    function Empty({ title, text, action }) {
        return h('div', { className: `${P}-empty`, role: 'status' },
            h('div', { className: `${P}-empty-title` }, title),
            text ? h('p', { className: `${P}-empty-text` }, text) : null,
            action ? h('div', { style: { marginTop: '10px' } }, action) : null);
    }

    /** "Couldn't refresh: …  Retry": the old data stays on screen above it. */
    function ErrorLine({ text, onRetry, lead = 'Couldn\'t refresh' }) {
        return h('div', { className: `${P}-alert`, role: 'alert' },
            h('span', null, `${lead}: ${text}`),
            onRetry ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: onRetry }, 'Retry') : null);
    }

    function Loading({ text = 'Loading' }) {
        return h('div', { className: `${P}-loading`, role: 'status', 'aria-live': 'polite' }, text);
    }

    /** A state in words, in DSH's tag (with the suite's deeper words, see the CSS above). */
    function StateTag({ word }) {
        return h(ui.Tag, { tone: toneOf(word), className: `${P}-tag` }, word);
    }

    // One clock for every "4 min ago" in the window: it ticks every 30 seconds while something shows a time and the
    // window is in view, and once more when the window comes back into view.
    const MINUTE_KEY = 'dsh-plugin-suite/minute/v1';
    function minuteClock() {
        const scope = win ?? globalThis;
        if (scope[MINUTE_KEY]) return scope[MINUTE_KEY];
        const state = { now: Date.now(), subs: new Set(), timer: undefined };
        const hidden = () => Boolean(doc && doc.visibilityState === 'hidden');
        const tick = () => {
            state.now = Date.now();
            for (const fn of [...state.subs]) {
                try { fn(); } catch { /* one part never stops the others */ }
            }
        };
        const start = () => { if (state.timer === undefined && !hidden()) state.timer = setInterval(tick, 30000); };
        const stop = () => {
            clearInterval(state.timer);
            state.timer = undefined;
        };
        const onVisibility = () => {
            if (hidden()) return stop();
            tick();
            start();
        };
        scope[MINUTE_KEY] = {
            subscribe(fn) {
                if (state.subs.size === 0) {
                    state.now = Date.now();
                    doc?.addEventListener?.('visibilitychange', onVisibility);
                    start();
                }
                state.subs.add(fn);
                return () => {
                    state.subs.delete(fn);
                    if (state.subs.size > 0) return;
                    stop();
                    doc?.removeEventListener?.('visibilitychange', onVisibility);
                };
            },
            now: () => state.now,
        };
        return scope[MINUTE_KEY];
    }

    /** Draw the caller again every 30 seconds while the window is in view: for parts that write "4 min ago". */
    function useMinute() {
        const clock = minuteClock();
        return React.useSyncExternalStore(clock.subscribe, clock.now);
    }

    /** A time as "4 min ago" (kept current), with the full time on hover and for screen readers. */
    function TimeText({ at, now }) {
        useMinute();
        if (!Number.isFinite(at) || at <= 0) return null;
        const full = new Date(at).toLocaleString();
        return h('time', { className: `${P}-num`, dateTime: new Date(at).toISOString(), title: full }, agoText(at, now ?? Date.now()));
    }

    /**
     * A choice between a few values that commits only when the person means
     * it: a click commits at once; with the keyboard, the arrow keys move
     * between the values and Enter or Space commits the one in focus (Escape,
     * or leaving the control, goes back to the saved one). It is never
     * disabled while a change is on its way, so focus stays where it was; a
     * choice made meanwhile is applied next. `onChoose(value)` may return a
     * promise of false when the change did not go through: the control then
     * shows the saved value again.
     */
    function Choice({ id, label, value, options, busy = false, onChoose, className = '' }) {
        const [shown, setShown] = React.useState(value);
        const sent = React.useRef(undefined);
        const queued = React.useRef(undefined);
        const valueRef = React.useRef(value);
        valueRef.current = value;
        React.useEffect(() => {
            setShown(value);
            sent.current = undefined;
        }, [value]);
        const commit = (next) => {
            if (!options.some((o) => o.value === next && o.disabled !== true)) return;
            if (busy) {
                queued.current = next;
                setShown(next);
                return;
            }
            if (next === valueRef.current || next === sent.current) return;
            sent.current = next;
            setShown(next);
            void Promise.resolve(onChoose(next)).then((ok) => {
                if (ok !== false || sent.current !== next) return;
                sent.current = undefined;
                setShown(valueRef.current);
            }, () => {
                sent.current = undefined;
                setShown(valueRef.current);
            });
        };
        React.useEffect(() => {
            if (busy || queued.current === undefined) return;
            const next = queued.current;
            queued.current = undefined;
            commit(next);
        }, [busy]);
        const pending = shown !== value && shown !== sent.current && shown !== queued.current;
        const shownLabel = options.find((o) => o.value === shown)?.label ?? shown;
        const tabValue = (target) => {
            const tab = target?.closest?.('[role="tab"]');
            return tab && typeof tab.id === 'string' && tab.id.startsWith(`${id}-`) ? tab.id.slice(id.length + 1) : undefined;
        };
        return h('div', {
            className: `${P}-choice${className ? ` ${className}` : ''}`,
            'aria-busy': busy ? 'true' : undefined,
            'data-suite-choice': id,
            ...(pending ? { 'data-suite-pending': shown } : {}),
            // A click (or a key that clicks) on a value commits it; DSH's control ignores a click on the value it shows.
            onClickCapture: (event) => {
                const next = tabValue(event.target);
                if (next !== undefined) commit(next);
            },
            onKeyDownCapture: (event) => {
                if ((event.key === 'Enter' || event.key === ' ') && pending) {
                    event.preventDefault();
                    commit(shown);
                } else if (event.key === 'Escape' && pending) {
                    event.preventDefault();
                    setShown(value);
                }
            },
            onBlurCapture: (event) => {
                if (pending && !event.currentTarget.contains(event.relatedTarget)) setShown(value);
            },
        },
        h(ui.SegmentedControl, { id, label, value: shown, options, onChange: setShown }),
        h('span', { className: pending ? `${P}-choice-hint` : `${P}-sr`, role: 'status', 'aria-live': 'polite' }, pending ? `Press Enter to apply ${shownLabel}.` : ''));
    }

    // ── States every suite page shares ────────────────────────────────

    const WATCH_PACKAGE = 'dsh-plugin-session-watch';
    const watchLink = link(WATCH_PACKAGE, { name: 'Session Watch' });

    /**
     * What the page shows when its plugin cannot be read: not running (with
     * why: the Session Watch it needs is off, or the plugin itself stopped)
     * or DSH not answering. Each says what to do next, with a button to the
     * place to do it; the page comes back by itself once the plugin runs.
     */
    function Trouble({ name, packageName, code, text, onRetry, needsWatch = true }) {
        const [watchUp, setWatchUp] = React.useState(undefined);
        React.useEffect(() => {
            if (code !== 'not-running' || !needsWatch) return undefined;
            let alive = true;
            void watchLink.call('status').then((result) => { if (alive) setWatchUp(result.ok || result.error?.code !== 'not-running'); });
            return () => { alive = false; };
        }, [code, needsWatch, text]);
        const button = (label, target) => (typeof nav.current?.openBundle === 'function'
            ? h(ui.Button, { variant: 'primary', size: 'sm', onClick: () => openPlugin(target) }, label) : null);
        const retry = onRetry ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: onRetry }, 'Check again') : null;
        let kind;
        let title;
        let next;
        let action = null;
        if (code === 'not-running' && needsWatch && watchUp === false) {
            kind = 'watch-off';
            title = `${name} needs Session Watch, which is not running.`;
            next = `Switch Session Watch on in Plugins. This page comes back by itself once it runs.`;
            action = button('Open Session Watch in Plugins', WATCH_PACKAGE);
        } else if (code === 'not-running') {
            kind = 'not-running';
            title = `${name} is not running.`;
            next = `Open ${name} in Plugins and switch it off and on again. If it still does not start, restart DSH.`;
            action = button(`Open ${name} in Plugins`, packageName);
        } else {
            kind = 'unreachable';
            title = `Couldn't read ${name}.`;
            next = text || 'DSH did not answer. Check that DSH is still running, then try again.';
        }
        return h('div', { className: `${P}-trouble`, role: 'alert', 'data-suite-trouble': kind },
            h('p', { className: `${P}-trouble-title` }, title),
            h('p', { className: `${P}-trouble-text` }, next),
            h('div', { className: `${P}-actions` }, action, retry));
    }

    /** A name's possessive as the suite writes it: Autopilot's, Decisions'. */
    const whose = (name) => (/s$/.test(String(name)) ? `${name}'` : `${name}'s`);

    /**
     * A setting is wrong, so the plugin does no work: which setting, what it
     * must be, and where to change it (its settings in Plugins when the
     * person can change it there, else DSH's profile).
     */
    function SettingsProblem({ name, packageName, problem }) {
        const live = problem?.live === true;
        const its = whose(name);
        return h('div', { className: `${P}-trouble`, role: 'alert', 'data-suite-trouble': 'setting' },
            h('p', { className: `${P}-trouble-title` }, `${name} is waiting for a setting to be fixed.`),
            h('p', { className: `${P}-trouble-text` }, `${String(problem?.text ?? 'A setting is wrong').replace(/\.$/, '')}.`),
            h('p', { className: `${P}-trouble-text` }, live
                ? `Change it in ${its} settings in Plugins. ${name} starts working again as soon as you save.`
                : `Change it in ${its} entry in DSH's profile (cordis.patch.yml), then restart DSH.`),
            live && typeof nav.current?.openBundle === 'function'
                ? h('div', { className: `${P}-actions` }, h(ui.Button, { variant: 'primary', size: 'sm', onClick: () => openPlugin(packageName, { focus: problem?.key }) }, `Open ${its} settings`)) : null);
    }

    // ── Settings on the plugin's page in Plugins ──────────────────────

    /**
     * How one setting turns from its stored value into the text its control
     * shows, and back. A draft the setting cannot take (a number out of its
     * range) blocks the Save, so nothing out of range is ever stored.
     */
    function fieldSpec(f) {
        const clear = { kind: 'clear' };
        const whole = (text) => (/^\d+$/.test(text) ? Number(text) : undefined);
        // A stored value of the wrong kind shows as it is, so the form can flag it rather than show it as empty.
        const raw = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
        switch (f.kind) {
            case 'switch':
                return { field: f.name, format: (v) => (v === true ? 'on' : v === false ? 'off' : raw(v)), parse: (t) => (t === 'on' ? { kind: 'set', value: true } : t === 'off' ? { kind: 'set', value: false } : t === '' ? clear : undefined) };
            case 'choice':
                return { field: f.name, format: raw, parse: (t) => (t === '' ? clear : f.options.some((o) => o.value === t) ? { kind: 'set', value: t } : undefined) };
            case 'number':
                return {
                    field: f.name,
                    format: (v) => (Number.isFinite(v) ? String(v) : raw(v)),
                    parse: (t) => {
                        const text = String(t).trim();
                        if (text === '') return clear;
                        const n = whole(text);
                        return n !== undefined && n >= f.min && n <= f.max ? { kind: 'set', value: n } : undefined;
                    },
                };
            case 'numbers':
                return {
                    field: f.name,
                    format: (v) => (Array.isArray(v) ? v.join(', ') : raw(v)),
                    parse: (t) => {
                        const text = String(t).trim();
                        if (text === '') return clear;
                        const list = text.split(/[\s,]+/).filter(Boolean).map(whole);
                        if (list.length === 0 || list.length > (f.maxItems ?? 10)) return undefined;
                        return list.every((n) => n !== undefined && n >= f.min && n <= f.max) ? { kind: 'set', value: list } : undefined;
                    },
                };
            default:
                return {
                    field: f.name,
                    format: raw,
                    parse: (t) => {
                        const text = String(t).trim();
                        if (text === '') return clear;
                        return typeof f.accepts === 'function' && !f.accepts(text) ? undefined : { kind: 'set', value: text };
                    },
                };
        }
    }

    /** The words under a value that does not fit: what does. */
    function invalidWords(f) {
        if (f.invalid) return f.invalid;
        if (f.kind === 'number') return `A whole number from ${f.min} to ${f.max}, or empty for the default (${f.default}).`;
        if (f.kind === 'numbers') return `Up to ${f.maxItems ?? 10} whole numbers from ${f.min} to ${f.max}, with commas between them, or empty for the default (${(f.default ?? []).join(', ')}).`;
        if (f.kind === 'switch') return 'The saved value is neither on nor off. Switch it to the one you want, then save.';
        if (f.kind === 'choice') {
            const names = (f.options ?? []).map((o) => o.label);
            const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join('');
            return `The saved value is not one of the choices. Choose ${list}, then save.`;
        }
        return 'This value does not fit here.';
    }

    /**
     * A secret's row (a webhook address, a token): DSH's own secret field,
     * which shows whether one is set and where from, never the value. What is
     * typed is checked as it is typed (`f.check(text)` gives the words for a
     * value that does not fit, which then is not saved), stored in DSH's key
     * store on Save, and removable here when it lives there.
     */
    function SecretRow({ f, state, disabled, actions, keeper }) {
        const [draft, setDraft] = React.useState('');
        const [problem, setProblem] = React.useState('');
        const [removing, setRemoving] = React.useState(false);
        // Saved or discarded: the form no longer holds the draft, so the field empties.
        React.useEffect(() => { if (state.text === '' && draft !== '' && !problem) setDraft(''); }, [state.text]);
        const info = state.key ?? {};
        const fromEnvironment = info.configured && info.source === 'env';
        const stateLabel = !info.configured ? (f.unsetLabel ?? 'Not set')
            : fromEnvironment ? (f.envLabel ?? 'Set where DSH starts')
                : (f.setLabel ?? 'Set');
        const onEdit = (text) => {
            setDraft(text);
            const words = text.trim() === '' || typeof f.check !== 'function' ? '' : f.check(text.trim()) || '';
            setProblem(words);
            actions.edit(f.name, words ? '' : text);
        };
        const remove = async () => {
            setRemoving(true);
            try { await keeper?.remove(); } finally { setRemoving(false); }
        };
        return h('div', { className: `${P}-set-row`, 'data-suite-setting': f.name, 'data-suite-secret': info.configured ? (fromEnvironment ? 'env' : 'set') : 'unset' },
            h('div', { className: `${P}-set-text` },
                h(ui.SettingsSecretField, { id: `${P}-set-${f.name}`, label: f.title, hint: fromEnvironment ? (f.envHint ?? f.hint) : f.hint, disabled: disabled || info.writable === false, text: draft, configured: info.configured === true, stateLabel, onEdit }),
                problem ? h('p', { className: `${P}-set-error`, role: 'alert' }, problem) : null,
                info.configured && !fromEnvironment && info.writable !== false && keeper
                    ? h('button', { type: 'button', className: `${P}-set-reset`, disabled: disabled || removing, onClick: () => void remove() }, f.removeLabel ?? 'Remove it') : null));
    }

    /**
     * DSH's segmented control for a choice. A saved value that is not one of
     * the choices selects none: DSH's control would draw its pill outside
     * the box and leave no tab to Tab into, so the pill is hidden and the
     * first choice takes the focus.
     */
    function ChoiceControl({ id, f, value, disabled, onChange }) {
        const known = f.options.some((o) => o.value === value);
        const box = React.useRef(null);
        React.useEffect(() => {
            const tabs = box.current?.querySelectorAll?.('[role="tab"]') ?? [];
            tabs.forEach((tab, i) => { tab.tabIndex = tab.getAttribute('aria-selected') === 'true' || (!known && i === 0) ? 0 : -1; });
        });
        /*
         * With no value chosen, DSH's control walks from "before the first"
         * (an arrow right picks the first choice, an arrow left the one before
         * the last). Walk from the choice that has the cursor instead, as it
         * does once a value is chosen.
         */
        const walkUnset = (event) => {
            if (known || disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            const tabs = [...(box.current?.querySelectorAll?.('[role="tab"]') ?? [])];
            const from = Math.max(0, tabs.indexOf(event.target?.closest?.('[role="tab"]')));
            const open = f.options.map((o, i) => (o.disabled === true ? -1 : i)).filter((i) => i >= 0);
            if (!open.length) return;
            let to;
            if (event.key === 'Home') to = open[0];
            else if (event.key === 'End') to = open.at(-1);
            else {
                const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
                const n = f.options.length;
                for (let k = 1; k < n && to === undefined; k += 1) {
                    const i = ((from + step * k) % n + n) % n;
                    if (open.includes(i)) to = i;
                }
            }
            event.preventDefault();
            event.stopPropagation();
            if (to !== undefined) onChange(f.options[to].value);
        };
        return h('span', { ref: box, className: `${P}-choice`, onKeyDownCapture: walkUnset, ...(known ? {} : { 'data-suite-unset': '' }) },
            h(ui.SegmentedControl, { id, label: f.title, value: known ? value : '', options: f.options, disabled, onChange, ...(known ? {} : { className: `${P}-seg-none` }) }));
    }

    /** One setting's row: a switch or a choice drawn here, anything typed in DSH's own field. */
    function SettingRow({ f, state, disabled, actions }) {
        const id = `${P}-set-${f.name}`;
        const edit = (text) => actions.edit(f.name, text);
        const reset = state.overridden
            ? h('button', { type: 'button', className: `${P}-set-reset`, disabled, onClick: () => actions.resetField(f.name), 'aria-label': `Use the default for ${f.title}` }, 'Use the default') : null;
        if (f.kind === 'switch' || f.kind === 'choice') {
            return h('div', { className: `${P}-set-row`, 'data-suite-setting': f.name, ...(state.invalid ? { 'data-suite-invalid': '' } : {}) },
                h('div', { className: `${P}-set-text` },
                    h('div', { className: `${P}-set-title`, id: `${id}-label` }, f.title),
                    h('div', { className: `${P}-set-hint` }, f.hint),
                    state.invalid ? h('p', { className: `${P}-set-error`, role: 'alert' }, invalidWords(f)) : null),
                h('div', { className: `${P}-set-control` }, reset,
                    f.kind === 'switch'
                        ? h(ui.Switch, { checked: state.text === 'on', label: f.title, disabled, onChange: (next) => edit(next ? 'on' : 'off') })
                        : h(ChoiceControl, { id, f, value: state.text || f.default, disabled, onChange: edit })));
        }
        return h('div', { className: `${P}-set-row`, 'data-suite-setting': f.name, ...(state.invalid ? { 'data-suite-invalid': '' } : {}) },
            h('div', { className: `${P}-set-text` },
                h(ui.SettingsValueField, {
                    id,
                    label: f.title,
                    hint: f.hint,
                    text: state.text,
                    overridden: state.overridden,
                    invalid: state.invalid,
                    overriddenLabel: 'Changed',
                    resetLabel: 'Use the default',
                    invalidLabel: invalidWords(f),
                    disabled,
                    numeric: f.kind === 'number',
                    onEdit: edit,
                    onReset: () => actions.resetField(f.name),
                })));
    }

    /** Bring a setting's row into view and put the cursor in its control. */
    function focusSetting(root, key) {
        const row = [...(root?.querySelectorAll?.('[data-suite-setting]') ?? [])].find((el) => el.getAttribute('data-suite-setting') === key);
        // Not drawn yet, or on a page that is not in view: try again in a moment.
        if (!row || row.getClientRects?.().length === 0) return false;
        row.scrollIntoView?.({ block: 'center' });
        // The value itself first: DSH's own field draws "Use the default" before its input.
        // A choice with no value chosen: its first choice, which takes the keys (not "Use the default").
        const control = ['input:not([type="hidden"])', 'textarea', 'select', '[role="tab"][aria-selected="true"]', '[role="tab"][tabindex="0"]', '[role="tab"]', '[role="switch"]', 'button']
            .map((selector) => row.querySelector(selector)).find(Boolean);
        control?.focus?.({ preventScroll: true });
        return true;
    }

    function SettingsBody({ form, name, fields, note }) {
        const snap = React.useSyncExternalStore(form.subscribe, form.getSnapshot);
        const disabled = !snap.writable || snap.saving;
        const root = React.useRef(null);
        // Sent here to fix a setting ("Open Autopilot's settings"): bring it into view, now or when it is asked for.
        React.useEffect(() => {
            const timers = new Set();
            const take = () => {
                const key = takeFocusAsk(bundle);
                if (!key) return;
                // DSH draws the page around the form a moment after it opens.
                let tries = 0;
                const attempt = () => {
                    timers.delete(timer);
                    if (focusSetting(root.current, key) || ++tries >= 20) return;
                    timer = setTimeout(attempt, 100);
                    timers.add(timer);
                };
                let timer = setTimeout(attempt, 60);
                timers.add(timer);
            };
            take();
            const board = focusBoard();
            const on = (packageName) => { if (packageName === bundle) take(); };
            board.subs.add(on);
            return () => {
                board.subs.delete(on);
                for (const t of timers) clearTimeout(t);
            };
        }, []);
        const labels = {
            unavailable: `${name} is not running, so its settings cannot be changed right now. Switch it on above.`,
            readOnly: 'This DSH keeps its settings read-only, so they cannot be changed here.',
            saveFailed: 'DSH did not save these. Your changes are still here, so you can try again.',
            save: 'Save',
            saving: 'Saving…',
        };
        const rows = [];
        for (const f of fields) {
            if (f.group) rows.push(h('h4', { key: `g-${f.name}`, className: `${P}-set-group` }, f.group));
            const state = snap[f.name] ?? { text: '', overridden: false, invalid: false };
            if (f.kind === 'secret') {
                const keeper = form.keepers?.get(f.name);
                if (keeper) rows.push(h(SecretRow, { key: f.name, f, state, disabled, actions: form.actions, keeper }));
                continue;
            }
            // DSH's form checks only what is typed; a saved value that does not fit (typed into the profile) is
            // flagged too, with what does fit.
            const wrong = !state.invalid && state.text !== '' && fieldSpec(f).parse(state.text) === undefined;
            rows.push(h(SettingRow, { key: f.name, f, state: wrong ? { ...state, invalid: true } : state, disabled, actions: form.actions }));
        }
        return h('div', { className: `${P}-settings`, 'data-suite-settings': bundle, ref: root },
            h(ui.SettingsForm, { labels, state: snap, onSave: form.actions.save, onDiscard: form.actions.discard },
                ...rows,
                note ? h('p', { key: 'note', className: `${P}-set-note` }, note) : null));
    }

    /**
     * A secret kept in DSH's key store (never the settings file), under the
     * key name the setting `f.keyFrom` holds (else `f.defaultKey`): whether
     * one is set and where from, storing what the person typed, removing it.
     * Values only ever go to DSH; nothing here reads one back.
     */
    function keyKeeper(ctx, scope, f, changed) {
        const credentials = ctx.remote.credentials;
        const refOf = () => {
            const named = scope.getSnapshot?.()?.value?.[f.keyFrom];
            return typeof named === 'string' && named ? named : f.defaultKey;
        };
        // The plugin may log it (never the value): f.stored('set' | 'removed'), not waited for, so a Save never hangs on it.
        const told = (change) => { void Promise.resolve().then(() => f.stored?.(change)).catch(() => {}); };
        const keeper = {
            info: { ref: refOf(), configured: false, writable: true },
            ref: refOf,
            async read() {
                const ref = refOf();
                try {
                    const response = await credentials.describe([ref]);
                    if (response?.ok !== true || ref !== refOf()) return;
                    const view = response.value?.[ref];
                    keeper.info = { ref, configured: view?.configured === true, writable: view?.writable !== false, ...(typeof view?.source === 'string' ? { source: view.source } : {}) };
                } catch {
                    keeper.info = { ...keeper.info, ref };
                }
                changed();
            },
            async write(text) {
                let response;
                try { response = await credentials.set(refOf(), text); } catch { response = { ok: false }; }
                await keeper.read();
                const ok = response?.ok !== false && keeper.info.configured;
                if (ok) told('set');
                return ok;
            },
            async remove() {
                try { await credentials.unset(refOf()); } catch { /* the read below shows what is stored */ }
                await keeper.read();
                if (!keeper.info.configured) told('removed');
            },
        };
        return keeper;
    }

    /**
     * Put the plugin's settings on its page in Plugins: DSH's own settings
     * form (staged as typed, written on Save), registered only while DSH
     * serves them, which is while the plugin runs. Each field:
     * `{ name, kind: 'switch'|'choice'|'number'|'numbers'|'text'|'secret', title, hint, default, min?, max?, options?, group? }`;
     * a secret also takes `keyFrom`, `defaultKey`, `check(text)`, its
     * labels (`setLabel`, `envLabel`, `unsetLabel`, `envHint`, `removeLabel`)
     * and, to log it, `stored(change)` ('set' or 'removed', never the value),
     * and needs DSH's `remote.credentials`.
     * Does nothing on a DSH without settings forms.
     */
    function applySettings(ctx, { entry, name, summary, fields, note }) {
        if (typeof ui.SettingsFormModel !== 'function' || typeof ui.SettingsForm !== 'function' || typeof ctx.configForms?.get !== 'function') return;
        const scope = ctx.configForms.get(entry);
        // DSH's key store, only for a plugin with a secret: reading remote.credentials throws in a plugin that does not inject it.
        let canKeep = false;
        if (fields.some((f) => f.kind === 'secret') && typeof ui.SettingsSecretField === 'function') {
            try { canKeep = typeof ctx.remote?.credentials?.describe === 'function'; } catch { canKeep = false; }
        }
        const plain = fields.filter((f) => f.kind !== 'secret');
        const secrets = canKeep ? fields.filter((f) => f.kind === 'secret') : [];
        let store;
        const keepers = new Map(secrets.map((f) => [f.name, keyKeeper(ctx, scope, f, () => store?.set(projection()))]));
        const model = new ui.SettingsFormModel(scope, plain.map(fieldSpec), secrets.map((f) => ({ field: f.name, write: (text) => keepers.get(f.name).write(text) })));
        const projection = () => ({
            ...model.shell(),
            ...Object.fromEntries(plain.map((f) => [f.name, model.field(f.name)])),
            ...Object.fromEntries(secrets.map((f) => [f.name, { ...model.field(f.name), key: keepers.get(f.name).info }])),
        });
        store = model.bind(projection);
        const form = { subscribe: (fn) => store.subscribe(fn), getSnapshot: () => store.getSnapshot(), actions: model.actions(), keepers };
        const View = (props) => (props?.view === 'summary' ? summary : h(SettingsBody, { form, name, fields: [...plain, ...secrets].sort((a, b) => fields.indexOf(a) - fields.indexOf(b)), note }));
        ctx.effect(() => () => model.dispose(), `${bundle}: settings form`);
        if (keepers.size > 0) {
            const readAll = () => { for (const keeper of keepers.values()) void keeper.read(); };
            readAll();
            // A key stored elsewhere (another page, another window) or a new key name: read again.
            ctx.effect(() => scope.subscribe?.(() => { for (const keeper of keepers.values()) if (keeper.ref() !== keeper.info.ref) void keeper.read(); }) ?? (() => {}), `${bundle}: settings keys`);
            if (typeof ctx.remote.$on === 'function') ctx.effect(() => ctx.remote.$on('credentials/reference-updated', (ref) => { for (const keeper of keepers.values()) if (keeper.info.ref === ref) void keeper.read(); }), `${bundle}: settings key changes`);
        }
        ctx.effect(() => ctx.configForms.whileServed([entry], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: bundle }, View))), `${bundle}: settings page`);
    }

    return {
        P, css, injectStyle, removeStyle, setConnection, whenConnected, link, hub, useLive, useMinute,
        setNavigation, canOpenPlugin, openPlugin, fieldSpec, invalidWords, applySettings,
        timeText, agoText, spanText, toneOf, isRecord,
        Page, Card, Empty, ErrorLine, Loading, StateTag, TimeText, Choice, Trouble, SettingsProblem, SettingsBody, SettingRow, SecretRow, ChoiceControl,
    };
}
// </suite-kit>

        const BUNDLE = 'dsh-plugin-recall';
        const PAGE = `${BUNDLE}:page`;
        /** The tool lib/tool.js offers agents (its card is keyed by this name; people never read it). */
        const TOOL = 'recall_search';
        const kit = suiteKit({ prefix: 'dshrc', bundle: BUNDLE, React, ui, h });
        const P = kit.P;
        const api = kit.link(BUNDLE, { name: 'Recall' });
        const CHANNELS = ['recall', 'settings'];
        /** Results a page of the search shows (and each "Show more" adds). */
        const PAGE_SIZE = 20;

        const TEXT = {
            entry: 'Recall',
            title: 'Recall',
            summary: 'Search everything you already did: this DSH\'s sessions, and the coding-agent transcripts and handoff notes named in its settings. A result opens at its turn.',
            disabled: 'Recall is switched off in DSH\'s profile (enabled: false in its entry in cordis.patch.yml), so it keeps no index. To use it, set enabled to true there; DSH applies it when you save the file. To take its page out of the sidebar as well, switch Recall off in Plugins.',
            loading: 'Reading Recall',
            search: 'Search past work',
            placeholder: 'Search sessions, transcripts and notes',
            settings: 'Settings',
            index: 'Index',
            indexSub: 'Where Recall looks, and how far it has read.',
            history: 'What happened',
            historySub: 'Newest first: index rebuilds, folders read or taken out, files it could not read, setting changes.',
            noHistory: 'Nothing yet',
            noHistoryText: 'Rebuilds, folders added or taken out, files Recall could not read and setting changes show here.',
            back: 'Back to the results',
        };

        /** One set of words for each kind of file, on every surface. */
        const KIND_WORD = Object.freeze({ session: 'Session', transcript: 'Coding-agent transcript', handoff: 'Handoff note' });
        const ROOT_WORD = Object.freeze({ session: 'DSH sessions', transcript: 'Coding-agent transcripts', handoff: 'Handoff notes' });
        const KIND_CHOICES = Object.freeze([
            { value: 'any', label: 'All' }, { value: 'session', label: 'Sessions' }, { value: 'transcript', label: 'Transcripts' }, { value: 'handoff', label: 'Notes' },
        ]);
        const WHEN_CHOICES = Object.freeze([
            { id: 'any', label: 'Any time' }, { id: 'day', label: 'Past day' }, { id: 'week', label: 'Past week' }, { id: 'month', label: 'Past month' }, { id: 'year', label: 'Past year' },
        ]);
        const SORT_CHOICES = Object.freeze([{ value: 'best', label: 'Best match' }, { value: 'newest', label: 'Newest' }]);
        /** A folder's state, as its tag says it. */
        const ROOT_STATE = Object.freeze({ waiting: 'waiting', walking: 'reading', ok: 'up to date', missing: 'not there', unreadable: 'cannot read' });
        const TONE = Object.freeze({ waiting: 'info', reading: 'info', 'up to date': 'success', 'not there': 'warning', 'cannot read': 'danger', stopped: 'danger', starting: 'info', 'starting again': 'warning' });

        /** Recall's settings on its page in Plugins: the same names as its config (lib/config.js). */
        const MAX_FOLDERS = 20;
        /** A folder list as typed: full paths or paths from ~/, commas or new lines between them; undefined when one is not a folder. */
        function folderList(text) {
            const list = String(text ?? '').split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
            if (list.length > MAX_FOLDERS) return undefined;
            return list.every((t) => t.length <= 1000 && !t.includes('\0') && (t === '~' || t.startsWith('~/') || t.startsWith('/'))) ? list : undefined;
        }
        const FOLDERS_INVALID = `Folders by their full path or a path from ~/, such as ~/notes, with commas between them: at most ${MAX_FOLDERS}. Empty for none.`;
        const folders = (f) => ({ ...f, kind: 'folders', default: [], accepts: (text) => folderList(text) !== undefined, invalid: FOLDERS_INVALID });
        const SETTINGS = [
            { name: 'sessions', kind: 'switch', title: 'Search this DSH\'s sessions', hint: 'Every turn of every session here: what was asked, the reply, and the commands and files its tools used.', default: true, group: 'What Recall searches' },
            folders({ name: 'sessionFolders', title: 'More DSH session folders', hint: 'Other DSH homes, or their sessions folders, such as ~/.dsh-test. Their turns open in Recall\'s reading view, as this DSH cannot open their sessions.' }),
            folders({ name: 'transcriptFolders', title: 'Coding-agent transcript folders', hint: 'Folders of transcripts written as JSON lines, one message a line. Folders inside them are searched too.' }),
            folders({ name: 'handoffFolders', title: 'Handoff note folders', hint: 'Folders of Markdown notes, such as handoff files: each heading\'s section is one result. Folders inside them are searched too.' }),
            { name: 'tool', kind: 'switch', title: 'Let agents search past work', hint: 'Agents get a search with the same filters as this page, and can read a past turn in full. What they read is marked as a record of earlier work, not instructions.', default: true, group: 'Agents' },
        ];
        const SETTINGS_SUMMARY = 'What Recall searches, and whether agents may search it too.';
        const SETTINGS_NOTE = 'Changes apply as soon as you save: Recall reads new folders in the background, and takes out what a removed folder held. Everything stays on this computer.';

        const CSS = [
            // The search box, its filters and the count.
            `.${P}-find{display:flex;align-items:center;gap:8px;margin-top:12px;min-width:0}`,
            `.${P}-find-box{flex:1 1 auto;min-width:0}`,
            `.${P}-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;min-width:0;container-type:inline-size}`,
            // On glass at a low tint (Wallpaper at .2, the cards at .4) over a mid picture, the suite's state words and the
            // green and red notes read at 3.3 to 4.1:1: on Recall's page they lean further toward the label colour, so they
            // read at 4.5:1 or more there, as on DSH's own ground (the real-DSH test measures both).
            `.${P}-page .${P}-tag[data-tone="success"]{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,var(--dsw-alias-label-primary))}`,
            `.${P}-page .${P}-tag[data-tone="warning"]{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,var(--dsw-alias-label-primary))}`,
            `.${P}-page .${P}-tag[data-tone="info"]{color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-label-primary))}`,
            `.${P}-page .${P}-tag[data-tone="danger"]{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-label-primary))}`,
            `.${P}-page .${P}-note.${P}-ok{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,var(--dsw-alias-label-primary))}`,
            `.${P}-page .${P}-note.${P}-error{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-label-primary))}`,
            // In a narrow card the kind switcher (DSH's segmented control, four equal columns as wide as "Transcripts")
            // would be wider than its row: there each choice is as wide as its word, and the chosen one wears the pill.
            `@container (max-width: 480px){.${P}-filters [data-suite-choice] [role="tablist"]{grid-auto-columns:auto;max-width:100%}`
                + `.${P}-filters [data-suite-choice] [role="tablist"]>[aria-hidden="true"]{display:none}`
                + `.${P}-filters [data-suite-choice] [role="tab"]{padding:0 10px}`
                + `.${P}-filters [data-suite-choice] [role="tab"][aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}}`,
            `.${P}-count{margin:12px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            // Results.
            `.${P}-results{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column}`,
            `.${P}-result{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}`,
            `.${P}-result:first-child{border-top:0}`,
            `.${P}-result-main{min-width:0;flex:1 1 auto}`,
            `.${P}-open{padding:0;border:0;background:none;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;overflow-wrap:anywhere}`,
            `.${P}-open:hover{text-decoration:underline;text-underline-offset:2px}`,
            `.${P}-snippet{margin:4px 0 0;font:var(--dsw-font-xs-13);line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}`,
            `.${P}-hit{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);color:inherit;border-radius:2px;padding:0 1px}`,
            `.${P}-asked{margin:4px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2);overflow-wrap:anywhere}`,
            `.${P}-others{margin-top:4px;display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-more{margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}`,
            // The reading view.
            `.${P}-read{margin-top:12px;min-width:0}`,
            `.${P}-read-title{margin:10px 0 0;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}`,
            `.${P}-read-label{margin:14px 0 4px;font:var(--dsw-font-xs-strong-13);color:var(--${P}-text-2)}`,
            `.${P}-read-text{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);font:var(--dsw-font-xs-13);line-height:1.55;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}`,
            `.${P}-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.95em}`,
            `.${P}-read-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}`,
            // The index and the log.
            `.${P}-status{margin:10px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-lines{margin:8px 0 0;display:flex;flex-direction:column;gap:4px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-log-time{flex:0 0 auto;min-width:64px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}`,
            `.${P}-alert[tabindex]:focus{outline:none}`,
            `.${P}-alert[tabindex]:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px}`,
            // The mark after the turn a result opened at: a card in a chat, drawn like DSH's own cards there (no blur).
            `.${P}-mark{box-sizing:border-box;margin:6px 0 2px;padding:8px 12px;max-width:100%;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}`,
            `.${P}-mark-glyph{flex:0 0 auto;display:inline-flex;color:var(--dsw-alias-state-business-primary)}`,
            `.${P}-mark-text{flex:1 1 200px;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}`,
            `.${P}-mark-strong{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}`,
            `.${P}-mark-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}`,
            // The turn a result opened at: a line down the left of its rows (DSH's rows that carry Recall's own mark), a
            // little apart from their text; a row DSH positions itself keeps the line inside its edge instead.
            `[data-recall-found="line"]{position:relative}`,
            `[data-recall-found="line"]::before{content:"";position:absolute;top:0;bottom:0;left:-14px;width:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary);pointer-events:none}`,
            `[data-recall-found="inset"]{box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}`,
            // The tool's card in a chat: DSH's tool row, and the results under it, with no ground of their own.
            `.${P}-tool-body{padding:2px 0 4px 24px;min-width:0}`,
            `.${P}-tool-list{list-style:none;margin:0;padding:0}`,
            `.${P}-tool-item{display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l4);min-width:0}`,
            `.${P}-tool-item:first-child{border-top:0}`,
            `.${P}-tool-main{flex:1 1 auto;min-width:0}`,
            `.${P}-tool-title{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}`,
            `.${P}-tool-meta{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}`,
            `.${P}-tool-snippet{margin:2px 0 0;font:var(--dsw-font-xs-13);line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}`,
            `.${P}-tool-foot{margin-top:6px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}`,
            `@media (max-width:560px){.${P}-result,.${P}-item{flex-wrap:wrap}.${P}-result .${P}-item-side,.${P}-item .${P}-item-side{width:100%;justify-content:flex-start}}`,
        ];

        // ── Words ─────────────────────────────────────────────────────

        const count = (n) => (Number.isFinite(n) ? Number(n).toLocaleString('en-US') : '0');
        const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
        const quoted = (text, n = 60) => {
            const t = String(text ?? '').replace(/\s+/g, ' ').trim();
            return t.length > n ? `“${t.slice(0, n - 1)}…”` : `“${t}”`;
        };
        const cut = (text, n) => {
            const t = String(text ?? '').replace(/\s+/g, ' ').trim();
            return t.length > n ? `${t.slice(0, n - 1)}…` : t;
        };
        const sentence = (text) => {
            const t = String(text ?? '').trim();
            return t && !/[.!?…]$/.test(t) ? `${t}.` : t;
        };
        const baseName = (path) => String(path ?? '').split('/').filter(Boolean).pop() ?? '';
        /** A path with the home folder written as ~. */
        function homeless(path, home) {
            const p = String(path ?? '');
            if (!home || typeof home !== 'string') return p;
            const base = home.replace(/\/+$/, '');
            return base && (p === base || p.startsWith(`${base}/`)) ? `~${p.slice(base.length)}` : p;
        }
        /** A result's title, or what it is when it has none. */
        function titleOf(r) {
            const t = String(r?.title ?? '').trim();
            if (t) return t;
            if (r?.kind === 'handoff') return baseName(r.path) || 'Untitled note';
            return r?.kind === 'transcript' ? 'Untitled transcript' : 'Untitled session';
        }
        const ownSession = (r) => r?.kind === 'session' && r.own === true && typeof r.sessionId === 'string' && r.sessionId !== '';
        /** A result's turn in words, for a button's name: “Long session”, turn 2 (section 2 of a note). */
        const turnName = (r, turn = r.turn) => `${quoted(titleOf(r), 60)}, ${r.kind === 'handoff' ? 'section' : 'turn'} ${turn}`;
        /** What pressing a result does, named with it: "Open “Long session” at turn 2", or "Read “Notes”, section 2 here". */
        const openName = (r, turn = r.turn, where = 'here') => (ownSession(r) ? `Open ${quoted(titleOf(r), 60)} at turn ${turn}` : `Read ${turnName(r, turn)} ${where}`);
        /** Where a result is in its file: its turn, or its note's section and line. */
        function placeOf(r) {
            if (r.kind === 'handoff') return [r.label && r.label !== r.title ? `section ${quoted(r.label, 40)}` : 'its first section', Number.isFinite(r.line) ? `line ${r.line}` : ''].filter(Boolean).join(', ');
            return Number.isFinite(r.turn) ? `turn ${r.turn}` : '';
        }
        /** A turn's state in a word or two, for its meta line ('' when it ended as it should): one word everywhere. */
        const STATE_WORD = Object.freeze({ running: 'still running', stopped: 'stopped', failed: 'failed', 'cut-off': 'cut off by a restart', 'cut-short': 'cut short', blocked: 'blocked' });
        const stateOf = (r) => (typeof r?.state === 'string' ? r.state : r?.running === true ? 'running' : '');
        /** A stopped turn in a sentence, from DSH's cause ("user", "parent", "disposed", "hook: why"). */
        function stoppedSentence(why) {
            const text = String(why ?? '');
            const kind = text.split(':')[0];
            if (kind === 'user') return 'This turn was stopped from the chat before it finished.';
            if (kind === 'parent') return 'The session that started this turn stopped it before it finished.';
            if (kind === 'disposed') return 'This turn stopped when DSH closed its session.';
            if (kind === 'hook') return `A plugin stopped this turn before it finished${text.includes(':') ? ` (${cut(text.slice(text.indexOf(':') + 1), 120)})` : ''}.`;
            return 'This turn was stopped before it finished.';
        }
        /** A turn's state in a sentence, for the reading view; '' when it ended as it should. */
        function stateSentence(t) {
            switch (stateOf(t)) {
                case 'running': return 'This turn is still running.';
                case 'stopped': return stoppedSentence(t.why);
                case 'failed': return t.why ? `This turn failed: ${sentence(cut(t.why, 300))}` : 'This turn failed.';
                case 'cut-off': return 'This turn was cut off by a restart: DSH stopped before it finished.';
                case 'cut-short': return 'This turn was cut short: its reply reached the model\'s output limit.';
                case 'blocked': return 'A plugin blocked this turn before it could go on.';
                default: return '';
            }
        }
        /** A result's kind, its folder, its model, its place (of how many) and its state, for its meta line (the time is drawn apart). */
        function metaParts(r, home, { of: total } = {}) {
            const kind = r.kind === 'session' && !r.own ? 'Session from another DSH' : KIND_WORD[r.kind] ?? 'Result';
            const place = placeOf(r);
            return [kind, r.folder ? homeless(r.folder, home) : '', r.model || '', place && Number.isFinite(total) && r.kind !== 'handoff' ? `${place} of ${count(total)}` : place, STATE_WORD[stateOf(r)] ?? ''].filter(Boolean);
        }
        /** A snippet's text with its hits as marks (the index marks them with \u0002 and \u0003). */
        function snippetParts(snippet) {
            const text = String(snippet ?? '').replace(/\s+/g, ' ').trim();
            if (!text) return [];
            return text.split(/(\u0002[^\u0003]*\u0003)/).filter(Boolean).map((part, i) => (part.startsWith('\u0002')
                ? h('mark', { key: i, className: `${P}-hit` }, part.slice(1, -1))
                : part.replace(/[\u0002\u0003]/g, '')));
        }
        /** What the turn asked, when the snippet does not already show it. */
        function askedLine(r) {
            if (r.kind === 'handoff') return '';
            const asked = cut(r.asked, 200);
            if (!asked) return '';
            const shown = String(r.snippet ?? '').replace(/[\u0002\u0003]/g, '').replace(/^…|…$/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
            return shown && asked.includes(shown) ? '' : asked;
        }
        const KIND_PLURAL = { session: ['session', 'sessions'], transcript: ['transcript', 'transcripts'], handoff: ['note', 'notes'] };
        /** "120 matching turns in 34 sessions and files · 18 ms". */
        function countLine(found, kind) {
            if (!found) return '';
            const [one, many] = KIND_PLURAL[kind] ?? ['session or file', 'sessions and files'];
            const took = Number.isFinite(found.took) ? ` · ${found.took < 1 ? '<1' : Math.round(found.took)} ms` : '';
            // Sessions whose title alone has the words: counted apart, as no turn of theirs says them.
            const titled = found.titled > 0 ? `${count(found.titled)}${found.titledMore ? '+' : ''}` : '';
            const single = found.titled === 1 && !found.titledMore;
            // A note is read in sections, not turns.
            const [unit, units] = kind === 'handoff' ? ['section', 'sections'] : ['turn', 'turns'];
            if (titled && found.total === 0 && !found.totalMore) return `No ${unit} says it; ${titled} ${single ? one : many} ${single ? 'matches' : 'match'} by title only${took}`;
            const turns = `${count(found.total)}${found.totalMore ? '+' : ''} matching ${found.total === 1 && !found.totalMore ? unit : units}`;
            const where = `${count(found.sessions)}${found.sessionsMore ? '+' : ''} ${found.sessions === 1 && !found.sessionsMore ? one : many}`;
            return `${turns} in ${where}${titled ? `, and ${titled} more by title only` : ''}${took}`;
        }

        /** Where a list stops before its end: at its 1,000th result, or at the files of the turns a search looks through. */
        function endLine(found, shown) {
            if (found?.cut === 'length') return `The list stops at ${plural(shown, 'result')}. Add a word or a filter to find others.`;
            const turns = !found?.text?.trim() ? 'newest turns' : found.sort === 'newest' ? 'newest matching turns' : 'best-matching turns';
            return `These are the sessions and files of the ${count(found?.looked ?? 0)} ${turns}. Add a word or a filter to find others.`;
        }

        // ── Shared state ──────────────────────────────────────────────

        function makeStore(initial) {
            let value = initial;
            const subs = new Set();
            return {
                get: () => value,
                set(next) {
                    value = next;
                    for (const fn of [...subs]) {
                        try { fn(); } catch { /* one part never stops the others */ }
                    }
                },
                subscribe(fn) {
                    subs.add(fn);
                    return () => subs.delete(fn);
                },
            };
        }
        const useStore = (store) => React.useSyncExternalStore(store.subscribe, store.get);
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        /** The window's document, when there is one. */
        const windowDoc = () => (typeof document === 'undefined' ? undefined : document);

        /** DSH's ways to open a session and Recall's page, set once its workspace is there. */
        const views = {
            openSession: () => false,
            openPage: () => {},
            /** DSH's sessions service (session-controller), for the turn-jump loader. */
            sessions: undefined,
        };

        /** Do something on the host: `{ value }`, or `{ problem }` in words. */
        async function run(method, args) {
            const result = await api.call(method, args);
            return result.ok ? { value: result.value } : { problem: result.error?.message || 'Recall did not answer.' };
        }

        const DEFAULT_QUERY = Object.freeze({ text: '', kind: 'any', when: 'any', folder: '', model: '', sort: 'best' });
        const filtered = (q) => q.kind !== 'any' || q.when !== 'any' || q.folder !== '' || q.model !== '';

        /**
         * The page's search, kept while the page is away (a result opened in
         * DSH, then "Back to the results"): the query, its results, the
         * reading view, the filters' choices.
         */
        function createFinder(read) {
            const store = makeStore({ query: DEFAULT_QUERY, found: undefined, results: [], loading: false, problem: '', more: false, ran: 0, turnsAt: undefined, reading: undefined });
            const facets = makeStore({ data: undefined, at: 0, loading: false, problem: '' });
            let seq = 0;
            let timer;
            const patch = (next) => store.set({ ...store.get(), ...next });
            const argsOf = (q, offset) => ({
                text: q.text,
                ...(q.kind !== 'any' ? { kind: q.kind } : {}),
                ...(q.folder ? { folder: q.folder } : {}),
                ...(q.model ? { model: q.model } : {}),
                ...(q.when !== 'any' ? { since: q.when } : {}),
                sort: q.sort,
                limit: PAGE_SIZE,
                offset,
                prefix: true,
            });
            async function search({ offset = 0, turns } = {}) {
                clearTimeout(timer);
                timer = undefined;
                const mine = ++seq;
                const q = store.get().query;
                patch({ loading: true, problem: '' });
                try {
                    const found = await read('search', { query: argsOf(q, offset) });
                    if (mine !== seq) return;
                    const prev = store.get();
                    const results = Array.isArray(found?.results) ? found.results : [];
                    patch({ loading: false, found, results: offset === 0 ? results : [...prev.results, ...results], more: found?.more === true, problem: '', ran: Date.now(), ...(turns !== undefined ? { turnsAt: turns } : {}) });
                } catch (error) {
                    if (mine !== seq) return;
                    patch({ loading: false, problem: String(error?.message ?? error) });
                }
            }
            return {
                store,
                facets,
                search,
                /** Typing: search once the person pauses (200 ms); Enter searches at once. */
                type(text) {
                    patch({ query: { ...store.get().query, text: String(text ?? '').slice(0, 500) }, reading: undefined });
                    clearTimeout(timer);
                    timer = setTimeout(() => { void search(); }, 200);
                },
                /** A filter changed: search at once. */
                choose(change) {
                    patch({ query: { ...store.get().query, ...change }, reading: undefined });
                    void search();
                },
                clearFilters() {
                    const q = store.get().query;
                    patch({ query: { ...DEFAULT_QUERY, text: q.text, sort: q.sort }, reading: undefined });
                    void search();
                },
                /** Start over with a whole query (the tool's card: "Open in Recall"). */
                set(query) {
                    patch({ query: { ...DEFAULT_QUERY, ...query }, reading: undefined, results: [], found: undefined });
                    void search();
                },
                more() {
                    return search({ offset: store.get().results.length });
                },
                /**
                 * Show one turn or note section in full, in the page's reading view. `from` is the control that
                 * opened it (a selector), where Back puts the focus again; Turn before and after pass it on.
                 */
                read(id, from) {
                    if (typeof id === 'string' && /^\d{1,12}\.\d{1,9}$/.test(id)) patch({ reading: { id, from: typeof from === 'string' ? from : undefined } });
                },
                closeReading() {
                    patch({ reading: undefined });
                },
                /** The filters' choices, read when a menu opens (kept 30 seconds). */
                async loadFacets() {
                    const f = facets.get();
                    if (f.loading || (f.data && Date.now() - f.at < 30000)) return;
                    facets.set({ ...f, loading: true, problem: '' });
                    try {
                        const data = await read('facets');
                        facets.set({ data, at: Date.now(), loading: false, problem: '' });
                    } catch (error) {
                        facets.set({ ...facets.get(), loading: false, problem: String(error?.message ?? error) });
                    }
                },
            };
        }
        const finder = createFinder((method, args) => api.read(method, args));

        /** The home folder, so paths read from ~: the page's state says it, and a tool card asks once. */
        const homeStore = makeStore(undefined);
        let homeAsked = false;
        function useHome(given) {
            const home = useStore(homeStore);
            React.useEffect(() => {
                if (given !== undefined || home !== undefined || homeAsked) return;
                homeAsked = true;
                api.read('state').then((s) => { if (typeof s?.home === 'string') homeStore.set(s.home); }, () => { homeAsked = false; });
            }, [home]);
            return given ?? home;
        }

        // ── Opening a session at a turn ───────────────────────────────

        /** The turn a result opened at, which its mark and line show until the person is done: `{ sessionId, turn, seq, query, n, landed }`. */
        const jump = makeStore(undefined);
        let jumps = 0;
        /** The rows Recall marked, so it can take its marks off again. */
        const marked = new Set();
        let landing;
        /** The landing tried when no mark was drawn, a moment after the session opened. */
        let fallback;

        function unmarkRows() {
            for (const el of marked) {
                try { el.removeAttribute('data-recall-found'); } catch { /* gone with its chat */ }
            }
            marked.clear();
        }

        /** Done with the turn: its mark and its line go. */
        function endJump() {
            clearTimeout(fallback);
            landing?.stop();
            landing = undefined;
            unmarkRows();
            jump.set(undefined);
        }

        /** Whether DSH leaves a row in the flow (so the line can sit beside it without moving anything). */
        function inFlow(row) {
            try {
                const position = typeof getComputedStyle === 'function' ? getComputedStyle(row)?.position : undefined;
                return !position || position === 'static';
            } catch {
                return false;
            }
        }

        /** The element that scrolls a chat: the nearest one around its flow that can. */
        function scrollerOf(flow) {
            for (let el = flow?.parentElement; el && el !== windowDoc()?.body; el = el.parentElement) {
                const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : undefined;
                if (style && /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
            }
            return undefined;
        }

        /**
         * Bring turn `turn` of the chat whose flow is `flow` to the top of its
         * view, and mark its rows. DSH lands a chat it opens at its end a
         * moment later, so this tries a few times over 1.5 seconds, and stops
         * as soon as the person scrolls, clicks or types there.
         */
        function land(flow, turn, n) {
            landing?.stop();
            const timers = [];
            const scroller = scrollerOf(flow);
            const target = scroller ?? flow;
            const events = ['wheel', 'touchmove', 'pointerdown', 'keydown'];
            let stopped = false;
            const stop = () => {
                stopped = true;
                for (const t of timers) clearTimeout(t);
                for (const name of events) target?.removeEventListener?.(name, stop);
            };
            for (const name of events) target?.addEventListener?.(name, stop, { passive: true });
            const attempt = () => {
                if (stopped || jump.get()?.n !== n) return;
                const rows = [...(flow.querySelectorAll?.(`[data-chat-turn="${turn}"]`) ?? [])];
                if (rows.length === 0) return;
                for (const row of rows) {
                    if (marked.has(row)) continue;
                    row.setAttribute('data-recall-found', inFlow(row) ? 'line' : 'inset');
                    marked.add(row);
                }
                const box = rows[0].getBoundingClientRect();
                if (scroller) {
                    const view = scroller.getBoundingClientRect();
                    const off = box.top - view.top - 24;
                    if (Math.abs(off) > 4) scroller.scrollTop += off;
                } else rows[0].scrollIntoView?.({ block: 'start' });
                const j = jump.get();
                if (j?.n === n && !j.landed) jump.set({ ...j, landed: true });
            };
            for (const ms of [0, 120, 350, 800, 1500]) timers.push(setTimeout(attempt, ms));
            timers.push(setTimeout(stop, 1600));
            landing = { n, stop };
            return stop;
        }

        /** No mark was drawn (a turn still open has no tail): land in the one chat on screen that holds the turn. */
        function landWithoutMark(turn, n) {
            const flows = [...(windowDoc()?.querySelectorAll?.('[data-chat-flow]') ?? [])].filter((flow) => flow.querySelector?.(`[data-chat-turn="${turn}"]`));
            if (flows.length === 1) land(flows[0], turn, n);
        }

        async function waitFor(get, ms, step = 100) {
            const until = Date.now() + ms;
            for (;;) {
                let value;
                try { value = get(); } catch { value = undefined; }
                if (value || Date.now() >= until) return value;
                await sleep(step);
            }
        }

        /**
         * Page a session's history back to `seq` with DSH's turn-jump loader.
         * The loader does nothing until the session's first page is in (a
         * session opened just now is still loading it) or while older history
         * is already being read, so it waits for both first.
         */
        async function pageBackTo(session, seq, n) {
            const snapshot = () => {
                try { return typeof session.getSnapshot === 'function' ? session.getSnapshot() : undefined; } catch { return undefined; }
            };
            if (snapshot() !== undefined) {
                await waitFor(() => {
                    const s = snapshot();
                    return jump.get()?.n !== n || !s || s.openState === 'error' || (s.openState === 'open' && !s.loadingOlder);
                }, 15000);
            }
            if (jump.get()?.n !== n) return;
            await session.loadThrough(seq);
        }

        /**
         * Open a session of this DSH at a turn: DSH opens the session, its
         * history pages back to the turn (the turn jump's own loader), and the
         * turn's mark brings it into view. False when this window cannot
         * open sessions (the caller shows the turn in Recall instead).
         */
        async function openAt({ sessionId, turn, seq, query }) {
            if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(turn)) return false;
            clearTimeout(fallback);
            landing?.stop();
            unmarkRows();
            const n = ++jumps;
            jump.set({ sessionId, turn, seq, query: cut(query, 80), n, landed: false });
            if (!views.openSession(sessionId)) {
                if (jump.get()?.n === n) jump.set(undefined);
                return false;
            }
            const binding = await waitFor(() => views.sessions?.binding?.(sessionId), 5000);
            if (jump.get()?.n !== n) return true;
            const session = binding?.session;
            if (typeof session?.loadThrough === 'function' && Number.isSafeInteger(seq) && seq > 0) {
                let timer;
                try {
                    await Promise.race([pageBackTo(session, seq, n), new Promise((resolve) => { timer = setTimeout(resolve, 20000); })]);
                } catch {
                    // The chat shows what it has; the mark finds the turn if it is there.
                } finally {
                    clearTimeout(timer);
                }
            }
            if (jump.get()?.n !== n) return true;
            fallback = setTimeout(() => {
                const j = jump.get();
                if (j?.n === n && !j.landed) landWithoutMark(turn, n);
            }, 2500);
            return true;
        }

        /** Open a result: a session of this DSH at its turn, anything else in Recall's reading view. */
        function openResult(r, { turn = r.turn, seq = r.seq, query = finder.store.get().query.text, page = false, from } = {}) {
            const id = `${r.file}.${turn}`;
            if (ownSession(r)) {
                void openAt({ sessionId: r.sessionId, turn, seq, query }).then((opened) => {
                    if (opened) return;
                    finder.read(id, from);
                    if (page) views.openPage();
                });
                return;
            }
            finder.read(id, from);
            if (page) views.openPage();
        }

        // ── The mark on the turn a result opened at ───────────────────

        function RecallGlyph({ size = 16, strokeWidth = 1.7 }) {
            return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
                h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }),
                h('path', { d: 'm15.5 15.5 5 5' }),
                h('path', { d: 'M10.5 7.4v3.1l2.1 1.5' }));
        }

        /** A search that is one "exact phrase", without its own quotes (the mark puts it in quotes already). */
        const phraseless = (text) => (/^"[^"]+"$/.test(String(text ?? '').trim()) ? String(text).trim().slice(1, -1) : text);

        /** After the turn a result opened at: "Found by Recall", and the way back. Nothing after any other turn. */
        function RecallMark({ turn, sessionId }) {
            const j = useStore(jump);
            const ref = React.useRef(null);
            const n = Number(turn?.turn);
            const mine = Boolean(j) && j.sessionId === sessionId && j.turn === n;
            React.useEffect(() => {
                if (!mine || j.landed) return undefined;
                const flow = ref.current?.closest?.('[data-chat-flow]');
                return flow ? land(flow, n, j.n) : undefined;
            }, [mine, mine ? j.n : 0]);
            if (!mine) return null;
            return h('section', { ref, className: `${P}-pane ${P}-mark`, 'aria-label': 'Found by Recall', 'data-recall-mark': '' },
                h('span', { className: `${P}-mark-glyph` }, h(RecallGlyph, { size: 14 })),
                h('span', { className: `${P}-mark-text` },
                    h('span', { className: `${P}-mark-strong` }, 'Found by Recall'),
                    j.query ? ` · turn ${n}, for ${quoted(phraseless(j.query), 60)}` : ` · turn ${n}`),
                h('span', { className: `${P}-mark-actions` },
                    h('button', { type: 'button', className: `${P}-link`, onClick: () => views.openPage() }, TEXT.back),
                    h('button', { type: 'button', className: `${P}-link`, onClick: endJump, 'aria-label': 'Done: take the mark off this turn' }, 'Done')));
        }

        // ── The page ──────────────────────────────────────────────────

        function Tag({ word }) {
            return h(ui.Tag, { tone: TONE[word] ?? kit.toneOf(word), className: `${P}-tag` }, word);
        }

        /** The index in a sentence: how much it holds, and whether it is reading. */
        function indexLine(data) {
            const ix = data.index;
            if (!ix) return 'Starting the index.';
            const t = ix.totals ?? {};
            const held = t.turns > 0 ? `Recall has ${plural(t.turns, 'turn')} from ${plural(t.files ?? 0, 'session or file', 'sessions and files')}.` : 'Recall has nothing indexed yet.';
            if (ix.busy) return `${held} ${readingWords(ix, data.home)}`;
            return `${held} Up to date.`;
        }

        /** How far a catch-up has read: "Reading new and changed files: 1,234 of 10,002 read…", or what it is looking through. */
        function readingWords(ix, home) {
            const b = ix.batch ?? { read: 0, left: ix.queued ?? 0, looking: Boolean(ix.walking) };
            const read = Math.max(0, Number(b.read) || 0);
            const total = read + Math.max(0, Number(b.left) || 0);
            const where = typeof ix.walking === 'string' && ix.walking ? homeless(ix.walking, home) : '';
            if (b.looking && total === 0) return where ? `Looking through ${where} for new and changed files…` : 'Looking for new and changed files…';
            if (b.looking) return `Reading new and changed files: ${count(read)} read so far, still looking${where ? ` through ${where}` : ''} for more…`;
            if (total === 1) return 'Reading 1 new or changed file…';
            return `Reading new and changed files: ${count(read)} of ${count(total)} read…`;
        }

        function HeaderCard({ data, children }) {
            const canOpen = kit.canOpenPlugin();
            return h(kit.Card, {
                title: TEXT.title,
                headingLevel: 1,
                main: true,
                sub: TEXT.summary,
                actions: canOpen ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => kit.openPlugin(BUNDLE) }, TEXT.settings) : null,
                attrs: { 'data-recall-header': data ? (data.enabled ? data.thread?.state ?? 'on' : 'off') : 'problem' },
            }, children);
        }

        /** DSH's own list of plugins, as its Plugins page reads it (only read: Recall never changes it). */
        const pluginList = kit.link('pluginManager', { name: 'DSH\'s plugin list' });
        /** How often the page looks again while Recall does not answer. */
        const DOWN_RECHECK_MS = 3000;

        /** What DSH's plugin list says of Recall's search side: 'starting', 'stopping', 'failed', 'off', 'on', or 'unknown'. */
        async function hostState() {
            const result = await pluginList.call('listPlugins');
            const rows = result.ok && Array.isArray(result.value) ? result.value.filter((row) => kit.isRecord(row) && row.moduleName === BUNDLE) : [];
            if (rows.length === 0) return 'unknown';
            const row = rows.find((r) => r.enabled !== false) ?? rows[0];
            if (row.enabled === false) return 'off';
            if (row.fiberPhase === 'failed') return 'failed';
            if (row.fiberPhase === 'pending' || row.fiberPhase === 'loading') return 'starting';
            if (row.fiberPhase === 'unloading') return 'stopping';
            return row.fiberPhase === 'active' ? 'on' : 'unknown';
        }

        /** The words for each of those, and whether to offer Recall's row in Plugins. None says "switch it off and on": that mends none of them. */
        const DOWN_WORDS = Object.freeze({
            starting: { title: 'Recall is starting.', text: 'This page comes back by itself in a moment.' },
            stopping: { title: 'Recall is stopping.', text: 'DSH is switching it off in Plugins. To search again, switch it on there.', open: true },
            off: { title: 'Recall is switched off in Plugins.', text: 'To search again, switch it on there. This page comes back by itself once it runs.', open: true },
            failed: { title: 'Recall could not start.', text: 'DSH stopped it as it started, so it searches nothing, and Plugins shows Problem for it. Restart DSH; if Recall stops again, DSH\'s log says why.', open: true },
            on: { title: 'Recall runs, but this page cannot reach it.', text: 'DSH did not pass this page\'s request on to Recall. Reload the window; if this stays, restart DSH.' },
            unknown: { title: 'Recall is not running.', text: 'Open Recall in Plugins to see why: Off there means it is switched off (switch it on), and Problem means it could not start (restart DSH). This page comes back by itself once it runs.', open: true },
        });

        /**
         * Recall's search side does not answer: what DSH's plugin list says of
         * it, and what to do next, looked at again every few seconds until it
         * answers. A wrong setting never lands here: Recall starts with any
         * value, and its page names the wrong one instead.
         */
        function RecallDown({ onRetry }) {
            const [state, setState] = React.useState(undefined);
            const [tick, setTick] = React.useState(0);
            React.useEffect(() => {
                let alive = true;
                void hostState().then((s) => { if (alive) setState(s); }, () => { if (alive) setState('unknown'); });
                const timer = setTimeout(() => {
                    if (!alive) return;
                    void onRetry?.();
                    setTick((n) => n + 1);
                }, DOWN_RECHECK_MS);
                return () => {
                    alive = false;
                    clearTimeout(timer);
                };
            }, [tick]);
            if (state === undefined) return h(kit.Loading, { text: 'Asking DSH about Recall' });
            const words = DOWN_WORDS[state] ?? DOWN_WORDS.unknown;
            const again = () => {
                void onRetry?.();
                setTick((n) => n + 1);
            };
            return h('div', { className: `${P}-trouble`, role: state === 'starting' ? 'status' : 'alert', 'data-suite-trouble': 'not-running', 'data-recall-down': state },
                h('p', { className: `${P}-trouble-title` }, words.title),
                h('p', { className: `${P}-trouble-text` }, words.text),
                h('div', { className: `${P}-actions` },
                    words.open && kit.canOpenPlugin() ? h(ui.Button, { variant: 'primary', size: 'sm', onClick: () => kit.openPlugin(BUNDLE) }, 'Open Recall in Plugins') : null,
                    h(ui.Button, { variant: 'ghost', size: 'sm', onClick: again }, 'Check again')));
        }

        /** The thread that owns the index stopped, or starts again: what happened, and what to do. */
        function ThreadState({ data, onRestart, busy, said }) {
            const t = data.thread ?? {};
            if (t.state === 'running') return h('p', { className: `${P}-status`, role: 'status', 'data-recall-index-line': '' }, indexLine(data));
            if (t.state === 'failed') {
                return h('div', { className: `${P}-trouble`, role: 'alert', 'data-recall-thread': 'failed' },
                    h('p', { className: `${P}-trouble-title` }, 'Recall\'s index stopped, so searches are refused.'),
                    h('p', { className: `${P}-trouble-text` }, sentence(t.problem) || 'It stopped and did not start again.'),
                    h('div', { className: `${P}-actions` }, h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: onRestart }, 'Start the index again')),
                    said ? h('p', { className: `${P}-trouble-text`, role: 'status' }, said) : null);
            }
            if (t.state === 'restarting') {
                return h('div', { className: `${P}-lines`, role: 'status', 'data-recall-thread': 'restarting' },
                    h('div', { className: `${P}-line` }, h(Tag, { word: 'starting again' }), h('span', null, sentence(t.problem) || 'The index stopped and starts again in a moment.')));
            }
            return h('div', { className: `${P}-lines`, role: 'status', 'data-recall-thread': t.state || 'starting' },
                h('div', { className: `${P}-line` }, h(Tag, { word: 'starting' }), h('span', null, 'Starting the index. Searches work in a moment.')));
        }

        /** A menu of choices for one filter, drawn as a button that says the choice. */
        function FilterMenu({ name, label, value, items, onChoose, onOpen }) {
            const [open, setOpen] = React.useState(false);
            const chosen = items.find((i) => i.id === value);
            const current = chosen?.label ?? label;
            const currentText = chosen?.full ?? (typeof chosen?.label === 'string' ? chosen.label : label);
            return h(ui.Menu, {
                open,
                onClose: () => setOpen(false),
                items,
                selectedId: value,
                portal: true,
                align: 'start',
                autoFocus: true,
                onSelect: (id) => {
                    setOpen(false);
                    onChoose(id);
                },
                anchor: h(ui.Button, {
                    variant: 'outline',
                    size: 'sm',
                    'aria-haspopup': 'menu',
                    'aria-expanded': open,
                    'aria-label': `${label}: ${currentText}`,
                    'data-recall-filter': name,
                    onClick: () => {
                        if (!open) onOpen?.();
                        setOpen(!open);
                    },
                }, current, ui.IconChevronDownOutlineRegular ? h(ui.IconChevronDownOutlineRegular, { size: 12 }) : null),
            });
        }

        /** The menus' items for folders and models: Any, the one chosen, then what the index holds (newest first). */
        /** The most characters of a folder a menu shows: DSH's menus cut a longer one at its end, where folders differ. */
        const PATH_SHOWN = 46;

        /**
         * A long path cut in the middle at whole folders: its start and as many of its last folders as fit
         * ("~/Projects/…/data/notes/projects/osprey"); a last folder too long by itself keeps its end.
         */
        function cutPath(path, max = PATH_SHOWN) {
            const p = String(path ?? '');
            if (p.length <= max) return p;
            const parts = p.split('/');
            const lead = parts[0] === '' || parts[0] === '~' ? 2 : 1;
            if (parts.length <= lead) return `${p.slice(0, Math.ceil(max / 2) - 1)}…${p.slice(p.length - Math.floor(max / 2))}`;
            const head = parts.slice(0, lead).join('/');
            let tail = parts[parts.length - 1];
            for (let i = parts.length - 2; i >= lead; i -= 1) {
                if (head.length + 3 + parts[i].length + 1 + tail.length > max) break;
                tail = `${parts[i]}/${tail}`;
            }
            if (head.length + 3 + tail.length <= max) return `${head}/…/${tail}`;
            return `${head}/…${tail.slice(tail.length - Math.max(8, max - head.length - 2))}`;
        }

        /** A folder as a menu item: cut in the middle when long, with the whole path for screen readers and on hover. */
        function folderLabel(path) {
            const cut = cutPath(path);
            if (cut === path) return path;
            return h('span', { title: path, 'data-recall-path': path }, h('span', { 'aria-hidden': 'true' }, cut), h('span', { className: `${P}-sr` }, path));
        }

        function facetItems({ facets, key, chosen, any, home }) {
            const list = Array.isArray(facets.data?.[key === 'folder' ? 'folders' : 'models']) ? facets.data[key === 'folder' ? 'folders' : 'models'] : [];
            const items = [{ id: 'any', label: any, full: any }];
            const seen = new Set();
            const add = (value) => {
                if (!value || seen.has(value) || items.length > 41) return;
                seen.add(value);
                const full = key === 'folder' ? homeless(value, home) : value;
                items.push({ id: `v:${value}`, label: key === 'folder' ? folderLabel(full) : full, full });
            };
            add(chosen);
            for (const row of list) add(row?.[key]);
            if (facets.loading && items.length === 1) items.push({ type: 'label', id: 'loading', text: 'Reading the choices…' });
            else if (facets.problem && items.length === 1) items.push({ type: 'label', id: 'problem', text: `Couldn't read the choices: ${facets.problem}` });
            else if (items.length === 1) items.push({ type: 'label', id: 'none', text: key === 'folder' ? 'No folders yet.' : 'No models yet.' });
            return items;
        }

        function Filters({ q, kinds, home }) {
            const facets = useStore(finder.facets);
            const open = () => { void finder.loadFacets(); };
            return h('div', { className: `${P}-filters`, role: 'group', 'aria-label': 'Filters', 'data-recall-filters': '' },
                kinds > 1 ? h(kit.Choice, { id: `${P}-kind`, label: 'Kind', value: q.kind, options: KIND_CHOICES, onChoose: (kind) => finder.choose({ kind }) }) : null,
                h(FilterMenu, { name: 'when', label: 'Time', value: q.when, items: WHEN_CHOICES, onChoose: (when) => finder.choose({ when }) }),
                h(FilterMenu, {
                    name: 'folder', label: 'Folder', value: q.folder ? `v:${q.folder}` : 'any', onOpen: open,
                    items: facetItems({ facets, key: 'folder', chosen: q.folder, any: 'Any folder', home }),
                    onChoose: (id) => finder.choose({ folder: id.startsWith('v:') ? id.slice(2) : '' }),
                }),
                h(FilterMenu, {
                    name: 'model', label: 'Model', value: q.model ? `v:${q.model}` : 'any', onOpen: open,
                    items: facetItems({ facets, key: 'model', chosen: q.model, any: 'Any model' }),
                    onChoose: (id) => finder.choose({ model: id.startsWith('v:') ? id.slice(2) : '' }),
                }),
                q.text.trim() ? h(kit.Choice, { id: `${P}-sort`, label: 'Order', value: q.sort, options: SORT_CHOICES, onChoose: (sort) => finder.choose({ sort }) }) : null,
                filtered(q) ? h('button', { type: 'button', className: `${P}-link`, onClick: () => finder.clearFilters(), 'data-recall-clear': '' }, 'Clear the filters') : null);
        }

        /** One result: its title opens it, then where it is, the words that matched, what was asked, its other turns. */
        function ResultRow({ r, home }) {
            const own = ownSession(r);
            const asked = askedLine(r);
            const others = Array.isArray(r.others) ? r.others.filter((o) => Number.isSafeInteger(o?.turn)) : [];
            const rest = Math.max(0, (r.hits ?? 1) - 1);
            const id = `${r.file}.${r.turn}`;
            return h('li', { className: `${P}-result`, 'data-recall-result': r.kind, 'data-recall-id': id },
                h('div', { className: `${P}-result-main` },
                    h('button', {
                        type: 'button',
                        className: `${P}-open`,
                        'data-recall-open': id,
                        'aria-label': openName(r),
                        onClick: () => openResult(r, { from: `[data-recall-open="${id}"]` }),
                    }, titleOf(r)),
                    h('div', { className: `${P}-meta` }, metaParts(r, home).join(' · '), r.time ? ' · ' : '', r.time ? h(kit.TimeText, { at: r.time }) : null),
                    r.snippet ? h('p', { className: `${P}-snippet` }, ...snippetParts(r.snippet)) : null,
                    r.titleOnly ? h('p', { className: `${P}-asked`, 'data-recall-title-only': '' }, `Only its title matches: it opens at its first ${r.kind === 'handoff' ? 'section' : 'turn'}.`) : null,
                    asked ? h('p', { className: `${P}-asked` }, `Asked: ${asked}`) : null,
                    others.length > 0 ? h('div', { className: `${P}-others` },
                        h('span', null, `${plural(rest, r.kind === 'handoff' ? 'other section' : 'other turn')} ${r.kind === 'handoff' ? 'of this note' : 'here'} ${rest === 1 ? 'matches' : 'match'}:`),
                        ...others.map((o) => h('button', {
                            key: o.turn,
                            type: 'button',
                            className: `${P}-link`,
                            'data-recall-other': `${r.file}.${o.turn}`,
                            'aria-label': openName(r, o.turn),
                            onClick: () => openResult(r, { turn: o.turn, seq: o.seq, from: `[data-recall-other="${r.file}.${o.turn}"]` }),
                        }, r.kind === 'handoff' ? `section ${o.turn}` : `turn ${o.turn}`)),
                        rest > others.length ? h('span', null, `and ${count(rest - others.length)} more`) : null) : null),
                own ? h('div', { className: `${P}-item-side` },
                    h(ui.Button, { variant: 'ghost', size: 'sm', 'aria-label': `Read ${turnName(r)} here`, onClick: () => finder.read(id, `[data-recall-peek="${id}"]`), 'data-recall-peek': id }, 'Read here')) : null);
        }

        /** One turn or note section in full, with the turns beside it, and the way into its session. */
        function ReadingView({ id, home, onBack }) {
            const [state, setState] = React.useState({ loading: true, id });
            const head = React.useRef(null);
            React.useEffect(() => {
                let alive = true;
                setState({ loading: true, id });
                api.read('turn', { id }).then(
                    (t) => { if (alive) setState({ t, id }); },
                    (error) => { if (alive) setState({ problem: String(error?.message ?? error), id }); },
                );
                return () => { alive = false; };
            }, [id]);
            React.useEffect(() => { head.current?.focus?.({ preventScroll: false }); }, [id, state.t ? 1 : 0]);
            const back = h(ui.Button, { variant: 'ghost', size: 'sm', onClick: onBack, 'data-recall-back': '' }, ui.IconChevronLeftOutlineRegular ? h(ui.IconChevronLeftOutlineRegular, { size: 12 }) : null, TEXT.back);
            if (state.loading || state.id !== id) return h('div', { className: `${P}-read`, 'data-recall-reading': id }, back, h(kit.Loading, { text: 'Reading the turn' }));
            if (state.problem) {
                return h('div', { className: `${P}-read`, 'data-recall-reading': id }, back,
                    h(kit.ErrorLine, { lead: 'Couldn\'t read it', text: state.problem }));
            }
            const t = state.t;
            const note = t.kind === 'handoff';
            const own = ownSession(t);
            const go = (n) => finder.read(`${t.file}.${n}`, finder.store.get().reading?.from);
            const where = own ? '' : `${note || t.kind === 'transcript' ? 'File' : 'Session file'}: ${homeless(t.path, home)}${t.line ? `, line ${t.line}` : ''}`;
            return h('div', { className: `${P}-read`, 'data-recall-reading': id },
                back,
                h('h3', { className: `${P}-read-title`, ref: head, tabIndex: -1 }, titleOf(t)),
                h('div', { className: `${P}-meta` }, metaParts(t, home, { of: t.count }).join(' · '), t.time ? ' · ' : '', t.time ? h(kit.TimeText, { at: t.time }) : null),
                where ? h('div', { className: `${P}-meta` }, where) : null,
                stateSentence(t) ? h('p', { className: `${P}-note`, 'data-recall-state': stateOf(t) }, stateSentence(t)) : null,
                note ? [
                    h('h4', { key: 'l', className: `${P}-read-label` }, t.label ? `Section ${quoted(t.label, 80)}` : 'The note'),
                    h('div', { key: 't', className: `${P}-read-text` }, t.reply || 'This section has no text.'),
                ] : [
                    h('h4', { key: 'al', className: `${P}-read-label` }, 'Asked'),
                    h('div', { key: 'at', className: `${P}-read-text` }, t.prompt || 'No words were kept for this request.'),
                    h('h4', { key: 'rl', className: `${P}-read-label` }, 'Reply'),
                    h('div', { key: 'rt', className: `${P}-read-text` }, t.reply || (stateOf(t) === 'running' ? 'No reply yet.' : 'This turn has no reply text.')),
                    t.tools ? h('h4', { key: 'tl', className: `${P}-read-label` }, 'Commands and files it used') : null,
                    t.tools ? h('div', { key: 'tt', className: `${P}-read-text ${P}-code` }, t.tools) : null,
                ],
                h('div', { className: `${P}-read-nav` },
                    own ? h(ui.Button, { variant: 'primary', size: 'sm', 'data-recall-go': '', onClick: () => void openAt({ sessionId: t.sessionId, turn: t.turn, seq: t.seq, query: finder.store.get().query.text }) }, 'Open the session at this turn') : null,
                    t.prev !== undefined ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => go(t.prev), 'data-recall-prev': '' }, note ? 'Section before' : 'Turn before') : null,
                    t.next !== undefined ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => go(t.next), 'data-recall-next': '' }, note ? 'Section after' : 'Turn after') : null));
        }

        /** What the results area says when it has nothing to list. */
        function NoResults({ state, data }) {
            const q = state.query;
            const found = state.found;
            const totals = data.index?.totals ?? {};
            const roots = data.index?.roots ?? [];
            if (roots.length === 0) {
                return h(kit.Empty, {
                    title: 'Recall searches nothing now',
                    text: 'Switch on “Search this DSH\'s sessions”, or add folders of coding-agent transcripts or handoff notes, in Recall\'s settings.',
                    action: kit.canOpenPlugin() ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => kit.openPlugin(BUNDLE, { focus: 'sessions' }) }, 'Open Recall\'s settings') : null,
                });
            }
            if (!q.text.trim() && !filtered(q) && !(totals.turns > 0)) {
                return data.index?.busy
                    ? h(kit.Loading, { text: 'Reading your sessions for the first time. Results show as they are read' })
                    : h(kit.Empty, { title: 'Nothing to search yet', text: 'Recall has read every folder it searches and found no turns or notes. Sessions you have from now on are added as they happen.' });
            }
            if (found?.nothing === 'no-words') {
                return h(kit.Empty, { title: 'Type a word to search for', text: 'Words with a minus in front are left out of the results, but they find nothing by themselves.' });
            }
            // The filter row has its own "Clear the filters": this one says what it does from here.
            const clear = filtered(q) ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => finder.clearFilters(), 'data-recall-unfilter': '' }, 'Search again without the filters') : null;
            if (!q.text.trim()) return h(kit.Empty, { title: 'No turns with these filters', text: 'Try another time, folder or model.', action: clear });
            return h(kit.Empty, {
                title: `Nothing matches ${quoted(q.text, 60)}`,
                text: `Try fewer or other words, or the start of a word (deplo finds deploy and deployment). "Quotes" find an exact phrase; OR between two words finds either.${filtered(q) ? ' The filters may also leave it out.' : ''}`,
                action: clear,
            });
        }

        function SearchCard({ data }) {
            const state = useStore(finder.store);
            const q = state.query;
            const home = data.home;
            const turns = data.index?.totals?.turns ?? 0;
            const input = React.useRef(null);
            // The first look (and the newest turns, while nothing is typed) follows the index as it reads.
            React.useEffect(() => {
                if (state.loading) return;
                if (state.ran === 0 || (!q.text.trim() && state.turnsAt !== turns)) void finder.search({ turns });
            }, [turns]);
            const kinds = new Set((data.index?.roots ?? []).map((r) => r.kind)).size;
            const reading = state.reading;
            const backToList = () => {
                const { from, id } = reading ?? {};
                finder.closeReading();
                setTimeout(() => {
                    const doc = windowDoc();
                    const target = (from && doc?.querySelector?.(from)) || doc?.querySelector?.(`[data-recall-open="${id}"]`) || input.current;
                    target?.focus?.();
                }, 0);
            };
            const newer = q.text.trim() && state.turnsAt !== undefined && turns > state.turnsAt && !state.loading;
            let body;
            if (reading) body = h(ReadingView, { id: reading.id, home, onBack: backToList });
            else if (state.results.length === 0 && state.loading) body = h(kit.Loading, { text: 'Searching' });
            else if (state.results.length === 0 && state.problem) body = h(kit.ErrorLine, { lead: 'Not searched', text: state.problem, onRetry: () => void finder.search({ turns }) });
            else if (state.results.length === 0 && state.ran > 0) body = h(NoResults, { state, data });
            else if (state.results.length === 0) body = h(kit.Loading, { text: 'Searching' });
            else {
                body = [
                    h('p', { key: 'count', className: `${P}-count`, role: 'status', 'aria-live': 'polite', 'data-recall-count': String(state.found?.total ?? 0) },
                        q.text.trim() ? countLine(state.found, q.kind) : 'The newest turns first. Type to search everything Recall has read.',
                        state.loading ? ' · searching…' : ''),
                    state.problem ? h(kit.ErrorLine, { key: 'error', lead: 'Not searched', text: state.problem, onRetry: () => void finder.search({ turns }) }) : null,
                    h('ul', { key: 'list', className: `${P}-results`, 'aria-label': 'Results' }, ...state.results.map((r) => h(ResultRow, { key: `${r.file}.${r.turn}`, r, home }))),
                    state.more || newer || (state.found?.cut && !state.loading) ? h('div', { key: 'more', className: `${P}-more` },
                        state.more ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: state.loading, onClick: () => void finder.more(), 'data-recall-more': '' }, 'Show more results') : null,
                        !state.more && state.found?.cut && !state.loading ? h('span', { className: `${P}-meta`, 'data-recall-end': state.found.cut }, endLine(state.found, state.results.length)) : null,
                        newer ? h('span', { className: `${P}-meta` }, 'Recall has read more since this search. ', h('button', { type: 'button', className: `${P}-link`, onClick: () => void finder.search({ turns }) }, 'Search again')) : null) : null,
                ];
            }
            return h(kit.Card, { title: TEXT.search, main: true, attrs: { 'data-recall-search': '' } },
                h('div', { className: `${P}-find` },
                    h(ui.Input, {
                        ref: input,
                        type: 'text',
                        role: 'searchbox',
                        value: q.text,
                        placeholder: TEXT.placeholder,
                        'aria-label': TEXT.search,
                        'data-recall-query': '',
                        autoFocus: !reading,
                        className: `${P}-find-box`,
                        icon: ui.IconSearchOutlineRegular ? h(ui.IconSearchOutlineRegular, { size: 14 }) : undefined,
                        onChange: (event) => finder.type(event.target.value),
                        onKeyDown: (event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                void finder.search({ turns });
                            } else if (event.key === 'Escape' && q.text !== '') {
                                event.preventDefault();
                                event.stopPropagation();
                                finder.type('');
                            }
                        },
                    }),
                    q.text !== '' ? h(ui.Button, { variant: 'ghost', size: 'sm', 'aria-label': 'Clear the search', onClick: () => { finder.type(''); input.current?.focus?.(); } }, 'Clear') : null),
                h(Filters, { q, kinds, home }),
                body);
        }

        function rootWords(root, ix) {
            const reading = ix?.busy && ix.reading?.kind === root.kind && typeof ix.reading?.path === 'string' && ix.reading.path.startsWith(`${root.root}/`);
            const word = root.state === 'ok' && (reading || ix?.walking === root.root) ? 'reading' : ROOT_STATE[root.state] ?? 'waiting';
            const parts = [];
            if (root.indexed > 0 || root.state === 'ok') parts.push(`${plural(root.indexed ?? 0, root.kind === 'handoff' ? 'note' : 'file')} · ${plural(root.turns ?? 0, root.kind === 'handoff' ? 'section' : 'turn')}`);
            if (root.problems > 0) parts.push(`${plural(root.problems, 'file')} could not be read`);
            let why = '';
            if (root.state === 'missing') why = 'This folder is not there now (a disk may be unplugged). What Recall read from it stays searchable, and it looks again every minute.';
            else if (root.state === 'unreadable') why = sentence(root.error) || 'Recall cannot read this folder. Check that DSH may read it.';
            else if (root.state === 'waiting') why = 'Not read yet.';
            else if (root.capped) why = `It holds more files than Recall reads: only the first ${count(root.files)} are searched.`;
            return { word, counts: parts.join(' · '), why };
        }

        function IndexCard({ data, onAction, busy, said }) {
            const ix = data.index;
            const roots = ix?.roots ?? [];
            const problems = Array.isArray(ix?.problems) ? ix.problems : [];
            const left = Array.isArray(data.left) ? data.left : [];
            const running = data.thread?.state === 'running';
            const t = ix?.totals ?? {};
            const sub = ix ? `${plural(t.turns ?? 0, 'turn')} from ${plural(t.files ?? 0, 'file')}${ix.bytes > 0 ? ` · ${Math.max(1, Math.round(ix.bytes / 1048576))} MB on this computer` : ''}${ix.lastRead ? ' · read ' : ''}` : TEXT.indexSub;
            // Every card on the page is read (lists, why lines, small text): glass at tint + .2, as DESIGN puts what people read.
            return h(kit.Card, { title: TEXT.index, main: true, sub: ix ? [sub, ix.lastRead ? h(kit.TimeText, { key: 't', at: ix.lastRead }) : null] : sub, attrs: { 'data-recall-index': ix?.busy ? 'reading' : 'idle' } },
                ix?.stale ? h('p', { className: `${P}-note` }, 'The index is busy reading, so this is the last count it sent.') : null,
                roots.length === 0
                    ? h(kit.Empty, {
                        title: 'No folders to search',
                        text: 'Switch on “Search this DSH\'s sessions”, or add folders, in Recall\'s settings.',
                        action: kit.canOpenPlugin() ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => kit.openPlugin(BUNDLE, { focus: 'sessions' }) }, 'Open Recall\'s settings') : null,
                    })
                    : h('ul', { className: `${P}-list` }, ...roots.map((root) => {
                        const w = rootWords(root, ix);
                        return h('li', { key: `${root.kind}:${root.root}`, className: `${P}-item`, 'data-recall-root': root.kind, 'data-recall-root-state': root.state },
                            h('div', { className: `${P}-item-main` },
                                h('div', { className: `${P}-title` }, root.own ? 'This DSH\'s sessions' : ROOT_WORD[root.kind] ?? 'Folder'),
                                h('div', { className: `${P}-meta` }, homeless(root.root, data.home), w.counts ? ` · ${w.counts}` : '', root.scanned ? ' · looked ' : '', root.scanned ? h(kit.TimeText, { at: root.scanned }) : null),
                                w.why ? h('div', { className: `${P}-why` }, w.why) : null),
                            h('div', { className: `${P}-item-side` }, h(Tag, { word: w.word })));
                    })),
                problems.length > 0 ? h('div', { 'data-recall-problems': String(problems.length) },
                    h('h3', { className: `${P}-h2`, style: { marginTop: '14px' } }, 'Files Recall could not read'),
                    h('ul', { className: `${P}-list` }, ...problems.map((p) => h('li', { key: p.id, className: `${P}-item` },
                        h('div', { className: `${P}-item-main` },
                            h('div', null, baseName(p.path)),
                            h('div', { className: `${P}-meta` }, homeless(p.path, data.home)),
                            h('div', { className: `${P}-why` }, `${sentence(p.error)} Recall reads it again when it changes.`)))))) : null,
                left.length > 0 ? h('div', { 'data-recall-left': String(left.length) },
                    h('h3', { className: `${P}-h2`, style: { marginTop: '14px' } }, 'Folders left out'),
                    h('ul', { className: `${P}-list` }, ...left.map((l) => h('li', { key: `${l.kind}:${l.root}`, className: `${P}-item` },
                        h('div', { className: `${P}-item-main` },
                            h('div', null, homeless(l.root, data.home)),
                            h('div', { className: `${P}-why` }, l.why)))))) : null,
                running && roots.length > 0 ? h('div', { className: `${P}-tools` },
                    h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => onAction('rescan'), 'data-recall-action': 'rescan' }, 'Look for changes now'),
                    h(ui.Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => onAction('rebuild'), 'data-recall-action': 'rebuild' }, 'Rebuild the index')) : null,
                h('p', { className: said?.text ? `${P}-note ${said.bad ? `${P}-error` : `${P}-ok`}` : `${P}-sr`, role: said?.bad ? 'alert' : 'status', 'aria-live': 'polite', 'data-recall-said': '' }, said?.text ?? ''));
        }

        function HistoryCard({ data }) {
            const [all, setAll] = React.useState(false);
            const history = Array.isArray(data.history) ? data.history : [];
            const shown = all ? history : history.slice(0, 20);
            return h(kit.Card, { title: TEXT.history, main: true, sub: TEXT.historySub, attrs: { 'data-recall-history': String(history.length) } },
                history.length === 0 ? h(kit.Empty, { title: TEXT.noHistory, text: TEXT.noHistoryText })
                    : [
                        h('ul', { key: 'l', className: `${P}-list` }, ...shown.map((entry) => h('li', { key: entry.id, className: `${P}-item`, 'data-recall-entry': entry.kind },
                            h('span', { className: `${P}-log-time` }, h(kit.TimeText, { at: entry.at })),
                            h('div', { className: `${P}-item-main` },
                                h('div', { className: entry.state === 'failed' ? `${P}-error` : undefined }, entry.text),
                                entry.why ? h('div', { className: `${P}-why` }, entry.why) : null)))),
                        history.length > shown.length ? h('div', { key: 'm', style: { marginTop: '8px' } }, h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setAll(true) }, `Show all ${history.length}`)) : null,
                    ]);
        }

        const ACTION_WORDS = Object.freeze({
            rescan: { done: 'Looking through every folder for new, changed and deleted files.', failed: 'Not looked' },
            rebuild: { done: 'Rebuilding the index: every file is read again. Searches keep working and find more as it goes.', failed: 'Not rebuilt' },
            restart: { done: 'Starting the index again.', failed: 'Not started' },
        });

        function RecallPage() {
            const live = kit.useLive(() => api.read('state'), CHANNELS, { delayMs: 400 });
            const [busy, setBusy] = React.useState(false);
            const [said, setSaid] = React.useState({ text: '', bad: false });
            const data = live.data;
            React.useEffect(() => {
                if (typeof data?.home === 'string' && homeStore.get() !== data.home) homeStore.set(data.home);
            }, [data?.home]);
            const act = async (method) => {
                setBusy(true);
                setSaid({ text: '', bad: false });
                const { problem } = await run(method);
                setBusy(false);
                const words = ACTION_WORDS[method];
                setSaid(problem ? { text: `${words.failed}: ${problem}`, bad: true } : { text: words.done, bad: false });
                void live.refresh();
            };
            const down = live.code === 'not-running' || (data === undefined && live.error);
            let cards;
            if (live.code === 'not-running') {
                cards = h(HeaderCard, { data: undefined }, h(RecallDown, { onRetry: live.refresh }));
            } else if (down) {
                cards = h(HeaderCard, { data: undefined }, h(kit.Trouble, { name: 'Recall', packageName: BUNDLE, code: live.code, text: live.error, onRetry: live.refresh, needsWatch: false }));
            } else if (data === undefined) {
                cards = h(kit.Card, { title: TEXT.title, headingLevel: 1, main: true }, h(kit.Loading, { text: TEXT.loading }));
            } else if (data.problem) {
                cards = [
                    h(HeaderCard, { key: 'head', data: undefined }, h(kit.SettingsProblem, { name: 'Recall', packageName: BUNDLE, problem: data.problem })),
                    h(HistoryCard, { key: 'history', data }),
                ];
            } else if (!data.enabled) {
                cards = [
                    h(HeaderCard, { key: 'head', data }, h('p', { className: `${P}-status` }, TEXT.disabled)),
                    h(HistoryCard, { key: 'history', data }),
                ];
            } else {
                const running = data.thread?.state === 'running';
                cards = [
                    h(HeaderCard, { key: 'head', data }, h(ThreadState, { data, busy, onRestart: () => void act('restart'), said: data.thread?.state === 'failed' && said.text ? said.text : '' })),
                    live.error ? h(kit.ErrorLine, { key: 'refresh', text: live.error, onRetry: live.refresh }) : null,
                    running ? h(SearchCard, { key: 'search', data }) : null,
                    h(IndexCard, { key: 'index', data, busy, said, onAction: (method) => void act(method) }),
                    h(HistoryCard, { key: 'history', data }),
                ];
            }
            return h(kit.Page, { label: TEXT.title, attrs: { 'data-recall-page': '' } }, cards);
        }

        /** The panel entry's glyph. */
        function RecallIcon({ size = 16 }) {
            return h('span', { className: `${P}-icon`, 'data-recall-icon': '' }, h(RecallGlyph, { size }));
        }

        // ── The search tool's card in a chat ──────────────────────────

        const ARG_KEYS = ['query', 'open', 'kind', 'folder', 'model', 'since', 'until'];
        /** A call's string arguments as far as they go: DSH's argument view, the call's JSON, or the prefix still streaming in. */
        function callArgs(block, raw = '') {
            const out = {};
            const view = block?.args;
            if (view && typeof view.text === 'function') {
                for (const key of ARG_KEYS) {
                    try {
                        const text = view.text(key);
                        if (typeof text === 'string') out[key] = text;
                    } catch { /* not there yet */ }
                }
                if (Object.keys(out).length > 0 || typeof raw !== 'string' || raw === '') return out;
            }
            const source = typeof raw === 'string' && raw !== '' ? raw
                : typeof block?.argsRaw === 'string' ? block.argsRaw
                    : typeof block?.call?.argsRaw === 'string' ? block.call.argsRaw : '';
            if (source === '') return out;
            try {
                const parsed = JSON.parse(source);
                if (kit.isRecord(parsed)) for (const key of ARG_KEYS) if (typeof parsed[key] === 'string') out[key] = parsed[key];
                return out;
            } catch { /* still streaming: read what is there */ }
            for (const key of ARG_KEYS) {
                const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(source);
                if (!m) continue;
                try {
                    out[key] = JSON.parse(`"${m[1].replace(/\\$/, '')}"`);
                } catch {
                    out[key] = m[1];
                }
            }
            return out;
        }

        /** The text a call gave the agent. */
        function resultText(block) {
            const content = Array.isArray(block?.content) ? block.content : [];
            return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
        }

        /** Why a call did not work, in the person's words (the host's words are for the agent). */
        function failureText(text) {
            const t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/^error:\s*/i, '');
            if (/^Give words to search for/i.test(t)) return 'the agent gave no words to search for.';
            if (/^Name a result by its id/i.test(t)) return 'the agent named a result Recall does not know.';
            return cut(t, 300) || 'Recall did not say why.';
        }

        /** What a call does, while it runs. */
        function runningTitle(a) {
            if (a.open) return 'Reading a past turn';
            return a.query ? `Searching past work for ${quoted(a.query, 50)}` : 'Searching past work';
        }

        /** What a call did, over its results. */
        function doneTitle(view, a) {
            if (view?.kind === 'turn') return `Read a past turn: ${quoted(titleOf(view.turn), 50)}`;
            const q = view?.query || a.query;
            if ((!Number.isFinite(view?.total) || view.total === 0) && view?.titled > 0) return `Searched past work for ${quoted(q, 50)}: ${plural(view.titled, 'session or file', 'sessions and files')} by title only`;
            if (!Number.isFinite(view?.total) || view.total === 0) return `Searched past work for ${quoted(q, 50)}: nothing found`;
            // With a kind asked for, its places by name (a note's are sections), as the page's count says them.
            const [one, many] = KIND_PLURAL[a?.kind] ?? ['session or file', 'sessions and files'];
            const [unit, units] = a?.kind === 'handoff' ? ['section', 'sections'] : ['turn', 'turns'];
            return `Searched past work for ${quoted(q, 50)}: ${count(view.total)}${view.totalMore ? '+' : ''} ${view.total === 1 && !view.totalMore ? unit : units} in ${plural(view.sessions ?? 0, one, many)}`;
        }

        const noop = () => {};

        /** A call's one-line head, as DSH draws its tool rows. */
        function ToolHead({ title, running = false, open = false, expandable = false, onToggle = noop, children }) {
            const glyph = h('span', { className: `${P}-mark-glyph` }, h(RecallGlyph, { size: 14 }));
            if (ui.DisclosureRow) return h(ui.DisclosureRow, { icon: glyph, title, open, expandable, onToggle, running, expandOnRowClick: expandable, previewChevron: expandable }, children);
            return h('div', null,
                h('div', { 'aria-busy': running ? true : undefined, onClick: expandable ? onToggle : undefined, style: expandable ? { cursor: 'pointer' } : undefined }, glyph, h('span', null, title)),
                open ? children : null);
        }

        /** The results a search gave the agent, each a press from its turn. */
        function ToolResults({ view, args, home }) {
            const results = Array.isArray(view.results) ? view.results.filter((r) => kit.isRecord(r) && typeof r.file === 'number') : [];
            const openSearch = () => {
                const since = ['day', 'week', 'month', 'year'].includes(args.since) ? args.since : 'any';
                finder.set({ text: view.query || args.query || '', kind: ['session', 'transcript', 'handoff'].includes(args.kind) ? args.kind : 'any', folder: args.folder || '', model: args.model || '', when: since });
                views.openPage();
            };
            return h('div', { className: `${P}-tool-body` },
                results.length === 0 ? h('div', { className: `${P}-tool-foot` }, 'Nothing matched. The agent may try other words.') : h('ul', { className: `${P}-tool-list` }, ...results.map((r) => h('li', { key: r.id ?? `${r.file}.${r.turn}`, className: `${P}-tool-item`, 'data-recall-tool-result': r.kind },
                    h('div', { className: `${P}-tool-main` },
                        h('div', { className: `${P}-tool-title` }, titleOf(r)),
                        h('div', { className: `${P}-tool-meta` }, [...metaParts(r, home), kit.timeText(r.time)].filter(Boolean).join(' · ')),
                        r.snippet ? h('p', { className: `${P}-tool-snippet` }, ...snippetParts(r.snippet)) : null),
                    h(ui.Button, { variant: 'ghost', size: 'sm', 'aria-label': openName(r, r.turn, 'in Recall'), onClick: () => openResult(r, { query: view.query, page: true }), 'data-recall-tool-open': `${r.file}.${r.turn}` }, ownSession(r) ? 'Open' : 'Read')))),
                h('div', { className: `${P}-tool-foot` },
                    h('button', { type: 'button', className: `${P}-link`, onClick: openSearch, 'data-recall-tool-page': '' }, 'Search this in Recall')));
        }

        /** One turn the agent read in full. */
        function ToolTurn({ view, home }) {
            const t = kit.isRecord(view.turn) ? view.turn : {};
            return h('div', { className: `${P}-tool-body` },
                h('div', { className: `${P}-tool-meta` }, [...metaParts(t, home), kit.timeText(t.time)].filter(Boolean).join(' · ')),
                t.prompt ? h('p', { className: `${P}-tool-snippet` }, `Asked: ${cut(t.prompt, 300)}`) : null,
                t.reply ? h('p', { className: `${P}-tool-snippet` }, `Reply: ${cut(t.reply, 500)}`) : null,
                typeof t.file === 'number' ? h('div', { className: `${P}-tool-foot` },
                    h('button', { type: 'button', className: `${P}-link`, onClick: () => openResult(t, { query: '', page: true }), 'data-recall-tool-open': `${t.file}.${t.turn}` }, ownSession(t) ? 'Open the session at this turn' : 'Read it in Recall')) : null);
        }

        function PreparingToolView(props) {
            const raw = typeof props.useToolCallArgumentsPartial === 'function' ? props.useToolCallArgumentsPartial() : '';
            return h('div', { className: `${P}-pane`, 'data-recall-tool': 'preparing' }, h(ToolHead, { title: runningTitle(callArgs(props.block, raw)), running: true }));
        }

        function SettledToolView(props) {
            const { block, phase } = props;
            const disclosure = typeof props.useDisclosure === 'function' ? props.useDisclosure() : { expanded: false, toggle: noop };
            const home = useHome(typeof props.home === 'string' ? props.home : undefined);
            const a = callArgs(block);
            if (phase !== 'result') return h('div', { className: `${P}-pane`, 'data-recall-tool': 'running' }, h(ToolHead, { title: runningTitle(a), running: true }));
            if (block?.isError) {
                const stopped = block.error?.code === 'interrupted';
                const why = stopped ? 'stopped before it finished.' : failureText(block.error?.reason || resultText(block));
                return h('div', { className: `${P}-pane`, 'data-recall-tool': 'failed' },
                    h(ToolHead, { title: `${a.open ? 'Didn\'t read the past turn' : 'Didn\'t search past work'}: ${why}` }));
            }
            const view = kit.isRecord(block?.meta) && (block.meta.kind === 'results' || block.meta.kind === 'turn') ? block.meta : null;
            if (!view) return h('div', { className: `${P}-pane`, 'data-recall-tool': 'done' }, h(ToolHead, { title: a.open ? 'Read a past turn' : a.query ? `Searched past work for ${quoted(a.query, 50)}` : 'Searched past work' }));
            return h('div', { className: `${P}-pane`, 'data-recall-tool': view.kind },
                h(ToolHead, { title: doneTitle(view, a), open: disclosure.expanded, expandable: true, onToggle: disclosure.toggle },
                    view.kind === 'turn' ? h(ToolTurn, { view, home }) : h(ToolResults, { view, args: a, home })));
        }

        /** The view DSH draws for a search call in a chat: a running line, then what it found, folded under its head. */
        function RecallToolView(props) {
            return props.phase === 'preparing' ? h(PreparingToolView, props) : h(SettledToolView, props);
        }

        // ── Settings on its page in Plugins ───────────────────────────

        /** A folder list's field: shown with commas between the folders, saved as a list. */
        function folderSpec(f) {
            return {
                field: f.name,
                // A saved value that is not a list (one folder without the brackets, typed into the profile) shows as the
                // profile has it, in quotes, so the form flags it with what fits rather than show it as if it were right.
                format: (v) => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : JSON.stringify(v)),
                parse: (t) => {
                    const text = String(t ?? '').trim();
                    if (text === '') return { kind: 'clear' };
                    const list = folderList(text);
                    return list ? { kind: 'set', value: list } : undefined;
                },
            };
        }
        const specOf = (f) => (f.kind === 'folders' ? folderSpec(f) : kit.fieldSpec(f));

        /**
         * Recall's settings on its page in Plugins: DSH's own settings form
         * (staged as typed, written on Save), as the kit draws it, with
         * folder lists added. Does nothing on a DSH without settings forms.
         */
        function applySettings(ctx) {
            if (typeof ui.SettingsFormModel !== 'function' || typeof ui.SettingsForm !== 'function' || typeof ctx.configForms?.get !== 'function') return;
            const scope = ctx.configForms.get('recall');
            const model = new ui.SettingsFormModel(scope, SETTINGS.map(specOf), []);
            const projection = () => ({ ...model.shell(), ...Object.fromEntries(SETTINGS.map((f) => [f.name, model.field(f.name)])) });
            const store = model.bind(projection);
            const form = { subscribe: (fn) => store.subscribe(fn), getSnapshot: () => store.getSnapshot(), actions: model.actions(), keepers: new Map() };
            const View = (props) => (props?.view === 'summary' ? SETTINGS_SUMMARY : h(kit.SettingsBody, { form, name: 'Recall', fields: SETTINGS, note: SETTINGS_NOTE }));
            ctx.effect(() => () => model.dispose(), 'recall: settings form');
            ctx.effect(() => ctx.configForms.whileServed(['recall'], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE }, View))), 'recall: settings page');
        }

        const inject = ['slots'];

        function apply(ctx) {
            try {
                kit.injectStyle(CSS);
            } catch (error) {
                console?.warn?.('dsh-plugin-recall: style:', error);
            }
            ctx.effect?.(() => () => {
                endJump();
                kit.removeStyle();
            }, 'recall: style');
            ctx.inject(['connection'], (scope) => scope.effect(() => {
                kit.setConnection(scope.connection);
                const detach = kit.hub.attach();
                return () => {
                    detach();
                    kit.setConnection(undefined);
                };
            }, 'recall: connection'));
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PAGE }, RecallPage));
            // After Plugins (0), Decisions (2), Autopilot (3), Agent Terminals (4), Proof (5), Categories (6), Calendar (7) and Canon (8).
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PAGE, order: 9, label: TEXT.entry }, RecallIcon));
            // After the coordinator's thread cards (30), Proof's flag (40) and Canon's notes (45).
            ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: `${BUNDLE}:mark`, order: 50, label: 'Recall' }, RecallMark));
            ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: TOOL, locale: 'conversation' }, RecallToolView));
            // Opening sessions and Recall's own page, once DSH's workspace is there.
            ctx.inject(['uiWorkspace'], (scope) => {
                views.openSession = (sessionId) => {
                    if (typeof sessionId !== 'string' || sessionId === '') return false;
                    try {
                        scope.uiWorkspace.openSession(sessionId);
                        return true;
                    } catch (error) {
                        console?.warn?.('dsh-plugin-recall: could not open the session', error);
                        return false;
                    }
                };
                views.openPage = () => {
                    let layout;
                    try { layout = scope.get?.('layout'); } catch { layout = undefined; }
                    try { layout?.selectPanel?.(PAGE); } catch (error) { console?.warn?.('dsh-plugin-recall: could not open Recall\'s page', error); }
                };
                return () => {
                    views.openSession = () => false;
                    views.openPage = () => {};
                };
            });
            // DSH's sessions, for the turn jump's loader.
            ctx.inject(['sessions'], (scope) => {
                views.sessions = scope.sessions;
                return () => { if (views.sessions === scope.sessions) views.sessions = undefined; };
            });
            // DSH's Plugins page: the buttons that open Recall's switch and settings.
            ctx.inject(['pluginNavigation'], (scope) => {
                kit.setNavigation(scope.pluginNavigation);
                return () => kit.setNavigation(undefined);
            });
            ctx.inject(['configForms', 'remote', 'remote.session'], (scope) => {
                try {
                    applySettings(scope);
                } catch (error) {
                    console?.warn?.('dsh-plugin-recall: settings:', error);
                }
            });
        }

        module.exports.inject = inject;
        module.exports.apply = apply;
        // For the plugin's own tests.
        module.exports.internals = {
            kit, TEXT, CSS, SETTINGS, SETTINGS_SUMMARY, SETTINGS_NOTE, KIND_WORD, TONE, finder, jump, views,
            folderList, folderSpec, specOf, homeless, cutPath, folderLabel, titleOf, metaParts, snippetParts, askedLine, countLine, endLine, stateSentence, indexLine, rootWords, callArgs, failureText, runningTitle, doneTitle,
            openAt, openResult, endJump, land, landWithoutMark, applySettings,
            RecallPage, RecallMark, RecallIcon, RecallToolView, SettledToolView, PreparingToolView, SearchCard, ResultRow, ReadingView, IndexCard, HistoryCard, HeaderCard, ThreadState, Filters, FilterMenu, NoResults,
        };
        return module.exports;
    },
});
