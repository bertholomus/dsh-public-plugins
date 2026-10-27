/**
 * The Discord client against the fake Discord (REST and Gateway on
 * 127.0.0.1): identify, heartbeats, resume on Discord's resume address with
 * missed events replayed, reconnect after every kind of drop, the faults that
 * are never retried, the startup lookup retried through a network fault,
 * rate limits, splitting, uploads, slash-command registration, and handler
 * faults that never reach the host.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiscordClient, DEFAULT_INTENTS } from '../../lib/client.js';
import { startFakeDiscord, waitFor } from '../support/fake-discord.mjs';

const quiet = () => {
    const lines = [];
    return { lines, logger: { info: (...a) => lines.push(['info', ...a]), warn: (...a) => lines.push(['warn', ...a]), debug() {} } };
};

async function connected(options = {}) {
    const fake = await startFakeDiscord({ heartbeatMs: options.heartbeatMs ?? 45000 });
    const got = { messages: [], interactions: [], readies: [] };
    const { lines, logger } = quiet();
    const client = new DiscordClient({
        token: options.token ?? fake.token,
        apiBase: fake.apiBase,
        logger,
        maxBackoffMs: 40,
        requestTimeoutMs: 2000,
        onMessage: options.onMessage ?? ((d) => got.messages.push(d)),
        onInteraction: (d) => got.interactions.push(d),
        onReady: (info) => got.readies.push(info),
    });
    return { fake, client, got, lines };
}

test('start: finds the gateway, identifies with the token and intents, READY names the bot', async () => {
    const { fake, client, got } = await connected();
    try {
        await client.start();
        assert.equal(client.botUser.id, fake.bot.id);
        assert.equal(fake.gateway.identifies.length, 1);
        assert.equal(fake.gateway.identifies[0].token, fake.token);
        assert.equal(fake.gateway.identifies[0].intents, DEFAULT_INTENTS);
        assert.ok(DEFAULT_INTENTS & (1 << 15), 'asks for the message content intent');
        assert.deepEqual(got.readies, [{ resumed: false, sessionId: fake.gateway.sessionId }]);
        assert.equal(client.state.connected, true);
        assert.equal(fake.calls('GET', '/gateway/bot')[0].auth, `Bot ${fake.token}`);
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('a dispatched message reaches onMessage; a throwing or rejecting handler is logged, never thrown', async () => {
    let calls = 0;
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const { fake, client, lines } = await connected({
        onMessage: (d) => {
            calls += 1;
            if (d.content === 'throw') throw new Error('sync boom');
            return Promise.reject(new Error('async boom'));
        },
    });
    try {
        await client.start();
        const channel = fake.addChannel({});
        const person = fake.addUser({});
        fake.userMessage({ channelId: channel.id, author: person, content: 'throw' });
        fake.userMessage({ channelId: channel.id, author: person, content: 'reject' });
        await waitFor(() => calls === 2 && lines.filter((l) => l[0] === 'warn' && /handler failed/.test(l[1])).length === 2, 'both handler faults logged');
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(unhandled.length, 0);
    } finally {
        process.off('unhandledRejection', onUnhandled);
        await client.stop();
        await fake.close();
    }
});

test('heartbeats are sent and acked; a zombie connection (no ack) is dropped and resumed', async () => {
    const { fake, client, got } = await connected({ heartbeatMs: 120 });
    try {
        await client.start();
        await waitFor(() => fake.gateway.heartbeats >= 2, 'two heartbeats');
        fake.stopAcking(true);
        await waitFor(() => fake.gateway.resumes.length >= 1, 'a resume after the missed ack', 5000);
        fake.stopAcking(false);
        await waitFor(() => got.readies.some((r) => r.resumed), 'RESUMED');
        assert.equal(fake.gateway.identifies.length, 1, 'no second identify: the session was resumed');
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('RECONNECT (op 7): resumes on resume_gateway_url with the last seq; events missed meanwhile are replayed once', async () => {
    const { fake, client, got } = await connected();
    try {
        await client.start();
        const channel = fake.addChannel({});
        const person = fake.addUser({});
        fake.userMessage({ channelId: channel.id, author: person, content: 'one' });
        await waitFor(() => got.messages.length === 1, 'first message');
        fake.requestReconnect();
        // While the bot is away, a message is posted: the gateway keeps it for the resume.
        await waitFor(() => !fake.connected(), 'the bot dropped the socket');
        fake.userMessage({ channelId: channel.id, author: person, content: 'two' });
        await waitFor(() => got.messages.length === 2, 'the missed message replayed', 5000);
        assert.deepEqual(got.messages.map((m) => m.content), ['one', 'two']);
        assert.equal(fake.gateway.resumes.length, 1);
        assert.equal(fake.gateway.resumes[0].path, '/resume', 'resumed on Discord\'s resume address');
        assert.equal(fake.gateway.resumes[0].sessionId, got.readies[0].sessionId);
        assert.equal(fake.gateway.identifies.length, 1);
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('INVALID SESSION (not resumable): identifies afresh and reports a new session (catch-up runs)', async () => {
    const { fake, client, got } = await connected();
    try {
        await client.start();
        fake.invalidSession(false);
        await waitFor(() => fake.gateway.identifies.length === 2, 'a second identify', 5000);
        await waitFor(() => got.readies.length === 2, 'a second READY');
        assert.equal(got.readies[1].resumed, false);
        assert.notEqual(got.readies[1].sessionId, got.readies[0].sessionId);
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('a dropped connection (no close frame) and an ordinary close both reconnect', async () => {
    const { fake, client, got } = await connected();
    try {
        await client.start();
        fake.dropSocket();
        await waitFor(() => got.readies.length === 2, 'back after the drop', 5000);
        fake.closeSocket(4000);
        await waitFor(() => got.readies.length === 3, 'back after the close', 5000);
        assert.ok(client.state.reconnects >= 2);
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('a refused token (401 at the gateway lookup) is final: no retry, the reason is kept in words', async () => {
    const { fake, client, lines } = await connected({ token: 'wrong-token' });
    try {
        // The REST lookup refuses the wrong token first: final, never retried.
        await assert.rejects(() => client.start(), /refused the bot token/);
        assert.equal(fake.gateway.connects, 0);
        assert.match(client.state.fatal, /refused the bot token/);
        assert.ok(lines.some((l) => l[0] === 'warn' && /stays offline until the setting is fixed/.test(l[1])));
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('a gateway close with a configuration code (4014 disallowed intent) stops reconnecting', async () => {
    const { fake, client } = await connected();
    try {
        await client.start();
        const connects = fake.gateway.connects;
        fake.closeSocket(4014);
        await waitFor(() => client.state.fatal !== null, 'the fatal state', 5000);
        assert.match(client.state.fatal, /Message Content Intent/);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(fake.gateway.connects, connects, 'no new connection after a configuration fault');
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('the startup lookup is retried through server errors and a cut connection (a Mac that boots offline)', async () => {
    const fake = await startFakeDiscord();
    fake.failNext('GET', /^\/gateway\/bot$/, 500, 2);
    fake.failNext('GET', /^\/gateway\/bot$/, 'drop', 1);
    const { logger, lines } = quiet();
    const client = new DiscordClient({ token: fake.token, apiBase: fake.apiBase, logger, maxBackoffMs: 30, onMessage() {} });
    try {
        await client.start();
        assert.equal(fake.calls('GET', '/gateway/bot').length, 4);
        assert.ok(lines.some((l) => l[0] === 'warn' && /trying again/.test(l[1])));
        assert.equal(client.state.connected, true);
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('stop() ends the connection for good: no reconnect afterwards', async () => {
    const { fake, client } = await connected();
    await client.start();
    await client.stop();
    const connects = fake.gateway.connects;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fake.gateway.connects, connects);
    assert.equal(client.state.connected, false);
    await fake.close();
});

test('REST: a 429 waits retry_after and succeeds; other refusals carry Discord\'s reason, never the token', async () => {
    const { fake, client } = await connected();
    try {
        await client.start();
        const channel = fake.addChannel({});
        fake.rateLimitNext('POST', /\/messages$/, 0.15);
        const started = Date.now();
        const sent = await client.sendMessage(channel.id, 'hello');
        assert.ok(Date.now() - started >= 140, 'waited for the rate limit');
        assert.equal(fake.botMessages(channel.id).length, 1);
        assert.equal(sent.chunkCount, 1);
        const error = await client.sendMessage('123456789012345678', 'x').catch((e) => e);
        assert.match(error.message, /Discord refused POST \/channels\/123456789012345678\/messages: 404 Unknown Channel/);
        assert.equal(error.status, 404);
        assert.doesNotMatch(error.message, new RegExp(fake.token));
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('REST: an unreachable host says so in words', async () => {
    const client = new DiscordClient({ token: 't', apiBase: 'http://127.0.0.1:9/api/v10', requestTimeoutMs: 1000, onMessage() {} });
    const error = await client.rest('GET', '/users/1').catch((e) => e);
    assert.match(error.message, /could not reach 127\.0\.0\.1:9 for GET \/users\/1/);
    assert.equal(error.retryable, true);
});

test('sendMessage splits long text under 2000 per message, pings users only', async () => {
    const { fake, client } = await connected();
    try {
        await client.start();
        const channel = fake.addChannel({});
        const text = Array.from({ length: 120 }, (_, i) => `Line ${i}: ${'word '.repeat(8)}`).join('\n') + '\n\n```js\n' + 'const x = 1;\n'.repeat(150) + '```';
        const { chunkCount, messageIds } = await client.sendMessage(channel.id, `@everyone ${text}`);
        const posted = fake.botMessages(channel.id);
        assert.equal(posted.length, chunkCount);
        assert.ok(chunkCount >= 3);
        assert.deepEqual(messageIds, posted.map((m) => m.id));
        for (const m of posted) {
            assert.ok(m.content.length <= 2000);
            assert.equal((m.content.match(/^```/gm) ?? []).length % 2, 0, 'fences balanced in each part');
            assert.deepEqual(m.allowed_mentions, { parse: ['users'], replied_user: false });
        }
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('sendFile uploads the file as multipart with its name and size', async () => {
    const { fake, client } = await connected();
    try {
        await client.start();
        const channel = fake.addChannel({});
        const buffer = Buffer.from('report body\n'.repeat(100));
        await client.sendFile(channel.id, { buffer, filename: 'report.txt' }, 'Here it is');
        const call = fake.calls('POST', `/channels/${channel.id}/messages`).at(-1);
        assert.equal(call.body.multipart, true);
        assert.equal(call.body.payload.content, 'Here it is');
        assert.equal(call.body.files[0].filename, 'report.txt');
        assert.equal(call.body.files[0].size, buffer.length);
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('ensureCommands posts new and changed commands only', async () => {
    const { fake, client } = await connected();
    try {
        await client.start();
        const commands = [{ name: 'status', description: 'Show it.' }, { name: 'rename', description: 'Rename.', options: [{ name: 'title', description: 'T', type: 3, required: false }] }];
        assert.deepEqual(await client.ensureCommands(fake.bot.id, commands), ['status', 'rename']);
        assert.deepEqual(await client.ensureCommands(fake.bot.id, commands), []);
        assert.deepEqual(await client.ensureCommands(fake.bot.id, [{ ...commands[0], description: 'Show it all.' }, commands[1]]), ['status']);
        assert.equal(fake.commands.length, 2);
        assert.equal(fake.commands.find((c) => c.name === 'status').description, 'Show it all.');
    } finally {
        await client.stop();
        await fake.close();
    }
});

test('getMessagesAfter returns newer messages oldest first', async () => {
    const { fake, client } = await connected();
    try {
        await client.start();
        const channel = fake.addChannel({});
        const person = fake.addUser({});
        const first = fake.userMessage({ channelId: channel.id, author: person, content: 'a', offline: true });
        fake.userMessage({ channelId: channel.id, author: person, content: 'b', offline: true });
        fake.userMessage({ channelId: channel.id, author: person, content: 'c', offline: true });
        const got = await client.getMessagesAfter(channel.id, { after: first.id });
        assert.deepEqual(got.map((m) => m.content), ['b', 'c']);
    } finally {
        await client.stop();
        await fake.close();
    }
});
