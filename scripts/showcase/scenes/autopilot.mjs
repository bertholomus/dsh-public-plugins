/**
 * Autopilot: its page with a question waiting and a session it backed off
 * from, its log with a Why line for every action, and a chat that its notes
 * kept going until the work was done.
 */
import { waitFor } from '../stage.mjs';

export default async function autopilot(scene) {
    const run = await scene.start({
        plugins: ['session-watch', 'autopilot'],
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
- id: autopilot
  config:
    idleSeconds: 60
    startDelaySeconds: 1
`,
    });
    const api = (method, args) => scene.api(`dsh-plugin-autopilot/${method}`, args);
    const say = (start) => scene.say(start);
    const ids = {};
    ids.limits = await run.newSession({ project: 'harbor-gateway', title: 'Rate limit tuning', prompt: say('Raise the gateway') });
    ids.report = await run.newSession({ project: 'tide-ledger', title: 'October report', prompt: say('Write the October report') });
    ids.config = await run.newSession({ project: 'harbor-gateway', title: 'Config key rename', prompt: say('Rename the old config keys') });
    await api('setRule', { sessionId: ids.config, rule: 'ask' });
    ids.deploy = await run.newSession({ project: 'harbor-gateway', title: 'Release 2.3.1', prompt: say('Get v2.3.1 ready') });
    ids.changelog = await run.newSession({ project: 'tide-ledger', title: 'Changelog 0.9.2', prompt: say('Add the 0.9.2 changes') });
    await api('setRule', { sessionId: ids.changelog, rule: 'off' });
    ids.docs = await run.newSession({ project: 'atlas-docs', title: 'Deploy page proofread', prompt: say('Proofread the deploy page') });
    for (const id of Object.values(ids)) await run.idle(id);

    // Autopilot's own clock: a note after a minute of quiet, two notes without progress and it backs off.
    const state = () => api('state');
    await waitFor(async () => {
        const s = await state();
        const limits = s.sessions.find((x) => x.sessionId === ids.limits);
        const done = Boolean(limits) && !limits.work;
        const backed = s.sessions.find((x) => x.sessionId === ids.report)?.backedOff;
        const asked = s.asks.some((a) => a.sessionId === ids.config);
        return done && backed && asked;
    }, 'the notes, the back-off and the question', 420000, 2000);
    for (const id of Object.values(ids)) await run.idle(id);

    const page = await scene.open({ entry: 'Autopilot' });
    await page.getByRole('button', { name: 'Autopilot', exact: true }).first().click();
    await page.locator('[data-autopilot-page]').waitFor({ state: 'visible' });
    await page.locator('[data-autopilot-log] [data-autopilot-entry]').first().waitFor({ state: 'visible' });
    await scene.shoot('page');
    await scene.shoot('log', {
        themes: ['light'],
        prepare: (p) => p.locator('[data-autopilot-log]').evaluate((el) => el.scrollIntoView({ block: 'start' })),
    });
    await page.getByText('Rate limit tuning', { exact: true }).first().click();
    await page.getByText('That was the last todo.').first().waitFor({ state: 'visible' });
    await scene.shoot('chat', {
        themes: ['dark'],
        prepare: (p) => p.getByText('That was the last todo.').first().scrollIntoViewIfNeeded(),
    });
}
