/**
 * dsh-plugin-canon — shared long-term memory from an Obsidian canon vault.
 *
 * Recall: before a turn that starts from a person's new prompt, Canon
 * searches the vault's active notes for the prompt and the session's
 * folder, and adds the few that fit as one short block after the prompt,
 * each cited by its path in the vault (lib/recall.js). It is bounded (a
 * few notes, a few thousand characters), kept in the session's log as
 * Canon's context (DSH's Trajectory tab lists it; its Chat shows Canon's
 * card after the turn instead), and can be turned off for one session from
 * the card or from Canon's page.
 *
 * Capture: while the settings allow drafts, agents get a `canon_capture`
 * tool that saves a note as a DRAFT (`status: draft`, its kind, where it
 * came from) in the drafts folder, never anywhere else and never over a
 * note (lib/drafts.js). Drafts are never added to turns. A person promotes
 * one on Canon's page, and only while the settings allow promoting.
 *
 * Canon reads the vault and, by default, writes nothing. It needs nothing
 * else running; with Session Watch, its page updates through the suite's
 * one open request per window.
 *
 * @module dsh-plugin-canon
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { LIVE_SETTINGS, checkConfig, displayPath, resolved, savedEntry } from './config.js';
import { capture, promote } from './drafts.js';
import { Switches, parseSwitches, working } from './page.js';
import { KEY, canonProjection } from './projection.js';
import { Recall } from './recall.js';
import { CanonRemote, SERVICE } from './remote.js';
import { captureTool } from './tools.js';
import { Vault } from './vault.js';
import { JsonStore } from './shared/files.js';
import { Journal } from './shared/journal.js';
import { errorText, guard } from './shared/safe.js';
import { SettingsCheck, live, liveSettings } from './shared/settings.js';

export { SETTING_TITLES, LIVE_SETTINGS, ACCESS_CHOICES, DEFAULTS, checkConfig, changedWords } from './config.js';

export const name = 'canon';

/** DSH's session controller (session titles for the page) and its projections (the card after a turn). */
export const inject = ['sessionController', 'sessionProjections'];

/**
 * Settings: their defaults here; their types and ranges in checkConfig
 * (lib/config.js). Each takes any value, so a wrong type in the profile (a
 * number in quotes, say) is said in words on Canon's page as a wrong range
 * is, instead of stopping Canon at start or being dropped on a live edit.
 * The live ones are on its page in Plugins and apply as soon as they are
 * saved.
 */
export const Config = z.object({
    /** Profile only. false keeps Canon loaded but idle: it reads no vault, and its page says so. */
    enabled: z.any().default(true),
    /** The Obsidian vault's folder: a full path, or one starting with ~/. Empty: Canon does nothing until it is set. */
    vault: live(z.any().default('')),
    /** What Canon may write: "read-only" (nothing) or "drafts" (new draft notes in the drafts folder). */
    access: live(z.any().default('read-only')),
    /** The folder inside the vault where drafts go; its notes are never added to turns. */
    draftsFolder: live(z.any().default('Drafts')),
    /** Whether a person may promote a draft to an active note from Canon's page (needs access "drafts" too). */
    promote: live(z.any().default(false)),
    /** Where promoted notes go, inside the vault: empty for its top level. */
    promoteFolder: live(z.any().default('')),
    /** Add the notes that fit to each turn that starts from a person's prompt. */
    recall: live(z.any().default(true)),
    /** The most notes a turn gets (1 to 10). */
    maxNotes: live(z.any().default(3)),
    /** The most characters a turn's block may have (400 to 8000). */
    maxChars: live(z.any().default(2000)),
});

export function apply(ctx, config) {
    const logger = ctx.logger;
    const settings = liveSettings(config);
    const home = homedir();
    let dshHome;
    try { dshHome = resolveDshHome(); } catch { dshHome = undefined; }
    // A wrong value never stops Canon from starting: it adds and writes nothing, and its page says which setting to change.
    const check = new SettingsCheck({ settings, check: (s) => checkConfig(s, { home, dshHome }), liveKeys: LIVE_SETTINGS, label: 'canon', logger });
    check.run();
    const isWorking = () => working({ config: settings, check });
    const current = () => resolved(settings, home);

    // The suite's change numbers live with Session Watch; without it the page reads again every few seconds.
    let hub;
    ctx.inject(['sessionWatch'], (scope) => {
        const mine = scope.sessionWatch?.hub;
        hub = mine;
        return () => { if (hub === mine) hub = undefined; };
    });
    const bump = () => { try { hub?.bump?.('canon'); } catch { /* the page reads again later */ } };

    // Its folder in DSH's data folder, as DSH resolves it (DSH_HOME, else ~/.dsh).
    const dir = dshHomePath('canon');
    const events = new Journal(join(dir, 'events.jsonl'), { logger, onChange: bump });
    const recalls = new Journal(join(dir, 'recall.jsonl'), { logger, onChange: bump, keep: 300 });
    const store = new JsonStore(join(dir, 'state.json'), { parse: parseSwitches, logger });
    const switches = new Switches(store);

    // The vault Canon reads now: none while it is off or a setting is wrong.
    const where = () => {
        if (!isWorking()) return { vault: '', draftsFolder: '' };
        const s = current();
        return { vault: s.vault, draftsFolder: s.draftsFolder };
    };
    const vault = new Vault({
        where,
        logger,
        home,
        onChange: guard(logger, 'canon: vault', ({ kind, before, after }) => {
            // Problems with the folder, and the read after one, go in the log once each.
            if (kind === 'error') {
                events.add({ kind: 'vault', state: 'failed', text: 'Couldn\'t read the vault', why: after.error?.text ?? '' });
            } else if (kind === 'ok' && before?.state === 'error') {
                events.add({ kind: 'vault', state: 'done', text: 'Reading the vault again', why: `${after.counts.active} active note${after.counts.active === 1 ? '' : 's'}, ${after.counts.drafts} draft${after.counts.drafts === 1 ? '' : 's'}.` });
            }
            bump();
        }),
    });

    const stateOf = (session, key) => {
        try { return ctx.sessionProjections?.stateOf?.(session, key); } catch { return undefined; }
    };

    const recall = new Recall({
        vault,
        settings: current,
        working: isWorking,
        isOff: (sessionId) => switches.isOff(sessionId),
        makeMessage: (text, source) => createUserMessage({ content: [{ type: 'text', text }], source }),
        onRecall: ({ sessionId, turn, block, boosted }) => {
            recalls.add({
                kind: 'recall',
                sessionId,
                ...(turn !== undefined ? { turn } : {}),
                notes: block.notes,
                chars: block.chars,
                text: `Added ${block.notes.length} note${block.notes.length === 1 ? '' : 's'}${turn !== undefined ? ` to turn ${turn}` : ''}`,
                why: block.notes.map((n) => n.path).join(', '),
                ...(boosted.length ? { boosted } : {}),
            });
        },
        logger,
    });

    /** The capture tool's work: check, write the draft, log it. */
    const save = async (args, exec) => {
        const session = exec?.agent?.session;
        const sessionId = typeof session?.id === 'string' ? session.id : undefined;
        const folder = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
        const turnNow = stateOf(session, KEY)?.turn;
        const turn = Number.isSafeInteger(turnNow) && turnNow > 0 ? turnNow : undefined;
        const title = typeof args?.title === 'string' ? args.title.slice(0, 120) : '';
        const refuse = (reason) => {
            events.add({ kind: 'capture', state: 'refused', sessionId, ...(turn !== undefined ? { turn } : {}), text: 'Draft not saved', why: `${title ? `“${title}”: ` : ''}${reason[0].toUpperCase()}${reason.slice(1)}` });
            return { text: `Not saved: ${reason}`, view: { kind: 'canon-capture', ok: false, reason } };
        };
        if (!isWorking()) return refuse('Canon is waiting for a setting to be fixed. A person can see which on Canon\'s page.');
        if (stateOf(session, 'sandboxMode') === 'read-only') return refuse('this session is Read Only, so Canon saves nothing from it.');
        const result = await capture({ settings: current(), note: args, from: { sessionId, turn, folder }, home });
        if (!result.ok) return refuse(result.reason);
        events.add({ kind: 'capture', state: 'done', sessionId, ...(turn !== undefined ? { turn } : {}), path: result.path, text: `Draft saved: “${result.title}”`, why: `A ${result.kind} note in ${result.path}. It waits for a person to promote it.` });
        void vault.again();
        return {
            text: `Saved a draft to the canon vault: ${result.path}. It is a draft: Canon adds it to no turn until a person promotes it on Canon's page.`,
            view: { kind: 'canon-capture', ok: true, path: result.path, title: result.title, noteKind: result.kind },
        };
    };

    // The capture tool, offered only while Canon may write drafts (the model never sees a tool it cannot use).
    let syncTool = () => {};
    if (settings.enabled !== false) {
        // Which turn of each session Canon added notes to, for the card after it.
        ctx.sessionProjections.register(canonProjection());
        // Before each step: the notes that fit a person's new prompt.
        ctx.on('agent/pre-step', recall.handler);
        ctx.inject(['tools'], (scope) => {
            let offTool;
            syncTool = () => {
                const s = current();
                const want = isWorking() && Boolean(s.vault) && s.access === 'drafts';
                if (want && !offTool) {
                    try {
                        offTool = scope.tools.register(captureTool(save));
                    } catch (error) {
                        logger?.warn?.(`canon: could not offer canon_capture: ${errorText(error)}`);
                    }
                } else if (!want && offTool) {
                    try { offTool(); } catch { /* DSH took it down already */ }
                    offTool = undefined;
                }
            };
            syncTool();
            return () => {
                syncTool = () => {};
                if (offTool) {
                    try { offTool(); } catch { /* DSH took it down already */ }
                    offTool = undefined;
                }
            };
        });
        void vault.refresh();
    }

    // Settings saved on Canon's page in Plugins: checked again, and they apply at once.
    ctx.on('loader/volatile-update', guard(logger, 'canon: settings', (paths) => {
        const entry = savedEntry(check, paths);
        if (entry) events.add(entry);
        if (settings.enabled !== false) {
            vault.settingsChanged();
            syncTool();
        }
        bump();
    }));

    // DSH's session list, read at most every two seconds (sooner for a session it did not list yet): the page's titles.
    const sc = ctx.sessionController;
    let listed = { at: 0, items: [], ids: new Set() };
    /** Sessions the last read did not list (gone, or another computer's): no reason to read again before two seconds. */
    const unlisted = new Set();
    const titleIn = (value) => (typeof value === 'string' ? value : typeof value?.title === 'string' ? value.title : '');
    // DSH works a session's title out lazily: an open session's list row can lack it until something has looked.
    const openTitle = (sessionId) => {
        try {
            const session = ctx.get?.('sessions')?.get?.(sessionId);
            return session ? titleIn(ctx.sessionProjections?.snapshot?.(session, ['title'])?.values?.title) : '';
        } catch {
            return '';
        }
    };
    const readList = async () => {
        try {
            const result = await sc.list({}, AbortSignal.timeout(20000));
            const items = Array.isArray(result?.items) ? result.items : [];
            listed = { at: Date.now(), items, ids: new Set(items.map((item) => item?.sessionId)) };
        } catch (error) {
            logger?.warn?.(`canon: session titles: ${errorText(error)}`);
        }
    };
    /** The sessions DSH still has, by id, with their titles ('' for none); a session DSH no longer has is left out. */
    const titles = async (ids) => {
        const out = new Map();
        if (!ids.length) return out;
        const newcomer = ids.some((id) => !listed.ids.has(id) && !unlisted.has(id));
        if (Date.now() - listed.at > 2000 || newcomer) {
            await readList();
            for (const id of [...unlisted]) if (listed.ids.has(id)) unlisted.delete(id);
            if (unlisted.size > 2000) unlisted.clear();
            for (const id of ids) if (!listed.ids.has(id)) unlisted.add(id);
        }
        const wanted = new Set(ids);
        for (const item of listed.items) {
            if (!wanted.has(item?.sessionId)) continue;
            out.set(item.sessionId, titleIn(item.projections?.values?.title) || openTitle(item.sessionId));
        }
        return out;
    };

    const parts = {
        config: settings,
        check,
        current,
        vault,
        events,
        recalls,
        switches,
        titles,
        async setSession(sessionId, on) {
            const changed = switches.set(sessionId, on);
            if (changed) {
                const title = (await titles([sessionId])).get(sessionId) ?? '';
                events.add({
                    kind: 'session',
                    state: 'done',
                    sessionId,
                    text: on ? 'Notes turned back on for a session' : 'Notes turned off for a session',
                    why: on ? `Canon adds notes to ${title ? `“${title}”` : 'this session'} again.` : `Canon adds nothing to ${title ? `“${title}”` : 'this session'} until it is turned back on.`,
                });
            }
            bump();
            return { sessionId, off: switches.isOff(sessionId), changed };
        },
        async promote(path) {
            const result = await promote({ settings: current(), path });
            if (!result.ok) {
                events.add({ kind: 'promote', state: 'refused', text: 'Not promoted', why: `${path}: ${result.reason[0].toUpperCase()}${result.reason.slice(1)}` });
                throw new Error(`Not promoted: ${result.reason}`);
            }
            events.add({ kind: 'promote', state: 'done', path: result.path, text: 'Draft promoted to an active note', why: `${result.from} is now ${result.path}, with status: active. Canon adds it to turns from now on.` });
            await vault.again();
            return result;
        },
        home,
        /** The try-out: what a turn in a session in `folder` (a full path, or '') gets, and the folder in words. */
        preview: async (text, folder) => ({ ...(await recall.preview(text, folder)), place: displayPath(folder, home) }),
        async refresh() {
            await vault.again();
            return vault.status();
        },
    };

    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new CanonRemote(parts));
    });

    ctx.effect(() => () => {
        store.close();
    }, 'canon: state');
}
