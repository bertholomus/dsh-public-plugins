/**
 * Session Watch's settings in words: which ones its page in Plugins can
 * change while it runs, the range each must be in, and what the watcher
 * uses while one is wrong. No DSH packages here, so the checks run in
 * plain unit tests too.
 *
 * @module dsh-plugin-session-watch/config
 */
import { wholeNumber } from './shared/settings.js';

/** The settings its page in Plugins can change while it runs. */
export const LIVE_SETTINGS = Object.freeze(['deliveryTimeoutSeconds']);

/** What the watcher uses when the profile sets nothing, and while a setting is wrong. */
export const DEFAULTS = Object.freeze({ deliveryTimeoutSeconds: 600 });

/** Check the settings and say what is wrong in words (a SettingError naming the setting). */
export function checkConfig(settings) {
    wholeNumber(settings, 'deliveryTimeoutSeconds', 10, 86400, 'seconds', 'How long a message may wait to be read');
}

/**
 * The settings the watcher works with: each as saved while every value is
 * right, the default while one is wrong (every suite plugin needs the
 * watcher, so a wrong value never stops it; its status says which).
 * @param {object} settings - from `liveSettings`.
 * @param {{ ok: boolean }} check
 */
export function usableSettings(settings, check) {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
        Object.defineProperty(out, key, { enumerable: true, get: () => (check.ok ? settings[key] : DEFAULTS[key]) });
    }
    return out;
}
