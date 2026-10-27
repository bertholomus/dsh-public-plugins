/**
 * Which notes Canon gives a prompt, measured on a labelled set: every
 * prompt goes through Canon's own recall exactly as a turn's first step
 * does (the `agent/pre-step` handler, with Canon's default settings: at
 * most 3 notes and 2,000 characters), over the fixture vault, and the
 * block it adds is compared with the set's answers.
 *
 * A set is a JSON list of `{ "id", "kind", "folder", "prompt", "answers" }`:
 * - `kind` (the dev set and the second hold-out have one; the first
 *   hold-out has none): `answers` (a note answers it), `coding` (an
 *   everyday coding request no note answers), `project` (it is about a
 *   project, and no note says what it asks), `chat` (chat filler), `vault`
 *   (words about the vault and answering from it) or `other`;
 * - `folder`: the session's folder, a full path (`/Users/someone/...`), one
 *   that starts with `~/` (the measuring home, /Users/someone), or "" for a
 *   session with none;
 * - `answers`: the vault paths of the notes that answer the prompt, empty
 *   when none does. Only notes Canon may add can answer: active notes (no
 *   status, or `status: active`) outside Drafts/, never a draft, an idea
 *   or decision with another status, `.obsidian/`, `.trash/` or a file that
 *   is not Markdown.
 *
 * The figures (the floors are OPEN-QUESTIONS #29 and #33):
 * - of the prompts a note answers: the share whose block's first note
 *   answers, the share whose block holds an answering note, and the mean
 *   number of notes per block that do not answer (over those prompts'
 *   blocks);
 * - of the prompts no note answers: the share that get no block;
 * - of the everyday coding requests no note answers (kind `coding`): the
 *   share that get no block.
 *
 * @module test/helpers/canon-relevance
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, resolved } from '../../plugins/canon/lib/config.js';
import { KIND, Recall } from '../../plugins/canon/lib/recall.js';
import { Vault } from '../../plugins/canon/lib/vault.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** The fixture vault the sets are labelled on (frozen: a note changed there would make the labels wrong). */
export const VAULT = join(ROOT, 'test', 'fixtures', 'canon', 'vault');
/** Where the sets live. */
export const SETS = join(ROOT, 'test', 'fixtures', 'canon', 'relevance');
export const DEV = join(SETS, 'dev.json');
/**
 * Dev prompts by two fresh writers who read only the frozen vault and never
 * saw Canon (OPEN-QUESTIONS #38): part of the dev set from round 3,
 * measured once before they were tuned on.
 */
export const DEV_FRESH = join(SETS, 'dev-fresh.json');
/**
 * The round-3 judge's two sets, written on this same fixture vault and so
 * seen (dev only, from round 4): 86 everyday prompts and 43 casually typed
 * ones, 41 of them coding requests ("how do i check if a port is free from
 * a shell script"). Four prompts that repeat a dev prompt word for word in
 * the same folder are left out.
 */
export const DEV_JUDGE = join(SETS, 'dev-judge.json');
/**
 * Round 4's builder's own: casually typed coding requests ("redis: set a key
 * with an expiry in one command"), casually typed questions a note answers
 * ("gateway health check port?"), and statements of a decision or a lesson
 * to record ("we decided …, put that in the notes"), half with a note in
 * force on the same subject and half without.
 */
export const DEV_CASUAL = join(SETS, 'dev-casual.json');
/** The dev set's files: the dev measure reads them as one set. */
export const DEV_FILES = Object.freeze([DEV, DEV_FRESH, DEV_JUDGE, DEV_CASUAL]);
/**
 * Round 5's probe sets (tuned on, apart from the dev set): two fresh writers
 * who read only the frozen vault and never saw Canon, one typing casually
 * (w1-…: "postgres: total of entries per account per month") and one with
 * care (w3-…): 110 everyday coding requests, 96 prompts a note answers and
 * 14 others. Measured once at 53646c8 and at 341ff4e before any rule
 * changed for them.
 */
export const PROBES = join(SETS, 'probes.json');
/** Written by fresh writers who never saw Canon's code or the dev set; measured once. */
export const HOLDOUT = join(SETS, 'holdout.json');
/** The second hold-out (OPEN-QUESTIONS #33), with everyday coding requests, from two more fresh writers. */
export const HOLDOUT2 = join(SETS, 'holdout2.json');
/**
 * The third hold-out (OPEN-QUESTIONS #41): casually typed coding requests
 * and statements of a decision to record, among other prompts, from two
 * fresh writers who saw only the vault; measured once when round 4's rules
 * are frozen. Its tests skip while it is not there.
 */
export const HOLDOUT3 = join(SETS, 'holdout3.json');
/** The home folder the sets' folders are measured under. */
export const HOME = '/Users/someone';
/**
 * The floors, fixed before anything was measured: OPEN-QUESTIONS #29
 * (first, inBlock, extraPerBlock, noBlock) and #33 (coding: no block for an
 * everyday coding request no note answers).
 */
export const FLOORS = Object.freeze({ first: 0.8, inBlock: 0.9, extraPerBlock: 1.0, noBlock: 0.7, coding: 0.9 });
/** The kinds a prompt may have. */
export const KINDS = Object.freeze(['answers', 'coding', 'project', 'chat', 'vault', 'other']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A set from its file, its shape checked: every entry has an id (unique),
 * a folder, a prompt, a list of answers, and a kind from KINDS when it has
 * one (`kinds: true`: every entry must have one).
 * @param {string} file
 * @param {{ kinds?: boolean }} [options]
 */
export function loadSet(file, { kinds = false } = {}) {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error(`${file}: a set is a JSON list`);
    const ids = new Set();
    for (const [i, entry] of list.entries()) {
        const where = `${file} entry ${i + 1}`;
        if (!isRecord(entry)) throw new Error(`${where}: each entry is an object`);
        if (typeof entry.id !== 'string' || entry.id === '') throw new Error(`${where}: "id" must be a string`);
        if (ids.has(entry.id)) throw new Error(`${where}: the id ${entry.id} is used twice`);
        ids.add(entry.id);
        if (typeof entry.folder !== 'string') throw new Error(`${where} (${entry.id}): "folder" must be a string ("" for none)`);
        if (typeof entry.prompt !== 'string' || entry.prompt.trim() === '') throw new Error(`${where} (${entry.id}): "prompt" must be text`);
        if (!Array.isArray(entry.answers) || entry.answers.some((a) => typeof a !== 'string')) throw new Error(`${where} (${entry.id}): "answers" must be a list of vault paths`);
        if (entry.kind === undefined ? kinds : !KINDS.includes(entry.kind)) throw new Error(`${where} (${entry.id}): "kind" must be one of ${KINDS.join(', ')}`);
    }
    return list;
}

/**
 * The whole dev set: its files (DEV_FILES) as one list, every entry with a
 * kind, no id in two of them.
 */
export function loadDev() {
    const list = DEV_FILES.flatMap((file) => loadSet(file, { kinds: true }));
    const ids = new Set();
    for (const entry of list) {
        if (ids.has(entry.id)) throw new Error(`the dev set's id ${entry.id} is used in two of its files`);
        ids.add(entry.id);
    }
    return list;
}

/** A set's folder as a turn's session has it: `~/` is the measuring home. */
export function folderOf(folder, home = HOME) {
    const text = folder.trim();
    if (text === '~') return home;
    if (text.startsWith('~/')) return join(home, text.slice(2));
    return text;
}

const share = (n, of) => (of ? n / of : 0);

/**
 * Measure a set: each prompt's block as a turn gets it, and the figures.
 * @param {{ id: string, kind?: string, folder: string, prompt: string, answers: string[] }[]} entries
 * @param {{ vault?: string, home?: string }} [options]
 */
export async function measure(entries, { vault: dir = VAULT, home = HOME } = {}) {
    const vault = new Vault({ where: () => ({ vault: dir, draftsFolder: DEFAULTS.draftsFolder }), home });
    await vault.refresh();
    if (vault.status().state !== 'ok') throw new Error(`the vault ${dir} could not be read: ${vault.status().error?.text ?? vault.status().state}`);
    const settings = resolved({ ...DEFAULTS, vault: dir }, home);
    const recall = new Recall({
        vault,
        settings: () => settings,
        working: () => true,
        isOff: () => false,
        makeMessage: (text, source) => ({ role: 'user', content: [{ type: 'text', text }], source }),
    });
    const problems = [];
    const rows = [];
    for (const [i, entry] of entries.entries()) {
        for (const path of entry.answers) {
            if (!vault.index.has(path)) problems.push(`${entry.id}: ${path} is not an active note in the vault, so no turn can get it`);
        }
        if (entry.kind !== undefined && (entry.kind === 'answers') !== (entry.answers.length > 0)) {
            problems.push(`${entry.id}: its kind is ${entry.kind} but it lists ${entry.answers.length} answers (kind answers, and only it, lists the notes that answer)`);
        }
        const folder = folderOf(entry.folder, home);
        if (folder !== '' && !folder.startsWith('/')) problems.push(`${entry.id}: the folder ${JSON.stringify(entry.folder)} is not a full path, one starting with ~/, or ""`);
        const session = `measure-${i + 1}`;
        const prompt = { id: `prompt-${i + 1}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: entry.prompt }] };
        const payload = { agent: { id: session, session: { id: session, header: folder ? { cwd: folder } : {} } }, messages: [prompt], step: 1, turn: 1 };
        const decision = await recall.preStep(payload, async () => ({ kind: 'enter', messages: [prompt] }));
        const added = decision.messages.find((m) => m?.source?.kind === KIND);
        const got = added ? added.source.notes.map((n) => n.path) : [];
        const answers = new Set(entry.answers);
        rows.push({
            id: entry.id,
            kind: entry.kind ?? '',
            folder: entry.folder,
            prompt: entry.prompt,
            answers: entry.answers,
            got,
            chars: added ? added.source.chars : 0,
            first: got.length > 0 && answers.has(got[0]),
            inBlock: got.some((p) => answers.has(p)),
            extra: got.filter((p) => !answers.has(p)).length,
        });
    }
    const answerable = rows.filter((r) => r.answers.length > 0);
    const none = rows.filter((r) => r.answers.length === 0);
    const coding = none.filter((r) => r.kind === 'coding');
    const blocks = answerable.filter((r) => r.got.length > 0);
    const extra = blocks.reduce((sum, r) => sum + r.extra, 0);
    const summary = {
        prompts: rows.length,
        answerable: {
            n: answerable.length,
            first: answerable.filter((r) => r.first).length,
            inBlock: answerable.filter((r) => r.inBlock).length,
            blocks: blocks.length,
            extra,
            extraPerBlock: blocks.length ? extra / blocks.length : 0,
        },
        unanswerable: {
            n: none.length,
            noBlock: none.filter((r) => r.got.length === 0).length,
            extra: none.reduce((sum, r) => sum + r.got.length, 0),
        },
        coding: {
            n: coding.length,
            noBlock: coding.filter((r) => r.got.length === 0).length,
            extra: coding.reduce((sum, r) => sum + r.got.length, 0),
        },
    };
    summary.rates = {
        first: share(summary.answerable.first, summary.answerable.n),
        inBlock: share(summary.answerable.inBlock, summary.answerable.n),
        extraPerBlock: summary.answerable.extraPerBlock,
        noBlock: share(summary.unanswerable.noBlock, summary.unanswerable.n),
        coding: share(summary.coding.noBlock, summary.coding.n),
    };
    const misses = rows.filter((r) => (r.answers.length ? !r.first || r.extra > 0 : r.got.length > 0));
    return { rows, summary, misses, problems };
}

/**
 * Whether a measured set meets every floor, and the ones it misses in
 * words. The coding floor applies to a set with prompts of kind `coding`
 * (the first hold-out has no kinds, so it is held to the other four).
 */
export function belowFloors({ summary }) {
    const r = summary.rates;
    const out = [];
    if (r.first < FLOORS.first) out.push(`first note answers ${pct(r.first)} (floor ${pct(FLOORS.first)})`);
    if (r.inBlock < FLOORS.inBlock) out.push(`an answering note in the block ${pct(r.inBlock)} (floor ${pct(FLOORS.inBlock)})`);
    if (r.extraPerBlock > FLOORS.extraPerBlock) out.push(`notes per block that do not answer ${r.extraPerBlock.toFixed(2)} (at most ${FLOORS.extraPerBlock.toFixed(1)})`);
    if (r.noBlock < FLOORS.noBlock) out.push(`no block for a prompt no note answers ${pct(r.noBlock)} (floor ${pct(FLOORS.noBlock)})`);
    if (summary.coding.n > 0 && r.coding < FLOORS.coding) out.push(`no block for an everyday coding request no note answers ${pct(r.coding)} (floor ${pct(FLOORS.coding)})`);
    return out;
}

const pct = (x) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

/** A set's figures as a Markdown table, as the README shows them. */
export function table(name, { summary }) {
    const a = summary.answerable;
    const u = summary.unanswerable;
    const c = summary.coding;
    const r = summary.rates;
    return [
        `${name}: ${summary.prompts} prompts, ${a.n} that a note answers, ${u.n} that none does${c.n ? ` (${c.n} of them everyday coding requests)` : ''}`,
        '',
        '| Figure | Measured | Floor |',
        '|---|---|---|',
        `| The block's first note answers | ${a.first} of ${a.n} (${pct(r.first)}) | at least ${pct(FLOORS.first)} |`,
        `| An answering note is in the block | ${a.inBlock} of ${a.n} (${pct(r.inBlock)}) | at least ${pct(FLOORS.inBlock)} |`,
        `| Notes per block that do not answer | ${r.extraPerBlock.toFixed(2)} (${a.extra} in ${a.blocks} blocks) | at most ${FLOORS.extraPerBlock.toFixed(1)} |`,
        `| No block, for a prompt no note answers | ${u.noBlock} of ${u.n} (${pct(r.noBlock)}) | at least ${pct(FLOORS.noBlock)} |`,
        ...(c.n ? [`| No block, for an everyday coding request no note answers | ${c.noBlock} of ${c.n} (${pct(r.coding)}) | at least ${pct(FLOORS.coding)} |`] : []),
    ].join('\n');
}

/**
 * The prompts by kind (or, in a set without kinds, by the letters their ids
 * start with), each group with how it went. The notes that do not answer
 * are counted apart: `extra` in the blocks of prompts a note answers (as the
 * table counts them), `given` to prompts no note answers (the table counts
 * those only as prompts with a block).
 */
export function groups({ rows }) {
    const out = new Map();
    for (const r of rows) {
        const key = r.kind || r.id.replace(/\d+$/, '') || r.id;
        const g = out.get(key) ?? { n: 0, answerable: 0, first: 0, inBlock: 0, blocks: 0, extra: 0, none: 0, noBlock: 0, given: 0 };
        g.n += 1;
        if (r.answers.length) {
            g.answerable += 1;
            if (r.first) g.first += 1;
            if (r.inBlock) g.inBlock += 1;
            if (r.got.length) g.blocks += 1;
            g.extra += r.extra;
        } else {
            g.none += 1;
            if (r.got.length === 0) g.noBlock += 1;
            g.given += r.got.length;
        }
        out.set(key, g);
    }
    return out;
}

const counted = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One group of groups() in words, saying what each count counts. */
export function groupText(key, g) {
    const parts = [];
    if (g.answerable) {
        parts.push(`of ${g.answerable} a note answers, the first note answers in ${g.first} and an answering note is in the block in ${g.inBlock}, with ${counted(g.extra, 'note')} that do not answer in their ${counted(g.blocks, 'block')}`);
    }
    if (g.none) {
        const rest = g.none - g.noBlock;
        parts.push(rest === 0
            ? `of ${g.none} no note answers, ${g.none === 1 ? 'it got' : `all ${g.none} got`} no block`
            : `of ${g.none} no note answers, ${g.noBlock} got no block and the other ${rest} got ${counted(g.given, 'note')}`);
    }
    return `${key}: ${parts.join('; ')}`;
}

/** A miss in a few lines: the prompt, its kind and folder, what answers it, and what the turn got. */
export function missText(r) {
    return [
        `${r.id}${r.kind ? ` (${r.kind})` : ''} ${JSON.stringify(r.prompt)}${r.folder ? ` in ${r.folder}` : ' (no folder)'}`,
        `    answers: ${r.answers.join(', ') || '(none)'}`,
        `    got:     ${r.got.join(', ') || '(no block)'}`,
    ].join('\n');
}
