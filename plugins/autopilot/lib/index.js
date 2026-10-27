/**
 * dsh-plugin-autopilot — keeps sessions moving when nobody is watching.
 *
 * After a DSH restart it finds the sessions whose turn the stop cut off and
 * tells them to carry on; it nudges a session that went idle with open
 * todos (once, then backs off when nudges bring no progress); and it starts
 * a goal again after an error stopped it. Every action waits for proof from
 * the session's own log, and the event log says what it did and why.
 * Per-session rules (Auto, Ask first, Off) and a kill switch live on its
 * page in DSH's sidebar (lib/client.js).
 *
 * It reads sessions through the session watcher (plugins/session-watch),
 * which must run too: while Session Watch is switched off, Autopilot stays
 * loaded and does nothing, and its page says what it needs. With the
 * notifications plugin it also says, outside the window, when it backs off
 * or asks something.
 *
 * @module dsh-plugin-autopilot
 */
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { Pilot, parseData } from './pilot.js';
import { AutopilotRemote, SERVICE } from './remote.js';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { JsonStore } from './shared/files.js';
import { Journal } from './shared/journal.js';
import { errorText, guard } from './shared/safe.js';
import { SettingsCheck, live, liveSettings } from './shared/settings.js';
import { LIVE_SETTINGS, SETTING_TITLES, checkConfig, savedEntry } from './config.js';

export { SETTING_TITLES, LIVE_SETTINGS, checkConfig, changedWords } from './config.js';

export const name = 'autopilot';

/** Whether a pilot has started in this process yet: the first one, soon after DSH starts, starts with DSH. */
let firstStart = true;
/** How long after DSH's process starts a first pilot still counts as starting with DSH, in seconds. */
const WITH_DSH_SECONDS = 180;

/**
 * Nothing at start: Autopilot waits for the session watcher inside apply, so
 * switching Session Watch off leaves Autopilot loaded and idle (its page says
 * why) instead of making DSH report it as waiting for a service.
 */
export const inject = [];

/**
 * Settings: their defaults here; their types and ranges in checkConfig
 * (lib/config.js). Each takes any value, so a wrong type in the profile (a
 * number in quotes, say) is said in words on Autopilot's page as a wrong range
 * is, instead of stopping it at start or being dropped on a live edit. The
 * live ones are on its page in Plugins and apply as soon as they are saved.
 */
export const Config = z.object({
    /** Profile only. false keeps Autopilot loaded but idle; the switch in Plugins unloads it instead. */
    enabled: z.any().default(true),
    /** The rule for sessions without their own until the page sets one: "auto", "ask" or "off". */
    defaultRule: z.any().default('auto'),
    /** After a DSH restart, tell the sessions it cut off to carry on. */
    resumeAfterRestart: live(z.any().default(true)),
    /** Only sessions cut off within this many hours are resumed (1 to 168). */
    resumeWindowHours: live(z.any().default(6)),
    /** How long a session stays quiet, with work open, before a note, in seconds (5 to 86400). */
    idleSeconds: live(z.any().default(600)),
    /** At start, idle sessions whose last turn ended within this many hours are looked at (1 to 168). */
    idleWindowHours: live(z.any().default(2)),
    /** Notes in a row that bring no progress before Autopilot backs off (1 to 10). */
    maxNudges: live(z.any().default(2)),
    /** The most notes and goal starts Autopilot sends in an hour, over all sessions (1 to 500). */
    maxNotesPerHour: live(z.any().default(20)),
    /** Waits before each try after a failed turn, in seconds; one try per entry (1 to 10 entries, each up to 86400). */
    errorRetrySeconds: live(z.any().default([120, 600, 1800])),
    /** How long after DSH starts Autopilot first looks, in seconds (0 to 600). */
    startDelaySeconds: z.any().default(20),
});

export function apply(ctx, config) {
    const logger = ctx.logger;
    const settings = liveSettings(config);
    // DSH tells only Autopilot's own entry when its settings are saved in Plugins, so the listener lives here and
    // hands them to the pilot while one runs.
    let onSaved;
    ctx.on('loader/volatile-update', guard(logger, 'autopilot: settings', (paths) => onSaved?.(paths)));

    // Autopilot works only while Session Watch runs. Switched off, the pilot stops and the page says why;
    // switched on again, a new pilot starts from what Autopilot saved.
    ctx.inject(['sessionWatch'], (scope) => {
        const watch = scope.sessionWatch;
        // A wrong value never stops Autopilot from starting: it does no work, and its page says which setting to change.
        const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'autopilot', logger });
        check.run();
        // Its folder in DSH's data folder, as DSH resolves it (DSH_HOME, else ~/.dsh).
        const dir = dshHomePath('autopilot');
        const bump = () => watch.hub?.bump?.('autopilot');
        const store = new JsonStore(join(dir, 'state.json'), { parse: parseData, logger });
        const journal = new Journal(join(dir, 'events.jsonl'), { logger, onChange: bump });

        // System notifications through the notifications plugin, when it runs; one that fails never stops Autopilot.
        let notifications;
        scope.inject(['notifications'], (inner) => {
            const service = inner.notifications;
            notifications = service;
            return () => { if (notifications === service) notifications = undefined; };
        });
        const notify = (item) => {
            try {
                notifications?.notify?.(item);
            } catch (error) {
                logger?.warn?.(`autopilot: a notification failed: ${errorText(error)}`);
            }
        };

        const pilot = new Pilot({ watch, config: settings, store, journal, logger, notify, changed: bump, settingsOk: () => check.ok });
        /** Start once the settings allow; `after` says what the start follows, for the page's words (Pilot.start). */
        const startIfReady = (after) => {
            if (settings.enabled !== false && check.ok && !pilot.started) {
                const withDsh = firstStart && (typeof process?.uptime === 'function' ? process.uptime() < WITH_DSH_SECONDS : true);
                pilot.start({ after: after ?? (withDsh ? 'dsh' : 'again') });
                firstStart = false;
            }
        };
        startIfReady();

        // Settings saved on Autopilot's page in Plugins: checked again, and they apply at once. The log says each
        // new value and the one before it, so a copy of the values is kept between saves.
        const values = () => {
            const out = {};
            for (const key of Object.keys(SETTING_TITLES)) {
                try { out[key] = structuredClone(settings[key]); } catch { out[key] = String(settings[key]); }
            }
            return out;
        };
        let lastValues = values();
        const saved = (paths) => {
            const wasWrong = !check.ok;
            const before = lastValues;
            lastValues = values();
            const entry = savedEntry(check, paths, { before, after: lastValues });
            if (entry) journal.add(entry);
            if (pilot.started) pilot.settingsChanged({ fixed: wasWrong && check.ok });
            else startIfReady(wasWrong ? 'settings' : undefined);
            bump();
        };
        onSaved = saved;

        // Whether Decisions runs, from its service: the page names it only then, and never calls it to find out.
        let decisionsUp = false;
        scope.inject(['dshPluginDecisionsRemote'], () => {
            decisionsUp = true;
            bump();
            return () => {
                decisionsUp = false;
                bump();
            };
        });

        scope.inject(['typertGateway'], (inner) => {
            inner.provide(SERVICE, new AutopilotRemote({ pilot, watch, journal, config: settings, check, decisions: () => decisionsUp }));
        });

        scope.effect(() => () => {
            if (onSaved === saved) onSaved = undefined;
            // Its open questions leave the cards and are marked in the log before the store closes (see Pilot.setAsksAside).
            pilot.stop();
            store.close();
        }, 'autopilot: pilot');
    });
}
