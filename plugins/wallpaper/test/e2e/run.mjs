#!/usr/bin/env node
/**
 * Real-DSH test of Wallpaper: one DSH build (DSH_BIN, on DSH_NODE when set; scripts/e2e.mjs runs it on every build)
 * in a throwaway DSH home, with a throwaway user home for the Trash, a Fleet Shell folder to import from, and a
 * scripted model. A Chromium works the window as a person would. Each claim the README makes is checked where it
 * lands: in the window (computed styles of DSH's surfaces), in Wallpaper's files on disk, and in its routes.
 *
 *   node scripts/e2e.mjs wallpaper            (every DSH, with the live DSH's fingerprint before and after)
 *   DSH_BIN=…/bin.js node plugins/wallpaper/test/e2e/run.mjs
 *
 * KEEP=1 keeps the throwaway folders; pictures go to .shots/wallpaper/<DSH>/ (E2E_SHOTS, NO_SHOTS=1).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DshRun, checks, contrast, dshLabel, dshTarget, findPlaywright, openWindow, pluginsDir, setDark, setReducedTransparency, shot, shotsDir, waitFor,
} from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from '../../../../test/e2e/fake-model.mjs';
import { contrastAgainstDsh } from './pixels.mjs';
import { gradientPng } from './png.mjs';

const PLUGIN = 'dsh-plugin-wallpaper';
const t = checks();
const target = dshTarget();
if (!target) {
    console.log('not ok - a DSH to run (set DSH_BIN, or install one under .e2e/)');
    process.exit(1);
}
const pw = await findPlaywright();
if (!pw) {
    console.log('not ok - Playwright (playwright-core under .e2e/tools, or PLAYWRIGHT_MODULE)');
    process.exit(1);
}
const shots = shotsDir('wallpaper');
console.log(`# Wallpaper on DSH ${dshLabel()}${shots ? `; pictures in ${shots}` : ''}`);

// A user home of its own, so a picture moved to the Trash lands in this test's Trash, never the real one.
const userHome = mkdtempSync(join(tmpdir(), 'wallpaper-e2e-user-'));
mkdirSync(join(userHome, '.Trash'), { recursive: true });
const model = await startFakeModel();
// Beside it, a stand-in neighbour with a panel entry, a page and a footer button (test/e2e/neighbour).
const NEIGHBOUR = 'dsh-plugin-wallpaper-neighbour';
const run = new DshRun({ label: 'wallpaper', bin: target.bin, node: target.node, env: { ...(target.env ?? {}), HOME: userHome }, plugins: { [PLUGIN]: join(pluginsDir, 'wallpaper'), [NEIGHBOUR]: join(dirname(fileURLToPath(import.meta.url)), 'neighbour') } });
run.writeProfile({ modelPort: model.port, models: [{ id: 'fake-model', name: 'Fake Model' }] });
const patchFile = join(run.profile, 'cordis.patch.yml');
const dataDir = join(run.home, 'wallpaper');
const libDir = join(dataDir, 'wallpapers');
const stateFile = join(dataDir, 'state.json');
const saved = () => JSON.parse(readFileSync(stateFile, 'utf8'));

// Fleet Shell's folder, as the user's Mac has it: look settings among others, two pictures and a stray file.
const fleet = join(run.home, 'fleet-shell');
mkdirSync(join(fleet, 'wallpapers', 'cars'), { recursive: true });
mkdirSync(join(fleet, 'wallpapers', 'notes'), { recursive: true });
writeFileSync(join(fleet, 'wallpapers', 'cars', 'dune.png'), gradientPng(640, 360, [240, 232, 214], [196, 172, 130]));
writeFileSync(join(fleet, 'wallpapers', 'cars', 'night.png'), gradientPng(640, 360, [24, 30, 52], [8, 10, 18]));
writeFileSync(join(fleet, 'wallpapers', 'notes', 'readme.txt'), 'not a picture');
writeFileSync(join(fleet, 'state.json'), JSON.stringify({
    prefs: { headline: 'Ship it today', glassTint: 40, wallpaperCollection: 'cars', wallpaperRotate: 'daily', projectsSidebar: true, guardAutoRepair: true },
    projects: [{ id: 'p1', name: 'Security' }],
}));

/** Computed looks of DSH's surfaces, by the anchors the plugin uses (each must match exactly one element). */
const surfaces = (page) => page.evaluate(() => {
    const one = (sel) => {
        const all = document.querySelectorAll(sel);
        if (all.length !== 1) return { count: all.length };
        const c = getComputedStyle(all[0]);
        return { count: 1, bg: c.backgroundColor, blur: c.backdropFilter || c.webkitBackdropFilter, radius: c.borderTopLeftRadius };
    };
    return {
        frame: one('[data-slot="root"] > [class*="_frame"]'),
        sidebar: one('[data-slot="sidebar"] > div'),
        chat: one('[data-slot="main.conversation"] > div'),
        dock: one('[data-slot="rightbar.session"] > [class*="_panel"]'),
        composer: one('[data-slot="conversation.composer.bar"] [data-composer-card]'),
    };
});
const alphaOf = (rgba) => {
    const m = /rgba?\(([^)]+)\)/.exec(rgba ?? '');
    if (!m) return null;
    const p = m[1].split(',').map((s) => Number(s.trim()));
    return p.length === 4 ? p[3] : 1;
};
const rgbOf = (rgba) => (/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgba ?? '') ?? []).slice(1, 4).map(Number).join(',');
const near = (a, b) => a !== null && Math.abs(a - b) < 0.011;
/** `top` (rgb or rgba) laid over the opaque colour `under`, as an rgb() string. */
const over = (top, under) => {
    const [r, g, b, a = 1] = (top.match(/[\d.]+/g) ?? []).map(Number);
    const [ur, ug, ub] = (under.match(/[\d.]+/g) ?? []).map(Number);
    return `rgb(${Math.round(r * a + ur * (1 - a))}, ${Math.round(g * a + ug * (1 - a))}, ${Math.round(b * a + ub * (1 - a))})`;
};
const bodyVars = (page) => page.evaluate(() => ({
    cls: document.body.className,
    blur: document.body.style.getPropertyValue('--wp-blur'),
    tint: document.body.style.getPropertyValue('--wp-tint'),
}));
const wallImage = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#wp-wall .wp-wl.on') ?? document.body).backgroundImage);
const panel = (page) => page.locator('[role="dialog"][aria-label="Wallpaper and glass"]');
const openPanel = async (page) => {
    await page.locator('[data-slot="sidebar.footer.action"] .wp-footbtn').click();
    await panel(page).waitFor({ state: 'visible', timeout: 20000 });
};
const closePanel = async (page) => {
    await page.keyboard.press('Escape');
    await panel(page).waitFor({ state: 'detached', timeout: 20000 });
};
const noteText = async (page) => ((await page.locator('.wp-note').allTextContents()).join(' | '));
/** The picture of this state in dark too (the light one is taken first), then back to light. */
const shotDark = async (page, name) => { await setDark(page, true); await shot(page, shots, `${name}-dark`); await setDark(page, false); };

let win;
try {
    // ── First start: the one-time import ─────────────────────────────
    await run.boot('first start');
    t.check('DSH starts with the plugin loaded', run.alive());
    await t.step('first start imports Fleet Shell\'s look settings and pictures, and nothing else', async () => {
        await waitFor(() => existsSync(stateFile), 'Wallpaper\'s state.json', 30000);
        const s = saved();
        t.check('its look settings come over (headline, tint, collection; daily rotation becomes 1440 min)', s.prefs.headline === 'Ship it today' && s.prefs.glassTint === 40 && s.prefs.wallpaperCollection === 'cars' && s.prefs.wallpaperRotateMin === 1440 && s.prefs.wallpaperRotate === null, JSON.stringify(s.prefs));
        t.check('none of its other settings or data come over', !('projectsSidebar' in s.prefs) && !('guardAutoRepair' in s.prefs) && !('projects' in s), JSON.stringify(Object.keys(s)));
        t.check('its pictures are copied and the originals stay; a non-picture is not copied', existsSync(join(libDir, 'cars', 'dune.png')) && existsSync(join(libDir, 'cars', 'night.png')) && existsSync(join(fleet, 'wallpapers', 'cars', 'dune.png')) && readdirSync(join(libDir, 'notes')).length === 0);
    });

    // ── The look ─────────────────────────────────────────────────────
    win = await openWindow(run, pw, { width: 1440, height: 900, colorScheme: 'light' });
    const { page } = win;
    // A busy Mac (the test bench runs beside many others) can take more than the harness's 15 s to draw a frame of
    // the glass for a picture or a click; each action here gets 40 s.
    page.setDefaultTimeout(40000);
    await t.step('the wall shows a picture from the collection, and Wallpaper publishes its values', async () => {
        await waitFor(async () => /\/api\/wallpaper\/wallpaper\?c=cars&f=/.test(await wallImage(page)), 'a picture on the wall', 30000);
        const url = /url\("?([^")]+)"?\)/.exec(await wallImage(page))?.[1] ?? '';
        const got = await run.fetch(new URL(url).pathname + new URL(url).search);
        t.check('the wall shows a picture of the collection, served as a JPEG', got.status === 200 && String(got.headers['content-type']).startsWith('image/jpeg') && got.bytes > 1000, `${got.status} ${got.headers['content-type']} ${got.bytes}`);
        const v = await bodyVars(page);
        t.check('on <body>: wp-on, --wp-blur 22px, --wp-tint 0.4 (the imported tint), no wp-still', /\bwp-on\b/.test(v.cls) && v.blur === '22px' && v.tint === '0.4' && !/\bwp-still\b/.test(v.cls), JSON.stringify(v));
        const own = await page.evaluate(() => ({
            sheets: document.querySelectorAll('style[data-plugin="dsh-plugin-wallpaper"]').length,
            walls: document.querySelectorAll('#wp-wall').length,
            webFonts: [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => /fonts\.googleapis/.test(l.href)).length,
            privateVars: ['--wp-glass', '--wp-text', '--wp-accent', '--wp-ground'].filter((k) => getComputedStyle(document.body).getPropertyValue(k) !== ''),
        }));
        t.check('one style sheet, one wall, no web font, no private colour tokens on <body>', own.sheets === 1 && own.walls === 1 && own.webFonts === 0 && own.privateVars.length === 0, JSON.stringify(own));
    });
    await t.step('DSH\'s sidebar and composer are glass at the tint; the frame and the new-chat page stay clear', async () => {
        const s = await surfaces(page);
        t.check('each anchor finds exactly one DSH surface (frame, sidebar, open chat, right dock, composer)', ['frame', 'sidebar', 'chat', 'dock', 'composer'].every((k) => s[k].count === 1), JSON.stringify(s));
        t.check('the sidebar: light glass at the tint (.4), blurred 22px, 18px corners', rgbOf(s.sidebar.bg) === '250,250,246' && near(alphaOf(s.sidebar.bg), 0.4) && /blur\(22px\)/.test(s.sidebar.blur) && s.sidebar.radius === '18px', JSON.stringify(s.sidebar));
        t.check('the composer: glass at the tint, blurred, 22px corners', near(alphaOf(s.composer.bg), 0.4) && /blur\(22px\)/.test(s.composer.blur) && s.composer.radius === '22px', JSON.stringify(s.composer));
        t.check('the frame and the new-chat page are clear (the wall shows)', alphaOf(s.frame.bg) === 0 && alphaOf(s.chat.bg) === 0, JSON.stringify({ frame: s.frame, chat: s.chat }));
        const head = await page.evaluate(() => {
            const el = document.querySelector('[data-slot="main.conversation"] [class*="_titleGroup"] > span:first-child');
            if (!el) return null;
            const a = getComputedStyle(el, '::after');
            return { content: a.content, family: a.fontFamily, dsh: getComputedStyle(document.body).getPropertyValue('--dsw-font-family').trim(), size: getComputedStyle(el).fontSize };
        });
        t.check('the headline "Ship it today" shows over DSH\'s hero text, in DSH\'s font', head && head.content === '"Ship it today"' && head.size === '0px' && head.family.length > 0 && !/geist/i.test(head.family), JSON.stringify(head));
        await shot(page, shots, 'new-chat-light');
        await shotDark(page, 'new-chat');
    });
    await t.step('an open chat becomes a card at tint + .2; the right dock is glass while open', async () => {
        const box = page.locator('[data-slot="conversation.composer.bar"] [contenteditable="true"]').first();
        await box.click();
        await page.keyboard.type('E2E:say Glass check.');
        await page.keyboard.press('Enter');
        await waitFor(() => model.requests.length > 0, 'the model to get the message', 60000);
        await waitFor(async () => (await page.locator('[class*="_viewArea"]').count()) > 0, 'the open chat', 30000);
        await waitFor(async () => near(alphaOf((await surfaces(page)).chat.bg), 0.6), 'the open chat\'s glass', 20000).catch(() => {});
        let s = await surfaces(page);
        t.check('the open chat: glass at tint + .2 (.6), blurred', near(alphaOf(s.chat.bg), 0.6) && /blur\(22px\)/.test(s.chat.blur), JSON.stringify(s.chat));
        const dockClosed = s.dock;
        const toggle = page.getByRole('button', { name: 'Open right sidebar' }).first();
        await toggle.click();
        await waitFor(async () => near(alphaOf((await surfaces(page)).dock.bg), 0.4), 'the dock\'s glass', 20000).catch(() => {});
        s = await surfaces(page);
        t.check('the right dock: clear while closed, glass at the tint with 18px corners while open', alphaOf(dockClosed.bg) === 0 && near(alphaOf(s.dock.bg), 0.4) && s.dock.radius === '18px', JSON.stringify({ closed: dockClosed, open: s.dock }));
        await shot(page, shots, 'chat-dock-light');
        await setDark(page, true);
        s = await surfaces(page);
        t.check('dark: the glass turns dark (14,18,17 at the tint; 10,13,12 at tint + .2 for the chat)', rgbOf(s.sidebar.bg) === '14,18,17' && rgbOf(s.chat.bg) === '10,13,12', JSON.stringify({ sidebar: s.sidebar.bg, chat: s.chat.bg }));
        await shot(page, shots, 'chat-dock-dark');
        await setDark(page, false);
        await page.getByRole('button', { name: 'Collapse right sidebar' }).first().click().catch(() => {});
    });

    // ── The panel ────────────────────────────────────────────────────
    await t.step('the footer button opens DSH\'s own dialog, by keyboard too, and Escape gives the focus back', async () => {
        const btn = page.locator('[data-slot="sidebar.footer.action"] .wp-footbtn');
        t.check('one Wallpaper button in the sidebar footer, named for screen readers', (await btn.count()) === 1 && (await btn.getAttribute('aria-label')) === 'Wallpaper and glass');
        await btn.focus();
        await page.keyboard.press('Enter');
        await panel(page).waitFor({ state: 'visible', timeout: 20000 });
        const d = await page.evaluate(() => {
            const dlg = document.querySelector('[role="dialog"][aria-label="Wallpaper and glass"]');
            return { modal: dlg?.getAttribute('aria-modal'), focusIn: !!dlg?.contains(document.activeElement), heads: [...dlg.querySelectorAll('h3')].map((x) => x.textContent) };
        });
        t.check('DSH\'s Modal opens (role dialog, aria-modal) with the focus inside it', d.modal === 'true' && d.focusIn, JSON.stringify(d));
        t.check('its sections: Colour mode, Pictures, Colours, Rotate, Wallpaper and glass, Motion, Headline', ['Colour mode', 'Pictures', 'Colours', 'Wallpaper and glass', 'Motion', 'Headline'].every((x) => d.heads.includes(x)) && d.heads.some((x) => x.startsWith('Rotate')), JSON.stringify(d.heads));
        await shot(page, shots, 'panel-light');
        await closePanel(page);
        t.check('Escape closes it and the focus is back on the footer button', await page.evaluate(() => document.activeElement?.classList.contains('wp-footbtn')));
    });
    await t.step('sliders save to state.json and move the published values', async () => {
        await openPanel(page);
        const tint = page.locator('#wp-s-glassTint');
        await tint.focus();
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
        await waitFor(() => saved().prefs.glassTint === 45, 'glassTint 45 in state.json', 20000).catch(() => {});
        t.check('Glass tint by keyboard: saved as 45 and --wp-tint is 0.45', saved().prefs.glassTint === 45 && (await bodyVars(page)).tint === '0.45', JSON.stringify({ saved: saved().prefs.glassTint, ...(await bodyVars(page)) }));
        const blur = page.locator('#wp-s-glassBlur');
        await blur.focus();
        await page.keyboard.press('Home');
        await waitFor(() => saved().prefs.glassBlur === 0, 'glassBlur 0', 20000).catch(() => {});
        t.check('Glass blur to 0: saved, and --wp-blur is 0px', saved().prefs.glassBlur === 0 && (await bodyVars(page)).blur === '0px');
        await page.keyboard.press('End');
        await waitFor(() => saved().prefs.glassBlur === 40, 'glassBlur 40', 20000).catch(() => {});
        await page.keyboard.press('Home');
        for (let i = 0; i < 22; i++) await page.keyboard.press('ArrowRight');
        await waitFor(() => saved().prefs.glassBlur === 22, 'glassBlur 22', 20000).catch(() => {});
        t.check('… and back to 22', saved().prefs.glassBlur === 22);
    });
    await t.step('Motion off: wp-still, the crossfade and the page\'s transitions stop; on again restores them', async () => {
        await panel(page).getByRole('switch', { name: 'Motion' }).click();
        await waitFor(() => saved().prefs.motion === false, 'motion false', 20000).catch(() => {});
        const still = await page.evaluate(() => ({
            cls: document.body.classList.contains('wp-still'),
            wall: getComputedStyle(document.querySelector('#wp-wall .wp-wl')).transitionDuration,
            dsh: getComputedStyle(document.querySelector('[data-slot="sidebar"] button')).transitionDuration,
            after: getComputedStyle(document.querySelector('[data-slot="sidebar"] button'), '::after').transitionDuration,
        }));
        t.check('Motion off: saved, body.wp-still, the crossfade and DSH\'s transitions (pseudo-elements too) at 0s', saved().prefs.motion === false && still.cls && /^0s/.test(still.wall) && /^0s(, 0s)*$/.test(still.dsh) && /^0s(, 0s)*$/.test(still.after), JSON.stringify(still));
        await panel(page).getByRole('switch', { name: 'Motion' }).click();
        await waitFor(() => saved().prefs.motion === true, 'motion true', 20000).catch(() => {});
        const moving = await page.evaluate(() => ({ cls: document.body.classList.contains('wp-still'), wall: getComputedStyle(document.querySelector('#wp-wall .wp-wl')).transitionDuration }));
        t.check('Motion on: wp-still goes and the crossfade is 1.1s again', saved().prefs.motion === true && !moving.cls && moving.wall === '1.1s', JSON.stringify(moving));
    });
    await t.step('pictures: keep one by click, arrows move between them, rotation off and on', async () => {
        const thumbs = panel(page).locator('.wp-thumbs [data-wallpaper-rove]');
        t.check('two pictures in cars, one tab stop among them', (await thumbs.count()) === 2 && (await panel(page).locator('.wp-thumbs [tabindex="0"]').count()) === 1);
        await panel(page).locator('.wp-thumbs [tabindex="0"]').focus();
        const before = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
        await page.keyboard.press('End');
        const after = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
        await page.keyboard.press('Home');
        const home = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
        t.check('Home and End move the focus between the pictures', after === 'night' && home === 'dune', JSON.stringify({ before, after, home }));
        await thumbs.nth(1).click();
        await waitFor(() => saved().prefs.wallpaperPinned === 'night.png', 'night.png kept', 20000).catch(() => {});
        await waitFor(async () => /f=night\.png/.test(await wallImage(page)), 'night on the wall', 20000).catch(() => {});
        t.check('a click keeps that picture: saved as pinned, pressed, and on the wall', saved().prefs.wallpaperPinned === 'night.png' && (await thumbs.nth(1).getAttribute('aria-pressed')) === 'true' && /f=night\.png/.test(await wallImage(page)));
        t.check('rotation shows off while a picture is kept', (await panel(page).getByRole('switch', { name: 'Rotate' }).getAttribute('aria-checked')) === 'false');
        await panel(page).getByRole('switch', { name: 'Rotate' }).click();
        await waitFor(() => saved().prefs.wallpaperPinned === null, 'rotating again', 20000).catch(() => {});
        t.check('Rotate on: nothing kept, rotating every 24 h', saved().prefs.wallpaperPinned === null && saved().prefs.wallpaperRotate === null && (await panel(page).locator('output[for="wp-s-rotate"]').textContent()) === '24 h');
        // Rotate off keeps the picture on the wall; a click on it lets it go, and rotation comes back (the panel's words).
        await panel(page).getByRole('switch', { name: 'Rotate' }).click();
        await waitFor(() => saved().prefs.wallpaperRotate === 'off' && !!saved().prefs.wallpaperPinned, 'rotation off with the shown picture kept', 20000).catch(() => {});
        const keptNow = saved().prefs.wallpaperPinned ?? '';
        t.check('Rotate off: saved off, and the picture on the wall is kept', saved().prefs.wallpaperRotate === 'off' && !!keptNow && (await wallImage(page)).includes(`f=${keptNow}`), JSON.stringify(saved().prefs));
        await panel(page).locator(`.wp-thumbs [aria-label="${keptNow.replace(/\.\w+$/, '')}, kept"]`).click();
        await waitFor(() => saved().prefs.wallpaperPinned === null && saved().prefs.wallpaperRotate === null, 'let go and rotating', 20000).catch(() => {});
        t.check('a click on the kept picture lets it go and rotates again: saved, and the switch on', saved().prefs.wallpaperPinned === null && saved().prefs.wallpaperRotate === null && (await panel(page).getByRole('switch', { name: 'Rotate' }).getAttribute('aria-checked')) === 'true', JSON.stringify(saved().prefs));
    });
    await t.step('add a picture, make and rename a collection', async () => {
        const png = gradientPng(800, 450, [120, 170, 120], [40, 80, 50]);
        await panel(page).locator('input[type="file"].wp-file').setInputFiles({ name: 'meadow.png', mimeType: 'image/png', buffer: png });
        await waitFor(async () => /Added 1 picture to cars/.test(await noteText(page)), 'the added note', 20000).catch(() => {});
        t.check('Add pictures: "Added 1 picture to cars.", the file in the library, three pictures shown', /Added 1 picture to cars\./.test(await noteText(page)) && existsSync(join(libDir, 'cars', 'meadow.png')) && (await panel(page).locator('.wp-thumbs [data-wallpaper-rove]').count()) === 3, await noteText(page));
        await panel(page).locator('input[type="file"].wp-file').setInputFiles({ name: 'fake.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('this is a text file, not a picture at all.\n') });
        await waitFor(async () => /fake\.jpg/.test(await noteText(page)), 'the refusal', 20000).catch(() => {});
        t.check('a text file named .jpg: refused by its bytes, in words, and nothing in the library', /Nothing added: fake\.jpg isn't a JPEG, PNG, WebP or HEIC picture \(only its name is\)\./.test(await noteText(page)) && !existsSync(join(libDir, 'cars', 'fake.jpg')) && (await panel(page).locator('.wp-thumbs [data-wallpaper-rove]').count()) === 3, await noteText(page));
        const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '');
        await panel(page).getByRole('button', { name: 'New collection' }).click();
        await waitFor(async () => (await focused()) === 'New collection name', 'the new name field to take the focus', 10000).catch(() => {});
        t.check('New collection: its name field takes the focus', (await focused()) === 'New collection name', await focused());
        await page.keyboard.type('Space');
        await page.keyboard.press('Enter');
        await waitFor(async () => (await panel(page).getByRole('button', { name: 'Space (0)' }).count()) === 1, 'the Space collection', 20000).catch(() => {});
        t.check('New collection: a folder, chosen, with an empty-state line that says what to do', existsSync(join(libDir, 'Space')) && saved().prefs.wallpaperCollection === 'Space' && (await panel(page).getByRole('button', { name: 'Space (0)' }).getAttribute('aria-pressed')) === 'true' && /No pictures in Space yet/.test(await panel(page).textContent()));
        t.check('Enter puts the focus back on New collection', /New collection/.test(await focused()), await focused());
        await panel(page).getByRole('button', { name: 'Rename Space' }).click();
        await waitFor(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Collection name'), 'the name field to take the focus', 10000).catch(() => {});
        t.check('Rename: the name field takes the focus, with the old name selected', await page.evaluate(() => { const el = document.activeElement; return el?.getAttribute('aria-label') === 'Collection name' && el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value === 'Space'; }));
        await page.keyboard.type('Stars');
        await page.keyboard.press('Enter');
        await waitFor(async () => existsSync(join(libDir, 'Stars')) && saved().prefs.wallpaperCollection === 'Stars' && /Renamed Space to Stars\./.test(await noteText(page)), 'the renamed folder', 30000).catch(() => {});
        t.check('Rename: the folder and the setting follow, and the panel says so', existsSync(join(libDir, 'Stars')) && !existsSync(join(libDir, 'Space')) && saved().prefs.wallpaperCollection === 'Stars' && /Renamed Space to Stars\./.test(await noteText(page)), await noteText(page));
        await waitFor(async () => /Rename Stars/.test(await focused()), 'the focus on Rename Stars', 10000).catch(() => {});
        t.check('Enter puts the focus back on the Rename button, now "Rename Stars"', /Rename Stars/.test(await focused()), await focused());
        await panel(page).getByRole('button', { name: 'cars (3)' }).click();
        await waitFor(() => saved().prefs.wallpaperCollection === 'cars', 'cars again', 20000).catch(() => {});
    });
    await t.step('Move to the Trash asks first (Cancel first, Escape means no), then moves the picture to the Trash', async () => {
        const thumbs = panel(page).locator('.wp-thumbs [data-wallpaper-rove]');
        const names = await thumbs.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
        await thumbs.nth(names.indexOf('meadow')).click();
        await waitFor(() => saved().prefs.wallpaperPinned === 'meadow.png', 'meadow kept', 20000).catch(() => {});
        await panel(page).getByRole('button', { name: 'Move meadow to the Trash' }).click();
        const confirm = page.locator('[role="dialog"][aria-label="Move this picture to the Trash?"]');
        await confirm.waitFor({ state: 'visible', timeout: 20000 });
        await waitFor(() => page.evaluate(() => document.activeElement?.textContent === 'Cancel'), 'the focus on Cancel', 10000).catch(() => {});
        t.check('the question opens with the focus on Cancel', (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancel');
        await shot(page, shots, 'confirm-light');
        await shotDark(page, 'confirm');
        await page.keyboard.press('Escape');
        await confirm.waitFor({ state: 'detached', timeout: 20000 });
        t.check('Escape: nothing moved, and the panel is still open', existsSync(join(libDir, 'cars', 'meadow.png')) && (await panel(page).count()) === 1);
        await panel(page).getByRole('button', { name: 'Move meadow to the Trash' }).click();
        await confirm.waitFor({ state: 'visible', timeout: 20000 });
        await confirm.getByRole('button', { name: 'Move to the Trash' }).click();
        await confirm.waitFor({ state: 'detached', timeout: 20000 });
        await waitFor(async () => /Moved meadow to the Trash/.test(await noteText(page)), 'the moved note', 20000).catch(() => {});
        t.check('moved: in this test\'s Trash, gone from the library, no longer kept, and the panel says so', existsSync(join(userHome, '.Trash', 'meadow.png')) && !existsSync(join(libDir, 'cars', 'meadow.png')) && saved().prefs.wallpaperPinned === null && /Moved meadow to the Trash/.test(await noteText(page)), await noteText(page));
    });
    await t.step('a file in a collection that isn\'t a picture: marked, passed over on the wall, logged once, and the Trash takes it', async () => {
        await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { wallpaperCollection: 'cars', wallpaperKind: 'image', wallpaperPinned: 'night.png' } } });
        await closePanel(page);
        await openPanel(page);
        await waitFor(async () => /f=night\.png/.test(await wallImage(page)), 'night on the wall', 20000).catch(() => {});
        // A file put in the folder by hand, first by name: with rotation off and nothing kept, the wall would show it.
        writeFileSync(join(libDir, 'cars', 'aaa-scan.jpg'), 'this is a text file, not a picture at all.\n');
        await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { wallpaperPinned: null, wallpaperRotate: 'off' } } });
        await closePanel(page);
        await openPanel(page);
        const tile = panel(page).locator('.wp-thumbs [aria-label="aaa scan, can\'t be shown"]');
        await waitFor(async () => (await tile.count()) === 1 && /f=dune\.png/.test(await wallImage(page)), 'the tile marked and dune on the wall', 20000).catch(() => {});
        t.check('its tile says it can\'t be shown, and the Pictures section says why in words', (await tile.count()) === 1 && /aaa scan can't be shown: the window can't read it as a picture, so rotation passes over it\./.test(await noteText(page)), await noteText(page));
        t.check('the wall moves on to the next picture (not the one before), and the panel marks that one as on the wall', /f=dune\.png/.test(await wallImage(page)) && (await panel(page).locator('.wp-thumbs [aria-current="true"]').getAttribute('aria-label')) === 'dune', await wallImage(page));
        for (let i = 0; i < 3; i++) await run.fetch('/api/wallpaper/wallpaper?c=cars&f=aaa-scan.jpg');
        const lines = readFileSync(join(dataDir, 'wallpaper.log'), 'utf8').split('\n').filter((l) => l.includes('resize cars/aaa-scan.jpg failed'));
        t.check('wallpaper.log has one line for it, however often it is asked for', lines.length === 1, lines.join('\n'));
        await shot(page, shots, 'cant-show-light');
        await panel(page).getByRole('button', { name: 'Move aaa scan to the Trash' }).click();
        const confirm = page.locator('[role="dialog"][aria-label="Move this picture to the Trash?"]');
        await confirm.waitFor({ state: 'visible', timeout: 20000 });
        await confirm.getByRole('button', { name: 'Move to the Trash' }).click();
        await confirm.waitFor({ state: 'detached', timeout: 20000 });
        await waitFor(() => !existsSync(join(libDir, 'cars', 'aaa-scan.jpg')), 'the file gone', 20000).catch(() => {});
        t.check('the Move to the Trash button beside its note takes it to the Trash', !existsSync(join(libDir, 'cars', 'aaa-scan.jpg')) && existsSync(join(userHome, '.Trash', 'aaa-scan.jpg')));
        // A file fixed in the folder under the same name shows again: its address carries its modified time.
        const fixedFile = join(libDir, 'cars', 'aab-photo.jpg');
        writeFileSync(fixedFile, 'this is a text file, not a picture at all.\n');
        await closePanel(page);
        await openPanel(page);
        const fixed = panel(page).locator('.wp-thumbs [aria-label^="aab photo"]');
        await waitFor(async () => (await fixed.getAttribute('aria-label')) === 'aab photo, can\'t be shown', 'aab photo marked', 20000).catch(() => {});
        const markedFirst = (await fixed.getAttribute('aria-label')) === 'aab photo, can\'t be shown';
        writeFileSync(fixedFile, gradientPng(320, 180, [90, 140, 200], [30, 60, 110]));
        const later = new Date(Date.now() + 2000);
        utimesSync(fixedFile, later, later);
        await closePanel(page);
        await openPanel(page);
        // The tile loses its mark as soon as the panel has the file's new address; the picture loads after that.
        const tileLoaded = () => fixed.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
        await waitFor(async () => (await fixed.getAttribute('aria-label')) === 'aab photo' && await tileLoaded(), 'aab photo shown again', 30000).catch(() => {});
        const loaded = await tileLoaded();
        t.check('a file fixed in the folder under the same name shows again when the panel next opens, without a reload', markedFirst && (await fixed.getAttribute('aria-label')) === 'aab photo' && loaded, `${markedFirst} ${await fixed.getAttribute('aria-label')} ${loaded}`);
        rmSync(fixedFile);
        await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { wallpaperRotate: null } } });
        await closePanel(page);
        await openPanel(page);
    });
    await t.step('colours: a swatch colours the wall in the colour mode\'s tone', async () => {
        await panel(page).getByRole('button', { name: 'Blue' }).click();
        await waitFor(() => saved().prefs.wallpaperKind === 'colour', 'colour kind', 20000).catch(() => {});
        await waitFor(async () => /rgb\(111, 168, 247\)/.test(await wallImage(page)), 'Blue\'s light tone on the wall', 20000).catch(() => {});
        const light = await wallImage(page);
        t.check('Blue: saved, and the wall is Blue\'s light tone', saved().prefs.wallpaperKind === 'colour' && saved().prefs.wallpaperColour?.light === '#6FA8F7' && /rgb\(111, 168, 247\)/.test(light), light);
        await shot(page, shots, 'panel-colour-light');
        await setDark(page, true);
        await waitFor(async () => /rgb\(20, 49, 95\)/.test(await wallImage(page)), 'Blue\'s dark tone on the wall', 20000).catch(() => {});
        const dark = await wallImage(page);
        t.check('in dark, Blue\'s dark tone', /rgb\(20, 49, 95\)/.test(dark), dark);
        await shot(page, shots, 'panel-colour-dark');
        await setDark(page, false);
        await panel(page).getByRole('button', { name: 'cars (2)' }).click();
        await waitFor(() => saved().prefs.wallpaperKind === 'image', 'pictures again', 20000).catch(() => {});
    });
    await t.step('the headline: emptied, DSH\'s own hero text shows again', async () => {
        await panel(page).locator('#wp-headline').fill('');
        await panel(page).locator('#wp-headline').press('Enter');
        await waitFor(() => saved().prefs.headline === '', 'headline empty', 20000).catch(() => {});
        await waitFor(async () => /DSH's own headline/.test(await noteText(page)), 'the headline note', 10000).catch(() => {});
        t.check('Enter saves the headline, says so, and leaves the focus in the field', /The new chat page shows DSH's own headline\./.test(await noteText(page)) && (await page.evaluate(() => document.activeElement?.id)) === 'wp-headline', await noteText(page));
        await closePanel(page);
        await page.getByRole('button', { name: 'New Session' }).first().click().catch(() => {});
        await waitFor(async () => (await page.locator('[data-slot="main.conversation"] [class*="_titleGroup"] > span:first-child').count()) > 0, 'the new-chat page', 20000).catch(() => {});
        const hero = await page.evaluate(() => {
            const el = document.querySelector('[data-slot="main.conversation"] [class*="_titleGroup"] > span:first-child');
            return el ? { size: getComputedStyle(el).fontSize, text: el.textContent, cls: document.body.classList.contains('wp-headline') } : null;
        });
        t.check('saved empty, and DSH\'s own hero text shows (its size back, no wp-headline)', saved().prefs.headline === '' && hero && hero.size !== '0px' && !hero.cls && hero.text.length > 0, JSON.stringify(hero));
    });

    // ── Values that don't fit ────────────────────────────────────────
    await t.step('bad values sent to the settings route are refused in words, and nothing is saved', async () => {
        const before = saved().prefs;
        const bad = await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { glassTint: 'lots', motion: 'yes' } } });
        t.check('a word for a number: 400, the error names the setting and its range, nothing saved', bad.status === 400 && /glassTint must be a number from 10 to 95/.test(bad.json?.error ?? '') && /motion must be true or false/.test(bad.json?.error) && JSON.stringify(saved().prefs) === JSON.stringify(before), JSON.stringify(bad.json?.error));
        const unknown = await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { projectsSidebar: true } } });
        t.check('a setting that isn\'t Wallpaper\'s: refused', unknown.status === 400 && /not a Wallpaper setting/.test(unknown.json?.error ?? ''));
        const big = await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { glassTint: 500 } } });
        t.check('a number out of range is held to the range (500 -> 95)', big.status === 200 && saved().prefs.glassTint === 95);
        await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { glassTint: 45 } } });
        const path = await run.fetch('/api/wallpaper/wallpaper?c=..&f=..%2F..%2Fstate.json');
        t.check('a path outside the library is not served', path.status === 404);
        const log = readFileSync(join(dataDir, 'wallpaper.log'), 'utf8');
        t.check('refusals are written to wallpaper.log in words', /settings not saved: glassTint must be a number/.test(log));
    });

    await t.step('a save the disk refuses says so in the panel (a 500, not a 400), and the next save that works clears it', async () => {
        await openPanel(page);
        const statuses = [];
        const seen = (r) => { if (r.url().includes('/api/wallpaper/state') && r.request().method() === 'POST') statuses.push(r.status()); };
        page.on('response', seen);
        try {
            await panel(page).locator('#wp-s-wallpaperFrost').focus();
            chmodSync(dataDir, 0o555);
            try {
                await page.keyboard.press('ArrowRight');
                await waitFor(async () => /Couldn't save/.test(await noteText(page)), 'the note', 20000).catch(() => {});
            } finally { chmodSync(dataDir, 0o755); }
            t.check('refused by the disk: "Couldn\'t save: couldn\'t write the settings file (no permission)." in the glass section, from a 500', /Couldn't save: couldn't write the settings file \(no permission\)\./.test(await noteText(page)) && statuses.at(-1) === 500, `${statuses} ${await noteText(page)}`);
            await page.keyboard.press('ArrowLeft');
            await waitFor(async () => !/Couldn't save/.test(await noteText(page)), 'the note to clear', 20000).catch(() => {});
            t.check('the next change saves, and the note is gone', !/Couldn't save/.test(await noteText(page)) && statuses.at(-1) === 200 && saved().prefs.wallpaperFrost === 3, `${statuses} ${await noteText(page)}`);
        } finally { page.off('response', seen); }
        await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { wallpaperFrost: 4 } } });
        await closePanel(page);
    });

    // ── DSH's own words over pictures of either tone ─────────────────
    await t.step('DSH\'s own words read at the default tint over a light and a dark picture, in light and dark, on the new-chat page and in an open chat', async () => {
        const SCOPES = ['[data-slot="sidebar"]', '[data-slot="main.conversation"]', '[data-slot="rightbar.session"]'];
        const veils = () => page.evaluate(() => {
            const w = document.querySelector('#wp-wall');
            return { light: Number(w.style.getPropertyValue('--wp-veil-light') || 0), dark: Number(w.style.getPropertyValue('--wp-veil-dark') || 0), shown: Number(getComputedStyle(w.querySelector('.wp-veil')).opacity) };
        });
        const show = async (prefs, file) => {
            await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs } });
            await openPanel(page);
            await closePanel(page);
            if (file) await waitFor(async () => new RegExp(`f=${file}`).test(await wallImage(page)), `${file} on the wall`, 20000);
            await page.waitForTimeout(1500); // the crossfade and the veil's 1.1 s
        };
        const openChat = async () => {
            await page.locator('[data-slot="sidebar"]').getByText(/Glass check/).first().click();
            await waitFor(async () => (await page.locator('[class*="_viewArea"]').count()) > 0, 'the open chat', 20000);
        };
        const newChat = async () => {
            await page.getByRole('button', { name: 'New Session' }).first().click();
            await waitFor(async () => (await page.locator('[data-slot="main.conversation"] [class*="_titleGroup"]').count()) > 0, 'the new-chat page', 20000);
        };
        const read = async (label) => {
            for (const dark of [false, true]) {
                await setDark(page, dark);
                await page.waitForTimeout(1400); // the veil follows the colour mode over 1.1 s
                const mode = dark ? 'dark' : 'light';
                const c = await contrastAgainstDsh(page, SCOPES);
                const worst = [...c.rows].sort((a, b) => a.ratio / a.need - b.ratio / b.need)[0];
                t.check(`${label}, ${mode}: every run of DSH's text at 4.5:1 (3:1 large), or 80% of DSH's own where that is less (${c.rows.length} runs, lowest ${worst?.ratio} for ${worst?.need})`, c.rows.length >= 6 && c.under.length === 0, JSON.stringify(c.under.slice(0, 6)));
                await shot(page, shots, `readable-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}-${mode}`);
            }
            await setDark(page, false);
        };
        await show({ glassTint: 55, wallpaperKind: 'image', wallpaperCollection: 'cars', wallpaperPinned: 'night.png' }, 'night.png');
        const night = await veils();
        t.check('a dark picture: a veil in light mode, none in dark', night.light >= 0.5 && night.dark === 0, JSON.stringify(night));
        await newChat();
        await read('dark picture, new chat');
        await openChat();
        await page.getByRole('button', { name: 'Open right sidebar' }).first().click().catch(() => {});
        await read('dark picture, open chat');
        for (const dark of [false, true]) {
            await setDark(page, dark);
            const grounds = await page.evaluate(() => {
                const card = document.querySelector('[data-slot="conversation.composer.bar"] [data-composer-card]');
                const chat = document.querySelector('[data-slot="main.conversation"] > div');
                const painted = [];
                for (let el = card?.parentElement; el && el !== chat; el = el.parentElement) {
                    for (const pseudo of [null, '::before', '::after']) {
                        const c = getComputedStyle(el, pseudo);
                        if (pseudo && (c.content === 'none' || c.content === 'normal')) continue;
                        if (c.backgroundImage !== 'none' || !/rgba\(0, 0, 0, 0\)|transparent/.test(c.backgroundColor)) painted.push(`${String(el.className).replace(/\b\w{6}_/g, '_')}${pseudo ?? ''}: ${c.backgroundColor} ${c.backgroundImage.slice(0, 80)}`);
                    }
                }
                return { found: !!card && !!chat && chat.contains(card), painted };
            });
            t.check(`the open chat, ${dark ? 'dark' : 'light'}: nothing between the glass composer and the chat card paints a ground (no band behind the composer)`, grounds.found && grounds.painted.length === 0, JSON.stringify(grounds));
        }
        await setDark(page, false);
        await shot(page, shots, 'chat-composer-dark-picture-light');
        await page.getByRole('button', { name: 'Collapse right sidebar' }).first().click().catch(() => {});
        await show({ wallpaperPinned: 'dune.png' }, 'dune.png');
        const dune = await veils();
        t.check('a light picture: a veil in dark mode, little or none in light', dune.dark >= 0.3 && dune.light <= 0.3, JSON.stringify(dune));
        await read('light picture, open chat');
        await newChat();
        await read('light picture, new chat');
        await show({ glassTint: 80, wallpaperPinned: 'night.png' }, 'night.png');
        const thicker = await veils();
        t.check('a higher tint needs less veil (the tint stays the lever): the dark picture at 80% in light', thicker.light < night.light, JSON.stringify({ at55: night.light, at80: thicker.light }));
        await show({ glassTint: 45, wallpaperPinned: null });
    });
    await t.step('a neighbour plugin\'s panel entry, page and footer button stay where DSH puts them, work, and read', async () => {
        const entry = page.locator('[data-slot="sidebar"] nav[class*="_panelList"] button[class*="_panelRow"]', { hasText: 'Neighbour' });
        t.check('its panel entry is one of the tiles', (await entry.count()) === 1 && (await entry.evaluate((el) => getComputedStyle(el).flexDirection)) === 'column');
        await entry.click();
        const own = page.locator('[data-wallpaper-neighbour="page"]');
        await own.waitFor({ state: 'visible', timeout: 20000 });
        t.check('a click opens its page, and its tile shows it is open', (await own.isVisible()) && (await entry.getAttribute('aria-current')) === 'page');
        const foot = page.locator('[data-slot="sidebar.footer.action"] .wpn-foot');
        const beside = await page.evaluate(() => {
            const a = document.querySelector('[data-slot="sidebar.footer.action"] .wpn-foot')?.getBoundingClientRect();
            const b = document.querySelector('[data-slot="sidebar.footer.action"] .wp-footbtn')?.getBoundingClientRect();
            return a && b ? { sameRow: Math.abs(a.top - b.top) < 4, apart: Math.abs(a.left - b.left) >= 28 } : null;
        });
        await foot.click();
        t.check('its footer button sits beside Wallpaper\'s, on the same row, and a click reaches it', beside?.sameRow && beside?.apart && (await page.evaluate(() => document.body.dataset.wpnClicked)) === '1', JSON.stringify(beside));
        // Its main words over the wall at the default tint: light mode over the dark picture, dark over the light one.
        for (const [file, dark] of [['night.png', false], ['dune.png', true]]) {
            await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { glassTint: 55, wallpaperKind: 'image', wallpaperCollection: 'cars', wallpaperPinned: file } } });
            await openPanel(page);
            await closePanel(page);
            await waitFor(async () => (await wallImage(page)).includes(`f=${file}`), `${file} on the wall`, 20000).catch(() => {});
            await setDark(page, dark);
            await page.waitForTimeout(1500);
            const c = await contrastAgainstDsh(page, ['[data-wallpaper-neighbour="page"]']);
            const main = c.rows.filter((r) => !/quieter/i.test(r.text));
            const quiet = c.rows.find((r) => /quieter/i.test(r.text));
            t.check(`its page's main words, ${dark ? 'dark over the light picture' : 'light over the dark picture'}: 4.5:1 or more (lowest ${Math.min(...main.map((r) => r.ratio))})`, main.length >= 2 && main.every((r) => r.ratio >= 4.5), JSON.stringify(main));
            console.log(`# a page on the bare wall, ${dark ? 'dark over the light picture' : 'light over the dark picture'}: DSH's secondary grey at ${quiet?.ratio}:1 (DSH alone ${quiet?.own}:1); DESIGN.md's open question on DSH's own pages`);
            await shot(page, shots, `neighbour-page-${dark ? 'dark' : 'light'}`);
        }
        await setDark(page, false);
        await run.fetch('/api/wallpaper/state', { method: 'POST', body: { prefs: { glassTint: 45, wallpaperPinned: null } } });
        await page.getByRole('button', { name: 'New Session' }).first().click();
        await waitFor(async () => (await page.locator('[data-slot="main.conversation"] [class*="_titleGroup"]').count()) > 0, 'the new-chat page', 20000).catch(() => {});
    });
    await t.step('the look\'s cost while a chat streams: style work with the look and without it', async () => {
        await page.locator('[data-slot="sidebar"]').getByText(/Glass check/).first().click();
        await waitFor(async () => (await page.locator('[class*="_viewArea"]').count()) > 0, 'the open chat', 20000);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
        // A stand-in for a streaming reply: 120 words added inside the open chat, 30 a second, each followed by a read
        // of the chat card's style, so the open chat's :has() rule is asked again for every word (frame rate apart).
        const stream = () => page.evaluate(async () => {
            const host = document.querySelector('[data-slot="conversation.session"] [class*="_viewArea"]');
            const card = document.querySelector('[data-slot="main.conversation"] > div');
            const box = document.createElement('div');
            host.appendChild(box);
            for (let i = 0; i < 120; i++) {
                const w = document.createElement('span');
                w.textContent = 'word ';
                box.appendChild(w);
                void getComputedStyle(card).backgroundColor;
                await new Promise((r) => setTimeout(r, 33));
            }
            box.remove();
            return 120;
        });
        const measure = async () => {
            await page.waitForTimeout(600); // the style change before this one settles outside the measure
            const a = await metric();
            const words = await stream();
            const b = await metric();
            return { msPerWord: Number((((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000) / words).toFixed(3)), recalcs: b.RecalcStyleCount - a.RecalcStyleCount };
        };
        // With the look and without it, three times each, in turn; the lowest of each is the cost with the least noise
        // from the rest of the Mac. What counts is what the look adds to DSH's own work.
        const sheet = (on) => page.evaluate((v) => { document.querySelector('style[data-plugin="dsh-plugin-wallpaper"]').media = v ? '' : 'not all'; }, on);
        const runs = { withLook: [], alone: [] };
        try {
            for (let i = 0; i < 3; i++) {
                await sheet(true);
                runs.withLook.push(await measure());
                await sheet(false);
                runs.alone.push(await measure());
            }
        } finally { await sheet(true); }
        await cdp.detach().catch(() => {});
        const best = (list) => Math.min(...list.map((r) => r.msPerWord));
        const withLook = best(runs.withLook);
        const alone = best(runs.alone);
        const added = Number((withLook - alone).toFixed(3));
        console.log(`# style work for each word added to an open chat: ${withLook} ms with the look, ${alone} ms for DSH alone (the look adds ${added} ms)`);
        t.check(`while a chat streams, the look adds under 1 ms of style work a word to DSH's own (30 words a second: under 3% of the time): ${added} ms (${withLook} with it, ${alone} alone)`, added < 1 && [...runs.withLook, ...runs.alone].every((r) => r.recalcs >= 100), JSON.stringify(runs));
    });

    // ── The user's settings ──────────────────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-slot="sidebar"]').first().waitFor({ state: 'attached', timeout: 60000 });
    await waitFor(async () => (await bodyVars(page)).tint === '0.45', 'the saved tint after a reload', 20000).catch(() => {});
    await t.step('reduced transparency: the glass goes near-opaque (.9, the open chat .95)', async () => {
        const cdp = await setReducedTransparency(page, true);
        await page.emulateMedia({ colorScheme: 'light' });
        const s = await surfaces(page);
        t.check('the sidebar and composer at .9 or more', alphaOf(s.sidebar.bg) >= 0.899 && alphaOf(s.composer.bg) >= 0.899, JSON.stringify({ sidebar: s.sidebar.bg, composer: s.composer.bg }));
        await shot(page, shots, 'reduced-transparency-light');
        await setDark(page, true);
        const sd = await surfaces(page);
        t.check('in dark too: the sidebar and composer at .9 or more', alphaOf(sd.sidebar.bg) >= 0.899 && alphaOf(sd.composer.bg) >= 0.899, JSON.stringify({ sidebar: sd.sidebar.bg, composer: sd.composer.bg }));
        await shot(page, shots, 'reduced-transparency-dark');
        await setDark(page, false);
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
        await page.emulateMedia({ colorScheme: 'light' });
        await cdp.detach().catch(() => {});
    });
    await t.step('reduced motion: Wallpaper\'s crossfade and its own transitions stop', async () => {
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
        const m = await page.evaluate(() => ({ wall: getComputedStyle(document.querySelector('#wp-wall .wp-wl')).transitionDuration, btn: getComputedStyle(document.querySelector('.wp-footbtn')).transitionDuration, composer: (() => { const c = document.querySelector('[data-slot="conversation.composer.bar"] :is([data-composer-card],[class$="_card"],[class*="_card "])'); return c ? getComputedStyle(c).transitionDuration : 'absent'; })() }));
        t.check('crossfade, the footer button and the composer\'s glass at 0s', /^0s/.test(m.wall) && /^0s(, 0s)*$/.test(m.btn) && /^0s(, 0s)*$/.test(m.composer), JSON.stringify(m));
        await openPanel(page);
        await shot(page, shots, 'reduced-motion-panel-light');
        await shotDark(page, 'reduced-motion-panel');
        await closePanel(page);
        await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
    });
    await t.step('the panel\'s own words read at 4.5:1 or more in light and dark', async () => {
        for (const dark of [false, true]) {
            await setDark(page, dark);
            await openPanel(page);
            const c = await page.evaluate(() => {
                const dlg = document.querySelector('[role="dialog"][aria-label="Wallpaper and glass"]');
                let ground = null;
                for (let el = dlg.querySelector('.wp-meta'); el && !ground; el = el.parentElement) {
                    const bg = getComputedStyle(el).backgroundColor;
                    if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) ground = bg;
                }
                return { meta: getComputedStyle(dlg.querySelector('.wp-meta')).color, head: getComputedStyle(dlg.querySelector('.wp-h')).color, ground, body: getComputedStyle(document.body).backgroundColor };
            });
            // The dialog's ground laid over the darkest (light) or lightest (dark) wall behind it: the worst case.
            const under = dark ? 'rgb(240, 232, 214)' : 'rgb(8, 10, 18)';
            const ground = over(c.ground ?? under, under);
            const ratio = Math.min(contrast(over(c.meta, ground), ground), contrast(over(c.head, ground), ground));
            t.check(`${dark ? 'dark' : 'light'}: secondary text and headings on DSH's dialog at 4.5:1 or more`, ratio >= 4.5, `${ratio.toFixed(2)} ${JSON.stringify(c)}`);
            await shot(page, shots, `panel-${dark ? 'dark' : 'light'}`);
            await closePanel(page);
        }
        await setDark(page, false);
    });
    await t.step('760 px: no sideways scroll, DSH\'s rail keeps its glass, the panel fits', async () => {
        await page.setViewportSize({ width: 760, height: 860 });
        try {
            await waitFor(() => page.evaluate(() => !!document.querySelector('[data-slot="sidebar"] > div[class*="_collapsed"]')), 'DSH\'s rail at 760 px', 20000).catch(() => {});
            await waitFor(async () => near(alphaOf((await surfaces(page)).sidebar.bg), 0.45), 'the rail\'s glass', 10000).catch(() => {});
            const s = await surfaces(page);
            const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, rail: !!document.querySelector('[data-slot="sidebar"] > div[class*="_collapsed"]'), fold: (() => { const f = document.querySelector('.wp-tiles-fold'); return f ? getComputedStyle(f).display : 'absent'; })() }));
            t.check('no sideways scroll; the rail is glass; no fold button in the rail', fit.sw <= 760 && near(alphaOf(s.sidebar.bg), 0.45) && (fit.fold === 'none' || fit.fold === 'absent') && fit.rail, JSON.stringify({ ...fit, sidebar: s.sidebar }));
            await openPanel(page);
            const box = await panel(page).boundingBox();
            const inner = await page.evaluate(() => { const d = document.querySelector('[role="dialog"][aria-label="Wallpaper and glass"]'); return { sw: d.scrollWidth, cw: d.clientWidth }; });
            t.check('the panel fits the window with no sideways scroll inside', box && box.x >= 0 && box.x + box.width <= 760 && inner.sw <= inner.cw + 1, JSON.stringify({ box, inner }));
            await shot(page, shots, '760-panel-light');
            await shotDark(page, '760-panel');
            await closePanel(page);
            await shot(page, shots, '760-light');
            await shotDark(page, '760');
        } finally {
            // Back to light and 1440 px even when something here fails, so the steps after it see the open sidebar.
            if (await panel(page).count()) await closePanel(page).catch(() => {});
            await setDark(page, false).catch(() => {});
            await page.setViewportSize({ width: 1440, height: 900 });
            await waitFor(() => page.evaluate(() => !document.querySelector('[data-slot="sidebar"] > div[class*="_collapsed"]')), 'the open sidebar again', 20000).catch(() => {});
        }
    });
    await t.step('the panel tiles fold to a row of icons and back, and the choice holds across a reload', async () => {
        const fold = page.locator('[data-slot="sidebar"] nav[class*="_panelList"] > .wp-tiles-fold');
        t.check('one fold button, last in DSH\'s panel list, open', (await fold.count()) === 1 && (await fold.getAttribute('aria-expanded')) === 'true' && await page.evaluate(() => document.querySelector('[data-slot="sidebar"] nav[class*="_panelList"]').lastElementChild.classList.contains('wp-tiles-fold')));
        await fold.click();
        const folded = await page.evaluate(() => ({ cls: document.body.classList.contains('wp-tiles-folded'), key: localStorage.getItem('dsh-plugin-wallpaper/tiles-folded'), titles: [...document.querySelectorAll('[data-slot="sidebar"] nav[class*="_panelList"] [class*="_panelTitle"]')].map((e) => getComputedStyle(e).display) }));
        t.check('folded: names hidden, the choice kept in the window\'s storage', folded.cls && folded.key === '1' && folded.titles.every((d) => d === 'none') && (await fold.getAttribute('aria-expanded')) === 'false', JSON.stringify(folded));
        await shot(page, shots, 'tiles-folded-light');
        await shotDark(page, 'tiles-folded');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-slot="sidebar"] nav[class*="_panelList"] > .wp-tiles-fold').waitFor({ state: 'attached', timeout: 60000 });
        t.check('after a reload: still folded', await page.evaluate(() => document.body.classList.contains('wp-tiles-folded')));
        await page.locator('[data-slot="sidebar"] nav[class*="_panelList"] > .wp-tiles-fold').click();
        t.check('unfolded again', !(await page.evaluate(() => document.body.classList.contains('wp-tiles-folded'))));
    });

    // ── Off and on, and a restart ────────────────────────────────────
    await t.step('switched off: nothing of Wallpaper is left; on again: one of each, no second import', async () => {
        const importedAt = saved().imported?.at;
        writeFileSync(join(fleet, 'wallpapers', 'cars', 'late.png'), gradientPng(64, 36, [200, 200, 200], [100, 100, 100]));
        const patchBefore = readFileSync(patchFile, 'utf8');
        writeFileSync(patchFile, `${patchBefore}- id: wallpaper\n  disabled: true\n`);
        const gone = await waitFor(async () => (await page.locator('#wp-wall').count()) === 0, 'the wall to go (live)', 30000).then(() => true, () => false);
        if (!gone) {
            await run.stop();
            await run.boot('plugin off');
            await page.goto((await run.signIn()).link, { waitUntil: 'domcontentloaded' });
            await page.locator('[data-slot="sidebar"]').first().waitFor({ state: 'attached', timeout: 60000 });
        }
        const left = await page.evaluate(() => ({
            sheets: document.querySelectorAll('style[data-plugin="dsh-plugin-wallpaper"]').length,
            own: document.querySelectorAll('#wp-wall,.wp-footbtn,.wp-tiles-fold,.wp-panel').length,
            cls: [...document.body.classList].filter((c) => c.startsWith('wp-')),
            vars: ['--wp-blur', '--wp-tint', '--wp-headline'].filter((k) => document.body.style.getPropertyValue(k) !== ''),
            sidebar: getComputedStyle(document.querySelector('[data-slot="sidebar"] > div')).backdropFilter,
        }));
        t.check(`off ${gone ? '(live, no reload)' : '(after a restart)'}: no style sheet, wall, button, class or value left; DSH's sidebar unblurred`, left.sheets === 0 && left.own === 0 && left.cls.length === 0 && left.vars.length === 0 && !/blur/.test(left.sidebar), JSON.stringify(left));
        const neighbourOff = await page.evaluate(() => ({ foot: document.querySelectorAll('[data-slot="sidebar.footer.action"] .wpn-foot').length, entry: [...document.querySelectorAll('[data-slot="sidebar"] nav button')].filter((b) => /Neighbour/.test(b.textContent)).length }));
        t.check('off: the neighbour\'s footer button and panel entry are still there, one of each', neighbourOff.foot === 1 && neighbourOff.entry === 1, JSON.stringify(neighbourOff));
        await shot(page, shots, 'off-light');
        await shotDark(page, 'off');
        writeFileSync(patchFile, patchBefore);
        if (!gone) {
            await run.stop();
            await run.boot('plugin on again');
            await page.goto((await run.signIn()).link, { waitUntil: 'domcontentloaded' });
        }
        await waitFor(async () => (await page.locator('#wp-wall').count()) === 1 && (await bodyVars(page)).tint === '0.45', 'the look back with the saved tint', 60000).catch(() => {});
        const again = await page.evaluate(() => ({ sheets: document.querySelectorAll('style[data-plugin="dsh-plugin-wallpaper"]').length, walls: document.querySelectorAll('#wp-wall').length, btns: document.querySelectorAll('.wp-footbtn').length, folds: document.querySelectorAll('.wp-tiles-fold').length }));
        t.check('on again: one style sheet, one wall, one button, one fold; the saved tint', again.sheets === 1 && again.walls === 1 && again.btns === 1 && again.folds <= 1 && (await bodyVars(page)).tint === '0.45', JSON.stringify(again));
        const neighbourOn = await page.evaluate(() => ({ foot: document.querySelectorAll('[data-slot="sidebar.footer.action"] .wpn-foot').length, entry: [...document.querySelectorAll('[data-slot="sidebar"] nav button')].filter((b) => /Neighbour/.test(b.textContent)).length }));
        t.check('on again: the neighbour\'s footer button and panel entry, one of each', neighbourOn.foot === 1 && neighbourOn.entry === 1, JSON.stringify(neighbourOn));
        t.check('on again: no second import (a picture added to Fleet Shell later is not copied)', saved().imported?.at === importedAt && !existsSync(join(libDir, 'cars', 'late.png')));
    });
    await t.step('a restart of DSH brings the same look back from state.json', async () => {
        await run.stop();
        await run.boot('restart');
        await page.goto((await run.signIn()).link, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-slot="sidebar"]').first().waitFor({ state: 'attached', timeout: 90000 });
        await waitFor(async () => (await bodyVars(page)).tint === '0.45' && /f=/.test(await wallImage(page)), 'the look after the restart', 30000).catch(() => {});
        t.check('after the restart: the saved tint and a picture on the wall', (await bodyVars(page)).tint === '0.45' && /\/api\/wallpaper\/wallpaper\?c=cars&f=/.test(await wallImage(page)));
        await shot(page, shots, 'after-restart-light');
        await shotDark(page, 'after-restart');
    });

    await t.step('no errors from the plugin, in the window, in DSH\'s log or in wallpaper.log', async () => {
        const errs = win.errors.filter((e) => /wallpaper|wp-/i.test(e));
        t.check('no error from the plugin in the window', errs.length === 0, errs.join('\n'));
        const own = run.logText().split('\n').filter((l) => /wallpaper/i.test(l) && /error|fail/i.test(l));
        t.check('no error from the plugin in DSH\'s log', own.length === 0, own.join('\n'));
        // The failures this test causes on purpose: the files in cars that aren't pictures.
        const wlog = readFileSync(join(dataDir, 'wallpaper.log'), 'utf8').split('\n').filter((l) => /fail|couldn't|can't/i.test(l) && !/resize cars\/(aaa-scan|aab-photo)\.jpg failed/.test(l));
        t.check('no failure in wallpaper.log but the one this test made', wlog.length === 0, wlog.join('\n'));
    });
} catch (error) {
    t.check('the run finished', false, error?.stack ?? error);
    console.log(run.logText().slice(-2500));
} finally {
    await win?.browser.close().catch(() => {});
    await run.stop();
    await model.close();
    run.cleanup();
    if (!process.env.KEEP) rmSync(userHome, { recursive: true, force: true });
    t.summary();
    process.exit(t.failed ? 1 : 0);
}
