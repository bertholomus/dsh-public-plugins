/**
 * Markdown handoff notes (HANDOFF.md, notes folders), read into sections:
 * one row per heading with its text, so a hit lands on the section and
 * line it is in. A note without headings is one section; a long section
 * is cut into parts at paragraph breaks.
 *
 * Headings inside fenced code blocks are text. YAML front matter is left
 * out of the text; its `title` names the note.
 *
 * @module dsh-plugin-recall/handoffs
 */
import { titleLine } from './turns.js';

/** The most of a note Recall reads, and how it cuts it. */
export const NOTE_LIMITS = Object.freeze({ fileBytes: 4 << 20, part: 8000, sections: 400 });

/** Whether a file name is a Markdown note. */
export const isNote = (name) => /\.(?:md|markdown|mdown|mkd)$/i.test(name);

/** Cut a section's text into parts of at most `max` characters, at paragraph breaks where it can. */
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
    return out;
}

/**
 * A note's sections.
 * @param {string} text - the file's text.
 * @param {{ name?: string, mtime?: number }} [file]
 * @returns {{ title: string, rows: object[] }} rows as the index stores them (`turn` is the section's number).
 */
export function readNote(text, { name = '', mtime = 0 } = {}) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
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
    let current = { label: '', line: start + 1, body: [] };
    let fence = '';
    for (let i = start; i < lines.length; i += 1) {
        const line = lines[i];
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
            current = { label, line: i + 1, body: [] };
            continue;
        }
        current.body.push(line);
    }
    sections.push(current);
    const rows = [];
    for (const section of sections) {
        const body = section.body.join('\n').trim();
        if (!body && !section.label) continue;
        const pieces = body ? parts(body, NOTE_LIMITS.part) : [''];
        pieces.forEach((piece, n) => {
            if (rows.length >= NOTE_LIMITS.sections) return;
            rows.push({
                turn: rows.length + 1,
                seq: 0,
                time: mtime,
                end: mtime,
                line: section.line,
                status: 'done',
                model: '',
                provider: '',
                label: n === 0 ? section.label : `${section.label || 'Text'} (continued)`,
                prompt: section.label,
                reply: piece,
                tools: '',
            });
        });
    }
    return { title: title || titleLine(name.replace(/\.(?:md|markdown|mdown|mkd)$/i, '')), rows };
}
