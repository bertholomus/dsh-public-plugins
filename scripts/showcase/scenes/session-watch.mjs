/**
 * Session Watch: its page in Plugins, with what it watches: sessions
 * running, waiting for approval, waiting for an answer, failed, and a month
 * of finished work; the idle ones listed, twelve more at a time, and then
 * the ones that wait for your answer.
 */
import { waitFor } from '../stage.mjs';

const DONE = [
    ['harbor-gateway', 'Health check path'], ['tide-ledger', 'CSV export'], ['atlas-docs', 'Glossary terms'],
    ['harbor-gateway', 'Route table cleanup'], ['tide-ledger', 'Account sort order'], ['atlas-docs', 'Broken links'],
    ['harbor-gateway', 'Request log format'], ['tide-ledger', 'Backup restore check'], ['atlas-docs', 'Onboarding page'],
    ['harbor-gateway', 'TLS certificate check'], ['tide-ledger', 'Currency rounding'], ['atlas-docs', 'Release notes 2.3'],
    ['harbor-gateway', 'Timeout defaults'], ['tide-ledger', 'Import dry run'], ['atlas-docs', 'Style guide'],
    ['harbor-gateway', '429 response body'], ['tide-ledger', 'Year-end checklist'], ['atlas-docs', 'Search box'],
    ['harbor-gateway', 'Header size limit'], ['tide-ledger', 'Duplicate entries'], ['atlas-docs', 'Page footer'],
    ['harbor-gateway', 'Graceful shutdown'], ['tide-ledger', 'Index on entry dates'], ['atlas-docs', 'Deploy page table'],
];

const ASKS = [
    ['harbor-gateway', 'Retry policy', 'Add retries'], ['atlas-docs', 'Handbook sidebar', 'Reorder the handbook'],
    ['tide-ledger', 'Fiscal year', 'Set the fiscal year'], ['harbor-gateway', 'Log retention', 'Choose how long'],
    ['atlas-docs', 'Deprecation notices', 'Mark the old API pages'],
];

export default async function sessionWatch(scene) {
    const run = await scene.start({
        plugins: ['session-watch', 'autopilot', 'decisions'],
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
- id: autopilot
  config:
    defaultRule: off
`,
    });
    const say = (start) => scene.say(start);
    // DSH asks an open window to approve; with none, it refuses at once. This stands in for the window until it opens.
    const prompts = await run.prompts();
    const ids = {};
    ids.failed = await run.newSession({ project: 'harbor-gateway', title: 'Error log summary', prompt: say('Summarise last night') });
    ids.done = await run.newSession({ project: 'atlas-docs', title: 'Runbook title', prompt: say('Fix the typo') });
    ids.todos = await run.newSession({ project: 'atlas-docs', title: 'Config names in docs', prompt: say('Update the getting-started page') });
    for (const id of Object.values(ids)) await run.idle(id).catch(() => {});
    // A month of small finished jobs: a list long enough that the section fills the window.
    for (let i = 0; i < DONE.length; i += 6) {
        const batch = await Promise.all(DONE.slice(i, i + 6).map(([project, title]) => run.newSession({ project, title, prompt: `Quick task: ${title}.` })));
        for (const id of batch) await run.idle(id);
    }
    // Questions that wait for an answer, in each project: the state the second picture lists.
    const asks = [];
    for (const [project, title, start] of ASKS) asks.push(await run.newSession({ project, title, prompt: say(start) }));
    ids.question = await run.newSession({ project: 'tide-ledger', title: 'Changelog format', prompt: say('Which changelog format') });
    ids.approval = await run.newSession({ project: 'harbor-gateway', title: 'Tag 2.3.1', prompt: say('Tag v2.3.1') });
    ids.running = await run.newSession({ project: 'tide-ledger', title: '2026 reconciliation', prompt: say('Reconcile every month') });
    const words = async () => new Map(((await scene.api('dsh-plugin-session-watch/sessions')).items ?? []).map((r) => [r.sessionId, r.word]));
    await waitFor(async () => {
        const w = await words();
        return w.get(ids.running) === 'running' && /approval/.test(w.get(ids.approval) ?? '')
            && [ids.question, ...asks].every((id) => /answer/.test(w.get(id) ?? '')) && w.size >= 6;
    }, 'each session in its state', 60000, 500);

    const page = await scene.open({ entry: 'Plugins' });
    await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
    await page.getByRole('button', { name: 'View Session Watch' }).click();
    const watching = page.locator('[data-session-watch-watching]');
    await watching.waitFor({ state: 'visible' });
    // Its section, at the top: the page above it names where this demo's plugins are linked from.
    const atTop = () => watching.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const choose = async (word) => {
        await watching.locator(`button[title$=" that read ${word}"]`).click();
        await watching.locator(`[data-session-watch-chosen="${word}"] li`).first().waitFor({ state: 'visible' });
    };
    await choose((await words()).get(ids.todos));
    await watching.locator('[data-session-watch-more]').click();
    await waitFor(async () => (await watching.locator('[data-session-watch-chosen] li').count()) >= 24, 'twelve more sessions', 10000, 200);
    await scene.shoot('watching', { prepare: atTop });
    // Where that picture has the page's Current version row (the row under the plugin's folder): the next has it
    // there too.
    const versionAt = await watching.evaluate((el) => {
        let pane = el.parentElement;
        while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
        const label = pane && [...pane.querySelectorAll('*')].find((n) => n.childElementCount === 0 && n.textContent.trim() === 'Current version');
        return label ? label.getBoundingClientRect().top - pane.getBoundingClientRect().top : null;
    });
    // Another state: the sessions that wait for your answer, as their rows in the session list say too. The page
    // is shorter now, so the pane gets just the room it needs at its end to scroll as far as the first picture.
    await choose((await words()).get(ids.question));
    await scene.shoot('list', {
        themes: ['dark'],
        prepare: () => watching.evaluate((el, at) => {
            let pane = el.parentElement;
            while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
            if (!pane) return el.scrollIntoView({ block: 'start' });
            const label = [...pane.querySelectorAll('*')].find((n) => n.childElementCount === 0 && n.textContent.trim() === 'Current version');
            const [mark, offset] = label && at !== null ? [label, at] : [el, 0];
            const target = pane.scrollTop + mark.getBoundingClientRect().top - pane.getBoundingClientRect().top - offset;
            const short = Math.ceil(target + pane.clientHeight - pane.scrollHeight);
            if (short > 0) {
                const room = document.createElement('div');
                room.style.cssText = `height:${short}px;flex:none`;
                pane.append(room);
            }
            pane.scrollTop = target;
        }, versionAt),
    });
    prompts.close();
}
