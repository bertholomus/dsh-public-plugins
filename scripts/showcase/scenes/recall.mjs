/**
 * Recall: past turns of this DSH's sessions and a handoff note, found by a
 * few words with the words marked; a result opened at its turn; and an
 * agent's own search, on its card in the chat.
 */
import { unfold, waitFor } from '../stage.mjs';

export default async function recall(scene) {
    const run = await scene.start({
        plugins: ['session-watch', 'recall'],
        files: { Notes: 'scripts/showcase/files/notes' },
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
- id: recall
  config:
    handoffFolders: ["~/Notes"]
`,
    });
    const api = (method, args) => scene.api(`dsh-plugin-recall/${method}`, args);
    const say = (start) => scene.say(start);
    const ids = {};
    ids.docs = await run.newSession({ project: 'atlas-docs', title: 'Rollback steps', prompt: say('Add the rollback steps') });
    ids.ledger = await run.newSession({ project: 'tide-ledger', title: 'October balance', prompt: say('The October balance') });
    ids.resets = await run.newSession({ project: 'harbor-gateway', title: 'Connection resets', prompt: say('Clients behind the load balancer') });
    for (const id of Object.values(ids)) await run.idle(id);
    const found = (text) => api('search', { query: { text, limit: 20 } });
    await waitFor(async () => (await found('connection resets')).total >= 2, 'the index to hold the session and the note', 60000, 500);
    ids.again = await run.newSession({ project: 'harbor-gateway', title: 'Resets again?', prompt: say('Did we ever see connection resets') });
    await run.idle(ids.again);
    await waitFor(async () => (await found('connection resets')).total >= 3, 'the index to hold the newest turn', 60000, 500);

    const page = await scene.open({ entry: 'Recall' });
    await page.getByRole('button', { name: 'Recall', exact: true }).first().click();
    await page.locator('[data-recall-page]').waitFor({ state: 'visible' });
    const box = page.getByRole('searchbox', { name: 'Search past work' });
    await box.fill('connection resets');
    await box.press('Enter');
    await waitFor(async () => (await page.locator('[data-recall-result]').count()) >= 3, 'the results', 15000, 200);
    const top = (p) => p.locator('[data-recall-page]').evaluate((el) => { el.scrollTop = 0; });
    await scene.shoot('search', { prepare: top });

    const resets = page.locator('[data-recall-result]').filter({ hasText: 'Connection resets' }).first();
    await resets.locator('[data-recall-open]').first().click();
    const mark = page.locator('[data-recall-mark]').filter({ visible: true }).first();
    await mark.waitFor({ state: 'visible' });
    await scene.shoot('found', { themes: ['dark'] });

    await page.getByRole('button', { name: /^Done/ }).first().click().catch(() => {});
    await page.getByText('Resets again?', { exact: true }).first().click();
    await page.getByText('the gateway handoff note lists it under Gotchas').first().waitFor({ state: 'visible' });
    await unfold(page);
    const card = page.locator('[data-recall-tool="results"]').filter({ visible: true }).first();
    await card.waitFor({ state: 'visible' });
    await card.getByText(/Searched past work for/).first().click();
    await card.locator('[data-recall-tool-result]').first().waitFor({ state: 'visible' });
    await scene.shoot('tool', { themes: ['light'], prepare: () => card.evaluate((el) => el.scrollIntoView({ block: 'center' })) });
}
