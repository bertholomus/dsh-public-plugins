// lib/http.js: where an account's password may go (sameService), what is
// this computer or its network (isLocal), and the redirects request()
// follows: the password only to the same host (iCloud's own hosts aside),
// and never from a server elsewhere to this computer or its network, by
// address or by a name that resolves there. No test asks DNS: each gives
// request() a resolver of its own.
//
//   node --test plugins/calendar/test/http.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, isLocal, request, sameService } from '../lib/http.js';

/** A fetch that answers from `routes` (url → {status, headers, body}; 404 otherwise) and records every call. */
function fakeFetch(routes) {
    const calls = [];
    async function fetch(url, init = {}) {
        calls.push({ url: String(url), headers: { ...(init.headers ?? {}) } });
        const { status = 200, body = null, headers = {} } = routes[String(url)] ?? { status: 404 };
        return new Response(body, { status, headers });
    }
    return { fetch, calls };
}

/** A resolver: the addresses `names` gives, any other name an address on the internet (TEST-NET-1). */
const resolver = (names = {}, asked = []) => async (hostname) => {
    asked.push(hostname);
    const found = names[hostname] ?? ['192.0.2.10'];
    if (found instanceof Error) throw found;
    return found;
};

const LOCAL = 'sent the request on to an address on this computer or its network, which isn\'t allowed.';

describe('sameService', () => {
    test('the same host, port and scheme only, not other hosts of the same domain', () => {
        assert.equal(sameService('https://dav.example.com/', 'https://dav.example.com/dav/calendars/'), true);
        assert.equal(sameService('https://dav.example.com/', 'https://DAV.Example.com:443/x'), true);
        assert.equal(sameService('http://127.0.0.1:5232/', 'http://127.0.0.1:5232/alice/'), true);
        for (const to of [
            'https://www.example.com/', 'https://example.com/', 'https://dav.example.com.evil.net/',
            'http://dav.example.com/', 'https://dav.example.com:8443/', 'not a URL',
        ]) assert.equal(sameService('https://dav.example.com/', to), false, to);
        // On a shared domain the old two-label rule gave the password to anyone's site.
        assert.equal(sameService('https://dav.example.co.uk/', 'https://other.co.uk/'), false);
        assert.equal(sameService('https://alice.example.com.au/', 'https://mallory.example.com.au/'), false);
        assert.equal(sameService('https://alice.hosting.example/', 'https://bob.hosting.example/'), false);
        assert.equal(sameService('http://127.0.0.1:5232/', 'http://localhost:5232/'), false);
        assert.equal(sameService('webcal://a.example/', 'webcal://a.example/'), false);
    });

    test('iCloud: one icloud.com host to another, over https', () => {
        assert.equal(sameService('https://caldav.icloud.com/', 'https://p52-caldav.icloud.com/1234567890/calendars/'), true);
        assert.equal(sameService('https://p52-caldav.icloud.com/', 'https://caldav.icloud.com:443/'), true);
        assert.equal(sameService('https://caldav.icloud.com/', 'https://icloud.com/'), true);
        for (const to of ['http://p52-caldav.icloud.com/', 'https://p52-caldav.icloud.com:8443/', 'https://caldav.icloud.com.evil.net/', 'https://evilicloud.com/', 'https://me.com/']) {
            assert.equal(sameService('https://caldav.icloud.com/', to), false, to);
        }
        assert.equal(sameService('https://dav.example.com/', 'https://p52-caldav.icloud.com/'), false);
    });
});

describe('isLocal', () => {
    test('loopback, private, link-local and unique-local addresses, and localhost and .local names', () => {
        for (const url of [
            'http://127.0.0.1:5232/', 'http://127.8.9.10/', 'http://localhost/', 'https://LOCALHOST./', 'https://calendar.localhost/', 'https://nas.local/',
            'https://10.1.2.3/', 'https://172.16.0.1/', 'https://172.31.255.254/', 'https://192.168.1.1/', 'https://169.254.169.254/latest/meta-data/',
            'https://100.64.0.1/', 'https://0.0.0.0/', 'http://0/',
            'https://[::1]/', 'https://[::]/', 'https://[fd12:3456::1]/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:c0a8:101]/',
            // Other spellings of 127.0.0.1, as a URL reads them.
            'http://2130706433/', 'http://0x7f.1/', 'http://127.1/',
        ]) assert.equal(isLocal(url), true, url);
    });

    test('not addresses or names on the internet, or what isn\'t a URL', () => {
        for (const url of [
            'https://example.com/', 'https://172.32.0.1/', 'https://100.128.0.1/', 'https://8.8.8.8/', 'https://192.0.2.10/', 'https://[2001:db8::1]/',
            'https://[::ffff:8.8.8.8]/', 'https://localhost.example.com/', 'https://local.example.com/', 'not a URL', '',
        ]) assert.equal(isLocal(url), false, url);
    });
});

describe('request: redirects', () => {
    test('the password follows a redirect to the same host, or to another icloud.com host, only', async () => {
        const auth = 'Basic YWxpY2U6c2VjcmV0';
        for (const [from, to, kept] of [
            ['https://dav.example.com/a', 'https://dav.example.com/b', true],
            ['https://dav.example.com/a', 'https://www.example.com/b', false],
            ['https://dav.example.co.uk/a', 'https://other.co.uk/b', false],
            ['https://caldav.icloud.com/a', 'https://p52-caldav.icloud.com/b', true],
        ]) {
            const { fetch, calls } = fakeFetch({ [from]: { status: 301, headers: { location: to } }, [to]: { body: 'ok' } });
            const res = await request(from, { headers: { Authorization: auth }, keepAuth: sameService, fetch, lookup: resolver() });
            assert.deepEqual([res.status, res.url, res.text], [200, to, 'ok']);
            assert.equal(calls[0].headers.Authorization, auth);
            assert.equal(calls[1].headers.Authorization, kept ? auth : undefined, to);
        }
    });

    test('a redirect from a server elsewhere to this computer or its network is refused, with no request there', async () => {
        const feed = 'https://feed.example.com/private/abc123/basic.ics?key=secret';
        for (const to of [
            'http://127.0.0.1:8080/admin', 'http://localhost:631/', 'https://10.0.0.1/', 'https://172.20.1.1/', 'https://192.168.1.1/',
            'http://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://[fd12:3456::1]/', 'https://[fe80::1]/',
            'https://[::ffff:127.0.0.1]/', 'http://2130706433/', 'https://printer.local/', 'https://0.0.0.0/', '//127.0.0.1/x',
        ]) {
            const { fetch, calls } = fakeFetch({ [feed]: { status: 302, headers: { location: to } } });
            await assert.rejects(request(feed, { fetch, lookup: resolver() }), (e) => e instanceof HttpError && e.code === 'insecure'
                && e.message === `feed.example.com ${LOCAL}`, to);
            assert.deepEqual(calls.map((c) => c.url), [feed], to);
        }
        // Further down a chain of redirects too.
        const { fetch, calls } = fakeFetch({
            [feed]: { status: 301, headers: { location: 'https://cdn.example.net/x.ics' } },
            'https://cdn.example.net/x.ics': { status: 307, headers: { location: 'http://127.0.0.1:9000/' } },
        });
        await assert.rejects(request(feed, { fetch, lookup: resolver() }), (e) => e.message === `cdn.example.net ${LOCAL}`);
        assert.equal(calls.length, 2);
    });

    test('a name that resolves to such an address is refused too; one that doesn\'t resolve, or stays on its host, is followed', async () => {
        const asked = [];
        const lookup = resolver({
            'sneaky.example.net': ['203.0.113.5', '127.0.0.1'],
            'v6.example.net': ['fd00::5'],
            'mapped.example.net': ['::ffff:192.168.0.10'],
            'gone.example.net': Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
        }, asked);
        for (const host of ['sneaky.example.net', 'v6.example.net', 'mapped.example.net']) {
            const { fetch, calls } = fakeFetch({ 'https://dav.example.com/': { status: 302, headers: { location: `https://${host}/dav/` } } });
            await assert.rejects(request('https://dav.example.com/', { fetch, lookup }), (e) => e.code === 'insecure' && e.message === `dav.example.com ${LOCAL}`, host);
            assert.equal(calls.length, 1, host);
        }
        // A name that doesn't resolve: followed (the request then fails on its own).
        const gone = fakeFetch({ 'https://dav.example.com/': { status: 302, headers: { location: 'https://gone.example.net/dav/' } }, 'https://gone.example.net/dav/': { body: 'here' } });
        assert.equal((await request('https://dav.example.com/', { fetch: gone.fetch, lookup })).text, 'here');
        // The same host (another path, another port) isn't looked up again.
        asked.length = 0;
        const same = fakeFetch({
            'https://dav.example.com/.well-known/caldav': { status: 301, headers: { location: '/dav/' } },
            'https://dav.example.com/dav/': { status: 307, headers: { location: 'https://dav.example.com:8443/dav/' } },
            'https://dav.example.com:8443/dav/': { body: 'dav' },
        });
        assert.equal((await request('https://dav.example.com/.well-known/caldav', { fetch: same.fetch, lookup })).text, 'dav');
        assert.deepEqual(asked, []);
    });

    test('a request that started on this computer or its network may be sent on within it', async () => {
        // A feed on this computer, sent on to another computer of the network.
        const here = fakeFetch({
            'http://127.0.0.1:5232/feed.ics': { status: 302, headers: { location: 'https://192.168.1.20/feed.ics' } },
            'https://192.168.1.20/feed.ics': { body: 'BEGIN:VCALENDAR' },
        });
        assert.equal((await request('http://127.0.0.1:5232/feed.ics', { fetch: here.fetch, lookup: resolver() })).url, 'https://192.168.1.20/feed.ics');
        // A server named by a name of the network (it resolves to one of its addresses), by way of a server elsewhere and back.
        const named = fakeFetch({
            'https://nas.example.net/cal/': { status: 302, headers: { location: 'https://login.example.org/sso' } },
            'https://login.example.org/sso': { status: 302, headers: { location: 'https://192.168.1.6/cal/' } },
            'https://192.168.1.6/cal/': { body: 'ok' },
        });
        const res = await request('https://nas.example.net/cal/', { fetch: named.fetch, lookup: resolver({ 'nas.example.net': ['192.168.1.5'] }) });
        assert.equal(res.url, 'https://192.168.1.6/cal/');
    });

    test('looking a name up is bounded by the timeout and the caller\'s signal', async () => {
        const { fetch } = fakeFetch({ 'https://dav.example.com/': { status: 302, headers: { location: 'https://slow.example.net/' } } });
        // A resolver that would answer in a minute (its timer keeps the test running, as a real lookup would).
        const timers = [];
        const slow = () => new Promise((resolve) => timers.push(setTimeout(resolve, 60_000, ['192.0.2.10'])));
        try {
            await assert.rejects(request('https://dav.example.com/', { fetch, lookup: slow, timeoutMs: 100 }), (e) => e instanceof HttpError && e.code === 'timeout');
            const stop = new AbortController();
            setTimeout(() => stop.abort(), 20);
            await assert.rejects(request('https://dav.example.com/', { fetch, lookup: slow, signal: stop.signal }), (e) => e instanceof HttpError && e.code === 'aborted');
        } finally {
            for (const timer of timers) clearTimeout(timer);
        }
    });
});
