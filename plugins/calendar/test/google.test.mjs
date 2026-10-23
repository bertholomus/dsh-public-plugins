/**
 * Google Calendar source and OAuth tests, against the stand-in in
 * test/standins/google.mjs: the sign-in through the loopback and pasted,
 * the scopes it asks for and the ones it needs, renewing and revoking
 * tokens, calendars, full and incremental sync, changes (conditional, and
 * a create sent twice made once), series with changed and cancelled
 * occurrences, all-day events and time zones.
 *
 * Run: node --test plugins/calendar/test/google.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { HttpError, request } from '../lib/http.js';
import { accessToken, idTokenClaims, pkce, randomState, refreshGrant } from '../lib/oauth.js';
import * as google from '../lib/sources/google.js';
import { SourceError } from '../lib/sources/index.js';
import { start } from './standins/google.mjs';

const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';

/** The scopes the sign-in asks for, and the broad one it asked for before. */
const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const BROAD_SCOPE = 'https://www.googleapis.com/auth/calendar';

/**
 * Whether the two narrow scopes allow an API request, by Google's API
 * reference: reading the calendar list (calendar.calendarlist.readonly),
 * and listing, reading, adding, changing, deleting and moving events and
 * listing a series' instances (calendar.events).
 */
function narrowAllows({ method, path }) {
    if (/^\/calendar\/v3\/users\/me\/calendarList(?:\/[^/]+)?$/.test(path)) return method === 'GET';
    return /^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/[^/]+(?:\/(?:instances|move))?)?$/.test(path);
}

/**
 * The stand-in knows only Google's broad calendar scope. A token with both
 * narrow ones passes its check as if it had the broad one (what the client
 * is told it got stays as asked), and the test ends by checking that each
 * API request it saw is one the narrow scopes allow.
 */
function narrowScopes(t, store) {
    store.accessTokens = new (class extends Map {
        set(token, record) {
            const scopes = record.scope.split(' ');
            const both = scopes.includes(EVENTS_SCOPE) && scopes.includes(LIST_SCOPE);
            return super.set(token, both ? { ...record, scope: `${record.scope} ${BROAD_SCOPE}` } : record);
        }
    })();
    const outside = [];
    store.requests = new (class extends Array {
        // filter and map give plain arrays.
        static get [Symbol.species]() {
            return Array;
        }

        push(...requests) {
            for (const r of requests) if (!narrowAllows(r)) outside.push(`${r.method} ${r.path}`);
            return super.push(...requests);
        }
    })();
    t.after(() => assert.deepEqual(outside, [], 'requests the narrow scopes don\'t allow'));
}

/** A wall clock in a zone, as the stand-in takes it (Google reads dateTime without an offset in timeZone). */
const at = (local, timeZone = LA) => ({ dateTime: local, timeZone });
/** A record time. */
const wall = (local, tz = LA) => ({ local, tz });

/** A secret in memory, as DSH's credential store behaves. */
function memorySecret(initial) {
    let value = initial;
    return {
        get: async () => value,
        set: async (next) => {
            value = structuredClone(next);
        },
        clear: async () => {
            value = undefined;
        },
        peek: () => value,
    };
}

/** A stand-in and a source env for one test, closed when the test ends. */
async function setup(t, { zone = LA, settings = {} } = {}) {
    const server = await start();
    t.after(() => server.close());
    narrowScopes(t, server.store);
    const clock = { shift: 0 };
    const logs = [];
    const env = {
        request: (url, init) => request(url, init),
        secret: memorySecret(),
        log: (line) => logs.push(line),
        now: () => Date.now() + clock.shift,
        zone,
        settings: { ...server.settings, ...settings },
    };
    return { server, store: server.store, env, logs, clock, cal: server.store.user.email };
}

/** setup, then the whole sign-in through the loopback, the grant saved, and a source. */
async function signedIn(t, options) {
    const ctx = await setup(t, options);
    const flow = await google.signIn(ctx.env);
    const page = await fetch(flow.url);
    assert.equal(page.status, 200);
    const who = await flow.done;
    await ctx.env.secret.set(who.grant);
    const source = google.create({ id: 'acct-1', kind: 'google', name: 'Google', email: who.email }, ctx.env);
    const [calendar] = await source.calendars();
    ctx.store.requests.length = 0;
    return { ...ctx, who, source, calendar };
}

/**
 * Google's revoke endpoint, beside the stand-in: a refresh token it issued
 * ends its grant (its access tokens too), a live access token ends itself,
 * both with 200; a token it doesn't know, or already revoked, gets Google's
 * 400 invalid_token. With `control.answer` set, every request gets that
 * instead. `seen` keeps each request.
 */
async function revokeStandIn(t, store) {
    const seen = [];
    const control = { answer: undefined };
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
        const send = (status, payload) => {
            const text = JSON.stringify(payload);
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
            res.end(text);
        };
        if (control.answer) return send(control.answer.status, control.answer.body);
        const token = new URLSearchParams(body).get('token') ?? '';
        const refresh = store.refreshTokens.get(token);
        const access = store.accessTokens.get(token);
        if (refresh !== undefined && !refresh.revoked) {
            refresh.revoked = true;
            store.expireAccessTokens();
            return send(200, {});
        }
        if (access !== undefined && access.expiresAt > Date.now()) {
            access.expiresAt = 0;
            return send(200, {});
        }
        return send(400, { error: 'invalid_token', error_description: 'Token expired or revoked' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const close = () => new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
    t.after(close);
    return { url: `http://127.0.0.1:${server.address().port}/revoke`, seen, control, close };
}

/** The item whose (first) record has this title. */
const titled = (items, title) => items.find((item) => item.events[0].title === title);

/** API requests seen by the stand-in since the last reset, as "METHOD path" with the query. */
const requestsOf = (store, method, pathEnd) => store.requests.filter((r) => r.method === method && r.path.endsWith(pathEnd));

/** Nothing secret in these texts: tokens, codes, the client secret. */
function assertNoSecrets(ctx, texts) {
    const secrets = [
        ctx.env.settings.googleClientSecret,
        ...ctx.store.accessTokens.keys(), ...ctx.store.refreshTokens.keys(), ...ctx.store.codes.keys(),
    ];
    for (const text of texts) {
        for (const secret of secrets) assert.ok(!String(text).includes(secret), `a secret leaked into: ${text}`);
        assert.doesNotMatch(String(text), /[?&](code|access_token|refresh_token|client_secret)=/);
    }
}

test('pkce gives an S256 pair; states and verifiers are random', () => {
    const a = pkce();
    const b = pkce();
    assert.match(a.verifier, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.equal(a.method, 'S256');
    assert.equal(a.challenge, createHash('sha256').update(a.verifier, 'ascii').digest('base64url'));
    assert.notEqual(a.verifier, b.verifier);
    assert.notEqual(randomState(), randomState());
});

test('sign-in through the loopback redirect', async (t) => {
    const { env, store } = await setup(t);
    const flow = await google.signIn(env);
    const url = new URL(flow.url);
    assert.equal(`${url.origin}${url.pathname}`, env.settings.googleAuthorizeUrl);
    const q = url.searchParams;
    assert.match(flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(q.get('redirect_uri'), flow.redirectUri);
    assert.equal(q.get('client_id'), env.settings.googleClientId);
    assert.equal(q.get('response_type'), 'code');
    // The events and the list of calendars, not the broad scope that also shares and deletes calendars.
    assert.deepEqual(q.get('scope').split(' '), [EVENTS_SCOPE, LIST_SCOPE, 'openid', 'email']);
    assert.deepEqual(google.SCOPES, [EVENTS_SCOPE, LIST_SCOPE, 'openid', 'email']);
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.get('access_type'), 'offline');
    assert.equal(q.get('prompt'), 'consent');
    assert.ok(q.get('state').length >= 32);
    assert.equal(q.get('client_secret'), null);

    // An answer with another state (an old tab, or a forged link) is turned away; the sign-in goes on.
    const forged = await fetch(`${flow.redirectUri}?state=forged&code=4/0Aforged`);
    assert.equal(forged.status, 400);
    assert.match(await forged.text(), /another sign-in/);
    assert.equal((await fetch(`${flow.redirectUri}favicon.ico`)).status, 404);
    assert.deepEqual(store.tokenRequests, []);

    // The browser: Google's page sends it to the loopback, which trades the code.
    const page = await fetch(flow.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /signed in\. You can close this tab/);
    const { grant, email, name } = await flow.done;
    assert.equal(email, store.user.email);
    assert.equal(name, undefined, 'no profile scope, no name');
    assert.equal(grant.tokenType, 'Bearer');
    assert.ok(store.accessTokens.has(grant.accessToken));
    assert.ok(store.refreshTokens.has(grant.refreshToken));
    assert.ok(Math.abs(grant.expiresAt - (Date.now() + 3599_000)) < 10_000);
    const granted = grant.scope.split(' ');
    assert.ok(granted.includes(EVENTS_SCOPE) && granted.includes(LIST_SCOPE) && !granted.includes(BROAD_SCOPE));
    assert.equal(idTokenClaims(grant.idToken).aud, env.settings.googleClientId);
    assert.deepEqual(store.tokenRequests, [{ grantType: 'authorization_code' }]);
    // One use: the loopback is closed now.
    await assert.rejects(fetch(flow.redirectUri));
});

test('sign-in with the address pasted from a browser on another device', async (t) => {
    const { env, store } = await setup(t);
    const flow = await google.signIn(env);
    // The browser can't reach this computer: the user copies the address it ended on.
    const consent = await fetch(flow.url, { redirect: 'manual' });
    assert.equal(consent.status, 302);
    const pasted = consent.headers.get('location');
    assert.ok(pasted.startsWith(flow.redirectUri));
    assert.match(new URL(pasted).searchParams.get('code'), /^4\/0A/);

    // An address from another sign-in, or not an address at all, is refused; the sign-in goes on.
    const other = new URL(pasted);
    other.searchParams.set('state', 'from-another-sign-in');
    await assert.rejects(flow.finish(other.toString()), (e) => e instanceof SourceError && e.code === 'auth' && /another sign-in/.test(e.message));
    await assert.rejects(flow.finish('hello'), (e) => e.code === 'auth' && e.message.includes(flow.redirectUri));
    assert.deepEqual(store.tokenRequests, []);

    // Just the part after "?" will do.
    const result = await flow.finish(`  ${pasted.slice(pasted.indexOf('?'))}  `);
    assert.equal(result.email, store.user.email);
    assert.ok(store.refreshTokens.has(result.grant.refreshToken));
    assert.equal((await flow.done).grant.accessToken, result.grant.accessToken);
    // The same answer again gives the same grant, without a second exchange.
    assert.equal((await flow.finish(pasted)).grant.accessToken, result.grant.accessToken);
    assert.deepEqual(store.tokenRequests, [{ grantType: 'authorization_code' }]);
    await assert.rejects(fetch(flow.redirectUri));
});

test('a refusal on the consent page ends the sign-in in plain words', async (t) => {
    const { env, store } = await setup(t);
    store.consent = 'deny';
    const flow = await google.signIn(env);
    const page = await fetch(flow.url);
    assert.equal(page.status, 400);
    assert.match(await page.text(), /didn&#39;t finish: Access wasn&#39;t allowed on the sign-in page\. You can close this tab\./);
    await assert.rejects(flow.done, (e) => e instanceof SourceError && e.code === 'auth' && e.message === 'Access wasn\'t allowed on the sign-in page.');
    assert.deepEqual(store.tokenRequests, []);
});

test('a sign-in with a calendar permission unticked is refused, saying which', async (t) => {
    const { env, store } = await setup(t);
    const cases = [
        [[EVENTS_SCOPE], 'Google didn\'t give access to your events. Sign in again and make sure the permission to view and edit events is ticked.'],
        [[LIST_SCOPE], 'Google didn\'t give access to your list of calendars. Sign in again and make sure the permission to see your list of calendars is ticked.'],
        [[EVENTS_SCOPE, LIST_SCOPE], 'Google didn\'t give access to your events or your list of calendars. Sign in again and make sure both calendar permissions are ticked.'],
    ];
    for (const [unticked, message] of cases) {
        store.uncheckedScopes = new Set(unticked);
        const flow = await google.signIn(env);
        await fetch(flow.url);
        await assert.rejects(flow.done, (e) => e instanceof SourceError && e.code === 'auth' && e.message === message);
    }
});

test('a grant with the broad calendar scope, as earlier sign-ins made, still counts', async (t) => {
    const { env, store } = await setup(t);
    const flow = await google.signIn(env);
    // An account signed in before asked for the broad scope; Google answers with the scope a grant has.
    const url = new URL(flow.url);
    url.searchParams.set('scope', `${BROAD_SCOPE} openid email`);
    await fetch(url);
    const { grant, email } = await flow.done;
    assert.equal(email, store.user.email);
    assert.deepEqual(grant.scope.split(' ').filter((s) => s.includes('calendar')), [BROAD_SCOPE]);
    await env.secret.set(grant);
    const source = google.create({ id: 'acct-1', kind: 'google', name: 'Google', email }, env);
    const [calendar] = await source.calendars();
    assert.equal(calendar.remoteId, store.user.email);
    // Renewed, it goes on working.
    store.expireAccessTokens();
    const [lunch] = await source.create(calendar, { uid: 'broad-1', title: 'Lunch', start: wall('2026-10-14T12:00:00'), end: wall('2026-10-14T13:00:00') });
    assert.equal(store.get(store.user.email, lunch.remoteId).summary, 'Lunch');
    assert.deepEqual(store.tokenRequests.map((r) => r.grantType), ['authorization_code', 'refresh_token']);
});

test('cancel and a timeout end a sign-in and close the loopback', async (t) => {
    const { env } = await setup(t);
    const flow = await google.signIn(env);
    flow.cancel();
    await assert.rejects(flow.done, (e) => e.code === 'auth' && /cancelled/.test(e.message));
    await assert.rejects(fetch(flow.redirectUri));
    await assert.rejects(flow.finish(`${flow.redirectUri}?state=x&code=y`), (e) => e.code === 'auth');
    const slow = await google.signIn(env, { timeoutMs: 50 });
    await assert.rejects(slow.done, (e) => e.code === 'auth' && /in time/.test(e.message));
    await assert.rejects(fetch(slow.redirectUri));
});

test('without an OAuth client in the settings, Google is a config error', async (t) => {
    const { env } = await setup(t, { settings: { googleClientId: '', googleClientSecret: undefined } });
    await assert.rejects(google.signIn(env), (e) => e instanceof SourceError && e.code === 'config'
        && /googleClientId/.test(e.message) && /googleClientSecret/.test(e.message));
    const source = google.create({ id: 'acct-1', kind: 'google' }, env);
    await assert.rejects(source.calendars(), (e) => e.code === 'config');
});

test('an access token about to expire is renewed first, once for every caller', async (t) => {
    const ctx = await signedIn(t);
    const before = ctx.env.secret.peek();
    ctx.clock.shift = before.expiresAt - Date.now() - 60_000; // a minute left
    const options = {
        tokenUrl: ctx.env.settings.googleTokenUrl, clientId: ctx.env.settings.googleClientId,
        clientSecret: ctx.env.settings.googleClientSecret, request: ctx.env.request, now: ctx.env.now,
    };
    const [first, second, listed] = await Promise.all([
        accessToken(ctx.env.secret, options), accessToken(ctx.env.secret, options), ctx.source.calendars(),
    ]);
    assert.deepEqual(ctx.store.tokenRequests.map((r) => r.grantType), ['authorization_code', 'refresh_token']);
    const after = ctx.env.secret.peek();
    assert.notEqual(after.accessToken, before.accessToken);
    assert.equal(after.refreshToken, before.refreshToken, 'Google sent no new refresh token: the old one stays');
    assert.equal(after.idToken !== undefined, true);
    assert.ok(after.expiresAt > ctx.env.now() + 3500_000);
    assert.equal(first, after.accessToken);
    assert.equal(second, after.accessToken);
    assert.equal(listed.length, 1);
    // Fresh again: no renewal.
    assert.equal(await accessToken(ctx.env.secret, options), after.accessToken);
    assert.equal(ctx.store.tokenRequests.length, 2);
    // refreshGrant on its own keeps the refresh token too, and says when a grant is gone.
    const again = await refreshGrant({ ...options, grant: after });
    assert.equal(again.refreshToken, after.refreshToken);
    ctx.store.revokeRefreshTokens();
    await assert.rejects(refreshGrant({ ...options, grant: after }), (e) => e.code === 'auth' && /Sign in again/.test(e.message));
});

test('a 401 renews the token once and tries again; a second 401 asks to sign in', async (t) => {
    const ctx = await signedIn(t);
    const messages = [];
    ctx.store.expireAccessTokens();
    assert.equal((await ctx.source.calendars()).length, 1);
    assert.deepEqual(ctx.store.tokenRequests.map((r) => r.grantType), ['authorization_code', 'refresh_token']);
    assert.equal(requestsOf(ctx.store, 'GET', '/calendarList').length, 2);

    ctx.store.failNext({ status: 401, reason: 'authError', message: 'Invalid Credentials', times: 2 });
    await assert.rejects(ctx.source.calendars(), (e) => {
        messages.push(e.message);
        return e instanceof SourceError && e.code === 'auth' && e.status === 401;
    });
    assert.equal(ctx.store.tokenRequests.filter((r) => r.grantType === 'refresh_token').length, 2);

    ctx.store.revokeRefreshTokens();
    ctx.store.expireAccessTokens();
    // Google ended the sign-in: the user is told why that can happen every week, and what stops it.
    await assert.rejects(ctx.source.calendars(), (e) => {
        messages.push(e.message);
        return e.code === 'auth' && /Sign in again\. If Google asks every week, your Google app is still in Testing, where Google ends sign-ins after 7 days: publish it/.test(e.message);
    });
    // A secret store without a grant: not signed in.
    const bare = google.create({ id: 'acct-2', kind: 'google' }, { ...ctx.env, secret: memorySecret() });
    await assert.rejects(bare.calendars(), (e) => e.code === 'auth');
    assertNoSecrets(ctx, [...messages, ...ctx.logs]);
});

test('revoke: removing the account ends the grant at Google; where it can\'t, the page to end it there', async (t) => {
    const ctx = await signedIn(t);
    const revoker = await revokeStandIn(t, ctx.store);
    ctx.env.settings.googleRevokeUrl = revoker.url;
    const grant = ctx.env.secret.peek();
    const messages = [];
    assert.equal(google.DEFAULTS.googleRevokeUrl, 'https://oauth2.googleapis.com/revoke');

    // The refresh token goes in a form body, never in the address, and the whole grant ends.
    assert.deepEqual(await google.revoke(ctx.env, grant), { revoked: true });
    const [sent] = revoker.seen;
    assert.deepEqual([sent.method, sent.url], ['POST', '/revoke']);
    assert.match(sent.type, /^application\/x-www-form-urlencoded/);
    assert.deepEqual([...new URLSearchParams(sent.body)], [['token', grant.refreshToken]]);
    await assert.rejects(ctx.source.calendars(), (e) => {
        messages.push(e.message);
        return e.code === 'auth' && /Sign in again/.test(e.message);
    });

    // Ended already (sent twice, or the user removed the access on Google's page): Google says invalid_token, which counts.
    // The secret that holds the grant does as well as the grant.
    assert.deepEqual(await google.revoke(ctx.env, ctx.env.secret), { revoked: true });
    assert.equal(new URLSearchParams(revoker.seen[1].body).get('token'), grant.refreshToken);
    // A grant without a refresh token sends its access token.
    assert.deepEqual(await google.revoke(ctx.env, { accessToken: grant.accessToken }), { revoked: true });
    assert.equal(new URLSearchParams(revoker.seen[2].body).get('token'), grant.accessToken);

    // Refused or failed: not revoked, and the Google Account page where the user removes the access.
    const page = { revoked: false, manageUrl: 'https://myaccount.google.com/linkedapps' };
    assert.equal(google.MANAGE_URL, page.manageUrl);
    for (const answer of [
        { status: 400, body: { error: 'invalid_request', error_description: 'Bad Request' } },
        { status: 500, body: { error: 'internal_failure' } },
        { status: 503, body: {} },
    ]) {
        revoker.control.answer = answer;
        assert.deepEqual(await google.revoke(ctx.env, grant), page);
    }
    // No token to send: nothing is sent.
    const sentBefore = revoker.seen.length;
    assert.deepEqual(await google.revoke(ctx.env, undefined), page);
    assert.deepEqual(await google.revoke(ctx.env, memorySecret()), page);
    assert.equal(revoker.seen.length, sentBefore);

    // Google out of reach: a network error naming its host, nothing more.
    await revoker.close();
    await assert.rejects(google.revoke(ctx.env, grant), (e) => {
        messages.push(e.message);
        return e instanceof SourceError && e.code === 'network' && e.message.includes('127.0.0.1') && !e.message.includes('/revoke');
    });
    assertNoSecrets(ctx, [...messages, ...ctx.logs]);
    assert.ok(ctx.logs.some((line) => line === 'google revoke done'));
});

test('calendars: the visible ones, every page, with names, colors, access and zones', async (t) => {
    const ctx = await signedIn(t);
    const { store } = ctx;
    store.addCalendar({ id: 'team@group.calendar.google.com', summary: 'Team', summaryOverride: 'My team', backgroundColor: '#ff7537', accessRole: 'writer', timeZone: BERLIN, description: 'Team things' });
    store.addCalendar({ id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in United States', accessRole: 'reader', timeZone: 'UTC' });
    store.addCalendar({ id: 'hidden@group.calendar.google.com', summary: 'Hidden', hidden: true });
    store.addCalendar({ id: 'gone@group.calendar.google.com', summary: 'Gone', deleted: true });
    store.addCalendar({ id: 'boss@example.com', summary: 'boss@example.com', accessRole: 'freeBusyReader' });
    store.addCalendar({ id: 'shared@group.calendar.google.com', summary: 'Shared', accessRole: 'writerWithoutPrivateAccess' });
    store.pageLimit = 2;
    const list = await ctx.source.calendars();
    assert.deepEqual(list.map((c) => c.remoteId), [
        store.user.email, 'team@group.calendar.google.com', 'en.usa#holiday@group.v.calendar.google.com',
        'boss@example.com', 'shared@group.calendar.google.com',
    ]);
    // The account's own main calendar is the primary one: new events go there unless the user says otherwise.
    assert.deepEqual(list[0], { remoteId: store.user.email, name: store.user.email, readOnly: false, primary: true, color: '#9fe1e7', timeZone: LA });
    assert.deepEqual(list[1], {
        remoteId: 'team@group.calendar.google.com', name: 'My team', readOnly: false, color: '#ff7537', timeZone: BERLIN, description: 'Team things',
    });
    assert.deepEqual(list.filter((c) => c.primary).map((c) => c.remoteId), [store.user.email]);
    assert.equal(list[2].readOnly, true);
    assert.equal(list[3].readOnly, true);
    assert.equal(list[4].readOnly, true, 'only writer and owner write');
    const reads = requestsOf(store, 'GET', '/calendarList');
    assert.equal(reads.length, 3);
    assert.equal(reads[0].query.pageToken, undefined);
    assert.ok(reads[1].query.pageToken && reads[2].query.pageToken);

    // A calendar id with "#" and "@" travels in the path, encoded.
    store.pageLimit = Infinity;
    const holidays = await ctx.source.sync(list[2], undefined);
    assert.equal(holidays.reset, true);
    assert.deepEqual(holidays.items, []);
    assert.equal(requestsOf(store, 'GET', '/events').at(-1).path, '/calendar/v3/calendars/en.usa%23holiday%40group.v.calendar.google.com/events');
});

test('a full sync, then only what changed', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const standup = store.insert(cal, {
        summary: 'Standup', description: 'Daily', location: 'Room 1', start: at('2026-10-12T09:00:00'), end: at('2026-10-12T09:30:00'),
        hangoutLink: 'https://meet.google.com/abc-defg-hij', transparency: 'transparent', visibility: 'private',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 60 }] },
    });
    const holiday = store.insert(cal, { summary: 'Holiday', start: { date: '2026-10-13' }, end: { date: '2026-10-14' }, guestsCanModify: true });
    store.insert(cal, { summary: 'Desk', eventType: 'workingLocation', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } });

    const first = await source.sync(calendar, undefined);
    assert.equal(first.reset, true);
    assert.deepEqual(first.removed, []);
    assert.equal(first.items.length, 2, 'a working location is no event');
    const item = titled(first.items, 'Standup');
    assert.equal(item.remoteId, standup.id);
    assert.equal(item.etag, standup.etag);
    assert.deepEqual(item.events[0], {
        uid: standup.iCalUID, title: 'Standup', description: 'Daily', location: 'Room 1',
        start: wall('2026-10-12T09:00:00'), end: wall('2026-10-12T09:30:00'), allDay: false, status: 'confirmed',
        busy: false, privacy: 'private', organizer: { email: store.user.email, self: true }, alarms: [10],
        conference: 'https://meet.google.com/abc-defg-hij', created: standup.created, updated: standup.updated, sequence: 0,
    });
    // An event whose guests may change it says so: a guest's change to it is made for everyone on it.
    assert.equal(titled(first.items, 'Holiday').events[0].guestsMayChange, true);
    assert.ok(first.state.syncToken);
    const list = requestsOf(store, 'GET', '/events')[0].query;
    assert.equal(list.singleEvents, 'false');
    assert.equal(list.showDeleted, 'true');
    assert.equal(list.syncToken, undefined);

    // Changes made elsewhere.
    store.patch(cal, standup.id, { summary: 'Standup (later)', start: at('2026-10-12T10:00:00'), end: at('2026-10-12T10:30:00'), reminders: { useDefault: true } });
    store.remove(cal, holiday.id);
    const lunch = store.insert(cal, { summary: 'Lunch', start: at('2026-10-12T12:00:00'), end: at('2026-10-12T13:00:00') });
    const second = await source.sync(calendar, first.state);
    assert.equal(second.reset, false);
    assert.deepEqual(second.items.map((i) => i.remoteId).sort(), [standup.id, lunch.id].sort());
    const later = titled(second.items, 'Standup (later)').events[0];
    assert.deepEqual(later.start, wall('2026-10-12T10:00:00'));
    assert.equal(later.alarms, undefined, 'the calendar\'s default reminders: no alarms field');
    assert.equal(later.sequence, 1);
    assert.deepEqual(second.removed, [holiday.id]);
    assert.notEqual(second.state.syncToken, first.state.syncToken);
    assert.equal(requestsOf(store, 'GET', '/events').at(-1).query.syncToken, first.state.syncToken);

    const third = await source.sync(calendar, second.state);
    assert.deepEqual([third.reset, third.items, third.removed], [false, [], []]);
});

test('410: Google dropped the sync token, so the calendar is read whole again, every page', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    for (const n of [1, 2, 3]) store.insert(cal, { summary: `Event ${n}`, start: at(`2026-10-1${n}T09:00:00`), end: at(`2026-10-1${n}T10:00:00`) });
    const first = await source.sync(calendar, undefined);
    store.insert(cal, { summary: 'Event 4', start: at('2026-10-14T09:00:00'), end: at('2026-10-14T10:00:00') });
    store.expireSyncTokens(cal);
    store.pageLimit = 1;
    store.requests.length = 0;
    const again = await source.sync(calendar, first.state);
    assert.equal(again.reset, true);
    assert.deepEqual(again.items.map((i) => i.events[0].title).sort(), ['Event 1', 'Event 2', 'Event 3', 'Event 4']);
    assert.deepEqual(again.removed, []);
    const lists = requestsOf(store, 'GET', '/events');
    assert.equal(lists[0].query.syncToken, first.state.syncToken, 'the old token first, answered 410');
    assert.equal(lists.length, 5, 'then four pages');
    for (const page of lists.slice(2)) assert.ok(page.query.pageToken);
    // The token from the last page works.
    store.pageLimit = Infinity;
    const next = await source.sync(calendar, again.state);
    assert.deepEqual([next.reset, next.items.length], [false, 0]);
    assert.ok(ctx.logs.some((line) => /sync token gone/.test(line)));
});

test('a series with changed and cancelled occurrences, RDATE and EXDATE lines', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    // Mondays at 18:00 in Los Angeles; Oct 12 and Oct 19 left out, an extra Thursday morning on Oct 8.
    const gym = store.insert(cal, {
        summary: 'Gym', start: at('2026-10-05T18:00:00'), end: at('2026-10-05T19:00:00'),
        recurrence: [
            'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10',
            'EXDATE;TZID=America/Los_Angeles:20261012T180000',
            'EXDATE:20261020T010000Z',
            'RDATE;TZID=America/Los_Angeles:20261008T070000',
        ],
    });
    // Oct 26 moved to 19:00 (18:00 PDT is 01:00Z the next day); Nov 2 cancelled (18:00 PST is 02:00Z).
    store.patch(cal, `${gym.id}_20261027T010000Z`, { summary: 'Gym (late)', start: at('2026-10-26T19:00:00'), end: at('2026-10-26T20:00:00') });
    store.remove(cal, `${gym.id}_20261103T020000Z`);
    assert.equal(store.get(cal, `${gym.id}_20261103T020000Z`).iCalUID, undefined, 'Google sends a cancelled occurrence without its uid');

    const { items } = await source.sync(calendar, undefined);
    assert.equal(items.length, 3);
    const master = items.find((i) => i.remoteId === gym.id).events[0];
    assert.equal(master.uid, gym.iCalUID);
    assert.equal(master.rrule, 'FREQ=WEEKLY;BYDAY=MO;COUNT=10');
    assert.deepEqual(master.exdates, [wall('2026-10-12T18:00:00'), wall('2026-10-20T01:00:00', 'UTC')]);
    assert.deepEqual(master.rdates, [wall('2026-10-08T07:00:00')]);
    assert.deepEqual([master.start, master.end], [wall('2026-10-05T18:00:00'), wall('2026-10-05T19:00:00')]);
    assert.equal(master.recurrenceId, undefined);

    const moved = items.find((i) => i.remoteId === `${gym.id}_20261027T010000Z`).events[0];
    assert.equal(moved.uid, gym.iCalUID, 'an exception carries the series\' uid');
    assert.deepEqual(moved.recurrenceId, wall('2026-10-26T18:00:00'));
    assert.deepEqual([moved.start, moved.end], [wall('2026-10-26T19:00:00'), wall('2026-10-26T20:00:00')]);
    assert.equal(moved.title, 'Gym (late)');
    assert.equal(moved.rrule, undefined);

    const cancelled = items.find((i) => i.remoteId === `${gym.id}_20261103T020000Z`);
    assert.deepEqual(cancelled.events[0], {
        uid: gym.iCalUID, title: '', status: 'cancelled', start: wall('2026-11-02T18:00:00'), end: wall('2026-11-02T19:00:00'),
        recurrenceId: wall('2026-11-02T18:00:00'), allDay: false,
    });

    // Later, alone in a delta, a cancelled occurrence's series is looked up (a new source knows nothing yet).
    const { state } = await source.sync(calendar, undefined);
    store.remove(cal, `${gym.id}_20261110T020000Z`);
    store.requests.length = 0;
    const fresh = google.create({ id: 'acct-1', kind: 'google' }, ctx.env);
    const delta = await fresh.sync(calendar, state);
    assert.equal(delta.items.length, 1);
    assert.equal(delta.items[0].events[0].uid, gym.iCalUID);
    assert.equal(delta.items[0].events[0].status, 'cancelled');
    assert.deepEqual(delta.items[0].events[0].recurrenceId, wall('2026-11-09T18:00:00'));
    assert.equal(requestsOf(store, 'GET', `/events/${gym.id}`).length, 1);

    // The series deleted elsewhere: it and its occurrences are gone.
    store.remove(cal, gym.id);
    const gone = await fresh.sync(calendar, delta.state);
    assert.deepEqual(gone.items, []);
    assert.deepEqual(gone.removed.sort(), [gym.id, `${gym.id}_20261027T010000Z`].sort());
});

test('all-day events and series', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const trip = store.insert(cal, { summary: 'Trip', start: { date: '2026-10-20' }, end: { date: '2026-10-23' } });
    // Tuesdays from Oct 13, four of them, Oct 27 left out.
    const bins = store.insert(cal, {
        summary: 'Bins', start: { date: '2026-10-13' }, end: { date: '2026-10-14' },
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;VALUE=DATE:20261027'],
    });
    const { items } = await source.sync(calendar, undefined);
    const tripRecord = items.find((i) => i.remoteId === trip.id).events[0];
    assert.deepEqual([tripRecord.start, tripRecord.end, tripRecord.allDay], [{ date: '2026-10-20' }, { date: '2026-10-23' }, true]);
    const binsItem = items.find((i) => i.remoteId === bins.id);
    const series = binsItem.events[0];
    assert.equal(series.rrule, 'FREQ=WEEKLY;COUNT=4');
    assert.deepEqual(series.exdates, [{ date: '2026-10-27' }]);

    // One day of the series: Google's id for it ends in the date.
    const [changed] = await source.update(calendar, { item: binsItem, record: series, occurrence: { date: '2026-10-20' } }, { title: 'Bins (recycling)' }, 'one');
    assert.equal(changed.remoteId, `${bins.id}_20261020`);
    assert.deepEqual(changed.events[0].recurrenceId, { date: '2026-10-20' });
    assert.deepEqual([changed.events[0].start, changed.events[0].end], [{ date: '2026-10-20' }, { date: '2026-10-21' }]);
    assert.equal(changed.events[0].title, 'Bins (recycling)');
    assert.equal(store.get(cal, bins.id).summary, 'Bins');

    const removed = await source.remove(calendar, { item: binsItem, record: series, occurrence: { date: '2026-11-03' } }, 'one');
    assert.deepEqual(removed.removed, []);
    assert.equal(removed.items[0].remoteId, `${bins.id}_20261103`);
    assert.deepEqual(removed.items[0].events[0], {
        uid: bins.iCalUID, title: '', status: 'cancelled', start: { date: '2026-11-03' }, end: { date: '2026-11-04' },
        recurrenceId: { date: '2026-11-03' }, allDay: true,
    });
    assert.equal(store.get(cal, `${bins.id}_20261103`).status, 'cancelled');

    // A new all-day event goes as dates.
    const [off] = await source.create(calendar, { title: 'Off', start: { date: '2026-12-24' }, end: { date: '2026-12-27' } });
    assert.deepEqual(store.get(cal, off.remoteId).start, { date: '2026-12-24' });
    assert.deepEqual([off.events[0].start, off.events[0].end, off.events[0].allDay], [{ date: '2026-12-24' }, { date: '2026-12-27' }, true]);
});

test('an event in Europe/Berlin keeps its zone and wall clock whatever the user\'s zone', async (t) => {
    const saved = process.env.TZ;
    t.after(() => {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
    });
    for (const [userZone, machineZone] of [['Asia/Tokyo', 'Pacific/Kiritimati'], ['America/New_York', 'Pacific/Pago_Pago']]) {
        process.env.TZ = machineZone;
        const ctx = await signedIn(t, { zone: userZone });
        const { store, source, calendar, cal } = ctx;
        const call = store.insert(cal, {
            summary: 'Berlin call', start: { dateTime: '2026-10-12T09:00:00+02:00', timeZone: BERLIN }, end: { dateTime: '2026-10-12T10:00:00+02:00', timeZone: BERLIN },
        });
        // Google writes dateTime in the calendar's zone (Los Angeles) and names the event's zone apart.
        assert.deepEqual(store.get(cal, call.id).start, { dateTime: '2026-10-12T00:00:00-07:00', timeZone: BERLIN });
        // An event without a zone of its own is read in the calendar's.
        store.insert(cal, { summary: 'Noon UTC', start: { dateTime: '2026-10-12T12:00:00Z' }, end: { dateTime: '2026-10-12T13:00:00Z' } });
        const { items } = await source.sync(calendar, undefined);
        const berlin = titled(items, 'Berlin call').events[0];
        assert.deepEqual([berlin.start, berlin.end], [wall('2026-10-12T09:00:00', BERLIN), wall('2026-10-12T10:00:00', BERLIN)]);
        assert.deepEqual(titled(items, 'Noon UTC').events[0].start, wall('2026-10-12T05:00:00', LA));

        // Written back: the wall clock with its offset, and the zone.
        const [lunch] = await source.create(calendar, { title: 'Berlin lunch', start: wall('2026-11-02T12:00:00', BERLIN), end: wall('2026-11-02T13:00:00', BERLIN) });
        assert.deepEqual(store.get(cal, lunch.remoteId).start, { dateTime: '2026-11-02T03:00:00-08:00', timeZone: BERLIN });
        assert.deepEqual(lunch.events[0].start, wall('2026-11-02T12:00:00', BERLIN));
        const [moved] = await source.update(calendar, { item: lunch, record: lunch.events[0] }, { start: wall('2026-11-02T12:30:00', BERLIN), end: wall('2026-11-02T13:30:00', BERLIN) }, 'all');
        assert.deepEqual(moved.events[0].start, wall('2026-11-02T12:30:00', BERLIN));
        assert.equal(Date.parse(store.get(cal, lunch.remoteId).start.dateTime), Date.UTC(2026, 10, 2, 11, 30));

        // A Berlin series keeps 09:00 across the end of summer time (Oct 25): Nov 2 09:00 CET is 08:00Z.
        const weekly = store.insert(cal, {
            summary: 'Berlin weekly', start: at('2026-10-19T09:00:00', BERLIN), end: at('2026-10-19T10:00:00', BERLIN), recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
        });
        const synced = await source.sync(calendar, undefined);
        const weeklyItem = synced.items.find((i) => i.remoteId === weekly.id);
        assert.deepEqual(weeklyItem.events[0].start, wall('2026-10-19T09:00:00', BERLIN));
        const occurrence = wall('2026-11-02T09:00:00', BERLIN);
        const [one] = await source.update(calendar, { item: weeklyItem, record: weeklyItem.events[0], occurrence }, { title: 'Berlin weekly (moved)', start: wall('2026-11-02T11:00:00', BERLIN), end: wall('2026-11-02T12:00:00', BERLIN) }, 'one');
        assert.equal(one.remoteId, `${weekly.id}_20261102T080000Z`);
        assert.deepEqual(one.events[0].recurrenceId, occurrence);
        assert.deepEqual(one.events[0].start, wall('2026-11-02T11:00:00', BERLIN));
    }
});

test('create: an event as Google takes it; guests hear of it only when asked', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const [lunch] = await source.create(calendar, {
        uid: 'made-here-1', title: 'Lunch with Sam', description: 'Bring the plan', location: 'Cafe',
        start: wall('2026-10-14T12:00:00'), end: wall('2026-10-14T13:00:00'), allDay: false,
        attendees: [{ email: 'sam@example.com', name: 'Sam' }, { email: 'kim@example.com', role: 'optional' }],
        alarms: [10, 30], busy: false, privacy: 'private', notify: true,
    });
    const insert = requestsOf(store, 'POST', '/events').at(-1);
    assert.equal(insert.query.sendUpdates, 'all');
    const saved = store.get(cal, lunch.remoteId);
    assert.equal(saved.summary, 'Lunch with Sam');
    assert.deepEqual(saved.start, { dateTime: '2026-10-14T12:00:00-07:00', timeZone: LA });
    assert.deepEqual(saved.attendees, [
        { email: 'sam@example.com', displayName: 'Sam', responseStatus: 'needsAction' },
        { email: 'kim@example.com', optional: true, responseStatus: 'needsAction' },
    ]);
    assert.deepEqual(saved.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }, { method: 'popup', minutes: 30 }] });
    assert.equal(saved.transparency, 'transparent');
    assert.equal(saved.visibility, 'private');
    // The item is Google's: its id, etag and uid.
    assert.equal(lunch.etag, saved.etag);
    const record = lunch.events[0];
    assert.equal(record.uid, saved.iCalUID);
    assert.deepEqual(record.attendees, [
        { email: 'sam@example.com', name: 'Sam', status: 'needs-action' },
        { email: 'kim@example.com', status: 'needs-action', role: 'optional' },
    ]);
    assert.deepEqual([record.alarms, record.busy, record.privacy], [[10, 30], false, 'private']);

    // Without notify: no mail to the guests.
    await source.create(calendar, { title: 'Quiet', start: wall('2026-10-15T12:00:00'), end: wall('2026-10-15T13:00:00'), attendees: [{ email: 'sam@example.com' }] });
    assert.equal(requestsOf(store, 'POST', '/events').at(-1).query.sendUpdates, 'none');

    // A series goes as recurrence lines in its zone.
    const [piano] = await source.create(calendar, {
        title: 'Piano', start: wall('2026-10-13T17:00:00'), end: wall('2026-10-13T18:00:00'),
        rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10', exdates: [wall('2026-10-15T17:00:00'), wall('2026-10-20T00:00:00', 'UTC')],
        rdates: [{ date: '2026-10-31' }],
    });
    assert.deepEqual(store.get(cal, piano.remoteId).recurrence, [
        'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10', 'RDATE;VALUE=DATE:20261031',
        'EXDATE;TZID=America/Los_Angeles:20261015T170000', 'EXDATE:20261020T000000Z',
    ]);
    assert.equal(piano.events[0].rrule, 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10');

    // A calendar the account may only read.
    store.addCalendar({ id: 'holidays@group.v.calendar.google.com', summary: 'Holidays', accessRole: 'reader' });
    await assert.rejects(source.create({ remoteId: 'holidays@group.v.calendar.google.com', timeZone: 'UTC' }, { title: 'x', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } }),
        (e) => e instanceof SourceError && e.code === 'forbidden');
});

test('create: the event\'s id comes from its uid, so a create sent again finds the event instead of adding another', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const idOf = (uid, n = 0) => createHash('sha256').update(n === 0 ? uid : `${uid}\n${n}`).digest('hex');
    const steps = () => store.requests.map((r) => `${r.method} ${r.path.slice(r.path.lastIndexOf('/') + 1)}`);
    // What goes to Google, and an answer lost on its way back.
    const plain = ctx.env.request;
    const inserts = [];
    let loseAnswer = false;
    ctx.env.request = async (url, init = {}) => {
        const insert = init.method === 'POST' && new URL(url).pathname.endsWith('/events');
        if (insert) inserts.push(JSON.parse(init.body));
        const res = await plain(url, init);
        if (insert && loseAnswer) {
            loseAnswer = false;
            throw new HttpError('timeout', '127.0.0.1 didn\'t answer within 30 s.');
        }
        return res;
    };
    const record = {
        uid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', title: 'Planning', start: wall('2026-10-20T10:00:00'), end: wall('2026-10-20T11:00:00'),
        attendees: [{ email: 'sam@example.com' }], notify: true,
    };

    // Google makes the event, but its answer never comes.
    loseAnswer = true;
    await assert.rejects(source.create(calendar, record), (e) => e instanceof SourceError && e.code === 'network');
    const id = idOf(record.uid);
    assert.match(id, /^[a-v0-9]{5,1024}$/);
    assert.equal(inserts[0].id, id);
    assert.equal('iCalUID' in inserts[0], false);
    assert.equal(store.get(cal, id).summary, 'Planning');

    // Sent again with the same uid: Google answers 409, and the event the first one made is the result.
    // Nothing is written again, so the guests aren't invited twice.
    store.requests.length = 0;
    const [made] = await source.create(calendar, record);
    assert.deepEqual(steps(), ['POST events', `GET ${id}`]);
    assert.equal(inserts[1].id, id);
    assert.deepEqual([made.remoteId, made.etag, made.events[0].title, made.events[0].uid], [id, store.get(cal, id).etag, 'Planning', `${id}@google.com`]);
    assert.equal((await source.sync(calendar, undefined)).items.filter((i) => i.events[0].title === 'Planning').length, 1);

    // A deleted event keeps its id at Google: a new event with the same uid takes the uid's next id, and finds it when sent again.
    store.remove(cal, id);
    const [anew] = await source.create(calendar, { ...record, notify: false });
    assert.equal(anew.remoteId, idOf(record.uid, 1));
    const [again] = await source.create(calendar, { ...record, notify: false });
    assert.equal(again.remoteId, anew.remoteId);
    assert.equal(store.get(cal, id).status, 'cancelled');

    // With the uid's first five ids all held by deleted events, Google picks the id.
    const held = [0, 1, 2, 3, 4].map((n) => idOf('reused-uid', n));
    for (const old of held) {
        store.insert(cal, { id: old, summary: 'Old', start: at('2026-10-21T09:00:00'), end: at('2026-10-21T10:00:00') });
        store.remove(cal, old);
    }
    const [picked] = await source.create(calendar, { uid: 'reused-uid', title: 'New', start: wall('2026-10-21T09:00:00'), end: wall('2026-10-21T10:00:00') });
    assert.equal('id' in inserts.at(-1), false);
    assert.ok(!held.includes(picked.remoteId));
    assert.equal(store.get(cal, picked.remoteId).summary, 'New');

    // Without a uid, Google picks the id too.
    await source.create(calendar, { title: 'No uid', start: wall('2026-10-22T09:00:00'), end: wall('2026-10-22T10:00:00') });
    assert.equal('id' in inserts.at(-1), false);
    ctx.env.request = plain;
});

test('update: a single event with If-Match, and a conflict when it changed meanwhile', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const [lunch] = await source.create(calendar, { title: 'Lunch', location: 'Cafe', start: wall('2026-10-14T12:00:00'), end: wall('2026-10-14T13:00:00') });
    const [changed] = await source.update(calendar, { item: lunch, record: lunch.events[0] }, {
        title: 'Lunch with Kim', location: '', alarms: [5], busy: false, privacy: 'confidential',
        start: wall('2026-10-14T12:30:00'), end: wall('2026-10-14T13:30:00'),
    }, 'all');
    const patch = requestsOf(store, 'PATCH', `/events/${lunch.remoteId}`).at(-1);
    assert.equal(patch.ifMatch, lunch.etag);
    assert.equal(patch.query.sendUpdates, 'none');
    const saved = store.get(cal, lunch.remoteId);
    assert.equal(saved.summary, 'Lunch with Kim');
    assert.equal(saved.location, undefined);
    assert.equal(saved.visibility, 'confidential');
    assert.notEqual(changed.etag, lunch.etag);
    assert.deepEqual(changed.events[0].start, wall('2026-10-14T12:30:00'));
    assert.deepEqual([changed.events[0].alarms, changed.events[0].busy, changed.events[0].location], [[5], false, undefined]);
    // Back to the calendar's reminders and busy.
    const [plain] = await source.update(calendar, { item: changed, record: changed.events[0] }, { alarms: undefined, busy: true, privacy: undefined }, 'all');
    assert.deepEqual(store.get(cal, lunch.remoteId).reminders, { useDefault: true });
    assert.deepEqual([plain.events[0].alarms, plain.events[0].busy, plain.events[0].privacy], [undefined, undefined, undefined]);

    // Someone else changes it: the etag held here is stale.
    store.patch(cal, lunch.remoteId, { description: 'Upstairs' });
    await assert.rejects(source.update(calendar, { item: plain, record: plain.events[0] }, { title: 'Mine' }, 'all'),
        (e) => e instanceof SourceError && e.code === 'conflict' && e.status === 412);
    assert.equal(store.get(cal, lunch.remoteId).summary, 'Lunch with Kim');
});

test('update: one occurrence, the whole series, and an occurrence moved far away', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const gym = store.insert(cal, {
        summary: 'Gym', start: at('2026-10-05T18:00:00'), end: at('2026-10-05T19:00:00'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10'],
    });
    const { items } = await source.sync(calendar, undefined);
    const master = items.find((i) => i.remoteId === gym.id);
    const record = master.events[0];

    // One occurrence, from the series: found through events.instances around its start.
    store.requests.length = 0;
    const occurrence = wall('2026-10-19T18:00:00');
    const [late] = await source.update(calendar, { item: master, record, occurrence }, {
        title: 'Gym (late)', start: wall('2026-10-19T19:30:00'), end: wall('2026-10-19T20:30:00'),
    }, 'one');
    assert.equal(late.remoteId, `${gym.id}_20261020T010000Z`);
    assert.deepEqual(late.events[0].recurrenceId, occurrence);
    assert.deepEqual([late.events[0].start, late.events[0].title, late.events[0].uid], [wall('2026-10-19T19:30:00'), 'Gym (late)', gym.iCalUID]);
    const instances = requestsOf(store, 'GET', `/events/${gym.id}/instances`);
    assert.equal(instances.length, 1);
    assert.ok(instances[0].query.timeMin && instances[0].query.timeMax);
    assert.ok(requestsOf(store, 'PATCH', `/events/${late.remoteId}`)[0].ifMatch, 'If-Match with the instance\'s etag');
    assert.equal(store.get(cal, gym.id).summary, 'Gym', 'the series is unchanged');

    // That changed occurrence again, by its own item.
    const [pool] = await source.update(calendar, { item: late, record: late.events[0], occurrence }, { location: 'Pool' }, 'one');
    assert.equal(requestsOf(store, 'PATCH', `/events/${late.remoteId}`).at(-1).ifMatch, late.etag);
    assert.equal(pool.events[0].location, 'Pool');

    // An occurrence someone moved four days away isn't near its original start: Google's id finds it.
    store.patch(cal, `${gym.id}_20261110T020000Z`, { start: at('2026-11-13T18:00:00'), end: at('2026-11-13T19:00:00') });
    const [friday] = await source.update(calendar, { item: master, record, occurrence: wall('2026-11-09T18:00:00') }, { title: 'Gym (Friday)' }, 'one');
    assert.equal(friday.remoteId, `${gym.id}_20261110T020000Z`);
    assert.deepEqual([friday.events[0].start, friday.events[0].recurrenceId], [wall('2026-11-13T18:00:00'), wall('2026-11-09T18:00:00')]);

    // Another occurrence changed elsewhere, only its time.
    store.patch(cal, `${gym.id}_20261027T010000Z`, { start: at('2026-10-26T17:00:00'), end: at('2026-10-26T18:00:00') });

    // The whole series: the master (If-Match), read back with its changed occurrences.
    store.requests.length = 0;
    const all = await source.update(calendar, { item: master, record }, { title: 'Workout' }, 'all');
    assert.equal(requestsOf(store, 'PATCH', `/events/${gym.id}`)[0].ifMatch, master.etag);
    assert.equal(requestsOf(store, 'GET', '/events')[0].query.iCalUID, gym.iCalUID);
    const titles = Object.fromEntries(all.map((i) => [i.remoteId, i.events[0].title]));
    assert.deepEqual(titles, {
        [gym.id]: 'Workout',
        [`${gym.id}_20261020T010000Z`]: 'Gym (late)',
        [`${gym.id}_20261110T020000Z`]: 'Gym (Friday)',
        [`${gym.id}_20261027T010000Z`]: 'Workout',
    });
    assert.equal(all.find((i) => i.remoteId === gym.id).events[0].rrule, 'FREQ=WEEKLY;BYDAY=MO;COUNT=10');

    // Through a changed occurrence's item, 'all' changes the series.
    const fresh = all.find((i) => i.remoteId === `${gym.id}_20261027T010000Z`);
    await source.update(calendar, { item: fresh, record: fresh.events[0] }, { location: 'Gym hall' }, 'all');
    assert.equal(store.get(cal, gym.id).location, 'Gym hall');

    // The series' rule changes on the master only.
    const [series] = (await source.sync(calendar, undefined)).items.filter((i) => i.remoteId === gym.id);
    await source.update(calendar, { item: series, record: series.events[0] }, { rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=6', exdates: [wall('2026-10-12T18:00:00')] }, 'all');
    assert.deepEqual(store.get(cal, gym.id).recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6', 'EXDATE;TZID=America/Los_Angeles:20261012T180000']);
});

test('delete: one occurrence, a changed one, a whole series and a single event (twice)', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const gym = store.insert(cal, {
        summary: 'Gym', start: at('2026-10-05T18:00:00'), end: at('2026-10-05T19:00:00'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10'],
    });
    store.patch(cal, `${gym.id}_20261027T010000Z`, { summary: 'Gym (late)', start: at('2026-10-26T19:00:00'), end: at('2026-10-26T20:00:00') });
    const lunch = store.insert(cal, { summary: 'Lunch', start: at('2026-10-14T12:00:00'), end: at('2026-10-14T13:00:00') });
    const { items } = await source.sync(calendar, undefined);
    const master = items.find((i) => i.remoteId === gym.id);
    const late = items.find((i) => i.remoteId === `${gym.id}_20261027T010000Z`);

    const occurrence = wall('2026-11-16T18:00:00');
    const one = await source.remove(calendar, { item: master, record: master.events[0], occurrence }, 'one');
    assert.deepEqual(one.removed, []);
    assert.equal(one.items[0].remoteId, `${gym.id}_20261117T020000Z`);
    assert.deepEqual([one.items[0].events[0].status, one.items[0].events[0].recurrenceId, one.items[0].events[0].uid], ['cancelled', occurrence, gym.iCalUID]);
    assert.equal(store.get(cal, `${gym.id}_20261117T020000Z`).status, 'cancelled');
    assert.equal(requestsOf(store, 'DELETE', `/events/${gym.id}_20261117T020000Z`)[0].query.sendUpdates, 'none');

    const changed = await source.remove(calendar, { item: late, record: late.events[0] }, 'one');
    assert.equal(changed.items[0].remoteId, late.remoteId);
    assert.equal(changed.items[0].events[0].status, 'cancelled');
    assert.equal(requestsOf(store, 'DELETE', `/events/${late.remoteId}`)[0].ifMatch, late.etag);

    // The next sync agrees.
    const { items: after } = await source.sync(calendar, undefined);
    assert.equal(after.find((i) => i.remoteId === `${gym.id}_20261117T020000Z`).events[0].status, 'cancelled');

    store.patch(cal, `${gym.id}_20261013T010000Z`, { summary: 'Gym (moved)', start: at('2026-10-12T20:00:00'), end: at('2026-10-12T21:00:00') });
    const series = await source.remove(calendar, { item: master, record: master.events[0] }, 'all');
    assert.deepEqual(series.items, []);
    assert.ok(series.removed.includes(gym.id));
    assert.ok(series.removed.includes(`${gym.id}_20261013T010000Z`), 'its changed occurrences go too');
    assert.equal(store.get(cal, gym.id).status, 'cancelled');

    const lunchItem = items.find((i) => i.remoteId === lunch.id);
    assert.deepEqual(await source.remove(calendar, { item: lunchItem, record: lunchItem.events[0] }, 'all'), { removed: [lunch.id], items: [] });
    assert.equal(requestsOf(store, 'DELETE', `/events/${lunch.id}`)[0].ifMatch, lunch.etag);
    // Already gone (410): still removed, no error.
    assert.deepEqual(await source.remove(calendar, { item: lunchItem, record: lunchItem.events[0] }, 'all'), { removed: [lunch.id], items: [] });
});

test('a change with no etag held reads the event first and sends If-Match; a change in between is a conflict', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const gym = store.insert(cal, {
        summary: 'Gym', start: at('2026-10-05T18:00:00'), end: at('2026-10-05T19:00:00'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10'],
    });
    store.patch(cal, `${gym.id}_20261027T010000Z`, { summary: 'Gym (late)', start: at('2026-10-26T19:00:00'), end: at('2026-10-26T20:00:00') });
    // Nov 9 moved four days on and Nov 16 three: events.instances around their original starts misses them, Google's id finds them.
    const friday = `${gym.id}_20261110T020000Z`;
    const thursday = `${gym.id}_20261117T020000Z`;
    store.patch(cal, friday, { start: at('2026-11-13T18:00:00'), end: at('2026-11-13T19:00:00') });
    store.patch(cal, thursday, { start: at('2026-11-19T18:00:00'), end: at('2026-11-19T19:00:00') });
    const { items } = await source.sync(calendar, undefined);
    const master = items.find((i) => i.remoteId === gym.id);
    const late = items.find((i) => i.remoteId === `${gym.id}_20261027T010000Z`);
    const steps = () => store.requests.map((r) => `${r.method} ${r.path.slice(r.path.lastIndexOf('/') + 1)}`);

    // One occurrence by Google's id: read, then changed only while it is as read.
    store.requests.length = 0;
    let etag = store.get(cal, friday).etag;
    await source.update(calendar, { item: master, record: master.events[0], occurrence: wall('2026-11-09T18:00:00') }, { title: 'Gym (Friday)' }, 'one');
    assert.deepEqual(steps(), ['GET instances', `GET ${friday}`, `PATCH ${friday}`]);
    assert.equal(store.requests[2].ifMatch, etag);
    assert.equal(store.get(cal, friday).summary, 'Gym (Friday)');
    // Deleted the same way.
    store.requests.length = 0;
    etag = store.get(cal, thursday).etag;
    await source.remove(calendar, { item: master, record: master.events[0], occurrence: wall('2026-11-16T18:00:00') }, 'one');
    assert.deepEqual(steps(), ['GET instances', `GET ${thursday}`, `DELETE ${thursday}`, `GET ${thursday}`]);
    assert.equal(store.requests[2].ifMatch, etag);
    assert.equal(store.get(cal, thursday).status, 'cancelled');

    // The whole series through a changed occurrence: the series is read with its changed occurrences (by its uid),
    // then changed only while it is as read.
    store.requests.length = 0;
    etag = store.get(cal, gym.id).etag;
    await source.update(calendar, { item: late, record: late.events[0] }, { location: 'Gym hall' }, 'all');
    assert.deepEqual(steps().slice(0, 3), [`GET ${late.remoteId}`, 'GET events', `PATCH ${gym.id}`]);
    assert.equal(store.requests[1].query.iCalUID, gym.iCalUID);
    assert.equal(store.requests[2].ifMatch, etag);
    assert.equal(store.get(cal, gym.id).location, 'Gym hall');

    // Someone changes the series between that read and the write: Google refuses (412), and nothing is changed or deleted.
    const plain = ctx.env.request;
    ctx.env.request = async (url, init) => {
        const res = await plain(url, init);
        const read = new URL(url);
        if (init?.method === 'GET' && read.pathname.endsWith('/events') && read.searchParams.get('iCalUID') === gym.iCalUID) store.patch(cal, gym.id, { description: 'Changed elsewhere' });
        return res;
    };
    await assert.rejects(source.update(calendar, { item: late, record: late.events[0] }, { location: 'Pool' }, 'all'),
        (e) => e instanceof SourceError && e.code === 'conflict' && e.status === 412);
    await assert.rejects(source.remove(calendar, { item: late, record: late.events[0] }, 'all'),
        (e) => e instanceof SourceError && e.code === 'conflict' && e.status === 412);
    ctx.env.request = plain;
    assert.deepEqual([store.get(cal, gym.id).location, store.get(cal, gym.id).status], ['Gym hall', 'confirmed']);
});

test('an occurrence found by its start, or a series found from its occurrence, with someone added at Google since: nothing is written', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const standup = store.insert(cal, {
        summary: 'Standup', start: at('2026-10-05T09:30:00'), end: at('2026-10-05T09:45:00'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10'],
        attendees: [{ email: 'ann@example.com' }],
    });
    store.patch(cal, `${standup.id}_20261026T163000Z`, { summary: 'Standup (late)', start: at('2026-10-26T10:00:00'), end: at('2026-10-26T10:15:00') });
    const { items } = await source.sync(calendar, undefined);
    const master = items.find((i) => i.remoteId === standup.id);
    const late = items.find((i) => i.remoteId === `${standup.id}_20261026T163000Z`);
    const conflict = (e) => e instanceof SourceError && e.code === 'conflict';
    const writes = () => store.requests.filter((r) => r.method === 'PATCH' || r.method === 'DELETE');

    // Bob joins the series at Google. One occurrence is found with events.instances, as Google has it now: it names
    // Bob, whom the change wasn't worked out with and Google would put the change before. Nothing is written.
    store.patch(cal, standup.id, { attendees: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }] });
    store.requests.length = 0;
    const monday = { item: master, record: master.events[0], occurrence: wall('2026-10-19T09:30:00') };
    await assert.rejects(source.update(calendar, monday, { start: wall('2026-10-19T10:00:00'), end: wall('2026-10-19T10:15:00') }, 'one'), conflict);
    await assert.rejects(source.remove(calendar, monday, 'one'), conflict);
    // The whole series through a changed occurrence (the plugin holds no etag of the series'): the same.
    await assert.rejects(source.update(calendar, { item: late, record: late.events[0] }, { title: 'Daily' }, 'all'), conflict);
    await assert.rejects(source.remove(calendar, { item: late, record: late.events[0] }, 'all'), conflict);
    assert.equal(writes().length, 0);
    assert.equal(store.get(cal, standup.id).summary, 'Standup');

    // Worked out with Bob on it, the occurrence moves.
    const bob = { ...master.events[0], attendees: [...master.events[0].attendees, { email: 'bob@example.com' }] };
    const [moved] = await source.update(calendar, { ...monday, planned: bob }, { start: wall('2026-10-19T10:00:00'), end: wall('2026-10-19T10:15:00') }, 'one');
    assert.deepEqual(moved.events[0].start, wall('2026-10-19T10:00:00'));
    assert.deepEqual(writes().map((r) => r.method), ['PATCH']);
});

test('a whole series with someone added at Google to one of its changed occurrences since: they are read too, and nothing is written', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const standup = store.insert(cal, {
        summary: 'Standup', start: at('2026-10-05T09:30:00'), end: at('2026-10-05T09:45:00'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10'],
        attendees: [{ email: 'ann@example.com' }],
    });
    const late = `${standup.id}_20261026T163000Z`;
    store.patch(cal, late, { summary: 'Standup (late)', start: at('2026-10-26T10:00:00'), end: at('2026-10-26T10:15:00') });
    const { items } = await source.sync(calendar, undefined);
    const master = items.find((i) => i.remoteId === standup.id);
    // Worked out as the manager does: on everyone on the series and its changed occurrences.
    const plannedOn = (list) => list.filter((i) => i.events[0].uid === standup.iCalUID).map((i) => i.events[0]);
    const conflict = (e) => e instanceof SourceError && e.code === 'conflict';
    const writes = () => store.requests.filter((r) => r.method === 'PATCH' || r.method === 'DELETE');

    // Xen is added at Google to the 26th alone. The series' etag is held, and still holds, but a change to all of it
    // reaches Xen: its changed occurrences are read too, and nothing is written.
    store.patch(cal, late, { attendees: [{ email: 'ann@example.com' }, { email: 'xen@example.com' }] });
    store.requests.length = 0;
    const all = { item: master, record: master.events[0], planned: plannedOn(items) };
    await assert.rejects(source.update(calendar, all, { title: 'Daily' }, 'all'), conflict);
    await assert.rejects(source.remove(calendar, all, 'all'), conflict);
    // So does a change from the 19th on, which reaches the 26th; from Nov 2 on, it doesn't, and the series ends before then.
    const series = { ...all, planned: [master.events[0]] };
    await assert.rejects(source.update(calendar, { ...series, from: wall('2026-10-19T09:30:00') }, { rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2' }, 'all'), conflict);
    assert.equal(writes().length, 0);
    assert.ok(requestsOf(store, 'GET', '/events').every((r) => r.query.iCalUID === standup.iCalUID));
    await source.update(calendar, { ...series, from: wall('2026-11-02T09:30:00') }, { rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4' }, 'all');
    assert.deepEqual(store.get(cal, standup.id).recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4']);

    // After a sync, worked out with Xen on it, a change to all of it goes.
    const { items: again } = await source.sync(calendar, undefined);
    const fresh = again.find((i) => i.remoteId === standup.id);
    await source.update(calendar, { item: fresh, record: fresh.events[0], planned: plannedOn(again) }, { title: 'Daily' }, 'all');
    assert.equal(store.get(cal, standup.id).summary, 'Daily');
    // Xen taken off the 26th at Google stops it again: the change would say Xen was told.
    store.patch(cal, late, { attendees: [{ email: 'ann@example.com' }] });
    const { items: last } = await source.sync(calendar, undefined);
    const now = last.find((i) => i.remoteId === standup.id);
    await assert.rejects(source.remove(calendar, { item: now, record: now.events[0], planned: plannedOn(again) }, 'all'), conflict);
    await source.remove(calendar, { item: now, record: now.events[0], planned: plannedOn(last) }, 'all');
    assert.equal(store.get(cal, standup.id).status, 'cancelled');
});

test('respond: the account\'s own answer, the rest of the guest list untouched', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    const guests = [
        { email: 'alex@example.com', displayName: 'Alex', responseStatus: 'accepted' },
        { email: store.user.email, responseStatus: 'needsAction' },
        { email: 'kim@example.com', displayName: 'Kim', responseStatus: 'tentative', comment: 'Might be late', optional: true },
    ];
    const invite = store.insert(cal, {
        summary: 'Design review', start: at('2026-10-15T10:00:00'), end: at('2026-10-15T11:00:00'), iCalUID: 'design-review-1@example.com',
        organizer: { email: 'alex@example.com', displayName: 'Alex' }, creator: { email: 'alex@example.com' }, attendees: guests,
    });
    const weekly = store.insert(cal, {
        summary: 'Weekly sync', start: at('2026-10-16T10:00:00'), end: at('2026-10-16T10:30:00'), recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
        organizer: { email: 'alex@example.com', displayName: 'Alex' }, creator: { email: 'alex@example.com' }, attendees: guests,
    });
    const { items } = await source.sync(calendar, undefined);
    const item = items.find((i) => i.remoteId === invite.id);
    const record = item.events[0];
    assert.equal(record.uid, 'design-review-1@example.com');
    assert.deepEqual(record.organizer, { email: 'alex@example.com', name: 'Alex' });
    assert.deepEqual(record.attendees, [
        { email: 'alex@example.com', name: 'Alex', status: 'accepted', organizer: true },
        { email: store.user.email, status: 'needs-action', self: true },
        { email: 'kim@example.com', name: 'Kim', status: 'tentative', role: 'optional' },
    ]);

    // A guest can't change the event itself.
    await assert.rejects(source.update(calendar, { item, record }, { title: 'Mine now' }, 'all'), (e) => e.code === 'forbidden');

    const [answered] = await source.respond(calendar, { item, record }, 'accepted', 'all');
    const patch = requestsOf(store, 'PATCH', `/events/${invite.id}`).at(-1);
    assert.equal(patch.query.sendUpdates, 'all', 'the organizer hears the answer');
    assert.ok(patch.ifMatch);
    assert.deepEqual(store.get(cal, invite.id).attendees, [
        { email: 'alex@example.com', displayName: 'Alex', responseStatus: 'accepted', organizer: true },
        { email: store.user.email, responseStatus: 'accepted', self: true },
        { email: 'kim@example.com', displayName: 'Kim', optional: true, responseStatus: 'tentative', comment: 'Might be late' },
    ]);
    assert.equal(answered.events[0].attendees.find((p) => p.self).status, 'accepted');

    // One occurrence of a recurring invitation.
    const series = items.find((i) => i.remoteId === weekly.id);
    const occurrence = wall('2026-10-23T10:00:00');
    const [declined] = await source.respond(calendar, { item: series, record: series.events[0], occurrence }, 'declined', 'one');
    assert.equal(declined.remoteId, `${weekly.id}_20261023T170000Z`);
    assert.deepEqual(declined.events[0].recurrenceId, occurrence);
    assert.equal(declined.events[0].attendees.find((p) => p.self).status, 'declined');
    assert.equal(store.get(cal, weekly.id).attendees.find((p) => p.self).responseStatus, 'needsAction');

    // The whole series.
    const all = await source.respond(calendar, { item: series, record: series.events[0] }, 'tentative', 'all');
    assert.equal(all.find((i) => i.remoteId === weekly.id).events[0].attendees.find((p) => p.self).status, 'tentative');

    // An event without the account on its guest list.
    const [own] = await source.create(calendar, { title: 'Alone', start: wall('2026-10-17T10:00:00'), end: wall('2026-10-17T11:00:00') });
    await assert.rejects(source.respond(calendar, { item: own, record: own.events[0] }, 'accepted', 'all'), (e) => e.code === 'forbidden');
});

test('errors: rate limits, refusals and outages in the codes the manager acts on', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar } = ctx;
    const messages = [];
    const expect = async (spec, check) => {
        store.failNext(spec);
        await assert.rejects(source.sync(calendar, undefined), (e) => {
            messages.push(e.message);
            return e instanceof SourceError && check(e);
        });
    };
    await expect({ status: 403, reason: 'rateLimitExceeded', domain: 'usageLimits', message: 'Rate Limit Exceeded' }, (e) => e.code === 'rate' && e.retryAfter === 60 && e.status === 403);
    await expect({ status: 403, reason: 'userRateLimitExceeded', domain: 'usageLimits', message: 'User Rate Limit Exceeded' }, (e) => e.code === 'rate');
    await expect({ status: 429, reason: 'rateLimitExceeded', domain: 'usageLimits', retryAfter: 7 }, (e) => e.code === 'rate' && e.retryAfter === 7);
    await expect({ status: 503, reason: 'backendError', message: 'Service Unavailable' }, (e) => e.code === 'rate' && e.retryAfter === 60);
    await expect({ status: 403, reason: 'forbidden', message: 'Forbidden' }, (e) => e.code === 'forbidden');
    await expect({ status: 403, reason: 'insufficientPermissions', message: 'Insufficient Permission' }, (e) => e.code === 'auth');
    await expect({ status: 404, reason: 'notFound', message: 'Not Found' }, (e) => e.code === 'not-found');
    await expect({ status: 500, reason: 'backendError', message: 'Backend Error' }, (e) => e.code === 'server');
    // A calendar this account can't see.
    await assert.rejects(source.sync({ remoteId: 'nobody@example.com' }, undefined), (e) => {
        messages.push(e.message);
        return e.code === 'not-found';
    });
    // Nothing answers.
    await ctx.server.close();
    await assert.rejects(source.calendars(), (e) => {
        messages.push(e.message);
        return e.code === 'network';
    });
    assertNoSecrets(ctx, [...messages, ...ctx.logs]);
    for (const message of messages) assert.doesNotMatch(message, /Bearer|ya29\.|GOCSPX/);
});

test('a description written in Google\'s editor reads as plain text', async (t) => {
    const ctx = await signedIn(t);
    const { store, source, calendar, cal } = ctx;
    store.insert(cal, {
        summary: 'Plan', start: at('2026-10-14T09:00:00'), end: at('2026-10-14T10:00:00'),
        description: 'Agenda:<br><ul><li>Scope</li><li>Dates &amp; owners</li></ul><a href="https://example.com/doc">The doc</a> and <a href="https://example.com/x">https://example.com/x</a>',
    });
    store.insert(cal, { summary: 'Plain', start: at('2026-10-14T11:00:00'), end: at('2026-10-14T12:00:00'), description: 'Bring <laptop> & charger' });
    const { items } = await source.sync(calendar, undefined);
    assert.equal(titled(items, 'Plan').events[0].description, 'Agenda:\n\n• Scope\n• Dates & owners\nThe doc (https://example.com/doc) and https://example.com/x');
    assert.equal(titled(items, 'Plain').events[0].description, 'Bring <laptop> & charger');
});
