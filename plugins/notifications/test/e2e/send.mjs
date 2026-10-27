#!/usr/bin/env node
/**
 * Send one notification through the notifications plugin in a running DSH
 * (a DSH Test instance, or a DSH started by hand), the way another plugin
 * sends one: through the stand-in caller plugin (test/e2e/caller), which
 * must be loaded beside the notifications plugin. Then it reads the
 * plugin's own list until the notification has an outcome, and prints it.
 *
 *   node plugins/notifications/test/e2e/send.mjs <sign-in link> [--title T] [--body B] [--kind K] [--session ID]
 *
 * The sign-in link is what `dsh-test url` prints. It carries a token: pass
 * it on the command line, never write it into a file. The answer is one of
 * the service's ('browser' = queued for DSH's window, 'none', 'off', …), and
 * the outcome what DSH's window reported ("shown: …", "not shown: …").
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
const link = args.find((a) => /^https?:\/\//.test(a));
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
if (!link) {
    console.error('usage: node plugins/notifications/test/e2e/send.mjs <sign-in link> [--title T] [--body B] [--kind K] [--session ID]');
    process.exit(2);
}
const notification = {
    title: option('title', 'Notifications check from send.mjs'),
    body: option('body', 'If this shows as a banner with DSH\'s icon, the sender works.'),
    ...(option('kind') ? { kind: option('kind') } : {}),
    ...(option('session') ? { sessionId: option('session') } : {}),
};

function request(url, { method = 'GET', headers = {}, body } = {}) {
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = lib.request(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

const signIn = await request(new URL(link));
const cookie = String(signIn.headers['set-cookie']?.[0] ?? '').split(';')[0];
if (!cookie) {
    console.error(`the sign-in link was not taken (HTTP ${signIn.status}); get a fresh one from dsh-test url`);
    process.exit(1);
}
const base = new URL('./', link);
async function call(endpoint, callArgs) {
    const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: callArgs } });
    const res = await request(new URL(`api/${endpoint}`, base), { method: 'POST', headers: { cookie }, body });
    try {
        return JSON.parse(res.text).result ?? { ok: false, error: { message: res.text.slice(0, 200) } };
    } catch {
        return { ok: false, error: { message: `HTTP ${res.status}: ${res.text.slice(0, 200)}` } };
    }
}

const sent = await call('dsh-plugin-notifications-e2e-caller/notify', { notification });
if (!sent.ok) {
    console.error(`the caller did not answer: ${sent.error?.message ?? JSON.stringify(sent)} (is test/e2e/caller loaded?)`);
    process.exit(1);
}
console.log(`answer: ${sent.value}`);
const deadline = Date.now() + 30000;
let entry;
while (Date.now() < deadline) {
    const status = await call('dsh-plugin-notifications/status', {});
    entry = status.ok ? status.value.recent.find((item) => item.title === notification.title) : undefined;
    if (entry && entry.state !== 'waiting') break;
    await new Promise((r) => setTimeout(r, 1000));
}
console.log(entry ? `#${entry.id} ${entry.state}: ${entry.detail}` : 'not in the list');
process.exit(entry && entry.state !== 'failed' ? 0 : 1);
