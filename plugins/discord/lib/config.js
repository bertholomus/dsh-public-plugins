/**
 * The plugin's settings in words: defaults, the check that turns a profile
 * row into settings the bot can use, and a sentence for each value it had to
 * refuse. No DSH packages here, so the checks run in plain unit tests.
 *
 * A wrong value never stops DSH or the plugin from loading. Most wrong values
 * fall back to their default and say so. The two settings that decide who may
 * drive an agent (allowedUserIds, allowedChannelIds) never fall back to
 * "anyone": a wrong value there keeps the bot offline until it is fixed.
 *
 * @module dsh-plugin-discord/config
 */

/** What the bot uses when the profile row sets nothing. */
export const DEFAULTS = Object.freeze({
    enabled: true,
    tokenRef: 'DISCORD_BOT_TOKEN',
    workspacePath: '',
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    allowedChannelIds: Object.freeze([]),
    allowedUserIds: Object.freeze([]),
    requireMention: false,
    autoThread: true,
    threadArchiveMinutes: 1440,
    titleModel: '',
    titleTimeoutMs: 20000,
    models: Object.freeze([]),
    maxPromptChars: 8000,
    requestTimeoutMs: 15000,
    replyFallback: true,
    postErrors: true,
    catchUpMinutes: 120,
    sendScope: 'allowed',
    extraSendChannelIds: Object.freeze([]),
    apiBase: '',
    traceFile: '~/.dsh/discord-plugin-trace.log',
    storeFile: '~/.dsh/discord-plugin-sessions.json',
});

/** Discord's own auto-archive choices, in minutes. */
export const ARCHIVE_MINUTES = Object.freeze([60, 1440, 4320, 10080]);

/** A Discord id: a snowflake, 17 to 20 digits. */
const SNOWFLAKE = /^\d{17,20}$/;

const isString = (v) => typeof v === 'string';
const shown = (v) => {
    try {
        const text = JSON.stringify(v);
        return text === undefined ? String(v) : text.length > 60 ? `${text.slice(0, 57)}...` : text;
    } catch {
        return String(v);
    }
};

/**
 * Check one profile row. Never throws.
 * @param {Record<string, unknown>} raw - the row's config as DSH hands it over (any shape).
 * @returns {{ settings: object, problems: string[], offline: string|null }}
 *   settings: every key, with defaults for missing or refused values;
 *   problems: one sentence per refused value (what it was, what it must be, what is used instead);
 *   offline: why the bot must not connect (a refused allowlist), or null.
 */
export function readConfig(raw) {
    const input = raw !== null && typeof raw === 'object' ? raw : {};
    const settings = {};
    const problems = [];
    let offline = null;
    const has = (key) => input[key] !== undefined && input[key] !== null;

    const bool = (key) => {
        if (!has(key)) return DEFAULTS[key];
        const v = input[key];
        if (typeof v === 'boolean') return v;
        if (v === 'true' || v === 'false') return v === 'true';
        problems.push(`${key} must be true or false, not ${shown(v)}; using ${DEFAULTS[key]}.`);
        return DEFAULTS[key];
    };
    const text = (key, { allowEmpty = true } = {}) => {
        if (!has(key)) return DEFAULTS[key];
        const v = input[key];
        if (isString(v) && (allowEmpty || v.trim() !== '')) return v.trim();
        problems.push(`${key} must be text, not ${shown(v)}; using ${shown(DEFAULTS[key])}.`);
        return DEFAULTS[key];
    };
    const whole = (key, min, max, unit) => {
        if (!has(key)) return DEFAULTS[key];
        const v = typeof input[key] === 'string' && input[key].trim() !== '' ? Number(input[key]) : input[key];
        if (Number.isInteger(v) && v >= min && v <= max) return v;
        problems.push(`${key} must be a whole number from ${min} to ${max}${unit ? ` ${unit}` : ''}, not ${shown(input[key])}; using ${DEFAULTS[key]}.`);
        return DEFAULTS[key];
    };
    /** A list of Discord ids. A single id is taken as a list of one; numbers are refused (YAML rounds long ones). */
    const ids = (key, { failClosed }) => {
        if (!has(key)) return [...DEFAULTS[key]];
        let v = input[key];
        if (isString(v)) v = [v];
        const refuse = (why) => {
            if (failClosed) {
                problems.push(`${key} ${why}; the bot stays offline until it is fixed (it never falls back to allowing everyone).`);
                offline ??= `${key} is not a list of Discord ids in quotes`;
                return [];
            }
            problems.push(`${key} ${why}; using an empty list.`);
            return [];
        };
        if (!Array.isArray(v)) return refuse(`must be a list of Discord ids in quotes, not ${shown(v)}`);
        const out = [];
        for (const item of v) {
            if (typeof item === 'number') return refuse(`has the id ${shown(item)} without quotes (YAML rounds long numbers, so it can never match); write it in quotes`);
            if (!isString(item) || !SNOWFLAKE.test(item.trim())) return refuse(`has ${shown(item)}, which is not a Discord id (17 to 20 digits, in quotes)`);
            out.push(item.trim());
        }
        return [...new Set(out)];
    };

    settings.enabled = bool('enabled');
    settings.tokenRef = text('tokenRef', { allowEmpty: false });
    settings.workspacePath = text('workspacePath');
    settings.agentPreset = text('agentPreset', { allowEmpty: false });
    settings.permissionPreset = text('permissionPreset', { allowEmpty: false });
    settings.allowedChannelIds = ids('allowedChannelIds', { failClosed: true });
    settings.allowedUserIds = ids('allowedUserIds', { failClosed: true });
    settings.requireMention = bool('requireMention');
    settings.autoThread = bool('autoThread');

    settings.threadArchiveMinutes = DEFAULTS.threadArchiveMinutes;
    if (has('threadArchiveMinutes')) {
        const v = Number(input.threadArchiveMinutes);
        if (ARCHIVE_MINUTES.includes(v)) settings.threadArchiveMinutes = v;
        else problems.push(`threadArchiveMinutes must be one of ${ARCHIVE_MINUTES.join(', ')} (Discord's choices), not ${shown(input.threadArchiveMinutes)}; using ${DEFAULTS.threadArchiveMinutes}.`);
    }

    settings.titleModel = text('titleModel');
    settings.titleTimeoutMs = whole('titleTimeoutMs', 1000, 300000, 'ms');
    settings.models = [];
    if (has('models')) {
        const v = input.models;
        if (Array.isArray(v) && v.every((m) => isString(m) && m.trim() !== '')) settings.models = v.map((m) => m.trim());
        else problems.push(`models must be a list of model names such as "provider:model", not ${shown(v)}; /model shows no list.`);
    }
    settings.maxPromptChars = whole('maxPromptChars', 500, 200000, 'characters');
    settings.requestTimeoutMs = whole('requestTimeoutMs', 1000, 120000, 'ms');
    settings.replyFallback = bool('replyFallback');
    settings.postErrors = bool('postErrors');
    settings.catchUpMinutes = whole('catchUpMinutes', 0, 10080, 'minutes');

    settings.sendScope = DEFAULTS.sendScope;
    if (has('sendScope')) {
        if (input.sendScope === 'allowed' || input.sendScope === 'any') settings.sendScope = input.sendScope;
        else problems.push(`sendScope must be "allowed" or "any", not ${shown(input.sendScope)}; using "allowed".`);
    }
    settings.extraSendChannelIds = ids('extraSendChannelIds', { failClosed: false });

    settings.apiBase = text('apiBase');
    if (settings.apiBase !== '' && !/^https?:\/\/[^\s]+$/.test(settings.apiBase)) {
        problems.push(`apiBase must be an http(s) address such as http://127.0.0.1:8080/api/v10, not ${shown(settings.apiBase)}; using Discord itself.`);
        settings.apiBase = '';
    }
    settings.apiBase = settings.apiBase.replace(/\/+$/, '');
    settings.traceFile = text('traceFile');
    settings.storeFile = text('storeFile', { allowEmpty: false });

    for (const key of Object.keys(input)) {
        if (!(key in DEFAULTS)) problems.push(`${key} is not a setting of this plugin; it is ignored.`);
    }
    return { settings, problems, offline };
}

/**
 * The settings that leave the bot connected but unable to do its job, in
 * words: shown once at start, so a quiet bot is never a mystery.
 * @param {object} settings - from readConfig.
 * @returns {string[]}
 */
export function quietReasons(settings) {
    const out = [];
    if (settings.allowedChannelIds.length === 0) {
        out.push('allowedChannelIds is empty, so the bot ignores every message; add the id of the channel it should answer in.');
    }
    if (settings.allowedUserIds.length === 0 && settings.allowedChannelIds.length > 0) {
        out.push('allowedUserIds is empty, so anyone who can post in the allowed channels drives an agent on this computer; list your own user id.');
    }
    return out;
}
