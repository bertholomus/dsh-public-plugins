/**
 * lib/index.js with DSH's own packages (schemastery, defineTool, the llm
 * helpers): the settings schema never refuses a value, the tools compile
 * through DSH's defineTool, and apply() connects to the fake Discord,
 * registers the slash commands, routes a message into a session and lets go
 * of everything on unload; switched off, offline, or without a token it
 * stays quiet and says why. Real DSH runs it end to end in test/e2e.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { repoRoot, useDshModules } from '../support/dsh-modules.mjs';
import { FakeAgent, fakeCtx } from '../support/fake-host.mjs';
import { startFakeDiscord, waitFor } from '../support/fake-discord.mjs';
import { tempDir } from '../support/temp.mjs';

const modules = useDshModules();
const plugin = await import('../../lib/index.js');
const { defineTool } = await import('@deepseek-ai/dsh-tools');
const { discordTools } = await import('../../lib/tools.js');
// DSH's own: the model choice it puts on every session it opens, and how its Plugins page reads a plugin's face.
const { installModelSelection } = await import('@deepseek-ai/dsh-agent');
const { readPluginMeta } = await import('@deepseek-ai/dsh-app-boot');

/** A plugin context: the stand-in services plus tools, credentials and effects. */
function pluginCtx({ token } = {}) {
    const base = fakeCtx();
    const tools = [];
    const disposers = [];
    const ctx = {
        ...base.ctx,
        tools: { register: (tool) => tools.push(tool) },
        credentials: { resolve: async (ref) => (token && ref === 'E2E_FAKE_DISCORD_TOKEN' ? { value: token } : undefined) },
        effect: (fn) => disposers.push(fn()),
    };
    const unload = async () => {
        for (const dispose of disposers.reverse()) await dispose?.();
    };
    return { ...base, ctx, tools, unload };
}

const dir = () => tempDir('discord-host-');
/** The plugin's log lines as DSH prints them. */
const lines = (p, level) => p.logs.filter((l) => !level || l[0] === level).map((l) => format(...l.slice(1)));

test(`DSH packages from ${modules}`, () => {
    assert.ok(modules.endsWith('node_modules'));
});

test('the plugin contract DSH loads: name, injected services, Config, apply', () => {
    assert.equal(plugin.name, 'discord-plugin');
    for (const service of ['tools', 'llm', 'agents', 'credentials']) assert.ok(plugin.inject.includes(service), service);
    assert.equal(typeof plugin.Config, 'function');
    assert.equal(typeof plugin.apply, 'function');
});

test('Config: every setting has a default, and no value (a wrong type, a string for a list) is refused at load', () => {
    const config = plugin.Config({});
    assert.equal(config.enabled, true);
    assert.equal(config.tokenRef, 'DISCORD_BOT_TOKEN');
    assert.deepEqual(config.allowedChannelIds, []);
    assert.equal(config.permissionPreset, 'workspace-write');
    assert.doesNotThrow(() => plugin.Config({ maxPromptChars: 'lots', allowedUserIds: 111111111111111111, enabled: 'yes' }));
});

test('the six tools compile through DSH\'s defineTool', () => {
    const { settings } = plugin.readConfig({});
    const tools = discordTools({ defineTool, getClient: () => null, config: settings });
    assert.deepEqual(tools.map((t) => t.name), ['discord_send', 'discord_send_file', 'discord_typing', 'discord_create_thread', 'discord_react', 'discord_user']);
});

test('apply without a token: no tool is registered for DSH\'s sessions, and the log says what to do', async () => {
    const p = pluginCtx();
    plugin.apply(p.ctx, { workspacePath: dir(), tokenRef: 'E2E_FAKE_DISCORD_TOKEN', allowedChannelIds: ['2222222222222222222'], allowedUserIds: ['111111111111111111'], traceFile: '', storeFile: join(dir(), 's.json') });
    await waitFor(() => lines(p, 'warn').some((l) => /no bot token under the credential name E2E_FAKE_DISCORD_TOKEN/.test(l)), 'the warning');
    assert.equal(p.tools.length, 0, 'the Discord tools go only to the bot\'s own sessions, never to all of DSH');
    await p.unload();
});

test('apply switched off, offline (a bad allowlist) or without a usable workspace folder: no tools, no connection, a line in words', async () => {
    const fake = await startFakeDiscord({ token: 'tok' });
    const fileNotFolder = join(dir(), 'a-file');
    writeFileSync(fileNotFolder, 'x');
    try {
        for (const [row, said] of [
            [{ enabled: false }, /switched off \(enabled: false\)/],
            [{ allowedUserIds: [111111111111111111] }, /the bot stays offline: allowedUserIds is not a list of Discord ids in quotes/],
            [{ workspacePath: '' }, /workspacePath is not set, so the bot stays offline/],
            [{ workspacePath: 'relative/ws' }, /the bot stays offline: workspacePath "relative\/ws" is not an absolute path/],
            [{ workspacePath: '/no/such/discord-workspace' }, /the bot stays offline: workspacePath \/no\/such\/discord-workspace does not exist/],
            [{ workspacePath: fileNotFolder }, /the bot stays offline: workspacePath \S+ is not a folder/],
        ]) {
            const p = pluginCtx({ token: 'tok' });
            plugin.apply(p.ctx, { workspacePath: dir(), tokenRef: 'E2E_FAKE_DISCORD_TOKEN', apiBase: fake.apiBase, traceFile: '', storeFile: join(dir(), 's.json'), ...row });
            await new Promise((r) => setTimeout(r, 100));
            assert.equal(p.tools.length, 0);
            assert.ok(lines(p).some((l) => said.test(l)), lines(p).join('\n'));
            await p.unload();
        }
        assert.equal(fake.requests.length, 0, 'the fake Discord heard nothing');
    } finally {
        await fake.close();
    }
});

test('apply with wrong settings still loads, names each refused value, and uses the defaults', async () => {
    const p = pluginCtx();
    assert.doesNotThrow(() => plugin.apply(p.ctx, { workspacePath: dir(), maxPromptChars: 'lots', threadArchiveMinutes: 7, traceFile: '', storeFile: join(dir(), 's.json') }));
    const refused = lines(p, 'warn').filter((l) => /setting refused/.test(l));
    assert.equal(refused.length, 2, refused.join('\n'));
    assert.ok(refused.some((l) => /setting refused: maxPromptChars must be a whole number/.test(l)), refused.join('\n'));
    assert.ok(refused.some((l) => /setting refused: threadArchiveMinutes must be one of 60, 1440, 4320, 10080/.test(l)), refused.join('\n'));
    await p.unload();
});

test('every line the plugin logs is in its trace file too, as a log event (DSH keeps plugin log lines in memory only)', async () => {
    const p = pluginCtx();
    const traceFile = join(dir(), 'trace.log');
    plugin.apply(p.ctx, { workspacePath: '', maxPromptChars: 'lots', traceFile, storeFile: join(dir(), 's.json') });
    const logged = readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'log');
    assert.deepEqual(logged.map((e) => [e.status, e.text]), lines(p).map((text, i) => [p.logs[i][0], text]), 'the same lines, in the same order, at the same level');
    assert.ok(logged.some((e) => e.status === 'warn' && /^discord: setting refused: maxPromptChars must be a whole number/.test(e.text)));
    assert.ok(logged.some((e) => e.status === 'warn' && e.text === 'discord: workspacePath is not set, so the bot stays offline; set it to the folder Discord sessions should work in, then reload'));
    await p.unload();
});

test('apply connected to the fake Discord: slash commands registered, a message becomes a session, unload lets go', async () => {
    const fake = await startFakeDiscord({ token: 'tok' });
    const channel = fake.addChannel({ name: 'deepseek-harness' });
    const person = fake.addUser({ username: 'albert' });
    const p = pluginCtx({ token: 'tok' });
    try {
        plugin.apply(p.ctx, {
            workspacePath: dir(), tokenRef: 'E2E_FAKE_DISCORD_TOKEN', apiBase: fake.apiBase,
            allowedChannelIds: [channel.id], allowedUserIds: [person.id], traceFile: '', storeFile: join(dir(), 's.json'),
        });
        await waitFor(() => lines(p).some((l) => /gateway connected; listening for messages/.test(l)), 'connected');
        await waitFor(() => fake.commands.length === plugin.COMMANDS.length, 'the slash commands');
        assert.deepEqual(fake.commands.map((c) => c.name).sort(), ['effort', 'model', 'new', 'rename', 'reset', 'status', 'stop']);
        fake.userMessage({ channelId: channel.id, author: person, content: 'hello bot' });
        await waitFor(() => p.created[0]?.followups.length === 1, 'the session and its turn');
        assert.equal(fake.threadsOf(channel.id).length, 1);
        assert.equal(p.tools.length, 0, 'no Discord tool is registered for all of DSH');
        assert.deepEqual(p.created[0].ctx.tools.registered.map((t) => t.name), ['discord_send', 'discord_send_file', 'discord_typing', 'discord_create_thread', 'discord_react', 'discord_user'], 'the bot\'s own session has them, in its own scope');
        await p.unload();
        await waitFor(() => !fake.connected(), 'the gateway let go');
        assert.equal(p.created[0].disposed, true, 'the session it opened is let go too');
    } finally {
        await fake.close();
    }
});

test('the Plugins page, as DSH reads it: the title Discord, one plain sentence, and the plugin\'s own icon', () => {
    // DSH reads a plugin's face from its package (locale/en.json and package.json's icon) without running it.
    const home = dir();
    mkdirSync(join(home, 'node_modules'));
    symlinkSync(repoRoot, join(home, 'node_modules', 'dsh-plugin-discord'));
    const meta = readPluginMeta('dsh-plugin-discord', pathToFileURL(join(home, 'index.js')).href);
    assert.equal(meta.error, undefined, meta.error);
    assert.deepEqual(meta.title, { en: 'Discord' });
    assert.match(meta.description.en, /^A Discord bot for your own channels: each conversation gets a thread and its own DSH session/);
    assert.ok(!/[`{}\[\]]|discord_|\bid\b/.test(meta.description.en), 'plain words: no tool names, ids or code');
    assert.ok(meta.icon.startsWith('data:image/svg+xml;base64,'));
    const svg = Buffer.from(meta.icon.split(',')[1], 'base64').toString('utf8');
    assert.match(svg, /^<svg width="36" height="36" viewBox="0 0 36 36"/);
});

test('a session DSH opened first, with DSH\'s own model choice on it: /model and /effort still decide its requests; /model default and /new give it back', async () => {
    const fake = await startFakeDiscord({ token: 'tok' });
    const channel = fake.addChannel({ name: 'deepseek-harness' });
    const person = fake.addUser({ username: 'albert' });
    const settings = {
        workspacePath: dir(), tokenRef: 'E2E_FAKE_DISCORD_TOKEN', apiBase: fake.apiBase,
        allowedChannelIds: [channel.id], allowedUserIds: [person.id], traceFile: '', storeFile: join(dir(), 's.json'),
    };
    const connected = (p) => waitFor(() => lines(p).some((l) => /gateway connected; listening for messages/.test(l)), 'connected');
    const first = pluginCtx({ token: 'tok' });
    const second = pluginCtx({ token: 'tok' });
    try {
        plugin.apply(first.ctx, settings);
        await connected(first);
        fake.userMessage({ channelId: channel.id, author: person, content: 'hello bot' });
        await waitFor(() => first.created[0]?.followups.length === 1, 'the first session');
        const thread = fake.threadsOf(channel.id)[0];
        const sessionId = first.created[0].id;
        await first.unload();

        // DSH restarts, and the person opens the Discord session in DSH before the next Discord message: DSH's
        // session controller puts its own model choice on it, ahead of anything the bot adds later.
        const opened = new FakeAgent(sessionId);
        const dshChoice = { provider: 'fake', model: 'fake-model', reasoningEffort: 'low' };
        const selection = { current: dshChoice, assembled: dshChoice };
        installModelSelection(opened.ctx, selection);
        second.open.set(sessionId, opened);
        plugin.apply(second.ctx, settings);
        await connected(second);
        fake.userMessage({ channelId: thread.id, author: person, content: 'are you there?' });
        await waitFor(() => opened.followups.length === 1, 'the open session picked up');
        assert.equal(opened.ctx.tools.registered.length, 6, 'it has the Discord tools while it is the thread\'s');
        const ask = async (name, value) => {
            const asked = fake.interaction({ channelId: thread.id, user: person, name, value });
            return (await waitFor(() => fake.answerOf(asked), `the answer to /${name}`)).text;
        };
        const request = () => opened.ctx.waterfall('agent/request', {}, { provider: 'fake', model: 'fake-model', reasoningEffort: 'low' });
        const route = (r) => [r.provider, r.model, r.reasoningEffort];

        assert.deepEqual(route(await request()), ['fake', 'fake-model', 'low'], 'DSH\'s choice before any command');
        assert.match(await ask('model', 'other:big-model'), /set to \*\*other:big-model\*\*, from the next turn/);
        assert.deepEqual(route(await request()), ['other', 'big-model', 'low'], '/model wins over DSH\'s own choice');
        await ask('effort', 'high');
        assert.deepEqual(route(await request()), ['other', 'big-model', 'high'], '/effort too');
        // DSH's choice for a session it opened follows the model the session used last: by now, /model's.
        selection.current = selection.assembled = { provider: 'other', model: 'big-model' };
        assert.equal(await ask('model', 'default'), 'Model for this thread back to the DSH default, from the next turn.');
        assert.deepEqual(route(await request()), ['fake', 'fake-model', 'high'], 'the model is DSH\'s default again, not the last one used');
        selection.current = selection.assembled = dshChoice;
        await ask('model', 'other:big-model');

        // /new: the session stays in DSH, but it is no longer the thread's: no Discord tool, no listener of the bot's.
        assert.match(await ask('new'), /^Session cleared\. Your next message here starts a fresh session, listed in DSH as “Discord — .+ \(session 2\)”/);
        assert.deepEqual(opened.ctx.tools.registered, [], 'no Discord tool left in the old session');
        assert.equal(opened.ctx.listeners.get('agent/request').length, 1, 'only DSH\'s own listener is left');
        assert.deepEqual(route(await request()), ['fake', 'fake-model', 'low'], 'and its requests are DSH\'s choice alone');
        // The thread's next session is a new one, numbered, and the old one is untouched by its /model.
        fake.userMessage({ channelId: thread.id, author: person, content: 'start over' });
        await waitFor(() => second.created.length === 1 && second.created[0].followups.length === 1, 'a fresh session');
        assert.match(second.renames.at(-1).title, /^Discord — .+ \(session 2\)$/);
        await ask('model', 'third:other-model');
        assert.deepEqual(route(await request()), ['fake', 'fake-model', 'low']);
        assert.deepEqual(route(await second.created[0].ctx.waterfall('agent/request', {}, { provider: 'fake', model: 'fake-model' })).slice(0, 2), ['third', 'other-model']);
    } finally {
        await first.unload();
        await second.unload();
        await fake.close();
    }
});
