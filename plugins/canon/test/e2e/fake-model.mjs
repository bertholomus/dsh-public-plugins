/**
 * A scripted OpenAI-compatible model for Canon's real-DSH test: it plays
 * the agent, and it records what each request carried, so the test can see
 * the block Canon added to a turn exactly as the model got it.
 *
 * The person's message says what its turn does:
 *
 *   E2E:turn {"calls":[{"tool":"canon_capture","args":{...}}, ...],"reply":"..."}
 *                      make each call in order (one per request), then reply;
 *                      a call whose tool is not offered gets the reply
 *                      "MISSING TOOL <name>" instead
 *   E2E:say <text>     reply with that text at once
 *
 * Every request is recorded: its model, the tools it offered, the person's
 * message it answers (the anchor), how many calls were made since, the
 * results of those calls, and Canon's blocks: every one in the request,
 * and the ones added for this prompt (after it, or in the same message when
 * a provider joins neighbouring messages).
 *
 * @module plugins/canon/test/e2e/fake-model
 */
import { createServer } from 'node:http';

/** The first words of every block Canon adds (lib/recall.js HEADER). */
export const CANON_HEAD = 'Background from the canon vault:';

const textOf = (m) => (typeof m?.content === 'string' ? m.content
    : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? '').join('') : '');

/** Canon's block in a message's text: from its first line on, or undefined. */
const blockIn = (text) => {
    const at = text.indexOf(CANON_HEAD);
    return at < 0 ? undefined : text.slice(at, at + 9000);
};

/** The newest person's message that scripts a turn: its index and text, and how many calls the agent made after it. */
function anchorOf(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role !== 'user') continue;
        const text = textOf(messages[i]);
        if (!/E2E:(turn|say) /.test(text)) continue;
        const after = messages.slice(i + 1);
        const made = after.filter((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0).length;
        return { index: i, text, made, results: after.filter((m) => m.role === 'tool').map(textOf) };
    }
    return undefined;
}

function decide(body) {
    const messages = body.messages ?? [];
    const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
    const turn = anchorOf(messages);
    if (!turn) return { text: 'Plain reply.' };
    const say = /E2E:say (.*)$/m.exec(turn.text);
    const script = /E2E:turn (.*)$/m.exec(turn.text);
    if (say && (!script || turn.text.lastIndexOf('E2E:say') > turn.text.lastIndexOf('E2E:turn'))) return { text: say[1].replace(/\\n/g, '\n'), turn };
    let parsed;
    try { parsed = JSON.parse(script[1]); } catch { return { text: 'BAD SCRIPT', turn }; }
    const calls = parsed.calls ?? [];
    if (turn.made < calls.length) {
        const c = calls[turn.made];
        return tools.has(c.tool) ? { tool: c.tool, args: c.args, turn } : { text: `MISSING TOOL ${c.tool}`, turn };
    }
    return { text: parsed.reply ?? 'Plain reply.', turn };
}

function chunk(id, model, delta, finish, usage) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}),
    })}\n\n`;
}

/** Start the server on 127.0.0.1: { port, requests, close }. */
export async function startCanonModel({ models = ['fake-model'] } = {}) {
    const requests = [];
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
            return;
        }
        let body = {};
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {}
        const messages = body.messages ?? [];
        const action = decide(body);
        const users = messages.map((m, i) => ({ i, m })).filter(({ m }) => m.role === 'user');
        const blocks = users.map(({ m }) => blockIn(textOf(m))).filter(Boolean);
        const anchor = action.turn;
        const fresh = anchor ? users.filter(({ i }) => i >= anchor.index).map(({ m }) => blockIn(textOf(m))).filter(Boolean) : [];
        const tools = (body.tools ?? []).map((t) => t.function?.name);
        requests.push({
            n: requests.length + 1,
            at: Date.now(),
            model: body.model,
            agent: tools.length > 0,
            tools,
            anchor: String(anchor?.text ?? '').slice(0, 600),
            made: anchor?.made ?? 0,
            results: anchor?.results ?? [],
            blocks,
            fresh,
            action: action.tool ? { tool: action.tool } : { text: String(action.text ?? '').slice(0, 120) },
        });
        const id = `c${requests.length}`;
        const model = body.model ?? models[0];
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
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}
