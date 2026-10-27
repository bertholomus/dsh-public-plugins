#!/usr/bin/env node
/**
 * Autopilot in a real DSH: its host half over the real session watcher, its
 * page in a real window, and DSH quit and crashed under running turns.
 *
 * DSH runs from a throwaway DSH_HOME (test/e2e/harness.mjs) with the
 * session bridge, Session Watch and Autopilot, a scripted model
 * (test/e2e/fake-model.mjs) that plays the agent, and new sessions on
 * Workspace Write, so writing outside the workspace asks for approval.
 * Autopilot's waits are short here (idleSeconds 5, startDelaySeconds 1,
 * errorRetrySeconds 2).
 *
 * - The browser half is served and parses; the endpoints answer, and refuse
 *   bad input in words.
 * - A session that stops with open todos gets a note, read into a turn (the
 *   session's own log shows the note and the turn it started); two notes
 *   that bring no progress and Autopilot backs off; notes that bring
 *   progress go on until the todos are done, with no back-off.
 * - Ask first raises a question instead; Off leaves the session alone; a
 *   last reply that asks the person something is left alone.
 * - A goal stopped by a failed turn gets a carry-on note first, which
 *   spends no goal round; once that turn ends without an error the goal
 *   starts again, proven by a round of the revision the start wrote, and
 *   its next round runs (the goal completes). An outage (the round and
 *   every note fail): no goal round goes to it, and Autopilot gives up as
 *   the last try fails, tagged gave up.
 * - The switch: off, a session with open work gets nothing; on again, it
 *   gets its note.
 * - The page, from DSH's sidebar: the question with its answer buttons, the
 *   backed-off session with Try again, the sessions with their rules, the
 *   log with a Why line for every action; light and dark pictures; every
 *   state word on the page reads at 4.5:1 or more over its panel, light and
 *   dark; the Waiting card is glass at tint + .2, and at Wallpaper's tint .2
 *   over a mid picture its small text still reads at 4.5:1 (where the plain
 *   tint would not). Its buttons work: the answer sends the note and the
 *   focus goes on to the next row; Try again while off is refused in words
 *   in its row, which takes the focus, and sends nothing; Try again nudges
 *   again and the focus stays in the page; a rule changed to Auto acts; the
 *   switch goes off and on. On a rule, an arrow key only shows the choice,
 *   Enter applies it and Escape takes it back, and focus stays on the rule;
 *   a choice shown that way outlives a redraw that moves its row.
 * - A question open when DSH quits is set aside in the log as withdrawn (DSH
 *   stopped), and asked again after the start under the same entry and time.
 * - DSH quit under four running turns: a plain one, a goal round, one
 *   whose tool waits for approval and one whose question waits in DSH's
 *   question box (a stand-in window gets their prompts; their rows say
 *   what they wait for, and why Autopilot leaves them alone). After the
 *   start each gets a carry-on note, read into a turn; the goal's next
 *   round runs after it; the notes for the approval and the question say
 *   what did not happen; nothing handled before the quit is done again.
 * - DSH crashed (SIGKILL to its process group) under a running turn: the
 *   watcher's record of running turns names it, and after the start it gets
 *   its note. A question open at the kill is withdrawn at the start (a crash
 *   or a forced quit named) and asked again under its one entry and first
 *   time; a goal start left waiting for its round is checked against the
 *   session's log and marked not started.
 * - A number in quotes in the profile: the settings form shows it in quotes,
 *   flagged as it opens; the number typed back saves and fixes it, and the
 *   log says the new value and the one before.
 * - Autopilot's and the watcher's folders are 700 and their files 600.
 * - A quiet session that Autopilot leaves to the person says why on its row.
 * - A wrong setting in the profile: Autopilot starts but does no work, and
 *   its page says which setting, what it must be and where to change it;
 *   its button opens Autopilot's settings in Plugins (DSH's own form) with
 *   the cursor in that setting, flagged at once; the form refuses a value
 *   out of range; saving a good one fixes it, the log says who did, and the
 *   waiting session gets its note.
 * - Session Watch's own setting in Plugins. Session Watch switched off
 *   there: DSH reports no failure, Autopilot stays on in Plugins and its
 *   page says it needs Session Watch; switched on again (as from another
 *   window), the page comes back by itself.
 * - Session Watch off in the profile: Autopilot loads but does nothing
 *   (DSH reports nothing waiting), and its page says it needs Session
 *   Watch, with a button that opens it in Plugins.
 * - `enabled: false`: the page says Autopilot watches nothing, and how to
 *   change it; its actions are refused in words.
 *
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node plugins/autopilot/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/; `node scripts/e2e.mjs
 * autopilot` runs it on each of those and on the installed app's own DSH
 * (under the app's binary as Node). SHOTS=<folder> keeps
 * the window's pictures there (default .e2e/shots/autopilot/<version>);
 * KEEP=1 keeps the throwaway DSH_HOME. Without Playwright the run fails,
 * unless NO_WINDOW=1 says to run without the window checks (the summary
 * then says they were skipped).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { DshRun, checks, dshBin, findPlaywright, modeOf, openWindow, pluginsDir, repoRoot, setDark, shot, sleep, waitFor } from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from '../../../../test/e2e/fake-model.mjs';

const bin = dshBin();
if (!bin) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'autopilot', version);
console.log(`# DSH ${version}: ${bin}`);
console.log(`# pictures: ${shots}`);

const IDLE = 5;
const tally = checks();
const { check, step } = tally;
const model = await startFakeModel();
/**
 * The profile's rows: new sessions on Workspace Write (writing outside the workspace asks for approval), and the two
 * plugins with the e2e's short waits; `off` lists rows switched off in the profile.
 */
const rowsWith = ({ off = [], idle = IDLE, enabled = true, extra = {}, watchTimeout = 60 } = {}) => `- id: permission
  config:
    defaultPreset: workspace-write
- id: autopilot
${off.includes('autopilot') ? '  disabled: true\n' : ''}  config:
${enabled ? '' : '    enabled: false\n'}    idleSeconds: ${idle}
    startDelaySeconds: 1
    errorRetrySeconds: [2, 2]
    maxNotesPerHour: 80
${Object.entries(extra).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}\n`).join('')}- id: session-watch
${off.includes('session-watch') ? '  disabled: true\n' : ''}  config:
    deliveryTimeoutSeconds: ${JSON.stringify(watchTimeout)}
`;
const run = new DshRun({
    label: 'autopilot',
    bin,
    plugins: {
        'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge'),
        'dsh-plugin-session-watch': join(pluginsDir, 'session-watch'),
        'dsh-plugin-autopilot': join(pluginsDir, 'autopilot'),
    },
    rows: rowsWith(),
});
const outside = join(run.root, 'outside');
mkdirSync(outside, { recursive: true });
/** Start DSH again with other rows (the plugin settings a person would have in the profile). */
async function restartWith(rows, what) {
    await run.stop();
    run.rows = rows;
    run.writeProfile(model.port);
    await run.boot(what);
}

const api = async (method, args = {}) => run.api(`dsh-plugin-autopilot/${method}`, args);
const state = async () => {
    const r = await api('state');
    if (!r.ok) throw new Error(`state: ${JSON.stringify(r.error)}`);
    return r.value;
};
/** Autopilot's log entries for one session, oldest first. */
const entriesOf = async (sessionId, kind) => (await state()).log.filter((e) => e.sessionId === sessionId && (!kind || e.kind === kind)).reverse();
const count = async (sessionId, kind, wanted = undefined) => (await entriesOf(sessionId, kind)).filter((e) => !wanted || e.state === wanted).length;
/** Wait for the n-th entry of `kind` for a session to reach `wanted`; that entry. */
const entryReaches = (sessionId, kind, wanted, n = 1, timeout = 60000) => waitFor(async () => {
    const found = (await entriesOf(sessionId, kind)).filter((e) => e.state === wanted);
    return found.length >= n ? found[n - 1] : null;
}, `${kind} ${wanted} #${n} for ${sessionId}`, timeout, 300);

const todos = (...items) => JSON.stringify(items.map(([content, status]) => ({ content, status })));
const call = (tool, args) => `E2E:call ${tool} ${JSON.stringify(args)}`;
const idleSession = async (sessionId) => waitFor(async () => {
    const s = await run.session(sessionId);
    return s.status !== 'running' && s.turns.started > 0 && s.turns.started === s.turns.ended ? s : null;
}, `${sessionId} to finish its turn`, 30000);

/** Whether the session's log shows `text` as a message in it, with a turn started after it (DSH read it in). */
async function readIntoTurn(sessionId, text) {
    const events = await run.events(sessionId);
    const at = events.findIndex((e) => e.type === 'user/message' && typeof e.text === 'string' && e.text.startsWith(text));
    if (at < 0) return false;
    const turnBefore = events.slice(0, at).findLast((e) => e.type === 'turn/start');
    const endBefore = events.slice(0, at).findLast((e) => e.type === 'turn/end');
    // Read into a turn: the message sits inside a turn (after its turn/start, with no turn/end between).
    return Boolean(turnBefore) && (!endBefore || endBefore.seq < turnBefore.seq);
}

/**
 * The contrast of an element's text over what is painted behind it: its own and its ancestors' backgrounds, stacked
 * as the window draws them (down to the first solid one), measured as WCAG does. With `ground`, the page stands on
 * that colour instead of DSH's own ground, as over a picture with Wallpaper on (where DSH's grounds go clear).
 */
const contrastOf = (locator, { ground } = {}) => locator.evaluate((el, ground) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const c = canvas.getContext('2d', { willReadFrequently: true });
    const pixel = () => [...c.getImageData(0, 0, 1, 1).data];
    const alphaOf = (css) => {
        c.clearRect(0, 0, 1, 1);
        c.fillStyle = css;
        c.fillRect(0, 0, 1, 1);
        return pixel()[3];
    };
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        const alpha = alphaOf(bg);
        if (alpha > 0) layers.push(bg);
        if (alpha === 255 || (ground && node.matches('[data-autopilot-page]'))) break;
    }
    c.clearRect(0, 0, 1, 1);
    c.fillStyle = ground ?? '#ffffff';
    c.fillRect(0, 0, 1, 1);
    for (const bg of [...layers].reverse()) {
        c.fillStyle = bg;
        c.fillRect(0, 0, 1, 1);
    }
    const back = pixel().slice(0, 3);
    c.fillStyle = getComputedStyle(el).color;
    c.fillRect(0, 0, 1, 1);
    const text = pixel().slice(0, 3);
    const channel = (v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const [hi, lo] = [lum(text), lum(back)].sort((a, b) => b - a);
    return { word: el.textContent, tone: el.getAttribute('data-tone'), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, text, back, layers };
}, ground ?? null);
/** `contrastOf` for every element a locator matches. */
const contrastsOf = async (locator, options) => {
    const out = [];
    for (let i = 0; i < await locator.count(); i++) out.push(await contrastOf(locator.nth(i), options));
    return out;
};
/** Where the keyboard focus is, in the page's terms. */
const focusOf = (page) => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { body: true };
    const card = ['waiting', 'sessions', 'header', 'log'].find((name) => el.closest(`[data-autopilot-${name}]`));
    return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 120),
        inPage: Boolean(el.closest('[data-autopilot-page]')),
        card: card ?? null,
        backed: el.closest('[data-autopilot-backed]')?.getAttribute('data-autopilot-backed') ?? null,
        refusal: el.getAttribute('data-autopilot-refusal'),
    };
});

let window;
let pw;
const ids = {};
try {
    run.writeProfile(model.port);
    await run.boot('first start');
    await waitFor(async () => (await api('state')).ok, 'Autopilot\'s endpoints', 30000);

    // ── The browser half and the endpoints ─────────────────────────────
    await step('DSH serves Autopilot\'s browser half and it parses', async () => {
        const client = await run.clientOf('dsh-plugin-autopilot');
        let parses = false;
        try {
            new Script(client.text);
            parses = true;
        } catch {}
        check('DSH serves Autopilot\'s browser half and it parses', client.status === 200 && parses && client.text.includes('dsh-plugin-autopilot'), `${client.url ?? 'not in the boot graph'}: ${client.status}`);
    });
    await step('the endpoints answer, and refuse bad input in words', async () => {
        const s = await state();
        check('the state endpoint answers: on, Auto by default, the e2e settings', s.enabled === true && s.paused === false && s.defaultRule === 'auto' && s.settings.idleSeconds === IDLE, JSON.stringify({ enabled: s.enabled, paused: s.paused, rule: s.defaultRule, settings: s.settings }));
        const noSession = await api('setRule', { sessionId: '', rule: 'auto' });
        const badRule = await api('setRule', { sessionId: 'session-x', rule: 'sometimes' });
        const badSwitch = await api('setPaused', { paused: 'yes' });
        const badAnswer = await api('answer', { id: 'autopilot:nothing', answer: 'go' });
        check('bad input is refused with a message a person can act on',
            noSession.ok === false && /Name the session/.test(noSession.error?.message)
            && badRule.ok === false && /Auto, Ask first or Off/.test(badRule.error?.message)
            && badSwitch.ok === false && /switch Autopilot off/.test(badSwitch.error?.message)
            && badAnswer.ok === false && typeof badAnswer.error?.message === 'string' && badAnswer.error.message.length > 0,
        JSON.stringify([noSession.error, badRule.error, badSwitch.error, badAnswer.error]));
        const badge = await api('badge');
        check('the sidebar badge endpoint answers', badge.ok && badge.value.asks === 0 && badge.value.paused === false, JSON.stringify(badge));
    });

    // ── Sessions that stop with work open ──────────────────────────────
    ids.report = await run.newSession(`E2E:todos ${todos(['Write the report', 'in_progress'], ['Check the numbers', 'pending'])}`, 'Quarterly report');
    ids.progress = await run.newSession(`E2E:todos ${todos(['Draft the outline', 'in_progress'], ['Write section one', 'pending'], ['Write section two', 'pending'])}\n#note=progress`, 'Release notes');
    ids.ask = await run.newSession(`E2E:todos ${todos(['Rename the config keys', 'in_progress'])}\n#note=progress`, 'Config cleanup');
    ids.off = await run.newSession(`E2E:todos ${todos(['Update the changelog', 'in_progress'])}\n#note=progress`, 'Changelog');
    ids.question = await run.newSession(`E2E:todos ${todos(['Deploy the fix', 'pending'])}\n#final=ask`, 'Deploy question');
    ids.fix = await run.newSession('E2E:goal Fix the failing build [r1=fail]', 'Build fix');
    // Two sessions whose last reply is an offer (Off until it is written, so nothing acts on the reply before it).
    ids.offerGo = await run.newSession(`E2E:todos ${todos(['Write the parser', 'in_progress'], ['Add tests', 'pending'])}\n#note=progress`, 'Offer, goes on');
    await api('setRule', { sessionId: ids.offerGo, rule: 'off' });
    ids.handOver = await run.newSession(`E2E:todos ${todos(['Write step 2', 'pending'], ['Write step 3', 'pending'])}`, 'Offer, hands over');
    await api('setRule', { sessionId: ids.handOver, rule: 'off' });
    await api('setRule', { sessionId: ids.ask, rule: 'ask' });
    await api('setRule', { sessionId: ids.off, rule: 'off' });

    await step('a session that stops with open todos gets a note, read into a turn', async () => {
        const first = await entryReaches(ids.report, 'nudge', 'delivered', 1, 40000);
        check('a session that stops with open todos gets a note, delivered (proven by a turn reading it)', first.state === 'delivered' && typeof first.turn === 'number', JSON.stringify(first));
        check('the note names the open work, and is signed', /^\[Autopilot\] You stopped with 2 open todos \(next: “Write the report”\)/.test(first.note ?? ''), first.note);
        check('its Why line says what Autopilot saw', /idle for 5 seconds after turn 1 with 2 open todos, and its last reply asked you nothing/.test(first.why ?? ''), first.why);
        check('the session\'s own log shows the note read into a turn', await readIntoTurn(ids.report, '[Autopilot] You stopped with 2 open todos'));
    });
    await step('two notes with no progress, and Autopilot backs off', async () => {
        await entryReaches(ids.report, 'nudge', 'delivered', 2, 40000);
        const off = await entryReaches(ids.report, 'backoff', 'backed off', 1, 40000);
        check('two notes that bring no progress, and Autopilot backs off, saying why', /2 notes in a row brought no progress/.test(off.why ?? ''), off.why);
        await sleep((IDLE * 2 + 2) * 1000);
        check('after backing off it sends no more notes', (await count(ids.report, 'nudge')) === 2, `${await count(ids.report, 'nudge')} notes`);
        const row = (await state()).sessions.find((s) => s.sessionId === ids.report);
        check('the page lists it as backed off', Boolean(row?.backedOff), JSON.stringify(row));
    });
    await step('notes that bring progress go on until the work is done, without backing off', async () => {
        await waitFor(async () => (await run.session(ids.progress)).status !== 'running' && (await count(ids.progress, 'nudge', 'delivered')) >= 3, 'three notes for the session that makes progress', 60000, 500);
        await sleep((IDLE + 3) * 1000);
        const notes = await count(ids.progress, 'nudge');
        const backoffs = await count(ids.progress, 'backoff');
        const row = (await state()).sessions.find((s) => s.sessionId === ids.progress);
        check('a todo done after each note: three notes, no back-off, and nothing open at the end', notes === 3 && backoffs === 0 && !row?.work, JSON.stringify({ notes, backoffs, work: row?.work }));
    });
    await step('Ask first asks; Off and a question to the person are left alone', async () => {
        const asked = await entryReaches(ids.ask, 'ask', 'asked you', 1, 40000);
        const s = await state();
        const ask = s.asks.find((a) => a.sessionId === ids.ask);
        check('under Ask first, Autopilot asks instead of acting, with its recommendation', Boolean(ask) && /Config cleanup/.test(ask.question) && typeof ask.recommendation === 'string' && (await count(ids.ask, 'nudge')) === 0,
            JSON.stringify({ asked, ask }));
        const badge = await api('badge');
        check('the sidebar badge counts the question', badge.ok && badge.value.asks === 1, JSON.stringify(badge));
        await idleSession(ids.off);
        await idleSession(ids.question);
        check('Off: no note, no question', (await entriesOf(ids.off)).filter((e) => e.kind !== 'rule').length === 0, JSON.stringify(await entriesOf(ids.off)));
        check('a last reply that asks the person something is left alone', (await entriesOf(ids.question)).length === 0, JSON.stringify(await entriesOf(ids.question)));
        const held = (await state()).sessions.find((x) => x.sessionId === ids.question);
        check('its row says why Autopilot leaves it to the person', held?.hold === 'waits for you: its last reply asks you something', JSON.stringify(held));
    });
    await step('an offer holds the nudge only when it hands the next step to you; one that says the agent goes on gets its note', async () => {
        const say = async (sessionId, text) => {
            const s0 = await idleSession(sessionId);
            await run.bridge('POST', `/sessions/${encodeURIComponent(sessionId)}/prompt`, { text: `E2E:say ${text}` });
            await waitFor(async () => {
                const s = await run.session(sessionId);
                return s.status !== 'running' && s.turns.ended > s0.turns.ended ? s : null;
            }, `${sessionId} to reply`, 30000);
        };
        await say(ids.offerGo, 'All tests pass. Happy to keep going with the next todo.');
        await say(ids.handOver, 'Step 1 is done. Let me know if you want me to continue with steps 2 and 3.');
        await api('setRule', { sessionId: ids.offerGo, rule: 'auto' });
        await api('setRule', { sessionId: ids.handOver, rule: 'auto' });
        const note = await entryReaches(ids.offerGo, 'nudge', 'delivered', 1, 40000);
        check('a reply that offers more but goes on ("Happy to keep going with the next todo.") gets its note, read into a turn',
            note.state === 'delivered' && /and its last reply asked you nothing\.$/.test(note.why ?? ''), JSON.stringify(note));
        await sleep((IDLE + 3) * 1000);
        check('a reply that hands the next step to you ("Let me know if you want me to continue …") gets none', (await count(ids.handOver, 'nudge')) === 0, `${await count(ids.handOver, 'nudge')} notes`);
        const row = (await state()).sessions.find((x) => x.sessionId === ids.handOver);
        check('its row quotes the words that hold it',
            row?.hold === 'waits for you: its last reply leaves the next step to you (“Let me know if you want me to continue with steps 2 and 3.”)', JSON.stringify(row));
    });
    await step('a goal stopped by a failed turn gets a carry-on note first (no goal round spent); once that turn ends cleanly, the goal starts again and its next round runs', async () => {
        const note = await entryReaches(ids.fix, 'error', 'delivered', 1, 40000);
        check('after the failed turn a carry-on note goes first, and its Why line names the error in plain words and says which round the goal starts with',
            /^Turn 2 failed \(400: E2E: the scripted model refused this request\), which stops a goal; the goal “Fix the failing build \[r1=fail\]” is still active\. A note costs no goal round, so it goes first; the goal starts again \(round 2 of 6\) once a turn ends without an error\.$/.test(note.why ?? ''), note.why);
        check('the note is read into a turn', await readIntoTurn(ids.fix, '[Autopilot] Your last turn (turn 2) failed'));
        const rearm = await entryReaches(ids.fix, 'rearm', 'started', 1, 40000);
        check('once the note\'s turn ended without an error, the goal starts again, proven by a round of the revision it wrote', rearm.reason === 'round 2 of 6 began' && rearm.goal?.round === 2 && rearm.at > note.at, JSON.stringify(rearm));
        check('its Why line says which round the start begins', rearm.why === 'The turn after its carry-on note ended without an error, so its goal goes on: this start begins round 2 of 6.', rearm.why);
        const rounds = (await run.events(ids.fix)).filter((e) => e.type === 'user/message' && e.source?.kind === 'goal').length;
        check('the failed turn and the note spent no goal round: round 1 failed, round 2 is the start\'s', rounds === 2, `${rounds} goal rounds`);
        const ends = await waitFor(async () => {
            const events = await run.events(ids.fix, 'goal/change');
            return events.length >= 3 ? events : null;
        }, 'the goal to complete', 30000);
        const complete = (await run.savedEvents(ids.fix)).some((e) => e.type === 'goal/change' && e.data?.goal?.phase === 'complete');
        check('the goal\'s round completes it', complete, JSON.stringify(ends.map((e) => e.type)));
    });

    // ── The switch ─────────────────────────────────────────────────────
    await step('off: nothing runs; on again: the session gets its note', async () => {
        await api('setPaused', { paused: true });
        ids.paused = await run.newSession(`E2E:todos ${todos(['Tidy the imports', 'in_progress'])}\n#note=progress`, 'Imports');
        await idleSession(ids.paused);
        await sleep((IDLE + 4) * 1000);
        check('while Autopilot is off, a session with open work gets nothing', (await entriesOf(ids.paused)).length === 0, JSON.stringify(await entriesOf(ids.paused)));
        await api('setPaused', { paused: false });
        const note = await entryReaches(ids.paused, 'nudge', 'delivered', 1, 30000);
        check('on again, it looks at every session: the session gets its note', note.state === 'delivered', JSON.stringify(note));
    });

    // ── The page ───────────────────────────────────────────────────────
    pw = await findPlaywright();
    if (!pw) {
        check('Playwright is here for the window checks (NO_WINDOW=1 runs without them)', process.env.NO_WINDOW === '1', 'install it: npm i --prefix .e2e/tools playwright-core (or set PLAYWRIGHT_MODULE)');
    } else {
        await step('the page', async () => {
            window = await openWindow(run, pw, { entry: 'Autopilot' });
            const { page } = window;
            await page.getByRole('button', { name: 'Autopilot', exact: true }).first().click();
            await page.locator('[data-autopilot-page]').waitFor({ state: 'visible', timeout: 20000 });
            await page.locator('[data-autopilot-log] [data-autopilot-entry]').first().waitFor({ state: 'visible' });
            const header = await page.locator('[data-autopilot-header]').getAttribute('data-autopilot-header');
            const status = await page.locator('[data-autopilot-header] .dshap-status').textContent();
            check('the page opens from DSH\'s sidebar, on, with what it watches in words', header === 'on' && /^Watching \d+ sessions · \d+ notes? this hour; the limit is 80 · a session with open work gets a note after 5 seconds of quiet$/.test(status ?? ''), `${header} | ${status}`);
            const anyAsk = page.locator('[data-autopilot-ask]');
            const backed = page.locator(`[data-autopilot-backed="${ids.report}"]`);
            check('Waiting for you: the question, with its answer buttons and Open', (await anyAsk.count()) === 1
                && (await anyAsk.getByRole('button').allTextContents()).join('|').includes('Leave it')
                && (await anyAsk.getByRole('button', { name: 'Open', exact: true }).count()) === 1, await anyAsk.textContent().catch(() => ''));
            check('Waiting for you: the backed-off session, with Try again', (await backed.count()) === 1 && (await backed.getByRole('button', { name: 'Try again' }).count()) === 1, await backed.textContent().catch(() => ''));
            const whyLines = await page.locator('[data-autopilot-log] [data-autopilot-entry] >> text=/^Why: /').count();
            const entries = await page.locator('[data-autopilot-log] [data-autopilot-entry]').count();
            check('every entry in the log has its Why line', entries > 5 && whyLines >= entries - 2, `${whyLines} Why lines for ${entries} entries`);
            const icon = await page.locator('[data-autopilot-icon]').first().textContent();
            check('the sidebar icon shows the question waiting', /1/.test(icon ?? ''), icon);
            const hold = await page.locator(`[data-autopilot-session="${ids.question}"] [data-autopilot-hold]`).textContent().catch(() => '');
            check('a held session says why on its row', hold === 'Waits for you: its last reply asks you something.', hold);
            const amber = page.locator(`[data-autopilot-backed="${ids.report}"] .dshap-tag[data-tone="warning"]`).first();
            const amberLight = await contrastOf(amber);
            const tags = page.locator('[data-autopilot-page] .dshap-tag');
            const tagsLight = await contrastsOf(tags);
            const waitingMain = await page.locator('[data-autopilot-waiting]').evaluate((el) => el.classList.contains('dshap-main'));
            check('the Waiting card is glass at tint + .2, like the other cards people read', waitingMain);
            await shot(page, shots, 'autopilot-light');
            await shot(page, shots, 'waiting-light', page.locator('[data-autopilot-waiting]'));
            await setDark(page, true);
            await page.waitForTimeout(400);
            const amberDark = await contrastOf(amber);
            const tagsDark = await contrastsOf(tags);
            check('the amber state words read at 4.5:1 or more over their panel, light and dark', amberLight.ratio >= 4.5 && amberDark.ratio >= 4.5, JSON.stringify({ light: amberLight, dark: amberDark }));
            // Every state word on the page, whatever its tone ("idle" was drawn in DSH's glyph colour at 3.6:1).
            const allTags = [...tagsLight.map((t) => ({ ...t, mode: 'light' })), ...tagsDark.map((t) => ({ ...t, mode: 'dark' }))];
            const tones = [...new Set(allTags.map((t) => t.tone))].sort();
            const weakTags = allTags.filter((t) => t.ratio < 4.5).map(({ word, tone, mode, ratio }) => ({ word, tone, mode, ratio }));
            const lowest = (list) => Math.min(...list.map((t) => t.ratio));
            console.log(`# state words: ${allTags.length} measured, tones ${tones.join(', ')}; lowest ${lowest(tagsLight)}:1 light, ${lowest(tagsDark)}:1 dark`);
            check('every state word on the page reads at 4.5:1 or more over its panel, in every tone shown, light and dark', ['quiet', 'success', 'warning'].every((tone) => tones.includes(tone)) && weakTags.length === 0, JSON.stringify({ tones, weakTags }));
            await shot(page, shots, 'autopilot-dark');
            await shot(page, shots, 'waiting-dark', page.locator('[data-autopilot-waiting]'));
            await page.locator('[data-autopilot-log]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
            await shot(page, shots, 'log-dark');
            await setDark(page, false);
            await shot(page, shots, 'log-light');
            // Wallpaper on at a low tint (.2): the page stands on a picture, here its local colour. A mid grey (lighter
            // in dark mode, darker in light mode) is where tint + .2 carries small text and the plain tint does not; the
            // extremes at this tint are DESIGN's open question about a floor for the tint slider.
            const small = (card) => ['why', 'meta', 'hold', 'status'].map((c) => `[data-autopilot-${card}] .dshap-${c}`).join(', ');
            const lowTint = {};
            await page.evaluate(() => document.documentElement.style.setProperty('--wp-tint', '.2'));
            try {
                for (const [mode, ground] of [['light', 'rgb(180, 180, 180)'], ['dark', 'rgb(140, 140, 140)']]) {
                    await setDark(page, mode === 'dark');
                    await page.waitForTimeout(300);
                    const waiting = await contrastsOf(page.locator(small('waiting')), { ground });
                    const sessions = await contrastsOf(page.locator(small('sessions')), { ground });
                    const tagsHere = await contrastsOf(page.locator('[data-autopilot-waiting] .dshap-tag'), { ground });
                    // The same text on the plain tint, to show the ground is one where the glass matters.
                    await page.locator('[data-autopilot-waiting]').evaluate((el) => el.classList.remove('dshap-main'));
                    const plain = await contrastsOf(page.locator(small('waiting')), { ground });
                    await page.locator('[data-autopilot-waiting]').evaluate((el) => el.classList.add('dshap-main'));
                    lowTint[mode] = { ground, waiting: lowest(waiting), sessions: lowest(sessions), plain: lowest(plain), tags: lowest(tagsHere), tagCount: tagsHere.length, count: waiting.length };
                }
            } finally {
                await page.evaluate(() => document.documentElement.style.removeProperty('--wp-tint'));
                await setDark(page, false);
            }
            console.log(`# at tint .2: ${JSON.stringify(lowTint)}`);
            check('at Wallpaper\'s tint .2 over a mid picture, the small text on the Waiting and Sessions cards (amber "waits for you" lines too) reads at 4.5:1 or more, light and dark',
                ['light', 'dark'].every((mode) => lowTint[mode].count > 0 && lowTint[mode].waiting >= 4.5 && lowTint[mode].sessions >= 4.5), JSON.stringify(lowTint));
            check('on the plain tint the same text would read under 4.5:1 there, so the check can fail', ['light', 'dark'].every((mode) => lowTint[mode].plain < 4.5), JSON.stringify(lowTint));
            check('at that tint the Waiting card\'s tags (backed off, gave up) read at 4.5:1 or more too, on their solid chips, light and dark',
                ['light', 'dark'].every((mode) => lowTint[mode].tagCount > 0 && lowTint[mode].tags >= 4.5), JSON.stringify(lowTint));
            await page.locator('[data-autopilot-page]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
            // A narrow window: the page reflows, nothing spills sideways.
            await page.setViewportSize({ width: 760, height: 900 });
            await page.waitForTimeout(500);
            const spill = await page.locator('[data-autopilot-page]').evaluate((el) => el.scrollWidth - el.clientWidth);
            check('in a narrow window nothing on the page spills sideways', spill <= 1, `${spill}px wider than the page`);
            await shot(page, shots, 'narrow-light');
            await page.setViewportSize({ width: 1280, height: 860 });
            await page.waitForTimeout(300);
        });
        await step('the page\'s buttons', async () => {
            const { page } = window;
            // The question's recommended answer sends the note.
            const ask = page.locator('[data-autopilot-ask]').first();
            await ask.getByRole('button').first().click();
            const answered = await entryReaches(ids.ask, 'nudge', 'delivered', 1, 30000);
            check('the question\'s first button sends the note, delivered', answered.state === 'delivered' && answered.by === 'you', JSON.stringify(answered));
            await page.locator('[data-autopilot-ask]').waitFor({ state: 'detached', timeout: 15000 });
            check('the question leaves the page once answered', (await page.locator('[data-autopilot-ask]').count()) === 0);
            /** The focus once it settles where `wanted` says (or where it is after `ms`). */
            const focusSettles = async (wanted, ms = 5000) => waitFor(async () => {
                const where = await focusOf(page);
                return wanted(where) ? where : null;
            }, 'the focus', ms, 100).catch(() => focusOf(page));
            const afterAnswer = await focusSettles((f) => f.backed === ids.report && f.text === 'Try again');
            check('after the answer, the focus goes on to the row now in its place (its Try again), not the page body', afterAnswer.backed === ids.report && afterAnswer.text === 'Try again', JSON.stringify(afterAnswer));
            // Try again while Autopilot is off: refused in words in its row, which takes the focus; nothing is sent.
            const backedRow = page.locator(`[data-autopilot-backed="${ids.report}"]`);
            const switchOf = () => page.locator('[data-autopilot-header] [role="switch"]');
            await switchOf().click();
            await page.locator('[data-autopilot-header="off"]').waitFor({ timeout: 15000 });
            const notesOff = await count(ids.report, 'nudge');
            await backedRow.getByRole('button', { name: 'Try again' }).click();
            const refusal = backedRow.locator(`[data-autopilot-refusal="backed:${ids.report}"]`);
            await refusal.waitFor({ state: 'visible', timeout: 10000 });
            const refusalWords = await refusal.textContent();
            const onRefusal = await focusSettles((f) => f.refusal === `backed:${ids.report}`);
            const elsewhere = await page.locator('[data-autopilot-refusal]').count();
            check('Try again while off: "Not changed." and why, in its row, as an alert that takes the focus',
                refusalWords === 'Not changed. Autopilot is off: switch it on at the top of its page first.' && (await refusal.getAttribute('role')) === 'alert' && onRefusal.refusal === `backed:${ids.report}` && elsewhere === 1,
                JSON.stringify({ refusalWords, onRefusal, elsewhere }));
            const refusalContrast = await contrastOf(refusal);
            check('the refusal reads at 4.5:1 or more on its card', refusalContrast.ratio >= 4.5, JSON.stringify(refusalContrast));
            await sleep(1500);
            check('nothing is sent while off', (await count(ids.report, 'nudge')) === notesOff, `${await count(ids.report, 'nudge')} notes, ${notesOff} before`);
            await shot(page, shots, 'try-again-refused-light', page.locator('[data-autopilot-waiting]'));
            await switchOf().click();
            await page.locator('[data-autopilot-header="on"]').waitFor({ timeout: 15000 });
            await refusal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            check('switched on with the switch the refusal names, the refusal goes', (await page.locator('[data-autopilot-refusal]').count()) === 0);
            // Try again on the backed-off session.
            const before = await count(ids.report, 'nudge');
            await backedRow.getByRole('button', { name: 'Try again' }).click();
            await waitFor(async () => (await count(ids.report, 'nudge', 'delivered')) > before, 'the note after Try again', 30000, 300);
            check('Try again nudges the backed-off session again', true);
            const left = await backedRow.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false);
            const afterTry = await focusSettles((f) => f.inPage && !f.body);
            check('once its row leaves, the focus stays in the page (the next row, else the card\'s heading)', left && afterTry.inPage === true && !afterTry.body, JSON.stringify({ left, afterTry }));
            // A rule changed on the page: the session left alone under Off gets its note under Auto.
            await page.locator('[data-autopilot-sessions]').getByRole('tab', { name: 'All', exact: true }).click();
            const row = page.locator(`[data-autopilot-session="${ids.off}"]`);
            await row.waitFor({ state: 'visible' });
            await row.getByRole('tab', { name: 'Auto', exact: true }).click();
            const ruled = await entryReaches(ids.off, 'nudge', 'delivered', 1, 30000);
            check('a rule changed to Auto on the page acts at once', ruled.state === 'delivered', JSON.stringify(ruled));
            // The keyboard: an arrow key only shows a choice, Enter applies it, Escape takes it back; focus stays on the rule.
            const ruleOf = async () => (await state()).sessions.find((x) => x.sessionId === ids.off)?.rule;
            const focusedTab = () => page.evaluate(() => {
                const el = document.activeElement;
                return el?.getAttribute('role') === 'tab'
                    ? { session: el.closest('[data-autopilot-session]')?.getAttribute('data-autopilot-session'), name: el.textContent, selected: el.getAttribute('aria-selected') } : null;
            });
            await row.getByRole('tab', { name: 'Auto', exact: true }).focus();
            await page.keyboard.press('ArrowRight');
            const askHint = row.getByText('Press Enter to apply Ask first.');
            await askHint.waitFor({ state: 'visible', timeout: 5000 });
            await sleep(1500);
            check('an arrow key on a rule only shows the choice and says how to apply it: nothing is sent', (await ruleOf()) === 'auto', await ruleOf());
            await shot(page, shots, 'rule-keys-light', row);
            // The list changes under the choice: a session lower down starts a turn and moves to the top, so the rows
            // above it are moved. The choice is kept, the focus comes back to it, and Enter still applies it.
            const orderOf = () => page.locator('[data-autopilot-sessions] [data-autopilot-session]').evaluateAll((els) => els.map((el) => el.getAttribute('data-autopilot-session')));
            const orderBefore = await orderOf();
            // Sessions with nothing left open, so the turn gives Autopilot nothing to do later.
            const lower = orderBefore.slice(orderBefore.indexOf(ids.off) + 1).find((id) => [ids.ask, ids.progress].includes(id));
            if (lower) await run.bridge('POST', `/sessions/${encodeURIComponent(lower)}/prompt`, { text: 'Thanks. One more check, please.' });
            const moved = lower ? await waitFor(async () => {
                const order = await orderOf();
                return order.indexOf(lower) < order.indexOf(ids.off) ? order : null;
            }, 'the list to change under the choice', 45000, 100).catch(() => null) : null;
            await sleep(600);
            const stillShown = await askHint.isVisible();
            const onChoice = await focusedTab();
            check('a choice made with the keyboard outlives a redraw that moves its row: the line under it stays, and the focus is back on it',
                Boolean(moved) && stillShown && onChoice?.session === ids.off && onChoice.name === 'Ask first', JSON.stringify({ lower, orderBefore, moved, stillShown, onChoice }));
            await page.keyboard.press('Enter');
            await waitFor(async () => (await ruleOf()) === 'ask', 'Enter to apply Ask first', 15000, 200);
            await askHint.waitFor({ state: 'hidden', timeout: 5000 });
            const kept = await focusedTab();
            check('Enter applies it, and focus stays on the rule', kept?.session === ids.off && kept.name === 'Ask first' && kept.selected === 'true', JSON.stringify(kept));
            await page.keyboard.press('ArrowRight');
            const offHint = row.getByText('Press Enter to apply Off.');
            await offHint.waitFor({ state: 'visible', timeout: 5000 });
            await page.keyboard.press('Escape');
            await offHint.waitFor({ state: 'hidden', timeout: 5000 });
            await sleep(1000);
            const back = await focusedTab();
            check('Escape takes the shown choice back, and nothing is sent', (await ruleOf()) === 'ask' && back?.name === 'Ask first' && back.selected === 'true', JSON.stringify({ rule: await ruleOf(), back }));
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('Enter');
            await waitFor(async () => (await ruleOf()) === 'auto', 'the rule back to Auto', 15000, 200);
            await shot(page, shots, 'sessions-light', page.locator('[data-autopilot-sessions]'));
            // The switch.
            const toggle = page.locator('[data-autopilot-header] [role="switch"]');
            await toggle.click();
            await page.locator('[data-autopilot-header="off"]').waitFor({ timeout: 15000 });
            check('the switch turns Autopilot off', (await state()).paused === true);
            const ruleLine = await page.locator('[data-autopilot-rule-row="off"]').textContent().catch(() => '');
            check('while off, the rule line says the rule applies when Autopilot is on', /Applies when Autopilot is on\./.test(ruleLine ?? ''), ruleLine);
            await shot(page, shots, 'off-light', page.locator('[data-autopilot-header]'));
            await page.locator('[data-autopilot-header] [role="switch"]').click();
            await page.locator('[data-autopilot-header="on"]').waitFor({ timeout: 15000 });
            check('and on again', (await state()).paused === false);
            const ours = window.errors.filter((text) => /autopilot|session-watch/i.test(text));
            check('no errors from the suite in the window', ours.length === 0, ours.join('\n'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-buttons');
        });
        await window?.browser?.close().catch(() => {});
        window = undefined;
    }

    // ── An outage ──────────────────────────────────────────────────────
    await step('an outage: the goal\'s round fails and each carry-on note fails too; no goal round goes to it, and Autopilot gives up at once after the last try, tagged gave up', async () => {
        ids.outage = await run.newSession('E2E:goal Ship the hotfix [r1=fail]\n#note=fail', 'Hotfix');
        const giveup = await entryReaches(ids.outage, 'giveup', 'gave up', 1, 60000);
        const notes = await entriesOf(ids.outage, 'error');
        check('two tries (errorRetrySeconds [2, 2]), each a carry-on note, then the give-up', notes.length === 2 && giveup.why === 'It failed again after 2 tries, so Autopilot stops retrying and leaves it to you.', JSON.stringify({ notes: notes.map((e) => [e.state, e.at]), giveup }));
        const lastFail = (await run.events(ids.outage)).filter((e) => e.type === 'turn/end').at(-1);
        check('the give-up comes as the last try fails, not after another wait', Math.abs(giveup.at - (lastFail?.time ?? 0)) < 1500, `${giveup.at} vs ${lastFail?.time}`);
        const rounds = (await run.events(ids.outage)).filter((e) => e.type === 'user/message' && e.source?.kind === 'goal').length;
        check('no goal round went to the outage: only round 1, which failed', rounds === 1 && (await count(ids.outage, 'rearm')) === 0, `${rounds} goal rounds`);
        const row = (await state()).sessions.find((x) => x.sessionId === ids.outage);
        check('its row says gave up, with no next try', row?.word === 'gave up' && row.next === undefined && row.last?.text === 'stopped retrying after errors', JSON.stringify(row));
    });

    // ── A quit under running turns ──────────────────────────────────────
    // The report session goes back to backed off (no progress after Try again) before the quit, so nothing is in flight.
    await entryReaches(ids.report, 'backoff', 'backed off', 2, 60000).catch(() => {});
    // A tool waiting for approval and a question waiting in DSH's question box when DSH quits. A stand-in window gets
    // their prompts, as an open DSH window would (with no window, DSH answers an approval "unavailable" at once).
    const prompts = await run.prompts();
    ids.cutApproval = await run.newSession(call('write', { file_path: join(outside, 'draft.txt'), content: 'The draft.', sandbox_permissions: 'danger-full-access', justification: 'It saves the draft next to the workspace.' }), 'Draft upload');
    ids.cutQuestion = await run.newSession(call('ask_user_question', {
        questions: [{ id: 'env', question: 'Which environment should I deploy to?', header: 'Target', options: [{ label: 'staging' }, { label: 'production' }] }],
        timeout: -1,
    }), 'Deploy target');
    await step('a tool waiting for approval and a question in DSH\'s question box: their rows say so, and why Autopilot waits', async () => {
        const prompt = await waitFor(() => prompts.find('approval/request', (r) => /the draft next to the workspace/.test(r.reason ?? '')), 'the window\'s prompt for the draft', 30000, 200);
        check('DSH asks the window to allow the write', Boolean(prompt), JSON.stringify(prompts.asked.map((a) => a.event)));
        const rowOf = async (sessionId, word) => {
            let found;
            await waitFor(async () => {
                found = (await state()).sessions.find((x) => x.sessionId === sessionId);
                return found?.word === word;
            }, `${sessionId} to read ${word}`, 20000, 300).catch(() => {});
            return found;
        };
        const approval = await rowOf(ids.cutApproval, 'waiting for approval');
        check('the session whose tool waits for approval: its row says so, and why Autopilot leaves it to you',
            approval?.word === 'waiting for approval' && approval.hold === 'waits for you: a tool waits for you to allow or reject it', JSON.stringify(approval));
        const question = await rowOf(ids.cutQuestion, 'waiting for your answer');
        check('the session whose question waits in DSH\'s question box: its row says so, and why Autopilot leaves it to you',
            question?.word === 'waiting for your answer' && question.hold === 'waits for you: a question in DSH\'s question box', JSON.stringify(question));
    });
    // A question open when DSH quits (Ask first): set aside in the log, then back under the same entry and time.
    ids.askQuit = await run.newSession(`E2E:todos ${todos(['Tidy the imports', 'in_progress'])}`, 'Import tidy');
    await api('setRule', { sessionId: ids.askQuit, rule: 'ask' });
    const openAsk = await entryReaches(ids.askQuit, 'ask', 'asked you', 1, 40000);
    const openAskAt = (await state()).asks.find((a) => a.sessionId === ids.askQuit)?.at;
    ids.cut = await run.newSession('E2E:slow', 'Long migration');
    // No todos and no goal; DSH comes back before its gateway, so every note it gets fails.
    ids.blip = await run.newSession('E2E:slow\n#note=fail', 'Power blip');
    ids.cutGoal = await run.newSession('E2E:goal Write the summary [r1=slow]', 'Summary goal');
    await waitFor(async () => (await run.session(ids.cut)).status === 'running', 'the long turn to run', 30000);
    await waitFor(async () => (await run.session(ids.blip)).status === 'running', 'the power blip\'s turn to run', 30000);
    // The round has begun once its message is in the log (DSH opens the turn first, then writes the round's message).
    await waitFor(async () => {
        const s = await run.session(ids.cutGoal);
        if (s.status !== 'running' || s.turns.started < 2) return false;
        return (await run.events(ids.cutGoal)).some((e) => e.type === 'user/message' && e.source?.kind === 'goal');
    }, 'the goal round to run', 30000);
    const before = (await state()).log.length;
    const reportNotes = await count(ids.report, 'nudge');
    const quitAt = Date.now();
    await run.stop();
    check('DSH quits (SIGTERM) under five running turns', !run.alive(), `quit took ${Date.now() - quitAt} ms`);
    prompts.close();
    await run.boot('after a quit');
    await waitFor(async () => (await api('state')).ok, 'Autopilot\'s endpoints after the quit', 30000);
    await step('after a quit: each cut-off session gets a carry-on note, read into a turn', async () => {
        const note = await entryReaches(ids.cut, 'resume', 'delivered', 1, 40000);
        check('after a quit, the cut-off session gets a carry-on note, delivered', note.state === 'delivered', JSON.stringify(note));
        check('the note says what happened and what to do', /^\[Autopilot\] DSH stopped while you were working: turn 1 was cut off \(its last step was at .+\)\. Check what already finished \(files, commands, todos\), then carry on from where you stopped\./.test(note.note ?? ''), note.note);
        check('its Why line says a quit can do it too', /DSH stopped before it finished \(a quit, a restart or a crash\)/.test(note.why ?? ''), note.why);
        check('the session\'s own log shows the note read into a turn', await readIntoTurn(ids.cut, '[Autopilot] DSH stopped while you were working'));
        const goalNote = await entryReaches(ids.cutGoal, 'resume', 'delivered', 1, 40000);
        check('the goal\'s session gets its note too, naming the goal', /Still open: the goal “Write the summary \[r1=slow\]” \(round 1 of 6\)/.test(goalNote.note ?? ''), goalNote.note);
        const rearm = await entryReaches(ids.cutGoal, 'rearm', 'started', 1, 40000);
        check('once the note\'s turn has ended, its goal starts again, proven by a round of the revision it wrote', rearm.reason === 'round 2 of 6 began' && rearm.at > goalNote.at, JSON.stringify(rearm));
        check('its Why line says which round the start begins', rearm.why === 'Its goal was active when DSH stopped, and the turn after its carry-on note has ended, so its goal goes on: this start begins round 2 of 6.', rearm.why);
    });
    await step('after a quit, an outage too (DSH back before its gateway): a carry-on turn with no todos and no goal that fails is tried again note-first, then given up, with Try again', async () => {
        const resume = await entryReaches(ids.blip, 'resume', 'delivered', 1, 40000);
        const giveup = await entryReaches(ids.blip, 'giveup', 'gave up', 1, 60000);
        const notes = await entriesOf(ids.blip, 'error');
        check('its carry-on note is read, its turn fails, and two tries follow, each a note saying it was carrying on after DSH stopped',
            resume.state === 'delivered' && notes.length === 2 && notes.every((e) => /You were carrying on after DSH stopped under turn 1: check what already finished/.test(e.note ?? ''))
                && notes.every((e, i) => new RegExp(`^Turn ${i + 2} failed \\(400: E2E: the scripted model refused this request\\) while it carried on after DSH stopped under turn 1, so the work that stop cut off is still open\\.$`).test(e.why ?? '')),
            JSON.stringify({ resume: resume.state, notes: notes.map((e) => [e.state, e.why]) }));
        check('then Autopilot gives up as the last try fails, and says why', giveup.why === 'It failed again after 2 tries, so Autopilot stops retrying and leaves it to you.', JSON.stringify(giveup));
        const row = (await state()).sessions.find((x) => x.sessionId === ids.blip);
        check('its row says gave up, which puts it in the Waiting card with Try again', row?.word === 'gave up' && Boolean(row.gaveUp) && row.next === undefined, JSON.stringify(row));
    });
    await step('after a quit: the notes for a tool that waited for approval and a question that waited say what did not happen', async () => {
        const approval = await entryReaches(ids.cutApproval, 'resume', 'delivered', 1, 40000);
        check('the approval\'s note names the call, says it did not run, and what to do',
            /When DSH stopped, your \S+ call was waiting for approval, so it did not run: make it again if you still need it, and DSH asks for approval again\./.test(approval.note ?? ''), approval.note);
        check('its Why line says so too', /A tool was waiting for approval when it stopped; the note says it did not run\./.test(approval.why ?? ''), approval.why);
        check('the tool never ran: no file was written', !existsSync(join(outside, 'draft.txt')));
        const question = await entryReaches(ids.cutQuestion, 'resume', 'delivered', 1, 40000);
        check('the question\'s note quotes it, and says to ask again',
            (question.note ?? '').includes('When DSH stopped, your question in DSH\'s question box (“Which environment should I deploy to?”) had no answer yet: ask it again if you still need the answer.'), question.note);
        check('its Why line says so too', /Its question in DSH's question box had no answer; the note says to ask again\./.test(question.why ?? ''), question.why);
        check('both notes are read into a turn', await readIntoTurn(ids.cutApproval, '[Autopilot] DSH stopped while you were working') && await readIntoTurn(ids.cutQuestion, '[Autopilot] DSH stopped while you were working'));
    });
    await step('a question open at the quit: set aside in the log as DSH stopped, then asked again under the same entry and time', async () => {
        const rows = readFileSync(join(run.home, 'autopilot', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const aside = rows.find((row) => row.set === openAsk.id && row.patch?.stopped === true);
        check('when DSH quit, its log entry was marked withdrawn, with why, before DSH exited',
            aside?.patch.state === 'withdrawn' && /^withdrawn: Autopilot stopped \(DSH quit, or Autopilot or Session Watch was switched off\); it asks again when it runs, if this still applies$/.test(aside.patch.reason ?? ''), JSON.stringify(aside));
        const back = await waitFor(async () => (await state()).asks.find((a) => a.sessionId === ids.askQuit) ?? null, 'the question to come back', 40000, 300);
        const entriesNow = await entriesOf(ids.askQuit, 'ask');
        check('after the start it is asked again: one entry, open again, the stop no longer on it', entriesNow.length === 1 && entriesNow[0].id === openAsk.id && entriesNow[0].state === 'asked you' && !entriesNow[0].reason,
            JSON.stringify(entriesNow));
        check('it keeps the time it was first asked, so its wait counts from then', back.at === openAskAt && typeof openAskAt === 'number', `${back.at} vs ${openAskAt}`);
        const row = (await state()).sessions.find((x) => x.sessionId === ids.askQuit);
        check('its row\'s last words follow the question: asked you', row?.last?.text === 'asked you', JSON.stringify(row?.last));
    });
    await step('a restart never repeats what was handled', async () => {
        await sleep((IDLE * 2 + 2) * 1000);
        const s = await state();
        const fresh = s.log.slice(0, s.log.length - before);
        const repeats = fresh.filter((e) => ![ids.cut, ids.cutGoal, ids.cutApproval, ids.cutQuestion, ids.blip].includes(e.sessionId) && e.kind !== 'skip');
        check('nothing handled before the quit is done again', repeats.length === 0 && (await count(ids.report, 'nudge')) === reportNotes, JSON.stringify(repeats.map((e) => [e.kind, e.title, e.state])));
        check('the rules survive the quit', (await state()).sessions.find((x) => x.sessionId === ids.ask)?.rule === 'ask');
    });

    // ── A crash under a running turn ────────────────────────────────────
    // Ask first, with its question open when DSH is killed: no stop handler runs, so the next start settles it.
    ids.askCrash = await run.newSession(`E2E:todos ${todos(['Rename the tests', 'in_progress'])}`, 'Test rename');
    await api('setRule', { sessionId: ids.askCrash, rule: 'ask' });
    const crashAsk = await entryReaches(ids.askCrash, 'ask', 'asked you', 1, 40000);
    const crashAskAt = (await state()).asks.find((a) => a.sessionId === ids.askCrash)?.at;
    ids.crash = await run.newSession('E2E:slow', 'Big refactor');
    await waitFor(async () => (await run.session(ids.crash)).status === 'running', 'the turn to run before the crash', 30000);
    await sleep(500);
    await run.crash();
    // A goal start that DSH took but whose round had not begun when it was killed. In a running DSH the round follows
    // within a millisecond, so the e2e writes the entry such a kill leaves in Autopilot's log (the goal of the summary
    // session, whose next revision has no round in its log).
    const summaryGoal = (await run.savedEvents(ids.cutGoal)).filter((e) => e.type === 'goal/change').at(-1)?.data?.goal;
    const leftId = `e2e-kill-${Date.now().toString(36)}`;
    appendFileSync(join(run.home, 'autopilot', 'events.jsonl'), `${JSON.stringify({ add: { kind: 'rearm', sessionId: ids.cutGoal, title: 'Summary goal', text: 'Started its goal again', why: 'Its goal is active but stopped.', state: 'waiting for a round', by: 'Autopilot', key: 'idle:99:1', goal: { id: summaryGoal?.id, rev: (summaryGoal?.revision ?? 0) + 1, round: 3, max: 6 }, id: leftId, at: Date.now() } })}\n`);
    await step('a crash: the record of running turns names the session, and it gets its note after the start', async () => {
        const runningFile = join(run.home, 'session-watch', 'running.json');
        const record = JSON.parse(readFileSync(runningFile, 'utf8'));
        check('the watcher\'s record of running turns names the cut-off session, in a private file', Boolean(record.sessions?.[ids.crash]) && modeOf(runningFile) === 0o600, JSON.stringify(record));
        await run.boot('after a crash');
        await waitFor(async () => (await api('state')).ok, 'Autopilot\'s endpoints after the crash', 30000);
        const note = await entryReaches(ids.crash, 'resume', 'delivered', 1, 40000);
        check('after a crash, the cut-off session gets its carry-on note, delivered', note.state === 'delivered', JSON.stringify(note));
        check('the session\'s own log shows it read into a turn', await readIntoTurn(ids.crash, '[Autopilot] DSH stopped while you were working'));
    });
    await step('a crash under an open question and a goal start waiting for its round: both are settled from the logs before the first look', async () => {
        const rows = readFileSync(join(run.home, 'autopilot', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const aside = rows.find((row) => row.set === crashAsk.id && row.patch?.stopped === true);
        check('the question left open by the kill is marked withdrawn at the start, with a crash or a forced quit named',
            aside?.patch.state === 'withdrawn' && aside.patch.reason === 'withdrawn: DSH stopped before it was answered (a crash or a forced quit); it asks again when it runs, if this still applies' && typeof aside.patch.settledAt === 'number', JSON.stringify(aside));
        const back = await waitFor(async () => (await state()).asks.find((a) => a.sessionId === ids.askCrash) ?? null, 'the question to come back after the crash', 40000, 300);
        const entriesNow = await entriesOf(ids.askCrash, 'ask');
        check('then it is asked again under its one entry, open again, with the time it was first asked',
            entriesNow.length === 1 && entriesNow[0].id === crashAsk.id && entriesNow[0].state === 'asked you' && back.at === crashAskAt, JSON.stringify({ entriesNow, back: back.at, crashAskAt }));
        const left = (await state()).log.find((e) => e.id === leftId);
        check('the goal start left waiting is checked against its session\'s log: no round of its revision, so not started, and why',
            left?.state === 'not started' && left.reason === 'DSH stopped before a round began (a crash or a forced quit)' && typeof left.settledAt === 'number', JSON.stringify(left));
        const row = (await state()).sessions.find((x) => x.sessionId === ids.cutGoal);
        check('its row\'s last words follow it', row?.last?.text === 'its goal did not start', JSON.stringify(row?.last));
        await api('answer', { id: back.id, answer: 'skip' });
    });

    // ── Files ──────────────────────────────────────────────────────────
    await step('private folders and files', async () => {
        const dirs = ['autopilot', 'session-watch'].map((d) => join(run.home, d));
        const files = [join(run.home, 'autopilot', 'state.json'), join(run.home, 'autopilot', 'events.jsonl'), join(run.home, 'session-watch', 'running.json')];
        const modes = [...dirs, ...files].map((p) => `${p.slice(run.home.length + 1)} ${modeOf(p).toString(8)}`);
        check('Autopilot\'s and the watcher\'s folders are 700 and their files 600', dirs.every((d) => modeOf(d) === 0o700) && files.every((f) => modeOf(f) === 0o600), modes.join(', '));
    });

    // ── A wrong type in the profile ────────────────────────────────────
    // A number in quotes, for Autopilot and for Session Watch: DSH starts both. Autopilot names its setting and does
    // no work; the watcher keeps its default for its own, and Autopilot's page names that one too.
    await restartWith(rowsWith({ extra: { maxNudges: '2' }, watchTimeout: '60' }), 'a wrong type');
    await waitFor(async () => (await api('state')).ok, 'Autopilot\'s endpoints with a wrong type', 30000);
    await step('a wrong type in the profile: Session Watch and Autopilot both start, and the setting is named with its value', async () => {
        const s = await state();
        check('a number in quotes does not stop Autopilot from starting: its state names the setting and the value as the profile has it',
            s.problem?.text === 'Notes in a row without progress (maxNudges) must be a whole number from 1 to 10 (it is "2")' && s.problem?.live === true, JSON.stringify(s.problem));
        check('Session Watch starts with a number in quotes too (Autopilot\'s endpoints need it), and Autopilot\'s page names its setting and the value as the profile has it',
            s.watchProblem?.text === 'How long a message may wait to be read (deliveryTimeoutSeconds) must be a whole number of seconds from 10 to 86400 (it is "60")' && s.watchProblem?.live === true,
            JSON.stringify(s.watchProblem));
    });

    if (pw) {
        await step('a number in quotes, in the window: the form opens with it in quotes and flagged, and the number typed back saves and fixes it', async () => {
            window = await openWindow(run, pw, { entry: 'Autopilot' });
            const { page } = window;
            await page.getByRole('button', { name: 'Autopilot', exact: true }).first().click();
            await page.locator('[data-suite-trouble="setting"]').waitFor({ state: 'visible', timeout: 20000 });
            await page.getByRole('button', { name: 'Open Autopilot\'s settings' }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-autopilot"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            const flagged = page.locator('[data-suite-setting="maxNudges"][data-suite-invalid]');
            await flagged.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const input = page.locator('[data-suite-setting="maxNudges"] input');
            const shown = await input.inputValue();
            const flaggedWords = (await flagged.count()) ? await flagged.innerText() : '';
            check('the form shows the value with its quotes, flagged as it opens as text in quotes, with what to type', shown === '"2"' && /It is saved as text, in quotes\. Type a whole number from 1 to 10, without the quotes, then save\./.test(flaggedWords), `${shown} | ${flaggedWords}`);
            await shot(page, shots, 'settings-quoted-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-quoted-dark');
            await setDark(page, false);
            await input.fill('2');
            const save = form.getByRole('button', { name: 'Save' });
            await waitFor(async () => !(await save.isDisabled()), 'Save to come on', 5000, 100);
            check('typing the number back counts as a change: Save comes on', !(await save.isDisabled()));
            await save.click();
            const fixed = await waitFor(async () => {
                const r = await api('state');
                return r.ok && !r.value.problem ? r.value : null;
            }, 'the quoted setting to be fixed', 20000);
            const entry = fixed.log.find((e) => e.kind === 'settings');
            check('saved, it is fixed at once, and the log says the new value and the one before', entry?.text === 'Settings fixed: Autopilot is working again' && entry?.why === 'The change to “Notes in a row without progress” now 2 (was "2") fixed it.', JSON.stringify(entry));
            // Saved at its default, the value is no change: no "Changed", nothing to reset. One that differs shows both, in one style.
            const sameRow = page.locator('[data-suite-setting="maxNudges"]');
            const changedRow = page.locator('[data-suite-setting="idleSeconds"]');
            const noChip = await waitFor(async () => !/Changed|Use the default/.test(await sameRow.innerText()), 'the value saved at its default to show no Changed', 10000, 200).then(() => true, () => false);
            const changedWords = await changedRow.innerText();
            check('saved at its default (2), the value shows no "Changed" and no "Use the default"; one that differs (5 seconds) shows both',
                noChip && /Changed/.test(changedWords) && /Use the default/.test(changedWords), `${(await sameRow.innerText()).replace(/\n+/g, ' | ')} || ${changedWords.replace(/\n+/g, ' | ')}`);
            await shot(page, shots, 'settings-saved-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-saved-dark');
            await setDark(page, false);
            const ours = window.errors.filter((text) => /autopilot|session-watch/i.test(text));
            check('no errors from the suite in the window', ours.length === 0, ours.join('\n'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-quoted');
        });
        await window?.browser?.close().catch(() => {});
        window = undefined;
    }

    // ── A wrong setting, fixed in Plugins ──────────────────────────────
    await restartWith(rowsWith({ idle: 2 }), 'a wrong setting');
    await waitFor(async () => (await api('state')).ok, 'Autopilot\'s endpoints with a wrong setting', 30000);
    await step('a wrong setting: Autopilot starts, does no work, and says which setting and what it must be', async () => {
        const s = await state();
        check('a wrong value does not stop Autopilot from starting: its state names the setting, the range and the value',
            s.problem?.text === 'Quiet time before a note (idleSeconds) must be a whole number of seconds from 5 to 86400 (it is 2)' && s.problem?.live === true, JSON.stringify(s.problem));
        ids.waiting = await run.newSession(`E2E:todos ${todos(['Sort the inbox', 'in_progress'])}\n#note=progress`, 'Inbox');
        await idleSession(ids.waiting);
        await sleep(6000);
        check('while a setting is wrong, Autopilot does no work', (await entriesOf(ids.waiting)).length === 0, JSON.stringify(await entriesOf(ids.waiting)));
        const refused = await api('setPaused', { paused: true });
        check('its page\'s actions say why they cannot go', refused.ok === false && /waiting for a setting to be fixed/.test(refused.error?.message ?? ''), JSON.stringify(refused));
    });
    if (pw) {
        await step('a wrong setting, in the window: the page says what to change and opens Autopilot\'s settings in Plugins, which fix it', async () => {
            window = await openWindow(run, pw, { entry: 'Autopilot' });
            const { page } = window;
            await page.getByRole('button', { name: 'Autopilot', exact: true }).first().click();
            const problem = page.locator('[data-suite-trouble="setting"]');
            await problem.waitFor({ state: 'visible', timeout: 20000 });
            const words = (await problem.innerText()).replace(/\n+/g, ' ');
            check('the page says which setting is wrong, what it must be, and where to change it',
                /^Autopilot is waiting for a setting to be fixed\. Quiet time before a note \(idleSeconds\) must be a whole number of seconds from 5 to 86400 \(it is 2\)\. Change it in Autopilot's settings in Plugins\. Autopilot starts working again as soon as you save\./.test(words), words);
            await shot(page, shots, 'setting-light');
            await setDark(page, true);
            await shot(page, shots, 'setting-dark');
            await setDark(page, false);
            await page.getByRole('button', { name: 'Open Autopilot\'s settings' }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-autopilot"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            const labels = await form.locator('label').allTextContents();
            check('its button opens Autopilot\'s settings in Plugins, in DSH\'s own form', labels.includes('Quiet time before a note, in seconds') && labels.includes('Waits before each try after an error, in seconds') && (await form.getByRole('switch', { name: 'Resume after a restart' }).count()) === 1, labels.join(' | '));
            const flagged = page.locator('[data-suite-setting="idleSeconds"][data-suite-invalid]');
            await flagged.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const focused = await waitFor(() => page.evaluate(() => {
                const el = document.activeElement;
                return el?.tagName === 'INPUT' ? el.closest('[data-suite-setting]')?.getAttribute('data-suite-setting') : null;
            }), 'the cursor in the setting', 5000, 100).catch(() => null);
            const flaggedWords = (await flagged.count()) ? await flagged.innerText() : '';
            check('the form opens with the cursor in the wrong setting, flagged at once with what fits', focused === 'idleSeconds' && /A whole number from 5 to 86400, or empty for the default \(600\)\./.test(flaggedWords), `${focused} | ${flaggedWords}`);
            await shot(page, shots, 'settings-flagged-light');
            const field = page.getByLabel('Quiet time before a note, in seconds');
            await field.fill('3');
            const save = form.getByRole('button', { name: 'Save' });
            const refusedWords = await page.locator('[data-suite-setting="idleSeconds"]').innerText();
            check('the form will not save a value out of range, and says what fits', await save.isDisabled() && /A whole number from 5 to 86400, or empty for the default \(600\)\./.test(refusedWords), refusedWords);
            await shot(page, shots, 'settings-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-dark');
            await setDark(page, false);
            await field.fill(String(IDLE));
            await save.click();
            const fixed = await waitFor(async () => {
                const r = await api('state');
                return r.ok && !r.value.problem ? r.value : null;
            }, 'the setting to be fixed', 20000);
            const entry = fixed.log.find((e) => e.kind === 'settings');
            check('saving a good value fixes it at once, and the log says which change did', fixed.settings.idleSeconds === IDLE && entry?.text === 'Settings fixed: Autopilot is working again' && entry?.why === `The change to “Quiet time before a note” now ${IDLE} seconds (was 2 seconds) fixed it.`, JSON.stringify(entry));
            const note = await entryReaches(ids.waiting, 'nudge', 'delivered', 1, 30000);
            check('once fixed, the session that waited gets its note', note.state === 'delivered', JSON.stringify(note));
            // Session Watch's own setting, on its page in Plugins: back to the plugin list, then its card.
            const viewWatch = page.getByRole('button', { name: 'View Session Watch' });
            await page.getByRole('button', { name: 'Back to plugins' }).click();
            await viewWatch.waitFor({ state: 'visible', timeout: 15000 });
            await viewWatch.click();
            const watchForm = page.locator('[data-suite-settings="dsh-plugin-session-watch"]');
            await watchForm.waitFor({ state: 'visible', timeout: 20000 });
            const watchField = await watchForm.getByLabel('How long a message may wait to be read, in seconds').inputValue();
            check('Session Watch\'s page in Plugins has its one setting, with the profile\'s value', watchField === '60', watchField);
            await shot(page, shots, 'watch-settings-light');
            const ours = window.errors.filter((text) => /autopilot|session-watch/i.test(text));
            check('no errors from the suite in the window', ours.length === 0, ours.join('\n'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-settings');
        });
        await step('Session Watch switched off in Plugins: no failure from DSH, Autopilot stays on and says what it needs; switched on again, its page comes back by itself', async () => {
            const { page } = window;
            const failed = page.getByText(/Could not (disable|enable)/);
            const watchSwitch = page.getByRole('switch', { name: 'Enable Session Watch' });
            await watchSwitch.click();
            await waitFor(async () => (await watchSwitch.getAttribute('aria-checked')) === 'false', 'Session Watch\'s switch to go off', 20000, 200);
            await waitFor(async () => (await api('state')).ok === false, 'Autopilot to stop with Session Watch', 20000, 300);
            await sleep(2500);
            const offWords = (await failed.count()) ? await failed.first().innerText() : '';
            check('switched off in Plugins, DSH reports no failure (no "Could not disable")', offWords === '', offWords);
            await shot(page, shots, 'watch-switched-off-light');
            await page.getByRole('button', { name: 'Back to plugins' }).click();
            const autopilotSwitch = page.getByRole('switch', { name: 'Enable Autopilot' });
            await autopilotSwitch.waitFor({ state: 'visible', timeout: 15000 });
            check('Autopilot stays on in Plugins, waiting for Session Watch', (await autopilotSwitch.getAttribute('aria-checked')) === 'true', await autopilotSwitch.getAttribute('aria-checked'));
            await page.getByRole('button', { name: 'Autopilot', exact: true }).first().click();
            const trouble = page.locator('[data-suite-trouble="watch-off"]');
            await trouble.waitFor({ state: 'visible', timeout: 20000 });
            const words = (await trouble.innerText()).replace(/\n+/g, ' ');
            check('Autopilot\'s page says it needs Session Watch, and what to do', /^Autopilot needs Session Watch, which is not running\. Switch Session Watch on in Plugins\. This page comes back by itself once it runs\./.test(words), words);
            // On again from another window (DSH's own call, as its Plugins page makes it): this page comes back by itself.
            const on = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-watch', enabled: true });
            check('switched on again, DSH reports it applied, with no failure', on.ok === true && on.value?.application === 'applied' && !on.value?.error, JSON.stringify(on));
            const backAt = Date.now();
            await page.locator('[data-autopilot-page]').waitFor({ state: 'visible', timeout: 30000 });
            check('Autopilot\'s page comes back by itself', true, `after ${Math.round((Date.now() - backAt) / 1000)} s`);
            const said = run.logText().split('\n').filter((line) => /did not activate autopilot/.test(line));
            check('DSH never reports Autopilot as waiting for a service', said.length === 0, said.slice(-3).join('\n'));
            await shot(page, shots, 'watch-back-light');
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-watch-switch');
        });
        await window?.browser?.close().catch(() => {});
        window = undefined;
    }

    // ── Session Watch off ──────────────────────────────────────────────
    await restartWith(rowsWith({ off: ['session-watch'] }), 'Session Watch off');
    await step('Session Watch off in the profile: Autopilot loads but does nothing, and its page says what it needs', async () => {
        const r = await api('state');
        check('without Session Watch, Autopilot does nothing: its endpoints are not there', r.ok === false, JSON.stringify(r));
        const said = run.logText().split('\n').filter((line) => /did not activate autopilot/.test(line));
        check('DSH reports nothing waiting: Autopilot itself is loaded', said.length === 0, said.slice(-3).join('\n'));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Autopilot' });
        const { page } = window;
        await page.getByRole('button', { name: 'Autopilot', exact: true }).first().click();
        const trouble = page.locator('[data-suite-trouble="watch-off"]');
        await trouble.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await trouble.innerText()).replace(/\n+/g, ' ');
        check('the page says Autopilot needs Session Watch, and what to do, with no HTTP status',
            /^Autopilot needs Session Watch, which is not running\. Switch Session Watch on in Plugins\. This page comes back by itself once it runs\./.test(words) && !/404|HTTP|transport/.test(words), words);
        await shot(page, shots, 'watch-off-light');
        await setDark(page, true);
        await shot(page, shots, 'watch-off-dark');
        await setDark(page, false);
        await trouble.getByRole('button', { name: 'Open Session Watch in Plugins' }).click();
        await page.getByText('dsh-plugin-session-watch', { exact: true }).first().waitFor({ state: 'visible', timeout: 20000 });
        check('its button opens Session Watch in Plugins', true);
        await shot(page, shots, 'watch-off-plugins-light');
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-watch-off');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── enabled: false ─────────────────────────────────────────────────
    await restartWith(rowsWith({ enabled: false }), 'enabled: false');
    await waitFor(async () => (await api('state')).ok, 'Autopilot\'s endpoints with enabled: false', 30000);
    await step('enabled: false: Autopilot watches nothing, and its page says so and how to change it', async () => {
        const s = await state();
        check('with enabled: false Autopilot is loaded but idle', s.enabled === false && !s.problem, JSON.stringify({ enabled: s.enabled, problem: s.problem }));
        const refused = await api('setPaused', { paused: false });
        check('its actions are refused, saying why', refused.ok === false && /Autopilot is switched off in DSH's profile \(enabled: false\), so it watches nothing\./.test(refused.error?.message ?? ''), JSON.stringify(refused));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Autopilot' });
        const { page } = window;
        await page.getByRole('button', { name: 'Autopilot', exact: true }).first().click();
        const header = page.locator('[data-autopilot-header]');
        await header.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await header.innerText()).replace(/\n+/g, ' ');
        check('the page says it watches nothing, and how to change that', /Autopilot is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\), so it watches nothing\. To use it, set enabled to true there and restart DSH\./.test(words), words);
        await shot(page, shots, 'disabled-light');
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-disabled');
    });
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
    if (window?.page) await shot(window.page, shots, 'failed').catch(() => {});
} finally {
    await window?.browser?.close().catch(() => {});
    model.release();
    await run.stop();
    await model.close();
    const warnings = run.logText().split('\n').filter((line) => /autopilot|session-watch/i.test(line) && /warn|error|fail/i.test(line));
    if (warnings.length) console.log(`# DSH said about the suite:\n${warnings.slice(-20).map((l) => `#   ${l}`).join('\n')}`);
    run.cleanup();
}
console.log(`\n# DSH ${version}: ${tally.passed} passed, ${tally.failed} failed${pw ? '' : ', window checks skipped (no Playwright)'}`);
process.exit(tally.failed ? 1 : 0);
