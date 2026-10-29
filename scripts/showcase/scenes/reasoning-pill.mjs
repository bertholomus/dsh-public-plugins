/**
 * Reasoning pill: the Reasoning control beside the model name in an open
 * chat, its menu open with the model's levels; DSH's model menu with one
 * place for reasoning (no Effort row of its own); and a new chat that starts
 * at the last pick.
 */
import { waitFor } from '../stage.mjs';

export default async function reasoningPill(scene) {
    const run = await scene.start({
        plugins: ['reasoning-pill'],
        model: { efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
    });
    const chat = await run.newSession({ project: 'harbor-gateway', title: 'Bucket refill', prompt: scene.say('Should the rate limiter refill') });
    await run.idle(chat);

    const page = await scene.open({ entry: 'Plugins' });
    const row = page.locator(`[data-row-key="session:${chat}"]`).first();
    // The workspace came after the window: its folder in the session list opens to show the chat.
    if (!(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) {
        await page.locator('[data-slot="sidebar.workspaces"]').getByText('harbor-gateway', { exact: true }).first().click();
    }
    await row.click();
    const pill = page.locator('[data-slot="conversation.composer.bar"] .rp-trigger').first();
    const menu = page.locator('.rp-menu').first();
    await pill.waitFor({ state: 'visible', timeout: 30000 });
    // High for this chat, picked from the control's menu.
    await pill.click();
    await menu.waitFor({ state: 'visible' });
    await menu.locator('[role^="menuitem"]').filter({ hasText: /^High/ }).first().click();
    await waitFor(async () => /High/.test(await pill.textContent()), 'Reasoning: High', 15000, 200);

    // The control's menu open above it: the model's levels, with DSH's check on the one in force.
    await scene.shoot('chat', {
        still: true,
        prepare: async (p) => {
            if (!(await menu.isVisible())) await pill.click();
            await menu.waitFor({ state: 'visible' });
            await p.mouse.move(1, 899);
        },
    });
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });

    // DSH's model menu: the Model row as before, and no Effort row beside the control.
    const modelButton = page.locator('[data-slot="conversation.input.model"] button').first();
    await scene.shoot('model-menu', {
        themes: ['dark'],
        still: true,
        prepare: async (p) => {
            await modelButton.click();
            await waitFor(() => p.evaluate(() => [...document.querySelectorAll('[role="menu"]')].some((m) => m.getClientRects().length > 0)), 'DSH\'s model menu', 5000, 200);
            await p.mouse.move(1, 899);
        },
    });
    await page.keyboard.press('Escape');

    // A new chat starts at the last pick: DSH keeps it as the default for new chats.
    await page.getByRole('button', { name: 'New Session' }).first().click();
    await waitFor(async () => /High/.test((await pill.textContent().catch(() => '')) ?? ''), 'the new chat at High', 15000, 200);
    await scene.shoot('new-chat', { themes: ['light'] });
}
