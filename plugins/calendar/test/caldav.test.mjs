// The CalDAV source (lib/sources/caldav.js): its XML reader and hrefs on
// answers shaped like iCloud's, Fastmail's (Cyrus) and Nextcloud's (Sabre);
// the source against a stand-in server; and the source, and the manager's
// changes through it, against a real Radicale server. The Radicale tests
// run when one is installed: a
// virtualenv in RADICALE_VENV, a python in RADICALE_PYTHON, or a python3 on
// the PATH that has radicale. Otherwise they are skipped.
//
//   RADICALE_VENV=/path/to/venv node --test plugins/calendar/test/caldav.test.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { occurrences } from '../lib/expand.js';
import { request } from '../lib/http.js';
import { readIcs } from '../lib/ical.js';
import { CalendarManager, calendarIdOf } from '../lib/manager.js';
import { SourceError } from '../lib/sources/index.js';
import * as caldav from '../lib/sources/caldav.js';
import { hrefUrl, parseMultistatus, parseXml } from '../lib/sources/caldav.js';
import { toLocal } from '../lib/zones.js';

const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const fixture = (name) => readFileSync(new URL(`./fixtures/caldav/${name}`, import.meta.url), 'utf8');
const isCode = (code) => (error) => error instanceof SourceError && error.code === code;

/** An event as a client writes it. */
const ics = (uid, summary, body = 'VEVENT') => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DSH calendar tests//EN', `BEGIN:${body}`, `UID:${uid}`, 'DTSTAMP:20261011T000000Z',
    ...(body === 'VEVENT' ? ['DTSTART:20261012T090000Z', 'DTEND:20261012T100000Z'] : ['DUE:20261012T090000Z']),
    `SUMMARY:${summary}`, `END:${body}`, 'END:VCALENDAR', '',
].join('\r\n');

// ---------------------------------------------------------------------------
// The XML reader

describe('parseXml', () => {
    test('resolves prefixes, default namespaces and declarations on inner elements', () => {
        const doc = parseXml(`<?xml version='1.0' encoding='UTF-8'?>
<multistatus xmlns='DAV:'><a xmlns='urn:x'><b xmlns:D='DAV:'><D:href>h</D:href><c/></b></a><n:odd xmlns:n="http://apple.com/ns/ical/">v</n:odd><e/></multistatus>`);
        const top = doc.children[0];
        assert.deepEqual([top.ns, top.name], [DAV, 'multistatus']);
        const a = top.children[0];
        const b = a.children[0];
        assert.deepEqual([a.ns, b.ns], ['urn:x', 'urn:x']);
        assert.deepEqual([b.children[0].ns, b.children[0].name, b.children[0].text], [DAV, 'href', 'h']);
        assert.deepEqual([b.children[1].ns, b.children[1].name], ['urn:x', 'c']);
        assert.deepEqual([top.children[1].ns, top.children[1].name, top.children[1].text], ['http://apple.com/ns/ical/', 'odd', 'v']);
        assert.equal(top.children[2].ns, DAV, 'back in the outer default namespace');
    });

    test('gives undeclared D: and C: prefixes their usual namespaces, and others none', () => {
        const doc = parseXml('<D:multistatus><D:response><C:calendar-data>x</C:calendar-data><Q:what/></D:response></D:multistatus>');
        const response = doc.children[0].children[0];
        assert.equal(doc.children[0].ns, DAV);
        assert.equal(response.children[0].ns, CALDAV);
        assert.equal(response.children[1].ns, null);
    });

    test('decodes entities and character references, and keeps CDATA as it is', () => {
        const doc = parseXml('<x>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#13;&#10;&#x41;&#X42;&#128512; &#0; &nbsp; <![CDATA[<raw> &amp; ]] stays]]></x>');
        assert.equal(doc.children[0].text, 'a & b <c> "d" \'e\' \r\nAB\u{1F600} \uFFFD &nbsp; <raw> &amp; ]] stays');
    });

    test('reads line ends as \\n, as XML does, but keeps an escaped carriage return', () => {
        const doc = parseXml('<x>one\r\ntwo\rthree&#13;\nfour</x>');
        assert.equal(doc.children[0].text, 'one\ntwo\nthree\r\nfour');
    });

    test('skips comments, processing instructions and a DTD, and expands none of its entities', () => {
        const doc = parseXml('<?xml version="1.0"?><!-- a <comment> --><!DOCTYPE x [<!ENTITY boom "BOOM"><!ELEMENT x ANY>]><?pi stuff?><x>&boom;<!-- inner --></x>');
        assert.equal(doc.children.length, 1);
        assert.equal(doc.children[0].text, '&boom;');
    });

    test('reads attributes in either quote, with > inside, and forgives stray and missing end tags', () => {
        const doc = parseXml('<a><b title="x > y" name=\'VEVENT\' xmlns:p="urn:p"><p:c/></b></z><d>text</a><e/>');
        const a = doc.children[0];
        const b = a.children[0];
        assert.equal(b.attrs.title, 'x > y');
        assert.equal(b.attrs.name, 'VEVENT');
        assert.equal(b.children[0].ns, 'urn:p');
        // </z> closes nothing; </a> closes the unclosed <d> as well; <e/> is a sibling of <a>.
        assert.equal(a.children[1].text, 'text');
        assert.deepEqual(doc.children.map((c) => c.name), ['a', 'e']);
    });

    test('a truncated document gives what came before', () => {
        const doc = parseXml('<a><b>one</b><c attr="never closed');
        assert.equal(doc.children[0].children[0].text, 'one');
    });
});

// ---------------------------------------------------------------------------
// Hrefs

describe('hrefUrl', () => {
    test('resolves hrefs against the address they came from', () => {
        assert.equal(hrefUrl('/1234/calendars/home/', 'https://caldav.icloud.com/1234/principal/'), 'https://caldav.icloud.com/1234/calendars/home/');
        assert.equal(hrefUrl('a.ics', 'https://h.example/cal/'), 'https://h.example/cal/a.ics');
        assert.equal(hrefUrl('../other/', 'https://h.example/cal/x/'), 'https://h.example/cal/other/');
        assert.equal(hrefUrl('  https://p52-caldav.icloud.com:443/1/calendars/  ', 'https://caldav.icloud.com/'), 'https://p52-caldav.icloud.com/1/calendars/');
    });

    test('spells one resource one way however a server encodes it', () => {
        const base = 'https://caldav.fastmail.com/';
        const at = [
            '/dav/calendars/user/alice@fastmail.com/Default/',
            '/dav/calendars/user/alice%40fastmail.com/Default/',
            '/dav/calendars/user/alice%40fastmail%2ecom/Default/',
            'https://CalDAV.Fastmail.com:443/dav/calendars/user/alice@fastmail.com/Default/',
        ].map((href) => hrefUrl(href, base));
        assert.deepEqual(new Set(at), new Set(['https://caldav.fastmail.com/dav/calendars/user/alice@fastmail.com/Default/']));
        const cafe = ['/c/caf\u00e9 au lait.ics', '/c/caf%C3%A9%20au%20lait.ics', '/c/caf%c3%a9 au%20lait.ics'].map((href) => hrefUrl(href, base));
        assert.deepEqual(new Set(cafe), new Set(['https://caldav.fastmail.com/c/caf%C3%A9%20au%20lait.ics']));
        // An encoded slash is part of the name, not a path step.
        assert.equal(hrefUrl('/c/a%2fb.ics', base), 'https://caldav.fastmail.com/c/a%2Fb.ics');
        assert.notEqual(hrefUrl('/c/a%2Fb.ics', base), hrefUrl('/c/a/b.ics', base));
        // Not UTF-8: kept as it is, its escapes in capitals.
        assert.equal(hrefUrl('/c/caf%e9.ics', base), 'https://caldav.fastmail.com/c/caf%E9.ics');
    });

    test('drops user info and fragments, and refuses what is not http(s)', () => {
        assert.equal(hrefUrl('https://user:secret@h.example/cal/#frag'), 'https://h.example/cal/');
        assert.equal(hrefUrl('mailto:alice@example.com', 'https://h.example/'), undefined);
        assert.equal(hrefUrl('javascript:alert(1)', 'https://h.example/'), undefined);
        assert.equal(hrefUrl('/relative/without/base'), undefined);
        assert.equal(hrefUrl(''), undefined);
    });
});

// ---------------------------------------------------------------------------
// Multistatus answers as servers send them

describe('multistatus answers', () => {
    test('iCloud: the principal on caldav.icloud.com names a home on a pNN host', () => {
        const root = parseMultistatus(fixture('icloud-root.xml'), 'https://caldav.icloud.com/');
        assert.equal(root.responses.length, 1);
        const [self] = root.responses;
        assert.equal(self.url, 'https://caldav.icloud.com/');
        assert.deepEqual(self.failed, [404]);
        assert.equal(self.props.has(`{${CALDAV}}calendar-home-set`), false, 'a 404 propstat is ignored');
        assert.equal(hrefUrl(self.props.get('{DAV:}current-user-principal').children[0].text, root.base), 'https://caldav.icloud.com/1234567890/principal/');
        const principal = parseMultistatus(fixture('icloud-principal.xml'), 'https://caldav.icloud.com/1234567890/principal/');
        const home = principal.responses[0].props.get(`{${CALDAV}}calendar-home-set`).children[0];
        assert.deepEqual([home.ns, home.name], [DAV, 'href']);
        assert.equal(hrefUrl(home.text, principal.base), 'https://p52-caldav.icloud.com/1234567890/calendars/');
    });

    test('iCloud: calendar data in CDATA, a member gone meanwhile', () => {
        const answer = parseMultistatus(fixture('icloud-multiget.xml'), 'https://p52-caldav.icloud.com/1234567890/calendars/home/');
        const [event, gone] = answer.responses;
        assert.equal(event.url, 'https://p52-caldav.icloud.com/1234567890/calendars/home/0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0.ics');
        assert.equal(event.props.get('{DAV:}getetag').text, '"mhd6x2kp"');
        const data = event.props.get(`{${CALDAV}}calendar-data`).text;
        assert.match(data, /^BEGIN:VCALENDAR\nVERSION:2\.0\n/);
        assert.match(data, /\nSUMMARY:Standup <daily> & notes \]\] still text\nEND:VEVENT\n/);
        assert.equal(gone.url, 'https://p52-caldav.icloud.com/1234567890/calendars/home/gone-meanwhile.ics');
        assert.equal(gone.status, 404);
        assert.equal(gone.props.size, 0);
    });

    test('Fastmail (Cyrus): D:/C:/A: prefixes, &#13; line ends, %40 and @ alike', () => {
        const base = 'https://caldav.fastmail.com/dav/calendars/user/alice@fastmail.com/';
        const home = parseMultistatus(fixture('fastmail-home.xml'), base);
        assert.deepEqual(home.responses.map((r) => r.url), [
            base,
            `${base}Default/`,
            `${base}b1c2d3e4-5f60-4718-92a3-b4c5d6e7f809/`,
            `${base}Inbox/`,
            `${base}Outbox/`,
        ]);
        const shared = home.responses[2].props;
        assert.equal(shared.get('{DAV:}displayname').text, 'Bob\'s "team" calendar');
        assert.equal(shared.get(`{${CALDAV}}calendar-description`).text, 'Bob\u2019s plans \u2014 read only');
        const zone = home.responses[1].props.get(`{${CALDAV}}calendar-timezone`).text;
        assert.match(zone, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);

        const sync = parseMultistatus(fixture('fastmail-sync.xml'), `${base}Default/`);
        assert.equal(sync.syncToken, 'data:,30188-1700000000');
        assert.equal(sync.responses[0].url, `${base}Default/5f9a0c1e-1111-4a2b-9c3d-7e6f5a4b3c2d.ics`);
        assert.equal(sync.responses[1].status, 404);

        const got = parseMultistatus(fixture('fastmail-multiget.xml'), `${base}Default/`);
        assert.equal(got.responses[0].url, sync.responses[0].url, 'the same resource, written two ways');
        const data = got.responses[0].props.get(`{${CALDAV}}calendar-data`).text;
        assert.match(data, /\r\nSUMMARY:Lunch with Sam & Kim <3\r\nDESCRIPTION:Bring the "plans"\\, and a café map\r\n/);
    });

    test('Nextcloud (Sabre): x1: for Apple\'s namespace, a 507 on the collection, a deleted member', () => {
        const base = 'https://cloud.example.com/remote.php/dav/calendars/alice/';
        const home = parseMultistatus(fixture('nextcloud-home.xml'), base);
        const personal = home.responses[1].props;
        assert.equal(personal.get('{http://apple.com/ns/ical/}calendar-color').text, '#0082c9');
        assert.equal(home.responses[3].url, `${base}work%20stuff_shared_by_bob/`);

        const first = parseMultistatus(fixture('nextcloud-sync-1.xml'), `${base}personal/`);
        assert.equal(first.responses[0].url, `${base}personal/`);
        assert.equal(first.responses[0].status, 507);
        assert.equal(first.responses[1].props.get('{DAV:}getetag').text, '"5d41402abc4b2a76b9719d911017c592"');
        assert.equal(first.syncToken, 'http://sabre.io/ns/sync/40');
        const second = parseMultistatus(fixture('nextcloud-sync-2.xml'), `${base}personal/`);
        assert.deepEqual(second.responses.map((r) => r.status), [undefined, undefined, 404]);

        const got = parseMultistatus(fixture('nextcloud-multiget.xml'), `${base}personal/`);
        assert.match(got.responses[0].props.get(`{${CALDAV}}calendar-data`).text, /\r\nLOCATION:Room "Elbe" & online\r\nEND:VEVENT\r\nEND:VCALENDAR$/);
        assert.equal(got.responses[1].props.size, 0, 'only 404 propstats');
        assert.deepEqual(got.responses[1].failed, [404]);
    });

    test('what is not a multistatus gives undefined', () => {
        assert.equal(parseMultistatus('<html><body>Sign in</body></html>', 'https://h.example/'), undefined);
        assert.equal(parseMultistatus('', 'https://h.example/'), undefined);
    });
});

// ---------------------------------------------------------------------------
// The source against a stand-in server

/**
 * A fetch that answers from `routes` ("METHOD url" → answer, or a function
 * of the call that returns one), and records every call.
 */
function fakeServer(routes) {
    const calls = [];
    async function fetch(url, init = {}) {
        const call = { url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body ?? null };
        calls.push(call);
        const route = routes[`${call.method} ${call.url}`];
        const answer = typeof route === 'function' ? await route(call) : route;
        if (answer instanceof Error) throw answer;
        if (answer === undefined) return new Response('Not here', { status: 404 });
        const { status = 207, body = null, headers = {} } = answer;
        const type = body !== null && status === 207 ? { 'content-type': 'application/xml; charset=utf-8' } : {};
        return new Response(body, { status, headers: { ...type, ...headers } });
    }
    return { fetch, calls };
}

/**
 * An env for the stand-in server. Names resolve to an address on the
 * internet (TEST-NET-1) unless `names` says otherwise: no test asks DNS.
 */
const stubEnv = (fetch, { names = {}, ...extra } = {}) => ({
    request: (url, init) => request(url, { ...init, fetch, lookup: async (host) => names[host] ?? ['192.0.2.10'] }),
    secret: { get: async () => ({ password: 'app-password' }) },
    log: () => {},
    now: () => Date.UTC(2026, 9, 11),
    zone: 'UTC',
    settings: {},
    ...extra,
});

const header = (call, name) => Object.entries(call.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const BASIC = `Basic ${Buffer.from('alice:app-password').toString('base64')}`;

/** A multistatus of {href, etag?, status?, props?} for stand-in answers. */
function multistatus(entries, token) {
    const body = entries.map(({ href, etag, status, props = '' }) => {
        if (status !== undefined) return `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 ${status}</d:status></d:response>`;
        const tag = etag === undefined ? '' : `<d:getetag>${etag.replace(/"/g, '&quot;')}</d:getetag>`;
        return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${tag}${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    }).join('');
    const sync = token === undefined ? '' : `<d:sync-token>${token}</d:sync-token>`;
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:cs="http://calendarserver.org/ns/">${body}${sync}</d:multistatus>`;
}

/** A calendar-multiget answer for the hrefs a request body names, from `files` (href → {etag, text}). */
function multigetAnswer(body, files) {
    const hrefs = [...body.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => m[1]);
    return multistatus(hrefs.map((href) => {
        const file = files[href];
        if (file === undefined) return { href, status: '404 Not Found' };
        return { href, etag: file.etag, props: `<c:calendar-data>${file.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\r/g, '&#13;')}</c:calendar-data>` };
    }));
}

describe('the source, against a stand-in server', () => {
    test('iCloud: discovery follows the move to a pNN host with the password, and lists event calendars by order, the default primary', async () => {
        const { fetch, calls } = fakeServer({
            'PROPFIND https://caldav.icloud.com/': { body: fixture('icloud-root.xml') },
            'PROPFIND https://caldav.icloud.com/1234567890/principal/': { status: 301, headers: { location: 'https://p52-caldav.icloud.com/1234567890/principal/' } },
            // The principal answers what is asked: its calendar home, or whether the server schedules, the user's addresses and the inbox.
            'PROPFIND https://p52-caldav.icloud.com/1234567890/principal/': (call) => ({ body: fixture(/schedule-outbox-URL/.test(call.body) ? 'icloud-scheduling.xml' : 'icloud-principal.xml') }),
            // The default calendar is the scheduling Inbox's (RFC 6638 9.2).
            'PROPFIND https://p52-caldav.icloud.com/1234567890/calendars/inbox/': { body: fixture('icloud-inbox.xml') },
            'PROPFIND https://p52-caldav.icloud.com/1234567890/calendars/': { body: fixture('icloud-home.xml') },
        });
        const account = { id: 'icloud-1', kind: 'caldav', name: 'iCloud', preset: 'icloud', username: 'alice' };
        const found = await caldav.discover(account, stubEnv(fetch));
        assert.equal(found.principal, 'https://caldav.icloud.com/1234567890/principal/');
        assert.equal(found.home, 'https://p52-caldav.icloud.com/1234567890/calendars/');
        // iCloud schedules: it emails a meeting's guests itself. The user's addresses are every one it names (N1):
        // the mailto: ones as emails, its principal's URL in full, and its urn:uuid, as iCloud's own meetings name their organizer.
        const about = { scheduling: true, addresses: ['alice@icloud.com', 'alice@me.com', 'https://p52-caldav.icloud.com/1234567890/principal/', 'urn:uuid:1234567890'] };
        assert.deepEqual(found.calendars, [
            {
                remoteId: 'https://p52-caldav.icloud.com/1234567890/calendars/2A7C6E1F-3B5D-4C8A-9E0F-1D2C3B4A5968/',
                name: 'Team & Ops', color: '#1BADF8', readOnly: true, description: 'Shared by the team', ...about,
            },
            {
                remoteId: 'https://p52-caldav.icloud.com/1234567890/calendars/home/',
                name: 'Home', color: '#FF2968', readOnly: false, timeZone: 'America/Los_Angeles', primary: true, ...about,
            },
        ]);
        assert.deepEqual(calls.map((c) => [c.method, c.url, header(c, 'depth')]), [
            ['PROPFIND', 'https://caldav.icloud.com/', '0'],
            ['PROPFIND', 'https://caldav.icloud.com/1234567890/principal/', '0'],
            ['PROPFIND', 'https://p52-caldav.icloud.com/1234567890/principal/', '0'],
            ['PROPFIND', 'https://caldav.icloud.com/1234567890/principal/', '0'],
            ['PROPFIND', 'https://p52-caldav.icloud.com/1234567890/principal/', '0'],
            ['PROPFIND', 'https://p52-caldav.icloud.com/1234567890/calendars/inbox/', '0'],
            ['PROPFIND', 'https://p52-caldav.icloud.com/1234567890/calendars/', '1'],
        ]);
        assert.ok(calls.every((c) => header(c, 'authorization') === BASIC), 'the password stays with every icloud.com host');
        assert.ok(calls.every((c) => /<d:propfind [^>]*xmlns:d="DAV:"/.test(c.body)));
        // One request asks the principal for the scheduling properties and the inbox; the inbox, for its default calendar.
        assert.match(calls[3].body, /<c:schedule-outbox-URL\/><c:calendar-user-address-set\/><c:schedule-inbox-URL\/><c:schedule-default-calendar-URL\/>/);
        assert.match(calls[5].body, /<d:prop><c:schedule-default-calendar-URL\/><\/d:prop>/);

        // calendars() on a new source object finds them again from scratch.
        const again = await caldav.create(account, stubEnv(fetch)).calendars();
        assert.deepEqual(again, found.calendars);
    });

    /** A Depth 0 answer about `href` naming a calendar home. */
    const homeAt = (href, home) => multistatus([{ href, props: `<c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set>` }]);

    test('a home on another host gets no request and no password, even on the same domain', async () => {
        for (const [start, home, place] of [
            ['https://dav.example.com', 'https://collector.example.net/homes/alice/', 'collector.example.net'],
            ['https://dav.example.com', 'https://www.example.com/homes/alice/', 'www.example.com'],
            // A shared domain: other.co.uk is anyone's.
            ['https://dav.example.co.uk', 'https://other.co.uk/homes/alice/', 'other.co.uk'],
            ['https://dav.example.com', 'http://dav.example.com/homes/alice/', 'dav.example.com over http'],
            ['https://dav.example.com', 'https://dav.example.com:8443/homes/alice/', 'dav.example.com:8443'],
        ]) {
            const { fetch, calls } = fakeServer({ [`PROPFIND ${start}/`]: { body: homeAt('/', home) } });
            const account = { id: 'x', kind: 'caldav', url: start, username: 'alice' };
            await assert.rejects(caldav.discover(account, stubEnv(fetch)), (e) => isCode('config')(e)
                && e.message === `The server pointed to ${place}, which isn't the server this account names. `
                    + 'The plugin doesn\'t send the password there; if it is your CalDAV server, give its address instead.', home);
            assert.ok(calls.every((c) => new URL(c.url).origin === start), home);
        }
    });

    test('a redirect to another host drops the password, its answer isn\'t used, and discovery says where it led', async () => {
        const { fetch, calls } = fakeServer({
            'PROPFIND https://dav.example.com/': { status: 307, headers: { location: 'https://other.example.com/dav/' } },
            'PROPFIND https://other.example.com/dav/': {
                body: multistatus([{ href: '/dav/', props: '<d:current-user-principal><d:href>/dav/principals/alice/</d:href></d:current-user-principal>' }]),
            },
        });
        const account = { id: 'x', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' };
        await assert.rejects(caldav.discover(account, stubEnv(fetch)), (e) => isCode('config')(e)
            && e.message === 'dav.example.com sent the request on to other.example.com, which isn\'t the server this account names. '
                + 'The plugin doesn\'t send the password there; if it is your CalDAV server, give its address instead.');
        const elsewhere = calls.filter((c) => new URL(c.url).hostname === 'other.example.com');
        assert.equal(elsewhere.length, 1);
        assert.equal(header(elsewhere[0], 'authorization'), undefined);
        assert.ok(!calls.some((c) => c.url.includes('/dav/principals/')), 'what it named gets no request');
    });

    test('a domain whose /.well-known/caldav leads to its CalDAV host: discovery names that host to give instead', async () => {
        const { fetch, calls } = fakeServer({
            'PROPFIND https://example.com/': { status: 301, headers: { location: 'https://www.example.com/' } },
            'PROPFIND https://www.example.com/': { status: 405, body: 'Method not allowed' },
            'PROPFIND https://example.com/.well-known/caldav': { status: 301, headers: { location: 'https://dav.example.com/caldav/' } },
            'PROPFIND https://dav.example.com/caldav/': { status: 401, headers: { 'www-authenticate': 'Basic realm="dav"' } },
        });
        const account = { id: 'x', kind: 'caldav', preset: 'other', url: 'example.com', username: 'alice' };
        await assert.rejects(caldav.discover(account, stubEnv(fetch)), (e) => isCode('config')(e) && e.message.startsWith('example.com sent the request on to dav.example.com,'));
        assert.deepEqual(calls.map((c) => [c.url, header(c, 'authorization') === BASIC]), [
            ['https://example.com/', true],
            ['https://www.example.com/', false],
            ['https://example.com/.well-known/caldav', true],
            ['https://dav.example.com/caldav/', false],
        ]);
    });

    test('a redirect or an address that leads to this computer or its network gets no request, from a server elsewhere', async () => {
        const local = 'an address on this computer or its network, which isn\'t allowed.';
        const account = { id: 'x', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' };
        for (const location of ['http://127.0.0.1:8080/dav/', 'https://192.168.1.20/dav/', 'https://[::1]/dav/', 'https://localhost/dav/', 'https://sneaky.example.net/dav/']) {
            const { fetch, calls } = fakeServer({ 'PROPFIND https://dav.example.com/': { status: 302, headers: { location } } });
            // sneaky.example.net is a name that resolves to an address on the user's network.
            const env = stubEnv(fetch, { names: { 'sneaky.example.net': ['203.0.113.5', '10.0.0.7'] } });
            await assert.rejects(caldav.discover(account, env), (e) => isCode('config')(e) && e.message === `dav.example.com sent the request on to ${local}`, location);
            assert.ok(calls.every((c) => new URL(c.url).hostname === 'dav.example.com'), location);
        }
        // A home on such an address, named in an answer.
        const named = fakeServer({ 'PROPFIND https://dav.example.com/': { body: homeAt('/', 'http://192.168.1.20/homes/alice/') } });
        await assert.rejects(caldav.discover(account, stubEnv(named.fetch)), (e) => isCode('config')(e) && e.message === `dav.example.com pointed to ${local}`);
        assert.ok(named.calls.every((c) => new URL(c.url).hostname === 'dav.example.com'));
    });

    test('a Location on another host isn\'t taken as a new event\'s address', async () => {
        const collection = 'https://dav.example.com/cal/home/';
        const located = { 'a.ics': 'https://elsewhere.example.org/cal/home/a.ics', 'b.ics': '/cal/home/b-renamed.ics' };
        const { fetch } = fakeServer({});
        const routed = async (url, init) => {
            if (init.method !== 'PUT') return fetch(url, init);
            return new Response(null, { status: 201, headers: { etag: '"1"', location: located[String(url).split('/').pop()] } });
        };
        const source = caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, stubEnv(routed));
        assert.equal((await source.put({ remoteId: collection }, null, ics('a', 'A'), 'a')).remoteId, `${collection}a.ics`);
        assert.equal((await source.put({ remoteId: collection }, null, ics('b', 'B'), 'b')).remoteId, `${collection}b-renamed.ics`);
    });

    test('Nextcloud: the preset starts at /remote.php/dav; /.well-known/caldav with a 303 works too', async () => {
        const home = fixture('nextcloud-home.xml');
        const routes = {
            'PROPFIND https://cloud.example.com/remote.php/dav/': {
                body: multistatus([{ href: '/remote.php/dav/', props: '<d:current-user-principal><d:href>/remote.php/dav/principals/users/alice/</d:href></d:current-user-principal>' }]),
            },
            'PROPFIND https://cloud.example.com/remote.php/dav/principals/users/alice/': {
                body: multistatus([{ href: '/remote.php/dav/principals/users/alice/', props: '<c:calendar-home-set><d:href>/remote.php/dav/calendars/alice/</d:href></c:calendar-home-set>' }]),
            },
            'PROPFIND https://cloud.example.com/remote.php/dav/calendars/alice/': { body: home },
        };
        const expected = [
            { remoteId: 'https://cloud.example.com/remote.php/dav/calendars/alice/personal/', name: 'Personal', color: '#0082C9', readOnly: false, timeZone: 'Europe/Berlin' },
            { remoteId: 'https://cloud.example.com/remote.php/dav/calendars/alice/contact_birthdays/', name: 'Contact birthdays', color: '#E9D859', readOnly: true },
            { remoteId: 'https://cloud.example.com/remote.php/dav/calendars/alice/work%20stuff_shared_by_bob/', name: 'Work stuff (Bob)', color: '#795AAB', readOnly: false },
        ];
        const first = fakeServer(routes);
        const account = { id: 'nc', kind: 'caldav', preset: 'nextcloud', url: 'https://cloud.example.com/index.php/apps/calendar/dayGridMonth/now', username: 'alice' };
        const found = await caldav.discover(account, stubEnv(first.fetch));
        assert.equal(first.calls[0].url, 'https://cloud.example.com/remote.php/dav/');
        assert.equal(found.principal, 'https://cloud.example.com/remote.php/dav/principals/users/alice/');
        assert.deepEqual(found.calendars, expected);

        // As 'other' with only the server's address: its root is a web page, /.well-known/caldav sends a 303.
        const second = fakeServer({
            ...routes,
            'PROPFIND https://cloud.example.com/': { status: 405, body: 'Method not allowed' },
            'PROPFIND https://cloud.example.com/.well-known/caldav': { status: 303, headers: { location: '/remote.php/dav/' } },
            'GET https://cloud.example.com/remote.php/dav/': { status: 200, body: 'This is the WebDAV interface.' },
        });
        const other = await caldav.discover({ id: 'nc2', kind: 'caldav', preset: 'other', url: 'cloud.example.com', username: 'alice' }, stubEnv(second.fetch));
        assert.deepEqual(other.calendars, expected);
        assert.deepEqual(second.calls.slice(0, 4).map((c) => `${c.method} ${c.url}`), [
            'PROPFIND https://cloud.example.com/',
            'PROPFIND https://cloud.example.com/.well-known/caldav',
            'GET https://cloud.example.com/remote.php/dav/',
            'PROPFIND https://cloud.example.com/remote.php/dav/',
        ]);
    });

    test('Fastmail: an incremental sync by sync-collection, new and changed resources by multiget', async () => {
        const collection = 'https://caldav.fastmail.com/dav/calendars/user/alice@fastmail.com/Default/';
        const reports = [];
        const { fetch } = fakeServer({
            [`REPORT ${collection}`]: (call) => {
                reports.push(call);
                if (call.body.includes('sync-collection')) return { body: fixture('fastmail-sync.xml') };
                return { body: fixture('fastmail-multiget.xml') };
            },
        });
        const state = {
            v: 1,
            token: 'data:,30100-1700000000&more',
            etags: {
                '5f9a0c1e-1111-4a2b-9c3d-7e6f5a4b3c2d.ics': '"stale"',
                '0b1c2d3e-2222-4f5a-8b9c-0d1e2f3a4b5c.ics': '"x"',
                'c0ffee00-3333-4abc-8def-0123456789ab.ics': '"1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b"',
            },
        };
        const source = caldav.create({ id: 'fm', kind: 'caldav', preset: 'fastmail', username: 'alice' }, stubEnv(fetch));
        const result = await source.sync({ remoteId: collection, name: 'Calendar' }, state, {});
        assert.equal(result.reset, false);
        assert.deepEqual(result.removed, [`${collection}0b1c2d3e-2222-4f5a-8b9c-0d1e2f3a4b5c.ics`]);
        assert.equal(result.items.length, 1);
        const [item] = result.items;
        assert.equal(item.remoteId, `${collection}5f9a0c1e-1111-4a2b-9c3d-7e6f5a4b3c2d.ics`);
        assert.equal(item.etag, '"9c58a3f1d0e2b4c6a8e0f2d4b6c8a0e2"');
        assert.deepEqual(item.events, []);
        assert.ok(item.raw.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
        assert.ok(item.raw.endsWith('END:VCALENDAR\r\n'));
        assert.ok(!/[^\r]\n/.test(item.raw), 'CRLF line ends only');
        assert.match(item.raw, /\r\nSUMMARY:Lunch with Sam & Kim <3\r\nDESCRIPTION:Bring the "plans"\\, and a café map\r\n/);
        assert.deepEqual(result.state, {
            v: 1,
            token: 'data:,30188-1700000000',
            etags: {
                '5f9a0c1e-1111-4a2b-9c3d-7e6f5a4b3c2d.ics': '"9c58a3f1d0e2b4c6a8e0f2d4b6c8a0e2"',
                'c0ffee00-3333-4abc-8def-0123456789ab.ics': '"1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b"',
            },
        });
        // The REPORTs: the token escaped, Depth 0; the multiget names only the changed resource.
        assert.equal(header(reports[0], 'depth'), '0');
        assert.match(reports[0].body, /<d:sync-token>data:,30100-1700000000&amp;more<\/d:sync-token>/);
        assert.equal([...reports[1].body.matchAll(/<d:href>/g)].length, 1);
        assert.match(reports[1].body, /<d:href>\/dav\/calendars\/user\/alice@fastmail\.com\/Default\/5f9a0c1e-1111-4a2b-9c3d-7e6f5a4b3c2d\.ics<\/d:href>/);
    });

    test('Nextcloud: a truncated first sync (507) is followed; GET each where multiget is refused; tasks stay out', async () => {
        const collection = 'https://cloud.example.com/remote.php/dav/calendars/alice/personal/';
        const tokens = [];
        let multigets = 0;
        const { fetch, calls } = fakeServer({
            [`REPORT ${collection}`]: (call) => {
                if (call.body.includes('calendar-multiget')) {
                    multigets++;
                    return { status: 501, body: 'Not implemented' };
                }
                const token = /<d:sync-token>([^<]*)<\/d:sync-token>/.exec(call.body)[1];
                tokens.push(token);
                return { body: fixture(token === '' ? 'nextcloud-sync-1.xml' : 'nextcloud-sync-2.xml') };
            },
            [`GET ${collection}Nextcloud-1A2B3C4D.ics`]: { status: 200, body: ics('nc-1', 'Dentist'), headers: { etag: '"5d41402abc4b2a76b9719d911017c592"' } },
            [`GET ${collection}team%20sync.ics`]: { status: 200, body: ics('3f6c8a2e-team-sync', 'Team sync'), headers: { etag: '"4a8a08f09d37b73795649038408b5f33"' } },
            [`GET ${collection}task-1.ics`]: { status: 200, body: ics('task-1', 'Buy milk', 'VTODO'), headers: { etag: '"92eb5ffee6ae2fec3ad71c777531578f"' } },
        });
        const source = caldav.create({ id: 'nc', kind: 'caldav', preset: 'nextcloud', url: 'https://cloud.example.com', username: 'alice' }, stubEnv(fetch));
        const result = await source.sync({ remoteId: collection }, undefined, {});
        assert.deepEqual(tokens, ['', 'http://sabre.io/ns/sync/40']);
        assert.equal(multigets, 1, 'after one refusal, GET only');
        assert.equal(result.reset, true);
        assert.deepEqual(result.removed, []);
        assert.deepEqual(result.items.map((i) => [i.remoteId, i.etag]).sort(), [
            [`${collection}Nextcloud-1A2B3C4D.ics`, '"5d41402abc4b2a76b9719d911017c592"'],
            [`${collection}team%20sync.ics`, '"4a8a08f09d37b73795649038408b5f33"'],
        ]);
        assert.ok(result.items.every((i) => /SUMMARY:(Dentist|Team sync)\r\n/.test(i.raw)));
        assert.equal(result.state.token, 'http://sabre.io/ns/sync/41');
        assert.deepEqual(result.state.other, { 'task-1.ics': '"92eb5ffee6ae2fec3ad71c777531578f"' });
        assert.ok(!calls.some((c) => c.url.endsWith('old.ics')), 'deleted in the second round, never fetched');
    });

    test('a server without sync-collection: etag listings compared with the last sync; an unchanged ctag lists nothing', async () => {
        const collection = 'https://dav.example.com/cal/alice/home/';
        const server = {
            ctag: 'ctag-1',
            files: {
                '/cal/alice/home/a.ics': { etag: '"1"', text: ics('a', 'Alpha') },
                '/cal/alice/home/b.ics': { etag: '"2"', text: ics('b', 'Beta') },
            },
        };
        const seen = [];
        const { fetch } = fakeServer({
            [`REPORT ${collection}`]: (call) => {
                seen.push(call.body.includes('sync-collection') ? 'sync' : 'multiget');
                if (call.body.includes('sync-collection')) return { status: 501, body: 'Not implemented' };
                return { body: multigetAnswer(call.body, server.files) };
            },
            [`PROPFIND ${collection}`]: (call) => {
                if (header(call, 'depth') === '0') {
                    seen.push('ctag');
                    return { body: multistatus([{ href: '/cal/alice/home/', props: `<cs:getctag>${server.ctag}</cs:getctag>` }]) };
                }
                seen.push('list');
                return {
                    body: multistatus([
                        { href: '/cal/alice/home/', props: '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>' },
                        { href: '/cal/alice/home/attachments/', props: '<d:resourcetype><d:collection/></d:resourcetype>' },
                        ...Object.entries(server.files).map(([href, file]) => ({ href, etag: file.etag, props: '<d:resourcetype/>' })),
                    ]),
                };
            },
        });
        const env = stubEnv(fetch);
        const calendar = { remoteId: collection };
        const first = await caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, env).sync(calendar, undefined, {});
        assert.equal(first.reset, true);
        assert.deepEqual(first.items.map((i) => i.remoteId).sort(), [`${collection}a.ics`, `${collection}b.ics`]);
        assert.equal(first.state.noSync, env.now());
        assert.equal(first.state.ctag, 'ctag-1');
        assert.equal(first.state.token, undefined);
        assert.deepEqual(seen, ['sync', 'ctag', 'list', 'multiget']);

        seen.length = 0;
        const second = await caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, env).sync(calendar, first.state, {});
        assert.deepEqual(seen, ['ctag'], 'no sync-collection again for a while, and nothing listed');
        assert.deepEqual([second.reset, second.items, second.removed], [false, [], []]);
        assert.deepEqual(second.state, first.state);

        server.ctag = 'ctag-2';
        server.files['/cal/alice/home/a.ics'] = { etag: '"1b"', text: ics('a', 'Alpha moved') };
        delete server.files['/cal/alice/home/b.ics'];
        server.files['/cal/alice/home/c.ics'] = { etag: '"3"', text: ics('c', 'Gamma') };
        seen.length = 0;
        const third = await caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, env).sync(calendar, second.state, {});
        assert.deepEqual(seen, ['ctag', 'list', 'multiget']);
        assert.equal(third.reset, false);
        assert.deepEqual(third.items.map((i) => [i.remoteId, i.etag]).sort(), [[`${collection}a.ics`, '"1b"'], [`${collection}c.ics`, '"3"']]);
        assert.deepEqual(third.removed, [`${collection}b.ics`]);
        assert.deepEqual(third.state.etags, { 'a.ics': '"1b"', 'c.ics': '"3"' });

        // A week on, sync-collection is tried again.
        seen.length = 0;
        const later = stubEnv(fetch, { now: () => env.now() + 8 * 86_400_000 });
        const fourth = await caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, later).sync(calendar, third.state, {});
        assert.deepEqual(seen, ['sync', 'ctag']);
        assert.equal(fourth.state.noSync, later.now());
    });

    test('a sync token the server no longer takes: everything again with a new token, compared by etag', async () => {
        const collection = 'https://dav.example.com/cal/home/';
        const files = {
            '/cal/home/a.ics': { etag: '"1"', text: ics('a', 'Alpha') },
            '/cal/home/b.ics': { etag: '"2b"', text: ics('b', 'Beta changed') },
        };
        const syncs = [];
        const { fetch } = fakeServer({
            [`REPORT ${collection}`]: (call) => {
                if (call.body.includes('calendar-multiget')) return { body: multigetAnswer(call.body, files) };
                const token = /<d:sync-token>([^<]*)<\/d:sync-token>/.exec(call.body)[1];
                syncs.push(token);
                if (token !== '') {
                    return { status: 403, body: `<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>` };
                }
                return { body: multistatus(Object.entries(files).map(([href, f]) => ({ href, etag: f.etag })), 'token-new') };
            },
        });
        const state = { v: 1, token: 'token-old', etags: { 'a.ics': '"1"', 'b.ics': '"2"', 'c.ics': '"3"' } };
        const result = await caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, stubEnv(fetch))
            .sync({ remoteId: collection }, state, {});
        assert.deepEqual(syncs, ['token-old', '']);
        assert.equal(result.reset, false);
        assert.deepEqual(result.items.map((i) => i.remoteId), [`${collection}b.ics`]);
        assert.deepEqual(result.removed, [`${collection}c.ics`]);
        assert.deepEqual(result.state, { v: 1, token: 'token-new', etags: { 'a.ics': '"1"', 'b.ics': '"2b"' } });
    });

    test('multiget answers that leave a resource out, say it is gone, or send no data', async () => {
        const collection = 'https://dav.example.com/cal/x/';
        const etags = { a: '"a1"', b: '"b1"', c: '"c1"', d: '"d1"' };
        const { fetch, calls } = fakeServer({
            [`REPORT ${collection}`]: (call) => {
                if (call.body.includes('sync-collection')) {
                    return { body: multistatus(Object.entries(etags).map(([name, etag]) => ({ href: `/cal/x/${name}.ics`, etag })), 't1') };
                }
                return {
                    body: multistatus([
                        { href: '/cal/x/a.ics', etag: '"a1"', props: `<c:calendar-data>${ics('a', 'Alpha').replace(/\r/g, '&#13;')}</c:calendar-data>` },
                        { href: '/cal/x/c.ics', status: '404 Not Found' },
                        { href: '/cal/x/d.ics', etag: '"d1"', props: '<c:calendar-data/>' },
                    ]),
                };
            },
            [`GET ${collection}b.ics`]: { status: 200, body: ics('b', 'Beta'), headers: { etag: '"b2"' } },
            [`GET ${collection}d.ics`]: { status: 200, body: ics('d', 'Delta'), headers: { etag: '"d1"' } },
        });
        const result = await caldav.create({ id: 'm', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, stubEnv(fetch))
            .sync({ remoteId: collection }, undefined, {});
        assert.equal(result.reset, true);
        assert.deepEqual(result.items.map((i) => [i.remoteId, i.etag]), [
            [`${collection}a.ics`, '"a1"'],
            [`${collection}b.ics`, '"b2"'],
            [`${collection}d.ics`, '"d1"'],
        ]);
        assert.deepEqual(result.state, { v: 1, token: 't1', etags: { 'a.ics': '"a1"', 'b.ics': '"b2"', 'd.ics': '"d1"' } });
        assert.deepEqual(calls.filter((c) => c.method === 'GET').map((c) => c.url).sort(), [`${collection}b.ics`, `${collection}d.ics`]);
    });

    test('put and remove: conditional requests and what their refusals mean', async () => {
        const collection = 'https://dav.example.com/cal/home/';
        const puts = [];
        const answers = {
            'new.ics': { status: 201, headers: { etag: '"e1"' } },
            'no-etag.ics': { status: 204 },
            'stale.ics': { status: 412 },
            'dup.ics': { status: 403, body: `<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:c="${CALDAV}"><c:no-uid-conflict><d:href>/cal/home/other.ics</d:href></c:no-uid-conflict></d:error>` },
            'bad.ics': { status: 403, body: `<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:c="${CALDAV}"><c:valid-calendar-data/></d:error>` },
        };
        const { fetch, calls } = fakeServer({
            [`PROPFIND ${collection}no-etag.ics`]: { body: multistatus([{ href: '/cal/home/no-etag.ics', etag: '"e2"' }]) },
            [`GET ${collection}no-etag.ics`]: { status: 200, body: ics('n', 'N'), headers: { etag: '"e2"' } },
            [`DELETE ${collection}gone.ics`]: { status: 404 },
            [`DELETE ${collection}new.ics`]: (call) => (header(call, 'if-match') === '"e1"' ? { status: 204 } : { status: 412 }),
            [`DELETE ${collection}locked.ics`]: { status: 403 },
        });
        const routed = async (url, init) => {
            if (init.method === 'PUT') {
                puts.push({ url, headers: init.headers, body: init.body });
                const name = String(url).split('/').pop();
                const { status, headers = {}, body = null } = answers[name] ?? { status: 201, headers: { etag: '"other"' } };
                return new Response(body, { status, headers });
            }
            return fetch(url, init);
        };
        const source = caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, stubEnv(routed));
        const calendar = { remoteId: collection };

        assert.deepEqual(await source.put(calendar, null, ics('new', 'New'), 'new'), { remoteId: `${collection}new.ics`, etag: '"e1"' });
        assert.equal(header(puts[0], 'if-none-match'), '*');
        assert.equal(header(puts[0], 'if-match'), undefined);
        assert.equal(header(puts[0], 'content-type'), 'text/calendar; charset=utf-8');
        assert.equal(puts[0].body, ics('new', 'New'));

        // No etag in the answer: asked for with PROPFIND.
        assert.deepEqual(await source.put(calendar, { remoteId: `${collection}no-etag.ics`, etag: '"e0"' }, ics('n', 'N'), 'n'), { remoteId: `${collection}no-etag.ics`, etag: '"e2"' });
        assert.equal(header(puts[1], 'if-match'), '"e0"');
        assert.equal(header(puts[1], 'if-none-match'), undefined);

        await assert.rejects(source.put(calendar, { remoteId: `${collection}stale.ics`, etag: '"old"' }, ics('s', 'S'), 's'), isCode('conflict'));
        await assert.rejects(source.put(calendar, null, ics('dup', 'D'), 'dup'), isCode('conflict'));
        await assert.rejects(source.put(calendar, null, ics('bad', 'B'), 'bad'), (e) => isCode('server')(e) && /valid-calendar-data/.test(e.message));

        // A UID that isn't a plain file name: a readable part and a hash.
        const odd = await source.put(calendar, null, ics('odd', 'O'), 'Odd/UID with spaces?#1');
        assert.match(odd.remoteId, /^https:\/\/dav\.example\.com\/cal\/home\/Odd-UID-with-spaces-1-[0-9a-f]{24}\.ics$/);
        const plain = await source.put(calendar, null, ics('x', 'X'), 'abc-123@example.com');
        assert.equal(plain.remoteId, `${collection}abc-123@example.com.ics`);

        // No stored etag: the event is read first, so a change made elsewhere meanwhile is a conflict, not lost.
        await source.put(calendar, { remoteId: `${collection}no-etag.ics`, raw: ics('n', 'N') }, ics('n', 'N2'), 'n');
        assert.equal(header(puts.at(-1), 'if-match'), '"e2"');

        await source.remove(calendar, { remoteId: `${collection}new.ics`, etag: '"e1"' });
        await source.remove(calendar, { remoteId: `${collection}gone.ics`, etag: '"e9"' });
        await assert.rejects(source.remove(calendar, { remoteId: `${collection}new.ics`, etag: '"old"' }), isCode('conflict'));
        await assert.rejects(source.remove(calendar, { remoteId: `${collection}locked.ics`, etag: '"e1"' }), isCode('forbidden'));
        assert.ok(calls.filter((c) => c.method === 'DELETE').every((c) => header(c, 'if-match') !== undefined));
        assert.ok(calls.filter((c) => c.method === 'DELETE').every((c) => header(c, 'schedule-reply') === undefined));

        // Taking out an invitation without telling its organizer: Schedule-Reply: F (RFC 6638), and the etag read first.
        const before = calls.length;
        await source.remove(calendar, { remoteId: `${collection}no-etag.ics`, raw: ics('n', 'N') }, { scheduleReply: false });
        const quiet = calls.slice(before);
        assert.deepEqual(quiet.map((c) => c.method), ['GET', 'DELETE']);
        assert.equal(header(quiet[1], 'if-match'), '"e2"');
        assert.equal(header(quiet[1], 'schedule-reply'), 'F');
    });

    test('a change whose etag can\'t be read isn\'t made; a server that keeps none for it gets If-Match: *; one gone meanwhile is a conflict, or done for a delete', async () => {
        const collection = 'https://dav.example.com/cal/home/';
        const { fetch, calls } = fakeServer({
            [`GET ${collection}flaky.ics`]: { status: 500 },
            [`GET ${collection}offline.ics`]: new TypeError('fetch failed'),
            [`GET ${collection}refused.ics`]: { status: 403 },
            [`GET ${collection}bare.ics`]: { status: 200, body: ics('b', 'B') },
            [`PROPFIND ${collection}bare.ics`]: { body: multistatus([{ href: '/cal/home/bare.ics', props: '' }]) },
            [`PUT ${collection}bare.ics`]: { status: 204, headers: { etag: '"b2"' } },
            [`DELETE ${collection}bare.ics`]: { status: 204 },
            [`GET ${collection}gone.ics`]: { status: 404 },
        });
        const source = caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, stubEnv(fetch));
        const calendar = { remoteId: collection };
        const writes = () => calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE').length;

        await assert.rejects(source.put(calendar, { remoteId: `${collection}flaky.ics` }, ics('f', 'F'), 'f'),
            (e) => isCode('server')(e) && e.message === 'The event\'s version on the server couldn\'t be read, so nothing was changed. Try again.');
        await assert.rejects(source.remove(calendar, { remoteId: `${collection}flaky.ics` }), isCode('server'));
        await assert.rejects(source.put(calendar, { remoteId: `${collection}offline.ics` }, ics('o', 'O'), 'o'), isCode('network'));
        await assert.rejects(source.put(calendar, { remoteId: `${collection}refused.ics` }, ics('r', 'R'), 'r'), isCode('server'));
        assert.equal(writes(), 0, 'no unconditional write');

        // A server that keeps no etag for it: it must at least still be there, naming the same people.
        await source.put(calendar, { remoteId: `${collection}bare.ics`, raw: ics('b', 'B') }, ics('b', 'B2'), 'b');
        assert.equal(header(calls.at(-1), 'if-match'), '*');
        await source.remove(calendar, { remoteId: `${collection}bare.ics`, raw: ics('b', 'B') });
        assert.equal(header(calls.at(-1), 'if-match'), undefined);

        // Deleted on the server meanwhile: a change to it is a conflict (the manager syncs); a delete has nothing left to do.
        await assert.rejects(source.put(calendar, { remoteId: `${collection}gone.ics` }, ics('g', 'G'), 'g'), isCode('conflict'));
        const before = writes();
        await source.remove(calendar, { remoteId: `${collection}gone.ics` });
        assert.equal(writes(), before);
    });

    test('no etag held: the event is read first, and a change or a delete goes on only while it names the same people as the plugin\'s copy', async () => {
        const collection = 'https://dav.example.com/cal/home/';
        const meeting = (people) => [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DSH calendar tests//EN', 'BEGIN:VEVENT', 'UID:standup', 'DTSTAMP:20261011T000000Z',
            'DTSTART:20261012T090000Z', 'DTEND:20261012T093000Z', 'SUMMARY:Standup', 'ORGANIZER:mailto:alice@example.com',
            ...people.map((p) => `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${p}`), 'END:VEVENT', 'END:VCALENDAR', '',
        ].join('\r\n');
        let server = meeting(['ann@example.com', 'bob@example.com']);
        const { fetch, calls } = fakeServer({
            [`GET ${collection}standup.ics`]: () => ({ status: 200, body: server, headers: { etag: '"s1"' } }),
            [`PUT ${collection}standup.ics`]: { status: 204, headers: { etag: '"s2"' } },
            [`DELETE ${collection}standup.ics`]: { status: 204 },
        });
        const source = caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, stubEnv(fetch));
        const calendar = { remoteId: collection };
        const item = { remoteId: `${collection}standup.ics`, raw: meeting(['ann@example.com', 'bob@example.com']) };
        const writes = () => calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE');

        // Someone added on the server since the plugin read it: the server would email them, so nothing is written.
        server = meeting(['ann@example.com', 'bob@example.com', 'cy@example.com']);
        await assert.rejects(source.put(calendar, item, item.raw.replace('Standup', 'Standup!'), 'standup'), isCode('conflict'));
        await assert.rejects(source.remove(calendar, item), isCode('conflict'));
        // Someone taken off there: writing the plugin's copy would invite them again, and a delete would be said to cancel it for them.
        server = meeting(['ann@example.com']);
        await assert.rejects(source.put(calendar, item, item.raw.replace('Standup', 'Standup!'), 'standup'), isCode('conflict'));
        await assert.rejects(source.remove(calendar, item), isCode('conflict'));
        assert.equal(writes().length, 0);
        // The same people (in another order, by another case): the change goes, on the version read, and so does a delete.
        server = meeting(['BOB@example.com', 'ann@example.com']);
        assert.deepEqual(await source.put(calendar, item, item.raw.replace('Standup', 'Standup!'), 'standup'), { remoteId: item.remoteId, etag: '"s2"' });
        assert.equal(header(writes().at(-1), 'if-match'), '"s1"');
        await source.remove(calendar, item);
        assert.deepEqual([writes().at(-1).method, header(writes().at(-1), 'if-match')], ['DELETE', '"s1"']);
    });

    test('a create repeated after a timeout: the event already there with its uid counts as made; another one there is a conflict', async () => {
        const collection = 'https://dav.example.com/cal/home/';
        const uid = '6f1c2b7e-0d4a-4c3e-9a51-2b8f0e7d6c5a';
        const { fetch, calls } = fakeServer({
            // The first try was stored, but its answer never came: the same uid is put again.
            [`PUT ${collection}${uid}.ics`]: { status: 412 },
            [`GET ${collection}${uid}.ics`]: { status: 200, body: ics(uid, 'Lunch'), headers: { etag: '"stored-1"' } },
            // Another event under the name a uid gives.
            [`PUT ${collection}taken.ics`]: { status: 412 },
            [`GET ${collection}taken.ics`]: { status: 200, body: ics('someone-else', 'Not ours'), headers: { etag: '"x"' } },
            // Gone again by the time it is read.
            [`PUT ${collection}vanished.ics`]: { status: 412 },
            // Stored, and the server sends no etag with it.
            [`PUT ${collection}quiet.ics`]: { status: 412 },
            [`GET ${collection}quiet.ics`]: { status: 200, body: ics('quiet', 'Quiet') },
            [`PROPFIND ${collection}quiet.ics`]: { body: multistatus([{ href: '/cal/home/quiet.ics', etag: '"q1"' }]) },
            [`PUT ${collection}changed.ics`]: { status: 412 },
        });
        const source = caldav.create({ id: 'd', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' }, stubEnv(fetch));
        const calendar = { remoteId: collection };

        assert.deepEqual(await source.put(calendar, null, ics(uid, 'Lunch'), uid), { remoteId: `${collection}${uid}.ics`, etag: '"stored-1"' });
        assert.deepEqual(calls.map((c) => [c.method, c.url, header(c, 'if-none-match')]), [
            ['PUT', `${collection}${uid}.ics`, '*'],
            ['GET', `${collection}${uid}.ics`, undefined],
        ]);
        assert.equal(header(calls[1], 'authorization'), BASIC);

        await assert.rejects(source.put(calendar, null, ics('taken', 'Mine'), 'taken'), isCode('conflict'));
        await assert.rejects(source.put(calendar, null, ics('vanished', 'V'), 'vanished'), isCode('conflict'));
        assert.deepEqual(await source.put(calendar, null, ics('quiet', 'Quiet'), 'quiet'), { remoteId: `${collection}quiet.ics`, etag: '"q1"' });

        // A change (If-Match) refused is a conflict as before, and nothing is read back.
        const before = calls.length;
        await assert.rejects(source.put(calendar, { remoteId: `${collection}changed.ics`, etag: '"old"' }, ics('changed', 'C'), 'changed'), isCode('conflict'));
        assert.deepEqual(calls.slice(before).map((c) => c.method), ['PUT']);
    });

    test('the default calendar: Nextcloud names it on the principal; a server without one marks none', async () => {
        const principal = 'https://cloud.example.com/remote.php/dav/principals/users/alice/';
        const routes = (scheduling, inbox) => ({
            'PROPFIND https://cloud.example.com/remote.php/dav/': {
                body: multistatus([{ href: '/remote.php/dav/', props: '<d:current-user-principal><d:href>/remote.php/dav/principals/users/alice/</d:href></d:current-user-principal>' }]),
            },
            [`PROPFIND ${principal}`]: (call) => (/schedule-outbox-URL/.test(call.body) ? scheduling
                : { body: homeAt('/remote.php/dav/principals/users/alice/', '/remote.php/dav/calendars/alice/') }),
            'PROPFIND https://cloud.example.com/remote.php/dav/calendars/alice/inbox/': inbox,
            'PROPFIND https://cloud.example.com/remote.php/dav/calendars/alice/': { body: fixture('nextcloud-home.xml') },
        });
        const account = { id: 'nc', kind: 'caldav', preset: 'nextcloud', url: 'https://cloud.example.com', username: 'alice' };
        const primaryOf = (calendars) => calendars.filter((c) => c.primary).map((c) => c.remoteId);

        const nextcloud = fakeServer(routes({ body: fixture('nextcloud-principal.xml') }, { status: 500 }));
        const found = await caldav.discover(account, stubEnv(nextcloud.fetch));
        assert.deepEqual(primaryOf(found.calendars), ['https://cloud.example.com/remote.php/dav/calendars/alice/personal/']);
        assert.deepEqual(found.calendars.map((c) => [c.name, c.scheduling, c.addresses]), [
            ...['Personal', 'Contact birthdays', 'Work stuff (Bob)'].map((name) => [name, true, ['alice@example.com', 'https://cloud.example.com/remote.php/dav/principals/users/alice/']]),
        ]);
        assert.ok(!nextcloud.calls.some((c) => c.url.endsWith('/inbox/')), 'the principal said it: no request to the inbox');

        // The inbox names none (an empty property means no default), fails, or there is no inbox: no calendar is primary.
        const noOutbox = '<c:schedule-inbox-URL><d:href>/remote.php/dav/calendars/alice/inbox/</d:href></c:schedule-inbox-URL>';
        const empty = multistatus([{ href: '/remote.php/dav/calendars/alice/inbox/', props: '<c:schedule-default-calendar-URL/>' }]);
        for (const [scheduling, inbox] of [
            [{ body: multistatus([{ href: '/remote.php/dav/principals/users/alice/', props: noOutbox }]) }, { body: empty }],
            [{ body: multistatus([{ href: '/remote.php/dav/principals/users/alice/', props: noOutbox }]) }, { status: 500 }],
            [{ body: multistatus([{ href: '/remote.php/dav/principals/users/alice/' }]) }, undefined],
        ]) {
            const server = fakeServer(routes(scheduling, inbox));
            const none = await caldav.discover(account, stubEnv(server.fetch));
            assert.deepEqual(primaryOf(none.calendars), []);
            assert.equal(none.calendars.length, 3);
        }
    });

    test('scheduling: a server without an outbox doesn\'t schedule; one that doesn\'t say is unknown', async () => {
        const principal = '<d:current-user-principal><d:href>/dav/principals/alice/</d:href></d:current-user-principal>';
        const routes = (scheduling) => ({
            'PROPFIND https://dav.example.com/': { body: multistatus([{ href: '/', props: principal }]) },
            'PROPFIND https://dav.example.com/dav/principals/alice/': (call) => {
                if (!/schedule-outbox-URL/.test(call.body)) return { body: multistatus([{ href: '/dav/principals/alice/', props: '<c:calendar-home-set><d:href>/dav/calendars/alice/</d:href></c:calendar-home-set>' }]) };
                return { body: scheduling };
            },
            'PROPFIND https://dav.example.com/dav/calendars/alice/': {
                body: multistatus([{ href: '/dav/calendars/alice/personal/', props: '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Personal</d:displayname>' }]),
            },
        });
        const account = { id: 'r', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' };
        // Radicale: both asked for, both "404 Not Found".
        const radicale = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:response><d:href>/dav/principals/alice/</d:href>`
            + '<d:propstat><d:prop><c:schedule-outbox-URL/><c:calendar-user-address-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>';
        const none = await caldav.discover(account, stubEnv(fakeServer(routes(radicale)).fetch));
        assert.equal(none.calendars[0].scheduling, false);
        assert.equal(none.calendars[0].addresses, undefined);
        // An error, or an answer that says nothing about it: unknown (the plugin then takes it as a server that schedules).
        const silent = await caldav.discover(account, stubEnv(fakeServer(routes(multistatus([{ href: '/dav/principals/alice/' }]))).fetch));
        assert.equal(silent.calendars[0].scheduling, undefined);
        const failing = fakeServer(routes(undefined));
        const broken = await caldav.discover(account, stubEnv(async (url, init) => (/schedule-outbox-URL/.test(init?.body ?? '') ? new Response('nope', { status: 500 }) : failing.fetch(url, init))));
        assert.equal(broken.calendars[0].scheduling, undefined);
        assert.equal(broken.calendars[0].name, 'Personal');
    });

    test('errors: a refused sign-in, an unauthenticated principal, no password, an unreachable server, plain http', async () => {
        const account = { id: 'e', kind: 'caldav', url: 'https://dav.example.com/', username: 'alice' };
        const refused = fakeServer({ 'PROPFIND https://dav.example.com/': { status: 401, body: 'no', headers: { 'www-authenticate': 'Basic realm="x"' } } });
        await assert.rejects(caldav.discover(account, stubEnv(refused.fetch)), isCode('auth'));

        const anonymous = fakeServer({
            'PROPFIND https://dav.example.com/': { body: multistatus([{ href: '/', props: '<d:current-user-principal><d:unauthenticated/></d:current-user-principal>' }]) },
        });
        await assert.rejects(caldav.discover(account, stubEnv(anonymous.fetch)), isCode('auth'));

        const unused = fakeServer({});
        await assert.rejects(caldav.discover(account, stubEnv(unused.fetch, { secret: { get: async () => undefined } })), isCode('auth'));
        assert.equal(unused.calls.length, 0);

        const down = async () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        };
        await assert.rejects(caldav.discover(account, stubEnv(down)), (e) => isCode('network')(e) && /connection was refused/.test(e.message));
        await assert.rejects(caldav.create(account, stubEnv(down)).sync({ remoteId: 'https://dav.example.com/cal/' }, undefined, {}), isCode('network'));

        const plain = fakeServer({ 'PROPFIND http://dav.example.com/': { status: 401 } });
        await assert.rejects(caldav.discover({ ...account, url: 'http://dav.example.com/' }, stubEnv(plain.fetch)), isCode('config'));
        assert.equal(plain.calls.length, 0);
        // allowHttp lets it through (and the server's answer decides).
        await assert.rejects(caldav.discover({ ...account, url: 'http://dav.example.com/', allowHttp: true }, stubEnv(plain.fetch)), isCode('auth'));
        assert.equal(plain.calls.length, 1);

        await assert.rejects(caldav.discover({ id: 'n', kind: 'caldav', username: 'alice' }, stubEnv(unused.fetch)), isCode('config'));
        const nothing = fakeServer({});
        await assert.rejects(caldav.discover(account, stubEnv(nothing.fetch)), (e) => isCode('config')(e) && /No CalDAV calendars were found at https:\/\/dav\.example\.com\//.test(e.message));
    });
});

describe('PRESETS', () => {
    test('one for each service, with what the account dialog shows', () => {
        assert.deepEqual(caldav.PRESETS.map((p) => p.id), ['icloud', 'fastmail', 'nextcloud', 'yahoo', 'mailbox.org', 'zoho', 'other']);
        for (const preset of caldav.PRESETS) {
            assert.equal(typeof preset.name, 'string');
            assert.ok(preset.usernameHint.length > 0 && preset.passwordHint.length > 0, preset.id);
            if (preset.needsUrl) assert.equal(preset.url, '', preset.id);
            else assert.match(preset.url, /^https:\/\/[a-z0-9.-]+$/, preset.id);
            if (preset.helpUrl !== undefined) assert.match(preset.helpUrl, /^https:\/\//, preset.id);
        }
        assert.equal(caldav.kind, 'caldav');
        assert.equal(caldav.style, 'ics');
    });
});

// ---------------------------------------------------------------------------
// Against a real Radicale server

/** A python that can run Radicale 3 or later: RADICALE_PYTHON, RADICALE_VENV's, or python3 on the PATH. */
function findRadicale() {
    const candidates = [];
    if (process.env.RADICALE_PYTHON) candidates.push(process.env.RADICALE_PYTHON);
    if (process.env.RADICALE_VENV) {
        candidates.push(process.platform === 'win32' ? join(process.env.RADICALE_VENV, 'Scripts', 'python.exe') : join(process.env.RADICALE_VENV, 'bin', 'python'));
    }
    candidates.push('python3');
    for (const python of candidates) {
        try {
            const version = execFileSync(python, ['-c', 'import radicale; print(radicale.VERSION)'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
            if (Number.parseInt(version, 10) >= 3) return python;
        } catch {}
    }
    return undefined;
}

async function freePort() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    server.close();
    await once(server, 'close');
    return port;
}

const python = findRadicale();

describe('against Radicale', { skip: python === undefined ? 'Radicale not found: set RADICALE_VENV to a virtualenv with radicale installed' : false }, () => {
    const user = 'alice';
    const password = 'radicale-test-pw';
    let dir;
    let server;
    let base;
    let stderr = '';
    const env = {
        request,
        secret: { get: async () => ({ password }) },
        log: () => {},
        now: () => Date.now(),
        zone: 'UTC',
        settings: {},
    };
    const account = () => ({ id: 'radicale', kind: 'caldav', name: 'Radicale', url: base, username: user });
    const fresh = () => caldav.create(account(), env);

    /** The second client: plain fetch, signed in. */
    async function dav(method, path, { body, headers = {} } = {}) {
        const res = await fetch(new URL(path, base), {
            method,
            body,
            headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, ...headers },
        });
        return { status: res.status, etag: res.headers.get('etag'), text: await res.text() };
    }
    const putFile = async (path, text) => {
        const res = await dav('PUT', path, { body: text, headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
        assert.ok(res.status === 201 || res.status === 204, `PUT ${path}: ${res.status}`);
        return res.etag;
    };

    const ZONE = 'Europe/Berlin';
    const NOW = Date.parse('2026-10-11T10:00:00Z');

    /**
     * The manager with a new calendar on this server, `name`, as a CalDAV
     * account's, synced; the user is alice@example.com. opts.fetch: how the
     * manager reaches the server. opts.scheduling: what the calendar says
     * about email (Radicale sends none; marked as a server that does, the
     * manager works out who it would email). → {m, id: the calendar's, done}.
     */
    async function managerOn(name, { fetch: reach, scheduling = false } = {}) {
        const made = await dav('MKCALENDAR', `${user}/${name}/`, {
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
            body: `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:set><d:prop><d:displayname>${name}</d:displayname></d:prop></d:set></c:mkcalendar>`,
        });
        assert.equal(made.status, 201, `MKCALENDAR ${name}: ${made.status}`);
        const folder = mkdtempSync(join(tmpdir(), 'caldav-manager-'));
        const m = new CalendarManager({
            config: { storeFile: join(folder, 'calendar.json'), logFile: '', syncMinutes: 15, timeZone: ZONE },
            secrets: { get: async () => ({ password }), set: async () => {}, clear: async () => {} },
            now: () => NOW,
            ...(reach ? { fetch: reach } : {}),
        });
        m.store.accounts.rad = { id: 'rad', kind: 'caldav', name: 'Radicale', url: base, username: user, email: 'alice@example.com', createdAt: NOW, calendarsAt: NOW };
        const remoteId = `${base}${user}/${name}/`;
        const id = calendarIdOf('rad', remoteId);
        m.store.calendars[id] = { id, accountId: 'rad', remoteId, name, color: '#4f7cff', readOnly: false, mode: 'masters', scheduling };
        m.store.itemsOf(id);
        await m.syncCalendar(id, { throwErrors: true });
        return {
            m, id,
            done: () => {
                m.dispose();
                rmSync(folder, { recursive: true, force: true });
            },
        };
    }

    /** An event as the server holds it now: its occurrences in [from, to), as "start title @ place with guests". */
    async function heldOn(path, from, to) {
        const { events } = readIcs((await dav('GET', path)).text, { zone: ZONE });
        return occurrences(events, { from: Date.parse(from), to: Date.parse(to), zone: ZONE }).map(({ record, start }) => `${toLocal(start, ZONE).slice(0, 16)} ${record.title} `
            + `@ ${record.location ?? '-'} with ${(record.attendees ?? []).map((p) => p.email.split('@')[0]).join(' ')}`);
    }

    /** The changed occurrences an event has on the server: "start" for each, "and following" on those that reach later ones too. */
    async function changedOn(path) {
        const { events } = readIcs((await dav('GET', path)).text, { zone: ZONE });
        return events.filter((r) => r.recurrenceId).map((r) => `${r.recurrenceId.local}${r.thisAndFuture ? ' and following' : ''}`).sort();
    }

    /** A meeting alice organizes, as another app writes it: VEVENT lines with these, then the people. */
    const meetingOf = (uid, lines, people) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z', ...lines, 'DURATION:PT1H', 'ORGANIZER:mailto:alice@example.com',
        ...people.map((p) => `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${p}@example.com`), 'END:VEVENT'];
    const calendarOf = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DSH calendar tests//EN', ...events.flat(), 'END:VCALENDAR', ''].join('\r\n');

    /**
     * This server as one that keeps no tags: its answers without ETag
     * headers or getetag properties, and If-Match: * taken as "it is there"
     * (Radicale itself compares it with the tag). → {fetch, writes: the
     * PUTs and DELETEs sent, as "METHOD path If-Match"}.
     */
    function tagless() {
        const writes = [];
        const reach = async (url, init = {}) => {
            const method = init.method ?? 'GET';
            const sent = Object.entries(init.headers ?? {});
            const ifMatch = sent.find(([k]) => k.toLowerCase() === 'if-match')?.[1] ?? '-';
            if (method === 'PUT' || method === 'DELETE') writes.push(`${method} ${new URL(url).pathname} ${ifMatch}`);
            if (ifMatch === '*') {
                if ((await fetch(url, { method: 'HEAD', headers: init.headers })).status === 404) return new Response(null, { status: 412 });
                init = { ...init, headers: Object.fromEntries(sent.filter(([k]) => k.toLowerCase() !== 'if-match')) };
            }
            const res = await fetch(url, init);
            const headers = new Headers(res.headers);
            for (const name of ['etag', 'content-length', 'content-encoding']) headers.delete(name);
            const text = (await res.text()).replace(/<([\w.-]+:)?getetag\b[^>]*?(?:\/>|>[^<]*<\/\1getetag>)/g, '');
            return new Response([204, 304].includes(res.status) ? null : text, { status: res.status, headers });
        };
        return { fetch: reach, writes };
    }

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), 'caldav-radicale-'));
        writeFileSync(join(dir, 'users'), `${user}:${password}\n`);
        const port = await freePort();
        base = `http://127.0.0.1:${port}/`;
        server = spawn(python, [
            '-m', 'radicale', '--config',
            '--server-hosts', `127.0.0.1:${port}`,
            '--storage-filesystem-folder', join(dir, 'collections'),
            '--auth-type', 'htpasswd', '--auth-htpasswd-filename', join(dir, 'users'), '--auth-htpasswd-encryption', 'plain',
            '--auth-delay', '0', '--rights-type', 'owner_only', '--logging-level', 'warning',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        // Never left running, whatever happens to the tests.
        process.once('exit', () => server.kill());
        server.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-4000);
        });
        const deadline = Date.now() + 20_000;
        for (;;) {
            if (server.exitCode !== null) throw new Error(`Radicale stopped: ${stderr}`);
            try {
                await fetch(base);
                break;
            } catch {
                if (Date.now() > deadline) throw new Error(`Radicale didn't start: ${stderr}`);
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        const made = await dav('MKCALENDAR', `${user}/work/`, {
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
            body: `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:i="http://apple.com/ns/ical/"><d:set><d:prop>
<d:displayname>Work &amp; Play</d:displayname>
<i:calendar-color>#FF2968FF</i:calendar-color>
<c:calendar-description>Team things</c:calendar-description>
<c:calendar-timezone>BEGIN:VCALENDAR&#13;
VERSION:2.0&#13;
PRODID:-//DSH calendar tests//EN&#13;
BEGIN:VTIMEZONE&#13;
TZID:Europe/Paris&#13;
BEGIN:STANDARD&#13;
DTSTART:19701025T030000&#13;
TZOFFSETFROM:+0200&#13;
TZOFFSETTO:+0100&#13;
END:STANDARD&#13;
END:VTIMEZONE&#13;
END:VCALENDAR&#13;
</c:calendar-timezone>
<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
</d:prop></d:set></c:mkcalendar>`,
        });
        assert.equal(made.status, 201, `MKCALENDAR work: ${made.status}`);
        const tasks = await dav('MKCALENDAR', `${user}/tasks/`, {
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
            body: `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:set><d:prop><d:displayname>Tasks</d:displayname>`
                + '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>',
        });
        assert.equal(tasks.status, 201, `MKCALENDAR tasks: ${tasks.status}`);
        // A calendar that doesn't say what it holds, made with extended MKCOL (RFC 5689).
        const mixed = await dav('MKCOL', `${user}/mixed/`, {
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
            body: `<?xml version="1.0" encoding="utf-8"?><d:mkcol xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:set><d:prop>`
                + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Mixed</d:displayname></d:prop></d:set></d:mkcol>',
        });
        assert.equal(mixed.status, 201, `MKCOL mixed: ${mixed.status}`);
    }, { timeout: 60_000 });

    after(async () => {
        if (server !== undefined && server.exitCode === null) {
            const exited = once(server, 'exit');
            server.kill();
            await exited;
        }
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    });

    test('discovers the calendars from the server root', async () => {
        const found = await caldav.discover(account(), env);
        assert.equal(found.principal, `${base}${user}/`);
        assert.equal(found.home, `${base}${user}/`);
        assert.deepEqual(found.calendars.map((c) => c.name).sort(), ['Mixed', 'Work & Play'], 'Tasks holds no events');
        assert.deepEqual(found.calendars.find((c) => c.name === 'Work & Play'), {
            remoteId: `${base}${user}/work/`,
            name: 'Work & Play',
            color: '#FF2968',
            readOnly: false,
            description: 'Team things',
            timeZone: 'Europe/Paris',
            // Radicale doesn't schedule: it emails nobody, and says so (no outbox). It names its user by the principal's URL.
            scheduling: false,
            addresses: [`${base}${user}/`],
        });
        assert.deepEqual(await fresh().calendars(), found.calendars);
    });

    test('discovers from /.well-known/caldav, the principal and a calendar', async () => {
        for (const url of [`${base}.well-known/caldav`, `${base}${user}/`, `${base}${user}/work/`, `${base}${user}/work`]) {
            const found = await caldav.discover({ ...account(), url }, env);
            assert.equal(found.home, `${base}${user}/`, url);
            assert.deepEqual(found.calendars.map((c) => c.remoteId).sort(), [`${base}${user}/mixed/`, `${base}${user}/work/`], url);
        }
    });

    test('a wrong password is a sign-in error', async () => {
        const wrong = { ...env, secret: { get: async () => ({ password: 'not-it' }) } };
        await assert.rejects(caldav.discover(account(), wrong), isCode('auth'));
        await assert.rejects(caldav.create(account(), wrong).sync({ remoteId: `${base}${user}/work/` }, undefined, {}), isCode('auth'));
    });

    test('put creates and changes events, refuses a stale etag or a name another event has, and finds a repeated create made', async () => {
        const work = { remoteId: `${base}${user}/work/` };
        const uid = 'put-1@example.com';
        const created = await fresh().put(work, null, ics(uid, 'First'), uid);
        assert.equal(created.remoteId, `${base}${user}/work/${uid}.ics`);
        assert.match(created.etag, /^"[^"]+"$/);
        const stored = await dav('GET', `${user}/work/${uid}.ics`);
        assert.equal(stored.status, 200);
        assert.match(stored.text, /SUMMARY:First/);
        assert.equal(stored.etag, created.etag);

        const changed = await fresh().put(work, { remoteId: created.remoteId, etag: created.etag }, ics(uid, 'Second'), uid);
        assert.equal(changed.remoteId, created.remoteId);
        assert.notEqual(changed.etag, created.etag);
        assert.match((await dav('GET', `${user}/work/${uid}.ics`)).text, /SUMMARY:Second/);

        await assert.rejects(fresh().put(work, { remoteId: created.remoteId, etag: created.etag }, ics(uid, 'Third'), uid), isCode('conflict'));
        // A create repeated with the same uid (its first try timed out after the server stored it): made, not stored twice.
        assert.deepEqual(await fresh().put(work, null, ics(uid, 'Again'), uid), { remoteId: created.remoteId, etag: changed.etag });
        assert.match((await dav('GET', `${user}/work/${uid}.ics`)).text, /SUMMARY:Second/, 'neither write landed');
        // Another event under the name a uid gives: a conflict, and it stays as it was.
        await putFile(`${user}/work/clash@example.com.ics`, ics('someone-else@example.com', 'Theirs'));
        await assert.rejects(fresh().put(work, null, ics('clash@example.com', 'Mine'), 'clash@example.com'), isCode('conflict'));
        assert.match((await dav('GET', `${user}/work/clash@example.com.ics`)).text, /SUMMARY:Theirs/);

        const odd = 'odd/uid with spaces?#1';
        const made = await fresh().put(work, null, ics(odd, 'Odd'), odd);
        assert.match(made.remoteId, /\/work\/odd-uid-with-spaces-1-[0-9a-f]{24}\.ics$/);
        assert.equal((await dav('GET', new URL(made.remoteId).pathname)).status, 200);
    });

    test('remove refuses a stale etag and takes a resource that is gone as done', async () => {
        const work = { remoteId: `${base}${user}/work/` };
        const item = await fresh().put(work, null, ics('rm-1', 'To remove'), 'rm-1');
        await assert.rejects(fresh().remove(work, { remoteId: item.remoteId, etag: '"stale"' }), isCode('conflict'));
        assert.equal((await dav('GET', `${user}/work/rm-1.ics`)).status, 200);
        await fresh().remove(work, item);
        assert.equal((await dav('GET', `${user}/work/rm-1.ics`)).status, 404);
        await fresh().remove(work, item);
        // Without a stored etag the server's own is read first; Schedule-Reply: F is a header a server without scheduling ignores.
        const again = await fresh().put(work, null, ics('rm-2', 'To remove too'), 'rm-2');
        await fresh().remove(work, { remoteId: again.remoteId }, { scheduleReply: false });
        assert.equal((await dav('GET', `${user}/work/rm-2.ics`)).status, 404);
    });

    test('sync: from nothing, after another client\'s changes, and with a token the server no longer takes', async () => {
        const mixed = { remoteId: `${base}${user}/mixed/` };
        const at = (name) => `${base}${user}/mixed/${name}`;
        await putFile(`${user}/mixed/a.ics`, ics('a', 'Alpha'));
        await putFile(`${user}/mixed/b.ics`, ics('b', 'Beta'));
        await putFile(`${user}/mixed/t.ics`, ics('t', 'A task', 'VTODO'));

        // From nothing: the whole calendar, tasks left out.
        const first = await fresh().sync(mixed, undefined, {});
        assert.equal(first.reset, true);
        assert.deepEqual(first.items.map((i) => i.remoteId).sort(), [at('a.ics'), at('b.ics')]);
        assert.ok(first.items.every((i) => i.etag && i.raw.startsWith('BEGIN:VCALENDAR\r\n') && i.events.length === 0));
        assert.match(first.items.find((i) => i.remoteId === at('a.ics')).raw, /\r\nSUMMARY:Alpha\r\n/);
        assert.match(first.state.token, /\S/);
        assert.deepEqual(Object.keys(first.state.other), ['t.ics']);

        // Another client changes a, deletes b, adds c.
        await putFile(`${user}/mixed/a.ics`, ics('a', 'Alpha moved'));
        assert.equal((await dav('DELETE', `${user}/mixed/b.ics`)).status, 200);
        const cEtag = await putFile(`${user}/mixed/c.ics`, ics('c', 'Gamma'));
        const second = await fresh().sync(mixed, first.state, {});
        assert.equal(second.reset, false);
        assert.deepEqual(second.items.map((i) => i.remoteId).sort(), [at('a.ics'), at('c.ics')]);
        assert.match(second.items.find((i) => i.remoteId === at('a.ics')).raw, /\r\nSUMMARY:Alpha moved\r\n/);
        assert.equal(second.items.find((i) => i.remoteId === at('c.ics')).etag, cEtag);
        assert.deepEqual(second.removed, [at('b.ics')]);
        assert.notEqual(second.state.token, first.state.token);

        // Nothing new: nothing handed over.
        const quiet = await fresh().sync(mixed, second.state, {});
        assert.deepEqual([quiet.reset, quiet.items, quiet.removed], [false, [], []]);

        // A token the server doesn't know: everything listed again with a new token, compared by etag.
        await putFile(`${user}/mixed/c.ics`, ics('c', 'Gamma later'));
        assert.equal((await dav('DELETE', `${user}/mixed/t.ics`)).status, 200);
        const stale = { ...quiet.state, token: 'http://radicale.org/ns/sync/0000000000000000000000000000000000000000000000000000000000000000' };
        const third = await fresh().sync(mixed, stale, {});
        assert.equal(third.reset, false);
        assert.deepEqual(third.items.map((i) => i.remoteId), [at('c.ics')]);
        assert.match(third.items[0].raw, /\r\nSUMMARY:Gamma later\r\n/);
        assert.deepEqual(third.removed, [], 'the task was never handed over');
        assert.equal(third.state.other, undefined);
        assert.notEqual(third.state.token, stale.token);

        // The new token works.
        const last = await fresh().sync(mixed, third.state, {});
        assert.deepEqual([last.reset, last.items, last.removed], [false, [], []]);
        assert.deepEqual(Object.keys(last.state.etags).sort(), ['a.ics', 'c.ics']);
    });

    test('sync and put agree on resource addresses', async () => {
        const work = { remoteId: `${base}${user}/work/` };
        const synced = await fresh().sync(work, undefined, {});
        const ids = synced.items.map((i) => i.remoteId);
        assert.ok(ids.includes(`${base}${user}/work/put-1@example.com.ics`), 'Radicale writes %40, the source one spelling');
        const etags = Object.fromEntries(synced.items.map((i) => [i.remoteId, i.etag]));
        const changed = await fresh().put(work, { remoteId: `${base}${user}/work/put-1@example.com.ics`, etag: etags[`${base}${user}/work/put-1@example.com.ics`] },
            ics('put-1@example.com', 'Fourth'), 'put-1@example.com');
        const next = await fresh().sync(work, synced.state, {});
        assert.deepEqual(next.items.map((i) => [i.remoteId, i.etag]), [[changed.remoteId, changed.etag]]);
    });

    test('the occurrence a "this and following" change starts at, changed alone: the later ones stay as that change set them', async () => {
        const { m, id, done } = await managerOn('ranges', { scheduling: true });
        try {
            const path = `${user}/ranges/weekly.ics`;
            await putFile(path, calendarOf(
                meetingOf('weekly', ['DTSTART:20261020T100000', 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Weekly'], ['ann']),
                // Another app changed it from Oct 27 on: Room B, and gil too. And Nov 3 on its own: later, with hal.
                meetingOf('weekly', ['RECURRENCE-ID;RANGE=THISANDFUTURE:20261027T100000', 'DTSTART:20261027T100000', 'SUMMARY:Weekly B', 'LOCATION:Room B'], ['ann', 'gil']),
                meetingOf('weekly', ['RECURRENCE-ID:20261103T100000', 'DTSTART:20261103T150000', 'SUMMARY:Weekly late'], ['ann', 'hal']),
            ));
            await m.syncCalendar(id, { throwErrors: true });
            const first = m.events({ from: Date.parse('2026-10-27T00:00:00+01:00'), to: Date.parse('2026-10-28T00:00:00+01:00'), calendars: [id] }).occurrences[0];
            assert.deepEqual([first.title, first.location], ['Weekly B', 'Room B']);
            // Who it emails is that occurrence's own people (Radicale's calendar is marked as one whose server emails them).
            assert.deepEqual(m.planChange('update', { id: first.id, input: { location: 'Room C' }, scope: 'one', notify: true }).mail.to, ['ann@example.com', 'gil@example.com']);
            const changed = await m.updateEvent(first.id, { location: 'Room C', notify: true }, 'one');
            assert.deepEqual([changed.title, changed.location, changed.emailed], ['Weekly B', 'Room C', { what: 'an update', to: ['ann@example.com', 'gil@example.com'] }]);
            assert.deepEqual(await heldOn(path, '2026-10-19T00:00:00+02:00', '2026-12-01T00:00:00+01:00'), [
                '2026-10-20T10:00 Weekly @ - with ann',
                '2026-10-27T10:00 Weekly B @ Room C with ann gil',
                '2026-11-03T15:00 Weekly late @ - with ann hal',
                '2026-11-10T10:00 Weekly B @ Room B with ann gil',
                '2026-11-17T10:00 Weekly B @ Room B with ann gil',
                '2026-11-24T10:00 Weekly B @ Room B with ann gil',
            ]);
            // The change from Oct 27 on goes on from the next occurrence without a change of its own.
            assert.deepEqual(await changedOn(path), ['2026-10-27T10:00:00', '2026-11-03T10:00:00', '2026-11-10T10:00:00 and following']);
        } finally {
            done();
        }
    });

    test('the occurrence a "this and following" change starts at, deleted alone: the later ones stay as that change set them', async () => {
        const { m, id, done } = await managerOn('ranges-out', { scheduling: true });
        try {
            const path = `${user}/ranges-out/other.ics`;
            await putFile(path, calendarOf(
                meetingOf('other', ['DTSTART:20261021T100000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Other'], ['ann']),
                meetingOf('other', ['RECURRENCE-ID;RANGE=THISANDFUTURE:20261028T100000', 'DTSTART:20261028T100000', 'SUMMARY:Other B', 'LOCATION:Room B'], ['ann', 'gil']),
            ));
            await m.syncCalendar(id, { throwErrors: true });
            const on = (day) => m.events({ from: Date.parse(`${day}T00:00:00+01:00`), to: Date.parse(`${day}T23:00:00+01:00`), calendars: [id] }).occurrences[0];
            const held = () => heldOn(path, '2026-10-19T00:00:00+02:00', '2026-12-01T00:00:00+01:00');
            assert.deepEqual(m.planChange('delete', { id: on('2026-10-28').id, scope: 'one', notify: true }).mail.to, ['ann@example.com', 'gil@example.com']);
            assert.deepEqual(await m.deleteEvent(on('2026-10-28').id, 'one', 'window', { notify: true }), { emailed: { what: 'a cancellation', to: ['ann@example.com', 'gil@example.com'] } });
            assert.deepEqual(await held(), [
                '2026-10-21T10:00 Other @ - with ann',
                '2026-11-04T10:00 Other B @ Room B with ann gil',
                '2026-11-11T10:00 Other B @ Room B with ann gil',
            ]);
            assert.deepEqual(await changedOn(path), ['2026-11-04T10:00:00 and following']);
            // With the occurrences after it gone, the one that change starts at has none to hand it on to.
            await m.deleteEvent(on('2026-11-11').id, 'one', 'window', { notify: true });
            await m.deleteEvent(on('2026-11-04').id, 'one', 'window', { notify: true });
            assert.deepEqual(await held(), ['2026-10-21T10:00 Other @ - with ann']);
            assert.deepEqual(await changedOn(path), []);
        } finally {
            done();
        }
    });

    test('a server that keeps no tags: a change goes only while the event shows what the plugin read, a delete only while it names the same people', async () => {
        const work = { remoteId: `${base}${user}/work/` };
        const path = `${user}/work/swap.ics`;
        const bare = tagless();
        const source = caldav.create(account(), { ...env, request: (url, init) => request(url, { ...init, fetch: bare.fetch }) });
        // "Swap" as the plugin read it, and the same with lines changed (by property name; [] takes it out) and lines added.
        const read = ['BEGIN:VEVENT', 'UID:swap', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261014T090000Z', 'DTEND:20261014T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=4',
            'SUMMARY:Swap', 'LOCATION:Room 1', 'ORGANIZER:mailto:alice@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com', 'END:VEVENT'];
        const edit = (changes, ...added) => [...read.slice(0, -1).flatMap((line) => changes[/^[A-Z-]+/.exec(line)[0]] ?? [line]), ...added, 'END:VEVENT'];
        await putFile(path, calendarOf(read));
        const item = { remoteId: `${base}${path}`, raw: (await dav('GET', path)).text };
        const renamed = calendarOf(edit({ SUMMARY: ['SUMMARY:Swap!'] }));

        // Changed by another app since: the plugin's whole copy, renamed, would undo it, so nothing is written.
        const moved = ['BEGIN:VEVENT', 'UID:swap', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID:20261021T090000Z', 'DTSTART:20261021T110000Z', 'DTEND:20261021T120000Z',
            'SUMMARY:Swap', 'ORGANIZER:mailto:alice@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com', 'END:VEVENT'];
        const theirs = {
            // Bob takes it over, and alice is a guest: the same people.
            organizer: edit({ ORGANIZER: ['ORGANIZER:mailto:bob@example.com'], ATTENDEE: ['ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@example.com'] }),
            title: edit({ SUMMARY: ['SUMMARY:Swap shifts'] }),
            start: edit({ DTSTART: ['DTSTART:20261014T083000Z'] }),
            end: edit({ DTEND: ['DTEND:20261014T110000Z'] }),
            'all day': edit({ DTSTART: ['DTSTART;VALUE=DATE:20261014'], DTEND: ['DTEND;VALUE=DATE:20261015'] }),
            place: edit({ LOCATION: ['LOCATION:Room 2'] }),
            notes: edit({}, 'DESCRIPTION:Bring the keys'),
            link: edit({}, 'URL:https://example.com/swap'),
            status: edit({}, 'STATUS:TENTATIVE'),
            rule: edit({ RRULE: ['RRULE:FREQ=WEEKLY;COUNT=5'] }),
            'skipped date': edit({}, 'EXDATE:20261021T090000Z'),
            'extra date': edit({}, 'RDATE:20261016T090000Z'),
            'changed occurrence': [read, moved],
        };
        for (const [what, lines] of Object.entries(theirs)) {
            await putFile(path, calendarOf(...(Array.isArray(lines[0]) ? lines : [lines])));
            const there = (await dav('GET', path)).text;
            await assert.rejects(source.put(work, item, renamed, 'swap'),
                (e) => isCode('conflict')(e) && e.message === 'Saving the event: it changed on the server since the plugin read it, so nothing was changed.', what);
            assert.equal((await dav('GET', path)).text, there, what);
        }
        assert.deepEqual(bare.writes, []);

        // Only what a server and the guests set changed (stamps, answers, the rule's order, the organizer's spelling): it goes.
        await putFile(path, calendarOf(edit({
            DTSTAMP: ['DTSTAMP:20261011T080000Z'], RRULE: ['RRULE:COUNT=4;FREQ=WEEKLY'], ORGANIZER: ['ORGANIZER;CN=Alice:MAILTO:Alice@Example.com'],
            ATTENDEE: ['ATTENDEE;PARTSTAT=ACCEPTED;CN=Bob:mailto:bob@example.com'],
        }, 'LAST-MODIFIED:20261011T080000Z', 'CREATED:20261001T000000Z', 'SEQUENCE:2', 'STATUS:CONFIRMED')));
        await source.put(work, item, renamed, 'swap');
        assert.deepEqual(bare.writes, [`PUT /${path} *`]);
        assert.match((await dav('GET', path)).text, /\r\nSUMMARY:Swap!\r\n/);

        // A delete: not while the server names fewer people (or more), as their cancellations would differ; anything else changed, it goes.
        await putFile(path, calendarOf(edit({ ATTENDEE: [] })));
        await assert.rejects(source.remove(work, item), (e) => isCode('conflict')(e) && /^Deleting the event: /.test(e.message));
        assert.equal((await dav('GET', path)).status, 200);
        await putFile(path, calendarOf(edit({ SUMMARY: ['SUMMARY:Swap shifts'] }, 'DESCRIPTION:Bring the keys')));
        await source.remove(work, item);
        assert.deepEqual(bare.writes.slice(1), [`DELETE /${path} -`]);
        assert.equal((await dav('GET', path)).status, 404);
    });

    test('a server that keeps no tags: the manager\'s change, stopped by another app\'s edit, goes again on the event as that app left it', async () => {
        const bare = tagless();
        const { m, id, done } = await managerOn('bare', { fetch: bare.fetch });
        try {
            const path = `${user}/bare/lunch.ics`;
            const lunch = (...lines) => calendarOf(['BEGIN:VEVENT', 'UID:lunch', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261014T100000Z', 'DTEND:20261014T110000Z', ...lines, 'END:VEVENT']);
            await putFile(path, lunch('SUMMARY:Lunch'));
            await m.syncCalendar(id, { throwErrors: true });
            assert.equal(m.store.itemsOf(id)[`${base}${path}`].etag, undefined, 'no tag held');
            const on = () => m.events({ from: Date.parse('2026-10-14T00:00:00Z'), to: Date.parse('2026-10-15T00:00:00Z'), calendars: [id] }).occurrences[0];

            // Renamed in another app; the plugin, not synced since, gives it a place: refused, synced, and made on the new name.
            await putFile(path, lunch('SUMMARY:Team lunch'));
            const changed = await m.updateEvent(on().id, { location: 'Cafe' });
            assert.deepEqual([changed.title, changed.location], ['Team lunch', 'Cafe']);
            assert.deepEqual(bare.writes, [`PUT /${path} *`]);
            assert.deepEqual(readIcs((await dav('GET', path)).text, { zone: ZONE }).events.map((r) => [r.title, r.location]), [['Team lunch', 'Cafe']]);

            // A new time is worked out on the event as it was: stopped by an edit, it says so and isn't tried again.
            await putFile(path, lunch('SUMMARY:Team lunch', 'LOCATION:Cafe', 'DESCRIPTION:Bring the keys'));
            await assert.rejects(m.updateEvent(on().id, { start: '2026-10-14T13:00', end: '2026-10-14T14:00' }), /^CalendarError: The event changed on its server meanwhile/);
            assert.equal(bare.writes.length, 1);
            assert.match((await dav('GET', path)).text, /\r\nDTSTART:20261014T100000Z\r\n/);
        } finally {
            done();
        }
    });
});
