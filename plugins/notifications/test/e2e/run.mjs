#!/usr/bin/env node
/**
 * Notifications in a real DSH: a plugin's news through the notifications
 * service, shown by a real DSH window, with every outcome proven in the
 * plugin's log file and on its settings page.
 *
 * DSH runs from a throwaway DSH_HOME (test/e2e/harness.mjs) with the
 * session bridge, the notifications plugin and a stand-in caller
 * (test/e2e/caller) that calls the service exactly as the coordinator,
 * Decisions and Fleet do. The window is a real Chromium on DSH's web
 * profile, with the Web Notifications API replaced by a recorder that
 * fires the system's show event: nothing reaches this computer's screen,
 * and the test reads what the sender would have shown.
 *
 * - The browser half is served and parses; the endpoints answer over DSH's
 *   gateway (the 404 that once sent every notification to the wrong app).
 * - No window yet: on macOS nothing is sent (no command sender), and the
 *   log says why; the plugin's state file is 700/600 in DSH's data folder.
 * - A window in the background: the news shows with its title and body,
 *   the window reports the system's show event, and the log and the page
 *   say "shown"; a click brings the window up and opens the chat the news
 *   is about.
 * - A window in front with nobody at it still shows the news; once the
 *   person moves the pointer it is in use, nothing shows, and the list says
 *   why.
 * - Five at once: the newest two alone and one summary of the rest; a
 *   click on the summary opens the plugin's page at the recent list.
 * - A blocked tab beside a window that can show news takes nothing, and the
 *   other window shows it; two windows that can both show it show it once.
 * - A notification that names a place opens it on a click (a plugin's
 *   page); Fleet's findings name Fleet's page; each click is logged.
 * - The settings page in Plugins (DSH's own form): where notifications go,
 *   this window's permission, the recent list with Open chat and the log
 *   file's path, a kind switched off and saved (applied at once with no
 *   restart, the next one of that kind is "off", in words, and the log
 *   names the setting), the test button by keyboard; light and dark
 *   pictures, a 760 px window, text contrast.
 * - A browser that has not answered the permission ask: the row says so,
 *   the Allow button asks, and the keyboard's place stays on the row.
 * - A restart with news waiting: after it the relaunched window, in front,
 *   shows the news once, and a reload does not show it again.
 * - Switched off and on from Plugins: callers get nothing while off, its
 *   style sheet leaves the window, and on again it works with one sheet.
 * - A wrong setting and a misspelt key in the profile: the plugin still
 *   starts and works, the log warns, and the page names each, with the fix.
 *
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node plugins/notifications/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/; `node scripts/e2e.mjs
 * notifications` runs it on each of those and on the installed app's own
 * DSH. SHOTS=<folder> keeps the window's pictures there (default
 * .e2e/shots/notifications/<version>); KEEP=1 keeps the throwaway DSH_HOME.
 * Without Playwright the run fails, unless NO_WINDOW=1 says to run without
 * the window checks.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { DshRun, checks, dismissNotices, dshBin, findPlaywright, freePort, launchChromium, pluginsDir, repoRoot, setDark, shot, sleep, waitFor } from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from '../../../../test/e2e/fake-model.mjs';

const bin = dshBin();
if (!bin) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'notifications', version);
console.log(`# DSH ${version}: ${bin}`);
console.log(`# pictures: ${shots}`);

const tally = checks();
const { check, step } = tally;
const json = (value) => JSON.stringify(value);
const model = await startFakeModel();
const here = dirname(new URL(import.meta.url).pathname);
const BUNDLE = 'dsh-plugin-notifications';
/** The app's own DSH runs under the app's binary as Node (scripts/e2e.mjs runs this test under it too). */
const desktopApp = process.versions.electron !== undefined;

/** The notifications row's settings in the profile (restated whole, as a patch row replaces its config). */
const rowsWith = (config = {}) => (Object.keys(config).length === 0 ? '' : `- id: notifications
  config:
${Object.entries(config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`).join('\n')}
`);

const run = new DshRun({
    label: 'notifications',
    bin,
    port: await freePort(),
    plugins: {
        'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge'),
        [BUNDLE]: join(pluginsDir, 'notifications'),
        'dsh-plugin-notifications-e2e-caller': join(here, 'caller'),
    },
});
const stateFile = join(run.home, 'notifications', 'state.json');
const api = (method, args = {}) => run.api(`${BUNDLE}/${method}`, args);
/** A notification through the stand-in caller, as another plugin sends one: what the service answered. */
const notify = async (notification) => {
    const result = await run.api('dsh-plugin-notifications-e2e-caller/notify', { notification });
    return result.ok ? result.value : `error: ${json(result.error)}`;
};
const status = async () => {
    const result = await api('status');
    if (!result.ok) throw new Error(`status: ${json(result.error)}`);
    return result.value;
};
const entryOf = async (title) => (await status()).recent.find((item) => item.title === title);
/** The plugin's log lines, from its own file (DSH 0.2 writes no plugin's log lines out), each without its time: `info #12 …`. */
const logFile = () => join(run.home, 'notifications', 'notifications.log');
const logLines = () => (existsSync(logFile()) ? readFileSync(logFile(), 'utf8') : '').split('\n').filter(Boolean).map((line) => line.replace(/^\S+ /, ''));

/**
 * The window's Web Notifications, replaced by a recorder: each one is kept
 * in `window.__notes` (title, body, tag, and its click), and the system's
 * show event fires 50 ms later. `window.__watching` says whether the person
 * looks at the window (document.hasFocus); `startPermission` is the
 * browser's answer so far, `askAnswer` what the ask resolves to.
 */
const fakeNotifications = ({ startPermission = 'granted', askAnswer = 'granted', startWatching = false } = {}) => `
(() => {
    window.__notes = [];
    window.__watching = ${JSON.stringify(startWatching)};
    class RecordedNotification {
        constructor(title, options = {}) {
            this.title = title;
            this.body = options.body;
            this.tag = options.tag;
            window.__notes.push(this);
            setTimeout(() => { try { this.onshow && this.onshow(); } catch (e) {} }, 50);
        }
        close() { this.closed = true; }
        static requestPermission() {
            RecordedNotification.permission = ${JSON.stringify(askAnswer)};
            return Promise.resolve(RecordedNotification.permission);
        }
    }
    RecordedNotification.permission = ${JSON.stringify(startPermission)};
    Object.defineProperty(window, 'Notification', { value: RecordedNotification, configurable: true, writable: true });
    Document.prototype.hasFocus = function () { return Boolean(window.__watching); };
})();`;

/**
 * A signed-in window whose Web Notifications are the recorder from its first
 * script on, so no news is taken before the recorder is there.
 */
async function openFakeWindow(pw, { width = 1280, height = 860, fake = {}, dismiss = true } = {}) {
    const web = await run.signIn();
    const browser = await launchChromium(pw);
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', colorScheme: 'light', timezoneId: 'America/Los_Angeles' });
    await context.addInitScript({ content: fakeNotifications(fake) });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(web.link, { waitUntil: 'domcontentloaded' });
    // DSH's first-run notices, out of the way (they can come seconds late). Without `dismiss`, nothing touches the window:
    // it stays a window nobody has used since it loaded.
    const end = Date.now() + (dismiss ? 30000 : 0);
    let calm = Date.now();
    while (Date.now() < end && Date.now() - calm < 4000) {
        if (await dismissNotices(page)) calm = Date.now();
        await page.waitForTimeout(400);
    }
    return { browser, context, page, errors };
}

/**
 * Scroll an element into the window for a picture, without waiting for it to
 * hold still (on a busy machine DSH's page can keep moving for longer than a
 * locator waits; the picture is taken either way).
 */
const inView = async (locator) => {
    await locator.first().evaluate((element) => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    await sleep(250);
};
/**
 * A picture for the record. On a busy machine a screenshot can take longer
 * than an action may wait (one took over 15 s at a load average of 65), so
 * a picture gets up to 60 s; the checks keep their own limits.
 */
async function picture(page, name) {
    page.setDefaultTimeout(60000);
    try {
        return await shot(page, shots, name);
    } finally {
        page.setDefaultTimeout(30000);
    }
}
const notes = (page) => page.evaluate(() => window.__notes.map((n) => ({ title: n.title, body: n.body, tag: n.tag, closed: Boolean(n.closed) })));
/** Make the window look at its queue now (it polls every 15 s, and at once on focus or blur). */
const poke = (page) => page.evaluate(() => window.dispatchEvent(new Event('blur')));

/** Open DSH's Plugins page at the notifications plugin's settings, as a person does: Plugins, then its card. */
async function openSettings(page) {
    const form = page.locator('[data-notifications-settings]');
    const seen = (locator) => locator.first().isVisible().catch(() => false);
    if (await seen(form)) return form;
    // DSH's sidebar entry (a button named Plugins); its page opens on its last view, the list or a plugin's own page.
    // DSH's first-run notice can come late (after a restart, on a busy machine) and cover it: out of the way first,
    // and again whenever it covers the click.
    const plugins = page.getByRole('button', { name: 'Plugins', exact: true }).first();
    const end = Date.now() + 60000;
    for (;;) {
        await dismissNotices(page);
        try {
            await plugins.click({ timeout: 5000 });
            break;
        } catch (error) {
            if (Date.now() > end) throw error;
        }
    }
    // The card's title is DSH's "View <name>" button.
    const card = page.getByRole('button', { name: 'View Notifications', exact: true });
    const back = page.getByRole('button', { name: 'Back to plugins', exact: true });
    await waitFor(async () => (await seen(form)) || (await seen(card)) || (await seen(back)), 'DSH\'s Plugins page', 20000, 200);
    if (await seen(form)) return form;
    if (!(await seen(card))) await back.first().click();
    await card.first().waitFor({ state: 'visible', timeout: 20000 });
    await card.first().click();
    await form.waitFor({ state: 'visible', timeout: 20000 });
    return form;
}

/** Quit DSH and start it again with the profile as it is. */
async function restart(what, rows) {
    await run.stop();
    if (rows !== undefined) {
        run.rows = rows;
        run.writeProfile(model.port);
    }
    await run.boot(what);
    await waitFor(async () => (await api('status')).ok, `the notifications endpoints (${what})`, 60000, 300);
}

let window;
try {
    run.writeProfile(model.port);
    await run.boot('first start');
    await waitFor(async () => (await api('status')).ok, 'the notifications endpoints', 60000, 300);

    // ── Served, and its endpoints answer ───────────────────────────────
    await step('the browser half is served and parses; the endpoints answer over DSH\'s gateway', async () => {
        const client = await run.clientOf(BUNDLE);
        let parses = false;
        try {
            new Script(client.text);
            parses = true;
        } catch {}
        check('DSH serves the browser half, and it parses', client.status === 200 && parses && client.text.includes('dsh-plugin-notifications'), `${client.status} ${client.url}`);
        const s = await status();
        check('status answers before any window: no window has checked in', s.windowSeenAt === '' && s.enabled === true && Array.isArray(s.recent) && s.recent.length === 0 && s.problems.length === 0, json(s));
        const unknown = await api('nope');
        check('a method it does not have is refused, not served', unknown.ok === false, json(unknown));
        // The app's own DSH runs under the app's binary (Electron as Node), as it does inside the app: the plugin takes it for the Desktop app.
        const expected = desktopApp ? /^info started \(on; the Desktop app; sender now: window\)/ : /^info started \(on; no Desktop app; sender now: (none|command)\)/;
        check(`the log says it started, and where notifications go (${desktopApp ? 'the Desktop app\'s DSH' : 'a DSH in a terminal'})`, logLines().some((line) => expected.test(line)), logLines().join('\n'));
    });

    // ── No window: on macOS nothing is sent, in words ──────────────────
    await step('with no window, nothing is sent where no sender shows DSH\'s icon, and the log says why', async () => {
        const sent = await notify({ title: 'No window yet', body: 'B', kind: 'handback' });
        const entry = await entryOf('No window yet');
        if (desktopApp) {
            // The Desktop app's window is there even while hidden, so the news waits for it (and shows when it looks).
            check('the Desktop app\'s DSH: the news waits for the app\'s window, and the list says so', sent === 'browser' && entry?.state === 'waiting' && entry.detail === 'Waiting for DSH\'s window to show it.', json({ sent, entry }));
        } else if (process.platform === 'darwin') {
            check('macOS: the caller is told none, nothing is spawned, and the reason is listed', sent === 'none' && entry?.state === 'not shown' && entry.detail === 'No DSH window was open to show it, and macOS has no other sender that shows DSH\'s icon.', json({ sent, entry }));
        } else {
            check('a command sender takes it where the system has one', ['cli', 'none'].includes(sent) && Boolean(entry), json({ sent, entry }));
        }
        check('the log has the line, with its id and kind', logLines().some((line) => line.includes(`#${entry?.id} (handback) “No window yet”`)), logLines().slice(-5).join('\n'));
        check('its state is kept in DSH\'s data folder, the folder 700 and the file 600', existsSync(stateFile) && (statSync(dirname(stateFile)).mode & 0o777) === 0o700 && (statSync(stateFile).mode & 0o777) === 0o600, stateFile);
    });

    const pw = await findPlaywright();
    if (!pw && process.env.NO_WINDOW !== '1') throw new Error('Playwright is not installed: install it under .e2e/tools, or set NO_WINDOW=1');
    const sessionText = 'Notifications e2e: the chat a notification opens. E2E:say Done, and the chat says so.';
    let sessionId;
    if (pw) {
        sessionId = await run.newSession(sessionText, 'Fix the flaky upload test');
        await waitFor(async () => (await run.session(sessionId))?.status === 'idle', 'the session to finish its turn', 120000, 500).catch(() => {});

        // ── A window in the background ─────────────────────────────────
        window = await openFakeWindow(pw);
        await waitFor(async () => (await status()).sender === 'window', 'the window to check in', 60000, 300);
        await step('a window in the background shows the news, reports the system\'s show event, and a click opens its chat', async () => {
            const { page } = window;
            const sent = await notify({ title: '“Fix the flaky upload test” handed back', body: 'Ready for review', kind: 'handback', sessionId });
            check('the caller is told it is queued for DSH\'s window', sent === 'browser', sent);
            await poke(page);
            const shown = await waitFor(async () => (await notes(page)).find((n) => n.title === '“Fix the flaky upload test” handed back'), 'the window to show it', 30000, 300);
            check('the window shows it with its title and body, tagged with its id', shown.body === 'Ready for review' && /^dsh-plugin-notifications:[\w-]+:\d+$/.test(shown.tag ?? ''), json(shown));
            const entry = await waitFor(async () => {
                const found = await entryOf('“Fix the flaky upload test” handed back');
                return found?.state === 'shown' ? found : undefined;
            }, 'the window to report it shown', 20000, 300);
            check('the host lists it as shown, on the system\'s word', entry.detail === 'Shown on screen by DSH\'s window (the system reported it).' && entry.sessionId === sessionId, json(entry));
            check('the log says shown, by its id', logLines().some((line) => line === `info #${entry.id} shown: Shown on screen by DSH's window (the system reported it).`), logLines().slice(-6).join('\n'));
            // The person clicks it: DSH's window comes up with that chat open.
            await page.evaluate(() => window.__notes.at(-1).onclick());
            await page.getByText('Notifications e2e: the chat a notification opens.', { exact: false }).first().waitFor({ state: 'visible', timeout: 20000 });
            check('a click opens the chat the news is about, and closes the notification', (await notes(page)).at(-1).closed === true, json(await notes(page)));
            await picture(page, 'chat-opened-light');
        }, async () => { if (window?.page) await picture(window.page, 'failed-background'); });

        await step('a window in front with nobody at it still shows the news; once the person is at it, nothing shows, and the list says why', async () => {
            // A window in front and seen that nobody has touched since it loaded (the owner walked away). The first window
            // stands aside meanwhile: its notifications blocked for the moment, so it takes nothing.
            await window.page.evaluate(() => { window.Notification.permission = 'denied'; });
            await poke(window.page);
            const front = await openFakeWindow(pw, { fake: { startWatching: true }, dismiss: false });
            const { page } = front;
            try {
            await waitFor(async () => (await status()).sender === 'window', 'the window to check in', 30000, 300);
            check('the window is in front and seen', await page.evaluate(() => document.hasFocus() && document.visibilityState === 'visible'));
            check('the caller is told it is queued', (await notify({ title: 'Left in front', kind: 'handback' })) === 'browser');
            await poke(page);
            await waitFor(async () => (await notes(page)).some((n) => n.title === 'Left in front'), 'the window in front with nobody at it to show it', 20000, 300);
            const left = await waitFor(async () => {
                const found = await entryOf('Left in front');
                return found?.state === 'shown' ? found : undefined;
            }, 'it to be reported shown', 20000, 300);
            check('in front with nobody at it, the news shows, and the list says shown', left.detail === 'Shown on screen by DSH\'s window (the system reported it).', json(left));
            // The person moves the pointer over the window: now it is in use.
            await page.mouse.move(300, 300);
            await page.mouse.move(320, 310);
            const before = (await notes(page)).length;
            check('the caller is told it is queued', (await notify({ title: 'While you use it', kind: 'approval' })) === 'browser');
            await poke(page);
            const entry = await waitFor(async () => {
                const found = await entryOf('While you use it');
                return found?.state === 'not shown' ? found : undefined;
            }, 'the window to take it', 20000, 300);
            check('in use: nothing shows, and the list says you were using DSH', (await notes(page)).length === before && entry.detail === 'You were using DSH (its window was in front and in use), so no notification was needed.', json(entry));
            } finally {
                await front.browser.close().catch(() => {});
                await window.page.evaluate(() => { window.Notification.permission = 'granted'; });
                await poke(window.page);
            }
        });

        await step('five at once: the newest two alone and one summary of the rest, each listed', async () => {
            const { page } = window;
            const before = (await notes(page)).length;
            for (const n of [1, 2, 3, 4, 5]) await notify({ title: `Burst ${n}`, kind: 'finished' });
            await poke(page);
            const made = await waitFor(async () => {
                const all = (await notes(page)).slice(before);
                return all.length >= 3 ? all : undefined;
            }, 'the burst to show', 30000, 300);
            await sleep(500);
            check('three notifications: Burst 4, Burst 5 and a summary of three', json(made.map((n) => n.title)) === json(['Burst 4', 'Burst 5', 'DSH: 3 more updates']) && made[2].body === 'Burst 1 · Burst 2 · Burst 3', json(made));
            const s = await waitFor(async () => {
                const now = await status();
                const burst = now.recent.filter((item) => item.title.startsWith('Burst '));
                return burst.length === 5 && burst.every((item) => item.state === 'shown') ? now : undefined;
            }, 'the burst to be reported', 20000, 300);
            const words = s.recent.filter((item) => item.title.startsWith('Burst ')).map((item) => `${item.title}: ${item.detail}`);
            check('each is listed shown, the three in one notification', words.filter((w) => w.endsWith('in one notification with others that came at once.')).length === 3, words.join('\n'));
            // A click on the summary opens the plugin's page at the recent list, with the keyboard there.
            await page.evaluate(() => window.__notes.find((n) => n.title === 'DSH: 3 more updates').onclick());
            await page.locator('[data-notifications-settings]').waitFor({ state: 'visible', timeout: 20000 });
            const at = await waitFor(async () => {
                const found = await page.evaluate(() => {
                    const title = document.querySelector('[data-notifications-recent-title]');
                    const box = title?.getBoundingClientRect();
                    return { focused: document.activeElement === title, seen: Boolean(box) && box.top >= 0 && box.bottom <= window.innerHeight };
                });
                return found.focused && found.seen ? found : undefined;
            }, 'the recent list in view', 15000, 300).catch(() => ({ focused: false, seen: false }));
            check('a click on the summary opens the plugin\'s page at the recent list, with the keyboard on it', at.focused && at.seen, json(at));
            await picture(page, 'summary-opens-recent-light');
        });


        // ── The settings page ──────────────────────────────────────────
        await step('its settings page in Plugins: switches in DSH\'s own form, where they go, the recent list with Open chat', async () => {
            const { page } = window;
            const form = await openSettings(page);
            const switches = await form.getByRole('switch').count();
            check('DSH\'s own form with the master switch and one per kind', switches === 7 && (await form.getByRole('switch', { name: 'Fleet findings' }).count()) === 1, String(switches));
            // The page reads where they go from the plugin once it opens (the row says "Reading…" until then).
            await waitFor(async () => (await page.locator('[data-notifications-where]').getAttribute('data-notifications-where')) !== 'loading', 'the page to read where they go', 15000, 200);
            const where = await page.locator('[data-notifications-where]').innerText();
            const whereExpected = desktopApp ? /\nDSH's app window is closed, so this browser tab shows them while you are not using DSH: hidden, minimised, behind other windows, or left in front for 2 minutes with nobody at it\.$/ : /\nA DSH window in your browser shows them while you are not using DSH: hidden, minimised, behind other windows, or left in front for 2 minutes with nobody at it \(one last checked in at /;
            check('where they go now, in words', whereExpected.test(where), where);
            const permission = await page.locator('[data-notifications-permission]').innerText();
            check('this window\'s permission, in words', /This window may show notifications\./.test(permission), permission);
            const recent = page.locator('[data-notifications-recent] li');
            await waitFor(async () => (await recent.count()) >= 5, 'the recent list', 15000, 300);
            const rows = await recent.allInnerTexts();
            check('the recent list: newest first, each with its time and what became of it', /^Burst 5|\n?Burst 5/.test(rows[0].split('\n').slice(1).join('\n')) && rows.some((r) => /Fix the flaky upload test/.test(r) && /Shown\. Shown on screen by DSH's window/.test(r)) && rows.some((r) => /While you use it/.test(r) && /Not shown\. You were using DSH \(its window was in front and in use\)/.test(r)), rows.slice(0, 8).join('\n---\n'));
            check('no ids, raw paths or JSON where people read', !/dsh-plugin-|\{|\bsession-[0-9a-f]{6,}|\/Users\//.test(rows.join('\n') + where + permission), rows.join(' | ').slice(0, 400));
            const hint = await page.locator('[data-notifications-recent-hint]').innerText();
            check('the list names the log file that has every one', hint.includes(`Every one is also a line in its log file, ${logFile()}.`), hint);
            const open = page.getByRole('button', { name: 'Open chat: “Fix the flaky upload test” handed back' });
            check('the one from a chat has Open chat', (await open.count()) === 1);
            await inView(page.locator('[data-notifications-settings]'));
            await picture(page, 'settings-light');
            // The master switch off (not saved yet): the kinds below it show as inactive, and say why.
            const master = form.getByRole('switch', { name: 'Send system notifications' });
            await master.click();
            const inactive = await form.locator('[data-notifications-event] [role=switch]').evaluateAll((els) => els.map((el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true'));
            const note = await page.locator('[data-notifications-kinds-off]').innerText().catch(() => '');
            check('with the master off, the six kinds are inactive and the page says they apply while it is on', inactive.length === 6 && inactive.every(Boolean) && note === 'These apply while “Send system notifications” is on.', json({ inactive, note }));
            await picture(page, 'settings-master-off-light');
            await master.click();
            const back = await form.locator('[data-notifications-event] [role=switch]').evaluateAll((els) => els.filter((el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true').length);
            check('master on again: the kinds are live again', back === 0 && (await page.locator('[data-notifications-kinds-off]').count()) === 0, String(back));
            await setDark(page, true);
            await picture(page, 'settings-dark');
            // Further down: where they go, this window, the test, and the recent list.
            await inView(page.locator('[data-notifications-recent]'));
            await picture(page, 'settings-recent-dark');
            await setDark(page, false);
            await picture(page, 'settings-recent-light');
            await open.click();
            await page.getByText('Notifications e2e: the chat a notification opens.', { exact: false }).first().waitFor({ state: 'visible', timeout: 20000 });
            check('Open chat opens it', true);
        }, async () => { if (window?.page) await picture(window.page, 'failed-settings'); });

        await step('a kind switched off and saved: the next one of that kind is "off", in words, on the page too', async () => {
            const { page } = window;
            const form = await openSettings(page);
            await form.getByRole('switch', { name: 'Fleet findings' }).click();
            await form.getByRole('button', { name: 'Save' }).click();
            await waitFor(async () => /notifyFleet:\s*false/.test(readFileSync(join(run.profile, 'cordis.patch.yml'), 'utf8')), 'the save to reach the profile', 20000, 300);
            const sent = await waitFor(async () => {
                const answer = await notify({ title: 'A3 is running hot', body: '91 °C', kind: 'fleet' });
                return answer === 'off' ? answer : undefined;
            }, 'the setting to apply', 30000, 500).catch(() => 'not off');
            const entry = await entryOf('A3 is running hot');
            check('the caller is told off, and the list says which switch', sent === 'off' && entry?.state === 'not shown' && entry.detail === '“Fleet findings” is switched off in its settings.', json({ sent, entry }));
            check('other kinds still go', (await notify({ title: 'Still on', kind: 'handback' })) === 'browser');
            check('the save applied in place: nothing restarted, the earlier ones are still listed', (await status()).recent.some((item) => item.title === 'Burst 1') && logLines().filter((line) => /^info started /.test(line)).length === 1, logLines().filter((line) => /^info started /.test(line)).join('\n'));
            check('the log says which setting changed, by its title, with its new value', logLines().some((line) => /^info settings changed: “Fleet findings” off \(notifications on; sender: window\)$/.test(line)), logLines().slice(-4).join('\n'));
        }, async () => { if (window?.page) await picture(window.page, 'failed-switch'); });

        await step('the test button shows one now, says the system showed it, and logs it', async () => {
            const { page } = window;
            await openSettings(page);
            await page.evaluate(() => { window.__watching = true; });
            const before = (await notes(page)).length;
            const button = page.getByRole('button', { name: 'Send a test notification' });
            // By keyboard, as a person tabs to it (so the focus ring is the keyboard's).
            await button.focus();
            await page.keyboard.press('Shift+Tab');
            await page.keyboard.press('Tab');
            const ring = await button.evaluate((el) => ({ focused: el === document.activeElement, style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
            check('the focused button shows DSH\'s 2px ring', ring.focused && ring.style === 'solid' && ring.width === '2px', json(ring));
            await page.keyboard.press('Enter');
            const line = page.locator('[data-notifications-test-result]');
            await waitFor(async () => /^Shown: the system reported showing it\.$/.test(await line.innerText()), 'the test line', 15000, 300);
            const made = (await notes(page)).slice(before);
            check('it shows even while you look, and the line says the system showed it', made.length === 1 && made[0].title === 'Notifications test', json(made));
            check('focus stays on the button after the test', await button.evaluate((el) => el === document.activeElement));
            const entry = await waitFor(async () => (await entryOf('Notifications test')), 'the test in the list', 15000, 300);
            check('the test is in the list and the log', entry.state === 'shown' && logLines().some((l) => l.startsWith(`info #${entry.id} (test) “Notifications test” shown`)), json(entry));
            await page.evaluate(() => { window.__watching = false; });
            await picture(page, 'settings-tested-light');
        }, async () => { if (window?.page) await picture(window.page, 'failed-test'); });

        await step('a 760 px window: the page fits without a sideways scroll, every state word readable', async () => {
            const { page } = window;
            await page.setViewportSize({ width: 760, height: 900 });
            await openSettings(page);
            const fit = await page.evaluate(() => {
                const root = document.querySelector('[data-notifications-settings]');
                const over = [...root.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'hidden' && el.clientWidth > 0).map((el) => el.className || el.tagName).slice(0, 5);
                return { width: root.getBoundingClientRect().width, scroll: root.scrollWidth, client: root.clientWidth, over };
            });
            check('no sideways scroll in the page at 760 px', fit.scroll <= fit.client + 1 && fit.over.length === 0, json(fit));
            await picture(page, 'settings-760-light');
            await setDark(page, true);
            await picture(page, 'settings-760-dark');
            await setDark(page, false);
            await page.setViewportSize({ width: 1280, height: 860 });
        }, async () => { if (window?.page) await picture(window.page, 'failed-760'); });

        await step('contrast: every text style on the page reaches 4.5:1, light and dark', async () => {
            const { page } = window;
            await openSettings(page);
            for (const dark of [false, true]) {
                await setDark(page, dark);
                const worst = await page.evaluate(() => {
                    const parse = (c) => {
                        const m = /rgba?\(([^)]+)\)/.exec(c);
                        if (!m) return null;
                        const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
                        return { r, g, b, a };
                    };
                    const lum = ({ r, g, b }) => {
                        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
                        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
                    };
                    const ground = (el) => {
                        // Layer the grounds down to an opaque one.
                        const layers = [];
                        for (let node = el; node; node = node.parentElement) {
                            const c = parse(getComputedStyle(node).backgroundColor);
                            if (c && c.a > 0) layers.push(c);
                            if (c && c.a >= 1) break;
                        }
                        let base = document.body.hasAttribute('data-ds-dark-theme') ? { r: 21, g: 21, b: 23 } : { r: 255, g: 255, b: 255 };
                        for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
                        return base;
                    };
                    const out = [];
                    for (const el of document.querySelectorAll('[data-notifications-settings] *')) {
                        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
                        if (!own || !el.getClientRects().length) continue;
                        const fg = parse(getComputedStyle(el).color);
                        if (!fg) continue;
                        const bg = ground(el);
                        const mixed = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
                        const [l1, l2] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
                        out.push({ ratio: (l1 + 0.05) / (l2 + 0.05), text: el.textContent.trim().slice(0, 40), cls: String(el.className).slice(0, 40) });
                    }
                    return out.sort((a, b) => a.ratio - b.ratio).slice(0, 3);
                });
                check(`${dark ? 'dark' : 'light'}: the lowest text contrast is 4.5:1 or more`, worst.length > 0 && worst[0].ratio >= 4.5, json(worst));
            }
            await setDark(page, false);
        });

        // ── A browser that has not answered the ask ─────────────────────
        await step('a browser that has not answered the ask: news waits, Allow asks, focus stays on the row, then the news shows', async () => {
            const asking = await openFakeWindow(pw, { fake: { startPermission: 'default', askAnswer: 'granted' } });
            try {
                // The first window must not take this one: it stays focused (looking), and the asking window is the only one in the background.
                await window.page.evaluate(() => { window.__watching = true; });
                const page = asking.page;
                await openSettings(page);
                const row = page.locator('[data-notifications-permission]');
                check('the row says the browser asks once, with an Allow button', /This browser asks you once before DSH may show notifications/.test(await row.innerText()) && (await row.getByRole('button', { name: 'Allow notifications' }).count()) === 1, await row.innerText());
                await inView(row);
                await picture(page, 'permission-ask-light');
                await row.getByRole('button', { name: 'Allow notifications' }).focus();
                await page.keyboard.press('Enter');
                await waitFor(async () => /This window may show notifications\./.test(await row.innerText()), 'the answer', 10000, 200);
                const focused = await page.evaluate(() => document.activeElement?.closest('[data-notifications-permission]') !== null);
                check('after the answer, the row says so and keeps the keyboard\'s place', focused, await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)));
            } finally {
                await asking.browser.close().catch(() => {});
                await window.page.evaluate(() => { window.__watching = false; });
            }
        }, async () => { if (window?.page) await picture(window.page, 'failed-ask'); });

        await step('a blocked tab beside a window that can show news takes nothing; two windows that can both show it show it once', async () => {
            const blocked = await openFakeWindow(pw, { fake: { startPermission: 'denied' } });
            const second = await openFakeWindow(pw);
            try {
                const ids = await Promise.all([window, blocked, second].map((w) => w.page.evaluate(() => window.__notes.length)));
                await waitFor(async () => (await status()).sender === 'window', 'the windows to check in', 30000, 300);
                // Every window looks at the queue at once: the blocked one first, then the two that can show it.
                const sent = await notify({ title: 'Beside a blocked tab', kind: 'handback' });
                for (const w of [blocked, window, second]) await poke(w.page);
                await waitFor(async () => (await entryOf('Beside a blocked tab'))?.state === 'shown', 'one window to show it', 30000, 300);
                await sleep(1500);
                for (const w of [blocked, second, window]) await poke(w.page);
                await sleep(1500);
                const counts = await Promise.all([window, blocked, second].map(async (w, n) => (await w.page.evaluate(() => window.__notes.map((x) => x.title))).slice(ids[n]).filter((title) => title === 'Beside a blocked tab').length));
                check('the blocked tab took nothing, and the news showed once in all', sent === 'browser' && counts[1] === 0 && counts[0] + counts[2] === 1, json({ sent, counts }));
                const entry = await entryOf('Beside a blocked tab');
                check('the list says shown, not blocked', entry.state === 'shown' && entry.detail === 'Shown on screen by DSH\'s window (the system reported it).', json(entry));
                // The blocked tab's page says what it does.
                await openSettings(blocked.page);
                await waitFor(async () => (await blocked.page.locator('[data-notifications-where]').getAttribute('data-notifications-where')) !== 'loading', 'the blocked tab\'s page', 15000, 200);
                const where = await blocked.page.locator('[data-notifications-where]').innerText();
                const perm = await blocked.page.locator('[data-notifications-permission]').innerText();
                check('the blocked tab\'s page says it is blocked, and how to allow them', /blocked/i.test(perm) && where.length > 0, `${where} | ${perm}`);
                await inView(blocked.page.locator('[data-notifications-permission]'));
                await picture(blocked.page, 'blocked-tab-light');
            } finally {
                await blocked.browser.close().catch(() => {});
                await second.browser.close().catch(() => {});
            }
        }, async () => { if (window?.page) await picture(window.page, 'failed-two-windows'); });

        await step('a notification that names a place opens it on a click', async () => {
            const { page } = window;
            await notify({ title: 'Opens a page', body: 'B', open: { bundle: BUNDLE } });
            await poke(page);
            await waitFor(async () => (await notes(page)).some((n) => n.title === 'Opens a page'), 'it to show', 20000, 300);
            // Away from it first: the chat.
            await page.evaluate(() => window.__notes.find((n) => n.title === '“Fix the flaky upload test” handed back').onclick());
            await page.getByText('Notifications e2e: the chat a notification opens.', { exact: false }).first().waitFor({ state: 'visible', timeout: 20000 });
            await page.evaluate(() => window.__notes.find((n) => n.title === 'Opens a page').onclick());
            await page.locator('[data-notifications-settings]').waitFor({ state: 'visible', timeout: 20000 });
            check('a click on a notification that names a plugin\'s page opens that page', true);
            const entry = await waitFor(async () => {
                const found = await entryOf('Opens a page');
                return found?.state === 'shown' ? found : undefined;
            }, 'it to be listed shown', 15000, 300);
            await waitFor(async () => (await page.getByRole('button', { name: 'Open: Opens a page' }).count()) === 1, 'its Open button', 15000, 300).catch(() => {});
            check('the list keeps the place, with an Open button', JSON.stringify(entry.open) === JSON.stringify({ bundle: BUNDLE }) && (await page.getByRole('button', { name: 'Open: Opens a page' }).count()) === 1, json(entry));
            // Fleet's findings open Fleet's page; with no Fleet here, the click still works and nothing breaks.
            await notify({ title: 'Fleet · A5 logged a GPU error', kind: 'fleet' });
            const fleet = await entryOf('Fleet · A5 logged a GPU error');
            check('Fleet\'s findings name Fleet\'s page', JSON.stringify(fleet.open) === JSON.stringify({ panel: 'fs-fleet' }), json(fleet));
            await waitFor(async () => logLines().filter((line) => /^info #\d+ clicked: DSH's window came up by itself$/.test(line)).length >= 3, 'the clicks in the log', 10000, 300).catch(() => {});
            check('each click is in the log', logLines().filter((line) => /^info #\d+ clicked: DSH's window came up by itself$/.test(line)).length >= 3, logLines().slice(-6).join('\n'));
        }, async () => { if (window?.page) await picture(window.page, 'failed-open-place'); });

        const ours = window.errors.filter((text) => /notifications/i.test(text));
        check('no errors from the plugin in the window', ours.length === 0, ours.join('\n'));
        await window.browser.close().catch(() => {});
        window = undefined;
    }

    // ── A restart with news waiting ────────────────────────────────────
    await step('a restart with news waiting: it shows once afterwards, and a reload does not show it again', async () => {
        // The window has just gone (within the 90 s a browser window counts as around), so the news queues for it.
        const sent = await notify({ title: 'Waited through a restart', kind: 'handback', sessionId });
        check('queued while a window counts as around', sent === 'browser', sent);
        await restart('a restart with news waiting');
        check('the log says what still waits after the restart', logLines().some((line) => /^info \d+ notification\(s\) still waiting for DSH's window from before the restart/.test(line)), logLines().slice(-8).join('\n'));
        const waiting = await entryOf('Waited through a restart');
        check('the list kept it, still waiting', waiting?.state === 'waiting', json(waiting));
        if (!pw) return;
        // The relaunched window comes to the front (as the app's does): nobody has touched it yet, so the news that waited shows.
        window = await openFakeWindow(pw, { fake: { startWatching: true }, dismiss: false });
        const { page } = window;
        check('the relaunched window is in front and seen', await page.evaluate(() => document.hasFocus() && document.visibilityState === 'visible'));
        await waitFor(async () => (await notes(page)).some((n) => n.title === 'Waited through a restart'), 'the waiting news to show', 30000, 300);
        await waitFor(async () => (await entryOf('Waited through a restart'))?.state === 'shown', 'it to be reported shown', 20000, 300);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(3000);
        await poke(page);
        await sleep(1500);
        const again = (await notes(page)).filter((n) => n.title === 'Waited through a restart');
        check('shown once after the restart, and not again after a reload', again.length === 0, json(again));
        await page.evaluate(() => { window.__watching = false; });
    }, async () => { if (window?.page) await picture(window.page, 'failed-restart'); });

    // ── Switched off and on from Plugins ───────────────────────────────
    await step('switched off and on from Plugins: callers get nothing while off, its sheet leaves the window, and on again it works', async () => {
        const off = await run.api('pluginManager/setBundleEnabled', { name: BUNDLE, enabled: false });
        await waitFor(async () => !(await api('status')).ok, 'the plugin to stop', 30000, 300);
        check('switched off: the caller finds no service', (await notify({ title: 'While off' })) === 'absent');
        if (window?.page) {
            await waitFor(async () => (await window.page.locator('style[data-plugin="dsh-plugin-notifications"]').count()) === 0, 'its style sheet to leave', 15000, 300).catch(() => {});
            check('its style sheet leaves the window', (await window.page.locator('style[data-plugin="dsh-plugin-notifications"]').count()) === 0);
        }
        const on = await run.api('pluginManager/setBundleEnabled', { name: BUNDLE, enabled: true });
        await waitFor(async () => (await api('status')).ok, 'the plugin to run again', 30000, 300);
        check('switched off and on (as the Plugins page does)', off.ok && on.ok, json([off, on]).slice(0, 300));
        // On again, its browser half comes back to the open window, which checks in at once.
        if (window?.page) await waitFor(async () => (await status()).sender === 'window', 'the window to check in again', 30000, 300).catch(() => {});
        const again = await notify({ title: 'On again', kind: 'handback' });
        check('on again it takes news, and nothing was added while off', (window?.page ? again === 'browser' : ['browser', 'none', 'cli'].includes(again)) && !(await status()).recent.some((item) => item.title === 'While off'), again);
        const ids = Object.fromEntries((await status()).recent.map((item) => [item.title, item.id]));
        check('ids went on counting across the restart and the switch', ids['On again'] > ids['Waited through a restart'] && ids['Waited through a restart'] > ids['No window yet'], json(ids));
        if (window?.page) {
            await waitFor(async () => (await window.page.locator('style[data-plugin="dsh-plugin-notifications"]').count()) === 1, 'its style sheet to come back', 15000, 300).catch(() => {});
            check('one style sheet of its own again', (await window.page.locator('style[data-plugin="dsh-plugin-notifications"]').count()) === 1);
        }
    }, async () => { if (window?.page) await picture(window.page, 'failed-off-on'); });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── A wrong setting ────────────────────────────────────────────────
    await step('a wrong setting in the profile: it still starts and works, the log warns, and the page names the setting', async () => {
        await restart('a wrong setting', rowsWith({ enabled: true, notifyHandback: 'no', notifyFleeet: false }));
        check('the log warns, naming the setting and what it counts as', logLines().some((line) => line.startsWith('warn a setting is wrong: “Handbacks” (notifyHandback) must be true or false, but it is "no"; it counts as on until you change it')), logLines().slice(-6).join('\n'));
        check('the log warns about the misspelt key, with the setting it meant', logLines().some((line) => line === 'warn a setting is wrong: notifyFleeet is not a setting of this plugin, so it does nothing (did you mean notifyFleet, “Fleet findings”?)'), logLines().slice(-6).join('\n'));
        const s = await status();
        check('the status names both for the page', s.problems.length === 2 && s.problems[0].key === 'notifyHandback' && s.problems[1].key === 'notifyFleeet', json(s.problems));
        const sent = await notify({ title: 'Despite a wrong setting', kind: 'handback' });
        check('it still works: news of that kind goes, as the default says', ['browser', 'none', 'cli'].includes(sent), sent);
        if (pw) {
            window = await openFakeWindow(pw);
            await openSettings(window.page);
            const problem = await window.page.locator('[data-notifications-problems]').innerText();
            check('the page names the setting, what it must be, and how to fix it', /A setting is wrong/.test(problem) && problem.includes('“Handbacks” must be true or false, but it is "no"; it counts as on until you change it. Set it with its switch above and save (in the profile its key is notifyHandback).'), problem);
            check('and the misspelt key, with the setting it meant and the fix', problem.includes('“notifyFleeet” is not a setting of this plugin, so it does nothing; did you mean “Fleet findings”? Rename it to notifyFleet in the profile\'s notifications row, or remove it.') && !problem.includes('?.'), problem);
            await inView(window.page.locator('[data-notifications-problems]'));
            await picture(window.page, 'settings-wrong-setting-light');
        }
    }, async () => { if (window?.page) await picture(window.page, 'failed-wrong-setting'); });
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
} finally {
    await window?.browser?.close().catch(() => {});
    await run.stop().catch(() => {});
    await model.close?.();
    run.cleanup();
}

console.log(`\n# ${tally.passed} passed, ${tally.failed} failed`);
if (tally.failed > 0) console.log(`# failed: ${tally.failures.join(' | ')}`);
process.exit(tally.failed > 0 ? 1 : 0);
