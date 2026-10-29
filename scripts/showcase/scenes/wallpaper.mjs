/**
 * Wallpaper: DSH's sidebar, open chat and right dock as glass over a picture
 * (an evening picture in dark, a daylight one in light), the panel with the
 * collection, and the new-chat page on the bare wall with a headline of its
 * own.
 *
 * The pictures are made here: gradients from top to bottom, no photos.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '../stage.mjs';

/** Each picture's colours from top to bottom, with their places (0 to 1). */
const PICTURES = {
    'harbor-dusk.png': [[0, '#17224a'], [0.4, '#2e4382'], [0.68, '#9a6f93'], [0.8, '#e0956a'], [1, '#3a3150']],
    'fjord-night.png': [[0, '#0b1a24'], [0.5, '#12384a'], [0.8, '#1f5f66'], [1, '#0d2229']],
    'sand-dune.png': [[0, '#fbf3e4'], [0.45, '#f1dfc0'], [0.75, '#dcb98c'], [1, '#b98f63']],
    'sea-mist.png': [[0, '#eef4f6'], [0.5, '#cfe3e8'], [0.8, '#9cc4cc'], [1, '#6f9fae']],
};

/** A 2880 × 1800 PNG of `stops`, top to bottom. */
function gradient(file, stops) {
    const parts = [];
    for (let i = 1; i < stops.length; i += 1) {
        const height = Math.round(stops[i][0] * 1800) - Math.round(stops[i - 1][0] * 1800);
        parts.push('-size', `2880x${height}`, `gradient:${stops[i - 1][1]}-${stops[i][1]}`);
    }
    execFileSync('magick', [...parts, '-append', '-depth', '8', file]);
}

export default async function wallpaper(scene) {
    const run = await scene.start({
        plugins: ['wallpaper'],
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
`,
        before: (r) => {
            const folder = join(r.home, 'wallpaper');
            const collection = join(folder, 'wallpapers', 'Gradients');
            mkdirSync(collection, { recursive: true });
            for (const [file, stops] of Object.entries(PICTURES)) gradient(join(collection, file), stops);
            // As a person left it: the collection, an evening picture kept on the wall, and a headline.
            writeFileSync(join(folder, 'state.json'), JSON.stringify({
                prefs: { wallpaperCollection: 'Gradients', wallpaperKind: 'image', wallpaperPinned: 'harbor-dusk.png', headline: 'What ships today?' },
            }));
        },
    });
    const chat = await run.newSession({ project: 'harbor-gateway', title: 'Health check path', prompt: scene.say('Add /healthz next to /status') });
    await run.idle(chat);

    const page = await scene.open({ entry: 'Plugins' });
    const row = page.locator(`[data-row-key="session:${chat}"]`).first();
    // The workspace came after the window: its folder in the session list opens to show the chat.
    if (!(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) {
        await page.locator('[data-slot="sidebar.workspaces"]').getByText('harbor-gateway', { exact: true }).first().click();
    }
    await row.click();
    await page.getByRole('button', { name: 'Open right sidebar' }).first().click();
    await page.locator('[data-slot="rightbar.session"]').first().waitFor({ state: 'visible' });

    const panel = page.locator('[role="dialog"][aria-label="Wallpaper and glass"]');
    const openPanel = async () => {
        await page.locator('[data-slot="sidebar.footer.action"] .wp-footbtn').click();
        await panel.waitFor({ state: 'visible', timeout: 20000 });
    };
    /** The picture on the wall: `file` kept, as a click on its tile in the panel keeps it, after the crossfade. */
    const keep = async (file) => {
        await openPanel();
        const name = file.replace(/\.\w+$/, '').replace(/-/g, ' ');
        const tile = panel.locator(`.wp-thumbs button[aria-label^="${name}"]`).first();
        if ((await tile.getAttribute('aria-pressed')) !== 'true') await tile.click();
        await waitFor(async () => (await tile.getAttribute('aria-pressed')) === 'true', `${name} kept`, 10000, 200);
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached', timeout: 20000 });
        await waitFor(() => page.evaluate((f) => getComputedStyle(document.querySelector('#wp-wall .wp-wl.on') ?? document.body).backgroundImage.includes(f), file), `${name} on the wall`, 20000, 200);
        await page.waitForTimeout(1600);
    };

    // The chat and the dock on glass: an evening picture in dark, a daylight one in light.
    await scene.shoot('chat', { prepare: (p, dark) => keep(dark ? 'harbor-dusk.png' : 'sand-dune.png') });

    // The panel: the colour mode, the collection's pictures with the kept one marked, and the colours.
    await scene.shoot('panel', { themes: ['light'], still: true, prepare: async (p) => { await openPanel(); await p.mouse.move(1, 899); } });
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached', timeout: 20000 });

    // The new-chat page on the bare wall, with the headline in place of DSH's words.
    await scene.shoot('new-chat', {
        themes: ['dark'],
        prepare: async (p) => {
            await keep('harbor-dusk.png');
            await p.getByRole('button', { name: 'New Session' }).first().click();
            await waitFor(() => p.evaluate(() => document.body.classList.contains('wp-headline')), 'the headline', 15000, 200);
        },
    });
}
