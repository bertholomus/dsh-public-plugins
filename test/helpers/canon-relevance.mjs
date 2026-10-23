/**
 * Which notes Canon gives a prompt, measured on a labelled set: every
 * prompt goes through Canon's own recall exactly as a turn's first step
 * does (the `agent/pre-step` handler, with Canon's default settings: at
 * most 3 notes and 2,000 characters), over the fixture vault, and the
 * block it adds is compared with the set's answers.
 *
 * A set is a JSON list of `{ "id", "folder", "prompt", "answers" }`:
 * - `folder`: the session's folder, a full path (`/Users/someone/...`), one
 *   that starts with `~/` (the measuring home, /Users/someone), or "" for a
 *   session with none;
 * - `answers`: the vault paths of the notes that answer the prompt, empty
 *   when none does. Only notes Canon may add can answer: active notes (no
 *   status, or `status: active`) outside Drafts/, never a draft, an idea
 *   or decision with another status, `.obsidian/`, `.trash/` or a file that
 *   is not Markdown.
 *
 * The figures (the floors are OPEN-QUESTIONS #29):
 * - of the prompts a note answers: the share whose block's first note
 *   answers, the share whose block holds an answering note, and the mean
 *   number of notes per block that do not answer (over those prompts'
 *   blocks);
 * - of the prompts no note answers: the share that get no block.
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
/** Written by fresh writers who never saw Canon's code or the dev set; measured once. */
export const HOLDOUT = join(SETS, 'holdout.json');
/** The home folder the sets' folders are measured under. */
export const HOME = '/Users/someone';
/** The floors of OPEN-QUESTIONS #29, fixed before anything was measured. */
export const FLOORS = Object.freeze({ first: 0.8, inBlock: 0.9, extraPerBlock: 1.0, noBlock: 0.7 });

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A set from its file, its shape checked: every entry has an id (unique),
 * a folder, a prompt and a list of answers.
 * @param {string} file
 */
export function loadSet(file) {
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
 * @param {{ id: string, folder: string, prompt: string, answers: string[] }[]} entries
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
    };
    summary.rates = {
        first: share(summary.answerable.first, summary.answerable.n),
        inBlock: share(summary.answerable.inBlock, summary.answerable.n),
        extraPerBlock: summary.answerable.extraPerBlock,
        noBlock: share(summary.unanswerable.noBlock, summary.unanswerable.n),
    };
    const misses = rows.filter((r) => (r.answers.length ? !r.first || r.extra > 0 : r.got.length > 0));
    return { rows, summary, misses, problems };
}

/** Whether a measured set meets every floor, and the ones it misses in words. */
export function belowFloors({ summary }) {
    const r = summary.rates;
    const out = [];
    if (r.first < FLOORS.first) out.push(`first note answers ${pct(r.first)} (floor ${pct(FLOORS.first)})`);
    if (r.inBlock < FLOORS.inBlock) out.push(`an answering note in the block ${pct(r.inBlock)} (floor ${pct(FLOORS.inBlock)})`);
    if (r.extraPerBlock > FLOORS.extraPerBlock) out.push(`notes per block that do not answer ${r.extraPerBlock.toFixed(2)} (at most ${FLOORS.extraPerBlock.toFixed(1)})`);
    if (r.noBlock < FLOORS.noBlock) out.push(`no block for a prompt no note answers ${pct(r.noBlock)} (floor ${pct(FLOORS.noBlock)})`);
    return out;
}

const pct = (x) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

/** A set's figures as a Markdown table, as the README shows them. */
export function table(name, { summary }) {
    const a = summary.answerable;
    const u = summary.unanswerable;
    const r = summary.rates;
    return [
        `${name}: ${summary.prompts} prompts, ${a.n} that a note answers, ${u.n} that none does`,
        '',
        '| Figure | Measured | Floor |',
        '|---|---|---|',
        `| The block's first note answers | ${a.first} of ${a.n} (${pct(r.first)}) | at least ${pct(FLOORS.first)} |`,
        `| An answering note is in the block | ${a.inBlock} of ${a.n} (${pct(r.inBlock)}) | at least ${pct(FLOORS.inBlock)} |`,
        `| Notes per block that do not answer | ${r.extraPerBlock.toFixed(2)} (${a.extra} in ${a.blocks} blocks) | at most ${FLOORS.extraPerBlock.toFixed(1)} |`,
        `| No block, for a prompt no note answers | ${u.noBlock} of ${u.n} (${pct(r.noBlock)}) | at least ${pct(FLOORS.noBlock)} |`,
    ].join('\n');
}

/** The prompts by the letters their ids start with (a, p, f, …), each with how it went. */
export function groups({ rows }) {
    const out = new Map();
    for (const r of rows) {
        const key = r.id.replace(/\d+$/, '') || r.id;
        const g = out.get(key) ?? { n: 0, answerable: 0, first: 0, inBlock: 0, noBlock: 0, extra: 0 };
        g.n += 1;
        if (r.answers.length) {
            g.answerable += 1;
            if (r.first) g.first += 1;
            if (r.inBlock) g.inBlock += 1;
            g.extra += r.extra;
        } else if (r.got.length === 0) g.noBlock += 1;
        else g.extra += r.got.length;
        out.set(key, g);
    }
    return out;
}

/** A miss in a few lines: the prompt, its folder, what answers it, and what the turn got. */
export function missText(r) {
    return [
        `${r.id} ${JSON.stringify(r.prompt)}${r.folder ? ` in ${r.folder}` : ' (no folder)'}`,
        `    answers: ${r.answers.join(', ') || '(none)'}`,
        `    got:     ${r.got.join(', ') || '(no block)'}`,
    ].join('\n');
}
