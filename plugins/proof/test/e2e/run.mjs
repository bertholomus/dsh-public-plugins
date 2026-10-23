#!/usr/bin/env node
/**
 * Proof in a real DSH: claims judged from a scripted model's real sessions
 * (real commands in a real workspace), flagged on their turns in a real
 * window, kept in a ledger that exports, and checked in read-only threads.
 *
 * DSH runs from a throwaway DSH_HOME (test/e2e/harness.mjs) with the session
 * bridge, Session Watch and Proof, and a scripted model (./fake-model.mjs)
 * that plays the agent: its turns run real `node --test`, `ls` and `write`
 * calls in the bench's workspace. The check model is a second model of the
 * same scripted provider (`fake-check`, named "Fake Check", with a low and a
 * high effort), so every request a check makes is seen, and DSH's default
 * model stays `fake-model`.
 *
 * - The browser half is served and parses; the endpoints answer (the check
 *   model named as DSH's model menu names it), and refuse bad input in words.
 * - Claims: a test count the run shows (quiet), a summary leaning on the turn
 *   before (quiet), "All tests pass" with no test run (flagged), "All tests
 *   pass" after a failing run (contradicted), "Deployed to staging" after an
 *   `ls` (flagged), a reply that only asks (no claim).
 * - The window: each flag on its turn, with its words, inline code drawn as
 *   code and nothing said twice; none where the turn shows its claims; light
 *   and dark pictures.
 * - A check from the flag: the focus goes to the check's line; a new thread
 *   titled "Proof check · …", read-only before its first turn (DSH's
 *   read-only file policy and approvals that never ask, in its own log), on
 *   the check model at low effort for that thread only (the default model
 *   unchanged), offered only tools that read or run; Proof's guard refuses a
 *   commit, the file policy stops a write, and the checked session gets
 *   nothing. Its NOT VERIFIED heads the flag, with the reason on its line;
 *   the check thread's own note, with no way into itself; the way back.
 * - A check from the page's ledger (VERIFIED): the focus goes to its line,
 *   and the claim stays in view with its answer; its flag is then headed
 *   "Verified by an independent check", and the claim is counted apart on
 *   the ledger, its session's row, the page's header and the exports.
 * - While a check runs, its thread says above the message box what it
 *   checks; its limit changed meanwhile, it still stops at the minutes it
 *   was given, and says so.
 * - By itself, set in Plugins, checks a new flagged claim and leaves the
 *   older ones; past the hour's limit a check waits, and switching checks
 *   Off ends it; the page then offers Proof's settings.
 * - The page: header, sessions, ledger filter, what the turn ran, the
 *   checks (newest first, their times in one column), What happened; export
 *   as Markdown, CSV and JSON (real downloads) and Copy (logged as a copy);
 *   a narrow window.
 * - Its settings in Plugins (DSH's own form): a choice saved and noted, a
 *   value out of range refused.
 * - A restart under a running check: the check settles at once, saying DSH
 *   restarted while it ran.
 * - Proof switched off and on in Plugins: DSH reports no failure; its entry
 *   and flags go and come back.
 * - Without Session Watch, the page still follows new claims.
 * - A wrong setting: Proof starts, flags nothing, refuses checks, and its
 *   page says which setting; fixed through the form.
 * - `enabled: false`: idle, and its page says so; a session made and one
 *   used while it was off are listed again once it is back on.
 * - Its folder is 700 and its files 600.
 *
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node plugins/proof/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/; `node scripts/e2e.mjs
 * proof` runs it on each of those and on the installed app's own DSH.
 * SHOTS=<folder> keeps the window's pictures there (default
 * .e2e/shots/proof/<version>); KEEP=1 keeps the throwaway DSH_HOME. Without
 * Playwright the run fails, unless NO_WINDOW=1 says to run without the
 * window checks.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { DshRun, checks, dshBin, findPlaywright, modeOf, openWindow, pluginsDir, repoRoot, setDark, shot, sleep, waitFor } from '../../../../test/e2e/harness.mjs';
import { startProofModel } from './fake-model.mjs';

const bin = dshBin();
if (!bin) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'proof', version);
console.log(`# DSH ${version}: ${bin}`);
console.log(`# pictures: ${shots}`);

const tally = checks();
const { check, step } = tally;
const model = await startProofModel();
const json = (value) => JSON.stringify(value);

/** A Node for the scripted agent's commands: never the app's own binary (run as a program, it would start the app). */
function realNode() {
    if (!process.execPath.includes('.app/')) return process.execPath;
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        const candidate = join(dir, 'node');
        if (dir && !candidate.includes('.app/') && existsSync(candidate)) return candidate;
    }
    return 'node';
}
const NODE = realNode();

/** The checks this test asks for, at most, in the first hour (the fifth waits). */
const PER_HOUR = 4;
/** The profile's rows: new sessions on Workspace Write, Session Watch, and Proof's settings. */
const rowsWith = ({ proof = {}, off = [] } = {}) => `- id: permission
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
- id: session-watch
${off.includes('session-watch') ? '  disabled: true\n' : ''}  config:
    deliveryTimeoutSeconds: 60
- id: proof
  config:
${Object.entries({ verifierProvider: 'fake', verifierModel: 'fake-check', verifierMinutes: 1, verifierPerHour: PER_HOUR, ...proof }).map(([key, value]) => `    ${key}: ${json(value)}`).join('\n')}
`;
const run = new DshRun({
    label: 'proof',
    bin,
    plugins: {
        'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge'),
        'dsh-plugin-session-watch': join(pluginsDir, 'session-watch'),
        'dsh-plugin-proof': join(pluginsDir, 'proof'),
    },
});
run.rows = rowsWith();

/**
 * The bench's profile, with a second model in the scripted provider for the
 * check threads: one with reasoning efforts (low and high), so a check's
 * request shows the effort Proof asked for.
 */
function writeProfile() {
    run.writeProfile(model.port);
    const file = join(run.profile, 'cordis.patch.yml');
    const text = readFileSync(file, 'utf8');
    const line = '            reasoningEfforts: false\n';
    const checkModel = '          - id: fake-check\n            name: Fake Check\n            contextWindow: 131072\n            reasoningEfforts:\n              low: low\n              high: high\n';
    writeFileSync(file, text.replace(line, `${line}${checkModel}`));
}
/** DSH's default model, as its profile keeps it. */
const defaultModel = () => /- id: agent-default-model\n(?: {2}.*\n)*/.exec(readFileSync(join(run.profile, 'cordis.patch.yml'), 'utf8'))?.[0] ?? '';

/** Start DSH again with other rows (the settings a person would have in the profile). */
async function restartWith(rows, what) {
    await run.stop();
    run.rows = rows;
    writeProfile();
    await run.boot(what);
}
/** Quit DSH and start it again with the profile as it is. */
async function restart(what) {
    await run.stop();
    await run.boot(what);
}

// The workspace the scripted agent works in: a module, its passing tests and a failing one.
writeFileSync(join(run.ws, 'calc.mjs'), 'export const add = (a, b) => a + b;\n');
writeFileSync(join(run.ws, 'calc.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './calc.mjs';
test('adds two numbers', () => assert.equal(add(2, 3), 5));
test('adds a negative number', () => assert.equal(add(2, -3), -1));
`);
writeFileSync(join(run.ws, 'broken.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './calc.mjs';
test('adds two numbers', () => assert.equal(add(2, 3), 5));
test('adds numbers given as words', () => assert.equal(add('2', '3'), 5));
`);

const api = (method, args = {}) => run.api(`dsh-plugin-proof/${method}`, args);
const value = async (method, args) => {
    const r = await api(method, args);
    if (!r.ok) throw new Error(`${method}: ${json(r.error)}`);
    return r.value;
};
const pageState = () => value('state');
const ledgerOf = (sessionId) => value('ledger', { sessionId });
const sessionOf = (sessionId) => value('session', { sessionId });
const turnsEnded = (sessionId, n, timeout = 30000) => waitFor(async () => {
    const s = await run.session(sessionId);
    return s.status !== 'running' && s.turns.ended >= n && s.turns.started === s.turns.ended ? s : null;
}, `${sessionId} to finish turn ${n}`, timeout);
const say = (text) => `E2E:say ${text}`;
const turn = (calls, reply) => `E2E:turn ${json({ calls, reply })}`;
const bash = (command, description) => ({ tool: 'bash', args: { command, description } });
const write = (file, content) => ({ tool: 'write', args: { file_path: join(run.ws, file), content } });
/** A claim's check, as Proof keeps it. */
const checkOf = async (sessionId, claimId) => (await sessionOf(sessionId)).checks.find((c) => c.claimId === claimId);
const ACTIVE = new Set(['queued', 'running']);
const settled = (sessionId, claimId, timeout = 30000) => waitFor(async () => {
    const c = await checkOf(sessionId, claimId);
    return c && !ACTIVE.has(c.state) ? c : null;
}, `the check of ${claimId} in ${sessionId} to settle`, timeout, 300);
const flaggedOf = async (sessionId) => (await ledgerOf(sessionId)).claims.filter((c) => c.verdict !== 'backed');
const historyHas = async (pattern) => (await pageState()).history.some((e) => pattern.test(`${e.text} ${e.why ?? ''}`));

const ours = (errors) => errors.filter((text) => /proof|session-watch|suite-kit/i.test(text));

let window;
let pw;
const ids = {};
const claims = {};
try {
    writeProfile();
    await run.boot('first start');
    await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints', 30000);

    // ── The browser half and the endpoints ─────────────────────────────
    await step('DSH serves Proof\'s browser half and it parses', async () => {
        const client = await run.clientOf('dsh-plugin-proof');
        let parses = false;
        try {
            new Script(client.text);
            parses = true;
        } catch {}
        check('DSH serves Proof\'s browser half and it parses, with its turn flag', client.status === 200 && parses && client.text.includes('conversation.chat.turnTail'), `${client.url ?? 'not in the boot graph'}: ${client.status}`);
    });
    await step('the endpoints answer, and refuse bad input in words', async () => {
        const s = await pageState();
        check('the state endpoint answers: on, flags on, checks when you press Check, on the check model (named as DSH\'s model menu names it), nothing yet',
            s.enabled === true && !s.problem && s.flags === true && s.verifier.mode === 'ask' && s.verifier.model === 'fake-check' && s.verifier.provider === 'fake'
            && s.verifier.modelName === 'Fake Check' && s.verifier.providerName === 'Fake'
            && s.verifier.minutes === 1 && s.verifier.perHour === PER_HOUR && s.sessions.length === 0 && s.checks.length === 0,
            json({ enabled: s.enabled, problem: s.problem, flags: s.flags, verifier: s.verifier, sessions: s.sessions.length }));
        const noClaim = await api('check', { sessionId: 'session-nobody', claimId: '' });
        const noSession = await api('ledger', { sessionId: '' });
        const badFormat = await api('exportLedger', { sessionId: 'session-nobody', format: 'pdf' });
        check('bad input is refused with words a person can act on',
            noClaim.ok === false && noClaim.error?.message === 'Name the claim to check.'
            && noSession.ok === false && noSession.error?.message === 'Name the session.'
            && badFormat.ok === false && badFormat.error?.message === 'Export as Markdown, CSV or JSON.',
            json([noClaim.error, noSession.error, badFormat.error]));
    });

    // ── Sessions the scripted agent works in ──────────────────────────
    const before = defaultModel();
    ids.tests = await run.newSession(`Run the calculator tests.\n${turn([bash(`${NODE} --test calc.test.mjs`, 'Run the calculator tests')], 'All 2 tests pass.')}`, 'Calculator tests');
    ids.subtract = await run.newSession(`Add a subtract helper.\n${turn([write('subtract.mjs', 'export const subtract = (a, b) => a - b;\n')], 'Added `subtract` in subtract.mjs. All tests pass.')}`, 'Add subtract');
    ids.broken = await run.newSession(`Fix the word test.\n${turn([bash(`${NODE} --test broken.test.mjs`, 'Run the word tests')], 'All tests pass.')}`, 'Broken tests');
    ids.deploy = await run.newSession(`Ship it to staging.\n${turn([bash('ls -1', 'List the files')], 'Deployed to staging.')}`, 'Staging deploy');
    ids.question = await run.newSession(say('Which branch should I use for this?'), 'Branch question');
    for (const id of Object.values(ids)) await turnsEnded(id, 1);
    // A second turn that asks for no new work: its claim leans on the turn before.
    await run.bridge('POST', `/sessions/${encodeURIComponent(ids.tests)}/prompt`, { text: `Thanks, can you summarize?\n${say('All 2 tests pass.')}` });
    await turnsEnded(ids.tests, 2);

    await step('claims are judged against what each turn ran', async () => {
        const tests = await ledgerOf(ids.tests);
        const t1 = tests.claims.find((c) => c.turn === 1);
        const t2 = tests.claims.find((c) => c.turn === 2);
        check('"All 2 tests pass." after a run of 2 passing tests is shown by the turn: quiet', t1?.verdict === 'backed' && t1.kind === 'passed', json(tests.claims));
        check('the same claim in a summary turn that ran nothing is shown by the turn before it', t2?.verdict === 'backed' && t2.from === 1, json(t2));
        const subtract = await ledgerOf(ids.subtract);
        const added = subtract.claims.find((c) => c.kind === 'done');
        claims.subtract = subtract.claims.find((c) => c.kind === 'passed');
        check('"Added `subtract`…" with a write in the turn is shown; "All tests pass." with no test run is flagged, saying why',
            added?.verdict === 'backed' && claims.subtract?.verdict === 'unbacked' && claims.subtract.why === 'No test ran in this turn.', json(subtract.claims));
        const broken = await ledgerOf(ids.broken);
        claims.broken = broken.claims[0];
        check('"All tests pass." after a failing run is contradicted, with the run\'s own words as evidence',
            broken.claims.length === 1 && claims.broken.verdict === 'contradicted' && /did not pass/.test(claims.broken.why) && claims.broken.evidence.length > 0, json(broken.claims));
        const deploy = await ledgerOf(ids.deploy);
        claims.deploy = deploy.claims[0];
        check('"Deployed to staging." after an ls is flagged: no deploy ran', deploy.claims.length === 1 && claims.deploy.verdict === 'unbacked' && /deploy/i.test(claims.deploy.why) && claims.deploy.kind === 'deployed', json(deploy.claims));
        check('what each turn ran is kept with its claims', (claims.broken.ran ?? []).some((r) => r.includes('--test broken.test.mjs')) && (claims.deploy.ran ?? []).some((r) => r.includes('ls -1')), json([claims.broken.ran, claims.deploy.ran]));
        const question = await ledgerOf(ids.question);
        check('a reply that only asks makes no claim', question.claims.length === 0, json(question.claims));
        // DSH's session list is read at most every two seconds.
        const four = [ids.tests, ids.subtract, ids.broken, ids.deploy].sort().join();
        const listedAt = Date.now();
        const s = await waitFor(async () => { const now = await pageState(); return now.sessions.map((r) => r.sessionId).sort().join() === four ? now : undefined; }, 'the four sessions on the page', 10000, 250).catch(() => pageState());
        const listed = s.sessions.map((r) => r.sessionId).sort().join();
        console.log(`# the four sessions were on the page after ${Date.now() - listedAt} ms`);
        check('the page lists the four sessions with claims, with their flagged counts, and not the one without',
            listed === four && s.sessions.find((r) => r.sessionId === ids.tests)?.flagged === 0
            && s.sessions.find((r) => r.sessionId === ids.broken)?.contradicted === 1, json(s.sessions));
    });

    // ── A check from the flag, in its read-only thread ────────────────
    model.setPlan('Staging deploy', {
        calls: [
            // DSH adds its own subagent tool to every thread, where no plugin can take it away: the guard must refuse it.
            { tool: 'subagent', args: { description: 'Look for a deploy', prompt: 'Find where this was deployed.' }, optional: true },
            bash('git commit -am "proof was here"', 'Commit the work'),
            bash('touch proof-was-here.txt', 'Mark the folder'),
            bash('ls -1', 'List the files'),
        ],
        reply: 'Nothing here shows a deploy.\nNOT VERIFIED: no deploy command or staging address appears in the workspace.',
    });
    model.setPlan('Add subtract', { calls: [bash(`${NODE} --test calc.test.mjs`, 'Run the calculator tests')], reply: 'The tests ran again.\nVERIFIED: the calculator tests pass when run again (2 of 2).' });
    model.setPlan('Release notes', { reply: 'NOT VERIFIED: no publish ran in that turn or since.' });
    model.setPlan('Broken tests', { slow: true });
    const deployMessages = (await run.events(ids.deploy)).filter((e) => e.type === 'user/message').length;

    pw = await findPlaywright();
    if (!pw) {
        check('Playwright is here for the window checks (NO_WINDOW=1 runs without them)', process.env.NO_WINDOW === '1', 'install it: npm i --prefix .e2e/tools playwright-core (or set PLAYWRIGHT_MODULE)');
        // Without the window the checks are asked for through the endpoints.
        await api('check', { sessionId: ids.deploy, claimId: claims.deploy.id });
        await api('check', { sessionId: ids.subtract, claimId: claims.subtract.id });
    }
    const openProof = async (page) => {
        await page.getByRole('button', { name: 'Proof', exact: true }).first().click();
        await page.locator('[data-proof-page]').waitFor({ state: 'visible', timeout: 20000 });
    };
    /** A session's ledger on the page, once it has read the session's claims. */
    const openLedger = async (page, sessionId) => {
        await page.locator(`[data-proof-session="${sessionId}"]`).click();
        const ledger = page.locator(`[data-proof-ledger="${sessionId}"]`);
        await ledger.waitFor({ state: 'visible', timeout: 15000 });
        await ledger.locator('[data-proof-said]').waitFor({ state: 'attached', timeout: 15000 });
        return ledger;
    };
    /** A session's chat, opened from its ledger's "Open the session". */
    const openChat = async (page, sessionId) => {
        await openProof(page);
        const ledger = await openLedger(page, sessionId);
        await ledger.getByRole('button', { name: 'Open the session', exact: true }).click();
        await page.locator('[data-proof-page]').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    };
    const flagsShown = (page) => page.locator('[data-proof-flag]').filter({ visible: true });
    /** Where the window's focus is: the element, and the check line, claim, flag and ledger it is in. */
    const focusIn = (page) => page.evaluate(() => {
        const el = document.activeElement;
        const near = (selector, attr) => el?.closest?.(selector)?.getAttribute(attr) ?? null;
        return {
            tag: el?.tagName ?? '',
            check: near('[data-proof-check]', 'data-proof-check'),
            claim: near('[data-proof-claim]', 'data-proof-claim'),
            flag: near('[data-proof-flag]', 'data-proof-flag'),
            ledger: near('[data-proof-ledger]', 'data-proof-ledger'),
        };
    });
    /** The focus once it is on a check's line (or where it is after 10 s). */
    const focusOnLine = (page) => waitFor(async () => {
        const at = await focusIn(page);
        return at.check ? at : null;
    }, 'the focus on the check\'s line', 10000, 100).catch(() => focusIn(page));
    /** Words without Markdown's backquotes and with one space, to tell whether two say the same. */
    const bare = (text) => String(text ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (pw) {
        await step('each flag on its turn, with its words; none where the turn shows its claims', async () => {
            window = await openWindow(run, pw, { entry: 'Proof' });
            const { page, context } = window;
            await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
            await openChat(page, ids.deploy);
            const deploy = flagsShown(page).first();
            await deploy.waitFor({ state: 'visible', timeout: 20000 });
            const deployText = (await deploy.innerText()).replace(/\n+/g, ' ');
            check('a claim nothing in its turn shows gets a card after the turn: what, why, and the way to check it',
                (await deploy.getAttribute('data-proof-flag')) === 'unbacked' && /Proof · Nothing in this turn shows this/.test(deployText)
                && deployText.includes('“Deployed to staging.”') && /No deploy[^.]* ran in this turn\./.test(deployText)
                && (await deploy.getByRole('button', { name: 'Check it', exact: true }).count()) === 1 && (await deploy.getByRole('button', { name: 'Open in Proof', exact: true }).count()) === 1,
                deployText);
            check('one card for the session\'s one flagged turn', (await flagsShown(page).count()) === 1, String(await flagsShown(page).count()));
            await shot(page, shots, 'flag-unbacked-light', deploy);
            await setDark(page, true);
            await shot(page, shots, 'flag-unbacked-dark', deploy);
            await setDark(page, false);

            await openChat(page, ids.broken);
            const broken = flagsShown(page).first();
            await broken.waitFor({ state: 'visible', timeout: 20000 });
            const brokenText = (await broken.innerText()).replace(/\n+/g, ' ');
            check('a claim the turn\'s own output contradicts says so, with what the turn shows',
                (await broken.getAttribute('data-proof-flag')) === 'contradicted' && /Proof · This turn's own output says otherwise/.test(brokenText) && brokenText.includes('“All tests pass.”')
                && bare(brokenText).includes(bare(claims.broken.why)), brokenText);
            // The evidence the why already quotes is not given again; inline code is drawn as code, without its backquotes.
            const fresh = claims.broken.evidence.filter((e) => !bare(claims.broken.why).includes(bare(e)));
            const shows = /What the turn shows: (.*)$/.exec(brokenText)?.[1] ?? '';
            const codeSpans = (`${claims.broken.why} ${fresh.join(' ')}`.match(/`[^`\n]+`/g) ?? []).length;
            check('it says each thing once: "What the turn shows" only for what the why does not already give; commands drawn as code',
                (fresh.length === 0 ? !brokenText.includes('What the turn shows') : fresh.every((e) => bare(shows).includes(bare(e))))
                && !brokenText.includes('`') && (await broken.locator('code.dshpf-code').count()) === codeSpans,
                `${brokenText} | why: ${claims.broken.why} | evidence: ${json(claims.broken.evidence)}`);
            await shot(page, shots, 'flag-contradicted-light', broken);
            await setDark(page, true);
            await shot(page, shots, 'flag-contradicted-dark', broken);
            await setDark(page, false);

            await openChat(page, ids.subtract);
            const subtract = flagsShown(page).first();
            await subtract.waitFor({ state: 'visible', timeout: 20000 });
            const subtractText = (await subtract.innerText()).replace(/\n+/g, ' ');
            check('in a turn with a shown claim and an unshown one, the card names only the unshown one',
                subtractText.includes('“All tests pass.”') && subtractText.includes('No test ran in this turn.') && !subtractText.includes('subtract'), subtractText);

            await openChat(page, ids.tests);
            await page.getByText('All 2 tests pass.').first().waitFor({ state: 'visible', timeout: 20000 });
            await page.waitForTimeout(1500);
            check('a session whose turns show their claims has no card, on either turn', (await flagsShown(page).count()) === 0, String(await flagsShown(page).count()));
            await shot(page, shots, 'quiet-light');
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-flags');
        });

        await step('Check it on the flag: a read-only thread on the check model answers NOT VERIFIED, with its reason', async () => {
            const { page } = window;
            await openChat(page, ids.deploy);
            const deploy = flagsShown(page).first();
            await deploy.waitFor({ state: 'visible', timeout: 20000 });
            await deploy.getByRole('button', { name: 'Check it', exact: true }).click();
            const focused = await focusOnLine(page);
            check('after Check it the focus goes to the check\'s line in the flag, not back to the top of the page',
                focused.check !== null && focused.claim === claims.deploy.id && focused.flag !== null, json(focused));
            const done = await settled(ids.deploy, claims.deploy.id, 40000);
            check('the check settles as not verified, with the check model\'s reason; it ran on the check model as DSH names it, at low effort, with its minutes',
                done.state === 'not-verified' && done.reason === 'no deploy command or staging address appears in the workspace.'
                && done.model === 'Fake Check from Fake' && /^low$/i.test(done.effort ?? '') && done.minutes === 1, json(done));
            const line = deploy.locator('[data-proof-check]');
            await waitFor(async () => (await line.getAttribute('data-proof-check')) === 'not-verified', 'the flag to show the verdict', 15000, 300);
            const lineText = (await line.innerText()).replace(/\n+/g, ' ');
            const deployText = (await deploy.innerText()).replace(/\n+/g, ' ');
            check('the verdict heads the flag, said once; its line gives the reason and the way to the check, and it offers to check again',
                (await deploy.getAttribute('data-proof-flag')) === 'not-verified' && deployText.startsWith('Proof · Not verified by an independent check')
                && deployText.match(/not verified/gi)?.length === 1 && lineText.startsWith('no deploy command or staging address appears in the workspace.')
                && (await line.getByRole('button', { name: 'Open the check', exact: true }).count()) === 1
                && (await deploy.getByRole('button', { name: 'Check again', exact: true }).count()) === 1, deployText);
            check('the focus is still on the check\'s line now that it answered', (await focusIn(page)).claim === claims.deploy.id && (await focusIn(page)).check === 'not-verified', json(await focusIn(page)));
            await shot(page, shots, 'flag-checked-light', deploy);
            await setDark(page, true);
            await shot(page, shots, 'flag-checked-dark', deploy);
            await setDark(page, false);
            // The check thread: its own note, and the way back.
            await line.getByRole('button', { name: 'Open the check', exact: true }).click();
            const note = page.locator('[data-proof-flag="check"]').filter({ visible: true }).first();
            await note.waitFor({ state: 'visible', timeout: 20000 });
            const noteText = (await note.innerText()).replace(/\n+/g, ' ');
            check('the check thread says what it checks and from where, that it cannot write, and how it ended, with no way into itself',
                /Proof · An independent check/.test(noteText) && noteText.includes('This thread checks “Deployed to staging.” from turn 1 of “Staging deploy”. It can read and run commands, but nothing it runs can write a file.')
                && /not verified\s*no deploy command or staging address appears in the workspace\./.test(noteText)
                && (await note.getByRole('button', { name: 'Open the check', exact: true }).count()) === 0, noteText);
            check('once its check has ended, nothing sits above the check thread\'s message box', (await page.locator('[data-proof-dock]').count()) === 0);
            check('the check thread\'s own replies are not judged: no flag in it', (await page.locator('[data-proof-flag="unbacked"], [data-proof-flag="contradicted"]').filter({ visible: true }).count()) === 0);
            await shot(page, shots, 'check-thread-light');
            await setDark(page, true);
            await shot(page, shots, 'check-thread-dark');
            await setDark(page, false);
            await note.getByRole('button', { name: 'Open the checked session', exact: true }).click();
            await flagsShown(page).first().waitFor({ state: 'visible', timeout: 20000 });
            check('"Open the checked session" goes back to the flagged turn', (await flagsShown(page).first().innerText()).includes('“Deployed to staging.”'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-check');
        });
    }

    await step('the check thread was read-only from its first turn, on the check model, and left the checked session alone', async () => {
        const c = await settled(ids.deploy, claims.deploy.id, 40000);
        const thread = c.checkSessionId;
        const summary = await run.session(thread);
        check('the check runs in a new session titled "Proof check · …"', typeof thread === 'string' && /^Proof check · Deployed to staging\./.test(summary.title ?? ''), json(summary.title));
        const saved = run.savedEvents(thread);
        const firstMessage = saved.findIndex((e) => e.type === 'user/message');
        const mode = saved.findIndex((e) => e.type === 'sandbox/mode' && e.data?.mode === 'read-only');
        const policy = saved.findIndex((e) => e.type === 'approval/policy' && e.data?.policy === 'never');
        const selections = saved.filter((e) => e.type === 'model/selection').map((e) => JSON.stringify(e.data ?? {}));
        check('before its first message, DSH\'s own log sets its file policy to read-only and its approvals to never',
            firstMessage > 0 && mode >= 0 && mode < firstMessage && policy >= 0 && policy < firstMessage, json(saved.slice(0, 12).map((e) => e.type)));
        check('its model is chosen for that thread only: the check model', selections.length > 0 && selections.every((s) => s.includes('"fake-check"') && s.includes('"fake"')), json(selections));
        const asked = model.requests.filter((r) => r.anchor.includes('Proof check.') && r.anchor.includes('Staging deploy'));
        const allowed = new Set(['read', 'read_image', 'grep', 'glob', 'bash', 'pwsh', 'job_output', 'job_list', 'todo_write', 'web_fetch', 'web_search']);
        const offered = [...new Set(asked.flatMap((r) => r.tools))];
        check('every request of the check went to the check model, offering only tools that read or run (and DSH\'s own subagent tool)',
            asked.length >= 4 && asked.every((r) => r.model === 'fake-check') && offered.includes('bash') && offered.every((t) => allowed.has(t) || t === 'subagent') && !offered.includes('write') && !offered.includes('edit'),
            json({ models: asked.map((r) => r.model), offered }));
        const agentAsked = model.requests.filter((r) => !r.anchor.includes('Proof check.'));
        check('every request of the check asked for low effort (the lowest the check model offers); the sessions\' own requests asked for none',
            asked.every((r) => r.effort === 'low') && agentAsked.length > 0 && agentAsked.every((r) => r.effort === undefined),
            json({ check: asked.map((r) => r.effort), sessions: [...new Set(agentAsked.map((r) => String(r.effort)))] }));
        if (offered.includes('subagent')) {
            check('the guard refused DSH\'s subagent tool in the check thread, saying why', JSON.stringify(run.savedEvents(c.checkSessionId)).includes('Proof\'s check threads only read and run commands, so subagent is refused.'));
        }
        const refusal = 'Refused: git commit changes the repository, and a check only reads and runs. Check without changing anything.';
        check('Proof\'s guard refused the commit, saying why, and the thread heard it', JSON.stringify(saved).includes(refusal), saved.filter((e) => /tool/.test(e.type)).map((e) => JSON.stringify(e.data).slice(0, 300)).join('\n'));
        check('DSH\'s read-only file policy stopped the write: no file was made', !existsSync(join(run.ws, 'proof-was-here.txt')));
        check('the checked session got nothing from the check', (await run.events(ids.deploy)).filter((e) => e.type === 'user/message').length === deployMessages);
        check('DSH\'s default model is unchanged', defaultModel() === before && before.includes('model: fake-model'), defaultModel());
    });

    // ── A check from the page's ledger, the page, export ──────────────
    if (pw) {
        await step('Check from the ledger: VERIFIED, on the page and in What happened', async () => {
            const { page } = window;
            await openProof(page);
            const ledger = await openLedger(page, ids.subtract);
            const row = ledger.locator(`[data-proof-claim="${claims.subtract.id}"]`);
            await row.getByRole('button', { name: 'Check', exact: true }).click();
            const focused = await focusOnLine(page);
            check('after Check the focus goes to the claim\'s check line in the ledger', focused.check !== null && focused.claim === claims.subtract.id && focused.ledger === ids.subtract, json(focused));
            const done = await settled(ids.subtract, claims.subtract.id, 40000);
            check('the check settles as verified, with the reason', done.state === 'verified' && done.reason === 'the calculator tests pass when run again (2 of 2).', json(done));
            await waitFor(async () => (await row.getAttribute('data-proof-state')) === 'verified', 'the ledger row to show verified', 15000, 300);
            const rowText = (await row.innerText()).replace(/\n+/g, ' ');
            const lineText = (await row.locator('[data-proof-check]').innerText()).replace(/\n+/g, ' ');
            const said = (await ledger.locator('[data-proof-said]').textContent()) ?? '';
            check('the claim stays where Check was pressed, its one tag now verified, its line the reason and the way to the check; nothing said twice',
                rowText.match(/verified/g)?.length === 1 && lineText.startsWith('the calculator tests pass when run again (2 of 2).') && !rowText.includes('No test ran in this turn.')
                && (await row.getByRole('button', { name: 'Open the check', exact: true }).count()) === 1 && said === '', `${rowText} | said: ${said}`);
            check('the focus stayed on its line', (await focusIn(page)).claim === claims.subtract.id, json(await focusIn(page)));
            const checksCard = page.locator('[data-proof-checks]');
            await waitFor(async () => (await checksCard.getAttribute('data-proof-checks')) === '2', 'Independent checks to list both checks', 15000, 300).catch(() => {});
            const checkRows = checksCard.locator('[data-proof-check-row]');
            check('Independent checks lists both checks, newest first, each said once', (await checksCard.getAttribute('data-proof-checks')) === '2'
                && json(await checkRows.evaluateAll((els) => els.map((el) => el.getAttribute('data-proof-check-row')))) === json(['verified', 'not-verified'])
                && /you asked/.test(await checksCard.innerText()) && (await checkRows.nth(1).innerText()).match(/not verified/gi)?.length === 1, await checksCard.innerText());
            check('What happened has each check asked for, how it ran and its answer', await historyHas(/^Check asked for: “Deployed to staging\.”/) && await historyHas(/^Not verified: “Deployed to staging\.”/) && await historyHas(/^Verified: “All tests pass\.”/)
                && await historyHas(/^Checking “Deployed to staging\.” In a new read-only thread on Fake Check from Fake at low effort, for at most 1 minute\./));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-ledger-check');
        });

        await step('a verified claim: its flag is headed so, with the check\'s reason in place of Proof\'s reading', async () => {
            const { page } = window;
            await openChat(page, ids.subtract);
            const flag = flagsShown(page).first();
            await flag.waitFor({ state: 'visible', timeout: 20000 });
            await waitFor(async () => (await flag.getAttribute('data-proof-flag')) === 'verified', 'the flag to say verified', 15000, 300).catch(() => {});
            const text = (await flag.innerText()).replace(/\n+/g, ' ');
            check('the flag of a claim its check verified says so in its head (not "Nothing in this turn shows this"), with the check\'s reason, said once',
                (await flag.getAttribute('data-proof-flag')) === 'verified' && text.startsWith('Proof · Verified by an independent check') && text.includes('“All tests pass.”')
                && text.includes('the calculator tests pass when run again (2 of 2).') && !text.includes('No test ran in this turn.') && !text.includes('Nothing in this turn shows this')
                && text.match(/verified/gi)?.length === 1, text);
            await shot(page, shots, 'flag-verified-light', flag);
            await setDark(page, true);
            await shot(page, shots, 'flag-verified-dark', flag);
            await setDark(page, false);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-verified-flag');
        });
    }

    // A check that runs past its minute: asked for now, settled after the page's checks below.
    const slowAsked = await api('check', { sessionId: ids.broken, claimId: claims.broken.id });
    check('a check is asked for through the endpoint as the page asks for it', slowAsked.ok && ACTIVE.has(slowAsked.value?.state), json(slowAsked));
    const slowFrom = Date.now();

    await step('while a check runs, its thread says above the message box what it checks; changing the limit meanwhile leaves its own', async () => {
        const running = await waitFor(async () => {
            const c = await checkOf(ids.broken, claims.broken.id);
            return c?.state === 'running' && c.checkSessionId ? c : null;
        }, 'the slow check to run', 20000, 250);
        check('a running check keeps the minutes it was given, its effort and the check model\'s name', running.minutes === 1 && /^low$/i.test(running.effort ?? '') && running.model === 'Fake Check from Fake', json(running));
        if (!pw) return;
        const { page } = window;
        await openProof(page);
        const runningRow = page.locator('[data-proof-checks] [data-proof-check-row="running"]');
        await runningRow.waitFor({ state: 'visible', timeout: 15000 });
        await runningRow.getByRole('button', { name: 'Open the check', exact: true }).click();
        const dock = page.locator('[data-proof-dock]').filter({ visible: true }).first();
        await dock.waitFor({ state: 'visible', timeout: 20000 });
        const dockText = (await dock.innerText()).replace(/\n+/g, ' ');
        const input = page.getByRole('textbox').filter({ visible: true }).last();
        const [dockBox, inputBox] = [await dock.boundingBox(), (await input.count()) ? await input.boundingBox() : null];
        check('in the running check\'s thread, above its message box: what it checks and from where, that it cannot write, its state, and the way back',
            (await dock.getAttribute('data-proof-dock')) === 'running' && dockText.startsWith('Proof check')
            && dockText.includes('This thread checks “All tests pass.” from turn 1 of “Broken tests”. It can read and run commands, but nothing it runs can write a file.')
            && /checking/.test(dockText) && (await dock.getByRole('button', { name: 'Open the checked session', exact: true }).count()) === 1
            && Boolean(dockBox && inputBox && dockBox.y + dockBox.height <= inputBox.y + 1), `${dockText} | ${json({ dockBox, inputBox })}`);
        await shot(page, shots, 'check-dock-light', dock);
        await setDark(page, true);
        await shot(page, shots, 'check-dock-dark', dock);
        await setDark(page, false);
        await dock.getByRole('button', { name: 'Open the checked session', exact: true }).click();
        await flagsShown(page).first().waitFor({ state: 'visible', timeout: 20000 });
        const flagText = (await flagsShown(page).first().innerText()).replace(/\n+/g, ' ');
        check('"Open the checked session" goes to the claim, whose flag says its check runs, for how long and how',
            flagText.includes('“All tests pass.”') && /checking\s*In a read-only thread on Fake Check from Fake at low effort, for up to 1 minute\./.test(flagText), flagText);

        // The limit raised while it runs: this check keeps the minute it was given.
        await openProof(page);
        await page.locator('[data-proof-header]').getByRole('button', { name: 'Settings', exact: true }).click();
        const form = page.locator('[data-suite-settings="dsh-plugin-proof"]');
        await form.waitFor({ state: 'visible', timeout: 20000 });
        await page.getByLabel('Minutes a check may take').fill('2');
        await form.getByRole('button', { name: 'Save' }).click();
        await waitFor(async () => (await pageState()).verifier.minutes === 2, 'the new limit to apply', 15000, 300);
        await openProof(page);
        const card = page.locator('[data-proof-checks]');
        await waitFor(async () => /for at most 2 minutes/.test(await card.innerText()), 'the checks card to say the new limit', 15000, 300).catch(() => {});
        const rowText = (await card.locator('[data-proof-check-row="running"]').innerText().catch(() => '')).replace(/\n+/g, ' ');
        check('with the limit raised to 2 minutes, new checks get 2; the running one keeps the 1 it was given, and says so',
            /for at most 2 minutes/.test(await card.innerText()) && rowText.includes('for up to 1 minute.') && (await checkOf(ids.broken, claims.broken.id))?.minutes === 1, rowText);
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-dock');
    });

    if (pw) {
        await step('the page: header, sessions, the ledger and its filter, what the turn ran; light, dark and narrow', async () => {
            const { page } = window;
            await openProof(page);
            const header = page.locator('[data-proof-header]');
            const status = (await header.locator('.dshpf-status').textContent()) ?? '';
            check('the header says how many sessions have claims, how many claims are flagged, and how many a check verified (counted apart)',
                status === '4 sessions with claims · 2 claims flagged · 1 verified by an independent check', status);
            check('the header says flags are on; the checks card how checks run', (await page.locator('[data-proof-flags]').getAttribute('data-proof-flags')) === 'on' && (await page.locator('[data-proof-verifier]').getAttribute('data-proof-verifier')) === 'ask'
                && !/read-only thread/.test(await header.innerText()), await header.innerText());
            const rows = await page.locator('[data-proof-session]').evaluateAll((els) => els.map((el) => el.getAttribute('data-proof-session')));
            check('the sessions list has the four sessions with claims, and no check thread', rows.length === 4 && [ids.tests, ids.subtract, ids.broken, ids.deploy].every((id) => rows.includes(id)), json(rows));
            const subtractRow = (await page.locator(`[data-proof-session="${ids.subtract}"]`).innerText()).replace(/\n+/g, ' ');
            const subtractData = (await pageState()).sessions.find((r) => r.sessionId === ids.subtract);
            check('the session whose flagged claim was verified is counted apart: no flagged claim, one verified, and its row says verified',
                subtractData?.flagged === 0 && subtractData?.verified === 1 && /\bverified\b/.test(subtractRow) && !/no evidence/.test(subtractRow), `${subtractRow} | ${json(subtractData)}`);
            const ledger = await openLedger(page, ids.subtract);
            check('the ledger counts its claims in words, the verified one apart', /2 claims: 1 shown by their turn, 1 verified by an independent check, 0 with no evidence, 0 contradicted\./.test(await ledger.innerText()), (await ledger.innerText()).slice(0, 300));
            check('it shows the flagged claims first: none now, and says why', (await ledger.locator('[data-proof-claim]').count()) === 0 && /Nothing flagged now/.test(await ledger.innerText())
                && (await ledger.getByText('Flagged (0)', { exact: true }).count()) === 1, (await ledger.innerText()).slice(0, 600));
            await ledger.getByText('All claims (2)', { exact: true }).click();
            await waitFor(async () => (await ledger.locator('[data-proof-claim]').count()) === 2, 'All claims to show both', 10000, 200);
            check('All claims shows the quiet one too', (await ledger.locator('[data-proof-verdict="backed"]').count()) === 1);
            const tops = await ledger.locator('.dshpf-claim-top').allInnerTexts();
            check('no claim kind beside a claim\'s tag (it read as a verdict)', tops.length === 2 && tops.every((t) => /^Turn 1\b/.test(t) && !/\b(passed|done|fixed|deployed)\b/.test(t)), json(tops));
            const ran = ledger.locator('details').first();
            await ran.locator('summary').click();
            check('"What the turn ran" lists the turn\'s runs', /subtract\.mjs/.test(await ran.innerText()), await ran.innerText());
            await shot(page, shots, 'page-light');
            await setDark(page, true);
            await shot(page, shots, 'page-dark');
            await page.locator('[data-proof-history]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
            await shot(page, shots, 'history-dark');
            await setDark(page, false);
            await shot(page, shots, 'history-light');
            await page.locator('[data-proof-page]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
            await page.setViewportSize({ width: 760, height: 900 });
            await page.waitForTimeout(500);
            const spill = await page.locator('[data-proof-page]').evaluate((el) => el.scrollWidth - el.clientWidth);
            check('in a narrow window nothing on the page spills sideways', spill <= 1, `${spill}px wider than the page`);
            await shot(page, shots, 'narrow-light');
            await page.setViewportSize({ width: 1280, height: 860 });
            await page.waitForTimeout(300);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-page');
        });

        await step('export: Markdown, CSV and JSON download the whole ledger; Copy puts the Markdown on the clipboard', async () => {
            const { page } = window;
            await openProof(page);
            const ledger = await openLedger(page, ids.subtract);
            const download = async (label) => {
                const [file] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), ledger.getByRole('button', { name: label, exact: true }).click()]);
                const path = await file.path();
                return { name: file.suggestedFilename(), text: readFileSync(path, 'utf8') };
            };
            const md = await download('Markdown');
            check('Markdown downloads as a file named for the session, with every claim, the verified one counted apart', /^proof-ledger-add-subtract-\d{4}-\d{2}-\d{2}\.md$/.test(md.name)
                && md.text.startsWith('# Claims ledger: Add subtract\n') && md.text.includes('2 claims: 1 shown by their turn, 1 verified by an independent check, 0 with no evidence, 0 contradicted by their turn\'s own output.')
                && md.text.includes('| Turn | Claim | Verdict | Why | Evidence | Independent check |')
                && /\| 1 \| All tests pass\. \| No evidence \| No test ran in this turn\. \| — \| Verified: the calculator tests pass when run again \(2 of 2\)\. \|/.test(md.text), `${md.name}\n${md.text.slice(0, 900)}`);
            const said = (await ledger.locator('[data-proof-said]').textContent()) ?? '';
            check('the page says what it downloaded', said === `Downloaded ${md.name}.`, said);
            const csv = await download('CSV');
            const lines = csv.text.trim().split('\r\n');
            check('CSV downloads with a header row and one row per claim', /\.csv$/.test(csv.name) && lines[0] === 'session,title,turn,claimed_at,kind,claim,verdict,why,evidence,ran,check,check_reason,checked_at' && lines.length === 3
                && lines.some((l) => l.includes(',All tests pass.,No evidence,No test ran in this turn.,') && l.includes(',Verified,')), csv.text.slice(0, 600));
            const file = await download('JSON');
            let parsed;
            try { parsed = JSON.parse(file.text); } catch {}
            check('JSON downloads and parses: the session, the counts (the verified claim apart), each claim with its check', /\.json$/.test(file.name) && parsed?.session?.id === ids.subtract
                && parsed.counts?.total === 2 && parsed.counts.verified === 1 && parsed.counts.unbacked === 0 && parsed.counts.flagged === 0
                && parsed.claims.some((c) => c.verdict === 'unbacked' && c.check?.state === 'verified' && c.check.checkSession), file.text.slice(0, 600));
            await ledger.getByRole('button', { name: 'Copy', exact: true }).click();
            await waitFor(async () => /Copied|Not copied/.test((await ledger.locator('[data-proof-said]').textContent()) ?? ''), 'the copy to say how it went', 10000, 200);
            const copied = (await ledger.locator('[data-proof-said]').textContent()) ?? '';
            const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
            check('Copy puts the ledger on the clipboard as Markdown, and says so', copied === 'Copied the ledger as Markdown.' && clip.startsWith('# Claims ledger: Add subtract'), `${copied} | ${clip.slice(0, 80)}`);
            await waitFor(() => historyHas(/^Ledger copied as Markdown 2 claims, onto the clipboard\./), 'the copy in What happened', 10000, 250).catch(() => {});
            const exports = (await pageState()).history.filter((e) => e.kind === 'export' && e.sessionId === ids.subtract).map((e) => `${e.text} ${e.why}`);
            check('What happened notes each export, and the copy as a copy (no file named for it)',
                exports.filter((t) => /^Ledger exported as Markdown/.test(t)).length === 1 && exports.some((t) => /^Ledger exported as CSV/.test(t)) && exports.some((t) => /^Ledger exported as JSON/.test(t))
                && exports.filter((t) => t === 'Ledger copied as Markdown 2 claims, onto the clipboard.').length === 1, json(exports));
            await shot(page, shots, 'exported-light', ledger);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-export');
        });

    }

    await step('a check past its minute is stopped, its model request closed, and its answer unclear, naming the minute it was given', async () => {
        const done = await settled(ids.broken, claims.broken.id, Math.max(10000, 100000 - (Date.now() - slowFrom)));
        const limitNow = (await pageState()).verifier.minutes;
        check('it settles as unclear, saying it took longer than the minute it was given (the limit is 2 minutes now)',
            done.state === 'unclear' && done.reason === 'It took longer than the 1 minute it was given, so Proof stopped it.' && done.minutes === 1 && limitNow === (pw ? 2 : 1), json({ done, limitNow }));
        const held = model.requests.find((r) => r.held && r.anchor.includes('Broken tests'));
        await waitFor(() => held?.closed, 'the held request to close', 15000, 200).catch(() => {});
        check('DSH stopped the check thread: the model\'s open reply was closed', Boolean(held?.closed), json(held));
        const end = (await run.events(done.checkSessionId)).filter((e) => e.type === 'turn/end').at(-1);
        check('the check thread\'s turn ended stopped, not finished', end && end.reason?.kind !== 'completed', json(end));
        if (!pw) return;
        // In the stopped check's own thread: how it ended, and no way into itself.
        const { page } = window;
        await openProof(page);
        const row = page.locator('[data-proof-checks] [data-proof-check-row="unclear"]').filter({ hasText: 'All tests pass.' });
        await row.waitFor({ state: 'visible', timeout: 15000 });
        await row.getByRole('button', { name: 'Open the check', exact: true }).click();
        const note = page.locator('[data-proof-flag="check"]').filter({ visible: true }).first();
        await note.waitFor({ state: 'visible', timeout: 20000 });
        const noteText = (await note.innerText()).replace(/\n+/g, ' ');
        check('its thread\'s note says it was stopped after the minute it was given, and offers no way into itself',
            /unclear\s*It took longer than the 1 minute it was given, so Proof stopped it\./.test(noteText) && !noteText.replace('Open the checked session', '').includes('Open the check')
            && (await page.locator('[data-proof-dock]').count()) === 0, noteText);
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-stopped');
    });

    if (pw) {
        await step('its settings in Plugins: By itself saved and noted; a value out of range refused', async () => {
            const { page } = window;
            await openProof(page);
            await page.locator('[data-proof-header]').getByRole('button', { name: 'Settings', exact: true }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-proof"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            const labels = (await form.locator('label').allTextContents()).join(' | ');
            check('the header\'s Settings opens Proof\'s settings in Plugins, in DSH\'s own form',
                labels.includes('Minutes a check may take') && labels.includes('Checks an hour, at most') && labels.includes('Check with the model')
                && (await form.getByRole('switch', { name: 'Flag claims with no evidence on their turn' }).count()) === 1, labels);
            await shot(page, shots, 'settings-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-dark');
            await setDark(page, false);
            const minutes = page.getByLabel('Minutes a check may take');
            const hint = (await page.locator('[data-suite-setting="verifierMinutes"]').innerText()).replace(/\n+/g, ' ');
            check('the minutes\' help says what a busy shared gateway needs', /on a busy shared gateway, where each answer can wait several minutes, allow 30\./.test(hint), hint);
            await minutes.fill('61');
            const refused = await page.locator('[data-suite-setting="verifierMinutes"]').innerText();
            check('the form will not save a value out of range, and says what fits', await form.getByRole('button', { name: 'Save' }).isDisabled() && /A whole number from 1 to 60, or empty for the default \(15\)\./.test(refused), refused);
            await minutes.fill('1');
            await form.getByRole('tab', { name: 'By itself', exact: true }).click();
            await form.getByRole('button', { name: 'Save' }).click();
            await waitFor(async () => (await pageState()).verifier.mode === 'auto', 'By itself to apply', 15000, 300);
            check('saved: it applies at once and What happened says which settings changed',
                await historyHas(/^Settings changed: (?=.*“Independent check”)(?=.*“Minutes a check may take”)/) && (await pageState()).verifier.minutes === 1);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-settings');
        });
    } else {
        // Without the window, By itself through the profile.
        await restartWith(rowsWith({ proof: { verifier: 'auto' } }), 'By itself');
        await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints', 30000);
    }

    await step('By itself checks a new flagged claim, and leaves the ones flagged before', async () => {
        ids.release = await run.newSession(`Publish the release.\n${turn([bash('ls -1', 'List the files')], 'Published 1.2.0 to npm.')}`, 'Release notes');
        await turnsEnded(ids.release, 1);
        const [claim] = await flaggedOf(ids.release);
        check('"Published 1.2.0 to npm." after an ls is flagged', Boolean(claim) && claim.kind === 'deployed', json(claim));
        const done = await settled(ids.release, claim.id, 40000);
        check('it was checked by itself, and answered', done.by === 'auto' && done.state === 'not-verified' && done.reason === 'no publish ran in that turn or since.', json(done));
        const older = await checkOf(ids.subtract, claims.subtract.id);
        check('a claim flagged before By itself was chosen is not checked again by itself', older?.by === 'you', json(older));
        check('What happened says why it checked', await historyHas(/^Check asked for: “Published 1\.2\.0 to npm\.” Proof checks each new flagged claim by itself/));
    });

    await step('past the hour\'s limit a check waits, saying until when; switching checks Off ends it', async () => {
        const again = await api('check', { sessionId: ids.deploy, claimId: claims.deploy.id });
        check('a fifth check in the hour waits its turn, and says until when and why', again.ok && again.value.state === 'queued'
            && new RegExp(`^Waits until .+: ${PER_HOUR} checks have started in the last hour, the most Proof's settings allow\\.$`).test(again.value.reason), json(again.value ?? again.error));
        if (pw) {
            const { page } = window;
            await openProof(page);
            await page.locator('[data-proof-header]').getByRole('button', { name: 'Settings', exact: true }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-proof"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            await form.getByRole('tab', { name: 'Off', exact: true }).click();
            await form.getByRole('button', { name: 'Save' }).click();
        } else {
            await restartWith(rowsWith({ proof: { verifier: 'off' } }), 'checks off');
        }
        const ended = await settled(ids.deploy, claims.deploy.id, 20000);
        await waitFor(async () => (await pageState()).verifier.mode === 'off', 'checks to be off', 15000, 250).catch(() => {});
        check('switched Off, the waiting check ends, saying so (once: its tag says it was not checked)', ended.state === 'failed' && ended.reason === 'The independent check was switched off before it started.', json(ended));
        const refused = await api('check', { sessionId: ids.deploy, claimId: claims.deploy.id });
        check('while checks are off, asking for one is refused in words', refused.ok === false && refused.error?.message === 'The independent check is off. Turn it on in Proof\'s settings ("Independent check").', json(refused.error));
        if (pw) {
            const { page } = window;
            await openProof(page);
            const card = page.locator('[data-proof-checks]');
            await waitFor(async () => (await page.locator('[data-proof-verifier]').getAttribute('data-proof-verifier')) === 'off', 'the page to say checks are off', 15000, 300);
            // One row for each claim checked (four claims): asking again for the deploy claim replaced its first row.
            const rows = card.locator('[data-proof-check-row]');
            const deployRow = rows.filter({ hasText: 'Deployed to staging.' });
            const deployRowText = (await deployRow.innerText().catch(() => '')).replace(/\n+/g, ' ');
            check('the page says checks are off, and still lists the checks made, one row for each claim, each state said once', (await card.innerText()).includes('The independent check is off.') && (await rows.count()) === 4
                && (await deployRow.count()) === 1 && deployRowText.includes('The independent check was switched off before it started.') && deployRowText.match(/could not check|not checked/gi)?.length === 1,
            (await card.innerText()).slice(0, 600));
            // Newest first by the time each row shows, every time in one column.
            const times = await rows.evaluateAll((els) => els.map((el) => {
                const time = el.querySelector('.dshpf-log-time');
                const at = Date.parse(time?.querySelector('time')?.getAttribute('datetime') ?? '');
                const box = time?.getBoundingClientRect();
                const next = time?.nextElementSibling?.getBoundingClientRect();
                return { at, width: Math.round(box?.width ?? -1), left: Math.round(next?.left ?? -1) };
            }));
            check('the checks are newest first by the time each row shows, and their times sit in one fixed-width column',
                times.length === 4 && times.every((t, i) => Number.isFinite(t.at) && (i === 0 || t.at <= times[i - 1].at)) && new Set(times.map((t) => t.width)).size === 1
                && new Set(times.map((t) => t.left)).size === 1 && times[0].width > 0, json(times));
            // While the check is off, the way to turn it on, though checks were made before.
            await card.getByRole('button', { name: 'Open Proof\'s settings', exact: true }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-proof"]');
            await form.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
            check('while the check is off, the checks card offers Open Proof\'s settings, and it opens them', await form.isVisible());
            await openChat(page, ids.deploy);
            await flagsShown(page).first().waitFor({ state: 'visible', timeout: 20000 });
            check('the flag stays, with no Check button while checks are off', (await flagsShown(page).first().getByRole('button', { name: /^Check/ }).count()) === 0);
            check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
        }
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-off');
    });

    // ── Proof switched off and on in Plugins ───────────────────────────
    await step('Proof switched off and on in Plugins: no failure; its entry and flags go and come back', async () => {
        const off = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-proof', enabled: false });
        check('switched off, DSH reports it applied, with no failure', off.ok === true && off.value?.application === 'applied' && !off.value?.error, json(off));
        await waitFor(async () => (await api('state')).ok === false, 'Proof to stop', 20000, 300);
        if (window?.page) {
            const { page } = window;
            await waitFor(async () => (await flagsShown(page).count()) === 0, 'the flag to go', 15000, 300).catch(() => {});
            check('while Proof is off, its flag and its sidebar entry are gone', (await flagsShown(page).count()) === 0 && (await page.getByRole('button', { name: 'Proof', exact: true }).count()) === 0);
        }
        const on = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-proof', enabled: true });
        check('switched on again, DSH reports it applied, with no failure', on.ok === true && on.value?.application === 'applied' && !on.value?.error, json(on));
        await waitFor(async () => (await api('state')).ok, 'Proof to run again', 30000, 300);
        // Switched back on, Proof works out the open sessions' claims again from their logs.
        const back = await waitFor(async () => (await pageState()).sessions.some((r) => r.sessionId === ids.deploy), 'the flagged session back on the page', 15000, 300).catch(() => false);
        check('switched on again, the page lists the sessions with claims again', back === true);
        if (window?.page) {
            const { page } = window;
            await page.getByRole('button', { name: 'Proof', exact: true }).first().waitFor({ state: 'visible', timeout: 20000 });
            await openChat(page, ids.deploy);
            await flagsShown(page).first().waitFor({ state: 'visible', timeout: 20000 });
            check('switched on, its entry and the flag come back, with the claim', (await flagsShown(page).first().innerText()).includes('“Deployed to staging.”'));
            check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
        }
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-plugin-off');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── A restart under a running check ────────────────────────────────
    await restartWith(rowsWith({ proof: { verifierPerHour: 20 } }), 'more checks an hour');
    await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints after the restart', 30000);
    await step('a restart under a running check: the check settles as soon as Proof is back, saying DSH restarted while it ran', async () => {
        model.setPlan('Staging deploy', { slow: true });
        const asked = await api('check', { sessionId: ids.deploy, claimId: claims.deploy.id });
        check('a check starts', asked.ok, json(asked));
        await waitFor(async () => (await checkOf(ids.deploy, claims.deploy.id))?.state === 'running' && [...model.held].some((e) => e.record.anchor.includes('Staging deploy')), 'the check to be running', 20000, 300);
        await restart('a restart under a running check');
        await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints after the restart', 30000);
        const upAt = Date.now();
        const done = await settled(ids.deploy, claims.deploy.id, 100000);
        console.log(`# the cut check settled ${Math.round(((done.endedAt ?? Date.now()) - upAt) / 100) / 10} s after Proof's endpoints answered again`);
        check('after the restart the check settles at once (not when its minute runs out), as unclear, saying DSH restarted while it ran',
            done.state === 'unclear' && done.reason === 'DSH restarted while it ran, so it ended before it answered.' && (done.endedAt ?? Infinity) <= upAt + 20000, json(done));
        check('What happened says how it ended, in the same words', await historyHas(/^Check unclear: “Deployed to staging\.” DSH restarted while it ran, so it ended before it answered\.$/));
    });

    // ── Without Session Watch ──────────────────────────────────────────
    await restartWith(rowsWith({ off: ['session-watch'] }), 'Session Watch off');
    await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints without Session Watch', 30000);
    await step('without Session Watch Proof works, and its open page follows new claims', async () => {
        check('Proof needs nothing else: its endpoints answer with Session Watch off', (await pageState()).sessions.length >= 5);
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Proof' });
        const { page } = window;
        await openProof(page);
        const status = page.locator('[data-proof-header] .dshpf-status');
        const first = (await status.textContent()) ?? '';
        ids.late = await run.newSession(`Tag the release.\n${turn([bash('ls -1', 'List the files')], 'Pushed the v1.2.0 tag to origin.')}`, 'Late claim');
        await turnsEnded(ids.late, 1);
        const moved = await waitFor(async () => {
            const now = (await status.textContent()) ?? '';
            return now !== first ? now : null;
        }, 'the open page to show the new claim', 30000, 500).catch(() => '');
        check('the open page shows the new session by itself', /^6 sessions with claims/.test(moved) && (await page.locator(`[data-proof-session="${ids.late}"]`).count()) === 1, `${first} → ${moved}`);
        check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-watch-off');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── A wrong type in the profile ────────────────────────────────────
    await restartWith(rowsWith({ proof: { verifierMinutes: '20' } }), 'a wrong type');
    await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints with a wrong type', 30000);
    await step('a wrong type in the profile: Proof starts, flags nothing, and names the setting with its value', async () => {
        const s = await pageState();
        check('a number in quotes does not stop Proof from starting: its state names the setting and the value as the profile has it',
            s.problem?.text === 'Minutes a check may take (verifierMinutes) must be a whole number of minutes from 1 to 60 (it is "20")' && s.problem?.live === true && s.sessions.length === 0, json(s.problem));
    });

    // ── A wrong setting, fixed in Plugins ──────────────────────────────
    await restartWith(rowsWith({ proof: { verifierMinutes: 0 } }), 'a wrong setting');
    await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints with a wrong setting', 30000);
    await step('a wrong setting: Proof starts, flags nothing, refuses checks, and says which setting and what it must be', async () => {
        const s = await pageState();
        check('a wrong value does not stop Proof from starting: its state names the setting, the range and the value',
            s.problem?.text === 'Minutes a check may take (verifierMinutes) must be a whole number of minutes from 1 to 60 (it is 0)' && s.problem?.live === true && s.sessions.length === 0, json(s.problem));
        check('while a setting is wrong, no flag shows', (await sessionOf(ids.deploy)).flags === false);
        const refused = await api('check', { sessionId: ids.deploy, claimId: claims.deploy.id });
        check('checks are refused, saying why', refused.ok === false && refused.error?.message === 'Proof is waiting for a setting to be fixed: see the top of its page.', json(refused.error));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Proof' });
        const { page } = window;
        await openProof(page);
        const problem = page.locator('[data-suite-trouble="setting"]');
        await problem.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await problem.innerText()).replace(/\n+/g, ' ');
        check('the page says which setting is wrong, what it must be, and where to change it',
            /Proof is waiting for a setting to be fixed\. Minutes a check may take \(verifierMinutes\) must be a whole number of minutes from 1 to 60 \(it is 0\)\. Change it in Proof's settings in Plugins\. Proof starts working again as soon as you save\./.test(words), words);
        await shot(page, shots, 'setting-light');
        await setDark(page, true);
        await shot(page, shots, 'setting-dark');
        await setDark(page, false);
        await problem.getByRole('button', { name: 'Open Proof\'s settings' }).click();
        const form = page.locator('[data-suite-settings="dsh-plugin-proof"]');
        await form.waitFor({ state: 'visible', timeout: 20000 });
        await page.getByLabel('Minutes a check may take').fill('5');
        await form.getByRole('button', { name: 'Save' }).click();
        const fixed = await waitFor(async () => {
            const r = await api('state');
            return r.ok && !r.value.problem ? r.value : null;
        }, 'the setting to be fixed', 20000);
        check('saving a good value fixes it at once, the log says so, and the sessions are listed again',
            fixed.history.some((e) => e.kind === 'settings' && e.text === 'Settings fixed: Proof is working again') && fixed.sessions.length >= 5 && (await sessionOf(ids.deploy)).flags === true, json(fixed.history.slice(0, 2)));
        check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-setting');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── Files ──────────────────────────────────────────────────────────
    await step('a private folder and files', async () => {
        const dir = join(run.home, 'proof');
        const files = ['checks.json', 'events.jsonl'].map((f) => join(dir, f));
        const modes = [dir, ...files].map((p) => `${p.slice(run.home.length + 1)} ${existsSync(p) ? modeOf(p).toString(8) : 'missing'}`);
        check('Proof\'s folder is 700 and its files 600', modeOf(dir) === 0o700 && files.every((f) => existsSync(f) && modeOf(f) === 0o600), modes.join(', '));
    });

    // ── enabled: false ─────────────────────────────────────────────────
    await restartWith(rowsWith({ proof: { enabled: false } }), 'enabled: false');
    await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints with enabled: false', 30000);
    await step('enabled: false: Proof reads no claims, refuses its actions, and its page says so and how to change it', async () => {
        const s = await pageState();
        check('with enabled: false Proof is loaded but idle', s.enabled === false && !s.problem && s.sessions.length === 0, json({ enabled: s.enabled, problem: s.problem }));
        const refused = await api('ledger', { sessionId: ids.deploy });
        check('its actions say it is switched off', refused.ok === false && refused.error?.message === 'Proof is switched off in DSH\'s profile (enabled: false), so it reads no claims.', json(refused.error));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Proof' });
        const { page } = window;
        await openProof(page);
        const header = page.locator('[data-proof-header="off"]');
        await header.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await header.innerText()).replace(/\n+/g, ' ');
        check('the page says it reads no claims, and how to change that', /Proof is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\), so it reads no claims\. To use it, set enabled to true there and restart DSH\./.test(words), words);
        await shot(page, shots, 'disabled-light');
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-disabled');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── Sessions saved while Proof was off ─────────────────────────────
    // While it is off, a new session makes a claim and an older one takes a turn: DSH saves both without Proof's view.
    ids.offline = await run.newSession(`Ship the docs.\n${turn([bash('ls -1', 'List the files')], 'Deployed the docs to production.')}`, 'Docs while off');
    await turnsEnded(ids.offline, 1);
    await run.bridge('POST', `/sessions/${encodeURIComponent(ids.subtract)}/prompt`, { text: `Thanks.\n${say('Glad to help.')}` });
    await turnsEnded(ids.subtract, 2);
    await restartWith(rowsWith(), 'Proof on again');
    await waitFor(async () => (await api('state')).ok, 'Proof\'s endpoints, on again', 30000);
    await step('sessions saved while Proof was off are listed again once it is on, with their claims and their titles', async () => {
        const backAt = Date.now();
        const s = await waitFor(async () => {
            const now = await pageState();
            return [ids.offline, ids.subtract].every((id) => now.sessions.some((r) => r.sessionId === id)) ? now : null;
        }, 'the sessions saved while Proof was off on its page', 30000, 500).catch(() => pageState());
        console.log(`# the sessions saved while Proof was off were on its page ${Date.now() - backAt} ms after it answered again`);
        const offline = s.sessions.find((r) => r.sessionId === ids.offline);
        const subtract = s.sessions.find((r) => r.sessionId === ids.subtract);
        check('a session made while Proof was off is listed, with its flagged claim and its title', offline?.total === 1 && offline.flagged === 1 && offline.title === 'Docs while off', json(offline));
        check('a session that took a turn while Proof was off is listed again as before, its verified claim still counted apart',
            subtract?.total === 2 && subtract.flagged === 0 && subtract.verified === 1, json(subtract));
        const all = [ids.tests, ids.subtract, ids.broken, ids.deploy, ids.release, ids.late, ids.offline].filter(Boolean);
        check('no session with claims is lost', all.every((id) => s.sessions.some((r) => r.sessionId === id)), json(s.sessions.map((r) => r.title)));
        check('Independent checks name every checked session by its title', s.checks.length > 0 && s.checks.every((c) => typeof c.title === 'string' && c.title !== ''), json(s.checks.map((c) => c.title)));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Proof' });
        const { page } = window;
        await openProof(page);
        const ledger = await openLedger(page, ids.offline);
        check('its page lists the session made while it was off, and its ledger has the claim', (await ledger.locator('[data-proof-claim]').count()) === 1
            && (await ledger.innerText()).includes('“Deployed the docs to production.”'), (await ledger.innerText()).slice(0, 400));
        await openChat(page, ids.offline);
        const flag = flagsShown(page).first();
        await flag.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
        check('its turn has its flag', (await flag.innerText().catch(() => '')).includes('“Deployed the docs to production.”'));
        check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-saved-while-off');
    });
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
    if (window?.page) await shot(window.page, shots, 'failed').catch(() => {});
} finally {
    await window?.browser?.close().catch(() => {});
    model.release();
    await run.stop();
    await model.close();
    const warnings = run.logText().split('\n').filter((line) => /proof|session-watch/i.test(line) && /warn|error|fail/i.test(line));
    if (warnings.length) console.log(`# DSH said about the suite:\n${warnings.slice(-20).map((l) => `#   ${l}`).join('\n')}`);
    run.cleanup();
}
console.log(`\n# DSH ${version}: ${tally.passed} passed, ${tally.failed} failed${pw ? '' : ', window checks skipped (no Playwright)'}`);
process.exit(tally.failed ? 1 : 0);
