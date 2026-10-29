/**
 * Agent Terminals: three coding agents (a small terminal agent, `coder`, in
 * the demo home's PATH) at work in the demo projects: one done, one waiting
 * on a decision, one still building; then one agent's terminal tab beside
 * its session.
 */
import { accessSync, chmodSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { here, waitFor } from '../stage.mjs';

/** A Node for the agent: DSH's own runs as Node only with a flag the terminal does not pass. */
function nodeBin() {
    for (const dir of String(process.env.PATH ?? '').split(delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin'])) {
        try {
            accessSync(join(dir, 'node'), constants.X_OK);
            return join(dir, 'node');
        } catch {}
    }
    throw new Error('no node on PATH for the demo agent');
}
const quoted = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

export default async function agentTerminals(scene) {
    const run = await scene.start({
        plugins: ['session-watch', 'agent-terminals'],
        before: (r) => {
            const bin = join(r.user, '.local', 'bin');
            mkdirSync(bin, { recursive: true });
            writeFileSync(join(bin, 'coder'), `#!/bin/sh\nexec ${quoted(nodeBin())} ${quoted(join(here, 'demo-agent.mjs'))} "$@"\n`);
            chmodSync(join(bin, 'coder'), 0o755);
            // The terminal's shell: a plain prompt with the folder, and none of this computer's own shell setup.
            writeFileSync(join(r.user, '.zshrc'), "PROMPT='%F{8}%~%f %# '\n");
            r.env = { ...r.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ZDOTDIR: r.user, SHELL: '/bin/zsh', DEMO_AGENT_SCRIPT: join(here, 'demo.json') };
        },
        rows: `- id: permission
  config:
    defaultPreset: workspace-write
`,
    });
    const api = (method, args) => scene.api(`dsh-plugin-agent-terminals/${method}`, args);
    await waitFor(async () => (await run.api('dsh-plugin-agent-terminals/state')).ok, 'Agent Terminals', 30000, 300);
    const start = async (input) => {
        const r = await api('start', { input: { program: 'coder', style: 'flags', ...input } });
        if (r.problem) throw new Error(`start: ${JSON.stringify(r.problem)}`);
        return r.agent;
    };
    const docs = await start({ folder: '~/Projects/atlas-docs', name: 'Handbook build', task: 'Build the handbook and check every link.' });
    const ledger = await start({ folder: '~/Projects/tide-ledger', name: 'October import', task: 'Re-import the October entries from the bank export.' });
    const gateway = await start({ folder: '~/Projects/harbor-gateway', name: 'Gateway fix', task: 'Run the gateway tests and fix what fails.' });
    const statusOf = async (key) => (await api('state')).agents.find((a) => a.key === key)?.status;
    await waitFor(async () => (await statusOf(gateway.key)) === 'idle' && (await statusOf(ledger.key)) === 'waiting on you' && (await statusOf(docs.key)) === 'working',
        'one agent idle, one waiting on you, one working', 90000, 500);
    for (const id of [gateway.sessionId, ledger.sessionId, docs.sessionId]) await run.idle(id);

    const page = await scene.open({ entry: 'Coding agents' });
    await page.getByRole('button', { name: 'Coding agents', exact: true }).first().click();
    await page.locator('[data-agent-terminals-page]').waitFor({ state: 'visible' });
    await waitFor(async () => (await page.locator('[data-agent-terminals-ask]').count()) > 0, 'the question on the page', 15000, 300);
    const top = (p) => p.locator('[data-agent-terminals-page]').evaluate((el) => { el.scrollTop = 0; });
    await scene.shoot('page', { prepare: top });

    await page.locator(`[data-row-key="session:${gateway.sessionId}"]`).first().click();
    await page.locator('[role="tab"]', { hasText: 'Gateway fix' }).first().waitFor({ state: 'visible' });
    const rows = page.locator('.xterm-rows:visible').first();
    await waitFor(async () => (await rows.count()) && /All 12 tests pass/.test((await rows.innerText()).replace(/\s+/g, ' ')), 'the agent\'s screen in its tab', 20000, 300);
    await scene.shoot('terminal', { themes: ['dark'] });
}
