/**
 * dsh-plugin-decisions — one inbox for everything waiting on you.
 *
 * Every session that waits on a person shows here as a card: a reply with
 * a `DECISION NEEDED: … — recommend: …` or `BLOCKED: …` marker (or, with
 * `replies`, a plain question), a tool waiting for approval, a question in
 * DSH's question box, a coordinator thread that handed back needing a
 * decision, and the questions suite plugins raise (Autopilot's Ask first).
 * Each card says what is asked, what the agent recommends, which session
 * (one click opens it) and how long it has waited. Answering sends the
 * answer into the session: it steers a running turn, starts the next one
 * of an idle session, or settles the approval or question DSH is holding,
 * and the session's own log proves it arrived.
 *
 * A badge on the sidebar entry counts what waits; with the notifications
 * plugin running, new cards notify; an optional mirror (a webhook or a
 * command) sends a short note to wherever the person is. It reads every
 * session through Session Watch, which must run too: while Session Watch is
 * switched off, Decisions stays loaded, lists and holds nothing (DSH's own
 * cards work as always), and its page says what it needs.
 *
 * @module dsh-plugin-decisions
 */
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { Inbox, parseData } from './inbox.js';
import { LIVE_SETTINGS, WEBHOOK_KEY, checkConfig, savedEntry, settingHashes, startEntry } from './config.js';
import { Mirror } from './mirror.js';
import { DecisionsRemote, SERVICE } from './remote.js';
import { JsonStore } from './shared/files.js';
import { Journal } from './shared/journal.js';
import { errorText, guard } from './shared/safe.js';
import { SettingsCheck, live, liveSettings } from './shared/settings.js';

export { SETTING_TITLES, LIVE_SETTINGS, WEBHOOK_KEY, checkConfig, changedWords } from './config.js';

export const name = 'decisions';

/**
 * Nothing at start: Decisions waits for the session watcher inside apply, so
 * switching Session Watch off leaves Decisions loaded and idle (its page says
 * why) instead of making DSH report it as waiting for a service.
 */
export const inject = [];

/** A setting that names a key in DSH's key store, as DSH marks its own (its settings pages show whether the key is set). */
const keyRef = (schema) => (typeof schema?.role === 'function' ? schema.role('credential-ref') : schema);

/**
 * Settings: their defaults here; their types and ranges in checkConfig
 * (lib/config.js). Each takes any value, so a wrong type in the profile (a
 * number in quotes, say) is said in words on Decisions' page as a wrong range
 * is, instead of stopping it at start or being dropped on a live edit. The
 * live ones are on its page in Plugins and apply as soon as they are saved.
 */
export const Config = z.object({
    /** Profile only. false keeps Decisions loaded but idle: it lists and holds nothing, and its page says so. */
    enabled: z.any().default(true),
    /** Tools waiting for approval ("Allow once" or "Reject"). */
    approvals: live(z.any().default(true)),
    /** Questions in DSH's question box. */
    questions: live(z.any().default(true)),
    /** Replies that end with a plain question for you (DECISION NEEDED and BLOCKED lines always show). */
    replies: live(z.any().default(true)),
    /** Coordinator threads that handed back needing a decision, or blocked. */
    threads: live(z.any().default(true)),
    /** A system notification for each new card, through the notifications plugin. */
    notify: live(z.any().default(true)),
    /** How long a reply's question stays in the inbox, in hours (1 to 720). */
    windowHours: live(z.any().default(72)),
    /** Where new cards are also sent: "off", "webhook" or "command". */
    mirror: live(z.any().default('off')),
    /** The key in DSH's key store that holds the webhook address (never the address itself). */
    mirrorUrlEnv: live(keyRef(z.any()).default(WEBHOOK_KEY)),
    /** Profile only: the program's full path, then its arguments, run without a shell; the card comes as JSON on stdin. */
    mirrorCommand: z.any().default([]),
    /** The most messages sent elsewhere in an hour (1 to 500). */
    mirrorPerHour: live(z.any().default(30)),
});

export function apply(ctx, config) {
    const logger = ctx.logger;
    const settings = liveSettings(config);
    // DSH tells only Decisions' own entry when its settings are saved in Plugins, so the listener lives here and
    // hands them to the inbox while one runs.
    let onSaved;
    ctx.on('loader/volatile-update', guard(logger, 'decisions: settings', (paths) => onSaved?.(paths)));

    // Decisions works only while Session Watch runs. Switched off, the inbox stops, every held request goes back to
    // DSH's own card, and the page says why; switched on again, a new inbox starts from what Decisions saved.
    ctx.inject(['sessionWatch'], (scope) => {
        const watch = scope.sessionWatch;
        // A wrong value never stops Decisions from starting: it lists and holds nothing, and its page says which setting to change.
        const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'decisions', logger });
        check.run();
        // Its folder in DSH's data folder, as DSH resolves it (DSH_HOME, else ~/.dsh).
        const dir = dshHomePath('decisions');
        const bump = () => watch.hub?.bump?.('decisions');
        const store = new JsonStore(join(dir, 'state.json'), { parse: parseData, logger });
        const journal = new Journal(join(dir, 'events.jsonl'), { logger, onChange: bump });
        // An edit of DSH's profile restarts Decisions when it changes a setting its page cannot (DSH applies the file
        // when it is saved): the log says which settings changed, and what is wrong when one is.
        const remember = () => {
            store.data.settings = settingHashes(settings);
            store.change();
        };
        try {
            const entry = startEntry(check, store.data.settings, settingHashes(settings), settings);
            if (entry) journal.add(entry);
            remember();
        } catch (error) {
            logger?.warn?.(`decisions: could not compare its settings: ${errorText(error)}`);
        }

        // System notifications through the notifications plugin, when it runs; one that fails never stops Decisions.
        let notifications;
        scope.inject(['notifications'], (inner) => {
            const service = inner.notifications;
            notifications = service;
            return () => { if (notifications === service) notifications = undefined; };
        });
        // DSH's question service: late answers to questions whose wait ran out go through it.
        let questions;
        scope.inject(['userQuestions'], (inner) => {
            const service = inner.userQuestions;
            questions = service;
            return () => { if (questions === service) questions = undefined; };
        });
        // DSH's key store: the webhook address lives there (or in the environment DSH starts in), never in the settings file.
        let credentials;
        scope.inject(['credentials'], (inner) => {
            const service = inner.credentials;
            credentials = service;
            return () => { if (credentials === service) credentials = undefined; };
        });
        const readAddress = async () => {
            if (typeof credentials?.resolve !== 'function') throw new Error('this DSH has no key store running');
            const found = await credentials.resolve(settings.mirrorUrlEnv);
            return typeof found?.value === 'string' ? found.value : undefined;
        };

        const mirror = new Mirror({ config: settings, journal, store, logger, readAddress });
        const inbox = new Inbox({
            watch,
            config: settings,
            store,
            journal,
            logger,
            mirror,
            questions: () => questions,
            changed: bump,
            // What the notifications plugin did with it ('desktop', 'browser', 'cli', 'none' or 'off'); undefined when it is not running.
            notify: (item) => notifications?.notify?.(item),
        });
        const working = () => settings.enabled !== false && check.ok;

        if (settings.enabled !== false) {
            // First in DSH's chain for these requests, so the card shows here too. A kind switched off, a wrong
            // setting or any failure passes the request on untouched: DSH's own card works as it always does.
            const passOn = (label, kind, hold) => (request, next) => {
                try {
                    if (!working() || !inbox.started || settings[kind] === false) return next();
                    return hold(request, next);
                } catch (error) {
                    logger?.warn?.(`decisions: ${label}: ${errorText(error)}`);
                    return next();
                }
            };
            scope.on('approval/request', passOn('approval', 'approvals', (request, next) => inbox.holds.approval(request, next)), true);
            scope.on('user-questions/request', passOn('question', 'questions', (request, next) => inbox.holds.question(request, next)), true);
        }
        if (working()) inbox.start();

        // Settings saved on Decisions' page in Plugins: checked again, and they apply at once.
        const saved = (paths) => {
            const entry = savedEntry(check, paths);
            if (entry) journal.add(entry);
            remember();
            if (!working()) {
                if (inbox.started) inbox.stop();
            } else {
                // A kind switched off lets its held requests go back to DSH's own card alone.
                if (settings.approvals === false) inbox.holds.release('approval', 'kind');
                if (settings.questions === false) inbox.holds.release('question', 'kind');
                if (inbox.started) inbox.soon(0);
                else inbox.start();
            }
            bump();
        };
        onSaved = saved;

        scope.inject(['typertGateway'], (inner) => {
            inner.provide(SERVICE, new DecisionsRemote({ inbox, journal, config: settings, check, mirror, watch, notifications: () => notifications !== undefined }));
        });

        scope.effect(() => () => {
            if (onSaved === saved) onSaved = undefined;
            inbox.stop();
            store.close();
        }, 'decisions: inbox');
    });
}
