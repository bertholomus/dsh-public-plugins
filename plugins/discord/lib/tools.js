/**
 * Model-facing Discord tools. Every outbound action an agent can take goes
 * through these; the router's relay instruction tells the model to use
 * `discord_send` for its reply (and `discord_send_file` for artifacts).
 *
 * With sendScope "allowed" (the default) the tools reach only the bot's own
 * channels: the allowed channels, threads under them, threads the bot runs,
 * and extraSendChannelIds. Every id a call names (channel, message, reply)
 * must be a Discord id, so a call acts only in the channel it names, and
 * discord_send_file sends only files inside workspacePath. The router offers
 * these tools only to the sessions it runs for Discord. DSH's defineTool
 * comes in as a parameter, so the tools run in plain unit tests too.
 *
 * @module dsh-plugin-discord/tools
 */
import { readAttachment } from './router.js';

/** Common output schema for status-style results. */
const STATUS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        message: { type: 'string', required: true },
        messageId: { type: 'string' },
        threadId: { type: 'string' },
    },
};

/** Render a status result as model prose. */
function renderStatus(_args, value) {
    return [{ type: 'text', text: value.message }];
}

const SNOWFLAKE = /^\d{17,20}$/;

/** A refusal in words when `value` (given) is not a Discord id; null when it is one, or when an optional one is left out. */
const notAnId = (value, what, optional = false) => {
    if (optional && (value === undefined || value === null || (typeof value === 'string' && value.trim() === ''))) return null;
    return typeof value === 'string' && SNOWFLAKE.test(value.trim()) ? null : `"${String(value ?? '').slice(0, 40)}" is not a Discord ${what}`;
};

/**
 * A refusal in words when `value` is not an emoji: a unicode emoji (not plain ASCII text such as "." or "..",
 * which would change the request's path), or a custom one as name:id. null when it is one.
 */
export function notAnEmoji(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text !== '' && text.length <= 64 && (/[^\x00-\x7f]/.test(text) || /^\w{2,32}:\d{17,20}$/.test(text))) return null;
    return `"${String(value ?? '').slice(0, 40)}" is not an emoji (a unicode emoji, or name:id for a custom one)`;
}

/**
 * Build the Discord toolset.
 * @param {object} options
 * @param {Function} options.defineTool - DSH's defineTool.
 * @param {() => object|null} options.getClient - the connected client, or null.
 * @param {() => string} options.offlineReason - why there is no client, in words.
 * @param {object} options.config - checked settings.
 * @param {object} [options.router] - the ThreadRouter (scope and reply bookkeeping).
 */
export function discordTools({ defineTool, getClient, offlineReason = () => 'Discord is not connected', config, router, trace = () => {} }) {
    /** Refuse a channel outside the bot's own, in words; null when it is fine. */
    const outOfScope = async (channelId) => {
        if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId.trim())) return `"${String(channelId).slice(0, 40)}" is not a Discord channel id`;
        if (config.sendScope === 'any') return null;
        const id = channelId.trim();
        if (config.allowedChannelIds.includes(id) || config.extraSendChannelIds.includes(id)) return null;
        // A thread the bot runs counts only while its channel is still allowed.
        if (router?.storedUnder?.(id, config.allowedChannelIds)) return null;
        const info = await router?.channelInfo?.(id);
        if (info?.parent_id && config.allowedChannelIds.includes(info.parent_id)) return null;
        return `channel ${id} is outside the channels this bot may post in (its allowed channels and their threads); the owner can add it to extraSendChannelIds`;
    };

    const guard = async (channelId, run, ids = []) => {
        const client = getClient();
        if (client === null) return { ok: false, message: `discord: not sent, ${offlineReason()}` };
        try {
            for (const [value, what, optional] of ids) {
                const refused = notAnId(value, what, optional);
                if (refused) {
                    trace('tool', 'refused', { channelId: String(channelId ?? '').slice(0, 40), reason: refused });
                    return { ok: false, message: `discord: not sent, ${refused}` };
                }
            }
            if (channelId !== undefined) {
                const refused = await outOfScope(channelId);
                if (refused) {
                    trace('tool', 'refused', { channelId: String(channelId).slice(0, 40), reason: refused });
                    return { ok: false, message: `discord: not sent, ${refused}` };
                }
            }
            return await run(client);
        } catch (error) {
            trace('tool', 'failed', { channelId: String(channelId ?? '').slice(0, 40), error: String(error?.message ?? error).slice(0, 200) });
            return { ok: false, message: `discord: not sent, ${error?.message ?? String(error)}` };
        }
    };
    const sent = (exec, channelId, what) => {
        try {
            trace('tool', 'delivered', { channelId, sessionId: exec?.agent?.session?.id ?? null, ...what });
            router?.noteSent(exec?.agent?.session?.id, channelId);
        } catch {}
    };

    return [
        defineTool({
            name: 'discord_send',
            description: 'Send a message to a Discord channel or thread. This is how your reply reaches the person: plain text output never leaves the harness. Long text is split at 2000 characters on paragraph or code-fence boundaries (never inside a code block). Mentions ping users only, never @everyone or roles.',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Discord channel or thread id to send to' },
                content: { type: 'string', required: true, description: 'Message text (Markdown; split automatically at 2000 characters per message)' },
                reply_to: { type: 'string', description: 'Optional message id to reply to' },
                silent: { type: 'boolean', description: 'Set true to send without a push notification' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 60000,
            async execute(args, exec) {
                return guard(args.channel_id, async (client) => {
                    if (typeof args.content !== 'string' || args.content.trim() === '') return { ok: false, message: 'discord: not sent, the message is empty' };
                    const extra = {};
                    if (typeof args.reply_to === 'string' && args.reply_to.trim() !== '') {
                        extra.message_reference = { message_id: args.reply_to.trim(), fail_if_not_exists: false };
                    }
                    if (args.silent === true) extra.flags = 1 << 12; // SUPPRESS_NOTIFICATIONS
                    const channelId = args.channel_id.trim();
                    const { messageId, chunkCount } = await client.sendMessage(channelId, args.content, extra);
                    sent(exec, channelId, { tool: 'discord_send', messageId, chunkCount });
                    const parts = chunkCount > 1 ? ` as ${chunkCount} messages` : '';
                    return { ok: true, messageId: messageId ?? undefined, message: `delivered to Discord${parts} (message ${messageId ?? 'id unknown'})` };
                }, [[args.reply_to, 'message id (reply_to)', true]]);
            },
        }),
        defineTool({
            name: 'discord_send_file',
            description: 'Upload a file from the workspace folder (at most 10 MiB) as a Discord message attachment. Use it to deliver generated artifacts (documents, spreadsheets, images, exports). Files outside the workspace folder are refused.',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Discord channel or thread id to send to' },
                path: { type: 'string', required: true, description: 'Absolute path of the file to attach, inside the workspace folder' },
                caption: { type: 'string', description: 'Optional message text with the file' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 120000,
            async execute(args, exec) {
                return guard(args.channel_id, async (client) => {
                    const file = readAttachment(args.path, undefined, config.workspacePath);
                    const channelId = args.channel_id.trim();
                    const { messageId } = await client.sendFile(channelId, file, args.caption);
                    sent(exec, channelId, { tool: 'discord_send_file', messageId, bytes: file.buffer.length });
                    return { ok: true, messageId: messageId ?? undefined, message: `delivered ${file.filename} to Discord (message ${messageId ?? 'id unknown'})` };
                });
            },
        }),
        defineTool({
            name: 'discord_typing',
            description: 'Show the typing indicator in a Discord channel or thread for about ten seconds. The bot already shows typing while a turn runs; use this only for extra signaling.',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Discord channel id' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 15000,
            async execute(args) {
                return guard(args.channel_id, async (client) => {
                    await client.triggerTyping(args.channel_id.trim());
                    return { ok: true, message: 'typing indicator shown' };
                });
            },
        }),
        defineTool({
            name: 'discord_create_thread',
            description: 'Create a thread from an existing message (or a standalone thread in a channel). Normally unnecessary: the bot threads parent-channel messages itself. Returns the thread id to send into.',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Parent channel id' },
                name: { type: 'string', required: true, description: 'Thread name, 1 to 100 characters' },
                message_id: { type: 'string', description: 'Anchor message id; omit for a thread without a starter message' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 30000,
            async execute(args) {
                return guard(args.channel_id, async (client) => {
                    const messageId = typeof args.message_id === 'string' && args.message_id.trim() !== '' ? args.message_id.trim() : undefined;
                    const { threadId } = await client.createThread(args.channel_id.trim(), args.name, {
                        messageId,
                        autoArchiveMinutes: config.threadArchiveMinutes,
                    });
                    return {
                        ok: true,
                        threadId: threadId ?? undefined,
                        message: `created the thread "${args.name}"${threadId ? `; send into it with discord_send channel_id "${threadId}"` : ''}`,
                    };
                }, [[args.message_id, 'message id', true]]);
            },
        }),
        defineTool({
            name: 'discord_react',
            description: 'Add a reaction (unicode emoji, or custom emoji as name:id) to a Discord message.',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Channel id containing the message' },
                message_id: { type: 'string', required: true, description: 'Message id to react to' },
                emoji: { type: 'string', required: true, description: 'Unicode emoji or custom emoji name:id' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 15000,
            async execute(args) {
                return guard(args.channel_id, async (client) => {
                    const refused = notAnEmoji(args.emoji);
                    if (refused) return { ok: false, message: `discord: not sent, ${refused}` };
                    await client.addReaction(args.channel_id.trim(), args.message_id.trim(), args.emoji.trim());
                    return { ok: true, message: `reacted ${args.emoji.trim()}` };
                }, [[args.message_id, 'message id']]);
            },
        }),
        defineTool({
            name: 'discord_user',
            description: 'Look up a Discord user\'s public identity (username, display name) by user id. Relayed messages already name their author; use this for other mentions.',
            parameters: {
                user_id: { type: 'string', required: true, description: 'Discord user id' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true },
                        message: { type: 'string', required: true },
                        id: { type: 'string' },
                        username: { type: 'string' },
                        displayName: { type: 'string' },
                        bot: { type: 'boolean' },
                    },
                },
                render: (_args, value) => value.ok
                    ? [{ type: 'text', text: `@${value.username} (display name: ${value.displayName}, id: ${value.id}${value.bot ? ', bot' : ''})` }]
                    : [{ type: 'text', text: value.message }],
            },
            timeoutMs: 15000,
            async execute(args) {
                return guard(undefined, async (client) => {
                    if (typeof args.user_id !== 'string' || !SNOWFLAKE.test(args.user_id.trim())) return { ok: false, message: 'discord: that is not a Discord user id' };
                    const user = await client.getUser(args.user_id.trim());
                    return {
                        ok: true,
                        message: `looked up ${args.user_id}`,
                        id: String(user?.id ?? args.user_id),
                        username: String(user?.username ?? 'unknown'),
                        displayName: String(user?.global_name ?? user?.username ?? 'unknown'),
                        bot: user?.bot === true,
                    };
                });
            },
        }),
    ];
}
