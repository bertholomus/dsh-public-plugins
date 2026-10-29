/**
 * Decisions: the inbox with a tool waiting for approval, a question in DSH's
 * question box, a decision line with its recommendation, a blocker and a
 * plain question; then what happened to the one already answered.
 */
import { waitFor } from '../stage.mjs';

export default async function decisions(scene) {
    const run = await scene.start({
        plugins: ['session-watch', 'decisions', 'notifications'],
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
- id: decisions
  config:
    windowHours: 72
`,
    });
    const api = (method, args) => scene.api(`dsh-plugin-decisions/${method}`, args);
    const say = (start) => scene.say(start);
    // DSH asks an open window to approve; with none, it refuses at once. This stands in for the window until it opens.
    const prompts = await run.prompts();
    const ids = {};
    ids.release = await run.newSession({ project: 'tide-ledger', title: 'Release date', prompt: say('Pick a release date') });
    ids.schema = await run.newSession({ project: 'tide-ledger', title: 'Schema cleanup', prompt: say('The old entries_v1 table') });
    ids.staging = await run.newSession({ project: 'harbor-gateway', title: 'Staging deploy', prompt: say('Deploy the gateway to staging') });
    ids.version = await run.newSession({ project: 'harbor-gateway', title: 'Release build', prompt: say('Get a release build') });
    for (const id of Object.values(ids)) await run.idle(id);
    ids.report = await run.newSession({ project: 'tide-ledger', title: 'October report copy', prompt: say('Save the October report') });
    ids.target = await run.newSession({ project: 'harbor-gateway', title: 'Deploy 2.3.1', prompt: say('Deploy v2.3.1 once') });

    const cardOf = (sessionId) => waitFor(async () => (await api('state')).waiting.find((c) => c.sessionId === sessionId), `the card for ${sessionId}`, 60000, 300);
    const release = await cardOf(ids.release);
    for (const id of [ids.schema, ids.staging, ids.version, ids.report, ids.target]) await cardOf(id);
    await api('answer', { id: release.id, answer: { recommended: true } });
    await waitFor(async () => (await api('state')).history.find((e) => e.cardId === release.id && e.kind === 'answer' && e.state === 'delivered'), 'the answer read into a turn', 60000, 300);
    await run.idle(ids.release, { turns: 2 });

    const page = await scene.open({ entry: 'Decisions' });
    await page.getByRole('button', { name: 'Decisions', exact: true }).first().click();
    await page.locator('[data-decisions-page]').waitFor({ state: 'visible' });
    await page.locator('[data-decisions-card]').nth(4).waitFor({ state: 'visible' });
    const top = (p) => p.locator('[data-decisions-page]').evaluate((el) => { el.scrollTop = 0; });
    await scene.shoot('inbox', { prepare: top });
    await scene.shoot('decision', {
        themes: ['light'],
        prepare: (p) => p.locator(`[data-decisions-card]:has-text("Drop the old entries_v1 table now?")`).first().evaluate((el) => el.scrollIntoView({ block: 'center' })),
    });
    await scene.shoot('history', {
        themes: ['dark'],
        // What happened as far up as the page scrolls. The page ends before it reaches the top, so a line of the card
        // above may sit across the window's top edge: the window then starts just above that line instead.
        prepare: (p) => p.locator('[data-decisions-history]').evaluate((el) => {
            el.scrollIntoView({ block: 'start' });
            let box = el.parentElement;
            while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
            if (!box) return;
            const edge = box.getBoundingClientRect().top;
            const cut = [...document.querySelectorAll('[data-decisions-card] p')].find((line) => {
                const r = line.getBoundingClientRect();
                return r.top < edge && r.bottom > edge;
            });
            if (cut) box.scrollTop += cut.getBoundingClientRect().top - edge - 4;
        }),
    });
    prompts.close();
}
