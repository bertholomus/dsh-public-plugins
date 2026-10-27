import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedBy, inCidr, inRange, ipv4ToInt, ipv6ToBigInt, isLoopbackIp, normalizeIp, parseCidr } from '../../lib/cidr.js';

test('IPv4 ranges: the tailnet range, loopback, single addresses and /0', () => {
    assert.equal(inCidr('100.101.102.103', '100.64.0.0/10'), true);
    assert.equal(inCidr('100.63.255.255', '100.64.0.0/10'), false);
    assert.equal(inCidr('100.128.0.0', '100.64.0.0/10'), false);
    assert.equal(inCidr('127.0.0.1', '127.0.0.0/8'), true);
    assert.equal(inCidr('192.168.1.195', '127.0.0.0/8'), false);
    assert.equal(inCidr('10.1.2.3', '10.1.2.3'), true, 'a bare address is a /32');
    assert.equal(inCidr('10.1.2.4', '10.1.2.3'), false);
    assert.equal(inCidr('255.255.255.255', '0.0.0.0/0'), true);
    assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
    assert.equal(ipv4ToInt('1.2.3'), null);
});

test('a range is normalised to its network (host bits ignored)', () => {
    const r = parseCidr('100.101.102.103/10');
    assert.equal(r.family, 4);
    assert.equal(r.bits, 10);
    assert.equal(inRange('100.64.0.1', r), true);
});

test('IPv6 ranges: loopback, the Tailscale range, mapped IPv4 sources', () => {
    assert.equal(inCidr('::1', '::1/128'), true);
    assert.equal(inCidr('::2', '::1/128'), false);
    assert.equal(inCidr('fd7a:115c:a1e0:ab12::1', 'fd7a:115c:a1e0::/48'), true);
    assert.equal(inCidr('fd7a:115c:a1e1::1', 'fd7a:115c:a1e0::/48'), false);
    // A dual-stack listener sees IPv4 sources as ::ffff:a.b.c.d.
    assert.equal(normalizeIp('::ffff:100.101.102.103'), '100.101.102.103');
    assert.equal(inCidr('::ffff:100.101.102.103', '100.64.0.0/10'), true);
    assert.equal(inCidr('::ffff:192.168.1.5', '100.64.0.0/10'), false);
    assert.equal(ipv6ToBigInt('::ffff:1.2.3.4'), (0xffffn << 32n) + 0x01020304n);
    assert.equal(ipv6ToBigInt('[::1]'), 1n);
    assert.equal(ipv6ToBigInt('fe80::1%en0'), (0xfe80n << 112n) + 1n);
});

test('families never cross: an IPv6 source is not in an IPv4 range', () => {
    assert.equal(inCidr('::1', '127.0.0.0/8'), false);
    assert.equal(inCidr('127.0.0.1', '::1/128'), false);
});

test('anything that is not a range parses to null', () => {
    for (const bad of ['', ' ', 'tailnet', '100.64.0.0/33', '100.64.0.0/-1', '100.64.0.0/x', '::1/129', '300.1.1.1/8', '1.2.3.4/8/9', null, 42]) {
        assert.equal(parseCidr(bad), null, String(bad));
    }
    assert.equal(inCidr(undefined, '127.0.0.0/8'), false);
    assert.equal(inCidr('not-an-ip', '127.0.0.0/8'), false);
});

test('allowedBy checks every range; loopback is recognised in every form', () => {
    const ranges = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'].map(parseCidr);
    assert.equal(allowedBy(ranges, '100.100.1.1'), true);
    assert.equal(allowedBy(ranges, 'fd7a:115c:a1e0::5'), true);
    assert.equal(allowedBy(ranges, '127.0.0.1'), false);
    assert.equal(allowedBy([], '100.100.1.1'), false);
    assert.equal(isLoopbackIp('127.0.0.1'), true);
    assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackIp('::1'), true);
    assert.equal(isLoopbackIp('100.100.1.1'), false);
});
