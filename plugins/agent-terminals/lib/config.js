/**
 * Agent Terminals' settings in words: their titles, which ones its page in
 * Plugins can change while it runs, what each must be, and what its log
 * says after a save. No DSH packages here, so the checks run in plain unit
 * tests too.
 *
 * A wrong value never stops Agent Terminals from starting: it starts no
 * agent and types nothing, and its page says which setting is wrong, what
 * it must be, and where to change it.
 *
 * @module dsh-plugin-agent-terminals/config
 */
import { changedEntry, changedTitles, oneOf, onOff, wholeNumber } from './shared/settings.js';

/** The settings, in the words the page, the settings form and the errors use. */
export const SETTING_TITLES = Object.freeze({
    enabled: 'Agent Terminals on',
    resumeAfterRestart: 'Start agents again after DSH restarts',
    listNewSessions: 'List a new agent\'s session in the sidebar',
    openTabs: 'Open an agent\'s terminal tab with its session',
    typeWhileWorking: 'Type messages in while the agent works',
    proofSeconds: 'Seconds without proof before Enter is pressed again',
    enterRetries: 'Press Enter again, at most',
    askAfterSeconds: 'Seconds before a waiting tool call counts as asking you',
    notify: 'A notification when an agent waits on you',
    typing: 'How messages are typed in',
});

/** The settings its page in Plugins can change while it runs. */
export const LIVE_SETTINGS = Object.freeze(['resumeAfterRestart', 'listNewSessions', 'openTabs', 'typeWhileWorking', 'proofSeconds', 'enterRetries', 'askAfterSeconds', 'notify']);

/** The ways a message can be typed in (lib/typist.js). */
export const TYPING = Object.freeze(['auto', 'direct', 'attached']);

/** What Agent Terminals uses when the profile sets nothing (the defaults in lib/index.js Config). */
export const DEFAULTS = Object.freeze({
    enabled: true,
    resumeAfterRestart: true,
    listNewSessions: true,
    openTabs: true,
    typeWhileWorking: false,
    proofSeconds: 8,
    enterRetries: 2,
    askAfterSeconds: 20,
    notify: true,
    typing: 'auto',
});

/** Check the settings and say what is wrong in words (a SettingError naming the setting). */
export function checkConfig(settings) {
    const t = SETTING_TITLES;
    for (const key of ['enabled', 'resumeAfterRestart', 'listNewSessions', 'openTabs', 'typeWhileWorking', 'notify']) onOff(settings, key, t[key]);
    wholeNumber(settings, 'proofSeconds', 2, 120, 'seconds', t.proofSeconds);
    wholeNumber(settings, 'enterRetries', 0, 5, '', t.enterRetries);
    wholeNumber(settings, 'askAfterSeconds', 5, 600, 'seconds', t.askAfterSeconds);
    oneOf(settings, 'typing', TYPING, t.typing);
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
    return changedEntry(check, paths, { name: 'Agent Terminals', titles: SETTING_TITLES });
}
