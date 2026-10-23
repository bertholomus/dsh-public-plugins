/**
 * A scripted OpenAI-compatible chat-completions server for the calendar's
 * real-host test. It answers from a marker in the newest user text:
 *
 *   E2E:call <tool> <json args>   call that tool (the rest of the line is the JSON)
 *   anything else                 reply "Plain reply."
 *
 * After a tool result it replies "TOOL-RESULT: <result>", which ends the
 * turn. Every request is recorded (tool names offered, the user text) for
 * the test to check.
 *
 * @module dsh-plugin-calendar/test/e2e/fake-model
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

function decide(body, text) {
    const messages = body.messages ?? [];
    const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
    const last = messages.at(-1);
    if (last?.role === 'tool') return { text: `TOOL-RESULT: ${textOf(last).slice(0, 4000)}` };
    const call = /E2E:call (\w+) (.*)$/m.exec(text);
    if (call) {
        if (!tools.has(call[1])) return { text: `MISSING TOOL ${call[1]}` };
        return { tool: call[1], args: JSON.parse(call[2]) };
    }
    return { text: 'Plain reply.' };
}

function chunk(id, model, delta, finish, usage) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}),
    })}\n\n`;
}

/** Start the server on 127.0.0.1: {port, requests, close}. */
export async function startFakeModel({ models = ['fake-model'] } = {}) {
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
        const fresh = freshText(body.messages ?? []);
        const action = decide(body, fresh);
        requests.push({ n: requests.length + 1, tools: (body.tools ?? []).map((t) => t.function?.name), fresh, action });
        const id = `c${requests.length}`;
        const model = body.model ?? models[0];
        const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (action.tool) {
            res.write(chunk(id, model, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: action.tool, arguments: '' } }] }));
            res.write(chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(action.args) } }] }));
            res.write(chunk(id, model, {}, 'tool_calls', usage));
        } else {
            res.write(chunk(id, model, { role: 'assistant', content: action.text }));
            res.write(chunk(id, model, {}, 'stop', usage));
        }
        res.write('data: [DONE]\n\n');
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        requests,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    };
}
