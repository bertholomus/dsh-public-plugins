/**
 * dsh-plugin-agent-terminals, browser half: coding agents in DSH's window.
 *
 * - The entry in DSH's panel list (`sidebar.panellist`, order 4), with the
 *   count of agents waiting on you, and its page in `main`: every agent
 *   with what it is doing (working, idle, waiting on you, stopped), its
 *   question and the agent's recommendation when it asks you, its last
 *   reply, the messages you sent and whether its transcript shows each
 *   one, a box to send another, its screen, and Stop, Start again, Start
 *   anew and Forget; a form to start a new agent (programs found on this
 *   computer and ones used before, how it resumes, the folder, a first
 *   message); and what happened, newest first. When Agent Terminals
 *   cannot work it says why and what to do.
 * - Each agent's terminal as a tab beside its session: opened once per
 *   agent when its session is on screen, swapped in place when the agent
 *   starts again in a new terminal, read again when DSH lists the terminal
 *   later than the tab looked (after a restart), and given back its
 *   keyboard after Agent Terminals typed through it.
 * - Session rows: a mark in the row's leading seat (what the agent is
 *   doing, in DSH's own state dots; it gives way to any mark before it),
 *   a line in the row's hover card, and an item in the row's ⋯ menu to
 *   start an agent there or open its terminal.
 * - Its settings on its page in Plugins (DSH's `plugins.bundle.config`),
 *   saved through DSH's own settings form.
 *
 * Hand-written in the module format DSH serves to the browser (no build
 * step). Nothing here may throw at load: DSH joins every plugin's browser
 * half into one script, and one error would stop the others.
 *
 * @module dsh-plugin-agent-terminals/client
 */
// DSH serves browser halves in one script; never throw here, or the others stop loading too.
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-agent-terminals',
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

        const BUNDLE = 'dsh-plugin-agent-terminals';
        const PAGE = `${BUNDLE}:page`;
        const kit = suiteKit({ prefix: 'dshat', bundle: BUNDLE, React, ui, h });
        const P = kit.P;
        const api = kit.link(BUNDLE, { name: 'Agent Terminals' });
        const win = typeof window === 'undefined' ? undefined : window;
        const doc = typeof document === 'undefined' ? undefined : document;

        const TEXT = {
            entry: 'Coding agents',
            title: 'Coding agents',
            summary: 'Command-line coding agents, each in a terminal tab beside its own DSH session. They start again after DSH restarts, your messages are typed in and proven read, and what each one is doing shows here, on its session\'s row and in Decisions.',
            disabled: 'Agent Terminals is switched off in DSH\'s profile (enabled: false in its entry in cordis.patch.yml), so it starts, reads and types nothing. To use it, set enabled to true there and restart DSH. To remove it instead, switch it off in Plugins.',
            noTerminals: 'DSH\'s terminals are not running, so no agent can start or be reached. Restart DSH: agents that were running start again by themselves.',
            agents: 'Agents',
            none: 'No coding agents yet',
            noneText: 'Start one below: name its program and the folder it works in. It gets a session of its own, with its terminal in a tab beside it.',
            start: 'Start a coding agent',
            startSub: 'Any command-line coding agent. It runs in a terminal of its session; for a program that keeps transcripts Agent Terminals can read, it also follows the agent\'s work and proves your messages were read.',
            history: 'What happened',
            historySub: 'Newest first: agents started and stopped, your messages and whether each was read, and questions to you.',
            noHistory: 'Nothing yet',
            noHistoryText: 'Starts, stops, messages and questions show here, each with why.',
            loading: 'Reading the coding agents',
            settings: 'Settings',
            closeEnds: 'Closing an agent\'s terminal tab ends the agent; Start again brings it back.',
        };

        /** An agent's state, in the suite's words (the host's own words, said the same everywhere). */
        const STATUS_WORDS = Object.freeze({
            working: 'working',
            idle: 'idle',
            'waiting on you': 'waiting on you',
            starting: 'starting',
            running: 'running',
            stopped: 'stopped',
        });
        const statusWord = (agent) => STATUS_WORDS[agent?.status] ?? 'stopped';

        /** A message's state, in words. */
        const DELIVERY_WORDS = Object.freeze({
            queued: 'queued',
            waiting: 'waiting',
            typing: 'typing',
            typed: 'typed in',
            delivered: 'delivered',
            'not proven': 'not proven',
            failed: 'failed',
            cancelled: 'taken back',
        });
        const deliveryWord = (item) => DELIVERY_WORDS[item?.state] ?? String(item?.state ?? '');
        const OPEN = new Set(['queued', 'waiting']);

        /** Agent Terminals' settings on its page in Plugins: the same names, titles and ranges as its config (lib/config.js). */
        const SETTINGS = [
            { name: 'resumeAfterRestart', kind: 'switch', title: 'Start agents again after DSH restarts', hint: 'Each agent that was running starts again in a new terminal under the same name, resuming its conversation where its program can.', default: true, group: 'Starting' },
            { name: 'listNewSessions', kind: 'switch', title: 'List a new agent\'s session in the sidebar', hint: 'DSH lists a session once a turn ran in it, so the session\'s model answers one short line when the agent starts.', default: true },
            { name: 'openTabs', kind: 'switch', title: 'Open an agent\'s terminal tab with its session', hint: 'When you open its session, the agent\'s terminal opens in a tab beside it, once per agent.', default: true },
            { name: 'typeWhileWorking', kind: 'switch', title: 'Type messages in while the agent works', hint: 'Off: a message waits until the agent is idle. Never while it runs a tool, so nothing lands in an approval prompt.', default: false, group: 'Typing messages in' },
            { name: 'proofSeconds', kind: 'number', title: 'Seconds without proof before Enter is pressed again', hint: 'How long an idle agent has to show the message in its transcript before Enter goes again.', default: 8, min: 2, max: 120 },
            { name: 'enterRetries', kind: 'number', title: 'Press Enter again, at most', hint: 'For programs that swallow the Enter after a paste.', default: 2, min: 0, max: 5 },
            { name: 'askAfterSeconds', kind: 'number', title: 'Seconds before a waiting tool call counts as asking you', hint: 'A tool call that waits this long for its result most likely waits for your approval in its terminal.', default: 20, min: 5, max: 600, group: 'Telling you' },
            { name: 'notify', kind: 'switch', title: 'A notification when an agent waits on you', hint: 'Through DSH\'s notifications, while they run. The question also shows in Decisions.', default: true },
        ];
        const SETTINGS_SUMMARY = 'Starting agents again, opening their terminals, typing messages in, and telling you when one waits on you.';
        const SETTINGS_NOTE = 'Changes apply as soon as you save. How messages are typed in (typing) and switching Agent Terminals off (enabled) are set in its entry in DSH\'s profile.';

        const CSS = [
            `.${P}-status{margin:10px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-lines{margin:8px 0 0;display:flex;flex-direction:column;gap:4px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-agent{box-sizing:border-box;min-width:0;margin-top:10px;padding:12px 14px;border-radius:var(--dsw-radius-md,10px);background:var(--${P}-fill);border:1px solid var(--dsw-alias-border-l1)}`,
            `.${P}-agent:first-child{margin-top:8px}`,
            `.${P}-agent-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}`,
            `.${P}-agent-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}`,
            `.${P}-h3{margin:0;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}`,
            `.${P}-h3[tabindex]:focus{outline:none}`,
            `.${P}-h3[tabindex]:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px;border-radius:var(--dsw-radius-xs)}`,
            `.${P}-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}`,
            `.${P}-detail{margin:6px 0 0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}`,
            `.${P}-ask{margin:10px 0 0;padding:10px 12px;border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);border:1px solid var(--dsw-alias-border-l2)}`,
            `.${P}-ask-q{margin:0;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}`,
            `.${P}-rec{margin:6px 0 0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}`,
            `.${P}-rec-label{color:var(--${P}-text-2)}`,
            `.${P}-reply{max-height:9.5em;overflow:auto}`,
            `.${P}-answer{margin-top:10px;display:flex;flex-direction:column;gap:8px;min-width:0}`,
            `.${P}-label{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}`,
            `.${P}-textarea,.${P}-input{box-sizing:border-box;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}`,
            `.${P}-textarea{resize:vertical;min-height:4.5em}`,
            `.${P}-textarea::placeholder,.${P}-input::placeholder{color:var(--${P}-text-2)}`,
            `.${P}-hint{font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-details{margin-top:8px}`,
            `.${P}-details>summary{cursor:pointer;font:var(--dsw-font-xs-13);color:var(--${P}-link);width:max-content;max-width:100%;border-radius:var(--dsw-radius-xs)}`,
            `.${P}-details>summary:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px}`,
            `.${P}-msgs{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}`,
            `.${P}-msg{display:flex;align-items:flex-start;gap:8px;min-width:0}`,
            `.${P}-msg-main{min-width:0;flex:1 1 auto}`,
            `.${P}-msg-text{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}`,
            `.${P}-screen{margin:6px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);font:12px/1.45 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary);white-space:pre;overflow:auto;max-height:22em}`,
            `.${P}-form{display:flex;flex-direction:column;gap:14px;margin-top:10px;min-width:0}`,
            `.${P}-field{display:flex;flex-direction:column;gap:6px;min-width:0}`,
            `.${P}-row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}`,
            `@media (max-width:640px){.${P}-row2{grid-template-columns:minmax(0,1fr)}}`,
            `.${P}-group{margin:0;padding:0;border:0;min-width:0;display:flex;flex-direction:column;gap:6px}`,
            `.${P}-legend{padding:0;margin:0 0 2px;font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}`,
            `.${P}-option{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary)}`,
            `.${P}-option input{margin:3px 0 0;accent-color:var(--dsw-alias-state-business-primary)}`,
            `.${P}-option-hint{display:block;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-chips{display:flex;flex-wrap:wrap;gap:6px}`,
            `.${P}-chip{display:inline-flex;flex-direction:column;align-items:flex-start;gap:1px;max-width:100%;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-strong-13);text-align:left;cursor:pointer;overflow-wrap:anywhere}`,
            `.${P}-chip:hover{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}`,
            `.${P}-chip-sub{font:var(--dsw-font-xxs-12);color:var(--${P}-text-2)}`,
            `.${P}-log-time{flex:0 0 auto;min-width:64px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-alert[tabindex]:focus{outline:none}`,
            `.${P}-alert[tabindex]:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px}`,
            `.${P}-said[tabindex]:focus{outline:none}`,
            `@media (max-width:560px){.${P}-item{flex-wrap:wrap}.${P}-item-side{justify-content:flex-start;width:100%}}`,
            // A session row's leading seat: DSH's, 16px, one mark. Its entries draw side by side in one outlet, in
            // order; this mark gives way to any mark drawn before it there (DSH's automation mark, say), staying in
            // words for screen readers, and never widens the seat.
            `.${P}-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:20px;color:var(--dsw-alias-label-tertiary)}`,
            `[data-row-key^="session:"]>* .${P}-mark:not(:first-child){position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}`,
            // DSH's hover card is dark in both themes, with light words: the agent's lines match DSH's own there.
            `.${P}-hover{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:16px;color:#cfd3d6;overflow-wrap:anywhere}`,
            `.${P}-hover-head{display:flex;align-items:center;gap:6px;color:#fff}`,
            `.${P}-hover-line{color:#adb2b8}`,
        ];

        // ── Shared state in the window ────────────────────────────────

        /** A value parts of the window share, with subscribers (one per window, outside React). */
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

        const NO_MARKS = Object.freeze({ off: true, openTabs: false, agents: Object.freeze([]), code: undefined });
        /** What the host says about every agent, read once per window for the rows, the tabs and the panel count. */
        const marks = makeStore(NO_MARKS);
        /** A session to start an agent in, from a row's ⋯ menu: `{ sessionId, title }`. */
        const preset = makeStore(undefined);
        /** An agent to bring into view on the page: `{ key, n }`. */
        const spotlight = makeStore(undefined);
        /** An agent's terminal tab to show once its session is on screen: `{ sessionId, terminalId, at }`. */
        const reveal = makeStore(undefined);

        const agentOfSession = (sessionId) => marks.get().agents.find((agent) => agent.sessionId === sessionId);

        /** Read the agents' marks whenever the agents or the sessions move (the suite's one open request per window). */
        function followMarks() {
            let alive = true;
            let timer;
            let reading = false;
            let again = false;
            const read = async () => {
                if (reading) {
                    again = true;
                    return;
                }
                reading = true;
                try {
                    const result = await api.call('marks');
                    if (!alive) return;
                    if (result.ok && kit.isRecord(result.value)) {
                        const value = result.value;
                        marks.set({ off: value.off === true, openTabs: value.openTabs !== false, agents: Array.isArray(value.agents) ? value.agents.filter(kit.isRecord) : [], code: undefined });
                    } else {
                        marks.set({ ...NO_MARKS, code: result.error?.code });
                    }
                } catch {
                    if (alive) marks.set({ ...NO_MARKS, code: 'unreachable' });
                } finally {
                    reading = false;
                    if (again && alive) {
                        again = false;
                        void read();
                    }
                }
            };
            const off = kit.hub.subscribe(['agent-terminals', 'sessions', 'settings'], () => {
                clearTimeout(timer);
                timer = setTimeout(() => { void read(); }, 300);
            });
            void read();
            return () => {
                alive = false;
                clearTimeout(timer);
                off();
                marks.set(NO_MARKS);
            };
        }

        // ── Agents' terminal tabs ─────────────────────────────────────

        const OPENED_KEY = `${BUNDLE}/opened/v1`;
        /** DSH's own record of which terminal a restored tab shows (read only: a tab keeps no parameters across a reload). */
        const BINDING_PREFIX = 'dsh.terminal.binding.v1.';

        function readOpened() {
            try {
                const list = JSON.parse(win?.localStorage?.getItem(OPENED_KEY) ?? '[]');
                return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(-200) : []);
            } catch {
                return new Set();
            }
        }
        function saveOpened(opened) {
            try { win?.localStorage?.setItem(OPENED_KEY, JSON.stringify([...opened].slice(-200))); } catch { /* storage may be off */ }
        }

        /** The terminal a tab shows: its parameters, else DSH's saved binding for it. */
        function boundTerminal(sidebar, sessionId, tab) {
            try {
                const params = sidebar.tabDomain?.occurrence?.(sessionId, { id: tab.id })?.navigation?.getSnapshot?.()?.params;
                if (kit.isRecord(params) && typeof params.terminalId === 'string') return params.terminalId;
            } catch { /* a tab with no committed occurrence yet */ }
            try {
                const value = JSON.parse(win?.localStorage?.getItem(BINDING_PREFIX + JSON.stringify([sessionId, tab.contentId])) ?? 'null');
                return typeof value === 'string' ? value : undefined;
            } catch {
                return undefined;
            }
        }

        /** Whether a terminal id is an earlier terminal of the same agent (it got a new one when started again). */
        function earlierTerminal(agent, id) {
            const now = /^agent-([\w]+)-(\d+)$/.exec(String(agent.terminalId ?? ''));
            const then = /^agent-([\w]+)-(\d+)$/.exec(String(id ?? ''));
            return Boolean(now && then && now[1] === then[1] && Number(then[2]) < Number(now[2]));
        }

        /**
         * Keep each agent's terminal in a tab beside its session, in this window:
         * open it once when the session is on screen (or when asked), in place of
         * the tab of its earlier terminal; read a tab again when DSH lists its
         * terminal after the tab looked; and give the tab its keyboard back after
         * Agent Terminals typed through it.
         */
        function followTabs(sidebar, terminals) {
            const opened = readOpened();
            const refreshed = new Map();
            const taken = new Map();
            let timer;
            const terminalTabs = (sessionId) => {
                try {
                    return (sidebar.tabsIn?.(sessionId) ?? []).filter((tab) => kit.isRecord(tab) && tab.kind === 'terminal');
                } catch {
                    return [];
                }
            };
            const remember = (id) => {
                if (opened.has(id)) return;
                opened.add(id);
                saveOpened(opened);
            };
            function look() {
                const now = Date.now();
                const want = reveal.get();
                if (want && now - want.at > 10000) reveal.set(undefined);
                const m = marks.get();
                if (m.off) return;
                let sessionId;
                try { sessionId = sidebar.mounted?.getSnapshot?.(); } catch { sessionId = undefined; }
                if (typeof sessionId !== 'string') return;
                const agent = agentOfSession(sessionId);
                if (!agent) return;
                const asked = want?.sessionId === sessionId && want.terminalId === agent.terminalId;
                const tabs = terminalTabs(sessionId).map((tab) => ({ tab, id: boundTerminal(sidebar, sessionId, tab) }));
                const mine = tabs.find((item) => item.id === agent.terminalId)?.tab;
                if (mine) {
                    remember(agent.terminalId);
                    let view;
                    try { view = terminals?.view?.(sessionId, mine.id, mine.contentId, agent.terminalId); } catch { view = undefined; }
                    let state;
                    try { state = view?.state?.getSnapshot?.(); } catch { state = undefined; }
                    // The tab looked before DSH listed the terminal (after a restart, say): look again.
                    if (agent.running && state?.issue === 'missingTerminal' && now - (refreshed.get(mine.id) ?? 0) > 2500) {
                        refreshed.set(mine.id, now);
                        try { void view.refresh?.(); } catch { /* the next look tries again */ }
                    }
                    // Agent Terminals typed through the window's way in: the tab takes its keyboard back.
                    const at = Number(agent.controlTakenAt) || 0;
                    if (at && taken.get(agent.key) !== at && state?.info && state.writable === false) {
                        taken.set(agent.key, at);
                        try { view.connect?.(); } catch { /* the tab's own Take control still works */ }
                    }
                    if (asked) {
                        reveal.set(undefined);
                        try {
                            sidebar.focus?.(mine.id);
                            if (sidebar.isExpanded?.() === false) sidebar.toggleExpanded?.();
                        } catch { /* the tab stays where it is */ }
                    }
                    return;
                }
                if (!agent.running || (!asked && (!m.openTabs || opened.has(agent.terminalId)))) return;
                const earlier = tabs.find((item) => earlierTerminal(agent, item.id))?.tab;
                try {
                    sidebar.openTab('terminal', { params: { terminalId: agent.terminalId }, ...(earlier ? { replaceTab: earlier.id } : {}) });
                    remember(agent.terminalId);
                    if (asked) reveal.set(undefined);
                } catch { /* the session's surface is not ready yet: the next look tries again */ }
            }
            const soon = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    try { look(); } catch (error) { console?.warn?.('dsh-plugin-agent-terminals: terminal tabs:', error); }
                }, 60);
            };
            const offs = [marks.subscribe(soon), reveal.subscribe(soon)];
            try { offs.push(sidebar.mounted?.subscribe?.(soon)); } catch { /* an older DSH */ }
            try { offs.push(sidebar.openTabs?.subscribe?.(soon)); } catch { /* an older DSH */ }
            // A terminal DSH lists later than its tab looked, or a session whose surface was not ready: looked at again.
            const every = setInterval(() => {
                if (doc?.visibilityState !== 'hidden' && marks.get().agents.length) soon();
            }, 2000);
            soon();
            return () => {
                clearTimeout(timer);
                clearInterval(every);
                for (const off of offs) if (typeof off === 'function') off();
            };
        }

        // ── Words ─────────────────────────────────────────────────────

        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

        /** The header's line: how many agents run, how many of those wait on you, and how many are stopped. */
        function countText(agents) {
            if (!agents.length) return '';
            const waiting = agents.filter((a) => a.status === 'waiting on you').length;
            const running = agents.filter((a) => a.status !== 'stopped').length;
            const stopped = agents.length - running;
            const of = waiting === 0 ? ''
                : waiting === running ? (running === 1 ? ', waiting on you' : running === 2 ? ', both waiting on you' : `, all ${running} waiting on you`)
                    : `, ${waiting} of them waiting on you`;
            return [running ? `${running} running${of}` : '', stopped ? `${stopped} stopped` : ''].filter(Boolean).join(' · ');
        }

        /** The program as typed, with its arguments. */
        const commandText = (agent) => [agent.program, ...(agent.args ?? [])].join(' ');
        /** The program by its name (not its whole path), with its arguments: the card's short line. */
        const shortCommand = (agent) => [agent.programName || String(agent.program ?? '').split('/').pop() || agent.program, ...(agent.args ?? [])].join(' ');

        /** The last part of a folder, for a short line. */
        const folderName = (folder) => String(folder ?? '').replace(/\/+$/, '').split('/').pop() || String(folder ?? '');

        /** How a stopped agent comes back, in words. */
        const againText = (agent) => (agent.canResume ? 'Start again resumes its conversation.' : 'Start again runs it anew: this program cannot resume a conversation.');

        /**
         * The line under the list, kept true: a message you sent says where
         * it is now (typed in, delivered, not proven), and the line goes two
         * minutes after the last thing you did. `warn` when the news is bad.
         */
        function saidLine(said, data, now) {
            if (!said?.text) return { text: '' };
            if (Number.isFinite(said.at) && (now ?? Date.now()) - said.at > 120000) return { text: '' };
            if (!said.delivery) return { text: said.text };
            const agent = (data?.agents ?? []).find((a) => a.key === said.key);
            const item = agent?.deliveries?.find((d) => d.id === said.delivery);
            if (!agent || !item) return { text: said.text };
            const name = `“${agent.name}”`;
            switch (item.state) {
                case 'typing': return { text: `Typing your message into ${name}'s terminal.` };
                case 'typed': return { text: agent.keepsTranscript === false ? `Your message was typed into ${name}'s terminal.` : `Typed into ${name}'s terminal; waiting for its transcript to show it.` };
                case 'delivered': return { text: `${name} has your message: its transcript shows it.` };
                case 'not proven': return { text: `Typed into ${name}'s terminal, but its transcript has not shown it: look at its terminal.`, warn: true };
                case 'failed': return { text: `Your message was not typed in: ${String(item.why ?? 'see its card').replace(/^Not typed in: /, '').replace(/\.$/, '')}.`, warn: true };
                case 'cancelled': return { text: 'Taken back before it was typed in.' };
                case 'waiting': return { text: item.why ? `Queued for ${name}: ${String(item.why).replace(/\.$/, '')}.` : said.text };
                default: return { text: said.text };
            }
        }

        /** What an action did, in a line (shown where the person is looking, and read out). */
        function saidText(method, agent, value) {
            const name = agent?.name ? `“${agent.name}”` : 'The agent';
            switch (method) {
                case 'send':
                    if (value?.delivery?.state === 'waiting' && value.delivery.why) return `Queued for ${name}: ${String(value.delivery.why).replace(/\.$/, '')}.`;
                    return agent?.keepsTranscript === false ? `Queued for ${name}. It is typed in when the agent is ready.` : `Queued for ${name}. It is typed in when the agent is ready, and marked delivered once its transcript shows it.`;
                case 'cancel': return 'Taken back before it was typed in.';
                case 'stop': return `Stopped ${name}. ${againText(value?.agent ?? agent ?? {})}`;
                case 'startAgain': return value?.problem ? '' : `Started ${name} again.`;
                case 'forget': return `Forgot ${name}. Its session stays in DSH.`;
                default: return '';
            }
        }

        // ── Data ──────────────────────────────────────────────────────

        const readState = () => api.read('state');

        /** Do something on the host: `{ value }`, or `{ problem }` in words. */
        async function run(method, args) {
            const result = await api.call(method, args);
            return result.ok ? { value: result.value } : { problem: result.error?.message || 'Agent Terminals did not answer.' };
        }

        const domId = (text) => String(text).replace(/[^A-Za-z0-9_-]/g, '_');

        // ── Parts ─────────────────────────────────────────────────────

        /** A small terminal glyph: a window with a prompt, or with a stop square when its agent is stopped. */
        function TerminalGlyph({ size = 14, stopped = false }) {
            return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
                h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }),
                ...(stopped
                    ? [h('rect', { key: 'stop', x: 9.5, y: 9.5, width: 5, height: 5, rx: 0.8, fill: 'currentColor', stroke: 'none' })]
                    : [h('path', { key: 'prompt', d: 'm7.5 10 2.5 2-2.5 2' }), h('path', { key: 'cursor', d: 'M12.5 14.5h4' })]));
        }

        /** The prompt DSH's own terminal tabs show (a chevron and a cursor), for menu items about an agent's terminal. */
        function PromptGlyph({ size = 16 }) {
            return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
                h('path', { d: 'M3 4L7 8L3 12' }),
                h('path', { d: 'M9 12H13' }));
        }

        /** DSH's state dot for an agent's state, where it has one. */
        function dotOf(agent) {
            if (agent.status === 'waiting on you') return 'warning';
            if (agent.status === 'working' || agent.status === 'starting' || agent.status === 'running') return 'ongoing';
            return undefined;
        }

        function SessionLink({ title, sessionId, onOpen }) {
            if (!sessionId) return h('span', { className: `${P}-h3` }, title);
            return h('button', { type: 'button', className: `${P}-link ${P}-h3`, onClick: () => onOpen(sessionId), title: 'Open its session' }, title || 'Untitled session');
        }

        function HeaderCard({ data, onStart }) {
            const status = !data.enabled ? TEXT.disabled : countText(data.agents);
            const canOpen = kit.canOpenPlugin();
            return h(kit.Card, {
                title: TEXT.title,
                headingLevel: 1,
                main: true,
                sub: TEXT.summary,
                actions: data.enabled || canOpen ? [
                    data.enabled ? h(ui.Button, { key: 's', variant: 'primary', size: 'sm', onClick: onStart }, TEXT.start) : null,
                    canOpen ? h(ui.Button, { key: 'o', variant: 'outline', size: 'sm', onClick: () => kit.openPlugin(BUNDLE) }, TEXT.settings) : null,
                ] : undefined,
                attrs: { 'data-agent-terminals-header': data.enabled ? 'on' : 'off' },
            },
            status ? h('p', { className: `${P}-status`, 'data-agent-terminals-count': '' }, status) : null,
            data.enabled && !data.terminals ? h('p', { className: `${P}-alert`, role: 'alert', 'data-agent-terminals-no-terminals': '' }, TEXT.noTerminals) : null,
            data.watchProblem ? h('p', { className: `${P}-note`, 'data-agent-terminals-watch-problem': '' }, `Session Watch uses its default for a wrong setting: ${String(data.watchProblem.text).replace(/\.$/, '')}. Change it in Session Watch's settings in Plugins.`) : null);
        }

        /** The question an agent asks you, with the recommendation and a way to answer from here. */
        function AskBlock({ agent, busy, send, openTerminal }) {
            if (agent.status !== 'waiting on you') return null;
            if (agent.ask) {
                return h('div', { className: `${P}-ask`, 'data-agent-terminals-ask': 'reply' },
                    h('p', { className: `${P}-ask-q` }, agent.ask.question),
                    agent.ask.recommendation ? h('p', { className: `${P}-rec`, 'data-agent-terminals-recommendation': '' }, h('span', { className: `${P}-rec-label` }, 'Recommended: '), agent.ask.recommendation) : null,
                    agent.ask.recommendation ? h('div', { className: `${P}-actions`, style: { marginTop: '8px' } },
                        h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void send(`Go with your recommendation: ${agent.ask.recommendation}`) }, 'Go with the recommendation'),
                        h('span', { className: `${P}-hint` }, 'Or write your own answer below. It is typed into its terminal.')) : null);
            }
            if (agent.call) {
                const what = agent.call.summary ? `It asks to run “${agent.call.summary}”.` : `It waits on ${agent.call.tool || 'a tool'}.`;
                return h('div', { className: `${P}-ask`, 'data-agent-terminals-ask': 'call' },
                    h('p', { className: `${P}-ask-q` }, what),
                    h('p', { className: `${P}-why` }, agent.call.approval ? 'It asks for your approval in its terminal: answer there.' : 'Its terminal most likely asks you something: answer there.'),
                    h('div', { className: `${P}-actions`, style: { marginTop: '8px' } },
                        h(ui.Button, { variant: 'primary', size: 'sm', onClick: () => openTerminal(agent) }, 'Open its terminal')));
            }
            return null;
        }

        function MessageRow({ item, busy, onCancel }) {
            const word = deliveryWord(item);
            return h('li', { className: `${P}-msg`, 'data-agent-terminals-message': item.state },
                h('div', { className: `${P}-msg-main` },
                    h('div', { className: `${P}-msg-text` }, item.text),
                    h('div', { className: `${P}-meta` },
                        h(kit.TimeText, { at: item.at }),
                        item.by && item.by !== 'you' ? ` · from ${item.by}` : '',
                        item.enters > 1 ? ` · Enter pressed ${item.enters} times` : ''),
                    item.why && item.state !== 'delivered' ? h('div', { className: `${P}-why` }, item.why) : null),
                h('div', { className: `${P}-item-side` },
                    h(kit.StateTag, { word }),
                    OPEN.has(item.state) ? h(ui.Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void onCancel(item) }, 'Take back') : null));
        }

        function SendBox({ agent, busy, send }) {
            const [text, setText] = React.useState('');
            const id = `${P}-send-${domId(agent.key)}`;
            const asks = agent.status === 'waiting on you' && agent.ask;
            const go = () => {
                if (!text.trim()) return;
                void send(text).then((ok) => { if (ok) setText(''); });
            };
            const hint = !agent.keepsTranscript
                ? 'Typed into its terminal. This program keeps no transcript Agent Terminals can read, so a message counts as typed in, not proven read.'
                : agent.status === 'stopped'
                    ? 'It waits until the agent runs again, then it is typed in.'
                    : 'Typed in when the agent is ready for it (never while it runs a tool), then proven from its transcript.';
            return h('div', { className: `${P}-answer` },
                h('label', { className: `${P}-label`, htmlFor: id }, asks ? 'Your answer' : 'Message'),
                h('textarea', {
                    id,
                    className: `${P}-textarea`,
                    rows: 2,
                    value: text,
                    readOnly: busy,
                    // Each box says whose it is: a screen reader hears more than one on the page.
                    'aria-label': asks ? `Your answer to ${agent.name}` : `Message to ${agent.name}`,
                    placeholder: asks ? 'Write your answer' : `Write to ${agent.name}`,
                    onChange: (event) => setText(event.target.value),
                    onKeyDown: (event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault();
                            go();
                        }
                    },
                }),
                h('div', { className: `${P}-actions` },
                    h(ui.Button, { variant: asks ? 'outline' : 'primary', size: 'sm', disabled: busy || !text.trim(), onClick: go }, 'Send'),
                    h('span', { className: `${P}-hint` }, hint)));
        }

        /** What the agent's terminal shows now, read when asked. */
        function ScreenPeek({ agent }) {
            const [open, setOpen] = React.useState(false);
            const [screen, setScreen] = React.useState(undefined);
            const [reading, setReading] = React.useState(false);
            const pre = React.useRef(null);
            // Its prompt and its latest lines are at the bottom: shown first, as in its terminal.
            React.useEffect(() => {
                const box = pre.current;
                if (box) box.scrollTop = box.scrollHeight;
            }, [screen]);
            const read = React.useCallback(async () => {
                setReading(true);
                const { problem, value } = await run('screen', { key: agent.key });
                setReading(false);
                setScreen(problem ? { problem } : { lines: Array.isArray(value?.lines) ? value.lines : null, at: Date.now() });
            }, [agent.key]);
            React.useEffect(() => { if (open) void read(); }, [open, read]);
            return h('details', { className: `${P}-details`, 'data-agent-terminals-screen': '', onToggle: (event) => setOpen(event.currentTarget.open) },
                h('summary', null, 'Its screen now'),
                !open ? null
                    : screen === undefined ? h(kit.Loading, { text: 'Reading its screen' })
                        : screen.problem ? h('p', { className: `${P}-alert`, role: 'alert' }, `Couldn't read its screen: ${screen.problem}`)
                            : screen.lines === null || screen.lines.length === 0
                                ? h('p', { className: `${P}-why` }, agent.status === 'stopped' ? 'It is not running, so there is no screen to read.' : 'Its screen cannot be read now. Open its terminal to see it.')
                                : h('pre', { ref: pre, className: `${P}-screen`, 'aria-label': `${agent.name}'s screen`, tabIndex: 0 }, screen.lines.join('\n')),
                open ? h('div', { className: `${P}-actions`, style: { marginTop: '6px' } },
                    h(ui.Button, { variant: 'ghost', size: 'sm', disabled: reading, onClick: () => void read() }, 'Read again')) : null);
        }

        /** The agent's last reply: in view, or folded under the question it asks (which comes from it). */
        function LastReply({ agent }) {
            const reply = agent.lastReply;
            const quote = h('p', { className: `${P}-quote ${P}-reply`, tabIndex: 0, 'aria-label': `${agent.name}'s last reply` }, reply.text);
            if (agent.status === 'waiting on you' && agent.ask) {
                return h('details', { className: `${P}-details`, 'data-agent-terminals-reply': 'folded' },
                    h('summary', null, 'Its whole reply'),
                    quote);
            }
            return h('div', { className: `${P}-details`, 'data-agent-terminals-reply': '' },
                h('div', { className: `${P}-label` }, 'Its last reply', reply.at ? [' · ', h(kit.TimeText, { key: 't', at: reply.at })] : null),
                quote);
        }

        /** One agent: what it does, what it asks, its messages, and what you can do with it. */
        function AgentCard({ agent, act, busyKey, onOpen, openTerminal, spot }) {
            const [failure, setFailure] = React.useState(undefined);
            const alertRef = React.useRef(null);
            const headRef = React.useRef(null);
            const [all, setAll] = React.useState(false);
            const [forgetting, setForgetting] = React.useState(false);
            const keepRef = React.useRef(null);
            const forgetRef = React.useRef(null);
            const asked = React.useRef(false);
            const busy = busyKey === agent.key;
            const stopped = agent.status === 'stopped';
            // Agent Terminals waits for a setting: it does not follow its agents, so nothing here acts on them.
            const followed = agent.followed !== false;
            React.useEffect(() => {
                if (forgetting) keepRef.current?.focus?.();
                else if (asked.current) forgetRef.current?.focus?.();
                asked.current = forgetting;
            }, [forgetting]);
            // Its terminal asks (a tool call waits for approval): the question's block holds the way there.
            const asksInTerminal = agent.status === 'waiting on you' && !agent.ask && Boolean(agent.call);
            React.useEffect(() => { if (failure) alertRef.current?.focus?.(); }, [failure]);
            React.useEffect(() => {
                if (spot?.key !== agent.key) return;
                headRef.current?.scrollIntoView?.({ block: 'start' });
                headRef.current?.focus?.({ preventScroll: true });
            }, [spot?.n]);
            const doing = async (method, args) => {
                setFailure(undefined);
                const problem = await act(method, { key: agent.key, ...args }, agent);
                if (problem) setFailure(problem);
                return !problem;
            };
            const send = (text) => doing('send', { text });
            const messages = agent.deliveries ?? [];
            const shown = all ? messages : messages.slice(0, 4);
            const meta = [agent.folder ? `in ${folderName(agent.folder)}` : '', agent.launchedAt && !stopped ? h(kit.TimeText, { key: 't', at: agent.launchedAt }) : null];
            return h('li', { className: `${P}-agent`, 'data-agent-terminals-agent': agent.key, 'data-agent-terminals-status': agent.status },
                h('div', { className: `${P}-agent-top` },
                    h('div', { className: `${P}-head-text` },
                        h('div', { className: `${P}-agent-name` },
                            h(kit.StateTag, { word: statusWord(agent) }),
                            h('h3', { className: `${P}-h3`, ref: headRef, tabIndex: -1 }, h(SessionLink, { title: agent.name, sessionId: agent.sessionId, onOpen }))),
                        h('div', { className: `${P}-meta` },
                            h('span', { className: `${P}-code`, title: commandText(agent) }, shortCommand(agent)),
                            meta[0] ? ` · ${meta[0]}` : '',
                            meta[1] ? [' · started ', meta[1]] : null)),
                    h('div', {
                        className: `${P}-actions`,
                        // Escape takes Forget's question back, as Keep it does.
                        onKeyDown: stopped && forgetting ? (event) => {
                            if (event.key !== 'Escape') return;
                            event.preventDefault();
                            event.stopPropagation();
                            setForgetting(false);
                        } : undefined,
                    },
                        !followed ? (stopped || asksInTerminal ? null : h(ui.Button, { key: 'open', variant: 'outline', size: 'sm', onClick: () => openTerminal(agent) }, 'Open its terminal'))
                            : stopped && forgetting ? [
                                h('span', { key: 'q', className: `${P}-hint`, 'data-agent-terminals-forget': '' }, `Forget “${agent.name}”? Its session and its conversation files stay.`),
                                h(ui.Button, { key: 'yes', variant: 'primary', size: 'sm', disabled: busy, onClick: () => void doing('forget', {}) }, 'Forget it'),
                                h(ui.Button, { key: 'no', variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setForgetting(false), ref: keepRef }, 'Keep it'),
                            ]
                                : stopped ? [
                                    h(ui.Button, { key: 'again', variant: 'primary', size: 'sm', disabled: busy, onClick: () => void doing('startAgain', { fresh: false }) }, 'Start again'),
                                    agent.canResume ? h(ui.Button, { key: 'anew', variant: 'outline', size: 'sm', disabled: busy, onClick: () => void doing('startAgain', { fresh: true }) }, 'Start anew') : null,
                                    h(ui.Button, { key: 'forget', variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setForgetting(true), ref: forgetRef }, 'Forget'),
                                ] : [
                                    asksInTerminal ? null : h(ui.Button, { key: 'open', variant: 'primary', size: 'sm', onClick: () => openTerminal(agent) }, 'Open its terminal'),
                                    h(ui.Button, { key: 'stop', variant: 'outline', size: 'sm', disabled: busy || agent.launching, onClick: () => void doing('stop', {}) }, 'Stop'),
                                ])),
                // An idle agent's detail is its last reply's first line, which the reply below shows whole.
                agent.detail && !(agent.status === 'waiting on you' && (agent.ask || agent.call)) && !(agent.status === 'idle' && agent.lastReply?.text) ? h('p', { className: `${P}-detail`, 'data-agent-terminals-detail': '' }, agent.detail) : null,
                stopped && agent.ended?.text && agent.ended.text !== agent.detail ? h('p', { className: `${P}-detail` }, agent.ended.text) : null,
                h(AskBlock, { agent, busy, send, openTerminal }),
                agent.lastReply?.text ? h(LastReply, { agent }) : null,
                messages.length ? h('div', { className: `${P}-details` },
                    h('div', { className: `${P}-label` }, `Messages (${messages.length})`),
                    h('ul', { className: `${P}-msgs` }, ...shown.map((item) => h(MessageRow, { key: item.id, item, busy, onCancel: (m) => doing('cancel', { id: m.id }) }))),
                    messages.length > shown.length ? h('div', { style: { marginTop: '6px' } }, h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setAll(true) }, `Show all ${messages.length}`)) : null) : null,
                followed ? h(SendBox, { agent, busy, send }) : null,
                failure ? h('p', { className: `${P}-alert`, role: 'alert', tabIndex: -1, ref: alertRef, 'data-agent-terminals-error': '' }, /^Not /.test(failure) ? failure : `Not done: ${failure}`) : null,
                h(ScreenPeek, { agent }));
        }

        function AgentsCard({ data, act, busyKey, said, onOpen, openTerminal, onStart }) {
            const spot = useStore(spotlight);
            const line = React.useRef(null);
            const { text: shown, warn } = saidLine(said, data, Date.now());
            React.useEffect(() => {
                if (!said?.text || typeof document === 'undefined') return;
                const at = document.activeElement;
                // The card you acted on may have moved or gone: the keyboard goes to the line that says what happened.
                if (at && at !== document.body && at.isConnected) return;
                line.current?.focus?.({ preventScroll: true });
            }, [said?.n]);
            return h(kit.Card, { title: TEXT.agents, main: true, sub: data.agents.length ? TEXT.closeEnds : undefined, attrs: { 'data-agent-terminals-agents': String(data.agents.length) } },
                h('p', { ref: line, tabIndex: -1, className: shown ? `${P}-note ${warn ? `${P}-warn` : `${P}-ok`} ${P}-said` : `${P}-sr`, role: 'status', 'aria-live': 'polite', 'data-agent-terminals-said': '' }, shown),
                data.agents.length === 0
                    ? h(kit.Empty, { title: TEXT.none, text: TEXT.noneText, action: h(ui.Button, { variant: 'primary', size: 'sm', onClick: onStart }, TEXT.start) })
                    : h('ul', { className: `${P}-list` }, ...data.agents.map((agent) => h(AgentCard, { key: agent.key, agent, act, busyKey, onOpen, openTerminal, spot }))));
        }

        const BLANK = Object.freeze({ program: '', args: '', style: 'plain', styleChosen: false, data: '', folder: '', name: '', task: '', where: 'new' });

        /** The form that starts a new agent. */
        function StartCard({ data, onStarted, formRef }) {
            const here = useStore(preset);
            const [form, setForm] = React.useState(BLANK);
            const [busy, setBusy] = React.useState(false);
            const [failure, setFailure] = React.useState(undefined);
            const alertRef = React.useRef(null);
            const programRef = React.useRef(null);
            React.useEffect(() => { if (failure) alertRef.current?.focus?.(); }, [failure]);
            // From a session's ⋯ menu: this form starts the agent in that session.
            React.useEffect(() => {
                if (!here) return;
                setForm((was) => ({ ...was, where: 'session' }));
                programRef.current?.focus?.();
            }, [here?.n]);
            React.useEffect(() => {
                if (formRef) formRef.current = { focus: () => { programRef.current?.scrollIntoView?.({ block: 'center' }); programRef.current?.focus?.(); } };
            });
            const set = (patch) => setForm((was) => ({ ...was, ...patch }));
            const found = (data.detected ?? []).filter((d) => kit.isRecord(d) && typeof d.program === 'string');
            const recent = (data.recent ?? []).filter((r) => kit.isRecord(r) && typeof r.program === 'string');
            const style = data.styles.find((s) => s.id === form.style) ?? data.styles[0];
            const inSession = form.where === 'session' && here;
            const ready = form.program.trim() && (inSession || form.folder.trim()) && !busy;
            const pick = (entry) => set({ program: entry.path || entry.program, style: entry.style, styleChosen: true, data: entry.data ?? '', args: Array.isArray(entry.args) ? entry.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') : '' });
            /** A program typed in: until you choose how it resumes, the way of one found or used before with that name. */
            const typeProgram = (program) => {
                const name = folderName(program.trim());
                const known = form.styleChosen || !name ? undefined
                    : found.find((d) => d.program === name || d.path === program.trim()) ?? recent.find((r) => folderName(r.program) === name);
                set({ program, ...(known ? { style: known.style, data: known.data ?? '' } : {}) });
            };
            const submit = async (event) => {
                event?.preventDefault?.();
                if (!ready) return;
                setBusy(true);
                setFailure(undefined);
                const input = {
                    program: form.program.trim(),
                    args: form.args,
                    style: form.style,
                    ...(form.data.trim() && style?.keepsTranscript ? { data: form.data.trim() } : {}),
                    ...(inSession ? { sessionId: here.sessionId } : { folder: form.folder.trim() }),
                    ...(form.name.trim() ? { name: form.name.trim() } : {}),
                    ...(form.task.trim() ? { task: form.task } : {}),
                };
                const { problem, value } = await run('start', { input });
                setBusy(false);
                if (problem) return setFailure(problem);
                if (value?.problem) {
                    // The form keeps what was written, to be fixed and started again; its card says the same below.
                    setFailure(`It was added, but could not start: ${value.problem} The form keeps what you wrote: forget the card that could not start, then fix the form and start again.`);
                } else {
                    setForm(BLANK);
                    if (inSession) preset.set(undefined);
                }
                onStarted(value?.agent, value?.problem);
            };
            const ids = { program: `${P}-program`, args: `${P}-args`, data: `${P}-data`, folder: `${P}-folder`, name: `${P}-name`, task: `${P}-task`, folders: `${P}-folders` };
            return h(kit.Card, { title: TEXT.start, sub: TEXT.startSub, attrs: { 'data-agent-terminals-start': '' } },
                h('form', { className: `${P}-form`, onSubmit: submit, noValidate: true },
                    found.length || recent.length ? h('div', { className: `${P}-field` },
                        found.length ? h('div', { className: `${P}-label`, id: `${P}-found` }, 'Found on this computer') : null,
                        found.length ? h('div', { className: `${P}-chips`, role: 'group', 'aria-labelledby': `${P}-found` }, ...found.map((d) => h('button', {
                            key: `f-${d.program}`,
                            type: 'button',
                            className: `${P}-chip`,
                            'data-agent-terminals-found': d.program,
                            onClick: () => pick(d),
                        }, h('span', { className: `${P}-code` }, d.program), h('span', { className: `${P}-chip-sub` }, [plural(d.conversations, 'conversation'), d.latest ? `last ${kit.agoText(d.latest)}` : '', d.path ? '' : 'not found where DSH looks for programs'].filter(Boolean).join(' · '))))) : null,
                        recent.length ? h('div', { className: `${P}-label`, id: `${P}-recent` }, 'Used here before') : null,
                        recent.length ? h('div', { className: `${P}-chips`, role: 'group', 'aria-labelledby': `${P}-recent` }, ...recent.map((r, i) => h('button', {
                            key: `r-${i}`,
                            type: 'button',
                            className: `${P}-chip`,
                            'data-agent-terminals-recent': String(i),
                            onClick: () => pick(r),
                        }, h('span', { className: `${P}-code` }, [r.program, ...(r.args ?? [])].join(' ')), h('span', { className: `${P}-chip-sub` }, data.styles.find((s) => s.id === r.style)?.label ?? '')))) : null) : null,
                    h('div', { className: `${P}-row2` },
                        h('div', { className: `${P}-field` },
                            h('label', { className: `${P}-label`, htmlFor: ids.program }, 'Program'),
                            h('input', { id: ids.program, ref: programRef, className: `${P}-input ${P}-code`, value: form.program, readOnly: busy, autoComplete: 'off', spellCheck: false, placeholder: 'The command you type to run it', onChange: (e) => typeProgram(e.target.value) }),
                            h('span', { className: `${P}-hint` }, 'One word, or the program\'s full path.')),
                        h('div', { className: `${P}-field` },
                            h('label', { className: `${P}-label`, htmlFor: ids.args }, 'Arguments'),
                            h('input', { id: ids.args, className: `${P}-input ${P}-code`, value: form.args, readOnly: busy, autoComplete: 'off', spellCheck: false, placeholder: 'Optional', onChange: (e) => set({ args: e.target.value }) }),
                            h('span', { className: `${P}-hint` }, 'As you would type them after its name; quote a part with spaces.'))),
                    h('fieldset', { className: `${P}-group` },
                        h('legend', { className: `${P}-legend` }, 'How it resumes a conversation'),
                        ...data.styles.map((s) => h('label', { key: s.id, className: `${P}-option` },
                            h('input', { type: 'radio', name: `${P}-style`, value: s.id, checked: form.style === s.id, disabled: busy, onChange: () => set({ style: s.id, styleChosen: true }) }),
                            h('span', null, s.label, h('span', { className: `${P}-option-hint` }, s.detail))))),
                    style?.keepsTranscript ? h('div', { className: `${P}-field` },
                        h('label', { className: `${P}-label`, htmlFor: ids.data }, 'Its conversations folder'),
                        h('input', { id: ids.data, className: `${P}-input ${P}-code`, value: form.data, readOnly: busy, autoComplete: 'off', spellCheck: false, placeholder: form.program.trim() ? `~/.${folderName(form.program.trim())}` : '~/.<program>', onChange: (e) => set({ data: e.target.value }) }),
                        h('span', { className: `${P}-hint` }, 'Where the program keeps its conversations. Empty: a folder named after it in your home folder.')) : null,
                    h('fieldset', { className: `${P}-group` },
                        h('legend', { className: `${P}-legend` }, 'Where it works'),
                        here ? h('label', { className: `${P}-option` },
                            h('input', { type: 'radio', name: `${P}-where`, value: 'session', checked: form.where === 'session', disabled: busy, onChange: () => set({ where: 'session' }) }),
                            h('span', null, `In the session “${here.title || 'Untitled session'}”`, h('span', { className: `${P}-option-hint` }, 'Its terminal opens beside that session, in its folder.'))) : null,
                        here ? h('label', { className: `${P}-option` },
                            h('input', { type: 'radio', name: `${P}-where`, value: 'new', checked: form.where !== 'session', disabled: busy, onChange: () => set({ where: 'new' }) }),
                            h('span', null, 'In a new session in a folder')) : null,
                        inSession ? null : h('div', { className: `${P}-field` },
                            h('label', { className: `${P}-label`, htmlFor: ids.folder }, 'Folder'),
                            h('input', { id: ids.folder, className: `${P}-input ${P}-code`, value: form.folder, readOnly: busy, autoComplete: 'off', spellCheck: false, list: ids.folders, placeholder: '~/Projects/app', onChange: (e) => set({ folder: e.target.value }) }),
                            h('datalist', { id: ids.folders }, ...(data.workspaces ?? []).map((w) => h('option', { key: w.path, value: w.path }, w.title || folderName(w.path)))),
                            h('span', { className: `${P}-hint` }, 'The folder it works in. It gets a new session there, named after it.'))),
                    h('div', { className: `${P}-row2` },
                        h('div', { className: `${P}-field` },
                            h('label', { className: `${P}-label`, htmlFor: ids.name }, 'Name'),
                            h('input', { id: ids.name, className: `${P}-input`, value: form.name, readOnly: busy, autoComplete: 'off', placeholder: form.program.trim() ? `${folderName(form.program.trim())}${!inSession && form.folder.trim() ? ` · ${folderName(form.folder.trim())}` : ''}` : 'Optional', onChange: (e) => set({ name: e.target.value }) }),
                            h('span', { className: `${P}-hint` }, 'Shown here, on its session and in Decisions.')),
                        h('div', { className: `${P}-field` },
                            h('label', { className: `${P}-label`, htmlFor: ids.task }, 'First message'),
                            h('textarea', { id: ids.task, className: `${P}-textarea`, rows: 2, value: form.task, readOnly: busy, placeholder: 'Optional: typed in once it is ready', onChange: (e) => set({ task: e.target.value }) }))),
                    failure ? h('p', { className: `${P}-alert`, role: 'alert', tabIndex: -1, ref: alertRef, 'data-agent-terminals-start-error': '' }, /^(Not |It was added)/.test(failure) ? failure : `Not started: ${failure}`) : null,
                    h('div', { className: `${P}-actions` },
                        h(ui.Button, { type: 'submit', variant: 'primary', size: 'sm', disabled: !ready, onClick: submit }, busy ? 'Starting…' : 'Start'),
                        h('span', { className: `${P}-hint` }, ready ? (inSession ? 'Its terminal opens beside the session.' : 'It gets a new session, with its terminal in a tab beside it.') : !form.program.trim() ? 'Name the program first.' : 'Choose the folder it works in.'))));
        }

        function HistoryRow({ entry, names, onOpen }) {
            // An ask's entry says it waited ("… waits on you"); a tag would still say so after you answered.
            const state = entry.state && entry.state !== 'done' && entry.state !== 'waiting on you' ? entry.state : '';
            const failed = state === 'failed' || state === 'not delivered' || state === 'not proven';
            const name = names.get(entry.agent);
            return h('li', { className: `${P}-item`, 'data-agent-terminals-entry': entry.kind },
                h('span', { className: `${P}-log-time` }, h(kit.TimeText, { at: entry.at })),
                h('div', { className: `${P}-item-main` },
                    h('div', null,
                        entry.sessionId && name ? h('button', { type: 'button', className: `${P}-link`, onClick: () => onOpen(entry.sessionId), title: 'Open its session' }, name) : null,
                        entry.sessionId && name ? h('span', { className: `${P}-meta` }, ' · ') : null,
                        h('span', null, entry.text),
                        entry.by === 'you' ? h('span', { className: `${P}-meta` }, ' · You') : null),
                    entry.why ? h('div', { className: `${P}-why` }, `Why: ${entry.why}`) : null,
                    entry.reason ? h('div', { className: `${P}-why${failed ? ` ${P}-error` : ''}` }, `${failed ? `${state[0].toUpperCase()}${state.slice(1)}: ` : ''}${String(entry.reason).replace(/\.$/, '')}.`) : null),
                state ? h('div', { className: `${P}-item-side` }, h(kit.StateTag, { word: DELIVERY_WORDS[state] ?? state })) : null);
        }

        function HistoryCard({ data, onOpen }) {
            const [all, setAll] = React.useState(false);
            const names = React.useMemo(() => new Map(data.agents.map((a) => [a.key, a.name])), [data.agents]);
            const shown = all ? data.history : data.history.slice(0, 30);
            return h(kit.Card, { title: TEXT.history, sub: TEXT.historySub, attrs: { 'data-agent-terminals-history': '' } },
                data.history.length === 0 ? h(kit.Empty, { title: TEXT.noHistory, text: TEXT.noHistoryText })
                    : [
                        h('ul', { key: 'l', className: `${P}-list` }, ...shown.map((entry) => h(HistoryRow, { key: entry.id, entry, names, onOpen }))),
                        data.history.length > shown.length ? h('div', { key: 'm', style: { marginTop: '8px' } }, h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setAll(true) }, `Show all ${data.history.length}`)) : null,
                    ]);
        }

        function AgentsPage({ agents: views }) {
            const live = kit.useLive(readState, ['agent-terminals', 'sessions', 'settings'], { delayMs: 300 });
            const [busyKey, setBusyKey] = React.useState(undefined);
            const [said, setSaid] = React.useState({ text: '', n: 0 });
            const formRef = React.useRef(undefined);
            const onOpen = React.useCallback((sessionId) => views?.openSession?.(sessionId), [views]);
            const openTerminal = React.useCallback((agent) => views?.openTerminal?.(agent), [views]);
            const onStart = React.useCallback(() => formRef.current?.focus?.(), []);
            /** Act on an agent; the agent's card shows a failure, the list's status line what it did. */
            const act = React.useCallback(async (method, args, agent) => {
                setBusyKey(agent?.key ?? method);
                const { problem, value } = await run(method, args);
                setBusyKey(undefined);
                if (!problem) {
                    const text = method === 'startAgain' && value?.problem ? '' : saidText(method, agent, value);
                    // A message you sent: the line follows it (typed in, delivered, not proven).
                    const follow = method === 'send' && value?.delivery?.id ? { delivery: value.delivery.id, key: agent?.key } : {};
                    if (text) setSaid((was) => ({ text, n: was.n + 1, at: Date.now(), ...follow }));
                    if (method === 'startAgain' && value?.problem) return `It could not start: ${value.problem}`;
                }
                void live.refresh();
                return problem;
            }, [live.refresh]);
            const onStarted = React.useCallback((agent, problem) => {
                if (agent && !problem) setSaid((was) => ({ text: `Started “${agent.name}”. Open its terminal to watch it work.`, n: was.n + 1, at: Date.now() }));
                void live.refresh();
            }, [live.refresh]);
            const data = live.data;
            // Not running (or Session Watch is off): old data would mislead, so the page says why and what to do.
            const down = live.code === 'not-running' || (data === undefined && live.error);
            return h(kit.Page, { label: TEXT.title, attrs: { 'data-agent-terminals-page': '' } },
                down
                    ? h(kit.Card, { title: TEXT.title, headingLevel: 1, main: true, sub: TEXT.summary },
                        h(kit.Trouble, { name: 'Agent Terminals', packageName: BUNDLE, code: live.code, text: live.error, onRetry: live.refresh }))
                    : data === undefined
                        ? h(kit.Card, { title: TEXT.title, headingLevel: 1, main: true }, h(kit.Loading, { text: TEXT.loading }))
                        : data.problem
                            ? [
                                h(kit.Card, { key: 'head', title: TEXT.title, headingLevel: 1, main: true, sub: TEXT.summary, attrs: { 'data-agent-terminals-header': 'problem' } },
                                    h(kit.SettingsProblem, { name: 'Agent Terminals', packageName: BUNDLE, problem: data.problem })),
                                data.agents.length ? h(AgentsCard, { key: 'agents', data, act, busyKey, said, onOpen, openTerminal, onStart }) : null,
                                h(HistoryCard, { key: 'history', data, onOpen }),
                            ]
                            : [
                                h(HeaderCard, { key: 'head', data, onStart }),
                                live.error ? h(kit.ErrorLine, { key: 'refresh', text: live.error, onRetry: live.refresh }) : null,
                                data.enabled ? h(AgentsCard, { key: 'agents', data, act, busyKey, said, onOpen, openTerminal, onStart }) : null,
                                data.enabled ? h(StartCard, { key: 'start', data, onStarted, formRef }) : null,
                                h(HistoryCard, { key: 'history', data, onOpen }),
                            ]);
        }

        /** The panel entry's glyph, with the count of agents waiting on you. */
        function AgentsIcon({ size = 16 }) {
            const m = useStore(marks);
            const waiting = m.off ? 0 : m.agents.filter((a) => a.status === 'waiting on you').length;
            return h('span', { className: `${P}-icon`, 'data-agent-terminals-icon': m.off ? 'off' : String(waiting) },
                h('span', { style: m.off ? { opacity: 0.55, display: 'inline-flex' } : { display: 'inline-flex' } }, h(TerminalGlyph, { size })),
                waiting > 0 ? h('span', { className: `${P}-badge` }, waiting > 9 ? '9+' : String(waiting)) : null,
                waiting > 0 ? h('span', { className: `${P}-sr` }, `${plural(waiting, 'coding agent')} waiting on you`) : null);
        }

        /** A session row's leading mark: what its coding agent is doing. */
        function AgentMark({ sessionId }) {
            const m = useStore(marks);
            const agent = m.off ? undefined : m.agents.find((a) => a.sessionId === sessionId);
            if (!agent) return null;
            const word = statusWord(agent);
            const dot = dotOf(agent);
            // DSH's dot and the glyph are hidden from screen readers: the state is said in words here, and in the row's hover card.
            return h('span', { className: `${P}-mark`, 'data-agent-terminals-mark': agent.status },
                dot && ui.StateDot ? h(ui.StateDot, { state: dot }) : h(TerminalGlyph, { size: 13, stopped: agent.status === 'stopped' }),
                h('span', { className: `${P}-sr` }, `Coding agent: ${word}.`));
        }

        /** A session row's hover card: its coding agent's state and what it is doing. */
        function AgentHover({ sessionId }) {
            const m = useStore(marks);
            const agent = m.off ? undefined : m.agents.find((a) => a.sessionId === sessionId);
            if (!agent) return null;
            const dot = dotOf(agent) ?? 'idle';
            return h('div', { className: `${P}-hover`, 'data-agent-terminals-hover': agent.status },
                h('div', { className: `${P}-hover-head` },
                    ui.StateDot ? h(ui.StateDot, { state: dot }) : null,
                    h('span', null, `Coding agent in its terminal: ${statusWord(agent)}`)),
                agent.detail ? h('div', { className: `${P}-hover-line` }, String(agent.detail).length > 160 ? `${String(agent.detail).slice(0, 159)}…` : agent.detail) : null);
        }

        /** An item in a session row's ⋯ menu: start an agent there, or open the one it has. */
        function AgentMenuItem({ sessionId, displayTitle, useMenuOpenState, agents: views }) {
            const m = useStore(marks);
            let close = () => {};
            try {
                const state = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined;
                if (Array.isArray(state) && typeof state[1] === 'function') close = () => state[1](false);
            } catch { /* the menu closes by itself */ }
            if (m.off || typeof sessionId !== 'string') return null;
            const agent = m.agents.find((a) => a.sessionId === sessionId);
            const icon = h(PromptGlyph, {});
            if (agent?.running) {
                return h(ui.MenuItemButton, { icon, onSelect: () => { close(); views?.openTerminal?.(agent); } }, 'Open the coding agent\'s terminal');
            }
            if (agent) {
                return h(ui.MenuItemButton, { icon, onSelect: () => { close(); views?.showAgent?.(agent.key); } }, 'Show its coding agent');
            }
            return h(ui.MenuItemButton, { icon, onSelect: () => { close(); views?.startHere?.(sessionId, displayTitle); } }, 'Start a coding agent here');
        }

        const inject = ['slots'];

        function apply(ctx) {
            try {
                kit.injectStyle(CSS);
            } catch (error) {
                console?.warn?.('dsh-plugin-agent-terminals: style:', error);
            }
            ctx.effect?.(() => () => kit.removeStyle(), 'agent-terminals: style');
            ctx.inject(['connection'], (scope) => scope.effect(() => {
                kit.setConnection(scope.connection);
                const detach = kit.hub.attach();
                const stop = followMarks();
                return () => {
                    stop();
                    detach();
                    kit.setConnection(undefined);
                };
            }, 'agent-terminals: connection'));
            ctx.inject(['uiWorkspace'], (scope) => applyViews(scope));
            // Each agent's terminal in a tab beside its session (DSH's right sidebar and its terminal views).
            ctx.inject(['sidebarRight', 'webTerminals'], (scope) => scope.effect(() => followTabs(scope.sidebarRight, scope.webTerminals), 'agent-terminals: terminal tabs'));
            // DSH's Plugins page: the buttons that open Agent Terminals' (or Session Watch's) switch and settings.
            ctx.inject(['pluginNavigation'], (scope) => {
                kit.setNavigation(scope.pluginNavigation);
                return () => kit.setNavigation(undefined);
            });
            // Its settings on its page in Plugins, through DSH's own settings form; one part failing never stops the others.
            ctx.inject(['configForms', 'remote', 'remote.session'], (scope) => {
                try {
                    kit.applySettings(scope, { entry: 'agent-terminals', name: 'Agent Terminals', summary: SETTINGS_SUMMARY, fields: SETTINGS, note: SETTINGS_NOTE });
                } catch (error) {
                    console?.warn?.('dsh-plugin-agent-terminals: settings:', error);
                }
            });
        }

        /** The page, its sidebar entry and the session rows' parts, once DSH's workspace (which opens sessions) is there. */
        function applyViews(ctx) {
            // DSH's way to a panel page, as its sidebar entry opens it, read when needed.
            const openPage = () => {
                let layout;
                try { layout = ctx.get?.('layout'); } catch { layout = undefined; }
                try { layout?.selectPanel?.(PAGE); } catch (error) { console?.warn?.('dsh-plugin-agent-terminals: could not open the Coding agents page', error); }
            };
            const views = {
                openSession(sessionId) {
                    if (typeof sessionId !== 'string' || sessionId === '') return;
                    try { ctx.uiWorkspace.openSession(sessionId); } catch (error) { console?.warn?.('dsh-plugin-agent-terminals: could not open the session', error); }
                },
                /** Open the agent's session with its terminal tab in front (opened if it is not there). */
                openTerminal(agent) {
                    if (!agent?.sessionId || !agent.terminalId) return;
                    reveal.set({ sessionId: agent.sessionId, terminalId: agent.terminalId, at: Date.now() });
                    views.openSession(agent.sessionId);
                },
                startHere(sessionId, title) {
                    preset.set({ sessionId, title: typeof title === 'string' ? title : '', n: (preset.get()?.n ?? 0) + 1 });
                    openPage();
                },
                showAgent(key) {
                    spotlight.set({ key, n: (spotlight.get()?.n ?? 0) + 1 });
                    openPage();
                },
            };
            const withApi = () => ({ agents: views });
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PAGE, inject: withApi }, AgentsPage));
            // After Plugins (0), Decisions (2) and Autopilot (3), before Categories (6).
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PAGE, order: 4, label: TEXT.entry }, AgentsIcon));
            // The leading seat holds one mark: before the coordinator's (20), after DSH's automation mark (10).
            ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: `${BUNDLE}:mark`, order: 15 }, AgentMark));
            ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({ name: 'sidebar.session.row.hover', id: `${BUNDLE}:hover`, order: 15 }, AgentHover));
            ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: `${BUNDLE}:menu`, order: 60, inject: withApi }, AgentMenuItem));
        }

        module.exports.inject = inject;
        module.exports.apply = apply;
        // For the plugin's own tests.
        module.exports.internals = { kit, TEXT, CSS, SETTINGS, SETTINGS_SUMMARY, SETTINGS_NOTE, STATUS_WORDS, DELIVERY_WORDS, statusWord, deliveryWord, countText, saidText, saidLine, shortCommand, earlierTerminal, boundTerminal, followTabs, followMarks, marks, preset, spotlight, reveal, AgentsPage, AgentsIcon, AgentCard, AgentsCard, StartCard, HeaderCard, HistoryCard, AgentMark, AgentHover, AgentMenuItem };
        return module.exports;
    },
});
