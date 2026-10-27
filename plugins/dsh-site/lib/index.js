/**
 * dsh-plugin-dsh-site: a private-network front door to the DSH window this
 * plugin runs in.
 *
 * DSH serves its window on 127.0.0.1 only, and answers only requests that
 * carry its sign-in cookie and a loopback Host. This plugin opens a second
 * listener (lib/edge.js), lets in only the address ranges you list, checks
 * each request the way DSH itself would (lib/fence.js), and passes it on to
 * DSH's loopback server, so a device on your tailnet gets the same window:
 * the same sessions, workspaces and tools.
 *
 * Settings are checked in words (lib/config.js): a wrong one never stops the
 * plugin from loading, and the edge does not open its port until it is fixed.
 *
 * @module dsh-plugin-dsh-site
 */
import z from '@deepseek-ai/schemastery';
import { readFileSync } from 'node:fs';
import { checkConfig, settingPath } from './config.js';
import { readJar } from './cookie.js';
import { createEdge, lsofListeners, originOf } from './edge.js';
import { createLog } from './log.js';

export const name = 'dsh-site';

/** Nothing is required: DSH's window server (`webServer`) is used when it is there. */
export const inject = [];

const any = (words) => z.any().description(words);

/**
 * Every key takes any value and none is filled in: DSH checks a row against
 * its schema before the plugin starts, and a value of the wrong type there
 * would stop the plugin with only "Problem"; and a row with no settings must
 * reach the plugin as empty, so that it does not serve (lib/config.js says
 * what each must be, and the defaults).
 */
export const Config = z.object({
    enabled: any('Serve DSH to other devices (default true). false keeps the plugin loaded and the port closed.'),
    listenHost: any('Required. Address to listen on: this machine\'s tailnet address (that network only), 127.0.0.1, or 0.0.0.0 (every interface, still gated by allowCIDRs).'),
    listenPort: any('Port to listen on, plain HTTP (default 8443). Not the port DSH itself uses.'),
    allowCIDRs: any('The devices let in: their addresses, or private ranges, comma-separated or a list (default 100.64.0.0/10, the whole tailnet). With injectAuthCookie true, list your own devices\' tailnet addresses one by one (a range is refused); IPv6 works too.'),
    allowHosts: any('Names devices may use for this machine besides its IP addresses, such as mymac.example.ts.net or dsh.example.com (default none).'),
    allowThisMac: any('Let this machine\'s own programs through the edge (default false: they get a page instead). Only for a proxy on this machine, such as tailscale serve, in front of the edge.'),
    targetOrigin: any('Empty (default): the DSH this plugin runs in. Only for a DSH that does not say where its window server is: its loopback address, such as http://127.0.0.1:52817.'),
    discoverTarget: any('When DSH does not say where its window server is, look among this process\'s own ports, with lsof (default true).'),
    rewriteHost: any('Send DSH the loopback Host it requires (default true). Leave on.'),
    rewriteOrigin: any('Send DSH a loopback Origin and Referer, after the edge has checked them (default true). Leave on.'),
    injectAuthCookie: any('Sign in the devices listed in allowCIDRs with the desktop window\'s cookie, so that list is the only gate (default false: each device opens DSH\'s sign-in link once).'),
    cookieJar: any('The desktop window\'s cookie file (Electron), read-only, for injectAuthCookie.'),
    logFile: any('dsh-site\'s own log (listening, refusals, connections; never a cookie or token). Default dsh-site/site.log inside DSH\'s home. "" for none.'),
});

/** `~/` is the home folder; a relative path is inside DSH's home (DSH_HOME, else ~/.dsh). */
const expand = (p) => settingPath(p);

let version = '';
try {
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '';
} catch {}

export function apply(ctx, config) {
    const { settings, problems } = checkConfig(config);
    const log = createLog(settings.logFile ? expand(settings.logFile) : '');
    const logger = ctx.logger;

    if (problems.length > 0) {
        for (const problem of problems) {
            log.write(`not serving until a setting is fixed: ${problem.text}`);
            logger?.warn?.('dsh-site: not serving until a setting is fixed: %s', problem.text);
        }
        return;
    }
    if (!settings.enabled) {
        log.write('off (enabled is false): the port stays closed');
        logger?.info?.('dsh-site: off (enabled is false)');
        return;
    }

    // DSH's own window server, when this DSH has one: the edge serves the DSH it runs in, never another.
    // At a DSH start the service can come up after the edge has started looking, so its arrival looks again.
    let webServer;
    let edge;
    ctx.inject(['webServer'], (scope) => {
        const mine = scope.webServer;
        webServer = mine;
        edge?.refreshTarget();
        scope.effect(() => () => {
            if (webServer === mine) webServer = undefined;
        });
    });
    let noted = '';
    const note = (line) => {
        if (line !== noted) {
            noted = line;
            log.write(line);
        }
    };

    edge = createEdge({
        settings,
        log,
        logger,
        version,
        selfOrigin: () => originOf(webServer, note),
        listListeners: () => lsofListeners(process.pid),
        readCookie: (authority) => readJar(expand(settings.cookieJar), authority),
    });
    edge.start().catch(() => {});
    ctx.effect(() => () => edge.close());
}
