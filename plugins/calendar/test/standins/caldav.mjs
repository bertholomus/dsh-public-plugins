/**
 * A stand-in CalDAV server on this computer, for the real-DSH test when no
 * Radicale is installed: one user and one calendar, kept in memory. It
 * answers what the plugin asks (lib/sources/caldav.js, RFC 4791 and 6764):
 * discovery from its root (a principal that is its own calendar home), the
 * calendars in that home, a calendar's tag (getctag) and its resources'
 * etags, and GET, PUT and DELETE with If-Match and If-None-Match, a change
 * that doesn't match answering 412. It refuses sync-collection and
 * calendar-multiget (501), as some servers do, so the plugin lists the
 * calendar and fetches each event; Radicale covers those. Basic auth with
 * one password; anything else is 401.
 *
 * @module dsh-plugin-calendar/test/standins/caldav
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"';
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const found = (href, props) => `<d:response><d:href>${escape(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const multistatus = (responses) => `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NS}>${responses.join('')}</d:multistatus>`;

function bodyOf(req) {
    return new Promise((resolve, reject) => {
        let text = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { text += chunk; });
        req.on('end', () => resolve(text));
        req.on('error', reject);
    });
}

/**
 * Start the server on 127.0.0.1 (a free port).
 * @param {{user?: string, password: string, calendar?: string, name?: string}} options
 * @returns {Promise<{base: string, server: {kill: () => void}, files: Map<string, {etag: string, text: string}>, seen: string[]}>}
 *   base: its root; files: the calendar's resources by path; seen: "METHOD path" of each request.
 */
export async function start({ user = 'alice', password, calendar = 'home', name = 'Home' }) {
    const principal = `/${user}/`;
    const collection = `/${user}/${calendar}/`;
    const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    const files = new Map();
    const seen = [];
    let ctag = 1;
    const calendarProps = () => `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${escape(name)}</d:displayname>`
        + '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'
        + '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>'
        + `<cs:getctag>${ctag}</cs:getctag>`;

    const server = createServer(async (req, res) => {
        const body = await bodyOf(req).catch(() => '');
        const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        seen.push(`${req.method} ${path}`);
        const send = (status, text = '', headers = {}) => {
            res.writeHead(status, { 'content-length': Buffer.byteLength(text), ...headers });
            res.end(text);
        };
        const xml = (responses) => send(207, multistatus(responses), { 'content-type': 'application/xml; charset=utf-8' });
        if (req.headers.authorization !== auth) return send(401, 'Who are you?', { 'www-authenticate': 'Basic realm="stand-in"' });
        const depth = String(req.headers.depth ?? '0');

        if (req.method === 'PROPFIND') {
            if (path === '/' || path.startsWith('/.well-known/caldav')) {
                return xml([found(path, `<d:resourcetype><d:collection/></d:resourcetype><d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal>`)]);
            }
            if (path === principal) {
                const self = found(principal, '<d:resourcetype><d:collection/><d:principal/></d:resourcetype>'
                    + `<d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal><c:calendar-home-set><d:href>${principal}</d:href></c:calendar-home-set>`);
                return xml(depth === '0' ? [self] : [self, found(collection, calendarProps())]);
            }
            if (path === collection) {
                const members = [...files].map(([href, file]) => found(href, `<d:resourcetype/><d:getetag>${escape(file.etag)}</d:getetag><d:getcontenttype>text/calendar; charset=utf-8</d:getcontenttype>`));
                return xml(depth === '0' ? [found(collection, calendarProps())] : [found(collection, calendarProps()), ...members]);
            }
            const file = files.get(path);
            return file ? xml([found(path, `<d:getetag>${escape(file.etag)}</d:getetag>`)]) : send(404, 'Not here');
        }
        if (req.method === 'REPORT') return send(501, 'Not done here');
        if (!path.startsWith(collection) || path === collection || !path.endsWith('.ics')) return send(req.method === 'GET' ? 404 : 405, 'Not here');

        const file = files.get(path);
        const ifMatch = req.headers['if-match'];
        if (req.method === 'GET') return file ? send(200, file.text, { 'content-type': 'text/calendar; charset=utf-8', etag: file.etag }) : send(404, 'Not here');
        if (req.method === 'PUT') {
            if (req.headers['if-none-match'] === '*' && file) return send(412, 'It is there already');
            if (ifMatch !== undefined && ifMatch !== file?.etag) return send(412, 'It changed');
            const etag = `"${randomUUID()}"`;
            files.set(path, { etag, text: body });
            ctag += 1;
            return send(file ? 204 : 201, '', { etag });
        }
        if (req.method === 'DELETE') {
            if (!file) return send(404, 'Not here');
            if (ifMatch !== undefined && ifMatch !== file.etag) return send(412, 'It changed');
            files.delete(path);
            ctag += 1;
            return send(204);
        }
        return send(405, 'Not done here');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { base: `http://127.0.0.1:${server.address().port}/`, server: { kill: () => { server.closeAllConnections?.(); server.close(); } }, files, seen };
}
