/**
 * dsh-plugin-notifications, its settings in words. No DSH packages here, so
 * the checks run in plain unit tests too.
 *
 * A wrong value never stops the plugin: each setting that is not on or off
 * falls back to its default, the log says so, and the settings page names
 * the setting, what it must be and what it is.
 *
 * Every setting is a live field: DSH serves a plugin's page in Plugins only
 * for live fields, hands each to the plugin as a reference whose value
 * changes in place when the person saves (`valueOf` reads it), and says so
 * with `loader/volatile-update`. So a save applies at once, with no restart.
 *
 * @module dsh-plugin-notifications/config
 */

/** The settings, in the words the settings page uses. */
export const TITLES = Object.freeze({
    enabled: 'Send system notifications',
    notifyHandback: 'Handbacks',
    notifyFinished: 'Ended without a handback',
    notifyApproval: 'Waiting for approval',
    notifyFailed: 'Failed after a nudge',
    notifyStopped: 'Stopped after a nudge',
    notifyFleet: 'Fleet findings',
});

/** Every setting is a switch, on unless the profile says otherwise. */
export const DEFAULTS = Object.freeze(Object.fromEntries(Object.keys(TITLES).map((key) => [key, true])));

const shown = (value) => {
    if (value === undefined) return 'empty';
    try { return JSON.stringify(value).slice(0, 80); } catch { return String(value).slice(0, 80); }
};

/** A setting's value now: a live field's reference (`{ get() }`) read, a plain value as it is. */
export const valueOf = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value);

/** The config DSH passed, with each live field read as it is now. */
export function readConfig(config) {
    const given = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
    return Object.fromEntries(Object.keys(given).map((key) => [key, valueOf(given[key])]));
}

/**
 * The settings a change touched, from DSH's changed paths (`[['notifyFleet'], …]`),
 * each by its title with its new value: `“Fleet findings” off`. A value that
 * is not on or off says what it counts as; a key that is not a setting is
 * named as it is.
 * @param {unknown} paths - DSH's changed paths.
 * @param {{ settings?: Record<string, boolean>, problems?: { key: string }[] }} [checked] - checkSettings' answer after the change.
 */
export function changedWords(paths, checked = {}) {
    const keys = [...new Set((Array.isArray(paths) ? paths : []).map((path) => (Array.isArray(path) ? path[0] : path)).filter((key) => typeof key === 'string'))];
    const wrong = new Set((checked.problems ?? []).map((problem) => problem.key));
    return keys.map((key) => {
        if (!TITLES[key]) return `“${key}” (not a setting)`;
        const value = checked.settings?.[key];
        const state = typeof value === 'boolean' ? (value ? 'on' : 'off') : '';
        return `“${TITLES[key]}”${state ? ` ${wrong.has(key) ? `(not true or false, so ${state})` : state}` : ''}`;
    }).join(', ');
}

/** How many single-letter edits turn one word into another (for "did you mean"). */
function distance(a, b) {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    let row = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i += 1) {
        const next = [i];
        for (let j = 1; j <= y.length; j += 1) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        row = next;
    }
    return row[y.length];
}

/** The setting a misspelt key most likely meant, or undefined when none is close. */
export function nearestKey(key) {
    let best;
    for (const name of Object.keys(TITLES)) {
        const d = distance(key, name);
        if (d <= Math.max(2, Math.floor(name.length / 4)) && (!best || d < best.d)) best = { name, d };
    }
    return best?.name;
}

/**
 * The settings to use, and what is wrong with the ones given. Each problem
 * has `text` (what is wrong, by the setting's title: the page shows it),
 * `fix` (what to do, with the key as the profile spells it) and `log` (both,
 * for the log file).
 * @param {object} raw - the config DSH passed (any shape).
 * @returns {{ settings: Record<string, boolean>, problems: { key: string, text: string, fix: string, log: string }[] }}
 */
export function checkSettings(raw) {
    const given = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const settings = {};
    const problems = [];
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
        const value = given[key];
        if (value === undefined || typeof value === 'boolean') {
            settings[key] = value ?? fallback;
            continue;
        }
        settings[key] = fallback;
        const text = `“${TITLES[key]}” must be true or false, but it is ${shown(value)}; it counts as ${fallback ? 'on' : 'off'} until you change it`;
        problems.push({ key, text, fix: `Set it with its switch above and save (in the profile its key is ${key}).`, log: `“${TITLES[key]}” (${key}) must be true or false, but it is ${shown(value)}; it counts as ${fallback ? 'on' : 'off'} until you change it` });
    }
    // A key that is not a setting does nothing: name it, and the setting it most likely meant.
    for (const key of Object.keys(given)) {
        if (key in DEFAULTS) continue;
        const meant = nearestKey(key);
        const text = `“${key.slice(0, 60)}” is not a setting of this plugin, so it does nothing${meant ? `; did you mean “${TITLES[meant]}”?` : ''}`;
        problems.push({ key, text, fix: meant ? `Rename it to ${meant} in the profile's notifications row, or remove it.` : 'Remove it from the profile\'s notifications row.', log: `${key.slice(0, 60)} is not a setting of this plugin, so it does nothing${meant ? ` (did you mean ${meant}, “${TITLES[meant]}”?)` : ''}` });
    }
    return { settings, problems };
}
