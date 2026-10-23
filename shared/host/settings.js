/**
 * A plugin's settings: read live, checked in words, and never a reason for
 * the plugin to fail to start.
 *
 * DSH's settings page (Plugins → the plugin) edits only "live" fields. DSH
 * hands each to the plugin as a reference whose value changes in place when
 * the person saves, and tells the plugin with `loader/volatile-update`;
 * every other field stays fixed until DSH loads the plugin again.
 *
 * A wrong value never stops the plugin from starting: a plugin that fails to
 * start shows only "Problem" in Plugins, and its settings can no longer be
 * changed there. Instead the plugin starts, does no work, and its page says
 * which setting is wrong, what it must be, and where to change it.
 *
 * Schemas give types and defaults only; the ranges live in each plugin's
 * `checkConfig`, which throws a `SettingError` in words.
 *
 * @module suite/shared/settings
 */
import { errorText, isRecord } from './safe.js';

/** Mark a field the person may change on the plugin's page in Plugins while it runs. */
export const live = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema);

/** A config value as it is now: a live reference (`{ get() }`) read, a plain value as it is. */
export const liveValue = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value);

/**
 * The config with every value read when it is used, so a setting the person
 * saves takes effect without a restart. Keys are the config's own.
 * @param {object} config - the config DSH passed to `apply`.
 * @returns {object}
 */
export function liveSettings(config) {
    const out = {};
    for (const key of Object.keys(isRecord(config) ? config : {})) {
        Object.defineProperty(out, key, { enumerable: true, get: () => liveValue(config[key]) });
    }
    return out;
}

/** A setting that is wrong, in words, naming the setting. */
export class SettingError extends Error {
    /**
     * @param {string} key - the setting's name in the config.
     * @param {string} message - what it must be, and what it is.
     */
    constructor(key, message) {
        super(message);
        this.name = 'SettingError';
        this.key = key;
    }
}

const shown = (value) => {
    if (value === undefined) return 'empty';
    try { return JSON.stringify(value).slice(0, 120); } catch { return String(value).slice(0, 120); }
};

/** A setting as the person reads it: its title, then its name in the profile. */
const named = (key, title) => (title ? `${title} (${key})` : key);

/** Throw unless `settings[key]` is a whole number from `min` to `max`. */
export function wholeNumber(settings, key, min, max, unit = '', title = '') {
    const value = settings?.[key];
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    throw new SettingError(key, `${named(key, title)} must be a whole number${unit ? ` of ${unit}` : ''} from ${min} to ${max} (it is ${shown(value)})`);
}

/** Throw unless `settings[key]` is true or false. */
export function onOff(settings, key, title = '') {
    const value = settings?.[key];
    if (typeof value === 'boolean') return value;
    throw new SettingError(key, `${named(key, title)} must be true or false (it is ${shown(value)})`);
}

/**
 * Throw unless `settings[key]` is one of `choices`: a list of values, or the
 * values with the words the settings form shows for them ({ off: 'Nowhere' }),
 * so the error names the choice as the form does, with the value in brackets.
 */
export function oneOf(settings, key, choices, title = '') {
    const value = settings?.[key];
    const pairs = Array.isArray(choices) ? choices.map((c) => [c, '']) : Object.entries(choices);
    if (pairs.some(([c]) => c === value)) return value;
    const words = pairs.map(([c, word]) => (word ? `${word} ("${c}")` : `"${c}"`));
    throw new SettingError(key, `${named(key, title)} must be ${words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : words[0]} (it is ${shown(value)})`);
}

/** Throw unless `settings[key]` lists `minItems` to `maxItems` whole numbers from `min` to `max`. */
export function wholeNumbers(settings, key, { minItems = 1, maxItems = 10, min = 0, max }, unit = '', title = '') {
    const value = settings?.[key];
    if (Array.isArray(value) && value.length >= minItems && value.length <= maxItems && value.every((n) => Number.isInteger(n) && n >= min && n <= max)) return value;
    throw new SettingError(key, `${named(key, title)} must list ${minItems} to ${maxItems} whole numbers${unit ? ` of ${unit}` : ''}, each from ${min} to ${max} (it is ${shown(value)})`);
}

/**
 * Throw unless `settings[key]` names a key in DSH's key store (a secret kept
 * out of the settings file): letters, digits and _, not starting with a digit.
 */
export function keyName(settings, key, title = '') {
    const value = settings?.[key];
    if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
    throw new SettingError(key, `${named(key, title)} must be a name of letters, digits and _ that does not start with a digit, such as MY_WEBHOOK_URL (it is ${shown(value)})`);
}

/**
 * Throw unless `settings[key]` lists a program by its full path, then its
 * arguments; an empty list passes when `optional`.
 */
export function commandLine(settings, key, { optional = false } = {}, title = '') {
    const value = settings?.[key];
    const example = '["/usr/local/bin/notify", "--to", "me"]';
    if (!Array.isArray(value) || value.some((part) => typeof part !== 'string')) {
        throw new SettingError(key, `${named(key, title)} must list the program and then its arguments, for example ${example} (it is ${shown(value)})`);
    }
    if (value.length === 0) {
        if (optional) return value;
        throw new SettingError(key, `${named(key, title)} is empty: list the program and then its arguments, for example ${example}`);
    }
    if (!value[0].startsWith('/')) throw new SettingError(key, `${named(key, title)} must start with the program's full path, such as /usr/local/bin/notify (it starts with ${shown(value[0])})`);
    return value;
}

/**
 * The settings, checked when the plugin starts and each time the person
 * saves one: `problem` is undefined while every value is right, else what
 * is wrong, in words, with whether the person can fix it on the plugin's
 * page in Plugins (`live`) or only in DSH's profile.
 */
export class SettingsCheck {
    /**
     * @param {object} options
     * @param {object} options.settings - from `liveSettings`.
     * @param {(settings: object) => void} options.check - throws what is wrong.
     * @param {Iterable<string>} [options.liveKeys] - the settings the plugin's page in Plugins can change.
     * @param {string} options.label - the plugin's name, for the log.
     * @param {{ warn: Function, info?: Function }} [options.logger]
     */
    constructor({ settings, check, liveKeys = [], label, logger }) {
        this.settings = settings;
        this.checkFn = check;
        this.liveKeys = new Set(liveKeys);
        this.label = label;
        this.logger = logger;
        /** @type {{ text: string, key?: string, live: boolean } | undefined} */
        this.problem = undefined;
    }

    get ok() {
        return this.problem === undefined;
    }

    /**
     * Check again. Logs a change either way.
     * @returns {boolean} whether every value is right now.
     */
    run() {
        const was = this.problem?.text;
        try {
            this.checkFn(this.settings);
            this.problem = undefined;
        } catch (error) {
            const key = typeof error?.key === 'string' ? error.key : undefined;
            this.problem = { text: errorText(error, 400).replace(/^[a-z-]+: /, ''), ...(key ? { key } : {}), live: key !== undefined && this.liveKeys.has(key) };
        }
        const now = this.problem?.text;
        if (now !== was) {
            if (now) this.logger?.warn?.(`${this.label}: not working until a setting is fixed: ${now}`);
            else if (was) this.logger?.info?.(`${this.label}: settings fixed (${was}); working again`);
        }
        return this.problem === undefined;
    }
}

/** The settings a change touched, by their titles in quotes, from DSH's changed paths. */
export function changedTitles(paths, titles = {}) {
    const keys = [...new Set((Array.isArray(paths) ? paths : []).map((path) => (Array.isArray(path) ? path[0] : path)).filter((key) => typeof key === 'string'))];
    return keys.map((key) => `“${titles[key] ?? key}”`).join(', ');
}

/**
 * After the settings changed (DSH's `loader/volatile-update`, which a save
 * in Plugins and an edit of DSH's profile both send): check again, and the
 * log entry that says what changed, or undefined when nothing did. It does
 * not say who changed them or where: DSH does not tell.
 * @param {SettingsCheck} check
 * @param {readonly (readonly string[])[]} paths - the settings DSH changed.
 * @param {{ name: string, titles: Record<string, string> }} plugin - its name in sentences, and its settings' titles.
 */
export function changedEntry(check, paths, { name, titles }) {
    const was = check.problem?.text;
    check.run();
    const words = changedTitles(paths, titles);
    if (!check.ok) {
        return { kind: 'settings', text: `Settings changed${words ? `: ${words}` : ''}; ${name} waits until a wrong one is fixed`, why: `${check.problem.text}.`, state: 'waiting on a setting' };
    }
    if (was) return { kind: 'settings', text: `Settings fixed: ${name} is working again`, why: words ? `The change to ${words} fixed it.` : 'Its settings are right again.', state: 'done' };
    if (words) return { kind: 'settings', text: `Settings changed: ${words}`, why: 'They apply now.', state: 'done' };
    return undefined;
}
