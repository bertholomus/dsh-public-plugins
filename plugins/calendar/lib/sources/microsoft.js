/**
 * Microsoft 365, Outlook.com and Exchange Online calendars, through
 * Microsoft Graph v1.0. An 'events' source in 'instances' mode: Graph's
 * calendar view hands over each occurrence of a series on its own.
 *
 * Sign-in is OAuth 2.0 on the Microsoft identity platform, for a public
 * client (no secret) the user registers in Microsoft Entra; its id goes in
 * the microsoftClientId setting and never in this repository. By default
 * the user signs in in the browser: the authorization code flow with PKCE
 * (lib/oauth.js), whose redirect comes back to this computer at
 * http://localhost and a free port. That is the redirect address the app
 * registers, under "Mobile and desktop applications": Microsoft ignores a
 * localhost address's port, and its portal takes http://127.0.0.1 only by
 * editing the app's manifest. The loopback listens on 127.0.0.1 and ::1,
 * whichever localhost means here. Signing in with a code is there too
 * (the device authorization grant: the user types a short code on
 * Microsoft's page, on any device, while the plugin polls); it needs the
 * app's "Allow public client flows", and the Conditional Access of many
 * work tenants turns it down. An access token lasts about an hour. The
 * refresh token is traded for a new grant shortly before that, or when
 * Graph turns a token down, and since Microsoft rotates refresh tokens
 * every new grant is saved. A public client can't revoke its grant at
 * Microsoft: revoke() names the page where the user withdraws the app's
 * access.
 *
 * A calendar syncs through its calendar view's delta query, for a window of
 * time: the first round reads every event in the window, later rounds only
 * what changed or went away. A different window (time moves on) or a sync
 * link Graph no longer knows starts over. Graph writes times in UTC (we ask
 * for that) and names the zone each event was made in; a record keeps the
 * wall clock in that zone, as iCalendar does. In the calendar view a series
 * is its occurrences: the series' own event is never an item, so a new
 * series comes back from create() as its occurrences in the window.
 *
 * A change is made only to the event as the plugin last read it: every
 * PATCH and DELETE sends If-Match with the event's etag, and Graph answers
 * 412 if the event changed meanwhile. Where the plugin holds none (a series
 * it holds only the occurrences of), the event is read just before, and
 * the change goes on only while it names nobody the change wasn't worked
 * out with (newPeople): Graph would email them, and no 412 would say the
 * event changed since the plugin read it. A new event
 * carries the record's uid as Graph's transactionId, so a create repeated
 * after a lost answer gets back the event the first one made, not a second.
 *
 * Microsoft emails invitations itself, with no way to hold them back:
 * saving an event with guests invites them, and adding guests invites the
 * new ones. So the source does either only when the record or the patch
 * says `notify: true`, and otherwise turns the change down with a 'config'
 * error that says why. Changing or deleting a meeting you organized tells
 * its guests too, as it does in Outlook.
 *
 * Settings: microsoftClientId (required), microsoftTenant ('common' by
 * default; 'organizations', 'consumers' or a tenant id), and for tests
 * microsoftGraphBase and microsoftLoginBase.
 *
 * @module dsh-plugin-calendar/sources/microsoft
 */
import { SourceError, otherPeople, peopleConflict, statusError } from './index.js';
import { formBody } from '../http.js';
import { cleanRecord } from '../model.js';
import { idTokenClaims, loopbackSignIn } from '../oauth.js';
import {
    addDays, daysBetween, ianaToWindows, ianaZone, isDay, isZone, normalLocal, toInstant, toLocal, wallMs, wallOf,
} from '../zones.js';

export const kind = 'microsoft';
export const style = 'events';

/**
 * The redirect address the user's app registers, under "Mobile and desktop
 * applications". The browser comes back to it with a port added, which
 * Microsoft ignores for localhost.
 */
export const REDIRECT_URI = 'http://localhost';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const SCOPE = 'offline_access Calendars.ReadWrite User.Read';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** The tenant personal Microsoft accounts sign in through. */
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';
/** Where the user withdraws an app's access to their account, by kind of account. */
const MANAGE_URLS = {
    personal: 'https://account.live.com/consent/Manage',
    work: 'https://myapplications.microsoft.com/',
};
/** Renew the sign-in when the access token has less than this left. */
const EARLY = 2 * 60_000;
const PREFER_UTC = 'outlook.timezone="UTC"';
const PREFER_PAGES = 'outlook.timezone="UTC", odata.maxpagesize=100';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
/** Pages one listing may take before we decide something is wrong. */
const MAX_PAGES = 2000;
const DAY = 86_400_000;
const INVITES = 'Microsoft emails every guest an invitation as soon as an event with guests is saved. '
    + 'Save it with guests only if they should be invited now; otherwise save it without them.';
const NEW_GUESTS = 'Microsoft emails every new guest an invitation as soon as they are added. Add guests only if they should be invited now.';

// ── Settings ───────────────────────────────────────────────────────────

/** The account settings this source reads, with Microsoft's addresses unless a test points elsewhere. */
function settingsOf(env) {
    const s = env?.settings ?? {};
    const base = (value, fallback) => String(value || fallback).trim().replace(/\/+$/, '');
    return {
        graph: base(s.microsoftGraphBase, GRAPH),
        login: base(s.microsoftLoginBase, LOGIN),
        tenant: String(s.microsoftTenant ?? '').trim() || 'common',
        clientId: typeof s.microsoftClientId === 'string' ? s.microsoftClientId.trim() : '',
    };
}

function clientIdOf(conf) {
    if (conf.clientId === '') {
        throw new SourceError('config', 'To use Microsoft calendars, set microsoftClientId in the calendar plugin\'s settings '
            + `to the application (client) ID of an app you registered in Microsoft Entra, with ${REDIRECT_URI} as a redirect URI `
            + 'under "Mobile and desktop applications".');
    }
    return conf.clientId;
}

const authorizeUrl = (conf) => `${conf.login}/${encodeURIComponent(conf.tenant)}/oauth2/v2.0/authorize`;
const tokenUrl = (conf) => `${conf.login}/${encodeURIComponent(conf.tenant)}/oauth2/v2.0/token`;
const deviceUrl = (conf) => `${conf.login}/${encodeURIComponent(conf.tenant)}/oauth2/v2.0/devicecode`;

/** What to check when Microsoft turns the app down. */
const CHECK_APP = 'Check that it is the app\'s application (client) ID and that microsoftTenant fits the account.';
/** And what signing in with a code needs besides. */
const CODE_FLOWS = ' Signing in with a code also needs the app\'s "Allow public client flows" turned on.';

// ── Talking to Microsoft ───────────────────────────────────────────────

/** env.request, with its failures as SourceErrors (their messages never hold a query or a header). */
async function send(env, url, init) {
    try {
        return await env.request(url, init);
    } catch (error) {
        if (error instanceof SourceError) throw error;
        const message = typeof error?.message === 'string' && error.name === 'HttpError' ? error.message : 'Couldn\'t reach Microsoft.';
        throw new SourceError(error?.code === 'insecure' ? 'config' : 'network', message);
    }
}

/** A response body as JSON, or {} when it is empty or isn't JSON (for error answers). */
function tryJson(response) {
    try {
        const value = JSON.parse(response.text);
        return value !== null && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

/** A success's body as JSON. */
function jsonOf(response, what) {
    if (typeof response.text !== 'string' || response.text === '') return {};
    try {
        const value = JSON.parse(response.text);
        if (value !== null && typeof value === 'object') return value;
    } catch {
        // Fall through to the error below.
    }
    throw new SourceError('server', `${what}: Microsoft sent something that isn't JSON (HTTP ${response.status}).`, { status: response.status });
}

/** Graph's error codes in an error answer, outermost first. */
function graphCodes(response) {
    const codes = [];
    let error = tryJson(response).error;
    for (let depth = 0; error !== null && typeof error === 'object' && depth < 6; depth++) {
        if (typeof error.code === 'string') codes.push(error.code);
        error = error.innerError ?? error.innererror;
    }
    return codes;
}

/** The SourceError for a Graph answer that wasn't a success; Graph's error code helps tell what went wrong. */
function fail(response, what) {
    const error = statusError(response.status, what, response.headers);
    const code = graphCodes(response).find((c) => /^[A-Za-z][\w.-]{0,79}$/.test(c));
    if (error.code === 'server' && code !== undefined) error.message = `${error.message.replace(/\.$/, '')} (${code}).`;
    return error;
}

/**
 * The SourceError for an answer from Microsoft's sign-in service (its errors are OAuth's).
 * `hint` follows what to check when Microsoft turns the app down.
 */
function loginFailure(response, what, hint = '') {
    const code = tryJson(response).error;
    const extra = { status: response.status };
    if (code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required') {
        return new SourceError('auth', `${what}: Microsoft asks you to sign in to this account again.`, extra);
    }
    if (['invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope', 'unsupported_grant_type', 'invalid_resource'].includes(code)) {
        return new SourceError('config', `${what}: Microsoft turned down the app set in microsoftClientId (${code}). ${CHECK_APP}${hint}`, extra);
    }
    if (code === 'temporarily_unavailable') {
        const after = Number(response.headers?.get?.('retry-after'));
        return new SourceError('rate', `${what}: Microsoft's sign-in service is busy.`, { ...extra, retryAfter: Number.isFinite(after) ? after : 30 });
    }
    return statusError(response.status, what, response.headers);
}

/** Whether a URL is on the same site (scheme, host and port) as another. */
function sameOrigin(a, b) {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
}

/** A number of seconds Microsoft sent, or the fallback. */
function seconds(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** A grant from a token answer. Microsoft sends a new refresh token each time; keep the old one if it didn't. */
function grantOf(body, now, previous = {}) {
    const grant = {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : previous.refreshToken,
        expiresAt: now + seconds(body.expires_in, 3600) * 1000,
        scope: typeof body.scope === 'string' && body.scope !== '' ? body.scope : previous.scope ?? SCOPE,
    };
    if (grant.refreshToken === undefined) delete grant.refreshToken;
    return grant;
}

/** Who signed in: GET /me. */
async function whoIs(env, conf, accessToken, signal) {
    const what = 'Reading the Microsoft account';
    const response = await send(env, `${conf.graph}/me`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal });
    if (!response.ok) throw fail(response, what);
    const me = jsonOf(response, what);
    const email = [me.mail, me.userPrincipalName].find((v) => typeof v === 'string' && v !== '') ?? '';
    return { email, name: typeof me.displayName === 'string' ? me.displayName : '' };
}

// ── Sign-in ────────────────────────────────────────────────────────────

/** The next wait between polls after a failure: twice as long, at most a minute. */
const backOff = (wait) => Math.min(Math.max(wait * 2, 100), 60_000);

const stopped = () => new SourceError('auth', 'The Microsoft sign-in was stopped.');
const expired = () => new SourceError('auth', 'The Microsoft sign-in code ran out before it was used. Start the sign-in again.');

/** Wait, unless the sign-in is stopped first. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(stopped());
            return;
        }
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            reject(stopped());
        };
        timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Start signing in to a Microsoft account. Nothing is saved here: `done`
 * settles with the grant to keep as the account's secret and who signed in
 * ({grant: {accessToken, refreshToken?, expiresAt, scope}, email, name}),
 * or with a SourceError ('auth' when the user declines, lets it run out or
 * it is cancelled), and the caller stores the grant.
 *
 * In the browser (the default): open `url`. Microsoft's page sends the
 * browser back to this computer at `redirectUri` (http://localhost and a
 * free port), and the code it brings is traded with PKCE. When the browser
 * runs on another device, the page it ends on doesn't load: the address it
 * shows, pasted into `finish`, completes the sign-in. `loginHint` names the
 * account to sign in to again; without it Microsoft asks which account.
 *
 * With a code (`method: 'code'`, OAuth 2.0's device authorization grant):
 * show the user `message`, or `userCode` and `verificationUri`, to type on
 * any device; `expiresAt` is when the code runs out.
 * @param {object} env - a source env (request, now and settings are used).
 * @param {{method?: 'browser'|'code', loginHint?: string, timeoutMs?: number}} [options] - timeoutMs: how long
 *   the browser sign-in waits (10 minutes).
 * @returns {Promise<{url: string, redirectUri: string, done: Promise<object>, finish: (pastedUrl: string) => Promise<object>,
 *   cancel: () => void} | {userCode: string, verificationUri: string, message: string, expiresAt: number,
 *   done: Promise<object>, cancel: () => void}>}
 */
export async function signIn(env, options = {}) {
    const conf = settingsOf(env);
    const clientId = clientIdOf(conf);
    if (options?.method === 'code') return signInWithCode(env, conf, clientId);
    return signInInBrowser(env, conf, clientId, options ?? {});
}

/** The browser sign-in (signIn without a method): the authorization code flow with PKCE, through lib/oauth.js. */
async function signInInBrowser(env, conf, clientId, { loginHint, timeoutMs }) {
    const hint = typeof loginHint === 'string' ? loginHint.trim() : '';
    // Signing in again goes straight to that account; a new one is picked on Microsoft's page.
    const extraParams = hint !== '' ? { login_hint: hint } : { prompt: 'select_account' };
    const flow = await loopbackSignIn({
        authorizeUrl: authorizeUrl(conf), tokenUrl: tokenUrl(conf), clientId, scopes: SCOPE.split(' '), extraParams,
        request: env.request, timeoutMs, now: env.now ?? Date.now, redirectHost: 'localhost', redirectPath: '',
    });
    const stop = new AbortController();
    const done = flow.done.then(async (tokens) => {
        // The same grant a code sign-in keeps.
        const grant = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scope: tokens.scope ?? SCOPE };
        if (grant.refreshToken === undefined) delete grant.refreshToken;
        try {
            const me = await whoIs(env, conf, grant.accessToken, stop.signal);
            return { grant, email: me.email, name: me.name };
        } catch (error) {
            if (stop.signal.aborted) throw stopped();
            throw error;
        }
    }, (error) => {
        throw stop.signal.aborted ? stopped() : appRefused(error);
    });
    done.catch(() => {});
    return {
        url: flow.url,
        redirectUri: flow.redirectUri,
        done,
        finish: async (pastedUrl) => {
            try {
                await flow.finish(pastedUrl);
            } catch (error) {
                throw appRefused(error);
            }
            return done;
        },
        cancel: () => {
            stop.abort();
            flow.cancel();
        },
    };
}

/**
 * A failed code exchange as the user can act on it: when Microsoft turned
 * the app down, what to check, a redirect registered for a web app (which
 * needs a secret) most of all.
 */
function appRefused(error) {
    if (!(error instanceof SourceError) || error.code !== 'config' || error.status === undefined) return error;
    return new SourceError('config', `Signing in to Microsoft: Microsoft turned down the app set in microsoftClientId. ${CHECK_APP} `
        + `The app needs ${REDIRECT_URI} as a redirect URI under "Mobile and desktop applications", not "Web".`, { status: error.status });
}

/** The sign-in with a code (signIn with method 'code'): OAuth 2.0's device authorization grant. */
async function signInWithCode(env, conf, clientId) {
    const what = 'Signing in to Microsoft';
    const response = await send(env, deviceUrl(conf), { method: 'POST', headers: FORM, body: formBody({ client_id: clientId, scope: SCOPE }) });
    if (!response.ok) throw loginFailure(response, what, CODE_FLOWS);
    const code = jsonOf(response, what);
    for (const key of ['device_code', 'user_code', 'verification_uri']) {
        if (typeof code[key] !== 'string' || code[key] === '') throw new SourceError('server', `${what}: Microsoft didn't send a sign-in code.`);
    }
    const expiresAt = env.now() + seconds(code.expires_in, 900) * 1000;
    const stop = new AbortController();
    const done = pollForGrant(env, conf, clientId, code, expiresAt, stop.signal);
    // A sign-in nobody waits for any more must not take the process down.
    done.catch(() => {});
    return {
        userCode: code.user_code,
        verificationUri: code.verification_uri,
        message: typeof code.message === 'string' && code.message !== ''
            ? code.message
            : `To sign in, open ${code.verification_uri} and enter the code ${code.user_code}.`,
        expiresAt,
        done,
        cancel: () => stop.abort(),
    };
}

/** Ask Microsoft for the grant every `interval` seconds until the user has signed in. */
async function pollForGrant(env, conf, clientId, code, expiresAt, signal) {
    const what = 'Signing in to Microsoft';
    let wait = seconds(code.interval, 5) * 1000;
    for (;;) {
        await sleep(wait, signal);
        if (env.now() >= expiresAt) throw expired();
        let response;
        try {
            response = await send(env, tokenUrl(conf), {
                method: 'POST', headers: FORM, signal,
                body: formBody({ grant_type: DEVICE_GRANT, client_id: clientId, device_code: code.device_code }),
            });
        } catch (error) {
            if (signal.aborted) throw stopped();
            // A dropped connection: ask less often, and keep asking while the code lasts.
            if (error instanceof SourceError && error.code === 'network') {
                wait = backOff(wait);
                continue;
            }
            throw error;
        }
        const body = tryJson(response);
        if (response.status >= 500 || response.status === 429 || body.error === 'temporarily_unavailable') {
            wait = backOff(wait);
            continue;
        }
        if (response.ok) {
            if (typeof body.access_token !== 'string' || body.access_token === '') throw new SourceError('server', `${what}: Microsoft didn't send a token.`);
            const grant = grantOf(body, env.now());
            try {
                const me = await whoIs(env, conf, grant.accessToken, signal);
                return { grant, email: me.email, name: me.name };
            } catch (error) {
                if (signal.aborted) throw stopped();
                throw error;
            }
        }
        switch (body.error) {
            case 'authorization_pending':
                break;
            case 'slow_down':
                wait += 5000;
                break;
            case 'expired_token':
                throw expired();
            case 'access_denied':
            case 'authorization_declined':
                throw new SourceError('auth', 'The Microsoft sign-in was declined.');
            case 'bad_verification_code':
                throw new SourceError('auth', 'Microsoft didn\'t recognize the sign-in code. Start the sign-in again.');
            default:
                throw loginFailure(response, what, CODE_FLOWS);
        }
    }
}

/**
 * What removing a Microsoft account can do about its sign-in. A public
 * client can't revoke its refresh token at Microsoft, so nothing is revoked
 * here: `manageUrl` is the page where the user withdraws the app's access,
 * for a personal account its Microsoft account page, for a work or school
 * account My Apps. microsoftTenant says which kind the account is, else
 * the access token does when it names its tenant (a work or school
 * account's does); a token that doesn't, or none, is taken for a personal
 * account's (Microsoft encrypts those). No network.
 * @param {object} env - a source env (settings is used).
 * @param {object} [secret] - the account's grant, or its secret ({get}).
 * @returns {Promise<{revoked: boolean, manageUrl?: string}>}
 */
export async function revoke(env, secret) {
    let grant;
    try {
        grant = typeof secret?.get === 'function' ? await secret.get() : secret;
    } catch {
        grant = undefined;
    }
    return { revoked: false, manageUrl: MANAGE_URLS[accountKind(settingsOf(env).tenant, grant)] };
}

/** 'personal' or 'work' (work or school): the kind of account a tenant setting and a grant are for. */
function accountKind(tenant, grant) {
    const setting = tenant.toLowerCase();
    if (setting === 'consumers' || setting === CONSUMERS) return 'personal';
    // 'organizations', or one tenant by its id or domain.
    if (setting !== 'common') return 'work';
    const claims = idTokenClaims(grant?.accessToken);
    const tid = typeof claims?.tid === 'string' ? claims.tid.toLowerCase() : '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tid) && tid !== CONSUMERS ? 'work' : 'personal';
}

// ── The source ─────────────────────────────────────────────────────────

/** Sign-in renewals in flight, by account id. */
const RENEWALS = new Map();

/**
 * A source for one Microsoft account (see sources/index.js for what each
 * method takes and returns). Its secret is the grant signIn gave.
 * @param {{id: string, email?: string}} account
 * @param {object} env
 */
export function create(account, env) {
    const conf = settingsOf(env);
    const ctx = {
        zone: isZone(env.zone) ? env.zone : 'UTC',
        email: typeof account?.email === 'string' ? account.email.trim().toLowerCase() : '',
    };
    // Renewals in flight are kept by account, so two sources for one account don't spend one refresh token twice.
    const renewalKey = typeof account?.id === 'string' && account.id !== '' ? account.id : Symbol('account');
    /** The window each calendar last synced, by remote id: a new series' occurrences are read for it. */
    const windows = new Map();

    async function storedGrant() {
        const grant = await env.secret?.get?.();
        if (grant === null || typeof grant !== 'object' || (typeof grant.accessToken !== 'string' && typeof grant.refreshToken !== 'string')) {
            throw new SourceError('auth', 'Sign in to this Microsoft account again.');
        }
        return grant;
    }

    const fresh = (grant) => typeof grant.accessToken === 'string' && grant.accessToken !== '' && Number(grant.expiresAt) - env.now() > EARLY;

    /** An access token with at least two minutes left. */
    async function accessToken() {
        const grant = await storedGrant();
        if (fresh(grant)) return grant.accessToken;
        return (await renew(grant.accessToken)).accessToken;
    }

    /** A new grant for the refresh token, one renewal at a time. `stale` is the access token that stopped working. */
    function renew(stale) {
        let run = RENEWALS.get(renewalKey);
        if (run === undefined) {
            run = renewNow(stale);
            RENEWALS.set(renewalKey, run);
            const clear = () => {
                if (RENEWALS.get(renewalKey) === run) RENEWALS.delete(renewalKey);
            };
            run.then(clear, clear);
        }
        return run;
    }

    async function renewNow(stale) {
        const what = 'Renewing the Microsoft sign-in';
        const grant = await storedGrant();
        // Someone renewed it meanwhile: use theirs.
        if (grant.accessToken !== stale && fresh(grant)) return grant;
        if (typeof grant.refreshToken !== 'string' || grant.refreshToken === '') throw new SourceError('auth', 'Sign in to this Microsoft account again.');
        const response = await send(env, tokenUrl(conf), {
            method: 'POST', headers: FORM,
            body: formBody({ client_id: clientIdOf(conf), grant_type: 'refresh_token', refresh_token: grant.refreshToken, scope: SCOPE }),
        });
        if (!response.ok) throw loginFailure(response, what);
        const body = jsonOf(response, what);
        if (typeof body.access_token !== 'string' || body.access_token === '') throw new SourceError('server', `${what}: Microsoft didn't send a token.`);
        const next = grantOf(body, env.now(), grant);
        // Microsoft rotates refresh tokens: the old one may stop working, so the new grant is saved right away.
        await env.secret.set(next);
        env.log?.('microsoft: renewed the sign-in');
        return next;
    }

    /** A Graph path, or a link Graph sent (a next page, a sync link) as long as it points at Graph. */
    function graphUrl(target) {
        if (target.startsWith('/')) return `${conf.graph}${target}`;
        if (!sameOrigin(target, conf.graph)) throw new SourceError('server', 'Microsoft sent a link to another site, which the plugin doesn\'t follow.');
        return target;
    }

    /**
     * One Graph exchange with the account's token, renewed when it runs out and once when Graph turns it down.
     * `etag`: only while the event still has it (If-Match); Graph answers 412 if it changed.
     */
    async function graph(method, target, { body, prefer = PREFER_UTC, signal, etag } = {}) {
        const url = graphUrl(target);
        let token = await accessToken();
        for (let attempt = 0; ; attempt++) {
            const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: prefer };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            if (etag !== undefined) headers['If-Match'] = matchOf(etag);
            const response = await send(env, url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
            if (response.status !== 401 || attempt > 0) return response;
            token = (await renew(token)).accessToken;
        }
    }

    /** One event as Graph has it now, or null when it is gone. */
    async function getEvent(id, signal) {
        const what = 'Reading an event from Microsoft';
        const response = await graph('GET', `/me/events/${encodeURIComponent(id)}`, { signal });
        if (response.status === 404) return null;
        if (!response.ok) throw fail(response, what);
        return jsonOf(response, what);
    }

    /**
     * The etag a change to an event ({id, etag?, event?, occurrences?,
     * copy?}) goes with: the one the plugin holds, else the one Graph has
     * now (never '*'), of the event just read (`event`) or read here. An
     * event read now must name the people the change was worked out with
     * (`planned`), no one more and no one less (otherPeople), else the
     * change is a conflict. A whole series is compared with its occurrences
     * as Graph has them now (`occurrences`, occurrencesNow), etag held or
     * not: changing one of them doesn't change the series' etag. With its
     * etag held, the plugin's copy of the series (`copy`) stands for it.
     * null when the event is gone; undefined only if Graph sends none.
     */
    async function etagFor(ref, planned, what) {
        const held = typeof ref.etag === 'string' && ref.etag !== '' ? ref.etag : undefined;
        if (held !== undefined && ref.occurrences === undefined) return held;
        let event;
        if (held === undefined) {
            event = ref.event !== undefined ? ref.event : await getEvent(ref.id);
            if (event === null) return null;
        }
        const now = [held === undefined ? recordOf(event, ctx) ?? {} : ref.copy ?? {}, ...(ref.occurrences ?? [])];
        const other = otherPeople(planned, now);
        if (other.length > 0) {
            env.log?.(`microsoft: the event names ${other.length} other people since the change was worked out`);
            throw peopleConflict(what);
        }
        return held ?? etagOf(event);
    }

    /**
     * A series' occurrences as Graph has them now (changed and cancelled
     * ones too), as records, in the window the calendar was synced over:
     * the window a change to the whole series is worked out on, from what
     * the calendar view brought of them. That window is in the sync state
     * kept with the events (`synced`, as sync() returned it), so it holds
     * from a start on, before the first sync. undefined when the series is
     * gone (a delete is done already, and a change is answered 404).
     */
    async function occurrencesNow(calendar, seriesId, synced, what) {
        const kept = typeof synced?.from === 'string' && typeof synced?.to === 'string' ? { from: synced.from, to: synced.to } : undefined;
        const window = kept ?? windows.get(calendar.remoteId) ?? windowOf(undefined, undefined, env.now());
        const out = [];
        try {
            for await (const event of instances(seriesId, window.from, window.to, what)) {
                const record = recordOf(event, ctx);
                if (record !== null) out.push(record);
            }
        } catch (error) {
            if (error instanceof SourceError && error.code === 'not-found') return undefined;
            throw error;
        }
        return out;
    }

    async function calendars() {
        const what = 'Reading the Microsoft calendars';
        const out = [];
        let next = '/me/calendars';
        for (let page = 0; next !== undefined; page++) {
            if (page >= MAX_PAGES) throw new SourceError('server', `${what}: Microsoft sent page after page.`);
            const response = await graph('GET', next);
            if (!response.ok) throw fail(response, what);
            const body = jsonOf(response, what);
            for (const cal of Array.isArray(body.value) ? body.value : []) {
                if (typeof cal?.id !== 'string' || cal.id === '') continue;
                const entry = { remoteId: cal.id, name: typeof cal.name === 'string' ? cal.name : '', readOnly: !cal.canEdit, mode: 'instances' };
                const color = calendarColor(cal);
                if (color !== undefined) entry.color = color;
                // The account's own calendar, where Outlook puts new events.
                if (cal.isDefaultCalendar === true) entry.primary = true;
                out.push(entry);
            }
            next = linkOf(body['@odata.nextLink']);
        }
        env.log?.(`microsoft: ${out.length} calendars`);
        return out;
    }

    /**
     * One round of the calendar view's delta query from `first`, every page of it.
     * null when `incremental` and Graph refuses the sync link (start over).
     */
    async function deltaRound(first, { signal, incremental }) {
        const what = 'Syncing a Microsoft calendar';
        const items = new Map();
        const removed = new Set();
        let next = first;
        for (let page = 0; ; page++) {
            if (page >= MAX_PAGES) throw new SourceError('server', `${what}: Microsoft sent page after page.`);
            const response = await graph('GET', next, { prefer: PREFER_PAGES, signal });
            if (!response.ok) {
                if (incremental && refused(response)) return null;
                throw fail(response, what);
            }
            const body = jsonOf(response, what);
            for (const entry of Array.isArray(body.value) ? body.value : []) {
                if (typeof entry?.id !== 'string' || entry.id === '') continue;
                const gone = () => {
                    items.delete(entry.id);
                    removed.add(entry.id);
                };
                if (entry['@removed'] !== undefined) {
                    gone();
                    continue;
                }
                // Delta may send only some of an event's fields: read the rest.
                const event = sparse(entry) ? await getEvent(entry.id, signal) : entry;
                if (event === null) {
                    gone();
                    continue;
                }
                // The calendar view sends occurrences, not series; skip a series if one comes anyway.
                if (event.type === 'seriesMaster') continue;
                const item = itemOf(event, ctx);
                if (item === null) continue;
                items.set(entry.id, item);
                removed.delete(entry.id);
            }
            const nextLink = linkOf(body['@odata.nextLink']);
            if (nextLink !== undefined) {
                next = nextLink;
                continue;
            }
            const deltaLink = linkOf(body['@odata.deltaLink']);
            if (deltaLink === undefined) throw new SourceError('server', `${what}: Microsoft ended the list without a link for the next sync.`);
            return { items: [...items.values()], removed: [...removed], deltaLink };
        }
    }

    async function sync(calendar, state, { from, to, signal } = {}) {
        const window = windowOf(from, to, env.now());
        windows.set(calendar.remoteId, window);
        const link = state?.deltaLink;
        if (typeof link === 'string' && state.from === window.from && state.to === window.to && sameOrigin(link, conf.graph)) {
            const changes = await deltaRound(link, { signal, incremental: true });
            if (changes !== null) {
                env.log?.(`microsoft: sync, ${changes.items.length} changed, ${changes.removed.length} removed`);
                return { reset: false, items: changes.items, removed: changes.removed, state: { deltaLink: changes.deltaLink, ...window } };
            }
            env.log?.('microsoft: Microsoft refused the sync link; reading the calendar again');
        }
        const query = `startDateTime=${encodeURIComponent(window.from)}&endDateTime=${encodeURIComponent(window.to)}`;
        const all = await deltaRound(`/me/calendars/${encodeURIComponent(calendar.remoteId)}/calendarView/delta?${query}`, { signal, incremental: false });
        env.log?.(`microsoft: full sync, ${all.items.length} events`);
        return { reset: true, items: all.items, removed: [], state: { deltaLink: all.deltaLink, ...window } };
    }

    /** A series' occurrences (changed ones too) that overlap a window of ISO times, page by page. */
    async function* instances(seriesId, from, to, what) {
        let next = `/me/events/${encodeURIComponent(seriesId)}/instances?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}`;
        for (let page = 0; next !== undefined; page++) {
            if (page >= MAX_PAGES) throw new SourceError('server', `${what}: Microsoft sent page after page.`);
            const response = await graph('GET', next, { prefer: PREFER_PAGES });
            if (!response.ok) throw fail(response, what);
            const body = jsonOf(response, what);
            for (const event of Array.isArray(body.value) ? body.value : []) {
                if (event !== null && typeof event === 'object' && event.type !== 'seriesMaster') yield event;
            }
            next = linkOf(body['@odata.nextLink']);
        }
    }

    /**
     * A series just saved, as the calendar view holds it: its occurrences in
     * the window the calendar last synced, each an item. The series is saved
     * already, so when they can't be read the next sync brings them.
     */
    async function savedSeries(calendar, seriesId) {
        const window = windows.get(calendar.remoteId) ?? windowOf(undefined, undefined, env.now());
        try {
            const items = [];
            for await (const event of instances(seriesId, window.from, window.to, 'Reading the series from Microsoft')) {
                const item = itemOf(event, ctx);
                if (item !== null) items.push(item);
            }
            return items;
        } catch (error) {
            env.log?.(`microsoft: the series' occurrences come with the next sync (${error instanceof SourceError ? error.code : 'error'})`);
            return [];
        }
    }

    /**
     * The occurrence a target means: its item {id, etag}, or one looked up
     * in the series by its original start {id, event} (as Graph has it now).
     */
    async function occurrenceOf(target, seriesId) {
        const { item, record } = partsOf(target);
        if (record?.seriesRemoteId !== undefined && item.remoteId !== seriesId) return { id: item.remoteId, etag: item.etag };
        const when = target.occurrence ?? record?.recurrenceId;
        if (when === undefined || when === null) throw new SourceError('not-found', 'Which occurrence of the series to change wasn\'t given.');
        const at = instantOfTime(when, ctx.zone);
        for await (const event of instances(seriesId, isoSeconds(at - 2 * DAY), isoSeconds(at + 2 * DAY), 'Finding the occurrence on Microsoft')) {
            const found = recordOf(event, ctx);
            if (found?.recurrenceId !== undefined && sameTime(found.recurrenceId, when, ctx.zone)) return { id: event.id, event };
        }
        throw new SourceError('not-found', 'That occurrence isn\'t in the series on Microsoft any more.');
    }

    /**
     * The series a change to all of it goes to, {id, etag?, event?, master?}:
     * with the series' own etag when the plugin holds it (the item's when
     * the item is the series; an occurrence's isn't the series'), else as
     * Graph has it now (event); its event (master) when `withEvent`.
     */
    async function seriesRef(item, seriesId, withEvent) {
        const own = item.remoteId === seriesId && typeof item.etag === 'string' && item.etag !== '' ? item.etag : undefined;
        if (own !== undefined && !withEvent) return { id: seriesId, etag: own };
        const master = await getEvent(seriesId);
        if (master === null) throw new SourceError('not-found', 'The series isn\'t on Microsoft any more.');
        return own !== undefined ? { id: seriesId, etag: own, master } : { id: seriesId, event: master, master };
    }

    /** Graph's start, end and repeat pattern for the whole series (`master`) when one of its occurrences moves (or its rule changes). */
    function seriesTimes(master, record, patch) {
        const moves = 'start' in patch || 'end' in patch;
        if (!moves && !('rrule' in patch)) return {};
        const series = recordOf(master, ctx);
        if (series === null) throw new SourceError('server', 'Microsoft sent the series without its times.');
        const times = moves && record?.start !== undefined ? shiftSeries(series, record, patch, ctx) : { start: series.start, end: series.end };
        const out = moves ? timesFor(times.start, times.end, ctx) : {};
        if ('rrule' in patch) {
            out.recurrence = typeof patch.rrule === 'string' && patch.rrule !== '' ? patternFromRrule(patch.rrule, times.start) : null;
        } else if (moves && master.recurrence) {
            const startDate = dateOf(times.start);
            const shift = daysBetween(dateOf(series.start), startDate);
            if (shift !== 0) out.recurrence = shiftRecurrence(master.recurrence, shift, startDate);
        }
        return out;
    }

    /**
     * A new event: [its item], or for a series its occurrences in the
     * window (none when the window has none). With guests only when the
     * record says `notify: true`: saving them invites them. The record's uid
     * is Graph's transactionId: the same create again (a repeat after its
     * answer was lost) gets back the event the first one made.
     */
    async function createEvent(calendar, record) {
        const what = 'Saving the event on Microsoft';
        const given = Object.fromEntries(Object.entries(record ?? {}).filter(([, v]) => v !== undefined && v !== null));
        if (given.start === undefined) throw new SourceError('config', 'An event needs a start before it can be saved.');
        if (attendeesFor(given.attendees, ctx).length > 0 && given.notify !== true) throw new SourceError('config', INVITES);
        const body = { ...fieldsFor(given, ctx), ...timesFor(given.start, given.end, ctx) };
        if (typeof given.rrule === 'string' && given.rrule !== '') body.recurrence = patternFromRrule(given.rrule, given.start);
        if (typeof given.uid === 'string' && given.uid !== '') body.transactionId = given.uid;
        const response = await graph('POST', `/me/calendars/${encodeURIComponent(calendar.remoteId)}/events`, { body });
        if (!response.ok) {
            // The uid made an event already, one with other details: the next sync brings it.
            if (graphCodes(response).includes('ErrorDuplicateTransactionId')) {
                throw new SourceError('conflict', `${what}: Microsoft already has an event saved from an earlier try, with other details. `
                    + 'Look for it in the calendar before adding this one again.', { status: response.status });
            }
            throw fail(response, what);
        }
        const event = jsonOf(response, what);
        if (isSeries(event)) return savedSeries(calendar, event.id);
        const item = itemOf(event, ctx);
        return item === null ? [] : [item];
    }

    /**
     * Change an event, one occurrence ('one'), or a whole series ('all':
     * [] then, as its occurrences come with the next sync). New guests only
     * when the patch, the target or its record says `notify: true`. Only
     * while the event is as the plugin read it (If-Match): a 412 is a
     * 'conflict', and so is an event read just before that names people
     * target.planned doesn't (etagFor).
     */
    async function update(calendar, target, patch = {}, scope = 'all') {
        const what = 'Saving the event on Microsoft';
        const { item, record } = partsOf(target);
        const planned = target.planned ?? record;
        if (addsGuests(record, patch, ctx) && ![patch, target, record].some((x) => x?.notify === true)) throw new SourceError('config', NEW_GUESTS);
        const seriesId = seriesOf(item, record);
        let ref;
        let body;
        if (seriesId !== undefined && scope === 'one') {
            body = { ...fieldsFor(patch, ctx), ...movedTimes(record, patch, ctx) };
            if (Object.keys(body).length === 0) return [];
            ref = await occurrenceOf(target, seriesId);
        } else if (seriesId !== undefined) {
            const fields = fieldsFor(patch, ctx);
            const times = 'start' in patch || 'end' in patch || 'rrule' in patch;
            if (Object.keys(fields).length === 0 && !times) return [];
            // New times and rules are worked out from the series as Graph has it.
            ref = await seriesRef(item, seriesId, times);
            body = { ...fields, ...(times ? seriesTimes(ref.master, record, patch) : {}) };
            // It reaches every occurrence: who they name is read too.
            ref.occurrences = await occurrencesNow(calendar, seriesId, target.synced, what);
            if (item.remoteId === seriesId) ref.copy = record;
        } else {
            ref = { id: item.remoteId, etag: item.etag };
            body = { ...fieldsFor(patch, ctx), ...movedTimes(record, patch, ctx) };
            // A rule makes a single event a series.
            const start = patch.start ?? record?.start;
            if (typeof patch.rrule === 'string' && patch.rrule !== '' && start) body.recurrence = patternFromRrule(patch.rrule, start);
            if (Object.keys(body).length === 0) return [];
        }
        const etag = await etagFor(ref, planned, what);
        if (etag === null) throw new SourceError('not-found', `${what}: the event isn't on Microsoft any more.`);
        const response = await graph('PATCH', `/me/events/${encodeURIComponent(ref.id)}`, { body, etag });
        if (!response.ok) throw fail(response, what);
        // The whole series changed: its occurrences come with the next sync.
        if (seriesId !== undefined && scope !== 'one') return [];
        const event = jsonOf(response, what);
        // A single event that took a rule is a series now, so in the calendar view it is its
        // occurrences: its own item empties (the next sync drops it) and theirs come instead.
        if (isSeries(event)) return [{ remoteId: item.remoteId, events: [] }, ...(await savedSeries(calendar, event.id))];
        const changed = itemOf(event, ctx);
        return changed === null ? [] : [changed];
    }

    /**
     * Delete an event, one occurrence ('one') or a whole series ('all');
     * only while it is as the plugin read it (If-Match), or, read just
     * before, names nobody target.planned doesn't (etagFor).
     */
    async function remove(calendar, target, scope = 'all') {
        const { item, record } = partsOf(target);
        const planned = target.planned ?? record;
        const seriesId = seriesOf(item, record);
        // A whole series goes with its own etag: the item's only when the item is the series (an occurrence's isn't the series').
        let ref = { id: item.remoteId, etag: item.etag };
        if (seriesId !== undefined && scope === 'one') ref = await occurrenceOf(target, seriesId);
        else if (seriesId !== undefined) {
            // It takes out every occurrence: who they name is read too.
            const own = item.remoteId === seriesId;
            ref = { id: seriesId, etag: own ? item.etag : undefined, occurrences: await occurrencesNow(calendar, seriesId, target.synced, 'Deleting the event on Microsoft'), ...(own ? { copy: record } : {}) };
        }
        const removed = scope === 'one' ? [ref.id] : [...new Set([ref.id, item.remoteId])];
        const etag = await etagFor(ref, planned, 'Deleting the event on Microsoft');
        // Gone already is what was asked for.
        if (etag === null) return { removed, items: [] };
        const response = await graph('DELETE', `/me/events/${encodeURIComponent(ref.id)}`, { etag });
        if (!response.ok && response.status !== 404) throw fail(response, 'Deleting the event on Microsoft');
        return { removed, items: [] };
    }

    async function respond(calendar, target, status, scope = 'all') {
        const action = { accepted: 'accept', declined: 'decline', tentative: 'tentativelyAccept' }[status];
        if (action === undefined) throw new SourceError('config', 'An invitation can be accepted, declined or answered with maybe.');
        const { item, record } = partsOf(target);
        const seriesId = seriesOf(item, record);
        const id = seriesId !== undefined && scope === 'one' ? (await occurrenceOf(target, seriesId)).id : seriesId ?? item.remoteId;
        const response = await graph('POST', `/me/events/${encodeURIComponent(id)}/${action}`, { body: { sendResponse: true } });
        if (!response.ok) throw fail(response, 'Answering the invitation on Microsoft');
        if (seriesId !== undefined && scope !== 'one') return [];
        const event = await getEvent(id);
        const changed = event === null ? null : itemOf(event, ctx);
        return changed === null ? [] : [changed];
    }

    return { calendars, sync, create: createEvent, update, remove, respond };
}

// ── Sync helpers ───────────────────────────────────────────────────────

/** A link Graph sent, or undefined. */
const linkOf = (value) => (typeof value === 'string' && value !== '' ? value : undefined);

/** An instant as Graph takes it in a query: '2026-10-11T00:00:00Z'. */
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The calendar view's window as ISO times, widened to whole days in UTC so
 * it stays the same through a day and the sync link keeps working.
 */
function windowOf(from, to, now) {
    const start = Number.isFinite(Number(from)) && from !== null && from !== undefined ? Number(from) : now - 31 * DAY;
    const end = Number.isFinite(Number(to)) && to !== null && to !== undefined ? Number(to) : now + 366 * DAY;
    const a = Math.floor(start / DAY) * DAY;
    const b = Math.max(a + DAY, Math.ceil(end / DAY) * DAY);
    return { from: isoSeconds(a), to: isoSeconds(b) };
}

/** Graph's named calendar colors (light ones, as Outlook shows them) when a calendar has no hexColor. */
const NAMED_COLORS = {
    lightblue: '#8cbdea', lightgreen: '#8fd18a', lightorange: '#f7b26b', lightgray: '#b8b8b8', lightyellow: '#f2d56b',
    lightteal: '#6fcfcf', lightpink: '#f19cc4', lightbrown: '#c9a27e', lightred: '#f08c8c',
};

/** A calendar's color as '#rrggbb': its hexColor, else its named color ('auto' has none). */
function calendarColor(cal) {
    const hex = typeof cal.hexColor === 'string' ? cal.hexColor.trim() : '';
    if (/^#?[0-9a-f]{6}$/i.test(hex)) return `#${hex.replace(/^#/, '').toLowerCase()}`;
    return NAMED_COLORS[String(cal.color ?? '').toLowerCase()];
}

/** Whether Graph turned a sync link down, so the calendar has to be read again. */
function refused(response) {
    if (response.status === 410 || response.status === 400) return true;
    return graphCodes(response).some((c) => /^(syncStateNotFound|resyncRequired|syncStateInvalid|ErrorInvalidSyncStateData)$/i.test(c));
}

/** Whether a delta entry left out what an event needs. */
const sparse = (entry) => !('subject' in entry) || typeof entry.start?.dateTime !== 'string' || typeof entry.end?.dateTime !== 'string';

/** Whether Graph's event is a series' own event (its "series master"). */
const isSeries = (event) => event?.type === 'seriesMaster' || (event?.type === undefined && typeof event?.recurrence === 'object' && event.recurrence !== null);

/** The item and record a change targets. */
function partsOf(target) {
    const item = target?.item;
    if (item === null || typeof item !== 'object' || typeof item.remoteId !== 'string') {
        throw new SourceError('not-found', 'The event to change isn\'t one this Microsoft calendar knows.');
    }
    return { item, record: target.record ?? item.events?.[0] };
}

/** The id of the series an item belongs to (or is), or undefined for a single event. */
function seriesOf(item, record) {
    if (typeof record?.seriesRemoteId === 'string' && record.seriesRemoteId !== '') return record.seriesRemoteId;
    if (typeof record?.rrule === 'string' && record.rrule !== '') return item.remoteId;
    return undefined;
}

// ── Reading Graph's events ─────────────────────────────────────────────

/**
 * The IANA zone a zone name from Graph stands for (originalStartTimeZone
 * and the like): a Windows name, an IANA id, 'UTC' or
 * 'tzone://Microsoft/Utc'. `fallback` (the user's zone) for
 * 'tzone://Microsoft/Custom' (a zone Outlook made up) and names it doesn't know.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function graphZone(name, fallback = 'UTC') {
    const raw = String(name ?? '').trim();
    if (raw === '') return fallback;
    if (/^tzone:\/\/Microsoft\/Utc$/i.test(raw)) return 'UTC';
    if (/^tzone:\/\//i.test(raw)) return fallback;
    return ianaZone(raw) ?? fallback;
}

/** The zone a record's tz names, or the user's zone for a floating time or one this runtime doesn't know. */
const zoneFor = (tz, fallback) => (tz === null || tz === undefined || tz === '' ? fallback : ianaZone(tz) ?? fallback);

/** The instant a record's Time starts at; a day starts at midnight in `zone`. */
function instantOfTime(time, zone) {
    if ('date' in time) return toInstant(`${time.date}T00:00:00`, zone, zone);
    return toInstant(time.local, zoneFor(time.tz, zone), zone);
}

/** Whether two Times mean the same start (days by their date). */
function sameTime(a, b, zone) {
    if ('date' in a || 'date' in b) return dateOf(a) === dateOf(b);
    return instantOfTime(a, zone) === instantOfTime(b, zone);
}

/** The day a Time falls on, as written. */
const dateOf = (time) => ('date' in time ? time.date : String(time.local).slice(0, 10));

/** An ISO time in UTC (Graph's DateTimeOffset, '2026-10-12T16:30:00Z', any fraction) as epoch ms. */
function utcMs(value) {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(String(value ?? '').trim());
    if (m === null) return NaN;
    const wall = wallMs(m[1]);
    if (m[2] === undefined || m[2].toUpperCase() === 'Z') return wall;
    const digits = m[2].slice(1).replace(':', '');
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
    return wall - (m[2][0] === '-' ? -1 : 1) * minutes * 60_000;
}

/**
 * The day an all-day bound falls on. Graph sends midnight to midnight; if
 * a zone moved it off midnight, the nearest midnight in the event's zone.
 */
function dayOf(local, given, zone) {
    if (local.endsWith('T00:00:00')) return local.slice(0, 10);
    const there = toLocal(toInstant(local, given, 'UTC'), zone);
    return Number(there.slice(11, 13)) >= 12 ? addDays(there.slice(0, 10), 1) : there.slice(0, 10);
}

/** A Graph dateTimeTimeZone as a Time: the wall clock in `zone` (the zone the event was made in), or a day. */
function timeOf(dtz, zone, allDay) {
    const local = normalLocal(dtz?.dateTime);
    if (local === undefined) return undefined;
    const given = graphZone(dtz.timeZone, 'UTC');
    if (allDay) return { date: dayOf(local, given, zone) };
    return { local: toLocal(toInstant(local, given, 'UTC'), zone), tz: zone };
}

/** An occurrence's originalStart (UTC) as a Time in the series' zone. */
function originalOf(value, zone, allDay) {
    const ms = utcMs(value);
    if (!Number.isFinite(ms)) return undefined;
    if (allDay) return { date: dayOf(toLocal(ms, 'UTC'), 'UTC', zone) };
    return { local: toLocal(ms, zone), tz: zone };
}

/** Exchange's global object id in hex: a class id, then the occurrence's date (zeros for the series). */
const GLOBAL_ID = /^040000008200E00074C5B7101A82E008[0-9A-F]{8}/i;

/**
 * The record's UID. Graph's iCalUId differs for each occurrence (its date
 * is in it); without the date it is the series' UID, as iCalendar has it.
 */
function uidOf(event) {
    const uid = typeof event.iCalUId === 'string' && event.iCalUId !== '' ? event.iCalUId : event.id;
    if ((event.type === 'occurrence' || event.type === 'exception') && GLOBAL_ID.test(uid)) return `${uid.slice(0, 32)}00000000${uid.slice(40)}`;
    return uid;
}

const RESPONSES = {
    none: 'needs-action', notresponded: 'needs-action', accepted: 'accepted', declined: 'declined',
    tentativelyaccepted: 'tentative', organizer: 'accepted',
};
const ROLES = { required: 'required', optional: 'optional', resource: 'non-participant' };
const BUSY = { free: false, busy: true, tentative: true, oof: true, workingelsewhere: true };
const PRIVACY = { private: 'private', confidential: 'confidential' };

/** A Graph recipient as a Person. */
function personOf(recipient) {
    const address = recipient?.emailAddress?.address;
    if (typeof address !== 'string' || address.trim() === '') return undefined;
    const person = { email: address.trim() };
    const name = recipient.emailAddress.name;
    if (typeof name === 'string' && name.trim() !== '' && name.trim() !== person.email) person.name = name.trim();
    return person;
}

const isSelf = (person, ctx) => ctx.email !== '' && person.email.toLowerCase() === ctx.email;

function attendeesOf(event, ctx) {
    if (!Array.isArray(event.attendees)) return undefined;
    // The account's own answer is in responseStatus; its row among the attendees can lag.
    const own = RESPONSES[String(event.responseStatus?.response ?? '').toLowerCase()];
    const out = [];
    for (const attendee of event.attendees) {
        const person = personOf(attendee);
        if (person === undefined) continue;
        const response = String(attendee.status?.response ?? '').toLowerCase();
        const self = isSelf(person, ctx);
        person.status = (self ? own : undefined) ?? RESPONSES[response] ?? 'needs-action';
        person.role = response === 'organizer' ? 'chair' : ROLES[String(attendee.type ?? '').toLowerCase()] ?? 'required';
        if (self) person.self = true;
        out.push(person);
    }
    return out;
}

function organizerOf(event, ctx, attendees) {
    const person = personOf(event.organizer);
    if (person === undefined) return undefined;
    const self = event.isOrganizer === true || isSelf(person, ctx);
    // Your own appointment without guests has no organizer to speak of.
    if (self && !(attendees?.length > 0)) return undefined;
    if (self) person.self = true;
    return person;
}

/** A Graph body as plain text. */
function textOf(body) {
    if (body === null || typeof body !== 'object' || typeof body.content !== 'string') return undefined;
    const text = String(body.contentType ?? '').toLowerCase() === 'html' ? htmlToText(body.content) : body.content;
    return text.trim() === '' ? undefined : text;
}

/** A Graph event as a record, or null when it lacks its times. */
function recordOf(event, ctx) {
    if (event === null || typeof event !== 'object') return null;
    const allDay = event.isAllDay === true;
    const startZone = graphZone(event.originalStartTimeZone, ctx.zone);
    const endZone = graphZone(event.originalEndTimeZone, startZone);
    const start = timeOf(event.start, startZone, allDay);
    if (start === undefined) return null;
    let end = timeOf(event.end, endZone, allDay);
    if (allDay && !(end?.date > start.date)) end = { date: addDays(start.date, 1) };
    if (!allDay && end === undefined) end = start;
    const attendees = attendeesOf(event, ctx);
    const alarm = Number(event.reminderMinutesBeforeStart);
    const record = {
        uid: uidOf(event),
        title: typeof event.subject === 'string' ? event.subject : '',
        description: textOf(event.body),
        location: typeof event.location?.displayName === 'string' ? event.location.displayName : undefined,
        start,
        end,
        allDay,
        status: event.isCancelled === true ? 'cancelled' : undefined,
        busy: BUSY[String(event.showAs ?? '').toLowerCase()],
        privacy: PRIVACY[String(event.sensitivity ?? '').toLowerCase()],
        organizer: organizerOf(event, ctx, attendees),
        attendees,
        alarms: event.isReminderOn === true && Number.isFinite(alarm) && alarm >= 0 ? [alarm] : undefined,
        conference: [event.onlineMeeting?.joinUrl, event.onlineMeetingUrl].find((u) => typeof u === 'string' && u !== ''),
        categories: Array.isArray(event.categories) ? event.categories.filter((c) => typeof c === 'string' && c !== '') : undefined,
        created: typeof event.createdDateTime === 'string' ? event.createdDateTime : undefined,
        updated: typeof event.lastModifiedDateTime === 'string' ? event.lastModifiedDateTime : undefined,
    };
    if (event.type === 'occurrence' || event.type === 'exception') {
        if (typeof event.seriesMasterId === 'string') record.seriesRemoteId = event.seriesMasterId;
        record.recurrenceId = originalOf(event.originalStart, startZone, allDay) ?? start;
    } else if (event.type === 'seriesMaster' && event.recurrence) {
        try {
            record.rrule = rruleFromPattern(event.recurrence, start);
        } catch {
            // A pattern no rule can say: the series' occurrences still come one by one.
        }
    }
    return cleanRecord(record);
}

/** A Graph event as an Item, or null when it lacks its times. */
function itemOf(event, ctx) {
    const record = recordOf(event, ctx);
    if (record === null || typeof event.id !== 'string') return null;
    const item = { remoteId: event.id, events: [record] };
    const etag = etagOf(event);
    if (etag !== undefined) item.etag = etag;
    return item;
}

/** An event's etag: Graph's @odata.etag ('W/"<changeKey>"'), else its changeKey; undefined when it has neither. */
const etagOf = (event) => [event?.['@odata.etag'], event?.changeKey].find((v) => typeof v === 'string' && v !== '');

/** An etag as If-Match takes it: Graph's as it is, a bare changeKey in the weak form Graph gives it. */
const matchOf = (etag) => (/^(W\/)?"/.test(etag) ? etag : `W/"${etag}"`);

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
    ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
    laquo: '«', raquo: '»', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥',
    cent: '¢', sect: '§', para: '¶', deg: '°', plusmn: '±', times: '×', divide: '÷', iexcl: '¡', iquest: '¿',
};

/** HTML entities decoded in one pass, so '&amp;lt;' stays '&lt;'. */
function decodeEntities(text) {
    return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,8});/gi, (whole, name) => {
        if (name[0] === '#') {
            const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
            if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
            return String.fromCodePoint(code);
        }
        return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
    });
}

/**
 * HTML (an event body) as plain text: each block (paragraph, div, list
 * item, row) a line, an empty one (Outlook writes `<p>&nbsp;</p>` or
 * `<div><br></div>`) a blank line, `<br>` a line break; tags go, entities
 * are decoded and white space tidied.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
    const BLOCK = '\u0001';
    let text = String(html ?? '');
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    text = text.replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    // HTML reads every run of white space as one space; its lines come from tags.
    text = text.replace(/\s+/g, ' ');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<li\b[^>]*>/gi, `${BLOCK}- `);
    text = text.replace(/<\/?(html|body|p|div|tr|h[1-6]|blockquote|pre|table|ul|ol|li|section|article|header|footer|hr)\b[^>]*>/gi, BLOCK);
    text = text.replace(/<\/t[dh]\s*>/gi, ' ');
    text = text.replace(/<[^>]*>/g, '');
    const lines = [];
    for (const block of decodeEntities(text).split(BLOCK)) {
        // Only the white space between two tags: no line.
        if (/^[ \t]*$/.test(block)) continue;
        // A <br> that ends a block doesn't start another line.
        for (const line of block.replace(/\n[ \t ]*$/, '').split('\n')) lines.push(line.replace(/[ \t ]+/g, ' ').trim());
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Writing Graph's events ─────────────────────────────────────────────

/** The name Graph takes for a zone: its Windows name when it has one, else the IANA id. */
const zoneName = (zone) => (zone === 'UTC' ? 'UTC' : ianaToWindows(zone) ?? zone);

/** A timed Time as Graph's dateTimeTimeZone: the wall clock in its own zone. */
function wallFor(time, ctx) {
    const zone = zoneFor(time.tz, ctx.zone);
    return { dateTime: normalLocal(time.local) ?? String(time.local), timeZone: zoneName(zone) };
}

/** A start and end as Graph takes them: all day from midnight to midnight, or wall clocks in their zones. */
function timesFor(start, end, ctx) {
    if ('date' in start) {
        const zone = zoneName(ctx.zone);
        const last = end !== undefined && end !== null && 'date' in end && end.date > start.date ? end.date : addDays(start.date, 1);
        return {
            isAllDay: true,
            start: { dateTime: `${start.date}T00:00:00`, timeZone: zone },
            end: { dateTime: `${last}T00:00:00`, timeZone: zone },
        };
    }
    const to = end !== undefined && end !== null && 'local' in end ? end : start;
    return { isAllDay: false, start: wallFor(start, ctx), end: wallFor(to, ctx) };
}

/** An end that keeps an event's length when only its start moves. */
function keepLength(oldStart, oldEnd, newStart, zone) {
    if ('date' in newStart) {
        const days = oldStart && oldEnd && 'date' in oldStart && 'date' in oldEnd ? Math.max(1, daysBetween(oldStart.date, oldEnd.date)) : 1;
        return { date: addDays(newStart.date, days) };
    }
    let length = 3_600_000;
    if (oldStart && oldEnd && 'local' in oldStart && 'local' in oldEnd) {
        length = Math.max(0, instantOfTime(oldEnd, zone) - instantOfTime(oldStart, zone));
    }
    return { local: wallOf(wallMs(newStart.local) + length), tz: newStart.tz };
}

/** Graph's start and end for a patch that moves an event (nothing when it doesn't move it). */
function movedTimes(record, patch, ctx) {
    if (!('start' in patch) && !('end' in patch)) return {};
    const start = patch.start ?? record?.start;
    if (start === undefined || start === null) throw new SourceError('config', 'An event needs a start before it can be saved.');
    const end = patch.end ?? (record?.start && record?.end ? keepLength(record.start, record.end, start, ctx.zone) : undefined);
    return timesFor(start, end, ctx);
}

/** The series' new start and end when one occurrence (`record`) moves as `patch` says: the whole series moves as far. */
function shiftSeries(series, record, patch, ctx) {
    const newStart = patch.start ?? record.start;
    const newEnd = patch.end ?? keepLength(record.start, record.end, newStart, ctx.zone);
    const zone = 'date' in newStart ? ctx.zone : zoneFor(newStart.tz, ctx.zone);
    // Wall clocks in one zone, read as if UTC, to move by.
    const wall = (time) => wallMs('date' in time ? `${time.date}T00:00:00` : toLocal(instantOfTime(time, ctx.zone), zone));
    const startWall = wall(series.start) + (wall(newStart) - wall(record.start));
    const length = Math.max(0, wall(newEnd) - wall(newStart));
    if ('date' in newStart) {
        const date = wallOf(startWall).slice(0, 10);
        return { start: { date }, end: { date: addDays(date, Math.max(1, Math.round(length / DAY))) } };
    }
    const tz = newStart.tz ?? null;
    return { start: { local: wallOf(startWall), tz }, end: { local: wallOf(startWall + length), tz } };
}

const SENSITIVITY = { private: 'private', confidential: 'confidential', public: 'normal' };

/** The Graph fields for what a record (or a patch of one) holds, apart from its times and repeat rule. */
function fieldsFor(patch, ctx) {
    const out = {};
    if ('title' in patch) out.subject = typeof patch.title === 'string' ? patch.title : '';
    if ('description' in patch) out.body = { contentType: 'text', content: typeof patch.description === 'string' ? patch.description : '' };
    if ('location' in patch) out.location = { displayName: typeof patch.location === 'string' ? patch.location : '' };
    if ('busy' in patch) out.showAs = patch.busy === false ? 'free' : 'busy';
    if ('privacy' in patch) out.sensitivity = SENSITIVITY[patch.privacy] ?? 'normal';
    if ('alarms' in patch) {
        // Outlook keeps one reminder: the first.
        const minutes = (Array.isArray(patch.alarms) ? patch.alarms : []).map(Number).filter(Number.isFinite);
        out.isReminderOn = minutes.length > 0;
        if (minutes.length > 0) out.reminderMinutesBeforeStart = Math.max(0, Math.round(minutes[0]));
    }
    if ('attendees' in patch) out.attendees = attendeesFor(patch.attendees, ctx);
    if ('categories' in patch) out.categories = Array.isArray(patch.categories) ? patch.categories.filter((c) => typeof c === 'string' && c !== '') : [];
    return out;
}

/** Whether a patch puts people on an event who weren't on it (the account itself aside). */
function addsGuests(record, patch, ctx) {
    if (patch === null || typeof patch !== 'object' || !('attendees' in patch)) return false;
    const had = new Set((Array.isArray(record?.attendees) ? record.attendees : []).map((p) => String(p?.email ?? '').trim().toLowerCase()));
    return attendeesFor(patch.attendees, ctx).some((a) => !had.has(a.emailAddress.address.toLowerCase()));
}

/** People as Graph's attendees; the account itself is the organizer, not an attendee. */
function attendeesFor(list, ctx) {
    const out = [];
    for (const person of Array.isArray(list) ? list : []) {
        const email = typeof person?.email === 'string' ? person.email.trim() : '';
        if (email === '' || person.self === true || (ctx.email !== '' && email.toLowerCase() === ctx.email)) continue;
        const type = person.role === 'optional' ? 'optional' : person.role === 'non-participant' ? 'resource' : 'required';
        const entry = { emailAddress: { address: email }, type };
        if (typeof person.name === 'string' && person.name !== '') entry.emailAddress.name = person.name;
        out.push(entry);
    }
    return out;
}

// ── Repeat rules ───────────────────────────────────────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEK_INDEX = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };
const INDEX_NAMES = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
const PATTERN_TYPES = ['daily', 'weekly', 'absoluteMonthly', 'relativeMonthly', 'absoluteYearly', 'relativeYearly'];

const cant = (how) => new SourceError('config', `Microsoft calendars can't repeat an event ${how}.`);
/** Week order from Monday, as people write days. */
const weekOrder = (a, b) => ((a + 6) % 7) - ((b + 6) % 7);

/** Graph's daysOfWeek as day numbers (0 Sunday), each once, from Monday. */
function dayNumbers(names) {
    const out = [];
    for (const name of Array.isArray(names) ? names : []) {
        const i = DAY_NAMES.indexOf(String(name).toLowerCase());
        if (i < 0) throw cant('on a day that isn\'t a day of the week');
        if (!out.includes(i)) out.push(i);
    }
    return out.sort(weekOrder);
}

/** UNTIL for a range's last day: a date for an all-day series, else that day's last second in the series' zone, in UTC. */
function untilOf(endDate, start, rangeZone) {
    const day = endDate.replace(/-/g, '');
    if (start === undefined || start === null || 'date' in start) return day;
    if (start.tz === null || start.tz === undefined) return `${day}T235959`;
    const zone = graphZone(rangeZone, zoneFor(start.tz, 'UTC'));
    return new Date(toInstant(`${endDate}T23:59:59`, zone, zone)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * A Graph patternedRecurrence as an RRULE value, in the usual order (FREQ,
 * INTERVAL, COUNT or UNTIL, BYMONTH, BYMONTHDAY, BYDAY, BYSETPOS, WKST).
 * A weekly pattern's firstDayOfWeek becomes WKST unless it is Monday (the
 * RFC's default); relativeMonthly and relativeYearly become an ordinal
 * BYDAY for one day ('2TH', '-1FR') and BYDAY with BYSETPOS for several.
 * @param {{pattern: object, range?: object}} recurrence
 * @param {import('../model.js').Time} start - the series' first start. An
 *   endDate range becomes UNTIL as a date for an all-day series, else the
 *   end date's last second in the series' zone, in UTC.
 * @returns {string} e.g. 'FREQ=WEEKLY;BYDAY=MO,WE;WKST=SU'.
 * @throws {SourceError} 'config' for a pattern a rule can't say.
 */
export function rruleFromPattern(recurrence, start) {
    const pattern = recurrence?.pattern ?? {};
    const range = recurrence?.range ?? {};
    const type = String(pattern.type ?? '').toLowerCase();
    const by = [];
    const relative = () => {
        const days = dayNumbers(pattern.daysOfWeek);
        if (days.length === 0) throw cant('on an unnamed day of the week');
        const n = WEEK_INDEX[String(pattern.index ?? 'first').toLowerCase()];
        if (n === undefined) throw cant(`on the "${pattern.index}" day of a month`);
        if (days.length === 1) by.push(`BYDAY=${n}${DAY_CODES[days[0]]}`);
        else by.push(`BYDAY=${days.map((d) => DAY_CODES[d]).join(',')}`, `BYSETPOS=${n}`);
    };
    const month = () => {
        const m = Number(pattern.month);
        if (!Number.isInteger(m) || m < 1 || m > 12) throw cant('in a month that doesn\'t exist');
        by.push(`BYMONTH=${m}`);
    };
    const monthDay = () => {
        const d = Number(pattern.dayOfMonth);
        if (!Number.isInteger(d) || d < 1 || d > 31) throw cant('on a day of the month that doesn\'t exist');
        by.push(`BYMONTHDAY=${d}`);
    };
    let freq;
    switch (type) {
        case 'daily':
            freq = 'DAILY';
            break;
        case 'weekly': {
            freq = 'WEEKLY';
            const days = dayNumbers(pattern.daysOfWeek);
            if (days.length > 0) by.push(`BYDAY=${days.map((d) => DAY_CODES[d]).join(',')}`);
            // Graph's weeks start on Sunday unless it says otherwise; the RFC's on Monday.
            const first = DAY_NAMES.indexOf(String(pattern.firstDayOfWeek ?? 'sunday').toLowerCase());
            if (first >= 0 && first !== 1) by.push(`WKST=${DAY_CODES[first]}`);
            break;
        }
        case 'absolutemonthly':
            freq = 'MONTHLY';
            monthDay();
            break;
        case 'relativemonthly':
            freq = 'MONTHLY';
            relative();
            break;
        case 'absoluteyearly':
            freq = 'YEARLY';
            month();
            monthDay();
            break;
        case 'relativeyearly':
            freq = 'YEARLY';
            month();
            relative();
            break;
        default:
            throw cant(`by a "${pattern.type}" pattern`);
    }
    const parts = [`FREQ=${freq}`];
    const interval = Number(pattern.interval);
    if (Number.isInteger(interval) && interval > 1) parts.push(`INTERVAL=${interval}`);
    const until = String(range.type ?? 'noEnd').toLowerCase();
    if (until === 'numbered') {
        const count = Number(range.numberOfOccurrences);
        if (!Number.isInteger(count) || count < 1) throw cant('a number of times that isn\'t a whole number above zero');
        parts.push(`COUNT=${count}`);
    } else if (until === 'enddate') {
        const endDate = String(range.endDate ?? '').slice(0, 10);
        if (!isDay(endDate)) throw cant('until a day that doesn\'t exist');
        parts.push(`UNTIL=${untilOf(endDate, start, range.recurrenceTimeZone)}`);
    }
    return [...parts, ...by].join(';');
}

/** An RRULE value's parts by name; what Graph can't do is turned down here. */
function ruleParts(rrule) {
    const raw = String(rrule ?? '').trim().replace(/^RRULE:/i, '');
    if (raw === '') throw new SourceError('config', 'The repeat rule is empty.');
    const parts = {};
    for (const piece of raw.split(';')) {
        if (piece.trim() === '') continue;
        const eq = piece.indexOf('=');
        if (eq < 1) throw new SourceError('config', `The repeat rule has "${piece}", which isn't a part of a rule.`);
        const key = piece.slice(0, eq).trim().toUpperCase();
        const value = piece.slice(eq + 1).trim().toUpperCase();
        if (key.startsWith('X-')) continue;
        switch (key) {
            case 'FREQ': case 'INTERVAL': case 'COUNT': case 'UNTIL': case 'BYDAY': case 'BYMONTHDAY': case 'BYMONTH': case 'BYSETPOS': case 'WKST':
                parts[key] = value;
                break;
            case 'BYHOUR': case 'BYMINUTE': case 'BYSECOND':
                throw cant('at several times of a day');
            case 'BYWEEKNO':
                throw cant('by week number');
            case 'BYYEARDAY':
                throw cant('by day of the year');
            case 'RSCALE': case 'SKIP':
                throw cant('by a calendar other than the Gregorian one');
            default:
                throw new SourceError('config', `The repeat rule has a part (${key}) that isn't in the standard.`);
        }
    }
    if (parts.FREQ === undefined) throw new SourceError('config', 'The repeat rule doesn\'t say how often (FREQ).');
    return parts;
}

/** A whole number above zero from a rule. */
function positive(value, name) {
    if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw new SourceError('config', `The repeat rule's ${name}=${value} isn't a whole number above zero.`);
    return Number(value);
}

/** A rule's list of whole numbers. */
function numbers(value, name) {
    const out = [];
    for (const piece of value.split(',')) {
        if (!/^[+-]?\d{1,3}$/.test(piece.trim())) throw new SourceError('config', `The repeat rule's ${name} has "${piece}", which isn't a whole number.`);
        const n = Number(piece.trim());
        if (!out.includes(n)) out.push(n);
    }
    return out;
}

/** BYDAY's entries as {n (0 for every such day), day (0 Sunday)}. */
function weekdays(value) {
    const out = [];
    for (const piece of value.split(',')) {
        const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(piece.trim());
        if (m === null) throw new SourceError('config', `The repeat rule's BYDAY has "${piece}", which isn't a day of the week.`);
        const entry = { n: m[1] === undefined ? 0 : Number(m[1]), day: DAY_CODES.indexOf(m[2]) };
        if (!out.some((e) => e.n === entry.n && e.day === entry.day)) out.push(entry);
    }
    return out;
}

/** Graph's day names for BYDAY entries, from Monday. */
const dayNamesOf = (entries) => [...new Set(entries.map((e) => e.day))].sort(weekOrder).map((d) => DAY_NAMES[d]);

/** Graph's week index for a BYDAY ordinal or a BYSETPOS. */
function indexOf(n) {
    const name = INDEX_NAMES[n];
    if (name === undefined) throw cant('on any such day of a month but the first, second, third, fourth or last');
    return name;
}

/** Which day of a month a monthly or yearly rule means: {dayOfMonth} or {daysOfWeek, index}. */
function dayInMonth(byDay, byMonthDay, bySetPos, startDay) {
    if (byMonthDay !== undefined && byDay !== undefined) throw cant('on both days of the month and days of the week');
    if (byMonthDay !== undefined) {
        if (bySetPos !== undefined) throw cant('by position among days of the month');
        if (byMonthDay.length !== 1) throw cant('on several days of the month');
        const day = byMonthDay[0];
        // The last day of the month is the last of any day of the week.
        if (day === -1) return { daysOfWeek: [...DAY_NAMES.slice(1), DAY_NAMES[0]], index: 'last' };
        if (day < 1 || day > 31) throw cant('on a day counted from the end of the month');
        return { dayOfMonth: day };
    }
    if (byDay !== undefined) {
        if (byDay.some((e) => e.n !== 0)) {
            if (byDay.length !== 1 || bySetPos !== undefined) throw cant('on several numbered days of the week in a month');
            return { daysOfWeek: [DAY_NAMES[byDay[0].day]], index: indexOf(byDay[0].n) };
        }
        if (bySetPos === undefined) throw cant('on every such day of the week in a month');
        if (bySetPos.length !== 1) throw cant('on several positions in a month');
        return { daysOfWeek: dayNamesOf(byDay), index: indexOf(bySetPos[0]) };
    }
    if (bySetPos !== undefined) throw cant('by position without days of the week');
    return { dayOfMonth: startDay };
}

/**
 * An RRULE value as a Graph patternedRecurrence: daily, weekly (BYDAY,
 * WKST as firstDayOfWeek; Monday when it is left out, as the RFC reads
 * it), absoluteMonthly and absoluteYearly (BYMONTHDAY, BYMONTH),
 * relativeMonthly and relativeYearly (an ordinal BYDAY, or BYDAY with
 * BYSETPOS; BYMONTHDAY=-1 as the last day). COUNT is a numbered range,
 * UNTIL an endDate (its day in the series' zone), neither noEnd; the
 * range starts on the start's day. Parts the rule leaves out (the weekday,
 * day or month) come from the start.
 * @param {string} rrule - 'FREQ=MONTHLY;BYDAY=2TH' (an 'RRULE:' prefix is fine).
 * @param {import('../model.js').Time} start - the series' first start.
 * @returns {{pattern: object, range: object}}
 * @throws {SourceError} 'config' with a plain sentence when Graph can't repeat an event that way.
 */
export function patternFromRrule(rrule, start) {
    const parts = ruleParts(rrule);
    if (start === undefined || start === null || (!('date' in start) && typeof start.local !== 'string')) {
        throw new SourceError('config', 'A repeating event needs a start.');
    }
    const startDate = dateOf(start);
    if (!isDay(startDate)) throw new SourceError('config', 'A repeating event needs a start on a day that exists.');
    const [year, monthOfStart, dayOfStart] = startDate.split('-').map(Number);
    const weekdayOfStart = new Date(Date.UTC(year, monthOfStart - 1, dayOfStart)).getUTCDay();
    const interval = parts.INTERVAL === undefined ? 1 : positive(parts.INTERVAL, 'INTERVAL');
    const byDay = parts.BYDAY === undefined ? undefined : weekdays(parts.BYDAY);
    const byMonthDay = parts.BYMONTHDAY === undefined ? undefined : numbers(parts.BYMONTHDAY, 'BYMONTHDAY');
    const byMonth = parts.BYMONTH === undefined ? undefined : numbers(parts.BYMONTH, 'BYMONTH');
    const bySetPos = parts.BYSETPOS === undefined ? undefined : numbers(parts.BYSETPOS, 'BYSETPOS');
    let firstDayOfWeek = 'monday';
    if (parts.WKST !== undefined) {
        const i = DAY_CODES.indexOf(parts.WKST);
        if (i < 0) throw new SourceError('config', `The repeat rule's WKST=${parts.WKST} isn't a day of the week.`);
        firstDayOfWeek = DAY_NAMES[i];
    }
    let pattern;
    switch (parts.FREQ) {
        case 'DAILY':
            if (byMonth !== undefined || byMonthDay !== undefined || bySetPos !== undefined) throw cant('daily on chosen days of a month or year');
            if (byDay === undefined) {
                pattern = { type: 'daily', interval };
                break;
            }
            // Every weekday and the like: Outlook says that as weekly on those days.
            if (interval !== 1 || byDay.some((e) => e.n !== 0)) throw cant('every few days on chosen days of the week');
            pattern = { type: 'weekly', interval: 1, daysOfWeek: dayNamesOf(byDay), firstDayOfWeek };
            break;
        case 'WEEKLY':
            if (byMonth !== undefined || byMonthDay !== undefined || bySetPos !== undefined) throw cant('weekly on chosen days of a month or year');
            if (byDay?.some((e) => e.n !== 0)) throw cant('weekly on numbered days of the week');
            pattern = { type: 'weekly', interval, daysOfWeek: byDay === undefined ? [DAY_NAMES[weekdayOfStart]] : dayNamesOf(byDay), firstDayOfWeek };
            break;
        case 'MONTHLY': {
            if (byMonth !== undefined) throw cant('monthly in some months only');
            const day = dayInMonth(byDay, byMonthDay, bySetPos, dayOfStart);
            pattern = 'index' in day ? { type: 'relativeMonthly', interval, ...day } : { type: 'absoluteMonthly', interval, ...day };
            break;
        }
        case 'YEARLY': {
            if (byMonth !== undefined && byMonth.length !== 1) throw cant('in several months of the year');
            if (byMonth !== undefined && (byMonth[0] < 1 || byMonth[0] > 12)) throw cant('in a month that doesn\'t exist');
            if (byMonth === undefined && (byDay !== undefined || bySetPos !== undefined)) throw cant('on a numbered day of the week in the year');
            const month = byMonth === undefined ? monthOfStart : byMonth[0];
            const day = dayInMonth(byDay, byMonthDay, bySetPos, dayOfStart);
            pattern = 'index' in day ? { type: 'relativeYearly', interval, ...day, month } : { type: 'absoluteYearly', interval, ...day, month };
            break;
        }
        case 'HOURLY': case 'MINUTELY': case 'SECONDLY':
            throw cant('more often than once a day');
        default:
            throw new SourceError('config', `The repeat rule's FREQ=${parts.FREQ} isn't one the standard has.`);
    }
    if (parts.COUNT !== undefined && parts.UNTIL !== undefined) throw cant('both a number of times and until a day');
    let range = { type: 'noEnd', startDate };
    if (parts.COUNT !== undefined) range = { type: 'numbered', startDate, numberOfOccurrences: positive(parts.COUNT, 'COUNT') };
    if (parts.UNTIL !== undefined) range = { type: 'endDate', startDate, endDate: untilDay(parts.UNTIL, start) };
    return { pattern, range };
}

/** UNTIL's day: as written for a date or a wall clock, else (UTC) the day in the series' zone. */
function untilDay(value, start) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
    const day = m === null ? '' : `${m[1]}-${m[2]}-${m[3]}`;
    if (!isDay(day)) throw new SourceError('config', `The repeat rule's UNTIL=${value} isn't a date.`);
    if (m[7] === undefined) return day;
    const zone = 'date' in start ? 'UTC' : zoneFor(start.tz, 'UTC');
    return toLocal(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])), zone).slice(0, 10);
}

/** A pattern with only what its type needs: Graph turns down values a type doesn't take (it sends month 0 and the like). */
function tidyPattern(pattern) {
    const type = PATTERN_TYPES.find((t) => t.toLowerCase() === String(pattern?.type ?? '').toLowerCase()) ?? pattern?.type;
    const out = { type, interval: Number.isInteger(pattern?.interval) && pattern.interval > 0 ? pattern.interval : 1 };
    const days = () => dayNumbers(pattern.daysOfWeek).map((d) => DAY_NAMES[d]);
    if (type === 'weekly') Object.assign(out, { daysOfWeek: days(), firstDayOfWeek: String(pattern.firstDayOfWeek ?? 'sunday').toLowerCase() });
    if (type === 'absoluteMonthly' || type === 'absoluteYearly') out.dayOfMonth = pattern.dayOfMonth;
    if (type === 'relativeMonthly' || type === 'relativeYearly') Object.assign(out, { daysOfWeek: days(), index: String(pattern.index ?? 'first').toLowerCase() });
    if (type === 'absoluteYearly' || type === 'relativeYearly') out.month = pattern.month;
    return out;
}

/** A series' pattern after its start moved `shift` days: its days of the week and of the month move along. */
function shiftRecurrence(recurrence, shift, startDate) {
    const pattern = tidyPattern(recurrence.pattern);
    if (Array.isArray(pattern.daysOfWeek)) {
        const moved = pattern.daysOfWeek.map((d) => ((DAY_NAMES.indexOf(d) + shift) % 7 + 7) % 7);
        pattern.daysOfWeek = [...new Set(moved)].sort(weekOrder).map((d) => DAY_NAMES[d]);
    }
    if ('dayOfMonth' in pattern) pattern.dayOfMonth = Number(startDate.slice(8, 10));
    if ('month' in pattern) pattern.month = Number(startDate.slice(5, 7));
    const old = recurrence.range ?? {};
    const type = String(old.type ?? 'noEnd');
    const range = { type, startDate };
    if (type.toLowerCase() === 'enddate') range.endDate = old.endDate;
    if (type.toLowerCase() === 'numbered') range.numberOfOccurrences = old.numberOfOccurrences;
    if (typeof old.recurrenceTimeZone === 'string' && old.recurrenceTimeZone !== '') range.recurrenceTimeZone = old.recurrenceTimeZone;
    return { pattern, range };
}
