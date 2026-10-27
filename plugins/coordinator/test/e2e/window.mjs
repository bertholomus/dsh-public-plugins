#!/usr/bin/env node
/**
 * The coordinator in a real DSH's window: a Chromium signed in to DSH's web
 * window, with this repo's coordinator and session bridge and a scripted
 * model (fake-model.mjs). A chat runs /coordinate and starts three threads
 * (one hands back, one is still working, one fails); the test then looks at
 * what DSH draws for them: the Threads menu in the chat's header (by mouse
 * and by keyboard), the thread cards in the chat, the thread rows nested
 * under their chat in the session list, the Threads panel, Thread settings,
 * a thread's own header, and the plugin's page in Plugins, with a wrong
 * setting named in words. In light and dark, at 1280 and 760 px, with no
 * sideways scroll. Then the plugin is switched off in Plugins (every view,
 * mark and style of it goes) and on again (all of it back, once).
 *
 *   DSH_BIN=…/node_modules/@deepseek-ai/dsh/lib/bin.js node plugins/coordinator/test/e2e/window.mjs
 *
 * run.mjs runs it after its own checks, so `node scripts/e2e.mjs coordinator`
 * runs it on every DSH build. Pictures go to SHOTS/<DSH version> (default
 * .e2e/shots/coordinator/<version>). Without Playwright it says so and skips.
 * KEEP=1 keeps the throwaway folder.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DshRun, checks, dshBin, findPlaywright, openWindow, pluginsDir, repoRoot, setDark, shot, waitFor } from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from './fake-model.mjs';

const bin = dshBin();
const pw = bin ? await findPlaywright() : null;
if (!bin || !pw) {
    console.log(`# window: skipped (${!bin ? 'no DSH to run: set DSH_BIN' : 'no Playwright: npm i --prefix .e2e/tools playwright-core, with Playwright\'s Chromium installed'})`);
    console.log('\n0 passed, 0 failed');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
const shots = join(process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'coordinator'), version);
console.log(`# window on DSH ${version}; pictures: ${shots}`);

const tally = checks();
const { check, step } = tally;
const json = (value) => JSON.stringify(value)?.slice(0, 800);
/** The scripted model sees "E2E:call <tool> <json>" and calls that tool. */
const call = (tool, args) => `E2E:call ${tool} ${JSON.stringify(args)}`;
const BUNDLE = 'dsh-plugin-coordinator';
const CHAT = 'Release notes';
const COORDINATING = 'Coordinating. Ask for work here as usual: what runs long or splits into parts goes to threads that report back to this chat.';

const model = await startFakeModel();
const run = new DshRun({
    label: 'coordinator-window', bin,
    plugins: { [BUNDLE]: join(pluginsDir, 'coordinator'), 'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge') },
});
const state = join(run.root, 'state');
const storeFile = join(state, 'coordinator.json');
const logFile = join(state, 'coordinator.log');
/** The coordinator's row in the profile's patch: its files in the throwaway folder, and `more` (YAML, one level in). */
const rowsWith = (more = '') => `- id: coordinator
  config:
    storeFile: ${JSON.stringify(storeFile)}
    memoryDir: ${JSON.stringify(join(state, 'memory'))}
    logFile: ${JSON.stringify(logFile)}
${more}`;
const readText = (file) => {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return '';
    }
};
const store = () => {
    try {
        return JSON.parse(readFileSync(storeFile, 'utf8'));
    } catch {
        return {};
    }
};

/**
 * Rewrite only the coordinator's row in the profile's patch, as a save on its page does; DSH starts the plugin
 * again. DSH rewrites the file itself (its own rows, its line wrapping), so the row is found by its id.
 */
function rewriteRow(more = '') {
    const file = join(run.profile, 'cordis.patch.yml');
    const text = readFileSync(file, 'utf8');
    const row = /^- id: coordinator\n(?:(?!- )[^\n]*\n)*/m;
    if (!row.test(text)) throw new Error(`no coordinator row in ${file}`);
    writeFileSync(file, text.replace(row, rowsWith(more)));
    run.rows = rowsWith(more);
}
/** A picture with the pointer out of the way (a row it rests on shows DSH's hover card). */
async function snap(page, name) {
    await page.mouse.move(2, 2);
    await shot(page, shots, name);
}

async function idle(sessionId, timeout = 30000) {
    await waitFor(async () => {
        const s = await run.session(sessionId);
        return s.status === 'idle' && s.turns.started === s.turns.ended;
    }, `session ${sessionId} to be idle`, timeout);
}
/** Prompt a session as the user and wait until the model has it and the turn is over. */
async function say(sessionId, text) {
    const mark = model.requests.length;
    await run.bridge('POST', `/sessions/${encodeURIComponent(sessionId)}/prompt`, { text });
    await waitFor(() => model.requests.slice(mark).some((r) => r.fresh.includes(text)), `the model to see "${text.slice(0, 50)}"`);
    await idle(sessionId);
}
/** The chat's threads as the store keeps them: id → session id. */
const threadsOf = (chat) => Object.fromEntries(Object.entries(store().projects?.[chat]?.threads ?? {}).map(([id, t]) => [id, t.sessionId]));

let window;
const ids = {};
/** What DSH's window logged as errors, from this plugin. */
const ours = () => (window?.errors ?? []).filter((text) => /coordinator|dshp-|projects/i.test(text));
const rowOf = (page, sessionId) => page.locator(`[data-row-key="session:${sessionId}"]`).first();
const trigger = (page) => page.locator('[data-projects-threads-trigger]').filter({ visible: true }).first();
const menuOf = (page) => page.locator('[data-projects-threads-menu]');
/** Open a session in the main view from its row in the session list. */
async function openChat(page, sessionId) {
    const row = rowOf(page, sessionId);
    await row.waitFor({ state: 'visible', timeout: 30000 });
    await row.click();
    await waitFor(async () => (await page.locator(`[data-projects-thread-cards], [data-projects-threads-trigger]`).filter({ visible: true }).count()) > 0, 'the chat to show', 20000, 200).catch(() => {});
}
/** The plugin's own nodes and marks in the page, by kind. */
const leftovers = (page) => page.evaluate((bundle) => ({
    views: document.querySelectorAll('[class*="dshp-"]').length,
    marks: document.querySelectorAll('[data-projects-row],[data-projects-nests],[data-projects-nested],[data-projects-order],[data-projects-words],[data-projects-unread-row]').length,
    styles: document.querySelectorAll(`style[data-plugin="${bundle}"]`).length,
    sheets: document.querySelectorAll(`style[data-plugin-css="${bundle}/client.css"]`).length,
}), BUNDLE);
/**
 * The contrast of every text the plugin draws (its own nodes and what DSH draws inside them), against the ground
 * under it: each ancestor's background laid down to the first opaque one (DSH's page ground when none is), the
 * text's own alpha and every ancestor's opacity counted. Colours are read through a canvas, so any CSS colour form
 * counts. Large text (24 px, or 18.66 px bold) needs 3:1, the rest 4.5:1; disabled controls are left out, as WCAG does.
 * Returns the lowest ratio, how many texts were measured, and every one under its bar.
 */
const contrast = async (page) => page.evaluate(async (png) => {
    // The window as it shows now: text whose ground no ancestor paints (a layout can paint it on a layer beside the
    // text, not behind it in the tree) is measured against what the picture shows under it.
    const picture = await (async () => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const board = document.createElement('canvas');
        board.width = img.naturalWidth;
        board.height = img.naturalHeight;
        const draw = board.getContext('2d', { willReadFrequently: true });
        draw.drawImage(img, 0, 0);
        return { draw, width: board.width, height: board.height };
    })();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const paint = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (css) => {
        paint.clearRect(0, 0, 1, 1);
        paint.fillStyle = '#000';
        paint.fillStyle = css;
        paint.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: a / 255 };
    };
    const over = (top, base) => ({ r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const near = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 24;
    /** What the picture shows at the corners of the text's box (not on its letters): the most common colour there. */
    const shown = (el, text) => {
        const r = el.getClientRects()[0];
        if (!r || r.left < 0 || r.top < 0 || r.right > picture.width || r.bottom > picture.height) return null;
        const at = (x, y) => {
            const [red, green, blue] = picture.draw.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
            return { r: red, g: green, b: blue, a: 1 };
        };
        const corners = [[r.left + 1, r.top + 1], [r.right - 2, r.top + 1], [r.left + 1, r.bottom - 2], [r.right - 2, r.bottom - 2]].map(([x, y]) => at(x, y));
        const ground = corners.filter((c) => !near(c, text));
        const pool = ground.length > 0 ? ground : corners;
        return pool.map((c) => ({ c, n: pool.filter((d) => near(c, d)).length })).sort((x, y) => y.n - x.n)[0].c;
    };
    const ground = (el, text) => {
        const layers = [];
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
            const bg = rgba(getComputedStyle(node).backgroundColor);
            if (bg.a > 0) layers.push(bg);
            if (bg.a >= 1) break;
        }
        if (layers.length === 0 || layers[layers.length - 1].a < 1) return shown(el, text);
        let base = layers.pop();
        while (layers.length > 0) base = over(layers.pop(), base);
        return base;
    };
    const opacity = (el) => {
        let o = 1;
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) o *= Number(getComputedStyle(node).opacity);
        return o;
    };
    const roots = [...document.querySelectorAll('[class*="dshp-"]')];
    const seen = new Set();
    const results = [];
    let unseen = 0;
    for (const root of roots) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
            if (seen.has(el)) continue;
            seen.add(el);
            const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
            if (!own || el.getClientRects().length === 0) continue;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || el.closest('[disabled],[aria-disabled="true"]')) continue;
            const text = rgba(style.color);
            const alpha = text.a * opacity(el);
            if (alpha === 0) continue;
            const base = ground(el, text);
            // Off the picture with no ground of its own: nothing to measure it against.
            if (base === null) {
                unseen += 1;
                continue;
            }
            const fg = over({ ...text, a: alpha }, base);
            const [hi, lo] = [lum(fg), lum(base)].sort((x, y) => y - x);
            const ratio = (hi + 0.05) / (lo + 0.05);
            const size = parseFloat(style.fontSize);
            const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
            results.push({ ratio, need: large ? 3 : 4.5, text: el.textContent.trim().slice(0, 40), cls: `${el.className}`.slice(0, 50) });
        }
    }
    const low = results.filter((r) => r.ratio < r.need).map((r) => `${r.ratio.toFixed(2)} "${r.text}" (${r.cls})`);
    return { count: results.length, unseen, min: results.length ? Math.min(...results.map((r) => r.ratio)) : null, low: [...new Set(low)].slice(0, 12) };
}, (await page.screenshot({ scale: 'css' })).toString('base64'));
/** No sideways scroll in the window, and nothing of the plugin's past its right edge. */
const fits = (page) => page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('[class*="dshp-"]')]
        .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > width + 1 && getComputedStyle(el).visibility !== 'hidden')
        .map((el) => `${el.className}`.slice(0, 60));
    return { scroll: document.documentElement.scrollWidth - width, over: [...new Set(over)].slice(0, 5) };
});

try {
    run.rows = rowsWith();
    run.writeProfile(model.port);
    await run.boot('first start');

    await step('a chat coordinates and starts three threads: one hands back, one works on, one fails', async () => {
        ids.chat = await run.newSession('Hello, chat.', CHAT);
        await idle(ids.chat);
        const answer = await run.api('commands/execute', { agentId: ids.chat, line: '/coordinate', submittedAttachments: [] });
        check('/coordinate makes the chat coordinate', answer.ok && answer.value?.result?.text === COORDINATING, json(answer));
        await say(ids.chat, call('thread_start', {
            ask: 'Draft the changelog for 2.4.', title: 'Changelog draft',
            brief: `Draft it from the merged pull requests, then report. ${call('thread_handback', { status: 'done', summary: 'Drafted CHANGELOG.md for 2.4: twelve entries in three sections.' })}`,
        }));
        await waitFor(() => model.requests.some((r) => r.action.text === 'SAW-HANDBACK'), 'the chat to get the handback', 30000);
        await idle(ids.chat);
        await say(ids.chat, call('thread_start', { ask: 'Check every link in the docs.', title: 'Link check', brief: 'Check each link and list the broken ones.\nE2E:slow 900000' }));
        await say(ids.chat, call('thread_start', { ask: 'Publish the notes to the site.', title: 'Publish', brief: 'Publish them. E2E:fail' }));
        const threads = await waitFor(() => (Object.keys(threadsOf(ids.chat)).length === 3 ? threadsOf(ids.chat) : null), 'three threads in the store', 20000);
        Object.assign(ids, { done: threads.t1, working: threads.t2, failed: threads.t3 });
        await waitFor(() => /thread-failed|fail/.test(readText(logFile)) || model.requests.filter((r) => r.action.fail).length >= 2, 'the third thread to fail', 30000).catch(() => {});
        await idle(ids.chat, 60000).catch(() => {});
        check('the store has the three threads', Boolean(ids.done && ids.working && ids.failed), json(threads));
    });

    await step('the chat in the window: Threads menu in its header, thread cards in the chat, rows nested under it', async () => {
        window = await openWindow(run, pw, { width: 1280, height: 860 });
        const { page } = window;
        // DSH's first-run Preview Notice can come later than openWindow watches for (once on 0.2.0-rc.2, mid-test,
        // its mask took every click): whenever it stands in a step's way, it is put away first, as a person would.
        await page.addLocatorHandler(page.getByText('Preview Notice', { exact: true }), async () => {
            await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
        });
        await openChat(page, ids.chat);
        const button = trigger(page);
        await button.waitFor({ state: 'visible', timeout: 30000 });
        const label = await button.getAttribute('aria-label');
        check('the header has the Threads menu, named for a screen reader with what its threads are doing', /^Threads: .+/.test(label ?? '') && !/Loading/.test(label ?? ''), label);
        const cards = page.locator('[data-projects-thread-cards]').filter({ visible: true });
        await cards.first().waitFor({ state: 'visible', timeout: 20000 });
        const cardText = (await cards.allInnerTexts()).join('\n');
        check('the chat shows a card for each thread it started, by title', ['Changelog draft', 'Link check', 'Publish'].every((t) => cardText.includes(t)), cardText.slice(0, 600));
        const nested = await page.evaluate((list) => list.map((id) => Boolean(document.querySelector(`[data-projects-nests] > [data-projects-nested] [data-row-key="session:${id}"]`))), [ids.done, ids.working, ids.failed]);
        check('each thread\'s row is nested under its chat\'s row in the session list', nested.every(Boolean), json(nested));
        const fit = await fits(page);
        check('at 1280 px nothing scrolls sideways', fit.scroll <= 0 && fit.over.length === 0, json(fit));
        await snap(page, 'chat-light');
        await setDark(page, true);
        await snap(page, 'chat-dark');
        await setDark(page, false);
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-chat');
    });

    await step('the Threads menu by mouse and by keyboard: its threads by state, Escape gives focus back', async () => {
        const { page } = window;
        const button = trigger(page);
        await button.click();
        const menu = menuOf(page);
        await menu.waitFor({ state: 'visible', timeout: 10000 });
        const text = await menu.innerText();
        check('the menu lists the three threads', ['Changelog draft', 'Link check', 'Publish'].every((t) => text.includes(t)), text.slice(0, 600));
        check('the menu is a named dialog and its trigger says it is open', (await menu.getAttribute('role')) === 'dialog' && /^Threads · /.test((await menu.getAttribute('aria-label')) ?? '')
            && (await button.getAttribute('aria-expanded')) === 'true');
        await snap(page, 'menu-light');
        await setDark(page, true);
        await snap(page, 'menu-dark');
        await setDark(page, false);
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        check('Escape closes it', (await menu.count()) === 0);
        await button.focus();
        await page.keyboard.press('ArrowDown');
        await menu.waitFor({ state: 'visible', timeout: 5000 });
        const inside = await waitFor(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-projects-threads-menu]'))), 'focus in the menu', 3000, 100).catch(() => false);
        check('Arrow Down on the trigger opens it with the focus on its first item', inside === true);
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        const back = await page.evaluate(() => document.activeElement?.hasAttribute('data-projects-threads-trigger') === true);
        check('Escape from inside the menu puts the focus back on its trigger', back);
        const ring = await page.evaluate(() => {
            const el = document.activeElement;
            const s = el ? getComputedStyle(el) : null;
            return s ? `${s.boxShadow} | ${s.outlineStyle}` : '';
        });
        check('the focused trigger shows a focus ring', /inset|solid|auto/.test(ring) && !/^none \| none$/.test(ring), ring);
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-menu');
    });

    await step('at 760 px the header and the open menu still fit, with no sideways scroll', async () => {
        const { page } = window;
        await page.setViewportSize({ width: 760, height: 860 });
        await page.waitForTimeout(800);
        const button = trigger(page);
        await button.waitFor({ state: 'visible', timeout: 15000 });
        const box = await button.boundingBox();
        check('at 760 px the Threads menu is in the header, inside the window', box !== null && box.x >= 0 && box.x + box.width <= 760, json(box));
        let fit = await fits(page);
        check('at 760 px nothing scrolls sideways', fit.scroll <= 0 && fit.over.length === 0, json(fit));
        await snap(page, 'chat-760-light');
        await setDark(page, true);
        await snap(page, 'chat-760-dark');
        await setDark(page, false);
        await button.click();
        await menuOf(page).waitFor({ state: 'visible', timeout: 10000 });
        const menuBox = await menuOf(page).boundingBox();
        check('at 760 px the open menu stays inside the window', menuBox !== null && menuBox.x >= 0 && menuBox.x + menuBox.width <= 760, json(menuBox));
        fit = await fits(page);
        check('at 760 px the open menu makes nothing scroll sideways', fit.scroll <= 0, json(fit));
        await snap(page, 'menu-760-light');
        await setDark(page, true);
        await snap(page, 'menu-760-dark');
        await setDark(page, false);
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1280, height: 860 });
        await page.waitForTimeout(800);
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-760');
    });

    await step('a thread opens beside its chat; in full view its header links back to the chat', async () => {
        const { page } = window;
        await rowOf(page, ids.done).click();
        const beside = page.locator(`[data-projects-thread-chat="${ids.done}"]`).filter({ visible: true }).first();
        const opened = await beside.waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false);
        check('a thread\'s row in the session list opens it beside its chat, in the right sidebar', opened && (await trigger(page).count()) >= 1);
        await snap(page, 'beside-light');
        await setDark(page, true);
        await snap(page, 'beside-dark');
        await setDark(page, false);
        await beside.locator('[data-projects-full]').first().click();
        const parent = page.getByRole('button', { name: 'Open the chat that started this thread' }).filter({ visible: true }).first();
        await parent.waitFor({ state: 'visible', timeout: 20000 });
        check('Full view makes it the main chat, with the link back to its chat in its header', (await trigger(page).count()) >= 1);
        await snap(page, 'thread-light');
        await setDark(page, true);
        await snap(page, 'thread-dark');
        await setDark(page, false);
        await parent.click();
        const back = await waitFor(async () => (await parent.isVisible().catch(() => false)) === false, 'the chat to open', 15000, 200).catch(() => false);
        check('the link opens the chat again', back === true);
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-thread');
    });

    await step('the Threads panel and Thread settings open from the menu', async () => {
        const { page } = window;
        await trigger(page).click();
        await menuOf(page).waitFor({ state: 'visible', timeout: 10000 });
        await menuOf(page).getByRole('button', { name: 'Open the Threads panel', exact: true }).first().click();
        const pane = page.locator('[data-projects-threads-pane]').filter({ visible: true }).first();
        await pane.waitFor({ state: 'visible', timeout: 15000 });
        const paneText = await pane.innerText();
        check('the Threads panel lists the chat\'s threads', ['Changelog draft', 'Link check', 'Publish'].every((t) => paneText.includes(t)), paneText.slice(0, 500));
        await snap(page, 'pane-light');
        await setDark(page, true);
        await snap(page, 'pane-dark');
        await setDark(page, false);
        await trigger(page).click();
        await menuOf(page).waitFor({ state: 'visible', timeout: 10000 });
        await menuOf(page).getByRole('button', { name: 'Thread settings', exact: true }).first().click();
        const dialog = page.getByRole('dialog', { name: 'Thread settings', exact: true }).first();
        await dialog.waitFor({ state: 'visible', timeout: 15000 });
        await waitFor(async () => !(await dialog.innerText()).includes('Loading this chat'), 'the settings to load', 15000, 200).catch(() => {});
        const words = await dialog.innerText();
        check('Thread settings opens as a named dialog with the model and access of new threads and the chat\'s threads', /Model/i.test(words) && /Access/i.test(words)
            && ['Changelog draft', 'Link check', 'Publish'].every((t) => words.includes(t)), words.slice(0, 600));
        await snap(page, 'settings-light');
        await setDark(page, true);
        await snap(page, 'settings-dark');
        await setDark(page, false);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        check('Escape closes Thread settings', !(await dialog.isVisible().catch(() => false)));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-pane-settings');
    });

    await step('every text the plugin draws reads at 4.5:1 or better on its ground, in light and dark (the chat, its cards, the Threads menu and panel)', async () => {
        const { page } = window;
        await trigger(page).click();
        await menuOf(page).waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(300);
        for (const dark of [false, true]) {
            await setDark(page, dark);
            await page.waitForTimeout(300);
            const found = await contrast(page);
            check(`${dark ? 'dark' : 'light'}: every text of the plugin's measured (${found.count}${found.unseen ? `; ${found.unseen} off screen` : ''}) reads at 4.5:1 or better, large text at 3:1 (lowest ${found.min?.toFixed(2)})`, found.count >= 20 && found.low.length === 0, found.low.join('\n'));
        }
        await setDark(page, false);
        await page.keyboard.press('Escape');
        await menuOf(page).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-contrast');
    });

    await step('a handback that comes while the chat has stopped coordinating reads as held in the Threads menu, and arrives once it coordinates again', async () => {
        const { page } = window;
        await say(ids.chat, call('thread_start', {
            ask: 'Check the version numbers in the notes.', title: 'Version check',
            brief: `Check them, then report.\nE2E:slow 6000\n${call('thread_handback', { status: 'done', summary: 'Every version number in the notes matches 2.4.0.' })}`,
        }));
        const thread = await waitFor(() => threadsOf(ids.chat).t4, 'the fourth thread in the store', 20000);
        const stopped = await run.api('commands/execute', { agentId: ids.chat, line: '/coordinate off', submittedAttachments: [] });
        const open = Object.values(store().projects?.[ids.chat]?.threads ?? {}).filter((t) => t.resolved !== true).length;
        check('/coordinate off says how many threads stay open and how many run', stopped.ok
            && /^Stopped coordinating\. Its \d+ threads stay open \((\d+|all|none) running\); what they hand back waits until you run \/coordinate here again\.$/.test(stopped.value?.result?.text ?? '')
            && stopped.value.result.text.includes(`Its ${open} threads`), json(stopped));
        await waitFor(() => (store().projects?.[ids.chat]?.pendingHandbacks?.length ?? 0) === 1, 'the handback to be held', 40000);
        await idle(thread, 30000).catch(() => {});
        await openChat(page, ids.chat);
        await trigger(page).click();
        const menu = menuOf(page);
        await menu.waitFor({ state: 'visible', timeout: 10000 });
        const line = await waitFor(async () => {
            const text = await menu.innerText().catch(() => '');
            return text.includes('Done · held until you coordinate again') ? text : null;
        }, 'the held handback in the menu', 40000, 500).catch(async () => menu.innerText().catch(() => ''));
        check('its row reads "Done · held until you coordinate again" under Done, not "No handback yet"', /Done · held until you coordinate again/.test(line) && !/Version check[^\n]*\n[^\n]*No handback yet/.test(line), line.slice(0, 700));
        await snap(page, 'stopped-held-light');
        await setDark(page, true);
        await snap(page, 'stopped-held-dark');
        await setDark(page, false);
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        const mark = model.requests.length;
        const again = await run.api('commands/execute', { agentId: ids.chat, line: '/coordinate', submittedAttachments: [] });
        await waitFor(() => model.requests.slice(mark).some((r) => r.action.text === 'SAW-HANDBACK' && r.fresh.includes('Every version number in the notes matches 2.4.0.')), 'the held handback to reach the chat', 30000);
        await idle(ids.chat, 30000).catch(() => {});
        await trigger(page).click();
        await menu.waitFor({ state: 'visible', timeout: 10000 });
        const after = await waitFor(async () => {
            const text = await menu.innerText().catch(() => '');
            return text.includes('Every version number in the notes matches 2.4.0.') && !text.includes('held until') ? text : null;
        }, 'the delivered handback in the menu', 30000, 500).catch(async () => menu.innerText().catch(() => ''));
        check('/coordinate again delivers it, and its row reads the handback itself', again.ok && again.value?.result?.text === COORDINATING
            && after.includes('Every version number in the notes matches 2.4.0.') && !after.includes('held until'), after.slice(0, 700));
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-stopped-held');
    });

    await step('the plugin\'s page in Plugins: its defaults, and a wrong setting named in words', async () => {
        const { page } = window;
        const openPage = async () => {
            await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
            const card = page.getByText('Coordinator', { exact: true }).filter({ visible: true }).first();
            await card.waitFor({ state: 'visible', timeout: 30000 });
            await card.click();
            const form = page.locator('[data-projects-defaults]');
            await form.waitFor({ state: 'visible', timeout: 30000 });
            return form;
        };
        let form = await openPage();
        check('the page shows the defaults for new threads, with nothing to fix', (await form.locator('[data-projects-problems]').count()) === 0);
        await snap(page, 'plugin-page-light');
        await setDark(page, true);
        await snap(page, 'plugin-page-dark');
        await setDark(page, false);
        rewriteRow('    maxHandbacksPerHour: 0\n');
        const problems = page.locator('[data-projects-problems]');
        const shown = await waitFor(async () => {
            if (await problems.count()) return true;
            form = await openPage().catch(() => form);
            return (await problems.count()) > 0;
        }, 'the page to name the wrong setting', 45000, 1500).catch(() => false);
        const said = shown ? await problems.innerText() : '';
        check('a wrong setting shows on the page in words: what it must be and what the plugin uses meanwhile', shown
            && said.includes('maxHandbacksPerHour must be a whole number of handbacks from 1 to 1000 (it is 0), so the plugin uses 30 until you fix it.')
            && said.includes('cordis.patch.yml'), said.slice(0, 500));
        await snap(page, 'plugin-page-problem-light');
        for (const dark of [false, true]) {
            await setDark(page, dark);
            await page.waitForTimeout(300);
            const found = await contrast(page);
            check(`the plugin's page with a problem, ${dark ? 'dark' : 'light'}: every text of the plugin's measured (${found.count}) reads at 4.5:1 or better (lowest ${found.min?.toFixed(2)})`, found.count >= 5 && found.low.length === 0, found.low.join('\n'));
        }
        await snap(page, 'plugin-page-problem-dark');
        await setDark(page, false);
        rewriteRow();
        const cleared = await waitFor(async () => {
            if ((await problems.count()) === 0) return true;
            await openPage().catch(() => {});
            return (await problems.count()) === 0;
        }, 'the page with nothing to fix', 45000, 1500).catch(() => false);
        check('put right, the page has nothing to fix again', cleared === true);
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-plugin-page');
    });

    await step('switched off in Plugins it leaves nothing behind; switched on again it is all back, once', async () => {
        const { page } = window;
        await openChat(page, ids.chat);
        await trigger(page).waitFor({ state: 'visible', timeout: 30000 });
        // A thread open beside the chat, so switching off has one of its tabs to close.
        await rowOf(page, ids.done).click();
        const besideOpen = await page.locator(`[data-projects-thread-chat="${ids.done}"]`).filter({ visible: true }).first()
            .waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false);
        await openChat(page, ids.chat);
        await page.waitForTimeout(500);
        const on = await leftovers(page);
        check('while on: its views, its marks on the session list and its one style sheet', on.views > 0 && on.marks > 0 && on.sheets === 1, json(on));
        const off = await run.api('pluginManager/setBundleEnabled', { name: BUNDLE, enabled: false });
        check('switched off, DSH reports it applied, with no failure', off.ok === true && !off.value?.error, json(off));
        const gone = await waitFor(async () => {
            const left = await leftovers(page);
            return left.views === 0 && left.marks === 0 && left.styles === 0 ? left : null;
        }, 'the plugin\'s views, marks and styles to go', 30000, 300).catch(async () => leftovers(page));
        check('switched off, no view, mark or style of it is left in the window', gone.views === 0 && gone.marks === 0 && gone.styles === 0, json(gone));
        // Round-1 finding 8: its thread tab beside the chat closed, so no tab is left that nothing can show.
        const dead = await page.getByText('Nothing here can view this kind of content yet').filter({ visible: true }).count();
        check('switched off, the thread tab beside the chat closes instead of reading "Nothing here can view this kind of content yet"', besideOpen && dead === 0, `beside open before: ${besideOpen}; dead tabs: ${dead}`);
        await snap(page, 'off-light');
        await setDark(page, true);
        await snap(page, 'off-dark');
        await setDark(page, false);
        const back = await run.api('pluginManager/setBundleEnabled', { name: BUNDLE, enabled: true });
        check('switched on again, DSH reports it applied, with no failure', back.ok === true && !back.value?.error, json(back));
        await trigger(page).waitFor({ state: 'visible', timeout: 45000 });
        const again = await waitFor(async () => {
            const left = await leftovers(page);
            return left.marks > 0 && left.sheets === 1 ? left : null;
        }, 'the plugin\'s views and marks to come back', 30000, 300).catch(async () => leftovers(page));
        check('switched on again, its menu, cards and nesting are back, with one style sheet', again.views > 0 && again.marks > 0 && again.sheets === 1, json(again));
        const nested = await page.evaluate((id) => Boolean(document.querySelector(`[data-projects-nests] > [data-projects-nested] [data-row-key="session:${id}"]`)), ids.done);
        check('and the thread rows are nested under their chat again', nested);
        await snap(page, 'on-again-light');
        await setDark(page, true);
        await snap(page, 'on-again-dark');
        await setDark(page, false);
        check('no errors from the plugin in the window', ours().length === 0, ours().join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-off-on');
    });
} catch (error) {
    check(`the window test ran to its end (${error.message})`, false, error.stack);
    console.log('--- dsh.log (tail)');
    console.log(run.logText().split('\n').slice(-30).join('\n'));
} finally {
    await window?.browser?.close().catch(() => {});
    await run.stop().catch(() => {});
    await model.close().catch(() => {});
    run.cleanup();
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
