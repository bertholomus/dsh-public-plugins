/**
 * dsh-plugin-coordinator, browser half. Three parts:
 *
 * - The defaults form on the plugin's page in DSH (Plugins →
 *   Coordinator). It edits the plugin-wide thread model, effort and access
 *   defaults through DSH's own settings forms, so a save lands in the
 *   profile's cordis.patch.yml and the running plugin switches without a
 *   restart.
 * - Thread settings: a dialog per coordinating chat, opened from its
 *   header, its Threads menu and pane, or its row's menu in the session
 *   list. It sets new threads' model and effort, each open thread's, the
 *   user's tools, new threads' permission and pause, through the plugin's
 *   endpoints (remote.js), with a model picker shaped like DSH's own.
 * - Threads in the chat window: a Coordinate action in the header of a
 *   plain chat, a Threads menu in the header of a coordinating chat and of
 *   each thread (a thread also gets a link back to its chat), a Threads pane
 *   in the right sidebar, thread cards under the turns that started or heard
 *   from a thread, a thread's chat opened beside the current one, thread
 *   names in replies that open the thread, and thread rows in the session
 *   list marked and nested under the chat that started them. It reads the
 *   `coordinatorSession` projection the host half folds (projection.js) and
 *   never reads session logs itself.
 *
 * Hand-written in the module format DSH serves to the browser, so the plugin
 * needs no build step: the factory gets DSH's module `require` and returns
 * the client plugin (inject + apply). Each part waits for the DSH services it
 * uses, so a DSH without some of them still runs the rest.
 *
 * @module dsh-plugin-coordinator/client
 */
// DSH serves browser halves in one script; never throw here, or the others stop loading too.
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-coordinator',
    factory: (require) => {
        const module = { exports: {} };
        Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const ReactDOM = require('react-dom');
        const ui = require('@deepseek-ai/dsh-client-ui-primitives');
        const h = React.createElement;

        /** The plugin's row id in the profile; DSH serves its settings under it. */
        const ENTRY = 'coordinator';
        /** The package whose page shows the form. */
        const BUNDLE = 'dsh-plugin-coordinator';
        /** What the defaults form sets a model and effort for: new threads (a coordinating chat keeps the user's own). */
        const ROUTES = [
            { id: 'thread', title: 'New threads', hint: 'A running thread keeps the model it started with.', model: 'threadModel', effort: 'threadEffort' },
        ];
        const FIELDS = ROUTES.flatMap((route) => [route.model, route.effort]);
        /** The plugin-wide access defaults, in the same form; empty is the plugin's own default. */
        const ACCESS_FIELDS = ['yourTools', 'threadPermission'];
        const FORM_FIELDS = [...FIELDS, ...ACCESS_FIELDS];
        /** What an empty access field means. */
        const ACCESS_BUILTIN = { yourTools: 'asked', threadPermission: 'workspace-write' };
        const LABELS = {
            unavailable: 'The coordinator plugin is not running, so its defaults cannot be changed right now.',
            readOnly: 'This DSH stores settings read-only.',
            saveFailed: 'DSH did not save these. Your choices are still here, so you can try again.',
            save: 'Save',
            saving: 'Saving…',
        };
        const INSERTED_TWICE = 'DSH can\'t save here because your profile adds this plugin with "insert:" (the older setup). In cordis.patch.yml, change that row to "- id: coordinator" with its "config:", as in the plugin README. Below is what the plugin runs with now.';
        const NOTE = 'These apply to every coordinating chat that doesn\'t set its own. A chat\'s own choice, made in its Thread settings or by asking in the chat, comes first. Default follows DSH\'s default model, which is the one last picked in any DSH chat.';

        /** DSH's branch glyph, as a mask for links drawn by DSH's markdown. */
        const BRANCH_MASK = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.3"><path d="M1.015 8h4.681c.723 0 1.085 0 1.425-.08.302-.072.591-.19.857-.35.3-.18.558-.433 1.075-.939l2.275-2.225"/><path d="M1.012 8h4.684c.723 0 1.085 0 1.425.08.302.072.591.19.857.35.3.18.558.433 1.075.939l2.275 2.225"/><circle cx="12.45" cy="3.308" r="1.57"/><circle cx="12.45" cy="12.692" r="1.57"/></svg>')}")`;
        /** The corner that hangs a nested thread under its coordinator, as DSH's own tree corner (IconTreeCornerRegular). */
        const CORNER_MASK = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 11" fill="none" stroke="#000"><path d="M0.5 0V7C0.5 7.79565 0.81607 8.55871 1.37868 9.12132C1.94129 9.68393 2.70435 10 3.5 10H8.5"/></svg>')}")`;
        /** Drawn in a nested thread's indent, under its coordinator's leading seat, its foot level with the row's middle. */
        const NEST_CORNER = `content:"";position:absolute;z-index:1;pointer-events:none;top:calc(50% - 11px);left:calc(var(--dsh-workspace-indent,0px) + 15px);width:10px;height:12px;background:var(--dsw-alias-label-tertiary);-webkit-mask:${CORNER_MASK} center/contain no-repeat;mask:${CORNER_MASK} center/contain no-repeat`;
        /** Out of sight, still read by screen readers. */
        const HIDDEN = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';
        /** DSH's focus ring color, as its own controls draw it. */
        const RING = 'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))';
        // DSH's error red and link blue reach only 4.5 and 4.2:1 as small text on white: a touch of the
        // label colour takes them past 5:1 in light and further from the background in dark.
        const ERROR_TEXT = 'color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary))';
        const LINK_TEXT = 'color-mix(in srgb,var(--dsw-alias-link,var(--dsw-alias-state-business-primary)) 85%,var(--dsw-alias-label-primary))';
        /** Every view the plugin draws, by its root: what the motion rules reach (with what DSH draws inside them). */
        const MOTION_ROOTS = ':is(.dshp-t-hdr,.dshp-t-menu,.dshp-mp,.dshp-mp-menu,.dshp-pp,.dshp-ps,.dshp-page,.dshp-t-pane,.dshp-t-cards,.dshp-t-card,.dshp-nt,.dshp-dock,.dshp-start,.dshp-ch,.dshp-t-chat,.dshp-t-hover,.dshp-t-mark,.dshp-t-tab,.dshp-rn,.dshp-problems)';
        const CSS = [
            // Keyboard focus: DSH's ring on every plugin control. DSH's own buttons (Open, Retry, Save…) get its outline;
            // the plugin's own controls draw it inset below, so a scrolling list can't clip it.
            `:where(.dshp-t-card-actions,.dshp-t-paused,.dshp-dock,.dshp-ps,.dshp-page,.dshp-t-chat-bar,.dshp-t-pane-gear) button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ${RING};outline-offset:2px}`,
            // Default models form
            '.dshp-heading{margin:0 0 4px;font-size:14px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
            // Settings to fix: a line in the error colour, no ground of its own (the page is DSH's).
            '.dshp-problems{display:flex;flex-direction:column;gap:4px;margin:0 0 16px;padding:2px 0 2px 12px;border-left:2px solid var(--dsw-alias-state-error-primary)}',
            `.dshp-problems-title{color:${ERROR_TEXT}}`,
            '.dshp-problems-list{margin:2px 0 0;padding-left:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
            '.dshp-problems-list>li+li{margin-top:4px}',
            '.dshp-section{display:flex;flex-direction:column;gap:2px;padding:12px 0}',
            '.dshp-section+.dshp-section{border-top:.5px solid var(--dsw-alias-border-l2)}',
            '.dshp-title{margin:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
            '.dshp-hint,.dshp-note{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
            '.dshp-note{padding-top:4px}',
            '.dshp-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 16px;margin-top:8px}',
            '.dshp-route{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}',
            '.dshp-route-text{display:flex;flex-direction:column;gap:2px;flex:1 1 220px;min-width:0}',
            '.dshp-route-text .dshp-hint{margin:0}',
            '.dshp-route-note{color:var(--dsw-alias-label-secondary)}',
            '.dshp-route>.dshp-hint{flex:1 1 220px}',
            // The plugin's page: the defaults, then the thread options
            '.dshp-page{display:flex;flex-direction:column}',
            '.dshp-options{display:flex;flex-direction:column;margin-top:12px;padding:16px 0 4px;border-top:.5px solid var(--dsw-alias-border-l2)}',
            '.dshp-option{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:8px 0}',
            '.dshp-option-text{min-width:0}',
            '.dshp-option-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
            '.dshp-option-hint{margin-top:4px;max-width:560px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-option>span{flex:none;display:flex}',
            // Model picker: DSH's composer model menu, as a settings control
            '.dshp-mp{position:relative;display:inline-flex;flex:none;min-width:0;max-width:100%}',
            '.dshp-mp-trigger{display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;min-width:0;max-width:min(300px,100%);height:32px;padding:0 10px 0 12px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:nowrap;cursor:pointer}',
            '.dshp-mp-trigger:hover:not(:disabled),.dshp-mp-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}',
            '.dshp-mp-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
            '.dshp-mp-trigger:disabled{cursor:default;opacity:.6}',
            '.dshp-mp-name{min-width:0;overflow:hidden;text-overflow:ellipsis}',
            '.dshp-mp-effort{flex-shrink:1000;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
            '.dshp-mp-trigger>svg,.dshp-mp-trigger>span:last-child:not(.dshp-mp-name):not(.dshp-mp-effort){flex:none;color:var(--dsw-alias-label-tertiary)}',
            '.dshp-mp-chev{transition:transform .12s}',
            '.dshp-mp-chev-open{transform:rotate(180deg)}',
            '.dshp-mp-menu{position:fixed;z-index:1100;box-sizing:border-box;display:flex;flex-direction:column;width:max-content;min-width:min(264px,calc(100vw - 32px));max-width:min(420px,calc(100vw - 32px));max-height:min(380px,calc(100vh - 96px));padding:4px;overflow:hidden;box-shadow:var(--dsw-elevation-prominent);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);color:var(--dsw-alias-label-primary);outline:none}',
            '.dshp-mp-cell,.dshp-mp-opt,.dshp-mp-back{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;border:0;border-radius:var(--dsw-radius-md);background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;outline:none}',
            '.dshp-mp-cell{height:34px;padding:0 8px;font-size:13px;line-height:20px}',
            '.dshp-mp-cell:hover,.dshp-mp-cell:focus-visible,.dshp-mp-opt:hover:not(:disabled),.dshp-mp-opt:focus-visible,.dshp-mp-back:hover,.dshp-mp-back:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
            '.dshp-mp-cell-label{flex:none;white-space:nowrap}',
            '.dshp-mp-cell-value{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-secondary)}',
            '.dshp-mp-cell>svg{flex:none;color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-tertiary))}',
            '.dshp-mp-back{height:28px;margin-bottom:2px;padding:0 7px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-mp-back:hover,.dshp-mp-back:focus-visible{color:var(--dsw-alias-label-primary)}',
            '.dshp-mp-opt{min-height:34px;padding:5px 7px;font-size:13px;line-height:18px}',
            '.dshp-mp-opt:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
            '.dshp-mp-opt-copy{display:flex;flex-direction:column;flex:1;min-width:0}',
            '.dshp-mp-opt-name,.dshp-mp-opt-detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshp-mp-opt-detail{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-mp-check{flex:0 0 14px;display:grid;place-items:center;color:var(--dsw-alias-label-primary)}',
            '.dshp-mp-check svg{width:14px;height:14px}',
            '.dshp-mp-sep{flex:none;height:.5px;margin:3px 7px;background:var(--dsw-alias-border-l2)}',
            '.dshp-mp-list{min-height:0;overflow-y:auto}',
            '.dshp-mp-search{position:relative;flex:none;margin:2px 0 3px}',
            '.dshp-mp-search .dshp-mp-search-box{display:flex;height:auto;padding:5px 7px;border:0 solid transparent;border-radius:var(--dsw-radius-md);background:none}',
            '.dshp-mp-search .dshp-mp-search-box:focus-within{border-color:transparent}',
            '.dshp-mp-search .dshp-mp-search-box input{padding:0;font-size:12px;line-height:normal}',
            '.dshp-mp-search .dshp-mp-search-box input::placeholder{color:var(--dsw-alias-label-secondary)}',
            '.dshp-mp-search .dshp-mp-search-query{padding-right:34px}',
            '.dshp-mp-search-clear{position:absolute;top:50%;right:4px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;transform:translateY(-50%)}',
            '.dshp-mp-search-clear:hover,.dshp-mp-search-clear:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshp-mp-search-clear:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-mp-empty{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            // Access: DSH's permission icons, the permission picker (DSH's access chip, in the model picker's shape), Your tools.
            '.dshp-perm-glyph{flex:none;display:inline-flex;align-items:center}',
            '.dshp-nowrap{white-space:nowrap}',
            '.dshp-perm-glyph>svg{display:block}',
            '.dshp-pp{display:inline-flex;min-width:0;max-width:100%}',
            '.dshp-pp-trigger .dshp-perm-glyph{color:var(--dsw-alias-label-secondary)}',
            '.dshp-pp-compact{gap:4px;padding:0 8px 0 10px}',
            '.dshp-pp-opt{display:inline-flex;flex-direction:column;min-width:0;max-width:100%}',
            '.dshp-pp-opt-name,.dshp-pp-opt-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshp-pp-opt-detail{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-tools-control{flex:none;display:inline-flex}',
            '.dshp-tools-pair{display:inline-flex;gap:4px}',
            '.dshp-tool-names{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}',
            '.dshp-tool-name{padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-heading-next{margin-top:20px}',
            // Threads: header menu
            '.dshp-t-hdr{position:relative;display:inline-flex;align-items:center;gap:2px;min-width:0}',
            '.dshp-t-trigger{display:inline-flex;align-items:center;gap:5px;min-width:0;min-height:28px;padding:3px 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}',
            '.dshp-t-trigger:hover,.dshp-t-trigger:focus-visible,.dshp-t-trigger[aria-expanded=true]{color:var(--dsw-alias-label-primary)}',
            `.dshp-t-trigger:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-t-trigger svg{flex:none}',
            '.dshp-t-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
            '.dshp-t-parent .dshp-t-label{max-width:180px}',
            '.dshp-t-signal{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px}',
            '.dshp-t-chev{transition:transform .12s}',
            '.dshp-t-chev-open{transform:rotate(180deg)}',
            // In a narrow header the link back to a thread's chat and Coordinate keep only their icons (and their names for screen readers).
            '@container (width<=480px){.dshp-t-parent .dshp-t-label,.dshp-t-coordinate .dshp-t-label{display:none}}',
            // Coordinate on DSH's new-chat screen, in the composer's row: shaped like DSH's controls there, and while
            // on, like its Plan chip (its stop glyph on hover). A narrow row keeps only the icon.
            '.dshp-start{display:inline-flex;align-items:center;min-width:0}',
            '.dshp-start-btn{display:inline-flex;align-items:center;gap:4px;min-width:0;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}',
            '.dshp-start-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
            `.dshp-start-btn:focus-visible{outline:none;box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-start-btn:disabled{opacity:.6;cursor:default}',
            '.dshp-start-btn.dshp-start-on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}',
            '.dshp-start-btn.dshp-start-on:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-tertiary),var(--dsw-alias-state-business-primary) 6%);color:var(--dsw-alias-state-business-primary)}',
            '.dshp-start-glyph{flex:none;display:inline-flex;width:14px;height:14px}',
            '.dshp-start-glyph>svg{display:block}',
            '.dshp-start-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
            '.dshp-start-glyph>.dshp-start-stop,.dshp-start-on:hover:not(:disabled) .dshp-start-rest,.dshp-start-on:focus-visible .dshp-start-rest{display:none}',
            '.dshp-start-on:hover:not(:disabled) .dshp-start-stop,.dshp-start-on:focus-visible .dshp-start-stop{display:block}',
            '@container (width<=520px){.dshp-start-label{display:none}}',
            '.dshp-t-menu{position:fixed;z-index:100;box-sizing:border-box;display:flex;flex-direction:column;width:400px;max-width:calc(100vw - 32px);max-height:min(560px,calc(100vh - 120px));padding:4px;box-shadow:var(--dsw-elevation-prominent);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);color:var(--dsw-alias-label-primary);outline:none}',
            '.dshp-t-menu-head{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 9px 4px}',
            '.dshp-t-menu-head .dshp-t-project{max-width:100%}',
            '.dshp-t-project{display:inline-flex;align-items:center;gap:6px;flex:1;min-width:0;padding:2px 0;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);text-align:left}',
            'button.dshp-t-project{cursor:pointer}',
            'button.dshp-t-project:hover .dshp-t-project-name,button.dshp-t-project:focus-visible .dshp-t-project-name{text-decoration:underline}',
            `button.dshp-t-project:focus-visible{outline:none;box-shadow:0 0 0 2px ${RING}}`,
            '.dshp-t-project-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshp-t-count{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
            '.dshp-t-menu-body{flex:1 1 auto;min-height:0;overflow:auto}',
            '.dshp-t-menu-foot{margin-top:3px;padding-top:3px;border-top:.5px solid var(--dsw-alias-border-l2)}',
            // Threads: what new threads run on and can reach, under the chat's name
            '.dshp-t-models{display:flex;flex-direction:column;margin:0 0 3px;padding:0 0 3px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
            '.dshp-t-models-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:28px;padding:4px 9px;border:0;border-radius:var(--dsw-radius-md);background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);text-align:left}',
            'button.dshp-t-models-row{cursor:pointer}',
            'button.dshp-t-models-row:hover,button.dshp-t-models-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
            'button.dshp-t-models-row:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
            '.dshp-t-models-label{flex:none;width:84px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-t-models-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshp-t-models-row>svg{flex:none;color:var(--dsw-alias-label-tertiary)}',
            '.dshp-t-models-glyph{flex:none;display:inline-flex;margin-right:-3px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-t-pane .dshp-t-models{margin:0 0 6px;padding:0 0 8px}',
            '.dshp-t-pane .dshp-t-models-row{min-height:32px;padding:6px 10px;font-size:13px;line-height:20px}',
            '.dshp-t-pane .dshp-t-models-label{width:96px}',
            '.dshp-t-group{display:flex;align-items:center;gap:4px;box-sizing:border-box;width:100%;padding:8px 9px 3px;border:0;background:none;font:inherit;font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:left}',
            'button.dshp-t-group{cursor:pointer;border-radius:var(--dsw-radius-sm)}',
            'button.dshp-t-group:hover,button.dshp-t-group:focus-visible{outline:none;color:var(--dsw-alias-label-primary)}',
            `button.dshp-t-group:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            'button.dshp-t-group svg{flex:none;transition:transform .12s}',
            'button.dshp-t-group[aria-expanded=true] svg{transform:rotate(90deg)}',
            // Threads: rows (menu and pane)
            // A row is its open button (the whole row) with its Retry, Resume or Open beside buttons laid over the
            // button's right end, which keeps their room free (--dshp-t-acts): no control sits inside another.
            '.dshp-t-row{position:relative;box-sizing:border-box;width:100%;border-radius:var(--dsw-radius-lg);font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary);outline:none}',
            '.dshp-t-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.dshp-t-row:has(>.dshp-t-main[aria-disabled=true]):hover{background:none}',
            '.dshp-t-main{display:grid;grid-template-columns:14px minmax(0,1fr);column-gap:8px;align-items:start;box-sizing:border-box;width:100%;min-height:44px;margin:0;padding:6px 6px 6px 9px;border:0;border-radius:inherit;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;outline:none}',
            '.dshp-t-row[data-acts]>.dshp-t-main{padding-right:calc(14px + var(--dshp-t-acts))}',
            `.dshp-t-main:focus-visible{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-t-main[aria-disabled=true]{cursor:default}',
            '.dshp-t-dot{grid-column:1;grid-row:1;display:inline-flex;align-items:center;justify-content:center;width:14px;height:17px}',
            '.dshp-t-text{display:contents}',
            '.dshp-t-name{grid-column:2;grid-row:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            // The second line: the summary keeps at least 150px; the counts, model and time wrap under it when they need more.
            '.dshp-t-second{grid-column:2;grid-row:2;display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:1px;min-width:0}',
            '.dshp-t-main[aria-current=true] .dshp-t-name{font-weight:600}',
            '.dshp-t-line{flex:1 1 150px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-t-meta{flex:none;margin-left:auto;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;height:16px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
            '.dshp-t-model{min-width:0;overflow:hidden;text-overflow:ellipsis}',
            '.dshp-t-tools,.dshp-t-perm{flex:0 1 auto;display:inline-flex;align-items:center;gap:3px;min-width:0;max-width:140px}',
            '.dshp-t-tools>span,.dshp-t-perm>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis}',
            '.dshp-t-tools>svg{flex:none}',
            '.dshp-t-ago{flex:none}',
            '.dshp-t-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;margin:-4px -2px -4px 0;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
            '.dshp-t-icon:hover,.dshp-t-icon:focus-visible,.dshp-t-icon[aria-expanded=true]{outline:none;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
            `.dshp-t-icon:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-t-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 9px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            `.dshp-t-error{color:${ERROR_TEXT}}`,
            '.dshp-t-retry{flex:none;display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:12px;color:inherit;cursor:pointer}',
            '.dshp-t-retry:hover,.dshp-t-retry:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshp-t-retry:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-t-foot-btn{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:32px;padding:6px 9px;border:0;border-radius:var(--dsw-radius-lg);background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer}',
            '.dshp-t-foot-btn:hover,.dshp-t-foot-btn:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
            `.dshp-t-foot-btn:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            // Threads: right-sidebar pane
            '.dshp-t-pane{box-sizing:border-box;height:100%;overflow:auto;padding:14px 10px 24px;color:var(--dsw-alias-label-primary);container:dshp-pane/inline-size}',
            '.dshp-t-pane-head{display:flex;flex-direction:column;gap:2px;padding:0 10px 8px}',
            '.dshp-t-pane-head .dshp-t-project{font-size:14px;line-height:20px}',
            '.dshp-t-pane-head .dshp-t-count{font-size:12px;line-height:18px}',
            '.dshp-t-pane .dshp-t-row{font-size:13px;line-height:18px}',
            '.dshp-t-pane .dshp-t-main{min-height:54px;padding:8px 8px 8px 10px}',
            '.dshp-t-pane .dshp-t-row[data-acts]>.dshp-t-main{padding-right:calc(16px + var(--dshp-t-acts))}',
            '.dshp-t-pane .dshp-t-row-acts{right:8px}',
            '.dshp-t-pane .dshp-t-dot{height:18px}',
            '.dshp-t-pane .dshp-t-meta{height:17px;line-height:17px}',
            '.dshp-t-pane .dshp-t-line{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal;font-size:12px;line-height:17px}',
            '.dshp-t-pane .dshp-t-group{padding:12px 10px 4px}',
            // Find a thread, above a long list; the found words are marked in each name.
            '.dshp-t-find{position:relative;margin:0 0 6px}',
            '.dshp-t-find .dshp-t-find-box{display:flex;width:100%;box-sizing:border-box}',
            '.dshp-t-find .dshp-t-find-query{padding-right:34px}',
            '.dshp-t-notice.dshp-t-find-none{padding:6px 10px}',
            '.dshp-t-hit{background:none;color:inherit;font-weight:600}',
            '.dshp-t-empty{padding:28px 16px;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            // Threads: a thread's chat in the right sidebar
            '.dshp-t-chat{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0}',
            '.dshp-t-chat-bar{flex:none;display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:40px;padding:4px 8px 4px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
            '.dshp-t-chat-title{display:flex;flex-direction:column;flex:1;min-width:0}',
            '.dshp-t-chat-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;line-height:17px;color:var(--dsw-alias-label-primary)}',
            '.dshp-t-chat-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-t-chat-body{display:flex;flex:1 1 auto;min-width:0;min-height:0}',
            '.dshp-t-tab-title{display:inline-flex;align-items:center;gap:6px;min-width:0}',
            '.dshp-t-tab-title>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            // Threads: a thread's Changes tab, its bar and buttons as DSH's own Review tab draws them
            '.dshp-ch{display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;color:var(--dsw-alias-label-primary)}',
            '.dshp-ch-bar{flex:none;display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:44px;padding:4px 6px 4px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
            '.dshp-ch-title{display:flex;flex-direction:column;align-items:flex-start;flex:1;min-width:0}',
            '.dshp-ch-name{max-width:100%;padding:0;border:0;background:none;font:inherit;font-size:12px;font-weight:500;line-height:17px;color:var(--dsw-alias-label-primary);text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            'button.dshp-ch-name{cursor:pointer}',
            'button.dshp-ch-name:hover,button.dshp-ch-name:focus-visible{outline:none;text-decoration:underline}',
            '.dshp-ch-sub{display:inline-flex;align-items:center;gap:6px;min-height:15px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
            '.dshp-ch-tool{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}',
            '.dshp-ch-tool:hover,.dshp-ch-tool:focus-visible{outline:none;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshp-ch-tool:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-ch-tool[aria-disabled=true]{cursor:progress}',
            '.dshp-ch-busy{animation:dshp-ch-turn 1s linear infinite}',
            '@keyframes dshp-ch-turn{to{transform:rotate(360deg)}}',
            '@media (prefers-reduced-motion:reduce){.dshp-ch-busy{animation:none}}',
            '.dshp-ch-body{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:8px 8px 20px}',
            '.dshp-ch-files{display:flex;flex-direction:column;gap:8px}',
            '.dshp-ch-file{display:flex;flex-direction:column;min-width:0}',
            '.dshp-ch-file-head{display:flex;align-items:center;gap:2px;min-width:0}',
            '.dshp-ch-file-toggle{display:flex;align-items:center;gap:6px;flex:1;min-width:0;height:30px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}',
            '.dshp-ch-file-toggle:hover,.dshp-ch-file-toggle:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshp-ch-file-toggle:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-ch-chev{flex:none;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg);transition:transform .12s}',
            '.dshp-ch-chev-open{transform:none}',
            '.dshp-ch-file-icon,.dshp-ch-tab-icon{flex:none;display:inline-flex}',
            '.dshp-ch-path{flex:0 1 auto;min-width:0}',
            '.dshp-ch-new{flex:none;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-ch-file-head .dshp-t-counts{flex:none;margin-left:auto;padding-left:6px;font-size:11px}',
            '.dshp-ch-file-body{display:flex;flex-direction:column;gap:4px;min-width:0;padding:2px 0 10px}',
            // The file's name heads its section, so DSH's diff leaves out its own path row (always its body's first).
            '.dshp-ch-diff[data-diff]>:nth-child(2)>:first-child{display:none}',
            // DSH's code card keeps its margin for chat; here the file's own spacing holds.
            '.dshp-ch-diff[data-diff]{margin:0}',
            '.dshp-ch-note{margin:0;padding:0 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
            // Under the path: the toggle's padding, chevron, icon and their gaps.
            '.dshp-ch-note.dshp-ch-when{margin-top:-6px;padding-left:46px}',
            // "Each edit (N)": the file's edits one by one, under the diff of what they came to.
            '.dshp-ch-each{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;height:24px;padding:0 6px 0 4px;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
            '.dshp-ch-each:hover,.dshp-ch-each:focus-visible{outline:none;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshp-ch-each:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-ch-net,.dshp-ch-edits,.dshp-ch-edit{display:flex;flex-direction:column;gap:4px;min-width:0}',
            // Each edit of several: its place, turn and author over its own diff, so one edit reads apart from the next.
            '.dshp-ch-edit+.dshp-ch-edit{margin-top:6px}',
            '.dshp-ch-note.dshp-ch-edit-head{display:flex;align-items:center;gap:8px;min-width:0}',
            '.dshp-ch-edit-head .dshp-t-counts{flex:none;margin-left:auto;padding-right:2px}',
            `.dshp-ch-link{padding:0;border:0;background:none;font:inherit;color:${LINK_TEXT};text-decoration:underline;text-underline-offset:2px;cursor:pointer}`,
            `.dshp-ch-link:focus-visible{outline:2px solid ${RING};outline-offset:1px;border-radius:2px}`,
            '.dshp-ch-foot{display:flex;flex-direction:column;gap:6px;margin-top:12px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l3)}',
            // The plugin's messages between sessions: DSH's notice box, saying what came in (TriggerNotice).
            '.dshp-nt{min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-turn-trigger-bg,var(--dsw-alias-markdown-code-block));container-type:inline-size;transition:background-color .1s}',
            '.dshp-nt:hover{background:var(--dsw-alias-turn-trigger-bg-hover,var(--dsw-alias-interactive-bg-hover))}',
            '.dshp-nt-head{display:flex;align-items:center;gap:10px;box-sizing:border-box;width:100%;padding:12px 16px;border:0;border-radius:inherit;background:none;font:inherit;text-align:left;color:var(--dsw-alias-label-secondary);cursor:pointer;outline:none}',
            `.dshp-nt-head:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-nt-icon{flex:none;display:inline-flex}',
            '.dshp-nt-line{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size,14px)}',
            '.dshp-nt-name{font-weight:500;color:var(--dsw-alias-label-primary)}',
            // A handback is the turn's news: its whole line reads in the label colour.
            '.dshp-nt[data-projects-notice=handback] .dshp-nt-head{color:var(--dsw-alias-label-primary)}',
            '.dshp-nt-state{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
            '.dshp-nt-time{flex:none;margin-left:auto;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}',
            '.dshp-nt-chev{flex:none}',
            '.dshp-nt-state+.dshp-nt-chev,.dshp-nt-line+.dshp-nt-chev{margin-left:auto}',
            '.dshp-nt-chev-open{transform:rotate(180deg)}',
            '.dshp-nt-body{padding:0 16px 12px 40px}',
            '.dshp-nt-why{margin:8px 0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}',
            '.dshp-nt-text{margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}',
            // In a chat beside a thread, the time gives way first; the name gives way before the state.
            // Narrow (a coordinator beside its thread), a long thread name takes a second line rather than being cut.
            '@container (width<=480px){.dshp-nt-line{white-space:normal;overflow-wrap:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}}',
            '@container (width<=380px){.dshp-nt-time{display:none}.dshp-nt-state+.dshp-nt-chev{margin-left:0}.dshp-nt-state{margin-left:auto}.dshp-nt-head{gap:8px;padding:12px 12px}.dshp-nt-body{padding:0 12px 12px 34px}}',
            '@media (prefers-reduced-motion:reduce){.dshp-nt{transition:none}}',
            // Threads: cards under a turn
            '.dshp-t-cards{display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);container-type:inline-size}',
            // A card is a grid: icon, then verb, name and reason stacked, then counts, state and actions.
            '.dshp-t-card{display:grid;grid-template-columns:28px minmax(0,1fr) auto auto auto;align-items:center;row-gap:1px;box-sizing:border-box;min-height:48px;padding:8px 10px 8px 12px}',
            '.dshp-t-card+.dshp-t-card{border-top:.5px solid var(--dsw-alias-border-l2)}',
            '.dshp-t-card-icon{grid-column:1;grid-row:1/4;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
            '.dshp-t-card-text{display:contents}',
            '.dshp-t-card-verb{grid-column:2;grid-row:1;min-width:0;margin-left:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-t-card-title{grid-column:2;grid-row:2;justify-self:start;max-width:calc(100% - 10px);margin-left:10px;overflow:hidden;padding:0;border:0;background:none;font:inherit;font-size:13px;font-weight:500;line-height:19px;color:var(--dsw-alias-label-primary);text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
            '.dshp-t-card-title:hover{text-decoration:underline}',
            `.dshp-t-card-title:focus-visible{outline:none;border-radius:3px;box-shadow:0 0 0 2px ${RING}}`,
            '.dshp-t-card-title:disabled{cursor:default;text-decoration:none}',
            '.dshp-t-card-state{grid-column:4;grid-row:1/4;margin-left:10px;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
            '.dshp-t-card-actions{grid-column:5;grid-row:1/4;margin-left:10px;display:inline-flex;align-items:center;gap:4px}',
            '.dshp-t-card>.dshp-t-changes{grid-column:3;grid-row:1/4;margin-left:10px}',
            '.dshp-t-card-side{display:contents}',
            '.dshp-t-card-actions .dshp-t-icon{width:28px;height:28px;margin:0}',
            // Threads: a thread whose last turn failed or stopped, on its newest card
            '.dshp-t-card[data-card-tone=error] .dshp-t-card-icon{color:var(--dsw-alias-state-error-primary)}',
            '.dshp-t-card-when{font-variant-numeric:tabular-nums}',
            '.dshp-t-card-why{grid-column:2;grid-row:3;margin-left:10px;display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
            // What a thread is doing (its step, how far along, how long) or what it reported, under its name.
            '.dshp-t-card-detail{grid-column:2;grid-row:3;min-width:0;margin-left:10px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-t-card-detail:not([data-projects-card-detail=running]){display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}',
            '.dshp-t-card-detail[data-projects-card-detail=running]{display:flex;align-items:center;gap:5px}',
            '.dshp-t-card-meter{margin-right:2px}',
            '.dshp-t-card-meter{flex:none;position:relative;width:36px;height:4px;overflow:hidden;border-radius:2px;background:var(--dsw-alias-bg-layer-3)}',
            '.dshp-t-card-meter>span{position:absolute;inset:0 auto 0 0;border-radius:2px;background:var(--dsw-alias-label-secondary);transition:width .3s ease}',
            '.dshp-t-card-count,.dshp-t-card-elapsed,.dshp-t-card-dot{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}',
            '.dshp-t-card-step{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            // The actions' box lets clicks through to the row under it; only its buttons take them.
            '.dshp-t-row-acts{position:absolute;top:0;bottom:0;right:6px;display:inline-flex;align-items:center;justify-content:flex-end;gap:2px;pointer-events:none}',
            '.dshp-t-row-acts>*{pointer-events:auto}',
            '.dshp-t-icon:disabled{cursor:default}',
            // A narrow chat gives the name the counts' room: they join the verb line, and drop their file count first.
            '@container (width<=560px){.dshp-t-card>.dshp-t-changes{grid-row:1;height:16px;margin-left:6px;padding:0 3px}.dshp-t-card>.dshp-t-changes .dshp-t-changes-icon{display:none}.dshp-t-card-title,.dshp-t-card-why,.dshp-t-card-detail{grid-column:2/4}}',
            // Narrower still, the state and buttons move to a row of their own under the name, which keeps the card's width.
            '@container (width<=460px){.dshp-t-card .dshp-t-files{display:none}.dshp-t-card-icon{align-self:start}.dshp-t-card-side{grid-column:2/4;grid-row:4;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0 0 10px}.dshp-t-card-side>.dshp-t-card-state,.dshp-t-card-side>.dshp-t-card-actions{margin-left:0}.dshp-t-card-side>.dshp-t-card-actions:only-child{margin-left:auto}}',
            '@container (460px<width<=560px){.dshp-t-full-label{display:none}}',
            // A coordinator beside its thread is about 400 px wide: Full view keeps its icon and tooltip, and the buttons move under
            // the state rather than cut it ("Sto…"); only a state wider than the card itself is cut.
            '@container (width<=400px){.dshp-t-full-label{display:none}.dshp-t-card-side{flex-wrap:wrap;row-gap:6px}.dshp-t-card-side>.dshp-t-card-actions{margin-left:auto}.dshp-t-card-side>.dshp-t-card-state{min-width:0;max-width:100%;overflow:hidden}.dshp-t-card-state-text{min-width:0;overflow:hidden;text-overflow:ellipsis}}',
            '@container (width<=300px){.dshp-t-go-label,.dshp-t-full-label{display:none}}',
            '.dshp-t-go-label,.dshp-t-full-label{white-space:nowrap}',
            // Threads: a thread's code changes, in DSH's colors for added and deleted lines
            '.dshp-t-changes{flex:none;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:26px;padding:0 7px;border:0;border-radius:var(--dsw-radius-md);background:none;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
            'button.dshp-t-changes{cursor:pointer}',
            'button.dshp-t-changes:hover,button.dshp-t-changes:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
            'button.dshp-t-changes:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
            '.dshp-t-changes-icon{flex:none;display:inline-flex}',
            // In a thread's header, its own changes: the counts open its Changes tab.
            '.dshp-t-changes-pill .dshp-t-counts{font-size:11px}',
            '@container (width<=480px){.dshp-t-changes-pill .dshp-t-changes-icon{display:none}}',
            '.dshp-t-counts{display:inline-flex;gap:5px;font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums}',
            // DSH's green is too light to read on white at this size; deepened toward the text color.
            '.dshp-t-added{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-label-primary))}',
            `.dshp-t-deleted{color:${ERROR_TEXT}}`,
            // DSH's hover card is dark in both themes.
            '.dshp-t-hover-line .dshp-t-added{color:var(--dsw-alias-state-success-primary)}',
            '.dshp-t-hover-line .dshp-t-deleted{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,white)}',
            '.dshp-t-row-changes{flex:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
            // Threads: paused threads, in the menu and the pane
            '.dshp-t-paused{display:flex;align-items:center;gap:10px;margin:0 0 4px;padding:8px 8px 8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-t-paused-icon{flex:none;display:inline-flex;color:var(--dsw-alias-label-primary)}',
            '.dshp-t-paused-text{flex:1;min-width:0}',
            '.dshp-t-paused-text b{font-weight:600;color:var(--dsw-alias-label-primary)}',
            '.dshp-t-pane .dshp-t-paused{margin:0 0 8px;padding:10px 10px 10px 12px;font-size:13px;line-height:19px}',
            '.dshp-t-paused-mark{color:var(--dsw-alias-label-secondary)}',
            // Paused threads, above the message box (as DSH docks a goal there)
            '.dshp-dock{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,0px) - 4 * var(--dsh-composer-dock-inset,0px));margin:0 auto;container:dshp-dock/inline-size}',
            '.dshp-dock-bar{isolation:isolate;position:relative;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;max-width:calc(var(--dsh-composer-card-max-width,760px) - 4 * var(--dsh-composer-dock-inset,0px));min-height:36px;margin:0 auto;padding:4px 5px 4px 12px;border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)}',
            '.dshp-dock-bar::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);pointer-events:none}',
            // Asked for less transparency, the bar's menu glass is laid on DSH's own opaque card ground and blurs nothing.
            '@media (prefers-reduced-transparency:reduce){.dshp-dock-bar::before{background:linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu)),var(--dsw-alias-bg-layer-2);backdrop-filter:none}}',
            '.dshp-dock-glyph{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}',
            '.dshp-dock-label{flex:none;font-size:13px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
            '.dshp-dock-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-secondary))}',
            // A failed thread's reason may run long: two lines, then the bar's tooltip.
            '.dshp-dock-wrap .dshp-dock-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal}',
            '.dshp-dock-glyph[data-state=stopped]{color:var(--dsw-alias-label-secondary)}',
            '.dshp-dock-time{flex:none;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
            // In a narrow chat the text takes its own line under the label, so the held count and what it means stay whole.
            '@container dshp-dock (max-width:600px){.dshp-dock-bar{flex-wrap:wrap;row-gap:0;padding-bottom:7px}.dshp-dock-label{flex:1 1 auto}.dshp-dock-text{order:1;box-sizing:border-box;flex:1 1 100%;padding-inline:24px 7px;white-space:normal}}',
            // Threads: `[title](.dsh-thread/t3)` in a reply (DSH draws it as a file link)
            'button[title*=".dsh-thread/"]>svg:first-child{display:none}',
            `button[title*=".dsh-thread/"][title]{color:${LINK_TEXT}}`,
            `button[title*=".dsh-thread/"]::before{content:"";display:inline-block;flex:none;width:1.1em;height:1.1em;margin-right:5px;vertical-align:-.25em;background-color:currentColor;-webkit-mask:${BRANCH_MASK} center/contain no-repeat;mask:${BRANCH_MASK} center/contain no-repeat}`,
            // DSH draws the link as an inline block, which sits on its last line: in a list, a link that wraps would
            // pull the bullet down to its second line, so it hangs from the top of the line instead.
            'li button[title*=".dsh-thread/"]{vertical-align:top}',
            // Threads: session list rows. A thread row under its coordinator is indented, with a corner in the
            // indent (nestingCss); a thread row anywhere else keeps a branch mark in the leading seat.
            '.dshp-t-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:20px;color:var(--dsw-alias-label-tertiary)}',
            // A coordinator with news the user hasn't seen reads bold, like unread mail (RowPlace marks it, markUnread its row).
            '[data-row-key][data-projects-unread-row]{font-weight:600}',
            // The seat is DSH's, 16 px, and holds one mark: the plugin's gives way to DSH's or another plugin's there
            // (hidden the way a nested thread's branch mark is, so the row's description still says it). The seat
            // never widens, so the other marks keep their place and the title its room.
            `[data-row-key^="session:"]>* .dshp-t-mark:not(:only-child),[data-row-key^="session:"]>* [data-slot]:not(:only-child)>.dshp-t-mark{${HIDDEN}}`,
            '.dshp-t-hover{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:16px;color:#cfd3d6}',
            '.dshp-t-hover-head{display:flex;align-items:center;gap:6px;color:#fff}',
            '.dshp-t-hover-line{color:#adb2b8;overflow-wrap:anywhere}',
            // The same 6px between the counts and "· N files" as on cards and rows.
            '.dshp-t-hover-line[data-projects-changes]{display:flex;align-items:center;gap:6px}',
            '.dshp-t-hover-line[data-projects-access]{display:flex;align-items:flex-start;gap:6px}',
            '.dshp-t-hover-line[data-projects-access]>.dshp-perm-glyph{margin-top:2px}',
            // Thread settings dialog
            '.dshp-t-gear{padding:3px 5px}',
            '.dshp-t-pane-head{position:relative;padding-right:40px}',
            '.dshp-t-pane-gear{position:absolute;top:2px;right:6px}',
            '.dshp-ps.dshp-ps{width:min(560px,100%);max-height:100%}',
            '.dshp-ps-content{min-height:0;overflow-y:auto;padding-bottom:4px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}',
            '.dshp-ps-sub{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
            '.dshp-ps-sub b{font-weight:500;color:var(--dsw-alias-label-primary)}',
            '.dshp-ps-path{display:inline-flex;align-items:center;gap:4px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-ps-path>svg{flex:none}',
            '.dshp-ps-path>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshp-ps-section+.dshp-ps-section{margin-top:22px}',
            '.dshp-ps-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 2px 8px}',
            '.dshp-ps-heading{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
            '.dshp-ps-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
            '.dshp-ps-card{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}',
            '.dshp-ps-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;box-sizing:border-box;min-height:60px;padding:12px 14px}',
            '.dshp-ps-row+.dshp-ps-row{border-top:.5px solid var(--dsw-alias-border-l2)}',
            '.dshp-ps-text{display:flex;flex-direction:column;flex:1 1 220px;gap:2px;min-width:0}',
            '.dshp-ps-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
            '.dshp-ps-title>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshp-ps-title>.dshp-ps-dot{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px}',
            '.dshp-ps-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-ps-source{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-ps-fit{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-ps-own{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-ps-own::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}',
            '.dshp-ps-link{padding:0;border:0;background:none;font:inherit;color:var(--dsw-alias-label-secondary);text-decoration:underline;text-decoration-color:var(--dsw-alias-border-l4);text-underline-offset:2px;cursor:pointer}',
            '.dshp-ps-link:hover,.dshp-ps-link:focus-visible{outline:none;color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}',
            `.dshp-ps-link:focus-visible{border-radius:3px;box-shadow:0 0 0 2px ${RING}}`,
            '.dshp-ps-link:disabled{cursor:default;opacity:.6}',
            '.dshp-ps-alert{flex:1 0 100%;margin:0;padding:6px 8px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}',
            `.dshp-ps-alert.dshp-ps-error{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover));color:${ERROR_TEXT}}`,
            '.dshp-ps-alert.dshp-ps-info{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
            '.dshp-ps-empty{padding:16px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dshp-ps-more{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;min-height:40px;padding:8px 14px;border:0;border-top:.5px solid var(--dsw-alias-border-l2);background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;border-radius:0 0 var(--dsw-radius-xl) var(--dsw-radius-xl)}',
            '.dshp-ps-more:hover,.dshp-ps-more:focus-visible{outline:none;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
            `.dshp-ps-more:focus-visible{box-shadow:inset 0 0 0 2px ${RING}}`,
            '.dshp-ps-more svg{transition:transform .12s}',
            '.dshp-ps-more[aria-expanded=true] svg{transform:rotate(90deg)}',
            '.dshp-ps-note{margin:18px 2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            // Rename… (RenameThread): its line, its error and its field.
            '.dshp-ar-line{margin:0 0 10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
            `.dshp-ar-error{color:${ERROR_TEXT}}`,
            '.dshp-rn-form{margin:0 0 10px}',
            '.dshp-rn-form>span{width:100%}',
            '.dshp-ps-state{display:flex;flex-direction:column;align-items:center;gap:10px;padding:36px 12px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
            `.dshp-ps-state.dshp-ps-error{color:${ERROR_TEXT}}`,
            '.dshp-ps-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;min-width:0;max-width:100%}',
            '.dshp-ps-reach{display:inline-flex;align-items:flex-start;gap:5px;min-width:0}',
            '.dshp-ps-reach>.dshp-perm-glyph{margin-top:3px}',
            '.dshp-ps-reach>span:last-child{min-width:0}',
            // A place DSH's own drag may not drop a session (useSessionDragGuard): no line there.
            '[data-projects-refused] [data-row-key^="session:"]::before,[data-projects-refused] [data-row-key^="session:"]::after{display:none!important}',
            // Motion stops while Wallpaper's motion switch is off (body.wp-still) or the system asks for less motion:
            // the plugin's own transitions and spinner, and DSH's parts drawn inside its views, pseudo-elements too.
            `body.wp-still ${MOTION_ROOTS},body.wp-still ${MOTION_ROOTS}::before,body.wp-still ${MOTION_ROOTS}::after,body.wp-still ${MOTION_ROOTS} *,body.wp-still ${MOTION_ROOTS} *::before,body.wp-still ${MOTION_ROOTS} *::after{animation:none!important;transition:none!important}`,
            `@media (prefers-reduced-motion:reduce){${MOTION_ROOTS},${MOTION_ROOTS}::before,${MOTION_ROOTS}::after,${MOTION_ROOTS} *,${MOTION_ROOTS} *::before,${MOTION_ROOTS} *::after{animation:none!important;transition:none!important}}`,
        ].join('');
        const CSS_ID = `${BUNDLE}/client.css`;
        /** The plugin's one style sheet in <head>, added once; never a throw, which would stop other plugins loading. */
        function mountStyle() {
            try {
                if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) !== null) return;
                const tag = document.createElement('style');
                tag.dataset.plugin = BUNDLE;
                tag.dataset.pluginCss = CSS_ID;
                tag.textContent = CSS;
                document.head.appendChild(tag);
            } catch {}
        }
        /** Take the style sheet away again: switched off, the plugin leaves no rule behind. */
        function unmountStyle() {
            try {
                if (typeof document !== 'undefined') document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`)?.remove?.();
            } catch {}
        }
        mountStyle();

        // ── Default models form ────────────────────────────────────────────

        /**
         * The Host model catalog, shared by every part of the window: the
         * forms read it again each time they open, and the thread views load
         * it once to name models.
         * @param remoteOf - DSH's `remote` service, or undefined until DSH provides it.
         */
        function catalogSource(remoteOf) {
            let snapshot = { status: 'idle', value: undefined };
            let tried = 0;
            // A reload asked for while a read is in flight runs once that read lands.
            let again = false;
            const listeners = new Set();
            const set = (next) => {
                snapshot = next;
                for (const listener of [...listeners]) listener();
                if (again && next.status !== 'loading') {
                    again = false;
                    source.load();
                }
            };
            const source = {
                getSnapshot: () => snapshot,
                subscribe: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                load() {
                    if (snapshot.status === 'loading') return;
                    tried = Date.now();
                    set({ status: 'loading', value: snapshot.value });
                    let session;
                    try { session = remoteOf()?.session; } catch { session = undefined; }
                    if (!session || typeof session.modelCatalog !== 'function') {
                        set({ status: 'failed', value: snapshot.value });
                        return;
                    }
                    Promise.resolve().then(() => session.modelCatalog()).then((result) => {
                        const value = result && result.ok === true ? result.value : result && Array.isArray(result.groups) ? result : undefined;
                        set(value ? { status: 'ready', value } : { status: 'failed', value: snapshot.value });
                    }, () => set({ status: 'failed', value: snapshot.value }));
                },
                /** Load once, for views that only name models; a failed read is tried again after a while. */
                ensure() {
                    if (snapshot.status === 'idle' || (snapshot.status === 'failed' && Date.now() - tried > 15000)) source.load();
                },
                /** DSH's remote arrived or changed: the next ensure reads again. */
                reset() {
                    if (snapshot.status !== 'loading') set({ status: 'idle', value: snapshot.value });
                },
                /** DSH's default model may have changed: read again now, or right after the read in flight. */
                reload() {
                    if (snapshot.status === 'loading') again = true;
                    else source.load();
                },
            };
            return source;
        }

        const selectionKey = (s) => (s ? `${s.provider}:${s.model}:${s.reasoningEffort ?? ''}` : '');

        /**
         * Each loaded session's model pick, keyed as selectionKey ('' for a
         * session DSH has sent with no pick yet); sessions DSH has not sent
         * are left out, so loading one is not taken for a pick.
         */
        function picksIn(state) {
            const out = new Map();
            const ids = new Set([...Object.keys(state?.projectionsBySession ?? {}), ...Object.keys(state?.byId ?? {})]);
            for (const id of ids) {
                const value = state.projectionsBySession?.[id]?.values?.modelSelection ?? state.byId?.[id]?.projectionValues?.modelSelection;
                if (isObject(value)) out.set(id, selectionKey(selectionIn(state, id)));
            }
            return out;
        }

        /** After a pick, when to read the catalog again while it still names another default (ms after the pick). */
        const DEFAULT_RETRIES = [300, 1000, 2500];

        /**
         * A pick in any chat's composer is also DSH's new default model, saved
         * in the background (its session controller's selectModel). The
         * catalog read once would keep naming the old one, so a new pick in a
         * loaded session reads it again, and again a moment later while the
         * save has not landed. The plugin's own picks for its sessions leave
         * DSH's default as it is; they cost a few reads.
         * @returns a stop function.
         */
        function followDefault(sessions, catalog, timers = {}) {
            const frame = timers.frame ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16));
            const cancel = timers.cancel ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout);
            const later = timers.later ?? setTimeout;
            const clear = timers.clear ?? clearTimeout;
            let seen = picksIn(sessions.list.getSnapshot());
            let pending = 0;
            let retry;
            const check = () => {
                pending = 0;
                const now = picksIn(sessions.list.getSnapshot());
                let picked;
                for (const [id, key] of now) if (key !== '' && seen.has(id) && seen.get(id) !== key) picked = key;
                seen = now;
                // A catalog nothing has read yet is read fresh by the first view that needs it.
                if (picked === undefined || catalog.getSnapshot().status === 'idle') return;
                clear(retry);
                catalog.reload();
                const again = (i, at) => {
                    if (i >= DEFAULT_RETRIES.length) { retry = undefined; return; }
                    retry = later(() => {
                        if (selectionKey(catalog.getSnapshot().value?.default) === picked) { retry = undefined; return; }
                        catalog.reload();
                        again(i + 1, DEFAULT_RETRIES[i]);
                    }, DEFAULT_RETRIES[i] - at);
                };
                again(0, 0);
            };
            const off = sessions.list.subscribe(() => { if (!pending) pending = frame(check); });
            return () => {
                off();
                if (pending) cancel(pending);
                clear(retry);
            };
        }

        /** Every model in a catalog, keyed "provider:model" as the plugin stores it. */
        function modelsOf(catalog) {
            const out = [];
            for (const group of (catalog && catalog.groups) || []) {
                for (const model of group.models || []) {
                    const reasoning = model.reasoning || {};
                    out.push({
                        key: `${group.id}:${model.id}`,
                        provider: group.id,
                        providerName: group.name || group.id,
                        id: model.id,
                        name: model.name || model.id,
                        efforts: (reasoning.efforts || []).map((e) => ({ id: e.id, name: e.name || e.id })),
                        defaultEffort: reasoning.defaultEffort,
                    });
                }
            }
            return out;
        }

        /** The catalog model a stored value names: "provider:model", "provider/model" or a bare id. */
        function findModel(models, text, defaultProvider) {
            const value = String(text || '').trim();
            if (value === '') return undefined;
            const m = /^([a-zA-Z0-9_-]+)[:/](.+)$/.exec(value);
            if (m) return models.find((x) => x.provider === m[1] && x.id === m[2]);
            const hits = models.filter((x) => x.id === value);
            return hits.find((x) => x.provider === defaultProvider) || hits[0];
        }

        const effortName = (model, id) => ((model && model.efforts.find((e) => e.id === id)) || { name: id }).name;

        /**
         * Whether the profile adds the plugin's row with `insert` (the older
         * setup): the row is then in the profile twice, the plugin runs the
         * later one, and DSH refuses every save. It shows as values the plugin
         * runs with that come from neither layer a save edits.
         */
        function insertedTwice(snapshot) {
            if (!snapshot || snapshot.status !== 'ready') return false;
            const has = (layer, key) => layer !== null && typeof layer === 'object' && layer[key] !== undefined && layer[key] !== '';
            return FORM_FIELDS.some((key) => has(snapshot.value, key) && !has(snapshot.user, key) && !has(snapshot.base, key));
        }

        /** Provider groups of a model list in catalog order, DSH's own account first as its picker does. */
        function groupsOf(models) {
            const groups = [];
            for (const model of models) {
                let group = groups.find((g) => g.provider === model.provider);
                if (!group) groups.push(group = { provider: model.provider, name: model.providerName, models: [] });
                group.models.push(model);
            }
            const rank = (group) => (group.provider === 'deepseek-account' ? 0 : group.provider === 'deepseek-official' ? 1 : 2);
            return groups.sort((a, b) => rank(a) - rank(b));
        }

        /** A catalog read once for the pickers: its models, provider groups, every effort they list, and the DSH default. */
        function catalogView(catalog) {
            const models = modelsOf(catalog);
            const def = catalog && catalog.default;
            const known = [...new Set(models.flatMap((model) => model.efforts.map((e) => e.id)))];
            return { models, groups: groupsOf(models), known, def, defaultModel: def ? findModel(models, `${def.provider}:${def.model}`) : undefined };
        }

        /** Effort names from least to most reasoning, ranked as the plugin ranks them (lib/settings.js). */
        const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

        /** The level a model runs for an effort it lacks, as the plugin picks it: the highest at or below it, else its lowest. */
        function nearestEffort(offered, effort, known) {
            const rank = (e) => {
                const i = EFFORT_ORDER.indexOf(e);
                return i >= 0 ? i : EFFORT_ORDER.length + known.indexOf(e);
            };
            const below = offered.filter((e) => rank(e) <= rank(effort)).sort((a, b) => rank(b) - rank(a));
            return below[0] ?? [...offered].sort((a, b) => rank(a) - rank(b))[0];
        }

        /**
         * What a model and effort setting runs on: the catalog model (DSH's
         * default model when none is set) and the effort DSH fills in for it.
         * @param {object} cv - catalogView().
         * @param {string|undefined} modelText - "provider:model", or unset.
         * @param {string|undefined} effortText - an effort id, or unset.
         */
        function resolveRoute(cv, modelText, effortText) {
            const set = typeof modelText === 'string' && modelText.trim() !== '';
            const model = set ? findModel(cv.models, modelText, cv.def && cv.def.provider) : cv.defaultModel;
            const efforts = model ? model.efforts : [];
            const wanted = typeof effortText === 'string' && effortText.trim() !== '' ? effortText.trim() : undefined;
            const asked = wanted ?? (!set && cv.def && cv.def.reasoningEffort ? cv.def.reasoningEffort : model && model.defaultEffort);
            // An effort the model lacks runs at the nearest level it offers (the
            // plugin fits it the same way), or at its default when no model has it.
            const lacks = model && efforts.length > 0 && asked !== undefined && !efforts.some((e) => e.id === asked);
            const effort = lacks ? (cv.known.includes(asked) ? nearestEffort(efforts.map((e) => e.id), asked, cv.known) : model.defaultEffort) : asked;
            // A model the catalog lists says whether it has efforts; until then a stored effort shows as it is.
            const shown = model ? (efforts.length > 0 ? effort : undefined) : wanted;
            return {
                model,
                name: model ? model.name : set ? modelText.trim().replace(/^[a-zA-Z0-9_-]+[:/]/, '') : 'DSH default',
                efforts,
                effort: shown,
                // Like DSH's picker: a model whose provider picks the effort shows "Default".
                effortName: shown !== undefined ? effortName(model, shown) : efforts.length > 0 ? 'Default' : undefined,
                // A set effort the model can't use: fitted, or ignored by a model with no levels.
                unused: lacks || (model && efforts.length === 0 && wanted !== undefined) ? wanted ?? asked : undefined,
            };
        }

        /** An effort's name as any catalog model lists it. */
        function anyEffortName(cv, id) {
            for (const model of cv.models) {
                const found = model.efforts.find((e) => e.id === id);
                if (found) return found.name;
            }
            return String(id).charAt(0).toUpperCase() + String(id).slice(1);
        }

        /**
         * Why a set effort is not what runs (resolveRoute's `unused`), or
         * undefined. An inherited effort on a model without levels is left
         * unsaid, as DSH's picker hides effort for such a model.
         */
        function effortNote(cv, route, own = true) {
            if (route.unused === undefined || !route.model || (!own && route.efforts.length === 0)) return undefined;
            const asked = anyEffortName(cv, route.unused);
            return route.efforts.length === 0
                ? `${route.name} has no effort levels, so ${asked} isn't used.`
                : `${route.name} doesn't offer ${asked}, so it runs at ${route.effortName}.`;
        }

        /**
         * What a loaded session's next request really uses, when it differs
         * from what its setting shows: a coordinator set up on an earlier DSH
         * default keeps that model, and a change can fail.
         */
        function liveNote(cv, route, live) {
            if (!isObject(live) || typeof live.provider !== 'string' || typeof live.model !== 'string' || !route.model) return undefined;
            const model = findModel(cv.models, `${live.provider}:${live.model}`);
            const effort = typeof live.reasoningEffort === 'string' ? live.reasoningEffort : undefined;
            if (model && model.key === route.model.key && (effort === undefined || route.effort === undefined || effort === route.effort)) return undefined;
            return `It runs on ${model ? model.name : live.model}${effort ? ` · ${model ? effortName(model, effort) : effort}` : ''} right now.`;
        }

        const MEASURE = Object.freeze({ visibility: 'hidden', left: 0, top: 0 });

        /**
         * A model and effort control in the shape of DSH's own composer
         * picker: a "Model · Effort" trigger opening a menu with a Model row
         * and an Effort row, each leading to its list (models by provider, with
         * search past four). With `fallback`, both lists start with Default,
         * which hands the choice back to what the setting inherits; without it
         * they hold explicit choices only.
         * @param props.value - {model?, effort?}: the values in force.
         * @param props.own - {model, effort}: whether each is set at this level, so Default is not checked.
         * @param props.fallback - {model?, effort?, modelLabel?, effortLabel?}: what Default means, or undefined.
         * @param props.onPick - called with {model?, effort?}: a value, or null for Default.
         * @param props.autoOpen - open the menu once, when the picker first shows.
         */
        function ModelPicker({ id, label, catalog, value, own, fallback, busy = false, disabled = false, autoOpen = false, onPick }) {
            const cv = React.useMemo(() => catalogView(catalog), [catalog]);
            const route = resolveRoute(cv, value.model, value.effort);
            const base = fallback ? resolveRoute(cv, fallback.model, fallback.effort) : undefined;
            const effortBase = fallback ? resolveRoute(cv, value.model, fallback.effort) : undefined;
            const [open, setOpen] = React.useState(false);
            const [pane, setPane] = React.useState('root');
            const [query, setQuery] = React.useState('');
            const [side, setSide] = React.useState('bottom');
            const rootRef = React.useRef(null);
            const triggerRef = React.useRef(null);
            const menuRef = React.useRef(null);
            const listRef = React.useRef(null);
            const searchRef = React.useRef(null);
            const intent = React.useRef(null);
            const position = ui.useAnchoredPosition({ open, anchorRef: triggerRef, panelRef: menuRef, side, align: 'end', gap: 6, margin: 12 });
            const close = React.useCallback((refocus) => {
                setOpen(false);
                setPane('root');
                setQuery('');
                if (refocus) queueMicrotask(() => triggerRef.current?.focus());
            }, []);
            const dismiss = React.useCallback((next) => { if (!next) close(false); }, [close]);
            ui.useDismissOnOutsidePointer(rootRef, open, dismiss, menuRef);
            React.useEffect(() => { if (disabled) close(false); }, [disabled, close]);
            const showSearch = cv.models.length > 4;
            const typed = showSearch ? query.trim() : '';
            const groups = React.useMemo(() => cv.groups.map((group) => ({ ...group, models: ui.rankByName(group.models, typed) }))
                .filter((group) => group.models.length > 0), [cv.groups, typed]);
            // Once a pane is placed: the search field, the row that opened it, or its checked row.
            React.useLayoutEffect(() => {
                const want = intent.current;
                const menu = menuRef.current;
                if (!open || position === null || want === null || !menu) return;
                intent.current = null;
                const first = menu.querySelector('[data-dshp-pick]:not(:disabled):not([data-dshp-pick=back])');
                const target = want === 'search' ? searchRef.current
                    : want === 'model' || want === 'effort' ? menu.querySelector(`[data-dshp-pick=${want}]`)
                        : want === 'checked' ? menu.querySelector('[data-dshp-pick][aria-checked=true]') ?? first : first;
                target?.focus();
            }, [open, position, pane]);
            React.useEffect(() => {
                const viewport = listRef.current;
                if (!open || pane !== 'model' || viewport === null) return undefined;
                return ui.observeStickyMenuGroups(viewport);
            }, [open, pane, groups]);

            const show = () => {
                if (disabled) return;
                const rect = triggerRef.current?.getBoundingClientRect();
                const below = rect ? window.innerHeight - rect.bottom : Infinity;
                setSide(rect && below < 320 && rect.top > below ? 'top' : 'bottom');
                setPane('root');
                setQuery('');
                intent.current = 'first';
                setOpen(true);
            };
            // Opened from the Threads menu's models summary, or at one thread: this menu is what the user asked for.
            React.useEffect(() => { if (autoOpen) show(); }, [autoOpen]);
            const drill = (next) => {
                setQuery('');
                intent.current = next === 'model' && showSearch ? 'search' : 'checked';
                setPane(next);
            };
            const back = () => {
                intent.current = pane;
                setQuery('');
                setPane('root');
            };
            const pick = (change) => {
                close(true);
                onPick(change);
            };
            /** A model change also sets an effort the new model offers, when the effort that would apply is not one. */
            // A new model keeps no effort it can't use: an own effort it lacks is
            // cleared (no levels) or moved to its default; an inherited one is
            // fitted by the plugin when it runs.
            const withEffort = (model, change) => {
                const applies = own.effort ? value.effort : fallback?.effort;
                if (!model || !applies || model.efforts.some((e) => e.id === applies)) return change;
                if (model.efforts.length === 0) return own.effort ? { ...change, effort: null } : change;
                return { ...change, effort: model.defaultEffort ?? model.efforts[0].id };
            };
            const chooseModel = (model) => {
                if (model === null) return own.model ? pick(withEffort(base?.model, { model: null })) : close(true);
                if (own.model && route.model?.key === model.key) return close(true);
                return pick(withEffort(model, { model: model.key }));
            };
            const chooseEffort = (effort) => {
                if (effort === null) return own.effort ? pick({ effort: null }) : close(true);
                if (own.effort && route.effort === effort) return close(true);
                return pick({ effort });
            };

            const onMenuKey = (event) => {
                if (event.nativeEvent?.isComposing) return;
                const menu = menuRef.current;
                if (!menu) return;
                const items = [...menu.querySelectorAll('[data-dshp-pick]:not(:disabled)')];
                const at = items.indexOf(document.activeElement);
                const inSearch = searchRef.current !== null && event.target === searchRef.current;
                const stop = () => { event.preventDefault(); event.stopPropagation(); };
                if (event.key === 'Escape') {
                    stop();
                    if (pane === 'root') close(true);
                    else back();
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    stop();
                    if (items.length === 0) return;
                    const step = event.key === 'ArrowDown' ? 1 : -1;
                    if (inSearch) (step > 0 ? items[0] : items[items.length - 1]).focus();
                    else if (at === 0 && step < 0 && searchRef.current) searchRef.current.focus();
                    else items[at < 0 ? 0 : (at + step + items.length) % items.length].focus();
                } else if ((event.key === 'Home' || event.key === 'End') && !inSearch) {
                    stop();
                    items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
                } else if (event.key === 'ArrowLeft' && !inSearch && pane !== 'root') {
                    stop();
                    back();
                } else if (event.key === 'ArrowRight' && pane === 'root' && at >= 0) {
                    stop();
                    items[at].click();
                } else if (event.key === 'Enter' && inSearch) {
                    stop();
                    menu.querySelector('[data-dshp-model]:not(:disabled)')?.click();
                } else if (event.key === 'Tab') {
                    stop();
                    if (event.shiftKey) {
                        if (pane === 'root') close(true);
                        else back();
                    } else if (at >= 0) items[at].click();
                    else close(true);
                }
            };

            const check = (on) => h('span', { className: 'dshp-mp-check', 'aria-hidden': true }, on ? h(ui.IconCheckOutlineRegular, { size: 14 }) : null);
            const option = ({ key, name, detail, checked, onClick, model = false }) => h('button', {
                key, type: 'button', role: 'menuitemradio', 'aria-checked': checked, className: 'dshp-mp-opt',
                'data-dshp-pick': 'opt', 'data-dshp-model': model ? '' : undefined, title: detail ? `${name} · ${detail}` : name, onClick,
            },
            h('span', { className: 'dshp-mp-opt-copy' },
                h('span', { className: 'dshp-mp-opt-name' }, name),
                detail ? h('span', { className: 'dshp-mp-opt-detail' }, detail) : null),
            check(checked));
            const cell = (which, text, shown) => h('button', {
                key: which, type: 'button', role: 'menuitem', className: 'dshp-mp-cell', 'data-dshp-pick': which, onClick: () => drill(which),
            },
            h('span', { className: 'dshp-mp-cell-label' }, text),
            h('span', { className: 'dshp-mp-cell-value' }, shown),
            h(ui.IconChevronRightOutlineRegular, { size: 12 }));
            const backRow = (text) => h('button', { key: 'back', type: 'button', className: 'dshp-mp-back', 'data-dshp-pick': 'back', onClick: back },
                h(ui.IconChevronLeftOutlineRegular, { size: 12 }), h('span', null, text));
            const sep = (key) => h('div', { key, className: 'dshp-mp-sep', role: 'separator' });

            let content;
            if (pane === 'root') {
                content = [
                    cell('model', 'Model', route.name),
                    route.efforts.length > 0 ? cell('effort', 'Effort', route.effortName ?? 'Default') : null,
                ];
            } else if (pane === 'model') {
                content = [
                    backRow('Model'),
                    showSearch ? h('div', { key: 'search', className: 'dshp-mp-search' }, h(ui.Input, {
                        ref: searchRef, className: query !== '' ? 'dshp-mp-search-box dshp-mp-search-query' : 'dshp-mp-search-box', type: 'text', role: 'searchbox',
                        placeholder: 'Search models…', 'aria-label': 'Search models', value: query,
                        onChange: (event) => setQuery(event.target.value),
                    }), query !== '' ? h('button', {
                        type: 'button', className: 'dshp-mp-search-clear', 'aria-label': 'Clear search',
                        onClick: () => { setQuery(''); searchRef.current?.focus(); },
                    }, h(ui.IconCloseFillRegular, null)) : null) : null,
                    base && typed === '' ? option({
                        key: 'default', name: 'Default', checked: !own.model, onClick: () => chooseModel(null),
                        detail: `${fallback.model ? fallback.modelLabel ?? 'Default' : 'DSH default'} · ${base.name}`,
                    }) : null,
                    base && typed === '' ? sep('sep') : null,
                    h('div', { key: 'list', ref: listRef, className: 'dshp-mp-list scrollable', role: 'menu', 'aria-label': 'Models', hidden: groups.length === 0 },
                        ...groups.map((group) => h(ui.MenuGroup, { key: group.provider, label: group.name },
                            ...group.models.map((model) => option({
                                key: model.key, name: model.name, model: true, onClick: () => chooseModel(model),
                                checked: own.model && route.model !== undefined && route.model.key === model.key,
                            }))))),
                    groups.length === 0 ? h('div', { key: 'empty', className: 'dshp-mp-empty', role: 'status' },
                        cv.models.length === 0 ? 'No models to choose from yet.' : 'No matching models.') : null,
                ];
            } else {
                const effortSource = fallback?.effort ? fallback.effortLabel ?? 'Default' : value.model ? 'Model default' : 'DSH default';
                content = [
                    backRow('Effort'),
                    effortBase ? option({
                        key: 'default', name: 'Default', checked: !own.effort, onClick: () => chooseEffort(null),
                        detail: `${effortSource} · ${effortBase.effortName ?? 'none'}`,
                    }) : null,
                    effortBase ? sep('sep') : null,
                    ...route.efforts.map((effort) => option({
                        key: effort.id, name: effort.name, onClick: () => chooseEffort(effort.id),
                        checked: own.effort && route.effort === effort.id,
                    })),
                ];
            }
            const caption = route.effortName ? `${route.name} · ${route.effortName}` : route.name;
            const menu = open ? ReactDOM.createPortal(h(ui.MenuSurface, {
                ref: menuRef, id: `${id}-menu`, className: 'dshp-mp-menu', role: pane === 'model' ? 'group' : 'menu',
                'aria-label': `${label}: model and effort`, 'data-projects-model-menu': id,
                style: position ?? MEASURE,
                onKeyDown: onMenuKey,
            }, ...content), document.body) : null;
            return h('div', { ref: rootRef, className: 'dshp-mp', 'data-projects-model-picker': id },
                h('button', {
                    ref: triggerRef, type: 'button', id, className: 'dshp-mp-trigger', disabled,
                    'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? `${id}-menu` : undefined,
                    'aria-label': `${label}: ${caption}`, 'aria-busy': busy || undefined, title: caption,
                    onClick: () => (open ? close(true) : show()),
                    onKeyDown: (event) => {
                        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
                            event.preventDefault();
                            show();
                        }
                    },
                },
                h('span', { className: 'dshp-mp-name' }, route.name),
                route.effortName ? h('span', { className: 'dshp-mp-effort' }, route.effortName) : null,
                busy ? h(ui.StateDot, { state: 'ongoing' }) : h(ui.IconChevronDownOutlineRegular, { size: 12, className: open ? 'dshp-mp-chev dshp-mp-chev-open' : 'dshp-mp-chev' })),
                menu);
        }

        /** Plain text controls, for a DSH whose model catalog cannot be read. */
        function TextFields({ route, state, actions, disabled }) {
            const text = (name, label, hint) => h(ui.SettingsValueField, {
                id: `dshp-${route.id}-${name}`, label, hint,
                overriddenLabel: 'Set here', resetLabel: 'Use default', invalidLabel: 'Not a valid value.',
                disabled, placeholder: 'Default',
                ...state[name],
                onEdit: (value) => actions.edit(name, value),
                onReset: () => actions.resetField(name),
            });
            return [
                text(route.model, 'Model', '"provider:model" or a model id; empty uses the DSH default.'),
                text(route.effort, 'Effort', 'For DeepSeek: off, low, high or max; empty uses the model default.'),
            ];
        }

        function RouteSection({ route, state, actions, catalog, models, disabled }) {
            const head = h('h4', { className: 'dshp-title' }, route.title);
            if (catalog.status === 'failed' && models.length === 0) {
                return h('section', { className: 'dshp-section', 'data-projects-route': route.id },
                    head, h('p', { className: 'dshp-hint' }, route.hint),
                    h('div', { className: 'dshp-row' }, ...TextFields({ route, state, actions, disabled })));
            }
            const text = (name) => state[name].text.trim();
            const cv = catalogView(catalog.value);
            const shown = resolveRoute(cv, text(route.model) || undefined, text(route.effort) || undefined);
            const note = text(route.effort) !== '' ? effortNote(cv, shown) : undefined;
            const fix = shown.efforts.length === 0 ? { label: 'Clear it', value: '' } : { label: `Use ${shown.effortName}`, value: shown.effort ?? '' };
            return h('section', { className: 'dshp-section', 'data-projects-route': route.id },
                head,
                h('div', { className: 'dshp-route' },
                    h('div', { className: 'dshp-route-text' },
                        h('p', { className: 'dshp-hint' }, route.hint),
                        note ? h('p', { className: 'dshp-hint dshp-route-note', 'data-projects-route-note': '' }, note, ' ',
                            h('button', { type: 'button', className: 'dshp-ps-link', disabled, onClick: () => actions.edit(route.effort, fix.value) }, fix.label)) : null),
                    h(ModelPicker, {
                        id: `dshp-${route.id}`, label: route.title, catalog: catalog.value, disabled,
                        value: { model: text(route.model) || undefined, effort: text(route.effort) || undefined },
                        own: { model: text(route.model) !== '', effort: text(route.effort) !== '' },
                        // Unset plugin defaults leave the choice to DSH's own default model.
                        fallback: {},
                        onPick: (pick) => {
                            if (pick.model !== undefined) actions.edit(route.model, pick.model ?? '');
                            if (pick.effort !== undefined) actions.edit(route.effort, pick.effort ?? '');
                        },
                    })));
        }

        /** The user's tools and DSH's permissions, as the plugin lists them: read when shown, then every 15 s. null until read. */
        function useListedAccess(link) {
            const [value, setValue] = React.useState(null);
            React.useEffect(() => {
                let alive = true;
                const read = async () => {
                    const result = await link.call('list', {});
                    if (!alive || !result.ok || !isObject(result.value)) return;
                    const guarded = Array.isArray(result.value.guarded) ? result.value.guarded.filter((name) => typeof name === 'string' && name !== '') : [];
                    const permissions = isObject(result.value.permissions) ? result.value.permissions : null;
                    const problems = Array.isArray(result.value.problems) ? result.value.problems.filter((text) => typeof text === 'string' && text !== '') : [];
                    const store = Array.isArray(result.value.store) ? result.value.store.filter((text) => typeof text === 'string' && text !== '') : [];
                    const off = result.value.off === true;
                    setValue((was) => (was && was.guarded.join('\n') === guarded.join('\n') && JSON.stringify(was.permissions) === JSON.stringify(permissions)
                        && was.problems.join('\n') === problems.join('\n') && was.store.join('\n') === store.join('\n') && was.off === off ? was : { guarded, permissions, problems, store, off }));
                };
                void read();
                const timer = setInterval(() => {
                    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void read();
                }, 15000);
                return () => { alive = false; clearInterval(timer); };
            }, [link]);
            return value;
        }

        const PROBLEMS = {
            one: 'A setting to fix',
            many: (n) => `${n} settings to fix`,
            where: 'In your profile\'s cordis.patch.yml, in the row "- id: coordinator". The plugin keeps running meanwhile, as each line says.',
            store: 'Its record of coordinating chats',
            off: 'Switched off',
            offWhy: 'Its row in your profile\'s cordis.patch.yml ("- id: coordinator") says enabled: false, so no chat coordinates and no chat is offered the thread tools. Set it to true, or take the line out, to coordinate again.',
        };
        const ACCESS_NOTE = 'These apply to every coordinating chat that doesn\'t set its own in its Thread settings. Your tools are the ones listed under guardedTools in this plugin\'s config.';

        /**
         * The plugin-wide access defaults, in the same form as the default
         * models (one Save): Your tools, and the permission new threads start
         * on. An empty field is the plugin's own default; picking that value
         * stages a clear.
         * @param props.listed - useListedAccess' answer.
         */
        function accessDefaults({ state, actions, disabled, listed }) {
            const text = (name) => String(state[name]?.text ?? '').trim();
            const guarded = listed?.guarded ?? EMPTY;
            const perms = isObject(listed?.permissions) && Array.isArray(listed.permissions.options) && listed.permissions.options.length > 0 ? listed.permissions : null;
            const pick = (name, next) => actions.edit(name, next === ACCESS_BUILTIN[name] ? '' : next);
            const tools = text('yourTools').toLowerCase() === 'always' ? 'always' : 'asked';
            const row = (id, title, hint, control, extra) => h('section', { key: id, className: 'dshp-section', 'data-projects-access-default': id },
                h('h4', { className: 'dshp-title' }, title),
                h('div', { className: 'dshp-route' },
                    h('div', { className: 'dshp-route-text' }, h('p', { className: 'dshp-hint' }, hint), extra ?? null),
                    control));
            const permission = (name, title, hint, risk) => row(name, title, hint, h(PermissionPicker, {
                id: `dshp-${name}`, label: title, catalog: perms, value: text(name) || ACCESS_BUILTIN[name], dshDefault: true, risk, disabled,
                onPick: (next) => pick(name, next),
            }));
            return [
                h('h3', { key: 'h', className: 'dshp-heading dshp-heading-next', 'data-projects-access-defaults': '' }, 'Default access'),
                row('yourTools', SETTINGS.yourTools,
                    guarded.length === 0 ? SETTINGS.noTools : tools === 'always' ? SETTINGS.toolsAlwaysAll : SETTINGS.toolsAsked,
                    h(ToolsControl, { id: 'dshp-your-tools', value: tools, names: guarded, risk: RISK.allTools, disabled, onPick: (next) => pick('yourTools', next) }),
                    guarded.length > 0 ? h(ToolNames, { names: guarded }) : null),
                perms ? permission('threadPermission', SETTINGS.threadPermission, 'What each new thread starts on. A running thread keeps its own.', RISK.allThreads) : null,
                h('p', { key: 'n', className: 'dshp-note' }, ACCESS_NOTE),
            ];
        }

        /**
         * The plugin's settings that are wrong, each in the words the plugin
         * logs: what it must be, what it is, and what the plugin uses
         * meanwhile. Nothing while all are right.
         */
        /**
         * The settings to fix, in words, at the top of the plugin's page; or,
         * while the plugin is switched off in its settings, that it is and
         * how to switch it on, with any setting to fix below.
         */
        function SettingProblems({ problems, off = false }) {
            const list = Array.isArray(problems) ? problems : [];
            if (!off && list.length === 0) return null;
            return h('section', { className: 'dshp-problems', 'data-projects-problems': '', 'data-projects-off': off ? '' : undefined, 'aria-labelledby': 'dshp-problems-title' },
                h('h4', { id: 'dshp-problems-title', className: 'dshp-title dshp-problems-title' }, off ? PROBLEMS.off : list.length === 1 ? PROBLEMS.one : PROBLEMS.many(list.length)),
                h('p', { className: 'dshp-hint' }, off ? PROBLEMS.offWhy : PROBLEMS.where),
                list.length > 0 ? h('ul', { className: 'dshp-problems-list' }, ...list.map((text, i) => h('li', { key: i }, text))) : null);
        }

        /** What went wrong with the plugin's own record (remote.js list `store`), each in words with what to do; nothing while it is fine. */
        function StoreProblems({ notes }) {
            const list = Array.isArray(notes) ? notes : EMPTY;
            if (list.length === 0) return null;
            return h('section', { className: 'dshp-problems', 'data-projects-store-problems': '', 'aria-labelledby': 'dshp-store-title' },
                h('h4', { id: 'dshp-store-title', className: 'dshp-title dshp-problems-title' }, PROBLEMS.store),
                h('ul', { className: 'dshp-problems-list' }, ...list.map((text, i) => h('li', { key: i }, text))));
        }

        function DefaultsForm({ form, catalog, link }) {
            const snapshot = React.useSyncExternalStore(form.subscribe, form.getSnapshot);
            const cat = React.useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
            const listed = useListedAccess(link);
            React.useEffect(() => { catalog.load(); }, [catalog]);
            const models = modelsOf(cat.value);
            // A save would be refused, so the form shows the values read-only with the fix.
            const state = snapshot.insertedTwice ? { ...snapshot, writable: false } : snapshot;
            const labels = snapshot.insertedTwice ? { ...LABELS, readOnly: INSERTED_TWICE } : LABELS;
            const disabled = !state.writable || state.saving;
            return h('div', { 'data-projects-defaults': true },
                h(SettingProblems, { problems: listed?.problems, off: listed?.off === true }),
                h(StoreProblems, { notes: listed?.store }),
                h('h3', { className: 'dshp-heading' }, 'Default models'),
                h(ui.SettingsForm, { labels, state, onSave: form.actions.save, onDiscard: form.actions.discard },
                    ...ROUTES.map((route) => h(RouteSection, { key: route.id, route, state, actions: form.actions, catalog: cat, models, disabled })),
                    h('p', { key: 'note', className: 'dshp-note' }, NOTE),
                    ...accessDefaults({ state, actions: form.actions, disabled, listed })));
        }

        /** Where a thread setting comes from: a line for one source, a phrase each for two. */
        const SOURCE_LINE = { 'chat setting': 'Set for this chat', 'plugin default': 'From Default models', 'DSH default': 'Follows DSH\'s default model' };
        const SOURCE_PHRASE = { 'chat setting': 'set for this chat', 'plugin default': 'from Default models', 'DSH default': 'follows DSH' };

        /**
         * The source of a model and effort pair, naming the effort's own
         * source when it differs. `long` adds what DSH's default model is.
         */
        function sourceLine(m, e, { long = false } = {}) {
            if (!isObject(e) || e.value == null || e.source === m?.source) {
                const line = SOURCE_LINE[m?.source] ?? '';
                return long && m?.source === 'DSH default' ? `${line}, the one last picked in any DSH chat` : line;
            }
            return `Model ${SOURCE_PHRASE[m?.source] ?? ''} · effort ${SOURCE_PHRASE[e.source] ?? ''}`;
        }

        const OPTIONS = {
            heading: 'Threads',
            beside: 'Open threads beside their coordinator',
            besideHint: 'A thread you open from the sidebar or a card shows in the right panel, beside the chat that started it, when the window has room for both. Off, a thread opens on its own, and "Open beside its coordinator" in its menus still pairs them.',
        };

        /** The plugin page's switches, which this window keeps (no Save). */
        function ThreadOptions() {
            const beside = useBesidePref();
            return h('section', { className: 'dshp-options', 'data-projects-options': '' },
                h('h3', { className: 'dshp-heading' }, OPTIONS.heading),
                h('div', { className: 'dshp-option' },
                    h('div', { className: 'dshp-option-text' },
                        h('div', { className: 'dshp-option-title', id: 'dshp-option-beside' }, OPTIONS.beside),
                        h('div', { className: 'dshp-option-hint' }, OPTIONS.besideHint)),
                    h('span', { 'data-projects-beside-setting': beside ? 'on' : 'off' },
                        h(ui.Switch, { checked: beside, label: OPTIONS.beside, onChange: (on) => besidePref.set(on) }))));
        }

        function applyDefaultsForm(ctx, { catalog, link }) {
            const scope = ctx.configForms.get(ENTRY);
            const model = new ui.SettingsFormModel(scope, FORM_FIELDS.map((name) => ui.settingsTextField(name)));
            const store = model.bind(() => ({
                ...model.shell(),
                insertedTwice: insertedTwice(scope.getSnapshot()),
                ...Object.fromEntries(FORM_FIELDS.map((name) => [name, model.field(name)])),
            }));
            const form = {
                subscribe: (listener) => store.subscribe(listener),
                getSnapshot: () => store.getSnapshot(),
                actions: model.actions(),
            };
            ctx.effect(() => () => model.dispose(), 'coordinator: defaults form');
            const Page = (props) => (props.view === 'summary'
                ? 'Default models, effort and access for threads.'
                : h('div', { className: 'dshp-page' },
                    h(DefaultsForm, { form, catalog, link }),
                    h(ThreadOptions)));
            ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
                name: 'plugins.bundle.config',
                key: BUNDLE,
            }, Page))), 'coordinator: defaults page');
        }

        // ── Threads in the chat window ─────────────────────────────────────

        /** The projection the host half folds for every session (projection.js). */
        const KEY = 'coordinatorSession';
        /** A thread's chat in the right sidebar: `dsh-resource://projectthread/session/<session id>`. */
        const CHAT_PROTOCOL = 'projectthread';
        const CHAT_PREFIX = `dsh-resource://${CHAT_PROTOCOL}/session/`;
        /** A thread's Changes tab, its own file edits as diffs: `dsh-resource://projectchanges/session/<thread session id>`. */
        const CHANGES_PROTOCOL = 'projectchanges';
        const CHANGES_PREFIX = `dsh-resource://${CHANGES_PROTOCOL}/session/`;
        const KINDS = { chat: 'projectthread', pane: 'projectthreads', link: 'projectthreadlink', changes: CHANGES_PROTOCOL };
        /** DSH's Review tab for one turn's changes (dsh-client-ui-deliverables): `<session>/<seq>/<turn>`. */
        const REVIEW_PREFIX = 'dsh-resource://changes-review/session/';
        const IDS = {
            menu: `${BUNDLE}:threads-menu`,
            cards: `${BUNDLE}:thread-cards`,
            mark: `${BUNDLE}:thread-mark`,
            hover: `${BUNDLE}:thread-hover`,
            chat: `${BUNDLE}:thread-chat`,
            pane: `${BUNDLE}:threads-pane`,
            link: `${BUNDLE}:thread-link`,
            changes: `${BUNDLE}:thread-changes`,
            settings: `${BUNDLE}:project-settings`,
            settingsItem: `${BUNDLE}:project-settings-item`,
            rename: `${BUNDLE}:rename`,
            fullItem: `${BUNDLE}:full-view-item`,
            paused: `${BUNDLE}:paused-bar`,
            ending: `${BUNDLE}:ending-bar`,
            place: `${BUNDLE}:row-place`,
            sessionList: `${BUNDLE}:session-list`,
            news: `${BUNDLE}:news-notice`,
            coordinate: `${BUNDLE}:coordinate`,
            start: `${BUNDLE}:start-coordinating`,
        };
        /** The conversation inside a thread's sidebar chat; its tab body declares it. */
        const CONVERSATION_SLOT = 'projects.thread.conversation';
        /**
         * A coordinator reply names a thread as `[title](.dsh-thread/t3)`
         * (prompts.js threadLink); DSH turns that relative link into a file
         * address of the session, which the link tab type claims.
         */
        const LINK = /^dsh-resource:\/\/file\/session\/([^/?#]+)\/\.dsh-thread\/(t\d+)\/?(?:[?#].*)?$/i;
        /** The short `[title](.t3)` a reply may write instead: `.t` and digits exactly, so `.tmp` or `.tool-versions` stay files. */
        const SHORT_LINK = /^dsh-resource:\/\/file\/session\/([^/?#]+)\/\.(t\d+)\/?(?:[?#].*)?$/;
        const EMPTY = Object.freeze([]);
        const NO_PROJECT = Object.freeze({});
        const TEXT = {
            // The plugin's messages between sessions, as their notices name them.
            noticeHandback: 'Handback from',
            noticeHandbackWhy: 'What the thread reported. This chat answers it below.',
            noticeIdle: 'ended without a handback',
            noticeIdleWhy: 'The thread ended a turn without reporting back, so the plugin told this chat.',
            noticeApproval: 'is waiting for approval',
            noticeApprovalWhy: 'The thread waits on a permission prompt in its own chat, so the plugin told this chat.',
            noticeQuestion: 'asked a question',
            noticeQuestionWhy: 'The thread asked this chat while it works. This chat answers it, or asks you when only you can decide.',
            noticeBrief: 'Brief from',
            noticeBriefWhy: 'The chat that started this thread sent this brief.',
            noticeCoordinator: 'Message from the coordinating chat',
            noticeCoordinatorWhy: 'The chat that started this thread sent it a message.',
            noticeMessage: 'Message from',
            noticeMessageWhy: 'A coordinating chat sent it at your request. This chat doesn\'t join its threads; its answer goes back to that chat once.',
            noticeReply: 'Reply from',
            noticeReplyWhy: 'The answer to the message this chat sent at your request.',
            noticeOther: 'Message received',
            needsYou: 'Needs you',
            running: 'Running',
            // What a coordinating chat's row and the window's notice say about news from its threads.
            news: {
                handback: (title, status) => (status === 'blocked' ? `“${title}” is blocked` : status === 'needs_decision' ? `“${title}” needs a decision` : `“${title}” handed back`),
                finished: (title) => `“${title}” finished its turn`,
                approval: (title) => `“${title}” is waiting for your approval`,
                failed: (title) => `“${title}” failed`,
                stopped: (title) => `“${title}” stopped`,
            },
            newsMore: (n) => (n === 1 ? ', and one more' : `, and ${n} more`),
            newsOpen: 'Open',
            newsMark: (n, line) => (n === 1 ? `New: ${line}` : `${n} new, latest: ${line}`),
            // In a chat's header: start coordinating there, or stop.
            coordinate: 'Coordinate',
            coordinateTip: 'Run work from this chat in threads that report back here',
            stopCoordinating: 'Stop coordinating',
            // On DSH's new-chat screen, while the chat coordinates.
            coordinating: 'Coordinating',
            coordinatingLabel: 'Coordinating, press to stop',
            coordinatingTip: 'This chat runs work in threads that report back here. Click to stop (/coordinate off)',
            threads: 'Threads',
            thread: 'Thread',
            coordinator: 'Coordinator',
            openCoordinator: 'Open the chat that started this thread',
            open: 'Open',
            openTip: 'Open it beside this chat',
            fullView: 'Full view',
            openFull: 'Open in full view',
            openBeside: 'Open beside its coordinator',
            openPane: 'Open the Threads panel',
            current: 'This chat',
            loading: 'Loading threads…',
            failed: 'Could not load this chat\'s threads.',
            noCoordinator: 'The chat that started this thread isn\'t known yet.',
            retry: 'Retry',
            empty: 'No threads yet. When work needs its own session, this chat starts a thread and it shows up here.',
            notProject: 'This chat has no threads. Open a chat that coordinates threads, or one of its threads, to see them here.',
            chatGone: 'This thread\'s chat can\'t be opened. It may have been deleted.',
            linkLoading: 'Opening the thread…',
            linkNotProject: 'This chat doesn\'t coordinate threads, so it has none to open.',
            paused: 'Paused',
            projectPaused: 'Threads paused',
            // What a coordinating chat's and its threads' rows in the session list say after their titles, to a screen reader.
            rowProject: 'Coordinating',
            rowStopped: 'Stopped coordinating',
            rowThread: 'Thread',
            pausedCoordinator: 'New threads and handbacks wait until you resume.',
            pausedNewThreads: 'New threads wait too.',
            pausedThread: 'This thread\'s handbacks wait until you resume.',
            // What a held handback waits for: Resume (paused), /coordinate in its chat (stopped coordinating), or both.
            heldLine: { paused: 'held until you resume', off: 'held until you coordinate again', both: 'held until you coordinate again and resume' },
            handbackHeld: 'Handback held',
            handbackHeldWhy: {
                paused: 'Threads are paused, so the chat that started this thread gets this handback when you resume.',
                off: 'The chat that started this thread stopped coordinating, so it gets this handback when you run /coordinate there again.',
                both: 'The chat that started this thread stopped coordinating and its threads are paused, so it gets this handback when you run /coordinate there again and resume.',
            },
            resume: 'Resume',
            resuming: 'Resuming…',
            resumeFailed: 'Couldn\'t resume the threads.',
            reviewChanges: 'Review changes',
            reviewLatest: 'Review the latest changes',
            diffGone: 'DSH has no diff of this to show. It keeps diffs only until it restarts.',
            // A thread's Changes tab.
            changes: 'Changes',
            openChanges: 'See what this thread changed',
            changesLoading: 'Reading changes…',
            changesFailed: 'Couldn\'t read this thread\'s changes.',
            changesNone: 'This thread hasn\'t changed any files yet.',
            changesRead: 'Read again',
            changesNew: 'new',
            changesOpenFile: 'Open the whole file in the sidebar',
            changesClipped: 'Part of this is too large to show here. Its lines are still counted.',
            changesEach: (n) => `Each edit (${n})`,
            changesUndone: (n) => (n > 1 ? 'Its edits undid each other: the file is as it was before.' : 'Its edit left the file as it was.'),
            changesEmpty: 'A new, empty file.',
            changesEndings: 'Only line endings or the last newline changed.',
            changesUnlisted: 'This also has edits by subagents that aren\'t listed here.',
            changesSince: 'The file has changed since these edits. This is how they left it.',
            /** Why a file shows its edits one by one instead of one diff of what they came to. */
            changesNetWhy: {
                mixed: 'Shown edit by edit: the file also changed some other way between or during these edits.',
                big: 'Shown edit by edit: too much of this file changed for one diff.',
                large: 'Shown edit by edit: this file is too large to keep a copy of.',
                full: 'Shown edit by edit: this thread\'s room for kept copies is used up.',
                many: 'Shown edit by edit: this thread changed too many files to keep a copy of each.',
                binary: 'Shown edit by edit: this isn\'t a text file.',
                encoding: 'Shown edit by edit: this file isn\'t UTF-8 text.',
                outside: 'Shown edit by edit: no copies are kept of files outside the thread\'s folders.',
                secret: 'Shown edit by edit: no copies are kept of files that may hold secrets.',
            },
            changesAlso: 'Also changed by',
            changesReview: 'DSH\'s review of the whole folder',
            changesShell: 'Edits made by commands the thread ran in its shell aren\'t shown yet.',
            changesFolded: (n) => `${plural(n, 'file')} folded. Open one to see its diff.`,
            retryThread: 'Retry',
            resumeThread: 'Resume',
            // A thread row's ⋯, in the Threads menu and panel.
            renameThread: 'Rename…',
            threadActions: (name) => `Thread actions: ${name}`,
            findThread: 'Find a thread',
            findClear: 'Clear the find',
            findNone: (words) => `Nothing matches “${words}”.`,
            steps: 'Steps done',
            threadSettings: 'Model and permission…',
            stopThread: 'Stop',
            resolveThread: 'Mark resolved',
            reopenThread: 'Reopen',
            threadChangeFailed: 'Couldn\'t change the thread.',
            retrying: 'Retrying…',
            resumingThread: 'Resuming…',
            continueFailed: 'Couldn\'t reach the thread.',
            endedFailed: 'Failed',
            endedStopped: 'Stopped',
            stoppedEarly: 'It stopped before it finished.',
            youStopped: 'You stopped it.',
            youStoppedEarly: 'You stopped it before it finished.',
        };
        const GROUPS = [
            { id: 'waiting', label: 'Waiting on you' },
            { id: 'running', label: 'Running' },
            { id: 'done', label: 'Done' },
            { id: 'idle', label: 'Idle' },
            { id: 'resolved', label: 'Resolved' },
        ];
        const HANDBACK_LABELS = { done: 'Done', blocked: 'Blocked', needs_decision: 'Needs your decision', progress: 'Progress update' };

        const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
        const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
        const threadNumber = (id) => Number(String(id).slice(1)) || 0;
        /** Names as a sentence lists them: "A", "A and B", "A, B and C". */
        const listText = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
        /** For a DSH without workspaces or session statuses on its slot props: none. */
        const NO_WORKSPACES = Object.freeze({ items: EMPTY, archivedSessionIds: EMPTY, phase: 'none' });
        const noWorkspaces = (select) => select(NO_WORKSPACES);
        const noStatuses = (select) => select(new Map());

        /** A title with the found words marked, as parts to draw. */
        function withHit(title, find) {
            const words = String(find ?? '').trim();
            const at = words === '' ? -1 : String(title).toLowerCase().indexOf(words.toLowerCase());
            if (at < 0) return [title];
            return [title.slice(0, at), h('mark', { key: 'hit', className: 'dshp-t-hit' }, title.slice(at, at + words.length)), title.slice(at + words.length)].filter((part) => part !== '');
        }

        /** A session's `coordinatorSession` value from DSH's shared session store, or undefined. */
        function valueIn(state, sessionId) {
            if (typeof sessionId !== 'string' || sessionId === '' || !state) return undefined;
            const value = state.projectionsBySession?.[sessionId]?.values?.[KEY] ?? state.byId?.[sessionId]?.projectionValues?.[KEY];
            return isObject(value) && (value.role === 'coordinator' || value.role === 'thread') ? value : undefined;
        }

        /**
         * The coordinator and thread sessions the plugin's store knows, by id:
         * {role, coordinator?} (remote.js `sessions`). DSH lists a
         * session without the plugin's value while the value it saved is from
         * another version of the plugin, until the session is next loaded; the
         * session list's rows go by this then, not by their titles.
         */
        const known = { map: new Map(), off: false, version: 0, listeners: new Set() };
        const subscribeKnown = (listener) => {
            known.listeners.add(listener);
            return () => { known.listeners.delete(listener); };
        };
        const knownVersion = () => known.version;
        /** Re-render with the sessions the store knows, once they are read. */
        const useKnown = () => React.useSyncExternalStore(subscribeKnown, knownVersion);
        /** @param off - the plugin is switched off in its settings (`enabled: false`): no Coordinate anywhere. */
        function takeKnown(sessions, off = false) {
            const map = new Map();
            for (const [id, s] of Object.entries(isObject(sessions) ? sessions : {})) {
                if (!isObject(s) || (s.role !== 'coordinator' && s.role !== 'thread')) continue;
                map.set(id, { role: s.role, ...(typeof s.coordinator === 'string' && s.coordinator !== '' ? { coordinator: s.coordinator } : {}) });
            }
            known.map = map;
            known.off = off === true;
            known.version += 1;
            for (const listener of [...known.listeners]) listener();
        }

        const chatAddress = (sessionId) => `${CHAT_PREFIX}${encodeURIComponent(sessionId)}`;
        const changesAddress = (sessionId) => `${CHANGES_PREFIX}${encodeURIComponent(sessionId)}`;

        /** The sessions DSH's main view holds (its "mainView" references): the main chat, or two for a moment while DSH switches. */
        function mainViews(state) {
            const ids = [];
            if (!isObject(state?.byId)) return ids;
            for (const [id, row] of Object.entries(state.byId)) if ((row?.retainedBy?.mainView ?? 0) > 0) ids.push(id);
            return ids;
        }

        /**
         * DSH's own layout limits: its smallest main chat beside a right
         * sidebar and its smallest right sidebar; below the narrowest window
         * the right sidebar covers the whole window instead.
         */
        const MAIN_MIN = 400;
        const PANE_MIN = 300;
        const COVER_BELOW = 768;
        /**
         * Whether the window has room for a chat beside the main one: DSH's
         * smallest main chat and right sidebar next to the left sidebar as it
         * is now, the same rule DSH uses to show its right sidebar at all.
         * That is 980 px wide with the left sidebar at its 280 px default,
         * 1118 px at 418 px, and 768 px once DSH folds the sidebar away.
         */
        function roomBeside() {
            if (typeof window === 'undefined' || typeof document === 'undefined') return true;
            let left = 0;
            try { left = document.querySelector('[data-slot="sidebar"]')?.parentElement?.getBoundingClientRect().width ?? 0; } catch { left = 0; }
            return roomFor(window.innerWidth, left);
        }
        /** The same for a window `width` px wide whose left sidebar takes `left` px. */
        const roomFor = (width, left) => width >= COVER_BELOW && width - left - MAIN_MIN >= PANE_MIN;

        /**
         * Whether a thread opened anywhere lands beside its coordinator (on
         * unless turned off on the plugin's page), kept in the window's
         * storage. Off, a thread opens on its own unless asked to open
         * beside.
         */
        const BESIDE_KEY = `${BUNDLE}/open-beside`;
        const besidePref = (() => {
            const listeners = new Set();
            let value;
            const notify = () => { for (const listener of [...listeners]) listener(); };
            // Another DSH window changed it.
            const onStorage = (event) => {
                if (event.key !== BESIDE_KEY && event.key !== null) return;
                value = undefined;
                notify();
            };
            return {
                get() {
                    if (value === undefined) {
                        try { value = window.localStorage.getItem(BESIDE_KEY) !== 'off'; } catch { value = true; }
                    }
                    return value;
                },
                set(on) {
                    value = on === true;
                    try { window.localStorage.setItem(BESIDE_KEY, value ? 'on' : 'off'); } catch { /* no storage: until the window closes */ }
                    notify();
                },
                subscribe(listener) {
                    if (listeners.size === 0) try { window.addEventListener('storage', onStorage); } catch { /* no window */ }
                    listeners.add(listener);
                    return () => {
                        listeners.delete(listener);
                        if (listeners.size === 0) try { window.removeEventListener('storage', onStorage); } catch { /* no window */ }
                    };
                },
            };
        })();
        const useBesidePref = () => React.useSyncExternalStore(besidePref.subscribe, besidePref.get);

        /** The session a `dsh-resource://<protocol>/session/<id>` address names, or undefined. */
        function addressSession(address, protocol) {
            let url;
            try { url = new URL(address); } catch { return undefined; }
            if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== protocol) return undefined;
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length !== 2 || parts[0] !== 'session') return undefined;
            try { return decodeURIComponent(parts[1]) || undefined; } catch { return undefined; }
        }

        /** The session a thread chat address names, or undefined. */
        function chatSessionOf(address) {
            return addressSession(address, CHAT_PROTOCOL);
        }

        /** The thread a Changes tab address names, or undefined. */
        function changesSessionOf(address) {
            return addressSession(address, CHANGES_PROTOCOL);
        }

        /** The session and thread a `.dsh-thread/t3` (or `.t3`) link names, or undefined. */
        function linkTarget(address) {
            const m = LINK.exec(String(address)) ?? SHORT_LINK.exec(String(address));
            if (!m) return undefined;
            try { return { sessionId: decodeURIComponent(m[1]), threadId: m[2].toLowerCase() }; } catch { return undefined; }
        }

        /** "now", "5m", "3h", "2d", … for a moment in epoch ms. */
        function ago(at, now) {
            if (!Number.isFinite(at)) return '';
            const { unit, n } = ui.relativeTime(at, now);
            switch (unit) {
                case 'now': return 'now';
                case 'minutes': return `${n}m`;
                case 'hours': return `${n}h`;
                case 'days': return `${n}d`;
                case 'months': return `${n}mo`;
                default: return `${n}y`;
            }
        }

        /** A moment as DSH's chat times its messages: "14:58" today, else with the date ("Oct 9, 14:58"). */
        function clockOf(at, now = Date.now()) {
            if (!Number.isFinite(at)) return '';
            const d = new Date(at);
            const n = new Date(now);
            const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            if (d.toDateString() === n.toDateString()) return clock;
            const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }) });
            return `${day}, ${clock}`;
        }

        /** How many times in a row a thread's last turn ended the same way, when more than once: "twice", "3 times". */
        const againText = (times) => (Number.isSafeInteger(times) && times > 1 ? (times === 2 ? 'twice' : `${times} times`) : '');

        /**
         * What a session's next request runs on, from DSH's own
         * `modelSelection` projection (the one its composer picker shows), or
         * undefined before DSH has sent it.
         */
        function selectionIn(state, sessionId) {
            if (typeof sessionId !== 'string' || sessionId === '' || !state) return undefined;
            const value = state.projectionsBySession?.[sessionId]?.values?.modelSelection ?? state.byId?.[sessionId]?.projectionValues?.modelSelection;
            const picked = isObject(value) ? value.next ?? value.lastUsed : undefined;
            return isObject(picked) && typeof picked.provider === 'string' && typeof picked.model === 'string' ? picked : undefined;
        }
        const sameSelection = (a, b) => a === b || (a != null && b != null
            && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort);
        const sameSelections = (a, b) => {
            const keys = Object.keys(a);
            return keys.length === Object.keys(b).length && keys.every((key) => sameSelection(a[key], b[key]));
        };

        /** The selections of some sessions, by session id; the same object until one of them changes. */
        function useSelections(useSessions, sessionIds) {
            const key = sessionIds.join('\n');
            // The ids are read through `key`, so a new array of the same ids keeps the selector.
            const select = React.useCallback((state) => {
                const out = {};
                for (const id of sessionIds) {
                    const picked = selectionIn(state, id);
                    if (picked) out[id] = picked;
                }
                return out;
            }, [key]);
            return useSessions(select, sameSelections);
        }

        /** A selection named as DSH's model menu names it: "DeepSeek V4 · High", or just the model when it has no effort levels. */
        function selectionText(cv, picked) {
            if (!isObject(picked)) return undefined;
            const model = findModel(cv.models, `${picked.provider}:${picked.model}`);
            const name = model ? model.name : picked.model;
            if (model && model.efforts.length === 0) return name;
            const effort = typeof picked.reasoningEffort === 'string' ? picked.reasoningEffort : model?.defaultEffort;
            if (effort === undefined) return model ? `${name} · Default` : name;
            return `${name} · ${model ? effortName(model, effort) : anyEffortName(cv, effort)}`;
        }

        /** Whether a resolved setting's model takes an effort (an unknown model might). */
        const levelsOf = (route) => !route.model || route.efforts.length > 0;

        /** A resolved setting (resolveRoute) as one label. */
        const routeLabel = (route) => (route.effortName ? `${route.name} · ${route.effortName}` : route.name);

        // ── Access: the user's tools, and the permission each session runs on ──

        /** DSH's own labels for its built-in permission presets, as its access menu shows them. */
        const PRESET_LABELS = Object.freeze({ 'read-only': 'Read Only', 'workspace-write': 'Workspace Write', 'danger-full-access': 'Full access' });
        const FULL_ACCESS = 'danger-full-access';

        /**
         * A permission preset under the name DSH's menus give it: the built-in
         * label, else the name DSH sends, title-cased when it is a kebab-case
         * key ("team-review" is "Team Review"), as DSH does.
         * @param catalog - the permissions DSH offers ({options: [{value, name}]}), or undefined.
         */
        function permissionName(value, catalog) {
            if (typeof value !== 'string' || value === '') return undefined;
            if (value === 'custom') return 'Custom';
            const option = Array.isArray(catalog?.options) ? catalog.options.find((o) => isObject(o) && o.value === value) : undefined;
            const name = typeof option?.name === 'string' && option.name !== '' ? option.name : value;
            if (Object.hasOwn(PRESET_LABELS, value) && (name === value || name === PRESET_LABELS[value])) return PRESET_LABELS[value];
            return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? name.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : name;
        }

        /** DSH's icon for one of its built-in presets (a shield for any other), at `size`. */
        function permissionGlyph(value, size = 14) {
            if (typeof value !== 'string' || value === '') return null;
            const Icon = value === 'read-only' ? ui.PermissionIconReadOnlyRegular : value === 'workspace-write' ? ui.PermissionIconWorkspaceWriteRegular
                : value === FULL_ACCESS ? ui.PermissionIconFullAccessRegular : ui.IconShieldOutlineRegular;
            return Icon ? h('span', { className: 'dshp-perm-glyph', 'aria-hidden': true }, h(Icon, { size })) : null;
        }

        /** The shield that marks the user's tools. */
        function toolsGlyph(size = 12) {
            return ui.IconShieldOutlineRegular ? h('span', { className: 'dshp-perm-glyph', 'aria-hidden': true }, h(ui.IconShieldOutlineRegular, { size })) : null;
        }

        /**
         * The preset a permission setting puts a session on ("default" is
         * DSH's default for new sessions), and its name.
         * @returns {{preset?: string, name?: string}}
         */
        function permissionShown(value, catalog) {
            const preset = value === 'default' ? (typeof catalog?.defaultPreset === 'string' ? catalog.defaultPreset : undefined) : value;
            return { preset, name: permissionName(preset, catalog) ?? (value === 'default' ? 'DSH default' : undefined) };
        }

        /** The user's tools a session has, as a phrase: "none", "all of them", or their names. */
        function toolsText(tools) {
            if (tools === 'all') return 'all of them';
            return Array.isArray(tools) && tools.length > 0 ? tools.join(', ') : 'none';
        }

        /** "Your tools: …" as an element, each name kept whole on a line ("lane-catalog" doesn't break at its hyphen). */
        function toolsWords(tools) {
            const names = tools !== 'all' && Array.isArray(tools) ? tools : EMPTY;
            if (names.length === 0) return h('span', null, `Your tools: ${toolsText(tools)}`);
            return h('span', null, 'Your tools: ', ...names.flatMap((name, i) => [i > 0 ? ', ' : null, h('span', { key: name, className: 'dshp-nowrap' }, name)]).filter((part) => part !== null));
        }

        /** The parts of a line, with " · " between them. */
        const joined = (parts) => parts.filter(Boolean).flatMap((part, i) => (i > 0 ? [' · ', part] : [part]));

        /**
         * A session's permission preset now, from DSH's own `permissions`
         * projection (the one its access chip shows), or undefined before DSH
         * has sent it.
         */
        function permissionIn(state, sessionId) {
            if (typeof sessionId !== 'string' || sessionId === '' || !state) return undefined;
            const value = state.projectionsBySession?.[sessionId]?.values?.permissions ?? state.byId?.[sessionId]?.projectionValues?.permissions;
            return isObject(value) && typeof value.currentValue === 'string' && value.currentValue !== '' ? value.currentValue : undefined;
        }
        const sameRecord = (a, b) => {
            const keys = Object.keys(a);
            return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
        };

        /** The permission presets of some sessions, by session id; the same object until one of them changes. */
        function usePermissions(useSessions, sessionIds) {
            const key = sessionIds.join('\n');
            const select = React.useCallback((state) => {
                const out = {};
                for (const id of sessionIds) {
                    const preset = permissionIn(state, id);
                    if (preset) out[id] = preset;
                }
                return out;
            }, [key]);
            return useSessions(select, sameRecord);
        }

        /**
         * What each thread of a described chat can reach, by session id:
         * {permission, tools}. The preset DSH shows now wins over the one the
         * plugin last saw; which of the user's tools it has only the plugin
         * knows. Empty until the chat is described.
         * @param info - describe's answer, or null.
         * @param live - usePermissions' answer.
         */
        function accessOf(info, live) {
            const out = {};
            for (const t of Array.isArray(info?.threads) ? info.threads : []) {
                if (!isObject(t) || typeof t.session !== 'string') continue;
                const permission = live?.[t.session] ?? (typeof t.permission === 'string' ? t.permission : undefined);
                out[t.session] = { permission, tools: t.tools === 'all' ? 'all' : Array.isArray(t.tools) ? t.tools : EMPTY };
            }
            return out;
        }

        /**
         * The access rows at the top of the Threads menu and pane: the
         * permission new threads start on (when DSH offers permissions), and
         * whether threads get the user's tools (when any are listed). Each is
         * undefined until the chat is described.
         * @returns {{permission?: {preset?: string, name: string}, tools?: string}}
         */
        function accessSummary(info) {
            const a = info?.access;
            if (!isObject(a)) return {};
            const thread = permissionShown(a.threadPermission?.value, info.permissions);
            const guarded = Array.isArray(info.guarded) ? info.guarded : EMPTY;
            return {
                permission: isObject(info.permissions) && thread.name ? thread : undefined,
                tools: guarded.length === 0 ? undefined : a.yourTools?.value === 'always' ? 'Always' : 'Only when asked',
            };
        }

        /** DSH's model catalog for naming models; loads it once while `active`. */
        function useCatalogView(catalog, active = true) {
            const snapshot = React.useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
            React.useEffect(() => { if (active) catalog.ensure(); }, [catalog, active, snapshot.status]);
            return React.useMemo(() => catalogView(snapshot.value), [snapshot.value]);
        }

        /**
         * What the plugin says about coordinating chats and their threads
         * (remote.js), shared by every view in the window: `describe` for one
         * chat's thread settings and pause, `list` for every coordinating
         * chat's pause (the session list marks a paused one). Each answer is
         * kept by the chat's id (`project.id`, which is its session id). A
         * view watches what it shows; while any does
         * and the window is visible, it is read again every 15 s, and a
         * change made in this window shows everywhere at once.
         * @param link - the plugin's endpoints (hostLink).
         */
        function projectFacts(link) {
            const described = new Map();
            const projectOf = new Map();
            const pausedAt = new Map();
            const last = new Map();
            const reading = new Map();
            const watching = new Map();
            const listeners = new Set();
            let version = 0;
            let timer;
            /** The last list answer (null until one came), and whether the last read failed. */
            let listed = null;
            let listFailed = false;
            /** What list says besides the coordinating chats: the user's tools (guardedTools) and the permissions DSH offers. */
            let listedAccess = { guarded: EMPTY, permissions: null };
            /** What the user hasn't seen, by coordinator (remote.js `news`), and the notice the window shows for the newest. */
            let newsBy = new Map();
            let newsKnown = false;
            let newsReading = null;
            let newsAgain = false;
            /** The newest news each coordinator had when this window last read it: only what comes after earns a notice. */
            const announced = new Map();
            let notice = null;
            const emit = () => {
                version += 1;
                for (const listener of [...listeners]) listener();
            };
            const once = (key, maxAge, run) => {
                if (reading.has(key)) return reading.get(key);
                if (Date.now() - (last.get(key) ?? 0) < maxAge) return Promise.resolve();
                const promise = run().catch(() => {}).finally(() => {
                    last.set(key, Date.now());
                    reading.delete(key);
                });
                reading.set(key, promise);
                return promise;
            };
            const put = (target, value) => {
                if (!isObject(value) || !isObject(value.project) || typeof value.project.id !== 'string' || !isObject(value.settings)) return;
                const id = value.project.id;
                if (typeof target === 'string') projectOf.set(target, id);
                if (typeof value.project.coordinator === 'string') {
                    projectOf.set(value.project.coordinator, id);
                    pausedAt.set(value.project.coordinator, value.paused?.value === true);
                }
                for (const t of Array.isArray(value.threads) ? value.threads : []) {
                    if (typeof t?.session === 'string') projectOf.set(t.session, id);
                }
                described.set(id, value);
                emit();
            };
            const describe = (target, maxAge = 0) => {
                if (typeof target !== 'string' || target === '') return Promise.resolve();
                return once(`d:${target}`, maxAge, async () => {
                    const result = await link.call('describe', { target });
                    if (result.ok) put(target, result.value);
                });
            };
            /** Take every coordinating chat as the plugin listed them. */
            const take = (value) => {
                const projects = Array.isArray(value?.projects) ? value.projects : EMPTY;
                listFailed = false;
                listed = projects.filter((p) => isObject(p) && typeof p.id === 'string');
                for (const p of projects) {
                    if (!isObject(p) || typeof p.coordinator !== 'string') continue;
                    pausedAt.set(p.coordinator, p.paused === true);
                    if (typeof p.id !== 'string') continue;
                    projectOf.set(p.coordinator, p.id);
                    const d = described.get(p.id);
                    if (d && (d.paused?.value === true) !== (p.paused === true)) described.set(p.id, { ...d, paused: { ...d.paused, value: p.paused === true } });
                }
                emit();
            };
            const list = (maxAge = 0) => once('list', maxAge, async () => {
                const result = await link.call('list', {});
                if (!result.ok || !Array.isArray(result.value?.projects)) {
                    if (!listFailed) { listFailed = true; emit(); }
                    return;
                }
                const guarded = Array.isArray(result.value.guarded) ? result.value.guarded.filter((name) => typeof name === 'string') : EMPTY;
                const permissions = isObject(result.value.permissions) ? result.value.permissions : null;
                if (guarded.join('\n') !== listedAccess.guarded.join('\n') || JSON.stringify(permissions) !== JSON.stringify(listedAccess.permissions)) listedAccess = { guarded, permissions };
                take(result.value);
            });
            /**
             * Take the news as the plugin answered; with `open` (whether a
             * coordinator is the main chat), the newest that came since the
             * last read, for a coordinator the user isn't looking at, becomes
             * the window's notice. The first read only learns where each is.
             */
            const takeNews = (value, open) => {
                if (!Array.isArray(value?.news)) return;
                const first = !newsKnown;
                const next = new Map();
                let fresh = null;
                for (const raw of value.news) {
                    if (!isObject(raw) || typeof raw.coordinator !== 'string') continue;
                    const unread = (Array.isArray(raw.unread) ? raw.unread : EMPTY).filter((item) => isObject(item) && Number.isInteger(item.seq) && typeof item.kind === 'string');
                    const entry = { project: raw.project, name: typeof raw.name === 'string' ? raw.name : '', coordinator: raw.coordinator, seq: Number.isInteger(raw.seq) ? raw.seq : 0, unread };
                    next.set(entry.coordinator, entry);
                    // A coordinator the window hasn't seen before (a chat that just started coordinating) has had all its news since.
                    const before = announced.has(entry.coordinator) ? announced.get(entry.coordinator) : first ? entry.seq : 0;
                    // An answer to seeNews only updates the marks: what it brings is announced by the next read.
                    if (first || typeof open === 'function') announced.set(entry.coordinator, Math.max(before, entry.seq));
                    if (first || typeof open !== 'function' || open(entry.coordinator)) continue;
                    const newer = unread.filter((item) => item.seq > before);
                    const item = newer[newer.length - 1];
                    if (item && (!fresh || String(item.at ?? '') > String(fresh.item.at ?? ''))) {
                        fresh = { key: `${entry.coordinator}:${item.seq}`, coordinator: entry.coordinator, name: entry.name, item, more: newer.length - 1 };
                    }
                }
                newsBy = next;
                newsKnown = true;
                if (fresh) notice = fresh;
                emit();
            };
            /** Read the news; a read asked for while one runs runs again after it, so nothing that came meanwhile is missed. */
            const news = (open) => {
                if (newsReading) {
                    newsAgain = true;
                    return newsReading;
                }
                newsReading = Promise.resolve(link.call('news', {}))
                    .then((result) => { if (result?.ok) takeNews(result.value, open); })
                    .catch(() => {})
                    .finally(() => {
                        newsReading = null;
                        if (newsAgain) {
                            newsAgain = false;
                            void news(open);
                        }
                    });
                return newsReading;
            };
            /** The sessions the plugin's store knows (remote.js `sessions`), once per window; again a minute after a failed read. */
            let knownRead = false;
            const sessions = () => (knownRead ? Promise.resolve() : once('sessions', 60000, async () => {
                const result = await link.call('sessions', {});
                if (!result.ok || !isObject(result.value?.sessions)) return;
                knownRead = true;
                takeKnown(result.value.sessions, result.value.off === true);
            }));
            const read = (key, maxAge) => (key === 'list' ? list(maxAge) : describe(key.slice(2), maxAge));
            const tick = () => {
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
                for (const key of watching.keys()) void read(key, 10000);
            };
            return {
                subscribe(listener) {
                    listeners.add(listener);
                    return () => { listeners.delete(listener); };
                },
                getSnapshot: () => version,
                /** describe's answer for the coordinating chat a session belongs to (itself, or a thread's chat), or null. */
                info(target) {
                    const id = projectOf.get(target) ?? (described.has(target) ? target : undefined);
                    return id === undefined ? null : described.get(id) ?? null;
                },
                /** Every coordinating chat as `list` last answered (null until it has), and whether the last read failed. */
                projects: () => listed,
                listFailed: () => listFailed,
                /** The user's tools and DSH's permissions as `list` last answered: {guarded, permissions}; the same object until they change. */
                listedAccess: () => listedAccess,
                /** Whether a coordinating chat's threads are paused, as last read; undefined until read. */
                paused(coordinator) {
                    const d = this.info(coordinator);
                    return d ? d.paused?.value === true : pausedAt.get(coordinator);
                },
                put,
                describe,
                list,
                sessions,
                news,
                /** A coordinator's news the user hasn't seen: {project, name, coordinator, seq, unread}; undefined when it has none. */
                newsOf(coordinator) {
                    const entry = newsBy.get(coordinator);
                    return entry && entry.unread.length > 0 ? entry : undefined;
                },
                /** The notice the window shows: {key, coordinator, name, item, more}, or null. */
                notice: () => notice,
                /** The notice is gone (it faded, or the user opened it). */
                dropNotice(key) {
                    if (notice === null || (key !== undefined && notice.key !== key)) return;
                    notice = null;
                    emit();
                },
                /** The user has the coordinator open: its news is seen (remote.js `seeNews`), here at once. */
                async seeNews(coordinator) {
                    const entry = newsBy.get(coordinator);
                    if (!entry || entry.unread.length === 0) return;
                    newsBy = new Map(newsBy);
                    newsBy.set(coordinator, { ...entry, unread: EMPTY });
                    if (notice?.coordinator === coordinator) notice = null;
                    emit();
                    const result = await link.call('seeNews', { target: coordinator, seq: entry.seq });
                    if (result?.ok) takeNews(result.value);
                },
                /**
                 * Keep reading `d:<session>` (its chat's description) or `list` while
                 * the returned function has not been called.
                 */
                watch(key) {
                    if (typeof key !== 'string' || key === '' || key === 'd:') return () => {};
                    watching.set(key, (watching.get(key) ?? 0) + 1);
                    void read(key, 5000);
                    timer ??= setInterval(tick, 15000);
                    return () => {
                        const n = (watching.get(key) ?? 1) - 1;
                        if (n > 0) watching.set(key, n);
                        else watching.delete(key);
                        if (watching.size === 0 && timer !== undefined) {
                            clearInterval(timer);
                            timer = undefined;
                        }
                    };
                },
                /**
                 * Start or stop coordinating in a chat (remote.js `coordinate`):
                 * {coordinating, session, text, projects}. Its list of
                 * coordinating chats updates every view.
                 */
                async coordinate(target, on) {
                    const result = await link.call('coordinate', { target, on: on === true });
                    if (result.ok && Array.isArray(result.value?.projects)) take(result.value);
                    return result;
                },
                /** Change a chat's thread settings or one thread (remote.js `update`); its answer updates every view. */
                async change(target, changes) {
                    const result = await link.call('update', { target, changes });
                    if (result.ok) put(target, result.value);
                    return result;
                },
                /** Run a thread again after its last turn failed or stopped (remote.js `continueThread`). */
                async continueThread(target, thread) {
                    const result = await link.call('continueThread', { target, thread });
                    if (result.ok) put(target, result.value);
                    return result;
                },
            };
        }

        /** Re-render when anything the plugin says about coordinating chats changes. */
        const useFacts = (facts) => React.useSyncExternalStore(facts.subscribe, facts.getSnapshot);
        /** Facts that never change, for a view drawn without the plugin's (a test's). */
        const NO_FACTS = Object.freeze({ subscribe: () => () => {}, getSnapshot: () => 0, watch: () => () => {}, paused: () => undefined, newsOf: () => undefined });
        /** Watch a facts key (`d:<session>` or `list`) while `on`. */
        function useWatch(facts, key, on = true) {
            React.useEffect(() => (on && key ? facts.watch(key) : undefined), [facts, key, on]);
        }

        /**
         * A coordinating chat as the plugin describes it (remote.js `describe`): read
         * when `enabled` turns on, and again every 15 s while `active`.
         */
        function useProjectInfo(facts, target, enabled, active) {
            useFacts(facts);
            React.useEffect(() => { if (enabled) void facts.describe(target, 5000); }, [facts, target, enabled]);
            useWatch(facts, typeof target === 'string' ? `d:${target}` : null, enabled && active);
            return enabled ? facts.info(target) : null;
        }

        /**
         * Whether a coordinating chat's threads are paused (undefined until known),
         * kept current by watching `watch` (`d:<coordinator>` or `list`).
         */
        function usePaused(facts, coordinator, watch) {
            useWatch(facts, watch, typeof coordinator === 'string');
            return React.useSyncExternalStore(facts.subscribe, () => (typeof coordinator === 'string' ? facts.paused(coordinator) : undefined));
        }

        /** How many messages a pause holds for a coordinator, as last read. */
        const useHeld = (facts, coordinator) => React.useSyncExternalStore(facts.subscribe, () => facts.info(coordinator)?.paused?.held ?? 0);
        /** The handbacks the plugin holds for a coordinator ([{thread, status}]), as last read. */
        const useHeldHandbacks = (facts, coordinator) => React.useSyncExternalStore(facts.subscribe, () => facts.info(coordinator)?.paused?.handbacks ?? EMPTY);
        /**
         * Whether a coordinating chat has stopped coordinating (/coordinate off): from its own value when the view has
         * it (a coordinator's), else from the plugin's description of it.
         */
        const useStopped = (facts, info) => React.useSyncExternalStore(facts.subscribe,
            () => (info?.me?.role === 'coordinator' ? info.me.off === true : facts.info(info?.coordinator)?.project?.off === true));
        /** Why what threads hand back waits now: 'paused', 'off' (the chat stopped coordinating), 'both', or null. */
        const holdOf = (paused, off) => (paused && off ? 'both' : off ? 'off' : paused ? 'paused' : null);

        /**
         * Each thread's name for its rows and controls, as the user knows it: its title, never the plugin's id
         * ("t1"); a title two threads share says which by number ("Fix tests, thread 3"); none, "Untitled thread".
         * @returns {Map<string, string>} thread id → name.
         */
        const threadNames = (threads) => {
            const titleOf = (t) => (typeof t.title === 'string' && t.title.trim() !== '' ? t.title.trim() : 'Untitled thread');
            const seen = new Map();
            for (const t of threads) seen.set(titleOf(t), (seen.get(titleOf(t)) ?? 0) + 1);
            return new Map(threads.map((t) => {
                const n = /^t(\d+)$/.exec(t.id)?.[1];
                return [t.id, seen.get(titleOf(t)) > 1 && n ? `${titleOf(t)}, thread ${n}` : titleOf(t)];
            }));
        };

        /**
         * A thread whose handback is held (its chat paused its threads or
         * stopped coordinating) says so, and what it waits for, instead of
         * "No handback yet", and sits where that handback puts it (Done, or
         * Waiting on you for a decision).
         * @param why - holdOf's answer; null holds nothing.
         */
        function withHeld(rows, handbacks, why = 'paused') {
            if (why === null || !Array.isArray(handbacks) || handbacks.length === 0) return rows;
            const held = new Map();
            for (const hb of handbacks) if (isObject(hb) && typeof hb.thread === 'string') held.set(hb.thread, hb.status);
            return rows.map((row) => {
                if (!held.has(row.id) || row.running || row.pending || row.group === 'running' || row.group === 'resolved') return row;
                const status = held.get(row.id);
                const state = rowState({ resolved: false, running: false, pending: undefined, hb: { status }, ending: undefined });
                const label = HANDBACK_LABELS[status] ?? 'Handback';
                return { ...row, group: state.group, dot: state.dot, stateLabel: state.label, ending: undefined, line: `${label} · ${TEXT.heldLine[why] ?? TEXT.heldLine.paused}`, held: true };
            });
        }

        /** Resume paused threads; `failed` says the last try didn't go through. */
        function useResume(facts, target) {
            const [state, setState] = React.useState('idle');
            const alive = React.useRef(true);
            React.useEffect(() => () => { alive.current = false; }, []);
            const resume = React.useCallback(async () => {
                setState('busy');
                const result = await facts.change(target, { paused: false });
                if (alive.current) setState(result.ok ? 'idle' : 'failed');
            }, [facts, target]);
            return { busy: state === 'busy', failed: state === 'failed', resume };
        }

        /** What a pause means where it is shown, with how many messages it holds for the coordinator. */
        function pausedText(role, held, handbacks = 0) {
            if (role === 'thread') return TEXT.pausedThread;
            if (!(held > 0)) return TEXT.pausedCoordinator;
            // The count comes first, so a narrow bar cuts the explanation rather than the count.
            return `${held === handbacks ? plural(held, 'handback') : plural(held, 'message')} held until you resume. ${TEXT.pausedNewThreads}`;
        }

        /**
         * Where a session sits among coordinating chats and threads: its own
         * value, its coordinating chat (itself, for one), that chat's name as
         * `project`, and its roster of threads (null while unknown).
         */
        function projectContext(state, sessionId) {
            const me = valueIn(state, sessionId);
            if (!me) return undefined;
            if (me.role === 'coordinator') {
                return { me, coordinator: sessionId, project: me.project ?? NO_PROJECT, roster: Array.isArray(me.threads) ? me.threads : EMPTY, load: 'ready' };
            }
            const coordinator = typeof me.coordinator === 'string' && me.coordinator !== '' ? me.coordinator : undefined;
            const parent = valueIn(state, coordinator);
            const roster = parent && Array.isArray(parent.threads) ? parent.threads : null;
            const load = roster !== null ? 'ready' : coordinator === undefined ? 'none' : state.projectionsBySession?.[coordinator]?.state ?? 'idle';
            return { me, coordinator, project: parent?.project ?? me.project ?? NO_PROJECT, roster, load };
        }
        const sameContext = (a, b) => a === b || (a !== undefined && b !== undefined && a.me === b.me && a.coordinator === b.coordinator
            && a.project === b.project && a.roster === b.roster && a.load === b.load);
        /** A chat that stopped coordinating with no threads left: as plain as any other chat. */
        const stoppedEmpty = (info) => info?.me.role === 'coordinator' && info.me.off === true && (info.roster ?? EMPTY).length === 0;

        /** What a pending interaction asks of the user, in a few words. */
        function pendingLine(pending) {
            const kind = String(pending?.kind ?? '');
            return /question|review/i.test(kind) ? 'Has a question for you' : 'Waiting for your approval';
        }

        /** What a pending request asks, in its asker's words on DSH's prompt: a question, or an approval's reason; '' when it gives none. */
        function pendingAsk(pending) {
            if (!isObject(pending)) return '';
            const one = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');
            if (Array.isArray(pending.questions)) return one(pending.questions.find((q) => isObject(q) && one(q.question) !== '')?.question);
            return one(pending.displayReason?.en) || one(pending.reason);
        }

        /** A handback's state and summary, without saying the state twice ("Blocked · Blocked: …"). */
        function toldText(hb) {
            const label = HANDBACK_LABELS[hb.status] ?? String(hb.status ?? '');
            const summary = typeof hb.summary === 'string' ? hb.summary.trim() : '';
            if (summary === '') return label;
            const rest = summary.slice(label.length);
            if (label !== '' && summary.slice(0, label.length).toLowerCase() === label.toLowerCase() && (rest === '' || /^[\s:.,;—–-]/.test(rest))) return summary;
            return `${label} · ${summary}`;
        }

        /** A thread's last turn when it failed or stopped (its own projection value's `ending`), or undefined. */
        function endingOf(value) {
            const ending = value?.ending;
            return isObject(ending) && (ending.state === 'failed' || ending.state === 'stopped') ? ending : undefined;
        }
        const endingIn = (state, sessionId) => endingOf(valueIn(state, sessionId));
        const sameEndings = (a, b) => {
            const keys = Object.keys(a);
            return keys.length === Object.keys(b).length && keys.every((key) => a[key]?.seq === b[key]?.seq && a[key]?.state === b[key]?.state);
        };

        /** The failed or stopped last turns of some sessions, by session id; the same object until one of them changes. */
        function useEndings(useSessions, sessionIds) {
            const key = sessionIds.join('\n');
            // The ids are read through `key`, so a new array of the same ids keeps the selector.
            const select = React.useCallback((state) => {
                const out = {};
                for (const id of sessionIds) {
                    const ending = endingIn(state, id);
                    if (ending) out[id] = ending;
                }
                return out;
            }, [key]);
            return useSessions(select, sameEndings);
        }

        /**
         * A stop DSH counts as the user's: its stop button, the session bridge, or the coordinator or an
         * archive, which stop a thread only when the user asks.
         */
        const stoppedByYou = (ending) => ending?.state === 'stopped' && ending.kind === 'aborted' && ending.cause === 'user';

        /** Why a thread's last turn didn't finish, as a sentence ('' when it was simply stopped). */
        function endingReason(ending) {
            switch (ending?.kind) {
                case 'error': return typeof ending.message === 'string' && ending.message !== '' ? ending.message : 'DSH couldn\'t finish the turn.';
                case 'blocked': return 'A DSH plugin blocked the turn.';
                case 'signed-out': return 'You signed out of DeepSeek.';
                case 'interrupted': return 'DSH closed while it ran.';
                case 'max-tokens': return 'It reached the output token limit.';
                default:
                    if (ending?.cause === 'hook') return ending.hook ? `A DSH plugin stopped it (${ending.hook}).` : 'A DSH plugin stopped it.';
                    if (ending?.cause === 'disposed') return 'Its session closed while it ran.';
                    if (stoppedByYou(ending)) return TEXT.youStopped;
                    return '';
            }
        }

        /** A failed or stopped last turn as one line: "Failed · <why>", "Stopped by you", "Stopped before it finished", "Stopped · <why>". */
        function endingLine(ending) {
            const why = endingReason(ending);
            if (ending.state === 'failed') return `Failed · ${why}`;
            if (stoppedByYou(ending)) return 'Stopped by you';
            return why ? `Stopped · ${why}` : 'Stopped before it finished';
        }

        /**
         * A thread's state in the one vocabulary every view uses: its group
         * in the Threads menu, its dot, its label. A failed or stopped last
         * turn counts when it came after the last handback.
         */
        function rowState({ resolved, running, pending, hb, ending }) {
            const later = ending !== undefined && !(Date.parse(hb?.at ?? '') > Date.parse(ending.at ?? ''));
            const ended = !resolved && !running && !pending && later ? ending : undefined;
            const failed = ended?.state === 'failed';
            const asks = !ended && (hb?.status === 'needs_decision' || hb?.status === 'blocked');
            const done = !ended && hb?.status === 'done';
            const group = resolved ? 'resolved' : pending || (!running && (asks || failed)) ? 'waiting' : running ? 'running' : done ? 'done' : 'idle';
            const dot = resolved ? 'done' : pending ? 'warning' : running ? 'ongoing' : failed ? 'error' : asks ? 'warning' : done ? 'done' : 'idle';
            const label = resolved ? 'Resolved' : pending ? 'Needs you' : running ? 'Running' : failed ? 'Failed' : ended ? 'Stopped'
                : hb?.status === 'blocked' ? 'Blocked' : asks ? 'Needs a decision' : done ? 'Done' : 'Idle';
            return { group, dot, label, ending: ended };
        }

        /** One roster entry with its live state, as the menu, the pane and the cards show it. */
        function threadRow(entry, statuses, byId, endings, live) {
            const session = typeof entry.session === 'string' && entry.session !== '' ? entry.session : undefined;
            const status = session ? statuses?.get?.(session) : undefined;
            const summary = session ? byId?.[session] : undefined;
            const running = (status?.running ?? summary?.running) === true;
            const pending = status?.pendingInteraction ?? undefined;
            const hb = isObject(entry.handback) ? entry.handback : undefined;
            const state = rowState({ resolved: entry.resolved === true, running, pending, hb, ending: session ? endings?.[session] : undefined });
            const told = hb ? toldText(hb) : undefined;
            // A running thread with a to-do list says how far along it is and its step.
            const progress = running && session ? progressOf(live?.[session]?.todos) : undefined;
            const line = pending ? [pendingLine(pending), pendingAsk(pending)].filter(Boolean).join(' · ')
                : progress ? (progress.current ? `${progress.done}/${progress.total} · ${progress.current}` : `${progress.done} of ${progress.total} steps done`)
                : running ? (hb?.status === 'progress' && hb.summary ? `Working… · ${hb.summary}` : 'Working…')
                    : state.ending ? endingLine(state.ending)
                        : told ?? (entry.resolved ? 'Resolved' : 'No handback yet');
            const at = Number.isFinite(summary?.updatedAt) ? summary.updatedAt : Date.parse(hb?.at ?? entry.created ?? '');
            return {
                entry, id: entry.id, title: entry.title || entry.id, session, group: state.group, dot: state.dot, line, stateLabel: state.label,
                running, pending: pending !== undefined, pendingInteraction: pending, ending: state.ending, at: Number.isFinite(at) ? at : undefined,
            };
        }

        /** The sessions of a roster's open threads, whose own projections say how their last turn ended. */
        function openSessions(roster) {
            const out = [];
            for (const entry of Array.isArray(roster) ? roster : EMPTY) {
                if (isObject(entry) && entry.resolved !== true && typeof entry.session === 'string' && entry.session !== '') out.push(entry.session);
            }
            return out;
        }

        function rowsOf(roster, statuses, byId, endings, live) {
            const rows = (roster ?? EMPTY).filter((entry) => isObject(entry) && typeof entry.id === 'string').map((entry) => threadRow(entry, statuses, byId, endings, live));
            // Newest activity first within a group; then the newest thread.
            return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || threadNumber(b.id) - threadNumber(a.id));
        }

        /** The sessions of some rows (threads without a session yet are left out). */
        const rowSessions = (rows) => rows.map((row) => row.session).filter((id) => id !== undefined);

        function countsOf(rows) {
            const count = (group) => rows.filter((row) => row.group === group).length;
            return {
                open: rows.length - count('resolved'), running: count('running'), waiting: count('waiting'), resolved: count('resolved'),
                failed: rows.filter((row) => row.dot === 'error').length,
            };
        }

        function summaryText(counts) {
            const parts = [`${counts.open} open`];
            if (counts.waiting) parts.push(`${counts.waiting} waiting on you`);
            if (counts.running) parts.push(`${counts.running} running`);
            if (counts.resolved) parts.push(`${counts.resolved} resolved`);
            return parts.join(' · ');
        }

        /** A clock for relative times that ticks while something shows them. */
        function useNow(active, every = 30000) {
            const [now, setNow] = React.useState(() => Date.now());
            React.useEffect(() => {
                if (!active) return undefined;
                setNow(Date.now());
                const timer = setInterval(() => setNow(Date.now()), every);
                return () => clearInterval(timer);
            }, [active, every]);
            return now;
        }

        /** Focusable items of a list, for arrow keys. */
        function focusables(root) {
            return root ? Array.from(root.querySelectorAll('[data-dshp-item]:not([aria-disabled="true"])')) : [];
        }
        function arrowKeys(event, root) {
            // A row's ⋯ with its list open: DSH's menu walks the list.
            if (typeof event.target?.closest === 'function' && event.target.closest('[data-projects-row-menu][aria-expanded="true"]')) return;
            const items = focusables(root);
            if (items.length === 0) return;
            const active = document.activeElement;
            // From a row's other button (Retry, its ⋯), the walk goes on from that row.
            const row = items.includes(active) || typeof active?.closest !== 'function' ? null : active.closest('.dshp-t-row');
            const index = row ? items.findIndex((item) => row.contains(item)) : items.indexOf(active);
            const at = (i) => { event.preventDefault(); items[(i + items.length) % items.length].focus(); };
            if (event.key === 'ArrowDown') at(index + 1);
            else if (event.key === 'ArrowUp') at(index < 0 ? items.length - 1 : index - 1);
            else if (event.key === 'Home') at(0);
            else if (event.key === 'End') at(items.length - 1);
        }

        /** A refusal from the plugin as a sentence, or that the thread couldn't be reached. */
        function continueError(error) {
            const message = String(error?.message ?? '').trim();
            if (error?.code === 'coordinator/refused' && message) return `${message.replace(/^./, (c) => c.toUpperCase())}${/[.!?]$/.test(message) ? '' : '.'}`;
            return TEXT.continueFailed;
        }

        /**
         * Retry a thread whose last turn failed, or resume one that stopped:
         * the plugin sends it on with a message from its coordinator. Busy
         * until the thread runs again (its row then stops offering it), with
         * the plugin's refusal when it says no.
         */
        function useContinue(projects, row) {
            const [state, setState] = React.useState({ busy: false, error: '' });
            const alive = React.useRef(true);
            React.useEffect(() => () => { alive.current = false; }, []);
            React.useEffect(() => {
                if (!state.busy) return undefined;
                // A thread that doesn't start (DSH refused the message) is offered again.
                const timer = setTimeout(() => { if (alive.current) setState({ busy: false, error: '' }); }, 15000);
                return () => clearTimeout(timer);
            }, [state.busy]);
            const session = row?.session;
            const thread = row?.id;
            const run = React.useCallback(async () => {
                if (typeof session !== 'string' || typeof thread !== 'string') return;
                setState({ busy: true, error: '' });
                const result = await projects.facts.continueThread(session, thread);
                if (alive.current && !result.ok) setState({ busy: false, error: continueError(result.error) });
            }, [projects, session, thread]);
            return { ...state, run, retry: row?.ending?.state === 'failed' };
        }

        /** Retry or Resume as an icon button on a Threads menu or pane row. */
        function RowContinue({ row, projects }) {
            const { busy, error, run, retry } = useContinue(projects, row);
            const label = retry ? TEXT.retryThread : TEXT.resumeThread;
            return h(ui.Tooltip, { label: error || label, side: 'bottom', align: 'end', portal: true },
                h('button', {
                    type: 'button', className: error ? 'dshp-t-icon dshp-t-error' : 'dshp-t-icon', disabled: busy, 'aria-busy': busy || undefined,
                    'aria-label': `${label}: ${row.title}${error ? `. ${error}` : ''}`, 'data-projects-continue': retry ? 'retry' : 'resume',
                    onClick: (event) => { event.preventDefault(); event.stopPropagation(); void run(); },
                    onKeyDown: (event) => event.stopPropagation(),
                }, busy ? h(ui.StateDot, { state: 'ongoing' }) : h(retry ? ui.IconRefreshOutlineRegular : ui.IconPlayOutlineRegular, { size: 14 })));
        }

        /**
         * What a thread's ⋯ offers: the other way to open it (`open`, the
         * list's action), its changes (`opener`, changesOpener's), Rename…,
         * Model and permission… (Thread settings at its row), Stop while it
         * runs, and Mark resolved or Reopen. Rename, Stop and the rest need
         * the plugin (`live`), which makes the change as the user's own.
         * @param thread - {running, resolved}.
         * @param rename - the Rename dialog (renameFlow), when this window has it.
         * @param settings - the Thread settings dialog, when this window has it.
         * @returns [{id, label, icon}] in the order shown.
         */
        function threadMenuItems({ thread, open, opener, changes, live, rename, settings }) {
            const icon = (name) => (ui[name] ? h(ui[name], {}) : undefined);
            const review = changes?.turns > 1 ? TEXT.reviewLatest : TEXT.reviewChanges;
            return [
                open ? { id: 'open', label: open.label, icon: h(open.icon, {}) } : null,
                opener?.onOpen ? { id: 'changes', label: opener.review ? review : TEXT.openChanges, icon: icon('IconCodeOutlineRegular') } : null,
                live && rename?.getSnapshot?.().available ? { id: 'rename', label: TEXT.renameThread, icon: icon('IconEditOutlineRegular') } : null,
                settings?.getSnapshot?.().available ? { id: 'thread-settings', label: TEXT.threadSettings, icon: icon('IconSlidersTwoOutlineRegular') } : null,
                live && thread.running ? { id: 'stop', label: TEXT.stopThread, icon: icon('IconStopFillRegular') } : null,
                live && thread.resolved ? { id: 'reopen', label: TEXT.reopenThread, icon: icon('IconRefreshOutlineRegular') } : null,
                live && !thread.resolved && !thread.running ? { id: 'resolve', label: TEXT.resolveThread, icon: icon('IconCheckCircleOutlineRegular') } : null,
            ].filter(Boolean);
        }

        /**
         * Do what a thread's ⋯ item says: open it or its changes, ask for a
         * new name (`rename`, renameFlow) or show its row in Thread settings
         * (`settings`), or stop, resolve or reopen it through the plugin
         * (remote.js `update`).
         * @param target - the thread's chat or the thread itself, which the change goes through.
         * @param title - the thread's name now, for Rename.
         * @returns the plugin's refusal as a sentence, or '' when it's done.
         */
        async function runThreadItem(id, { target, thread, title, open, opener, facts, rename, settings }) {
            if (id === 'open') open?.();
            else if (id === 'changes') opener?.onOpen?.();
            else if (id === 'rename') rename?.open?.({ target, thread, title });
            else if (id === 'thread-settings') settings?.open?.(target, { pick: `thread:${thread}` });
            const changes = id === 'stop' ? { stop: true } : id === 'resolve' ? { resolved: true } : id === 'reopen' ? { resolved: false } : null;
            if (changes === null || typeof facts?.change !== 'function') return '';
            const said = (error) => (continueError(error) === TEXT.continueFailed ? TEXT.threadChangeFailed : continueError(error));
            try {
                const result = await facts.change(target, { thread, ...changes });
                return result?.ok === false ? said(result.error) : '';
            } catch (error) {
                return said(error);
            }
        }

        let menuMarks = 0;
        /**
         * Hand the keyboard to a menu's first item once its list shows. DSH
         * draws a list that sits in the page's body hidden for its first
         * frame while it measures it, and a hidden item can't take the
         * keyboard, so DSH's own autoFocus misses it there (and the arrows
         * then start on the second item). Opened from the keyboard, the item
         * shows its ring; opened with the pointer it doesn't, as in DSH's menus.
         * @returns the class for the menu's list (listClassName), which finds it.
         */
        function useFirstItemFocus(open) {
            const [mark] = React.useState(() => `dshp-menu-${(menuMarks += 1)}`);
            React.useEffect(() => {
                if (!open || typeof requestAnimationFrame !== 'function') return undefined;
                const keys = document.activeElement?.matches?.(':focus-visible') === true;
                let frame = 0;
                let tries = 0;
                const step = () => {
                    const list = document.querySelector(`.${mark}`);
                    const first = list?.querySelector('[role="menuitem"]:not(:disabled)');
                    if (!first || getComputedStyle(list).visibility === 'hidden') {
                        if ((tries += 1) < 30) frame = requestAnimationFrame(step);
                        return;
                    }
                    if (list.contains(document.activeElement)) return;
                    if (keys || typeof ui.focusWithoutRing !== 'function') first.focus();
                    else ui.focusWithoutRing(first);
                };
                frame = requestAnimationFrame(step);
                return () => cancelAnimationFrame(frame);
            }, [open, mark]);
            return mark;
        }

        /**
         * ⋯ at the end of a thread's row in the Threads menu and panel: its
         * items (threadMenuItems) in DSH's menu. A right-click on the row,
         * Shift+F10 or the context-menu key opens it too (ThreadRow). A
         * change the plugin refuses shows on the button, as Retry's does.
         */
        function ThreadMore({ title, items, run, open, setOpen }) {
            const [error, setError] = React.useState('');
            const alive = React.useRef(true);
            React.useEffect(() => () => { alive.current = false; }, []);
            const mark = useFirstItemFocus(open);
            return h(ui.Menu, {
                open, onClose: () => setOpen(false), items, portal: true, closeOnPointerLeave: true, align: 'end',
                // Its list is drawn in the page's body; the Threads menu counts it as its own (ThreadsMenu).
                listClassName: `dshp-t-more-list ${mark}`,
                onSelect: (id) => {
                    setOpen(false);
                    setError('');
                    void Promise.resolve(run(id)).then((said) => { if (alive.current) setError(said || ''); });
                },
                anchor: h('button', {
                    type: 'button', className: error ? 'dshp-t-icon dshp-t-error' : 'dshp-t-icon', title: error || undefined,
                    'aria-label': `${TEXT.threadActions(title)}${error ? `. ${error}` : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': open,
                    'data-projects-row-menu': '',
                    onClick: (event) => { event.preventDefault(); event.stopPropagation(); setOpen(!open); },
                }, h(ui.IconEllipsisOutlineRegular, { size: 14 })),
            });
        }

        /** Whether a node is in a thread row's ⋯ list, which DSH draws in the page's body. */
        function inMoreList(node) {
            const el = node?.nodeType === 1 ? node : node?.parentElement;
            return typeof el?.closest === 'function' && el.closest('.dshp-t-more-list') !== null;
        }

        /** A thread row's ⋯ items in a list (threadMenuItems), as the row and the list's room both need them. */
        function rowMenuItems({ row, current, action, changes, projects }) {
            if (row.session === undefined) return EMPTY;
            return threadMenuItems({
                thread: { running: row.running === true, resolved: row.group === 'resolved' },
                open: action && !current ? action : undefined,
                opener: projects && changes ? changesOpener(projects, row.session, changes) : undefined,
                changes, live: typeof projects?.facts?.change === 'function', rename: projects?.rename, settings: projects?.settings,
            });
        }

        /**
         * One thread: its name on the first line; its state and summary on
         * the second, with its code changes, its model and the time. A model
         * equal to `quietModel` (what new threads start on, which the menu
         * names once at its top) is left off the line and named in a tooltip
         * when the row is hovered or focused, so the summary keeps its room.
         * The same goes for its permission against `quietPermission`; the
         * user's tools it has are always named.
         * @param props.access - {permission?, tools}: what it can reach (accessOf), or undefined.
         * @param props.permissions - the permissions DSH offers, for their names.
         */
        function ThreadRow({ row, current, now, model, quietModel, access, quietPermission, permissions, changes, onOpen, action, onLeave, projects, slots = 0, find = '' }) {
            const enabled = !current && row.session !== undefined;
            const quiet = model !== undefined && model === quietModel;
            const permission = access?.permission !== undefined && access.permission !== quietPermission ? access.permission : undefined;
            const permissionText = permission !== undefined ? permissionName(permission, permissions) : undefined;
            const tools = access?.tools === 'all' || (Array.isArray(access?.tools) && access.tools.length > 0) ? toolsText(access.tools) : undefined;
            // ⋯: the other way to open it, its changes, Stop, Mark resolved or Reopen.
            const items = rowMenuItems({ row, current, action, changes, projects });
            const [menuOpen, setMenuOpen] = React.useState(false);
            const run = (id) => {
                const opener = projects && changes ? changesOpener(projects, row.session, changes) : undefined;
                // These open elsewhere (its Changes tab, a dialog), so the Threads menu closes first.
                if (id === 'changes' || id === 'rename' || id === 'thread-settings') onLeave?.();
                return runThreadItem(id, {
                    target: row.session, thread: row.id, title: row.title, open: () => action?.run(row), opener,
                    facts: projects?.facts, rename: projects?.rename, settings: projects?.settings,
                });
            };
            const acts = [
                row.ending && row.session !== undefined && projects ? h(RowContinue, { key: 'continue', row, projects }) : null,
                items.length > 0 ? h(ThreadMore, { key: 'more', title: row.title, items, run, open: menuOpen, setOpen: setMenuOpen }) : null,
            ].filter(Boolean);
            const openMenu = items.length > 0 ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen(true);
            } : undefined;
            // The room the buttons take at the row's right end: as wide as the list's busiest row's,
            // so every row's time sits in one column.
            const room = Math.max(slots * 28, acts.length > 0 ? acts.length * 26 - 2 : 0);
            const body = h('div', {
                className: 'dshp-t-row', 'data-thread': row.id, 'data-changes': changes ? '' : undefined,
                'data-projects-runs-on': model || undefined,
                'data-acts': room > 0 ? '' : undefined, style: room > 0 ? { '--dshp-t-acts': `${room}px` } : undefined,
                // Focusing the row itself (a script may) focuses its open button.
                tabIndex: -1,
                onFocus: (event) => { if (event.target === event.currentTarget) event.currentTarget.firstElementChild?.focus(); },
                // A right-click anywhere on the row opens its ⋯, as in DSH's session list.
                onContextMenu: openMenu,
            },
            h('button', {
                type: 'button', className: 'dshp-t-main', tabIndex: enabled ? 0 : -1, 'data-dshp-item': '',
                'aria-current': current ? 'true' : undefined,
                'aria-disabled': enabled ? undefined : 'true',
                'aria-keyshortcuts': items.length > 0 ? 'Shift+F10' : undefined,
                'aria-label': `${row.title}. ${current ? `${TEXT.current}. ` : ''}${row.line}${changes ? `. ${changesText(changes)}` : ''}${model ? `. Runs on ${model}` : ''}`
                    + `${permissionText ? `. ${permissionText}` : ''}${tools ? `. Your tools: ${tools}` : ''}`,
                onClick: () => { if (enabled) onOpen(row); },
                onKeyDown: openMenu ? (event) => {
                    if (event.altKey || event.ctrlKey || event.metaKey || !((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return;
                    openMenu(event);
                } : undefined,
            },
            h('span', { className: 'dshp-t-dot', 'data-state': row.dot }, h(ui.StateDot, { state: row.dot })),
            h('span', { className: 'dshp-t-text' },
                h('span', { className: 'dshp-t-name' }, ...withHit(row.title, find)),
                h('span', { className: 'dshp-t-second' },
                    h('span', { className: 'dshp-t-line' }, current ? `${TEXT.current} · ${row.line}` : row.line),
                    h('span', { className: 'dshp-t-meta' },
                        changes ? h('span', { className: 'dshp-t-row-changes', 'data-projects-changes': '' }, ...changeCounts(changes)) : null,
                        tools ? h('span', { className: 'dshp-t-tools', title: `Your tools: ${tools}`, 'data-projects-thread-tools': '' },
                            ui.IconShieldOutlineRegular ? h(ui.IconShieldOutlineRegular, { size: 12, 'aria-hidden': true }) : null, h('span', null, tools)) : null,
                        permissionText ? h('span', { className: 'dshp-t-perm', title: `Permission: ${permissionText}`, 'data-projects-thread-permission': permission },
                            permissionGlyph(permission, 12), h('span', null, permissionText)) : null,
                        model && !quiet ? h('span', { className: 'dshp-t-model', title: model, 'data-projects-thread-model': '' }, model) : null,
                        row.at !== undefined ? h('span', { className: 'dshp-t-ago' }, ago(row.at, now)) : null)))),
            acts.length > 0 || slots > 0 ? h('span', { className: 'dshp-t-row-acts', style: slots > 0 ? { minWidth: slots * 28 } : undefined }, ...acts) : null);
            return quiet ? h(ui.Tooltip, { label: `Runs on ${model}`, side: 'right', delayMs: 500, focusDelayMs: 300, portal: true }, body) : body;
        }

        /** The groups a thread list folds behind a count until clicked. */
        const FOLDED = Object.freeze(['resolved']);

        /**
         * Rows grouped as Waiting on you, Running, Done, Idle and Resolved.
         * A group in `fold` shows as "Resolved · 3" and opens on a click; it
         * starts open when it holds the current chat's row.
         * @param props.action - {label, icon, run(row)}: the other way to open a thread, first in its row's ⋯.
         * @param props.onLeave - called before a row's ⋯ opens the thread's changes elsewhere.
         */
        function ThreadList({ rows, current, now, models, quietModel, access, quietPermission, permissions, changes, onOpen, action, onLeave, projects, fold = FOLDED, find = '' }) {
            const [shown, setShown] = React.useState(() => new Set(rows.filter((row) => row.session !== undefined && row.session === current).map((row) => row.group)));
            // The most buttons a row has (Retry or Resume, and its ⋯).
            const slots = rows.reduce((most, row) => {
                const here = row.session !== undefined && row.session === current;
                const more = rowMenuItems({ row, current: here, action, changes: changes?.[row.id], projects }).length > 0;
                return Math.max(most, (row.ending && row.session !== undefined && projects ? 1 : 0) + (more ? 1 : 0));
            }, 0);
            const toggle = (id) => setShown((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
            });
            return GROUPS.map((group) => {
                const members = rows.filter((row) => row.group === group.id);
                if (members.length === 0) return null;
                const list = members.map((row) => h(ThreadRow, {
                    key: row.id, row, current: row.session !== undefined && row.session === current, now, onOpen, action, onLeave, projects, quietModel, slots, find,
                    model: row.session !== undefined ? models?.[row.session] : undefined,
                    access: row.session !== undefined ? access?.[row.session] : undefined, quietPermission, permissions,
                    changes: changes?.[row.id],
                }));
                if (!fold.includes(group.id)) {
                    return h('div', { key: group.id, role: 'group', 'aria-label': group.label, 'data-thread-group': group.id },
                        h('div', { className: 'dshp-t-group' }, group.label), ...list);
                }
                const open = shown.has(group.id);
                return h('div', { key: group.id, role: 'group', 'aria-label': group.label, 'data-thread-group': group.id },
                    h('button', {
                        type: 'button', className: 'dshp-t-group', 'data-dshp-item': '', 'aria-expanded': open,
                        onClick: () => toggle(group.id),
                    }, h(ui.IconChevronRightOutlineRegular, { size: 12 }), `${group.label} · ${members.length}`),
                    ...(open ? list : []));
            });
        }

        /** Loading, failure or empty notice for a roster, or null when there are rows. */
        function rosterNotice(info, rows, projects) {
            if (info.roster === null) {
                if (info.load === 'none') return h('div', { className: 'dshp-t-notice' }, TEXT.noCoordinator);
                if (info.load === 'error') {
                    return h('div', { className: 'dshp-t-notice dshp-t-error', role: 'alert' }, TEXT.failed,
                        h('button', { type: 'button', className: 'dshp-t-retry', onClick: () => projects.refresh(info.coordinator, true) },
                            h(ui.IconRefreshOutlineRegular, { size: 12 }), TEXT.retry));
                }
                return h('div', { className: 'dshp-t-notice', role: 'status' }, TEXT.loading);
            }
            return rows.length === 0 ? h('div', { className: 'dshp-t-notice' }, TEXT.empty) : null;
        }

        /**
         * What new threads run on and can reach, at the top of the Threads
         * menu and pane: the model and effort they start on and (once the
         * chat is described) the permission they start on and whether they
         * get the user's tools. Each opens Thread settings with that model
         * menu open, or at Access.
         * @param props.access - accessSummary's answer, or undefined.
         */
        function ModelsSummary({ thread, access, onPick }) {
            const item = (id, label, text, glyph, pick = id) => {
                const shown = text ?? '…';
                const content = [
                    h('span', { key: 'l', className: 'dshp-t-models-label' }, label),
                    glyph ? h('span', { key: 'g', className: 'dshp-t-models-glyph' }, glyph) : null,
                    h('span', { key: 'v', className: 'dshp-t-models-value', title: text }, shown),
                ];
                if (!onPick) return h('div', { key: id, className: 'dshp-t-models-row', 'data-projects-models': id }, ...content);
                return h('button', {
                    key: id, type: 'button', className: 'dshp-t-models-row', 'data-dshp-item': '', 'data-projects-models': id,
                    'aria-label': `${label}: ${text ?? 'loading'}. Change it in ${SETTINGS.title}`,
                    onClick: () => onPick(pick),
                }, ...content, h(ui.IconChevronRightOutlineRegular, { key: 'c', size: 12 }));
            };
            return h('div', { className: 'dshp-t-models', role: 'group', 'aria-label': 'Models and access' },
                item('thread', 'New threads', thread),
                access?.permission ? item('access', SETTINGS.threadAccess, access.permission.name, permissionGlyph(access.permission.preset, 12)) : null,
                access?.tools ? item('tools', SETTINGS.yourTools, access.tools, toolsGlyph(), 'access') : null);
        }

        /** The label ModelsSummary shows: the setting new threads start on, once the chat is described. */
        function summaryModels(cv, info) {
            const s = info?.settings;
            return { thread: s ? routeLabel(resolveRoute(cv, s.threadModel?.value ?? undefined, s.threadEffort?.value ?? undefined)) : undefined };
        }

        /** What newestRoster takes from the plugin's answer: [field, its value there, its value in the roster]. */
        const TOLD_FIELDS = Object.freeze([
            ['resolved', (t) => t.resolved === true, (entry) => entry.resolved === true],
            ['title', (t) => (typeof t.title === 'string' && t.title !== '' ? t.title : undefined), (entry) => entry.title],
        ]);

        /**
         * A roster with each thread's resolved state and name from the
         * plugin's answer (describe's `threads`) where that changed after the
         * roster did. The roster comes from the coordinating chat's session
         * (its thread tools' results), so Rename, Mark resolved or Reopen from
         * a row's ⋯ reaches it only at the chat's next thread tool, and
         * after a reload the plugin's answer is the newer; a change by the
         * coordinator reaches the roster first. Whichever changed last wins,
         * the plugin's at the first look.
         * @param seen - Map `<scope>/<thread>/<field>` → {listed, plugin, winner}, kept across draws by the caller.
         */
        function newestRoster(roster, threads, seen, scope = '') {
            if (!Array.isArray(roster) || !Array.isArray(threads)) return roster;
            const told = new Map();
            for (const t of threads) if (isObject(t) && typeof t.id === 'string') told.set(t.id, t);
            let changed = false;
            const out = roster.map((entry) => {
                if (!isObject(entry) || typeof entry.id !== 'string' || !told.has(entry.id)) return entry;
                let next = entry;
                for (const [field, fromPlugin, fromRoster] of TOLD_FIELDS) {
                    const plugin = fromPlugin(told.get(entry.id));
                    if (plugin === undefined) continue;
                    const key = `${scope}/${entry.id}/${field}`;
                    const listed = fromRoster(entry);
                    const last = seen.get(key);
                    const winner = !last ? 'plugin' : last.listed !== listed ? 'roster' : last.plugin !== plugin ? 'plugin' : last.winner;
                    seen.set(key, { listed, plugin, winner });
                    const value = winner === 'roster' ? listed : plugin;
                    if (value !== listed) next = { ...next, [field]: value };
                }
                if (next !== entry) changed = true;
                return next;
            });
            return changed ? out : roster;
        }

        /**
         * A roster's rows with their live state, each open thread's own
         * ending included. Thread sessions this window hasn't loaded are read
         * once, so a thread that failed or stopped says so from the start.
         * @param held - the handbacks a pause holds ([{thread, status}]).
         * @param threads - describe's threads for the chat, for newestRoster; `scope` that chat.
         */
        function useRows(projects, useSessions, listed, statuses, byId, held, threads, scope, why = 'paused') {
            // Rename, Mark resolved or Reopen from a row's ⋯ shows at once (newestRoster).
            const seen = React.useRef(null);
            if (seen.current === null) seen.current = new Map();
            const roster = React.useMemo(() => newestRoster(listed, threads, seen.current, scope), [listed, threads, scope]);
            const sessions = React.useMemo(() => openSessions(roster), [roster]);
            const endings = useEndings(useSessions, sessions);
            const live = useThreadLive(useSessions, sessions);
            const key = sessions.join('\n');
            React.useEffect(() => {
                for (const id of sessions) projects.refresh(id);
            }, [key, projects]);
            return React.useMemo(() => withHeld(rowsOf(roster, statuses, byId, endings, live), held, why), [roster, statuses, byId, endings, live, held, why]);
        }

        /** The model labels of a roster's sessions, read live from DSH. */
        function useRosterModels(projects, useSessions, rows, active) {
            const ids = React.useMemo(() => rows.map((row) => row.session).filter((id) => id !== undefined), [rows]);
            const selections = useSelections(useSessions, ids);
            const cv = useCatalogView(projects.catalog, active);
            const key = ids.join('\n');
            // Sessions DSH hasn't loaded in this window send their selection once their projections are read.
            React.useEffect(() => {
                if (active) for (const id of ids) projects.refresh(id);
            }, [active, key, projects]);
            const models = React.useMemo(() => {
                const out = {};
                for (const [id, picked] of Object.entries(selections)) out[id] = selectionText(cv, picked);
                return out;
            }, [selections, cv]);
            return { cv, models };
        }

        const GROUPED = new Intl.NumberFormat('en-US');
        const ALWAYS = Object.freeze({ getSnapshot: () => true, subscribe: () => () => {} });

        /** A thread's changes as the plugin describes them (lines added and deleted, files, the newest turn to review), or undefined. */
        function changesOf(value) {
            return isObject(value) && Number.isSafeInteger(value.added) && Number.isSafeInteger(value.deleted)
                && Number.isSafeInteger(value.files) && value.files > 0 ? value : undefined;
        }

        /** "2 files changed: 18 lines added, 3 deleted", for screen readers. */
        const changesText = (changes) => `${plural(changes.files, 'file')} changed: ${plural(changes.added, 'line')} added, ${changes.deleted} deleted`;

        /** "+18 -3 · 2 files", in DSH's colors for added and deleted lines. */
        function changeCounts(changes) {
            return [
                h('span', { key: 'c', className: 'dshp-t-counts' },
                    h('span', { className: 'dshp-t-added' }, `+${GROUPED.format(changes.added)}`),
                    h('span', { className: 'dshp-t-deleted' }, `-${GROUPED.format(changes.deleted)}`)),
                h('span', { key: 'f', className: 'dshp-t-files' }, `· ${plural(changes.files, 'file')}`),
            ];
        }

        /** Whether DSH shows code changes in chats (its developer tools setting, as its own "Edited N files" card does); on where DSH doesn't say. */
        function useCodeChanges(projects) {
            const store = projects.codeChanges?.() ?? ALWAYS;
            const subscribe = React.useCallback((listener) => store.subscribe(listener), [store]);
            const get = React.useCallback(() => store.getSnapshot(), [store]);
            return React.useSyncExternalStore(subscribe, get) !== false;
        }

        /** The newest turn in which a thread changed files, from its own projection ('' when none). */
        function lastChange(value) {
            const list = Array.isArray(value?.changes) ? value.changes : EMPTY;
            return list.length > 0 && Number.isSafeInteger(list[list.length - 1]?.seq) ? String(list[list.length - 1].seq) : '';
        }

        /**
         * Each thread's code changes, by thread id, as the plugin counts them
         * from the thread's own edits (describe's `threads[].changes`). A
         * thread's own projection marks each turn DSH announces changes for,
         * and the chat's description is read again then, so a card updates as the turn
         * ends.
         * @param {string[]} sessions - the shown threads' sessions.
         */
        function useThreadChanges(projects, useSessions, coordinator, sessions, active) {
            const key = sessions.join('\n');
            // The ids are read through `key`, so a new array of the same ids keeps the selector.
            const select = React.useCallback((state) => sessions.map((id) => lastChange(valueIn(state, id))).join(','), [key]);
            const marks = useSessions(select);
            const shown = useCodeChanges(projects);
            const facts = projects.facts;
            const on = active && shown && typeof coordinator === 'string' && coordinator !== '' && sessions.length > 0;
            const seen = React.useRef(marks);
            React.useEffect(() => {
                if (!on) return undefined;
                const fresh = seen.current !== marks;
                seen.current = marks;
                void facts.describe(coordinator, fresh ? 0 : 5000);
                if (!fresh) return undefined;
                // The plugin keeps a summary a moment after DSH announces it; read once more to be sure.
                const timer = setTimeout(() => { void facts.describe(coordinator, 0); }, 1500);
                return () => clearTimeout(timer);
            }, [on, coordinator, marks, facts]);
            const threads = React.useSyncExternalStore(facts.subscribe, () => (on ? facts.info(coordinator)?.threads : undefined));
            return React.useMemo(() => {
                const out = {};
                for (const t of Array.isArray(threads) ? threads : EMPTY) {
                    const changes = isObject(t) && typeof t.id === 'string' ? changesOf(t.changes) : undefined;
                    if (changes) out[t.id] = changes;
                }
                return out;
            }, [threads]);
        }

        /**
         * A thread's changes on its card: "+18 -3 · 2 files", opening the
         * thread's Changes tab. In a DSH without the plugin's tabs, they open
         * DSH's Review tab on the newest turn that changed files (`review`)
         * while DSH still has its diff.
         */
        function CardChanges({ changes, onOpen, review = false }) {
            const counts = changeCounts(changes);
            if (!onOpen) {
                return h('span', { className: 'dshp-t-changes', title: `${changesText(changes)}. ${TEXT.diffGone}`, 'data-projects-changes': 'gone' }, ...counts);
            }
            const label = !review ? TEXT.openChanges : changes.turns > 1 ? TEXT.reviewLatest : TEXT.reviewChanges;
            // DSH's own code-file tile, the mark on its "Edited N files" card.
            const icon = ui.FileTypeIcon ? h('span', { className: 'dshp-t-changes-icon', 'aria-hidden': true }, h(ui.FileTypeIcon, { kind: 'code', size: 16 })) : null;
            return h(ui.Tooltip, { label, side: 'top', align: 'end' },
                h('button', {
                    type: 'button', className: 'dshp-t-changes', 'aria-label': `${label}. ${changesText(changes)}`,
                    'data-projects-changes': review ? 'review' : '', onClick: onOpen,
                }, icon, ...counts));
        }

        /** What a thread's change counts open: its Changes tab, or where DSH has none, DSH's Review while it can. */
        function changesOpener(projects, sessionId, changes) {
            if (typeof sessionId !== 'string' || sessionId === '' || !changes) return {};
            if (projects.hasChanges?.() === true) return { onOpen: () => projects.openChanges(sessionId) };
            return changes.reviewable && changes.last ? { onOpen: () => projects.openReview(sessionId, changes.last), review: true } : {};
        }

        /** The coordinating chat's name, as a link to it unless that is where the user is. */
        function ProjectName({ info, here, onOpen }) {
            const name = info.project.name || TEXT.coordinator;
            const content = [h('span', { key: 'n', className: 'dshp-t-project-name' }, name)];
            if (!info.coordinator || info.coordinator === here) return h('span', { className: 'dshp-t-project' }, ...content);
            return h('button', { type: 'button', className: 'dshp-t-project', 'data-dshp-item': '', title: TEXT.openCoordinator, onClick: onOpen }, ...content);
        }

        /**
         * Start or stop coordinating in a chat, with DSH's banner for what
         * came of it: the plugin's refusal, or what the chat does now that it
         * coordinates. The chat's value is read again at once, so its header
         * changes without waiting for the chat's next event.
         */
        function useCoordinate(projects, sessionId) {
            const [busy, setBusy] = React.useState(false);
            const [said, setSaid] = React.useState(null);
            const alive = React.useRef(true);
            React.useEffect(() => {
                alive.current = true;
                return () => { alive.current = false; };
            }, []);
            const run = async (on) => {
                setBusy(true);
                const result = await projects.facts.coordinate(sessionId, on);
                if (!alive.current) return;
                setBusy(false);
                if (result.ok) projects.refresh(sessionId, true);
                const text = !result.ok ? errorText(result.error) : on && typeof result.value?.text === 'string' ? result.value.text.trim() : '';
                if (text !== '') setSaid((prev) => ({ text, failed: !result.ok, seq: (prev?.seq ?? 0) + 1 }));
            };
            const banner = said === null || typeof ui.Toast !== 'function' ? null : h(ui.Toast, {
                key: `coordinate:${said.seq}`, text: said.text, holdMs: said.failed ? 8000 : 5000,
                ...(said.failed ? { icon: h(ui.IconWarningOutlineRegular, { size: 16 }) } : { tone: 'success' }),
                onDone: () => setSaid((prev) => (prev?.seq === said.seq ? null : prev)),
            });
            return { busy, run, banner };
        }

        /**
         * Whether a session is a plain chat of the user's own, not coordinating
         * now: not a thread, nor a subagent's or teammate's session (DSH marks
         * both as a subagent's), and either no value of the plugin's or a
         * coordinating one the user stopped. A chat the user forked from
         * another is their own, though DSH lists it under its source. Not
         * while DSH is still reading its value, so a coordinating chat never
         * shows Coordinate for a moment. Never while the plugin is switched
         * off in its settings.
         */
        function canCoordinate(state, sessionId) {
            const row = state?.byId?.[sessionId];
            if (!isObject(row) || known.off) return false;
            if (row.origin === 'subagent' || row.origin === 'teammate') return false;
            const value = valueIn(state, sessionId);
            if (value) return value.role === 'coordinator' && value.off === true;
            if (state.projectionsBySession?.[sessionId]?.state === 'loading') return false;
            return !known.map.has(sessionId);
        }

        /**
         * Coordinate, in the header of a plain chat that isn't coordinating
         * (canCoordinate): a click makes the chat coordinate, so the work the
         * user asks for there runs in threads that report back to it. A chat
         * that stopped coordinating gets it back here, beside the Threads menu
         * it keeps while it has threads. A refusal shows as DSH's banner.
         */
        function CoordinateAction({ sessionId, useSessions, projects }) {
            useKnown();
            // The sessions the plugin's store knows: one DSH shows without the plugin's value may still be a thread or coordinate.
            React.useEffect(() => { void projects.facts.sessions?.(); }, [projects]);
            const shown = useSessions((state) => canCoordinate(state, sessionId));
            const { busy, run, banner } = useCoordinate(projects, sessionId);
            if (!shown) return banner;
            return h('div', { className: 'dshp-t-hdr', 'data-projects-coordinate': '' },
                h(ui.Tooltip, { label: TEXT.coordinateTip, side: 'bottom' },
                    h('button', {
                        type: 'button', className: 'dshp-t-trigger dshp-t-coordinate', 'aria-label': TEXT.coordinate, 'aria-description': TEXT.coordinateTip,
                        disabled: busy, 'aria-busy': busy || undefined, 'data-projects-coordinate-button': '', onClick: () => { void run(true); },
                    },
                    h(ui.IconBranchOutlineRegular, { size: 14 }),
                    h('span', { className: 'dshp-t-label' }, TEXT.coordinate))),
                banner);
        }

        /**
         * Whether DSH shows a chat as its new-chat screen: nothing sent in it
         * and nothing running (DSH's own test). A command run there, such as
         * /coordinate, leaves it on that screen.
         */
        const isNewChat = (session) => isObject(session) && session.blank === true && session.running !== true
            && session.promptAttempted !== true && session.awaitingFirstTurn !== true;

        /**
         * The Coordinate switch on a chat's new-chat screen: 'on' while the
         * chat coordinates, 'off' while it can start (canCoordinate), and
         * undefined for no switch: a thread, a subagent's session, a chat with
         * no folder for threads to work in, or one whose value DSH is still
         * reading.
         */
        function startState(state, sessionId) {
            const row = state?.byId?.[sessionId];
            if (!isObject(row) || typeof row.cwd !== 'string' || row.cwd === '') return undefined;
            const value = valueIn(state, sessionId);
            if (value?.role === 'coordinator' && value.off !== true) return 'on';
            return canCoordinate(state, sessionId) ? 'off' : undefined;
        }

        /**
         * What /coordinate said in each chat where this window ran it while
         * the chat was still DSH's new-chat screen, which shows a command's
         * answer only once the chat has a message. Kept until the switch there
         * has shown it.
         */
        function commandSaid() {
            const by = new Map();
            const listeners = new Set();
            let seq = 0;
            const changed = () => { for (const listener of [...listeners]) listener(); };
            return {
                subscribe(listener) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                get: (sessionId) => by.get(sessionId),
                /** DSH's answer to the command: {kind, text}. */
                put(sessionId, result) {
                    const text = typeof result?.text === 'string' ? result.text.trim() : '';
                    if (typeof sessionId !== 'string' || text === '') return;
                    seq += 1;
                    by.set(sessionId, { text, failed: result.kind === 'error', seq });
                    changed();
                },
                /** Shown: gone, unless the command ran again meanwhile. */
                take(sessionId, shown) {
                    if (by.get(sessionId)?.seq !== shown) return;
                    by.delete(sessionId);
                    changed();
                },
            };
        }

        /**
         * Coordinate on DSH's new-chat screen. Until a chat has a message,
         * DSH shows it as that screen, without the header that holds the
         * Coordinate button and without what a command run there said, so
         * the switch sits in the composer's row there. A click makes the chat
         * coordinate before its first message, so what the user asks for
         * first already runs in threads that report back to it; a click while
         * it's on stops it. /coordinate typed there lights it too, and what
         * the plugin said shows as DSH's banner. Not on a thread, a
         * subagent's session, or a chat with no folder for threads.
         */
        function StartCoordinating({ sessionId, useSession, useSessions, useConversation, projects }) {
            useKnown();
            React.useEffect(() => { void projects.facts.sessions?.(); }, [projects]);
            const fresh = useSession((session) => isNewChat(session));
            // DSH counts what its chat view shows besides commands: a chat showing any is past that screen.
            const quiet = typeof useConversation === 'function' ? useConversation((c) => !(c?.activeTargets?.size > 0)) : true;
            const state = useSessions((s) => startState(s, sessionId));
            const said = React.useSyncExternalStore(projects.said.subscribe, () => projects.said.get(sessionId));
            const { busy, run, banner } = useCoordinate(projects, sessionId);
            const shown = fresh && quiet;
            // The chat started before the banner could show: nothing left to say there.
            React.useEffect(() => {
                if (!shown && said !== undefined) projects.said.take(sessionId, said.seq);
            }, [shown, said, sessionId, projects]);
            if (!shown) return banner;
            const typed = said === undefined || typeof ui.Toast !== 'function' ? null : h(ui.Toast, {
                key: `said:${said.seq}`, text: said.text, holdMs: said.failed ? 8000 : 5000,
                ...(said.failed ? { icon: h(ui.IconWarningOutlineRegular, { size: 16 }) } : { tone: 'success' }),
                onDone: () => projects.said.take(sessionId, said.seq),
            });
            if (state === undefined) return banner || typed ? h(React.Fragment, null, banner, typed) : null;
            const on = state === 'on';
            const tip = on ? TEXT.coordinatingTip : TEXT.coordinateTip;
            return h('span', { className: 'dshp-start', 'data-coordinator-start': state },
                h(ui.Tooltip, { label: tip, side: 'top', delayMs: 500 },
                    h('button', {
                        type: 'button', className: on ? 'dshp-start-btn dshp-start-on' : 'dshp-start-btn',
                        'aria-label': on ? TEXT.coordinatingLabel : TEXT.coordinate, 'aria-description': tip,
                        disabled: busy, 'aria-busy': busy || undefined, 'data-coordinator-start-button': '', onClick: () => { void run(!on); },
                    },
                    h('span', { className: 'dshp-start-glyph', 'aria-hidden': true },
                        h(ui.IconBranchOutlineRegular, { size: 14, className: 'dshp-start-rest' }),
                        on ? h(ui.IconCloseCircleFillRegular, { size: 14, className: 'dshp-start-stop' }) : null),
                    h('span', { className: 'dshp-start-label' }, on ? TEXT.coordinating : TEXT.coordinate))),
                banner, typed);
        }

        /**
         * The Threads menu at the top of a coordinating chat and of each of
         * its threads: a count with the live state of the chat's threads,
         * opening a menu of them grouped by state. In a thread, a link back
         * to its chat comes first. While the chat coordinates, its own menu
         * ends with Stop coordinating; a chat that stopped keeps the menu
         * while it has threads.
         */
        function ThreadsMenu({ sessionId, useSessions, useSessionStatus, projects }) {
            const info = useSessions((state) => projectContext(state, sessionId), sameContext);
            const settingsOn = useSettingsAvailable(projects.settings);
            const stopping = useCoordinate(projects, sessionId);
            const beside = useBesidePref();
            const statuses = useSessionStatus((value) => value);
            const byId = useSessions((state) => state.byId);
            const [open, setOpen] = React.useState(false);
            const rootRef = React.useRef(null);
            const triggerRef = React.useRef(null);
            const panelRef = React.useRef(null);
            const hoverTimer = React.useRef(undefined);
            // The pointer came onto the trigger and hasn't moved over it yet.
            const hoverArmed = React.useRef(false);
            const pinned = React.useRef(false);
            const focusFirst = React.useRef(false);
            const now = useNow(open);
            const position = ui.useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16 });
            const cancelHover = () => {
                clearTimeout(hoverTimer.current);
                hoverTimer.current = undefined;
                hoverArmed.current = false;
            };
            const change = React.useCallback((next) => {
                cancelHover();
                if (!next) pinned.current = false;
                setOpen(next);
            }, []);
            const scheduleClose = () => {
                cancelHover();
                if (pinned.current) return;
                hoverTimer.current = setTimeout(() => change(false), 120);
            };
            // A row's ⋯ draws its list in the page's body; a click there is still in the menu.
            const within = React.useMemo(() => ({
                get current() {
                    return { contains: (node) => panelRef.current?.contains(node) === true || inMoreList(node) };
                },
            }), []);
            ui.useDismissOnOutsidePointer(rootRef, open, change, within);
            React.useEffect(() => { change(false); }, [sessionId, change]);
            React.useEffect(() => cancelHover, []);
            React.useEffect(() => {
                if (!open) return undefined;
                const dismiss = (event) => {
                    // Escape in a row's ⋯ (DSH's menu takes it first) closes only that.
                    if (event.key !== 'Escape' || event.defaultPrevented) return;
                    event.preventDefault();
                    const inside = panelRef.current?.contains(document.activeElement);
                    change(false);
                    if (inside) triggerRef.current?.focus();
                };
                document.addEventListener('keydown', dismiss);
                return () => document.removeEventListener('keydown', dismiss);
            }, [open, change]);
            React.useLayoutEffect(() => {
                if (!open || position === null || !focusFirst.current) return;
                focusFirst.current = false;
                focusables(panelRef.current)[0]?.focus();
            }, [open, position]);
            const coordinator = info?.coordinator;
            const away = coordinator !== undefined && coordinator !== sessionId;
            const unknown = info !== undefined && info.roster === null;
            React.useEffect(() => {
                if (away && (unknown || open)) projects.refresh(coordinator);
            }, [away, unknown, open, coordinator, projects]);
            const paused = usePaused(projects.facts, coordinator, coordinator ? `d:${coordinator}` : null) === true;
            const handbacks = useHeldHandbacks(projects.facts, coordinator);
            const why = holdOf(paused, useStopped(projects.facts, info));
            const described = useProjectInfo(projects.facts, sessionId, info !== undefined, open);
            const rows = useRows(projects, useSessions, info?.roster, statuses, byId, why ? handbacks : EMPTY, described?.threads, coordinator, why);
            const { cv, models } = useRosterModels(projects, useSessions, rows, open);
            const changes = useThreadChanges(projects, useSessions, coordinator, rowSessions(rows), open);
            // In a thread, its own changes as a pill in its header.
            const ownId = info?.me?.role === 'thread' && typeof info.me.thread?.id === 'string' ? info.me.thread.id : undefined;
            const own = useThreadChanges(projects, useSessions, coordinator, ownId !== undefined ? [sessionId] : EMPTY, ownId !== undefined)[ownId];
            const permissions = usePermissions(useSessions, rowSessions(rows));
            if (info === undefined || stoppedEmpty(info)) return stopping.banner;

            const counts = countsOf(rows);
            const signal = counts.failed > 0 ? 'error' : counts.waiting > 0 ? 'warning' : counts.running > 0 ? 'ongoing' : null;
            const threadsLabel = counts.open > 0 ? plural(counts.open, 'thread') : TEXT.threads;
            const label = paused ? `${TEXT.paused} · ${threadsLabel}` : threadsLabel;
            const openSession = (target) => { change(false); projects.openSession(target); };
            const parent = info.me.role === 'thread' && coordinator
                ? h(ui.Tooltip, { label: `Open ${info.project.name || TEXT.coordinator}`, side: 'bottom' },
                    h('button', { type: 'button', className: 'dshp-t-trigger dshp-t-parent', 'aria-label': TEXT.openCoordinator, onClick: () => openSession(coordinator) },
                        h(ui.IconChevronLeftOutlineRegular, { size: 14 }),
                        h('span', { className: 'dshp-t-label' }, TEXT.coordinator)))
                : null;
            const trigger = h('button', {
                ref: triggerRef, type: 'button', className: 'dshp-t-trigger',
                'aria-haspopup': 'dialog', 'aria-expanded': open,
                'aria-label': `${TEXT.threads}: ${paused ? `${TEXT.projectPaused}, ` : ''}${info.roster === null ? TEXT.loading : summaryText(counts)}`,
                'data-projects-threads-trigger': '', 'data-projects-paused': paused ? '' : undefined,
                // Hovering opens it: the pointer comes onto the trigger, then moves there. A header that re-flows
                // under a still pointer (the Changes tab opening from the pill puts the trigger where the pill was)
                // brings the trigger to the pointer without a move, and that alone must not open the menu.
                onPointerEnter: () => {
                    if (open) return;
                    cancelHover();
                    hoverArmed.current = true;
                },
                onPointerMove: (event) => {
                    if (!hoverArmed.current || open || event.pointerType === 'touch' || (event.movementX === 0 && event.movementY === 0)) return;
                    hoverArmed.current = false;
                    hoverTimer.current = setTimeout(() => { hoverTimer.current = undefined; change(true); }, 150);
                },
                // Coming back from the open menu keeps it open. A mouse event, as the menu's leave is, so it comes
                // after that leave and cancels the close it starts.
                onMouseEnter: () => { if (open) cancelHover(); },
                onClick: () => {
                    cancelHover();
                    pinned.current = true;
                    if (!open) change(true);
                },
                onKeyDown: (event) => {
                    if (event.key !== 'ArrowDown') return;
                    event.preventDefault();
                    pinned.current = true;
                    if (open) focusables(panelRef.current)[0]?.focus();
                    else { focusFirst.current = true; change(true); }
                },
            },
            signal ? h('span', { className: 'dshp-t-signal' }, h(ui.StateDot, { state: signal }))
                : paused ? h(ui.IconPauseOutlineRegular, { size: 14 }) : h(ui.IconBranchOutlineRegular, { size: 14 }),
            h('span', { className: 'dshp-t-label' }, label),
            h(ui.IconChevronDownOutlineRegular, { size: 12, className: open ? 'dshp-t-chev dshp-t-chev-open' : 'dshp-t-chev' }));

            const notice = rosterNotice(info, rows, projects);
            const summary = summaryModels(cv, described);
            const openSettings = (pick) => { change(false); projects.settings.open(sessionId, typeof pick === 'string' ? { pick } : undefined); };
            const quietPermission = permissionShown(described?.access?.threadPermission?.value, described?.permissions).preset;
            const foot = [
                projects.hasPane() ? h('button', { key: 'pane', type: 'button', className: 'dshp-t-foot-btn', 'data-dshp-item': '', onClick: () => { change(false); projects.openPane(); } },
                    h(ui.IconFlatListOutlineRegular, { size: 14 }), TEXT.openPane) : null,
                settingsOn ? h('button', { key: 'settings', type: 'button', className: 'dshp-t-foot-btn', 'data-dshp-item': '', onClick: openSettings },
                    h(ui.IconSlidersTwoOutlineRegular, { size: 14 }), SETTINGS.title) : null,
                // Only in the chat that coordinates, while it does: Coordinate in its header starts it again.
                info.me.role === 'coordinator' && info.me.off !== true ? h('button', {
                    key: 'stop', type: 'button', className: 'dshp-t-foot-btn', 'data-dshp-item': '', 'data-projects-stop-coordinating': '',
                    disabled: stopping.busy, 'aria-busy': stopping.busy || undefined, onClick: () => { change(false); void stopping.run(false); },
                }, h(ui.IconCloseOutlineRegular, { size: 14 }), TEXT.stopCoordinating) : null,
            ].filter(Boolean);
            const menu = open ? ReactDOM.createPortal(h(ui.MenuSurface, {
                ref: panelRef, className: 'dshp-t-menu', role: 'dialog', tabIndex: -1,
                'aria-label': `${TEXT.threads} · ${info.project.name ?? ''}`,
                'data-projects-threads-menu': '',
                style: position ?? { visibility: 'hidden', left: 0, top: 0 },
                onMouseEnter: cancelHover,
                onMouseLeave: scheduleClose,
                // Keys in a row's ⋯ (its list is drawn in the page's body) are that menu's own.
                onKeyDown: (event) => { if (panelRef.current?.contains(event.target)) arrowKeys(event, panelRef.current); },
            },
            h('div', { className: 'dshp-t-menu-head' },
                h(ProjectName, { info, here: sessionId, onOpen: () => openSession(coordinator) }),
                info.roster !== null ? h('span', { className: 'dshp-t-count' }, summaryText(counts)) : null),
            h(ModelsSummary, { ...summary, access: accessSummary(described), onPick: settingsOn ? openSettings : undefined }),
            paused ? h(PausedNotice, { coordinator, role: info.me.role, projects }) : null,
            h('div', { className: 'dshp-t-menu-body' },
                notice ?? h(ThreadList, {
                    rows, current: sessionId, now, models, changes, projects,
                    // The menu names what new threads start on at its top; a row names its model and permission only when they differ.
                    quietModel: summary.thread,
                    access: accessOf(described, permissions), quietPermission, permissions: described?.permissions,
                    onOpen: (row) => { change(false); projects.openThread(row.session); },
                    // A row opens the thread as the setting says; its ⋯ does the other first.
                    action: beside
                        ? { label: TEXT.openFull, icon: ui.IconRightUpOutlineRegular, run: (row) => { change(false); projects.openFull(row.session); } }
                        : { label: TEXT.openBeside, icon: ui.IconCompareSplitOutlineRegular, run: (row) => { change(false); projects.openPaired(row.session); } },
                    onLeave: () => change(false),
                })),
            foot.length > 0 ? h('div', { className: 'dshp-t-menu-foot' }, ...foot) : null), document.body) : null;
            const pill = own && projects.hasChanges?.() === true ? h(ui.Tooltip, { label: TEXT.openChanges, side: 'bottom' },
                h('button', {
                    type: 'button', className: 'dshp-t-trigger dshp-t-changes-pill', 'aria-label': `${TEXT.openChanges}. ${changesText(own)}`,
                    'data-projects-changes-pill': '', onClick: () => projects.openChanges(sessionId),
                },
                ui.FileTypeIcon ? h('span', { className: 'dshp-t-changes-icon', 'aria-hidden': true }, h(ui.FileTypeIcon, { kind: 'code', size: 14 })) : null,
                lineCounts(own.added, own.deleted))) : null;
            const gear = settingsOn ? h(ui.Tooltip, { label: SETTINGS.title, side: 'bottom' },
                h('button', {
                    type: 'button', className: 'dshp-t-trigger dshp-t-gear', 'aria-label': SETTINGS.title, 'data-projects-settings-trigger': '',
                    onClick: openSettings,
                }, h(ui.IconSlidersTwoOutlineRegular, { size: 14 }))) : null;

            return h('div', { ref: rootRef, className: 'dshp-t-hdr', 'data-projects-threads': info.me.role, onMouseLeave: scheduleClose },
                parent, pill, trigger, gear, menu, stopping.banner);
        }

        /**
         * The Threads pane in the right sidebar: a coordinating chat's threads by state.
         * A row opens the thread's chat as a tab here; its button makes it the
         * main chat.
         */
        /** A Threads panel with more threads than this has Find a thread above its list. */
        const FIND_FROM = 8;

        /** The rows whose name holds the words, in any case; all of them for no words. */
        function findRows(rows, find) {
            const words = String(find ?? '').trim().toLowerCase();
            return words === '' ? rows : rows.filter((row) => String(row.title).toLowerCase().includes(words));
        }

        /**
         * Find a thread, above the Threads panel's list. Its arrows go on to
         * the rows (it is one of the panel's items), Home and End stay in the
         * words, and Escape clears them.
         */
        function ThreadFind({ find, setFind, inputRef }) {
            return h('div', { className: 'dshp-t-find' }, h(ui.Input, {
                ref: inputRef, type: 'text', role: 'searchbox', value: find, placeholder: TEXT.findThread, 'aria-label': TEXT.findThread,
                'data-projects-thread-find': '', 'data-dshp-item': '',
                className: find !== '' ? 'dshp-t-find-box dshp-t-find-query' : 'dshp-t-find-box',
                icon: ui.IconSearchOutlineRegular ? h(ui.IconSearchOutlineRegular, { size: 14 }) : undefined,
                onChange: (event) => setFind(event.target.value),
                onKeyDown: (event) => {
                    if (event.key === 'Home' || event.key === 'End') event.stopPropagation();
                    else if (event.key === 'Escape' && find !== '') { event.preventDefault(); event.stopPropagation(); setFind(''); }
                },
            }), find !== '' ? h('button', {
                type: 'button', className: 'dshp-mp-search-clear', 'aria-label': TEXT.findClear, 'data-projects-thread-find-clear': '',
                onClick: () => { setFind(''); inputRef.current?.focus(); },
            }, h(ui.IconCloseFillRegular, null)) : null);
        }

        function ThreadsPane({ sessionId, useSessions, useSessionStatus, useTabInfo, projects }) {
            const { tab } = useTabInfo();
            const info = useSessions((state) => projectContext(state, sessionId), sameContext);
            const settingsOn = useSettingsAvailable(projects.settings);
            const statuses = useSessionStatus((value) => value);
            const byId = useSessions((state) => state.byId);
            const now = useNow(tab.visible !== false);
            const rootRef = React.useRef(null);
            const findRef = React.useRef(null);
            const [find, setFind] = React.useState('');
            const coordinator = info?.coordinator;
            React.useEffect(() => {
                if (coordinator !== undefined && coordinator !== sessionId) projects.refresh(coordinator);
            }, [coordinator, sessionId, projects]);
            const visible = tab.visible !== false;
            const paused = usePaused(projects.facts, coordinator, coordinator && visible ? `d:${coordinator}` : null) === true;
            const handbacks = useHeldHandbacks(projects.facts, coordinator);
            const why = holdOf(paused, useStopped(projects.facts, info));
            const described = useProjectInfo(projects.facts, sessionId, info !== undefined, visible);
            const rows = useRows(projects, useSessions, info?.roster, statuses, byId, why ? handbacks : EMPTY, described?.threads, coordinator, why);
            const { cv, models } = useRosterModels(projects, useSessions, rows, info !== undefined && visible);
            const changes = useThreadChanges(projects, useSessions, coordinator, rowSessions(rows), info !== undefined && visible);
            const permissions = usePermissions(useSessions, rowSessions(rows));
            if (info === undefined || stoppedEmpty(info)) {
                return h('div', { className: 'dshp-t-pane', 'data-projects-threads-pane': '' }, h('div', { className: 'dshp-t-empty' }, TEXT.notProject));
            }
            const notice = rosterNotice(info, rows, projects);
            // Over 8 threads, Find a thread; while it has words, the rows whose name holds them, resolved ones too.
            const finding = notice === null && (rows.length > FIND_FROM || find !== '');
            const found = finding ? findRows(rows, find) : rows;
            const words = finding ? find.trim() : '';
            return h('div', {
                ref: rootRef, className: 'dshp-t-pane', 'data-projects-threads-pane': '',
                onKeyDown: (event) => { if (rootRef.current?.contains(event.target)) arrowKeys(event, rootRef.current); },
            },
            h('div', { className: 'dshp-t-pane-head' },
                h(ProjectName, { info, here: sessionId, onOpen: () => projects.openSession(coordinator) }),
                info.roster !== null ? h('span', { className: 'dshp-t-count' }, summaryText(countsOf(rows))) : null,
                settingsOn ? h('span', { className: 'dshp-t-pane-gear' }, h(ui.Tooltip, { label: SETTINGS.title, side: 'bottom', align: 'end', portal: true },
                    h('button', {
                        type: 'button', className: 'dshp-t-icon', 'aria-label': SETTINGS.title, 'data-projects-settings-trigger': '',
                        onClick: () => projects.settings.open(sessionId),
                    }, h(ui.IconSlidersTwoOutlineRegular, { size: 14 })))) : null),
            h(ModelsSummary, { ...summaryModels(cv, described), access: accessSummary(described), onPick: settingsOn ? (pick) => projects.settings.open(sessionId, { pick }) : undefined }),
            paused ? h(PausedNotice, { coordinator, role: info.me.role, projects }) : null,
            finding ? h(ThreadFind, { find, setFind, inputRef: findRef }) : null,
            notice ?? (found.length === 0 ? h('div', { className: 'dshp-t-notice dshp-t-find-none', role: 'status', 'data-projects-thread-find-none': '' }, TEXT.findNone(words)) : h(ThreadList, {
                rows: found, current: sessionId, now, models, changes, projects, find: words, fold: words !== '' ? [] : FOLDED,
                access: accessOf(described, permissions), permissions: described?.permissions,
                quietPermission: permissionShown(described?.access?.threadPermission?.value, described?.permissions).preset,
                onOpen: (row) => {
                    if (projects.replaceThreadTab?.(sessionId, row.session)) return;
                    try { tab.actions.openResource(chatAddress(row.session)); } catch { projects.openBeside(row.session); }
                },
                action: { label: TEXT.openFull, icon: ui.IconRightUpOutlineRegular, run: (row) => projects.openFull(row.session) },
            })));
        }

        /** The resource behind a thread's sidebar chat: the thread session, held while the tab shows it. */
        function threadChatResources(sessions) {
            const waitForAbort = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
            }));
            /** Wait until the session list has the session, or has loaded without it. */
            const listed = (sessionId, signal) => new Promise((resolve) => {
                const check = () => {
                    const state = sessions.list.getSnapshot();
                    if (state.byId[sessionId] !== undefined) return finish(true);
                    if (state.phase === 'ready' || signal.aborted) return finish(false);
                    return undefined;
                };
                let unsubscribe = () => {};
                const finish = (value) => {
                    unsubscribe();
                    signal.removeEventListener('abort', check);
                    resolve(value);
                };
                unsubscribe = sessions.list.subscribe(check);
                signal.addEventListener('abort', check, { once: true });
                check();
            });
            return {
                protocol: CHAT_PROTOCOL,
                async *open(address, { signal }) {
                    const sessionId = chatSessionOf(address);
                    if (sessionId === undefined) {
                        yield { ok: false, error: { message: `not a thread chat address: ${address}` } };
                        await waitForAbort(signal);
                        return;
                    }
                    if (!(await listed(sessionId, signal)) && signal.aborted) return;
                    let reference;
                    try {
                        reference = sessions.retain(sessionId, { source: 'projectsThreadChat', signal });
                    } catch (error) {
                        if (signal.aborted) return;
                        yield { ok: false, error: { message: String(error?.message ?? error) } };
                        await waitForAbort(signal);
                        return;
                    }
                    try {
                        yield { ok: true, value: { sessionId, reference } };
                        await waitForAbort(signal);
                    } finally {
                        reference.release();
                    }
                },
            };
        }

        /** The chat itself always shows the Chat view of the conversation. */
        function ChatOnlyView(props) {
            return props.renderSlot('conversation.session', { view: 'chat' });
        }

        /** The conversation of the session the chat tab provides (DSH's own embedded chat). */
        function ThreadConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
            const session = useSession((value) => value);
            const conversation = useConversation((value) => value);
            const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank);
            const shellPhase = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
                ? 'active' : session.promptAttempted ? 'engaging' : 'blank';
            const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
            const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true);
            return renderFactorySlot('conversation.content', {
                variant: 'embedded',
                phase: settling ? 'settling' : hero ? 'hero' : 'active',
                hero,
            }, { slots: { views: ChatOnlyView } });
        }

        /** Live facts for the bar and title of a thread's sidebar chat. */
        function useChatFacts(threadSession, useSessions, useSessionStatus) {
            const value = useSessions((state) => valueIn(state, threadSession));
            const displayTitle = useSessions((state) => state.byId[threadSession]?.displayTitle);
            const listRunning = useSessions((state) => state.byId[threadSession]?.running === true);
            const status = useSessionStatus((map) => map.get(threadSession));
            const running = (status?.running ?? listRunning) === true;
            const title = value?.role === 'thread' ? value.thread?.title ?? displayTitle : displayTitle;
            const dot = status?.pendingInteraction ? 'warning' : running ? 'ongoing' : endingOf(value)?.state === 'failed' ? 'error' : 'idle';
            return { value, title: title || TEXT.thread, running, dot };
        }

        function ThreadChatTab({ useTabInfo, useResource, useSessions, useSessionStatus, SessionProvider, renderSlot, projects }) {
            const { tab } = useTabInfo();
            const threadSession = chatSessionOf(tab.contentId);
            const resource = useResource(tab.contentId);
            const facts = useChatFacts(threadSession, useSessions, useSessionStatus);
            const value = facts.value;
            const sub = value?.role === 'thread'
                ? (value.project?.name ? `${TEXT.thread} of ${value.project.name}` : TEXT.thread)
                : value?.role === 'coordinator' ? (value.off === true ? TEXT.rowStopped : TEXT.rowProject) : '';
            return h('div', { className: 'dshp-t-chat', 'data-projects-thread-chat': threadSession ?? '' },
                h('div', { className: 'dshp-t-chat-bar' },
                    h(ui.StateDot, { state: facts.dot }),
                    h('div', { className: 'dshp-t-chat-title' },
                        h('span', { className: 'dshp-t-chat-name' }, facts.title),
                        sub ? h('span', { className: 'dshp-t-chat-sub' }, sub) : null),
                    threadSession ? h(ui.Tooltip, { label: TEXT.openFull, side: 'bottom', align: 'end' },
                        h(ui.Button, {
                            variant: 'ghost', size: 'sm', icon: h(ui.IconRightUpOutlineRegular, { size: 16 }), 'data-projects-full': '',
                            onClick: () => projects.openFull(threadSession),
                        }, TEXT.fullView)) : null),
                h('div', { className: 'dshp-t-chat-body' },
                    resource.status === 'failed' && resource.value === undefined
                        ? h('div', { className: 'dshp-t-empty' }, TEXT.chatGone)
                        : resource.value === undefined ? null
                            : h(SessionProvider, { session: resource.value.reference }, renderSlot(CONVERSATION_SLOT, {}))));
        }

        function ThreadChatTitle({ useTabInfo, useSessions, useSessionStatus }) {
            const { tab } = useTabInfo();
            const facts = useChatFacts(chatSessionOf(tab.contentId), useSessions, useSessionStatus);
            return h('span', { className: 'dshp-t-tab-title' },
                facts.dot === 'idle' ? h(ui.IconBranchOutlineRegular, { size: 14 }) : h(ui.StateDot, { state: facts.dot }),
                h('span', null, facts.title));
        }

        /** Which session a `.dsh-thread/tN` link means, as far as the store knows yet. */
        function resolveLink(state, target) {
            if (!target) return { state: 'invalid' };
            const own = valueIn(state, target.sessionId);
            if (!own) {
                const load = state.projectionsBySession?.[target.sessionId]?.state;
                return { state: load === 'ready' || load === 'error' ? 'not-project' : 'loading' };
            }
            if (own.role === 'thread' && own.thread?.id === target.threadId) return { state: 'found', session: target.sessionId };
            const coordinator = own.role === 'coordinator' ? target.sessionId : own.coordinator;
            const roster = own.role === 'coordinator' ? own.threads : valueIn(state, coordinator)?.threads;
            if (!Array.isArray(roster)) return { state: coordinator ? 'loading' : 'missing', coordinator };
            const entry = roster.find((t) => isObject(t) && t.id === target.threadId);
            return typeof entry?.session === 'string' && entry.session !== ''
                ? { state: 'found', session: entry.session, coordinator }
                : { state: 'missing', coordinator };
        }
        const sameLink = (a, b) => a.state === b.state && a.session === b.session && a.coordinator === b.coordinator;

        /**
         * A `.dsh-thread/tN` link from a reply: find the thread's session and
         * open its chat in this tab's place.
         */
        function ThreadLinkTab({ useTabInfo, useSessions, projects }) {
            const { tab } = useTabInfo();
            const target = linkTarget(tab.contentId);
            const found = useSessions((state) => resolveLink(state, target), sameLink);
            React.useEffect(() => {
                if (found.state === 'found') tab.actions.openResource(chatAddress(found.session), { replaceTab: true });
            }, [found.state, found.session, tab.actions]);
            React.useEffect(() => {
                if (target) projects.refresh(target.sessionId);
                if (found.coordinator && found.coordinator !== target?.sessionId) projects.refresh(found.coordinator);
            }, [target?.sessionId, found.coordinator, projects]);
            const retry = () => {
                if (target) projects.refresh(target.sessionId, true);
                if (found.coordinator) projects.refresh(found.coordinator, true);
            };
            const text = found.state === 'found' || found.state === 'loading' ? TEXT.linkLoading
                : found.state === 'not-project' ? TEXT.linkNotProject
                    : `Thread ${target?.threadId ?? ''} isn't one of this chat's threads.`;
            return h('div', { className: 'dshp-t-pane', 'data-projects-thread-link': found.state },
                h('div', { className: 'dshp-t-empty', role: 'status' }, text,
                    found.state === 'missing' ? h('div', null, h('button', { type: 'button', className: 'dshp-t-retry', onClick: retry },
                        h(ui.IconRefreshOutlineRegular, { size: 12 }), TEXT.retry)) : null));
        }

        /** DSH's own words for its diff card's controls, for the Changes tab's diffs. */
        const DIFF_LABELS = Object.freeze({
            codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Do not wrap lines',
            copy: 'Copy', copied: 'Copied',
            collapseAria: 'Collapse diff', expandAria: (count) => `Expand ${count} more diff lines`,
            collapse: 'Collapse', expand: (count) => `… ${count} more lines`,
        });
        /** Lines one file's diff shows before its middle folds. */
        const CHANGES_MAX_LINES = 40;
        /** A Changes tab with more files than this starts with them folded. */
        const CHANGES_OPEN_FILES = 8;
        const whole = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

        /** A thread's title as DSH's session store has it, for its tabs. */
        function threadTitleIn(state, sessionId) {
            const value = valueIn(state, sessionId);
            return (value?.role === 'thread' ? value.thread?.title : undefined) ?? state?.byId?.[sessionId]?.displayTitle ?? TEXT.thread;
        }

        /** DSH's address for a file read through a session: a path inside its folder is relative to it, any other absolute. */
        function fileAddress(sessionId, path) {
            const encode = (part) => encodeURIComponent(part).replace(/%3A/gi, ':');
            const clean = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
            return `dsh-resource://file/session/${encode(sessionId)}/${clean.split('/').map(encode).join('/')}`;
        }

        /** "Turns 1, 2 · by this thread and Docs helper": when a file changed, and who changed it besides the thread. */
        function editsText(edits) {
            const turns = [...new Set(edits.map((e) => e.turn).filter(Number.isSafeInteger))].sort((a, b) => a - b);
            const by = [...new Set(edits.map((e) => (typeof e.by === 'string' ? e.by : '')))];
            const helpers = by.filter(Boolean);
            const when = turns.length === 0 ? '' : turns.length === 1 ? `Turn ${turns[0]}` : `Turns ${turns.join(', ')}`;
            const who = helpers.length === 0 ? '' : `by ${by.includes('') ? 'this thread and ' : ''}${listText(helpers)}`;
            return [when, who].filter(Boolean).join(' · ');
        }

        /** Why a Changes tab couldn't read a thread's changes, in one sentence. */
        function readFailure(error) {
            const code = String(error?.code ?? '');
            const message = String(error?.message ?? '').trim();
            if (code === 'coordinator/refused' && message) return `${message.replace(/^./, (c) => c.toUpperCase())}${/[.!?]$/.test(message) ? '' : '.'}`;
            if (code === 'projects/unreachable' || code.startsWith('gateway/not') || code.startsWith('rpc/') || !message) return SETTINGS.unreachable;
            return `${TEXT.changesFailed} ${message}`;
        }

        /** "+12 -3" in DSH's colors for added and deleted lines. */
        const lineCounts = (added, deleted) => h('span', { className: 'dshp-t-counts' },
            h('span', { className: 'dshp-t-added' }, `+${GROUPED.format(added)}`),
            h('span', { className: 'dshp-t-deleted' }, `-${GROUPED.format(deleted)}`));

        /** What a file's edits came to, as the plugin read it (projects.js threadDiffs), or null when it couldn't say. */
        function netOf(file) {
            const net = file?.net;
            return isObject(net) && Array.isArray(net.hunks) ? net : null;
        }

        /** One edit's caption when a file shows several: its place among them, its turn and who made it. */
        function editHead(edit, i) {
            const turn = Number.isSafeInteger(edit?.turn) ? `Turn ${edit.turn}` : '';
            const by = typeof edit?.by === 'string' && edit.by !== '' ? `by ${edit.by}` : '';
            return [`Edit ${i + 1}`, turn, by].filter(Boolean).join(' · ');
        }

        /** The lines a file's head counts: what its edits came to when the plugin knows, else their sum. */
        const shownCounts = (file) => netOf(file) ?? file;

        /**
         * One changed file in a Changes tab: its name and counts, folding open
         * to DSH's diff of what its edits came to, with each edit's hunks
         * under "Each edit" when there are two or more; or to the edits one by
         * one, and why, when there is no such diff.
         */
        function ChangedFile({ file, open, onToggle, each = false, onEach, onOpenFile, onOpenThread }) {
            const bodyId = React.useId();
            const eachId = React.useId();
            const net = netOf(file);
            const asDiffs = (hunks) => hunks.filter(isObject)
                .map((hunk) => ({ path: file.path, oldText: typeof hunk.oldText === 'string' ? hunk.oldText : null, newText: String(hunk.newText ?? '') }));
            const perEdit = React.useMemo(() => file.edits.map((edit) => asDiffs(Array.isArray(edit.hunks) ? edit.hunks : EMPTY)), [file]);
            const netDiffs = React.useMemo(() => (net ? asDiffs(net.hunks) : EMPTY), [file]);
            const clipped = file.edits.some((edit) => edit.clipped === true);
            const also = (Array.isArray(file.alsoBy) ? file.alsoBy : EMPTY).filter((other) => isObject(other) && typeof other.thread === 'string');
            const counts = shownCounts(file);
            const added = whole(counts.added);
            const deleted = whole(counts.deleted);
            const created = net ? net.created === true : file.created === true;
            const block = (list) => (list.length > 0 && ui.DiffBlock ? h(ui.DiffBlock, { key: 'diff', diffs: list, labels: DIFF_LABELS, maxLines: CHANGES_MAX_LINES, className: 'dshp-ch-diff' }) : null);
            const clippedNote = (key) => h('p', { key, className: 'dshp-ch-note' }, TEXT.changesClipped);
            // One edit is the file's diff; several each get their own, under a caption, so one reads apart from the next.
            const edits = file.edits.length > 1
                ? file.edits.map((edit, i) => h('div', { key: `edit-${i}`, className: 'dshp-ch-edit', 'data-projects-changes-edit': String(i + 1) },
                    h('p', { className: 'dshp-ch-note dshp-ch-edit-head' }, h('span', null, editHead(edit, i)), lineCounts(whole(edit.added), whole(edit.deleted))),
                    block(perEdit[i]),
                    edit.clipped === true ? clippedNote('clipped') : null))
                : [block(perEdit[0] ?? EMPTY), clipped ? clippedNote('clipped') : null];
            const why = typeof file.netWhy === 'string' && Object.hasOwn(TEXT.changesNetWhy, file.netWhy) ? TEXT.changesNetWhy[file.netWhy] : '';
            // One edit is the same diff again.
            const eachable = file.edits.length > 1 && typeof onEach === 'function';
            return h('section', { className: 'dshp-ch-file', 'data-projects-changes-file': file.path, 'data-open': open ? '' : undefined },
                h('div', { className: 'dshp-ch-file-head' },
                    h('button', {
                        type: 'button', className: 'dshp-ch-file-toggle', 'aria-expanded': open, 'aria-controls': open ? bodyId : undefined,
                        'aria-label': `${file.path}${created ? ` (${TEXT.changesNew})` : ''}: ${plural(added, 'line')} added, ${deleted} deleted`,
                        onClick: onToggle,
                    },
                    h(ui.IconChevronDownOutlineRegular, { size: 12, className: open ? 'dshp-ch-chev dshp-ch-chev-open' : 'dshp-ch-chev' }),
                    ui.FileTypeIcon ? h('span', { className: 'dshp-ch-file-icon', 'aria-hidden': true }, h(ui.FileTypeIcon, { path: file.path, size: 16 })) : null,
                    ui.PathLabel ? h(ui.PathLabel, { path: file.path, className: 'dshp-ch-path' }) : h('span', { className: 'dshp-ch-path', title: file.path }, file.path),
                    created ? h('span', { className: 'dshp-ch-new' }, TEXT.changesNew) : null,
                    lineCounts(added, deleted)),
                    onOpenFile ? h(ui.Tooltip, { label: TEXT.changesOpenFile, side: 'bottom', align: 'end' },
                        h('button', { type: 'button', className: 'dshp-ch-tool', 'aria-label': `Open ${file.path} in the sidebar`, 'data-projects-changes-open': '', onClick: onOpenFile },
                            h(ui.IconInspectOutlineRegular ?? ui.IconRightUpOutlineRegular, { size: 15 }))) : null),
                open ? h('div', { id: bodyId, className: 'dshp-ch-file-body' },
                    // When and by whom, under the file's name, so it never reads as the next file's.
                    h('p', { className: 'dshp-ch-note dshp-ch-when' }, editsText(file.edits)),
                    ...(net ? [
                        h('div', { key: 'net', className: 'dshp-ch-net', 'data-projects-changes-net': '' },
                            netDiffs.length > 0 && ui.DiffBlock ? h(ui.DiffBlock, { diffs: netDiffs, labels: DIFF_LABELS, maxLines: CHANGES_MAX_LINES, className: 'dshp-ch-diff' }) : null,
                            net.clipped === true ? h('p', { className: 'dshp-ch-note' }, TEXT.changesClipped)
                                : netDiffs.length === 0 ? h('p', { className: 'dshp-ch-note', 'data-projects-changes-same': net.endings === true ? 'endings' : created ? 'empty' : 'undone' },
                                    net.endings === true ? TEXT.changesEndings : created ? TEXT.changesEmpty : TEXT.changesUndone(file.edits.length)) : null,
                            net.since === true ? h('p', { className: 'dshp-ch-note' }, TEXT.changesSince) : null,
                            net.unlisted === true ? h('p', { className: 'dshp-ch-note' }, TEXT.changesUnlisted) : null),
                        eachable ? h('button', {
                            key: 'each', type: 'button', className: 'dshp-ch-each', 'aria-expanded': each, 'aria-controls': each ? eachId : undefined,
                            'data-projects-changes-each': '', onClick: onEach,
                        }, h(ui.IconChevronDownOutlineRegular, { size: 12, className: each ? 'dshp-ch-chev dshp-ch-chev-open' : 'dshp-ch-chev' }), TEXT.changesEach(file.edits.length)) : null,
                        eachable && each ? h('div', { key: 'edits', id: eachId, className: 'dshp-ch-edits', 'data-projects-changes-edits': '' }, ...edits) : null,
                    ] : [
                        why ? h('p', { key: 'why', className: 'dshp-ch-note', 'data-projects-changes-why': file.netWhy }, why) : null,
                        ...edits,
                    ]),
                    also.length > 0 ? h('p', { className: 'dshp-ch-note', 'data-projects-changes-also': '' }, `${TEXT.changesAlso} `,
                        ...also.flatMap((other, i) => [
                            i > 0 ? (i === also.length - 1 ? ' and ' : ', ') : null,
                            typeof other.session === 'string' && onOpenThread
                                ? h('button', {
                                    key: other.thread, type: 'button', className: 'dshp-ch-link', 'aria-label': `See what ${other.title || other.thread} changed`,
                                    onClick: () => onOpenThread(other.session),
                                }, other.title || other.thread)
                                : h('span', { key: other.thread }, other.title || other.thread),
                        ]), '.') : null) : null);
        }

        /**
         * A thread's Changes tab: each file it changed with DSH's file tools,
         * or a subagent of its did, with lines added and deleted and DSH's diff
         * of what its edits came to (each edit's hunks one click away). The
         * plugin reads them from the sessions' logs and the texts it kept
         * (remote.js `changes`) when the tab shows, each time the thread's
         * records gain a turn, and on Read again.
         */
        function ThreadChangesTab({ useTabInfo, useSessions, projects }) {
            const { tab } = useTabInfo();
            const thread = changesSessionOf(tab.contentId);
            const visible = tab.visible !== false;
            const mark = useSessions((state) => lastChange(valueIn(state, thread)));
            const stored = useSessions((state) => threadTitleIn(state, thread));
            const [read, setRead] = React.useState({ phase: 'loading' });
            const [again, setAgain] = React.useState(0);
            const [folds, setFolds] = React.useState(() => new Map());
            // The files whose edits show one by one under the diff of what they came to.
            const [eaches, setEaches] = React.useState(() => new Set());
            const asked = React.useRef('');
            React.useEffect(() => {
                if (thread === undefined || !visible) return undefined;
                const key = `${mark}|${again}`;
                if (asked.current === key) return undefined;
                asked.current = key;
                let live = true;
                let done = false;
                setRead((prev) => (prev.phase === 'ready' ? { ...prev, busy: true } : { phase: 'loading' }));
                void Promise.resolve(projects.link.call('changes', { target: thread })).then((result) => {
                    done = true;
                    if (!live) return;
                    // A failed read again keeps what the tab showed, and says it failed.
                    setRead((prev) => (result?.ok && isObject(result.value) ? { phase: 'ready', value: result.value }
                        : prev.phase === 'ready' ? { phase: 'ready', value: prev.value, error: result?.error } : { phase: 'failed', error: result?.error }));
                });
                return () => {
                    live = false;
                    if (!done) asked.current = '';
                };
            }, [thread, visible, mark, again, projects]);
            const value = read.phase === 'ready' ? read.value : undefined;
            const files = (Array.isArray(value?.files) ? value.files : EMPTY).filter((f) => isObject(f) && typeof f.path === 'string' && f.path !== '' && Array.isArray(f.edits));
            const name = typeof value?.title === 'string' && value.title !== '' ? value.title : stored;
            const added = files.reduce((n, f) => n + whole(shownCounts(f).added), 0);
            const deleted = files.reduce((n, f) => n + whole(shownCounts(f).deleted), 0);
            const openAll = files.length <= CHANGES_OPEN_FILES;
            const isOpen = (path) => folds.get(path) ?? openAll;
            const toggle = (path) => setFolds((prev) => new Map(prev).set(path, !(prev.get(path) ?? openAll)));
            const toggleEach = (path) => setEaches((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
            });
            const openFile = (path) => {
                try { tab.actions.openResource(fileAddress(thread, path)); } catch (error) { console.warn(`[coordinator] could not open ${path}: ${error?.message ?? error}`); }
            };
            const reviewable = (Array.isArray(value?.turns) ? value.turns : EMPTY)
                .filter((t) => isObject(t) && t.reviewable === true && Number.isSafeInteger(t.turn) && Number.isSafeInteger(t.seq));
            const folded = files.filter((f) => !isOpen(f.path)).length;
            const retry = () => setAgain((n) => n + 1);
            const busy = read.phase === 'loading' || read.busy === true;
            let body;
            if (thread === undefined) body = h('div', { className: 'dshp-t-empty' }, TEXT.changesFailed);
            else if (read.phase === 'loading') body = h('div', { className: 'dshp-t-empty', role: 'status' }, TEXT.changesLoading);
            else if (read.phase === 'failed') {
                body = h('div', { className: 'dshp-t-empty', role: 'alert' }, readFailure(read.error),
                    h('div', null, h('button', { type: 'button', className: 'dshp-t-retry', onClick: retry }, h(ui.IconRefreshOutlineRegular, { size: 12 }), TEXT.retry)));
            } else if (files.length === 0) body = h('div', { className: 'dshp-t-empty' }, TEXT.changesNone);
            else {
                body = h('div', { className: 'dshp-ch-files' }, ...files.map((file) => h(ChangedFile, {
                    key: file.path, file, open: isOpen(file.path), onToggle: () => toggle(file.path),
                    each: eaches.has(file.path), onEach: () => toggleEach(file.path),
                    onOpenFile: () => openFile(file.path),
                    onOpenThread: (session) => projects.openChanges(session),
                })));
            }
            return h('div', { className: 'dshp-ch', 'data-projects-changes-tab': thread ?? '', 'data-state': read.phase },
                h('div', { className: 'dshp-ch-bar' },
                    h('div', { className: 'dshp-ch-title' },
                        thread !== undefined
                            ? h('button', { type: 'button', className: 'dshp-ch-name', title: `${TEXT.openTip}: ${name}`, onClick: () => projects.openThread(thread) }, name)
                            : h('span', { className: 'dshp-ch-name' }, name),
                        h('span', { className: 'dshp-ch-sub', 'aria-live': 'polite' },
                            files.length > 0 ? [lineCounts(added, deleted), h('span', { key: 'f', className: 'dshp-t-files' }, `· ${plural(files.length, 'file')}`)]
                                : read.phase === 'ready' ? TEXT.changes : '')),
                    h(ui.Tooltip, { label: TEXT.changesRead, side: 'bottom', align: 'end' },
                        h('button', {
                            type: 'button', className: 'dshp-ch-tool', 'aria-label': TEXT.changesRead, 'data-projects-changes-read': '',
                            'aria-disabled': busy ? 'true' : undefined, onClick: () => { if (!busy) retry(); },
                        }, h(ui.IconRefreshOutlineRegular, { size: 15, className: busy ? 'dshp-ch-busy' : undefined })))),
                h('div', { className: 'dshp-ch-body' },
                    read.error && read.phase === 'ready' ? h('p', { className: 'dshp-ch-note dshp-t-error', role: 'alert' }, readFailure(read.error)) : null,
                    folded > 0 && folded === files.length ? h('p', { className: 'dshp-ch-note' }, TEXT.changesFolded(folded)) : null,
                    body,
                    read.phase === 'ready' ? h('div', { className: 'dshp-ch-foot' },
                        reviewable.length > 0 ? h('p', { className: 'dshp-ch-note', 'data-projects-changes-reviews': '' }, `${TEXT.changesReview}: `,
                            ...reviewable.flatMap((t, i) => [
                                i > 0 ? ' · ' : null,
                                h('button', { key: t.seq, type: 'button', className: 'dshp-ch-link', 'data-projects-changes-review': String(t.turn), onClick: () => projects.openReview(thread, t) }, `Turn ${t.turn}`),
                            ])) : null,
                        whole(value?.unread) > 0 ? h('p', { className: 'dshp-ch-note' }, `What ${plural(value.unread, 'subagent')} changed couldn't be read.`) : null,
                        h('p', { className: 'dshp-ch-note' }, TEXT.changesShell)) : null));
        }

        /** A Changes tab's title: DSH's code-file mark and the thread's name. */
        function ThreadChangesTitle({ useTabInfo, useSessions }) {
            const { tab } = useTabInfo();
            const title = useSessions((state) => threadTitleIn(state, changesSessionOf(tab.contentId)));
            return h('span', { className: 'dshp-t-tab-title', 'data-projects-changes-title': '' },
                ui.FileTypeIcon ? h('span', { className: 'dshp-ch-tab-icon', 'aria-hidden': true }, h(ui.FileTypeIcon, { kind: 'code', size: 14 })) : null,
                h('span', null, `${TEXT.changes} · ${title}`));
        }

        /**
         * A thread's to-do list (DSH's `todos` view of its session: what its
         * turn's todo_write set; a new turn clears it) as {done, total,
         * current}, or undefined when it has none.
         */
        function progressOf(todos) {
            const items = Array.isArray(todos) ? todos.filter((t) => isObject(t) && typeof t.content === 'string' && t.content.trim() !== '') : EMPTY;
            if (items.length === 0) return undefined;
            const current = items.find((t) => t.status === 'in_progress')?.content.replace(/\s+/g, ' ').trim();
            return { done: items.filter((t) => t.status === 'completed').length, total: items.length, ...(current ? { current } : {}) };
        }

        /** How long a turn has run: "45s", "3m 12s", "1h 4m". */
        function elapsedText(ms) {
            if (!(ms >= 0)) return '';
            const seconds = Math.floor(ms / 1000);
            if (seconds < 60) return `${seconds}s`;
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
            return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
        }

        /** A handback's summary on one line, without its state ahead of it ("Blocked: no key" reads "No key"); '' when it has none. */
        function handbackGist(hb) {
            const summary = typeof hb?.summary === 'string' ? hb.summary.replace(/\s+/g, ' ').trim() : '';
            const label = HANDBACK_LABELS[hb?.status] ?? '';
            if (label === '' || summary.slice(0, label.length).toLowerCase() !== label.toLowerCase()) return summary;
            const rest = summary.slice(label.length);
            if (rest !== '' && !/^[\s:.,;—–-]/.test(rest)) return summary;
            return rest.replace(/^[\s:.,;—–-]+/, '').replace(/^./, (c) => c.toUpperCase());
        }

        /** What some threads are doing now, by session: their to-do list (DSH's `todos`) and when their turn started (`turnAt`). */
        function useThreadLive(useSessions, sessionIds) {
            const key = sessionIds.join('\n');
            // The ids are read through `key`, so a new array of the same ids keeps the selector.
            const select = React.useCallback((state) => {
                const out = {};
                for (const id of sessionIds) {
                    const todos = state?.projectionsBySession?.[id]?.values?.todos ?? state?.byId?.[id]?.projectionValues?.todos;
                    const turnAt = valueIn(state, id)?.turnAt;
                    if (Array.isArray(todos) || Number.isFinite(turnAt)) {
                        out[id] = { todos: Array.isArray(todos) ? todos : undefined, turnAt: Number.isFinite(turnAt) ? turnAt : undefined };
                    }
                }
                return out;
            }, [key]);
            return useSessions(select, sameLive);
        }
        const sameLive = (a, b) => {
            const keys = Object.keys(a);
            return keys.length === Object.keys(b).length && keys.every((k) => isObject(b[k]) && a[k].todos === b[k].todos && a[k].turnAt === b[k].turnAt);
        };

        /**
         * The line of substance on a thread's newest card: while it runs, its
         * step, how far along it is and how long its turn has run; once it
         * reports, what it said; while it waits on you, what it asks (and that
         * it waits, unless the card says so already). Never its state again: the card says that
         * beside it. Undefined when there is nothing to add; a failed or
         * stopped turn has its own line.
         */
        function cardDetail(view, live, now) {
            const row = view?.row;
            if (!row || row.ending) return undefined;
            if (row.pending) {
                const ask = pendingAsk(row.pendingInteraction);
                // An approval card says it waits on you already: it adds what the thread asks, when DSH's prompt says.
                if (view.kind === 'approval') return ask ? { kind: 'pending', text: ask } : undefined;
                return { kind: 'pending', text: [pendingLine(row.pendingInteraction), ask].filter(Boolean).join(' · ') };
            }
            const hb = isObject(row.entry?.handback) ? row.entry.handback : undefined;
            if (row.running) {
                const progress = progressOf(live?.todos);
                const step = progress ? progress.current : hb?.status === 'progress' ? handbackGist(hb) || undefined : undefined;
                const elapsed = Number.isFinite(live?.turnAt) ? elapsedText(now - live.turnAt) : '';
                return progress || step || elapsed ? { kind: 'running', progress, step, elapsed } : undefined;
            }
            const gist = hb && hb.status !== 'progress' ? handbackGist(hb) : '';
            return gist ? { kind: 'told', text: gist } : undefined;
        }

        /** The cards one turn earned, one per thread, in the order they happened. */
        function cardsOf(value, turn) {
            if (!isObject(value) || !Array.isArray(value.cards) || !Number.isSafeInteger(turn)) return EMPTY;
            const out = [];
            const seen = new Set();
            for (const card of value.cards) {
                if (!isObject(card) || card.turn !== turn || typeof card.kind !== 'string') continue;
                const key = typeof card.thread === 'string' ? card.thread : `#${card.kind}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(card);
            }
            return out.length > 0 ? out : EMPTY;
        }
        const sameList = (a, b) => a === b || (a.length === b.length && a.every((item, i) => item === b[i]));

        const UPDATE_VERBS = { stopped: 'Stopped a thread', resolved: 'Resolved a thread', reopened: 'Reopened a thread', renamed: 'Renamed a thread' };
        const UPDATE_ICONS = { stopped: 'IconStopFillRegular', resolved: 'IconCheckCircleOutlineRegular', reopened: 'IconRefreshOutlineRegular', renamed: 'IconEditOutlineRegular' };
        /** An idle note's card when the thread's turn failed or stopped (the note says so first). */
        const IDLE_VIEWS = {
            failed: { icon: 'IconWarningTriangleOutlineRegular', verb: 'Turn failed', tone: 'error' },
            stopped: { icon: 'IconStopFillRegular', verb: 'Stopped before it finished' },
        };
        /**
         * The state a card's event left its thread in, in the words the
         * card's state uses. While the thread is still there, the card says
         * the state once, beside the name, and its line names only the event.
         */
        const OUTCOMES = {
            handback: { done: 'Done', blocked: 'Blocked', needs_decision: 'Needs a decision' },
            idle: { failed: 'Failed', stopped: 'Stopped', '': 'Idle' },
            update: { stopped: 'Stopped', resolved: 'Resolved' },
        };
        const SHORT_VERBS = { handback: 'Handback', idle: 'Ended without a handback', update: 'Updated a thread' };

        /**
         * How one card reads: its icon, its line above the name, and what it
         * opens. `held` lists the handbacks a pause holds.
         */
        function cardView(card, info, statuses, byId, here, endings, held = EMPTY, why = 'paused') {
            const handback = HANDBACK_LABELS[card.status] ?? card.status;
            if (info.me.role === 'thread') {
                // A thread's own turn: only its handback is news, and it points at the chat that started it.
                if (card.kind !== 'handback' || !info.coordinator) return null;
                // While threads are paused, the thread's newest handback waits for Resume.
                const waits = held.some((hb) => isObject(hb) && hb.thread === info.me.thread?.id)
                    && !(info.me.cards ?? EMPTY).some((c) => isObject(c) && c.kind === 'handback' && c.seq > card.seq);
                return {
                    key: `handback-${card.seq ?? ''}`, kind: card.kind, icon: waits ? ui.IconPauseOutlineRegular : ui.IconTreeCornerRegular,
                    verb: `${waits ? TEXT.handbackHeld : 'Handed back'}${handback ? ` · ${handback}` : ''}`,
                    note: waits ? TEXT.handbackHeldWhy[why] ?? TEXT.handbackHeldWhy.paused : undefined,
                    title: info.project.name || TEXT.coordinator, session: info.coordinator === here ? undefined : info.coordinator,
                };
            }
            const entry = (info.roster ?? EMPTY).find((t) => isObject(t) && t.id === card.thread);
            // A handback a pause holds counts as the thread's state, as in the Threads menu.
            const row = entry ? withHeld([threadRow(entry, statuses, byId, endings)], held, why)[0] : undefined;
            const base = {
                key: card.thread ?? `${card.kind}-${card.seq ?? ''}`, kind: card.kind, threadId: card.thread, seq: card.seq,
                title: row?.title ?? card.thread ?? TEXT.thread, session: row?.session, row,
                state: row ? { dot: row.dot, label: row.stateLabel } : undefined,
            };
            // Said beside the name already: the line names only the event.
            const told = row !== undefined && OUTCOMES[card.kind]?.[card.status ?? ''] === row.stateLabel;
            switch (card.kind) {
                case 'start': return { ...base, icon: ui.IconBranchOutlineRegular, verb: 'Started a thread' };
                case 'send': return { ...base, icon: ui.IconSendOutlineRegular, verb: card.status === 'steer' ? 'Steered a thread' : 'Sent a message to a thread' };
                case 'update': return { ...base, icon: ui[UPDATE_ICONS[card.status]] ?? ui.IconEditOutlineRegular, verb: told ? SHORT_VERBS.update : UPDATE_VERBS[card.status] ?? 'Updated a thread' };
                case 'handback': {
                    const verb = card.status === 'progress' ? handback : told ? SHORT_VERBS.handback : `Handback${handback ? ` · ${handback}` : ''}`;
                    return { ...base, icon: ui.IconTreeCornerRegular, verb };
                }
                case 'idle': {
                    const ended = IDLE_VIEWS[card.status];
                    return {
                        ...base, icon: (ended && ui[ended.icon]) || ui.IconPauseOutlineRegular,
                        verb: told ? SHORT_VERBS.idle : ended?.verb ?? 'Went idle without a handback', tone: ended?.tone,
                    };
                }
                case 'approval': return { ...base, icon: ui.IconWarningOutlineRegular, verb: 'Asked for your approval' };
                case 'question': return { ...base, icon: ui.IconQuestionOutlineRegular ?? ui.IconSendOutlineRegular, verb: 'Asked a question' };
                default: return null;
            }
        }

        /**
         * The plugin's own messages between sessions. DSH draws a message from
         * another session or from a plugin as a collapsed notice that says
         * only "Task message received" or "Plugin status updated"; these say
         * what came in. The first line of each is its tag (prompts.js TAGS).
         */
        const NOTICE_PATTERNS = [
            ['handback', /^\[Handback from thread (t\d+) · "(.*)" · status: ([a-z_]+)\]$/],
            ['idle', /^\[Thread idle without a handback: (t\d+) · "(.*)"\]$/],
            ['approval', /^\[Thread waiting for approval: (t\d+) · "(.*)"\]$/],
            ['question', /^\[Question from thread (t\d+) · "(.*)"\]$/],
            ['brief', /^\[Brief from the chat "(.*)" · you are thread (t\d+), "(.*)"\]$/],
            ['coordinator', /^\[From the coordinator\]$/],
            ['message', /^\[Message from the chat "(.*)"\]$/],
            ['reply', /^\[Reply from (.+)\]$/],
        ];
        /** The sources DSH draws those messages with: another session's (a handback, a brief) and a plugin's (the notes). */
        const NOTICE_SOURCES = new Set(['agent-message', 'cordis-host-runner']);
        /** The closing note in which the plugin tells the coordinator how to answer (prompts.js NOTE_START); the user's notice leaves it out. */
        const CLOSING_NOTE = /(?:^|\n\n)\((?:The user has not seen this|For the user|Full conversation|Tell the user|If its last reply|Sent by the chat|DSH closed before you answered this)\b[^\n]*\)\s*$/;
        /** A handback's state as its notice says it: the state the thread reported, not its state now. */
        const NOTICE_STATES = {
            done: { dot: 'done', label: 'Done' },
            blocked: { dot: 'warning', label: 'Blocked' },
            needs_decision: { dot: 'warning', label: 'Needs a decision' },
            progress: { dot: 'idle', label: 'Progress' },
        };

        /**
         * What one of the plugin's messages says, for its notice: its kind,
         * the thread or chat it names, and its text without the tag (a
         * handback's without its closing note to the coordinator). undefined
         * for any other message, which keeps DSH's own notice.
         */
        function noticeOf(data) {
            if (!isObject(data) || !isObject(data.source) || !NOTICE_SOURCES.has(data.source.kind)) return undefined;
            const text = (Array.isArray(data.content) ? data.content : [])
                .map((part) => (isObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
            const newline = text.indexOf('\n');
            const head = newline < 0 ? text : text.slice(0, newline);
            const body = newline < 0 ? '' : text.slice(newline).trim().replace(CLOSING_NOTE, '').trim();
            for (const [kind, pattern] of NOTICE_PATTERNS) {
                const m = pattern.exec(head);
                if (!m) continue;
                switch (kind) {
                    case 'handback': return { kind, thread: m[1], name: m[2], status: m[3], body };
                    case 'idle': {
                        // The note's first line says when the turn failed or stopped (prompts.js describeEnding).
                        const ended = /^The turn (failed|was blocked)\b/.test(body) ? 'failed' : /^The turn (was stopped|hit the output token limit|was cut off)\b/.test(body) ? 'stopped' : '';
                        return { kind, thread: m[1], name: m[2], status: ended, body };
                    }
                    case 'approval': return { kind, thread: m[1], name: m[2], body };
                    case 'question': return { kind, thread: m[1], name: m[2], body };
                    case 'message': return { kind, project: m[1], body };
                    case 'reply': {
                        // Its first line says when the chat's turn failed or stopped, as an idle note's does.
                        const ended = /^The turn (failed|was blocked)\b/.test(body) ? 'failed' : /^The turn (was stopped|hit the output token limit|was cut off)\b/.test(body) ? 'stopped' : '';
                        // A chat named by an earlier version may still carry its "◆ " mark.
                        return { kind, name: m[1].replace(/^"([^]*)"$/, '$1').replace(/^◆ /, ''), status: ended, body };
                    }
                    case 'brief': return { kind, project: m[1], thread: m[2], name: m[3], body };
                    default: return { kind, body };
                }
            }
            return undefined;
        }

        /** How a notice reads: its icon, its line (lead, name, tail), its state, and why it came. */
        function noticeView(notice) {
            switch (notice.kind) {
                case 'handback':
                    return { icon: ui.IconTreeCornerRegular, lead: TEXT.noticeHandback, name: notice.name, state: NOTICE_STATES[notice.status] ?? { dot: 'idle', label: notice.status }, why: TEXT.noticeHandbackWhy };
                case 'idle': {
                    const failed = notice.status === 'failed';
                    const stopped = notice.status === 'stopped';
                    return {
                        icon: failed ? ui.IconWarningTriangleOutlineRegular : stopped ? ui.IconStopFillRegular : ui.IconPauseOutlineRegular,
                        name: notice.name, tail: TEXT.noticeIdle,
                        state: { dot: failed ? 'error' : 'idle', label: OUTCOMES.idle[notice.status] ?? OUTCOMES.idle[''] }, why: TEXT.noticeIdleWhy,
                    };
                }
                case 'approval':
                    return { icon: ui.IconWarningOutlineRegular, name: notice.name, tail: TEXT.noticeApproval, state: { dot: 'warning', label: TEXT.needsYou }, why: TEXT.noticeApprovalWhy };
                case 'question':
                    return { icon: ui.IconQuestionOutlineRegular ?? ui.IconSendOutlineRegular, name: notice.name, tail: TEXT.noticeQuestion, why: TEXT.noticeQuestionWhy };
                case 'brief':
                    return { icon: ui.IconPaperPlaneOutlineRegular, lead: TEXT.noticeBrief, name: notice.project, why: TEXT.noticeBriefWhy };
                case 'message':
                    return { icon: ui.IconPaperPlaneOutlineRegular, lead: TEXT.noticeMessage, name: notice.project, why: TEXT.noticeMessageWhy };
                case 'reply': {
                    const failed = notice.status === 'failed';
                    return {
                        icon: ui.IconSendOutlineRegular, lead: TEXT.noticeReply, name: notice.name, why: TEXT.noticeReplyWhy,
                        state: notice.status ? { dot: failed ? 'error' : 'idle', label: failed ? 'Failed' : 'Stopped' } : undefined,
                    };
                }
                default:
                    return { icon: ui.IconPaperPlaneOutlineRegular, lead: TEXT.noticeCoordinator, why: TEXT.noticeCoordinatorWhy };
            }
        }

        /**
         * DSH's keyed node for a turn's trigger, shadowed: the plugin's own
         * messages get a notice that names them; every other trigger renders
         * through DSH's own view, found among the slot's entries.
         */
        function TriggerNotice(props) {
            const notice = noticeOf(props.node?.data);
            if (notice !== undefined) return h(ProjectNotice, { node: props.node, notice });
            const Dsh = props.dshTrigger?.();
            return Dsh ? h(Dsh, props) : h(ProjectNotice, { node: props.node, notice: { kind: 'other', body: noticeText(props.node?.data) } });
        }

        /** A notice's text as DSH shows it when expanded. */
        function noticeText(data) {
            return (Array.isArray(data?.content) ? data.content : []).map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : '')).join('').trim();
        }

        /** DSH's notice, saying what came in. The same box and toggle, the name and state in words. */
        function ProjectNotice({ node, notice }) {
            const [open, setOpen] = React.useState(false);
            const bodyId = React.useId();
            const view = notice.kind === 'other' ? { icon: ui.IconPaperPlaneOutlineRegular, lead: TEXT.noticeOther } : noticeView(notice);
            const at = Number(node?.data?.time);
            const time = clockOf(at);
            return h('section', { className: 'dshp-nt', 'data-turn-trigger': '', 'data-projects-notice': notice.kind, 'data-thread': notice.thread },
                h('button', { type: 'button', className: 'dshp-nt-head', 'aria-expanded': open, 'aria-controls': bodyId, onClick: () => setOpen(!open) },
                    h('span', { className: 'dshp-nt-icon', 'aria-hidden': true }, h(view.icon ?? ui.IconPaperPlaneOutlineRegular, { size: 14 })),
                    h('span', { className: 'dshp-nt-line' },
                        view.lead ? `${view.lead}${view.name ? ' ' : ''}` : null,
                        view.name ? h('span', { className: 'dshp-nt-name' }, view.name) : null,
                        view.tail ? ` ${view.tail}` : null),
                    view.state ? h('span', { className: 'dshp-nt-state' }, h(ui.StateDot, { state: view.state.dot }), view.state.label) : null,
                    time ? h('time', { className: 'dshp-nt-time', dateTime: new Date(at).toISOString() }, time) : null,
                    h(ui.IconChevronDownOutlineRegular, { size: 12, className: open ? 'dshp-nt-chev dshp-nt-chev-open' : 'dshp-nt-chev' })),
                open ? h('div', { id: bodyId, className: 'dshp-nt-body' },
                    view.why ? h('p', { className: 'dshp-nt-why' }, view.why) : null,
                    notice.body ? h('pre', { className: 'dshp-nt-text' }, notice.body) : null) : null);
        }

        function ThreadCard({ view, projects }) {
            const enabled = view.session !== undefined;
            // While its turn runs, the newest card's clock ticks each second.
            const ticking = view.newest === true && view.row?.running === true && Number.isFinite(view.live?.turnAt);
            const now = useNow(ticking, 1000);
            const detail = view.newest === true ? cardDetail(view, view.live, now) : undefined;
            const beside = useBesidePref();
            // A thread's own handback card points at its coordinator, which opens as the main chat.
            const thread = view.threadId !== undefined;
            // The thread's newest card says why its last turn failed or stopped, and offers to run it again.
            const ending = enabled && view.newest ? view.row?.ending : undefined;
            const go = useContinue(projects, ending ? view.row : undefined);
            // When it ended, so a retry that failed again reads differently from the failure before it.
            const at = ending ? Date.parse(ending.at ?? '') : NaN;
            const when = clockOf(at);
            const reason = ending ? endingReason(ending) : '';
            const why = go.error || [when, reason].filter(Boolean).join(' · ');
            const again = ending ? againText(ending.times) : '';
            const goLabel = go.retry ? TEXT.retryThread : TEXT.resumeThread;
            return h('div', { className: 'dshp-t-card', 'data-thread': view.threadId, 'data-card-kind': view.kind, 'data-card-tone': view.tone },
                h('span', { className: 'dshp-t-card-icon', 'aria-hidden': true }, h(view.icon, { size: 16 })),
                h('div', { className: 'dshp-t-card-text' },
                    h('span', { className: 'dshp-t-card-verb', title: view.note ?? (view.model ? `${view.verb} · ${view.model}` : undefined) },
                        view.verb, view.model ? h('span', { className: 'dshp-t-card-model', 'data-projects-thread-model': '' }, ` · ${view.model}`) : null),
                    h('button', {
                        type: 'button', className: 'dshp-t-card-title', disabled: !enabled,
                        title: !enabled ? undefined : thread ? `${beside ? TEXT.openTip : TEXT.openFull}: ${view.title}` : TEXT.openCoordinator,
                        onClick: () => projects.openThread(view.session),
                    }, view.title),
                    detail && !(ending && why) ? h(CardDetail, { detail }) : null,
                    ending && why ? h('span', {
                        className: go.error ? 'dshp-t-card-why dshp-t-error' : 'dshp-t-card-why', title: why,
                        role: go.error ? 'alert' : undefined, 'data-projects-ending': ending.state,
                    }, go.error || [
                        when ? h('time', { key: 'when', className: 'dshp-t-card-when', dateTime: new Date(at).toISOString() }, when) : null,
                        when && reason ? ' · ' : null, reason || null,
                    ]) : null),
                view.changes ? h(CardChanges, { changes: view.changes, ...changesOpener(projects, enabled ? view.session : undefined, view.changes) }) : null,
                view.state || enabled ? h('div', { className: 'dshp-t-card-side' },
                view.state ? h('span', { className: 'dshp-t-card-state' },
                    h(ui.StateDot, { state: view.state.dot }),
                    h('span', { className: 'dshp-t-card-state-text' },
                        h('span', { className: 'dshp-t-card-state-label' }, view.state.label), again ? ` ${again}` : null)) : null,
                enabled ? h('div', { className: 'dshp-t-card-actions' },
                    ending ? h(ui.Button, {
                        variant: 'outline', size: 'sm', disabled: go.busy, 'aria-label': `${goLabel}: ${view.title}`,
                        'data-projects-continue': go.retry ? 'retry' : 'resume',
                        icon: h(go.retry ? ui.IconRefreshOutlineRegular : ui.IconPlayOutlineRegular, { size: 14 }),
                        onClick: () => { void go.run(); },
                    }, h('span', { className: 'dshp-t-go-label' }, go.busy ? (go.retry ? TEXT.retrying : TEXT.resumingThread) : goLabel)) : null,
                    thread ? h(ui.Tooltip, { label: TEXT.openFull, side: 'top', align: 'end' },
                        h(ui.Button, {
                            variant: 'outline', size: 'sm', 'aria-label': `${TEXT.openFull}: ${view.title}`, 'data-projects-full': '',
                            icon: h(ui.IconRightUpOutlineRegular, { size: 14 }),
                            onClick: () => projects.openFull(view.session),
                        }, h('span', { className: 'dshp-t-full-label' }, TEXT.fullView))) : null,
                    h(ui.Tooltip, { label: thread ? TEXT.openTip : TEXT.openCoordinator, side: 'top', align: 'end' },
                        h(ui.Button, {
                            variant: 'outline', size: 'sm', 'aria-label': `${TEXT.open}: ${view.title}`, 'data-projects-open': '',
                            icon: thread ? h(ui.IconCompareSplitOutlineRegular, { size: 14 }) : undefined,
                            onClick: () => projects.openPaired(view.session),
                        }, TEXT.open))) : null) : null);
        }

        /** A card's line of substance (cardDetail): a step with its meter and clock, or what the thread said. */
        function CardDetail({ detail }) {
            if (detail.kind !== 'running') {
                return h('span', { className: 'dshp-t-card-detail', title: detail.text, 'data-projects-card-detail': detail.kind }, detail.text);
            }
            const { progress, step, elapsed } = detail;
            const title = [progress ? `${progress.done} of ${progress.total} steps done` : '', step ?? '', elapsed ? `running ${elapsed}` : ''].filter(Boolean).join(' · ');
            return h('span', { className: 'dshp-t-card-detail', title, 'data-projects-card-detail': 'running' },
                progress ? h('span', {
                    key: 'meter', className: 'dshp-t-card-meter', role: 'progressbar', 'aria-label': TEXT.steps,
                    'aria-valuemin': 0, 'aria-valuemax': progress.total, 'aria-valuenow': progress.done, 'aria-valuetext': `${progress.done} of ${progress.total}`,
                }, h('span', { style: { width: `${Math.round((progress.done / progress.total) * 100)}%` } })) : null,
                ...[
                    progress ? h('span', { key: 'count', className: 'dshp-t-card-count', 'aria-hidden': true }, `${progress.done}/${progress.total}`) : null,
                    step ? h('span', { key: 'step', className: 'dshp-t-card-step', 'data-projects-card-step': '' }, step) : null,
                    elapsed ? h('span', { key: 'elapsed', className: 'dshp-t-card-elapsed', 'data-projects-card-elapsed': '' }, elapsed) : null,
                ].filter(Boolean).flatMap((part, i) => (i > 0 ? [h('span', { key: `dot${i}`, className: 'dshp-t-card-dot', 'aria-hidden': true }, '·'), part] : [part])));
        }

        function ThreadCardList({ sessionId, cards, useSessions, useSessionStatus, projects }) {
            const info = useSessions((state) => projectContext(state, sessionId), sameContext);
            const statuses = useSessionStatus((value) => value);
            const byId = useSessions((state) => state.byId);
            // How each card's thread last ended, from the thread's own projection.
            const ofCards = info?.me.role === 'coordinator'
                ? cards.map((card) => (info.roster ?? EMPTY).find((t) => isObject(t) && t.id === card.thread)?.session).filter((id) => typeof id === 'string' && id !== '')
                : EMPTY;
            const endings = useEndings(useSessions, ofCards);
            // What a pause holds, so a held handback reads the same here as in the Threads menu.
            const coordinator = info?.me.role === 'coordinator' ? sessionId : info?.coordinator;
            const paused = usePaused(projects.facts, coordinator, coordinator ? 'list' : null) === true;
            const heldList = useHeldHandbacks(projects.facts, coordinator);
            const why = holdOf(paused, useStopped(projects.facts, info));
            React.useEffect(() => { if (why && coordinator) void projects.facts.describe(coordinator, 15000); }, [why, coordinator, projects]);
            const held = why ? heldList : EMPTY;
            const all = info?.me.role === 'coordinator' && Array.isArray(info.me.cards) ? info.me.cards : EMPTY;
            const newest = (view) => view.threadId !== undefined && !all.some((c) => isObject(c) && c.thread === view.threadId && c.seq > view.seq);
            const views = info === undefined ? EMPTY : cards.map((card) => cardView(card, info, statuses, byId, sessionId, endings, held, why)).filter(Boolean)
                .map((view) => (newest(view) ? { ...view, newest: true } : view));
            // A coordinator's cards say what each thread runs on.
            const threadSessions = views.filter((view) => view.threadId !== undefined && view.session !== undefined).map((view) => view.session);
            const selections = useSelections(useSessions, threadSessions);
            const cv = useCatalogView(projects.catalog, threadSessions.length > 0);
            const key = threadSessions.join('\n');
            React.useEffect(() => {
                for (const id of threadSessions) projects.refresh(id);
            }, [key, projects]);
            // And what each changed in the workspace, and what it is doing now.
            const changes = useThreadChanges(projects, useSessions, info?.me.role === 'coordinator' ? sessionId : undefined, threadSessions, true);
            const live = useThreadLive(useSessions, threadSessions);
            if (views.length === 0) return null;
            return h('div', { className: 'dshp-t-cards', 'data-projects-thread-cards': '' },
                ...views.map((view) => h(ThreadCard, {
                    key: view.key, projects,
                    view: view.threadId !== undefined && view.session !== undefined
                        ? { ...view, model: selectionText(cv, selections[view.session]), changes: changes[view.threadId], live: live[view.session] }
                        : view,
                })));
        }

        /** Under a finished turn: a card for each thread the turn started, steered, resolved or heard from. */
        function ThreadCards({ sessionId, turn, useProjection, useSessions, useSessionStatus, projects }) {
            const cards = useProjection(KEY, (value) => cardsOf(value, turn?.turn), sameList);
            if (cards.length === 0) return null;
            return h(ThreadCardList, { sessionId, cards, useSessions, useSessionStatus, projects });
        }

        /** Paused threads' line in the Threads menu and pane, with Resume. */
        function PausedNotice({ coordinator, role, projects }) {
            const { busy, failed, resume } = useResume(projects.facts, coordinator);
            const held = useHeld(projects.facts, coordinator);
            const handbacks = useHeldHandbacks(projects.facts, coordinator);
            return h('div', { className: 'dshp-t-paused', 'data-projects-paused': role },
                h('span', { className: 'dshp-t-paused-icon', 'aria-hidden': true }, h(ui.IconPauseOutlineRegular, { size: 14 })),
                h('div', { className: 'dshp-t-paused-text', role: 'status' },
                    h('b', null, TEXT.projectPaused), ' ', pausedText(role, held, handbacks.length),
                    failed ? h('span', { className: 'dshp-t-error' }, ` ${TEXT.resumeFailed}`) : null),
                h(ui.Button, {
                    variant: 'outline', size: 'sm', disabled: busy, 'data-projects-resume': '',
                    icon: h(ui.IconPlayOutlineRegular, { size: 14 }), onClick: () => { void resume(); },
                }, busy ? TEXT.resuming : TEXT.resume));
        }

        /**
         * Above the message box of a coordinating chat whose threads are
         * paused, and of each of its threads, the way DSH shows a goal: what
         * the pause means here, and Resume.
         */
        function PausedBar({ sessionId, useSessions, projects }) {
            const info = useSessions((state) => projectContext(state, sessionId), sameContext);
            // A chat that stopped coordinating and has no threads left has nothing to pause.
            const coordinator = stoppedEmpty(info) ? undefined : info?.coordinator;
            const paused = usePaused(projects.facts, coordinator, coordinator ? `d:${coordinator}` : null);
            const held = useHeld(projects.facts, coordinator);
            const handbacks = useHeldHandbacks(projects.facts, coordinator);
            const { busy, failed, resume } = useResume(projects.facts, coordinator);
            if (info === undefined || coordinator === undefined || paused !== true) return null;
            const text = failed ? TEXT.resumeFailed : pausedText(info.me.role, held, handbacks.length);
            return h('div', { className: 'dshp-dock', 'data-projects-paused-bar': info.me.role },
                h('div', { className: 'dshp-dock-bar', role: 'status', title: text },
                    h('span', { className: 'dshp-dock-glyph', 'aria-hidden': true }, h(ui.IconPauseOutlineRegular, { size: 14 })),
                    h('span', { className: 'dshp-dock-label' }, TEXT.projectPaused),
                    h('span', { className: failed ? 'dshp-dock-text dshp-t-error' : 'dshp-dock-text' }, text),
                    h(ui.Button, {
                        variant: 'outline', size: 'sm', disabled: busy, 'data-projects-resume': '',
                        icon: h(ui.IconPlayOutlineRegular, { size: 14 }), onClick: () => { void resume(); },
                    }, busy ? TEXT.resuming : TEXT.resume)));
        }

        /**
         * Above the message box of a thread whose last turn failed or
         * stopped (where DSH's own note can be raw JSON): why, in a sentence,
         * when, and Retry or Resume, which send the thread on with a message
         * from its coordinator. Gone once the thread runs or hands back.
         */
        function EndingBar({ sessionId, useSessions, useSessionStatus = noStatuses, projects }) {
            const me = useSessions((state) => valueIn(state, sessionId));
            const busyNow = useSessionStatus((map) => {
                const status = map?.get?.(sessionId);
                return status?.running === true || status?.pendingInteraction !== undefined && status?.pendingInteraction !== null;
            });
            const ending = me?.role === 'thread' && typeof me.thread?.id === 'string' ? endingOf(me) : undefined;
            const row = React.useMemo(() => (ending ? { session: sessionId, id: me.thread.id, title: me.thread.title || me.thread.id, ending } : undefined),
                [sessionId, me?.thread?.id, me?.thread?.title, ending]);
            const { busy, error, run, retry } = useContinue(projects, row);
            const now = useNow(row !== undefined);
            if (!row || busyNow) return null;
            const why = stoppedByYou(ending) ? TEXT.youStoppedEarly : endingReason(ending) || (retry ? '' : TEXT.stoppedEarly);
            const at = Date.parse(ending.at ?? '');
            const text = error || why;
            const action = retry ? TEXT.retryThread : TEXT.resumeThread;
            return h('div', { className: 'dshp-dock dshp-dock-wrap', 'data-projects-ending-bar': ending.state },
                h('div', { className: 'dshp-dock-bar', role: 'status', title: text },
                    h('span', { className: 'dshp-dock-glyph', 'data-state': ending.state, 'aria-hidden': true },
                        retry ? h(ui.StateDot, { state: 'error' }) : h(ui.IconStopFillRegular, { size: 12 })),
                    h('span', { className: 'dshp-dock-label' }, [retry ? TEXT.endedFailed : TEXT.endedStopped, againText(ending.times)].filter(Boolean).join(' ')),
                    text ? h('span', { className: error ? 'dshp-dock-text dshp-t-error' : 'dshp-dock-text' }, text) : h('span', { className: 'dshp-dock-text' }),
                    Number.isFinite(at) ? h('span', { className: 'dshp-dock-time' }, ago(at, now)) : null,
                    h(ui.Button, {
                        variant: 'outline', size: 'sm', disabled: busy, 'aria-busy': busy || undefined, 'data-projects-continue': retry ? 'retry' : 'resume',
                        'aria-label': `${action}: ${row.title}`,
                        icon: h(retry ? ui.IconRefreshOutlineRegular : ui.IconPlayOutlineRegular, { size: 14 }), onClick: () => { void run(); },
                    }, busy ? (retry ? TEXT.retrying : TEXT.resumingThread) : action)));
        }

        /**
         * Whether a session list row is a thread: its projection says so, or
         * (before DSH has folded it) the plugin's store does.
         */
        function isThreadRow(state, sessionId) {
            const value = valueIn(state, sessionId);
            if (value) return value.role === 'thread';
            return known.map.get(sessionId)?.role === 'thread';
        }

        /**
         * What an idle thread row's mark says beyond "a thread": that it
         * failed, or waits on the user (a decision, a block), as its rows in
         * the Threads menu say. DSH draws its own dot while a thread runs or
         * waits on a prompt. '' for nothing to say.
         */
        function markState(state, sessionId) {
            const value = valueIn(state, sessionId);
            if (value?.role !== 'thread') return '';
            const roster = valueIn(state, value.coordinator)?.threads;
            const entry = Array.isArray(roster) ? roster.find((t) => isObject(t) && t.session === sessionId) : undefined;
            if (entry?.resolved === true) return '';
            const row = rowState({ resolved: false, running: false, pending: undefined, hb: isObject(entry?.handback) ? entry.handback : undefined, ending: endingIn(state, sessionId) });
            return row.dot === 'error' || row.dot === 'warning' ? `${row.dot}:${row.label}` : '';
        }

        /** One piece of news as a line: “Fix the tests” handed back. */
        function newsLine(item) {
            const say = TEXT.news[item?.kind];
            const title = typeof item?.title === 'string' && item.title !== '' ? item.title : item?.thread ?? '';
            return say ? say(title, item.status) : '';
        }

        /** The dot a coordinator's news earns: a thread waiting on the user or failing outranks one that handed back. */
        function newsDot(unread) {
            const kinds = new Set(unread.map((item) => (item.kind === 'handback' && item.status !== 'done' ? 'stuck' : item.kind)));
            if (kinds.has('failed')) return 'error';
            return kinds.has('approval') || kinds.has('stopped') || kinds.has('stuck') ? 'warning' : 'done';
        }

        /**
         * The window's notice when a thread hands back or needs the user and
         * the chat that started it isn't the one they're looking at: DSH's own
         * banner at the top, with Open, wherever they are. That chat's row
         * keeps the news (ThreadMark, RowPlace) until they open it.
         */
        function NewsNotice({ projects }) {
            useFacts(projects.facts);
            const notice = projects.facts.notice?.() ?? null;
            if (notice === null || typeof ui.Toast !== 'function') return null;
            const needsYou = newsDot([notice.item]) !== 'done';
            const text = `${notice.name || TEXT.threads}: ${newsLine(notice.item)}${notice.more > 0 ? TEXT.newsMore(notice.more) : ''}.`;
            return h(ui.Toast, {
                key: notice.key, text, holdMs: 8000,
                ...(needsYou ? { icon: h(ui.IconWarningOutlineRegular, { size: 16 }) } : { tone: 'success' }),
                actions: [{
                    prefix: ' ', label: TEXT.newsOpen,
                    onClick: () => { projects.facts.dropNotice(notice.key); projects.openSession(notice.coordinator); },
                }],
                onDone: () => projects.facts.dropNotice(notice.key),
            });
        }

        /**
         * A row's mark in its leading seat: a branch on a thread (while it
         * nests under its coordinating chat, nestingCss draws a corner in its
         * indent instead), or the thread's state dot when it failed or waits
         * on the user; a pause sign on a coordinating chat whose threads are
         * paused, and a dot on one with news the user hasn't seen (DSH's own
         * dot takes the seat while the chat runs or waits). It is drawn
         * only: the seat comes before the title, so what it shows is read
         * after the title, from the row's description (RowPlace, rowWords).
         * It gives way to any other mark in the seat, DSH's or another
         * plugin's (CSS), so it never moves theirs.
         */
        function ThreadMark({ sessionId, useSessions, projects }) {
            useKnown();
            useFacts(projects.facts);
            // The sessions the plugin's store knows, for rows DSH lists without the plugin's value.
            React.useEffect(() => { void projects.facts.sessions?.(); }, [projects]);
            const thread = useSessions((state) => isThreadRow(state, sessionId));
            const coordinator = useSessions((state) => rowPlace(state, sessionId) === `coordinator:${sessionId}`);
            const paused = usePaused(projects.facts, coordinator ? sessionId : undefined, coordinator ? 'list' : null) === true;
            const mark = useSessions((state) => (thread ? markState(state, sessionId) : ''));
            const parent = useSessions((state) => (thread ? valueIn(state, sessionId)?.coordinator ?? known.map.get(sessionId)?.coordinator : undefined));
            const stale = useSessions((state) => known.map.has(sessionId) && valueIn(state, sessionId) === undefined);
            // A thread row's state comes from its own session and its coordinator's roster; read both once if DSH hasn't,
            // and any session the store knows that DSH listed without a value.
            React.useEffect(() => { if (thread || stale) projects.refresh(sessionId); }, [thread, stale, sessionId, projects]);
            React.useEffect(() => { if (typeof parent === 'string' && parent !== '') projects.refresh(parent); }, [parent, projects]);
            if (paused) {
                return h('span', { className: 'dshp-t-mark dshp-t-paused-mark', 'aria-hidden': true, title: TEXT.projectPaused, 'data-projects-paused-mark': '' },
                    h(ui.IconPauseOutlineRegular, { size: 12 }));
            }
            const news = coordinator ? projects.facts.newsOf?.(sessionId) : undefined;
            if (news) {
                const label = newsWords(news);
                return h('span', { className: 'dshp-t-mark', 'aria-hidden': true, title: label, 'data-projects-news-mark': news.unread.length },
                    h(ui.StateDot, { state: newsDot(news.unread) }));
            }
            if (!thread) return null;
            if (mark !== '') {
                const [dot, label] = [mark.slice(0, mark.indexOf(':')), mark.slice(mark.indexOf(':') + 1)];
                return h('span', { className: 'dshp-t-mark', 'aria-hidden': true, title: label, 'data-projects-thread-mark': dot },
                    h(ui.StateDot, { state: dot }));
            }
            return h('span', { className: 'dshp-t-mark', 'aria-hidden': true, 'data-projects-thread-mark': '' },
                h(ui.IconBranchOutlineRegular, { size: 12 }));
        }

        /** What a coordinating chat's news says: “4 new, latest: “Deploy” failed”. */
        function newsWords(news) {
            return TEXT.newsMark(news.unread.length, newsLine(news.unread[news.unread.length - 1]));
        }

        /**
         * What a coordinating chat's or a thread's row in the session list
         * says to a screen reader after its title: what the row is, then what
         * its mark shows (a pause, news from its threads, a thread that
         * failed or waits on the user). '' for any other row.
         * @param role - 'coordinator', 'thread' or ''.
         * @param off - a chat that stopped coordinating and still has threads.
         * @param mark - a thread's markState: '' for none.
         */
        function rowWords({ role, off = false, paused = false, news, mark = '' }) {
            if (role === 'coordinator') return [paused ? TEXT.projectPaused : off ? TEXT.rowStopped : TEXT.rowProject, news ? newsWords(news) : ''].filter((part) => part !== '').join(', ');
            if (role === 'thread') return mark === '' ? TEXT.rowThread : `${TEXT.rowThread}: ${mark.slice(mark.indexOf(':') + 1)}`;
            return '';
        }

        /**
         * A session list row's place: `coordinator:<its id>` for a chat that
         * coordinates threads (or did, and still has some), `thread:<its
         * chat's id>` for a thread, or '' for any other session. Only the
         * plugin's value says it, or its store for a session DSH lists without
         * one; a title never does.
         */
        function rowPlace(state, sessionId) {
            if (!isObject(state)) return '';
            const value = valueIn(state, sessionId);
            if (value?.role === 'coordinator') return value.off === true && !(Array.isArray(value.threads) && value.threads.length > 0) ? '' : `coordinator:${sessionId}`;
            if (value?.role === 'thread') return typeof value.coordinator === 'string' && value.coordinator !== '' ? `thread:${value.coordinator}` : '';
            // DSH has no value for it (one saved by another version of the plugin): the store says what it is.
            const stored = known.map.get(sessionId);
            if (stored?.role === 'coordinator') return `coordinator:${sessionId}`;
            if (stored?.role === 'thread' && stored.coordinator) return `thread:${stored.coordinator}`;
            return '';
        }

        /**
         * The coordinating chats drawn in one of DSH's workspace sections, read
         * from the marks RowPlace puts in each row: every coordinator there with at
         * least one of its threads there too, with its wrapper's position in
         * the section (from 1) and its threads in DSH's order. A section's
         * children are its rows' wrappers; a thread in another workspace
         * belongs to no group here.
         * @returns {{coordinator: string, at: number, threads: string[]}[]} in DSH's order of their coordinators.
         */
        function sectionGroups(section) {
            const coordinators = [];
            const threads = new Map();
            const wrappers = section?.children ?? EMPTY;
            for (let i = 0; i < wrappers.length; i += 1) {
                const row = sessionRowIn(wrappers[i]);
                const mark = row?.querySelector?.('[data-projects-row]');
                if (!mark) continue;
                const id = row.getAttribute('data-row-key').slice('session:'.length);
                const role = mark.getAttribute('data-projects-row');
                const of = mark.getAttribute('data-projects-of') ?? '';
                if (role === 'coordinator' && of === id) coordinators.push({ coordinator: id, at: i + 1 });
                else if (role === 'thread' && of !== '') {
                    if (threads.has(of)) threads.get(of).push(id);
                    else threads.set(of, [id]);
                }
            }
            return coordinators.filter((g) => threads.has(g.coordinator)).map((g) => ({ ...g, threads: threads.get(g.coordinator) }));
        }

        /** The session row a wrapper in one of DSH's sections holds (its child with a `session:` row key), or null. */
        function sessionRowIn(wrapper) {
            for (const child of wrapper?.children ?? EMPTY) {
                if (String(child.getAttribute?.('data-row-key') ?? '').startsWith('session:')) return child;
            }
            return null;
        }

        /** The groups the plugin nests, by their places: each with its coordinator's id and its threads' ids. */
        function nestedGroups(groups) {
            const named = (id) => typeof id === 'string' && id !== '';
            return (Array.isArray(groups) ? groups : EMPTY)
                .filter((g) => named(g?.coordinator) && Number.isInteger(g.at) && g.at >= 1 && Array.isArray(g.threads))
                .map((g) => ({ ...g, threads: g.threads.filter(named) }))
                .filter((g) => g.threads.length > 0)
                .sort((a, b) => a.at - b.at);
        }

        /** The plugin's marks for the nesting (markNesting): a section that nests threads, the order each of its children is drawn in, and a nested thread's wrapper. */
        const NEST = 'data-projects-nests';
        const NEST_ORDER = 'data-projects-order';
        const NESTED = 'data-projects-nested';
        /** The orders the nesting CSS always has a rule for: ten coordinating chats in one workspace, three each. More add rules. */
        const NEST_ORDERS = 30;

        /**
         * The CSS that nests each chat's threads under it in one of DSH's
         * workspace sections, whatever order DSH lists them in. The section
         * lays its rows' wrappers out as a column, and each coordinating chat
         * is drawn with its threads where its row is: the chat, then its
         * threads in DSH's order. So dragging the chat's row moves its threads
         * along, a thread is never drawn apart from it, and two coordinating
         * chats in one workspace stay apart. The rows DSH lists after a coordinator
         * follow its threads. DSH's order, data and wrappers stay as they
         * are. A nested thread is indented, with its corner drawn in the
         * indent: the row's leading seat stays free for DSH's marks and other
         * plugins' (a thread in another workspace keeps its branch mark there),
         * and its time is left out, so its title has the room of DSH's own.
         *
         * The rules find the section, each child's place and the nested
         * threads by the plugin's marks (markNesting), never by what an
         * element holds: each rule ends in a mark or DSH's row key, so a
         * change to one row restyles that row, not the list around it.
         * @param top - the highest order markNesting gave.
         */
        function nestingCss(top = 0) {
            const S = `[role="tree"] div[${NEST}]`;
            const T = `${S}>[${NESTED}]`;
            const last = Math.max(NEST_ORDERS, top);
            const rules = [
                `${S}{display:flex;flex-direction:column}`,
                // DSH's "Show more" button is a row of its own, as wide as its text.
                `${S}>[data-row-key]{align-self:flex-start}`,
                // A row DSH adds goes last until the plugin's next pass gives it its place: DSH measures its rows for
                // their animation before that pass, and the rows Show more adds belong at the end.
                `${S}>:not([${NEST_ORDER}]){order:${last + 1}}`,
            ];
            for (let order = 1; order <= last; order += 1) rules.push(`${S}>[${NEST_ORDER}="${order}"]{order:${order}}`);
            rules.push(
                // A thread's title 16 px in from its chat's: enough to show the tree, and the thread keeps room for its title.
                `${T}>[data-row-key]{padding-inline-start:calc(var(--dshp-nest,24px) + var(--dsh-workspace-indent,0px))}`,
                `${T}::before{${NEST_CORNER}}`,
                // The branch mark gives way to the corner; the row's description still says "Thread".
                `${T} .dshp-t-mark[data-projects-thread-mark=""]{${HIDDEN}}`,
                // DSH's time (the row's child after its title, before its actions) gives way to the indent, still read
                // aloud, so the title keeps the room it has in DSH's own rows. A status DSH writes there instead
                // ("Approval", hidden from screen readers since the seat says it) stays.
                `${T}>[data-row-key]>:nth-child(3):not(:last-child,[aria-hidden="true"]){${HIDDEN}}`,
            );
            return rules.join('\n');
        }

        /**
         * Where nestingCss draws each child of a section: the order it gets
         * (0 for what DSH lists before the first coordinator; then, for the
         * k-th coordinating chat from 0, 3k+1 its row, 3k+2 its threads and
         * 3k+3 what DSH lists after the coordinator), and whether it holds a
         * thread nested under its coordinator. null with nothing to nest.
         * @param groups - sectionGroups' answer for the section.
         * @param keys - the session each child holds, in DSH's order ('' for none).
         */
        function nestedPlaces(groups, keys) {
            const list = nestedGroups(groups);
            const count = Array.isArray(keys) ? keys.length : 0;
            if (list.length === 0 || count === 0) return null;
            const order = new Array(count).fill(0);
            const nested = new Array(count).fill(false);
            list.forEach((g, k) => { for (let i = g.at; i < count; i += 1) order[i] = 3 * k + 3; });
            list.forEach((g, k) => {
                const threads = new Set(g.threads);
                keys.forEach((key, i) => {
                    if (key === g.coordinator) order[i] = 3 * k + 1;
                    else if (threads.has(key)) {
                        order[i] = 3 * k + 2;
                        nested[i] = true;
                    }
                });
            });
            return { order, nested };
        }

        /**
         * The order nestingCss draws a section's children in: their places
         * in DSH's order (from 1), by the CSS order each gets there, then by
         * DSH's order between equals. null when that is DSH's own order.
         * @param groups - sectionGroups' answer for the section.
         * @param keys - the session each child holds, in DSH's order ('' for none).
         */
        function nestedOrder(groups, keys) {
            const places = nestedPlaces(groups, keys);
            if (places === null) return null;
            const drawn = keys.map((key, i) => i + 1).sort((a, b) => places.order[a - 1] - places.order[b - 1] || a - b);
            return drawn.some((at, i) => at !== i + 1) ? drawn : null;
        }

        /** The sections of DSH's list that hold a coordinating chat's row: where the plugin may nest threads. */
        function projectSections(tree) {
            const sections = new Set();
            for (const mark of tree?.querySelectorAll?.('[data-projects-row="coordinator"]') ?? EMPTY) {
                const section = mark.closest('[data-row-key^="session:"]')?.parentElement?.parentElement;
                if (section) sections.add(section);
            }
            return sections;
        }

        /** The session a child of one of DSH's sections holds, '' for none. */
        const keyIn = (kid) => String(sessionRowIn(kid)?.getAttribute('data-row-key') ?? '').slice('session:'.length);

        /** An attribute set to a value, or gone for null, changed only when it differs. */
        function setMark(el, name, value) {
            if (value === null) {
                if (el.hasAttribute(name)) el.removeAttribute(name);
            } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
        }

        /**
         * Mark DSH's list for nestingCss: each section that holds a
         * coordinating chat with threads, the order each of its children is drawn in there (0
         * too, so a child without one is one DSH added since), and each
         * wrapper of a thread nested under its coordinator. Only a
         * section inside the list nests (a list drawn as one flat list keeps
         * DSH's order), marks the plugin no longer needs go, and only what
         * differs changes.
         * @returns the highest order given.
         */
        function markNesting(tree) {
            let top = 0;
            const kept = new Set();
            for (const section of projectSections(tree)) {
                if (typeof section.matches !== 'function' || !section.matches('[role="tree"] div')) continue;
                const kids = [...section.children];
                const places = nestedPlaces(sectionGroups(section), kids.map(keyIn));
                if (places === null) continue;
                kept.add(section);
                setMark(section, NEST, '');
                kids.forEach((kid, i) => {
                    kept.add(kid);
                    setMark(kid, NEST_ORDER, String(places.order[i]));
                    setMark(kid, NESTED, places.nested[i] ? '' : null);
                    top = Math.max(top, places.order[i]);
                });
            }
            for (const el of tree?.querySelectorAll?.(`[${NEST}],[${NEST_ORDER}],[${NESTED}]`) ?? EMPTY) {
                if (kept.has(el)) continue;
                for (const name of [NEST, NEST_ORDER, NESTED]) el.removeAttribute(name);
            }
            return top;
        }

        const OWNS = 'data-projects-owns';
        const OWN_ID = 'dshp-o-';
        let ownCount = 0;
        /** An element's id for aria-owns: its own, else one the plugin gives it. */
        function ownId(el) {
            if (!el.id) el.id = `${OWN_ID}${(ownCount += 1).toString(36)}`;
            return el.id;
        }
        /** A section the plugin no longer reorders: its own order again, and none of the plugin's ids. */
        function unown(section) {
            section.removeAttribute('aria-owns');
            section.removeAttribute(OWNS);
            for (const kid of section.children ?? EMPTY) if (String(kid.id ?? '').startsWith(OWN_ID)) kid.removeAttribute('id');
        }

        /**
         * A screen reader meets a coordinating chat's rows in the order
         * nestingCss draws them, the threads after their chat: the section owns
         * its children in that order (aria-owns, which gives each child that
         * has no id one of the plugin's). Only a section the CSS nests (a div
         * inside the list) is reordered, and one it no longer nests gets its
         * own order back. DSH's elements stay where DSH put them.
         */
        function readInOrder(tree) {
            const kept = new Set();
            for (const section of projectSections(tree)) {
                if (typeof section.matches !== 'function' || !section.matches('[role="tree"] div')) continue;
                const kids = [...section.children];
                const drawn = nestedOrder(sectionGroups(section), kids.map(keyIn));
                if (drawn === null) continue;
                kept.add(section);
                const owns = drawn.map((at) => ownId(kids[at - 1])).join(' ');
                if (section.getAttribute('aria-owns') !== owns) section.setAttribute('aria-owns', owns);
                if (!section.hasAttribute(OWNS)) section.setAttribute(OWNS, '');
            }
            for (const section of tree?.querySelectorAll?.(`[${OWNS}]`) ?? EMPTY) if (!kept.has(section)) unown(section);
        }

        const SAID = 'data-projects-said';
        /**
         * Each coordinating chat's and thread's row in the list says the plugin's words for it
         * (rowWords, which RowPlace carries) after its title: they are the
         * row's description, since the plugin's only seat before the title
         * would be read first. A description DSH gives a row (an archived
         * one's) is DSH's, and stays.
         */
        function describeRows(tree) {
            const rows = new Set();
            for (const mark of tree?.querySelectorAll?.('[data-projects-words]') ?? EMPTY) {
                const row = mark.closest('[data-row-key^="session:"]');
                if (row) rows.add(row);
            }
            for (const row of tree?.querySelectorAll?.(`[${SAID}]`) ?? EMPTY) rows.add(row);
            for (const row of rows) {
                const words = row.querySelector('[data-projects-words]')?.getAttribute('data-projects-words') ?? '';
                const said = row.getAttribute(SAID);
                const now = row.getAttribute('aria-description');
                if (said !== null && now !== said) row.removeAttribute(SAID);
                else if (said === null && now !== null) continue;
                else if (words === '') {
                    row.removeAttribute('aria-description');
                    row.removeAttribute(SAID);
                } else if (now !== words) {
                    row.setAttribute('aria-description', words);
                    row.setAttribute(SAID, words);
                }
            }
        }

        const UNREAD_ROW = 'data-projects-unread-row';
        /**
         * A coordinating chat's row with news the user hasn't seen (RowPlace's
         * mark in it says so) is marked itself, so the CSS that makes it bold
         * names the row, rather than looking into every row for the mark.
         */
        function markUnread(tree) {
            const rows = new Set();
            for (const mark of tree?.querySelectorAll?.('[data-projects-unread]') ?? EMPTY) {
                const row = mark.closest('[data-row-key^="session:"]');
                if (row) rows.add(row);
            }
            for (const row of tree?.querySelectorAll?.(`[${UNREAD_ROW}]`) ?? EMPTY) if (!rows.has(row)) row.removeAttribute(UNREAD_ROW);
            for (const row of rows) setMark(row, UNREAD_ROW, '');
        }

        /** The list as DSH draws it: no description, order or mark of the plugin's. */
        function undoRows(tree) {
            for (const row of tree?.querySelectorAll?.(`[${SAID}]`) ?? EMPTY) {
                if (row.getAttribute('aria-description') === row.getAttribute(SAID)) row.removeAttribute('aria-description');
                row.removeAttribute(SAID);
            }
            for (const section of tree?.querySelectorAll?.(`[${OWNS}]`) ?? EMPTY) unown(section);
            for (const el of tree?.querySelectorAll?.(`[${NEST}],[${NEST_ORDER}],[${NESTED}],[${UNREAD_ROW}]`) ?? EMPTY) {
                for (const name of [NEST, NEST_ORDER, NESTED, UNREAD_ROW]) el.removeAttribute(name);
            }
        }

        /**
         * A row's place (rowPlace), from inside the row: a hidden mark in the
         * row's actions seat, which DSH mounts on every row whether it is idle
         * or busy. The sidebar reads the marks to nest each chat's threads
         * under it (nestingCss) and to keep DSH's own drags from taking a
         * thread away from its chat or a chat in among another's threads
         * (useSessionDragGuard). It also carries what the row says to a
         * screen reader after its title (rowWords, describeRows): DSH's own
         * status can take the leading seat from ThreadMark, never this one.
         * Nothing of DSH's own is changed.
         */
        function RowPlace({ sessionId, useSessions, projects }) {
            useKnown();
            const facts = projects?.facts ?? NO_FACTS;
            useFacts(facts);
            const place = useSessions((state) => rowPlace(state, sessionId));
            const at = place.indexOf(':');
            const role = place.slice(0, Math.max(0, at));
            const paused = usePaused(facts, role === 'coordinator' ? sessionId : undefined, role === 'coordinator' ? 'list' : null) === true;
            const mark = useSessions((state) => (role === 'thread' ? markState(state, sessionId) : ''));
            const off = useSessions((state) => role === 'coordinator' && valueIn(state, sessionId)?.off === true);
            if (place === '') return null;
            const news = role === 'coordinator' ? facts.newsOf?.(sessionId) : undefined;
            // A coordinating chat with news the user hasn't seen: its row's title reads bold (CSS), like unread mail.
            const unread = news?.unread.length ?? 0;
            return h('span', {
                hidden: true, 'data-projects-row': role, 'data-projects-of': place.slice(at + 1),
                'data-projects-node': role === 'coordinator' ? 'project' : 'thread', 'data-projects-id': sessionId,
                'data-projects-words': rowWords({ role, off, paused, news: unread > 0 ? news : undefined, mark }),
                ...(unread > 0 ? { 'data-projects-unread': unread } : {}),
            });
        }

        /**
         * A thread's state in its session-list hover card. DSH ends the card
         * with the session's own status ("● Idle", "● Running"), so this says
         * what the thread last did: its handback, or how its last turn ended.
         */
        function hoverLine(row) {
            if (row.pending) return undefined;
            if (row.running || row.held || row.entry.resolved) return row.line;
            if (row.ending) {
                const why = endingReason(row.ending);
                if (row.ending.state === 'failed') return `Last turn failed · ${why}`;
                if (stoppedByYou(row.ending)) return 'Last turn stopped by you';
                return why ? `Last turn stopped · ${why}` : 'Last turn stopped before it finished';
            }
            return isObject(row.entry.handback) ? `Last handback · ${row.line}` : row.line;
        }

        function ThreadHover({ sessionId, useSessions, useSessionStatus, projects }) {
            const info = useSessions((state) => projectContext(state, sessionId), sameContext);
            const statuses = useSessionStatus((value) => value);
            const byId = useSessions((state) => state.byId);
            const own = info?.me.role === 'thread';
            const endingSessions = React.useMemo(() => (own ? [sessionId] : openSessions(info?.roster)), [own, sessionId, info?.roster]);
            const endings = useEndings(useSessions, endingSessions);
            const picked = useSessions((state) => selectionIn(state, sessionId), sameSelection);
            const cv = useCatalogView(projects.catalog, info !== undefined);
            const paused = usePaused(projects.facts, info?.coordinator, info?.coordinator ? 'list' : null) === true;
            const handbacks = useHeldHandbacks(projects.facts, info?.coordinator);
            const why = holdOf(paused, useStopped(projects.facts, info));
            const thread = info?.me.role === 'thread';
            const changed = useThreadChanges(projects, useSessions, thread ? info.coordinator : undefined, thread ? [sessionId] : EMPTY, true)[info?.me.thread?.id];
            const live = useSessions((state) => permissionIn(state, sessionId));
            // Which handbacks a pause holds, and which of the user's tools a thread has, are in the chat's description; read it for this card.
            React.useEffect(() => { if (info?.coordinator) void projects.facts.describe(info.coordinator, 15000); }, [info?.coordinator, projects]);
            const described = React.useSyncExternalStore(projects.facts.subscribe, () => (info?.coordinator ? projects.facts.info(info.coordinator) : null));
            if (info === undefined || stoppedEmpty(info)) return null;
            const project = info.project.name ?? '';
            const runs = picked ? h('div', { className: 'dshp-t-hover-line', 'data-projects-thread-model': '' }, `Runs on ${selectionText(cv, picked)}`) : null;
            // Where it can write, and which of the user's tools a thread has (named only when some are listed); a coordinating chat keeps the user's own.
            const mine = thread ? described?.threads?.find?.((t) => isObject(t) && t.session === sessionId) : undefined;
            const preset = live ?? (typeof mine?.permission === 'string' ? mine.permission : undefined);
            const listed = Array.isArray(described?.guarded) && described.guarded.length > 0 && mine;
            const reach = joined([preset ? permissionName(preset, described?.permissions) : null, listed ? toolsWords(mine.tools) : null]);
            const access = reach.length > 0 ? h('div', { className: 'dshp-t-hover-line', 'data-projects-access': preset ?? '' }, permissionGlyph(preset, 12), h('span', null, ...reach)) : null;
            const pause = paused ? h('div', { className: 'dshp-t-hover-line', 'data-projects-paused': '' }, `${TEXT.projectPaused}. ${pausedText(info.me.role, 0)}`) : null;
            if (info.me.role === 'thread') {
                const entry = (info.roster ?? EMPTY).find((t) => isObject(t) && t.session === sessionId);
                const row = entry ? withHeld([threadRow(entry, statuses, byId, endings)], why ? handbacks : EMPTY, why)[0] : undefined;
                const line = row ? hoverLine(row) : undefined;
                return h('div', { className: 'dshp-t-hover', 'data-projects-thread-hover': '' },
                    h('div', { className: 'dshp-t-hover-head' }, h(ui.IconTreeCornerRegular, { size: 12 }), project ? `${TEXT.thread} of ${project}` : TEXT.thread),
                    line ? h('div', { className: 'dshp-t-hover-line', 'data-projects-state': row.dot }, line) : null,
                    changed ? h('div', { className: 'dshp-t-hover-line', 'data-projects-changes': '' }, ...changeCounts(changed)) : null,
                    runs, access, pause);
            }
            const counts = countsOf(rowsOf(info.roster, statuses, byId, endings));
            return h('div', { className: 'dshp-t-hover', 'data-projects-thread-hover': '' },
                h('div', { className: 'dshp-t-hover-head' }, h(ui.IconBranchOutlineRegular, { size: 12 }), info.me.off === true ? TEXT.rowStopped : TEXT.rowProject),
                h('div', { className: 'dshp-t-hover-line' }, counts.open + counts.resolved > 0 ? summaryText(counts).replace(/^(\d+) open/, (m, n) => plural(Number(n), 'open thread')) : 'No threads yet'),
                runs, access, pause);
        }

        /** Navigation the thread views share, with the model catalog and the plugin's endpoints; nothing here throws into React. */
        function threadsApi(ctx, dialog = settingsDialog(), shared = {}) {
            const warn = (what, error) => { console.warn(`[coordinator] ${what}: ${error?.message ?? error}`); };
            const openSession = (sessionId) => {
                if (typeof sessionId !== 'string' || sessionId === '') return;
                try { ctx.uiWorkspace.openSession(sessionId); } catch (error) { warn('could not open the session', error); }
            };
            const list = () => {
                try { return ctx.sessions.list.getSnapshot(); } catch { return undefined; }
            };
            /** The main chat: the session DSH's main view holds; undefined while it holds none, or two in the middle of a switch. */
            const mainChat = () => {
                const ids = mainViews(list());
                return ids.length === 1 ? ids[0] : undefined;
            };
            /** The coordinator a thread opens beside: undefined for any other session, or a thread whose coordinator is gone. */
            const coordinatorOf = (sessionId) => {
                let state;
                try { state = ctx.sessions.list.getSnapshot(); } catch { return undefined; }
                const place = rowPlace(state, sessionId);
                const coordinator = place.startsWith('thread:') ? place.slice('thread:'.length) : undefined;
                return coordinator !== undefined && coordinator !== sessionId && state.byId?.[coordinator] !== undefined ? coordinator : undefined;
            };
            /** The thread the user chose to see as the main chat; it stays there until another chat is opened. */
            let full;
            /**
             * Show a thread's chat in its coordinator's right sidebar, once that
             * sidebar is the one on screen (DSH keeps one per chat). A thread
             * already open there comes to the front.
             */
            const besideIn = (coordinator, sessionId) => {
                const sidebar = ctx.sidebarRight;
                let tries = 0;
                const place = () => {
                    let onScreen;
                    try { onScreen = sidebar.mounted?.getSnapshot?.(); } catch { onScreen = undefined; }
                    if (onScreen === coordinator || (onScreen === undefined && tries >= 2)) {
                        try {
                            sidebar.openResource(chatAddress(sessionId), { kind: KINDS.chat, ...threadTabFor(sidebar, coordinator, sessionId) });
                            return;
                        } catch (error) {
                            if (tries >= 40) { warn('could not open the thread beside its coordinator', error); return; }
                        }
                    }
                    // The user went on to another chat meanwhile.
                    if (tries > 0 && mainChat() !== undefined && mainChat() !== coordinator) return;
                    if (++tries <= 40) setTimeout(place, 50);
                };
                place();
            };
            /**
             * Where a thread opens in its coordinator's sidebar: in place of the thread tab already there (the one
             * in front, else the newest), so opening one thread after another doesn't pile up tabs. Nothing to
             * replace when the thread is open there already (DSH brings it to the front) or no thread is.
             */
            const threadTabFor = (sidebar, coordinator, sessionId) => {
                let tabs;
                try { tabs = sidebar.tabsIn?.(coordinator); } catch { tabs = undefined; }
                const threads = (Array.isArray(tabs) ? tabs : EMPTY).filter((tab) => tab?.kind === KINDS.chat && typeof tab.id === 'string');
                if (threads.length === 0 || threads.some((tab) => chatSessionOf(tab.contentId) === sessionId)) return {};
                let front;
                try { front = sidebar.active?.(); } catch { front = undefined; }
                const take = threads.find((tab) => tab.id === front?.id) ?? threads[threads.length - 1];
                return { replaceTab: take.id };
            };
            const failed = new Set();
            const catalog = shared.catalog ?? catalogSource(() => undefined);
            const link = shared.link ?? hostLink(() => undefined, catalog);
            const said = shared.said ?? commandSaid();
            /** Open a thread as the main chat, where it stays until another chat is opened. */
            const openFull = (sessionId) => {
                if (typeof sessionId !== 'string' || sessionId === '') return;
                full = sessionId;
                openSession(sessionId);
            };
            /**
             * Open a thread side by side: its coordinator as the main chat
             * and the thread in the coordinator's right sidebar. Where the
             * window has no room for both, or for any other session, it
             * opens as the main chat.
             */
            const openPaired = (sessionId) => {
                if (typeof sessionId !== 'string' || sessionId === '') return;
                const coordinator = coordinatorOf(sessionId);
                if (coordinator === undefined || !roomBeside()) {
                    if (coordinator !== undefined) full = sessionId;
                    openSession(sessionId);
                    return;
                }
                // Also when the coordinator is the main chat already: that closes a page (Plugins, say) shown over it.
                openSession(coordinator);
                besideIn(coordinator, sessionId);
            };
            return {
                openSession,
                openPaired,
                /** Open a chat: a thread beside its coordinator unless that's turned off, any other chat as the main chat. */
                openThread(sessionId) {
                    if (besidePref.get()) openPaired(sessionId);
                    else openFull(sessionId);
                },
                openFull,
                /**
                 * A thread from the Threads panel: in place of the thread tab shown in the panel's sidebar
                 * (threadTabFor), so the panel stays and thread after thread doesn't pile up tabs.
                 * @param holder - the session whose right sidebar holds the panel.
                 * @returns whether it opened; false when that sidebar isn't on screen or has no thread tab to replace.
                 */
                replaceThreadTab(holder, sessionId) {
                    const sidebar = ctx.sidebarRight;
                    if (typeof holder !== 'string' || typeof sessionId !== 'string' || sessionId === '' || typeof sidebar?.openResource !== 'function') return false;
                    let onScreen;
                    try { onScreen = sidebar.mounted?.getSnapshot?.(); } catch { onScreen = undefined; }
                    if (onScreen !== holder) return false;
                    const place = threadTabFor(sidebar, holder, sessionId);
                    if (place.replaceTab === undefined) return false;
                    try {
                        sidebar.openResource(chatAddress(sessionId), { kind: KINDS.chat, ...place });
                        return true;
                    } catch (error) {
                        warn('could not open the thread', error);
                        return false;
                    }
                },
                /**
                 * A click on a thread's row in DSH's session list opens the
                 * pair at once, so DSH never shows the thread as the main
                 * chat first. (Its right sidebar would open a view for the
                 * thread and drop it a moment later, which DSH logs as an
                 * error.) A click on the row's own buttons, with a modifier
                 * key, or where the thread would open on its own anyway, is
                 * DSH's as before; followOpens covers DSH's other ways in.
                 * @returns the unsubscribe.
                 */
                followRowClicks() {
                    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {};
                    const onClick = (event) => {
                        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        const target = typeof event.target?.closest === 'function' ? event.target : undefined;
                        const row = target?.closest('[data-row-key^="session:"]');
                        if (!row) return;
                        const control = target.closest('button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="switch"]');
                        if (control && control !== row && row.contains(control)) return;
                        const sessionId = row.getAttribute('data-row-key').slice('session:'.length);
                        if (!besidePref.get() || sessionId === mainChat() || coordinatorOf(sessionId) === undefined || !roomBeside()) return;
                        event.preventDefault();
                        event.stopPropagation();
                        openPaired(sessionId);
                    };
                    document.addEventListener('click', onClick, true);
                    return () => document.removeEventListener('click', onClick, true);
                },
                /**
                 * Threads open side by side wherever DSH opens them: its session
                 * list, its search, the plugin's pages. DSH's main view shows the
                 * session it holds as the main chat. When DSH starts moving that
                 * hold from one chat to a thread, the plugin holds the thread's
                 * coordinator there too, and once DSH has let go of the old chat
                 * the coordinator takes the thread's place, all before anything
                 * is drawn; the thread opens in the coordinator's right sidebar.
                 * A thread opened in full view, or one DSH shows at start or with
                 * nothing open before it, stays the main chat.
                 * @returns the unsubscribe.
                 */
                followOpens() {
                    const store = ctx.sessions?.list;
                    if (typeof store?.subscribe !== 'function') return () => {};
                    let last = mainChat();
                    let busy = false;
                    // While DSH switches to a thread: the thread, its coordinator and the plugin's hold on it.
                    let held;
                    const letGo = () => { const hold = held; held = undefined; try { hold?.reference.release(); } catch { /* already released */ } };
                    const holds = (state, id) => state?.byId?.[id]?.retainedBy?.mainView ?? 0;
                    const check = () => {
                        const state = store.getSnapshot();
                        const now = mainViews(state);
                        if (held !== undefined && !now.includes(held.thread)) letGo();
                        if (held === undefined) {
                            const opening = now.find((id) => id !== last);
                            if (opening === undefined) {
                                if (now.length === 0) last = undefined;
                                return;
                            }
                            if (full !== undefined && full !== opening) full = undefined;
                            const coordinator = last === undefined || opening === full || !besidePref.get() ? undefined : coordinatorOf(opening);
                            if (coordinator === undefined || !roomBeside()) {
                                if (now.length === 1) last = opening;
                                return;
                            }
                            busy = true;
                            try {
                                held = { thread: opening, coordinator, reference: ctx.sessions.retain(coordinator, { source: 'mainView' }) };
                            } catch (error) {
                                warn('could not open the thread beside its coordinator', error);
                                return;
                            } finally {
                                busy = false;
                            }
                        }
                        // DSH still holds the chat it showed (the coordinator's own hold counts beside the plugin's).
                        const state2 = store.getSnapshot();
                        const waiting = mainViews(state2).some((id) => id !== held.thread && (id !== held.coordinator || holds(state2, id) > 1));
                        if (waiting) return;
                        const { thread, coordinator } = held;
                        busy = true;
                        try {
                            ctx.uiWorkspace.openSession(coordinator);
                        } catch (error) {
                            warn('could not open the coordinator', error);
                        } finally {
                            letGo();
                            busy = false;
                        }
                        last = mainChat() ?? coordinator;
                        queueMicrotask(() => besideIn(coordinator, thread));
                    };
                    return store.subscribe(() => { if (!busy) check(); });
                },
                /**
                 * Keep the news current: read it at start and whenever a
                 * coordinator's row in DSH's session list changes (a note
                 * from a thread starts its turn and moves its time), and
                 * mark a coordinator's news seen while it is the main chat.
                 * @returns the unsubscribe.
                 */
                followNews() {
                    const store = ctx.sessions?.list;
                    const facts = this.facts;
                    if (typeof store?.subscribe !== 'function' || typeof facts?.news !== 'function') return () => {};
                    const open = (id) => mainViews(list()).includes(id);
                    let seen = null;
                    let timer;
                    const read = () => {
                        timer = undefined;
                        void facts.news(open).then(() => {
                            const main = mainChat();
                            if (main !== undefined) void facts.seeNews(main);
                        });
                    };
                    const check = () => {
                        const state = store.getSnapshot();
                        const main = mainChat();
                        if (main !== undefined) void facts.seeNews(main);
                        const rows = [];
                        for (const id of Object.keys(state?.byId ?? {})) {
                            if (!rowPlace(state, id).startsWith('coordinator:')) continue;
                            const row = state.byId[id];
                            rows.push(`${id}:${row?.updatedAt ?? ''}:${row?.running === true ? 1 : 0}`);
                        }
                        const key = rows.sort().join('|');
                        if (key === seen) return;
                        seen = key;
                        clearTimeout(timer);
                        timer = setTimeout(read, 600);
                    };
                    check();
                    const off = store.subscribe(check);
                    return () => {
                        off();
                        clearTimeout(timer);
                    };
                },
                /** What /coordinate said where DSH's new-chat screen hides it, for the switch there to show (StartCoordinating). */
                said,
                /**
                 * Hear DSH's note that this window ran a command: what
                 * /coordinate said in a chat that is still DSH's new-chat
                 * screen goes to `said`.
                 * @returns the unsubscribe.
                 */
                followCommands() {
                    if (typeof ctx.on !== 'function') return () => {};
                    const off = ctx.on('command/executed', (sessionId, name, result) => {
                        if (name !== 'coordinate' || list()?.byId?.[sessionId]?.blank !== true) return;
                        said.put(sessionId, result);
                    });
                    return typeof off === 'function' ? off : () => {};
                },
                /** The Thread settings dialog, for the entry points. */
                settings: dialog,
                /** The Rename dialog, for a thread's ⋯. */
                rename: shared.renames,
                /** DSH's model catalog, to name the models sessions run on. */
                catalog,
                /** The plugin's endpoints (remote.js). */
                link,
                /** What the plugin says about coordinating chats and their threads, shared by the window's views. */
                facts: shared.facts ?? projectFacts(link),
                openBeside(sessionId) {
                    if (typeof sessionId !== 'string' || sessionId === '') return;
                    try {
                        ctx.sidebarRight.openResource(chatAddress(sessionId), { kind: KINDS.chat, preferNewPane: true });
                    } catch (error) {
                        warn('could not open the thread beside this chat', error);
                        openSession(sessionId);
                    }
                },
                openPane() {
                    try { ctx.sidebarRight.openTab(KINDS.pane); } catch (error) { warn('could not open the Threads panel', error); }
                },
                /** A thread's Changes tab, in this chat's right sidebar; one already open there comes forward. */
                openChanges(sessionId) {
                    if (typeof sessionId !== 'string' || sessionId === '') return;
                    try {
                        ctx.sidebarRight.openResource(changesAddress(sessionId), { kind: KINDS.changes });
                    } catch (error) {
                        warn('could not open the thread\'s changes', error);
                    }
                },
                /** Whether this DSH has the Changes tab (a right sidebar with the plugin's tab types). */
                hasChanges() {
                    try { return ctx.get('sidebarRightTabs')?.get?.(KINDS.changes) !== undefined; } catch { return false; }
                },
                /**
                 * DSH's Review tab on one turn's changes (`last`: {seq, turn}).
                 * The tab reviews the session whose sidebar holds it, so the
                 * thread opens in full view and the tab opens in its sidebar
                 * once DSH has set that sidebar up (a moment later). Where DSH
                 * can't open a tab in another session, the thread opens, with
                 * DSH's own card for its changes.
                 */
                openReview(sessionId, last) {
                    if (typeof sessionId !== 'string' || sessionId === '' || !isObject(last)) return;
                    const address = `${REVIEW_PREFIX}${encodeURIComponent(sessionId)}/${last.seq}/${last.turn}`;
                    const sidebar = ctx.sidebarRight;
                    full = sessionId;
                    openSession(sessionId);
                    if (typeof sidebar?.openResourceIn !== 'function' || typeof sidebar.actionsFor !== 'function') return;
                    let tries = 0;
                    const place = () => {
                        try {
                            if (sidebar.actionsFor(sessionId) !== undefined) {
                                sidebar.openResourceIn(sessionId, address, { params: { index: 0 } });
                                return;
                            }
                        } catch (error) {
                            warn('could not open the changes', error);
                            return;
                        }
                        if (++tries < 50) setTimeout(place, 100);
                    };
                    place();
                },
                /** DSH's developer tools setting, which shows or hides code changes in chats; undefined where DSH has none. */
                codeChanges() {
                    try {
                        const store = ctx.get('configForms')?.developerTools?.enabled;
                        return store && typeof store.subscribe === 'function' && typeof store.getSnapshot === 'function' ? store : undefined;
                    } catch {
                        return undefined;
                    }
                },
                hasPane() {
                    try { return ctx.get('sidebarRightTabs')?.get?.(KINDS.pane) !== undefined; } catch { return false; }
                },
                /** DSH's Plugins page at this plugin (its defaults for threads); undefined where DSH can't open it. */
                get openDefaults() {
                    let nav;
                    try { nav = ctx.get?.('pluginNavigation'); } catch { nav = undefined; }
                    if (!nav || typeof nav.openBundle !== 'function') return undefined;
                    return () => {
                        try { nav.openBundle(BUNDLE); } catch (error) { warn('could not open the plugin\'s page', error); }
                    };
                },
                /** Read a session's projections once per connection; `again` retries a failed read. */
                refresh(sessionId, again = false) {
                    if (typeof sessionId !== 'string' || sessionId === '') return;
                    if (failed.has(sessionId) && !again) return;
                    failed.delete(sessionId);
                    try {
                        Promise.resolve(ctx.sessions.refreshProjections(sessionId)).catch(() => failed.add(sessionId));
                    } catch {
                        failed.add(sessionId);
                    }
                },
            };
        }

        function applyThreads(ctx, dialog, shared) {
            const projects = threadsApi(ctx, dialog, shared);
            const withApi = () => ({ projects });
            ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
                name: 'conversation.session.header.actions', id: IDS.menu, order: -25, inject: withApi,
            }, ThreadsMenu));
            // Coordinate, next to it: a plain chat starts running work in threads from there.
            ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
                name: 'conversation.session.header.actions', id: IDS.coordinate, order: -24, inject: withApi,
            }, CoordinateAction));
            // DSH's new-chat screen hides that header: there, Coordinate sits in the composer's row, and what
            // /coordinate typed there said shows as DSH's banner.
            ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
                name: 'conversation.input.left', id: IDS.start, order: 30, inject: withApi,
            }, StartCoordinating));
            ctx.effect(() => projects.followCommands(), 'coordinator: /coordinate on the new-chat screen');
            ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
                name: 'conversation.chat.turnTail', id: IDS.cards, order: 30, inject: withApi,
            }, ThreadCards));
            // A turn's trigger: DSH's keyed node, shadowed one priority ahead (the lowest renders). The plugin's
            // own messages get a notice that names them; every other trigger renders through DSH's own view.
            const dshTrigger = () => ctx.slots.entries('conversation.chat.node')
                .find((entry) => entry.options?.key === 'turn-trigger' && entry.component !== TriggerNotice)?.component;
            ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
                name: 'conversation.chat.node', key: 'turn-trigger', priority: -1, locale: 'chat', inject: () => ({ dshTrigger }),
            }, TriggerNotice));
            ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
                name: 'sidebar.session.row.leading', id: IDS.mark, order: 20, inject: withApi,
            }, ThreadMark));
            // Threads under the chat that started them in the session list: a mark inside each row, read by CSS.
            ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
                name: 'sidebar.workspaces.session.row.action', id: IDS.place, order: 900, inject: withApi,
            }, RowPlace));
            ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
                name: 'conversation.input.dock', id: IDS.paused, order: 15, inject: withApi,
            }, PausedBar));
            ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
                name: 'conversation.input.dock', id: IDS.ending, order: 16, inject: withApi,
            }, EndingBar));
            ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
                name: 'sidebar.session.row.hover', id: IDS.hover, order: 20, inject: withApi,
            }, ThreadHover));
            ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
                name: 'sidebar.workspaces.session.menu.item', id: IDS.fullItem, order: 50, inject: withApi,
            }, FullViewMenuItem));
            // A thread opened anywhere lands beside its coordinator; from DSH's session list, straight there.
            ctx.effect(() => projects.followRowClicks(), 'coordinator: thread rows open beside their coordinator');
            ctx.effect(() => projects.followOpens(), 'coordinator: threads beside their coordinator');
            // What threads hand back, or need the user for: a mark on their chat's row and a notice wherever the user is.
            ctx.effect(() => projects.followNews(), 'coordinator: news from threads');
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                name: 'shell.overlay', id: IDS.news, inject: withApi,
            }, NewsNotice));
            // DSH's session list: each chat's threads under it, and DSH's own drags kept from pulling them apart.
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                name: 'shell.overlay', id: IDS.sessionList, inject: withApi,
            }, SessionList));
            // The right-sidebar parts: a thread's chat, the Threads pane, thread links from replies, and a thread's Changes.
            ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
                scope.effect(() => scope.resources.register(threadChatResources(scope.sessions)), 'coordinator: thread chat resources');
                scope.effect(() => scope.sidebarRightTabs.register({
                    id: IDS.chat,
                    kind: KINDS.chat,
                    patterns: [`${CHAT_PREFIX}**`],
                    canOpen: (address) => chatSessionOf(address) !== undefined,
                    title: (address) => {
                        const sessionId = chatSessionOf(address);
                        const state = scope.sessions.list.getSnapshot();
                        const value = valueIn(state, sessionId);
                        return (value?.role === 'thread' ? value.thread?.title : undefined) ?? state.byId[sessionId]?.displayTitle ?? TEXT.thread;
                    },
                }), 'coordinator: thread chat tab');
                scope.effect(() => scope.sidebarRightTabs.register({
                    id: IDS.pane,
                    kind: KINDS.pane,
                    title: () => TEXT.threads,
                }), 'coordinator: threads pane');
                scope.effect(() => scope.sidebarRightTabs.register({
                    id: IDS.link,
                    kind: KINDS.link,
                    // `.t*` matches files such as `.tmp` too: canOpen leaves those to DSH's file viewer.
                    patterns: ['dsh-resource://file/session/**/.dsh-thread/*', 'dsh-resource://file/session/*/.t*'],
                    canOpen: (address) => linkTarget(address) !== undefined,
                    title: (address) => `${TEXT.thread} ${linkTarget(address)?.threadId ?? ''}`.trim(),
                }), 'coordinator: thread links');
                scope.effect(() => scope.sidebarRightTabs.register({
                    id: IDS.changes,
                    kind: KINDS.changes,
                    patterns: [`${CHANGES_PREFIX}**`],
                    canOpen: (address) => changesSessionOf(address) !== undefined,
                    title: (address) => `${TEXT.changes} · ${threadTitleIn(scope.sessions.list.getSnapshot(), changesSessionOf(address))}`,
                }), 'coordinator: thread changes');
                scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
                    name: 'sidebar.right.pane.tab', key: IDS.chat, inject: withApi,
                    children: { [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } },
                }, ThreadChatTab));
                scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
                    name: 'sidebar.right.pane.tab.title', key: IDS.chat,
                }, ThreadChatTitle));
                scope.slots.inject(CONVERSATION_SLOT, () => scope.slots.register({ name: CONVERSATION_SLOT }, ThreadConversation));
                scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
                    name: 'sidebar.right.pane.tab', key: IDS.pane, inject: withApi,
                }, ThreadsPane));
                scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
                    name: 'sidebar.right.pane.tab', key: IDS.link, inject: withApi,
                }, ThreadLinkTab));
                scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
                    name: 'sidebar.right.pane.tab', key: IDS.changes, inject: withApi,
                }, ThreadChangesTab));
                scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
                    name: 'sidebar.right.pane.tab.title', key: IDS.changes,
                }, ThreadChangesTitle));
                // Switched off: its tabs in the chat on screen close first, while their kinds are still registered, so
                // none is left saying "Nothing here can view this kind of content yet" (round-1 finding 8). DSH keeps
                // other chats' layouts out of reach; their tabs read that until the plugin is on again.
                scope.effect(() => {
                    const sidebar = ctx.sidebarRight;
                    return () => closeOwnTabs(sidebar);
                }, 'coordinator: close its tabs when switched off');
            });
        }

        /** Close the plugin's own right-sidebar tabs (a thread's chat, the Threads pane, a thread link, Changes) in the chat on screen. */
        function closeOwnTabs(sidebar) {
            const ours = new Set(Object.values(KINDS));
            let onScreen;
            try { onScreen = sidebar?.mounted?.getSnapshot?.(); } catch { onScreen = undefined; }
            if (typeof onScreen !== 'string' || onScreen === '') return 0;
            let tabs;
            try { tabs = sidebar.tabsIn?.(onScreen); } catch { tabs = undefined; }
            let closed = 0;
            for (const tab of Array.isArray(tabs) ? [...tabs] : EMPTY) {
                if (!ours.has(tab?.kind) || typeof tab.id !== 'string') continue;
                try {
                    sidebar.close(tab.id);
                    closed += 1;
                } catch (error) {
                    console.warn(`[coordinator] could not close its tab: ${error?.message ?? error}`);
                }
            }
            return closed;
        }

        // ── DSH's session list ─────────────────────────────────────────────

        /** DSH's workspace list in its sidebar. */
        const SB_TREE = '[data-slot="sidebar.workspaces"] [role="tree"]';

        /** DSH's own drags of session rows, refused with the reason (useSessionDragGuard). */
        const SIDEBAR = {
            threadStays: 'A thread stays with the chat that started it.',
            chatOut: 'A chat can\'t join another chat\'s threads. That chat can message it instead.',
            coordinatorIn: 'A chat with threads can\'t go in among another chat\'s threads.',
            chatStays: 'A chat stays in the folder it started in.',
            coordinatorStays: 'A chat with threads stays in its workspace.',
        };

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
         * The part of DSH's list an element is in: a child of the list (a
         * workspace's section, or anything else drawn there), or of a folder's
         * group in Workspace Tree. null for anything outside the list.
         */
        function sectionAt(tree, el) {
            for (let e = el instanceof Element ? el : null; e && e !== tree; e = e.parentElement) {
                const parent = e.parentElement;
                if (parent === tree || parent?.getAttribute('role') === 'group') return e;
            }
            return null;
        }

        /**
         * Keep the plugin's marks in DSH's list in step with it: the nesting
         * (markNesting, for nestingCss's sheet) with what a screen reader gets
         * from it, the rows in drawn order (readInOrder), the words after the
         * title of each coordinating chat's and thread's row (describeRows), and the rows with unread news
         * (markUnread). DSH redraws rows on its own (a fold, Show more, a
         * session moving up), so this runs again on every change to the list
         * and to the rows' marks, before it is painted, and after every render
         * here. The sheet and the attributes change only when they differ.
         */
        function useNesting(tree) {
            const sheet = React.useRef(null);
            const pass = React.useRef(() => {});
            pass.current = () => {
                if (!tree?.isConnected || !sheet.current) return;
                // Put back if something took it out of the page (it is drawn again from the rows below).
                if (!sheet.current.isConnected) document.head.append(sheet.current);
                const css = nestingCss(markNesting(tree));
                if (sheet.current.textContent !== css) sheet.current.textContent = css;
                readInOrder(tree);
                describeRows(tree);
                markUnread(tree);
            };
            React.useLayoutEffect(() => {
                if (!tree || typeof document === 'undefined') return undefined;
                const style = document.createElement('style');
                // Marked as the coordinator's from the start: DSH gives an unmarked sheet to whichever plugin is
                // starting when it is added, and removes it when that plugin is switched off.
                style.setAttribute('data-plugin', BUNDLE);
                style.setAttribute('data-projects-nest', '');
                document.head.append(style);
                sheet.current = style;
                let busy = false;
                const run = () => {
                    if (busy) return;
                    busy = true;
                    try { pass.current(); } finally { busy = false; }
                };
                run();
                const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(run);
                observer?.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-projects-row', 'data-projects-of', 'data-projects-words', 'data-projects-unread'] });
                return () => {
                    observer?.disconnect();
                    style.remove();
                    sheet.current = null;
                    undoRows(tree);
                };
            }, [tree]);
            React.useLayoutEffect(() => { pass.current(); });
        }

        /**
         * DSH's own drags of session rows, kept from pulling a chat and its
         * threads apart. DSH moves a row among the rows of its workspace; the
         * plugin only watches, and refuses, with the reason, a drop that would
         * take a thread away from its chat, put another chat in among a
         * chat's threads, or move a session to another workspace (its folder
         * is fixed). A refused place shows no drop line and the "no" pointer,
         * and DSH saves nothing: DSH saves the last place it marked when the
         * drag ends, wherever it ends, so the plugin first drops the row on
         * itself, which DSH takes as a drop where it already is.
         * @param read - a ref to {pinned: Set of DSH's pinned session ids, refuse(text)}.
         */
        function useSessionDragGuard(tree, read) {
            React.useEffect(() => {
                if (!tree || typeof document === 'undefined') return undefined;
                let drag = null;
                let replaying = false;
                const rowAt = (el) => (el instanceof Element ? el.closest('[data-row-key^="session:"]') : null);
                const idOf = (row) => row.getAttribute('data-row-key').slice('session:'.length);
                // A row's own section: its wrapper's parent.
                const sectionOfRow = (row) => row?.parentElement?.parentElement ?? null;
                const placeOf = (row) => {
                    const mark = row.querySelector('[data-projects-row]');
                    return { role: mark?.getAttribute('data-projects-row') ?? '', of: mark?.getAttribute('data-projects-of') ?? '' };
                };
                const pinned = (id) => read.current.pinned.has(id);
                const verdict = (el) => {
                    const role = drag.place.role;
                    if (el instanceof Element && tree.contains(el)) {
                        // Anywhere in the list outside the row's own section: another workspace, or what another plugin draws there.
                        const section = sectionAt(tree, el);
                        if (section && section !== drag.section) return role === 'thread' ? SIDEBAR.threadStays : role === 'coordinator' ? SIDEBAR.coordinatorStays : SIDEBAR.chatStays;
                        // A thread onto its own workspace: out from under its chat.
                        if (role === 'thread' && el.closest('[data-row-key^="workspace:"]')) return SIDEBAR.threadStays;
                    }
                    const marker = drag.marker;
                    if (!marker) return null;
                    const groups = sectionGroups(drag.section);
                    if (role === 'thread') {
                        // Below its chat, or among that chat's threads.
                        const own = groups.find((g) => g.coordinator === drag.place.of);
                        return !own || (marker.id === own.coordinator && marker.half === 'after') || own.threads.includes(marker.id) ? null : SIDEBAR.threadStays;
                    }
                    // Onto a coordinating chat's row, or in among its threads.
                    if (marker.project && marker.id !== drag.id && marker.into) return role === 'coordinator' ? SIDEBAR.coordinatorIn : SIDEBAR.chatOut;
                    for (const g of groups) {
                        if (g.coordinator === drag.id) continue;
                        const last = g.threads[g.threads.length - 1];
                        const inside = marker.id === g.coordinator ? marker.half === 'after' : g.threads.includes(marker.id) && !(marker.id === last && marker.half === 'after');
                        if (inside) return role === 'coordinator' ? SIDEBAR.coordinatorIn : SIDEBAR.chatOut;
                    }
                    return null;
                };
                const mark = (refused) => {
                    if (refused) tree.setAttribute('data-projects-refused', '');
                    else tree.removeAttribute('data-projects-refused');
                };
                // A drop on the dragged row itself: DSH then saves nothing, and its drag ends as a drop in place.
                const keep = () => {
                    if (drag.kept || !drag.row.isConnected) return;
                    drag.kept = true;
                    const box = drag.row.getBoundingClientRect();
                    replaying = true;
                    try {
                        drag.row.dispatchEvent(new DragEvent('drop', {
                            bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, dataTransfer: new DataTransfer(),
                        }));
                    } catch { /* no DragEvent: DSH saves its line */ } finally {
                        replaying = false;
                    }
                };
                const onStart = (event) => {
                    if (replaying) return;
                    drag = null;
                    const row = rowAt(event.target);
                    if (!row || !tree.contains(row)) return;
                    const section = sectionOfRow(row);
                    // In one list and search results have no sections: DSH's own.
                    if (sectionWorkspace(section) === null) return;
                    const id = idOf(row);
                    drag = { id, row, section, place: placeOf(row), pinned: pinned(id), marker: null, refusal: null, kept: false };
                };
                const onOver = (event) => {
                    if (!drag || replaying) return;
                    const row = rowAt(event.target);
                    // The rows DSH marks a place on: the same workspace, pinned or not as the dragged one is.
                    if (row && sectionOfRow(row) === drag.section && pinned(idOf(row)) === drag.pinned) {
                        const box = row.getBoundingClientRect();
                        const at = (event.clientY - box.top) / Math.max(1, box.height);
                        const place = placeOf(row);
                        // DSH marks above or below by the row's halves; its middle half is "onto" it.
                        drag.marker = { id: idOf(row), half: at < 0.5 ? 'before' : 'after', into: at >= 0.25 && at < 0.75, project: place.role === 'coordinator' && place.of === idOf(row) };
                    }
                    drag.refusal = verdict(event.target);
                    mark(drag.refusal !== null);
                };
                // After DSH's own handlers, which call every place "move".
                const onOverLate = (event) => {
                    if (drag?.refusal && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
                };
                const onDrop = (event) => {
                    if (!drag || replaying) return;
                    drag.refusal = verdict(event.target);
                    if (drag.refusal === null) return;
                    event.preventDefault();
                    event.stopPropagation();
                    keep();
                };
                const onEnd = () => {
                    if (!drag || replaying) return;
                    const refusal = drag.refusal;
                    if (refusal) keep();
                    mark(false);
                    drag = null;
                    if (refusal) read.current.refuse(refusal);
                };
                document.addEventListener('dragstart', onStart, true);
                document.addEventListener('dragover', onOver, true);
                window.addEventListener('dragover', onOverLate);
                document.addEventListener('drop', onDrop, true);
                document.addEventListener('dragend', onEnd, true);
                return () => {
                    document.removeEventListener('dragstart', onStart, true);
                    document.removeEventListener('dragover', onOver, true);
                    window.removeEventListener('dragover', onOverLate);
                    document.removeEventListener('drop', onDrop, true);
                    document.removeEventListener('dragend', onEnd, true);
                    mark(false);
                };
            }, [tree, read]);
        }

        /**
         * DSH's session list, as the plugin keeps it: each coordinating chat's
         * threads nest under it (useNesting), and DSH's own drags of session
         * rows keep a thread with its chat and another chat out from among
         * its threads (useSessionDragGuard), each refusal said in DSH's banner at the top
         * of the window. Not centered over the list: the list is narrower than
         * any of the reasons, and DSH's banner doesn't keep to the window, so
         * it would cut off the start of the sentence. DSH's rows, its order,
         * its view options and its search stay its own.
         */
        function SessionList({ useWorkspaces = noWorkspaces }) {
            const pinnedIds = useWorkspaces((state) => state.pinnedSessionIds);
            const tree = useSidebarTree();
            const [toast, setToast] = React.useState(null);
            const pinned = React.useMemo(() => new Set(Array.isArray(pinnedIds) ? pinnedIds : EMPTY), [pinnedIds]);
            const refuse = React.useCallback((text) => setToast((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 })), []);
            const read = React.useRef(null);
            read.current = { pinned, refuse };
            useNesting(tree);
            useSessionDragGuard(tree, read);
            if (tree === null || toast === null || typeof document === 'undefined') return null;
            return h(ui.Toast, {
                key: toast.seq, text: toast.text, icon: h(ui.IconInfoOutlineRegular, { size: 16 }), holdMs: 4000,
                onDone: () => setToast((prev) => (prev?.seq === toast.seq ? null : prev)),
            });
        }

        // ── Thread settings ────────────────────────────────────────────────

        const SETTINGS = {
            title: 'Thread settings',
            close: 'Close',
            loading: 'Loading this chat\'s thread settings…',
            unreachable: 'The coordinator plugin didn\'t answer. If it was just updated, restart DSH so the new version loads.',
            retry: 'Try again',
            catalogFailed: 'DSH\'s model list didn\'t load, so the pickers can\'t list models.',
            models: 'Models',
            threads: 'Threads',
            project: 'This chat',
            noThreads: 'No threads yet. Each thread this chat starts shows up here with its model.',
            allResolved: 'Every thread is resolved.',
            pause: 'Pause threads',
            pauseHint: 'New threads and handbacks wait until you resume.',
            own: 'Set for this chat',
            useDefault: 'Use default',
            running: 'Running. A change applies from its next request.',
            resolved: 'Resolved.',
            note: 'Chats that don\'t choose their own thread models or access use the plugin\'s defaults.',
            openDefaults: 'Defaults for all chats',
            access: 'Access',
            threadAccess: 'Thread access',
            yourTools: 'Your tools',
            toolsAsked: 'A thread has only the ones your words for it name.',
            toolsAlways: 'Every thread of this chat has them.',
            toolsAlwaysAll: 'Every thread has them, unless its chat chooses otherwise.',
            noTools: 'None are listed yet, so no thread is kept from any. List your personal and infrastructure tools under guardedTools in this plugin\'s config.',
            threadPermission: 'New threads\' permission',
            threadPermissionHint: 'What each new thread starts on. Running threads keep theirs; change one under Threads.',
            permission: 'Permission',
            notKnown: 'Not known until it runs',
        };
        /** The two values of Your tools, as the controls name them. */
        const TOOL_MODES = [{ value: 'asked', label: 'Only when asked' }, { value: 'always', label: 'Always' }];
        /** Where an inherited access setting comes from, in the pickers' Default rows. */
        const ACCESS_LABELS = { 'plugin default': 'Default access', 'DSH default': 'DSH default' };
        const ACCESS_SOURCE = { 'chat setting': 'Set for this chat', 'plugin default': 'From Default access', 'DSH default': 'Follows DSH' };
        /** DSH's own confirmation copy for Full access, and ours for Always. */
        const RISK = {
            acknowledge: 'I understand the risks and want to continue',
            cancel: 'Cancel',
            fullTitle: 'Enable Full access?',
            fullConfirm: 'Enable Full access',
            threads: 'Full access lets this chat\'s new threads reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the tasks they get.',
            thread: 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
            allThreads: 'Full access lets new threads of every chat that doesn\'t choose its own reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the tasks they get.',
            toolsTitle: 'Give every thread your tools?',
            tools: (names) => `Every thread of this chat can then use ${listText(names)} on its own, even when your words don't ask for them. Only use it when you trust what runs here.`,
            allTools: (names) => `Every thread of chats that don't choose their own can then use ${listText(names)} on its own, even when your words don't ask for them. Only use it when you trust what runs there.`,
            toolsConfirm: 'Use always',
        };
        const SETTING_ROUTES = [
            { id: 'thread', title: 'New threads', hint: 'What each new thread starts on. Running threads keep theirs.', model: 'threadModel', effort: 'threadEffort' },
        ];
        /** Where an inherited value comes from, in the pickers' Default rows and under a row. */
        const SOURCE_LABELS = { 'chat setting': 'This chat', 'plugin default': 'Default models', 'DSH default': 'DSH default' };

        /**
         * Which coordinating chat the dialog shows, if any. Any part of the
         * window opens it with a session id (the chat's or one of its
         * threads'); the dialog part, once its DSH services are there, marks
         * it available so the entry points show.
         */
        function settingsDialog() {
            let snapshot = { target: null, seq: 0, available: false, pick: null };
            const listeners = new Set();
            const set = (next) => {
                snapshot = { ...snapshot, ...next };
                for (const listener of [...listeners]) listener();
            };
            return {
                getSnapshot: () => snapshot,
                subscribe: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                /**
                 * @param options - {pick?: 'thread'|'access'|'thread:<id>'}: open with that model menu
                 *   open (New threads', or one thread's on its own row), or at Access.
                 */
                open(target, options) {
                    const named = typeof options?.pick === 'string' && /^thread:[\w-]+$/.test(options.pick);
                    const pick = named || options?.pick === 'thread' || options?.pick === 'access' ? options.pick : null;
                    if (typeof target === 'string' && target !== '' && snapshot.available) set({ target, seq: snapshot.seq + 1, pick });
                },
                close() {
                    if (snapshot.target !== null) set({ target: null });
                },
                connect() {
                    set({ available: true });
                    return () => set({ available: false, target: null, pick: null });
                },
            };
        }
        const useSettingsAvailable = (dialog) => React.useSyncExternalStore(dialog.subscribe, () => dialog.getSnapshot().available);

        /**
         * The plugin's endpoints (remote.js) over the window's own connection,
         * with DSH's model catalog.
         * @param connectionOf - DSH's `connection` service, or undefined until DSH provides it.
         */
        function hostLink(connectionOf, catalog) {
            return {
                catalog,
                async call(method, args) {
                    try {
                        const connection = connectionOf();
                        if (!connection) throw new Error('the window is not connected to DSH yet');
                        const result = await connection.rpc.call('/api', `${BUNDLE}/${method}`, { args });
                        if (isObject(result) && (result.ok === true || (result.ok === false && isObject(result.error)))) return result;
                        return { ok: false, error: { code: 'projects/unreadable', message: 'The plugin sent an answer this window can\'t read.' } };
                    } catch (error) {
                        return { ok: false, error: { code: 'projects/unreachable', message: String(error?.message ?? error) } };
                    }
                },
            };
        }

        /** A folder's own name from its path ("storefront" from "/work/storefront/"). */
        function folderName(path) {
            const parts = String(path).split(/[\\/]+/).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : String(path);
        }

        /** A failed call as one sentence: the plugin's own refusal, or that it can't be reached. */
        function errorText(error) {
            const code = String(error?.code ?? '');
            const message = String(error?.message ?? '').trim();
            if (code === 'coordinator/refused' && message) return `${message.replace(/^./, (c) => c.toUpperCase())}${/[.!?]$/.test(message) ? '' : '.'}`;
            if (code === 'projects/unreachable' || code.startsWith('gateway/not') || code.startsWith('rpc/')) return SETTINGS.unreachable;
            return message ? `The change didn't go through: ${message}` : SETTINGS.unreachable;
        }

        /** The parts of a change's notes worth showing: a dropped effort, or a model that could not be set. */
        function noteText(notes) {
            const parts = [];
            for (const note of Array.isArray(notes) ? notes : []) {
                if (typeof note !== 'string') continue;
                for (const part of note.replace(/^t\d+: /, '').split(/; |(?<=\.) /)) {
                    // Efforts a model can't use show on the row itself (effortNote), so only failures are told here.
                    if (/could not/.test(part)) parts.push(part.replace(/^but the /, 'The ').replace(/\.?$/, '.'));
                }
            }
            return parts.join(' ');
        }

        /**
         * DSH's own confirmation before a riskier setting takes effect.
         * `ask(copy, then)` shows it (copy: {title, description, confirm}) and
         * runs `then` once confirmed; `element` goes in the tree. Without
         * DSH's RiskConfirmation, `then` runs at once. Once it closes, focus
         * goes back to `restore()` (the control it came from) if nothing has it.
         */
        function useRiskGate(restore) {
            const [pending, setPending] = React.useState(null);
            const [acknowledged, setAcknowledged] = React.useState(false);
            const refocus = () => {
                if (typeof restore !== 'function' || typeof document === 'undefined') return;
                // DSH's dialog hands focus back to what had it when it opened: a menu item that is gone by
                // then, so the page would have it. The control can be busy for a moment after a change.
                const again = () => {
                    const active = document.activeElement;
                    if (!active || active === document.body) restore()?.focus?.();
                };
                for (const ms of [0, 120, 400, 1000]) setTimeout(again, ms);
            };
            const close = () => { setPending(null); setAcknowledged(false); refocus(); };
            const ask = (copy, then) => {
                if (!ui.RiskConfirmation) { then(); return; }
                setAcknowledged(false);
                setPending({ ...copy, then });
            };
            const element = pending ? h(ui.RiskConfirmation, {
                open: true, title: pending.title, description: pending.description, confirmLabel: pending.confirm,
                acknowledgeLabel: RISK.acknowledge, cancelLabel: RISK.cancel, closeLabel: SETTINGS.close,
                acknowledged, onAcknowledgedChange: setAcknowledged, onCancel: close,
                onConfirm: () => { const { then } = pending; close(); then(); },
            }) : null;
            return { ask, element };
        }

        /**
         * A permission control in the shape of DSH's own access chip: the
         * preset's icon and name, opening a menu of the presets DSH offers.
         * With `fallback` the menu starts with Default, which hands the choice
         * back to what the setting inherits; with `dshDefault` it offers DSH's
         * default for new sessions as a value of its own. A pick that ends in
         * Full access asks first, as DSH does.
         * @param props.value - the value in force: a preset name, or "default" for DSH's default.
         * @param props.own - whether it is set at this level, so Default is not checked.
         * @param props.fallback - {value, label}: what Default means, or undefined.
         * @param props.catalog - the permissions DSH offers ({options, defaultPreset}).
         * @param props.risk - what the Full access confirmation says.
         * @param props.compact - only the icon; the name is in its label and tooltip.
         * @param props.onPick - called with a preset name, "default", or null for Default.
         */
        function PermissionPicker({ id, label, catalog, value, own = true, fallback, dshDefault = false, risk, compact = false, busy = false, disabled = false, onPick }) {
            const [open, setOpen] = React.useState(false);
            const triggerRef = React.useRef(null);
            const gate = useRiskGate(() => triggerRef.current);
            React.useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
            const options = Array.isArray(catalog?.options) ? catalog.options.filter((o) => isObject(o) && typeof o.value === 'string') : EMPTY;
            const shown = permissionShown(value, catalog);
            const base = fallback ? permissionShown(fallback.value, catalog) : undefined;
            const dsh = permissionShown('default', catalog);
            const optionLabel = (name, detail) => (detail ? h('span', { className: 'dshp-pp-opt' }, h('span', { className: 'dshp-pp-opt-name' }, name), h('span', { className: 'dshp-pp-opt-detail' }, detail)) : name);
            const items = [
                ...(base ? [{ id: '@default', label: optionLabel('Default', [fallback.label, base.name].filter(Boolean).join(' · ')), icon: permissionGlyph(base.preset) }, { type: 'separator', id: '@sep' }] : []),
                ...(dshDefault || (own && value === 'default') ? [{ id: 'default', label: optionLabel('DSH default', dsh.preset ? dsh.name : undefined), icon: permissionGlyph(dsh.preset) }] : []),
                ...options.map((o) => ({ id: o.value, label: permissionName(o.value, catalog), icon: permissionGlyph(o.value) })),
            ];
            const selected = fallback && !own ? '@default' : value;
            const choose = (next) => {
                setOpen(false);
                if (next === selected) return;
                const pick = next === '@default' ? null : next;
                const ends = pick === null ? base?.preset : permissionShown(pick, catalog).preset;
                const run = () => onPick(pick);
                if (ends === FULL_ACCESS && shown.preset !== FULL_ACCESS && risk) gate.ask({ title: RISK.fullTitle, description: risk, confirm: RISK.fullConfirm }, run);
                else run();
            };
            const name = shown.name ?? SETTINGS.notKnown;
            const description = options.find((o) => o.value === shown.preset)?.description;
            const trigger = h('button', {
                ref: triggerRef, type: 'button', id, className: compact ? 'dshp-mp-trigger dshp-pp-trigger dshp-pp-compact' : 'dshp-mp-trigger dshp-pp-trigger',
                disabled: disabled || options.length === 0, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-busy': busy || undefined,
                'aria-label': `${label}: ${name}`, title: compact ? `${SETTINGS.permission}: ${name}` : description ?? name,
                'data-projects-permission-picker': id, 'data-projects-permission': shown.preset ?? '',
                onClick: () => setOpen((was) => !was),
            },
            permissionGlyph(shown.preset ?? 'unknown'),
            compact ? null : h('span', { className: 'dshp-mp-name' }, name),
            busy ? h(ui.StateDot, { state: 'ongoing' }) : h(ui.IconChevronDownOutlineRegular, { size: 12, className: open ? 'dshp-mp-chev dshp-mp-chev-open' : 'dshp-mp-chev' }));
            return h('span', { className: 'dshp-pp' },
                h(ui.Menu, {
                    open, items, selectedId: selected, onSelect: choose, onClose: () => setOpen(false),
                    align: 'end', portal: true, anchor: trigger, listClassName: 'dshp-pp-menu',
                }),
                gate.element);
        }

        /**
         * Your tools: Only when asked or Always, as DSH's segmented control.
         * Always asks first, naming the tools it hands over.
         * @param props.names - the user's tools (guardedTools names).
         * @param props.risk - (names) => what the confirmation says.
         */
        function ToolsControl({ id, value, names, risk, disabled = false, onPick }) {
            const box = React.useRef(null);
            const gate = useRiskGate(() => box.current?.querySelector('[aria-selected="true"],[aria-pressed="true"]') ?? box.current?.querySelector('button'));
            const choose = (next) => {
                if (next === value) return;
                if (next === 'always' && names.length > 0) gate.ask({ title: RISK.toolsTitle, description: risk(names), confirm: RISK.toolsConfirm }, () => onPick(next));
                else onPick(next);
            };
            const control = ui.SegmentedControl
                ? h(ui.SegmentedControl, { id, label: SETTINGS.yourTools, value, options: TOOL_MODES, disabled, onChange: choose })
                : h('span', { className: 'dshp-tools-pair', role: 'group', 'aria-label': SETTINGS.yourTools },
                    ...TOOL_MODES.map((mode) => h('button', { key: mode.value, type: 'button', 'aria-pressed': value === mode.value, disabled, onClick: () => choose(mode.value) }, mode.label)));
            return h('span', { ref: box, className: 'dshp-tools-control', 'data-projects-your-tools': value }, control, gate.element);
        }

        /** The user's tools by name, as DSH's quiet tags. */
        function ToolNames({ names }) {
            return h('span', { className: 'dshp-tool-names', 'data-projects-guarded': '' },
                ...names.map((name) => (ui.Tag ? h(ui.Tag, { key: name, tone: 'neutral' }, name) : h('span', { key: name, className: 'dshp-tool-name' }, name))));
        }

        function SettingRow({ id, lead, title, description, source, note, control, message }) {
            return h('div', { className: 'dshp-ps-row', 'data-projects-setting': id },
                h('div', { className: 'dshp-ps-text' },
                    h('div', { className: 'dshp-ps-title' },
                        lead ?? null,
                        h('span', null, title)),
                    description ? h('div', { className: 'dshp-ps-desc' }, description) : null,
                    source ? h('div', { className: 'dshp-ps-source' }, ...source) : null,
                    note ? h('div', { className: 'dshp-ps-fit', 'data-projects-setting-note': '' }, note) : null),
                control,
                message ? h('p', {
                    className: `dshp-ps-alert ${message.kind === 'error' ? 'dshp-ps-error' : 'dshp-ps-info'}`,
                    role: message.kind === 'error' ? 'alert' : 'status',
                }, message.text) : null);
        }

        function Section({ id, heading, meta, children }) {
            return h('section', { className: 'dshp-ps-section', 'data-projects-settings-section': id },
                h('div', { className: 'dshp-ps-head' },
                    h('h3', { className: 'dshp-ps-heading' }, heading),
                    meta ? h('span', { className: 'dshp-ps-count' }, meta) : null),
                h('div', { className: 'dshp-ps-card' }, children));
        }

        /** Stands in for DSH's session store where a slot doesn't get one: nothing known. */
        const noSessions = (select) => select({});

        /**
         * One coordinating chat's thread settings: pause, new threads' model
         * and effort, access (the user's tools, new threads' permission), and
         * each thread's. Every change goes to the plugin at once, like DSH's
         * own settings, and the dialog shows what the plugin then holds; it
         * reads again every few seconds, so a change asked for in the chat
         * shows up too.
         */
        function ThreadSettings({ target, pick, link, facts, dialog, openDefaults, useSessionStatus, useSessions = noSessions }) {
            const catalog = React.useSyncExternalStore(link.catalog.subscribe, link.catalog.getSnapshot);
            const statuses = useSessionStatus((value) => value);
            const [data, setData] = React.useState(null);
            const [failure, setFailure] = React.useState(null);
            const [busy, setBusy] = React.useState(null);
            const [message, setMessage] = React.useState(null);
            const [showResolved, setShowResolved] = React.useState(false);
            const reads = React.useRef(0);
            const alive = React.useRef(true);
            React.useEffect(() => () => { alive.current = false; }, []);
            // Each thread's dot says what the Threads menu says, a failed or stopped last turn included.
            const threadSessions = React.useMemo(() => openSessions(Array.isArray(data?.threads)
                ? data.threads.map((t) => (isObject(t) ? { ...t, resolved: t.resolved === true } : t)) : EMPTY), [data?.threads]);
            const endings = useEndings(useSessions, threadSessions);
            const read = React.useCallback(async () => {
                const seq = ++reads.current;
                const result = await link.call('describe', { target });
                if (!alive.current || seq !== reads.current) return;
                if (result.ok && isObject(result.value) && isObject(result.value.settings)) {
                    setData(result.value);
                    setFailure(null);
                    facts?.put(target, result.value);
                } else {
                    setFailure(errorText(result.ok ? undefined : result.error));
                }
            }, [link, target]);
            React.useEffect(() => {
                link.catalog.load();
                void read();
                const timer = setInterval(() => {
                    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void read();
                }, 8000);
                return () => clearInterval(timer);
            }, [link, read]);

            const change = async (key, changes) => {
                setBusy(key);
                setMessage(null);
                // A read already on its way would show the values from before the change.
                reads.current += 1;
                const result = await link.call('update', { target, changes });
                if (!alive.current) return;
                setBusy(null);
                if (!result.ok) {
                    setMessage({ key, kind: 'error', text: errorText(result.error) });
                    return false;
                }
                if (isObject(result.value) && isObject(result.value.settings)) {
                    setData(result.value);
                    // The other views (the pause bar, the menu, the session list) show the change at once.
                    facts?.put(target, result.value);
                }
                const note = noteText(result.value?.notes);
                if (note) setMessage({ key, kind: 'info', text: note });
                return true;
            };
            const messageFor = (key) => (message?.key === key ? message : null);
            // Opened at one thread (Model and permission… in its row's ⋯): its row in view, a resolved one shown,
            // then its model menu open (placed where the row is once in view, below it when there's room).
            const atThread = typeof pick === 'string' && pick.startsWith('thread:') ? pick : null;
            const shownThread = React.useRef(false);
            const [threadInView, setThreadInView] = React.useState(null);
            React.useEffect(() => {
                if (atThread === null || data === null || shownThread.current || typeof document === 'undefined') return;
                shownThread.current = true;
                const id = atThread.slice('thread:'.length);
                if (Array.isArray(data.threads) && data.threads.some((t) => t?.id === id && t.resolved === true)) setShowResolved(true);
                const show = () => {
                    document.querySelector(`[data-projects-setting="${atThread}"]`)?.scrollIntoView?.({ block: 'center' });
                    setThreadInView(atThread);
                };
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(show);
                else show();
            }, [atThread, data]);
            // Opened at Access (the Access row of the Threads menu or pane): that section, its first control focused.
            const shownAccess = React.useRef(false);
            React.useEffect(() => {
                if (pick !== 'access' || data === null || shownAccess.current || typeof document === 'undefined') return;
                shownAccess.current = true;
                const section = document.querySelector('[data-projects-settings-section="access"]');
                section?.scrollIntoView?.({ block: 'start' });
                section?.querySelector?.('[role=tab][aria-selected=true],button:not(:disabled)')?.focus?.();
            }, [pick, data]);

            let body;
            if (data === null) {
                body = failure
                    ? h('div', { className: 'dshp-ps-state dshp-ps-error', role: 'alert' }, failure,
                        h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { setFailure(null); void read(); } }, SETTINGS.retry))
                    : h('div', { className: 'dshp-ps-state', role: 'status' }, SETTINGS.loading);
            } else {
                const disabled = busy !== null;
                const cv = catalogView(catalog.value);
                const notesFor = (shown, live, ownEffort = true) => [effortNote(cv, shown, ownEffort), liveNote(cv, shown, live)].filter(Boolean).join(' ') || undefined;
                const routeRow = (route) => {
                    const m = data.settings[route.model] ?? {};
                    const e = data.settings[route.effort] ?? {};
                    const shown = resolveRoute(cv, m.value ?? undefined, e.value ?? undefined);
                    const own = { model: m.source === 'chat setting', effort: e.source === 'chat setting' };
                    const reset = { ...(own.model ? { [route.model]: null } : {}), ...(own.effort ? { [route.effort]: null } : {}) };
                    const source = own.model || own.effort
                        ? [h('span', { key: 'own', className: 'dshp-ps-own' }, SETTINGS.own),
                            h('button', { key: 'reset', type: 'button', className: 'dshp-ps-link', disabled, onClick: () => change(route.id, reset) }, SETTINGS.useDefault)]
                        : [h('span', { key: 'from' }, sourceLine(m, levelsOf(shown) ? e : undefined, { long: true }))];
                    return h(SettingRow, {
                        key: route.id, id: route.id, title: route.title, description: route.hint, source, message: messageFor(route.id),
                        note: notesFor(shown, undefined, own.effort),
                        control: h(ModelPicker, {
                            id: `dshp-ps-${route.id}`, label: route.title, catalog: catalog.value, busy: busy === route.id, disabled,
                            value: { model: m.value, effort: e.value }, own, autoOpen: pick === route.id,
                            fallback: {
                                model: m.inherited?.value, effort: e.inherited?.value,
                                modelLabel: SOURCE_LABELS[m.inherited?.source], effortLabel: SOURCE_LABELS[e.inherited?.source],
                            },
                            onPick: (pick) => change(route.id, {
                                ...(pick.model !== undefined ? { [route.model]: pick.model } : {}),
                                ...(pick.effort !== undefined ? { [route.effort]: pick.effort } : {}),
                            }),
                        }),
                    });
                };
                // Access: the user's tools for threads, and where new threads can write.
                const perms = isObject(data.permissions) && Array.isArray(data.permissions.options) && data.permissions.options.length > 0 ? data.permissions : null;
                const guarded = Array.isArray(data.guarded) ? data.guarded.filter((name) => typeof name === 'string' && name !== '') : [];
                const access = isObject(data.access) ? data.access : {};
                const accessSource = (key) => (access[key]?.source === 'chat setting'
                    ? [h('span', { key: 'own', className: 'dshp-ps-own' }, SETTINGS.own),
                        h('button', { key: 'reset', type: 'button', className: 'dshp-ps-link', disabled, onClick: () => change(key, { [key]: null }) }, SETTINGS.useDefault)]
                    : [h('span', { key: 'from' }, ACCESS_SOURCE[access[key]?.source] ?? '')]);
                const tools = access.yourTools?.value === 'always' ? 'always' : 'asked';
                const toolsRow = h(SettingRow, {
                    key: 'yourTools', id: 'yourTools', title: SETTINGS.yourTools, message: messageFor('yourTools'),
                    description: guarded.length === 0 ? SETTINGS.noTools : tools === 'always' ? SETTINGS.toolsAlways : SETTINGS.toolsAsked,
                    source: accessSource('yourTools'),
                    note: guarded.length > 0 ? h(ToolNames, { names: guarded }) : undefined,
                    control: h(ToolsControl, { id: 'dshp-ps-your-tools', value: tools, names: guarded, risk: RISK.tools, disabled, onPick: (next) => change('yourTools', { yourTools: next }) }),
                });
                const permissionRow = (key, title, hint, risk) => {
                    const a = access[key] ?? {};
                    return h(SettingRow, {
                        key, id: key, title, description: hint, source: accessSource(key), message: messageFor(key),
                        control: h(PermissionPicker, {
                            id: `dshp-ps-${key}`, label: title, catalog: perms, value: a.value, own: a.source === 'chat setting', risk, busy: busy === key, disabled,
                            fallback: { value: a.inherited?.value, label: ACCESS_LABELS[a.inherited?.source] },
                            onPick: (next) => change(key, { [key]: next }),
                        }),
                    });
                };
                const threads = Array.isArray(data.threads) ? data.threads.filter((t) => isObject(t) && typeof t.id === 'string') : [];
                const open = threads.filter((t) => !t.resolved);
                const resolved = threads.filter((t) => t.resolved);
                const named = threadNames(threads);
                const threadRowFor = (t) => {
                    const key = `thread:${t.id}`;
                    const name = named.get(t.id);
                    const status = typeof t.session === 'string' ? statuses?.get?.(t.session) : undefined;
                    const running = status?.running === true;
                    // The same states as the Threads menu.
                    const { dot } = rowState({
                        resolved: t.resolved === true, running, pending: status?.pendingInteraction ?? undefined,
                        hb: typeof t.handback === 'string' ? { status: t.handback } : undefined,
                        ending: typeof t.session === 'string' ? endings[t.session] : undefined,
                    });
                    // Where it can write and which of the user's tools it has, in words; the picker beside the model changes the first.
                    const permission = typeof t.permission === 'string' ? t.permission : undefined;
                    const reach = joined([perms && permission ? permissionName(permission, perms) : null, guarded.length > 0 ? toolsWords(t.tools) : null]);
                    return h(SettingRow, {
                        key, id: key, title: name, message: messageFor(key),
                        note: notesFor(resolveRoute(cv, t.model ?? undefined, t.effort ?? undefined), t.live),
                        lead: h('span', { className: 'dshp-ps-dot' }, h(ui.StateDot, { state: dot })),
                        description: t.resolved ? SETTINGS.resolved : running ? SETTINGS.running : undefined,
                        source: reach.length > 0 ? [h('span', { key: 'reach', className: 'dshp-ps-reach', 'data-projects-thread-access': permission ?? '' },
                            perms && permission ? permissionGlyph(permission, 12) : null, h('span', null, ...reach))] : undefined,
                        control: h('div', { className: 'dshp-ps-controls' },
                            h(ModelPicker, {
                                id: `dshp-ps-${t.id}`, label: name, catalog: catalog.value, busy: busy === key, disabled,
                                value: { model: t.model ?? undefined, effort: t.effort ?? undefined }, own: { model: true, effort: true }, autoOpen: threadInView === key,
                                onPick: (pick) => change(key, { thread: t.id, ...pick }),
                            }),
                            perms && !t.resolved && typeof t.session === 'string' ? h(PermissionPicker, {
                                id: `dshp-ps-${t.id}-permission`, label: `${name}: ${SETTINGS.permission}`, catalog: perms, value: permission, compact: true,
                                risk: RISK.thread, disabled, onPick: (next) => change(key, { thread: t.id, permission: next }),
                            }) : null),
                    });
                };
                const shown = showResolved ? [...open, ...resolved] : open;
                body = [
                    catalog.status === 'failed' && !catalog.value ? h('p', { key: 'catalog', className: 'dshp-ps-alert dshp-ps-info', role: 'status' }, SETTINGS.catalogFailed, ' ',
                        h('button', { type: 'button', className: 'dshp-ps-link', onClick: () => link.catalog.load() }, SETTINGS.retry)) : null,
                    // Whether this chat's threads run comes first.
                    h(Section, { key: 'project', id: 'project', heading: SETTINGS.project },
                        h(SettingRow, {
                            id: 'paused', title: SETTINGS.pause, description: SETTINGS.pauseHint, message: messageFor('paused'),
                            control: h(ui.Switch, { checked: data.paused?.value === true, label: SETTINGS.pause, disabled, onChange: (next) => change('paused', { paused: next }) }),
                        })),
                    h(Section, { key: 'models', id: 'models', heading: SETTINGS.models }, ...SETTING_ROUTES.map(routeRow)),
                    h(Section, { key: 'access', id: 'access', heading: SETTINGS.access },
                        toolsRow,
                        perms ? permissionRow('threadPermission', SETTINGS.threadPermission, SETTINGS.threadPermissionHint, RISK.threads) : null),
                    h(Section, { key: 'threads', id: 'threads', heading: SETTINGS.threads, meta: threads.length > 0 ? `${open.length} open` : undefined },
                        shown.length === 0 ? h('div', { key: 'empty', className: 'dshp-ps-empty' }, threads.length === 0 ? SETTINGS.noThreads : SETTINGS.allResolved) : null,
                        ...shown.map(threadRowFor),
                        resolved.length > 0 ? h('button', {
                            key: 'more', type: 'button', className: 'dshp-ps-more', 'aria-expanded': showResolved, onClick: () => setShowResolved((value) => !value),
                        }, h(ui.IconChevronRightOutlineRegular, { size: 12 }), `${showResolved ? 'Hide' : 'Show'} ${plural(resolved.length, 'resolved thread')}`) : null),
                    h('p', { key: 'note', className: 'dshp-ps-note' }, SETTINGS.note,
                        openDefaults ? [' ', h('button', {
                            key: 'defaults', type: 'button', className: 'dshp-ps-link', 'data-projects-open-defaults': '',
                            onClick: () => { if (openDefaults()) dialog.close(); },
                        }, SETTINGS.openDefaults)] : null),
                ];
            }
            const project = data?.project;
            return h(ui.Modal, {
                open: true, title: SETTINGS.title, closeLabel: SETTINGS.close, className: 'dshp-ps', contentClassName: 'dshp-ps-content',
                onClose: () => dialog.close(),
                description: project ? h('span', { className: 'dshp-ps-sub', 'data-projects-settings': project.id },
                    h('span', null, h('b', null, project.name)),
                    // The folder by name, as DSH's session list shows it; the whole path on hover.
                    project.workspace ? h('span', { className: 'dshp-ps-path', title: project.workspace, 'data-projects-workspace': project.workspace },
                        ui.IconFolderCloseRegular ? h(ui.IconFolderCloseRegular, { size: 13, 'aria-hidden': true }) : null,
                        h('span', null, folderName(project.workspace))) : null) : undefined,
            }, body);
        }

        /** The dialog in DSH's overlay layer, mounted while a chat's thread settings are open. */
        function ThreadSettingsOverlay({ dialog, link, facts, openDefaults, useSessionStatus, useSessions }) {
            const state = React.useSyncExternalStore(dialog.subscribe, dialog.getSnapshot);
            if (state.target === null) return null;
            return h(ThreadSettings, {
                key: `${state.target}\u0000${state.seq}`, target: state.target, pick: state.pick, link, facts, dialog, useSessionStatus, useSessions,
                openDefaults: openDefaults(false) ? openDefaults : undefined,
            });
        }

        /**
         * The other way to open a thread, in its menu in the session list:
         * "Open in full view" (the thread as the main chat) where a click on
         * its row opens it beside its coordinator, not while it is the main
         * chat; "Open beside its coordinator" where that's turned off.
         */
        function FullViewMenuItem({ sessionId, useMenuOpenState, useSessions, projects }) {
            const [, setMenuOpen] = useMenuOpenState();
            const thread = useSessions((state) => rowPlace(state, sessionId).startsWith('thread:'));
            const beside = useBesidePref();
            if (!thread || (beside && openRow(sessionId))) return null;
            return h(ui.MenuItemButton, {
                icon: h(beside ? ui.IconRightUpOutlineRegular : ui.IconCompareSplitOutlineRegular, {}),
                onSelect: () => {
                    setMenuOpen(false);
                    if (beside) projects.openFull(sessionId);
                    else projects.openPaired(sessionId);
                },
            }, beside ? TEXT.openFull : TEXT.openBeside);
        }

        /** Whether DSH's session list shows this session as the open one. */
        function openRow(sessionId) {
            try {
                return [...document.querySelectorAll('[data-row-key^="session:"][aria-selected="true"]')].some((row) => row.getAttribute('data-row-key') === `session:${sessionId}`);
            } catch {
                return false;
            }
        }

        /** What Rename… from a thread's ⋯ says. */
        const RENAME = Object.freeze({
            title: 'Rename thread',
            label: 'Thread name',
            save: 'Rename',
            cancel: 'Cancel',
            pending: 'Renaming…',
        });

        /**
         * Rename… from a thread's ⋯: which thread is being renamed, through
         * which session (its chat's, or its own). Drawn in DSH's overlay layer
         * (RenameOverlay), so it outlives the menu it came from.
         */
        function renameFlow() {
            let snapshot = { ask: null, seq: 0, available: false };
            const listeners = new Set();
            const set = (next) => {
                snapshot = { ...snapshot, ...next };
                for (const listener of [...listeners]) listener();
            };
            return {
                getSnapshot: () => snapshot,
                subscribe: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                /** @param ask - {target, thread, title}: the thread's chat or the thread itself, the thread's id and its name now. */
                open(ask) {
                    if (!snapshot.available || typeof ask?.target !== 'string' || ask.target === '' || typeof ask.thread !== 'string') return;
                    set({ ask: { target: ask.target, thread: ask.thread, title: typeof ask.title === 'string' ? ask.title : '' }, seq: snapshot.seq + 1 });
                },
                close() {
                    if (snapshot.ask !== null) set({ ask: null });
                },
                connect() {
                    set({ available: true });
                    return () => set({ available: false, ask: null });
                },
            };
        }

        /**
         * The Rename dialog: the thread's name, ready to type over; Enter or
         * Rename saves it through the plugin, which renames its chat in DSH
         * too. A refusal shows in the dialog, which stays open.
         */
        function RenameThread({ ask, flow, facts }) {
            const [name, setName] = React.useState(ask.title);
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState(null);
            const clean = name.replace(/\s+/g, ' ').trim();
            const close = () => { if (!busy) flow.close(); };
            const save = async () => {
                if (busy || clean === '') return;
                if (clean === ask.title.replace(/\s+/g, ' ').trim()) {
                    flow.close();
                    return;
                }
                setBusy(true);
                setError(null);
                let result;
                try {
                    result = await facts.change(ask.target, { thread: ask.thread, title: clean });
                } catch (failure) {
                    result = { ok: false, error: failure };
                }
                setBusy(false);
                if (result?.ok === false) {
                    setError(errorText(result.error));
                    return;
                }
                flow.close();
            };
            return h(ui.Modal, {
                open: true, title: RENAME.title, closeLabel: SETTINGS.close, className: 'dshp-rn', onClose: close,
                footer: h(React.Fragment, null,
                    h(ui.Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: close }, RENAME.cancel),
                    h(ui.Button, { key: 'save', variant: 'primary', disabled: busy || clean === '', onClick: () => { void save(); }, 'data-projects-rename-save': '' }, RENAME.save)),
            },
            h('form', { key: 'form', className: 'dshp-rn-form', onSubmit: (event) => { event.preventDefault(); void save(); } },
                h(ui.Input, {
                    type: 'text', value: name, 'aria-label': RENAME.label, 'data-modal-autofocus': '', 'data-projects-rename-input': '', maxLength: 300,
                    disabled: busy, onChange: (event) => setName(event.target.value), onFocus: (event) => event.target.select?.(),
                })),
            busy ? h('p', { key: 'busy', className: 'dshp-ar-line', role: 'status' }, RENAME.pending) : null,
            error ? h('p', { key: 'error', className: 'dshp-ar-line dshp-ar-error', role: 'alert' }, error) : null);
        }

        /** The Rename dialog in DSH's overlay layer while one is open. */
        function RenameOverlay({ flow, facts }) {
            const state = React.useSyncExternalStore(flow.subscribe, flow.getSnapshot);
            return state.ask === null ? null : h(RenameThread, { key: state.seq, ask: state.ask, flow, facts });
        }

        /** "Thread settings" in the menu of a coordinating chat or a thread in the session list. */
        function SettingsMenuItem({ sessionId, useMenuOpenState, useSessions, dialog }) {
            useKnown();
            const [, setMenuOpen] = useMenuOpenState();
            const placed = useSessions((state) => rowPlace(state, sessionId) !== '');
            if (!placed) return null;
            return h(ui.MenuItemButton, {
                icon: h(ui.IconSlidersTwoOutlineRegular, {}),
                onSelect: () => {
                    setMenuOpen(false);
                    dialog.open(sessionId);
                },
            }, SETTINGS.title);
        }

        function applySettings(ctx, dialog, link, facts, renames) {
            /** DSH's Plugins page, at this plugin; false when this DSH can't open it. Called without `go`, it only asks. */
            const openDefaults = (go = true) => {
                let nav;
                try { nav = ctx.get?.('pluginNavigation'); } catch { nav = undefined; }
                if (!nav || typeof nav.openBundle !== 'function') return false;
                if (!go) return true;
                try { nav.openBundle(BUNDLE); return true; } catch { return false; }
            };
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                name: 'shell.overlay', id: IDS.settings, inject: () => ({ dialog, link, facts, openDefaults }),
            }, ThreadSettingsOverlay));
            ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
                name: 'sidebar.workspaces.session.menu.item', id: IDS.settingsItem, order: 250, inject: () => ({ dialog }),
            }, SettingsMenuItem));
            ctx.effect(() => dialog.connect(), 'coordinator: thread settings');
            if (renames) {
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                    name: 'shell.overlay', id: IDS.rename, inject: () => ({ flow: renames, facts }),
                }, RenameOverlay));
                ctx.effect(() => renames.connect(), 'coordinator: rename');
            }
        }

        /** Required services (cordis inject); each part below waits for its own. */
        const inject = ['slots'];

        function apply(ctx) {
            // The style sheet goes with the plugin: back when it is switched on again, gone when it is off.
            ctx.effect(() => {
                mountStyle();
                return unmountStyle;
            }, 'coordinator: style sheet');
            const dialog = settingsDialog();
            const renames = renameFlow();
            // DSH's services the parts share, once DSH provides them: one model catalog and one link to the plugin.
            const bound = {};
            const bind = (name, then) => (scope) => scope.effect(() => {
                const service = scope[name];
                bound[name] = service;
                then?.();
                return () => { if (bound[name] === service) bound[name] = undefined; };
            }, `coordinator: ${name}`);
            const catalog = catalogSource(() => bound.remote);
            const link = hostLink(() => bound.connection, catalog);
            const facts = projectFacts(link);
            ctx.inject(['remote', 'remote.session'], bind('remote', () => catalog.reset()));
            ctx.inject(['connection'], bind('connection'));
            ctx.inject(['sessions'], (scope) => {
                bind('sessions')(scope);
                // New threads on DSH's default name what the next one runs, after a pick anywhere changes it.
                scope.effect(() => followDefault(scope.sessions, catalog), 'coordinator: DSH default model');
            });
            ctx.inject(['configForms', 'remote', 'remote.session'], (scope) => applyDefaultsForm(scope, { catalog, link }));
            ctx.inject(['connection', 'remote', 'remote.session'], (scope) => applySettings(scope, dialog, link, facts, renames));
            ctx.inject(['sessions', 'uiWorkspace', 'sidebarRight'], (scope) => applyThreads(scope, dialog, { catalog, link, facts, renames }));
        }

        module.exports.inject = inject;
        module.exports.apply = apply;
        // For the plugin's own tests: the pure helpers the views are built on.
        module.exports.internals = {
            withHit, valueIn, takeKnown, projectContext, threadRow, rowsOf, countsOf, summaryText, cardsOf, cardView, resolveLink, linkTarget, chatAddress, chatSessionOf, isThreadRow, ago, rowPlace, sectionGroups, nestingCss, nestedPlaces, nestedOrder, markNesting, readInOrder, describeRows, markUnread, undoRows, rowWords,
            catalogView, catalogSource, picksIn, followDefault, ThreadRow, resolveRoute, effortNote, liveNote, settingsDialog, hostLink, errorText, noteText,
            selectionIn, selectionText, summaryModels, sourceLine, toldText, projectFacts, pausedText, withHeld, holdOf, threadNames, closeOwnTabs,
            changesOf, changesText, lastChange, REVIEW_PREFIX,
            CardChanges, changesOpener, ThreadChangesTab, ThreadChangesTitle, ChangedFile, shownCounts, editsText, fileAddress, readFailure, changesAddress, changesSessionOf, DIFF_LABELS,
            threadMenuItems, rowMenuItems, runThreadItem, ThreadMore, ThreadList, inMoreList, newestRoster, arrowKeys, ThreadFind, findRows, FIND_FROM, ThreadsMenu,
            progressOf, elapsedText, handbackGist, cardDetail, CardDetail, useThreadLive, pendingAsk,
            renameFlow, RenameThread, RenameOverlay, RENAME,
            rowState, endingOf, endingIn, endingReason, endingLine, openSessions, markState, hoverLine, continueError, GROUPS,
            roomFor, besidePref, sectionWorkspace, sectionAt, listText, clockOf, againText, ThreadCard, EndingBar,
            SessionList, SIDEBAR,
            noticeOf, noticeView, TriggerNotice, ProjectNotice,
            permissionName, permissionShown, permissionIn, toolsText, accessOf, accessSummary, PermissionPicker, ToolsControl, ModelsSummary,
            NewsNotice, newsLine, newsDot, ThreadMark, RowPlace, SettingsMenuItem,
            CoordinateAction, canCoordinate, stoppedEmpty, SettingProblems, ThreadSettings, Section, SettingRow, SETTINGS,
            StartCoordinating, startState, isNewChat, commandSaid,
        };
        return module.exports;
    },
});
