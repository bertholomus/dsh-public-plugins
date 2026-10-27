#!/usr/bin/env node
/**
 * Recall in a real DSH: real sessions, made by a scripted model, indexed as
 * they happen; synthetic coding-agent transcripts and handoff notes in
 * folders its settings name; searched from its page and by an agent with
 * the recall_search tool; and a result opened at its exact turn in a real
 * window.
 *
 * DSH runs from a throwaway DSH_HOME (test/e2e/harness.mjs) with the session
 * bridge, Session Watch and Recall, and a scripted model (./fake-model.mjs)
 * that plays the agent. Every transcript and note here is written by this
 * test; no real session is read.
 *
 * - The browser half is served and parses; the endpoints answer, and refuse
 *   bad input in words.
 * - Indexing: every turn of a 40-turn session, a word in a request, a reply
 *   and a command, each found at its turn with DSH's own seq for it; a
 *   transcript turn and a note section with their file and line; a new turn
 *   found seconds after it ends; a transcript that grew read from where it
 *   ended; a deleted one taken out.
 * - Filters: kind, folder, model and time, and newest first.
 * - How each turn ended: a turn is "still running" only while DSH runs it;
 *   stopped from the chat it reads "stopped", and why; one DSH was running
 *   when it crashed reads "cut off by a restart", in the API, the rows and
 *   the reading view.
 * - The tool: an agent searches, reads a turn in full (marked as a record,
 *   not instructions), and a call with no words is refused in words; the
 *   turn that asks is left out of what it finds.
 * - The window: the page (newest turns first, then a search), a result that
 *   opens the long session at turn 2 (which DSH's first page of it does not
 *   hold), marked "Found by Recall", the turn's rows marked and brought to
 *   the top; Back to the results keeps the search; Done takes the marks off;
 *   the filters; the reading view for a transcript and a note; the tool's
 *   card in the agent's chat and its Open, then Back to the results (the
 *   card's search) and Back to the chat; a running turn's row that follows
 *   it to "stopped" with no new search, and the line above the message box
 *   when it is opened while it runs (the mark takes over when it is stopped
 *   there); the index card, a folder that is
 *   not there, Look for changes now; a narrow window; light and dark; focus
 *   back on the button that opened the reading view after Turn before and
 *   Back; Wallpaper on (a stand-in for it in this window) over a light and a
 *   dark picture at a low tint, and off, light and dark, the small text
 *   measured at 4.5:1; at 420 px the kind switcher inside its row.
 * - Its settings in Plugins (DSH's own form): a folder that is not a full
 *   path refused; a notes folder added, read and searchable; the tool
 *   switched off and on (offered to agents, or not); another DSH's 450
 *   sessions added and taken out, after which the index gives their space
 *   back by itself, What happened says how much and the Index card shows
 *   the new size.
 * - A restart: the index is kept, nothing read again. A crash: the index is
 *   checked and kept.
 * - Recall switched off and on in Plugins: no failure; its entry, marks and
 *   style go and come back.
 * - Without Session Watch, the open page follows new turns and never asks
 *   for Session Watch's endpoint.
 * - Wrong types in the profile (one folder without the brackets, "yes" for a
 *   switch): Recall starts, names the setting and how to write it, refuses
 *   searches and offers no tool.
 * - A wrong setting: Recall starts, refuses searches, offers no tool, and
 *   its page says which setting; fixed through the form.
 * - Its folder is 700 and its files 600. `enabled: false`: idle, its page
 *   says so and What happened says it first; `enabled` saved in the profile
 *   while DSH runs, true then false: applied with no restart, the open page
 *   follows, each switch said once, and the turn made while it was off is
 *   read.
 *
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node plugins/recall/test/e2e/run.mjs
 *
 * Without DSH_BIN it runs the newest DSH under .e2e/; `node scripts/e2e.mjs
 * recall` runs it on each of those and on the installed app's own DSH.
 * SHOTS=<folder> keeps the window's pictures there (default
 * .e2e/shots/recall/<version>); KEEP=1 keeps the throwaway DSH_HOME. Without
 * Playwright the run fails, unless NO_WINDOW=1 says to run without the
 * window checks.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { DshRun, checks, dismissNotices, dshBin, findPlaywright, modeOf, openWindow, pluginsDir, repoRoot, setDark, shot, sleep, waitFor } from '../../../../test/e2e/harness.mjs';
import { startRecallModel } from './fake-model.mjs';
import { writeCorpus } from '../../../../test/fixtures/recall/corpus.mjs';

const bin = dshBin();
if (!bin) {
    console.log('skipped: no DSH to run (set DSH_BIN, or install one under .e2e/dsh-<version>)');
    process.exit(0);
}
const version = process.env.DSH_LABEL || (/dsh-([^/]+)\/node_modules/.exec(bin)?.[1] ?? basename(dirname(dirname(bin))));
const shots = process.env.SHOTS || join(repoRoot, '.e2e', 'shots', 'recall', version);
console.log(`# DSH ${version}: ${bin}`);
console.log(`# pictures: ${shots}`);
// A failed step's picture from an earlier run would say this run failed there too.
try {
    for (const name of readdirSync(shots)) if (/^failed-.*\.png$/.test(name)) rmSync(join(shots, name));
} catch {}

const tally = checks();
const { check, step } = tally;
const model = await startRecallModel();
const json = (value) => JSON.stringify(value);

const run = new DshRun({
    label: 'recall',
    bin,
    plugins: {
        'dsh-plugin-session-bridge': join(pluginsDir, 'session-bridge'),
        'dsh-plugin-session-watch': join(pluginsDir, 'session-watch'),
        'dsh-plugin-recall': join(pluginsDir, 'recall'),
    },
});

// ── Synthetic transcripts and notes, in folders the settings name ────────
const AGENT_LOGS = join(run.root, 'agent-logs');
const GONE = join(run.root, 'unplugged-disk', 'logs');
const NOTES = join(run.root, 'notes');
const MORE_NOTES = join(run.root, 'more-notes');
/** Written by the notes step (after the first counts): a 601-section daily log and a run log past 4 MB. */
const DAILY = join(NOTES, 'daily-log.md');
const BIG_LOG = join(NOTES, 'run-log.md');
const DAY = 86_400_000;
const old = (days, minutes = 0) => new Date(Date.now() - days * DAY + minutes * 60_000).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
const say = (role, text, at, extra = {}) => line({ type: role, timestamp: at, cwd: '/work/parser', sessionId: 'parser-run-1', message: { role, content: text, ...(role === 'assistant' ? { model: 'glm-transcript' } : {}) }, ...extra });
const RUN_1 = join(AGENT_LOGS, 'parser-work', 'run-1.jsonl');
const RUN_2 = join(AGENT_LOGS, 'parser-work', 'run-2.jsonl');
mkdirSync(dirname(RUN_1), { recursive: true });
writeFileSync(RUN_1, [
    say('user', 'Please migrate the ledger schema to version 7.', old(40)),
    line({ type: 'assistant', timestamp: old(40, 1), cwd: '/work/parser', message: { role: 'assistant', model: 'glm-transcript', content: [{ type: 'tool_use', name: 'bash', input: { command: 'make migrate-ledger' } }, { type: 'text', text: 'Migrated the ledger schema.' }] } }),
    say('user', 'The xylophone parser fails on nested quotes.', old(40, 5)),
    say('assistant', 'Fixed the xylophone tokenizer: **nested quotes** are read now, in `readQuoted`.', old(40, 6)),
].join(''));
writeFileSync(RUN_2, [
    say('user', 'Rename the okapi helper.', old(39)),
    say('assistant', 'Renamed the okapi helper.', old(39, 1)),
].join(''));
mkdirSync(NOTES, { recursive: true });
writeFileSync(join(NOTES, 'HANDOFF.md'), `# Gateway handoff

Updated by the gateway team.

## Done

- Moved the gateway to the new cluster.

## Next steps

1. Rotate the quokka certificates before Friday.
2. Watch the error dashboards.
`);
mkdirSync(MORE_NOTES, { recursive: true });
writeFileSync(join(MORE_NOTES, 'plan.md'), '# Storage plan\n\n## Open questions\n\nShould the wombat backups move to the new volume?\n');
// Another DSH's home with 450 synthetic sessions (some 5,000 turns, many MB of index): added in the form and taken out.
const OTHER_DSH = join(run.root, 'other-dsh');
const OTHER_WORD = 'ptarmigan';
const OTHER = writeCorpus(join(OTHER_DSH, 'sessions'), { sessions: 450, seed: 11, now: Date.now(), rare: [{ session: 7, turn: 2, word: OTHER_WORD }] });

/** The profile's rows: new sessions on Workspace Write, Session Watch, and Recall's settings. */
const rowsWith = ({ recall = {}, off = [] } = {}) => `- id: permission
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
- id: recall
  config:
${Object.entries({ transcriptFolders: [AGENT_LOGS, GONE], handoffFolders: [NOTES], ...recall }).map(([key, value]) => `    ${key}: ${json(value)}`).join('\n')}
`;
run.rows = rowsWith();

async function restartWith(rows, what) {
    await run.stop();
    run.rows = rows;
    run.writeProfile(model.port);
    await run.boot(what);
}

const api = (method, args = {}) => run.api(`dsh-plugin-recall/${method}`, args);
const value = async (method, args) => {
    const r = await api(method, args);
    if (!r.ok) throw new Error(`${method}: ${json(r.error)}`);
    return r.value;
};
const pageState = () => value('state');
const search = (query) => value('search', { query: { limit: 20, ...query } });
const turnsEnded = (sessionId, n, timeout = 30000) => waitFor(async () => {
    const s = await run.session(sessionId);
    return s.status !== 'running' && s.turns.ended >= n && s.turns.started === s.turns.ended ? s : null;
}, `${sessionId} to finish turn ${n}`, timeout);
const prompt = async (sessionId, text, n) => {
    await run.bridge('POST', `/sessions/${encodeURIComponent(sessionId)}/prompt`, { text });
    await turnsEnded(sessionId, n);
};
const tall = (lines, text) => `E2E:tall ${lines} ${text}`;
const sayText = (text) => `E2E:say ${text}`;
const turnScript = (calls, reply) => `E2E:turn ${json({ calls, reply })}`;
/** A turn's start seq, from DSH's own events (by its number when the event has one, else the nth start). */
async function seqOf(sessionId, turn) {
    const starts = (await run.events(sessionId)).filter((e) => e.type === 'turn/start');
    return (starts.find((e) => (e.data?.turn ?? e.turn) === turn) ?? starts[turn - 1])?.seq;
}
/** Wait until a search finds something (the index reads a moment after DSH writes). */
const found = (query, what, timeout = 30000, test = (r) => r.results.length > 0) => waitFor(async () => {
    const r = await search(query);
    return test(r) ? r : null;
}, what, timeout, 300);
const historyHas = async (pattern) => (await pageState()).history.some((e) => pattern.test(`${e.text} ${e.why ?? ''}`));
/** The index once it has caught up with what DSH wrote (it reads a session 1.5 s after its events): two reads 2 s apart agree. */
const settledIndex = () => waitFor(async () => {
    const a = (await pageState()).index;
    await sleep(2000);
    const b = (await pageState()).index;
    return a && b && !a.busy && !b.busy && a.totals.turns === b.totals.turns && a.totals.files === b.totals.files ? b : null;
}, 'the index to catch up', 40000, 100);
/** The long session's turn 2 among the results for "narwhal" (the agent's session that searched for it matches too). */
const narwhalTurn = async () => (await search({ text: 'narwhal' })).results.find((r) => r.sessionId === ids.long);
const offeredTool = (anchorWords) => model.requests.filter((r) => r.anchor.includes(anchorWords)).map((r) => r.tools.includes('recall_search'));

const ours = (errors) => errors.filter((text) => /recall|session-watch|suite-kit/i.test(text));

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
        if (alpha === 255 || (ground && node.matches('[data-recall-page]'))) break;
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
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const [hi, lo] = [lum(text), lum(back)].sort((a, b) => b - a);
    return { word: (el.textContent ?? '').trim().slice(0, 40), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 };
}, ground ?? null);
/** The lowest contrast among every element a locator matches, how many it measured, and the three lowest. */
const lowestContrast = async (locator, options) => {
    const all = [];
    for (let i = 0; i < await locator.count(); i += 1) {
        const x = await contrastOf(locator.nth(i), options);
        all.push({ ...x, kind: await locator.nth(i).evaluate((el) => [...el.classList].filter((c) => c.startsWith('dshrc-')).join('.') + (el.getAttribute('data-tone') ? `[${el.getAttribute('data-tone')}]` : '')) });
    }
    all.sort((a, b) => a.ratio - b.ratio);
    return { count: all.length, ratio: all[0]?.ratio ?? 0, word: all[0]?.word ?? '', low: all.slice(0, 3).map((x) => `${x.kind} ${x.ratio}`) };
};
/** The small text people read on Recall's page: lines under titles, snippets, counts, why lines, state words. */
const SMALL_TEXT = ['sub', 'meta', 'snippet', 'asked', 'count', 'others', 'status', 'why', 'note', 'tag'].map((c) => `[data-recall-page] .dshrc-${c}`).join(', ');
/** Pictures for the Wallpaper stand-in: a light one and a dark one. */
const PICTURES = {
    light: 'radial-gradient(circle at 20% 25%,#fde68a 0,transparent 40%),radial-gradient(circle at 80% 70%,#bae6fd 0,transparent 45%),linear-gradient(135deg,#f5f0e6,#dde7ee)',
    dark: 'radial-gradient(circle at 25% 30%,#1d4ed8 0,transparent 40%),radial-gradient(circle at 75% 70%,#9d174d 0,transparent 45%),linear-gradient(135deg,#0b1020,#1f2937)',
};
/** A stand-in for the Wallpaper plugin, in this test window only: its public values on <body>, a picture behind DSH, DSH's frame clear. */
const wallpaperOn = (page, picture, tint) => page.evaluate(({ picture, tint }) => {
    const b = document.body;
    b.classList.add('wp-on');
    b.style.setProperty('--wp-blur', '22px');
    b.style.setProperty('--wp-tint', String(tint));
    let wall = document.getElementById('test-wall');
    if (!wall) {
        wall = document.createElement('div');
        wall.id = 'test-wall';
        document.body.prepend(wall);
        const style = document.createElement('style');
        style.id = 'test-wall-style';
        style.textContent = 'body.wp-on #root{position:relative;z-index:1}'
            + 'body.wp-on [class*="_frame"],body.wp-on [class*="_centerCol"],body.wp-on [class*="_sidebarCol"],body.wp-on [class*="_rightbarCol"],'
            + 'body.wp-on [data-slot="main"],body.wp-on [data-slot="main.conversation"]>div{background:transparent!important;border:0!important;box-shadow:none!important}';
        document.head.append(style);
    }
    wall.style.cssText = `position:fixed;inset:0;z-index:0;background:${picture}`;
}, { picture, tint });
const wallpaperOff = (page) => page.evaluate(() => {
    document.body.classList.remove('wp-on');
    document.body.style.removeProperty('--wp-blur');
    document.body.style.removeProperty('--wp-tint');
    document.getElementById('test-wall')?.remove();
    document.getElementById('test-wall-style')?.remove();
});

let window;
let pw;
const ids = {};
const timings = {};
try {
    run.writeProfile(model.port);
    await run.boot('first start');
    await waitFor(async () => (await api('state')).ok && (await pageState()).thread.state === 'running', 'Recall\'s index thread', 60000);

    // ── The browser half and the endpoints ─────────────────────────────
    await step('DSH serves Recall\'s browser half and it parses', async () => {
        const client = await run.clientOf('dsh-plugin-recall');
        let parses = false;
        try {
            new Script(client.text);
            parses = true;
        } catch {}
        check('DSH serves Recall\'s browser half and it parses, with its page, its mark on a turn and its tool card',
            client.status === 200 && parses && client.text.includes('conversation.chat.turnTail') && client.text.includes('tool.call.toolview'), `${client.url ?? 'not in the boot graph'}: ${client.status}`);
    });
    await step('the endpoints answer, and refuse bad input in words', async () => {
        const s = await waitFor(async () => {
            const now = await pageState();
            return now.index && !now.index.busy && now.index.roots.every((r) => r.state !== 'waiting') ? now : null;
        }, 'the first read of every folder', 30000, 300);
        const kinds = s.index.roots.map((r) => `${r.kind}:${r.own ? 'own' : r.root === GONE ? 'gone' : 'folder'}:${r.state}`).sort();
        check('the state endpoint answers: on, its index running, searching this DSH\'s sessions, the transcript and note folders, and one not there',
            s.enabled === true && !s.problem && s.tool === true && s.thread.state === 'running'
            && json(kinds) === json(['handoff:folder:ok', 'session:own:ok', 'transcript:folder:ok', 'transcript:gone:missing']), json({ enabled: s.enabled, thread: s.thread, kinds }));
        check('it has read the transcripts and the note: 3 transcript turns and 3 note sections', s.index.roots.find((r) => r.kind === 'transcript' && r.root === AGENT_LOGS)?.turns === 3
            && s.index.roots.find((r) => r.kind === 'handoff')?.turns === 3, json(s.index.roots));
        const badId = await api('turn', { id: 'not-an-id' });
        const badTime = await api('search', { query: { text: 'ledger', since: 'someday' } });
        check('bad input is refused with words a person can act on', badId.ok === false && badId.error?.message === 'Name a result by its id, such as 12.4.'
            && badTime.ok === false && /"someday" is not a time Recall can read: write a date such as 2026-10-01, or today, yesterday, 7d, week, month or year/.test(badTime.error?.message ?? ''), json([badId.error, badTime.error]));
    });

    // ── Real sessions, indexed as they happen ──────────────────────────
    const started = Date.now();
    ids.long = await run.newSession(`Turn 1: set up the export service.\n${tall(14, 'Turn 1 done: the export service is set up.')}`, 'Long session');
    await turnsEnded(ids.long, 1);
    await prompt(ids.long, `Turn 2: wire the narwhal exporter.\n${tall(14, 'Turn 2 done: the exporter is wired.')}`, 2);
    for (let n = 3; n <= 40; n += 1) await prompt(ids.long, `Turn ${n}: routine step ${n} of the export work.\n${tall(14, `Turn ${n} done: routine step ${n} finished.`)}`, n);
    ids.deploy = await run.newSession(`Deploy the gateway to staging.\n${turnScript([{ tool: 'bash', args: { command: 'echo pelican-checksum', description: 'Check the release checksum' } }], 'Deployed the gateway to staging.')}`, 'Gateway deploy');
    await turnsEnded(ids.deploy, 1);
    await prompt(ids.deploy, `Check the canary dashboards.\n${sayText('The canary dashboards look healthy.')}`, 2);
    await prompt(ids.deploy, `Roll back if errors climb.\n${sayText('Rolled back the canary to build 41.')}`, 3);
    console.log(`# made 43 turns in ${Math.round((Date.now() - started) / 1000)} s`);

    await step('every turn of the real sessions is indexed, and a word in a request is found at its exact turn', async () => {
        const r = await found({ text: 'narwhal' }, 'the narwhal turn', 30000);
        const hit = r.results[0];
        const seq = await seqOf(ids.long, 2);
        check('a word in a person\'s request is found at its turn: the session, turn 2, and DSH\'s own seq for its start',
            r.total === 1 && hit.kind === 'session' && hit.own === true && hit.sessionId === ids.long && hit.turn === 2 && Number.isInteger(seq) && hit.seq === seq && hit.title === 'Long session',
            json({ total: r.total, hit, seq }));
        check('the turn knows its folder (the session\'s workspace) and the model that answered', /\/ws$/.test(hit.folder ?? '') && hit.model === 'fake-model', json({ folder: hit.folder, model: hit.model }));
        ids.wsFolder = hit.folder;
        const all = await found({ text: '', kind: 'session', limit: 50 }, 'all 43 turns', 30000, (x) => x.total >= 43);
        check('one row per turn: 43 turns from the two sessions', all.total === 43 && all.sessions === 2, json({ total: all.total, sessions: all.sessions }));
        const step30 = await search({ text: '"routine step 30"' });
        check('each of the 40 turns is its own result: "routine step 30" is turn 30', step30.results[0]?.turn === 30 && step30.results[0]?.sessionId === ids.long, json(step30.results.map((x) => x.turn)));
    });
    await step('words in replies and commands are found too, with the other turns that match', async () => {
        const canary = await search({ text: 'canary' });
        const top = canary.results[0];
        check('a word in two replies of one session: one result, its best turn, and the other turn that matches', canary.results.length === 1 && top?.sessionId === ids.deploy && top.hits === 2
            && [2, 3].includes(top.turn) && top.others.length === 1 && [2, 3].includes(top.others[0].turn) && top.others[0].turn !== top.turn, json(canary.results));
        const pelican = await search({ text: 'pelican' });
        check('a word in a command the turn ran is found at that turn', pelican.results[0]?.sessionId === ids.deploy && pelican.results[0]?.turn === 1, json(pelican.results));
        check('a result carries a snippet with the hit marked, and what was asked', /\u0002canary\u0003/i.test(top?.snippet ?? '') && typeof top?.asked === 'string' && top.asked.length > 0, json({ snippet: top?.snippet, asked: top?.asked }));
    });
    await step('transcripts and notes: a transcript turn and a note section, with their file and line', async () => {
        const x = await search({ text: 'xylophone' });
        const t = x.results[0];
        check('a transcript turn: kind, file, line, turn, model and folder', x.total === 1 && t.kind === 'transcript' && t.path === RUN_1 && t.turn === 2 && t.line === 3 && t.model === 'glm-transcript' && t.folder === '/work/parser', json(t));
        const q = await search({ text: 'quokka' });
        const n = q.results[0];
        check('a note section: its heading and line', q.total === 1 && n.kind === 'handoff' && n.label === 'Next steps' && n.title === 'Gateway handoff' && n.line === 9 && n.path === join(NOTES, 'HANDOFF.md'), json(n));
        const turn = await value('turn', { id: t.id });
        check('a transcript turn reads in full: what was asked, the reply, the turn after none', turn.prompt === 'The xylophone parser fails on nested quotes.' && /Fixed the xylophone tokenizer/.test(turn.reply) && turn.prev === 1 && turn.next === undefined && turn.count === 2, json(turn));
    });
    await step('a note of 601 sections is searched to its last; one past 4 MB keeps its first 1 MB and last 3 MB, and says so', async () => {
        // A daily log with a heading a day (round 3: sections past the 400th dropped without a word).
        writeFileSync(DAILY, `# Daily log\n\n${Array.from({ length: 601 }, (_, i) => `## Day ${i}\nEntry ${i}: ${i === 600 ? 'the manatee survey' : i === 450 ? 'the axolotl tank' : 'a quiet day'}\n`).join('\n')}`);
        // A run log past 4 MB that grows at the bottom: its first entry, its middle and its newest.
        const lines = ['# Run log', '', '## First run', 'The gecko build started.', ''];
        let bytes = lines.join('\n').length;
        const fill = (upTo) => {
            // The same few words on every line: a small index, so the later checks of the index's size hold.
            const text = 'another step of the long run went fine';
            while (bytes < upTo) {
                lines.push(text);
                bytes += text.length + 1;
            }
        };
        // Its middle, between its first 1 MB and its last 3 MB, is the part that is not read.
        fill(1.5 * 1048576);
        lines.push('', '## Middle run', 'The chinchilla build stalled.', '');
        fill(5 * 1048576);
        const newestLine = lines.length + 2;
        lines.push('', '## Newest run', 'The quetzal build passed.', '');
        writeFileSync(BIG_LOG, lines.join('\n'));
        await api('rescan');
        const manatee = await found({ text: 'manatee' }, 'the daily log\'s 601st section', 30000);
        const axolotl = await search({ text: 'axolotl' });
        check('every section of a 601-section note is searched: the last at its heading and line, and the 451st',
            manatee.total === 1 && manatee.results[0].label === 'Day 600' && manatee.results[0].line === 1803 && axolotl.results[0]?.label === 'Day 450', json([manatee.results[0], axolotl.results[0]]));
        const quetzal = await found({ text: 'quetzal' }, 'the big log\'s newest section', 30000);
        const gecko = await search({ text: 'gecko' });
        const chinchilla = await search({ text: 'chinchilla' });
        check('a note past 4 MB: its first and its newest sections are found, at their lines; its middle is not',
            quetzal.results[0]?.label === 'Newest run' && quetzal.results[0].line === newestLine && gecko.results[0]?.label === 'First run' && chinchilla.total === 0,
            json({ quetzal: quetzal.results[0], gecko: gecko.results[0], chinchilla: chinchilla.total }));
        const s = await settledIndex();
        const st = await pageState();
        const parts = st.index.problems.filter((p) => p.part).map((p) => [p.path, p.error]);
        const mb = Math.round((statSync(BIG_LOG).size / 1048576) * 10) / 10;
        check('the big log is listed as read in part, with what is searched; the daily log is not, and its folder is up to date',
            parts.some(([path, error]) => path === BIG_LOG && error === `Only its first 1 MB and its last 3 MB are searched (it is ${mb} MB).`) && !parts.some(([path]) => path === DAILY)
            && st.index.roots.find((r) => r.kind === 'handoff')?.state === 'ok' && s.totals.partial >= 1, json({ parts, roots: st.index.roots.filter((r) => r.kind === 'handoff') }));
    });
    await step('filters: kind, folder, model and time; newest first', async () => {
        const kinds = async (query) => [...new Set((await search(query)).results.map((r) => r.kind))].sort().join();
        check('kind: "gateway" is in sessions and a note; each kind alone finds only its own', await kinds({ text: 'gateway' }) === 'handoff,session'
            && await kinds({ text: 'gateway', kind: 'handoff' }) === 'handoff' && await kinds({ text: 'gateway', kind: 'session' }) === 'session');
        check('folder: the sessions\' workspace finds its sessions only; /work/parser the transcripts only', await kinds({ text: 'migrate OR gateway OR narwhal', folder: ids.wsFolder }) === 'session'
            && await kinds({ text: 'migrate OR gateway OR narwhal', folder: '/work/parser' }) === 'transcript');
        check('model: the transcript\'s model finds the transcript only; DSH\'s model the sessions only', await kinds({ text: 'xylophone OR gateway', model: 'glm-transcript' }) === 'transcript'
            && await kinds({ text: 'xylophone OR gateway', model: 'fake-model' }) === 'session');
        check('time: the 40-day-old transcript is not in the past month, and is in the past year', (await search({ text: 'xylophone', since: 'month' })).total === 0 && (await search({ text: 'xylophone', since: 'year' })).total === 1);
        const newest = (await search({ text: 'gateway OR canary OR xylophone OR quokka', sort: 'newest' })).results;
        check('newest first: the deploy session\'s latest turn, then the note written before it, then the 40-day-old transcript',
            json(newest.map((r) => r.kind)) === json(['session', 'handoff', 'transcript']) && newest.every((r, i) => i === 0 || r.time <= newest[i - 1].time) && newest[0].turn === 3,
            json(newest.map((r) => [r.kind, r.turn, r.time])));
    });
    await step('a new turn is found seconds after it ends; a transcript that grew is read from where it ended; a deleted one is taken out', async () => {
        const asked = Date.now();
        await prompt(ids.deploy, `Look at the pool.\n${sayText('Found the walrus leak in the connection pool.')}`, 4);
        const r = await found({ text: 'walrus' }, 'the new turn', 20000);
        timings.newTurn = Date.now() - asked;
        console.log(`# a new turn was searchable ${timings.newTurn} ms after it was asked (the turn itself, DSH's event, 1.5 s of batching, the read)`);
        check('a new turn is found within seconds of its end, at its turn', r.results[0]?.sessionId === ids.deploy && r.results[0]?.turn === 4 && timings.newTurn < 15000, json({ ms: timings.newTurn, hit: r.results[0] }));
        appendFileSync(RUN_1, say('user', 'Why does the zebrafish fixture time out?', old(38)) + say('assistant', 'The zebrafish fixture waited on a closed socket.', old(38, 1)));
        const rescan = await api('rescan');
        const z = await found({ text: 'zebrafish' }, 'the grown transcript', 15000);
        check('Look for changes now reads the grown transcript from where it ended: the new turn, at its line', rescan.ok && z.results[0]?.kind === 'transcript' && z.results[0].turn === 3 && z.results[0].line === 5, json(z.results[0]));
        rmSync(RUN_2);
        await api('rescan');
        const gone = await found({ text: 'okapi' }, 'the deleted transcript to go', 15000, (x) => x.total === 0);
        check('a deleted transcript\'s turns are taken out', gone.total === 0);
    });

    // ── How a turn ended: running by DSH's word, then stopped from the chat ──
    ids.stopped = await run.newSession('Roll out the stoat release.\nE2E:hang The stoat rollout waits.', 'Stoat rollout');
    await step('a turn is still running only while DSH runs it; stopped from the chat, it says "stopped" and who stopped it', async () => {
        await waitFor(async () => (await run.session(ids.stopped)).status === 'running', 'the stoat turn to start', 20000, 200);
        const running = await found({ text: 'stoat' }, 'the running turn to be read', 20000, (r) => r.results[0]?.state === 'running');
        check('while DSH runs the turn, it is still running', running.results[0]?.sessionId === ids.stopped && running.results[0].running === true, json(running.results[0]));
        await run.bridge('POST', `/sessions/${encodeURIComponent(ids.stopped)}/cancel`, {});
        await turnsEnded(ids.stopped, 1);
        const stopped = await found({ text: 'stoat' }, 'the turn to read as stopped', 20000, (r) => r.results[0]?.state === 'stopped');
        const turn = await value('turn', { id: stopped.results[0].id });
        check('stopped from the chat: "stopped", from the chat as DSH logged it, never running again',
            stopped.results[0].sessionId === ids.stopped && stopped.results[0].running === false && stopped.results[0].why === 'user' && turn.state === 'stopped' && turn.why === 'user', json({ hit: stopped.results[0], state: turn.state, why: turn.why }));
    });

    // ── The window ─────────────────────────────────────────────────────
    pw = await findPlaywright();
    if (!pw) check('Playwright is here for the window checks (NO_WINDOW=1 runs without them)', process.env.NO_WINDOW === '1', 'install it: npm i --prefix .e2e/tools playwright-core (or set PLAYWRIGHT_MODULE)');
    const openRecall = async (page) => {
        // DSH's own first-run notice can come late, over the whole window (the app's DSH showed its Preview Notice
        // after the window had been calm for 4 s): put it away, and again if the click meets it.
        await dismissNotices(page);
        const entry = page.getByRole('button', { name: 'Recall', exact: true }).first();
        await entry.click({ timeout: 5000 }).catch(async () => {
            await dismissNotices(page);
            await entry.click();
        });
        await page.locator('[data-recall-page]').waitFor({ state: 'visible', timeout: 20000 });
    };
    const searchBox = (page) => page.getByRole('searchbox', { name: 'Search past work' });
    /** Type a search and press Enter; then wait until the page lists what the index answers for it (the same first result and count). */
    const searchFor = async (page, text, { total } = {}) => {
        await searchBox(page).fill(text);
        await searchBox(page).press('Enter');
        const want = await search({ text, prefix: true });
        if (total !== undefined && want.total !== total) throw new Error(`“${text}”: the index has ${want.total} matching turns, not ${total}: ${json(want.results.map((r) => [r.title, r.turn]))}`);
        const first = want.results[0] ? `${want.results[0].file}.${want.results[0].turn}` : null;
        await waitFor(async () => {
            const count = page.locator('[data-recall-count]');
            if (!(await count.count())) return false;
            if (/searching/.test((await count.textContent()) ?? '')) return false;
            if ((await count.getAttribute('data-recall-count')) !== String(want.total)) return false;
            return (await page.locator('[data-recall-result]').first().getAttribute('data-recall-id')) === first;
        }, `the results for “${text}”`, 15000, 200);
    };
    /** Where turn n's first row is in its chat: marked, and how far below the chat's top. */
    const turnPlace = (page, n) => page.evaluate((turn) => {
        const rows = [...document.querySelectorAll(`[data-chat-turn="${turn}"]`)];
        const row = rows[0];
        let el = row?.closest('[data-chat-flow]')?.parentElement;
        while (el && el !== document.body && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)) el = el.parentElement;
        const view = el && el !== document.body ? el.getBoundingClientRect() : { top: 0, height: window.innerHeight };
        const box = row?.getBoundingClientRect();
        return {
            rows: rows.length,
            marked: rows.filter((r) => r.hasAttribute('data-recall-found')).length,
            anyMarked: document.querySelectorAll('[data-recall-found]').length,
            offset: box ? Math.round(box.top - view.top) : null,
            height: Math.round(view.height),
            turns: new Set([...document.querySelectorAll('[data-chat-turn]')].map((r) => r.getAttribute('data-chat-turn'))).size,
        };
    }, n);
    if (pw) {
        await step('the page: the newest turns first, then a search as you type', async () => {
            window = await openWindow(run, pw, { entry: 'Recall' });
            const { page } = window;
            await openRecall(page);
            const line = (await page.locator('[data-recall-index-line]').textContent()) ?? '';
            const held = (await pageState()).index.totals;
            const sections = held.sections ?? 0;
            const many = (n) => n.toLocaleString('en-US');
            const heldWords = `${many(held.turns - sections)} turn${held.turns - sections === 1 ? '' : 's'}${sections ? ` and ${many(sections)} note section${sections === 1 ? '' : 's'}` : ''}`;
            check('the header says what Recall holds, turns and note sections apart, and that it is up to date',
                sections > 0 && line === `Recall has ${heldWords} from ${held.files} sessions and files. Up to date.`, `${line} | ${json(held)}`);
            await page.locator('[data-recall-result]').first().waitFor({ state: 'visible', timeout: 15000 });
            const first = (await page.locator('[data-recall-count]').textContent()) ?? '';
            check('with nothing typed, the newest turns are listed', /^The newest turns first\./.test(first) && (await page.locator('[data-recall-result]').count()) > 0, first);
            await shot(page, shots, 'page-light');
            await setDark(page, true);
            await shot(page, shots, 'page-dark');
            await setDark(page, false);
            await searchFor(page, 'narwhal', { total: 1 });
            const count = (await page.locator('[data-recall-count]').textContent()) ?? '';
            const row = page.locator('[data-recall-result]').first();
            const rowText = (await row.innerText()).replace(/\n+/g, ' ');
            check('a search as you type: one matching turn, its session, where and when, the hit marked, and what was asked',
                /^1 matching turn in 1 session or file · (<1|\d+) ms$/.test(count) && rowText.startsWith('Long session') && /Session · .+ · fake-model · turn 2/.test(rowText)
                && (await row.locator('mark').first().textContent())?.toLowerCase() === 'narwhal', `${count} | ${rowText}`);
            check('no ids or tool names where people read', !/recall_search|\b\d+\.\d+\b/.test(rowText) && !rowText.includes(ids.long), rowText);
            await shot(page, shots, 'results-light');
            await setDark(page, true);
            await shot(page, shots, 'results-dark');
            await setDark(page, false);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-page');
        });

        await step('a result opens its session at the exact turn: marked, brought to the top, and DSH\'s first page did not hold it', async () => {
            const { page } = window;
            // The newest turn first, as DSH opens a session: its first page does not reach turn 2.
            await searchFor(page, '"routine step 40"', { total: 1 });
            await page.locator('[data-recall-open]').first().click();
            await page.locator('[data-recall-mark]').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20000 });
            const tail = await turnPlace(page, 2);
            console.log(`# DSH's first page of the 40-turn session showed ${tail.turns} turns`);
            check('DSH opens the 40-turn session at its newest turns: turn 2 is not in the chat, so a jump to it must load it', tail.rows === 0 && tail.turns > 0, json(tail));
            await page.getByRole('button', { name: 'Done: take the mark off this turn' }).first().click();
            await openRecall(page);
            await searchFor(page, 'narwhal', { total: 1 });
            await page.locator('[data-recall-open]').first().click();
            const mark = page.locator('[data-recall-mark]').filter({ visible: true }).first();
            await mark.waitFor({ state: 'visible', timeout: 20000 });
            const markText = (await mark.innerText()).replace(/\n+/g, ' ');
            check('the turn gets Recall\'s mark: Found by Recall, the turn and the words, the way back and Done',
                /Found by Recall · turn 2, for “narwhal”/.test(markText) && /Back to the results/.test(markText) && /Done/.test(markText), markText);
            const place = await waitFor(async () => {
                const p = await turnPlace(page, 2);
                return p.marked > 0 && p.offset !== null && p.offset >= 0 && p.offset <= 160 ? p : null;
            }, 'turn 2 to be marked and at the top of the chat', 10000, 200).catch(() => turnPlace(page, 2));
            check('turn 2\'s rows are marked and its first row is at the top of the chat', place.marked > 0 && place.marked === place.rows && place.offset >= 0 && place.offset <= 160, json(place));
            check('the person sees turn 2\'s request', (await page.getByText('Turn 2: wire the narwhal exporter.').filter({ visible: true }).count()) > 0, json(place));
            check('only turn 2 is marked', place.anyMarked === place.marked, json(place));
            await shot(page, shots, 'jump-light');
            await setDark(page, true);
            await shot(page, shots, 'jump-dark');
            await shot(page, shots, 'mark-dark', mark);
            await setDark(page, false);
            await shot(page, shots, 'mark-light', mark);
            await mark.getByRole('button', { name: 'Back to the results' }).click();
            await page.locator('[data-recall-page]').waitFor({ state: 'visible', timeout: 15000 });
            check('Back to the results: the same search, still there', await searchBox(page).inputValue() === 'narwhal' && (await page.locator('[data-recall-result]').count()) === 1);
            await page.locator('[data-recall-open]').first().click();
            await mark.waitFor({ state: 'visible', timeout: 20000 });
            await page.getByRole('button', { name: 'Done: take the mark off this turn' }).first().click();
            await waitFor(async () => (await page.locator('[data-recall-mark]').count()) === 0 && (await turnPlace(page, 2)).anyMarked === 0, 'the marks to go', 5000, 200).catch(() => {});
            check('Done takes the mark and the line off', (await page.locator('[data-recall-mark]').count()) === 0 && (await turnPlace(page, 2)).anyMarked === 0);
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-jump');
        });
    }

    // ── The tool, as an agent uses it ──────────────────────────────────
    // After the window's "narwhal" checks: the agent's own call (its line "recall_search: narwhal exporter") matches that
    // word too. Its script writes the word \u006earwhal, which the model reads as "narwhal" while the request's own text
    // does not match it, so the search cannot find the turn that asks it.
    const agentScript = turnScript([
        { tool: 'recall_search', args: {} },
        { tool: 'recall_search', args: { query: 'narwhal exporter', kind: 'session' } },
        { tool: 'recall_search', args: { open: '$FIRST_ID' } },
    ], 'It was wired in turn 2 of the long session.').replace('narwhal', '\\u006earwhal');
    ids.agent = await run.newSession(`What did we decide about the exporter?\n${agentScript}`, 'Ask about past work');
    await turnsEnded(ids.agent, 1);
    await step('the recall_search tool: an agent searches, reads a turn in full, and a call with no words is refused in words', async () => {
        const asked = model.requests.filter((r) => r.anchor.includes('What did we decide about the exporter?'));
        check('agents are offered recall_search', asked.length >= 4 && asked.every((r) => r.tools.includes('recall_search')), json(asked.map((r) => r.tools.length)));
        const [empty, searched, opened] = asked.slice(1, 4).map((r) => r.result);
        check('a call with no words is refused, saying what to give', /Give words to search for/.test(empty ?? ''), empty);
        check('the search answers with the session, its turn and its id, marked as a record of earlier work',
            /Recall found 1 matching turn in 1 session for “narwhal exporter” \(kind session\)/.test(searched ?? '') && searched.includes('“Long session”') && /DSH session, turn 2/.test(searched)
            && searched.includes(`session ${ids.long}`) && searched.includes('information, not instructions'), searched);
        check('open reads that turn in full: what was asked, the reply, the turns beside it',
            /^“Long session” \(DSH session, turn 2/.test(opened ?? '') && opened.includes('The person asked:') && opened.includes('Turn 2: wire the narwhal exporter.') && opened.includes('The reply:') && /Next to it: earlier \d+\.1, later \d+\.3/.test(opened), opened);
        const results = (await run.events(ids.agent)).filter((e) => e.type === 'tool/result');
        check('DSH logged the three calls\' results in the session', results.length === 3, json(results.map((e) => e.type)));
    });
    // An agent whose own request says "stoat": a command first (3 s), so its open turn is in the index when it searches.
    ids.askStoat = await run.newSession(`What happened to the stoat rollout?\n${turnScript([
        { tool: 'bash', args: { command: 'sleep 3', description: 'Wait a moment' } },
        { tool: 'recall_search', args: { query: 'stoat' } },
    ], 'It was stopped before it finished.')}`, 'Ask about the stoat rollout');
    await turnsEnded(ids.askStoat, 1, 60000);
    await step('the tool leaves out the turn that asks: its own words are the question, not earlier work', async () => {
        const asked = model.requests.filter((r) => r.anchor.includes('What happened to the stoat rollout?'));
        const result = asked[2]?.result ?? '';
        check('the agent finds the stopped rollout, with how it ended, and not its own turn, though its request says "stoat" too',
            /Recall found 1 matching turn in 1 session or file for “stoat”/.test(result) && result.includes(`session ${ids.stopped}`) && !result.includes(`session ${ids.askStoat}`)
            && /stopped before it finished \(stopped from the chat\)/.test(result), result);
        const later = await search({ text: 'stoat' });
        check('once its turn is over, the asking session is found like any other', later.results.some((r) => r.sessionId === ids.askStoat) && later.results.some((r) => r.sessionId === ids.stopped), json(later.results.map((r) => [r.title, r.state])));
    });

    if (pw) {
        await step('the filters and the reading view: a transcript turn and a note section read in the page', async () => {
            const { page } = window;
            await openRecall(page);
            await searchFor(page, 'xylophone OR quokka OR gateway');
            const kindsShown = async () => [...new Set(await page.locator('[data-recall-result]').evaluateAll((els) => els.map((el) => el.getAttribute('data-recall-result'))))].sort().join();
            check('all kinds at first', await kindsShown() === 'handoff,session,transcript', await kindsShown());
            await page.locator('[data-suite-choice="dshrc-kind"]').getByRole('tab', { name: 'Transcripts', exact: true }).click();
            await waitFor(async () => await kindsShown() === 'transcript', 'transcripts only', 10000, 200).catch(() => {});
            check('Transcripts: only the transcript', await kindsShown() === 'transcript', await kindsShown());
            await page.getByRole('button', { name: 'Time: Any time' }).click();
            await page.getByRole('menuitem', { name: 'Past month' }).or(page.getByRole('menuitemradio', { name: 'Past month' })).or(page.getByRole('option', { name: 'Past month' })).first().click();
            await page.getByText('Nothing matches “xylophone OR quokka OR gateway”').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const empty = (await page.locator('[data-recall-search]').innerText()).replace(/\n+/g, ' ');
            check('the past month has no transcript turn: the empty state says why and offers to search again without the filters, one "Clear the filters" on the page', /Nothing matches “xylophone OR quokka OR gateway”/.test(empty) && /The filters may also leave it out\./.test(empty) && /Search again without the filters/.test(empty) && (empty.match(/Clear the filters/g) ?? []).length === 1, empty);
            await shot(page, shots, 'filters-light');
            await page.getByRole('button', { name: 'Search again without the filters' }).click();
            await waitFor(async () => await kindsShown() === 'handoff,session,transcript', 'every kind again', 10000, 200);
            await searchFor(page, 'xylophone', { total: 1 });
            const opener = await page.locator('[data-recall-open]').first().getAttribute('data-recall-open');
            await page.locator('[data-recall-open]').first().click();
            const reading = page.locator('[data-recall-reading]');
            await reading.getByText('Fixed the xylophone tokenizer', { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 });
            const text = (await reading.innerText()).replace(/\n+/g, ' ');
            check('a transcript turn opens in the reading view: what was asked, the reply, the file and line, the turn before',
                /Asked The xylophone parser fails on nested quotes\./.test(text) && /Reply Fixed the xylophone tokenizer/.test(text) && text.includes(`File: ${RUN_1}, line 3`) && /Turn before/.test(text) && /Coding-agent transcript · \/work\/parser · glm-transcript · turn 2 of 3/.test(text), text);
            // The reply in DSH's own Markdown, as the chat draws it: bold and code drawn, no raw marks.
            const md = await reading.evaluate((el) => {
                const box = el.querySelector('[data-recall-markdown]');
                return { box: Boolean(box), strong: box?.querySelector('strong, b')?.textContent ?? '', code: box?.querySelector('code')?.textContent ?? '', raw: /\*\*|`/.test(el.innerText) };
            });
            check('the reply is drawn in DSH\'s own Markdown, as in the chat: bold and code, with none of their marks shown',
                md.box && md.strong === 'nested quotes' && md.code === 'readQuoted' && !md.raw, json(md));
            await shot(page, shots, 'reading-light');
            await setDark(page, true);
            await shot(page, shots, 'reading-dark');
            await setDark(page, false);
            await reading.getByRole('button', { name: 'Turn before' }).click();
            await reading.getByText('Please migrate the ledger schema to version 7.').first().waitFor({ state: 'visible', timeout: 10000 });
            check('Turn before reads the turn before, with the command it ran', /make migrate-ledger/.test(await reading.innerText()));
            await reading.getByRole('button', { name: 'Back to the results' }).click();
            const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-recall-open') ?? document.activeElement?.tagName ?? null);
            await waitFor(async () => (await focused()) === opener, 'the focus to come back', 5000, 100).catch(() => {});
            check('Back after Turn before: the focus is back on the button that opened the reading view', (await focused()) === opener, json({ focused: await focused(), opener }));
            await searchFor(page, 'quokka', { total: 1 });
            await page.locator('[data-recall-open]').first().click();
            await reading.getByText('Rotate the quokka certificates', { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 });
            const note = (await reading.innerText()).replace(/\n+/g, ' ');
            check('a note section opens in the reading view: its heading, its text, its file and line', /Section “Next steps”/.test(note) && note.includes(`File: ${join(NOTES, 'HANDOFF.md')}, line 9`) && /Section before/.test(note), note);
            await reading.getByRole('button', { name: 'Back to the results' }).click();
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-filters');
        });

        await step('the tool\'s card in the agent\'s chat: what it searched, what it found, and Open at the turn', async () => {
            const { page } = window;
            await openRecall(page);
            await searchFor(page, '"decide about the exporter"', { total: 1 });
            await page.locator('[data-recall-open]').first().click();
            await page.locator('[data-recall-mark]').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20000 });
            // DSH folds a finished turn's steps under "Completed in …" (button[data-turn-process]), and a run of
            // calls under a group row ([data-step-process]): unfold both to see the calls.
            const folded = page.locator('button[data-turn-process][aria-expanded="false"], [data-step-process] button[aria-expanded="false"]').filter({ visible: true });
            for (let i = 0; i < 6 && (await folded.count()) > 0; i += 1) {
                await folded.first().click();
                await sleep(300);
            }
            const card = page.locator('[data-recall-tool="results"]').filter({ visible: true }).first();
            await card.waitFor({ state: 'visible', timeout: 20000 });
            const head = (await card.innerText()).replace(/\n+/g, ' ');
            check('the search call shows as a tool row in DSH\'s own style: what it searched and what it found', /Searched past work for “narwhal exporter”: 1 turn in 1 session$/.test(head.trim()), head);
            const turnCard = page.locator('[data-recall-tool="turn"]').filter({ visible: true }).first();
            const failed = page.locator('[data-recall-tool="failed"]').filter({ visible: true }).first();
            check('the open call reads "Read a past turn", and the call with no words says why in the person\'s words',
                /Read a past turn: “Long session”/.test(await turnCard.innerText()) && /Didn't search past work: the agent gave no words to search for\./.test(await failed.innerText()), `${await turnCard.innerText()} | ${await failed.innerText()}`);
            await card.getByText(/Searched past work for/).first().click();
            const result = card.locator('[data-recall-tool-result]').first();
            await result.waitFor({ state: 'visible', timeout: 10000 });
            const resultText = (await result.innerText()).replace(/\s+/g, ' ').trim();
            check('opened, it lists the result: title, where, the hit, and Open', /^Long session Session · .+ · fake-model · turn 2/.test(resultText) && /Open$/.test(resultText) && !/recall_search/.test(await card.innerText()), resultText);
            await shot(page, shots, 'tool-card-light', card);
            await setDark(page, true);
            await shot(page, shots, 'tool-card-dark', card);
            await setDark(page, false);
            await result.getByRole('button', { name: 'Open' }).click();
            const mark = page.locator('[data-recall-mark]').filter({ visible: true }).first();
            await mark.waitFor({ state: 'visible', timeout: 20000 });
            check('Open on the card opens the long session at turn 2, marked', /Found by Recall · turn 2, for “narwhal exporter”/.test(await mark.innerText()) && (await turnPlace(page, 2)).marked > 0);
            check('its mark offers Back to the results and Back to the chat the card is in', /Back to the results/.test(await mark.innerText()) && /Back to the chat/.test(await mark.innerText()), await mark.innerText());
            // Back to the results: the agent's search, not the page's own earlier one ("decide about the exporter").
            await mark.getByRole('button', { name: 'Back to the results' }).click();
            await page.locator('[data-recall-page]').waitFor({ state: 'visible', timeout: 15000 });
            const agentSaw = await search({ text: 'narwhal exporter', kind: 'session', prefix: true });
            const landed = await waitFor(async () => {
                const count = page.locator('[data-recall-count]');
                return (await searchBox(page).inputValue()) === 'narwhal exporter' && (await count.count()) > 0 && (await count.getAttribute('data-recall-count')) === String(agentSaw.total)
                    && (await page.locator('[data-recall-result]').first().getAttribute('data-recall-id')) === `${agentSaw.results[0].file}.${agentSaw.results[0].turn}`;
            }, 'the page to show the card\'s search', 10000, 200).then(() => true, () => false);
            const kindShown = await page.locator('[id="dshrc-kind-session"][aria-selected="true"]').count();
            check('Back to the results from the card shows the search the agent made (its words and its kind filter), not the page\'s earlier one',
                landed && kindShown === 1, `${await searchBox(page).inputValue()} | kind session shown: ${kindShown} | ${await page.locator('[data-recall-count]').textContent().catch(() => '')}`);
            await shot(page, shots, 'tool-back-light');
            await setDark(page, true);
            await shot(page, shots, 'tool-back-dark');
            await setDark(page, false);
            // Back to the chat: from the card's turn again, then to the chat the card is in.
            await searchFor(page, '"decide about the exporter"', { total: 1 });
            await page.locator('[data-recall-open]').first().click();
            await page.locator('[data-recall-mark]').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20000 });
            for (let i = 0; i < 6 && (await folded.count()) > 0; i += 1) {
                await folded.first().click();
                await sleep(300);
            }
            await card.waitFor({ state: 'visible', timeout: 20000 });
            // The card may still be open from before: open it only when its result does not show.
            if (!(await result.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false))) await card.getByText(/Searched past work for/).first().click();
            await result.waitFor({ state: 'visible', timeout: 10000 });
            await result.getByRole('button', { name: 'Open' }).click();
            await waitFor(async () => /for “narwhal exporter”/.test((await mark.innerText().catch(() => '')) ?? ''), 'the long session\'s mark again', 20000, 200);
            await mark.getByRole('button', { name: 'Back to the chat' }).click();
            const back = await waitFor(async () => (await page.getByText('What did we decide about the exporter?').filter({ visible: true }).count()) > 0, 'the agent\'s chat', 15000, 200).then(() => true, () => false);
            check('Back to the chat from the mark goes to the chat the card is in', back, (await page.locator('[data-chat-flow]').first().innerText().catch(() => '')).slice(0, 300));
            const done = page.getByRole('button', { name: 'Done: take the mark off this turn' }).filter({ visible: true });
            if (await done.count()) await done.first().click().catch(() => {});
            // The page kept the card's search with its kind (Sessions): Clear the filters puts every kind back.
            await openRecall(page);
            await page.locator('[data-recall-clear]').first().click();
            const cleared = await waitFor(async () => (await page.locator('[id="dshrc-kind-any"][aria-selected="true"], [id="dshrc-kind-all"][aria-selected="true"]').count()) === 1
                && (await page.locator('[data-recall-clear]').count()) === 0, 'every kind again', 10000, 200).then(() => true, () => false);
            check('the card\'s filter stays on the page until Clear the filters, which puts every kind back', cleared, await page.locator('[data-recall-search]').innerText().catch(() => ''));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-tool-card');
        });

        await step('rows already on the page follow their turns: a shown running turn, stopped from the chat, reads "stopped" with no search again; opened while it runs, it gets a line above the composer', async () => {
            const { page } = window;
            ids.ocelot = await run.newSession('Roll out the ocelot canary.\nE2E:hang The ocelot canary waits.', 'Ocelot canary');
            await waitFor(async () => (await run.session(ids.ocelot)).status === 'running', 'the ocelot turn to start', 20000, 200);
            await found({ text: 'ocelot' }, 'the running ocelot turn to be read', 20000, (r) => r.results[0]?.state === 'running');
            await openRecall(page);
            await searchFor(page, 'ocelot canary', { total: 1 });
            const row = page.locator('[data-recall-result]').first();
            check('the running turn is listed as still running', /turn 1 · still running/.test((await row.innerText()).replace(/\n+/g, ' ')), await row.innerText());
            // Opened while it runs: DSH draws no tail for a running turn, so no mark; the way back is a line above the composer.
            await page.locator('[data-recall-open]').first().click();
            const dock = page.locator('[data-recall-dock]').filter({ visible: true }).first();
            const docked = await dock.waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false);
            const dockText = docked ? (await dock.innerText()).replace(/\n+/g, ' ') : '';
            check('a running turn opened from the page: a line above the composer says which turn, with Back to the results and Done',
                /Found by Recall · turn 1, still running, for “ocelot canary”/.test(dockText) && /Back to the results/.test(dockText) && /Done/.test(dockText), dockText);
            // As wide as the composer at most, inside its edges (round 3: it spanned the chat column, wider than the composer).
            const widths = docked ? await dock.evaluate((el) => {
                const card = document.querySelector('[data-slot="conversation.composer.bar"] :is([class$="_card"],[class*="_card "])');
                const a = el.getBoundingClientRect();
                const b = card?.getBoundingClientRect();
                return { line: [Math.round(a.left), Math.round(a.right)], composer: b ? [Math.round(b.left), Math.round(b.right)] : null };
            }) : { line: null, composer: null };
            check('the line above the composer sits inside the composer\'s width', Boolean(widths.composer) && widths.line[0] >= widths.composer[0] - 1 && widths.line[1] <= widths.composer[1] + 1, json(widths));
            if (docked) {
                await shot(page, shots, 'running-dock-light');
                await setDark(page, true);
                await shot(page, shots, 'running-dock-dark');
                await setDark(page, false);
                await dock.getByRole('button', { name: 'Back to the results' }).click();
            } else await openRecall(page);
            await page.locator('[data-recall-page]').waitFor({ state: 'visible', timeout: 15000 });
            await row.waitFor({ state: 'visible', timeout: 10000 });
            // Stopped from the chat while its row is on the page: the row says so by itself, with no search again.
            const asked = [];
            const onRequest = (req) => {
                const m = /dsh-plugin-recall\/(search|states)/.exec(req.url());
                if (m) asked.push(m[1]);
            };
            page.on('request', onRequest);
            const stoppedAt = Date.now();
            await run.bridge('POST', `/sessions/${encodeURIComponent(ids.ocelot)}/cancel`, {});
            // Every look at the row on the way says a state: still running, then ending, then stopped (round 3: no word
            // at all for about 2 s while its end was read).
            const seen = [];
            const took = await waitFor(async () => {
                const text = (await row.innerText()).replace(/\n+/g, ' ');
                const word = /turn 1 · (still running|ending|stopped)\b/.exec(text)?.[1] ?? 'no word';
                if (seen.at(-1) !== word) seen.push(word);
                return word === 'stopped';
            }, 'the shown row to read stopped', 30000, 100).then(() => Date.now() - stoppedAt, () => -1);
            page.off('request', onRequest);
            check('on its way to "stopped", the row always says a state: still running, ending, stopped, never none', !seen.includes('no word') && seen.at(-1) === 'stopped', seen.join(' → '));
            console.log(`# the shown row said: ${seen.join(' → ')}`);
            timings.followed = took;
            check('stopped from the chat, the row already shown reads "stopped" by itself: its state asked for, no search again',
                took >= 0 && asked.includes('states') && !asked.includes('search') && (await searchBox(page).inputValue()) === 'ocelot canary', `${took} ms | asked: ${asked.join(', ')} | ${(await row.innerText()).replace(/\n+/g, ' ')}`);
            console.log(`# a shown row read "stopped" ${took} ms after the turn was stopped`);
            // Opened again now that it ended: its mark after the turn, and no line above the composer.
            await page.locator('[data-recall-open]').first().click();
            const mark = page.locator('[data-recall-mark]').filter({ visible: true }).first();
            await mark.waitFor({ state: 'visible', timeout: 20000 });
            check('opened once it ended: its mark, and no line above the composer', (await page.locator('[data-recall-dock]').filter({ visible: true }).count()) === 0, await mark.innerText());
            await mark.getByRole('button', { name: 'Done' }).click();
            // Stopped while its line shows: the mark takes over at the turn's end, and no line says it still runs.
            ids.lynx = await run.newSession('Roll out the lynx canary.\nE2E:hang The lynx canary waits.', 'Lynx canary');
            await waitFor(async () => (await run.session(ids.lynx)).status === 'running', 'the lynx turn to start', 20000, 200);
            await found({ text: 'lynx' }, 'the running lynx turn to be read', 20000, (r) => r.results[0]?.state === 'running');
            await openRecall(page);
            await searchFor(page, 'lynx canary', { total: 1 });
            await page.locator('[data-recall-open]').first().click();
            await dock.waitFor({ state: 'visible', timeout: 20000 });
            await run.bridge('POST', `/sessions/${encodeURIComponent(ids.lynx)}/cancel`, {});
            const tookOver = await waitFor(async () => {
                const docks = page.locator('[data-recall-dock]').filter({ visible: true });
                const still = (await docks.count()) > 0 && /still running/.test(await docks.first().innerText().catch(() => ''));
                return (await mark.count()) > 0 && /Found by Recall · turn 1, for “lynx canary”/.test(await mark.innerText().catch(() => '')) && !still;
            }, 'the mark to take over from the line', 20000, 200).then(() => true, () => false);
            check('stopped while its line shows above the composer: the mark is drawn at the turn\'s end, and no line says it still runs', tookOver,
                `${await mark.innerText().catch(() => 'no mark')} | ${await page.locator('[data-recall-dock]').filter({ visible: true }).first().innerText().catch(() => 'no line')}`);
            if (tookOver) await mark.getByRole('button', { name: 'Done' }).click();
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-follow');
        });

        await step('the index card: each folder\'s state, one not there, Look for changes now; a narrow window', async () => {
            const { page } = window;
            await openRecall(page);
            const index = page.locator('[data-recall-index]');
            const text = (await index.innerText()).replace(/\n+/g, ' ');
            check('the index card lists this DSH\'s sessions, the transcript and note folders, each up to date, and says a folder is not there and what that means',
                /This DSH's sessions .* up to date/.test(text) && text.includes(GONE) && /This folder is not there now \(a disk may be unplugged\)\. What Recall read from it stays searchable, and it looks again every minute\. not there/.test(text)
                && (await page.locator('[data-recall-root-state="missing"]').count()) === 1 && (await page.locator('[data-recall-root-state="ok"]').count()) === 3, text.slice(0, 900));
            await index.getByRole('button', { name: 'Look for changes now' }).click();
            await waitFor(async () => /Looking through every folder/.test((await page.locator('[data-recall-said]').textContent()) ?? ''), 'the page to say it looks', 10000, 200).catch(() => {});
            check('Look for changes now says what it does', /^Looking through every folder for new, changed and deleted files\.$/.test((await page.locator('[data-recall-said]').textContent()) ?? ''));
            await index.evaluate((el) => el.scrollIntoView({ block: 'start' }));
            await shot(page, shots, 'index-light');
            await setDark(page, true);
            const indexDark = await shot(page, shots, 'index-dark');
            // What happened, shot as its own card (round 3: the page could not scroll it to the top, so its pictures
            // were the index card's again).
            const history = page.locator('[data-recall-history]');
            await history.evaluate((el) => el.scrollIntoView({ block: 'start' }));
            const historyDark = await shot(page, shots, 'history-dark', history);
            await setDark(page, false);
            await shot(page, shots, 'history-light', history);
            if (indexDark && historyDark) {
                const historyText = (await history.innerText()).replace(/\n+/g, ' ');
                check('the pictures of What happened show that card, not the index card again', !readFileSync(indexDark).equals(readFileSync(historyDark)) && /^What happened/.test(historyText), historyText.slice(0, 200));
            }
            await page.locator('[data-recall-page]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
            await page.setViewportSize({ width: 760, height: 900 });
            await searchFor(page, 'gateway');
            await page.waitForTimeout(400);
            const spill = await page.locator('[data-recall-page]').evaluate((el) => el.scrollWidth - el.clientWidth);
            check('in a narrow window nothing on the page spills sideways', spill <= 1, `${spill}px wider than the page`);
            await shot(page, shots, 'narrow-light');
            await setDark(page, true);
            await shot(page, shots, 'narrow-dark');
            await setDark(page, false);
            await page.setViewportSize({ width: 1280, height: 860 });
            await page.waitForTimeout(300);
            check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-index');
        });

        await step('Wallpaper on and off, light and dark, over a light and a dark picture: the small text reads at 4.5:1; at 420 px the kind switcher fits', async () => {
            const { page } = window;
            await openRecall(page);
            await searchFor(page, 'gateway OR canary OR xylophone OR quokka OR stoat');
            await page.locator('[data-recall-page]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
            const off = {};
            for (const mode of ['light', 'dark']) {
                await setDark(page, mode === 'dark');
                await page.waitForTimeout(300);
                off[mode] = await lowestContrast(page.locator(SMALL_TEXT));
            }
            await setDark(page, false);
            // At a low tint (.2): over a mid grey (lighter in dark, darker in light: where the glass carries small text),
            // and over each picture's own colour (the far ends, which DESIGN leaves open), measured; pictures of each.
            const low = {};
            const ends = {};
            try {
                for (const mode of ['light', 'dark']) {
                    await setDark(page, mode === 'dark');
                    for (const picture of ['light', 'dark']) {
                        await wallpaperOn(page, PICTURES[picture], 0.2);
                        await page.waitForTimeout(300);
                        await shot(page, shots, `wallpaper-${mode}-on-${picture}-picture`);
                    }
                    low[mode] = await lowestContrast(page.locator(SMALL_TEXT), { ground: mode === 'dark' ? 'rgb(140, 140, 140)' : 'rgb(180, 180, 180)' });
                    ends[mode] = {
                        overLight: (await lowestContrast(page.locator(SMALL_TEXT), { ground: 'rgb(240, 236, 228)' })).ratio,
                        overDark: (await lowestContrast(page.locator(SMALL_TEXT), { ground: 'rgb(20, 24, 36)' })).ratio,
                    };
                }
            } finally {
                await wallpaperOff(page);
                await setDark(page, false);
            }
            console.log(`# small text, lowest contrast: Wallpaper off ${json(off)}; tint .2 over a mid grey ${json(low)}; over the pictures' far ends ${json(ends)}`);
            check('Wallpaper off: the page\'s small text reads at 4.5:1 or more, light and dark', ['light', 'dark'].every((m) => off[m].count > 10 && off[m].ratio >= 4.5), json(off));
            check('Wallpaper on at a low tint (.2) over a mid picture: the small text reads at 4.5:1 or more, light and dark', ['light', 'dark'].every((m) => low[m].count > 10 && low[m].ratio >= 4.5), json(low));
            // A narrow window: the kind switcher inside its row, every choice whole; nothing wider than the page.
            await page.setViewportSize({ width: 420, height: 900 });
            const fit = () => page.evaluate(() => {
                const row = document.querySelector('[data-recall-filters]');
                const list = row?.querySelector('[data-suite-choice="dshrc-kind"] [role="tablist"]');
                const r = row?.getBoundingClientRect();
                const l = list?.getBoundingClientRect();
                const tabs = [...(list?.querySelectorAll('[role="tab"]') ?? [])].map((t) => ({ text: t.textContent, whole: t.scrollWidth <= t.clientWidth + 1 }));
                const pageEl = document.querySelector('[data-recall-page]');
                return { width: Math.round(pageEl.getBoundingClientRect().width), row: r ? [Math.round(r.left), Math.round(r.right)] : null, list: l ? [Math.round(l.left), Math.round(l.right)] : null, tabs, spill: pageEl.scrollWidth - pageEl.clientWidth };
            });
            // DSH folds its sidebar into a rail at this width, a moment after the resize on some builds (the app's own
            // took more than half a second under load): measure once the page has the window's width, not before.
            await waitFor(async () => (await fit()).width >= 300, 'DSH\'s narrow layout', 10000, 200).catch(() => {});
            await page.waitForTimeout(300);
            const narrow = await fit();
            check('at 420 px the kind switcher fits inside its row with every choice whole, and nothing spills sideways',
                narrow.row && narrow.list && narrow.list[0] >= narrow.row[0] && narrow.list[1] <= narrow.row[1] && narrow.tabs.length === 4 && narrow.tabs.every((t) => t.whole) && narrow.spill <= 1, json(narrow));
            await page.locator('[data-suite-choice="dshrc-kind"]').getByRole('tab', { name: 'Notes', exact: true }).click();
            await waitFor(async () => (await page.locator('[data-recall-result]').count()) > 0 && (await page.locator('[data-recall-result]').evaluateAll((els) => els.every((el) => el.getAttribute('data-recall-result') === 'handoff'))), 'notes only', 10000, 200).catch(() => {});
            check('at 420 px a choice still chooses: Notes lists notes only', await page.locator('[data-recall-result]').evaluateAll((els) => els.length > 0 && els.every((el) => el.getAttribute('data-recall-result') === 'handoff')));
            await shot(page, shots, 'narrow-420-light');
            await setDark(page, true);
            await shot(page, shots, 'narrow-420-dark');
            await setDark(page, false);
            await page.locator('[data-suite-choice="dshrc-kind"]').getByRole('tab', { name: 'All', exact: true }).click();
            await page.setViewportSize({ width: 1280, height: 860 });
            await page.waitForTimeout(300);
        }, async () => {
            if (window?.page) {
                await wallpaperOff(window.page).catch(() => {});
                await shot(window.page, shots, 'failed-wallpaper');
                await window.page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
            }
        });

        await step('its settings in Plugins: a folder that is not a full path refused; a notes folder added and read; the tool off and on', async () => {
            const { page } = window;
            await openRecall(page);
            await page.locator('[data-recall-header]').getByRole('button', { name: 'Settings', exact: true }).click();
            const form = page.locator('[data-suite-settings="dsh-plugin-recall"]');
            await form.waitFor({ state: 'visible', timeout: 20000 });
            // DSH's form fills in the saved values a moment after it shows.
            await waitFor(async () => (await page.getByLabel('Handoff note folders').inputValue()) === NOTES, 'the form to show the saved folders', 15000, 200).catch(() => {});
            const labels = (await form.innerText()).replace(/\n+/g, ' ');
            check('the header\'s Settings opens Recall\'s settings in Plugins, in DSH\'s own form, with the folders it searches',
                /What Recall searches/.test(labels) && (await page.getByLabel('Handoff note folders').inputValue()) === NOTES
                && (await page.getByLabel('Coding-agent transcript folders').inputValue()) === `${AGENT_LOGS}, ${GONE}`
                && (await form.getByRole('switch', { name: 'Let agents search past work' }).count()) === 1, labels.slice(0, 600));
            await shot(page, shots, 'settings-light');
            await setDark(page, true);
            await shot(page, shots, 'settings-dark');
            await setDark(page, false);
            const notes = page.getByLabel('Handoff note folders');
            await notes.fill(`${NOTES}, notes`);
            const refused = (await page.locator('[data-suite-setting="handoffFolders"]').innerText()).replace(/\n+/g, ' ');
            check('the form will not save a folder that is not a full path, and says what fits', await form.getByRole('button', { name: 'Save' }).isDisabled() && /full path or a path from ~\//.test(refused), refused);
            await notes.fill(`${NOTES}, ${MORE_NOTES}`);
            await form.getByRole('button', { name: 'Save' }).click();
            const w = await found({ text: 'wombat' }, 'the new notes folder to be read', 20000);
            check('saved: the new folder is read at once and its note is found', w.results[0]?.kind === 'handoff' && w.results[0].path === join(MORE_NOTES, 'plan.md'), json(w.results[0]));
            check('What happened says which setting changed', await historyHas(/^Settings changed: “Handoff note folders”/));
            await form.getByRole('switch', { name: 'Let agents search past work' }).click();
            await form.getByRole('button', { name: 'Save' }).click();
            await waitFor(async () => (await pageState()).tool === false, 'the tool to be off', 15000, 300);
            ids.toolOff = await run.newSession(sayText('Nothing to search here.'), 'Tool off');
            await turnsEnded(ids.toolOff, 1);
            check('with the tool off, agents are not offered recall_search', offeredTool('Nothing to search here.').length > 0 && offeredTool('Nothing to search here.').every((x) => !x), json(offeredTool('Nothing to search here.')));
            await form.getByRole('switch', { name: 'Let agents search past work' }).click();
            await form.getByRole('button', { name: 'Save' }).click();
            await waitFor(async () => (await pageState()).tool === true, 'the tool to be on', 15000, 300);
            ids.toolOn = await run.newSession(sayText('Searching is back.'), 'Tool on');
            await turnsEnded(ids.toolOn, 1);
            check('on again, agents are offered recall_search', offeredTool('Searching is back.').length > 0 && offeredTool('Searching is back.').every((x) => x), json(offeredTool('Searching is back.')));
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-settings');
        });

        await step('a large folder taken out in the form: the index gives its space back by itself, What happened says how much, and the Index card shows the new size', async () => {
            const { page } = window;
            const settingsForm = async () => {
                await openRecall(page);
                await page.locator('[data-recall-header]').getByRole('button', { name: 'Settings', exact: true }).click();
                const form = page.locator('[data-suite-settings="dsh-plugin-recall"]');
                await form.waitFor({ state: 'visible', timeout: 20000 });
                await waitFor(async () => (await page.getByLabel('Handoff note folders').inputValue()) !== '', 'the form to show the saved folders', 15000, 200).catch(() => {});
                return form;
            };
            let form = await settingsForm();
            await page.getByLabel('More DSH session folders').fill(OTHER_DSH);
            await form.getByRole('button', { name: 'Save' }).click();
            await found({ text: OTHER_WORD }, 'the other DSH\'s sessions to be read', 60000);
            const full = await settledIndex();
            const mb = (bytes) => `${Math.max(1, Math.round(bytes / 1048576))} MB`;
            console.log(`# another DSH's ${OTHER.files} sessions (${OTHER.turns} turns) read: the index is ${mb(full.bytes)}`);
            form = await settingsForm();
            await page.getByLabel('More DSH session folders').fill('');
            await form.getByRole('button', { name: 'Save' }).click();
            const asked = Date.now();
            const small = await waitFor(async () => {
                const s = await pageState();
                return s.index && !s.index.busy && s.history.some((e) => e.text === 'Made the index smaller') ? s : null;
            }, 'the index to give its space back', 60000, 200);
            timings.shrunk = Date.now() - asked;
            const said = small.history.find((e) => e.text === 'Made the index smaller');
            const gone = full.totals.turns - small.index.totals.turns;
            console.log(`# taken out: ${mb(full.bytes)} → ${mb(small.index.bytes)} in ${timings.shrunk} ms; ${said?.why}`);
            check('taken out, its turns are gone at once and the index gives their space back by itself',
                gone === OTHER.turns && small.index.bytes < full.bytes / 2 && (await search({ text: OTHER_WORD })).total === 0
                && small.history.some((e) => /^Stopped searching \S*\/other-dsh$/.test(e.text) && e.why.includes(`(${OTHER.files} files, ${gone.toLocaleString('en-US')} turns)`)),
                json({ before: [full.bytes, full.totals], after: [small.index.bytes, small.index.totals], history: small.history.slice(0, 3) }));
            check('What happened says how much it gave back, from the size the Index card showed before',
                /^What was taken out of it \(a folder no longer searched, files gone\) left space in it, which it gave back to the disk: it went from [\d,]+ MB to [\d,]+ MB\.$/.test(said?.why ?? '')
                && said.why.endsWith(`it went from ${mb(full.bytes)} to ${mb(small.index.bytes)}.`), json({ said, before: full.bytes, after: small.index.bytes }));
            await openRecall(page);
            const card = page.locator('[data-recall-index]');
            await waitFor(async () => (await card.innerText()).includes(`${mb(small.index.bytes)} on this computer`), 'the Index card to show the new size', 10000, 200)
                .catch(() => {});
            const head = (await card.innerText()).split('\n').slice(0, 3).join(' · ');
            check('the Index card shows the new size', head.includes(`${mb(small.index.bytes)} on this computer`), head);
            await page.locator('[data-recall-history]').scrollIntoViewIfNeeded();
            await shot(page, shots, 'index-smaller-light');
        }, async () => {
            if (window?.page) await shot(window.page, shots, 'failed-index-smaller');
        });
        await window?.browser?.close().catch(() => {});
        window = undefined;
    }

    // ── A restart, and a crash ─────────────────────────────────────────
    const before = { index: await settledIndex() };
    await run.stop();
    const markerAfterStop = existsSync(join(run.home, 'recall', 'index.sqlite.open'));
    await run.boot('a restart');
    await waitFor(async () => (await api('state')).ok && (await pageState()).thread.state === 'running', 'Recall\'s index after the restart', 60000);
    await step('a restart keeps the index: searches answer at once and nothing is read again', async () => {
        const asked = Date.now();
        const hit = await narwhalTurn();
        timings.afterRestart = Date.now() - asked;
        check('DSH quit cleanly: Recall closed its index (no mark of an unclean close left)', markerAfterStop === false);
        check('right after the restart the turn is found, at its turn', hit?.turn === 2, json(hit));
        const s = await waitFor(async () => {
            const now = await pageState();
            return now.index && !now.index.busy ? now : null;
        }, 'the index to look through every folder', 30000, 300);
        console.log(`# after the restart Recall read ${s.index.read} of ${s.index.totals.files} files (those DSH wrote to since)`);
        check('the restart kept every turn and did not read every file again', s.index.totals.turns === before.index.totals.turns && s.index.read < s.index.totals.files && !(await historyHas(/^Built a new index/)),
            json({ before: before.index.totals, after: s.index.totals, read: s.index.read }));
    });
    // A turn DSH is running when it crashes, in a session nothing opens again afterwards.
    ids.hung = await run.newSession('Migrate the ibis tables.\nE2E:hang The ibis migration waits.', 'Ibis migration');
    await waitFor(async () => (await run.session(ids.hung)).status === 'running', 'the ibis turn to start', 20000, 200);
    await found({ text: 'ibis' }, 'the running ibis turn to be read', 20000, (r) => r.results[0]?.state === 'running');
    await run.crash();
    const markerAfterCrash = existsSync(join(run.home, 'recall', 'index.sqlite.open'));
    await run.boot('after a crash');
    await waitFor(async () => (await api('state')).ok && (await pageState()).thread.state === 'running', 'Recall\'s index after the crash', 60000);
    await step('after a crash the index is checked and kept', async () => {
        check('a crash leaves the mark of an unclean close', markerAfterCrash === true);
        const hit = await narwhalTurn();
        check('after the crash the index passed its check and is kept: the turn is found', hit?.turn === 2, json(hit));
        check('no new index was built', !(await historyHas(/^Built a new index/)));
    });
    await step('turns that ended early say how: one cut by the crash is "cut off by a restart", the stopped one "stopped", in rows and the reading view', async () => {
        const cut = await found({ text: 'ibis' }, 'the turn cut by the crash', 30000, (r) => r.results[0]?.state === 'cut-off');
        check('the turn DSH was running when it crashed is cut off by a restart, not still running', cut.results[0].sessionId === ids.hung && cut.results[0].running === false, json(cut.results[0]));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Recall' });
        const { page } = window;
        await openRecall(page);
        await searchFor(page, 'ibis OR "stoat release"');
        const rowOf = (title) => page.locator('[data-recall-result]').filter({ hasText: title }).first();
        const ibis = (await rowOf('Ibis migration').innerText()).replace(/\n+/g, ' ');
        const stoat = (await rowOf('Stoat rollout').innerText()).replace(/\n+/g, ' ');
        check('each row says how its turn ended', /turn 1 · cut off by a restart/.test(ibis) && /turn 1 · stopped/.test(stoat) && !/still running/.test(`${ibis} ${stoat}`), `${ibis} | ${stoat}`);
        await shot(page, shots, 'ended-early-light');
        const reading = page.locator('[data-recall-reading]');
        const said = async (title) => {
            await rowOf(title).getByRole('button', { name: /^Read / }).click();
            const line = reading.locator('[data-recall-state]').first();
            await line.waitFor({ state: 'visible', timeout: 15000 });
            const text = (await line.innerText()).trim();
            const meta = (await reading.innerText()).replace(/\n+/g, ' ');
            await reading.getByRole('button', { name: 'Back to the results' }).click();
            return { text, meta };
        };
        const ibisRead = await said('Ibis migration');
        const stoatRead = await said('Stoat rollout');
        check('the reading view says it in a sentence: cut off by a restart; stopped from the chat',
            ibisRead.text === 'This turn was cut off by a restart: DSH stopped before it finished.' && /turn 1 of 1 · cut off by a restart/.test(ibisRead.meta)
            && stoatRead.text === 'This turn was stopped from the chat before it finished.' && /turn 1 of 1 · stopped/.test(stoatRead.meta), json({ ibisRead, stoatRead }));
        await setDark(page, true);
        await shot(page, shots, 'ended-early-dark');
        await setDark(page, false);
        check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-ended-early');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── Recall switched off and on in Plugins ──────────────────────────
    await step('Recall switched off and on in Plugins: no failure; its entry, marks and style go and come back', async () => {
        if (pw) {
            window = await openWindow(run, pw, { entry: 'Recall' });
            const { page } = window;
            await openRecall(page);
            await searchFor(page, '"wire the narwhal"', { total: 1 });
            await page.locator('[data-recall-open]').first().click();
            await page.locator('[data-recall-mark]').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20000 });
        }
        const off = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-recall', enabled: false });
        check('switched off, DSH reports it applied, with no failure', off.ok === true && off.value?.application === 'applied' && !off.value?.error, json(off));
        await waitFor(async () => (await api('state')).ok === false, 'Recall to stop', 20000, 300);
        if (window?.page) {
            const { page } = window;
            await waitFor(async () => (await page.getByRole('button', { name: 'Recall', exact: true }).count()) === 0, 'its entry to go', 15000, 300).catch(() => {});
            const left = await page.evaluate(() => ({
                marks: document.querySelectorAll('[data-recall-mark], [data-recall-found]').length,
                sheets: document.querySelectorAll('style[data-plugin-css="dsh-plugin-recall/client.css"]').length,
            }));
            check('while Recall is off, its entry, its mark, the turn\'s line and its style sheet are gone', (await page.getByRole('button', { name: 'Recall', exact: true }).count()) === 0 && left.marks === 0 && left.sheets === 0, json(left));
        }
        const on = await run.api('pluginManager/setBundleEnabled', { name: 'dsh-plugin-recall', enabled: true });
        check('switched on again, DSH reports it applied, with no failure', on.ok === true && on.value?.application === 'applied' && !on.value?.error, json(on));
        await waitFor(async () => (await api('state')).ok && (await pageState()).thread.state === 'running', 'Recall to run again', 30000, 300);
        check('switched on again, it searches again', (await narwhalTurn())?.turn === 2);
        if (window?.page) {
            const { page } = window;
            await page.getByRole('button', { name: 'Recall', exact: true }).first().waitFor({ state: 'visible', timeout: 20000 });
            const sheets = await page.evaluate(() => document.querySelectorAll('style[data-plugin-css="dsh-plugin-recall/client.css"]').length);
            check('switched on, its entry comes back, with one style sheet', sheets === 1, String(sheets));
            check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
        }
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-plugin-off');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── Without Session Watch ──────────────────────────────────────────
    await restartWith(rowsWith({ off: ['session-watch'] }), 'Session Watch off');
    await waitFor(async () => (await api('state')).ok && (await pageState()).thread.state === 'running', 'Recall without Session Watch', 60000);
    await step('without Session Watch Recall works, and its open page follows new turns', async () => {
        check('Recall needs nothing else: it searches with Session Watch off', (await narwhalTurn())?.turn === 2);
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Recall' });
        const { page } = window;
        const waits = [];
        page.on('request', (req) => { if (req.url().includes('dsh-plugin-session-watch/')) waits.push(req.url()); });
        await openRecall(page);
        await page.locator('[data-recall-result]').first().waitFor({ state: 'visible', timeout: 15000 });
        ids.late = await run.newSession(sayText('The heron cache is warm now.'), 'Late session');
        await turnsEnded(ids.late, 1);
        const shown = await waitFor(async () => (await page.locator('[data-recall-result]').first().innerText()).startsWith('Late session'), 'the open page to show the new turn', 40000, 500).catch(() => false);
        check('the open page lists the new session\'s turn first, by itself', shown === true, await page.locator('[data-recall-result]').first().innerText().catch(() => ''));
        check('without Session Watch the window never asks for its endpoint (no 404s): the page reads its own state on a timer', waits.length === 0, waits.slice(0, 3).join(', '));
        check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-watch-off');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── Wrong types in the profile ─────────────────────────────────────
    await restartWith(rowsWith({ recall: { transcriptFolders: AGENT_LOGS, tool: 'yes' } }), 'wrong types');
    await waitFor(async () => (await api('state')).ok, 'Recall\'s endpoints with wrong types', 60000);
    await step('wrong types in the profile (one folder without the brackets, "yes" for a switch): Recall starts, says what to write, refuses searches, offers no tool', async () => {
        const s = await pageState();
        const words = /^Coding-agent transcript folders \(transcriptFolders\) must be a list of folders in square brackets, such as \[".+"\] \(it is ".+", one folder without the brackets\); Let agents search past work \(tool\) is wrong too$/;
        check('DSH starts Recall: its state names the first wrong setting in words and how to write it, and names the other one', words.test(s.problem?.text ?? '') && s.problem?.key === 'transcriptFolders' && s.problem?.live === true, json(s.problem));
        const plugins = await run.api('pluginManager/listPlugins', {});
        const entry = (plugins.value?.plugins ?? plugins.value ?? []).find?.((p) => /recall/.test(p?.name ?? p?.id ?? ''));
        console.log(`# DSH's plugin list has Recall as ${json(entry ?? plugins.value ?? plugins.error).slice(0, 300)}`);
        const refused = await api('search', { query: { text: 'narwhal' } });
        check('searches are refused, naming the setting', refused.ok === false && /^Recall is waiting for a setting to be fixed: Coding-agent transcript folders \(transcriptFolders\)/.test(refused.error?.message ?? ''), json(refused.error));
        check('What happened says it started with a wrong setting', await historyHas(/^Started with a wrong setting; Recall waits until it is fixed/));
        ids.wrongType = await run.newSession(sayText('A turn while a type is wrong.'), 'Wrong type');
        await turnsEnded(ids.wrongType, 1);
        check('while a type is wrong, agents are not offered recall_search', offeredTool('A turn while a type is wrong.').length > 0 && offeredTool('A turn while a type is wrong.').every((x) => !x));
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Recall' });
        const { page } = window;
        await openRecall(page);
        const problem = page.locator('[data-suite-trouble="setting"]');
        await problem.waitFor({ state: 'visible', timeout: 20000 });
        const text = (await problem.innerText()).replace(/\n+/g, ' ');
        check('the page names the setting, what to write, the other wrong one, and where to change them', /Coding-agent transcript folders \(transcriptFolders\) must be a list of folders in square brackets/.test(text) && /one folder without the brackets\); Let agents search past work \(tool\) is wrong too\./.test(text) && /Change it in Recall's settings in Plugins/.test(text), text);
        await shot(page, shots, 'wrong-type-light');
        check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-wrong-type');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── A wrong setting, fixed in Plugins ──────────────────────────────
    await restartWith(rowsWith({ recall: { handoffFolders: ['notes'] } }), 'a wrong setting');
    await waitFor(async () => (await api('state')).ok, 'Recall\'s endpoints with a wrong setting', 60000);
    await step('a wrong setting: Recall starts, refuses searches, offers no tool, and says which setting and what it must be', async () => {
        const s = await pageState();
        const words = 'Handoff note folders (handoffFolders) must list folders by their full path or a path from ~/, such as ~/notes ("notes" is not one)';
        check('a wrong value does not stop Recall from starting: its state names the setting and what it must be', s.problem?.text === words && s.problem?.live === true, json(s.problem));
        const refused = await api('search', { query: { text: 'narwhal' } });
        check('searches are refused, saying why', refused.ok === false && refused.error?.message === `Recall is waiting for a setting to be fixed: ${words}.`, json(refused.error));
        ids.wrong = await run.newSession(sayText('A turn while a setting is wrong.'), 'Wrong setting');
        await turnsEnded(ids.wrong, 1);
        check('while a setting is wrong, agents are not offered recall_search', offeredTool('A turn while a setting is wrong.').every((x) => !x) && offeredTool('A turn while a setting is wrong.').length > 0);
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Recall' });
        const { page } = window;
        await openRecall(page);
        const problem = page.locator('[data-suite-trouble="setting"]');
        await problem.waitFor({ state: 'visible', timeout: 20000 });
        const text = (await problem.innerText()).replace(/\n+/g, ' ');
        check('the page says which setting is wrong, what it must be, and where to change it', text.includes(`Recall is waiting for a setting to be fixed. ${words}. Change it in Recall's settings in Plugins. Recall starts working again as soon as you save.`), text);
        await shot(page, shots, 'setting-light');
        await setDark(page, true);
        await shot(page, shots, 'setting-dark');
        await setDark(page, false);
        await problem.getByRole('button', { name: 'Open Recall\'s settings' }).click();
        const form = page.locator('[data-suite-settings="dsh-plugin-recall"]');
        await form.waitFor({ state: 'visible', timeout: 20000 });
        // DSH's form fills in the saved values a moment after it shows: type once they are in.
        const field = page.getByLabel('Handoff note folders');
        await waitFor(async () => (await field.inputValue()) === 'notes', 'the form to show the saved value', 15000, 200);
        await field.fill(NOTES);
        await waitFor(async () => (await field.inputValue()) === NOTES && (await form.getByRole('button', { name: 'Save' }).isEnabled()), 'the good value to be ready to save', 10000, 200);
        await form.getByRole('button', { name: 'Save' }).click();
        const fixed = await waitFor(async () => {
            const r = await api('state');
            return r.ok && !r.value.problem ? r.value : null;
        }, 'the setting to be fixed', 20000);
        check('saving a good value fixes it at once, the log says so, and searches work again',
            fixed.history.some((e) => e.kind === 'settings' && e.text === 'Settings fixed: Recall is working again') && (await search({ text: 'quokka' })).total === 1, json(fixed.history.slice(0, 2)));
        check('no errors from the suite in the window', ours(window.errors).length === 0, ours(window.errors).join('\n'));
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-setting');
    });
    await window?.browser?.close().catch(() => {});
    window = undefined;

    // ── Files ──────────────────────────────────────────────────────────
    await step('a private folder and files', async () => {
        const dir = join(run.home, 'recall');
        const files = ['index.sqlite', 'events.jsonl'].map((f) => join(dir, f));
        const modes = [dir, ...files].map((p) => `${p.slice(run.home.length + 1)} ${existsSync(p) ? modeOf(p).toString(8) : 'missing'}`);
        check('Recall\'s folder is 700 and its index and log 600', modeOf(dir) === 0o700 && files.every((f) => existsSync(f) && modeOf(f) === 0o600), modes.join(', '));
    });

    // ── enabled: false ─────────────────────────────────────────────────
    await restartWith(rowsWith({ recall: { enabled: false } }), 'enabled: false');
    await waitFor(async () => (await api('state')).ok, 'Recall\'s endpoints with enabled: false', 60000);
    await step('enabled: false: Recall keeps no index, refuses searches, offers no tool, and its page says so and how to change it', async () => {
        const s = await pageState();
        check('with enabled: false Recall is loaded but idle', s.enabled === false && !s.problem, json({ enabled: s.enabled, problem: s.problem, thread: s.thread }));
        check('What happened says it was switched off in the profile', s.history[0]?.kind === 'switch' && s.history[0].text === 'Switched off in DSH\'s profile', json(s.history[0]));
        const refused = await api('search', { query: { text: 'narwhal' } });
        check('searches say it is switched off', refused.ok === false && refused.error?.message === 'Recall is switched off in DSH\'s profile (enabled: false), so it keeps no index.', json(refused.error));
        ids.disabled = await run.newSession(sayText('A turn with Recall off.'), 'Recall off');
        await turnsEnded(ids.disabled, 1);
        check('agents are not offered recall_search', offeredTool('A turn with Recall off.').every((x) => !x) && offeredTool('A turn with Recall off.').length > 0);
        if (!pw) return;
        window = await openWindow(run, pw, { entry: 'Recall' });
        const { page } = window;
        await openRecall(page);
        const header = page.locator('[data-recall-header="off"]');
        await header.waitFor({ state: 'visible', timeout: 20000 });
        const words = (await header.innerText()).replace(/\n+/g, ' ');
        check('the page says it keeps no index, and how to change that', /Recall is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\), so it keeps no index\. To use it, set enabled to true there; DSH applies it when you save the file\./.test(words), words);
        await shot(page, shots, 'disabled-light');
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-disabled');
    });

    // ── enabled written while DSH runs ─────────────────────────────────
    await step('enabled written into the profile while DSH runs: DSH applies the save, the open page follows within seconds, What happened says each switch once, and Recall reads what changed while it was off', async () => {
        const patchFile = join(run.profile, 'cordis.patch.yml');
        const off = readFileSync(patchFile, 'utf8');
        check('Recall\'s row in the profile says enabled: false', /\n- id: recall\n {2}config:\n(?: {4}.*\n)*? {4}enabled: false\n/.test(off), off.slice(off.indexOf('- id: recall')));
        const switches = (s) => s.history.filter((e) => e.kind === 'switch').map((e) => e.text);
        const page = pw ? window?.page : undefined;
        if (page) await page.locator('[data-recall-header="off"]').waitFor({ state: 'visible', timeout: 20000 });
        // On again: the save alone, no restart.
        let wrote = Date.now();
        const recallRow = /(\n- id: recall\n {2}config:\n(?: {4}.*\n)*?) {4}enabled: false\n/;
        writeFileSync(patchFile, off.replace(recallRow, '$1    enabled: true\n'));
        const on = await waitFor(async () => {
            const r = await api('state');
            return r.ok && r.value.enabled === true && r.value.thread?.state === 'running' ? r.value : null;
        }, 'DSH to apply enabled: true from the saved profile', 30000);
        const appliedOn = Date.now() - wrote;
        check('DSH applies enabled: true from the saved profile, with no restart', appliedOn < 30000, `${appliedOn} ms`);
        check('What happened says it was switched on again, once', json(switches(on)) === json(['Switched on again in DSH\'s profile', 'Switched off in DSH\'s profile']), json(on.history.slice(0, 3)));
        if (page) {
            await page.locator('[data-recall-header="off"]').waitFor({ state: 'hidden', timeout: 15000 });
            check('the open page shows Recall on again within 15 s of the save', true, `${Date.now() - wrote} ms`);
        }
        const madeOff = await waitFor(async () => {
            const r = await search({ text: '"turn with Recall off"' });
            return r.total >= 1 ? r : null;
        }, 'the turn made while Recall was off to be read', 30000);
        check('Recall reads what changed while it was off: the turn made then is found', madeOff.results[0]?.sessionId === ids.disabled && madeOff.results[0]?.turn === 1, json(madeOff.results[0]));
        // Off again, the same way.
        wrote = Date.now();
        writeFileSync(patchFile, off);
        const offAgain = await waitFor(async () => {
            const r = await api('state');
            return r.ok && r.value.enabled === false ? r.value : null;
        }, 'DSH to apply enabled: false from the saved profile', 30000);
        timings.switched = Math.max(appliedOn, Date.now() - wrote);
        check('What happened says it was switched off again, once', json(switches(offAgain)) === json(['Switched off in DSH\'s profile', 'Switched on again in DSH\'s profile', 'Switched off in DSH\'s profile']), json(offAgain.history.slice(0, 3)));
        const refused = await api('search', { query: { text: 'narwhal' } });
        check('searches are refused again', refused.ok === false && /switched off/.test(refused.error?.message ?? ''), json(refused.error));
        if (page) {
            await page.locator('[data-recall-header="off"]').waitFor({ state: 'visible', timeout: 15000 });
            check('the open page says it is off again within 15 s of the save', true, `${Date.now() - wrote} ms`);
            await shot(page, shots, 'switched-off-live-light');
            check('no errors from the suite in the window while Recall was switched off and on', ours(window.errors).length === 0, ours(window.errors).join('\n'));
        }
    }, async () => {
        if (window?.page) await shot(window.page, shots, 'failed-switch-live');
    });
} catch (error) {
    check('the run finished', false, error?.stack ?? error);
    if (window?.page) await shot(window.page, shots, 'failed').catch(() => {});
} finally {
    await window?.browser?.close().catch(() => {});
    await run.stop();
    await model.close();
    const warnings = run.logText().split('\n').filter((l) => /recall|session-watch/i.test(l) && /warn|error|fail/i.test(l));
    if (warnings.length) console.log(`# DSH said about the suite:\n${warnings.slice(-20).map((l) => `#   ${l}`).join('\n')}`);
    run.cleanup();
}
if (timings.newTurn) console.log(`# timings: new turn searchable after ${timings.newTurn} ms; first search after a restart ${timings.afterRestart ?? '?'} ms${timings.shrunk ? `; a large folder taken out and its space given back in ${timings.shrunk} ms` : ''}${timings.followed ? `; a shown row followed its turn's end in ${timings.followed} ms` : ''}${timings.switched ? `; enabled saved in the profile applied in ${timings.switched} ms` : ''}`);
console.log(`\n# DSH ${version}: ${tally.passed} passed, ${tally.failed} failed${pw ? '' : ', window checks skipped (no Playwright)'}`);
process.exit(tally.failed ? 1 : 0);
