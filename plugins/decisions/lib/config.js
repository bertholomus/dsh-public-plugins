/**
 * Decisions' settings in words: their titles, which ones its page in
 * Plugins can change while it runs, what each must be, and what its log
 * says after a save. No DSH packages here, so the checks run in plain unit
 * tests too.
 *
 * A wrong value never stops Decisions from starting: it lists and holds
 * nothing, and its page says which setting is wrong, what it must be, and
 * where to change it.
 *
 * @module dsh-plugin-decisions/config
 */
import { changedEntry, changedTitles, keyName, oneOf, onOff, wholeNumber } from './shared/settings.js';

/** The settings, in the words the page, the settings form and the errors use. */
export const SETTING_TITLES = Object.freeze({
    enabled: 'Decisions on',
    approvals: 'Tools waiting for approval',
    questions: 'Questions in the question box',
    replies: 'Replies that end with a question',
    threads: 'Threads that need a decision',
    notify: 'A notification for each new card',
    windowHours: 'Keep a reply\'s question for',
    mirror: 'Also send new cards to',
    mirrorUrlEnv: 'The key that holds the webhook address',
    mirrorCommand: 'The command',
    mirrorPerHour: 'Messages sent an hour, at most',
});

/** The settings its page in Plugins can change while it runs. */
export const LIVE_SETTINGS = Object.freeze(['approvals', 'questions', 'replies', 'threads', 'notify', 'windowHours', 'mirror', 'mirrorUrlEnv', 'mirrorPerHour']);

/** Where the webhook address is kept: a key in DSH's key store (or the environment DSH starts in), never the settings file. */
export const WEBHOOK_KEY = 'DECISIONS_WEBHOOK_URL';

/** What Decisions uses when the profile sets nothing (the defaults in lib/index.js Config). */
export const DEFAULTS = Object.freeze({
    enabled: true,
    approvals: true,
    questions: true,
    replies: true,
    threads: true,
    notify: true,
    windowHours: 72,
    mirror: 'off',
    mirrorUrlEnv: WEBHOOK_KEY,
    mirrorCommand: Object.freeze([]),
    mirrorPerHour: 30,
});

/** Check the settings and say what is wrong in words (a SettingError naming the setting). */
export function checkConfig(settings) {
    const t = SETTING_TITLES;
    onOff(settings, 'enabled', t.enabled);
    for (const key of ['approvals', 'questions', 'replies', 'threads', 'notify']) onOff(settings, key, t[key]);
    wholeNumber(settings, 'windowHours', 1, 720, 'hours', t.windowHours);
    oneOf(settings, 'mirror', { off: 'Nowhere', webhook: 'Webhook', command: 'Command' }, t.mirror);
    keyName(settings, 'mirrorUrlEnv', t.mirrorUrlEnv);
    // mirrorCommand is checked by the mirror alone, while new cards go to a command: a wrong command stops only
    // the mirror (its line on the page says what is wrong and where to change it), never the inbox.
    wholeNumber(settings, 'mirrorPerHour', 1, 500, '', t.mirrorPerHour);
}

/** The settings a change touched, by their titles in quotes, from DSH's changed paths. */
export function changedWords(paths) {
    return changedTitles(paths, SETTING_TITLES);
}

/**
 * After the settings changed (a save in Plugins, or an edit of DSH's
 * profile): check again, and the log entry that says what changed, or
 * undefined when nothing did.
 * @param {import('./shared/settings.js').SettingsCheck} check
 * @param {readonly (readonly string[])[]} paths - the settings DSH changed.
 */
export function savedEntry(check, paths) {
    return changedEntry(check, paths, { name: 'Decisions', titles: SETTING_TITLES });
}
