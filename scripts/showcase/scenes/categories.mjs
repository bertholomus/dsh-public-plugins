/**
 * Categories: DSH's session list under category headers (Writing folded,
 * with the dot of the chat that runs in it), the Categories page with the
 * whole tree, a header's ⋯ menu at Add a workspace, and the chip at the top
 * of a chat.
 */
import { basename, join } from 'node:path';
import { waitFor } from '../stage.mjs';

export default async function categories(scene) {
    const run = await scene.start({
        plugins: ['categories'],
        files: { Notes: 'scripts/showcase/files/notes' },
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
`,
    });
    const api = (method, args) => scene.api(`dsh-plugin-categories/${method}`, args);
    const say = (start) => scene.say(start);
    const quick = (project, title) => run.newSession({ project, title, prompt: `${say('Small task:')} ${title}.` });
    const ids = {};
    ids.route = await run.newSession({ project: 'harbor-gateway', title: 'Invoices route', prompt: say('Add a route for /api/invoices') });
    ids.health = await quick('harbor-gateway', 'Health check path');
    ids.rounding = await quick('tide-ledger', 'Currency rounding');
    ids.import = await quick('tide-ledger', 'October import');
    ids.runbook = await quick('atlas-docs', 'Runbook typo');
    ids.notes = (await run.bridge('POST', '/sessions', { workspacePath: join(run.user, 'Notes'), title: 'Weekly notes', text: `${say('Small task:')} Weekly notes.` })).sessionId;
    for (const id of Object.values(ids)) await run.idle(id);
    await run.newSession({ project: 'atlas-docs', title: 'Handbook build', prompt: say('Build the handbook') });

    const ws = Object.fromEntries((await run.bridge('GET', '/workspaces')).map((w) => [basename(w.path), w.id]));
    const backend = (await api('createCategory', { name: 'Backend', workspace: ws['harbor-gateway'] })).category;
    await api('fileWorkspace', { workspace: ws['tide-ledger'], category: backend });
    const writing = (await api('createCategory', { name: 'Writing', workspace: ws['atlas-docs'] })).category;

    const page = await scene.open({ entry: 'Categories' });
    const head = (id) => page.locator(`[data-categories-sb="${id}"]`).first();
    await waitFor(async () => (await page.locator('[data-categories-sb]').count()) >= 3, 'the headers in the session list', 30000, 300);
    // Writing folded: its dot says a chat in it runs.
    await head(writing).click();
    await waitFor(async () => (await head(writing).getAttribute('aria-expanded')) === 'false', 'Writing folded', 5000, 200).catch(() => {});

    await page.getByRole('button', { name: 'Categories', exact: true }).first().click();
    const root = page.locator('[data-categories-page]');
    await root.waitFor({ state: 'visible' });
    // The page prints a workspace's folder with ~ for a home in its usual place (the Users folder on a Mac, home
    // on Linux). The demo home is a throwaway folder, so the scene writes ~ for it too, as the page does for a person.
    await page.evaluate((home) => {
        const tilde = () => {
            for (const meta of document.querySelectorAll('[data-categories-page] .dshc-tree-meta')) {
                for (const node of meta.childNodes) {
                    if (node.nodeType === 3 && node.nodeValue.startsWith(`${home}/`)) node.nodeValue = `~${node.nodeValue.slice(home.length)}`;
                }
            }
        };
        tilde();
        new MutationObserver(tilde).observe(document.body, { subtree: true, childList: true, characterData: true });
    }, run.user);
    await waitFor(async () => (await root.locator('[role="treeitem"]').count()) >= 6, 'the tree', 15000, 300);
    await scene.shoot('page', { prepare: (p) => p.locator('[data-categories-page] .dshc-pg-scroll').evaluate((el) => { el.scrollTop = 0; }).catch(() => {}) });

    // A header's ⋯ menu, at Add a workspace: the workspaces in no category first, then the others with where they are.
    await scene.shoot('menu', {
        themes: ['light'],
        still: true,
        prepare: async (p) => {
            await p.keyboard.press('Escape');
            await head(backend).focus();
            await p.keyboard.press('Shift+F10');
            const add = p.getByRole('menuitem', { name: 'Add a workspace', exact: true });
            await add.waitFor({ state: 'visible', timeout: 5000 });
            await add.focus();
            await p.keyboard.press('Enter');
            await waitFor(() => p.evaluate(() => [...document.querySelectorAll('[role="menu"]')].filter((m) => m.getClientRects().length > 0).length >= 2), 'the Add a workspace menu', 5000, 200);
        },
    });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // The chip at the top of a chat in a category, the chat opened from the page.
    await root.locator('.dshc-tree-title', { hasText: 'Invoices route' }).first().click();
    await page.locator('[data-categories-chip]').first().waitFor({ state: 'visible' });
    await scene.shoot('chip', { themes: ['dark'] });
}
