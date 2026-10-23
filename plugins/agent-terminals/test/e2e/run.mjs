#!/usr/bin/env node
/**
 * Agent Terminals in a real DSH: command-line coding agents (a stand-in
 * that keeps transcripts the way the two common kinds of CLI do) started in
 * DSH's own terminals, typed to and proven from their transcripts, shown on
 * the session's row, in a terminal tab beside the session and in Decisions,
 * and started again after DSH restarts.
 *
 * DSH runs from a throwaway DSH_HOME (test/e2e/harness.mjs) with the session
 * bridge, Session Watch, Decisions, Agent Terminals and a stand-in neighbour
 * plugin (test/e2e/neighbour) that draws in the same places, and a scripted
 * model (test/e2e/fake-model.mjs) for the sessions' own turns. DSH's HOME is
 * a throwaway folder too: its shell reads no startup file of yours, and the
 * stand-in agents (test/e2e/fake-agent.mjs, behind small programs named
 * standin, standin-events and standin-plain on DSH's PATH) keep their
 * conversations under it, as a CLI keeps them under ~/.<name>.
 *
 * - The browser half is served and parses; the endpoints answer, find the
 *   stand-ins by the conversations they keep, and refuse bad input in words.
 * - An agent starts in a new session of its folder: DSH lists the session
 *   (one turn by its model), names it after the agent, and opens a terminal
 *   there that runs the program with `exec` and a conversation id of its
 *   own; its first message is typed in and proven from its transcript.
 * - One message at a time: while the agent works the next one waits (and
 *   can be taken back); several lines go in as one paste.
 * - A program that swallows the Enter after a paste: Enter is pressed again
 *   and the proof says so.
 * - A reply that asks: waiting on you, on the session's row and in
 *   Decisions; answered there (the recommendation, and own words), the
 *   answer is typed in and proven, and Decisions says "reached" only then.
 * - A program with no transcript runs and is typed to, and says it cannot
 *   prove; a program that is not there says how to fix it, is never logged
 *   as started and gives its session no turn; a path that is not a program
 *   is refused before anything is made.
 * - The window: the Coding agents page (counts, agents, messages, the start
 *   form with the programs found here), light and dark and narrow; the
 *   session row's mark, hover line and menu item beside the neighbour's; a
 *   terminal tab beside the session that shows the agent's screen.
 * - A tool call waiting in the terminal: waiting on you on the page, the
 *   badge and in Decisions, the next message held, answered in the
 *   terminal tab: the tool runs and the held message goes in.
 * - Starting from the page with a program found here (events style: its
 *   id read from the file it makes); Stop, Start again (it resumes), Start
 *   anew and Forget from the page.
 * - Closing an agent's terminal tab ends it; Start again brings it back in a
 *   new tab.
 * - Its settings in Plugins (DSH's own form): typing while the agent works,
 *   switched on, applies at once; a message typed while it works is never
 *   followed by an Enter into an approval prompt that opens before it is read.
 * - "Start a coding agent here" from a session's menu starts one in that
 *   session.
 * - A wrong setting saved while DSH runs: the agents keep running, read
 *   "running, not followed" with no buttons that would act, and are picked
 *   up where they are once it is fixed.
 * - A DSH restart in the middle of a job and of an approval prompt: the
 *   agents come back idle (the job said cut off), the messages held for
 *   them go in once and are proven, and no question is left in Decisions.
 * - A DSH restart: every running agent starts again under the same terminal
 *   id and resumes its conversation; a program that cannot resume is not
 *   started again, and says why; the window's tab shows the resumed agent.
 * - Typing through DSH's terminal input (`typing: attached`): on DSH 0.2.0
 *   a message goes in and the tab gets its keyboard back; on later builds,
 *   which have no such input for plugins, it says what to set.
 * - A wrong setting: no agent runs, each says why, and the page says which
 *   setting; saving a good one in Plugins brings the agents back.
 * - Session Watch off in the profile, and `enabled: false`: loaded, idle,
 *   and the page says what to do.
 * - Its folder is 700 and its files 600.
 *
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node plugins/agent-terminals/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/; `node scripts/e2e.mjs
 * agent-terminals` runs it on each of those and on the installed app's own
 * DSH. SHOTS=<folder> keeps the window's pictures there (default
 * .e2e/shots/agent-terminals/<version>); KEEP=1 keeps the throwaway homes.
 * Without Playwright the run fails, unless NO_WINDOW=1 says to run without
 * the window checks.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { DshRun, checks, dshBin, findPlaywright, freePort, modeOf, openWindow, pluginsDir, repoRoot, setDark, shot, waitFor } from '../../../../test/e2e/harness.mjs';
import { startFakeModel } from '../../../../test/e2e/fake-model.mjs';

const bin = dshBin();
if (!bin) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
/** DSH 0.2.0 gives plugins its terminal input (`follow` and `write`); later builds do not. */
const hasTerminalInput = /(^|-)0\.2\.0/.test(version);
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'agent-terminals', version);
console.log(`# DSH ${version}: ${bin}`);
console.log(`# pictures: ${shots}`);

const tally = checks();
const { check, step } = tally;
const model = await startFakeModel();
const json = (value) => JSON.stringify(value);
const pattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Text without its spaces and line breaks: a terminal wraps a long line where its width ends. */
const flat = (text) => String(text).replace(/\s+/g, '');
const shows = (text, want) => flat(text).includes(flat(want));

/** The profile's rows: new sessions on Workspace Write, the suite's plugins, Agent Terminals' settings (quick ones for a test). */
const rowsWith = ({ off = [], at = {} } = {}) => `- id: permission
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
- id: decisions
  config:
    windowHours: 72
- id: agent-terminals
  config:
${Object.entries({ proofSeconds: 2, askAfterSeconds: 5, ...at }).map(([key, value]) => `    ${key}: ${json(value)}`).join('\n')}
`;

const run = new DshRun({
    label: 'agent-terminals',
    bin,
    // The window keeps its address across restarts, so a reload finds the tabs it saved.
    port: await freePort(),
    plugins: {
        'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge'),
        'dsh-plugin-session-watch': join(pluginsDir, 'session-watch'),
        'dsh-plugin-decisions': join(pluginsDir, 'decisions'),
        'dsh-plugin-agent-terminals': join(pluginsDir, 'agent-terminals'),
        // A neighbour with a mark, a menu item, a panel entry and a footer button: Agent Terminals must leave them be.
        'dsh-plugin-neighbour': join(repoRoot, 'test', 'e2e', 'neighbour'),
    },
});
run.rows = rowsWith();

// ── The computer the agents run on: a home folder, the stand-ins, the projects ──

const user = join(run.root, 'user');
const binDir = join(run.root, 'bin');
mkdirSync(binDir, { recursive: true });
mkdirSync(user, { recursive: true });
// The shell in an agent's terminal reads these, not yours: a plain prompt, and no first-run setup.
writeFileSync(join(user, '.zshrc'), 'PROMPT=\'$ \'\n');
writeFileSync(join(user, '.bashrc'), 'PS1=\'$ \'\n');
/** A Node that runs the stand-in: this one, unless it is an app's own binary acting as Node. */
function nodeForAgents() {
    if (!process.versions.electron) return process.execPath;
    for (const dir of String(process.env.PATH ?? '').split(delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin'])) {
        try {
            accessSync(join(dir, 'node'), constants.X_OK);
            return join(dir, 'node');
        } catch {}
    }
    return 'node';
}
const fakeAgent = join(repoRoot, 'test', 'e2e', 'fake-agent.mjs');
const quoted = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
/** A program named like an installed CLI: the stand-in in a style, keeping its conversations in ~/.<name>. */
function standIn(name, style) {
    const file = join(binDir, name);
    const data = style === 'plain' ? '' : `STAND_IN_DATA=${quoted(join(user, `.${name}`))} `;
    // --run-tag marks the processes this run started (the stand-in ignores it), so the end of the run can find them.
    writeFileSync(file, `#!/bin/sh\nSTAND_IN_STYLE=${style} ${data}exec ${quoted(nodeForAgents())} ${quoted(fakeAgent)} --run-tag ${quoted(run.root)} "$@"\n`);
    chmodSync(file, 0o755);
    return file;
}
const programs = { flags: standIn('standin', 'flags'), events: standIn('standin-events', 'subcommand'), plain: standIn('standin-plain', 'plain') };
// Conversations each kept before: how Agent Terminals finds a CLI on this computer (never by its name).
const long = Date.now() - 3 * 86400000;
const seed = (file, line) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${json(line)}\n`);
    utimesSync(file, new Date(long), new Date(long));
};
seed(join(user, '.standin', 'projects', '-old-project', '0f0e0d0c-0000-4000-8000-000000000001.jsonl'), { type: 'user', message: { role: 'user', content: 'An old conversation' }, timestamp: new Date(long).toISOString() });
seed(join(user, '.standin-events', 'sessions', '2026', '10', '14', 'rollout-2026-10-14T09-00-00-000Z-0f0e0d0c-0000-4000-8000-000000000002.jsonl'), { type: 'session_meta', payload: { id: '0f0e0d0c-0000-4000-8000-000000000002', cwd: '/old/project' } });
run.env = { HOME: user, ZDOTDIR: user, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` };

const ws = {};
for (const name of ['app', 'swallow', 'events', 'plain', 'missing', 'long']) {
    ws[name] = join(run.root, 'projects', name);
    mkdirSync(ws[name], { recursive: true });
}
const real = (path) => {
    try { return realpathSync(path); } catch { return path; }
};

// ── Reading Agent Terminals, Decisions and the agents' own files ──

const api = (method, args = {}) => run.api(`dsh-plugin-agent-terminals/${method}`, args);
const state = async () => {
    const r = await api('state');
    if (!r.ok) throw new Error(`state: ${json(r.error)}`);
    return r.value;
};
const agentOf = async (key) => (await state()).agents.find((a) => a.key === key);
const waitAgent = (key, test, what, timeout = 30000) => waitFor(async () => {
    const agent = await agentOf(key);
    return agent && test(agent) ? agent : null;
}, what, timeout, 300);
const deliveryOf = (agent, id) => agent?.deliveries?.find((d) => d.id === id);
const waitDelivery = (key, id, states, what, timeout = 40000) => waitFor(async () => {
    const item = deliveryOf(await agentOf(key), id);
    return item && states.includes(item.state) ? item : null;
}, what, timeout, 300);
/** Send a message: the delivery it made. */
async function send(key, text) {
    const r = await api('send', { key, text });
    if (!r.ok) throw new Error(`send: ${json(r.error)}`);
    return r.value.delivery;
}
/** What the agent's terminal shows now (DSH's own screen of it); compare with `shows`, as lines wrap. */
async function screen(key) {
    const r = await api('screen', { key });
    return r.ok && Array.isArray(r.value?.lines) ? r.value.lines.join('\n') : '';
}
/** The person's messages in an agent's own transcript, in order. */
function transcriptUsers(path) {
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type === 'user' && typeof entry.message?.content === 'string') out.push(entry.message.content);
        else if (entry?.type === 'event_msg' && entry.payload?.type === 'user_message') out.push(entry.payload.message);
    }
    return out;
}
const history = async (test) => (await state()).history.filter(test);
const watchRow = async (sessionId) => {
    const r = await run.api('dsh-plugin-session-watch/sessions');
    return r.ok ? r.value.items.find((row) => row.sessionId === sessionId) : undefined;
};
const decisions = async () => {
    const r = await run.api('dsh-plugin-decisions/state');
    if (!r.ok) throw new Error(`decisions: ${json(r.error)}`);
    return r.value;
};
const askCardFor = async (sessionId) => (await decisions()).waiting.find((c) => c.kind === 'ask' && c.sessionId === sessionId);
/** Start an agent through the endpoint, as the start form does. */
async function start(input) {
    const r = await api('start', { input });
    if (!r.ok) throw new Error(`start: ${json(r.error)}`);
    return r.value;
}
const idleAgent = (key, what) => waitAgent(key, (a) => a.status === 'idle', what ?? `${key} to be idle`, 40000);

/** Start DSH again with other rows (the settings a person would have in the profile). */
async function restartWith(rows, what) {
    await run.stop();
    run.rows = rows;
    run.writeProfile(model.port);
    await run.boot(what);
}

/** The processes this run started (DSH ends its terminals as it quits; this makes sure). */
function endOurs() {
    let pids = [];
    try {
        pids = execFileSync('/usr/bin/pgrep', ['-f', run.root], { encoding: 'utf8' }).split('\n').map(Number).filter((pid) => pid > 1 && pid !== process.pid);
    } catch {}
    for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    return pids.length;
}

// ── The window ──

let window;
let pw;
const errors = [];
async function openAgents(options = {}) {
    if (!window) {
        window = await openWindow(run, pw, { entry: 'Coding agents', ...options });
        window.page.on('pageerror', (error) => errors.push(error.message));
        window.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    }
    const { page } = window;
    await page.getByRole('button', { name: 'Coding agents', exact: true }).first().click();
    await page.locator('[data-agent-terminals-page]').waitFor({ state: 'visible', timeout: 20000 });
    return page;
}
/** Sign in again after a DSH restart (a new link), on the same address: the window's saved tabs stay. */
async function signInAgain() {
    if (!window) return;
    const web = await run.signIn();
    await window.page.goto(web.link, { waitUntil: 'domcontentloaded' });
    await window.page.getByRole('button', { name: 'Coding agents', exact: true }).first().waitFor({ state: 'visible', timeout: 90000 });
}
const rowOf = (page, sessionId) => page.locator(`[data-row-key="session:${sessionId}"]`).first();
const cardOf = (page, key) => page.locator(`[data-agent-terminals-agent="${key}"]`);
/** The visible terminal's text, once it shows `want` (wrapped or not). */
async function terminalShows(page, want, timeout = 20000) {
    const rows = page.locator('.xterm-rows:visible').first();
    return waitFor(async () => {
        if (!(await rows.count())) return null;
        const text = await rows.innerText();
        return shows(text, want) ? text : null;
    }, `the terminal tab to show “${want}”`, timeout, 300);
}
const terminalTab = (page, title) => page.locator('[role="tab"]', { hasText: title });
const suiteErrors = () => errors.filter((text) => /agent-terminals|session-watch|suite-kit|dshat/i.test(text));

const ids = {};
const agents = {};
try {
    run.writeProfile(model.port);
    await run.boot('first start');
    await waitFor(async () => (await api('state')).ok, 'Agent Terminals\' endpoints', 30000);

    // ── The browser half and the endpoints ─────────────────────────────
    await step('DSH serves Agent Terminals\' browser half and it parses', async () => {
        const client = await run.clientOf('dsh-plugin-agent-terminals');
        let parses = false;
        try {
            new Script(client.text);
            parses = true;
        } catch {}
        check('DSH serves Agent Terminals\' browser half and it parses', client.status === 200 && parses && client.text.includes('dsh-plugin-agent-terminals'), `${client.url ?? 'not in the boot graph'}: ${client.status}`);
    });

    await step('the endpoints answer, find the programs this computer used, and refuse bad input in words', async () => {
        const s = await state();
        check('its state: on, with DSH\'s terminals, no agents yet, the four ways a program can resume', s.enabled === true && s.terminals === true && s.agents.length === 0
            && json(s.styles.map((x) => x.id)) === json(['flags', 'subcommand', 'continue', 'plain']) && s.settings.proofSeconds === 2 && s.settings.askAfterSeconds === 5, json({ enabled: s.enabled, terminals: s.terminals, styles: s.styles.map((x) => x.id) }));
        const found = Object.fromEntries(s.detected.map((d) => [d.program, d]));
        check('the programs this computer used are found by the conversations they keep, with their way of resuming and where they are',
            found.standin?.style === 'flags' && found.standin.path === programs.flags && found.standin.conversations === 1
            && found['standin-events']?.style === 'subcommand' && found['standin-events'].path === programs.events && !found['standin-plain'], json(s.detected));
        const marks = await api('marks');
        check('its marks for the window answer', marks.ok && marks.value.off === false && marks.value.openTabs === true && marks.value.agents.length === 0, json(marks));
        const before = (await run.api('dsh-plugin-session-watch/sessions')).value.items.length;
        const refusals = [
            [{}, /^Name the program to start: the command you type to run the coding agent\.$/],
            [{ program: 'standin', style: 'sideways', folder: ws.app }, /^Choose how the program resumes a conversation: flags, subcommand, continue, plain\.$/],
            [{ program: 'two words', style: 'plain', folder: ws.app }, /^The program is one word \(put its options under Arguments\), or a full path\.$/],
            [{ program: 'standin', style: 'flags', folder: join(run.root, 'nowhere') }, new RegExp(`^There is no folder at ${pattern(join(run.root, 'nowhere'))}: create it first, or choose another\\.$`)],
            [{ program: 'standin', style: 'flags', folder: 'projects/app' }, /^The folder must be a full path, such as ~\/Projects\/app\.$/],
        ];
        for (const [input, words] of refusals) {
            const r = await api('start', { input });
            check(`a start with ${json(input)} is refused in words`, r.ok === false && words.test(r.error?.message ?? ''), json(r));
        }
        const sent = await api('send', { key: 'nobody', text: 'hello' });
        check('a message for an agent that is not there is refused in words', sent.ok === false && sent.error?.message === 'That agent is not in the list any more.', json(sent));
        const after = (await run.api('dsh-plugin-session-watch/sessions')).value.items.length;
        check('a refused start makes no session', after === before, `${before} → ${after}`);
    });

    // ── An agent in a new session ──────────────────────────────────────
    await step('an agent starts in a new session of its folder, in a terminal there, and its first message is proven from its transcript', async () => {
        const started = await start({ program: 'standin', style: 'flags', folder: ws.app, name: 'App agent', task: 'Read the README #work=300' });
        const view = started.agent;
        agents.app = view.key;
        ids.app = view.sessionId;
        check('it starts with no problem, in a terminal of its own named after it', !started.problem && view.terminalId === `agent-${view.key}-1` && /^[0-9a-f-]{36}$/.test(view.conversationId ?? ''), json(started));
        const first = view.deliveries[0];
        const proven = await waitDelivery(view.key, first.id, ['delivered'], 'its first message to be proven');
        const agent = await agentOf(view.key);
        const users = transcriptUsers(agent.transcript);
        check('its first message is typed in and proven: its own transcript shows it', proven.why === 'Its transcript shows it.' && proven.enters === 1 && proven.provenAt >= first.at && users[0] === 'Read the README #work=300', json({ proven, users }));
        check('its transcript is where the program keeps it: under ~/.standin, by folder, named by the conversation id', agent.transcript.startsWith(join(user, '.standin', 'projects')) || real(agent.transcript).startsWith(real(join(user, '.standin', 'projects'))), agent.transcript);
        const lines = await screen(view.key);
        check('its terminal runs the program with exec and the conversation id it was given', shows(lines, `$ exec standin --session-id ${view.conversationId} || exit $?`) && shows(lines, `Stand-in coding agent · flags · ${view.conversationId}`), lines);
        const session = await waitFor(async () => {
            const s = await run.session(ids.app);
            return s.turns.ended >= 1 ? s : null;
        }, 'its session\'s first turn to end', 30000, 300);
        check('DSH has its session: named after the agent, in its folder', session.title === 'App agent' && real(session.cwd) === real(ws.app), json(session));
        const events = await run.events(ids.app);
        const note = events.find((e) => e.type === 'user/message' && /^A coding agent runs in this session's terminal: standin in /.test(e.text ?? ''));
        // Session Watch reads DSH's list again when it is older than 1.5 s: the row turns from blank within a few seconds.
        const listed = await waitFor(async () => ((await watchRow(ids.app))?.blank === false ? true : null), 'its session\'s row to stop being blank', 10000, 300).catch(() => false);
        check('its session got one short turn by its model, so DSH lists it', Boolean(note) && session.turns.started >= 1 && session.turns.started === session.turns.ended && listed === true, json({ turns: session.turns, note: note?.text, blank: (await watchRow(ids.app))?.blank }));
        const idle = await idleAgent(view.key, 'the agent to be idle after its answer');
        check('it is idle after its answer, with its reply', idle.lastReply?.text === 'Done: Read the README' && idle.detail === 'Done: Read the README', json({ status: idle.status, lastReply: idle.lastReply }));
        const row = await waitFor(async () => {
            const r = await watchRow(ids.app);
            return r?.external?.status === 'idle' ? r : null;
        }, 'the session row to say idle', 15000, 300);
        check('its session\'s row in Session Watch says what the agent does, by name', row.external.label === 'App agent' && row.external.agent === view.key && row.external.detail === 'Done: Read the README', json(row.external));
        const log = await history((e) => e.agent === view.key);
        const kinds = log.map((e) => `${e.kind}:${e.state}`).reverse();
        check('What happened: started, its session\'s first turn, the message, and its proof, each with why',
            ['start:done', 'session:done', 'message:delivered', 'proof:done'].every((k) => kinds.includes(k))
            && log.find((e) => e.kind === 'start')?.why === `You started standin in ${ws.app}, in a new session.`, json(log.map((e) => [e.kind, e.state, e.text, e.why])));
    });

    await step('one message at a time: the next waits while the agent works, can be taken back, and several lines go in as one paste', async () => {
        const key = agents.app;
        const busy = await send(key, 'Build it #work=4000');
        await waitDelivery(key, busy.id, ['delivered'], 'the first message to be proven');
        await waitAgent(key, (a) => a.status === 'working', 'the agent to work');
        const lines = await send(key, 'Line one\nLine two #work=200');
        const later = await send(key, 'Never mind this one');
        const waiting = await waitDelivery(key, lines.id, ['waiting'], 'the next message to wait', 10000);
        check('while the agent works, the next message waits, and says why', waiting.why === 'The agent is working; this is typed in when it is idle.', json(waiting));
        const taken = await api('cancel', { key, id: later.id });
        check('a message that waits can be taken back', taken.ok && taken.value.delivery.state === 'cancelled' && taken.value.delivery.why === 'You took it back before it was typed in.', json(taken));
        const again = await api('cancel', { key, id: later.id });
        check('taking it back again says it is taken back already', again.ok === false && again.error?.message === 'It was taken back already.', json(again));
        const pasted = await waitDelivery(key, lines.id, ['delivered'], 'the message of two lines to be proven', 30000);
        const agent = await idleAgent(key);
        const users = transcriptUsers(agent.transcript);
        check('once the agent is idle the waiting message goes in, its two lines as one message, and the one taken back never does',
            pasted.why === 'Its transcript shows it.' && users.includes('Line one\nLine two #work=200') && !users.some((u) => u.includes('Never mind'))
            && users.indexOf('Build it #work=4000') < users.indexOf('Line one\nLine two #work=200'), json(users));
    });

    await step('a program that swallows the Enter after a paste: Enter is pressed again, and the proof says so', async () => {
        const started = await start({ program: 'standin', args: '--swallow-enter', style: 'flags', folder: ws.swallow, name: 'Swallower' });
        agents.swallow = started.agent.key;
        ids.swallow = started.agent.sessionId;
        await waitAgent(agents.swallow, (a) => a.status === 'idle' && a.ready, 'the swallower to be ready');
        const item = await send(agents.swallow, 'Check the swallow #work=100');
        const proven = await waitDelivery(agents.swallow, item.id, ['delivered', 'not proven'], 'the swallowed message to be proven', 30000);
        const users = transcriptUsers((await agentOf(agents.swallow)).transcript);
        check('the first Enter was swallowed; Enter went again after 2 s, and its transcript shows the message once',
            proven.state === 'delivered' && proven.enters === 2 && proven.why === 'Its transcript shows it, after Enter 2 times (the first was swallowed).'
            && users.filter((u) => u === 'Check the swallow #work=100').length === 1, json({ proven, users }));
        const swallowScreen = await screen(agents.swallow);
        check('the program got the arguments it was given, before its conversation id', shows(swallowScreen, `exec standin --swallow-enter --session-id ${(await agentOf(agents.swallow)).conversationId}`), swallowScreen);
    });

    await step('a reply that asks: waiting on you, on its row and in Decisions; answered there, the answer is typed in and proven', async () => {
        const key = agents.app;
        await send(key, 'Choose the path #ask #work=200');
        const asking = await waitAgent(key, (a) => a.status === 'waiting on you', 'the agent to wait on you');
        check('it waits on you, with the question and the recommendation from its reply', asking.ask?.question === 'Use the fast path?' && asking.ask?.recommendation === 'Yes, the fast path', json(asking.ask));
        const row = await waitFor(async () => {
            const r = await watchRow(ids.app);
            return r?.external?.status === 'waiting on you' ? r : null;
        }, 'its row to say it waits on you', 15000, 300);
        check('its session\'s row says it waits on you', row.external.detail === 'Use the fast path?', json(row.external));
        const card = await waitFor(() => askCardFor(ids.app), 'a card in Decisions', 15000, 300);
        check('Decisions has one card for it: the agent\'s name, the question, the recommendation, Go with the recommendation, and room for own words',
            card.source === 'Agent Terminals' && card.title === 'App agent' && card.question === 'Use the fast path?' && card.recommendation === 'Yes, the fast path'
            && json(card.options) === json([{ id: 'recommended', label: 'Go with the recommendation' }]) && card.freeText === true && card.answer === 'ask', json(card));
        const asked = await history((e) => e.agent === key && e.kind === 'ask');
        check('What happened says it waits on you, and on what', asked[0]?.text === 'App agent waits on you' && asked[0]?.why === 'Use the fast path? Recommended: Yes, the fast path', json(asked[0]));
        const answered = await run.api('dsh-plugin-decisions/answer', { id: card.id, answer: { option: 'recommended' } });
        check('answered from Decisions: "answered", in Agent Terminals\' words, not yet "reached"', answered.ok && answered.value?.state === 'answered'
            && answered.value?.text === 'It goes into “App agent”\'s terminal when the agent is ready, and counts as delivered once its transcript shows it.', json(answered));
        const typed = await waitFor(async () => (await agentOf(key)).deliveries.find((d) => d.text === 'Go with your recommendation: Yes, the fast path' && d.state === 'delivered'), 'the answer to be proven', 30000, 300);
        check('the answer is typed into its terminal and proven from its transcript, marked as from Decisions', typed.by === 'you' && transcriptUsers((await agentOf(key)).transcript).includes('Go with your recommendation: Yes, the fast path'), json(typed));
        const outcome = await waitFor(async () => (await decisions()).history.find((e) => e.kind === 'answer' && e.cardId === card.id && e.state === 'delivered'), 'Decisions to hear it was delivered', 15000, 300);
        check('Decisions\' log turns the answer delivered once the agent\'s transcript shows it, with that proof', outcome.why === 'Its transcript shows it.' && outcome.askId === card.askId, json(outcome));
        await waitFor(async () => !(await askCardFor(ids.app)), 'the card to leave Decisions', 20000, 300);
        // A second question, answered in words.
        await idleAgent(key);
        await send(key, 'Choose again #ask #work=100');
        const second = await waitFor(() => askCardFor(ids.app), 'a second card', 20000, 300);
        const words = await run.api('dsh-plugin-decisions/answer', { id: second.id, answer: { text: 'Take the slow path, it is safer.' } });
        const own = await waitFor(async () => (await agentOf(key)).deliveries.find((d) => d.text === 'Take the slow path, it is safer.' && d.state === 'delivered'), 'the answer in words to be proven', 30000, 300);
        check('an answer in your own words goes in as written, and is proven', words.ok && Boolean(own), json(words));
        const idle = await idleAgent(key);
        check('answered, it is idle again with its new reply', idle.lastReply?.text === 'Done: Take the slow path, it is safer.', json(idle.lastReply));
    });

    await step('a program with no transcript runs and is typed to, and says it cannot prove; a program that is not there says how to fix it', async () => {
        const plain = await start({ program: 'standin-plain', style: 'plain', folder: ws.plain, name: 'Plain agent' });
        agents.plain = plain.agent.key;
        const running = await waitAgent(agents.plain, (a) => a.status === 'running' && a.ready, 'the plain agent to run', 30000);
        check('a program with no transcript is "running", and says what that means', running.detail === 'Running. It keeps no transcript Agent Terminals can read, so its work and its answers show only in its terminal.' && running.keepsTranscript === false && running.canResume === false, json(running));
        const item = await send(agents.plain, 'Hello plain #work=100');
        const typed = await waitDelivery(agents.plain, item.id, ['typed'], 'the message to be typed in', 20000);
        await waitFor(async () => shows(await screen(agents.plain), 'agent: Done: Hello plain'), 'the plain agent to answer on its screen', 15000, 300);
        check('its message is typed in, not "delivered": it says it cannot prove the agent read it; its screen shows the answer',
            /^(Typed|Pasted) in, then Enter\. This program keeps no transcript Agent Terminals can read, so it cannot prove the agent read it: look at its terminal\.$/.test(typed.why), json(typed));
        const words127 = 'It exited with code 127: the shell could not find no-such-agent-e2e. Use its full path (“which no-such-agent-e2e” in a terminal shows it), or check the name.';
        const missing = await start({ program: 'no-such-agent-e2e', style: 'plain', folder: ws.missing, name: 'Missing' });
        agents.missing = missing.agent.key;
        check('a program the shell cannot find: the start says it could not start, and why', missing.problem === words127, json(missing.problem));
        const ended = await waitAgent(agents.missing, (a) => a.status === 'stopped', 'the missing program to end', 30000);
        check('it is stopped, with the exit code and what to do', ended.ended?.code === 127 && ended.ended?.text === words127, json(ended.ended));
        const log = await history((e) => e.agent === agents.missing);
        const startEntry = log.find((e) => e.kind === 'start');
        check('What happened never says it started: it could not start, and it stopped, each with why', startEntry?.text === 'Could not start Missing' && startEntry?.state === 'failed' && startEntry?.reason === words127
            && log.some((e) => e.kind === 'ended' && e.text === 'Missing stopped' && e.state === 'stopped') && !log.some((e) => /^Started/.test(e.text ?? '')), json(log.map((e) => [e.kind, e.text, e.state])));
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const missingSession = await run.session(missing.agent.sessionId);
        check('its session got no turn: a program that never ran gives its model nothing to say', missingSession.turns.started === 0 && !log.some((e) => e.kind === 'session'), json(missingSession.turns));
        const recent = (await state()).recent;
        check('a program that could not start is not offered under "Used here before"; one that ran is', !recent.some((r) => r.program === 'no-such-agent-e2e') && recent.some((r) => r.program === 'standin'), json(recent));
        // A program under the home folder, given as ~/…: kept as its full path (a quoted ~ is not the home folder to the shell).
        const tildeFile = join(user, 'bin', 'standin-home');
        mkdirSync(dirname(tildeFile), { recursive: true });
        writeFileSync(tildeFile, readFileSync(programs.flags, 'utf8'));
        chmodSync(tildeFile, 0o755);
        const tilde = await start({ program: '~/bin/standin-home', style: 'flags', data: '~/.standin', folder: ws.missing, name: 'Home agent', task: 'From the home folder #work=100' });
        check('a program given as ~/… starts, kept as its full path', !tilde.problem && tilde.agent.program === tildeFile, json({ problem: tilde.problem, program: tilde.agent.program }));
        const homeFirst = await waitDelivery(tilde.agent.key, tilde.agent.deliveries[0].id, ['delivered', 'not proven'], 'its first message to be proven', 30000);
        check('it runs: its first message is proven from its transcript', homeFirst.state === 'delivered', json(homeFirst));
        await api('stop', { key: tilde.agent.key });
        await waitAgent(tilde.agent.key, (a) => a.status === 'stopped', 'the home agent to stop', 20000);
        await api('forget', { key: tilde.agent.key });
        // A path that is not a program: refused before a session or an agent is made for it.
        const sessionsBefore = (await run.api('dsh-plugin-session-watch/sessions')).value.items.length;
        const agentsBefore = (await state()).agents.length;
        const nowhere = await api('start', { input: { program: join(ws.missing, 'no-such-program'), style: 'plain', folder: ws.missing, name: 'Nowhere' } });
        const sessionsAfter = (await run.api('dsh-plugin-session-watch/sessions')).value.items.length;
        check('a path that is not a program is refused in words, and nothing is made for it', nowhere.ok === false
            && nowhere.error?.message === `There is no program at ${join(ws.missing, 'no-such-program')}: check the path, and that the file is executable.`
            && sessionsAfter === sessionsBefore && (await state()).agents.length === agentsBefore, json({ nowhere, sessionsBefore, sessionsAfter }));
    });

    // ── The window ─────────────────────────────────────────────────────
    pw = await findPlaywright();
    if (!pw) {
        check('Playwright is here for the window checks (NO_WINDOW=1 runs without them)', process.env.NO_WINDOW === '1', 'install it: npm i --prefix .e2e/tools playwright-core (or set PLAYWRIGHT_MODULE)');
    } else {
        ids.notes = await run.newSession('E2E:say Noted.', 'Notes');
        await waitFor(async () => (await run.session(ids.notes)).turns.ended >= 1, 'the notes session\'s turn', 30000, 300);

        await step('the page: counts, the agents with their states and messages, the start form with the programs found here', async () => {
            const page = await openAgents();
            const header = page.locator('[data-agent-terminals-header="on"]');
            await header.waitFor({ state: 'visible', timeout: 20000 });
            const count = await page.locator('[data-agent-terminals-count]').innerText();
            check('the header counts the agents: running and stopped', count === '3 running · 1 stopped', count);
            const app = cardOf(page, agents.app);
            await app.waitFor({ state: 'visible', timeout: 15000 });
            const appText = (await app.innerText()).replace(/\n+/g, ' ');
            check('an agent\'s card: its state, name, command and folder, its last reply, its messages with their states', (await app.getAttribute('data-agent-terminals-status')) === 'idle'
                && /idle/.test(appText) && /App agent/.test(appText) && /standin · in app/.test(appText) && /Its last reply/.test(appText) && /Done: Take the slow path, it is safer\./.test(appText)
                && /Messages \(\d+\)/.test(appText) && /delivered/.test(appText), appText);
            await app.getByRole('button', { name: /^Show all \d+$/ }).click();
            const taken = app.locator('[data-agent-terminals-message="cancelled"]');
            await taken.waitFor({ state: 'visible', timeout: 10000 });
            const takenText = (await taken.innerText()).replace(/\n+/g, ' ');
            const plainCard = cardOf(page, agents.plain);
            check('a message taken back says so, and why; one the program cannot prove says "typed in"', /Never mind this one/.test(takenText) && /taken back/.test(takenText)
                && /You took it back before it was typed in\./.test(takenText) && /typed in/.test(await plainCard.innerText()), `${takenText} | ${await plainCard.innerText()}`);
            const missingCard = cardOf(page, agents.missing);
            check('a stopped agent: Start again, Start anew only where it can resume, Forget, and why it stopped',
                (await missingCard.getByRole('button', { name: 'Start again' }).count()) === 1 && (await missingCard.getByRole('button', { name: 'Start anew' }).count()) === 0
                && (await missingCard.getByRole('button', { name: 'Forget' }).count()) === 1 && /could not find no-such-agent-e2e/.test(await missingCard.innerText()), await missingCard.innerText());
            const form = page.locator('[data-agent-terminals-start]');
            const chips = await form.locator('[data-agent-terminals-found]').evaluateAll((els) => els.map((el) => el.getAttribute('data-agent-terminals-found')));
            check('the start form offers the programs found here, and the ones used before', chips.includes('standin') && chips.includes('standin-events')
                && (await form.locator('[data-agent-terminals-recent]').count()) >= 2, json(chips));
            await shot(page, shots, 'page-light');
            await setDark(page, true);
            await shot(page, shots, 'page-dark');
            await setDark(page, false);
            await page.setViewportSize({ width: 760, height: 900 });
            await page.waitForTimeout(400);
            const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            check('a narrow window (760 px): nothing runs off the side', wide <= 1, `${wide}px wider`);
            await shot(page, shots, 'page-narrow-light');
            await page.setViewportSize({ width: 1280, height: 860 });
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-page');
        });

        await step('the session row: its mark, hover line and menu item, beside a neighbour\'s; the panel and the footer keep theirs', async () => {
            const page = window.page;
            // A new agent's session is in a workspace of its own, which the sidebar shows folded: its name on the card opens it.
            await cardOf(page, agents.app).getByRole('button', { name: 'App agent', exact: true }).click();
            const row = rowOf(page, ids.app);
            await row.waitFor({ state: 'visible', timeout: 20000 });
            check('the agent\'s name on its card opens its session, which the sidebar then shows', await row.isVisible());
            const mark = row.locator('[data-agent-terminals-mark]');
            check('its row has a mark that says what its agent does, in words for screen readers too', (await mark.getAttribute('data-agent-terminals-mark')) === 'idle'
                && (await mark.innerText()).includes('Coding agent: idle.'), await mark.innerText());
            const noteRow = rowOf(page, ids.notes);
            check('a session with no agent has no mark', (await noteRow.locator('[data-agent-terminals-mark]').count()) === 0);
            await row.hover();
            const hover = page.locator('[data-agent-terminals-hover]');
            await hover.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const hoverText = (await hover.count()) ? await hover.innerText() : '';
            check('its hover line says the agent\'s state and what it last did', /Coding agent in its terminal: idle/.test(hoverText) && /Done: Take the slow path, it is safer\./.test(hoverText), hoverText);
            await shot(page, shots, 'row-hover-light');
            // The neighbour marks the row too: its mark keeps the seat, ours stays in words; the menus hold both.
            await page.evaluate((id) => window.localStorage.setItem('dsh-plugin-neighbour/marked', JSON.stringify([id])), ids.app);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await rowOf(page, ids.app).waitFor({ state: 'visible', timeout: 60000 });
            await rowOf(page, ids.app).locator('[data-neighbour="mark"]').waitFor({ state: 'visible', timeout: 15000 });
            await rowOf(page, ids.app).locator('[data-agent-terminals-mark]').waitFor({ state: 'attached', timeout: 15000 });
            const seat = await rowOf(page, ids.app).evaluate((row) => [...row.querySelectorAll('[data-neighbour="mark"], [data-agent-terminals-mark]')].map((el) => ({
                who: el.hasAttribute('data-neighbour') ? 'neighbour' : 'agent',
                width: Math.round(el.getBoundingClientRect().width),
            })));
            check('beside a neighbour\'s mark: the neighbour\'s comes first and keeps the seat; ours stays, in words only', seat[0]?.who === 'neighbour' && seat[0].width === 16
                && seat.some((s) => s.who === 'agent' && s.width <= 1), json(seat));
            await rowOf(page, ids.app).hover();
            await page.getByRole('button', { name: 'Session actions for App agent' }).click();
            const items = await page.getByRole('menuitem').allInnerTexts();
            const ours = items.indexOf('Open the coding agent\'s terminal');
            const theirs = items.indexOf('Neighbour action');
            check('its menu item sits after the neighbour\'s, in order, and the menu keeps DSH\'s own', theirs >= 0 && ours > theirs && items.length >= 3, json(items));
            await shot(page, shots, 'row-menu-light');
            await page.keyboard.press('Escape');
            await rowOf(page, ids.notes).hover();
            await page.getByRole('button', { name: 'Session actions for Notes' }).click();
            const notesItems = await page.getByRole('menuitem').allInnerTexts();
            check('a session with no agent offers to start one there', notesItems.includes('Start a coding agent here'), json(notesItems));
            await page.keyboard.press('Escape');
            check('the panel list keeps the neighbour\'s entry beside Coding agents, and the footer its button', (await page.getByRole('button', { name: 'Neighbour', exact: true }).count()) >= 1
                && (await page.getByRole('button', { name: 'Coding agents', exact: true }).count()) >= 1 && (await page.locator('[data-neighbour="footer"]').isVisible()));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-row');
        });

        await step('its terminal opens in a tab beside its session, once, showing the agent', async () => {
            const page = window.page;
            await rowOf(page, ids.app).click();
            const tab = terminalTab(page, 'App agent');
            await tab.first().waitFor({ state: 'visible', timeout: 20000 });
            const text = await terminalShows(page, 'agent: Done: Take the slow path, it is safer.');
            check('opening its session opens its terminal tab, named after it, showing the agent\'s screen', shows(text, 'you: Take the slow path, it is safer.'), text.slice(-600));
            await shot(page, shots, 'terminal-tab-light');
            await setDark(page, true);
            await shot(page, shots, 'terminal-tab-dark');
            await setDark(page, false);
            // Away and back: the tab is there once, not again.
            await rowOf(page, ids.notes).click();
            await page.waitForTimeout(1500);
            await rowOf(page, ids.app).click();
            await page.waitForTimeout(2500);
            check('back on its session, there is still one tab for it', (await terminalTab(page, 'App agent').count()) === 1, String(await terminalTab(page, 'App agent').count()));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-tab');
        });

        await step('a tool call waiting in its terminal: waiting on you on the page, the badge and in Decisions; the next message held; answered in the terminal tab', async () => {
            const page = window.page;
            const key = agents.app;
            await send(key, 'Make the file #approve #work=100');
            const asking = await waitAgent(key, (a) => a.status === 'waiting on you' && Boolean(a.call), 'the call to count as asking you', 20000);
            check('after 5 s with no result, the call counts as asking you, with the command', asking.call.tool === 'Bash' && asking.call.summary === 'touch approved.txt'
                && /^Bash “touch approved\.txt” has waited (\d+ s or more|\d+ min) for its result: it may be asking you in its terminal\.$/.test(asking.detail), json({ call: asking.call, detail: asking.detail }));
            const card = await waitFor(() => askCardFor(ids.app), 'its card in Decisions', 15000, 300);
            check('Decisions says what it asks and to answer in its terminal, with nothing to pick there', card.question === 'It asks to run “touch approved.txt”.' && card.answer === 'session'
                && card.hint === 'Answer in its terminal: open the session, then the agent\'s terminal tab.', json(card));
            const held = await send(key, 'After the file #work=100');
            const waits = await waitDelivery(key, held.id, ['waiting'], 'the next message to wait', 10000);
            check('the next message waits, so nothing lands in the prompt, and says where to answer', waits.why === 'Held while a tool call waits in its terminal (to run “touch approved.txt”); this is typed in after it ends. If its terminal asks you something, answer there.', waits.why);
            await openAgents();
            const icon = page.locator('[data-agent-terminals-icon]').first();
            await waitFor(async () => (await icon.getAttribute('data-agent-terminals-icon')) === '1', 'the badge to count it', 15000, 300);
            check('the sidebar entry\'s badge counts the agent waiting on you, in words too', /1 coding agent waiting on you/.test(await icon.innerText()), await icon.innerText());
            const block = cardOf(page, key).locator('[data-agent-terminals-ask="call"]');
            await block.waitFor({ state: 'visible', timeout: 15000 });
            const blockText = (await block.innerText()).replace(/\n+/g, ' ');
            check('its card says what it asks, and offers its terminal', /It asks to run “touch approved\.txt”\./.test(blockText) && /Its terminal most likely asks you something: answer there\./.test(blockText), blockText);
            await shot(page, shots, 'waiting-call-light');
            await block.getByRole('button', { name: 'Open its terminal' }).click();
            await terminalShows(page, 'Allow this command?');
            await page.locator('.xterm-screen:visible').first().click();
            await page.keyboard.type('1');
            await waitFor(() => existsSync(join(ws.app, 'approved.txt')), 'the tool to run', 15000, 300);
            const done = await waitDelivery(key, held.id, ['delivered'], 'the held message to go in', 30000);
            check('answered in its terminal tab: the tool ran, and the held message went in after, proven', done.why === 'Its transcript shows it.' && existsSync(join(ws.app, 'approved.txt')), json(done));
            await waitFor(async () => !(await askCardFor(ids.app)), 'the card to leave Decisions', 20000, 300);
            await idleAgent(key);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-call');
        });

        await step('started from the page with a program found here: its way of resuming comes with it, and its first message is proven', async () => {
            const page = await openAgents();
            const form = page.locator('[data-agent-terminals-start]');
            await form.locator('[data-agent-terminals-found="standin-events"]').click();
            check('the found program fills in its path and its way of resuming', (await form.getByLabel('Program', { exact: true }).inputValue()) === programs.events
                && (await form.getByRole('radio', { name: /Resumes with the resume subcommand/ }).isChecked()), await form.getByLabel('Program', { exact: true }).inputValue());
            await form.getByLabel('Folder', { exact: true }).fill(ws.events);
            await form.getByLabel('Name', { exact: true }).fill('Events agent');
            await form.getByLabel('First message', { exact: true }).fill('Hello events #work=200');
            await shot(page, shots, 'start-form-light');
            await form.getByRole('button', { name: 'Start', exact: true }).click();
            const said = page.locator('[data-agent-terminals-said]');
            await waitFor(async () => /Started “Events agent”\./.test(await said.innerText()), 'the page to say it started', 20000, 300);
            check('the page says it started, and how to watch it', (await said.innerText()) === 'Started “Events agent”. Open its terminal to watch it work.', await said.innerText());
            const agent = await waitFor(async () => (await state()).agents.find((a) => a.name === 'Events agent'), 'the events agent', 10000, 300);
            agents.events = agent.key;
            ids.events = agent.sessionId;
            const proven = await waitDelivery(agent.key, agent.deliveries.at(-1).id, ['delivered'], 'its first message to be proven', 30000);
            const now = await agentOf(agent.key);
            check('its conversation id comes from the file it made, and its first message is proven there', /^[0-9a-f-]{36}$/.test(now.conversationId ?? '') && now.transcript.endsWith(`-${now.conversationId}.jsonl`)
                && proven.why === 'Its transcript shows it.' && transcriptUsers(now.transcript).includes('Hello events #work=200'), json({ id: now.conversationId, transcript: now.transcript }));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-start-form');
        });

        await step('Stop, Start again (it resumes), Start anew and Forget, from the page', async () => {
            const page = await openAgents();
            const key = agents.events;
            const before = await idleAgent(key);
            const card = cardOf(page, key);
            await card.getByRole('button', { name: 'Stop', exact: true }).click();
            const said = page.locator('[data-agent-terminals-said]');
            await waitFor(async () => /^Stopped “Events agent”/.test(await said.innerText()), 'the page to say it stopped', 15000, 300);
            const stopped = await waitAgent(key, (a) => a.status === 'stopped', 'the agent to stop');
            check('Stop: it stops, its terminal closes, and the page says Start again resumes it', (await said.innerText()) === 'Stopped “Events agent”. Start again resumes its conversation.'
                && stopped.ended?.why === 'stopped' && (stopped.terminal === null || stopped.terminal.state !== 'running'), json({ ended: stopped.ended, terminal: stopped.terminal }));
            await card.getByRole('button', { name: 'Start again', exact: true }).click();
            const resumed = await waitAgent(key, (a) => a.status === 'idle' && a.launches === 2, 'it to start again', 30000);
            const lines = await waitFor(async () => {
                const now = await screen(key);
                return shows(now, `Resumed conversation ${before.conversationId}`) ? now : null;
            }, 'its screen to say it resumed', 15000, 300);
            check('Start again: a new terminal, resuming the same conversation', resumed.conversationId === before.conversationId && resumed.terminalId === `agent-${key}-2`
                && shows(lines, `exec ${programs.events} resume ${before.conversationId}`), lines);
            const next = await send(key, 'After the resume #work=100');
            await waitDelivery(key, next.id, ['delivered'], 'a message after the resume', 30000);
            check('a message after it resumed goes into the same conversation file', transcriptUsers(before.transcript).includes('After the resume #work=100'), json(transcriptUsers(before.transcript)));
            await idleAgent(key);
            await card.getByRole('button', { name: 'Stop', exact: true }).click();
            await waitAgent(key, (a) => a.status === 'stopped', 'the agent to stop again');
            await card.getByRole('button', { name: 'Start anew', exact: true }).click();
            const anew = await waitAgent(key, (a) => a.status === 'idle' && a.launches === 3 && a.conversationId && a.conversationId !== before.conversationId, 'it to start anew', 30000);
            check('Start anew: a new conversation, in a new file', !shows(await screen(key), 'Resumed conversation') && anew.transcript !== before.transcript, json({ id: anew.conversationId }));
            await card.getByRole('button', { name: 'Stop', exact: true }).click();
            await waitAgent(key, (a) => a.status === 'stopped', 'the agent to stop before it is forgotten');
            // Forget asks first: Keep it changes nothing, Forget it takes it off the list.
            await card.getByRole('button', { name: 'Forget', exact: true }).click();
            const asked = card.locator('[data-agent-terminals-forget]');
            await asked.waitFor({ state: 'visible', timeout: 10000 });
            const question = await asked.innerText();
            const keepFocused = await page.evaluate(() => document.activeElement?.textContent ?? '');
            await card.getByRole('button', { name: 'Keep it', exact: true }).click();
            await page.waitForTimeout(300);
            const kept = Boolean(await agentOf(key)) && (await card.getByRole('button', { name: 'Forget', exact: true }).count()) === 1;
            check('Forget asks first, with Keep it in focus; Keep it changes nothing', question === 'Forget “Events agent”? Its session and its conversation files stay.' && keepFocused === 'Keep it' && kept, json({ question, keepFocused, kept }));
            await card.getByRole('button', { name: 'Forget', exact: true }).click();
            await card.getByRole('button', { name: 'Forget it', exact: true }).click();
            await waitFor(async () => !(await agentOf(key)), 'the agent to leave the list', 15000, 300);
            const session = await run.session(ids.events);
            const forgot = await history((e) => e.agent === key && e.kind === 'forget');
            check('Forget: it leaves the list; its session stays in DSH, and its conversation files stay', session.sessionId === ids.events && existsSync(before.transcript)
                && forgot[0]?.why === 'Its session and its own conversation files stay as they are.', json(forgot[0]));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-buttons');
        });

        await step('closing an agent\'s terminal tab ends the agent; Start again brings it back in a new tab', async () => {
            const page = window.page;
            const key = agents.app;
            const before = await agentOf(key);
            await rowOf(page, ids.app).click();
            const tab = terminalTab(page, 'App agent').first();
            await tab.waitFor({ state: 'visible', timeout: 20000 });
            await tab.hover();
            await tab.locator('[data-dockkit-tab-close]').click();
            // DSH may ask before it ends a running program: only a dialog's button, never another tab's close.
            const dialog = page.locator('[role="alertdialog"], [role="dialog"]');
            await dialog.first().waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
            if (await dialog.count()) {
                const confirm = dialog.first().getByRole('button', { name: /^(Close|Terminate|End|Kill|OK)/i });
                if (await confirm.count()) await confirm.first().click().catch(() => {});
            }
            const ended = await waitAgent(key, (a) => a.status === 'stopped', 'the agent to end with its tab', 20000);
            check('closing its tab ends it, and says so, with the way back', ended.ended?.why === 'closed'
                && ended.ended?.text === 'Its terminal was closed (closing an agent\'s terminal tab ends the agent). Start again resumes its conversation.', json(ended.ended));
            const log = await history((e) => e.agent === key && e.kind === 'ended');
            check('What happened says it was closed', log[0]?.text === 'App agent was closed', json(log[0]));
            await openAgents();
            await cardOf(page, key).getByRole('button', { name: 'Start again', exact: true }).click();
            const back = await waitAgent(key, (a) => a.status === 'idle' && a.launches === before.launches + 1, 'it to come back', 30000);
            check('Start again: the same conversation, in a new terminal', back.conversationId === before.conversationId && back.terminalId === `agent-${key}-${before.launches + 1}`, json({ terminalId: back.terminalId }));
            await rowOf(page, ids.app).click();
            const text = await terminalShows(page, `Resumed conversation ${back.conversationId}`);
            check('opening its session shows the new terminal in a tab, resumed', (await terminalTab(page, 'App agent').count()) === 1, text.slice(0, 400));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-close-tab');
        });

        await step('its settings in Plugins, in DSH\'s own form: typing while the agent works, switched on, applies at once', async () => {
            const page = await openAgents();
            await page.locator('[data-agent-terminals-header]').getByRole('button', { name: 'Settings', exact: true }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-agent-terminals"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            const switches = ['Start agents again after DSH restarts', 'List a new agent\'s session in the sidebar', 'Open an agent\'s terminal tab with its session', 'Type messages in while the agent works', 'A notification when an agent waits on you'];
            const numbers = ['Seconds without proof before Enter is pressed again', 'Press Enter again, at most', 'Seconds before a waiting tool call counts as asking you'];
            const missing = [];
            for (const title of switches) if ((await form.getByRole('switch', { name: title, exact: true }).count()) !== 1) missing.push(title);
            for (const title of numbers) if ((await form.getByLabel(title, { exact: true }).count()) !== 1) missing.push(title);
            check('the header\'s Settings opens its settings in Plugins, every one by its title, with the values in the profile', missing.length === 0
                && (await form.getByLabel('Seconds without proof before Enter is pressed again', { exact: true }).inputValue()) === '2', `missing: ${missing.join(' | ')}`);
            await shot(page, shots, 'settings-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-dark');
            await setDark(page, false);
            await form.getByRole('switch', { name: 'Type messages in while the agent works' }).click();
            await form.getByRole('button', { name: 'Save' }).click();
            await waitFor(async () => (await state()).settings.typeWhileWorking === true, 'the setting to apply', 15000, 300);
            const changed = await history((e) => e.kind === 'settings');
            check('saved: it applies at once, and What happened says what changed', changed[0]?.text === 'Settings changed: “Type messages in while the agent works”', json(changed[0]));
            const key = agents.app;
            await idleAgent(key);
            const long = await send(key, 'Long job #work=4000');
            await waitDelivery(key, long.id, ['delivered'], 'the long job to be proven', 20000);
            await waitAgent(key, (a) => a.status === 'working', 'the agent to work');
            const during = await send(key, 'While it works #work=100');
            const typedWhile = await waitDelivery(key, during.id, ['typed', 'delivered'], 'the next message to be typed in while it works', 10000);
            const stillWorking = (await agentOf(key)).status === 'working';
            check('with it on, the next message is typed in while the agent works (the program keeps it)', typedWhile.state === 'typed' && stillWorking, json({ typedWhile, stillWorking }));
            const kept = await waitDelivery(key, during.id, ['delivered'], 'the message typed while it worked to be proven', 30000);
            const users = transcriptUsers((await agentOf(key)).transcript);
            check('and proven once the agent reads it, after the job it was working on', kept.enters === 1 && users.indexOf('While it works #work=100') > users.indexOf('Long job #work=4000'), json(users.slice(-3)));
            // Typed while it works, then its approval prompt opens before it reads the message: no Enter may land there.
            rmSync(join(ws.app, 'approved.txt'), { force: true });
            await idleAgent(key);
            const guarded = await send(key, 'Guarded job #approve #work=2000');
            await waitDelivery(key, guarded.id, ['delivered'], 'the guarded job to be proven', 20000);
            const early = await send(key, 'Typed before its prompt #work=100');
            const earlyTyped = await waitDelivery(key, early.id, ['typed'], 'the next message typed in while it works', 10000);
            await waitAgent(key, (a) => a.status === 'waiting on you' && Boolean(a.call), 'its approval prompt', 20000);
            await new Promise((resolve) => setTimeout(resolve, 6000));
            const held = deliveryOf(await agentOf(key), early.id);
            check('with typing while it works on, no Enter goes into the approval prompt that opened: the prompt is unanswered, the message typed once and waiting for its proof',
                earlyTyped.enters === 1 && held.state === 'typed' && held.enters === 1 && !existsSync(join(ws.app, 'approved.txt')), json({ held, approved: existsSync(join(ws.app, 'approved.txt')) }));
            const block = cardOf(page, key).locator('[data-agent-terminals-ask="call"]');
            await openAgents();
            await block.waitFor({ state: 'visible', timeout: 15000 });
            await block.getByRole('button', { name: 'Open its terminal' }).click();
            await terminalShows(page, 'Allow this command?');
            await page.locator('.xterm-screen:visible').first().click();
            await page.keyboard.type('n');
            const late = await waitDelivery(key, early.id, ['delivered'], 'the message typed before the prompt to be proven', 30000);
            const after = transcriptUsers((await agentOf(key)).transcript);
            check('refused in its terminal: the tool did not run, and the message went in once, proven, after the guarded job', late.enters === 1 && !existsSync(join(ws.app, 'approved.txt'))
                && after.filter((u) => u === 'Typed before its prompt #work=100').length === 1 && after.indexOf('Typed before its prompt #work=100') > after.indexOf('Guarded job #approve #work=2000'), json(after.slice(-3)));
            await idleAgent(key);
            // Back off, in the same form.
            if (!(await form.isVisible())) {
                await openAgents();
                await page.locator('[data-agent-terminals-header]').getByRole('button', { name: 'Settings', exact: true }).click();
                await form.waitFor({ state: 'visible', timeout: 20000 });
            }
            await form.getByRole('switch', { name: 'Type messages in while the agent works' }).click();
            await form.getByRole('button', { name: 'Save' }).click();
            await waitFor(async () => (await state()).settings.typeWhileWorking === false, 'the setting to go back', 15000, 300);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-settings');
        });

        await step('"Start a coding agent here" from a session\'s menu starts one in that session', async () => {
            const page = window.page;
            await rowOf(page, ids.notes).hover();
            await page.getByRole('button', { name: 'Session actions for Notes' }).click();
            await page.getByRole('menuitem', { name: 'Start a coding agent here' }).click();
            await page.locator('[data-agent-terminals-page]').waitFor({ state: 'visible', timeout: 15000 });
            const form = page.locator('[data-agent-terminals-start]');
            const here = form.getByRole('radio', { name: /In the session “Notes”/ });
            await here.waitFor({ state: 'visible', timeout: 10000 });
            check('the form offers that session, chosen, and puts the cursor on the program', (await here.isChecked()) && (await page.evaluate(() => document.activeElement?.id)) === 'dshat-program', '');
            await form.getByLabel('Program', { exact: true }).fill('standin-plain');
            await form.getByRole('radio', { name: /Runs the command; nothing to resume/ }).check();
            await shot(page, shots, 'start-here-light');
            await form.getByRole('button', { name: 'Start', exact: true }).click();
            const agent = await waitFor(async () => (await state()).agents.find((a) => a.sessionId === ids.notes), 'an agent in the Notes session', 20000, 300);
            agents.notes = agent.key;
            check('it starts in that session, in its folder, named after the program', agent.name === 'standin-plain' && real(agent.folder) === real(run.ws), json({ name: agent.name, folder: agent.folder }));
            const again = await api('start', { input: { program: 'standin-plain', style: 'plain', sessionId: ids.notes } });
            check('a second agent in the same session is refused, in words', again.ok === false && again.error?.message === 'That session already has a coding agent (standin-plain). Start the new one in a new session, or forget that one first.', json(again));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-start-here');
        });
        check('no errors from the suite in the window', suiteErrors().length === 0, suiteErrors().join('\n'));
    }

    // ── A DSH restart ──────────────────────────────────────────────────
    await step('a wrong setting saved while DSH runs: the agents keep running, read "not followed" with nothing that would act on them, and are picked up where they are', async () => {
        const before = await idleAgent(agents.app);
        run.rows = rowsWith({ at: { proofSeconds: 500 } });
        run.writeProfile(model.port);
        const s = await waitFor(async () => {
            const now = await state();
            return now.problem?.key === 'proofSeconds' ? now : null;
        }, 'the wrong setting to be read', 30000, 300);
        const app = s.agents.find((a) => a.key === agents.app);
        check('the agent still runs in its terminal, and says it is running, not followed, and what Agent Terminals waits for', app.status === 'running' && app.followed === false && app.terminal?.state === 'running'
            && app.detail === 'Running in its terminal, not followed: Agent Terminals waits for a setting to be fixed (see the top of this page), then picks it up where it is.', json({ status: app.status, followed: app.followed, detail: app.detail }));
        const stopped = await history((e) => e.kind === 'switch');
        check('What happened says Agent Terminals stopped following its agents, and why', stopped[0]?.text === 'Agent Terminals stopped following its agents' && /A setting is wrong/.test(stopped[0]?.why ?? ''), json(stopped[0]));
        if (window) {
            const page = await openAgents();
            const card = cardOf(page, agents.app);
            await card.waitFor({ state: 'visible', timeout: 20000 });
            // The page reads its state again within a moment of the change.
            const acts = (names) => !names.some((n) => /^(Stop|Start again|Start anew|Forget|Send)$/.test(n.trim())) && names.some((n) => n.trim() === 'Open its terminal');
            const names = await waitFor(async () => {
                const now = await card.getByRole('button').allInnerTexts();
                return acts(now) ? now : null;
            }, 'its card to show it is not followed', 10000, 300).catch(async () => card.getByRole('button').allInnerTexts());
            check('its card offers nothing that would act on it while it is not followed (its terminal can still be opened)', acts(names), json(names));
            await shot(page, shots, 'not-followed-light');
        }
        run.rows = rowsWith();
        run.writeProfile(model.port);
        await waitFor(async () => !(await state()).problem, 'the setting to be fixed', 30000, 300);
        const back = await idleAgent(agents.app, 'the agent to be picked up');
        check('fixed: the agent is picked up where it is, in the same terminal, not started again', back.followed === true && back.terminalId === before.terminalId && back.launches === before.launches, json({ terminalId: back.terminalId, launches: back.launches }));
        const follows = await history((e) => e.kind === 'switch');
        check('What happened says it follows its agents again', follows[0]?.text === 'Agent Terminals follows its agents' && follows[0]?.why === 'Its settings are right again: it picks up every agent where it is.', json(follows[0]));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-not-followed');
    });

    await step('a DSH restart: running agents start again under the same terminal id and resume; one that cannot resume says why', async () => {
        const before = await agentOf(agents.app);
        const plainBefore = await agentOf(agents.plain);
        await run.stop();
        await run.boot('a restart');
        await waitFor(async () => (await api('state')).ok, 'Agent Terminals after the restart', 30000);
        const back = await waitAgent(agents.app, (a) => a.status === 'idle' && a.ready, 'the agent to be back', 40000);
        const lines = await screen(agents.app);
        check('it starts again in a terminal with the same id, resuming its conversation', back.terminalId === before.terminalId && back.conversationId === before.conversationId
            && shows(lines, `exec standin --resume ${before.conversationId}`) && shows(lines, `Resumed conversation ${before.conversationId}`), lines);
        const log = await history((e) => e.agent === agents.app && e.kind === 'restart');
        check('What happened says it started again after the restart, and why', log[0]?.text === 'Started App agent again after DSH restarted'
            && log[0]?.why === 'DSH ended its terminal when it quit. It resumes its conversation in a new terminal with the same name, so its tab finds it.', json(log[0]));
        const plain = await waitAgent(agents.plain, (a) => a.status === 'stopped', 'the plain agent to be stopped');
        check('a program that cannot resume is not started again, and says why', plainBefore.status === 'running' && plain.ended?.why === 'restart'
            && plain.ended.text === 'DSH restarted, which ended its terminal. This program cannot resume a conversation, so it was not started again: Start again runs it anew.', json(plain.ended));
        const next = await send(agents.app, 'After the restart #work=100');
        await waitDelivery(agents.app, next.id, ['delivered'], 'a message after the restart', 30000);
        check('a message after the restart goes into the same conversation', transcriptUsers(before.transcript).includes('After the restart #work=100'), '');
        if (window) {
            await signInAgain();
            const page = window.page;
            await rowOf(page, ids.app).click();
            const text = await terminalShows(page, `Resumed conversation ${before.conversationId}`, 30000);
            check('the window\'s tab, restored after the restart, shows the resumed agent', (await terminalTab(page, 'App agent').count()) === 1 && shows(text, 'you: After the restart'), text.slice(-400));
            await shot(page, shots, 'after-restart-light');
        }
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-restart');
    });

    await step('a DSH restart in the middle of a job and of an approval prompt: idle after it, the held messages typed in once and proven, no question left in Decisions', async () => {
        rmSync(join(ws.app, 'approved.txt'), { force: true });
        await idleAgent(agents.app);
        const long = await start({ program: 'standin', style: 'flags', folder: ws.long, name: 'Long agent', task: 'A long job #work=600000' });
        agents.long = long.agent.key;
        ids.long = long.agent.sessionId;
        await waitDelivery(agents.long, long.agent.deliveries[0].id, ['delivered'], 'the long job to be under way', 30000);
        await waitAgent(agents.long, (a) => a.status === 'working', 'the long job to work', 20000);
        await send(agents.app, 'Guarded job #approve #work=100');
        await waitAgent(agents.app, (a) => a.status === 'waiting on you' && Boolean(a.call), 'its approval prompt', 20000);
        await waitFor(() => askCardFor(ids.app), 'its card in Decisions', 15000, 300);
        const heldApp = await send(agents.app, 'After the cut prompt #work=100');
        const heldLong = await send(agents.long, 'After the cut job #work=100');
        await waitDelivery(agents.app, heldApp.id, ['waiting'], 'the message held by the prompt', 10000);
        await waitDelivery(agents.long, heldLong.id, ['waiting'], 'the message held by the job', 10000);
        await run.stop();
        await run.boot('a restart in the middle of a job');
        await waitFor(async () => (await api('state')).ok, 'Agent Terminals after the restart', 30000);
        const cut = await waitFor(async () => {
            const entries = await history((e) => e.kind === 'cut');
            return entries.some((e) => e.agent === agents.app) && entries.some((e) => e.agent === agents.long) ? entries : null;
        }, 'the cut jobs to be logged', 40000, 300);
        check('What happened says which jobs the restart cut off, once each, and that the agent waits for a message', cut.filter((e) => e.agent === agents.app).length === 1 && cut.filter((e) => e.agent === agents.long).length === 1
            && cut.find((e) => e.agent === agents.app).why === 'Its program ended while it worked on “Guarded job #approve #work=100”. It starts again idle in the same conversation: send it a message to carry on.'
            && cut.find((e) => e.agent === agents.long).text === 'Long agent\'s job was cut off', json(cut.map((e) => [e.agent, e.text, e.why])));
        const app = await waitDelivery(agents.app, heldApp.id, ['delivered'], 'the message held by the prompt to go in after the restart', 60000);
        const longDone = await waitDelivery(agents.long, heldLong.id, ['delivered'], 'the message held by the job to go in after the restart', 60000);
        const appUsers = transcriptUsers((await agentOf(agents.app)).transcript);
        const longUsers = transcriptUsers((await agentOf(agents.long)).transcript);
        check('each held message is typed in once and proven, into the resumed conversation', app.enters === 1 && longDone.enters === 1
            && appUsers.filter((u) => u === 'After the cut prompt #work=100').length === 1 && longUsers.filter((u) => u === 'After the cut job #work=100').length === 1, json({ app, longDone }));
        const idleApp = await idleAgent(agents.app);
        const idleLong = await idleAgent(agents.long);
        check('neither works nor waits on you for ever: both idle, with the answer to the held message', idleApp.lastReply?.text === 'Done: After the cut prompt' && idleLong.lastReply?.text === 'Done: After the cut job', json([idleApp.lastReply, idleLong.lastReply]));
        check('no question is left in Decisions, and nothing answered the old prompt', !(await askCardFor(ids.app)) && !(await askCardFor(ids.long)) && !existsSync(join(ws.app, 'approved.txt')), '');
        await api('stop', { key: agents.long });
    });

    await step('a restart while messages wait for their proof: each is typed in again once and proven, and Decisions hears the answer delivered', async () => {
        // The swallower asks first (with Enter pressed again after 2 s).
        await idleAgent(agents.swallow);
        await send(agents.swallow, 'Ask before the restart #ask #work=100');
        const card = await waitFor(() => askCardFor(ids.swallow), 'the swallower\'s question in Decisions', 30000, 300);
        // Then messages that wait for their proof when DSH quits: one typed in while a job works, and an answer
        // whose Enter the program swallowed (Enter goes again only after a minute).
        run.rows = rowsWith({ at: { typeWhileWorking: true, proofSeconds: 60 } });
        run.writeProfile(model.port);
        await waitFor(async () => {
            const now = (await state()).settings;
            return now.typeWhileWorking === true && now.proofSeconds === 60 ? true : null;
        }, 'the settings to apply', 30000, 300);
        await idleAgent(agents.app);
        await send(agents.app, 'A job to type into #work=600000');
        await waitAgent(agents.app, (a) => a.status === 'working', 'the job to work', 20000);
        const during = await send(agents.app, 'Typed during the job #work=100');
        await waitDelivery(agents.app, during.id, ['typed'], 'typed in while it works', 20000);
        const answered = await run.api('dsh-plugin-decisions/answer', { id: card.id, answer: { text: 'Restart answer: the slow path' } });
        check('answered from Decisions', answered.ok && answered.value?.state === 'answered', json(answered));
        const answer = await waitFor(async () => (await agentOf(agents.swallow)).deliveries.find((d) => d.text === 'Restart answer: the slow path' && d.state === 'typed'), 'the answer typed in, its Enter swallowed', 20000, 300);
        await restartWith(rowsWith(), 'a restart while messages wait for their proof');
        await waitFor(async () => (await api('state')).ok, 'Agent Terminals after the restart', 30000);
        const typedAgain = await waitDelivery(agents.app, during.id, ['delivered', 'not proven', 'failed'], 'the message typed during the job to go in again', 60000);
        const appUsers = transcriptUsers((await agentOf(agents.app)).transcript);
        check('the message the old program had not read is typed in again once, and proven', typedAgain.state === 'delivered' && typedAgain.enters === 1
            && appUsers.filter((u) => u === 'Typed during the job #work=100').length === 1, json({ typedAgain, users: appUsers.slice(-4) }));
        const answerAgain = await waitDelivery(agents.swallow, answer.id, ['delivered', 'not proven', 'failed'], 'the answer to go in again', 60000);
        const swallowUsers = transcriptUsers((await agentOf(agents.swallow)).transcript);
        check('the answer whose Enter was swallowed is typed in again once (Enter twice), and proven', answerAgain.state === 'delivered' && answerAgain.enters === 2
            && swallowUsers.filter((u) => u === 'Restart answer: the slow path').length === 1, json({ answerAgain, users: swallowUsers.slice(-4) }));
        const said = await history((e) => e.kind === 'message' && e.delivery === during.id);
        check('What happened ends the message delivered', said[0]?.state === 'delivered', json(said[0]));
        const outcome = await waitFor(async () => (await decisions()).history.find((e) => e.kind === 'answer' && e.cardId === card.id && e.state === 'delivered'), 'Decisions to hear the answer was delivered', 20000, 300);
        check('Decisions\' log turns the answer delivered, from the proof after the restart', outcome.why === 'Its transcript shows it, after Enter 2 times (the first was swallowed).', json(outcome));
        await idleAgent(agents.swallow, 'the swallower to answer');
        await waitFor(async () => !(await askCardFor(ids.swallow)), 'no question left in Decisions', 20000, 300);
    });

    await step('a pick-up after a restart cut a job and an approval prompt, with nothing sent since: both stay idle, hold nothing, and leave nothing in Decisions', async () => {
        rmSync(join(ws.app, 'approved.txt'), { force: true });
        await idleAgent(agents.app);
        await api('startAgain', { key: agents.long, fresh: false });
        await idleAgent(agents.long, 'the long agent to start again');
        await send(agents.long, 'Cut before a pick-up #work=600000');
        await waitAgent(agents.long, (a) => a.status === 'working', 'the job to work', 20000);
        await send(agents.app, 'Guarded before a pick-up #approve #work=100');
        await waitAgent(agents.app, (a) => a.status === 'waiting on you' && Boolean(a.call), 'its approval prompt', 20000);
        await waitFor(() => askCardFor(ids.app), 'its card in Decisions', 15000, 300);
        await run.stop();
        await run.boot('a restart before a pick-up');
        await waitFor(async () => (await api('state')).ok, 'Agent Terminals after the restart', 30000);
        const cutIdle = (a) => a.status === 'idle' && a.ready && /was cut off when its program ended/.test(a.detail ?? '');
        await waitAgent(agents.app, cutIdle, 'the approval cut', 40000);
        await waitAgent(agents.long, cutIdle, 'the job cut', 40000);
        // A pick-up without a launch: a wrong setting saved, then fixed (as switching off and on in Plugins does).
        run.rows = rowsWith({ at: { proofSeconds: 500 } });
        run.writeProfile(model.port);
        await waitFor(async () => (await state()).problem?.key === 'proofSeconds', 'the wrong setting to be read', 30000, 300);
        run.rows = rowsWith();
        run.writeProfile(model.port);
        await waitFor(async () => !(await state()).problem, 'the setting to be fixed', 30000, 300);
        await waitFor(async () => (await state()).agents.filter((a) => [agents.app, agents.long].includes(a.key)).every((a) => a.followed === true) || null, 'both picked up', 20000, 300);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const both = (await state()).agents.filter((a) => [agents.app, agents.long].includes(a.key));
        check('picked up, both are still idle, with the job the restart cut (not working, not waiting on you)', both.length === 2 && both.every(cutIdle), json(both.map((a) => [a.name, a.status, a.detail])));
        check('nothing is left in Decisions for them', !(await askCardFor(ids.app)) && !(await askCardFor(ids.long)), '');
        const row = await watchRow(ids.long);
        check('their rows say idle too', row?.external?.status === 'idle', json(row?.external));
        const next = await send(agents.long, 'After the pick-up #work=100');
        const went = await waitDelivery(agents.long, next.id, ['delivered'], 'a message after the pick-up', 30000);
        check('a message goes straight in, held by nothing, and is proven', went.enters === 1 && !existsSync(join(ws.app, 'approved.txt')), json(went));
        await api('stop', { key: agents.long });
    });

    // ── Typing through DSH's terminal input ────────────────────────────
    await step(hasTerminalInput ? 'typing through DSH\'s terminal input (0.2.0): a message goes in, and the tab gets its keyboard back'
        : 'typing through DSH\'s terminal input on a build without it: the agents say what to set', async () => {
        await restartWith(rowsWith({ at: { typing: 'attached' } }), 'typing: attached');
        await waitFor(async () => (await api('state')).ok, 'Agent Terminals with typing: attached', 30000);
        if (!hasTerminalInput) {
            const words = 'This DSH has no terminal input for plugins. Set "How messages are typed in" (typing) to auto in its profile settings.';
            const failed = await waitAgent(agents.app, (a) => a.status === 'stopped' && Boolean(a.problem), 'the agent to say it cannot start', 30000);
            check('with no terminal input for plugins, the agent cannot start, says what to set, and opens no terminal for nothing', failed.problem === words && failed.terminal === null
                && failed.detail === `It could not start after DSH restarted: ${words} It is tried again the next time DSH starts; Start again tries now.`, json({ problem: failed.problem, detail: failed.detail, terminal: failed.terminal }));
            check('it stays meant to run, so the next start of DSH tries again', failed.wanted === 'running', failed.wanted);
            return;
        }
        await waitAgent(agents.app, (a) => a.status === 'idle' && a.ready, 'the agent to be back', 40000);
        if (window) {
            await signInAgain();
            await rowOf(window.page, ids.app).click();
            await terminalShows(window.page, 'Resumed conversation', 30000);
        }
        const item = await send(agents.app, 'Typed the other way #work=100');
        const proven = await waitDelivery(agents.app, item.id, ['delivered'], 'the message typed the other way', 30000);
        const marks = await api('marks');
        const mark = marks.value.agents.find((m) => m.key === agents.app);
        check('typed through DSH\'s terminal input, and proven', proven.way === 'attached' && mark.controlTakenAt > 0, json({ proven, controlTakenAt: mark?.controlTakenAt }));
        if (window) {
            const page = window.page;
            // The window takes its keyboard back: a key typed in the tab reaches the agent's input line.
            await waitFor(async () => {
                await page.locator('.xterm-screen:visible').first().click();
                await page.keyboard.type('z');
                const shown = await screen(agents.app);
                return /› z+\s*$/.test(shown.split('\n').filter((l) => l.trim()).at(-1) ?? '') ? true : null;
            }, 'the tab to take its keyboard back', 20000, 1500);
            check('the tab took its keyboard back: a key typed there reaches the agent', true);
            await page.keyboard.press('Backspace');
            for (let i = 0; i < 12; i += 1) await page.keyboard.press('Backspace');
        }
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-attached');
    });

    // ── A wrong setting ────────────────────────────────────────────────
    await step('a wrong setting: no agent runs, each says why, and the page says which setting; saving a good one brings them back', async () => {
        await restartWith(rowsWith({ at: { proofSeconds: 1 } }), 'a wrong setting');
        await waitFor(async () => (await api('state')).ok, 'Agent Terminals with a wrong setting', 30000);
        const s = await state();
        check('it starts and says which setting is wrong and what it must be', s.problem?.key === 'proofSeconds' && /Seconds without proof before Enter is pressed again/.test(s.problem?.text ?? '') && /\b2\b.*\b120\b/.test(s.problem?.text ?? ''), json(s.problem));
        const app = s.agents.find((a) => a.key === agents.app);
        check('no agent runs, and each says why', app?.status === 'stopped' && app.detail === 'Not running: Agent Terminals waits for a setting to be fixed (see the top of this page), then picks it up again.', json({ status: app?.status, detail: app?.detail }));
        const refused = await api('start', { input: { program: 'standin', style: 'flags', folder: ws.app } });
        check('a start is refused, and says where to look', refused.ok === false && refused.error?.message === 'Agent Terminals is waiting for a setting to be fixed: see the top of its page.', json(refused));
        if (!window) return;
        await signInAgain();
        const page = await openAgents();
        const header = page.locator('[data-agent-terminals-header="problem"]');
        await header.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await header.innerText()).replace(/\n+/g, ' ');
        check('the page says which setting, what it must be, and offers its settings', /Agent Terminals is waiting for a setting to be fixed\./.test(words) && /Seconds without proof before Enter is pressed again/.test(words), words);
        await shot(page, shots, 'wrong-setting-light');
        await header.getByRole('button', { name: /settings/i }).first().click();
        const form = page.locator('[data-suite-settings="dsh-plugin-agent-terminals"]');
        await form.waitFor({ state: 'visible', timeout: 20000 });
        await form.getByLabel('Seconds without proof before Enter is pressed again', { exact: true }).fill('3');
        await form.getByRole('button', { name: 'Save' }).click();
        await waitFor(async () => !(await state()).problem, 'the setting to be fixed', 15000, 300);
        const back = await waitAgent(agents.app, (a) => a.status === 'idle' && a.ready, 'the agent to come back once it is fixed', 40000);
        check('saved: the problem is gone and the agents come back, resuming', back.terminal?.state === 'running' && shows(await screen(agents.app), 'Resumed conversation'), json({ status: back.status }));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-wrong-setting');
    });

    await step('a private folder and files', async () => {
        const dir = join(run.home, 'agent-terminals');
        check('its folder is 700 and its files 600', modeOf(dir) === 0o700 && modeOf(join(dir, 'state.json')) === 0o600 && modeOf(join(dir, 'events.jsonl')) === 0o600,
            `${modeOf(dir).toString(8)} ${modeOf(join(dir, 'state.json')).toString(8)} ${modeOf(join(dir, 'events.jsonl')).toString(8)}`);
    });

    // ── Session Watch off, and switched off ────────────────────────────
    await window?.browser?.close().catch(() => {});
    window = undefined;
    await step('Session Watch off in the profile: Agent Terminals loads but does nothing, and its page says what it needs', async () => {
        await restartWith(rowsWith({ off: ['session-watch'] }), 'Session Watch off');
        const r = await api('state');
        check('its endpoints are not there while Session Watch is off (it waits for it)', r.ok === false, json(r).slice(0, 300));
        check('DSH reports no failure for it', !/agent-terminals[^\n]*(fail|error)/i.test(run.logText()), run.logText().split('\n').filter((l) => /agent-terminals/.test(l)).slice(-5).join('\n'));
        if (!pw) return;
        const page = await openAgents();
        const trouble = page.locator('[data-suite-trouble="watch-off"]');
        await trouble.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await trouble.innerText()).replace(/\n+/g, ' ');
        check('the page says Agent Terminals needs Session Watch, and what to do', /^Agent Terminals needs Session Watch, which is not running\. Switch Session Watch on in Plugins\./.test(words) && !/404|HTTP|transport/.test(words), words);
        await shot(page, shots, 'watch-off-light');
        await setDark(page, true);
        await shot(page, shots, 'watch-off-dark');
        await setDark(page, false);
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-watch-off');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    await step('enabled: false: Agent Terminals starts and types nothing, and its page says so and how to change it', async () => {
        await restartWith(rowsWith({ at: { enabled: false } }), 'enabled: false');
        await waitFor(async () => (await api('state')).ok, 'Agent Terminals with enabled: false', 30000);
        const s = await state();
        check('with enabled: false it is loaded but idle', s.enabled === false && !s.problem, json({ enabled: s.enabled, problem: s.problem }));
        const refused = await api('start', { input: { program: 'standin', style: 'flags', folder: ws.app } });
        check('its actions say it is switched off', refused.ok === false && refused.error?.message === 'Agent Terminals is switched off in DSH\'s profile (enabled: false), so it starts and types nothing.', json(refused));
        const app = await agentOf(agents.app);
        check('no agent was started', !app || app.status === 'stopped', json(app?.status));
        if (!pw) return;
        const page = await openAgents();
        const header = page.locator('[data-agent-terminals-header="off"]');
        await header.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await header.innerText()).replace(/\n+/g, ' ');
        check('the page says it is switched off and how to change it', words.includes('Agent Terminals is switched off in DSH\'s profile (enabled: false in its entry in cordis.patch.yml), so it starts, reads and types nothing. To use it, set enabled to true there and restart DSH.'), words);
        await shot(page, shots, 'disabled-light');
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-disabled');
    });
    check('no errors from the suite in the window', suiteErrors().length === 0, suiteErrors().join('\n'));
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
    if (window?.page) await shot(window.page, shots, 'failed').catch(() => {});
} finally {
    await window?.browser?.close().catch(() => {});
    await run.stop();
    const left = endOurs();
    if (left) console.log(`# ended ${left} process(es) this run started that DSH left running`);
    await model.close();
    const warnings = run.logText().split('\n').filter((line) => /agent-terminals|session-watch/i.test(line) && /warn|error|fail/i.test(line));
    if (warnings.length) console.log(`# DSH said about the suite:\n${warnings.slice(-20).map((l) => `#   ${l}`).join('\n')}`);
    run.cleanup();
}
console.log(`\n# DSH ${version}: ${tally.passed} passed, ${tally.failed} failed${pw ? '' : ', window checks skipped (no Playwright)'}`);
process.exit(tally.failed ? 1 : 0);
