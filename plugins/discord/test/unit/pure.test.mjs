/**
 * The plain modules: settings in words, file places, titles, the
 * fence-aware splitter, the store, the trace, and route overrides.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, quietReasons, readConfig } from '../../lib/config.js';
import { resolvePath } from '../../lib/paths.js';
import { applyRouteOverride, inWords, parseTitleModel, readAttachment } from '../../lib/router.js';
import { splitForDiscord } from '../../lib/split.js';
import { SessionStore, newerId } from '../../lib/store.js';
import { capTitle, cleanTitle, deriveFallbackTitle, uniquifyTitle } from '../../lib/titles.js';
import { initTrace, stopTrace, teeLogger, write } from '../../lib/trace.js';
import { repoRoot } from '../support/dsh-modules.mjs';
import { tempDir } from '../support/temp.mjs';

const ID = '111111111111111111';
const CH = '2222222222222222222';

// ── settings ────────────────────────────────────────────────────────────

test('settings: nothing set gives the defaults and no problems', () => {
    const { settings, problems, offline } = readConfig({});
    assert.deepEqual(problems, []);
    assert.equal(offline, null);
    for (const [key, value] of Object.entries(DEFAULTS)) assert.deepEqual(settings[key], Array.isArray(value) ? [...value] : value, key);
});

test('settings: the live row reads as it is', () => {
    const { settings, problems } = readConfig({
        workspacePath: '/Users/someone/dshbot', tokenRef: 'DISCORD_BOT_TOKEN', permissionPreset: 'danger-full-access',
        allowedUserIds: [ID], allowedChannelIds: [CH], requireMention: false, autoThread: true, threadArchiveMinutes: 1440,
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(settings.allowedUserIds, [ID]);
    assert.equal(settings.permissionPreset, 'danger-full-access');
});

test('settings: wrong values fall back to defaults with a sentence each; nothing throws', () => {
    const { settings, problems, offline } = readConfig({
        enabled: 'yes', maxPromptChars: 'lots', requestTimeoutMs: -5, threadArchiveMinutes: 30, sendScope: 'everywhere',
        apiBase: 'not a url', models: 'gpt', catchUpMinutes: 1.5, surprise: 1, titleTimeoutMs: '5000',
    });
    assert.equal(offline, null);
    assert.equal(settings.enabled, true);
    assert.equal(settings.maxPromptChars, 8000);
    assert.equal(settings.requestTimeoutMs, 15000);
    assert.equal(settings.threadArchiveMinutes, 1440);
    assert.equal(settings.sendScope, 'allowed');
    assert.equal(settings.apiBase, '');
    assert.deepEqual(settings.models, []);
    assert.equal(settings.catchUpMinutes, 120);
    assert.equal(settings.titleTimeoutMs, 5000, 'a number in quotes is read as the number');
    assert.equal(problems.length, 9, problems.join('\n'));
    assert.ok(problems.includes('enabled must be true or false, not "yes"; using true.'));
    assert.ok(problems.includes('threadArchiveMinutes must be one of 60, 1440, 4320, 10080 (Discord\'s choices), not 30; using 1440.'));
    assert.ok(problems.includes('surprise is not a setting of this plugin; it is ignored.'));
    assert.ok(problems.some((p) => p.startsWith('maxPromptChars must be a whole number from 500 to 200000 characters, not "lots"')));
    assert.deepEqual(readConfig(null).problems, []);
    assert.deepEqual(readConfig('garbage').problems, []);
});

test('settings: a bad allowlist never falls back to "anyone": the bot stays offline and says why', () => {
    const unquoted = readConfig({ allowedUserIds: [111111111111111111] });
    assert.match(unquoted.offline, /allowedUserIds/);
    assert.deepEqual(unquoted.settings.allowedUserIds, []);
    assert.match(unquoted.problems[0], /without quotes \(YAML rounds long numbers, so it can never match\); write it in quotes; the bot stays offline/);
    assert.match(readConfig({ allowedChannelIds: { a: 1 } }).offline, /allowedChannelIds/);
    assert.match(readConfig({ allowedChannelIds: ['general'] }).problems[0], /"general", which is not a Discord id/);
    const single = readConfig({ allowedUserIds: ID });
    assert.equal(single.offline, null, 'one id in quotes is a list of one');
    assert.deepEqual(single.settings.allowedUserIds, [ID]);
    const extra = readConfig({ extraSendChannelIds: [12] });
    assert.equal(extra.offline, null, 'a bad extra send list only empties itself');
    assert.deepEqual(extra.settings.extraSendChannelIds, []);
});

test('settings: a quiet bot says why at start', () => {
    assert.match(quietReasons(readConfig({}).settings)[0], /allowedChannelIds is empty, so the bot ignores every message/);
    assert.match(quietReasons(readConfig({ allowedChannelIds: [CH] }).settings)[0], /allowedUserIds is empty, so anyone who can post/);
    assert.deepEqual(quietReasons(readConfig({ allowedChannelIds: [CH], allowedUserIds: [ID] }).settings), []);
});

test('paths: ~/.dsh/ follows DSH_HOME (a test home never touches the real one); other ~ paths are the home folder', () => {
    assert.equal(resolvePath('~/.dsh/discord-plugin-sessions.json', { DSH_HOME: '/tmp/home-x' }), '/tmp/home-x/discord-plugin-sessions.json');
    assert.equal(resolvePath('~/.dsh/discord-plugin-sessions.json', {}), join(homedir(), '.dsh', 'discord-plugin-sessions.json'));
    assert.equal(resolvePath('~/notes/x', { DSH_HOME: '/tmp/home-x' }), join(homedir(), 'notes', 'x'));
    assert.equal(resolvePath('/abs/path', {}), '/abs/path');
});

// ── titles ──────────────────────────────────────────────────────────────

test('titles: plain text passes; quotes, markdown and trailing punctuation go', () => {
    assert.equal(cleanTitle('Fix login redirect loop'), 'Fix login redirect loop');
    assert.equal(cleanTitle('"Fix the bug"'), 'Fix the bug');
    assert.equal(cleanTitle('`Fix the bug`'), 'Fix the bug');
    assert.equal(cleanTitle('**Fix the bug**.'), 'Fix the bug');
    assert.equal(cleanTitle('## Fix the bug'), 'Fix the bug');
});

test('titles: JSON scaffolds, bare metadata and echoes of the prompt are refused', () => {
    assert.equal(cleanTitle('{"title": "Fix the bug"}'), '');
    assert.equal(cleanTitle('{'), '');
    assert.equal(cleanTitle('title: Fix the bug'), '');
    assert.equal(cleanTitle('[Triggering message id 12345] Fix the bug'), 'Fix the bug');
    assert.equal(cleanTitle('[metadata only]'), '');
    const prompt = 'please help me fix the login redirect loop in the app';
    assert.equal(cleanTitle(prompt, prompt), '');
});

test('titles: one line, at most 100 characters, cut at a word; a fallback from the person\'s own words', () => {
    const out = cleanTitle(`${'A '.repeat(80)}end`);
    assert.ok(out.length <= 100 && !out.includes('\n'));
    assert.equal(cleanTitle('Line one\nLine two'), 'Line one Line two');
    assert.equal(capTitle('x'.repeat(150)).length, 100);
    assert.equal(cleanTitle(''), '');
    assert.equal(cleanTitle(null), '');
    const fallback = deriveFallbackTitle('Help me design a rate limiter for the API gateway');
    assert.ok(fallback.toLowerCase().includes('rate limiter'), fallback);
    assert.equal(deriveFallbackTitle(''), 'conversation');
});

test('titles: collisions get #2, #3 (case does not matter)', () => {
    const existing = ['Deploy notes', 'Deploy notes #2'];
    assert.equal(uniquifyTitle('Deploy notes', 't1', () => existing), 'Deploy notes #3');
    assert.equal(uniquifyTitle('Unique', 't1', () => existing), 'Unique');
    assert.equal(uniquifyTitle('deploy notes', 't1', () => ['Deploy notes']), 'deploy notes #2');
});

// ── splitter ────────────────────────────────────────────────────────────

test('splitter: short text is one part; long text splits at lines, within the limit, losing nothing', () => {
    assert.deepEqual(splitForDiscord('hello', 2000), ['hello']);
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const chunks = splitForDiscord(text, 2000);
    assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 2000));
    assert.equal(chunks.join('\n'), text);
});

test('splitter: never cuts inside a code fence (closed and reopened with its language)', () => {
    const codeLine = `const x = ${'1 + '.repeat(200)}1;`;
    const text = `Intro paragraph\n\n\`\`\`js\n${Array.from({ length: 40 }, () => codeLine).join('\n')}\n\`\`\`\n\nOutro`;
    const chunks = splitForDiscord(text, 2000);
    assert.ok(chunks.length > 2);
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 2000);
        assert.equal((chunk.match(/^```/gm) ?? []).length % 2, 0, `unbalanced: ${chunk.slice(0, 60)}`);
    }
    assert.ok(chunks.slice(1, -1).every((c) => c.startsWith('```js')), 'reopened with the language');
    const rejoined = chunks.join('\n');
    assert.equal(rejoined.split(codeLine).length - 1, 40);
});

test('splitter: a single overlong line is hard-split, every character kept', () => {
    const line = 'y'.repeat(4500);
    const chunks = splitForDiscord(line, 2000);
    assert.ok(chunks.length >= 3 && chunks.every((c) => c.length <= 2000));
    assert.equal(chunks.join(''), line);
});

// ── store ───────────────────────────────────────────────────────────────

test('store: thread ids map to sessions and survive a new instance (a restart)', () => {
    const file = join(tempDir('discord-store-'), 'sessions.json');
    const store = new SessionStore(file);
    assert.equal(store.loaded, 'empty');
    store.put('t1', { sessionId: 's1', title: 'First', turnCount: 2 });
    store.put('t2', { sessionId: 's2', title: 'First', modelOverride: 'b:m2', effortOverride: null });
    store.markSeen('900000000000000001', { channelId: 't1', threadId: 't1' });
    store.markSeen('900000000000000005', { channelId: 'parent' });
    const again = new SessionStore(file);
    assert.equal(again.loaded, 'ok');
    assert.equal(again.get('t1').sessionId, 's1');
    assert.equal(again.get('t1').lastMessageId, '900000000000000001');
    assert.equal(again.get('t2').effortOverride, null, 'null (cleared) survives');
    assert.equal(again.threadOfSession('s2'), 't2');
    assert.equal(again.channels.parent.lastMessageId, '900000000000000005');
    assert.ok(again.hasSeen('900000000000000001'));
    assert.deepEqual(again.titlesExcluding('t1'), ['First']);
    again.delete('t2');
    assert.equal(new SessionStore(file).get('t2'), null);
    assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('store: an older file (threads only) loads; a damaged file is set aside, never overwritten blind', () => {
    const dir = tempDir('discord-store-');
    const file = join(dir, 'sessions.json');
    writeFileSync(file, JSON.stringify({ version: 1, threads: { t: { sessionId: 's', title: 'T' } } }));
    const old = new SessionStore(file);
    assert.equal(old.get('t').sessionId, 's');
    assert.deepEqual(old.channels, {});
    writeFileSync(file, '{ not json');
    const errors = [];
    const damaged = new SessionStore(file, { onError: (what) => errors.push(what) });
    assert.equal(damaged.loaded, 'damaged');
    assert.deepEqual(errors, ['parse']);
    assert.ok(readdirSync(dir).some((n) => n.startsWith('sessions.json.damaged-')));
    assert.equal(damaged.get('t'), null);
});

test('store: a write the disk refuses is reported, not swallowed', () => {
    const errors = [];
    const store = new SessionStore('/dev/null/cannot/sessions.json', { onError: (what) => errors.push(what) });
    assert.equal(store.put('t', { sessionId: 's' }), false);
    assert.deepEqual(errors, ['read', 'write'], 'an unreadable place (not just a missing file) is reported too');
});

test('store: remembers at most 1000 handled ids; snowflakes compare as numbers', () => {
    const store = new SessionStore(join(tempDir('discord-store-'), 's.json'));
    for (let i = 0; i < 1005; i++) store.seen.push(String(i)), store.seenSet.add(String(i));
    store.markSeen('2000', { channelId: 'c' });
    assert.equal(store.seen.length, 1000);
    assert.equal(store.hasSeen('0'), false);
    assert.equal(newerId('1000000000000000010', '999999999999999999'), true);
    assert.equal(newerId('5', null), true);
    assert.equal(newerId(null, '5'), false);
});

// ── trace ───────────────────────────────────────────────────────────────

test('trace: owner-only, one JSON line per event, the previous run kept as .1, off with ""', () => {
    const dir = tempDir('discord-trace-');
    const file = join(dir, 'trace.log');
    assert.equal(initTrace(file), file);
    write('router', 'turn_start', { threadId: 't' });
    const first = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(first.map((l) => l.status), ['enabled', 'turn_start']);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    initTrace(file);
    assert.ok(existsSync(`${file}.1`));
    assert.match(readFileSync(`${file}.1`, 'utf8'), /turn_start/);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /turn_start/);
    assert.equal(initTrace(''), null);
    write('x', 'y', {});
    stopTrace();
    assert.equal(initTrace('/dev/null/no/trace.log'), null, 'an unwritable trace switches itself off');
});

test('trace: the plugin\'s logger sends each line to DSH\'s logger and to the trace, formatted; a logger that throws breaks nothing', () => {
    const dsh = [];
    const copied = [];
    const logger = teeLogger({ info: (...a) => dsh.push(['info', ...a]), warn: (...a) => dsh.push(['warn', ...a]) }, (event, status, data) => copied.push({ event, status, ...data }));
    logger.info('discord: answered %d message(s) sent while DSH was not running', 2);
    logger.warn('discord: %s; trying again in %d s', 'fetch failed', 5);
    assert.deepEqual(dsh, [['info', 'discord: answered %d message(s) sent while DSH was not running', 2], ['warn', 'discord: %s; trying again in %d s', 'fetch failed', 5]]);
    assert.deepEqual(copied, [
        { event: 'log', status: 'info', text: 'discord: answered 2 message(s) sent while DSH was not running' },
        { event: 'log', status: 'warn', text: 'discord: fetch failed; trying again in 5 s' },
    ]);
    const broken = teeLogger({ warn: () => { throw new Error('logger down'); } }, (event, status, data) => copied.push({ event, status, ...data }));
    assert.doesNotThrow(() => broken.warn('discord: still %s', 'traced'));
    assert.doesNotThrow(() => teeLogger(undefined, () => {}).info('no logger at all'));
    assert.equal(copied.at(-1).text, 'discord: still traced');
});

// ── routes, attachments, words ─────────────────────────────────────────

test('model specs: provider:model, provider/model, or a bare id on the default provider', () => {
    const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'local', model: 'glm' }) } };
    assert.deepEqual(parseTitleModel('pi/pi-ai/glm-5', ctx), ['pi', 'pi-ai/glm-5']);
    assert.deepEqual(parseTitleModel('glm-5:fast', ctx), ['glm-5', 'fast']);
    assert.deepEqual(parseTitleModel('glm-5', ctx), ['local', 'glm-5']);
});

test('route override: model and effort replace, clear or keep; the input is untouched', () => {
    const resolved = { provider: 'a', model: 'm1', reasoningEffort: 'low', maxTokens: 999 };
    const out = applyRouteOverride(resolved, 'b:m2');
    assert.deepEqual([out.provider, out.model, out.reasoningEffort, out.maxTokens], ['b', 'm2', 'low', 999]);
    assert.deepEqual([resolved.provider, resolved.model], ['a', 'm1']);
    assert.equal(applyRouteOverride(resolved, 'm9').provider, 'a');
    assert.equal(applyRouteOverride(resolved, undefined, 'high').reasoningEffort, 'high');
    assert.equal('reasoningEffort' in applyRouteOverride(resolved, undefined, null), false);
    assert.equal(applyRouteOverride(resolved, undefined, undefined).reasoningEffort, 'low');
});

test('attachments: absolute files only, at most 10 MiB, refused in words', () => {
    const dir = tempDir('discord-attach-');
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'hello');
    assert.equal(readAttachment(path).filename, 'a.txt');
    assert.throws(() => readAttachment('a.txt'), /must be absolute/);
    assert.throws(() => readAttachment(dir), /is not a file/);
    assert.throws(() => readAttachment(path, 2), /a\.txt is 5 bytes; Discord takes at most 2/);
});

test('errors in words: no stacks, no private paths, at most 200 characters', () => {
    assert.equal(inWords(new Error('ENOENT: no such file /Users/someone/private/thing.json')), 'ENOENT: no such file (path)');
    assert.equal(inWords('plain'), 'plain');
    assert.ok(inWords(new Error('x'.repeat(500))).length <= 200);
    assert.equal(inWords({ failure: { message: 'provider down' } }), 'provider down');
    // A model server's JSON error body is read for its message; JSON that is not an error body stays as it is.
    assert.equal(inWords(new Error('400 {"error":{"message":"The model refused this request.","type":"invalid_request_error"}}')), '400: The model refused this request.');
    assert.equal(inWords('{"message":"rate limited"}'), 'rate limited');
    assert.equal(inWords(new Error('503 {"detail":"overloaded"}')), '503: overloaded');
    assert.equal(inWords(new Error('bad value {"a":1}')), 'bad value {"a":1}');
    assert.equal(inWords(new Error('cut short {"error":')), 'cut short {"error":');
});

test('README: the invite link asks for exactly the permissions the bot uses, and the table names each one', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    // What the code does needs these (Discord's permission bits): no more, no less.
    const needed = {
        'View Channels': 10, 'Read Message History': 16, 'Send Messages': 11, 'Send Messages in Threads': 38,
        'Create Public Threads': 35, 'Manage Threads': 34, 'Embed Links': 14, 'Attach Files': 15, 'Add Reactions': 6,
    };
    const asked = BigInt(/&permissions=(\d+)/.exec(readme)[1]);
    assert.equal(asked, Object.values(needed).reduce((sum, bit) => sum | (1n << BigInt(bit)), 0n));
    const table = readme.slice(readme.indexOf('The number asks for exactly these permissions'));
    const named = [...table.slice(0, table.indexOf('\n\n', table.indexOf('|'))).matchAll(/^ *\| ([A-Z][^|]*?) \|/gm)].map((m) => m[1]).filter((n) => n !== 'Permission');
    assert.deepEqual(named.sort(), Object.keys(needed).sort());
});
