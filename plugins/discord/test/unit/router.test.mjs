/**
 * The router (gates, threads, sessions, queueing, never-silent rules,
 * titles, slash commands, catch-up) and the tools, over a real Discord
 * client talking to the fake Discord, and stand-in DSH services. What the
 * fake Discord recorded is the proof: what was posted, where, and what not.
 */
import assert from 'node:assert/strict';
import { linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { DiscordClient } from '../../lib/client.js';
import { readConfig } from '../../lib/config.js';
import { ThreadRouter, nudgeText, readAttachment, reasonText, turnReplyText } from '../../lib/router.js';
import { SessionStore } from '../../lib/store.js';
import { discordTools } from '../../lib/tools.js';
import { FakeAgent, fakeCtx, host } from '../support/fake-host.mjs';
import { startFakeDiscord, waitFor } from '../support/fake-discord.mjs';
import { tempDir } from '../support/temp.mjs';

/** A stand-in for DSH's defineTool: the definition as it is. */
const defineTool = (definition) => definition;

/** A connected bot over the fake Discord, with one allowed channel and one allowed person. */
async function bench({ config: extra = {}, ctxOptions, store: storeFile, fake: given } = {}) {
    const fake = given ?? await startFakeDiscord();
    const channel = fake.channels.size > 0 && given ? [...fake.channels.values()].find((c) => c.type === 0) : fake.addChannel({ name: 'deepseek-harness' });
    const person = given ? [...fake.users.values()].find((u) => !u.bot) : fake.addUser({ username: 'albert' });
    const dir = tempDir('discord-router-');
    const file = storeFile ?? join(dir, 'sessions.json');
    const { settings: config, problems } = readConfig({
        workspacePath: '/tmp/discord-ws',
        allowedChannelIds: [channel.id],
        allowedUserIds: [person.id],
        storeFile: file,
        traceFile: '',
        ...extra,
    });
    assert.deepEqual(problems, []);
    const host_ = fakeCtx(ctxOptions);
    const traced = [];
    const trace = (event, status, data) => traced.push({ event, status, ...data });
    let client;
    const router = new ThreadRouter({ ctx: host_.ctx, config, logger: host_.ctx.logger, host, trace, botState: () => client?.state });
    client = new DiscordClient({
        token: fake.token,
        apiBase: fake.apiBase,
        maxBackoffMs: 30,
        logger: host_.ctx.logger,
        onMessage: (d) => router.handleMessage(d),
        onInteraction: (d) => router.handleInteraction(d),
    });
    router.attachClient(client);
    await client.start();
    const toolList = discordTools({ defineTool, getClient: () => client, config, router, trace });
    router.offerTools?.(toolList); // as the plugin does: the router offers them to its own sessions only
    const tools = Object.fromEntries(toolList.map((t) => [t.name, t]));
    const stop = async () => {
        await client.stop();
        await router.dispose();
        if (!given) await fake.close();
    };
    return { fake, channel, person, config, router, client, tools, traced, file, stop, ...host_ };
}

/** The agent's discord_send, as the model would call it. */
const sendAs = (b, agent, channelId, content) => b.tools.discord_send.execute({ channel_id: channelId, content }, { agent });

test('a top-level message gets a thread anchored to it, its own session, and the turn with the reply instruction', async () => {
    const b = await bench();
    try {
        const msg = b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'Please fix the login redirect loop in the web app' });
        await waitFor(() => b.created.length === 1 && b.created[0].followups.length === 1, 'the session and its first turn');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        assert.equal(thread.id, msg.id, 'the thread hangs off the message');
        assert.equal(thread.name, 'Please fix the login redirect loop in the web app');
        const agent = b.created[0];
        assert.equal(agent.meta.cwd, '/tmp/discord-ws');
        const turn = agent.followups[0];
        assert.equal(turn.source.kind, 'discord');
        assert.equal(turn.source.form, 'notice');
        assert.equal(turn.source.channelId, thread.id);
        assert.match(turn.source.summary, /^@albert on Discord: Please fix/);
        assert.ok(turn.source.summary.length <= 120);
        const text = turn.content[0].text;
        assert.match(text, /Please fix the login redirect loop/);
        assert.ok(text.includes(`channel_id "${thread.id}"`), 'the reply instruction names the thread');
        assert.equal(b.presetSets[0].name, 'workspace-write');
        assert.match(b.renames[0].title, /^Discord — Please fix/);
        assert.equal(new SessionStore(b.file).get(thread.id).sessionId, agent.id);
        // The typing call goes out beside the hand-over, not before it, so wait for it to land.
        await waitFor(() => b.fake.calls('POST', `/channels/${thread.id}/typing`).length >= 1, 'typing shown while the turn runs');
        assert.equal(b.fake.botMessages(b.channel.id).length, 0, 'nothing posted in the parent channel');
    } finally {
        await b.stop();
    }
});

test('gates: other people, bots, other channels, and a missing mention when one is required, are dropped without a word', async () => {
    const b = await bench({ config: { requireMention: true } });
    try {
        const stranger = b.fake.addUser({ username: 'stranger' });
        const otherBot = b.fake.addUser({ username: 'otherbot', bot: true });
        const elsewhere = b.fake.addChannel({ name: 'random' });
        b.fake.userMessage({ channelId: b.channel.id, author: stranger, content: `<@${b.fake.bot.id}> hi` });
        b.fake.userMessage({ channelId: b.channel.id, author: otherBot, content: `<@${b.fake.bot.id}> hi` });
        b.fake.userMessage({ channelId: elsewhere.id, author: b.person, content: `<@${b.fake.bot.id}> hi` });
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'no mention here' });
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: `<@${b.fake.bot.id}> with a mention` });
        await waitFor(() => b.created.length === 1 && b.created[0].followups.length === 1, 'only the mentioned message');
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(b.created.length, 1);
        const text = b.created[0].followups[0].content[0].text;
        assert.match(text, /\n\nwith a mention\n\n/, 'the mention is taken out of what the agent reads');
        assert.equal(b.fake.threadsOf(b.channel.id).length, 1);
        assert.equal(b.fake.threadsOf(elsewhere.id).length, 0);
        const reasons = b.traced.filter((t) => t.status === 'inbound' && t.result === 'drop').map((t) => t.reason);
        assert.deepEqual(reasons.sort(), ['channel not allowlisted', 'mention required', 'user not allowlisted'].sort());
        for (const id of [b.channel.id, elsewhere.id]) assert.equal(b.fake.botMessages(id).length, 0);
    } finally {
        await b.stop();
    }
});

test('a replayed message (same id) is handed over once; a second message in a busy thread queues behind the first in order', async () => {
    const b = await bench();
    try {
        const first = b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'first question' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'first turn');
        b.fake.dispatch('MESSAGE_CREATE', first); // a gateway replay
        const thread = b.fake.threadsOf(b.channel.id)[0];
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'second' });
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'third' });
        await waitFor(() => b.created[0].followups.length === 3, 'three turns');
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(b.created.length, 1, 'one session for the thread');
        assert.deepEqual(b.created[0].followups.map((f) => /\n\n(.*)\n\n/.exec(f.content[0].text)[1]), ['first question', 'second', 'third']);
        assert.ok(b.traced.some((t) => t.result === 'duplicate'));
    } finally {
        await b.stop();
    }
});

test('two messages racing into a thread whose agent is not open yet open one session, not two', async () => {
    const dir = tempDir('discord-race-');
    const file = join(dir, 's.json');
    const b = await bench({ store: file });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created.length === 1, 'session');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        const sessionId = b.created[0].id;
        // A restart: a fresh router over the same store; the session is on disk only.
        await b.router.dispose();
        const b2 = await bench({ store: file, fake: b.fake });
        b2.ctx.agents.knownOnDisk.add(sessionId);
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'one' });
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'two' });
        await waitFor(() => b2.resumed.length >= 1 && b2.resumed[0].followups.length === 2, 'both turns in the resumed session');
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(b2.resumed.length, 1);
        assert.equal(b2.created.length, 0);
        assert.equal(b2.resumed[0].id, sessionId, 'the stored session, with its history');
        await b2.stop();
    } finally {
        await b.stop();
    }
});

test('a stored session that is gone: a new one starts, and the thread is told it does not remember', async () => {
    const dir = tempDir('discord-gone-');
    const file = join(dir, 's.json');
    const b = await bench({ store: file });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created.length === 1, 'session');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        await b.router.dispose();
        const b2 = await bench({ store: file, fake: b.fake });
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'still there?' });
        await waitFor(() => b2.created.length === 1 && b2.created[0].followups.length === 1, 'a new session');
        const posted = b.fake.botMessages(thread.id).map((m) => m.content);
        assert.ok(posted.some((c) => /could not be opened .* a new one starts now; it does not remember/.test(c)), posted.join(' | '));
        await b2.stop();
    } finally {
        await b.stop();
    }
});

test('a session that cannot start (a preset that does not exist) says so in the thread, in words', async () => {
    const b = await bench({ config: { permissionPreset: 'no-such-preset' } });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'hello' });
        const thread = await waitFor(() => b.fake.threadsOf(b.channel.id)[0], 'thread');
        await waitFor(() => b.fake.botMessages(thread.id).length === 1, 'the explanation');
        assert.match(b.fake.botMessages(thread.id)[0].content, /Could not start an agent for this message \(there is no permission preset named "no-such-preset"\)\. Check the Discord plugin's settings in DSH/);
        assert.equal(b.created.length, 0);
    } finally {
        await b.stop();
    }
});

test('a thread that cannot be created (twice) gets one line in the parent, replying to the message', async () => {
    const b = await bench();
    try {
        b.fake.failNext('POST', /\/threads$/, 403, 2, { message: 'Missing Permissions', code: 50013 });
        const msg = b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'hello' });
        await waitFor(() => b.fake.botMessages(b.channel.id).length === 1, 'the parent line');
        const line = b.fake.botMessages(b.channel.id)[0];
        // Discord's reason in words: no request, path or status code reaches the person.
        assert.equal(line.content, 'Could not open a thread for this message, so no agent was started (Discord said “Missing Permissions”). Check that the bot may create public threads here, then send it again.');
        assert.equal(line.message_reference.message_id, msg.id);
        assert.equal(b.created.length, 0);
    } finally {
        await b.stop();
    }
});

test('an archived thread is unarchived and its session continues', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'first turn');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        thread.thread_metadata.archived = true;
        b.router.channelCache.delete(thread.id);
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'back again' });
        await waitFor(() => b.created[0].followups.length === 2, 'second turn');
        assert.equal(thread.thread_metadata.archived, false);
        assert.ok(b.fake.calls('PATCH', `/channels/${thread.id}`).some((c) => c.body.archived === false));
    } finally {
        await b.stop();
    }
});

test('attachments are handed over with their names and links; an attachment-only message is not dropped', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: '', attachments: [{ id: '1', filename: 'crash.log', size: 2048, content_type: 'text/plain', url: 'https://cdn.example/crash.log' }] });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const text = b.created[0].followups[0].content[0].text;
        assert.match(text, /Attached files .*\n- crash\.log \(text\/plain, 2048 bytes\): https:\/\/cdn\.example\/crash\.log/);
        assert.equal(b.fake.threadsOf(b.channel.id)[0].name, 'crash.log');
    } finally {
        await b.stop();
    }
});

test('a message longer than maxPromptChars is cut with a note; the reply instruction stays whole', async () => {
    const b = await bench({ config: { maxPromptChars: 1000 } });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'x'.repeat(1900) });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const text = b.created[0].followups[0].content[0].text;
        assert.ok(text.length <= 1100, `relayed ${text.length}`);
        assert.match(text, /\(message cut at \d+ characters\)/);
        assert.match(text, /Reply in Discord with the discord_send tool using channel_id "\d+"/);
    } finally {
        await b.stop();
    }
});

test('never silent: a reply sent with discord_send ends the turn quietly; no send gets one reminder, then the last words are posted', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'question one' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const agent = b.created[0];
        const thread = b.fake.threadsOf(b.channel.id)[0];
        // Turn 1: the model replies through the tool.
        await agent.playTurn({ send: () => sendAs(b, agent, thread.id, 'Answer one') });
        assert.equal(agent.steers.length, 0, 'no reminder after a real reply');
        assert.deepEqual(b.fake.botMessages(thread.id).map((m) => m.content), ['Answer one']);
        // Turn 2: the model forgets the tool, and is reminded; it sends after the reminder.
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'question two' });
        await waitFor(() => agent.followups.length === 2, 'turn 2');
        await agent.playTurn({ afterNudge: () => sendAs(b, agent, thread.id, 'Answer two, after the reminder') });
        assert.equal(agent.steers.length, 1);
        assert.equal(agent.steers[0].content[0].text, nudgeText(thread.id));
        // Turn 3: it forgets even after the reminder: its last words go to Discord.
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'question three' });
        await waitFor(() => agent.followups.length === 3, 'turn 3');
        await agent.playTurn({ text: 'The answer is 42.' });
        assert.equal(agent.steers.length, 2);
        assert.deepEqual(b.fake.botMessages(thread.id).map((m) => m.content), ['Answer one', 'Answer two, after the reminder', 'The answer is 42.']);
        assert.ok(b.traced.some((t) => t.status === 'reply_fallback' && t.posted === true));
    } finally {
        await b.stop();
    }
});

test('never silent: a failed turn says so in its thread, once; postErrors and replyFallback can be switched off', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'q' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const agent = b.created[0];
        const thread = b.fake.threadsOf(b.channel.id)[0];
        await agent.playTurn({ error: new Error('the model provider answered 503 Service Unavailable') });
        await waitFor(() => b.fake.botMessages(thread.id).length === 1, 'the failure line');
        assert.match(b.fake.botMessages(thread.id)[0].content, /^The agent's turn failed: the model provider answered 503 Service Unavailable\. Send your message again to retry/);
        // A model server's JSON error, whose message ends in a period: said in words, with one period.
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'again' });
        await waitFor(() => agent.followups.length === 2, 'turn 2');
        await agent.playTurn({ error: new Error('400 {"error":{"message":"The model refused this request.","type":"invalid_request_error"}}') });
        await waitFor(() => b.fake.botMessages(thread.id).length === 2, 'the second failure line');
        // A model server's JSON error: its message in words, without the bare status code.
        assert.equal(b.fake.botMessages(thread.id)[1].content, 'The agent\'s turn failed: The model refused this request. Send your message again to retry; /status shows the session.');
    } finally {
        await b.stop();
    }
    const quiet = await bench({ config: { postErrors: false, replyFallback: false } });
    try {
        quiet.fake.userMessage({ channelId: quiet.channel.id, author: quiet.person, content: 'q' });
        await waitFor(() => quiet.created[0]?.followups.length === 1, 'turn');
        const agent = quiet.created[0];
        await agent.playTurn({ error: new Error('boom') });
        quiet.fake.userMessage({ channelId: quiet.fake.threadsOf(quiet.channel.id)[0].id, author: quiet.person, content: 'q2' });
        await waitFor(() => agent.followups.length === 2, 'turn 2');
        await agent.playTurn({ text: 'unsent words' });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(agent.steers.length, 0);
        assert.equal(quiet.fake.botMessages(quiet.fake.threadsOf(quiet.channel.id)[0].id).length, 0);
    } finally {
        await quiet.stop();
    }
});

test('titles: after the first reply the thread and the DSH session are renamed once; a name changed by hand wins', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'please fix the login redirect loop' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const agent = b.created[0];
        const thread = b.fake.threadsOf(b.channel.id)[0];
        await agent.playTurn({ send: () => sendAs(b, agent, thread.id, 'ok') });
        await waitFor(() => thread.name === 'Fix the login redirect loop', 'the new title');
        assert.ok(b.renames.some((r) => r.title === 'Discord — Fix the login redirect loop'), 'the DSH session follows');
        // A second thread renamed by hand before its first reply keeps its name.
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'another task for later' });
        await waitFor(() => b.created.length === 2 && b.created[1].followups.length === 1, 'second thread');
        const second = b.fake.threadsOf(b.channel.id)[1];
        second.name = 'My own name';
        await b.created[1].playTurn({ send: () => sendAs(b, b.created[1], second.id, 'ok') });
        await waitFor(() => b.traced.some((t) => t.status === 'rename_result' && t.outcome === 'skipped-manual-rename'), 'the skip');
        assert.equal(second.name, 'My own name');
        assert.ok(b.renames.some((r) => r.sessionId === b.created[1].id && r.title === 'Discord — My own name'), 'the DSH session takes the name the person chose');
    } finally {
        await b.stop();
    }
});

test('titles: a message whose first 80 characters end in a space is still titled (Discord trims the name it stores)', async () => {
    const b = await bench();
    try {
        const content = `${'Checklist '.repeat(8)}for the Friday release`; // character 80 is a space
        assert.equal(content.replace(/\s+/g, ' ').slice(0, 80).at(-1), ' ');
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const agent = b.created[0];
        const thread = b.fake.threadsOf(b.channel.id)[0];
        assert.equal(thread.name, thread.name.trim(), 'the thread is made with a trimmed name');
        await agent.playTurn({ send: () => sendAs(b, agent, thread.id, 'ok') });
        await waitFor(() => thread.name === 'Fix the login redirect loop', 'the new title');
        assert.ok(!b.traced.some((t) => t.outcome === 'skipped-manual-rename'), 'not taken for a rename by hand');
        assert.ok(b.renames.some((r) => r.title === 'Discord — Fix the login redirect loop'));
    } finally {
        await b.stop();
    }
});

test('slash commands: only allowed people, only in the bot\'s channels; /status, /stop, /model, /effort, /rename, /new', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start a session' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        const agent = b.created[0];
        const ask = async (name, value, { user = b.person, channelId = thread.id } = {}) => {
            const asked = b.fake.interaction({ channelId, user, name, value });
            return await waitFor(() => b.fake.answerOf(asked), `the answer to /${name}`);
        };
        const stranger = b.fake.addUser({ username: 'stranger' });
        const refused = await ask('new', undefined, { user: stranger });
        assert.deepEqual(refused, { text: 'This bot answers only the people it is set up for.', deferred: false, ephemeral: true });
        assert.ok(new SessionStore(b.file).get(thread.id), 'a stranger cleared nothing');
        const elsewhere = b.fake.addChannel({ name: 'random' });
        assert.equal((await ask('status', undefined, { channelId: elsewhere.id })).text, 'This bot works only in its own channels and their threads.');

        const status = await ask('status');
        assert.equal(status.ephemeral, true);
        assert.match(status.text, /\*\*This thread:\*\* idle, waiting for a message; 1 message\(s\) handed over/);
        // The session as DSH lists it, the folder by its name (never a private path), and a time each reader sees in their own zone.
        assert.match(status.text, /\*\*DSH session:\*\* “Discord — start a session”, working in the folder “discord-ws”\./);
        assert.ok(!status.text.includes('/tmp/'), 'no path');
        assert.match(status.text, /\*\*Bot:\*\* connected since <t:\d{10}:f>\./);

        assert.equal((await ask('stop')).text, 'Nothing is running in this thread.');
        agent.setStatus('running');
        const stopped = await ask('stop');
        assert.match(stopped.text, /^Stopped the running turn/);
        assert.deepEqual(agent.cancels.at(-1), { cause: { kind: 'user' }, options: { keepInbox: true } });
        agent.setStatus('idle');

        const model = await ask('model', 'other:big-model');
        assert.equal(model.deferred, true);
        assert.match(model.text, /set to \*\*other:big-model\*\*, from the next turn/);
        const routed = await agent.ctx.waterfall('agent/request', {}, { provider: 'fake', model: 'fake-model', reasoningEffort: 'low' });
        assert.deepEqual({ provider: routed.provider, model: routed.model }, { provider: 'other', model: 'big-model' });
        await ask('effort', 'high');
        assert.equal((await agent.ctx.waterfall('agent/request', {}, { provider: 'fake', model: 'm' })).reasoningEffort, 'high');
        await ask('effort', 'clear');
        assert.equal('reasoningEffort' in (await agent.ctx.waterfall('agent/request', {}, { provider: 'fake', model: 'm', reasoningEffort: 'low' })), false);

        const renamed = await ask('rename', 'Deploy notes');
        assert.equal(renamed.text, 'Renamed to “Deploy notes”.');
        assert.equal(thread.name, 'Deploy notes');

        const cleared = await ask('new');
        assert.equal(cleared.deferred, true);
        assert.equal(cleared.text, 'Session cleared. Your next message here starts a fresh session, listed in DSH as “Discord — Deploy notes (session 2)”; the old one stays in DSH under its own name.');
        assert.equal(agent.disposed, true);
        assert.equal(new SessionStore(b.file).get(thread.id), null);
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'fresh start' });
        await waitFor(() => b.created.length === 2 && b.created[1].followups.length === 1, 'a fresh session');
        assert.notEqual(b.created[1].id, agent.id);
        // Listed in DSH as /new said, from its first moment: the thread's name, numbered (never a second "Discord — Deploy notes").
        assert.deepEqual(b.renames.filter((r) => r.sessionId === b.created[1].id).map((r) => r.title), ['Discord — Deploy notes (session 2)']);
        assert.equal((await ask('nonsense')).text, '“nonsense” is not a command of this bot.');
    } finally {
        await b.stop();
    }
});

test('catch-up: messages posted while DSH was down are answered after the restart, once; old ones and ones answered since are left', async () => {
    const dir = tempDir('discord-catchup-');
    const file = join(dir, 's.json');
    const b = await bench({ store: file });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created.length === 1, 'session');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'in the thread' });
        await waitFor(() => b.created[0].followups.length === 2, 'second turn');
        const sessionId = b.created[0].id;
        await b.client.stop();
        await b.router.dispose();
        // DSH is down: two messages in the thread, one new top-level message, one stale message.
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'while away 1', offline: true });
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'while away 2', offline: true });
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'a new task while away', offline: true });
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'too old', offline: true, timestamp: new Date(Date.now() - 5 * 3600 * 1000).toISOString() });
        const b2 = await bench({ store: file, fake: b.fake });
        b2.ctx.agents.knownOnDisk.add(sessionId);
        const first = await b2.router.catchUp();
        assert.equal(first.handled, 3);
        const resumed = b2.resumed[0];
        assert.equal(resumed.id, sessionId);
        assert.deepEqual(resumed.followups.map((f) => /\n\n(.*)\n\n/.exec(f.content[0].text)[1]), ['while away 1', 'while away 2']);
        assert.match(resumed.followups[0].content[0].text, /sent while DSH was not running/);
        assert.equal(b2.created.length, 1, 'the top-level message got its own thread and session');
        assert.equal(b.fake.threadsOf(b.channel.id).length, 2);
        // The stale one is not answered, and the thread says so (never lost without a word).
        assert.equal(first.late, 1);
        assert.deepEqual(b.fake.botMessages(thread.id).map((m) => m.content), ['Your message (“too old”) came while DSH was not running and is older than 120 minutes, the longest the bot answers late, so the agent was not given it. Send it again if it still needs an answer.']);
        const again = await b2.router.catchUp();
        assert.equal(again.handled, 0, 'nothing twice');
        assert.equal(again.late, 0, 'and nothing said twice');
        assert.equal(resumed.followups.length, 2);
        assert.equal(b.fake.botMessages(thread.id).length, 1);
        await b2.stop();
    } finally {
        await b.fake.close();
    }
});

/** A bench whose bot has handled one thread, then stopped (DSH down): the store, the thread and the session id. */
async function threadThenStop() {
    const dir = tempDir('discord-catchup-');
    const file = join(dir, 's.json');
    const b = await bench({ store: file });
    b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
    await waitFor(() => b.created[0]?.followups.length === 1, 'session');
    const thread = b.fake.threadsOf(b.channel.id)[0];
    const sessionId = b.created[0].id;
    await b.client.stop();
    await b.router.dispose();
    return { b, file, thread, sessionId };
}

/** The followups' message text (the line between the header and the reply instruction). */
const relayedTexts = (agent) => agent.followups.map((f) => /\n\n(.*)\n\n/.exec(f.content[0].text)?.[1]);

test('catch-up reads a thread idle for longer than catchUpMinutes before DSH stopped', async () => {
    const { b, file, thread, sessionId } = await threadThenStop();
    try {
        // The thread was last active three hours before the outage; a message comes during the restart.
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        raw.threads[thread.id].lastActiveAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
        writeFileSync(file, JSON.stringify(raw));
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'are you there?', offline: true });
        const b2 = await bench({ store: file, fake: b.fake });
        b2.ctx.agents.knownOnDisk.add(sessionId);
        const result = await b2.router.catchUp();
        assert.equal(result.handled, 1);
        assert.deepEqual(relayedTexts(b2.resumed[0]), ['are you there?']);
        await b2.stop();
    } finally {
        await b.fake.close();
    }
});

test('catch-up pages to the newest message: one after 120 bot posts is still answered', async () => {
    const { b, file, thread, sessionId } = await threadThenStop();
    try {
        for (let i = 1; i <= 120; i++) b.fake.userMessage({ channelId: thread.id, author: b.fake.bot, content: `progress ${i}`, offline: true });
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'after the progress lines', offline: true });
        const b2 = await bench({ store: file, fake: b.fake });
        b2.ctx.agents.knownOnDisk.add(sessionId);
        const result = await b2.router.catchUp();
        assert.equal(result.handled, 1);
        assert.equal(result.checked, 121);
        assert.deepEqual(relayedTexts(b2.resumed[0]), ['after the progress lines']);
        assert.ok(b.fake.calls('GET', `/channels/${thread.id}/messages`).length >= 2, 'more than one page read');
        await b2.stop();
    } finally {
        await b.fake.close();
    }
});

test('catch-up after a gateway gap: a message the bot posted after is still answered (this build keeps the ids it handled)', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'session');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        const agent = b.created[0];
        // The gateway drops and Discord ends the session: a message in the gap is never delivered, and the agent,
        // still working, posts a progress line after it (REST works without the gateway).
        b.fake.invalidSession(false);
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'written in the gap', offline: true });
        await sendAs(b, agent, thread.id, 'still working on it');
        // A fresh gateway session: catch-up.
        const result = await b.router.catchUp();
        assert.equal(result.handled, 1);
        assert.deepEqual(relayedTexts(agent).slice(1), ['written in the gap']);
    } finally {
        await b.stop();
    }
});

test('catch-up over a store an older build wrote last: a message the bot replied after is taken as answered', async () => {
    const { b, file, thread, sessionId } = await threadThenStop();
    try {
        // An older build ran meanwhile: it answered a message without keeping ids, and wrote the store without them.
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ version: 1, threads: raw.threads }));
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'answered by an earlier build', offline: true });
        b.fake.userMessage({ channelId: thread.id, author: b.fake.bot, content: 'the earlier build answered', offline: true });
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'not answered yet', offline: true });
        const b2 = await bench({ store: file, fake: b.fake });
        b2.ctx.agents.knownOnDisk.add(sessionId);
        assert.equal(b2.router.store.legacy, true);
        const result = await b2.router.catchUp();
        assert.equal(result.handled, 1);
        assert.deepEqual(relayedTexts(b2.resumed[0]), ['not answered yet']);
        assert.equal(new SessionStore(file).legacy, false, 'once this build saves, the store is its own again');
        // For the first catch-up only: after a later gateway gap, a message the bot posted after is still answered.
        assert.equal(b2.router.store.legacy, false);
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'in a later gap', offline: true });
        b.fake.userMessage({ channelId: thread.id, author: b.fake.bot, content: 'a progress line', offline: true });
        assert.equal((await b2.router.catchUp()).handled, 1);
        assert.deepEqual(relayedTexts(b2.resumed[0]), ['not answered yet', 'in a later gap']);
        await b2.stop();
    } finally {
        await b.fake.close();
    }
});

test('catch-up: a top-level message too old to answer gets one reply saying so; catchUpMinutes 0 answers nothing late but says so', async () => {
    const { b, file, thread } = await threadThenStop();
    try {
        const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
        const stale = b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'an old request', offline: true, timestamp: old });
        const b2 = await bench({ store: file, fake: b.fake });
        const result = await b2.router.catchUp();
        assert.equal(result.handled, 0);
        assert.equal(result.late, 1);
        const said = b.fake.botMessages(b.channel.id);
        assert.equal(said.length, 1);
        assert.equal(said[0].message_reference.message_id, stale.id, 'a reply to the message itself');
        assert.match(said[0].content, /^This message came while DSH was not running and is older than 120 minutes, the longest the bot answers late, so no agent was started for it\./);
        assert.equal(b.fake.threadsOf(b.channel.id).length, 1, 'no thread made for it');
        await b2.stop();
        // catchUpMinutes 0: even a fresh message is not answered late, and its thread is told.
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'fresh but late', offline: true });
        const b3 = await bench({ store: file, fake: b.fake, config: { catchUpMinutes: 0 } });
        const off = await b3.router.catchUp();
        assert.equal(off.handled, 0);
        assert.equal(off.late, 1);
        assert.match(b.fake.botMessages(thread.id).at(-1).content, /^Your message \(“fresh but late”\) came while DSH was not running; the bot is set not to answer late messages, so the agent was not given it\./);
        await b3.stop();
    } finally {
        await b.fake.close();
    }
});

test('catch-up in an allowed channel the bot has had no message from: it reads from the bot\'s first start', async () => {
    const dir = tempDir('discord-start-');
    const file = join(dir, 's.json');
    const b = await bench({ store: file });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'before the bot ever ran', offline: true });
        await new Promise((r) => setTimeout(r, 5));
        assert.equal((await b.router.catchUp()).handled, 0, 'nothing from before its first start');
        await b.client.stop();
        await b.router.dispose();
        // A quiet channel: the first message in it comes while DSH is down.
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'the first request, during a restart', offline: true });
        const b2 = await bench({ store: file, fake: b.fake });
        const result = await b2.router.catchUp();
        assert.equal(result.handled, 1);
        assert.deepEqual(relayedTexts(b2.created[0]), ['the first request, during a restart']);
        await b2.stop();
    } finally {
        await b.fake.close();
    }
});

test('catch-up keeps its place: messages it passed over (other people\'s) are not read again by the next one', async () => {
    const { b, file } = await threadThenStop();
    try {
        const stranger = b.fake.addUser({ username: 'someone' });
        let newest;
        for (let i = 1; i <= 150; i++) newest = b.fake.userMessage({ channelId: b.channel.id, author: stranger, content: `chatter ${i}`, offline: true });
        const b2 = await bench({ store: file, fake: b.fake });
        const first = await b2.router.catchUp();
        assert.equal(first.handled, 0);
        assert.ok(first.checked >= 150);
        const reads = () => b.fake.calls('GET', `/channels/${b.channel.id}/messages`);
        const before = reads().length;
        await b2.router.catchUp();
        assert.deepEqual(reads().slice(before).map((r) => r.query.after), [newest.id], 'the next catch-up reads the channel after them, once');
        assert.deepEqual(b.fake.botMessages(b.channel.id), [], 'and says nothing about them');
        await b2.stop();
    } finally {
        await b.fake.close();
    }
});

test('catch-up that cannot read a thread (Discord down) tries again, and says so in the thread only when it still cannot', async () => {
    const { b, file, thread, sessionId } = await threadThenStop();
    try {
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'sent during the outage', offline: true });
        const reads = new RegExp(`^/channels/${thread.id}/messages$`);
        // What the bot says in the thread about reading it (the first turn, cut off by the stop, is said apart).
        const aboutReading = () => b.fake.botMessages(thread.id).map((m) => m.content).filter((c) => !c.startsWith('DSH stopped before the agent finished'));
        b.fake.failNext('GET', reads, 503, 1);
        const b2 = await bench({ store: file, fake: b.fake });
        b2.ctx.agents.knownOnDisk.add(sessionId);
        b2.router.catchUpRetryMs = 30;
        const first = await b2.router.catchUp();
        assert.equal(first.handled, 0);
        assert.deepEqual(aboutReading(), [], 'nothing said yet: it tries again first');
        await waitFor(() => b2.resumed[0]?.followups.length === 1, 'the message answered on the next try');
        assert.deepEqual(relayedTexts(b2.resumed[0]), ['sent during the outage']);
        assert.deepEqual(aboutReading(), []);
        await b2.stop();
        // A fault that does not pass: after the tries, the thread is told once.
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'during a longer outage', offline: true });
        b.fake.failNext('GET', reads, 503, 10);
        const b3 = await bench({ store: file, fake: b.fake });
        b3.ctx.agents.knownOnDisk.add(sessionId);
        b3.router.catchUpRetryMs = 20;
        await b3.router.catchUp();
        await waitFor(() => aboutReading().length === 1, 'the line after the last try');
        assert.deepEqual(aboutReading(), ['Not every message sent here while DSH was not running could be read, so some were not answered. Send again what still needs an answer.']);
        assert.equal(b.fake.calls('GET', reads).length, 1 + 1 + 3 + 1, 'the first try, its retry; then the first try and three more');
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(aboutReading().length, 1, 'said once');
        await b3.stop();
    } finally {
        await b.fake.close();
    }
});

test('catch-up reads a thread someone opened by hand while DSH was down: from their message, or on its own', async () => {
    const { b, file } = await threadThenStop();
    try {
        // A thread made from a person's message (its id is the message's), and one made on its own (Discord's
        // "started a thread" line in the channel points at it); each has a message in it.
        const starter = b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'please look at the logs', offline: true });
        const fromMessage = b.fake.addChannel({ id: starter.id, type: 11, parent_id: b.channel.id, name: 'logs' });
        starter.thread = { id: fromMessage.id };
        b.fake.userMessage({ channelId: fromMessage.id, author: b.person, content: 'the second thing', offline: true });
        const onItsOwn = b.fake.addChannel({ type: 11, parent_id: b.channel.id, name: 'side' });
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'side', type: 18, message_reference: { channel_id: onItsOwn.id }, offline: true });
        b.fake.userMessage({ channelId: onItsOwn.id, author: b.person, content: 'in the side thread', offline: true });
        const b2 = await bench({ store: file, fake: b.fake });
        const result = await b2.router.catchUp();
        assert.equal(result.handled, 3);
        const byThread = (id) => b2.created.find((a) => a.id.startsWith(`discord-t${id}-`));
        assert.deepEqual(relayedTexts(byThread(fromMessage.id)), ['please look at the logs', 'the second thing'], 'the message the thread was made from comes first');
        assert.deepEqual(relayedTexts(byThread(onItsOwn.id)), ['in the side thread']);
        assert.equal(b.fake.threadsOf(b.channel.id).length, 3, 'no thread of the bot\'s own for them');
        assert.equal((await b2.router.catchUp()).handled, 0, 'nothing twice');
        await b2.stop();
    } finally {
        await b.fake.close();
    }
});

test('a message DSH stopped on before it reached an agent (a quit while its session started) is said after the restart', async () => {
    const dir = tempDir('discord-untaken-');
    const file = join(dir, 's.json');
    let release;
    const b = await bench({ store: file, ctxOptions: { createGate: () => new Promise((r) => { release = r; }) } });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start the nightly report' });
        const thread = await waitFor(() => b.fake.threadsOf(b.channel.id)[0], 'the thread');
        await waitFor(() => release, 'the session to be starting');
        // DSH quits now: the message was taken (its id is remembered, so catch-up skips it), but no agent has it.
        await b.client.stop();
        await b.router.dispose();
        const b2 = await bench({ store: file, fake: b.fake });
        await b2.router.catchUp();
        assert.deepEqual(b.fake.botMessages(thread.id).map((m) => m.content), ['DSH stopped before your message (“start the nightly report”) reached an agent, so it was not answered. Send it again if you still need the answer.']);
        await b2.router.catchUp();
        assert.equal(b.fake.botMessages(thread.id).length, 1, 'said once');
        await b2.stop();
    } finally {
        release?.();
        await b.fake.close();
    }
});

test('Discord\'s system messages (a thread started by hand, a pin) are not relayed: no thread, no session', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'Plans for Friday', type: 18 });
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: '', type: 6 });
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'a real message' });
        await waitFor(() => b.created.length === 1 && b.created[0].followups.length === 1, 'the real message');
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(b.created.length, 1);
        assert.deepEqual(relayedTexts(b.created[0]), ['a real message']);
        assert.equal(b.fake.threadsOf(b.channel.id).length, 1);
        assert.ok(b.traced.some((t) => t.result === 'drop' && /system message \(type 18\)/.test(t.reason)));
        // A reply (type 19) is a person's words.
        const thread = b.fake.threadsOf(b.channel.id)[0];
        b.fake.userMessage({ channelId: thread.id, author: b.person, content: 'replying to you', type: 19 });
        await waitFor(() => b.created[0].followups.length === 2, 'the reply relayed');
    } finally {
        await b.stop();
    }
});

test('an approval a Discord turn waits on in DSH is said in the thread, even with DSH\'s window listening first; one answered at once is not', async () => {
    // DSH's window forwarding is on every agent from boot, before any plugin: an open window answers without calling
    // next(), which ends the chain there; with no window it passes the request on, and DSH answers "unavailable".
    const window = { open: true, ms: 0, outcome: 'allowed-once' };
    const b = await bench({
        ctxOptions: {
            hostListeners: (agentCtx) => agentCtx.on('approval/request', (_req, next) => (window.open ? new Promise((r) => setTimeout(() => r(window.outcome), window.ms)) : next())),
        },
    });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'clean the build folder' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const agent = b.created[0];
        const thread = b.fake.threadsOf(b.channel.id)[0];
        // As DSH's sandbox asks: a plain reason, and a display reason per language.
        const request = {
            agent, toolName: 'bash', callId: 'call-1',
            reason: 'escalate sandbox to danger-full-access: rm -rf build needs wider access',
            displayReason: { en: 'Allow this operation with danger-full-access permissions: rm -rf build needs wider access', zh: '允许本次操作使用 danger-full-access 权限' },
        };
        const ask = (open, ms, outcome) => {
            Object.assign(window, { open, ms, outcome });
            return agent.ctx.waterfall('approval/request', request, () => Promise.resolve('unavailable'));
        };
        const outcomes = [];
        await agent.playTurn({
            send: async () => {
                outcomes.push(await ask(true, 100, 'allowed-once')); // answered in the window at once
                outcomes.push(await ask(false, 0, 'unused')); // no window: DSH answers "unavailable" at once
                outcomes.push(await ask(true, 3600, 'rejected')); // the person takes a while in DSH
                await sendAs(b, agent, thread.id, 'done');
            },
        });
        assert.deepEqual(outcomes, ['allowed-once', 'unavailable', 'rejected'], 'DSH\'s own answer passes through unchanged');
        const said = b.fake.botMessages(thread.id).map((m) => m.content).filter((x) => /approval/.test(x));
        // What the agent wants to do in plain words, never the tool's own name.
        assert.deepEqual(said, ['The agent is waiting for your approval in DSH to run a command (Allow this operation with danger-full-access permissions: rm -rf build needs wider access). Allow or refuse it in DSH, in the session “Discord — clean the build folder”; it cannot be answered from Discord.']);
        assert.equal(agent.ctx.listeners.get('approval/request').length, 2, 'the window\'s listener and the plugin\'s, nothing else');
    } finally {
        await b.stop();
    }
});

test('approval reasons: DSH\'s English display text, any other language, else the plain reason; never "[object Object]"', () => {
    assert.equal(reasonText({ displayReason: { en: 'Allow this', zh: '允许' }, reason: 'raw' }), 'Allow this');
    assert.equal(reasonText({ displayReason: { zh: '允许' }, reason: 'raw' }), '允许');
    assert.equal(reasonText({ displayReason: 'Shown as is', reason: 'raw' }), 'Shown as is');
    assert.equal(reasonText({ displayReason: { en: '  ' }, reason: 'raw' }), 'raw');
    assert.equal(reasonText({ reason: 'raw' }), 'raw');
    assert.equal(reasonText({ displayReason: { en: 42 } }), '');
    assert.equal(reasonText(undefined), '');
});

test('a turn DSH stopped in the middle of is said in its thread after the restart, once; a finished one is not', async () => {
    const dir = tempDir('discord-interrupted-');
    const file = join(dir, 's.json');
    const b = await bench({ store: file });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'a finished task' });
        await waitFor(() => b.created.length === 1, 'first session');
        const done = b.fake.threadsOf(b.channel.id)[0];
        await b.created[0].playTurn({ send: () => sendAs(b, b.created[0], done.id, 'all done') });
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'a long migration job' });
        await waitFor(() => b.created.length === 2 && b.created[1].followups.length === 1, 'second session');
        const cut = b.fake.threadsOf(b.channel.id)[1];
        b.created[1].setStatus('running');
        // DSH stops mid-turn: no idle, no reply.
        await b.client.stop();
        await b.router.dispose();
        const b2 = await bench({ store: file, fake: b.fake });
        await b2.router.catchUp();
        const said = b.fake.botMessages(cut.id).map((m) => m.content);
        assert.deepEqual(said, ['DSH stopped before the agent finished your last message (“a long migration job”). Send it again if you still need the answer.']);
        assert.deepEqual(b.fake.botMessages(done.id).map((m) => m.content), ['all done'], 'a finished turn gets nothing more');
        await b2.router.catchUp();
        await b2.stop();
        const b3 = await bench({ store: file, fake: b.fake });
        await b3.router.catchUp();
        assert.equal(b.fake.botMessages(cut.id).length, 1, 'said once, not at every start');
        await b3.stop();
    } finally {
        await b.fake.close();
    }
});

test('tools: post only in the bot\'s own channels, refuse empty text and bad paths in words, and answer without a client', async () => {
    const ws = tempDir('discord-ws-');
    const b = await bench({ config: { workspacePath: ws } });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        const elsewhere = b.fake.addChannel({ name: 'secret' });
        const ok = await b.tools.discord_send.execute({ channel_id: thread.id, content: 'hi' }, {});
        assert.equal(ok.ok, true);
        assert.match(ok.message, /^delivered to Discord \(message \d+\)$/);
        const out = await b.tools.discord_send.execute({ channel_id: elsewhere.id, content: 'leak' }, {});
        assert.equal(out.ok, false);
        assert.match(out.message, /outside the channels this bot may post in/);
        assert.equal(b.fake.botMessages(elsewhere.id).length, 0);
        assert.match((await b.tools.discord_send.execute({ channel_id: thread.id, content: '  ' }, {})).message, /the message is empty/);
        assert.match((await b.tools.discord_send.execute({ channel_id: 'general', content: 'x' }, {})).message, /is not a Discord channel id/);
        assert.match((await b.tools.discord_send_file.execute({ channel_id: thread.id, path: 'relative.txt' }, {})).message, /the path must be absolute/);
        const path = join(ws, 'result.csv');
        writeFileSync(path, 'a,b\n1,2\n');
        const file = await b.tools.discord_send_file.execute({ channel_id: thread.id, path, caption: 'the numbers' }, {});
        assert.equal(file.ok, true);
        assert.equal(b.fake.calls('POST', `/channels/${thread.id}/messages`).at(-1).body.files[0].filename, 'result.csv');
        const offline = discordTools({ defineTool, getClient: () => null, offlineReason: () => 'no bot token is stored under DISCORD_BOT_TOKEN', config: b.config });
        assert.equal((await offline[0].execute({ channel_id: thread.id, content: 'x' }, {})).message, 'discord: not sent, no bot token is stored under DISCORD_BOT_TOKEN');
        const anywhere = await bench({ config: { sendScope: 'any' }, fake: b.fake });
        assert.equal((await anywhere.tools.discord_send.execute({ channel_id: elsewhere.id, content: 'allowed now' }, {})).ok, true);
        await anywhere.stop();
    } finally {
        await b.stop();
    }
});

test('tools: every id a call names must be a Discord id, so a call acts only in the channel it names; a refused call makes no request', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const thread = b.fake.threadsOf(b.channel.id)[0]; // its id is the starter message's, in the allowed channel
        const elsewhere = b.fake.addChannel({ name: 'secret' });
        const before = b.fake.requests.length;
        const bad = [`${thread.id}/threads`, `../../../channels/${elsewhere.id}/messages/${thread.id}`, `${thread.id}?x=1`, `${thread.id}%2F..`, 'abc', '12345'];
        for (const id of bad) {
            const react = await b.tools.discord_react.execute({ channel_id: b.channel.id, message_id: id, emoji: '👍' }, {});
            assert.equal(react.ok, false, id);
            assert.match(react.message, /^discord: not sent, ".*" is not a Discord message id$/, id);
            const made = await b.tools.discord_create_thread.execute({ channel_id: b.channel.id, name: 'side thread', message_id: id }, {});
            assert.equal(made.ok, false, id);
            assert.match(made.message, /is not a Discord message id/, id);
            const reply = await b.tools.discord_send.execute({ channel_id: thread.id, content: 'hi', reply_to: id }, {});
            assert.equal(reply.ok, false, id);
            assert.match(reply.message, /is not a Discord message id \(reply_to\)/, id);
        }
        const asked = b.fake.requests.slice(before).filter((r) => !r.path.endsWith('/typing'));
        assert.deepEqual(asked.map((r) => `${r.method} ${r.path}`), [], 'no refused call reached Discord');
        assert.equal(b.fake.threadsOf(elsewhere.id).length, 0, 'no thread outside the allowed channels');
        // Real ids still work, in the channel named.
        assert.equal((await b.tools.discord_react.execute({ channel_id: b.channel.id, message_id: thread.id, emoji: '👍' }, {})).ok, true);
        assert.equal(b.fake.calls('PUT', /\/reactions\//).at(-1).path, `/channels/${b.channel.id}/messages/${thread.id}/reactions/${encodeURIComponent('👍')}/@me`);
        // The client checks every id it puts in a request path, whoever calls it.
        await assert.rejects(b.client.addReaction(b.channel.id, '1/../2', 'x'), /is not a Discord message id/);
        await assert.rejects(b.client.sendMessage('../users/@me', 'x'), /is not a Discord channel id/);
        await assert.rejects(b.client.createThread(b.channel.id, 'x', { messageId: 'abc' }), /is not a Discord message id/);
    } finally {
        await b.stop();
    }
});

test('a thread is the bot\'s only while its channel is allowed: once the channel leaves allowedChannelIds, its tools and commands refuse the thread', async () => {
    const dir = tempDir('discord-scope-');
    const file = join(dir, 's.json');
    const b = await bench({ store: file });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'the session');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        assert.equal((await sendAs(b, b.created[0], thread.id, 'while allowed')).ok, true);
        await b.client.stop();
        await b.router.dispose();
        // The owner moves the bot to another channel; the old thread is still in the store.
        const moved = b.fake.addChannel({ name: 'new-home' });
        const b2 = await bench({ store: file, fake: b.fake, config: { allowedChannelIds: [moved.id] } });
        assert.ok(b2.router.store.get(thread.id), 'the thread is still stored');
        const before = b.fake.botMessages(thread.id).length;
        const sent = await b2.tools.discord_send.execute({ channel_id: thread.id, content: 'after the move' }, {});
        assert.equal(sent.ok, false);
        assert.match(sent.message, /outside the channels this bot may post in/);
        assert.equal(b.fake.botMessages(thread.id).length, before, 'nothing posted there');
        const asked = b.fake.interaction({ channelId: thread.id, user: b.person, name: 'status' });
        assert.equal((await waitFor(() => b.fake.answerOf(asked), 'the answer')).text, 'This bot works only in its own channels and their threads.');
        await b2.stop();
    } finally {
        await b.fake.close();
    }
});

test('discord_react takes an emoji only: dots, plain words and empty text are refused before any request; a unicode or custom emoji works', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        const before = b.fake.requests.length;
        for (const emoji of ['.', '..', '../..', 'abc', '', '   ', '%2e%2e', 'thumbsup']) {
            const out = await b.tools.discord_react.execute({ channel_id: b.channel.id, message_id: thread.id, emoji }, {});
            assert.equal(out.ok, false, JSON.stringify(emoji));
            assert.match(out.message, /is not an emoji \(a unicode emoji, or name:id for a custom one\)$/, JSON.stringify(emoji));
        }
        assert.deepEqual(b.fake.requests.slice(before).filter((r) => !r.path.endsWith('/typing')).map((r) => `${r.method} ${r.path}`), [], 'none reached Discord');
        await assert.rejects(b.client.addReaction(b.channel.id, thread.id, '..'), /is not an emoji/);
        assert.equal((await b.tools.discord_react.execute({ channel_id: b.channel.id, message_id: thread.id, emoji: ' 👍 ' }, {})).ok, true);
        assert.equal(b.fake.calls('PUT', /\/reactions\//).at(-1).path, `/channels/${b.channel.id}/messages/${thread.id}/reactions/${encodeURIComponent('👍')}/@me`);
        assert.equal((await b.tools.discord_react.execute({ channel_id: b.channel.id, message_id: thread.id, emoji: 'party:123456789012345678' }, {})).ok, true);
        assert.equal(b.fake.calls('PUT', /\/reactions\//).at(-1).path, `/channels/${b.channel.id}/messages/${thread.id}/reactions/${encodeURIComponent('party:123456789012345678')}/@me`);
    } finally {
        await b.stop();
    }
});

test('tools: offered only to the sessions the bot runs for Discord, each in its own agent scope', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'first' });
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'second' });
        await waitFor(() => b.created.length === 2, 'two sessions');
        for (const agent of b.created) {
            assert.deepEqual(agent.ctx.tools.registered.map((t) => t.name), ['discord_send', 'discord_send_file', 'discord_typing', 'discord_create_thread', 'discord_react', 'discord_user']);
        }
        // DSH's own context (every other session's) gets none.
        assert.equal(b.ctx.tools, undefined, 'nothing is registered for all of DSH');
    } finally {
        await b.stop();
    }
});

test('tools: a session DSH keeps open loses the Discord tools when the plugin is unloaded', async () => {
    const b = await bench();
    const kept = new FakeAgent('kept-open-session'); // one the bot picked up rather than started: it outlives the plugin
    try {
        b.router.installHooks(kept.ctx, 'thread-1');
        assert.equal(kept.ctx.tools.registered.length, 6, 'the session the bot picked up has the six tools');
    } finally {
        await b.stop();
    }
    assert.deepEqual(kept.ctx.tools.registered.map((t) => t.name), [], 'none is left in it after unload');
    b.router.installHooks(kept.ctx, 'thread-1');
    assert.equal(kept.ctx.tools.registered.length, 0, 'an unloaded router registers nothing');
});

test('discord_send_file sends only files inside workspacePath: links and ".." are resolved first; the size limit stays', async () => {
    const ws = tempDir('discord-ws-');
    const outside = tempDir('discord-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'not for Discord');
    writeFileSync(join(ws, 'report.txt'), 'for Discord');
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'));
    symlinkSync(outside, join(ws, 'linked-folder'));
    const b = await bench({ config: { workspacePath: ws } });
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'start' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        const thread = b.fake.threadsOf(b.channel.id)[0];
        for (const path of [join(outside, 'secret.txt'), `${ws}/../${basename(outside)}/secret.txt`, join(ws, 'link.txt'), join(ws, 'linked-folder', 'secret.txt'), ws]) {
            const sent = await b.tools.discord_send_file.execute({ channel_id: thread.id, path }, {});
            assert.equal(sent.ok, false, path);
            assert.match(sent.message, /^discord: not sent, \S+ is outside the workspace folder; only files inside it can be sent$/, path);
        }
        assert.match((await b.tools.discord_send_file.execute({ channel_id: thread.id, path: join(ws, 'missing.txt') }, {})).message, /missing\.txt was not found/);
        assert.equal(b.fake.calls('POST', `/channels/${thread.id}/messages`).filter((c) => c.body?.files).length, 0, 'nothing was uploaded');
        const fine = await b.tools.discord_send_file.execute({ channel_id: thread.id, path: join(ws, 'report.txt') }, {});
        assert.equal(fine.ok, true, fine.message);
        assert.throws(() => readAttachment(join(ws, 'report.txt'), 3, ws), /report\.txt is 11 bytes; Discord takes at most 3/);
        // A hard link inside the folder is another name for a file that may lie outside it.
        linkSync(join(outside, 'secret.txt'), join(ws, 'hard-link.txt'));
        const hard = await b.tools.discord_send_file.execute({ channel_id: thread.id, path: join(ws, 'hard-link.txt') }, {});
        assert.match(hard.message, /^discord: not sent, hard-link\.txt has other names \(hard links\), which may lie outside the workspace folder/);
        assert.equal(b.fake.calls('POST', `/channels/${thread.id}/messages`).filter((c) => c.body?.files).length, 1, 'only the file inside was uploaded');
    } finally {
        await b.stop();
    }
});

test('turnReplyText reads the ending turn\'s last words from the session\'s history, never an earlier turn\'s', () => {
    const say = (id, role, ...content) => ({ id, role, content });
    const history = [
        say('u1', 'user', { type: 'text', text: 'first question' }),
        say('a1', 'assistant', { type: 'text', text: 'old answer' }),
        say('u2', 'user', { type: 'text', text: 'second question' }),
        say('a2', 'assistant', { type: 'text', text: 'first step' }, { type: 'toolCall', name: 'x' }),
        say('t2', 'tool', { type: 'text', text: 'tool output' }),
        say('a3', 'assistant', { type: 'text', text: 'final ' }, { type: 'text', text: 'words' }),
        say('n2', 'user', { type: 'text', text: 'the reminder' }),
        say('a4', 'assistant', { type: 'toolCall', name: 'y' }),
    ];
    const session = { deriveMessages: () => history };
    assert.equal(turnReplyText(session, 'u2'), 'final words', 'the newest text after the turn\'s first message');
    // A turn whose steps said nothing: no words, not the turn before's.
    const quiet = { deriveMessages: () => [...history.slice(0, 3), say('a5', 'assistant', { type: 'toolCall', name: 'z' })] };
    assert.equal(turnReplyText(quiet, 'u2'), '');
    assert.equal(turnReplyText(session, 'not-there'), '');
    assert.equal(turnReplyText(session, undefined), '');
    assert.equal(turnReplyText({ deriveMessages: () => { throw new Error('x'); } }, 'u2'), '');
    assert.equal(turnReplyText({}, 'u2'), '');
});

test('the store file is owner-only and keeps the documented shape', async () => {
    const b = await bench();
    try {
        b.fake.userMessage({ channelId: b.channel.id, author: b.person, content: 'hello' });
        await waitFor(() => b.created[0]?.followups.length === 1, 'turn');
        assert.equal(statSync(b.file).mode & 0o777, 0o600);
        const raw = JSON.parse(readFileSync(b.file, 'utf8'));
        assert.equal(raw.version, 1);
        const thread = b.fake.threadsOf(b.channel.id)[0];
        assert.equal(raw.threads[thread.id].sessionId, b.created[0].id);
        assert.ok(raw.seen.includes(thread.id), 'the anchor message is remembered as handled');
        assert.ok(raw.channels[b.channel.id].lastMessageId);
    } finally {
        await b.stop();
    }
});
