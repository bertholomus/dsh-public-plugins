/**
 * Subscribed calendars: an iCalendar file on the web (holidays, a team's
 * published calendar, sports fixtures, a booking site's feed), read only.
 * webcal:// addresses are read over https. The file is fetched again only
 * when the server says it changed (ETag, Last-Modified).
 *
 * The address is a secret: a private feed (Google's secret address, iCloud's
 * and Outlook's published links) carries its key in the path, and anyone
 * with the address can read the calendar. So it is kept like a password, in
 * the account's record in DSH's credential store ({url}); the plugin's
 * files keep its host, and messages name the host only.
 *
 * @module dsh-plugin-calendar/sources/subscription
 */
import { readIcs } from '../ical.js';
import { HttpError, safeHost } from '../http.js';
import { SourceError, statusError } from './index.js';

export const kind = 'ics';
export const style = 'ics';

/** The remote id of a feed's one calendar (never its address). */
export const FEED = 'feed';

/** The address to fetch: webcal:// and webcals:// are https. */
export function feedUrl(url) {
    const text = String(url ?? '').trim();
    if (/^webcals?:\/\//i.test(text)) return `https://${text.replace(/^webcals?:\/\//i, '')}`;
    return text;
}

export function create(account, env) {
    let saved;
    /** The address, read from the account's secret the first time it's needed. */
    const address = async () => {
        if (saved === undefined) {
            const stored = await env.secret?.get?.();
            const url = feedUrl(stored?.url);
            if (url === '') throw new SourceError('config', 'This subscription has no address saved. Remove it and subscribe again.');
            saved = url;
        }
        return saved;
    };
    return {
        async calendars() {
            return [{ remoteId: FEED, name: account.name || 'Subscribed calendar', readOnly: true }];
        },
        async sync(_calendar, state, opts = {}) {
            const url = await address();
            const what = `Reading the calendar at ${safeHost(url)}`;
            const headers = { accept: 'text/calendar, */*;q=0.5' };
            if (state?.etag) headers['if-none-match'] = state.etag;
            if (state?.modified) headers['if-modified-since'] = state.modified;
            let response;
            try {
                response = await env.request(url, { headers, signal: opts.signal });
            } catch (error) {
                if (error instanceof HttpError) throw new SourceError('network', error.message);
                throw error;
            }
            if (response.status === 304) return { reset: false, items: [], removed: [], state };
            if (!response.ok) throw statusError(response.status, what, response.headers);
            if (!/BEGIN:VCALENDAR/i.test(response.text.slice(0, 4096))) {
                throw new SourceError('config', `${what}: it isn't a calendar file (it has no BEGIN:VCALENDAR).`);
            }
            const { events, calendar } = readIcs(response.text, { zone: env.zone });
            const byUid = new Map();
            for (const record of events) {
                const list = byUid.get(record.uid);
                if (list === undefined) byUid.set(record.uid, [record]);
                else list.push(record);
            }
            const items = [...byUid].map(([uid, list]) => ({ remoteId: uid, events: list }));
            env.log?.(`subscription read events=${events.length}`);
            return {
                reset: true,
                items,
                removed: [],
                state: { etag: response.headers.get('etag') ?? undefined, modified: response.headers.get('last-modified') ?? undefined },
                calendar,
            };
        },
    };
}
