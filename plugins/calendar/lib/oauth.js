/**
 * OAuth 2.0 sign-in for installed apps (RFC 8252, with PKCE from RFC 7636),
 * not tied to one provider. The plugin listens on this computer's loopback
 * address for the browser's redirect, then trades the code it brings for
 * tokens. When the browser runs on another device (DSH used remotely), the
 * redirect can't reach this computer: the user pastes the address the
 * browser ended on and `finish` completes the same exchange.
 *
 * A grant is what a sign-in leaves: {accessToken, refreshToken, expiresAt
 * (epoch ms), scope, tokenType, idToken?}. It lives only in the account's
 * secret; nothing here logs any of it or puts it in an error message.
 *
 * @module dsh-plugin-calendar/oauth
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { HttpError, formBody } from './http.js';
import { SourceError } from './sources/index.js';

/** An access token this close to expiring is renewed first. */
const MARGIN_MS = 2 * 60_000;

/** Lifetime assumed when the token endpoint doesn't say (an hour). */
const DEFAULT_LIFETIME_S = 3600;

/**
 * A PKCE pair: a random verifier and its S256 challenge.
 * @returns {{verifier: string, challenge: string, method: 'S256'}}
 */
export function pkce() {
    // 48 random bytes are 64 base64url characters, all of them "unreserved".
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    return { verifier, challenge, method: 'S256' };
}

/** A random state for an authorization request: the redirect must bring it back. */
export function randomState() {
    return randomBytes(24).toString('base64url');
}

/** The addresses the loopback listens on for each redirect host: localhost can mean either loopback address. */
const LISTEN_ON = { '127.0.0.1': ['127.0.0.1'], localhost: ['127.0.0.1', '::1'] };

/** Listen on a port (0: a free one) of one address; rejects with the listen error. */
function listen(server, port, address) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, address, () => {
            server.off('error', reject);
            resolve();
        });
    });
}

/**
 * Servers on one free port at each of `addresses`, the same port at all of
 * them. The first address must work. A later one this computer doesn't have
 * (no IPv6) is left out; one whose port is taken means another port, a few
 * times, and then it is left out too.
 * @param {string[]} addresses
 * @returns {Promise<{servers: import('node:http').Server[], port: number}>}
 */
async function listenAll(addresses) {
    for (let attempt = 1; ; attempt++) {
        const first = createServer();
        await listen(first, 0, addresses[0]);
        const { port } = first.address();
        const servers = [first];
        let taken = false;
        for (const address of addresses.slice(1)) {
            const server = createServer();
            try {
                await listen(server, port, address);
                servers.push(server);
            } catch (error) {
                taken = error?.code === 'EADDRINUSE' && attempt < 5;
                if (taken) break;
            }
        }
        if (!taken) return { servers, port };
        for (const server of servers) server.close();
    }
}

/**
 * Starts a sign-in: listens on this computer's loopback on a free port and
 * builds the address to open in the browser. The server answers one
 * redirect, then closes; it also closes on timeout and on cancel.
 * @param {object} options
 * @param {string} options.authorizeUrl - the provider's authorization endpoint.
 * @param {string} options.tokenUrl - the provider's token endpoint.
 * @param {string} options.clientId
 * @param {string} [options.clientSecret] - installed apps' "secret" (not confidential, but some providers want it).
 * @param {string[]} [options.scopes]
 * @param {Record<string, string>} [options.extraParams] - more authorization parameters (access_type, prompt, login_hint...).
 * @param {Function} options.request - lib/http.js `request`.
 * @param {number} [options.timeoutMs] - how long to wait for the browser (10 minutes).
 * @param {() => number} [options.now] - epoch ms.
 * @param {'127.0.0.1'|'localhost'} [options.redirectHost] - the host the redirect address names: 127.0.0.1 (the
 *   default), or localhost for a provider whose app registrations take only that (Microsoft's). With localhost
 *   the loopback listens on 127.0.0.1 and ::1 at one port, so the browser gets there whichever one localhost means.
 * @param {string} [options.redirectPath] - the redirect address's path: '/' (the default), or '' for an address
 *   that ends with its port, as the app has it registered (http://localhost; Microsoft ignores a localhost port).
 * @returns {Promise<{url: string, redirectUri: string, done: Promise<object>, finish: (pastedUrl: string) => Promise<object>, cancel: () => void}>}
 *   `done` settles with the grant (or a SourceError); `finish` completes the
 *   sign-in from a pasted redirect address (with any host) and settles the same way.
 */
export async function loopbackSignIn({
    authorizeUrl, tokenUrl, clientId, clientSecret, scopes = [], extraParams = {}, request,
    timeoutMs = 600_000, now = Date.now, redirectHost = '127.0.0.1', redirectPath = '/',
}) {
    let url;
    try {
        url = new URL(authorizeUrl);
    } catch {
        throw new SourceError('config', 'The sign-in address is not a valid URL.');
    }
    const host = redirectHost === 'localhost' ? 'localhost' : '127.0.0.1';
    const path = typeof redirectPath === 'string' ? redirectPath : '/';
    if (path !== '' && !/^\/[\w./~-]*$/.test(path)) throw new SourceError('config', 'The sign-in\'s redirect path is not a path.');
    const { verifier, challenge, method } = pkce();
    const state = randomState();
    const { servers, port } = await listenAll(LISTEN_ON[host]);
    const redirectUri = `http://${host}:${port}${path}`;
    // The path the browser asks for: an address without one comes back with '/'.
    const callbackPath = new URL(redirectUri).pathname;
    // The extra parameters can't replace the ones the exchange depends on.
    const params = {
        ...extraParams,
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
        code_challenge: challenge, code_challenge_method: method, state,
    };
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    let ended = false;
    let exchange;
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });
    // A caller that never awaits `done` (it cancelled) mustn't crash the process.
    done.catch(() => {});

    const timer = setTimeout(() => end(new SourceError('auth', 'The sign-in wasn\'t finished in time. Start it again.'), undefined, true), timeoutMs);
    timer.unref?.();

    /** Settles `done` once and stops listening. */
    function end(error, grant, force = false) {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        for (const server of servers) {
            server.close();
            // An answer still being written finishes first (it says Connection: close).
            if (force) server.closeAllConnections?.();
            else server.closeIdleConnections?.();
        }
        if (error) rejectDone(error);
        else resolveDone(grant);
    }

    /** Takes a redirect's parameters: starts the one exchange, or says why not. */
    function take(answer, pasted) {
        if (answer.get('state') !== state) {
            return {
                refused: new SourceError('auth', pasted
                    ? 'That address is from another sign-in. Paste the address the browser showed at the end of this one.'
                    : 'This answer is from another sign-in. Start the sign-in again.'),
            };
        }
        if (exchange === undefined) {
            if (ended) return { refused: new SourceError('auth', 'This sign-in has ended. Start it again.') };
            const error = answer.get('error');
            const code = answer.get('code');
            let started;
            if (error !== null) started = Promise.reject(new SourceError('auth', refusalText(error)));
            else if (!code) started = Promise.reject(new SourceError('auth', 'The sign-in page sent no code back. Start the sign-in again.'));
            else started = tradeCode({ tokenUrl, clientId, clientSecret, code, verifier, redirectUri, request, now });
            exchange = started.then(
                (grant) => {
                    end(undefined, grant);
                    return grant;
                },
                (failure) => {
                    end(failure);
                    throw failure;
                },
            );
            exchange.catch(() => {});
        }
        return { promise: exchange };
    }

    const onRequest = (req, res) => {
        let answer;
        try {
            const target = new URL(req.url ?? '/', redirectUri);
            if (req.method === 'GET' && target.pathname === callbackPath) answer = target.searchParams;
        } catch {
            answer = undefined;
        }
        if (answer === undefined || !(answer.has('state') || answer.has('code') || answer.has('error'))) {
            page(res, 404, 'There is nothing here.');
            return;
        }
        const taken = take(answer, false);
        if (taken.refused) {
            page(res, 400, `${taken.refused.message} You can close this tab.`);
            return;
        }
        taken.promise.then(
            () => page(res, 200, 'You\'re signed in. You can close this tab.'),
            (error) => page(res, 400, `The sign-in didn't finish: ${error.message} You can close this tab.`),
        );
    };
    for (const server of servers) server.on('request', onRequest);

    /** Completes the sign-in from the redirect address the user pasted. */
    async function finish(pastedUrl) {
        const answer = pastedParams(pastedUrl);
        if (answer === undefined || !(answer.has('code') || answer.has('error'))) {
            throw new SourceError('auth', `Paste the whole address the browser showed after you signed in (it starts with ${redirectUri}).`);
        }
        const taken = take(answer, true);
        if (taken.refused) throw taken.refused;
        return taken.promise;
    }

    return {
        url: url.toString(),
        redirectUri,
        done,
        finish,
        cancel: () => end(new SourceError('auth', 'The sign-in was cancelled.'), undefined, true),
    };
}

/**
 * A new grant from a refresh token. Keeps the old refresh token (and id
 * token) when the answer brings none, as Google's refresh answers do.
 * @param {object} options
 * @param {string} options.tokenUrl
 * @param {string} options.clientId
 * @param {string} [options.clientSecret]
 * @param {object} options.grant - the current grant.
 * @param {Function} options.request - lib/http.js `request`.
 * @param {() => number} [options.now]
 * @returns {Promise<object>} the new grant.
 */
export async function refreshGrant({ tokenUrl, clientId, clientSecret, grant, request, now = Date.now }) {
    if (typeof grant?.refreshToken !== 'string' || grant.refreshToken === '') {
        throw new SourceError('auth', 'The sign-in can\'t be renewed. Sign in again.');
    }
    const started = now();
    const res = await post(request, tokenUrl, {
        grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: clientId, client_secret: clientSecret,
    });
    if (!res.ok) throw tokenError(res, 'refresh');
    return grantOf(parseJson(res.text), started, grant);
}

/** Refreshes in flight, by secret: one at a time for each. */
const refreshing = new WeakMap();

/**
 * A usable access token from the grant in `secret`. One that expires
 * within 2 minutes, or that the server just refused (`rejected`), is
 * renewed first and the new grant saved through `secret.set`; callers that
 * ask meanwhile wait for that same renewal.
 * @param {{get: () => any, set: (grant: object) => any}} secret
 * @param {object} options
 * @param {string} options.tokenUrl
 * @param {string} options.clientId
 * @param {string} [options.clientSecret]
 * @param {Function} options.request - lib/http.js `request`.
 * @param {() => number} [options.now]
 * @param {string} [options.rejected] - an access token the server answered 401 to.
 * @returns {Promise<string>}
 */
export async function accessToken(secret, { tokenUrl, clientId, clientSecret, request, now = Date.now, rejected } = {}) {
    const grant = await secret.get();
    if (grant === undefined || grant === null || typeof grant !== 'object' || (!grant.accessToken && !grant.refreshToken)) {
        throw new SourceError('auth', 'This account isn\'t signed in. Sign in again.');
    }
    const fresh = typeof grant.accessToken === 'string' && grant.accessToken !== '' && grant.accessToken !== rejected
        && Number.isFinite(grant.expiresAt) && grant.expiresAt - now() > MARGIN_MS;
    if (fresh) return grant.accessToken;
    let pending = refreshing.get(secret);
    if (pending === undefined) {
        pending = (async () => {
            try {
                const next = await refreshGrant({ tokenUrl, clientId, clientSecret, grant, request, now });
                await secret.set(next);
                return next;
            } finally {
                refreshing.delete(secret);
            }
        })();
        refreshing.set(secret, pending);
    }
    return (await pending).accessToken;
}

/**
 * The claims of an id token (a JWT), without checking its signature: only
 * for a token that came straight from the token endpoint over https, and
 * only to learn who signed in. Undefined when it isn't a JWT.
 */
export function idTokenClaims(idToken) {
    if (typeof idToken !== 'string') return undefined;
    const parts = idToken.split('.');
    if (parts.length !== 3) return undefined;
    try {
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return claims !== null && typeof claims === 'object' ? claims : undefined;
    } catch {
        return undefined;
    }
}

/** Trades an authorization code (and the PKCE verifier) for a grant. */
async function tradeCode({ tokenUrl, clientId, clientSecret, code, verifier, redirectUri, request, now }) {
    const started = now();
    const res = await post(request, tokenUrl, {
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: clientId, client_secret: clientSecret, code_verifier: verifier,
    });
    if (!res.ok) throw tokenError(res, 'code');
    return grantOf(parseJson(res.text), started);
}

/** A form POST to the token endpoint. */
async function post(request, url, fields) {
    try {
        return await request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: formBody(fields),
        });
    } catch (error) {
        if (error instanceof HttpError) throw new SourceError(error.code === 'insecure' ? 'config' : 'network', error.message);
        throw error;
    }
}

/** A grant from a token answer, `started` being when the request went out. */
function grantOf(body, started, previous) {
    if (typeof body?.access_token !== 'string' || body.access_token === '') {
        throw new SourceError('server', 'The sign-in service sent no access token.');
    }
    const seconds = Number(body.expires_in);
    const grant = { accessToken: body.access_token };
    const refreshToken = text(body.refresh_token) ?? previous?.refreshToken;
    if (refreshToken) grant.refreshToken = refreshToken;
    grant.expiresAt = started + (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_LIFETIME_S) * 1000;
    const scope = text(body.scope) ?? previous?.scope;
    if (scope) grant.scope = scope;
    grant.tokenType = text(body.token_type) ?? 'Bearer';
    const idToken = text(body.id_token) ?? previous?.idToken;
    if (idToken) grant.idToken = idToken;
    return grant;
}

/** What a refresh the token endpoint turned down (invalid_grant) says: the sign-in has ended. */
export const SIGN_IN_ENDED = 'The sign-in has expired or was revoked. Sign in again.';

/** A SourceError for a token endpoint's refusal, in words without secrets. */
function tokenError(res, during) {
    const body = parseJson(res.text);
    // Only a well-formed OAuth error code is repeated (it is never a secret).
    const code = typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : undefined;
    const status = res.status;
    if (code === 'invalid_grant') {
        return new SourceError('auth', during === 'refresh'
            ? SIGN_IN_ENDED
            : 'The sign-in code wasn\'t accepted (it may have expired). Start the sign-in again.', { status });
    }
    if (code === 'invalid_client' || code === 'unauthorized_client') {
        return new SourceError('config', 'The sign-in service didn\'t accept the OAuth client id or secret in the settings.', { status });
    }
    if (status === 429 || status === 503) {
        return new SourceError('rate', 'The sign-in service asked to wait.', { status, retryAfter: retryAfter(res.headers) });
    }
    if (status >= 500) return new SourceError('server', `The sign-in service answered HTTP ${status}. Try again later.`, { status });
    return new SourceError('auth', `The sign-in service refused the request (${code ?? `HTTP ${status}`}).`, { status });
}

/** Seconds a Retry-After header asks for (a number of seconds or a date), else a minute. */
export function retryAfter(headers) {
    const value = headers?.get?.('retry-after');
    if (typeof value !== 'string' || value.trim() === '') return 60;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
    const when = Date.parse(value);
    return Number.isFinite(when) && when > Date.now() ? Math.ceil((when - Date.now()) / 1000) : 60;
}

/** In words, an error the authorization page sent back. */
function refusalText(error) {
    if (error === 'access_denied') return 'Access wasn\'t allowed on the sign-in page.';
    const code = /^[a-z_]{1,64}$/.test(error) ? error : 'an unknown error';
    return `The sign-in page answered with ${code}.`;
}

/** The parameters of a pasted redirect address (a whole URL, or just its query). */
function pastedParams(pasted) {
    const raw = String(pasted ?? '').trim();
    if (raw === '') return undefined;
    try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return new URL(raw).searchParams;
        return new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
    } catch {
        return undefined;
    }
}

/** A small plain page for the browser tab. */
function page(res, status, message) {
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in</title>'
        + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>'
        + `</head><body><p>${escapeHtml(message)}</p></body></html>`;
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'',
        Connection: 'close',
    });
    res.end(html);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);
}

function parseJson(body) {
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

const text = (value) => (typeof value === 'string' && value !== '' ? value : undefined);
