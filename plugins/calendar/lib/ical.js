/**
 * iCalendar (RFC 5545) text: read a calendar file into records, and change
 * events inside a file while keeping everything the plugin doesn't model
 * (other properties, parameters, alarms it doesn't show, other components)
 * exactly as it was written.
 *
 * Times come out as model.js Times whose zone is an IANA id, 'UTC' or null
 * (floating). A TZID the runtime doesn't know is read as the zone it names
 * (Windows', Outlook's and Lotus Notes' names, prefixed ids, "GMT+01.00"),
 * else as the zone its VTIMEZONE defines: the IANA zone whose offsets and
 * changes match its rules over the years the file's times use, else the
 * nearest one, else its standard offset (a fixed offset no IANA id has is
 * read as UTC). Floating only when nothing says what a TZID is. Writing
 * keeps the file's own TZID for a zone its VTIMEZONE matches, and adds a
 * VTIMEZONE for each IANA zone the file uses, made from the runtime's zone
 * data, as RFC 5545 asks. A changed occurrence with RANGE=THISANDFUTURE
 * keeps that on its record (`thisAndFuture`).
 *
 * @module dsh-plugin-calendar/ical
 */
import { createHash, randomUUID } from 'node:crypto';
import { ATTENDEE_STATUSES, addressKey, cleanRecord, isEmailAddress, sameTime } from './model.js';
import { expandWall, parseRule } from './recur.js';
import {
    addDays, fixedZone, ianaZone, isDay, isZone, localZone, nameOffsets, normalLocal, offsetAt, toInstant, toLocal, wallMs, wallOf, zoneIds,
} from './zones.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** What the plugin writes as PRODID in files it makes. */
export const PRODID = '-//DSH//Calendar//EN';

/**
 * A property as written: name, parameters (each a list of values, decoded)
 * and the value as it stands in the file (still escaped). `line` is the
 * unfolded line it was read from, written back as is while unchanged.
 * @typedef {{name: string, params: Record<string, string[]>, value: string, line?: string}} Prop
 */

/**
 * A component, BEGIN:NAME … END:NAME.
 * @typedef {{name: string, props: Prop[], subs: Component[]}} Component
 */

// ── Lines ──────────────────────────────────────────────────────────────

/** The file's logical lines: folded lines joined, any line ending. */
function unfold(text) {
    const out = [];
    for (const line of String(text ?? '').replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
        if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) out[out.length - 1] += line.slice(1);
        else if (line.trim() !== '') out.push(line);
    }
    return out;
}

/** RFC 6868 parameter value escapes. */
const decodeParam = (v) => v.replace(/\^(\^|n|N|')/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c === "'" ? '"' : '^'));

function encodeParam(value) {
    const v = String(value).replace(/\^/g, '^^').replace(/\r?\n/g, '^n').replace(/"/g, "^'");
    return /[;:,\s]/.test(v) ? `"${v}"` : v;
}

/** One content line: NAME;PARAM=a,"b":value. Undefined when it isn't one. */
function parseLine(line) {
    const head = /^[A-Za-z0-9-]+/.exec(line);
    if (head === null) return undefined;
    const name = head[0].toUpperCase();
    const params = {};
    let i = head[0].length;
    while (line[i] === ';') {
        const pname = /^[A-Za-z0-9-]+/.exec(line.slice(i + 1));
        if (pname === null || line[i + 1 + pname[0].length] !== '=') return undefined;
        i += pname[0].length + 2;
        const values = [];
        for (;;) {
            if (line[i] === '"') {
                const end = line.indexOf('"', i + 1);
                if (end < 0) return undefined;
                values.push(decodeParam(line.slice(i + 1, end)));
                i = end + 1;
            } else {
                let j = i;
                while (j < line.length && line[j] !== ';' && line[j] !== ':' && line[j] !== ',') j++;
                values.push(decodeParam(line.slice(i, j)));
                i = j;
            }
            if (line[i] !== ',') break;
            i++;
        }
        const key = pname[0].toUpperCase();
        params[key] = [...(params[key] ?? []), ...values];
    }
    if (line[i] !== ':') return undefined;
    return { name, params, value: line.slice(i + 1), line };
}

/** A line cut into pieces of at most 75 octets, never inside a character. */
function fold(line) {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75) return line;
    const parts = [];
    let start = 0;
    let limit = 75;
    while (start < bytes.length) {
        let end = Math.min(start + limit, bytes.length);
        while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
        parts.push(bytes.subarray(start, end).toString('utf8'));
        start = end;
        limit = 74;
    }
    return parts.join('\r\n ');
}

function formatProp(prop) {
    if (prop.line !== undefined) return prop.line;
    let out = prop.name;
    for (const [key, values] of Object.entries(prop.params)) out += `;${key}=${values.map(encodeParam).join(',')}`;
    return `${out}:${prop.value}`;
}

// ── Components ─────────────────────────────────────────────────────────

/**
 * The components of a file (usually one VCALENDAR). Lenient: lines that
 * aren't content lines are skipped, a missing END closes at the next END
 * of an outer component or at the end of the file.
 * @returns {Component[]}
 */
export function parseIcs(text) {
    const root = { name: '', props: [], subs: [] };
    const stack = [root];
    for (const line of unfold(text)) {
        const prop = parseLine(line);
        if (prop === undefined) continue;
        if (prop.name === 'BEGIN') {
            const component = { name: prop.value.trim().toUpperCase(), props: [], subs: [] };
            stack[stack.length - 1].subs.push(component);
            stack.push(component);
        } else if (prop.name === 'END') {
            const name = prop.value.trim().toUpperCase();
            const at = stack.findLastIndex((c) => c.name === name);
            if (at > 0) stack.length = at;
        } else if (stack.length > 1) {
            stack[stack.length - 1].props.push(prop);
        }
    }
    return root.subs;
}

/** Components as file text: CRLF line ends, lines folded at 75 octets. */
export function writeIcs(components) {
    const out = [];
    const write = (c) => {
        out.push(`BEGIN:${c.name}`);
        for (const prop of c.props) out.push(fold(formatProp(prop)));
        for (const sub of c.subs) write(sub);
        out.push(`END:${c.name}`);
    };
    for (const c of components) write(c);
    return `${out.join('\r\n')}\r\n`;
}

const propOf = (c, name) => c.props.find((p) => p.name === name);
const propsOf = (c, name) => c.props.filter((p) => p.name === name);
const paramOf = (prop, name) => prop?.params[name]?.[0];

/** Undo TEXT escapes (\\ \; \, \n). */
export function unescapeText(value) {
    return String(value).replace(/\\(.)/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** TEXT escapes for writing. */
export function escapeText(text) {
    return String(text).replace(/\r\n?/g, '\n').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
}

/** A TEXT list (CATEGORIES) split on its unescaped commas. */
function splitText(value) {
    const out = [];
    let current = '';
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === '\\' && i + 1 < value.length) {
            current += c + value[i + 1];
            i++;
        } else if (c === ',') {
            out.push(current);
            current = '';
        } else {
            current += c;
        }
    }
    out.push(current);
    return out.map(unescapeText);
}

const textOf = (c, name) => {
    const prop = propOf(c, name);
    if (prop === undefined) return undefined;
    const text = unescapeText(prop.value).trim();
    return text === '' ? undefined : text;
};

/** Replace every `name` property with `props` (none: removed), where the first one stood. */
function setProps(c, name, props) {
    const at = c.props.findIndex((p) => p.name === name);
    c.props = c.props.filter((p) => p.name !== name);
    c.props.splice(at < 0 ? c.props.length : at, 0, ...props);
}

const textProp = (name, text) => ({ name, params: {}, value: escapeText(text) });

// ── Values ─────────────────────────────────────────────────────────────

const DATE_VALUE = /^(\d{4})-?(\d{2})-?(\d{2})$/;
const DATE_TIME_VALUE = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2})(?::?(\d{2}))?(?:[.,]\d+)?(Z)?$/i;

/** A DATE or DATE-TIME value: {date} or {local, utc}; undefined if it's neither. */
function readStamp(value) {
    const v = String(value ?? '').trim();
    let m = DATE_VALUE.exec(v);
    if (m !== null) {
        const date = `${m[1]}-${m[2]}-${m[3]}`;
        return isDay(date) ? { date } : undefined;
    }
    m = DATE_TIME_VALUE.exec(v);
    if (m === null) return undefined;
    const local = normalLocal(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`);
    if (local === undefined || !isDay(local.slice(0, 10))) return undefined;
    return { local, utc: m[7] !== undefined };
}

/** An ISO time ('2026-10-11T07:25:00Z') from a UTC DATE-TIME value. */
function isoOf(value) {
    const stamp = readStamp(value);
    if (stamp === undefined) return undefined;
    return 'date' in stamp ? `${stamp.date}T00:00:00Z` : `${stamp.local}Z`;
}

/** A UTC DATE-TIME value from epoch ms or an ISO time. */
function utcValue(time) {
    const ms = typeof time === 'number' ? time : Date.parse(time);
    return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

/**
 * A DURATION value as {sign, days, ms}: days are calendar days (a day is
 * 23 or 25 hours across daylight saving), ms exact time.
 */
export function readDuration(value) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(value ?? '').trim());
    if (m === null || /^[+-]?PT?$/i.test(String(value).trim())) return undefined;
    return {
        sign: m[1] === '-' ? -1 : 1,
        days: Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0),
        ms: Number(m[4] ?? 0) * HOUR + Number(m[5] ?? 0) * MINUTE + Number(m[6] ?? 0) * 1000,
    };
}

/** A UTC-OFFSET value (+0530, -0800, +023045; leniently +05:30 or +1) in minutes. */
function readOffset(value) {
    const m = /^([+-])(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?$/.exec(String(value ?? '').trim());
    if (m === null || Number(m[2]) > 14 || Number(m[3] ?? 0) > 59) return undefined;
    const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0) + Math.round(Number(m[4] ?? 0) / 60);
    return m[1] === '-' ? -minutes : minutes;
}

const pad = (n) => String(n).padStart(2, '0');
const offsetValue = (minutes) => `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;

/**
 * A time as a property: VALUE=DATE, a UTC 'Z' time, a TZID time, or a
 * floating one. `nameOf` gives the TZID a zone is written as (the file's own
 * name for it, when it has one).
 */
function timeProp(name, time, nameOf = (tz) => tz) {
    if ('date' in time) return { name, params: { VALUE: ['DATE'] }, value: time.date.replaceAll('-', '') };
    const value = time.local.replace(/[-:]/g, '');
    if (time.tz === 'UTC') return { name, params: {}, value: `${value}Z` };
    if (time.tz) return { name, params: { TZID: [nameOf(time.tz)] }, value };
    return { name, params: {}, value };
}

// ── Zones a file defines ───────────────────────────────────────────────

/** A TZID as a key: parameters and VTIMEZONEs name a zone alike (a TZID property's value is TEXT, its commas escaped). */
const zoneKey = (value) => unescapeText(value ?? '').trim().replace(/^"|"$/g, '').trim();

/** A VTIMEZONE's TZID, as a key. */
const tzidOf = (vtimezone) => zoneKey(propOf(vtimezone, 'TZID')?.value);

/** When an observance starts, as wall-clock ms: its DTSTART (a day at midnight), or 1601 as Outlook writes it. */
function onsetWall(part) {
    const start = readStamp(propOf(part, 'DTSTART')?.value) ?? { date: '1601-01-01' };
    return wallMs('date' in start ? `${start.date}T00:00:00` : start.local);
}

/**
 * A VTIMEZONE as a rule zone: `offsetAt(ms)` from its STANDARD and
 * DAYLIGHT parts (each from DTSTART on, by its RRULE and RDATEs), and the
 * onsets it found (1900 to 2200). Lenient as files are: an offset written
 * +01:00, a part without TZOFFSETFROM or DTSTART.
 */
function ruleZone(vtimezone) {
    const onsets = [];
    let first;
    for (const part of vtimezone.subs) {
        if (part.name !== 'STANDARD' && part.name !== 'DAYLIGHT') continue;
        const to = readOffset(propOf(part, 'TZOFFSETTO')?.value);
        if (to === undefined) continue;
        const from = readOffset(propOf(part, 'TZOFFSETFROM')?.value) ?? to;
        const wall = onsetWall(part);
        if (first === undefined || wall < first.wall) first = { wall, from };
        onsets.push([wall - from * MINUTE, to]);
        const rrule = propOf(part, 'RRULE');
        if (rrule !== undefined) {
            try {
                const rule = parseRule(rrule.value);
                let until;
                if (rule.until !== undefined) {
                    const u = readStamp(rule.until);
                    if (u !== undefined) until = 'date' in u ? wallMs(`${u.date}T23:59:59`) : wallMs(u.local) + (u.utc ? from * MINUTE : 0);
                }
                for (const w of expandWall(rule, wall, { until, skipTo: Date.UTC(1900, 0, 1), stop: Date.UTC(2200, 0, 1) })) {
                    onsets.push([w - from * MINUTE, to]);
                }
            } catch {
                // A rule we can't read: its DTSTART alone.
            }
        }
        for (const prop of propsOf(part, 'RDATE')) {
            for (const v of prop.value.split(',')) {
                const s = readStamp(v.split('/')[0]);
                if (s !== undefined && 'local' in s) onsets.push([wallMs(s.local) - (s.utc ? 0 : from * MINUTE), to]);
            }
        }
    }
    if (first === undefined) return undefined;
    onsets.sort((a, b) => a[0] - b[0]);
    return {
        onsets,
        offsetAt(ms) {
            let lo = 0;
            let hi = onsets.length - 1;
            let found = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (onsets[mid][0] <= ms) {
                    found = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            return found < 0 ? first.from : onsets[found][1];
        },
    };
}

/** Zones tried first when matching a file's own zone, before the runtime's whole list. */
const COMMON_ZONES = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
    'Pacific/Honolulu', 'America/Halifax', 'America/St_Johns', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City',
    'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
    'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
    'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Zurich', 'Europe/Vienna', 'Europe/Stockholm', 'Europe/Oslo',
    'Europe/Copenhagen', 'Europe/Warsaw', 'Europe/Prague', 'Europe/Athens', 'Europe/Helsinki', 'Europe/Kyiv',
    'Europe/Istanbul', 'Europe/Moscow', 'Africa/Lagos', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Nairobi',
    'Asia/Jerusalem', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Jakarta',
    'Asia/Singapore', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Manila', 'Asia/Seoul', 'Asia/Tokyo',
    'Australia/Perth', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Brisbane', 'Australia/Sydney',
    'Pacific/Auckland',
];

/** The zones tried when matching a file's own zone, in order: the user's, the common ones, then every one the runtime knows. */
function* candidates(userZone) {
    const seen = new Set(['UTC']);
    for (const tz of [userZone, ...COMMON_ZONES, ...zoneIds()]) {
        if (!tz || seen.has(tz)) continue;
        seen.add(tz);
        if (isZone(tz)) yield tz;
    }
}

/** Mid-winter and mid-summer of each year: where a zone's standard and daylight offsets show. */
const seasons = (years) => years.flatMap((y) => [Date.UTC(y, 0, 15, 12), Date.UTC(y, 6, 15, 12)]);

/** Instants to compare zones at, in the years given: the 1st and the 15th of each month, and each change the rules make there (and the minute before it). */
function samplesOf(rules, years) {
    const out = [];
    for (const y of years) for (let m = 0; m < 12; m++) out.push(Date.UTC(y, m, 1, 12), Date.UTC(y, m, 15, 12));
    for (const [at] of rules.onsets) if (years.includes(new Date(at).getUTCFullYear())) out.push(at - MINUTE, at);
    return out;
}

/** Whether a zone keeps the rules' offsets at every sample in the years given. */
function sameAs(zone, rules, years) {
    return samplesOf(rules, years).every((ms) => offsetAt(zone, ms) === rules.offsetAt(ms));
}

/**
 * The IANA zone with the rule zone's offsets and changes all through the
 * years given, or undefined. A fixed offset is the user's zone when that
 * has it all along, else the offset's own id (Etc/GMT-1).
 */
function matchZone(rules, years, userZone) {
    const samples = samplesOf(rules, years);
    const want = samples.map((ms) => rules.offsetAt(ms));
    const fits = (tz) => samples.every((ms, i) => offsetAt(tz, ms) === want[i]);
    if (want.every((o) => o === want[0])) {
        if (want[0] === 0) return 'UTC';
        if (userZone && isZone(userZone) && fits(userZone)) return userZone;
        const fixed = fixedZone(want[0]);
        if (fixed !== undefined) return fixed;
    }
    for (const tz of candidates(userZone)) if (fits(tz)) return tz;
    return undefined;
}

/**
 * When none matches exactly: the zone with the rule zone's standard and
 * daylight offsets in every year given that agrees with it most often
 * (three samples in four at least): the same zone, its changes on other
 * days, as when the file has rules that changed since it was written.
 */
function nearZone(rules, years, userZone) {
    const must = seasons(years);
    const mustWant = must.map((ms) => rules.offsetAt(ms));
    if (mustWant.every((o) => o === mustWant[0])) return undefined;
    const samples = samplesOf(rules, years);
    const want = samples.map((ms) => rules.offsetAt(ms));
    let best;
    let bestScore = Math.ceil(samples.length * 0.75) - 1;
    for (const tz of candidates(userZone)) {
        if (!must.every((ms, i) => offsetAt(tz, ms) === mustWant[i])) continue;
        const score = samples.reduce((n, ms, i) => n + (offsetAt(tz, ms) === want[i] ? 1 : 0), 0);
        if (score > bestScore) {
            best = tz;
            bestScore = score;
        }
    }
    return best;
}

/** A rule zone that keeps one offset (minutes east). */
const fixedRules = (minutes) => ({ onsets: [], offsetAt: () => minutes });

/**
 * A zone with a fixed offset: its IANA id (Etc/GMT-1), else for an offset
 * that isn't whole hours a zone that kept it all through the years given,
 * else a rule zone.
 */
function fixedOf(minutes, years, userZone) {
    const rules = fixedRules(minutes);
    return matchZone(rules, years, userZone) ?? rules;
}

/**
 * A VTIMEZONE's standard offset: its STANDARD observance's (the last to
 * start before `before`, wall-clock ms), else the offset its DAYLIGHT one
 * changes from; undefined when it gives neither.
 */
function standardOffset(vtimezone, before) {
    const standards = vtimezone.subs
        .filter((part) => part.name === 'STANDARD')
        .map((part) => ({ wall: onsetWall(part), to: readOffset(propOf(part, 'TZOFFSETTO')?.value) }))
        .filter((s) => s.to !== undefined)
        .sort((a, b) => a.wall - b.wall);
    const standard = standards.filter((s) => s.wall <= before).at(-1) ?? standards[0];
    if (standard !== undefined) return standard.to;
    for (const part of vtimezone.subs) {
        const from = part.name === 'DAYLIGHT' ? readOffset(propOf(part, 'TZOFFSETFROM')?.value) : undefined;
        if (from !== undefined) return from;
    }
    return undefined;
}

/** Matches already made, by the user's zone, the years and the VTIMEZONE's text. */
const matches = new Map();

/**
 * The zone a VTIMEZONE defines, from its rules: the IANA zone that matches
 * them over the years given, else the nearest one, else its standard offset.
 */
function definedZone(def, rules, years, userZone) {
    const key = `${userZone}\n${years.join(',')}\n${writeIcs([def])}`;
    if (matches.has(key)) return matches.get(key);
    const end = Date.UTC(years.at(-1) + 1, 0, 1);
    const zone = matchZone(rules, years, userZone) ?? nearZone(rules, years, userZone)
        ?? fixedOf(standardOffset(def, end) ?? rules.offsetAt(end), years, userZone);
    if (matches.size > 200) matches.clear();
    matches.set(key, zone);
    return zone;
}

/** How long a rule's periods last, in days, to tell how long a series with COUNT runs. */
const PERIOD_DAYS = { YEARLY: 366, MONTHLY: 31, WEEKLY: 7, DAILY: 1 };

/**
 * The years each TZID's times fall in: the years written, and for a series
 * that runs until now or on, the years around now too (where it's looked
 * at). A zone the file defines is matched over these.
 */
function zoneYears(calendar, nowYear) {
    const years = new Map();
    const add = (tzid, year) => {
        if (!Number.isInteger(year) || year < 1800 || year > 2999) return;
        if (!years.has(tzid)) years.set(tzid, new Set());
        years.get(tzid).add(year);
    };
    const walk = (c) => {
        for (const prop of c.props) {
            const tzid = zoneKey(paramOf(prop, 'TZID'));
            if (tzid) for (const part of prop.value.split(',')) add(tzid, Number(part.trim().slice(0, 4)));
        }
        const start = propOf(c, 'DTSTART');
        const tzid = zoneKey(paramOf(start, 'TZID'));
        const rrule = propOf(c, 'RRULE')?.value ?? '';
        if (tzid && rrule) {
            const from = Number(start.value.trim().slice(0, 4));
            const until = /UNTIL=(\d{4})/i.exec(rrule);
            const count = /COUNT=(\d+)/i.exec(rrule);
            const days = PERIOD_DAYS[/FREQ=([A-Z]+)/i.exec(rrule)?.[1].toUpperCase()] ?? 0;
            const interval = Number(/INTERVAL=(\d+)/i.exec(rrule)?.[1] ?? 1);
            const to = until ? Number(until[1]) : count ? from + Math.ceil((Number(count[1]) * interval * days) / 365) : nowYear + 1;
            for (let y = Math.max(from, nowYear - 1); y <= Math.min(to, nowYear + 1); y++) add(tzid, y);
        }
        for (const sub of c.subs) if (sub.name !== 'VTIMEZONE') walk(sub);
    };
    walk(calendar);
    return years;
}

/** Whether a zone has the rule zone's offsets in mid-winter and mid-summer of each year given. */
const agrees = (zone, rules, years) => seasons(years).every((ms) => offsetAt(zone, ms) === rules.offsetAt(ms));

/** How one VCALENDAR's times read: its zones by TZID, and the zone for floating times. */
class ZoneBook {
    constructor(calendar, userZone, now = Date.now()) {
        this.userZone = userZone;
        this.nowYear = new Date(now).getUTCFullYear();
        this.defs = new Map();
        for (const sub of calendar.subs) {
            if (sub.name !== 'VTIMEZONE') continue;
            const id = tzidOf(sub);
            if (id && !this.defs.has(id)) this.defs.set(id, sub);
        }
        this.years = zoneYears(calendar, this.nowYear);
        // X-WR-TIMEZONE (Google's and Apple's exports): floating times in the file are in that zone.
        const wr = textOf(calendar, 'X-WR-TIMEZONE');
        this.floating = (wr ? ianaZone(wr) : undefined) ?? null;
        this.zones = new Map();
        this.names = undefined;
    }

    /**
     * The zone for a TZID: an IANA id, 'UTC', null (floating) or a rule
     * zone (a fixed offset no IANA id has). In this order: an IANA id (as
     * is, behind a prefix, or the VTIMEZONE's X-LIC-LOCATION); another name
     * for one (Windows', Outlook's, Lotus Notes', a bare offset), unless
     * the file's VTIMEZONE gives other offsets; the zone the VTIMEZONE's
     * rules make (see definedZone); its standard offset when its rules can't
     * be read. Floating only when nothing says what the TZID is.
     */
    resolve(tzid) {
        if (this.zones.has(tzid)) return this.zones.get(tzid);
        const zone = this.find(tzid);
        this.zones.set(tzid, zone);
        return zone;
    }

    find(tzid) {
        const def = this.defs.get(tzid);
        const years = [...(this.years.get(tzid) ?? [this.nowYear])].sort((a, b) => a - b);
        const named = ianaZone(tzid);
        if (named !== undefined && named !== 'UTC' && (tzid === named || tzid.endsWith(`/${named}`))) return named;
        const location = def === undefined ? undefined : ianaZone(textOf(def, 'X-LIC-LOCATION'));
        if (location !== undefined) return location;
        const rules = def === undefined ? undefined : ruleZone(def);
        if (named !== undefined && (rules === undefined || agrees(named, rules, years))) return named;
        if (rules !== undefined) return definedZone(def, rules, years, this.userZone);
        const standard = (def === undefined ? undefined : standardOffset(def, Date.UTC(years.at(-1) + 1, 0, 1))) ?? nameOffsets(tzid)?.[0];
        if (standard !== undefined) return fixedOf(standard, years, this.userZone);
        // A one-word id the runtime knows (CET, EST5EDT, Japan), with nothing else to go on.
        return isZone(tzid) ? tzid : null;
    }

    /**
     * The TZID this file writes a zone as: its own, from the first of its
     * VTIMEZONEs that is that zone all through the years it's used in (an
     * IANA-named one first), so a changed time keeps the file's names; else
     * the zone's IANA id.
     */
    nameOf(tz) {
        if (this.names === undefined) {
            this.names = new Map();
            for (const [tzid, def] of this.defs) {
                const zone = this.resolve(tzid);
                if (typeof zone !== 'string' || zone === 'UTC' || (this.names.has(zone) && tzid !== zone)) continue;
                const rules = ruleZone(def);
                if (rules !== undefined && sameAs(zone, rules, [...(this.years.get(tzid) ?? [this.nowYear])])) this.names.set(zone, tzid);
            }
        }
        return this.names.get(tz) ?? tz;
    }

    /** The Times in a DATE or DATE-TIME property (EXDATE and RDATE hold lists; a PERIOD gives its start). */
    times(prop) {
        const out = [];
        const tzid = zoneKey(paramOf(prop, 'TZID'));
        const dateOnly = /^DATE$/i.test(paramOf(prop, 'VALUE') ?? '');
        for (const part of prop.value.split(',')) {
            const stamp = readStamp(part.split('/')[0]);
            if (stamp === undefined) continue;
            if ('date' in stamp) {
                out.push({ date: stamp.date });
            } else if (dateOnly) {
                out.push({ date: stamp.local.slice(0, 10) });
            } else if (stamp.utc) {
                out.push({ local: stamp.local, tz: 'UTC' });
            } else if (!tzid) {
                out.push({ local: stamp.local, tz: this.floating });
            } else {
                const zone = this.resolve(tzid);
                if (zone === null) out.push({ local: stamp.local, tz: this.floating });
                else if (typeof zone === 'string') out.push({ local: stamp.local, tz: zone });
                else out.push({ local: toLocal(toInstant(stamp.local, zone), 'UTC'), tz: 'UTC' });
            }
        }
        return out;
    }

    time(prop) {
        return prop === undefined ? undefined : this.times(prop)[0];
    }
}

// ── Zones the plugin writes ────────────────────────────────────────────

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const vtimezones = new Map();

/** The zone's short name at an instant when it has a real one ('PDT'), else undefined. */
function shortName(tz, ms) {
    try {
        const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
            .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value;
        return name && /^[A-Z]{2,5}$/.test(name) ? name : undefined;
    } catch {
        return undefined;
    }
}

/** A zone's offset changes between two instants: [{at, from, to}]. */
function transitions(tz, from, to) {
    const out = [];
    const step = 7 * DAY;
    let before = from;
    let offset = offsetAt(tz, from);
    for (let t = from + step; t <= to; t += step) {
        const now = offsetAt(tz, t);
        if (now !== offset) {
            let lo = before;
            let hi = t;
            while (hi - lo > MINUTE) {
                const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
                if (offsetAt(tz, mid) === offset) lo = mid;
                else hi = mid;
            }
            out.push({ at: hi, from: offset, to: offsetAt(tz, hi) });
            offset = offsetAt(tz, hi);
            // Look again from the change, in case the offset moved twice within the step.
            before = hi;
            t = hi;
            continue;
        }
        before = t;
    }
    return out;
}

/**
 * A VTIMEZONE for an IANA zone, from the runtime's zone data: the offset
 * changes from the year before `fromYear` through two years from now, the
 * steady yearly pattern at the end as an RRULE that goes on, the rest as
 * single changes.
 * @returns {Component}
 */
export function vtimezone(tz, fromYear) {
    const lastYear = Math.max(fromYear, new Date().getUTCFullYear()) + 2;
    const key = `${tz}\n${fromYear}\n${lastYear}`;
    const known = vtimezones.get(key);
    if (known !== undefined) return structuredClone(known);
    const component = { name: 'VTIMEZONE', props: [textProp('TZID', tz)], subs: [] };
    const found = transitions(tz, Date.UTC(fromYear - 1, 0, 1), Date.UTC(lastYear + 1, 0, 1)).map((t) => {
        const local = wallOf(t.at + t.from * MINUTE);
        const day = Number(local.slice(8, 10));
        const year = Number(local.slice(0, 4));
        const month = Number(local.slice(5, 7));
        const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
        return {
            ...t, local, year, month, kind: t.to > t.from ? 'DAYLIGHT' : 'STANDARD',
            weekday: (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7,
            nth: Math.ceil(day / 7), last: day > dim - 7, clock: local.slice(11),
        };
    });
    const observance = (kind, t, rrule) => {
        const props = [
            { name: 'TZOFFSETFROM', params: {}, value: offsetValue(t.from) },
            { name: 'TZOFFSETTO', params: {}, value: offsetValue(t.to) },
        ];
        const name = shortName(tz, t.at);
        if (name) props.push(textProp('TZNAME', name));
        props.push({ name: 'DTSTART', params: {}, value: t.local.replace(/[-:]/g, '') });
        if (rrule) props.push({ name: 'RRULE', params: {}, value: rrule });
        return { name: kind, props, subs: [] };
    };
    if (found.length === 0) {
        const offset = offsetAt(tz, Date.UTC(fromYear, 0, 1));
        component.subs.push(observance('STANDARD', { from: offset, to: offset, at: Date.UTC(fromYear, 0, 1), local: '1970-01-01T00:00:00' }));
    } else {
        // Per kind, the run of years at the end where the change is the same weekday rule each year.
        const ruled = new Map();
        for (const kind of ['DAYLIGHT', 'STANDARD']) {
            const mine = found.filter((t) => t.kind === kind);
            const byYear = new Map();
            for (const t of mine) byYear.set(t.year, [...(byYear.get(t.year) ?? []), t]);
            const end = byYear.get(lastYear);
            if (end?.length !== 1) continue;
            const model = end[0];
            let nthSame = true;
            let allLast = true;
            let firstYear = lastYear;
            for (let y = lastYear - 1; y >= fromYear - 1; y--) {
                const list = byYear.get(y);
                if (list?.length !== 1) break;
                const t = list[0];
                if (t.month !== model.month || t.weekday !== model.weekday || t.clock !== model.clock || t.from !== model.from || t.to !== model.to) break;
                const nthNext = nthSame && t.nth === model.nth;
                const lastNext = allLast && t.last && model.last;
                if (!nthNext && !lastNext) break;
                nthSame = nthNext;
                allLast = lastNext;
                firstYear = y;
            }
            if (firstYear > lastYear - 2) continue;
            const byday = nthSame ? `${model.nth}${WEEKDAY_CODES[model.weekday]}` : `-1${WEEKDAY_CODES[model.weekday]}`;
            ruled.set(kind, { firstYear, rrule: `FREQ=YEARLY;BYMONTH=${model.month};BYDAY=${byday}` });
        }
        for (const t of found) {
            const rule = ruled.get(t.kind);
            if (rule === undefined || t.year < rule.firstYear) component.subs.push(observance(t.kind, t));
            else if (t.year === rule.firstYear) component.subs.push(observance(t.kind, t, rule.rrule));
        }
    }
    vtimezones.set(key, structuredClone(component));
    return component;
}

/** Add the VTIMEZONEs the calendar's TZIDs need, and drop the ones nothing uses. */
function syncZones(calendar) {
    const used = new Map();
    const walk = (c) => {
        for (const prop of c.props) {
            const tzid = zoneKey(paramOf(prop, 'TZID'));
            if (!tzid) continue;
            const year = Number(prop.value.slice(0, 4));
            used.set(tzid, Math.min(used.get(tzid) ?? 9999, Number.isInteger(year) && year > 1800 ? year : 9999));
        }
        for (const sub of c.subs) if (sub.name !== 'VTIMEZONE') walk(sub);
    };
    walk(calendar);
    calendar.subs = calendar.subs.filter((c) => c.name !== 'VTIMEZONE' || used.has(tzidOf(c)));
    const have = new Set(calendar.subs.filter((c) => c.name === 'VTIMEZONE').map(tzidOf));
    const add = [];
    for (const [tzid, year] of used) {
        if (!have.has(tzid) && isZone(tzid) && tzid.includes('/')) add.push(vtimezone(tzid, year < 9999 ? year : new Date().getUTCFullYear()));
    }
    const at = calendar.subs.findIndex((c) => c.name !== 'VTIMEZONE');
    calendar.subs.splice(at < 0 ? calendar.subs.length : at, 0, ...add);
}

// ── Events ─────────────────────────────────────────────────────────────

const ROLE_OF = { 'REQ-PARTICIPANT': 'required', 'OPT-PARTICIPANT': 'optional', CHAIR: 'chair', 'NON-PARTICIPANT': 'non-participant' };
const ROLE_PARAM = Object.fromEntries(Object.entries(ROLE_OF).map(([k, v]) => [v, k]));

/**
 * Someone on an event. A mailto address gives their email; any other
 * calendar user address (a urn:uuid, a principal's URL: iCloud's own
 * meetings name their organizer so) is kept as `address`, with the email
 * from its EMAIL parameter (RFC 7986) where there is one.
 */
function readPerson(prop) {
    const value = String(prop.value).trim();
    const mail = /^mailto:(.*)$/i.exec(value);
    let email;
    if (mail) {
        email = mail[1].trim();
    } else {
        const given = paramOf(prop, 'EMAIL')?.trim().replace(/^mailto:/i, '');
        email = isEmailAddress(given) ? given : value;
    }
    if (email === '') return undefined;
    const person = { email };
    if (!mail) person.address = value;
    const name = paramOf(prop, 'CN')?.trim();
    if (name && name !== email) person.name = name;
    const status = paramOf(prop, 'PARTSTAT')?.toLowerCase();
    if (status && ATTENDEE_STATUSES.includes(status)) person.status = status;
    const role = ROLE_OF[paramOf(prop, 'ROLE')?.toUpperCase()];
    if (role) person.role = role;
    return person;
}

/** A reminder's minutes before the start, for the alarms the plugin shows (shown, sounded, start-related). */
function alarmMinutes(alarm) {
    const action = (propOf(alarm, 'ACTION')?.value ?? '').trim().toUpperCase();
    if (action !== 'DISPLAY' && action !== 'AUDIO') return undefined;
    const trigger = propOf(alarm, 'TRIGGER');
    if (trigger === undefined || /^DATE-TIME$/i.test(paramOf(trigger, 'VALUE') ?? '')) return undefined;
    if ((paramOf(trigger, 'RELATED') ?? 'START').toUpperCase() !== 'START') return undefined;
    const d = readDuration(trigger.value);
    if (d === undefined) return undefined;
    const minutes = -d.sign * (d.days * 1440 + d.ms / MINUTE);
    return minutes >= 0 ? Math.round(minutes) : undefined;
}

/** A start plus a DURATION: calendar days on the wall clock, then exact time. */
function plusDuration(start, d) {
    if ('date' in start) return { date: addDays(start.date, d.sign * (d.days + Math.ceil(d.ms / DAY))) };
    const wall = wallMs(start.local) + d.sign * d.days * DAY;
    if (!start.tz || start.tz === 'UTC') return { local: wallOf(wall + d.sign * d.ms), tz: start.tz };
    const ms = toInstant(wallOf(wall), start.tz) + d.sign * d.ms;
    return { local: toLocal(ms, start.tz), tz: start.tz };
}

/** A uid for an event that came without one: the same each time the same file is read. */
function madeUid(event) {
    const hash = createHash('sha256');
    for (const name of ['DTSTART', 'SUMMARY', 'LOCATION', 'RRULE', 'RECURRENCE-ID']) hash.update(`${propOf(event, name)?.value ?? ''}\n`);
    return `made-${hash.digest('hex').slice(0, 32)}`;
}

/** A VEVENT as a record, or undefined when it has no usable start. */
function readEvent(event, book, warnings) {
    const start = book.time(propOf(event, 'DTSTART'));
    if (start === undefined) {
        warnings.push('An event without a start time was left out.');
        return undefined;
    }
    let end = book.time(propOf(event, 'DTEND'));
    if (end === undefined) {
        const duration = readDuration(propOf(event, 'DURATION')?.value);
        if (duration !== undefined) end = plusDuration(start, duration);
    }
    if ('date' in start) {
        if (end !== undefined && !('date' in end)) end = { date: end.local.slice(0, 10) };
        if (end === undefined || end.date <= start.date) end = { date: addDays(start.date, 1) };
    } else if (end === undefined || 'date' in end || toInstant(end.local, end.tz ?? 'UTC') < toInstant(start.local, start.tz ?? 'UTC')) {
        end = { ...start };
    }
    const record = {
        uid: textOf(event, 'UID') ?? madeUid(event),
        title: textOf(event, 'SUMMARY') ?? '',
        description: textOf(event, 'DESCRIPTION'),
        location: textOf(event, 'LOCATION'),
        url: propOf(event, 'URL')?.value.trim() || undefined,
        start,
        end,
    };
    const status = textOf(event, 'STATUS')?.toLowerCase();
    if (status === 'confirmed' || status === 'tentative' || status === 'cancelled') record.status = status;
    if (textOf(event, 'TRANSP')?.toUpperCase() === 'TRANSPARENT') record.busy = false;
    const privacy = textOf(event, 'CLASS')?.toLowerCase();
    if (privacy === 'private' || privacy === 'confidential') record.privacy = privacy;
    const organizer = propOf(event, 'ORGANIZER');
    if (organizer !== undefined) record.organizer = readPerson(organizer);
    const attendees = propsOf(event, 'ATTENDEE').map(readPerson).filter(Boolean);
    if (attendees.length > 0) record.attendees = attendees;
    const alarms = [...new Set(event.subs.filter((s) => s.name === 'VALARM').map(alarmMinutes).filter((m) => m !== undefined))];
    if (alarms.length > 0) record.alarms = alarms.sort((a, b) => a - b);
    const rrule = propOf(event, 'RRULE');
    if (rrule !== undefined) {
        try {
            parseRule(rrule.value);
            record.rrule = rrule.value.trim();
        } catch (error) {
            warnings.push(`"${record.title || record.uid}" repeats by a rule that can't be read (${error.message}); it shows once.`);
        }
    }
    const rdates = propsOf(event, 'RDATE').flatMap((p) => book.times(p));
    if (rdates.length > 0) record.rdates = rdates;
    const exdates = propsOf(event, 'EXDATE').flatMap((p) => book.times(p));
    if (exdates.length > 0) record.exdates = exdates;
    const recurrence = propOf(event, 'RECURRENCE-ID');
    const recurrenceId = book.time(recurrence);
    if (recurrenceId !== undefined) {
        record.recurrenceId = recurrenceId;
        // RANGE=THISANDFUTURE: the change holds for every later occurrence of the series too (expand.js).
        if (/^THISANDFUTURE$/i.test(paramOf(recurrence, 'RANGE')?.trim() ?? '')) record.thisAndFuture = true;
    }
    const conference = propOf(event, 'CONFERENCE') ?? propOf(event, 'X-GOOGLE-CONFERENCE')
        ?? propOf(event, 'X-MICROSOFT-SKYPETEAMSMEETINGURL') ?? propOf(event, 'X-MICROSOFT-ONLINEMEETINGEXTERNALLINK');
    if (conference !== undefined && /^https?:\/\//i.test(unescapeText(conference.value).trim())) record.conference = unescapeText(conference.value).trim();
    const categories = [...new Set(propsOf(event, 'CATEGORIES').flatMap((p) => splitText(p.value)).map((c) => c.trim()).filter(Boolean))];
    if (categories.length > 0) record.categories = categories;
    const created = isoOf(propOf(event, 'CREATED')?.value);
    if (created) record.created = created;
    const updated = isoOf((propOf(event, 'LAST-MODIFIED') ?? propOf(event, 'DTSTAMP'))?.value);
    if (updated) record.updated = updated;
    const sequence = Number(propOf(event, 'SEQUENCE')?.value);
    if (Number.isInteger(sequence) && sequence > 0) record.sequence = sequence;
    return cleanRecord(record);
}

/** The calendar's own name, description and color, when the file says. */
function calendarInfo(calendar) {
    const info = {};
    const name = textOf(calendar, 'X-WR-CALNAME') ?? textOf(calendar, 'NAME');
    if (name) info.name = name;
    const description = textOf(calendar, 'X-WR-CALDESC') ?? textOf(calendar, 'DESCRIPTION');
    if (description) info.description = description;
    const color = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(textOf(calendar, 'X-APPLE-CALENDAR-COLOR') ?? textOf(calendar, 'COLOR') ?? '');
    if (color) info.color = `#${color[1].toLowerCase()}`;
    const zone = ianaZone(textOf(calendar, 'X-WR-TIMEZONE'));
    if (zone) info.timeZone = zone;
    return info;
}

/**
 * The events in a calendar file, as records. A series and its changed
 * occurrences come out as separate records with the same uid.
 * @param {string} text
 * @param {{zone?: string, now?: number}} [opts] - the user's zone, tried first when matching a zone the
 *   file defines; now, for the years a series that goes on is matched over.
 * @returns {{events: import('./model.js').Record[], calendar: {name?: string, description?: string, color?: string, timeZone?: string}, warnings: string[]}}
 */
export function readIcs(text, opts = {}) {
    const zone = opts.zone ?? localZone();
    const warnings = [];
    const events = new Map();
    let calendar = {};
    for (const root of parseIcs(text)) {
        if (root.name !== 'VCALENDAR') continue;
        calendar = { ...calendarInfo(root), ...calendar };
        const book = new ZoneBook(root, zone, opts.now);
        for (const sub of root.subs) {
            if (sub.name !== 'VEVENT') continue;
            const record = readEvent(sub, book, warnings);
            if (record === undefined) continue;
            const key = `${record.uid}\n${record.recurrenceId ? JSON.stringify(record.recurrenceId) : ''}`;
            const had = events.get(key);
            if (had !== undefined && (had.sequence ?? 0) > (record.sequence ?? 0)) continue;
            events.set(key, record);
        }
    }
    return { events: [...events.values()], calendar, warnings: [...new Set(warnings)] };
}

// ── Writing events ─────────────────────────────────────────────────────

/** Deep equality for record fields (key order doesn't matter). */
function same(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}

/**
 * The people on an event written back: unchanged ones as they were,
 * changed ones keep their address and the parameters the plugin doesn't
 * model.
 */
function writePeople(event, name, people) {
    const old = [];
    for (const prop of propsOf(event, name)) {
        const person = readPerson(prop);
        if (person !== undefined) old.push({ prop, person });
    }
    const keyOf = (person) => addressKey(person.address ?? person.email);
    const byKey = new Map(old.map((o) => [keyOf(o.person), o]));
    const byEmail = new Map(old.map((o) => [o.person.email.toLowerCase(), o]));
    const props = people.map((person) => {
        const found = byKey.get(keyOf(person)) ?? byEmail.get(person.email.toLowerCase());
        const existing = found?.prop;
        if (existing !== undefined && same(cleanPerson(found.person), cleanPerson(person))) return existing;
        const params = existing ? { ...existing.params } : {};
        if (person.name) params.CN = [person.name];
        else delete params.CN;
        if (name === 'ATTENDEE') {
            params.ROLE = [ROLE_PARAM[person.role ?? 'required'] ?? 'REQ-PARTICIPANT'];
            params.PARTSTAT = [(person.status ?? 'needs-action').toUpperCase()];
            if (existing === undefined && (person.status ?? 'needs-action') === 'needs-action') params.RSVP = ['TRUE'];
        }
        const address = person.address ?? found?.person.address;
        if (address !== undefined && isEmailAddress(person.email) && params.EMAIL === undefined) params.EMAIL = [person.email];
        return { name, params, value: address ?? `mailto:${person.email}` };
    });
    setProps(event, name, props);
}

const cleanPerson = (p) => ({ email: p.email.toLowerCase(), address: p.address || undefined, name: p.name || undefined, status: p.status, role: p.role });

/** Reminders written back: alarms the plugin doesn't show stay; shown ones match the list. */
function writeAlarms(event, minutes) {
    const wanted = new Set(minutes ?? []);
    event.subs = event.subs.filter((sub) => {
        if (sub.name !== 'VALARM') return true;
        const m = alarmMinutes(sub);
        if (m === undefined) return true;
        if (wanted.has(m)) {
            wanted.delete(m);
            return true;
        }
        return false;
    });
    for (const m of [...wanted].sort((a, b) => a - b)) {
        const trigger = m === 0 ? 'PT0S' : m % 1440 === 0 ? `-P${m / 1440}D` : `-PT${m}M`;
        event.subs.push({
            name: 'VALARM',
            props: [
                { name: 'ACTION', params: {}, value: 'DISPLAY' },
                textProp('DESCRIPTION', 'Reminder'),
                { name: 'TRIGGER', params: {}, value: trigger },
            ],
            subs: [],
        });
    }
}

/**
 * Write a record into a VEVENT. Only the fields that differ from `before`
 * (the record the VEVENT held) are rewritten, so the rest stays as the
 * file had it; without `before`, everything is written. Times keep the
 * file's own name for their zone (`book`).
 */
function writeEvent(event, record, before, now, book) {
    const changed = (key) => before === undefined || !same(record[key], before[key]);
    const text = (name, value) => setProps(event, name, value ? [textProp(name, value)] : []);
    const time = (name, value) => timeProp(name, value, (tz) => book?.nameOf(tz) ?? tz);
    if (changed('uid')) text('UID', record.uid);
    setProps(event, 'DTSTAMP', [{ name: 'DTSTAMP', params: {}, value: utcValue(now) }]);
    if (changed('start') || changed('end')) {
        setProps(event, 'DTSTART', [time('DTSTART', record.start)]);
        setProps(event, 'DURATION', []);
        setProps(event, 'DTEND', [time('DTEND', record.end)]);
    }
    if (changed('recurrenceId') || changed('thisAndFuture')) {
        const prop = record.recurrenceId ? time('RECURRENCE-ID', record.recurrenceId) : undefined;
        if (prop !== undefined && record.thisAndFuture) prop.params = { RANGE: ['THISANDFUTURE'], ...prop.params };
        setProps(event, 'RECURRENCE-ID', prop ? [prop] : []);
    }
    if (changed('title')) text('SUMMARY', record.title);
    if (changed('description')) {
        text('DESCRIPTION', record.description);
        setProps(event, 'X-ALT-DESC', []);
    }
    if (changed('location')) {
        text('LOCATION', record.location);
        setProps(event, 'X-APPLE-STRUCTURED-LOCATION', []);
    }
    if (changed('url')) setProps(event, 'URL', record.url ? [{ name: 'URL', params: {}, value: record.url }] : []);
    if (changed('status')) setProps(event, 'STATUS', record.status ? [{ name: 'STATUS', params: {}, value: record.status.toUpperCase() }] : []);
    if (changed('busy')) setProps(event, 'TRANSP', [{ name: 'TRANSP', params: {}, value: record.busy === false ? 'TRANSPARENT' : 'OPAQUE' }]);
    if (changed('privacy')) setProps(event, 'CLASS', record.privacy ? [{ name: 'CLASS', params: {}, value: record.privacy.toUpperCase() }] : []);
    if (changed('organizer')) {
        if (record.organizer) writePeople(event, 'ORGANIZER', [record.organizer]);
        else setProps(event, 'ORGANIZER', []);
    }
    if (changed('attendees')) writePeople(event, 'ATTENDEE', record.attendees ?? []);
    if (changed('alarms')) writeAlarms(event, record.alarms);
    if (changed('rrule')) setProps(event, 'RRULE', record.rrule ? [{ name: 'RRULE', params: {}, value: record.rrule }] : []);
    if (changed('rdates')) setProps(event, 'RDATE', (record.rdates ?? []).map((t) => time('RDATE', t)));
    if (changed('exdates')) setProps(event, 'EXDATE', (record.exdates ?? []).map((t) => time('EXDATE', t)));
    if (changed('conference')) {
        setProps(event, 'CONFERENCE', record.conference ? [{ name: 'CONFERENCE', params: { VALUE: ['URI'] }, value: record.conference }] : []);
    }
    if (changed('categories')) {
        setProps(event, 'CATEGORIES', record.categories?.length ? [{ name: 'CATEGORIES', params: {}, value: record.categories.map(escapeText).join(',') }] : []);
    }
    if (changed('sequence')) setProps(event, 'SEQUENCE', record.sequence ? [{ name: 'SEQUENCE', params: {}, value: String(record.sequence) }] : []);
    if (before === undefined && propOf(event, 'CREATED') === undefined) event.props.push({ name: 'CREATED', params: {}, value: utcValue(record.created ?? now) });
    setProps(event, 'LAST-MODIFIED', [{ name: 'LAST-MODIFIED', params: {}, value: utcValue(now) }]);
}

/** A new VCALENDAR. */
function newCalendar() {
    return {
        name: 'VCALENDAR',
        props: [
            { name: 'VERSION', params: {}, value: '2.0' },
            textProp('PRODID', PRODID),
            { name: 'CALSCALE', params: {}, value: 'GREGORIAN' },
        ],
        subs: [],
    };
}

/**
 * A calendar file with events changed, added or taken out.
 * @param {string|null|undefined} raw - the file as it is; empty for a new one.
 * @param {{uid: string, recurrenceId?: import('./model.js').Time, record: import('./model.js').Record|null}[]} edits
 *   Each edit names an event (the series or a single event when
 *   recurrenceId is undefined, else that changed occurrence) and gives its
 *   new record, or null to take it out. An event the file doesn't have is added.
 * @param {{now?: number, zone?: string}} [opts]
 * @returns {string|null} the new text, or null when no event or task is left (delete the file).
 */
export function editIcs(raw, edits, opts = {}) {
    const now = opts.now ?? Date.now();
    const zone = opts.zone ?? localZone();
    const roots = raw ? parseIcs(raw) : [];
    let calendar = roots.find((c) => c.name === 'VCALENDAR');
    if (calendar === undefined) {
        calendar = newCalendar();
        roots.splice(0, roots.length, calendar);
    }
    const book = new ZoneBook(calendar, zone, now);
    for (const edit of edits) {
        const index = calendar.subs.findIndex((c) => c.name === 'VEVENT'
            && textOf(c, 'UID') === edit.uid
            && (edit.recurrenceId === undefined
                ? propOf(c, 'RECURRENCE-ID') === undefined
                : sameTime(book.time(propOf(c, 'RECURRENCE-ID')), edit.recurrenceId)));
        if (edit.record === null) {
            if (index >= 0) calendar.subs.splice(index, 1);
        } else if (index >= 0) {
            writeEvent(calendar.subs[index], edit.record, readEvent(calendar.subs[index], book, []), now, book);
        } else {
            const event = { name: 'VEVENT', props: [], subs: [] };
            writeEvent(event, edit.record, undefined, now, book);
            calendar.subs.push(event);
        }
    }
    if (!calendar.subs.some((c) => c.name === 'VEVENT' || c.name === 'VTODO' || c.name === 'VJOURNAL')) return null;
    syncZones(calendar);
    return writeIcs(roots);
}

/** A new event uid. */
export const newUid = () => randomUUID();
