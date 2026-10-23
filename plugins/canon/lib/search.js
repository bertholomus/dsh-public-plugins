/**
 * Canon's search: an in-memory inverted index over the vault's active
 * notes, scored like BM25F. A word in a note's title, aliases, tags, path
 * or headings counts for more than one in its body; a body's length is
 * evened out; a word few notes have counts for more than a common one.
 *
 * Which notes fit a prompt: words about the vault and about answering from
 * it ("answer from the team's shared notes") are left out of the prompt; a
 * project's name counts as one word, however many parts it has, and a
 * session in a known project's folder names that project for its notes; a
 * note fits when it shares two words with the prompt, at least one beyond
 * a project's name, and a single word beyond the name must be in its
 * title, aliases, tags, path or headings (one word in its body never makes
 * a match); a note that belongs to a project is left out when the
 * session's folder or the prompt points at other projects and not at its
 * own. A note is kept above a floor and near the best match, or as the
 * best match of one of the questions a prompt asks, asked alone. A note
 * that belongs to the session's folder (its path, its `project` or `repo`,
 * or a tag names the folder's repo) is lifted, but never makes a match on
 * its own.
 *
 * The index keeps terms and counts only, never a note's text: the passage
 * a turn gets is read from the file when it is needed (vault.js).
 *
 * @module dsh-plugin-canon/search
 */
import { counts, nameKey, promptTerms, terms, wordsOf } from './text.js';

/** BM25's saturation and length weight. */
const K1 = 1.2;
const B = 0.6;
/** How much a word counts in each of a note's strong fields (the body counts 1). */
const WEIGHTS = Object.freeze({ title: 4, aliases: 3, tags: 3, path: 2, headings: 1.5 });
/** A note scores at least this, and at least this share of the best note, to be added. */
export const MIN_SCORE = 3;
export const NEAR_BEST = 0.5;
/** The lift for a note of the session's repo, and of the folder it sits in. */
export const REPO_BOOST = 1.6;
export const PARENT_BOOST = 1.2;
/**
 * A word's rarity is judged as if the vault held at least this many notes:
 * in a vault of a handful of notes every word is "common", and nothing
 * could ever reach the floor.
 */
export const SMALL_VAULT = 10;
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
 * What a session's folder says about which notes belong to it: the repo
 * (the folder's own name) and the folder above it, unless those are
 * generic names (Projects, src, …) or the person's own user name.
 * @param {string} folder - a full path.
 * @param {string} [home] - the home folder, whose own name is not a project.
 */
export function folderKeys(folder, home = '') {
    if (typeof folder !== 'string' || !folder.startsWith('/')) return { repo: '', parent: '' };
    const user = nameKey(String(home).split('/').filter(Boolean).at(-1) ?? '');
    const parts = folder.split('/').filter(Boolean).map(nameKey);
    const useful = (k) => Boolean(k) && k.length >= 2 && !GENERIC.has(k) && k !== user;
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

export class Index {
    constructor() {
        /** Slot → note record, or null once removed. */
        this.docs = [];
        /** Note path → slot. */
        this.byPath = new Map();
        /** Term → { slots, strong, body }: parallel arrays, one entry per note that has the term. */
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
        const addStrong = (text, weight) => {
            for (const [t, n] of counts(text)) strong.set(t, (strong.get(t) ?? 0) + n * weight);
        };
        addStrong(note.title, WEIGHTS.title);
        for (const alias of note.aliases ?? []) addStrong(alias, WEIGHTS.aliases);
        for (const tag of note.tags ?? []) addStrong(tag.replace(/[/_-]+/g, ' '), WEIGHTS.tags);
        addStrong(segments.join(' ').replace(/\.md$/i, ''), WEIGHTS.path);
        for (const heading of note.headings ?? []) addStrong(heading, WEIGHTS.headings);
        const bodyTerms = terms(note.body ?? '');
        const body = new Map();
        for (const t of bodyTerms) body.set(t, (body.get(t) ?? 0) + 1);
        const all = [...new Set([...strong.keys(), ...body.keys()])].slice(0, MAX_NOTE_TERMS);
        for (const t of all) {
            let p = this.postings.get(t);
            if (!p) {
                p = { slots: [], strong: [], body: [] };
                this.postings.set(t, p);
            }
            p.slots.push(slot);
            p.strong.push(strong.get(t) ?? 0);
            p.body.push(body.get(t) ?? 0);
        }
        const keys = new Set([...segments.map((s, i) => nameKey(i === segments.length - 1 ? s.replace(/\.md$/i, '') : s)), ...(note.projects ?? []), ...(note.tags ?? []).map(nameKey)].filter(Boolean));
        const projects = projectsOf(note);
        for (const name of projects) this.projects.set(name, (this.projects.get(name) ?? 0) + 1);
        this.docs.push({
            slot,
            path: note.path,
            title: note.title,
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
            const next = { slots: [], strong: [], body: [] };
            for (let i = 0; i < p.slots.length; i += 1) {
                const to = moved.get(p.slots[i]);
                if (to === undefined) continue;
                next.slots.push(to);
                next.strong.push(p.strong[i]);
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
     * `name` (only a project's name in common), `few` (one word, or one
     * word in its body), `other` (another project's note), `less` (it fits,
     * but under the floors).
     *
     * The rules: words about the vault ("the team's shared notes") are left
     * out of the prompt. A project's name counts as one word, however many
     * parts it has, and a note needs a word beyond it: two words in common,
     * or one in its title, aliases, tags, path or headings; one word in its
     * body alone never fits. A session in a known project's folder names
     * that project for its own notes ("this service" in quartz-cache's
     * folder). A note that belongs to a project (its `project` or `repo`,
     * or its folder under Projects/) is left out when the session's folder
     * or the prompt points at other projects and not at its own. A note is
     * kept above a floor and near the best note; a prompt that asks two
     * things also keeps the note that best answers each question asked
     * alone ("When does on-call hand over, and why did we choose NATS?").
     * @param {string} prompt
     * @param {{ folder?: { repo: string, parent: string }, limit?: number }} [options]
     */
    search(prompt, { folder = { repo: '', parent: '' }, limit = 10 } = {}) {
        const { query, scored } = this.rank(prompt, folder);
        const best = scored.find((r) => r.fits)?.score ?? 0;
        const leads = new Set();
        const questions = questionsOf(prompt);
        if (questions.length > 1) {
            for (const question of questions.slice(0, MAX_QUESTIONS)) {
                const lead = this.rank(question, folder).scored.find((r) => r.fits && r.score >= MIN_SCORE);
                if (lead) leads.add(lead.path);
            }
        }
        const keep = (r) => r.fits && r.score >= MIN_SCORE && (r.score >= best * NEAR_BEST || leads.has(r.path));
        const kept = scored.filter(keep).map(({ why, ...r }) => r);
        // Each question's best note comes before the rest when not all fit (still in score order).
        const firsts = kept.filter((r) => leads.has(r.path)).slice(0, limit);
        const chosen = new Set([...firsts, ...kept.filter((r) => !leads.has(r.path)).slice(0, limit - firsts.length)].map((r) => r.path));
        const results = kept.filter((r) => chosen.has(r.path));
        const others = [...kept.filter((r) => !chosen.has(r.path)).map((r) => ({ ...r, why: 'less' })), ...scored.filter((r) => !keep(r))].slice(0, 5);
        return { terms: query, results, others };
    }

    /**
     * Every note that shares a word with a prompt, scored, best first, each
     * with whether it fits the prompt and, when it does not, why (search()
     * says the rules).
     * @param {string} prompt
     * @param {{ repo: string, parent: string }} folder
     */
    rank(prompt, folder) {
        const query = promptTerms(prompt, { max: 400 }).slice(0, MAX_QUERY_TERMS);
        if (query.length === 0 || this.live === 0) return { query, scored: [] };
        const asked = new Set(query);
        const names = this.projectWords(folder.repo);
        const context = new Set(this.namedProjects(asked));
        if (folder.repo && this.projects.has(folder.repo)) context.add(folder.repo);
        const here = folder.repo && this.projects.has(folder.repo) ? folder.repo : '';
        const topics = query.filter((t) => !names.has(t)).length;
        const need = Math.min(2, topics + (query.some((t) => names.has(t)) ? 1 : 0));
        const n = Math.max(this.live, SMALL_VAULT);
        const average = Math.max(1, this.bodyLength / this.live);
        const found = new Map();
        for (const t of query) {
            const p = this.postings.get(t);
            if (!p) continue;
            let df = 0;
            for (const slot of p.slots) if (this.docs[slot]) df += 1;
            if (df === 0) continue;
            const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
            const isName = names.has(t);
            for (let i = 0; i < p.slots.length; i += 1) {
                const doc = this.docs[p.slots[i]];
                if (!doc) continue;
                const norm = 1 - B + B * (doc.bodyLength / average);
                const tf = p.strong[i] + p.body[i] / norm;
                const score = idf * ((tf * (K1 + 1)) / (tf + K1));
                let hit = found.get(doc.slot);
                if (!hit) {
                    hit = { doc, topic: 0, name: 0, matched: [], topics: 0, strong: 0 };
                    found.set(doc.slot, hit);
                }
                hit.matched.push(t);
                if (isName) {
                    // A project's name counts once: its best-scoring word.
                    hit.name = Math.max(hit.name, score);
                    continue;
                }
                hit.topic += score;
                hit.topics += 1;
                if (p.strong[i] > 0) hit.strong += 1;
            }
        }
        const words = wordsOf(prompt);
        const scored = [];
        for (const hit of found.values()) {
            const place = folder.repo && hit.doc.keys.has(folder.repo) ? 'repo' : folder.parent && hit.doc.keys.has(folder.parent) ? 'parent' : '';
            const boost = place === 'repo' ? REPO_BOOST : place === 'parent' ? PARENT_BOOST : 1;
            const own = hit.doc.projects;
            // The session's own project counts as named for its notes.
            const shared = hit.topics + (hit.name > 0 || (here !== '' && own.includes(here)) ? 1 : 0);
            let why = '';
            if (hit.topics === 0) why = 'name';
            else if (shared < need || (hit.topics === 1 && hit.strong === 0)) why = 'few';
            else if (context.size > 0 && own.length > 0 && !own.some((name) => context.has(name))) why = 'other';
            scored.push({
                path: hit.doc.path,
                title: hit.doc.title,
                score: (hit.topic + hit.name) * boost,
                matched: hit.matched,
                words: hit.matched.map((t) => words.get(t) ?? t),
                folder: place,
                fits: why === '',
                why: why || 'less',
            });
        }
        scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        return { query, scored };
    }
}
