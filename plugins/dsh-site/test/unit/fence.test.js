import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenceCheck, isIpHostname, isLoopbackHostname, parseAllowedHost, sameAuthority } from '../../lib/fence.js';

const allow = (...names) => names.map(parseAllowedHost);

test('a Host that is loopback or an IP literal passes; a name passes only when listed', () => {
    assert.equal(fenceCheck({ host: '127.0.0.1:8443' }), undefined);
    assert.equal(fenceCheck({ host: 'localhost:8443' }), undefined);
    assert.equal(fenceCheck({ host: '[::1]:8443' }), undefined);
    assert.equal(fenceCheck({ host: '100.101.102.103:8443' }), undefined);
    assert.equal(fenceCheck({ host: '[fd7a:115c:a1e0::5]:8443' }), undefined);
    assert.deepEqual(fenceCheck({ host: 'evil.example:8443' }), { kind: 'host', host: 'evil.example:8443' });
    assert.equal(fenceCheck({ host: 'mymac.example.ts.net:8443' }, allow('mymac.example.ts.net')), undefined);
    assert.equal(fenceCheck({ host: 'MyMac.Example.ts.net:8443' }, allow('mymac.example.ts.net')), undefined, 'names compare without case');
    assert.equal(fenceCheck({ host: 'dsh.example.com:8443' }, allow('dsh.example.com:8443')), undefined);
    assert.equal(fenceCheck({ host: 'dsh.example.com:9000' }, allow('dsh.example.com:8443'))?.kind, 'host', 'a name with a port matches that port only');
    assert.equal(fenceCheck({ host: 'dsh.example.com' }, allow('dsh.example.com:80')), undefined, 'the default port counts as written');
    assert.equal(fenceCheck({ host: 'sub.dsh.example.com:8443' }, allow('dsh.example.com'))?.kind, 'host', 'no suffix matching');
});

test('a missing or malformed Host is refused', () => {
    assert.equal(fenceCheck({})?.kind, 'bad-host');
    assert.equal(fenceCheck({ host: '' })?.kind, 'bad-host');
    assert.equal(fenceCheck({ host: 'user@127.0.0.1:8443' })?.kind, 'bad-host');
    assert.equal(fenceCheck({ host: '127.0.0.1:8443/path' })?.kind, 'bad-host');
    assert.equal(fenceCheck({ host: 'a b' })?.kind, 'bad-host');
});

test('DNS rebinding: a page on a name that now points here is refused, whatever its Origin says', () => {
    assert.equal(fenceCheck({ host: 'rebind.attacker.example:8443', origin: 'http://rebind.attacker.example:8443' })?.kind, 'host');
});

test('cross-site: Sec-Fetch-Site cross-site and a foreign Origin are refused; the same address passes', () => {
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', 'sec-fetch-site': 'cross-site' })?.kind, 'cross-site');
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', 'sec-fetch-site': 'same-origin' }), undefined);
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', origin: 'http://evil.example' })?.kind, 'cross-site');
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', origin: 'http://evil.example' }).origin, 'http://evil.example');
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', origin: 'null' })?.kind, 'cross-site');
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', origin: 'http://100.101.102.103:9999' })?.kind, 'cross-site', 'another port is another site');
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', origin: 'file://' })?.kind, 'cross-site');
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', origin: 'http://100.101.102.103:8443' }), undefined);
    assert.equal(fenceCheck({ host: 'mymac.example.ts.net:8443', origin: 'http://mymac.example.ts.net:8443' }, allow('mymac.example.ts.net')), undefined);
    assert.equal(fenceCheck({ host: 'mymac.example.ts.net:8443', origin: 'http://100.101.102.103:8443' }, allow('mymac.example.ts.net'))?.kind, 'cross-site', 'the IP and the name are different sites');
});

test('helpers: loopback and IP hostnames, same authority under http and https', () => {
    assert.equal(isLoopbackHostname('127.9.9.9'), true);
    assert.equal(isLoopbackHostname('128.0.0.1'), false);
    assert.equal(isIpHostname('[::1]'), true);
    assert.equal(isIpHostname('::1'), false, 'a URL hostname brackets IPv6');
    assert.equal(isIpHostname('dsh.example.com'), false);
    assert.equal(sameAuthority('https://dsh.example.com', 'dsh.example.com:443'), true);
    assert.equal(sameAuthority('http://dsh.example.com', 'dsh.example.com:80'), true);
    assert.equal(sameAuthority('not a url', 'dsh.example.com'), false);
});

test('allowHosts entries are checked: no wildcards, no paths, no empty names', () => {
    assert.deepEqual(parseAllowedHost('  Dsh.Example.com '), { hostname: 'dsh.example.com', host: 'dsh.example.com', port: '' });
    assert.deepEqual(parseAllowedHost('dsh.example.com:8443'), { hostname: 'dsh.example.com', host: 'dsh.example.com:8443', port: '8443' });
    assert.match(parseAllowedHost('*.ts.net').error, /wildcard/);
    assert.match(parseAllowedHost('dsh.example.com/x').error, /not a host name/);
    assert.match(parseAllowedHost('').error, /empty/);
    assert.match(parseAllowedHost(42).error, /empty/);
});

test('a frame, embed or object load marked as from another origin is refused; DSH framing itself is not', () => {
    for (const dest of ['iframe', 'frame', 'embed', 'object', 'fencedframe']) {
        for (const site of ['same-site', 'cross-site']) {
            const got = fenceCheck({ host: '100.101.102.103:8443', 'sec-fetch-site': site, 'sec-fetch-dest': dest });
            assert.equal(got?.kind, 'framed', `${site} ${dest}`);
            assert.equal(got.dest, dest);
        }
    }
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' }), undefined);
    assert.equal(fenceCheck({ host: '100.101.102.103:8443', 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'image' }), undefined, 'a same-site image is not a frame (the edge\'s answers keep other sites from reading it)');
    assert.equal(fenceCheck({ host: '100.101.102.103:8443' }), undefined, 'over plain HTTP a browser marks nothing: the answer headers carry the rule');
});
