/**
 * One-shot cheap-model call used for thread titles: a framed single-user
 * message streamed through the host `llm` runtime and assembled into text.
 * DSH's message helpers come in through `host`, so tests can run it.
 *
 * @module dsh-plugin-discord/llm
 */

/**
 * Generate a short title for a conversation starter.
 * @param {object} ctx - runtime context with the `llm` service.
 * @param {{ createUserMessage: Function, BlockAssembler: Function }} host - DSH's llm helpers.
 * @param {object} options
 * @param {string} options.provider - LLM provider id.
 * @param {string} options.model - model id.
 * @param {string} options.sessionId - session the call is attributed to.
 * @param {string} options.text - the conversation starter text.
 * @param {number} [options.timeoutMs] - call deadline.
 * @returns {Promise<string>} raw model text (cleaned by the caller).
 */
export async function generateTitle(ctx, host, { provider, model, sessionId, text, timeoutMs = 20000 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`the title model did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    try {
        const messages = [host.createUserMessage({
            content: [{ type: 'text', text: text || '(no text)' }],
            source: { kind: 'discord-plugin' },
        })];
        const system = [
            'Create a concise title for an AI coding-assistant conversation from the supplied first message.',
            'Return only the title on one line, in plain natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
            'Use the language of the message.',
            'Aim for 3 to 7 words.',
        ].join('\n');
        const assembler = new host.BlockAssembler();
        for await (const chunk of ctx.llm.stream({
            provider,
            model,
            messages,
            system,
            maxTokens: 64,
            sessionId,
            purpose: 'discord-thread-title',
            signal: controller.signal,
        })) {
            controller.signal.throwIfAborted();
            assembler.push(chunk);
        }
        const finish = assembler.finish;
        if (finish && finish.kind === 'error') {
            throw new Error(`the title model failed (${String(finish.error?.message ?? finish.message ?? 'no reason given').slice(0, 160)})`);
        }
        const title = assembler.blocks()
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(' ');
        if (title.trim().length === 0) throw new Error('the title model gave no text');
        return title;
    } finally {
        clearTimeout(timer);
    }
}
