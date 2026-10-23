/**
 * What Autopilot's page shows, read from the pilot, the watcher and the
 * event log in one go (no DSH imports, so its tests run anywhere).
 *
 * @module dsh-plugin-autopilot/page
 */
import { basename } from 'node:path';
import { openWork } from './notes.js';

/** How many sessions the page lists. */
const MAX_SESSIONS = 80;

/** A log entry in a few words, for its session's row ("last: …"). */
export function lastWords(entry) {
    if (entry.kind === 'ask') return entry.state === 'answered' ? 'you answered its question' : entry.state === 'withdrawn' ? 'its question was withdrawn' : 'asked you';
    const text = String(entry.text ?? '').trim().replace(/\.$/, '');
    return text ? `${text[0].toLowerCase()}${text.slice(1)}` : '';
}

/** The sessions the page lists: not a subagent's, not a blank one. */
const listed = (row) => !row.parentSessionId && row.origin !== 'subagent' && !row.blank;

/** The row's state word: Autopilot's own hold over Session Watch's word. */
function rowWord(row, s) {
    if (s.gaveUp) return 'gave up';
    if (s.backedOff) return 'backed off';
    return row.word;
}

/** The page's view of everything Autopilot knows. */
export async function pageState({ pilot, watch, journal, config, check }) {
    const rows = await watch.list();
    const pending = pilot.pending();
    const latest = new Map();
    for (const entry of journal.list({ limit: 400 })) if (entry.sessionId && !latest.has(entry.sessionId)) latest.set(entry.sessionId, entry);
    const sessions = [];
    for (const row of rows) {
        if (!listed(row)) continue;
        if (sessions.length >= MAX_SESSIONS) break;
        const s = pilot.data.sessions[row.sessionId] ?? {};
        const last = latest.get(row.sessionId);
        const hold = pending[row.sessionId] ? undefined : pilot.holdOf?.(row);
        sessions.push({
            sessionId: row.sessionId,
            title: row.title || 'Untitled session',
            folder: row.cwd ? basename(row.cwd) : '',
            word: rowWord(row, s),
            work: openWork(row.state) || '',
            rule: pilot.ruleOf(row.sessionId),
            own: Object.hasOwn(pilot.data.rules, row.sessionId),
            updatedAt: row.updatedAt,
            ...(pending[row.sessionId] ? { next: pending[row.sessionId] } : {}),
            ...(hold ? { hold } : {}),
            ...(s.backedOff ? { backedOff: s.backedOff } : {}),
            ...(s.gaveUp ? { gaveUp: s.gaveUp } : {}),
            ...(last ? { last: { text: lastWords(last), state: last.state, at: last.at } } : {}),
        });
    }
    const hourAgo = pilot.now() - 3600000;
    const problem = check?.problem;
    const watchProblem = watch.settings?.problem;
    return {
        ...(problem ? { problem } : {}),
        ...(watchProblem ? { watchProblem } : {}),
        enabled: config.enabled !== false,
        paused: pilot.data.paused === true,
        defaultRule: pilot.defaultRule(),
        settings: {
            idleSeconds: config.idleSeconds,
            maxNotesPerHour: config.maxNotesPerHour,
            maxNudges: config.maxNudges,
            resumeWindowHours: config.resumeWindowHours,
            resumeAfterRestart: config.resumeAfterRestart !== false,
        },
        notesLastHour: pilot.data.notes.filter((at) => at > hourAgo).length,
        watching: rows.filter(listed).length,
        sessions,
        asks: (watch.asks?.() ?? []).filter((ask) => ask.source === 'Autopilot'),
        log: journal.list({ limit: 150 }),
    };
}
