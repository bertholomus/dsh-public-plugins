/**
 * What Proof's page and its flags read, in one go (no DSH packages, so its
 * tests run anywhere).
 *
 * @module dsh-plugin-proof/page
 */
import { countsOf, ledgerOf, withChecks } from './ledger.js';

/** Log entries the page's history lists, newest first. */
const HISTORY = 150;

/** Whether Proof works now: switched on in the profile, and every setting right. */
export const working = ({ config, check }) => config.enabled !== false && (check?.ok ?? true);

/** The check model's names as DSH's model menu shows them, else as the settings name them. */
async function namesOf(config, dsh) {
    try {
        const named = await dsh?.namesOf?.(config.verifierProvider, config.verifierModel);
        if (named && typeof named.provider === 'string' && typeof named.model === 'string') return named;
    } catch { /* the names as set */ }
    return { provider: config.verifierProvider, model: config.verifierModel };
}

/** The independent check's settings and how much of its hour is used. */
function verifierState(config, verifier, names) {
    const budget = verifier.budget();
    return {
        mode: verifier.mode,
        provider: config.verifierProvider,
        model: config.verifierModel,
        providerName: names.provider,
        modelName: names.model,
        minutes: config.verifierMinutes,
        perHour: config.verifierPerHour,
        used: budget.used,
        nextAt: budget.nextAt,
    };
}

/** Session titles by id, from DSH's list (every session, not only those with claims). */
async function titlesOf(dsh) {
    try {
        const titles = await dsh?.titles?.();
        return titles instanceof Map ? titles : new Map();
    } catch {
        return new Map();
    }
}

/**
 * Everything the page shows. `rows()` reads the sessions with claims (DSH's
 * list). Each check and each log entry carries its session's title, so a
 * session that is not on the list of sessions with claims is still named.
 */
export async function pageState({ config, check, verifier, journal, rows, dsh }) {
    const problem = check?.problem;
    const on = working({ config, check });
    const [names, titles, sessions] = await Promise.all([namesOf(config, dsh), titlesOf(dsh), on ? rows() : []]);
    const titled = (entry) => (entry.sessionId && titles.has(entry.sessionId) ? { ...entry, title: titles.get(entry.sessionId) } : entry);
    return {
        ...(problem ? { problem } : {}),
        enabled: config.enabled !== false,
        flags: config.flags !== false,
        verifier: verifierState(config, verifier, names),
        sessions,
        checks: verifier.recent(40).map(titled),
        history: journal.list({ limit: HISTORY }).map(titled),
    };
}

/**
 * What one session's flags need: whether to show them, how checks run, and
 * the session's checks. In one of Proof's check threads, `checkOf` says
 * what it checks: the claim, the session it came from, and the answer.
 */
export async function sessionState({ config, check, verifier, dsh }, sessionId) {
    const on = working({ config, check });
    const of = verifier.checkOf(sessionId);
    let checkOf;
    if (of) {
        let title = '';
        try { title = (await dsh?.titleOf?.(of.sessionId)) ?? ''; } catch { title = ''; }
        checkOf = {
            sessionId: of.sessionId, turn: of.turn, claim: of.claim, state: of.state, reason: of.reason ?? '', model: of.model ?? '', title,
            ...(of.minutes ? { minutes: of.minutes } : {}), ...(of.effort ? { effort: of.effort } : {}),
            ...(of.startedAt ? { startedAt: of.startedAt } : {}), ...(of.endedAt ? { endedAt: of.endedAt } : {}),
        };
    }
    return {
        on,
        flags: on && config.flags !== false,
        verifier: on ? verifier.mode : 'off',
        isCheck: verifier.isCheckSession(sessionId),
        ...(checkOf ? { checkOf } : {}),
        checks: verifier.checksFor(sessionId).slice(0, 60),
    };
}

/**
 * One session's whole ledger: its claims (folded from its log), each with
 * its check, the counts, and the session's title and folder.
 * @param {{ inspect: (id: string) => Promise<{ meta: object, events: object[] }>, titleOf: (id: string) => Promise<string> }} dsh
 */
export async function ledgerState({ dsh, verifier }, sessionId) {
    const { meta, events } = await dsh.inspect(sessionId);
    const { check, claims } = ledgerOf(events);
    const all = withChecks(claims, verifier.checksFor(sessionId));
    let title = '';
    try { title = (await dsh.titleOf(sessionId)) ?? ''; } catch { title = ''; }
    return {
        session: { id: sessionId, title, cwd: typeof meta?.cwd === 'string' ? meta.cwd : '' },
        isCheck: check || verifier.isCheckSession(sessionId),
        counts: countsOf(all),
        claims: all,
    };
}
