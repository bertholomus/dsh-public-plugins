/**
 * dsh-plugin-canon, browser half: Canon's card after a turn it added notes
 * to, its page in DSH's sidebar, and its settings.
 *
 * - The card (`conversation.chat.turnTail`, order 45): after the latest
 *   turn of a session that got notes from the canon vault, which notes
 *   (title and folder), with "Turn off for this session" (or "Turn back
 *   on") and the way to Canon's page. DSH's Chat keeps the block itself out
 *   of sight (its Trajectory tab lists it), and Canon's page lists each
 *   session's recent turns that got notes, so older turns get no card.
 * - The entry in DSH's panel list (`sidebar.panellist`, order 8) and the
 *   page in `main`: the vault and what Canon may do with it, a try-out
 *   that shows what a prompt would get and why, the sessions that got
 *   notes with a switch for each, the drafts agents saved with Promote,
 *   and what happened.
 * - Its settings on its page in Plugins (DSH's `plugins.bundle.config`),
 *   saved through DSH's own settings form.
 *
 * Hand-written in the module format DSH serves to the browser (no build
 * step). Nothing here may throw at load: DSH joins every plugin's browser
 * half into one script, and one error would stop the others.
 *
 * @module dsh-plugin-canon/client
 */
// DSH serves browser halves in one script; never throw here, or the others stop loading too.
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-canon',
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

        const BUNDLE = 'dsh-plugin-canon';
        const PAGE = `${BUNDLE}:page`;
        const kit = suiteKit({ prefix: 'dshcn', bundle: BUNDLE, React, ui, h });
        const P = kit.P;
        const api = kit.link(BUNDLE, { name: 'Canon' });
        /** The projection the host registers (lib/projection.js KEY). */
        const KEY = 'canonRecall';
        /** The hub channel Canon's host moves when what its page shows changes. */
        const CHANNELS = ['canon'];

        const TEXT = {
            entry: 'Canon',
            title: 'Canon',
            summary: 'Shared long-term notes from your Obsidian canon vault. When a turn starts from your prompt, Canon adds the few active notes that fit it and the session\'s folder, as a short block that cites each note.',
            disabled: 'Canon is switched off in DSH\'s profile (enabled: false in its entry in cordis.patch.yml), so it reads no vault. To use it, set enabled to true there and restart DSH. Switching it off in Plugins instead also takes this page away; it stays installed either way.',
            loading: 'Reading Canon',
            noVault: 'No vault yet',
            noVaultText: 'Set “Vault folder” in Canon\'s settings to your Obsidian vault\'s folder, such as ~/Obsidian/Canon. Canon only reads it unless you allow drafts.',
            settingsSaved: 'Saved.',
            emptyVault: 'This folder has no notes: no Markdown (.md) file in it or the folders inside it. Is it your vault? If not, change “Vault folder” in Canon\'s settings.',
            tryTitle: 'Try a prompt',
            trySub: 'See which notes a prompt would get, and why, without sending it.',
            readQuestion: 'Read as a question.',
            noFit: 'A turn with it gets no notes.',
            readCoding: 'Read as a coding request: it asks for work on code, or speaks of “this function” or “my script”.',
            noFitQuestion: 'A turn with it gets no notes. A note fits a question when it shares two words with it (a project\'s name counts as one). One word is enough when it is all the prompt asks beyond everyday request words like “run” or “test”, in the note\'s title, tags, aliases or headings, or in its body when few notes have it or the body has it twice. One word in the note\'s title, tags, aliases or headings is also enough when few notes have it, the prompt shares no rarer word with the vault and has no word the vault lacks; and one in its body beside a project the prompt or this folder names, when few notes have it or the body has it twice. An everyday request word is enough alone only when it is all the prompt asks. A question that names something no note has, as “Kafka” or “CORS”, needs three words in common, or a note of a project it or this folder names. A term a list in the note defines counts as one of its aliases.',
            noFitCoding: 'A turn with it gets no notes. A note fits a coding request when the words it shares with it, beyond everyday request words like “write”, “fix” and “test”, carry enough of what it asks, rare words weighing most: a third when one is in the note\'s title, tags, aliases or headings, 45% when none is. It also fits when the request works on what the note is titled for and the note is a project\'s the prompt or this folder names, as “Add a route…” and Routing rules.',
            sessions: 'Sessions that got notes',
            sessionsSub: 'Newest first. Switch one off and its later turns get no notes.',
            noSessions: 'No notes added yet',
            noSessionsText: 'When a turn starts from your prompt and active notes fit it, Canon adds them and lists the session here. Try a prompt above to see what one would get.',
            drafts: 'Drafts',
            history: 'What happened',
            historySub: 'Newest first: drafts saved, promoted and discarded, switches, settings and the vault.',
            noHistory: 'Nothing yet',
            noHistoryText: 'Drafts agents save, drafts you promote or discard, sessions you switch off and setting changes show here.',
            settings: 'Settings',
        };

        /** The kinds of note an agent may save (lib/drafts.js KINDS), in words. */
        const KIND_WORD = Object.freeze({ decision: 'decision', fact: 'fact', howto: 'how-to', gotcha: 'gotcha' });

        /** Canon's settings on its page in Plugins: the same names, defaults and ranges as its config (lib/config.js). */
        const FOLDER = /^[\p{L}\p{N} _().,'&+-]+(?:\/[\p{L}\p{N} _().,'&+-]+)*$/u;
        const folderOk = (t) => FOLDER.test(t) && t.split('/').every((part) => !part.startsWith('.') && part.trim() === part);
        /**
         * What a vault folder that is a full path, or one starting with ~/, is not, as the profile refuses it
         * (lib/config.js checkConfig): '/' is the whole disk and '~' or '~/' the home folder.
         */
        const notAVault = (t) => {
            const home = t.startsWith('~');
            const parts = [];
            for (const part of (home ? t.slice(1) : t).split('/')) {
                if (part === '' || part === '.') continue;
                if (part !== '..') parts.push(part);
                else if (parts.length > 0 && parts.at(-1) !== '..') parts.pop();
                else if (home) parts.push(part);
            }
            if (parts.length > 0) return '';
            return home ? 'your home folder' : 'the whole disk';
        };
        let notThat = '';
        const SETTINGS = [
            {
                name: 'vault',
                kind: 'text',
                title: 'Vault folder',
                hint: 'Your Obsidian vault\'s folder: a full path, or one starting with ~/. Canon reads its notes; it never reads DSH\'s own folder.',
                default: '',
                accepts: (t) => {
                    notThat = '';
                    if (!t.startsWith('/') && t !== '~' && !t.startsWith('~/')) return false;
                    notThat = notAVault(t);
                    return notThat === '';
                },
                get invalid() {
                    return notThat
                        ? `The vault's own folder, not ${notThat}: a full path, such as /Users/you/Canon, or one starting with ~/, such as ~/Obsidian/Canon.`
                        : 'A full path, such as /Users/you/Canon, or one starting with ~/, such as ~/Obsidian/Canon.';
                },
                group: 'Vault',
            },
            {
                name: 'access',
                kind: 'choice',
                title: 'What Canon may write',
                hint: 'Read only: nothing, ever. Drafts: agents may save new draft notes in the drafts folder, and Discard on Canon\'s page moves one to the vault\'s .trash; drafts are never added to turns.',
                default: 'read-only',
                options: [{ value: 'read-only', label: 'Read only' }, { value: 'drafts', label: 'Drafts' }],
            },
            {
                name: 'draftsFolder',
                kind: 'text',
                title: 'Drafts folder',
                hint: 'A folder inside the vault, such as Drafts or Canon/Drafts. Its notes are never added to turns.',
                default: 'Drafts',
                accepts: folderOk,
                invalid: 'A folder inside the vault: letters, digits and spaces, parts joined by /, none starting with a dot.',
            },
            {
                name: 'promote',
                kind: 'switch',
                title: 'Allow promoting drafts',
                hint: 'Promote on a draft (on Canon\'s page) makes it an active note. Off, Promote changes nothing. Needs Drafts above.',
                default: false,
                group: 'Promoting',
            },
            {
                name: 'promoteFolder',
                kind: 'text',
                title: 'Promoted notes go to',
                hint: 'A folder inside the vault, outside the drafts folder. Empty: the vault\'s top level.',
                default: '',
                accepts: folderOk,
                invalid: 'A folder inside the vault, outside the drafts folder: letters, digits and spaces, parts joined by /, none starting with a dot.',
            },
            { name: 'recall', kind: 'switch', title: 'Add notes to turns', hint: 'Before a turn that starts from your prompt, add the active notes that fit it. Off, Canon adds nothing anywhere.', default: true, group: 'Turns' },
            { name: 'maxNotes', kind: 'number', title: 'Notes a turn, at most', hint: 'From 1 to 10.', default: 3, min: 1, max: 10 },
            { name: 'maxChars', kind: 'number', title: 'Characters a turn, at most', hint: 'From 400 to 8000: the whole block, notes and citations included.', default: 2000, min: 400, max: 8000 },
        ];
        /** Whether a folder inside the vault is `folder` or inside it (without case, as Canon checks it). */
        const insideOf = (inner, folder) => {
            const a = inner.toLowerCase();
            const b = folder.toLowerCase();
            return a === b || a.startsWith(`${b}/`);
        };
        /**
         * The form's fields, with the one rule that needs another setting: promoted notes go outside the drafts
         * folder (as saved), refused in Canon's own words (lib/config.js checkConfig). Both changed at once, Canon
         * still checks them on Save and its page says which to change.
         * @param {() => unknown} draftsNow - the drafts folder as saved.
         */
        function settingsFields(draftsNow) {
            const fallback = SETTINGS.find((f) => f.name === 'draftsFolder').default;
            const drafts = () => {
                const value = draftsNow();
                const text = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : '';
                return text && folderOk(text) ? text : fallback;
            };
            let inside = '';
            return SETTINGS.map((f) => (f.name !== 'promoteFolder' ? f : {
                ...f,
                accepts: (text) => {
                    inside = '';
                    if (!folderOk(text)) return false;
                    const folder = drafts();
                    if (insideOf(text, folder)) {
                        inside = folder;
                        return false;
                    }
                    return true;
                },
                get invalid() {
                    return inside ? `Must be outside the drafts folder (${inside}): notes there are never added to turns. Leave it empty for the vault's top level.` : f.invalid;
                },
            }));
        }
        const SETTINGS_SUMMARY = 'Which vault Canon reads, what it may write there, and how much it adds to a turn.';
        const SETTINGS_NOTE = 'Changes apply as soon as you save. Canon never promotes a draft by itself: a person presses Promote on its page.';

        const CSS = [
            // The card after a turn: drawn like DSH's own cards in a chat (no blur: the chat is glass already). It is a kit
            // pane, for the suite's colours, tag words, focus ring and motion rules; its own ground is DSH's layer 1.
            `.${P}-turn{box-sizing:border-box;margin:6px 0 2px;padding:10px 12px;max-width:100%;min-width:0;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}`,
            `.${P}-turn-head{display:flex;align-items:center;gap:6px;min-width:0;font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-secondary)}`,
            `.${P}-turn-glyph{flex:0 0 auto;display:inline-flex;color:var(--dsw-alias-state-business-primary)}`,
            `.${P}-turn-notes{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}`,
            `.${P}-turn-note{min-width:0;font-size:var(--dsh-content-font-size,14px);line-height:1.45;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}`,
            `.${P}-turn-where{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}`,
            `.${P}-turn-line{margin:6px 0 0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}`,
            `.${P}-turn-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px}`,
            `.${P}-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.95em;overflow-wrap:anywhere}`,
            // The page.
            `.${P}-lines{margin:10px 0 0;display:flex;flex-direction:column;gap:4px;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;overflow-wrap:anywhere}`,
            `.${P}-strong{color:var(--dsw-alias-label-primary)}`,
            `.${P}-form{display:flex;flex-direction:column;gap:10px;margin-top:10px;min-width:0}`,
            `.${P}-field{display:flex;flex-direction:column;gap:6px;min-width:0}`,
            `.${P}-label{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}`,
            `.${P}-textarea,.${P}-input{box-sizing:border-box;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}`,
            `.${P}-textarea{resize:vertical;min-height:4.5em}`,
            `.${P}-textarea::placeholder,.${P}-input::placeholder{color:var(--${P}-text-2)}`,
            `.${P}-row2{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:10px;align-items:end}`,
            `@media (max-width:640px){.${P}-row2{grid-template-columns:minmax(0,1fr)}}`,
            `.${P}-hint{font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-section{margin-top:12px}`,
            `.${P}-section-title{margin:0;font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}`,
            `.${P}-details{margin-top:6px}`,
            `.${P}-details>summary{cursor:pointer;font:var(--dsw-font-xs-13);color:var(--${P}-link);width:max-content;max-width:100%;border-radius:var(--dsw-radius-xs)}`,
            `.${P}-details>summary:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px}`,
            `.${P}-block{margin:6px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--${P}-fill);font:12px/1.5 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:24em;overflow:auto}`,
            // What happened's times in one column: every entry's words start at the same place.
            `.${P}-log-time{flex:0 0 7.5em;width:7.5em;font:var(--dsw-font-xs-13);color:var(--${P}-text-2)}`,
            `.${P}-item[tabindex]:focus{outline:none}`,
            `.${P}-item[tabindex]:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:-2px}`,
            `.${P}-said{margin:8px 0 0;font:var(--dsw-font-xs-13)}`,
            `.${P}-warn{color:var(--${P}-warn)}`,
            `.${P}-also{margin-top:10px}`,
            `.${P}-also-list{margin:4px 0 0;padding-left:18px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}`,
            // Use the default on a switch or a choice drawn as DSH draws it on a typed field: one style in the form.
            `.${P}-settings .${P}-set-reset{font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);text-decoration:none}`,
            `.${P}-settings .${P}-set-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}`,
            `.${P}-fix{margin-top:10px}`,
            `.${P}-fixed{margin:0 0 8px}`,
            `.${P}-said[tabindex]:focus{outline:none}`,
            `.${P}-said[tabindex]:focus-visible{outline:2px solid var(--${P}-ring);outline-offset:1px}`,
            `@media (max-width:560px){.${P}-item{flex-wrap:wrap}.${P}-item-side{justify-content:flex-start;width:100%}}`,
        ];

        // ── Words ─────────────────────────────────────────────────────

        const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
        const listWords = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
        const sentence = (text) => {
            const t = String(text ?? '').trim();
            return t && !/[.!?…]$/.test(t) ? `${t}.` : t;
        };
        const upper = (text) => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : text);
        /** A note's folder in the vault ("" at its top level). */
        const folderOf = (path) => String(path ?? '').split('/').slice(0, -1).join('/');
        /** A note's name: its title, else its file name. */
        const nameOf = (note) => note?.title || String(note?.path ?? '').split('/').at(-1).replace(/\.md$/i, '') || 'A note';
        const where = (path) => (folderOf(path) ? `in ${folderOf(path)}` : 'at the vault\'s top level');

        /** What Canon may write, in one sentence. */
        function writesText(s) {
            if (s.access !== 'drafts') return 'Read only: Canon writes nothing to the vault.';
            return `Drafts: agents may save draft notes in ${s.draftsFolder}, and none is added to a turn until a person promotes it.`;
        }
        /** Whether Promote does anything, in one sentence. */
        function promoteText(s) {
            if (s.access === 'drafts' && s.promote) return `Promoting is on: Promote makes a draft an active note ${s.promoteFolder ? `in ${s.promoteFolder}` : 'at the vault\'s top level'}.`;
            if (s.access !== 'drafts') return 'Promoting is off while Canon is read only: Promote changes nothing.';
            return 'Promoting is off: Promote changes nothing until “Allow promoting drafts” is on in Canon\'s settings.';
        }
        /** How much a turn gets, in one sentence. */
        function turnsText(s) {
            if (!s.recall) return 'Adding notes to turns is off: no turn gets notes.';
            return `A turn that starts from your prompt gets at most ${plural(s.maxNotes, 'note')} and ${plural(s.maxChars, 'character')}.`;
        }
        /** What the vault holds, in one sentence (without the time it was read). */
        function vaultText(v) {
            const c = v.counts ?? {};
            const parts = [plural(c.active ?? 0, 'active note'), plural(c.drafts ?? 0, 'draft')];
            return `${v.display ? `The vault ${v.display}` : 'The vault'} holds ${listWords(parts)}.`;
        }
        /** The vault's side notes: folders it may not read, notes left out, cut short or unreadable. */
        function vaultNotes(v) {
            const c = v.counts ?? {};
            const out = [];
            if (c.closed > 0) {
                const names = (v.closed ?? []).slice(0, 5);
                const more = c.closed - names.length;
                const one = c.closed === 1;
                out.push(`${plural(c.closed, 'folder')} Canon may not read${names.length ? `: ${names.join(', ')}${more > 0 ? `, and ${more} more` : ''}` : ''}. ${one ? 'Its' : 'Their'} notes are never added to turns: give DSH access to ${one ? 'it' : 'them'}, then read the vault again.`);
            }
            if (c.addressed > 0) {
                const names = (v.addressed ?? []).slice(0, 5);
                const more = c.addressed - names.length;
                out.push(`${plural(c.addressed, 'note')} ${c.addressed === 1 ? 'has a line' : 'have lines'} addressed to agents, left out of turns${names.length ? `: ${names.join(', ')}${more > 0 ? `, and ${more} more` : ''}` : ''}.`);
            }
            if (c.other > 0) out.push(`${plural(c.other, 'note')} with another status (archived, draft and the like) ${c.other === 1 ? 'is' : 'are'} never added.`);
            if (c.unreadable > 0) out.push(`${plural(c.unreadable, 'note')} could not be read.`);
            if (v.truncated) out.push('Only the first 20,000 notes are read.');
            return out;
        }

        // ── Shared state ──────────────────────────────────────────────

        /**
         * DSH's way to open a panel page and a session, set once its workspace
         * is there; and DSH's own settings form for Canon (`settings.set(field,
         * value)` saves one setting as the form's Save does), while DSH serves it.
         */
        const views = { openPage: () => {}, openSession: () => {}, settings: undefined };

        /** Do something on the host: `{ value }`, or `{ problem }` in words. */
        async function run(method, args) {
            const result = await api.call(method, args);
            return result.ok ? { value: result.value } : { problem: result.error?.message || 'Canon did not answer.' };
        }

        function BookGlyph({ size = 14 }) {
            return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
                h('path', { d: 'M12 6.5C10.2 5.1 7.6 4.5 4 4.5v13c3.6 0 6.2.6 8 2 1.8-1.4 4.4-2 8-2v-13c-3.6 0-6.2.6-8 2Z' }),
                h('path', { d: 'M12 6.5v13' }));
        }

        // ── The card after a turn ─────────────────────────────────────

        const NONE = Object.freeze([]);
        /** The notes the card under turn `n` lists: the session's last recall, when it was turn `n`. */
        function notesOf(view, n) {
            if (!kit.isRecord(view) || !kit.isRecord(view.last) || !Number.isSafeInteger(n) || view.last.turn !== n) return NONE;
            const notes = Array.isArray(view.last.notes) ? view.last.notes.filter((x) => kit.isRecord(x) && typeof x.path === 'string' && x.path) : [];
            return notes.length ? notes : NONE;
        }
        const sameNotes = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x.path === b[i].path && x.title === b[i].title));

        /** The card: which notes this turn got, and the session's switch. */
        function TurnCard({ sessionId, notes }) {
            const live = kit.useLive(() => api.read('session', { sessionId }), CHANNELS, { delayMs: 300 });
            const [busy, setBusy] = React.useState(false);
            const [problem, setProblem] = React.useState('');
            const data = live.data;
            const off = data?.off === true;
            const toggle = async (on) => {
                if (busy) return;
                setBusy(true);
                setProblem('');
                const { problem: no } = await run('setSession', { sessionId, on });
                setBusy(false);
                if (no) setProblem(no);
                void live.refresh();
            };
            // One line that says the session's state, there from the start so a change is read out where the focus is.
            const line = off ? 'Turned off for this session: its later turns get no notes.' : data && data.on === false && data.why ? data.why : '';
            return h('section', { className: `${P}-pane ${P}-turn`, 'aria-label': 'Canon', 'data-canon-turn': off ? 'off' : 'on' },
                h('div', { className: `${P}-turn-head` },
                    h('span', { className: `${P}-turn-glyph` }, h(BookGlyph, {})),
                    h('span', null, `Canon · ${plural(notes.length, 'note')} from the canon vault added to this turn`)),
                h('ul', { className: `${P}-turn-notes` }, ...notes.map((note) => h('li', { key: note.path, className: `${P}-turn-note`, 'data-canon-note': note.path },
                    h('span', null, nameOf(note)),
                    h('span', { className: `${P}-turn-where` }, ` · ${where(note.path)}`)))),
                h('p', { className: line ? `${P}-turn-line` : `${P}-sr`, role: 'status', 'aria-live': 'polite', ...(off ? { 'data-canon-off': '' } : {}) }, line),
                problem ? h('p', { className: `${P}-turn-line ${P}-error`, role: 'alert' }, `Not changed: ${problem}`) : null,
                h('div', { className: `${P}-turn-actions` },
                    // Never disabled while it works: the focus stays on it, and it names what pressing it does now.
                    data ? h(ui.Button, { key: 'switch', variant: 'outline', size: 'sm', 'aria-disabled': busy ? 'true' : undefined, onClick: () => void toggle(off), 'data-canon-switch': '' }, off ? 'Turn back on' : 'Turn off for this session') : null,
                    h('button', { key: 'open', type: 'button', className: `${P}-link`, onClick: () => views.openPage() }, 'Open Canon')));
        }

        /** After each completed turn: nothing unless it is the session's latest turn that got notes. */
        function CanonTurn({ turn, sessionId, useProjection }) {
            const n = Number(turn?.turn);
            let notes = NONE;
            try {
                if (typeof useProjection === 'function') notes = useProjection(KEY, (view) => notesOf(view, n), sameNotes) ?? NONE;
            } catch {
                notes = NONE;
            }
            if (!sessionId || typeof sessionId !== 'string' || !Array.isArray(notes) || notes.length === 0) return null;
            return h(TurnCard, { sessionId, notes });
        }

        // ── The page ──────────────────────────────────────────────────

        function SessionLink({ title, sessionId }) {
            if (!sessionId) return h('span', null, title || 'A session');
            return h('button', { type: 'button', className: `${P}-link`, onClick: () => views.openSession(sessionId), title: 'Open this session' }, title || 'Untitled session');
        }

        function SettingsButton({ focus, label = TEXT.settings, variant = 'outline' }) {
            if (!kit.canOpenPlugin()) return null;
            return h(ui.Button, { variant, size: 'sm', onClick: () => kit.openPlugin(BUNDLE, focus ? { focus } : {}) }, label);
        }

        function HeaderCard({ data, onRead, reading, said = '' }) {
            const s = data.settings;
            const v = data.vault;
            // What a fix saved takes the focus: the button pressed is gone with the problem it fixed.
            const saidRef = React.useRef(null);
            React.useEffect(() => {
                if (said) saidRef.current?.focus?.();
            }, [said]);
            // Read again stays the same button through a read and whatever it finds (an error, then the notes), so
            // the focus stays on it; pressed again during a read, it changes nothing. Beside an error it is one of
            // the two ways on, drawn as a button.
            const readAgain = h(ui.Button, { key: 'read', variant: v.state === 'error' ? 'outline' : 'ghost', size: 'sm', onClick: onRead, 'aria-disabled': reading ? 'true' : undefined, 'data-canon-read': '' }, reading ? 'Reading…' : 'Read again');
            let body;
            if (!data.enabled) body = h('p', { className: `${P}-note` }, TEXT.disabled);
            else if (v.state === 'unset' || !s.vault) {
                body = h(kit.Empty, { title: TEXT.noVault, text: TEXT.noVaultText, action: h(SettingsButton, { focus: 'vault', label: 'Open Canon\'s settings', variant: 'primary' }) });
            } else if (v.state === 'reading') {
                body = h('div', { className: `${P}-lines` },
                    h('div', { key: 'vault', className: `${P}-line`, 'data-canon-vault': 'reading' },
                        h('span', { key: 'text', className: `${P}-strong`, role: 'status' }, `Reading the vault ${v.display}…`)));
            } else if (v.state === 'error') {
                body = h('div', { className: `${P}-lines` },
                    h('div', { key: 'vault', className: `${P}-line`, 'data-canon-vault': 'error' },
                        h('span', { key: 'text', className: `${P}-error`, role: 'alert' }, v.error?.text ?? 'Canon cannot read the vault.'),
                        v.readAt ? h('span', { key: 'time' }, 'Tried ', h(kit.TimeText, { at: v.readAt }), '.') : null,
                        readAgain,
                        h(SettingsButton, { key: 'settings', focus: 'vault', label: 'Open Canon\'s settings', variant: 'outline' })));
            } else {
                body = h('div', { className: `${P}-lines` },
                    h('div', { key: 'vault', className: `${P}-line`, 'data-canon-vault': 'ok' },
                        h('span', { key: 'text', className: `${P}-strong` }, vaultText(v)),
                        v.readAt ? h('span', { key: 'time' }, 'Read ', h(kit.TimeText, { at: v.readAt }), '.') : null,
                        readAgain),
                    (v.counts?.notes ?? 0) === 0 && !(v.counts?.closed > 0)
                        ? h('div', { key: 'empty', className: `${P}-line`, 'data-canon-empty': '' },
                            h('span', { key: 'text' }, TEXT.emptyVault),
                            h(SettingsButton, { key: 'settings', focus: 'vault', label: 'Open Canon\'s settings' })) : null,
                    // Folders it may not read come first, drawn as a warning: notes are missing from turns.
                    ...vaultNotes(v).map((text, i) => (i === 0 && v.counts?.closed > 0
                        ? h('div', { key: `n${i}`, className: `${P}-line ${P}-warn`, 'data-canon-closed': '' }, text)
                        : h('div', { key: `n${i}`, className: `${P}-line`, ...(text.includes('addressed to agents') ? { 'data-canon-addressed': '' } : {}) }, text))),
                    h('div', { key: 'access', className: `${P}-line`, 'data-canon-access': s.access }, writesText(s)),
                    h('div', { key: 'recall', className: `${P}-line`, 'data-canon-recall': s.recall ? 'on' : 'off' }, turnsText(s)));
            }
            return h(kit.Card, {
                title: TEXT.title,
                headingLevel: 1,
                main: true,
                sub: TEXT.summary,
                actions: h(SettingsButton, {}),
                // The page is the region "Canon": its first card is not a second one inside it.
                attrs: { 'aria-label': undefined, 'data-canon-header': data.enabled ? v.state : 'off' },
            }, said ? [h('p', { key: 'said', ref: saidRef, tabIndex: -1, className: `${P}-said ${P}-fixed`, role: 'status', 'data-canon-fixed': '' }, said), h(React.Fragment, { key: 'body' }, body)] : body);
        }

        /**
         * A number or true/false written in quotes (text in the profile) that
         * would be right without them. DSH's settings form shows it as if it
         * were right, so the waiting state offers to save it without quotes,
         * through DSH's own settings call, in one press.
         */
        function QuotedFix({ problem, onSaved }) {
            const [busy, setBusy] = React.useState(false);
            const [failed, setFailed] = React.useState(false);
            const form = views.settings;
            if (problem?.live !== true || problem.unquoted === undefined || typeof form?.set !== 'function') return null;
            const title = SETTINGS.find((f) => f.name === problem.key)?.title ?? problem.key;
            const value = String(problem.unquoted);
            const save = async () => {
                if (busy) return;
                setBusy(true);
                setFailed(false);
                let ok = false;
                try { ok = (await form.set(problem.key, problem.unquoted)) === true; } catch { ok = false; }
                setBusy(false);
                const left = problem.also?.length ?? 0;
                if (ok) onSaved(`Saved “${title}” as ${value}, without quotes. ${left === 0 ? 'Canon works again.' : `${left === 1 ? 'One more setting is' : `${left} more settings are`} still wrong.`}`);
                else setFailed(true);
            };
            return h('div', { className: `${P}-fix`, 'data-canon-fix': problem.key },
                h('p', { className: `${P}-trouble-text` }, `Without the quotes it is right: Canon can save it as ${value} for you, as the settings form would.`),
                h('div', { className: `${P}-actions` },
                    h(ui.Button, { variant: 'primary', size: 'sm', 'aria-disabled': busy ? 'true' : undefined, onClick: () => void save(), 'data-canon-fix-save': '' }, busy ? 'Saving…' : `Save it as ${value}`)),
                failed ? h('p', { className: `${P}-said ${P}-error`, role: 'alert' }, 'DSH did not save it. Change it in Canon\'s settings in Plugins instead.') : null);
        }

        /** What a fix saved, while another setting is still wrong: a status line that takes the focus. */
        function SaidLine({ text }) {
            const line = React.useRef(null);
            React.useEffect(() => {
                line.current?.focus?.();
            }, [text]);
            return h('p', { ref: line, tabIndex: -1, className: `${P}-said ${P}-fixed`, role: 'status', 'data-canon-fixed': '' }, text);
        }

        /** The other wrong settings, each in Canon's words, after the first (which the problem above names). */
        function AlsoWrong({ also }) {
            return h('div', { className: `${P}-also`, 'data-canon-also': '' },
                h('p', { className: `${P}-trouble-text` }, also.length === 1 ? 'Also wrong:' : `${also.length} more are wrong:`),
                h('ul', { className: `${P}-also-list` }, ...also.map((p) => h('li', { key: p.key, 'data-canon-also-key': p.key }, `${p.text}.`))));
        }

        /** Why a note fits, in words. */
        function whyText(r) {
            const words = (r.words ?? r.matched ?? []).slice(0, 8);
            const place = r.folder === 'repo' ? ' It belongs to this folder\'s project, so it counts for more.' : r.folder === 'parent' ? ' It belongs to the folder above this one, so it counts a little more.' : '';
            const question = r.question ? ' It is the best note for one of the questions the prompt asks.' : '';
            return `Shares ${words.length === 1 ? 'the word' : 'the words'} ${listWords(words.map((w) => `“${w}”`))}.${question}${place}`;
        }
        /** Why a close note was left out, in words: a question's rules, or a coding request's. */
        function missText(r) {
            if (r.why === 'name') return 'It shares only a project\'s name with the prompt.';
            if (r.why === 'few' && !r.coding) {
                if (r.unknown?.length) return `Too little in common: the prompt names ${listWords(r.unknown.map((w) => `“${w}”`))}, which no note has, so a note needs three words in common with it, or to belong to a project the prompt or this folder names.`;
                if (r.plain === 0) return `Too little in common: ${r.named ? 'besides the project\'s name, ' : ''}one everyday request word like “run” or “test”, which is enough alone only when it is all the prompt asks.`;
                if (r.body) return 'Too little in common: one word, only in the note\'s body. That is enough when few notes have the word or the body has it twice, beside a project the prompt or this folder names, or when it is all the prompt asks beyond everyday request words.';
                return 'Too little in common: one word, and the prompt asks more. One word in the note\'s title, tags, aliases or headings is enough when few notes have it, the prompt shares no rarer word with the vault and has no word the vault lacks, and it names no other project.';
            }
            if (r.why === 'few' && r.named) return 'Too little in common for a coding request: besides the project\'s name, only the one word the prompt asks, and not in the note\'s title, tags, aliases or headings.';
            if (r.why === 'few' && r.titled) return 'Too little in common for a coding request: one word that says what the note is about. It needs two (in the note\'s title, tags, aliases or headings, in few notes, or twice in its body), or one beside a project the prompt or this folder names.';
            if (r.why === 'few') return 'Too little in common for a coding request: one word, and not in the note\'s title, tags, aliases or headings.';
            if (r.why === 'part') {
                const weigh = typeof r.share === 'number' ? `weigh ${Math.round(r.share * 100)}% of it` : 'weigh too little of it';
                return r.titled
                    ? `Too little of what the coding request asks: the words in common ${weigh}, and a note needs a third.`
                    : `Too little of what the coding request asks: the words in common ${weigh}, and a note needs 45% when they are not in its title, tags, aliases or headings.`;
            }
            if (r.why === 'other') return 'It belongs to another project than the one this folder or the prompt points at.';
            return 'It fits less well than the notes above, or too little to add.';
        }

        /** Why a note was close but not added, in a few words (missText says the rule, once, behind Why). */
        function missShort(r) {
            if (r.why === 'name') return 'It shares only a project\'s name.';
            if (r.why === 'few' && !r.coding) {
                if (r.unknown?.length) return `Too little in common: the prompt names ${listWords(r.unknown.map((w) => `“${w}”`))}, which no note has.`;
                if (r.plain === 0) return 'Too little in common: only an everyday request word.';
                return r.body ? 'Too little in common: one word, only in its body.' : 'Too little in common: one word, and the prompt asks more.';
            }
            if (r.why === 'few' && r.named) return 'Too little in common: the project\'s name and one word.';
            if (r.why === 'few') return r.titled ? 'Too little in common: one word that says what it is about.' : 'Too little in common: one word, not in its title, tags, aliases or headings.';
            if (r.why === 'part') return typeof r.share === 'number' ? `Too little of what the request asks: ${Math.round(r.share * 100)}% of it.` : 'Too little of what the request asks.';
            if (r.why === 'other') return 'It belongs to another project.';
            return 'It fits less well than the notes above.';
        }

        /** The rules behind a few words, said once each: a "Why" to open. */
        function WhyRules({ rules }) {
            const once = [...new Set(rules.filter(Boolean))];
            if (!once.length) return null;
            return h('details', { className: `${P}-details`, 'data-canon-why': '' },
                h('summary', null, 'Why'),
                ...once.map((text, i) => h('p', { key: `w${i}`, className: `${P}-why` }, text)));
        }

        function TryCard() {
            const [text, setText] = React.useState('');
            const [folder, setFolder] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const [result, setResult] = React.useState(undefined);
            const [problem, setProblem] = React.useState('');
            const ids = { prompt: `${P}-try-prompt`, folder: `${P}-try-folder` };
            const go = async () => {
                if (busy) return;
                if (!text.trim()) {
                    setProblem('Type a prompt to try.');
                    return;
                }
                setBusy(true);
                setProblem('');
                const { problem: no, value } = await run('search', { text, folder: folder.trim() });
                setBusy(false);
                if (no) {
                    setProblem(no);
                    setResult(undefined);
                } else setResult(value);
            };
            const onKey = (event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.target?.tagName === 'INPUT')) {
                    event.preventDefault();
                    void go();
                }
            };
            return h(kit.Card, { title: TEXT.tryTitle, sub: TEXT.trySub, attrs: { 'data-canon-try': result ? String(result.results.length) : '' } },
                h('div', { className: `${P}-form` },
                    h('div', { className: `${P}-field` },
                        h('label', { className: `${P}-label`, htmlFor: ids.prompt }, 'Prompt'),
                        h('textarea', { id: ids.prompt, className: `${P}-textarea`, value: text, rows: 2, placeholder: 'What port does the gateway listen on?', onChange: (e) => setText(e.target.value), onKeyDown: onKey, 'data-canon-try-prompt': '' })),
                    h('div', { className: `${P}-row2` },
                        h('div', { className: `${P}-field` },
                            h('label', { className: `${P}-label`, htmlFor: ids.folder }, 'Session folder (optional)'),
                            h('input', { id: ids.folder, className: `${P}-input ${P}-code`, value: folder, autoComplete: 'off', spellCheck: false, placeholder: '~/Projects/app', onChange: (e) => setFolder(e.target.value), onKeyDown: onKey, 'data-canon-try-folder': '' })),
                        h('div', { className: `${P}-actions` }, h(ui.Button, { variant: 'primary', size: 'sm', 'aria-disabled': busy ? 'true' : undefined, onClick: () => void go() }, busy ? 'Trying…' : 'Try it')))),
                problem ? h('p', { className: `${P}-said ${P}-error`, role: 'alert' }, problem) : null,
                result ? h(TryResult, { result }) : null);
        }

        function TryResult({ result }) {
            if (result.terms.length === 0) {
                return h(kit.Empty, { title: 'Nothing to search for', text: 'That prompt has no words Canon searches for: greetings, thanks, words like “please” and words about the vault itself are left out, and so are everyday request words like “write”, “fix” and “test” in a coding request. A turn with it gets no notes.' });
            }
            return h('div', { 'data-canon-try-result': '' },
                h('p', { className: `${P}-meta`, 'data-canon-try-place': '', 'data-canon-try-coding': result.coding ? '' : undefined }, `${result.place ? `For a session in ${result.place}.` : 'For a session with no folder.'} ${result.coding ? TEXT.readCoding : TEXT.readQuestion}`),
                result.results.length === 0
                    ? h(kit.Empty, { title: 'No note fits this prompt', text: TEXT.noFit, action: h(WhyRules, { rules: [(result.coding ? TEXT.noFitCoding : TEXT.noFitQuestion).replace(`${TEXT.noFit} `, '')] }) })
                    : h('div', { className: `${P}-section` },
                        h('h3', { className: `${P}-section-title` }, `A turn with this prompt gets ${plural(result.results.length, 'note')}`),
                        h('ul', { className: `${P}-list` }, ...result.results.map((r) => h('li', { key: r.path, className: `${P}-item`, 'data-canon-result': r.path },
                            h('div', { className: `${P}-item-main` },
                                h('div', { className: `${P}-title` }, nameOf(r)),
                                h('div', { className: `${P}-meta ${P}-code` }, r.path),
                                // Its kind and date, and the newer decision it comes after, as its citation in the block says.
                                r.kind || r.when || r.older ? h('div', { className: `${P}-meta`, 'data-canon-about': '' }, sentence(upper([r.kind, r.when, r.older ? `older than ${r.older}, which comes first` : ''].filter(Boolean).join(', ')))) : null,
                                h('div', { className: `${P}-why` }, whyText(r)),
                                r.passage ? h('p', { className: `${P}-quote` }, r.passage) : null,
                                r.leftOut ? h('div', { className: `${P}-meta`, 'data-canon-left-out': '' }, `${r.leftOut === 1 ? 'A line' : `${plural(r.leftOut, 'line')}`} of this note ${r.leftOut === 1 ? 'is' : 'are'} addressed to agents, so ${r.leftOut === 1 ? 'it is' : 'they are'} left out: Canon never quotes ${r.leftOut === 1 ? 'it' : 'them'} into a turn.`) : null),
                            r.folder ? h('div', { className: `${P}-item-side` }, h(ui.Tag, { tone: 'info', className: `${P}-tag` }, r.folder === 'repo' ? 'this project' : 'nearby')) : null))),
                        result.block ? h('details', { className: `${P}-details` },
                            h('summary', null, `The exact text the turn gets (${plural(result.block.chars, 'character')})`),
                            h('pre', { className: `${P}-block`, 'data-canon-block': '' }, result.block.text)) : null),
                result.others.length ? h('div', { className: `${P}-section` },
                    h('h3', { className: `${P}-section-title` }, 'Close, but not added'),
                    h('ul', { className: `${P}-list` }, ...result.others.map((r) => h('li', { key: r.path, className: `${P}-item`, 'data-canon-other': r.path },
                        h('div', { className: `${P}-item-main` },
                            h('div', null, nameOf(r)),
                            h('div', { className: `${P}-why` }, missShort(r)))))),
                    h(WhyRules, { rules: result.others.map(missText) })) : null);
        }

        function SessionsCard({ data }) {
            const [busy, setBusy] = React.useState('');
            const [said, setSaid] = React.useState({ text: '', bad: false });
            const toggle = async (row, on) => {
                if (busy) return;
                setBusy(row.sessionId);
                setSaid({ text: '', bad: false });
                const { problem } = await run('setSession', { sessionId: row.sessionId, on });
                setBusy('');
                setSaid(problem ? { text: `Not changed: ${problem}`, bad: true }
                    : { text: on ? `Notes are on again for “${row.title || 'Untitled session'}”.` : `“${row.title || 'Untitled session'}” gets no notes from now on.`, bad: false });
            };
            return h(kit.Card, { title: TEXT.sessions, sub: data.sessions.length ? TEXT.sessionsSub : undefined, attrs: { 'data-canon-sessions': String(data.sessions.length) } },
                h('p', { className: said.text ? `${P}-said ${said.bad ? `${P}-error` : `${P}-ok`}` : `${P}-sr`, role: said.bad ? 'alert' : 'status', 'aria-live': 'polite' }, said.text),
                data.sessions.length === 0
                    ? h(kit.Empty, { title: TEXT.noSessions, text: TEXT.noSessionsText })
                    : h('ul', { className: `${P}-list` }, ...data.sessions.map((row) => {
                        const last = row.recalls[0];
                        return h('li', { key: row.sessionId, className: `${P}-item`, 'data-canon-session': row.sessionId, 'data-canon-session-off': row.off ? 'true' : 'false' },
                            h('div', { className: `${P}-item-main` },
                                h('div', { className: `${P}-title` }, h(SessionLink, { title: row.title, sessionId: row.sessionId })),
                                last ? h('div', { className: `${P}-meta` }, `Turn ${last.turn ?? '?'}: ${listWords(last.notes.map(nameOf))}`, last.at ? ' · ' : '', last.at ? h(kit.TimeText, { at: last.at }) : null)
                                    : h('div', { className: `${P}-meta` }, 'No notes added yet.'),
                                row.count > 1 ? h('div', { className: `${P}-why` }, `${plural(row.count, 'turn')} got notes.`) : null),
                            h('div', { className: `${P}-item-side` },
                                // Named for its session; never disabled while it works, so the focus stays on it.
                                h(ui.Switch, { checked: !row.off, label: `Add notes to ${row.title || 'Untitled session'}`, onChange: (next) => void toggle(row, next) })));
                    })));
        }

        function DraftsCard({ data, onChanged }) {
            const s = data.settings;
            const [busy, setBusy] = React.useState('');
            const [said, setSaid] = React.useState({ text: '', bad: false });
            const saidRef = React.useRef(null);
            // After Promote the focus goes to what it did: a promoted draft's row (and its button) is gone.
            React.useEffect(() => {
                if (said.text) saidRef.current?.focus?.();
            }, [said]);
            const act = async (what, draft) => {
                if (busy) return;
                setBusy(`${what}:${draft.path}`);
                setSaid({ text: '', bad: false });
                const { problem, value } = await run(what, { path: draft.path });
                setBusy('');
                setSaid(problem ? { text: problem, bad: true }
                    : what === 'promote'
                        ? { text: `Promoted “${nameOf(draft)}”: it is now an active note, ${value.path}, and turns can get it.`, bad: false }
                        : { text: `Discarded “${nameOf(draft)}”: it is in the vault's trash now, ${value.path}. Move it back to ${s.draftsFolder} to keep it.`, bad: false });
                onChanged();
            };
            const writes = s.access === 'drafts';
            const sub = writes
                ? `Notes agents saved in ${s.draftsFolder}. None is added to a turn until a person promotes it; Discard moves one to the vault's trash.`
                : `The notes in the drafts folder, ${s.draftsFolder}. Canon is read only, so agents save none there, and none is ever added to a turn.`;
            return h(kit.Card, { title: TEXT.drafts, sub, attrs: { 'data-canon-drafts': String(data.drafts.length), 'data-canon-promote': s.access === 'drafts' && s.promote ? 'on' : 'off' } },
                h('div', { className: `${P}-lines` }, h('div', { className: `${P}-line` }, promoteText(s), s.access === 'drafts' && s.promote ? null : h(SettingsButton, { focus: s.access === 'drafts' ? 'promote' : 'access', label: 'Open Canon\'s settings', variant: 'ghost' }))),
                h('p', {
                    ref: saidRef,
                    tabIndex: said.text ? -1 : undefined,
                    className: said.text ? `${P}-said ${said.bad ? `${P}-error` : `${P}-ok`}` : `${P}-sr`,
                    role: said.bad ? 'alert' : 'status',
                    'aria-live': 'polite',
                    'data-canon-said': said.text ? (said.bad ? 'refused' : 'done') : '',
                }, said.text),
                data.drafts.length === 0
                    ? h(kit.Empty, s.access === 'drafts'
                        ? { title: 'No drafts', text: `When an agent saves something worth keeping, its draft shows here for you to read and promote. Drafts go to ${s.draftsFolder} in the vault.` }
                        : { title: 'No drafts', text: 'Canon is read only, so agents save no drafts. To let them, set “What Canon may write” to Drafts in Canon\'s settings.', action: h(SettingsButton, { focus: 'access', label: 'Open Canon\'s settings' }) })
                    : h('ul', { className: `${P}-list` }, ...data.drafts.map((d) => h('li', { key: d.path, className: `${P}-item`, 'data-canon-draft': d.path },
                        h('div', { className: `${P}-item-main` },
                            h('div', { className: `${P}-title` }, nameOf(d)),
                            h('div', { className: `${P}-meta` },
                                d.created ? h('span', null, 'Saved ', h(kit.TimeText, { at: d.created })) : null,
                                d.sessionId ? h('span', null, d.created ? ' from ' : 'From ', h(SessionLink, { title: d.sessionTitle || 'a session', sessionId: d.sessionKnown === false ? '' : d.sessionId }), Number.isSafeInteger(d.turn) ? `, turn ${d.turn}` : '') : null,
                                h('span', { className: `${P}-code` }, `${d.created || d.sessionId ? ' · ' : ''}${d.path}`)),
                            d.preview ? h('div', { className: `${P}-why` }, d.preview) : null,
                            Array.isArray(d.related) && d.related.length
                                ? h('div', { className: `${P}-meta`, 'data-canon-related': d.related.map((r) => r.path).join('\n') },
                                    `Active ${d.related.length === 1 ? 'note' : 'notes'} on the same subject: `,
                                    ...d.related.flatMap((r, i) => [i ? '; ' : '', `“${nameOf(r)}” `, h('span', { key: r.path, className: `${P}-code` }, `(${r.path})`)]),
                                    '. Read ', d.related.length === 1 ? 'it' : 'them', ' before you promote this draft.')
                                : null,
                            // The whole draft, when it holds more than the line above shows.
                            typeof d.body === 'string' && d.body !== '' && d.body.replace(/\s+/g, ' ').trim() !== d.preview ? h('details', { className: `${P}-details`, 'data-canon-draft-body': '' },
                                h('summary', null, 'Read the whole draft'),
                                h('p', { className: `${P}-quote` }, d.body)) : null),
                        h('div', { className: `${P}-item-side` },
                            d.kind ? h(ui.Tag, { tone: 'quiet', className: `${P}-tag` }, KIND_WORD[d.kind] ?? d.kind) : null,
                            h(ui.Button, { variant: 'outline', size: 'sm', 'aria-disabled': busy ? 'true' : undefined, onClick: () => void act('promote', d), 'aria-label': `Promote ${nameOf(d)}` }, busy === `promote:${d.path}` ? 'Promoting…' : 'Promote'),
                            writes ? h(ui.Button, { variant: 'ghost', size: 'sm', 'aria-disabled': busy ? 'true' : undefined, onClick: () => void act('discard', d), 'aria-label': `Discard ${nameOf(d)} to the vault's trash`, 'data-canon-discard': d.path }, busy === `discard:${d.path}` ? 'Discarding…' : 'Discard') : null)))));
        }

        /** What happened lists this many entries until "Show all". */
        const SHOWN = 30;
        function HistoryCard({ data, titles }) {
            const [all, setAll] = React.useState(false);
            const firstMore = React.useRef(null);
            const shown = all ? data.history : data.history.slice(0, SHOWN);
            // "Show all" goes once pressed: the focus moves to the first entry it brought into view.
            React.useEffect(() => {
                if (all) firstMore.current?.focus?.();
            }, [all]);
            return h(kit.Card, { title: TEXT.history, sub: TEXT.historySub, attrs: { 'data-canon-history': '' } },
                data.history.length === 0 ? h(kit.Empty, { title: TEXT.noHistory, text: TEXT.noHistoryText })
                    : [
                        h('ul', { key: 'l', className: `${P}-list` }, ...shown.map((entry, i) => h('li', { key: entry.id, className: `${P}-item`, 'data-canon-entry': entry.kind, 'data-canon-state': entry.state ?? '', ...(i === SHOWN ? { ref: firstMore, tabIndex: -1 } : {}) },
                            h('span', { className: `${P}-log-time` }, h(kit.TimeText, { at: entry.at })),
                            h('div', { className: `${P}-item-main` },
                                h('div', null,
                                    entry.sessionId ? h(SessionLink, { title: entry.sessionTitle || titles.get(entry.sessionId) || 'A session', sessionId: entry.sessionKnown === false ? '' : entry.sessionId }) : null,
                                    entry.sessionId ? h('span', { className: `${P}-meta` }, ' · ') : null,
                                    h('span', null, entry.text)),
                                entry.why ? h('div', { className: `${P}-why` }, sentence(upper(entry.why))) : null),
                            entry.state === 'refused' || entry.state === 'failed' ? h('div', { className: `${P}-item-side` }, h(kit.StateTag, { word: entry.state === 'failed' ? 'failed' : 'not changed' })) : null))),
                        data.history.length > shown.length ? h('div', { key: 'm', style: { marginTop: '8px' } }, h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setAll(true) }, `Show all ${data.history.length}`)) : null,
                    ]);
        }

        function CanonPage() {
            const live = kit.useLive(() => api.read('state'), CHANNELS, { delayMs: 300 });
            const [reading, setReading] = React.useState(false);
            const [readProblem, setReadProblem] = React.useState('');
            // What the waiting state's fix saved, said on the page it comes back to: working again, or waiting on
            // another wrong setting.
            const [fixed, setFixed] = React.useState({ text: '', shown: false });
            const data = live.data;
            const problemText = data?.problem?.text;
            // The first change of the problem after a fix is the fix itself; any later one makes what it saved old news.
            React.useEffect(() => {
                setFixed((f) => (!f.text ? f : f.shown ? { text: '', shown: false } : { ...f, shown: true }));
            }, [problemText]);
            const down = live.code === 'not-running' || (data === undefined && live.error);
            const onRead = async () => {
                if (reading) return;
                setReading(true);
                setReadProblem('');
                const { problem } = await run('refresh', {});
                setReading(false);
                if (problem) setReadProblem(problem);
                void live.refresh();
            };
            const titles = new Map([...(data?.sessions ?? []).map((s) => [s.sessionId, s.title]), ...(data?.drafts ?? []).filter((d) => d.sessionId).map((d) => [d.sessionId, d.sessionTitle])]);
            const ok = data && data.enabled && !data.problem && data.vault.state === 'ok';
            return h(kit.Page, { label: TEXT.title, attrs: { 'data-canon-page': '' } },
                down
                    ? h(kit.Card, { title: TEXT.title, headingLevel: 1, main: true, sub: TEXT.summary, attrs: { 'aria-label': undefined } },
                        h(kit.Trouble, { name: 'Canon', packageName: BUNDLE, code: live.code, text: live.error, onRetry: live.refresh, needsWatch: false }))
                    : data === undefined
                        ? h(kit.Card, { title: TEXT.title, headingLevel: 1, main: true, attrs: { 'aria-label': undefined } }, h(kit.Loading, { text: TEXT.loading }))
                        : data.problem
                            ? [
                                h(kit.Card, { key: 'head', title: TEXT.title, headingLevel: 1, main: true, sub: TEXT.summary, attrs: { 'aria-label': undefined, 'data-canon-header': 'problem' } },
                                    fixed.text ? h(SaidLine, { key: 'said', text: fixed.text }) : null,
                                    h(kit.SettingsProblem, { name: 'Canon', packageName: BUNDLE, problem: data.problem }),
                                    // Save it as N fixes the setting just named, so it sits right under it, before the others that are wrong.
                                    h(QuotedFix, { key: `fix-${data.problem.key ?? ''}`, problem: data.problem, onSaved: (text) => { setFixed({ text, shown: false }); void live.refresh(); } }),
                                    data.problem.also?.length ? h(AlsoWrong, { key: 'also', also: data.problem.also }) : null),
                                h(HistoryCard, { key: 'history', data, titles }),
                            ]
                            : [
                                h(HeaderCard, { key: 'head', data, onRead: () => void onRead(), reading, said: fixed.text }),
                                live.error ? h(kit.ErrorLine, { key: 'refresh', text: live.error, onRetry: live.refresh }) : null,
                                readProblem ? h(kit.ErrorLine, { key: 'read', lead: 'Couldn\'t read the vault again', text: readProblem, onRetry: () => void onRead() }) : null,
                                ok ? h(TryCard, { key: 'try' }) : null,
                                data.enabled ? h(SessionsCard, { key: 'sessions', data }) : null,
                                ok ? h(DraftsCard, { key: 'drafts', data, onChanged: () => void live.refresh() }) : null,
                                h(HistoryCard, { key: 'history', data, titles }),
                            ]);
        }

        /** The panel entry's glyph. */
        function CanonIcon({ size = 16 }) {
            return h('span', { className: `${P}-icon`, 'data-canon-icon': '' }, h(BookGlyph, { size }));
        }

        /**
         * A number or true/false written in quotes in the profile that is right without them: the profile's
         * text, the form's text for what Canon would take ('3', 'on', 'off') and the form's words for it.
         */
        function quotedSetting(f, value) {
            if (typeof value !== 'string' || (f.kind !== 'number' && f.kind !== 'switch')) return undefined;
            const text = value.trim();
            let fixed;
            if (f.kind === 'switch' && /^(?:true|false)$/i.test(text)) fixed = text.toLowerCase() === 'true' ? 'on' : 'off';
            if (f.kind === 'number' && /^\d+$/.test(text) && Number(text) >= f.min && Number(text) <= f.max) fixed = String(Number(text));
            if (fixed === undefined) return undefined;
            return { raw: value, text: fixed, words: `“${value}” is text: it is written in quotes in the profile, so Canon waits. Save writes it as ${f.kind === 'switch' ? `${fixed}, a switch` : `the number ${fixed}`}.` };
        }

        /**
         * Canon's settings on its page in Plugins: DSH's own form model and the kit's rows, as the kit's
         * applySettings draws them (Canon has no secret), and three things more:
         * - a number or true/false in quotes in the profile is marked wrong in Canon's words, and the value Canon
         *   would take is put in the form when it opens, so Save is on and writes it as a number or a switch
         *   (DSH's form drops what it holds when it closes; it is put back the next time it opens);
         * - "Changed" and Use the default only for a value that is not the default;
         * - after a Save, the focus goes to a status line that says so: Save is off then, and the focus would be
         *   lost. A Save DSH refuses is said by DSH's form beside Save, which keeps the focus.
         */
        function applyCanonSettings(ctx, { entry, name, summary, fields, note }) {
            if (typeof ui.SettingsFormModel !== 'function' || typeof ui.SettingsForm !== 'function' || typeof ctx.configForms?.get !== 'function') return;
            const scope = ctx.configForms.get(entry);
            const snap = () => scope.getSnapshot?.() ?? {};
            const quotedNow = (f) => quotedSetting(f, snap().value?.[f.name]);
            const drawn = fields.map((f) => (f.kind === 'number' || f.kind === 'switch' ? { ...f, get invalid() { return quotedNow(f)?.words; } } : f));
            const specs = new Map(drawn.map((f) => {
                const spec = kit.fieldSpec(f);
                // A value in quotes shows with them until the form holds the fix, so the two differ and Save writes it.
                return [f.name, { ...spec, format: (v) => (quotedSetting(f, v) ? `“${v}”` : spec.format(v)) }];
            }));
            const model = new ui.SettingsFormModel(scope, [...specs.values()], []);
            const actions = model.actions();
            const isDefault = (f, text) => text === specs.get(f.name).format(snap().base?.[f.name] ?? f.default);
            const projection = () => {
                const out = { ...model.shell() };
                for (const f of drawn) {
                    const state = model.field(f.name);
                    const q = quotedNow(f);
                    out[f.name] = q && state.text === q.text ? { ...state, invalid: true } : { ...state, overridden: state.overridden && !isDefault(f, state.text) };
                }
                return out;
            };
            const store = model.bind(projection);
            const form = { subscribe: (fn) => store.subscribe(fn), getSnapshot: () => store.getSnapshot(), actions, keepers: new Map() };
            const putFixes = () => {
                for (const f of drawn) {
                    const q = quotedNow(f);
                    if (q && model.field(f.name).text === specs.get(f.name).format(q.raw)) actions.edit(f.name, q.text);
                }
            };
            function CanonSettings() {
                const [saved, setSaved] = React.useState(false);
                const line = React.useRef(null);
                React.useEffect(() => {
                    putFixes();
                    return scope.subscribe?.(putFixes);
                }, []);
                // A Save that ends well says so; the next change takes the line away.
                React.useEffect(() => {
                    let was = form.getSnapshot().saving;
                    return form.subscribe(() => {
                        const now = form.getSnapshot();
                        if (was && !now.saving) setSaved(!now.failed);
                        else if (now.dirty && !now.saving) setSaved(false);
                        was = now.saving;
                    });
                }, []);
                React.useEffect(() => {
                    if (saved) line.current?.focus?.();
                }, [saved]);
                return h('div', { className: `${P}-set-wrap` },
                    h(kit.SettingsBody, { form, name, fields: drawn, note }),
                    h('p', { ref: line, tabIndex: -1, role: 'status', className: `${P}-said`, 'data-canon-saved': saved ? '' : undefined }, saved ? TEXT.settingsSaved : ''));
            }
            const View = (props) => (props?.view === 'summary' ? summary : h(CanonSettings, {}));
            ctx.effect(() => () => model.dispose(), `${BUNDLE}: settings form`);
            ctx.effect(() => ctx.configForms.whileServed([entry], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE }, View))), `${BUNDLE}: settings page`);
            return { model, form, View };
        }

        const inject = ['slots'];

        function apply(ctx) {
            try {
                kit.injectStyle(CSS);
            } catch (error) {
                console?.warn?.('dsh-plugin-canon: style:', error);
            }
            ctx.effect?.(() => () => kit.removeStyle(), 'canon: style');
            ctx.inject(['connection'], (scope) => scope.effect(() => {
                kit.setConnection(scope.connection);
                const detach = kit.hub.attach();
                return () => {
                    detach();
                    kit.setConnection(undefined);
                };
            }, 'canon: connection'));
            ctx.inject(['uiWorkspace'], (scope) => applyViews(scope));
            // DSH's Plugins page: the buttons that open Canon's switch and settings.
            ctx.inject(['pluginNavigation'], (scope) => {
                kit.setNavigation(scope.pluginNavigation);
                return () => kit.setNavigation(undefined);
            });
            // Its settings on its page in Plugins, through DSH's own settings form.
            ctx.inject(['configForms', 'remote', 'remote.session'], (scope) => {
                let saved;
                try {
                    saved = scope.configForms?.get?.('canon');
                    views.settings = saved;
                    const fields = settingsFields(() => saved?.getSnapshot?.()?.value?.draftsFolder);
                    applyCanonSettings(scope, { entry: 'canon', name: 'Canon', summary: SETTINGS_SUMMARY, fields, note: SETTINGS_NOTE });
                } catch (error) {
                    console?.warn?.('dsh-plugin-canon: settings:', error);
                }
                return () => { if (views.settings === saved) views.settings = undefined; };
            });
        }

        /** The card, the page and its sidebar entry, once DSH's workspace (which opens sessions) is there. */
        function applyViews(ctx) {
            views.openSession = (sessionId) => {
                if (typeof sessionId !== 'string' || sessionId === '') return;
                try { ctx.uiWorkspace.openSession(sessionId); } catch (error) { console?.warn?.('dsh-plugin-canon: could not open the session', error); }
            };
            // DSH's way to a panel page, as its sidebar entry opens it, read when needed.
            views.openPage = () => {
                let layout;
                try { layout = ctx.get?.('layout'); } catch { layout = undefined; }
                try { layout?.selectPanel?.(PAGE); } catch (error) { console?.warn?.('dsh-plugin-canon: could not open Canon\'s page', error); }
            };
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PAGE }, CanonPage));
            // After Calendar (7), before DSH's Automation tasks (10).
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PAGE, order: 8, label: TEXT.entry }, CanonIcon));
            // After the coordinator's thread cards (30) and Proof's flag (40).
            ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: `${BUNDLE}:card`, order: 45, label: 'Canon' }, CanonTurn));
        }

        module.exports.inject = inject;
        module.exports.apply = apply;
        // For the plugin's own tests.
        module.exports.internals = {
            kit, TEXT, CSS, SETTINGS, SETTINGS_SUMMARY, SETTINGS_NOTE, KIND_WORD, settingsFields, views, notesOf, sameNotes, writesText, promoteText, turnsText, vaultText, vaultNotes, whyText, missText,
            CanonTurn, TurnCard, CanonPage, CanonIcon, HeaderCard, QuotedFix, TryCard, TryResult, SessionsCard, DraftsCard, HistoryCard, quotedSetting, applyCanonSettings, missShort, AlsoWrong,
        };
        return module.exports;
    },
});
