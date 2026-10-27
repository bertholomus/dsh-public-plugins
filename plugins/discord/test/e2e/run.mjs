#!/usr/bin/env node
/**
 * The Discord plugin on a real DSH, end to end, against a fake Discord.
 *
 * DSH (DSH_BIN, else the newest test runtime) runs in a throwaway home with
 * this repository linked into its web profile and a scripted model. The
 * plugin is pointed at a fake Discord on 127.0.0.1 (REST and gateway, from
 * test/support/fake-discord.mjs) with a made-up token, so nothing reaches
 * the real Discord and no live token is read: DSH gets no DISCORD_*
 * variable, and the plugin's token comes from a variable of its own. Then,
 * as a person on Discord would see it:
 *
 * - Start: the plugin logs in to the gateway with that token and registers
 *   its seven slash commands.
 * - A message in the bot's channel gets a thread made from it, a DSH session
 *   (listed in DSH's window as "Discord — ..."), typing while the agent
 *   works, and the agent's discord_send reply in the thread; after the first
 *   reply the thread and the session take a title from the title model.
 *   The session's own log holds the relayed message and the delivered send.
 * - A second message in the thread goes to the same session, once.
 * - Gates: a stranger, a channel that is not the bot's, a bot: nothing.
 * - Never silent: a turn without discord_send is reminded once and its reply
 *   then arrives; one that ignores the reminder has its last words posted;
 *   a failed turn says so in the thread.
 * - Sends stay in the bot's channels: a send elsewhere is refused.
 * - The tools act only where they may: a reaction to a message id that is not
 *   a Discord id reaches no endpoint, and a file outside the workspace (by its
 *   path, through a link or through a hard link) is not uploaded; the agent is
 *   told why in words.
 * - An ordinary DSH session (made through DSH's own API) is offered no
 *   Discord tool and posts nothing to Discord.
 * - An approval the agent waits on in DSH (a command asking for wider
 *   access) is said in the thread; refused in DSH's window, the turn still
 *   ends with an answer.
 * - A long reply arrives in parts of at most 2000 characters; a file from
 *   the workspace is uploaded; a file the person attaches is listed for the
 *   agent.
 * - Slash commands: /status (the session's name, its folder, a Discord
 *   timestamp), /model (the next request goes to that model), /rename (the
 *   thread and the session), /stop (a running turn), /new (a fresh session,
 *   listed in DSH as "(session 2)"), and a stranger's command refused.
 * - The gateway drops: the plugin resumes, and the message sent meanwhile
 *   is handled once.
 * - DSH restarts: the thread keeps its session, a message sent while DSH was
 *   down is answered after the restart, and nothing is handled twice.
 * - DSH crashes mid-turn: the store is intact, the thread is told its last
 *   message was cut off, and keeps its session.
 * - A session DSH opened first: after a restart the person types in the
 *   Discord session in DSH before writing in Discord; the bot picks that
 *   session up, /model decides its requests over DSH's own choice, and
 *   /model default gives the choice back.
 * - /new on that session: the old session, prompted through DSH's API, is
 *   offered no Discord tool and posts nothing; the next session is listed
 *   as "(session 3)".
 * - Switched off and on by editing the row while DSH runs (its profile hot
 *   reload): offline at once, the thread's session in DSH has no Discord
 *   tool, nothing is answered; on again, the message sent meanwhile is
 *   answered.
 * - Files: the store and the trace are owner-only, in the throwaway home,
 *   and the trace never holds the token.
 * - The Plugins page: the plugin's title (Discord), its sentence and its icon.
 * - Settings, each on a fresh start: no workspace set, a relative or missing
 *   workspace folder, switched off, no
 *   token, an allowlist that is not a list of ids, a token Discord refuses,
 *   a wrong number: the plugin says so in its log and does not connect (or
 *   stops after the refusal, or connects with the default, for the number).
 *
 * The plugin's log lines are read from its trace (`log` events): DSH keeps
 * plugin log lines in memory, and its own output has none of them.
 *
 * With SHOTS=<folder>, pictures of DSH's window, light and dark: the Discord
 * session's Chat tab (also 760 px wide) and its Trajectory tab, which shows
 * the relayed messages (Chat leaves out context rows); the plugin in DSH's
 * Plugins page (installed, running, also 760 px wide); and the fake
 * Discord's thread as a person would read it.
 *
 *   node test/e2e/run.mjs                    the newest test runtime
 *   DSH_BIN=<bin.js> node test/e2e/run.mjs   that build (npm run e2e runs every build)
 *
 * KEEP=1 keeps the throwaway folders. Prints "N passed, M failed" at the end.
 */
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { startFakeDiscord } from '../support/fake-discord.mjs';
import { startFakeModel } from './fake-model.mjs';
import { checks, dismissNotices, DshRun, dshBin, findPlaywright, launchChromium, modeOf, openWindow, repoRoot, setDark, shot, sleep, waitFor } from './harness.mjs';

const bin = process.env.DSH_BIN || dshBin();
if (!bin) {
    console.error('no DSH to run: install the test builds (npm run e2e:install) or set DSH_BIN');
    process.exit(2);
}
const label = process.env.DSH_LABEL || 'dsh';
const shots = process.env.SHOTS ? join(process.env.SHOTS, label) : undefined;
const TOKEN = 'e2e-fake-bot-token-not-a-real-one';
const MODELS = ['fake-model', 'fake-model-2'];
const q = JSON.stringify;

const t = checks({ redact: (text) => text.replaceAll(TOKEN, '<fake token>') });
const { check } = t;
/** A step; a throw in it is a failed check, followed by what DSH and the fake saw. */
const step = (name, run, onFail) => t.step(name, run, onFail ?? ((error) => dump(error)));
console.log(`# discord on DSH ${label} (${bin})`);

const fake = await startFakeDiscord({ token: TOKEN, heartbeatMs: 4000 });
const model = await startFakeModel({ models: MODELS });
const channel = fake.addChannel({ name: 'deepseek-harness' });
const elsewhere = fake.addChannel({ name: 'random' });
const albert = fake.addUser({ username: 'albert', global_name: 'Albert' });
const stranger = fake.addUser({ username: 'stranger', global_name: 'Someone Else' });
const otherBot = fake.addUser({ username: 'otherbot', global_name: 'Other Bot', bot: true });

/** The plugin's row: the fake Discord, its own token variable, the store and trace inside the throwaway home. */
function discordRow(run, extra = '') {
    return `- id: discord
  config:
    workspacePath: ${q(run.ws)}
    tokenRef: E2E_FAKE_DISCORD_TOKEN
    apiBase: ${q(fake.apiBase)}
    allowedChannelIds: [${q(channel.id)}]
    allowedUserIds: [${q(albert.id)}]
    storeFile: ${q(join(run.home, 'discord-plugin-sessions.json'))}
    traceFile: ${q(join(run.home, 'discord-plugin-trace.log'))}
${extra}`;
}

const run = new DshRun({ label: `discord-${label}`, bin, plugins: { 'dsh-plugin-discord': repoRoot }, env: { E2E_FAKE_DISCORD_TOKEN: TOKEN } });
run.rows = discordRow(run);
run.writeProfile(model.port, { models: MODELS });
const storeFile = join(run.home, 'discord-plugin-sessions.json');
const traceFile = join(run.home, 'discord-plugin-trace.log');
const readStore = () => JSON.parse(readFileSync(storeFile, 'utf8'));
const sessionOf = (threadId) => readStore().threads?.[threadId]?.sessionId;
const botTexts = (channelId) => fake.botMessages(channelId).map((m) => m.content ?? '');
const replyIn = (channelId, pattern, what, timeout = 45000) => waitFor(() => botTexts(channelId).find((x) => pattern.test(x)), what, timeout);
const savedText = (sessionId) => JSON.stringify(run.savedEvents(sessionId));
/** The session's saved log once `test` holds, or as it is after `ms` (DSH writes events to disk in batches of up to 200 ms). */
const savedWhen = async (sessionId, test, ms = 8000) => {
    const deadline = Date.now() + ms;
    for (;;) {
        const text = savedText(sessionId);
        if (test(text) || Date.now() > deadline) return text;
        await sleep(250);
    }
};
/**
 * Waits until the scripted model has had no request for `quiet` ms (at most `ms`): a turn's last step (the model
 * reading its tool results) can come a moment after its reply reached Discord, so a step that counts requests
 * starts from a quiet model, not from the middle of the turn before.
 */
const modelQuiet = async (quiet = 1500, ms = 20000) => {
    const deadline = Date.now() + ms;
    let count = model.requests.length;
    let since = Date.now();
    while (Date.now() < deadline) {
        await sleep(100);
        if (model.requests.length !== count) {
            count = model.requests.length;
            since = Date.now();
        } else if (Date.now() - since >= quiet) return;
    }
};
const relayedCount = (sessionId, needle) => run.savedEvents(sessionId).filter((e) => /user/.test(e.type) && JSON.stringify(e).includes(needle)).length;
const listed = async (sessionId) => (await run.sessions()).find((s) => JSON.stringify(s).includes(sessionId));
/**
 * What the plugin logged since its last start, one line each: the `log` events of its trace. DSH keeps plugin log
 * lines in memory only (its own output has none of them), and the plugin writes each one to its trace too.
 */
const saidIn = (file) => {
    let text = '';
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        return '';
    }
    return text.split('\n').map((line) => {
        try {
            const e = JSON.parse(line);
            return e.event === 'log' ? `${e.status}: ${e.text}` : null;
        } catch {
            return null;
        }
    }).filter(Boolean).join('\n');
};
const say = (content, channelId = channel.id, author = albert, more = {}) => fake.userMessage({ channelId, author, content, ...more });
const slash = async (channelId, name, value, user = albert) => {
    const asked = fake.interaction({ channelId, user, name, value });
    return waitFor(() => {
        const answer = fake.answerOf(asked);
        return answer && (!answer.deferred || answer.text) ? answer : null;
    }, `the answer to /${name}`, 30000);
};

let thread; // the first message's thread id
let firstSession;

/** On a failed step: what DSH and the fake saw, to read the failure by (the token is never in it). */
async function dump(error) {
    const lines = [`# dump after: ${String(error?.message ?? error).slice(0, 300)}`];
    try {
        lines.push(`# the plugin's log (its trace): ${saidIn(traceFile).split('\n').slice(-25).join('\n#   ')}`);
        lines.push(`# DSH's own output: ${run.logText().split('\n').filter((l) => /discord|plugin|Error|error/.test(l)).slice(-10).join('\n#   ')}`);
        lines.push(`# fake Discord: ${fake.requests.length} requests, last: ${fake.requests.slice(-6).map((r) => `${r.method} ${r.path} ${r.failed ?? ''}`).join(' | ')}`);
        lines.push(`# model: ${model.requests.length} requests, last: ${q(model.requests.slice(-3).map((r) => ({ model: r.model, action: r.action, fresh: r.fresh.slice(0, 120) })))}`);
        if (thread) lines.push(`# thread ${thread}: bot said ${q(botTexts(thread).slice(-4))}`);
        const sid = thread ? sessionOf(thread) : undefined;
        if (sid) lines.push(`# session ${sid}: events ${q(run.savedEvents(sid).map((e) => e.type).slice(-30))}`);
        const listedNow = await run.api('session/list', { _request: {} }).catch((e) => ({ error: e.message }));
        lines.push(`# session/list: ${q(listedNow).slice(0, 800)}`);
    } catch (e) {
        lines.push(`# dump failed: ${e.message}`);
    }
    console.log(lines.join('\n').replaceAll(TOKEN, '<fake token>'));
}

try {
    // ── Start ────────────────────────────────────────────────────────────
    await step('start: the profile points the plugin only at this computer, and DSH starts with it', async () => {
        const patch = run.patchText();
        check('the profile sends the plugin to the fake Discord on 127.0.0.1, never to discord.com, with a token variable of its own',
            patch.includes(fake.apiBase) && !/discord\.com|discordapp/.test(patch) && !/DISCORD_BOT_TOKEN/.test(patch), patch);
        await run.boot('first start', () => fake.connected());
        // The line follows the gateway's READY, a moment after the fake sees the connection.
        const up = await waitFor(() => /^info: discord: gateway connected; listening for messages$/m.test(saidIn(traceFile)), 'the line in the plugin\'s log', 10000).catch(() => false);
        check('the plugin\'s log (its trace) says the gateway connected', up === true, saidIn(traceFile));
    });
    await step('start: logs in with the fake token, asks for the intents it needs, registers its seven slash commands', async () => {
        const login = fake.gateway.identifies[0];
        check('the plugin logs in to the fake gateway with the made-up token', login?.token === TOKEN, JSON.stringify({ ...login, token: login?.token === TOKEN ? '<fake token>' : 'other' }));
        check('it asks for guilds, guild messages, direct messages and message content', login?.intents === (0x1 | 0x200 | 0x1000 | 0x8000), String(login?.intents));
        await waitFor(() => fake.commands.length >= 7, 'the slash commands', 30000);
        check('its slash commands are registered', q(fake.commands.map((c) => c.name).sort()) === q(['effort', 'model', 'new', 'rename', 'reset', 'status', 'stop']), q(fake.commands.map((c) => c.name)));
        check('every REST call went to the fake Discord with the fake token', fake.requests.length > 0 && fake.requests.every((r) => r.auth === null || r.auth === `Bot ${TOKEN}`));
    });

    // ── A message becomes a thread, a session and a reply ───────────────
    await step('a message in the bot\'s channel: a thread, a DSH session, typing, and the agent\'s reply in the thread', async () => {
        const typingBefore = fake.calls('POST', /\/typing$/).length;
        const msg = say('Deploy checklist for Friday. E2E:reply The checklist looks good: tests pass and the notes are written.');
        thread = msg.id;
        const reply = await replyIn(thread, /The checklist looks good/, 'the reply in the thread');
        const made = fake.channels.get(thread);
        check('a public thread is made from the message', made?.type === 11 && made.parent_id === channel.id, q(made));
        check('the agent\'s reply reaches the thread', /^The checklist looks good: tests pass and the notes are written\.$/.test(reply), reply);
        const sent = fake.botMessages(thread).find((m) => /checklist looks good/.test(m.content));
        check('the reply pings no one but users (allowed_mentions)', q(sent?.allowed_mentions) === q({ parse: ['users'], replied_user: false }), q(sent?.allowed_mentions));
        check('the person saw typing while the agent worked', fake.calls('POST', /\/typing$/).length > typingBefore);
        firstSession = sessionOf(thread);
        check('the thread has a DSH session, kept in the store', /^discord-t\d+-/.test(firstSession ?? ''), firstSession);
        const entry = await waitFor(() => listed(firstSession), 'the session in DSH\'s session list', 20000);
        check('DSH\'s window lists the session, titled "Discord — ..."', /Discord — /.test(q(entry)), q(entry).slice(0, 400));
        const saved = await savedWhen(firstSession, (x) => x.includes('Discord message from @albert') && /delivered to Discord \(message \d+\)/.test(x));
        check('the session\'s own log holds the relayed message: who, where, and how to reply', saved.includes('Discord message from @albert') && saved.includes(`Reply in Discord with the discord_send tool using channel_id \\"${thread}\\"`), saved.slice(0, 600));
        check('the session\'s log holds the delivered discord_send', /discord_send/.test(saved) && /delivered to Discord \(message \d+\)/.test(saved));
        const offered = model.requests.find((r) => !r.action.title)?.tools ?? [];
        const six = ['discord_send', 'discord_send_file', 'discord_typing', 'discord_create_thread', 'discord_react', 'discord_user'];
        check('the agent is offered the six Discord tools', six.every((name) => offered.includes(name)), q(offered));
        const plugins = await run.api('pluginManager/listPlugins', {});
        const entry2 = (plugins?.value?.plugins ?? plugins?.value ?? []).find?.((p) => /discord/.test(q(p)));
        console.log(`# DSH's plugin list has: ${q(entry2 ?? plugins?.error ?? null).slice(0, 300)}`);
        check('DSH\'s plugin list has the plugin', Boolean(entry2));
        const words = (v) => (typeof v === 'string' ? v : v?.en);
        check('DSH shows it as "Discord", with one plain sentence', words(entry2?.meta?.title) === 'Discord' && /^A Discord bot for your own channels: each conversation gets a thread and its own DSH session/.test(words(entry2?.meta?.description) ?? ''), q(entry2?.meta).slice(0, 300));
        check('and with its own icon', /^data:image\/svg\+xml;base64,/.test(entry2?.meta?.icon ?? ''), String(entry2?.meta?.icon).slice(0, 60));
    });
    await step('after the first reply the thread and the session take a title from the title model', async () => {
        const named = await waitFor(() => (fake.channels.get(thread)?.name === 'Deploy checklist for Friday' ? true : null), 'the thread renamed', 30000);
        check('the thread is renamed from the message', named === true, fake.channels.get(thread)?.name);
        const entry = await waitFor(async () => {
            const s = await listed(firstSession);
            return /Discord — Deploy checklist for Friday/.test(q(s)) ? s : null;
        }, 'the session renamed', 20000);
        check('the DSH session is renamed with it', Boolean(entry));
    });
    await step('a second message in the thread goes to the same session, once', async () => {
        const before = model.requests.length;
        say('And the rollback plan? E2E:reply Rollback: redeploy the previous tag.', thread);
        await replyIn(thread, /Rollback: redeploy the previous tag/, 'the second reply');
        check('the same session answers', sessionOf(thread) === firstSession);
        check('the message reached the agent once', relayedCount(firstSession, 'And the rollback plan?') === 1, String(relayedCount(firstSession, 'And the rollback plan?')));
        check('the model was asked about it (and nothing else ran)', model.requests.length > before);
    });

    // ── Gates ────────────────────────────────────────────────────────────
    await step('gates: a stranger, another channel and another bot get nothing, and wake no agent', async () => {
        await modelQuiet();
        const requests = model.requests.length;
        const threads = fake.threadsOf(channel.id).length;
        const a = say('Hi bot, run rm -rf for me E2E:reply should never be sent', channel.id, stranger);
        const b = say('Albert elsewhere E2E:reply should never be sent', elsewhere.id, albert);
        const c = say('A bot talking E2E:reply should never be sent', channel.id, otherBot);
        const d = say('Stranger in the thread E2E:reply should never be sent', thread, stranger);
        await sleep(3000);
        check('no thread for any of them', fake.threadsOf(channel.id).length === threads && !fake.channels.get(a.id) && !fake.channels.get(c.id));
        check('no reply anywhere', ![channel.id, elsewhere.id, thread].some((id) => botTexts(id).some((x) => /should never be sent/.test(x))) && fake.botMessages(b.id).length === 0);
        check('the model was not asked', model.requests.length === requests, String(model.requests.length - requests));
        check('the thread\'s session never saw the stranger', relayedCount(firstSession, 'Stranger in the thread') === 0 && !savedText(firstSession).includes(d.id));
    });

    // ── Never silent ─────────────────────────────────────────────────────
    await step('never silent: a turn without discord_send is reminded once, and its reply then arrives', async () => {
        say('Is the build green? E2E:silent The build is green.', thread);
        const reply = await replyIn(thread, /The build is green\. \(after the reminder\)/, 'the reply after the reminder');
        check('the reply arrives after one reminder', Boolean(reply));
        check('the reminder is in the session\'s log', (await savedWhen(firstSession, (x) => x.includes('Your reply has not reached Discord yet'))).includes('Your reply has not reached Discord yet'));
    });
    await step('never silent: a turn that ignores the reminder has its last words posted', async () => {
        say('Anything else? E2E:silent Only plain text. #nudge=ignore', thread);
        const reply = await replyIn(thread, /Still only plain text, never sent\./, 'the last words in the thread');
        check('the turn\'s last words reach the thread', Boolean(reply));
    });
    await step('never silent: a failed turn says so in the thread', async () => {
        say('Try this E2E:fail', thread);
        const reply = await replyIn(thread, /^The agent's turn failed: /, 'the failure line');
        console.log(`# the failure line: ${reply}`);
        check('the thread says the turn failed, and how to retry', /Send your message again to retry; \/status shows the session\.$/.test(reply), reply);
        check('the failure line carries no stack or private path', !/\n\s+at |\/Users\//.test(reply), reply);
        check('the failure line gives the model\'s reason in words, without a bare status code', /scripted model refused this request/.test(reply) && !/failed: \d{3}\b|\b\d{3}:/.test(reply), reply);
    });

    // ── Sends stay in the bot's channels ─────────────────────────────────
    await step('sends stay in the bot\'s channels: a send to another channel is refused, the person still gets an answer', async () => {
        say(`Post this in random E2E:to ${elsewhere.id} leaked text`, thread);
        await replyIn(thread, /^the answer \(after the reminder\)$/, 'the answer in the thread after the refused send');
        check('nothing reached the other channel', !botTexts(elsewhere.id).some((x) => /leaked text/.test(x)));
        check('the trace records the refusal', /"refused"/.test(readFileSync(traceFile, 'utf8')));
    });

    // ── What the tools may touch, and who gets them ──────────────────────
    await step('the tools act only where they may: a message id that is not an id, and files outside the workspace, are refused in words', async () => {
        const answers = () => botTexts(thread).filter((x) => x === 'the answer (after the reminder)').length;
        const uploads = () => fake.calls('POST', `/channels/${thread}/messages`).filter((c) => c.body?.files).length;
        await modelQuiet();
        const before = fake.requests.length;
        let n = answers();
        say(`React to the first message E2E:react ${thread}/threads`, thread);
        await waitFor(() => answers() > n, 'the answer after the refused reaction', 45000);
        const asked = fake.requests.slice(before).map((r) => `${r.method} ${r.path}`);
        check('a message id that is not a Discord id reached no Discord endpoint', !asked.some((x) => /^PUT |\/threads$/.test(x)), q(asked));
        check('the agent was told why, in words', (await savedWhen(sessionOf(thread), (x) => x.includes('is not a Discord message id'))).includes('is not a Discord message id'));
        // A file outside the workspace folder: by its own path, and through a link inside the folder.
        const outside = join(run.root, 'outside-the-workspace.txt');
        writeFileSync(outside, 'not for Discord\n');
        const link = join(run.ws, 'link-to-outside.txt');
        symlinkSync(outside, link);
        const hard = join(run.ws, 'hard-link-to-outside.txt');
        linkSync(outside, hard);
        for (const [path, how] of [[outside, 'by its own path'], [link, 'through a link inside the workspace'], [hard, 'through a hard link inside the workspace']]) {
            n = answers();
            const sent = uploads();
            say(`Send it E2E:file ${path}`, thread);
            await waitFor(() => answers() > n, `the answer after the refused upload ${how}`, 45000);
            check(`a file outside the workspace is not uploaded (${how})`, uploads() === sent);
        }
        check('the agent was told the file is outside the workspace folder', (await savedWhen(sessionOf(thread), (x) => x.includes('is outside the workspace folder'))).includes('is outside the workspace folder'));
        check('and that a hard-linked file has other names', (await savedWhen(sessionOf(thread), (x) => x.includes('has other names (hard links)'))).includes('has other names (hard links)'));
    });
    await step('an ordinary DSH session is offered no Discord tool and posts nothing to Discord', async () => {
        await modelQuiet();
        const created = await run.api('session/create', { request: { cwd: run.ws } });
        const sessionId = created?.value?.sessionId;
        check('DSH makes an ordinary session through its own API', Boolean(sessionId), q(created).slice(0, 300));
        const before = model.requests.length;
        const prompted = await run.api('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: `E2E:to ${channel.id} posted by an ordinary DSH session` }] } });
        check('DSH takes the prompt', prompted?.ok === true, q(prompted).slice(0, 300));
        const first = await waitFor(() => model.requests.slice(before).find((r) => !r.action.title && /posted by an ordinary DSH session/.test(r.fresh)), 'the ordinary session\'s model request', 60000);
        check('its model request offers tools, and none of them is a Discord tool', first.tools.length > 0 && !first.tools.some((name) => /^discord_/.test(name)), q(first.tools));
        await modelQuiet();
        check('nothing from it reached Discord', ![channel.id, elsewhere.id, thread].some((id) => botTexts(id).some((x) => /posted by an ordinary DSH session/.test(x))));
    });

    // ── An approval the agent waits on ───────────────────────────────────
    await step('an approval the agent waits on in DSH is said in the thread; refused there, the turn still ends with an answer', async () => {
        const prompts = await run.prompts();
        try {
            const from = fake.botMessages(thread).length;
            const later = (pattern) => fake.botMessages(thread).slice(from).map((m) => m.content).find((x) => pattern.test(x));
            say('Clean the cache E2E:escalate true', thread);
            const told = await waitFor(() => later(/^The agent is waiting for your approval in DSH/), 'the approval line in the thread', 45000);
            check('the thread says the agent waits for an approval in DSH, what it wants to do in words (no tool name), and where', /^The agent is waiting for your approval in DSH to run a command \(.+\)\. Allow or refuse it in DSH, in the session “Discord — Deploy checklist for Friday”; it cannot be answered from Discord\.$/.test(told), told);
            const prompt = await waitFor(() => prompts.asked.find((a) => /approval/.test(a.event)), 'the approval in DSH\'s window', 20000);
            await prompts.answer(prompt, 'rejected');
            const after = await waitFor(() => later(/^the answer \(after the reminder\)$/), 'the answer after the refusal', 45000);
            check('refused in DSH, the turn still ends with an answer in the thread', Boolean(after));
        } finally {
            prompts.close();
        }
    });

    // ── Long replies, files ──────────────────────────────────────────────
    await step('a long reply arrives in parts of at most 2000 characters, nothing lost', async () => {
        const before = fake.botMessages(thread).length;
        say('Give me the long report E2E:long 4500', thread);
        await waitFor(() => fake.botMessages(thread).slice(before).some((m) => /Line \d+/.test(m.content)) && fake.botMessages(thread).slice(before).filter((m) => /Line \d+/.test(m.content)).length >= 3, 'three parts', 45000);
        const parts = fake.botMessages(thread).slice(before).filter((m) => /Line \d+/.test(m.content)).map((m) => m.content);
        check('three parts, each at most 2000 characters', parts.length === 3 && parts.every((p) => p.length <= 2000), parts.map((p) => p.length).join(','));
        check('every character arrives', parts.join('\n').replace(/\n/g, '').length >= 4500 - 80, String(parts.join('').length));
    });
    await step('a file from the workspace is uploaded to the thread', async () => {
        const file = join(run.ws, 'report.txt');
        writeFileSync(file, 'release report\n');
        say(`Send me the report E2E:file ${file}`, thread);
        const sent = await waitFor(() => fake.botMessages(thread).find((m) => (m.attachments ?? []).some((a) => a.filename === 'report.txt')), 'the uploaded file', 45000);
        check('the file arrives as an attachment with its caption', sent?.content === 'Here is the file.' && sent.attachments[0].size === 15, q(sent));
    });
    await step('a file the person attaches is listed for the agent', async () => {
        say('Here is the log E2E:reply Got the log.', thread, albert, { attachments: [{ id: fake.snowflake(), filename: 'build.log', size: 2048, content_type: 'text/plain', url: `http://127.0.0.1:${fake.port}/files/build.log` }] });
        await replyIn(thread, /Got the log\./, 'the reply to the attachment');
        const listing = `- build.log (text/plain, 2048 bytes): http://127.0.0.1:${fake.port}/files/build.log`;
        check('the relayed message lists the file, its type, size and address', (await savedWhen(firstSession, (x) => x.includes(listing))).includes(listing));
    });

    // ── Slash commands ───────────────────────────────────────────────────
    await step('/status answers privately with the thread\'s session, its folder, the model and the connection', async () => {
        const answer = await slash(thread, 'status');
        check('only the person sees it', answer.ephemeral === true);
        check('it names the session as DSH lists it, the model and the connection', /\*\*This thread:\*\* (idle, waiting for a message|working on a turn)/.test(answer.text) && /\*\*DSH session:\*\* “Discord — Deploy checklist for Friday”/.test(answer.text) && /\*\*Model:\*\* the DSH default/.test(answer.text), answer.text);
        check('the folder by its name, never its path', answer.text.includes(`working in the folder “${basename(run.ws)}”`) && !answer.text.includes(run.root), answer.text);
        check('the connection time as a Discord timestamp (each reader sees their own time zone)', /\*\*Bot:\*\* connected since <t:\d{10}:f>\./.test(answer.text), answer.text);
    });
    await step('/model switches this thread\'s model from the next turn', async () => {
        const answer = await slash(thread, 'model', 'fake:fake-model-2');
        check('the answer names the model', /set to \*\*fake:fake-model-2\*\*, from the next turn/.test(answer.text), answer.text);
        await modelQuiet();
        const before = model.requests.length;
        say('Which model now? E2E:reply Using the other model.', thread);
        await replyIn(thread, /Using the other model\./, 'the reply on the other model');
        const asked = model.requests.slice(before).filter((r) => !r.action.title);
        check('the next turn\'s requests go to that model', asked.length > 0 && asked.every((r) => r.model === 'fake-model-2'), q(asked.map((r) => r.model)));
    });
    await step('/rename renames the thread and the DSH session', async () => {
        const answer = await slash(thread, 'rename', 'Release notes');
        check('the answer says so', answer.text === 'Renamed to “Release notes”.', answer.text);
        check('the thread has the new name', fake.channels.get(thread)?.name === 'Release notes');
        const entry = await waitFor(async () => {
            const s = await listed(firstSession);
            return /Discord — Release notes/.test(q(s)) ? s : null;
        }, 'the session renamed', 20000);
        check('the DSH session has it too', Boolean(entry));
    });
    await step('/stop stops a running turn', async () => {
        say('Take your time E2E:slow', thread);
        await waitFor(() => model.held.size > 0, 'the turn to start', 30000);
        const answer = await slash(thread, 'stop');
        check('the answer says it stopped', /^Stopped the running turn\./.test(answer.text), answer.text);
        await waitFor(() => model.held.size === 0, 'the model request to be let go', 20000);
        check('the model request is let go', model.held.size === 0);
        await sleep(1500);
        const idle = await slash(thread, 'stop');
        check('a second /stop: nothing is running', idle.text === 'Nothing is running in this thread.' && idle.ephemeral, idle.text);
    });
    await step('a stranger\'s slash command is refused, and changes nothing', async () => {
        const answer = await slash(thread, 'new', undefined, stranger);
        check('refused, privately', answer.text === 'This bot answers only the people it is set up for.' && answer.ephemeral, answer.text);
        check('the thread keeps its session', sessionOf(thread) === firstSession);
    });
    await step('/new: the next message in the thread starts a fresh session; the old one stays in DSH', async () => {
        const answer = await slash(thread, 'new');
        check('the answer says so, and the name the next session gets in DSH', answer.text === 'Session cleared. Your next message here starts a fresh session, listed in DSH as “Discord — Release notes (session 2)”; the old one stays in DSH under its own name.', answer.text);
        say('Start over please E2E:reply Fresh start.', thread);
        await replyIn(thread, /Fresh start\./, 'the reply from the fresh session');
        const fresh = sessionOf(thread);
        check('a different session answers', Boolean(fresh) && fresh !== firstSession, `${firstSession} -> ${fresh}`);
        check('the old session is still listed in DSH, under its own name', /Discord — Release notes"/.test(q(await listed(firstSession))), q(await listed(firstSession)).slice(0, 300));
        check('the fresh one is listed as "(session 2)"', /Discord — Release notes \(session 2\)/.test(q(await listed(fresh))), q(await listed(fresh)).slice(0, 300));
        firstSession = fresh;
        check('the fresh session is back on the default model', model.requests.at(-1)?.model === 'fake-model', model.requests.at(-1)?.model);
    });

    // ── The gateway drops ────────────────────────────────────────────────
    await step('the gateway drops: the plugin resumes, and the message sent meanwhile is handled once', async () => {
        const resumes = fake.gateway.resumes.length;
        fake.dropSocket();
        say('Sent during the drop E2E:reply Caught up after the drop.', thread);
        await waitFor(() => fake.gateway.resumes.length > resumes && fake.connected(), 'the resume', 60000);
        check('the plugin resumes the gateway session (no new login)', fake.gateway.identifies.length === 1, String(fake.gateway.identifies.length));
        await replyIn(thread, /Caught up after the drop\./, 'the reply to the message sent during the drop', 60000);
        await sleep(1500);
        check('the message reached the agent once', relayedCount(firstSession, 'Sent during the drop') === 1, String(relayedCount(firstSession, 'Sent during the drop')));
    });

    // ── DSH restarts ─────────────────────────────────────────────────────
    await step('DSH restarts: a message sent while it was down is answered, in the same session, and nothing runs twice', async () => {
        await run.stop();
        check('DSH stopped', !run.alive());
        const offline = say('Sent while DSH was down E2E:reply Answered after the restart.', thread, albert, { offline: true });
        const logins = fake.gateway.identifies.length;
        await run.boot('restart', () => fake.connected() && fake.gateway.identifies.length > logins);
        const reply = await replyIn(thread, /Answered after the restart\./, 'the catch-up reply', 60000);
        check('the message sent while DSH was down is answered after the restart', Boolean(reply));
        check('the same session answers (resumed, not new)', sessionOf(thread) === firstSession);
        check('the agent is told it was sent while DSH was not running', (await savedWhen(firstSession, (x) => x.includes('(sent while DSH was not running; answer it now)'))).includes('(sent while DSH was not running; answer it now)'));
        check('the plugin\'s log says it caught up (this start\'s trace)', /^info: discord: answered 1 message\(s\) sent while DSH was not running$/m.test(saidIn(traceFile)), saidIn(traceFile));
        await sleep(2000);
        check('nothing earlier was handed over again', relayedCount(firstSession, 'Sent during the drop') === 1 && relayedCount(firstSession, 'Start over please') === 1 && relayedCount(firstSession, offline.content.slice(0, 24)) === 1);
        check('the first thread was not opened again: one thread from the channel', fake.threadsOf(channel.id).length === 1);
    });

    // ── DSH crashes mid-turn ─────────────────────────────────────────────
    await step('DSH crashes mid-turn: the store is intact and the thread keeps its session', async () => {
        say('A long job E2E:slow', thread);
        await waitFor(() => model.held.size > 0, 'the turn to start', 30000);
        await run.crash();
        model.release();
        let store;
        try {
            store = readStore();
        } catch {}
        check('the store reads back after the crash', store?.version === 1 && store.threads?.[thread]?.sessionId === firstSession);
        const logins = fake.gateway.identifies.length;
        await run.boot('after the crash', () => fake.connected() && fake.gateway.identifies.length > logins);
        const told = await replyIn(thread, /^DSH stopped before the agent finished your last message/, 'the line about the cut turn', 60000);
        check('the thread is told the cut turn will not be answered, and what to do', told === 'DSH stopped before the agent finished your last message (“A long job E2E:slow”). Send it again if you still need the answer.', told);
        say('Back again? E2E:reply Back after the crash.', thread);
        await replyIn(thread, /Back after the crash\./, 'the reply after the crash', 60000);
        check('the thread keeps its session after the crash', sessionOf(thread) === firstSession);
        check('no store was set aside as damaged', !/the thread store was damaged/.test(saidIn(traceFile)) && !/damaged/.test(saidIn(`${traceFile}.1`)));
    });

    // ── A session DSH opened first ───────────────────────────────────────
    const promptInDsh = (sessionId, text) => run.api('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } });
    const requestFor = (needle) => waitFor(() => model.requests.find((r) => !r.action.title && r.fresh.includes(needle)), `the model request for "${needle}"`, 60000);
    const discordToolsOf = (r) => r.tools.filter((name) => /^discord_/.test(name));
    await step('a Discord session DSH opened first (after a restart) is picked up: /model decides its requests over DSH\'s own choice, /model default gives it back', async () => {
        await modelQuiet();
        await run.stop();
        const logins = fake.gateway.identifies.length;
        await run.boot('restart, then the window first', () => fake.connected() && fake.gateway.identifies.length > logins);
        await sleep(1500);
        // The person types in the Discord session in DSH's window before writing in Discord: DSH opens the session
        // itself, with its own model choice on it.
        const typed = await promptInDsh(firstSession, 'Typed in the DSH window first');
        check('DSH opens the Discord session itself and takes the prompt', typed?.ok === true, q(typed).slice(0, 300));
        const windowTurn = await requestFor('Typed in the DSH window first');
        check('opened by DSH, the session has no Discord tool yet', discordToolsOf(windowTurn).length === 0, q(windowTurn.tools));
        await modelQuiet();
        say('Back in Discord E2E:reply Picked up in the open session.', thread);
        await replyIn(thread, /Picked up in the open session\./, 'the reply from the session DSH has open');
        check('the bot picks up the session DSH has open, not a new one', /"session_adopted"/.test(readFileSync(traceFile, 'utf8')) && sessionOf(thread) === firstSession);
        const set = await slash(thread, 'model', 'fake:fake-model-2');
        check('/model answers with the model', /set to \*\*fake:fake-model-2\*\*, from the next turn/.test(set.text), set.text);
        await modelQuiet();
        let before = model.requests.length;
        say('Which model now? E2E:reply On the other model in the open session.', thread);
        await replyIn(thread, /On the other model in the open session\./, 'the reply on the other model');
        let asked = model.requests.slice(before).filter((r) => !r.action.title);
        check('its next turn goes to that model, over the model DSH chose for the session', asked.length > 0 && asked.every((r) => r.model === 'fake-model-2'), q(asked.map((r) => r.model)));
        const back = await slash(thread, 'model', 'default');
        check('/model default says so', back.text === 'Model for this thread back to the DSH default, from the next turn.', back.text);
        await modelQuiet();
        before = model.requests.length;
        say('And now? E2E:reply Back on the default model.', thread);
        await replyIn(thread, /Back on the default model\./, 'the reply on the default model');
        asked = model.requests.slice(before).filter((r) => !r.action.title);
        check('and the next turn is on DSH\'s choice again', asked.length > 0 && asked.every((r) => r.model === 'fake-model'), q(asked.map((r) => r.model)));
    });
    await step('/new on the session DSH opened: the old session keeps no Discord tool and posts nothing; the next one is "(session 3)"', async () => {
        const old = firstSession;
        const answer = await slash(thread, 'new');
        check('/new names the next session', answer.text === 'Session cleared. Your next message here starts a fresh session, listed in DSH as “Discord — Release notes (session 3)”; the old one stays in DSH under its own name.', answer.text);
        await modelQuiet();
        const prompted = await promptInDsh(old, `The old session after new E2E:to ${thread} posted by the old session`);
        check('DSH still takes a prompt in the old session', prompted?.ok === true, q(prompted).slice(0, 300));
        const r = await requestFor('The old session after new');
        check('the old session is offered no Discord tool', discordToolsOf(r).length === 0, q(discordToolsOf(r)));
        await modelQuiet();
        check('and nothing from it reaches the thread', !botTexts(thread).some((x) => /posted by the old session/.test(x)));
        say('Fresh again E2E:reply A third session.', thread);
        await replyIn(thread, /A third session\./, 'the reply from the third session');
        firstSession = sessionOf(thread);
        check('a new session answers', Boolean(firstSession) && firstSession !== old);
        check('listed in DSH as "(session 3)"', /Discord — Release notes \(session 3\)/.test(q(await listed(firstSession))), q(await listed(firstSession)).slice(0, 300));
        check('the old one keeps its own name', /Discord — Release notes \(session 2\)/.test(q(await listed(old))), q(await listed(old)).slice(0, 300));
    });

    // ── Switched off and on while DSH runs ────────────────────────────────
    await step('switched off by editing the row while DSH runs: offline, no Discord tool in its session, nothing answered; on again, the message sent meanwhile is answered', async () => {
        const patchFile = join(run.profile, 'cordis.patch.yml');
        const base = readFileSync(patchFile, 'utf8');
        check('the plugin\'s row ends the profile\'s patch', base.endsWith(run.rows));
        const connects = fake.gateway.connects;
        await modelQuiet();
        writeFileSync(patchFile, base.slice(0, base.length - run.rows.length) + discordRow(run, '    enabled: false\n'));
        await waitFor(() => !fake.connected(), 'the bot to go offline', 45000);
        await waitFor(() => /discord: switched off \(enabled: false\)/.test(saidIn(traceFile)), 'the line in the plugin\'s log', 15000).catch(() => {});
        check('the plugin\'s log says it is switched off', /discord: switched off \(enabled: false\)/.test(saidIn(traceFile)), saidIn(traceFile).slice(-400));
        const prompted = await promptInDsh(firstSession, `While switched off E2E:to ${thread} posted while switched off`);
        check('DSH takes a prompt in the thread\'s session', prompted?.ok === true, q(prompted).slice(0, 300));
        const r = await requestFor('While switched off');
        check('switched off, the session is offered no Discord tool', discordToolsOf(r).length === 0, q(discordToolsOf(r)));
        say('Sent while switched off E2E:reply Answered after switching on.', thread, albert, { offline: true });
        await sleep(3000);
        check('nothing reaches Discord while it is switched off', !botTexts(thread).some((x) => /posted while switched off|Answered after switching on/.test(x)));
        await modelQuiet();
        writeFileSync(patchFile, base);
        await waitFor(() => fake.connected() && fake.gateway.connects > connects, 'the bot back online', 45000);
        const reply = await replyIn(thread, /Answered after switching on\./, 'the reply to the message sent while switched off', 60000);
        check('on again, the message sent while it was off is answered', Boolean(reply));
        check('in the thread\'s own session', sessionOf(thread) === firstSession);
    });

    // ── Files ────────────────────────────────────────────────────────────
    await step('the store and the trace are owner-only, inside the throwaway home, and the trace never holds the token', async () => {
        check('the store is owner-only (600)', modeOf(storeFile) === 0o600, modeOf(storeFile).toString(8));
        check('the trace is owner-only (600)', modeOf(traceFile) === 0o600, modeOf(traceFile).toString(8));
        const trace = readFileSync(traceFile, 'utf8');
        check('the trace is one JSON object per line', trace.trim().split('\n').every((line) => {
            try {
                return typeof JSON.parse(line).event === 'string';
            } catch {
                return false;
            }
        }));
        check('the trace and the store never hold the token', !trace.includes(TOKEN) && !readFileSync(storeFile, 'utf8').includes(TOKEN));
        check('DSH\'s own output never holds the token', !run.logText().includes(TOKEN));
        check('the previous run\'s trace is kept as .1', statSync(`${traceFile}.1`).size > 0);
    });

    // ── Pictures ─────────────────────────────────────────────────────────
    if (shots) await pictures();
} finally {
    await run.stop();
}

// ── Settings, each on a fresh start ──────────────────────────────────────
const settings = [
    ['switched off (enabled: false): it says so and never connects', 'enabled: false', /discord: switched off \(enabled: false\); the bot stays offline/],
    ['no token under its name: it says where to store one and never connects', null, /discord: no bot token under the credential name E2E_NO_SUCH_TOKEN, so the bot stays offline\. Store it in the DSH credential store/],
    ['an allowlist id without quotes: it stays offline (never "anyone") and says why', 'allowedUserIds: [111111111111111111]', /discord: setting refused: allowedUserIds has the id 111111111111111100 without quotes[\s\S]*discord: the bot stays offline: allowedUserIds is not a list of Discord ids in quotes/],
    ['installed without a workspace: it says what to set and never connects', 'bare', /discord: workspacePath is not set, so the bot stays offline; set it to the folder Discord sessions should work in, then reload/],
    ['a relative workspacePath: it stays offline and says why', 'workspacePath: "relative/ws"', /discord: the bot stays offline: workspacePath "relative\/ws" is not an absolute path; set it to the absolute path of a folder that exists, then reload/],
    ['a workspacePath that does not exist: it stays offline and says why', 'workspacePath: "/no/such/discord-workspace"', /discord: the bot stays offline: workspacePath \/no\/such\/discord-workspace does not exist; set it to the absolute path of a folder that exists, then reload/],
];
for (const [what, extra, said] of settings) {
    await step(`settings: ${what}`, async () => {
        const quiet = await startFakeDiscord({ token: TOKEN });
        const one = new DshRun({ label: `discord-settings-${label}`, bin, plugins: { 'dsh-plugin-discord': repoRoot }, env: { E2E_FAKE_DISCORD_TOKEN: TOKEN } });
        const row = `- id: discord
  config:
    workspacePath: ${q(one.ws)}
    tokenRef: ${extra === null ? 'E2E_NO_SUCH_TOKEN' : 'E2E_FAKE_DISCORD_TOKEN'}
    apiBase: ${q(quiet.apiBase)}
    allowedChannelIds: [${q(channel.id)}]
    allowedUserIds: [${q(albert.id)}]
    storeFile: ${q(join(one.home, 'discord-plugin-sessions.json'))}
    traceFile: ${q(join(one.home, 'discord-plugin-trace.log'))}
`;
        const trace = join(one.home, 'discord-plugin-trace.log');
        // 'bare': as installed, with no workspace; only the files are set, so both stay in the throwaway home.
        one.rows = extra === 'bare' ? `- id: discord\n  config:\n    storeFile: ${q(join(one.home, 'discord-plugin-sessions.json'))}\n    traceFile: ${q(trace)}\n`
            : extra && /^(allowedUserIds|workspacePath):/.test(extra) ? row.replace(new RegExp(`    ${extra.split(':')[0]}: .*\n`), `    ${extra}\n`) : extra ? `${row}    ${extra}\n` : row;
        one.writeProfile(model.port, { models: MODELS });
        try {
            await one.boot(what, () => said.test(saidIn(trace)));
            await sleep(1500);
            check(`${what}: the plugin's log says so`, said.test(saidIn(trace)), saidIn(trace));
            check(`${what}: the fake Discord heard nothing`, quiet.requests.length === 0 && quiet.gateway.connects === 0, `${quiet.requests.length} requests, ${quiet.gateway.connects} connections`);
            check(`${what}: DSH runs on`, one.alive());
        } finally {
            await one.stop();
            one.cleanup();
            await quiet.close();
        }
    });
}
await step('settings: a token Discord refuses: the bot says so once and stops, without hammering Discord', async () => {
    const strict = await startFakeDiscord({ token: TOKEN });
    const one = new DshRun({ label: `discord-settings-${label}`, bin, plugins: { 'dsh-plugin-discord': repoRoot }, env: { E2E_FAKE_DISCORD_TOKEN: 'e2e-a-token-the-fake-refuses' } });
    one.rows = `- id: discord
  config:
    workspacePath: ${q(one.ws)}
    tokenRef: E2E_FAKE_DISCORD_TOKEN
    apiBase: ${q(strict.apiBase)}
    allowedChannelIds: [${q(channel.id)}]
    allowedUserIds: [${q(albert.id)}]
    storeFile: ${q(join(one.home, 'discord-plugin-sessions.json'))}
    traceFile: ${q(join(one.home, 'discord-plugin-trace.log'))}
`;
    one.writeProfile(model.port, { models: MODELS });
    try {
        const trace = join(one.home, 'discord-plugin-trace.log');
        await one.boot('a refused token', () => /discord: Discord refused the bot token/.test(saidIn(trace)));
        const asked = strict.requests.length;
        await sleep(5000);
        check('the plugin\'s log says Discord refused the token and what to check', /^warn: discord: Discord refused the bot token \(401\); check the token stored under tokenRef\. The bot stays offline until the setting is fixed and the plugin is reloaded\.$/m.test(saidIn(trace)), saidIn(trace));
        check('it stops: no more calls to Discord after the refusal', strict.requests.length === asked && asked <= 2 && strict.gateway.connects === 0, `${asked} then ${strict.requests.length} requests`);
        check('DSH runs on', one.alive());
    } finally {
        await one.stop();
        one.cleanup();
        await strict.close();
    }
});
await step('settings: a wrong number falls back to its default with a line in the log, and the bot still connects', async () => {
    const fine = await startFakeDiscord({ token: TOKEN });
    const one = new DshRun({ label: `discord-settings-${label}`, bin, plugins: { 'dsh-plugin-discord': repoRoot }, env: { E2E_FAKE_DISCORD_TOKEN: TOKEN } });
    one.rows = `- id: discord
  config:
    workspacePath: ${q(one.ws)}
    tokenRef: E2E_FAKE_DISCORD_TOKEN
    apiBase: ${q(fine.apiBase)}
    allowedChannelIds: [${q(channel.id)}]
    allowedUserIds: [${q(albert.id)}]
    storeFile: ${q(join(one.home, 'discord-plugin-sessions.json'))}
    traceFile: ${q(join(one.home, 'discord-plugin-trace.log'))}
    maxPromptChars: lots
`;
    one.writeProfile(model.port, { models: MODELS });
    try {
        await one.boot('a wrong number', () => fine.connected());
        const said = saidIn(join(one.home, 'discord-plugin-trace.log'));
        check('the plugin\'s log names the refused value and the default it uses', /^warn: discord: setting refused: maxPromptChars must be a whole number[^\n]*using 8000/m.test(said), said);
        check('the bot connects anyway', fine.connected());
    } finally {
        await one.stop();
        one.cleanup();
        await fine.close();
    }
});

await fake.close();
await model.close();
run.cleanup();
console.log(`\n${t.passed} passed, ${t.failed} failed`);
if (t.failed > 0) console.log(`# failed: ${t.failures.join('; ')}`);
process.exit(t.failed === 0 ? 0 : 1);

// ── The pictures ─────────────────────────────────────────────────────────
/**
 * Clicks `target` in DSH's window. A notice DSH shows late (after the window settled) can cover it: then the
 * notice is named in the log, closed, and the click tried again, at most three times.
 */
async function clickPast(page, target, tries = 3) {
    for (let i = 1; ; i += 1) {
        try {
            await target.click({ timeout: 5000 });
            return;
        } catch (error) {
            if (i >= tries) throw error;
            const cover = page.locator('[role="dialog"], [role="alertdialog"], [role="presentation"]').last();
            const text = await cover.innerText({ timeout: 1000 }).catch(() => '');
            console.log(`# a dialog covered the click (${q(text.replace(/\s+/g, ' ').slice(0, 200))}); closing it`);
            await shot(page, shots, `covered-click-${i}`).catch(() => {});
            await dismissNotices(page);
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(500);
        }
    }
}

async function pictures() {
    const pw = await findPlaywright();
    if (!pw) {
        check('pictures: Playwright is there (PLAYWRIGHT_MODULE, or a runtime folder\'s tools/)', false);
        return;
    }
    await step('pictures: the Discord session in DSH\'s window, light, dark and 760 px', async () => {
        const window = await openWindow(run, pw, { width: 1280, height: 860 });
        try {
            const { page } = window;
            const stored = readStore().threads?.[thread] ?? {};
            const listedAs = `Discord — ${stored.title ?? ''}${stored.generation > 1 ? ` (session ${stored.generation})` : ''}`;
            const entry = page.getByText(listedAs, { exact: true }).first();
            await entry.waitFor({ state: 'visible', timeout: 30000 });
            await clickPast(page, entry);
            await page.mouse.move(900, 450); // away from the sidebar, so no hover card covers it
            await page.getByText('Answered after switching on.').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
            await dismissNotices(page);
            check('the window shows the Discord session in its list', await entry.isVisible());
            await shot(page, shots, 'session-light');
            await setDark(page, true);
            await shot(page, shots, 'session-dark');
            await setDark(page, false);
            await page.setViewportSize({ width: 760, height: 860 });
            await shot(page, shots, 'session-760-light');
            await setDark(page, true);
            await shot(page, shots, 'session-760-dark');
            await setDark(page, false);
            await page.setViewportSize({ width: 1280, height: 860 });
            // The Chat tab shows the agent's turns and leaves out context rows, as DSH does for every message that
            // a person did not type in its window, and each relayed Discord message is one. The Trajectory tab
            // shows them: a CONTEXT row per message, with the text the agent got ("Discord message from @albert ...").
            const tab = page.getByRole('tab', { name: 'Trajectory', exact: true }).or(page.getByRole('button', { name: 'Trajectory', exact: true })).or(page.getByText('Trajectory', { exact: true })).first();
            await clickPast(page, tab);
            await page.mouse.move(900, 450);
            const relayed = page.getByText(/Discord message from @albert/).last();
            await relayed.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
            await relayed.scrollIntoViewIfNeeded().catch(() => {});
            const shown = await relayed.isVisible();
            if (!shown) console.log(`# Trajectory shows: ${q((await page.locator('body').innerText().catch(() => '')).slice(0, 1500))}`);
            check('the session\'s Trajectory tab shows the relayed Discord messages, as the agent got them', shown);
            await shot(page, shots, 'trajectory-light');
            await setDark(page, true);
            await shot(page, shots, 'trajectory-dark');
            const ours = window.errors.filter((text) => /discord/i.test(text));
            check('no errors from the plugin in the window', ours.length === 0, ours.join('\n'));
        } finally {
            await window.browser.close();
        }
    }, async () => {});
    await step('pictures: the plugin in DSH\'s Plugins page (installed, running), light, dark and 760 px', async () => {
        const window = await openWindow(run, pw, { width: 1280, height: 860 });
        const { page } = window;
        const names = async () => page.getByRole('button').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40)).filter(Boolean));
        try {
            const plugins = page.getByRole('button', { name: 'Plugins', exact: true }).or(page.getByRole('link', { name: 'Plugins', exact: true })).first();
            await clickPast(page, plugins);
            await page.mouse.move(900, 450);
            // The card under Installed, by its sentence (the sidebar lists "Discord — ..." sessions too).
            const card = page.getByText(/^A Discord bot for your own channels/).first();
            await card.waitFor({ state: 'visible', timeout: 15000 });
            await card.scrollIntoViewIfNeeded(); // the Installed list comes after DSH's own plugins
            check('DSH\'s Plugins page lists the plugin under Installed, with its sentence', await card.isVisible());
            const icons = await page.locator('img[src^="data:image/svg+xml"]').count();
            console.log(`# the Plugins page draws ${icons} picture(s) from an SVG data address`);
            await shot(page, shots, 'plugins-list-light');
            await setDark(page, true);
            await shot(page, shots, 'plugins-list-dark');
            await setDark(page, false);
            // The card opens by its title button ("View Discord"), which DSH lays over the whole card, sentence included.
            await clickPast(page, page.getByRole('button', { name: 'View Discord', exact: true }).first());
            await page.mouse.move(900, 450);
            // The plugin's own page: its one component (the row "discord") and whether it runs. The settings live in
            // the profile row: DSH offers a settings form only to plugins that ship a window part, and this one has none.
            await page.getByText('Running').first().waitFor({ state: 'visible', timeout: 15000 });
            check('the plugin\'s page shows it running, with its row "discord"', await page.getByText('Running').first().isVisible() && await page.getByText('discord', { exact: true }).first().isVisible());
            await shot(page, shots, 'plugin-page-light');
            await setDark(page, true);
            await shot(page, shots, 'plugin-page-dark');
            await page.setViewportSize({ width: 760, height: 860 });
            await shot(page, shots, 'plugin-page-760-dark');
            await setDark(page, false);
            await shot(page, shots, 'plugin-page-760-light');
            const ours = window.errors.filter((text) => /discord/i.test(text));
            check('no errors from the plugin in the window', ours.length === 0, ours.join('\n'));
        } catch (error) {
            console.log(`# Plugins page: ${error.message.split('\n')[0]}; buttons: ${q(await names().catch(() => [])).slice(0, 1500)}`);
            await shot(page, shots, 'failed-plugins').catch(() => {});
            throw error;
        } finally {
            await window.browser.close();
        }
    }, async () => {});
    await step('pictures: the fake Discord thread as the person reads it, light and dark', async () => {
        const browser = await launchChromium(pw);
        try {
            const page = await browser.newPage({ viewport: { width: 760, height: 1200 } });
            await page.setContent(transcriptHtml(), { waitUntil: 'load' });
            await shot(page, shots, 'discord-thread-light', page.locator('body')); // the whole thread, not just the first screen
            await page.emulateMedia({ colorScheme: 'dark' });
            await shot(page, shots, 'discord-thread-dark', page.locator('body'));
            check('pictures: the thread transcript', true);
        } finally {
            await browser.close();
        }
    }, async () => {});
}

/** The fake Discord's channel and first thread as a page: who said what, in order. */
function transcriptHtml() {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const rows = (id) => (fake.messages.get(id) ?? []).map((m) => `<div class="m ${m.author?.bot ? 'bot' : ''}"><b>${esc(m.author?.global_name ?? m.author?.username)}</b>${m.author?.bot ? ' <span class="tag">BOT</span>' : ''}<pre>${esc((m.content ?? '').slice(0, 400))}${(m.content ?? '').length > 400 ? ' …' : ''}</pre>${(m.attachments ?? []).map((a) => `<div class="file">📎 ${esc(a.filename)} (${esc(a.size)} bytes)</div>`).join('')}</div>`).join('');
    return `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#5c6370;--line:#e3e5e8;--bot:#5865f2}
@media (prefers-color-scheme:dark){:root{--bg:#313338;--fg:#f2f3f5;--muted:#b5bac1;--line:#3f4147;--bot:#949cf7}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:15px;margin:0 0 4px}h2{font-size:13px;color:var(--muted);margin:16px 0 6px;font-weight:600}
.m{padding:6px 0;border-bottom:1px solid var(--line)}.m pre{margin:2px 0 0;white-space:pre-wrap;font:inherit}
.bot b{color:var(--bot)}.tag{font-size:10px;background:var(--bot);color:#fff;border-radius:3px;padding:0 4px}
.file{color:var(--muted)}</style>
<h1># ${esc(channel.name)} (fake Discord, ${esc(label)})</h1>
<h2>Channel</h2>${rows(channel.id)}
<h2>Thread: ${esc(fake.channels.get(thread)?.name)}</h2>${rows(thread)}`;
}
