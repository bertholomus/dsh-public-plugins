#!/usr/bin/env node
/**
 * A stand-in coding agent for Agent Terminals' tests: a small terminal app
 * that reads typed and pasted messages, works on them for a moment, answers,
 * and keeps a transcript the way the two common kinds of coding-agent CLI do.
 *
 *   fake-agent.mjs --style flags --data DIR (--session-id ID | --resume ID | --continue)
 *   fake-agent.mjs --style subcommand --data DIR [resume ID]
 *   fake-agent.mjs --style plain
 *
 * flags: one JSON line per message in DIR/projects/<folder>/<id>.jsonl.
 * subcommand: one JSON line per event in DIR/sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl.
 * plain: no transcript.
 *
 * A message may carry directives for the tests (anywhere in it):
 *   #work=MS    work this long before answering (default 1200)
 *   #reply=TEXT answer with TEXT (to the end of the line)
 *   #ask        the answer ends with a DECISION NEEDED line
 *   #tool       one tool call and its result before the answer
 *   #approve    one tool call that waits for 1, y or Enter (yes), 2, n or Escape (no) in the
 *               terminal: Enter takes the first choice, as real programs' prompts do
 *   #exit       quit after answering
 * --swallow-enter: the first Enter after each paste is ignored, as some
 * terminal apps do. Messages sent while it works wait, and are written to
 * the transcript when it reads them, as such apps do.
 *
 * STAND_IN_STYLE and STAND_IN_DATA give --style and --data when they are
 * not passed, so a small wrapper named like a program acts as an installed
 * CLI that keeps its conversations in its own folder (~/.<name>).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
};
const style = flag('--style') ?? process.env.STAND_IN_STYLE ?? 'flags';
const data = flag('--data') ?? process.env.STAND_IN_DATA;
const swallowEnter = argv.includes('--swallow-enter');
const cwd = process.cwd();
const out = (text) => process.stdout.write(text);
const now = () => new Date().toISOString();

// ── The conversation and its transcript ─────────────────────────────────

const slug = (path) => path.replace(/[^A-Za-z0-9]/g, '-');
let id;
let file;
let resumed = false;

function rolloutFiles(root) {
    const found = [];
    const walk = (dir, depth) => {
        let names = [];
        try {
            names = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of names) {
            const path = join(dir, entry.name);
            if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
            else if (/^rollout-.*\.jsonl$/.test(entry.name)) found.push(path);
        }
    };
    walk(root, 0);
    return found;
}

function metaOf(path) {
    try {
        const first = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]);
        return first?.type === 'session_meta' ? first.payload : undefined;
    } catch {
        return undefined;
    }
}

if (style === 'flags') {
    if (!data) fail('--data is required');
    const dir = join(data, 'projects', slug(cwd));
    mkdirSync(dir, { recursive: true });
    if (flag('--resume')) {
        id = flag('--resume');
        resumed = true;
    } else if (argv.includes('--continue')) {
        const latest = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
            .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
        id = latest ? latest.name.replace(/\.jsonl$/, '') : randomUUID();
        resumed = Boolean(latest);
    } else {
        id = flag('--session-id') ?? randomUUID();
    }
    file = join(dir, `${id}.jsonl`);
    if (resumed && !existsSync(file)) fail(`No conversation found with session ID: ${id}`);
} else if (style === 'subcommand') {
    if (!data) fail('--data is required');
    const root = join(data, 'sessions');
    const at = argv.indexOf('resume');
    if (at !== -1) {
        id = argv[at + 1];
        file = rolloutFiles(root).find((path) => path.endsWith(`-${id}.jsonl`));
        if (!file) fail(`No saved session found with ID ${id}`);
        resumed = true;
    } else {
        id = randomUUID();
        const date = new Date();
        const dir = join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        mkdirSync(dir, { recursive: true });
        file = join(dir, `rollout-${date.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`);
        write({ timestamp: now(), type: 'session_meta', payload: { id, timestamp: now(), cwd, originator: 'stand-in', cli_version: '0.0.0' } });
    }
}

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

function write(entry) {
    if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

let parent = null;
function flagsEntry(type, message) {
    const uuid = randomUUID();
    write({ parentUuid: parent, isSidechain: false, type, message, uuid, timestamp: now(), sessionId: id, cwd, version: '0.0.0' });
    parent = uuid;
}

const record = {
    user(text) {
        if (style === 'flags') flagsEntry('user', { role: 'user', content: text });
        else if (style === 'subcommand') {
            write({ timestamp: now(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
            write({ timestamp: now(), type: 'event_msg', payload: { type: 'user_message', message: text } });
            write({ timestamp: now(), type: 'event_msg', payload: { type: 'task_started' } });
        }
    },
    call(callId, command) {
        if (style === 'flags') flagsEntry('assistant', { role: 'assistant', model: 'stand-in', content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command } }], stop_reason: 'tool_use' });
        else if (style === 'subcommand') write({ timestamp: now(), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }), call_id: callId } });
    },
    result(callId, output) {
        if (style === 'flags') flagsEntry('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: output }] });
        else if (style === 'subcommand') write({ timestamp: now(), type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } });
    },
    reply(text) {
        if (style === 'flags') flagsEntry('assistant', { role: 'assistant', model: 'stand-in', content: [{ type: 'text', text }], stop_reason: 'end_turn' });
        else if (style === 'subcommand') {
            write({ timestamp: now(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
            write({ timestamp: now(), type: 'event_msg', payload: { type: 'agent_message', message: text } });
            write({ timestamp: now(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } });
        }
    },
};

// ── The screen ──────────────────────────────────────────────────────────

let input = '';
let pasting = false;
let swallowNext = false;
let busy = false;
let approval;
const queue = [];

const shown = (text) => text.replace(/\n/g, ' ⏎ ');
function prompt() {
    out(`\r\x1b[2K${busy ? '… ' : '› '}${shown(input)}`);
}
function say(line) {
    out(`\r\x1b[2K${line}\r\n`);
    prompt();
}

out('\x1b[?2004h');
out(`Stand-in coding agent · ${style}${id ? ` · ${id}` : ''}\r\n`);
if (resumed) out(`Resumed conversation ${id}\r\n`);
out(`Folder: ${cwd}\r\n\r\n`);
prompt();

// ── Work ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handle(text) {
    busy = true;
    record.user(text);
    say(`you: ${shown(text)}`);
    const work = Number(/#work=(\d+)/.exec(text)?.[1] ?? 1200);
    await sleep(work);
    if (/#tool\b/.test(text)) {
        const callId = `call_${randomUUID().slice(0, 8)}`;
        record.call(callId, 'ls');
        say('tool: ls');
        await sleep(200);
        record.result(callId, 'README.md');
    }
    if (/#approve\b/.test(text)) {
        const callId = `call_${randomUUID().slice(0, 8)}`;
        record.call(callId, 'touch approved.txt');
        say('Allow this command?  touch approved.txt');
        say('  1. Yes   2. No');
        const yes = await new Promise((resolve) => { approval = resolve; });
        approval = undefined;
        if (yes) {
            appendFileSync(join(cwd, 'approved.txt'), '');
            record.result(callId, '');
            say('allowed: touch approved.txt');
        } else {
            record.result(callId, 'The person refused this command.');
            say('refused: touch approved.txt');
        }
    }
    let reply = /#reply=([^\n#]+)/.exec(text)?.[1]?.trim() ?? `Done: ${text.replace(/#\w+(=\S+)?/g, '').trim().slice(0, 60)}`;
    if (/#ask\b/.test(text)) reply = `${reply}\nDECISION NEEDED: Use the fast path? — recommend: Yes, the fast path`;
    record.reply(reply);
    for (const line of reply.split('\n')) say(`agent: ${line}`);
    busy = false;
    prompt();
    if (/#exit\b/.test(text)) quit(0);
    const next = queue.shift();
    if (next !== undefined) void handle(next);
}

function submit() {
    const text = input.trim();
    input = '';
    if (!text) {
        prompt();
        return;
    }
    if (busy) {
        queue.push(text);
        say(`queued: ${shown(text)}`);
        return;
    }
    void handle(text);
}

function quit(code) {
    out('\x1b[?2004l\r\nBye.\r\n');
    try {
        process.stdin.setRawMode?.(false);
    } catch {}
    process.exit(code);
}

// ── Keys ────────────────────────────────────────────────────────────────

let pending = '';
function onKeys(chunk) {
    pending += chunk;
    while (pending.length > 0) {
        if (pasting) {
            const end = pending.indexOf('\x1b[201~');
            if (end === -1) {
                // Keep what may be the start of the end marker for the next chunk.
                let keep = 0;
                for (let n = Math.min(5, pending.length); n > 0; n -= 1) {
                    if ('\x1b[201~'.startsWith(pending.slice(-n))) {
                        keep = n;
                        break;
                    }
                }
                input += pending.slice(0, pending.length - keep).replace(/\r\n?/g, '\n');
                pending = pending.slice(pending.length - keep);
                break;
            }
            input += pending.slice(0, end).replace(/\r\n?/g, '\n');
            pending = pending.slice(end + 6);
            pasting = false;
            swallowNext = swallowEnter;
            prompt();
            continue;
        }
        if (pending.startsWith('\x1b[200~')) {
            pasting = true;
            pending = pending.slice(6);
            continue;
        }
        if (pending[0] === '\x1b') {
            if (approval) {
                approval(false);
                pending = pending.slice(1);
                continue;
            }
            // The start of a paste split across chunks: wait for the rest.
            if ('\x1b[200~'.startsWith(pending)) break;
            // Another escape sequence (arrows and the like): skip it, or wait for the rest of it.
            let match = null;
            if (pending[1] === '[') match = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
            else if (pending[1] === 'O') match = pending.length >= 3 ? [pending.slice(0, 3)] : null;
            else match = [pending.slice(0, 2)];
            if (!match) {
                if (pending.length < 16) break;
                pending = pending.slice(1);
                continue;
            }
            pending = pending.slice(match[0].length);
            continue;
        }
        const key = pending[0];
        pending = pending.slice(1);
        if (approval) {
            if (key === '1' || key === 'y' || key === '\r' || key === '\n') approval(true);
            else if (key === '2' || key === 'n') approval(false);
            continue;
        }
        if (key === '\r' || key === '\n') {
            if (swallowNext) {
                swallowNext = false;
                continue;
            }
            submit();
        } else if (key === '\x7f' || key === '\b') {
            input = input.slice(0, -1);
            prompt();
        } else if (key === '\x03') {
            quit(130);
        } else if (key === '\x04') {
            if (!input) quit(0);
        } else if (key >= ' ') {
            input += key;
            prompt();
        }
    }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', onKeys);
process.stdin.on('end', () => quit(0));
process.on('SIGTERM', () => quit(143));
process.on('SIGHUP', () => quit(129));
