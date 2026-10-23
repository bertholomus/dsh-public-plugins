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
    verifierMinutes: 15,
    verifierPerHour: 12,
});

/** The longest a check may be given, in minutes: a busy shared gateway can take half an hour to answer a short check. */
export const MAX_MINUTES = 60;

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
    return changedEntry(check, paths, { name: 'Proof', titles: SETTING_TITLES });
}
