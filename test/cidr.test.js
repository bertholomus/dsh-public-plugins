import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inCidr, ipv4ToInt } from '../plugins/dsh-site/lib/cidr.js';

test('ipv4ToInt parses and rejects', () => {
    assert.equal(ipv4ToInt('0.0.0.0'), 0);
    assert.equal(ipv4ToInt('255.255.255.255'), 0xffffffff);
    assert.equal(ipv4ToInt('256.0.0.1'), null);
    assert.equal(ipv4ToInt('1.2.3'), null);
});

test('tailscale CGNAT range', () => {
    assert.equal(inCidr('100.64.0.1', '100.64.0.0/10'), true);
    assert.equal(inCidr('100.127.255.254', '100.64.0.0/10'), true);
    assert.equal(inCidr('100.128.0.1', '100.64.0.0/10'), false);
    assert.equal(inCidr('192.168.1.10', '100.64.0.0/10'), false);
});

test('loopback and edge cases', () => {
    assert.equal(inCidr('127.0.0.1', '127.0.0.0/8'), true);
    assert.equal(inCidr('::1', '::1/128'), true);
    assert.equal(inCidr('fe80::1', '::1/128'), false);
    assert.equal(inCidr('fe80::1', '100.64.0.0/10'), false);
    assert.equal(inCidr('10.0.0.1', '0.0.0.0/0'), true);
    assert.equal(inCidr('10.0.0.1', '10.0.0.1/32'), true);
    assert.equal(inCidr('10.0.0.2', '10.0.0.1/32'), false);
    assert.equal(inCidr(undefined, '0.0.0.0/0'), false);
    assert.equal(inCidr('10.0.0.1', 'bad'), false);
});
