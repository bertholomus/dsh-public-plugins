/**
 * Proof's settings in words: their titles, which ones its page in Plugins
 * can change while it runs, what each must be, and what its log says after
 * a save. No DSH packages here, so the checks run in plain unit tests too.
 *
 * A wrong value never stops Proof from starting: it flags and checks
 * nothing, and its page says which setting is wrong, what it must be, and
 * where to change it.
 *
 * @module dsh-plugin-proof/config
 */
import { SettingError, changedEntry, changedTitles, oneOf, onOff, wholeNumber } from './shared/settings.js';

/** The settings, in the words the page, the settings form and the errors use. */
export const SETTING_TITLES = Object.freeze({
    enabled: 'Proof on',
    flags: 'Flag claims with no evidence on their turn',
    verifier: 'Independent check',
    verifierProvider: 'Check with the model from',
    verifierModel: 'Check with the model',
    verifierMinutes: 'Minutes a check may take',
    verifierPerHour: 'Checks an hour, at most',
});

/** The settings its page in Plugins can change while it runs. */
export const LIVE_SETTINGS = Object.freeze(['flags', 'verifier', 'verifierProvider', 'verifierModel', 'verifierMinutes', 'verifierPerHour']);

/** How the independent check runs: never, when you press Check, or by itself for each flagged claim. */
export const VERIFIER_CHOICES = Object.freeze({ off: 'Off', ask: 'When I press Check', auto: 'By itself' });

/** What Proof uses when the profile sets nothing (the defaults in lib/index.js Config). */
export const DEFAULTS = Object.freeze({
    enabled: true,
    flags: true,
    verifier: 'ask',
    verifierProvider: 'local-gateway',
    verifierModel: 'glm-5.3-flash',
    verifierMinutes: 45,
    verifierPerHour: 12,
});

/**
 * The longest a check may be given, in minutes. A busy shared gateway can take half an hour to answer a short check
 * (one given 60 minutes answered at 30 min 11 s, while two given 30 ran out), so the default is 45 and the form's
 * advice is to allow 60 when the gateway is busy.
 */
export const MAX_MINUTES = 60;

/** What the settings form says under "Minutes a check may take". */
export const MINUTES_ADVICE = 'A busy shared gateway can take half an hour to answer one check: allow 60 then.';

/** A provider or model name as DSH routes it: one line of letters, digits and . _ - : / @ +. */
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;

function routeName(settings, key, title, example) {
    const value = settings?.[key];
    if (typeof value === 'string' && ROUTE.test(value)) return value;
    throw new SettingError(key, `${title} (${key}) must be a name as DSH's model list shows it, such as ${example} (it is ${value === undefined ? 'empty' : JSON.stringify(value).slice(0, 120)})`);
}

/** Check the settings and say what is wrong in words (a SettingError naming the setting). */
export function checkConfig(settings) {
    const t = SETTING_TITLES;
    onOff(settings, 'enabled', t.enabled);
    onOff(settings, 'flags', t.flags);
    oneOf(settings, 'verifier', VERIFIER_CHOICES, t.verifier);
    routeName(settings, 'verifierProvider', t.verifierProvider, 'local-gateway');
    routeName(settings, 'verifierModel', t.verifierModel, 'glm-5.3-flash');
    wholeNumber(settings, 'verifierMinutes', 1, MAX_MINUTES, 'minutes', t.verifierMinutes);
    wholeNumber(settings, 'verifierPerHour', 1, 120, '', t.verifierPerHour);
}

/** The live settings that are true or false, and the whole numbers with their ranges. */
const SWITCHES = Object.freeze(['flags']);
const RANGES = Object.freeze({ verifierMinutes: [1, MAX_MINUTES], verifierPerHour: [1, 120] });
const QUOTED_NUMBER = /^[+-]?\d+$/;
const QUOTED_SWITCH = /^(?:true|false)$/i;

/**
 * What a setting written in quotes would be without them, when that is right
 * for it: "45" for Minutes a check may take is 45; "false" for the flags is
 * false. Undefined for anything else (another type, a number out of range,
 * a setting that is not a number or a switch): the page offers to save the
 * value without quotes only then.
 * @param {object} settings
 * @param {string} key
 * @returns {number | boolean | undefined}
 */
export function unquoted(settings, key) {
    const value = settings?.[key];
    if (typeof value !== 'string' || !LIVE_SETTINGS.includes(key)) return undefined;
    const text = value.trim();
    if (SWITCHES.includes(key)) return QUOTED_SWITCH.test(text) ? text.toLowerCase() === 'true' : undefined;
    if (!Object.hasOwn(RANGES, key) || !QUOTED_NUMBER.test(text)) return undefined;
    const n = Number(text);
    const [min, max] = RANGES[key];
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** A setting's value as the log says it: the form's words for a choice, text in quotes, the rest as it is. */
function valueWords(key, value) {
    if (value === undefined) return 'unset';
    if (key === 'verifier' && typeof value === 'string' && Object.hasOwn(VERIFIER_CHOICES, value)) return VERIFIER_CHOICES[value];
    if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 59)}…` : value);
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** The live settings now, to say what the next change was. */
export function liveValues(settings) {
    return Object.fromEntries(LIVE_SETTINGS.map((key) => [key, settings?.[key]]));
}

/** What each live setting that moved was and is now: "“Minutes a check may take” 15 → 45". */
export function changesOf(before, after) {
    const out = [];
    for (const key of LIVE_SETTINGS) {
        const a = before?.[key];
        const b = after?.[key];
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        out.push(`“${SETTING_TITLES[key]}” ${valueWords(key, a)} → ${valueWords(key, b)}`);
    }
    return out;
}

/** The settings a change touched, by their titles in quotes, from DSH's changed paths. */
export function changedWords(paths) {
    return changedTitles(paths, SETTING_TITLES);
}

/**
 * After the settings changed (a save in Plugins, or an edit of DSH's
 * profile): check again, and the log entry that says what changed (each
 * live setting's value before and after, when `values` gives them), or
 * undefined when nothing did.
 */
export function savedEntry(check, paths, values = {}) {
    const entry = changedEntry(check, paths, { name: 'Proof', titles: SETTING_TITLES });
    // What each change was, where the values before and after are known: "“Minutes a check may take” 15 → 45."
    const changes = values.before && values.after ? changesOf(values.before, values.after) : [];
    if (!entry || changes.length === 0) return entry;
    return { ...entry, why: `${changes.join('; ')}. ${entry.why}` };
}
