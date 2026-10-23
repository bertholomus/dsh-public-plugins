/**
 * Thread routing: the heart of the bot. Every inbound message is gated,
 * classified (parent channel vs thread), and mapped to a per-thread agent
 * session. Top-level messages in allowed parent channels get a public thread
 * anchored to the message; all work happens in threads, never in the parent.
 * Sessions are keyed by thread id and persisted, so they survive restarts;
 * busy threads queue turns (one agent loop per thread serializes them).
 *
 * @module dsh-plugin-discord/router
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { brandString } from '@deepseek-ai/dsh-brand';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import { SessionStore } from './store.js';
import { cleanTitle, deriveFallbackTitle, uniquifyTitle, capTitle, TITLE_MAX } from './titles.js';
import { generateTitle } from './llm.js';
import { write as trace } from './trace.js';

/** Channel types that are threads. */
const THREAD_TYPES = new Set([11, 12]);
/** Auto-archive durations Discord accepts (minutes). */
const ARCHIVE_MINUTES = new Set([60, 1440, 4320, 10080]);

/** First ~80 chars of the prompt, for the temporary thread name. */
function tempName(text) {
    const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
    return capTitle(oneLine.slice(0, 80) || 'conversation', 100);
}

/**
 * The standing reply instruction appended to every relayed turn.
 * @param {object} entry - store entry with threadId.
 */
function replyInstruction(threadId) {
    return `Reply in Discord with the discord_send tool using channel_id "${threadId}". ` +
        'Everything you send with discord_send lands in this thread; plain text output never reaches the user. ' +
        'When you generate an artifact file, deliver it with discord_send_file.';
}

/**
 * Owns gating, thread lifecycle, session lifecycle, typing, and titling.
 * One agent per thread; messages queue in that agent's inbox, so a busy
 * thread never runs concurrent turns while different threads do run
 * concurrently.
 */
export class ThreadRouter {
    /**
     * @param {object} options
     * @param {object} options.ctx - runtime context owning created agents.
     * @param {object} options.config - validated plugin config.
     * @param {object} options.logger - cordis-style logger.
     * @param {object} options.client - DiscordClient (assigned by the plugin once started).
     */
    constructor({ ctx, config, logger }) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        this.client = null;
        this.store = new SessionStore(config.storeFile);
        /** threadId → {sessionId, handle, status, firstReplyPending} for LIVE agents. */
        this.live = new Map();
        /** threadId → typing interval handle. */
        this.typing = new Map();
        /** channelId → channel object cache (type, name, parent_id, thread metadata). */
        this.channelCache = new Map();
        /** Per-thread one-line event log sink. */
        this.events = [];
    }

    /** Attach the live client once the plugin has started it. */
    attachClient(client) {
        this.client = client;
    }

    /** One line per event with thread_id, contents capped at 80 chars. */
    log(threadId, event, data = {}) {
        const line = { t: new Date().toISOString(), threadId, event, ...data };
        this.events.push(line);
        if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
        trace('router', event, { threadId, ...data });
    }

    /** Stop typing loops; called on plugin teardown. */
    async dispose() {
        for (const timer of this.typing.values()) clearInterval(timer);
        this.typing.clear();
        await Promise.allSettled([...this.live.values()].map(async (live) => {
            await live.handle.dispose();
        }));
        this.live.clear();
    }

    /**
     * Gate and route one inbound MESSAGE_CREATE payload.
     * @param {object} d - Discord payload `d`.
     * @returns {Promise<void>}
     */
    async handleMessage(d) {
        if (!d || typeof d !== 'object') return;
        const author = d.author;
        if (!author || author.bot) return; // ignore bots, including ourselves
        const me = this.client?.botUser;
        if (me && author.id === me.id) return;
        if (this.config.allowedUserIds.length > 0 && !this.config.allowedUserIds.includes(author.id)) {
            this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'user not allowlisted', authorId: author.id });
            return;
        }
        const content = typeof d.content === 'string' ? d.content.trim() : '';
        if (content.length === 0) return;

        const info = await this.channelInfo(d.channel_id);
        if (info === null) {
            this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'channel lookup failed' });
            return;
        }

        if (THREAD_TYPES.has(info.type)) {
            await this.handleThreadMessage(d, info, content, author);
            return;
        }
        if (info.type === 0) {
            await this.handleParentMessage(d, info, content, author);
            return;
        }
        this.log(d.channel_id, 'inbound', { result: 'drop', reason: `unsupported channel type ${info.type}` });
    }

    /** Fetch (and cache) a channel object. */
    async channelInfo(channelId) {
        if (this.channelCache.has(channelId)) return this.channelCache.get(channelId);
        if (!this.client) return null;
        try {
            const channel = await this.client.getChannel(channelId);
            if (channel?.id) {
                this.channelCache.set(channelId, channel);
                return channel;
            }
        } catch (error) {
            this.log(channelId, 'inbound', { result: 'drop', reason: `channel lookup error: ${String(error?.message ?? error).slice(0, 120)}` });
        }
        return null;
    }

    /** A thread under an allowed parent (or explicitly allowlisted channel) is in scope. */
    threadInScope(info) {
        if (this.config.allowedChannelIds.length === 0) return false;
        return this.config.allowedChannelIds.includes(info.id) || this.config.allowedChannelIds.includes(info.parent_id);
    }

    /**
     * A message inside a thread: every message is a turn, no mention needed.
     */
    async handleThreadMessage(d, info, content, author) {
        if (!this.threadInScope(info)) {
            this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'thread outside allowlist' });
            return;
        }
        if (info.thread_metadata?.archived) {
            try {
                await this.client.unarchiveThread(d.channel_id, 'continuing agent session');
                this.log(d.channel_id, 'unarchive', {});
            } catch (error) {
                this.log(d.channel_id, 'error', { where: 'unarchive', error: String(error?.message ?? error).slice(0, 200) });
            }
        }
        await this.ensureTurn(d.channel_id, d.id, content, author, info);
    }

    /**
     * A top-level message in a parent channel: gate, then auto-thread.
     * Never posts anything in the parent except a single error line when
     * thread creation fails twice.
     */
    async handleParentMessage(d, info, content, author) {
        if (!this.config.allowedChannelIds.includes(d.channel_id)) {
            this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'channel not allowlisted' });
            return;
        }
        if (this.config.requireMention) {
            const me = this.client?.botUser;
            const mentioned = me ? content.includes(`<@${me.id}>`) || content.includes(`<@!${me.id}>`) : false;
            if (!mentioned) {
                this.log(d.channel_id, 'inbound', { result: 'drop', reason: 'mention required' });
                return;
            }
        }
        if (!this.config.autoThread) {
            // Threads disabled: treat the parent channel itself as the session key.
            await this.ensureTurn(d.channel_id, d.id, content, author, info);
            return;
        }

        let threadId = null;
        for (let attempt = 1; attempt <= 2 && threadId === null; attempt++) {
            try {
                const created = await this.client.createThread(d.channel_id, tempName(content), {
                    messageId: d.id,
                    autoArchiveMinutes: ARCHIVE_MINUTES.has(this.config.threadArchiveMinutes) ? this.config.threadArchiveMinutes : 1440,
                });
                threadId = created.threadId;
            } catch (error) {
                this.log(d.channel_id, 'error', { where: `thread-create attempt ${attempt}`, error: String(error?.message ?? error).slice(0, 200) });
            }
        }
        if (threadId === null) {
            try {
                await this.client.sendMessage(d.channel_id, 'Could not create a thread for this message; the agent was not started.');
            } catch {}
            this.log(d.channel_id, 'error', { where: 'thread-create', error: 'gave up after retry' });
            return;
        }
        this.log(threadId, 'thread_created', { parentChannelId: d.channel_id, anchorMessageId: d.id });

        // Strip the bot's own mention from the text the agent sees.
        const me = this.client?.botUser;
        let anchorText = content;
        if (me) anchorText = content.split(`<@${me.id}>`).join('').split(`<@!${me.id}>`).join('').trim() || '(no text content)';

        // The thread's own name is the bot's temporary name: a manual rename
        // by the user would differ, and the rename step respects that.
        await this.ensureTurn(threadId, d.id, anchorText, author, { id: threadId, name: tempName(content), type: 11 }, { fresh: true });
    }

    /**
     * Ensure the thread's session exists (create, or resume from disk after a
     * restart) and feed this message in as the next turn.
     * @param {string} threadId - session key.
     * @param {string} messageId - Discord message id.
     * @param {string} content - user text.
     * @param {object} author - Discord author.
     * @param {object} info - channel info (name for titles).
     */
    async ensureTurn(threadId, messageId, content, author, info) {
        const stored = this.store.get(threadId);
        let live = this.live.get(threadId);

        if (!live) {
            try {
                live = stored
                    ? await this.resume(threadId, stored)
                    : await this.create(threadId, info, { anchorText: content });
            } catch (error) {
                this.log(threadId, 'error', { where: 'session-ensure', error: String(error?.stack ?? error).slice(0, 400) });
                return;
            }
        }

        const isFirstTurn = live.turnCount === 0;
        live.turnCount += 1;
        this.store.put(threadId, { turnCount: live.turnCount });
        if (isFirstTurn) {
            live.firstReplyPending = true;
            live.anchorText = content.slice(0, 500);
            this.store.put(threadId, { anchorMessageId: messageId, anchorText: live.anchorText });
        }
        this.startTyping(threadId);
        this.log(threadId, 'turn_start', { turn: live.turnCount, authorId: author.id, content: content.slice(0, 80) });

        const text = [
            `**Discord message from @${author.username}** (display name: ${author.displayName ?? author.username}, user id: ${author.id}) in the thread **${this.store.get(threadId)?.title ?? info.name ?? threadId}**`,
            '',
            content,
            '',
            replyInstruction(threadId),
        ].join('\n');
        if (text.length > this.config.maxPromptChars) {
            // Keep the tail (the reply instruction) intact; truncate the middle.
            text = `${text.slice(0, this.config.maxPromptChars)}\n\n(message truncated at ${this.config.maxPromptChars} characters)`;
        }
        live.handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: {
                kind: 'discord',
                channelId: threadId,
                messageId,
                authorId: author.id,
                form: 'notice',
                summary: `Discord message from @${author.username} in thread ${threadId}`,
            },
        }));
        trace('router', 'turn_relayed', { threadId, turn: live.turnCount });
    }

    /**
     * Create a fresh agent session for a thread and register its status hook.
     * @param {string} threadId
     * @param {object} info - channel info for the session title.
     * @param {object} [options] - anchorText for the temporary name.
     */
    async create(threadId, info, options = {}) {
        const ctx = this.ctx;
        const config = this.config;
        ctx.permissionPresets.resolve(config.permissionPreset);
        const preset = await ctx.agentPresets.resolve(config.agentPreset);
        const lease = await ctx.agentPresets.acquireScope(preset.id);
        try {
            const workspace = await ctx.workspaceRegistry.create(config.workspacePath);
            const title = capTitle(`Discord — ${info?.name ?? threadId}`, 80);
            const sessionId = brandString(`discord-t${threadId}-${randomUUID().slice(0, 8)}`);
            const selected = ctx.agentDefaultModel.currentSelection();
            const handle = await ctx.agents.create({
                sessionId,
                meta: { cwd: workspace.path, agentPreset: preset.id },
                agentOptions: { provider: selected.provider, model: selected.model },
                setup: async (agentCtx) => {
                    await ctx.agentPresets.mount(agentCtx, preset.id);
                    agentCtx.on('agent/status', ({ status }) => this.onAgentStatus(threadId, status));
                    this.installRouteOverride(agentCtx, threadId);
                },
            });
            await workspace.attachSession(sessionId);
            ctx.permissionPresets.set(handle.agent.session, config.permissionPreset);
            ctx.sessionTitle.rename(handle.agent.session, title);

            const tempNameValue = tempName(options.anchorText ?? info?.name ?? 'conversation');
            this.store.put(threadId, {
                sessionId,
                title: tempNameValue,
                tempName: tempNameValue,
                renamed: false,
                parentChannelId: info?.parent_id ?? null,
                turnCount: 0,
                createdAt: new Date().toISOString(),
            });
            const live = { sessionId, handle, status: 'idle', firstReplyPending: false, turnCount: 0 };
            this.live.set(threadId, live);
            this.log(threadId, 'session_created', { sessionId });
            return live;
        } finally {
            await lease[Symbol.asyncDispose]();
        }
    }

    /**
     * Resume a persisted session for a thread (restart survival).
     * @param {string} threadId
     * @param {object} stored - store entry.
     */
    async resume(threadId, stored) {
        const ctx = this.ctx;
        const config = this.config;
        ctx.permissionPresets.resolve(config.permissionPreset);
        const preset = await ctx.agentPresets.resolve(config.agentPreset);
        const lease = await ctx.agentPresets.acquireScope(preset.id);
        try {
            const selected = ctx.agentDefaultModel.currentSelection();
            const handle = await ctx.agents.resume({
                resumeSessionId: stored.sessionId,
                agentOptions: { provider: selected.provider, model: selected.model },
                setup: async (agentCtx) => {
                    await ctx.agentPresets.mount(agentCtx, preset.id);
                    agentCtx.on('agent/status', ({ status }) => this.onAgentStatus(threadId, status));
                    this.installRouteOverride(agentCtx, threadId);
                },
            });
            ctx.permissionPresets.set(handle.agent.session, config.permissionPreset);
            const live = { sessionId: stored.sessionId, handle, status: 'idle', firstReplyPending: false, turnCount: stored.turnCount ?? 1 };
            this.live.set(threadId, live);
            this.log(threadId, 'session_resumed', { sessionId: stored.sessionId });
            return live;
        } finally {
            await lease[Symbol.asyncDispose]();
        }
    }

    /**
     * Rewrite every resolved request route for this thread's agent from the
     * persisted /model and /effort overrides (the agent/request waterfall —
     * the same hook the webhook runtime uses to pin initial selection). Reads
     * the store per request, so a slash command applies immediately and
     * survives restarts.
     * @param {object} agentCtx - the agent's context.
     * @param {string} threadId
     */
    installRouteOverride(agentCtx, threadId) {
        agentCtx.on('agent/request', async (_event, next) => {
            const resolved = await next();
            const stored = this.store.get(threadId);
            if (!stored) return resolved;
            return applyRouteOverride(resolved, stored.modelOverride ?? undefined, stored.effortOverride === undefined ? undefined : stored.effortOverride);
        });
    }

    /** Agent status transitions: stop typing on idle; run the title flow after the first reply. */
    onAgentStatus(threadId, status) {
        const live = this.live.get(threadId);
        if (!live) return;
        live.status = status;
        if (status === 'idle') {
            this.stopTyping(threadId);
            this.log(threadId, 'turn_end', {});
            if (live.firstReplyPending) {
                live.firstReplyPending = false;
                void this.autoRename(threadId).catch(() => {});
            }
        }
    }

    /** Typing loop for a thread: repeat every ~8s until the turn ends. */
    startTyping(threadId) {
        if (this.typing.has(threadId)) return;
        const startedAt = Date.now();
        const timer = setInterval(async () => {
            if (Date.now() - startedAt > 10 * 60 * 1000) {
                this.stopTyping(threadId); // hard stop: never type forever
                return;
            }
            try {
                await this.client.triggerTyping(threadId);
            } catch {
                this.stopTyping(threadId);
            }
        }, 8000);
        // Fire once immediately.
        void this.client.triggerTyping(threadId).catch(() => {});
        this.typing.set(threadId, timer);
    }

    stopTyping(threadId) {
        const timer = this.typing.get(threadId);
        if (timer) {
            clearInterval(timer);
            this.typing.delete(threadId);
        }
    }

    /**
     * Auto-rename a thread once, after its first assistant reply. Uses one
     * cheap model call, cleans the result, falls back to the user's own
     * words, guarantees uniqueness, and only renames while the thread still
     * carries the temporary name. Never throws.
     * @param {string} threadId
     */
    async autoRename(threadId) {
        const stored = this.store.get(threadId);
        if (!stored || stored.renamed) return;
        this.log(threadId, 'rename_attempt', { mode: 'auto' });
        const title = await this.makeTitle(threadId, stored);
        if (title === null) return;
        await this.applyRename(threadId, stored, title, 'auto');
    }

    /** Generate + clean a title; returns null when nothing usable was produced. */
    async makeTitle(threadId, stored) {
        try {
            // One cheap model call; titleModel overrides the deployment's
            // default route ("provider:model" or a bare model id).
            const route = this.config.titleModel
                ? parseTitleModel(this.config.titleModel, this.ctx)
                : (() => { const s = this.ctx.agentDefaultModel.currentSelection(); return [s.provider, s.model]; })();
            const raw = await generateTitle(this.ctx, {
                provider: route[0],
                model: route[1],
                sessionId: stored.sessionId,
                text: stored.anchorText ?? '',
                timeoutMs: this.config.titleTimeoutMs ?? 20000,
            });
            let title = cleanTitle(raw, stored.anchorText ?? '');
            if (title.length === 0) {
                title = deriveFallbackTitle(stored.anchorText ?? '');
                this.log(threadId, 'rename_result', { outcome: 'fallback-derived', title: title.slice(0, 80) });
            }
            return title;
        } catch (error) {
            // Model path failed: derive from the user's own words, never a placeholder.
            this.log(threadId, 'error', { where: 'title-generate', error: String(error?.message ?? error).slice(0, 200) });
            const title = deriveFallbackTitle(stored.anchorText ?? '');
            this.log(threadId, 'rename_result', { outcome: 'fallback-derived', title: title.slice(0, 80) });
            return title;
        }
    }

    /**
     * Apply a title to a thread: uniqueness suffix, temporary-name guard,
     * Discord rename, store update. Never throws.
     * @param {string} threadId
     * @param {object} stored - store entry.
     * @param {string} title - cleaned title.
     * @param {string} mode - 'auto' | 'slash'.
     */
    async applyRename(threadId, stored, title, mode) {
        try {
            const unique = uniquifyTitle(title, threadId, () => this.store.titlesExcluding(threadId));
            // Manual renames win: only touch the thread while it still has the
            // temporary (or previously bot-set) name.
            let currentName = null;
            try {
                const channel = await this.client.getChannel(threadId);
                currentName = channel?.name ?? null;
            } catch {}
            if (mode === 'auto' && currentName !== null && currentName !== stored.tempName) {
                this.log(threadId, 'rename_result', { outcome: 'skipped-manual-rename', currentName: currentName.slice(0, 80) });
                this.store.put(threadId, { renamed: true, title: currentName });
                return;
            }
            await this.client.renameThread(threadId, unique, 'dsh-plugin-discord title');
            this.store.put(threadId, { renamed: true, title: unique });
            this.log(threadId, 'rename_result', { outcome: 'renamed', title: unique.slice(0, 80), mode });
        } catch (error) {
            // A failed rename never crashes the turn.
            this.log(threadId, 'rename_result', { outcome: 'failed', error: String(error?.message ?? error).slice(0, 200) });
        }
    }

    /**
     * Handle one slash-command interaction: /rename [title], /new, /reset.
     * @param {object} d - INTERACTION_CREATE payload.
     */
    async handleInteraction(d) {
        const name = d?.data?.name;
        const threadId = d?.channel?.id;
        if (!name || !threadId) return;
        // Commands carry at most one option; take its value whatever it's named.
        const arg = (d.data.options ?? [])[0]?.value ?? null;
        try {
            if (name === 'rename') {
                await this.client.deferInteraction(d);
                const stored = this.store.get(threadId);
                if (!stored) {
                    await this.client.editInteractionResponse(d, 'No agent session is attached to this thread.');
                    return;
                }
                if (arg !== null && String(arg).trim() !== '') {
                    const title = capTitle(cleanTitle(String(arg)) || String(arg).trim(), TITLE_MAX);
                    await this.applyRename(threadId, stored, title, 'slash');
                    await this.client.editInteractionResponse(d, `Renamed to “${this.store.get(threadId)?.title ?? title}”.`);
                    return;
                }
                // No argument: regenerate from the conversation.
                const title = await this.makeTitle(threadId, stored);
                if (title === null) {
                    await this.client.editInteractionResponse(d, 'Title generation failed.');
                    return;
                }
                await this.applyRename(threadId, stored, title, 'slash');
                await this.client.editInteractionResponse(d, `Renamed to “${this.store.get(threadId)?.title ?? title}”.`);
                return;
            }
            if (name === 'new' || name === 'reset') {
                const stored = this.store.get(threadId);
                if (stored) {
                    const live = this.live.get(threadId);
                    if (live) {
                        await live.handle.dispose().catch(() => {});
                        this.live.delete(threadId);
                    }
                    this.store.delete(threadId);
                    this.stopTyping(threadId);
                    this.log(threadId, 'session_cleared', { command: name });
                    await this.client.respondInteraction(d, 'Session cleared. Your next message starts a fresh session.');
                } else {
                    await this.client.respondInteraction(d, 'This thread has no agent session.');
                }
                return;
            }
            if (name === 'model') {
                await this.client.deferInteraction(d);
                const spec = arg !== null && String(arg).trim() !== '' ? String(arg).trim() : null;
                if (spec === null) {
                    const stored = this.store.get(threadId);
                    const current = stored?.modelOverride ?? '(deployment default)';
                    const menu = this.config.models.length > 0 ? `\nConfigured options: ${this.config.models.map((m) => '`' + m + '`').join(', ')}` : '';
                    await this.client.editInteractionResponse(d, `Model for this thread: **${current}**${menu}\nPass a model to switch, e.g. \`/model provider:model\`. Clears on /new.`);
                    return;
                }
                const stored = this.store.get(threadId);
                if (!stored) {
                    await this.client.editInteractionResponse(d, 'No agent session is attached to this thread yet — send a message first.');
                    return;
                }
                const [provider, model] = parseTitleModel(spec, this.ctx);
                this.store.put(threadId, { modelOverride: spec });
                this.log(threadId, 'model_override', { provider, model });
                await this.client.editInteractionResponse(d, `Model for this thread set to **${provider}:${model}**. Applies from the next turn.`);
                return;
            }
            if (name === 'effort') {
                await this.client.deferInteraction(d);
                const spec = arg !== null && String(arg).trim() !== '' ? String(arg).trim() : null;
                const stored = this.store.get(threadId);
                if (!stored) {
                    await this.client.editInteractionResponse(d, 'No agent session is attached to this thread yet — send a message first.');
                    return;
                }
                if (spec === null) {
                    const current = stored.effortOverride === undefined ? '(adapter default)' : stored.effortOverride === null ? '(cleared)' : `**${stored.effortOverride}**`;
                    await this.client.editInteractionResponse(d, `Reasoning effort for this thread: ${current}\nPass a level to set it (adapter-defined, e.g. minimal / low / medium / high), or \`clear\` to remove the override.`);
                    return;
                }
                const normalized = /^(clear|none|off)$/i.test(spec) ? null : spec;
                this.store.put(threadId, { effortOverride: normalized });
                this.log(threadId, 'effort_override', { effort: normalized });
                await this.client.editInteractionResponse(d, normalized === null
                    ? 'Reasoning-effort override cleared; the adapter default applies.'
                    : `Reasoning effort for this thread set to **${normalized}**. Applies from the next turn.`);
                return;
            }
            if (name === 'stop') {
                const live = this.live.get(threadId);
                if (!live) {
                    await this.client.respondInteraction(d, 'No running agent in this thread.');
                    return;
                }
                live.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
                this.log(threadId, 'turn_stopped', { command: 'stop' });
                await this.client.respondInteraction(d, 'Stopped. Queued messages are kept; the current turn was cancelled.');
                return;
            }
            await this.client.respondInteraction(d, `Unknown command “${name}”.`);
        } catch (error) {
            this.log(threadId, 'error', { where: 'interaction', command: name, error: String(error?.message ?? error).slice(0, 200) });
            try {
                await this.client.respondInteraction(d, `Command failed: ${String(error?.message ?? error).slice(0, 150)}`);
            } catch {}
        }
    }
}

/**
 * Apply a per-thread route override to one resolved request config.
 * `modelSpec` ("provider:model" / "provider/model" / bare model) replaces the
 * route; an absent spec keeps it. `effortSpec`: undefined = no change,
 * null = clear the override, string = set the reasoning effort.
 * @param {object} resolved - the proposed request config from the waterfall.
 * @param {string|null|undefined} modelSpec
 * @param {string|null|undefined} effortSpec
 * @returns {object} the rewritten config.
 */
export function applyRouteOverride(resolved, modelSpec, effortSpec) {
    const next = { ...resolved };
    if (typeof modelSpec === 'string' && modelSpec.trim() !== '') {
        const [provider, model] = parseTitleModel(modelSpec, { agentDefaultModel: { currentSelection: () => next } });
        next.provider = provider;
        next.model = model;
    }
    if (effortSpec === null) delete next.reasoningEffort;
    else if (typeof effortSpec === 'string' && effortSpec.trim() !== '') next.reasoningEffort = effortSpec.trim();
    return next;
}

/**
 * Parse a `title_model` config value: "provider:model" or "provider/model",
 * or a bare model id combined with the deployment's default provider.
 * @param {string} spec - config value.
 * @param {object} ctx - runtime context (for the default selection).
 * @returns {[string, string]} [provider, model]
 */
export function parseTitleModel(spec, ctx) {
    const value = String(spec ?? '').trim();
    const sepMatch = value.match(/^([a-zA-Z0-9_-]+)[:/](.+)$/);
    if (sepMatch) return [sepMatch[1], sepMatch[2]];
    const selected = ctx.agentDefaultModel.currentSelection();
    return [selected.provider, value];
}

/** Read a local file for attachment, with a size guard. */
export function readAttachment(path, maxBytes = 10 * 1024 * 1024) {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`not a file: ${basename(path)}`);
    if (stat.size > maxBytes) throw new Error(`file too large (${stat.size} bytes; limit ${maxBytes})`);
    return { buffer: readFileSync(path), filename: basename(path) };
}
