/**
 * Canon's settings in words: their titles, which ones its page in Plugins
 * can change while it runs, what each must be, and what its log says after
 * a save. No DSH packages here, so the checks run in plain unit tests too.
 *
 * A wrong value never stops Canon from starting: it adds nothing to turns
 * and writes nothing, and its page says which setting is wrong, what it
 * must be, and where to change it. A vault folder that is right as a
 * setting but cannot be read (missing, no permission) is not a setting
 * problem: the page says what is wrong with the folder instead.
 *
 * @module dsh-plugin-canon/config
 */
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { SettingError, changedEntry, changedTitles } from './shared/settings.js';

/** The settings, in the words the page, the settings form and the errors use. */
export const SETTING_TITLES = Object.freeze({
    enabled: 'Canon on',
    vault: 'Vault folder',
    access: 'What Canon may write',
    draftsFolder: 'Drafts folder',
    promote: 'Allow promoting drafts',
    promoteFolder: 'Promoted notes go to',
    recall: 'Add notes to turns',
    maxNotes: 'Notes a turn, at most',
    maxChars: 'Characters a turn, at most',
});

/** The settings its page in Plugins can change while it runs (all but `enabled`). */
export const LIVE_SETTINGS = Object.freeze(['vault', 'access', 'draftsFolder', 'promote', 'promoteFolder', 'recall', 'maxNotes', 'maxChars']);

/** What Canon may write into the vault: nothing, or new draft notes in the drafts folder. */
export const ACCESS_CHOICES = Object.freeze({ 'read-only': 'Read only', drafts: 'Drafts' });

/** What Canon uses when the profile sets nothing (the defaults in lib/index.js Config). */
export const DEFAULTS = Object.freeze({
    enabled: true,
    vault: '',
    access: 'read-only',
    draftsFolder: 'Drafts',
    promote: false,
    promoteFolder: '',
    recall: true,
    maxNotes: 3,
    maxChars: 2000,
});

/** The ranges the numbers must be in (the settings form uses the same). */
export const RANGES = Object.freeze({ maxNotes: [1, 10], maxChars: [400, 8000] });

/** A value as Canon's words show it: text in quotes (“…”), anything else as the profile writes it. */
const shown = (value) => {
    if (value === undefined) return 'empty';
    if (typeof value === 'string') return `“${value.length > 120 ? `${value.slice(0, 119)}…` : value}”`;
    try { return JSON.stringify(value).slice(0, 120); } catch { return String(value).slice(0, 120); }
};

/** A setting as the person reads it: its title, then its name in the profile. */
const named = (key) => `${SETTING_TITLES[key]} (${key})`;

/**
 * Whether a value is a number or true/false written in quotes: text in the
 * profile, so its words say how to write it instead.
 */
const quoted = (value, looks) => typeof value === 'string' && looks.test(value.trim());
const QUOTED_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
const QUOTED_SWITCH = /^(?:true|false)$/i;

/** The settings that are true or false. */
const SWITCHES = Object.freeze(['enabled', 'promote', 'recall']);

/**
 * What a setting written in quotes would be without them, when that is
 * right for it: "3" for Notes a turn, at most, is 3; "false" for a switch is
 * false. Undefined for anything else (another type, a number out of range,
 * a setting that is not a number or a switch): the page offers to save the
 * value without quotes only then.
 * @param {object} settings
 * @param {string} key
 * @returns {number | boolean | undefined}
 */
export function unquoted(settings, key) {
    const value = settings?.[key];
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (SWITCHES.includes(key)) return QUOTED_SWITCH.test(text) ? text.toLowerCase() === 'true' : undefined;
    if (!Object.hasOwn(RANGES, key) || !QUOTED_NUMBER.test(text)) return undefined;
    const n = Number(text);
    const [min, max] = RANGES[key];
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Throw unless a setting is true or false; a "true" in quotes is said to be text. */
function onOff(settings, key) {
    const value = settings?.[key];
    if (typeof value === 'boolean') return value;
    const text = quoted(value, QUOTED_SWITCH);
    throw new SettingError(key, `${named(key)} must be true or false${text ? ', written without quotes' : ''} (it is ${shown(value)}${text ? ', which is text' : ''})`);
}

/** Throw unless a setting is a whole number in its range (RANGES); a number in quotes is said to be text. */
function wholeNumber(settings, key, unit = '') {
    const value = settings?.[key];
    const [min, max] = RANGES[key];
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    const text = quoted(value, QUOTED_NUMBER);
    throw new SettingError(key, `${named(key)} must be a whole number${unit ? ` of ${unit}` : ''} from ${min} to ${max}${text ? ', written without quotes' : ''} (it is ${shown(value)}${text ? ', which is text' : ''})`);
}

/** Throw unless a setting is one of its choices, named as the settings form names them. */
function oneOf(settings, key, choices) {
    const value = settings?.[key];
    if (typeof value === 'string' && Object.hasOwn(choices, value)) return value;
    const words = Object.entries(choices).map(([c, word]) => `${word} (${c})`);
    throw new SettingError(key, `${named(key)} must be ${words.slice(0, -1).join(', ')} or ${words.at(-1)} (it is ${shown(value)})`);
}

/**
 * The vault folder a setting names, as a full path: `~/` is the home
 * folder; '' when none is set. Never throws; `undefined` when the value is
 * not a path at all (checkConfig says why).
 * @param {unknown} value
 * @param {string} [home]
 */
export function vaultPath(value, home = homedir()) {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (text === '') return '';
    if (/[\0\r\n]/.test(text)) return undefined;
    const expanded = text === '~' ? home : text.startsWith('~/') ? join(home, text.slice(2)) : text;
    if (!isAbsolute(expanded)) return undefined;
    return resolve(normalize(expanded));
}

/**
 * A session's folder as the page's try-out takes it, the way a turn's
 * session has it: a full path, or one starting with ~/ (the home folder);
 * '' for none. Undefined for anything else: a folder that is not a full
 * path names no place.
 * @param {unknown} value
 * @param {string} [home]
 */
export function sessionFolder(value, home = homedir()) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > 1000) return undefined;
    return vaultPath(value, home);
}

/** A path as a person reads it: the home folder as ~. */
export function displayPath(path, home = homedir()) {
    if (typeof path !== 'string' || path === '') return '';
    if (path === home) return '~';
    return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/**
 * A folder inside the vault, as a setting names it: '' (the vault's top
 * level) when `optional`, else segments of letters, digits, spaces and
 * - _ . ( ), joined by /, none hidden (starting with a dot) and none `..`.
 * Gives the cleaned relative path, or undefined.
 */
export function folderIn(value, { optional = false } = {}) {
    if (typeof value !== 'string') return undefined;
    const text = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (text === '') return optional ? '' : undefined;
    if (text.length > 200) return undefined;
    const parts = text.split('/');
    if (parts.some((p) => p === '' || p.startsWith('.') || !/^[\p{L}\p{N} _().,'&+-]+$/u.test(p) || p.trim() !== p)) return undefined;
    return parts.join('/');
}

/** Whether `inner` is `outer` or a folder inside it (both full paths). */
export const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);

/**
 * Check the settings and say what is wrong in words (a SettingError naming
 * the setting).
 * @param {object} settings
 * @param {{ home?: string, dshHome?: string }} [env] - the home folder, and DSH's data folder (Canon never reads or
 *   writes there).
 */
export function checkConfig(settings, { home = homedir(), dshHome } = {}) {
    onOff(settings, 'enabled');
    const raw = settings?.vault;
    const vault = vaultPath(raw, home);
    if (vault === undefined) {
        throw new SettingError('vault', `${named('vault')} must be the full path of your Obsidian vault's folder, such as ~/Obsidian/Canon or /Users/you/Canon (it is ${shown(raw)})`);
    }
    if (vault !== '') {
        if (vault === sep || vault === resolve(home)) {
            throw new SettingError('vault', `${named('vault')} must be the vault's own folder, not ${vault === sep ? 'the whole disk' : 'your home folder'} (it is ${shown(raw)})`);
        }
        if (dshHome) {
            const data = resolve(dshHome);
            if (within(vault, data)) throw new SettingError('vault', `${named('vault')} must not be in DSH's data folder (${displayPath(data, home)}): Canon never reads or writes there (it is ${shown(raw)})`);
            if (within(data, vault)) throw new SettingError('vault', `${named('vault')} must not hold DSH's data folder (${displayPath(data, home)}): choose the vault's own folder (it is ${shown(raw)})`);
        }
    }
    oneOf(settings, 'access', ACCESS_CHOICES);
    const drafts = folderIn(settings?.draftsFolder);
    if (drafts === undefined) {
        throw new SettingError('draftsFolder', `${named('draftsFolder')} must be a folder inside the vault, such as Drafts or Canon/Drafts: letters, digits and spaces, no part starting with a dot, no .. (it is ${shown(settings?.draftsFolder)})`);
    }
    onOff(settings, 'promote');
    const target = folderIn(settings?.promoteFolder, { optional: true });
    if (target === undefined) {
        throw new SettingError('promoteFolder', `${named('promoteFolder')} must be empty (the vault's top level) or a folder inside the vault, such as Notes: letters, digits and spaces, no part starting with a dot, no .. (it is ${shown(settings?.promoteFolder)})`);
    }
    const lower = (p) => p.toLowerCase();
    if (target !== '' && (lower(target) === lower(drafts) || lower(target).startsWith(`${lower(drafts)}/`))) {
        throw new SettingError('promoteFolder', `${named('promoteFolder')} must be outside the drafts folder (${drafts}): notes there are never added to turns (it is ${shown(settings?.promoteFolder)})`);
    }
    onOff(settings, 'recall');
    wholeNumber(settings, 'maxNotes');
    wholeNumber(settings, 'maxChars', 'characters');
}

/** The settings a change touched, by their titles in quotes, from DSH's changed paths. */
export function changedWords(paths) {
    return changedTitles(paths, SETTING_TITLES);
}

/**
 * After the settings changed (a save in Plugins, or an edit of DSH's
 * profile): check again, and the log entry that says what changed, or
 * undefined when nothing did.
 */
export function savedEntry(check, paths) {
    const entry = changedEntry(check, paths, { name: 'Canon', titles: SETTING_TITLES });
    // A switch, a number or a choice is said with its new value: “Add notes to turns” off, “What Canon may write” to
    // “Drafts”; a setting that is wrong, without one (the why says what is wrong with it).
    const keys = [...new Set((Array.isArray(paths) ? paths : []).map((path) => (Array.isArray(path) ? path[0] : path)).filter((key) => typeof key === 'string'))];
    const said = (wrong) => keys.map((key) => {
        const value = wrong.has(key) ? undefined : valueWords(key, check.settings?.[key]);
        return `“${SETTING_TITLES[key] ?? key}”${value === undefined ? '' : ` ${value}`}`;
    }).join(', ');
    if (entry?.state === 'waiting on a setting') {
        // Every wrong setting, not only the first; a right one saved meanwhile, with its new value.
        const also = alsoWrong(check);
        const text = entry.text.startsWith('Settings changed: ') ? `Settings changed: ${said(new Set([check.problem?.key, ...also.map((p) => p.key)]))}; Canon waits until a wrong one is fixed` : entry.text;
        return { ...entry, text, ...(also.length ? { why: `${entry.why} ${also.length === 1 ? 'Also wrong:' : `${also.length} more are wrong:`} ${also.map((p) => `${p.text}.`).join(' ')}` } : {}) };
    }
    if (entry?.state !== 'done' || !entry.text.startsWith('Settings changed: ')) return entry;
    return { ...entry, text: `Settings changed: ${said(new Set())}` };
}

/** A setting's value in What happened's words: a switch on or off, a number, a choice's name; undefined for others. */
function valueWords(key, value) {
    if (SWITCHES.includes(key) && typeof value === 'boolean') return value ? 'on' : 'off';
    if (Object.hasOwn(RANGES, key) && Number.isInteger(value)) return `to ${value.toLocaleString('en-US')}`;
    if (key === 'access' && typeof value === 'string' && Object.hasOwn(ACCESS_CHOICES, value)) return `to “${ACCESS_CHOICES[value]}”`;
    return undefined;
}

/**
 * The wrong settings after the first one a check found, in its order and
 * words: each one found is set aside (its default in its place) and the
 * rest checked again. Empty when only one is wrong.
 * @param {import('./shared/settings.js').SettingsCheck} check
 * @returns {{ key: string, text: string }[]}
 */
export function alsoWrong(check) {
    const first = check?.problem?.key;
    if (typeof first !== 'string' || !Object.hasOwn(DEFAULTS, first) || typeof check.checkFn !== 'function') return [];
    const out = [];
    const seen = new Set([first]);
    let rest = { ...check.settings, [first]: DEFAULTS[first] };
    for (let i = 0; i < Object.keys(DEFAULTS).length; i += 1) {
        try {
            check.checkFn(rest);
            break;
        } catch (error) {
            const key = error?.key;
            if (typeof key !== 'string' || seen.has(key) || !Object.hasOwn(DEFAULTS, key)) break;
            seen.add(key);
            out.push({ key, text: String(error.message) });
            rest = { ...rest, [key]: DEFAULTS[key] };
        }
    }
    return out;
}

/**
 * The settings as Canon uses them (only while every value is right): the
 * vault's full path, its folders, and what it may do.
 * @param {object} settings - from liveSettings.
 * @param {string} [home]
 */
export function resolved(settings, home = homedir()) {
    return {
        vault: vaultPath(settings.vault, home) || '',
        draftsFolder: folderIn(settings.draftsFolder) ?? DEFAULTS.draftsFolder,
        promoteFolder: folderIn(settings.promoteFolder, { optional: true }) ?? '',
        access: settings.access === 'drafts' ? 'drafts' : 'read-only',
        promote: settings.promote === true,
        recall: settings.recall !== false,
        maxNotes: Number.isInteger(settings.maxNotes) ? settings.maxNotes : DEFAULTS.maxNotes,
        maxChars: Number.isInteger(settings.maxChars) ? settings.maxChars : DEFAULTS.maxChars,
    };
}
