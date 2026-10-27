/**
 * A DeepSeek Harness community plugin that connects a Discord bot to agent
 * sessions. A top-level message in an allowed channel gets a public thread
 * anchored to it; the thread's session is keyed by thread id and persists
 * across restarts. Agents reply through the plugin's Discord tools (send,
 * send_file, typing, threads, reactions, user lookup). No runtime
 * dependencies beyond DSH itself: the Discord REST and Gateway client is
 * written directly on `fetch` and `WebSocket`.
 *
 * Nothing here throws into DSH: a wrong setting, a missing token or an
 * unreachable Discord is logged in words and leaves the bot offline or
 * retrying, never the profile broken.
 *
 * @module dsh-plugin-discord
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { brandString } from '@deepseek-ai/dsh-brand';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DiscordClient, DEFAULT_INTENTS, REST_BASE } from './client.js';
import { DEFAULTS, quietReasons, readConfig } from './config.js';
import { ThreadRouter, inWords, parseTitleModel } from './router.js';
import { discordTools } from './tools.js';
import { initTrace, stopTrace, teeLogger, write as trace } from './trace.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'discord-plugin';

/** Host services the plugin drives. */
export const inject = [
    'tools',
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'permissionPresets',
    'sessionTitle',
    'workspaceRegistry',
    'credentials',
    'llm',
];

/** The slash commands the bot registers (global, once; changed ones are updated). */
export const COMMANDS = Object.freeze([
    {
        name: 'status',
        description: "Show this thread's agent session, its model and whether the bot is connected.",
    },
    {
        name: 'stop',
        description: 'Stop the running turn in this thread. Messages sent after it stay queued.',
    },
    {
        name: 'new',
        description: "Start this thread's agent session afresh (the old one stays in DSH).",
    },
    {
        name: 'reset',
        description: "Start this thread's agent session afresh (the same as /new).",
    },
    {
        name: 'rename',
        description: 'Rename this thread. With no title, a new one is made from the conversation.',
        options: [{ name: 'title', description: 'The new title; leave it out to make one', type: 3, required: false }],
    },
    {
        name: 'model',
        description: 'Show or switch the model for this thread. /new clears it.',
        options: [{ name: 'spec', description: 'provider:model (or a model id); leave it out to show the current one', type: 3, required: false }],
    },
    {
        name: 'effort',
        description: 'Show or set the reasoning effort for this thread (for example low, medium, high).',
        options: [{ name: 'level', description: 'An effort level, or "clear" for the default; leave it out to show it', type: 3, required: false }],
    },
]);

const describe = {
    enabled: 'Master switch. false keeps the plugin loaded with the bot offline and no Discord tools.',
    tokenRef: 'The credential name that holds the bot token, in the DSH credential store or the environment.',
    workspacePath: 'Absolute folder the Discord sessions work in. Without it the bot stays offline.',
    agentPreset: 'The agent preset for the sessions the bot starts.',
    permissionPreset: 'The permission preset for the sessions the bot starts (read-only, workspace-write, danger-full-access).',
    allowedChannelIds: 'Channel ids (in quotes) the bot answers in, and their threads. Empty: it answers nowhere.',
    allowedUserIds: 'User ids (in quotes) the bot answers. Empty: anyone who can post in the allowed channels.',
    requireMention: 'true: a top-level message must @mention the bot to start a thread.',
    autoThread: 'true: each top-level message gets its own thread and session. false: the channel is one session.',
    threadArchiveMinutes: "Discord's auto-archive time for new threads: 60, 1440, 4320 or 10080.",
    titleModel: 'The model that names threads ("provider:model" or a model id). Empty: the DSH default model.',
    titleTimeoutMs: 'How long the title model may take, in ms (1000 to 300000).',
    models: 'Model choices /model lists ("provider:model"). Any model can still be typed.',
    maxPromptChars: 'The longest relayed message in characters (500 to 200000); longer text is cut with a note.',
    requestTimeoutMs: 'How long one Discord call may take, in ms (1000 to 120000).',
    replyFallback: 'true: a Discord turn that ends without a reply is reminded once, then its last words are posted.',
    postErrors: 'true: a failed turn says so in its thread.',
    catchUpMinutes: 'After a restart, answer messages posted in the last this-many minutes while DSH was down (0: off).',
    sendScope: '"allowed": the Discord tools post only in the allowed channels and their threads. "any": anywhere the bot can.',
    extraSendChannelIds: 'More channel ids (in quotes) the Discord tools may post in, with sendScope "allowed".',
    apiBase: "Discord's REST address; empty means Discord itself. Tests point it at a local fake (the gateway follows).",
    traceFile: "The bot's event trace and log (one JSON line per event, owner-only; the last run is kept as .1). Empty: off.",
    storeFile: 'The thread-to-session store (owner-only JSON).',
};

/**
 * Settings: their defaults here, their checks in lib/config.js. Each takes any
 * value, so a wrong type in the profile is said in words in DSH's log instead
 * of stopping the plugin at load.
 */
export const Config = z.object(Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [
    key,
    z.any().default(Array.isArray(value) ? [...value] : value).description(describe[key] ?? ''),
])));

/**
 * Start the gateway and register the Discord tools for the lifetime of `ctx`.
 * @param ctx - plugin context; registrations and the connection are disposed with it.
 * @param rawConfig - the row's config (checked here, never trusted).
 */
export function apply(ctx, rawConfig) {
    // Every line the plugin logs also goes to its trace (DSH keeps plugin log lines in memory only).
    const logger = teeLogger(ctx.logger, trace);
    const { settings: config, problems, offline } = readConfig(rawConfig);
    const tracePath = initTrace(config.traceFile);
    trace('apply', 'start', {
        enabled: config.enabled,
        workspacePath: config.workspacePath,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        allowedChannelIds: config.allowedChannelIds,
        allowedUserIds: config.allowedUserIds,
        requireMention: config.requireMention,
        autoThread: config.autoThread,
        apiBase: config.apiBase || REST_BASE,
        intents: DEFAULT_INTENTS,
        problems,
    });
    for (const problem of problems) logger.warn('discord: setting refused: %s', problem);
    ctx.effect(() => () => {
        trace('apply', 'dispose', {});
        stopTrace();
    });

    if (!config.enabled) {
        logger.info('discord: switched off (enabled: false); the bot stays offline');
        trace('apply', 'disabled', {});
        return;
    }
    if (offline !== null) {
        logger.warn('discord: the bot stays offline: %s. Fix the setting in the plugin row and reload.', offline);
        trace('apply', 'offline', { reason: offline });
        return;
    }
    if (config.workspacePath === '') {
        logger.warn('discord: workspacePath is not set, so the bot stays offline; set it to the folder Discord sessions should work in, then reload');
        trace('apply', 'no-workspace', {});
        return;
    }
    const workspaceProblem = workspaceFault(config.workspacePath);
    if (workspaceProblem) {
        logger.warn('discord: the bot stays offline: workspacePath %s; set it to the absolute path of a folder that exists, then reload', workspaceProblem);
        trace('apply', 'bad-workspace', { reason: workspaceProblem });
        return;
    }
    for (const reason of quietReasons(config)) logger.warn('discord: %s', reason);

    let client = null;
    let offlineWhy = 'the bot is still connecting to Discord';
    const router = new ThreadRouter({
        ctx,
        config,
        logger,
        host: { brandString, createUserMessage, BlockAssembler },
        botState: () => client?.state ?? null,
    });
    let commandsDone = false;
    let stopped = false;

    const start = async () => {
        const credential = await ctx.credentials.resolve(config.tokenRef);
        const token = credential === undefined || typeof credential?.value !== 'string' || credential.value.trim() === '' ? null : credential.value.trim();
        trace('token', token === null ? 'missing' : 'resolved', { tokenRef: config.tokenRef });
        if (token === null) {
            offlineWhy = `no bot token is stored under ${config.tokenRef}`;
            logger.warn('discord: no bot token under the credential name %s, so the bot stays offline. Store it in the DSH credential store (.credentials.yaml in DSH\'s data folder) or the environment, then reload.', config.tokenRef);
            return;
        }
        if (stopped) return;
        client = new DiscordClient({
            token,
            intents: DEFAULT_INTENTS,
            requestTimeoutMs: config.requestTimeoutMs,
            apiBase: config.apiBase || REST_BASE,
            logger,
            trace,
            onMessage: (d) => router.handleMessage(d),
            onInteraction: (d) => router.handleInteraction(d),
            onReady: async ({ resumed }) => {
                if (!commandsDone && client?.botUser?.id) {
                    try {
                        await client.ensureCommands(client.botUser.id, COMMANDS);
                        commandsDone = true;
                    } catch (error) {
                        trace('commands', 'failed', { error: inWords(error) });
                        logger.warn('discord: could not register the slash commands (%s); messages still work, and the next connection tries again', inWords(error));
                    }
                }
                if (!resumed) await router.catchUp();
            },
        });
        router.attachClient(client);
        offlineWhy = 'the bot is still connecting to Discord';
        try {
            await client.start();
            trace('apply', 'connected', { botId: client.botUser?.id });
            logger.info('discord: gateway connected; listening for messages');
        } catch (error) {
            offlineWhy = client.state.fatal ? `Discord refused the bot (${client.state.fatal})` : 'the bot stopped';
            trace('apply', 'not-connected', { error: inWords(error) });
        }
    };
    start().catch((error) => {
        offlineWhy = `the bot could not start (${inWords(error)})`;
        trace('apply', 'startup-failed', { error: inWords(error) });
        logger.warn('discord: the bot could not start (%s); reload the plugin to try again', inWords(error));
    });

    const getClient = () => (!stopped && client !== null && !client.state.fatal ? client : null);
    // The Discord tools go only to the sessions the bot runs for Discord threads: the router registers them in
    // each such agent's own scope. No other DSH session is offered them.
    router.offerTools(discordTools({ defineTool, getClient, offlineReason: () => offlineWhy, config, router, trace }));
    trace('apply', 'ready', { tracePath, store: router.store.file, storeLoaded: router.store.loaded });
    if (router.store.loaded === 'damaged') {
        logger.warn('discord: the thread store was damaged and was set aside next to it; threads start new sessions');
    }

    // Live connections and created sessions must not outlive the plugin.
    ctx.effect(() => async () => {
        stopped = true;
        offlineWhy = 'the Discord plugin was unloaded';
        if (client !== null) await client.stop();
        await router.dispose();
    });
}

/** Why `path` cannot be the workspace (not absolute, missing, not a folder), in words; null when it can. */
function workspaceFault(path) {
    if (!isAbsolute(path)) return `"${path}" is not an absolute path`;
    try {
        return statSync(path).isDirectory() ? null : `${path} is not a folder`;
    } catch {
        return `${path} does not exist`;
    }
}

export { parseTitleModel, readConfig };
