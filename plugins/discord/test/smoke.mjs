/**
 * Unit tests for dsh-plugin-discord. No Discord credentials required.
 * Covers: title cleaner (JSON scaffold, prefix echo, quotes, long text,
 * empty → derived fallback), collision suffixing, the fence-aware message
 * splitter, and session-key mapping (threadId → session, persistence).
 *
 * Run from the plugin root:  node test/smoke.mjs
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

/**
 * Host packages resolve from APP_MODULES when set (a DSH app bundle's
 * node_modules), else from normal Node resolution (e.g. `npm i` at the repo root).
 */
const APP_MODULES = process.env.APP_MODULES;
const resolveHost = (spec) => (APP_MODULES
    ? createRequire(join(APP_MODULES, 'dsh-brand/package.json')).resolve(spec)
    : import.meta.resolve(spec));

const { default: z } = await import(resolveHost('@deepseek-ai/schemastery'));
const { defineTool } = await import(resolveHost('@deepseek-ai/dsh-tools'));
const plugin = await import('../lib/index.js');
const { cleanTitle, deriveFallbackTitle, uniquifyTitle, capTitle } = await import('../lib/titles.js');
const { splitForDiscord } = await import('../lib/split.js');
const { SessionStore } = await import('../lib/store.js');
const { parseTitleModel } = await import('../lib/router.js');

let passed = 0;
const test = (label, fn) => {
    try {
        fn();
        passed += 1;
        console.log(`ok - ${label}`);
    } catch (error) {
        console.error(`FAIL - ${label}`);
        throw error;
    }
};

// ── config ──────────────────────────────────────────────────────────────────

test('config schema carries the spec fields with defaults', () => {
    const config = plugin.Config({ workspacePath: '/tmp/ws' });
    assert.equal(config.enabled, true);
    assert.equal(config.tokenRef, 'DISCORD_BOT_TOKEN');
    assert.deepEqual(config.allowedChannelIds, []);
    assert.deepEqual(config.allowedUserIds, []);
    assert.equal(config.requireMention, false);
    assert.equal(config.autoThread, true);
    assert.equal(config.threadArchiveMinutes, 1440);
    assert.equal(config.storeFile, '~/.dsh/discord-plugin-sessions.json');
});

test('plugin exports the expected cordis contract', () => {
    assert.equal(plugin.name, 'discord-plugin');
    assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('tools') && plugin.inject.includes('llm'));
    assert.equal(typeof plugin.apply, 'function');
});

// ── title cleaner ───────────────────────────────────────────────────────────

test('title cleaner: plain text passes', () => {
    assert.equal(cleanTitle('Fix login redirect loop'), 'Fix login redirect loop');
});

test('title cleaner: strips quotes and markdown', () => {
    assert.equal(cleanTitle('"Fix the bug"'), 'Fix the bug');
    assert.equal(cleanTitle('`Fix the bug`'), 'Fix the bug');
    assert.equal(cleanTitle('**Fix the bug**.'), 'Fix the bug');
    assert.equal(cleanTitle('## Fix the bug'), 'Fix the bug');
});

test('title cleaner: rejects JSON scaffold', () => {
    assert.equal(cleanTitle('{"title": "Fix the bug"}'), '');
    assert.equal(cleanTitle('{'), '');
    assert.equal(cleanTitle('title: Fix the bug'), '');
});

test('title cleaner: strips wrapper/metadata prefixes', () => {
    assert.equal(cleanTitle('[Triggering message id 12345] Fix the bug'), 'Fix the bug');
    assert.equal(cleanTitle('[metadata only]'), '');
});

test('title cleaner: rejects echoed prompt text', () => {
    const prompt = 'please help me fix the login redirect loop in the app';
    assert.equal(cleanTitle(prompt, prompt), '');
});

test('title cleaner: collapses newlines, caps at 100', () => {
    const long = 'A '.repeat(80) + 'end';
    const out = cleanTitle(long);
    assert.ok(out.length <= 100, `length ${out.length}`);
    assert.ok(!out.includes('\n'));
    assert.equal(cleanTitle('Line one\nLine two'), 'Line one Line two');
    assert.equal(capTitle('x'.repeat(150)).length, 100);
});

test('title cleaner: empty and non-string reject to derived fallback', () => {
    assert.equal(cleanTitle(''), '');
    assert.equal(cleanTitle(null), '');
    assert.equal(cleanTitle('   '), '');
    const fallback = deriveFallbackTitle('Help me design a rate limiter for the API gateway');
    assert.ok(fallback.length > 0 && fallback.length <= 100);
    assert.ok(fallback.toLowerCase().includes('rate limiter'), `fallback: ${fallback}`);
    assert.equal(deriveFallbackTitle(''), 'conversation');
});

// ── collision suffixing ─────────────────────────────────────────────────────

test('collision suffixing adds #2, #3', () => {
    const existing = ['Deploy notes', 'Deploy notes #2'];
    assert.equal(uniquifyTitle('Deploy notes', 't1', () => existing), 'Deploy notes #3');
    assert.equal(uniquifyTitle('Unique', 't1', () => existing), 'Unique');
    assert.equal(uniquifyTitle('deploy notes', 't1', () => ['Deploy notes']), 'deploy notes #2');
    assert.equal(uniquifyTitle('X', 't1', () => []), 'X');
});

// ── splitter ────────────────────────────────────────────────────────────────

test('splitter: short text is one chunk', () => {
    assert.deepEqual(splitForDiscord('hello', 2000), ['hello']);
});

test('splitter: long plain text splits at line boundaries within limit', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const chunks = splitForDiscord(text, 2000);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 2000), `max len ${Math.max(...chunks.map((c) => c.length))}`);
    assert.equal(chunks.join('\n'), text);
});

test('splitter: never splits inside a code fence (closed and reopened)', () => {
    const codeLine = 'const x = ' + '1 + '.repeat(200) + '1;'; // long code line
    const text = 'Intro paragraph\n\n```js\n' + Array.from({ length: 40 }, () => codeLine).join('\n') + '\n```\n\nOutro';
    const chunks = splitForDiscord(text, 2000);
    assert.ok(chunks.length > 2, `chunks: ${chunks.length}`);
    for (const chunk of chunks) {
        const fences = (chunk.match(/^```/gm) ?? []).length;
        assert.equal(fences % 2, 0, `unbalanced fences in chunk of ${chunk.length}: ${chunk.slice(0, 80)}`);
    }
    // Content preserved (order intact, all code lines present).
    const rejoined = chunks.join('\n').replace(/^```(js)?\n/gm, '').replace(/\n```$/gm, '');
    for (let i = 0; i < 40; i++) assert.ok(rejoined.includes(codeLine), `missing code line ${i}`);
});

test('splitter: hard-splits a single overlong line', () => {
    const line = 'y'.repeat(4500);
    const chunks = splitForDiscord(line, 2000);
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every((c) => c.length <= 2000));
    assert.equal(chunks.join(''), line);
});

// ── session-key mapping (store) ────────────────────────────────────────────

test('store maps thread ids to sessions and persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-discord-store-'));
    const file = join(dir, 'sessions.json');
    const store = new SessionStore(file);
    assert.equal(store.get('thread-1'), null);

    store.put('thread-1', { sessionId: 'discord-t1-aaa', title: 'First', tempName: 'First', renamed: false, turnCount: 2 });
    store.put('thread-2', { sessionId: 'discord-t2-bbb', title: 'First', tempName: 'First', renamed: false, turnCount: 0 });

    // Session key is the thread id: each thread maps to its own session.
    assert.equal(store.get('thread-1').sessionId, 'discord-t1-aaa');
    assert.equal(store.get('thread-2').sessionId, 'discord-t2-bbb');
    assert.deepEqual(store.titlesExcluding('thread-1'), ['First']);
    assert.deepEqual(store.titlesExcluding('thread-2'), ['First']);

    // Persistence: a fresh instance reads the same mapping.
    const reloaded = new SessionStore(file);
    assert.equal(reloaded.get('thread-1').sessionId, 'discord-t1-aaa');
    assert.equal(reloaded.get('thread-1').turnCount, 2);
    assert.deepEqual(reloaded.titlesExcluding('thread-2'), ['First']);

    reloaded.delete('thread-2');
    assert.equal(new SessionStore(file).get('thread-2'), null);
    assert.ok(existsSync(file));
});

// ── title model parsing ─────────────────────────────────────────────────────

test('title model spec parsing', () => {
    const fakeCtx = { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) } };
    assert.deepEqual(parseTitleModel('pi/pi-ai/glm-5'), ['pi', 'pi-ai/glm-5']);
    assert.deepEqual(parseTitleModel('glm-5:fast'), ['glm-5', 'fast']);
    assert.deepEqual(parseTitleModel('glm-5', fakeCtx), ['deepseek', 'glm-5']);
});

// ── route overrides (/model, /effort) ───────────────────────────────────────

test('route override: model spec replaces provider+model, keeps the rest', async () => {
    const { applyRouteOverride } = await import('../lib/router.js');
    const resolved = { provider: 'a', model: 'm1', reasoningEffort: 'low', maxTokens: 999 };
    const out = applyRouteOverride(resolved, 'b:m2');
    assert.deepEqual({ provider: out.provider, model: out.model }, { provider: 'b', model: 'm2' });
    assert.equal(out.reasoningEffort, 'low');
    assert.equal(out.maxTokens, 999);
    assert.deepEqual({ provider: resolved.provider, model: resolved.model }, { provider: 'a', model: 'm1' }); // input untouched
});

test('route override: bare model id inherits the resolved provider', async () => {
    const { applyRouteOverride } = await import('../lib/router.js');
    const out = applyRouteOverride({ provider: 'a', model: 'm1' }, 'm9');
    assert.deepEqual({ provider: out.provider, model: out.model }, { provider: 'a', model: 'm9' });
});

test('route override: effort set/clear/absent semantics', async () => {
    const { applyRouteOverride } = await import('../lib/router.js');
    const base = { provider: 'a', model: 'm', reasoningEffort: 'low' };
    assert.equal(applyRouteOverride(base, undefined, 'high').reasoningEffort, 'high');
    assert.equal(applyRouteOverride(base, undefined, null).reasoningEffort, undefined);
    assert.equal(applyRouteOverride(base, undefined, undefined).reasoningEffort, 'low');
    assert.equal('reasoningEffort' in applyRouteOverride(base, undefined, null), false);
});

// ── store: override tri-state survives persistence ──────────────────────────

test('store persists model/effort overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-discord-store-'));
    const file = join(dir, 'sessions.json');
    const store = new SessionStore(file);
    store.put('t', { modelOverride: 'b:m2', effortOverride: null });
    const reloaded = new SessionStore(file).get('t');
    assert.equal(reloaded.modelOverride, 'b:m2');
    assert.equal(reloaded.effortOverride, null); // null = cleared, must survive
});

// ── tools ───────────────────────────────────────────────────────────────────

test('tools compile through the host defineTool and answer without a client', async () => {
    const { discordTools } = await import('../lib/tools.js');
    const tools = discordTools({ getClient: () => null, config: {} });
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ['discord_send', 'discord_send_file', 'discord_typing', 'discord_create_thread', 'discord_react', 'discord_user']);
    const result = await tools[0].execute({ channel_id: 'c', content: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.message, /no bot token/);
});

// ── plugin idle behavior ────────────────────────────────────────────────────

test('plugin apply registers tools and stays idle without a token', async () => {
    const registered = [];
    const effects = [];
    const fakeCtx = {
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        credentials: { resolve: async () => undefined },
        tools: { register: (tool) => registered.push(tool.name) },
        effect: (fn) => effects.push(fn),
    };
    const config = plugin.Config({ workspacePath: '/tmp/ws', apiBase: 'http://127.0.0.1:1', traceFile: '' });
    plugin.apply(fakeCtx, config);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(registered.length, 6, `tools: ${registered.join(', ')}`);
    assert.equal(effects.length, 1);
});

test('REST failure path produces a descriptive error', async () => {
    const { DiscordClient } = await import('../lib/client.js');
    const client = new DiscordClient({
        token: 'fake-token',
        apiBase: 'http://127.0.0.1:1',
        requestTimeoutMs: 1500,
        logger: { info() {}, warn() {}, debug() {} },
        onMessage: () => {},
    });
    await assert.rejects(() => client.rest('GET', '/gateway/bot'), /discord REST GET \/gateway\/bot/);
});

test('store file content is the documented versioned shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-discord-store-'));
    const file = join(dir, 'sessions.json');
    const store = new SessionStore(file);
    store.put('t', { sessionId: 's', title: 'T', turnCount: 1 });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.threads.t.sessionId, 's');
});

console.log(`\n${passed} unit tests passed`);
process.exit(0);
