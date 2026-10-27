/**
 * A scripted chat-completions model for the Discord plugin's real-DSH test.
 * It answers from markers in the Discord message the plugin relays, so the
 * test says in the "person's" Discord message what the agent does:
 *
 *   E2E:reply <text>     send <text> with discord_send to the channel the
 *                        plugin's reply instruction names
 *   E2E:long <n>         send <n> characters (many lines) with discord_send
 *   E2E:file <path>      upload that file with discord_send_file
 *   E2E:to <id> <text>   send <text> to channel <id> (a channel of its own)
 *   E2E:react <id>       react with discord_react to message <id> in the thread
 *   E2E:escalate <cmd>   run <cmd> with bash, asking for wider access (an approval)
 *   E2E:silent <text>    answer <text> as plain text, without discord_send; after
 *                        the plugin's reminder it sends "<text> (after the
 *                        reminder)", unless the message also says #nudge=ignore
 *                        (a turn whose message has no E2E:silent sends "the
 *                        answer (after the reminder)")
 *   E2E:slow             start a plain reply and hold it open until released
 *   E2E:fail             refuse the request (the turn ends in an error)
 *
 * After a tool result it ends the turn with a short line. A title request
 * (the plugin's "Create a concise title" system prompt, or any request
 * without tools) gets a title made from the first words of the message. Every request is recorded with its
 * model id, tool names and fresh text.
 *
 * @module test/e2e/fake-model
 */
import { createServer } from 'node:http';

const textOf = (m) => (typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map((p) => p.text ?? '').join('') : '');

/**
 * Every user message after the last assistant message, joined, without the
 * plugin's header lines: the header names the thread, whose first name is
 * the message's own first words, so a marker would show there too.
 */
function freshText(messages) {
    const fresh = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'assistant'; i--) {
        if (messages[i].role === 'user') fresh.unshift(textOf(messages[i]));
    }
    return withoutHeaders(fresh.join('\n'));
}

const withoutHeaders = (text) => text.split('\n').filter((line) => !/^\*\*Discord message from /.test(line)).join('\n');

const userText = (messages) => messages.filter((m) => m.role === 'user').map(textOf).join('\n');

/** The channel the plugin asks the reply to go to (its reply instruction or its reminder). */
const replyChannel = (text) => [...text.matchAll(/channel_id "(\d+)"/g)].at(-1)?.[1];

/** A title: the message's first four words (markers left out). */
function titleFor(text) {
    const words = text.replace(/E2E:\w+/g, ' ').match(/[A-Za-z][A-Za-z'-]*/g) ?? ['Discord', 'conversation'];
    return words.slice(0, 4).join(' ');
}

function longText(n) {
    const lines = [];
    let size = 0;
    for (let i = 1; size < n; i++) {
        const line = `Line ${i}: ${'lorem ipsum '.repeat(6).trim()}`;
        lines.push(line);
        size += line.length + 1;
    }
    return lines.join('\n').slice(0, n);
}

function decide(body) {
    const messages = body.messages ?? [];
    const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
    const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map(textOf).join('\n');
    // A title request (the plugin's, or any call without tools, such as DSH's own session titles): a title, never a tool call.
    if (/Create a concise title/.test(system) || tools.size === 0) return { text: titleFor(userText(messages)), title: true };
    const call = (tool, args) => (tools.has(tool) ? { tool, args } : { text: `MISSING TOOL ${tool}` });
    const last = messages.at(-1);
    if (last?.role === 'tool') return { text: 'Sent.' };
    const fresh = freshText(messages);
    const all = userText(messages);
    const channel = replyChannel(fresh) ?? replyChannel(all);
    if (/Your reply has not reached Discord yet/.test(fresh)) {
        // The plugin's reminder: what to do comes from this turn's Discord message (the newest one relayed).
        const turn = withoutHeaders(messages.filter((m) => m.role === 'user').map(textOf).findLast((x) => x.includes('Discord message from')) ?? '');
        if (/#nudge=ignore/.test(turn)) return { text: 'Still only plain text, never sent.' };
        const said = /E2E:silent (.*)$/m.exec(turn)?.[1]?.replace(/\s*#nudge=\w+/, '') ?? 'the answer';
        return call('discord_send', { channel_id: channel, content: `${said} (after the reminder)` });
    }
    let m = /E2E:reply (.*)$/m.exec(fresh);
    if (m) return call('discord_send', { channel_id: channel, content: m[1] });
    m = /E2E:long (\d+)/.exec(fresh);
    if (m) return call('discord_send', { channel_id: channel, content: longText(Number(m[1])) });
    m = /E2E:file (\S+)/.exec(fresh);
    if (m) return call('discord_send_file', { channel_id: channel, path: m[1], caption: 'Here is the file.' });
    m = /E2E:escalate (.*)$/m.exec(fresh);
    if (m) return call('bash', { description: 'Run a command with wider access', command: m[1], sandbox_permissions: 'danger-full-access', justification: 'The test asks for wider access to see the approval reach Discord.' });
    m = /E2E:react (\S+)/.exec(fresh);
    if (m) return call('discord_react', { channel_id: channel, message_id: m[1], emoji: '\u{1F44D}' });
    m = /E2E:to (\d+) (.*)$/m.exec(fresh);
    if (m) return call('discord_send', { channel_id: m[1], content: m[2] });
    m = /E2E:silent (.*)$/m.exec(fresh);
    if (m) return { text: m[1] };
    if (/E2E:slow/.test(fresh)) return { slow: true };
    if (/E2E:fail/.test(fresh)) return { fail: true };
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
        const record = {
            n: requests.length + 1, at: Date.now(), model: body.model, effort: body.reasoning_effort ?? null,
            tools: (body.tools ?? []).map((t) => t.function?.name), fresh: freshText(body.messages ?? []), action,
        };
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
