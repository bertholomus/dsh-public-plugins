/**
 * A scripted OpenAI-compatible model for Proof's real-DSH test. It plays
 * two parts:
 *
 * The agent in an ordinary session. The person's message says what its turn
 * does:
 *
 *   E2E:turn {"calls":[{"tool":"bash","args":{...}}, ...],"reply":"..."}
 *                      make each call in order (one per request), then reply;
 *                      a call with "optional": true only when its tool is offered
 *   E2E:say <text>     reply with that text at once (\n starts a new line)
 *
 * The model of one of Proof's check threads (its first message starts
 * "Proof check."). It follows the check plan whose `match` that message
 * contains (`setPlan`), the same way: `{ calls, reply }`, or `{ slow: true }`
 * to hold the reply open until the test lets go or DSH stops the turn.
 *
 * Every request is recorded: its model, the reasoning effort it asked for
 * (none for a model without efforts), the tools it offered, and the first
 * words of the message it answers.
 *
 * @module plugins/proof/test/e2e/fake-model
 */
import { createServer } from 'node:http';

const textOf = (m) => (typeof m?.content === 'string' ? m.content
    : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? '').join('') : '');

/** The newest person's message that scripts a turn, and how many calls the agent made after it. */
function anchorOf(messages, test) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role !== 'user' || !test(textOf(messages[i]))) continue;
        const made = messages.slice(i + 1).filter((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0).length;
        return { text: textOf(messages[i]), made };
    }
    return undefined;
}

function decide(body, plans) {
    const messages = body.messages ?? [];
    const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
    const call = (c) => (tools.has(c.tool) ? { tool: c.tool, args: c.args } : { text: `MISSING TOOL ${c.tool}` });
    // A call marked optional is made only when the tool is offered (the same tools on each request of a thread).
    const follow = (script, made) => {
        const calls = (script.calls ?? []).filter((c) => !c.optional || tools.has(c.tool));
        return made < calls.length ? call(calls[made]) : { text: script.reply ?? 'Plain reply.' };
    };
    const check = anchorOf(messages, (t) => t.includes('Proof check.'));
    if (check) {
        const plan = plans.find((p) => check.text.includes(p.match));
        if (!plan) return { text: 'NOT VERIFIED: the test gave this check no plan.', anchor: check.text };
        if (plan.slow) return { slow: true, anchor: check.text };
        return { ...follow(plan, check.made), anchor: check.text };
    }
    const turn = anchorOf(messages, (t) => /E2E:(turn|say) /.test(t));
    if (!turn) return { text: 'Plain reply.' };
    const say = /E2E:say (.*)$/m.exec(turn.text);
    const script = /E2E:turn (.*)$/m.exec(turn.text);
    // The newest marker in the message wins, so a later message can say instead of run.
    if (say && (!script || turn.text.lastIndexOf('E2E:say') > turn.text.lastIndexOf('E2E:turn'))) return { text: say[1].replace(/\\n/g, '\n'), anchor: turn.text };
    let parsed;
    try { parsed = JSON.parse(script[1]); } catch { return { text: 'BAD SCRIPT', anchor: turn.text }; }
    return { ...follow(parsed, turn.made), anchor: turn.text };
}

function chunk(id, model, delta, finish, usage) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}),
    })}\n\n`;
}

/** Start the server on 127.0.0.1: { port, requests, setPlan, held, release, close }. */
export async function startProofModel({ models = ['fake-model', 'fake-check'] } = {}) {
    const requests = [];
    const plans = [];
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
        const action = decide(body, plans);
        const record = {
            n: requests.length + 1,
            at: Date.now(),
            model: body.model,
            effort: body.reasoning_effort ?? body.reasoning?.effort,
            tools: (body.tools ?? []).map((t) => t.function?.name),
            anchor: String(action.anchor ?? '').slice(0, 400),
            action: action.tool ? { tool: action.tool } : action.slow ? { slow: true } : { text: String(action.text ?? '').slice(0, 120) },
        };
        requests.push(record);
        const id = `c${requests.length}`;
        const model = body.model ?? models[0];
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (action.slow) {
            res.write(chunk(id, model, { role: 'assistant', content: 'Checking' }));
            const entry = {
                record,
                finish: () => {
                    held.delete(entry);
                    if (res.writableEnded || res.destroyed) return;
                    res.write(chunk(id, model, { content: ' it now.\nNOT VERIFIED: it was let go before it could look.' }));
                    res.write(chunk(id, model, {}, 'stop', usage));
                    res.write('data: [DONE]\n\n');
                    res.end();
                },
            };
            held.add(entry);
            res.on('close', () => {
                held.delete(entry);
                record.closed = Date.now();
            });
            record.held = true;
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
        /** What a check thread whose message contains `match` does; a later plan for the same match replaces it. */
        setPlan(match, plan) {
            const at = plans.findIndex((p) => p.match === match);
            if (at >= 0) plans.splice(at, 1);
            plans.push({ match, ...plan });
        },
        held,
        /** Let every held reply finish. */
        release: () => {
            for (const entry of [...held]) entry.finish();
        },
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}
