/**
 * dsh-plugin-agent-terminals — command-line coding agents as part of DSH.
 *
 * A coding agent (any command-line one: the person names the program and
 * how it resumes a conversation) runs in a terminal of its own DSH session,
 * shown as a tab beside the session. Agent Terminals reads the agent's own
 * transcript to know what it is doing (working, idle, waiting on you,
 * stopped), shows that on the session's row and in Decisions, types
 * messages in one at a time and proves from the transcript that the agent
 * read each one (pressing Enter again when a program swallowed it), and
 * starts every agent again after DSH restarts, resuming its conversation.
 *
 * It reads sessions and raises questions through Session Watch, which must
 * run too: while Session Watch is switched off, Agent Terminals stays
 * loaded, does nothing, and its page says what it needs.
 *
 * @module dsh-plugin-agent-terminals
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { AgentTerminals, parseData } from './agents.js';
import { LIVE_SETTINGS, checkConfig, savedEntry } from './config.js';
import { detectAgents } from './detect.js';
import { AgentTerminalsRemote, SERVICE } from './remote.js';
import { Typist } from './typist.js';
import { JsonStore } from './shared/files.js';
import { Journal } from './shared/journal.js';
import { errorText, guard } from './shared/safe.js';
import { SettingsCheck, live, liveSettings } from './shared/settings.js';

export { SETTING_TITLES, LIVE_SETTINGS, TYPING, checkConfig, changedWords } from './config.js';

export const name = 'agent-terminals';

/**
 * Nothing at start: Agent Terminals waits for the session watcher inside
 * apply, so switching Session Watch off leaves it loaded and idle (its page
 * says why) instead of making DSH report it as waiting for a service.
 */
export const inject = [];

/**
 * Settings: types and defaults here, the rest in checkConfig (lib/config.js),
 * so a wrong value is said in words on its page instead of stopping it at
 * start. The live ones are on its page in Plugins and apply when saved.
 */
export const Config = z.object({
    /** Profile only. false keeps Agent Terminals loaded but idle: it starts and types nothing, and its page says so. */
    enabled: z.boolean().default(true),
    /** Start the agents again, resuming their conversations, after DSH restarts. */
    resumeAfterRestart: live(z.boolean().default(true)),
    /** Give a new agent's session one short turn by its model, so DSH lists it in the sidebar. */
    listNewSessions: live(z.boolean().default(true)),
    /** Open an agent's terminal tab when its session is on screen (once per agent and window). */
    openTabs: live(z.boolean().default(true)),
    /** Type messages in while the agent works (never while it runs a tool). Off: they wait until it is idle. */
    typeWhileWorking: live(z.boolean().default(false)),
    /** Seconds without proof, while the agent is idle, before Enter is pressed again (2 to 120). */
    proofSeconds: live(z.number().default(8)),
    /** How many more times Enter is pressed (0 to 5). */
    enterRetries: live(z.number().default(2)),
    /** Seconds a tool call may wait for its result before the agent counts as asking you (5 to 600). */
    askAfterSeconds: live(z.number().default(20)),
    /** A system notification when an agent waits on you, through the notifications plugin. */
    notify: live(z.boolean().default(true)),
    /** Profile only: "auto", "direct" (into the terminal's process) or "attached" (DSH's terminal input). */
    typing: z.string().default('auto'),
});

export function apply(ctx, config) {
    const logger = ctx.logger;
    const settings = liveSettings(config);
    // DSH tells only the plugin's own entry when its settings are saved in Plugins: the listener lives here.
    let onSaved;
    ctx.on('loader/volatile-update', guard(logger, 'agent-terminals: settings', (paths) => onSaved?.(paths)));

    ctx.inject(['sessionWatch'], (scope) => {
        const watch = scope.sessionWatch;
        const check = new SettingsCheck({ settings, check: checkConfig, liveKeys: LIVE_SETTINGS, label: 'agent-terminals', logger });
        check.run();
        const dir = dshHomePath('agent-terminals');
        const bump = () => watch.hub?.bump?.('agent-terminals');
        const store = new JsonStore(join(dir, 'state.json'), { parse: parseData, logger });
        const journal = new Journal(join(dir, 'events.jsonl'), { logger, onChange: bump });
        const home = homedir();

        // DSH's services, each optional: what is missing is said on the page.
        const services = { terminals: undefined, registry: undefined, sessions: undefined, notifications: undefined };
        const track = (name, key) => scope.inject([name], (inner) => {
            const service = inner[name];
            services[key] = service;
            bump();
            return () => {
                if (services[key] === service) services[key] = undefined;
                bump();
            };
        });
        track('workspaceRegistry', 'registry');
        track('sessionController', 'sessions');
        track('notifications', 'notifications');
        const sessionController = () => services.sessions ?? watch.ctx?.sessionController;

        const typist = new Typist({ controller: () => services.terminals, method: () => settings.typing, logger });
        const sessions = {
            async create(folder) {
                if (typeof services.registry?.create !== 'function') throw new Error('DSH\'s project list is not running');
                const workspace = await services.registry.create(folder);
                const created = await sessionController().create({ workspaceId: workspace.id });
                if (typeof created?.sessionId !== 'string') throw new Error('DSH made no session');
                return created.sessionId;
            },
            async rename(sessionId, title) {
                await sessionController().rename({ sessionId, title });
            },
        };
        const working = () => settings.enabled !== false && check.ok;
        const agents = new AgentTerminals({
            watch,
            controller: () => services.terminals,
            sessions,
            typist,
            config: settings,
            store,
            journal,
            logger,
            home,
            working,
            changed: bump,
            notify: (item) => {
                const sent = services.notifications?.notify?.(item);
                if (sent && typeof sent.then === 'function') sent.then(undefined, (error) => logger?.warn?.(`agent-terminals: a notification failed: ${errorText(error)}`));
            },
        });

        // Agent Terminals itself starting and stopping is in the log too: while stopped, nobody follows the agents.
        const switched = (on, why) => {
            try {
                journal.add({ kind: 'switch', text: on ? 'Agent Terminals follows its agents' : 'Agent Terminals stopped following its agents', why, state: on ? 'done' : 'stopped', by: 'Agent Terminals' });
            } catch (error) {
                logger?.warn?.(`agent-terminals: could not log: ${errorText(error)}`);
            }
        };
        const some = () => Object.keys(store.data.agents).length > 0;
        // Whichever part of DSH lets go first (its terminals, or the plugin itself) stops the agents and says so, once.
        const stopFollowing = (why) => {
            const was = agents.started;
            agents.stop();
            if (was && some()) switched(false, why);
        };
        const OFF_WHY = 'Switched off in Plugins, or DSH is quitting. While DSH runs, the agents keep running in their terminals; Agent Terminals picks them up where they are when it starts again.';

        // The agents start once DSH's terminals are there (never before: an agent would look gone).
        scope.inject(['terminalController'], (inner) => {
            services.terminals = inner.terminalController;
            if (working()) {
                agents.start();
                if (some()) switched(true, 'It started (with DSH, or switched on in Plugins): it picks up every agent where it is.');
            }
            bump();
            return () => {
                stopFollowing(OFF_WHY);
                services.terminals = undefined;
                bump();
            };
        });

        // What the start form offers: programs found by the conversations they keep, read at most once a minute.
        let found = { at: 0, list: [] };
        const detected = async () => {
            if (Date.now() - found.at > 60000) {
                try {
                    found = { at: Date.now(), list: detectAgents(home).slice(0, 8) };
                } catch (error) {
                    logger?.warn?.(`agent-terminals: could not look for coding agents: ${errorText(error)}`);
                    found = { at: Date.now(), list: [] };
                }
            }
            return found.list;
        };
        const workspaces = () => {
            try {
                const list = services.registry?.list?.() ?? [];
                return list.map((w) => ({ path: w.path, title: w.title })).filter((w) => typeof w.path === 'string').slice(0, 40);
            } catch {
                return [];
            }
        };

        // Settings saved on its page in Plugins: checked again; they apply at once.
        const saved = (paths) => {
            const entry = savedEntry(check, paths);
            if (entry) journal.add(entry);
            if (working() && services.terminals && !agents.started) {
                agents.start();
                if (some()) switched(true, 'Its settings are right again: it picks up every agent where it is.');
            } else if (!working() && agents.started) {
                agents.stop();
                if (some()) {
                    switched(false, settings.enabled === false
                        ? 'It was switched off in its settings. The agents keep running in their terminals, unfollowed: switch it on to pick them up where they are.'
                        : 'A setting is wrong (see the top of its page). The agents keep running in their terminals, unfollowed: once the setting is fixed, it picks them up where they are.');
                }
            }
            bump();
        };
        onSaved = saved;

        scope.inject(['typertGateway'], (inner) => {
            inner.provide(SERVICE, new AgentTerminalsRemote({ agents, journal, config: settings, check, watch, terminals: () => services.terminals, detected, workspaces, started: () => agents.started }));
        });

        scope.effect(() => () => {
            if (onSaved === saved) onSaved = undefined;
            stopFollowing(OFF_WHY);
            typist.close();
            store.close();
        }, 'agent-terminals: agents');
    });
}
