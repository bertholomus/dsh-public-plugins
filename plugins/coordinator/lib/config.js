/**
 * The plugin's settings, checked in words. A wrong value never stops the
 * plugin: a plugin that fails to start shows only "Problem" in DSH's Plugins
 * page, and every coordinating chat would lose its thread tools over one
 * typo. Instead each wrong setting falls back to its default, and the
 * plugin says which setting is wrong, what it must be and what it uses
 * meanwhile: on its page (Plugins → Coordinator) and in its own log. It
 * warns DSH's logger too, which DSH keeps in memory and does not print.
 *
 * The schema in index.js gives defaults only (any value passes it, the
 * live ones too); the types and ranges live here. Pure, no host imports.
 *
 * @module dsh-plugin-coordinator/config
 */

/**
 * DSH's data folder as the plugin's paths spell it. A path under it lives in
 * $DSH_HOME when that is set, as DSH's own data does (store.js dataPath), so
 * a second DSH with its own DSH_HOME keeps its own store, notes and log.
 */
export const DSH_HOME_DIR = '~/.dsh';

/** The defaults of the settings checked here; index.js's schema gives DSH the same ones (a test holds them equal). */
export const DEFAULTS = Object.freeze({
    enabled: true,
    autoHandback: 'idle',
    maxHandbacksPerHour: 30,
    maxThreadsPerHour: 20,
    approvalNoticeSeconds: 0,
    storeFile: `${DSH_HOME_DIR}/coordinator/coordinator.json`,
    memoryDir: `${DSH_HOME_DIR}/coordinator/memory`,
    maxMemoryBytes: 65536,
    logFile: `${DSH_HOME_DIR}/coordinator/coordinator.log`,
});

/** The ranges of the number settings: [lowest, highest, unit]. */
export const RANGES = Object.freeze({
    maxHandbacksPerHour: [1, 1000, 'handbacks'],
    maxThreadsPerHour: [1, 1000, 'threads'],
    approvalNoticeSeconds: [0, 86400, 'seconds'],
    maxMemoryBytes: [1024, 16 * 1024 * 1024, 'bytes'],
});

/** A value as a person reads it in an error: JSON, cut short. */
function shown(value) {
    if (value === undefined) return 'empty';
    try {
        return JSON.stringify(value).slice(0, 80);
    } catch {
        return String(value).slice(0, 80);
    }
}

/**
 * A setting's problem, in words: what it must be, what it is, and what the plugin does meanwhile
 * (`instead` is what it uses, or with `{ does: true }` what it does, such as "trusts no machine").
 */
const problem = (key, must, value, instead, { does = false } = {}) => ({ key, message: `${key} must be ${must} (it is ${shown(value)}), so the plugin ${does ? instead : `uses ${instead}`} until you fix it.` });

/** Words YAML or a person may use for on and off. */
const ON = new Set(['true', 'on', 'yes', '1']);
const OFF = new Set(['false', 'off', 'no', '0']);

function onOff(key, value, fallback, problems) {
    if (typeof value === 'boolean') return value;
    const word = typeof value === 'string' ? value.trim().toLowerCase() : typeof value === 'number' ? String(value) : undefined;
    if (word !== undefined && ON.has(word)) return true;
    if (word !== undefined && OFF.has(word)) return false;
    problems.push(problem(key, 'true or false', value, String(fallback)));
    return fallback;
}

function wholeNumber(key, value, problems, { whole = true } = {}) {
    const [min, max, unit] = RANGES[key];
    const n = typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
    if ((whole ? Number.isInteger(n) : Number.isFinite(n)) && n >= min && n <= max) return n;
    problems.push(problem(key, `${whole ? 'a whole number' : 'a number'} of ${unit} from ${min} to ${max}`, value, DEFAULTS[key]));
    return DEFAULTS[key];
}

function path(key, value, problems, { optional = false } = {}) {
    if (typeof value === 'string' && (value.trim() !== '' || optional)) return value.trim();
    problems.push(problem(key, optional ? 'a file path, or "" to turn it off' : 'a file or folder path', value, DEFAULTS[key]));
    return DEFAULTS[key];
}

/**
 * The fixed settings checked, with the live ones (read when used: the model
 * and access defaults, guardedTools, trustedHosts) passed on as they are.
 * @param {object} raw - the config DSH passed to apply.
 * @returns {{config: object, problems: {key: string, message: string}[]}}
 */
export function checkConfig(raw) {
    const given = raw !== null && typeof raw === 'object' ? raw : {};
    const problems = [];
    const autoHandback = (() => {
        const value = given.autoHandback ?? DEFAULTS.autoHandback;
        // YAML 1.1 reads a bare `off` as false (and `on` as true).
        if (value === false) return 'off';
        if (value === true) return 'idle';
        const word = typeof value === 'string' ? value.trim().toLowerCase() : value;
        if (word === 'idle' || word === 'off') return word;
        problems.push(problem('autoHandback', '"idle" or "off"', value, `"${DEFAULTS.autoHandback}"`));
        return DEFAULTS.autoHandback;
    })();
    const config = {
        ...given,
        enabled: onOff('enabled', given.enabled ?? DEFAULTS.enabled, DEFAULTS.enabled, problems),
        autoHandback,
        maxHandbacksPerHour: wholeNumber('maxHandbacksPerHour', given.maxHandbacksPerHour ?? DEFAULTS.maxHandbacksPerHour, problems),
        maxThreadsPerHour: wholeNumber('maxThreadsPerHour', given.maxThreadsPerHour ?? DEFAULTS.maxThreadsPerHour, problems),
        approvalNoticeSeconds: wholeNumber('approvalNoticeSeconds', given.approvalNoticeSeconds ?? DEFAULTS.approvalNoticeSeconds, problems, { whole: false }),
        maxMemoryBytes: wholeNumber('maxMemoryBytes', given.maxMemoryBytes ?? DEFAULTS.maxMemoryBytes, problems),
        storeFile: path('storeFile', given.storeFile ?? DEFAULTS.storeFile, problems),
        memoryDir: path('memoryDir', given.memoryDir ?? DEFAULTS.memoryDir, problems),
        logFile: path('logFile', given.logFile ?? DEFAULTS.logFile, problems, { optional: true }),
    };
    return { config, problems };
}

/**
 * guardedTools as the plugin reads it: a list of names, or a map from each
 * name to the words the user calls it by (a list, or one word). One name on
 * its own counts as a list of one. Anything else holds nothing back, and
 * says so.
 * @returns {{value: string[]|Record<string, string[]>, problem?: {key, message}}}
 */
export function guardedToolsOf(value) {
    if (value === undefined || value === null || value === '') return { value: [] };
    if (typeof value === 'string') return { value: [value] };
    if (Array.isArray(value)) {
        const names = value.filter((name) => typeof name === 'string' || typeof name === 'number').map(String);
        return names.length === value.length ? { value: names } : { value: names, problem: problem('guardedTools', 'a list of tool or server names', value, `only the names in it (${names.length})`) };
    }
    if (typeof value === 'object') {
        const out = {};
        let bad = false;
        for (const [name, words] of Object.entries(value)) {
            if (words === null || words === undefined) out[name] = [];
            else if (typeof words === 'string') out[name] = [words];
            else if (Array.isArray(words) && words.every((w) => typeof w === 'string' || typeof w === 'number')) out[name] = words.map(String);
            else {
                out[name] = [];
                bad = true;
            }
        }
        return bad ? { value: out, problem: problem('guardedTools', 'a list of names, or a map from each name to a list of the words you call it by', value, 'each name without the words it could not read') } : { value: out };
    }
    return { value: [], problem: problem('guardedTools', 'a list of names, or a map from each name to a list of the words you call it by', value, 'holds no tool back', { does: true }) };
}

/** What each live text setting falls back to while its value is not text. */
const TEXT_FALLBACK = Object.freeze({
    threadModel: 'DSH\'s default model for new threads',
    threadEffort: 'the model\'s default effort for new threads',
    yourTools: '"asked"',
    threadPermission: '"workspace-write" for new threads',
});

/**
 * A live text setting (threadModel, threadEffort, yourTools,
 * threadPermission) that is not text, such as a bare number in YAML, as a
 * problem in words; the plugin reads such a value as not set.
 * @returns {{key, message}|undefined}
 */
export function textSettingProblem(key, value) {
    if (value === undefined || value === null || typeof value === 'string') return undefined;
    return problem(key, key === 'threadModel' ? 'text: a model, such as "provider:model"' : 'text', value, TEXT_FALLBACK[key] ?? 'its default');
}

/**
 * trustedHosts as the plugin reads it: a list of host names or addresses.
 * One name on its own counts as a list of one. Anything else trusts no
 * machine (so every send asks), and says so.
 * @returns {{value: string[], problem?: {key, message}}}
 */
export function trustedHostsOf(value) {
    if (value === undefined || value === null || value === '') return { value: [] };
    if (typeof value === 'string') return { value: [value] };
    if (Array.isArray(value)) {
        const hosts = value.filter((host) => typeof host === 'string' && host.trim() !== '');
        return hosts.length === value.length ? { value: hosts } : { value: hosts, problem: problem('trustedHosts', 'a list of host names or addresses', value, `only the names in it (${hosts.length})`) };
    }
    return { value: [], problem: problem('trustedHosts', 'a list of host names or addresses', value, 'trusts no machine (every send asks)', { does: true }) };
}
