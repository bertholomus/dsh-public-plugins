/**
 * Coordinator: a chat that coordinates splits a release into threads; one
 * needs a decision, the version bump hands back done, and the chat then
 * starts the changelog thread, which hands back done too. The chat with its
 * thread cards and the thread rows nested under it, the Threads menu, and a
 * thread open beside its chat.
 *
 * The threads work in the chat's folder, and DSH counts a file written while
 * a turn runs there as that turn's change. So the demo script (demo.json)
 * has each write wait until no other turn in the folder runs: the version
 * bump waits for Route tests and the chat to answer, and the changelog
 * thread starts only after the version bump.
 */
import { waitFor } from '../stage.mjs';

export default async function coordinator(scene) {
    const run = await scene.start({
        plugins: ['coordinator'],
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
`,
    });
    const say = (start) => scene.say(start);
    const chat = await run.newSession({ project: 'harbor-gateway', title: 'Gateway 2.4' });
    const on = await run.api('commands/execute', { agentId: chat, line: '/coordinate', submittedAttachments: [] });
    if (!on.ok) throw new Error(`/coordinate: ${JSON.stringify(on.error)}`);
    await run.prompt(chat, say('Get the gateway ready for 2.4'));
    // The chat's own turn, then one turn for each thread's handback.
    await run.idle(chat, { turns: 4, timeout: 180000 });

    const page = await scene.open({ entry: 'Plugins' });
    const row = (id) => page.locator(`[data-row-key="session:${id}"]`).first();
    await row(chat).click();
    const trigger = page.locator('[data-projects-threads-trigger]').filter({ visible: true }).first();
    await trigger.waitFor({ state: 'visible', timeout: 30000 });
    const cards = page.locator('[data-projects-thread-cards]').filter({ visible: true });
    await cards.first().waitFor({ state: 'visible' });
    await waitFor(async () => (await page.locator('[data-projects-nests] [data-projects-nested] [data-row-key]').count()) >= 3, 'the thread rows under the chat', 20000, 300);
    // The end of the chat: the last handbacks, each with the chat's answer and the thread's card.
    const toEnd = (p) => p.locator('[data-projects-thread-cards]').filter({ visible: true }).last().evaluate((el) => {
        for (let node = el.parentElement; node; node = node.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {
                node.scrollTop = node.scrollHeight;
                return;
            }
        }
    });
    await scene.shoot('chat', { prepare: toEnd });

    await scene.shoot('menu', {
        themes: ['light'],
        still: true,
        prepare: async (p) => {
            await p.keyboard.press('Escape');
            await trigger.click();
            await p.locator('[data-projects-threads-menu]').waitFor({ state: 'visible' });
            await p.mouse.move(1, 899);
        },
    });
    await page.keyboard.press('Escape');

    // A thread beside its chat: its row in the session list opens it in the right sidebar.
    await page.locator('[data-projects-nests] [data-projects-nested] [data-row-key]').filter({ hasText: 'Version 2.4.0' }).first().click();
    await page.locator('[data-projects-thread-chat]').filter({ visible: true }).first().waitFor({ state: 'visible' });
    await scene.shoot('beside', { themes: ['dark'] });
}
