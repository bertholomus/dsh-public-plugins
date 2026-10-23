/**
 * Synthetic DSH session logs for Recall's tests, its bench and its real-DSH
 * test: the same file layout and event shapes DSH writes
 * (`<sessions>/<project>/<session>/session.v4.jsonl.zstd`, one zstd frame
 * per write, JSON lines of a header and events), with made-up words. No real
 * session is read or copied.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

/** Where DSH keeps a session's log under its sessions folder. */
export function sessionFile(sessionsDir, id, project = 'workspace') {
    return join(sessionsDir, project, encodeURIComponent(id), 'session.v4.jsonl.zstd');
}

/** One zstd frame of JSON lines, as DSH appends them. */
export const frame = (...events) => zlib.zstdCompressSync(Buffer.from(events.map((e) => `${JSON.stringify(e)}\n`).join('')));

/**
 * A session log writer: `header()`, then `turn(...)` for each turn (one frame
 * per event, as DSH writes them), `title()`, `raw()` for anything else.
 */
export function sessionWriter(file, { id, cwd = '/work/project', createdAt = Date.UTC(2026, 9, 1, 17, 0, 0), seeded = false, depth = 0, provider = 'local', model = 'glm-test' } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    let seq = 0;
    let turn = 0;
    const put = (...events) => appendFileSync(file, frame(...events));
    const event = (type, data, time) => ({ type, seq: ++seq, time, data });
    const w = {
        file,
        get seq() { return seq; },
        get turns() { return turn; },
        header() {
            put({ type: 'session', version: 4, id, createdAt, cwd, isSeeded: seeded, delegationDepth: depth, agentPreset: 'default' });
            // DSH writes its system prompt and request header lines too: big, and of no use to search.
            put(event('system/message', { text: 'You are a coding agent. '.repeat(40) }, createdAt));
            return w;
        },
        /**
         * A whole turn: the person's words, context DSH injects, tool calls, the reply, its end. `end`: true (it
         * completed), false (left open), or DSH's reason for its end (`{ kind: 'aborted', reason: { kind: 'user' } }`).
         */
        turn({ prompt, reply = '', tools = [], at = createdAt + turn * 60_000, context = [], end = true, source = { kind: 'user' }, turnModel = model }) {
            turn += 1;
            // DSH's order: the turn starts, then each step logs its request's messages (the person's, then context).
            const start = event('turn/start', { turn }, at);
            put(start);
            put(event('request/context', { provider, model: turnModel }, at));
            put(event('request/header', { headers: { 'x-trace': 'x'.repeat(200) } }, at));
            put(event('user/message', { role: 'user', content: [{ type: 'text', text: prompt }], source }, at));
            for (const c of context) put(event('user/message', { role: 'user', content: [{ type: 'text', text: c.text }], source: { kind: c.kind ?? 'runtime-context', ...(c.form ? { form: c.form } : {}) } }, at));
            for (const [name, args] of tools) {
                put(event('tool/call', { name, arguments: JSON.stringify(args) }, at + 500));
                put(event('tool/result', { output: 'output '.repeat(50) }, at + 600));
            }
            if (reply) put(event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: reply }], source: { kind: 'model', provider, model: turnModel } } }, at + 1000));
            if (end) put(event('turn/end', { turn, reason: end === true ? { kind: 'completed' } : end }, at + 2000));
            return start.seq;
        },
        /** The end of a turn left open, with DSH's reason (completed unless given). */
        end(at, reason = { kind: 'completed' }) {
            put(event('turn/end', { turn, reason }, at));
        },
        title(text, at = createdAt) {
            put(event('session/title', { title: text }, at));
        },
        endSeed(at = createdAt) {
            put(event('session/end-seed', { inherited: true }, at));
        },
        raw(buffer) {
            appendFileSync(file, buffer);
        },
    };
    return w;
}

// ── A corpus for the bench ──────────────────────────────────────────

const VOCAB = ('deploy gateway staging rollback parser tokenizer cache index migration schema router handler queue worker '
    + 'timeout retry backoff socket stream buffer encoder decoder session token config profile plugin sidebar render '
    + 'layout theme palette contrast shader texture vertex fragment compile linker bundle chunk module import export '
    + 'promise async await thread mutex channel signal process daemon service cluster replica shard partition ledger '
    + 'invoice payment refund ticket incident alert metric dashboard latency throughput benchmark profile flame graph '
    + 'kernel driver firmware sensor camera audio codec network packet header payload checksum digest hash cipher key '
    + 'vault secret policy role grant audit trail backup restore snapshot volume mount fabric switch router subnet vlan').split(' ');

/** A small seeded random source, so a corpus is the same every run. */
export function rng(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

const sentence = (r, n) => Array.from({ length: n }, () => VOCAB[Math.floor(r() * VOCAB.length)]).join(' ');

/**
 * Write `sessions` synthetic sessions (2 to 22 turns each) under
 * `sessionsDir`, over the year before `now`, in 40 project folders.
 * @returns {{ files: number, turns: number, bytes: number }}
 */
export function writeCorpus(sessionsDir, { sessions = 10_000, seed = 7, now = Date.UTC(2026, 9, 17, 12, 0, 0), rare = [] } = {}) {
    const r = rng(seed);
    let turns = 0;
    let bytes = 0;
    for (let i = 0; i < sessions; i += 1) {
        const id = `bench-${String(i).padStart(5, '0')}`;
        const project = `project-${i % 40}`;
        const createdAt = now - Math.floor(r() * 365 * 86_400_000);
        const n = 2 + Math.floor(r() * 21);
        const parts = [];
        let seq = 0;
        const event = (type, data, time) => ({ type, seq: ++seq, time, data });
        parts.push(frame({ type: 'session', version: 4, id, createdAt, cwd: `/work/${project}`, isSeeded: false, delegationDepth: 0, agentPreset: 'default' }));
        for (let t = 1; t <= n; t += 1) {
            const at = createdAt + t * 90_000;
            const extra = rare.find((x) => x.session === i && x.turn === t);
            const prompt = `${sentence(r, 6 + Math.floor(r() * 14))}${extra ? ` ${extra.word}` : ''}`;
            const reply = sentence(r, 40 + Math.floor(r() * 160));
            const model = r() < 0.5 ? 'glm-5.3-flash' : 'glm-5.3';
            parts.push(frame(
                event('turn/start', { turn: t }, at),
                event('request/context', { provider: 'local', model }, at),
                event('user/message', { role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }, at),
                event('tool/call', { name: 'bash', arguments: JSON.stringify({ command: `make ${VOCAB[Math.floor(r() * VOCAB.length)]}` }) }, at + 400),
                event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: reply }], source: { kind: 'model', provider: 'local', model } } }, at + 1000),
                event('turn/end', { turn: t, reason: { kind: 'completed' } }, at + 2000),
            ));
            if (t === 1) parts.push(frame(event('session/title', { title: sentence(r, 4) }, at + 2100)));
        }
        const file = sessionFile(sessionsDir, id, project);
        mkdirSync(dirname(file), { recursive: true });
        const data = Buffer.concat(parts);
        writeFileSync(file, data);
        turns += n;
        bytes += data.length;
    }
    return { files: sessions, turns, bytes };
}
