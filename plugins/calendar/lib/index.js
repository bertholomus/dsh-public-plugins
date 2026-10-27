/**
 * dsh-plugin-calendar — the user's calendars in DSH, for the user and for
 * agents.
 *
 * Calendars come from iCloud, Fastmail, Nextcloud and other CalDAV servers,
 * Google, Microsoft 365 and Outlook.com, subscribed .ics feeds, and
 * calendars kept in DSH (lib/sources). The host half
 * (lib/manager.js) syncs them into the plugin's own store and routes every
 * change to the server that holds the event. The window (lib/client.js) has
 * a Calendar page and an agenda beside chats, styled to sit on the
 * wallpaper plugin's glass when it is on; agents get calendar_* tools
 * (lib/tools.js), and whether a chat may change calendars is decided per
 * call by its permission (lib/policy.js).
 *
 * Passwords, sign-ins and subscriptions' addresses (a private feed's key is
 * in its path) are kept in DSH's credential store, never in the plugin's
 * files or log.
 *
 * @module dsh-plugin-calendar
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import z from '@deepseek-ai/schemastery';
import { TEST_ENDPOINTS, checkConfig, dataPath } from './config.js';
import { isLoopback } from './http.js';
import { CalendarManager } from './manager.js';
import { ShownPlans, changeGate } from './policy.js';
import { CalendarOff, CalendarRemote, SERVICE } from './remote.js';
import { calendarTools } from './tools.js';

export const name = 'calendar';

/** Host services the plugin uses. */
export const inject = ['tools', 'credentials'];

/*
 * Every key takes any value with its default: DSH stops a plugin whose entry has a value of the wrong type,
 * with only "Problem" in Plugins. config.js checks each one in words instead; while one is wrong, the plugin
 * uses the safe choice, logs it, and the Calendar page says which setting to change.
 */
export const Config = z.object({
    /** Master switch. */
    enabled: z.any().default(true),
    /**
     * Accounts, calendars and choices (mode 600); each calendar's events are in an events folder beside it.
     * A relative path is in DSH's data folder (DSH_HOME, else the home's DSH folder).
     */
    storeFile: z.any().default('calendar/calendar.json'),
    /** Action log, mode 600: ids, kinds and counts, never event text or secrets. Empty turns it off. Relative: in DSH's data folder. */
    logFile: z.any().default('calendar/calendar.log'),
    /** How often accounts sync, in minutes (5 to 1440). */
    syncMinutes: z.any().default(15),
    /** The user's time zone (IANA, like Europe/Berlin). Empty: this computer's. */
    timeZone: z.any().default(''),
    /** Agents' calendar tools. Off: chats can't see or change calendars; the window still can. */
    tools: z.any().default(true),
    /**
     * Whether agents may change calendars: 'preset' by the chat's permission
     * (Read Only can't, Full access can, others ask first), 'ask' always ask
     * first, 'off' never.
     */
    agentChanges: z.any().default('preset'),
    /**
     * Whether a chat's change that emails someone (an invitation, an update,
     * a cancellation, an answer), or puts an event on other people's Google
     * calendars or takes it off them, asks the user first, naming who,
     * whatever agentChanges says. A chat that can't ask (Full access) is
     * refused such changes instead. Off: those changes follow agentChanges
     * like any other; the plugin warns at start, and agents are told. It is
     * set only in the profile's config file (cordis.patch.yml), which no
     * calendar tool or window endpoint changes; a chat that can write files
     * there can, from DSH's next start.
     */
    askBeforeEmails: z.any().default(true),
    /**
     * Whether the calendars' reminders show in DSH: at each reminder's time, DSH's banner at the top of the window
     * with the event and Open (and Join for a call), shown once by one window. Off: they fire only where the
     * calendar's server sends them (your phone and other apps).
     */
    reminders: z.any().default(true),
    /** Google sign-in: the client id of the user's own OAuth client (Desktop app). The window can set it too. */
    googleClientId: z.any().default(''),
    /** The credential (DSH's store or the environment) that holds that client's secret. */
    googleClientSecretRef: z.any().default('CALENDAR_GOOGLE_CLIENT_SECRET'),
    /** Microsoft sign-in: the application (client) id of the user's own app registration, with public client flows on. */
    microsoftClientId: z.any().default(''),
    /** Microsoft tenant: 'common' for work, school and personal accounts, or a tenant id. */
    microsoftTenant: z.any().default('common'),
    /** Test servers in place of Google's and Microsoft's: tests only, and only on this computer. */
    googleApiBase: z.any().default(''),
    googleAuthorizeUrl: z.any().default(''),
    googleTokenUrl: z.any().default(''),
    googleUserinfoUrl: z.any().default(''),
    googleRevokeUrl: z.any().default(''),
    microsoftGraphBase: z.any().default(''),
    microsoftLoginBase: z.any().default(''),
});

/** The credential record that holds one account's password or sign-in. */
const recordOf = (accountId) => `calendar/${accountId}`;

export function apply(ctx, raw) {
    // Each setting checked in words; a wrong one never stops the plugin: it uses the safe choice and says so.
    const { settings: config, problems } = checkConfig(raw);
    for (const problem of problems) ctx.logger?.warn?.('calendar: setting %s is wrong: %s', problem.key, problem.text);
    if (!config.enabled) {
        // Switched off: no sync, no file, no tools. The window's calls say so in words rather than going unanswered.
        ctx.inject(['typertGateway'], (scope) => {
            // A wrong value switches it off too, and says so (config.js).
            scope.provide(SERVICE, new CalendarOff(scope, problems.find((p) => p.key === 'enabled')?.text));
        });
        return;
    }
    // Its files in DSH's data folder, as DSH resolves it (DSH_HOME, else the home's DSH folder).
    const home = dshHomePath();
    config.storeFile = dataPath(config.storeFile, home);
    config.logFile = dataPath(config.logFile, home);

    // Each account's secret, in DSH's credential store as a record of this plugin's own.
    const secrets = {
        async get(accountId) {
            const record = await ctx.credentials.readRecord(recordOf(accountId));
            return record?.kind === 'grant' ? record.payload : undefined;
        },
        async set(accountId, payload) {
            await ctx.credentials.modifyRecord(recordOf(accountId), async () => ({ kind: 'grant', payload }));
        },
        async clear(accountId) {
            await ctx.credentials.deleteRecord(recordOf(accountId));
        },
    };

    let manager;
    /** Test server settings that point elsewhere, warned about once. */
    const ignored = new Set();
    /**
     * What Google's and Microsoft's sign-ins need, read each time one starts or a token refreshes. secret: false
     * leaves the Google client secret out (undefined), unread.
     */
    const clientSettings = async ({ secret = true } = {}) => {
        const prefs = manager?.store.prefs ?? {};
        let googleClientSecret = secret ? '' : undefined;
        if (secret) {
            try {
                googleClientSecret = (await ctx.credentials.resolve(config.googleClientSecretRef))?.value ?? '';
            } catch {
                // An unusable reference reads as not set: the window says what's missing.
            }
        }
        const out = {
            googleClientId: String(prefs.googleClientId || config.googleClientId || '').trim(),
            googleClientSecret,
            microsoftClientId: String(prefs.microsoftClientId || config.microsoftClientId || '').trim(),
            microsoftTenant: String(prefs.microsoftTenant || config.microsoftTenant || 'common').trim(),
        };
        // A test server stands in only on this computer: no setting sends the client secret or a sign-in anywhere else.
        for (const key of TEST_ENDPOINTS) {
            const value = typeof config[key] === 'string' ? config[key].trim() : '';
            if (value === '') continue;
            if (isLoopback(value)) out[key] = value;
            else if (!ignored.has(key)) {
                ignored.add(key);
                ctx.logger?.warn?.('calendar: %s is ignored: a test server must be on this computer', key);
            }
        }
        return out;
    };

    manager = new CalendarManager({ config, secrets, clientSettings, logger: ctx.logger });
    for (const problem of problems) manager.log(`setting wrong ${problem.key}`);
    // Switched off or reloaded: this manager stops (writing what it holds), and the next start reads the files.
    ctx.effect(() => () => manager.dispose(), 'calendar.manager()');

    const askEmails = config.askBeforeEmails !== false;
    /** Whether the Google client secret is set, as last read: the window asks for the state every few seconds. */
    let secretSeen;
    const setup = {
        /** Whether chats' emailing changes ask the user first (askBeforeEmails), for the window to say when they don't. */
        askBeforeEmails: () => askEmails,
        /** The settings that are wrong, in words, for the window to say ([{key, text}]). */
        settingsProblems: () => problems,
        /** What each sign-in still needs; the credential store is read for the Google secret at most every half minute. */
        async signInReady() {
            const stale = secretSeen === undefined || Date.now() - secretSeen.at > 30_000;
            const s = await clientSettings({ secret: stale });
            if (stale) secretSeen = { set: s.googleClientSecret !== '', at: Date.now() };
            const secretSet = secretSeen.set;
            return {
                google: { ready: s.googleClientId !== '' && secretSet, secretSet, ...(s.googleClientId ? { clientId: s.googleClientId } : {}) },
                microsoft: { ready: s.microsoftClientId !== '', ...(s.microsoftClientId ? { clientId: s.microsoftClientId, tenant: s.microsoftTenant } : {}) },
            };
        },
        async setGoogleSecret(secret) {
            await ctx.credentials.set(config.googleClientSecretRef, secret);
            secretSeen = undefined;
        },
    };

    // The window's endpoints (remote.js), served by DSH's own gateway.
    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new CalendarRemote(scope, manager, setup));
    });

    if (!askEmails) ctx.logger?.warn?.('calendar: askBeforeEmails is off: changes from chats that email guests are made without asking the user');

    if (config.tools) {
        // Who the approval prompt named, for the tool to hold the change to (policy.js ShownPlans).
        const shown = new ShownPlans();
        // Each tool is marked as the user's own (tools.js PERSONAL), so project sessions get it only as the user allows.
        for (const tool of calendarTools(manager, { askEmails, shown })) ctx.tools.register(tool);
        // Changes go through the chat's permission first (policy.js).
        const service = (key) => {
            try { return ctx.get?.(key); } catch { return undefined; }
        };
        ctx.on('tools/pre-execute', changeGate({
            presets: () => service('permissionPresets'),
            approval: () => service('approval'),
            manager,
            mode: () => config.agentChanges,
            askEmails: () => askEmails,
            shown,
            log: (line) => manager.log(line),
        }));
    }

    manager.start().then(() => {
        ctx.logger?.info?.('calendar: %d calendar(s) in %d account(s)', Object.keys(manager.store.calendars).length, Object.keys(manager.store.accounts).length);
        // A file that couldn't be read is kept beside the store, and the plugin started without it: say so where it's seen.
        const where = (issue) => (issue.held ? 'left as it is' : `set aside as ${issue.file}`);
        if (manager.store.issue) ctx.logger?.warn?.('calendar: calendar.json could not be read and was %s; started without it, nothing deleted', where(manager.store.issue));
        for (const [calendarId, issue] of manager.store.issues ?? []) {
            ctx.logger?.warn?.('calendar: the saved events of %s could not be read and were %s; nothing deleted', calendarId, where(issue));
        }
    }, (error) => {
        ctx.logger?.warn?.('calendar: startup failed: %s', error?.message ?? error);
    });
}
