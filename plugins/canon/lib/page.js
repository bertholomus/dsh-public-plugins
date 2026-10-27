/**
 * What Canon's page and its card after a turn read, in one go, and the
 * per-session switches (no DSH packages, so its tests run anywhere).
 *
 * @module dsh-plugin-canon/page
 */
import { RANGES, alsoWrong, unquoted } from './config.js';

/** Log entries the page's history lists, newest first. */
const HISTORY = 150;
/** Sessions the page's "Recent recall" lists, and recalls per session. */
const SESSIONS = 30;
const PER_SESSION = 3;
/** Sessions whose switch is kept, at most. */
const MAX_SWITCHES = 5000;
/** Folders inside the vault kept by name (vault.js's MAX_CLOSED_NAMED). */
const MAX_CLOSED = 20;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether Canon works now: switched on in the profile, and every setting right. */
export const working = ({ config, check }) => config.enabled !== false && (check?.ok ?? true);

/** The switches as stored: `{ v: 1, off: { [sessionId]: at } }`; anything else starts empty. */
export function parseSwitches(value) {
    const off = {};
    let closed;
    if (isRecord(value) && value.v === 1) {
        if (isRecord(value.off)) {
            for (const [id, at] of Object.entries(value.off).slice(-MAX_SWITCHES)) {
                if (id && id.length <= 200 && Number.isFinite(at)) off[id] = at;
            }
        }
        // The folders inside the vault What happened named last, so a restart names none of them again.
        const c = value.closed;
        if (isRecord(c) && typeof c.vault === 'string' && Array.isArray(c.names) && Number.isSafeInteger(c.count) && c.count >= 0) {
            closed = { vault: c.vault.slice(0, 4096), names: c.names.filter((n) => typeof n === 'string').slice(0, MAX_CLOSED).map((n) => n.slice(0, 1000)), count: c.count };
        }
    }
    return { v: 1, off, ...(closed ? { closed } : {}) };
}

/** Recall switched off for single sessions, kept across restarts (a JsonStore of parseSwitches). */
export class Switches {
    /** @param {import('./shared/files.js').JsonStore} store */
    constructor(store, now = Date.now) {
        this.store = store;
        this.now = now;
    }

    isOff(sessionId) {
        return Object.hasOwn(this.store.data.off, sessionId);
    }

    /** Turn recall on or off for a session: whether that changed anything. */
    set(sessionId, on) {
        const off = this.store.data.off;
        if (on === !Object.hasOwn(off, sessionId)) return false;
        if (on) delete off[sessionId];
        else {
            off[sessionId] = this.now();
            const ids = Object.keys(off);
            if (ids.length > MAX_SWITCHES) delete off[ids[0]];
        }
        this.store.change();
        return true;
    }

    /** The sessions switched off, newest first. */
    list() {
        return Object.entries(this.store.data.off).sort((a, b) => b[1] - a[1]).map(([sessionId, at]) => ({ sessionId, at }));
    }
}

/**
 * The sessions Canon added notes to, newest first, each with its last few
 * recalls, from the recall log; and the sessions switched off.
 * @param {object[]} entries - the recall log, newest first.
 * @param {Switches} switches
 */
export function recentSessions(entries, switches) {
    const bySession = new Map();
    for (const e of entries) {
        if (!isRecord(e) || typeof e.sessionId !== 'string') continue;
        let row = bySession.get(e.sessionId);
        if (!row) {
            if (bySession.size >= SESSIONS) continue;
            row = { sessionId: e.sessionId, at: e.at, count: 0, recalls: [] };
            bySession.set(e.sessionId, row);
        }
        row.count += 1;
        if (row.recalls.length < PER_SESSION) row.recalls.push({ turn: e.turn, at: e.at, notes: Array.isArray(e.notes) ? e.notes : [] });
    }
    const rows = [...bySession.values()].map((row) => ({ ...row, off: switches.isOff(row.sessionId) }));
    const listed = new Set(rows.map((r) => r.sessionId));
    const offOnly = switches.list().filter((s) => !listed.has(s.sessionId)).slice(0, SESSIONS).map((s) => ({ sessionId: s.sessionId, at: s.at, count: 0, recalls: [], off: true }));
    return [...rows, ...offOnly];
}

/** The settings as the page shows them. */
function settingsOf(config, current) {
    return {
        vault: current.vault,
        access: current.access,
        draftsFolder: current.draftsFolder,
        promote: current.promote,
        promoteFolder: current.promoteFolder,
        recall: current.recall,
        maxNotes: current.maxNotes,
        maxChars: current.maxChars,
        ranges: RANGES,
    };
}

/** The newest drafts that name the active notes on their subject (one search each). */
const RELATED_DRAFTS = 30;

/**
 * Everything the page shows.
 * @param {object} parts
 * @param {object} parts.config - Canon's live settings.
 * @param {object} parts.check - its SettingsCheck.
 * @param {() => object} parts.current - the settings as Canon uses them (config.js resolved).
 * @param {import('./vault.js').Vault} parts.vault
 * @param {import('./shared/journal.js').Journal} parts.events
 * @param {import('./shared/journal.js').Journal} parts.recalls
 * @param {Switches} parts.switches
 * @param {(ids: string[]) => Promise<Map<string, string>>} parts.titles - the sessions DSH still has, with their titles.
 */
export async function pageState({ config, check, current, vault, events, recalls, switches, titles }) {
    const on = working({ config, check });
    // A number or true/false in quotes that would be right without them: the page offers to save it so.
    const fix = check?.problem?.live && check.problem.key ? unquoted(config, check.problem.key) : undefined;
    // Every wrong setting is named: the first, and the others after it.
    const also = check?.problem ? alsoWrong(check) : [];
    const problem = check?.problem && { ...check.problem, ...(fix === undefined ? {} : { unquoted: fix }), ...(also.length ? { also } : {}) };
    const sessions = on ? recentSessions(recalls.list({ limit: 300 }), switches) : [];
    const drafts = on ? vault.drafts() : [];
    const history = events.list({ limit: HISTORY });
    const named = (id) => typeof id === 'string' && id !== '';
    const ids = [...new Set([...sessions.map((s) => s.sessionId), ...drafts.map((d) => d.sessionId), ...history.map((e) => e.sessionId)].filter(named))];
    let names = new Map();
    try { names = (await titles(ids)) ?? new Map(); } catch { names = new Map(); }
    return {
        ...(problem ? { problem } : {}),
        enabled: config.enabled !== false,
        settings: settingsOf(config, current()),
        vault: on ? vault.status() : { state: 'unset', counts: { notes: 0, active: 0, drafts: 0, other: 0, unreadable: 0, closed: 0 }, closed: [] },
        sessions: sessions.map((s) => ({ ...s, title: names.get(s.sessionId) ?? '' })),
        // A draft from a session DSH no longer has (or another computer's) names it without a way to open it.
        // The newest drafts also name the active notes on the same subject, for a person to read before Promote.
        drafts: drafts.map((d, i) => ({ ...d, related: i < RELATED_DRAFTS && typeof vault.related === 'function' ? vault.related(d) : [], sessionTitle: d.sessionId ? names.get(d.sessionId) ?? '' : '', sessionKnown: Boolean(d.sessionId) && names.has(d.sessionId) })),
        // Each entry names its session as DSH does now (its title), and says whether DSH still has it.
        history: history.map((e) => (named(e.sessionId) ? { ...e, sessionTitle: names.get(e.sessionId) ?? '', sessionKnown: names.has(e.sessionId) } : e)),
    };
}

/**
 * What one session's card needs: whether Canon adds notes here, and why
 * not when it does not.
 */
export function sessionState({ config, check, current, vault, switches }, sessionId) {
    const on = working({ config, check });
    const s = current();
    const state = on ? vault.status().state : 'unset';
    const off = switches.isOff(sessionId);
    let why = '';
    if (config.enabled === false) why = 'Canon is switched off in DSH\'s profile.';
    else if (!on) why = 'Canon is waiting for a setting to be fixed: see its page.';
    else if (!s.vault) why = 'No vault is set yet: set one in Canon\'s settings.';
    else if (!s.recall) why = 'Adding notes to turns is off in Canon\'s settings.';
    else if (state === 'error') why = 'Canon cannot read the vault now: see its page.';
    return { on: on && Boolean(s.vault) && s.recall && state !== 'error', off, why, access: s.access };
}
