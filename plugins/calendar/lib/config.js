/**
 * The plugin's settings, checked in words. DSH checks a plugin's entry in
 * the profile's cordis.patch.yml against its schema before the plugin
 * starts, and a value of the wrong type there (a number in quotes, "yes"
 * for a switch) would stop the plugin with only "Problem" in Plugins. So the
 * schema (index.js) takes any value with its default, and this module says
 * what is wrong with each one, in words, and what the plugin uses until it
 * is fixed: always the safe choice (agents get no calendar tools, every
 * change from a chat asks, an email always asks first). The calendar itself
 * keeps working; its page and log say which setting to change and where.
 *
 * Pure: no DSH package, no file system. The paths are resolved against DSH's
 * data folder, which index.js reads from DSH (DSH_HOME, else the home's
 * DSH folder) and hands in.
 *
 * @module dsh-plugin-calendar/config
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isZone, localZone } from './zones.js';

/** What each setting takes, its default, and the safe value used while it is wrong. */
export const DEFAULTS = Object.freeze({
    enabled: true,
    storeFile: 'calendar/calendar.json',
    logFile: 'calendar/calendar.log',
    syncMinutes: 15,
    timeZone: '',
    tools: true,
    agentChanges: 'preset',
    askBeforeEmails: true,
    reminders: true,
    googleClientId: '',
    googleClientSecretRef: 'CALENDAR_GOOGLE_CLIENT_SECRET',
    microsoftClientId: '',
    microsoftTenant: 'common',
});

/**
 * The settings safety depends on: while one is wrong, the plugin uses the safe choice, not the default. A wrong
 * `enabled` means off: someone touched the off switch, so the calendar stops rather than sync and give chats tools.
 */
const SAFE = Object.freeze({ enabled: false, tools: false, agentChanges: 'ask', askBeforeEmails: true });

export const MODES = Object.freeze(['preset', 'ask', 'off']);
export const SYNC_MINUTES = Object.freeze({ min: 5, max: 1440 });

/** Test servers in place of Google's and Microsoft's (tests only, and only on this computer: index.js). */
export const TEST_ENDPOINTS = Object.freeze(['googleApiBase', 'googleAuthorizeUrl', 'googleTokenUrl', 'googleUserinfoUrl', 'googleRevokeUrl', 'microsoftGraphBase', 'microsoftLoginBase']);

const shown = (value) => {
    if (value === undefined) return 'empty';
    try {
        return JSON.stringify(value).slice(0, 80);
    } catch {
        return String(value).slice(0, 80);
    }
};

const usedWords = (value) => (value === '' ? 'none' : typeof value === 'string' ? `“${value}”` : String(value));

/**
 * The settings as the plugin uses them, and what is wrong with any of them.
 * @param {object} raw - the config DSH passed to apply.
 * @returns {{ settings: object, problems: { key: string, text: string }[] }}
 *   problems: one per wrong setting, in words: what it must be, what it is,
 *   and what the plugin uses until it is fixed.
 */
export function checkConfig(raw) {
    const given = raw !== null && typeof raw === 'object' ? raw : {};
    const settings = {};
    const problems = [];
    /** A wrong setting: what it must be, what it is, and what happens until it's fixed (`then`, else "the calendar uses …"). */
    const wrong = (key, must, use, then = `the calendar uses ${usedWords(use)}`) => {
        settings[key] = use;
        problems.push({ key, text: `${key} must be ${must} (it is ${shown(given[key])}); ${then} until it's fixed.` });
    };
    const value = (key) => (given[key] === undefined || given[key] === null ? DEFAULTS[key] : given[key]);

    const onOff = (key, then) => {
        const v = value(key);
        if (typeof v === 'boolean') settings[key] = v;
        else wrong(key, 'true or false', SAFE[key] ?? DEFAULTS[key], then);
    };
    onOff('enabled', 'the calendar is switched off');
    onOff('tools', 'chats get no calendar tools');
    onOff('askBeforeEmails', 'a chat\'s change that emails anyone, or reaches their Google calendars, asks you first');
    onOff('reminders', 'reminders show in DSH');

    for (const key of ['storeFile', 'logFile']) {
        const v = value(key);
        if (typeof v === 'string' && (v.trim() !== '' || key === 'logFile')) settings[key] = v.trim();
        else wrong(key, key === 'logFile' ? 'a file path, or empty to keep no log' : 'a file path', DEFAULTS[key]);
    }

    const minutes = value('syncMinutes');
    if (Number.isInteger(minutes) && minutes >= SYNC_MINUTES.min && minutes <= SYNC_MINUTES.max) settings.syncMinutes = minutes;
    else wrong('syncMinutes', `a whole number of minutes from ${SYNC_MINUTES.min} to ${SYNC_MINUTES.max}`, DEFAULTS.syncMinutes);

    const zone = value('timeZone');
    if (typeof zone === 'string' && (zone.trim() === '' || isZone(zone.trim()))) settings.timeZone = zone.trim();
    else wrong('timeZone', 'a time zone such as Europe/Berlin, or empty for this computer\'s', '', `the calendar uses this computer's zone (${localZone()})`);

    const mode = value('agentChanges');
    if (MODES.includes(mode)) settings.agentChanges = mode;
    else wrong('agentChanges', '"preset", "ask" or "off"', SAFE.agentChanges, 'every change from a chat asks you first');

    const google = value('googleClientId');
    if (typeof google === 'string' && (google.trim() === '' || /^[\w.-]+\.apps\.googleusercontent\.com$/.test(google.trim()))) settings.googleClientId = google.trim();
    else wrong('googleClientId', 'a Google OAuth client id ending in .apps.googleusercontent.com, or empty', '', 'Google sign-in uses the one set in the Accounts dialog, if any,');

    const ref = value('googleClientSecretRef');
    if (typeof ref === 'string' && /^[A-Za-z_][\w./:-]*$/.test(ref.trim())) settings.googleClientSecretRef = ref.trim();
    else wrong('googleClientSecretRef', 'the name of a DSH credential, such as CALENDAR_GOOGLE_CLIENT_SECRET', DEFAULTS.googleClientSecretRef);

    const microsoft = value('microsoftClientId');
    if (typeof microsoft === 'string' && (microsoft.trim() === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(microsoft.trim()))) {
        settings.microsoftClientId = microsoft.trim();
    } else {
        wrong('microsoftClientId', 'an application (client) id such as 00000000-0000-0000-0000-000000000000, or empty', '', 'Microsoft sign-in uses the one set in the Accounts dialog, if any,');
    }

    const tenant = value('microsoftTenant');
    if (typeof tenant === 'string' && /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i.test(tenant.trim())) {
        settings.microsoftTenant = tenant.trim();
    } else {
        wrong('microsoftTenant', '"common", "organizations", "consumers", a tenant id or a tenant\'s domain', DEFAULTS.microsoftTenant);
    }

    for (const key of TEST_ENDPOINTS) {
        const v = given[key];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'string') settings[key] = v.trim();
        else {
            wrong(key, 'an address', '', 'it is left out');
            delete settings[key];
        }
    }
    return { settings, problems };
}

/**
 * A data path as the plugin opens it: a relative one is in `home` (DSH's data
 * folder), `~/` is the user's home, and one written under the home's own DSH
 * folder follows `home` too, so a test copy of DSH (its own DSH_HOME) keeps its
 * own calendars.
 * @param {string} path
 * @param {string} [home] - DSH's data folder; without it, relative paths stay relative.
 */
export function dataPath(path, home) {
    if (typeof path !== 'string' || path === '') return '';
    if (home) {
        const inDsh = /^~\/\.dsh(?=\/|$)/.exec(path);
        if (inDsh) return join(home, path.slice(inDsh[0].length));
    }
    if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
    if (isAbsolute(path) || !home) return path;
    return resolve(home, path);
}

/**
 * An unexpected failure in words, for the window or a chat: no file path (its
 * name alone says enough), no stack, at most `max` characters. A web address
 * stays as it is.
 */
export function plainFailure(error, max = 300) {
    const text = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim()
        .replace(/(^|[\s'"`(=])(?:~|[A-Za-z]:)?(?:[\\/][^\s'"`,;()\\/]+)*[\\/]([^\s'"`,;()\\/]+)/g, '$1$2');
    return (text === '' ? 'Something went wrong.' : text).slice(0, max);
}
