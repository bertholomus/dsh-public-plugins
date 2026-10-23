/**
 * Thread title utilities: cleaning model output, deriving fallbacks from the
 * user's own words, and guaranteeing uniqueness in the session store.
 *
 * @module dsh-plugin-discord/titles
 */

/** Discord's hard cap on thread names. */
export const TITLE_MAX = 100;

/**
 * Clean one raw model title. Returns '' when the result must be rejected
 * (empty, JSON scaffold, wrapper prefix with no remainder, pure echo).
 * @param {string} raw - model output.
 * @param {string} prompt - the user's own words, used to detect echoes.
 * @returns {string} cleaned title, possibly ''.
 */
export function cleanTitle(raw, prompt = '') {
    if (typeof raw !== 'string') return '';
    let title = raw;

    // Newlines and control noise first: the result must be one line.
    title = title.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');

    // Strip surrounding quotes and code ticks (repeatedly, for nested cases).
    for (let i = 0; i < 3; i++) {
        title = title.trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
    }

    // Strip a leading bracketed metadata prefix such as "[Triggering message id
    // ...]" — BEFORE the JSON rejection, which would otherwise fire on the '['.
    const unbracketed = title.replace(/^\s*\[[^\]]{0,200}\]\s*/, '').trim();
    if (unbracketed.length > 0) title = unbracketed;
    // A leftover bare bracket wrapper with nothing after it is a reject.
    if (/^\[[^\]]*\]$/.test(title.trim())) return '';

    // Strip markdown emphasis/heading markers and trailing punctuation until
    // stable (they can hide each other: "**Fix the bug**.").
    for (let i = 0; i < 3; i++) {
        const before = title;
        title = title.replace(/^(\*\*|__|#{1,6}\s|[-*]\s+)+/, '').replace(/(\*\*|__)+$/, '').trim();
        title = title.replace(/[.!?,;:，。！？、…·\u2014\u2013]+\s*$/u, '').trim();
        if (title === before) break;
    }

    // Reject JSON fragments outright: {"title": ...} or anything starting a JSON object/array.
    if (/^\s*[[{]/.test(title) || /^"?title"?\s*:/i.test(title)) return '';

    // Collapse internal whitespace runs.
    title = title.replace(/\s{2,}/g, ' ').trim();

    // Reject echoes of the prompt: same normalized prefix.
    const normalizedPrompt = String(prompt).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
    const normalizedTitle = title.toLowerCase();
    if (normalizedPrompt.length >= 12 && normalizedTitle.startsWith(normalizedPrompt.slice(0, Math.min(40, normalizedPrompt.length)))) {
        return '';
    }

    if (title.length === 0) return '';
    return capTitle(title);
}

/**
 * Cap a title at 100 characters without cutting mid-word (unless forced).
 * @param {string} title - already-clean title.
 * @param {number} [max] - cap.
 * @returns {string}
 */
export function capTitle(title, max = TITLE_MAX) {
    if (title.length <= max) return title;
    const cut = title.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return (space >= Math.floor(max * 0.5) ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * Derive a fallback title from the user's own words. Never a constant.
 * @param {string} prompt - the user's message text.
 * @param {number} [maxWords] - word budget.
 * @returns {string} non-empty title.
 */
export function deriveFallbackTitle(prompt, maxWords = 8) {
    const words = String(prompt ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[@#*_`~>|]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 0);
    let title = words.slice(0, maxWords).join(' ');
    if (title.trim().length === 0) title = 'conversation';
    return capTitle(cleanTitle(title) || title);
}

/**
 * Make a title unique in the store by appending " #2", " #3", ...
 * @param {string} title - desired title.
 * @param {string} threadId - the thread being named (excluded from collisions).
 * @param {() => Iterable<string>} existingTitles - all stored titles.
 * @returns {string} unique title.
 */
export function uniquifyTitle(title, threadId, existingTitles) {
    const taken = new Set([...existingTitles()].map((t) => t.toLowerCase()));
    if (!taken.has(title.toLowerCase())) return title;
    for (let n = 2; ; n++) {
        const candidate = `${title} #${n}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}
