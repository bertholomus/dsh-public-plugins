/**
 * A scripted OpenAI-compatible chat-completions server for the suite's
 * real-DSH tests. It answers from markers in the conversation, so a test
 * says in its prompt what the "agent" does:
 *
 *   E2E:call <tool> <json>   call that tool with that JSON
 *   E2E:todos <json>         call todo_write with that list
 *   E2E:goal <objective>     call create_goal (the objective may carry round
 *                            scripts such as [r1=slow] or [r1=fail])
 *   E2E:slow                 start a reply and hold it open (a turn that keeps
 *                            running until the test lets go or DSH stops)
 *   E2E:fail                 refuse the request (the turn ends in an error)
 *   E2E:ask                  reply with a question for the person
 *   E2E:say <text>           reply with that text (\n in it starts a new line),
 *                            such as a DECISION NEEDED or BLOCKED line
 *
 * Flags anywhere in the person's messages script later turns:
 *
 *   #note=reply|progress|slow|fail   what a note from a suite plugin (a message
 *                                    starting "[Autopilot]") gets: a plain reply
 *                                    (default), one more todo done, a held
 *                                    reply, or a refused request
 *   #final=ask                       after a tool result, reply with a question
 *
 * A goal round (DSH's <goal_round> message) does what its objective's
 * [rN=...] says for round N (slow, fail, reply), else completes the goal:
 * get_goal, then update_goal complete. Every request is recorded.
 *
 * @module test/e2e/fake-model
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

const userText = (messages) => messages.filter((m) => m.role === 'user').map(textOf).join('\n');

/** The tool call a tool result answers: { name, args }. */
function callOf(messages, toolMessage) {
    for (let i = messages.length - 1; i >= 0; i--) {
        for (const call of messages[i].tool_calls ?? []) {
            if (call.id === toolMessage.tool_call_id) {
                let args = {};
                try {
                    args = JSON.parse(call.function?.arguments || '{}');
                } catch {}
                return { name: call.function?.name, args };
            }
        }
    }
    return { name: undefined, args: {} };
}

/** The newest todo list the agent wrote in this conversation. */
function lastTodos(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const call = (messages[i].tool_calls ?? []).findLast((c) => c.function?.name === 'todo_write');
        if (call) {
            try {
                return JSON.parse(call.function.arguments).todos ?? [];
            } catch {
                return [];
            }
        }
    }
    return [];
}

/** One more todo done, the next one started. */
function oneMoreDone(todos) {
    const next = todos.map((t) => ({ content: t.content, status: t.status }));
    const at = next.findIndex((t) => t.status !== 'completed');
    if (at >= 0) next[at].status = 'completed';
    const following = next.findIndex((t) => t.status === 'pending');
    if (following >= 0 && !next.some((t) => t.status === 'in_progress')) next[following].status = 'in_progress';
    return next;
}

const flag = (text, name) => new RegExp(`#${name}=(\\w+)`).exec(text)?.[1];

function decide(body) {
    const messages = body.messages ?? [];
    const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
    const all = userText(messages);
    const call = (tool, args) => (tools.has(tool) ? { tool, args } : { text: `MISSING TOOL ${tool}` });
    const last = messages.at(-1);
    if (last?.role === 'tool') {
        const done = callOf(messages, last);
        if (done.name === 'get_goal') {
            let goal;
            try {
                goal = JSON.parse(textOf(last)).goal;
            } catch {}
            if (goal?.id && goal.phase === 'active') return call('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' });
            return { text: 'There is no active goal to complete.' };
        }
        if (done.name === 'update_goal') return { text: 'The goal is complete.' };
        if (flag(all, 'final') === 'ask') return { text: 'Should I deploy it to staging or to production?' };
        return { text: `Done with ${done.name ?? 'that'}. Working through the list.` };
    }
    const fresh = freshText(messages);
    // A note from a suite plugin first: after a cut-off turn the person's own message is still "fresh" beside it.
    if (/\[Autopilot\]/.test(fresh)) {
        const how = flag(all, 'note') ?? 'reply';
        if (how === 'progress') return call('todo_write', { todos: oneMoreDone(lastTodos(messages)) });
        if (how === 'slow') return { slow: true };
        if (how === 'fail') return { fail: true };
        return { text: 'Still working on it.' };
    }
    if (fresh.includes('<goal_round>')) {
        // After a failed round its message is still "fresh" beside the next one: the newest round counts.
        const round = Number([...fresh.matchAll(/Round: (\d+)\//g)].at(-1)?.[1] ?? 0);
        const script = Object.fromEntries([...fresh.matchAll(/\[r(\d+)=(\w+)\]/g)].map((m) => [Number(m[1]), m[2]]));
        const how = script[round];
        if (how === 'slow') return { slow: true };
        if (how === 'fail') return { fail: true };
        if (how === 'reply') return { text: `Round ${round}: still going.` };
        return call('get_goal', {});
    }
    let m = /E2E:call (\w+) (.*)$/m.exec(fresh);
    if (m) return call(m[1], JSON.parse(m[2]));
    m = /E2E:todos (.*)$/m.exec(fresh);
    if (m) return call('todo_write', { todos: JSON.parse(m[1]) });
    m = /E2E:goal (.*)$/m.exec(fresh);
    if (m) return call('create_goal', { objective: m[1].trim(), max_goal_rounds: 6 });
    if (/E2E:slow/.test(fresh)) return { slow: true };
    if (/E2E:fail/.test(fresh)) return { fail: true };
    if (/E2E:ask/.test(fresh)) return { text: 'Which branch should I use for this?' };
    m = /E2E:say (.*)$/m.exec(fresh);
    if (m) return { text: m[1].replace(/\\n/g, '\n') };
    return { text: 'Plain reply.' };
}

function chunk(id, model, delta, finish, usage) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}),
    })}\n\n`;
}

/** Start the server on 127.0.0.1: { port, requests, held, release, close }. */
export async function startFakeModel({ models = ['fake-model'] } = {}) {
    const requests = [];
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
        const record = { n: requests.length + 1, at: Date.now(), tools: (body.tools ?? []).map((t) => t.function?.name), fresh: freshText(body.messages ?? []), action };
        requests.push(record);
        const id = `c${requests.length}`;
        const model = body.model ?? models[0];
        if (action.fail) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'E2E: the scripted model refused this request.', type: 'invalid_request_error', code: 'e2e_refused' } }));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (action.slow) {
            // A reply that keeps going: one word now, the rest when the test lets go (or never, when DSH stops first).
            res.write(chunk(id, model, { role: 'assistant', content: 'Working' }));
            const entry = {
                record,
                finish: () => {
                    held.delete(entry);
                    if (res.writableEnded || res.destroyed) return;
                    res.write(chunk(id, model, { content: ' on it, done now.' }));
                    res.write(chunk(id, model, {}, 'stop', usage));
                    res.write('data: [DONE]\n\n');
                    res.end();
                },
            };
            held.add(entry);
            res.on('close', () => held.delete(entry));
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
