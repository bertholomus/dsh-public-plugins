/**
 * What a person (or an agent) types, as Recall searches it: words, "exact
 * phrases", -words to leave out and OR between words, turned into an FTS5
 * query that can never be a syntax error; and dates as a span of time.
 *
 * @module dsh-plugin-recall/query
 */

/** The most terms and characters a query keeps. */
export const QUERY_LIMITS = Object.freeze({ terms: 30, term: 100, text: 500 });

/** A term as FTS5 reads it: a quoted string (its quotes doubled), the tokenizer splits it into words. */
const quote = (term) => `"${term.replace(/"/g, '""')}"`;
/** Whether a term has any letter or digit (FTS5 drops everything else). */
const wordy = (term) => /[\p{L}\p{N}]/u.test(term);

/**
 * Split a query into terms.
 * @returns {{ text: string, negated: boolean, phrase: boolean, or: boolean }[]}
 */
function tokens(text) {
    const out = [];
    let i = 0;
    const s = String(text ?? '').slice(0, QUERY_LIMITS.text);
    while (i < s.length) {
        while (i < s.length && /\s/.test(s[i])) i += 1;
        if (i >= s.length) break;
        let negated = false;
        if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
            negated = true;
            i += 1;
        }
        if (s[i] === '"' || s[i] === '“' || s[i] === '”') {
            i += 1;
            let end = i;
            while (end < s.length && s[end] !== '"' && s[end] !== '”' && s[end] !== '“') end += 1;
            out.push({ text: s.slice(i, end).trim(), negated, phrase: true, or: false });
            i = end + 1;
            continue;
        }
        let end = i;
        while (end < s.length && !/\s/.test(s[end])) end += 1;
        const word = s.slice(i, end);
        i = end;
        if (!negated && word === 'OR') {
            out.push({ text: 'OR', negated: false, phrase: false, or: true });
            continue;
        }
        out.push({ text: word, negated, phrase: false, or: false });
    }
    return out;
}

/**
 * A query as FTS5 runs it.
 * @param {string} text
 * @param {{ prefix?: boolean }} [options] - prefix: the last word may be cut short (the person is still typing it).
 * @returns {{ match: string, own: string, titled: string, parts: string[], words: string[], excluded: string[] }}
 *   `match` is '' when nothing searchable is left. `own` matches the rows `match` does whose own text (request,
 *   reply, tools: not the title of their file, which every row of it holds) says the whole query, every word
 *   of it; `titled` the rest of them: rows that match only with their file's title. `parts`: with two or more
 *   groups of words (words joined by OR are one group), each group in the row's own text.
 */
export function parseQuery(text, { prefix = false } = {}) {
    const raw = String(text ?? '');
    const all = tokens(raw).filter((t) => t.or || (t.text && wordy(t.text))).slice(0, QUERY_LIMITS.terms);
    const groups = [];
    const excluded = [];
    const words = [];
    let joinNext = false;
    for (const t of all) {
        if (t.or) {
            joinNext = groups.length > 0;
            continue;
        }
        const term = t.text.slice(0, QUERY_LIMITS.term);
        if (t.negated) {
            excluded.push(term);
            joinNext = false;
            continue;
        }
        words.push(term);
        const piece = { term, phrase: t.phrase };
        if (joinNext) groups[groups.length - 1].push(piece);
        else groups.push([piece]);
        joinNext = false;
    }
    if (groups.length === 0) return { match: '', own: '', titled: '', parts: [], words, excluded };
    // Still typing: the last word matches as a prefix ("deplo" finds "deploy").
    const typing = prefix && !/\s$/.test(raw);
    const last = groups.at(-1).at(-1);
    const render = (piece) => (typing && piece === last && !piece.phrase && piece.term.replace(/[^\p{L}\p{N}]/gu, '').length >= 2 && /[\p{L}\p{N}]$/u.test(piece.term)
        ? `${quote(piece.term)}*` : quote(piece.term));
    // FTS5 joins two phrases with a space, but a group in brackets only with an explicit AND.
    const positive = groups.map((g) => (g.length === 1 ? render(g[0]) : `(${g.map(render).join(' OR ')})`)).join(' AND ');
    const not = excluded.map((e) => ` NOT ${quote(e)}`).join('');
    const match = excluded.length ? `(${positive})${not}` : positive;
    // A turn whose own text says the whole query: a column filter puts every word of it in the request, the
    // reply or the tools (each word in any of them), never in the title its file gives every row. A word left
    // out stays out of the title too. The index alone answers, without scoring a row.
    const said = `{prompt reply tools} : (${positive})`;
    const own = excluded.length ? `(${said})${not}` : said;
    // The rows that match only with their file's title: some or all of the words are in the title alone.
    const titled = `(${match}) NOT (${said})`;
    // With two or more groups of words, each group's own-text match: how many of them a titled row says itself.
    const parts = groups.length > 1 ? groups.map((g) => `{prompt reply tools} : (${g.length === 1 ? render(g[0]) : `(${g.map(render).join(' OR ')})`})`) : [];
    return { match, own, titled, parts, words, excluded };
}

const DAY = 86_400_000;

/** Midnight of a local day, from "2026-10-01". */
function localDay(text) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (!m) return undefined;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 ? d.getTime() : undefined;
}

/** The spans the page offers, by name. */
export const SPANS = Object.freeze({ day: 'Past day', week: 'Past week', month: 'Past month', year: 'Past year' });

/**
 * A moment from words: a span back from now (day, week, month, year, 7d,
 * 12h), today, yesterday, a date (2026-10-01, local midnight) or a full
 * ISO time. Throws in words when it cannot be read.
 * @param {string} text
 * @param {{ now?: number, end?: boolean }} [options] - end: a date means the end of that day.
 */
export function momentOf(text, { now = Date.now(), end = false } = {}) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t) return undefined;
    const spans = { day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };
    if (spans[t]) return now - spans[t];
    const back = /^(\d{1,4})\s*(h|d|w|m|y)$/.exec(t);
    if (back) return now - Number(back[1]) * { h: 3_600_000, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }[back[2]];
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    if (t === 'today') return end ? now : midnight.getTime();
    if (t === 'yesterday') return midnight.getTime() - (end ? 0 : DAY);
    const day = localDay(t);
    if (day !== undefined) return end ? day + DAY : day;
    const iso = Date.parse(text);
    if (Number.isFinite(iso) && /^\d{4}-\d{2}-\d{2}T/.test(String(text).trim())) return iso;
    throw new Error(`"${String(text).slice(0, 40)}" is not a time Recall can read: write a date such as 2026-10-01, or today, yesterday, 7d, week, month or year`);
}

/** The time span of a search, `{ from, to }` in ms (either may be undefined). */
export function spanOf({ since, until, now = Date.now() } = {}) {
    const from = since ? momentOf(since, { now }) : undefined;
    const to = until ? momentOf(until, { now, end: true }) : undefined;
    if (from !== undefined && to !== undefined && to <= from) throw new Error('The end of the time span is before its start.');
    return { from, to };
}
