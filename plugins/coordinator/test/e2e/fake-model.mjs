/**
 * A scripted OpenAI-compatible chat-completions server for the real-host
 * end-to-end test. It answers from markers in the newest user text, so the
 * test drives every session by what it sends:
 *
 *   E2E:call <tool> <json args>   call that tool (the rest of the line is the JSON); one such line
 *                                 each for several calls in one step
 *   E2E:force <tool> <json args>  call it even if the session is not offered it
 *   E2E:fail                      answer HTTP 400, so the turn fails
 *   …asked you to try again/continue  (Retry or Resume from the window) reply RESUMED
 *   Carry on from where you left off and finish the task.  (the plugin's nudge after a failed turn) reply NUDGED at once,
 *                                 unless E2E:fail is there too
 *   E2E:slow <ms>                 on a line of its own: answer after that long
 *   [Handback from thread …       reply SAW-HANDBACK
 *   [Thread idle without …        reply SAW-IDLE
 *   [Thread waiting for approval… reply SAW-APPROVAL
 *   [Message from the chat …      reply SAW-MESSAGE
 *   [Reply from …                 reply SAW-REPLY
 *   anything else                 reply "Plain reply."
 *
 * After a tool result it replies "TOOL-RESULT: <result>", which ends the turn.
 * Every request is recorded (model, effort, tool names, system text, the user
 * text since the last assistant message, action, arrival time) for the test
 * to check.
 *
 * @module dsh-plugin-coordinator/test/e2e/fake-model
 */
import { createServer } from 'node:http';

const textOf = (m) => (typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map((p) => p.text ?? '').join('') : '');

/** Every user message after the last assistant message, joined. */
function freshText(messages) {
    const fresh = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'assistant'; i--) {
        if (messages[i].role === 'user') fresh.unshift(textOf(messages[i]));
    }
    return fresh.join('\n');
}

/** Decide one answer from the request body. */
function decide(body, text) {
    const messages = body.messages ?? [];
    const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
    const last = messages.at(-1);
    if (last?.role === 'tool') return { text: `TOOL-RESULT: ${textOf(last).slice(0, 2000)}` };
    // Retry or Resume from the DSH window: the thread picks the work back up, whatever failed before.
    if (/The user asked you to (try again|continue)\./.test(text)) return { text: 'RESUMED' };
    const calls = [...text.matchAll(/E2E:call (\w+) (.*)$/gm)];
    if (calls.length > 0) {
        const missing = calls.find((c) => !tools.has(c[1]));
        if (missing) return { text: `MISSING TOOL ${missing[1]}` };
        const [first, ...more] = calls.map((c) => ({ tool: c[1], args: JSON.parse(c[2]) }));
        return more.length > 0 ? { ...first, more } : first;
    }
    const force = /E2E:force (\S+) (.*)$/m.exec(text);
    if (force) return { tool: force[1], args: JSON.parse(force[2]) };
    if (text.includes('E2E:fail')) return { fail: true };
    // The plugin's nudge after a failed or stopped turn: it carries on at once, whatever made the turn slow.
    if (text.includes('Carry on from where you left off and finish the task.')) return { text: 'NUDGED', nudge: true };
    if (text.includes('[Handback from thread')) return { text: 'SAW-HANDBACK' };
    if (text.includes('[Thread idle without a handback')) return { text: 'SAW-IDLE' };
    if (text.includes('[Thread waiting for approval')) return { text: 'SAW-APPROVAL' };
    if (text.includes('[Message from the chat')) return { text: 'SAW-MESSAGE' };
    if (text.includes('[Reply from')) return { text: 'SAW-REPLY' };
    return { text: 'Plain reply.' };
}

function chunk(id, model, delta, finish, usage) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}),
    })}\n\n`;
}

/**
 * Start the server on 127.0.0.1.
 * @param {object} [options]
 * @param {number} [options.port] - 0 picks a free port.
 * @param {string[]} [options.models] - model ids to list.
 * @returns {Promise<{port: number, requests: object[], close: () => Promise<void>}>}
 */
export async function startFakeModel({ port = 0, models = ['fake-model', 'fake-flash'] } = {}) {
    const requests = [];
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
            return;
        }
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        const messages = body.messages ?? [];
        const fresh = freshText(messages);
        const action = decide(body, fresh);
        requests.push({
            n: requests.length + 1,
            model: body.model,
            effort: body.reasoning_effort,
            tools: (body.tools ?? []).map((t) => t.function?.name),
            system: messages.filter((m) => m.role === 'system' || m.role === 'developer').map(textOf).join('\n---\n'),
            fresh,
            action,
            at: Date.now(),
        });
        const slow = action.nudge ? null : /^E2E:slow (\d+)$/m.exec(fresh);
        if (slow) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, Number(slow[1]));
                res.once('close', () => { clearTimeout(timer); resolve(); });
            });
            if (req.socket.destroyed) return;
        }
        if (action.fail) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'fake model rejected the request', type: 'invalid_request_error' } }));
            return;
        }
        const id = `c${requests.length}`;
        const model = body.model ?? models[0];
        const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (action.tool) {
            const calls = [action, ...(action.more ?? [])];
            res.write(chunk(id, model, { role: 'assistant', content: null, tool_calls: calls.map((c, i) => ({ index: i, id: i === 0 ? `call_${id}` : `call_${id}_${i}`, type: 'function', function: { name: c.tool, arguments: '' } })) }));
            res.write(chunk(id, model, { tool_calls: calls.map((c, i) => ({ index: i, function: { arguments: JSON.stringify(c.args) } })) }));
            res.write(chunk(id, model, {}, 'tool_calls', usage));
        } else {
            res.write(chunk(id, model, { role: 'assistant', content: action.text }));
            res.write(chunk(id, model, {}, 'stop', usage));
        }
        res.write('data: [DONE]\n\n');
        res.end();
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        requests,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    };
}
