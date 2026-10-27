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
import { createHash } from 'node:crypto';
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
 * Each setting's value as a short hash, kept in Decisions' state: at its next
 * start, what an edit of DSH's profile changed (one that restarts Decisions,
 * such as `enabled` or `mirrorCommand`) is said in its log.
 */
export function settingHashes(settings) {
    const out = {};
    for (const key of Object.keys(SETTING_TITLES)) {
        let text;
        try { text = JSON.stringify(settings?.[key]) ?? 'undefined'; } catch { text = 'unreadable'; }
        out[key] = createHash('sha256').update(text).digest('hex').slice(0, 16);
    }
    return out;
}

/** `settingHashes`' hash of `enabled: false`: how a start tells that Decisions was switched off when it last ran. */
const OFF_HASH = settingHashes({ enabled: false }).enabled;

/**
 * At start: the log entry for the settings that changed since Decisions last
 * ran (an edit of DSH's profile restarts it), or undefined when none did or
 * it never ran before. A switch of `enabled` is said as what it did:
 * switched off, or switched on again.
 * @param {import('./shared/settings.js').SettingsCheck} check - already run.
 * @param {Record<string, string> | undefined} before - `settingHashes` when it last ran.
 * @param {Record<string, string>} now - `settingHashes` now.
 * @param {{ enabled?: unknown }} [settings] - the settings now, for which way `enabled` went.
 */
export function startEntry(check, before, now, settings = {}) {
    if (!before) return undefined;
    const keys = Object.keys(now).filter((key) => before[key] !== now[key]);
    if (keys.length === 0) return undefined;
    const off = settings.enabled === false;
    const wasOff = before.enabled === OFF_HASH;
    // `enabled` changed between on and off: said as such, with any other setting that changed with it.
    const switched = keys.includes('enabled') && off !== wasOff && check.ok;
    const others = switched ? keys.filter((key) => key !== 'enabled') : keys;
    const also = others.length ? `; also changed: ${changedWords(others.map((key) => [key]))}` : '';
    if (switched && off) {
        return { kind: 'settings', text: `Switched off in DSH's profile (enabled: false)${also}`, why: 'Decisions lists and holds nothing until enabled is true again; DSH\'s own cards work as always.', state: 'paused' };
    }
    if (switched) return { kind: 'settings', text: `Switched on again in DSH's profile (enabled: true)${also}`, why: 'Decisions lists and holds again.', state: 'done' };
    const words = changedWords(keys.map((key) => [key]));
    if (!check.ok) return { kind: 'settings', text: `Settings changed in DSH's profile: ${words}; Decisions waits until a wrong one is fixed`, why: `${check.problem.text}.`, state: 'waiting on a setting' };
    return { kind: 'settings', text: `Settings changed in DSH's profile: ${words}`, why: 'Decisions started again with them.', state: 'done' };
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
