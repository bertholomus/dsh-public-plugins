/**
 * dsh-plugin-coordinator — any DSH chat can run its work in threads.
 *
 * /coordinate in a chat (or Coordinate in its header) makes it coordinate:
 * it starts thread sessions for focused work with the plugin's tools;
 * threads report back with thread_handback, and the handback arrives in
 * the chat as its next turn. /coordinate off stops it. Every thread is an
 * ordinary DSH session made through the Host's sessionController, so the
 * user watches and talks to each one in the DSH window. The chat itself
 * keeps the user's own access: its model, permission and tools stay theirs.
 *
 * Settings for threads: model and effort, plus pause. Each coordinating
 * chat sets its own in its Thread settings dialog (lib/client.js, through
 * remote.js) or through its thread_settings tool; chats that set none use
 * the plugin-wide defaults. Those are live config, so the form on the
 * plugin's page in DSH changes them without a restart. Access settings work
 * the same way, except that only the user changes them: whether threads
 * have the user's own tools, and the DSH permission preset new threads
 * start on.
 *
 * @module dsh-plugin-coordinator
 */
import z from '@deepseek-ai/schemastery';
import { ProjectManager, COMMAND } from './projects.js';
import { projectTools } from './tools.js';
import { coordinatorSessionProjection } from './projection.js';
import { ProjectsRemote, SERVICE } from './remote.js';

export const name = 'coordinator';

/** Host services the plugin drives. */
export const inject = ['sessionController', 'workspaceRegistry', 'agents', 'tools', 'systemPrompt'];

/**
 * A setting DSH's settings page may change while the plugin runs. The plugin
 * reads it through pluginDefaults(); a schemastery without volatile fields
 * keeps it ordinary config.
 */
const live = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema);

export const Config = z.object({
    /** Master switch. */
    enabled: z.boolean().default(true),
    /** Plugin-wide default model for new threads; empty uses the DSH default model. */
    threadModel: live(z.string()),
    /** Plugin-wide default effort for new threads; empty uses the model's default. */
    threadEffort: live(z.string()),
    /**
     * Which threads may use the user's own tools (guardedTools, and the
     * ones other plugins mark as the user's own). A coordinating chat has
     * them, as any chat does. "asked" (the default): a thread has only the
     * ones the user's own words for it name. "always": every thread has
     * them, and only the prompts' rule and the thread checks stand between
     * them and the model.
     */
    yourTools: live(z.string()),
    /** Plugin-wide permission new threads start on: a DSH permission preset (read-only, workspace-write, danger-full-access), or "default" for DSH's default. Empty means workspace-write. */
    threadPermission: live(z.string()),
    /** "idle": when a thread ends a turn the coordinator started without a handback, nudge it once, and tell the coordinator when it ends that way again. "off": only explicit handbacks. */
    autoHandback: z.union(['idle', 'off']).default('idle'),
    /** Handbacks one thread may send per hour, explicit plus the plugin's notes and nudges; stops runaway loops. */
    maxHandbacksPerHour: z.number().default(30),
    /** New threads one chat may start per hour; stops a chat stuck starting threads in a loop. */
    maxThreadsPerHour: z.number().default(20),
    /** Seconds a thread may wait on a permission prompt before its chat is told. 0 (the default) tells it at once. */
    approvalNoticeSeconds: z.number().default(0),
    /** Durable state: the coordinating chats and their threads. */
    storeFile: z.string().default('~/.dsh/coordinator/coordinator.json'),
    /** Folder for each coordinating chat's shared notes. */
    memoryDir: z.string().default('~/.dsh/coordinator/memory'),
    /** Largest memory file the tools will write. */
    maxMemoryBytes: z.number().default(65536),
    /**
     * The user's personal and infrastructure tools (MCP server or tool
     * names) that threads use only when the user's own words ask for them:
     * a list, or a map from each name to the words the user may call it by,
     * e.g. { "lane-catalog": ["lanes", "model lanes"] }. The prompts name
     * them, a thread start or message that names one is refused unless the
     * user's words name it, and under yourTools "asked" threads don't have
     * them at all. Live, so an edit doesn't restart the plugin. A tool
     * another plugin registers with `personal` on its definition is guarded
     * too, without being listed (see the README's "Tools other plugins mark
     * as yours").
     */
    guardedTools: live(z.union([z.array(z.string()), z.dict(z.array(z.string()))]).default([])),
    /**
     * Machines the user trusts, such as their own NAS: host names or
     * addresses (`nas`, `100.64.0.7`; a user, a port or brackets are left
     * off), matched without regard to case. A thread's command whose only
     * sends reach these (ssh, mosh or autossh to one, scp or rsync to or
     * from one, a web request to one) runs without asking; one that also
     * sends elsewhere asks about the rest. Live, so an edit doesn't restart
     * the plugin.
     */
    trustedHosts: live(z.array(z.string()).default([])),
    /** Action log, mode 600, never prompt text. Empty turns it off. */
    logFile: z.string().default('~/.dsh/coordinator/coordinator.log'),
});

export function apply(ctx, config) {
    if (!config.enabled) return;
    for (const key of ['maxHandbacksPerHour', 'maxThreadsPerHour', 'maxMemoryBytes']) {
        if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`coordinator: ${key} must be a positive integer`);
    }
    if (!(config.approvalNoticeSeconds >= 0)) throw new Error('coordinator: approvalNoticeSeconds must be 0 or more');
    const manager = new ProjectManager({ ctx, config, buildTools: projectTools });

    // System notifications for its news (plugins/notifications), while no window is looking: that
    // plugin gates the kinds on its own settings, and is absent when it is off or not installed.
    // The callback gets a scope, not the service: read the service off it (cordis throws on a property the scope
    // didn't inject). A notification is a side effect and never fails the delivery that raised it: a thrown sink used
    // to fail thread_handback after the coordinator already had the handback, so the thread handed back again and
    // again, and the idle review nudged it each time.
    ctx.inject(['notifications'], (scope) => {
        const notifications = scope.notifications;
        const sink = (item) => notifications.notify({
            title: coordinatorNewsLine(item),
            kind: item.kind,
            sessionId: item.session,
        });
        sink.notifications = notifications;
        manager.newsSink = sink;
        return () => { if (manager.newsSink === sink) manager.newsSink = undefined; };
    });

    ctx.on('agent/created', ({ agent }) => {
        manager.maybeInstall(agent);
    });
    ctx.on('agent/disposed', ({ agent }) => {
        manager.forget(agent);
    });
    // A chat a coordinating chat messaged (chat_message) went idle: its answer goes back to that chat once.
    ctx.on('agent/status', ({ agent, status }) => {
        manager.onAgentStatus(agent, status);
    });
    // Every session's events, as DSH's own change recorder hears them: a subagent's file edit counts for its thread.
    ctx.on('session/event', (session, event) => {
        manager.onSessionEvent(session, event);
    });
    // The defaults form saved: only the live fields changed, so the plugin keeps running.
    ctx.on('loader/volatile-update', () => {
        void manager.onDefaultsChanged();
    });
    // An MCP server connected, reconnected or changed its tools: the user's tools stay out of the threads that may not use them.
    ctx.on('tools/change', () => {
        manager.onToolsChanged();
    });
    // A thread's command that sends outside the workspace, or deletes files it didn't create, waits for the user
    // (manager.holdCommand: one prompt that says both), for every session, since a thread's subagent has no scope of its
    // own. It wraps DSH's own checks: their refusals stand, and when one asks without passing the call on (a hook's
    // ask), the send or delete is named on that same prompt.
    ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        return decision?.kind === 'allow' || decision?.kind === 'ask' ? manager.holdCommand(exec, decision) ?? decision : decision;
    }, { prepend: true });
    // A thread's call the user rejected at the prompt: its result says what they declined and to hand back
    // needs_decision, unless another listener already changed it (manager.declined).
    ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next();
        if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value') || decision.content !== undefined) {
            manager.declined(exec, undefined);
            return decision;
        }
        const own = manager.declined(exec, result);
        return own ? { ...decision, ...own } : decision;
    }, { prepend: true });
    // A thread's file edits, and its subagents': the file's text before its first edit and after each, for its
    // Changes tab's one diff per file.
    ctx.on('tools/execute', (exec, next) => manager.aroundTool(exec, next));
    // A coordinating chat archived or unarchived in DSH (its row's Archive or Unarchive, the Undo on DSH's notice):
    // its threads go or come back with it.
    ctx.on('domain/changed', (change) => {
        manager.onWorkspaceState(change);
    });
    // DSH's own Archive on a coordinating chat's row asks first while its threads run, names them, and stops them with it.
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
        const rest = await next();
        const own = manager.archiveActivity(sessionId);
        return own ? [own, ...rest] : rest;
    });
    ctx.effect(() => () => manager.dispose(), 'coordinator.scopes()');
    // What the DSH window draws for coordinating chats and threads: roles, rosters and thread
    // cards (lib/projection.js). Optional, so a Host without projections still runs threads.
    ctx.inject(['sessionProjections'], (scope) => {
        scope.sessionProjections.register(coordinatorSessionProjection((sessionId) => manager.seedView(sessionId)));
    });

    // /coordinate in any chat starts coordinating there, and /coordinate off stops. DSH logs the command and its
    // result in the chat, which is how the window (the projection) learns the chat coordinates.
    ctx.inject(['commands'], (scope) => {
        scope.commands.register({
            name: COMMAND,
            description: 'Run work from this chat in threads that report back here; /coordinate off stops',
            input: { hint: '[off]' },
            handler: ({ agent, rawInput }) => manager.onCommand(agent, rawInput),
        });
    });

    // The Coordinate button's and the Thread settings dialog's endpoints (remote.js), served by DSH's own
    // gateway. Optional too: without them the window says it can't reach the plugin.
    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new ProjectsRemote(scope, manager));
    });

    // Coordinating chats come up after composition settles; failures are logged, never thrown.
    manager.start().then(() => {
        ctx.logger.info('coordinator: %d coordinating chat(s)', manager.projects.size);
    }, (error) => {
        ctx.logger.warn('coordinator: startup failed: %s', error?.message ?? error);
    });
}

/**
 * The system notification's one line for a news item, in the window notice's
 * words (lib/client.js TEXT.news and the notice kinds).
 * @param {{kind: string, status?: string, title: string}} item - a noteNews item.
 */
export function coordinatorNewsLine({ kind, status, title }) {
    if (kind === 'handback') return status === 'blocked' ? `“${title}” is blocked` : status === 'needs_decision' ? `“${title}” needs a decision` : `“${title}” handed back`;
    if (kind === 'finished') return `“${title}” ended without a handback`;
    if (kind === 'approval') return `“${title}” is waiting for approval`;
    if (kind === 'failed') return `“${title}” failed`;
    return `“${title}” stopped`;
}
