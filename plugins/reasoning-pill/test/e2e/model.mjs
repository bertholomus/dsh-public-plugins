/**
 * The Reasoning pill's scripted model: the repository's chat-completions stand-in (test/e2e/fake-model.mjs) plus one
 * tool call, so the real-DSH test can open a subagent's chat. Every request is recorded with the model, the reasoning
 * effort DSH sent and the tools it offered.
 *
 *   E2E:spawn        the reply is a call to DSH's `subagent` tool whose prompt is "E2E:say child done"
 *   E2E:say <text>   reply with that text
 *   anything else    "Plain reply." (also the reply after a tool result)
 *
 * @module plugins/reasoning-pill/test/e2e/model
 */
import { createServer } from 'node:http';

const textOf = (m) => (typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map((p) => p.text ?? '').join('') : '');

/** The person's newest words: user messages after the last assistant message; none after a tool result. */
function freshText(messages) {
    const fresh = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'assistant'; i--) {
        if (messages[i].role === 'tool') return '';
        if (messages[i].role === 'user') fresh.unshift(textOf(messages[i]));
    }
    return fresh.join('\n');
}

function chunk(id, model, delta, finish, usage) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}),
    })}\n\n`;
}

/** Arguments for DSH's `subagent` tool, from the schema DSH sent: the task and its label, other required fields filled. */
function spawnArgs(tool) {
    const schema = tool?.function?.parameters ?? tool?.parameters ?? {};
    const args = { description: 'Reasoning child task', prompt: 'E2E:say child done' };
    for (const key of schema.required ?? []) {
        if (key in args) continue;
        const type = schema.properties?.[key]?.type;
        args[key] = type === 'boolean' ? false : type === 'number' || type === 'integer' ? 1 : schema.properties?.[key]?.enum?.[0] ?? 'general';
    }
    return args;
}

/** Start the server on 127.0.0.1: { port, requests, close }. */
export async function startModel() {
    const requests = [];
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    const server = createServer(async (req, res) => {
        const parts = [];
        for await (const c of req) parts.push(c);
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [] }));
            return;
        }
        let body = {};
        try {
            body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        } catch {}
        const text = freshText(body.messages ?? []);
        const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
        requests.push({
            n: requests.length + 1, at: Date.now(), model: body.model, text, tools,
            effort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
            body: { reasoning_effort: body.reasoning_effort, reasoning: body.reasoning, thinking: body.thinking },
        });
        const id = `c${requests.length}`;
        const model = body.model ?? 'fake-model';
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (/E2E:spawn/.test(text) && tools.includes('subagent')) {
            const tool = (body.tools ?? []).find((t) => (t.function?.name ?? t.name) === 'subagent');
            const call = { index: 0, id: `call_${id}`, type: 'function', function: { name: 'subagent', arguments: JSON.stringify(spawnArgs(tool)) } };
            res.write(chunk(id, model, { role: 'assistant', content: null, tool_calls: [call] }));
            res.write(chunk(id, model, {}, 'tool_calls', usage));
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        // A subagent's prompt arrives with DSH's note about its parent run on after it ("…child doneYour parent…").
        const say = /E2E:say ([^"\n]*)/.exec(text)?.[1]?.replace(/Your parent.*$/, '').trim() || 'Plain reply.';
        res.write(chunk(id, model, { role: 'assistant', content: say }));
        res.write(chunk(id, model, {}, 'stop', usage));
        res.write('data: [DONE]\n\n');
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        requests,
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}
