/**
 * Words for Canon's search: one way to cut text into terms, used for the
 * notes and for the prompts, so a note's "Deploying" meets a prompt's
 * "deploys". Light stemming, and stop words that include the filler of a
 * chat ("thanks", "looks good", "please carry on"), so a prompt that asks
 * nothing finds nothing.
 *
 * @module dsh-plugin-canon/text
 */

/**
 * Words that say nothing about what a note or a prompt is about ("called"
 * and "named" only name a thing: "what is the mascot called?").
 */
export const STOP = new Set(`
a about above after again against all almost also am an and another any anyone anything anyway are aren around as at
away back be because been before being below between both but by can cannot could couldn did didn do does doesn doing
don done down during each either else enough etc even ever every few for from further get gets getting give given go
goes going gone got had has hasn have haven having he her here hers herself him himself his how however i if in into is
isn it its itself just keep kind know last least let lets like likely made make makes many may maybe me might mine more
most much must my myself need needs neither never new next no nor not now of off often oh ok okay on once one only onto
or other others our ours ourselves out over per perhaps please pretty quite rather re really right said same say
says see seem seems shall she should shouldn show since so some something sometimes soon still such sure take tell than
thank thanks thats the their theirs them themselves then there these they thing things think this those though through
thus to too try trying two under until up upon us use used uses using very via want wants was wasn way we well were
weren what whatever when where whether which while who whom whose why will with within without won would wouldn yeah
yes yet you your yours yourself yourselves
hi hello hey thx ty cool nice great good fine awesome perfect looks look looking sounds sound ahead carry continue
proceed lgtm sorry wait hmm hm ah ugh anyway also again stuff bit lot lots really actually basically just
called named that although unless already always usually none nothing everything someone everyone somebody anybody
everybody less
`.split(/\s+/).filter(Boolean));

/**
 * A word's stem: plural and verb endings off, and a last "e" off longer
 * words, so forms of one word meet ("rotate", "rotated", "rotating" →
 * "rotat"; "stores", "stored" → "stor"). Numbers stay as they are.
 */
export function stem(word) {
    let w = word;
    if (w.length <= 3 || /\d/.test(w)) return w;
    if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
    else if (/(?:ss|sh|ch|x|z)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
    else if (w.endsWith('s') && !/(?:ss|us|is|ous)$/.test(w)) w = w.slice(0, -1);
    if (w.endsWith('ing') && w.length - 3 >= 4) w = undouble(w.slice(0, -3));
    else if (w.endsWith('ed') && w.length - 2 >= 4) w = undouble(w.slice(0, -2));
    else if (w.endsWith('ly') && w.length > 5) w = w.slice(0, -2);
    if (w.endsWith('e') && w.length >= 5) w = w.slice(0, -1);
    return w;
}

/** "runn" → "run", "stopp" → "stop"; "fall" and "pass" keep theirs. */
function undouble(w) {
    return /([b-df-hj-np-tv-z])\1$/.test(w) && !/(?:ll|ss|zz|ff)$/.test(w) ? w.slice(0, -1) : w;
}

const SPLIT = /[^\p{L}\p{N}]+/u;
const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/**
 * The terms of a text, in order, repeats kept: lower case, stemmed, stop
 * words and one-letter words dropped; a camelCase word also gives its parts.
 * @param {string} text
 * @param {{ max?: number }} [options] - stop after this many terms.
 */
export function terms(text, { max = Infinity } = {}) {
    const out = [];
    if (typeof text !== 'string' || text === '') return out;
    for (const raw of text.split(SPLIT)) {
        if (raw === '') continue;
        const parts = raw.length > 3 && CAMEL.test(raw) ? [raw, ...raw.split(CAMEL)] : [raw];
        for (const part of parts) {
            const lower = part.toLowerCase();
            if (lower.length < 2 || lower.length > 40 || STOP.has(lower)) continue;
            if (/^\d+$/.test(lower) && lower.length < 2) continue;
            const s = stem(lower);
            if (s.length < 2 || STOP.has(s)) continue;
            out.push(s);
            if (out.length >= max) return out;
        }
    }
    return out;
}

/** The distinct terms of a text, in first-seen order. */
export function distinctTerms(text, options) {
    return [...new Set(terms(text, options))];
}

/**
 * Words about the vault itself and about answering from it ("answer from
 * the team's shared notes and cite the note", "is it in the canon vault?"),
 * as terms: they say where to look and how to answer, not what about, so a
 * prompt's are left out (a note may still use them).
 */
export const ABOUT_THE_VAULT = new Set(['note', 'vault', 'canon', 'shar', 'team', 'answer', 'cite', 'cited', 'citation', 'reply', 'repli']);

/**
 * The words of a text as a person wrote them, by their term: the first
 * word that gave each term, in lower case ("rotating" for "rotat"), so the
 * page shows words, never stems.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function wordsOf(text) {
    const out = new Map();
    if (typeof text !== 'string' || text === '') return out;
    for (const raw of text.split(SPLIT)) {
        if (raw === '') continue;
        const parts = raw.length > 3 && CAMEL.test(raw) ? [raw, ...raw.split(CAMEL)] : [raw];
        for (const part of parts) {
            const lower = part.toLowerCase();
            if (lower.length < 2 || lower.length > 40 || STOP.has(lower)) continue;
            const s = stem(lower);
            if (s.length < 2 || STOP.has(s) || out.has(s)) continue;
            out.set(s, lower);
        }
    }
    return out;
}

/** A prompt's distinct terms, without its words about the vault. */
export function promptTerms(text, options) {
    return distinctTerms(text, options).filter((t) => !ABOUT_THE_VAULT.has(t));
}

/** How often each term comes in a text. */
export function counts(text) {
    const out = new Map();
    for (const t of terms(text)) out.set(t, (out.get(t) ?? 0) + 1);
    return out;
}

/** A name as folders and projects are compared: lower case, runs of other characters as one "-". */
export const nameKey = (text) => String(text ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
