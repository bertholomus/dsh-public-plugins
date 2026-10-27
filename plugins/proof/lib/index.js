/**
 * dsh-plugin-proof — claims need evidence.
 *
 * When a turn's reply says something is done, passing, fixed or deployed,
 * Proof reads what that turn ran (tool output, exit codes, test counts,
 * metric changes, file hashes) and judges the claim: shown (quiet),
 * no evidence (flagged on the turn), or contradicted by the turn's own
 * output (flagged). It does this in a session projection DSH folds over
 * every committed event (lib/projection.js), so it costs no model call
 * and the flag appears the moment the turn ends.
 *
 * Its page lists the sessions with claims and each one's whole ledger
 * (claim, evidence, verdict, check), with export as Markdown, CSV or JSON.
 * An optional independent check (lib/verifier.js) opens a short, fresh,
 * read-only thread on a cheap local model that re-runs or re-reads the
 * evidence and answers VERIFIED or NOT VERIFIED with its reason: when the
 * person presses Check (the default), by itself for each new flagged
 * claim, or never.
 *
 * It needs nothing else running. With Session Watch running, its page
 * updates through the suite's one open request per window.
 *
 * @module dsh-plugin-proof
 */
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { LIVE_SETTINGS, checkConfig, liveValues, savedEntry } from './config.js';
import { sessionRows, titleOf } from './ledger.js';
import { KEY, foldAll, proofProjection, viewOf } from './projection.js';
import { ProofRemote, SERVICE } from './remote.js';
import { CHECK_TOOLS, Verifier, effortFor, parseChecks, refusalOf } from './verifier.js';
import { working } from './page.js';
import { JsonStore } from './shared/files.js';
import { Journal } from './shared/journal.js';
import { errorText, guard } from './shared/safe.js';
import { SettingsCheck, live, liveSettings } from './shared/settings.js';

export { SETTING_TITLES, LIVE_SETTINGS, VERIFIER_CHOICES, checkConfig, changedWords } from './config.js';

export const name = 'proof';

/** DSH's session controller (sessions, the ledger, check threads) and its projections (the claims). */
export const inject = ['sessionController', 'sessionProjections'];

/**
 * Settings: their defaults here; their types and ranges in checkConfig
 * (lib/config.js). Each takes any value, so a wrong type in the profile (a
 * number in quotes, say) is said in words on Proof's page as a wrong range
 * is, instead of stopping it at start or being dropped on a live edit. The
 * live ones are on its page in Plugins and apply as soon as they are saved.
 */
export const Config = z.object({
    /** Profile only. false keeps Proof loaded but idle: it reads no claims, and its page says so. */
    enabled: z.any().default(true),
    /** Show a flag on each turn whose claim nothing in the turn shows, or its own output contradicts. */
    flags: live(z.any().default(true)),
    /** The independent check: "off", "ask" (when you press Check) or "auto" (by itself, for each new flagged claim). */
    verifier: live(z.any().default('ask')),
    /** The provider of the check model, by its id in DSH's profile. */
    verifierProvider: live(z.any().default('local-gateway')),
    /** The check model, by its id in DSH's profile: a cheap local one, asked for low effort when it offers that. */
    verifierModel: live(z.any().default('glm-5.3-flash')),
    /**
     * The longest a check may take, in minutes (1 to 60); it is stopped after that. 45 by default: a check
     * re-runs a command or two, but a busy shared gateway can take half an hour to answer (allow 60 then).
     */
    verifierMinutes: live(z.any().default(45)),
    /** The most checks that start in an hour (1 to 120); more wait their turn. */
    verifierPerHour: live(z.any().default(12)),
});

/** How Proof's own messages are marked in a session's log, as DSH marks a plugin's. */
const PLUGIN_SOURCE = Object.freeze({ kind: 'cordis-host-runner' });

export function apply(ctx, config) {
    const logger = ctx.logger;
    const settings = liveSettings(config);
    // A wrong value never stops Proof from starting: it flags and checks nothing, and its page says which setting to change.
    const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'proof', logger });
    check.run();
    const isWorking = () => working({ config: settings, check });

    // The suite's change numbers live with Session Watch; without it the page reads again every few seconds.
    let hub;
    ctx.inject(['sessionWatch'], (scope) => {
        const mine = scope.sessionWatch?.hub;
        hub = mine;
        return () => { if (hub === mine) hub = undefined; };
    });
    const bump = () => { try { hub?.bump?.('proof'); } catch { /* the page reads again later */ } };

    // Its folder in DSH's data folder, as DSH resolves it (DSH_HOME, else ~/.dsh).
    const dir = dshHomePath('proof');
    const journal = new Journal(join(dir, 'events.jsonl'), { logger, onChange: bump });
    const store = new JsonStore(join(dir, 'checks.json'), { parse: parseChecks, logger });
    const sc = ctx.sessionController;

    // DSH's session list, read at most every two seconds: the page's sessions and the titles. Each read takes an open
    // session's claims as they are now (withClaims), so a claim made since the list was read is on the page at once.
    let listed = { at: 0, items: [] };
    const listItems = async () => {
        if (Date.now() - listed.at >= 2000) {
            const result = await sc.list({}, AbortSignal.timeout(20000));
            listed = { at: Date.now(), items: Array.isArray(result?.items) ? result.items : [] };
        }
        return withClaims(listed.items);
    };

    // A session's claims on DSH's list come from DSH's cache of each session's views, written when the session last
    // saved. One saved while Proof was off (or before it was installed) has none there, and would drop off Proof's
    // page until it is opened again. Their claims are worked out here from their logs instead: on start and as the
    // list shows them, newest first, one log at a time, at most FOLD_LIMIT logs each time Proof starts.
    const FOLD_LIMIT = 200;
    const folded = new Map();
    const toFold = new Map();
    let foldBudget = FOLD_LIMIT;
    let folding = false;
    // The log being read now: a list read meanwhile does not queue it again.
    let foldingId;
    let stopped = false;
    const foldLoop = async () => {
        folding = true;
        let found = 0;
        try {
            while (toFold.size > 0 && foldBudget > 0 && !stopped) {
                const [id, updatedAt] = toFold.entries().next().value;
                toFold.delete(id);
                foldBudget -= 1;
                foldingId = id;
                try {
                    const { events } = await sc.inspect(id, AbortSignal.timeout(20000));
                    const value = viewOf(foldAll(events));
                    folded.set(id, { updatedAt, value });
                    if (value.total > 0) found += 1;
                } catch (error) {
                    folded.set(id, { updatedAt, failed: true });
                    logger.warn?.(`proof: could not read the claims of session ${id}: ${errorText(error, 160)}`);
                } finally {
                    foldingId = undefined;
                }
                if (folded.size > 2000) folded.delete(folded.keys().next().value);
                // One log at a time, with a breath between: DSH serves its window meanwhile.
                await new Promise((resolve) => { setTimeout(resolve, 25); });
            }
        } finally {
            folding = false;
            if (found > 0 && !stopped) {
                listed = { at: 0, items: [] };
                bump();
            }
        }
    };
    // DSH's list gives an open session's claims only once they are worked out (after Proof is switched back on, not
    // until the session's next event): worked out here for the open sessions still without them, and from the log
    // (above) for the others.
    const withClaims = (items) => {
        const sessions = ctx.get?.('sessions');
        const withValue = (item, value) => ({ ...item, projections: { ...item.projections, values: { ...item.projections?.values, [KEY]: value } } });
        const out = items.map((item) => {
            if (!item || typeof item.sessionId !== 'string') return item;
            try {
                // An open session's claims as they are now: DSH's list holds them as of the session's last save.
                const session = typeof sessions?.get === 'function' ? sessions.get(item.sessionId) : undefined;
                if (session && typeof ctx.sessionProjections?.snapshot === 'function') {
                    const value = ctx.sessionProjections.snapshot(session, [KEY])?.values?.[KEY];
                    return value === undefined ? item : withValue(item, value);
                }
                if (item.projections?.values?.[KEY] !== undefined) return item;
                const known = folded.get(item.sessionId);
                if (known && known.updatedAt === item.updatedAt) return known.failed ? item : withValue(item, known.value);
                if (foldBudget > 0 && !toFold.has(item.sessionId) && foldingId !== item.sessionId) toFold.set(item.sessionId, item.updatedAt);
                return item;
            } catch {
                return item;
            }
        });
        if (toFold.size > 0 && !folding && !stopped && settings.enabled !== false) void foldLoop();
        return out;
    };

    /** The tool names DSH offers a session before any restriction. */
    const toolNames = (agent) => {
        const tools = ctx.get?.('tools');
        try {
            const known = tools?.view?.(agent)?.restrictableNames;
            if (known instanceof Set) return [...known];
        } catch { /* the schemas below */ }
        try {
            return (tools?.schemas?.() ?? []).map((s) => s?.name).filter((n) => typeof n === 'string');
        } catch {
            return [];
        }
    };

    // A check thread is read-only before its first turn, and its agent is guarded each time DSH makes one.
    const ALLOWED = new Set(CHECK_TOOLS);
    const guarded = new WeakSet();
    const installCheck = (agent, cwd) => {
        if (!agent || guarded.has(agent)) return;
        const session = agent.session;
        if (!session || typeof session.append !== 'function') throw new Error('DSH gave no session to make read-only');
        const projections = ctx.sessionProjections;
        // DSH's own write paths for a session's file policy and approvals: the log keeps them for every later turn.
        if (projections.stateOf(session, 'sandboxMode') !== 'read-only') session.append('sandbox/mode', { mode: 'read-only' });
        if (projections.stateOf(session, 'permissions')?.approval !== 'never') session.append('approval/policy', { policy: 'never' });
        const scoped = agent.ctx;
        if (typeof scoped?.tools?.guard !== 'function') throw new Error('this DSH cannot guard a thread\'s tools');
        const deny = toolNames(agent).filter((n) => !ALLOWED.has(n));
        if (deny.length > 0 && typeof scoped.tools.restrict === 'function') scoped.tools.restrict({ deny });
        scoped.tools.guard((exec) => refusalOf(exec, { cwd: session.header?.cwd ?? cwd }));
        guarded.add(agent);
    };

    // The check model's names as DSH's model menu shows them (its provider's name, its model's), kept a minute.
    const names = new Map();
    const namesOf = async (provider, model) => {
        const key = `${provider}\u0000${model}`;
        const known = names.get(key);
        if (known && Date.now() - known.at < 60_000) return known.value;
        const llm = ctx.get?.('llm');
        let providerName = provider;
        let modelName = model;
        try { providerName = llm?.listProviders?.().find((p) => p?.id === provider)?.name || provider; } catch { /* its id */ }
        try { modelName = (await llm?.resolveModelInfo?.(provider, model, AbortSignal.timeout(3000)))?.name || model; } catch { /* its id */ }
        const value = { provider: providerName, model: modelName };
        names.set(key, { at: Date.now(), value });
        if (names.size > 50) names.delete(names.keys().next().value);
        return value;
    };

    const dsh = {
        inspect: (sessionId) => sc.inspect(sessionId, AbortSignal.timeout(20000)),
        namesOf,
        titles: async () => new Map((await listItems()).filter((i) => typeof i?.sessionId === 'string').map((i) => [i.sessionId, titleOf(i)])),
        titleOf: async (sessionId) => {
            let item = (await listItems()).find((i) => i?.sessionId === sessionId);
            if (!item) {
                listed = { at: 0, items: [] };
                item = (await listItems()).find((i) => i?.sessionId === sessionId);
            }
            return item ? titleOf(item) : '';
        },
        // The check model for one thread, at the lowest effort it offers (effortFor), with its names as DSH shows them.
        async resolveModel(wanted) {
            const llm = ctx.get?.('llm');
            if (typeof llm?.resolveCallConfig !== 'function') throw new Error('this DSH has no model service');
            const signal = AbortSignal.timeout(20000);
            const info = typeof llm.resolveModelInfo === 'function' ? await llm.resolveModelInfo(wanted.provider, wanted.model, signal) : undefined;
            const effort = effortFor(info);
            const r = await llm.resolveCallConfig(effort ? { ...wanted, reasoningEffort: effort } : wanted, signal);
            const effortId = r.reasoningEffort === undefined ? undefined : String(r.reasoningEffort);
            let providerName;
            try { providerName = llm.listProviders?.().find((p) => p?.id === r.provider)?.name; } catch { providerName = undefined; }
            return {
                provider: r.provider,
                model: r.model,
                ...(effortId === undefined ? {} : { reasoningEffort: effortId, effortName: info?.reasoning?.efforts?.find((e) => e?.id === effortId)?.name ?? effortId }),
                ...(providerName ? { providerName } : {}),
                ...(typeof info?.name === 'string' && info.name ? { modelName: info.name } : {}),
            };
        },
        // In the checked session's workspace, so it lists beside it; in its folder when it has no workspace.
        async createNear(sessionId, newId, cwd) {
            let workspace;
            try { workspace = ctx.get?.('workspaceRegistry')?.list?.().find((w) => w?.sessionIds?.includes?.(sessionId)); } catch { workspace = undefined; }
            await sc.create(workspace ? { sessionId: newId, workspaceId: workspace.id } : { sessionId: newId, ...(cwd ? { cwd } : {}) });
            listed = { at: 0, items: [] };
        },
        rename: (sessionId, title) => sc.rename({ sessionId, title }),
        async agentOf(sessionId) {
            const found = await sc.resolveAgent(sessionId);
            if (!found?.agent) throw new Error(found?.error?.message ?? found?.error?.code ?? 'DSH did not open the thread');
            return found.agent;
        },
        prepare: (agent, { cwd } = {}) => installCheck(agent, cwd),
        // For this thread only, as DSH's model picker does: DSH's default model is never changed.
        select(agent, selection) {
            if (typeof sc.agents?.selectForNextRequest !== 'function') throw new Error('this DSH cannot choose a model for one thread');
            sc.agents.selectForNextRequest(agent, selection);
        },
        async send(agent, text) {
            agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }));
            const sessions = ctx.get?.('sessions');
            if (typeof sessions?.flush === 'function' && agent.session && !await sessions.flush(agent.session)) throw new Error('the thread did not save the message');
        },
        cancel: (sessionId) => sc.cancel({ sessionId }),
    };

    const verifier = new Verifier({ config: settings, working: isWorking, dsh, store, journal, logger, changed: bump });

    if (settings.enabled !== false) {
        // The claims: folded by DSH over every committed event of every session.
        ctx.sessionProjections.register(proofProjection());
        // A new claim: the page moves, and with "By itself" a new flagged one is checked. Only a view that changed
        // counts: DSH may tell of every event a turn commits.
        const seen = new Map();
        const signature = (view) => `${view?.check === true ? 'check' : ''}${view?.total ?? 0}:${(view?.flagged ?? []).map((c) => c?.id).join(',')}`;
        ctx.sessionProjections.onChanged(guard(logger, 'proof: claims', (session, key, value) => {
            if (key !== KEY || typeof session?.id !== 'string') return;
            const sig = signature(value);
            if (seen.get(session.id) === sig) return;
            seen.delete(session.id);
            seen.set(session.id, sig);
            if (seen.size > 2000) seen.delete(seen.keys().next().value);
            // A session the last list read did not have (a new one): read the list again, so the page lists it.
            if (!listed.items.some((i) => i?.sessionId === session.id)) listed = { at: 0, items: [] };
            bump();
            verifier.onView(session.id, value);
        }));
        // A check thread's reply and its turn's end.
        ctx.on('session/event', guard(logger, 'proof: session event', (session, event) => verifier.onEvent(session, event)));
        // DSH makes a check thread's agent again after a restart or a while idle: guarded again.
        ctx.on('agent/created', guard(logger, 'proof: check thread', ({ agent }) => {
            if (verifier.isCheckSession(agent?.id)) installCheck(agent);
        }));
        verifier.start();
        // Sessions saved while Proof was off: their claims worked out from their logs (withClaims), soon after start.
        const timer = setTimeout(() => { listItems().catch((error) => logger.warn?.(`proof: could not read DSH's session list: ${errorText(error, 160)}`)); }, 3000);
        ctx.effect(() => () => clearTimeout(timer), 'proof: claims of sessions saved while it was off');
    }

    // Settings saved on Proof's page in Plugins: checked again, and they apply at once.
    // The live settings as they were before the next save, so its log entry says what each change was.
    let values = liveValues(settings);
    ctx.on('loader/volatile-update', guard(logger, 'proof: settings', (paths) => {
        const now = liveValues(settings);
        const entry = savedEntry(check, paths, { before: values, after: now });
        values = now;
        if (entry) journal.add(entry);
        verifier.settingsChanged();
        bump();
    }));

    const rows = async () => {
        try {
            const checkOf = (sessionId, claimId) => verifier.data.checks[`${sessionId}#${claimId}`];
            return sessionRows((await listItems()).filter((i) => !verifier.isCheckSession(i?.sessionId)), { checkOf });
        } catch (error) {
            throw new Error(`DSH's session list could not be read (${errorText(error, 160)}). Reload the page to try again.`);
        }
    };

    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new ProofRemote({ config: settings, check, verifier, journal, dsh, rows }));
    });

    ctx.effect(() => () => {
        stopped = true;
        verifier.stop();
        store.close();
    }, 'proof: checks');
}
