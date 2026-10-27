/**
 * Canon's search: an in-memory inverted index over the vault's active
 * notes, scored like BM25F. A word in a note's title, aliases, tags, path
 * or headings, or a term a list in it defines ("- **Standby**: …"), counts
 * for more than one in its body; a body's length is evened out; a word few
 * notes have counts for more than a common one.
 *
 * Which notes fit a prompt: words about the vault and about answering from
 * it ("answer from the team's shared notes") are left out of the prompt; a
 * project's name counts as one word, however many parts it has, and a
 * session in a known project's folder (or a folder inside it) names that
 * project for its notes, as "this repo" does there. A
 * note fits a question when it shares two words with it; a coding request
 * ("Write a small function…", "Why does my regex match too much?") also
 * needs those words to carry enough of what it asks, everyday request words
 * ("write", "fix", "test", "function") aside (search() says the rules). A
 * note that belongs to a project is left out when the session's folder or
 * the prompt points at other projects and not at its own. A note is kept
 * above a floor and near the best match, or as the best match of one of the
 * questions a prompt asks, asked alone. A note that belongs to the
 * session's folder (its path, its `project` or `repo`, or a tag names the
 * folder's repo) is lifted, but never makes a match on its own.
 *
 * The index keeps terms and counts only, never a note's text: the passage
 * a turn gets is read from the file when it is needed (vault.js).
 *
 * @module dsh-plugin-canon/search
 */
import { CODE_TERMS, COMMON, EVERYDAY, RECORDING, asksForWork, counts, decisionSubject, isCodingRequest, isDecision, nameKey, promptTerms, proseOf, terms, wordsOf, workObject } from './text.js';

/** BM25's saturation and length weight. */
const K1 = 1.2;
const B = 0.6;
/** How much a word counts in each of a note's strong fields (the body counts 1). */
const WEIGHTS = Object.freeze({ title: 4, aliases: 3, tags: 3, defined: 3, path: 2, headings: 1.5 });
/** A note scores at least this, and at least this share of the best note, to be added. */
export const MIN_SCORE = 3;
export const NEAR_BEST = 0.6;
/** A word is rare when at most this share of the vault's notes has it (one note, in a small vault). */
export const RARE = 0.06;
/**
 * The share of a coding request's weight that the words a note shares with
 * it must carry: a third when one of them is in the note's title, aliases,
 * tags or headings, 45% when none is (the page's words say these figures).
 */
export const SHARE_TITLED = 1 / 3;
export const SHARE_BODY = 0.45;
/**
 * A coding request fits a note that shares this many distinctive words with
 * it whatever their share, and one more when the note is not of a project
 * the prompt or the session names: pasted output ("…/overlay2/3fd9c1/…: no
 * space left on device") thins the share, not the words in common.
 */
export const MANY_DISTINCT = 4;
/**
 * A coding request says at least this share of a note's title's words (or
 * an alias's) for the note to fit, unless it shares a value of the note's
 * (a port, a tool's command), many distinctive words, or at least
 * COVER_SHARE of its weight with it (most of what it asks is in the note).
 * A decision statement is held to neither.
 */
export const COVER = 0.5;
export const COVER_SHARE = 0.4;
/** The lift for a note of the session's repo, and of the folder it sits in. */
export const REPO_BOOST = 1.6;
export const PARENT_BOOST = 1.2;
/**
 * A word's rarity is judged as if the vault held at least this many notes:
 * in a vault of a handful of notes every word is "common", and nothing
 * could ever reach the floor.
 */
export const SMALL_VAULT = 10;
/** A year ("2026"): a pasted timestamp's, a dated note's file name. */
const YEAR = /^(?:19|20)\d\d$/;
/** Prompt terms used, at most (the rest of a long prompt adds little). */
const MAX_QUERY_TERMS = 48;
/** The questions of a prompt that are each asked alone, at most. */
const MAX_QUESTIONS = 4;
/** A note's distinct terms kept, at most. */
const MAX_NOTE_TERMS = 4000;

/**
 * Folder names that say nothing about a project: a session in
 * ~/Projects/harbor-gateway is about harbor-gateway, not about Projects.
 */
const GENERIC = new Set(['users', 'user', 'home', 'root', 'projects', 'project', 'src', 'source', 'code', 'repos', 'repo', 'repositories', 'git', 'github',
    'work', 'workspace', 'workspaces', 'dev', 'development', 'documents', 'desktop', 'downloads', 'tmp', 'temp', 'private', 'var', 'folders', 'volumes',
    'library', 'mobile-documents', 'icloud', 'opt', 'sites', 'ws', 'main', 'app', 'apps', 'packages', 'lib', 'test', 'tests']);

/**
 * Words that, in a known project's folder, name that project ("Who owns
 * this repo?", "this service's ports", "How is this database backed up?").
 * The first group's word only points at the project; "database", "cluster"
 * and "site" also say what about it, so they stay in the prompt.
 */
const THIS_PROJECT = /\b(?:this|these)\s+(?:(repo|repos|repository|project|service|app|application|codebase)|cluster|database|site)\b/gi;

/**
 * What a session's folder says about which notes belong to it: the repo
 * (the folder's own name) and the folder above it, unless those are
 * generic names (Projects, src, …) or the person's own user name. A folder
 * inside a known project's folder is that project's
 * (~/Projects/lantern-api/internal/auth is lantern-api's).
 * @param {string} folder - a full path.
 * @param {string} [home] - the home folder, whose own name is not a project.
 * @param {(name: string) => boolean} [isProject] - whether a name is a known project's.
 */
export function folderKeys(folder, home = '', isProject = undefined) {
    if (typeof folder !== 'string' || !folder.startsWith('/')) return { repo: '', parent: '' };
    const user = nameKey(String(home).split('/').filter(Boolean).at(-1) ?? '');
    let parts = folder.split('/').filter(Boolean).map(nameKey);
    const useful = (k) => Boolean(k) && k.length >= 2 && !GENERIC.has(k) && k !== user;
    if (isProject && !isProject(parts.at(-1) ?? '')) {
        for (let i = parts.length - 2; i >= 0; i -= 1) {
            if (useful(parts[i]) && isProject(parts[i])) {
                parts = parts.slice(0, i + 1);
                break;
            }
        }
    }
    const repo = parts.at(-1) ?? '';
    const parent = parts.at(-2) ?? '';
    return { repo: useful(repo) ? repo : '', parent: useful(parent) ? parent : '' };
}

/**
 * The projects a note belongs to by name: its `project` or `repo`, and the
 * folder it sits in under a generic folder (Projects/lantern-api/… is
 * lantern-api's).
 * @param {{ path: string, projects?: string[] }} note
 */
export function projectsOf(note) {
    const out = new Set(note.projects ?? []);
    const folders = note.path.split('/').slice(0, -1).map(nameKey);
    for (let i = 1; i < folders.length; i += 1) if (GENERIC.has(folders[i - 1]) && folders[i] && !GENERIC.has(folders[i])) out.add(folders[i]);
    return [...out];
}

/**
 * The questions a prompt asks: its parts between question marks, and
 * between clauses joined by "and" before a question word ("When does X,
 * and why did we choose Y?").
 * @param {string} prompt
 */
export function questionsOf(prompt) {
    return String(prompt ?? '')
        .split(/\?+(?:\s+|$)|[,;]\s*(?:and|or|also|plus)\s+(?=(?:why|what|when|where|which|who|whose|how)\b)/i)
        .map((part) => part.trim())
        .filter(Boolean);
}

/**
 * The sentences of a prompt that ask a question and ask for no work on code
 * ("Add a field to the /v2/projects response. Does that need a v3?" asks
 * "Does that need a v3?").
 * @param {string} prompt
 */
export function asksOf(prompt) {
    return String(prompt ?? '')
        .split(/(?<=[.!?])\s+|\n+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.endsWith('?') && !isCodingRequest(sentence));
}

/** Words written with a capital that name no thing: "I'm", days and months. */
const CAPITALIZED = /^(?:i['’]\w*|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|january|february|march|april|may|june|july|august|september|october|november|december)$/i;

/**
 * The terms of the words a text writes as names: with a capital inside a
 * sentence ("How do I run Kafka locally?"), or in capitals ("CORS").
 * @param {string} text
 */
export function namesOf(text) {
    const out = [];
    for (const sentence of String(text ?? '').split(/(?<=[.!?;:])\s+|\n+/)) {
        const words = sentence.trim().split(/\s+/);
        for (const [i, raw] of words.entries()) {
            const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
            if (word.length < 2 || CAPITALIZED.test(word)) continue;
            if ((i > 0 && /^\p{Lu}/u.test(word)) || (/^[\p{Lu}\p{N}]+$/u.test(word) && /\p{Lu}{2}/u.test(word))) out.push(...terms(word));
        }
    }
    return out;
}

export class Index {
    constructor() {
        /** Slot → note record, or null once removed. */
        this.docs = [];
        /** Note path → slot. */
        this.byPath = new Map();
        /**
         * Term → { slots, strong, marked, body }: parallel arrays, one entry
         * per note that has the term. `strong` counts its title, aliases,
         * tags, path and headings; `marked` the same without the path (the
         * fields that say what a note is about, not where it is).
         */
        this.postings = new Map();
        this.live = 0;
        this.dead = 0;
        this.bodyLength = 0;
        /** Project name → how many notes belong to it (projectsOf). */
        this.projects = new Map();
        /** Project name → its words as terms. */
        this.parts = new Map();
    }

    get size() {
        return this.live;
    }

    has(path) {
        return this.byPath.has(path);
    }

    get(path) {
        const slot = this.byPath.get(path);
        return slot === undefined ? undefined : this.docs[slot] ?? undefined;
    }

    /** Every note in the index (for the page's counts and tests). */
    notes() {
        return this.docs.filter(Boolean);
    }

    /**
     * Add a note (or replace the one at its path).
     * @param {{ path: string, title: string, aliases: string[], tags: string[], projects: string[], headings: string[], body: string }} note
     * @param {{ mtimeMs?: number, size?: number }} [file]
     */
    add(note, file = {}) {
        this.remove(note.path);
        const slot = this.docs.length;
        const segments = note.path.split('/');
        const strong = new Map();
        const marked = new Map();
        const addStrong = (text, weight, marks = true) => {
            for (const [t, n] of counts(text)) {
                strong.set(t, (strong.get(t) ?? 0) + n * weight);
                if (marks) marked.set(t, (marked.get(t) ?? 0) + n * weight);
            }
        };
        addStrong(note.title, WEIGHTS.title);
        for (const alias of note.aliases ?? []) addStrong(alias, WEIGHTS.aliases);
        for (const tag of note.tags ?? []) addStrong(tag.replace(/[/_-]+/g, ' '), WEIGHTS.tags);
        addStrong(segments.join(' ').replace(/\.md$/i, ''), WEIGHTS.path, false);
        for (const heading of note.headings ?? []) addStrong(heading, WEIGHTS.headings);
        for (const term of note.defined ?? []) addStrong(term, WEIGHTS.defined);
        const bodyTerms = terms(note.body ?? '');
        const body = new Map();
        for (const t of bodyTerms) body.set(t, (body.get(t) ?? 0) + 1);
        const all = [...new Set([...strong.keys(), ...body.keys()])].slice(0, MAX_NOTE_TERMS);
        for (const t of all) {
            let p = this.postings.get(t);
            if (!p) {
                p = { slots: [], strong: [], marked: [], body: [] };
                this.postings.set(t, p);
            }
            p.slots.push(slot);
            p.strong.push(strong.get(t) ?? 0);
            p.marked.push(marked.get(t) ?? 0);
            p.body.push(body.get(t) ?? 0);
        }
        const keys = new Set([...segments.map((s, i) => nameKey(i === segments.length - 1 ? s.replace(/\.md$/i, '') : s)), ...(note.projects ?? []), ...(note.tags ?? []).map(nameKey)].filter(Boolean));
        const projects = projectsOf(note);
        for (const name of projects) this.projects.set(name, (this.projects.get(name) ?? 0) + 1);
        this.docs.push({
            slot,
            path: note.path,
            title: note.title,
            // What the note says it is about: its title's terms and each alias's (coverage, in rank()).
            // What the note says it is about, word by word (each word's terms: "JetStream" is one word), from its title and aliases.
            subjects: [note.title, ...(note.aliases ?? [])].map((text) => String(text ?? '').split(/[\s/]+/).map((word) => [...new Set(terms(word).filter((t) => !/^\d+$/.test(t)))]).filter((list) => list.length > 0)).filter((words) => words.length > 0),
            tags: note.tags ?? [],
            keys,
            projects,
            bodyLength: bodyTerms.length,
            mtimeMs: file.mtimeMs ?? 0,
            size: file.size ?? 0,
        });
        this.byPath.set(note.path, slot);
        this.live += 1;
        this.bodyLength += bodyTerms.length;
    }

    /** Remove a note by its path; nothing when it is not here. */
    remove(path) {
        const slot = this.byPath.get(path);
        if (slot === undefined) return false;
        const doc = this.docs[slot];
        this.byPath.delete(path);
        if (doc) {
            this.live -= 1;
            this.bodyLength -= doc.bodyLength;
            for (const name of doc.projects) {
                const n = (this.projects.get(name) ?? 0) - 1;
                if (n > 0) this.projects.set(name, n);
                else this.projects.delete(name);
            }
            this.docs[slot] = null;
            this.dead += 1;
        }
        if (this.dead > 2000 && this.dead > this.live) this.compact();
        return true;
    }

    /** Drop removed notes from the lists, so they stop costing memory and time. */
    compact() {
        const moved = new Map();
        const docs = [];
        for (const doc of this.docs) {
            if (!doc) continue;
            moved.set(doc.slot, docs.length);
            doc.slot = docs.length;
            docs.push(doc);
        }
        for (const [term, p] of this.postings) {
            const next = { slots: [], strong: [], marked: [], body: [] };
            for (let i = 0; i < p.slots.length; i += 1) {
                const to = moved.get(p.slots[i]);
                if (to === undefined) continue;
                next.slots.push(to);
                next.strong.push(p.strong[i]);
                next.marked.push(p.marked[i]);
                next.body.push(p.body[i]);
            }
            if (next.slots.length) this.postings.set(term, next);
            else this.postings.delete(term);
        }
        this.docs = docs;
        this.byPath = new Map(docs.map((d) => [d.path, d.slot]));
        this.dead = 0;
    }

    /** A project name's words, as terms (`lantern-api` → lantern, api). */
    partsOf(name) {
        let parts = this.parts.get(name);
        if (!parts) {
            parts = terms(name.replace(/-/g, ' '));
            if (this.parts.size > 5000) this.parts.clear();
            this.parts.set(name, parts);
        }
        return parts;
    }

    /**
     * The words of every known project's name, as terms: a project's name
     * (`lantern-api`) and each of its words (`lantern`, `api`) say which
     * project, not what about it.
     * @param {string} [repo] - the session folder's project, known or not.
     * @returns {Set<string>}
     */
    projectWords(repo = '') {
        const out = new Set();
        for (const name of repo ? [...this.projects.keys(), repo] : this.projects.keys()) for (const t of this.partsOf(name)) out.add(t);
        return out;
    }

    /**
     * The known projects a prompt names: every word of a name, or one of its
     * words that no project named in full already accounts for ("the lantern
     * API" names lantern-api, not lantern-web; "lantern" alone names both).
     * @param {Set<string>} asked - the prompt's terms.
     */
    namedProjects(asked) {
        const all = [...this.projects.keys()];
        const full = all.filter((name) => this.partsOf(name).length > 0 && this.partsOf(name).every((t) => asked.has(t)));
        const claimed = new Set(full.flatMap((name) => this.partsOf(name)));
        return all.filter((name) => full.includes(name) || this.partsOf(name).some((t) => asked.has(t) && !claimed.has(t)));
    }

    /**
     * The notes that fit a prompt, best first, each with its score, the
     * prompt terms it matched (and the prompt's own words for them), and
     * whether it belongs to the folder; and the few that matched some words
     * but stayed out (`others`, for the page's "why not"), each with `why`:
     * `name` (only a project's name in common), `few` (too few words in
     * common, or too few that say what the note is about; with `unknown`,
     * the names the prompt writes that no note has), `part` (a coding
     * request's words in common carry too little of what it asks), `other`
     * (another project's note), `less` (it fits, but under the floors).
     *
     * The rules. Words about the vault ("the team's shared notes") are left
     * out of the prompt. A project's name counts as one word, however many
     * parts it has; a session in a known project's folder, or in a folder
     * inside it, names that project for its own notes, and "this repo" or
     * "this service" there says its name ("Who owns this repo?").
     * A term a list in a note defines counts as one of its aliases. A word
     * is distinctive in a note when it is in the note's title, aliases, tags
     * or headings, in at most 6% of the notes, or twice in its body.
     *
     * A question (any prompt that is not a coding request) fits a note
     * that shares two words with it, a project's name counting as one, at
     * least one beyond it. One word is enough when it is all the prompt
     * asks beyond everyday request words ("run", "test", "file") and a
     * project's name the note's own, and it is in the note's title, aliases,
     * tags, path or headings, or distinctive in its body; when it is
     * distinctive and only in the note's body, beside a project the prompt
     * or the session names; or when it is in the note's title, aliases, tags
     * or headings, in at most 6% of the notes and the rarest word the prompt
     * shares with the vault, and the prompt has no word the vault lacks and
     * names no other project. An everyday request word is enough alone only
     * when it is all the prompt asks ("How do I run lantern-web?"). A
     * question that names a thing no note has (a word it writes with a
     * capital inside a sentence, or in capitals, other than a day, a month
     * or "I'm") fits only a note of a project it or the session names, or
     * one that shares three words with it ("How do I run Kafka locally?").
     *
     * Words every software project uses for its everyday parts and doings
     * (text.js COMMON: "port", "endpoint", "deploy", "build", "request",
     * "log", "commit"), the names of tools and languages ("postgres",
     * "docker", "npm") and numbers of one or two digits never carry a fit on
     * their own, whatever the vault says about them: a question whose words
     * in common are all of these fits only a note of a project it or the
     * session names.
     *
     * A coding request (text.js isCodingRequest: a sentence starts with a
     * verb such as "write", "add" or "fix"; it speaks of "this function" or
     * "my script"; it asks for a thing to be made, "need a bash loop…"; or
     * it has code-shaped words, a tool's or a library's name, a file name, a
     * flag or an error, whatever its first word: "how do i check if a port
     * is free from a shell script") leaves its everyday request words out of
     * the words in common, though they still weigh in what it asks. So does
     * a statement of a decision or a lesson ("we decided to keep v1 for a
     * year, put that in the notes"), whose words that say it was decided and
     * should be recorded say nothing of what about: it gets only notes on
     * its subject. Each of its words weighs as much as it is rare in the
     * vault (a word no note has weighs most; a project's name weighs once,
     * and a word of a name that every project uses, "api" or "cache", does
     * not name it alone), and a note fits when:
     * - it shares two words with the prompt (a project's name can be one),
     *   or the one word a prompt of one word asks;
     * - when one of those words is in its title, aliases, tags or headings:
     *   enough of them are distinctive, and they carry a third of the
     *   prompt's weight;
     * - when they are only in its body: two or more of them carry 45% of the
     *   prompt's weight (one word in its body never fits, beside a project
     *   the prompt or the session names or not);
     * - one of them is a word beyond the everyday ones, tools' names and
     *   small numbers, unless the note is of a project the prompt or the
     *   session names and one of them is in its title, aliases, tags or
     *   headings ("Change the HTTPS port to 9000" in harbor-gateway's folder:
     *   Gateway ports).
     * It also fits, whatever its share, when what the request's first work
     * verb acts on is in the note's title and the note is a project's the
     * prompt or the session names ("Write a migration for the ledger…":
     * Schema migrations), and when it shares four distinctive words with the
     * prompt, five when it is not a note of a project the prompt or the
     * session names: pasted output thins the share, not the words in common
     * ("…/overlay2/3fd9c1/…: no space left on device. Clean it up": Disk
     * full on a build agent).
     *
     * A note that belongs to a project (its `project` or `repo`, or its
     * folder under Projects/) is left out when the session's folder or the
     * prompt points at other projects and not at its own; a session in the
     * folder of a project the vault does not know (~/src/invoice-pdf) points
     * at that one, so another project's note fits there only when the
     * prompt names its project. A note is kept
     * above a floor and near the best note; a prompt that asks two things
     * also keeps the note that best answers each question asked alone
     * ("When does on-call hand over, and why did we choose NATS?"), by the
     * whole prompt's rules, which in a coding request needs its share of
     * that question only. A coding request that asks a question of its own
     * ("Add a created_by field to the /v2/projects response. Does that need
     * a v3, or can it go into v2?") also keeps the note that best answers
     * that question, asked alone by a question's rules, when the note is of
     * a project the request or the session names and the whole request
     * finds it short only on the share.
     * @param {string} prompt
     * @param {{ folder?: { repo: string, parent: string }, limit?: number }} [options]
     */
    search(asked, { folder = { repo: '', parent: '' }, limit = 10 } = {}) {
        const decision = isDecision(asked);
        const coding = isCodingRequest(asked) || decision;
        // A decision statement is about its subject, not about how to save it ("…with the canon_capture tool").
        const prompt = decision ? decisionSubject(asked) : asked;
        const { query, scored } = this.rank(prompt, folder, coding, decision);
        const best = scored.find((r) => r.fits)?.score ?? 0;
        const leads = new Set();
        const questions = questionsOf(prompt);
        // A coding request's own question ("…Does that need a v3?"), asked alone by a question's rules: its best
        // note, when that note is of a project the request or the session names ("Any idea what's wrong?" is not).
        if (coding) {
            const asked = new Set();
            for (const question of asksOf(prompt).slice(0, MAX_QUESTIONS)) {
                const lead = this.rank(question, folder, false).scored.find((r) => r.fits && r.score >= MIN_SCORE);
                if (lead) asked.add(lead.path);
            }
            for (const r of scored) if (asked.has(r.path) && r.named) leads.add(r.path);
        }
        if (questions.length > 1) {
            for (const question of questions.slice(0, MAX_QUESTIONS)) {
                const lead = this.rank(question, folder, coding, decision).scored.find((r) => r.fits && r.score >= MIN_SCORE);
                if (lead) leads.add(lead.path);
            }
        }
        // A question's best note carries its question, not the whole prompt: it is kept when the whole
        // prompt finds it short only on the share (`question` says so).
        const fits = (r) => r.fits || (r.why === 'part' && leads.has(r.path));
        const keep = (r) => fits(r) && r.score >= MIN_SCORE && (r.score >= best * NEAR_BEST || leads.has(r.path));
        const kept = scored.filter(keep).map(({ why, ...r }) => (r.fits ? r : { ...r, fits: true, question: true }));
        // Each question's best note comes before the rest when not all fit (still in score order).
        const firsts = kept.filter((r) => leads.has(r.path)).slice(0, limit);
        const chosen = new Set([...firsts, ...kept.filter((r) => !leads.has(r.path)).slice(0, limit - firsts.length)].map((r) => r.path));
        const results = kept.filter((r) => chosen.has(r.path));
        const others = [...kept.filter((r) => !chosen.has(r.path)).map((r) => ({ ...r, why: 'less' })), ...scored.filter((r) => !keep(r))].slice(0, 5);
        return { terms: query, results, others, coding };
    }

    /**
     * The projects a note belongs to: its own (projectsOf), or else the one
     * known project its tags name.
     * @param {{ projects: string[], tags: string[] }} doc
     */
    ownersOf(doc) {
        if (doc.projects.length) return doc.projects;
        // One project's tag says whose note it is; a note tagged with several projects is about them all (On-call).
        const tagged = [...new Set((doc.tags ?? []).map(nameKey).filter((tag) => this.projects.has(tag)))];
        return tagged.length === 1 ? tagged : doc.projects;
    }

    /**
     * Whether a prompt says all of what a note is about: every word, two or
     * more, of its title or of one of its aliases, a project's name aside.
     * @param {{ subjects?: string[][][] }} doc
     * @param {Set<string> | Map<string, number>} asked - the prompt's terms.
     * @param {Set<string>} names - the words of projects' names.
     */
    saysAll(doc, asked, names) {
        return (doc.subjects ?? []).some((subject) => {
            const words = subject.filter((word) => !word.every((t) => names.has(t)));
            return words.length >= 2 && words.every((word) => word.some((t) => asked.has(t)));
        });
    }

    /**
     * The share of a note's title's words, or of one of its aliases', that
     * a prompt has, a project's name aside (0 to 1; the best of them).
     * @param {{ subjects?: string[][][] }} doc
     * @param {Set<string> | Map<string, number>} asked - the prompt's terms.
     * @param {Set<string>} names - the words of projects' names.
     */
    coverOf(doc, asked, names) {
        let best = 0;
        for (const subject of doc.subjects ?? []) {
            const words = subject.filter((word) => !word.every((t) => names.has(t)));
            if (words.length === 0) continue;
            const said = words.filter((word) => word.some((t) => asked.has(t))).length / words.length;
            if (said > best) best = said;
        }
        return best;
    }

    /** How many live notes have a term. */
    notesWith(term) {
        const p = this.postings.get(term);
        let df = 0;
        if (p) for (const slot of p.slots) if (this.docs[slot]) df += 1;
        return df;
    }

    /**
     * Every note that shares a word with a prompt, scored, best first, each
     * with whether it fits the prompt and, when it does not, why (search()
     * says the rules); with `coding` (the prompt is a coding request),
     * `named` (the prompt or the session names its project), `titled` (a
     * word in common is in its title, aliases, tags or headings), `topics`
     * (the words in common beyond a project's name), `plain` (those beyond
     * everyday request words too), `body` (all of them only in its body)
     * and `share` (how much of the prompt's weight the words it shares
     * carry, 0 to 1: a coding request's rule).
     * @param {string} prompt
     * @param {{ repo: string, parent: string }} folder
     * @param {boolean} [coding] - the prompt is a coding request (text.js isCodingRequest).
     * @param {boolean} [decision] - the prompt states a decision to record (text.js isDecision).
     */
    rank(prompt, folder, coding = isCodingRequest(prompt), decision = isDecision(prompt)) {
        // A coding request leaves its everyday request words out of the words in common; a question keeps them.
        // A decision statement's words that say it was decided and should be recorded say nothing of what about.
        const recording = decision ? RECORDING : new Set();
        // A coding request only for its code-shaped words ("what does `fatal: refusing to merge…` mean?") asks no work.
        const shaped = coding && recording.size === 0 && !asksForWork(prompt);
        let query = promptTerms(prompt, { max: 400, everyday: !coding }).filter((t) => !recording.has(t)).slice(0, MAX_QUERY_TERMS);
        // In a known project's folder, "this repo" or "this service" says that project's name, in place of its own word.
        const pointed = folder.repo && this.projects.has(folder.repo) ? [...String(prompt).matchAll(THIS_PROJECT)] : [];
        if (pointed.length) {
            const only = new Set(pointed.flatMap((m) => terms(m[1] ?? '')));
            query = [...new Set([...query.filter((t) => !only.has(t)), ...this.partsOf(folder.repo)])];
        }
        if (query.length === 0 || this.live === 0) return { query, scored: [], coding };
        const asked = new Set(query);
        const names = this.projectWords(folder.repo);
        const context = new Set(this.namedProjects(asked));
        if (folder.repo && this.projects.has(folder.repo)) context.add(folder.repo);
        const here = folder.repo && this.projects.has(folder.repo) ? folder.repo : '';
        const topics = query.filter((t) => !names.has(t)).length;
        const need = Math.min(2, topics + (query.some((t) => names.has(t)) ? 1 : 0));
        const n = Math.max(this.live, SMALL_VAULT);
        const idfOf = (df) => Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const rare = Math.max(1, Math.floor(RARE * n));
        const average = Math.max(1, this.bodyLength / this.live);
        // What the prompt asks, by weight: every word it asks about, its everyday request words too, each as
        // rare as it is in the vault; a project's name once, as its rarest word.
        const weight = new Map();
        for (const t of [...query, ...promptTerms(prompt, { max: 400, everyday: true }).filter((w) => !recording.has(w)).slice(0, MAX_QUERY_TERMS)]) {
            if (!weight.has(t)) weight.set(t, idfOf(this.notesWith(t)));
        }
        let nameWeight = 0;
        let total = 0;
        for (const [t, w] of weight) {
            if (names.has(t)) nameWeight = Math.max(nameWeight, w);
            else total += w;
        }
        total += nameWeight;
        // For its own notes, a session in a project's folder says that project's name.
        const hereWeight = here ? Math.max(0, ...this.partsOf(here).map((t) => idfOf(this.notesWith(t)))) : 0;
        // What a coding request works on, beyond everyday words: a thing a note of the project it names, or the
        // session's, is titled for.
        const object = coding && context.size > 0 ? workObject(prompt).filter((t) => !EVERYDAY.has(t) && !names.has(t)) : [];
        // A question's lone title word must be the rarest word it shares with the vault, in a prompt with no
        // word the vault lacks.
        const namesAsked = query.some((t) => names.has(t));
        const unknown = query.some((t) => !names.has(t) && !EVERYDAY.has(t) && this.notesWith(t) === 0);
        const plainAsked = query.filter((t) => !names.has(t) && !EVERYDAY.has(t)).length;
        // A name the prompt writes with a capital inside a sentence, or in capitals, that no note has ("Kafka", "CORS"):
        // the question is about something the vault does not know.
        const alien = [...new Set(namesOf(prompt).filter((t) => !EVERYDAY.has(t) && !names.has(t) && this.notesWith(t) === 0))];
        let rarest = Infinity;
        for (const t of query) {
            if (names.has(t) || EVERYDAY.has(t)) continue;
            const df = this.notesWith(t);
            if (df > 0 && df < rarest) rarest = df;
        }
        const found = new Map();
        for (const t of query) {
            const p = this.postings.get(t);
            if (!p) continue;
            const df = this.notesWith(t);
            if (df === 0) continue;
            const idf = idfOf(df);
            const isName = names.has(t);
            for (let i = 0; i < p.slots.length; i += 1) {
                const doc = this.docs[p.slots[i]];
                if (!doc) continue;
                const norm = 1 - B + B * (doc.bodyLength / average);
                const tf = p.strong[i] + p.body[i] / norm;
                const score = idf * ((tf * (K1 + 1)) / (tf + K1));
                let hit = found.get(doc.slot);
                if (!hit) {
                    hit = { doc, topic: 0, name: 0, matched: [], topics: 0, plain: 0, special: 0, values: 0, lone: '', strong: 0, marked: 0, distinct: 0, covered: 0 };
                    found.set(doc.slot, hit);
                }
                hit.matched.push(t);
                if (isName) {
                    // A project's name counts once: its best-scoring word. In a coding request, a word of a name that
                    // every project uses ("api", "cache", "web") does not name it alone: "the dns cache" is not quartz-cache's.
                    if (!(coding && COMMON.has(t))) hit.name = Math.max(hit.name, score);
                    continue;
                }
                hit.topic += score;
                hit.topics += 1;
                hit.lone = t;
                if (!EVERYDAY.has(t)) hit.plain += 1;
                // Small numbers and years (a pasted log's timestamp, a decision's file name) say nothing on their own.
                const vague = /^\d{1,2}$/.test(t) || YEAR.test(t);
                if (!EVERYDAY.has(t) && !COMMON.has(t) && !CODE_TERMS.has(t) && !vague) hit.special += 1;
                // A value the note holds: a number of two digits or more, a word with digits in it, a tool's command ("deployctl").
                if (!vague && df <= rare && (/\d{2,}/.test(t) || /ctl$/.test(t))) hit.values += 1;
                hit.covered += weight.get(t);
                if (p.strong[i] > 0) hit.strong += 1;
                if (p.marked[i] > 0) hit.marked += 1;
                if (!vague && (p.marked[i] > 0 || df <= rare || p.body[i] >= 2)) hit.distinct += 1;
            }
        }
        const words = wordsOf(prompt);
        // What a coding request says in the person's own words, without pasted code or output.
        const prose = coding ? new Set(promptTerms(proseOf(prompt), { max: 400, everyday: true })) : new Set();
        const scored = [];
        for (const hit of found.values()) {
            const place = folder.repo && hit.doc.keys.has(folder.repo) ? 'repo' : folder.parent && hit.doc.keys.has(folder.parent) ? 'parent' : '';
            const boost = place === 'repo' ? REPO_BOOST : place === 'parent' ? PARENT_BOOST : 1;
            // A note belongs to its projects (projectsOf) and to a known project its tags name ("tags: [runbook, quartz-cache]").
            const own = this.ownersOf(hit.doc);
            // The session's own project counts as named for its notes, as if the prompt said its name.
            const named = hit.name > 0 || (here !== '' && own.includes(here));
            const said = hit.name > 0 ? nameWeight : named ? hereWeight : 0;
            const asks = total + (hit.name === 0 && named && nameWeight === 0 ? hereWeight : 0);
            const share = asks > 0 ? (hit.covered + said) / asks : 0;
            const titled = hit.marked > 0;
            let why = '';
            let strange = null;
            // How much of what the note says it is about (its title, or an alias) the prompt says, a project's name aside.
            const cover = this.coverOf(hit.doc, weight, names);
            if (hit.topics === 0) why = 'name';
            else if (coding) {
                if ((titled ? hit.distinct : hit.topics) + (named ? 1 : 0) < need || (!titled && hit.topics === 1)) why = 'few';
                else if (share < (titled ? SHARE_TITLED : SHARE_BODY)) why = 'part';
                // "Write a migration…" in tide-ledger's folder, or "…for the ledger", works on what its Schema migrations note is about.
                if (why === 'part' && object.length && own.some((name) => context.has(name)) && terms(hit.doc.title).some((t) => object.includes(t))) why = '';
                // A pasted log thins the share, not the words in common: many distinctive ones fit whatever their share.
                if (why === 'part' && hit.distinct >= MANY_DISTINCT + (named ? 0 : 1)) why = '';
                // A request that says in its own words all of what a note is about, two words or more of its title or an
                // alias, fits it whatever else it says ("a script that restarts quartz on every node" is Restarting a
                // quartz-cache node; a pasted `Warn("rate limited")` is not Rate limits).
                if (why === 'part' && named && this.saysAll(hit.doc, prose, names)) why = '';
                // A request that asks no work, only code-shaped, about what two words of a note's say: it fits by those.
                if ((why === 'part' || why === 'few') && shaped && hit.special >= 2) why = '';
                // Words every project uses ("port", "deploy", "build", "request") never carry a fit on their own.
                if (why === '' && hit.special === 0 && !(named && titled)) why = 'few';
                // A coding request fits a note only when it says at least half of what the note is about, its title's
                // or an alias's words ("restarts every node" is Restarting a quartz-cache node; "the account cache"
                // is not On-call's), shares a value or many distinctive words with it (a pasted log), or finds most of
                // what it asks in it. A decision statement need not say the note's title: the note in force comes.
                if (why === '' && recording.size === 0 && cover < COVER && share < COVER_SHARE && hit.values === 0 && hit.distinct < MANY_DISTINCT + (named ? 0 : 1)) why = 'part';
                // Beside a project the request or the session names, a note of no project fits only by what it is
                // about: a word in its title, aliases, tags or headings ("…release on thursdays" is not Office's lunch).
                if (why === '' && context.size > 0 && own.length === 0 && !titled) why = 'few';
            } else {
                const lone = hit.topics === 1;
                const df = lone ? this.notesWith(hit.lone) : 0;
                // One word in the body only: distinctive, beside a project the prompt or the session names.
                const inBody = lone && hit.strong === 0;
                // One word in the title, aliases, tags or headings, rare and the rarest the prompt shares with the vault.
                const alone = lone && titled && df <= rare && df <= rarest && !unknown && (named || !namesAsked);
                // An everyday request word is enough alone only when it is all the prompt asks beside a project's name.
                const plain = hit.plain > 0 || topics === 1;
                // The one word the prompt asks beyond everyday request words (and a project's name it says).
                const only = plainAsked === 1 && hit.plain === 1 && (named || !namesAsked);
                if (inBody ? !((named || only) && hit.distinct > 0 && plain) : hit.topics + (named ? 1 : 0) < need && !(alone && plain) && !only) why = 'few';
                else if (!plain && hit.topics < 2) why = 'few';
                // Words every project uses, tools' names and numbers fit a question on their own only for a note of a project it or the session names.
                else if (hit.special === 0 && !named) why = 'few';
                // A question about a thing no note names fits a note of a project it or the session names, or one that shares three words.
                else if (alien.length > 0 && !named && hit.topics < 3) why = 'few';
                if (why === 'few' && alien.length > 0 && !named && hit.topics >= 2) strange = alien.map((t) => words.get(t) ?? t);
            }
            if (why === '' && context.size > 0 && own.length > 0 && !own.some((name) => context.has(name))) why = 'other';
            // A session in the folder of a project the vault does not know points at that project: another
            // project's note fits only when the prompt names its project.
            if (why === '' && folder.repo && !here && own.length > 0 && hit.name === 0) why = 'other';
            scored.push({
                path: hit.doc.path,
                title: hit.doc.title,
                score: (hit.topic + hit.name) * boost,
                matched: hit.matched,
                words: hit.matched.map((t) => words.get(t) ?? t),
                folder: place,
                fits: why === '',
                why: why || 'less',
                coding,
                named,
                titled,
                topics: hit.topics,
                plain: hit.plain,
                body: hit.strong === 0,
                share,
                ...(strange ? { unknown: strange } : {}),
            });
        }
        scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        return { query, scored, coding };
    }
}
