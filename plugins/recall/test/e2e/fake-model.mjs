/**
 * A scripted OpenAI-compatible model for Recall's real-DSH test: it plays
 * the agent in ordinary sessions. The person's message says what its turn
 * does:
 *
 *   E2E:say <text>        reply with that text at once (\n starts a new line)
 *   E2E:tall <n> <text>   reply with that text, then n more lines (a tall turn in the chat)
 *   E2E:hang <text>       never answer: the turn runs until it is stopped, or DSH stops under it
 *   E2E:turn {"calls":[{"tool":"bash","args":{...}}, ...],"reply":"..."}
 *                         make each call in order (one per request), then reply;
 *                         "$FIRST_ID" in an argument is the first result id
 *                         ("id 12.4") in the newest tool result
 *
 * Every request is recorded: its model, the tools it offered, the first
 * words of the message it answers, and the newest tool result it saw.
 *
 * @module plugins/recall/test/e2e/fake-model
 */
import { createServer } from 'node:http';

const textOf = (m) => (typeof m?.content === 'string' ? m.content
    : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? '').join('') : '');

/** The newest person's message that scripts a turn, and how many calls the agent made after it. */
function anchorOf(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role !== 'user' || !/E2E:(turn|say|tall|hang) /.test(textOf(messages[i]))) continue;
        const made = messages.slice(i + 1).filter((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0).length;
        return { text: textOf(messages[i]), made };
    }
    return undefined;
}

/** The newest tool result's text. */
const lastResult = (messages) => textOf([...messages].reverse().find((m) => m.role === 'tool'));

function decide(body) {
    const messages = body.messages ?? [];
    const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
    const turn = anchorOf(messages);
    if (!turn) return { text: 'Plain reply.' };
    if (/E2E:hang /.test(turn.text)) return { hang: true, anchor: turn.text };
    const say = /E2E:say (.*)$/m.exec(turn.text);
    if (say) return { text: say[1].replace(/\\n/g, '\n'), anchor: turn.text };
    const tall = /E2E:tall (\d+) (.*)$/m.exec(turn.text);
    if (tall) {
        const lines = Array.from({ length: Number(tall[1]) }, (_, i) => `Line ${i + 1} of the reply: ${tall[2]}`);
        return { text: [tall[2], '', ...lines].join('\n'), anchor: turn.text };
    }
    let script;
    try { script = JSON.parse(/E2E:turn (.*)$/m.exec(turn.text)[1]); } catch { return { text: 'BAD SCRIPT', anchor: turn.text }; }
    const calls = script.calls ?? [];
    if (turn.made >= calls.length) return { text: script.reply ?? 'Plain reply.', anchor: turn.text };
    const c = calls[turn.made];
    if (!tools.has(c.tool)) return { text: `MISSING TOOL ${c.tool}`, anchor: turn.text };
    const firstId = /\bid (\d+\.\d+)\b/.exec(lastResult(messages))?.[1] ?? 'none';
    const args = JSON.parse(JSON.stringify(c.args ?? {}).replaceAll('$FIRST_ID', firstId));
    return { tool: c.tool, args, anchor: turn.text };
}

function chunk(id, model, delta, finish, usage) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}),
    })}\n\n`;
}

/** Start the server on 127.0.0.1: { port, requests, close }. */
export async function startRecallModel({ models = ['fake-model'] } = {}) {
    const requests = [];
    /** Answers held open for E2E:hang, until DSH closes them (a stop, or DSH gone) or the model closes. */
    const held = new Set();
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
        const action = decide(body);
        requests.push({
            n: requests.length + 1,
            at: Date.now(),
            model: body.model,
            tools: (body.tools ?? []).map((t) => t.function?.name),
            anchor: String(action.anchor ?? '').slice(0, 400),
            result: lastResult(body.messages ?? []).slice(0, 4000),
            action: action.tool ? { tool: action.tool, args: action.args } : action.hang ? { hang: true } : { text: String(action.text ?? '').slice(0, 120) },
        });
        const id = `c${requests.length}`;
        const model = body.model ?? models[0];
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (action.hang) {
            held.add(res);
            res.on('close', () => held.delete(res));
            return;
        }
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
            for (const res of held) res.destroy();
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}
