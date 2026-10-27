#!/usr/bin/env node
/**
 * Real-DSH test of the Reasoning pill: one DSH build (DSH_BIN, on DSH_NODE when set; scripts/e2e.mjs runs it on
 * every build) in a throwaway home, with a scripted model (./model.mjs) that has reasoning levels, one that has none
 * and one with two levels, and that can start a subagent. A Chromium drives the window as a person would: the new
 * chat, then an open chat (the menu's place, a second click, a click in the message box with the menu open, DSH's
 * model button with the menu open), two chats switched back and forth, a subagent's chat, and last DSH's host gone
 * and back. Each claim the README makes is checked where it lands: in the window, in the request DSH sends the
 * model, and in the session's own log on disk.
 *
 *   node scripts/e2e.mjs reasoning-pill            (every DSH, with the live DSH's fingerprint before and after)
 *   DSH_BIN=…/bin.js node plugins/reasoning-pill/test/e2e/run.mjs
 *
 * KEEP=1 keeps the throwaway folder; pictures go to .shots/reasoning-pill/<DSH>/ (E2E_SHOTS, NO_SHOTS=1).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    DshRun, checks, contrast, dshLabel, dshTarget, findPlaywright, openWindow, pluginsDir, setDark, setReducedTransparency, shot, shotsDir, waitFor,
} from '../../../../test/e2e/harness.mjs';
import { startModel } from './model.mjs';

const PLUGIN = 'dsh-plugin-reasoning-pill';
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
const shots = shotsDir('reasoning-pill');
console.log(`# Reasoning pill on DSH ${dshLabel()}${shots ? `; pictures in ${shots}` : ''}`);

const model = await startModel();
const MODELS = [
    { id: 'think-model', name: 'Think Model', efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
    { id: 'plain-model', name: 'Plain Model' },
    { id: 'hm-model', name: 'High Max Model', efforts: { high: 'high', max: 'max' } },
];
const run = new DshRun({ label: 'reasoning-pill', bin: target.bin, node: target.node, env: target.env, plugins: { [PLUGIN]: join(pluginsDir, 'reasoning-pill') } });
run.writeProfile({ modelPort: model.port, models: MODELS });
const patchFile = join(run.profile, 'cordis.patch.yml');

const pill = (page) => page.locator('[data-slot="conversation.composer.bar"] .rp-trigger');
const pillText = async (page) => ((await pill(page).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
/** The turn's request (it offers DSH's tools; a title request for the same words does not). */
const requestFor = (text) => model.requests.find((r) => r.text.includes(text) && r.tools.length > 0) ?? model.requests.find((r) => r.text.includes(text));
const box = (page) => page.locator('[data-slot="conversation.composer.bar"] [contenteditable="true"]').first();
const modelButton = (page) => page.locator('[data-slot="conversation.input.model"] button').first();
/** Whether DSH's own model menu (its rows carry DSH's cell labels) is open. */
const dshMenuOpen = (page) => page.evaluate(() => [...document.querySelectorAll('[role="menu"]')].some((m) => m.querySelector('[class*="_cellLabel"]') && m.getClientRects().length > 0));
const rect = (page, selector) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null; }, selector);
const overlaps = (a, b) => Boolean(a && b) && a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
/** Open a chat from DSH's session list by its title. */
const openChat = async (page, title) => {
    const list = page.locator('[data-slot="sidebar"]');
    const exact = list.getByText(title, { exact: true });
    await ((await exact.count()) ? exact : list.getByText(title)).first().click();
    await waitFor(async () => (await page.title()).includes(title), `the chat "${title}"`, 15000);
    await waitFor(async () => (await pill(page).count()) === 1 && (await pillText(page)).length > 0, 'the control in that chat', 15000);
    await page.waitForTimeout(500);
};
/**
 * Pick a level with the pointer, and wait until the control shows it. In a chat DSH has just opened, DSH can still
 * redraw the composer for a moment, taking the open menu with it; then open it again, as a person would (logged).
 */
const pickLevel = async (page, name) => {
    for (let attempt = 1; ; attempt++) {
        if (!(await pillMenu(page).isVisible().catch(() => false))) {
            await pill(page).click();
            await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        }
        const mark = await pill(page).evaluate((el) => { el.dataset.e2eSeen = '1'; return true; }).catch(() => false);
        const item = pillMenu(page).locator('[role^="menuitem"]').filter({ hasText: new RegExp(`^${name}`) }).first();
        if (await item.click({ timeout: 4000 }).then(() => true, () => false)) break;
        const after = await page.evaluate(() => { const el = document.querySelector('[data-slot="conversation.composer.bar"] .rp-trigger'); return { control: el ? el.textContent.trim() : null, sameControl: el?.dataset.e2eSeen === '1', menuOpen: Boolean(document.querySelector('.rp-menu')) }; });
        console.log(`# the menu went before the pick of ${name} (try ${attempt}, marked ${mark}): ${JSON.stringify(after)}`);
        if (attempt >= 3) throw new Error(`could not pick ${name}: the menu went ${attempt} times`);
        await page.waitForTimeout(500);
    }
    await waitFor(async () => (await pillText(page)) === `Reasoning: ${name}` && (await pill(page).getAttribute('aria-busy')) === null, `the control to read ${name}`, 10000);
};
/** The model selections in a session's own log: every record that carries a provider/model selection. */
const selectionsIn = (sessionId) => {
    const out = [];
    const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        if (typeof v.provider === 'string' && typeof v.model === 'string' && ('reasoningEffort' in v || v.model.endsWith('-model'))) out.push({ provider: v.provider, model: v.model, effort: v.reasoningEffort ?? null });
        for (const k of Object.keys(v)) walk(v[k]);
    };
    for (const e of run.savedEvents(sessionId)) walk(e);
    return out;
};
const send = async (page, text) => {
    const box = page.locator('[data-slot="conversation.composer.bar"] [contenteditable="true"]').first();
    await box.click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await waitFor(() => requestFor(text), `the model to get "${text}"`, 60000).catch(async (error) => {
        await shot(page, shots, `failed-send-${text.replace(/\W+/g, '-')}`);
        throw new Error(`${error.message}; requests: ${JSON.stringify(model.requests.map((r) => r.text.slice(-80)))}`);
    });
};
/** DSH's own menu for the pill (DSH's Menu part draws it in the page's body). */
const pillMenu = (page) => page.locator('.rp-menu');
const menuItems = async (page) => pillMenu(page).locator('[role^="menuitem"]').evaluateAll((els) => els.map((e) => ({ text: e.textContent.trim(), checked: e.getAttribute('aria-checked'), selected: e.getAttribute('aria-selected'), focused: e === document.activeElement })));

let win;
try {
    await run.boot('first start');
    t.check('DSH starts with the plugin loaded', run.alive());

    // ── The new-chat composer ─────────────────────────────────────────
    win = await openWindow(run, pw, { width: 1280, height: 860, colorScheme: 'light' });
    const { page } = win;
    await t.step('the control shows in the new-chat composer, just before the model button, as one control', async () => {
        await waitFor(async () => (await pill(page).count()) === 1 && (await pillText(page)).length > 0, 'the control', 30000);
        t.check('one Reasoning control in the composer (no second copy)', (await page.locator('.rp-root').count()) === 1);
        t.check('it reads "Reasoning: Default" for a model with levels and no default of its own', (await pillText(page)) === 'Reasoning: Default', await pillText(page));
        const place = await page.evaluate(() => {
            const m = document.querySelector('[data-slot="conversation.input.model"] button').getBoundingClientRect();
            const p = document.querySelector('.rp-trigger').getBoundingClientRect();
            return { modelLeft: m.left, pillRight: p.right, dy: Math.abs((m.top + m.bottom) / 2 - (p.top + p.bottom) / 2) };
        });
        t.check('it sits just before the model button on the same line', place.pillRight <= place.modelLeft && place.modelLeft - place.pillRight <= 16 && place.dy <= 2, JSON.stringify(place));
        const looks = await page.evaluate(() => {
            const s = (el) => { const c = getComputedStyle(el); return { size: c.fontSize, line: c.lineHeight, family: c.fontFamily, color: c.color, height: c.height, radius: c.borderRadius, bg: c.backgroundColor, weight: c.fontWeight }; };
            return { dsh: s(document.querySelector('[data-slot="conversation.input.model"] button')), pill: s(document.querySelector('.rp-trigger')) };
        });
        const same = ['size', 'line', 'family', 'color', 'height', 'radius', 'bg', 'weight'].filter((k) => looks.dsh[k] !== looks.pill[k]);
        t.check('it looks like DSH\'s own model button (type, colour, height, corners, no ground of its own)', same.length === 0, JSON.stringify({ differs: same, ...looks }));
        const caption = await page.evaluate(() => {
            const el = document.querySelector('[data-slot="conversation.input.model"] [class*="_triggerEffort"]');
            return el ? getComputedStyle(el).display : 'none (absent)';
        });
        t.check('DSH\'s effort caption on the model button is hidden while the control is there', caption.startsWith('none'), caption);
        const tabOrder = await page.evaluate(() => {
            const bar = document.querySelector('[data-slot="conversation.composer.bar"]');
            const focusables = [...bar.querySelectorAll('button,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')].filter((el) => !el.disabled && el.getClientRects().length);
            return focusables.map((el) => (el.classList.contains('rp-trigger') ? 'PILL' : el.closest('[data-slot="conversation.input.model"]') ? 'MODEL' : el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20) || el.tagName));
        });
        await pill(page).focus();
        await page.keyboard.press('Tab');
        const next = await page.evaluate(() => document.activeElement?.closest('[data-slot="conversation.input.model"]') !== null);
        await page.keyboard.press('Shift+Tab');
        const back = await page.evaluate(() => document.activeElement?.classList.contains('rp-trigger'));
        t.check('Tab goes from the control to the model button and Shift+Tab back (the order you see is the order keys follow)', next && back, JSON.stringify(tabOrder));
        await shot(page, shots, 'new-chat-light');
    });

    await t.step('keyboard: the control opens DSH\'s menu with the model\'s levels, a pick closes it and keeps focus', async () => {
        await pill(page).focus();
        await page.keyboard.press('Enter');
        await waitFor(async () => (await pillMenu(page).count()) > 0 && (await pillMenu(page).isVisible()), 'the reasoning menu', 10000);
        const items = await menuItems(page);
        t.check('the menu lists Default and the model\'s five levels in DSH\'s words', items.map((i) => i.text.replace(', current', '')).join(',') === 'Default,Low,Medium,High,Xhigh,Max', JSON.stringify(items));
        t.check('the menu marks the current level (DSH\'s check, and ", current" for screen readers)', items[0]?.text === 'Default, current' || items.some((i) => i.text.startsWith('Default') && (i.checked === 'true' || i.selected === 'true')), JSON.stringify(items));
        t.check('the menu is DSH\'s own menu part (role menu, in the page body)', await pillMenu(page).evaluate((el) => el.closest('[role="menu"]') !== null || el.getAttribute('role') === 'menu'));
        t.check('the trigger says the menu is open', (await pill(page).getAttribute('aria-expanded')) === 'true');
        await shot(page, shots, 'menu-open-light');
        // Down to Low and pick it.
        const focusedAt = async () => (await menuItems(page)).findIndex((i) => i.focused);
        await waitFor(async () => (await focusedAt()) >= 0, 'a focused item in the menu', 5000).catch(() => {});
        let at = await focusedAt();
        for (let i = 0; i < 6 && at !== 1; i += 1) {
            await page.keyboard.press('ArrowDown');
            at = await focusedAt();
        }
        t.check('the arrow keys move through the levels', at === 1, `focused item ${at}`);
        await page.keyboard.press('Enter');
        await waitFor(async () => !(await pillMenu(page).isVisible().catch(() => false)), 'the menu to close', 5000);
        await waitFor(async () => (await pillText(page)) === 'Reasoning: Low', 'the control to read Low', 10000);
        t.check('a pick shows at once on the control', (await pillText(page)) === 'Reasoning: Low');
        const focusBack = await waitFor(() => page.evaluate(() => document.activeElement?.classList.contains('rp-trigger')), 'focus on the control', 5000).catch(() => false);
        t.check('focus goes back to the control after a pick', focusBack, await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200)));
        const said = await waitFor(async () => (await page.locator('.rp-root [role="status"]').textContent()) || '', 'the announcement', 10000).catch(() => '');
        t.check('the change is announced to screen readers when DSH confirms it', said === 'Reasoning effort: Low', said);
        await waitFor(async () => (await pill(page).getAttribute('aria-busy')) === null, 'the pick to settle', 10000);
        t.check('the accessible name says the level', (await pill(page).getAttribute('aria-label')) === 'Reasoning effort: Low');
    });

    await t.step('Escape closes the menu without a change and gives focus back', async () => {
        await pill(page).focus();
        await page.keyboard.press('Enter');
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await pillMenu(page).isVisible().catch(() => false)), 'the menu to close', 5000);
        t.check('still Low after Escape', (await pillText(page)) === 'Reasoning: Low');
        t.check('focus is back on the control after Escape', await page.evaluate(() => document.activeElement?.classList.contains('rp-trigger')));
    });

    // ── The pick reaches the model and the session's log ─────────────
    let sessionId;
    await t.step('the first turn goes out with the picked level (Low)', async () => {
        await send(page, 'E2E:say first turn');
        const r = requestFor('first turn');
        t.check('DSH sent reasoning_effort "low" to the model for the first turn', r?.effort === 'low', JSON.stringify(r?.body));
        await waitFor(() => run.sessionIds().length > 0, 'the session on disk', 20000);
        sessionId = run.sessionIds()[0];
        await waitFor(() => selectionsIn(sessionId).some((s) => s.effort === 'low'), 'the selection in the session log', 20000).catch(() => {});
        const sel = selectionsIn(sessionId);
        t.check('the session\'s own log records the selection with effort low', sel.some((s) => s.model === 'think-model' && s.effort === 'low'), JSON.stringify(sel.slice(-4)));
    });

    // ── An open chat, where the day is spent ─────────────────────────
    await t.step('an open chat: the menu opens above its control, as DSH\'s model menu does, covering neither the control nor the status line', async () => {
        await waitFor(async () => (await pill(page).count()) === 1 && (await pillText(page)) === 'Reasoning: Low', 'the control in the open chat', 20000);
        await page.waitForTimeout(800);
        await pill(page).click();
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        await page.waitForTimeout(300);
        const menuBox = await rect(page, '.rp-menu');
        const control = await rect(page, '[data-slot="conversation.composer.bar"] .rp-trigger');
        const card = await page.evaluate(() => { const r = document.querySelector('.rp-trigger').closest('[data-composer-card]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
        const statusLine = { top: card.bottom, bottom: card.bottom + 40, left: card.left, right: card.right };
        t.check('the menu opens above the control and does not cover it', Boolean(menuBox && control) && menuBox.bottom <= control.top && !overlaps(menuBox, control), JSON.stringify({ menuBox, control }));
        t.check('the menu does not reach the status line under the composer', Boolean(menuBox) && menuBox.bottom <= card.bottom && !overlaps(menuBox, statusLine), JSON.stringify({ menuBox, card }));
        await shot(page, shots, 'chat-menu-open-light');
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await pillMenu(page).isVisible().catch(() => false)), 'the menu to close', 5000);
        await modelButton(page).click();
        await waitFor(() => dshMenuOpen(page), 'DSH\'s model menu', 10000);
        const dsh = await page.evaluate(() => {
            const m = [...document.querySelectorAll('[role="menu"]')].find((x) => x.querySelector('[class*="_cellLabel"]') && x.getClientRects().length).getBoundingClientRect();
            const b = document.querySelector('[data-slot="conversation.input.model"] button').getBoundingClientRect();
            return { menuBottom: m.bottom, buttonTop: b.top };
        });
        t.check('DSH\'s model menu beside it opens above its button too (the two agree)', dsh.menuBottom <= dsh.buttonTop, JSON.stringify(dsh));
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await dshMenuOpen(page)), 'DSH\'s menu to close', 5000).catch(() => {});
    });

    await t.step('a second click on the control closes the menu and picks nothing', async () => {
        const before = selectionsIn(sessionId).length;
        await pill(page).click();
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        await page.waitForTimeout(300);
        await pill(page).click();
        await waitFor(async () => !(await pillMenu(page).isVisible().catch(() => false)), 'the menu to close', 5000).catch(() => {});
        await page.waitForTimeout(1500);
        t.check('the second click closed the menu', !(await pillMenu(page).isVisible().catch(() => false)) && (await pill(page).getAttribute('aria-expanded')) === 'false');
        const after = selectionsIn(sessionId).length;
        t.check('nothing was picked: the control still reads Low and the session\'s log has no new selection', (await pillText(page)) === 'Reasoning: Low' && before > 0 && after === before, JSON.stringify({ text: await pillText(page), before, after }));
    });

    await t.step('with the menu open, a click in the message box closes it and what is typed lands there', async () => {
        await pill(page).click();
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        await box(page).click();
        await page.waitForTimeout(400);
        const focus = await page.evaluate(() => ({ editable: document.activeElement?.isContentEditable === true, onControl: document.activeElement?.classList.contains('rp-trigger') === true }));
        await page.keyboard.type('abc def');
        await page.waitForTimeout(300);
        const typed = ((await box(page).innerText()) ?? '').trim();
        const open = await pillMenu(page).isVisible().catch(() => false);
        t.check('the focus stays in the message box (the control does not take it back)', focus.editable && !focus.onControl, JSON.stringify(focus));
        t.check('the typing lands in the message box, and the menu stays closed', typed === 'abc def' && !open, JSON.stringify({ typed, open }));
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.press('Backspace');
        await waitFor(async () => ((await box(page).innerText()) ?? '').trim() === '', 'the box to be empty again', 5000).catch(() => {});
    });

    await t.step('with the menu open, one click on DSH\'s model button opens DSH\'s model menu', async () => {
        await pill(page).click();
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        await modelButton(page).click();
        const opened = await waitFor(() => dshMenuOpen(page), 'DSH\'s model menu', 3000).then(() => true, () => false);
        t.check('DSH\'s model menu opens on the first click, and the control\'s menu is closed', opened && !(await pillMenu(page).isVisible().catch(() => false)));
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await dshMenuOpen(page)), 'DSH\'s menu to close', 5000).catch(() => {});
    });

    await t.step('DSH\'s model menu: the Effort row is hidden, the Model row still works', async () => {
        await waitFor(async () => (await pill(page).count()) === 1, 'the control in the session composer', 20000);
        const modelButton = page.locator('[data-slot="conversation.input.model"] button').first();
        await modelButton.click();
        const menu = page.locator('[role="menu"]').filter({ has: page.locator('[class*="_cellLabel"]') }).first();
        await waitFor(async () => menu.isVisible(), 'DSH\'s model menu', 10000);
        const readRows = () => menu.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => ({ label: e.querySelector('[class*="_cellLabel"]')?.textContent, shown: getComputedStyle(e).display !== 'none', marked: e.hasAttribute('data-reasoning-pill-hidden') })));
        const first = await readRows();
        await page.waitForTimeout(300);
        const rows = await readRows();
        t.check('the Effort row is in DSH\'s menu but hidden (marked by the plugin) as soon as the menu shows, and stays hidden', [first, rows].every((list) => list.some((r) => r.label === 'Effort' && !r.shown && r.marked)), JSON.stringify({ first, rows }));
        t.check('the Model row shows', rows.some((r) => r.label === 'Model' && r.shown), JSON.stringify(rows));
        await shot(page, shots, 'dsh-model-menu-light');
        // Keyboard in DSH's menu never lands on the hidden row.
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        const onHidden = await page.evaluate(() => document.activeElement?.hasAttribute('data-reasoning-pill-hidden') === true);
        t.check('the arrow keys in DSH\'s menu never land on the hidden row', !onHidden);
        // Pick the model with no levels through DSH's own Model row.
        await menu.locator('[role="menuitem"]').filter({ hasText: 'Model' }).first().click();
        const plain = page.getByText('Plain Model', { exact: true }).last();
        await waitFor(async () => plain.isVisible(), 'the model list', 10000);
        await plain.click();
        await waitFor(async () => (await pillText(page)) === 'Reasoning: None', 'the control to read None', 15000);
        t.check('a model with no levels shows "Reasoning: None", marked unavailable (aria-disabled) and still reachable by keyboard', (await pill(page).getAttribute('aria-disabled')) === 'true' && !(await pill(page).evaluate((el) => el.disabled)) && (await pillText(page)) === 'Reasoning: None');
        await pill(page).focus();
        t.check('it takes the keyboard focus (so its reason can be heard)', await page.evaluate(() => document.activeElement?.classList.contains('rp-trigger')));
        await pill(page).click({ force: true });
        await page.waitForTimeout(300);
        t.check('clicking it opens nothing', !(await pillMenu(page).isVisible().catch(() => false)));
        const title = await pill(page).getAttribute('title');
        t.check('it says why in its tooltip and accessible name', /has no reasoning levels/.test(title ?? '') && /has no reasoning levels/.test((await pill(page).getAttribute('aria-label')) ?? ''), title);
        await shot(page, shots, 'no-levels-light');
    });

    await t.step('a model with two levels: pick Max with the pointer; the next turn sends max', async () => {
        await page.locator('[data-slot="conversation.input.model"] button').first().click();
        const menu = page.locator('[role="menu"]').filter({ has: page.locator('[class*="_cellLabel"]') }).first();
        await waitFor(async () => menu.isVisible(), 'DSH\'s model menu', 10000);
        await menu.locator('[role="menuitem"]').filter({ hasText: 'Model' }).first().click();
        const hm = page.getByText('High Max Model', { exact: true }).last();
        await waitFor(async () => hm.isVisible(), 'the model list', 10000);
        await hm.click();
        await waitFor(async () => (await pillText(page)) === 'Reasoning: Default', 'Default for the new model', 15000);
        await pill(page).click();
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        const items = await menuItems(page);
        t.check('the menu follows the model: Default, High, Max', items.map((i) => i.text.replace(', current', '')).join(',') === 'Default,High,Max', JSON.stringify(items));
        await pillMenu(page).locator('[role^="menuitem"]').filter({ hasText: 'Max' }).first().click();
        await waitFor(async () => (await pillText(page)) === 'Reasoning: Max', 'Max', 10000);
        await send(page, 'E2E:say second turn');
        const r = requestFor('second turn');
        t.check('DSH sent the new model with reasoning_effort "max"', r?.model === 'hm-model' && r?.effort === 'max', JSON.stringify({ model: r?.model, body: r?.body }));
        await waitFor(() => selectionsIn(sessionId).some((s) => s.model === 'hm-model' && s.effort === 'max'), 'max in the log', 20000).catch(() => {});
        t.check('the session\'s own log records hm-model with effort max', selectionsIn(sessionId).some((s) => s.model === 'hm-model' && s.effort === 'max'), JSON.stringify(selectionsIn(sessionId).slice(-4)));
        // DSH keeps every model pick as its default for new chats (its own Effort row does the same); the README says so.
        const defaultRow = () => /- id: agent-default-model\n([\s\S]*?)(?=\n- |$)/.exec(readFileSync(patchFile, 'utf8'))?.[1] ?? '';
        await waitFor(() => /model: hm-model/.test(defaultRow()) && /reasoningEffort: max/.test(defaultRow()), 'DSH to save its default', 15000).catch(() => {});
        t.check('as with DSH\'s own Effort row, DSH keeps the pick as its default for new chats (profile: hm-model, max)', /model: hm-model/.test(defaultRow()) && /reasoningEffort: max/.test(defaultRow()), defaultRow().replace(/\s+/g, ' '));
        await shot(page, shots, 'session-light');
    });

    await t.step('dark theme: the control keeps DSH\'s colours and reads at 4.5:1 or more', async () => {
        await setDark(page, true);
        await page.waitForTimeout(400);
        const c = await page.evaluate(() => {
            const pillEl = document.querySelector('.rp-trigger');
            let el = pillEl;
            let bg = 'rgba(0, 0, 0, 0)';
            while (el && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
                bg = getComputedStyle(el).backgroundColor;
                el = el.parentElement;
            }
            if (bg === 'rgba(0, 0, 0, 0)') bg = getComputedStyle(document.body).backgroundColor;
            return { fg: getComputedStyle(pillEl).color, bg, dsh: getComputedStyle(document.querySelector('[data-slot="conversation.input.model"] button')).color };
        });
        t.check('the control\'s colour is DSH\'s model button colour in dark', c.fg === c.dsh, JSON.stringify(c));
        t.check('the control\'s text has 4.5:1 or more against the composer in dark', contrast(c.fg, c.bg) >= 4.5, `${contrast(c.fg, c.bg).toFixed(2)} ${JSON.stringify(c)}`);
        await pill(page).click();
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        const dark = { menu: await rect(page, '.rp-menu'), control: await rect(page, '[data-slot="conversation.composer.bar"] .rp-trigger') };
        t.check('in dark too, the open chat\'s menu sits above its control', Boolean(dark.menu && dark.control) && dark.menu.bottom <= dark.control.top, JSON.stringify(dark));
        await shot(page, shots, 'chat-menu-open-dark');
        await page.keyboard.press('Escape');
        await shot(page, shots, 'session-dark');
        await setDark(page, false);
        const light = await page.evaluate(() => {
            const pillEl = document.querySelector('.rp-trigger');
            return { fg: getComputedStyle(pillEl).color, bg: getComputedStyle(document.body).backgroundColor };
        });
        t.check('the control\'s text has 4.5:1 or more in light', contrast(light.fg, light.bg) >= 4.5, `${contrast(light.fg, light.bg).toFixed(2)} ${JSON.stringify(light)}`);
    });

    await t.step('reload: the window shows the session\'s saved level', async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitFor(async () => (await pill(page).count()) === 1 && (await pillText(page)) === 'Reasoning: Max', 'Max after a reload', 60000);
        t.check('after a reload the control still reads Max (DSH kept it in the session)', (await pillText(page)) === 'Reasoning: Max');
    });

    // ── Many chats ───────────────────────────────────────────────────
    await t.step('switching chats: each chat keeps its own level, and its turns go out at it', async () => {
        await page.locator('[data-slot="sidebar"]').getByText(/^New session$/i).first().click();
        await waitFor(async () => (await pill(page).count()) === 1 && (await pillText(page)) === 'Reasoning: Max', 'a new chat at the last pick (Max)', 15000);
        await page.waitForTimeout(1500);
        await pickLevel(page, 'High');
        await send(page, 'E2E:say beta chat');
        t.check('chat B\'s turn went out at high', requestFor('beta chat')?.effort === 'high', JSON.stringify(requestFor('beta chat')?.body));
        const list = page.locator('[data-slot="sidebar"]');
        await waitFor(async () => (await list.getByText('beta chat', { exact: true }).count()) > 0 && (await list.getByText('first turn', { exact: true }).count()) > 0, 'both chats in DSH\'s list', 30000);
        const seen = [];
        await openChat(page, 'first turn');
        seen.push(await pillText(page));
        await openChat(page, 'beta chat');
        seen.push(await pillText(page));
        await openChat(page, 'first turn');
        seen.push(await pillText(page));
        t.check('each chat shows its own level when switched to (A Max, B High, A Max)', seen.join('|') === 'Reasoning: Max|Reasoning: High|Reasoning: Max', JSON.stringify(seen));
        await send(page, 'E2E:say alpha again');
        const r = requestFor('alpha again');
        t.check('a turn in A after the switches goes out at A\'s level (max on its model); B\'s pick left A alone', r?.effort === 'max' && r?.model === 'hm-model', JSON.stringify({ model: r?.model, body: r?.body }));
        await shot(page, shots, 'switched-back-light');
    });

    await t.step('a subagent\'s chat: no control, as DSH shows no model button there', async () => {
        await send(page, 'E2E:spawn');
        await waitFor(() => model.requests.some((q) => q.text.includes('child done')), 'the subagent\'s turn', 60000);
        // DSH lists a chat's subagents in its header; the row opens the subagent's chat.
        const list = page.getByRole('button', { name: /^1 subagent/i }).first();
        await waitFor(async () => (await list.count()) > 0, 'the subagent list in the chat\'s header', 30000);
        await list.click();
        await page.getByText('Reasoning child task', { exact: true }).first().click();
        await waitFor(async () => /child done|Reasoning child task/.test(await page.title()), 'the subagent\'s chat', 15000);
        await page.waitForTimeout(1200);
        const view = await page.evaluate(() => ({
            title: document.title,
            controls: [...document.querySelectorAll('.rp-root')].filter((e) => e.getClientRects().length > 0).length,
            modelButtons: [...document.querySelectorAll('[data-slot="conversation.input.model"] button')].filter((e) => e.getClientRects().length > 0).length,
        }));
        await shot(page, shots, 'subagent-chat-light');
        t.check('in a subagent\'s chat there is no control, as there is no model button from DSH', view.controls === 0 && view.modelButtons === 0, JSON.stringify(view));
        await openChat(page, 'first turn');
        t.check('back in the parent chat, the control is there with the chat\'s level', (await pillText(page)) === 'Reasoning: Max', await pillText(page));
    });

    await t.step('reduced motion and reduced transparency', async () => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const motion = await page.evaluate(() => getComputedStyle(document.querySelector('.rp-trigger')).transitionDuration);
        t.check('no transition on the control under reduced motion', /^0s(, 0s)*$/.test(motion), motion);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => document.body.classList.add('wp-still'));
        const still = await page.evaluate(() => getComputedStyle(document.querySelector('.rp-trigger')).transitionDuration);
        t.check('no transition on the control while Wallpaper\'s Motion is off (body.wp-still)', /^0s(, 0s)*$/.test(still), still);
        await page.evaluate(() => document.body.classList.remove('wp-still'));
        const cdp = await setReducedTransparency(page, true);
        const ground = await page.evaluate(() => getComputedStyle(document.querySelector('.rp-trigger')).backgroundColor);
        t.check('the control paints no translucent ground of its own (DSH\'s menu keeps its own material)', ground === 'rgba(0, 0, 0, 0)', ground);
        await pill(page).click();
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        await shot(page, shots, 'menu-reduced-transparency-light');
        await page.keyboard.press('Escape');
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    });

    await t.step('a narrow window (760 px): the control fits and nothing scrolls sideways', async () => {
        await page.setViewportSize({ width: 760, height: 820 });
        await page.waitForTimeout(800);
        const fit = await page.evaluate(() => {
            const row = document.querySelector('.rp-trigger').closest('[data-composer-card]');
            const p = document.querySelector('.rp-trigger').getBoundingClientRect();
            const card = row.getBoundingClientRect();
            return { inside: p.left >= card.left - 1 && p.right <= card.right + 1, visible: p.width > 0 && p.height > 0, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, card: card.width, pill: p.width };
        });
        t.check('at 760 px the control is inside the composer, and the window does not scroll sideways', fit.inside && fit.visible && fit.overflow <= 0, JSON.stringify(fit));
        await shot(page, shots, 'narrow-760-light');
        await setDark(page, true);
        await shot(page, shots, 'narrow-760-dark');
        await setDark(page, false);
    });

    await t.step('a composer too narrow for words: DSH shows its controls as icons, and the control shows its gauge', async () => {
        const compact = () => page.evaluate(() => document.querySelector('.rp-trigger')?.closest('[data-model-compact]') !== null);
        let width = 0;
        for (const w of [640, 560, 500, 440]) {
            await page.setViewportSize({ width: w, height: 820 });
            if (await waitFor(compact, 'DSH\'s compact composer', 3000).then(() => true, () => false)) {
                width = w;
                break;
            }
        }
        t.check('DSH turns its composer to icons in a narrow window', width > 0, `tried 640, 560, 500, 440 px`);
        const look = await page.evaluate(() => {
            const el = document.querySelector('.rp-trigger');
            const card = el.closest('[data-composer-card]').getBoundingClientRect();
            const p = el.getBoundingClientRect();
            return {
                label: getComputedStyle(el.querySelector('.rp-label')).display,
                gauge: getComputedStyle(el.querySelector('.rp-gauge')).display,
                modelText: (() => { const t = document.querySelector('[data-slot="conversation.input.model"] [class*="_triggerLabel"],[data-slot="conversation.input.model"] [class*="_triggerText"]'); return t ? getComputedStyle(t).display : 'unknown'; })(),
                inside: p.left >= card.left - 1 && p.right <= card.right + 1,
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
        });
        t.check('there the control shows only its gauge, as DSH\'s model button shows only its icon', look.label === 'none' && look.gauge !== 'none', JSON.stringify(look));
        t.check('the level stays in the control\'s accessible name and tooltip', (await pill(page).getAttribute('aria-label')) === 'Reasoning effort: Max' && (await pill(page).getAttribute('title')) === 'Reasoning effort: Max');
        t.check('the narrow control is inside the composer, and the window does not scroll sideways', look.inside && look.overflow <= 0, JSON.stringify(look));
        await shot(page, shots, `compact-${width}-light`);
        await page.setViewportSize({ width: 1280, height: 860 });
    });

    // ── Switched off and on again, live ──────────────────────────────
    await t.step('switched off: DSH\'s own Effort row and caption come back, nothing of the plugin is left', async () => {
        const patchBefore = readFileSync(patchFile, 'utf8');
        writeFileSync(patchFile, `${patchBefore}- id: reasoning-pill\n  disabled: true\n`);
        const gone = await waitFor(async () => (await page.locator('.rp-root').count()) === 0, 'the control to go (live)', 30000).then(() => true, () => false);
        if (!gone) {
            // A DSH that does not apply the profile live: restart it, as Settings → Plugins would.
            await run.stop();
            await run.boot('plugin off');
            await page.goto((await run.signIn()).link, { waitUntil: 'domcontentloaded' });
        }
        await waitFor(async () => (await page.locator('[data-slot="conversation.input.model"] button').count()) > 0, 'the composer', 60000);
        const left = await page.evaluate(() => ({
            roots: document.querySelectorAll('.rp-root,.rp-trigger').length,
            styles: document.querySelectorAll('style[data-plugin="dsh-plugin-reasoning-pill"]').length,
            marks: document.querySelectorAll('[data-reasoning-pill-hidden]').length,
            caption: (() => { const el = document.querySelector('[data-slot="conversation.input.model"] [class*="_triggerEffort"]'); return el ? getComputedStyle(el).display : 'absent'; })(),
        }));
        t.check(`off ${gone ? '(live, no reload)' : '(after a restart)'}: no control, no style sheet, no mark left`, left.roots === 0 && left.styles === 0 && left.marks === 0, JSON.stringify(left));
        t.check('off: DSH\'s effort caption shows again on the model button', left.caption !== 'none' && left.caption !== 'absent', JSON.stringify(left));
        await page.locator('[data-slot="conversation.input.model"] button').first().click();
        const menu = page.locator('[role="menu"]').filter({ has: page.locator('[class*="_cellLabel"]') }).first();
        await waitFor(async () => menu.isVisible(), 'DSH\'s model menu', 10000);
        await page.waitForTimeout(300);
        const effortShown = await menu.locator('[role="menuitem"]').evaluateAll((els) => els.some((e) => e.querySelector('[class*="_cellLabel"]')?.textContent === 'Effort' && getComputedStyle(e).display !== 'none'));
        t.check('off: DSH\'s Effort row shows again in its model menu', effortShown);
        await shot(page, shots, 'off-dsh-model-menu-light');
        await page.keyboard.press('Escape');
        writeFileSync(patchFile, patchBefore);
        if (!gone) {
            await run.stop();
            await run.boot('plugin on again');
            await page.goto((await run.signIn()).link, { waitUntil: 'domcontentloaded' });
        }
        await waitFor(async () => (await pill(page).count()) === 1 && (await pillText(page)) === 'Reasoning: Max', 'the control back, reading Max', 60000);
        const styles = await page.locator('style[data-plugin="dsh-plugin-reasoning-pill"]').count();
        t.check('on again: the control is back with the session\'s level, and one style sheet (nothing doubled)', styles === 1 && (await page.locator('.rp-root').count()) === 1, `styles ${styles}`);
        await page.locator('[data-slot="conversation.input.model"] button').first().click();
        const again = page.locator('[role="menu"]').filter({ has: page.locator('[class*="_cellLabel"]') }).first();
        await waitFor(async () => again.isVisible(), 'DSH\'s model menu', 10000);
        const effortAgain = await again.locator('[role="menuitem"]').evaluateAll((els) => els.filter((e) => e.querySelector('[class*="_cellLabel"]')?.textContent === 'Effort').map((e) => getComputedStyle(e).display));
        t.check('on again: DSH\'s Effort row is hidden again', effortAgain.length === 1 && effortAgain[0] === 'none', JSON.stringify(effortAgain));
        await page.keyboard.press('Escape');
    });

    await t.step('no errors from the plugin, in the window or in DSH\'s log', async () => {
        const errs = win.errors.filter((e) => /reasoning|rp-/i.test(e));
        t.check('no error from the plugin in the window', errs.length === 0, errs.join('\n'));
        const own = run.logText().split('\n').filter((l) => /reasoning-pill/i.test(l) && /error|fail/i.test(l));
        t.check('no error from the plugin in DSH\'s log', own.length === 0, own.join('\n'));
    });

    // ── DSH gone: the last step, as it stops DSH ─────────────────────
    await t.step('DSH\'s host gone: a pick says plainly that it was not made, and the level in force stays', async () => {
        await waitFor(async () => !(await dshMenuOpen(page)), 'DSH\'s menu to close', 5000).catch(() => {});
        const before = await pillText(page);
        const records = selectionsIn(sessionId).length;
        await run.stop();
        await page.waitForTimeout(1500);
        await pill(page).click();
        await waitFor(async () => pillMenu(page).isVisible(), 'the menu', 5000);
        await pillMenu(page).locator('[role^="menuitem"]').filter({ hasText: /^High/ }).first().click();
        const words = 'Reasoning not changed: DSH isn\'t reachable. Try again when it reconnects.';
        const banner = page.locator('[role="alert"]').filter({ hasText: 'Reasoning not changed' }).first();
        const shown = await waitFor(async () => (await banner.isVisible().catch(() => false)) && ((await banner.innerText()) ?? '').trim(), 'DSH\'s banner', 20000).catch(() => '');
        t.check('DSH\'s banner (read out at once: role alert) says it in plain words, with what to do next', shown === words, shown);
        await waitFor(async () => (await pillText(page)) === before && (await pill(page).getAttribute('aria-busy')) === null, 'the level in force', 10000).catch(() => {});
        const control = () => pill(page).evaluate((el) => ({ text: el.textContent.replace(/\s+/g, ' ').trim(), name: el.getAttribute('aria-label'), tip: el.getAttribute('title'), state: el.getAttribute('data-reasoning-pill-state'), mark: el.querySelector('.rp-warn')?.getClientRects().length > 0 }));
        const now = await control();
        t.check('the control still shows the level in force, with a warning mark and the same words in its name and tooltip', now.text === before && now.state === 'refused' && now.mark && now.name === `Reasoning effort: ${before.replace('Reasoning: ', '')}. ${words}` && now.tip === now.name, JSON.stringify(now));
        const raw = await page.evaluate(() => /client api|selectModel|Failed to fetch|gateway\//.test(document.body.innerText));
        t.check('no raw DSH text anywhere people read', !raw);
        await shot(page, shots, 'host-gone-refused-light');
        await page.waitForTimeout(4000);
        const later = await control();
        t.check('the mark and the words stay while DSH is away (until the next pick, another chat or DSH back)', later.state === 'refused' && later.mark && later.tip === now.tip, JSON.stringify(later));
        t.check('nothing reached the session\'s log', selectionsIn(sessionId).length === records);
        // DSH back on the same port: the window reconnects, DSH clears its error, and the mark goes. (DSH's window
        // sometimes stays blank after its host restarts, with or without plugins; then a person reloads it.)
        await run.boot('back');
        const ready = async () => (await pill(page).count()) === 1 && (await pill(page).getAttribute('data-reasoning-pill-state')) === 'ready';
        let how = await waitFor(ready, 'the mark to go once DSH is back', 45000).then(() => 'the window reconnected', () => '');
        if (!how && (await page.locator('[data-slot="sidebar"]').count()) === 0) {
            await page.goto((await run.signIn()).link, { waitUntil: 'domcontentloaded' });
            await page.locator('[data-slot="sidebar"]').first().waitFor({ state: 'attached', timeout: 60000 });
            await openChat(page, 'first turn');
            how = await waitFor(ready, 'the control after a reload', 30000).then(() => 'DSH left its window blank; reloaded', () => '');
        }
        console.log(`# after DSH came back (${how || 'mark still there'}): ${JSON.stringify(await control().catch((e) => String(e)))}`);
        t.check(`once DSH is back (${how || 'no reconnect'}), the mark goes and the control reads the level in force`, Boolean(how) && (await pillText(page)) === before, JSON.stringify(await control().catch(() => null)));
    });
} catch (error) {
    t.check('the run finished', false, error?.stack ?? error);
    console.log(run.logText().slice(-2500));
} finally {
    await win?.browser.close().catch(() => {});
    await run.stop();
    await model.close();
    run.cleanup();
    t.summary();
    process.exit(t.failed ? 1 : 0);
}
