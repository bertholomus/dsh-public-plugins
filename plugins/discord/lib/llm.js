/**
 * One-shot cheap-model call used for thread titles. Mirrors the
 * dsh-session-title-llm pattern: a framed single-user-message request streamed
 * through the host `llm` runtime and assembled into text.
 *
 * @module dsh-plugin-discord/llm
 */
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';

/**
 * Generate a short title for a conversation starter.
 * @param {object} ctx - runtime context with the `llm` service.
 * @param {object} options
 * @param {string} options.provider - LLM provider id.
 * @param {string} options.model - model id.
 * @param {string} options.sessionId - session the call is attributed to.
 * @param {string} options.text - the conversation starter text.
 * @param {number} [options.timeoutMs] - call deadline.
 * @returns {Promise<string>} raw model text (cleaned by the caller).
 */
export async function generateTitle(ctx, { provider, model, sessionId, text, timeoutMs = 20000 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('title generation timed out')), timeoutMs);
    try {
        const messages = [createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'discord-plugin' },
        })];
        const system = [
            'Create a concise title for an AI coding-assistant conversation from the supplied first message.',
            'Return only the title on one line, in plain natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
            'Use the language of the message.',
            'Aim for 3 to 7 words.',
        ].join('\n');
        const assembler = new BlockAssembler();
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
            throw new Error(`title stream failed: ${JSON.stringify(finish).slice(0, 200)}`);
        }
        const text2 = assembler.blocks()
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(' ');
        if (text2.trim().length === 0) throw new Error('title model produced no text');
        return text2;
    } finally {
        clearTimeout(timer);
    }
}
