/**
 * dsh-plugin-notifications, bringing the Desktop app's window up after a
 * click on a notification.
 *
 * In the Desktop app the window's own `window.focus()` cannot show a window
 * that is hidden (closed with its close button, which DSH's app hides) or
 * minimised: only the app's main process can, and it offers the renderer
 * no call for it. What it does offer is what the Dock does: an app that is
 * opened again while it runs hands the launch to the running one, which
 * restores, shows and focuses its window (DSH's app: `second-instance` →
 * `focusPrimaryWindow`, the same as `dsh://open` and a Dock click). So the
 * plugin's host half, which the app runs as its own child process, opens
 * the app once more with the running app's own user-data folder; the new
 * process finds the app already running, hands over, and quits.
 *
 * It only does this where it can prove it is that child: the host's entry
 * is DSH's desktop host and its parent's command line is the same app. Any
 * other DSH (a terminal one, the real-DSH tests, a browser profile) gets a
 * reason in words and nothing is started.
 *
 * @module dsh-plugin-notifications/raise
 */
import { execFileSync, spawn } from 'node:child_process';

/** The least time between two raises, so a burst of clicks starts one launch. */
export const RAISE_GAP_MS = 2000;

/**
 * How to open the running Desktop app again, or why not.
 * @param {object} facts
 * @param {NodeJS.Platform} facts.platform
 * @param {string} facts.execPath - this process's executable (the app's, in its Node mode).
 * @param {string[]} facts.argv - this process's argv (its entry is argv[1]).
 * @param {string} facts.parentArgs - the parent process's command line ('' when unknown).
 * @param {boolean} facts.electron - this process runs on the app's runtime.
 * @returns {{ command: string, args: string[] } | { reason: string }}
 */
export function relaunchPlan({ platform, execPath, argv, parentArgs, electron }) {
    if (!electron) return { reason: 'this DSH is not the Desktop app' };
    if (platform !== 'darwin' && platform !== 'linux') return { reason: 'the app window is raised this way on macOS and Linux only' };
    const entry = String(argv?.[1] ?? '');
    if (!/[\\/]dsh-desktop-host[\\/]/.test(entry)) return { reason: 'this DSH was not started by the Desktop app' };
    const parent = String(parentArgs ?? '').trim();
    if (!execPath || !parent.startsWith(execPath)) return { reason: 'the Desktop app that started this DSH could not be found' };
    // The app's own command line: its executable and its switches, never a script of its own.
    const rest = parent.slice(execPath.length).trim();
    const parts = rest === '' ? [] : rest.split(/\s+(?=-)/);
    if (parts.some((part) => !part.startsWith('-'))) return { reason: 'the process that started this DSH is not the Desktop app itself' };
    const userData = parts.find((part) => part.startsWith('--user-data-dir='));
    return { command: execPath, args: userData ? [userData.trim()] : [] };
}

/** The parent process's command line, or '' (never throws). */
export function parentCommandLine(ppid = process.ppid, run = execFileSync) {
    try {
        return String(run('ps', ['-ww', '-o', 'args=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    } catch {
        return '';
    }
}

/**
 * The raiser the host keeps: `raise()` answers what it did, in words, and
 * never throws.
 * @param {object} [options]
 * @param {() => ({ command: string, args: string[] } | { reason: string })} [options.plan]
 * @param {typeof spawn} [options.spawnImpl]
 * @param {() => number} [options.now]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function makeRaiser({ plan, spawnImpl = spawn, now = Date.now, env = process.env } = {}) {
    let last = 0;
    let known;
    const planNow = () => {
        known ??= plan?.() ?? { reason: 'no way to raise the window here' };
        return known;
    };
    return {
        /** Whether this DSH can bring the app's window up, and why not. */
        available() {
            const p = planNow();
            return 'command' in p ? { ok: true } : { ok: false, reason: p.reason };
        },
        raise() {
            const p = planNow();
            if (!('command' in p)) return { raised: false, reason: p.reason };
            if (now() - last < RAISE_GAP_MS) return { raised: false, reason: 'it was asked to come up a moment ago' };
            last = now();
            try {
                // The app as it is opened, not in its Node mode.
                const childEnv = { ...env };
                delete childEnv.ELECTRON_RUN_AS_NODE;
                delete childEnv.NODE_OPTIONS;
                const child = spawnImpl(p.command, p.args, { detached: true, stdio: 'ignore', env: childEnv });
                child.on?.('error', () => {});
                child.unref?.();
                return { raised: true };
            } catch (error) {
                return { raised: false, reason: `the app could not be asked: ${String(error?.message ?? error).slice(0, 160)}` };
            }
        },
    };
}
