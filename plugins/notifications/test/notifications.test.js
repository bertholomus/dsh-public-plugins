/**
 * Offline tests for dsh-plugin-notifications: the settings gate, the
 * per-platform backend choice, the queue the browser half takes, the
 * endpoints its client calls, and the coordinator's news wiring. No DSH
 * install and no network; a fake spawn, a fake desktopRuntime and a fake
 * browser stand in for the real senders, so nothing here shows a real
 * notification.
 *
 * Run:  node plugins/notifications/test/notifications.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, EVENT_FIELDS, BROWSER_TTL_MS, MAX_QUEUED } from '../lib/notifier.js';
import { oneLine, cliCommand, cliSend, desktopSend, iconFor } from '../lib/backends.js';
import { NotificationsRemote, SERVICE } from '../lib/remote.js';
import * as plugin from '../lib/index.js';
import { ProjectManager } from '../../coordinator/lib/projects.js';
import { coordinatorNewsLine } from '../../coordinator/lib/index.js';

// The browser half is loaded once, in the module format DSH serves: a window
// with a module loader, then the file. Each test runs the factory again with
// its own fake `require`.
const clientMetas = [];
globalThis.window = { __ModuleLoader__: { load: (meta) => clientMetas.push(meta) } };
await import('../lib/client.js');
delete globalThis.window;
if (clientMetas.length !== 1) throw new Error(`the browser half loaded ${clientMetas.length} times`);
/** @returns the plugin's own test helpers, from a fresh factory run. */
const clientInternals = (requireImpl = () => ({})) => clientMetas[0].factory(requireImpl).internals;

const CONFIG = { enabled: true, notifyHandback: true, notifyFinished: true, notifyApproval: true, notifyFailed: true, notifyStopped: true };

/** A fake cordis context: provide records, inject runs only with every service, like DSH's. */
function fakeCtx(services = {}) {
    const provided = new Map();
    const ctx = {
        provided,
        logger: { info() {}, warn() {} },
        provide(name, value) { provided.set(name, value); return () => provided.delete(name); },
        inject(names, fn) {
            if (!names.every((name) => services[name])) return;
            return fn(Object.assign(Object.create(ctx), Object.fromEntries(names.map((name) => [name, services[name]]))));
        },
        effect(fn) { return fn(); },
    };
    return ctx;
}

test('notifications: one line', () => {
    assert.equal(oneLine('  a\n\nb\tc  '), 'a b c');
    assert.equal(oneLine(undefined), '');
});

test('notifications: the platform command and its quoting', () => {
    assert.deepEqual(cliCommand('darwin', { title: 'He said "hi"', body: 'a\\b' }),
        { command: 'osascript', args: ['-e', 'display notification "a\\\\b" with title "He said \\"hi\\""'] });
    // macOS's osascript has no icon of its own: given one, it is ignored.
    assert.deepEqual(cliCommand('darwin', { title: 'T', body: 'B' }, { path: '/i/whale.png' }),
        { command: 'osascript', args: ['-e', 'display notification "B" with title "T"'] });
    assert.deepEqual(cliCommand('linux', { title: 'T', body: 'B' }),
        { command: 'notify-send', args: ['--app-name=DSH', 'T', 'B'] });
    assert.deepEqual(cliCommand('linux', { title: 'T', body: 'B' }, { path: '/i/whale.svg' }),
        { command: 'notify-send', args: ['--app-name=DSH', '--icon=/i/whale.svg', 'T', 'B'] });
    const win = cliCommand('win32', { title: "it's", body: 'B' });
    assert.equal(win.command, 'powershell.exe');
    assert.match(win.args[3], /CreateTextNode\('it''s'\)/);
    assert.doesNotMatch(win.args[3], /ToastImageAndText02/);
    const winIcon = cliCommand('win32', { title: 'T', body: 'B' }, { path: 'C:\\icons\\whale.png' });
    assert.match(winIcon.args[3], /ToastImageAndText02/);
    assert.match(winIcon.args[3], /file:\/\/\/C:\/icons\/whale\.png/);
    assert.equal(cliCommand('sunos', { title: 'T', body: 'B' }), null);
});

test('notifications: the cli sender reports a missing command, never throws', () => {
    const errors = [];
    const ok = cliSend('darwin', { title: 'T', body: 'B' }, { spawnImpl: () => ({ on() {}, kill() {} }) });
    assert.equal(ok, true);
    const failed = cliSend('linux', { title: 'T', body: 'B' }, { spawnImpl: () => { throw new Error('no notify-send'); }, onError: (e) => errors.push(e) });
    assert.equal(failed, false);
    assert.match(String(errors[0]), /notify-send/);
    assert.equal(cliSend('sunos', { title: 'T', body: 'B' }, {}), false);
});

test('notifications: iconFor picks what each platform can show', () => {
    assert.match(iconFor('linux').path, /icon\.svg$/);
    assert.match(iconFor('win32').path, /icon\.png$/);
    assert.equal(iconFor('darwin'), undefined);
    assert.equal(iconFor('sunos'), undefined);
});

test('notifications: the cli sender hands the icon to the command', () => {
    let seen;
    cliSend('linux', { title: 'T', body: 'B' }, {
        spawnImpl: (command, args) => { seen = { command, args }; return { on() {}, kill() {} }; },
        icon: { path: '/i/whale.svg' },
    });
    assert.deepEqual(seen.args, ['--app-name=DSH', '--icon=/i/whale.svg', 'T', 'B']);
});

test('notifications: the desktop sender is DSH\'s own call shape', () => {
    const seen = [];
    desktopSend({ notifyAttention: (n) => seen.push(n) }, { title: 'T', body: 'B' });
    assert.deepEqual(seen, [{ title: 'T', body: 'B' }]);
});

test('notifications: the settings gate every notification', () => {
    const sent = [];
    const send = () => { sent.push('cli'); return true; };
    const off = new Notifier({ settings: () => ({ ...CONFIG, enabled: false }), send });
    assert.equal(off.notify({ title: 'T', kind: 'handback' }), 'off');
    const perKind = new Notifier({ settings: () => ({ ...CONFIG, notifyApproval: false }), send });
    assert.equal(perKind.notify({ title: 'T', kind: 'approval' }), 'off');
    assert.equal(perKind.notify({ title: 'T', kind: 'handback' }), 'cli');
    // An unknown kind is not gated: the caller's own settings say what it is.
    assert.equal(perKind.notify({ title: 'T' }), 'cli');
    assert.deepEqual(sent, ['cli', 'cli']);
});

test('notifications: the desktop backend wins where DSH provides it', () => {
    const seen = [];
    const notifier = new Notifier({ settings: () => CONFIG, send: () => assert.fail('the cli sender must not run') });
    notifier.desktop = { notifyAttention: (n) => seen.push(n) };
    assert.equal(notifier.notify({ title: 'T', body: 'B' }), 'desktop');
    assert.deepEqual(seen, [{ title: 'T', body: 'B' }]);
    assert.deepEqual(notifier.pending(), { desktop: true, items: [] });
});

test('notifications: the browser queue takes, shows once and clears', () => {
    let clock = 1000;
    const sent = [];
    const notifier = new Notifier({ settings: () => CONFIG, send: () => { sent.push('cli'); return true; }, now: () => clock });
    // No window has polled yet: the command takes it (the browser half is a tab that has not come up).
    assert.equal(notifier.notify({ title: 'T0' }), 'cli');
    notifier.markBrowserSeen();
    assert.equal(notifier.notify({ title: 'T1', body: 'B1' }), 'browser');
    assert.equal(notifier.notify({ title: 'T2', body: 'B2' }), 'browser');
    const pending = notifier.pending();
    assert.equal(pending.desktop, false);
    assert.deepEqual(pending.items.map((item) => [item.title, item.body]), [['T1', 'B1'], ['T2', 'B2']]);
    assert.ok(pending.items.every((item) => typeof item.id === 'number' && typeof item.at === 'string'));
    assert.equal(notifier.acknowledge([pending.items[0].id]), 1);
    assert.deepEqual(notifier.pending().items.map((item) => item.title), ['T2']);
    assert.equal(notifier.acknowledge('nope'), 0);
    // The window must keep polling: after the ttl the command takes over again.
    clock += BROWSER_TTL_MS + 1;
    assert.equal(notifier.notify({ title: 'T3' }), 'cli');
    assert.deepEqual(sent, ['cli', 'cli']);
});

test('notifications: the queue keeps the newest MAX_QUEUED', () => {
    const notifier = new Notifier({ settings: () => CONFIG, send: () => true });
    notifier.markBrowserSeen();
    for (let i = 0; i < MAX_QUEUED + 5; i += 1) notifier.notify({ title: `T${i}` });
    const items = notifier.pending().items;
    assert.equal(items.length, MAX_QUEUED);
    assert.equal(items.at(-1).title, `T${MAX_QUEUED + 4}`);
});

test('notifications: the remote marks the window seen and answers it', async () => {
    const notifier = new Notifier({ settings: () => CONFIG, now: () => 5 });
    const remote = new NotificationsRemote(notifier);
    assert.equal(notifier.lastBrowserSeen, 0);
    const answer = await remote.pending();
    assert.equal(notifier.lastBrowserSeen, 5);
    assert.deepEqual(answer, { desktop: false, items: [] });
    assert.equal(await remote.acknowledge([1, 2]), 0);
});

test('notifications: the host half wires the service, the desktop runtime and the remote', async () => {
    const attention = [];
    const providedThroughGateway = new Map();
    const ctx = fakeCtx({
        desktopRuntime: { notifyAttention: (n) => attention.push(n) },
        typertGateway: { provide: (name, value) => providedThroughGateway.set(name, value) },
    });
    plugin.apply(ctx, CONFIG);
    assert.ok(ctx.provided.has('notifications'), 'the notifications service is provided');
    assert.equal(ctx.provided.get('notifications').notify({ title: 'T', body: 'B', kind: 'handback' }), 'desktop');
    assert.deepEqual(attention, [{ title: 'T', body: 'B' }]);
    const remote = ctx.provided.get(SERVICE);
    assert.ok(remote instanceof NotificationsRemote, 'the gateway serves the remote');
    assert.deepEqual(await remote.pending(), { desktop: true, items: [] });
});

test('notifications: off provides no service, and the service still works without a gateway', () => {
    const off = fakeCtx();
    plugin.apply(off, { ...CONFIG, enabled: false });
    assert.equal(off.provided.has('notifications'), false);
    // With a gateway (so the notifier is reachable) but no desktop runtime and no window:
    // the notifier must go through its send, faked here so no real command runs.
    const plain = fakeCtx({ typertGateway: { provide: (name, value) => plain.provided.set(name, value) } });
    plugin.apply(plain, CONFIG);
    const notifier = plain.provided.get(SERVICE).notifier;
    const sent = [];
    notifier.send = () => { sent.push('cli'); return true; };
    assert.equal(plain.provided.get('notifications').notify({ title: 'T' }), 'cli');
    assert.deepEqual(sent, ['cli']);
});

test('notifications: the coordinator notes its news to the sink, with the thread\'s session', () => {
    const sinks = [];
    const puts = [];
    const manager = {
        store: {
            project: () => ({ news: {} }),
            thread: () => ({ title: 'Fix CI', sessionId: 's9' }),
            putProject: (id, patch) => puts.push(patch),
        },
        log: () => {},
        newsSink: (item) => sinks.push(item),
    };
    ProjectManager.prototype.noteNews.call(manager, 'p1', { kind: 'handback', thread: 't1', status: 'blocked' });
    assert.deepEqual(sinks, [{ seq: 1, kind: 'handback', thread: 't1', title: 'Fix CI', status: 'blocked', at: sinks[0].at, session: 's9', projectId: 'p1' }]);
    assert.equal(puts.length, 1);
    // No sink (the plugin is absent or off): the news is still kept, nothing throws.
    ProjectManager.prototype.noteNews.call({ store: manager.store, log: () => {} }, 'p1', { kind: 'approval', thread: 't1' });
});

test('notifications: the coordinator\'s one line for a news item', () => {
    assert.equal(coordinatorNewsLine({ kind: 'handback', title: 'Fix CI' }), '“Fix CI” handed back');
    assert.equal(coordinatorNewsLine({ kind: 'handback', status: 'blocked', title: 'Fix CI' }), '“Fix CI” is blocked');
    assert.equal(coordinatorNewsLine({ kind: 'handback', status: 'needs_decision', title: 'Fix CI' }), '“Fix CI” needs a decision');
    assert.equal(coordinatorNewsLine({ kind: 'finished', title: 'Fix CI' }), '“Fix CI” ended without a handback');
    assert.equal(coordinatorNewsLine({ kind: 'approval', title: 'Fix CI' }), '“Fix CI” is waiting for approval');
    assert.equal(coordinatorNewsLine({ kind: 'failed', title: 'Fix CI' }), '“Fix CI” failed');
    assert.equal(coordinatorNewsLine({ kind: 'stopped', title: 'Fix CI' }), '“Fix CI” stopped');
});

test('notifications: every news kind is gated by a settings field', () => {
    for (const [kind, field] of Object.entries(EVENT_FIELDS)) assert.match(field, /^notify/);
});

test('notifications: the browser half loads in the module format DSH serves, without throwing', () => {
    const internals = clientInternals((name) => (
        name === 'react' ? { createElement: (type, props, ...children) => ({ type, props, children }) }
            : {
                SettingsForm: 'SettingsForm',
                Switch: 'Switch',
                SettingsFormModel: class {
                    constructor(scope, specs) { this.scope = scope; this.specs = specs; }
                    bind(project) { return { subscribe: () => () => {}, getSnapshot: project }; }
                    shell() { return { writable: true, saving: false }; }
                    field(name) { return { text: this.specs.find((spec) => spec.field === name)?.format(true) ?? 'off', overridden: false, invalid: false }; }
                    actions() { return {}; }
                    dispose() {}
                },
            }
    ));
    assert.deepEqual(internals.FIELDS, ['enabled', 'notifyHandback', 'notifyFinished', 'notifyApproval', 'notifyFailed', 'notifyStopped']);
    assert.deepEqual(internals.boolSpec('enabled').parse('on'), { kind: 'set', value: true });
    assert.deepEqual(internals.boolSpec('enabled').parse('off'), { kind: 'set', value: false });
    assert.equal(internals.boolSpec('enabled').parse('maybe'), undefined);
    assert.equal(internals.boolSpec('enabled').format(false), 'off');
});

test('notifications: the style tag is appended once, under the plugin\'s name', () => {
    const { injectStyle, CSS } = clientInternals();
    const heads = [];
    const styleEl = () => {
        const el = { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
        return el;
    };
    const doc = { querySelector: () => (heads.length > 0 ? heads[0] : null), createElement: styleEl, head: { appendChild: (el) => heads.push(el) } };
    injectStyle(doc);
    injectStyle(doc);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].getAttribute('data-plugin'), 'dsh-plugin-notifications');
    assert.equal(heads[0].getAttribute('data-plugin-css'), 'dsh-plugin-notifications/client.css');
    assert.match(CSS, /body\.wp-still/);
    assert.match(CSS, /prefers-reduced-motion/);
});

test('notifications: the browser sender shows while unfocused, takes the rest, and stands down on the desktop', async () => {
    const { applyPoller } = clientInternals();

    class FakeNotification {
        constructor(title, options) { FakeNotification.shown.push([title, options]); }
        close() {}
    }
    FakeNotification.shown = [];
    FakeNotification.permission = 'granted';

    const doc = { hasFocus: () => false, addEventListener() {}, removeEventListener() {} };
    const disposers = [];
    const scope = { effect(fn) { disposers.push(fn()); } };
    let pendings = 0;
    const items = { desktop: false, items: [{ id: 1, title: 'T1', body: 'B1', at: new Date().toISOString() }, { id: 2, title: 'T2', body: 'B2', at: new Date().toISOString() }] };
    const link = {
        calls: [],
        async call(method, args) {
            this.calls.push([method, args]);
            if (method === 'pending') {
                pendings += 1;
                return pendings === 3 ? { ok: true, value: { desktop: true, items: [] } } : { ok: true, value: { ...items } };
            }
            return { ok: true, value: 1 };
        },
    };
    const poller = applyPoller(scope, link, { Notification: FakeNotification, doc, win: undefined });
    assert.equal(await poller.read(), 2, 'both queue items show while the window is unfocused');
    assert.deepEqual(FakeNotification.shown.map(([title]) => title), ['T1', 'T2']);
    assert.deepEqual(link.calls.map(([method]) => method), ['pending', 'acknowledge']);
    FakeNotification.shown.length = 0;
    doc.hasFocus = () => true;
    link.calls.length = 0;
    await poller.read();
    assert.equal(FakeNotification.shown.length, 0, 'a focused window is watching already');
    assert.deepEqual(link.calls.map(([method]) => method), ['pending', 'acknowledge'], 'it still takes the queue');
    // The desktop answer stands the sender down: the read that learned it was the last call.
    FakeNotification.shown.length = 0;
    link.calls.length = 0;
    await poller.read();
    assert.equal(poller.state.desktopHandled, true);
    assert.deepEqual(link.calls.map(([method]) => method), ['pending']);
    assert.equal(disposers.length, 1);
    disposers[0](); // the interval's cleanup, as DSH runs it
});

test('notifications: the browser sender drops stale items instead of showing them late', async () => {
    const { applyPoller } = clientInternals();
    class FakeNotification {
        constructor(title) { FakeNotification.shown.push(title); }
        close() {}
    }
    FakeNotification.shown = [];
    FakeNotification.permission = 'granted';
    const doc = { hasFocus: () => false, addEventListener() {}, removeEventListener() {} };
    const link = {
        async call(method) {
            return method === 'pending'
                ? { ok: true, value: { desktop: false, items: [{ id: 1, title: 'Old', body: '', at: new Date(Date.now() - 6 * 60_000).toISOString() }] } }
                : { ok: true, value: 0 };
        },
    };
    const disposers = [];
    const poller = applyPoller({ effect(fn) { return disposers.push(fn()); } }, link, { Notification: FakeNotification, doc, win: undefined });
    assert.equal(await poller.read(), 0);
    assert.deepEqual(FakeNotification.shown, []);
    disposers[0](); // the interval's cleanup, as DSH runs it
});
