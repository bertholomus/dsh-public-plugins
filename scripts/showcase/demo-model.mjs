/**
 * The scripted model in demo mode, for the showcase pictures (scripts/showcase.mjs).
 *
 * The test benches' scripted models answer from markers such as `E2E:say`
 * that the prompt carries. Here the prompts are ordinary requests, and the
 * model looks each one up in the demo script (scripts/showcase/demo.json):
 *
 *   turns   { prompt, think?, todos?, goal?, calls?, reply | slow | fail }
 *           a person's message that holds `prompt` gets that turn: a todo
 *           list first, then a goal, then each call in order (one per
 *           request), then the reply; `slow` holds the reply open until
 *           the bench lets go, `fail` refuses the request with that message
 *           (and the status `failStatus`, 400 by default: one DSH does not retry);
 *           a call's `wait` is how long, in ms, the model takes before it
 *           (so a thread's write can come after the other sessions in its
 *           folder have finished their turns); `capture` names patterns
 *           with one group, and `{{name}}` in a call's text arguments is
 *           that group's last match in the message the turn answers (the
 *           thread a relayed Discord message asks the reply to go to)
 *   notes   { match, progress?, calls?, reply } a message that a plugin or
 *           DSH writes (an Autopilot note, a Proof check, a goal round),
 *           found by the regular expression `match`; `progress` marks one
 *           more of the session's todos done before the reply
 *   titles  { match, title } the title for a side request (one with no tools)
 *
 * A `~/` at the start of a call's text argument is the demo home. Replies
 * stream in pieces at about `pace` tokens a second, with usage counted from
 * the request, so DSH's speed and token lines read like a real local model.
 * A message the script does not cover gets a reply that says so, and is
 * listed in `misses`, so a picture never shows it unnoticed.
 *
 * @module scripts/showcase/demo-model
 */
import { createServer } from 'node:http';

const textOf = (m) => (typeof m?.content === 'string' ? m.content
    : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? '').join('') : '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** About four characters a token, as for English text and code. */
const tokensOf = (text) => Math.max(1, Math.ceil(String(text).length / 4));

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

/** `~/…` in a call's text arguments, as the demo home. */
function expand(value, home) {
    if (typeof value === 'string') return value.startsWith('~/') ? `${home}${value.slice(1)}` : value;
    if (Array.isArray(value)) return value.map((v) => expand(v, home));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, home)]));
    return value;
}

/** `{{name}}` in a call's text arguments, as the last match of the turn's `capture` pattern `name` in `text`. */
function captured(value, capture, text) {
    if (!capture) return value;
    if (typeof value === 'string') {
        return value.replace(/\{\{(\w+)\}\}/g, (all, name) => (capture[name] ? [...text.matchAll(new RegExp(capture[name], 'g'))].at(-1)?.[1] ?? all : all));
    }
    if (Array.isArray(value)) return value.map((v) => captured(v, capture, text));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, captured(v, capture, text)]));
    return value;
}

/** The steps of a scripted turn: its calls in order, then how it ends. */
function stepsOf(spec, messages) {
    const steps = [];
    if (spec.todos) steps.push({ tool: 'todo_write', args: { todos: spec.todos.map(([content, status]) => ({ content, status })) } });
    if (spec.progress) steps.push({ tool: 'todo_write', args: { todos: oneMoreDone(lastTodos(messages)) } });
    if (spec.goal) steps.push({ tool: 'create_goal', args: { objective: spec.goal, max_goal_rounds: spec.rounds ?? 6 } });
    for (const call of spec.calls ?? []) steps.push(call);
    return steps;
}

/** The newest message a turn or note of the script answers, with the calls made since. */
function anchorOf(messages, script) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role !== 'user') continue;
        const text = textOf(messages[i]);
        const note = script.notes.find((n) => n.re.test(text));
        const spec = note ?? script.turns.find((t) => text.includes(t.prompt));
        if (!spec) continue;
        const made = messages.slice(i + 1).filter((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0).length;
        return { spec, made, text };
    }
    return undefined;
}

function decide(body, script, home) {
    const messages = body.messages ?? [];
    const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
    const person = messages.filter((m) => m.role === 'user').map(textOf);
    if (tools.size === 0) {
        // A side request (a session's title): the script's title, else the first words of the request.
        const first = person[0] ?? '';
        const titled = script.titles.find((t) => t.re.test(first));
        return { text: titled?.title ?? first.split(/\s+/).slice(0, 5).join(' ').replace(/[.,:;!?]+$/, '') };
    }
    const anchor = anchorOf(messages, script);
    if (!anchor) return { text: 'No demo reply is written for this message.', miss: person.at(-1) ?? '' };
    const steps = stepsOf(anchor.spec, messages);
    if (anchor.made < steps.length) {
        const step = steps[anchor.made];
        if (!tools.has(step.tool)) return { text: `No ${step.tool} tool in this session.`, miss: `tool ${step.tool}` };
        return { tool: step.tool, args: captured(expand(step.args, home), anchor.spec.capture, anchor.text), think: anchor.made === 0 ? anchor.spec.think : undefined, wait: step.wait };
    }
    if (anchor.spec.slow) return { slow: true, text: anchor.spec.reply ?? '' };
    if (anchor.spec.fail) return { fail: anchor.spec.fail, status: anchor.spec.failStatus ?? 400 };
    return { text: anchor.spec.reply ?? 'Done.', think: steps.length === 0 ? anchor.spec.think : undefined };
}

function chunk(id, model, delta, finish, usage) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}),
    })}\n\n`;
}

/** Usage as a local server reports it: the prompt counted from the request, most of it from the prompt cache. */
function usageOf(body, completion) {
    const prompt = tokensOf(JSON.stringify(body.messages ?? [])) + tokensOf(JSON.stringify(body.tools ?? []));
    const later = (body.messages ?? []).some((m) => m.role === 'assistant');
    const cached = Math.floor((prompt * (later ? 0.9 : 0.6)) / 64) * 64;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
}

/** Text in pieces, at about `pace` tokens a second. */
async function stream(res, id, model, field, text, pace) {
    const words = String(text).split(/(?<=\s)/);
    const pieces = Math.min(32, Math.max(2, Math.ceil(words.length / 4)));
    const per = Math.ceil(words.length / pieces);
    const total = Math.min(8000, Math.max(300, (tokensOf(text) / pace) * 1000));
    for (let i = 0; i < words.length; i += per) {
        if (res.destroyed) return;
        res.write(chunk(id, model, { ...(i === 0 ? { role: 'assistant' } : {}), [field]: words.slice(i, i + per).join('') }));
        await sleep(total / pieces);
    }
}

/**
 * Start the model on 127.0.0.1.
 *
 * @param {{ script: object, home: string, models?: string[], pace?: number }} options
 *   script: the parsed demo script; home: the demo home that `~/` stands for
 * @returns {Promise<{ port: number, requests: object[], misses: string[], held: Set<object>, release: () => void, close: () => Promise<void> }>}
 */
export async function startDemoModel({ script, home, models = ['local-model'], pace = 55 }) {
    const compiled = {
        turns: script.turns ?? [],
        notes: (script.notes ?? []).map((n) => ({ ...n, re: new RegExp(n.match, 'm') })),
        titles: (script.titles ?? []).map((t) => ({ ...t, re: new RegExp(t.match, 'i') })),
    };
    const requests = [];
    const misses = [];
    const held = new Set();
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
        const action = decide(body, compiled, home);
        if (action.miss !== undefined) misses.push(String(action.miss).slice(0, 200));
        requests.push({ n: requests.length + 1, at: Date.now(), tools: (body.tools ?? []).length, action: action.tool ?? (action.slow ? 'slow' : action.fail ? 'fail' : 'reply') });
        const id = `demo${requests.length}`;
        const model = body.model ?? models[0];
        if (action.fail) {
            res.writeHead(action.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: action.fail, type: action.status >= 500 ? 'server_error' : 'invalid_request_error' } }));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (action.wait) await sleep(action.wait);
        if (action.think) await stream(res, id, model, 'reasoning_content', action.think, pace * 2);
        if (action.slow) {
            // A turn that keeps running: its first words now, the rest when the bench lets go (or never).
            res.write(chunk(id, model, { role: 'assistant', content: action.text ? `${action.text.split(' ').slice(0, 3).join(' ')} ` : 'Working ' }));
            const entry = {
                finish: async () => {
                    held.delete(entry);
                    if (res.writableEnded || res.destroyed) return;
                    const rest = action.text ? action.text.split(' ').slice(3).join(' ') : 'on it.';
                    await stream(res, id, model, 'content', rest, pace);
                    res.write(chunk(id, model, {}, 'stop', usageOf(body, tokensOf(action.text))));
                    res.write('data: [DONE]\n\n');
                    res.end();
                },
            };
            held.add(entry);
            res.on('close', () => held.delete(entry));
            return;
        }
        if (action.tool) {
            await sleep(350);
            const args = JSON.stringify(action.args);
            res.write(chunk(id, model, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: action.tool, arguments: '' } }] }));
            // The arguments come at the text's pace too, so DSH's tok/s reads like a local model's.
            const pieces = Math.min(32, Math.max(2, Math.ceil(args.length / 40)));
            const size = Math.ceil(args.length / pieces);
            const total = Math.min(8000, Math.max(300, (tokensOf(args) / pace) * 1000));
            for (let i = 0; i < args.length; i += size) {
                if (res.destroyed) return;
                res.write(chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + size) } }] }));
                await sleep(total / pieces);
            }
            res.write(chunk(id, model, {}, 'tool_calls', usageOf(body, tokensOf(args) + 12)));
        } else {
            await stream(res, id, model, 'content', action.text, pace);
            res.write(chunk(id, model, {}, 'stop', usageOf(body, tokensOf(action.text) + tokensOf(action.think ?? ''))));
        }
        res.write('data: [DONE]\n\n');
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        requests,
        misses,
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
