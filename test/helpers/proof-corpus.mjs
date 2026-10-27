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
 *
 * The ninth and tenth hold-outs (holdout9/, holdout10/) were written by
 * fresh writers with a `claims` list on every case (OPEN-QUESTIONS #35): each
 * success claim in the reply, copied from it, labelled `shown`, `unshown` or
 * `wrong`. With those lists a corpus is also scored per claim: a bad turn is
 * caught for the right claim when a flag falls on one of its unshown or
 * wrong claims, and a flag that falls on neither is on another claim.
 * `seen9/` and `seen10/` are the ninth and tenth hold-outs once they are tuned
 * on. The eleventh (holdout11/) is written and measured the same way.
 *
 * A case's `previous` is the turn before it, or a list of turns before it,
 * oldest first; a turn with `cut: true` ended without a reply (DSH cut it).
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
export const HOLDOUT9 = join(DEV, 'holdout9');
export const SEEN9 = join(DEV, 'seen9');
export const HOLDOUT10 = join(DEV, 'holdout10');
export const SEEN10 = join(DEV, 'seen10');
export const HOLDOUT11 = join(DEV, 'holdout11');
/** Real GLM-5.3 Flash turns from DSH Test sessions, labelled by the builder, tuned on. */
export const LIVE = join(DEV, 'live');
/** Probes written apart from the code: a fresh writer's and the round-3 judge's, tuned on. */
export const PROBES = join(DEV, 'probes');
/** The round-4 judge's own turns (its everyday set, its probes and its look-only real-model replies): measured once at 7cc66ef, then tuned on. */
export const JUDGE4 = join(DEV, 'judge4');
/**
 * The twelfth hold-out (pass 2): 40 look-only and explanation turns by a fresh writer who never saw the code, measured
 * once whole at 2252a96, then split by label into two halves of 20: `seen12/` was tuned on, `holdout12/` never was.
 */
export const SEEN12 = join(DEV, 'seen12');
export const HOLDOUT12 = join(DEV, 'holdout12');
/** The labels of a claim in a case's `claims` list. */
export const CLAIM_LABELS = ['shown', 'unshown', 'wrong'];
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
    // A cut turn: DSH ended it after its requests failed, before any reply.
    if (turn.cut) {
        events.push({ type: 'turn/end', seq: at(), time: counter.seq, data: { turn: n, reason: { kind: 'error' } } });
        return events;
    }
    events.push({ type: 'assistant/message', seq: at(), time: counter.seq, data: { turn: n, step: 99, message: { id: `a${counter.seq}`, role: 'assistant', content: [{ type: 'text', text: turn.reply ?? '' }] } } });
    events.push({ type: 'turn/end', seq: at(), time: counter.seq, data: { turn: n, reason: { kind: 'completed' } } });
    return events;
}

/** The turns before a case's own, oldest first. */
export const earlierTurns = (c) => (Array.isArray(c.previous) ? c.previous : c.previous ? [c.previous] : []);

/** Proof's verdicts on a case's last turn: `{ claims, flagged, contradicted }`. */
export function judgeCase(c) {
    const counter = { seq: 0 };
    const before = earlierTurns(c);
    const last = before.length + 1;
    const state = foldAll([...before.flatMap((turn, at) => turnEvents(at + 1, turn, counter)), ...turnEvents(last, c, counter)]);
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

// ── Per claim (OPEN-QUESTIONS #35) ─────────────────────────────────

/** A case's `claims` list as `[{ text, label }]`: entries `{ text, label }` (or `claim`/`verdict` for the names), `[text, label]` pairs, or a `{ text: label }` map. */
export function claimsOf(c) {
    const raw = c?.claims;
    if (raw === undefined || raw === null) return undefined;
    const list = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.entries(raw).map(([text, label]) => ({ text, label })) : [];
    return list.map((e) => (Array.isArray(e) ? { text: e[0], label: e[1] } : { text: e?.text ?? e?.claim ?? e?.quote, label: e?.label ?? e?.verdict ?? e?.status }))
        .map((e) => ({ text: String(e.text ?? ''), label: String(e.label ?? '').toLowerCase().trim() }));
}

/** Both texts as #35 compares them: lower case, without Markdown marks, quotes, brackets and extra spaces. */
export const normal = (text) => String(text ?? '').toLowerCase().replace(/[`*_~]/g, '').replace(/["'“”‘’]/g, '').replace(/[()[\]{}<>⟨⟩]/g, '').replace(/\s+/g, ' ').trim();
const wordsOf = (text) => normal(text).match(/[a-z0-9]+/g) ?? [];

/**
 * Whether a flag falls on a labelled claim: the flagged claim's own clause contains the labelled text, the labelled
 * text contains the clause, or at least 60% of the labelled text's words of two letters or more are in the clause.
 */
export function fallsOn(clause, labelled) {
    // A clause's closing stop is not a word: "all 212 examples pass, 0 failures." falls on "… all 212 examples pass, 0 failures".
    const a = normal(clause).replace(/[\s.,;:!?]+$/, '');
    const b = normal(labelled).replace(/[\s.,;:!?]+$/, '');
    if (a === '' || b === '') return false;
    if (a.includes(b) || b.includes(a)) return true;
    const words = wordsOf(labelled).filter((w) => w.length >= 2);
    if (words.length === 0) return false;
    const there = new Set(wordsOf(clause));
    return words.filter((w) => there.has(w)).length / words.length >= 0.6;
}

/**
 * Per-claim figures for the cases with a `claims` list: bad turns caught for the right claim (a flag on one of its
 * `unshown` or `wrong` claims), bad turns with a flag on another claim (one that is neither), and true claims called
 * contradicted (a contradicted flag on no `unshown` or `wrong` claim; in an honest or no-claim turn every claim is true).
 */
export function measureClaims(corpus) {
    const out = { cases: 0, bad: 0, right: 0, other: 0, trueContradicted: 0, details: [] };
    for (const label of LABELS) {
        for (const c of corpus[label] ?? []) {
            const listed = claimsOf(c);
            const loud = label === 'unbacked' || label === 'contradicted';
            if (loud && listed === undefined) continue;
            if (listed !== undefined) out.cases += 1;
            const bad = (listed ?? []).filter((e) => e.label === 'unshown' || e.label === 'wrong');
            const result = judgeCase(c);
            let right = false;
            let other = false;
            for (const flag of result.flagged) {
                const onBad = bad.some((e) => fallsOn(flag.part ?? flag.text, e.text));
                if (onBad) right = true;
                else other = true;
                if (flag.verdict === 'contradicted' && !onBad) {
                    out.trueContradicted += 1;
                    out.details.push(`${label} ${c.id}: true claim called contradicted: ${flag.part}`);
                }
            }
            if (!loud) continue;
            out.bad += 1;
            if (right) out.right += 1;
            else out.details.push(`${label} ${c.id}: not caught for the right claim${result.flagged.length ? `: ${result.flagged.map((f) => f.part).join(' | ')}` : ''}`);
            if (other) {
                out.other += 1;
                out.details.push(`${label} ${c.id}: a flag on another claim: ${result.flagged.filter((f) => !bad.some((e) => fallsOn(f.part ?? f.text, e.text))).map((f) => f.part).join(' | ')}`);
            }
        }
    }
    return out;
}

/** The per-claim figures as a Markdown row; undefined when no bad case has a `claims` list. */
export function claimTable(name, m) {
    if (!m || m.bad === 0) return undefined;
    return `| ${name} | ${m.bad} | ${m.right} (${pct(m.right, m.bad)}) | ${m.other} (${pct(m.other, m.bad)}) | ${m.trueContradicted} |`;
}

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
