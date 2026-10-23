/**
 * A snippet, or the start of a request, as plain words: the Markdown marks
 * replies are full of (links, code fences, `code`, **bold**, # headings,
 * > quotes, list marks) taken out, so a result reads as text on the page
 * and in the tool. The index's hit marks (\u0002 and \u0003) stay where
 * they are. The reading view shows a turn as it was written.
 *
 * @module dsh-plugin-recall/plain
 */

/** `text` without its Markdown marks; the hit marks kept. */
export function plainText(text) {
    let t = String(text ?? '');
    if (!t) return t;
    // [words](where) and ![words](where): the words. A link cut at either end of a snippet loses its marks too.
    t = t.replace(/!?\[([^\]\n]{0,400})\]\([^)\n]{0,800}\)/g, '$1');
    t = t.replace(/\]\([^)\s]{0,800}\)/g, '');
    t = t.replace(/!?\[([^\]\n]{0,400})\]\([^)\n]{0,800}$/, '$1');
    // Code fences with their language, and the ticks around `code`.
    t = t.replace(/(?:```|~~~)[\w.+-]*/g, ' ');
    t = t.replace(/`+/g, '');
    // **bold** (single * and _ stay: they are in names and sums).
    t = t.replace(/\*\*/g, '');
    // # headings, > quotes and list marks at the start of a line.
    t = t.replace(/(^|\n)[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?=\S))/g, '$1');
    return t.replace(/[ \t]{2,}/g, ' ');
}
