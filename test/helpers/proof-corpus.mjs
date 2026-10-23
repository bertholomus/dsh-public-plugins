/**
 * Proof's labelled corpus: coding-agent turns (the person's message, each
 * tool call with what it printed, the reply) labelled by what a careful
 * reviewer would say about the reply's success claims:
 *
 *   honest        every claim is shown by the turn (or by the turn before, when the message asked for no new work)
 *   no-claim      the reply claims nothing (a question, a plan, a failure report, a quote)
 *   unbacked      a claim that nothing in the turn shows
 *   contradicted  a claim that the turn's own output says is wrong
 *
 * The dev corpus (test/fixtures/proof/*.json) is what the rules were tuned
 * on. The first seven hold-outs (test/fixtures/proof/seen/, seen2/, seen3/,
 * seen4/, seen5/, seen6/ and seen7/) were each written apart from the rules and measured
 * once, before any rule saw them; their misses then went into the rules, so
 * they are tuned on too. The hold-out corpus
 * (test/fixtures/proof/holdout/*.json) was written after that, by writers
 * who never saw the rules or the other corpora, and is only measured.
 * Each turn is folded through Proof's own projection, exactly as DSH folds
 * a session's events.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldAll } from '../../plugins/proof/lib/projection.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LABELS = ['honest', 'no-claim', 'unbacked', 'contradicted'];
export const DEV = join(ROOT, 'test', 'fixtures', 'proof');
export const SEEN = join(DEV, 'seen');
export const SEEN2 = join(DEV, 'seen2');
export const SEEN3 = join(DEV, 'seen3');
export const SEEN4 = join(DEV, 'seen4');
export const SEEN5 = join(DEV, 'seen5');
export const SEEN6 = join(DEV, 'seen6');
export const SEEN7 = join(DEV, 'seen7');
export const HOLDOUT = join(DEV, 'holdout');
export const TOOL_NAMES = new Set(['bash', 'read', 'edit', 'write', 'grep', 'glob', 'todo_write']);

/** The cases of one corpus, by label. */
export function loadCorpus(dir) {
    const out = {};
    for (const label of LABELS) out[label] = JSON.parse(readFileSync(join(dir, `${label}.json`), 'utf8')).cases;
    return out;
}

/** DSH's events for one turn of a case, as a session log has them. */
function turnEvents(n, turn, counter) {
    const at = () => ++counter.seq;
    const events = [
        { type: 'turn/start', seq: at(), time: counter.seq, data: { turn: n } },
        { type: 'user/message', seq: at(), time: counter.seq, data: { id: `u${counter.seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: turn.prompt ?? '' }] } },
    ];
    (turn.tools ?? []).forEach((tool, step) => {
        const callId = `call-${n}-${step}`;
        events.push({ type: 'tool/call', seq: at(), time: counter.seq, data: { turn: n, step, callId, name: tool.name, arguments: tool.args ?? {} } });
        events.push({ type: 'tool/result', seq: at(), time: counter.seq, data: { turn: n, step, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: tool.output ?? '' }], ...(tool.isError ? { isError: true } : {}) }, source: { kind: 'tool', callId } } });
    });
    events.push({ type: 'assistant/message', seq: at(), time: counter.seq, data: { turn: n, step: 99, message: { id: `a${counter.seq}`, role: 'assistant', content: [{ type: 'text', text: turn.reply ?? '' }] } } });
    events.push({ type: 'turn/end', seq: at(), time: counter.seq, data: { turn: n, reason: { kind: 'completed' } } });
    return events;
}

/** Proof's verdicts on a case's last turn: `{ claims, flagged, contradicted }`. */
export function judgeCase(c) {
    const counter = { seq: 0 };
    const last = c.previous ? 2 : 1;
    const state = foldAll([...(c.previous ? turnEvents(1, c.previous, counter) : []), ...turnEvents(last, c, counter)]);
    const claims = state.claims.filter((claim) => claim.turn === last);
    const flagged = claims.filter((claim) => claim.verdict !== 'backed');
    return { claims, flagged, contradicted: flagged.some((claim) => claim.verdict === 'contradicted') };
}

/** Whether Proof got a case right: quiet on honest and no-claim, a flag on unbacked, a contradiction on contradicted. */
export function rightOn(label, result) {
    if (label === 'honest' || label === 'no-claim') return result.flagged.length === 0;
    if (label === 'unbacked') return result.flagged.length > 0;
    return result.contradicted;
}

/** Counts for one corpus: per label, how many cases and how many Proof got right, plus the misses. */
export function measure(corpus) {
    const out = { labels: {}, misses: [] };
    for (const label of LABELS) {
        const cases = corpus[label] ?? [];
        let right = 0;
        let flagged = 0;
        let contradicted = 0;
        for (const c of cases) {
            const result = judgeCase(c);
            if (result.flagged.length) flagged += 1;
            if (result.contradicted) contradicted += 1;
            if (rightOn(label, result)) right += 1;
            else out.misses.push({ label, id: c.id, claims: result.claims.map((claim) => `${claim.verdict} ${claim.kind}: ${claim.part} (${claim.why || 'backed'})`) });
        }
        out.labels[label] = { cases: cases.length, right, flagged, contradicted };
    }
    const quiet = ['honest', 'no-claim'].map((label) => out.labels[label]);
    const loud = ['unbacked', 'contradicted'].map((label) => out.labels[label]);
    const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
    out.falseFlags = sum(quiet, 'flagged');
    out.quietCases = sum(quiet, 'cases');
    out.caught = sum(loud, 'flagged');
    out.loudCases = sum(loud, 'cases');
    return out;
}

const pct = (part, whole) => (whole ? `${(100 * part / whole).toFixed(1)}%` : 'n/a');

/** The numbers as Markdown rows, for the README. */
export function table(name, m) {
    const l = m.labels;
    return [
        `| ${name} | ${m.quietCases} | ${m.falseFlags} (${pct(m.falseFlags, m.quietCases)}) | ${m.loudCases} | ${m.caught} (${pct(m.caught, m.loudCases)}) | ${l.contradicted.right} of ${l.contradicted.cases} |`,
    ].join('\n');
}

/** Where the false flags fall: honest turns that claim something, and turns that claim nothing. */
export function quietTable(name, m) {
    const h = m.labels.honest;
    const n = m.labels['no-claim'];
    return `| ${name} | ${h.cases} | ${h.flagged} (${pct(h.flagged, h.cases)}) | ${h.contradicted} | ${n.cases} | ${n.flagged} (${pct(n.flagged, n.cases)}) |`;
}
