/**
 * dsh-plugin-notifications, the senders. One notification goes out through
 * exactly one of these:
 *
 * - desktop: DSH's own desktopRuntime (Electron main). It already does the
 *   whole job: it sends nothing while the window is focused, it flashes the
 *   taskbar on Windows and badges the dock elsewhere, and a click brings the
 *   window up. Present in the Desktop app; absent in a browser profile and
 *   a terminal DSH.
 * - browser: the plugin's own browser half in a DSH window (the Web
 *   Notifications API), for the `web` profile served to a browser. The host
 *   queues the notification and the window shows it; this module only
 *   carries the payload.
 * - cli: a command-line sender (notify-send, PowerShell toast) when no DSH
 *   window is around to show one. A clean fallback, never a second copy: it
 *   only runs when no browser half has polled recently. Where the platform
 *   takes one, the sender carries the plugin's DeepSeek whale. macOS has no
 *   command-line sender here: osascript cannot set a per-notification icon,
 *   so its notifications show Script Editor's icon — the exact bug this
 *   plugin exists to fix — and macOS returns null instead of sending one.
 *   (On macOS the Desktop app's renderer is the sender; see notifier.js.)
 *
 * @module dsh-plugin-notifications/backends
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The plugin's icon, beside this module, as an absolute path. */
export const iconSvgPath = fileURLToPath(new URL('../icon.svg', import.meta.url));
/** A raster copy of it, for senders that need pixels (a Windows toast's logo). */
export const iconPngPath = fileURLToPath(new URL('../icon.png', import.meta.url));

/**
 * The icon a platform's CLI sender can show: an SVG path for notify-send,
 * the raster for a Windows toast, nothing for osascript.
 * @param {NodeJS.Platform} platform
 * @returns {{path: string} | undefined}
 */
export function iconFor(platform) {
    if (platform === 'linux') return { path: iconSvgPath };
    if (platform === 'win32') return existsSync(iconPngPath) ? { path: iconPngPath } : undefined;
    return undefined;
}

/** Collapse whitespace so a notification is one line. */
export function oneLine(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** DSH's own sender; the payload is {title, body} (see its notifications plugin). */
export function desktopSend(runtime, notification) {
    runtime.notifyAttention({ title: notification.title, body: notification.body });
}

/** A PowerShell single-quoted string literal, on one line. */
const psLiteral = (text) => `'${oneLine(text).replace(/'/g, "''")}'`;

/** A file:// URL a Windows toast can load its logo from. */
const toastFileUrl = (path) => `file:///${encodeURI(String(path).replace(/\\/g, '/'))}`;

/**
 * The command that shows one notification on this platform, or null when
 * the platform has none here. Windows takes a text toast through the
 * PowerShell WinRT projection (with the plugin's logo when an icon is
 * given); Linux takes notify-send. macOS takes nothing: osascript cannot
 * set a per-notification icon, so its notifications would show Script
 * Editor's icon — the posting app is not ours and cannot be made ours.
 * Nothing is run through a shell: every word is its own argument.
 * @param {NodeJS.Platform} platform
 * @param {{title: string, body: string}} notification
 * @param {{path: string} | undefined} [icon] - what iconFor says for the platform.
 */
export function cliCommand(platform, { title, body }, icon) {
    if (platform === 'linux') {
        const args = ['--app-name=DSH'];
        if (icon?.path) args.push(`--icon=${icon.path}`);
        args.push(title, body);
        return { command: 'notify-send', args };
    }
    if (platform === 'win32') {
        const script = [
            '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]',
            icon?.path
                ? `$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastImageAndText02)`
                : `$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
            icon?.path
                ? `$i=$t.GetElementsByTagName('image');[void]$i.Item(0).SetAttribute('src',${psLiteral(toastFileUrl(icon.path))});[void]$i.Item(0).SetAttribute('alt',${psLiteral(title)})`
                : null,
            `$x=$t.GetElementsByTagName('text')`,
            `[void]$x.Item(0).AppendChild($t.CreateTextNode(${psLiteral(title)}))`,
            `[void]$x.Item(1).AppendChild($t.CreateTextNode(${psLiteral(body)}))`,
            `[void][Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DSH').Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
        ].filter((line) => line !== null).join(';');
        return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
    }
    return null;
}

/**
 * Send one notification through the platform's command. Fire and forget:
 * a stuck child is killed after timeoutMs, and a missing command, a
 * non-zero exit or the kill is reported once through onError; none of it
 * throws into the caller.
 * @param {NodeJS.Platform} platform
 * @param {{title: string, body: string}} notification
 * @param {object} [options]
 * @param {{path: string} | undefined} [options.icon] - what iconFor says for the platform.
 * @returns whether a command was started.
 */
export function cliSend(platform, notification, { spawnImpl = spawn, timeoutMs = 15000, onError = () => {}, icon } = {}) {
    const cmd = cliCommand(platform, notification, icon);
    if (!cmd) return false;
    try {
        const child = spawnImpl(cmd.command, cmd.args, { stdio: 'ignore' });
        const timer = setTimeout(() => child.kill(), timeoutMs);
        timer.unref?.();
        let reported = false;
        const report = (error) => {
            if (reported) return;
            reported = true;
            onError(error);
        };
        child.on('error', (error) => {
            clearTimeout(timer);
            report(error);
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (signal) report(new Error(`${cmd.command} was stopped after ${Math.round(timeoutMs / 1000)} s`));
            else if (typeof code === 'number' && code !== 0) report(new Error(`${cmd.command} exited with code ${code}`));
        });
        return true;
    } catch (error) {
        onError(error);
        return false;
    }
}
