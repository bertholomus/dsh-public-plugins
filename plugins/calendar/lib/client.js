/**
 * dsh-plugin-calendar, browser half: the window's side of the user's
 * calendars. Five parts, over one store of what the host half (remote.js)
 * answers:
 *
 * - The Calendar page (CalendarPage), opened from its entry in DSH's
 *   sidebar: Month, Week, Day and Agenda views; a side column with a small
 *   month, the calendars by account (show or hide, rename, color, default,
 *   .ics export and import) and Accounts.
 * - An event's details (EventPopover), the event dialog for a new event or
 *   a change (EventDialog), and the questions a repeating event asks (which
 *   occurrences a change or a delete reaches).
 * - The Accounts dialog (AccountsDialog): each account and how its sync
 *   stands, and adding one: iCloud, Google, Microsoft 365 / Outlook.com /
 *   Exchange Online, Fastmail, Nextcloud, Yahoo and other CalDAV servers, a
 *   subscribed feed, or a calendar kept in DSH.
 * - The Agenda pane beside chats (AgendaPane), in DSH's right sidebar: today
 *   and the next days, the event on now and the next one, with Join for a
 *   call.
 * - Cards in chats for the calendar_* tools (ToolView): the events a call
 *   read, one event, free time, or what a change did, with a way to the
 *   event on the page.
 *
 * Who a change emails is the host's to say. One it says would email people
 * asks the user first, in its words, and Send holds it to the people named;
 * afterwards the window says who was emailed, and whose calendars a change
 * reached without email (Google). A move that would drop part of a series
 * asks first too.
 *
 * Styled to sit on the wallpaper plugin's glass when it is on: the page has
 * no background of its own, its cards follow the wallpaper's public
 * `--wp-blur`, `--wp-tint` and `body.wp-still`, and light or dark follows
 * DSH's `data-ds-dark-theme`. Nothing here reads or writes another plugin's
 * data or DOM, or styles DSH's.
 *
 * Passwords and client secrets go once to the host's endpoints and are never
 * kept here, logged, or stored in the window.
 *
 * Hand-written in the module format DSH serves to the browser, so the plugin
 * needs no build step: the factory gets DSH's module `require` and returns
 * the client plugin (inject + apply).
 *
 * @module dsh-plugin-calendar/client
 */
// DSH serves browser halves in one script; never throw here, or the others stop loading too.
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-calendar',
    factory: (require) => {
        const module = { exports: {} };
        Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const ReactDOM = require('react-dom');
        const ui = require('@deepseek-ai/dsh-client-ui-primitives');
        const h = React.createElement;

        /** The package: its endpoints' namespace. */
        const BUNDLE = 'dsh-plugin-calendar';
        /** The plugin's entries in DSH's slots: the page (and its sidebar entry), and the Agenda pane's tab type. */
        const IDS = {
            page: `${BUNDLE}:page`,
            agenda: `${BUNDLE}:agenda`,
            reminders: `${BUNDLE}:reminders`,
        };
        /** The Agenda pane's tab kind in DSH's right sidebar. */
        const AGENDA_KIND = 'calendar-agenda';
        /** The agent tools (tools.js) whose calls get a card in chats. */
        const TOOL_NAMES = ['calendar_list_calendars', 'calendar_events', 'calendar_search', 'calendar_get_event', 'calendar_free_time',
            'calendar_create_event', 'calendar_update_event', 'calendar_delete_event', 'calendar_respond'];
        /** The colors the host gives calendars (manager.js PALETTE), offered for a calendar's color. */
        const PALETTE = ['#4f7cff', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e54666', '#0090ff', '#ad7f58', '#6e56cf'];
        const VIEWS = ['month', 'week', 'day', 'agenda'];

        const MINUTE = 60_000;
        const HOUR = 3_600_000;
        const DAY = 86_400_000;
        /** The week and day views: pixels per hour. */
        const HOUR_PX = 48;
        /** How far the Agenda view reads at a time, in days. */
        const AGENDA_DAYS = 30;

        // ── Styles ─────────────────────────────────────────────────────────

        /**
         * Every root the plugin draws (the page, the pane, chat cards, and
         * what it portals to <body>: popovers, dialogs, menus, toasts). Its
         * tokens are scoped to these, never to :root.
         */
        const ROOTS = '.dshcal-root,.dshcal-pane,.dshcal-chat,.dshcal-pop,.dshcal-dlg,.dshcal-menu,.dshcal-toast';
        /** Out of sight, still read by screen readers. */
        const HIDDEN = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';
        /** DSH's focus ring colour (DSH hides it after a pointer press, as on its own controls). */
        const RING = 'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))';
        /** One of DSH's colours deepened toward its label colour (DESIGN.md sections 3 and 4). */
        const DEEP = (token, share) => `color-mix(in srgb,var(${token}) ${share}%,var(--dsw-alias-label-primary))`;
        /**
         * Secondary text deepened by the tint: at the default tint (.55) and above its share is as given; below, it falls
         * with the tint (at .3 about half of it), so small secondary text keeps 4.5:1 on thinner glass (DESIGN.md section 3).
         */
        const DEEP_BY_TINT = (token, share) => `color-mix(in srgb,var(${token}) min(${share}%,calc(var(--wp-tint,.55) * ${Math.round((share / 0.55) * 10) / 10}%)),var(--dsw-alias-label-primary))`;
        const GLASS = 'background:var(--cal-glass);-webkit-backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%)';
        const CSS = [
            // Tokens: DSH's own (DESIGN.md section 4), so light and dark follow DSH. Secondary text, the accent and the state
            // colours are deepened toward DSH's label colour, so small text holds 4.5:1 on glass (section 3); the glass
            // grounds are the wallpaper plugin's recipe, dark by default and light where DSH is light.
            `:is(${ROOTS}){--cal-text:var(--dsw-alias-label-primary);--cal-strong:var(--dsw-alias-label-primary);`
                + `--cal-soft:${DEEP_BY_TINT('--dsw-alias-label-secondary', 45)};--cal-meta:${DEEP_BY_TINT('--dsw-alias-label-secondary', 55)};--cal-faint:${DEEP_BY_TINT('--dsw-alias-label-secondary', 65)};`
                + `--cal-accent:${DEEP('--dsw-alias-state-business-primary', 85)};--cal-link:${DEEP('--dsw-alias-link', 50)};--cal-on-accent:var(--dsw-alias-label-primary-inverted);`
                + '--cal-accent-soft:var(--dsw-alias-state-business-tertiary);'
                + `--cal-danger:${DEEP('--dsw-alias-state-error-primary', 75)};--cal-warn:${DEEP('--dsw-alias-state-warn-label', 50)};--cal-ok:${DEEP('--dsw-alias-state-success-primary', 50)};`
                + '--cal-now:var(--dsw-alias-state-error-primary);--cal-line:var(--dsw-alias-border-l2);--cal-line2:var(--dsw-alias-border-l4);'
                + '--cal-hover:var(--dsw-alias-interactive-bg-hover);--cal-press:var(--dsw-alias-interactive-bg-active);--cal-chip-ground:var(--dsw-alias-bg-base);--cal-chip-ring:var(--dsw-alias-border-l2);'
                + '--cal-glass:rgba(14,18,17,var(--wp-tint,.55));--cal-conv:rgba(10,13,12,calc(var(--wp-tint,.55) + .2));--cal-fill:rgba(255,255,255,.04);--cal-shadow:rgba(0,0,0,.45);color-scheme:dark}',
            `body:not([data-ds-dark-theme]) :is(${ROOTS}){--cal-glass:rgba(250,250,246,var(--wp-tint,.55));--cal-conv:rgba(250,250,246,calc(var(--wp-tint,.55) + .2));`
                + '--cal-fill:rgba(20,26,22,.035);--cal-shadow:rgba(20,26,22,.18);color-scheme:light}',
            // Where the system asks for less transparency, the glass goes near-opaque, as DSH's own sidebar does.
            `@media (prefers-reduced-transparency:reduce){:is(${ROOTS}){--cal-glass:rgba(14,18,17,.9);--cal-conv:rgba(10,13,12,.95)}`
                + `body:not([data-ds-dark-theme]) :is(${ROOTS}){--cal-glass:rgba(250,250,246,.9);--cal-conv:rgba(250,250,246,.95)}}`,
            // Keyboard focus on the plugin's own controls (DSH's controls inside keep theirs).
            `:is(button,a,input,select,textarea,[tabindex])[class*="dshcal-"]:focus-visible{outline:2px solid ${RING};outline-offset:2px}`,
            `.dshcal-sr{${HIDDEN}}`,
            '.dshcal-glass{' + GLASS + ';border:1px solid var(--cal-line);border-radius:var(--dsw-radius-lg);box-sizing:border-box}',

            // ── The page: no background of its own, its parts on glass cards.
            '.dshcal-root{position:relative;display:flex;gap:12px;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;padding:12px;overflow:hidden;color:var(--cal-text);font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.45;container:dshcal/inline-size}',
            '[data-platform=darwin] .dshcal-root{padding-top:calc(12px + var(--dsh-frame-top-clearance,0px))}',
            '.dshcal-side{flex:none;display:flex;flex-direction:column;gap:14px;width:244px;min-height:0;padding:12px 10px 10px;overflow:auto;scrollbar-width:thin}',
            '.dshcal-main{position:relative;flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}',
            // The view itself: the wallpaper's tint + .2, as the open conversation has, so its small text stays readable.
            '.dshcal-main.dshcal-glass{background:var(--cal-conv)}',
            // The side column is all small text (the small month, the calendars, Accounts): it sits at tint + .2 too, never
            // on the plain tint, where small text falls under 4.5:1 at a low tint (DESIGN.md section 3).
            '.dshcal-side.dshcal-glass{background:var(--cal-conv)}',
            // The page takes the focus of a click on its empty parts (its keys work from there); it shows no ring for it.
            '.dshcal-root:focus,.dshcal-root[tabindex]:focus-visible{outline:none}',
            '.dshcal-root[data-calendar-dragging],.dshcal-root[data-calendar-dragging] *{cursor:grabbing!important;user-select:none;-webkit-user-select:none}',
            '.dshcal-root[data-calendar-dragging=resize],.dshcal-root[data-calendar-dragging=resize] *{cursor:ns-resize!important}',
            '.dshcal-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 12px;border-bottom:1px solid var(--cal-line)}',
            '.dshcal-head-nav{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 280px}',
            '.dshcal-head-tools{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:8px;min-width:0;margin-left:auto}',
            '.dshcal-title{margin:0 0 0 6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsw-font-l-20-font-size,20px);font-weight:600;line-height:26px;color:var(--cal-strong)}',
            '.dshcal-title-ruler{position:absolute;visibility:hidden;pointer-events:none}',
            // The week's number by the title (under it on a narrow page).
            '.dshcal-titles{display:flex;align-items:center;gap:6px;min-width:0}',
            '.dshcal-wknum{flex:none;font-variant-numeric:tabular-nums}',
            // Search, in the header with the views (the two go to a row of their own when the title needs the room): its own row on a narrow page.
            '.dshcal-search{position:relative;display:flex;align-items:center;flex:0 1 220px;min-width:150px}',
            '.dshcal-search>svg{position:absolute;left:9px;color:var(--cal-meta);pointer-events:none}',
            '.dshcal-search>.dshcal-input{height:30px;padding-left:30px;padding-right:28px}',
            '.dshcal-search>.dshcal-input::-webkit-search-cancel-button{display:none}',
            '.dshcal-search-clear{position:absolute;right:3px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-meta);cursor:pointer}',
            '.dshcal-search-clear:hover{background:var(--cal-hover);color:var(--cal-text)}',
            // A read again that failed, over the events read before.
            '.dshcal-stale{display:flex;align-items:center;gap:8px;min-width:0;padding:5px 12px;border-bottom:1px solid var(--cal-line);background:color-mix(in srgb,var(--cal-warn) 10%,transparent);font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.4;color:var(--cal-text)}',
            '.dshcal-stale>svg{flex:none;color:var(--cal-warn)}',
            '.dshcal-stale>span{flex:1;min-width:0;overflow-wrap:anywhere}',
            '.dshcal-stale>button{flex:none}',
            '.dshcal-body{position:relative;flex:1;display:flex;flex-direction:column;min-height:0}',
            '.dshcal-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;flex:1;padding:40px 20px;text-align:center;color:var(--cal-meta)}',
            '.dshcal-error{color:var(--cal-danger)}',
            '.dshcal-busy{position:absolute;top:0;left:0;right:0;height:2px;overflow:hidden;pointer-events:none}',
            '.dshcal-busy::after{content:"";position:absolute;top:0;bottom:0;width:30%;background:var(--cal-accent);animation:dshcal-slide 1.1s ease-in-out infinite}',
            '@keyframes dshcal-slide{from{left:-30%}to{left:100%}}',
            '@keyframes dshcal-spin{to{transform:rotate(360deg)}}',
            '@keyframes dshcal-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
            '.dshcal-spin{display:inline-flex;animation:dshcal-spin 1s linear infinite}',

            // Buttons, fields and small parts, shared by every surface.
            '.dshcal-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:30px;padding:0 12px;border:1px solid var(--cal-line2);border-radius:var(--dsw-radius-sm);background:var(--cal-fill);color:var(--cal-text);font:inherit;font-size:var(--dsw-font-xs-13-font-size,13px);font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;text-decoration:none}',
            '.dshcal-btn:hover{background:var(--cal-hover)}',
            '.dshcal-btn:active{background:var(--cal-press)}',
            '.dshcal-btn:disabled{opacity:.5;cursor:default}',
            '.dshcal-btn>svg{flex:none}',
            '.dshcal-btn-primary{border-color:transparent;background:var(--cal-accent);color:var(--cal-on-accent)}',
            '.dshcal-btn-primary:hover{background:color-mix(in srgb,var(--cal-accent) 86%,var(--cal-text))}',
            '.dshcal-btn-ghost{border-color:transparent;background:none}',
            '.dshcal-btn-sm{height:26px;padding:0 9px;font-size:var(--dsw-font-xxs-12-font-size,12px);border-radius:var(--dsw-radius-sm)}',
            '.dshcal-btn-icon{width:30px;padding:0}',
            '.dshcal-btn-sm.dshcal-btn-icon{width:26px}',
            '.dshcal-btn-danger{color:var(--cal-danger)}',
            '.dshcal-btn[aria-pressed=true]{background:var(--cal-accent-soft);border-color:color-mix(in srgb,var(--cal-accent) 55%,transparent);color:var(--cal-text)}',
            '.dshcal-link{border:0;padding:0;background:none;color:var(--cal-link);font:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer;overflow-wrap:anywhere}',
            '.dshcal-seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--cal-line2);border-radius:var(--dsw-radius-md);background:var(--cal-fill)}',
            '.dshcal-seg>button{height:24px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-meta);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:500;cursor:pointer}',
            '.dshcal-seg>button:hover{color:var(--cal-text)}',
            '.dshcal-seg>button[aria-checked=true]{background:var(--cal-press);color:var(--cal-text)}',
            '.dshcal-dot{display:inline-block;flex:none;width:9px;height:9px;border-radius:50%;background:var(--dot,var(--cal-accent))}',
            '.dshcal-dot[data-none]{background:none;box-shadow:inset 0 0 0 1.5px var(--cal-meta)}',
            '.dshcal-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--cal-hover);font-size:var(--dsw-font-xxxs-11-font-size,11px);font-weight:500;color:var(--cal-meta);white-space:nowrap}',
            '.dshcal-warn{color:var(--cal-warn)}',
            '.dshcal-meta{color:var(--cal-meta)}',
            '.dshcal-faint{color:var(--cal-faint)}',
            '.dshcal-input,.dshcal-select,.dshcal-textarea{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 10px;border:1px solid var(--cal-line2);border-radius:var(--dsw-radius-sm);background:var(--cal-fill);color:var(--cal-text);font:inherit;font-size:var(--dsw-font-xs-13-font-size,13px)}',
            '.dshcal-textarea{height:auto;min-height:72px;padding:8px 10px;line-height:1.45;resize:vertical}',
            '.dshcal-select{padding-right:6px}',
            '.dshcal-input::placeholder,.dshcal-textarea::placeholder{color:var(--cal-faint)}',
            `.dshcal-input:focus,.dshcal-select:focus,.dshcal-textarea:focus{outline:2px solid ${RING};outline-offset:-1px;border-color:transparent}`,
            '.dshcal-input[aria-invalid=true],.dshcal-select[aria-invalid=true]{border-color:var(--cal-danger)}',
            '.dshcal-select option,.dshcal-select optgroup{background:var(--cal-chip-ground);color:var(--cal-text)}',
            '.dshcal-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--dsw-font-xs-13-font-size,13px)}',
            '.dshcal-check>input{width:15px;height:15px;margin:0;accent-color:var(--cal-accent)}',
            '.dshcal-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
            '.dshcal-field>label,.dshcal-label{font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:500;color:var(--cal-meta)}',
            '.dshcal-hint{font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.45;color:var(--cal-meta)}',
            '.dshcal-tell{display:flex;flex-direction:column;gap:3px;margin-top:4px}',
            '.dshcal-tell>.dshcal-hint{padding-left:23px}',
            '.dshcal-field-error{font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.4;color:var(--cal-danger)}',
            '.dshcal-alert{display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--cal-danger) 14%,transparent);color:var(--cal-text);font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.45}',
            '.dshcal-alert>svg{flex:none;margin-top:2px;color:var(--cal-danger)}',
            '.dshcal-note{display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-radius:var(--dsw-radius-md);background:var(--cal-fill);border:1px solid var(--cal-line);font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.5;color:var(--cal-soft)}',
            '.dshcal-note>svg{flex:none;margin-top:2px}',
            '.dshcal-note>span{flex:1;min-width:0;overflow-wrap:anywhere}',

            // The side column: the small month, the calendars by account.
            '.dshcal-mini{display:flex;flex-direction:column;gap:4px}',
            '.dshcal-mini-head{display:flex;align-items:center;gap:2px;padding:0 2px 2px}',
            '.dshcal-mini-title{flex:1;font-size:var(--dsw-font-xs-13-font-size,13px);font-weight:600;color:var(--cal-strong);padding-left:4px}',
            '.dshcal-mini-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px}',
            '.dshcal-mini-grid[data-week-numbers]{grid-template-columns:20px repeat(7,1fr)}',
            '.dshcal-mini-wk{height:28px;display:flex;align-items:center;justify-content:center;font-size:var(--dsw-font-xxxs-11-font-size,11px);color:var(--cal-meta);font-variant-numeric:tabular-nums}',
            '.dshcal-mini-wd{height:20px;display:flex;align-items:center;justify-content:center;font-size:var(--dsw-font-xxxs-11-font-size,11px);font-weight:600;color:var(--cal-meta);text-transform:uppercase}',
            '.dshcal-mini-day{height:28px;display:flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-text);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);font-variant-numeric:tabular-nums;cursor:pointer}',
            '.dshcal-mini-day:hover{background:var(--cal-hover)}',
            '.dshcal-mini-day[data-out]{color:var(--cal-meta)}',
            '.dshcal-mini-day[data-in-range]{background:var(--cal-accent-soft)}',
            '.dshcal-mini-day[data-today]{color:var(--cal-on-accent);background:var(--cal-accent);font-weight:600}',
            '.dshcal-cals{display:flex;flex-direction:column;gap:12px;min-height:0}',
            '.dshcal-acct-head{display:flex;align-items:center;gap:6px;padding:0 4px 2px;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;letter-spacing:.02em;color:var(--cal-meta);text-transform:uppercase}',
            '.dshcal-acct-head>span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-cal{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 2px 0 6px;border-radius:var(--dsw-radius-sm)}',
            '.dshcal-cal:hover{background:var(--cal-hover)}',
            '.dshcal-cal-toggle{display:flex;align-items:center;gap:9px;flex:1;min-width:0;height:30px;padding:0;border:0;background:none;color:var(--cal-text);font:inherit;font-size:var(--dsw-font-xs-13-font-size,13px);text-align:left;cursor:pointer}',
            '.dshcal-cal-box{flex:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:15px;height:15px;border-radius:var(--dsw-radius-xs);border:2px solid var(--cal-color);background:var(--cal-color);color:var(--cal-color-text)}',
            '.dshcal-cal-toggle[aria-checked=false] .dshcal-cal-box{background:none}',
            '.dshcal-cal-toggle[aria-checked=false] .dshcal-cal-name{color:var(--cal-meta)}',
            '.dshcal-cal-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-cal-more{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-meta);cursor:pointer;opacity:0}',
            '.dshcal-cal:hover .dshcal-cal-more,.dshcal-cal-more:focus-visible,.dshcal-cal-more[aria-expanded=true]{opacity:1}',
            '.dshcal-cal-more:hover{background:var(--cal-press);color:var(--cal-text)}',
            '@media (hover:none){.dshcal-cal-more{opacity:1}}',
            '.dshcal-side-foot{display:flex;flex-direction:column;gap:6px;margin-top:auto;padding-top:6px}',
            '.dshcal-side-foot .dshcal-btn{justify-content:flex-start}',

            // ── Week and Day: a time grid, its all-day row on top.
            '.dshcal-wk{--gutter:56px;display:flex;flex-direction:column;flex:1;min-height:0}',
            '.dshcal-wk-head,.dshcal-wk-allday{display:grid;grid-template-columns:var(--gutter) repeat(var(--days),minmax(0,1fr));overflow:hidden;scrollbar-gutter:stable;flex:none}',
            '.dshcal-wk-head{border-bottom:1px solid var(--cal-line)}',
            '.dshcal-wk-dayhead{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;height:44px;padding:0 4px;border:0;border-left:1px solid var(--cal-line);background:none;color:var(--cal-meta);font:inherit;cursor:pointer}',
            '.dshcal-wk-dayhead:hover{background:var(--cal-hover)}',
            '.dshcal-wk-dayhead span:first-child{font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;text-transform:uppercase;letter-spacing:.03em}',
            '.dshcal-wk-dayhead span:last-child{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 4px;box-sizing:border-box;border-radius:var(--dsw-radius-lg);font-size:var(--dsw-font-base-16-font-size,16px);font-weight:500;color:var(--cal-strong);font-variant-numeric:tabular-nums}',
            '.dshcal-wk-dayhead[data-today] span:first-child{color:var(--cal-link)}',
            '.dshcal-wk-dayhead[data-today] span:last-child{background:var(--cal-accent);color:var(--cal-on-accent)}',
            '.dshcal-wk-allday{border-bottom:1px solid var(--cal-line);max-height:30%;overflow-y:auto}',
            '.dshcal-wk-gutterlabel{display:flex;flex-direction:column;align-items:flex-end;justify-content:flex-start;gap:2px;padding:5px 8px 4px 0;font-size:var(--dsw-font-xxxs-11-font-size,11px);color:var(--cal-faint);white-space:nowrap}',
            '.dshcal-wk-lanes{grid-column:2 / -1;display:grid;grid-template-columns:repeat(var(--days),minmax(0,1fr));grid-template-rows:repeat(var(--lanes),22px);row-gap:2px;padding:3px 0;min-height:22px}',
            '.dshcal-wk-lanecell{grid-row:1 / -1;border:0;border-left:1px solid var(--cal-line);background:none;padding:0;cursor:pointer;min-height:22px}',
            '.dshcal-wk-lanecell:hover{background:var(--cal-fill)}',
            '.dshcal-wk-more{z-index:1;align-self:center;justify-self:start;margin-left:4px;height:20px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-meta);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;cursor:pointer}',
            '.dshcal-wk-more:hover{background:var(--cal-hover);color:var(--cal-text)}',
            '.dshcal-wk-scroll{position:relative;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;scrollbar-width:thin;touch-action:pan-y}',
            '.dshcal-wk-canvas{position:relative;display:grid;grid-template-columns:var(--gutter) repeat(var(--days),minmax(0,1fr));height:calc(24 * var(--hour))}',
            '.dshcal-wk-hours{position:relative}',
            '.dshcal-wk-hour{position:absolute;right:8px;transform:translateY(-50%);font-size:var(--dsw-font-xxxs-11-font-size,11px);color:var(--cal-faint);font-variant-numeric:tabular-nums;white-space:nowrap}',
            '.dshcal-wk-col{position:relative;border-left:1px solid var(--cal-line);background-image:linear-gradient(to bottom,var(--cal-line) 1px,transparent 1px);background-size:100% var(--hour);cursor:cell;user-select:none;-webkit-user-select:none}',
            '.dshcal-wk-col[data-today]{background-color:color-mix(in srgb,var(--cal-accent) 5%,transparent)}',
            '.dshcal-wk-ghost{position:absolute;left:2px;right:4px;z-index:19;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--cal-accent) 30%,transparent);border:1px solid var(--cal-accent);pointer-events:none;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;padding:3px 6px;box-sizing:border-box;color:var(--cal-text)}',
            '.dshcal-now{position:absolute;left:0;right:0;z-index:20;height:2px;margin-top:-1px;background:var(--cal-now);pointer-events:none}',
            '.dshcal-now::before{content:"";position:absolute;left:-5px;top:-4px;width:10px;height:10px;border-radius:50%;background:var(--cal-now)}',

            // An event in the time grid, a bar in the all-day row and the month.
            '.dshcal-ev{position:absolute;z-index:2;display:flex;flex-direction:column;gap:1px;box-sizing:border-box;min-width:0;padding:3px 6px;overflow:hidden;border:0;border-radius:var(--dsw-radius-sm);background:var(--ev);color:var(--ev-text);box-shadow:0 0 0 1px var(--cal-chip-ring);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.3;text-align:left;cursor:pointer}',
            '.dshcal-ev:hover,.dshcal-ev:focus-visible{z-index:5;filter:brightness(1.06)}',
            '.dshcal-ev-more{position:absolute;display:flex;align-items:flex-start;justify-content:center;box-sizing:border-box;min-width:0;padding:3px 2px;border:0;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--cal-text) 9%,var(--cal-chip-ground));color:var(--cal-text);box-shadow:0 0 0 1px var(--cal-line);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:700;cursor:pointer;overflow:hidden}',
            '.dshcal-ev-more:hover,.dshcal-ev-more:focus-visible{z-index:5;background:color-mix(in srgb,var(--cal-text) 15%,var(--cal-chip-ground))}',
            '.dshcal-ev-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--lines,3);overflow-wrap:anywhere}',
            '.dshcal-ev-sub{font-size:var(--dsw-font-xxs-12-font-size,12px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.dshcal-ev[data-nested]{box-shadow:0 0 0 1.5px var(--cal-chip-ground),0 2px 6px var(--cal-shadow)}',
            // A short event on one line: its time beside the title when both fit, else out of sight on the next line (the row gap is taller than the chip).
            '.dshcal-ev[data-short]{flex-flow:row wrap;align-content:flex-start;align-items:baseline;gap:40px 5px;padding-top:1px;padding-bottom:1px}',
            '.dshcal-ev[data-short] .dshcal-ev-title{display:block;min-width:0;max-width:100%;flex:0 1 auto;white-space:nowrap}',
            '.dshcal-ev[data-short] .dshcal-ev-sub{flex:0 0 auto}',
            // Answers and states: invited and not answered (outlined), maybe or free (tinted), declined or cancelled (struck), past (quieter).
            ':is(.dshcal-ev,.dshcal-bar)[data-look=soft]{background:color-mix(in srgb,var(--ev) 24%,var(--cal-chip-ground));color:var(--cal-text);box-shadow:inset 3px 0 0 var(--ev)}',
            ':is(.dshcal-ev,.dshcal-bar)[data-look=outline]{background:var(--cal-chip-ground);color:var(--cal-text);box-shadow:inset 0 0 0 1.5px var(--ev)}',
            ':is(.dshcal-ev,.dshcal-bar)[data-look=struck]{background:color-mix(in srgb,var(--ev) 14%,var(--cal-chip-ground));color:var(--cal-meta);box-shadow:inset 3px 0 0 color-mix(in srgb,var(--ev) 50%,transparent)}',
            ':is(.dshcal-ev,.dshcal-bar)[data-look=struck] :is(.dshcal-ev-title,.dshcal-bar-title){text-decoration:line-through}',
            // An event that has ended fades and stays readable: a solid one takes its calendar's colour mixed into the
            // ground, its words the soft text colour, and a line's dot pales (no opacity on the words).
            ':is(.dshcal-ev,.dshcal-bar)[data-past][data-look=solid]{background:color-mix(in srgb,var(--ev) 36%,var(--cal-chip-ground))}',
            ':is(.dshcal-ev,.dshcal-bar,.dshcal-line)[data-past]:not([data-look=struck]){color:var(--cal-soft)}',
            '.dshcal-line[data-past]>.dshcal-dot{opacity:.5}',
            '.dshcal-bar{position:relative;z-index:1;display:flex;align-items:center;gap:5px;box-sizing:border-box;min-width:0;height:20px;margin:0 3px;padding:0 6px;overflow:hidden;border:0;border-radius:var(--dsw-radius-sm);background:var(--ev);color:var(--ev-text);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:20px;text-align:left;cursor:pointer;white-space:nowrap}',
            '.dshcal-bar:hover,.dshcal-bar:focus-visible{filter:brightness(1.06)}',
            '.dshcal-bar[data-cont-start]{border-top-left-radius:0;border-bottom-left-radius:0;margin-left:0}',
            '.dshcal-bar[data-cont-end]{border-top-right-radius:0;border-bottom-right-radius:0;margin-right:0}',
            '.dshcal-bar-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:600}',
            '.dshcal-bar-time{flex:none;font-size:var(--dsw-font-xxs-12-font-size,12px);opacity:.9;font-variant-numeric:tabular-nums}',
            // A timed event in the month: a dot, its time and title, no fill.
            '.dshcal-line{position:relative;z-index:1;display:flex;align-items:center;gap:4px;box-sizing:border-box;min-width:0;height:20px;margin:0 3px;padding:0 5px;overflow:hidden;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-text);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);text-align:left;cursor:pointer;white-space:nowrap}',
            '.dshcal-line:hover,.dshcal-line:focus-visible{background:var(--cal-hover)}',
            '.dshcal-line>.dshcal-dot{background:var(--ev);width:8px;height:8px}',
            '.dshcal-line-time{flex:none;color:var(--cal-meta);font-size:var(--dsw-font-xxxs-11-font-size,11px);font-variant-numeric:tabular-nums}',
            '.dshcal-line-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
            '.dshcal-line[data-look=struck] .dshcal-line-title{text-decoration:line-through;color:var(--cal-meta)}',
            '.dshcal-line[data-look=outline]>.dshcal-dot{background:none;box-shadow:inset 0 0 0 1.5px var(--ev)}',
            // Dragging: an event to another time or day, its bottom edge to another end; where it goes is shown, it stays faint.
            '.dshcal-ev-grip{position:absolute;left:0;right:0;bottom:0;height:7px;cursor:ns-resize}',
            ':is(.dshcal-ev,.dshcal-bar,.dshcal-line)[data-moving]{opacity:.35}',
            '.dshcal-wk-ghost>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-wk-ghost>span+span{font-weight:500;opacity:.85}',
            '.dshcal-wk-ghost[data-short]{padding-top:1px;padding-bottom:1px}',
            ':is(.dshcal-mo-cell,.dshcal-wk-lanecell)[data-drop]{background:var(--cal-accent-soft);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--cal-accent) 60%,transparent)}',

            // ── Month: weeks of days, bars and lines in lanes.
            // Its columns: the days of a week on show (--cols: 7, or 5 while weekends are hidden), the week's number first when asked for.
            '.dshcal-mo{--wk:28px;display:flex;flex-direction:column;flex:1;min-height:0;container:dshcal-mo/inline-size}',
            // Narrow days: a timed event's title alone, without its time in front.
            '@container dshcal-mo (max-width: 909px){.dshcal-mo:not([data-cols="5"]) .dshcal-line-time{display:none}}',
            '@container dshcal-mo (max-width: 649px){.dshcal-mo .dshcal-line-time{display:none}}',
            '.dshcal-mo-head{display:grid;grid-template-columns:repeat(var(--cols,7),minmax(0,1fr));flex:none;border-bottom:1px solid var(--cal-line)}',
            '.dshcal-mo[data-week-numbers] :is(.dshcal-mo-head,.dshcal-mo-week){grid-template-columns:var(--wk) repeat(var(--cols,7),minmax(0,1fr))}',
            '.dshcal-mo-wk{display:flex;justify-content:center;box-sizing:border-box;min-width:0;padding-top:6px;font-size:var(--dsw-font-xxxs-11-font-size,11px);font-weight:500;line-height:16px;color:var(--cal-meta);font-variant-numeric:tabular-nums;background:var(--cal-fill)}',
            '.dshcal-mo-wd{padding:8px 8px 6px;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;letter-spacing:.03em;color:var(--cal-meta);text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-mo-weeks{flex:1;display:grid;grid-template-rows:repeat(var(--weeks),minmax(0,1fr));min-height:0}',
            '.dshcal-mo-week{position:relative;display:grid;grid-template-columns:repeat(var(--cols,7),minmax(0,1fr));grid-template-rows:28px repeat(var(--lanes),20px) minmax(0,1fr);row-gap:2px;min-height:0;overflow:hidden;border-bottom:1px solid var(--cal-line)}',
            '.dshcal-mo-week:last-child{border-bottom:0}',
            '.dshcal-mo-cell{grid-row:1 / -1;min-width:0;border-left:1px solid var(--cal-line);outline:none;cursor:pointer}',
            '.dshcal-mo-cell:first-child{border-left:0}',
            '.dshcal-mo-cell:hover{background:var(--cal-fill)}',
            '.dshcal-mo-cell[data-out]{background:color-mix(in srgb,var(--cal-text) 2.5%,transparent)}',
            '.dshcal-mo-cell:focus-visible{box-shadow:inset 0 0 0 2px var(--cal-accent)}',
            '.dshcal-mo-num{grid-row:1;z-index:1;justify-self:start;align-self:center;display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;margin-left:5px;padding:0 5px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-md);background:none;color:var(--cal-strong);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:500;font-variant-numeric:tabular-nums;cursor:pointer}',
            '.dshcal-mo-num:hover{background:var(--cal-hover)}',
            '.dshcal-mo-num[data-out]{color:var(--cal-faint)}',
            '.dshcal-mo-num[data-today]{background:var(--cal-accent);color:var(--cal-on-accent);font-weight:600}',
            '.dshcal-mo-more{z-index:1;align-self:center;justify-self:start;height:20px;margin:0 3px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-meta);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;cursor:pointer;white-space:nowrap;overflow:hidden;max-width:calc(100% - 6px);text-overflow:ellipsis}',
            '.dshcal-mo-more:hover{background:var(--cal-hover);color:var(--cal-text)}',

            // ── Agenda: the coming events by day.
            '.dshcal-ag{flex:1;min-height:0;overflow:auto;padding:6px 6px 16px;scrollbar-width:thin}',
            '.dshcal-ag-day{display:grid;grid-template-columns:96px minmax(0,1fr);gap:0 12px;padding:10px 8px;border-bottom:1px solid var(--cal-line)}',
            '.dshcal-ag-date{display:flex;align-items:baseline;gap:7px;padding-top:5px;color:var(--cal-meta)}',
            '.dshcal-ag-date b{font-size:var(--dsw-font-l-20-font-size,20px);font-weight:600;color:var(--cal-strong);font-variant-numeric:tabular-nums}',
            '.dshcal-ag-date[data-today] b{color:var(--cal-link)}',
            '.dshcal-ag-date span{font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;text-transform:uppercase;letter-spacing:.03em}',
            '.dshcal-ag-list{display:flex;flex-direction:column;gap:2px;min-width:0}',
            '.dshcal-ag-row{display:grid;grid-template-columns:minmax(118px,auto) minmax(0,1fr);align-items:baseline;gap:12px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-text);font:inherit;text-align:left;cursor:pointer}',
            '.dshcal-ag-row:hover{background:var(--cal-hover)}',
            '.dshcal-ag-time{display:flex;align-items:center;gap:8px;font-size:var(--dsw-font-xs-13-font-size,13px);color:var(--cal-meta);font-variant-numeric:tabular-nums;white-space:nowrap}',
            '.dshcal-ag-time>.dshcal-dot{background:var(--ev)}',
            '.dshcal-ag-what{display:flex;flex-direction:column;min-width:0}',
            '.dshcal-ag-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-ag-sub{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-ag-row[data-look=struck] .dshcal-ag-title{text-decoration:line-through;color:var(--cal-meta)}',
            '.dshcal-ag-foot{display:flex;justify-content:center;padding:14px}',
            // Search results: how many, and where the earlier ones start.
            '.dshcal-ag-part{padding:12px 8px 4px;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;letter-spacing:.03em;color:var(--cal-meta);text-transform:uppercase}',
            '.dshcal-ag-part:first-child{padding-top:6px}',

            // ── Popovers (an event's details, a day's events): fixed, portaled, in DSH's menu material at its level for menus and hover cards.
            '.dshcal-pop{position:fixed;z-index:100;box-sizing:border-box;width:min(360px,calc(100vw - 24px));max-height:min(620px,calc(100vh - 24px));overflow:auto;padding:14px 14px 12px;'
                + 'background:var(--dsw-specific-menu);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);backdrop-filter:var(--dsw-menu-backdrop-filter);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent);'
                + 'color:var(--cal-text);font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.45;animation:dshcal-in var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));scrollbar-width:thin}',
            '.dshcal-pop:focus{outline:none}',
            '.dshcal-pop[data-sheet]{left:12px!important;right:12px;bottom:12px;top:auto!important;width:auto;max-height:70vh}',
            '.dshcal-pop-top{display:flex;align-items:flex-start;gap:10px}',
            '.dshcal-pop-swatch{flex:none;width:12px;height:12px;margin-top:6px;border-radius:var(--dsw-radius-xs);background:var(--ev)}',
            '.dshcal-pop-title{flex:1;min-width:0;margin:0;font-size:var(--dsw-font-base-16-font-size,16px);font-weight:600;line-height:1.4;color:var(--cal-strong);overflow-wrap:anywhere}',
            '.dshcal-pop-actions{display:flex;gap:2px;margin:-4px -4px 0 0}',
            '.dshcal-pop-rows{display:flex;flex-direction:column;gap:9px;margin-top:10px}',
            '.dshcal-pop-row{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;align-items:start}',
            '.dshcal-pop-row>svg,.dshcal-pop-row>.dshcal-pop-icon{margin-top:2px;color:var(--cal-meta)}',
            '.dshcal-pop-row>div{min-width:0;overflow-wrap:anywhere}',
            '.dshcal-pop-sub{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta)}',
            '.dshcal-pop-notes{white-space:pre-wrap;max-height:180px;overflow:auto;font-size:var(--dsw-font-xs-13-font-size,13px);color:var(--cal-soft);scrollbar-width:thin}',
            '.dshcal-pop-guests{display:flex;flex-direction:column;gap:3px;margin-top:4px}',
            '.dshcal-guest{display:flex;align-items:center;gap:7px;min-width:0;font-size:var(--dsw-font-xs-13-font-size,13px)}',
            '.dshcal-guest>span:nth-child(2){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-fields{display:contents;margin:0;padding:0;border:0;min-width:0}',
            '.dshcal-people{list-style:none;margin:0;padding:4px;display:flex;flex-direction:column;gap:1px;max-height:244px;overflow-y:auto;border:1px solid var(--cal-line);border-radius:var(--dsw-radius-md);background:var(--cal-fill);scrollbar-width:thin}',
            `.dshcal-people:focus-visible{outline:2px solid ${RING};outline-offset:2px}`,
            '.dshcal-people>li{display:flex;align-items:center;flex-wrap:wrap;gap:2px 8px;box-sizing:border-box;min-height:28px;padding:3px 6px;font-size:var(--dsw-font-xs-13-font-size,13px)}',
            '.dshcal-person{flex:1 1 160px;min-width:0;overflow-wrap:anywhere;color:var(--cal-text)}',
            '.dshcal-gets{margin-left:auto;font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta);text-align:right}',
            '.dshcal-ans{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;font-size:var(--dsw-font-xxxs-11-font-size,11px);font-weight:700;line-height:1}',
            '.dshcal-ans[data-ans=accepted]{background:var(--cal-ok);color:var(--cal-chip-ground)}',
            '.dshcal-ans[data-ans=declined]{background:var(--cal-danger);color:var(--cal-chip-ground)}',
            '.dshcal-ans[data-ans=tentative]{background:var(--cal-warn);color:var(--cal-chip-ground)}',
            '.dshcal-ans[data-ans=needs-action]{box-shadow:inset 0 0 0 1.5px var(--cal-faint)}',
            '.dshcal-rsvp{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:11px;border-top:1px solid var(--cal-line)}',
            '.dshcal-rsvp>span{flex:1 0 auto;font-size:var(--dsw-font-xs-13-font-size,13px);font-weight:500;color:var(--cal-meta)}',
            '.dshcal-pop-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:11px;border-top:1px solid var(--cal-line)}',
            '.dshcal-daypop-list{display:flex;flex-direction:column;gap:3px;margin:10px 0 2px}',
            '.dshcal-daypop-list .dshcal-bar,.dshcal-daypop-list .dshcal-line{margin:0}',

            // ── Dialogs: DSH's Modal as DSH draws it, scrolling inside; only its width is the plugin's.
            '.dshcal-dlg.dshcal-dlg{width:min(540px,100%);max-height:100%}',
            '.dshcal-dlg.dshcal-dlg-narrow{width:min(420px,100%)}',
            '.dshcal-dlg.dshcal-dlg-wide{width:min(600px,100%)}',
            // Starts and Ends share a row only where both show in full; a time goes under its date before either is cut.
            '.dshcal-row.dshcal-when-row>.dshcal-field{flex:1 1 max-content;min-width:min-content}',
            '.dshcal-inline.dshcal-dt>.dshcal-date{flex:1.25 1 0;width:auto;min-width:min-content}',
            '.dshcal-inline.dshcal-dt>.dshcal-time{flex:1 1 0;width:auto;min-width:min-content}',
            '.dshcal-inline>.dshcal-grow{flex:1 1 auto;width:auto;min-width:0}',
            '.dshcal-switch-row{display:flex;align-items:center;gap:8px;font-size:var(--dsw-font-xs-13-font-size,13px)}',
            '.dshcal-switch-text{cursor:pointer;user-select:none}',
            '.dshcal-dlg-content{flex:1 1 auto;min-height:0;overflow:auto;scrollbar-width:thin}',
            '.dshcal-form{display:flex;flex-direction:column;gap:14px;font-size:var(--dsw-font-xs-13-font-size,13px)}',
            // A save that didn't go through, at the top of the event form with Look at it again: it takes the focus without a ring, as DSH's own automatic focus.
            '.dshcal-refusal{display:flex;flex-direction:column;align-items:flex-start;gap:8px;scroll-margin:12px}',
            '.dshcal-refusal>.dshcal-alert{align-self:stretch}',
            '.dshcal-refusal:focus,.dshcal-refusal[tabindex]:focus-visible{outline:none}',
            '.dshcal-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}',
            '.dshcal-row>.dshcal-field{flex:1 1 140px}',
            '.dshcal-when{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:8px 8px;align-items:end}',
            '.dshcal-when>.dshcal-label{grid-column:1 / -1;margin-bottom:-3px}',
            '.dshcal-title-input{height:40px;font-size:var(--dsw-font-base-16-font-size,16px);font-weight:600}',
            '.dshcal-chips{display:flex;flex-wrap:wrap;gap:6px}',
            '.dshcal-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:26px;padding:0 4px 0 10px;border-radius:var(--dsw-radius-md);background:var(--cal-hover);font-size:var(--dsw-font-xs-13-font-size,13px);box-sizing:border-box}',
            '.dshcal-chip>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-chip>button{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-md);background:none;color:var(--cal-meta);cursor:pointer}',
            '.dshcal-chip>button:hover{background:var(--cal-press);color:var(--cal-text)}',
            '.dshcal-wdays{display:flex;flex-wrap:wrap;gap:4px}',
            '.dshcal-wdays>button{width:32px;height:32px;padding:0;border:1px solid var(--cal-line2);border-radius:var(--dsw-radius-lg);background:none;color:var(--cal-text);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;cursor:pointer}',
            '.dshcal-wdays>button[aria-pressed=true]{background:var(--cal-accent);border-color:transparent;color:var(--cal-on-accent)}',
            '.dshcal-custom{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--cal-line);border-radius:var(--dsw-radius-md);background:var(--cal-fill)}',
            '.dshcal-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
            '.dshcal-inline>.dshcal-input,.dshcal-inline>.dshcal-select{width:auto}',
            '.dshcal-num{width:72px!important}',
            '.dshcal-radio{display:flex;align-items:center;gap:8px;min-height:30px;cursor:pointer}',
            '.dshcal-radio>input{margin:0;accent-color:var(--cal-accent)}',
            '.dshcal-options{display:flex;flex-direction:column;gap:4px}',
            '.dshcal-option{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--cal-line2);border-radius:var(--dsw-radius-md);cursor:pointer}',
            '.dshcal-option:has(input:checked){border-color:var(--cal-accent);background:var(--cal-accent-soft)}',
            '.dshcal-option>input{margin:3px 0 0;accent-color:var(--cal-accent)}',
            '.dshcal-option b{display:block;font-weight:600}',
            '.dshcal-option span{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta)}',
            '.dshcal-swatches{display:flex;flex-wrap:wrap;gap:8px}',
            '.dshcal-swatch{width:26px;height:26px;padding:0;border:2px solid transparent;border-radius:50%;background:var(--sw);cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)}',
            '.dshcal-swatch[aria-checked=true]{border-color:var(--cal-text)}',
            '.dshcal-color-input{width:40px;height:30px;padding:0;border:1px solid var(--cal-line2);border-radius:var(--dsw-radius-sm);background:none;cursor:pointer}',

            // The Accounts dialog.
            '.dshcal-accts{display:flex;flex-direction:column;gap:8px}',
            '.dshcal-acct{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 10px 10px 12px;border:1px solid var(--cal-line);border-radius:var(--dsw-radius-lg);background:var(--cal-fill)}',
            '.dshcal-acct-badge{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:var(--dsw-radius-md);background:var(--cal-hover);color:var(--cal-strong);font-size:var(--dsw-font-xs-13-font-size,13px);font-weight:700}',
            '.dshcal-acct-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-acct-sub{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-acct-status{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta);flex-wrap:wrap}',
            '.dshcal-acct-status[data-status=signin],.dshcal-acct-status[data-status=error]{color:var(--cal-warn)}',
            '.dshcal-acct-actions{display:flex;align-items:center;gap:4px}',
            '.dshcal-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}',
            '.dshcal-tile{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:12px;border:1px solid var(--cal-line2);border-radius:var(--dsw-radius-lg);background:var(--cal-fill);color:var(--cal-text);font:inherit;text-align:left;cursor:pointer}',
            '.dshcal-tile:hover{background:var(--cal-hover)}',
            '.dshcal-tile b{font-size:var(--dsw-font-s-14-font-size,14px);font-weight:600}',
            '.dshcal-tile span{font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.4;color:var(--cal-meta)}',
            '.dshcal-steps{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.5;color:var(--cal-soft)}',
            '.dshcal-steps code,.dshcal-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.95em;padding:1px 4px;border-radius:var(--dsw-radius-xs);background:var(--cal-hover)}',
            '.dshcal-usercode{display:flex;align-items:center;justify-content:center;gap:12px;padding:16px;border-radius:var(--dsw-radius-lg);background:var(--cal-fill);border:1px solid var(--cal-line2)}',
            '.dshcal-usercode b{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:var(--dsw-font-xl-24-font-size,24px);font-weight:700;letter-spacing:.12em;color:var(--cal-strong);user-select:all}',
            '.dshcal-wait{display:flex;align-items:center;gap:8px;font-size:var(--dsw-font-xs-13-font-size,13px);color:var(--cal-meta)}',
            '.dshcal-back{align-self:flex-start;margin:-6px 0 -4px -8px}',
            // Where a dialog's page puts its own buttons, among the dialog's footer buttons.
            '.dshcal-slot{display:contents}',

            // Menus: DSH's Menu as DSH draws it, with the plugin's colour swatches.
            '.dshcal-menu-swatch{display:inline-block;width:12px;height:12px;border-radius:var(--dsw-radius-xs);background:var(--sw)}',

            // Toasts are DSH's (its banner at the top of the window); this one shows only on a DSH without it.
            '.dshcal-toast{position:fixed;top:max(40px,var(--dsh-frame-overlay-top,40px));left:0;right:0;z-index:1100;display:flex;align-items:center;gap:10px;box-sizing:border-box;width:max-content;max-width:min(640px,calc(100vw - 48px));margin:0 auto;padding:12px 16px;'
                + 'border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-toast-label);font-size:var(--dsw-font-s-14-font-size,14px);line-height:22px;pointer-events:none;animation:dshcal-in var(--ds-transition-duration,.2s) var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}',
            '.dshcal-toast[data-tone=error]>svg{color:var(--dsw-alias-state-warn-label)}',
            '.dshcal-toast[data-tone=ok]>svg{color:var(--dsw-alias-state-success-primary)}',
            '.dshcal-toast.dshcal-toast-acts{pointer-events:auto}',
            '.dshcal-toast-acts .dshcal-link{color:inherit;font-weight:600}',

            // ── The Agenda pane beside chats: inside DSH's right dock (glass already), a faint fill, no second blur.
            '.dshcal-pane{display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;overflow:auto;padding:12px 10px 16px;color:var(--cal-text);font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.45;scrollbar-width:thin}',
            '.dshcal-pane-head{display:flex;align-items:center;gap:6px;padding:0 4px 10px}',
            '.dshcal-pane-head h2{flex:1;min-width:0;margin:0;font-size:var(--dsw-font-s-14-font-size,14px);font-weight:600;color:var(--cal-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-pane-day{margin-top:12px}',
            '.dshcal-pane-day:first-of-type{margin-top:0}',
            '.dshcal-pane-dayname{display:flex;align-items:baseline;gap:6px;padding:0 4px 5px;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;letter-spacing:.03em;color:var(--cal-meta);text-transform:uppercase}',
            '.dshcal-pane-list{display:flex;flex-direction:column;gap:4px}',
            '.dshcal-pane-ev{position:relative;display:grid;grid-template-columns:4px minmax(0,1fr) auto;gap:9px;align-items:center;padding:7px 8px 7px 7px;border:1px solid var(--cal-line);border-radius:var(--dsw-radius-md);background:var(--cal-fill);color:var(--cal-text);min-width:0}',
            '.dshcal-pane-ev:hover{background:var(--cal-hover)}',
            '.dshcal-pane-ev[data-now]{border-color:color-mix(in srgb,var(--cal-accent) 60%,transparent);background:var(--cal-accent-soft)}',
            '.dshcal-pane-ev[data-past]{color:var(--cal-soft)}',
            '.dshcal-pane-ev[data-past]>.dshcal-pane-bar{opacity:.45}',
            '.dshcal-pane-bar{align-self:stretch;border-radius:var(--dsw-radius-xs);background:var(--ev)}',
            // The whole card opens the event; Join stays its own link above it.
            '.dshcal-pane-what{display:flex;flex-direction:column;align-items:stretch;min-width:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}',
            '.dshcal-pane-what::after{content:"";position:absolute;inset:0;border-radius:var(--dsw-radius-md)}',
            '.dshcal-pane-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-pane-ev[data-look=struck] .dshcal-pane-title{text-decoration:line-through;color:var(--cal-meta)}',
            '.dshcal-pane-sub{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
            '.dshcal-pane-badge{display:inline-flex;align-items:center;height:17px;padding:0 6px;margin-right:5px;border-radius:var(--dsw-radius-sm);background:var(--cal-accent);color:var(--cal-on-accent);font-size:var(--dsw-font-xxxs-11-font-size,11px);font-weight:700;vertical-align:1px}',
            '.dshcal-pane-join{position:relative;z-index:1;height:26px;padding:0 9px;border:0;border-radius:var(--dsw-radius-sm);background:var(--cal-accent);color:var(--cal-on-accent);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}',
            '.dshcal-pane-empty{padding:6px 4px;font-size:var(--dsw-font-xs-13-font-size,13px);color:var(--cal-faint)}',
            '.dshcal-notes{display:flex;flex-direction:column;gap:6px;padding:8px 12px 0}',
            '.dshcal-notice{display:flex;align-items:flex-start;gap:8px;padding:7px 6px 7px 10px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--cal-accent) 10%,transparent);font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.45;color:var(--cal-text)}',
            '.dshcal-notice>svg{flex:none;margin-top:2px;color:var(--cal-meta)}',
            '.dshcal-notice>span,.dshcal-notice-body{flex:1;min-width:0;overflow-wrap:anywhere}',
            '.dshcal-notice-list{margin:3px 0 0;padding:0 0 0 16px}',
            '.dshcal-notice-list>li+li{margin-top:2px}',
            // Switched off, by the owner's choice: secondary text, no alarm.
            '.dshcal-off{color:var(--cal-soft)}',
            '.dshcal-off>svg{flex:none;color:var(--cal-meta)}',
            '.dshcal-notice[data-tone=warn]{background:color-mix(in srgb,var(--cal-warn) 14%,transparent)}',
            '.dshcal-notice[data-tone=warn]>svg{color:var(--cal-warn)}',
            '.dshcal-pane-note{display:flex;align-items:center;gap:6px;margin:0 0 10px;padding:7px 9px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--cal-warn) 14%,transparent);font-size:var(--dsw-font-xxs-12-font-size,12px)}',
            '.dshcal-pane-note>span{flex:1;min-width:0}',
            // What's next, at the top of the pane: on the event cards' faint fill, so its small text has a ground.
            '.dshcal-pane-next{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 10px;padding:7px 9px;border:1px solid var(--cal-line);border-radius:var(--dsw-radius-md);background:var(--cal-fill);font-size:var(--dsw-font-xs-13-font-size,13px)}',
            '.dshcal-pane-next-label{flex:none;font-weight:600;color:var(--cal-meta)}',
            '.dshcal-pane-next-what{flex:0 1 auto;min-width:0;margin:0;padding:0;border:0;background:none;color:var(--cal-strong);font:inherit;font-weight:600;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-pane-next-what:hover{text-decoration:underline}',
            '.dshcal-pane-next-when{flex:none;margin-left:auto;color:var(--cal-meta);font-variant-numeric:tabular-nums;white-space:nowrap}',
            '.dshcal-pane .dshcal-stale{margin:0 0 10px;padding:6px 9px;border:0;border-radius:var(--dsw-radius-md)}',
            '.dshcal-pane-foot{display:flex;justify-content:center;margin-top:16px}',

            // ── Chat cards for the calendar tools: drawn as DSH's own cards in a chat, opaque, with no blur.
            '.dshcal-chat{display:flex;flex-direction:column;gap:6px;min-width:0;max-width:640px;margin:2px 0 6px;color:var(--cal-text);font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.45}',
            '.dshcal-chat-card{display:flex;flex-direction:column;gap:2px;min-width:0;padding:8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
            '.dshcal-chat-day{padding:6px 6px 2px;font-size:var(--dsw-font-xxs-12-font-size,12px);font-weight:600;letter-spacing:.03em;color:var(--cal-meta);text-transform:uppercase}',
            '.dshcal-chat-day:first-child{padding-top:0}',
            '.dshcal-chat-ev{display:grid;grid-template-columns:4px minmax(96px,auto) minmax(0,1fr);gap:10px;align-items:center;padding:5px 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--cal-text);font:inherit;text-align:left;cursor:pointer;min-width:0}',
            '.dshcal-chat-ev:hover{background:var(--cal-hover)}',
            '.dshcal-chat-ev:disabled{cursor:default;background:none}',
            '.dshcal-chat-bar{align-self:stretch;min-height:18px;border-radius:var(--dsw-radius-xs);background:var(--ev)}',
            '.dshcal-chat-time{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta);font-variant-numeric:tabular-nums;white-space:nowrap}',
            '.dshcal-chat-what{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-chat-what b{font-weight:600}',
            '.dshcal-chat-what span{color:var(--cal-meta)}',
            '.dshcal-chat-ev[data-look=struck] b{text-decoration:line-through;color:var(--cal-meta)}',
            '.dshcal-chat-foot{padding:4px 6px 0;font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-meta)}',
            '.dshcal-chat-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
            '.dshcal-chat-line>svg{flex:none;color:var(--cal-ok)}',
            '.dshcal-chat-line[data-kind=deleted]>svg{color:var(--cal-meta)}',
            '.dshcal-chat-line[data-kind=failed]{align-items:flex-start;border-color:color-mix(in srgb,var(--cal-warn) 45%,var(--dsw-alias-border-l4))}',
            '.dshcal-chat-line[data-kind=failed]>svg{margin-top:2px;color:var(--cal-warn)}',
            '.dshcal-chat-line[data-kind=failed] .dshcal-chat-text{color:var(--cal-text);overflow-wrap:anywhere}',
            '.dshcal-chat-cal>.dshcal-warn{flex:1 1 100%;padding-left:16px;font-size:var(--dsw-font-xxs-12-font-size,12px)}',
            '.dshcal-chat-line>.dshcal-chat-text{flex:1 1 220px;min-width:0}',
            '.dshcal-chat-text b{font-weight:600}',
            '.dshcal-chat-text span{color:var(--cal-meta)}',
            '.dshcal-chat-told{flex:1 1 100%;min-width:0;padding-left:22px;font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.45;color:var(--cal-meta);overflow-wrap:anywhere}',
            '.dshcal-chat-slots{display:flex;flex-direction:column;gap:4px;padding:2px 4px}',
            '.dshcal-chat-slot{display:grid;grid-template-columns:minmax(110px,auto) minmax(0,1fr);gap:10px;font-size:var(--dsw-font-xs-13-font-size,13px)}',
            '.dshcal-chat-slot>span:first-child{font-weight:600}',
            '.dshcal-chat-slot>span:last-child{color:var(--cal-soft);font-variant-numeric:tabular-nums}',
            '.dshcal-chat-cal{display:flex;align-items:center;flex-wrap:wrap;gap:0 8px;padding:3px 6px;font-size:var(--dsw-font-xs-13-font-size,13px);min-width:0}',
            '.dshcal-chat-cal>span:nth-child(2){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-chat-row{display:flex;align-items:center;gap:6px;min-width:0;height:24px;color:var(--cal-meta);font-size:var(--dsw-font-xs-13-font-size,13px)}',
            '.dshcal-chat-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshcal-chat-out{margin:2px 0 0 22px;max-height:240px;overflow:auto;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--cal-fill);white-space:pre-wrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--cal-soft);scrollbar-width:thin}',

            // The side column: beside the view on a roomy page, folded behind its button on a narrower one (the page says
            // which: data-side-folded), and over the page while open on a narrow one (data-side-open). Then the header wraps.
            '.dshcal-head .dshcal-head-new{display:none}',
            '.dshcal-root[data-side-folded] .dshcal-side{display:none}',
            '.dshcal-root[data-side-folded] .dshcal-head .dshcal-head-new{display:inline-flex}',
            '.dshcal-scrim{display:none;position:absolute;inset:0;z-index:19;border:0;padding:0;background:var(--dsw-alias-bg-mask-2);cursor:default}',
            '.dshcal-root[data-side-open] .dshcal-scrim{display:block}',
            '.dshcal-root[data-side-folded][data-side-open] .dshcal-side{display:flex;position:absolute;z-index:20;top:12px;bottom:12px;left:12px;width:min(280px,calc(100% - 24px));background:var(--dsw-specific-menu);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent)}',
            '@container dshcal (max-width: 799px){.dshcal-head .dshcal-head-new{display:inline-flex}}',
            // Below 1100px the header's New event is its + alone (its name in its tooltip and for screen readers), so the
            // search, the views and it stay on one row instead of wrapping it onto a row of its own.
            '@container dshcal (max-width: 1099px){.dshcal-head-new>.dshcal-hide-narrow{display:none}.dshcal-head-new{width:30px;padding:0}}',
            // Above 560px the tools keep to one row (the search gives way first): beside the title when they fit, else
            // on the row under it, never a row of their own each.
            '@container dshcal (min-width: 561px){.dshcal-head-tools{flex-wrap:nowrap}}',
            '@container dshcal (max-width: 560px){'
                + '.dshcal-root{padding:8px;gap:8px}'
                + '.dshcal-head{padding:8px}'
                + '.dshcal-title{font-size:var(--dsw-font-base-16-font-size,16px);margin-left:2px}'
                + '.dshcal-head-tools{width:100%;justify-content:space-between}'
                + '.dshcal-hide-narrow{display:none!important}'
                + '.dshcal-wk{--gutter:42px}'
                + '.dshcal-wk-dayhead{flex-direction:column;gap:0;height:46px}'
                + '.dshcal-wk-dayhead span:first-child{font-size:var(--dsw-font-xxxs-11-font-size,11px)}'
                + '.dshcal-wk-dayhead span:last-child{font-size:var(--dsw-font-s-14-font-size,14px);min-width:24px;height:24px}'
                + '.dshcal-ev{padding:2px 4px;font-size:var(--dsw-font-xxxs-11-font-size,11px)}'
                + '.dshcal-ag-day{grid-template-columns:1fr;gap:4px}'
                + '.dshcal-ag-row{grid-template-columns:1fr;gap:2px}'
                + '.dshcal-mo-wd{padding:6px 4px;text-align:center}'
                + '.dshcal-mo{--wk:20px}'
                + '.dshcal-titles{flex-direction:column;align-items:flex-start;gap:0}'
                + '.dshcal-titles>.dshcal-title{max-width:100%;line-height:20px}'
                + '.dshcal-wknum{height:auto;margin-left:2px;padding:0;background:none;line-height:13px}'
                + '.dshcal-line-time{display:none}'
                + '.dshcal-search{order:3;flex:1 1 100%}'
                + '}',
            '.dshcal-pane .dshcal-hide-narrow{display:none}',
            // Motion: none while the wallpaper's Motion is off, or where the user asks for less (the loading bar is an ::after).
            `body.wp-still :is(${ROOTS}),body.wp-still :is(${ROOTS})::before,body.wp-still :is(${ROOTS})::after,`
                + `body.wp-still :is(${ROOTS}) *,body.wp-still :is(${ROOTS}) *::before,body.wp-still :is(${ROOTS}) *::after{animation:none!important;transition:none!important}`,
            `@media (prefers-reduced-motion:reduce){:is(${ROOTS}),:is(${ROOTS})::before,:is(${ROOTS})::after,`
                + `:is(${ROOTS}) *,:is(${ROOTS}) *::before,:is(${ROOTS}) *::after{animation:none!important;transition:none!important}}`,
        ].join('');
        const CSS_ID = `${BUNDLE}/client.css`;
        try {
            if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null) {
                const tag = document.createElement('style');
                tag.dataset.plugin = BUNDLE;
                tag.dataset.pluginCss = CSS_ID;
                tag.textContent = CSS;
                document.head.appendChild(tag);
            }
        } catch (error) {
            console.warn(`[calendar] could not add the plugin's styles: ${error?.message ?? error}`);
        }

        // ── Shared ─────────────────────────────────────────────────────────

        const EMPTY = Object.freeze([]);
        const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
        const pad = (n, width = 2) => String(n).padStart(width, '0');
        const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
        /** Names in a sentence: "A", "A and B", "A, B and C". */
        const andList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
        /** A message as a sentence: its stop added when it has none. */
        const stopped = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`);
        const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
        /** A DSH icon by name, or nothing where this DSH has none. */
        const icon = (name, props = {}) => (ui && ui[name] ? h(ui[name], { size: 14, 'aria-hidden': true, ...props }) : null);
        const warn = (what, error) => { console.warn(`[calendar] ${what}: ${error?.message ?? error}`); };

        /** What the window says wherever it shows. */
        const TEXT = {
            entry: 'Calendar',
            unreachable: 'The calendar plugin didn\'t answer. If it was just updated, restart DSH so the new version loads.',
            unreadable: 'The calendar plugin sent an answer this window can\'t read.',
            retry: 'Retry',
            close: 'Close',
            cancel: 'Cancel',
            save: 'Save',
            today: 'Today',
            tomorrow: 'Tomorrow',
            allDay: 'All day',
            noTitle: '(No title)',
            views: { month: 'Month', week: 'Week', day: 'Day', agenda: 'Agenda' },
            previous: { month: 'Previous month', week: 'Previous week', day: 'Previous day', agenda: 'Earlier' },
            next: { month: 'Next month', week: 'Next week', day: 'Next day', agenda: 'Later' },
            agendaTab: 'Agenda',
            agendaGuide: 'Today and the next days from your calendars',
        };

        /**
         * The plugin's endpoints over the window's own connection: POST
         * /api/dsh-plugin-calendar/<method> with `{args}` (named by the
         * method's parameters), answered `{ok: true, value}` or `{ok: false,
         * error: {code, message}}`. Never throws: a failed call answers as a
         * refusal does.
         * @param connectionOf - DSH's `connection` service, or undefined until DSH provides it.
         * @param whenConnected - waits a while for the connection a call finds missing (ms → it, or undefined).
         */
        function hostLink(connectionOf, whenConnected) {
            return {
                async call(method, args = {}) {
                    try {
                        let connection = connectionOf();
                        if (!connection && typeof whenConnected === 'function') connection = await whenConnected(8000);
                        if (!connection) throw new Error('the window is not connected to DSH yet');
                        const result = await connection.rpc.call('/api', `${BUNDLE}/${method}`, { args });
                        if (isObject(result) && (result.ok === true || (result.ok === false && isObject(result.error)))) return result;
                        return { ok: false, error: { code: 'calendar/unreadable', message: TEXT.unreadable } };
                    } catch (error) {
                        return { ok: false, error: { code: 'calendar/unreachable', message: String(error?.message ?? error) } };
                    }
                },
            };
        }

        /** The refusals whose message is the plugin's own words to the user, shown as they are. */
        const OWN_WORDS = new Set(['calendar/off', 'calendar/refused', 'calendar/needs-notify', 'calendar/needs-approval', 'calendar/changed', 'calendar/drops-changes', 'calendar/choose-calendar', 'calendar/half-moved']);

        /** A failed call as one sentence: the plugin's own refusal as it is, or that it failed or can't be reached. */
        function errorText(error) {
            const code = String(error?.code ?? '');
            const message = String(error?.message ?? '').trim();
            const sentence = (text) => `${text.replace(/^./, (c) => c.toUpperCase())}${/[.!?…)]$/.test(text) ? '' : '.'}`;
            if (OWN_WORDS.has(code) && message) return sentence(message);
            if (code === 'calendar/unreachable' || code.startsWith('gateway/') || code.startsWith('rpc/')) return TEXT.unreachable;
            if (code === 'calendar/unreadable') return TEXT.unreadable;
            return message ? `That didn't work: ${sentence(message.slice(0, 240))}` : TEXT.unreachable;
        }

        // ── Days and zones ─────────────────────────────────────────────────
        // Times are epoch ms; days 'YYYY-MM-DD'; wall clocks 'YYYY-MM-DDTHH:MM[:SS]' in a zone. The window shows every
        // day and time in the user's zone (the plugin's, from state()), which can differ from the browser's.

        /** Formatters per zone for reading wall clocks; Intl's are costly to make and cheap to reuse. */
        const partFormatters = new Map();
        function partFormatter(zone) {
            let format = partFormatters.get(zone);
            if (format === undefined) {
                format = new Intl.DateTimeFormat('en-US', {
                    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
                });
                partFormatters.set(zone, format);
            }
            return format;
        }

        /** Whether the browser knows a zone id. */
        function isZone(zone) {
            if (typeof zone !== 'string' || zone === '' || zone.length > 64) return false;
            try {
                partFormatter(zone);
                return true;
            } catch {
                return false;
            }
        }

        /** The browser's own zone ('UTC' if it can't tell). */
        function browserZone() {
            try {
                const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
                return isZone(zone) ? zone : 'UTC';
            } catch {
                return 'UTC';
            }
        }

        /** Every zone id the browser offers, for the zone field. */
        let zoneList;
        function zoneIds() {
            if (zoneList === undefined) {
                try {
                    const ids = Intl.supportedValuesOf('timeZone');
                    zoneList = ids.includes('UTC') ? ids : ['UTC', ...ids];
                } catch {
                    zoneList = ['UTC'];
                }
            }
            return zoneList;
        }

        /** The wall clock read as if it were UTC (calendar arithmetic), NaN for a malformed one. */
        function wallMs(local) {
            const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(local ?? ''));
            if (m === null) return NaN;
            return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
        }

        function wallOf(ms) {
            const d = new Date(ms);
            return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        }

        /** A zone's offset from UTC at an instant, in minutes east. */
        function offsetAt(zone, ms) {
            if (zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT' || !isZone(zone)) return 0;
            const parts = {};
            for (const { type, value } of partFormatter(zone).formatToParts(new Date(ms))) parts[type] = value;
            const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
            return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
        }

        /** The wall clock in a zone at an instant: 'YYYY-MM-DDTHH:MM:SS'. */
        const toLocal = (ms, zone) => wallOf(ms + offsetAt(zone, ms) * MINUTE);

        /**
         * The instant a wall clock in a zone stands for, read as the host reads
         * it (zones.js): a time skipped by a spring-forward gap takes the offset
         * from before the gap, a time that happens twice is the first.
         */
        function toInstant(local, zone) {
            const wall = wallMs(local);
            if (Number.isNaN(wall)) return NaN;
            if (zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT') return wall;
            const before = offsetAt(zone, wall - DAY);
            const after = offsetAt(zone, wall + DAY);
            const want = wallOf(wall);
            const fits = [...new Set([before, after])].map((o) => wall - o * MINUTE).filter((t) => toLocal(t, zone) === want);
            return fits.length > 0 ? Math.min(...fits) : wall - before * MINUTE;
        }

        const dayIn = (ms, zone) => toLocal(ms, zone).slice(0, 10);
        /** Minutes since the day's midnight on the zone's clock (0 to 1439). */
        const minutesIn = (ms, zone) => {
            const local = toLocal(ms, zone);
            return Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
        };
        /** A day's midnight in a zone, as an instant. */
        const startOfDay = (day, zone) => toInstant(`${day}T00:00:00`, zone);

        function isDay(day) {
            if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
            return new Date(wallMs(day)).toISOString().slice(0, 10) === day;
        }
        const addDays = (day, n) => new Date(wallMs(day) + n * DAY).toISOString().slice(0, 10);
        const daysBetween = (from, to) => Math.round((wallMs(to) - wallMs(from)) / DAY);
        /** A day's weekday, 0 (Sunday) to 6. */
        const weekdayOf = (day) => new Date(wallMs(day)).getUTCDay();
        const monthLength = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
        /** A day moved by whole months, its day of the month kept where the month has it (Jan 31 + 1 → Feb 28). */
        function addMonths(day, n) {
            const y = Number(day.slice(0, 4));
            const m = Number(day.slice(5, 7)) - 1 + n;
            const year = y + Math.floor(m / 12);
            const month = ((m % 12) + 12) % 12 + 1;
            return `${pad(year, 4)}-${pad(month)}-${pad(Math.min(Number(day.slice(8, 10)), monthLength(year, month)))}`;
        }
        const monthStart = (day) => `${day.slice(0, 7)}-01`;
        /** The first day of the week holding a day. */
        const weekStartOf = (day, weekStart) => addDays(day, -((weekdayOf(day) - weekStart + 7) % 7));
        /** Every day from one to another, both included. */
        function daySpan(from, to) {
            const out = [];
            for (let d = from; d <= to && out.length < 500; d = addDays(d, 1)) out.push(d);
            return out;
        }
        /** The days an occurrence covers in a zone: its first and last (inclusive). */
        function daysOf(o, zone) {
            if (o.allDay) return [o.startDay, o.lastDay ?? o.startDay];
            const first = dayIn(o.start, zone);
            return [first, o.end > o.start ? dayIn(Math.max(o.start, o.end - 1), zone) : first];
        }
        /** Whether an occurrence belongs in the all-day row: an all-day event, or one a day long or more. */
        const spansDays = (o) => o.allDay || o.end - o.start >= DAY;

        /**
         * The first day of the week: the user's choice in the plugin, else the
         * browser's locale (Intl weekInfo), else its region's custom.
         */
        function localeWeekStart() {
            try {
                const locale = new Intl.Locale(navigator.language || 'en-US');
                const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
                if (info && Number.isInteger(info.firstDay)) return info.firstDay % 7;
                const region = locale.maximize?.().region ?? '';
                if (['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'TW', 'HK', 'IL', 'PH', 'IN', 'ZA', 'AU', 'SA', 'PE', 'CO', 'AR', 'GT', 'VE'].includes(region)) return 0;
                if (['AE', 'AF', 'BH', 'DZ', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SD', 'SY'].includes(region)) return 6;
            } catch {}
            return 1;
        }
        const weekStartFrom = (prefs) => (Number.isInteger(prefs?.weekStart) && prefs.weekStart >= 0 && prefs.weekStart <= 6 ? prefs.weekStart : localeWeekStart());

        // ── Weekends and week numbers (the user's choices: prefs.hideWeekends, prefs.weekNumbers) ──
        // Hidden weekends leave Saturday and Sunday out of Week and Month only; Day, Agenda and the small month keep
        // every day. A week's number is ISO 8601's.

        const isWeekend = (day) => weekdayOf(day) === 0 || weekdayOf(day) === 6;
        /** The days of a run that a view shows: all of them, or the weekdays alone while weekends are hidden. */
        const visibleDays = (days, hideWeekends) => (hideWeekends ? days.filter((day) => !isWeekend(day)) : days);
        /** A day `n` shown days on (back, for a negative n): weekends don't count while they are hidden. */
        function addShownDays(day, n, hideWeekends) {
            const by = n < 0 ? -1 : 1;
            let d = day;
            for (let left = Math.abs(n); left > 0;) {
                d = addDays(d, by);
                if (!hideWeekends || !isWeekend(d)) left--;
            }
            return d;
        }
        /** The first day from a day on that shows: the day itself, or the Monday after a hidden weekend's day. */
        const firstShown = (day, hideWeekends) => (hideWeekends && isWeekend(day) ? addShownDays(day, 1, true) : day);
        /** A day that shows, in the day's own month: the day itself, else the weekday after it, or before it where that's in another month. */
        function shownNear(day, hideWeekends) {
            const next = firstShown(day, hideWeekends);
            return next.slice(0, 7) === day.slice(0, 7) ? next : addShownDays(day, -1, hideWeekends);
        }
        /** A day's ISO 8601 week number (1 to 53): weeks run Monday to Sunday, and a year's week 1 has its first Thursday. */
        function isoWeek(day) {
            const thursday = addDays(day, 3 - ((weekdayOf(day) + 6) % 7));
            return Math.floor(daysBetween(`${thursday.slice(0, 4)}-01-01`, thursday) / 7) + 1;
        }
        /**
         * The number of the week holding a day, as the views lay weeks out from the user's first day of the week: the
         * ISO week most of its seven days are in, which is its fourth day's. For a week from Monday, Sunday or Saturday
         * that is its Monday's (a week from Sunday or Saturday has its Monday among its first three days).
         */
        const weekNumberOf = (day, weekStart) => isoWeek(addDays(weekStartOf(day, weekStart), 3));
        /** The week numbers of days a view shows, in words: 'Week 42', or 'Weeks 42–43' for days in two weeks. */
        function weekWords(days, weekStart) {
            const first = weekNumberOf(days[0], weekStart);
            const last = weekNumberOf(days[days.length - 1], weekStart);
            return first === last ? `Week ${first}` : `Weeks ${first}–${last}`;
        }

        // ── Words for days and times, in the browser's language ────────────

        const formatters = new Map();
        function dtf(options) {
            const key = JSON.stringify(options);
            let format = formatters.get(key);
            if (format === undefined) {
                try {
                    format = new Intl.DateTimeFormat(undefined, options);
                } catch {
                    format = new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
                }
                formatters.set(key, format);
            }
            return format;
        }
        /** A day in words ('Mon, Oct 12'); days are read at their noon in UTC, so no zone moves them. */
        const dayText = (day, options = { weekday: 'short', month: 'short', day: 'numeric' }) => dtf({ ...options, timeZone: 'UTC' }).format(new Date(wallMs(day) + 12 * HOUR));
        /** A time of day on a zone's clock, as the browser's locale writes it (12- or 24-hour). */
        const timeText = (ms, zone) => dtf({ hour: 'numeric', minute: '2-digit', timeZone: zone }).format(ms);
        /**
         * A time as short as the locale allows, for a month's day ('9:30am',
         * '11am'; '09:30' where clocks are 24-hour): the locale's own parts,
         * the minutes dropped on the hour where an am/pm says which half.
         */
        function shortTime(ms, zone) {
            let parts;
            try {
                parts = dtf({ hour: 'numeric', minute: '2-digit', timeZone: zone }).formatToParts(ms);
            } catch {
                return timeText(ms, zone);
            }
            const kinds = parts.map((p) => p.type).filter((t) => t !== 'literal');
            const period = parts.find((p) => p.type === 'dayPeriod');
            if (!period || !/^[ap]\.?\s?m\.?$/i.test(period.value.trim()) || kinds.join() !== 'hour,minute,dayPeriod') return parts.map((p) => p.value).join('');
            const hour = parts.find((p) => p.type === 'hour').value;
            const minute = parts.find((p) => p.type === 'minute').value;
            return `${hour}${minute === '00' ? '' : `:${minute}`}${period.value.toLowerCase().replace(/[\s.]/g, '')}`;
        }
        /** An hour's label for the time grid ('9 AM', '09'). */
        const hourText = (hour) => dtf({ hour: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2000, 0, 3, hour));
        /** Minutes into a day on the clock, as the locale writes a time ('9:30 AM', '09:30'). */
        const clockText = (minutes) => dtf({ hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(Date.UTC(2000, 0, 3, 0, minutes));
        /** From one clock time to another on a day ('9:00 – 10:30 AM'); the day's end is midnight. */
        function clockRangeText(from, to) {
            if (to >= 1440 || to < from) return `${clockText(from)} – ${clockText(to % 1440)}`;
            return rangeText(dtf({ hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }), Date.UTC(2000, 0, 3, 0, from), Date.UTC(2000, 0, 3, 0, to));
        }
        function rangeText(format, a, b, fallback) {
            try {
                if (typeof format.formatRange === 'function') return format.formatRange(a, b);
            } catch {}
            return fallback ?? `${format.format(a)} – ${format.format(b)}`;
        }
        /** A span of time on one day ('9:00 – 10:30 AM'). */
        const timeRangeText = (start, end, zone) => rangeText(dtf({ hour: 'numeric', minute: '2-digit', timeZone: zone }), start, Math.max(start, end));
        /** Days in words, first to last ('Oct 12 – 14'). */
        function dayRangeText(first, last, options = { month: 'short', day: 'numeric' }) {
            if (first === last) return dayText(first, options);
            return rangeText(dtf({ ...options, timeZone: 'UTC' }), new Date(wallMs(first) + 12 * HOUR), new Date(wallMs(last) + 12 * HOUR));
        }
        const thisYear = (zone) => dayIn(Date.now(), zone).slice(0, 4);
        /** The long form of a day: the weekday, and the year where it isn't this one. */
        const longDay = (day, zone) => dayText(day, { weekday: 'long', month: 'long', day: 'numeric', ...(day.slice(0, 4) !== thisYear(zone) ? { year: 'numeric' } : {}) });

        /**
         * When an occurrence is, in the user's zone: 'Monday, October 12 ·
         * 9:00 – 10:00 AM', 'Monday, October 12' (all day), or its first and
         * last moments when it spans days.
         */
        function whenText(o, zone) {
            if (o.allDay) {
                const last = o.lastDay ?? o.startDay;
                if (last === o.startDay) return longDay(o.startDay, zone);
                const year = o.startDay.slice(0, 4) !== thisYear(zone) || last.slice(0, 4) !== thisYear(zone);
                return dayRangeText(o.startDay, last, { weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
            }
            const [first, last] = daysOf(o, zone);
            if (first === last) return `${longDay(first, zone)} · ${timeRangeText(o.start, o.end, zone)}`;
            return rangeText(dtf({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }), o.start, o.end);
        }

        /** An occurrence's time in short: 'All day', '9:00 – 10:00 AM', or its span of days. */
        function shortWhen(o, zone, day) {
            if (o.allDay) {
                const last = o.lastDay ?? o.startDay;
                return last === o.startDay ? TEXT.allDay : `${TEXT.allDay}, ${dayRangeText(o.startDay, last)}`;
            }
            const [first, last] = daysOf(o, zone);
            if (first === last) return timeRangeText(o.start, o.end, zone);
            if (day && day !== first && day !== last) return TEXT.allDay;
            if (day && day === last && day !== first) return `until ${timeText(o.end, zone)}`;
            if (day && day === first) return `${timeText(o.start, zone)} →`;
            return rangeText(dtf({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }), o.start, o.end);
        }

        /** 'Today', 'Tomorrow', or the day in words. */
        function relativeDay(day, today, options) {
            if (day === today) return TEXT.today;
            if (day === addDays(today, 1)) return TEXT.tomorrow;
            return dayText(day, options);
        }

        /** Minutes as words: '15 minutes', '1 hour', '1 day', '2 hours 30 minutes'. */
        function minutesWords(total) {
            const m = Math.max(0, Math.round(total));
            if (m === 0) return '0 minutes';
            if (m % (7 * 1440) === 0) return plural(m / (7 * 1440), 'week');
            if (m % 1440 === 0) return plural(m / 1440, 'day');
            if (m % 60 === 0) return plural(m / 60, 'hour');
            if (m > 60) return `${plural(Math.floor(m / 60), 'hour')} ${plural(m % 60, 'minute')}`;
            return plural(m, 'minute');
        }
        const reminderWords = (m) => (m === 0 ? 'At the start' : `${minutesWords(m)} before`);

        /** How long until an instant, in short ('in 25 min', 'in 2 h'). */
        function untilWords(ms, now) {
            const m = Math.round((ms - now) / MINUTE);
            if (m <= 0) return 'now';
            if (m < 60) return `in ${m} min`;
            const hours = Math.floor(m / 60);
            return m % 60 === 0 || hours >= 5 ? `in ${hours} h` : `in ${hours} h ${m % 60} min`;
        }

        /** The address a link shows as: its host and path, without the scheme. */
        const linkLabel = (url) => String(url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
        const isUrl = (text) => /^https?:\/\/\S+$/i.test(String(text ?? '').trim());

        /** An occurrence's look in the grid: by the user's answer and its state. */
        function lookOf(o) {
            if (o.status === 'cancelled' || o.myStatus === 'declined') return 'struck';
            if (o.myStatus === 'needs-action') return 'outline';
            if (o.myStatus === 'tentative' || o.status === 'tentative' || o.busy === false) return 'soft';
            return 'solid';
        }

        // ── Colors ─────────────────────────────────────────────────────────

        function rgbOf(color) {
            const text = String(color ?? '').trim();
            let m = /^#([0-9a-f]{3})$/i.exec(text);
            if (m) return [...m[1]].map((c) => Number.parseInt(c + c, 16));
            m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(text);
            if (m) return [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16));
            return undefined;
        }
        function luminance(rgb) {
            const [r, g, b] = rgb.map((v) => {
                const c = v / 255;
                return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        /** The text color with the most contrast on a calendar's color: near-black or white. */
        function textOn(color) {
            const rgb = rgbOf(color);
            if (!rgb) return '#ffffff';
            const l = luminance(rgb);
            return contrast(l, luminance([17, 20, 18])) >= contrast(l, 1) ? '#111412' : '#ffffff';
        }
        /** A calendar's color as given, or the first of the palette when it isn't one the window can draw. */
        const colorOf = (color) => (rgbOf(color) ? String(color).trim() : PALETTE[0]);
        /** The CSS variables an event's chip takes from its calendar. */
        const evStyle = (color) => ({ '--ev': colorOf(color), '--ev-text': textOn(colorOf(color)) });

        // ── Repeat rules ───────────────────────────────────────────────────
        // The event dialog offers what most calendars do: daily, weekly, monthly (by day or by the nth weekday), yearly,
        // every weekday, and a custom rule with an interval and an end. A rule it can't show that way stays as it is.

        const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
        const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
        const weekdayName = (wd, style = 'long') => dtf({ weekday: style, timeZone: 'UTC' }).format(Date.UTC(2023, 0, 1 + wd));
        /** The nth time this weekday comes in its month (1 to 5), and whether it is the last. */
        function nthOf(day) {
            const d = Number(day.slice(8, 10));
            return { n: Math.ceil(d / 7), last: d + 7 > monthLength(Number(day.slice(0, 4)), Number(day.slice(5, 7))) };
        }

        /** A rule's parts, or undefined when it can't be read. */
        function parseRule(text) {
            const parts = {};
            for (const piece of String(text ?? '').trim().replace(/^RRULE:/i, '').split(';')) {
                if (!piece) continue;
                const eq = piece.indexOf('=');
                if (eq < 1) return undefined;
                parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1).toUpperCase();
            }
            return parts.FREQ ? parts : undefined;
        }

        /** UNTIL for the last day of a series: the whole day (all-day), or its last second on the event's clock. */
        function untilValue(day, allDay, zone) {
            if (allDay) return day.replaceAll('-', '');
            const ms = toInstant(`${day}T23:59:59`, zone);
            return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
        }
        /** UNTIL back to a day on the event's clock. */
        function untilDay(until, zone) {
            const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(until ?? ''));
            if (!m) return undefined;
            if (m[7]) return dayIn(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), zone);
            return `${m[1]}-${m[2]}-${m[3]}`;
        }

        /** The choices the Repeat field offers for a start day. */
        function repeatChoices(startDay) {
            const wd = weekdayOf(startDay);
            const { n, last } = nthOf(startDay);
            const date = Number(startDay.slice(8, 10));
            const out = [
                { value: 'none', label: 'Does not repeat' },
                { value: 'daily', label: 'Every day' },
                { value: 'weekly', label: `Every week on ${weekdayName(wd)}` },
                { value: 'weekdays', label: 'Every weekday (Monday to Friday)' },
                { value: 'monthly', label: `Every month on day ${date}` },
            ];
            if (n <= 4) out.push({ value: 'monthly-nth', label: `Every month on the ${ORDINALS[n]} ${weekdayName(wd)}` });
            if (last) out.push({ value: 'monthly-last', label: `Every month on the last ${weekdayName(wd)}` });
            out.push({ value: 'yearly', label: `Every year on ${dayText(startDay, { month: 'long', day: 'numeric' })}` });
            out.push({ value: 'custom', label: 'Custom…' });
            return out;
        }

        /** A fresh custom rule from a start day: every week on its weekday, no end. */
        const customFrom = (startDay) => ({ interval: 1, unit: 'week', days: [weekdayOf(startDay)], monthBy: 'day', end: 'never', until: addMonths(startDay, 3), count: 10 });

        /**
         * The Repeat field's state from a rule (an event being changed):
         * {mode, custom, keep?}. A rule the field can't show is kept as it is
         * (mode 'keep').
         */
        function repeatFromRule(text, startDay, allDay, zone) {
            const base = { mode: 'none', custom: customFrom(startDay) };
            if (!text) return base;
            const p = parseRule(text);
            const keep = { ...base, mode: 'keep', keep: String(text) };
            if (!p) return keep;
            const known = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST']);
            if (Object.keys(p).some((k) => !known.has(k))) return keep;
            const interval = p.INTERVAL ? Number(p.INTERVAL) : 1;
            if (!Number.isInteger(interval) || interval < 1) return keep;
            const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[p.FREQ];
            if (!unit) return keep;
            const wd = weekdayOf(startDay);
            const days = p.BYDAY ? p.BYDAY.split(',') : [];
            const plain = days.every((d) => WD.includes(d));
            const custom = { ...base.custom, interval, unit, end: 'never' };
            if (p.COUNT) {
                const count = Number(p.COUNT);
                if (!Number.isInteger(count) || count < 1) return keep;
                Object.assign(custom, { end: 'after', count });
            } else if (p.UNTIL) {
                const day = untilDay(p.UNTIL, allDay ? 'UTC' : zone);
                if (!day) return keep;
                Object.assign(custom, { end: 'on', until: day });
            }
            const simple = interval === 1 && custom.end === 'never';
            if (unit === 'day') {
                if (days.length) return keep;
                return simple ? { ...base, mode: 'daily' } : { ...base, mode: 'custom', custom };
            }
            if (unit === 'week') {
                if (!plain) return keep;
                const set = days.length ? days.map((d) => WD.indexOf(d)) : [wd];
                if (simple && set.length === 5 && [1, 2, 3, 4, 5].every((d) => set.includes(d))) return { ...base, mode: 'weekdays' };
                if (simple && set.length === 1 && set[0] === wd) return { ...base, mode: 'weekly' };
                return { ...base, mode: 'custom', custom: { ...custom, days: [...new Set(set)].sort() } };
            }
            if (unit === 'month') {
                const date = Number(startDay.slice(8, 10));
                if (p.BYMONTHDAY && days.length) return keep;
                if (p.BYMONTHDAY) {
                    if (Number(p.BYMONTHDAY) !== date) return keep;
                    return simple ? { ...base, mode: 'monthly' } : { ...base, mode: 'custom', custom: { ...custom, monthBy: 'day' } };
                }
                if (days.length === 0) return simple ? { ...base, mode: 'monthly' } : { ...base, mode: 'custom', custom: { ...custom, monthBy: 'day' } };
                const m = days.length === 1 ? /^(-?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(days[0]) : null;
                if (!m || !m[1] || WD.indexOf(m[2]) !== wd) return keep;
                const n = Number(m[1]);
                const at = nthOf(startDay);
                if (n === -1 && at.last) return simple ? { ...base, mode: 'monthly-last' } : { ...base, mode: 'custom', custom: { ...custom, monthBy: 'last' } };
                if (n === at.n && n <= 4) return simple ? { ...base, mode: 'monthly-nth' } : { ...base, mode: 'custom', custom: { ...custom, monthBy: 'nth' } };
                return keep;
            }
            if (days.length || p.BYMONTHDAY) return keep;
            return simple ? { ...base, mode: 'yearly' } : { ...base, mode: 'custom', custom };
        }

        /** The rule for the Repeat field's state and the event's start ('' for none). */
        function ruleFromRepeat(repeat, startDay, allDay, zone) {
            const wd = weekdayOf(startDay);
            const { n } = nthOf(startDay);
            const date = Number(startDay.slice(8, 10));
            switch (repeat.mode) {
                case 'none': return '';
                case 'keep': return repeat.keep ?? '';
                case 'daily': return 'FREQ=DAILY';
                case 'weekly': return `FREQ=WEEKLY;BYDAY=${WD[wd]}`;
                case 'weekdays': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
                case 'monthly': return `FREQ=MONTHLY;BYMONTHDAY=${date}`;
                case 'monthly-nth': return `FREQ=MONTHLY;BYDAY=${n}${WD[wd]}`;
                case 'monthly-last': return `FREQ=MONTHLY;BYDAY=-1${WD[wd]}`;
                case 'yearly': return 'FREQ=YEARLY';
                case 'custom': {
                    const c = repeat.custom;
                    const parts = [`FREQ=${{ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[c.unit] ?? 'WEEKLY'}`];
                    if (c.interval > 1) parts.push(`INTERVAL=${c.interval}`);
                    if (c.unit === 'week') parts.push(`BYDAY=${[...new Set(c.days.length ? c.days : [wd])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD[d]).join(',')}`);
                    if (c.unit === 'month') parts.push(c.monthBy === 'nth' ? `BYDAY=${Math.min(n, 4)}${WD[wd]}` : c.monthBy === 'last' ? `BYDAY=-1${WD[wd]}` : `BYMONTHDAY=${date}`);
                    if (c.end === 'after') parts.push(`COUNT=${c.count}`);
                    if (c.end === 'on' && isDay(c.until)) parts.push(`UNTIL=${untilValue(c.until, allDay, zone)}`);
                    return parts.join(';');
                }
                default: return '';
            }
        }

        /** What's wrong with a custom rule, or ''. */
        function repeatProblem(repeat, startDay) {
            if (repeat.mode !== 'custom') return '';
            const c = repeat.custom;
            if (!Number.isInteger(c.interval) || c.interval < 1 || c.interval > 999) return 'Repeat every 1 to 999.';
            if (c.unit === 'week' && c.days.length === 0) return 'Pick at least one day of the week.';
            if (c.end === 'after' && (!Number.isInteger(c.count) || c.count < 1 || c.count > 9999)) return 'End after 1 to 9999 times.';
            if (c.end === 'on' && (!isDay(c.until) || c.until < startDay)) return 'The end date is on or after the start.';
            return '';
        }

        // ── Placing events ─────────────────────────────────────────────────

        /**
         * Where a day's timed events go across its column. Events that start
         * close together (within `nestAfter` minutes) share the width side by
         * side; one that starts well into another is drawn over it, indented,
         * so the first keeps its width (and its title stays readable). Where
         * more start together than `maxCols` side by side, the last place
         * says how many more there are ("+N") for each run of those left out.
         * @param items - [{key, from, to}], minutes into the day.
         * @param minLength - the shortest an event is drawn, in minutes.
         * @param maxCols - the most events side by side.
         * @returns {places: Map key → {left, width, level}, more: [{key, left, width, level, from, to, count}]}: fractions of
         *   the column, how deep it is drawn over others, and the "+N" places (minutes into the day).
         */
        function columnsOf(items, minLength = 20, nestAfter = 30, maxCols = Infinity) {
            const indent = 0.14;
            const sorted = [...items].sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
            // Groups of events side by side: where they start, how deep, each column's end, who is in which column.
            const groups = [];
            for (const item of sorted) {
                const end = Math.max(item.to, item.from + minLength);
                const running = groups.filter((g) => g.ends.some((e) => e > item.from));
                const latest = running.at(-1);
                if (latest === undefined) {
                    groups.push({ start: item.from, level: 0, ends: [end], members: [{ item, col: 0, end }] });
                    continue;
                }
                const free = latest.ends.findIndex((e) => e <= item.from);
                if (free >= 0) {
                    latest.ends[free] = end;
                    latest.members.push({ item, col: free, end });
                } else if (item.from - latest.start < nestAfter) {
                    latest.ends.push(end);
                    latest.members.push({ item, col: latest.ends.length - 1, end });
                } else {
                    groups.push({ start: item.from, level: Math.max(...running.map((g) => g.level)) + 1, ends: [end], members: [{ item, col: 0, end }] });
                }
            }
            const places = new Map();
            const more = [];
            const cap = Math.max(2, maxCols);
            for (const g of groups) {
                const left = Math.min(g.level * indent, 0.56);
                const crowded = g.ends.length > cap;
                const slots = crowded ? cap : g.ends.length;
                const shown = crowded ? cap - 1 : slots;
                const width = (1 - left) / slots;
                const hidden = [];
                for (const member of g.members) {
                    if (member.col < shown) places.set(member.item.key, { left: left + member.col * width, width, level: g.level });
                    else hidden.push(member);
                }
                // The ones left out, in runs that overlap: one "+N" each, in the last place.
                hidden.sort((a, b) => a.item.from - b.item.from);
                let run = null;
                for (const { item, end } of hidden) {
                    if (run && item.from < run.to) {
                        run.to = Math.max(run.to, end);
                        run.count += 1;
                        continue;
                    }
                    run = { key: `more:${g.level}:${item.from}`, left: left + shown * width, width, level: g.level, from: item.from, to: end, count: 1 };
                    more.push(run);
                }
            }
            return { places, more };
        }

        /**
         * Bars over a row of days, in lanes: each item takes the lowest lane
         * free on all its days.
         * @param items - [{key, a, b}], first and last day index in the row (inclusive).
         * @param days - how many days the row has.
         * @returns {placed: [{key, a, b, lane}], lanes, perDay: count per day}.
         */
        function lanesOf(items, days) {
            const sorted = [...items].sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a) || (x.order ?? 0) - (y.order ?? 0));
            const taken = [];
            const placed = [];
            const perDay = new Array(days).fill(0);
            for (const item of sorted) {
                let lane = 0;
                for (;;) {
                    const row = taken[lane] ?? (taken[lane] = new Array(days).fill(false));
                    let free = true;
                    for (let d = item.a; d <= item.b; d++) if (row[d]) { free = false; break; }
                    if (free) {
                        for (let d = item.a; d <= item.b; d++) row[d] = true;
                        break;
                    }
                    lane++;
                }
                for (let d = item.a; d <= item.b; d++) perDay[d]++;
                placed.push({ ...item, lane });
            }
            return { placed, lanes: taken.length, perDay };
        }

        /**
         * What a row shows in `cap` lanes: on a day with more than fit, the
         * last lane says "+N more" instead; a bar shows on the days its lane
         * shows, split where it doesn't.
         * @returns {pieces: [{key, a, b, lane, contStart, contEnd}], more: [{day, count}]}
         */
        function fitLanes(layout, cap) {
            const visible = layout.perDay.map((count) => (count > cap ? Math.max(0, cap - 1) : cap));
            const pieces = [];
            for (const item of layout.placed) {
                let run = null;
                for (let d = item.a; d <= item.b + 1; d++) {
                    const shows = d <= item.b && item.lane < visible[d];
                    if (shows && run === null) run = d;
                    if (!shows && run !== null) {
                        pieces.push({ ...item, a: run, b: d - 1, contStart: run > item.a || item.contStart === true, contEnd: d - 1 < item.b || item.contEnd === true });
                        run = null;
                    }
                }
            }
            const more = [];
            layout.perDay.forEach((count, day) => {
                if (count > cap) more.push({ day, count: count - visible[day], lane: visible[day] });
            });
            return { pieces, more };
        }

        // ── The store ──────────────────────────────────────────────────────

        /**
         * What every view shows, read from the host half: state() (accounts,
         * calendars, the user's zone and choices), and the events of each span
         * a view asks for. While a view watches and the window is visible, the
         * host's version() is asked every 4 s (every 12 s when only the Agenda
         * pane shows); state() is read again when it moves (a sync, a change
         * here or by an agent), and every minute all the same, and the events
         * with it. Changes go through act(), which reads both again. Also the
         * page's way to an event (openAt), its toasts, notices that stay until
         * the user closes them, and events' titles by id.
         * @param link - the plugin's endpoints (hostLink).
         */
        function calendarStore(link) {
            const listeners = new Set();
            let version = 0;
            let state;
            let stateJson = '';
            let stateError = '';
            /** The code of the last failed state() ('calendar/off' while the plugin is switched off). */
            let stateCode = '';
            let loading;
            /** When state() was last read, for the read every minute whatever version() says. */
            let stateAt = 0;
            let watchers = 0;
            /** Watchers that want the 4 s step (the page); the Agenda pane alone is asked after every 12 s. */
            let fastWatchers = 0;
            let timer;
            let polling = false;
            /** Spans of events: `${from}:${to}` → {from, to, data?, error, loading, stale}, the most recently used last. */
            const spans = new Map();
            let target = null;
            let targetSeq = 0;
            let toast = null;
            let toastSeq = 0;
            let toastTimer;
            /** The views showing toasts now (the page, the pane): the first one shows them, so each shows once. */
            const toastHosts = new Set();
            /** Titles of events the chat cards name by id, asked of the host: id → title ('' while asked, or unknown). */
            const titles = new Map();
            /** Notices that stay until the user closes them (a move that stopped halfway): [{id, text}], the newest last. */
            let notices = [];
            let noticeSeq = 0;
            /** The default calendar the user chose here last, so its move isn't announced as one they didn't make. */
            let chosenDefault;
            const emit = () => {
                version++;
                for (const listener of [...listeners]) {
                    try { listener(); } catch (error) { warn('a view could not update', error); }
                }
            };
            const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
            const onVisible = () => { if (visible()) void poll(); };

            /** What moved on the host, cheaply (version()); state() read again when it did, or after a minute. */
            async function poll() {
                if (polling || !visible()) return;
                polling = true;
                try {
                    if (state === undefined || Date.now() - stateAt >= 60_000) {
                        await loadState();
                        return;
                    }
                    const result = await link.call('version', {});
                    // A host without version() (or a failed ask): state() itself, as before.
                    if (!result.ok || !isObject(result.value)) await loadState();
                    else if (result.value.version !== state.version || Boolean(result.value.syncing) !== Boolean(state.syncing)) await loadState();
                } finally {
                    polling = false;
                }
            }
            const schedule = () => {
                clearTimeout(timer);
                if (watchers === 0 || typeof window === 'undefined') return;
                timer = setTimeout(() => { void poll().finally(schedule); }, fastWatchers > 0 ? 4000 : 12000);
            };

            function loadState() {
                if (loading) return loading;
                loading = (async () => {
                    const result = await link.call('state', {});
                    loading = undefined;
                    if (result.ok) stateAt = Date.now();
                    if (result.ok && isObject(result.value)) {
                        const json = JSON.stringify(result.value);
                        const moved = state !== undefined && state.version !== result.value.version;
                        if (json === stateJson && stateError === '') return;
                        // New events now go elsewhere, and not by the user's choice here (an account added): said once.
                        const was = state?.defaultCalendar;
                        const now = result.value.defaultCalendar;
                        if (was && now && was !== now && chosenDefault !== now) {
                            const named = (id) => (Array.isArray(result.value.calendars) ? result.value.calendars : []).find((c) => c?.id === id)?.name;
                            const [to, from] = [named(now), named(was)];
                            if (to) setTimeout(() => store.toast(`New events now go to “${to}”.${from ? ` To keep them in “${from}”, choose Use for new events in its menu.` : ''}`), 0);
                        }
                        state = result.value;
                        stateJson = json;
                        stateError = '';
                        stateCode = '';
                        if (moved) for (const entry of spans.values()) entry.stale = true;
                    } else {
                        const text = errorText(result.error);
                        const code = String(result.error?.code ?? '');
                        // Switched off: what was shown goes, and the page says it's off; it comes back on its own.
                        const off = code === 'calendar/off' && state !== undefined;
                        if (off) {
                            state = undefined;
                            stateJson = '';
                            spans.clear();
                        }
                        if (text === stateError && code === stateCode && !off) return;
                        stateError = text;
                        stateCode = code;
                    }
                    emit();
                })();
                return loading;
            }

            /** state() read after now: a read already on its way may have left before a change. */
            async function freshState() {
                if (loading) await loading;
                stateJson = '';
                return loadState();
            }

            async function fetchSpan(entry) {
                entry.loading = true;
                entry.stale = false;
                const result = await link.call('events', { from: entry.from, to: entry.to });
                entry.loading = false;
                if (result.ok && isObject(result.value) && Array.isArray(result.value.occurrences)) {
                    entry.data = result.value;
                    entry.error = '';
                } else {
                    entry.error = errorText(result.error);
                }
                if (entry.stale && spans.has(`${entry.from}:${entry.to}`)) void fetchSpan(entry);
                emit();
            }

            const store = {
                link,
                subscribe(listener) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                snapshot: () => version,
                /** state() as last read, or undefined before the first answer. */
                state: () => state,
                stateError: () => stateError,
                /** Whether the plugin is switched off (enabled: false in its entry): the owner's choice, not a failure. */
                stateOff: () => stateCode === 'calendar/off',
                /** The user's zone: the plugin's (its setting, else the computer's), else this browser's. */
                zone: () => (state && isZone(state.zone) ? state.zone : browserZone()),
                calendar: (id) => (state?.calendars ?? EMPTY).find((c) => c.id === id),
                /** An event's title by its id (or an occurrence's): from the events read, else asked of the host once; '' until known. */
                titleOf(id) {
                    if (typeof id !== 'string' || id === '') return '';
                    for (const entry of spans.values()) {
                        const o = entry.data?.occurrences?.find((x) => x?.id === id || x?.eventId === id);
                        if (o) return String(o.title || TEXT.noTitle);
                    }
                    if (!titles.has(id)) {
                        titles.set(id, '');
                        while (titles.size > 100) titles.delete(titles.keys().next().value);
                        void link.call('event', { id }).then((result) => {
                            const title = result.ok && isObject(result.value?.occurrence) ? String(result.value.occurrence.title || TEXT.noTitle) : '';
                            if (title === '') return;
                            titles.set(id, title);
                            emit();
                        });
                    }
                    return titles.get(id) ?? '';
                },
                account: (id) => (state?.accounts ?? EMPTY).find((a) => a.id === id),
                loadState,
                /** Ask the host now what moved, as watch() does on its step. */
                poll,
                /** Keep state fresh while a view shows (fast: every 4 s, else every 12 s); returns the stop. */
                watch(fast = true) {
                    watchers++;
                    if (fast) fastWatchers++;
                    if (watchers === 1 && typeof window !== 'undefined') {
                        document.addEventListener('visibilitychange', onVisible);
                        window.addEventListener('focus', onVisible);
                    }
                    void loadState();
                    schedule();
                    return () => {
                        watchers--;
                        if (fast) fastWatchers--;
                        if (watchers === 0 && typeof window !== 'undefined') {
                            clearTimeout(timer);
                            document.removeEventListener('visibilitychange', onVisible);
                            window.removeEventListener('focus', onVisible);
                        } else {
                            schedule();
                        }
                    };
                },
                /**
                 * The events in [from, to) of the shown calendars, as last read:
                 * {data?: {occurrences, more}, error, loading}. Reads them when
                 * they aren't here yet or are out of date.
                 */
                events(from, to) {
                    const key = `${from}:${to}`;
                    let entry = spans.get(key);
                    if (entry === undefined) {
                        entry = { from, to, error: '', loading: false, stale: true };
                    } else {
                        spans.delete(key);
                    }
                    spans.set(key, entry);
                    while (spans.size > 24) spans.delete(spans.keys().next().value);
                    if (entry.stale && !entry.loading && state !== undefined) void fetchSpan(entry);
                    return entry;
                },
                /** Read everything again (a Retry). */
                async refresh() {
                    for (const entry of spans.values()) entry.stale = true;
                    await freshState();
                    emit();
                },
                /** Call an endpoint that changes something, then read state and events again: its answer. */
                async act(method, args) {
                    const result = await link.call(method, args);
                    if (result.ok) {
                        for (const entry of spans.values()) entry.stale = true;
                        await freshState();
                        emit();
                    }
                    return result;
                },
                /**
                 * The user's own choices (setPrefs: weekends, week numbers, the week's first day): shown at once, then
                 * saved, and state read again either way, so a refusal puts back what the host has.
                 */
                async choose(patch) {
                    if (isObject(state) && isObject(state.prefs)) {
                        state = { ...state, prefs: { ...state.prefs, ...patch } };
                        stateJson = '';
                        emit();
                    }
                    const result = await link.call('setPrefs', { patch });
                    await freshState();
                    emit();
                    return result;
                },
                /** Ask the page to show an event: its day, then its details. */
                openAt(occurrence) {
                    if (!isObject(occurrence) || typeof occurrence.id !== 'string') return;
                    target = { ...occurrence, seq: ++targetSeq };
                    emit();
                },
                /** The user chose this calendar for new events here: its move is theirs, not news. */
                choseDefault(id) {
                    chosenDefault = id;
                },
                target: () => target,
                clearTarget(seq) {
                    if (target?.seq === seq) target = null;
                },
                toast(text, tone = 'ok') {
                    const id = ++toastSeq;
                    toast = { text, tone, id };
                    clearTimeout(toastTimer);
                    // DSH's Toast says when it has faded (clearToast); this is only a backstop.
                    toastTimer = setTimeout(() => store.clearToast(id), toastHold(tone) + 1500);
                    emit();
                },
                currentToast: () => toast,
                /** The toast has gone (DSH's Toast faded out); a newer one stays. */
                clearToast(id) {
                    if (toast?.id !== id) return;
                    toast = null;
                    clearTimeout(toastTimer);
                    emit();
                },
                /** A notice that stays on the page until the user closes it: what a change did in part, and what is left to do. */
                keepNotice(text) {
                    notices = [...notices, { id: ++noticeSeq, text: String(text) }].slice(-5);
                    emit();
                },
                notices: () => notices,
                closeNotice(id) {
                    notices = notices.filter((n) => n.id !== id);
                    emit();
                },
                /** A view that shows toasts, while it's there; returns the leave. */
                hostToasts(id) {
                    toastHosts.add(id);
                    emit();
                    return () => {
                        toastHosts.delete(id);
                        emit();
                    };
                },
                toastHost: () => (toastHosts.size ? Math.min(...toastHosts) : 0),
                /**
                 * The reminders due now that no window has shown, claimed for this one (remote.reminders), and the
                 * user's zone: {list, zone}; none when the host can't say (switched off, an older host).
                 */
                async reminders() {
                    const result = await link.call('reminders', {});
                    const list = result.ok && Array.isArray(result.value?.reminders) ? result.value.reminders.filter((r) => isObject(r) && isObject(r.reminder) && Number.isFinite(r.start)) : [];
                    return { list, zone: isZone(result.value?.zone) ? result.value.zone : store.zone() };
                },
            };
            return store;
        }

        /** How long a toast holds before it fades (DSH's Toast fades over a second after it): a failure holds longer. */
        const toastHold = (tone) => (tone === 'error' ? 6000 : 3000);
        /** DSH's Toast for one of the store's toasts: a done one with DSH's green check, a failure with its warning glyph. */
        const toastProps = (toast, onDone) => ({
            text: toast.text, holdMs: toastHold(toast.tone), onDone,
            ...(toast.tone === 'error' ? { icon: icon('IconWarningOutlineRegular') } : { tone: 'success' }),
        });

        /** Re-render with the store. */
        const useStore = (store) => React.useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
        /** Keep state fresh while this view shows; fast: the page's 4 s step, else the pane's slower one. */
        function useWatch(store, on = true, fast = true) {
            React.useEffect(() => (on ? store.watch(fast) : undefined), [store, on, fast]);
        }
        /** Now, on a step (the current-time line, the agenda's "now"). */
        function useNow(stepMs = 30_000, on = true) {
            const [now, setNow] = React.useState(() => Date.now());
            React.useEffect(() => {
                if (!on) return undefined;
                setNow(Date.now());
                const id = setInterval(() => setNow(Date.now()), stepMs);
                return () => clearInterval(id);
            }, [stepMs, on]);
            return now;
        }
        /** An element's width, as it changes. */
        function useWidth(ref) {
            const [width, setWidth] = React.useState(0);
            React.useLayoutEffect(() => {
                const el = ref.current;
                if (!el || typeof ResizeObserver === 'undefined') return undefined;
                setWidth(el.clientWidth);
                const observer = new ResizeObserver(() => setWidth(el.clientWidth));
                observer.observe(el);
                return () => observer.disconnect();
            }, [ref]);
            return width;
        }
        /** Whether this component is still mounted, for answers that come after it closed. */
        function useAlive() {
            const alive = React.useRef(true);
            React.useEffect(() => {
                alive.current = true;
                return () => { alive.current = false; };
            }, []);
            return alive;
        }

        // ── Small parts ────────────────────────────────────────────────────

        const svg = (size, children, props = {}) => h('svg', {
            width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false', ...props,
        }, ...children);
        /** The Calendar entry's icon, drawn like DSH's own (16 px grid, 1 px stroke): a calendar page. */
        function CalendarIcon({ size = 16 }) {
            return svg(size, [
                h('rect', { key: 'a', x: 2, y: 3, width: 12, height: 11, rx: 2 }),
                h('path', { key: 'b', d: 'M2 6.5h12M5.5 1.5v3M10.5 1.5v3' }),
                h('path', { key: 'c', d: 'M5 9.5h1M7.5 9.5h1M10 9.5h1M5 11.8h1M7.5 11.8h1' }),
            ], { strokeWidth: 1 });
        }
        const PinGlyph = ({ size = 14 }) => svg(size, [h('path', { key: 'a', d: 'M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8z' }), h('circle', { key: 'b', cx: 8, cy: 6.5, r: 1.6 })]);
        const VideoGlyph = ({ size = 14 }) => svg(size, [h('rect', { key: 'a', x: 1.5, y: 4, width: 9.5, height: 8, rx: 1.8 }), h('path', { key: 'b', d: 'M11 7l3.5-2v6L11 9' })]);
        const RepeatGlyph = ({ size = 14 }) => svg(size, [h('path', { key: 'a', d: 'M2.5 7V6a2 2 0 0 1 2-2h8.5l-2-2M13.5 9v1a2 2 0 0 1-2 2H3l2 2' })]);
        const LockGlyph = ({ size = 14 }) => svg(size, [h('rect', { key: 'a', x: 3, y: 7, width: 10, height: 7, rx: 1.6 }), h('path', { key: 'b', d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' })]);
        const NotesGlyph = ({ size = 14 }) => svg(size, [h('path', { key: 'a', d: 'M3 3.5h10M3 6.5h10M3 9.5h10M3 12.5h6' })]);
        const BellGlyph = ({ size = 14 }) => svg(size, [h('path', { key: 'a', d: 'M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3L4 11zM6.5 14a1.6 1.6 0 0 0 3 0' })]);
        const CalendarGlyph = ({ size = 14 }) => h(CalendarIcon, { size });

        function Spinner({ size = 14 }) {
            return h('span', { className: 'dshcal-spin', 'aria-hidden': true }, icon('IconLoadingOutlineRegular', { size }) ?? svg(size, [h('path', { key: 'a', d: 'M8 2a6 6 0 1 0 6 6' })]));
        }

        function Btn({ kind, size, iconOnly, className, children, ...rest }) {
            const classes = ['dshcal-btn', kind ? `dshcal-btn-${kind}` : '', size === 'sm' ? 'dshcal-btn-sm' : '', iconOnly ? 'dshcal-btn-icon' : '', className ?? ''].filter(Boolean).join(' ');
            return h('button', { type: 'button', className: classes, ...rest }, children);
        }
        /** An icon button with its name as a tooltip. */
        function IconBtn({ label, glyph, tip = true, side = 'bottom', size, ...rest }) {
            const button = h(Btn, { iconOnly: true, kind: 'ghost', size, 'aria-label': label, ...rest }, glyph);
            return tip && ui.Tooltip ? h(ui.Tooltip, { label, side, portal: true }, button) : button;
        }

        let toastHostSeq = 0;
        /**
         * The store's toast as DSH's own Toast: its banner at the top of the window, clear of a dialog's buttons and
         * click-through, one at a time, shown by one view. A failure holds longer and keeps DSH's warning glyph. On a
         * DSH without the Toast part, the plugin draws the same banner itself.
         */
        function ToastHost({ store }) {
            useStore(store);
            const [id] = React.useState(() => ++toastHostSeq);
            React.useEffect(() => store.hostToasts(id), [store, id]);
            const toast = store.currentToast();
            if (!toast || store.toastHost() !== id) return null;
            const failed = toast.tone === 'error';
            if (ui.Toast) return h(ui.Toast, { key: toast.id, ...toastProps(toast, () => store.clearToast(toast.id)) });
            return ReactDOM.createPortal(h('div', { className: 'dshcal-toast', role: 'alert', 'data-tone': toast.tone, key: toast.id },
                failed ? icon('IconWarningOutlineRegular') : icon('IconCheckCircleOutlineRegular'),
                h('span', null, toast.text)), document.body);
        }

        /** How often a window in front asks for the reminders due, and how long a reminder's banner holds. */
        const REMINDER_STEP = 30_000;
        const REMINDER_HOLD = 30_000;

        /**
         * A reminder in words for DSH's banner: 'Team sync in 10 min · 10:00 – 10:30 AM, Work', 'Team sync starts
         * now · …', 'Team sync started 3 minutes ago · …', 'Dentist tomorrow · 3:00 – 3:45 PM, Personal';
         * all day: 'Holiday tomorrow · All day, Personal'.
         */
        function reminderText(o, now, zone) {
            const title = o.title || '(No title)';
            const today = dayIn(now, zone);
            const dayWord = (day) => (day === today ? 'today' : day === addDays(today, 1) ? 'tomorrow' : `on ${dayText(day)}`);
            const where = o.calendar ? `, ${o.calendar}` : '';
            if (o.allDay) return `${title} ${dayWord(o.startDay)} · ${TEXT.allDay}${where}`;
            const m = Math.round((o.start - now) / MINUTE);
            const day = dayIn(o.start, zone);
            const lead = m < 0 ? `started ${plural(-m, 'minute')} ago` : m === 0 ? 'starts now' : day !== today || m >= 12 * 60 ? dayWord(day) : untilWords(o.start, now);
            return `${title} ${lead} · ${shortWhen(o, zone)}${where}`;
        }

        /**
         * The line under the page's header for accounts that couldn't sync: {id (the account's, '' for several), text,
         * fix: 'retry' | 'accounts'}; null when every account is fine. One account: its name, why, and when it last
         * synced; several: how many and which. One that needs signing in again is fixed in Accounts, the rest by Retry.
         */
        function troubleWords(attention) {
            const list = (Array.isArray(attention) ? attention : []).filter((a) => isObject(a) && typeof a.name === 'string');
            if (list.length === 0) return null;
            const fix = list.some((a) => a.status === 'signin') ? 'accounts' : 'retry';
            if (list.length > 1) return { id: '', text: `${plural(list.length, 'account')} couldn't sync: ${andList(list.map((a) => a.name))}.`, fix };
            const [a] = list;
            const why = stopped(a.error || (a.status === 'signin' ? 'it needs signing in again' : 'the last sync failed'));
            return { id: String(a.id ?? ''), text: `${a.name}: ${why}${Number.isFinite(a.syncedAt) ? ` Last synced ${relativeText(a.syncedAt)}.` : ''}`, fix };
        }

        /** The wrong settings in one box: {head, lines: [{key, text}]}, or null when none is wrong. */
        function settingsWords(problems) {
            const lines = (Array.isArray(problems) ? problems : []).filter((p) => isObject(p) && typeof p.key === 'string' && typeof p.text === 'string')
                .map((p) => ({ key: p.key, text: p.text }));
            if (lines.length === 0) return null;
            const one = lines.length === 1;
            return {
                head: `${one ? 'A setting of the calendar plugin is wrong' : `${lines.length} settings of the calendar plugin are wrong`}; change ${one ? 'it' : 'them'} in its entry (id: calendar) in this profile's cordis.patch.yml:`,
                lines,
            };
        }

        /** A web address opened outside DSH's window, as the Agenda pane's Join link opens it. */
        function openLink(url) {
            try {
                window.open(url, '_blank', 'noopener,noreferrer');
            } catch (error) {
                warn('could not open the link', error);
            }
        }

        /**
         * The calendars' reminders, in every DSH window while it is in front: every half minute it asks the host
         * for the reminders due (remote.reminders, which hands each to one window, once), and shows each as DSH's
         * banner at the top of the window, one after another, with Open (the event on the Calendar page) and Join
         * for a call. Nothing while the window is hidden: a reminder still due waits for it, one long over is
         * never shown. Mounted in DSH's shell overlay, so it needs no page or pane open.
         */
        function ReminderHost({ cal }) {
            const [queue, setQueue] = React.useState([]);
            const shown = React.useRef(new Set());
            React.useEffect(() => {
                if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
                let stopped = false;
                let timer;
                const front = () => document.visibilityState !== 'hidden';
                const ask = async () => {
                    clearTimeout(timer);
                    if (stopped) return;
                    if (front()) {
                        let due = { list: [], zone: cal.store.zone() };
                        try {
                            due = await cal.store.reminders();
                        } catch (error) {
                            warn('could not ask for reminders', error);
                        }
                        const fresh = due.list.filter((r) => !shown.current.has(r.reminder.key));
                        for (const r of fresh) shown.current.add(r.reminder.key);
                        if (!stopped && fresh.length > 0) setQueue((q) => [...q, ...fresh.map((r) => ({ ...r, zone: due.zone }))]);
                    }
                    if (!stopped) timer = setTimeout(() => void ask(), REMINDER_STEP);
                };
                const onVisible = () => { if (front()) void ask(); };
                timer = setTimeout(() => void ask(), 2000);
                document.addEventListener('visibilitychange', onVisible);
                return () => {
                    stopped = true;
                    clearTimeout(timer);
                    document.removeEventListener('visibilitychange', onVisible);
                };
            }, [cal]);
            const first = queue[0];
            if (!first) return null;
            const done = () => setQueue((q) => q.filter((r) => r.reminder.key !== first.reminder.key));
            const actions = [
                { label: 'Open', onClick: () => { done(); cal.openAt(first); } },
                ...(isUrl(first.conference) ? [{ label: 'Join', onClick: () => { done(); openLink(first.conference); } }] : []),
            ];
            const text = reminderText(first, Date.now(), first.zone);
            if (ui.Toast) {
                return h(ui.Toast, { key: first.reminder.key, text, holdMs: REMINDER_HOLD, actions, onDone: done, icon: icon('IconClockOutlineRegular') ?? h(BellGlyph) });
            }
            return ReactDOM.createPortal(h('div', { className: 'dshcal-toast dshcal-toast-acts', role: 'status', 'data-calendar-reminder': first.reminder.key, key: first.reminder.key },
                h(BellGlyph), h('span', null, text),
                actions.map((a) => h('button', { key: a.label, type: 'button', className: 'dshcal-link', onClick: a.onClick }, a.label)),
                h('button', { type: 'button', className: 'dshcal-link', onClick: done }, TEXT.close)), document.body);
        }

        /** A dialog: DSH's Modal on the plugin's glass, its content scrolling inside. */
        function Dialog({ title, description, narrow, wide, onClose, footer, children, busy }) {
            return h(ui.Modal, {
                open: true, title, description, closeLabel: TEXT.close,
                className: `dshcal-dlg${narrow ? ' dshcal-dlg-narrow' : wide ? ' dshcal-dlg-wide' : ''}`, contentClassName: 'dshcal-dlg-content',
                onClose: () => { if (!busy) onClose(); },
                footer,
            }, children);
        }

        const Alert = ({ text }) => (text ? h('div', { className: 'dshcal-alert', role: 'alert' }, icon('IconWarningOutlineRegular'), h('span', null, text)) : null);

        /** A name for a new calendar, or a calendar's or an account's new name. */
        function NameDialog({ title, label, initial = '', action, onSubmit, onClose }) {
            const [draft, setDraft] = React.useState(initial);
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const clean = draft.replace(/\s+/g, ' ').trim();
            const submit = async () => {
                if (busy || clean === '') return;
                if (clean === initial) {
                    onClose();
                    return;
                }
                setBusy(true);
                setError('');
                const problem = await onSubmit(clean);
                if (!alive.current) return;
                setBusy(false);
                if (problem) setError(problem);
                else onClose();
            };
            return h(Dialog, {
                title, narrow: true, onClose, busy,
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', disabled: busy, onClick: onClose }, TEXT.cancel),
                    h(ui.Button, { variant: 'primary', disabled: busy || clean === '', onClick: () => void submit(), 'data-calendar-submit': '' }, action)),
            },
            h('div', { className: 'dshcal-form' },
                h('input', {
                    className: 'dshcal-input', value: draft, 'aria-label': label, placeholder: label, maxLength: 120, 'data-modal-autofocus': true, disabled: busy,
                    onFocus: (event) => event.target.select(),
                    onChange: (event) => { setDraft(event.target.value); setError(''); },
                    onKeyDown: (event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void submit();
                        }
                    },
                }),
                h(Alert, { text: error })));
        }

        /** A question before something goes away. */
        function ConfirmDialog({ title, text, action, danger = true, onSubmit, onClose, children }) {
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const submit = async () => {
                if (busy) return;
                setBusy(true);
                setError('');
                const problem = await onSubmit();
                if (!alive.current) return;
                setBusy(false);
                if (problem) setError(problem);
                else onClose();
            };
            return h(Dialog, {
                title, description: text, narrow: true, onClose, busy,
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', disabled: busy, onClick: onClose, 'data-modal-autofocus': true }, TEXT.cancel),
                    h(ui.Button, { variant: danger ? 'outline' : 'primary', className: danger ? 'dshcal-btn-danger' : undefined, disabled: busy, onClick: () => void submit(), 'data-calendar-submit': '' }, busy ? h(Spinner) : null, action)),
            }, children || error ? h('div', { className: 'dshcal-form' }, children, h(Alert, { text: error })) : undefined);
        }

        /** A question's words by what the change does: its buttons, and what guests get when the host doesn't say. */
        const CONSENT_WORDS = {
            add: { no: 'Don\'t add', yes: 'Add', email: 'Add and email', what: 'invitations' },
            save: { no: 'Don\'t save', yes: 'Save', email: 'Save and email', what: 'an update' },
            move: { no: 'Don\'t move', yes: 'Move', email: 'Move and email', what: 'an update' },
            delete: { no: 'Don\'t delete', yes: 'Delete', email: 'Delete and email', what: 'a cancellation' },
            // Someone else's invitation whose organizer lets guests change it: Google makes a change to it for everyone on it.
            invitation: {
                no: 'Don\'t save', yes: 'Save', email: 'Save and email', what: 'an update', many: 'people', manyOwn: 'people\'s',
                why: { change: 'Its organizer lets guests change it, so Google makes your change for everyone on it, without an email.' },
            },
        };

        /**
         * The words for a change: 'add', 'save', 'move' or 'delete', or 'invitation' (a change to someone else's
         * invitation). A "Don't …" button label reads the same.
         */
        function consentWords(action) {
            if (Object.hasOwn(CONSENT_WORDS, action)) return CONSENT_WORDS[action];
            const words = String(action ?? '').toLowerCase();
            return words.includes('delete') ? CONSENT_WORDS.delete : words.includes('add') ? CONSENT_WORDS.add
                : words.includes('move') ? CONSENT_WORDS.move : CONSENT_WORDS.save;
        }

        /** What a guest's Google calendar gets without an email, by how: the question, and each person's line. */
        const REACH_ASK = { add: 'put it on', remove: 'take it off', change: 'change it on' };
        const REACH_WHY = {
            add: 'Google puts a meeting on its guests\' calendars by itself, without an email.',
            remove: 'Google takes a meeting off its guests\' calendars by itself, without an email.',
            change: 'Google changes a meeting on its guests\' calendars by itself, without an email.',
        };
        const REACH_GETS = { add: 'Added to their calendar, no email', remove: 'Taken off their calendar, no email', change: 'Changed on their calendar, no email' };

        /** Addresses in a list from the host, once each. */
        function addressList(list) {
            const out = new Map();
            for (const p of Array.isArray(list) ? list : EMPTY) if (typeof p === 'string' && p.trim() !== '' && !out.has(p.toLowerCase())) out.set(p.toLowerCase(), p);
            return [...out.values()];
        }

        /**
         * The question before a change that emails or reaches people, from the
         * host's refusal ('calendar/needs-approval', 'needs-notify', 'changed'):
         * everyone it names, each with what they get, and why.
         * → {code, title, why, changed, people: [{email, gets, emailed, fresh}], no, yes}.
         * @param error - the refusal: details {people, mail: {emailed?: {what, to}, reached?: {how, to}, why?}}.
         * @param action - 'add', 'save', 'move', 'delete' or 'invitation' (consentWords).
         * @param [before] - who the last question named: anyone else is marked new.
         */
        function consentQuestion(error, action, before) {
            const words = consentWords(action);
            const details = isObject(error?.details) ? error.details : {};
            const mail = isObject(details.mail) ? details.mail : null;
            const emailedTo = new Set(addressList(mail?.emailed?.to).map((p) => p.toLowerCase()));
            const reachedTo = new Set(addressList(mail?.reached?.to).map((p) => p.toLowerCase()));
            const what = typeof mail?.emailed?.what === 'string' && mail.emailed.what.trim() ? mail.emailed.what.trim() : words.what;
            const how = Object.hasOwn(REACH_ASK, mail?.reached?.how) ? mail.reached.how : 'change';
            const seen = Array.isArray(before) ? new Set(before.map((p) => String(p).toLowerCase())) : null;
            const gets = what === 'invitations' ? 'An invitation' : what.replace(/^./, (c) => c.toUpperCase());
            const people = addressList([...(Array.isArray(details.people) ? details.people : EMPTY), ...(mail?.emailed?.to ?? EMPTY), ...(mail?.reached?.to ?? EMPTY)]).map((email) => {
                const key = email.toLowerCase();
                // Reached only when the host says so; anyone else it names (an older host names them alone) is emailed.
                const emailed = emailedTo.has(key) || !reachedTo.has(key);
                return { email, emailed, gets: emailed ? gets : REACH_GETS[how], fresh: seen !== null && !seen.has(key) };
            });
            const mailed = people.filter((p) => p.emailed);
            const whom = (list, one, many) => (list.length === 1 ? one(list[0].email) : many(list.length));
            const title = mailed.length > 0
                ? `Email ${what} to ${whom(mailed, (e) => e, (n) => `${n} ${words.many ?? 'guests'}`)}?`
                : `Also ${REACH_ASK[how]} ${whom(people, (e) => `${e}'s Google calendar`, (n) => `${n} ${words.manyOwn ?? 'guests\''} Google calendars`)}?`;
            const reason = typeof mail?.why === 'string' && mail.why.trim() ? mail.why.trim() : '';
            const why = mailed.length > 0
                ? (reason ? `${reason.replace(/^./, (c) => c.toUpperCase())}${/[.!?]$/.test(reason) ? '' : '.'}` : mail ? 'You chose to tell them by email.' : '')
                : words.why?.[how] ?? REACH_WHY[how];
            return {
                code: String(error?.code ?? '').replace(/^calendar\//, ''),
                title, why, people,
                changed: error?.code === 'calendar/changed',
                no: words.no,
                yes: mailed.length > 0 ? words.email : words.yes,
            };
        }

        /**
         * Before a change emails or reaches people: everyone it names, with
         * what each gets, and why (and for a dragged event, where it goes:
         * question.move); then the change or not. Not making it has the first
         * focus.
         */
        function ConsentDialog({ question, onYes, onClose }) {
            const q = question;
            const long = q.people.length > 8;
            return h(Dialog, {
                title: q.title, description: q.why || undefined, narrow: true, onClose,
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', onClick: onClose, 'data-modal-autofocus': true, 'data-calendar-keep': '' }, q.no),
                    h(ui.Button, { variant: 'primary', onClick: onYes, 'data-calendar-send': '' }, q.yes)),
            },
            h('div', { className: 'dshcal-form', 'data-calendar-consent': q.code },
                q.move ? h('div', { 'data-calendar-consent-move': '' }, q.move) : null,
                q.changed ? h('div', { className: 'dshcal-hint dshcal-warn', 'data-calendar-consent-changed': '' },
                    'It changed meanwhile, on its server or in another app, so nothing was done yet. This is everyone it reaches now.') : null,
                q.people.length ? h('ul', {
                    className: 'dshcal-people', 'data-calendar-people': '', 'aria-label': 'Who it reaches', tabIndex: long ? 0 : undefined,
                    // Home and End go to the list's ends, whatever the browser does with them.
                    onKeyDown: long ? (event) => {
                        if (event.key !== 'Home' && event.key !== 'End') return;
                        event.preventDefault();
                        event.currentTarget.scrollTop = event.key === 'Home' ? 0 : event.currentTarget.scrollHeight;
                    } : undefined,
                }, q.people.map((p) => h('li', { key: p.email, 'data-calendar-person': p.email },
                    h('span', { className: 'dshcal-person' }, p.email),
                    p.fresh ? h('span', { className: 'dshcal-tag', 'data-calendar-person-new': '' }, 'New') : null,
                    h('span', { className: 'dshcal-gets' }, p.gets)))) : null));
        }

        /** Before a series moves to a calendar that would drop some of it: the host's words (what it drops), then Move anyway or not. */
        function DropDialog({ text, onYes, onClose }) {
            return h(Dialog, {
                title: 'Move it anyway?', description: text, narrow: true, onClose,
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', onClick: onClose, 'data-modal-autofocus': true, 'data-calendar-dont-move': '' }, 'Don\'t move it'),
                    h(ui.Button, { variant: 'primary', onClick: onYes, 'data-calendar-move-anyway': '' }, 'Move anyway')),
            });
        }

        /** Before an event's dialog closes with changes not saved: Keep editing (the first focus) or Discard. */
        function DiscardDialog({ onDiscard, onClose }) {
            return h(Dialog, {
                title: 'Discard your changes?', narrow: true, onClose,
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', onClick: onClose, 'data-modal-autofocus': true, 'data-calendar-keep-editing': '' }, 'Keep editing'),
                    h(ui.Button, { variant: 'outline', className: 'dshcal-btn-danger', onClick: onDiscard, 'data-calendar-discard': '' }, 'Discard')),
            });
        }

        /**
         * The questions a change can need before it's made, for a view to
         * show: {ask(question) → Promise<boolean: yes>, drop(text) →
         * Promise<boolean: Move anyway>, dialog}. question: consentQuestion's.
         */
        function useSendQuestion() {
            const [question, setQuestion] = React.useState(null);
            const ask = React.useCallback((q) => new Promise((resolve) => setQuestion({ kind: 'send', q, resolve })), []);
            const drop = React.useCallback((text) => new Promise((resolve) => setQuestion({ kind: 'drop', text, resolve })), []);
            const answer = (yes) => {
                question?.resolve(yes);
                setQuestion(null);
            };
            const q = question?.kind === 'send' && !isObject(question.q) ? { title: 'Send the email?', why: String(question.q ?? ''), people: EMPTY, no: TEXT.cancel, yes: 'Send', code: '' } : question?.q;
            return {
                ask,
                drop,
                dialog: question === null ? null
                    : question.kind === 'drop' ? h(DropDialog, { text: question.text, onYes: () => answer(true), onClose: () => answer(false) })
                        : h(ConsentDialog, { question: q, onYes: () => answer(true), onClose: () => answer(false) }),
            };
        }

        /** What the user's answers add to a change's call: notify when it tells people (ticked, or said yes to), approved and dropChanges when given. */
        function asked(tell, { notify, approved, dropChanges } = {}) {
            return {
                ...(notify === true || tell === true ? { notify: true } : {}),
                ...(Array.isArray(approved) ? { approved } : {}),
                ...(dropChanges === true ? { dropChanges: true } : {}),
            };
        }

        /** Why a change stopped asking: each yes came back naming someone new. */
        const KEEPS_CHANGING = 'It keeps changing on its server or in another app, so nothing was done. Look at it again first.';

        /**
         * A change the user asked for, made by make(how) only as they say:
         * `how` ({notify?, approved?, dropChanges?}) is what their answers add
         * to its call.
         * - 'calendar/needs-approval' (it would email or reach people, and
         *   doesn't say who the user saw) or 'calendar/needs-notify' (the
         *   server would email them anyway): the question names every one of
         *   them, with what they get (ask), and only yes makes it again, with
         *   approved: those people, and notify for needs-notify (otherwise
         *   notify stays as it was).
         * - 'calendar/changed' naming people (it would now reach someone else):
         *   asked again, naming them all. Naming no one (nobody new), it is
         *   the result, for the user to look at the event again.
         * - 'calendar/drops-changes': a series move that would drop part of it
         *   asks with the host's words first (drop); Move anyway adds dropChanges.
         * Five calls at most: a host that would still ask after them (someone
         * new each time, as the event keeps changing) stops it there.
         * → the result; {ok: false, kept: true, error} when the user said no;
         * {ok: false, stopped: true, error} when it stopped, error being
         * 'calendar/changed' in the window's words (KEEPS_CHANGING).
         * @param ask - (question) → Promise<boolean>: useSendQuestion's.
         * @param action - 'add', 'save', 'move' or 'delete': the question's words.
         * @param make - ({notify?, approved?, dropChanges?}) → the call's result.
         * @param [drop] - (text) → Promise<boolean>: whether to move a series anyway.
         */
        async function withConsent(ask, action, make, drop) {
            let how = {};
            let shown;
            for (let round = 0; ; round += 1) {
                const result = await make(how);
                if (result.ok) return result;
                const error = result.error;
                const code = error?.code;
                const drops = code === 'calendar/drops-changes' && typeof drop === 'function' && how.dropChanges !== true;
                const people = Array.isArray(error?.details?.people) ? addressList(error.details.people) : undefined;
                // Approval is for people named: a refusal that names no one is shown as it is.
                const asks = code === 'calendar/needs-notify' || (people?.length > 0 && (code === 'calendar/needs-approval' || code === 'calendar/changed'));
                if (!drops && !asks) return result;
                if (round >= 4) return { ok: false, stopped: true, error: { code: 'calendar/changed', message: KEEPS_CHANGING } };
                if (drops) {
                    if (!(await drop(errorText(error)))) return { ok: false, kept: true, error };
                    how = { ...how, dropChanges: true };
                    continue;
                }
                if (!(await ask(consentQuestion(error, action, shown)))) return { ok: false, kept: true, error };
                how = { ...how, ...(code === 'calendar/needs-notify' ? { notify: true } : {}), ...(people !== undefined ? { approved: people } : {}) };
                shown = people;
            }
        }

        const SCOPE_TEXT = {
            one: { title: 'This event', text: 'Only this occurrence.' },
            following: { title: 'This and following events', text: 'This occurrence and the ones after it.' },
            all: { title: 'All events', text: 'Every occurrence in the series.' },
        };

        /**
         * Which occurrences of a repeating event a change, a delete or an
         * answer reaches, among those it can (the occurrence's `scopes`).
         * tellFor(scope): the box to tick to tell people by email for that
         * choice {label, hint?, quiet?}, or null for none. quiet: what
         * happens all the same while the box is unticked.
         */
        function ScopeDialog({ title, scopes, note, action, danger, tellFor, onSubmit, onClose }) {
            const [scope, setScope] = React.useState(scopes[0]);
            const [told, setTell] = React.useState(false);
            const box = typeof tellFor === 'function' ? tellFor(scope) : null;
            const tell = box !== null && told;
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const submit = async () => {
                if (busy) return;
                setBusy(true);
                setError('');
                const problem = await onSubmit(scope, tell);
                if (!alive.current) return;
                setBusy(false);
                if (problem) setError(problem);
                else onClose();
            };
            return h(Dialog, {
                title, narrow: true, onClose, busy,
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', disabled: busy, onClick: onClose }, TEXT.cancel),
                    h(ui.Button, { variant: danger ? 'outline' : 'primary', className: danger ? 'dshcal-btn-danger' : undefined, disabled: busy, onClick: () => void submit(), 'data-calendar-submit': '' }, busy ? h(Spinner) : null, action)),
            },
            h('div', { className: 'dshcal-form' },
                h('div', { className: 'dshcal-options', role: 'radiogroup', 'aria-label': title },
                    scopes.map((s, i) => h('label', { key: s, className: 'dshcal-option' },
                        h('input', { type: 'radio', name: 'dshcal-scope', checked: scope === s, onChange: () => setScope(s), 'data-modal-autofocus': i === 0 ? true : undefined, 'data-calendar-scope': s }),
                        h('div', null, h('b', null, SCOPE_TEXT[s].title), h('span', null, SCOPE_TEXT[s].text))))),
                note ? h('div', { className: 'dshcal-hint' }, note) : null,
                box ? h('div', { className: 'dshcal-tell' },
                    h('label', { className: 'dshcal-check' }, h('input', { type: 'checkbox', checked: tell, onChange: (e) => setTell(e.target.checked), 'data-calendar-notify': '' }), box.label),
                    box.hint ? h('div', { className: 'dshcal-hint' }, box.hint) : null,
                    box.quiet && !tell ? h('div', { className: 'dshcal-hint', 'data-calendar-mail': 'reach' }, box.quiet) : null) : null,
                h(Alert, { text: error })));
        }

        /** A calendar's color: the palette, or any color. */
        function ColorDialog({ calendar, onSubmit, onClose }) {
            const [color, setColor] = React.useState(colorOf(calendar.color));
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const submit = async () => {
                setBusy(true);
                const problem = await onSubmit(color);
                if (!alive.current) return;
                setBusy(false);
                if (problem) setError(problem);
                else onClose();
            };
            return h(Dialog, {
                title: `Color of “${calendar.name}”`, narrow: true, onClose, busy,
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', disabled: busy, onClick: onClose }, TEXT.cancel),
                    h(ui.Button, { variant: 'primary', disabled: busy, onClick: () => void submit() }, TEXT.save)),
            },
            h('div', { className: 'dshcal-form' },
                h('div', { className: 'dshcal-swatches', role: 'radiogroup', 'aria-label': 'Colors' },
                    PALETTE.map((c, i) => h('button', {
                        key: c, type: 'button', className: 'dshcal-swatch', style: { '--sw': c }, role: 'radio', 'aria-checked': color.toLowerCase() === c, 'aria-label': `Color ${i + 1}`,
                        'data-modal-autofocus': i === 0 ? true : undefined, onClick: () => setColor(c),
                    }))),
                h('label', { className: 'dshcal-inline' },
                    h('input', { type: 'color', className: 'dshcal-color-input', value: color, onChange: (e) => setColor(e.target.value) }),
                    h('span', { className: 'dshcal-hint' }, 'Any other color')),
                h(Alert, { text: error })));
        }

        // ── The event dialog: a new event, a change, a duplicate ───────────

        /** The reminders offered first, in minutes before the start. */
        const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 1440];
        const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
        const isTime = (text) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(text ?? ''));

        /**
         * The calendars a new event can go to, and the one it goes to unless
         * the user picks another: the host's default, or '' when there is
         * none (nothing chosen, and no main calendar stands out), and the user
         * picks one.
         */
        function writableCalendars(state, keep = EMPTY) {
            const writable = (state?.calendars ?? EMPTY).filter((c) => !c.readOnly);
            // A hidden calendar would hide what's saved to it: offered only as the event's own or the default,
            // or when no shown calendar can be written.
            const shown = writable.filter((c) => !c.hidden || keep.includes(c.id) || c.id === state?.defaultCalendar);
            const list = shown.length > 0 ? shown : writable;
            const chosen = list.find((c) => c.id === state?.defaultCalendar);
            return { list, defaultId: chosen?.id ?? '' };
        }

        // ── Who a change emails ────────────────────────────────────────────
        // The host decides. Where a calendar's server emails guests only when asked (Google), the dialogs offer a box
        // to tick; where it emails them anyway (Microsoft, a CalDAV server for a meeting the user organizes), the host
        // refuses the change ('calendar/needs-notify') and the user is asked, with its words, before it is made again
        // with notify. notify: true is sent only after the user's own click: the box, or Send. Send holds the change to
        // the people the refusal named (approved): if the event changed meanwhile so that it would reach anyone else,
        // the host makes nothing ('calendar/changed') and the user looks at it again. Google puts a meeting on its
        // guests' calendars by itself (reached), which the toasts say.

        /** The user's part in an event: 'guest' (someone else's invitation), 'organizer', or 'own' (nobody named as organizer). */
        function roleOf(o) {
            if (o?.invitation === true || o?.canRespond === true) return 'guest';
            return String(o?.organizer?.email ?? '').trim() === '' ? 'own' : 'organizer';
        }

        /** The people on an event other than the user. */
        const othersOf = (list) => (list ?? EMPTY).filter((p) => p && p.email && p.self !== true);

        /**
         * Whether a change can email people, as far as the window can tell:
         * {mode: 'none' | 'ask' (a box the user ticks) | 'always' (the server
         * emails them anyway: the user is asked when the host says so), to:
         * 'guests' | 'organizer', cannot: true when there are guests the
         * calendar can't email}.
         * @param kind - 'create', 'update' or 'delete'.
         * @param guests - how many other people the event has (before or after the change).
         */
        function mailMode({ kind, calendar, occurrence, guests = 0, scope = 'all' }) {
            const emails = calendar?.canEmail === true;
            const server = calendar?.kind;
            if (occurrence && roleOf(occurrence) === 'guest') {
                // Someone else's invitation: only taking it out of the calendar can tell its organizer (a decline).
                if (kind !== 'delete' || !emails || server === 'microsoft') return { mode: 'none', to: 'organizer' };
                return { mode: server === 'caldav' && scope !== 'all' ? 'always' : 'ask', to: 'organizer' };
            }
            if (guests === 0) return { mode: 'none', to: 'guests' };
            if (!emails) return { mode: 'none', to: 'guests', cannot: kind !== 'delete' };
            if (server === 'google') return { mode: 'ask', to: 'guests' };
            // A CalDAV server emails the guests of a meeting the user organizes; telling them makes it one.
            if (server === 'caldav' && (!occurrence || roleOf(occurrence) === 'own')) return { mode: kind === 'delete' ? 'none' : 'ask', to: 'guests' };
            return { mode: 'always', to: 'guests' };
        }

        /** Under the guests, where their server emails them anyway. */
        function alwaysWords(kind, calendar) {
            const who = calendar?.kind === 'microsoft' ? 'Microsoft' : 'Your calendar server';
            if (kind === 'create') return `${who} emails the guests their invitations when it's saved. You'll be asked first.`;
            return `${who} emails a meeting's guests about changes to it. You'll be asked first.`;
        }

        /** People in words: up to three addresses, then how many more. */
        function peopleText(list, all = false) {
            const people = (list ?? EMPTY).filter((v) => typeof v === 'string' && v !== '');
            const shown = all ? people : people.slice(0, 3);
            const more = people.length - shown.length;
            if (more > 0) return `${shown.join(', ')} and ${plural(more, 'other')}`;
            return shown.length <= 1 ? (shown[0] ?? 'no one') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
        }

        /**
         * The occurrence a moved event's other changes go to: the one the user
         * was changing (its date part), in the event as the move left it.
         */
        function sameOccurrence(moved, before) {
            if (!isObject(moved) || typeof moved.id !== 'string') return before;
            const dot = String(before?.id ?? '').indexOf('.');
            const eventId = typeof moved.eventId === 'string' && moved.eventId ? moved.eventId : moved.id.split('.')[0];
            return dot < 0 ? moved : { ...moved, id: `${eventId}.${before.id.slice(dot + 1)}` };
        }

        /** What the user may change on someone else's invitation: their reminders, whether it shows them as busy, whether it's private (and the box to tell). */
        const OWN_FIELDS = ['alarms', 'busy', 'private', 'notify'];

        /** Whether a change's answer is an occurrence the page can show and follow (one the host lost sight of is its id alone). */
        const placed = (o) => isObject(o) && typeof o.id === 'string' && (o.allDay === true ? isDay(o.startDay) : Number.isFinite(o.start));

        /** Who a change emailed, as a sentence ('Emailed an update to ann@example.com.'), or ''. all: everyone by name, not three and a number. */
        function emailedText(emailed, all = false) {
            if (!isObject(emailed) || !Array.isArray(emailed.to) || emailed.to.length === 0) return '';
            return `Emailed ${String(emailed.what || 'them')} to ${peopleText(emailed.to, all)}.`;
        }

        const REACHED_WORDS = { add: 'Put on', remove: 'Taken off', change: 'Changed on' };

        /**
         * Who a change emailed, and whose calendars it reached without email
         * (Google puts a meeting on its guests' calendars, changes it there and
         * takes it off them by itself), as sentences, or ''.
         * @param result - a change's result: {emailed?: {what, to}, reached?: {how: 'add'|'remove'|'change', to}}.
         * @param [options] - all: name everyone (a chat's record), not three and a number (a toast).
         */
        function contactText(result, { all = false } = {}) {
            const emailed = emailedText(result?.emailed, all);
            const r = result?.reached;
            const to = isObject(r) && Array.isArray(r.to) ? r.to.filter((p) => typeof p === 'string' && p !== '') : EMPTY;
            const reached = to.length ? `${REACHED_WORDS[r.how] ?? 'Changed on'} the calendars of ${peopleText(to, all)}${emailed ? '' : ', without emailing anyone'}.` : '';
            return [emailed, reached].filter(Boolean).join(' ');
        }

        /** What the event dialog says on its calendar select when the host wants the calendar named ('calendar/choose-calendar'). */
        const CHOOSE_CALENDAR = 'Choose the calendar it goes to.';

        /** A guest as the dialog keeps one: {email, name?, self?}. */
        const guestOf = (p) => ({ email: String(p.email ?? ''), ...(p.name ? { name: p.name } : {}), ...(p.self ? { self: true } : {}) });

        /**
         * The dialog's draft: from an occurrence (a change, or a duplicate),
         * or a new event's from what was clicked or dragged (`preset`). Times
         * are wall clocks in the event's own zone.
         */
        function draftFrom({ occurrence, preset, state, zone, duplicate = false }) {
            const { list, defaultId } = writableCalendars(state, occurrence && !duplicate ? [occurrence.calendarId] : EMPTY);
            if (occurrence) {
                const o = occurrence;
                const tz = o.allDay ? zone : (isZone(o.timeZone) || o.timeZone === 'UTC' ? o.timeZone : zone);
                const startDay = o.allDay ? o.startDay : String(o.startLocal ?? toLocal(o.start, tz)).slice(0, 10);
                const endDay = o.allDay ? (o.lastDay ?? o.startDay) : String(o.endLocal ?? toLocal(o.end, tz)).slice(0, 10);
                const calendarOk = list.some((c) => c.id === o.calendarId);
                return {
                    title: o.title === TEXT.noTitle ? '' : String(o.title ?? ''),
                    allDay: o.allDay === true,
                    startDay,
                    startTime: o.allDay ? '09:00' : String(o.startLocal ?? toLocal(o.start, tz)).slice(11, 16),
                    endDay,
                    endTime: o.allDay ? '10:00' : String(o.endLocal ?? toLocal(o.end, tz)).slice(11, 16),
                    timeZone: tz,
                    repeat: repeatFromRule(o.repeat, startDay, o.allDay, tz),
                    calendarId: duplicate && !calendarOk ? defaultId : o.calendarId,
                    location: String(o.location ?? ''),
                    url: String(o.url ?? ''),
                    description: String(o.description ?? ''),
                    alarms: [...(o.alarms ?? EMPTY)].filter((m) => Number.isInteger(m)).sort((a, b) => a - b),
                    guests: (o.attendees ?? EMPTY).filter((p) => p && p.email).map(guestOf),
                    busy: o.busy !== false,
                    private: o.privacy === 'private' || o.privacy === 'confidential',
                    notify: null,
                };
            }
            const p = preset ?? {};
            const now = Date.now();
            const today = dayIn(now, zone);
            const day = isDay(p.startDay) ? p.startDay : today;
            let startTime = isTime(p.startTime) ? p.startTime : undefined;
            if (!startTime) {
                const nextHour = day === today ? Math.min(23, Math.floor(minutesIn(now, zone) / 60) + 1) : 9;
                startTime = `${pad(nextHour)}:00`;
            }
            const endWall = wallMs(`${day}T${startTime}`) + HOUR;
            return {
                title: '',
                allDay: p.allDay === true,
                startDay: day,
                startTime,
                endDay: isDay(p.endDay) ? p.endDay : (p.allDay ? day : wallOf(endWall).slice(0, 10)),
                endTime: isTime(p.endTime) ? p.endTime : wallOf(endWall).slice(11, 16),
                timeZone: zone,
                repeat: { mode: 'none', custom: customFrom(day) },
                calendarId: p.calendarId && list.some((c) => c.id === p.calendarId) ? p.calendarId : defaultId,
                location: '',
                url: '',
                description: '',
                alarms: [],
                guests: [],
                busy: true,
                private: false,
                notify: null,
            };
        }

        /** How long a draft lasts, in minutes (all-day: whole days). */
        const draftLength = (d) => (d.allDay ? daysBetween(d.startDay, d.endDay) * 1440 : (wallMs(`${d.endDay}T${d.endTime}`) - wallMs(`${d.startDay}T${d.startTime}`)) / MINUTE);

        /** The draft's start and end as the host takes them: days (the end is the last day), or wall clocks. */
        const draftStart = (d) => (d.allDay ? d.startDay : `${d.startDay}T${d.startTime}`);
        const draftEnd = (d) => (d.allDay ? d.endDay : `${d.endDay}T${d.endTime}`);

        /**
         * What's wrong with a draft: {field: message}, empty when nothing is.
         * @param writable - how many calendars it can go to, when known.
         */
        function draftProblems(d, writable) {
            const out = {};
            if (d.title.trim() === '') out.title = 'Give the event a title.';
            if (!isDay(d.startDay)) out.start = 'Pick the day it starts.';
            if (!isDay(d.endDay)) out.end = 'Pick the day it ends.';
            if (!d.allDay) {
                if (!isTime(d.startTime)) out.start = 'Pick the time it starts.';
                if (!isTime(d.endTime)) out.end = 'Pick the time it ends.';
                if (!isZone(d.timeZone) && d.timeZone !== 'UTC') out.timeZone = 'Pick a time zone from the list, like Europe/Berlin.';
            }
            if (!out.start && !out.end && !out.timeZone) {
                if (d.allDay ? d.endDay < d.startDay : toInstant(`${d.endDay}T${d.endTime}`, d.timeZone) < toInstant(`${d.startDay}T${d.startTime}`, d.timeZone)) out.end = 'The end is before the start.';
            }
            if (d.url.trim() !== '' && !isUrl(d.url.trim())) out.url = 'A link starts with https:// or http://.';
            const repeat = repeatProblem(d.repeat, d.startDay);
            if (repeat) out.repeat = repeat;
            if (!d.calendarId) out.calendarId = writable === 0 ? 'There is no calendar that can be written. Add an account or a calendar first.' : CHOOSE_CALENDAR;
            return out;
        }

        /** A new event's input for createEvent. */
        function createInput(d) {
            const rule = ruleFromRepeat(d.repeat, d.startDay, d.allDay, d.timeZone);
            const input = { calendarId: d.calendarId, title: d.title.trim(), allDay: d.allDay, start: draftStart(d), end: draftEnd(d) };
            if (!d.allDay) input.timeZone = d.timeZone;
            for (const key of ['location', 'description', 'url']) if (d[key].trim() !== '') input[key] = d[key].trim();
            if (rule) input.repeat = rule;
            if (d.alarms.length) input.alarms = [...d.alarms];
            if (d.guests.length) {
                input.attendees = d.guests.map((g) => (g.name ? { email: g.email, name: g.name } : g.email));
                if (d.notify === true) input.notify = true;
            }
            if (!d.busy) input.busy = false;
            if (d.private) input.privacy = 'private';
            return input;
        }

        const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
        const normalRule = (text) => String(text ?? '').trim().replace(/^RRULE:/i, '').toUpperCase();

        /** A change's patch for updateEvent: only what differs from how the event was. */
        function changePatch(initial, d, { repeatTouched, originalRule }) {
            const patch = {};
            if (d.title.trim() !== initial.title.trim()) patch.title = d.title.trim();
            if (['allDay', 'startDay', 'startTime', 'endDay', 'endTime', 'timeZone'].some((k) => d[k] !== initial[k])) {
                patch.allDay = d.allDay;
                patch.start = draftStart(d);
                patch.end = draftEnd(d);
                if (!d.allDay) patch.timeZone = d.timeZone;
            }
            for (const key of ['location', 'description', 'url']) {
                if (d[key].trim() !== initial[key].trim()) patch[key] = d[key].trim() === '' ? null : d[key].trim();
            }
            if (repeatTouched) {
                const rule = ruleFromRepeat(d.repeat, d.startDay, d.allDay, d.timeZone);
                if (normalRule(rule) !== normalRule(originalRule)) patch.repeat = rule === '' ? null : rule;
            }
            if (!sameSet(d.alarms.map(String), initial.alarms.map(String))) patch.alarms = [...d.alarms];
            const emails = (list) => list.map((g) => g.email.toLowerCase());
            if (!sameSet(emails(d.guests), emails(initial.guests))) patch.attendees = d.guests.map((g) => (g.name ? { email: g.email, name: g.name } : g.email));
            if (d.busy !== initial.busy) patch.busy = d.busy;
            if (d.private !== initial.private) patch.privacy = d.private ? 'private' : 'public';
            if (Object.keys(patch).length > 0 && d.notify === true && (d.guests.length > 0 || initial.guests.length > 0)) patch.notify = true;
            return patch;
        }

        /** Whether a draft differs from how the dialog opened, in anything saving would keep: closing it then asks first. */
        function draftChanged(initial, d) {
            return d.calendarId !== initial.calendarId || JSON.stringify(d.repeat) !== JSON.stringify(initial.repeat)
                || Object.keys(changePatch(initial, d, { repeatTouched: false })).length > 0;
        }

        /** A labelled field with its problem under it. */
        function Field({ label, id, error, hint, children, className }) {
            return h('div', { className: `dshcal-field${className ? ` ${className}` : ''}` },
                label ? h('label', { htmlFor: id }, label) : null,
                children,
                error ? h('div', { className: 'dshcal-field-error', id: `${id}-error` }, error) : hint ? h('div', { className: 'dshcal-hint' }, hint) : null);
        }

        /** The Repeat field and, for Custom…, its rule. */
        function RepeatField({ d, set, error, originalWords, onTouch, weekStart }) {
            const choices = repeatChoices(d.startDay);
            if (d.repeat.mode === 'keep') choices.splice(1, 0, { value: 'keep', label: `${originalWords || 'Repeats'} (as it is)` });
            const c = d.repeat.custom;
            const setRepeat = (repeat) => {
                onTouch();
                set({ repeat });
            };
            const setCustom = (patch) => setRepeat({ ...d.repeat, mode: 'custom', custom: { ...c, ...patch } });
            const units = [['day', 'day', 'days'], ['week', 'week', 'weeks'], ['month', 'month', 'months'], ['year', 'year', 'years']];
            const wd = weekdayOf(d.startDay);
            const { n, last } = nthOf(d.startDay);
            return h(Field, { label: 'Repeat', id: 'dshcal-repeat', error },
                h('select', {
                    id: 'dshcal-repeat', className: 'dshcal-select', value: d.repeat.mode, 'data-calendar-repeat': '', 'aria-invalid': error ? true : undefined,
                    'aria-describedby': error ? 'dshcal-repeat-error' : undefined,
                    onChange: (event) => setRepeat({ ...d.repeat, mode: event.target.value }),
                }, choices.map((choice) => h('option', { key: choice.value, value: choice.value }, choice.label))),
                d.repeat.mode === 'custom' ? h('div', { className: 'dshcal-custom', 'data-calendar-custom-repeat': '' },
                    h('div', { className: 'dshcal-inline' },
                        h('span', null, 'Every'),
                        h('input', {
                            className: 'dshcal-input dshcal-num', type: 'number', min: 1, max: 999, value: Number.isFinite(c.interval) ? c.interval : '', 'aria-label': 'Every how many',
                            onChange: (event) => setCustom({ interval: Number.parseInt(event.target.value, 10) }),
                        }),
                        h('select', {
                            className: 'dshcal-select', value: c.unit, 'aria-label': 'Unit',
                            onChange: (event) => setCustom({ unit: event.target.value }),
                        }, units.map(([value, one, many]) => h('option', { key: value, value }, c.interval === 1 ? one : many)))),
                    c.unit === 'week' ? h('div', { className: 'dshcal-wdays', role: 'group', 'aria-label': 'On these days' },
                        [0, 1, 2, 3, 4, 5, 6].map((i) => (weekStart + i) % 7).map((day) => h('button', {
                            key: day, type: 'button', 'aria-pressed': c.days.includes(day), 'aria-label': weekdayName(day), title: weekdayName(day),
                            onClick: () => setCustom({ days: c.days.includes(day) ? c.days.filter((x) => x !== day) : [...c.days, day] }),
                        }, weekdayName(day, 'narrow')))) : null,
                    c.unit === 'month' ? h('div', { className: 'dshcal-options', role: 'radiogroup', 'aria-label': 'On' },
                        h('label', { className: 'dshcal-radio' }, h('input', { type: 'radio', name: 'dshcal-monthby', checked: c.monthBy === 'day', onChange: () => setCustom({ monthBy: 'day' }) }), `On day ${Number(d.startDay.slice(8, 10))}`),
                        n <= 4 ? h('label', { className: 'dshcal-radio' }, h('input', { type: 'radio', name: 'dshcal-monthby', checked: c.monthBy === 'nth', onChange: () => setCustom({ monthBy: 'nth' }) }), `On the ${ORDINALS[n]} ${weekdayName(wd)}`) : null,
                        last ? h('label', { className: 'dshcal-radio' }, h('input', { type: 'radio', name: 'dshcal-monthby', checked: c.monthBy === 'last', onChange: () => setCustom({ monthBy: 'last' }) }), `On the last ${weekdayName(wd)}`) : null) : null,
                    h('div', { className: 'dshcal-options', role: 'radiogroup', 'aria-label': 'Ends' },
                        h('span', { className: 'dshcal-label' }, 'Ends'),
                        h('label', { className: 'dshcal-radio' }, h('input', { type: 'radio', name: 'dshcal-ends', checked: c.end === 'never', onChange: () => setCustom({ end: 'never' }) }), 'Never'),
                        h('label', { className: 'dshcal-radio' },
                            h('input', { type: 'radio', name: 'dshcal-ends', checked: c.end === 'on', onChange: () => setCustom({ end: 'on' }) }), 'On',
                            h('input', { className: 'dshcal-input', type: 'date', value: c.until, style: { width: 'auto' }, 'aria-label': 'Last day', onChange: (event) => setCustom({ end: 'on', until: event.target.value }) })),
                        h('label', { className: 'dshcal-radio' },
                            h('input', { type: 'radio', name: 'dshcal-ends', checked: c.end === 'after', onChange: () => setCustom({ end: 'after' }) }), 'After',
                            h('input', {
                                className: 'dshcal-input dshcal-num', type: 'number', min: 1, max: 9999, value: Number.isFinite(c.count) ? c.count : '', 'aria-label': 'How many times',
                                onChange: (event) => setCustom({ end: 'after', count: Number.parseInt(event.target.value, 10) }),
                            }), 'times'))) : null);
        }

        /** Reminders: the ones set, and a way to add another. */
        function RemindersField({ alarms, onChange }) {
            const [custom, setCustom] = React.useState(false);
            const [amount, setAmount] = React.useState('20');
            const [unit, setUnit] = React.useState('1');
            const add = (minutes) => {
                if (!Number.isInteger(minutes) || minutes < 0 || minutes > 40320 || alarms.includes(minutes)) return;
                onChange([...alarms, minutes].sort((a, b) => a - b));
            };
            const left = REMINDER_CHOICES.filter((m) => !alarms.includes(m));
            return h(Field, { label: 'Reminders', id: 'dshcal-reminder-add' },
                alarms.length ? h('div', { className: 'dshcal-chips', 'data-calendar-reminders': '' },
                    alarms.map((m) => h('span', { key: m, className: 'dshcal-chip' },
                        h('span', null, reminderWords(m)),
                        h('button', { type: 'button', 'aria-label': `Remove the reminder ${reminderWords(m).toLowerCase()}`, onClick: () => onChange(alarms.filter((x) => x !== m)) }, icon('IconCloseOutlineRegular', { size: 12 }))))) : null,
                h('div', { className: 'dshcal-inline' },
                    h('select', {
                        id: 'dshcal-reminder-add', className: 'dshcal-select', value: '', style: { width: 'auto' }, 'data-calendar-reminder-add': '',
                        onChange: (event) => {
                            const value = event.target.value;
                            if (value === 'custom') setCustom(true);
                            else if (value !== '') add(Number(value));
                        },
                    },
                    h('option', { value: '' }, alarms.length ? 'Add another reminder…' : 'Add a reminder…'),
                    left.map((m) => h('option', { key: m, value: String(m) }, reminderWords(m))),
                    h('option', { value: 'custom' }, 'Custom…')),
                    custom ? h(React.Fragment, null,
                        h('input', { className: 'dshcal-input dshcal-num', type: 'number', min: 1, max: 999, value: amount, 'aria-label': 'How long before', onChange: (event) => setAmount(event.target.value) }),
                        h('select', { className: 'dshcal-select', value: unit, 'aria-label': 'Unit', onChange: (event) => setUnit(event.target.value) },
                            h('option', { value: '1' }, 'minutes before'), h('option', { value: '60' }, 'hours before'), h('option', { value: '1440' }, 'days before'), h('option', { value: '10080' }, 'weeks before')),
                        h(Btn, {
                            size: 'sm',
                            onClick: () => {
                                const minutes = Number.parseInt(amount, 10) * Number(unit);
                                if (Number.isInteger(minutes) && minutes > 0) {
                                    add(Math.min(40320, minutes));
                                    setCustom(false);
                                }
                            },
                        }, 'Add')) : null));
        }

        /**
         * Guests: their addresses and a way to add more (not on someone else's
         * invitation), and whether to email them.
         * @param mail - {mode: 'ask', label, checked, onChange, quiet?}: the box to tick (quiet: what saving does
         *   without it); {mode: 'always', hint}: their server emails them anyway; {cannot: true}: the calendar can't
         *   email them.
         */
        function GuestsField({ guests, onChange, readOnly, mail, error, setError }) {
            const [text, setText] = React.useState('');
            const addFrom = (raw) => {
                const words = String(raw).split(/[\s,;]+/).map((w) => w.replace(/^<|>$/g, '').trim()).filter(Boolean);
                const bad = words.filter((w) => !EMAIL.test(w));
                const have = new Set(guests.map((g) => g.email.toLowerCase()));
                const fresh = words.filter((w) => EMAIL.test(w) && !have.has(w.toLowerCase()));
                if (fresh.length) onChange([...guests, ...[...new Set(fresh)].map((email) => ({ email }))]);
                setText(bad.join(' '));
                setError(bad.length ? `“${bad[0]}” isn't an email address.` : '');
            };
            return h(Field, { label: 'Guests', id: 'dshcal-guest', error },
                guests.length ? h('div', { className: 'dshcal-chips', 'data-calendar-guests': '' },
                    guests.map((g) => h('span', { key: g.email, className: 'dshcal-chip', title: g.email },
                        h('span', null, g.name ? `${g.name} <${g.email}>` : g.email, g.self ? ' (you)' : ''),
                        readOnly ? null : h('button', { type: 'button', 'aria-label': `Remove ${g.email}`, onClick: () => onChange(guests.filter((x) => x !== g)) }, icon('IconCloseOutlineRegular', { size: 12 }))))) : null,
                readOnly ? h('div', { className: 'dshcal-hint' }, 'Only the organizer changes who\'s invited.') : h('div', { className: 'dshcal-inline', style: { flexWrap: 'nowrap' } },
                    h('input', {
                        id: 'dshcal-guest', className: 'dshcal-input dshcal-grow', type: 'email', multiple: true, value: text, placeholder: 'name@example.com', autoComplete: 'off', 'data-calendar-guest-input': '',
                        'aria-invalid': error ? true : undefined, 'aria-describedby': error ? 'dshcal-guest-error' : undefined,
                        onChange: (event) => { setText(event.target.value); setError(''); },
                        onKeyDown: (event) => {
                            if ((event.key === 'Enter' || event.key === ',' || event.key === ';') && !event.nativeEvent.isComposing) {
                                if (text.trim() === '') return;
                                event.preventDefault();
                                addFrom(text);
                            }
                        },
                        onBlur: () => { if (text.trim() !== '') addFrom(text); },
                    }),
                    h(Btn, { size: 'sm', disabled: text.trim() === '', onClick: () => addFrom(text) }, 'Add')),
                mail?.mode === 'ask' ? h('div', { className: 'dshcal-tell' },
                    h('label', { className: 'dshcal-check' },
                        h('input', { type: 'checkbox', checked: mail.checked, onChange: (event) => mail.onChange(event.target.checked), 'data-calendar-notify': '' }),
                        mail.label),
                    mail.quiet ? h('div', { className: 'dshcal-hint', 'data-calendar-mail': 'reach' }, mail.quiet) : null)
                    : mail?.mode === 'always' ? h('div', { className: 'dshcal-hint', 'data-calendar-mail': 'always' }, mail.hint)
                    : mail?.cannot && guests.length ? h('div', { className: 'dshcal-hint', 'data-calendar-mail': 'never' }, 'This calendar can\'t email guests: tell them another way.') : null);
        }

        /**
         * The event dialog. mode 'new' (from New event, a click or a drag on
         * the page: `preset`), 'edit' (an occurrence), or 'duplicate' (a new
         * event from an occurrence). A change to a repeating event asks which
         * occurrences it reaches; a change that would email people asks
         * first; the host's refusal shows at the top of the form, where the
         * focus goes. Closed with changes not saved, it asks first.
         */
        function EventDialog({ cal, mode, occurrence, preset, onClose, onSaved }) {
            const store = cal.store;
            useStore(store);
            const state = store.state();
            const zone = store.zone();
            const editing = mode === 'edit';
            const initial = React.useMemo(() => draftFrom({ occurrence, preset, state, zone, duplicate: mode === 'duplicate' }), []);
            const [d, setD] = React.useState(initial);
            const [repeatTouched, setRepeatTouched] = React.useState(mode === 'duplicate');
            const [errors, setErrors] = React.useState({});
            const [guestError, setGuestError] = React.useState('');
            const [refusal, setRefusal] = React.useState('');
            // The host stopped a change because the event changed meanwhile ('calendar/changed'): the way to look at it again.
            const [changed, setChanged] = React.useState(false);
            // It moved, but the host couldn't say where it is now: the other changes can't follow it, so Save stops.
            const [lost, setLost] = React.useState(false);
            const [busy, setBusy] = React.useState(false);
            const [ask, setAsk] = React.useState(null);
            // Closing with changes not saved: '' (open), 'ask' (Discard your changes?), 'go' (discarded: it closes).
            const [leaving, setLeaving] = React.useState('');
            const sending = useSendQuestion();
            // A move a Save made before its other changes failed: the event is in that calendar now.
            const movedRef = React.useRef(null);
            const alive = useAlive();
            const formRef = React.useRef(null);
            const refusalRef = React.useRef(null);
            // A refusal just set: into view, with the focus, once no question is open over the dialog.
            const showRefusal = React.useRef(false);
            const weekStart = weekStartFrom(state?.prefs);
            const { list: calendars } = writableCalendars(state, editing ? [initial.calendarId] : EMPTY);
            const homeId = movedRef.current?.calendarId ?? (editing ? initial.calendarId : d.calendarId);
            // Who saving emails: a change is made in the calendar the event is in (a move to another one goes first, on its own).
            const home = store.calendar(homeId) ?? store.calendar(d.calendarId);
            const invitation = editing && roleOf(occurrence) === 'guest';
            const others = new Set([...othersOf(d.guests), ...(editing ? othersOf(initial.guests) : EMPTY)].map((g) => g.email.toLowerCase())).size;
            const mailKind = editing ? 'update' : 'create';
            // No calendar chosen yet: nothing to say about emails until there is one.
            const mail = home ? mailMode({ kind: mailKind, calendar: home, occurrence: editing ? occurrence : undefined, guests: others }) : { mode: 'none', to: 'guests' };
            // Ticked only by the user: unticked, nobody is told (or, where the server emails anyway, the user is asked).
            const tell = mail.mode === 'ask' && d.notify === true;
            const tellLabel = !editing || (home?.kind === 'caldav' && roleOf(occurrence) === 'own') ? 'Send invitations by email' : 'Send updates to guests by email';
            // Google shows a meeting on its guests' calendars by itself: unticked, saving still puts it on theirs, changes it
            // there, or takes it off (a move out of Google, or every guest taken off), without an email.
            const reaches = home?.kind === 'google' && mail.mode === 'ask' && !tell && others > 0
                && (!editing || d.calendarId !== homeId || Object.keys(changePatch(initial, d, { repeatTouched, originalRule: occurrence.repeat })).some((k) => k !== 'alarms' && k !== 'notify'));
            const reachHow = !editing || othersOf(initial.guests).length === 0 ? 'puts it on'
                : (d.calendarId !== homeId && store.calendar(d.calendarId)?.kind !== 'google') || othersOf(d.guests).length === 0 ? 'removes it from' : 'changes it on';
            const reachHint = reaches ? `Unticked, Google still ${reachHow} the guests' Google calendars, without an email.` : '';
            const set = (given) => {
                // Someone else's invitation: its organizer's fields stay as they are; the user's own reminders, busy or free and privacy change.
                const patch = invitation ? Object.fromEntries(Object.entries(given).filter(([k]) => OWN_FIELDS.includes(k))) : given;
                if (Object.keys(patch).length === 0) return;
                setD((current) => ({ ...current, ...patch }));
                setErrors((current) => {
                    const next = { ...current };
                    for (const key of Object.keys(patch)) delete next[key === 'startDay' || key === 'startTime' ? 'start' : key === 'endDay' || key === 'endTime' ? 'end' : key];
                    return next;
                });
                setRefusal('');
                setChanged(false);
            };
            React.useEffect(() => {
                if (Object.keys(errors).length === 0) return;
                formRef.current?.querySelector('[aria-invalid=true]')?.focus?.();
            }, [errors]);
            React.useEffect(() => {
                const el = refusalRef.current;
                if (!showRefusal.current || !el || ask || sending.dialog) return;
                showRefusal.current = false;
                // The dialog's top: its title (which scrolls with the form), then the refusal.
                const box = el.closest('.dshcal-dlg-content');
                if (box) box.scrollTop = 0;
                el.scrollIntoView?.({ block: 'nearest' });
                el.focus({ preventScroll: true });
            });
            // Discarded: the question closes first (its focus goes back into this dialog), then the dialog.
            React.useEffect(() => {
                if (leaving === 'go') onClose();
            }, [leaving]);
            const close = () => {
                if (draftChanged(initial, d)) setLeaving('ask');
                else onClose();
            };

            /** A new start keeps the event's length. */
            const moveStart = (startDay, startTime) => {
                const length = draftLength(d);
                if (d.allDay) {
                    if (!isDay(startDay)) return set({ startDay });
                    return set({ startDay, endDay: addDays(startDay, Math.max(0, Math.round(length / 1440))) });
                }
                if (!isDay(startDay) || !isTime(startTime)) return set({ startDay, startTime });
                const end = wallOf(wallMs(`${startDay}T${startTime}`) + Math.max(0, length) * MINUTE);
                return set({ startDay, startTime, endDay: end.slice(0, 10), endTime: end.slice(11, 16) });
            };
            const switchAllDay = (allDay) => {
                if (allDay) set({ allDay, endDay: d.endDay < d.startDay ? d.startDay : (draftLength(d) < 1440 ? d.startDay : d.endDay) });
                else {
                    const start = isTime(d.startTime) ? d.startTime : '09:00';
                    const end = wallOf(wallMs(`${d.startDay}T${start}`) + HOUR);
                    set({ allDay, startTime: start, endDay: end.slice(0, 10), endTime: end.slice(11, 16) });
                }
            };

            const finish = (result, words) => {
                if (!alive.current) return;
                setBusy(false);
                if (!result.ok) {
                    const code = result.error?.code;
                    // No default calendar: said on the select, where it's chosen.
                    if (code === 'calendar/choose-calendar') {
                        setErrors((current) => ({ ...current, calendarId: CHOOSE_CALENDAR }));
                        return;
                    }
                    // The move made its copy (and sent its invitations) but couldn't take the event out of its old calendar:
                    // said on the page until the user closes it, with what is left to do. Never tried again from here, which
                    // would make a second copy.
                    if (code === 'calendar/half-moved') {
                        store.keepNotice(errorText(result.error));
                        void store.refresh();
                        onClose();
                        return;
                    }
                    // The event changed on its server meanwhile and nothing was done (with someone new each time, it kept changing
                    // and the questions stopped): the page reads it again, for the user to look at.
                    if (code === 'calendar/changed') {
                        setRefusal(result.kept ? 'Not saved: it changed meanwhile, on its server or in another app. Look at it again to see it as it is now.'
                            : result.stopped ? 'Not saved: it keeps changing on its server or in another app. Look at it again to see it as it is now.' : errorText(result.error));
                        setChanged(true);
                        showRefusal.current = true;
                        void store.refresh();
                        return;
                    }
                    // Not made, as the user chose: the dialog stays, to change what would email or reach them.
                    if (!result.kept) {
                        setRefusal(errorText(result.error));
                        showRefusal.current = true;
                    }
                    return;
                }
                onSaved?.(result.value?.occurrence, words);
                onClose();
            };

            /**
             * A change, and a move to another calendar: the move first, on its
             * own (the whole event or series), then the other changes on the
             * same occurrence in its new calendar.
             */
            const commitChange = async (patch, moveTo, scope) => {
                setBusy(true);
                setRefusal('');
                setChanged(false);
                let target = movedRef.current?.occurrence ?? occurrence;
                let result = { ok: true, value: { occurrence: target } };
                if (moveTo) {
                    // A series that would lose part of itself on the way asks first (drop), as does one that would email people.
                    // The box, ticked, tells the guests of the move too.
                    const moved = await withConsent(sending.ask, 'move', (how) => store.act('updateEvent', {
                        id: target.id, patch: { calendarId: moveTo, ...asked(tell, how) }, scope: 'all',
                    }), sending.drop);
                    if (!moved.ok) return finish(moved);
                    if (!placed(moved.value?.occurrence) && Object.keys(patch).length > 0) {
                        movedRef.current = { calendarId: moveTo, occurrence: null };
                        setLost(true);
                        const where = store.calendar(moveTo)?.name ?? 'the other calendar';
                        return finish({ ok: false, error: { code: 'calendar/refused', message: `It moved to “${where}”, but the other changes weren't saved: open it there and make them again` } });
                    }
                    target = sameOccurrence(moved.value?.occurrence, target);
                    movedRef.current = { calendarId: moveTo, occurrence: target };
                    result = moved;
                }
                if (Object.keys(patch).length > 0) {
                    // The same patch on every round: the host holds a yes to the very change it asked about.
                    const made = await withConsent(sending.ask, invitation ? 'invitation' : 'save', (how) => store.act('updateEvent', {
                        id: target.id, patch: { ...patch, ...asked(patch.notify, how) }, scope,
                    }));
                    if (!made.ok && movedRef.current) {
                        const where = store.calendar(movedRef.current.calendarId)?.name ?? 'the other calendar';
                        const why = made.kept ? 'you chose not to.' : errorText(made.error);
                        return finish({ ok: false, error: { code: made.error?.code === 'calendar/changed' ? made.error.code : 'calendar/refused', message: `It moved to “${where}”, but the other changes weren't saved: ${why}` } });
                    }
                    result = made;
                }
                return finish(result, 'Saved');
            };

            const save = async () => {
                if (busy || lost) return;
                const problems = draftProblems(d, calendars.length);
                if (guestError) problems.guests = guestError;
                if (Object.keys(problems).length) {
                    setErrors(problems);
                    return;
                }
                if (!editing) {
                    setBusy(true);
                    setRefusal('');
                    setChanged(false);
                    const input = createInput({ ...d, notify: tell });
                    const result = await withConsent(sending.ask, 'add', (how) => store.act('createEvent', { input: { ...input, ...asked(input.notify, how) } }));
                    return finish(result, 'Added');
                }
                const patch = changePatch(initial, { ...d, notify: tell }, { repeatTouched, originalRule: occurrence.repeat });
                const moveTo = d.calendarId !== homeId ? d.calendarId : '';
                if (Object.keys(patch).length === 0 && !moveTo) {
                    onClose();
                    return;
                }
                if (occurrence.recurring) {
                    let scopes = Array.isArray(occurrence.scopes) && occurrence.scopes.length ? occurrence.scopes : ['one', 'following', 'all'];
                    if ('repeat' in patch) scopes = scopes.filter((s) => s !== 'one');
                    // A move takes the whole series; the changes made with it go to all of it too.
                    if (moveTo) scopes = scopes.filter((s) => s === 'all');
                    if (scopes.length === 0) scopes = ['all'];
                    if (scopes.length > 1) {
                        setAsk({
                            scopes,
                            run: async (scope) => {
                                await commitChange(patch, moveTo, scope);
                                return '';
                            },
                        });
                        return;
                    }
                    return commitChange(patch, moveTo, scopes[0]);
                }
                return commitChange(patch, moveTo, 'all');
            };

            const title = editing ? 'Edit event' : mode === 'duplicate' ? 'Duplicate event' : 'New event';
            const timed = !d.allDay;
            const userTime = timed && d.timeZone !== zone && isZone(d.timeZone) && isDay(d.startDay) && isTime(d.startTime) && isTime(d.endTime)
                ? `${timeRangeText(toInstant(`${d.startDay}T${d.startTime}`, d.timeZone), toInstant(`${d.endDay}T${d.endTime}`, d.timeZone), zone)} your time (${zone})` : '';
            const byAccount = new Map();
            for (const c of calendars) {
                const group = byAccount.get(c.account) ?? [];
                group.push(c);
                byAccount.set(c.account, group);
            }
            const calendar = store.calendar(d.calendarId);
            // A problem's id, as its Field gives it (`${id}-error`), for the controls it is about.
            const FIELD_IDS = { start: 'dshcal-start-day', end: 'dshcal-end-day', timeZone: 'dshcal-zone', calendarId: 'dshcal-calendar' };
            const errorId = (key) => (errors[key] ? `${FIELD_IDS[key] ?? `dshcal-${key}`}-error` : undefined);
            return h(React.Fragment, null,
                h(Dialog, {
                    title, onClose: close, busy, wide: true,
                    footer: h(React.Fragment, null,
                        h(ui.Button, { variant: 'outline', disabled: busy, onClick: close, 'data-calendar-cancel': '' }, TEXT.cancel),
                        h(ui.Button, { variant: 'primary', disabled: busy || lost, onClick: () => void save(), 'data-calendar-save': '' }, busy ? h(Spinner) : null, editing ? TEXT.save : 'Add event')),
                },
                h('form', {
                    ref: formRef, className: 'dshcal-form', 'data-calendar-event-form': mode, noValidate: true,
                    onSubmit: (event) => { event.preventDefault(); void save(); },
                    onKeyDown: (event) => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void save();
                        }
                    },
                },
                // Why a save didn't go through, where the user is looking (the end of the form is out of view in a tall dialog).
                refusal ? h('div', { ref: refusalRef, className: 'dshcal-refusal', tabIndex: -1, 'data-calendar-refusal': '' },
                    h(Alert, { text: refusal }),
                    changed && editing ? h(Btn, {
                        size: 'sm', 'data-calendar-look-again': '',
                        onClick: () => {
                            onClose();
                            cal.openAt?.(movedRef.current?.occurrence ?? occurrence);
                        },
                    }, 'Look at it again') : null) : null,
                invitation ? h('p', { className: 'dshcal-hint', style: { margin: 0 }, 'data-calendar-invitation-note': '' },
                    'Someone else\'s invitation: its organizer sets its title, time, place, link and notes. Your reminders, Show me as and Private are yours to change.') : null,
                h('fieldset', { className: 'dshcal-fields', disabled: invitation, 'data-calendar-organizer-fields': '' },
                h(Field, { id: 'dshcal-title', error: errors.title },
                    h('input', {
                        id: 'dshcal-title', className: 'dshcal-input dshcal-title-input', value: d.title, placeholder: 'Add a title', 'aria-label': 'Title', maxLength: 500,
                        'data-modal-autofocus': true, 'data-calendar-title': '', 'aria-invalid': errors.title ? true : undefined, 'aria-describedby': errorId('title'),
                        onChange: (event) => set({ title: event.target.value }),
                        onKeyDown: (event) => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void save();
                            }
                        },
                    })),
                ui.Switch
                    ? h('div', { className: 'dshcal-switch-row', 'data-calendar-allday': '' },
                        h(ui.Switch, { checked: d.allDay, onChange: (next) => switchAllDay(next), label: 'All day' }),
                        h('span', { className: 'dshcal-switch-text', 'aria-hidden': true, onClick: () => switchAllDay(!d.allDay) }, 'All day'))
                    : h('label', { className: 'dshcal-check' }, h('input', { type: 'checkbox', checked: d.allDay, onChange: (event) => switchAllDay(event.target.checked), 'data-calendar-allday': '' }), 'All day'),
                h('div', { className: 'dshcal-row dshcal-when-row' },
                    h(Field, { label: 'Starts', id: 'dshcal-start-day', error: errors.start },
                        h('div', { className: 'dshcal-inline dshcal-dt' },
                            h('input', {
                                id: 'dshcal-start-day', className: 'dshcal-input dshcal-date', type: 'date', value: d.startDay, 'data-calendar-start-day': '', 'aria-invalid': errors.start ? true : undefined,
                                'aria-describedby': errorId('start'),
                                onChange: (event) => moveStart(event.target.value, d.startTime),
                            }),
                            timed ? h('input', {
                                className: 'dshcal-input dshcal-time', type: 'time', step: 300, value: d.startTime, 'aria-label': 'Start time', 'data-calendar-start-time': '',
                                'aria-describedby': errorId('start'),
                                onChange: (event) => moveStart(d.startDay, event.target.value),
                            }) : null)),
                    h(Field, { label: 'Ends', id: 'dshcal-end-day', error: errors.end },
                        h('div', { className: 'dshcal-inline dshcal-dt' },
                            h('input', {
                                id: 'dshcal-end-day', className: 'dshcal-input dshcal-date', type: 'date', value: d.endDay, min: d.startDay, 'data-calendar-end-day': '', 'aria-invalid': errors.end ? true : undefined,
                                'aria-describedby': errorId('end'),
                                onChange: (event) => set({ endDay: event.target.value }),
                            }),
                            timed ? h('input', {
                                className: 'dshcal-input dshcal-time', type: 'time', step: 300, value: d.endTime, 'aria-label': 'End time', 'data-calendar-end-time': '',
                                'aria-describedby': errorId('end'),
                                onChange: (event) => set({ endTime: event.target.value }),
                            }) : null))),
                timed ? h(Field, { label: 'Time zone', id: 'dshcal-zone', error: errors.timeZone, hint: userTime || undefined },
                    h('input', {
                        id: 'dshcal-zone', className: 'dshcal-input', list: 'dshcal-zones', value: d.timeZone, spellCheck: false, autoComplete: 'off', 'data-calendar-zone': '',
                        'aria-invalid': errors.timeZone ? true : undefined, 'aria-describedby': errorId('timeZone'),
                        onFocus: (event) => event.target.select(),
                        onChange: (event) => set({ timeZone: event.target.value.trim() }),
                    }),
                    h('datalist', { id: 'dshcal-zones' }, zoneIds().map((z) => h('option', { key: z, value: z })))) : null,
                h(RepeatField, { d, set, error: errors.repeat, originalWords: occurrence?.repeats, onTouch: () => setRepeatTouched(true), weekStart }),
                h(Field, {
                    label: 'Calendar', id: 'dshcal-calendar', error: errors.calendarId,
                    hint: invitation ? 'An invitation stays in the calendar it was sent to.'
                        : editing && d.calendarId !== homeId && occurrence.recurring ? 'The whole series moves to this calendar, and the changes made here go to all of it.'
                        : !calendar && calendars.length > 1 ? 'To skip this next time, pick “Use for new events” in a calendar\'s menu in the list of calendars.' : undefined,
                },
                    h('div', { className: 'dshcal-inline', style: { flexWrap: 'nowrap' } },
                        h('span', { className: 'dshcal-dot', 'data-none': calendar ? undefined : '', style: calendar ? { '--dot': colorOf(calendar.color) } : undefined }),
                        h('select', {
                            id: 'dshcal-calendar', className: 'dshcal-select dshcal-grow', value: d.calendarId, disabled: invitation, 'data-calendar-calendar': '', 'aria-invalid': errors.calendarId ? true : undefined,
                            'aria-describedby': errorId('calendarId'),
                            onChange: (event) => set({ calendarId: event.target.value }),
                        },
                        // No calendar chosen yet (no default): the user picks one before saving.
                        calendar ? null : h('option', { value: '', disabled: true }, calendars.length ? 'Choose a calendar' : 'No calendar can be written'),
                        [...byAccount].map(([account, list]) => h('optgroup', { key: account, label: account || 'Calendars' },
                            list.map((c) => h('option', { key: c.id, value: c.id }, c.name))))))),
                h(Field, { label: 'Place', id: 'dshcal-location' },
                    h('input', { id: 'dshcal-location', className: 'dshcal-input', value: d.location, placeholder: 'An address, a room, or a link', 'data-calendar-location': '', onChange: (event) => set({ location: event.target.value }) })),
                h(Field, { label: 'Link', id: 'dshcal-url', error: errors.url },
                    h('input', {
                        id: 'dshcal-url', className: 'dshcal-input', type: 'url', value: d.url, placeholder: 'https://', 'data-calendar-url': '', 'aria-invalid': errors.url ? true : undefined,
                        'aria-describedby': errorId('url'),
                        onChange: (event) => set({ url: event.target.value }),
                    })),
                h(Field, { label: 'Notes', id: 'dshcal-notes' },
                    h('textarea', { id: 'dshcal-notes', className: 'dshcal-textarea', value: d.description, rows: 3, 'data-calendar-notes': '', onChange: (event) => set({ description: event.target.value }) }))),
                h(RemindersField, { alarms: d.alarms, onChange: (alarms) => set({ alarms }) }),
                h(GuestsField, {
                    guests: d.guests, onChange: (guests) => set({ guests }), readOnly: invitation,
                    mail: mail.mode === 'ask' ? { mode: 'ask', label: tellLabel, checked: tell, onChange: (notify) => set({ notify }), quiet: reachHint }
                        : mail.mode === 'always' ? { mode: 'always', hint: alwaysWords(mailKind, home) } : { cannot: mail.cannot === true },
                    error: errors.guests || guestError, setError: (text) => { setGuestError(text); setErrors((e) => ({ ...e, guests: undefined })); },
                }),
                h('div', { className: 'dshcal-row' },
                    h(Field, { label: 'Show me as', id: 'dshcal-busy' },
                        h('select', { id: 'dshcal-busy', className: 'dshcal-select', value: d.busy ? 'busy' : 'free', 'data-calendar-busy': '', onChange: (event) => set({ busy: event.target.value === 'busy' }) },
                            h('option', { value: 'busy' }, 'Busy'), h('option', { value: 'free' }, 'Free'))),
                    h('div', { className: 'dshcal-field', style: { justifyContent: 'flex-end' } },
                        h('label', { className: 'dshcal-check', style: { minHeight: 34 }, title: 'Others who can see this calendar see only that the time is taken.' },
                            h('input', { type: 'checkbox', checked: d.private, onChange: (event) => set({ private: event.target.checked }), 'data-calendar-private': '' }),
                            'Private'))))),
                ask ? h(ScopeDialog, {
                    title: 'Change repeating event', scopes: ask.scopes, action: TEXT.save,
                    onSubmit: (scope) => ask.run(scope), onClose: () => setAsk(null),
                }) : null,
                sending.dialog,
                leaving === 'ask' ? h(DiscardDialog, { onDiscard: () => setLeaving('go'), onClose: () => setLeaving('') }) : null);
        }

        // ── Popovers: an event's details, a day's events ───────────────────

        /** A rectangle to place a popover by: an element's, kept as numbers. */
        const rectOf = (el) => {
            const r = el?.getBoundingClientRect?.();
            return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : undefined;
        };

        /**
         * A card beside what opened it (to its right, else its left, else
         * below or above it; in the middle without one), or a sheet at the
         * bottom of a narrow window. It takes the focus once it is placed;
         * Escape or a press outside closes it (onClose says which: 'escape',
         * 'outside'), and the focus goes back where it was.
         */
        function Popover({ anchor, onClose, label, children, ...rest }) {
            const ref = React.useRef(null);
            const [place, setPlace] = React.useState(null);
            const close = React.useRef(onClose);
            close.current = onClose;
            React.useLayoutEffect(() => {
                const el = ref.current;
                if (!el) return;
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                if (vw < 560) {
                    setPlace({ sheet: true });
                    return;
                }
                const w = el.offsetWidth;
                const hgt = el.offsetHeight;
                if (!anchor) {
                    // Nothing on the page to stand beside (an event opened from elsewhere): the middle of the window.
                    setPlace({ left: Math.max(12, (vw - w) / 2), top: clamp((vh - hgt) / 3, 12, Math.max(12, vh - hgt - 12)) });
                    return;
                }
                let left = anchor.right + 8;
                let top = anchor.top;
                if (left + w > vw - 12) {
                    left = anchor.left - 8 - w;
                    if (left < 12) {
                        // No room on either side: below it (or above), centred on it.
                        left = clamp(anchor.left + anchor.width / 2 - w / 2, 12, Math.max(12, vw - w - 12));
                        top = anchor.bottom + 8;
                        if (top + hgt > vh - 12) top = anchor.top - 8 - hgt;
                    }
                }
                setPlace({ left, top: clamp(top, 12, Math.max(12, vh - hgt - 12)) });
            }, [anchor]);
            // The focus moves in once it is placed: hidden while it is measured, it can't take the focus.
            const focused = React.useRef(false);
            React.useEffect(() => {
                if (place === null || focused.current) return;
                focused.current = true;
                const el = ref.current;
                (el?.querySelector('[data-pop-autofocus]') ?? el)?.focus?.({ preventScroll: true });
            }, [place]);
            React.useEffect(() => {
                const before = document.activeElement;
                const el = ref.current;
                const onKey = (event) => {
                    if (event.key !== 'Escape' || event.defaultPrevented) return;
                    if (document.querySelector('[role=dialog][aria-modal=true]')) return;
                    event.preventDefault();
                    close.current('escape');
                };
                const onDown = (event) => {
                    if (el && !el.contains(event.target) && !event.target?.closest?.('[role=dialog][aria-modal=true],[role=menu],[role=listbox]')) close.current('outside');
                };
                document.addEventListener('keydown', onKey);
                document.addEventListener('pointerdown', onDown, true);
                return () => {
                    document.removeEventListener('keydown', onKey);
                    document.removeEventListener('pointerdown', onDown, true);
                    if (before && typeof before.focus === 'function' && document.contains(before) && (document.activeElement === document.body || el?.contains(document.activeElement))) {
                        before.focus({ preventScroll: true });
                    }
                };
            }, []);
            const style = place === null ? { left: -9999, top: 0, visibility: 'hidden' } : place.sheet ? {} : { left: place.left, top: place.top };
            // Escape inside it is its own: the page under it doesn't see it too.
            const onKeyDown = (event) => {
                if (event.key !== 'Escape' || document.querySelector('[role=dialog][aria-modal=true]')) return;
                event.preventDefault();
                event.stopPropagation();
                close.current('escape');
            };
            return ReactDOM.createPortal(h('div', {
                ref, className: 'dshcal-pop', role: 'dialog', 'aria-label': label, tabIndex: -1, style, 'data-sheet': place?.sheet ? '' : undefined, onKeyDown, ...rest,
            }, children), document.body);
        }

        const ANSWER_WORDS = { accepted: 'Going', declined: 'Not going', tentative: 'Maybe', 'needs-action': 'Not answered yet', delegated: 'Delegated' };
        const ANSWER_MARK = { accepted: '✓', declined: '✕', tentative: '?', 'needs-action': '' };

        /** Text with its web addresses as links. */
        function Linked({ text }) {
            const parts = String(text ?? '').split(/(https?:\/\/[^\s<>"')\]]+)/g);
            return h(React.Fragment, null, parts.map((part, i) => (i % 2 === 1
                ? h('a', { key: i, className: 'dshcal-link', href: part, target: '_blank', rel: 'noopener noreferrer' }, part)
                : part)));
        }

        /** One row of an event's details: a glyph, then what it says. */
        const DetailRow = ({ glyph, children, ...rest }) => h('div', { className: 'dshcal-pop-row', ...rest }, h('span', { className: 'dshcal-pop-icon', 'aria-hidden': true }, glyph), h('div', null, children));

        /**
         * An event's details: when (in the user's zone, and its own when that
         * differs), how it repeats, its calendar, place, call, link, notes,
         * guests and their answers, reminders; Accept / Maybe / Decline for an
         * invitation; Edit, Duplicate and Delete where its calendar can be
         * written; with onOpenPage, a button to see it in the calendar.
         */
        function EventPopover({ cal, occurrence, anchor, onClose, onEdit, onDuplicate, onDelete, onOpenPage, openLabel = 'Open in Calendar' }) {
            const store = cal.store;
            useStore(store);
            const zone = store.zone();
            const [o, setO] = React.useState(occurrence);
            const [answering, setAnswering] = React.useState('');
            const [askAnswer, setAskAnswer] = React.useState('');
            const [error, setError] = React.useState('');
            const alive = useAlive();
            React.useEffect(() => setO(occurrence), [occurrence]);
            const calendar = store.calendar(o.calendarId);
            const canWrite = o.readOnly !== true && (calendar ? !calendar.readOnly : true);
            const canDuplicate = writableCalendars(store.state()).list.length > 0;
            const answer = async (status, scope) => {
                setAskAnswer('');
                setAnswering(status);
                setError('');
                const result = await store.act('respond', { id: o.id, status, scope });
                if (!alive.current) return;
                setAnswering('');
                if (result.ok && isObject(result.value?.occurrence)) {
                    setO(result.value.occurrence);
                    const told = contactText(result.value.occurrence);
                    store.toast(`Answered: ${ANSWER_WORDS[status]}.${told ? ` ${told}` : ''}`);
                } else if (!result.ok) {
                    setError(errorText(result.error));
                    if (result.error?.code === 'calendar/changed') void store.refresh();
                }
            };
            const pick = (status) => {
                if (o.recurring && (o.scopes ?? EMPTY).includes('one')) setAskAnswer(status);
                else void answer(status, 'all');
            };
            const ownZone = !o.allDay && o.timeZone && o.timeZone !== zone && isZone(o.timeZone);
            const guests = (o.attendees ?? EMPTY).filter((p) => p && p.email);
            const counts = { accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 };
            for (const p of guests) counts[p.status in counts ? p.status : 'needs-action']++;
            const look = lookOf(o);
            return h(Popover, { anchor, onClose, label: o.title, 'data-calendar-details': o.id },
                h('div', { className: 'dshcal-pop-top', style: evStyle(o.color) },
                    h('span', { className: 'dshcal-pop-swatch', 'aria-hidden': true }),
                    h('h2', { className: 'dshcal-pop-title', style: look === 'struck' ? { textDecoration: 'line-through' } : undefined }, o.title),
                    h('div', { className: 'dshcal-pop-actions' },
                        canWrite ? h(IconBtn, { label: 'Edit', glyph: icon('IconEditOutlineRegular'), size: 'sm', onClick: () => onEdit(o), 'data-calendar-edit': '' }) : null,
                        canDuplicate ? h(IconBtn, { label: 'Duplicate', glyph: icon('IconCopyOutlineRegular'), size: 'sm', onClick: () => onDuplicate(o), 'data-calendar-duplicate': '' }) : null,
                        canWrite ? h(IconBtn, { label: 'Delete', glyph: icon('IconTrashOutlineRegular'), size: 'sm', onClick: () => onDelete(o), 'data-calendar-delete': '' }) : null,
                        h(IconBtn, { label: TEXT.close, glyph: icon('IconCloseOutlineRegular'), size: 'sm', onClick: onClose }))),
                h('div', { className: 'dshcal-pop-rows' },
                    h(DetailRow, { glyph: icon('IconClockOutlineRegular') },
                        h('div', { 'data-calendar-when': '' }, whenText(o, zone)),
                        ownZone ? h('div', { className: 'dshcal-pop-sub' }, `${o.allDay ? '' : shortWhenIn(o, o.timeZone)} in ${o.timeZone}`) : null,
                        o.status === 'cancelled' ? h('div', { className: 'dshcal-pop-sub dshcal-warn' }, 'Cancelled') : o.status === 'tentative' ? h('div', { className: 'dshcal-pop-sub' }, 'Not confirmed yet') : null),
                    o.recurring ? h(DetailRow, { glyph: h(RepeatGlyph) }, o.repeats || 'Repeats', o.changed ? h('span', { className: 'dshcal-pop-sub' }, ' · this one changed') : null) : null,
                    h(DetailRow, { glyph: h(CalendarGlyph) },
                        h('span', { className: 'dshcal-inline', style: { gap: 6 } }, h('span', { className: 'dshcal-dot', style: { '--dot': colorOf(o.color) } }), o.calendar),
                        o.readOnly ? h('span', { className: 'dshcal-pop-sub' }, ' · read only') : null,
                        o.busy === false ? h('span', { className: 'dshcal-pop-sub' }, ' · shows as free') : null,
                        o.privacy === 'private' || o.privacy === 'confidential' ? h('span', { className: 'dshcal-pop-sub' }, ' · private') : null),
                    o.location ? h(DetailRow, { glyph: h(PinGlyph) }, isUrl(o.location)
                        ? h('a', { className: 'dshcal-link', href: o.location.trim(), target: '_blank', rel: 'noopener noreferrer' }, linkLabel(o.location))
                        : h(Linked, { text: o.location })) : null,
                    o.conference ? h(DetailRow, { glyph: h(VideoGlyph) },
                        h('div', { className: 'dshcal-inline' },
                            isUrl(o.conference) ? h('a', { className: 'dshcal-btn dshcal-btn-primary dshcal-btn-sm', href: o.conference, target: '_blank', rel: 'noopener noreferrer', 'data-calendar-join': '' }, 'Join call') : null,
                            h('span', { className: 'dshcal-pop-sub', style: { overflowWrap: 'anywhere' } }, linkLabel(o.conference)))) : null,
                    o.url ? h(DetailRow, { glyph: icon('IconLinkOutlineRegular') }, isUrl(o.url)
                        ? h('a', { className: 'dshcal-link', href: o.url.trim(), target: '_blank', rel: 'noopener noreferrer', 'data-calendar-url-link': '' }, linkLabel(o.url))
                        : h('span', { style: { overflowWrap: 'anywhere' }, 'data-calendar-url-text': '' }, String(o.url))) : null,
                    o.description ? h(DetailRow, { glyph: h(NotesGlyph) }, h('div', { className: 'dshcal-pop-notes' }, h(Linked, { text: o.description }))) : null,
                    guests.length || o.organizer ? h(DetailRow, { glyph: icon('IconUsersOutlineRegular') },
                        guests.length ? h('div', null, plural(guests.length, 'guest'),
                            h('span', { className: 'dshcal-pop-sub' }, ` · ${[counts.accepted ? `${counts.accepted} going` : '', counts.tentative ? `${counts.tentative} maybe` : '', counts.declined ? `${counts.declined} not going` : '', counts['needs-action'] ? `${counts['needs-action']} not answered` : ''].filter(Boolean).join(', ')}`)) : null,
                        h('div', { className: 'dshcal-pop-guests' },
                            o.organizer && !guests.some((p) => p.email?.toLowerCase() === String(o.organizer.email ?? '').toLowerCase())
                                ? h('div', { className: 'dshcal-guest' }, h('span', { className: 'dshcal-ans', 'data-ans': 'accepted', 'aria-hidden': true }, '✓'), h('span', null, o.organizer.name || o.organizer.email), h('span', { className: 'dshcal-pop-sub' }, 'organizer')) : null,
                            guests.slice(0, 30).map((p) => h('div', { key: p.email, className: 'dshcal-guest', title: p.email },
                                h('span', { className: 'dshcal-ans', 'data-ans': p.status in ANSWER_MARK ? p.status : 'needs-action', 'aria-hidden': true }, ANSWER_MARK[p.status] ?? ''),
                                h('span', null, p.name || p.email, p.self ? ' (you)' : ''),
                                h('span', { className: 'dshcal-pop-sub' }, [
                                    String(o.organizer?.email ?? '').toLowerCase() === p.email.toLowerCase() ? 'organizer' : '',
                                    p.role === 'optional' ? 'optional' : '',
                                    ANSWER_WORDS[p.status] ?? ANSWER_WORDS['needs-action'],
                                ].filter(Boolean).join(' · ')))),
                            guests.length > 30 ? h('div', { className: 'dshcal-pop-sub' }, `and ${guests.length - 30} more`) : null)) : null,
                    o.alarms?.length ? h(DetailRow, { glyph: h(BellGlyph) }, o.alarms.map(reminderWords).join(', ')) : null),
                o.canRespond ? h('div', { className: 'dshcal-rsvp', 'data-calendar-rsvp': '' },
                    askAnswer
                        ? h(React.Fragment, null,
                            h('span', null, `${ANSWER_WORDS[askAnswer]} for`),
                            h(Btn, { size: 'sm', onClick: () => void answer(askAnswer, 'one'), 'data-calendar-answer-scope': 'one' }, 'This event'),
                            h(Btn, { size: 'sm', onClick: () => void answer(askAnswer, 'all'), 'data-calendar-answer-scope': 'all' }, 'All events'),
                            h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setAskAnswer('') }, TEXT.cancel))
                        : h(React.Fragment, null,
                            h('span', null, 'Going?'),
                            [['accepted', 'Yes'], ['tentative', 'Maybe'], ['declined', 'No']].map(([status, label]) => h(Btn, {
                                key: status, size: 'sm', 'aria-pressed': o.myStatus === status, disabled: answering !== '', 'data-calendar-answer': status,
                                onClick: () => pick(status),
                            }, answering === status ? h(Spinner, { size: 12 }) : null, label)))) : null,
                error ? h('div', { style: { marginTop: 10 } }, h(Alert, { text: error })) : null,
                typeof onOpenPage === 'function' ? h('div', { className: 'dshcal-pop-foot' },
                    h(Btn, { size: 'sm', onClick: () => onOpenPage(o), 'data-calendar-open-page': '' }, h(CalendarIcon, { size: 12 }), openLabel)) : null);
        }

        /** An occurrence's times on another zone's clock ('6:00 – 7:00 PM'). */
        function shortWhenIn(o, zone) {
            const first = dayIn(o.start, zone);
            const last = dayIn(Math.max(o.start, o.end - 1), zone);
            if (first === last) return `${dayText(first)}, ${timeRangeText(o.start, o.end, zone)}`;
            return rangeText(dtf({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }), o.start, o.end);
        }

        /** One occurrence as a line in a list (a day's popover): its time, its title, its color. */
        function EventLine({ o, zone, day, onOpen, now, autoFocus }) {
            const bar = spansDays(o);
            const past = now !== undefined && o.end <= now;
            const label = `${o.title}, ${shortWhen(o, zone, day)}, ${o.calendar}`;
            if (bar) {
                return h('button', {
                    type: 'button', className: 'dshcal-bar', style: evStyle(o.color), 'data-look': lookOf(o), 'data-past': past ? '' : undefined, 'aria-label': label, 'data-calendar-event': o.id,
                    'data-pop-autofocus': autoFocus ? true : undefined, onClick: (event) => onOpen(o, event.currentTarget),
                }, h('span', { className: 'dshcal-bar-title' }, o.title));
            }
            return h('button', {
                type: 'button', className: 'dshcal-line', style: evStyle(o.color), 'data-look': lookOf(o), 'data-past': past ? '' : undefined, 'aria-label': label, 'data-calendar-event': o.id,
                'data-pop-autofocus': autoFocus ? true : undefined, onClick: (event) => onOpen(o, event.currentTarget),
            }, h('span', { className: 'dshcal-dot' }), h('span', { className: 'dshcal-line-time' }, timeText(Math.max(o.start, startOfDay(day, zone)), zone)), h('span', { className: 'dshcal-line-title' }, o.title));
        }

        /** A day's events (the month's "+N more", or Enter on a day): each one, New event, and the day itself. */
        function DayPopover({ day, occurrences, zone, anchor, onClose, onOpen, onNew, onOpenDay, now }) {
            return h(Popover, { anchor, onClose, label: longDay(day, zone), 'data-calendar-day': day },
                h('div', { className: 'dshcal-pop-top' },
                    h('h2', { className: 'dshcal-pop-title' }, longDay(day, zone)),
                    h('div', { className: 'dshcal-pop-actions' }, h(IconBtn, { label: TEXT.close, glyph: icon('IconCloseOutlineRegular'), size: 'sm', onClick: onClose }))),
                occurrences.length
                    ? h('div', { className: 'dshcal-daypop-list' }, occurrences.map((o, i) => h(EventLine, { key: o.id, o, zone, day, now, onOpen, autoFocus: i === 0 })))
                    : h('div', { className: 'dshcal-hint', style: { margin: '8px 0' } }, 'Nothing on this day.'),
                h('div', { className: 'dshcal-pop-foot' },
                    h(Btn, { size: 'sm', kind: 'primary', onClick: () => onNew(day), 'data-pop-autofocus': occurrences.length ? undefined : true }, icon('IconPlusOutlineRegular', { size: 12 }), 'New event'),
                    h(Btn, { size: 'sm', onClick: () => onOpenDay(day) }, 'Open day')));
        }

        // ── Week and Day: the time grid ────────────────────────────────────

        const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

        // ── Dragging events ────────────────────────────────────────────────
        // An event dragged in Week or Day goes to another time or day (its start on a quarter hour), or by its bottom edge
        // to another end; in Month, and in the all-day row, to another day, keeping its time of day. The math is on the
        // clock of the zone the page shows (wall clocks read as UTC, as wallMs does), so a day with a clock change keeps
        // its hours where the grid draws them; the event keeps its length.

        /** How far apart the times a drag lands on are, in minutes. */
        const SNAP = 15;
        /** How long after the last press of Alt and an arrow key the move is saved, in ms. */
        const KEYS_PAUSE = 1500;
        /** The keys that move an event, in its tooltip: a timed one in Week and Day, and one in the all-day row. */
        const KEYS_TIP = {
            timed: `Alt and ↑ ↓ move it by ${SNAP} minutes, ← → by a day.`,
            days: 'Alt and ← → move it by a day.',
        };
        /** Minutes to the nearest step. */
        const snapTo = (minutes, step = SNAP) => Math.round(minutes / step) * step;
        /** A day and minutes into it as one wall-clock number (ms, read as UTC). */
        const wallAt = (day, minutes) => wallMs(day) + minutes * MINUTE;
        /** An event's start on the page's clock, as such a number. */
        const startWall = (o, zone) => wallMs(toLocal(o.start, zone));

        /** Whether the user can drag an occurrence: a calendar that can be written, and not someone else's invitation. */
        function canDrag(o, calendar) {
            if (!isObject(o) || o.readOnly === true || calendar?.readOnly === true) return false;
            return roleOf(o) !== 'guest';
        }

        /**
         * Where a timed event moved by a drag goes: grabbed at `grab` ({day, minute}, where the press was), now at
         * `at`; its start on the nearest quarter hour, its length kept. → {start, end} (ms).
         */
        function movedTo(o, zone, grab, at) {
            const offset = wallAt(grab.day, grab.minute) - startWall(o, zone);
            const wall = snapTo((wallAt(at.day, at.minute) - offset) / MINUTE) * MINUTE;
            const start = toInstant(wallOf(wall), zone);
            return { start, end: start + Math.max(0, o.end - o.start) };
        }

        /** Where a timed event's end goes when its bottom edge is dragged to `at`: a quarter hour, a quarter hour after its start at least. */
        function resizedTo(o, zone, at) {
            const first = startWall(o, zone);
            const wall = Math.max(first + SNAP * MINUTE, snapTo(wallAt(at.day, at.minute) / MINUTE) * MINUTE);
            return { start: o.start, end: toInstant(wallOf(wall), zone) };
        }

        /**
         * An event moved by whole days (Month, the all-day row), at the same time of day: {start, end}, and for an
         * all-day one its days {startDay, lastDay} too.
         */
        function shiftedBy(o, zone, days) {
            if (o.allDay) {
                const startDay = addDays(o.startDay, days);
                return { allDay: true, startDay, lastDay: addDays(o.lastDay ?? o.startDay, days), start: o.start + days * DAY, end: o.end + days * DAY };
            }
            const start = toInstant(wallOf(startWall(o, zone) + days * DAY), zone);
            return { start, end: start + Math.max(0, o.end - o.start) };
        }

        /**
         * Where one press of Alt and an arrow key takes an event from where it is: a quarter hour earlier or later
         * (up, down), or a day back or on (left, right; a day shown, past hidden weekends). byDays: one in the all-day
         * row, which goes by days alone. → {start, end} (and an all-day one's days), or null for any other key.
         */
        function keyedTo(o, key, zone, { byDays = false, hideWeekends = false } = {}) {
            const step = { ArrowUp: [-SNAP, 0], ArrowDown: [SNAP, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
            if (!step || (byDays && step[1] === 0)) return null;
            if (step[1] !== 0) {
                const from = o.allDay ? o.startDay : dayIn(o.start, zone);
                return shiftedBy(o, zone, daysBetween(from, addShownDays(from, step[1], hideWeekends)));
            }
            const start = toInstant(wallOf(startWall(o, zone) + step[0] * MINUTE), zone);
            return { start, end: start + Math.max(0, o.end - o.start) };
        }

        /** Whether a drop changes anything. */
        const sameTimes = (o, t) => (o.allDay ? t.startDay === o.startDay && t.lastDay === (o.lastDay ?? o.startDay) : t.start === o.start && t.end === o.end);

        /** The days an event dragged to new times would cover: [first, last]. */
        const coveredDays = (t, zone) => (t.allDay ? [t.startDay, t.lastDay] : [dayIn(t.start, zone), dayIn(Math.max(t.start, t.end - 1), zone)]);
        /** An occurrence at the times a drag gave it, to show until its calendar has it there. */
        const placedAt = (o, t) => ({ ...o, start: t.start, end: t.end, ...(t.allDay ? { startDay: t.startDay, lastDay: t.lastDay } : {}) });

        /** Who a moved event's change emailed, and whose calendars it changed without an email, in the other toasts' words, or ''. */
        function movedWords(moved) {
            return isObject(moved) ? contactText(moved) : '';
        }

        /**
         * The patch updateEvent takes for a drop: an all-day event's days (the end is its last day), or a timed one's
         * instants (the host puts them on the event's own clock, so its zone stays). Undefined when nothing changes.
         */
        function dropPatch(o, t) {
            if (!t || sameTimes(o, t)) return undefined;
            if (o.allDay) return { allDay: true, start: t.startDay, end: t.lastDay };
            return { allDay: false, start: new Date(t.start).toISOString(), end: new Date(t.end).toISOString() };
        }

        /**
         * What the consent helper hands a change's maker, as the arguments it adds: notify only when the user said Send,
         * approved when they were shown who it reaches. Takes the helper's older form (notify: boolean) and its newer
         * one ({notify, approved}).
         */
        function consentArgs(given) {
            const c = typeof given === 'boolean' ? { notify: given } : isObject(given) ? given : {};
            return { ...(c.notify === true ? { notify: true } : {}), ...(Array.isArray(c.approved) ? { approved: c.approved } : {}) };
        }

        /** The words on a dragged event's ghost: its new times ('9:30 – 10:30 AM'). */
        function ghostWords(t, zone) {
            if (t.allDay) return dayRangeText(t.startDay, t.lastDay);
            return dayIn(t.start, zone) === dayIn(Math.max(t.start, t.end - 1), zone) ? timeRangeText(t.start, t.end, zone) : `${timeText(t.start, zone)} – ${timeText(t.end, zone)}`;
        }

        /**
         * Where Week and Day open, in minutes into the day: the earlier of 7:30 and the first timed event on show, so no
         * early one hides above. Late on a day on show (after 15:00), four hours before now instead, unless an event
         * still to come starts earlier.
         * @param starts - [{minute, upcoming}]: each timed event on show, minutes into its day, and whether it is still to come.
         */
        function openingMinute(starts, nowMinute = 0, todayShown = false) {
            const late = todayShown && nowMinute > 15 * 60;
            const base = late ? nowMinute - 240 : 450;
            const firsts = (starts ?? EMPTY).filter((s) => Number.isFinite(s?.minute) && (!late || s.upcoming)).map((s) => s.minute);
            return clamp(Math.min(base, ...firsts), 0, 1440);
        }

        /**
         * A press on an event that may become a drag: past a few pixels it is one, and onMove follows the pointer
         * (held by pointer capture); on release onDrop, on Escape or a lost pointer onCancel. A press that doesn't move
         * is left alone, so its click opens the event as before; the click that ends a drag is swallowed.
         */
        function pressToDrag(event, { onStart, onMove, onDrop, onCancel }) {
            const el = event.currentTarget;
            const id = event.pointerId;
            const x0 = event.clientX;
            const y0 = event.clientY;
            let dragging = false;
            let over = false;
            try { el.setPointerCapture(id); } catch {}
            const swallowClick = () => {
                const swallow = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    stop();
                };
                const stop = () => {
                    clearTimeout(timer);
                    window.removeEventListener('click', swallow, true);
                };
                // The release's click comes in the same task, if at all (not when the drop re-drew the event pressed);
                // the next click is the user's.
                const timer = setTimeout(stop, 0);
                window.addEventListener('click', swallow, true);
            };
            const leave = () => {
                window.removeEventListener('pointermove', move, true);
                window.removeEventListener('pointerup', up, true);
                window.removeEventListener('pointercancel', lost, true);
                window.removeEventListener('keydown', key, true);
                el.removeEventListener('lostpointercapture', lost);
                try { el.releasePointerCapture(id); } catch {}
            };
            const move = (e) => {
                if (e.pointerId !== id || over) return;
                if (!dragging) {
                    if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
                    dragging = true;
                    onStart?.(e);
                }
                onMove(e);
            };
            const up = (e) => {
                if (e.pointerId !== id) return;
                leave();
                if (!dragging) return;
                swallowClick();
                if (!over) onDrop(e);
            };
            const lost = (e) => {
                if (e.pointerId !== id) return;
                leave();
                if (dragging && !over) onCancel();
            };
            const key = (e) => {
                if (e.key !== 'Escape' || !dragging || over) return;
                e.preventDefault();
                e.stopPropagation();
                // Cancelled; the release still comes, and its click is swallowed then.
                over = true;
                onCancel();
            };
            window.addEventListener('pointermove', move, true);
            window.addEventListener('pointerup', up, true);
            window.addEventListener('pointercancel', lost, true);
            window.addEventListener('keydown', key, true);
            el.addEventListener('lostpointercapture', lost);
        }

        /** A day's timed events as minute spans on its clock: [{o, from, to}]. */
        function daySegments(occurrences, day, zone) {
            const dayStart = startOfDay(day, zone);
            const dayEnd = startOfDay(addDays(day, 1), zone);
            const out = [];
            for (const o of occurrences) {
                if (spansDays(o)) continue;
                const point = o.end <= o.start;
                if (point ? o.start < dayStart || o.start >= dayEnd : o.end <= dayStart || o.start >= dayEnd) continue;
                const from = o.start <= dayStart ? 0 : minutesIn(o.start, zone);
                let to = o.end >= dayEnd ? 1440 : minutesIn(o.end, zone);
                if (to <= from) to = Math.min(1440, from + 15);
                out.push({ o, from, to, key: o.id });
            }
            return out;
        }

        /**
         * The all-day row's bars for the days a row shows: [{key, a, b, o, contStart, contEnd, order}], a and b the
         * first and last of those days it covers. A bar is cut to them, marked as going on where its event starts
         * before them or ends after them (on days before or after the row, or on hidden weekend days).
         */
        function barItems(occurrences, days, zone, which = spansDays, hideWeekends = false) {
            const first = days[0];
            const last = days[days.length - 1];
            const out = [];
            for (const o of occurrences) {
                if (!which(o)) continue;
                const [s, e] = daysOf(o, zone);
                if (e < first || s > last) continue;
                // A timed event shorter than a day stays on the day it starts, even when it ends after midnight;
                // when that day is a hidden weekend's, the view doesn't show it.
                const long = spansDays(o);
                if (!long && hideWeekends && isWeekend(s)) continue;
                const a = days.findIndex((day) => day >= s);
                let b = a;
                if (long) while (b + 1 < days.length && days[b + 1] <= e) b++;
                // Only on days the row leaves out: nothing to draw.
                if (a < 0 || days[a] > e) continue;
                out.push({ key: o.id, o, a, b, contStart: s < days[a], contEnd: long && e > days[b], order: (long ? 0 : 1e13) + o.start });
            }
            return out;
        }

        /**
         * Week and Day: the days' heads, an all-day row with the events that
         * last a day or more, then the hours with the timed events side by
         * side where they overlap, and a line at the current time. A click on
         * an empty time makes an hour's event there; a drag makes one as long
         * as the drag. An event dragged goes to another time or day, by its
         * bottom edge to another end, and Alt with an arrow key moves the one
         * in focus (a quarter hour, a day): `onDrop(o, times)` saves it.
         * @param ready - whether the events of these days are read (where the view opens waits for them).
         * @param movable - (o) → whether it can be dragged.
         * @param hideWeekends - whether Saturday and Sunday are left out of `days` (Alt and an arrow then go past them).
         */
        function TimeGrid({ days, zone, occurrences, now, today, onOpen, onCreate, onDay, onMore, scrollTo, ready = true, movable, onDrop, onDragging, hideWeekends = false }) {
            const scrollRef = React.useRef(null);
            const laneRef = React.useRef(null);
            const [expanded, setExpanded] = React.useState(false);
            const [drag, setDrag] = React.useState(null);
            const dragRef = React.useRef(null);
            dragRef.current = drag;
            // An event being dragged, or moved with the keys: {id, mode ('move', 'resize', 'days'), title, t: where it would go,
            // and for the keys, keys: true and words: where, in a sentence}.
            const [moving, setMoving] = React.useState(null);
            // An event moved with the keys, to keep in focus where it lands: {id, until}.
            const refocus = React.useRef(null);
            // Presses of Alt and an arrow key, gathered: {o, t, timer}; saved once after a pause or on Enter, dropped on Escape.
            const keyMove = React.useRef(null);
            const dropRef = React.useRef(onDrop);
            dropRef.current = onDrop;
            const endKeys = (save) => {
                const k = keyMove.current;
                if (!k) return;
                keyMove.current = null;
                clearTimeout(k.timer);
                setMoving(null);
                if (!save) return;
                refocus.current = { id: k.o.id, until: Date.now() + 20_000 };
                dropRef.current?.(k.o, k.t);
            };
            // Leaving the view saves a move the keys started.
            React.useEffect(() => () => endKeys(true), []);
            // Where the view opens (see openingMinute): again whenever the days shown change, and once more when their
            // events are read; each time only if the user hasn't scrolled since it was last placed.
            const daysKey = days.join(' ');
            const opening = React.useRef({ top: -1, key: '', settled: false });
            const placeOpening = (withEvents) => {
                const el = scrollRef.current;
                if (!el) return;
                const starts = withEvents ? days.flatMap((day) => {
                    const dayStart = startOfDay(day, zone);
                    return daySegments(occurrences, day, zone).filter((s) => s.o.start >= dayStart).map((s) => ({ minute: s.from, upcoming: s.o.end > Date.now() }));
                }) : EMPTY;
                el.scrollTop = Math.max(0, (openingMinute(starts, minutesIn(Date.now(), zone), days.includes(today)) / 60) * HOUR_PX - 10);
                opening.current.top = el.scrollTop;
                opening.current.settled = withEvents;
            };
            React.useLayoutEffect(() => {
                const was = opening.current;
                const el = scrollRef.current;
                const untouched = was.top < 0 || (el !== null && Math.abs(el.scrollTop - was.top) <= 1);
                if (was.key !== daysKey) {
                    was.key = daysKey;
                    if (untouched) placeOpening(ready);
                } else if (ready && !was.settled && untouched) {
                    placeOpening(true);
                }
            }, [daysKey, ready]);
            React.useEffect(() => {
                const want = refocus.current;
                if (!want) return;
                if (Date.now() > want.until) {
                    refocus.current = null;
                    return;
                }
                const active = document.activeElement;
                if (active && active !== document.body) return;
                const el = scrollRef.current?.parentElement?.querySelector(`[data-calendar-event="${cssEscape(want.id)}"]`);
                if (el) {
                    refocus.current = null;
                    el.focus({ preventScroll: false });
                }
            });

            /** The day column under a point (the nearest one beside the grid) and how far down it is, in minutes. */
            const pointAt = (x, y) => {
                const columns = [...(scrollRef.current?.querySelectorAll('[data-calendar-day-column]') ?? EMPTY)];
                if (columns.length === 0) return null;
                const rects = columns.map((c) => c.getBoundingClientRect());
                let i = rects.findIndex((r) => x >= r.left && x < r.right);
                if (i < 0) i = x < rects[0].left ? 0 : columns.length - 1;
                return { day: columns[i].getAttribute('data-calendar-day-column'), minute: clamp(((y - rects[i].top) / HOUR_PX) * 60, 0, 1440) };
            };
            /** The day in the all-day row under a point, or ''. */
            const laneDayAt = (x) => {
                for (const cell of laneRef.current?.querySelectorAll('[data-calendar-allday-cell]') ?? EMPTY) {
                    const r = cell.getBoundingClientRect();
                    if (x >= r.left && x < r.right) return cell.getAttribute('data-calendar-allday-cell');
                }
                return '';
            };
            const draggable = (event, o) => event.button === 0 && event.pointerType !== 'touch' && typeof movable === 'function' && movable(o);
            const done = () => {
                setMoving(null);
                onDragging?.('');
            };
            /** A timed event pressed: dragged to another time or day, or by its bottom edge to another end. */
            const pressEvent = (event, o) => {
                if (!draggable(event, o)) return;
                endKeys(true);
                const mode = event.target?.closest?.('.dshcal-ev-grip') ? 'resize' : 'move';
                const grab = pointAt(event.clientX, event.clientY);
                if (!grab) return;
                const session = { x: event.clientX, y: event.clientY, t: undefined, frame: 0 };
                const place = () => {
                    const at = pointAt(session.x, session.y);
                    if (!at) return;
                    const t = mode === 'resize' ? resizedTo(o, zone, at) : movedTo(o, zone, grab, at);
                    if (session.t && t.start === session.t.start && t.end === session.t.end) return;
                    session.t = t;
                    setMoving({ id: o.id, mode, title: o.title, t });
                };
                // While it's held near the top or the bottom, the hours scroll.
                const tick = () => {
                    const el = scrollRef.current;
                    if (el) {
                        const r = el.getBoundingClientRect();
                        const edge = session.y < r.top + 28 ? -1 : session.y > r.bottom - 28 ? 1 : 0;
                        if (edge !== 0) el.scrollTop += edge * 10;
                    }
                    place();
                    session.frame = requestAnimationFrame(tick);
                };
                const end = () => {
                    cancelAnimationFrame(session.frame);
                    done();
                };
                pressToDrag(event, {
                    onStart: () => {
                        onDragging?.(mode);
                        session.frame = requestAnimationFrame(tick);
                    },
                    onMove: (e) => {
                        session.x = e.clientX;
                        session.y = e.clientY;
                        place();
                    },
                    onDrop: () => {
                        end();
                        if (session.t) onDrop?.(o, session.t);
                    },
                    onCancel: end,
                });
            };
            /** An event in the all-day row pressed: dragged to another day. */
            const pressBar = (event, o) => {
                if (!draggable(event, o)) return;
                endKeys(true);
                const grabDay = laneDayAt(event.clientX);
                if (!grabDay) return;
                let at = '';
                let t;
                pressToDrag(event, {
                    onStart: () => onDragging?.('move'),
                    onMove: (e) => {
                        const day = laneDayAt(e.clientX);
                        if (day === at) return;
                        at = day;
                        t = day ? shiftedBy(o, zone, daysBetween(grabDay, day)) : undefined;
                        setMoving({ id: o.id, mode: 'days', title: o.title, t });
                    },
                    onDrop: () => {
                        done();
                        if (t) onDrop?.(o, t);
                    },
                    onCancel: done,
                });
            };
            /**
             * Alt with an arrow key on the event in focus (see keyedTo): each press from where the ones before took it,
             * shown as a drag shows it, and saved once, a moment after the last press or on Enter; Escape drops it.
             */
            const nudge = (event, o, byDays) => {
                const k = keyMove.current?.o.id === o.id ? keyMove.current : null;
                if (k && !event.altKey && (event.key === 'Enter' || event.key === 'Escape')) {
                    event.preventDefault();
                    event.stopPropagation();
                    endKeys(event.key === 'Enter');
                    return;
                }
                if (!event.altKey || event.ctrlKey || event.metaKey || typeof movable !== 'function' || !movable(o)) return;
                const t = keyedTo(k ? placedAt(o, k.t) : o, event.key, zone, { byDays, hideWeekends });
                if (!t) return;
                event.preventDefault();
                event.stopPropagation();
                // Another event's move, saved before this one starts.
                if (!k) endKeys(true);
                clearTimeout(k?.timer);
                keyMove.current = { o, t, timer: setTimeout(() => endKeys(true), KEYS_PAUSE) };
                setMoving({
                    id: o.id, mode: byDays ? 'days' : 'move', title: o.title, t, keys: true,
                    words: `“${o.title}” to ${whenText(placedAt(o, t), zone)}. Enter saves it, Escape leaves it.`,
                });
            };
            // Moved with the keys past the days shown: the nearest day shown, where it shows instead, its day named.
            const movedDays = moving?.t ? coveredDays(moving.t, zone) : null;
            const away = moving?.keys && movedDays ? (movedDays[1] < days[0] ? days[0] : movedDays[0] > days[days.length - 1] ? days[days.length - 1] : '') : '';
            /** Where the dragged event would go on a day: its piece of that day, in minutes, or null. */
            const ghostOn = (day) => {
                const t = moving?.t;
                if (!t || moving.mode === 'days') return null;
                const dayStart = startOfDay(day, zone);
                const dayEnd = startOfDay(addDays(day, 1), zone);
                if (away) {
                    if (day !== away) return null;
                    const from = minutesIn(t.start, zone);
                    const to = dayIn(t.end, zone) === dayIn(t.start, zone) ? minutesIn(t.end, zone) : 1440;
                    return { from, to: Math.max(to, Math.min(1440, from + SNAP)), first: true, day: dayIn(t.start, zone) };
                }
                if (t.end <= dayStart || t.start >= dayEnd) return null;
                const from = t.start <= dayStart ? 0 : minutesIn(t.start, zone);
                const to = t.end >= dayEnd ? 1440 : minutesIn(t.end, zone);
                return { from, to: Math.max(to, Math.min(1440, from + SNAP)), first: t.start >= dayStart };
            };
            // The days an event dragged in the all-day row would cover.
            const dropDays = moving?.mode === 'days' && movedDays ? (away ? [away, away] : movedDays) : null;
            React.useEffect(() => {
                const el = scrollRef.current;
                if (!el || !scrollTo) return;
                const top = (scrollTo.minutes / 60) * HOUR_PX;
                if (top >= el.scrollTop + 8 && top <= el.scrollTop + el.clientHeight - 60) return;
                el.scrollTop = Math.max(0, top - HOUR_PX);
                // Moved to what was asked for (now, or an event): kept when the events come, placed again on other days.
                opening.current.top = el.scrollTop;
                opening.current.settled = true;
            }, [scrollTo]);
            const n = days.length;
            // How many events fit side by side: a day's column, measured, over the narrowest that still shows a few letters.
            const [colWidth, setColWidth] = React.useState(0);
            React.useLayoutEffect(() => {
                const el = scrollRef.current;
                if (!el) return undefined;
                const measure = () => {
                    const width = el.querySelector('.dshcal-wk-col')?.clientWidth ?? 0;
                    setColWidth((was) => (Math.abs(was - width) >= 1 ? width : was));
                };
                measure();
                if (typeof ResizeObserver === 'undefined') return undefined;
                const observer = new ResizeObserver(measure);
                observer.observe(el);
                return () => observer.disconnect();
            }, [n]);
            const maxCols = colWidth > 0 ? clamp(Math.floor(colWidth / 30), 2, 8) : 8;
            const bars = barItems(occurrences, days, zone);
            const layout = lanesOf(bars, n);
            const collapsible = layout.lanes > 3;
            const cap = collapsible && !expanded ? 2 : Math.max(1, layout.lanes);
            const fitted = fitLanes(layout, cap);
            const byKey = new Map(bars.map((b) => [b.key, b]));
            const minuteAt = (event, el) => {
                const rect = el.getBoundingClientRect();
                return clamp(Math.floor((((event.clientY - rect.top) / HOUR_PX) * 60) / 15) * 15, 0, 1425);
            };
            const columnHandlers = (day) => ({
                onPointerDown: (event) => {
                    if (event.button !== 0 || event.target !== event.currentTarget) return;
                    const minute = minuteAt(event, event.currentTarget);
                    if (event.pointerType !== 'touch') {
                        try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
                    }
                    setDrag({ day, anchor: minute, from: minute, to: minute + 15, y: event.clientY, moved: false });
                },
                onPointerMove: (event) => {
                    const current = dragRef.current;
                    if (!current || current.day !== day) return;
                    const minute = minuteAt(event, event.currentTarget);
                    const moved = current.moved || Math.abs(event.clientY - current.y) > 5;
                    const from = Math.min(current.anchor, minute);
                    const to = Math.max(current.anchor, minute) + 15;
                    if (moved !== current.moved || from !== current.from || to !== current.to) setDrag({ ...current, from, to, moved });
                },
                onPointerUp: () => {
                    const current = dragRef.current;
                    if (!current || current.day !== day) return;
                    setDrag(null);
                    if (current.moved) onCreate({ day, from: current.from, to: Math.min(1440, current.to), moved: true });
                    else {
                        const from = Math.floor(current.anchor / 30) * 30;
                        onCreate({ day, from, to: Math.min(1440, from + 60) });
                    }
                },
                onPointerCancel: () => setDrag(null),
            });
            const lanesShown = Math.max(1, cap);
            const nowMinutes = minutesIn(now, zone);
            return h('div', { className: 'dshcal-wk', style: { '--days': n, '--hour': `${HOUR_PX}px` }, 'data-calendar-grid': n === 1 ? 'day' : 'week' },
                // Where the keys would move an event, for screen readers (the ghost shows it).
                h('div', { className: 'dshcal-sr', role: 'status', 'data-calendar-keys': '' }, moving?.keys ? moving.words : ''),
                h('div', { className: 'dshcal-wk-head' },
                    h('div', null),
                    days.map((day) => h('button', {
                        key: day, type: 'button', className: 'dshcal-wk-dayhead', 'data-today': day === today ? '' : undefined,
                        'aria-label': `${longDay(day, zone)}${day === today ? ', today' : ''}. Open the day.`, onClick: () => onDay(day),
                    }, h('span', null, dayText(day, { weekday: 'short' })), h('span', null, dayText(day, { day: 'numeric' }))))),
                h('div', { className: 'dshcal-wk-allday' },
                    h('div', { className: 'dshcal-wk-gutterlabel' },
                        h('span', null, TEXT.allDay),
                        collapsible ? h(IconBtn, {
                            label: expanded ? 'Show fewer all-day events' : 'Show every all-day event', size: 'sm',
                            glyph: icon(expanded ? 'IconChevronUpOutlineRegular' : 'IconChevronDownOutlineRegular', { size: 12 }),
                            onClick: () => setExpanded(!expanded), 'aria-expanded': expanded,
                        }) : null),
                    h('div', { ref: laneRef, className: 'dshcal-wk-lanes', style: { '--lanes': lanesShown } },
                        days.map((day, i) => h('button', {
                            key: `cell-${day}`, type: 'button', className: 'dshcal-wk-lanecell', style: { gridColumn: `${i + 1}`, gridRow: '1 / -1' }, tabIndex: -1,
                            'aria-label': `New all-day event on ${longDay(day, zone)}`, 'data-calendar-allday-cell': day,
                            'data-drop': dropDays && day >= dropDays[0] && day <= dropDays[1] ? '' : undefined,
                            onClick: () => onCreate({ day, allDay: true }),
                        })),
                        fitted.pieces.map((piece) => {
                            const o = byKey.get(piece.key).o;
                            return h('button', {
                                key: `${piece.key}:${piece.a}`, type: 'button', className: 'dshcal-bar', style: { ...evStyle(o.color), gridColumn: `${piece.a + 1} / ${piece.b + 2}`, gridRow: `${piece.lane + 1}` },
                                'data-look': lookOf(o), 'data-past': o.end <= now ? '' : undefined, 'data-cont-start': piece.contStart ? '' : undefined, 'data-cont-end': piece.contEnd ? '' : undefined,
                                'aria-label': `${o.title}, ${shortWhen(o, zone)}, ${o.calendar}`, 'data-calendar-event': o.id, 'data-moving': moving?.id === o.id ? '' : undefined,
                                title: typeof movable === 'function' && movable(o) ? `${o.title}\n${KEYS_TIP.days}` : undefined,
                                onClick: (event) => onOpen(o, event.currentTarget),
                                onPointerDown: (event) => pressBar(event, o),
                                onKeyDown: (event) => nudge(event, o, true),
                            }, h('span', { className: 'dshcal-bar-title' }, o.title));
                        }),
                        fitted.more.map((m) => h('button', {
                            key: `more-${m.day}`, type: 'button', className: 'dshcal-wk-more', style: { gridColumn: `${m.day + 1}`, gridRow: `${m.lane + 1}` },
                            onClick: (event) => onMore(days[m.day], event.currentTarget),
                        }, `+${m.count}`)))),
                h('div', { ref: scrollRef, className: 'dshcal-wk-scroll', 'data-calendar-scroll': '' },
                    h('div', { className: 'dshcal-wk-canvas' },
                        h('div', { className: 'dshcal-wk-hours', 'aria-hidden': true },
                            Array.from({ length: 23 }, (_, i) => i + 1).map((hour) => h('span', { key: hour, className: 'dshcal-wk-hour', style: { top: hour * HOUR_PX } }, hourText(hour)))),
                        days.map((day) => {
                            const segments = daySegments(occurrences, day, zone);
                            const cols = columnsOf(segments, 20, 30, maxCols);
                            const dayEnd = startOfDay(addDays(day, 1), zone);
                            const ghost = ghostOn(day);
                            // Its words: the title, then where it goes; under 45 minutes, on one line, where first (moved, where it starts).
                            const ghostShort = ghost !== null && ghost.to - ghost.from < 45;
                            const ghostWhere = ghost?.first ? (ghostShort && moving.mode === 'move' ? timeText(moving.t.start, zone) : ghostWords(moving.t, zone)) : '';
                            const ghostText = ghostWhere && ghost.day ? `${dayText(ghost.day)} · ${ghostWhere}` : ghostWhere;
                            return h('div', { key: day, className: 'dshcal-wk-col', 'data-today': day === today ? '' : undefined, 'data-calendar-day-column': day, ...columnHandlers(day) },
                                segments.map(({ o, from, to }) => {
                                    const place = cols.places.get(o.id);
                                    if (!place) return null;
                                    const height = Math.max(18, ((to - from) / 60) * HOUR_PX - 2);
                                    const short = height < 34;
                                    const lines = clamp(Math.floor((height - 20) / 15), 1, 8);
                                    const when = timeRangeText(o.start, o.end, zone);
                                    const can = typeof movable === 'function' && movable(o);
                                    return h('button', {
                                        key: o.id, type: 'button', className: 'dshcal-ev', 'data-calendar-event': o.id, 'data-look': lookOf(o), 'data-past': o.end <= now ? '' : undefined,
                                        'data-short': short ? '' : undefined, 'data-nested': place.level > 0 ? '' : undefined, 'data-moving': moving?.id === o.id ? '' : undefined,
                                        style: {
                                            ...evStyle(o.color), '--lines': lines, top: (from / 60) * HOUR_PX + 1, height, zIndex: 2 + place.level,
                                            left: `calc(${place.left * 100}% + 2px)`, width: `calc(${place.width * 100}% - ${place.left + place.width > 0.999 ? 8 : 3}px)`,
                                        },
                                        'aria-label': `${o.title}, ${shortWhen(o, zone, day)}, ${o.calendar}`, title: can ? `${o.title}\n${KEYS_TIP.timed}` : undefined,
                                        onClick: (event) => onOpen(o, event.currentTarget),
                                        onPointerDown: (event) => pressEvent(event, o),
                                        onKeyDown: (event) => nudge(event, o, false),
                                    },
                                    h('span', { className: 'dshcal-ev-title' }, o.title),
                                    h('span', { className: 'dshcal-ev-sub' }, short ? timeText(o.start, zone) : when),
                                    !short && height > 66 && o.location ? h('span', { className: 'dshcal-ev-sub' }, o.location) : null,
                                    // Its bottom edge, where it ends on this day: dragged, a new end.
                                    can && o.end <= dayEnd ? h('span', { className: 'dshcal-ev-grip', 'aria-hidden': true, 'data-calendar-resize': o.id }) : null);
                                }),
                                cols.more.map((m) => h('button', {
                                    key: m.key, type: 'button', className: 'dshcal-ev-more', 'data-calendar-more': day,
                                    style: {
                                        top: (m.from / 60) * HOUR_PX + 1, height: Math.max(18, ((m.to - m.from) / 60) * HOUR_PX - 2), zIndex: 2 + m.level,
                                        left: `calc(${m.left * 100}% + 2px)`, width: `calc(${m.width * 100}% - ${m.left + m.width > 0.999 ? 8 : 3}px)`,
                                    },
                                    'aria-label': `${plural(m.count, 'more event')} at ${clockText(m.from)}. Show the day's events.`,
                                    onClick: (event) => onMore(day, event.currentTarget),
                                }, `+${m.count}`)),
                                drag && drag.day === day ? h('div', {
                                    className: 'dshcal-wk-ghost', style: { top: (drag.from / 60) * HOUR_PX, height: Math.max(12, ((drag.to - drag.from) / 60) * HOUR_PX) },
                                }, clockRangeText(drag.from, Math.min(1440, drag.to))) : null,
                                ghost ? h('div', {
                                    className: 'dshcal-wk-ghost', 'data-calendar-ghost': moving.mode, 'data-short': ghostShort ? '' : undefined,
                                    style: { top: (ghost.from / 60) * HOUR_PX, height: Math.max(12, ((ghost.to - ghost.from) / 60) * HOUR_PX) },
                                }, ...(!ghostText ? [] : ghostShort ? [h('span', null, `${ghostText} · ${moving.title}`)] : [h('span', null, moving.title), h('span', null, ghostText)])) : null,
                                day === today ? h('div', { className: 'dshcal-now', style: { top: (nowMinutes / 60) * HOUR_PX }, 'aria-hidden': true }) : null);
                        }))));
        }

        // ── Month ──────────────────────────────────────────────────────────

        /**
         * The month: its weeks, each day's events as bars (all-day and
         * longer) and lines (timed), as many as a day has room for, then
         * "+N more". Arrow keys move between days (Page Up and Page Down by
         * month), Enter shows a day's events, a click on a day's empty space
         * makes an all-day event there, its number opens the day. An event
         * dragged to another day goes there at the same time of day:
         * `onDrop(o, times)` saves it. With weekends hidden, each week shows
         * its five weekdays and the keys go past Saturday and Sunday; with week
         * numbers, a narrow column before the days names each week.
         * @param movable - (o) → whether it can be dragged.
         * @param weekStart - the user's first day of the week (0 Sunday), for the weeks' numbers.
         */
        function MonthView({ days, month, zone, occurrences, today, now, onOpen, onCreateDay, onDay, onMore, onMove, focusDay, movable, onDrop, onDragging, weekStart = 1, hideWeekends = false, weekNumbers = false }) {
            /** Days in a week's row; the week number's column, when there is one, comes first. */
            const per = hideWeekends ? 5 : 7;
            const lead = weekNumbers ? 1 : 0;
            const weeksRef = React.useRef(null);
            const [cap, setCap] = React.useState(3);
            // An event being dragged to another day: {id, t: where it would go}.
            const [moving, setMoving] = React.useState(null);
            /** The day under a point, or ''. */
            const cellDayAt = (x, y) => {
                for (const cell of weeksRef.current?.querySelectorAll('[data-calendar-cell]') ?? EMPTY) {
                    const r = cell.getBoundingClientRect();
                    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return cell.getAttribute('data-calendar-cell');
                }
                return '';
            };
            const pressPiece = (event, o) => {
                if (event.button !== 0 || event.pointerType === 'touch' || typeof movable !== 'function' || !movable(o)) return;
                const grabDay = cellDayAt(event.clientX, event.clientY);
                if (!grabDay) return;
                let at = grabDay;
                let t;
                const done = () => {
                    setMoving(null);
                    onDragging?.('');
                };
                pressToDrag(event, {
                    onStart: () => {
                        onDragging?.('move');
                        setMoving({ id: o.id, t: undefined });
                    },
                    onMove: (e) => {
                        const day = cellDayAt(e.clientX, e.clientY);
                        if (day === at && t) return;
                        at = day;
                        t = day ? shiftedBy(o, zone, daysBetween(grabDay, day)) : undefined;
                        setMoving({ id: o.id, t });
                    },
                    onDrop: () => {
                        done();
                        if (t) onDrop?.(o, t);
                    },
                    onCancel: done,
                });
            };
            const dropDays = moving?.t ? coveredDays(moving.t, zone) : null;
            const weeks = [];
            for (let i = 0; i < days.length; i += per) weeks.push(days.slice(i, i + per));
            React.useLayoutEffect(() => {
                const el = weeksRef.current;
                if (!el) return undefined;
                const measure = () => {
                    const rowHeight = el.clientHeight / Math.max(1, weeks.length);
                    setCap(Math.max(1, Math.floor((rowHeight - 28 - 6) / 22)));
                };
                measure();
                if (typeof ResizeObserver === 'undefined') return undefined;
                const observer = new ResizeObserver(measure);
                observer.observe(el);
                return () => observer.disconnect();
            }, [weeks.length]);
            const [focused, setFocused] = React.useState(() => (days.includes(focusDay) ? focusDay : days.includes(today) && today.slice(0, 7) === month ? today
                : days.find((day) => day.slice(0, 7) === month) ?? `${month}-01`));
            const wantFocus = React.useRef(false);
            React.useEffect(() => {
                if (days.includes(focusDay)) setFocused(focusDay);
            }, [focusDay, days[0]]);
            React.useEffect(() => {
                if (!wantFocus.current) return;
                wantFocus.current = false;
                weeksRef.current?.querySelector(`[data-calendar-cell="${focused}"]`)?.focus({ preventScroll: true });
            });
            const move = (day) => {
                wantFocus.current = true;
                if (days.includes(day) && day.slice(0, 7) === month) setFocused(day);
                else {
                    setFocused(day);
                    onMove(day);
                }
            };
            const onKey = (event, day) => {
                const row = Math.floor(days.indexOf(day) / per) * per;
                const keys = {
                    ArrowLeft: () => addShownDays(day, -1, hideWeekends), ArrowRight: () => addShownDays(day, 1, hideWeekends), ArrowUp: () => addDays(day, -7), ArrowDown: () => addDays(day, 7),
                    Home: () => days[row], End: () => days[row + per - 1],
                    PageUp: () => shownNear(addMonths(day, -1), hideWeekends), PageDown: () => shownNear(addMonths(day, 1), hideWeekends),
                };
                if (keys[event.key] && !event.altKey && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    move(keys[event.key]());
                } else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onMore(day, event.currentTarget);
                }
            };
            const tabStop = days.includes(focused) ? focused : days[0];
            /** A day's column in its week's row, from 1 (after the week number's, when there is one). */
            const column = (i) => i + 1 + lead;
            return h('div', { className: 'dshcal-mo', 'data-calendar-grid': 'month', style: { '--cols': per }, 'data-cols': per, 'data-week-numbers': weekNumbers ? '' : undefined },
                h('div', { className: 'dshcal-mo-head', 'aria-hidden': true },
                    weekNumbers ? h('div', { key: 'wk', className: 'dshcal-mo-wd' }) : null,
                    days.slice(0, per).map((day) => h('div', { key: day, className: 'dshcal-mo-wd' }, dayText(day, { weekday: 'short' })))),
                h('div', { ref: weeksRef, className: 'dshcal-mo-weeks', style: { '--weeks': weeks.length }, role: 'grid', 'aria-label': dayText(`${month}-01`, { month: 'long', year: 'numeric' }) },
                    weeks.map((week) => {
                        const items = barItems(occurrences, week, zone, () => true, hideWeekends);
                        const layout = lanesOf(items, per);
                        const fitted = fitLanes(layout, cap);
                        const byKey = new Map(items.map((b) => [b.key, b]));
                        const number = weekNumbers ? weekNumberOf(week[0], weekStart) : 0;
                        return h('div', { key: week[0], className: 'dshcal-mo-week', role: 'row', style: { '--lanes': cap } },
                            // The week's number, first in its row: "Week 42" to a screen reader.
                            weekNumbers ? h('div', { key: 'wk', className: 'dshcal-mo-wk', role: 'rowheader', 'data-calendar-week-number': number, style: { gridColumn: '1', gridRow: '1 / -1' } },
                                h('span', { className: 'dshcal-sr' }, 'Week '), number) : null,
                            week.map((day, i) => {
                                const count = layout.perDay[i];
                                const names = layout.placed.filter((p) => p.a <= i && p.b >= i).slice(0, 3).map((p) => byKey.get(p.key).o.title);
                                return h('div', {
                                    key: day, className: 'dshcal-mo-cell', role: 'gridcell', tabIndex: day === tabStop ? 0 : -1, style: { gridColumn: `${column(i)}` },
                                    'data-out': day.slice(0, 7) !== month ? '' : undefined, 'data-calendar-cell': day,
                                    'data-drop': dropDays && day >= dropDays[0] && day <= dropDays[1] ? '' : undefined,
                                    'aria-label': `${longDay(day, zone)}${day === today ? ', today' : ''}, ${count ? `${plural(count, 'event')}: ${names.join(', ')}${count > 3 ? '…' : ''}` : 'no events'}`,
                                    onFocus: () => setFocused(day),
                                    onKeyDown: (event) => onKey(event, day),
                                    onClick: (event) => { if (event.target === event.currentTarget) onCreateDay(day); },
                                });
                            }),
                            week.map((day, i) => h('button', {
                                key: `n-${day}`, type: 'button', className: 'dshcal-mo-num', tabIndex: -1, 'aria-hidden': true, style: { gridColumn: `${column(i)}` },
                                'data-out': day.slice(0, 7) !== month ? '' : undefined, 'data-today': day === today ? '' : undefined,
                                onClick: () => onDay(day),
                            }, Number(day.slice(8, 10)) === 1 ? dayText(day, { month: 'short', day: 'numeric' }) : Number(day.slice(8, 10)))),
                            fitted.pieces.map((piece) => {
                                const o = byKey.get(piece.key).o;
                                const style = { ...evStyle(o.color), gridColumn: `${column(piece.a)} / ${column(piece.b) + 1}`, gridRow: `${piece.lane + 2}` };
                                const common = {
                                    key: `${piece.key}:${piece.a}`, type: 'button', tabIndex: -1, 'aria-hidden': true, 'data-calendar-event': o.id, 'data-look': lookOf(o),
                                    'data-past': o.end <= now ? '' : undefined, onClick: (event) => onOpen(o, event.currentTarget), title: `${o.title} · ${shortWhen(o, zone)}`,
                                    'data-moving': moving?.id === o.id ? '' : undefined, onPointerDown: (event) => pressPiece(event, o),
                                };
                                if (spansDays(o)) {
                                    return h('button', { ...common, className: 'dshcal-bar', style, 'data-cont-start': piece.contStart ? '' : undefined, 'data-cont-end': piece.contEnd ? '' : undefined },
                                        h('span', { className: 'dshcal-bar-title' }, o.title));
                                }
                                return h('button', { ...common, className: 'dshcal-line', style },
                                    h('span', { className: 'dshcal-dot' }),
                                    h('span', { className: 'dshcal-line-time' }, shortTime(o.start, zone)),
                                    h('span', { className: 'dshcal-line-title' }, o.title));
                            }),
                            fitted.more.map((m) => h('button', {
                                key: `more-${m.day}`, type: 'button', className: 'dshcal-mo-more', tabIndex: -1, style: { gridColumn: `${column(m.day)}`, gridRow: `${m.lane + 2}` },
                                'data-calendar-more': week[m.day], onClick: (event) => onMore(week[m.day], event.currentTarget),
                            }, `+${m.count} more`)));
                    })));
        }

        // ── Agenda ─────────────────────────────────────────────────────────

        /** The coming events by day, each day with its events in time order; a day an event spans lists it too. */
        function agendaDays(occurrences, firstDay, lastDay, zone) {
            const byDay = new Map();
            for (const o of occurrences) {
                const [s, e] = daysOf(o, zone);
                const from = s < firstDay ? firstDay : s;
                const to = e > lastDay ? lastDay : e;
                for (let d = from, i = 0; d <= to && i < 62; d = addDays(d, 1), i++) {
                    const list = byDay.get(d) ?? [];
                    list.push(o);
                    byDay.set(d, list);
                }
            }
            return [...byDay.keys()].sort().map((day) => ({
                day,
                list: byDay.get(day).sort((a, b) => Number(spansDays(b)) - Number(spansDays(a)) || a.start - b.start),
            }));
        }

        /** A day in the Agenda layout: its date, then its events, each opening on a click. */
        function agendaDay({ day, list }, { zone, today, now, onOpen }) {
            const year = day.slice(0, 4) !== today.slice(0, 4);
            return h('section', { key: day, className: 'dshcal-ag-day', 'aria-label': longDay(day, zone) },
                h('div', { className: 'dshcal-ag-date', 'data-today': day === today ? '' : undefined },
                    h('b', null, Number(day.slice(8, 10))),
                    h('span', null, day === today ? TEXT.today : dayText(day, { weekday: 'short', month: 'short', ...(year ? { year: 'numeric' } : {}) }))),
                h('div', { className: 'dshcal-ag-list' }, list.map((o) => h('button', {
                    key: o.id, type: 'button', className: 'dshcal-ag-row', style: evStyle(o.color), 'data-look': lookOf(o), 'data-calendar-event': o.id,
                    'data-past': o.end <= now ? '' : undefined, onClick: (event) => onOpen(o, event.currentTarget),
                },
                h('span', { className: 'dshcal-ag-time' }, h('span', { className: 'dshcal-dot' }), shortWhen(o, zone, day)),
                h('span', { className: 'dshcal-ag-what' },
                    h('span', { className: 'dshcal-ag-title' }, o.title),
                    h('span', { className: 'dshcal-ag-sub' }, [o.location, o.calendar].filter(Boolean).join(' · ')))))));
        }

        function AgendaList({ firstDay, lastDay, zone, occurrences, today, now, onOpen, onLater, loading }) {
            const groups = agendaDays(occurrences, firstDay, lastDay, zone);
            return h('div', { className: 'dshcal-ag', 'data-calendar-grid': 'agenda' },
                groups.length === 0 && !loading ? h('div', { className: 'dshcal-state' }, `Nothing from ${dayText(firstDay, { month: 'short', day: 'numeric' })} to ${dayText(lastDay, { month: 'short', day: 'numeric', year: 'numeric' })}.`) : null,
                groups.map((group) => agendaDay(group, { zone, today, now, onOpen })),
                groups.length ? h('div', { className: 'dshcal-ag-foot' }, h(Btn, { onClick: onLater, 'data-calendar-later': '' }, 'Show later events')) : null);
        }

        // ── Search ─────────────────────────────────────────────────────────

        /**
         * What a search found, by the day each event starts, in the plugin's
         * order: those still to come (soonest first), then the earlier ones
         * (latest first). → {upcoming: [{day, list}], past: [{day, list}]}.
         */
        function searchGroups(occurrences, zone, now) {
            const upcoming = [];
            const past = [];
            for (const o of occurrences ?? EMPTY) {
                if (!isObject(o) || !Number.isFinite(o.start) || !Number.isFinite(o.end)) continue;
                const into = o.end >= now ? upcoming : past;
                const day = daysOf(o, zone)[0];
                const last = into[into.length - 1];
                if (last?.day === day) last.list.push(o);
                else into.push({ day, list: [o] });
            }
            return { upcoming, past };
        }

        /**
         * The events a search found, in the Agenda layout.
         * @param found - {words, loading, data?: {occurrences, more}, dataWords, error}.
         */
        function SearchList({ found, zone, today, now, onOpen, onRetry }) {
            const data = found?.data;
            const list = data?.occurrences ?? EMPTY;
            const { upcoming, past } = searchGroups(list, zone, now);
            const options = { zone, today, now, onOpen };
            let content;
            if (found?.error) {
                content = h('div', { className: 'dshcal-state', 'data-calendar-state': 'error' }, h('span', { className: 'dshcal-error' }, found.error), h(Btn, { onClick: onRetry }, TEXT.retry));
            } else if (!data) {
                content = h('div', { className: 'dshcal-state', role: 'status' }, h(Spinner), h('span', null, 'Searching…'));
            } else if (list.length === 0) {
                content = h('div', { className: 'dshcal-state', role: 'status' },
                    h('span', null, `Nothing matches “${found.dataWords}”.`),
                    h('span', { className: 'dshcal-hint' }, 'Search looks through the calendars shown, a year back and a year ahead.'));
            } else {
                content = h(React.Fragment, null,
                    h('div', { className: 'dshcal-ag-part', role: 'status' }, data.more ? `The first ${list.length} found` : `${plural(list.length, 'event')} found`),
                    upcoming.map((group) => agendaDay(group, options)),
                    past.length ? h('div', { className: 'dshcal-ag-part' }, 'Earlier') : null,
                    past.map((group) => agendaDay(group, options)),
                    data.more ? h('div', { className: 'dshcal-ag-foot dshcal-hint' }, 'More match than are shown here: add a word to narrow it.') : null);
            }
            return h('div', { className: 'dshcal-ag', 'data-calendar-grid': 'search', role: 'region', 'aria-label': `Search for “${found?.words ?? ''}”` }, content);
        }

        // ── The side column ────────────────────────────────────────────────

        /**
         * A small month to jump to a day; the days on show are marked, and
         * each week's number is in front of it when the user asked for them.
         * One tab stop: arrow keys move between days (Home and End to the
         * week's ends, Page Up and Page Down by month), Enter picks one.
         */
        function MiniMonth({ anchor, today, weekStart, weekNumbers = false, shown, onPick }) {
            const [month, setMonth] = React.useState(monthStart(anchor));
            const [focused, setFocused] = React.useState(anchor);
            const gridRef = React.useRef(null);
            const wantFocus = React.useRef(false);
            React.useEffect(() => {
                setMonth(monthStart(anchor));
                setFocused(anchor);
            }, [anchor]);
            React.useEffect(() => {
                if (!wantFocus.current) return;
                wantFocus.current = false;
                gridRef.current?.querySelector(`[data-calendar-mini-day="${focused}"]`)?.focus();
            });
            const first = weekStartOf(month, weekStart);
            const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
            const inMonth = (day) => day.slice(0, 7) === month.slice(0, 7);
            const tabStop = inMonth(focused) ? focused : inMonth(today) ? today : month;
            const onKey = (event, day) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                const into = (weekdayOf(day) - weekStart + 7) % 7;
                const keys = {
                    ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -into, End: 6 - into,
                };
                let next;
                if (event.key in keys) next = addDays(day, keys[event.key]);
                else if (event.key === 'PageUp' || event.key === 'PageDown') next = addMonths(day, event.key === 'PageUp' ? -1 : 1);
                if (!next) return;
                event.preventDefault();
                wantFocus.current = true;
                setFocused(next);
                if (!inMonth(next)) setMonth(monthStart(next));
            };
            return h('div', { className: 'dshcal-mini', 'data-calendar-mini': '' },
                h('div', { className: 'dshcal-mini-head' },
                    h('span', { className: 'dshcal-mini-title' }, dayText(month, { month: 'long', year: 'numeric' })),
                    h(IconBtn, { label: 'Previous month', glyph: icon('IconChevronLeftOutlineRegular'), size: 'sm', tip: false, onClick: () => setMonth(addMonths(month, -1)) }),
                    h(IconBtn, { label: 'Next month', glyph: icon('IconChevronRightOutlineRegular'), size: 'sm', tip: false, onClick: () => setMonth(addMonths(month, 1)) })),
                h('div', { ref: gridRef, className: 'dshcal-mini-grid', 'data-week-numbers': weekNumbers ? '' : undefined },
                    weekNumbers ? h('span', { key: 'wd', className: 'dshcal-mini-wd', 'aria-hidden': true }) : null,
                    days.slice(0, 7).map((day) => h('span', { key: `wd-${day}`, className: 'dshcal-mini-wd', 'aria-hidden': true }, dayText(day, { weekday: 'narrow' }))),
                    days.flatMap((day, i) => [
                        // A week's number, in front of its days: "Week 42" to a screen reader.
                        weekNumbers && i % 7 === 0 ? h('span', { key: `wk-${day}`, className: 'dshcal-mini-wk', 'data-calendar-mini-week': weekNumberOf(day, weekStart) },
                            h('span', { className: 'dshcal-sr' }, 'Week '), weekNumberOf(day, weekStart)) : null,
                        h('button', {
                            key: day, type: 'button', className: 'dshcal-mini-day', 'aria-label': longDay(day, 'UTC'), 'aria-current': day === today ? 'date' : undefined,
                            tabIndex: day === tabStop ? 0 : -1, 'data-calendar-mini-day': day,
                            'data-out': inMonth(day) ? undefined : '', 'data-today': day === today ? '' : undefined, 'data-in-range': shown.has(day) && day !== today ? '' : undefined,
                            onFocus: () => setFocused(day),
                            onKeyDown: (event) => onKey(event, day),
                            onClick: () => onPick(day),
                        }, Number(day.slice(8, 10))),
                    ])));
        }

        /** The calendars by account: each with its color, shown or hidden, and its ⋯ menu. */
        function CalendarList({ cal, onDialog }) {
            const store = cal.store;
            const state = store.state();
            const [menu, setMenu] = React.useState('');
            const fileRef = React.useRef(null);
            const importTo = React.useRef('');
            if (!state) return null;
            const accounts = state.accounts ?? EMPTY;
            const calendars = state.calendars ?? EMPTY;
            const toggle = async (c) => {
                const result = await store.act('updateCalendar', { id: c.id, patch: { hidden: !c.hidden } });
                if (!result.ok) store.toast(errorText(result.error), 'error');
            };
            const exportIcs = async (c) => {
                const result = await store.link.call('exportCalendar', { id: c.id });
                if (!result.ok) {
                    store.toast(errorText(result.error), 'error');
                    return;
                }
                try {
                    const blob = new Blob([result.value.ics], { type: 'text/calendar;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${String(result.value.name || c.name).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'calendar'}.ics`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 10_000);
                    store.toast(`Exported ${plural(result.value.events ?? 0, 'event')} from “${c.name}”.`);
                } catch (error) {
                    store.toast(`The file couldn't be saved: ${error?.message ?? error}`, 'error');
                }
            };
            const importFile = async (file) => {
                const id = importTo.current;
                if (!file || !id) return;
                if (file.size > 20 * 1024 * 1024) {
                    store.toast('That file is too big for a calendar (over 20 MB).', 'error');
                    return;
                }
                let text;
                try {
                    text = await file.text();
                } catch (error) {
                    store.toast(`The file couldn't be read: ${error?.message ?? error}`, 'error');
                    return;
                }
                const result = await store.act('importIcs', { calendarId: id, ics: text });
                if (result.ok) store.toast(`Added ${plural(result.value.added ?? 0, 'event')}${result.value.skipped ? `, ${result.value.skipped} already there` : ''}.`);
                else store.toast(errorText(result.error), 'error');
            };
            const items = (c, account) => [
                { id: 'rename', label: 'Rename…', icon: icon('IconEditOutlineRegular') },
                {
                    id: 'color', label: 'Color', icon: h('span', { className: 'dshcal-menu-swatch', style: { '--sw': colorOf(c.color) } }),
                    submenu: [...PALETTE.map((p, i) => ({ id: `color:${p}`, label: `Color ${i + 1}`, icon: h('span', { className: 'dshcal-menu-swatch', style: { '--sw': p } }) })), { id: 'color:custom', label: 'Other color…' }],
                },
                ...(!c.readOnly && !c.isDefault ? [{ id: 'default', label: 'Use for new events', icon: icon('IconCheckOutlineRegular') }] : []),
                { type: 'separator', id: 'sep1' },
                { id: 'export', label: 'Export .ics', icon: icon('IconDownloadOutlineRegular') },
                ...(!c.readOnly ? [{ id: 'import', label: 'Import .ics…', icon: icon('IconPlusOutlineRegular') }] : []),
                ...(account?.kind === 'local' ? [{ type: 'separator', id: 'sep2' }, { id: 'delete', label: 'Delete calendar…', icon: icon('IconTrashOutlineRegular'), danger: true }] : []),
            ];
            const select = (c, id) => {
                setMenu('');
                if (id === 'rename') onDialog({ kind: 'rename-calendar', calendar: c });
                else if (id === 'color:custom') onDialog({ kind: 'color', calendar: c });
                else if (id.startsWith('color:')) {
                    void store.act('updateCalendar', { id: c.id, patch: { color: id.slice(6) } }).then((r) => { if (!r.ok) store.toast(errorText(r.error), 'error'); });
                } else if (id === 'default') {
                    store.choseDefault(c.id);
                    void store.act('setDefaultCalendar', { id: c.id }).then((r) => store.toast(r.ok ? `New events go to “${c.name}”.` : errorText(r.error), r.ok ? 'ok' : 'error'));
                } else if (id === 'export') void exportIcs(c);
                else if (id === 'import') {
                    importTo.current = c.id;
                    if (fileRef.current) {
                        fileRef.current.value = '';
                        fileRef.current.click();
                    }
                } else if (id === 'delete') onDialog({ kind: 'delete-calendar', calendar: c });
            };
            const groups = accounts.map((a) => ({ account: a, list: calendars.filter((c) => c.accountId === a.id) })).filter((g) => g.list.length > 0);
            const orphans = calendars.filter((c) => !accounts.some((a) => a.id === c.accountId));
            if (orphans.length) groups.push({ account: { id: '', name: 'Other', kind: '' }, list: orphans });
            return h('div', { className: 'dshcal-cals', 'data-calendar-list': '' },
                h('input', {
                    ref: fileRef, type: 'file', accept: '.ics,.ical,.ifb,.icalendar,text/calendar', hidden: true, 'aria-hidden': true, tabIndex: -1, 'data-calendar-import-file': '',
                    onChange: (event) => void importFile(event.target.files?.[0]),
                }),
                groups.map(({ account, list }) => h('div', { key: account.id || 'other', role: 'group', 'aria-label': account.name },
                    h('div', { className: 'dshcal-acct-head' },
                        h('span', { title: account.email || account.name }, account.name),
                        account.status === 'syncing' ? h(Spinner, { size: 12 }) : null,
                        account.status === 'signin' || account.status === 'error'
                            ? h(IconBtn, {
                                label: `${account.name}: ${account.problem || (account.status === 'signin' ? 'sign-in needed' : 'the last sync failed')}`, size: 'sm', className: 'dshcal-warn',
                                glyph: icon('IconWarningOutlineRegular', { size: 13 }), onClick: () => onDialog({ kind: 'accounts' }),
                            }) : null),
                    list.map((c) => h('div', { key: c.id, className: 'dshcal-cal', 'data-calendar-cal': c.id },
                        h('button', {
                            type: 'button', className: 'dshcal-cal-toggle', role: 'checkbox', 'aria-checked': !c.hidden, title: c.error ? `${c.name}: ${c.problem || c.error}` : c.name,
                            style: { '--cal-color': colorOf(c.color), '--cal-color-text': textOn(colorOf(c.color)) },
                            onClick: () => void toggle(c),
                        },
                        h('span', { className: 'dshcal-cal-box', 'aria-hidden': true }, c.hidden ? null : icon('IconCheckOutlineRegular', { size: 10, strokeWidth: 2 })),
                        h('span', { className: 'dshcal-cal-name' }, c.name),
                        c.readOnly ? h('span', { className: 'dshcal-faint', title: 'Read only', 'aria-label': 'read only', style: { display: 'inline-flex' } }, h(LockGlyph, { size: 12 })) : null,
                        c.isDefault ? h('span', { className: 'dshcal-tag', title: 'New events go here' }, 'default') : null,
                        c.error ? h('span', { className: 'dshcal-warn', style: { display: 'inline-flex' }, 'aria-label': c.problem || c.error }, icon('IconWarningOutlineRegular', { size: 12 })) : null),
                        ui.Menu ? h(ui.Menu, {
                            open: menu === c.id, items: items(c, account), portal: true, align: 'end', autoFocus: true, listClassName: 'dshcal-menu',
                            onSelect: (id) => select(c, id), onClose: () => setMenu(''),
                            anchor: h('button', {
                                type: 'button', className: 'dshcal-cal-more', 'aria-label': `Calendar actions: ${c.name}`, 'aria-haspopup': 'menu', 'aria-expanded': menu === c.id,
                                'data-calendar-cal-menu': c.id, onClick: () => setMenu(menu === c.id ? '' : c.id),
                            }, icon('IconEllipsisOutlineRegular')),
                        }) : null)))));
        }

        // ── Accounts ───────────────────────────────────────────────────────

        /** What Add account offers, in its order; CalDAV ones name their preset (the host's PRESETS). */
        const PROVIDERS = [
            { id: 'icloud', name: 'Apple iCloud', text: 'The calendars on your iPhone, iPad and Mac.' },
            { id: 'google', name: 'Google', text: 'Google Calendar, with a Gmail or Google Workspace account.' },
            { id: 'microsoft', name: 'Microsoft 365 · Outlook.com', text: 'Exchange Online: work, school and personal Microsoft accounts.' },
            { id: 'fastmail', name: 'Fastmail', text: 'With an app password.' },
            { id: 'nextcloud', name: 'Nextcloud', text: 'The calendars on your Nextcloud.' },
            { id: 'yahoo', name: 'Yahoo', text: 'With an app password.' },
            { id: 'mailbox.org', name: 'mailbox.org', text: 'With your password or an application password.' },
            { id: 'zoho', name: 'Zoho Calendar', text: 'With your password or an application-specific password.' },
            { id: 'other', name: 'Other CalDAV server', text: 'Radicale, Baïkal, SOGo, Synology and any other server that speaks CalDAV.' },
            { id: 'subscribe', name: 'Subscribe by address', text: 'A published calendar (.ics or webcal://): holidays, sports, a school. Read only.' },
            { id: 'local', name: 'New calendar kept in DSH', text: 'Kept in DSH, synced nowhere.' },
        ];
        const PRESET_BADGES = { icloud: 'iC', fastmail: 'F', nextcloud: 'N', yahoo: 'Y', 'mailbox.org': 'mb', zoho: 'Z' };
        function accountBadge(account) {
            if (account.kind === 'google') return 'G';
            if (account.kind === 'microsoft') return 'M';
            if (account.kind === 'caldav') return PRESET_BADGES[account.preset] ?? 'C';
            if (account.kind === 'ics') return h(RepeatGlyph, { size: 15 });
            return h(CalendarIcon, { size: 16 });
        }
        /** "5 minutes ago", in the browser's language. */
        function relativeText(ms) {
            const seconds = Math.round((ms - Date.now()) / 1000);
            try {
                const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
                if (Math.abs(seconds) < 60) return format.format(0, 'second');
                if (Math.abs(seconds) < 3600) return format.format(Math.round(seconds / 60), 'minute');
                if (Math.abs(seconds) < 86400) return format.format(Math.round(seconds / 3600), 'hour');
                return format.format(Math.round(seconds / 86400), 'day');
            } catch {
                return new Date(ms).toLocaleString();
            }
        }

        /** Buttons a dialog's page puts among its dialog's footer buttons (target: the footer's slot). */
        function FooterSlot({ target, children }) {
            return target ? ReactDOM.createPortal(children, target) : null;
        }

        /**
         * A Google or Microsoft sign-in from start to end: start it (its page
         * opens in a new tab; a Microsoft sign-in with method 'code' has a
         * code to enter on Microsoft's page instead), then ask how it stands
         * every 2 s until it's done or failed. Leaving it cancels it.
         */
        function useSignIn(store, kind, accountId) {
            const [flow, setFlow] = React.useState(null);
            const [error, setError] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const alive = useAlive();
            const flowRef = React.useRef(null);
            flowRef.current = flow;
            React.useEffect(() => () => {
                const current = flowRef.current;
                if (current?.status === 'waiting') void store.link.call('cancelSignIn', { flow: current.flow });
            }, [store]);
            const waiting = flow?.status === 'waiting' ? flow.flow : '';
            React.useEffect(() => {
                if (!waiting) return undefined;
                const timer = setInterval(async () => {
                    const result = await store.link.call('signInStatus', { flow: waiting });
                    if (!alive.current || flowRef.current?.flow !== waiting) return;
                    if (result.ok && isObject(result.value)) {
                        setFlow(result.value);
                        if (result.value.status === 'done') void store.refresh();
                    } else if (!result.ok) {
                        setFlow({ ...flowRef.current, status: 'failed', error: errorText(result.error) });
                    }
                }, 2000);
                return () => clearInterval(timer);
            }, [waiting, store, alive]);
            /** method: '' for the provider's page in the browser, 'code' for a Microsoft sign-in with a code. */
            const start = async (method = '') => {
                const current = flowRef.current;
                if (current?.status === 'waiting') void store.link.call('cancelSignIn', { flow: current.flow });
                setFlow(null);
                setBusy(true);
                setError('');
                const result = await store.link.call('startSignIn', { kind, accountId: accountId ?? '', ...(method ? { method } : {}) });
                if (!alive.current) {
                    // The dialog closed while it started: nobody waits for it now.
                    if (result.ok && result.value?.status === 'waiting' && typeof result.value.flow === 'string') void store.link.call('cancelSignIn', { flow: result.value.flow });
                    return;
                }
                setBusy(false);
                if (!result.ok) {
                    setError(errorText(result.error));
                    return;
                }
                setFlow(result.value);
                if (isUrl(result.value?.url)) {
                    try { window.open(result.value.url, '_blank', 'noopener,noreferrer'); } catch {}
                }
            };
            const finish = async (address) => {
                if (!flow) return false;
                setBusy(true);
                setError('');
                const result = await store.link.call('finishSignIn', { flow: flow.flow, url: address });
                if (!alive.current) return false;
                setBusy(false);
                if (!result.ok) {
                    setError(errorText(result.error));
                    return false;
                }
                setFlow(result.value);
                if (result.value?.status === 'done') void store.refresh();
                return true;
            };
            return { flow, error, busy, start, finish };
        }

        const outLink = (href, text) => h('a', { className: 'dshcal-link', href, target: '_blank', rel: 'noopener noreferrer' }, text);
        const smallLink = { alignSelf: 'flex-start', fontSize: 12 };

        /** Where a sign-in's page sends the browser back to (the redirect_uri of its address), without the last '/', or ''. */
        function returnAddress(url) {
            try {
                const back = new URL(String(url ?? '')).searchParams.get('redirect_uri') ?? '';
                return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[^\s?#]*)?$/i.test(back) ? back.replace(/\/$/, '') : '';
            } catch {
                return '';
            }
        }

        /**
         * A sign-in on the provider's page in another tab: open it again, and
         * when DSH runs on another computer (the page can't come back to it),
         * finish it with the address the browser ended on.
         * @param who - 'Google' or 'Microsoft'.
         * @param prefix - the fields' names: 'google' or 'microsoft'.
         */
        function SignInWait({ who, prefix, flow, busy, onFinish, fallback }) {
            const [address, setAddress] = React.useState('');
            const back = returnAddress(flow.url) || fallback;
            const id = `dshcal-${prefix}-paste`;
            const finish = async () => {
                const value = address.trim();
                if (value === '' || busy) return;
                if (await onFinish(value)) setAddress('');
            };
            return h(React.Fragment, null,
                h('div', { className: 'dshcal-wait', role: 'status' }, h(Spinner), `Waiting for you to finish on ${who}'s page…`),
                isUrl(flow.url) ? h('a', { className: 'dshcal-btn', href: flow.url, target: '_blank', rel: 'noopener noreferrer', style: { alignSelf: 'flex-start' }, [`data-calendar-${prefix}-open`]: '' },
                    icon('IconRightUpOutlineRegular'), `Open ${who}'s page again`) : null,
                h(Field, { label: 'Did the page end on an address that didn\'t load?', id, hint: `When DSH runs on another computer, ${who} can't come back to it: copy that address (it starts with ${back}) and paste it here.` },
                    h('div', { className: 'dshcal-inline', style: { flexWrap: 'nowrap' } },
                        h('input', {
                            id, className: 'dshcal-input', style: { flex: 1 }, value: address, placeholder: `${back}/?code=…`, spellCheck: false, autoComplete: 'off', [`data-calendar-${prefix}-paste`]: '',
                            onChange: (e) => setAddress(e.target.value),
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    void finish();
                                }
                            },
                        }),
                        h(Btn, { disabled: address.trim() === '' || busy, onClick: () => void finish(), [`data-calendar-${prefix}-finish`]: '' }, busy ? h(Spinner) : null, 'Finish'))));
        }

        /** The steps to make the Google OAuth client the sign-in needs, and its id and secret. */
        function GoogleSetup({ store, signIn, onReady, slot }) {
            const [clientId, setClientId] = React.useState(signIn?.clientId ?? '');
            const [secret, setSecret] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const needSecret = !signIn?.secretSet;
            const ready = clientId.trim() !== '' && (!needSecret || secret.trim() !== '');
            const save = async () => {
                if (busy || !ready) return;
                setBusy(true);
                setError('');
                const value = secret;
                setSecret('');
                const result = await store.act('setGoogleClient', { clientId: clientId.trim(), clientSecret: value });
                if (!alive.current) return;
                setBusy(false);
                if (!result.ok) setError(errorText(result.error));
                else if (result.value?.signIn?.google?.ready === false) setError('The client secret is still missing.');
                else onReady();
            };
            return h('form', { className: 'dshcal-form', 'data-calendar-google-setup': '', onSubmit: (e) => { e.preventDefault(); void save(); } },
                h('div', { className: 'dshcal-note' }, icon('IconInfoOutlineRegular'),
                    h('span', null, 'Google lets an app like this sign in only through an OAuth client of your own. Making one takes a few minutes, once.')),
                h('ol', { className: 'dshcal-steps' },
                    h('li', null, 'In ', outLink('https://console.cloud.google.com/projectcreate', 'Google Cloud Console'), ', create a project, or pick one.'),
                    h('li', null, 'Turn on the ', outLink('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Google Calendar API'), ' for it.'),
                    h('li', null, 'Set up its ', outLink('https://console.cloud.google.com/apis/credentials/consent', 'OAuth consent screen'), ': ', h('b', null, 'External'),
                        '. With a Google Workspace account you can pick ', h('b', null, 'Internal'), ' instead, for your organization only, and skip the next step.'),
                    h('li', null, 'Under Audience, ', h('b', null, 'Publish app'), ', so it is In production. An app left in Testing has Google end its sign-ins after 7 days.'),
                    h('li', null, 'Under ', outLink('https://console.cloud.google.com/apis/credentials', 'Credentials'), ', Create credentials → OAuth client ID, of type ', h('b', null, 'Desktop app'), '. Copy its client ID and client secret here.')),
                h('p', { className: 'dshcal-hint', style: { margin: 0 }, 'data-calendar-google-unverified': '' },
                    'Signing in, Google first says it hasn\'t verified the app. It\'s your own: choose ', h('b', null, 'Advanced'), ', then ', h('b', null, 'Go to'), ' your app\'s name.'),
                h(Field, { label: 'Client ID', id: 'dshcal-google-id' },
                    h('input', { id: 'dshcal-google-id', className: 'dshcal-input', value: clientId, placeholder: '….apps.googleusercontent.com', spellCheck: false, autoComplete: 'off', 'data-modal-autofocus': true, 'data-calendar-google-id': '', onChange: (e) => setClientId(e.target.value) })),
                h(Field, { label: 'Client secret', id: 'dshcal-google-secret', hint: 'Kept in DSH\'s credential store, not in the plugin\'s files.' },
                    h('input', {
                        id: 'dshcal-google-secret', className: 'dshcal-input', type: 'password', value: secret, autoComplete: 'off', spellCheck: false, 'data-calendar-google-secret': '',
                        placeholder: needSecret ? '' : 'Saved. Leave empty to keep it.', onChange: (e) => setSecret(e.target.value),
                    })),
                h(Alert, { text: error }),
                h('button', { type: 'submit', hidden: true, tabIndex: -1 }),
                h(FooterSlot, { target: slot },
                    h(ui.Button, { variant: 'primary', disabled: busy || !ready, onClick: () => void save(), 'data-calendar-google-save': '' }, busy ? h(Spinner) : null, 'Save and continue')));
        }

        /** The steps to make the Microsoft app registration the sign-in needs, and its id. */
        function MicrosoftSetup({ store, signIn, onReady, slot }) {
            const [clientId, setClientId] = React.useState(signIn?.clientId ?? '');
            const [tenant, setTenant] = React.useState(signIn?.tenant ?? 'common');
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const save = async () => {
                if (busy || clientId.trim() === '') return;
                setBusy(true);
                setError('');
                const result = await store.act('setMicrosoftClient', { clientId: clientId.trim(), tenant: tenant.trim() || 'common' });
                if (!alive.current) return;
                setBusy(false);
                if (!result.ok) setError(errorText(result.error));
                else onReady();
            };
            const code = (text) => h('code', null, text);
            return h('form', { className: 'dshcal-form', 'data-calendar-microsoft-setup': '', onSubmit: (e) => { e.preventDefault(); void save(); } },
                h('div', { className: 'dshcal-note' }, icon('IconInfoOutlineRegular'),
                    h('span', null, 'Microsoft lets an app like this sign in through an app registration of your own, or your organization\'s. Making one takes a few minutes, once.')),
                h('ol', { className: 'dshcal-steps' },
                    h('li', null, 'In the ', outLink('https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', 'Microsoft Entra admin center'), ', App registrations → New registration. For who can use it, pick accounts in any organizational directory and personal Microsoft accounts.'),
                    h('li', null, 'Under Authentication, Add a platform → ', h('b', null, 'Mobile and desktop applications'), ', with the redirect URI ', code('http://localhost'),
                        '. Exactly that, with no port: Microsoft lets the sign-in come back to any port on localhost.'),
                    h('li', null, 'Under API permissions, add the Microsoft Graph delegated permissions ', code('Calendars.ReadWrite'), ', ', code('User.Read'), ' and ', code('offline_access'), '.'),
                    h('li', null, 'Copy its Application (client) ID here.')),
                h('p', { className: 'dshcal-hint', style: { margin: 0 }, 'data-calendar-microsoft-admin-note': '' },
                    'A work or school account whose organization has an admin approve apps: the admin grants these permissions once, with ', h('b', null, 'Grant admin consent'), ' under API permissions.'),
                h('p', { className: 'dshcal-hint', style: { margin: 0 }, 'data-calendar-microsoft-code-note': '' },
                    'Only to sign in with a code (from another device), also turn on ', h('b', null, 'Allow public client flows'), ' under Authentication. The sign-in in the browser doesn\'t need it.'),
                h(Field, { label: 'Application (client) ID', id: 'dshcal-ms-id' },
                    h('input', { id: 'dshcal-ms-id', className: 'dshcal-input', value: clientId, placeholder: '00000000-0000-0000-0000-000000000000', spellCheck: false, autoComplete: 'off', 'data-modal-autofocus': true, 'data-calendar-microsoft-id': '', onChange: (e) => setClientId(e.target.value) })),
                h(Field, { label: 'Tenant', id: 'dshcal-ms-tenant', hint: 'common takes any account; your organization\'s tenant ID or domain takes only its accounts.' },
                    h('input', { id: 'dshcal-ms-tenant', className: 'dshcal-input', value: tenant, spellCheck: false, autoComplete: 'off', onChange: (e) => setTenant(e.target.value) })),
                h(Alert, { text: error }),
                h('button', { type: 'submit', hidden: true, tabIndex: -1 }),
                h(FooterSlot, { target: slot },
                    h(ui.Button, { variant: 'primary', disabled: busy || clientId.trim() === '', onClick: () => void save(), 'data-calendar-microsoft-save': '' }, busy ? h(Spinner) : null, 'Save and continue')));
        }

        /** Signing in to Google: its page in a new tab, and a way to finish by its address when it can't come back here. */
        function GoogleSignIn({ store, accountId, onDone, onSetup, slot }) {
            const signIn = useSignIn(store, 'google', accountId);
            const flow = signIn.flow;
            React.useEffect(() => { if (flow?.status === 'done') onDone(flow.account); }, [flow?.status]);
            return h('div', { className: 'dshcal-form', 'data-calendar-google-signin': '' },
                !flow ? h('p', { className: 'dshcal-hint', style: { margin: 0 } }, 'Google\'s sign-in page opens in a new tab. Pick your account there and allow DSH to see and change your calendars; this dialog notices by itself when you\'re done.') : null,
                flow?.status === 'waiting' ? h(SignInWait, { key: flow.flow, who: 'Google', prefix: 'google', flow, busy: signIn.busy, onFinish: signIn.finish, fallback: 'http://127.0.0.1' }) : null,
                flow?.status === 'failed' ? h(Alert, { text: flow.error || 'The sign-in didn\'t finish.' }) : null,
                h(Alert, { text: signIn.error }),
                h('button', { type: 'button', className: 'dshcal-link', style: smallLink, onClick: onSetup }, 'Use another Google client'),
                h(FooterSlot, { target: slot }, flow?.status === 'waiting' ? null
                    : h(ui.Button, { variant: 'primary', disabled: signIn.busy, onClick: () => void signIn.start(), 'data-calendar-google-start': '' },
                        signIn.busy ? h(Spinner) : null, flow ? 'Start again' : 'Sign in with Google')));
        }

        /**
         * Signing in to Microsoft: its page in a new tab, as Google's, and a
         * way to finish by its address when it can't come back here. Or, when
         * asked, a code to enter on Microsoft's page from any device.
         */
        function MicrosoftSignIn({ store, accountId, onDone, onSetup, slot }) {
            const signIn = useSignIn(store, 'microsoft', accountId);
            const [method, setMethod] = React.useState('browser');
            // 'done' after the code is copied, 'failed' when the browser wouldn't copy it.
            const [copied, setCopied] = React.useState('');
            const flow = signIn.flow;
            const failedText = flow?.status === 'failed' ? String(flow.error || '') : '';
            // Microsoft's words when an organization has its admin approve apps (AADSTS65001, 90094 and the like).
            const needsAdmin = /AADSTS(65001|90094|900941|90099)|admin(istrator)?('s)? (consent|approval)|approval required/i.test(`${failedText} ${signIn.error}`);
            const withCode = method === 'code';
            const waiting = flow?.status === 'waiting';
            React.useEffect(() => { if (flow?.status === 'done') onDone(flow.account); }, [flow?.status]);
            const begin = (next) => {
                setMethod(next);
                setCopied('');
                void signIn.start(next === 'code' ? 'code' : '');
            };
            const copy = async () => {
                try {
                    await navigator.clipboard.writeText(flow.userCode);
                    setCopied('done');
                    setTimeout(() => setCopied((c) => (c === 'done' ? '' : c)), 2000);
                } catch {
                    setCopied('failed');
                }
            };
            return h('div', { className: 'dshcal-form', 'data-calendar-microsoft-signin': method },
                !flow ? h('p', { className: 'dshcal-hint', style: { margin: 0 } }, withCode
                    ? 'You get a code to enter on Microsoft\'s sign-in page, on this device or any other. Then sign in and allow DSH to see and change your calendars; this dialog notices by itself when you\'re done.'
                    : 'Microsoft\'s sign-in page opens in a new tab. Pick your account there and allow DSH to see and change your calendars; this dialog notices by itself when you\'re done.') : null,
                waiting && flow.userCode ? h(React.Fragment, null,
                    h('div', { className: 'dshcal-usercode' },
                        h('b', { 'data-calendar-user-code': '' }, flow.userCode),
                        h(Btn, { size: 'sm', onClick: () => void copy() }, icon(copied === 'done' ? 'IconCheckOutlineRegular' : 'IconCopyOutlineRegular'), copied === 'done' ? 'Copied' : 'Copy')),
                    copied === 'failed' ? h('p', { className: 'dshcal-hint', role: 'status', style: { margin: 0 }, 'data-calendar-copy-failed': '' }, 'This browser wouldn\'t copy it: select the code and copy it yourself.') : null,
                    isUrl(flow.verificationUri) ? h('div', { className: 'dshcal-inline' },
                        h('span', null, 'Enter it at'),
                        h('a', { className: 'dshcal-btn dshcal-btn-primary dshcal-btn-sm', href: flow.verificationUri, target: '_blank', rel: 'noopener noreferrer', 'data-calendar-verification': '' }, linkLabel(flow.verificationUri), icon('IconRightUpOutlineRegular', { size: 12 }))) : null,
                    h('div', { className: 'dshcal-wait', role: 'status' }, h(Spinner), flow.expiresAt ? `Waiting for you… The code works until ${timeText(flow.expiresAt, browserZone())}.` : 'Waiting for you…')) : null,
                waiting && !flow.userCode ? h(SignInWait, { key: flow.flow, who: 'Microsoft', prefix: 'microsoft', flow, busy: signIn.busy, onFinish: signIn.finish, fallback: 'http://localhost' }) : null,
                flow?.status === 'failed' ? h(Alert, { text: flow.error || 'The sign-in didn\'t finish.' }) : null,
                h(Alert, { text: signIn.error }),
                needsAdmin ? h('p', { className: 'dshcal-hint', style: { margin: 0 }, 'data-calendar-microsoft-admin': '' },
                    'Your organization has an admin approve apps. Ask them to grant this app\'s permissions (Grant admin consent, under API permissions in its app registration), then sign in again.') : null,
                h('div', { className: 'dshcal-inline', style: { gap: 16 } },
                    withCode
                        ? h('button', { type: 'button', className: 'dshcal-link', style: smallLink, disabled: signIn.busy, onClick: () => begin('browser'), 'data-calendar-microsoft-browser': '' }, 'Sign in on Microsoft\'s page instead')
                        : h('button', { type: 'button', className: 'dshcal-link', style: smallLink, disabled: signIn.busy, onClick: () => begin('code'), 'data-calendar-microsoft-code': '' }, 'Sign in with a code instead'),
                    h('button', { type: 'button', className: 'dshcal-link', style: smallLink, onClick: onSetup }, 'Use another app registration')),
                h(FooterSlot, { target: slot }, waiting ? null
                    : h(ui.Button, { variant: 'primary', disabled: signIn.busy, onClick: () => begin(method), 'data-calendar-microsoft-start': '' },
                        signIn.busy ? h(Spinner) : null, flow ? 'Start again' : withCode ? 'Get a code' : 'Sign in with Microsoft')));
        }

        /** A CalDAV account: the server (where the preset has none), the user name and an app password. */
        function CalDavForm({ store, preset, onDone, slot }) {
            const showUrl = Boolean(preset.needsUrl || preset.urlHint);
            const [url, setUrl] = React.useState(preset.needsUrl ? '' : preset.url ?? '');
            const [username, setUsername] = React.useState('');
            const [password, setPassword] = React.useState('');
            const [name, setName] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const ready = url.trim() !== '' && username.trim() !== '' && password !== '';
            const appPassword = ['icloud', 'fastmail', 'yahoo', 'nextcloud'].includes(preset.id);
            const add = async () => {
                if (!ready || busy) return;
                setBusy(true);
                setError('');
                const input = { kind: 'caldav', preset: preset.id, url: url.trim(), username: username.trim(), password, ...(name.trim() ? { name: name.trim() } : {}) };
                setPassword('');
                const result = await store.act('addAccount', { input });
                if (!alive.current) return;
                setBusy(false);
                if (!result.ok) setError(errorText(result.error));
                else onDone(result.value?.account);
            };
            return h('form', { className: 'dshcal-form', 'data-calendar-caldav': preset.id, onSubmit: (e) => { e.preventDefault(); void add(); } },
                showUrl ? h(Field, { label: 'Server', id: 'dshcal-dav-url', hint: preset.urlHint },
                    h('input', { id: 'dshcal-dav-url', className: 'dshcal-input', type: 'url', value: url, placeholder: 'https://', spellCheck: false, autoComplete: 'off', 'data-modal-autofocus': true, 'data-calendar-dav-url': '', onChange: (e) => setUrl(e.target.value) })) : null,
                h(Field, { label: preset.id === 'icloud' ? 'Apple Account' : 'User name', id: 'dshcal-dav-user', hint: preset.usernameHint },
                    h('input', { id: 'dshcal-dav-user', className: 'dshcal-input', value: username, spellCheck: false, autoComplete: 'off', 'data-modal-autofocus': showUrl ? undefined : true, 'data-calendar-dav-user': '', onChange: (e) => setUsername(e.target.value) })),
                h(Field, { label: appPassword ? 'App password' : 'Password', id: 'dshcal-dav-pass', hint: preset.passwordHint },
                    h('input', { id: 'dshcal-dav-pass', className: 'dshcal-input', type: 'password', value: password, autoComplete: 'new-password', spellCheck: false, 'data-calendar-dav-pass': '', onChange: (e) => setPassword(e.target.value) })),
                preset.helpUrl ? h('a', { className: 'dshcal-link', href: preset.helpUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 12, alignSelf: 'flex-start' } },
                    appPassword ? 'How to make an app password' : 'Help with this') : null,
                h(Field, { label: 'Name in DSH (optional)', id: 'dshcal-dav-name' },
                    h('input', { id: 'dshcal-dav-name', className: 'dshcal-input', value: name, placeholder: preset.name, onChange: (e) => setName(e.target.value) })),
                h('div', { className: 'dshcal-hint' }, 'The password is kept in DSH\'s credential store, not in the plugin\'s files.'),
                h(Alert, { text: error }),
                h('button', { type: 'submit', hidden: true, tabIndex: -1 }),
                h(FooterSlot, { target: slot },
                    h(ui.Button, { variant: 'primary', disabled: busy || !ready, onClick: () => void add(), 'data-calendar-caldav-add': '' }, busy ? h(Spinner) : null, busy ? 'Connecting…' : 'Add account')));
        }

        /** A subscription: a published calendar's address. */
        function SubscribeForm({ store, onDone, slot }) {
            const [url, setUrl] = React.useState('');
            const [name, setName] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const add = async () => {
                if (busy || url.trim() === '') return;
                setBusy(true);
                setError('');
                const result = await store.act('addAccount', { input: { kind: 'ics', url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) } });
                if (!alive.current) return;
                setBusy(false);
                if (!result.ok) setError(errorText(result.error));
                else {
                    // A feed's address is a secret: once it's sent, the window doesn't keep it.
                    setUrl('');
                    onDone(result.value?.account);
                }
            };
            return h('form', { className: 'dshcal-form', 'data-calendar-subscribe': '', onSubmit: (e) => { e.preventDefault(); void add(); } },
                h(Field, { label: 'Address', id: 'dshcal-sub-url', hint: 'Its .ics or webcal:// address. It syncs on its own, and stays read only here.' },
                    h('input', { id: 'dshcal-sub-url', className: 'dshcal-input', value: url, placeholder: 'webcal://… or https://….ics', spellCheck: false, autoComplete: 'off', 'data-modal-autofocus': true, 'data-calendar-sub-url': '', onChange: (e) => setUrl(e.target.value) })),
                h(Field, { label: 'Name (optional)', id: 'dshcal-sub-name' },
                    h('input', { id: 'dshcal-sub-name', className: 'dshcal-input', value: name, onChange: (e) => setName(e.target.value) })),
                h(Alert, { text: error }),
                h('button', { type: 'submit', hidden: true, tabIndex: -1 }),
                h(FooterSlot, { target: slot },
                    h(ui.Button, { variant: 'primary', disabled: busy || url.trim() === '', onClick: () => void add(), 'data-calendar-subscribe-add': '' }, busy ? h(Spinner) : null, busy ? 'Reading it…' : 'Subscribe')));
        }

        /** A calendar kept in DSH: its name and color. */
        function LocalForm({ store, onDone, slot }) {
            const [name, setName] = React.useState('');
            const [color, setColor] = React.useState(() => PALETTE[(store.state()?.calendars?.length ?? 0) % PALETTE.length]);
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const add = async () => {
                if (busy || name.trim() === '') return;
                setBusy(true);
                setError('');
                const result = await store.act('createCalendar', { name: name.trim(), color });
                if (!alive.current) return;
                setBusy(false);
                if (!result.ok) setError(errorText(result.error));
                else onDone(result.value?.calendar);
            };
            return h('form', { className: 'dshcal-form', 'data-calendar-local': '', onSubmit: (e) => { e.preventDefault(); void add(); } },
                h(Field, { label: 'Name', id: 'dshcal-local-name' },
                    h('input', { id: 'dshcal-local-name', className: 'dshcal-input', value: name, maxLength: 120, 'data-modal-autofocus': true, 'data-calendar-local-name': '', onChange: (e) => setName(e.target.value) })),
                h('div', { className: 'dshcal-field' },
                    h('span', { className: 'dshcal-label' }, 'Color'),
                    h('div', { className: 'dshcal-swatches', role: 'radiogroup', 'aria-label': 'Color' },
                        PALETTE.map((c, i) => h('button', { key: c, type: 'button', className: 'dshcal-swatch', style: { '--sw': c }, role: 'radio', 'aria-checked': color === c, 'aria-label': `Color ${i + 1}`, onClick: () => setColor(c) })))),
                h(Alert, { text: error }),
                h('button', { type: 'submit', hidden: true, tabIndex: -1 }),
                h(FooterSlot, { target: slot },
                    h(ui.Button, { variant: 'primary', disabled: busy || name.trim() === '', onClick: () => void add(), 'data-calendar-local-add': '' }, busy ? h(Spinner) : null, 'Create calendar')));
        }

        /** A CalDAV account's new password. */
        function PasswordForm({ store, account, onDone, slot }) {
            const [password, setPassword] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const alive = useAlive();
            const save = async () => {
                if (busy || password === '') return;
                setBusy(true);
                setError('');
                const value = password;
                setPassword('');
                const result = await store.act('updateAccount', { id: account.id, patch: { password: value } });
                if (!alive.current) return;
                setBusy(false);
                if (!result.ok) setError(errorText(result.error));
                else onDone();
            };
            const appPassword = ['icloud', 'fastmail', 'yahoo', 'nextcloud'].includes(account.preset);
            return h('form', { className: 'dshcal-form', onSubmit: (e) => { e.preventDefault(); void save(); } },
                h(Field, { label: appPassword ? 'App password' : 'Password', id: 'dshcal-new-pass', hint: account.username ? `For ${account.username}. Kept in DSH's credential store.` : 'Kept in DSH\'s credential store.' },
                    h('input', { id: 'dshcal-new-pass', className: 'dshcal-input', type: 'password', value: password, autoComplete: 'new-password', 'data-modal-autofocus': true, onChange: (e) => setPassword(e.target.value) })),
                h(Alert, { text: error }),
                h('button', { type: 'submit', hidden: true, tabIndex: -1 }),
                h(FooterSlot, { target: slot },
                    h(ui.Button, { variant: 'primary', disabled: busy || password === '', onClick: () => void save() }, busy ? h(Spinner) : null, 'Save password')));
        }

        /**
         * What a removal says about DSH's access to the account, from
         * removeAccount's answer ({revoked?: true, manageUrl?}): {toast} and,
         * when the user withdraws that access on the provider's page (always
         * Microsoft's, which doesn't let an app withdraw its own; Google's when
         * it couldn't be reached), {text, manageUrl} for a notice to link it.
         */
        function removalNotice(account, value) {
            const name = String(account?.name || 'the account');
            const provider = account?.kind === 'google' ? 'Google' : account?.kind === 'microsoft' ? 'Microsoft' : '';
            if (value?.revoked === true) return { toast: `Removed ${name}. DSH's access was withdrawn at ${provider || 'its provider'}.` };
            const manageUrl = typeof value?.manageUrl === 'string' && /^https:\/\/[^\s"<>]+$/i.test(value.manageUrl) ? value.manageUrl : '';
            if (manageUrl === '') return { toast: `Removed ${name}.` };
            let text = `To withdraw DSH's access to ${name}, go to`;
            if (account?.kind === 'microsoft') text = `Microsoft doesn't let an app withdraw its own access to an account. To withdraw DSH's access to ${name}, go to`;
            else if (provider) text = `${provider} couldn't be reached to withdraw DSH's access to ${name}. To withdraw it yourself, go to`;
            return { toast: `Removed ${name}.`, text, manageUrl };
        }

        /**
         * The Accounts dialog: the accounts and how each one's sync stands
         * (sync now, rename, a new password, sign in again, remove), and Add
         * account with each kind's way in.
         * @param start - the page to open on: {page: 'list'|'add'|'local'|'google'|'microsoft', accountId?, name?}.
         */
        function AccountsDialog({ cal, start, onClose }) {
            const store = cal.store;
            useStore(store);
            const state = store.state();
            const home = start?.page ?? 'list';
            const [page, setPage] = React.useState(start ?? { page: 'list' });
            const [menu, setMenu] = React.useState('');
            const [syncing, setSyncing] = React.useState('');
            const [error, setError] = React.useState('');
            const [slot, setSlot] = React.useState(null);
            // After a removal: where to withdraw DSH's access, while the dialog is open ({text, manageUrl}).
            const [removed, setRemoved] = React.useState(null);
            const bodyRef = React.useRef(null);
            const alive = useAlive();
            const first = React.useRef(true);
            // A new page: its first field takes the focus (the dialog's own autofocus runs only when it opens).
            React.useEffect(() => {
                if (first.current) {
                    first.current = false;
                    return;
                }
                const target = bodyRef.current?.querySelector('[data-modal-autofocus]') ?? bodyRef.current?.querySelector('input,button');
                target?.focus?.();
            }, [page]);
            const accounts = state?.accounts ?? EMPTY;
            const calendars = state?.calendars ?? EMPTY;
            const go = (next) => {
                setError('');
                setMenu('');
                setPage(next);
            };
            const leave = () => (page.page === home ? onClose() : go({ page: 'list' }));
            const added = (words) => {
                store.toast(words);
                if (home === 'list' || home === 'add') go({ page: 'list' });
                else onClose();
            };
            const sync = async (account) => {
                setSyncing(account?.id ?? '*');
                setError('');
                const result = await store.act('syncNow', { accountId: account?.id ?? '' });
                if (!alive.current) return;
                setSyncing('');
                if (!result.ok) setError(errorText(result.error));
            };
            const signInPage = (account) => go({ page: account.kind, accountId: account.id, name: account.name });
            const select = (account, id) => {
                setMenu('');
                if (id === 'sync') void sync(account);
                else if (id === 'rename') go({ page: 'rename', account });
                else if (id === 'password') go({ page: 'password', account });
                else if (id === 'signin') signInPage(account);
                else if (id === 'remove') go({ page: 'remove', account });
            };

            if (page.page === 'rename') {
                return h(NameDialog, {
                    title: 'Rename account', label: 'Name', initial: page.account.name, action: 'Rename',
                    onSubmit: async (name) => {
                        const result = await store.act('updateAccount', { id: page.account.id, patch: { name } });
                        return result.ok ? '' : errorText(result.error);
                    },
                    onClose: () => go({ page: 'list' }),
                });
            }
            if (page.page === 'remove') {
                const kind = page.account.kind;
                return h(ConfirmDialog, {
                    title: `Remove ${page.account.name}?`,
                    text: ['Its calendars leave DSH, with the copy DSH keeps of them. The account and its events stay as they are on its server, and you can add the account again.',
                        kind === 'google' ? 'DSH\'s access to it is withdrawn at Google too.' : '',
                        kind === 'microsoft' ? 'Microsoft doesn\'t let an app withdraw its own access, so DSH then shows you where to withdraw it.' : ''].filter(Boolean).join(' '),
                    action: 'Remove',
                    onSubmit: async () => {
                        const result = await store.act('removeAccount', { id: page.account.id });
                        if (!result.ok) return errorText(result.error);
                        const notice = removalNotice(page.account, result.value);
                        store.toast(notice.toast);
                        setRemoved(notice.manageUrl ? { ...notice, key: page.account.id } : null);
                        return '';
                    },
                    onClose: () => go({ page: 'list' }),
                });
            }

            let title = 'Accounts';
            let body;
            let actions = null;
            const toList = page.accountId || page.page === 'add' || page.page === 'password';
            const back = h(Btn, { kind: 'ghost', size: 'sm', className: 'dshcal-back', onClick: () => go({ page: toList ? 'list' : 'add' }) },
                icon('IconChevronLeftOutlineRegular', { size: 12 }), toList ? 'Accounts' : 'Add account');
            if (!state) {
                body = h('div', { className: 'dshcal-state' }, store.stateError() ? h('span', { className: store.stateOff() ? 'dshcal-off' : 'dshcal-error' }, store.stateError()) : h(Spinner));
            } else if (page.page === 'list') {
                body = h('div', { className: 'dshcal-form' },
                    removed ? h('div', { key: removed.key, className: 'dshcal-notice', role: 'status', 'data-calendar-removed': '' },
                        icon('IconInfoOutlineRegular'),
                        h('span', null, removed.text, ' ', outLink(removed.manageUrl, linkLabel(removed.manageUrl)), '.'),
                        h(IconBtn, { label: 'Close this notice', glyph: icon('IconCloseOutlineRegular', { size: 12 }), size: 'sm', onClick: () => setRemoved(null) })) : null,
                    h('div', { className: 'dshcal-accts', 'data-calendar-accounts': '' }, accounts.map((a) => {
                        const count = calendars.filter((c) => c.accountId === a.id).length;
                        const items = [
                            ...(a.kind !== 'local' ? [{ id: 'sync', label: 'Sync now', icon: icon('IconRefreshOutlineRegular') }] : []),
                            { id: 'rename', label: 'Rename…', icon: icon('IconEditOutlineRegular') },
                            ...(a.kind === 'caldav' ? [{ id: 'password', label: 'New password…', icon: h(LockGlyph) }] : []),
                            ...(a.kind === 'google' || a.kind === 'microsoft' ? [{ id: 'signin', label: 'Sign in again', icon: icon('IconUserOutlineRegular') }] : []),
                            ...(a.kind !== 'local' ? [{ type: 'separator', id: 'sep' }, { id: 'remove', label: 'Remove…', icon: icon('IconTrashOutlineRegular'), danger: true }] : []),
                        ];
                        const status = syncing === a.id || (syncing === '*' && a.kind !== 'local') ? 'syncing' : a.status;
                        let statusLine;
                        if (status === 'syncing') statusLine = h(React.Fragment, null, h(Spinner, { size: 12 }), 'Syncing…');
                        else if (status === 'signin') {
                            statusLine = h(React.Fragment, null, icon('IconWarningOutlineRegular', { size: 12 }), h('span', null, a.error || 'Needs signing in again.'),
                                a.kind === 'caldav' ? h(Btn, { size: 'sm', onClick: () => go({ page: 'password', account: a }) }, 'New password')
                                    : h(Btn, { size: 'sm', kind: 'primary', onClick: () => signInPage(a), 'data-calendar-resign': a.id }, 'Sign in again'));
                        } else if (status === 'error') {
                            // Why, from the account or the calendar of it that failed, and how old what's shown is.
                            const why = a.error || 'The last sync failed.';
                            statusLine = h(React.Fragment, null, icon('IconWarningOutlineRegular', { size: 12 }),
                                h('span', null, /[.!?…]$/.test(why) ? why : `${why}.`, a.syncedAt ? ` Last synced ${relativeText(a.syncedAt)}.` : ''));
                        }
                        else statusLine = a.kind === 'local' ? null : a.syncedAt ? `Synced ${relativeText(a.syncedAt)}` : 'Not synced yet';
                        const kindName = a.kind === 'caldav' && a.preset ? (PROVIDERS.find((p) => p.id === a.preset)?.name ?? a.kindName) : a.kindName;
                        return h('div', { key: a.id, className: 'dshcal-acct', 'data-calendar-account': a.id, 'data-status': status },
                            h('span', { className: 'dshcal-acct-badge', 'aria-hidden': true }, accountBadge(a)),
                            h('div', { style: { minWidth: 0 } },
                                h('div', { className: 'dshcal-acct-name' }, a.name),
                                h('div', { className: 'dshcal-acct-sub' }, [kindName !== a.name ? kindName : '', a.kind === 'ics' ? a.host : a.email && a.email !== a.name ? a.email : '', plural(count, 'calendar')].filter(Boolean).join(' · ')),
                                statusLine ? h('div', { className: 'dshcal-acct-status', 'data-status': status }, statusLine) : null),
                            h('div', { className: 'dshcal-acct-actions' },
                                h(ui.Menu, {
                                    open: menu === a.id, items, portal: true, align: 'end', autoFocus: true, listClassName: 'dshcal-menu',
                                    onSelect: (id) => select(a, id), onClose: () => setMenu(''),
                                    anchor: h(Btn, { kind: 'ghost', size: 'sm', iconOnly: true, 'aria-label': `Account actions: ${a.name}`, 'aria-haspopup': 'menu', 'aria-expanded': menu === a.id, 'data-calendar-account-menu': a.id, onClick: () => setMenu(menu === a.id ? '' : a.id) }, icon('IconEllipsisOutlineRegular')),
                                })));
                    })),
                    h('p', { className: 'dshcal-hint', style: { margin: 0 } }, 'Accounts sync on their own every few minutes. Removing one here changes nothing on its server.'),
                    h(Alert, { text: error }));
                actions = h(React.Fragment, null,
                    accounts.some((a) => a.kind !== 'local') ? h(ui.Button, { variant: 'outline', onClick: () => void sync(null), disabled: syncing !== '', 'data-calendar-sync-all': '' }, syncing === '*' ? h(Spinner) : icon('IconRefreshOutlineRegular'), 'Sync all') : null,
                    h(ui.Button, { variant: 'primary', onClick: () => go({ page: 'add' }), 'data-calendar-add-account': '' }, icon('IconPlusOutlineRegular'), 'Add account'));
            } else if (page.page === 'add') {
                title = 'Add account';
                body = h('div', { className: 'dshcal-form' },
                    home === 'add' ? null : back,
                    h('div', { className: 'dshcal-tiles', 'data-calendar-providers': '' }, PROVIDERS.map((p, i) => h('button', {
                        key: p.id, type: 'button', className: 'dshcal-tile', 'data-calendar-provider': p.id, 'data-modal-autofocus': i === 0 ? true : undefined,
                        onClick: () => go(p.id === 'google' || p.id === 'microsoft' || p.id === 'subscribe' || p.id === 'local' ? { page: p.id } : { page: 'caldav', preset: p.id }),
                    }, h('b', null, p.name), h('span', null, p.text)))));
            } else if (page.page === 'caldav') {
                const presets = Array.isArray(state.presets) ? state.presets : EMPTY;
                const found = presets.find((p) => p.id === page.preset);
                const preset = found ?? { id: 'other', name: 'CalDAV server', url: '', needsUrl: true, urlHint: 'The server\'s address, like https://dav.example.com. DSH finds the calendars under it.' };
                title = `Add ${PROVIDERS.find((p) => p.id === preset.id)?.name ?? preset.name}`;
                body = h('div', { className: 'dshcal-form' }, back, h(CalDavForm, { key: preset.id, store, preset, slot, onDone: (account) => added(`Added ${account?.name ?? 'the account'}. Syncing its calendars…`) }));
            } else if (page.page === 'subscribe') {
                title = 'Subscribe to a calendar';
                body = h('div', { className: 'dshcal-form' }, back, h(SubscribeForm, { store, slot, onDone: (account) => added(`Subscribed to ${account?.name ?? 'the calendar'}.`) }));
            } else if (page.page === 'local') {
                title = 'New calendar kept in DSH';
                body = h('div', { className: 'dshcal-form' }, home === 'local' ? null : back, h(LocalForm, { store, slot, onDone: (calendar) => added(`Created ${calendar?.name ?? 'the calendar'}.`) }));
            } else if (page.page === 'google' || page.page === 'microsoft') {
                const google = page.page === 'google';
                const signIn = isObject(state.signIn?.[page.page]) ? state.signIn[page.page] : {};
                const setup = page.setup === true || (page.setup !== false && !signIn.ready);
                title = page.accountId ? `Sign in again to ${page.name}` : google ? 'Add Google' : 'Add Microsoft 365 or Outlook.com';
                const done = (account) => added(page.accountId ? `${page.name} is signed in again.` : `Added ${account?.name || (google ? 'Google' : 'Microsoft')}. Syncing its calendars…`);
                const Setup = google ? GoogleSetup : MicrosoftSetup;
                const SignIn = google ? GoogleSignIn : MicrosoftSignIn;
                body = h('div', { className: 'dshcal-form' }, home === page.page ? null : back,
                    setup
                        ? h(Setup, { key: 'setup', store, signIn, slot, onReady: () => go({ ...page, setup: false }) })
                        : h(SignIn, { key: 'signin', store, accountId: page.accountId, slot, onDone: done, onSetup: () => go({ ...page, setup: true }) }));
            } else if (page.page === 'password') {
                title = `New password for ${page.account.name}`;
                body = h('div', { className: 'dshcal-form' }, back, h(PasswordForm, { store, account: page.account, slot, onDone: () => added('Password saved. Syncing…') }));
            }
            return h(Dialog, {
                title, onClose,
                footer: h(React.Fragment, null,
                    h(ui.Button, { variant: 'outline', onClick: page.page === 'list' ? onClose : leave, 'data-calendar-accounts-close': '' }, page.page === 'list' ? 'Done' : TEXT.cancel),
                    actions,
                    h('span', { className: 'dshcal-slot', ref: setSlot })),
            }, h('div', { ref: bodyRef, 'data-calendar-accounts-page': page.page }, body));
        }

        // ── The Calendar page ──────────────────────────────────────────────

        const cssEscape = (text) => (typeof window !== 'undefined' && typeof window.CSS?.escape === 'function' ? window.CSS.escape(text) : String(text).replace(/["\\]/g, '\\$&'));

        /**
         * The days a view shows around a day, the span of time it reads, and
         * its title, with its shorter forms after it (titles, longest first,
         * for a header short of room). A narrow page's week is three days
         * from the day. While weekends are hidden, Week and Month show the
         * weekdays alone (a narrow week the three from the day, a weekend's
         * day going on to Monday, and a month without a row whose weekdays
         * are all in the months beside it); the span read, from spanFirst to
         * spanLast, still holds the days left out, so details opened on one
         * have its events.
         */
        function rangeOf(view, anchor, weekStart, zone, { compact = false, agendaDays = AGENDA_DAYS, hideWeekends = false } = {}) {
            let first = anchor;
            let last = anchor;
            let titles;
            let days;
            // Days from one to another, with their year, then without it where it is this one.
            const spanTitles = (a, b) => [
                dayRangeText(a, b, { month: 'short', day: 'numeric', year: 'numeric' }),
                ...(a.slice(0, 4) === thisYear(zone) && b.slice(0, 4) === thisYear(zone) ? [dayRangeText(a, b, { month: 'short', day: 'numeric' })] : []),
            ];
            if (view === 'month') {
                const start = monthStart(anchor);
                first = weekStartOf(start, weekStart);
                last = addDays(weekStartOf(addDays(addMonths(start, 1), -1), weekStart), 6);
                titles = [dayText(start, { month: 'long', year: 'numeric' }), dayText(start, { month: 'short', year: 'numeric' })];
                days = visibleDays(daySpan(first, last), hideWeekends);
                if (hideWeekends) {
                    const month = start.slice(0, 7);
                    const rows = [];
                    for (let i = 0; i < days.length; i += 5) rows.push(days.slice(i, i + 5));
                    days = rows.filter((row) => row.some((day) => day.slice(0, 7) === month)).flat();
                }
            } else if (view === 'week') {
                if (compact) {
                    const from = firstShown(anchor, hideWeekends);
                    last = addShownDays(from, 2, hideWeekends);
                    days = visibleDays(daySpan(from, last), hideWeekends);
                } else {
                    first = weekStartOf(anchor, weekStart);
                    last = addDays(first, 6);
                    days = visibleDays(daySpan(first, last), hideWeekends);
                }
                titles = spanTitles(days[0], days[days.length - 1]);
            } else if (view === 'agenda') {
                last = addDays(anchor, agendaDays - 1);
                titles = spanTitles(first, last);
            } else {
                titles = [longDay(anchor, zone), dayText(anchor, { weekday: 'short', month: 'short', day: 'numeric', ...(anchor.slice(0, 4) !== thisYear(zone) ? { year: 'numeric' } : {}) })];
            }
            if (!days) days = daySpan(first, last);
            titles = titles.filter((t, i) => titles.indexOf(t) === i);
            return {
                view, first: days[0], last: days[days.length - 1], days, spanFirst: first, spanLast: last,
                from: startOfDay(first, zone), to: startOfDay(addDays(last, 1), zone), title: titles[0], titles,
            };
        }

        /** The day a view goes to from a day, back (-1) or on (1): a narrow page's week three days on, weekdays alone while weekends are hidden. */
        function stepFrom(view, anchor, by, compact = false, hideWeekends = false) {
            if (view === 'month') return addMonths(monthStart(anchor), by);
            if (view === 'week') return compact ? addShownDays(firstShown(anchor, hideWeekends), by * 3, hideWeekends) : addDays(anchor, by * 7);
            if (view === 'agenda') return addDays(anchor, by * AGENDA_DAYS);
            return addDays(anchor, by);
        }

        /** The occurrences on a day, the all-day and longer ones first, then by start. */
        function dayList(occurrences, day, zone) {
            return occurrences.filter((o) => {
                const [s, e] = daysOf(o, zone);
                return s <= day && e >= day;
            }).sort((a, b) => Number(spansDays(b)) - Number(spansDays(a)) || a.start - b.start);
        }

        /** Deleting an event: which occurrences (a repeating one), and whether its guests (or, for an invitation, its organizer) hear of it. */
        function DeleteEventDialog({ cal, occurrence, onClose }) {
            const store = cal.store;
            const o = occurrence;
            const [told, setTell] = React.useState(false);
            const sending = useSendQuestion();
            const calendar = store.calendar(o.calendarId);
            const guests = othersOf(o.attendees);
            const organizer = o.organizer?.name || o.organizer?.email || 'the organizer';
            // A box to tick where the server emails only when asked; where it emails anyway, the user is asked when the host says so.
            const tellFor = (scope) => {
                const mail = mailMode({ kind: 'delete', calendar, occurrence: o, guests: guests.length, scope });
                if (mail.mode !== 'ask') return null;
                const label = mail.to === 'organizer' ? `Tell ${organizer} you won't be there` : `Tell ${peopleText(guests.map((g) => g.name || g.email))} by email`;
                // Google takes a meeting off its guests' calendars by itself: unticked, deleting it still reaches them.
                const quiet = calendar?.kind === 'google' && mail.to === 'guests' ? 'Unticked, Google still removes it from the guests\' Google calendars, without an email.' : '';
                return { label, quiet };
            };
            const run = async (scope, tellThem) => {
                const result = await withConsent(sending.ask, 'delete', (how) => store.act('deleteEvent', { id: o.id, scope, ...asked(tellThem, how) }));
                // The event changed on its server meanwhile and nothing was done: the page reads it again.
                if (!result.ok && result.error?.code === 'calendar/changed') void store.refresh();
                if (result.kept) return '';
                if (!result.ok) return errorText(result.error);
                const day = o.allDay ? o.startDay : dayIn(o.start, store.zone());
                const done = scope === 'one' ? `Deleted “${o.title}” on ${dayText(day)}.` : scope === 'following' ? `Deleted “${o.title}” from ${dayText(day)} on.` : `Deleted “${o.title}”.`;
                const told = contactText(result.value);
                store.toast(told ? `${done} ${told}` : done);
                return '';
            };
            if (o.recurring) {
                const scopes = Array.isArray(o.scopes) && o.scopes.length ? o.scopes : ['one', 'following', 'all'];
                return h(React.Fragment, null,
                    h(ScopeDialog, { title: `Delete “${o.title}”?`, scopes, action: 'Delete', danger: true, tellFor, onSubmit: run, onClose }),
                    sending.dialog);
            }
            const box = tellFor('all');
            const tell = box !== null && told;
            return h(React.Fragment, null,
                h(ConfirmDialog, {
                    title: `Delete “${o.title}”?`, text: `${whenText(o, store.zone())} · ${o.calendar}`, action: 'Delete',
                    onSubmit: () => run('all', tell), onClose,
                }, box ? h('div', { className: 'dshcal-tell' },
                    h('label', { className: 'dshcal-check' },
                        h('input', { type: 'checkbox', checked: tell, onChange: (event) => setTell(event.target.checked), 'data-calendar-notify': '' }), box.label),
                    box.quiet && !tell ? h('div', { className: 'dshcal-hint', 'data-calendar-mail': 'reach' }, box.quiet) : null) : null),
                sending.dialog);
        }

        /**
         * Before an event dragged to new times is saved, when there's
         * something to ask: which occurrences of a repeating event move, and
         * whether its guests are told, where their server tells them only when
         * asked (Google).
         * @param onSubmit - (scope, tell) → '' once saved (or kept as it was), else what went wrong.
         */
        function MoveEventDialog({ cal, occurrence, times, scopes, onSubmit, onClose }) {
            const store = cal.store;
            const o = occurrence;
            const [told, setTell] = React.useState(false);
            const calendar = store.calendar(o.calendarId);
            const guests = othersOf(o.attendees);
            const title = `Move “${o.title}”?`;
            const to = `To ${whenText(placedAt(o, times), store.zone())}.`;
            const tellFor = (scope) => {
                if (mailMode({ kind: 'update', calendar, occurrence: o, guests: guests.length, scope }).mode !== 'ask') return null;
                const invites = calendar?.kind === 'caldav' && roleOf(o) === 'own';
                return {
                    label: invites ? 'Send invitations by email' : `Tell ${peopleText(guests.map((g) => g.name || g.email))} by email`,
                    hint: calendar?.kind === 'google' ? 'Unticked, Google still shows the new time on their Google calendars, without an email.' : undefined,
                };
            };
            if (scopes.length > 1) return h(ScopeDialog, { title, scopes, note: to, action: 'Move', tellFor, onSubmit, onClose });
            const box = tellFor(scopes[0]);
            const tell = box !== null && told;
            return h(ConfirmDialog, { title, text: to, action: 'Move', danger: false, onSubmit: () => onSubmit(scopes[0], tell), onClose },
                box ? h('div', { className: 'dshcal-tell' },
                    h('label', { className: 'dshcal-check' },
                        h('input', { type: 'checkbox', checked: tell, onChange: (event) => setTell(event.target.checked), 'data-calendar-notify': '' }), box.label),
                    box.hint ? h('div', { className: 'dshcal-hint' }, box.hint) : null) : null);
        }

        /** Notices about files set aside that the user closed, for as long as this window is open. */
        const closedIssues = new Set();
        /** The user's choice for the side column beside a page wide enough for it ('shown', 'folded'), for as long as this window is open. */
        let sideChoice = '';

        /**
         * Files the plugin couldn't read when DSH started (state().storeIssue,
         * a calendar's storeIssue): set aside, nothing deleted. → [{key, text}].
         */
        function storeIssues(state) {
            const out = [];
            const issue = state?.storeIssue;
            if (isObject(issue) && issue.file) {
                out.push({
                    key: `store:${issue.file}:${issue.at ?? ''}`,
                    text: issue.held
                        ? `The calendar's settings file (“${issue.file}”) couldn't be read when DSH started. It's left as it is and nothing was deleted, but changes to accounts and calendars can't be saved until it's fixed or moved away.`
                        : `The calendar's settings file couldn't be read when DSH started, so it was set aside as “${issue.file}” and the calendar started without it. Nothing was deleted.`,
                });
            }
            for (const c of state?.calendars ?? EMPTY) {
                const own = c?.storeIssue;
                if (!isObject(own) || !own.file) continue;
                out.push({
                    key: `cal:${c.id}:${own.file}:${own.at ?? ''}`,
                    text: own.held
                        ? `The events of “${c.name}” couldn't be read when DSH started (“${own.file}”). The file is left as it is and nothing was deleted.`
                        : `The events of “${c.name}” couldn't be read when DSH started, so their file was set aside as “${own.file}”. Nothing was deleted.`,
                });
            }
            return out;
        }

        /** Month, Week, Day, Agenda: a radio group, arrow keys moving the choice. */
        function ViewSwitch({ view, labels, onChange }) {
            const ref = React.useRef(null);
            const onKeyDown = (event) => {
                const by = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
                if (by === 0) return;
                event.preventDefault();
                const next = VIEWS[(VIEWS.indexOf(view) + by + VIEWS.length) % VIEWS.length];
                onChange(next);
                requestAnimationFrame(() => ref.current?.querySelector(`[data-calendar-view="${next}"]`)?.focus());
            };
            return h('div', { ref, className: 'dshcal-seg', role: 'radiogroup', 'aria-label': 'View', 'data-calendar-views': '', onKeyDown },
                VIEWS.map((v) => h('button', {
                    key: v, type: 'button', role: 'radio', 'aria-checked': view === v, tabIndex: view === v ? 0 : -1, 'data-calendar-view': v,
                    title: `${labels[v]} (${v[0].toUpperCase()})`, onClick: () => onChange(v),
                }, labels[v])));
        }

        /**
         * The header's title, as long as its room allows: the longest of its
         * forms (longest first) that fits beside the row's buttons (and the
         * week's number), measured from hidden copies of them in the title,
         * again whenever the page draws or the row's width changes; and the
         * least width the row needs with the shortest form, so the header
         * goes to two rows only where even that one wouldn't fit beside the
         * search and the views.
         */
        function useFitTitle(titles) {
            const navRef = React.useRef(null);
            const key = titles.join('\n');
            const [fit, setFit] = React.useState({ key: '', level: 0, need: 0 });
            const measure = () => {
                const nav = navRef.current;
                const title = nav?.querySelector('[data-calendar-range]');
                const rulers = [...(title?.querySelectorAll('.dshcal-title-ruler') ?? EMPTY)].map((el) => el.getBoundingClientRect().width);
                if (rulers.length === 0) return null;
                const css = (el) => window.getComputedStyle(el);
                const gap = (el) => parseFloat(css(el).columnGap) || 0;
                const box = title.parentElement === nav ? title : title.parentElement;
                const parts = [...nav.children].filter((el) => el.getBoundingClientRect().width > 0);
                const others = parts.reduce((sum, el) => sum + (el === box ? 0 : el.getBoundingClientRect().width), 0) + gap(nav) * Math.max(0, parts.length - 1)
                    + (parseFloat(css(title).marginLeft) || 0);
                const tag = box === title ? null : box.querySelector('[data-calendar-week-tag]');
                const tagWidth = tag ? tag.getBoundingClientRect().width : 0;
                // The week's number beside the title takes from its room; under it (a narrow page), only the row's least width.
                const under = tag !== null && css(box).flexDirection === 'column';
                const beside = tag && !under ? gap(box) + tagWidth : 0;
                const room = nav.getBoundingClientRect().width - others - beside;
                const found = rulers.findIndex((width) => width <= room + 0.5);
                const shortest = rulers[rulers.length - 1];
                return { level: found < 0 ? rulers.length - 1 : found, need: Math.ceil(others + (under ? Math.max(shortest, tagWidth) : shortest + beside)) };
            };
            React.useLayoutEffect(() => {
                const next = measure();
                if (next && (fit.key !== key || fit.level !== next.level || fit.need !== next.need)) setFit({ key, ...next });
            });
            React.useEffect(() => {
                const nav = navRef.current;
                if (!nav || typeof ResizeObserver === 'undefined') return undefined;
                let width = nav.clientWidth;
                // Wider or narrower: the form chosen again before the page shows it.
                const observer = new ResizeObserver(() => {
                    if (Math.abs(nav.clientWidth - width) < 1) return;
                    width = nav.clientWidth;
                    const next = measure();
                    if (next) ReactDOM.flushSync(() => setFit((f) => (f.level === next.level && f.need === next.need ? f : { ...f, ...next })));
                });
                observer.observe(nav);
                return () => observer.disconnect();
            }, []);
            return { navRef, shown: titles[fit.key === key ? Math.min(fit.level, titles.length - 1) : 0], need: fit.need };
        }

        /**
         * The Calendar page: the header (the side column's button, Today, back
         * and on, the range, search, the views, New event), the side column (a
         * small month, the calendars, Accounts; beside the view on a roomy
         * page, folded behind its button on a narrower one) and the view, with
         * an event's details over it and the dialogs. Keys while the focus is
         * in the page and nothing else takes them: T today, J/N on, K/P back,
         * M/W/D/A the views, C a new event, / search.
         */
        function CalendarPage({ cal }) {
            const store = cal.store;
            useStore(store);
            useWatch(store);
            const state = store.state();
            const zone = store.zone();
            const rootRef = React.useRef(null);
            const sideRef = React.useRef(null);
            const searchRef = React.useRef(null);
            const width = useWidth(rootRef);
            const compact = width > 0 && width < 560;
            const now = useNow(30_000);
            const today = dayIn(now, zone);
            const [viewChoice, setViewChoice] = React.useState('');
            const [anchor, setAnchor] = React.useState(today);
            const [agendaSpan, setAgendaSpan] = React.useState(AGENDA_DAYS);
            const [pop, setPop] = React.useState(null);
            const [dialog, setDialog] = React.useState(null);
            const [sideOpen, setSideOpen] = React.useState(false);
            const [sideWanted, setSideWanted] = React.useState(sideChoice);
            const [settings, setSettings] = React.useState(false);
            const [syncBusy, setSyncBusy] = React.useState(false);
            const [scrollTo, setScrollTo] = React.useState(null);
            const [focusDay, setFocusDay] = React.useState('');
            const [query, setQuery] = React.useState('');
            const [found, setFound] = React.useState(null);
            const [searchTry, setSearchTry] = React.useState(0);
            // An event dragged to new times: {key, id, t, saved, data}, shown there until the events read after it was saved arrive.
            const [pending, setPending] = React.useState(null);
            const [dragging, setDragging] = React.useState('');
            const drops = useSendQuestion();
            const shown = React.useRef(EMPTY);
            const pressClosed = React.useRef(-Infinity);
            const zoneRef = React.useRef(zone);
            const alive = useAlive();
            // The user's zone, once state says it: today can be another day there.
            React.useEffect(() => {
                if (zoneRef.current === zone) return;
                const before = dayIn(Date.now(), zoneRef.current);
                zoneRef.current = zone;
                setAnchor((day) => (day === before ? dayIn(Date.now(), zone) : day));
            }, [zone]);

            const prefsView = state?.prefs?.view;
            const view = VIEWS.includes(viewChoice) ? viewChoice : VIEWS.includes(prefsView) ? prefsView : 'week';
            const weekStart = weekStartFrom(state?.prefs);
            // The user's choices for Week and Month (the settings menu): Saturday and Sunday left out, ISO week numbers shown.
            const hideWeekends = state?.prefs?.hideWeekends === true;
            const weekNumbers = state?.prefs?.weekNumbers === true;
            const rangeOptions = { compact, agendaDays: agendaSpan, hideWeekends };
            const range = rangeOf(view, anchor, weekStart, zone, rangeOptions);
            const fitTitle = useFitTitle(range.titles);
            // A day the view is on: one it shows, or one it leaves out (a hidden weekend's) where going to it shows these same days.
            const inView = (day) => range.days.includes(day) || rangeOf(view, day, weekStart, zone, rangeOptions).first === range.first;
            const entry = state ? store.events(range.from, range.to) : null;
            // While another span loads, the last one read stays (each view shows only its own days of it).
            if (entry?.data) shown.current = entry.data.occurrences;
            const read = entry?.data ? entry.data.occurrences : shown.current;
            const occurrences = React.useMemo(() => (pending ? read.map((o) => (o.id === pending.id ? placedAt(o, pending.t) : o)) : read), [read, pending]);
            const loading = state !== undefined && entry !== null && (entry.loading || !entry.data);
            // A read again that failed, over what was read before: the events', or state's.
            const stale = state ? (entry?.data && entry.error ? entry.error : store.stateOff() ? '' : store.stateError()) : '';
            const dataNow = entry?.data;
            const dataRef = React.useRef(dataNow);
            dataRef.current = dataNow;
            React.useEffect(() => {
                if (!pending?.saved) return undefined;
                if (dataNow !== pending.data) {
                    setPending(null);
                    return undefined;
                }
                const timer = setTimeout(() => setPending((p) => (p === pending ? null : p)), 8000);
                return () => clearTimeout(timer);
            }, [pending, dataNow]);
            // The side column: beside the view where the page is roomy (or the user asked for it), folded behind its
            // button where it isn't (or the user folded it), and over the view while open on a narrow page.
            const narrow = width > 0 && width < 800;
            const folded = narrow || (sideWanted ? sideWanted === 'folded' : width < 1100);
            const overlay = narrow && sideOpen;
            const sideShows = !folded || overlay;
            // Where the focus goes once the side column opens ('in') or closes ('out').
            const sideFocus = React.useRef('');
            React.useEffect(() => {
                const want = sideFocus.current;
                if (!want) return;
                sideFocus.current = '';
                const active = document.activeElement;
                if (want === 'in') sideRef.current?.querySelector('button:not([disabled]),[href],input,[tabindex="0"]')?.focus();
                else if (!active || active === document.body || sideRef.current?.contains(active)) rootRef.current?.querySelector('[data-calendar-side-toggle]')?.focus();
            });
            const toggleSide = () => {
                sideFocus.current = sideShows ? 'out' : 'in';
                if (narrow) {
                    setSideOpen(!sideOpen);
                    return;
                }
                sideChoice = folded ? 'shown' : 'folded';
                setSideWanted(sideChoice);
            };
            const closeOverlay = () => {
                if (!overlay) return;
                sideFocus.current = 'out';
                setSideOpen(false);
            };
            const accounts = state?.accounts ?? EMPTY;
            const attention = accounts.filter((a) => a.status === 'signin' || a.status === 'error');
            const remote = accounts.some((a) => a.kind !== 'local');
            const [, setClosed] = React.useState(0);
            const issues = storeIssues(state).filter((i) => !closedIssues.has(i.key));
            const wrongSettings = (Array.isArray(state?.settingsProblems) ? state.settingsProblems : EMPTY).filter((p) => isObject(p) && typeof p.text === 'string' && typeof p.key === 'string');
            const wrongBox = settingsWords(wrongSettings);
            const trouble = troubleWords(attention);
            // What a change did in part, and what is left to do (a move that stopped halfway): until the user closes it.
            const kept = store.notices();
            // The small month marks the days Week, Day and Agenda show; Month shows the small month's own month, so it marks none.
            const shownDays = React.useMemo(() => new Set(view === 'month' ? [] : range.days), [view, range.first, range.last, range.days.length]);

            const closePop = (reason) => {
                // A press outside that closed details doesn't also make an event where it landed.
                if (reason === 'outside') pressClosed.current = performance.now();
                setPop(null);
            };
            const justClosed = () => performance.now() - pressClosed.current < 700;
            // Going to a day or a view ends a search.
            const go = (day) => {
                setPop(null);
                setQuery('');
                setAnchor(day);
                setFocusDay(day);
            };
            const setView = (next) => {
                if (!VIEWS.includes(next)) return;
                setPop(null);
                setQuery('');
                setViewChoice(next);
                setAgendaSpan(AGENDA_DAYS);
                if (next !== prefsView) {
                    void store.link.call('setPrefs', { patch: { view: next } }).then((r) => {
                        if (!r.ok) store.toast(`The view couldn't be kept for next time: ${errorText(r.error)}`, 'error');
                    });
                }
            };
            const step = (by) => {
                setAgendaSpan(AGENDA_DAYS);
                go(stepFrom(view, anchor, by, compact, hideWeekends));
            };
            const goToday = () => {
                go(dayIn(Date.now(), zone));
                setScrollTo({ minutes: minutesIn(Date.now(), zone) });
            };
            const newEvent = (preset) => {
                setPop(null);
                setSideOpen(false);
                const p = preset ?? (inView(today) ? {} : { startDay: view === 'month' ? shownNear(monthStart(anchor), hideWeekends) : range.first, startTime: '09:00' });
                setDialog({ kind: 'event', mode: 'new', preset: p });
            };
            const createAt = (slot) => {
                if (!slot.moved && justClosed()) return;
                if (slot.allDay) {
                    newEvent({ startDay: slot.day, endDay: slot.day, allDay: true });
                    return;
                }
                const over = slot.to >= 1440;
                newEvent({ startDay: slot.day, startTime: hhmm(slot.from), endDay: over ? addDays(slot.day, 1) : slot.day, endTime: over ? '00:00' : hhmm(slot.to) });
            };
            const openEvent = (o, el) => setPop({ kind: 'event', occurrence: o, anchor: rectOf(el) });
            const openDay = (day, el) => setPop({ kind: 'day', day, anchor: rectOf(el) });
            const closeDialog = () => setDialog(null);
            const saved = (o, words) => {
                const told = isObject(o) ? contactText(o) : '';
                // The host's answer without the event itself (a move it lost sight of): what it did, without going there.
                if (!placed(o)) {
                    store.toast(`${words === 'Added' ? 'Added.' : 'Saved.'}${told ? ` ${told}` : ''}`);
                    return;
                }
                const day = o.allDay ? o.startDay : dayIn(o.start, zone);
                store.toast(`${words === 'Added'
                    ? `Added “${o.title}” on ${dayText(day)}${o.allDay ? '' : ` at ${timeText(o.start, zone)}`}.`
                    : 'Saved.'}${told ? ` ${told}` : ''}`);
                if (isDay(day) && !inView(day)) go(day);
            };
            const syncNow = async (accountId = '') => {
                setSyncBusy(true);
                const result = await store.act('syncNow', { accountId });
                if (!alive.current) return;
                setSyncBusy(false);
                if (!result.ok) store.toast(errorText(result.error), 'error');
            };

            // An event dragged (or moved with Alt and an arrow key) to new times: it shows there at once; a repeating
            // one asks which occurrences move, a meeting whose guests are told only when asked asks whether to tell
            // them, and one the host says would email people asks first (withConsent).
            const movable = (o) => canDrag(o, store.calendar(o.calendarId));
            const saveDrop = async ({ o, t, patch, key }, scope, tell) => {
                // The question says where it goes.
                const ask = (question) => drops.ask({ ...question, move: `Moving “${o.title}” to ${whenText(placedAt(o, t), zoneRef.current)}.` });
                const result = await withConsent(ask, 'Don\'t move it', (given) => store.act('updateEvent', {
                    id: o.id, patch: { ...patch, ...(tell ? { notify: true } : {}), ...consentArgs(given) }, scope,
                }));
                if (!result.ok) {
                    setPending((p) => (p?.key === key ? null : p));
                    // Changed on its server meanwhile: read again, as the dialogs do.
                    if (result.error?.code === 'calendar/changed') void store.refresh();
                    return result.kept ? '' : errorText(result.error);
                }
                setPending((p) => (p?.key === key ? { ...p, saved: true, data: dataRef.current } : p));
                const words = movedWords(result.value?.occurrence);
                store.toast(`Moved “${o.title}” to ${whenText(placedAt(o, t), zoneRef.current)}.${words ? ` ${words}` : ''}`);
                return '';
            };
            const dropTo = (o, t) => {
                const patch = dropPatch(o, t);
                if (!patch) return;
                setPop(null);
                const drop = { o, t, patch, key: `${o.id}@${Date.now()}` };
                setPending({ key: drop.key, id: o.id, t, saved: false });
                const scopes = o.recurring ? (Array.isArray(o.scopes) && o.scopes.length ? o.scopes : ['one', 'following', 'all']) : ['all'];
                const mail = mailMode({ kind: 'update', calendar: store.calendar(o.calendarId), occurrence: o, guests: othersOf(o.attendees).length, scope: scopes[0] });
                if (scopes.length > 1 || mail.mode === 'ask') {
                    setDialog({ kind: 'move', drop, scopes });
                    return;
                }
                void saveDrop(drop, scopes[0], false).then((problem) => {
                    if (problem) store.toast(problem, 'error');
                });
            };

            // Search: what's typed, and what the plugin found for it, read again whenever the calendars change.
            const words = query.trim();
            const searchSeq = React.useRef(0);
            React.useEffect(() => {
                const seq = ++searchSeq.current;
                if (!words) {
                    setFound(null);
                    return undefined;
                }
                setFound((was) => ({ words, loading: true, data: was?.data, dataWords: was?.dataWords, error: '' }));
                const timer = setTimeout(() => {
                    void store.link.call('search', { query: words }).then((result) => {
                        if (!alive.current || seq !== searchSeq.current) return;
                        if (result.ok && isObject(result.value) && Array.isArray(result.value.occurrences)) {
                            setFound({ words, loading: false, data: result.value, dataWords: words, error: '' });
                        } else {
                            setFound({ words, loading: false, data: undefined, dataWords: words, error: errorText(result.error) });
                        }
                    });
                }, 250);
                return () => clearTimeout(timer);
            }, [words, searchTry, state?.version]);
            const focusSearch = () => {
                searchRef.current?.focus();
                searchRef.current?.select();
            };

            // An event asked for from elsewhere (the Agenda pane, a chat card): its day, then its details.
            const target = store.target();
            React.useEffect(() => {
                if (!target || !state) return;
                const day = target.allDay ? target.startDay : Number.isFinite(target.start) ? dayIn(target.start, zone) : '';
                // Another view's day: there first. A weekend's day this view leaves out stays here, its details open with nothing to point at.
                if (isDay(day) && !inView(day)) {
                    setPop(null);
                    setAnchor(day);
                    setFocusDay(day);
                    return;
                }
                // As it is now: after the events are read again (a change elsewhere, or one the host stopped).
                if (!entry?.data || entry.loading || entry.stale) return;
                const found = entry.data.occurrences.find((o) => o.id === target.id);
                store.clearTarget(target.seq);
                if (!target.allDay && Number.isFinite(target.start)) setScrollTo({ minutes: minutesIn(target.start, zone) });
                const show = (o) => requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (!alive.current) return;
                    const el = rootRef.current?.querySelector(`[data-calendar-event="${cssEscape(o.id)}"]`);
                    setPop({ kind: 'event', occurrence: o, anchor: el ? rectOf(el) : undefined });
                }));
                if (found) show(found);
                else {
                    void store.link.call('event', { id: target.id }).then((result) => {
                        if (result.ok && isObject(result.value?.occurrence)) show(result.value.occurrence);
                        else store.toast(errorText(result.error), 'error');
                    });
                }
            }, [target?.seq, state !== undefined, range.from, range.to, entry?.data, entry?.loading]);

            // Keys, while the focus is in the page and nothing else takes them (one letter alone does nothing elsewhere).
            const keys = React.useRef({});
            keys.current = {
                t: goToday, j: () => step(1), n: () => step(1), k: () => step(-1), p: () => step(-1),
                m: () => setView('month'), w: () => setView('week'), d: () => setView('day'), a: () => setView('agenda'),
                c: () => newEvent(), '/': focusSearch,
            };
            React.useEffect(() => {
                const onKey = (event) => {
                    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
                    const root = rootRef.current;
                    if (!root || root.getClientRects().length === 0) return;
                    const active = document.activeElement;
                    if (!active || !root.contains(active)) return;
                    if (active?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=menu],[role=listbox]')) return;
                    if (document.querySelector('[role=dialog][aria-modal=true]')) return;
                    const run = keys.current[String(event.key).toLowerCase()];
                    if (!run || event.key.length !== 1) return;
                    event.preventDefault();
                    run();
                };
                document.addEventListener('keydown', onKey);
                return () => document.removeEventListener('keydown', onKey);
            }, []);

            const labels = { ...TEXT.views, week: compact ? '3 days' : TEXT.views.week };
            const drags = { movable, onDrop: dropTo, onDragging: setDragging };
            let body;
            if (!state && store.stateOff()) {
                // Switched off is the owner's choice: a calm note saying where, no error and no Retry (it comes back on its own).
                body = h('div', { className: 'dshcal-state dshcal-off', 'data-calendar-state': 'off', role: 'status' }, icon('IconInfoOutlineRegular'), h('span', null, store.stateError()));
            } else if (!state) {
                body = h('div', { className: 'dshcal-state', 'data-calendar-state': store.stateError() ? 'error' : 'loading' },
                    store.stateError()
                        ? h(React.Fragment, null, h('span', { className: 'dshcal-error' }, store.stateError()), h(Btn, { onClick: () => void store.refresh() }, TEXT.retry))
                        : h(React.Fragment, null, h(Spinner), h('span', null, 'Loading your calendars…')));
            } else if (words) {
                body = h(SearchList, { found, zone, today, now, onOpen: openEvent, onRetry: () => setSearchTry((n) => n + 1) });
            } else if (entry?.error && !entry.data) {
                body = h('div', { className: 'dshcal-state', 'data-calendar-state': 'error' },
                    h('span', { className: 'dshcal-error' }, entry.error), h(Btn, { onClick: () => void store.refresh() }, TEXT.retry));
            } else if (view === 'month') {
                body = h(MonthView, {
                    days: range.days, month: anchor.slice(0, 7), zone, occurrences, today, now, focusDay, weekStart, hideWeekends, weekNumbers, ...drags,
                    onOpen: openEvent, onMore: openDay,
                    onCreateDay: (day) => { if (!justClosed()) newEvent({ startDay: day, endDay: day, allDay: true }); },
                    onDay: (day) => { go(day); setView('day'); },
                    onMove: (day) => go(day),
                });
            } else if (view === 'agenda') {
                body = h(AgendaList, {
                    firstDay: range.first, lastDay: range.last, zone, occurrences, today, now, loading,
                    onOpen: openEvent, onLater: () => setAgendaSpan((n) => Math.min(366, n + AGENDA_DAYS)),
                });
            } else {
                body = h(TimeGrid, {
                    days: range.days, zone, occurrences, now, today, scrollTo, ready: Boolean(entry?.data), hideWeekends: view === 'week' && hideWeekends, ...drags,
                    onOpen: openEvent, onCreate: createAt, onMore: openDay,
                    onDay: (day) => { go(day); setView('day'); },
                });
            }

            const weekChoice = Number.isInteger(state?.prefs?.weekStart) ? `ws:${state.prefs.weekStart}` : 'ws:auto';
            const chosen = [weekChoice, ...(hideWeekends ? [] : ['show:weekends']), ...(weekNumbers ? ['show:week-numbers'] : [])];
            /** A menu item that is on or off: its name, and which it is said to a screen reader too (the menu's check shows it). */
            const onOff = (text, on, pref) => h('span', { 'data-calendar-pref': pref, 'data-on': on ? 'true' : 'false' }, text, h('span', { className: 'dshcal-sr' }, on ? ', on' : ', off'));
            const side = h('aside', { ref: sideRef, id: 'dshcal-side', className: 'dshcal-side dshcal-glass', 'aria-label': 'Calendars', 'data-calendar-side': '' },
                h(Btn, { kind: 'primary', onClick: () => newEvent(), 'data-calendar-side-new': '', style: { alignSelf: 'stretch' } }, icon('IconPlusOutlineRegular'), 'New event'),
                h(MiniMonth, { anchor, today, weekStart, weekNumbers, shown: shownDays, onPick: (day) => { go(day); closeOverlay(); } }),
                state && !remote ? h('div', { className: 'dshcal-note', 'data-calendar-onboarding': '' },
                    h('span', null, 'Add iCloud, Google, Microsoft 365, Fastmail or any CalDAV account to see its calendars here.',
                        h('br'), h('button', { type: 'button', className: 'dshcal-link', onClick: () => setDialog({ kind: 'accounts', start: { page: 'add' } }) }, 'Add an account'))) : null,
                h(CalendarList, { cal, onDialog: (next) => { setSideOpen(false); setDialog(next); } }),
                // Set in the profile's settings file only, so it is said here, with no button to change it.
                state?.askBeforeEmails === false ? h('div', { className: 'dshcal-note', 'data-calendar-ask-off': '' },
                    icon('IconInfoOutlineRegular', { size: 12 }),
                    h('span', null, 'Chats can email your guests without asking you first: “Ask before emails” is off in the calendar plugin\'s settings (askBeforeEmails, in this profile\'s cordis.patch.yml).')) : null,
                h('div', { className: 'dshcal-side-foot' },
                    h('div', { className: 'dshcal-inline', style: { flexWrap: 'nowrap', gap: 4 } },
                        h(Btn, { kind: 'ghost', style: { flex: 1, justifyContent: 'flex-start' }, onClick: () => setDialog({ kind: 'accounts' }), 'data-calendar-accounts-open': '' },
                            icon('IconUserOutlineRegular'), 'Accounts',
                            attention.length ? h('span', { className: 'dshcal-dot', style: { '--dot': 'var(--cal-warn)' }, 'aria-label': `${plural(attention.length, 'account')} need${attention.length === 1 ? 's' : ''} attention` }) : null),
                        h(ui.Menu, {
                            // The chosen ones are checked: the week's first day, and each of the two below that is on.
                            open: settings, portal: true, align: 'end', side: 'top', autoFocus: true, listClassName: 'dshcal-menu', selectedIds: chosen,
                            items: [
                                { type: 'label', id: 'ws', text: 'Week starts on' },
                                { id: 'ws:auto', label: `As your language does (${weekdayName(localeWeekStart())})` },
                                { id: 'ws:1', label: weekdayName(1) },
                                { id: 'ws:0', label: weekdayName(0) },
                                { id: 'ws:6', label: weekdayName(6) },
                                { type: 'separator', id: 'show' },
                                { id: 'show:weekends', label: onOff('Show weekends', !hideWeekends, 'weekends') },
                                { id: 'show:week-numbers', label: onOff('Show week numbers', weekNumbers, 'week-numbers') },
                            ],
                            onSelect: (id) => {
                                setSettings(false);
                                const patch = id === 'show:weekends' ? { hideWeekends: !hideWeekends }
                                    : id === 'show:week-numbers' ? { weekNumbers: !weekNumbers }
                                        : id === weekChoice ? null : { weekStart: id === 'ws:auto' ? null : Number(id.slice(3)) };
                                if (!patch) return;
                                void store.choose(patch).then((r) => { if (!r.ok) store.toast(errorText(r.error), 'error'); });
                            },
                            onClose: () => setSettings(false),
                            anchor: h(Btn, { kind: 'ghost', iconOnly: true, 'aria-label': 'Calendar settings', 'aria-haspopup': 'menu', 'aria-expanded': settings, 'data-calendar-settings': '', onClick: () => setSettings(!settings) }, icon('IconSettingsOutlineRegular')),
                        }))));

            const search = h('div', { className: 'dshcal-search', role: 'search' },
                icon('IconSearchOutlineRegular'),
                h('input', {
                    ref: searchRef, type: 'search', className: 'dshcal-input', value: query, placeholder: 'Search', 'aria-label': 'Search events', title: 'Search events (/)',
                    autoComplete: 'off', spellCheck: false, enterKeyHint: 'search', 'data-calendar-search': '',
                    onChange: (event) => setQuery(event.target.value),
                    onKeyDown: (event) => {
                        if (event.key !== 'Escape' || query === '' || pop) return;
                        event.preventDefault();
                        event.stopPropagation();
                        setQuery('');
                    },
                }),
                query ? h('button', {
                    type: 'button', className: 'dshcal-search-clear', 'aria-label': 'Clear the search', 'data-calendar-search-clear': '',
                    onClick: () => { setQuery(''); searchRef.current?.focus(); },
                }, icon('IconCloseOutlineRegular', { size: 12 })) : null);

            // The title in the form that fits (see useFitTitle), whole for screen readers and as its tooltip.
            const heading = h('h1', { className: 'dshcal-title', 'aria-live': 'polite', 'data-calendar-range': '', title: fitTitle.shown === range.title ? undefined : range.title },
                h('span', { 'aria-hidden': true }, fitTitle.shown),
                h('span', { className: 'dshcal-sr' }, range.title),
                range.titles.map((t) => h('span', { key: t, className: 'dshcal-title-ruler', 'aria-hidden': true }, t)));
            const weekTag = weekNumbers && (view === 'week' || view === 'day') ? weekWords(range.days, weekStart) : '';
            const header = h('div', { className: 'dshcal-head' },
                h('div', { ref: fitTitle.navRef, className: 'dshcal-head-nav', style: fitTitle.need > 0 ? { minWidth: `min(${fitTitle.need}px, 100%)` } : undefined },
                    h(IconBtn, {
                        label: sideShows ? 'Hide the calendars' : 'Show the calendars', className: 'dshcal-side-toggle', glyph: icon('IconPanelLeftOutlineRegular'),
                        'aria-expanded': sideShows, 'aria-controls': 'dshcal-side', onClick: toggleSide, 'data-calendar-side-toggle': '',
                    }),
                    h(Btn, { onClick: goToday, 'data-calendar-today': '', title: 'Today (T)' }, TEXT.today),
                    h(IconBtn, { label: TEXT.previous[view], glyph: icon('IconChevronLeftOutlineRegular'), onClick: () => step(-1), 'data-calendar-prev': '' }),
                    h(IconBtn, { label: TEXT.next[view], glyph: icon('IconChevronRightOutlineRegular'), onClick: () => step(1), 'data-calendar-next': '' }),
                    // The week's number by the title, in Week and Day (under it where the page is narrow).
                    weekTag ? h('div', { className: 'dshcal-titles' }, heading, h('span', { className: 'dshcal-tag dshcal-wknum', 'data-calendar-week-tag': '' }, weekTag)) : heading),
                h('div', { className: 'dshcal-head-tools' },
                    search,
                    attention.length ? h(IconBtn, {
                        label: attention.length === 1 ? `${attention[0].name}: ${attention[0].problem || (attention[0].status === 'signin' ? 'sign-in needed' : 'the last sync failed')}` : `${plural(attention.length, 'account')} need attention`,
                        className: 'dshcal-warn', glyph: icon('IconWarningOutlineRegular'), onClick: () => setDialog({ kind: 'accounts' }), 'data-calendar-attention': '',
                    }) : null,
                    remote ? h(IconBtn, {
                        label: state?.syncing || syncBusy ? 'Syncing…' : 'Sync now', glyph: state?.syncing || syncBusy ? h(Spinner) : icon('IconRefreshOutlineRegular'),
                        disabled: syncBusy, onClick: () => void syncNow(), 'data-calendar-sync': '',
                    }) : null,
                    h(ViewSwitch, { view, labels, onChange: setView }),
                    h(Btn, { kind: 'primary', className: 'dshcal-head-new', onClick: () => newEvent(), 'aria-label': 'New event', title: 'New event (C)', 'data-calendar-new': '' },
                        icon('IconPlusOutlineRegular'), h('span', { className: 'dshcal-hide-narrow' }, 'New event'))));

            const busy = words ? found?.loading === true : loading;
            return h('div', {
                ref: rootRef, className: 'dshcal-root', tabIndex: -1, 'data-calendar-page': '', 'data-calendar-view-now': view,
                'data-side-folded': folded ? '' : undefined, 'data-side-open': overlay ? '' : undefined, 'data-calendar-dragging': dragging || undefined,
                onKeyDown: (event) => {
                    // An event's or a day's details open take Escape first (they close on it).
                    if (event.key !== 'Escape' || event.defaultPrevented || pop || !rootRef.current?.contains(event.target)) return;
                    if (overlay) {
                        event.stopPropagation();
                        closeOverlay();
                    } else if (words) {
                        event.stopPropagation();
                        setQuery('');
                    }
                },
            },
            side,
            overlay ? h('button', { type: 'button', className: 'dshcal-scrim', tabIndex: -1, 'aria-label': 'Hide the calendars', onClick: closeOverlay }) : null,
            h('section', { className: 'dshcal-main dshcal-glass', 'aria-label': words ? 'Search' : range.title, 'data-calendar-main': '' },
                header,
                stale ? h('div', { className: 'dshcal-stale', role: 'status', 'data-calendar-stale': '' },
                    icon('IconWarningOutlineRegular'),
                    h('span', null, `Couldn't refresh: ${stale}`),
                    h(Btn, { size: 'sm', kind: 'ghost', onClick: () => void store.refresh() }, TEXT.retry)) : null,
                // An account that couldn't sync: which, why and how old what's shown is, under the header, with Retry
                // (Accounts, for one that needs signing in again).
                trouble && !stale ? h('div', { className: 'dshcal-stale', role: 'status', 'data-calendar-trouble': trouble.id },
                    icon('IconWarningOutlineRegular'),
                    h('span', null, trouble.text),
                    trouble.fix === 'accounts'
                        ? h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setDialog({ kind: 'accounts' }), 'data-calendar-trouble-accounts': '' }, 'Accounts')
                        : h(Btn, { size: 'sm', kind: 'ghost', disabled: syncBusy, onClick: () => void syncNow(trouble.id), 'data-calendar-trouble-retry': '' }, TEXT.retry)) : null,
                issues.length || kept.length || wrongSettings.length ? h('div', { className: 'dshcal-notes' },
                    // Settings in the profile that are wrong, in one box: where to change them, then each one, what it must be
                    // and what the plugin does meanwhile.
                    wrongBox ? h('div', { key: 'settings', className: 'dshcal-notice', role: 'status', 'data-tone': 'warn', 'data-calendar-settings-problem': String(wrongBox.lines.length) },
                        icon('IconWarningOutlineRegular'),
                        h('div', { className: 'dshcal-notice-body' },
                            h('span', null, wrongBox.head),
                            h('ul', { className: 'dshcal-notice-list' }, wrongBox.lines.map((l) => h('li', { key: l.key, 'data-calendar-setting-problem': l.key }, l.text))))) : null,
                    kept.map((n) => h('div', { key: `kept:${n.id}`, className: 'dshcal-notice', role: 'alert', 'data-tone': 'warn', 'data-calendar-kept-notice': '' },
                        icon('IconWarningOutlineRegular'),
                        h('span', null, n.text),
                        h(IconBtn, { label: 'Close this notice', glyph: icon('IconCloseOutlineRegular', { size: 12 }), size: 'sm', onClick: () => store.closeNotice(n.id) }))),
                    issues.map((i) => h('div', { key: i.key, className: 'dshcal-notice', role: 'status', 'data-calendar-store-issue': '' },
                        icon('IconInfoOutlineRegular'),
                        h('span', null, i.text),
                        h(IconBtn, {
                            label: 'Close this notice', glyph: icon('IconCloseOutlineRegular', { size: 12 }), size: 'sm',
                            onClick: () => { closedIssues.add(i.key); setClosed((n) => n + 1); },
                        })))) : null,
                h('div', { className: 'dshcal-body', 'aria-busy': busy ? true : undefined },
                    busy ? h('div', { className: 'dshcal-busy', role: 'progressbar', 'aria-label': words ? 'Searching' : 'Loading events' }) : null,
                    !words && entry?.data?.more ? h('div', { className: 'dshcal-hint', style: { padding: '4px 12px' } }, 'More events than the page can show at once here; some are left out.') : null,
                    body)),
            pop?.kind === 'event' ? h(EventPopover, {
                key: `e:${pop.occurrence.id}`, cal, occurrence: pop.occurrence, anchor: pop.anchor, onClose: closePop,
                onEdit: (o) => { setPop(null); setDialog({ kind: 'event', mode: 'edit', occurrence: o }); },
                onDuplicate: (o) => { setPop(null); setDialog({ kind: 'event', mode: 'duplicate', occurrence: o }); },
                onDelete: (o) => { setPop(null); setDialog({ kind: 'delete', occurrence: o }); },
                // A search's event: to its day in the view.
                ...(words ? { openLabel: 'Show in calendar', onOpenPage: (o) => { setPop(null); setQuery(''); store.openAt(o); } } : {}),
            }) : null,
            pop?.kind === 'day' ? h(DayPopover, {
                key: `d:${pop.day}`, day: pop.day, occurrences: dayList(occurrences, pop.day, zone), zone, anchor: pop.anchor, now, onClose: closePop,
                onOpen: openEvent,
                onNew: (day) => newEvent({ startDay: day, startTime: '09:00' }),
                onOpenDay: (day) => { go(day); setView('day'); },
            }) : null,
            dialog?.kind === 'event' ? h(EventDialog, { cal, mode: dialog.mode, occurrence: dialog.occurrence, preset: dialog.preset, onClose: closeDialog, onSaved: saved }) : null,
            dialog?.kind === 'delete' ? h(DeleteEventDialog, { cal, occurrence: dialog.occurrence, onClose: closeDialog }) : null,
            dialog?.kind === 'rename-calendar' ? h(NameDialog, {
                title: 'Rename calendar', label: 'Name', initial: dialog.calendar.name, action: 'Rename', onClose: closeDialog,
                onSubmit: async (name) => {
                    const result = await store.act('updateCalendar', { id: dialog.calendar.id, patch: { name } });
                    return result.ok ? '' : errorText(result.error);
                },
            }) : null,
            dialog?.kind === 'color' ? h(ColorDialog, {
                calendar: dialog.calendar, onClose: closeDialog,
                onSubmit: async (color) => {
                    const result = await store.act('updateCalendar', { id: dialog.calendar.id, patch: { color } });
                    return result.ok ? '' : errorText(result.error);
                },
            }) : null,
            dialog?.kind === 'delete-calendar' ? h(ConfirmDialog, {
                title: `Delete “${dialog.calendar.name}”?`,
                text: 'It is kept only in DSH, so its events go with it, and that can\'t be undone. Export it first to keep a copy.',
                action: 'Delete calendar', onClose: closeDialog,
                onSubmit: async () => {
                    const result = await store.act('deleteCalendar', { id: dialog.calendar.id });
                    if (result.ok) store.toast(`Deleted “${dialog.calendar.name}”.`);
                    return result.ok ? '' : errorText(result.error);
                },
            }) : null,
            dialog?.kind === 'accounts' ? h(AccountsDialog, { cal, start: dialog.start, onClose: closeDialog }) : null,
            dialog?.kind === 'move' ? h(MoveEventDialog, {
                cal, occurrence: dialog.drop.o, times: dialog.drop.t, scopes: dialog.scopes,
                onSubmit: (scope, tell) => saveDrop(dialog.drop, scope, tell),
                onClose: () => {
                    const { key } = dialog.drop;
                    closeDialog();
                    setPending((p) => (p?.key === key && !p.saved ? null : p));
                },
            }) : null,
            drops.dialog,
            h(ToastHost, { store }));
        }

        // ── The Agenda pane beside chats ───────────────────────────────────

        /** How many days the Agenda pane shows, today first. */
        const PANE_DAYS = 7;

        /**
         * The Agenda pane in DSH's right sidebar: today and the next days, the
         * event on now and the next one marked, Join for a call about to
         * start. An event's details open beside the pane, the chat staying
         * where it is, with Open in Calendar; New event, Edit and Delete open
         * their dialogs right here.
         */
        function AgendaPane({ cal, useTabInfo }) {
            const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined;
            const visible = info?.tab?.visible !== false;
            const store = cal.store;
            useStore(store);
            useWatch(store, visible, false);
            const now = useNow(30_000, visible);
            const [dialog, setDialog] = React.useState(null);
            const [pop, setPop] = React.useState(null);
            const state = store.state();
            const zone = store.zone();
            const today = dayIn(now, zone);
            const last = addDays(today, PANE_DAYS - 1);
            const entry = state && visible ? store.events(startOfDay(today, zone), startOfDay(addDays(last, 1), zone)) : null;
            const occurrences = entry?.data?.occurrences ?? EMPTY;
            const stale = state ? (entry?.data && entry.error ? entry.error : store.stateOff() ? '' : store.stateError()) : '';
            const saved = (o, words) => {
                const told = isObject(o) ? contactText(o) : '';
                if (!placed(o)) {
                    store.toast(`${words === 'Added' ? 'Added.' : 'Saved.'}${told ? ` ${told}` : ''}`);
                    return;
                }
                const day = o.allDay ? o.startDay : dayIn(o.start, zone);
                store.toast(`${words === 'Added'
                    ? `Added “${o.title}” on ${dayText(day)}${o.allDay ? '' : ` at ${timeText(o.start, zone)}`}.`
                    : 'Saved.'}${told ? ` ${told}` : ''}`);
            };
            const live = (o) => o.status !== 'cancelled' && o.myStatus !== 'declined';
            const timed = occurrences.filter((o) => !spansDays(o) && live(o));
            const current = new Set(timed.filter((o) => o.start <= now && o.end > now).map((o) => o.id));
            const next = timed.filter((o) => o.start > now).sort((a, b) => a.start - b.start)[0];
            const attention = (state?.accounts ?? EMPTY).filter((a) => a.status === 'signin' || a.status === 'error');
            // At the top, what's next ('Next: Team sync in 10 min'), or what's on now when nothing follows within 12 hours.
            const onNow = timed.filter((o) => current.has(o.id)).sort((a, b) => a.end - b.end)[0];
            const upNext = next && next.start - now <= 12 * HOUR ? next : undefined;
            const headline = upNext ?? onNow;
            const nextLine = headline ? h('div', { className: 'dshcal-pane-next', 'data-calendar-pane-next': headline.id },
                h('span', { className: 'dshcal-pane-next-label' }, upNext ? 'Next:' : 'Now:'),
                h('button', {
                    type: 'button', className: 'dshcal-pane-next-what', 'aria-haspopup': 'dialog',
                    onClick: (event) => setPop({ occurrence: headline, anchor: rectOf(event.currentTarget) }),
                }, headline.title),
                h('span', { className: 'dshcal-pane-next-when' }, upNext ? untilWords(upNext.start, now) : `until ${timeText(headline.end, zone)}`)) : null;
            const groups = agendaDays(occurrences, today, last, zone);
            if (!groups.some((g) => g.day === today)) groups.unshift({ day: today, list: [] });

            const dayName = (day) => {
                const date = dayText(day, { month: 'short', day: 'numeric' });
                if (day === today) return `${TEXT.today} · ${date}`;
                if (day === addDays(today, 1)) return `${TEXT.tomorrow} · ${date}`;
                return dayText(day, { weekday: 'long', month: 'short', day: 'numeric' });
            };
            const row = (o, day) => {
                const isNow = current.has(o.id);
                const isNext = !isNow && next?.id === o.id;
                const soon = isNext && o.start - now <= 12 * HOUR;
                const join = isUrl(o.conference) && o.end > now && (isNow || o.start - now <= 15 * MINUTE);
                const when = shortWhen(o, zone, day);
                return h('div', {
                    key: o.id, className: 'dshcal-pane-ev', style: evStyle(o.color), 'data-look': lookOf(o), 'data-calendar-event': o.id,
                    'data-now': isNow ? '' : undefined, 'data-past': o.end <= now ? '' : undefined,
                },
                h('span', { className: 'dshcal-pane-bar', 'aria-hidden': true }),
                h('button', {
                    type: 'button', className: 'dshcal-pane-what', 'aria-haspopup': 'dialog',
                    onClick: (event) => setPop({ occurrence: o, anchor: rectOf(event.currentTarget.closest('.dshcal-pane-ev') ?? event.currentTarget) }),
                    'aria-label': `${o.title}, ${when}${isNow ? ', on now' : ''}`,
                },
                h('span', { className: 'dshcal-pane-title' },
                    isNow ? h('span', { className: 'dshcal-pane-badge' }, 'Now') : soon ? h('span', { className: 'dshcal-pane-badge' }, untilWords(o.start, now)) : null,
                    o.title),
                h('span', { className: 'dshcal-pane-sub' }, [when, o.location].filter(Boolean).join(' · '))),
                join ? h('a', { className: 'dshcal-pane-join', href: o.conference, target: '_blank', rel: 'noopener noreferrer', 'data-calendar-join': '' }, 'Join') : null);
            };

            let body;
            if (!state && store.stateOff()) {
                body = h('div', { className: 'dshcal-pane-empty dshcal-off', 'data-calendar-state': 'off', role: 'status' }, store.stateError());
            } else if (!state) {
                body = store.stateError()
                    ? h('div', { className: 'dshcal-pane-empty' }, h('div', { className: 'dshcal-error' }, store.stateError()), h(Btn, { size: 'sm', style: { marginTop: 8 }, onClick: () => void store.refresh() }, TEXT.retry))
                    : h('div', { className: 'dshcal-pane-empty', role: 'status' }, h(Spinner), ' Loading…');
            } else if (entry?.error && !entry.data) {
                body = h('div', { className: 'dshcal-pane-empty' }, h('div', { className: 'dshcal-error' }, entry.error), h(Btn, { size: 'sm', style: { marginTop: 8 }, onClick: () => void store.refresh() }, TEXT.retry));
            } else {
                body = h(React.Fragment, null,
                    groups.map(({ day, list }) => h('section', { key: day, className: 'dshcal-pane-day', 'aria-label': longDay(day, zone) },
                        h('div', { className: 'dshcal-pane-dayname' }, dayName(day)),
                        list.length
                            ? h('div', { className: 'dshcal-pane-list' }, list.map((o) => row(o, day)))
                            : h('div', { className: 'dshcal-pane-empty' }, entry?.data ? (occurrences.length ? 'Nothing today.' : `Nothing in the next ${PANE_DAYS} days.`) : h(Spinner)))));
            }
            return h('div', { className: 'dshcal-pane', 'data-calendar-pane': '' },
                h('div', { className: 'dshcal-pane-head' },
                    h('h2', null, TEXT.agendaTab),
                    h(IconBtn, { label: 'New event', glyph: icon('IconPlusOutlineRegular'), size: 'sm', side: 'bottom', onClick: () => setDialog({ kind: 'event' }), 'data-calendar-pane-new': '' }),
                    h(IconBtn, { label: 'Open the calendar', glyph: h(CalendarIcon, { size: 14 }), size: 'sm', side: 'bottom', onClick: () => cal.openPage(), 'data-calendar-pane-open': '' })),
                state ? nextLine : null,
                attention.length ? h('div', { className: 'dshcal-pane-note' },
                    icon('IconWarningOutlineRegular', { size: 12 }),
                    h('span', null, attention.length === 1 ? `${attention[0].name}: ${attention[0].problem || (attention[0].status === 'signin' ? 'sign-in needed' : 'the last sync failed')}.` : `${plural(attention.length, 'account')} need attention.`),
                    h('button', { type: 'button', className: 'dshcal-link', onClick: () => setDialog({ kind: 'accounts' }) }, 'Fix')) : null,
                stale ? h('div', { className: 'dshcal-stale', role: 'status', 'data-calendar-stale': '' },
                    icon('IconWarningOutlineRegular', { size: 12 }),
                    h('span', null, `Couldn't refresh: ${stale}`),
                    h(Btn, { size: 'sm', kind: 'ghost', onClick: () => void store.refresh() }, TEXT.retry)) : null,
                body,
                h('div', { className: 'dshcal-pane-foot' }, h(Btn, { size: 'sm', onClick: () => cal.openPage() }, h(CalendarIcon, { size: 14 }), 'Open calendar')),
                pop ? h(EventPopover, {
                    key: `e:${pop.occurrence.id}`, cal, occurrence: pop.occurrence, anchor: pop.anchor, onClose: () => setPop(null),
                    onEdit: (o) => { setPop(null); setDialog({ kind: 'event', mode: 'edit', occurrence: o }); },
                    onDuplicate: (o) => { setPop(null); setDialog({ kind: 'event', mode: 'duplicate', occurrence: o }); },
                    onDelete: (o) => { setPop(null); setDialog({ kind: 'delete', occurrence: o }); },
                    onOpenPage: (o) => { setPop(null); cal.openAt(o); },
                }) : null,
                dialog?.kind === 'event' ? h(EventDialog, { cal, mode: dialog.mode ?? 'new', occurrence: dialog.occurrence, onClose: () => setDialog(null), onSaved: saved }) : null,
                dialog?.kind === 'delete' ? h(DeleteEventDialog, { cal, occurrence: dialog.occurrence, onClose: () => setDialog(null) }) : null,
                dialog?.kind === 'accounts' ? h(AccountsDialog, { cal, onClose: () => setDialog(null) }) : null,
                h(ToastHost, { store }));
        }

        // ── Cards in chats for the calendar tools ──────────────────────────

        /** The arguments the cards read. */
        const ARG_KEYS = ['id', 'title', 'start', 'from', 'to', 'query', 'answer', 'scope', 'calendar_id'];
        const quote = (text, n = 60) => {
            const t = String(text ?? '').replace(/\s+/g, ' ').trim();
            return t.length > n ? `“${t.slice(0, n - 1)}…”` : `“${t}”`;
        };

        /**
         * A call's string arguments as far as they go: from DSH's argument
         * view (newer DSH: block.args), the dispatched call's JSON (argsRaw),
         * or the prefix still streaming in (each string field so far).
         */
        function callArgs(block, raw = '') {
            const out = {};
            const view = block?.args;
            if (view && typeof view.text === 'function') {
                for (const key of ARG_KEYS) {
                    try {
                        const text = view.text(key);
                        if (typeof text === 'string') out[key] = text;
                    } catch {}
                }
                if (Object.keys(out).length > 0 || typeof raw !== 'string' || raw === '') return out;
            }
            const source = typeof raw === 'string' && raw !== '' ? raw
                : typeof block?.argsRaw === 'string' ? block.argsRaw
                    : typeof block?.call?.argsRaw === 'string' ? block.call.argsRaw : '';
            if (source === '') return out;
            try {
                const parsed = JSON.parse(source);
                if (isObject(parsed)) for (const key of ARG_KEYS) if (typeof parsed[key] === 'string') out[key] = parsed[key];
                return out;
            } catch {}
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

        /** A day or time an agent gave, in words where it can be read ('Mon, Oct 12, 09:30'), else as given ('tomorrow'). */
        function argWhen(text) {
            const t = String(text ?? '').trim();
            const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(t);
            if (!m || !isDay(m[1])) return t;
            return m[2] ? `${dayText(m[1])}, ${m[2]}` : dayText(m[1]);
        }

        /**
         * What a call does, while it runs or waits for the user (and over a
         * call that didn't work or has no card). name: the event's title,
         * found by the call's id; where: the name of the calendar a move goes to.
         */
        function runningTitle(toolName, a, name = '', where = '') {
            const event = name ? quote(name, 50) : '';
            switch (toolName) {
                case 'calendar_list_calendars': return 'List calendars';
                case 'calendar_events': return a.from ? `Calendar from ${argWhen(a.from)}${a.to ? ` to ${argWhen(a.to)}` : ''}` : 'Calendar for the week';
                case 'calendar_search': return a.query ? `Search calendar for ${quote(a.query, 40)}` : 'Search calendar';
                case 'calendar_get_event': return event ? `Read ${event}` : 'Read event';
                case 'calendar_free_time': return 'Find free time';
                case 'calendar_create_event': return a.title ? `Add ${quote(a.title)}${a.start ? ` at ${argWhen(a.start)}` : ''}` : 'Add event';
                case 'calendar_update_event':
                    if (a.calendar_id) return `Move ${event || 'event'}${where ? ` to ${where}` : ''}`;
                    if (event) return a.title && a.title !== name ? `Change ${quote(name, 40)} to ${quote(a.title, 40)}` : `Change ${event}`;
                    return a.title ? `Change event to ${quote(a.title)}` : 'Change event';
                case 'calendar_delete_event': return event ? `Delete ${event}` : 'Delete event';
                case 'calendar_respond': return `Answer ${event || 'invitation'}${a.answer ? `: ${(ANSWER_WORDS[a.answer] ?? a.answer).toLowerCase()}` : ''}`;
                default: return TEXT.entry;
            }
        }

        /** What a change that didn't work didn't do, by tool; a read that didn't work "didn't work". */
        const NOT_DONE = { calendar_create_event: 'Not added', calendar_update_event: 'Not changed', calendar_delete_event: 'Not deleted', calendar_respond: 'Not answered' };

        /**
         * Why a call didn't work, for the user: the tool's error without its
         * leading words ("Error:", "Not done:", "Failed:", "Done in part:") and
         * without what it tells the agent to do next (a sentence naming a tool
         * or an argument, or telling it to tell or ask the user).
         */
        function failureText(text) {
            const plainText = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/^error:\s*/i, '').replace(/^(not done|failed|done in part):\s*/i, '');
            const sentences = plainText.split(/(?<=[.!?])\s+(?=[A-Z])/);
            const forUser = sentences.filter((s) => {
                const bare = s.replace(/“[^”]*”|"[^"]*"/g, '');
                return !/\b[a-z]+_[a-z_]+\b/.test(bare) && !/\b(tell|ask) the user\b/i.test(bare);
            });
            const out = (forUser.length ? forUser : sentences).join(' ').trim();
            return out.length > 400 ? `${out.slice(0, 399)}…` : out;
        }

        /**
         * A call refused because it would email people and didn't say to tell
         * them (the host's "This would email … to … (why), so it's made only
         * when they are to be told."), in the window's words: who (by name
         * for a few, by number for more), why, and what the user can do. ''
         * for any other text.
         */
        function refusedEmailText(toolName, text) {
            const m = /This would email (.+?) to (.+?) \(([^()]*)\), so it's made only when they are to be told\./.exec(String(text ?? '').replace(/\s+/g, ' '));
            if (m === null) return '';
            const [, what, people, why] = m;
            const more = /^(.*) and (\d+) more$/.exec(people);
            const named = (more ? more[1] : people).split(/, | and /).filter(Boolean);
            const count = named.length + (more ? Number(more[2]) : 0);
            const who = count > 3 ? `${count} ${/decline/.test(what) ? 'people' : 'guests'}` : named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
            const it = /^invitations\b/.test(what) ? 'them' : 'it';
            const verb = { calendar_create_event: 'add it', calendar_delete_event: 'delete it', calendar_respond: 'answer it' }[toolName] ?? 'change it';
            return `It would email ${what} to ${who} (${why}). Ask again to send ${it}, or ${verb} in Calendar.`;
        }

        /** Whether a call's text says it wasn't done (a host that answers a failure as text rather than as the call's error). */
        const saysNotDone = (text) => /^(error:\s*)?(not done|failed|done in part):/i.test(String(text ?? '').trim());
        /** Whether it says a move stopped halfway ("Done in part: …"): copied to its new calendar, still in its old one. */
        const saysPartly = (text) => /^(error:\s*)?done in part:/i.test(String(text ?? '').trim());

        const SCOPE_WORDS = { one: 'this occurrence', following: 'this and the following ones', all: '' };

        /** What a call did, over its card. */
        function doneTitle(view, a, zone) {
            const o = isObject(view.occurrence) ? view.occurrence : {};
            const list = Array.isArray(view.occurrences) ? view.occurrences : EMPTY;
            switch (view.kind) {
                case 'calendars': return `Calendars · ${Array.isArray(view.calendars) ? view.calendars.length : 0}`;
                case 'events': {
                    if (typeof view.query === 'string') return `Search ${quote(view.query, 40)} · ${plural(list.length, 'event')}${view.more ? '+' : ''}`;
                    const span = Number.isFinite(view.from) && Number.isFinite(view.to) ? ` · ${dayRangeText(dayIn(view.from, zone), dayIn(Math.max(view.from, view.to - 1), zone))}` : '';
                    return `Calendar${span} · ${plural(list.length, 'event')}${view.more ? '+' : ''}`;
                }
                case 'event': return `Event ${quote(o.title, 50)}`;
                case 'free': return `Free time · ${plural(Array.isArray(view.slots) ? view.slots.length : 0, 'slot')}`;
                case 'created': return `Added ${quote(o.title, 50)}`;
                case 'updated': return `Changed ${quote(o.title, 50)}${SCOPE_WORDS[view.scope] ? `, ${SCOPE_WORDS[view.scope]}` : ''}`;
                case 'moved': return `Moved ${quote(o.title, 50)}${o.calendar ? ` to ${o.calendar}` : ''}`;
                case 'deleted': return `Deleted ${quote(o.title, 50)}${SCOPE_WORDS[view.scope] ? `, ${SCOPE_WORDS[view.scope]}` : ''}`;
                case 'responded': return `Answered ${(ANSWER_WORDS[view.answer] ?? view.answer ?? '').toLowerCase()}: ${quote(o.title, 50)}`;
                default: return runningTitle('', a);
            }
        }

        const CARD_KINDS = new Set(['calendars', 'events', 'event', 'free', 'created', 'updated', 'moved', 'deleted', 'responded']);
        const noop = () => {};

        /** The text a call gave the agent. */
        function resultText(block) {
            const content = Array.isArray(block?.content) ? block.content : EMPTY;
            return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
        }

        /** A call's one-line head, as DSH draws its tool rows. */
        function ToolHead({ title, running = false, open = false, expandable = false, onToggle = noop, glyph = h(CalendarIcon, { size: 14 }), children }) {
            if (ui.DisclosureRow) {
                return h(ui.DisclosureRow, { icon: glyph, title, open, expandable, onToggle, running, expandOnRowClick: expandable, previewChevron: expandable }, children);
            }
            return h('div', null,
                h('div', { className: 'dshcal-chat-row', 'aria-busy': running ? true : undefined, onClick: expandable ? onToggle : undefined, style: expandable ? { cursor: 'pointer' } : undefined },
                    glyph, h('span', null, title)),
                open ? children : null);
        }

        /** One occurrence in a card's list: its time, its title, where; a click shows it in the calendar. */
        function ChatEvent({ o, zone, day, cal }) {
            const sub = [o.location, o.calendar].filter(Boolean).join(' · ');
            return h('button', {
                type: 'button', className: 'dshcal-chat-ev', style: evStyle(o.color), 'data-look': lookOf(o), 'data-calendar-event': o.id,
                title: 'Show it in the calendar', onClick: () => cal.openAt(o),
            },
            h('span', { className: 'dshcal-chat-bar', 'aria-hidden': true }),
            h('span', { className: 'dshcal-chat-time' }, shortWhen(o, zone, day)),
            h('span', { className: 'dshcal-chat-what' }, h('b', null, o.title || TEXT.noTitle), sub ? h('span', null, ` · ${sub}`) : null));
        }

        /** How many of a list's events a card shows before "Show all". */
        const CARD_EVENTS = 8;

        /** The calendars hidden on the page that a chat's list or search left out, in a line under its card ('' for none). */
        function leftOutWords(view) {
            const names = (Array.isArray(view?.hidden) ? view.hidden : EMPTY).filter((n) => typeof n === 'string' && n !== '');
            if (names.length === 0) return '';
            return `Not ${typeof view.query === 'string' ? 'searched' : 'listed'}: ${andList(names.map((n) => `“${n}”`))}, hidden on the Calendar page.`;
        }

        /** The card under a settled call: its events, an event, free time, the calendars, or what a change did. */
        function ToolCard({ view, zone, cal }) {
            const [all, setAll] = React.useState(false);
            const today = dayIn(Date.now(), zone);
            if (view.kind === 'events') {
                const list = (Array.isArray(view.occurrences) ? view.occurrences : EMPTY).filter((o) => isObject(o) && typeof o.id === 'string');
                const shown = all ? list : list.slice(0, CARD_EVENTS);
                const rows = [];
                let lastDay = '';
                for (const o of shown) {
                    const day = o.allDay ? o.startDay : dayIn(o.start, zone);
                    if (day !== lastDay) {
                        rows.push(h('div', { key: `d:${day}:${rows.length}`, className: 'dshcal-chat-day' }, relativeDay(day, today, { weekday: 'long', month: 'short', day: 'numeric' })));
                        lastDay = day;
                    }
                    rows.push(h(ChatEvent, { key: `${o.id}:${rows.length}`, o, zone, day, cal }));
                }
                return h('div', { className: 'dshcal-chat-card', 'data-calendar-chat-card': 'events' },
                    list.length === 0 ? h('div', { className: 'dshcal-chat-foot' }, typeof view.query === 'string' ? `Nothing matches ${quote(view.query, 40)}.` : 'No events then.') : null,
                    rows,
                    list.length > CARD_EVENTS || view.more ? h('div', { className: 'dshcal-chat-foot dshcal-inline' },
                        list.length > CARD_EVENTS ? h('button', { type: 'button', className: 'dshcal-link', onClick: () => setAll(!all) }, all ? 'Show fewer' : `Show all ${list.length}`) : null,
                        view.more ? h('span', null, 'The calendar has more than the agent read.') : null) : null,
                    leftOutWords(view) ? h('div', { className: 'dshcal-chat-foot', 'data-calendar-chat-hidden': '' }, leftOutWords(view)) : null);
            }
            if (view.kind === 'free') {
                const byDay = new Map();
                for (const s of Array.isArray(view.slots) ? view.slots : EMPTY) {
                    if (!Number.isFinite(s?.start) || !Number.isFinite(s?.end)) continue;
                    const day = dayIn(s.start, zone);
                    byDay.set(day, [...(byDay.get(day) ?? []), s]);
                }
                return h('div', { className: 'dshcal-chat-card', 'data-calendar-chat-card': 'free' },
                    byDay.size === 0 ? h('div', { className: 'dshcal-chat-foot' }, 'No free time then.') : h('div', { className: 'dshcal-chat-slots' },
                        [...byDay].map(([day, slots]) => h('div', { key: day, className: 'dshcal-chat-slot' },
                            h('span', null, relativeDay(day, today, { weekday: 'short', month: 'short', day: 'numeric' })),
                            h('span', null, slots.map((s) => timeRangeText(s.start, s.end, zone)).join(', '))))));
            }
            if (view.kind === 'calendars') {
                const list = (Array.isArray(view.calendars) ? view.calendars : EMPTY).filter(isObject);
                return h('div', { className: 'dshcal-chat-card', 'data-calendar-chat-card': 'calendars' },
                    list.map((c) => h('div', { key: c.id, className: 'dshcal-chat-cal' },
                        h('span', { className: 'dshcal-dot', style: { '--dot': colorOf(c.color) } }),
                        h('span', null, c.name),
                        h('span', { className: 'dshcal-faint' }, [c.account, c.readOnly ? 'read only' : '', c.isDefault ? 'new events go here' : '', c.hidden ? 'hidden' : ''].filter(Boolean).join(' · ')),
                        // What's wrong with it (its kind, never a server's words).
                        typeof c.problem === 'string' && c.problem ? h('span', { className: 'dshcal-warn', 'data-calendar-problem': '' }, c.problem) : null)));
            }
            const o = isObject(view.occurrence) ? view.occurrence : null;
            if (!o) return null;
            const deleted = view.kind === 'deleted';
            const when = Number.isFinite(o.start) || isDay(o.startDay) ? whenText(o, zone) : '';
            // A change: who it emailed, and whose calendars it reached without email.
            // A chat keeps the record: everyone emailed or reached, by name.
            const told = view.kind === 'event' ? '' : contactText(view, { all: true });
            return h('div', { className: 'dshcal-chat-line', 'data-kind': view.kind, 'data-calendar-chat-card': view.kind, style: evStyle(o.color) },
                deleted ? icon('IconTrashOutlineRegular') : view.kind === 'event' ? h('span', { className: 'dshcal-dot', style: { '--dot': colorOf(o.color) } }) : icon('IconCheckCircleOutlineRegular'),
                h('span', { className: 'dshcal-chat-text' },
                    h('b', { style: deleted ? { textDecoration: 'line-through' } : undefined }, o.title || TEXT.noTitle),
                    h('span', null, [when, o.calendar, o.location, o.repeats].filter(Boolean).map((part) => ` · ${part}`).join(''))),
                deleted ? null : h(Btn, { size: 'sm', onClick: () => cal.openAt(o), 'data-calendar-open-event': o.id }, 'Show in Calendar'),
                told ? h('div', { className: 'dshcal-chat-told', 'data-calendar-told': '' }, told) : null);
        }

        /**
         * A call that didn't work: what it tried, and, in view, what it didn't
         * do and why ("Not added: …"). A move that stopped halfway says so
         * ("Moved in part: …"), with what is left to do.
         */
        function FailedRow({ toolName, title, text }) {
            const why = refusedEmailText(toolName, text) || failureText(text);
            const partly = saysPartly(text);
            return h('div', { className: 'dshcal-chat', 'data-calendar-chat': toolName, 'data-phase': 'result', 'data-calendar-failed': partly ? 'partly' : '' },
                h(ToolHead, { title, glyph: icon('IconWarningOutlineRegular') }),
                h('div', { className: 'dshcal-chat-line', 'data-kind': 'failed', 'data-calendar-chat-card': 'failed' },
                    icon('IconWarningOutlineRegular'),
                    h('span', { className: 'dshcal-chat-text' }, h('b', null, `${partly ? 'Moved in part' : NOT_DONE[toolName] ?? 'Didn\'t work'}:`), ` ${why || 'the calendar didn\'t say why.'}`)));
        }

        /** A call with no card: its line, and what it gave the agent folded under it. */
        function PlainRow({ toolName, title, text, useDisclosure }) {
            const disclosure = typeof useDisclosure === 'function' ? useDisclosure() : { expanded: false, toggle: noop };
            return h('div', { className: 'dshcal-chat', 'data-calendar-chat': toolName, 'data-phase': 'result' },
                h(ToolHead, { title, open: disclosure.expanded, expandable: text !== '', onToggle: disclosure.toggle },
                    text ? h('div', { className: 'dshcal-chat-out' }, text) : null));
        }

        /** A call still preparing: its one line, from the arguments streaming in. */
        function PreparingToolView(props) {
            const raw = typeof props.useToolCallArgumentsPartial === 'function' ? props.useToolCallArgumentsPartial() : '';
            return h('div', { className: 'dshcal-chat', 'data-calendar-chat': props.toolName, 'data-phase': 'preparing' },
                h(ToolHead, { title: runningTitle(props.toolName, callArgs(props.block, raw)), running: true }));
        }

        /** A call running or done: its line and, once done, its card. */
        function SettledToolView(props) {
            const { block, phase, toolName, cal } = props;
            const disclosure = typeof props.useDisclosure === 'function' ? props.useDisclosure() : { expanded: false, toggle: noop };
            const store = cal.store;
            useStore(store);
            React.useEffect(() => {
                if (store.state() === undefined) void store.loadState();
            }, [store]);
            const a = callArgs(block);
            // The event and the calendar the call names, by their ids, for its line.
            const title = runningTitle(toolName, a, store.titleOf(a.id), a.calendar_id ? store.calendar(a.calendar_id)?.name ?? '' : '');
            if (phase !== 'result') {
                return h('div', { className: 'dshcal-chat', 'data-calendar-chat': toolName, 'data-phase': 'start' },
                    h(ToolHead, { title, running: true }));
            }
            const text = block?.isError ? String(block?.error?.reason || resultText(block)) : resultText(block);
            // Stopped by the user while it ran: whether it was made isn't known.
            if (block?.isError && block.error?.code === 'interrupted') return h(FailedRow, { toolName, title, text: 'Stopped before it finished: the calendar shows whether it was made.' });
            if (block?.isError || saysNotDone(text)) return h(FailedRow, { toolName, title, text });
            const view = isObject(block?.meta) && CARD_KINDS.has(block.meta.kind) ? block.meta : null;
            if (view === null) return h(PlainRow, { toolName, title, text, useDisclosure: props.useDisclosure });
            const zone = isZone(view.zone) ? view.zone : store.zone();
            return h('div', { className: 'dshcal-chat', 'data-calendar-chat': toolName, 'data-phase': 'result' },
                h(ToolHead, { title: doneTitle(view, a, zone), open: disclosure.expanded, expandable: text !== '', onToggle: disclosure.toggle },
                    text ? h('div', { className: 'dshcal-chat-out', 'aria-label': 'What the agent read' }, text) : null),
                h(ToolCard, { view, zone, cal }));
        }

        /**
         * The view DSH draws for a calendar tool's call in a chat (keyed by
         * the tool's name): a running line while it prepares and runs, then
         * a card of what it read or did. A call that didn't work says what it
         * didn't do, and why; one without a card gets the plugin's plain row.
         */
        function ToolView(props) {
            return props.phase === 'preparing' ? h(PreparingToolView, props) : h(SettledToolView, props);
        }

        // ── In DSH's window ────────────────────────────────────────────────

        /** What the views share: the store, and the way to the Calendar page and to an event on it. */
        function windowApi(ctx, store) {
            const openPage = () => {
                let layout;
                try { layout = ctx.get?.('layout'); } catch { layout = undefined; }
                try {
                    if (typeof layout?.selectPanel === 'function') layout.selectPanel(IDS.page);
                } catch (error) {
                    warn('could not open the Calendar page', error);
                }
            };
            return {
                store,
                openPage,
                /** Show an occurrence on the Calendar page: its day, then its details. */
                openAt(occurrence) {
                    store.openAt(occurrence);
                    openPage();
                },
            };
        }

        /** Required services (cordis inject); each part below waits for its own. */
        const inject = ['slots'];

        function apply(ctx) {
            // DSH's connection, once DSH provides it: the plugin's endpoints go over it (a call made before waits for it).
            let connection;
            const waiting = new Set();
            const whenConnected = (ms) => new Promise((resolve) => {
                const done = (value) => {
                    waiting.delete(done);
                    clearTimeout(timer);
                    resolve(value);
                };
                const timer = setTimeout(() => done(connection), ms);
                waiting.add(done);
            });
            const link = hostLink(() => connection, whenConnected);
            const store = calendarStore(link);
            ctx.inject(['connection'], (scope) => scope.effect(() => {
                const service = scope.connection;
                connection = service;
                for (const done of [...waiting]) done(service);
                return () => { if (connection === service) connection = undefined; };
            }, 'calendar: connection'));

            const cal = windowApi(ctx, store);
            const withApi = () => ({ cal });
            // The Calendar entry in DSH's sidebar, after the projects (5) and categories (6) plugins' pages, and its page.
            ctx.slots.inject('main', () => ctx.slots.register({
                name: 'main', key: IDS.page, inject: withApi,
            }, CalendarPage));
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
                name: 'sidebar.panellist', id: IDS.page, order: 7, label: TEXT.entry,
            }, CalendarIcon));
            // Reminders as DSH's banner, in every window, with no page or pane open.
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                name: 'shell.overlay', id: IDS.reminders, inject: withApi,
            }, ReminderHost));
            // Cards in chats for the calendar tools' calls.
            ctx.slots.inject('tool.call.toolview', function* () {
                for (const key of TOOL_NAMES) {
                    yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: 'conversation', inject: withApi }, ToolView);
                }
            });
            // The Agenda pane beside chats, offered on the right sidebar's guide.
            ctx.inject(['sidebarRightTabs'], (scope) => {
                scope.effect(() => scope.sidebarRightTabs.register({
                    id: IDS.agenda,
                    kind: AGENDA_KIND,
                    title: () => TEXT.agendaTab,
                    guide: [{ id: 'agenda', order: 40, title: () => TEXT.agendaTab, description: () => TEXT.agendaGuide, icon: CalendarIcon }],
                }), 'calendar: agenda pane');
                scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
                    name: 'sidebar.right.pane.tab', key: IDS.agenda, inject: withApi,
                }, AgendaPane));
            });
        }

        module.exports.inject = inject;
        module.exports.apply = apply;
        // For the plugin's own tests: the pieces the views are built on.
        module.exports.internals = {
            BUNDLE, IDS, TOOL_NAMES, PALETTE, VIEWS, CSS, TEXT, PROVIDERS,
            hostLink, errorText, calendarStore, windowApi,
            isZone, browserZone, wallMs, wallOf, offsetAt, toLocal, toInstant, dayIn, minutesIn, startOfDay, isDay, addDays, daysBetween, weekdayOf,
            addMonths, monthStart, weekStartOf, daySpan, daysOf, spansDays, localeWeekStart, weekStartFrom,
            isWeekend, visibleDays, addShownDays, firstShown, shownNear, isoWeek, weekNumberOf, weekWords,
            dayText, timeText, shortTime, whenText, shortWhen, relativeDay, minutesWords, reminderWords, untilWords, lookOf,
            rgbOf, textOn, colorOf, contrast, luminance,
            parseRule, untilValue, untilDay, repeatChoices, repeatFromRule, ruleFromRepeat, repeatProblem,
            columnsOf, lanesOf, fitLanes, daySegments, barItems, agendaDays, rangeOf, stepFrom, dayList,
            SNAP, snapTo, canDrag, movedTo, resizedTo, shiftedBy, keyedTo, KEYS_PAUSE, coveredDays, placedAt, dropPatch, consentArgs, movedWords, ghostWords, openingMinute, clockText, clockRangeText, searchGroups,
            draftFrom, draftProblems, createInput, changePatch, draftChanged, writableCalendars,
            roleOf, othersOf, mailMode, peopleText, sameOccurrence, placed, emailedText, contactText, CHOOSE_CALENDAR, withConsent, consentQuestion, consentWords, asked, removalNotice, returnAddress,
            callArgs, argWhen, runningTitle, doneTitle, resultText, failureText, refusedEmailText, saysNotDone, saysPartly, NOT_DONE,
            CalendarPage, AgendaPane, ToolView, ToolCard, EventDialog, EventPopover, AccountsDialog, ToastHost, toastProps, toastHold, troubleWords, settingsWords, leftOutWords,
            ReminderHost, reminderText, REMINDER_STEP, REMINDER_HOLD,
        };
        return module.exports;
    },
});
