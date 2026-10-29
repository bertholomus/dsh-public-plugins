import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPath, routeFor } from '../src/router.js';

const routes = [
    { prefix: '/api', upstream: 'api' },
    { prefix: '/api/orders', upstream: 'orders' },
    { prefix: '/status', upstream: 'local' },
];

test('the longest prefix wins', () => assert.equal(routeFor(routes, '/api/orders/17').upstream, 'orders'));
test('a shorter prefix still matches', () => assert.equal(routeFor(routes, '/api/users').upstream, 'api'));
test('an exact path matches', () => assert.equal(routeFor(routes, '/status').upstream, 'local'));
test('a prefix matches only at a slash', () => assert.equal(routeFor(routes, '/statuses'), undefined));
test('no route for an unknown path', () => assert.equal(routeFor(routes, '/admin'), undefined));
test('the query is not part of the path', () => assert.equal(cleanPath('/api/orders?page=2'), '/api/orders'));
test('repeated slashes fold into one', () => assert.equal(cleanPath('/api//orders///17'), '/api/orders/17'));
test('a trailing slash is dropped', () => assert.equal(cleanPath('/status/'), '/status'));
