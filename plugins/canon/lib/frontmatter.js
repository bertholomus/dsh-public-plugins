/**
 * Obsidian notes as Canon reads them: the YAML frontmatter at the top (the
 * subset notes use: scalars, quoted strings, lists, one level of nested
 * keys, block text), the title, tags, aliases, headings and the body; and
 * the few changes Canon ever writes (a draft's frontmatter, and a promoted
 * draft's status), made line by line so the rest of a note stays as it was
 * written.
 *
 * Nothing here throws: a note Canon cannot make sense of reads as a note
 * with no frontmatter.
 *
 * @module dsh-plugin-canon/frontmatter
 */
import { nameKey } from './text.js';

/** At most this much of a note's top is read as its frontmatter. */
const MAX_FRONTMATTER = 64 * 1024;
const KEY_LINE = /^([A-Za-z0-9_][\w .-]{0,60}?)\s*:(?:\s+(.*)|\s*)$/;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A plain YAML scalar: true/false, a number, null, or the text (quotes and a trailing comment off). */
function scalar(raw) {
    const text = String(raw ?? '').trim();
    if (text === '') return '';
    const q = text[0];
    if ((q === '"' || q === '\'') && text.length >= 2) {
        const end = text.lastIndexOf(q);
        if (end > 0) {
            const inner = text.slice(1, end);
            if (q === '\'') return inner.replace(/''/g, '\'');
            try { return JSON.parse(`"${inner.replace(/\\'/g, '\'')}"`); } catch { return inner; }
        }
    }
    const plain = text.replace(/\s+#.*$/, '').trim();
    if (/^(?:true|yes|on)$/i.test(plain)) return true;
    if (/^(?:false|no|off)$/i.test(plain)) return false;
    if (/^(?:null|~)$/i.test(plain)) return null;
    if (/^-?\d+(?:\.\d+)?$/.test(plain) && plain.length < 16) return Number(plain);
    return plain;
}

/** A YAML flow list, `[a, "b, c", d]`, as its items. */
function flowList(text) {
    const inner = text.trim().slice(1, -1);
    const out = [];
    let cur = '';
    let quote = '';
    for (const ch of inner) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = '';
        } else if (ch === '"' || ch === '\'') {
            quote = ch;
            cur += ch;
        } else if (ch === ',') {
            if (cur.trim() !== '') out.push(scalar(cur));
            cur = '';
        } else cur += ch;
    }
    if (cur.trim() !== '') out.push(scalar(cur));
    return out;
}

/** A value on a key's own line: a flow list, or a scalar. */
function inlineValue(text) {
    const t = String(text ?? '').trim();
    if (t.startsWith('[') && t.endsWith(']')) return flowList(t);
    return scalar(t);
}

/**
 * The frontmatter's lines as data: `key: value`, a key followed by `- item`
 * lines (a list), by indented `sub: value` lines (one nested level), or by
 * `|` / `>` and indented text.
 */
function parseYaml(lines) {
    const data = {};
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '' || /^\s*#/.test(line) || /^\s/.test(line)) {
            i += 1;
            continue;
        }
        const m = KEY_LINE.exec(line);
        if (!m) {
            i += 1;
            continue;
        }
        const key = m[1].trim();
        const rest = (m[2] ?? '').trim();
        i += 1;
        // The lines that belong to this key: indented, or list items.
        const block = [];
        while (i < lines.length && (/^\s+\S/.test(lines[i]) || /^-\s|^-$/.test(lines[i]) || lines[i].trim() === '')) {
            block.push(lines[i]);
            i += 1;
        }
        while (block.length && block.at(-1).trim() === '') block.pop();
        if (/^[|>][+-]?$/.test(rest)) {
            const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length), 80);
            const text = block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
            data[key] = rest.startsWith('>') ? text.join(' ').replace(/\s+/g, ' ').trim() : text.join('\n').trim();
        } else if (rest !== '') {
            data[key] = inlineValue(rest);
        } else if (block.some((l) => /^\s*-(\s|$)/.test(l))) {
            data[key] = block.filter((l) => /^\s*-(\s|$)/.test(l)).map((l) => inlineValue(l.replace(/^\s*-\s?/, ''))).filter((v) => v !== '' && v !== null);
        } else if (block.length) {
            const nested = {};
            for (const l of block) {
                const n = KEY_LINE.exec(l.trim());
                if (n) nested[n[1].trim()] = inlineValue(n[2] ?? '');
            }
            data[key] = nested;
        } else {
            data[key] = '';
        }
    }
    return data;
}

/**
 * A note's frontmatter and body.
 * @param {string} text - the whole note.
 * @returns {{ data: Record<string, unknown>, body: string, frontmatter: boolean, bodyStart: number }}
 */
export function parseNote(text) {
    const source = typeof text === 'string' ? text.replace(/^﻿/, '') : '';
    const none = { data: {}, body: source, frontmatter: false, bodyStart: 0 };
    try {
        if (!/^---[ \t]*\r?\n/.test(source)) return none;
        const head = source.slice(0, MAX_FRONTMATTER);
        const close = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(head.slice(3));
        if (!close) return none;
        const yamlEnd = 3 + close.index;
        const bodyStart = yamlEnd + close[0].length;
        const lines = head.slice(head.indexOf('\n') + 1, yamlEnd).split(/\r?\n/);
        return { data: parseYaml(lines), body: source.slice(bodyStart), frontmatter: true, bodyStart };
    } catch {
        return none;
    }
}

/** A key's value, whatever its case in the note (Status:, status:). */
export function field(data, ...names) {
    if (!isRecord(data)) return undefined;
    for (const name of names) {
        if (Object.hasOwn(data, name)) return data[name];
        const found = Object.keys(data).find((k) => k.toLowerCase() === name.toLowerCase());
        if (found !== undefined) return data[found];
    }
    return undefined;
}

/** A value as a list of short strings: a list, or one string split at commas. */
export function listOf(value, { split = true } = {}) {
    const items = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
    const out = [];
    for (const item of items) {
        if (typeof item !== 'string' && typeof item !== 'number') continue;
        const parts = split && typeof item === 'string' ? item.split(',') : [String(item)];
        for (const part of parts) {
            const t = part.trim().replace(/^#/, '').trim();
            if (t) out.push(t.slice(0, 120));
        }
    }
    return out.slice(0, 50);
}

/** A note's status as written ('' when it has none), in lower case. */
export function statusOf(data) {
    const value = field(data, 'status');
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first.trim().toLowerCase() : first === undefined || first === null ? '' : String(first).toLowerCase();
}

/** Whether a note may be added to turns: `status: active`, or no status at all. A draft, or any other status, never. */
export const isActive = (data) => {
    const status = statusOf(data);
    return status === '' || status === 'active';
};

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
/** A term a list defines, in bold before a colon or a dash ("- **Standby**: the copy of a database…"). */
const DEFINED = /^\s*(?:[-*+]|\d+[.)])\s+\*\*([^*\n]{1,80}?)\*\*\s*(?::|—|–|\s-\s)/;
const INLINE_TAG = /(?:^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const FENCE = /^\s*(```|~~~)/;

/** The body's headings, the terms its lists define and its inline #tags, outside code. */
export function bodyMarks(body) {
    const headings = [];
    const tags = [];
    const defined = [];
    let fenced = false;
    for (const line of String(body ?? '').split('\n')) {
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) continue;
        const h = HEADING.exec(line);
        if (h) {
            headings.push({ level: h[1].length, text: h[2].trim() });
            continue;
        }
        const d = DEFINED.exec(line);
        if (d) defined.push(d[1].trim());
        if (line.includes('#')) for (const m of line.replace(/`[^`]*`/g, '').matchAll(INLINE_TAG)) tags.push(m[1]);
    }
    return { headings, tags, defined };
}

/**
 * What Canon keeps of a note: title, tags, aliases, project names, headings,
 * the terms its lists define, status, and the body for its terms.
 * @param {string} path - the note's path in the vault (`a/b/Note.md`).
 * @param {string} text - the note.
 */
export function noteOf(path, text) {
    const { data, body } = parseNote(text);
    const { headings, tags: inline, defined } = bodyMarks(body);
    const file = String(path).split('/').at(-1).replace(/\.md$/i, '');
    const titled = field(data, 'title');
    const h1 = headings.find((h) => h.level === 1)?.text;
    const title = (typeof titled === 'string' && titled.trim() ? titled.trim() : h1 || file).slice(0, 200);
    const tags = [...new Set([...listOf(field(data, 'tags', 'tag')), ...inline].map((t) => t.toLowerCase()))].slice(0, 50);
    const aliases = listOf(field(data, 'aliases', 'alias'), { split: false });
    const projects = [...listOf(field(data, 'project', 'projects')), ...listOf(field(data, 'repo', 'repos'))].map(nameKey).filter(Boolean);
    return { path, title, tags, aliases, projects, headings: headings.map((h) => h.text), defined: defined.slice(0, 50), status: statusOf(data), active: isActive(data), data, body };
}

// ── Writing ─────────────────────────────────────────────────────────

/** A string as a YAML scalar: plain when that is safe, else in double quotes (JSON's escapes are YAML's). */
export function yamlText(value) {
    const text = String(value ?? '');
    return /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(text) && !/^(?:true|false|yes|no|on|off|null)$/i.test(text) && !/\s$/.test(text) && !/^\d/.test(text)
        ? text : JSON.stringify(text);
}

/**
 * Frontmatter lines for `fields`, in order: strings, numbers, booleans,
 * lists of strings (flow style) and one nested level of those.
 */
export function yamlLines(fields) {
    const out = [];
    const one = (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : yamlText(v));
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) out.push(`${key}: [${value.map(one).join(', ')}]`);
        else if (isRecord(value)) {
            out.push(`${key}:`);
            for (const [sub, v] of Object.entries(value)) if (v !== undefined) out.push(`  ${sub}: ${one(v)}`);
        } else out.push(`${key}: ${one(value)}`);
    }
    return out;
}

/**
 * The note with some top-level frontmatter keys set to new values (or added
 * at its end), every other line as it was. A note with no frontmatter gets
 * one. Values are scalars (strings, numbers, booleans).
 * @param {string} text
 * @param {Record<string, string | number | boolean>} fields
 */
export function setFields(text, fields) {
    const source = String(text ?? '');
    const bom = source.startsWith('﻿') ? '﻿' : '';
    const plain = source.slice(bom.length);
    const { frontmatter } = parseNote(plain);
    const newline = plain.includes('\r\n') ? '\r\n' : '\n';
    if (!frontmatter) return `${bom}---${newline}${yamlLines(fields).join(newline)}${newline}---${newline}${plain}`;
    const close = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(plain.slice(3));
    const yamlEnd = 3 + close.index;
    const firstBreak = plain.indexOf('\n') + 1;
    const lines = plain.slice(firstBreak, yamlEnd).split(/\r?\n/);
    const left = new Map(Object.entries(fields));
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
        const m = KEY_LINE.exec(lines[i]);
        const key = m && !/^\s/.test(lines[i]) ? [...left.keys()].find((k) => k.toLowerCase() === m[1].trim().toLowerCase()) : undefined;
        if (key === undefined) {
            out.push(lines[i]);
            continue;
        }
        out.push(...yamlLines({ [key]: left.get(key) }));
        left.delete(key);
        // The old value's own lines (a list or block under the key) go with it.
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-(\s|$)/.test(lines[i + 1]))) i += 1;
    }
    for (const [key, value] of left) out.push(...yamlLines({ [key]: value }));
    return `${bom}${plain.slice(0, firstBreak)}${out.join(newline)}${plain.slice(yamlEnd)}`;
}
