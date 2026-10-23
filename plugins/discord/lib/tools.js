/**
 * Model-facing Discord tools. Every outbound action an agent can take goes
 * through these; the router's relay instruction tells the model to use
 * `discord_send` for its reply (and `discord_send_file` for artifacts).
 *
 * @module dsh-plugin-discord/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
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

/** Build the Discord toolset over one client. */
export function discordTools({ getClient, config }) {
    const guard = async (run) => {
        const client = getClient();
        if (client === null) {
            return { ok: false, message: 'discord: no bot token is configured — set tokenRef in the plugin config and store the credential' };
        }
        try {
            return await run(client);
        } catch (error) {
            return { ok: false, message: `discord: ${error?.message ?? String(error)}` };
        }
    };

    return [
        defineTool({
            name: 'discord_send',
            description: 'Send a message to a Discord channel or thread. This is how your reply reaches the user — plain text output never leaves the harness. Long text is split at 2000 characters on paragraph or code-fence boundaries (never inside a code block).',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Discord channel or thread snowflake id to send to' },
                content: { type: 'string', required: true, description: 'Message text (Markdown supported, split automatically at 2000 chars per message)' },
                reply_to: { type: 'string', description: 'Optional message id to reply to' },
                silent: { type: 'boolean', description: 'Set true to suppress push notifications' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 30000,
            async execute(args) {
                return guard(async (client) => {
                    const extra = {};
                    if (args.reply_to !== undefined && args.reply_to.trim() !== '') {
                        extra.message_reference = { message_id: args.reply_to.trim() };
                    }
                    if (args.silent === true) extra.flags = 1 << 12; // SUPPRESS_NOTIFICATIONS
                    const { messageId, chunkCount } = await getClient().sendMessage(args.channel_id, args.content, extra);
                    const suffix = chunkCount > 1 ? ` (sent as ${chunkCount} messages)` : '';
                    return { ok: true, messageId: messageId ?? undefined, message: `sent to ${args.channel_id}${suffix}` };
                });
            },
        }),
        defineTool({
            name: 'discord_send_file',
            description: 'Upload a local file as a Discord message attachment. Use it to deliver generated artifacts (documents, spreadsheets, images, exports).',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Discord channel or thread snowflake id to send to' },
                path: { type: 'string', required: true, description: 'Absolute local path of the file to attach' },
                caption: { type: 'string', description: 'Optional message text accompanying the file' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 120000,
            async execute(args) {
                return guard(async (client) => {
                    const file = readAttachment(args.path);
                    const { messageId } = await getClient().sendFile(args.channel_id, file, args.caption);
                    return { ok: true, messageId: messageId ?? undefined, message: `attached ${file.filename} to ${args.channel_id}` };
                });
            },
        }),
        defineTool({
            name: 'discord_typing',
            description: 'Show the typing indicator in a Discord channel or thread for about ten seconds, or until a message is sent. The bot already shows typing while a turn is running; use this only for extra signaling.',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Discord channel id' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 15000,
            async execute(args) {
                return guard(async (client) => {
                    await getClient().triggerTyping(args.channel_id);
                    return { ok: true, message: `typing indicator shown in ${args.channel_id}` };
                });
            },
        }),
        defineTool({
            name: 'discord_create_thread',
            description: 'Create a thread from an existing message (or a standalone thread in a channel). Normally unnecessary — the bot threads parent-channel messages automatically. Returns the thread id to send into.',
            parameters: {
                channel_id: { type: 'string', required: true, description: 'Parent channel id' },
                name: { type: 'string', required: true, description: 'Thread name, 1-100 characters' },
                message_id: { type: 'string', description: 'Anchor message id; omit to create a thread without a starter message' },
            },
            output: { schema: STATUS_SCHEMA, render: renderStatus },
            timeoutMs: 30000,
            async execute(args) {
                return guard(async (client) => {
                    const { threadId } = await getClient().createThread(args.channel_id, args.name, { messageId: args.message_id });
                    return {
                        ok: true,
                        threadId: threadId ?? undefined,
                        message: `created thread "${args.name}"${threadId ? ` (id ${threadId})` : ''} — send into it with discord_send channel_id "${threadId}"`,
                    };
                });
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
                return guard(async (client) => {
                    await getClient().addReaction(args.channel_id, args.message_id, args.emoji);
                    return { ok: true, message: `reacted ${args.emoji} to ${args.message_id}` };
                });
            },
        }),
        defineTool({
            name: 'discord_user',
            description: 'Look up a Discord user\'s public identity (username, display name, avatar) by user id. Inbound message relays already include the author\'s identity; use this for other mentions.',
            parameters: {
                user_id: { type: 'string', required: true, description: 'Discord user snowflake id' },
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
                return guard(async (client) => {
                    const user = await getClient().getUser(args.user_id);
                    return {
                        ok: true,
                        message: `looked up ${args.user_id}`,
                        id: user.id,
                        username: user.username,
                        displayName: user.global_name ?? user.username,
                        bot: user.bot === true,
                    };
                });
            },
        }),
    ];
}
