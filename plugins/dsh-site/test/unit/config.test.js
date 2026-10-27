import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig, DEFAULTS, didYouMean, dshHomeOf, isLoopbackRange, isPrivateRange, listenLabel, NO_SETTINGS, REQUIRED, settingPath } from '../../lib/config.js';
import { parseCidr } from '../../lib/cidr.js';

const keys = (problems) => problems.map((p) => p.key);
const L = { listenHost: '127.0.0.1' };

test('a row that names where to listen needs nothing else: the defaults are right', () => {
    const { settings, problems } = checkConfig({ listenHost: '100.101.102.103' });
    assert.deepEqual(problems, []);
    assert.equal(settings.enabled, true);
    assert.equal(settings.listenHost, '100.101.102.103');
    assert.equal(settings.listenPort, 8443);
    assert.deepEqual(settings.allowCIDRs.map((r) => r.text), ['100.64.0.0/10'], 'the tailnet, not this Mac itself');
    assert.equal(settings.allowThisMac, false, 'this Mac\'s own programs are refused unless the row lets them in');
    assert.deepEqual(settings.allowHosts, []);
    assert.equal(settings.targetOrigin, '', 'empty: the DSH the plugin runs in');
    assert.equal(settings.injectAuthCookie, false, 'off unless the row turns it on');
    assert.equal(listenLabel(settings), '100.101.102.103:8443');
});

test('no settings at all (a plugin listed in the profile\'s bundles, its row gone): not serving, and it says what to do', () => {
    for (const raw of [{}, null, undefined, 'x', [], 7]) {
        const { problems } = checkConfig(raw);
        assert.deepEqual(problems, [{ key: 'config', text: NO_SETTINGS }], JSON.stringify(raw));
    }
    assert.match(NO_SETTINGS, /does not serve/);
    assert.match(NO_SETTINGS, /at least listenHost/);
    assert.match(NO_SETTINGS, /DSH's Plugins page, which takes dsh-plugin-dsh-site out of the profile's bundles/);
});

test('listenHost has no default: without it nothing is served; only enabled: false needs no address', () => {
    assert.deepEqual(REQUIRED, ['listenHost']);
    const { problems } = checkConfig({ listenPort: 9443, injectAuthCookie: true });
    assert.deepEqual(keys(problems), ['listenHost']);
    assert.match(problems[0].text, /listenHost is not set: set it to this Mac's tailnet address, such as "100\.101\.102\.103" \(only that network reaches the edge\)/);
    assert.deepEqual(checkConfig({ listenHost: '' }).problems.map((p) => p.key), ['listenHost']);
    assert.deepEqual(checkConfig({ enabled: false }).problems, [], 'off needs no address');
    assert.equal(checkConfig({ enabled: false }).settings.enabled, false);
});

test('a key that is not a setting keeps the port closed, named, with the setting it most likely means', () => {
    const one = (key, value = false) => checkConfig({ ...L, [key]: value }).problems;
    assert.deepEqual(keys(one('enable')), ['enable']);
    assert.equal(one('enable')[0].text, '"enable" is not a dsh-site setting: did you mean enabled?');
    assert.match(one('allowCidrs', '100.64.0.0/10')[0].text, /did you mean allowCIDRs\?/);
    assert.match(one('listen_port', 9000)[0].text, /did you mean listenPort\?/);
    assert.match(one('injectAuthCookies', true)[0].text, /did you mean injectAuthCookie\?/);
    assert.match(one('frobnicate')[0].text, /"frobnicate" is not a dsh-site setting \(the README lists every setting\)/);
    assert.equal(didYouMean('port'), 'listenPort');
    assert.equal(didYouMean('cidrs'), 'allowCIDRs');
    assert.equal(didYouMean('host'), undefined, 'two settings contain it: no guess');
    assert.equal(didYouMean('ENABLED'), 'enabled');
});

test('a 0.1 row (every interface, loopback and the whole tailnet in allowCIDRs, cookie mode) is named, not served; with the devices listed it serves', () => {
    const row = {
        listenHost: '0.0.0.0',
        listenPort: 8443,
        targetOrigin: 'http://127.0.0.1:52817',
        allowCIDRs: '100.64.0.0/10,127.0.0.0/8,::1/128',
        injectAuthCookie: true,
        cookieJar: '~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies',
        logFile: '~/.dsh/dsh-site/site.log',
    };
    const old = checkConfig(row).problems;
    assert.deepEqual(keys(old), ['allowCIDRs', 'allowCIDRs', 'allowCIDRs'], 'both loopback ranges and the tailnet range are named');
    assert.match(old[0].text, /allowCIDRs has "127\.0\.0\.0\/8", which is this Mac itself: through the edge every program and every account on this Mac would reach DSH, with no sign-in when injectAuthCookie is true\. Take it out .* or set allowThisMac to true/);
    assert.match(old[2].text, /allowCIDRs has "100\.64\.0\.0\/10", a range: with injectAuthCookie true the edge signs in every device it lets in/);
    assert.deepEqual(keys(checkConfig({ ...row, allowCIDRs: '100.64.0.0/10' }).problems), ['allowCIDRs'], 'this Mac taken out, the whole tailnet is still named');
    const { settings, problems } = checkConfig({ ...row, allowCIDRs: '100.101.102.104,100.101.102.105' });
    assert.deepEqual(problems, []);
    assert.equal(settings.targetOrigin, 'http://127.0.0.1:52817');
    assert.equal(settings.injectAuthCookie, true);
});

test('this Mac itself: a loopback range in allowCIDRs needs allowThisMac; per-device addresses are the way to list devices', () => {
    for (const loop of ['127.0.0.0/8', '127.0.0.1', '::1/128', '::1']) {
        assert.deepEqual(keys(checkConfig({ ...L, allowCIDRs: loop }).problems), ['allowCIDRs'], loop);
        assert.deepEqual(checkConfig({ ...L, allowCIDRs: loop, allowThisMac: true }).problems, [], `${loop} with allowThisMac`);
    }
    assert.equal(isLoopbackRange(parseCidr('127.0.0.0/8')), true);
    assert.equal(isLoopbackRange(parseCidr('100.64.0.0/10')), false);
    const devices = checkConfig({ ...L, allowCIDRs: '100.101.102.104,100.101.102.105/32,fd7a:115c:a1e0::104' });
    assert.deepEqual(devices.problems, []);
    assert.deepEqual(devices.settings.allowCIDRs.map((r) => r.bits), [32, 32, 128], 'single addresses are single devices');
    assert.equal(checkConfig({ ...L, allowThisMac: 'yes' }).problems[0].text, 'allowThisMac must be true or false (it is "yes")');
});

test('with injectAuthCookie true, devices that can reach the port are listed one by one: a range would sign in every device in it', () => {
    const T = { listenHost: '100.101.102.103', injectAuthCookie: true };
    const byDefault = checkConfig(T).problems;
    assert.deepEqual(keys(byDefault), ['allowCIDRs'], 'the default range, the whole tailnet, is not a list of devices');
    assert.equal(
        byDefault[0].text,
        'allowCIDRs has "100.64.0.0/10" (its default), a range: with injectAuthCookie true the edge signs in every device it lets in, so every device in that range would get DSH with no sign-in. List your own devices one by one, such as "100.101.102.104,100.101.102.105" (tailscale status lists them), or set injectAuthCookie to false so that each device signs in with DSH\'s own link',
    );
    assert.deepEqual(checkConfig({ ...T, allowCIDRs: '100.101.102.104,100.101.102.105/32,fd7a:115c:a1e0::104' }).problems, [], 'single addresses');
    const mixed = checkConfig({ ...T, allowCIDRs: '100.101.102.104,100.101.102.0/24' }).problems;
    assert.deepEqual(keys(mixed), ['allowCIDRs'], 'only the range is named');
    assert.match(mixed[0].text, /^allowCIDRs has "100\.101\.102\.0\/24", a range:/);
    for (const host of ['0.0.0.0', '::', '192.168.1.20']) assert.deepEqual(keys(checkConfig({ ...T, listenHost: host, allowCIDRs: '192.168.1.0/24' }).problems), ['allowCIDRs'], host);
    assert.deepEqual(checkConfig({ ...T, injectAuthCookie: false }).problems, [], 'DSH\'s own sign-in is the gate: a range is fine');
    assert.deepEqual(checkConfig({ ...T, enabled: false }).problems, [], 'off serves no one');
    assert.deepEqual(checkConfig({ ...T, allowThisMac: true, allowCIDRs: '127.0.0.0/8,::1/128,100.101.102.104' }).problems, [], 'a loopback entry is this Mac (allowThisMac decides), not a range of devices');
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
        assert.deepEqual(checkConfig({ ...T, listenHost: host, allowThisMac: true }).problems, [], `${host}: only this Mac reaches the port (tailscale serve in front)`);
    }
});

test('paths: ~/ is the home folder; a relative path, the default log among them, is inside DSH\'s home (DSH_HOME, else ~/.dsh)', () => {
    assert.equal(DEFAULTS.logFile, 'dsh-site/site.log');
    assert.equal(dshHomeOf({}, '/Users/me'), '/Users/me/.dsh');
    assert.equal(dshHomeOf({ DSH_HOME: '   ' }, '/Users/me'), '/Users/me/.dsh', 'a blank DSH_HOME is unset, as DSH treats it');
    assert.equal(dshHomeOf({ DSH_HOME: '/tmp/test-home' }, '/Users/me'), '/tmp/test-home');
    assert.equal(dshHomeOf({ DSH_HOME: '~/other-dsh' }, '/Users/me'), '/Users/me/other-dsh');
    const env = { DSH_HOME: '/tmp/test-home' };
    assert.equal(settingPath(DEFAULTS.logFile, { env, home: '/Users/me' }), '/tmp/test-home/dsh-site/site.log', 'the log of a DSH with its own home stays in that home');
    assert.equal(settingPath(DEFAULTS.logFile, { env: {}, home: '/Users/me' }), '/Users/me/.dsh/dsh-site/site.log');
    assert.equal(settingPath('~/x/site.log', { env, home: '/Users/me' }), '/Users/me/x/site.log');
    assert.equal(settingPath('/var/log/site.log', { env, home: '/Users/me' }), '/var/log/site.log');
    assert.equal(settingPath('', { env, home: '/Users/me' }), '', 'no log stays no log');
});

test('a number or a switch in quotes is taken as meant', () => {
    const { settings, problems } = checkConfig({ ...L, listenPort: '9443', enabled: 'true', injectAuthCookie: 'false' });
    assert.deepEqual(problems, []);
    assert.equal(settings.listenPort, 9443);
    assert.equal(settings.enabled, true);
    assert.equal(settings.injectAuthCookie, false);
});

test('lists work as YAML lists or as one comma-separated text', () => {
    const a = checkConfig({ ...L, allowCIDRs: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'], allowHosts: ['mymac.example.ts.net', 'dsh.example.com:8443'] });
    assert.deepEqual(a.problems, []);
    assert.deepEqual(a.settings.allowCIDRs.map((r) => r.text), ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']);
    assert.deepEqual(a.settings.allowHosts.map((h) => h.host), ['mymac.example.ts.net', 'dsh.example.com:8443']);
    const b = checkConfig({ ...L, allowHosts: 'mymac.example.ts.net, dsh.example.com' });
    assert.deepEqual(b.settings.allowHosts.map((h) => h.host), ['mymac.example.ts.net', 'dsh.example.com']);
});

test('every wrong value is named, says what it must be, and shows what it is', () => {
    const { problems } = checkConfig({
        enabled: 'yes',
        listenHost: 'my mac',
        listenPort: 'abc',
        allowCIDRs: '100.64.0.0/10, 10.0.0.0/33, tailnet',
        allowHosts: '*.ts.net',
        targetOrigin: 'http://example.com:80',
        discoverTarget: 1,
        rewriteHost: 'no',
        rewriteOrigin: [],
        injectAuthCookie: 'on',
        cookieJar: 5,
        logFile: false,
    });
    assert.deepEqual(keys(problems), ['enabled', 'listenHost', 'listenPort', 'allowCIDRs', 'allowCIDRs', 'allowHosts', 'targetOrigin', 'discoverTarget', 'rewriteHost', 'rewriteOrigin', 'injectAuthCookie', 'cookieJar', 'logFile']);
    const text = problems.map((p) => p.text).join('\n');
    assert.match(text, /enabled must be true or false \(it is "yes"\)/);
    assert.match(text, /listenHost must be an IP address of this machine/);
    assert.match(text, /listenPort must be a whole number from 1 to 65535, such as 8443 \(it is "abc"\)/);
    assert.match(text, /allowCIDRs has "10\.0\.0\.0\/33", which is not an address range/);
    assert.match(text, /allowCIDRs has "tailnet"/);
    assert.match(text, /allowHosts has "\*\.ts\.net" has a wildcard/);
    assert.match(text, /targetOrigin must be empty \(the DSH this plugin runs in\) or a loopback address/);
    assert.match(text, /cookieJar must be a path/);
    assert.match(text, /logFile must be a path .* or "" for none \(it is false\)/);
});

test('ports out of range, ranges that let everyone in, and an empty list are refused', () => {
    for (const port of [0, 65536, -1, 8443.5, '84 43']) assert.deepEqual(keys(checkConfig({ ...L, listenPort: port }).problems), ['listenPort'], String(port));
    assert.match(checkConfig({ ...L, allowCIDRs: '0.0.0.0/0' }).problems[0].text, /lets in every address/);
    assert.match(checkConfig({ ...L, allowCIDRs: '::/0' }).problems[0].text, /lets in every address/);
    assert.match(checkConfig({ ...L, allowCIDRs: '' }).problems[0].text, /allowCIDRs is empty, so no device could reach the edge/);
    assert.match(checkConfig({ ...L, allowCIDRs: 42 }).problems[0].text, /allowCIDRs must list addresses or ranges/);
});

test('allowCIDRs takes private networks only: all of IPv4 in two halves, or a public range, is refused', () => {
    const refused = (text) => checkConfig({ ...L, allowCIDRs: text }).problems.filter((p) => p.key === 'allowCIDRs').length;
    assert.equal(refused('0.0.0.0/1,128.0.0.0/1'), 2, 'every IPv4 address in two ranges');
    for (const pub of ['8.8.8.0/24', '8.8.8.8', '100.0.0.0/8', '10.0.0.0/7', '172.32.0.0/16', '96.0.0.0/3', '2001:db8::/32', '::/1', '::ffff:0:0/96']) assert.equal(refused(pub), 1, pub);
    for (const ok of ['100.64.0.0/10', '100.101.102.103', '10.1.0.0/16', '172.16.0.0/12', '192.168.1.0/24', '169.254.0.0/16', 'fd7a:115c:a1e0::/48', 'fe80::/10']) assert.equal(refused(ok), 0, ok);
    assert.match(checkConfig({ ...L, allowCIDRs: '8.8.8.0/24' }).problems[0].text, /allowCIDRs has "8\.8\.8\.0\/24", which is not inside a private network/);
    assert.equal(isPrivateRange(parseCidr('100.64.0.0/9')), false, 'wider than the tailnet range');
});

test('targetOrigin: only a loopback http origin with a port, normalised', () => {
    assert.equal(checkConfig({ ...L, targetOrigin: 'http://127.0.0.1:52817/' }).settings.targetOrigin, 'http://127.0.0.1:52817');
    assert.equal(checkConfig({ ...L, targetOrigin: 'http://[::1]:52817' }).settings.targetOrigin, 'http://[::1]:52817');
    assert.equal(checkConfig({ ...L, targetOrigin: 'http://localhost:52817' }).settings.targetOrigin, 'http://localhost:52817');
    for (const bad of ['https://127.0.0.1:52817', 'http://127.0.0.1', 'http://100.101.102.103:52817', 'http://127.0.0.1:52817/app', '127.0.0.1:52817', 7]) {
        assert.deepEqual(keys(checkConfig({ ...L, targetOrigin: bad }).problems), ['targetOrigin'], String(bad));
    }
});

test('logFile "" turns the log off; IPv6 listen addresses are accepted', () => {
    assert.equal(checkConfig({ logFile: '' }).settings.logFile, '');
    assert.deepEqual(checkConfig({ listenHost: '::' }).problems, []);
    assert.equal(listenLabel(checkConfig({ listenHost: '::1', listenPort: 9000 }).settings), '[::1]:9000');
});

test('every setting comes back checked, with its default standing in where the row says nothing', () => {
    assert.deepEqual(Object.keys(DEFAULTS).sort(), Object.keys(checkConfig({}).settings).sort());
    assert.deepEqual(Object.keys(DEFAULTS).sort(), Object.keys(checkConfig(L).settings).sort());
});
