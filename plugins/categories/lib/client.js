/**
 * dsh-plugin-categories, browser half. Three parts:
 *
 * - DSH's session list by category (SidebarTree): a header over each
 *   category's workspaces, then Other workspaces for the rest. A header
 *   folds, has a ⋯ menu and drags; a workspace's row drags into a
 *   category. DSH has no seat for a header in its list, so the headers are
 *   the plugin's own elements in it and CSS sets DSH's sections under them
 *   (sidebarRules); DSH's rows, their order in a workspace, its view
 *   options and its search stay DSH's own.
 * - The Categories page (CategoriesPage), opened from its entry in DSH's
 *   sidebar: the tree Category › Workspace › session, with Find by name
 *   and New category.
 * - The chip at the top of a session (CategoryChip), in DSH's header: the
 *   category and workspace the session is in; a click opens the page.
 *
 * All three read the categories from the plugin's host half (its `list`
 * endpoint) through one store (categoryFacts), and the list and the page
 * change them through its endpoints. A session here is DSH's own row: its
 * DSH title and DSH's dot. Nothing here reads or writes another plugin's
 * data or DOM.
 *
 * Hand-written in the module format DSH serves to the browser, so the plugin
 * needs no build step: the factory gets DSH's module `require` and returns
 * the client plugin (inject + apply).
 *
 * @module dsh-plugin-categories/client
 */
// DSH serves browser halves in one script; never throw here, or the others stop loading too.
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-categories',
    factory: (require) => {
        const module = { exports: {} };
        Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const ReactDOM = require('react-dom');
        const ui = require('@deepseek-ai/dsh-client-ui-primitives');
        const h = React.createElement;

        /** The package: its endpoints' namespace, and the prefix of what it keeps in the window's storage. */
        const BUNDLE = 'dsh-plugin-categories';
        /** The plugin's entries in DSH's slots: the session list's headers, the page with its sidebar entry, and the chip in a session's header. */
        const IDS = {
            sidebar: `${BUNDLE}:sidebar`,
            page: `${BUNDLE}:page`,
            chip: `${BUNDLE}:chip`,
        };

        /** DSH's drop line (its own style), drawn over the session list for the plugin's drags: they never touch DSH's rows. */
        const DROP_LINE = ['55deg', '125deg'].map((deg, i) => `linear-gradient(${deg},transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 ${i * 5}px/5px 7px no-repeat`)
            .concat('linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px/calc(100% - 4px) 2px no-repeat').join(',');
        /** Out of sight, still read by screen readers. */
        const HIDDEN = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';
        /** DSH's focus ring color, as its own controls draw it. */
        const RING = 'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))';
        /** DSH's header actions while the chip is among them (useChipHost). */
        const CHIP_HOST = 'data-categories-chip-host';
        // DSH's error red reaches only 4.5:1 as small text on white: a touch of the label colour takes it past 5:1
        // in light and further from the background in dark.
        const ERROR_TEXT = 'color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary))';
        const CSS = [
            // Keyboard focus: DSH's ring on every plugin control. DSH's own buttons (New category, Create, Cancel…) get
            // its outline; the plugin's own controls draw it inset below, so a scrolling list can't clip it.
            `:where(.dshc-page,.dshc-pg-dialog) button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ${RING};outline-offset:2px}`,
            // The Categories page (its entry in DSH's sidebar): DSH's page layout, as on Automation tasks, with the whole
            // tree: categories, their workspaces, each one's sessions.
            // Its ground (DESIGN.md, section 3): the page's root stays unpainted, so Wallpaper's wall shows around it, and
            // everything on it sits on one glass card at tint + .2, the open chat's ground, as a list people read does.
            // Secondary text and glyphs on that card are DSH's own, deepened toward its label colour. The root's class is
            // .dshc-page: Wallpaper still paints an older page's root, .dshc-pg, as a glass card of its own (a card in a
            // card, blurred twice), and only Wallpaper's own change can drop that rule.
            '.dshc-page{--dshc-conv:rgba(10,13,12,calc(var(--wp-tint,.55) + .2));--dshc-text-2:color-mix(in srgb,var(--dsw-alias-label-secondary) 80%,var(--dsw-alias-label-primary));--dshc-glyph:color-mix(in srgb,var(--dsw-alias-label-tertiary) 75%,var(--dsw-alias-label-primary))}',
            'body:not([data-ds-dark-theme]) .dshc-page{--dshc-conv:rgba(250,250,246,calc(var(--wp-tint,.55) + .2))}',
            '@media (prefers-reduced-transparency:reduce){.dshc-page{--dshc-conv:rgba(10,13,12,.95)}body:not([data-ds-dark-theme]) .dshc-page{--dshc-conv:rgba(250,250,246,.95)}}',
            '.dshc-page{display:flex;box-sizing:border-box;width:100%;min-width:0;height:100%;min-height:0;padding:12px;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}',
            '[data-platform=darwin] .dshc-page{padding-top:calc(12px + var(--dsh-frame-top-clearance,0px))}',
            '.dshc-pg-scroll{flex:1;min-width:0;min-height:0;overflow:auto;scrollbar-gutter:stable;container-type:inline-size;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px;background:var(--dshc-conv);-webkit-backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg)}',
            '.dshc-pg-content{max-width:960px;margin:0 auto;padding:0 clamp(16px,4vw,40px) 40px}',
            '.dshc-pg-heading{display:flex;align-items:baseline;gap:12px;margin-bottom:16px;padding-top:20px}',
            '.dshc-pg-heading h1{margin:0;font-size:20px;font-weight:500;line-height:28px}',
            '.dshc-tree,.dshc-tree-group{list-style:none;margin:0;padding:0}',
            '.dshc-tree-item{outline:none}',
            '.dshc-tree-row{display:flex;align-items:center;gap:6px;min-height:30px;padding-inline-end:10px;border-radius:6px;cursor:default}',
            '.dshc-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshc-tree-item:focus-visible>.dshc-tree-row{outline:var(--dsw-focus-ring-width,2px) solid ${RING};outline-offset:-2px}`,
            // The chevron's target is wider than it looks (20 px), and takes no more room in the row.
            '.dshc-tree-chevron{display:inline-flex;align-items:center;justify-content:center;width:20px;align-self:stretch;margin-inline:-4px;flex:none;color:var(--dshc-glyph)}',
            '.dshc-tree-title{flex:0 1 auto;min-width:4em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshc-tree-category>.dshc-tree-row .dshc-tree-title{font-weight:500}',
            // What follows a title (a level and its count, a path) gives way before the title does.
            '.dshc-tree-meta{margin-left:auto;padding-left:12px;flex:0 100 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--dshc-text-2);white-space:nowrap}',
            '.dshc-tree-dot{display:inline-flex;flex:none}',
            '.dshc-tree-glyph{display:inline-flex;width:14px;flex:none;color:var(--dshc-glyph)}',
            // A category's or a workspace's ⋯ at the end of its row, as on DSH's own rows: shown while the row is
            // pointed at, has the focus or has its menu open, its place kept meanwhile so the row doesn't shift.
            // DSH's menu wraps its button in a box of its own, which takes the menu's class: that box is what sits in the row.
            '.dshc-tree-row>.dshc-tree-act{flex:none;display:inline-flex;margin-left:auto;margin-right:-6px}',
            '.dshc-tree-meta+.dshc-tree-act{margin-left:4px}',
            '.dshc-tree-more{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,4px);background:none;color:var(--dshc-text-2);cursor:pointer;visibility:hidden}',
            '.dshc-tree-more:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
            '.dshc-tree-row:hover .dshc-tree-more,.dshc-tree-item:focus-visible>.dshc-tree-row .dshc-tree-more,.dshc-tree-more:focus,.dshc-tree-more[aria-expanded="true"]{visibility:visible}',
            '.dshc-pg-count{font-size:13px;line-height:20px;color:var(--dshc-text-2)}',
            '.dshc-pg-hint{max-width:560px;margin:-6px 0 14px;font-size:13px;line-height:20px;color:var(--dshc-text-2)}',
            '.dshc-pg-heading .dshc-pg-new{margin-left:auto;align-self:center}',
            '.dshc-pg-note{display:flex;align-items:center;gap:8px;margin:-4px 0 12px;padding:5px 5px 5px 12px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);font-size:13px;line-height:20px;color:var(--dshc-text-2)}',
            '.dshc-pg-note>svg{flex:none}',
            '.dshc-pg-note.dshc-pg-problems{align-items:flex-start;padding:8px 12px;color:var(--dsw-alias-label-primary)}',
            '.dshc-pg-problems>svg{margin-top:3px}',
            '.dshc-pg-problems strong{font-weight:500}',
            '.dshc-pg-note>span{flex:1;min-width:0}',
            // The note's ×: a small icon button, its ring drawn inset.
            '.dshc-pg-dismiss{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dshc-glyph);cursor:pointer}',
            '.dshc-pg-dismiss:hover,.dshc-pg-dismiss:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
            `.dshc-pg-dismiss:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            // Find by name, above the tree; a found name's words are marked in its title.
            '.dshc-pg-find{position:relative;max-width:360px;margin:0 0 10px}',
            '.dshc-pg-find .dshc-pg-find-box{display:flex;width:100%;box-sizing:border-box}',
            '.dshc-pg-find .dshc-pg-find-query{padding-right:34px}',
            '.dshc-pg-find-clear{position:absolute;top:50%;right:4px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:none;color:var(--dshc-text-2);cursor:pointer;transform:translateY(-50%)}',
            '.dshc-pg-find-clear:hover,.dshc-pg-find-clear:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshc-pg-find-clear:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshc-pg-state.dshc-pg-find-none{padding:6px 8px}',
            '.dshc-tree-hit{background:none;color:inherit;font-weight:600}',
            '.dshc-pg-state{padding:48px 0;font-size:13px;line-height:20px;color:var(--dshc-text-2)}',
            `.dshc-pg-state.dshc-pg-error{color:${ERROR_TEXT}}`,
            '.dshc-pg-retry{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:12px;color:inherit;vertical-align:middle;cursor:pointer}',
            '.dshc-pg-retry:hover,.dshc-pg-retry:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshc-pg-retry:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshc-pg-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:72px 20px;text-align:center;color:var(--dshc-text-2)}',
            '.dshc-pg-empty-glyph{display:inline-flex;margin-bottom:4px;color:var(--dshc-glyph)}',
            '.dshc-pg-empty h2{margin:0;font-size:15px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
            '.dshc-pg-empty p{max-width:440px;margin:0;font-size:13px;line-height:21px}',
            // The dialogs (New category, Rename, Delete) and a menu item's quieter part, shared with the session list's menus.
            '.dshc-menu-from{color:var(--dsw-alias-label-secondary)}',
            '.dshc-pg-dialog.dshc-pg-dialog{width:min(440px,100%)}',
            '.dshc-pg-input{box-sizing:border-box;width:100%;height:44px;padding:7px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:none;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);outline:none}',
            // Drawn over the edge, not inside the border, so the 2 px reach the field's own edge on every side.
            `.dshc-pg-input:focus{outline:2px solid ${RING};outline-offset:-2px}`,
            '.dshc-pg-input::placeholder{color:var(--dsw-alias-label-secondary)}',
            '.dshc-pg-input:disabled{color:var(--dsw-alias-label-dimmed)}',
            `.dshc-pg-dialog-error{margin-top:8px;font-size:12px;line-height:18px;color:${ERROR_TEXT}}`,
            `.dshc-pg-danger:not(:disabled){color:${ERROR_TEXT}}`,
            // Category headers in DSH's session list (sidebarRules places DSH's rows under them)
            '.dshc-sb-head{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:30px;margin-top:10px;padding:0 8px;border-radius:var(--dsw-radius-md);font-size:13px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none;outline:none}',
            '.dshc-sb-head:is(:hover,[data-categories-menu-open]){background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshc-sb-head:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshc-sb-lead{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}',
            '.dshc-sb-chev{display:inline-flex;color:var(--dsw-alias-label-secondary);transition:transform .15s var(--ds-ease-in-out,ease)}',
            '.dshc-sb-head[aria-expanded=true] .dshc-sb-chev{transform:rotate(90deg)}',
            '.dshc-sb-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshc-sb-dot{flex:none;display:inline-flex;align-items:center}',
            // The same dot on a folded workspace's own row, in the plugin's seat before DSH's row actions (markWorkspaceDots).
            '.dshc-ws-dot{flex:none;display:inline-flex;align-items:center}',
            '.dshc-sb-count{flex:none;min-width:18px;font-size:12px;font-weight:400;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
            // A header's ⋯ takes the count's place while the header is pointed at, focused or its menu is open, as DSH's rows show theirs.
            '.dshc-sb-more{flex:none;display:none;align-items:center;justify-content:center;width:20px;height:20px;margin-right:-2px;padding:0;border:0;border-radius:var(--dsw-radius-sm,4px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}',
            '.dshc-sb-more:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
            // Shown while it has the keyboard too (DSH's menu hands it back there when it closes), or the focus would drop.
            '.dshc-sb-head:is(:hover,:focus-visible,:focus-within,[data-categories-menu-open]) .dshc-sb-more{display:inline-flex}',
            '.dshc-sb-head:is(:hover,:focus-visible,[data-categories-menu-open]) .dshc-sb-count{display:none}',
            // Motion stops where the person asked for none: their system's setting, or Wallpaper's Still.
            '@media (prefers-reduced-motion:reduce){.dshc-sb-chev{transition:none}}',
            'body.wp-still .dshc-sb-chev{transition:none}',
            // Dragging a category or a workspace: what moves is dimmed, the category it goes into is lit, and DSH's line shows where.
            '[data-categories-dragging]{opacity:.5}',
            '.dshc-sb-head[data-categories-drop]{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}',
            // Other workspaces with nothing in it shows only while a workspace is dragged, as somewhere to drop it. It
            // goes last in a list that scrolls, so it is held at the list's lower edge, in sight wherever the list is
            // scrolled, on the sidebar's own fill so the rows under it don't show through.
            '.dshc-sb-head.dshc-sb-pinned{position:sticky;bottom:0;z-index:1;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base))}',
            '.dshc-sb-head.dshc-sb-pinned:is(:hover,[data-categories-drop]){background:linear-gradient(var(--dsw-alias-interactive-bg-hover),var(--dsw-alias-interactive-bg-hover)) var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base))}',
            // Over DSH's window, under its floating layers (menus from 100 up), as DSH's own line is.
            `.dshc-sb-drop-line{position:fixed;z-index:99;height:12px;pointer-events:none;background:${DROP_LINE}}`,
            '.dshc-sb-drop-line[hidden]{display:none}',
            // The chip at the top of a session: its category and workspace, among DSH's header actions. Those never
            // shrink; while they show the chip they may, by the chip alone, before the title does. Its text breaks at
            // any letter, so its least width is a letter, and it shows one line, cut at a letter with "…" as DSH's
            // title is. Found by DSH's markup (the actions are the box right after the title's nav, which the chip
            // marks: useChipHost), not by its generated class names.
            `@container (width>600px){nav[aria-label]+[${CHIP_HOST}]{flex-shrink:1000}}`,
            `@container (width>600px){nav[aria-label]+[${CHIP_HOST}]>[data-slot]>:not([data-categories-chip]){flex-shrink:0}}`,
            '.dshc-chip{flex:0 1000 auto;display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;min-width:0;max-width:280px;min-height:28px;padding:3px 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:left}',
            'button.dshc-chip{cursor:pointer}',
            'button.dshc-chip:hover,button.dshc-chip:focus-visible{color:var(--dsw-alias-label-primary)}',
            `button.dshc-chip:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshc-chip-glyph{flex:none;color:var(--dsw-alias-label-tertiary)}',
            '.dshc-chip-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;min-width:0;overflow:hidden;word-break:break-all}',
            '.dshc-chip-sep{margin:0 4px;color:var(--dsw-alias-label-caption)}',
            // Gone where the header is narrow (a chat with a pane open beside it), before DSH drops its own labels
            // (540 px and less); DSH's header is then as DSH draws it.
            '@container (width<=600px){.dshc-chip{display:none}}',
            `.dshc-sr{${HIDDEN}}`,
        ].join('');
        const CSS_ID = `${BUNDLE}/client.css`;
        /**
         * The plugin's style sheet, one per window, while the plugin runs: its
         * disposer takes it out again, so switched off in Plugins the plugin
         * leaves no rule behind. A sheet already there (an earlier copy's) is
         * taken over rather than doubled. Never throws.
         * @returns the sheet, or undefined where it could not be added.
         */
        function addStyles() {
            try {
                if (typeof document === 'undefined') return undefined;
                const found = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`);
                if (found) {
                    found.textContent = CSS;
                    return found;
                }
                const tag = document.createElement('style');
                tag.dataset.plugin = BUNDLE;
                tag.dataset.pluginCss = CSS_ID;
                tag.textContent = CSS;
                document.head.appendChild(tag);
                return tag;
            } catch (error) {
                console.warn(`[categories] could not add the plugin's styles: ${error?.message ?? error}`);
                return undefined;
            }
        }

        // ── Shared ─────────────────────────────────────────────────────────

        const EMPTY = Object.freeze([]);
        /** A set with nothing in it, never added to. */
        const EMPTY_SET = new Set();
        const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
        /** Two lists with the same items in the same order. */
        const sameList = (a, b) => a === b || (a.length === b.length && a.every((item, i) => item === b[i]));
        const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
        /** Names as a sentence lists them: "A", "A and B", "A, B and C". */
        const listText = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
        /** A path with the home folder as ~, as DSH's session list shows paths. */
        const shortPath = (path) => String(path ?? '').replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');

        /** A folder's own name from its path ("storefront" from "/work/storefront/"). */
        function folderName(path) {
            const parts = String(path).split(/[\\/]+/).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : String(path);
        }

        /**
         * A DSH workspace's name as its row shows it: its title, or its folder's name; DSH's own default workspace
         * (titled "default-workspace") by the name DSH's list gives it (its `workspaceDisplayTitle`).
         */
        const workspaceTitle = (ws) => {
            const title = typeof ws?.title === 'string' && ws.title !== '' ? ws.title : folderName(ws?.path ?? ws?.workspaceId ?? '');
            return title === 'default-workspace' ? 'Default workspace' : title;
        };

        /** The workspace in DSH's list that holds a session (the first that lists it, as DSH finds it), or undefined. */
        function workspaceOfSession(workspaces, sessionId) {
            for (const ws of Array.isArray(workspaces?.items) ? workspaces.items : EMPTY) {
                if (typeof ws?.workspaceId === 'string' && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) return ws.workspaceId;
            }
            return undefined;
        }

        /** What the window says wherever it shows. */
        const TEXT = {
            unreachable: 'The categories plugin didn\'t answer. If it was just updated, restart DSH so the new version loads.',
            retry: 'Retry',
            // A session's dot, as DSH's own: waiting on the user, or running.
            needsYou: 'Needs you',
            running: 'Running',
        };

        /**
         * The plugin's endpoints over the window's own connection: POST
         * /api/dsh-plugin-categories/<method> with `{args}`, answered
         * `{ok: true, value}` or `{ok: false, error: {code, message}}`.
         * Never throws: a failed call answers as a refusal does.
         * @param connectionOf - DSH's `connection` service, or undefined until DSH provides it.
         */
        function hostLink(connectionOf) {
            return {
                async call(method, args) {
                    try {
                        const connection = connectionOf();
                        if (!connection) throw new Error('the window is not connected to DSH yet');
                        const result = await connection.rpc.call('/api', `${BUNDLE}/${method}`, { args });
                        if (isObject(result) && (result.ok === true || (result.ok === false && isObject(result.error)))) return result;
                        return { ok: false, error: { code: 'categories/unreadable', message: 'The plugin sent an answer this window can\'t read.' } };
                    } catch (error) {
                        return { ok: false, error: { code: 'categories/unreachable', message: String(error?.message ?? error) } };
                    }
                },
            };
        }

        /** A failed call as one sentence: the plugin's own refusal, or that it can't be reached. */
        function errorText(error) {
            const code = String(error?.code ?? '');
            const message = String(error?.message ?? '').trim();
            if (code === 'categories/refused' && message) return `${message.replace(/^./, (c) => c.toUpperCase())}${/[.!?]$/.test(message) ? '' : '.'}`;
            if (code === 'categories/unreachable' || code.startsWith('gateway/not') || code.startsWith('rpc/')) return TEXT.unreachable;
            return message ? `The change didn't go through: ${message}` : TEXT.unreachable;
        }

        /**
         * The categories as the plugin keeps them (its `list` endpoint),
         * shared by the session list and the Categories page: each category
         * in its order, with the workspaces it holds in DSH's order. Read at
         * start, and again every 15 s while a view watches and the window is
         * visible; a change made in this window answers with the new list,
         * which every view shows at once.
         * @param link - the plugin's endpoints (hostLink).
         */
        function categoryFacts(link) {
            const listeners = new Set();
            let version = 0;
            /** The categories as last answered (null until an answer came), and whether the last read failed. */
            let listed = null;
            let failed = false;
            /** Switched off in the plugin's settings (the host said so), and the settings that were wrong, in words. */
            let off = false;
            let problems = EMPTY;
            /** What is wrong with the plugin's store, in words ({problem, text}: a save that failed, a file it couldn't use), else null. */
            let storeNote = null;
            let reading = null;
            let again = false;
            let last = 0;
            /** Changes answered so far: a list read sent before a change answered may predate it, so it is let go. */
            let changes = 0;
            let watching = 0;
            let timer;
            const emit = () => {
                version += 1;
                for (const listener of [...listeners]) listener();
            };
            const take = (value) => {
                failed = false;
                listed = value.categories.filter((c) => isObject(c) && typeof c.id === 'string');
                // The list's answer says both (a change's answer says neither, and leaves them as they were).
                if ('problems' in value || 'off' in value) {
                    off = value.off === true;
                    problems = Array.isArray(value.problems) ? value.problems.filter((p) => isObject(p) && typeof p.text === 'string') : EMPTY;
                }
                // The list's answer and each change's say how the store is.
                if ('store' in value) storeNote = isObject(value.store) && typeof value.store.text === 'string' ? value.store : null;
                emit();
            };
            /**
             * Read the list, unless a read is under `maxAge` ms old. One read
             * runs at a time; a read asked for now (`maxAge` 0) while one
             * runs runs again after it, so nothing changed meanwhile is missed.
             */
            const list = (maxAge = 0) => {
                if (reading) {
                    if (maxAge === 0) again = true;
                    return reading;
                }
                if (Date.now() - last < maxAge) return Promise.resolve();
                const before = changes;
                reading = Promise.resolve().then(() => link.call('list', {})).then((result) => {
                    if (changes !== before) return;
                    if (result?.ok === true && Array.isArray(result.value?.categories)) take(result.value);
                    else if (!failed) {
                        failed = true;
                        emit();
                    }
                }).catch(() => {}).finally(() => {
                    last = Date.now();
                    reading = null;
                    if (again) {
                        again = false;
                        void list(0);
                    }
                });
                return reading;
            };
            const tick = () => {
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
                void list(10000);
            };
            return {
                subscribe(listener) {
                    listeners.add(listener);
                    return () => { listeners.delete(listener); };
                },
                getSnapshot: () => version,
                /** Every category in its order, with the workspaces it holds in DSH's order; null until `list` answered. */
                categories: () => listed,
                /** Whether the last read failed. */
                listFailed: () => failed,
                /** Whether the plugin is switched off in its settings (then the window draws DSH's list as it is). */
                off: () => off,
                /** The plugin's settings that were wrong, each `{key, text}` in words (each counts as its default). */
                problems: () => problems,
                /** What is wrong with the plugin's store, `{problem, text}` in words, else null. */
                store: () => storeNote,
                list,
                /** Keep the list read while the returned function has not been called. */
                watch() {
                    watching += 1;
                    void list(5000);
                    timer ??= setInterval(tick, 15000);
                    let on = true;
                    return () => {
                        if (!on) return;
                        on = false;
                        watching -= 1;
                        if (watching === 0 && timer !== undefined) {
                            clearInterval(timer);
                            timer = undefined;
                        }
                    };
                },
                /**
                 * A change from the session list or the Categories page
                 * (`createCategory`, `renameCategory`, `removeCategory`,
                 * `moveCategory`, `fileWorkspace`); the categories it answers
                 * with update every view.
                 */
                async act(method, args) {
                    const result = await link.call(method, args);
                    if (result.ok === true && Array.isArray(result.value?.categories)) {
                        changes += 1;
                        take(result.value);
                    } else if (result.ok !== true) {
                        // Refused or failed: read the list again, so a store that couldn't be written is named at once.
                        void list(0);
                    }
                    return result;
                },
            };
        }

        /** Re-render when the categories change. */
        const useFacts = (facts) => React.useSyncExternalStore(facts.subscribe, facts.getSnapshot);
        /** Keep the categories read while `on`. */
        function useWatch(facts, on = true) {
            React.useEffect(() => (on ? facts.watch() : undefined), [facts, on]);
        }

        /** For a DSH without workspaces on a view's props: none. */
        const NO_WORKSPACES = Object.freeze({ items: EMPTY, archivedSessionIds: EMPTY, phase: 'none' });
        const noWorkspaces = (select) => select(NO_WORKSPACES);
        const noStatuses = (select) => select(new Map());
        /** For a DSH without sessions on a view's props: none. */
        const NO_SESSIONS = Object.freeze({ ids: EMPTY, byId: Object.freeze({}) });
        const noSessions = (select) => select(NO_SESSIONS);

        /** A chat's dot as DSH's session list draws it: waiting on the user, running, or none. */
        function chatDot(row, statuses) {
            const status = statuses?.get?.(row.id);
            if (status?.pendingInteraction) return 'warning';
            return (status?.running ?? row.running) === true ? 'ongoing' : null;
        }

        /**
         * A set of ids kept in the window's storage, so it holds across
         * restarts (the items closed in the page's tree, the sidebar's folded
         * categories, a note dismissed). Without storage it lasts until the
         * window closes.
         */
        function useStoredSet(key) {
            const [set, setSet] = React.useState(() => {
                try {
                    const saved = JSON.parse(window.localStorage.getItem(key) ?? '[]');
                    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : EMPTY);
                } catch {
                    return new Set();
                }
            });
            const first = React.useRef(true);
            React.useEffect(() => {
                if (first.current) { first.current = false; return; }
                try { window.localStorage.setItem(key, JSON.stringify([...set])); } catch { /* no storage */ }
            }, [set]);
            /** Add or remove an id; `on` undefined flips it. */
            const toggle = React.useCallback((id, on) => setSet((prev) => {
                const next = on === undefined ? !prev.has(id) : on;
                if (next === prev.has(id)) return prev;
                const copy = new Set(prev);
                if (next) copy.add(id);
                else copy.delete(id);
                return copy;
            }), []);
            return [set, toggle];
        }

        /** Other workspaces' id on the page and in the sidebar: the workspaces in no category. */
        const OTHERS = '@others';

        // ── Categories page ────────────────────────────────────────────────

        const PAGE = {
            /** The entry in DSH's sidebar that opens the page, named as the page is headed. */
            entry: 'Categories',
            title: 'Categories',
            loading: 'Loading categories…',
            emptyTitle: 'No workspaces yet',
            emptyText: 'Add a workspace in DSH\'s sidebar and it shows up here. Categories group workspaces, and each workspace holds its chats.',
            // New category on the page takes the sidebar's words (SIDEBAR) but this text: workspaces are filed in DSH's sidebar.
            newText: 'It starts empty and goes last. Add workspaces from its ⋯ menu, here or in DSH\'s sidebar, or drag them onto it there.',
            // What a category's row says it is, so it never reads as the workspace it holds.
            category: 'Category',
            cancel: 'Cancel',
            close: 'Close',
            newChat: 'New chat',
            find: 'Find by name',
            findClear: 'Clear the find',
            findNone: (words) => `Nothing matches “${words}”.`,
            // What Alt+↑ and Alt+↓ say on the page's tree.
            movedUp: (name) => `${name} moved up.`,
            movedDown: (name) => `${name} moved down.`,
            firstAlready: (name) => `${name} is first already.`,
            lastAlready: (name) => `${name} is last already.`,
            othersLast: 'Other workspaces stays last: it holds the workspaces in no category.',
            // A workspace's ⋯ on the page (DSH's own workspace menu has no seat for the plugin).
            workspaceActions: (name) => `Workspace actions: ${name}`,
            moveTo: 'Move to',
            noCategories: 'No categories yet',
            newWithIt: 'New category with it…',
            offTitle: 'Categories are switched off',
            offText: 'The categories row in the profile\'s cordis.patch.yml switches them off (its enabled setting), so DSH\'s session list shows your workspaces as DSH lists them. Your categories are kept: set enabled: true (or remove the line) and restart DSH, and they come back as they were.',
            // With workspaces but no category yet: what categories are for, and the way to the first.
            noneYet: 'Group your workspaces into categories: New category makes one, then add workspaces to it from its ⋯ menu, here or in DSH\'s session list, or drag them onto it there.',
            // What is wrong with the plugin's own file, as the host says it (a save that failed, a file it couldn't use).
            storeTitle: { unsaved: 'Not saved', unusable: 'The categories file couldn\'t be used', kept: 'The categories file couldn\'t be used' },
            problemsTitle: 'A setting is wrong',
            problemsFix: 'Change it in the categories row of the profile\'s cordis.patch.yml, then restart DSH.',
            imported: (names) => `Imported from your old sidebar: ${listText(names)}, with ${names.length === 1 ? 'its' : 'their'} workspaces. ${names.length === 1 ? 'Its' : 'Their'} old instructions, files and defaults for new sessions weren't carried over.`,
            dismiss: 'Dismiss',
        };

        /**
         * The Categories entry's icon, drawn like DSH's own (a 16 px grid, a
         * 1 px stroke, its folder's shape): a folder with another behind it,
         * folders grouped.
         */
        function CategoriesIcon({ size = 16 }) {
            return h('svg', {
                width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1, 'aria-hidden': true,
            },
            h('path', { d: 'M1.5 6.1C1.5 5.55 1.95 5.1 2.5 5.1H5C5.24 5.1 5.48 5.19 5.66 5.35L6.92 6.46C7.1 6.62 7.34 6.71 7.58 6.71H11.5C12.05 6.71 12.5 7.16 12.5 7.71V13C12.5 13.55 12.05 14 11.5 14H2.5C1.95 14 1.5 13.55 1.5 13V6.1Z' }),
            h('path', { d: 'M3.5 5.1V3.1C3.5 2.55 3.95 2.1 4.5 2.1H7C7.24 2.1 7.48 2.19 7.66 2.35L8.92 3.46C9.1 3.62 9.34 3.71 9.58 3.71H13.5C14.05 3.71 14.5 4.16 14.5 4.71V10C14.5 10.55 14.05 11 13.5 11H12.5' }));
        }

        /** The import note on the page, once dismissed. */
        const NOTE_KEY = `${BUNDLE}/page-notes`;
        /** Where the page's closed tree items are kept (the window's own storage); every item starts open. */
        const CLOSED_KEY = `${BUNDLE}/page-closed`;

        /** The name dialog for New category and Rename: DSH's own rename dialog, with the plugin's refusal under the field. */
        function NameDialog({ title, description, label, initial = '', action, busyLabel, onSubmit, onClose }) {
            const [draft, setDraft] = React.useState(initial);
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const composing = React.useRef(false);
            const alive = React.useRef(true);
            const field = React.useRef(null);
            React.useEffect(() => () => { alive.current = false; }, []);
            // Refused: the field had the keyboard, and lost it while it waited (disabled), so it takes it back.
            React.useEffect(() => { if (error && !busy) field.current?.focus(); }, [error, busy]);
            const clean = draft.replace(/\s+/g, ' ').trim();
            const submit = async () => {
                if (busy || clean === '') return;
                if (initial !== '' && clean === initial) {
                    onClose();
                    return;
                }
                setBusy(true);
                setError('');
                const problem = await onSubmit(clean);
                if (alive.current && problem) {
                    setBusy(false);
                    setError(problem);
                }
            };
            return h(ui.Modal, {
                open: true, title, description, closeLabel: PAGE.close, className: 'dshc-pg-dialog',
                onClose: () => { if (!busy) onClose(); },
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', disabled: busy, onClick: onClose }, PAGE.cancel),
                    h(ui.Button, { variant: 'primary', disabled: busy || clean === '', onClick: () => void submit(), 'data-categories-dialog-submit': '' }, busy ? busyLabel : action)),
            },
            h('input', {
                ref: field, className: 'dshc-pg-input', value: draft, 'aria-label': label, placeholder: label, maxLength: 120,
                'data-modal-autofocus': true, 'data-categories-name-input': '', disabled: busy,
                onFocus: (event) => event.target.select(),
                onChange: (event) => {
                    setDraft(event.target.value);
                    setError('');
                },
                onCompositionStart: () => { composing.current = true; },
                onCompositionEnd: () => { composing.current = false; },
                onKeyDown: (event) => {
                    if (event.key !== 'Enter' || composing.current) return;
                    event.preventDefault();
                    void submit();
                },
            }),
            error ? h('div', { className: 'dshc-pg-dialog-error', role: 'alert' }, error) : null);
        }

        /** A question before something is deleted, as DSH asks before it deletes a workspace. */
        function ConfirmDialog({ title, text, action, busyLabel, onSubmit, onClose }) {
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = React.useRef(true);
            React.useEffect(() => () => { alive.current = false; }, []);
            // Refused: the keyboard goes back to the button that asked (it lost it while it waited, disabled).
            React.useEffect(() => {
                if (error && !busy && typeof document !== 'undefined') document.querySelector('.dshc-pg-dialog [data-categories-dialog-submit]')?.focus();
            }, [error, busy]);
            const submit = async () => {
                if (busy) return;
                setBusy(true);
                setError('');
                const problem = await onSubmit();
                if (alive.current && problem) {
                    setBusy(false);
                    setError(problem);
                }
            };
            return h(ui.Modal, {
                open: true, title, description: text, closeLabel: PAGE.close, className: 'dshc-pg-dialog',
                onClose: () => { if (!busy) onClose(); },
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', disabled: busy, onClick: onClose, 'data-modal-autofocus': true }, PAGE.cancel),
                    h(ui.Button, { variant: 'outline', className: 'dshc-pg-danger', disabled: busy, onClick: () => void submit(), 'data-categories-dialog-submit': '' }, busy ? busyLabel : action)),
            }, error ? h('div', { className: 'dshc-pg-dialog-error', role: 'alert' }, error) : undefined);
        }

        /**
         * The page's tree: Category › Workspace › session, each category's
         * workspaces in DSH's own order and each workspace's sessions in DSH's
         * order, every one of them (no "Show more"), but archived ones and an
         * empty New Session; workspaces in no category come last, under Other
         * workspaces. A session is DSH's own row: its DSH title, whatever it
         * is to another plugin.
         * @param categories - the categories as `list` answered, in their order.
         * @param items - DSH's workspaces, in DSH's order.
         * @param sessions - DSH's session list ({byId}).
         * @param archived - DSH's archived session ids.
         * @returns {Array<{kind, id, title, children, row?, path?}>}
         */
        function pageModel({ categories, items, sessions, archived }) {
            const byId = sessions?.byId ?? {};
            const hidden = (id) => { const row = byId[id]; return !row || row.blank === true || archived.has(id); };
            const titleOf = (row) => (typeof row?.title === 'string' && row.title.trim() !== '' ? row.title : PAGE.newChat);
            // A session once, in the first workspace that lists it.
            const drawn = new Set();
            const workspace = (ws) => {
                const ids = (Array.isArray(ws.sessionIds) ? ws.sessionIds : EMPTY).filter((id) => typeof id === 'string' && !hidden(id) && !drawn.has(id));
                for (const id of ids) drawn.add(id);
                return {
                    kind: 'workspace', id: ws.workspaceId, title: workspaceTitle(ws), path: ws.path ?? '',
                    children: ids.map((id) => ({ kind: 'session', id, title: titleOf(byId[id]), row: byId[id], children: EMPTY })),
                };
            };
            const listed = items.filter((ws) => typeof ws?.workspaceId === 'string');
            const filed = new Set();
            const tree = (Array.isArray(categories) ? categories : EMPTY).filter((c) => isObject(c) && typeof c.id === 'string').map((c) => {
                const ids = new Set((Array.isArray(c.workspaces) ? c.workspaces : EMPTY).map((w) => w?.id));
                const own = listed.filter((ws) => ids.has(ws.workspaceId) && !filed.has(ws.workspaceId));
                for (const ws of own) filed.add(ws.workspaceId);
                return { kind: 'category', id: c.id, title: typeof c.name === 'string' && c.name !== '' ? c.name : c.id, children: own.map(workspace) };
            });
            const loose = listed.filter((ws) => !filed.has(ws.workspaceId));
            if (loose.length > 0) tree.push({ kind: 'category', id: OTHERS, title: SIDEBAR.others, children: loose.map(workspace) });
            return tree;
        }

        /** The items a tree shows now, in drawn order, each with its key, level, parent and place among its siblings. */
        function visibleItems(tree, closed) {
            const out = [];
            const walk = (nodes, level, parent) => nodes.forEach((node, i) => {
                const key = `${node.kind}:${node.id}`;
                const open = node.children.length > 0 && !closed.has(key);
                out.push({ node, key, level, parent, pos: i + 1, size: nodes.length, open });
                if (open) walk(node.children, level + 1, key);
            });
            walk(tree, 1, null);
            return out;
        }

        /**
         * What Alt+↑ (by -1) or Alt+↓ (by 1) on the page's tree does to an
         * item: a category moves past its neighbour; a workspace moves past
         * its neighbour in its category, and from either end into the next
         * category, where it goes in nearest that end (Other workspaces, past
         * the last category, puts it in none). Where there is nowhere to go,
         * `refuse` says so. null for an item that has no place to change (a
         * session's is DSH's).
         * @param tree - the page's whole tree (pageModel), not one a find cut down.
         * @returns {{method: string, args: object, said: string, open?: string}|{refuse: string}|null}
         *   the categories call to make, what to say once it's done, and the item to open so the moved one shows.
         */
        function pageMove(tree, key, by) {
            const cats = Array.isArray(tree) ? tree : EMPTY;
            const at = String(key ?? '').indexOf(':');
            const kind = String(key ?? '').slice(0, Math.max(0, at));
            const id = String(key ?? '').slice(at + 1);
            const real = cats.filter((c) => c.id !== OTHERS);
            if (kind === 'category') {
                const c = cats.find((x) => x.id === id);
                if (!c) return null;
                if (id === OTHERS) return { refuse: PAGE.othersLast };
                const i = real.indexOf(c);
                if (by < 0 && i === 0) return { refuse: PAGE.firstAlready(c.title) };
                if (by > 0 && i === real.length - 1) return { refuse: PAGE.lastAlready(c.title) };
                const before = by < 0 ? real[i - 1].id : real[i + 2]?.id ?? '';
                return { method: 'moveCategory', args: { category: id, before }, said: by < 0 ? PAGE.movedUp(c.title) : PAGE.movedDown(c.title) };
            }
            if (kind !== 'workspace') return null;
            const ci = cats.findIndex((c) => c.children.some((w) => w.kind === 'workspace' && w.id === id));
            if (ci < 0) return null;
            const list = cats[ci].children;
            const i = list.findIndex((w) => w.id === id);
            const ws = list[i];
            const filed = (c) => (c.id === OTHERS ? '' : c.id);
            if (by < 0 && i > 0) return { method: 'fileWorkspace', args: { workspace: id, category: filed(cats[ci]), before: list[i - 1].id }, said: PAGE.movedUp(ws.title) };
            if (by > 0 && i < list.length - 1) return { method: 'fileWorkspace', args: { workspace: id, category: filed(cats[ci]), before: list[i + 2]?.id ?? '' }, said: PAGE.movedDown(ws.title) };
            // Past the last category is Other workspaces, though no workspace is there yet.
            const next = cats[ci + by] ?? (by > 0 && cats[ci].id !== OTHERS ? { id: OTHERS, title: SIDEBAR.others, children: EMPTY } : undefined);
            if (!next) return { refuse: by < 0 ? PAGE.firstAlready(ws.title) : PAGE.lastAlready(ws.title) };
            return {
                method: 'fileWorkspace', args: { workspace: id, category: filed(next), before: by < 0 ? '' : next.children[0]?.id ?? '' },
                said: SIDEBAR.filed(ws.title, next.title), open: `category:${next.id}`,
            };
        }

        const TREE_GLYPHS = { category: 'IconFolderCloseRegular', workspace: 'IconFolderOpenOutlineRegular' };

        /**
         * What a tree row says after its title: a category says what it is
         * and how many workspaces it holds, so it never reads as the workspace
         * inside it (they can share a name); a workspace shows its path. Other
         * workspaces is no category: it holds the workspaces in none.
         */
        function treeMeta(node) {
            // All an item holds, though a find shows only part of it.
            const held = node.whole ?? node.children;
            const n = held.length;
            if (node.kind === 'category') return node.id === OTHERS ? plural(n, 'workspace') : `${PAGE.category} · ${plural(n, 'workspace')}`;
            return node.kind === 'workspace' && node.path ? shortPath(node.path) : null;
        }

        /** The dot after a session's title, DSH's own (running, or waiting on the user), with what it means; null for none. */
        function treeDot(node, statuses) {
            const dot = node.kind === 'session' && node.row ? chatDot(node.row, statuses) : null;
            return dot ? { dot, label: dot === 'warning' ? TEXT.needsYou : TEXT.running } : null;
        }

        /**
         * The Categories page's tree, as a screen reader and the keys expect:
         * one tab stop, Up and Down in drawn order, Right opens or goes in,
         * Left closes or goes to the parent, Home and End, Enter opens a
         * session or opens and closes a category or a workspace. Alt+↑ and
         * Alt+↓ move a category or a workspace (onMove, pageMove), and the
         * moved item keeps the focus. An item with a menu has ⋯ at the end
         * of its row, and a right-click, Shift+F10 or the context-menu key
         * opens it too.
         * @param onMove - (key, by) => null for an item that doesn't move, else {open?: the key of an item to open}.
         * @param menu - {has(node), draw({node, open, setOpen, reveal(key), keep(), focus()})}: which items have a menu,
         *   and each one's (an element), told how to open an item, to keep the focus on this one while it moves, and
         *   to give it the focus (before a dialog opens, so the dialog gives the focus back there when it closes).
         * @param keepRef - optional: the ref of the item to keep the focus on ({key, until}), shared with the page.
         */
        function PageTree({ tree, label, onOpenSession, onMove, menu, statuses, find = '', treeRef, keepRef }) {
            const [stored, toggleStored] = useStoredSet(CLOSED_KEY);
            // While a find is on, everything it keeps starts open, and what is closed then is forgotten when the
            // find changes (React's way to reset state when a prop changes: set it while drawing).
            const [found, setFound] = React.useState({ find, closed: EMPTY_SET });
            if (found.find !== find) setFound({ find, closed: EMPTY_SET });
            const finding = find.trim() !== '';
            const closed = !finding ? stored : found.find === find ? found.closed : EMPTY_SET;
            const toggleClosed = !finding ? toggleStored : (key, on) => setFound((prev) => {
                const copy = new Set(prev.find === find ? prev.closed : EMPTY_SET);
                if (on) copy.add(key);
                else copy.delete(key);
                return { find, closed: copy };
            });
            const shown = visibleItems(tree, closed);
            const [current, setCurrent] = React.useState(null);
            const refs = React.useRef(new Map());
            // A moved item keeps the focus for a while, though React may draw it anew in another part of the tree. The
            // page sets it too (keepRef): after a dialog, the item that takes a deleted one's place, or a workspace that
            // moved into a new category.
            const ownKeep = React.useRef(null);
            const keep = keepRef ?? ownKeep;
            React.useLayoutEffect(() => {
                const k = keep.current;
                if (k === null || typeof document === 'undefined') return;
                if (Date.now() > k.until) { keep.current = null; return; }
                const el = refs.current.get(k.key);
                const active = document.activeElement;
                if (el && el !== active && (active === null || active === document.body)) el.focus();
            });
            const at = Math.max(0, shown.findIndex((x) => x.key === current));
            const focusKey = (key) => { keep.current = null; setCurrent(key); refs.current.get(key)?.focus(); };
            // The item whose menu is open. One opened by Shift+F10 or the context-menu key hands the keyboard to the row's
            // ⋯ once it shows, as DSH's menu walks its items (↓, ↑, Home, End) from its own button, and gives it back there.
            const [menuKey, setMenuKey] = React.useState(null);
            const byKey = React.useRef(false);
            React.useLayoutEffect(() => {
                if (menuKey === null || !byKey.current) return;
                byKey.current = false;
                refs.current.get(menuKey)?.querySelector(':scope>.dshc-tree-row .dshc-tree-more')?.focus();
            }, [menuKey]);
            const activate = (x) => {
                if (x.node.kind === 'category' || x.node.kind === 'workspace') { if (x.node.children.length > 0) toggleClosed(x.key, x.open); }
                else onOpenSession(x.node.id);
            };
            // Clicks and keys in a menu (drawn elsewhere in the page) reach the tree through React, not the page.
            const inside = (event) => !event.target || typeof event.currentTarget?.contains !== 'function' || event.currentTarget.contains(event.target);
            const onKeyDown = (event) => {
                if (!inside(event)) return;
                // A row's ⋯ has its own keys while its menu is open, and Enter and Space always; else the tree's keys work from it.
                const onItem = typeof event.target?.matches !== 'function' || event.target.matches('[role="treeitem"]');
                if (!onItem && (menuKey !== null || event.key === 'Enter' || event.key === ' ')) return;
                const x = shown.find((item) => item.key === current) ?? shown[0];
                if (x && menu?.has(x.node) && !event.altKey && !event.ctrlKey && !event.metaKey && ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) {
                    event.preventDefault();
                    byKey.current = true;
                    setMenuKey(x.key);
                    return;
                }
                if (x && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                    const done = onMove?.(x.key, event.key === 'ArrowUp' ? -1 : 1) ?? null;
                    if (done === null) return;
                    event.preventDefault();
                    if (done.open && closed.has(done.open)) toggleClosed(done.open, false);
                    keep.current = { key: x.key, until: Date.now() + 4000 };
                    return;
                }
                if (!x || event.altKey || event.metaKey || event.ctrlKey) return;
                const i = shown.indexOf(x);
                const go = (y) => { if (y) { event.preventDefault(); focusKey(y.key); } };
                switch (event.key) {
                    case 'ArrowDown': go(shown[i + 1]); break;
                    case 'ArrowUp': go(shown[i - 1]); break;
                    case 'Home': go(shown[0]); break;
                    case 'End': go(shown[shown.length - 1]); break;
                    case 'ArrowRight':
                        event.preventDefault();
                        if (x.node.children.length > 0 && !x.open) toggleClosed(x.key, false);
                        else if (x.open) focusKey(shown[i + 1].key);
                        break;
                    case 'ArrowLeft':
                        event.preventDefault();
                        if (x.open) toggleClosed(x.key, true);
                        else if (x.parent) focusKey(x.parent);
                        break;
                    case 'Enter': case ' ': event.preventDefault(); activate(x); break;
                    default:
                }
            };
            const item = (x) => {
                const { node } = x;
                const kids = x.open ? shown.filter((y) => y.parent === x.key) : EMPTY;
                const Icon = ui[TREE_GLYPHS[node.kind]];
                const dot = treeDot(node, statuses);
                const meta = treeMeta(node);
                const menuOn = menu?.has(node) === true;
                const keys = [
                    onMove && (node.kind === 'workspace' || (node.kind === 'category' && node.id !== OTHERS)) ? 'Alt+ArrowUp Alt+ArrowDown' : '',
                    menuOn ? 'Shift+F10' : '',
                ].filter(Boolean).join(' ');
                return h('li', {
                    key: x.key, role: 'treeitem', 'aria-level': x.level, 'aria-setsize': x.size, 'aria-posinset': x.pos,
                    'aria-expanded': node.children.length > 0 ? x.open : undefined, tabIndex: x === shown[at] ? 0 : -1,
                    'aria-keyshortcuts': keys || undefined,
                    className: `dshc-tree-item dshc-tree-${node.kind}`, 'data-categories-node': node.kind, 'data-categories-id': node.id,
                    ref: (el) => { if (el) refs.current.set(x.key, el); else refs.current.delete(x.key); },
                    onFocus: (event) => { if (event.target === event.currentTarget) setCurrent(x.key); },
                    onClick: (event) => {
                        if (!inside(event)) return;
                        event.stopPropagation();
                        setCurrent(x.key);
                        activate(x);
                    },
                    // A right-click on the row itself (not an item inside it) opens its menu.
                    onContextMenu: menuOn ? (event) => {
                        if (!inside(event) || (event.target?.closest && event.target.closest('[role="treeitem"]') !== event.currentTarget)) return;
                        event.preventDefault();
                        event.stopPropagation();
                        setCurrent(x.key);
                        setMenuKey(x.key);
                    } : undefined,
                },
                h('div', { className: 'dshc-tree-row', style: { paddingInlineStart: `${8 + (x.level - 1) * 20}px` } },
                    // The chevron opens and closes what the item holds.
                    h('span', {
                        className: 'dshc-tree-chevron', 'aria-hidden': true, 'data-categories-chevron': node.children.length > 0 ? '' : undefined,
                        onClick: node.children.length > 0 ? (event) => { event.stopPropagation(); setCurrent(x.key); toggleClosed(x.key, x.open); } : undefined,
                    }, node.children.length > 0 ? h(x.open ? ui.IconChevronDownOutlineRegular : ui.IconChevronRightOutlineRegular, { size: 12 }) : null),
                    h('span', { className: 'dshc-tree-glyph', 'aria-hidden': true }, Icon ? h(Icon, { size: 14 }) : null),
                    h('span', { className: 'dshc-tree-title', 'data-categories-title': node.title }, ...(finding ? withHit(node.title, find) : [node.title])),
                    dot ? h('span', { className: 'dshc-tree-dot', role: 'img', 'aria-label': dot.label, title: dot.label }, ui.StateDot ? h(ui.StateDot, { state: dot.dot }) : null) : null,
                    meta ? h('span', { className: 'dshc-tree-meta' }, meta) : null,
                    menuOn ? menu.draw({
                        node, open: menuKey === x.key,
                        setOpen: (on) => { if (on) setCurrent(x.key); setMenuKey(on ? x.key : null); },
                        reveal: (key) => { if (closed.has(key)) toggleClosed(key, false); },
                        keep: () => { keep.current = { key: x.key, until: Date.now() + 4000 }; },
                        focus: () => { const el = refs.current.get(x.key); if (el && typeof document !== 'undefined' && document.activeElement !== el) el.focus({ preventScroll: true }); },
                    }) : null),
                kids.length > 0 ? h('ul', { role: 'group', className: 'dshc-tree-group' }, ...kids.map(item)) : null);
            };
            return h('ul', { role: 'tree', 'aria-label': label, className: 'dshc-tree', onKeyDown, ref: treeRef }, ...shown.filter((x) => x.level === 1).map(item));
        }

        /**
         * The tree cut down to a find: an item whose name holds the words (in
         * any case) with everything in it, and the items above each such
         * item, so a match is shown where it lives. Each kept item keeps what
         * it holds in `whole`, so its row still counts all of it.
         */
        function findInTree(nodes, find) {
            const words = String(find ?? '').trim().toLowerCase();
            if (words === '') return nodes;
            const keep = (node) => {
                if (String(node.title).toLowerCase().includes(words)) return node;
                const children = node.children.map(keep).filter(Boolean);
                return children.length > 0 ? { ...node, children, whole: node.whole ?? node.children } : null;
            };
            return nodes.map(keep).filter(Boolean);
        }

        /** A title with the found words marked, as parts to draw. */
        function withHit(title, find) {
            const words = String(find ?? '').trim();
            const at = words === '' ? -1 : String(title).toLowerCase().indexOf(words.toLowerCase());
            if (at < 0) return [title];
            return [title.slice(0, at), h('mark', { key: 'hit', className: 'dshc-tree-hit' }, title.slice(at, at + words.length)), title.slice(at + words.length)].filter((part) => part !== '');
        }

        /**
         * The page the Categories entry in DSH's sidebar opens: the whole
         * tree, with Find by name and New category. Each row says what it is
         * (treeMeta), so a category never reads as the workspace inside it.
         * A category's row has the sidebar's ⋯ menu, and a workspace's has
         * its own (WorkspaceMenu), so everything a drag does in the sidebar
         * can be done here too.
         */
        function CategoriesPage({ useSessions = noSessions, useSessionStatus = noStatuses, useWorkspaces = noWorkspaces, plugin }) {
            useFacts(plugin.facts);
            useWatch(plugin.facts);
            const listed = plugin.facts.categories();
            const failed = plugin.facts.listFailed();
            const off = plugin.facts.off?.() === true;
            const problems = plugin.facts.problems?.() ?? EMPTY;
            const sessions = useSessions((state) => state);
            const statuses = useSessionStatus((value) => value);
            const items = useWorkspaces((state) => state.items);
            const archivedIds = useWorkspaces((state) => state.archivedSessionIds);
            // Until DSH's own list has its workspaces, an empty tree means nothing yet.
            const pending = useWorkspaces((state) => state.phase) === 'pending';
            // The dialog open: {kind: 'new', ws?}, {kind: 'rename', group} or {kind: 'delete', group}.
            const [dialog, setDialog] = React.useState(null);
            const [said, setSaid] = React.useState('');
            const [find, setFind] = React.useState('');
            const treeRef = React.useRef(null);
            const findRef = React.useRef(null);
            // The tree item the keyboard goes to after a dialog that removed or moved the one it came from (PageTree).
            const keepRef = React.useRef(null);
            const [notes, dismissNote] = useStoredSet(NOTE_KEY);
            const announce = (text) => setSaid((prev) => (prev === text ? `${text} ` : text));
            const archived = React.useMemo(() => new Set(Array.isArray(archivedIds) ? archivedIds : EMPTY), [archivedIds]);
            const categories = Array.isArray(listed) ? listed : EMPTY;
            const tree = pageModel({ categories, items: Array.isArray(items) ? items : EMPTY, sessions, archived });
            // Other workspaces comes last in the tree, but it is no category.
            const count = tree.filter((node) => node.id !== OTHERS).length;
            // The categories this plugin's one-time import made from the old sidebar's projects (not ones the projects
            // plugin imported before this plugin, which came over with the rest).
            const imported = categories.filter((c) => c.imported === true).map((c) => (typeof c.name === 'string' && c.name !== '' ? c.name : c.id));
            const storeNote = plugin.facts.store?.() ?? null;
            // Alt+↑ and Alt+↓ on the tree, worked out on the whole tree (a find shows only part of it); said once done, or why not.
            const move = (key, by) => {
                const step = pageMove(tree, key, by);
                if (step === null) return null;
                if (step.refuse) {
                    announce(step.refuse);
                    return {};
                }
                void plugin.facts.act(step.method, step.args).then((result) => announce(result.ok ? step.said : errorText(result.error)));
                return { open: step.open };
            };
            // The menus: each category with the workspaces it holds, every workspace with its category (or none).
            const groups = tree.map((c) => ({ id: c.id, name: c.title, category: c.id !== OTHERS, workspaces: c.children.map((w) => w.id) }));
            const real = groups.filter((g) => g.category);
            const where = new Map();
            for (const g of real) for (const id of g.workspaces) where.set(id, g);
            const workspaces = tree.flatMap((c) => c.children).map((w) => ({ id: w.id, title: w.title, group: where.get(w.id) ?? null }));
            const titleOf = (id) => workspaces.find((w) => w.id === id)?.title ?? id;
            const nameOf = (id) => (id === '' || id === OTHERS ? SIDEBAR.others : groups.find((g) => g.id === id)?.name ?? id);
            const act = (method, args, success, then) => plugin.facts.act(method, args).then((result) => {
                announce(result.ok ? success : errorText(result.error));
                if (result.ok) then?.();
                return result;
            });
            const file = (workspace, category, reveal) => act('fileWorkspace', { workspace, category, before: '' }, SIDEBAR.filed(titleOf(workspace), nameOf(category)),
                () => reveal(`category:${category === '' ? OTHERS : category}`));
            const menu = {
                has: (node) => node.kind === 'workspace' || (node.kind === 'category' && groups.some((g) => g.id === node.id)),
                draw: ({ node, open, setOpen, reveal, keep, focus }) => {
                    // A dialog opened from a row's menu gives the keyboard back to that row when it closes (DSH's
                    // dialog returns the focus to what had it as it opened: the row, not the menu's hidden ⋯).
                    const ask = (next) => { focus(); setDialog(next); };
                    if (node.kind === 'category') {
                        const group = groups.find((g) => g.id === node.id);
                        const at = real.indexOf(group);
                        return h(CategoryMenu, {
                            page: true, group, open, setOpen, workspaces, first: at === 0, last: at === real.length - 1,
                            actions: {
                                move: (g, by) => { keep(); move(`category:${g.id}`, by); },
                                rename: (g) => ask({ kind: 'rename', group: g }),
                                remove: (g) => ask({ kind: 'delete', group: g }),
                                create: () => ask({ kind: 'new' }),
                                // DSH's own Add workspace, as from the sidebar; what it makes goes into this category.
                                newWorkspace: (g) => {
                                    plugin.addWorkspace?.start((ws) => {
                                        const title = workspaceTitle(ws);
                                        if (g.category) void act('fileWorkspace', { workspace: ws.workspaceId, category: g.id, before: '' }, SIDEBAR.added(title, g.name), () => reveal(`category:${g.id}`));
                                        else { announce(SIDEBAR.added(title, SIDEBAR.others)); void plugin.facts.list(); }
                                    });
                                },
                                adding: () => plugin.addWorkspace?.state() ?? null,
                                file: (id, g) => file(id, g.id, reveal),
                            },
                        });
                    }
                    const group = where.get(node.id) ?? null;
                    const list = (group ?? groups.find((g) => g.id === OTHERS))?.workspaces ?? EMPTY;
                    const at = list.indexOf(node.id);
                    return h(WorkspaceMenu, {
                        ws: { id: node.id, title: node.title }, group, categories: real, first: at <= 0, last: at === list.length - 1, open, setOpen,
                        actions: {
                            step: (by) => { keep(); move(`workspace:${node.id}`, by); },
                            fileTo: (category) => { keep(); void file(node.id, category, reveal); },
                            create: () => ask({ kind: 'new', ws: node.id }),
                        },
                    });
                },
            };
            let content;
            if (off) {
                // Switched off in its settings: what that means and how to switch it on, never an error.
                content = h('div', { className: 'dshc-pg-empty', 'data-categories-off': '' },
                    h('span', { className: 'dshc-pg-empty-glyph' }, h(CategoriesIcon, { size: 28 })),
                    h('h2', null, PAGE.offTitle),
                    h('p', null, PAGE.offText));
            } else if (listed === null && failed) {
                content = h('div', { className: 'dshc-pg-state dshc-pg-error', role: 'alert' }, TEXT.unreachable, ' ',
                    h('button', { type: 'button', className: 'dshc-pg-retry', onClick: () => { void plugin.facts.list(0); } },
                        h(ui.IconRefreshOutlineRegular, { size: 12 }), TEXT.retry));
            } else if (listed === null || (tree.length === 0 && pending)) {
                content = h('div', { className: 'dshc-pg-state', role: 'status' }, PAGE.loading);
            } else if (tree.length === 0) {
                content = h('div', { className: 'dshc-pg-empty', 'data-categories-empty': '' },
                    h('span', { className: 'dshc-pg-empty-glyph' }, h(CategoriesIcon, { size: 28 })),
                    h('h2', null, PAGE.emptyTitle),
                    h('p', null, PAGE.emptyText));
            } else {
                const kept = findInTree(tree, find);
                content = h(React.Fragment, null,
                    // Find by name: one box over every category, workspace and session name.
                    h('div', { className: 'dshc-pg-find' }, h(ui.Input, {
                        ref: findRef, type: 'text', role: 'searchbox', value: find, placeholder: PAGE.find, 'aria-label': PAGE.find, 'data-categories-find': '',
                        className: find !== '' ? 'dshc-pg-find-box dshc-pg-find-query' : 'dshc-pg-find-box',
                        icon: ui.IconSearchOutlineRegular ? h(ui.IconSearchOutlineRegular, { size: 14 }) : undefined,
                        onChange: (event) => setFind(event.target.value),
                        onKeyDown: (event) => {
                            if (event.key === 'Escape' && find !== '') { event.preventDefault(); event.stopPropagation(); setFind(''); }
                            else if (event.key === 'ArrowDown') { event.preventDefault(); treeRef.current?.querySelector('[role="treeitem"][tabindex="0"]')?.focus(); }
                        },
                    }), find !== '' ? h('button', {
                        type: 'button', className: 'dshc-pg-find-clear', 'aria-label': PAGE.findClear, 'data-categories-find-clear': '',
                        onClick: () => { setFind(''); findRef.current?.focus(); },
                    }, h(ui.IconCloseFillRegular, null)) : null),
                    kept.length > 0 ? h(PageTree, { tree: kept, label: PAGE.title, statuses, find, treeRef, keepRef, onMove: move, menu, onOpenSession: (id) => plugin.openSession(id) })
                        : h('div', { className: 'dshc-pg-state dshc-pg-find-none', role: 'status', 'data-categories-find-none': '' }, PAGE.findNone(find.trim())));
            }
            // New category, Rename and Delete, as the sidebar asks: a refusal shows in the dialog, and what was done is said.
            let overlay = null;
            if (dialog?.kind === 'delete') {
                overlay = h(ConfirmDialog, {
                    title: SIDEBAR.deleteTitle, text: SIDEBAR.deleteText(dialog.group.name, dialog.group.workspaces.length), action: SIDEBAR.deleteTitle, busyLabel: SIDEBAR.deleting,
                    onClose: () => setDialog(null),
                    onSubmit: async () => {
                        // The row that takes the deleted one's place: the next, else Other workspaces when its
                        // workspaces go there, else the one before it.
                        const at = tree.findIndex((c) => c.id === dialog.group.id);
                        const next = tree[at + 1]?.id ?? (dialog.group.workspaces.length > 0 ? OTHERS : tree[at - 1]?.id) ?? null;
                        const result = await plugin.facts.act('removeCategory', { category: dialog.group.id });
                        if (!result.ok) return errorText(result.error);
                        announce(SIDEBAR.deleted(dialog.group.name));
                        keepRef.current = next === null ? null : { key: `category:${next}`, until: Date.now() + 4000 };
                        setDialog(null);
                        return null;
                    },
                });
            } else if (dialog) {
                const naming = dialog.kind === 'new';
                overlay = h(NameDialog, {
                    title: naming ? SIDEBAR.newTitle : SIDEBAR.renameTitle,
                    description: naming ? (dialog.ws ? SIDEBAR.newWith(titleOf(dialog.ws)) : PAGE.newText) : undefined,
                    label: SIDEBAR.nameLabel,
                    initial: naming ? '' : dialog.group.name,
                    action: naming ? SIDEBAR.create : SIDEBAR.renameAction,
                    busyLabel: naming ? SIDEBAR.creating : SIDEBAR.renaming,
                    onClose: () => setDialog(null),
                    onSubmit: async (name) => {
                        const result = naming
                            ? await plugin.facts.act('createCategory', { name, workspace: dialog.ws ?? '' })
                            : await plugin.facts.act('renameCategory', { category: dialog.group.id, name });
                        if (!result.ok) return errorText(result.error);
                        announce(naming ? SIDEBAR.created(name) : SIDEBAR.renamed(name));
                        // A workspace that moved into the new category keeps the keyboard in its new place.
                        if (naming && dialog.ws) keepRef.current = { key: `workspace:${dialog.ws}`, until: Date.now() + 4000 };
                        setDialog(null);
                        return null;
                    },
                });
            }
            return h('div', { className: 'dshc-page', 'data-categories-page': '' },
                h('div', { className: 'dshc-pg-scroll' },
                    h('div', { className: 'dshc-pg-content' },
                        h('div', { className: 'dshc-pg-heading' },
                            h('h1', null, PAGE.title),
                            count > 0 ? h('span', { className: 'dshc-pg-count' }, plural(count, 'category', 'categories')) : null,
                            listed !== null && !off ? h(ui.Button, {
                                variant: 'outline', size: 'sm', className: 'dshc-pg-new', icon: h(ui.IconPlusOutlineRegular, { size: 14 }),
                                onClick: () => setDialog({ kind: 'new' }), 'data-categories-new': '',
                            }, SIDEBAR.newTitle) : null),
                        // With workspaces but no category yet: what categories are for, and how to make the first.
                        !off && listed !== null && count === 0 && tree.length > 0 ? h('p', { className: 'dshc-pg-hint', 'data-categories-none-yet': '' }, PAGE.noneYet) : null,
                        // The plugin's own file: a save that failed (the change was undone), or a file it couldn't use at the start.
                        storeNote ? h('div', { className: 'dshc-pg-note dshc-pg-problems', role: 'alert', 'data-categories-store-note': storeNote.problem ?? '' },
                            h(ui.IconInfoOutlineRegular, { size: 14, 'aria-hidden': true }),
                            h('span', null, h('strong', null, `${PAGE.storeTitle[storeNote.problem] ?? PAGE.storeTitle.unsaved}: `), storeNote.text)) : null,
                        // A setting that was wrong: which, what it must be and counts as meanwhile, and where to fix it.
                        problems.length > 0 ? h('div', { className: 'dshc-pg-note dshc-pg-problems', role: 'alert', 'data-categories-problems': '' },
                            h(ui.IconInfoOutlineRegular, { size: 14, 'aria-hidden': true }),
                            h('span', null, h('strong', null, `${PAGE.problemsTitle}: `), problems.map((p) => `${p.text}.`).join(' '), ' ', PAGE.problemsFix)) : null,
                        // What came from the old sidebar, and what didn't, said once, until dismissed.
                        imported.length > 0 && !notes.has('imported') ? h('div', { className: 'dshc-pg-note', 'data-categories-imported': '' },
                            h(ui.IconInfoOutlineRegular, { size: 14, 'aria-hidden': true }),
                            h('span', null, PAGE.imported(imported)),
                            h('button', { type: 'button', className: 'dshc-pg-dismiss', 'aria-label': `${PAGE.dismiss}: ${PAGE.imported(imported)}`, onClick: () => dismissNote('imported', true) },
                                h(ui.IconCloseOutlineRegular, { size: 14 }))) : null,
                        content)),
                // What the page made, said to screen readers.
                h('div', { className: 'dshc-sr', role: 'status', 'aria-live': 'polite', 'data-categories-page-said': '' }, said),
                overlay);
        }

        // ── Categories in DSH's session list ───────────────────────────────

        /** Where the folded categories are kept between restarts (the window's own storage). */
        const FOLDED_KEY = `${BUNDLE}/sidebar-folded`;
        /** DSH's workspace list in its sidebar, and the plugin's headers in it. */
        const SB_TREE = '[data-slot="sidebar.workspaces"] [role="tree"]';
        const SB_HEAD = '[data-categories-sb]';
        /**
         * The plugin's marks in DSH's list (markList): the list while it shows
         * the categories, each of its sections with its workspace ('' for
         * DSH's Ungrouped bucket, the chats no workspace holds), and how deep
         * a folder's nested workspace is in Workspace Tree.
         */
        const SB_LIST = 'data-categories-list';
        const SB_WS = 'data-categories-ws';
        const SB_DEPTH = 'data-categories-depth';
        /** A workspace's row, which DSH draws as its section's grandchild. */
        const WS_ROW = '[data-row-key^="workspace:"]';
        /** The plugin's seat for a folded workspace's dot, in that workspace's row (markWorkspaceDots). */
        const WS_DOT = 'data-categories-ws-dot';

        const SIDEBAR = {
            others: 'Other workspaces',
            actions: (name) => `Category actions: ${name}`,
            othersActions: 'Actions for Other workspaces',
            addWorkspace: 'Add a workspace',
            newWorkspace: 'New workspace…',
            addNone: 'Every workspace is already here',
            /** Said after a workspace's name in Add a workspace, where the menu shows " · Shop". */
            nowIn: (name) => `, now in ${name}`,
            moveUp: 'Move up',
            moveDown: 'Move down',
            rename: 'Rename…',
            newCategory: 'New category…',
            remove: 'Delete…',
            nameLabel: 'Category name',
            newTitle: 'New category',
            newText: 'It starts empty and goes last. Drag workspaces onto it, or add them from its ⋯ menu.',
            newWith: (title) => `${title} moves into it.`,
            create: 'Create',
            creating: 'Creating…',
            renameTitle: 'Rename category',
            renameAction: 'Rename',
            renaming: 'Renaming…',
            deleteTitle: 'Delete category',
            deleteText: (name, n) => `This deletes “${name}”. ${n === 0 ? 'It holds no workspaces.' : n === 1 ? 'Its workspace moves to Other workspaces.' : `Its ${n} workspaces move to Other workspaces.`} No chats or folders are deleted.`,
            deleting: 'Deleting…',
            in: (name) => `in ${name}`,
            /** A folded workspace's dot in words, read after its row's name (markWorkspaceDots). */
            dot: (dot) => (dot === 'warning' ? ', a chat is waiting on you' : ', a chat is running'),
            filed: (ws, category) => `${ws} moved to ${category}.`,
            added: (ws, group) => `${ws} added to ${group}.`,
            moved: (name) => `${name} moved.`,
            created: (name) => `${name} created.`,
            renamed: (name) => `Renamed to ${name}.`,
            deleted: (name) => `${name} deleted.`,
        };

        /**
         * The groups DSH's session list shows: every category in the plugin's
         * order, empty ones too, each with the workspaces it holds in DSH's
         * order, then Other workspaces (the rest) while it holds any, or while
         * a workspace is dragged (somewhere to drop it). With no categories,
         * Other workspaces holds every workspace, so its ⋯ can make the first
         * one. null while the categories aren't known, or while there are
         * neither categories nor workspaces: the list then stays as DSH draws
         * it.
         */
        function sidebarGroups(categories, items, othersShown = false) {
            if (!Array.isArray(categories) || !Array.isArray(items)) return null;
            const order = items.map((ws) => ws?.workspaceId).filter((id) => typeof id === 'string');
            const placed = new Set();
            const groups = [];
            for (const category of categories) {
                if (!isObject(category) || typeof category.id !== 'string') continue;
                const held = new Set((Array.isArray(category.workspaces) ? category.workspaces : EMPTY).map((ws) => ws?.id));
                const ids = order.filter((id) => held.has(id) && !placed.has(id));
                for (const id of ids) placed.add(id);
                groups.push({ id: category.id, name: typeof category.name === 'string' && category.name !== '' ? category.name : category.id, category: true, workspaces: ids });
            }
            const others = order.filter((id) => !placed.has(id));
            if (others.length > 0 || othersShown) groups.push({ id: OTHERS, name: SIDEBAR.others, category: false, workspaces: others });
            return groups.length > 0 ? groups : null;
        }

        /**
         * The CSS that sets DSH's list under the categories. It holds while the
         * list has the plugin's headers and shows workspaces (not In one list,
         * not search results): the list becomes a column whose workspace
         * sections each follow their category's header one step in (DSH's own
         * --dsh-workspace-indent), and a folded category's sections are
         * hidden. DSH's own order stays inside each category (the host keeps
         * DSH's order in category order, so the headers also sit before their
         * sections in the DOM); a workspace the plugin hasn't placed yet goes
         * last, with Other workspaces.
         *
         * The rules find the list and its sections by the plugin's marks
         * (markList), never by what an element holds: each ends in a mark,
         * or is a child of the marked list, so a change in one workspace
         * restyles that workspace, not the list.
         */
        function sidebarRules(groups, folded) {
            const on = `${SB_TREE}[${SB_LIST}]`;
            const last = 2 * groups.length - 1;
            const rules = [
                `${on}{display:flex;flex-direction:column}`,
                // Anything else DSH draws in the list goes last, and so does a section until the plugin's next pass marks
                // it (one DSH just added, which DSH measures for its row animation before that pass).
                `${on}>*{flex-shrink:0;order:${last}}`,
                `${SB_TREE}:not([${SB_LIST}])>${SB_HEAD}{display:none}`,
                `${on}>[${SB_WS}]{margin-top:4px!important;--dsh-workspace-indent:12px!important}`,
                // DSH's Ungrouped bucket stays last, level with the headers.
                `${on}>[${SB_WS}=""]{order:${last + 1};margin-top:10px!important;--dsh-workspace-indent:0px!important}`,
            ];
            // Workspace Tree nests a folder's workspaces in its section: each level a step further in.
            for (let depth = 1; depth <= 4; depth += 1) rules.push(`${on} [${SB_DEPTH}="${depth}"]{--dsh-workspace-indent:${12 * (depth + 1)}px!important}`);
            groups.forEach((group, i) => {
                const shut = folded.has(group.id) ? ';display:none!important' : '';
                for (const id of group.workspaces) {
                    if (/^[\w.:-]+$/.test(id)) rules.push(`${on}>[${SB_WS}="${id}"]{order:${2 * i + 1}${shut}}`);
                }
            });
            return rules.join('\n');
        }

        /** A folded workspace's dot: waiting on you if one of its chats is, else running if one runs, else null. */
        function workspaceDot(ws, statuses) {
            let dot = null;
            for (const sessionId of ws?.sessionIds ?? EMPTY) {
                const status = statuses?.get?.(sessionId);
                if (status?.pendingInteraction) return 'warning';
                if (status?.running === true) dot = 'ongoing';
            }
            return dot;
        }

        /** A folded category's dot: its workspaces' dots taken together, waiting on you before running. */
        function groupDot(group, byId, statuses) {
            let dot = null;
            for (const id of group.workspaces) {
                const own = workspaceDot(byId.get(id), statuses);
                if (own === 'warning') return 'warning';
                dot ??= own;
            }
            return dot;
        }

        /** Two lists of seats (markWorkspaceDots) with the same workspaces, elements and dots in the same order. */
        const sameSeats = (a, b) => a === b || (a.length === b.length && a.every((seat, i) => seat.id === b[i].id && seat.el === b[i].el && seat.dot === b[i].dot));

        /** The folded categories, kept in the window's storage so they stay folded after a restart. */
        const useFolded = () => useStoredSet(FOLDED_KEY);

        /**
         * DSH's workspace list while its sidebar shows one, found again when
         * DSH draws a new one (search, view options, folding the sidebar).
         */
        function useSidebarTree() {
            const find = () => (typeof document === 'undefined' ? null : document.querySelector(SB_TREE));
            const [tree, setTree] = React.useState(find);
            React.useEffect(() => {
                if (typeof MutationObserver === 'undefined') return undefined;
                let current = find();
                setTree(current);
                let frame = 0;
                const look = () => {
                    frame = 0;
                    const next = find();
                    if (next !== current) {
                        current = next;
                        setTree(next);
                    }
                };
                const observer = new MutationObserver(() => {
                    if (current?.isConnected || frame !== 0) return;
                    frame = requestAnimationFrame(look);
                });
                observer.observe(document.body, { childList: true, subtree: true });
                return () => {
                    observer.disconnect();
                    if (frame !== 0) cancelAnimationFrame(frame);
                };
            }, []);
            return tree;
        }

        /** The workspace a section of DSH's list is for: its own row's id ('' for DSH's Ungrouped bucket), or null for anything else. */
        function sectionWorkspace(section) {
            const row = section?.querySelector?.(':scope>[data-row-key^="workspace:"],:scope>*>[data-row-key^="workspace:"]');
            return row ? row.getAttribute('data-row-key').slice('workspace:'.length) : null;
        }

        /**
         * The section of DSH's list an element is in: a child of the list, or
         * of a folder's group in Workspace Tree. null for the plugin's headers
         * and anything outside the list.
         */
        function sectionAt(tree, el) {
            for (let e = el instanceof Element ? el : null; e && e !== tree; e = e.parentElement) {
                const parent = e.parentElement;
                if (parent === tree) return e.matches(SB_HEAD) ? null : e;
                if (parent?.getAttribute('role') === 'group') return e;
            }
            return null;
        }

        /**
         * Each header in DSH's list just before its category's first section,
         * and an empty category's before the next header, so the list reads
         * in the order it is drawn (DSH's Ungrouped bucket stays last). A
         * header that had the focus keeps it.
         */
        function placeHeaders(tree, groups) {
            const heads = new Map();
            const sections = new Map();
            const index = new Map();
            let strays = null;
            [...tree.children].forEach((child, i) => {
                index.set(child, i);
                const id = child.getAttribute('data-categories-sb');
                if (id !== null) { heads.set(id, child); return; }
                const ws = sectionWorkspace(child);
                if (ws === '') strays = child;
                else if (ws !== null) sections.set(ws, child);
            });
            let next = strays;
            for (let i = groups.length - 1; i >= 0; i -= 1) {
                const head = heads.get(groups[i].id);
                if (!head) continue;
                let first = null;
                for (const ws of groups[i].workspaces) {
                    const section = sections.get(ws);
                    if (section && (first === null || index.get(section) < index.get(first))) first = section;
                }
                const ref = first ?? next;
                if (head.nextElementSibling !== ref) {
                    const focused = typeof document !== 'undefined' && head.contains(document.activeElement) ? document.activeElement : null;
                    tree.insertBefore(head, ref);
                    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
                }
                next = head;
            }
        }

        /** Each workspace row names its category to a screen reader ("in Fleet Services"); the plugin's word goes when its category does. */
        function describeWorkspaces(tree, groups) {
            const where = new Map();
            for (const group of groups ?? EMPTY) for (const ws of group.workspaces) where.set(ws, SIDEBAR.in(group.name));
            for (const row of tree.querySelectorAll('[data-row-key^="workspace:"]')) {
                const text = where.get(row.getAttribute('data-row-key').slice('workspace:'.length));
                if (text !== undefined) {
                    if (row.getAttribute('aria-description') !== text) row.setAttribute('aria-description', text);
                    if (!row.hasAttribute('data-categories-in')) row.setAttribute('data-categories-in', '');
                } else if (row.hasAttribute('data-categories-in')) {
                    row.removeAttribute('aria-description');
                    row.removeAttribute('data-categories-in');
                }
            }
        }

        /** An attribute set to a value, or gone for null, changed only when it differs. */
        function setMark(el, name, value) {
            if (value === null) {
                if (el.hasAttribute(name)) el.removeAttribute(name);
            } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
        }

        /**
         * Mark DSH's list for sidebarRules: the list while it has the
         * plugin's headers and shows workspaces' sections, each of its
         * sections with its workspace ('' for DSH's Ungrouped bucket), and a
         * folder's nested workspace in Workspace Tree with how many sections
         * deep it is (up to 4). Only what differs changes; with no categories
         * (null) every mark goes.
         */
        function markList(tree, groups) {
            let heads = false;
            let shown = false;
            for (const child of tree.children) {
                if (child.hasAttribute('data-categories-sb')) {
                    heads = true;
                    continue;
                }
                const ws = groups ? sectionWorkspace(child) : null;
                if (ws !== null && child.querySelector(`:scope>*>${WS_ROW}`)) shown = true;
                setMark(child, SB_WS, ws);
            }
            setMark(tree, SB_LIST, groups && heads && shown ? '' : null);
            // A nested workspace's section is its row's grandparent, inside the section of each folder above it.
            const depths = new Map();
            for (const el of tree.querySelectorAll(`${WS_ROW},[${SB_DEPTH}]`)) {
                if (el.hasAttribute(SB_DEPTH) && !depths.has(el)) depths.set(el, null);
                const section = groups && el.matches(WS_ROW) ? el.parentElement?.parentElement : null;
                if (!section || section === tree || section.parentElement === tree) continue;
                let depth = 0;
                for (let e = section.parentElement; e && e !== tree; e = e.parentElement) if (e.querySelector(`:scope>*>${WS_ROW}`)) depth += 1;
                depths.set(section, depth > 0 ? String(Math.min(depth, 4)) : null);
            }
            for (const [el, depth] of depths) setMark(el, SB_DEPTH, depth);
        }

        /**
         * A seat for each folded workspace's dot in its own row of DSH's list,
         * which has none: the plugin's own element, before DSH's row actions
         * (the part of the row that holds its buttons), or last. A workspace
         * that is unfolded, or with nothing running or waiting, has no seat;
         * DSH's Ungrouped bucket never has one. Only what differs changes;
         * with no dots (null) every seat goes.
         * @param dotOf - a workspace's dot by its id (workspaceDot), or null.
         * @returns the seats in the list's order, each {id, el, dot}, for the dots to be drawn in.
         */
        function markWorkspaceDots(tree, dotOf) {
            const seats = [];
            for (const row of tree.querySelectorAll(WS_ROW)) {
                const id = row.getAttribute('data-row-key').slice('workspace:'.length);
                const dot = dotOf && id !== '' && row.getAttribute('aria-expanded') === 'false' ? dotOf(id) : null;
                let seat = null;
                for (const child of row.children) if (child.hasAttribute(WS_DOT)) seat = child;
                if (dot === null) {
                    seat?.remove();
                    continue;
                }
                if (seat === null) {
                    seat = row.ownerDocument.createElement('span');
                    seat.className = 'dshc-ws-dot';
                    seat.setAttribute(WS_DOT, '');
                    row.insertBefore(seat, [...row.children].find((child) => child.querySelector('button') !== null) ?? null);
                }
                seats.push({ id, el: seat, dot });
            }
            return seats;
        }

        /**
         * Keep the plugin's parts of DSH's list in step with it: the headers'
         * places, the marks its CSS goes by, the workspaces' categories, and
         * the folded workspaces' dots. DSH redraws rows on its own (a fold,
         * Show more, a session moving up), so this runs again on every change
         * to the list, a workspace folding or unfolding among them, before it
         * is painted, and after every render here. Each pass changes only what
         * differs.
         * @param read - a ref to {groups, dotOf, seated}: the latest categories to draw, a folded workspace's dot by its
         *   id, and where the dots go (each pass's seats from markWorkspaceDots).
         */
        function useTreeSync(tree, read) {
            const pass = React.useRef(() => {});
            pass.current = () => {
                if (!tree?.isConnected) return;
                const { groups, dotOf, seated } = read.current;
                if (groups) placeHeaders(tree, groups);
                markList(tree, groups);
                describeWorkspaces(tree, groups);
                seated?.(markWorkspaceDots(tree, dotOf ?? null));
            };
            React.useLayoutEffect(() => {
                if (!tree || typeof document === 'undefined') return undefined;
                let busy = false;
                const run = () => {
                    if (busy) return;
                    busy = true;
                    try { pass.current(); } finally { busy = false; }
                };
                run();
                const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(run);
                observer?.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
                return () => {
                    observer?.disconnect();
                    markList(tree, null);
                    describeWorkspaces(tree, null);
                    markWorkspaceDots(tree, null);
                    read.current.seated?.(EMPTY);
                };
            }, [tree]);
            React.useLayoutEffect(() => { pass.current(); });
        }

        /**
         * The plugin's own drags in DSH's list: a category's header (reorder
         * the categories) and a workspace's row (into a category, or among
         * its workspaces). The plugin claims these drags as they start,
         * before DSH sees them, so DSH draws no line and saves no order of
         * its own; the plugin draws DSH's line itself and makes the move
         * through its endpoints, which keep DSH's workspace order in step.
         * A folder's nested workspaces in Workspace Tree keep DSH's own drag,
         * and so do session rows.
         * @param read - a ref to {groups, folded, titleOf, dragging(on), file(ws, group, before), moveCategory(id, before)}.
         */
        function useCategoryDrags(tree, read) {
            React.useEffect(() => {
                if (!tree || typeof document === 'undefined') return undefined;
                let drag = null;
                let lit = null;
                const line = document.createElement('div');
                line.className = 'dshc-sb-drop-line';
                line.hidden = true;
                line.setAttribute('aria-hidden', 'true');
                document.body.append(line);
                const show = (target) => {
                    if (lit && lit !== target?.head) {
                        lit.removeAttribute('data-categories-drop');
                        lit = null;
                    }
                    if (target?.head && lit !== target.head) {
                        target.head.setAttribute('data-categories-drop', 'into');
                        lit = target.head;
                    }
                    line.hidden = !target?.line;
                    if (target?.line) Object.assign(line.style, { top: `${target.line.top}px`, left: `${target.line.left}px`, width: `${target.line.width}px` });
                };
                const stop = () => {
                    show(null);
                    if (!drag) return;
                    drag.source.removeAttribute('data-categories-dragging');
                    drag = null;
                    read.current.dragging(false);
                };
                const groups = () => read.current.groups ?? EMPTY;
                const groupOf = (ws) => groups().find((g) => g.workspaces.includes(ws)) ?? null;
                const sectionOf = (ws) => [...tree.children].find((el) => sectionWorkspace(el) === ws) ?? null;
                const under = (event) => (event.target instanceof Element && tree.contains(event.target) ? event.target : null);
                // The lower half of a row.
                const lower = (event, box) => event.clientY >= box.top + box.height / 2;
                /*
                 * A workspace goes onto a category's header (first in it) or a
                 * workspace's own row (above it, or below its open chats). A
                 * chat's row, or anything else, is no place for it: no line,
                 * and the "no" pointer.
                 */
                const workspaceTarget = (event) => {
                    const el = under(event);
                    if (!el) return null;
                    const from = groupOf(drag.id);
                    const head = el.closest(SB_HEAD);
                    if (head) {
                        const into = groups().find((g) => g.id === head.getAttribute('data-categories-sb'));
                        if (!into) return null;
                        if (from === into && into.workspaces[0] === drag.id) return { none: true };
                        return { head, into, before: into.workspaces.find((id) => id !== drag.id) ?? null };
                    }
                    const row = el.closest('[data-row-key^="workspace:"]');
                    const section = row ? sectionAt(tree, row) : null;
                    const ws = section?.parentElement === tree ? sectionWorkspace(section) : null;
                    const into = ws ? groupOf(ws) : null;
                    if (!into) return null;
                    if (ws === drag.id) return { none: true };
                    const box = section.getBoundingClientRect();
                    const after = lower(event, row.getBoundingClientRect());
                    const list = into.workspaces.filter((id) => id !== drag.id);
                    const before = list[list.indexOf(ws) + (after ? 1 : 0)] ?? null;
                    if (from === into && (from.workspaces[from.workspaces.indexOf(drag.id) + 1] ?? null) === before) return { none: true };
                    return { into, before, line: { top: after ? box.bottom - 4 : box.top - 8, left: box.left, width: box.width } };
                };
                /*
                 * A category goes onto another category's header: above it, or
                 * below its open workspaces; onto Other workspaces, last of the
                 * categories. Only headers take it.
                 */
                const categoryTarget = (event) => {
                    const head = under(event)?.closest(SB_HEAD);
                    const over = head ? groups().find((g) => g.id === head.getAttribute('data-categories-sb')) : null;
                    if (!over) return null;
                    if (over.id === drag.id) return { none: true };
                    const box = head.getBoundingClientRect();
                    let bottom = box.bottom;
                    if (!read.current.folded.has(over.id)) {
                        for (const ws of over.workspaces) bottom = Math.max(bottom, sectionOf(ws)?.getBoundingClientRect().bottom ?? bottom);
                    }
                    const ids = groups().filter((g) => g.category).map((g) => g.id);
                    const after = over.category && lower(event, box);
                    const before = !over.category ? null : after ? ids[ids.indexOf(over.id) + 1] ?? null : over.id;
                    if (before === drag.id || (ids[ids.indexOf(drag.id) + 1] ?? null) === before) return { none: true };
                    return { before, line: { top: after ? bottom - 4 : box.top - 8, left: box.left, width: box.width } };
                };
                const targetOf = (event) => (drag.kind === 'workspace' ? workspaceTarget(event) : categoryTarget(event));
                const begin = (event, next) => {
                    event.stopPropagation();
                    drag = next;
                    try {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', next.name);
                    } catch { /* a synthetic event */ }
                    // After the browser has taken its picture of the row and started the drag. Changed during
                    // dragstart (an empty Other workspaces showing up), the list could scroll the row out from under
                    // the pointer or cover it, and the browser would call the drag off.
                    requestAnimationFrame(() => {
                        if (drag !== next) return;
                        next.source.setAttribute('data-categories-dragging', '');
                        read.current.dragging(next.kind === 'workspace');
                    });
                };
                const onStart = (event) => {
                    const el = under(event);
                    if (!el || drag || !read.current.groups) return;
                    const head = el.closest(SB_HEAD);
                    if (head) {
                        const group = groups().find((g) => g.id === head.getAttribute('data-categories-sb'));
                        if (group?.category) begin(event, { kind: 'category', id: group.id, name: group.name, source: head });
                        return;
                    }
                    const row = el.closest('[data-row-key^="workspace:"]');
                    const section = row ? sectionAt(tree, row) : null;
                    if (!section || section.parentElement !== tree) return;
                    const id = row.getAttribute('data-row-key').slice('workspace:'.length);
                    if (id === '' || !groupOf(id)) return;
                    begin(event, { kind: 'workspace', id, name: read.current.titleOf(id), source: section });
                };
                const onOver = (event) => {
                    if (!drag) return;
                    event.stopPropagation();
                    const target = targetOf(event);
                    if (target) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                    }
                    show(target?.none ? null : target);
                };
                const onDrop = (event) => {
                    if (!drag) return;
                    event.stopPropagation();
                    event.preventDefault();
                    const target = targetOf(event);
                    const done = drag;
                    stop();
                    if (!target || target.none) return;
                    if (done.kind === 'workspace') read.current.file(done.id, target.into, target.before);
                    else read.current.moveCategory(done.id, target.before);
                };
                const onEnd = (event) => {
                    if (!drag) return;
                    event.stopPropagation();
                    stop();
                };
                document.addEventListener('dragstart', onStart, true);
                document.addEventListener('dragover', onOver, true);
                document.addEventListener('drop', onDrop, true);
                document.addEventListener('dragend', onEnd, true);
                return () => {
                    document.removeEventListener('dragstart', onStart, true);
                    document.removeEventListener('dragover', onOver, true);
                    document.removeEventListener('drop', onDrop, true);
                    document.removeEventListener('dragend', onEnd, true);
                    stop();
                    line.remove();
                };
            }, [tree, read]);
        }

        /** What DSH's session list entry hands its own component, read once per entry (dshAddFlow). */
        const listFaces = new WeakMap();

        /**
         * DSH's own Add workspace, as DSH's session list hands it to the +
         * over the list: ui-workspace's `sidebar.workspaces` entry injects
         * `requestAddWorkspace`, which opens DSH's folder picker or folder
         * dialog, and `workspaceShortcuts`, the state of that flow. DSH has no
         * service for it, so this reads the entry as DSH's renderer does.
         * undefined where this DSH has none, where no folder picker is
         * installed (DSH hides its + then), or where another plugin draws the
         * list.
         * @param slots - DSH's `slots` service.
         * @returns {request(), state} or undefined.
         */
        function dshAddFlow(slots) {
            let entry;
            try {
                entry = (typeof slots?.entriesOfSlot === 'function' ? slots.entriesOfSlot('sidebar.workspaces') : slots?.entries?.('sidebar.workspaces'))?.[0];
            } catch {
                return undefined;
            }
            if (!isObject(entry) || typeof entry.inject !== 'function') return undefined;
            if (!listFaces.has(entry)) {
                let face = null;
                try { face = entry.inject(); } catch { /* not DSH's own list */ }
                listFaces.set(entry, face);
            }
            const face = listFaces.get(entry);
            const state = face?.hooks?.workspaceShortcuts;
            const pickers = face?.hooks?.directoryFlow;
            if (typeof face?.requestAddWorkspace !== 'function' || typeof state?.getSnapshot !== 'function' || typeof state.subscribe !== 'function') return undefined;
            if (typeof pickers?.getSnapshot === 'function' && pickers.getSnapshot() !== true) return undefined;
            return { request: face.requestAddWorkspace, state };
        }

        /**
         * DSH's own Add workspace started from a menu here, and the workspace
         * it makes. DSH's state says while its flow runs: `addRequested` until
         * it opens, then `directoryBusy` while the folder is chosen and DSH
         * makes the workspace (DSH then opens a new chat there itself). The
         * first workspace DSH's list gains while the flow runs is the one it
         * made. Choose again, after a folder DSH couldn't open, is the same
         * run; another start of DSH's flow (its + or its shortcut) ends the
         * wait, and a folder that was a workspace already adds none.
         * @param flowOf - DSH's flow as it is now (dshAddFlow), or undefined.
         * @param listOf - DSH's workspace list ({getSnapshot, subscribe}), or undefined.
         */
        function workspaceAdder(flowOf, listOf) {
            let wait = null;
            const parts = () => {
                const flow = flowOf();
                const list = listOf();
                return flow && typeof list?.getSnapshot === 'function' && typeof list.subscribe === 'function' ? { flow, list } : null;
            };
            const busy = (flow) => flow.state.getSnapshot()?.directoryBusy === true;
            const workspaces = (list) => {
                const items = list.getSnapshot()?.items;
                return (Array.isArray(items) ? items : EMPTY).filter((ws) => typeof ws?.workspaceId === 'string');
            };
            const stop = () => {
                const run = wait;
                wait = null;
                run?.off();
            };
            return {
                /** Whether New workspace… can start DSH's flow: null where it can't, else {busy} (the flow runs already). */
                state() {
                    const p = parts();
                    return p ? { busy: busy(p.flow) } : null;
                },
                /**
                 * Start DSH's flow; `made(workspace)` gets the workspace it makes, once.
                 * @returns whether it started.
                 */
                start(made) {
                    const p = parts();
                    if (!p || busy(p.flow)) return false;
                    const { flow, list } = p;
                    stop();
                    const known = () => new Set(workspaces(list).map((ws) => ws.workspaceId));
                    const run = { known: known(), asked: false, starting: true, off: () => {} };
                    const check = () => {
                        if (wait !== run || run.starting) return;
                        const now = flow.state.getSnapshot() ?? {};
                        // DSH's flow asked for again, by its + or its shortcut: that run is DSH's own.
                        if (now.addRequested === true && !run.asked) { stop(); return; }
                        run.asked = now.addRequested === true;
                        // Only the flow running makes the workspace waited for; one added elsewhere meanwhile isn't it.
                        if (!run.asked && now.directoryBusy !== true) { run.known = known(); return; }
                        const ws = workspaces(list).find((w) => !run.known.has(w.workspaceId));
                        if (ws === undefined) return;
                        stop();
                        made(ws);
                    };
                    const offs = [flow.state.subscribe(check), list.subscribe(check)];
                    run.off = () => { for (const off of offs) if (typeof off === 'function') off(); };
                    wait = run;
                    try { flow.request(); } catch { /* DSH didn't take it: below */ }
                    run.starting = false;
                    const now = flow.state.getSnapshot() ?? {};
                    run.asked = now.addRequested === true;
                    if (!run.asked && now.directoryBusy !== true) {
                        stop();
                        return false;
                    }
                    return true;
                },
                stop,
            };
        }

        /**
         * ⋯ on a header. A category's: Add a workspace (those in no category
         * first), New workspace (DSH's own Add workspace, filed there), Move
         * up and down, Rename, New category and Delete. Other workspaces' (no
         * category): New workspace and New category. A right-click, Shift+F10
         * or the context-menu key opens it from the header too. On the
         * Categories page (`page`), the same menu at the end of the row.
         */
        function CategoryMenu({ group, first, last, open, setOpen, workspaces, actions, page = false }) {
            // DSH's own Add workspace, where this DSH has it; greyed while it runs.
            const adding = actions.adding?.() ?? null;
            const made = adding === null ? EMPTY : [{ id: 'newWorkspace', label: SIDEBAR.newWorkspace, icon: h(ui.IconFolderOpenOutlineRegular, {}), disabled: adding.busy }];
            const create = { id: 'new', label: SIDEBAR.newCategory, icon: h(ui.IconProjectAddOutlineRegular, {}) };
            const folder = h(ui.IconFolderCloseRegular, {});
            const free = workspaces.filter((ws) => ws.group === null);
            const taken = workspaces.filter((ws) => ws.group !== null && ws.group.id !== group.id);
            // DSH's Menu draws every entry of a submenu as an item with its label (no headings, no separators there):
            // the workspaces in no category come first, then each in another category with where it is now.
            const add = free.length + taken.length === 0 ? [{ id: 'none', label: SIDEBAR.addNone, disabled: true }] : [
                ...free.map((ws) => ({ id: `w:${ws.id}`, label: ws.title, icon: folder })),
                ...taken.map((ws) => ({
                    id: `w:${ws.id}`, icon: folder,
                    label: h('span', null, ws.title, h('span', { className: 'dshc-menu-from', 'aria-hidden': true }, ` · ${ws.group.name}`), h('span', { className: 'dshc-sr' }, SIDEBAR.nowIn(ws.group.name))),
                })),
            ];
            const items = !group.category ? [...made, create] : [
                { id: 'add', label: SIDEBAR.addWorkspace, icon: h(ui.IconPlusOutlineRegular, {}), submenu: add },
                ...made,
                { type: 'separator', id: 's1' },
                { id: 'up', label: SIDEBAR.moveUp, icon: h(ui.IconChevronUpOutlineRegular, {}), disabled: first },
                { id: 'down', label: SIDEBAR.moveDown, icon: h(ui.IconChevronDownOutlineRegular, {}), disabled: last },
                { type: 'separator', id: 's2' },
                { id: 'rename', label: SIDEBAR.rename, icon: h(ui.IconEditOutlineRegular, {}) },
                create,
                { id: 'delete', label: SIDEBAR.remove, icon: h(ui.IconTrashOutlineRegular, {}), danger: true },
            ];
            return h(ui.Menu, {
                // autoFocus: its first item takes the keyboard, so a menu opened by Shift+F10 can be walked with the arrows.
                open, onClose: () => setOpen(false), items, portal: true, closeOnPointerLeave: true, align: 'end', autoFocus: true, className: page ? 'dshc-tree-act' : undefined,
                onSelect: (id) => {
                    setOpen(false);
                    if (id === 'up') actions.move(group, -1);
                    else if (id === 'down') actions.move(group, 1);
                    else if (id === 'rename') actions.rename(group);
                    else if (id === 'newWorkspace') actions.newWorkspace(group);
                    else if (id === 'new') actions.create(null, group);
                    else if (id === 'delete') actions.remove(group);
                    else if (id.startsWith('w:')) void actions.file(id.slice(2), group, null);
                },
                anchor: h('button', {
                    type: 'button', className: page ? 'dshc-tree-more' : 'dshc-sb-more', tabIndex: -1, 'aria-label': group.category ? SIDEBAR.actions(group.name) : SIDEBAR.othersActions,
                    'aria-haspopup': 'menu', 'aria-expanded': open,
                    ...(page ? { 'data-categories-page-menu': group.id } : {
                        'data-categories-menu': group.category ? group.id : undefined,
                        'data-categories-others-menu': group.category ? undefined : '',
                    }),
                    onClick: (event) => {
                        event.stopPropagation();
                        setOpen(!open);
                    },
                }, h(ui.IconEllipsisOutlineRegular, { size: 14 })),
            });
        }

        /**
         * ⋯ on a workspace's row on the Categories page, as DSH's own
         * workspace menu has no seat for the plugin: Move to another category
         * or to Other workspaces, New category with it, and Move up and Move
         * down in its category. A right-click, Shift+F10 or the context-menu
         * key on the row opens it too.
         * @param group - the category it is in, or null for none.
         * @param categories - every category, in order.
         */
        function WorkspaceMenu({ ws, group, categories, first, last, open, setOpen, actions }) {
            const folder = h(ui.IconFolderCloseRegular, {});
            const to = [
                ...categories.filter((c) => c.id !== group?.id).map((c) => ({ id: `c:${c.id}`, label: c.name, icon: folder })),
                ...(group ? [{ id: 'c:', label: SIDEBAR.others, icon: folder }] : []),
            ];
            const items = [
                { id: 'to', label: PAGE.moveTo, icon: h(ui.IconFolderOpenOutlineRegular, {}), submenu: to.length > 0 ? to : [{ id: 'none', label: PAGE.noCategories, disabled: true }] },
                { id: 'new', label: PAGE.newWithIt, icon: h(ui.IconProjectAddOutlineRegular, {}) },
                { type: 'separator', id: 's1' },
                { id: 'up', label: SIDEBAR.moveUp, icon: h(ui.IconChevronUpOutlineRegular, {}), disabled: first },
                { id: 'down', label: SIDEBAR.moveDown, icon: h(ui.IconChevronDownOutlineRegular, {}), disabled: last },
            ];
            return h(ui.Menu, {
                open, onClose: () => setOpen(false), items, portal: true, closeOnPointerLeave: true, align: 'end', autoFocus: true, className: 'dshc-tree-act',
                onSelect: (id) => {
                    setOpen(false);
                    if (id === 'up') actions.step(-1);
                    else if (id === 'down') actions.step(1);
                    else if (id === 'new') actions.create();
                    else if (id.startsWith('c:')) actions.fileTo(id.slice(2));
                },
                anchor: h('button', {
                    type: 'button', className: 'dshc-tree-more', tabIndex: -1, 'aria-label': PAGE.workspaceActions(ws.title),
                    'aria-haspopup': 'menu', 'aria-expanded': open, 'data-categories-page-menu': ws.id,
                    onClick: (event) => {
                        event.stopPropagation();
                        setOpen(!open);
                    },
                }, h(ui.IconEllipsisOutlineRegular, { size: 14 })),
            });
        }

        /** A canvas to measure text with, made once. */
        let measuring = null;
        /** How wide `text` draws in `font` (a CSS font), in px; 0 where nothing can measure it. */
        function textWidth(text, font) {
            try {
                measuring ??= document.createElement('canvas').getContext('2d');
                if (!measuring) return 0;
                measuring.font = font;
                return measuring.measureText(text).width;
            } catch {
                return 0;
            }
        }

        /**
         * A header's name as it fits its element (DESIGN.md §7): null when the
         * whole name fits; else cut once, after the last whole word that fits
         * with "…"; a first word too long for it alone is left to the CSS,
         * which cuts it at a letter (the whole name is returned). Either way
         * the header shows the whole name in DSH's tooltip.
         * @param measure - (text, font) => px, for the tests.
         */
        function fitName(el, text, measure = textWidth) {
            const width = el?.clientWidth;
            if (!(width > 0) || typeof getComputedStyle !== 'function') return null;
            const cs = getComputedStyle(el);
            const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            // A pixel or two to spare: the browser's text and the canvas's can differ by a fraction.
            const room = width - 2;
            const whole = measure(text, font);
            if (!(whole > 0) || whole <= room) return null;
            const words = text.split(' ');
            for (let n = words.length - 1; n >= 1; n -= 1) {
                const start = words.slice(0, n).join(' ').replace(/[\s.,;:!?…–—-]+$/u, '');
                if (start !== '' && measure(`${start}…`, font) <= room) return `${start}…`;
            }
            return text;
        }

        /**
         * A header in DSH's list, a category's or Other workspaces': its name
         * and how many workspaces it holds; a click, Enter or Space folds or
         * opens it, the arrow keys walk the headers, ⋯, a right-click,
         * Shift+F10 or the context-menu key opens its menu, Alt+↑ and Alt+↓
         * move a category, and a category's header drags (Other workspaces
         * stays last).
         */
        function CategoryHeader({ group, index, count, folded, dot, onToggle, onMove, menu }) {
            // Clicks and keys from the menu (drawn elsewhere in the page) reach here through React, not the page.
            const own = (event) => typeof event.currentTarget?.contains !== 'function' || event.currentTarget.contains(event.target);
            const [open, setOpen] = React.useState(false);
            // The header's own element in DSH's list, found by its mark (DSH's tooltip wraps it).
            const head = React.useRef(null);
            const self = () => head.current ?? (typeof document === 'undefined' ? null
                : [...document.querySelectorAll(SB_HEAD)].find((el) => el.getAttribute('data-categories-sb') === group.id) ?? null);
            // Opened by its keys, the menu gets the keyboard on the header's ⋯ once it shows (see PageTree).
            const byKey = React.useRef(false);
            React.useLayoutEffect(() => {
                if (!open || !byKey.current) return;
                byKey.current = false;
                self()?.querySelector('.dshc-sb-more')?.focus();
            }, [open]);
            // A name too long for the header: cut at a word, the whole name in DSH's tooltip (fitName), measured again
            // whenever the header's width changes (the sidebar widened, a count growing).
            const [cut, setCut] = React.useState(null);
            React.useLayoutEffect(() => {
                const el = self()?.querySelector('.dshc-sb-name');
                if (!el) return undefined;
                const fit = () => {
                    const next = fitName(el, group.name);
                    setCut((prev) => (prev === next ? prev : next));
                };
                fit();
                const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
                observer?.observe(el);
                return () => observer?.disconnect();
            }, [group.name]);
            const n = group.workspaces.length;
            const status = dot === 'warning' ? ', a chat is waiting on you' : dot === 'ongoing' ? ', running' : '';
            const step = (event, by) => {
                const heads = [...(event.currentTarget.parentElement?.querySelectorAll(`:scope>${SB_HEAD}`) ?? EMPTY)];
                heads[heads.indexOf(event.currentTarget) + by]?.focus();
            };
            return h(ui.Tooltip, { label: group.name, side: 'right', portal: true, disabled: cut === null }, h('div', {
                ref: head, role: 'treeitem', tabIndex: 0, 'aria-level': 1, 'aria-expanded': !folded,
                'aria-label': `${group.name}, ${plural(n, 'workspace')}${status}`,
                'aria-keyshortcuts': group.category ? 'Alt+ArrowUp Alt+ArrowDown Shift+F10' : 'Shift+F10',
                // Other workspaces with nothing in it, shown while a workspace is dragged: held where it can be seen.
                className: !group.category && n === 0 ? 'dshc-sb-head dshc-sb-pinned' : 'dshc-sb-head', 'data-categories-sb': group.id,
                'data-categories-menu-open': open ? '' : undefined,
                draggable: group.category,
                style: index === 0 ? { order: 0, marginTop: 0 } : { order: 2 * index },
                onClick: (event) => {
                    if (own(event) && !event.target.closest?.('.dshc-sb-more')) onToggle();
                },
                onContextMenu: (event) => {
                    if (!own(event)) return;
                    event.preventDefault();
                    setOpen(true);
                },
                onKeyDown: (event) => {
                    // The header's own keys; from its ⋯ too once its menu is closed (DSH's menu hands the keyboard back
                    // there), except Enter and Space, the button's own.
                    const more = !open && event.target !== event.currentTarget && own(event) && event.target.closest?.('.dshc-sb-more') != null;
                    if (event.target !== event.currentTarget && !more) return;
                    if (more && (event.key === 'Enter' || event.key === ' ')) return;
                    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                        if (group.category) onMove(event.key === 'ArrowUp' ? -1 : 1);
                    } else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
                        byKey.current = true;
                        setOpen(true);
                    }
                    else if (event.key === 'Enter' || event.key === ' ') onToggle();
                    else if (event.key === 'ArrowRight') onToggle(true);
                    else if (event.key === 'ArrowLeft') onToggle(false);
                    else if (event.key === 'ArrowDown') step(event, 1);
                    else if (event.key === 'ArrowUp') step(event, -1);
                    else return;
                    event.preventDefault();
                    event.stopPropagation();
                },
            },
            h('span', { hidden: true, 'data-categories-node': 'category', 'data-categories-id': group.id }),
            h('span', { className: 'dshc-sb-lead', 'aria-hidden': true },
                h('span', { className: 'dshc-sb-chev' }, h(ui.IconChevronRightOutlineRegular, { size: 12 }))),
            h('span', { className: 'dshc-sb-name', 'data-categories-title': group.name, 'data-categories-cut': cut === null ? undefined : '' }, cut ?? group.name),
            dot ? h('span', { className: 'dshc-sb-dot', 'aria-hidden': true }, h(ui.StateDot, { state: dot })) : null,
            h('span', { className: 'dshc-sb-count', 'aria-hidden': true }, count),
            h(CategoryMenu, { ...menu, group, open, setOpen })));
        }

        /**
         * DSH's session list by category. A header goes over each category's
         * workspaces, with its count, foldable (remembered across restarts),
         * with Other workspaces last (alone while there are no categories, so
         * its ⋯ can make the first), and headers and workspaces drag
         * (useCategoryDrags). DSH has no seat for a header in its list, so the
         * headers are the plugin's own elements added to the list, placed
         * before their sections, and CSS sets DSH's rows under them
         * (sidebarRules). DSH's rows, its order inside each category, its view
         * options and search are its own as before; In one list and search
         * show no headers. A folded workspace's row shows the dot a folded
         * category shows, in a seat of the plugin's own (markWorkspaceDots),
         * whether or not the categories have loaded.
         */
        function SidebarTree({ useWorkspaces = noWorkspaces, useSessionStatus = noStatuses, plugin }) {
            useFacts(plugin.facts);
            useWatch(plugin.facts);
            const items = useWorkspaces((state) => state.items);
            const statuses = useSessionStatus((value) => value);
            const tree = useSidebarTree();
            const [folded, toggle] = useFolded();
            const [dragging, setDragging] = React.useState(false);
            const [dialog, setDialog] = React.useState(null);
            const [toast, setToast] = React.useState(null);
            const [said, setSaid] = React.useState('');
            // The folded workspaces' dots, each in its seat in the workspace's row (markWorkspaceDots).
            const [seats, setSeats] = React.useState(EMPTY);
            // Switched off in its settings, the list is DSH's as it is: no headers, not even Other workspaces.
            const categories = plugin.facts.off?.() === true ? null : plugin.facts.categories();
            const groups = React.useMemo(() => sidebarGroups(categories, items, dragging), [categories, items, dragging]);
            const css = React.useMemo(() => (groups === null ? '' : sidebarRules(groups, folded)), [groups, folded]);
            const byId = React.useMemo(() => new Map((Array.isArray(items) ? items : EMPTY).map((ws) => [ws?.workspaceId, ws])), [items]);
            const titleOf = (id) => workspaceTitle(byId.get(id) ?? { workspaceId: id });
            const refuse = React.useCallback((text) => setToast((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 })), []);
            const announce = (text) => setSaid((prev) => (prev === text ? `${text} ` : text));
            const act = async (method, args, success, then) => {
                const result = await plugin.facts.act(method, args);
                if (!result.ok) refuse(errorText(result.error));
                else {
                    if (success) announce(success);
                    then?.(result);
                }
                return result;
            };
            const ids = (groups ?? EMPTY).filter((g) => g.category).map((g) => g.id);
            /*
             * When a dialog closes, the keyboard goes back where it was (DESIGN.md §9): to the header its menu was
             * opened from. That header takes the focus as the dialog opens, so DSH's dialog, which gives the focus back
             * to what had it, gives it back there (the menu's ⋯ hides once the header loses the focus, and couldn't take
             * it). After a delete, that header is gone: the header now in its place takes it (refocus).
             */
            const headOf = (id) => [...(tree?.querySelectorAll?.(SB_HEAD) ?? EMPTY)].find((el) => el.getAttribute('data-categories-sb') === id) ?? null;
            const refocus = React.useRef(null);
            const openDialog = (next, group) => {
                const head = group ? headOf(group.id) : null;
                if (head && typeof document !== 'undefined' && document.activeElement !== head) head.focus({ preventScroll: true });
                setDialog(next);
            };
            React.useEffect(() => {
                const want = refocus.current;
                if (want === null || dialog !== null || typeof document === 'undefined') return;
                if (Date.now() > want.until) { refocus.current = null; return; }
                const head = headOf(want.id);
                const active = document.activeElement;
                if (head && (active === null || active === document.body)) {
                    refocus.current = null;
                    head.focus({ preventScroll: true });
                }
            });
            const actions = {
                file: (workspace, group, before) => act('fileWorkspace', { workspace, category: group.category ? group.id : '', before: before ?? '' },
                    group.workspaces.includes(workspace) ? SIDEBAR.moved(titleOf(workspace)) : SIDEBAR.filed(titleOf(workspace), group.name), () => toggle(group.id, false)),
                moveCategory: (id, before) => act('moveCategory', { category: id, before: before ?? '' }, SIDEBAR.moved(groups?.find((g) => g.id === id)?.name ?? id)),
                move: (group, by) => {
                    const at = ids.indexOf(group.id);
                    if (at < 0 || at + by < 0 || at + by >= ids.length) return;
                    void actions.moveCategory(group.id, by < 0 ? ids[at - 1] : ids[at + 2] ?? null);
                },
                create: (ws, group) => openDialog({ kind: 'new', ws }, group),
                // DSH's own Add workspace; what it makes goes where the menu was (added, below).
                newWorkspace: (group) => { plugin.addWorkspace?.start((ws) => read.current.added(ws, group.id)); },
                /** New workspace… shows where DSH has its Add workspace: null where it hasn't, else {busy}. */
                adding: () => plugin.addWorkspace?.state() ?? null,
                rename: (group) => openDialog({ kind: 'rename', group }, group),
                remove: (group) => openDialog({ kind: 'delete', group }, group),
            };
            const read = React.useRef(null);
            read.current = {
                groups, folded, titleOf, refuse, dragging: setDragging,
                dotOf: (id) => workspaceDot(byId.get(id), statuses),
                seated: (next) => setSeats((prev) => (sameSeats(prev, next) ? prev : next)),
                file: (ws, group, before) => { void actions.file(ws, group, before); },
                moveCategory: (id, before) => { void actions.moveCategory(id, before); },
                /**
                 * A workspace DSH made from a header's New workspace…: filed
                 * last in that category, as Add a workspace files one. From
                 * Other workspaces (or a category deleted meanwhile) it stays
                 * in none, and the next list puts DSH's order, which takes a
                 * new workspace first, back in category order.
                 */
                added: (ws, id) => {
                    const group = (groups ?? EMPTY).find((g) => g.id === id && g.category);
                    const title = workspaceTitle(ws);
                    if (group) {
                        void act('fileWorkspace', { workspace: ws.workspaceId, category: group.id, before: '' }, SIDEBAR.added(title, group.name), () => toggle(group.id, false));
                        return;
                    }
                    announce(SIDEBAR.added(title, SIDEBAR.others));
                    toggle(OTHERS, false);
                    void plugin.facts.list();
                },
            };
            useTreeSync(tree, read);
            useCategoryDrags(groups === null ? null : tree, read);
            if (tree === null || typeof document === 'undefined') return null;
            // Every workspace DSH lists, with the category it is in, for Add a workspace.
            const where = new Map();
            for (const group of groups ?? EMPTY) if (group.category) for (const ws of group.workspaces) where.set(ws, group);
            const workspaces = (Array.isArray(items) ? items : EMPTY).filter((ws) => typeof ws?.workspaceId === 'string')
                .map((ws) => ({ id: ws.workspaceId, title: workspaceTitle(ws), group: where.get(ws.workspaceId) ?? null }));
            let overlay = null;
            if (dialog?.kind === 'delete') {
                overlay = h(ConfirmDialog, {
                    title: SIDEBAR.deleteTitle, text: SIDEBAR.deleteText(dialog.group.name, dialog.group.workspaces.length), action: SIDEBAR.deleteTitle, busyLabel: SIDEBAR.deleting,
                    onClose: () => setDialog(null),
                    onSubmit: async () => {
                        // The header that takes the deleted one's place: the next one, else Other workspaces when its
                        // workspaces go there, else the one before it.
                        const all = groups ?? EMPTY;
                        const at = all.findIndex((g) => g.id === dialog.group.id);
                        const next = all[at + 1]?.id ?? (dialog.group.workspaces.length > 0 ? OTHERS : all[at - 1]?.id) ?? null;
                        const result = await plugin.facts.act('removeCategory', { category: dialog.group.id });
                        if (!result.ok) return errorText(result.error);
                        announce(SIDEBAR.deleted(dialog.group.name));
                        refocus.current = next === null ? null : { id: next, until: Date.now() + 4000 };
                        setDialog(null);
                        return null;
                    },
                });
            } else if (dialog) {
                const naming = dialog.kind === 'new';
                overlay = h(NameDialog, {
                    title: naming ? SIDEBAR.newTitle : SIDEBAR.renameTitle,
                    description: naming ? (dialog.ws ? SIDEBAR.newWith(titleOf(dialog.ws)) : SIDEBAR.newText) : undefined,
                    label: SIDEBAR.nameLabel,
                    initial: naming ? '' : dialog.group.name,
                    action: naming ? SIDEBAR.create : SIDEBAR.renameAction,
                    busyLabel: naming ? SIDEBAR.creating : SIDEBAR.renaming,
                    onClose: () => setDialog(null),
                    onSubmit: async (name) => {
                        const result = naming
                            ? await plugin.facts.act('createCategory', { name, workspace: dialog.ws ?? '' })
                            : await plugin.facts.act('renameCategory', { category: dialog.group.id, name });
                        if (!result.ok) return errorText(result.error);
                        announce(naming ? SIDEBAR.created(name) : SIDEBAR.renamed(name));
                        setDialog(null);
                        return null;
                    },
                });
            }
            return h(React.Fragment, null,
                css ? ReactDOM.createPortal(h('style', { 'data-categories-sidebar': '' }, css), document.head) : null,
                groups ? ReactDOM.createPortal(groups.map((group, i) => h(CategoryHeader, {
                    key: group.id, group, index: i, count: group.workspaces.length, folded: folded.has(group.id),
                    dot: folded.has(group.id) ? groupDot(group, byId, statuses) : null,
                    onToggle: (open) => toggle(group.id, open === undefined ? undefined : !open),
                    onMove: (by) => actions.move(group, by),
                    menu: { workspaces, actions, first: ids.indexOf(group.id) === 0, last: ids.indexOf(group.id) === ids.length - 1 },
                })), tree) : null,
                // A folded workspace's dot, as a folded category's, in its seat in the workspace's row; said in words
                // there too, so a screen reader reads it with the row's name.
                seats.map((seat) => ReactDOM.createPortal(h(React.Fragment, null,
                    h('span', { 'aria-hidden': true }, h(ui.StateDot, { state: seat.dot })),
                    h('span', { className: 'dshc-sr' }, SIDEBAR.dot(seat.dot))), seat.el, seat.id)),
                // Moves made here, said to screen readers.
                h('div', { className: 'dshc-sr', role: 'status', 'aria-live': 'polite', 'data-categories-sidebar-said': '' }, said),
                // A change that didn't go through, in DSH's banner at the top of the window: anchored to the list,
                // narrower than the sentence, the banner would run off the window's left edge.
                toast ? h(ui.Toast, {
                    key: toast.seq, text: toast.text, icon: h(ui.IconInfoOutlineRegular, { size: 16 }), holdMs: 4000,
                    onDone: () => setToast((prev) => (prev?.seq === toast.seq ? null : prev)),
                }) : null,
                overlay);
        }

        // ── At the top of a session ────────────────────────────────────────

        const CHIP = {
            /** What the chip is to a screen reader. */
            name: (category, workspace) => `Category: ${category}, workspace ${workspace}`,
            open: 'Open Categories',
        };

        /**
         * The sessions a header stands for, nearest first: the session, then
         * the ones a subagent or teammate DSH started works under. Empty for a
         * session DSH doesn't list, or a blank one.
         */
        function chipLine(state, sessionId) {
            const line = [];
            for (let id = sessionId; typeof id === 'string' && id !== '' && line.length < 8 && !line.includes(id); id = state?.byId?.[id]?.parentId) {
                const row = state?.byId?.[id];
                if (!isObject(row) || row.blank === true) break;
                line.push(id);
            }
            return line.length > 0 ? line : EMPTY;
        }

        /** The category holding a workspace, as the plugin lists them (the first, as the session list places it), or undefined. */
        function categoryHolding(categories, workspaceId) {
            if (typeof workspaceId !== 'string' || !Array.isArray(categories)) return undefined;
            return categories.find((c) => isObject(c) && typeof c.id === 'string' && Array.isArray(c.workspaces) && c.workspaces.some((ws) => ws?.id === workspaceId));
        }

        /** DSH's way to the Categories page, as its sidebar entry opens it (DSH's `layout`); undefined where this DSH has none. */
        function pageOpener(ctx) {
            let layout;
            try { layout = ctx.get?.('layout'); } catch { layout = undefined; }
            if (typeof layout?.selectPanel !== 'function') return undefined;
            return () => {
                try { layout.selectPanel(IDS.page); } catch (error) { console.warn(`[categories] could not open the Categories page: ${error?.message ?? error}`); }
            };
        }

        /**
         * Mark DSH's header actions while the chip is among them, for the CSS
         * that lets the chip, and only the chip, give way before the title
         * does: the box right after the title's nav that holds the chip's
         * slot. The CSS names the mark rather than finding the box by what it
         * holds on every update of the window. The mark goes with the chip.
         * @param text - a ref to the chip's text, null while there is no chip.
         */
        function useChipHost(text) {
            const host = React.useRef(null);
            React.useLayoutEffect(() => {
                const slot = text.current?.parentElement?.parentElement;
                const box = slot?.hasAttribute?.('data-slot') ? slot.parentElement : null;
                const next = box?.previousElementSibling?.matches?.('nav[aria-label]') ? box : null;
                if (host.current !== next) host.current?.removeAttribute(CHIP_HOST);
                host.current = next;
                if (next && !next.hasAttribute(CHIP_HOST)) next.setAttribute(CHIP_HOST, '');
            });
            React.useLayoutEffect(() => () => {
                host.current?.removeAttribute(CHIP_HOST);
                host.current = null;
            }, []);
        }

        /**
         * At the top of every session whose workspace is in a category, among
         * DSH's header actions: the category and the workspace, which DSH's
         * header doesn't name. It follows the plugin's list, so a workspace
         * filed in another category or a category renamed shows at the next
         * draw. A click opens the Categories page, as its sidebar entry does;
         * where DSH offers no way there it is plain text. Nothing for a blank,
         * archived or unknown session; a subagent's or a teammate's is its
         * parent's.
         */
        function CategoryChip({ sessionId, useSessions = noSessions, useWorkspaces = noWorkspaces, plugin, openPage }) {
            useFacts(plugin.facts);
            useWatch(plugin.facts);
            const text = React.useRef(null);
            useChipHost(text);
            const line = useSessions((state) => chipLine(state, sessionId), sameList);
            const archived = useWorkspaces((state) => Array.isArray(state?.archivedSessionIds) && state.archivedSessionIds.includes(sessionId));
            const workspaceId = useWorkspaces((state) => line.map((id) => workspaceOfSession(state, id)).find((id) => id !== undefined));
            const workspace = useWorkspaces((state) => workspaceTitle((Array.isArray(state?.items) ? state.items : EMPTY).find((ws) => ws?.workspaceId === workspaceId)));
            const category = categoryHolding(plugin.facts.categories(), workspaceId);
            if (archived || category === undefined || workspace === '') return null;
            const name = typeof category.name === 'string' && category.name !== '' ? category.name : category.id;
            const open = typeof openPage === 'function' ? openPage() : undefined;
            const shown = [
                h(ui.IconFolderCloseRegular, { key: 'g', size: 14, className: 'dshc-chip-glyph', 'aria-hidden': true }),
                h('span', { key: 't', ref: text, className: 'dshc-chip-text', 'aria-hidden': open ? undefined : true },
                    name, h('span', { className: 'dshc-chip-sep' }, '/'), workspace),
            ];
            if (!open) return h('span', { className: 'dshc-chip', 'data-categories-chip': category.id }, h('span', { className: 'dshc-sr' }, CHIP.name(name, workspace)), ...shown);
            return h(ui.Tooltip, { label: `${name} / ${workspace} · ${CHIP.open}`, side: 'bottom' },
                h('button', { type: 'button', className: 'dshc-chip', 'aria-label': CHIP.name(name, workspace), 'data-categories-chip': category.id, onClick: open }, ...shown));
        }

        // ── In DSH's window ────────────────────────────────────────────────

        /**
         * What the views share: the categories, opening a session, and DSH's
         * own Add workspace; nothing here throws into React.
         * @param facts - the categories store (categoryFacts).
         */
        function windowApi(ctx, facts) {
            const warn = (what, error) => { console.warn(`[categories] ${what}: ${error?.message ?? error}`); };
            return {
                facts,
                /** Open a session as DSH's own list does. */
                openSession(sessionId) {
                    if (typeof sessionId !== 'string' || sessionId === '') return;
                    try { ctx.uiWorkspace.openSession(sessionId); } catch (error) { warn('could not open the session', error); }
                },
                /** DSH's own Add workspace, started from a header's New workspace…, and the workspace it makes (workspaceAdder). */
                addWorkspace: workspaceAdder(() => dshAddFlow(ctx.slots), () => {
                    try { return ctx.get?.('workspaces')?.list; } catch { return undefined; }
                }),
            };
        }

        function applyViews(ctx, facts) {
            const plugin = windowApi(ctx, facts);
            const withApi = () => ({ plugin });
            // DSH's session list by category: a header over each category's workspaces, then Other workspaces.
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                name: 'shell.overlay', id: IDS.sidebar, inject: withApi,
            }, SidebarTree));
            // A header's New workspace… still waiting on DSH's flow stops waiting with the plugin.
            ctx.effect(() => () => plugin.addWorkspace.stop(), 'categories: New workspace from the session list');
            // The Categories entry in DSH's sidebar, after Plugins and the projects plugin's Projects (order 5), so
            // the two always list in one order, and the page it opens.
            ctx.slots.inject('main', () => ctx.slots.register({
                name: 'main', key: IDS.page, inject: withApi,
            }, CategoriesPage));
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
                name: 'sidebar.panellist', id: IDS.page, order: 6, label: PAGE.entry,
            }, CategoriesIcon));
            // Where each session sits, at its top: its category and workspace, opening the Categories page. After DSH's
            // subagents (-30); with the projects plugin on, just before its Threads menu (-25).
            ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
                name: 'conversation.session.header.actions', id: IDS.chip, order: -27, inject: () => ({ plugin, openPage: () => pageOpener(ctx) }),
            }, CategoryChip));
        }

        /** Required services (cordis inject); each part below waits for its own. */
        const inject = ['slots'];

        function apply(ctx) {
            // Its styles while it runs, gone when it is switched off (DESIGN.md: off leaves no rule).
            ctx.effect(() => {
                const sheet = addStyles();
                return () => { try { sheet?.remove?.(); } catch { /* already gone with the window */ } };
            }, 'categories: styles');
            // DSH's connection, once DSH provides it: the plugin's endpoints go over it.
            let connection;
            const link = hostLink(() => connection);
            const facts = categoryFacts(link);
            ctx.inject(['connection'], (scope) => scope.effect(() => {
                const service = scope.connection;
                connection = service;
                // The categories, read as soon as the window can ask.
                void facts.list(0);
                return () => { if (connection === service) connection = undefined; };
            }, 'categories: connection'));
            ctx.inject(['uiWorkspace'], (scope) => applyViews(scope, facts));
        }

        module.exports.inject = inject;
        module.exports.apply = apply;
        // For the plugin's own tests: the pieces the views are built on.
        module.exports.internals = {
            BUNDLE, IDS, OTHERS, CSS, TEXT, PAGE, SIDEBAR, CHIP, addStyles,
            hostLink, errorText, categoryFacts, listText, plural, shortPath, folderName, workspaceTitle, workspaceOfSession, sameList, chatDot,
            pageModel, visibleItems, pageMove, treeMeta, treeDot, findInTree, withHit, PageTree, WorkspaceMenu, CategoriesPage, CategoriesIcon, NameDialog, ConfirmDialog,
            sidebarGroups, sidebarRules, workspaceDot, groupDot, sameSeats, sectionWorkspace, sectionAt, placeHeaders, markList, describeWorkspaces, markWorkspaceDots, useTreeSync, useCategoryDrags,
            dshAddFlow, workspaceAdder, CategoryMenu, fitName, CategoryHeader, SidebarTree,
            chipLine, categoryHolding, pageOpener, CategoryChip, useChipHost, windowApi,
        };
        return module.exports;
    },
});
