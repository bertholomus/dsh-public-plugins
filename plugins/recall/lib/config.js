/**
 * Recall's settings in words: their titles, which ones its page in Plugins
 * can change while it runs, what each must be, and the folders they name.
 * No DSH packages here, so the checks run in plain unit tests too.
 *
 * A wrong value never stops Recall from starting, whatever its type: it
 * searches nothing, and its page and its log say which setting is wrong,
 * what it must be, and where to change it. A folder that is not there is
 * not a wrong setting (a disk may be unplugged): its status on the page
 * says so.
 *
 * @module dsh-plugin-recall/config
 */
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { SettingError, changedEntry, changedTitles } from './shared/settings.js';

/** The settings, in the words the page, the settings form and the errors use. */
export const SETTING_TITLES = Object.freeze({
    enabled: 'Recall on',
    sessions: 'Search this DSH\'s sessions',
    sessionFolders: 'More DSH session folders',
    transcriptFolders: 'Coding-agent transcript folders',
    handoffFolders: 'Handoff note folders',
    tool: 'Let agents search past work',
});

/** The settings its page in Plugins can change while it runs. */
export const LIVE_SETTINGS = Object.freeze(['sessions', 'sessionFolders', 'transcriptFolders', 'handoffFolders', 'tool']);

/** What Recall uses when the profile sets nothing (the defaults in lib/index.js Config). */
export const DEFAULTS = Object.freeze({
    enabled: true,
    sessions: true,
    sessionFolders: [],
    transcriptFolders: [],
    handoffFolders: [],
    tool: true,
});

/** The folder lists, and the kind of file each holds. */
export const FOLDER_SETTINGS = Object.freeze({ sessionFolders: 'session', transcriptFolders: 'transcript', handoffFolders: 'handoff' });

/** The most folders one list takes. */
export const MAX_FOLDERS = 20;

/** Text of at most `max` characters, cut in the middle (a long path keeps its start and its last folder). */
const cutMiddle = (text, max) => (text.length <= max ? text : `${text.slice(0, Math.ceil(max / 2) - 1)}…${text.slice(text.length - Math.floor(max / 2))}`);

/** A value as the profile writes it (text in quotes), cut in the middle past 120 characters; "empty" when there is none. */
const shown = (value) => {
    if (value === undefined || value === null) return 'empty';
    if (typeof value === 'string') return JSON.stringify(cutMiddle(value, 118));
    let text;
    try { text = JSON.stringify(value); } catch { text = String(value); }
    return cutMiddle(String(text), 120);
};

/** What kind of value a wrong one is, in words, after it is shown ("1, a number"); '' when showing it says enough. */
const kindOf = (value) => {
    if (typeof value === 'string') return value.trim() === '' ? ', which is empty text' : ', which is text';
    if (typeof value === 'number') return ', a number';
    if (Array.isArray(value)) return ', a list';
    if (value !== null && typeof value === 'object') return ', a group of named values';
    return '';
};

/** A setting as the person reads it: its title, then its name in the profile. */
const named = (key) => `${SETTING_TITLES[key]} (${key})`;

/** A path as a person reads it: the home folder as ~. */
export function tildePath(path, home = homedir()) {
    if (typeof path !== 'string' || path === '') return '';
    if (path === home) return '~';
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A folder as written ("~/notes", "/Users/me/notes/"), made absolute; undefined when it cannot be one. */
export function expandFolder(text, home = homedir()) {
    if (typeof text !== 'string') return undefined;
    const t = text.trim();
    if (!t || t.length > 1000 || t.includes('\0')) return undefined;
    const full = t === '~' ? home : t.startsWith('~/') ? join(home, t.slice(2)) : t;
    if (!isAbsolute(full)) return undefined;
    const clean = normalize(full);
    return clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
}

/**
 * Throw unless `settings[key]` is true or false. A switch written in quotes
 * ("true", "yes", "1") is text in the profile, so the words say how to
 * write it instead.
 */
function onOff(settings, key) {
    const value = settings?.[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') throw new SettingError(key, `${named(key)} must be true or false, written without quotes (it is ${shown(value)}${kindOf(value)})`);
    throw new SettingError(key, `${named(key)} must be true or false (it is ${shown(value)}${kindOf(value)})`);
}

/**
 * Throw unless `settings[key]` is a list of folders. One folder written
 * without the brackets is text in the profile, so the words show it in a
 * list, as it must be written.
 */
function folderList(settings, key) {
    const value = settings?.[key];
    const title = named(key);
    if (!Array.isArray(value)) {
        const text = typeof value === 'string' ? value.trim() : undefined;
        if (text && expandFolder(text) !== undefined) {
            const example = text.length <= 100 ? JSON.stringify([text]) : '["~/notes"]';
            throw new SettingError(key, `${title} must be a list of folders in square brackets, such as ${example} (it is ${shown(value)}, one folder without the brackets)`);
        }
        if (text) throw new SettingError(key, `${title} must be a list of folders in square brackets, such as ["~/notes"] (it is ${shown(value)}, which is text, not a list)`);
        throw new SettingError(key, `${title} must be a list of folders in square brackets, such as ["~/notes"], or [] for none (it is ${shown(value)}${kindOf(value)})`);
    }
    if (value.length > MAX_FOLDERS) throw new SettingError(key, `${title} may list at most ${MAX_FOLDERS} folders (it lists ${value.length})`);
    for (const folder of value) {
        if (typeof folder !== 'string') {
            const kind = kindOf(folder).replace(/^, (?:which is )?/, '');
            throw new SettingError(key, `${title} must list folders by their full path or a path from ~/, such as ~/notes (${shown(folder)} is ${kind ? `${kind}, ` : ''}not a folder)`);
        }
        if (expandFolder(folder) === undefined) {
            throw new SettingError(key, `${title} must list folders by their full path or a path from ~/, such as ~/notes (${shown(folder)} is not one)`);
        }
    }
    return value;
}

/**
 * Check the settings and say what is wrong in words (a SettingError naming
 * the setting): the first wrong one in the order its page lists them, and
 * the names of any others, so one look shows everything to fix. Every value
 * reaches this check: the Config takes any value, so a wrong type is named
 * here like a wrong range, and never stops Recall from starting.
 */
export function checkConfig(settings) {
    const checks = [
        () => onOff(settings, 'enabled'),
        () => onOff(settings, 'sessions'),
        ...Object.keys(FOLDER_SETTINGS).map((key) => () => folderList(settings, key)),
        () => onOff(settings, 'tool'),
    ];
    const wrong = [];
    for (const check of checks) {
        try {
            check();
        } catch (error) {
            if (!(error instanceof SettingError)) throw error;
            wrong.push(error);
        }
    }
    if (wrong.length === 0) return;
    const [first, ...more] = wrong;
    if (more.length === 0) throw first;
    // The others by name only: the first says what fits, and each says it in turn once the one before is fixed.
    // DSH's word for a problem is cut at 400 characters, so after a long first one they are only counted.
    const names = more.length <= 2 ? more.map((e) => named(e.key)) : [named(more[0].key), `${more.length - 1} more`];
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const also = `; ${list} ${more.length === 1 ? 'is' : 'are'} wrong too`;
    const counted = `; ${more.length} more ${more.length === 1 ? 'setting is' : 'settings are'} wrong too`;
    throw new SettingError(first.key, `${first.message}${first.message.length + also.length <= 400 ? also : counted}`);
}

/** Whether Recall keeps an index at all: only when `enabled` is true (DSH fills in true when the profile sets nothing); a wrong value keeps it idle until it is fixed. */
export const indexing = (settings) => settings?.enabled === true;

/**
 * The folders Recall searches, from its settings: this DSH's sessions
 * (when on), then each list's folders, made absolute. The same folder twice
 * counts once, and a folder inside another of the same kind is left out
 * (the outer one holds it), with why in `left`.
 * @param {object} settings
 * @param {{ sessionsDir: string, home?: string }} where - this DSH's sessions folder.
 * @returns {{ sources: { kind: string, root: string, own: boolean }[], left: { kind: string, root: string, why: string }[] }}
 */
export function sourcesOf(settings, { sessionsDir, home = homedir() }) {
    const sources = [];
    const left = [];
    if (settings?.sessions !== false && sessionsDir) sources.push({ kind: 'session', root: sessionsDir, own: true });
    const own = sessionsDir ? normalize(sessionsDir) : '';
    for (const [key, kind] of Object.entries(FOLDER_SETTINGS)) {
        const list = Array.isArray(settings?.[key]) ? settings[key] : [];
        for (const raw of list) {
            const root = expandFolder(raw, home);
            if (!root) continue;
            if (kind === 'session' && (root === own || join(root, 'sessions') === own)) {
                left.push({ kind, root, why: settings?.sessions === false ? 'This is this DSH\'s own sessions folder: switch on "Search this DSH\'s sessions" instead.' : 'This is this DSH\'s own sessions folder, already searched.' });
                continue;
            }
            const same = sources.find((s) => s.kind === kind && (s.root === root || root.startsWith(`${s.root}/`)));
            if (same) {
                left.push({ kind, root, why: same.root === root ? 'Listed twice.' : `Inside ${tildePath(same.root, home)}, which is already searched.` });
                continue;
            }
            // An outer folder listed after an inner one: the outer one holds it.
            for (let i = sources.length - 1; i >= 0; i -= 1) {
                const s = sources[i];
                if (s.kind === kind && !s.own && s.root.startsWith(`${root}/`)) {
                    left.push({ kind, root: s.root, why: `Inside ${tildePath(root, home)}, which is already searched.` });
                    sources.splice(i, 1);
                }
            }
            sources.push({ kind, root, own: false });
        }
    }
    return { sources, left };
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
    return changedEntry(check, paths, { name: 'Recall', titles: SETTING_TITLES });
}
