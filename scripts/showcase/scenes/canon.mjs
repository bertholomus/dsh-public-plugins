/**
 * Canon: a team's vault of notes (the repo's synthetic one), the notes a
 * turn got and the card after it, what Try a prompt says a turn would get,
 * and two drafts agents saved, waiting for a person to promote them.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '../stage.mjs';

export default async function canon(scene) {
    const run = await scene.start({
        plugins: ['session-watch', 'canon'],
        files: { 'Obsidian/Canon': 'test/fixtures/canon/vault' },
        // The vault's own drafts name the test's sessions: the drafts here are the ones this demo's agents save.
        before: (r) => {
            const drafts = join(r.user, 'Obsidian', 'Canon', 'Drafts');
            for (const name of readdirSync(drafts)) rmSync(join(drafts, name));
        },
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
- id: canon
  config:
    vault: ~/Obsidian/Canon
    access: drafts
    promote: true
`,
    });
    const api = (method, args) => scene.api(`dsh-plugin-canon/${method}`, args);
    const say = (start) => scene.say(start);
    await waitFor(async () => (await api('state')).vault?.state === 'ok', 'the first read of the vault', 30000, 300);
    const ids = {};
    ids.decision = await run.newSession({ project: 'tide-ledger', title: 'entries_v1 decision', prompt: say('Write down what we agreed') });
    await run.idle(ids.decision);
    ids.keepalive = await run.newSession({ project: 'harbor-gateway', title: 'Keepalive gotcha', prompt: say('Remember the keepalive gotcha') });
    await run.idle(ids.keepalive);
    ids.migration = await run.newSession({ project: 'tide-ledger', title: 'Migration timing', prompt: say('Can I run the entries schema migration') });
    await run.idle(ids.migration);
    ids.rollout = await run.newSession({ project: 'harbor-gateway', title: 'Health check and rollout', prompt: say('Which port does the load balancer use') });
    await run.idle(ids.rollout);
    await waitFor(async () => {
        const s = await api('state');
        return s.drafts.length === 2 && s.sessions.length >= 2;
    }, 'two drafts and the sessions that got notes', 30000, 300);

    const page = await scene.open({ entry: 'Canon' });
    const openCanon = async () => {
        await page.getByRole('button', { name: 'Canon', exact: true }).first().click();
        await page.locator('[data-canon-page]').waitFor({ state: 'visible' });
    };
    await openCanon();
    const tryCard = page.locator('[data-canon-try]');
    await tryCard.locator('[data-canon-try-prompt]').fill('What port does the harbor gateway listen on, and who owns it?');
    await tryCard.locator('[data-canon-try-folder]').fill('~/Projects/harbor-gateway');
    await tryCard.getByRole('button', { name: 'Try it', exact: true }).click();
    await waitFor(async () => Number(await tryCard.getAttribute('data-canon-try')) > 0, 'the try-out to show its notes', 15000, 200);
    const top = (p) => p.locator('[data-canon-page]').evaluate((el) => { el.scrollTop = 0; });
    await scene.shoot('page', { prepare: top });

    const drafts = page.locator('[data-canon-drafts]');
    await drafts.locator('details summary').first().click();
    await scene.shoot('drafts', { themes: ['light'], prepare: () => drafts.evaluate((el) => el.scrollIntoView({ block: 'start' })) });

    const row = page.locator(`[data-canon-session="${ids.rollout}"]`);
    await row.locator('.dshcn-title button').first().click();
    await page.locator('[data-canon-page]').waitFor({ state: 'detached' }).catch(() => {});
    const card = page.locator('[data-canon-turn]').filter({ visible: true }).first();
    await card.waitFor({ state: 'visible' });
    await scene.shoot('turn', { themes: ['dark'], prepare: () => card.evaluate((el) => el.scrollIntoView({ block: 'end' })) });
}
