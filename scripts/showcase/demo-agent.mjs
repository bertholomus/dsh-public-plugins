#!/usr/bin/env node
/**
 * The coding agent of the Agent Terminals pictures: a small terminal app
 * named `coder` that reads typed and pasted messages, shows the commands it
 * runs, answers, and keeps its conversation as one JSON line per message in
 * ~/.coder/projects/<folder>/<id>.jsonl, the way the `flags` kind of
 * coding-agent CLI does (--session-id ID, --resume ID, --continue).
 *
 * What it runs and answers comes from the "agent" list of the demo script
 * (DEMO_AGENT_SCRIPT, scripts/showcase/demo.json): the first entry whose
 * `match` (a regex) fits the message gives its `tools` ({ command, output }),
 * its `reply`, an `ask` (a DECISION NEEDED line after the reply), or `hold`
 * (it keeps working on its last command until it is stopped). Nothing it
 * shows runs: the commands and their output are the script's.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
};
const cwd = process.cwd();
const home = homedir();
const homeless = (path) => (path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
const out = (text) => process.stdout.write(text);
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plans = (() => {
    try {
        return JSON.parse(readFileSync(process.env.DEMO_AGENT_SCRIPT ?? '', 'utf8')).agent ?? [];
    } catch {
        return [];
    }
})();

// ── The conversation and its transcript ─────────────────────────────────

const slug = (path) => path.replace(/[^A-Za-z0-9]/g, '-');
const dir = join(home, '.coder', 'projects', slug(cwd));
mkdirSync(dir, { recursive: true });
let id;
let resumed = false;
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
const file = join(dir, `${id}.jsonl`);
if (resumed && !existsSync(file)) {
    process.stderr.write(`No conversation found with session ID: ${id}\n`);
    process.exit(1);
}

let parent = null;
function entry(type, message) {
    const uuid = randomUUID();
    appendFileSync(file, `${JSON.stringify({ parentUuid: parent, isSidechain: false, type, message, uuid, timestamp: now(), sessionId: id, cwd, version: '2.1.0' })}\n`);
    parent = uuid;
}
const record = {
    user: (text) => entry('user', { role: 'user', content: text }),
    call: (callId, command) => entry('assistant', { role: 'assistant', model: 'local-model', content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command } }], stop_reason: 'tool_use' }),
    result: (callId, output) => entry('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: output }] }),
    reply: (text) => entry('assistant', { role: 'assistant', model: 'local-model', content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
};

// ── The screen ──────────────────────────────────────────────────────────

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const OFF = '\x1b[0m';
let input = '';
let pasting = false;
let busy = false;
const queue = [];

const shown = (text) => text.replace(/\n/g, ' ⏎ ');
/**
 * A line cut at words, each part with the line's own indent: to the
 * terminal's width, and at most 74 columns, since a tab opened later may be
 * narrower than the terminal was when the line was written.
 */
function wrapped(line, indent) {
    const width = Math.max(40, Math.min(process.stdout.columns || 80, 74) - indent.length - 1);
    const parts = [];
    let rest = line;
    while (rest.length > width) {
        const cut = rest.lastIndexOf(' ', width);
        const at = cut > width / 2 ? cut : width;
        parts.push(rest.slice(0, at));
        rest = rest.slice(at).trimStart();
    }
    parts.push(rest);
    return parts.map((part) => `${indent}${part}`);
}
function prompt() {
    out(`\r\x1b[2K${busy ? `${DIM}⋯${OFF} ` : `${CYAN}›${OFF} `}${shown(input)}`);
}
function say(line = '') {
    out(`\r\x1b[2K${line}\r\n`);
    prompt();
}

out('\x1b[?2004h');
out(`${BOLD}coder${OFF} 2.1 ${DIM}· local-model · ${homeless(cwd)}${OFF}\r\n`);
out(`${DIM}${resumed ? 'Resumed conversation' : 'Conversation'} ${id.slice(0, 8)}${OFF}\r\n\r\n`);
prompt();

// ── Work ────────────────────────────────────────────────────────────────

async function handle(text) {
    busy = true;
    record.user(text);
    say(`${CYAN}›${OFF} ${BOLD}${shown(text)}${OFF}`);
    say();
    const plan = plans.find((p) => new RegExp(p.match, 'i').test(text)) ?? { reply: 'Done.' };
    await sleep(plan.think ?? 900);
    for (const [i, tool] of (plan.tools ?? []).entries()) {
        const callId = `call_${randomUUID().slice(0, 8)}`;
        record.call(callId, tool.command);
        say(`  ${GREEN}●${OFF} ${tool.command}`);
        if (plan.hold && i === plan.tools.length - 1) {
            await new Promise(() => {});
        }
        await sleep(tool.work ?? 1100);
        for (const line of String(tool.output ?? '').split('\n')) if (line) say(`    ${DIM}${line}${OFF}`);
        record.result(callId, tool.output ?? '');
    }
    const reply = plan.ask ? `${plan.reply}\n\nDECISION NEEDED: ${plan.ask}` : plan.reply;
    record.reply(reply);
    say();
    for (const line of reply.split('\n')) for (const part of line ? wrapped(line, '  ') : ['']) say(part);
    say();
    busy = false;
    prompt();
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
        say(`${DIM}queued: ${shown(text)}${OFF}`);
        return;
    }
    void handle(text);
}

function quit(code) {
    out('\x1b[?2004l\r\n');
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
            prompt();
            continue;
        }
        if (pending.startsWith('\x1b[200~')) {
            pasting = true;
            pending = pending.slice(6);
            continue;
        }
        if (pending[0] === '\x1b') {
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
        if (key === '\r' || key === '\n') {
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
