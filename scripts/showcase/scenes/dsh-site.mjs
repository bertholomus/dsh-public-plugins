/**
 * DSH Site: the same DSH on a phone. A device that is not signed in gets the
 * edge's sign-in page; after DSH's sign-in link it gets DSH's window, with the
 * sessions of the Mac. DSH's side is the plugin in DSH's Plugins page.
 *
 * The "phone" is a phone-width browser (390 px) on this computer: the edge
 * listens on 127.0.0.1 only, lets this Mac in (allowThisMac) and takes a
 * made-up tailnet name that only this browser maps to 127.0.0.1. Its two
 * screens are drawn side by side, and the picture says so.
 */
import { createServer } from 'node:net';
import { join } from 'node:path';
import { demoTimezone, forbiddenIn, shownText, waitFor } from '../stage.mjs';
import { dismissNotices } from '../../../test/e2e/harness.mjs';

/** The name the phone uses for the Mac: made up, and mapped to 127.0.0.1 in the phone's browser only. */
const NAME = 'dsh-mac.tailnet.example';

/** `port` when nothing listens on it here, else a free one. */
const portFor = (port) => new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
        const any = createServer();
        any.listen(0, '127.0.0.1', () => {
            const free = any.address().port;
            any.close(() => resolve(free));
        });
    });
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
});

/** A drawn page marked dark or light as DSH's window is, so the theme switch finds what it waits for. */
const MARK = `<script>const dark = matchMedia('(prefers-color-scheme: dark)'); const mark = () => document.body.toggleAttribute('data-ds-dark-theme', dark.matches); mark(); dark.addEventListener('change', mark);</script>`;

/** The phone's two screens, side by side, with what they show. */
function phones(signIn, window, dark) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
        body { background: ${dark ? '#171b22' : '#e8ecf1'}; color: ${dark ? '#e6e8eb' : '#1f2328'}; }
        .row { position: absolute; top: 34px; left: 0; right: 0; display: flex; justify-content: center; gap: 96px; }
        .phone { display: flex; flex-direction: column; align-items: center; gap: 12px; }
        .what { font-size: 14px; font-weight: 600; }
        /* Flat colours and no shadow: the picture stays small as a PNG without fewer colours. */
        .frame { padding: 10px; border-radius: 48px; background: ${dark ? '#050608' : '#15171c'}; }
        .frame img { display: block; width: 351px; height: 760px; border-radius: 38px; }
        .label { position: absolute; left: 0; right: 0; bottom: 18px; text-align: center; font-size: 13px; color: ${dark ? 'rgba(230, 232, 235, 0.7)' : 'rgba(31, 35, 40, 0.68)'}; }
    </style></head><body>${MARK}
        <div class="row">
            <div class="phone"><div class="what">Not signed in yet: the edge's page</div><div class="frame"><img src="${signIn}" alt=""></div></div>
            <div class="phone"><div class="what">After DSH's sign-in link: DSH, through the edge</div><div class="frame"><img src="${window}" alt=""></div></div>
        </div>
        <div class="label">A phone-width browser (390 px) on the Mac, with a made-up tailnet name, drawn side by side.</div>
    </body></html>`;
}

export default async function dshSite(scene) {
    const port = await portFor(18443);
    const run = await scene.start({
        plugins: ['dsh-site'],
        before: (r) => {
            r.rows = `- id: dsh-site
  config:
    listenHost: "127.0.0.1"
    listenPort: ${port}
    allowCIDRs: "127.0.0.0/8"
    allowThisMac: true
    allowHosts: ${JSON.stringify(NAME)}
    injectAuthCookie: false
    logFile: ${JSON.stringify(join(r.root, 'site.log'))}
`;
        },
    });
    const chat = await run.newSession({ project: 'harbor-gateway', title: 'Rate limits', prompt: scene.say('How many requests a minute') });
    await run.idle(chat);

    // DSH's side: the plugin in DSH's Plugins page, with the chat in the session list.
    const page = await scene.open({ entry: 'Plugins' });
    const row = page.locator(`[data-row-key="session:${chat}"]`).first();
    // The workspace came after the window: its folder in the session list opens to show the chat.
    if (!(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) {
        await page.locator('[data-slot="sidebar.workspaces"]').getByText('harbor-gateway', { exact: true }).first().click();
    }
    await row.click();
    await page.getByText('600 a minute').first().waitFor({ state: 'visible', timeout: 30000 });
    await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
    await page.getByText('DSH Site', { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
    /** The installed plugins in the middle of the page. */
    const frame = (p) => p.evaluate(() => {
        const head = [...document.querySelectorAll('div, h2, h3, p, span')].find((el) => el.childElementCount === 0 && el.textContent.trim() === 'Installed plugins');
        let box = head?.parentElement;
        while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
        if (!head || !box) return;
        box.scrollTop += head.getBoundingClientRect().top - box.getBoundingClientRect().top - 300;
    });
    await scene.shoot('plugins', { themes: ['light'], prepare: frame });

    // The phone: its own browser, where the made-up name is this Mac.
    const browser = await scene.pw.chromium.launch({
        ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
        args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-gpu-rasterization', `--host-resolver-rules=MAP ${NAME} 127.0.0.1`],
    });
    const edge = `http://${NAME}:${port}`;
    const token = new URL(run.signInLink()).search;
    /** One screen of the phone as a data URL, after a check of its words. */
    const screen = async (phone) => {
        const hits = forbiddenIn(await shownText(phone));
        if (hits.length) throw new Error(`the phone shows ${hits.map((h) => `${h.what}: ${h.match}`).join('; ')}`);
        return `data:image/png;base64,${(await phone.screenshot()).toString('base64')}`;
    };
    const drawn = await page.context().newPage();
    await drawn.setContent(`<!doctype html><body>${MARK}</body>`);
    try {
        await scene.shoot('phone', {
            page: drawn,
            prepare: async (p, dark) => {
                const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light', locale: 'en-US', timezoneId: demoTimezone() });
                try {
                    const phone = await context.newPage();
                    const first = await phone.goto(`${edge}/`, { waitUntil: 'load' });
                    if (first?.status() !== 401) throw new Error(`the edge answered ${first?.status()}, not its sign-in page`);
                    const signIn = await screen(phone);
                    await phone.goto(`${edge}/${token}`, { waitUntil: 'domcontentloaded' });
                    await phone.getByText('Into the Unknown').first().waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
                    await dismissNotices(phone);
                    // The chat from the Mac, opened from the phone's own session list.
                    await phone.getByRole('button', { name: 'Open sidebar' }).first().click();
                    const mine = phone.locator(`[data-row-key="session:${chat}"]`).first();
                    if (!(await mine.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) {
                        await phone.locator('[data-slot="sidebar.workspaces"]').getByText('harbor-gateway', { exact: true }).first().click();
                    }
                    await mine.click();
                    await phone.getByText('600 a minute').first().waitFor({ state: 'visible', timeout: 30000 });
                    // The chat on the whole screen: both side bars closed.
                    for (const name of ['Collapse sidebar', 'Collapse right sidebar']) {
                        const button = phone.getByRole('button', { name, exact: true }).first();
                        if (await button.isVisible().catch(() => false)) await button.click();
                    }
                    await phone.waitForTimeout(1200);
                    const window = await screen(phone);
                    await p.setContent(phones(signIn, window, dark), { waitUntil: 'load' });
                } finally {
                    await context.close();
                }
            },
        });
    } finally {
        await drawn.close();
        await browser.close();
    }
}
