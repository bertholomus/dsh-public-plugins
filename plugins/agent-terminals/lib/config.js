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

/** A value as JSON keeps it (a wrong type too), to compare with the next start's. */
function plain(value) {
    if (value === undefined) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

/**
 * The settings as they apply now, kept in state.json: at the next start
 * they tell what an edit of DSH's profile changed in between.
 */
export function settingsSnapshot(settings) {
    return Object.fromEntries(Object.keys(SETTING_TITLES).map((key) => [key, plain(settings?.[key])]));
}

/** The settings whose values differ from the ones Agent Terminals last ran with (none when it never ran here). */
export function changedSince(before, now) {
    if (!before || typeof before !== 'object' || Array.isArray(before)) return [];
    return Object.keys(SETTING_TITLES).filter((key) => key in before && JSON.stringify(before[key]) !== JSON.stringify(now?.[key]));
}

/**
 * At a start: the log entry for the settings an edit of DSH's profile
 * changed since Agent Terminals last ran (DSH applies the file when it is
 * saved, starting Agent Terminals again with it, or a DSH that starts reads
 * it), or undefined when none changed. A save in Plugins is logged by
 * `savedEntry` as it happens.
 * @param {import('./shared/settings.js').SettingsCheck} check - run already.
 * @param {string[]} keys - from `changedSince`.
 * @param {object} settings - as they apply now.
 */
export function profileEntry(check, keys, settings) {
    if (!keys.length) return undefined;
    const words = keys.map((key) => `“${SETTING_TITLES[key] ?? key}”`).join(', ');
    if (!check.ok) return { kind: 'settings', text: `Settings changed in DSH's profile: ${words}; Agent Terminals waits until a wrong one is fixed`, why: `${check.problem.text}.`, state: 'waiting on a setting' };
    if (settings?.enabled === false) return { kind: 'settings', text: `Settings changed in DSH's profile: ${words}`, why: 'Agent Terminals is switched off there (enabled: false): it starts, reads and types nothing.', state: 'done' };
    return { kind: 'settings', text: `Settings changed in DSH's profile: ${words}`, why: 'Agent Terminals started again with them.', state: 'done' };
}

// ── Following its agents, and why it stops or starts ────────────────────

/** cordis's states of a plugin's part: running (FiberState.ACTIVE) and being stopped (FiberState.UNLOADING). */
const ACTIVE = 2;
const UNLOADING = 5;

/**
 * Why Agent Terminals stops following its agents, read from DSH's own state
 * as it stops: `own` is its plugin's part in DSH (cordis's fiber, with the
 * profile's entry for it), `watchScope` the part that runs while Session
 * Watch does, and `config` the settings it was started with.
 *
 * - `off`: switched off (the Plugins switch writes `disabled: true` in the profile);
 * - `profile`: its settings changed in DSH's profile, so DSH starts it again with them;
 * - `quit`: DSH quits (the whole profile stops);
 * - `removed`: its entry left DSH's profile;
 * - `again`: DSH starts it again with the same settings;
 * - `watch`: Session Watch stopped;
 * - `terminals`: DSH's terminals stopped;
 * - `unknown`: DSH does not say.
 */
export function stopCause({ own, watchScope, config } = {}) {
    try {
        const going = (fiber) => fiber.uid === null || fiber.state === UNLOADING;
        if (own && typeof own.state === 'number' && own.state !== ACTIVE) {
            if (own.entry?.disabled === true) return 'off';
            if (own.uid !== null && own.uid !== undefined) return own.config !== config ? 'profile' : 'again';
            // Its part is gone for good: with the parts above it (DSH quits), or alone (its entry left the profile).
            for (let up = own.parent?.fiber, hops = 0; up && up !== own && hops < 64; up = up.parent?.fiber, hops += 1) {
                if (going(up)) return 'quit';
                if (up.uid === 0) break;
            }
            return 'removed';
        }
        if (own && watchScope && typeof watchScope.state === 'number') return watchScope.state !== ACTIVE ? 'watch' : 'terminals';
    } catch {
        // DSH's parts said nothing readable: the plain words below.
    }
    return 'unknown';
}

/** The why of "Agent Terminals stopped following its agents", by cause. */
export const STOP_WHYS = Object.freeze({
    off: 'It was switched off. While DSH runs, the agents keep running in their terminals; switched on again, Agent Terminals picks them up where they are.',
    profile: 'Its settings changed in DSH\'s profile, so DSH starts it again with them. While DSH runs, the agents keep running in their terminals; Agent Terminals picks them up where they are.',
    quit: 'DSH is quitting: its terminals end with it, and so do the agents in them. At DSH\'s next start, Agent Terminals starts again the ones meant to run.',
    removed: 'It was taken out of DSH\'s profile. While DSH runs, the agents keep running in their terminals.',
    again: 'DSH starts it again. While DSH runs, the agents keep running in their terminals; Agent Terminals picks them up where they are.',
    watch: 'Session Watch stopped, and Agent Terminals needs it to follow its agents. While DSH runs, the agents keep running in their terminals; once Session Watch runs again, Agent Terminals picks them up where they are.',
    terminals: 'DSH\'s terminals stopped. Once they run again, Agent Terminals picks its agents up where they are.',
    unknown: 'DSH stopped it. While DSH runs, the agents keep running in their terminals; Agent Terminals picks them up where they are when it starts again.',
});

/**
 * Why Agent Terminals follows its agents (again), from what came before it
 * in this DSH: Session Watch or DSH's terminals there again, or later than
 * Agent Terminals itself (`watchRuns`, `terminalRuns`: how often each part
 * started; `lateSeconds`: how long after Agent Terminals Session Watch
 * came); else the last "stopped following" entry this DSH process logged
 * (`last`, with `pid`); else an earlier start in this DSH process
 * (`ranHere`), with settings the profile changed since (`edited`); else a
 * start with DSH (`uptimeSeconds`: how long DSH has run).
 */
export function startCause({ terminalRuns = 1, watchRuns = 1, lateSeconds = 0, last, pid, ranHere = false, edited = false, uptimeSeconds = 0 } = {}) {
    if (terminalRuns > 1) return 'terminals';
    if (watchRuns > 1 || lateSeconds > 15) return 'watch';
    if (last && last.pid === pid && last.state === 'stopped') {
        if (last.cause === 'off') return 'on';
        if (last.cause === 'profile' || last.cause === 'watch' || last.cause === 'terminals') return last.cause;
    }
    if (ranHere) return edited ? 'profile' : 'again';
    return uptimeSeconds < 120 ? 'dsh' : 'on';
}

/** The why of "Agent Terminals follows its agents", by cause. */
export const START_WHYS = Object.freeze({
    dsh: 'It started with DSH: it picks up every agent where it is.',
    on: 'It was switched on: it picks up every agent where it is.',
    profile: 'DSH started it again with the settings in its profile: it picks up every agent where it is.',
    watch: 'Session Watch is running now: it picks up every agent where it is.',
    terminals: 'DSH\'s terminals are running now: it picks up every agent where it is.',
    again: 'It started again: it picks up every agent where it is.',
});
