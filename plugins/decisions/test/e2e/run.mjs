#!/usr/bin/env node
/**
 * Decisions in a real DSH: what waits on a person, from a scripted model's
 * real sessions, answered from Decisions, with each answer proven in the
 * session's own log; its page in a real window; its settings in Plugins
 * with the webhook address kept in DSH's key store.
 *
 * DSH runs from a throwaway DSH_HOME (test/e2e/harness.mjs) with the
 * session bridge, Session Watch, Autopilot and Decisions, a scripted model
 * (test/e2e/fake-model.mjs) that plays the agent, and new sessions on
 * Workspace Write, so writing outside the workspace asks for approval. A
 * stand-in window (DSH's events stream) gets DSH's own prompts, as an open
 * DSH window would. The webhook is a stand-in on this computer: nothing
 * goes to a real channel.
 *
 * - The browser half is served and parses; the endpoints answer, and refuse
 *   bad input in words.
 * - Replies: a DECISION NEEDED line (question and recommendation), a
 *   BLOCKED line and a plain question each make one card, logged once; a
 *   reply that asks nothing makes none. An answer in words, and Go with the
 *   recommendation, reach the session as its next message, read into a turn.
 *   A decision line's "— recommend X" without its colon splits off its
 *   pick, and the card keeps the lines before it (through the restart too).
 *   Questions in a coding model's shapes keep their words: a plain question
 *   with a dot in a file name or a version, and a decision line with
 *   `__init__.py` in code, on the card, in its lines, its pick and its log,
 *   and in the answer the session reads back; a DECISION NEEDED line quoted
 *   in a fenced code block is no card (the question after it is).
 * - Dismiss and bring back.
 * - Approvals: Decisions holds the request and passes it on at once (the
 *   window's prompt shows too); Allow once from Decisions lets the tool run
 *   (the file is written), Reject stops it, and an answer in the window
 *   takes Decisions' card down and is logged as answered in the session.
 * - The question box: a waiting question answered from Decisions (its
 *   answer is the tool's result, which Decisions checks in the session's
 *   log); a choice that was not offered is refused.
 *   (DSH's question box waits until it is answered unless a profile runs it
 *   in its timed mode; the late answer to a timed question whose wait ran
 *   out is covered by test/decisions.test.js.)
 * - A plugin's question (Autopilot's Ask first), answered from Decisions:
 *   Autopilot carries it out.
 * - A coordinator's thread (the coordinator plugin) that hands back needing
 *   a decision, relayed by its chat with a DECISION NEEDED line and a link:
 *   one card, the thread's, with the chat's recommendation; answered, the
 *   answer goes into the thread, and while the thread works on it neither
 *   card comes back and nothing is announced.
 * - A thread that hands back while its chat is held in a turn of its own,
 *   and whose reply asks: its card shows at once, and the handback the chat
 *   takes after its turn is the same card (same id and wait, announced
 *   once, its Markdown read as plain words), answered into the thread.
 * - The page, from DSH's sidebar: the count, the cards with their controls,
 *   an answer and an approval from the page (a one-line answer box that
 *   opens when you are in it; the page says when the answer reached the
 *   session), dismiss and bring back, the history; light and dark pictures,
 *   a narrow window.
 * - Its settings in Plugins (DSH's own form): a kind switched off leaves the
 *   list; the webhook address, refused when it cannot work, stored in DSH's
 *   key store (never the profile), shown as set, noted in What happened by
 *   its key, tested, used for new cards, never written to a log; a webhook
 *   that fails is said as a failure, on the page too, and a failed test
 *   under its button (focus kept); the address removed again, and noted.
 * - Decisions switched off and on from Plugins beside the coordinator: its
 *   page is styled again and the coordinator's sidebar sheet stays its own.
 * - A restart repeats nothing and keeps what is still waiting, each card
 *   with its lines and pick (read from its session's log).
 * - A command instead of a webhook (the profile's mirrorCommand).
 * - A wrong type ("yes" for a switch) and a number in quotes (#32): named
 *   with the value; the quoted number is flagged in the form and one Save
 *   stores it. A wrong setting: Decisions holds nothing and lists nothing,
 *   its page says which setting, and saving a good one fixes it. Session
 *   Watch's number in quotes: named in Decisions' header, whose button puts
 *   the cursor in Session Watch's field; one Save fixes it.
 * - Session Watch switched off in Plugins and on again: DSH reports no
 *   failure, and Decisions comes back by itself.
 * - Session Watch off in the profile: Decisions loads but does nothing (DSH
 *   reports nothing waiting, and approvals go to DSH's own prompt alone),
 *   its page says what to do and then asks no endpoint that is not there;
 *   `enabled: false` too (its log says it was switched off), then true
 *   again in the profile while DSH runs: applied, and its log says it was
 *   switched on again.
 * - Its folder is 700 and its files 600.
 *
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node plugins/decisions/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/; `node scripts/e2e.mjs
 * decisions` runs it on each of those and on the installed app's own DSH.
 * SHOTS=<folder> keeps the window's pictures there (default
 * .e2e/shots/decisions/<version>); KEEP=1 keeps the throwaway DSH_HOME.
 * Without Playwright the run fails, unless NO_WINDOW=1 says to run without
 * the window checks.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { DshRun, checks, dismissNotices, dshBin, findPlaywright, modeOf, openWindow as harnessWindow, pluginsDir, repoRoot, setDark, shot, sleep, waitFor } from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from '../../../../test/e2e/fake-model.mjs';

/**
 * A window as the harness opens it, with 30 s for each step instead of 15: on a busy computer a picture
 * taken just after the window changed size can wait longer than 15 s for the page to draw.
 */
async function openWindow(run, pw, options) {
    const window = await harnessWindow(run, pw, options);
    window.page.setDefaultTimeout(30000);
    return window;
}

const bin = dshBin();
if (!bin) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'decisions', version);
console.log(`# DSH ${version}: ${bin}`);
console.log(`# pictures: ${shots}`);

/** The stand-in webhook's secret part: it must never show in a log, a page or a failure line. */
const TOKEN = `e2e-${randomUUID()}`;
const tally = checks({ redact: (text) => text.replaceAll(TOKEN, '<token>') });
const { check, step } = tally;
const model = await startFakeModel();
const sink = await startSink();
const hookUrl = `http://127.0.0.1:${sink.port}/hook/${TOKEN}`;
const hookHost = `127.0.0.1:${sink.port}`;

/** A stand-in webhook on this computer: what it was sent, and what it answers. */
async function startSink() {
    const got = [];
    let status = 204;
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
        got.push({ at: Date.now(), method: req.method, url: req.url, body });
        res.writeHead(status);
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        got,
        answer: (code) => { status = code; },
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}

const json = (value) => JSON.stringify(value);
/** The session ids in the bridge's list. */
const sessionIdsOf = (list) => (Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : []).map((s) => s?.sessionId).filter(Boolean);
/** The profile's rows: new sessions on Workspace Write (writing outside the workspace asks), the suite's plugins, Decisions' settings. */
const rowsWith = ({ off = [], decisions = {}, watch = {} } = {}) => `- id: permission
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
${Object.entries({ deliveryTimeoutSeconds: 60, ...watch }).map(([key, value]) => `    ${key}: ${json(value)}`).join('\n')}
- id: autopilot
  config:
    defaultRule: "off"
    idleSeconds: 5
    startDelaySeconds: 1
    maxNotesPerHour: 80
- id: decisions
  config:
${Object.entries({ windowHours: 72, ...decisions }).map(([key, value]) => `    ${key}: ${json(value)}`).join('\n')}
- id: coordinator
  config:
    storeFile: ${json(join(run.home, 'coordinator', 'coordinator.json'))}
    memoryDir: ${json(join(run.home, 'coordinator', 'memory'))}
    logFile: ${json(join(run.home, 'coordinator', 'coordinator.log'))}
`;
const run = new DshRun({
    label: 'decisions',
    bin,
    plugins: {
        'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge'),
        'dsh-plugin-session-watch': join(pluginsDir, 'session-watch'),
        'dsh-plugin-autopilot': join(pluginsDir, 'autopilot'),
        'dsh-plugin-decisions': join(pluginsDir, 'decisions'),
        // A coordinator's threads hand back decisions, and its sidebar draws a style sheet of its own beside Decisions'.
        'dsh-plugin-coordinator': join(pluginsDir, 'coordinator'),
    },
});
// The rows name the run's own folder (the coordinator's files go there), so they are written once it exists.
run.rows = rowsWith();
const outside = join(run.root, 'outside');
mkdirSync(outside, { recursive: true });

const api = (method, args = {}) => run.api(`dsh-plugin-decisions/${method}`, args);
const state = async () => {
    const r = await api('state');
    if (!r.ok) throw new Error(`state: ${json(r.error)}`);
    return r.value;
};
const cardFor = async (sessionId, kind) => (await state()).waiting.find((c) => c.sessionId === sessionId && (!kind || c.kind === kind));
/**
 * Decisions' page from DSH's sidebar. DSH's first-run notice can come after the window's watch for it ended (on a
 * busy machine it came 30 s late and covered the click): it is moved out of the way first, and again if it covers it.
 */
async function openPage(page, timeout = 15000) {
    const entry = page.getByRole('button', { name: 'Decisions', exact: true }).first();
    await dismissNotices(page);
    await entry.click({ timeout: 5000 }).catch(async () => {
        await dismissNotices(page);
        await entry.click({ timeout });
    });
}
/** The page at its top. The page is its own scroller (the kit's page), so it is scrolled, not brought into view. */
async function toTop(page) {
    await page.locator('[data-decisions-page]').evaluate((el) => { el.scrollTop = 0; });
}
const waitCard = (sessionId, kind, timeout = 30000) => waitFor(() => cardFor(sessionId, kind), `a ${kind} card for ${sessionId}`, timeout, 300);
const leaves = (cardId, timeout = 30000) => waitFor(async () => !(await state()).waiting.some((c) => c.id === cardId), `${cardId} to leave the list`, timeout, 300);
/** Decisions' newest log entry about a card, of a kind (and a state). */
const entryFor = (cardId, kind, wanted, timeout = 40000) => waitFor(async () => (await state()).history.find((e) => e.cardId === cardId && e.kind === kind && (!wanted || e.state === wanted)),
    `${kind} ${wanted ?? ''} for ${cardId}`, timeout, 300);
const idle = (sessionId) => waitFor(async () => {
    const s = await run.session(sessionId);
    return s.status !== 'running' && s.turns.started > 0 && s.turns.started === s.turns.ended ? s : null;
}, `${sessionId} to finish its turn`, 30000);
/** The model sees "E2E:call <tool> <json>" and calls that tool. */
const call = (tool, args) => `E2E:call ${tool} ${json(args)}`;
/** Write outside the workspace: on Workspace Write that asks for Full access. */
const writeOutside = (name, why) => call('write', { file_path: join(outside, name), content: `written by ${name}`, sandbox_permissions: 'danger-full-access', justification: why });
/** The window's prompt for that write: DSH's reason names the justification. */
const escalation = (why) => (request) => request.reason === `escalate sandbox to danger-full-access: ${why}`;
const pattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const todos = (...items) => json(items.map(([content, status]) => ({ content, status })));

/** Whether the session's log shows a message starting with `text`, with a turn reading it in. */
async function readIntoTurn(sessionId, text) {
    const events = await run.events(sessionId);
    const at = events.findIndex((e) => e.type === 'user/message' && typeof e.text === 'string' && e.text.startsWith(text));
    if (at < 0) return false;
    const turnBefore = events.slice(0, at).findLast((e) => e.type === 'turn/start');
    const endBefore = events.slice(0, at).findLast((e) => e.type === 'turn/end');
    const turnAfter = events.slice(at + 1).find((e) => e.type === 'turn/start');
    return Boolean(turnAfter) || (Boolean(turnBefore) && (!endBefore || endBefore.seq < turnBefore.seq));
}

/** DSH's prompts as an open window gets them (test/e2e/harness.mjs). */
const promptsOf = () => run.prompts();

let prompts;
/** Start DSH again with other rows (the settings a person would have in the profile). */
async function restartWith(rows, what) {
    prompts?.close();
    await run.stop();
    run.rows = rows;
    run.writeProfile(model.port);
    await run.boot(what);
    prompts = await promptsOf();
}

/** Quit DSH and start it again with the profile as it is, settings saved in Plugins included. */
async function restart(what) {
    prompts?.close();
    await run.stop();
    await run.boot(what);
    prompts = await promptsOf();
}

/** Text that must never hold the webhook's secret part: DSH's log, Decisions' and the watcher's files. */
function tokenFound() {
    const places = [run.log, join(run.home, 'decisions', 'events.jsonl'), join(run.home, 'decisions', 'state.json'), join(run.home, 'profiles', 'web', 'cordis.patch.yml')];
    return places.filter((file) => {
        try { return readFileSync(file, 'utf8').includes(TOKEN); } catch { return false; }
    }).map((file) => file.slice(run.root.length + 1));
}

let window;
let pw;
const ids = {};
const cards = {};
try {
    run.writeProfile(model.port);
    await run.boot('first start');
    await waitFor(async () => (await api('state')).ok, 'Decisions\' endpoints', 30000);
    prompts = await promptsOf();

    // ── The browser half and the endpoints ─────────────────────────────
    await step('DSH serves Decisions\' browser half and it parses', async () => {
        const client = await run.clientOf('dsh-plugin-decisions');
        let parses = false;
        try {
            new Script(client.text);
            parses = true;
        } catch {}
        check('DSH serves Decisions\' browser half and it parses', client.status === 200 && parses && client.text.includes('dsh-plugin-decisions'), `${client.url ?? 'not in the boot graph'}: ${client.status}`);
    });
    await step('the endpoints answer, and refuse bad input in words', async () => {
        const s = await state();
        check('the state endpoint answers: on, every kind listed, nothing sent elsewhere', s.enabled === true && !s.problem && Object.values(s.sources).every(Boolean) && s.mirror.mode === 'off' && s.windowHours === 72,
            json({ enabled: s.enabled, problem: s.problem, sources: s.sources, mirror: s.mirror }));
        check('it says the Notifications plugin is not running here (none in this profile)', s.notify === true && s.notifications === false, json({ notify: s.notify, notifications: s.notifications }));
        const nothing = await api('answer', { id: 'decision:nobody:1', answer: { text: 'yes' } });
        const empty = await api('dismiss', { id: '' });
        const test = await api('testMirror');
        check('bad input is refused with words a person can act on',
            nothing.ok === false && /no longer waiting/.test(nothing.error?.message)
            && empty.ok === false && /Name what to dismiss/.test(empty.error?.message)
            && test.ok === false && /^Not sent: Sending elsewhere is off\. Choose Webhook or Command in Decisions' settings in Plugins first\.$/.test(test.error?.message),
        json([nothing.error, empty.error, test.error]));
        const badge = await api('badge');
        check('the sidebar badge endpoint answers', badge.ok && badge.value.waiting === 0 && badge.value.urgent === 0, json(badge));
    });

    // ── Replies that ask ───────────────────────────────────────────────
    ids.schema = await run.newSession('E2E:say I compared both ways.\\nDECISION NEEDED: Drop the old tables? — recommend: Keep them a week', 'Schema cleanup');
    ids.release = await run.newSession('E2E:say DECISION NEEDED: Ship on Friday? — recommend: Ship on Monday', 'Release timing');
    ids.staging = await run.newSession('E2E:say I tried twice.\\nBLOCKED: The staging database refuses my login.', 'Staging check');
    ids.branch = await run.newSession('E2E:ask', 'Branch question');
    ids.done = await run.newSession('E2E:say All done: the tests pass.', 'Finished work');
    ids.offer = await run.newSession("E2E:say The tests pass. Let me know if you'd like me to update the docs too.", 'Offer only');
    await step('replies that ask make one card each, with the question and the recommendation', async () => {
        cards.schema = await waitCard(ids.schema, 'decision');
        check('a DECISION NEEDED line makes a card with its question and recommendation', cards.schema.question === 'Drop the old tables?' && cards.schema.recommendation === 'Keep them a week' && cards.schema.title === 'Schema cleanup' && cards.schema.answer === 'text', json(cards.schema));
        cards.staging = await waitCard(ids.staging, 'blocked');
        check('a BLOCKED line makes a blocked card', cards.staging.question === 'The staging database refuses my login.', json(cards.staging));
        cards.branch = await waitCard(ids.branch, 'reply');
        check('a reply that ends with a question makes a card', cards.branch.question === 'Which branch should I use for this?', json(cards.branch));
        cards.release = await waitCard(ids.release, 'decision');
        await idle(ids.done);
        await idle(ids.offer);
        await sleep(1500);
        check('a reply that asks nothing makes no card', !(await state()).waiting.some((c) => c.sessionId === ids.done));
        check('a reply that only offers more ("Let me know if you\'d like…") makes no card', !(await state()).waiting.some((c) => c.sessionId === ids.offer));
        const fresh = (await state()).history.filter((e) => e.kind === 'new');
        const once = [cards.schema, cards.staging, cards.branch, cards.release].every((c) => fresh.filter((e) => e.cardId === c.id).length === 1);
        check('each new card is logged once, with its headline', once && fresh.some((e) => e.title === 'Schema cleanup' && e.text === 'Needs a decision') && fresh.some((e) => e.title === 'Staging check' && e.text === 'Blocked'), json(fresh.map((e) => e.text)));
        const badge = await api('badge');
        check('the badge counts them', badge.ok && badge.value.waiting === 4, json(badge));
    });
    // Markers where models put them: after the end of a sentence, in the reply's last lines.
    ids.inlineBlocked = await run.newSession('E2E:say I tried the staging server twice, so I cannot proceed without valid credentials. BLOCKED: working staging credentials (or an approved SSH login) for the staging server.', 'Inline blocker');
    ids.inlineDecision = await run.newSession('E2E:say Both builds pass and the diff is small. DECISION NEEDED: Merge today or wait for review? — recommend: wait for review', 'Inline decision');
    await step('markers written inline, after a sentence, make cards too, with the recommendation', async () => {
        const blocked = await waitCard(ids.inlineBlocked, 'blocked');
        check('an inline BLOCKED: makes a blocked card with what is needed', blocked.question === 'working staging credentials (or an approved SSH login) for the staging server.', json(blocked));
        const decision = await waitCard(ids.inlineDecision, 'decision');
        check('an inline DECISION NEEDED: keeps its question and its recommendation', decision.question === 'Merge today or wait for review?' && decision.recommendation === 'wait for review', json(decision));
        const went = await api('answer', { id: decision.id, answer: { recommended: true } });
        const rec = await entryFor(decision.id, 'answer', 'delivered');
        check('Go with the recommendation works for it', went.ok && rec.text === 'Went with the recommendation: wait for review', json(rec));
        const words = await api('answer', { id: blocked.id, answer: { text: 'Use the read-only account until Monday.' } });
        check('an answer in words goes to the blocked one', words.ok && (await entryFor(blocked.id, 'answer', 'delivered')).text === 'Answered: Use the read-only account until Monday.', json(words));
        await leaves(decision.id);
        await leaves(blocked.id);
        await idle(ids.inlineDecision);
        await idle(ids.inlineBlocked);
    });
    await step('an answer in words, and Go with the recommendation, reach the session and are read into a turn', async () => {
        const answered = await api('answer', { id: cards.schema.id, answer: { text: 'Keep them, and archive them next week.' } });
        check('the answer is taken', answered.ok && ['delivered', 'in the queue'].includes(answered.value?.state), json(answered));
        const entry = await entryFor(cards.schema.id, 'answer', 'delivered');
        check('the log proves it: delivered, with the turn that read it', typeof entry.turn === 'number' && entry.by === 'you' && entry.text === 'Answered: Keep them, and archive them next week.', json(entry));
        check('the session\'s own log shows the answer read into a turn, saying what it answers',
            await readIntoTurn(ids.schema, '[Decisions] The person answered your DECISION NEEDED line (“Drop the old tables?”):\n\nKeep them, and archive them next week.'));
        await leaves(cards.schema.id);
        check('the card leaves the list once answered', true);
        const went = await api('answer', { id: cards.release.id, answer: { recommended: true } });
        const rec = await entryFor(cards.release.id, 'answer', 'delivered');
        check('Go with the recommendation sends it in words', went.ok && rec.text === 'Went with the recommendation: Ship on Monday'
            && await readIntoTurn(ids.release, '[Decisions] The person answered your DECISION NEEDED line (“Ship on Friday?”): go with your recommendation (Ship on Monday).'), json(rec));
        await idle(ids.schema);
        await sleep(1000);
        check('the session\'s next reply asks nothing, so no new card for it', !(await state()).waiting.some((c) => c.sessionId === ids.schema));
        const again = await api('answer', { id: cards.schema.id, answer: { text: 'again' } });
        check('a second answer to the same card is refused in words', again.ok === false && /no longer waiting/.test(again.error?.message ?? ''), json(again));
    });
    await step('dismiss and bring back', async () => {
        const dismissed = await api('dismiss', { id: cards.branch.id });
        let s = await state();
        check('a dismissed card leaves the list for Dismissed, and the badge drops', dismissed.ok && !s.waiting.some((c) => c.id === cards.branch.id) && s.dismissed.some((c) => c.id === cards.branch.id)
            && (await api('badge')).value.waiting === s.waiting.length, json({ waiting: s.waiting.map((c) => c.id), dismissed: s.dismissed.map((c) => c.id) }));
        const back = await api('undismiss', { id: cards.branch.id });
        s = await state();
        check('Bring back puts it in the list again, and both are logged as yours', back.ok && s.waiting.some((c) => c.id === cards.branch.id)
            && s.history.some((e) => e.kind === 'dismiss' && e.cardId === cards.branch.id && e.by === 'you') && s.history.some((e) => e.kind === 'undismiss' && e.by === 'you'), json(s.history.slice(0, 3)));
    });

    // ── Approvals ──────────────────────────────────────────────────────
    ids.allow = await run.newSession(writeOutside('allowed.txt', 'It writes the report next to the workspace.'), 'Report writer');
    await step('an approval: held by Decisions and passed on at once; Allow once from Decisions lets the tool run', async () => {
        cards.allow = await waitCard(ids.allow, 'approval');
        check('the approval shows as a card: the question in DSH\'s words, why, and the file',
            cards.allow.question === 'Allow this change with Full access?' && cards.allow.detail === 'It writes the report next to the workspace.'
            && cards.allow.what === join(outside, 'allowed.txt') && cards.allow.answer === 'approval' && cards.allow.live === true, json(cards.allow));
        check('its details leave out what the card already says', !(cards.allow.lines ?? []).some((line) => /sandbox_permissions|justification/.test(line)), json(cards.allow.lines));
        const prompt = await waitFor(() => prompts.find('approval/request', escalation('It writes the report next to the workspace.')), 'the window\'s own prompt', 15000, 200);
        check('DSH\'s own prompt reaches the window too: Decisions passes the request on at once', Boolean(prompt));
        const badge = await api('badge');
        check('the badge counts it as holding a running turn', badge.ok && badge.value.urgent === 1, json(badge));
        const r = await api('answer', { id: cards.allow.id, answer: { decision: 'allow' } });
        check('Allow once is taken', r.ok, json(r));
        await waitFor(() => existsSync(join(outside, 'allowed.txt')), 'the file the tool writes once allowed', 20000);
        check('the tool runs: the file is written', readFileSync(join(outside, 'allowed.txt'), 'utf8') === 'written by allowed.txt');
        const entry = await entryFor(cards.allow.id, 'answer', 'answered');
        check('the log proves it from the session\'s own log (DSH recorded Allow once), without the tool\'s name', entry.text === 'Allowed once' && entry.question === 'Allow this change with Full access?', json(entry));
        const late = await prompts.answer(prompt, 'rejected');
        await idle(ids.allow);
        check('the window\'s prompt is gone once Decisions answered: a late answer there changes nothing', existsSync(join(outside, 'allowed.txt')) && !(await state()).waiting.some((c) => c.sessionId === ids.allow), json(late));
    });
    ids.reject = await run.newSession(writeOutside('rejected.txt', 'It cleans up next to the workspace.'), 'Cleanup');
    await step('Reject from Decisions: the tool does not run', async () => {
        cards.reject = await waitCard(ids.reject, 'approval');
        const r = await api('answer', { id: cards.reject.id, answer: { decision: 'reject' } });
        const entry = await entryFor(cards.reject.id, 'answer', 'answered');
        await idle(ids.reject);
        check('Reject is taken, proven in the session\'s log, and nothing is written', r.ok && entry.text === 'Rejected' && !existsSync(join(outside, 'rejected.txt')), json(entry));
    });
    ids.window = await run.newSession(writeOutside('window.txt', 'It updates the shared notes.'), 'Shared notes');
    await step('an approval answered in the window: Decisions\' card goes, and its log says so', async () => {
        cards.window = await waitCard(ids.window, 'approval');
        const prompt = await waitFor(() => prompts.find('approval/request', escalation('It updates the shared notes.')), 'the window\'s prompt for the shared notes', 15000, 200);
        const r = await prompts.answer(prompt, 'rejected');
        await leaves(cards.window.id);
        const entry = await entryFor(cards.window.id, 'elsewhere');
        await idle(ids.window);
        check('answered in the window: the card leaves, the log says it was answered in the session, and nothing is written',
            r.ok !== false && entry.text === 'Answered in the session: rejected' && entry.state === 'answered' && !existsSync(join(outside, 'window.txt')), json({ r, entry }));
    });

    // ── The question box ───────────────────────────────────────────────
    ids.target = await run.newSession(call('ask_user_question', {
        questions: [{ id: 'env', question: 'Which environment should I deploy to?', header: 'Target', options: [{ label: 'staging', description: 'Safe to break' }, { label: 'production' }] }],
        timeout: -1,
    }), 'Deploy target');
    await step('a question in the question box, answered from Decisions: the answer is the tool\'s result', async () => {
        cards.target = await waitCard(ids.target, 'question');
        check('the question shows with its choices', cards.target.answer === 'questions' && cards.target.live === true && cards.target.questions?.[0]?.header === 'Target'
            && cards.target.questions[0].options.map((o) => o.label).join() === 'staging,production', json(cards.target));
        const bad = await api('answer', { id: cards.target.id, answer: { answers: [{ id: 'env', selected: ['qa'] }] } });
        check('a choice that was not offered is refused in words, and the question still waits', bad.ok === false && /“qa” is not one of the choices/.test(bad.error?.message ?? '') && Boolean(await cardFor(ids.target, 'question')), json(bad));
        const r = await api('answer', { id: cards.target.id, answer: { answers: [{ id: 'env', selected: ['staging'] }] } });
        const entry = await entryFor(cards.target.id, 'answer', 'answered');
        await idle(ids.target);
        const events = await run.events(ids.target);
        const result = events.find((e) => e.type === 'tool/result' && /staging/.test(e.text ?? ''));
        check('the answer is taken, proven by the tool\'s result in the session\'s log (Decisions checked it there)', r.ok && entry.text === 'Answered: staging' && Number.isFinite(entry.provedAt) && Boolean(result), json({ entry, result: result?.text?.slice(0, 200) }));
    });
    // ── A plugin's question ────────────────────────────────────────────
    ids.pilot = await run.newSession(`E2E:todos ${todos(['Rename the config keys', 'in_progress'])}\n#note=progress`, 'Config keys');
    await run.api('dsh-plugin-autopilot/setRule', { sessionId: ids.pilot, rule: 'ask' });
    await step('Autopilot\'s Ask first shows in Decisions, and the answer there is carried out by Autopilot', async () => {
        cards.pilot = await waitCard(ids.pilot, 'ask', 40000);
        check('the plugin\'s question shows with its own options', cards.pilot.source === 'Autopilot' && cards.pilot.options.map((o) => o.id).join() === 'go,skip' && cards.pilot.options[0].label === cards.pilot.recommendation, json(cards.pilot));
        const r = await api('answer', { id: cards.pilot.id, answer: { option: 'go' } });
        const entry = await entryFor(cards.pilot.id, 'answer', 'answered');
        const pilotLog = await waitFor(async () => {
            const s = await run.api('dsh-plugin-autopilot/state');
            return s.value?.log?.find((e) => e.sessionId === ids.pilot && e.kind === 'nudge' && e.state === 'delivered');
        }, 'Autopilot\'s note, delivered', 30000, 300);
        check('answered from Decisions, Autopilot sends its note, delivered', r.ok && entry.state === 'answered' && pilotLog.state === 'delivered', json({ entry, pilotLog }));
    });

    // ── A coordinator's thread ─────────────────────────────────────────
    await step('a coordinator\'s thread that needs a decision: one card, the thread\'s; answered, the chat\'s relay of it does not come back', async () => {
        ids.chat = await run.newSession('E2E:say Ready to run threads.', 'Port chat');
        await idle(ids.chat);
        const on = await run.api('commands/execute', { agentId: ids.chat, line: '/coordinate', submittedAttachments: [] });
        check('/coordinate makes the chat coordinate', on.ok === true, json(on).slice(0, 300));
        // The thread hands back needing a decision; the chat relays it with a DECISION NEEDED line of its own, and a link.
        const relay = 'E2E:say [Port pick](.dsh-thread/t1): the thread needs your decision.\\n\\nDECISION NEEDED: Port 8080 or 9090? — recommend: Port 8080';
        const handback = { status: 'needs_decision', summary: `Port 8080 or 9090? I recommend 8080. ${relay}` };
        await run.bridge('POST', `/sessions/${ids.chat}/prompt`, { text: call('thread_start', { ask: 'Pick the port.', title: 'Port pick', brief: `Pick the port, then report. ${call('thread_handback', handback)}` }) });
        cards.thread = await waitFor(async () => (await state()).waiting.find((c) => c.kind === 'thread' && c.via?.sessionId === ids.chat), 'the thread\'s card', 40000, 300);
        await waitFor(async () => /DECISION NEEDED: Port 8080 or 9090\?/.test((await run.session(ids.chat)).lastAssistant?.text ?? ''), 'the chat\'s relay', 30000, 300);
        await sleep(1500);
        let s = await state();
        const mine = s.waiting.filter((c) => c.sessionId === ids.chat || c.sessionId === cards.thread.sessionId);
        check('one card, the thread\'s, with the chat\'s recommendation; the chat\'s relay is not a second card', mine.length === 1 && mine[0].kind === 'thread' && mine[0].recommendation === 'Port 8080'
            && /Port 8080 or 9090\?/.test(mine[0].question ?? ''), json(mine));
        const newBefore = s.history.filter((e) => e.kind === 'new' && e.sessionId === ids.chat).length;
        // Answered from Decisions: into the thread, which works on it (held open here); the chat's relay is still its newest reply.
        const r = await api('answer', { id: cards.thread.id, answer: { text: 'Use 8080. E2E:slow' } });
        check('the answer goes into the thread', r.ok, json(r));
        await waitFor(async () => (await run.session(cards.thread.sessionId)).status === 'running', 'the thread to work on the answer', 20000, 300);
        let back;
        for (let i = 0; i < 12 && !back; i += 1) {
            await sleep(500);
            s = await state();
            back = s.waiting.find((c) => c.sessionId === ids.chat || c.sessionId === cards.thread.sessionId);
        }
        check('while the thread works on it, neither the thread nor the chat\'s relay of its question comes back as a card', !back, json(back));
        check('nothing is announced for the chat', s.history.filter((e) => e.kind === 'new' && e.sessionId === ids.chat).length === newBefore, json(s.history.filter((e) => e.sessionId === ids.chat).slice(0, 3)));
        model.release();
        await idle(cards.thread.sessionId).catch(() => {});
    });

    // A thread hands back while its chat is in a turn on something else, as live chats do: the chat takes it late.
    await step('a thread\'s question and the handback its busy chat takes late are one card: one new line, one wait', async () => {
        ids.lateChat = await run.newSession('E2E:say Ready to run threads.', 'Branch chat');
        await idle(ids.lateChat);
        const on = await run.api('commands/execute', { agentId: ids.lateChat, line: '/coordinate', submittedAttachments: [] });
        check('/coordinate makes a second chat coordinate', on.ok === true, json(on).slice(0, 300));
        const known = new Set(sessionIdsOf(await run.bridge('GET', '/sessions')));
        // The thread's first turn is held open (its reply keeps going) until the test lets go of it.
        await run.bridge('POST', `/sessions/${ids.lateChat}/prompt`, { text: call('thread_start', { ask: 'Name the release branch.', title: 'Branch pick', brief: 'Name the release branch, then report. E2E:slow #late-thread' }) });
        const threadHeld = await waitFor(() => [...model.held].find((e) => e.record.fresh.includes('#late-thread')), 'the thread\'s turn, held open', 30000, 200);
        await idle(ids.lateChat);
        ids.lateThread = await waitFor(async () => sessionIdsOf(await run.bridge('GET', '/sessions')).find((id) => !known.has(id) && id !== ids.lateChat), 'the thread\'s session', 20000, 300);
        // The chat goes into a long turn of its own.
        await run.bridge('POST', `/sessions/${ids.lateChat}/prompt`, { text: 'Also read the changelog. E2E:slow #late-chat' });
        const chatHeld = await waitFor(() => [...model.held].find((e) => e.record.fresh.includes('#late-chat')), 'the chat\'s own turn, held open', 30000, 200);
        // The thread hands back needing a decision, then its reply asks the person; the chat is busy, so the handback waits for it.
        await run.bridge('POST', `/sessions/${ids.lateThread}/prompt`, { text: `${call('thread_handback', { status: 'needs_decision', summary: 'Two names fit: `release/v2` or **rel-2**. The deploy target is next.' })}\n#final=ask`, mode: 'steer' });
        threadHeld.finish();
        const first = await waitFor(async () => (await state()).waiting.find((c) => c.sessionId === ids.lateThread), 'the thread\'s own question as a card', 40000, 300);
        const chatBusy = (await run.session(ids.lateChat)).status === 'running';
        check('the thread\'s question is the thread\'s card from its first sight, named for its chat, while the chat is busy',
            first.kind === 'thread' && new RegExp(`^thread:${pattern(ids.lateThread)}:\\d+$`).test(first.id) && first.via?.sessionId === ids.lateChat && first.question === 'Should I deploy it to staging or to production?' && chatBusy, json({ first, chatBusy }));
        await sleep(1500);
        // The chat's turn ends, and it takes the handback now.
        chatHeld.finish();
        const landed = await waitFor(async () => (await state()).waiting.find((c) => c.id === first.id && /^Two names fit/.test(c.question ?? '')), 'the handback to land on the same card', 40000, 300).catch(() => undefined);
        await sleep(1500);
        const s = await state();
        const mine = s.waiting.filter((c) => c.sessionId === ids.lateThread || c.sessionId === ids.lateChat);
        check('the handback the chat took late is the same card, in the handback\'s words: one card, the same id, the same wait', Boolean(landed) && mine.length === 1 && mine[0].id === first.id && mine[0].at === first.at, json(mine));
        check('the handback\'s words read plain, its code and bold marks dropped', landed?.question === 'Two names fit: release/v2 or rel-2. The deploy target is next.', json(landed));
        const told = s.history.filter((e) => e.kind === 'new' && (e.sessionId === ids.lateThread || e.sessionId === ids.lateChat));
        check('it was announced once', told.length === 1 && told[0].cardId === first.id, json(told));
        // Answered from Decisions: into the thread.
        const r = await api('answer', { id: first.id, answer: { text: 'Use release/v2, and deploy to staging.' } });
        check('the answer goes into the thread, saying it answers its handback', r.ok && await waitFor(() => readIntoTurn(ids.lateThread, '[Decisions] The person answered your handback (“Two names fit: release/v2 or rel-2.'), 'the answer in the thread\'s log', 30000, 300).catch(() => false), json(r));
        await idle(ids.lateThread).catch(() => {});
        await leaves(first.id).catch(() => {});
    });

    // A plain question after a list: the card carries the list, so it can be answered in place.
    ids.names = await run.newSession('E2E:say Here are three names for the CLI:\\n1. **tidy** — short\\n2. **sweep** — says what it does\\n3. **pare** — rare\\n\\nWhich one do you prefer?', 'CLI names');
    await step('a plain question after a list carries the list', async () => {
        cards.names = await waitCard(ids.names, 'reply');
        check('the card keeps the reply\'s lines before its question, without Markdown marks', cards.names.question === 'Which one do you prefer?' && cards.names.context === 'Here are three names for the CLI:\n1. tidy — short\n2. sweep — says what it does\n3. pare — rare', json(cards.names));
    });
    // A decision line as GLM-5.3 Flash writes one, with the lines before it; it waits through the restart further on.
    ids.report = await run.newSession('E2E:say The report has 14 pages.\\nThe second review is tomorrow.\\n\\nDECISION NEEDED: Send the report to the list now? — recommend sending it after the second review', 'Report send');
    await step('a decision line\'s "— recommend X" without its colon splits off its pick; the card keeps the lines before it', async () => {
        cards.report = await waitCard(ids.report, 'decision');
        check('the question, the pick and the lines before it', cards.report.question === 'Send the report to the list now?' && cards.report.recommendation === 'sending it after the second review'
            && cards.report.context === 'The report has 14 pages.\nThe second review is tomorrow.', json(cards.report));
    });

    // Questions in a coding model's shapes: a dot in a file name or a version, and dunders in code.
    ids.parser = await run.newSession('E2E:say I found two failing tests in the parser suite. Should I fix the bug in `parser.py` first?', 'Parser fix');
    ids.version = await run.newSession('E2E:say Both builds pass. Which do you want to release: `v1.2` or `v1.3`?', 'Version pick');
    ids.entry = await run.newSession('E2E:say Two entry points exist.\\nDECISION NEEDED: Should I rename `__init__.py` to main.py? — recommend: keep `__init__.py`', 'Entry point');
    // A rule quoted in a fenced code block is shown, not asked: the card is the question after it.
    ids.rules = await run.newSession('E2E:say I added the rule to AGENTS.md:\\n```\\nDECISION NEEDED: <question> — recommend: <pick>\\n```\\nShould I add it to the README too?', 'Rules note');
    await step('questions in a coding model\'s shapes keep their words: a dot in a file name or a version, dunders in code, a rule quoted in a code block', async () => {
        cards.parser = await waitCard(ids.parser, 'reply');
        check('a plain question with a file name in it is the whole question, with the sentence before it', cards.parser.question === 'Should I fix the bug in parser.py first?' && cards.parser.context === 'I found two failing tests in the parser suite.', json(cards.parser));
        cards.version = await waitCard(ids.version, 'reply');
        check('one with versions in it too', cards.version.question === 'Which do you want to release: v1.2 or v1.3?' && cards.version.context === 'Both builds pass.', json(cards.version));
        cards.entry = await waitCard(ids.entry, 'decision');
        check('a decision line keeps __init__.py whole in its question, its pick and its lines', cards.entry.question === 'Should I rename __init__.py to main.py?' && cards.entry.recommendation === 'keep __init__.py' && cards.entry.context === 'Two entry points exist.', json(cards.entry));
        cards.rules = await waitCard(ids.rules, 'reply');
        const rulesCards = (await state()).waiting.filter((c) => c.sessionId === ids.rules);
        check('a DECISION NEEDED line quoted in a code block is no card and gives no pick: the card is the question after it', rulesCards.length === 1 && cards.rules.question === 'Should I add it to the README too?' && !cards.rules.recommendation, json(rulesCards));
        const mine = [cards.parser, cards.version, cards.entry, cards.rules];
        const told = await waitFor(async () => {
            const fresh = (await state()).history.filter((e) => e.kind === 'new' && mine.some((c) => c.id === e.cardId));
            return fresh.length === 4 ? fresh : null;
        }, 'the four new lines', 15000, 300).catch(() => []);
        check('each is logged once, with its whole question', told.length === 4 && mine.every((c) => told.filter((e) => e.cardId === c.id && e.question === c.question).length === 1), json(told));
        const words = await api('answer', { id: cards.parser.id, answer: { text: 'Yes, fix it first.' } });
        check('answered in words, the session reads the whole question back', words.ok
            && await waitFor(() => readIntoTurn(ids.parser, '[Decisions] The person answered your question (“Should I fix the bug in parser.py first?”):\n\nYes, fix it first.'), 'the answer in the parser session\'s log', 30000, 300).catch(() => false), json(words));
        const went = await api('answer', { id: cards.entry.id, answer: { recommended: true } });
        check('Go with the recommendation sends __init__.py whole', went.ok
            && await waitFor(() => readIntoTurn(ids.entry, '[Decisions] The person answered your DECISION NEEDED line (“Should I rename __init__.py to main.py?”): go with your recommendation (keep __init__.py).'), 'the answer in the entry session\'s log', 30000, 300).catch(() => false), json(went));
        const rules = await api('answer', { id: cards.rules.id, answer: { text: 'No, AGENTS.md is enough.' } });
        check('and it is answered as that question', rules.ok
            && await waitFor(() => readIntoTurn(ids.rules, '[Decisions] The person answered your question (“Should I add it to the README too?”):\n\nNo, AGENTS.md is enough.'), 'the answer in the rules session\'s log', 30000, 300).catch(() => false), json(rules));
        await leaves(cards.parser.id).catch(() => {});
        await leaves(cards.entry.id).catch(() => {});
        await leaves(cards.rules.id).catch(() => {});
        await idle(ids.parser).catch(() => {});
        await idle(ids.entry).catch(() => {});
        await idle(ids.rules).catch(() => {});
    });

    // ── The page ───────────────────────────────────────────────────────
    pw = await findPlaywright();
    if (!pw) {
        check('Playwright is here for the window checks (NO_WINDOW=1 runs without them)', process.env.NO_WINDOW === '1', 'install it: npm i --prefix .e2e/tools playwright-core (or set PLAYWRIGHT_MODULE)');
    } else {
        await step('the page', async () => {
            window = await openWindow(run, pw, { entry: 'Decisions' });
            const { page } = window;
            await openPage(page);
            await page.locator('[data-decisions-page]').waitFor({ state: 'visible', timeout: 20000 });
            await page.locator('[data-decisions-card]').first().waitFor({ state: 'visible' });
            const s = await state();
            const status = (await page.locator('[data-decisions-header] .dshdc-status').textContent()) ?? '';
            check('the page opens from DSH\'s sidebar, with what waits in words', (await page.locator('[data-decisions-header]').getAttribute('data-decisions-header')) === 'on' && status === `${s.waiting.length} waiting on you`, status);
            const icon = await page.locator('[data-decisions-icon]').first().getAttribute('data-decisions-icon');
            check('the sidebar icon shows the count', icon === String(s.waiting.length), icon);
            const blocked = page.locator(`[data-decisions-id="${cards.staging.id}"]`);
            check('a card shows its state, its session, its wait and its question', /blocked/.test(await blocked.innerText()) && /Staging check/.test(await blocked.innerText()) && /waiting (less than a minute|\d+ minutes?)/.test(await blocked.innerText()) && /The staging database refuses my login\./.test(await blocked.innerText()),
                await blocked.innerText());
            const names = page.locator(`[data-decisions-id="${cards.names.id}"]`);
            const before = names.locator('[data-decisions-context]');
            const unfold = before.getByRole('button', { name: 'Show 2 more lines of the reply' });
            check('a question\'s earlier lines show folded after two, with a button to unfold them', /Here are three names for the CLI:\n1\. tidy — short$/.test((await before.locator('p').innerText()).trim()) && await unfold.getAttribute('aria-expanded') === 'false', await before.innerText());
            await unfold.click();
            const fold = before.getByRole('button', { name: 'Show less of the reply' });
            check('unfolded, all of them show, and the button keeps the keyboard', /3\. pare — rare$/.test((await before.locator('p').innerText()).trim()) && await fold.getAttribute('aria-expanded') === 'true' && await fold.evaluate((el) => el === document.activeElement), await before.innerText());
            check('a BLOCKED line says what the session is blocked on', /Blocked on: The staging database refuses my login\./.test(await blocked.innerText()), await blocked.innerText());
            const version = page.locator(`[data-decisions-id="${cards.version.id}"]`);
            const versionText = await version.innerText();
            check('a question with versions in it reads whole on its card, with the sentence before it', versionText.includes('Which do you want to release: v1.2 or v1.3?') && versionText.includes('Both builds pass.') && !versionText.includes('`'), versionText);
            await shot(page, shots, 'dotted-question-light', version);
            // The page from its top; the whole list in a window tall enough to hold it (a picture of a part taller
            // than the window shows only what is in view, the rest blank).
            await toTop(page);
            await shot(page, shots, 'decisions-light');
            await page.setViewportSize({ width: 1280, height: 2200 });
            await page.waitForTimeout(300);
            await shot(page, shots, 'waiting-light', page.locator('[data-decisions-waiting]'));
            await setDark(page, true);
            await shot(page, shots, 'waiting-dark', page.locator('[data-decisions-waiting]'));
            await page.setViewportSize({ width: 1280, height: 860 });
            await page.waitForTimeout(300);
            await toTop(page);
            await shot(page, shots, 'decisions-dark');
            await page.locator('[data-decisions-history]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
            await shot(page, shots, 'history-dark');
            await setDark(page, false);
            await shot(page, shots, 'history-light');
            await toTop(page);
            // A narrow window: the page reflows, nothing spills sideways.
            await page.setViewportSize({ width: 760, height: 900 });
            await page.waitForTimeout(500);
            const spill = await page.locator('[data-decisions-page]').evaluate((el) => el.scrollWidth - el.clientWidth);
            check('in a narrow window nothing on the page spills sideways', spill <= 1, `${spill}px wider than the page`);
            await shot(page, shots, 'narrow-light');
            await page.setViewportSize({ width: 1280, height: 860 });
            await page.waitForTimeout(300);
        });
        await step('answers from the page', async () => {
            const { page } = window;
            // A blocked session, answered in words from its card.
            const blocked = page.locator(`[data-decisions-id="${cards.staging.id}"]`);
            const box = blocked.getByLabel('Your answer');
            const rowsBefore = await box.getAttribute('rows');
            await box.focus();
            const rowsOpen = await box.getAttribute('rows');
            check('the answer box is one line until you are in it, then has room to write', rowsBefore === '1' && rowsOpen === '3', `${rowsBefore} → ${rowsOpen}`);
            await box.fill('Use the read-only account for now.');
            await blocked.getByRole('button', { name: 'Send', exact: true }).click();
            await blocked.waitFor({ state: 'detached', timeout: 20000 });
            const said = (await page.locator('[data-decisions-said]').textContent()) ?? '';
            check('Send answers it: the card leaves, and the page says what the answer did', /^Your answer (reached “Staging check”\.|to “Staging check” waits in its queue\.)/.test(said), said);
            await entryFor(cards.staging.id, 'answer', 'delivered');
            check('the session reads the answer into a turn', await readIntoTurn(ids.staging, '[Decisions] The person answered your BLOCKED line (“The staging database refuses my login.”):\n\nUse the read-only account for now.'));
            const reached = await waitFor(async () => {
                const text = (await page.locator('[data-decisions-said]').textContent()) ?? '';
                return text === 'Your answer reached “Staging check”.' ? text : null;
            }, 'the page to say the answer reached the session', 15000, 300).catch(() => page.locator('[data-decisions-said]').textContent());
            check('once the session has it, the page says so (not "waits in its queue")', reached === 'Your answer reached “Staging check”.', reached);
            // An approval that arrives while the page is open, allowed from the page.
            ids.page = await run.newSession(writeOutside('from-page.txt', 'It saves the summary.'), 'Summary writer');
            const approval = page.locator('[data-decisions-card="approval"]').first();
            await approval.waitFor({ state: 'visible', timeout: 30000 });
            check('a new approval shows on the open page by itself, with the file', /Allow this change with Full access\?/.test(await approval.innerText()) && (await approval.innerText()).includes('from-page.txt'), await approval.innerText());
            await shot(page, shots, 'approval-light', approval);
            await setDark(page, true);
            await shot(page, shots, 'approval-dark', approval);
            await setDark(page, false);
            await approval.getByRole('button', { name: 'Allow once' }).click();
            await waitFor(() => existsSync(join(outside, 'from-page.txt')), 'the file allowed from the page', 20000);
            check('Allow once on the page lets the tool run', true);
            // Dismiss and bring back, from the page.
            const branch = page.locator(`[data-decisions-id="${cards.branch.id}"]`);
            await branch.getByRole('button', { name: 'Dismiss' }).click();
            await branch.waitFor({ state: 'detached', timeout: 15000 });
            const dismissed = page.locator('[data-decisions-dismissed]');
            await dismissed.getByText('Show them').click();
            await dismissed.getByRole('button', { name: 'Bring back' }).click();
            await page.locator(`[data-decisions-id="${cards.branch.id}"]`).waitFor({ state: 'visible', timeout: 15000 });
            check('Dismiss and Bring back work from the page', true);
            const history = await page.locator('[data-decisions-history]').innerText();
            check('What happened lists the answers with whether each arrived', /Answered: Use the read-only account for now\. · You/.test(history) && /Allowed once/.test(history) && /delivered/.test(history), history.slice(0, 600));
            const ours = window.errors.filter((text) => /decisions|session-watch|suite-kit/i.test(text));
            check('no errors from the suite in the window', ours.length === 0, ours.join('\n'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-answers');
        });
        await step('its settings in Plugins: a kind switched off, and the webhook address in DSH\'s key store', async () => {
            const { page } = window;
            await page.locator('[data-decisions-header]').getByRole('button', { name: 'Settings', exact: true }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-decisions"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            const labels = await form.locator('label').allTextContents();
            check('the header\'s Settings opens Decisions\' settings in Plugins, in DSH\'s own form', labels.some((text) => text.startsWith('Webhook address')) && labels.includes('Keep a reply\'s question for, in hours') && (await form.getByRole('switch', { name: 'Replies that end with a question' }).count()) === 1, labels.join(' | '));
            await shot(page, shots, 'settings-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-dark');
            await setDark(page, false);
            // Replies switched off: the plain question leaves the list at once.
            await form.getByRole('switch', { name: 'Replies that end with a question' }).click();
            await form.getByRole('button', { name: 'Save' }).click();
            await waitFor(async () => (await state()).sources.replies === false, 'replies switched off', 15000, 300);
            const s = await state();
            check('switched off and saved: a plain question leaves the list at once, and the log says what changed',
                !s.waiting.some((c) => c.id === cards.branch.id) && s.history.some((e) => e.kind === 'settings' && e.text === 'Settings changed: “Replies that end with a question”'), json(s.history.slice(0, 2)));
            // The webhook: an address that cannot work is refused where it is typed; a good one goes to DSH's key store.
            await form.getByRole('tab', { name: 'Webhook', exact: true }).click();
            const secret = page.locator('[data-suite-setting="webhookAddress"]');
            check('the address field says none is set yet', (await secret.getAttribute('data-suite-secret')) === 'unset' && /No address yet/.test(await secret.innerText()), await secret.innerText());
            const field = page.getByLabel('Webhook address');
            await field.fill('http://hooks.example.com/x');
            const refused = await secret.innerText();
            check('an address that cannot work is refused where it is typed, in words', /The address must start with https:\/\/ \(http:\/\/ only to this machine\)\./.test(refused), refused);
            await field.fill(hookUrl);
            await form.getByRole('button', { name: 'Save' }).click();
            await waitFor(async () => (await page.locator('[data-suite-setting="webhookAddress"]').getAttribute('data-suite-secret')) === 'set', 'the address to be stored', 15000, 300);
            const credentials = readFileSync(join(run.home, '.credentials.yaml'), 'utf8');
            const profile = readFileSync(join(run.home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
            check('the address is stored in DSH\'s key store under its key, and never in the profile', credentials.includes('DECISIONS_WEBHOOK_URL') && credentials.includes(TOKEN) && !profile.includes(TOKEN) && (await state()).mirror.mode === 'webhook', profile.slice(-300));
            check('the field says an address is set, and shows none of it', /An address is set/.test(await secret.innerText()) && (await field.inputValue()) === '' && !(await page.content()).includes(TOKEN), await secret.innerText());
            const setLine = await waitFor(async () => (await state()).history.find((e) => e.kind === 'settings' && e.text === 'Webhook address set'), 'What happened to note the address', 15000, 300).catch(() => undefined);
            check('What happened notes the address was set, naming its key and never the address', Boolean(setLine) && setLine.why === 'Kept in DSH\'s key store under DECISIONS_WEBHOOK_URL, never in the settings file.' && !json(setLine).includes(TOKEN), json(setLine));
            await shot(page, shots, 'settings-webhook-light');
            // Back on Decisions' page: where new cards go, and a test.
            await openPage(page);
            const mirror = page.locator('[data-decisions-mirror]');
            await mirror.waitFor({ state: 'visible', timeout: 20000 });
            check('the page says where new cards also go, by host only', new RegExp(`New cards also go to the webhook at ${pattern(hookHost)}: 0 of 30 this hour\\.`).test(await mirror.innerText()), await mirror.innerText());
            await mirror.getByRole('button', { name: 'Send a test' }).click();
            await waitFor(() => sink.got.length >= 1, 'the test message at the stand-in webhook', 15000, 200);
            const test = sink.got[0];
            check('Send a test reaches the webhook, with mentions off', test.method === 'POST' && /^Decisions can reach you here\./.test(test.body?.content ?? '') && json(test.body?.allowed_mentions) === json({ parse: [] }), json(test.body));
            // The stand-in webhook has the message before DSH's answer reaches the page.
            const said = page.locator('[data-decisions-test-said]');
            await waitFor(async () => /\S/.test(await said.innerText()), 'the page to say how the test went', 15000, 200).catch(() => {});
            const testSaid = await said.innerText();
            check('the page says the test went, by host', testSaid === `Test message sent to ${hookHost}.`, testSaid || '(nothing yet)');
            await shot(page, shots, 'mirror-light', page.locator('[data-decisions-header]'));
            // A new card goes out too.
            ids.hooked = await run.newSession('E2E:say DECISION NEEDED: Rotate the keys tonight? — recommend: Rotate them tonight', 'Key rotation');
            cards.hooked = await waitCard(ids.hooked, 'decision');
            await waitFor(() => sink.got.length >= 2, 'the new card at the stand-in webhook', 20000, 200);
            const note = sink.got[1].body?.content ?? '';
            check('a new card goes to the webhook: what, the question, the recommendation, and where to answer', note === '“Key rotation” needs a decision\nRotate the keys tonight?\nRecommended: Rotate them tonight\nAnswer it in DSH: Decisions.', note);
            const sent = await entryFor(cards.hooked.id, 'mirror', 'sent');
            check('the log says it was sent, naming the host only', sent.text === `Sent to ${hookHost}`, json(sent));
            // A webhook that fails is said as a failure.
            sink.answer(500);
            ids.failing = await run.newSession('E2E:say DECISION NEEDED: Merge the hotfix? — recommend: Merge it', 'Hotfix');
            cards.failing = await waitCard(ids.failing, 'decision');
            const failed = await entryFor(cards.failing.id, 'mirror', 'not sent');
            check('a webhook that fails is logged as not sent, with the host\'s answer', failed.reason === `${hookHost} answered 500`, json(failed));
            const failedLine = page.locator('[data-decisions-mirror-failed]');
            await failedLine.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
            const failedText = (await failedLine.count()) ? await failedLine.innerText() : '';
            check('the page says the last new card was not sent, why and when; the older test line is gone', new RegExp(`^The last new card was not sent: ${pattern(hookHost)} answered 500 \\(.+\\)\\.$`).test(failedText)
                && ((await page.locator('[data-decisions-test-said]').textContent()) ?? '') === '', failedText);
            await shot(page, shots, 'mirror-failed-light', page.locator('[data-decisions-header]'));
            // A test that fails is said under its button, inside the header; the focus stays on the button.
            const testButton = mirror.getByRole('button', { name: 'Send a test' });
            await testButton.focus();
            await testButton.press('Enter');
            await waitFor(async () => (await said.getAttribute('data-decisions-test-said')) === 'failed', 'the failed test to be said', 15000, 200).catch(() => {});
            const failedTest = {
                text: await said.innerText(),
                role: await said.getAttribute('role'),
                inHeader: await page.locator('[data-decisions-header] [data-decisions-test-said="failed"]').count(),
                pageLine: await page.locator('[data-decisions-failure]').count(),
                focused: await testButton.evaluate((el) => el === el.ownerDocument.activeElement),
            };
            check('a failed test is said under its button inside the header, as an alert, and the focus stays on the button',
                failedTest.text === `Not sent: ${hookHost} answered 500.` && failedTest.role === 'alert' && failedTest.inHeader === 1 && failedTest.pageLine === 0 && failedTest.focused, json(failedTest));
            await shot(page, shots, 'mirror-test-failed-light', page.locator('[data-decisions-header]'));
            sink.answer(204);
            check('the webhook\'s secret part is in no log, no file of Decisions\', and not the profile', tokenFound().length === 0, tokenFound().join(', '));
            // The address removed again, from the form.
            await page.locator('[data-decisions-header]').getByRole('button', { name: 'Settings', exact: true }).click();
            await page.locator('[data-suite-setting="webhookAddress"]').waitFor({ state: 'visible', timeout: 20000 });
            await page.locator('[data-suite-setting="webhookAddress"]').getByRole('button', { name: 'Remove the address' }).click();
            await waitFor(async () => (await page.locator('[data-suite-setting="webhookAddress"]').getAttribute('data-suite-secret')) === 'unset', 'the address to be removed', 15000, 300);
            const removedLine = await waitFor(async () => (await state()).history.find((e) => e.kind === 'settings' && e.text === 'Webhook address removed'), 'What happened to note the removal', 15000, 300).catch(() => undefined);
            check('What happened notes the address was removed', Boolean(removedLine), json((await state()).history.slice(0, 3)));
            await openPage(page);
            const missing = page.locator('[data-decisions-mirror="problem"]');
            await missing.waitFor({ state: 'visible', timeout: 20000 });
            check('with the address removed, the page says what is missing, with the way to the settings', /New cards cannot go elsewhere: No webhook address is set yet: add it in Decisions' settings in Plugins\./.test(await missing.innerText())
                && (await missing.getByRole('button', { name: 'Open Decisions\' settings' }).count()) === 1, await missing.innerText());
            await shot(page, shots, 'mirror-missing-light', page.locator('[data-decisions-header]'));
            const ours = window.errors.filter((text) => /decisions|session-watch|suite-kit/i.test(text));
            check('no errors from the suite in the window', ours.length === 0, ours.join('\n'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-settings');
        });
        await step('Decisions switched off and on in Plugins beside the coordinator: each keeps its own style sheet', async () => {
            const { page } = window;
            // The coordinator's sheet that nests threads under their chat in the sidebar.
            const nest = () => page.locator('style[data-projects-nest]').count();
            await waitFor(async () => (await nest()) >= 1, 'the coordinator\'s sidebar sheet', 15000, 300).catch(() => {});
            const before = await nest();
            const off = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-decisions', enabled: false });
            await waitFor(async () => !(await api('state')).ok, 'Decisions to stop', 30000, 300);
            await page.waitForTimeout(1500);
            const whileOff = await nest();
            const on = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-decisions', enabled: true });
            await waitFor(async () => (await api('state')).ok, 'Decisions to run again', 30000, 300);
            await openPage(page, 20000);
            await page.locator('[data-decisions-page]').waitFor({ state: 'visible', timeout: 20000 });
            // The header is drawn once the page has read Decisions' state again (it first says it is reading).
            await page.locator('[data-decisions-header]').waitFor({ state: 'visible', timeout: 20000 });
            await page.waitForTimeout(500);
            const look = await page.evaluate(() => ({
                sr: getComputedStyle(document.querySelector('[data-decisions-page] .dshdc-sr') ?? document.body).position,
                glass: getComputedStyle(document.querySelector('[data-decisions-header]')).backgroundColor,
                own: document.querySelectorAll('style[data-plugin-css="dsh-plugin-decisions/client.css"]').length,
                nest: document.querySelectorAll('style[data-projects-nest]').length,
                nestOwner: [...document.querySelectorAll('style[data-projects-nest]')].map((el) => el.getAttribute('data-plugin')),
            }));
            check('switched off and on from Plugins (as its page does)', off.ok && on.ok, json([off, on]).slice(0, 300));
            check('the coordinator\'s sidebar sheet is its own and stays through it', before >= 1 && whileOff >= 1 && look.nest >= 1 && look.nestOwner.every((who) => who === 'dsh-plugin-coordinator'), json({ before, whileOff, look }));
            check('Decisions\' page is styled again: one sheet of its own, hidden words hidden, glass behind the header', look.own === 1 && look.sr === 'absolute' && !/rgba\(0, 0, 0, 0\)/.test(look.glass), json(look));
            await shot(page, shots, 'after-off-on-light');
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-off-on');
        });
        await window?.browser?.close().catch(() => {});
        window = undefined;
    }

    // ── A restart ──────────────────────────────────────────────────────
    // A tool waits on an approval Decisions holds when DSH quits: after the restart, the log says what became of it.
    ids.cutOff = await run.newSession(writeOutside('cut-off.txt', 'It writes the notes before DSH quits.'), 'Cut off by a restart');
    const held = await waitCard(ids.cutOff, 'approval');
    // The list shows a held request at once; its "new" line follows on the next look: count once it is there.
    await entryFor(held.id, 'new', undefined, 15000);
    const before = await state();
    const newBefore = before.history.filter((e) => e.kind === 'new').length;
    await restart('a restart');
    await waitFor(async () => (await api('state')).ok, 'Decisions\' endpoints after the restart', 30000);
    await step('a restart repeats nothing and keeps what still waits', async () => {
        await sleep(3000);
        const after = await state();
        const waitingBefore = before.waiting.filter((c) => c.id !== held.id).map((c) => c.id).sort().join();
        const waitingAfter = after.waiting.map((c) => c.id).sort().join();
        check('what waited before the restart still waits; nothing answered comes back', waitingBefore === waitingAfter, `${waitingBefore} | ${waitingAfter}`);
        const stopped = await entryFor(held.id, 'elsewhere', 'stopped');
        check('the approval the restart cut off is gone, and the log says the turn stopped before anyone answered',
            !after.waiting.some((c) => c.id === held.id) && stopped.text === 'The turn stopped before anyone answered' && stopped.sessionId === ids.cutOff && !existsSync(join(outside, 'cut-off.txt')), json(stopped));
        const seenBefore = new Set(before.history.filter((e) => e.kind === 'new').map((e) => `${e.cardId}@${e.at}`));
        check('nothing is announced again', after.history.filter((e) => e.kind === 'new').length === newBefore,
            `${after.history.filter((e) => e.kind === 'new').length} vs ${newBefore}: ${json(after.history.filter((e) => e.kind === 'new' && !seenBefore.has(`${e.cardId}@${e.at}`)))}`);
        check('the settings saved in Plugins survive: replies stay off', after.sources.replies === false, json(after.sources));
        // Its session is not loaded after the restart, and its saved state leaves the reply out: read from its log.
        const report = await waitFor(async () => (await state()).waiting.find((c) => c.id === cards.report.id && c.context), 'the report card\'s lines after the restart', 20000, 300).catch(() => undefined);
        check('a card keeps what it shows through a restart: its lines, its question and its pick, without opening its session',
            report?.context === cards.report.context && report.question === cards.report.question && report.recommendation === cards.report.recommendation && !report.reading, json(report));
    });

    // ── A command instead of a webhook ──────────────────────────────────
    const commandOut = join(run.root, 'mirror-command.jsonl');
    await restartWith(rowsWith({ decisions: { mirror: 'command', mirrorCommand: ['/bin/sh', '-c', 'cat >> "$1"', 'sh', commandOut] } }), 'a command mirror');
    await waitFor(async () => (await api('state')).ok, 'Decisions\' endpoints with a command', 30000);
    await step('a command instead of a webhook: each new card as JSON on its input', async () => {
        const s = await state();
        check('the page says new cards also go to the command, by its program\'s name', s.mirror.mode === 'command' && s.mirror.place === 'sh' && !s.mirror.problem, json(s.mirror));
        ids.command = await run.newSession('E2E:say DECISION NEEDED: Retry the import? — recommend: Retry it once', 'Import retry');
        cards.command = await waitCard(ids.command, 'decision');
        await entryFor(cards.command.id, 'mirror', 'sent');
        const lines = readFileSync(commandOut, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const got = lines.find((line) => line.sessionId === ids.command);
        check('the command gets the card as JSON: its text, kind, title, question and recommendation', got?.kind === 'decision' && got.title === 'Import retry' && got.question === 'Retry the import?' && got.recommendation === 'Retry it once' && /^“Import retry” needs a decision\n/.test(got.text), json(got));
    });

    // ── A wrong type in the profile ────────────────────────────────────
    await restartWith(rowsWith({ decisions: { notify: 'yes' } }), 'a wrong type');
    await waitFor(async () => (await api('state')).ok, 'Decisions\' endpoints with a wrong type', 30000);
    await step('a wrong type in the profile: Decisions starts, holds and lists nothing, and names the setting with its value', async () => {
        const s = await state();
        check('"yes" for a switch does not stop Decisions from starting: its state names the setting and the value as the profile has it',
            s.problem?.text === 'A notification for each new card (notify) must be true or false (it is "yes")' && s.problem?.live === true && s.waiting.length === 0, json(s.problem));
    });

    // ── A number in quotes (OPEN-QUESTIONS #32), fixed in the form ─────
    await restartWith(rowsWith({ decisions: { windowHours: '72' } }), 'a number in quotes');
    await waitFor(async () => (await api('state')).ok, 'Decisions\' endpoints with a number in quotes', 30000);
    await step('a number in quotes: Decisions starts and names it; the form flags it, and one Save stores the number', async () => {
        const s = await state();
        check('"72" for a number does not stop Decisions from starting: its state names the setting and the value in quotes',
            /^Keep a reply's question for \(windowHours\) must be a whole number of hours from 1 to 720 \(it is "72"\)$/.test(s.problem?.text ?? '') && s.problem?.live === true && s.waiting.length === 0, json(s.problem));
        const logged = s.history.find((e) => e.kind === 'settings' && /^Settings changed in DSH's profile: .*“Keep a reply's question for”/.test(e.text));
        check('the log says the profile changed it, and that Decisions waits for it', Boolean(logged) && logged.state === 'waiting on a setting', json(s.history.filter((e) => e.kind === 'settings').slice(0, 3)));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Decisions' });
        const { page } = window;
        await openPage(page);
        await page.locator('[data-suite-trouble="setting"]').waitFor({ state: 'visible', timeout: 20000 });
        await page.getByRole('button', { name: 'Open Decisions\' settings' }).click();
        const form = page.locator('[data-suite-settings="dsh-plugin-decisions"]');
        await form.waitFor({ state: 'visible', timeout: 20000 });
        const field = page.getByLabel('Keep a reply\'s question for, in hours');
        await sleep(500);
        const row = page.locator('[data-suite-setting="windowHours"]');
        const shown = { value: await field.inputValue(), words: await row.innerText(), focused: await field.evaluate((el) => el === el.ownerDocument.activeElement) };
        check('the form shows it in its quotes, flagged with what to type, with the cursor in it',
            shown.value === '"72"' && /It is saved as text, in quotes\. Type a whole number from 1 to 720, without the quotes, then save\./.test(shown.words) && shown.focused, json(shown));
        await shot(page, shots, 'setting-quoted-light');
        await field.fill('72');
        const save = form.getByRole('button', { name: 'Save' });
        check('the number typed without its quotes is a change Save takes', !(await save.isDisabled()));
        await save.click();
        const fixed = await waitFor(async () => {
            const r = await api('state');
            return r.ok && !r.value.problem ? r.value : null;
        }, 'the number in quotes to be fixed', 20000).catch(() => undefined);
        const entry = fixed?.history.find((e) => e.kind === 'settings');
        const profile = readFileSync(join(run.home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
        check('one Save stores the number: Settings fixed, and the profile holds 72 without quotes',
            entry?.text === 'Settings fixed: Decisions is working again' && /\n\s+windowHours: 72\n/.test(profile) && !/windowHours: "72"/.test(profile), json({ entry, line: profile.split('\n').find((l) => /windowHours/.test(l)) }));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-quoted');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── A wrong setting, fixed in Plugins ──────────────────────────────
    await restartWith(rowsWith({ decisions: { windowHours: 0 } }), 'a wrong setting');
    await waitFor(async () => (await api('state')).ok, 'Decisions\' endpoints with a wrong setting', 30000);
    await step('a wrong setting: Decisions starts, holds and lists nothing, and says which setting and what it must be', async () => {
        const s = await state();
        check('a wrong value does not stop Decisions from starting: its state names the setting, the range and the value',
            s.problem?.text === 'Keep a reply\'s question for (windowHours) must be a whole number of hours from 1 to 720 (it is 0)' && s.problem?.live === true && s.waiting.length === 0, json(s.problem));
        const refused = await api('dismiss', { id: cards.release.id });
        check('its actions say why they cannot go', refused.ok === false && /waiting for a setting to be fixed/.test(refused.error?.message ?? ''), json(refused));
        ids.unheld = await run.newSession(writeOutside('unheld.txt', 'It writes while a setting is wrong.'), 'While wrong');
        const prompt = await waitFor(() => prompts.find('approval/request', escalation('It writes while a setting is wrong.')), 'the window\'s prompt while a setting is wrong', 30000, 200);
        await sleep(1000);
        check('while a setting is wrong, approvals go to DSH\'s own prompt alone', Boolean(prompt) && (await state()).waiting.length === 0 && (await api('badge')).value?.off === true);
        await prompts.answer(prompt, 'rejected');
        await idle(ids.unheld);
    });
    if (pw) {
        await step('a wrong setting, in the window: the page says what to change, and saving a good value fixes it', async () => {
            window = await openWindow(run, pw, { entry: 'Decisions' });
            const { page } = window;
            await openPage(page);
            const problem = page.locator('[data-suite-trouble="setting"]');
            await problem.waitFor({ state: 'visible', timeout: 20000 });
            const words = (await problem.innerText()).replace(/\n+/g, ' ');
            check('the page says which setting is wrong, what it must be, and where to change it',
                /^Decisions is waiting for a setting to be fixed\. Keep a reply's question for \(windowHours\) must be a whole number of hours from 1 to 720 \(it is 0\)\. Change it in Decisions' settings in Plugins\. Decisions starts working again as soon as you save\./.test(words), words);
            await shot(page, shots, 'setting-light');
            await setDark(page, true);
            await shot(page, shots, 'setting-dark');
            await setDark(page, false);
            await page.getByRole('button', { name: 'Open Decisions\' settings' }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-decisions"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            const field = page.getByLabel('Keep a reply\'s question for, in hours');
            await field.fill('0');
            const save = form.getByRole('button', { name: 'Save' });
            const refusedWords = await page.locator('[data-suite-setting="windowHours"]').innerText();
            check('the form will not save a value out of range, and says what fits', await save.isDisabled() && /A whole number from 1 to 720, or empty for the default \(72\)\./.test(refusedWords), refusedWords);
            await field.fill('72');
            await save.click();
            const fixed = await waitFor(async () => {
                const r = await api('state');
                return r.ok && !r.value.problem ? r.value : null;
            }, 'the setting to be fixed', 20000);
            const entry = fixed.history.find((e) => e.kind === 'settings');
            check('saving a good value fixes it at once, the log says which change did, and what waits is listed again',
                entry?.text === 'Settings fixed: Decisions is working again' && /^The change to “.+” fixed it\.$/.test(entry?.why ?? '') && fixed.waiting.length > 0, json({ entry, waiting: fixed.waiting.length }));
            const ours = window.errors.filter((text) => /decisions|session-watch|suite-kit/i.test(text));
            check('no errors from the suite in the window', ours.length === 0, ours.join('\n'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-setting');
        });
        await window?.browser?.close().catch(() => {});
        window = undefined;
    }

    // ── A number in quotes in Session Watch's row, fixed from Decisions' page ──
    await restartWith(rowsWith({ watch: { deliveryTimeoutSeconds: '600' } }), 'Session Watch with a number in quotes');
    await waitFor(async () => (await api('state')).ok, 'Decisions\' endpoints with Session Watch\'s number in quotes', 30000);
    await step('Session Watch with a number in quotes: Decisions works on, its header names it, and its button leads to the field', async () => {
        const s = await state();
        check('Session Watch works on with its default: Decisions lists what waits, and its state names Session Watch\'s setting and the value in quotes',
            !s.problem && s.waiting.length > 0 && /^How long a message may wait to be read \(deliveryTimeoutSeconds\) must be a whole number of seconds from 10 to 86400 \(it is "600"\)$/.test(s.watchProblem?.text ?? '') && s.watchProblem?.key === 'deliveryTimeoutSeconds',
            json({ problem: s.problem, watchProblem: s.watchProblem, waiting: s.waiting.length }));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Decisions' });
        const { page } = window;
        await openPage(page);
        const note = page.locator('[data-decisions-header] [data-decisions-watch-problem]');
        await note.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await note.innerText()).replace(/\n+/g, ' ');
        check('the header says Session Watch uses its default, which setting is wrong, and where to change it',
            /^Session Watch uses its default for a wrong setting: How long a message may wait to be read \(deliveryTimeoutSeconds\) must be a whole number of seconds from 10 to 86400 \(it is "600"\)\. Change it in Session Watch's settings in Plugins\./.test(words), words);
        await shot(page, shots, 'watch-setting-light');
        await note.getByRole('button', { name: 'Open Session Watch\'s settings' }).click();
        const form = page.locator('[data-suite-settings="dsh-plugin-session-watch"]');
        await form.waitFor({ state: 'visible', timeout: 20000 });
        const field = page.getByLabel('How long a message may wait to be read, in seconds');
        await sleep(500);
        const row = page.locator('[data-suite-setting="deliveryTimeoutSeconds"]');
        const shown = { value: await field.inputValue(), words: await row.innerText(), focused: await field.evaluate((el) => el === el.ownerDocument.activeElement) };
        check('Session Watch\'s form shows it in its quotes, flagged with what to type, with the cursor in it',
            shown.value === '"600"' && /It is saved as text, in quotes\. Type a whole number from 10 to 86400, without the quotes, then save\./.test(shown.words) && shown.focused, json(shown));
        await shot(page, shots, 'watch-setting-form-light');
        await field.fill('600');
        await form.getByRole('button', { name: 'Save' }).click();
        const fixed = await waitFor(async () => {
            const r = await api('state');
            return r.ok && !r.value.watchProblem ? r.value : null;
        }, 'Session Watch\'s number in quotes to be fixed', 20000).catch(() => undefined);
        const profile = readFileSync(join(run.home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
        check('one Save fixes it: Decisions no longer names it, and the profile holds 600 without quotes',
            Boolean(fixed) && /\n\s+deliveryTimeoutSeconds: 600\n/.test(profile) && !/deliveryTimeoutSeconds: "600"/.test(profile), json({ watchProblem: fixed?.watchProblem, line: profile.split('\n').find((l) => /deliveryTimeoutSeconds/.test(l)) }));
        const ours = window.errors.filter((text) => /decisions|session-watch|suite-kit/i.test(text));
        check('no errors from the suite in the window', ours.length === 0, ours.join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-watch-setting');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── Files ──────────────────────────────────────────────────────────
    await step('a private folder and files', async () => {
        const dir = join(run.home, 'decisions');
        const files = ['state.json', 'events.jsonl'].map((f) => join(dir, f));
        const modes = [dir, ...files].map((p) => `${p.slice(run.home.length + 1)} ${modeOf(p).toString(8)}`);
        check('Decisions\' folder is 700 and its files 600', modeOf(dir) === 0o700 && files.every((f) => modeOf(f) === 0o600), modes.join(', '));
    });

    // ── Session Watch off ──────────────────────────────────────────────
    await step('Session Watch switched off in Plugins and on again: DSH reports no failure, and Decisions comes back by itself', async () => {
        // DSH's own call, as its Plugins page makes it: its result is what the page shows ("Could not disable: …" on a failure).
        const off = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-watch', enabled: false });
        check('switched off, DSH reports it applied, with no failure', off.ok === true && off.value?.application === 'applied' && !off.value?.error, json(off));
        await waitFor(async () => (await api('state')).ok === false, 'Decisions to stop with Session Watch', 20000, 300);
        const on = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-session-watch', enabled: true });
        check('switched on again, DSH reports it applied, with no failure', on.ok === true && on.value?.application === 'applied' && !on.value?.error, json(on));
        await waitFor(async () => (await api('state')).ok, 'Decisions to come back with Session Watch', 30000, 300);
        check('Decisions works again by itself', (await state()).enabled === true);
    });
    await restartWith(rowsWith({ off: ['session-watch'] }), 'Session Watch off');
    await step('Session Watch off in the profile: Decisions loads but does nothing, approvals go to DSH\'s own prompt alone, and its page says what it needs', async () => {
        const r = await api('state');
        check('without Session Watch, Decisions does nothing: its endpoints are not there', r.ok === false, json(r));
        const said = run.logText().split('\n').filter((line) => /did not activate (decisions|autopilot)/.test(line));
        check('DSH reports nothing waiting: Decisions and Autopilot themselves are loaded', said.length === 0, said.slice(-3).join('\n'));
        ids.watchOff = await run.newSession(writeOutside('watch-off.txt', 'It writes while Session Watch is off.'), 'Watch off');
        const prompt = await waitFor(() => prompts.find('approval/request', escalation('It writes while Session Watch is off.')), 'the window\'s prompt while Session Watch is off', 30000, 200);
        check('while Session Watch is off, approvals go to DSH\'s own prompt alone', Boolean(prompt));
        await prompts.answer(prompt, 'rejected');
        await idle(ids.watchOff);
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Decisions' });
        const { page } = window;
        await openPage(page);
        const trouble = page.locator('[data-suite-trouble="watch-off"]');
        await trouble.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await trouble.innerText()).replace(/\n+/g, ' ');
        check('the page says Decisions needs Session Watch, and what to do, with no HTTP status',
            /^Decisions needs Session Watch, which is not running\. Switch Session Watch on in Plugins\. This page comes back by itself once it runs\./.test(words) && !/404|HTTP|transport/.test(words), words);
        await shot(page, shots, 'watch-off-light');
        await setDark(page, true);
        await shot(page, shots, 'watch-off-dark');
        await setDark(page, false);
        // Once the page says so, the window asks nothing that is not there: DSH's plugin list says when Session Watch runs again.
        const missing = [];
        let listed = 0;
        const onResponse = (response) => {
            const path = new URL(response.url()).pathname;
            if (response.status() >= 400 && /dsh-plugin-(decisions|session-watch)\//.test(path)) missing.push(`${response.status()} ${path}`);
            if (/pluginManager\/listPlugins/.test(`${path} ${response.request().postData() ?? ''}`)) listed += 1;
        };
        page.on('response', onResponse);
        await sleep(12000);
        page.off('response', onResponse);
        check('while Session Watch is off, the page asks no endpoint that is not there, only DSH\'s plugin list (12 s with the page open)', missing.length === 0 && listed > 0, json({ missing, listed }));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-watch-off');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── enabled: false ─────────────────────────────────────────────────
    await restartWith(rowsWith({ decisions: { enabled: false } }), 'enabled: false');
    await waitFor(async () => (await api('state')).ok, 'Decisions\' endpoints with enabled: false', 30000);
    await step('enabled: false: Decisions lists and holds nothing, and its page says so and how to change it', async () => {
        const s = await state();
        check('with enabled: false Decisions is loaded but idle', s.enabled === false && !s.problem && s.waiting.length === 0, json({ enabled: s.enabled, problem: s.problem }));
        const refused = await api('dismiss', { id: cards.release.id });
        check('its actions say it is switched off, and where to answer instead', refused.ok === false && /switched off in DSH's profile \(enabled: false\)/.test(refused.error?.message ?? ''), json(refused));
        const offLine = s.history.find((e) => e.kind === 'settings');
        check('its log says it was switched off, never that it started again', /^Switched off in DSH's profile \(enabled: false\)/.test(offLine?.text ?? '') && offLine.why === 'Decisions lists and holds nothing until enabled is true again; DSH\'s own cards work as always.' && offLine.state === 'paused', json(offLine));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Decisions' });
        const { page } = window;
        await openPage(page);
        const header = page.locator('[data-decisions-header="off"]');
        await header.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await header.innerText()).replace(/\n+/g, ' ');
        check('the page says it lists nothing, and how to change that', /Decisions is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\), so it lists nothing and holds nothing\. To use it, set enabled to true there; DSH applies it when you save the file\./.test(words), words);
        const newest = (await page.locator('[data-decisions-history] [data-decisions-entry]').first().innerText()).replace(/\n+/g, ' ');
        check('What happened on the page says so too, in its newest row', /Switched off in DSH's profile \(enabled: false\)/.test(newest) && /paused/.test(newest) && !/started again/.test(newest), newest);
        await shot(page, shots, 'disabled-light');
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-disabled');
    });
    // ── The profile edited while DSH runs ──────────────────────────────
    await step('enabled set back to true in the profile while DSH runs: DSH applies the file, Decisions works again, and its log says what changed', async () => {
        const pid = run.child?.pid;
        const file = join(run.home, 'profiles', 'web', 'cordis.patch.yml');
        const text = readFileSync(file, 'utf8');
        check('the profile has Decisions switched off', /\n    enabled: false\n/.test(text));
        writeFileSync(file, text.replace(/\n    enabled: false\n/, '\n    enabled: true\n'));
        const back = await waitFor(async () => {
            const r = await api('state');
            return r.ok && r.value.enabled === true ? r.value : null;
        }, 'Decisions to start again with the saved file', 45000, 500).catch(() => undefined);
        const line = back?.history.find((e) => e.kind === 'settings');
        check('DSH applies the saved file without a restart: Decisions works again', Boolean(back) && run.child?.pid === pid && back.waiting.length > 0, json({ enabled: back?.enabled, waiting: back?.waiting.length }));
        check('its log says it was switched on again', line?.text === 'Switched on again in DSH\'s profile (enabled: true)' && line.why === 'Decisions lists and holds again.' && line.state === 'done', json(line));
        if (window?.page) {
            const { page } = window;
            await page.locator('[data-decisions-header="on"]').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
            await shot(page, shots, 'profile-edited-light');
        }
    });
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
    if (window?.page) await shot(window.page, shots, 'failed').catch(() => {});
} finally {
    await window?.browser?.close().catch(() => {});
    prompts?.close();
    model.release();
    await run.stop();
    await model.close();
    await sink.close();
    const warnings = run.logText().split('\n').filter((line) => /decisions|session-watch/i.test(line) && /warn|error|fail/i.test(line));
    if (warnings.length) console.log(`# DSH said about the suite:\n${warnings.slice(-20).map((l) => `#   ${l.replaceAll(TOKEN, '<token>')}`).join('\n')}`);
    run.cleanup();
}
console.log(`\n# DSH ${version}: ${tally.passed} passed, ${tally.failed} failed${pw ? '' : ', window checks skipped (no Playwright)'}`);
process.exit(tally.failed ? 1 : 0);
