/**
 * Proof's claims ledger: every claim a session's turns made, what its turn
 * ran, the verdict, and the independent check when there was one; and the
 * ledger as Markdown, CSV or JSON to take elsewhere.
 *
 * DSH keeps each session's flagged claims in its `proofClaims` view, on
 * every row of its session list: the page's list of sessions reads that.
 * A whole ledger, quiet claims too, is folded here from the session's own
 * log when the page opens it, so it holds every claim the session made,
 * not only the last ones the view keeps. No DSH packages here, so it runs
 * in plain unit tests.
 *
 * @module dsh-plugin-proof/ledger
 */
import { INITIAL, KEY, applyEvent, flagged, parseView } from './projection.js';

/** A verdict in the words the page, the turn's flag and the export use. */
export const VERDICT_WORDS = Object.freeze({ backed: 'Shown', unbacked: 'No evidence', contradicted: 'Contradicted' });

/** An independent check's state in words. */
export const CHECK_WORDS = Object.freeze({
    queued: 'Waiting to check',
    running: 'Checking',
    verified: 'Verified',
    'not-verified': 'Not verified',
    unclear: 'Unclear',
    failed: 'Could not check',
    cancelled: 'Stopped',
});

/** The most claims one ledger holds (a session that makes more keeps its latest). */
const MAX_LEDGER = 2000;
/** Runs listed per turn. */
const MAX_RAN = 12;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A session's title from DSH's list row ('' when it has none). */
export function titleOf(item) {
    const values = isRecord(item?.projections?.values) ? item.projections.values : {};
    if (typeof values.title === 'string') return values.title;
    if (typeof values.title?.title === 'string') return values.title.title;
    return '';
}

/**
 * The sessions with claims, from DSH's session list (its `items`), the one
 * flagged last first (`at`: its latest flagged claim's time, else when the
 * session last changed): each with how many claims it made and how many are
 * flagged.
 * Proof's own check threads are left out. `checkOf(sessionId, claimId)`
 * gives a claim's independent check: a flagged claim a check verified is
 * counted as verified, not flagged.
 */
export function sessionRows(items, { limit = 300, checkOf } = {}) {
    const rows = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (!isRecord(item) || typeof item.sessionId !== 'string') continue;
        const view = parseView(item.projections?.values?.[KEY]);
        if (view.check || view.total === 0) continue;
        const verifiedNow = (c) => {
            try { return checkOf?.(item.sessionId, c.id)?.state === 'verified'; } catch { return false; }
        };
        const open = view.flagged.filter((c) => !verifiedNow(c));
        const last = open.at(-1);
        const updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : 0;
        // Its latest claim's time (a flagged claim's, which the view keeps), else when the session last changed.
        const claimedAt = view.flagged.reduce((n, c) => (Number.isFinite(c.at) && c.at > n ? c.at : n), 0);
        rows.push({
            sessionId: item.sessionId,
            title: titleOf(item),
            cwd: typeof item.cwd === 'string' ? item.cwd : '',
            updatedAt,
            at: claimedAt || updatedAt,
            running: item.running === true,
            total: view.total,
            flagged: open.length,
            contradicted: open.filter((c) => c.verdict === 'contradicted').length,
            verified: view.flagged.length - open.length,
            ...(last ? { latest: { id: last.id, turn: last.turn, verdict: last.verdict, text: last.text } } : {}),
        });
    }
    // The session flagged last listed first.
    rows.sort((a, b) => b.at - a.at || b.updatedAt - a.updatedAt);
    return rows.slice(0, limit);
}

/**
 * One session's whole ledger, folded from its log: every claim with the
 * runs of its turn (`ran`, in words) and what the person asked (`ask`).
 * `check` is true for one of Proof's own check threads (no claims).
 */
export function ledgerOf(events) {
    let state = INITIAL;
    const claims = [];
    const seen = new Set();
    for (const event of Array.isArray(events) ? events : []) {
        const before = state;
        state = applyEvent(state, event);
        if (state === before || event?.type !== 'turn/end' || !before.turn) continue;
        const fresh = state.claims.filter((c) => !seen.has(c.id));
        if (fresh.length === 0) continue;
        const ran = before.turn.items.map((i) => i.text).filter((t) => typeof t === 'string' && t).slice(-MAX_RAN);
        // A turn that ran nothing and leaned on the one before: its runs are what backed the claim.
        const prevRan = (before.prev?.items ?? []).map((i) => i.text).filter((t) => typeof t === 'string' && t).slice(-MAX_RAN);
        for (const claim of fresh) {
            seen.add(claim.id);
            claims.push({ ...claim, ran: claim.from !== undefined ? prevRan : ran, ask: before.turn.ask ?? '' });
        }
        if (claims.length > MAX_LEDGER) claims.splice(0, claims.length - MAX_LEDGER);
    }
    return { check: state.check === true, claims };
}

/**
 * How many claims of each verdict. A flagged claim an independent check
 * verified is counted apart (`verified`), not as no evidence, contradicted
 * or flagged, so the counts add up to the total.
 */
export function countsOf(claims) {
    const counts = { total: 0, backed: 0, verified: 0, unbacked: 0, contradicted: 0, flagged: 0 };
    for (const c of claims ?? []) {
        counts.total += 1;
        if (isVerified(c)) {
            counts.verified += 1;
            continue;
        }
        if (c.verdict === 'backed' || c.verdict === 'unbacked' || c.verdict === 'contradicted') counts[c.verdict] += 1;
        if (flagged(c)) counts.flagged += 1;
    }
    return counts;
}

/** A claim Proof flagged that its independent check verified. */
export const isVerified = (claim) => flagged(claim) && claim?.check?.state === 'verified';

/** One claim with its check (by claim id), as the page and the export list it. */
export function withChecks(claims, checks) {
    const byClaim = new Map((checks ?? []).map((c) => [c.claimId, c]));
    return (claims ?? []).map((c) => {
        const check = byClaim.get(c.id);
        return check ? { ...c, check } : c;
    });
}

// ── Export ──────────────────────────────────────────────────────────

const FORMATS = Object.freeze({
    md: { ext: 'md', type: 'text/markdown' },
    csv: { ext: 'csv', type: 'text/csv' },
    json: { ext: 'json', type: 'application/json' },
});

/** The formats an export can take. */
export const EXPORT_FORMATS = Object.freeze(Object.keys(FORMATS));

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** The local day, as the person's calendar has it: an export made at 11 PM is named for that day, not tomorrow's. */
const day = (at) => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const when = (at) => (Number.isFinite(at) && at > 0 ? new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') : '');

/** A check in words: "Verified: re-ran npm test, 42 passed." */
function checkText(check) {
    if (!check) return '';
    const word = CHECK_WORDS[check.state] ?? check.state;
    return check.reason ? `${word}: ${oneLine(check.reason)}` : word;
}

/** A file name for an export: the session's title (or id), the day, the format. */
export function exportName(session, format, now = Date.now()) {
    const slug = oneLine(session?.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
        || String(session?.id ?? 'session').replace(/^session-/, '').slice(0, 8);
    return `proof-ledger-${slug}-${day(now)}.${FORMATS[format]?.ext ?? 'txt'}`;
}

/** A Markdown table cell: one line, its pipes escaped. */
const mdCell = (s) => oneLine(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|') || '—';

function markdown(session, claims, now) {
    const counts = countsOf(claims);
    const lines = [
        `# Claims ledger: ${oneLine(session.title) || session.id}`,
        '',
        `Session \`${session.id}\`${session.cwd ? ` in \`${session.cwd}\`` : ''}. Exported ${when(now)}.`,
        '',
        `${counts.total} claim${counts.total === 1 ? '' : 's'}: ${counts.backed} shown by their turn, ${counts.verified ? `${counts.verified} verified by an independent check, ` : ''}${counts.unbacked} with no evidence, ${counts.contradicted} contradicted by their turn's own output.`,
        '',
    ];
    if (claims.length === 0) {
        lines.push('This session has made no claim of done, passed, fixed or deployed yet.');
        return `${lines.join('\n')}\n`;
    }
    lines.push('| Turn | Claim | Verdict | Why | Evidence | Independent check |', '| --- | --- | --- | --- | --- | --- |');
    for (const c of claims) {
        const evidence = c.evidence?.length ? c.evidence.join('; ') : '';
        lines.push(`| ${c.turn} | ${mdCell(c.text)} | ${VERDICT_WORDS[c.verdict] ?? c.verdict} | ${mdCell(c.why)} | ${mdCell(evidence)} | ${mdCell(checkText(c.check))} |`);
    }
    return `${lines.join('\n')}\n`;
}

/**
 * A CSV field (RFC 4180): quoted when it holds a quote, a comma or a line
 * break. A field a spreadsheet would read as a formula (it starts with
 * = + - @, a tab or a carriage return) gets a leading apostrophe first.
 */
export function csvField(value) {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = ['session', 'title', 'turn', 'claimed_at', 'kind', 'claim', 'verdict', 'why', 'evidence', 'ran', 'check', 'check_reason', 'checked_at'];

function csv(session, claims) {
    const rows = [CSV_COLUMNS.join(',')];
    for (const c of claims) {
        rows.push([
            session.id, session.title ?? '', c.turn, when(c.at), c.kind, c.text, VERDICT_WORDS[c.verdict] ?? c.verdict, c.why,
            (c.evidence ?? []).join('; '), (c.ran ?? []).join('; '),
            c.check ? CHECK_WORDS[c.check.state] ?? c.check.state : '', c.check?.reason ?? '', when(c.check?.endedAt),
        ].map(csvField).join(','));
    }
    return `${rows.join('\r\n')}\r\n`;
}

function json(session, claims, now) {
    return `${JSON.stringify({
        session: { id: session.id, title: session.title ?? '', cwd: session.cwd ?? '' },
        exportedAt: when(now),
        counts: countsOf(claims),
        claims: claims.map((c) => ({
            id: c.id,
            turn: c.turn,
            claimedAt: when(c.at),
            kind: c.kind,
            claim: c.text,
            verdict: c.verdict,
            why: c.why,
            evidence: c.evidence ?? [],
            ran: c.ran ?? [],
            ...(c.from !== undefined ? { evidenceFromTurn: c.from } : {}),
            ...(c.check ? {
                check: {
                    state: c.check.state,
                    reason: c.check.reason ?? '',
                    model: c.check.model ?? '',
                    by: c.check.by ?? '',
                    checkSession: c.check.checkSessionId ?? '',
                    startedAt: when(c.check.startedAt),
                    endedAt: when(c.check.endedAt),
                },
            } : {}),
        })),
    }, null, 2)}\n`;
}

/**
 * A ledger as a file: `{ name, type, text }`.
 * @param {{ id: string, title?: string, cwd?: string }} session
 * @param {object[]} claims - the ledger's claims, each with its check when it has one (withChecks).
 * @param {'md'|'csv'|'json'} format
 */
export function exportLedger(session, claims, format, now = Date.now()) {
    const spec = FORMATS[format];
    if (!spec) throw new Error(`Export as Markdown (md), CSV (csv) or JSON (json), not ${JSON.stringify(String(format)).slice(0, 40)}.`);
    const list = Array.isArray(claims) ? claims : [];
    const text = format === 'md' ? markdown(session, list, now) : format === 'csv' ? csv(session, list) : json(session, list, now);
    return { name: exportName(session, format, now), type: spec.type, text };
}
