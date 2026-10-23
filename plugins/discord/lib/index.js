/**
 * A DeepSeek Harness community plugin that connects a Discord bot to agent
 * sessions. Top-level messages in allowed parent channels get a public thread
 * anchored to the message; the thread's session is keyed by thread id and
 * persists across restarts. Agents reply through the plugin's Discord tools
 * (send, send_file, typing, threads, reactions, user lookup). Zero runtime
 * dependencies beyond schemastery: the Discord REST + Gateway client is
 * implemented directly on `fetch` and `WebSocket`.
 *
 * @module dsh-plugin-discord
 */
import z from '@deepseek-ai/schemastery';
import { DiscordClient, DEFAULT_INTENTS } from './client.js';
import { ThreadRouter, parseTitleModel } from './router.js';
import { discordTools } from './tools.js';
import { initTrace, write as trace } from './trace.js';

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

/** Schemastery schema validating {@link Config}; deployment-varying fields default here. */
export const Config = z.object({
    /** Master switch; false leaves the bot idle. */
    enabled: z.boolean().default(true),
    /** Credential reference holding the bot token (DSH credential store or environment). */
    tokenRef: z.string().default('DISCORD_BOT_TOKEN'),
    /** Absolute workspace path for Discord-driven agent sessions. */
    workspacePath: z.string(),
    /** Agent preset mounted on created sessions. */
    agentPreset: z.string().default('standard'),
    /** Permission preset applied to created sessions. */
    permissionPreset: z.string().default('workspace-write'),
    /** Parent channels the bot operates in (plus threads under them). */
    allowedChannelIds: z.array(z.string()).default([]),
    /** When non-empty, only these user ids may talk to the bot. */
    allowedUserIds: z.array(z.string()).default([]),
    /** Require an @mention for top-level messages in parent channels. */
    requireMention: z.boolean().default(false),
    /** Thread every top-level parent-channel message automatically. */
    autoThread: z.boolean().default(true),
    /** Thread auto-archive duration in minutes (60/1440/4320/10080). */
    threadArchiveMinutes: z.number().default(1440),
    /** Cheap model for titles: "provider:model", "provider/model", or bare model id. */
    titleModel: z.string(),
    /** Title call deadline. */
    titleTimeoutMs: z.number().default(20000),
    /** Models offered by /model ("provider:model" or bare id); free-form input is always allowed. */
    models: z.array(z.string()).default([]),
    /** Cap on relayed prompt text. */
    maxPromptChars: z.number().default(8000),
    /** REST call timeout. */
    requestTimeoutMs: z.number().default(15000),
    /** REST base override (tests only). */
    apiBase: z.string(),
    /** Plugin-local trace file for bring-up diagnostics ('' disables). */
    traceFile: z.string().default('~/.dsh/discord-plugin-trace.log'),
    /** Durable thread → session store. */
    storeFile: z.string().default('~/.dsh/discord-plugin-sessions.json'),
});

/** Reject numeric config that cannot work at load time. */
function assertPositive(label, value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`discord-plugin: ${label} must be a positive integer`);
    }
}

/**
 * Start the gateway and register the Discord tools for the lifetime of `ctx`.
 * Startup failures (missing token, unreachable gateway) are logged, never
 * thrown: a missing or wrong token must not break profile composition.
 * @param ctx - plugin context; registrations and the connection are disposed with it.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
    assertPositive('maxPromptChars', config.maxPromptChars);
    assertPositive('requestTimeoutMs', config.requestTimeoutMs);
    assertPositive('titleTimeoutMs', config.titleTimeoutMs);
    initTrace(config.traceFile);
    trace('apply', 'start', {
        enabled: config.enabled,
        workspacePath: config.workspacePath,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        allowedChannelIds: config.allowedChannelIds,
        allowedUserIds: config.allowedUserIds,
        requireMention: config.requireMention,
        autoThread: config.autoThread,
        threadArchiveMinutes: config.threadArchiveMinutes,
        titleModel: config.titleModel ?? '(default route)',
        intents: DEFAULT_INTENTS,
    });
    if (!config.enabled) {
        trace('apply', 'disabled', {});
        return;
    }
    if (config.workspacePath === undefined || config.workspacePath.trim() === '') {
        ctx.logger.warn('discord: workspacePath is not configured — set it in the plugin row to enable session routing');
        trace('apply', 'no-workspace', {});
        return;
    }

    /** Resolve the token lazily so composition never depends on credential timing. */
    const tokenPromise = (async () => {
        const credential = await ctx.credentials.resolve(config.tokenRef);
        return credential === undefined || credential.value === '' ? null : credential.value;
    })();

    // A client with a null token registers tools that answer with a clear
    // configuration error instead of disappearing from the toolset.
    let client = null;
    const router = new ThreadRouter({ ctx, config, logger: ctx.logger });

    tokenPromise.then(async (token) => {
        trace('token', token === null ? 'missing' : 'resolved', { tokenRef: config.tokenRef });
        if (token === null) {
            ctx.logger.warn(
                'discord: no token under credential ref %s — the bot stays idle. Store the token in the DSH credential store (~/.dsh/.credentials.yaml) or the environment, then reload.',
                config.tokenRef,
            );
            return;
        }
        client = new DiscordClient({
            token,
            intents: DEFAULT_INTENTS,
            requestTimeoutMs: config.requestTimeoutMs,
            ...(config.apiBase !== undefined ? { apiBase: config.apiBase } : {}),
            logger: ctx.logger,
            trace,
            onMessage: (d) => router.handleMessage(d),
            onInteraction: (d) => router.handleInteraction(d),
        });
        router.attachClient(client);
        await client.start();
        trace('apply', 'connected', { botId: client.botUser?.id });
        ctx.logger.info('discord: gateway connected; listening for messages');
        if (client.botUser?.id) {
            await client.ensureCommands(client.botUser.id, [
                {
                    name: 'rename',
                    description: 'Rename this thread. With no title, regenerates it from the conversation.',
                    options: [{ name: 'title', description: 'New title; omit to regenerate', type: 3, required: false }],
                },
                { name: 'new', description: "Clear this thread's agent session only." },
                { name: 'reset', description: "Clear this thread's agent session only (alias of /new)." },
                {
                    name: 'model',
                    description: 'Show or switch the model for this thread. Clears on /new.',
                    options: [{ name: 'spec', description: 'provider:model (or bare model id); omit to show the current one', type: 3, required: false }],
                },
                {
                    name: 'effort',
                    description: 'Show or set the reasoning effort for this thread (adapter-defined, e.g. minimal/low/medium/high).',
                    options: [{ name: 'level', description: 'Effort level, or "clear" to remove the override; omit to show', type: 3, required: false }],
                },
                { name: 'stop', description: 'Stop the running turn in this thread. Queued messages are kept.' },
            ]);
        }
    }).catch((error) => {
        trace('apply', 'startup-failed', { error: String(error?.stack ?? error).slice(0, 500) });
        ctx.logger.warn('discord: startup failed (%s) — the bot stays idle; reload the profile to retry', error?.message ?? error);
    });

    for (const tool of discordTools({ getClient: () => client, config })) {
        ctx.tools.register(tool);
    }

    // Live connections and created sessions must not outlive the plugin.
    ctx.effect(() => async () => {
        trace('apply', 'dispose', {});
        if (client !== null) await client.stop();
        await router.dispose();
    });
}

export { parseTitleModel };
