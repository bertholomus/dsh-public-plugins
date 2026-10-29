/**
 * Discord: a person asks in the bot's channel, the bot opens a thread with
 * its own DSH session, and the agent answers there with discord_send. DSH's
 * side is the session the thread made, listed as "Discord — <title>".
 *
 * The Discord here is the test Discord server of the plugin's own end-to-end
 * test (plugins/discord/test/support/fake-discord.mjs) on this computer, with
 * a made-up token: nothing reaches Discord. The other side is drawn from the
 * messages that server kept, as the plugin's test draws them, and says so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeDiscord } from '../../../plugins/discord/test/support/fake-discord.mjs';
import { demoTimezone, waitFor } from '../stage.mjs';

const TOKEN = 'showcase-bot-token-not-a-real-one';

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Discord's Markdown, as much as these messages use: code blocks, inline code, bold and lists. */
function markdown(text) {
    const html = [];
    for (const [i, part] of String(text).split(/```\w*\n?/).entries()) {
        if (i % 2 === 1) {
            html.push(`<pre>${escape(part.replace(/\n$/, ''))}</pre>`);
            continue;
        }
        const inline = (line) => escape(line).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        let list = false;
        for (const line of part.split('\n')) {
            const item = /^- (.*)$/.exec(line);
            if (item && !list) html.push('<ul>');
            if (!item && list) html.push('</ul>');
            list = Boolean(item);
            if (item) html.push(`<li>${inline(item[1])}</li>`);
            else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
        }
        if (list) html.push('</ul>');
    }
    return html.join('');
}

/** The thread as the test server kept it: the message it was made from, then its messages. */
function threadPage(fake, channel, thread, zone) {
    const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
    const row = (m) => `<div class="m${m.author?.bot ? ' bot' : ''}">
        <div class="av">${m.author?.bot ? 'D' : escape((m.author?.global_name ?? m.author?.username ?? '?')[0])}</div>
        <div class="body"><div class="who"><b>${escape(m.author?.global_name ?? m.author?.username)}</b>${m.author?.bot ? '<span class="tag">BOT</span>' : ''}<span class="at">Today at ${time(m.timestamp)}</span></div>
        <div class="text">${markdown(m.content)}</div></div></div>`;
    const starter = (fake.messages.get(channel.id) ?? []).filter((m) => !m.author?.bot).at(-1);
    const name = fake.channels.get(thread)?.name ?? '';
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        :root { color-scheme: light dark; --bg: #ffffff; --head: #f2f3f5; --fg: #1f2328; --muted: #5c6370; --line: #e3e5e8; --code: #f2f3f5; --bot: #5865f2; }
        @media (prefers-color-scheme: dark) { :root { --bg: #313338; --head: #2b2d31; --fg: #f2f3f5; --muted: #b5bac1; --line: #3f4147; --code: #2b2d31; --bot: #949cf7; } }
        html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
        .head { height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 20px; background: var(--head); border-bottom: 1px solid var(--line); font-weight: 600; }
        .head .hash { color: var(--muted); font-size: 22px; font-weight: 400; }
        .head .sep { color: var(--muted); font-weight: 400; }
        .feed { max-width: 1040px; padding: 12px 20px 60px; }
        .m { display: flex; gap: 14px; padding: 10px 0; }
        .av { width: 40px; height: 40px; border-radius: 50%; flex: none; display: grid; place-items: center; font-weight: 600; color: #fff; background: #3ba55d; }
        .bot .av { background: var(--bot); }
        .who b { font-weight: 600; } .bot .who b { color: var(--bot); }
        .tag { margin-left: 6px; font-size: 10px; font-weight: 600; color: #fff; background: #5865f2; border-radius: 3px; padding: 1px 4px; vertical-align: 2px; }
        .at { margin-left: 8px; font-size: 12px; color: var(--muted); }
        .text p { margin: 2px 0; } .text ul { margin: 4px 0; padding-left: 22px; } .text li { margin: 2px 0; }
        code, pre { font: 13px/1.45 ui-monospace, Menlo, monospace; background: var(--code); border-radius: 4px; }
        code { padding: 1px 4px; } pre { margin: 6px 0; padding: 10px 12px; border: 1px solid var(--line); max-width: 640px; white-space: pre-wrap; }
        .start { margin: 6px 0 4px 54px; font-size: 13px; color: var(--muted); }
        .label { position: fixed; left: 20px; bottom: 16px; font-size: 13px; color: var(--muted); }
    </style></head><body>
        <script>const dark = matchMedia('(prefers-color-scheme: dark)'); const mark = () => document.body.toggleAttribute('data-ds-dark-theme', dark.matches); mark(); dark.addEventListener('change', mark);</script>
        <div class="head"><span class="hash">#</span>${escape(channel.name)}<span class="sep">›</span>${escape(name)}</div>
        <div class="feed">${starter ? row(starter) : ''}<div class="start">The bot started a thread from this message: ${escape(name)}</div>${(fake.messages.get(thread) ?? []).map(row).join('')}</div>
        <div class="label">Drawn from the messages that a server on this computer kept in this run. It takes the place of Discord, so nothing went to Discord. In use, Discord shows the thread in its own app.</div>
    </body></html>`;
}

export default async function discord(scene) {
    const fake = await startFakeDiscord({ token: TOKEN, heartbeatMs: 4000 });
    try {
        fake.guild.name = 'Harbor team';
        const channel = fake.addChannel({ name: 'gateway' });
        const maya = fake.addUser({ username: 'maya', global_name: 'Maya' });
        let storeFile;
        const run = await scene.start({
            plugins: ['discord'],
            env: { SHOWCASE_DISCORD_TOKEN: TOKEN },
            before: (r) => {
                storeFile = join(r.home, 'discord-plugin-sessions.json');
                r.rows = `- id: permission
  config:
    defaultPreset: workspace-write
- id: discord
  config:
    workspacePath: ${JSON.stringify(r.ws)}
    tokenRef: SHOWCASE_DISCORD_TOKEN
    apiBase: ${JSON.stringify(fake.apiBase)}
    allowedChannelIds: [${JSON.stringify(channel.id)}]
    allowedUserIds: [${JSON.stringify(maya.id)}]
    storeFile: ${JSON.stringify(storeFile)}
    traceFile: ${JSON.stringify(join(r.home, 'discord-plugin-trace.log'))}
`;
            },
        });
        await waitFor(() => fake.connected(), 'the bot on the gateway', 60000, 300);
        await waitFor(() => fake.commands.length > 0, 'the slash commands', 30000, 300).catch(() => {});

        // Maya asks in #gateway: a thread is made from her message, with a DSH session of its own.
        fake.userMessage({ channelId: channel.id, author: maya, content: scene.say('What changed in the gateway') });
        const thread = await waitFor(() => fake.threadsOf(channel.id)[0]?.id, 'the thread', 60000, 300);
        await waitFor(() => fake.botMessages(thread).length >= 1, 'the first answer in the thread', 120000, 300);
        const session = await waitFor(() => JSON.parse(readFileSync(storeFile, 'utf8')).threads?.[thread]?.sessionId, 'the thread\'s session', 30000, 300);
        await run.idle(session);
        await waitFor(() => fake.channels.get(thread)?.name === 'Gateway changes since 2.3', 'the thread\'s title', 60000, 300).catch(() => {});
        // Her answer in the thread goes to the same session.
        fake.userMessage({ channelId: thread, author: maya, content: scene.say('Yes, draft it here first') });
        await waitFor(() => fake.botMessages(thread).length >= 2, 'the draft in the thread', 120000, 300);
        await run.idle(session);

        // DSH's side: the session the thread made, listed as "Discord — <title>", each Discord message a closed
        // "Execution requested" row (opened, it and the discord_send call show the thread's Discord id).
        const page = await scene.open({ entry: 'Plugins' });
        const row = page.locator(`[data-row-key="session:${session}"]`).first();
        if (!(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) {
            await page.locator('[data-slot="sidebar.workspaces"]').getByText('harbor-gateway', { exact: true }).first().click();
        }
        await row.click();
        await page.getByText('Sent the draft to the thread.').first().waitFor({ state: 'visible', timeout: 30000 });
        await scene.shoot('session', { themes: ['light'] });

        // The other side: the thread, drawn from what the test Discord server kept.
        const drawn = await page.context().newPage();
        await drawn.setContent(threadPage(fake, channel, thread, demoTimezone()));
        await scene.shoot('thread', { page: drawn });
        await drawn.close();
    } finally {
        await fake.close();
    }
}
