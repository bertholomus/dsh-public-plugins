/**
 * Markdown handoff notes (HANDOFF.md, notes folders), read into sections:
 * one row per heading with its text, so a hit lands on the section and
 * line it is in. A note without headings is one section; a long section
 * is cut into parts at paragraph breaks.
 *
 * Headings inside fenced code blocks are text. YAML front matter is left
 * out of the text; its `title` names the note.
 *
 * How much of a note is read (`NOTE_LIMITS`), and what is said when not all
 * of it is: a note up to 4 MB is read whole. Past that, its first 1 MB and
 * its last 3 MB are, so a log that grows at the bottom keeps its newest
 * entries searchable. A note of more than 50,000 rows keeps its first 5,000
 * and its last 45,000, for the same reason. Either way the note is listed
 * as read in part, with what was left out (`cutWords`).
 *
 * @module dsh-plugin-recall/handoffs
 */
import { titleLine } from './turns.js';

/**
 * The most of a note Recall reads, and how it cuts it: `fileBytes` read whole, else the first `headBytes` and the
 * last `fileBytes - headBytes`; a section's text in parts of at most `part` characters (and a code block's fences
 * where a cut falls inside one), one row each; at most `rows` rows, else the first `headRows` and the last
 * `rows - headRows`.
 */
export const NOTE_LIMITS = Object.freeze({ fileBytes: 4 << 20, headBytes: 1 << 20, part: 8000, rows: 50000, headRows: 5000 });

/** Whether a file name is a Markdown note. */
export const isNote = (name) => /\.(?:md|markdown|mdown|mkd)$/i.test(name);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** The fence of the code block a text ends inside, given the one it starts inside ('' for none). */
function fenceAfter(text, open = '') {
    let fence = open;
    for (const line of text.split('\n')) {
        const m = FENCE.exec(line);
        if (!m) continue;
        if (!fence) fence = m[1];
        else if (m[1][0] === fence[0] && m[1].length >= fence.length && line.slice(m[0].length).trim() === '') fence = '';
    }
    return fence;
}

/**
 * Cut a section's text into parts of about `max` characters, at paragraph breaks where it can. A code block a cut
 * falls inside is closed at the end of its part and opened again at the start of the next, so each part reads (and
 * draws) as code where it is code.
 */
function parts(text, max) {
    if (text.length <= max) return [text];
    const out = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n\n', max);
        if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
        if (cut < max * 0.5) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    let open = '';
    return out.map((piece) => {
        const from = open;
        open = fenceAfter(piece, from);
        return `${from ? `${from}\n` : ''}${piece}${open ? `\n${open}` : ''}`;
    });
}

const linesOf = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const count = (n) => Number(n).toLocaleString('en-US');
const megabytes = (bytes) => {
    const mb = bytes / 1048576;
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
};

/**
 * What a note read in part leaves out, in words for the page and the tool ("Only its first 1 MB and its last 3 MB
 * are searched (it is 4.7 MB)."), or '' when all of it is searched. Every such sentence starts "Only its first",
 * which is how the index tells a note read in part from one it could not read.
 * @param {{ bytes?: number, rows?: number }} cut - the file's size when only its ends were read; the rows it had
 *   when only the first and last were kept.
 */
export function cutWords({ bytes, rows } = {}) {
    const tail = NOTE_LIMITS.rows - NOTE_LIMITS.headRows;
    if (bytes > 0) {
        const ends = `Only its first ${megabytes(NOTE_LIMITS.headBytes)} and its last ${megabytes(NOTE_LIMITS.fileBytes - NOTE_LIMITS.headBytes)} are searched (it is ${megabytes(bytes)})`;
        return rows > 0 ? `${ends}; of their ${count(rows)} sections, the first ${count(NOTE_LIMITS.headRows)} and the last ${count(tail)}.` : `${ends}.`;
    }
    if (rows > 0) return `Only its first ${count(NOTE_LIMITS.headRows)} and its last ${count(tail)} sections are searched (it has ${count(rows)}).`;
    return '';
}

/**
 * A note's sections.
 * @param {string} text - the file's text (its first part, when `tail` is given).
 * @param {{ name?: string, mtime?: number, tail?: { text: string, line: number } }} [file] - `tail`: the file's
 *   last part, when its middle was not read, and the line it starts on (0 when not counted).
 * @returns {{ title: string, rows: object[], cut?: { rows: number } }} rows as the index stores them (`turn` is
 *   the row's place in the note: its section, or a part of one); `cut` when only its first and last rows are kept.
 */
export function readNote(text, { name = '', mtime = 0, tail } = {}) {
    const lines = linesOf(text);
    let title = '';
    let start = 0;
    // Front matter: its title names the note; the rest is left out.
    if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(l));
        if (end > 0) {
            for (const l of lines.slice(1, end)) {
                const m = /^title:\s*["']?(.+?)["']?\s*$/.exec(l);
                if (m) title = titleLine(m[1]);
            }
            start = end + 1;
        }
    }
    const sections = [];
    /** Read lines into sections; `lineOf(i)` is line i's number in the file (0: not known); `lead`: what the text before the first heading is called. */
    const scan = (rows, from, lineOf, lead) => {
        let current = { label: '', shown: lead, line: lineOf(from), body: [] };
        let fence = '';
        for (let i = from; i < rows.length; i += 1) {
            const line = rows[i];
            const opens = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
            if (opens) {
                if (!fence) fence = opens[1][0];
                else if (opens[1][0] === fence) fence = '';
                current.body.push(line);
                continue;
            }
            const heading = fence ? undefined : /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
            if (heading) {
                sections.push(current);
                const label = titleLine(heading[2].replace(/[*_`]/g, ''));
                if (!title && heading[1].length === 1) title = label;
                current = { label, line: lineOf(i), body: [] };
                continue;
            }
            current.body.push(line);
        }
        sections.push(current);
    };
    scan(lines, start, (i) => i + 1, undefined);
    // The last part of a note whose middle was not read: its text before its first heading is the end of a section
    // of the middle, so it is called "Further on".
    if (tail) scan(linesOf(tail.text), 0, (i) => (tail.line > 0 ? tail.line + i : 0), 'Further on');
    const all = [];
    for (const section of sections) {
        const body = section.body.join('\n').trim();
        if (!body && !section.label) continue;
        const label = section.shown ?? section.label;
        const pieces = body ? parts(body, NOTE_LIMITS.part) : [''];
        pieces.forEach((piece, n) => {
            all.push({
                turn: all.length + 1,
                seq: 0,
                time: mtime,
                end: mtime,
                line: section.line,
                status: 'done',
                model: '',
                provider: '',
                label: n === 0 ? label : `${label || 'Text'} (continued)`,
                prompt: section.label,
                reply: piece,
                tools: '',
            });
        });
    }
    const out = { title: title || titleLine(name.replace(/\.(?:md|markdown|mdown|mkd)$/i, '')), rows: all };
    if (all.length > NOTE_LIMITS.rows) {
        // Its first rows (what the note is) and its last (where a log's newest entries are); each keeps its place.
        out.rows = [...all.slice(0, NOTE_LIMITS.headRows), ...all.slice(all.length - (NOTE_LIMITS.rows - NOTE_LIMITS.headRows))];
        out.cut = { rows: all.length };
    }
    return out;
}
