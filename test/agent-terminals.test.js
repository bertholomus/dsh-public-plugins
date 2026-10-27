// Agent Terminals (plugins/agent-terminals): its launch rules, its transcript readers and status, its typist, the
// stand-in coding agent it is tested with, and its engine end to end over a stand-in DSH terminal controller whose
// "shell" really starts the stand-in agent. index.js, remote.js and the browser half run in real DSH
// (scripts/e2e.mjs agent-terminals).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    STYLES, argvOf, dataFolder, eventsMeta, findNewTranscript, findTranscriptById, folderKey, launchLine, pickShell, programName, shellWord, transcriptPath,
} from '../plugins/agent-terminals/lib/launch.js';
import { Tail, callSummary, closeOver, emptyFold, entriesOf, foldEntry, parseLines, proofs, provenIn, statusOf } from '../plugins/agent-terminals/lib/transcripts.js';
import { askIn } from '../plugins/session-watch/lib/shared/words.js';
import { PASTE_END, PASTE_START, Typist, messageKeys, pasteSwitch } from '../plugins/agent-terminals/lib/typist.js';
import { AgentTerminals, checkLaunch, exitWords, homeForm, listingNote, parseData, programForm, splitArgs } from '../plugins/agent-terminals/lib/agents.js';
import { DEFAULTS, LIVE_SETTINGS, SETTING_TITLES, START_WHYS, STOP_WHYS, changedSince, changedWords, checkConfig, profileEntry, savedEntry, settingsSnapshot, startCause, stopCause } from '../plugins/agent-terminals/lib/config.js';
import { detectAgents, keepsProjects, keepsSessions } from '../plugins/agent-terminals/lib/detect.js';
import { STYLE_CHOICES, pageState } from '../plugins/agent-terminals/lib/page.js';
import { JsonStore } from '../plugins/agent-terminals/lib/shared/files.js';
import { Journal } from '../plugins/agent-terminals/lib/shared/journal.js';
import { SettingsCheck } from '../plugins/agent-terminals/lib/shared/settings.js';
import { tempDir } from './helpers/temp.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'fake-agent.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set();
after(() => {
    for (const child of children) {
        try { child.kill('SIGKILL'); } catch {}
    }
});

async function until(fn, what, timeout = 15000, every = 50) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
        try {
            last = await fn();
            if (last) return last;
        } catch (error) {
            last = error;
        }
        await sleep(every);
    }
    throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

const tmp = (label) => realpathSync(tempDir(`agent-terminals-${label}`));

// ── Launch rules ───────────────────────────────────────────────────────

test('launch: each style starts and resumes with its own arguments, in the right place', () => {
    const flags = { program: 'agent', args: ['--model', 'x'], style: 'flags', conversationId: 'c1' };
    assert.deepEqual(argvOf(flags), ['agent', '--model', 'x', '--session-id', 'c1']);
    assert.deepEqual(argvOf(flags, { resume: true }), ['agent', '--model', 'x', '--resume', 'c1']);
    const sub = { program: 'tool', args: ['--full-auto'], style: 'subcommand' };
    assert.deepEqual(argvOf(sub), ['tool', '--full-auto']);
    assert.equal(argvOf(sub, { resume: true }), undefined, 'no id yet: nothing to resume');
    assert.deepEqual(argvOf({ ...sub, conversationId: 'r9' }, { resume: true }), ['tool', 'resume', 'r9', '--full-auto'], 'a subcommand goes first');
    assert.deepEqual(argvOf({ program: 'oc', args: [], style: 'continue' }, { resume: true }), ['oc', '--continue']);
    assert.deepEqual(argvOf({ program: 'oc', args: [], style: 'continue' }), ['oc']);
    assert.equal(argvOf({ program: 'x', style: 'plain' }, { resume: true }), undefined);
    assert.deepEqual(argvOf({ program: 'x', style: 'nonsense' }), ['x'], 'an unknown style runs the program plainly');
    for (const [id, style] of Object.entries(STYLES)) {
        // Named by how the CLI works; the branding scan in coordinator.test.js keeps product names out.
        assert.ok(style.label && style.detail, `${id} is described in words`);
    }
});

test('launch: the command line is quoted for a POSIX shell, and exec replaces the shell', () => {
    assert.equal(shellWord('plain-word_1.2/x:y=z,@%+'), 'plain-word_1.2/x:y=z,@%+');
    assert.equal(shellWord('two words'), '\'two words\'');
    assert.equal(shellWord('it\'s'), '\'it\'\\\'\'s\'');
    assert.equal(shellWord(''), '\'\'');
    assert.equal(shellWord('~/x'), '\'~/x\'', 'a tilde is not expanded behind the person\'s back');
    assert.equal(shellWord('$(rm -rf /)'), '\'$(rm -rf /)\'');
    assert.equal(launchLine(['/usr/bin/agent', '--name', 'a b']), 'exec /usr/bin/agent --name \'a b\' || exit $?');
    assert.deepEqual(pickShell([{ path: '/bin/fish' }, { path: '/bin/bash' }, { path: '/bin/zsh' }]), { path: '/bin/zsh' }, 'zsh first');
    assert.deepEqual(pickShell([{ path: 'C:/x/pwsh.exe' }, { path: '/usr/bin/bash' }]), { path: '/usr/bin/bash' });
    assert.equal(pickShell([{ path: '/bin/fish' }]), undefined, 'no POSIX shell: nothing to type a command into');
    assert.equal(pickShell(undefined), undefined);
});

test('launch: where a CLI keeps its conversations', () => {
    assert.equal(programName('/usr/local/bin/agent'), 'agent');
    assert.equal(programName(''), 'agent');
    assert.equal(dataFolder({ program: '/opt/bin/tool' }, '/home/me'), '/home/me/.tool');
    assert.equal(dataFolder({ program: 'tool', data: '~/elsewhere' }, '/home/me'), '/home/me/elsewhere');
    assert.equal(folderKey('/Users/me/my app'), '-Users-me-my-app');
    const home = tmp('paths');
    const folder = join(home, 'work');
    mkdirSync(folder);
    const agent = { program: 'agent', style: 'flags', folder, conversationId: 'abc', data: join(home, 'data') };
    assert.equal(transcriptPath(agent, home), join(home, 'data', 'projects', folderKey(folder), 'abc.jsonl'));
    assert.equal(transcriptPath({ ...agent, style: 'plain' }, home), undefined);
    assert.equal(transcriptPath({ ...agent, conversationId: undefined }, home), undefined);
    assert.equal(transcriptPath({ ...agent, style: 'subcommand', transcript: '/x.jsonl' }, home), '/x.jsonl');
});

// ── Transcripts ────────────────────────────────────────────────────────

const at = (s) => new Date(Date.UTC(2026, 9, 17, 3, 0, s)).toISOString();
const msgLine = (type, message, s, extra = {}) => ({ type, message, timestamp: at(s), uuid: `u${s}`, sessionId: 'c1', ...extra });

test('transcripts: a messages-style file reads as user words, calls, results and replies', () => {
    assert.deepEqual(entriesOf('messages', msgLine('user', { role: 'user', content: 'Fix the tests' }, 1)), [{ kind: 'user', at: Date.parse(at(1)), text: 'Fix the tests', key: 'u1' }], 'with the line\'s own id');
    assert.equal(entriesOf('messages', { ...msgLine('user', { role: 'user', content: 'x' }, 1), uuid: undefined })[0].key, undefined, 'a line without an id has none');
    assert.deepEqual(entriesOf('messages', msgLine('user', { role: 'user', content: '<command-name>/clear</command-name>' }, 1)), [], 'a command echo is not the person\'s words');
    assert.deepEqual(entriesOf('messages', msgLine('user', { role: 'user', content: '<system-reminder>x</system-reminder>' }, 1)), [], 'wrapped context is not the person\'s words');
    assert.deepEqual(entriesOf('messages', msgLine('user', { role: 'user', content: 'hi' }, 1, { isMeta: true })), []);
    assert.deepEqual(entriesOf('messages', msgLine('user', { role: 'user', content: 'hi' }, 1, { isSidechain: true })), [], 'a helper\'s side conversation is not the agent\'s');
    const call = entriesOf('messages', msgLine('assistant', { role: 'assistant', content: [{ type: 'text', text: 'Running them.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use' }, 2));
    assert.deepEqual(call.map((e) => e.kind), ['call', 'reply']);
    assert.equal(call[0].summary, 'npm test');
    assert.equal(call[1].final, false, 'a reply with a call is not the last word');
    assert.deepEqual(entriesOf('messages', msgLine('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, 3)).map((e) => e.kind), ['result']);
    const done = entriesOf('messages', msgLine('assistant', { role: 'assistant', content: [{ type: 'text', text: 'All 12 pass.' }], stop_reason: 'end_turn' }, 4));
    assert.equal(done[0].final, true);
    assert.deepEqual(entriesOf('messages', null), []);
    assert.deepEqual(entriesOf('messages', { type: 'summary', summary: 'x' }), []);
    assert.equal(callSummary('{"command":["bash","-lc","ls -la"]}'), 'ls -la');
    assert.equal(callSummary({ file_path: '/a/b.js' }), '/a/b.js');
    assert.equal(callSummary('not json'), 'not json');
});

test('transcripts: an events-style file reads the same way', () => {
    const ev = (type, payload, s) => ({ timestamp: at(s), type, payload });
    assert.deepEqual(entriesOf('events', ev('session_meta', { id: 'r1', cwd: '/w' }, 0)), [{ kind: 'meta', at: Date.parse(at(0)), id: 'r1', cwd: '/w' }]);
    assert.equal(entriesOf('events', ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Go' }] }, 1))[0].text, 'Go');
    assert.deepEqual(entriesOf('events', ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] }, 1)), []);
    assert.equal(entriesOf('events', ev('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","make"]}', call_id: 'f1' }, 2))[0].summary, 'make');
    assert.equal(entriesOf('events', ev('response_item', { type: 'function_call_output', call_id: 'f1', output: 'ok' }, 3))[0].kind, 'result');
    assert.equal(entriesOf('events', ev('event_msg', { type: 'task_complete', last_agent_message: 'Built.' }, 4))[0].final, true);
    assert.equal(entriesOf('events', ev('event_msg', { type: 'turn_aborted' }, 4))[0].final, false);
    assert.equal(entriesOf('events', ev('event_msg', { type: 'exec_approval_request', call_id: 'f2', command: ['rm', '-rf', 'build'] }, 5))[0].kind, 'approval');
    assert.deepEqual(entriesOf('events', ev('event_msg', { type: 'token_count' }, 5)), []);
});

test('transcripts: the fold says what the agent does now', () => {
    const now = Date.parse(at(10));
    let fold = emptyFold();
    assert.equal(statusOf(fold, { now }).status, 'starting');
    assert.equal(statusOf(fold, { now, exited: true }).status, 'stopped');
    assert.equal(statusOf(fold, { now, transcript: false }).status, 'running');
    fold = foldEntry(fold, { kind: 'user', at: now - 5000, text: 'Fix the tests' });
    assert.equal(statusOf(fold, { now }).status, 'working');
    assert.match(statusOf(fold, { now }).detail, /Fix the tests/);
    fold = foldEntry(fold, { kind: 'call', at: now - 4000, callId: 't1', tool: 'Bash', summary: 'npm test' });
    assert.deepEqual([statusOf(fold, { now, askAfterMs: 20000 }).status, statusOf(fold, { now, askAfterMs: 20000 }).detail], ['working', 'Running Bash: npm test']);
    const asking = statusOf(fold, { now, askAfterMs: 3000 });
    assert.equal(asking.status, 'waiting on you', 'a call that waits long is most likely an approval prompt');
    assert.equal(asking.call.callId, 't1');
    fold = foldEntry(fold, { kind: 'result', at: now - 3000, callId: 't1' });
    fold = foldEntry(fold, { kind: 'reply', at: now - 2900, text: 'Done: all pass.', final: false });
    assert.equal(statusOf(fold, { now, settleMs: 4000 }).status, 'working', 'a reply not yet settled may go on');
    assert.equal(statusOf(fold, { now: now + 5000, settleMs: 4000 }).status, 'idle');
    fold = foldEntry(fold, { kind: 'reply', at: now - 2800, text: 'One more line.', final: true });
    assert.equal(fold.reply.text, 'Done: all pass.\nOne more line.', 'a reply said in parts is one reply');
    assert.equal(statusOf(fold, { now }).status, 'idle');
    fold = foldEntry(fold, { kind: 'user', at: now - 2000, text: 'Ship it?' });
    fold = foldEntry(fold, { kind: 'reply', at: now - 1000, text: 'Ready.\nDECISION NEEDED: Deploy now? — recommend: Yes, deploy', final: true });
    const waiting = statusOf(fold, { now });
    assert.equal(waiting.status, 'waiting on you');
    assert.equal(waiting.ask.recommendation, 'Yes, deploy');
    fold = foldEntry(fold, { kind: 'user', at: now - 900, text: 'Yes' });
    fold = foldEntry(fold, { kind: 'reply', at: now - 800, text: 'Deployed. Let me know if you want the docs updated too.', final: true });
    assert.equal(statusOf(fold, { now }).status, 'idle', 'an offer waits on nobody');
    fold = foldEntry(fold, { kind: 'approval', at: now - 100, summary: 'rm -rf build', callId: 'f9' });
    assert.equal(statusOf(fold, { now }).status, 'waiting on you');
    assert.equal(statusOf(fold, { now }).call.approval, true);
    fold = foldEntry(fold, { kind: 'result', at: now, callId: 'f9' });
    assert.equal(fold.approval, undefined, 'answered');
    assert.equal(fold.turns, 3);
    const same = foldEntry(fold, { kind: 'user', at: now + 5000, text: 'Yes' });
    assert.equal(same.turns, 4, 'the same words later are a new message');
    const echo = foldEntry(same, { kind: 'user', at: now + 5000, text: 'Yes' });
    assert.equal(echo.turns, 4, 'one line read twice (the same words at the same moment) is one message');
    const quick = foldEntry(same, { kind: 'user', at: now + 5400, text: 'Yes' });
    assert.deepEqual([quick.turns, quick.users.length - same.users.length], [5, 1], 'the same words sent again a moment later are a message of their own');
    const keyed = foldEntry(foldEntry(fold, { kind: 'user', at: now + 6000, text: 'Go', key: 'line-a' }), { kind: 'user', at: now + 6001, text: 'Go', key: 'line-a' });
    assert.equal(keyed.turns, 4, 'the same line id twice is one message');
    const twoLines = foldEntry(foldEntry(fold, { kind: 'user', at: now + 6000, text: 'Go', key: 'line-a' }), { kind: 'user', at: now + 6000, text: 'Go', key: 'line-b' });
    assert.equal(twoLines.turns, 5, 'two line ids are two messages, even at the same moment');
    assert.equal(foldEntry(fold, { kind: 'unknown' }), fold);
});

test('transcripts: what a program left open when it ended is closed, and a job it was on is said cut off', () => {
    const now = Date.parse(at(10));
    let fold = emptyFold();
    fold = foldEntry(fold, { kind: 'user', at: now - 9000, text: 'Refactor the parser' });
    fold = foldEntry(fold, { kind: 'reply', at: now - 8000, text: 'Done.', final: true });
    assert.equal(closeOver(fold), fold, 'nothing open: the same fold');
    // Mid-job: a message with no answer, and a call waiting.
    fold = foldEntry(fold, { kind: 'user', at: now - 5000, text: 'Now run the migration' });
    fold = foldEntry(fold, { kind: 'call', at: now - 4000, callId: 'c1', tool: 'Bash', summary: 'npm run migrate' });
    fold = foldEntry(fold, { kind: 'approval', at: now - 3900, summary: 'npm run migrate', callId: 'c1' });
    fold = foldEntry(fold, { kind: 'meta', at: now - 3800, id: 'conv-1' });
    assert.equal(statusOf(fold, { now }).status, 'waiting on you');
    const closed = closeOver(fold);
    assert.deepEqual([Object.keys(closed.calls).length, closed.approval, closed.ended], [0, undefined, true]);
    assert.deepEqual(closed.cut, { at: now - 3900, text: 'Now run the migration' });
    const cut = statusOf(closed, { now });
    assert.equal(cut.status, 'idle', 'not working, not waiting on you');
    assert.match(cut.detail, /^Its job “Now run the migration” was cut off when its program ended \(a DSH restart, or a stop\)\. Send it a message to carry on\.$/);
    // Entries from the program running now stay open; older ones are closed.
    const mixed = foldEntry(closed, { kind: 'user', at: now + 1000, text: 'Carry on' });
    assert.equal(mixed.cut, undefined, 'new work: the cut job is history');
    const busy = foldEntry(mixed, { kind: 'call', at: now + 2000, callId: 'c2', tool: 'Bash', summary: 'ls' });
    assert.equal(closeOver(busy, now), busy, 'nothing from before the start is open');
    assert.equal(statusOf(closeOver(busy, now), { now: now + 2500 }).status, 'working');
    // A file that replays the old conversation with its old times: closed against the start.
    const replay = closeOver(fold, now);
    assert.equal(replay.cut.text, 'Now run the migration');
    // A job that ended before the program did is not cut.
    let finished = foldEntry(emptyFold(), { kind: 'user', at: now - 2000, text: 'Hi' });
    finished = foldEntry(finished, { kind: 'end', at: now - 1000, text: 'Hello.' });
    assert.equal(closeOver(finished).cut, undefined);
    assert.equal(closeOver(undefined), undefined);
});

test('transcripts: proof is the agent\'s own transcript showing the words, after they were typed', () => {
    let fold = emptyFold();
    fold = foldEntry(fold, { kind: 'user', at: 1000, text: 'Please   run\nthe tests' });
    assert.ok(provenIn(fold, 'Please run the tests', 1000));
    assert.ok(provenIn(fold, 'Please run the tests', 2500), 'a little clock skew is allowed');
    assert.equal(provenIn(fold, 'Please run the tests', 10000), undefined, 'an older message with the same words is no proof');
    assert.equal(provenIn(fold, 'Something else', 0), undefined);
    assert.equal(provenIn(fold, '   ', 0), undefined);
    const long = 'x'.repeat(500);
    fold = foldEntry(fold, { kind: 'user', at: 2000, text: `${long} (trimmed by the CLI)` });
    assert.ok(provenIn(fold, long, 2000), 'the first 160 characters are enough');
});

test('transcripts: one line proves one message, the oldest first, so the same words sent twice need two lines', () => {
    const user = (at, text, key) => ({ kind: 'user', at, text, ...(key ? { key } : {}) });
    // Round 4: "dup two" sent twice back to back; the agent has read only the first.
    let fold = foldEntry(emptyFold(), user(1000, 'dup two #work=6000', 'L1'));
    const both = [{ id: 'm1', text: 'dup two #work=6000', since: 900 }, { id: 'm2', text: 'dup two #work=6000', since: 1300 }];
    let found = proofs(fold, both);
    assert.deepEqual([found.get('m1')?.key, found.has('m2')], ['L1', false], 'the first line proves the first message only, though it is within 2 s of the second');
    found = proofs(fold, [both[1]], [{ key: 'L1', from: 0, to: 18 }]);
    assert.equal(found.has('m2'), false, 'a line a delivered message was proven by proves nothing more');
    fold = foldEntry(fold, user(7000, 'dup two #work=6000', 'L2'));
    found = proofs(fold, [both[1]], [{ key: 'L1', from: 0, to: 18 }]);
    assert.deepEqual([found.get('m2')?.key, found.get('m2')?.at], ['L2', 7000], 'the second is proven by its own line');
    found = proofs(fold, both);
    assert.deepEqual([found.get('m1')?.key, found.get('m2')?.key], ['L1', 'L2'], 'each message its own line, the oldest first');
    // Order: the oldest message gets the first line, whatever order they are asked in.
    found = proofs(fold, [both[1], both[0]]);
    assert.deepEqual([found.get('m1')?.key, found.get('m2')?.key], ['L1', 'L2']);
    // A message inside an earlier one's words: not proven by that line.
    let inner = foldEntry(emptyFold(), user(1000, 'fix the build, then run the tests', 'B1'));
    const contained = [{ id: 'a', text: 'fix the build, then run the tests', since: 900 }, { id: 'b', text: 'run the tests', since: 1500 }];
    found = proofs(inner, contained);
    assert.deepEqual([found.has('a'), found.has('b')], [true, false], 'the line holds the first message whole');
    inner = foldEntry(inner, user(2500, 'run the tests', 'B2'));
    assert.equal(proofs(inner, contained).get('b')?.key, 'B2', 'proven by its own line');
    // Two messages that went in as one line (the first sat in the input box when the second was typed): both.
    const merged = foldEntry(emptyFold(), user(5000, 'dup dup', 'M1'));
    found = proofs(merged, [{ id: 'x', text: 'dup', since: 4000 }, { id: 'y', text: 'dup', since: 4500 }]);
    assert.deepEqual([found.get('x')?.from, found.get('y')?.from], [0, 4], 'each one place in the line');
    assert.equal(proofs(merged, [{ id: 'z', text: 'dup', since: 4000 }], [{ key: 'M1', from: 0, to: 3 }, { key: 'M1', from: 4, to: 7 }]).has('z'), false, 'no third place');
    // The 2 s allowance is for a line no earlier message claims; later than that, never.
    const early = foldEntry(emptyFold(), user(1000, 'Please run the tests'));
    assert.ok(proofs(early, [{ id: 'p', text: 'Please run the tests', since: 2900 }]).has('p'), 'a line 1.9 s before the typing, unclaimed: proof (clocks)');
    assert.equal(proofs(early, [{ id: 'p', text: 'Please run the tests', since: 3100 }]).has('p'), false, 'more than 2 s before: an older message');
    // A state file from before kept only the proof's time: that line stays its message's.
    assert.equal(proofs(fold, [both[1]], [{ at: 1000, text: 'dup two #work=6000' }]).get('m2')?.key, 'L2', 'an older delivery\'s line, found by its time');
    // Lines without an id are told apart by their time.
    const plainLines = foldEntry(foldEntry(emptyFold(), user(1000, 'go')), user(1400, 'go'));
    found = proofs(plainLines, [{ id: 'g1', text: 'go', since: 900 }, { id: 'g2', text: 'go', since: 1200 }]);
    assert.deepEqual([found.get('g1')?.at, found.get('g2')?.at], [1000, 1400]);
    assert.deepEqual(proofs(undefined, both), new Map(), 'no transcript, no proof');
    assert.deepEqual(proofs(fold, [{ id: 'e', text: '  ', since: 0 }]), new Map(), 'no words, no proof');
});

test('transcripts: a call waiting for its result is said in steps, so its line does not change every few seconds', () => {
    let fold = emptyFold();
    fold = foldEntry(fold, { kind: 'user', at: 1000, text: 'go' });
    fold = foldEntry(fold, { kind: 'call', at: 2000, callId: 'c1', tool: 'Bash', summary: 'touch a' });
    const detail = (ms) => statusOf(fold, { now: 2000 + ms, askAfterMs: 20000 }).detail;
    assert.equal(detail(5000), 'Running Bash: touch a');
    assert.equal(detail(21000), 'Bash “touch a” has waited 20 s or more for its result: it may be asking you in its terminal.');
    assert.equal(detail(45000), detail(21000), 'the same line until a minute has passed');
    assert.equal(detail(61000), 'Bash “touch a” has waited 1 min for its result: it may be asking you in its terminal.');
    assert.equal(detail(150000), 'Bash “touch a” has waited 2 min for its result: it may be asking you in its terminal.');
});

test('transcripts: a file is read as it grows, whole lines only', () => {
    const dir = tmp('tail');
    const file = join(dir, 't.jsonl');
    const tail = new Tail(file);
    assert.deepEqual(tail.read(), { lines: [], reset: false }, 'no file yet');
    writeFileSync(file, '{"a":1}\n{"b":');
    assert.deepEqual(tail.read().lines, ['{"a":1}']);
    appendFileSync(file, '2}\n\n');
    assert.deepEqual(tail.read().lines, ['{"b":2}']);
    assert.deepEqual(tail.read().lines, []);
    writeFileSync(file, '{"c":3}\n');
    const again = tail.read();
    assert.equal(again.reset, true, 'a file that shrank is read again');
    assert.deepEqual(again.lines, ['{"c":3}']);
    writeFileSync(file, '{"skip":"me"}\n{"keep":1}\n');
    assert.deepEqual(new Tail(file, { maxBytes: 12 }).read().lines, ['{"keep":1}'], 'only the end of a big file, from its next whole line');
    assert.deepEqual(new Tail(file, { maxBytes: 11 }).read().lines, ['{"keep":1}'], 'a cut right after a line break keeps the line');
    writeFileSync(file, '{"skip":"me"}\n{"keep":1}');
    const cut = new Tail(file, { maxBytes: 4 });
    assert.deepEqual(cut.read().lines, [], 'a cut into a line still being written');
    appendFileSync(file, '\n{"next":2}\n');
    assert.deepEqual(cut.read().lines, ['{"next":2}'], 'the cut line is never read as a whole one');
    assert.deepEqual(parseLines('messages', ['not json', JSON.stringify(msgLine('user', { role: 'user', content: 'hi' }, 1))]).map((e) => e.text), ['hi']);
});

// ── Typist ─────────────────────────────────────────────────────────────

test('typist: a message is pasted when the program asked for it, else typed with its lines joined', () => {
    assert.deepEqual(messageKeys('one line', true), { data: `${PASTE_START}one line${PASTE_END}`, paste: true, flattened: false });
    assert.deepEqual(messageKeys('a\nb', true), { data: `${PASTE_START}a\rb${PASTE_END}`, paste: true, flattened: false }, 'line breaks in a paste go as a terminal sends them');
    assert.deepEqual(messageKeys('one line', false), { data: 'one line', paste: false, flattened: false });
    assert.deepEqual(messageKeys('a\n\nb', false), { data: 'a b', paste: false, flattened: true }, 'a line break would send it early');
    assert.deepEqual(messageKeys('one line', undefined).paste, false, 'unknown: one line is safe as keys');
    assert.deepEqual(messageKeys('a\nb', undefined).paste, true, 'unknown: more lines need a paste');
    assert.equal(messageKeys('esc\x1b[201~ape', true).data, `${PASTE_START}esc[201~ape${PASTE_END}`, 'a message cannot end the paste early');
    assert.deepEqual(messageKeys('stop\x03 now\x04 and\x7f\x9b go\tthere', false), { data: 'stop now and go\tthere', paste: false, flattened: false }, 'no control key goes in typed as keys: only tabs and line breaks stay');
    assert.equal(messageKeys('a\x1a\nb', true).data, `${PASTE_START}a\rb${PASTE_END}`);
    assert.equal(pasteSwitch('x\x1b[?2004hy\x1b[?2004l'), false);
    assert.equal(pasteSwitch('\x1b[?2004h'), true);
    assert.equal(pasteSwitch('nothing'), undefined);
});

test('typist: direct typing goes into the terminal\'s process without taking the tab\'s control', async () => {
    const writes = [];
    const terminal = { info: { state: 'running' }, handle: { write: async (data) => { writes.push(data); } }, screen: { modes: { bracketedPasteMode: true }, rows: 2, buffer: { active: { baseY: 0, getLine: (y) => ({ translateToString: () => ['› ', ''][y] }) } } } };
    const controller = { owners: new Map([['s1', { terminals: new Map([['t1', terminal]]) }]]) };
    const typist = new Typist({ controller: () => controller, wait: async () => {} });
    assert.deepEqual(typist.way('s1', 't1'), { way: 'direct' });
    assert.equal(typist.pasteMode('s1', 't1'), true);
    assert.deepEqual(typist.screenLines('s1', 't1'), ['› ', '']);
    const typed = await typist.type({ id: 's1' }, 't1', 'Hello');
    assert.deepEqual(typed, { way: 'direct', paste: true, flattened: false });
    assert.deepEqual(writes, [`${PASTE_START}Hello${PASTE_END}`, '\r']);
    writes.length = 0;
    await typist.write({ id: 's1' }, 't1', 'y'.repeat(2500));
    assert.deepEqual(writes.map((w) => w.length), [1024, 1024, 452], 'long input goes in pieces');
    await assert.rejects(typist.type({ id: 's1' }, 't1', 'z'.repeat(40 * 1024)), /longer than 32 KB/);
    terminal.info.state = 'exited';
    assert.match(typist.way('s1', 't1').problem, /no way to type/);
    const forced = new Typist({ controller: () => ({ owners: controller.owners }), method: () => 'attached' });
    terminal.info.state = 'running';
    assert.match(forced.way('s1', 't1').problem, /no terminal input for plugins/);
});

test('typist: the attached way takes the input, learns the paste mode, and lets go', async () => {
    const writes = [];
    const ended = [];
    const controller = {
        follow(agent, id, attachmentId, signal) {
            return (async function* () {
                yield { type: 'snapshot', sequence: 0, screen: 'prompt\x1b[?2004h', info: { controllerId: attachmentId } };
                await new Promise((resolve) => signal.addEventListener('abort', resolve));
                ended.push(attachmentId);
            })();
        },
        async write(agent, id, attachmentId, data) { writes.push([attachmentId, data]); },
    };
    const typist = new Typist({ controller: () => controller, wait: async () => {} });
    assert.deepEqual(typist.way('s1', 't1'), { way: 'attached' });
    const typed = await typist.type({ id: 's1' }, 't1', 'Hi');
    assert.equal(typed.way, 'attached');
    assert.equal(typed.paste, true, 'the paste mode came from the screen it got');
    assert.equal(writes.length, 2);
    assert.equal(writes[0][1], `${PASTE_START}Hi${PASTE_END}`);
    assert.ok(typist.takenAt('s1', 't1') > 0, 'the window is told it lost control, to take it back');
    typist.release('s1', 't1');
    await sleep(10);
    assert.equal(ended.length, 1, 'the attachment ended');
});

// ── Settings, page, detection, input checks ───────────────────────────

test('config: every setting is checked in words, and a save says what changed', () => {
    assert.doesNotThrow(() => checkConfig({ ...DEFAULTS }));
    assert.throws(() => checkConfig({ ...DEFAULTS, proofSeconds: 1 }), /Seconds without proof before Enter is pressed again \(proofSeconds\) must be a whole number of seconds from 2 to 120 \(it is 1\)/);
    assert.throws(() => checkConfig({ ...DEFAULTS, enterRetries: 9 }), /from 0 to 5/);
    assert.throws(() => checkConfig({ ...DEFAULTS, typing: 'fast' }), /"auto", "direct" or "attached"/);
    assert.throws(() => checkConfig({ ...DEFAULTS, notify: 'yes' }), /true or false/);
    for (const key of LIVE_SETTINGS) assert.ok(SETTING_TITLES[key], `${key} has a title`);
    assert.equal(changedWords([['openTabs'], ['proofSeconds']]), '“Open an agent\'s terminal tab with its session”, “Seconds without proof before Enter is pressed again”');
    const settings = { ...DEFAULTS };
    const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'agent-terminals' });
    check.run();
    settings.proofSeconds = 500;
    assert.match(savedEntry(check, [['proofSeconds']]).text, /waits until a wrong one is fixed/);
    settings.proofSeconds = 8;
    assert.match(savedEntry(check, [['proofSeconds']]).text, /Settings fixed/);
    assert.equal(savedEntry(check, []), undefined);
});

test('config: every key of its schema takes any value, so a wrong type in the profile is said in words and never stops it at start', () => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'agent-terminals', 'lib', 'index.js'), 'utf8');
    const start = text.indexOf('export const Config = z.object({');
    assert.ok(start >= 0, 'lib/index.js has a Config schema');
    const block = text.slice(start, text.indexOf('\n});', start)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const keys = [...block.matchAll(/^\s+(\w+):\s*(.+?),?\s*$/gm)].map(([, key, schema]) => ({ key, schema }));
    assert.deepEqual(keys.map((k) => k.key).sort(), Object.keys(DEFAULTS).sort(), 'DEFAULTS lists every key of its schema');
    for (const { key, schema } of keys) {
        assert.match(schema, /^(?:live\()?z\.any\(\)\.default\(.+\)\)?$/, `${key} is ${schema}`);
        assert.equal(schema.startsWith('live('), LIVE_SETTINGS.includes(key), `${key}: live in the schema exactly when its page can change it`);
        assert.deepEqual(JSON.parse(schema.match(/\.default\((.+?)\)\)?$/)[1].replace(/'/g, '"')), DEFAULTS[key], `${key}: the schema's default is the one in DEFAULTS`);
    }
    // A number in quotes, "yes" for a switch, a number for a choice: each is named, with the value as the profile has it.
    const wrong = (value) => (typeof value === 'boolean' ? (value ? 'yes' : 'no') : typeof value === 'number' ? String(value) : 5);
    for (const key of Object.keys(DEFAULTS)) {
        const value = wrong(DEFAULTS[key]);
        assert.throws(() => checkConfig({ ...DEFAULTS, [key]: value }), (error) => {
            assert.equal(error.name, 'SettingError', key);
            assert.equal(error.key, key, key);
            assert.ok(error.message.startsWith(`${SETTING_TITLES[key]} (${key}) must be `), error.message);
            assert.ok(error.message.endsWith(`(it is ${JSON.stringify(value)})`), error.message);
            return true;
        }, `${key} = ${JSON.stringify(value)}`);
    }
    assert.throws(() => checkConfig({ ...DEFAULTS, proofSeconds: '8' }), /^SettingError: Seconds without proof before Enter is pressed again \(proofSeconds\) must be a whole number of seconds from 2 to 120 \(it is "8"\)$/);
});

test('config: an edit of DSH\'s profile is said once, at the start that has it, with what changed', () => {
    const run = (settings) => {
        const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'agent-terminals' });
        check.run();
        return check;
    };
    const first = settingsSnapshot({ ...DEFAULTS });
    assert.deepEqual(Object.keys(first).sort(), Object.keys(SETTING_TITLES).sort(), 'every setting is kept');
    // Never ran here (or an older state.json): nothing to compare, nothing said.
    assert.deepEqual(changedSince(undefined, first), []);
    assert.equal(profileEntry(run({ ...DEFAULTS }), changedSince(undefined, first), DEFAULTS), undefined);
    // The same settings again: nothing said.
    assert.deepEqual(changedSince(first, settingsSnapshot({ ...DEFAULTS })), []);
    // typing changed in the profile: said by its title; Agent Terminals started again with it.
    const typed = { ...DEFAULTS, typing: 'direct' };
    const keys = changedSince(first, settingsSnapshot(typed));
    assert.deepEqual(keys, ['typing']);
    assert.deepEqual(profileEntry(run(typed), keys, typed), { kind: 'settings', text: 'Settings changed in DSH\'s profile: “How messages are typed in”', why: 'Agent Terminals started again with them.', state: 'done' });
    // Switched off there: said, and what that means.
    const off = { ...DEFAULTS, enabled: false };
    assert.equal(profileEntry(run(off), changedSince(first, settingsSnapshot(off)), off).why, 'Agent Terminals is switched off there (enabled: false): it starts, reads and types nothing.');
    // A wrong type there: named, with the value as the profile has it.
    const quoted = { ...DEFAULTS, proofSeconds: '8' };
    const wrong = profileEntry(run(quoted), changedSince(first, settingsSnapshot(quoted)), quoted);
    assert.equal(wrong.text, 'Settings changed in DSH\'s profile: “Seconds without proof before Enter is pressed again”; Agent Terminals waits until a wrong one is fixed');
    assert.equal(wrong.why, 'Seconds without proof before Enter is pressed again (proofSeconds) must be a whole number of seconds from 2 to 120 (it is "8").');
    assert.equal(wrong.state, 'waiting on a setting');
    // A setting a newer version added is not "changed" against an older snapshot.
    const { notify: _, ...older } = first;
    assert.deepEqual(changedSince(older, settingsSnapshot({ ...DEFAULTS, notify: false })), []);
    // state.json keeps the snapshot (and only setting-like keys).
    const kept = parseData({ agents: {}, recent: [], settings: { ...first, 'bad key': 1 } }).settings;
    assert.deepEqual(kept, first);
    assert.equal(parseData({ agents: {}, recent: [] }).settings, undefined);
});

test('start form: what is sent is checked in words', () => {
    const home = tmp('form');
    mkdirSync(join(home, 'app'));
    assert.throws(() => checkLaunch({}, { home }), /Name the program/);
    assert.throws(() => checkLaunch({ program: 'a\nb', style: 'flags', folder: home }, { home }), /one line/);
    assert.throws(() => checkLaunch({ program: 'my agent', style: 'flags', folder: home }, { home }), /one word/);
    assert.throws(() => checkLaunch({ program: 'agent', style: 'odd', folder: home }, { home }), /flags, subcommand, continue, plain/);
    assert.throws(() => checkLaunch({ program: 'agent', style: 'flags' }, { home }), /Choose the folder/);
    assert.throws(() => checkLaunch({ program: 'agent', style: 'flags', folder: 'rel/path' }, { home }), /full path/);
    assert.throws(() => checkLaunch({ program: 'agent', style: 'flags', folder: join(home, 'none') }, { home }), /^Error: There is no folder at ~\/none: create it first, or choose another\.$/, 'a folder under the home folder as people read it');
    assert.throws(() => checkLaunch({ program: 'agent', style: 'flags', folder: home, data: 'rel' }, { home }), /full path, such as ~\/.agent/);
    assert.throws(() => checkLaunch({ program: 'agent', style: 'flags', folder: home, args: '--x "open' }, { home }), /not closed/);
    const spec = checkLaunch({ program: 'agent', style: 'flags', folder: '~/app', args: '--model "big one" -v', task: '  Fix it  ' }, { home });
    assert.deepEqual(spec, { program: 'agent', args: ['--model', 'big one', '-v'], style: 'flags', folder: join(home, 'app'), name: 'agent · app', task: 'Fix it' });
    assert.equal(checkLaunch({ program: 'agent', style: 'plain', sessionId: 's1' }).folder, undefined, 'a session brings its own folder');
    // The start line quotes every word, and a quoted ~ is not the home folder: a ~/ program is kept as its full path.
    assert.equal(checkLaunch({ program: '~/bin/agent', style: 'plain', folder: home }, { home }).program, join(home, 'bin', 'agent'));
    assert.equal(checkLaunch({ program: '~', style: 'plain', folder: home }, { home }).program, home);
    assert.deepEqual(splitArgs(`a 'b c' "" d`), ['a', 'b c', '', 'd']);
});

test('detect: coding agents are found by the conversations they keep, not by name', () => {
    const home = tmp('detect');
    mkdirSync(join(home, '.alpha', 'projects', '-w-app'), { recursive: true });
    writeFileSync(join(home, '.alpha', 'projects', '-w-app', 'c1.jsonl'), '{}\n');
    mkdirSync(join(home, '.beta', 'sessions', '2026', '10', '17'), { recursive: true });
    writeFileSync(join(home, '.beta', 'sessions', '2026', '10', '17', 'rollout-x-r1.jsonl'), '{}\n');
    mkdirSync(join(home, '.gamma', 'projects'), { recursive: true });
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'alpha'), '#!/bin/sh\n');
    import('node:fs').then(({ chmodSync }) => chmodSync(join(home, '.local', 'bin', 'alpha'), 0o755));
    assert.ok(keepsProjects(join(home, '.alpha')));
    assert.equal(keepsProjects(join(home, '.gamma')), undefined, 'an empty projects folder is not an agent');
    assert.ok(keepsSessions(join(home, '.beta')));
    // A second folder of a program (a backup, another profile) is not a program; one named like an installed program is.
    for (const name of ['.alpha-backup', '.delta-cli']) {
        mkdirSync(join(home, name, 'projects', '-w-app'), { recursive: true });
        writeFileSync(join(home, name, 'projects', '-w-app', 'c1.jsonl'), '{}\n');
    }
    writeFileSync(join(home, '.local', 'bin', 'delta-cli'), '#!/bin/sh\n', { mode: 0o755 });
    const found = detectAgents(home, { path: '' });
    assert.deepEqual(found.map((f) => [f.program, f.style]).sort(), [['alpha', 'flags'], ['beta', 'subcommand'], ['delta-cli', 'flags']]);
});

test('page: its state reads in one go, and says what is wrong', async () => {
    const journal = new Journal(join(tmp('page'), 'events.jsonl'));
    journal.add({ kind: 'start', text: 'Started x', why: 'You did.' });
    const state = await pageState({
        agents: { list: () => [{ key: 'a' }], recent: [] },
        journal,
        config: { ...DEFAULTS },
        check: { ok: false, problem: { text: 'x must be y', key: 'proofSeconds', live: true } },
        watch: { settings: {} },
        terminals: () => undefined,
        detected: async () => [{ program: 'alpha' }],
        workspaces: () => [{ path: '/w', title: 'w' }],
    });
    assert.equal(state.problem.key, 'proofSeconds');
    assert.equal(state.terminals, false);
    assert.equal(state.agents.length, 1);
    assert.equal(state.history[0].text, 'Started x');
    assert.equal(state.styles.length, 4);
    assert.deepEqual(STYLE_CHOICES.map((s) => s.id), ['flags', 'subcommand', 'continue', 'plain']);
});

test('saved state: a broken or older file never stops it', () => {
    assert.deepEqual(parseData(undefined), { version: 1, agents: {}, recent: [] });
    assert.deepEqual(parseData({ agents: { 'bad key!': { sessionId: 's', program: 'x' }, ok: { program: 'x' } } }).agents, {});
    const data = parseData({ agents: { k1: { sessionId: 's1', program: 'agent', style: 'weird', launches: -1, deliveries: [{ id: 'm', text: 't', state: 'typing' }, { id: 'n', state: 'queued' }] } } });
    assert.equal(data.agents.k1.style, 'plain');
    assert.equal(data.agents.k1.launches, 1);
    assert.equal(data.agents.k1.terminalId, 'agent-k1-1');
    assert.deepEqual(data.agents.k1.deliveries.map((d) => [d.id, d.state]), [['m', 'queued']], 'a message cut off while typed is typed again');
    assert.match(exitWords({ program: 'nope' }, 127), /could not find nope/);
    assert.match(exitWords({ program: '/opt/bin/nope' }, 127), /“which nope” in a terminal shows it/);
    assert.doesNotMatch(exitWords({ program: 'nope' }, 127), /`/, 'no code marks in words people read');
    assert.match(exitWords({ program: 'x' }, 0, 'Start again runs it anew.'), /runs it anew/);
    // What the program printed last says why it ended; nothing points at a terminal that may be gone.
    assert.equal(exitWords({ program: 'x' }, 1, 'Start again resumes its conversation.', 'No conversation found with session ID: c1'), 'It exited with code 1: “No conversation found with session ID: c1”. Start again resumes its conversation.');
    assert.equal(exitWords({ program: 'x' }, 1, 'Start again resumes its conversation.'), 'It exited with code 1. Start again resumes its conversation.');
    assert.equal(parseData({ agents: { k2: { sessionId: 's2', program: 'agent', cutAt: 42 } } }).agents.k2.cutAt, 42, 'the job cut last is kept, so it is logged once');
});

test('words: paths read as people read them (~/… under the home folder), a program given by name stays its name', () => {
    assert.equal(homeForm('/Users/a/Projects/app', '/Users/a'), '~/Projects/app');
    assert.equal(homeForm('/Users/a', '/Users/a/'), '~');
    assert.equal(homeForm('/Users/ab/x', '/Users/a'), '/Users/ab/x', 'a folder that only starts with the same letters is not under it');
    assert.equal(homeForm('/opt/tool', '/Users/a'), '/opt/tool');
    assert.equal(homeForm('/Users/a/x', undefined), '/Users/a/x', 'no home folder known: as it is');
    assert.equal(homeForm('', '/Users/a'), '');
    assert.equal(programForm('/Users/a/.local/bin/agent', '/Users/a'), '~/.local/bin/agent');
    assert.equal(programForm('agent', '/Users/a'), 'agent');
    // Exit words name the program as people read it, and keep the name for "which".
    assert.equal(exitWords({ program: '/Users/a/bin/nope' }, 127, undefined, undefined, '/Users/a'), 'It exited with code 127: the shell could not find ~/bin/nope. Use its full path (“which nope” in a terminal shows it), or check the name.');
    assert.match(exitWords({ program: '/Users/a/bin/nope' }, 126, undefined, undefined, '/Users/a'), /^It exited with code 126: ~\/bin\/nope is not a program/);
});

test('listing note: its model gets the one line to answer and is told no answer is needed, so its reply asks nothing', () => {
    const note = listingNote({ program: '/Users/a/.local/bin/agent', folder: '/Users/a/Projects/app' }, '/Users/a');
    assert.equal(note, 'A coding agent runs in this session\'s terminal tab: agent in ~/Projects/app, started by Agent Terminals. This message only lets DSH list the session in its sidebar: there is no task here, and no answer is needed. Reply with exactly this one line and nothing else: The coding agent runs in its terminal tab.');
    // Session Watch counts a DECISION NEEDED line, or a question, in a reply's last lines as asking: the note names neither, so a model that echoes it asks nobody.
    assert.doesNotMatch(note, /DECISION NEEDED|BLOCKED|\?/);
    assert.match(listingNote({ program: 'agent', folder: '' }, '/Users/a'), /: agent in this session's folder, started by/);
    // Session Watch reads what a reply asks with askIn: the line it is told to answer, the note said back, and the note's own words in other words ask nothing.
    for (const reply of ['The coding agent runs in its terminal tab.', note, 'Noted: there is no task here, and no answer is needed.\nThe coding agent runs in its terminal tab.', 'Understood. No answer is needed from anyone.']) {
        assert.equal(askIn(reply), undefined, reply);
    }
});

// ── The stand-in agent on its own ──────────────────────────────────────

function runFake(args, cwd) {
    const child = spawn(process.execPath, [FAKE, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', () => children.delete(child));
    return { child, out: () => out, type: (data) => child.stdin.write(data) };
}

test('stand-in agent: a pasted message and its Enter make one transcript entry and a reply', async () => {
    const dir = tmp('fake-flags');
    const fake = runFake(['--style', 'flags', '--data', join(dir, 'data'), '--session-id', 'c1'], dir);
    await until(() => fake.out().includes('›'), 'its prompt');
    fake.type(`${PASTE_START}#work=20 line one\rline two${PASTE_END}`);
    await sleep(50);
    fake.type('\r');
    const file = join(dir, 'data', 'projects', folderKey(dir), 'c1.jsonl');
    const lines = await until(() => existsSync(file) && readFileSync(file, 'utf8').split('\n').filter(Boolean).length >= 2 && readFileSync(file, 'utf8').split('\n').filter(Boolean), 'the reply');
    const entries = parseLines('messages', lines);
    assert.equal(entries[0].text, '#work=20 line one\nline two', 'one message, both lines');
    assert.match(entries.at(-1).text, /^Done: line one/);
    fake.type('\x04');
    await until(() => fake.child.exitCode === 0, 'it to quit on Ctrl-D');
});

test('stand-in agent: with --swallow-enter the first Enter after a paste is lost, the second sends', async () => {
    const dir = tmp('fake-swallow');
    const fake = runFake(['--style', 'flags', '--data', join(dir, 'data'), '--session-id', 'c2', '--swallow-enter'], dir);
    await until(() => fake.out().includes('›'), 'its prompt');
    fake.type(`${PASTE_START}#work=10 hello${PASTE_END}`);
    await sleep(30);
    fake.type('\r');
    await sleep(300);
    const file = join(dir, 'data', 'projects', folderKey(dir), 'c2.jsonl');
    assert.equal(existsSync(file), false, 'nothing sent yet');
    fake.type('\r');
    await until(() => existsSync(file), 'the second Enter to send it');
    fake.child.kill('SIGTERM');
});

test('stand-in agent: the events style names its conversation in a new dated file, and resume appends to it', async () => {
    const dir = tmp('fake-events');
    const data = join(dir, 'data');
    const started = Date.now();
    const first = runFake(['--style', 'subcommand', '--data', data], dir);
    await until(() => first.out().includes('›'), 'its prompt');
    const found = await until(() => findNewTranscript({ program: 'x', style: 'subcommand', data, folder: dir }, dir, started), 'its new file');
    assert.equal(eventsMeta(found.path).cwd, dir);
    const link = join(tmp('link'), 'here');
    symlinkSync(dir, link);
    assert.equal(findNewTranscript({ program: 'x', style: 'subcommand', data, folder: link }, dir, started)?.path, found.path, 'its folder named through a link is the same folder');
    assert.equal(findNewTranscript({ program: 'x', style: 'subcommand', data, folder: tmp('other') }, dir, started), undefined, 'another folder\'s conversation is not its');
    assert.equal(findNewTranscript({ program: 'x', style: 'subcommand', data, folder: dir }, dir, started, new Set([found.path])), undefined, 'a file another agent took is not its');
    first.type(`${PASTE_START}#work=10 #tool build it${PASTE_END}`);
    await sleep(30);
    first.type('\r');
    await until(() => readFileSync(found.path, 'utf8').includes('task_complete'), 'its answer');
    first.child.kill('SIGTERM');
    await until(() => first.child.exitCode !== null || first.child.signalCode !== null, 'it to stop');
    const second = runFake(['--style', 'subcommand', '--data', data, 'resume', found.id], dir);
    await until(() => second.out().includes(`Resumed conversation ${found.id}`), 'the resume');
    assert.equal(findTranscriptById({ program: 'x', data }, dir, found.id), found.path);
    second.type('#work=10 again\r');
    await until(() => readFileSync(found.path, 'utf8').split('\n').filter((l) => l.includes('again')).length >= 2, 'the resumed answer');
    let fold = emptyFold();
    for (const entry of parseLines('events', readFileSync(found.path, 'utf8').split('\n').filter(Boolean))) fold = foldEntry(fold, entry);
    assert.equal(fold.turns, 2);
    assert.equal(fold.id, found.id);
    assert.equal(statusOf(fold, { now: Date.now() + 10000 }).status, 'idle');
    second.child.kill('SIGTERM');
});

// ── The engine over a stand-in DSH ─────────────────────────────────────

const strip = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '');

/** A stand-in for one DSH session terminal: a "shell" that runs `exec <program> <args>` for real, with pipes. */
class FakeTerminal {
    constructor(id, cwd) {
        this.cwd = cwd;
        this.info = { id, state: 'running', exitCode: null, title: 'zsh', cols: 120, rows: 32 };
        this.output = 'me@mac app % ';
        this.paste = true;
        this.line = '';
        this.child = undefined;
        this.handle = { write: async (data) => this.input(data) };
        const self = this;
        this.screen = {
            rows: 32,
            modes: { get bracketedPasteMode() { return self.paste; } },
            buffer: { active: { baseY: 0, getLine: (y) => ({ translateToString: () => self.lines()[y] ?? '' }) } },
        };
    }

    lines() {
        const all = strip(this.output).split(/\r?\n/).map((line) => line.split('\r').at(-1));
        return all.slice(-32).concat(Array(32).fill('')).slice(0, 32);
    }

    input(data) {
        if (this.child) {
            this.child.stdin.write(data);
            return;
        }
        // The shell echoes what is typed at its prompt, as a terminal does.
        for (const ch of data) {
            if (ch === '\r') {
                this.print('\r\n');
                this.run(this.line);
                this.line = '';
            } else {
                this.print(ch);
                this.line += ch;
            }
        }
    }

    run(line) {
        const words = splitArgs(line.replace(/ \|\| exit \$\?$/, ''));
        if (words[0] !== 'exec' || words.length < 2) {
            this.print(`zsh: ${line}\r\n`);
            return;
        }
        this.paste = false;
        const child = spawn(words[1], words.slice(2), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child);
        this.child = child;
        child.stdout.on('data', (chunk) => this.print(chunk.toString('utf8')));
        child.stderr.on('data', (chunk) => this.print(chunk.toString('utf8')));
        const done = (code) => {
            children.delete(child);
            if (this.child === child) this.child = undefined;
            if (this.info.state === 'running') this.info = { ...this.info, state: 'exited', exitCode: code };
        };
        child.on('error', () => done(127));
        child.on('exit', (code, signal) => done(code ?? (signal === 'SIGTERM' ? 143 : 129)));
    }

    print(text) {
        this.output = `${this.output}${text}`.slice(-20000);
        const mode = pasteSwitch(text);
        if (mode !== undefined) this.paste = mode;
    }

    kill() {
        try { this.child?.kill('SIGTERM'); } catch {}
    }
}

class FakeController {
    constructor() {
        this.owners = new Map();
    }

    owner(sessionId) {
        let owner = this.owners.get(sessionId);
        if (!owner) {
            owner = { terminals: new Map(), closedIds: new Set() };
            this.owners.set(sessionId, owner);
        }
        return owner;
    }

    async shells() { return [{ path: '/bin/zsh', name: 'zsh' }]; }

    list(sessionId) {
        return [...(this.owners.get(sessionId)?.terminals.values() ?? [])].map((t) => t.info);
    }

    async create(agent, request) {
        const owner = this.owner(agent.id);
        if (owner.closedIds.has(request.id)) throw new Error('Terminal was closed in this Session');
        const existing = owner.terminals.get(request.id);
        if (existing) return existing.info;
        if (owner.terminals.size >= 8) throw new Error('Session terminal limit reached');
        const terminal = new FakeTerminal(request.id, agent.session.header.cwd);
        owner.terminals.set(request.id, terminal);
        return terminal.info;
    }

    rename(agent, id, title) {
        const terminal = this.owners.get(agent.id)?.terminals.get(id);
        if (terminal) terminal.info = { ...terminal.info, title };
    }

    async close(agent, id) {
        const owner = this.owner(agent.id);
        owner.closedIds.add(id);
        owner.terminals.get(id)?.kill();
        owner.terminals.delete(id);
    }

    retain(sessionId, id, signal) {
        return (async function* () {
            yield { type: 'retained' };
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        })();
    }

    terminal(sessionId, id) {
        return this.owners.get(sessionId)?.terminals.get(id);
    }

    /** DSH quits: every terminal ends, and nothing about them is kept. */
    restart() {
        for (const owner of this.owners.values()) for (const terminal of owner.terminals.values()) terminal.kill();
        this.owners = new Map();
    }
}

function fakeWatch() {
    const sessions = new Map();
    const listeners = new Set();
    return {
        sessions,
        asks: new Map(),
        externals: new Map(),
        delivered: [],
        outcomes: [],
        on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        emit(event) {
            for (const listener of [...listeners]) listener(event);
        },
        askOutcome(id, outcome) {
            this.outcomes.push([id, outcome]);
            return true;
        },
        add(sessionId, cwd) {
            sessions.set(sessionId, { id: sessionId, session: { header: { cwd } }, followup() {}, status: 'idle' });
        },
        async resolveAgent(id) {
            const agent = sessions.get(id);
            if (!agent) throw new Error(`session "${id}" not found`);
            return agent;
        },
        async get(id) {
            return { sessionId: id, ...(sessions.has(id) ? { cwd: sessions.get(id).session.header.cwd } : {}) };
        },
        sessionOf(id) { return sessions.get(id); },
        raiseAsk(ask) { this.asks.set(ask.id, ask); return ask; },
        dropAsk(id) { return this.asks.delete(id); },
        setExternal(id, external) {
            if (external === null) this.externals.delete(id);
            else this.externals.set(id, external);
        },
        async deliver(sessionId, text) {
            this.delivered.push({ sessionId, text });
            return { state: 'queued' };
        },
    };
}

function engine({ dir = tmp('engine'), watch = fakeWatch(), controller = new FakeController(), config = {}, store, working, pid } = {}) {
    let n = 0;
    const notices = [];
    const settings = { ...DEFAULTS, proofSeconds: 1, askAfterSeconds: 1, ...config };
    const sessions = {
        async create(folder) {
            const id = `s${++n}-${Math.random().toString(36).slice(2, 6)}`;
            watch.add(id, folder);
            return id;
        },
        async rename() {},
    };
    const theStore = store ?? new JsonStore(join(dir, 'state.json'), { parse: parseData, delayMs: 5 });
    const journal = new Journal(join(dir, 'events.jsonl'));
    // DSH's server keeps its process alive; here the waits must (the plugin's own timers do not hold a process open).
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const typist = new Typist({ controller: () => controller, method: () => settings.typing, wait });
    const agents = new AgentTerminals({
        watch, controller: () => controller, sessions, typist, config: settings, store: theStore, journal, home: dir,
        notify: (item) => notices.push(item), tickMs: 100, wait, startCheckMs: 500, ...(working ? { working } : {}), ...(pid ? { pid } : {}),
    });
    return { agents, watch, controller, settings, store: theStore, journal, notices, dir };
}

const fakeArgs = (data, extra = []) => ['--style', 'flags', '--data', data, ...extra];

test('engine: start an agent, type its first message in, and prove it from its transcript', async () => {
    const { agents, watch, controller, journal, dir } = engine();
    const folder = join(dir, 'app');
    mkdirSync(folder);
    agents.start();
    try {
        const started = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder, name: 'Stand-in', task: '#work=50 #reply=Hello from the stand-in first task' });
        assert.equal(started.problem, undefined);
        const key = started.agent.key;
        const record = agents.records[key];
        assert.equal(watch.delivered.length, 1, 'its session got a first turn, so DSH lists it');
        assert.match(watch.delivered[0].text, /coding agent runs in this session's terminal/);
        // Logged as sending, and done only when that turn ends.
        const turn = () => journal.list().find((e) => e.kind === 'session');
        assert.deepEqual([turn().text, turn().state], ['Giving its session a first turn', 'sending']);
        watch.emit({ type: 'turn-end', sessionId: 'another', end: { kind: 'completed' } });
        assert.equal(turn().state, 'sending', 'another session\'s turn is not its');
        watch.emit({ type: 'turn-end', sessionId: record.sessionId, end: { kind: 'completed' } });
        await until(() => turn().state === 'done', 'the first turn done');
        assert.equal(turn().text, 'Gave its session a first turn');
        assert.deepEqual([journal.list().find((e) => e.kind === 'start').text, journal.list().find((e) => e.kind === 'start').state], ['Started Stand-in', 'done']);
        const terminal = controller.terminal(record.sessionId, record.terminalId);
        assert.ok(terminal, 'a terminal in its session');
        assert.equal(terminal.info.title, 'Stand-in');
        await until(() => agents.view(record).deliveries[0]?.state === 'delivered', 'the first message proven');
        const view = agents.view(record);
        assert.equal(view.deliveries[0].enters, 1);
        assert.equal(view.deliveries[0].way, 'direct');
        await until(() => agents.view(record).status === 'idle', 'idle after its answer');
        assert.equal(agents.view(record).lastReply.text, 'Hello from the stand-in first task');
        assert.equal(watch.externals.get(record.sessionId).status, 'idle', 'the session row says so');
        assert.ok(journal.list().some((e) => e.kind === 'proof' && /has the message/.test(e.text)));
        assert.match(terminal.output, /exec .*fake-agent\.mjs --style flags/, 'it was started with exec');
        assert.match(terminal.output, new RegExp(`--session-id ${record.conversationId}`), 'with the id it gave it');
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: the listing turn asks nothing; one whose model asked all the same says so; paths read as ~/…; Stop says who stopped it', async () => {
    const { agents, watch, controller, journal, dir } = engine();
    const folder = join(dir, 'app');
    mkdirSync(folder);
    // What Session Watch read in each session's reply: the model of the first asked all the same, the second only softly.
    const replies = new Map();
    watch.fullState = async (sessionId) => replies.get(sessionId);
    agents.start();
    try {
        const one = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder, name: 'One' });
        const record = agents.records[one.agent.key];
        assert.equal(watch.delivered[0].text, listingNote(record, dir));
        assert.match(watch.delivered[0].text, /: fake-agent\.mjs in ~\/app, started by Agent Terminals\./, 'its folder as people read it');
        assert.doesNotMatch(watch.delivered[0].text, /DECISION NEEDED|\?/);
        const start = journal.list().find((e) => e.kind === 'start' && e.agent === record.key);
        assert.equal(start.why, `You started ${FAKE} in ~/app, in a new session.`, 'a program outside the home folder in full, the folder as ~/…');
        replies.set(record.sessionId, { ask: { question: 'Should I look at anything else?', turn: 1 }, end: { turn: 1, kind: 'completed' } });
        watch.emit({ type: 'turn-end', sessionId: record.sessionId, end: { kind: 'completed' } });
        const turn = (key) => journal.list().find((e) => e.kind === 'session' && e.agent === key);
        await until(() => turn(record.key).state === 'done', 'the first turn done');
        assert.equal(turn(record.key).reason, 'Its model\'s reply asked something all the same (“Should I look at anything else?”): Decisions may list it, though nothing waits on you there. Dismiss it in Decisions.');
        const two = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder, name: 'Two' });
        const second = agents.records[two.agent.key];
        replies.set(second.sessionId, { ask: { question: 'Let me know if you need more.', turn: 1, soft: true }, end: { turn: 1, kind: 'completed' } });
        watch.emit({ type: 'turn-end', sessionId: second.sessionId, end: { kind: 'completed' } });
        await until(() => turn(second.key).state === 'done', 'the second first turn done');
        assert.equal(turn(second.key).reason, undefined, 'a soft line asks nobody: nothing to say');
        await until(() => agents.view(record).status === 'idle' || agents.view(record).status === 'running', 'the agent running');
        await agents.stopAgent(record.key);
        const stop = journal.list().find((e) => e.kind === 'stop' && e.agent === record.key);
        assert.deepEqual([stop.text, stop.why, stop.state], ['Stopped One', 'You stopped it; its terminal closed, which ends the program in it.', 'done']);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: a question in its reply goes to Decisions, and the answer is typed in', async () => {
    const { agents, watch, controller, notices, dir } = engine();
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Asker' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'it to be ready');
        agents.send(agent.key, '#work=30 #ask Can we go?');
        await until(() => agents.view(record).status === 'waiting on you', 'its question');
        const ask = [...watch.asks.values()][0];
        assert.equal(ask.question, 'Use the fast path?');
        assert.equal(ask.recommendation, 'Yes, the fast path');
        assert.deepEqual(ask.options, [{ id: 'recommended', label: 'Go with the recommendation' }]);
        assert.equal(ask.freeText, true);
        assert.equal(ask.sessionId, record.sessionId);
        assert.equal(notices.length, 1, 'one notification');
        assert.match(notices[0].title, /Asker waits on you/);
        const result = ask.onAnswer('recommended', 'you');
        assert.match(result.text, /goes into “Asker”'s terminal when the agent is ready, and counts as delivered once its transcript shows it/);
        await until(() => agents.view(record).deliveries[0]?.state === 'delivered', 'the answer proven');
        // Decisions hears what became of it: delivered only now, with the proof.
        await until(() => watch.outcomes.length === 1, 'the outcome told to Decisions');
        assert.equal(watch.outcomes[0][0], ask.id);
        assert.deepEqual([watch.outcomes[0][1].state, watch.outcomes[0][1].sessionId], ['delivered', record.sessionId]);
        assert.match(watch.outcomes[0][1].text, /Its transcript shows it/);
        assert.equal(agents.view(record).deliveries[0].text, 'Go with your recommendation: Yes, the fast path');
        await until(() => watch.asks.size === 0, 'the question dropped once answered');
        await until(() => agents.view(record).status === 'idle', 'idle again');
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: a swallowed Enter is pressed again, and the proof says so', async () => {
    const { agents, controller, dir } = engine();
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data'), ['--swallow-enter']), style: 'flags', data: join(dir, 'data'), folder: dir });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'it to be ready');
        agents.send(agent.key, '#work=20 swallow test');
        const done = await until(() => agents.view(record).deliveries.find((d) => d.state === 'delivered'), 'proof after the second Enter', 20000);
        assert.equal(done.enters, 2);
        assert.match(done.why, /after Enter 2 times/);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: a tool call waiting in its terminal holds the next message, and Decisions says to answer there', async () => {
    const { agents, watch, controller, dir } = engine();
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Careful' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'it to be ready');
        agents.send(agent.key, '#work=20 #approve make a file');
        await until(() => agents.view(record).status === 'waiting on you', 'its approval prompt', 20000);
        const ask = [...watch.asks.values()][0];
        assert.match(ask.question, /It asks to run “touch approved.txt”/);
        assert.equal(ask.onAnswer, undefined, 'only its terminal can answer');
        assert.match(ask.answerHint, /Answer in its terminal/);
        agents.send(agent.key, '#work=20 after the approval');
        await until(() => agents.view(record).deliveries[0].state === 'waiting', 'the next message to wait');
        assert.match(agents.view(record).deliveries[0].why, /^Held while a tool call waits in its terminal \(to run “touch approved.txt”\); this is typed in after it ends/);
        // The person answers in the terminal.
        await controller.terminal(record.sessionId, record.terminalId).handle.write('1');
        await until(() => existsSync(join(dir, 'approved.txt')), 'the approved command to run');
        await until(() => agents.view(record).deliveries[0].state === 'delivered', 'the held message typed in after');
        assert.equal(watch.asks.size, 0);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: stop, start again with its conversation, and pick up after a DSH restart', async () => {
    const dir = tmp('restart');
    const controller = new FakeController();
    const watch = fakeWatch();
    const first = engine({ dir, watch, controller });
    first.agents.start();
    let key;
    let record;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Keeper', task: '#work=20 remember the number 41' });
        key = agent.key;
        record = first.agents.records[key];
        await until(() => first.agents.view(record).deliveries[0]?.state === 'delivered', 'its first message');
        const firstTerminal = record.terminalId;
        await first.agents.stopAgent(key);
        assert.equal(first.agents.view(record).status, 'stopped');
        assert.equal(controller.terminal(record.sessionId, firstTerminal), undefined, 'its terminal is closed');
        await first.agents.startAgain(key);
        assert.notEqual(record.terminalId, firstTerminal, 'a closed terminal id is not used again in the same DSH');
        await until(() => controller.terminal(record.sessionId, record.terminalId)?.output.includes(`Resumed conversation ${record.conversationId}`), 'the resume');
        first.agents.send(key, '#work=20 second message');
        await until(() => first.agents.view(record).deliveries[0]?.state === 'delivered', 'the second message');
        assert.equal(first.agents.view(record).turns, 2, 'one conversation');
    } finally {
        first.agents.stop();
    }
    // DSH quits and starts again: its terminals are gone, and this is a new process.
    controller.restart();
    first.store.data.agents[key].hostPid = 1;
    first.store.flush();
    const second = engine({ dir, watch, controller, store: new JsonStore(join(dir, 'state.json'), { parse: parseData, delayMs: 5 }) });
    second.agents.start();
    try {
        const again = second.agents.records[key];
        await until(() => controller.terminal(again.sessionId, again.terminalId)?.output.includes(`Resumed conversation ${again.conversationId}`), 'the resume after the restart');
        assert.equal(again.terminalId, record.terminalId, 'the same terminal id, so the window\'s tab finds it');
        await until(() => second.agents.view(again).status === 'idle', 'idle with its old answer');
        second.agents.send(key, '#work=20 third message');
        await until(() => second.agents.view(again).deliveries[0]?.state === 'delivered', 'the third message');
        assert.equal(second.agents.view(again).turns, 3);
        assert.ok(second.journal.list().some((e) => /Started Keeper again after DSH restarted/.test(e.text)));
    } finally {
        second.agents.stop();
        controller.restart();
    }
});

test('engine: a reload of the plugin leaves the agent running, and a message typed just before is still proven', async () => {
    const dir = tmp('reload');
    const controller = new FakeController();
    const watch = fakeWatch();
    const first = engine({ dir, watch, controller });
    first.agents.start();
    let key;
    let terminal;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Steady' });
        key = agent.key;
        const record = first.agents.records[key];
        terminal = controller.terminal(record.sessionId, record.terminalId);
        await until(() => first.agents.view(record).ready, 'ready');
        first.agents.send(key, '#work=600 typed before the reload');
        await until(() => first.agents.view(record).deliveries[0]?.state === 'typed', 'typed in', 15000, 10);
    } finally {
        first.agents.stop();
    }
    assert.equal(watch.externals.size, 0, 'a stopped Agent Terminals leaves no status on the rows');
    const second = engine({ dir, watch, controller, store: new JsonStore(join(dir, 'state.json'), { parse: parseData, delayMs: 5 }) });
    second.agents.start();
    try {
        const record = second.agents.records[key];
        assert.equal(controller.terminal(record.sessionId, record.terminalId), terminal, 'the same terminal, never started again');
        await until(() => second.agents.view(record).deliveries[0]?.state === 'delivered', 'its proof, found after the reload');
        assert.equal(second.agents.view(record).deliveries[0].enters, 1, 'no Enter pressed again');
        await until(() => second.agents.view(record).status === 'idle', 'idle');
        assert.equal(second.journal.list().filter((e) => e.kind === 'restart').length, 0, 'not taken for a DSH restart');
        assert.equal((terminal.output.match(/exec /g) ?? []).length, 1, 'started once');
    } finally {
        second.agents.stop();
        controller.restart();
    }
});

test('engine: a DSH restart in the middle of a job or an approval leaves the agent idle, and its held message goes in once', async () => {
    for (const job of ['#work=60000 a long job', '#work=20 #approve a guarded job']) {
        const dir = tmp('cut');
        const controller = new FakeController();
        const watch = fakeWatch();
        const first = engine({ dir, watch, controller });
        first.agents.start();
        let key;
        try {
            const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Busy', task: job });
            key = agent.key;
            const record = first.agents.records[key];
            await until(() => first.agents.view(record).deliveries[0]?.state === 'delivered', 'its job under way');
            if (job.includes('#approve')) await until(() => first.agents.view(record).status === 'waiting on you', 'its approval prompt', 20000);
            else await until(() => first.agents.view(record).status === 'working', 'it to work');
            first.agents.send(key, '#work=20 after the restart');
            await until(() => first.agents.view(record).deliveries[0]?.state === 'waiting', 'the next message held');
        } finally {
            first.agents.stop();
        }
        // DSH quits mid-job: its terminals end with it.
        controller.restart();
        first.store.data.agents[key].hostPid = 1;
        first.store.flush();
        const second = engine({ dir, watch, controller, store: new JsonStore(join(dir, 'state.json'), { parse: parseData, delayMs: 5 }) });
        second.agents.start();
        try {
            const again = second.agents.records[key];
            const cut = await until(() => second.journal.list().find((e) => e.kind === 'cut'), 'the cut-off job logged');
            assert.match(cut.why, job.includes('#approve') ? /a guarded job/ : /a long job/, job);
            await until(() => second.agents.view(again).deliveries[0]?.state === 'delivered', 'the held message typed in and proven', 20000);
            assert.equal(second.agents.view(again).deliveries[0].enters, 1, 'typed in once');
            await until(() => second.agents.view(again).status === 'idle', 'idle after its answer');
            assert.equal(watch.asks.size, 0, `no question left from before the restart (${job})`);
            assert.equal(existsSync(join(dir, 'approved.txt')), false, 'nothing answered the old prompt');
            assert.equal(second.journal.list().filter((e) => e.kind === 'cut').length, 1, 'logged once');
        } finally {
            second.agents.stop();
            controller.restart();
        }
    }
});

/** A DSH restart: its terminals end, and the saved state is read by a new Agent Terminals. */
function restartDsh(before, { dir, watch, controller, key, config = {}, pid }) {
    before.agents.stop();
    controller.restart();
    before.store.data.agents[key].hostPid = 1;
    before.store.flush();
    const after = engine({ dir, watch, controller, config, pid, store: new JsonStore(join(dir, 'state.json'), { parse: parseData, delayMs: 5 }) });
    after.agents.start();
    return after;
}

/** A message by its words, from the saved list (oldest first; the page's list is newest first). */
const byText = (record, words) => record.deliveries.find((d) => d.text.includes(words));

/** How many times the agent's own transcript holds these words as a user message. */
const toldTimes = (record, home, words) => parseLines('messages', readFileSync(transcriptPath(record, home), 'utf8').split('\n').filter(Boolean))
    .filter((e) => e.kind === 'user' && e.text.includes(words)).length;

test('engine: after a restart cut its job, a pick-up without a launch (off and on, a fixed setting, a reload) keeps it idle with nothing held', async () => {
    for (const job of ['#work=60000 a long job', '#work=20 #approve a guarded job']) {
        const dir = tmp('pickup');
        const controller = new FakeController();
        const watch = fakeWatch();
        const first = engine({ dir, watch, controller });
        first.agents.start();
        let key;
        try {
            const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Busy', task: job });
            key = agent.key;
            const record = first.agents.records[key];
            await until(() => first.agents.view(record).deliveries[0]?.state === 'delivered', 'its job under way');
            if (job.includes('#approve')) await until(() => first.agents.view(record).status === 'waiting on you', 'its approval prompt', 20000);
            else await until(() => first.agents.view(record).status === 'working', 'it to work');
        } catch (error) {
            first.agents.stop();
            throw error;
        }
        const second = restartDsh(first, { dir, watch, controller, key });
        let third;
        try {
            const again = second.agents.records[key];
            await until(() => second.journal.list().some((e) => e.kind === 'cut'), 'the cut-off job logged');
            await until(() => second.agents.view(again).ready && second.agents.view(again).status === 'idle', 'idle after the restart', 20000);
            const launches = again.launches;
            const stillIdle = async (agents, record, what) => {
                await until(() => !['starting', 'running'].includes(agents.view(record).status), `${what}: picked up`);
                await sleep(1200);
                const view = agents.view(record);
                assert.equal(view.status, 'idle', `${what}: ${job}: ${view.detail}`);
                assert.match(view.detail, /was cut off when its program ended/, what);
                assert.equal(watch.asks.size, 0, `${what}: no question from before the restart`);
                assert.equal(record.launches, launches, `${what}: not started again`);
            };
            // Off and on (switched off and on in Plugins, or a wrong setting fixed): the same program, picked up.
            second.agents.stop();
            second.agents.start();
            await stillIdle(second.agents, again, 'off and on');
            // A reload of the plugin: only its saved state is left, and it keeps the cut.
            second.agents.stop();
            second.store.flush();
            third = engine({ dir, watch, controller, store: new JsonStore(join(dir, 'state.json'), { parse: parseData, delayMs: 5 }) });
            third.agents.start();
            const reloaded = third.agents.records[key];
            await stillIdle(third.agents, reloaded, 'a reload');
            // A message goes straight in, held by nothing, and is proven.
            third.agents.send(key, '#work=20 carry on');
            await until(() => third.agents.view(reloaded).deliveries.at(-1)?.state === 'delivered', 'typed in and proven', 20000);
            assert.equal(third.journal.list().filter((e) => e.kind === 'cut').length, 1, 'the cut logged once');
            assert.equal(existsSync(join(dir, 'approved.txt')), false, 'nothing answered the old prompt');
        } finally {
            second.agents.stop();
            third?.agents.stop();
            controller.restart();
        }
    }
});

test('engine: a message typed in but not yet read when DSH restarts is typed in again once, and proven', async () => {
    // With typeWhileWorking the program keeps a message it has not read yet while it works; DSH quits under it.
    const dir = tmp('lost');
    const controller = new FakeController();
    const watch = fakeWatch();
    const first = engine({ dir, watch, controller, config: { typeWhileWorking: true } });
    first.agents.start();
    let key;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Busy', task: '#work=60000 a long job' });
        key = agent.key;
        const record = first.agents.records[key];
        await until(() => first.agents.view(record).status === 'working', 'it to work');
        first.agents.send(key, '#work=20 typed during the long job');
        await until(() => byText(record, 'typed during the long job')?.state === 'typed', 'typed in while it works');
    } catch (error) {
        first.agents.stop();
        throw error;
    }
    const second = restartDsh(first, { dir, watch, controller, key, config: { typeWhileWorking: true } });
    try {
        const again = second.agents.records[key];
        const item = byText(again, 'typed during the long job');
        await until(() => item.state === 'delivered', 'typed in again and proven', 20000);
        assert.deepEqual([item.enters, item.again], [1, true]);
        assert.equal(toldTimes(again, dir, 'typed during the long job'), 1, 'in its transcript once: the old program never read it');
        const entry = second.journal.get(item.entry);
        assert.equal(entry.state, 'delivered');
    } finally {
        second.agents.stop();
        controller.restart();
    }
});

/** The messages with these words, oldest first. */
const allByText = (record, words) => record.deliveries.filter((d) => d.text.includes(words));

test('engine: the same words sent twice are two messages, each proven by its own line of the transcript', async () => {
    // Round 4, finding 1: the second was "delivered" on the first one's line, before the agent read it.
    for (const typeWhileWorking of [true, false]) {
        const { agents, controller, dir } = engine({ config: { typeWhileWorking } });
        agents.start();
        try {
            const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Twice' });
            const record = agents.records[agent.key];
            await until(() => agents.view(record).status === 'idle', 'ready', 20000);
            // While it works on the first (2.5 s), the second waits in its input (typeWhileWorking) or in the queue.
            const words = typeWhileWorking ? '#work=2500 dup two' : '#work=30 dup quick';
            agents.send(agent.key, words);
            agents.send(agent.key, words);
            const [one, two] = allByText(record, words.split(' ').at(-1));
            await until(() => one.state === 'delivered', 'the first proven', 20000);
            if (typeWhileWorking) {
                await until(() => two.state === 'typed', 'the second typed in while it works', 20000);
                await sleep(1000);
                assert.equal(two.state, 'typed', 'not proven by the first one\'s line');
            }
            await until(() => two.state === 'delivered', 'the second proven by its own line', 20000);
            assert.equal(toldTimes(record, dir, words), 2, 'the agent read it twice');
            assert.notEqual(two.proof.key, one.proof.key, 'two lines, one each');
            assert.ok(two.provenAt > one.provenAt, `its own line is the later one (${one.provenAt} then ${two.provenAt})`);
            if (typeWhileWorking) assert.ok(two.provenAt - one.provenAt >= 2000, 'read after the first job ended');
            // Words inside the message before: not proven by its line either.
            agents.send(agent.key, '#work=30 fix the build, then run the tests');
            agents.send(agent.key, 'run the tests');
            const [whole] = allByText(record, 'fix the build');
            const inner = record.deliveries.find((d) => d.text === 'run the tests');
            await until(() => whole.state === 'delivered' && inner.state === 'delivered', 'both proven', 20000);
            assert.notEqual(inner.proof.key, whole.proof.key);
            assert.equal(toldTimes(record, dir, 'run the tests'), 2);
        } finally {
            agents.stop();
            controller.restart();
        }
    }
});

test('engine: the second of two same messages, unread when DSH restarts, is typed in again once and proven by its own line', async () => {
    const dir = tmp('lost-twice');
    const controller = new FakeController();
    const watch = fakeWatch();
    const first = engine({ dir, watch, controller, config: { typeWhileWorking: true } });
    first.agents.start();
    let key;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Twice' });
        key = agent.key;
        const record = first.agents.records[key];
        await until(() => first.agents.view(record).status === 'idle', 'ready', 20000);
        first.agents.send(key, '#work=60000 dup three');
        first.agents.send(key, '#work=60000 dup three');
        const [one, two] = allByText(record, 'dup three');
        await until(() => one.state === 'delivered' && two.state === 'typed', 'the first read, the second typed in while it works', 20000);
        await sleep(800);
        assert.equal(two.state, 'typed', 'the second is not proven by the first one\'s line');
    } catch (error) {
        first.agents.stop();
        throw error;
    }
    const second = restartDsh(first, { dir, watch, controller, key, config: { typeWhileWorking: true } });
    try {
        const again = second.agents.records[key];
        const [one, two] = allByText(again, 'dup three');
        assert.equal(one.state, 'delivered');
        await until(() => two.state === 'delivered', 'typed in again after the restart and proven', 30000);
        assert.deepEqual([two.again, two.enters], [true, 1], 'typed in again once');
        assert.equal(toldTimes(again, dir, 'dup three'), 2, 'its transcript has it twice: the first, and the second once, after the restart');
        assert.notEqual(two.proof.key, one.proof.key);
        assert.equal(second.journal.get(two.entry).state, 'delivered');
    } finally {
        second.agents.stop();
        controller.restart();
    }
});

test('engine: an answer whose Enter was swallowed when DSH restarted is typed in again, and Decisions hears it delivered', async () => {
    const dir = tmp('lost-answer');
    const controller = new FakeController();
    const watch = fakeWatch();
    const args = fakeArgs(join(dir, 'data'), ['--swallow-enter']);
    const first = engine({ dir, watch, controller });
    first.agents.start();
    let key;
    let ask;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args, style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Swallower' });
        key = agent.key;
        const record = first.agents.records[key];
        await until(() => first.agents.view(record).ready, 'it to be ready');
        first.agents.send(key, '#work=30 #ask Can we go?');
        await until(() => first.agents.view(record).status === 'waiting on you', 'its question', 20000);
        ask = [...watch.asks.values()][0];
        // Enter is not pressed again for a minute: DSH quits while the answer sits in its input line.
        first.settings.proofSeconds = 60;
        watch.asks.delete(ask.id);
        ask.onAnswer('Take the slow path', 'you');
        await until(() => byText(record, 'Take the slow path')?.state === 'typed', 'the answer typed in, its Enter swallowed');
    } catch (error) {
        first.agents.stop();
        throw error;
    }
    const second = restartDsh(first, { dir, watch, controller, key });
    try {
        const again = second.agents.records[key];
        const answer = byText(again, 'Take the slow path');
        await until(() => answer.state === 'delivered', 'the answer typed in again and proven', 20000);
        assert.deepEqual([answer.enters, answer.again], [2, true]);
        assert.equal(toldTimes(again, dir, 'Take the slow path'), 1);
        assert.deepEqual(watch.outcomes.map(([id, o]) => [id, o.state]), [[ask.id, 'delivered']], 'Decisions hears only that it was delivered');
        await until(() => second.agents.view(again).status === 'idle', 'idle after its answer');
        await until(() => watch.asks.size === 0, 'no question left');
    } finally {
        second.agents.stop();
        controller.restart();
    }
});

test('engine: a message lost to a second restart failed; an answer that did not go in brings its question back', async () => {
    const { agents, watch, controller, journal, dir } = engine();
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Asker' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'it to be ready');
        agents.send(agent.key, '#work=30 #ask Can we go?');
        await until(() => agents.view(record).status === 'waiting on you', 'its question', 20000);
        const ask = [...watch.asks.values()][0];
        // The terminal will not take it: the answer fails, Decisions hears so, and the question is asked again.
        const type = agents.typist.type;
        agents.typist.type = async () => { throw new Error('the terminal is gone'); };
        // As Session Watch does: an answered question is dropped, then its handler runs.
        watch.asks.delete(ask.id);
        ask.onAnswer('Take the slow path', 'you');
        await until(() => byText(record, 'Take the slow path')?.state === 'failed', 'the answer failed');
        assert.deepEqual(watch.outcomes.map(([id, o]) => [id, o.state]), [[ask.id, 'not delivered']]);
        assert.match(watch.outcomes[0][1].text, /Not typed in: the terminal is gone/);
        assert.equal(watch.asks.has(ask.id), true, 'its question is raised again');
        agents.typist.type = type;
        // Answered again: typed in and proven.
        const asked = watch.asks.get(ask.id);
        watch.asks.delete(ask.id);
        asked.onAnswer('Take the fast path', 'you');
        await until(() => byText(record, 'Take the fast path')?.state === 'delivered', 'the second answer proven', 20000);
        assert.deepEqual(watch.outcomes.at(-1).slice(0, 1).concat(watch.outcomes.at(-1)[1].state), [ask.id, 'delivered']);

        // Typed in again once after a restart, and lost to a second one before its transcript showed it: failed, said once.
        const item = { id: 'm-lost', text: 'lost twice', by: 'you', at: Date.now(), state: 'typed', typedAt: Date.now(), enters: 1, again: true, askId: 'q-lost' };
        record.deliveries.push(item);
        agents.lostWithRestart(record);
        assert.equal(item.state, 'failed');
        assert.match(item.why, /^DSH restarted twice before the agent read it/);
        assert.deepEqual(watch.outcomes.at(-1).slice(0, 1).concat(watch.outcomes.at(-1)[1].state), ['q-lost', 'not delivered']);
        assert.equal(journal.list().filter((e) => e.kind === 'restart' && /was lost/.test(e.text)).length, 1);
        // One its transcript shows was delivered after all (DSH quit before Agent Terminals saw the proof): nothing is typed again.
        const seen = byText(record, 'Take the fast path');
        seen.state = 'typed';
        delete seen.proof;
        delete seen.provenAt;
        agents.lostWithRestart(record);
        assert.equal(seen.state, 'delivered');
        // The same words sent again, which the agent never read, are not proven by that line: typed in again.
        const repeat = { id: 'm-repeat', text: 'Take the fast path', by: 'you', at: seen.typedAt + 500, state: 'typed', typedAt: seen.typedAt + 500, enters: 1 };
        record.deliveries.push(repeat);
        agents.lostWithRestart(record);
        assert.deepEqual([repeat.state, repeat.again], ['queued', true], 'its line proves the first one only');
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: with typeWhileWorking, no key goes into an approval prompt, and the proof waits for it', async () => {
    const { agents, controller, dir } = engine({ config: { typeWhileWorking: true } });
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Guarded' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'it to be ready');
        // Typed while it works; its approval prompt opens before it reads the message.
        agents.send(agent.key, '#work=1500 #approve guarded job');
        await until(() => agents.view(record).status === 'working', 'it to work');
        agents.send(agent.key, 'typed while it works');
        await until(() => agents.view(record).deliveries[0]?.state === 'typed', 'typed in while it works');
        await until(() => agents.view(record).status === 'waiting on you', 'its approval prompt', 20000);
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.equal(existsSync(join(dir, 'approved.txt')), false, 'no Enter answered the prompt');
        assert.equal(agents.view(record).deliveries[0].enters, 1, 'no Enter pressed again while the prompt is open');
        assert.equal(agents.view(record).deliveries[0].state, 'typed');
        // Sent while the prompt is open: it waits its turn behind the one not proven yet, untyped.
        agents.send(agent.key, 'sent while it asks');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(agents.view(record).deliveries[0].state, 'queued');
        assert.equal(agents.view(record).deliveries[0].enters, undefined, 'not typed in');
        // The person says no in its terminal; then both messages go in, each proven once.
        await controller.terminal(record.sessionId, record.terminalId).handle.write('n');
        await until(() => agents.view(record).deliveries.every((d) => d.state === 'delivered'), 'both messages proven', 20000);
        assert.deepEqual(agents.view(record).deliveries.map((d) => d.enters), [1, 1, 1]);
        assert.equal(existsSync(join(dir, 'approved.txt')), false);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: a message marked not proven turns delivered when its transcript shows it later', async () => {
    const { agents, controller, journal, dir } = engine({ config: { enterRetries: 0 } });
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data'), ['--swallow-enter']), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Late' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'it to be ready');
        agents.send(agent.key, '#work=20 seen late');
        await until(() => agents.view(record).deliveries[0]?.state === 'not proven', 'not proven after its only Enter', 15000);
        assert.match(agents.view(record).deliveries[0].why, /It turns delivered if its transcript shows it later/);
        const noProof = journal.list().find((e) => e.kind === 'proof' && /No proof/.test(e.text));
        assert.equal(noProof.state, 'failed');
        // The person presses Enter in its terminal.
        await controller.terminal(record.sessionId, record.terminalId).handle.write('\r');
        await until(() => agents.view(record).deliveries[0]?.state === 'delivered', 'delivered after all', 15000);
        assert.match(agents.view(record).deliveries[0].why, /later than Agent Terminals looked for it/);
        assert.ok(journal.list().some((e) => e.kind === 'proof' && /has the message after all/.test(e.text)));
        assert.equal(journal.get(noProof.id).state, 'done', 'the "no proof" entry says it was seen later');
        assert.match(journal.get(noProof.id).reason, /Seen later/);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: while a setting is wrong, a running agent reads running (not followed), and is picked up where it is', async () => {
    let ok = true;
    const { agents, controller, dir } = engine({ working: () => ok });
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Followed' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'it to be ready');
        const terminalId = record.terminalId;
        // A setting goes wrong: Agent Terminals stops following, the program keeps running.
        ok = false;
        agents.stop();
        const view = agents.view(record);
        assert.deepEqual([view.status, view.followed], ['running', false]);
        assert.match(view.detail, /^Running in its terminal, not followed: Agent Terminals waits for a setting to be fixed/);
        assert.throws(() => agents.send(agent.key, 'hello'), /waiting for a setting to be fixed/);
        // Fixed: the same terminal, not started again.
        ok = true;
        agents.start();
        await until(() => agents.view(record).status === 'idle', 'picked up idle');
        assert.equal(record.terminalId, terminalId);
        assert.equal(record.launches, 1);
        assert.equal(agents.view(record).followed, true);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: switched off in DSH\'s profile (enabled: false) while it runs, its agent still shows on the page: running, not followed, and where to switch it on', async () => {
    let on = true;
    const { agents, controller, journal, settings, watch, dir } = engine({ working: () => on });
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Kept' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'it to be ready');
        on = false;
        settings.enabled = false;
        agents.stop();
        const view = agents.view(record);
        assert.deepEqual([view.status, view.followed], ['running', false]);
        assert.equal(view.detail, 'Running in its terminal, not followed: Agent Terminals is switched off in DSH\'s profile (enabled: false). Set enabled to true there and it picks it up where it is.');
        const page = await pageState({ agents, journal, config: settings, check: { ok: true }, watch, terminals: () => controller, detected: async () => [], workspaces: () => [] });
        assert.equal(page.enabled, false);
        assert.deepEqual(page.agents.map((a) => [a.key, a.status, a.followed]), [[agent.key, 'running', false]], 'the page lists the agent that still runs');
        // Switched on again: the same terminal, not started again.
        on = true;
        settings.enabled = true;
        agents.start();
        await until(() => agents.view(record).status === 'idle', 'picked up idle');
        assert.deepEqual([record.terminalId, record.launches, agents.view(record).followed], [agent.terminalId, 1, true]);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('switching: each stop of following its agents names its own cause, read from DSH\'s parts as they stop', () => {
    const config = {};
    const fiber = (over) => ({ uid: 7, state: 2, config, entry: { disabled: false, parent: { tree: { ctx: { fiber: { uid: 1, state: 2 } } } } }, ...over });
    const active = { state: 2 };
    // Its own part going: switched off (what the Plugins switch writes), new settings in the profile, the same ones, DSH quitting, its entry removed.
    assert.equal(stopCause({ own: fiber({ state: 5, entry: { disabled: true } }), watchScope: active, config }), 'off');
    assert.equal(stopCause({ own: fiber({ state: 5, config: { enabled: false } }), watchScope: active, config }), 'profile');
    assert.equal(stopCause({ own: fiber({ state: 5 }), watchScope: active, config }), 'again');
    const root = { uid: 0, state: 2 };
    root.parent = { fiber: root };
    const app = (over) => ({ uid: 3, state: 2, parent: { fiber: root }, ...over });
    assert.equal(stopCause({ own: fiber({ state: 5, uid: null, parent: { fiber: app({ uid: null, state: 5 }) } }), watchScope: active, config }), 'quit', 'the parts above it go too: DSH quits');
    assert.equal(stopCause({ own: fiber({ state: 5, uid: null, parent: { fiber: { uid: 9, state: 2, parent: { fiber: app({ state: 5 }) } } } }), watchScope: active, config }), 'quit', 'however far up');
    assert.equal(stopCause({ own: fiber({ state: 5, uid: null, parent: { fiber: app() } }), watchScope: active, config }), 'removed', 'it alone goes: its entry left the profile');
    // Its own part running: Session Watch went, else DSH's terminals.
    assert.equal(stopCause({ own: fiber(), watchScope: { state: 5 }, config }), 'watch');
    assert.equal(stopCause({ own: fiber(), watchScope: active, config }), 'terminals');
    // DSH says nothing readable: plain words, never a wrong cause.
    assert.equal(stopCause({}), 'unknown');
    assert.equal(stopCause({ own: { get state() { throw new Error('gone'); } } }), 'unknown');
    for (const [cause, why] of Object.entries(STOP_WHYS)) {
        assert.doesNotMatch(why, /Switched off in Plugins, or DSH is quitting/, cause);
        assert.ok(why.endsWith('.'), cause);
    }
    assert.match(STOP_WHYS.watch, /^Session Watch stopped/);
    assert.match(STOP_WHYS.profile, /^Its settings changed in DSH's profile/);
    assert.match(STOP_WHYS.off, /^It was switched off\./);
    assert.match(STOP_WHYS.quit, /^DSH is quitting/);
    // And why it follows them again: from what came before it in this DSH.
    const stopped = (cause, pid = 42) => ({ kind: 'switch', state: 'stopped', cause, pid });
    assert.equal(startCause({ terminalRuns: 2, pid: 42 }), 'terminals');
    assert.equal(startCause({ watchRuns: 2, pid: 42 }), 'watch');
    assert.equal(startCause({ lateSeconds: 60, pid: 42, uptimeSeconds: 600 }), 'watch', 'Session Watch came long after it');
    assert.equal(startCause({ last: stopped('off'), pid: 42, uptimeSeconds: 600 }), 'on');
    assert.equal(startCause({ last: stopped('profile'), pid: 42, uptimeSeconds: 600 }), 'profile');
    assert.equal(startCause({ last: stopped('watch'), pid: 42, uptimeSeconds: 600 }), 'watch');
    assert.equal(startCause({ last: stopped('again'), pid: 42, ranHere: true, uptimeSeconds: 600 }), 'again');
    assert.equal(startCause({ last: stopped('setting'), pid: 42, ranHere: true, edited: true, uptimeSeconds: 600 }), 'profile', 'a wrong setting fixed in the profile');
    assert.equal(startCause({ last: stopped('quit', 41), pid: 42, uptimeSeconds: 20 }), 'dsh', 'an earlier DSH stopped it: this one started it');
    assert.equal(startCause({ last: stopped('off', 41), pid: 42, uptimeSeconds: 900 }), 'on', 'long after DSH started: switched on');
    assert.equal(startCause({ last: { kind: 'switch', state: 'done', pid: 42 }, pid: 42, uptimeSeconds: 900 }), 'on');
    // Started earlier in this same DSH with nothing logged in between (it followed no agent then): the profile's edit, or a switch.
    assert.equal(startCause({ last: stopped('quit', 41), pid: 42, ranHere: true, edited: true, uptimeSeconds: 30 }), 'profile', 'enabled set back to true in the profile, soon after DSH started with it off');
    assert.equal(startCause({ last: stopped('quit', 41), pid: 42, ranHere: true, uptimeSeconds: 30 }), 'again');
    assert.equal(parseData({ ranPid: 42 }).ranPid, 42, 'the DSH process that last started it is kept');
    assert.equal(parseData({ ranPid: 'x' }).ranPid, undefined);
    assert.equal(START_WHYS.dsh, 'It started with DSH: it picks up every agent where it is.');
    assert.equal(START_WHYS.profile, 'DSH started it again with the settings in its profile: it picks up every agent where it is.');
});

test('engine: an agent that exits, a program that is not there, and a program with no transcript', async () => {
    const { agents, watch, controller, journal, dir } = engine();
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Leaver' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'ready');
        agents.send(agent.key, '#work=10 #exit bye');
        await until(() => agents.view(record).status === 'stopped', 'it to stop');
        assert.match(agents.view(record).detail, /exited by itself \(code 0\)/);
        assert.equal(record.wanted, 'stopped');

        const sessionsBefore = watch.sessions.size;
        await assert.rejects(agents.launch({ program: join(dir, 'no-such-agent'), style: 'plain', folder: dir, name: 'Ghost' }), /^Error: There is no program at .*no-such-agent: check the path, and that the file is executable\.$/);
        assert.equal(Object.values(agents.records).some((r) => r.name === 'Ghost'), false, 'no agent kept for a path that is not a program');
        assert.equal(watch.sessions.size, sessionsBefore, 'and no session made for it');
        const turnsBefore = watch.delivered.length;
        const nameless = await agents.launch({ program: 'no-such-agent-x1', style: 'plain', folder: dir, name: 'Nameless' });
        assert.match(nameless.problem, /code 127: the shell could not find no-such-agent-x1\. Use its full path \(“which no-such-agent-x1” in a terminal shows it\)/);
        assert.equal(agents.view(agents.records[nameless.agent.key]).status, 'stopped');
        assert.equal(watch.delivered.length, turnsBefore, 'no first turn for a program that never ran');
        const started = journal.list().find((e) => e.kind === 'start' && /Nameless/.test(e.text));
        assert.deepEqual([started.text, started.state], ['Could not start Nameless', 'failed'], 'never logged as started');
        assert.equal(agents.recent.some((r) => r.program === 'no-such-agent-x1'), false, 'a program that could not start is not offered under "Used here before"');
        assert.equal(agents.recent.some((r) => r.program === FAKE), true, 'one that ran is');

        const plain = await agents.launch({ program: FAKE, args: ['--style', 'plain'], style: 'plain', folder: dir, name: 'Quiet' });
        const quiet = agents.records[plain.agent.key];
        await until(() => agents.view(quiet).ready, 'ready');
        assert.equal(agents.view(quiet).status, 'running');
        agents.send(plain.agent.key, '#work=10 no transcript here');
        await until(() => agents.view(quiet).deliveries[0]?.state === 'typed', 'typed in');
        assert.match(agents.view(quiet).deliveries[0].why, /keeps no transcript/);
        await assert.rejects(agents.launch({ program: FAKE, style: 'plain', sessionId: quiet.sessionId }), /already has a coding agent/);
        await agents.forget(plain.agent.key);
        assert.equal(agents.records[plain.agent.key], undefined);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: the events style is followed through its dated file, across a start again', async () => {
    const { agents, controller, dir } = engine();
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: ['--style', 'subcommand', '--data', join(dir, 'data')], style: 'subcommand', data: join(dir, 'data'), folder: dir, name: 'Eventful', task: '#work=20 #tool first' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).deliveries[0]?.state === 'delivered', 'its first message');
        assert.ok(record.conversationId, 'its id came from its file');
        assert.match(record.transcript, /rollout-.*\.jsonl$/);
        await agents.stopAgent(agent.key);
        await agents.startAgain(agent.key);
        const terminal = controller.terminal(record.sessionId, record.terminalId);
        await until(() => terminal.output.includes(`Resumed conversation ${record.conversationId}`), 'the resume');
        assert.match(terminal.output, new RegExp(`fake-agent\\.mjs resume ${record.conversationId} --style subcommand`), 'resume comes right after the program');
        agents.send(agent.key, '#work=20 second');
        await until(() => agents.view(record).deliveries[0]?.state === 'delivered', 'the second message');
        assert.equal(agents.view(record).turns, 2);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: a message taken back twice says so; while Agent Terminals runs no agents, each says it is not running and why', async () => {
    const dir = tmp('held');
    const first = engine({ dir });
    first.agents.start();
    let key;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Held' });
        key = agent.key;
        const record = first.agents.records[key];
        await until(() => first.agents.view(record).ready, 'it to be ready');
        first.agents.send(key, '#work=600 busy');
        await until(() => first.agents.view(record).status === 'working', 'it to work');
        const { delivery } = first.agents.send(key, 'later');
        await until(() => first.agents.view(record).deliveries[0]?.state === 'waiting', 'the second message to wait');
        assert.equal(first.agents.cancel(key, delivery.id).delivery.state, 'cancelled');
        assert.throws(() => first.agents.cancel(key, delivery.id), /^Error: It was taken back already\.$/);
    } finally {
        first.agents.stop();
        first.controller.restart();
    }
    // The same agents, read by an Agent Terminals that does not run them: not "starting", but not running, and why.
    const second = engine({ dir });
    try {
        const record = second.agents.records[key];
        second.agents.working = () => false;
        let view = second.agents.view(record);
        assert.equal(view.status, 'stopped');
        assert.equal(view.detail, 'Not running: Agent Terminals waits for a setting to be fixed (see the top of this page), then picks it up again.');
        second.agents.lives.clear();
        second.agents.working = () => true;
        view = second.agents.view(record);
        assert.equal(view.status, 'stopped');
        assert.equal(view.detail, 'Not running: DSH\'s terminals are not there, so Agent Terminals cannot pick it up yet.');
        assert.deepEqual(second.agents.marks().map((m) => [m.status, m.running]), [['stopped', false]], 'the row says so too');
    } finally {
        second.agents.stop();
        second.controller.restart();
    }
});

test('engine: typing through a terminal input this DSH lacks is refused before a terminal opens; after a restart the agent stays meant to run and comes back once fixed', async () => {
    const dir = tmp('attached');
    const data = join(dir, 'data');
    const controller = new FakeController();
    const watch = fakeWatch();
    const first = engine({ dir, watch, controller });
    first.agents.start();
    let key;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(data), style: 'flags', data, folder: dir, name: 'Mover', task: '#work=20 hello' });
        key = agent.key;
        await until(() => first.agents.view(first.agents.records[key]).deliveries[0]?.state === 'delivered', 'its first message');
    } finally {
        first.agents.stop();
    }
    // DSH starts again with typing: attached, and has no terminal input for plugins (this controller has no follow or write).
    controller.restart();
    first.store.data.agents[key].hostPid = 1;
    first.store.flush();
    const second = engine({ dir, watch, controller, config: { typing: 'attached' }, store: new JsonStore(join(dir, 'state.json'), { parse: parseData, delayMs: 5 }) });
    second.agents.start();
    const words = 'This DSH has no terminal input for plugins. Set "How messages are typed in" (typing) to auto in its profile settings.';
    try {
        const record = second.agents.records[key];
        await until(() => second.agents.view(record).problem, 'the start after the restart to fail');
        const view = second.agents.view(record);
        assert.equal(view.status, 'stopped');
        assert.equal(view.problem, words);
        assert.equal(view.detail, `It could not start after DSH restarted: ${words} It is tried again the next time DSH starts; Start again tries now.`);
        assert.equal(view.wanted, 'running', 'still meant to run');
        assert.deepEqual(controller.list(record.sessionId), [], 'no terminal opened for nothing');
        const started = await second.agents.launch({ program: FAKE, args: fakeArgs(data), style: 'flags', data, folder: dir, name: 'Another' });
        assert.equal(started.problem, words, 'a new start is refused the same way');
        assert.deepEqual(controller.list(started.agent.sessionId), []);
        assert.equal(started.agent.wanted, 'stopped', 'a first start that failed waits for Start again');
    } finally {
        second.agents.stop();
    }
    // Set back to auto, and DSH started again: it resumes by itself.
    controller.restart();
    const third = engine({ dir, watch, controller, store: new JsonStore(join(dir, 'state.json'), { parse: parseData, delayMs: 5 }) });
    third.agents.start();
    try {
        const record = third.agents.records[key];
        await until(() => controller.terminal(record.sessionId, record.terminalId)?.output.includes(`Resumed conversation ${record.conversationId}`), 'the resume once fixed');
        await until(() => third.agents.view(record).status === 'idle', 'idle again');
        assert.equal(third.agents.view(record).problem, undefined);
    } finally {
        third.agents.stop();
        controller.restart();
    }
    // A start whose command cannot be typed in: the shell it opened is closed again.
    const fourth = engine({ dir: tmp('attached-mute'), watch, controller });
    fourth.agents.start();
    try {
        fourth.agents.typist.write = async () => {
            throw new Error('the terminal took no input');
        };
        const { agent, problem } = await fourth.agents.launch({ program: FAKE, args: fakeArgs(data), style: 'flags', data, folder: dir, name: 'Mute' });
        assert.equal(problem, 'the terminal took no input');
        assert.deepEqual(controller.list(agent.sessionId), [], 'no empty terminal stays beside the session');
    } finally {
        fourth.agents.stop();
        controller.restart();
    }
});

test('engine: an agent that never got a message comes back under its id after a Stop, a closed terminal and a restart, never told to resume what it does not have', async () => {
    const dir = tmp('no-message');
    const controller = new FakeController();
    const watch = fakeWatch();
    const data = join(dir, 'data');
    const first = engine({ dir, watch, controller });
    first.agents.start();
    let key;
    let id;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(data), style: 'flags', data, folder: dir, name: 'Quiet' });
        key = agent.key;
        id = agent.conversationId;
        const record = first.agents.records[key];
        await until(() => first.agents.view(record).ready, 'it to be ready');
        assert.equal(first.agents.view(record).canResume, false, 'no transcript yet: no conversation to resume');
        assert.equal(first.agents.view(record).again, 'Start again starts it again (it has no conversation to resume yet).');
        await first.agents.stopAgent(key);
        assert.equal(record.ended.text, 'You stopped it. Start again starts it again (it has no conversation to resume yet).');
        assert.equal((await first.agents.startAgain(key)).problem, undefined, 'Start again works');
        assert.equal(record.conversationId, id, 'under the same id');
        await until(() => controller.terminal(record.sessionId, record.terminalId)?.output.includes(`exec ${FAKE} --style flags --data ${data} --session-id ${id}`), 'started under its id, not resumed');
        await until(() => first.agents.view(record).ready, 'ready again');
        assert.equal(first.agents.view(record).status, 'idle');
        // Its terminal closed (its tab): Start again does the same.
        await controller.close(await watch.resolveAgent(record.sessionId), record.terminalId);
        await until(() => first.agents.view(record).status === 'stopped', 'stopped with its terminal');
        assert.equal(record.ended.text, 'Its terminal was closed (closing an agent\'s terminal tab ends the agent). Start again starts it again (it has no conversation to resume yet).');
        assert.equal((await first.agents.startAgain(key)).problem, undefined);
        await until(() => first.agents.view(record).ready, 'ready after its terminal closed');
        const starts = first.journal.list().filter((e) => e.agent === key && e.kind === 'start');
        assert.deepEqual(starts.map((e) => [e.text, e.state]), [['Started Quiet again', 'done'], ['Started Quiet again', 'done'], ['Started Quiet', 'done']]);
        assert.equal(starts[0].why, 'You started it again under the same id: it had no conversation to resume yet (its program writes one with its first message).');
    } catch (error) {
        first.agents.stop();
        throw error;
    }
    const restartedAt = Date.now();
    const second = restartDsh(first, { dir, watch, controller, key });
    try {
        const again = second.agents.records[key];
        const entry = await until(() => second.journal.list().find((e) => e.kind === 'restart' && e.agent === key), 'the restart logged once it holds', 30000);
        assert.deepEqual([entry.text, entry.state], ['Started Quiet again after DSH restarted', 'done']);
        assert.match(entry.why, /^DSH ended its terminal when it quit\. It had no conversation to resume yet .* so it starts again under the same id/);
        const output = controller.terminal(again.sessionId, again.terminalId).output;
        assert.ok(output.includes(`--session-id ${id}`) && !output.includes('--resume'), output.slice(-400));
        assert.equal(second.agents.view(again).status, 'idle');
        assert.ok(!second.journal.list().some((e) => e.agent === key && e.kind === 'ended' && e.at >= restartedAt), 'it did not end');
        // Its first message makes its conversation: from then on it resumes.
        second.agents.send(key, '#work=20 hello there');
        await until(() => second.agents.view(again).deliveries[0]?.state === 'delivered', 'its first message');
        assert.equal(second.agents.view(again).canResume, true);
        assert.equal(second.agents.view(again).again, 'Start again resumes its conversation.');
    } finally {
        second.agents.stop();
        controller.restart();
    }
});

test('engine: a program that fails as it starts again after a restart is logged as not started, with what it printed, and Start anew is offered', async () => {
    const dir = tmp('fails-again');
    const controller = new FakeController();
    const watch = fakeWatch();
    const data = join(dir, 'data');
    const program = join(dir, 'agent-wrapper');
    writeFileSync(program, `#!/bin/sh\nif [ -f "${join(dir, 'broken')}" ]; then echo "Its settings file cannot be read" >&2; exit 3; fi\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
    const first = engine({ dir, watch, controller });
    first.agents.start();
    let key;
    try {
        const { agent } = await first.agents.launch({ program, args: fakeArgs(data), style: 'flags', data, folder: dir, name: 'Brittle', task: '#work=20 hello' });
        key = agent.key;
        await until(() => first.agents.view(first.agents.records[key]).deliveries[0]?.state === 'delivered', 'its first message');
    } catch (error) {
        first.agents.stop();
        throw error;
    }
    writeFileSync(join(dir, 'broken'), '');
    const second = restartDsh(first, { dir, watch, controller, key });
    try {
        const again = second.agents.records[key];
        const entry = await until(() => second.journal.list().find((e) => e.kind === 'restart' && e.agent === key), 'the restart logged', 30000);
        const words = 'It exited with code 3: “Its settings file cannot be read”. Start again tries to resume it once more; Start anew starts a new conversation.';
        assert.deepEqual([entry.text, entry.state, entry.why], ['Could not start Brittle again after DSH restarted', 'failed', words]);
        assert.ok(!second.journal.list().some((e) => e.agent === key && /^Started Brittle again/.test(e.text)), 'never said to have started');
        const view = second.agents.view(again);
        assert.deepEqual([view.status, view.detail, view.canResume], ['stopped', words, true]);
    } finally {
        second.agents.stop();
        controller.restart();
    }
});

test('engine: a job cut by a restart is logged once, however many restarts follow before the next message', async () => {
    const dir = tmp('cut-once');
    const controller = new FakeController();
    const watch = fakeWatch();
    const data = join(dir, 'data');
    const first = engine({ dir, watch, controller });
    first.agents.start();
    let key;
    try {
        const { agent } = await first.agents.launch({ program: FAKE, args: fakeArgs(data), style: 'flags', data, folder: dir, name: 'Long', task: '#work=60000 a long job' });
        key = agent.key;
        const record = first.agents.records[key];
        await until(() => first.agents.view(record).status === 'working', 'it to work');
    } catch (error) {
        first.agents.stop();
        throw error;
    }
    let before = first;
    for (const n of [1, 2, 3]) {
        const after = restartDsh(before, { dir, watch, controller, key });
        before = after;
        await until(() => after.agents.view(after.agents.records[key]).ready && after.agents.view(after.agents.records[key]).status === 'idle', `idle after restart ${n}`, 20000);
        await until(() => after.journal.list().some((e) => e.kind === 'restart' && e.agent === key && e.state === 'done' && e.at >= Date.now() - 30000), `restart ${n} logged`, 30000);
        assert.equal(after.journal.list().filter((e) => e.kind === 'cut').length, 1, `restart ${n}: the cut is logged once`);
    }
    // A new job, cut by the next restart: that one is logged.
    try {
        before.agents.send(key, '#work=60000 another long job');
        await until(() => before.agents.view(before.agents.records[key]).status === 'working', 'it to work again', 20000);
    } catch (error) {
        before.agents.stop();
        throw error;
    }
    const last = restartDsh(before, { dir, watch, controller, key });
    try {
        await until(() => last.journal.list().filter((e) => e.kind === 'cut').length === 2, 'the new cut logged', 20000);
        assert.match(last.journal.list().find((e) => e.kind === 'cut').why, /another long job/);
    } finally {
        last.agents.stop();
        controller.restart();
    }
});

test('engine: at its first start it settles what an earlier run of DSH left open in its log: first turns, starts, and a forgotten agent\'s messages', async () => {
    const dir = tmp('stale');
    const watch = fakeWatch();
    const old = new Journal(join(dir, 'events.jsonl'));
    const sent = Date.now() - 60000;
    const cut = old.add({ kind: 'session', agent: 'a1', sessionId: 'cut', text: 'Giving its session a first turn', state: 'sending', by: 'Agent Terminals', pid: 1 });
    const done = old.add({ kind: 'session', agent: 'a2', sessionId: 'done', text: 'Giving its session a first turn', state: 'sending', by: 'Agent Terminals', pid: 1 });
    const stopped = old.add({ kind: 'session', agent: 'a3', sessionId: 'stopped', text: 'Giving its session a first turn', state: 'sending', by: 'Agent Terminals', pid: 1 });
    const start = old.add({ kind: 'start', agent: 'gone', sessionId: 'x', text: 'Starting Gone', state: 'starting', by: 'you', pid: 1 });
    const message = old.add({ kind: 'message', agent: 'gone', sessionId: 'x', text: 'Message for Gone', state: 'queued', by: 'you' });
    const mine = old.add({ kind: 'session', agent: 'a4', sessionId: 'mine', text: 'Giving its session a first turn', state: 'sending', by: 'Agent Terminals', pid: process.pid });
    const ends = { cut: { end: { kind: 'completed', at: sent - 1000 } }, done: { end: { kind: 'completed', at: Date.now() } }, stopped: { end: { kind: 'aborted', at: Date.now() } } };
    watch.fullState = async (sessionId) => ends[sessionId];
    const { agents, journal } = engine({ dir, watch });
    agents.start();
    try {
        const state = (entry) => journal.get(entry.id);
        await until(() => state(cut).state !== 'sending' && state(done).state !== 'sending' && state(stopped).state !== 'sending', 'the first turns settled');
        assert.deepEqual([state(cut).text, state(cut).state, state(cut).reason], ['Its session\'s first turn was cut off', 'stopped', 'DSH quit before the turn ended. The session is listed in the sidebar all the same.']);
        assert.deepEqual([state(done).text, state(done).state], ['Gave its session a first turn', 'done']);
        assert.deepEqual([state(stopped).text, state(stopped).state, state(stopped).reason], ['Its session\'s first turn did not finish', 'stopped', 'The turn was stopped, as DSH quit. The session is listed in the sidebar all the same.']);
        assert.deepEqual([state(start).text, state(start).state, state(start).reason], ['Could not start Gone', 'failed', 'DSH quit before it started.']);
        assert.deepEqual([state(message).state, state(message).reason], ['cancelled', 'Its agent was forgotten before it was typed in.']);
        assert.equal(state(mine).state, 'sending', 'one this DSH still waits on is left to end');
    } finally {
        agents.stop();
    }
});

test('engine: forgetting an agent closes its messages, and an answer it held is not raised again', async () => {
    const { agents, watch, controller, journal, dir } = engine();
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Leaving' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'ready');
        await agents.stopAgent(agent.key);
        const { delivery } = agents.send(agent.key, 'for later');
        assert.equal(record.deliveries.find((d) => d.id === delivery.id).state, 'waiting');
        await agents.forget(agent.key);
        const entry = journal.list().find((e) => e.kind === 'message' && e.delivery === delivery.id);
        assert.deepEqual([entry.state, entry.reason], ['cancelled', 'Its agent was forgotten before it was typed in.']);
        assert.equal(watch.asks.size, 0);
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: a message that failed is sent again whole, once; one on its way or delivered is not', async () => {
    const { agents, controller, dir } = engine();
    agents.start();
    try {
        const { agent } = await agents.launch({ program: FAKE, args: fakeArgs(join(dir, 'data')), style: 'flags', data: join(dir, 'data'), folder: dir, name: 'Retry' });
        const record = agents.records[agent.key];
        await until(() => agents.view(record).ready, 'ready');
        const long = `#work=20 ${'a long message '.repeat(40)}end`;
        const { delivery } = agents.send(agent.key, long);
        await until(() => record.deliveries.find((d) => d.id === delivery.id).state === 'delivered', 'it delivered');
        assert.throws(() => agents.resend(agent.key, delivery.id), /^Error: Its transcript shows it already\.$/);
        // Lost (as to two restarts): sent again whole, not the 400 characters the page shows.
        const item = record.deliveries.find((d) => d.id === delivery.id);
        item.state = 'failed';
        assert.ok(agents.view(record).deliveries.find((d) => d.id === delivery.id).text.length <= 400);
        const { delivery: again } = agents.resend(agent.key, delivery.id);
        assert.equal(record.deliveries.find((d) => d.id === again.id).text, long);
        assert.equal(agents.view(record).deliveries.find((d) => d.id === delivery.id).resent, again.id, 'the page offers it no second time');
        assert.throws(() => agents.resend(agent.key, delivery.id), /sent again already/);
        await until(() => record.deliveries.find((d) => d.id === again.id).state === 'delivered', 'the new one delivered');
    } finally {
        agents.stop();
        controller.restart();
    }
});

test('engine: programs used before are listed once, with their conversations folder when it is not the default', () => {
    const { agents, dir } = engine();
    agents.remember({ program: '/x/standin', args: [], style: 'flags' });
    agents.remember({ program: '/x/standin', args: [], style: 'flags', data: join(dir, '.standin') });
    agents.remember({ program: '/x/standin', args: [], style: 'flags', data: '~/.standin' });
    assert.equal(agents.recent.length, 1, 'the default folder, given as ~/… or in full, is one folder');
    agents.remember({ program: '/x/standin', args: [], style: 'flags', data: '~/elsewhere' });
    assert.deepEqual(agents.recent.map((r) => r.folder), [join(dir, 'elsewhere'), undefined], 'one that differs says where');
    agents.store.data.recent = [...agents.store.data.recent, { program: '/x/standin', args: [], style: 'flags', data: join(dir, 'elsewhere') }];
    assert.equal(agents.recent.length, 2, 'an older list with look-alikes reads once each');
    // The chips show paths as people read them; the whole path stays for the hover and for a start.
    assert.deepEqual(agents.recent.map((r) => r.shown), [{ program: '/x/standin', folder: '~/elsewhere' }, { program: '/x/standin' }]);
    agents.remember({ program: join(dir, 'bin', 'agent'), args: [], style: 'flags' });
    assert.deepEqual(agents.recent[0].shown, { program: '~/bin/agent' });
    assert.equal(agents.recent[0].program, join(dir, 'bin', 'agent'));
});
