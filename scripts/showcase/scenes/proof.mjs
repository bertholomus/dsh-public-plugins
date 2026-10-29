/**
 * Proof: a turn whose "All tests pass" its own test run contradicts, a
 * deploy claim nothing shows that an independent check answered NOT
 * VERIFIED, and the page with the claims ledger.
 */
import { waitFor } from '../stage.mjs';

export default async function proof(scene) {
    const run = await scene.start({
        plugins: ['session-watch', 'proof'],
        model: { more: [{ id: 'local-small', name: 'local-small', efforts: { low: 'low', high: 'high' } }] },
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
- id: proof
  config:
    verifierProvider: local
    verifierModel: local-small
    verifierMinutes: 2
`,
    });
    const api = (method, args) => scene.api(`dsh-plugin-proof/${method}`, args);
    const say = (start) => scene.say(start);
    const ids = {};
    ids.tests = await run.newSession({ project: 'harbor-gateway', title: 'Gateway tests', prompt: say('Run the gateway tests now') });
    ids.changelog = await run.newSession({ project: 'tide-ledger', title: 'Changelog 0.9.3', prompt: say('Add the trailing-zeros change') });
    await run.idle(ids.changelog);
    ids.deploy = await run.newSession({ project: 'harbor-gateway', title: 'Staging deploy', prompt: say('Deploy v2.3.1') });
    ids.report = await run.newSession({ project: 'tide-ledger', title: 'Report decimals', prompt: say('Make the report show amounts') });
    for (const id of Object.values(ids)) await run.idle(id);

    const ledger = (sessionId) => api('ledger', { sessionId });
    const deploy = await waitFor(async () => (await ledger(ids.deploy)).claims.find((c) => c.verdict === 'unbacked'), 'the deploy claim', 30000, 300);
    await waitFor(async () => (await ledger(ids.report)).claims.find((c) => c.verdict === 'contradicted'), 'the contradicted claim', 30000, 300);
    await api('check', { sessionId: ids.deploy, claimId: deploy.id });
    await waitFor(async () => {
        const c = (await api('session', { sessionId: ids.deploy })).checks.find((x) => x.claimId === deploy.id);
        return c && !['queued', 'running'].includes(c.state) ? c : null;
    }, 'the check to settle', 90000, 500);

    const page = await scene.open({ entry: 'Proof' });
    const openProof = () => page.getByRole('button', { name: 'Proof', exact: true }).first().click();
    const openLedger = async (sessionId) => {
        await openProof();
        await page.locator(`[data-proof-session="${sessionId}"]`).click();
        const box = page.locator(`[data-proof-ledger="${sessionId}"]`);
        await box.waitFor({ state: 'visible' });
        await box.locator('[data-proof-said]').waitFor({ state: 'attached', timeout: 15000 });
        return box;
    };
    const openChat = async (sessionId) => {
        const box = await openLedger(sessionId);
        await box.getByRole('button', { name: 'Open the session', exact: true }).click();
        await page.locator('[data-proof-page]').waitFor({ state: 'detached' }).catch(() => {});
        const flag = page.locator('[data-proof-flag]').filter({ visible: true }).first();
        await flag.waitFor({ state: 'visible' });
        return flag;
    };
    const center = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'end' }));

    const contradicted = await openChat(ids.report);
    await scene.shoot('flag', { prepare: () => center(contradicted) });
    const checked = await openChat(ids.deploy);
    await waitFor(async () => (await checked.getAttribute('data-proof-flag')) === 'not-verified', 'the verdict on the flag', 20000, 300);
    await scene.shoot('checked', { themes: ['light'], prepare: () => center(checked) });
    const box = await openLedger(ids.report);
    await box.getByRole('tab', { name: /^All claims/ }).click();
    await waitFor(async () => (await box.locator('[data-proof-claim]').count()) >= 1, 'every claim in the ledger', 10000, 200);
    await scene.shoot('ledger', { themes: ['dark'], prepare: (p) => p.locator('[data-proof-page]').evaluate((el) => { el.scrollTop = 0; }) });
}
