/**
 * Autopilot's settings in words: their titles, which ones its page in
 * Plugins can change while it runs, the ranges each must be in, and what
 * its log says after a save. No DSH packages here, so the checks run in
 * plain unit tests too.
 *
 * @module dsh-plugin-autopilot/config
 */
import { changedEntry, changedTitles, oneOf, onOff, wholeNumber, wholeNumbers } from './shared/settings.js';

/** The settings on Autopilot's page in Plugins, in the words the page and its errors use. */
export const SETTING_TITLES = Object.freeze({
    enabled: 'Autopilot on',
    defaultRule: 'The rule for sessions without their own',
    resumeAfterRestart: 'Resume after a restart',
    resumeWindowHours: 'Resume sessions cut off within',
    idleSeconds: 'Quiet time before a note',
    idleWindowHours: 'At start, look back',
    maxNudges: 'Notes in a row without progress',
    maxNotesPerHour: 'Notes an hour, at most',
    errorRetrySeconds: 'Waits before each try after an error',
    startDelaySeconds: 'Wait after DSH starts',
});

/** The settings its page in Plugins can change while it runs. */
export const LIVE_SETTINGS = Object.freeze(['resumeAfterRestart', 'resumeWindowHours', 'idleSeconds', 'idleWindowHours', 'maxNudges', 'maxNotesPerHour', 'errorRetrySeconds']);

/** What Autopilot uses when the profile sets nothing (the defaults in lib/index.js Config). */
export const DEFAULTS = Object.freeze({
    enabled: true, defaultRule: 'auto', resumeAfterRestart: true, resumeWindowHours: 6, idleSeconds: 600, idleWindowHours: 2,
    maxNudges: 2, maxNotesPerHour: 20, errorRetrySeconds: Object.freeze([120, 600, 1800]), startDelaySeconds: 20,
});

/** Check the settings and say what is wrong in words (a SettingError naming the setting). */
export function checkConfig(settings) {
    const t = SETTING_TITLES;
    onOff(settings, 'enabled', t.enabled);
    oneOf(settings, 'defaultRule', ['auto', 'ask', 'off'], t.defaultRule);
    onOff(settings, 'resumeAfterRestart', t.resumeAfterRestart);
    wholeNumber(settings, 'resumeWindowHours', 1, 168, 'hours', t.resumeWindowHours);
    wholeNumber(settings, 'idleSeconds', 5, 86400, 'seconds', t.idleSeconds);
    wholeNumber(settings, 'idleWindowHours', 1, 168, 'hours', t.idleWindowHours);
    wholeNumber(settings, 'maxNudges', 1, 10, '', t.maxNudges);
    wholeNumber(settings, 'maxNotesPerHour', 1, 500, '', t.maxNotesPerHour);
    wholeNumbers(settings, 'errorRetrySeconds', { minItems: 1, maxItems: 10, min: 0, max: 86400 }, 'seconds', t.errorRetrySeconds);
    wholeNumber(settings, 'startDelaySeconds', 0, 600, 'seconds', t.startDelaySeconds);
}

/** The settings a change touched, by their titles in quotes, from DSH's changed paths. */
export function changedWords(paths) {
    return changedTitles(paths, SETTING_TITLES);
}

/** The unit each number setting is in, for the log's words. */
const UNITS = Object.freeze({ resumeWindowHours: 'hours', idleSeconds: 'seconds', idleWindowHours: 'hours', errorRetrySeconds: 'seconds', startDelaySeconds: 'seconds' });

/**
 * A setting's value in words for the log: "90 seconds", "on", "120, 600,
 * 1800 seconds". A value of the wrong type keeps its quotes ("90" is text,
 * not a number), so the log shows what the profile held.
 */
export function valueWords(key, value) {
    const unit = UNITS[key] ?? '';
    const withUnit = (text, one) => (unit ? `${text} ${one ? unit.replace(/s$/, '') : unit}` : text);
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (typeof value === 'number' && Number.isFinite(value)) return withUnit(String(value), value === 1);
    if (Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) return withUnit(value.join(', '), value.length === 1 && value[0] === 1);
    if (value === undefined) return 'not set';
    return JSON.stringify(value) ?? String(value);
}

/** The settings DSH changed, by key, each once. */
const changedKeys = (paths) => [...new Set((Array.isArray(paths) ? paths : []).map((path) => (Array.isArray(path) ? path[0] : path)).filter((key) => typeof key === 'string'))];

/**
 * After the settings changed (a save in Plugins, or an edit of DSH's
 * profile): check again, and the log entry that says what changed, or
 * undefined when nothing did. With the values from before and after, it
 * says each one: "“Quiet time before a note” now 90 seconds (was 600 seconds)".
 * @param {import('./shared/settings.js').SettingsCheck} check
 * @param {readonly (readonly string[])[]} paths - the settings DSH changed.
 * @param {{ before?: Record<string, unknown>, after?: Record<string, unknown> }} [values]
 */
export function savedEntry(check, paths, values) {
    const entry = changedEntry(check, paths, { name: 'Autopilot', titles: SETTING_TITLES });
    const after = values?.after;
    if (!entry || !after) return entry;
    const before = values.before ?? {};
    const parts = changedKeys(paths).map((key) => {
        const title = `“${SETTING_TITLES[key] ?? key}”`;
        if (!Object.hasOwn(after, key)) return title;
        const now = valueWords(key, after[key]);
        const was = Object.hasOwn(before, key) ? valueWords(key, before[key]) : undefined;
        return `${title} now ${now}${was !== undefined && was !== now ? ` (was ${was})` : ''}`;
    });
    const words = changedWords(paths);
    if (!words) return entry;
    const said = parts.join(', ');
    return { ...entry, text: entry.text.replace(words, said), why: entry.why.replace(words, said) };
}
