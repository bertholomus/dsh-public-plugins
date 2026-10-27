/**
 * Proof's host half around the projection: the claims ledger and its
 * export (ledger.js), the independent check (verifier.js) with DSH and
 * time stood in for, what its page and flags read (page.js), its endpoints
 * (remote.js), and the host half as DSH loads it (index.js) with DSH's
 * services stood in for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { CHECK_WORDS, EXPORT_FORMATS, VERDICT_WORDS, countsOf, csvField, exportLedger, exportName, isVerified, ledgerOf, sessionRows, titleOf, withChecks } from '../plugins/proof/lib/ledger.js';
import { CHECK_LINE, KEY, foldAll, viewOf } from '../plugins/proof/lib/projection.js';
import { CHECK_TOOLS, Verifier, checkTime, effortFor, endWords, parseChecks, promptFor, refusalOf, verdictIn } from '../plugins/proof/lib/verifier.js';
import { ledgerState, pageState, sessionState, working } from '../plugins/proof/lib/page.js';
import { DEFAULTS, LIVE_SETTINGS, MAX_MINUTES, changesOf, checkConfig, liveValues, savedEntry, unquoted } from '../plugins/proof/lib/config.js';
import { SettingsCheck } from '../plugins/proof/lib/shared/settings.js';
import { JsonStore } from '../plugins/proof/lib/shared/files.js';
import { Journal } from '../plugins/proof/lib/shared/journal.js';
import { manualClock, settle } from './helpers/clock.mjs';
import { tempDir } from './helpers/temp.mjs';

let seq = 0;
/** One turn of a session's log, as DSH writes it. */
function turn(n, { prompt = '', tools = [], reply = '', end = 'completed', source = { kind: 'user' }, at } = {}) {
    const time = () => (at ?? 1_000_000) + (++seq);
    const ev = [
        { type: 'turn/start', seq: ++seq, time: time(), data: { turn: n } },
        { type: 'user/message', seq: ++seq, time: time(), data: { role: 'user', source, content: [{ type: 'text', text: prompt }] } },
    ];
    tools.forEach(([name, args, output], i) => {
        const callId = `c${n}-${i}-${seq}`;
        ev.push({ type: 'tool/call', seq: ++seq, time: time(), data: { turn: n, step: i, callId, name, arguments: args } });
        ev.push({ type: 'tool/result', seq: ++seq, time: time(), data: { turn: n, step: i, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: output }] } } });
    });
    if (reply) ev.push({ type: 'assistant/message', seq: ++seq, time: time(), data: { turn: n, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } });
    ev.push({ type: 'turn/end', seq: ++seq, time: time(), data: { turn: n, reason: { kind: end } } });
    return ev;
}
const testRun = ['bash', { command: 'npm test' }, '# pass 5\n# fail 0'];
const failingRun = ['bash', { command: 'npm test' }, '# pass 4\n# fail 1\nnot ok 5 - parses dates'];

/** A session with one claim of each verdict: shown (1), contradicted (2), no evidence (3), and a write-up leaning on 1 (4). */
function mixedSession() {
    return [
        ...turn(1, { prompt: 'Run the tests.', tools: [testRun], reply: 'All 5 tests pass.' }),
        ...turn(2, { prompt: 'Fix the date parser.', tools: [['edit', { file_path: 'src/date.js' }, 'The file src/date.js has been updated successfully.'], failingRun], reply: 'Fixed the parser; all tests pass.' }),
        ...turn(3, { prompt: 'Now deploy it.', reply: 'Deployed to staging.' }),
    ];
}

// ── The ledger ─────────────────────────────────────────────────────

test('ledger: every claim a session made, with what its turn ran and what the person asked', () => {
    const { check, claims } = ledgerOf(mixedSession());
    assert.equal(check, false);
    assert.deepEqual(claims.map((c) => [c.turn, c.verdict]), [[1, 'backed'], [2, 'contradicted'], [2, 'contradicted'], [3, 'unbacked']].filter((_, i) => i < claims.length));
    const shown = claims.find((c) => c.turn === 1);
    assert.equal(shown.ask, 'Run the tests.');
    assert.equal(shown.ran.length, 1);
    assert.match(shown.ran[0], /npm test/);
    const none = claims.find((c) => c.turn === 3);
    assert.deepEqual(none.ran, [], 'a turn that ran nothing lists nothing');
    assert.match(none.why, /\S/);
    // A summary turn leans on the turn before: its runs are that turn's.
    const leaned = ledgerOf([...turn(1, { prompt: 'Run the tests.', tools: [testRun], reply: 'Ran them.' }), ...turn(2, { prompt: 'thanks, can you summarize?', reply: 'All 5 tests pass.' })]).claims.find((c) => c.turn === 2);
    assert.equal(leaned.verdict, 'backed');
    assert.equal(leaned.from, 1);
    assert.match(leaned.ran[0], /npm test/);
    // Junk and an empty log: no claims, never a throw.
    assert.deepEqual(ledgerOf(undefined), { check: false, claims: [] });
    assert.deepEqual(ledgerOf([null, 3, { type: 'turn/end' }]), { check: false, claims: [] });
});

test('ledger: a check thread (its first message from Proof starts with the check line) is never judged', () => {
    const events = [
        ...turn(1, { prompt: `${CHECK_LINE} Check one claim another session made.`, source: { kind: 'cordis-host-runner' }, tools: [testRun], reply: 'Re-ran it: all 5 tests pass.\nVERIFIED: npm test exited 0 with 5 passing.' }),
        ...turn(2, { prompt: 'and deploy it', reply: 'Deployed to staging.' }),
    ];
    assert.deepEqual(ledgerOf(events), { check: true, claims: [] });
    const state = foldAll(events);
    assert.equal(state.check, true);
    assert.equal(state.first, 1, 'its first turn, where the window says what it checks');
    assert.deepEqual(viewOf(state), { total: 0, flagged: [], check: true, first: 1 });
    // The same words from the person, or after claims were made, do not make a session a check thread.
    assert.equal(ledgerOf(turn(1, { prompt: `${CHECK_LINE} please`, reply: 'Deployed to staging.' })).check, false);
    const later = [...turn(1, { prompt: 'Deploy.', reply: 'Deployed to staging.' }), ...turn(2, { prompt: `${CHECK_LINE} x`, source: { kind: 'cordis-host-runner' }, reply: 'ok' })];
    assert.equal(ledgerOf(later).check, false);
    assert.equal(ledgerOf(later).claims.length, 1, 'a ledger with claims is never wiped');
});

test('ledger: counts, checks by claim, titles and the sessions with claims', () => {
    const { claims } = ledgerOf(mixedSession());
    const counts = countsOf(claims);
    assert.equal(counts.total, claims.length);
    assert.equal(counts.backed + counts.unbacked + counts.contradicted, counts.total);
    assert.equal(counts.flagged, counts.unbacked + counts.contradicted);
    const check = { claimId: claims.at(-1).id, state: 'verified', reason: 'It is live.' };
    const joined = withChecks(claims, [check]);
    assert.equal(joined.at(-1).check, check);
    assert.equal(joined[0].check, undefined);
    // A flagged claim its check verified is counted apart: not flagged, not "no evidence", and the counts still add up.
    const counted = countsOf(joined);
    assert.equal(counted.verified, 1);
    assert.equal(counted.unbacked, counts.unbacked - 1);
    assert.equal(counted.flagged, counts.flagged - 1);
    assert.equal(counted.backed + counted.verified + counted.unbacked + counted.contradicted, counted.total);
    assert.equal(isVerified(joined.at(-1)), true);
    assert.equal(isVerified({ verdict: 'backed', check: { state: 'verified' } }), false, 'a shown claim is shown, whatever a check said');
    assert.equal(isVerified({ verdict: 'unbacked', check: { state: 'not-verified' } }), false);
    assert.equal(countsOf(withChecks(claims, [{ ...check, state: 'not-verified' }])).flagged, counts.flagged, 'not verified stays flagged');
    assert.equal(titleOf({ projections: { values: { title: 'A' } } }), 'A');
    assert.equal(titleOf({ projections: { values: { title: { title: 'B' } } } }), 'B');
    assert.equal(titleOf({}), '');

    const view = (events) => JSON.parse(JSON.stringify(viewOf(foldAll(events))));
    const items = [
        { sessionId: 'old', updatedAt: 1, cwd: '/w/old', projections: { values: { title: 'Old', [KEY]: view(turn(1, { prompt: 'Deploy.', reply: 'Deployed to staging.' })) } } },
        { sessionId: 'new', updatedAt: 9, running: true, projections: { values: { title: { title: 'New' }, [KEY]: view(mixedSession()) } } },
        { sessionId: 'quiet', updatedAt: 5, projections: { values: { [KEY]: view(turn(1, { prompt: 'Run the tests.', tools: [testRun], reply: 'All 5 tests pass.' })) } } },
        { sessionId: 'none', updatedAt: 7, projections: { values: { [KEY]: { total: 0, flagged: [] } } } },
        { sessionId: 'check', updatedAt: 8, projections: { values: { [KEY]: { total: 0, flagged: [], check: true, first: 1 } } } },
        { sessionId: 'junk', updatedAt: 6, projections: { values: { [KEY]: 'x' } } },
        null,
    ];
    const rows = sessionRows(items);
    // The one flagged last first (its latest flagged claim's time), then a session with no flag by when it changed.
    assert.deepEqual(rows.map((r) => r.sessionId), ['new', 'old', 'quiet'], 'the one flagged last first; no claims, check threads and junk left out');
    assert.ok(rows[0].at > rows[1].at, 'timed by its latest flag');
    assert.equal(rows[2].at, 5, 'no flag: when the session last changed');
    assert.equal(rows[0].title, 'New');
    assert.equal(rows[0].running, true);
    assert.ok(rows[0].flagged >= 2);
    assert.ok(rows[0].contradicted >= 1);
    assert.equal(rows[0].latest.turn, 3);
    assert.equal(rows[2].flagged, 0);
    assert.equal(rows[2].latest, undefined);
    assert.equal(rows[1].cwd, '/w/old');
    assert.equal(sessionRows(items, { limit: 1 }).length, 1);
    // With the checks: a verified claim leaves the flagged count and the latest flagged claim.
    const newest = items[1].projections.values[KEY].flagged;
    const lastId = newest.at(-1).id;
    const checked = sessionRows(items, { checkOf: (sessionId, claimId) => (sessionId === 'new' && claimId === lastId ? { state: 'verified' } : sessionId === 'old' ? { state: 'not-verified' } : undefined) });
    assert.equal(checked[0].flagged, rows[0].flagged - 1);
    assert.equal(checked[0].verified, 1);
    assert.notEqual(checked[0].latest.id, lastId, 'the latest flagged claim is one still open');
    assert.equal(checked[1].flagged, rows[1].flagged, 'not verified stays flagged');
    assert.equal(checked[1].verified, 0);
    const all = sessionRows(items, { checkOf: (sessionId) => (sessionId === 'old' ? { state: 'verified' } : undefined) });
    const old = all.find((r) => r.sessionId === 'old');
    assert.deepEqual([old.flagged, old.verified, old.latest], [0, 1, undefined]);
    const broken = sessionRows(items, { checkOf: () => { throw new Error('gone'); } });
    assert.deepEqual(broken.map((r) => r.flagged), rows.map((r) => r.flagged), 'a check store that cannot be read counts nothing as verified');
});

// ── Export ─────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 17, 17, 30, 0);

test('export: Markdown, a table a person reads, its cells safe', () => {
    const { claims } = ledgerOf(mixedSession());
    const all = withChecks(claims, [{ claimId: claims.at(-1).id, state: 'not-verified', reason: 'Nothing | answers on staging.' }]);
    const file = exportLedger({ id: 'session-1234abcd', title: 'Date parser | fix', cwd: '/work/app' }, all, 'md', NOW);
    assert.equal(file.type, 'text/markdown');
    assert.equal(file.name, 'proof-ledger-date-parser-fix-2026-10-17.md');
    const text = file.text;
    assert.match(text, /^# Claims ledger: Date parser \| fix\n/);
    assert.match(text, /Session `session-1234abcd` in `\/work\/app`\. Exported 2026-10-17T17:30:00Z\./);
    assert.match(text, /\| Turn \| Claim \| Verdict \| Why \| Evidence \| Independent check \|/);
    assert.match(text, /\| 3 \| Deployed to staging\. \| No evidence \|/);
    assert.match(text, /Not verified: Nothing \\\| answers on staging\./, 'a pipe in a cell is escaped');
    const rows = text.split('\n').filter((l) => /^\| \d/.test(l));
    assert.equal(rows.length, claims.length);
    for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length, 8, `six cells: ${row}`);
    assert.match(text, /^\d+ claims: 1 shown by their turn, 1 with no evidence, \d+ contradicted by their turn's own output\.$/m, 'no verified clause while none is verified');
    const verified = exportLedger({ id: 's', title: 'T' }, withChecks(claims, [{ claimId: claims.at(-1).id, state: 'verified', reason: 'It answers.' }]), 'md', NOW).text;
    assert.match(verified, /^\d+ claims: 1 shown by their turn, 1 verified by an independent check, 0 with no evidence, \d+ contradicted by their turn's own output\.$/m);
    assert.match(verified, /\| 3 \| Deployed to staging\. \| No evidence \| .* \| Verified: It answers\. \|$/m, 'the row keeps Proof\'s reading beside the check');
    const empty = exportLedger({ id: 'session-9' }, [], 'md', NOW).text;
    assert.match(empty, /0 claims: 0 shown by their turn/);
    assert.match(empty, /This session has made no claim of done, passed, fixed or deployed yet\./);
});

test('export: CSV a spreadsheet opens as data, never as a formula', () => {
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField('a, b'), '"a, b"');
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.equal(csvField('two\nlines'), '"two\nlines"');
    assert.equal(csvField('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
    for (const lead of ['+', '-', '@', '\t', '\r']) assert.ok(csvField(`${lead}1`).replace(/^"/, '').startsWith(`'${lead}`), JSON.stringify(lead));
    assert.equal(csvField(3), '3');
    assert.equal(csvField(undefined), '');

    const claims = [{ id: '1:0', turn: 1, at: NOW, kind: 'passed', text: '=1+1 tests pass, all "green"', verdict: 'unbacked', why: 'No run, in this turn.', evidence: [], ran: ['`ls` exited 0'], check: { state: 'verified', reason: 'Re-ran, 5 pass', endedAt: NOW } }];
    const file = exportLedger({ id: 's1', title: 'T' }, claims, 'csv', NOW);
    assert.equal(file.type, 'text/csv');
    assert.equal(file.name, 'proof-ledger-t-2026-10-17.csv');
    const lines = file.text.split('\r\n');
    assert.equal(lines[0], 'session,title,turn,claimed_at,kind,claim,verdict,why,evidence,ran,check,check_reason,checked_at');
    assert.equal(lines[1], 's1,T,1,2026-10-17T17:30:00Z,passed,"\'=1+1 tests pass, all ""green""",No evidence,"No run, in this turn.",,`ls` exited 0,Verified,"Re-ran, 5 pass",2026-10-17T17:30:00Z');
    assert.equal(lines.at(-1), '', 'every row ends with CRLF');
});

test('export: JSON with every field, and refusals in words', () => {
    const { claims } = ledgerOf([...turn(1, { prompt: 'Run the tests.', tools: [testRun], reply: 'Ran them.' }), ...turn(2, { prompt: 'thanks, summarize', reply: 'All 5 tests pass.' })]);
    const all = withChecks(claims, [{ claimId: claims[0].id, state: 'verified', reason: 'Re-ran: 5 pass.', model: 'Flash from local-gateway', by: 'you', checkSessionId: 'session-c', startedAt: NOW - 60000, endedAt: NOW }]);
    const file = exportLedger({ id: 'session-abcdef0123', title: '', cwd: '/w' }, all, 'json', NOW);
    assert.equal(file.type, 'application/json');
    assert.equal(file.name, 'proof-ledger-abcdef01-2026-10-17.json', 'no title: the id names it');
    const data = JSON.parse(file.text);
    assert.deepEqual(data.session, { id: 'session-abcdef0123', title: '', cwd: '/w' });
    assert.equal(data.exportedAt, '2026-10-17T17:30:00Z');
    assert.equal(data.counts.total, 1);
    assert.equal(data.counts.verified, 0, 'a shown claim a check verified is still shown');
    assert.equal(data.claims[0].evidenceFromTurn, 1);
    assert.equal(data.claims[0].verdict, 'backed');
    assert.deepEqual(data.claims[0].check, { state: 'verified', reason: 'Re-ran: 5 pass.', model: 'Flash from local-gateway', by: 'you', checkSession: 'session-c', startedAt: '2026-10-17T17:29:00Z', endedAt: '2026-10-17T17:30:00Z' });
    assert.deepEqual(EXPORT_FORMATS, ['md', 'csv', 'json']);
    assert.throws(() => exportLedger({ id: 's' }, [], 'pdf'), /Export as Markdown \(md\), CSV \(csv\) or JSON \(json\), not "pdf"\./);
    assert.equal(exportName({ id: 'session-x', title: '  ### ' }, 'md', NOW), 'proof-ledger-x-2026-10-17.md');
    // Named for the person's own day: an export at 11:30 PM is that day's, not tomorrow's (as UTC would have it west of it).
    assert.equal(exportName({ id: 's', title: 'Late' }, 'csv', new Date(2026, 9, 17, 23, 30).getTime()), 'proof-ledger-late-2026-10-17.csv');
    assert.equal(exportName({ id: 's', title: 'Early' }, 'json', new Date(2026, 9, 18, 0, 15).getTime()), 'proof-ledger-early-2026-10-18.json');
    assert.equal(VERDICT_WORDS.unbacked, 'No evidence');
    assert.equal(CHECK_WORDS.failed, 'Could not check');
});

// ── The check thread's limits ──────────────────────────────────────

const sh = (command) => ({ name: 'bash', arguments: JSON.stringify({ command }) });

test('check threads: only tools that read or run, and no command that sends or changes anything', () => {
    for (const name of CHECK_TOOLS) assert.equal(refusalOf({ name, arguments: '{}' }), undefined, name);
    for (const name of ['edit', 'write', 'multi_edit', 'apply_patch', 'agent', '']) assert.match(refusalOf({ name }), /only read and run commands, so .* is refused/);
    for (const command of [
        'npm test', 'git log --oneline -5', 'git status', 'git diff HEAD~1', 'grep -rn "git commit" .', 'curl -s https://example.com/health',
        'kubectl get pods -n staging', 'sha256sum dist/app.tgz', 'grep -r service .', 'echo kill', 'docker ps', 'sed -n 1,20p a.txt',
        'pytest -q', 'node --test', 'terraform plan', 'gh pr list', 'jq . package.json', 'crontab -l', 'git branch -a', 'cargo test', 'go test ./...', 'make test',
    ]) assert.equal(refusalOf(sh(command)), undefined, command);
    const said = (command) => refusalOf(sh(command)) ?? '';
    assert.match(said('git push origin main'), /^Refused: it pushes to origin \(git push\), and a check never sends anything elsewhere\. Check by reading instead\.$/);
    assert.match(said('npm publish'), /^Refused: it publishes/);
    assert.match(said('curl -X POST https://api.example.com/deploy'), /^Refused: it /);
    for (const [command, words] of [
        ['git commit -am wip', 'git commit changes the repository'],
        ['cd app && git reset --hard', 'git reset changes the repository'],
        ['npm install left-pad', 'npm install changes the installed packages'],
        ['npm ci', 'npm ci changes the installed packages'],
        ['sudo pkill node', 'pkill changes running processes'],
        ['systemctl restart api', 'systemctl changes running processes'],
        ['docker run --rm alpine true', 'docker run changes containers'],
        ['sed -i s/a/b/ x.txt', 'sed -i edits files'],
        ['crontab jobs.txt', 'crontab changes scheduled jobs'],
        ['git branch -D old', 'git branch with that option changes the repository'],
        ['pip install requests', 'pip install changes what is installed'],
    ]) assert.equal(said(command), `Refused: ${words}, and a check only reads and runs. Check without changing anything.`, command);
    // Arguments as an object, as "cmd", or not JSON at all.
    assert.match(refusalOf({ name: 'bash', arguments: { cmd: 'git push' } }), /^Refused/);
    assert.match(refusalOf({ name: 'bash', arguments: 'git push' }), /^Refused/);
    assert.equal(refusalOf({ name: 'bash', arguments: { command: '  ' } }), undefined);
});

test('check verdicts: the last line that starts with VERIFIED or NOT VERIFIED, and its reason', () => {
    assert.deepEqual(verdictIn('Ran `npm test`.\nVERIFIED: npm test exited 0 with 5 passing.'), { state: 'verified', reason: 'npm test exited 0 with 5 passing.' });
    assert.deepEqual(verdictIn('**NOT VERIFIED** — the hash differs from the listing.'), { state: 'not-verified', reason: 'the hash differs from the listing.' });
    assert.deepEqual(verdictIn('> ## Not Verified. Nothing answers on staging.'), { state: 'not-verified', reason: 'Nothing answers on staging.' });
    assert.deepEqual(verdictIn('The tests ran clean.\nVERIFIED'), { state: 'verified', reason: 'The tests ran clean.' });
    assert.deepEqual(verdictIn('If it had failed I would say NOT VERIFIED.\nVERIFIED: 5 pass.'), { state: 'verified', reason: '5 pass.' }, 'the last verdict line counts');
    assert.equal(verdictIn('UNVERIFIED claim, I think.'), undefined);
    assert.equal(verdictIn('It seems fine.'), undefined);
    assert.equal(verdictIn(''), undefined);
    assert.equal(verdictIn(undefined), undefined);
    assert.equal(verdictIn(`VERIFIED: ${'x'.repeat(500)}`).reason.length <= 300, true);
});

test('check prompt: the claim, the ask, what the turn ran, the limits and how to answer', () => {
    const claim = { turn: 3, text: 'Deployed to staging.', ask: 'Now deploy it.', ran: ['`kubectl apply -f k8s/` exited 0'], why: 'Nothing in this turn deployed.' };
    const text = promptFor({ claim, title: 'Release', cwd: '/work/app', minutes: 5 });
    assert.ok(text.startsWith(`${CHECK_LINE} Check one claim another session made, on your own, without changing anything.`));
    assert.match(text, /The claim, from turn 3 of "Release" \(in \/work\/app\):\n> Deployed to staging\./);
    assert.match(text, /What the person asked in that turn:\n> Now deploy it\./);
    assert.match(text, /What that turn ran:\n- `kubectl apply -f k8s\/` exited 0/);
    assert.match(text, /Proof's reading: Nothing in this turn deployed\./);
    assert.match(text, /Work in \/work\/app\./);
    assert.match(text, /nothing it runs can write a file, not even in \/tmp/);
    assert.match(text, /You have about 5 minutes\./);
    assert.ok(text.endsWith('End your reply with one line that starts with VERIFIED or NOT VERIFIED, then the reason in one sentence.'));
    const leaned = promptFor({ claim: { turn: 2, text: 'All pass.', from: 1, ran: [], why: '' }, title: '', minutes: 1 });
    assert.match(leaned, /from turn 2 of that session:/);
    assert.match(leaned, /What turn 1 ran \(that turn ran nothing itself\):\n- nothing: it ran no command and read no file\./);
    assert.match(leaned, /Proof's reading: nothing in that turn shows it\./);
    assert.match(leaned, /You have about 1 minute\./);
});

test('check store: anything unknown is dropped, the rest kept', () => {
    assert.deepEqual(parseChecks(undefined), { v: 1, checks: {}, sessions: {}, autoSince: 0, starts: [] });
    assert.deepEqual(parseChecks({ v: 2, checks: { a: {} } }).checks, {});
    const data = parseChecks({
        v: 1,
        autoSince: 5,
        starts: [2, 'x', 9],
        sessions: { 'session-c': 's#1:0', bad: 3 },
        checks: {
            's#1:0': { sessionId: 's', claimId: '1:0', state: 'verified', turn: 1, claim: 'Done.', reason: 'Yes.', by: 'auto', model: 'm', checkSessionId: 'session-c', queuedAt: 1, startedAt: 2, endedAt: 3, reply: 'r'.repeat(900) },
            's#2:0': { sessionId: 's', claimId: '2:0', state: 'exploded' },
            junk: 'x',
        },
    });
    assert.deepEqual(Object.keys(data.checks), ['s#1:0']);
    assert.equal(data.checks['s#1:0'].reply.length, 600);
    assert.equal(data.checks['s#1:0'].by, 'auto');
    assert.deepEqual(data.sessions, { 'session-c': 's#1:0' });
    assert.equal(data.autoSince, 5);
    assert.deepEqual(data.starts, [2, 9]);
});

// ── The independent check ──────────────────────────────────────────

/** DSH as the verifier asks for it: sessions with logs, and every call it made. */
function standInDsh(sessions = {}) {
    const calls = [];
    const dsh = {
        calls,
        sessions,
        noModel: false,
        cannotCreate: false,
        named: (name) => calls.filter((c) => c[0] === name),
        async inspect(id) {
            calls.push(['inspect', id]);
            const s = sessions[id];
            if (!s) throw new Error(`no session ${id}`);
            return { meta: { cwd: s.cwd ?? '' }, events: s.events ?? [] };
        },
        async titleOf(id) { return sessions[id]?.title ?? ''; },
        async titles() { return new Map(Object.entries(sessions).map(([id, s]) => [id, s.title ?? ''])); },
        async namesOf(provider, model) { return { provider: provider === 'local-gateway' ? 'Local Gateway' : provider, model: model === 'glm-5.3-flash' ? 'GLM-5.3 Flash' : model }; },
        // As lib/index.js resolves it: the lowest effort the model offers, and the names DSH's model menu shows.
        async resolveModel(wanted) {
            calls.push(['resolveModel', wanted]);
            if (dsh.noModel) throw new Error('no such model');
            return { provider: wanted.provider, model: wanted.model, reasoningEffort: 'low', effortName: 'Low', providerName: 'Local Gateway', modelName: 'GLM-5.3 Flash' };
        },
        async createNear(sessionId, id, cwd) {
            calls.push(['createNear', sessionId, id, cwd]);
            if (dsh.cannotCreate) throw new Error('the disk is full');
            sessions[id] = { cwd, events: [] };
        },
        async rename(id, title) { calls.push(['rename', id, title]); },
        async agentOf(id) { calls.push(['agentOf', id]); return { id }; },
        prepare(agent, { cwd } = {}) { calls.push(['prepare', agent.id, cwd]); },
        async select(agent, selection) { calls.push(['select', agent.id, selection]); },
        async send(agent, text) { calls.push(['send', agent.id, text]); },
        async cancel(id) { calls.push(['cancel', id]); },
    };
    return dsh;
}

const SETTINGS = { enabled: true, flags: true, verifier: 'ask', verifierProvider: 'local-gateway', verifierModel: 'glm-5.3-flash', verifierMinutes: 5, verifierPerHour: 12 };

/** A verifier over stand-ins, with its store and log on disk in a temp folder. */
function bench({ settings = {}, sessions, ok = true } = {}) {
    const clock = manualClock();
    const dir = tempDir('proof-verifier');
    const config = { ...SETTINGS, ...settings };
    const dsh = standInDsh(sessions ?? { s: { cwd: '/work/app', title: 'Release', events: mixedSession() } });
    const store = new JsonStore(join(dir, 'checks.json'), { parse: parseChecks });
    const journal = new Journal(join(dir, 'events.jsonl'), { now: clock.now });
    let changes = 0;
    const state = { ok };
    const verifier = new Verifier({
        config, working: () => state.ok && config.enabled !== false, dsh, store, journal, logger: { warn() {} },
        changed: () => { changes += 1; }, now: clock.now, after: clock.after, clear: clock.clearTimer,
    });
    return { clock, dir, config, dsh, store, journal, verifier, state, changes: () => changes };
}

const claimOf = (events, verdict) => ledgerOf(events).claims.find((c) => c.verdict === verdict);
const reply = (text) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
const ended = (kind = 'completed', extra = {}) => ({ type: 'turn/end', data: { reason: { kind, ...extra } } });

test('check: off, or Proof not working, says so and starts nothing', async () => {
    const off = bench({ settings: { verifier: 'off' } });
    await assert.rejects(off.verifier.request('s', '3:0'), /The independent check is off\. Turn it on in Proof's settings \("Independent check"\)\./);
    const down = bench({ ok: false });
    await assert.rejects(down.verifier.request('s', '3:0'), /Proof is not working now: see the top of its page\./);
    const ask = bench();
    await assert.rejects(ask.verifier.request('', '3:0'), /Name the session and the claim to check\./);
    await assert.rejects(ask.verifier.request('s', 'nope'), /That claim is not in the session's log any more, so it cannot be checked\./);
    assert.equal(ask.dsh.named('createNear').length, 0);
});

test('check: a fresh read-only thread beside the session, on the check model, asked the claim; VERIFIED settles it', async () => {
    const b = bench();
    const claim = claimOf(b.dsh.sessions.s.events, 'unbacked');
    const queued = await b.verifier.request('s', claim.id);
    assert.equal(queued.state === 'queued' || queued.state === 'running', true);
    assert.equal(queued.by, 'you');
    assert.equal(queued.model, 'glm-5.3-flash from local-gateway');
    await settle();
    const check = b.verifier.data.checks[`s#${claim.id}`];
    assert.equal(check.state, 'running');
    const id = check.checkSessionId;
    assert.match(id, /^session-[0-9a-f-]{36}$/);
    assert.equal(b.verifier.isCheckSession(id), true);
    assert.equal(b.verifier.checkOf(id), check);
    assert.deepEqual(b.dsh.named('createNear')[0], ['createNear', 's', id, '/work/app']);
    assert.deepEqual(b.dsh.named('rename')[0], ['rename', id, 'Proof check · Deployed to staging.']);
    assert.deepEqual(b.dsh.named('prepare')[0], ['prepare', id, '/work/app'], 'made read-only before it is asked anything');
    assert.deepEqual(b.dsh.named('select')[0], ['select', id, { provider: 'local-gateway', model: 'glm-5.3-flash', reasoningEffort: 'low' }], 'DSH is given ids and the effort, never names');
    assert.equal(check.model, 'GLM-5.3 Flash from Local Gateway', 'named as DSH\'s model menu names it');
    assert.equal(check.effort, 'Low');
    assert.equal(check.minutes, 5, 'the minutes it was given, kept on the check');
    const order = b.dsh.calls.map((c) => c[0]);
    assert.ok(order.indexOf('prepare') < order.indexOf('send') && order.indexOf('select') < order.indexOf('send'));
    const prompt = b.dsh.named('send')[0][2];
    assert.ok(prompt.startsWith(CHECK_LINE));
    assert.match(prompt, /from turn 3 of "Release" \(in \/work\/app\)/);
    // Asking again while it runs gives the same check back.
    assert.equal(await b.verifier.request('s', claim.id), check);
    assert.equal(b.dsh.named('createNear').length, 1);
    // Its own thread's claims are never checked.
    await assert.rejects(b.verifier.request(id, '1:0'), /one of Proof's own check threads/);

    b.verifier.onEvent({ id }, reply('kubectl shows no rollout on staging.'));
    b.verifier.onEvent({ id: 'someone-else' }, ended());
    assert.equal(check.state, 'running', 'another session\'s turn end changes nothing');
    b.verifier.onEvent({ id }, reply('I looked at the rollout history.\nNOT VERIFIED: staging still runs the old image.'));
    b.verifier.onEvent({ id }, ended());
    assert.equal(check.state, 'not-verified');
    assert.equal(check.reason, 'staging still runs the old image.');
    assert.match(check.reply, /NOT VERIFIED/);
    assert.equal(b.dsh.named('cancel').length, 0);
    const log = b.journal.list().map((e) => e.text);
    assert.deepEqual(log, ['Not verified: “Deployed to staging.”', 'Checking “Deployed to staging.”', 'Check asked for: “Deployed to staging.”']);
    assert.equal(b.journal.list()[1].why, 'In a new read-only thread on GLM-5.3 Flash from Local Gateway at low effort, for at most 5 minutes.');
    assert.ok(b.changes() >= 3);
    // The store on disk has it.
    b.store.flush();
    const saved = parseChecks(JSON.parse(readFileSync(join(b.dir, 'checks.json'), 'utf8')));
    assert.equal(saved.checks[`s#${claim.id}`].state, 'not-verified');
    assert.equal(saved.sessions[id], `s#${claim.id}`);
    // Check again: a new thread; the old one no longer answers for the claim.
    await b.verifier.request('s', claim.id);
    await settle();
    const again = b.verifier.data.checks[`s#${claim.id}`];
    assert.notEqual(again.checkSessionId, id);
    assert.equal(b.verifier.checkOf(id), undefined);
    assert.equal(b.verifier.isCheckSession(id), true, 'still known as a check thread');
});

test('check: one at a time, and at most the hour\'s budget; the rest wait their turn', async () => {
    const events = [
        ...turn(1, { prompt: 'Deploy.', reply: 'Deployed to staging.' }),
        ...turn(2, { prompt: 'Publish it.', reply: 'Published @acme/sdk@1.2.0 to npm.' }),
        ...turn(3, { prompt: 'Deploy prod.', reply: 'Deployed to production.' }),
    ];
    const b = bench({ settings: { verifierPerHour: 2 }, sessions: { s: { cwd: '/w', events } } });
    const ids = ledgerOf(events).claims.map((c) => c.id);
    assert.equal(ids.length, 3);
    for (const id of ids) await b.verifier.request('s', id);
    await settle();
    const checks = ids.map((id) => b.verifier.data.checks[`s#${id}`]);
    assert.deepEqual(checks.map((c) => c.state), ['running', 'queued', 'queued'], 'one at a time');
    const answer = (check, text) => {
        b.verifier.onEvent({ id: check.checkSessionId }, reply(text));
        b.verifier.onEvent({ id: check.checkSessionId }, ended());
    };
    answer(checks[0], 'VERIFIED: it answers.');
    await settle();
    assert.deepEqual(checks.map((c) => c.state), ['verified', 'running', 'queued']);
    answer(checks[1], 'VERIFIED: the registry lists 1.2.0.');
    await settle();
    assert.equal(checks[2].state, 'queued', 'two started this hour: the third waits');
    assert.equal(b.verifier.budget().used, 2);
    assert.ok(b.verifier.budget().nextAt > b.clock.now());
    await b.clock.advance(59 * 60_000);
    assert.equal(checks[2].state, 'queued');
    await b.clock.advance(2 * 60_000);
    assert.equal(checks[2].state, 'running', 'it starts when the hour allows');
    // A new ask while the budget is used up says when it starts.
    const late = bench({ settings: { verifierPerHour: 1 }, sessions: { s: { cwd: '/w', events } } });
    await late.verifier.request('s', ids[0]);
    await settle();
    late.verifier.onEvent({ id: late.verifier.data.checks[`s#${ids[0]}`].checkSessionId }, ended());
    const waiting = await late.verifier.request('s', ids[1]);
    assert.match(waiting.reason, /^Waits until .+: 1 check has started in the last hour, the most Proof's settings allow\.$/);
    // Checking the same claim again counts as a start too: its new run replaces the old one in the store, not in the hour.
    const again = bench({ settings: { verifierPerHour: 2 }, sessions: { s: { cwd: '/w', events } } });
    for (const n of [1, 2]) {
        await again.verifier.request('s', ids[0]);
        await settle();
        again.verifier.onEvent({ id: again.verifier.data.checks[`s#${ids[0]}`].checkSessionId }, ended());
        await settle();
        assert.equal(again.verifier.budget().used, n);
    }
    const third = await again.verifier.request('s', ids[0]);
    await settle();
    assert.equal(third.state, 'queued', 'a third run of the same claim waits: two started this hour');
    assert.match(third.reason, /^Waits until .+: 2 checks have started in the last hour/);
});

test('check: one that takes too long is stopped and unclear; turns that end badly say why', async () => {
    const b = bench();
    const claim = claimOf(b.dsh.sessions.s.events, 'unbacked');
    const asked = await b.verifier.request('s', claim.id);
    // Its minutes are on it from the moment it runs, before its thread is open.
    assert.equal(asked.state, 'running');
    assert.equal(asked.minutes, 5);
    assert.equal(asked.checkSessionId, undefined);
    await settle();
    const check = b.verifier.data.checks[`s#${claim.id}`];
    // The setting changes while it runs: it is still given the minutes it started with.
    b.config.verifierMinutes = 30;
    b.verifier.settingsChanged();
    await b.clock.advance(5 * 60_000 + 1);
    assert.equal(check.state, 'unclear');
    assert.equal(check.reason, 'It took longer than the 5 minutes it was given, so Proof stopped it.');
    assert.equal(b.journal.list()[0].why, 'It took longer than the 5 minutes it was given, so Proof stopped it.');
    assert.deepEqual(b.dsh.named('cancel')[0], ['cancel', check.checkSessionId]);
    // Late events from the stopped thread change nothing.
    b.verifier.onEvent({ id: check.checkSessionId }, reply('VERIFIED: fine.'));
    b.verifier.onEvent({ id: check.checkSessionId }, ended());
    assert.equal(check.state, 'unclear');

    // The reason only: the check's state is its tag's word, so no reason starts with it.
    const outcomes = [
        [[ended('error', { error: { message: 'model overloaded', code: 'overloaded' } })], 'failed', 'Its turn ended with an error: model overloaded.'],
        [[ended('error', { message: 'model overloaded.' })], 'failed', 'Its turn ended with an error: model overloaded.'],
        [[ended('cancelled')], 'unclear', 'It was stopped before it answered.'],
        [[ended('aborted', { reason: { kind: 'user' } })], 'unclear', 'It was stopped before it answered.'],
        [[ended('aborted', { reason: { kind: 'disposed' } })], 'unclear', 'DSH closed its thread while it ran, so it ended before it answered.'],
        [[ended('aborted', { reason: { kind: 'hook', reason: 'Policy said no.' } })], 'unclear', 'A plugin stopped it before it answered: Policy said no.'],
        [[ended('interrupted')], 'unclear', 'DSH restarted while it ran, so it ended before it answered.'],
        [[ended('max-tokens')], 'unclear', 'Its reply ran past the model\'s length limit before it answered.'],
        [[reply('It looks fine to me.'), ended()], 'unclear', 'Its reply did not end with VERIFIED or NOT VERIFIED.'],
        [[ended()], 'unclear', 'It ended without a reply.'],
        [[reply('VERIFIED')], 'running', ''],
    ];
    for (const [events, state, reason] of outcomes) {
        const c = bench();
        await c.verifier.request('s', claim.id);
        await settle();
        const k = c.verifier.data.checks[`s#${claim.id}`];
        for (const event of events) c.verifier.onEvent({ id: k.checkSessionId }, event);
        assert.equal(k.state, state, reason);
        assert.equal(k.reason, reason);
        c.verifier.stop();
    }
    const quiet = bench();
    await quiet.verifier.request('s', claim.id);
    await settle();
    const k = quiet.verifier.data.checks[`s#${claim.id}`];
    quiet.verifier.onEvent({ id: k.checkSessionId }, reply('VERIFIED'));
    quiet.verifier.onEvent({ id: k.checkSessionId }, ended());
    assert.equal(k.state, 'verified');
    assert.equal(k.reason, 'It gave no reason.');
});

test('check: when DSH cannot start it, the check says where it stopped, in words', async () => {
    const noModel = bench();
    noModel.dsh.noModel = true;
    const claim = claimOf(noModel.dsh.sessions.s.events, 'unbacked');
    await noModel.verifier.request('s', claim.id);
    await settle();
    const a = noModel.verifier.data.checks[`s#${claim.id}`];
    assert.equal(a.state, 'failed');
    assert.equal(a.reason, 'DSH has no model glm-5.3-flash from local-gateway to check with (no such model). Pick one DSH lists in Proof\'s settings ("Check with the model").');
    assert.equal(noModel.dsh.named('createNear').length, 0);

    const noThread = bench();
    noThread.dsh.cannotCreate = true;
    await noThread.verifier.request('s', claim.id);
    await settle();
    const b = noThread.verifier.data.checks[`s#${claim.id}`];
    assert.equal(b.state, 'failed');
    assert.equal(b.reason, 'It stopped while opening the check thread: the disk is full.');
    assert.equal(noThread.dsh.named('send').length, 0);

    // The claim left the log between the ask and the start.
    const gone = bench();
    const asked = await gone.verifier.request('s', 'zz:9', { claim: { id: 'zz:9', turn: 9, text: 'Shipped.', verdict: 'unbacked' } });
    await settle();
    assert.equal(asked.state, 'failed');
    assert.equal(asked.reason, 'The claim is not in the session\'s log any more.');
});

test('check: switching the check off drops what waits; a restart finishes what it cut off', async () => {
    const events = [...turn(1, { prompt: 'Deploy.', reply: 'Deployed to staging.' }), ...turn(2, { prompt: 'Publish it.', reply: 'Published @acme/sdk@1.2.0 to npm.' })];
    const b = bench({ sessions: { s: { cwd: '/w', events } } });
    const [one, two] = ledgerOf(events).claims;
    await b.verifier.request('s', one.id);
    await b.verifier.request('s', two.id);
    await settle();
    b.config.verifier = 'off';
    b.verifier.settingsChanged();
    await settle();
    const waiting = b.verifier.data.checks[`s#${two.id}`];
    // Switched off by the person: not an error.
    assert.equal(waiting.state, 'cancelled');
    assert.equal(waiting.reason, 'The independent check was switched off before it started.');
    assert.equal(b.verifier.data.checks[`s#${one.id}`].state, 'running', 'the one already running finishes');

    // Proof restarts with checks that were running.
    const r = bench({
        sessions: {
            s: { cwd: '/w', events },
            'session-done': { events: [reply('VERIFIED: the registry lists it.'), ended()] },
            'session-open': { events: [reply('Looking…')] },
            // DSH ended the cut turn as it started again ("interrupted"), or closed the thread as it stopped.
            'session-cut': { events: [reply('Looking…'), ended('interrupted')] },
            'session-closed': { events: [ended('aborted', { reason: { kind: 'disposed' } })] },
            'session-slow': { events: [reply('Still reading…')] },
        },
    });
    const base = { sessionId: 's', turn: 1, claim: 'Deployed to staging.', verdict: 'unbacked', by: 'you', model: 'm', queuedAt: r.clock.now() - 1000, startedAt: r.clock.now() - 1000, reason: '' };
    r.verifier.data.checks['s#a'] = { ...base, key: 's#a', claimId: 'a', state: 'running' };
    r.verifier.data.checks['s#b'] = { ...base, key: 's#b', claimId: 'b', state: 'running', checkSessionId: 'session-done' };
    r.verifier.data.checks['s#c'] = { ...base, key: 's#c', claimId: 'c', state: 'running', checkSessionId: 'session-open' };
    r.verifier.data.checks['s#d'] = { ...base, key: 's#d', claimId: 'd', state: 'running', checkSessionId: 'session-lost' };
    r.verifier.data.checks['s#e'] = { ...base, key: 's#e', claimId: 'e', state: 'running', checkSessionId: 'session-cut' };
    r.verifier.data.checks['s#f'] = { ...base, key: 's#f', claimId: 'f', state: 'running', checkSessionId: 'session-closed' };
    r.verifier.data.checks['s#g'] = { ...base, key: 's#g', claimId: 'g', state: 'running', checkSessionId: 'session-slow', minutes: 20 };
    for (const k of ['b', 'c', 'd', 'e', 'f', 'g']) r.verifier.data.sessions[r.verifier.data.checks[`s#${k}`].checkSessionId] = `s#${k}`;
    r.verifier.start();
    await settle();
    assert.equal(r.verifier.data.checks['s#a'].state, 'failed');
    assert.equal(r.verifier.data.checks['s#a'].reason, 'Proof restarted before it began.');
    assert.equal(r.verifier.data.checks['s#b'].state, 'verified', 'its answer was already in its thread');
    assert.equal(r.verifier.data.checks['s#c'].state, 'running', 'still running: it waits for its answer again');
    assert.match(r.verifier.data.checks['s#d'].reason, /^Proof restarted while it ran, and could not read its thread afterwards \(no session session-lost\)\.$/);
    for (const k of ['e', 'f']) {
        assert.equal(r.verifier.data.checks[`s#${k}`].state, 'unclear', k);
        assert.equal(r.verifier.data.checks[`s#${k}`].reason, 'DSH restarted while it ran, so it ended before it answered.', k);
    }
    r.verifier.onEvent({ id: 'session-open' }, reply('NOT VERIFIED: no such version.'));
    r.verifier.onEvent({ id: 'session-open' }, ended());
    assert.equal(r.verifier.data.checks['s#c'].state, 'not-verified');
    // A check cut off by the restart keeps the minutes it was given (20), not the setting's (5).
    await r.clock.advance(6 * 60_000);
    assert.equal(r.verifier.data.checks['s#g'].state, 'running');
    await r.clock.advance(14 * 60_000);
    assert.equal(r.verifier.data.checks['s#g'].state, 'unclear');
    assert.equal(r.verifier.data.checks['s#g'].reason, 'It took longer than the 20 minutes it was given, so Proof stopped it.');
});

test('check words: how a turn ended, in words a person reads; the effort a check asks for; the time a check is listed by', () => {
    assert.equal(endWords({ kind: 'interrupted' }), 'DSH restarted while it ran, so it ended before it answered.');
    assert.equal(endWords({ kind: 'aborted', reason: { kind: 'disposed' } }, { restarted: true }), 'DSH restarted while it ran, so it ended before it answered.', 'read after a restart: DSH closed it as it stopped');
    assert.equal(endWords({ kind: 'aborted', reason: { kind: 'disposed' } }), 'DSH closed its thread while it ran, so it ended before it answered.');
    assert.equal(endWords({ kind: 'aborted', reason: { kind: 'parent' } }), 'It was stopped before it answered.');
    assert.equal(endWords({ kind: 'aborted', reason: { kind: 'hook' } }), 'A plugin stopped it before it answered.');
    assert.equal(endWords({ kind: 'error', error: { message: `x${' y'.repeat(200)}` } }).length <= 240, true);
    assert.equal(endWords({ kind: 'blocked' }), 'DSH did not let its turn run (an archived thread cannot run).');
    assert.equal(endWords({ kind: 'forked' }), 'Its thread was forked before it answered.');
    assert.equal(endWords('mystery'), 'Its turn ended before it answered.');
    assert.equal(endWords(undefined), 'Its turn ended before it answered.');
    for (const kind of ['interrupted', 'aborted', 'error', 'max-tokens', 'blocked', 'forked', 'cancelled']) {
        const words = endWords({ kind, reason: { kind: 'user' } });
        assert.doesNotMatch(words, /\((interrupted|aborted|cancelled|max-tokens|blocked|forked)\)|^(Unclear|Could not check|Checking)/, `${kind}: ${words}`);
    }

    const efforts = (...ids) => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id.toUpperCase() })) } });
    assert.equal(effortFor(efforts('high', 'medium', 'low')), 'low');
    assert.equal(effortFor(efforts('minimal', 'high')), 'minimal');
    assert.equal(effortFor(efforts('low', 'minimal')), 'low', 'low first: minimal can skip the thinking a check needs');
    assert.equal(effortFor(efforts('high', 'max')), undefined, 'none of them: the model\'s own default');
    assert.equal(effortFor({ reasoning: { efforts: 'low' } }), undefined);
    assert.equal(effortFor(undefined), undefined);

    assert.equal(checkTime({ queuedAt: 1, startedAt: 2, endedAt: 3 }), 3);
    assert.equal(checkTime({ queuedAt: 1, startedAt: 2 }), 2);
    assert.equal(checkTime({ queuedAt: 1 }), 1);
    assert.equal(checkTime({}), 0);
});

test('check: "By itself" checks each new flagged claim once, and none made before it was on', async () => {
    const b = bench({ settings: { verifier: 'auto' } });
    b.verifier.start();
    const since = b.verifier.data.autoSince;
    assert.equal(since, b.clock.now());
    const flaggedView = (claims) => ({ total: claims.length, flagged: claims });
    const fresh = { id: '3:0', turn: 3, at: since + 10, text: 'Deployed to staging.', verdict: 'unbacked' };
    const old = { id: '2:0', turn: 2, at: since - 10, text: 'Fixed it.', verdict: 'unbacked' };
    b.verifier.onView('s', flaggedView([old, fresh]));
    b.verifier.onView('s', flaggedView([old, fresh]));
    await settle();
    const keys = Object.keys(b.verifier.data.checks);
    assert.deepEqual(keys, ['s#3:0'], 'once, and only the new claim');
    assert.equal(b.verifier.data.checks['s#3:0'].by, 'auto');
    assert.match(b.journal.list().at(-1).why, /by itself/);
    // Check threads and a check view are never checked.
    const id = b.verifier.data.checks['s#3:0'].checkSessionId;
    b.verifier.onView(id, flaggedView([{ ...fresh, id: '1:0' }]));
    b.verifier.onView('t', { total: 0, flagged: [], check: true });
    await settle();
    assert.equal(Object.keys(b.verifier.data.checks).length, 1);
    // Back to "ask": nothing by itself, and "By itself" starts afresh next time.
    b.config.verifier = 'ask';
    b.verifier.settingsChanged();
    assert.equal(b.verifier.data.autoSince, 0);
    b.verifier.onView('s', flaggedView([{ ...fresh, id: '4:0', at: b.clock.now() + 5 }]));
    await settle();
    assert.equal(Object.keys(b.verifier.data.checks).length, 1);
});

test('check: the store keeps the latest 400 checks and forgets the threads of those it drops', () => {
    const b = bench();
    for (let i = 0; i < 405; i += 1) {
        const key = `s#${i}:0`;
        b.verifier.data.checks[key] = { key, sessionId: 's', claimId: `${i}:0`, turn: i, claim: 'x', verdict: 'unbacked', state: 'verified', reason: '', by: 'you', model: '', checkSessionId: `session-${i}`, queuedAt: i, endedAt: i };
        b.verifier.data.sessions[`session-${i}`] = key;
    }
    b.verifier.trim();
    assert.equal(Object.keys(b.verifier.data.checks).length, 400);
    assert.equal(b.verifier.data.checks['s#0:0'], undefined, 'the oldest go first');
    assert.equal(b.verifier.isCheckSession('session-0'), false);
    assert.equal(b.verifier.isCheckSession('session-404'), true);
    assert.equal(b.verifier.recent(3).length, 3);
});

// ── What the page and the flags read ───────────────────────────────

test('page: everything in one read; sessions only while Proof works; a check thread says what it checks', async () => {
    const b = bench();
    const claim = claimOf(b.dsh.sessions.s.events, 'unbacked');
    await b.verifier.request('s', claim.id);
    await settle();
    const parts = { config: b.config, check: { ok: true }, verifier: b.verifier, journal: b.journal, dsh: b.dsh, rows: async () => [{ sessionId: 's', total: 4 }] };
    const state = await pageState(parts);
    assert.equal(state.problem, undefined);
    assert.equal(state.enabled, true);
    assert.equal(state.flags, true);
    assert.deepEqual(state.verifier, { mode: 'ask', provider: 'local-gateway', model: 'glm-5.3-flash', providerName: 'Local Gateway', modelName: 'GLM-5.3 Flash', minutes: 5, perHour: 12, used: 1, nextAt: 0 });
    assert.deepEqual(state.sessions, [{ sessionId: 's', total: 4 }]);
    assert.equal(state.checks.length, 1);
    assert.equal(state.checks[0].title, 'Release', 'each check names its session, listed with claims or not');
    assert.equal(state.history.length, 2);
    assert.deepEqual(state.history.map((e) => e.title), ['Release', 'Release']);
    // A DSH that cannot name them: the ids, as the settings have them.
    const plainNames = await pageState({ ...parts, dsh: { ...b.dsh, namesOf: async () => { throw new Error('no model menu'); }, titles: undefined } });
    assert.deepEqual([plainNames.verifier.providerName, plainNames.verifier.modelName], ['local-gateway', 'glm-5.3-flash']);
    assert.equal(plainNames.checks[0].title, undefined);
    const problem = { key: 'verifierMinutes', text: 'x', live: true };
    const broken = await pageState({ ...parts, check: { ok: false, problem } });
    assert.equal(broken.problem, problem);
    assert.deepEqual(broken.sessions, [], 'nothing is read while a setting is wrong');
    assert.equal(working({ config: { enabled: false }, check: { ok: true } }), false);

    const session = await sessionState(parts, 's');
    assert.deepEqual({ ...session, checks: session.checks.length }, { on: true, flags: true, verifier: 'ask', isCheck: false, checks: 1 });
    const id = b.verifier.data.checks[`s#${claim.id}`].checkSessionId;
    const thread = await sessionState(parts, id);
    assert.equal(thread.isCheck, true);
    const { startedAt, ...of } = thread.checkOf;
    assert.deepEqual(of, { sessionId: 's', turn: 3, claim: 'Deployed to staging.', state: 'running', reason: '', model: 'GLM-5.3 Flash from Local Gateway', title: 'Release', minutes: 5, effort: 'Low' });
    assert.equal(startedAt, b.clock.now());
    const quiet = await sessionState({ ...parts, config: { ...b.config, flags: false } }, 's');
    assert.equal(quiet.flags, false);
    const down = await sessionState({ ...parts, check: { ok: false } }, 's');
    assert.deepEqual([down.on, down.flags, down.verifier], [false, false, 'off']);

    const ledger = await ledgerState(parts, 's');
    assert.deepEqual(ledger.session, { id: 's', title: 'Release', cwd: '/work/app' });
    assert.equal(ledger.isCheck, false);
    assert.equal(ledger.counts.total, ledger.claims.length);
    assert.equal(ledger.claims.find((c) => c.id === claim.id).check.state, 'running');
    await assert.rejects(ledgerState(parts, 'missing'), /no session missing/);
});

test('checks are listed newest first by the time each row shows: when it ended, else started, else was asked for', () => {
    const b = bench();
    const put = (key, times) => { b.verifier.data.checks[key] = { key, sessionId: 's', claimId: key, turn: 1, claim: 'x', verdict: 'unbacked', state: times.endedAt ? 'verified' : times.startedAt ? 'running' : 'queued', reason: '', by: 'you', model: '', ...times }; };
    put('asked', { queuedAt: 40 });
    put('started-long-ago', { queuedAt: 1, startedAt: 2, endedAt: 50 });
    put('running', { queuedAt: 10, startedAt: 30 });
    put('ended-early', { queuedAt: 20, startedAt: 21, endedAt: 25 });
    assert.deepEqual(b.verifier.recent().map((c) => c.key), ['started-long-ago', 'asked', 'running', 'ended-early']);
    assert.deepEqual(b.verifier.recent().map(checkTime), [50, 40, 30, 25]);
    assert.deepEqual(b.verifier.recent(2).map((c) => c.key), ['started-long-ago', 'asked']);
});

// ── Its endpoints, and the host half as DSH loads it ───────────────

/** DSH's packages the host half imports, stood in for (the suite's test stand-ins, which live with Canon's tests). */
async function dshStandIns() {
    await import('./fixtures/canon/stubs/hooks.mjs');
    return import('./fixtures/canon/stubs/dsh-typert-protocol.mjs');
}

test('endpoints: an export is logged with its file; a copy is logged as a copy once the window has it, and saves nothing', async () => {
    const { marked } = await dshStandIns();
    const { ProofRemote } = await import('../plugins/proof/lib/remote.js');
    for (const name of ['state', 'session', 'ledger', 'exportLedger', 'copied', 'check']) assert.equal(marked.has(name), true, name);
    const b = bench();
    const remote = new ProofRemote({ config: b.config, check: { ok: true }, verifier: b.verifier, journal: b.journal, dsh: b.dsh, rows: async () => [] });
    const n = ledgerOf(b.dsh.sessions.s.events).claims.length;
    const file = await remote.exportLedger('s', 'md');
    assert.match(file.name, /^proof-ledger-release-\d{4}-\d{2}-\d{2}\.md$/);
    let entry = b.journal.list()[0];
    assert.equal(entry.text, 'Ledger exported as Markdown');
    assert.equal(entry.why, `${n} claims, as ${file.name}.`, 'the session is named once, by the entry');
    assert.equal(entry.sessionId, 's');
    // Copy: the Markdown comes back, and nothing is logged until the window says it is on the clipboard.
    const copy = await remote.exportLedger('s', 'md', true);
    assert.equal(copy.text, file.text);
    assert.equal(b.journal.list().length, 1);
    assert.deepEqual(await remote.copied('s', n), { ok: true });
    entry = b.journal.list()[0];
    assert.deepEqual([entry.kind, entry.text, entry.why, entry.sessionId], ['export', 'Ledger copied as Markdown', `${n} claims, onto the clipboard.`, 's']);
    await remote.copied('s', 1);
    assert.equal(b.journal.list()[0].why, '1 claim, onto the clipboard.');
    await remote.copied('s', 'many');
    assert.equal(b.journal.list()[0].why, 'Onto the clipboard.');
    await assert.rejects(remote.copied('', 1), /Name the session\./);
    await assert.rejects(remote.exportLedger('s', 'pdf'), /Export as Markdown, CSV or JSON\./);
    const off = new ProofRemote({ config: { ...b.config, enabled: false }, check: { ok: true }, verifier: b.verifier, journal: b.journal, dsh: b.dsh, rows: async () => [] });
    await assert.rejects(off.copied('s', 1), /Proof is switched off in DSH's profile/);
});

/**
 * Proof's host half loaded as DSH loads it, with DSH's services stood in for:
 * its session list (`items`), the logs `inspect` reads (`logs`), and its
 * model service (`llm`). Gives the endpoints and what DSH was asked.
 */
async function hostHalf({ items, logs, llm, settings = {}, open = {} }) {
    await dshStandIns();
    process.env.CANON_TEST_DSH_HOME = tempDir('proof-home');
    const { apply } = await import('../plugins/proof/lib/index.js');
    const asked = { inspected: [], created: [], selected: [], sent: [], appended: [] };
    const cleanups = [];
    // Open sessions (`open`: id → its claims as they are now) and DSH's word that a session's claims changed.
    const handlers = [];
    let remote;
    const agent = (id) => ({
        id,
        session: { id, header: { cwd: '/w' }, append: (type, data) => asked.appended.push([type, data]) },
        ctx: { tools: { guard() {}, restrict() {} } },
        followup: (message) => asked.sent.push(message),
    });
    const ctx = {
        logger: { warn() {}, info() {} },
        inject(names, fn) { if (names[0] === 'typertGateway') fn({ provide: (_name, value) => { remote = value; } }); },
        get: (name) => (name === 'llm' ? llm : name === 'sessions' ? { get: (id) => (id in open ? { id } : undefined), flush: async () => true } : undefined),
        sessionController: {
            list: async () => ({ items }),
            inspect: async (id) => {
                asked.inspected.push(id);
                if (!logs[id]) throw new Error(`no session ${id}`);
                return { meta: { cwd: '/w' }, events: logs[id] };
            },
            create: async (options) => { asked.created.push(options); logs[options.sessionId] = []; },
            rename: async () => {},
            resolveAgent: async (id) => ({ agent: agent(id) }),
            cancel: async () => {},
            agents: { selectForNextRequest: (_agent, selection) => asked.selected.push(selection) },
        },
        sessionProjections: { register() {}, onChanged(fn) { handlers.push(fn); }, snapshot: (session) => ({ values: { [KEY]: open[session.id] } }), stateOf() {} },
        on() {},
        effect(fn) {
            const cleanup = fn();
            if (typeof cleanup === 'function') cleanups.push(cleanup);
        },
    };
    apply(ctx, { enabled: true, flags: true, verifier: 'ask', verifierProvider: 'local-gateway', verifierModel: 'glm-5.3-flash', verifierMinutes: 15, verifierPerHour: 12, ...settings });
    const changed = (id) => { for (const fn of handlers) fn({ id }, KEY, open[id]); };
    return { remote, asked, changed, stop: () => { for (const fn of cleanups.splice(0)) fn(); } };
}

/**
 * Wait (in real time) until `fn` gives something, for at most `ms`. It returns as soon as `fn` does, so the long
 * limit costs a passing run nothing and keeps a loaded machine (an e2e beside it) from failing it.
 */
async function until(fn, ms = 10000) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await fn();
        if (value || Date.now() > end) return value;
        await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
}

const LLM = {
    listProviders: () => [{ id: 'local-gateway', name: 'Local Gateway (DSH Test)' }, { id: 'other', name: 'Other' }],
    resolveModelInfo: async (provider, model) => ({ provider, model, name: 'GLM-5.3 Flash', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
    asked: [],
    resolveCallConfig: async (wanted) => { LLM.asked.push(wanted); return { provider: wanted.provider, model: wanted.model, ...(wanted.reasoningEffort ? { reasoningEffort: wanted.reasoningEffort } : {}) }; },
};

test('host half: a session saved while Proof was off is listed again, its claims read from its log once', async (t) => {
    const view = (events) => JSON.parse(JSON.stringify(viewOf(foldAll(events))));
    const live = turn(1, { prompt: 'Deploy.', reply: 'Deployed to staging.' });
    const cold = mixedSession();
    const logs = { live, cold, quiet: turn(1, { prompt: 'Hello.', reply: 'Hi there.' }) };
    const items = [
        { sessionId: 'live', updatedAt: 30, projections: { values: { title: 'Live', [KEY]: view(live) } } },
        // Saved while Proof was off: DSH's cache of its views has no claims for it.
        { sessionId: 'cold', updatedAt: 20, projections: { values: { title: 'Saved while off' } } },
        { sessionId: 'quiet', updatedAt: 10, projections: { values: { title: 'No claims' } } },
        { sessionId: 'lost', updatedAt: 5, projections: { values: { title: 'Gone' } } },
    ];
    const proof = await hostHalf({ items, logs, llm: LLM });
    t.after(() => proof.stop());
    const first = await proof.remote.state();
    assert.deepEqual(first.sessions.map((s) => s.sessionId), ['live'], 'at first, only what DSH\'s list gives');
    const later = await until(async () => {
        const state = await proof.remote.state();
        return state.sessions.length > 1 ? state : undefined;
    });
    assert.ok(later, 'the folded session shows up');
    // The one flagged last first: the folded session's claims came after the live one's.
    assert.deepEqual(later.sessions.map((s) => [s.sessionId, s.title]), [['cold', 'Saved while off'], ['live', 'Live']]);
    const row = later.sessions[0];
    assert.equal(row.total, ledgerOf(cold).claims.length);
    assert.equal(row.flagged, ledgerOf(cold).claims.filter((c) => c.verdict !== 'backed').length);
    // Each log is read once (the page lists a session as soon as its log is read, before the others are).
    assert.ok(await until(() => proof.asked.inspected.length >= 3), 'every log without claims is read');
    assert.deepEqual([...proof.asked.inspected].sort(), ['cold', 'lost', 'quiet'], 'each read once; the session DSH gives claims for is not read');
    // The page again: nothing read again while the sessions stay as they were.
    await new Promise((resolve) => { setTimeout(resolve, 2100); });
    await proof.remote.state();
    assert.equal(proof.asked.inspected.length, 3);
    // The provider and model as DSH's model menu names them.
    assert.deepEqual([later.verifier.providerName, later.verifier.modelName], ['Local Gateway (DSH Test)', 'GLM-5.3 Flash']);
});

test('host half: the page lists an open session\'s claims as they are now, and a new session at once', async (t) => {
    const view = (events) => JSON.parse(JSON.stringify(viewOf(foldAll(events))));
    const hello = turn(1, { prompt: 'Hello.', reply: 'Hi there.' });
    const open = { busy: view(hello) };
    // DSH's list holds each session's claims as of its last save.
    const items = [{ sessionId: 'busy', updatedAt: 10, projections: { values: { title: 'Busy', [KEY]: view(hello) } } }];
    const proof = await hostHalf({ items, logs: { busy: hello }, llm: LLM, open });
    t.after(() => proof.stop());
    assert.deepEqual((await proof.remote.state()).sessions.map((s) => s.sessionId), [], 'no claims yet');
    open.busy = view([...hello, ...turn(2, { prompt: 'Deploy.', reply: 'Deployed to staging.' })]);
    proof.changed('busy');
    assert.deepEqual((await proof.remote.state()).sessions.map((s) => s.sessionId), ['busy'], 'listed at once, though DSH has not saved it since');
    // A session the last list read did not have: the list is read again, so it is listed at once too.
    items.push({ sessionId: 'fresh', updatedAt: 20, projections: { values: { title: 'Fresh' } } });
    open.fresh = view(turn(1, { prompt: 'Ship it.', reply: 'Pushed to main.' }));
    proof.changed('fresh');
    assert.deepEqual((await proof.remote.state()).sessions.map((s) => s.sessionId).sort(), ['busy', 'fresh']);
    assert.deepEqual(proof.asked.inspected, [], 'no log read for an open session');
});

test('host half: a check runs at the lowest effort its model offers (low), named as DSH names it', async (t) => {
    const logs = { s: mixedSession() };
    const items = [{ sessionId: 's', updatedAt: 1, projections: { values: { title: 'Release', [KEY]: JSON.parse(JSON.stringify(viewOf(foldAll(logs.s)))) } } }];
    const proof = await hostHalf({ items, logs, llm: LLM });
    t.after(() => proof.stop());
    const claim = ledgerOf(logs.s).claims.find((c) => c.verdict === 'unbacked');
    LLM.asked.length = 0;
    await proof.remote.check('s', claim.id);
    const sent = await until(() => proof.asked.sent.length > 0);
    assert.ok(sent, 'the check thread was asked');
    assert.deepEqual(LLM.asked, [{ provider: 'local-gateway', model: 'glm-5.3-flash', reasoningEffort: 'low' }]);
    assert.deepEqual(proof.asked.selected, [{ provider: 'local-gateway', model: 'glm-5.3-flash', reasoningEffort: 'low' }], 'for this thread only, at low effort');
    assert.deepEqual(proof.asked.appended.map(([type]) => type), ['sandbox/mode', 'approval/policy'], 'read-only before it is asked anything');
    const state = await proof.remote.state();
    const check = state.checks[0];
    assert.equal(check.model, 'GLM-5.3 Flash from Local Gateway (DSH Test)');
    assert.equal(check.effort, 'Low');
    assert.equal(check.minutes, 15);
    assert.equal(state.history[0].why, 'In a new read-only thread on GLM-5.3 Flash from Local Gateway (DSH Test) at low effort, for at most 15 minutes.');

    // A model with no efforts to choose from: its own default, and nothing asked for.
    const plainLlm = { ...LLM, resolveModelInfo: async () => ({ name: 'Plain' }), asked: [] };
    plainLlm.resolveCallConfig = async (wanted) => { plainLlm.asked.push(wanted); return { provider: wanted.provider, model: wanted.model }; };
    const other = await hostHalf({ items, logs: { s: mixedSession() }, llm: plainLlm });
    t.after(() => other.stop());
    await other.remote.check('s', claim.id);
    await until(() => other.asked.sent.length > 0);
    assert.deepEqual(plainLlm.asked, [{ provider: 'local-gateway', model: 'glm-5.3-flash' }]);
    assert.deepEqual(other.asked.selected, [{ provider: 'local-gateway', model: 'glm-5.3-flash' }]);
    assert.equal((await other.remote.state()).checks[0].effort, '');
});

test('settings: a number or true/false in quotes is offered without them only when that is right; the log says what each change was; 45 minutes by default', () => {
    assert.equal(DEFAULTS.verifierMinutes, 45);
    assert.equal(MAX_MINUTES, 60);
    assert.equal(unquoted({ verifierMinutes: '45' }, 'verifierMinutes'), 45);
    assert.equal(unquoted({ verifierMinutes: ' 60 ' }, 'verifierMinutes'), 60);
    assert.equal(unquoted({ verifierPerHour: '12' }, 'verifierPerHour'), 12);
    assert.equal(unquoted({ flags: 'false' }, 'flags'), false);
    assert.equal(unquoted({ flags: 'TRUE' }, 'flags'), true);
    assert.equal(unquoted({ verifierMinutes: '90' }, 'verifierMinutes'), undefined, 'out of range without quotes too');
    assert.equal(unquoted({ verifierMinutes: '4.5' }, 'verifierMinutes'), undefined, 'not a whole number');
    assert.equal(unquoted({ verifierMinutes: 45 }, 'verifierMinutes'), undefined, 'not in quotes');
    assert.equal(unquoted({ enabled: 'true' }, 'enabled'), undefined, 'a setting of the profile only');
    assert.equal(unquoted({ verifierModel: 'x' }, 'verifierModel'), undefined, 'text is right for a name');
    // The log: each live setting that moved, before and after, in the form's words.
    assert.deepEqual(changesOf({ ...DEFAULTS }, { ...DEFAULTS, verifierMinutes: 60, verifier: 'auto', flags: false }), [
        '“Flag claims with no evidence on their turn” on → off',
        '“Independent check” When I press Check → By itself',
        '“Minutes a check may take” 45 → 60',
    ]);
    assert.deepEqual(changesOf({ ...DEFAULTS }, { ...DEFAULTS, verifierMinutes: '45' }), ['“Minutes a check may take” 45 → "45"'], 'a number in quotes shows its quotes');
    assert.deepEqual(changesOf({ ...DEFAULTS }, { ...DEFAULTS }), []);
    const settings = { ...DEFAULTS };
    const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'proof', logger: {} });
    check.run();
    const before = liveValues(settings);
    settings.verifierMinutes = 60;
    const entry = savedEntry(check, [['verifierMinutes']], { before, after: liveValues(settings) });
    assert.equal(entry.text, 'Settings changed: “Minutes a check may take”');
    assert.equal(entry.why, '“Minutes a check may take” 45 → 60. They apply now.');
    // Without the values (an edit of the profile it did not see before), the entry is as the kit words it.
    assert.equal(savedEntry(check, [['verifierMinutes']]).why, 'They apply now.');
    const wrong = liveValues(settings);
    settings.verifierMinutes = '45';
    const waits = savedEntry(check, [['verifierMinutes']], { before: wrong, after: liveValues(settings) });
    assert.match(waits.text, /Proof waits until a wrong one is fixed/);
    assert.match(waits.why, /^“Minutes a check may take” 60 → "45"\. /);
});
