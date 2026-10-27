/**
 * dsh-plugin-decisions, browser half: Decisions' page in DSH's sidebar.
 *
 * - The entry in DSH's panel list (`sidebar.panellist`, order 2), with the
 *   count of what waits on you, and its page in `main`.
 * - The page: everything waiting on you, most urgent first (what holds a
 *   running turn), each card with its question, the agent's recommendation,
 *   the session (one click opens it) and how long it has waited, and the
 *   controls its kind takes: Allow once or Reject, the question box's
 *   choices, an answer in words or the recommendation, or a plugin's own
 *   options. Then what you dismissed, and what happened (new cards, your
 *   answers and whether the session got them, what went elsewhere). When
 *   Decisions cannot work it says why and what to do: Session Watch is off,
 *   Decisions is not running, or a setting is wrong.
 * - Its settings on its page in Plugins (DSH's `plugins.bundle.config`),
 *   saved through DSH's own settings form; the webhook address goes to
 *   DSH's key store, never the settings file.
 *
 * Hand-written in the module format DSH serves to the browser (no build
 * step). Nothing here may throw at load: DSH joins every plugin's browser
 * half into one script, and one error would stop the others.
 *
 * @module dsh-plugin-decisions/client
 */
// DSH serves browser halves in one script; never throw here, or the others stop loading too.
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-decisions',
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
    /** Choices made with the keyboard and not yet applied, by control id (see Choice). */
    const pendingChoices = new Map();
    /** Where and when the last press of a pointer was while a choice waited, so a blur toward an empty spot can be told from a redraw. */
    const lastPointerDown = { at: 0, target: null };

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
        // "Changed" and "Use the default" as DSH's own field draws them beside a typed value: one look for every row.
        `.${P}-set-badges{display:inline-flex;align-items:center;gap:8px}`,
        `.${P}-set-reset{padding:0;border:0;background:none;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}`,
        `.${P}-set-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.${P}-set-reset:disabled{cursor:default}`,
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
        // DSH tints a tag's ground with its tone over nothing (see-through), so over a picture at a low tint its words
        // lose contrast. On the suite's pages the same tint lies over the card's own colour instead: a solid chip.
        `:is(.${P}-page,.${P}-pane,.${P}-pop){--${P}-chip:rgb(14,18,17)}body:not([data-ds-dark-theme]) :is(.${P}-page,.${P}-pane,.${P}-pop){--${P}-chip:rgb(250,250,246)}`,
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag[data-tone="warning"]{background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,var(--${P}-chip))}`,
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag[data-tone="danger"]{background-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--${P}-chip))}`,
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag[data-tone="success"]{background-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,var(--${P}-chip))}`,
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag[data-tone="info"]{background-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--${P}-chip))}`,
        // Quiet and neutral words ("idle", "stopped") would be drawn in DSH's glyph colour, which is for glyphs, not small text.
        `:is(.${P}-page,.${P}-pane,.${P}-pop) .${P}-tag:is([data-tone="quiet"],[data-tone="neutral"]){color:var(--${P}-text-2)}`,
        // The settings form sits on DSH's Plugins page, outside the page's colours: the same secondary text, said here.
        `.${P}-settings .${P}-tag:is([data-tone="quiet"],[data-tone="neutral"]){color:color-mix(in srgb,var(--dsw-alias-label-secondary) 80%,var(--dsw-alias-label-primary))}`,
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
    /** How often a window looks at DSH's plugin list while Session Watch is not running. */
    const HUB_DOWN_MS = 4000;

    /**
     * Whether Session Watch runs, from DSH's own list of plugins (what its
     * Plugins page reads): 'on'; 'off' (switched off, starting, stopping,
     * failed, or not installed); or 'unknown' when this DSH gives no list.
     * Asking the list rather than Session Watch's own endpoint keeps the
     * window's console free of failed requests while it is off.
     */
    async function watchRuns(c) {
        let result;
        try {
            result = await c.rpc.call('/api', 'pluginManager/listPlugins', { args: {} });
        } catch {
            return 'unknown';
        }
        if (!isRecord(result) || result.ok !== true || !Array.isArray(result.value)) return 'unknown';
        const rows = result.value.filter((row) => isRecord(row) && row.moduleName === HUB_NS);
        if (rows.length === 0) return 'off';
        return rows.some((row) => row.enabled !== false && row.fiberPhase === 'active') ? 'on' : 'off';
    }

    function createHub() {
        const state = { providers: new Set(), subs: new Set(), since: undefined, running: false, failures: 0, down: false, watch: 'unknown' };
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
                    if (state.down) {
                        // Session Watch did not answer: DSH's plugin list says whether it runs, so the window never
                        // asks an endpoint that is not there. While it is off, nothing else is asked.
                        state.watch = await watchRuns(c);
                        if (state.watch === 'off') {
                            state.failures = 0;
                            await sleep(HUB_DOWN_MS);
                            continue;
                        }
                        // It runs but did not answer, or this DSH has no list: ask again after a few seconds (at most 10).
                        if (state.failures > 0) await sleep(Math.min(10000, 2000 * 2 ** Math.min(state.failures, 3)));
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
                        const wasDown = state.down;
                        state.since = next;
                        state.failures = 0;
                        state.down = false;
                        state.watch = 'on';
                        // Back after a stop (or the first answer): every page reads again.
                        if (!prev || prev.epoch !== next.epoch || wasDown) notify('all');
                        else {
                            const changed = new Set();
                            const was = prev.versions ?? {};
                            for (const [channel, n] of Object.entries(next.versions ?? {})) if ((was[channel] ?? 0) !== n) changed.add(channel);
                            if (changed.size) notify(changed);
                        }
                        continue;
                    }
                    // The watcher stopped (or did not answer): pages read once, so each can say what it needs (a page
                    // that opened before any answer has read already); then the loop above waits for it to run.
                    state.failures += 1;
                    if (!state.down) {
                        state.down = true;
                        if (state.since) notify('all');
                    }
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
            /** What the hub last knew of Session Watch: 'on', 'off' (DSH's plugin list says it is not running) or 'unknown'. */
            get watch() { return state.down ? state.watch : state.since ? 'on' : state.watch; },
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
     * says so in `error`. On a slow host reads can finish out of order: a read
     * that finishes after a newer one has landed is old news and is dropped,
     * so the page never goes back to what was true before.
     */
    function useLive(read, channels, { delayMs = 250 } = {}) {
        const [state, setState] = React.useState({ data: undefined, error: undefined, code: undefined, loading: true });
        const readRef = React.useRef(read);
        readRef.current = read;
        const timer = React.useRef(undefined);
        const alive = React.useRef(true);
        const asked = React.useRef(0);
        const landed = React.useRef(0);
        const refresh = React.useCallback(async () => {
            const n = ++asked.current;
            const fresh = () => {
                if (!alive.current || n < landed.current) return false;
                landed.current = n;
                return true;
            };
            try {
                const data = await readRef.current();
                if (fresh()) setState({ data, error: undefined, code: undefined, loading: false });
            } catch (error) {
                if (fresh()) setState((s) => ({ data: s.data, error: String(error?.message ?? error), code: typeof error?.code === 'string' ? error.code : undefined, loading: false }));
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
     * or leaving the control for another place, goes back to the saved one).
     * It is never disabled while a change is on its way, so focus stays where
     * it was; a choice made meanwhile is applied next. `onChoose(value)` may
     * return a promise of false when the change did not go through: the
     * control then shows the saved value again.
     *
     * A choice not yet applied outlives a redraw of its list (the row moved,
     * or was drawn anew): it is kept by the control's id, and the focus comes
     * back to it, so the next Enter still applies it.
     */
    function Choice({ id, label, value, options, busy = false, onChoose, className = '' }) {
        const kept = pendingChoices.get(id);
        // A kept choice counts only while the saved value is the one it was made against.
        if (kept && kept.from !== value) pendingChoices.delete(id);
        const [shown, setShownState] = React.useState(kept && kept.from === value ? kept.value : value);
        const sent = React.useRef(undefined);
        const queued = React.useRef(undefined);
        const valueRef = React.useRef(value);
        const box = React.useRef(null);
        const mounted = React.useRef(false);
        valueRef.current = value;
        /** Show a value; one that is not the saved one is kept by id until it is applied or dropped. */
        const setShown = (next, focused) => {
            setShownState(next);
            if (next === valueRef.current) pendingChoices.delete(id);
            else pendingChoices.set(id, { value: next, from: valueRef.current, focused: focused ?? pendingChoices.get(id)?.focused ?? true });
        };
        React.useEffect(() => {
            // The first run is the mount: a kept choice stays. Later, a new saved value replaces what is shown.
            if (!mounted.current) {
                mounted.current = true;
                return;
            }
            setShown(value);
            sent.current = undefined;
        }, [value]);
        // Drawn anew, or moved, with its choice kept and the focus lost to the page: the focus comes back.
        React.useEffect(() => {
            const entry = pendingChoices.get(id);
            if (!entry?.focused || entry.value !== shown || shown === value || !doc || !box.current) return;
            const active = doc.activeElement;
            if (active && active !== doc.body && active !== doc.documentElement) return;
            const tab = box.current.querySelector?.('[role="tab"][aria-selected="true"]') ?? box.current.querySelector?.('[role="tab"]');
            tab?.focus?.({ preventScroll: true });
        });
        const commit = (next) => {
            if (!options.some((o) => o.value === next && o.disabled !== true)) return;
            if (busy) {
                queued.current = next;
                setShownState(next);
                pendingChoices.delete(id);
                return;
            }
            pendingChoices.delete(id);
            if (next === valueRef.current || next === sent.current) return;
            sent.current = next;
            setShownState(next);
            void Promise.resolve(onChoose(next)).then((ok) => {
                if (ok !== false || sent.current !== next) return;
                sent.current = undefined;
                setShownState(valueRef.current);
            }, () => {
                sent.current = undefined;
                setShownState(valueRef.current);
            });
        };
        React.useEffect(() => {
            if (busy || queued.current === undefined) return;
            const next = queued.current;
            queued.current = undefined;
            commit(next);
        }, [busy]);
        const pending = shown !== value && shown !== sent.current && shown !== queued.current;
        // While a choice waits, note where the pointer goes down (and nothing after it is applied or this control goes).
        React.useEffect(() => {
            if (!pending || !doc?.addEventListener) return undefined;
            const note = (event) => {
                lastPointerDown.at = Date.now();
                lastPointerDown.target = event.target;
            };
            doc.addEventListener('pointerdown', note, true);
            return () => {
                doc.removeEventListener('pointerdown', note, true);
                lastPointerDown.at = 0;
                lastPointerDown.target = null;
            };
        }, [pending]);
        const shownLabel = options.find((o) => o.value === shown)?.label ?? shown;
        const tabValue = (target) => {
            const tab = target?.closest?.('[role="tab"]');
            return tab && typeof tab.id === 'string' && tab.id.startsWith(`${id}-`) ? tab.id.slice(id.length + 1) : undefined;
        };
        const drop = () => {
            pendingChoices.delete(id);
            setShownState(valueRef.current);
        };
        return h('div', {
            ref: box,
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
                    drop();
                }
            },
            onFocusCapture: () => {
                const entry = pendingChoices.get(id);
                if (entry) entry.focused = true;
            },
            onBlurCapture: (event) => {
                if (!pending) return;
                const to = event.relatedTarget;
                if (to && !event.currentTarget.contains(to)) {
                    // The person went to another place on the page.
                    drop();
                    return;
                }
                // The focus went nowhere: a click on an empty spot drops the choice; a redraw that moved the row
                // (no click) keeps it, and the focus comes back on the next draw.
                if (!to && Date.now() - lastPointerDown.at < 600 && !event.currentTarget.contains(lastPointerDown.target)) drop();
            },
        },
        h(ui.SegmentedControl, { id, label, value: shown, options, onChange: (next) => setShown(next, true) }),
        h('span', { className: pending ? `${P}-choice-hint` : `${P}-sr`, role: 'status', 'aria-live': 'polite' }, pending ? `Press Enter to apply ${shownLabel}.` : ''));
    }

    // ── States every suite page shares ────────────────────────────────

    const WATCH_PACKAGE = 'dsh-plugin-session-watch';
    const watchLink = link(WATCH_PACKAGE, { name: 'Session Watch' });

    /** Whether Session Watch runs: DSH's plugin list first (no request to an endpoint that is not there), else its status. */
    async function watchRunning() {
        const c = connections.current ?? await whenConnected();
        if (c) {
            const runs = await watchRuns(c);
            if (runs !== 'unknown') return runs === 'on';
        }
        const result = await watchLink.call('status');
        return result.ok || result.error?.code !== 'not-running';
    }

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
            void watchRunning().then((up) => { if (alive) setWatchUp(up); }, () => {});
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
     * person can change it there, else DSH's profile). `profileApplies`: the
     * plugin restarts with its new settings when DSH's profile is saved, so
     * no restart of DSH is needed (else the line says to restart DSH).
     */
    function SettingsProblem({ name, packageName, problem, profileApplies = false }) {
        const live = problem?.live === true;
        const its = whose(name);
        return h('div', { className: `${P}-trouble`, role: 'alert', 'data-suite-trouble': 'setting' },
            h('p', { className: `${P}-trouble-title` }, `${name} is waiting for a setting to be fixed.`),
            h('p', { className: `${P}-trouble-text` }, `${String(problem?.text ?? 'A setting is wrong').replace(/\.$/, '')}.`),
            h('p', { className: `${P}-trouble-text` }, live
                ? `Change it in ${its} settings in Plugins. ${name} starts working again as soon as you save.`
                : profileApplies
                    ? `Change it in ${its} entry in DSH's profile (cordis.patch.yml). DSH applies the file when you save it.`
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
        // Where text is the wrong kind (a number, a list or a switch saved in quotes), it shows with its quotes: the
        // form flags it as it opens, and the value typed without them counts as a change, so Save stores it.
        const quoted = (v) => (typeof v === 'string' ? JSON.stringify(v) : raw(v));
        switch (f.kind) {
            case 'switch':
                return { field: f.name, format: (v) => (v === true ? 'on' : v === false ? 'off' : quoted(v)), parse: (t) => (t === 'on' ? { kind: 'set', value: true } : t === 'off' ? { kind: 'set', value: false } : t === '' ? clear : undefined) };
            case 'choice':
                return { field: f.name, format: raw, parse: (t) => (t === '' ? clear : f.options.some((o) => o.value === t) ? { kind: 'set', value: t } : undefined) };
            case 'number':
                return {
                    field: f.name,
                    format: (v) => (Number.isFinite(v) ? String(v) : quoted(v)),
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
                    format: (v) => (Array.isArray(v) && v.every((n) => Number.isFinite(n)) ? v.join(', ') : Array.isArray(v) ? JSON.stringify(v) : quoted(v)),
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

    /** Whether a setting's text is a value saved in quotes (text where a number or a list of numbers belongs). */
    const inQuotes = (text) => typeof text === 'string' && text.length >= 2 && text.startsWith('"') && text.endsWith('"');

    /** The words under a value that does not fit: what does (and, for one saved in quotes, that the quotes are what is wrong). */
    function invalidWords(f, text) {
        if (inQuotes(text) && (f.kind === 'number' || f.kind === 'numbers')) {
            const what = f.kind === 'number' ? `a whole number from ${f.min} to ${f.max}` : `up to ${f.maxItems ?? 10} whole numbers from ${f.min} to ${f.max}, with commas between them`;
            return `It is saved as text, in quotes. Type ${what}, without the quotes, then save.`;
        }
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
                h(ui.SettingsSecretField, { id: `${P}-set-${f.name}`, label: f.title, hint: fromEnvironment ? (f.envHint ?? f.hint) : info.configured ? (f.setHint ?? f.hint) : f.hint, disabled: disabled || info.writable === false, text: draft, configured: info.configured === true, stateLabel, onEdit }),
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
        // As DSH's own field marks a typed value: "Changed", then "Use the default".
        const reset = state.overridden
            ? h('span', { className: `${P}-set-badges` },
                h(ui.Tag, { tone: 'neutral', className: `${P}-tag` }, 'Changed'),
                h('button', { type: 'button', className: `${P}-set-reset`, disabled, onClick: () => actions.resetField(f.name), 'aria-label': `Use the default for ${f.title}` }, 'Use the default'))
            : null;
        if (f.kind === 'switch' || f.kind === 'choice') {
            return h('div', { className: `${P}-set-row`, 'data-suite-setting': f.name, ...(state.invalid ? { 'data-suite-invalid': '' } : {}) },
                h('div', { className: `${P}-set-text` },
                    h('div', { className: `${P}-set-title`, id: `${id}-label` }, f.title),
                    h('div', { className: `${P}-set-hint` }, f.hint),
                    state.invalid ? h('p', { className: `${P}-set-error`, role: 'alert' }, invalidWords(f, state.text)) : null),
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
                    invalidLabel: invalidWords(f, state.text),
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
            const parsed = state.invalid || state.text === '' ? undefined : fieldSpec(f).parse(state.text);
            const wrong = !state.invalid && state.text !== '' && parsed === undefined;
            // A value saved in the profile that equals its default is not a change: no "Changed", nothing to reset.
            const atDefault = state.overridden && parsed?.kind === 'set' && f.default !== undefined && JSON.stringify(parsed.value) === JSON.stringify(f.default);
            rows.push(h(SettingRow, { key: f.name, f, state: wrong ? { ...state, invalid: true } : atDefault ? { ...state, overridden: false } : state, disabled, actions: form.actions }));
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
     * labels (`setLabel`, `envLabel`, `unsetLabel`, `envHint`, `setHint`, `removeLabel`)
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

        const BUNDLE = 'dsh-plugin-decisions';
        const PAGE = `${BUNDLE}:page`;
        const kit = suiteKit({ prefix: 'dshdc', bundle: BUNDLE, React, ui, h });
        const P = kit.P;
        /** The plugin that shows notifications, opened in Plugins when it is not running. */
        const NOTIFICATIONS_PACKAGE = 'dsh-plugin-notifications';
        /** The watcher Decisions reads every session through; its settings are on its own page in Plugins. */
        const WATCH_BUNDLE = 'dsh-plugin-session-watch';
        /** DSH's own list of plugins, as its Plugins page reads it. */
        const pluginList = kit.link('pluginManager', { name: 'DSH\'s plugin list' });

        /** Whether DSH has a plugin installed: true, false, or undefined while that is not known (then it is not said). */
        function useInstalled(packageName, ask) {
            const [installed, setInstalled] = React.useState(undefined);
            React.useEffect(() => {
                if (!ask) return undefined;
                let alive = true;
                void pluginList.call('listBundles').then((result) => {
                    if (!alive || !result.ok || !Array.isArray(result.value)) return;
                    const bundle = result.value.find((b) => kit.isRecord(b) && b.name === packageName);
                    setInstalled(Boolean(bundle) && bundle.installed !== false);
                });
                return () => { alive = false; };
            }, [ask]);
            return installed;
        }
        const api = kit.link(BUNDLE, { name: 'Decisions' });

        const TEXT = {
            entry: 'Decisions',
            title: 'Decisions',
            summary: 'Everything waiting on you, in one place: decision lines, tools waiting for approval, questions, and threads that need a decision. Answer here and the answer goes into the session.',
            disabled: 'Decisions is switched off in DSH\'s profile (enabled: false in its entry in cordis.patch.yml), so it lists nothing and holds nothing. To use it, set enabled to true there; DSH applies it when you save the file. To remove it instead, switch it off in Plugins.',
            waiting: 'Waiting on you',
            nothing: 'Nothing waits on you',
            dismissed: 'Dismissed',
            dismissedSub: 'Hidden from the list. A session that still waits for an answer still waits in the session.',
            history: 'What happened',
            historySub: 'Newest first: new cards, your answers and whether the session got them, and what went elsewhere.',
            noHistory: 'Nothing yet',
            noHistoryText: 'New cards and your answers show here, each with whether the session got it.',
            loading: 'Reading what waits on you',
            settings: 'Settings',
            sent: 'What it sent',
        };

        /** A card's state word (one set of words on every surface). */
        const KIND_WORD = Object.freeze({
            approval: 'waiting for approval',
            question: 'asks you',
            ask: 'asks you',
            decision: 'needs a decision',
            blocked: 'blocked',
            thread: 'needs a decision',
            reply: 'asked you',
        });
        const wordOf = (card) => (card.kind === 'thread' && card.status === 'blocked' ? 'blocked' : KIND_WORD[card.kind] ?? 'asked you');

        const SOURCE_WORDS = Object.freeze({
            approvals: 'tools waiting for approval',
            questions: 'question-box questions',
            replies: 'replies that ask you something',
            threads: 'threads that need a decision',
        });

        const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

        /** What is wrong with a webhook address as it is typed, or '' (the host checks it again before each send). */
        function webhookProblem(text) {
            let url;
            try { url = new URL(text); } catch { return 'That is not a web address: give the whole address, starting with https://'; }
            if (url.protocol === 'https:') return '';
            if (url.protocol === 'http:' && LOOPBACK.includes(url.hostname)) return '';
            return 'The address must start with https:// (http:// only to this machine).';
        }

        /** Decisions' settings on its page in Plugins: the same names and ranges as its config (lib/config.js). */
        const SETTINGS = [
            { name: 'approvals', kind: 'switch', title: 'Tools waiting for approval', hint: 'List a tool that asks to run with more access, with Allow once and Reject.', default: true, group: 'What it lists' },
            { name: 'questions', kind: 'switch', title: 'Questions in the question box', hint: 'List the questions an agent asks in DSH\'s question box, with their choices.', default: true },
            { name: 'replies', kind: 'switch', title: 'Replies that end with a question', hint: 'List a reply that ends by asking you something. Replies with a DECISION NEEDED: or BLOCKED: marker (at a line\'s start, or after a sentence near the end) are listed whatever this says.', default: true },
            { name: 'threads', kind: 'switch', title: 'Threads that need a decision', hint: 'List a coordinator\'s thread that handed back needing a decision, or blocked.', default: true },
            { name: 'windowHours', kind: 'number', title: 'Keep a reply\'s question for, in hours', hint: 'An older reply\'s question leaves the list; the session still has it.', default: 72, min: 1, max: 720 },
            { name: 'notify', kind: 'switch', title: 'A notification for each new card', hint: 'Through DSH\'s notifications, while they run. Questions other plugins raise notify through those plugins.', default: true, group: 'Telling you' },
            { name: 'mirror', kind: 'choice', title: 'Also send new cards to', hint: 'A short note for each new card: to a webhook (such as a chat channel\'s), or to a command of yours.', default: 'off', options: [{ value: 'off', label: 'Nowhere' }, { value: 'webhook', label: 'Webhook' }, { value: 'command', label: 'Command' }], group: 'Somewhere else' },
            {
                name: 'webhookAddress',
                kind: 'secret',
                title: 'Webhook address',
                hint: 'Kept in DSH\'s key store, never in the settings file.',
                setHint: 'Kept in DSH\'s key store, never in the settings file. Leave it empty to keep the one you have.',
                keyFrom: 'mirrorUrlEnv',
                defaultKey: 'DECISIONS_WEBHOOK_URL',
                check: webhookProblem,
                // What happened notes it; the address stays in DSH's key store.
                stored: (change) => api.call('addressChanged', { change }),
                setLabel: 'An address is set',
                envLabel: 'Set where DSH starts',
                unsetLabel: 'No address yet',
                envHint: 'Set in the environment DSH started in, so change it there.',
                removeLabel: 'Remove the address',
            },
            { name: 'mirrorPerHour', kind: 'number', title: 'Messages sent an hour, at most', hint: 'Past this, Decisions holds back and says so once; it still lists everything.', default: 30, min: 1, max: 500 },
        ];
        const SETTINGS_SUMMARY = 'What Decisions lists, whether it notifies you, and where else new cards go.';
        const SETTINGS_NOTE = 'Changes apply as soon as you save. Command runs the program set in DSH\'s profile (mirrorCommand in Decisions\' entry).';

        const CSS = [
            `.${P}-status{margin:10px 0 0;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-lines{margin:8px 0 0;display:flex;flex-direction:column;gap:4px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}`,
            `.${P}-warn{color:var(--${P}-warn)}`,
            `.${P}-card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}`,
            `.${P}-session{font:var(--dsw-font-s-strong-14)}`,
            `.${P}-ask{margin:8px 0 0;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}`,
            `.${P}-lead{font:var(--dsw-font-s-strong-14)}`,
            `.${P}-before{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0}`,
            `.${P}-before>.${P}-quote{align-self:stretch}`,
            `.${P}-rec{margin:6px 0 0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}`,
            `.${P}-rec-label{color:var(--${P}-text-2)}`,
            `.${P}-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);max-height:12em;overflow:auto}`,
            `.${P}-answer{margin-top:10px;display:flex;flex-direction:column;gap:8px;min-width:0}`,
            `.${P}-label{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}`,
            `.${P}-textarea,.${P}-input{box-sizing:border-box;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}`,
            `.${P}-textarea{resize:vertical;min-height:4.5em}`,
            `.${P}-textarea.${P}-textarea-closed{resize:none;min-height:0;height:auto}`,
            `.${P}-textarea::placeholder,.${P}-input::placeholder{color:var(--${P}-text-2)}`,
            `.${P}-question{margin:0;padding:0;border:0;min-width:0;display:flex;flex-direction:column;gap:6px}`,
            `.${P}-legend{padding:0;margin:0 0 2px;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}`,
            `.${P}-option{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary)}`,
            `.${P}-option input{margin:3px 0 0;accent-color:var(--dsw-alias-state-business-primary)}`,
            `.${P}-option-hint{display:block;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-hint{font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-details{margin-top:6px}`,
            `.${P}-details>summary{cursor:pointer;font:var(--dsw-font-xs-13);color:var(--${P}-link);width:max-content;border-radius:var(--dsw-radius-xs)}`,
            `.${P}-details>summary:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px}`,
            `.${P}-log-time{flex:0 0 auto;min-width:64px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-alert[tabindex]:focus{outline:none}`,
            `.${P}-alert[tabindex]:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px}`,
            `@media (max-width:560px){.${P}-item{flex-wrap:wrap}.${P}-item-side{justify-content:flex-start;width:100%}}`,
        ];

        // ── Words ─────────────────────────────────────────────────────

        const listWords = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

        /** What it does not list now, or '' when it lists everything (the summary above already says what that is). */
        function sourcesText(sources) {
            const off = Object.keys(SOURCE_WORDS).filter((k) => sources?.[k] === false).map((k) => SOURCE_WORDS[k]);
            return off.length ? `Not listed, as its settings say: ${listWords(off)}. DECISION NEEDED and BLOCKED lines and other plugins' questions always are.` : '';
        }

        /** What would show while nothing waits: only what it lists now (a kind switched off is left out). */
        function nothingText(sources) {
            const kinds = [
                'a DECISION NEEDED or BLOCKED line',
                sources?.replies !== false ? 'a reply that ends with a question' : '',
                sources?.approvals !== false ? 'a tool that needs approval' : '',
                sources?.questions !== false ? 'a question in the question box' : '',
                sources?.threads !== false ? 'a thread that needs a decision' : '',
                'a plugin\'s question',
            ].filter(Boolean);
            return `When a session asks you something (${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}), it shows here, and you can answer it here.`;
        }

        function notifyText(data, installed) {
            if (!data.notify) return 'Notifications are off in its settings.';
            if (data.notifications) return 'Each new card notifies you.';
            // The log says "not running" either way (the host cannot tell why); the page adds why when it knows.
            return installed === false ? 'Each new card would notify you, but the Notifications plugin is not running: it is not installed. Add it in Plugins to get them.'
                : 'Each new card would notify you, but the Notifications plugin is not running: switch it on in Plugins to get them.';
        }

        /** Where new cards also go, or why they cannot. */
        function mirrorText(m) {
            if (!m || m.mode === 'off') return '';
            if (m.problem) return `New cards cannot go elsewhere: ${String(m.problem).replace(/\.$/, '')}.`;
            const where = m.mode === 'webhook' ? (m.place ? `the webhook at ${m.place}` : 'the webhook') : (m.place || 'your command');
            return `New cards also go to ${where}: ${m.lastHour} of ${m.perHour} this hour.`;
        }

        const WAITS_ON_THIS = 'The session waits on this. Answer here or in the session: the first answer counts.';

        /** "waiting 4 minutes", with the full time for hover and screen readers. */
        function Waited({ at, now }) {
            if (!Number.isFinite(at) || at <= 0) return null;
            const seconds = Math.max(0, ((now ?? Date.now()) - at) / 1000);
            // Rounded as it is shown: 59 minutes 40 seconds reads "1 hour", never "60 minutes".
            return h('time', { className: `${P}-num`, dateTime: new Date(at).toISOString(), title: new Date(at).toLocaleString() }, seconds < 60 ? 'waiting less than a minute' : `waiting ${waitText(seconds)}`);
        }

        /** How long a card has waited: "4 minutes", "1 hour" (never "60 minutes"), "5.5 hours", from two days on in days ("2.5 days"). */
        function waitText(seconds) {
            if (seconds >= 48 * 3600) return `${Math.round(seconds / 43200) / 2} days`;
            return kit.spanText(seconds >= 3570 && seconds < 3600 ? 3600 : seconds);
        }

        /** Where a card comes from, in words, beside its session. */
        function originWords(card) {
            if (card.kind === 'thread' && card.via?.title) return `a thread of “${card.via.title}”`;
            if (card.via?.title) return `in a thread of “${card.via.title}”`;
            if (card.kind === 'ask') return `from ${card.source || 'a plugin'}`;
            if (card.kind === 'question' && card.late) return 'its wait ran out; your answer reaches it as a new message';
            return '';
        }

        // ── Data ──────────────────────────────────────────────────────

        const readState = () => api.read('state');

        /** Do something on the host: `{ value }`, or `{ problem }` in words. */
        async function run(method, args) {
            const result = await api.call(method, args);
            return result.ok ? { value: result.value } : { problem: result.error?.message || 'Decisions did not answer.' };
        }

        /** What an action did, in a line (shown where the person is looking, and read out). */
        function saidText(method, card, value) {
            const where = card?.title ? `“${card.title}”` : 'the session';
            if (method === 'answer') {
                switch (value?.state) {
                    case 'delivered': return `Your answer reached ${where}.`;
                    case 'in the queue': return `Your answer to ${where} waits in its queue. What happened says when the session reads it.`;
                    case 'answered': return value?.text ? `Answered. ${value.text}` : `Answered. ${card?.source || 'The plugin that asked'} carries it out.`;
                    default: return `Sent your answer to ${where}. What happened says when the session has it.`;
                }
            }
            if (method === 'dismiss') return 'Dismissed. It stays under Dismissed if you want it back.';
            if (method === 'undismiss') return 'Brought back.';
            if (method === 'testMirror') return `Test message sent${value?.place ? ` to ${value.place}` : ''}.`;
            return '';
        }

        /** A clock that moves every 30 seconds, so "waiting 4 minutes" stays true. */
        function useNow(ms = 30000) {
            const [now, setNow] = React.useState(() => Date.now());
            React.useEffect(() => {
                const timer = setInterval(() => setNow(Date.now()), ms);
                return () => clearInterval(timer);
            }, [ms]);
            return now;
        }

        // ── Parts ─────────────────────────────────────────────────────

        function useOpener(openSession) {
            return React.useCallback((sessionId) => {
                try { openSession?.(sessionId); } catch (error) { console?.warn?.('dsh-plugin-decisions: could not open the session', error); }
            }, [openSession]);
        }

        function SessionLink({ title, sessionId, onOpen }) {
            if (!sessionId) return h('span', { className: `${P}-session` }, title || 'A plugin');
            return h('button', { type: 'button', className: `${P}-link ${P}-session`, onClick: () => onOpen(sessionId), title: 'Open this session' }, title || 'Untitled session');
        }

        /** Whether the mirror's last send of a new card failed (a test's failure is said where you sent it). */
        const mirrorFailed = (m) => Boolean(m && m.mode !== 'off' && !m.problem && kit.isRecord(m.last) && m.last.ok === false && !m.last.test && !m.last.held && Number.isFinite(m.last.at));

        /** How long "Test message sent" stays under its button: its news is then old. */
        const SENT_SAID_MS = 60000;

        function HeaderCard({ data, busy, act, said, now }) {
            // "Test message sent" stays only until a newer send says more, or for a minute; a failure until then.
            const last = data.mirror?.last;
            const stale = !said?.failed && Number.isFinite(said?.at) && Number.isFinite(now) && now - said.at >= SENT_SAID_MS;
            const testSaid = said?.where === 'mirror' && Boolean(said.text) && !stale && !(kit.isRecord(last) && !last.test && Number.isFinite(said.at) && last.at > said.at);
            const waiting = data.waiting.length;
            const urgent = data.waiting.filter((c) => c.answer === 'approval' || c.live === true || ((c.kind === 'approval' || c.kind === 'question') && c.running === true)).length;
            // With nothing waiting, the list's own empty state says so: said once.
            const status = !data.enabled ? TEXT.disabled
                : waiting === 0 ? ''
                    : [`${waiting} waiting on you`, urgent ? `${urgent} holding a running turn` : ''].filter(Boolean).join(' · ');
            const mirror = mirrorText(data.mirror);
            const canOpen = kit.canOpenPlugin();
            // Not running: installed and switched off (a button to it), or not installed at all (no button to nowhere).
            const notesInstalled = useInstalled(NOTIFICATIONS_PACKAGE, data.enabled && data.notify && !data.notifications);
            return h(kit.Card, {
                title: TEXT.title,
                headingLevel: 1,
                main: true,
                sub: TEXT.summary,
                actions: canOpen ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => kit.openPlugin(BUNDLE) }, TEXT.settings) : null,
                attrs: { 'data-decisions-header': data.enabled ? 'on' : 'off' },
            },
            status ? h('p', { className: `${P}-status` }, status) : null,
            data.enabled ? h('div', { className: `${P}-lines` },
                sourcesText(data.sources) ? h('div', { className: `${P}-line`, 'data-decisions-sources': '' }, sourcesText(data.sources)) : null,
                h('div', { className: `${P}-line`, 'data-decisions-notify': data.notify ? (data.notifications ? 'on' : notesInstalled === false ? 'not installed' : 'not running') : 'off' },
                    h('span', null, notifyText(data, notesInstalled)),
                    data.notify && !data.notifications && notesInstalled !== false && canOpen
                        ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => kit.openPlugin(NOTIFICATIONS_PACKAGE) }, 'Open Notifications in Plugins') : null),
                mirror ? h('div', { className: `${P}-line${data.mirror.problem ? ` ${P}-warn` : ''}`, 'data-decisions-mirror': data.mirror.problem ? 'problem' : data.mirror.mode },
                    h('span', null, mirror),
                    data.mirror.problem
                        // The command lives only in DSH's profile, which its words name; the rest is in the settings form.
                        ? (canOpen && data.mirror.mode !== 'command' ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => kit.openPlugin(BUNDLE) }, 'Open Decisions\' settings') : null)
                        // Not disabled while busy, so the focus stays on it for the line under it that says how the test went.
                        : h(ui.Button, { variant: 'ghost', size: 'sm', 'aria-disabled': busy ? 'true' : undefined, 'data-decisions-test': '', onClick: () => { if (!busy) void act('testMirror', {}); } }, 'Send a test')) : null,
                mirrorFailed(data.mirror) ? h('div', { className: `${P}-line ${P}-warn`, 'data-decisions-mirror-failed': '' },
                    h('span', null, `The last new card was not sent: ${String(data.mirror.last.reason ?? 'it failed').replace(/\.$/, '')} (`, h(kit.TimeText, { at: data.mirror.last.at }), ').')) : null,
                // How the test went, under its button: sent, or why not (a failure is an alert, in the warning colour).
                mirror ? h('div', { className: testSaid ? `${P}-line ${said.failed ? `${P}-warn` : `${P}-ok`}` : `${P}-sr`, role: testSaid && said.failed ? 'alert' : 'status', 'aria-live': testSaid && said.failed ? 'assertive' : 'polite', 'data-decisions-test-said': testSaid ? (said.failed ? 'failed' : 'sent') : '' }, testSaid ? said.text : '') : null) : null,
            // Session Watch's own wrong setting: it works on with its default, and the button puts the cursor in it.
            data.watchProblem ? h('div', { className: `${P}-lines`, 'data-decisions-watch-problem': '' },
                h('div', { className: `${P}-line ${P}-warn` },
                    h('span', null, `Session Watch uses its default for a wrong setting: ${String(data.watchProblem.text).replace(/\.$/, '')}. ${data.watchProblem.live === false
                        ? 'Change it in Session Watch\'s entry in DSH\'s profile (cordis.patch.yml). DSH applies the file when you save it.'
                        : 'Change it in Session Watch\'s settings in Plugins.'}`),
                    canOpen && data.watchProblem.live !== false
                        ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => kit.openPlugin(WATCH_BUNDLE, { focus: data.watchProblem.key }) }, 'Open Session Watch\'s settings') : null)) : null);
        }

        function ApprovalAnswer({ card, busy, answer }) {
            return h('div', { className: `${P}-actions`, style: { marginTop: '10px' } },
                h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void answer({ decision: 'allow' }) }, 'Allow once'),
                h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => void answer({ decision: 'reject' }) }, 'Reject'));
        }

        const domId = (text) => String(text).replace(/[^A-Za-z0-9_-]/g, '_');

        function TextAnswer({ card, busy, answer }) {
            const [text, setText] = React.useState('');
            // One line until you start answering; then room to write (it stays open, so no button moves under the pointer).
            const [open, setOpen] = React.useState(false);
            const id = `${P}-answer-${domId(card.id)}`;
            const send = () => { if (text.trim()) void answer({ text }).then((ok) => { if (ok) setText(''); }); };
            return h('div', { className: `${P}-answer` },
                h('label', { className: `${P}-label`, htmlFor: id }, 'Your answer'),
                h('textarea', {
                    id,
                    className: `${P}-textarea${open || text ? '' : ` ${P}-textarea-closed`}`,
                    rows: open || text ? 3 : 1,
                    value: text,
                    disabled: busy,
                    onFocus: () => setOpen(true),
                    placeholder: card.recommendation ? 'Write your answer, or go with the recommendation' : 'Write your answer',
                    onChange: (event) => setText(event.target.value),
                    onKeyDown: (event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault();
                            send();
                        }
                    },
                }),
                h('div', { className: `${P}-actions` },
                    h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy || !text.trim(), onClick: send }, 'Send'),
                    card.recommendation ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => void answer({ recommended: true }) }, 'Go with the recommendation') : null,
                    h('span', { className: `${P}-hint` }, card.running ? 'The session is running: your answer steers its current turn.'
                        : card.kind === 'thread' ? 'It goes into the thread as your next message.' : 'It goes into the session as your next message.')));
        }

        function QuestionsAnswer({ card, busy, answer }) {
            const [picked, setPicked] = React.useState({});
            const [own, setOwn] = React.useState({});
            const questions = card.questions ?? [];
            const toggle = (q, label) => setPicked((was) => {
                const now = was[q.id] ?? [];
                return { ...was, [q.id]: q.multiSelect ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label] };
            });
            const answers = questions.map((q) => ({ id: q.id, selected: picked[q.id] ?? [], ...(own[q.id]?.trim() ? { custom: own[q.id].trim() } : {}) }));
            const ready = answers.some((a) => a.selected.length > 0 || a.custom);
            return h('div', { className: `${P}-answer` },
                ...questions.map((q, i) => h('fieldset', { key: q.id, className: `${P}-question` },
                    h('legend', { className: `${P}-legend` }, q.header ? `${q.header}: ${q.question}` : q.question),
                    q.detail ? h('p', { className: `${P}-why` }, q.detail) : null,
                    ...(q.options ?? []).map((o) => h('label', { key: o.label, className: `${P}-option` },
                        h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `${P}-q-${domId(card.id)}-${i}`, checked: (picked[q.id] ?? []).includes(o.label), disabled: busy, onChange: () => toggle(q, o.label) }),
                        h('span', null, o.label, o.description ? h('span', { className: `${P}-option-hint` }, o.description) : null))),
                    h('input', { type: 'text', className: `${P}-input`, 'aria-label': `Your own answer to: ${q.question}`, placeholder: 'Or write your own answer', value: own[q.id] ?? '', disabled: busy, onChange: (event) => setOwn((was) => ({ ...was, [q.id]: event.target.value })) }))),
                h('div', { className: `${P}-actions` },
                    h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy || !ready, onClick: () => void answer({ answers }) }, questions.length > 1 ? 'Send answers' : 'Send answer'),
                    questions.length > 1 ? h('span', { className: `${P}-hint` }, 'A question you leave blank is skipped.') : null));
        }

        function AskAnswer({ card, busy, answer }) {
            const [text, setText] = React.useState('');
            const [open, setOpen] = React.useState(false);
            const id = `${P}-answer-${domId(card.id)}`;
            return h('div', { className: `${P}-answer` },
                (card.options ?? []).length ? h('div', { className: `${P}-actions` },
                    ...card.options.map((o, i) => h(ui.Button, { key: o.id, variant: i === 0 ? 'primary' : 'outline', size: 'sm', disabled: busy, onClick: () => void answer({ option: o.id }) }, o.label))) : null,
                card.freeText ? [
                    h('label', { key: 'l', className: `${P}-label`, htmlFor: id }, (card.options ?? []).length ? 'Or answer in your words' : 'Your answer'),
                    h('textarea', { key: 't', id, className: `${P}-textarea${open || text ? '' : ` ${P}-textarea-closed`}`, rows: open || text ? 2 : 1, value: text, disabled: busy, onFocus: () => setOpen(true), onChange: (event) => setText(event.target.value) }),
                    h('div', { key: 'a', className: `${P}-actions` }, h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy || !text.trim(), onClick: () => void answer({ text }) }, 'Send')),
                ] : null);
        }

        /** The reply's lines before its question, folded after two: what the question is about. */
        function ReplyBefore({ text }) {
            const [open, setOpen] = React.useState(false);
            const lines = String(text).split('\n');
            const more = lines.length - 2;
            return h('div', { className: `${P}-before`, 'data-decisions-context': '' },
                h('p', { className: `${P}-quote` }, open || more <= 0 ? lines.join('\n') : lines.slice(0, 2).join('\n')),
                more > 0 ? h(ui.Button, { variant: 'ghost', size: 'sm', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen(!open) },
                    open ? 'Show less of the reply' : `Show ${more} more line${more === 1 ? '' : 's'} of the reply`) : null);
        }

        /** One thing waiting on you, with the controls its kind takes. */
        function DecisionCard({ card, onOpen, act, busyId, now }) {
            const [failure, setFailure] = React.useState(undefined);
            const alertRef = React.useRef(null);
            const busy = busyId === card.id || card.sending === true;
            const shown = failure || card.error;
            React.useEffect(() => { if (shown) alertRef.current?.focus?.(); }, [shown]);
            const answer = async (input) => {
                setFailure(undefined);
                const problem = await act('answer', { id: card.id, answer: input }, card);
                if (problem) setFailure(problem);
                return !problem;
            };
            const origin = originWords(card);
            const asksInForm = card.answer === 'questions';
            let controls = null;
            if (card.answer === 'approval') controls = h(ApprovalAnswer, { card, busy, answer });
            else if (card.answer === 'questions') controls = h(QuestionsAnswer, { card, busy, answer });
            else if (card.answer === 'text') controls = h(TextAnswer, { card, busy, answer });
            else if (card.answer === 'ask') controls = h(AskAnswer, { card, busy, answer });
            else if (card.sessionId) {
                controls = h('div', { className: `${P}-actions`, style: { marginTop: '10px' } },
                    h(ui.Button, { variant: 'primary', size: 'sm', onClick: () => onOpen(card.sessionId) }, 'Answer in the session'),
                    h('span', { className: `${P}-hint` }, card.hint || (card.kind === 'approval' ? 'Decisions was not holding this request when DSH asked, so answer it in the session.' : 'Only the session can take this answer.')));
            }
            return h('li', { className: `${P}-item`, 'data-decisions-card': card.kind, 'data-decisions-id': card.id },
                h('div', { className: `${P}-item-main` },
                    h('div', { className: `${P}-card-top` },
                        h(kit.StateTag, { word: wordOf(card) }),
                        h(SessionLink, { title: card.title, sessionId: card.sessionId, onOpen }),
                        h('span', { className: `${P}-meta` }, origin ? `${origin} · ` : '', h(Waited, { at: card.at, now }))),
                    asksInForm ? null : h('p', { className: `${P}-ask` }, card.head ? [h('span', { key: 'h', className: `${P}-lead` }, card.head), ' ', card.question] : card.question),
                    card.context && !asksInForm ? h(ReplyBefore, { text: card.context }) : null,
                    card.more && !asksInForm ? h('p', { className: `${P}-why` }, `And ${card.more} more question${card.more === 1 ? '' : 's'}.`) : null,
                    card.recommendation ? h('p', { className: `${P}-rec`, 'data-decisions-recommendation': '' }, h('span', { className: `${P}-rec-label` }, 'Recommended: '), card.recommendation) : null,
                    card.what ? h('p', { className: `${P}-quote ${P}-code` }, card.what) : null,
                    card.detail ? h('p', { className: `${P}-why` }, card.detail) : null,
                    card.lines?.length ? h('details', { className: `${P}-details` }, h('summary', null, 'More about the call'), h('p', { className: `${P}-quote` }, card.lines.join('\n'))) : null,
                    // A question box's questions are in its controls: they come first, then what the session waits on.
                    (card.answer === 'approval' || card.live) && !asksInForm ? h('p', { className: `${P}-why` }, WAITS_ON_THIS) : null,
                    controls,
                    card.live && asksInForm ? h('p', { className: `${P}-why` }, WAITS_ON_THIS) : null,
                    shown ? h('p', { className: `${P}-alert`, role: 'alert', tabIndex: -1, ref: alertRef, 'data-decisions-error': '' }, /^Not /.test(String(shown)) ? String(shown) : `Not sent: ${shown}`) : null,
                    card.sending ? h(kit.Loading, { text: 'Sending your answer' }) : null),
                h('div', { className: `${P}-item-side` },
                    h(ui.Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void act('dismiss', { id: card.id }, card) }, 'Dismiss')));
        }

        /**
         * What your last answer did, kept true: once the log shows the session
         * has it, the line says so; when it failed, the card itself says why;
         * after two minutes it goes. `warn` when an answer typed into a
         * coding agent's terminal is not in its transcript.
         */
        function saidLine(said, data, now) {
            if (said?.where !== 'list' || !said.text) return { text: '' };
            if (Number.isFinite(said.at) && (now ?? Date.now()) - said.at > 120000) return { text: '' };
            if (!said.cardId) return { text: said.text };
            const entry = (data.history ?? []).find((e) => e.kind === 'answer' && e.cardId === said.cardId);
            const terminal = said.title ? `“${said.title}”'s terminal` : 'its terminal';
            // A plugin's question is "answered" when the plugin took the answer; it reached its agent only once that is proven.
            if (entry?.state === 'delivered' || (entry?.state === 'answered' && entry.cardKind !== 'ask')) return { text: said.title ? `Your answer reached “${said.title}”.` : 'Your answer reached the session.' };
            if (entry?.state === 'typed in') return { text: `Your answer was typed into ${terminal}.` };
            if (entry?.state === 'not confirmed' && entry.cardKind === 'ask') return { text: `Your answer was typed into ${terminal}, but its transcript has not shown it: look at its terminal.`, warn: true };
            if (entry && ['not delivered', 'not confirmed', 'failed'].includes(entry.state)) return { text: '' };
            return { text: said.text };
        }

        function WaitingCard({ data, onOpen, act, busyId, now, said }) {
            const { text: shown, warn } = saidLine(said, data, now);
            const line = React.useRef(null);
            const acted = React.useRef(0);
            React.useEffect(() => { if (shown) acted.current = Date.now(); }, [said?.n]);
            // The card you answered leaves the list a moment later: the keyboard goes to the line that says what happened, not to the page's top.
            React.useEffect(() => {
                if (!acted.current || Date.now() - acted.current > 5000 || typeof document === 'undefined') return;
                const at = document.activeElement;
                if (at && at !== document.body && at.isConnected) return;
                acted.current = 0;
                line.current?.focus?.({ preventScroll: true });
            });
            return h(kit.Card, { title: TEXT.waiting, main: true, attrs: { 'data-decisions-waiting': String(data.waiting.length) } },
                // What your last answer did, said where you are looking (and to screen readers).
                h('p', { ref: line, tabIndex: -1, className: shown ? `${P}-note ${warn ? `${P}-warn` : `${P}-ok`}` : `${P}-sr`, role: 'status', 'aria-live': 'polite', 'data-decisions-said': '' }, shown),
                data.waiting.length === 0
                    ? h(kit.Empty, { title: TEXT.nothing, text: nothingText(data.sources) })
                    : h('ul', { className: `${P}-list` }, ...data.waiting.map((card) => h(DecisionCard, { key: card.id, card, onOpen, act, busyId, now }))));
        }

        function DismissedCard({ data, onOpen, act, busyId }) {
            if (data.dismissed.length === 0) return null;
            return h(kit.Card, { title: `${TEXT.dismissed} (${data.dismissed.length})`, sub: TEXT.dismissedSub, attrs: { 'data-decisions-dismissed': '' } },
                h('details', { className: `${P}-details` }, h('summary', null, 'Show them'),
                    h('ul', { className: `${P}-list` }, ...data.dismissed.map((card) => h('li', { key: card.id, className: `${P}-item`, 'data-decisions-dismissed-id': card.id },
                        h('div', { className: `${P}-item-main` },
                            h('div', { className: `${P}-card-top` }, h(kit.StateTag, { word: wordOf(card) }), h(SessionLink, { title: card.title, sessionId: card.sessionId, onOpen })),
                            h('p', { className: `${P}-why` }, card.question)),
                        h('div', { className: `${P}-item-side` },
                            h(ui.Button, { variant: 'outline', size: 'sm', disabled: busyId === card.id, onClick: () => void act('undismiss', { id: card.id }, card) }, 'Bring back')))))));
        }

        function HistoryRow({ entry, onOpen }) {
            const state = entry.state && entry.state !== 'done' ? entry.state : '';
            const failed = state === 'not delivered' || state === 'not sent';
            return h('li', { className: `${P}-item`, 'data-decisions-entry': entry.kind },
                h('span', { className: `${P}-log-time` }, h(kit.TimeText, { at: entry.at })),
                h('div', { className: `${P}-item-main` },
                    h('div', null,
                        entry.sessionId ? h(SessionLink, { title: entry.title || 'Untitled session', sessionId: entry.sessionId, onOpen }) : null,
                        entry.sessionId ? h('span', { className: `${P}-meta` }, ' · ') : null,
                        h('span', null, entry.text),
                        entry.by === 'you' ? h('span', { className: `${P}-meta` }, ' · You') : null),
                    entry.question ? h('div', { className: `${P}-meta` }, entry.kind === 'answer' ? `To: ${entry.question}` : entry.question) : null,
                    entry.why ? h('div', { className: `${P}-why` }, `Why: ${entry.why}`) : null,
                    entry.reason ? h('div', { className: `${P}-why${failed ? ` ${P}-error` : ''}` }, `${failed ? `${state[0].toUpperCase()}${state.slice(1)}: ` : ''}${String(entry.reason).replace(/\.$/, '')}.`) : null,
                    entry.note ? h('details', { className: `${P}-details` }, h('summary', null, TEXT.sent), h('p', { className: `${P}-quote` }, entry.note)) : null),
                state ? h('div', { className: `${P}-item-side` }, h(kit.StateTag, { word: state })) : null);
        }

        function HistoryCard({ data, onOpen }) {
            const [all, setAll] = React.useState(false);
            const shown = all ? data.history : data.history.slice(0, 30);
            return h(kit.Card, { title: TEXT.history, sub: TEXT.historySub, attrs: { 'data-decisions-history': '' } },
                data.history.length === 0 ? h(kit.Empty, { title: TEXT.noHistory, text: TEXT.noHistoryText })
                    : [
                        h('ul', { key: 'l', className: `${P}-list` }, ...shown.map((entry) => h(HistoryRow, { key: entry.id, entry, onOpen }))),
                        data.history.length > shown.length ? h('div', { key: 'm', style: { marginTop: '8px' } }, h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setAll(true) }, `Show all ${data.history.length}`)) : null,
                    ]);
        }

        function DecisionsPage({ decisions }) {
            const live = kit.useLive(readState, ['decisions', 'sessions', 'asks', 'settings'], { delayMs: 300 });
            const now = useNow();
            const [busyId, setBusyId] = React.useState(undefined);
            const [failure, setFailure] = React.useState(undefined);
            const [said, setSaid] = React.useState({ text: '', where: '', n: 0 });
            const onOpen = useOpener(decisions?.openSession);
            /**
             * Answer, dismiss, bring back or test. A card shows its own failure
             * (the answer's words come back to it); the others show under the
             * header. What it did is said where the person is looking.
             */
            const act = React.useCallback(async (method, args, card) => {
                setBusyId(card?.id ?? method);
                setFailure(undefined);
                const { problem, value } = await run(method, args);
                setBusyId(undefined);
                // A failed test is said under its button, in the header; other failures under the header.
                if (problem && method === 'testMirror') setSaid((was) => ({ text: /^Not /.test(problem) ? problem : `Not sent: ${problem}`, where: 'mirror', failed: true, n: was.n + 1, at: Date.now() }));
                else if (problem && method !== 'answer') setFailure(problem);
                if (!problem) setSaid((was) => ({ text: saidText(method, card, value), where: method === 'testMirror' ? 'mirror' : 'list', n: was.n + 1, at: Date.now(), ...(method === 'answer' && card?.id ? { cardId: card.id, title: card.title ?? '' } : {}) }));
                void live.refresh();
                return problem;
            }, [live.refresh]);
            const data = live.data;
            // Not running (or Session Watch is off): old data would mislead, so the page says why and what to do.
            const down = live.code === 'not-running' || (data === undefined && live.error);
            // What a test or a failed action said is about the page as it was: once the page goes down (and says why),
            // neither is said again when it comes back.
            React.useEffect(() => {
                if (!down) return;
                setSaid((was) => (was.where === 'mirror' ? { text: '', where: '', n: was.n + 1 } : was));
                setFailure(undefined);
            }, [Boolean(down)]);
            return h(kit.Page, { label: TEXT.title, attrs: { 'data-decisions-page': '' } },
                down
                    ? h(kit.Card, { title: TEXT.title, headingLevel: 1, main: true, sub: TEXT.summary },
                        h(kit.Trouble, { name: 'Decisions', packageName: BUNDLE, code: live.code, text: live.error, onRetry: live.refresh }))
                    : data === undefined
                        ? h(kit.Card, { title: TEXT.title, headingLevel: 1, main: true }, h(kit.Loading, { text: TEXT.loading }))
                        : data.problem
                            ? [
                                h(kit.Card, { key: 'head', title: TEXT.title, headingLevel: 1, main: true, sub: TEXT.summary, attrs: { 'data-decisions-header': 'problem' } },
                                    h(kit.SettingsProblem, { name: 'Decisions', packageName: BUNDLE, problem: data.problem, profileApplies: true })),
                                h(HistoryCard, { key: 'history', data, onOpen }),
                            ]
                            : [
                                h(HeaderCard, { key: 'head', data, busy: busyId !== undefined, act, said, now }),
                                live.error ? h(kit.ErrorLine, { key: 'refresh', text: live.error, onRetry: live.refresh }) : null,
                                failure ? h('p', { key: 'act', className: `${P}-alert`, role: 'alert', 'data-decisions-failure': '' }, /^Not /.test(failure) ? failure : `Not done: ${failure}`) : null,
                                data.enabled ? h(WaitingCard, { key: 'waiting', data, onOpen, act, busyId, now, said }) : null,
                                data.enabled ? h(DismissedCard, { key: 'dismissed', data, onOpen, act, busyId }) : null,
                                h(HistoryCard, { key: 'history', data, onOpen }),
                            ]);
        }

        /** The panel entry's glyph, with the count of what waits on you. */
        function DecisionsIcon({ size = 16 }) {
            const live = kit.useLive(() => api.read('badge'), ['decisions', 'asks', 'settings'], { delayMs: 500 });
            const down = live.code === 'not-running' || live.data?.off === true;
            const waiting = down ? 0 : live.data?.waiting ?? 0;
            return h('span', { className: `${P}-icon`, 'data-decisions-icon': down ? 'off' : String(waiting) },
                h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: down ? { opacity: 0.55 } : undefined },
                    h('path', { d: 'M4 13.5 6.2 6.4A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.4L20 13.5' }),
                    h('path', { d: 'M4 13.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5h-4.5l-1.2 2h-4.6l-1.2-2Z' })),
                waiting > 0 ? h('span', { className: `${P}-badge` }, waiting > 9 ? '9+' : String(waiting)) : null,
                waiting > 0 ? h('span', { className: `${P}-sr` }, `${waiting} waiting on you`) : null);
        }

        const inject = ['slots'];

        function apply(ctx) {
            try {
                kit.injectStyle(CSS);
            } catch (error) {
                console?.warn?.('dsh-plugin-decisions: style:', error);
            }
            ctx.effect?.(() => () => kit.removeStyle(), 'decisions: style');
            ctx.inject(['connection'], (scope) => scope.effect(() => {
                kit.setConnection(scope.connection);
                const detach = kit.hub.attach();
                return () => {
                    detach();
                    kit.setConnection(undefined);
                };
            }, 'decisions: connection'));
            ctx.inject(['uiWorkspace'], (scope) => applyViews(scope));
            // DSH's Plugins page: the buttons that open Decisions' (or Session Watch's) switch and settings.
            ctx.inject(['pluginNavigation'], (scope) => {
                kit.setNavigation(scope.pluginNavigation);
                return () => kit.setNavigation(undefined);
            });
            // Its settings on its page in Plugins, through DSH's own settings form; the webhook address through DSH's key store.
            ctx.inject(['configForms', 'remote', 'remote.session', 'remote.credentials'], (scope) => {
                try {
                    kit.applySettings(scope, { entry: 'decisions', name: 'Decisions', summary: SETTINGS_SUMMARY, fields: SETTINGS, note: SETTINGS_NOTE });
                } catch (error) {
                    console?.warn?.('dsh-plugin-decisions: settings:', error);
                }
            });
        }

        /** The page and its sidebar entry, once DSH's workspace (which opens sessions) is there. */
        function applyViews(ctx) {
            const decisions = {
                openSession(sessionId) {
                    if (typeof sessionId !== 'string' || sessionId === '') return;
                    try { ctx.uiWorkspace.openSession(sessionId); } catch (error) { console?.warn?.('dsh-plugin-decisions: could not open the session', error); }
                },
            };
            const withApi = () => ({ decisions });
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PAGE, inject: withApi }, DecisionsPage));
            // After Plugins (0), before Autopilot (3), Agent Terminals (4) and Categories (6).
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PAGE, order: 2, label: TEXT.entry }, DecisionsIcon));
        }

        module.exports.inject = inject;
        module.exports.apply = apply;
        // For the plugin's own tests.
        module.exports.internals = { kit, TEXT, KIND_WORD, CSS, SETTINGS, SETTINGS_SUMMARY, SETTINGS_NOTE, wordOf, sourcesText, nothingText, notifyText, mirrorText, webhookProblem, originWords, waitText, Waited, DecisionsPage, DecisionsIcon, DecisionCard, HeaderCard, WaitingCard, HistoryCard, DismissedCard };
        return module.exports;
    },
});
