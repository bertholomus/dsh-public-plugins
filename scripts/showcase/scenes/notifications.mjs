/**
 * Notifications: news that finds you while DSH works on its own. Decisions
 * sends one for each new card, DSH's window in the background shows them,
 * and the plugin's page in Plugins lists what became of each.
 *
 * The window's Web Notifications are a recorder here, as in the plugin's
 * end-to-end test, so nothing reaches this computer's screen: a picture of
 * the system's banners would show this computer. The other side is drawn
 * instead, from the notifications the window showed, and says so.
 */
import { waitFor } from '../stage.mjs';

/** Web Notifications that record what they would show, and a window that nobody looks at (it is behind others). */
const RECORDER = `(() => {
    window.__notes = [];
    class RecordedNotification {
        constructor(title, options = {}) {
            this.title = title;
            this.body = options.body ?? '';
            window.__notes.push({ title: this.title, body: this.body });
            setTimeout(() => { try { this.onshow && this.onshow(); } catch (e) {} }, 50);
        }
        close() {}
        static requestPermission() { return Promise.resolve('granted'); }
    }
    RecordedNotification.permission = 'granted';
    Object.defineProperty(window, 'Notification', { value: RecordedNotification, configurable: true, writable: true });
    Document.prototype.hasFocus = function () { return false; };
})();`;

/** How many banners the drawn desktop shows: the newest, as a stack at its corner. */
const BANNERS = 3;

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The newest banners as a desktop shows them, newest first, drawn from what the window showed. */
function banners(notes, icon) {
    const items = notes.slice(-BANNERS).reverse().map((n) => `
        <div class="note"><img src="${icon}" alt=""><div class="text">
            <div class="head"><span>DeepSeek Harness</span><span>now</span></div>
            <div class="title">${escape(n.title)}</div><div class="body">${escape(n.body)}</div>
        </div></div>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
        /* Top to bottom: a vertical gradient stays small as a PNG; a diagonal one does not. */
        body { background: linear-gradient(180deg, #263864 0%, #172442 55%, #0f3036 100%); }
        .stack { position: absolute; top: 18px; right: 18px; width: 380px; display: flex; flex-direction: column; gap: 10px; }
        .note { display: flex; gap: 12px; padding: 12px 14px; border-radius: 16px; background: rgba(38, 42, 50, 0.78);
            color: #f1f3f5; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.08); }
        .note img { width: 36px; height: 36px; border-radius: 9px; flex: none; }
        .text { min-width: 0; flex: 1; }
        .head { display: flex; justify-content: space-between; font-size: 12px; color: rgba(241, 243, 245, 0.62); margin-bottom: 3px; }
        .title { font-weight: 600; font-size: 13.5px; line-height: 1.3; }
        .body { font-size: 13px; line-height: 1.38; color: rgba(241, 243, 245, 0.86); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .label { position: absolute; left: 28px; bottom: 24px; font-size: 13px; color: rgba(255, 255, 255, 0.72); }
    </style></head><body data-ds-dark-theme>
        <div class="stack">${items}</div>
        <div class="label">Drawn from the newest ${Math.min(BANNERS, notes.length)} of the ${notes.length} notifications DSH's window showed in this run. Your system draws its own banners.</div>
    </body></html>`;
}

export default async function notifications(scene) {
    const run = await scene.start({ plugins: ['session-watch', 'decisions', 'notifications'] });
    const status = () => scene.api('dsh-plugin-notifications/status');
    const shownCount = async () => ((await status()).recent ?? []).filter((r) => r.state === 'shown').length;
    const page = await scene.open({ entry: 'Plugins', init: RECORDER });
    await waitFor(async () => (await status()).sender === 'window', 'the window to take news', 60000, 300);

    // A morning's news over three projects, one at a time, so each shows alone (several at once make one summary).
    const chats = [
        ['harbor-gateway', 'Route tests', 'Check that every route'],
        ['tide-ledger', 'October import', 'Run the month-end import'],
        ['atlas-docs', 'Publish the handbook', 'Publish the handbook'],
        ['harbor-gateway', 'Rate limits', 'Check the rate limit defaults'],
        ['tide-ledger', 'Currency rounding', 'Round the October totals'],
        ['atlas-docs', 'Old wiki links', 'Check the handbook for pages'],
    ];
    for (const [i, [project, title, prompt]] of chats.entries()) {
        const id = await run.newSession({ project, title, prompt: scene.say(prompt) });
        await run.idle(id);
        await waitFor(async () => (await shownCount()) >= i + 1, `the notification for ${title}`, 60000, 300);
    }
    const shown = (await status()).recent;

    // The plugin's page in Plugins, at the recent list: what became of each.
    await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
    await page.getByRole('button', { name: 'View Notifications', exact: true }).first().click();
    const recent = page.locator('[data-notifications-recent]').first();
    await recent.waitFor({ state: 'visible' });
    await waitFor(async () => (await recent.innerText()).includes(shown[0].title), 'the recent list', 15000, 300);
    // From the note on what a click does down to the plugin's card: the switches above it and the plugin's source below are out of view.
    const frame = (p) => p.evaluate(() => {
        const list = document.querySelector('[data-notifications-recent]');
        let box = list.parentElement;
        while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
        const note = [...document.querySelectorAll('div, p, span')].find((el) => el.childElementCount === 0 && el.textContent.startsWith('A click on a notification'));
        if (!box || !note) return;
        box.scrollTop += note.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
    });
    await scene.shoot('page', { prepare: frame });

    // The other side: the banners, drawn from what the window showed, with DSH's own icon.
    const notes = await page.evaluate(() => window.__notes);
    const icon = await page.evaluate(async () => {
        const link = document.querySelector('link[rel~="icon"]')?.href;
        if (!link) return '';
        const blob = await (await fetch(link)).blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    });
    const drawn = await page.context().newPage();
    await drawn.setContent(banners(notes, icon));
    await scene.shoot('banners', { themes: ['dark'], page: drawn });
    await drawn.close();
}
