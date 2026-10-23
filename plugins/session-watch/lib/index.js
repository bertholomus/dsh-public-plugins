/**
 * dsh-plugin-session-watch — the shared session watcher for the suite.
 *
 * Autopilot, Decisions and Agent Terminals all need to know what every
 * session is doing: whether a turn runs, how the last one ended, its todos,
 * its goal, the approvals it waits on. This plugin is the one place that
 * reads it, from DSH's own events, and serves it to them as the
 * `sessionWatch` service (lib/watch.js):
 *
 *     ctx.inject(['sessionWatch'], (scope) => {
 *         const watch = scope.sessionWatch;
 *         watch.on((event) => { if (event.type === 'turn-end') … });
 *         await watch.deliver(sessionId, 'Carry on.');   // resolves on proof, never on "sent"
 *     });
 *
 * Nothing polls: DSH drives the watcher's projection (lib/fold.js) over
 * every committed event, and one window request per window carries every
 * suite plugin's changes (lib/remote.js, shared/hub.js).
 *
 * @module dsh-plugin-session-watch
 */
import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { sessionWatchProjection } from './fold.js';
import { SessionWatch } from './watch.js';
import { SessionWatchRemote, SERVICE } from './remote.js';
import { Hub } from './shared/hub.js';
import { errorText, guard } from './shared/safe.js';
import { SettingsCheck, live, liveSettings } from './shared/settings.js';
import { LIVE_SETTINGS, checkConfig, usableSettings } from './config.js';

export { LIVE_SETTINGS, checkConfig } from './config.js';

export const name = 'session-watch';

/** Host services the watcher reads: DSH's session controller, sessions, agents and projections. */
export const inject = ['sessionController', 'sessions', 'agents', 'sessionProjections'];

/**
 * Settings: their defaults here; their types and ranges in checkConfig. It takes any value, so a wrong type in the
 * profile (a number in quotes, say) is said in words as a wrong range is, instead of stopping the watcher at start
 * or being dropped on a live edit.
 */
export const Config = z.object({
    /** How long a message may wait to be read into a turn before its delivery is reported as failed, in seconds (10 to 86400). */
    deliveryTimeoutSeconds: live(z.any().default(600)),
});

/** How plugin messages are marked in a session's log, as DSH marks a plugin's own. */
const PLUGIN_SOURCE = Object.freeze({ kind: 'cordis-host-runner' });

export function apply(ctx, config) {
    const logger = ctx.logger;
    const settings = liveSettings(config);
    // A wrong value never stops the watcher, which every suite plugin needs: it uses the default and says so.
    const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'session-watch', logger });
    check.run();
    const usable = usableSettings(settings, check);
    const hub = new Hub();
    const watch = new SessionWatch({
        ctx,
        config: usable,
        logger,
        hub,
        // Its folder in DSH's data folder, as DSH resolves it (DSH_HOME, else ~/.dsh).
        dir: dshHomePath('session-watch'),
        makeMessage: (text) => createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }),
    });

    // The watcher's own state of every session, driven by DSH over every committed event.
    ctx.sessionProjections.register(sessionWatchProjection());

    // One listener each, guarded: nothing the watcher does may fail the DSH call that raised the event.
    ctx.on('session/event', guard(logger, 'session-watch: session event', (session, event) => watch.onSessionEvent(session, event)));
    ctx.on('agent/created', guard(logger, 'session-watch: agent created', ({ agent }) => watch.onAgent(agent, 'created')));
    ctx.on('agent/disposed', guard(logger, 'session-watch: agent disposed', ({ agent }) => watch.onAgent(agent, 'disposed')));
    ctx.on('agent/status', guard(logger, 'session-watch: agent status', ({ agent, status }) => watch.onStatus(agent, status)));
    ctx.on('agent/inbox/discarded', guard(logger, 'session-watch: inbox discard', ({ agent, message }) => watch.onDiscarded(agent, message)));

    // Turns running now (the plugin restarted under them) go on the record too.
    try {
        for (const agent of ctx.agents.list?.() ?? []) {
            if (agent?.status === 'running' && typeof agent.id === 'string') watch.running.data.sessions[agent.id] = { at: Date.now() };
        }
        watch.running.change();
    } catch (error) {
        logger?.warn?.(`session-watch: could not read the running agents: ${errorText(error)}`);
    }

    // The goal service, when DSH has one: Autopilot reads and re-arms goals through it.
    ctx.inject(['goals'], (scope) => {
        watch.goals = scope.goals;
        return () => { if (watch.goals === scope.goals) watch.goals = undefined; };
    });

    // A setting saved on its page in Plugins: checked again, and the suite's pages read it.
    watch.settings = check;
    ctx.on('loader/volatile-update', guard(logger, 'session-watch: settings', () => {
        check.run();
        hub.bump('settings');
    }));

    ctx.provide('sessionWatch', watch);

    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new SessionWatchRemote(watch, hub));
    });

    ctx.effect(() => () => {
        hub.close();
        watch.close();
    }, 'session-watch: watcher');
}
