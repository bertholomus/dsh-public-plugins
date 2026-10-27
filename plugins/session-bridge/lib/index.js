/**
 * dsh-plugin-session-bridge — a local control surface for the running DSH.
 *
 * It serves a small JSON API on a Unix socket (owner-only, no TCP port) and
 * drives the Host's own `sessionController` service: the same code path the
 * window uses. Sessions created or prompted here show up live in the DSH
 * window, and the user can watch and take over there.
 *
 *   GET  /health                           {ok, plugin, version, pid, socket, problems}
 *   GET  /workspaces | /models | /sessions
 *   POST /sessions                         {workspacePath|workspaceId, title?, provider?, model?, reasoningEffort?, agentPreset?, text?, requestId?}
 *   GET  /sessions/:id                     status, turns, last reply
 *   GET  /sessions/:id/events              ?after=<seq>&limit=<n>&full=1&types=a,b&wait=<s>
 *   GET  /sessions/:id/requests/:rid       what became of one prompt (?wait=<s> until it is answered)
 *   POST /sessions/:id/prompt              {text, mode?: "followup"|"steer", requestId?}
 *   POST /sessions/:id/model | /cancel | /rename
 *
 * The routes, the settings check, the log and the socket are in lib/bridge.js,
 * which needs none of DSH's packages; this file wires it to DSH.
 *
 * @module dsh-plugin-session-bridge
 */
import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { readFileSync } from 'node:fs';
import { checkSettings, createBridge, errorText } from './bridge.js';

export const name = 'session-bridge';
export const inject = ['sessionController', 'workspaceRegistry', 'agents'];

/**
 * Settings. Their types and ranges are checked in lib/bridge.js
 * (checkSettings), which says what is wrong in words; any value is taken
 * here, so a wrong one never stops DSH loading the bridge. The socket and
 * the log default to DSH's own data folder (DSH_HOME, else the home
 * folder's .dsh), so a second DSH with its own home gets its own socket.
 */
export const Config = z.object({
    // No longer a setting (0.4.0): DSH's switch in Plugins turns the bridge off and shows it Off. Still read, with no
    // default, so that a row that says false keeps the socket closed instead of being taken as on.
    enabled: z.any().description('No longer a setting: switch the bridge off in Plugins. A row that says false keeps it from starting.'),
    socketPath: z.any().description('The Unix socket to listen on. Default: session-bridge/bridge.sock in DSH\'s data folder.'),
    logFile: z.any().description('The action log (mode 600); "" for none. Default: session-bridge/bridge.log in DSH\'s data folder.'),
    maxBodyBytes: z.any().default(1048576).description('The largest request body taken, in bytes (1024 to 67108864).'),
});

const VERSION = (() => {
    try {
        return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '';
    } catch {
        return '';
    }
})();

/** What to do after a failed start, as the start error says it. */
const AGAIN = 'then switch Session Bridge off and on in Plugins, or restart DSH; saving the fixed row alone may leave it failed';

/**
 * Start the bridge. When it cannot listen (a refused socket path, a socket another program answers on, a row that
 * still says `enabled: false`), apply fails with the reason, so DSH shows the plugin as failed ("Problem" on its
 * Plugins page, never "Running") and logs why. Switching the plugin off and on in Plugins, or restarting DSH,
 * always tries again. Saving a fixed row does when it differs from the row that last ran; when it is that row
 * again, DSH may leave the plugin failed (it does after a refused socket, and may after `enabled: false`).
 */
export async function apply(ctx, config) {
    const settings = checkSettings(config, {
        socketPath: dshHomePath('session-bridge', 'bridge.sock'),
        logFile: dshHomePath('session-bridge', 'bridge.log'),
    });
    const bridge = createBridge({
        host: {
            sessionController: () => ctx.sessionController,
            workspaceRegistry: () => ctx.workspaceRegistry,
            agents: () => ctx.agents,
        },
        settings,
        logger: ctx.logger,
        version: VERSION,
    });
    if (!settings.values.enabled) {
        // `enabled` is no longer a setting, but a row that says off is never taken as on: nothing listens, and DSH
        // shows a failed start with the reason (not "Running" for a bridge that is off).
        const why = 'its row says enabled: false, and enabled is no longer a setting. To switch it off, use its switch in Plugins (DSH then shows it Off); to have it listen, take enabled out of its row';
        for (const problem of settings.problems) {
            ctx.logger.warn('session-bridge: %s', problem);
            bridge.log(`setting: ${problem}`);
        }
        bridge.log(`not listening on ${bridge.socketPath}: ${why}`);
        throw new Error(`Session Bridge is not listening on ${bridge.socketPath}: ${why}, ${AGAIN}.`);
    }
    // A request that waits for news is woken by DSH's own events. Nothing here may throw into DSH's dispatch.
    ctx.on('session/event', (session, event) => {
        try {
            bridge.onSessionEvent(session?.id, event);
        } catch (error) {
            ctx.logger.warn('session-bridge: session event %s', errorText(error));
        }
    });
    let failure;
    let disposed = false;
    const started = bridge.start().catch((error) => {
        failure = errorText(error);
        bridge.log(`not listening on ${bridge.socketPath}: ${failure}`);
        return false;
    });
    ctx.effect(() => async () => {
        disposed = true;
        await started;
        await bridge.stop();
    });
    const listening = await started;
    const why = bridge.refused ?? failure;
    if (!listening && !disposed && why) {
        throw new Error(`Session Bridge is not listening on ${bridge.socketPath}: ${why}. Fix socketPath in its row (or free the socket), ${AGAIN}.`);
    }
}
