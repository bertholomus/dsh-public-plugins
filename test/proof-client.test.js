/**
 * Proof's browser half: loaded as DSH loads it, the flag after a turn, the
 * note above a running check's message box, its page (sessions, ledger,
 * export, checks, history) drawn as plain element trees, and its settings
 * form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, LIVE_SETTINGS, SETTING_TITLES, VERIFIER_CHOICES, checkConfig } from '../plugins/proof/lib/config.js';
import { OTHER_NAMES, elementsOf, loadClient, statefulReact, textIn } from './helpers/client.mjs';

const CLIENT = new URL('../plugins/proof/lib/client.js', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const buttons = (tree) => elementsOf(tree).filter((e) => e.type === 'Button' || e.type === 'button');
const button = (tree, label) => buttons(tree).find((e) => textIn(e) === label);
const withAttr = (tree, name) => elementsOf(tree).filter((e) => e.props?.[name] !== undefined);
/** An element as the window has it, to see where the focus goes. */
const focusable = (name, focused) => ({ name, focus() { focused.push(name); } });

const now = Date.now();
const UNSHOWN = { id: '3:0', turn: 3, seq: 40, at: now - 60000, kind: 'deployed', verdict: 'unbacked', text: 'Deployed to staging.', part: 'Deployed to staging.', why: 'No tool ran in this turn, and it was asked for new work, so the runs before it do not show this.', evidence: [] };
const AGAINST = { id: '2:1', turn: 2, seq: 30, at: now - 120000, kind: 'passed', verdict: 'contradicted', text: 'Fixed the parser; all tests pass.', part: 'all tests pass', why: 'The last test run in this turn did not pass: `npm test` exited 0: 4 passed, 1 failed.', evidence: ['`npm test` exited 0: 4 passed, 1 failed'] };
const VIEW = { total: 4, flagged: [AGAINST, UNSHOWN] };
const SESSION = { on: true, flags: true, verifier: 'ask', isCheck: false, checks: [] };

/** DSH's connection as the window has it: answers by method name; anything else never answers (the hub's wait). */
function connect(kit, answers) {
    const calls = [];
    kit.setConnection({ rpc: { call: async (_path, method, payload) => {
        const name = method.replace('dsh-plugin-proof/', '');
        calls.push([name, plain(payload.args)]);
        const answer = answers[name];
        if (answer === undefined) return new Promise(() => {});
        const value = typeof answer === 'function' ? await answer(payload.args) : answer;
        return value?.ok === false ? value : { ok: true, value };
    } } });
    return calls;
}

test('browser half: loads as DSH loads it, adds its entry (order 5), its page, its flag (order 40), its check note (order 17) and one style sheet', () => {
    const heads = [];
    const document = {
        querySelector: () => null,
        createElement: (type) => ({ type, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
        head: { appendChild: (tag) => { heads.push(tag); } },
    };
    const { id, client } = loadClient(CLIENT, { document });
    assert.equal(id, 'dsh-plugin-proof');
    assert.equal(heads.length, 0, 'styles wait for apply');
    const registered = [];
    const opened = [];
    const panels = [];
    const scope = {
        slots: { inject: (_name, fn) => { fn(); }, register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        uiWorkspace: { openSession: (sessionId) => { opened.push(sessionId); } },
        get: (name) => (name === 'layout' ? { selectPanel: (key) => panels.push(key) } : undefined),
        effect: () => {},
    };
    client.apply({ ...scope, inject: (names, fn) => { if (names[0] === 'uiWorkspace') fn(scope); } });
    assert.equal(heads.length, 1);
    assert.equal(heads[0].attributes['data-plugin'], 'dsh-plugin-proof');
    assert.equal(heads[0].attributes['data-plugin-css'], 'dsh-plugin-proof/client.css');
    const css = heads[0].textContent;
    assert.match(css, /\.dshpf-flag\{/);
    assert.match(css, /background:var\(--dsw-alias-bg-layer-1\);border:\.5px solid var\(--dsw-alias-border-l4\);border-radius:var\(--dsw-radius-lg\)/, 'a card in a chat is drawn as DSH draws its own there');
    assert.doesNotMatch(css.split('\n').filter((rule) => rule.startsWith('.dshpf-flag')).join('\n'), /backdrop-filter/, 'no blur in the chat');
    assert.match(css, /font-size:var\(--dsh-content-font-size,14px\)/, 'the claim follows the chat\'s text size');
    assert.match(css, /\.dshpf-flag\[data-proof-flag=verified\] \.dshpf-flag-glyph\{color:var\(--dsw-alias-state-success-primary\)\}/, 'a verified flag is not amber');
    assert.match(css, /\.dshpf-code\{font-family:var\(--ds-font-family-code\);[^}]*background-color:var\(--dsw-alias-markdown-inline-code\)/, 'inline code as DSH draws it');
    assert.match(css, /\.dshpf-log-time\{flex:0 0 8\.5em;width:8\.5em;[^}]*white-space:nowrap;[^}]*font-variant-numeric:tabular-nums/, 'one width for every time in a list');
    assert.match(css, /body\.wp-still/);
    assert.match(css, /prefers-reduced-motion/);
    assert.doesNotMatch(css, /:has\(/);
    assert.doesNotMatch(css, /(^|\})\s*(:root|html|body)\s*\{/m, 'nothing on the page root');
    const entry = registered.find((r) => r.spec.name === 'sidebar.panellist');
    assert.deepEqual(plain(entry.spec), { name: 'sidebar.panellist', id: 'dsh-plugin-proof:page', order: 5, label: 'Proof' });
    const page = registered.find((r) => r.spec.name === 'main');
    assert.equal(page.spec.key, 'dsh-plugin-proof:page');
    const flag = registered.find((r) => r.spec.name === 'conversation.chat.turnTail');
    assert.deepEqual(plain(flag.spec), { name: 'conversation.chat.turnTail', id: 'dsh-plugin-proof:flag', order: 40, label: 'Proof' });
    const dock = registered.find((r) => r.spec.name === 'conversation.input.dock');
    assert.deepEqual(plain(dock.spec), { name: 'conversation.input.dock', id: 'dsh-plugin-proof:check', order: 17, label: 'Proof check' });
    // The views it opens: a session in DSH's workspace, its own page through DSH's layout.
    client.internals.views.openSession('s1');
    client.internals.views.openSession('');
    client.internals.views.openPage();
    assert.deepEqual(opened, ['s1'], 'an empty id opens nothing');
    assert.deepEqual(panels, ['dsh-plugin-proof:page']);
});

test('words: inline code drawn as code, and a check\'s line gives its reason only (its tag gives its state)', () => {
    const { client } = loadClient(CLIENT);
    const { richText, checkWords, CHECK_WORD } = client.internals;
    const parts = richText('`git push origin main` exited 1: rejected (`fetch first`).');
    assert.equal(parts.length, 4);
    assert.deepEqual(plain(parts.filter((p) => typeof p !== 'string').map((p) => [p.type, p.props.className, p.children[0]])), [['code', 'dshpf-code', 'git push origin main'], ['code', 'dshpf-code', 'fetch first']]);
    assert.equal(textIn(parts), 'git push origin main exited 1: rejected (fetch first).');
    assert.equal(richText('No code here.'), 'No code here.');
    assert.equal(richText('A lone ` stays.'), 'A lone ` stays.');
    assert.equal(richText(undefined), '');

    assert.equal(checkWords({ state: 'running', model: 'GLM-5.3 Flash from Local Gateway', effort: 'Low', minutes: 15 }), "In a read-only thread on GLM-5.3 Flash from Local Gateway at low effort, for up to 15 minutes. It waits on the model's answers; on a busy shared gateway a request can wait and be sent again.");
    assert.equal(checkWords({ state: 'running', model: 'm from p', minutes: 1 }), "In a read-only thread on m from p, for up to 1 minute. It waits on the model's answers; on a busy shared gateway a request can wait and be sent again.", 'no effort when the model offers none');
    assert.equal(checkWords({ state: 'queued', reason: '' }), 'It starts when the check before it ends.');
    assert.equal(checkWords({ state: 'queued', reason: 'Waits until 3:40 PM: 12 checks have started in the last hour, the most Proof\'s settings allow.' }), 'Waits until 3:40 PM: 12 checks have started in the last hour, the most Proof\'s settings allow.');
    assert.equal(checkWords({ state: 'failed', reason: 'The independent check was switched off before it started.' }), 'The independent check was switched off before it started.');
    assert.equal(checkWords({ state: 'verified', reason: 'npm test ran: 5 passed' }), 'npm test ran: 5 passed.');
    assert.equal(checkWords({ state: 'unclear', reason: '' }), 'It gave no reason.');
    // Never the state's word again after its tag.
    for (const [state, word] of Object.entries(CHECK_WORD)) {
        const line = checkWords({ state, reason: 'It ended before it answered.', model: 'm', minutes: 5 });
        assert.equal(line.toLowerCase().startsWith(word), false, `${state}: ${line}`);
        assert.doesNotMatch(line, /^(Checking|Could not check|Not checked|Verified|Not verified|Unclear)\b/, state);
    }
});

test('the flag: each turn reads only its own flagged claims; a check thread says what it checks on its first turn', () => {
    const { client } = loadClient(CLIENT);
    const { flagOf, sameFlag, ProofFlag, flagHead } = client.internals;
    assert.deepEqual(plain(flagOf(VIEW, 3)), [plain(UNSHOWN)]);
    assert.deepEqual(plain(flagOf(VIEW, 2)), [plain(AGAINST)]);
    assert.equal(flagOf(VIEW, 1), flagOf(VIEW, 7), 'no claims: the same empty list every time, so the turn does not draw again');
    assert.equal(flagOf(undefined, 1).length, 0);
    assert.equal(flagOf({ flagged: 'x' }, 1).length, 0);
    assert.equal(flagOf(VIEW, Number.NaN).length, 0);
    const check = flagOf({ total: 0, flagged: [], check: true, first: 4 }, 4);
    assert.equal(check.check, true);
    assert.equal(flagOf({ total: 0, flagged: [], check: true, first: 4 }, 5).length, 0);
    assert.equal(flagOf({ total: 0, flagged: [], check: true }, 1).check, true, 'an older view without its first turn: turn 1');
    assert.equal(sameFlag(flagOf(VIEW, 3), flagOf(plain(VIEW), 3)), true, 'a new view with the same claims is the same flag');
    assert.equal(sameFlag(flagOf(VIEW, 3), [{ ...UNSHOWN, verdict: 'contradicted' }]), false);

    // DSH's useProjection with a selector and an equality.
    const asked = [];
    const useProjection = (view) => (key, select, equal) => { asked.push([key, typeof equal]); return select(view); };
    assert.equal(ProofFlag({ turn: { turn: 1 }, sessionId: 's', useProjection: useProjection(VIEW) }), null, 'a turn with no flagged claim draws nothing');
    assert.deepEqual(asked[0], ['proofClaims', 'function']);
    assert.equal(ProofFlag({ turn: { turn: 3 }, sessionId: 's' }), null, 'no projections in this DSH: nothing');
    assert.equal(ProofFlag({ turn: { turn: 3 }, sessionId: 's', useProjection: () => { throw new Error('gone'); } }), null);
    assert.equal(ProofFlag({ turn: { turn: 3 }, sessionId: '', useProjection: useProjection(VIEW) }), null);
    // With claims, it waits for Proof's word on whether flags show before drawing anything.
    assert.equal(ProofFlag({ turn: { turn: 3 }, sessionId: 's', useProjection: useProjection(VIEW) }), null);

    assert.equal(flagHead([UNSHOWN]), 'Nothing in this turn shows this');
    assert.equal(flagHead([AGAINST]), 'This turn\'s own output says otherwise');
    assert.equal(flagHead([UNSHOWN, { ...UNSHOWN, id: '3:1' }]), '2 claims this turn does not show');
    assert.equal(flagHead([UNSHOWN, AGAINST]), '2 claims this turn does not show (1 contradicted)');
    assert.equal(flagHead([AGAINST, { ...AGAINST, id: '2:2' }]), 'This turn\'s own output contradicts 2 claims');
});

test('the flag: one state, from Proof\'s reading and the checks: a check\'s answer heads it, verified is not amber', () => {
    const { client } = loadClient(CLIENT);
    const { flagState } = client.internals;
    const checks = (pairs) => new Map(pairs.map(([id, state]) => [id, { claimId: id, state }]));
    assert.deepEqual(plain(flagState([UNSHOWN], checks([]))), { head: 'Nothing in this turn shows this', flag: 'unbacked', says: '' });
    assert.deepEqual(plain(flagState([AGAINST], checks([]))), { head: 'This turn\'s own output says otherwise', flag: 'contradicted', says: '' });
    assert.deepEqual(plain(flagState([UNSHOWN], checks([['3:0', 'verified']]))), { head: 'Verified by an independent check', flag: 'verified', says: 'verified' });
    assert.deepEqual(plain(flagState([AGAINST], checks([['2:1', 'not-verified']]))), { head: 'Not verified by an independent check', flag: 'not-verified', says: 'not-verified' });
    // A check that gave no answer leaves Proof's reading as the head; its line carries its own tag.
    for (const state of ['queued', 'running', 'unclear', 'failed']) {
        assert.deepEqual(plain(flagState([UNSHOWN], checks([['3:0', state]]))), { head: 'Nothing in this turn shows this', flag: 'unbacked', says: '' }, state);
    }
    const two = [UNSHOWN, { ...UNSHOWN, id: '3:1' }];
    assert.deepEqual(plain(flagState(two, checks([['3:0', 'verified']]))), { head: '1 claim this turn does not show · 1 verified by an independent check', flag: 'unbacked', says: '' });
    assert.deepEqual(plain(flagState(two, checks([['3:0', 'verified'], ['3:1', 'verified']]))), { head: 'An independent check verified all 2 claims', flag: 'verified', says: 'verified' });
    assert.deepEqual(plain(flagState([UNSHOWN, AGAINST], checks([['3:0', 'verified']]))), { head: 'This turn\'s own output contradicts 1 claim · 1 verified by an independent check', flag: 'contradicted', says: '' });
    assert.deepEqual(plain(flagState([UNSHOWN, AGAINST, { ...UNSHOWN, id: '3:2' }], checks([['3:0', 'verified']]))).head, '2 claims this turn does not show (1 contradicted) · 1 verified by an independent check');
});

test('the flag: says which claim and why, checks it on a press, moves the focus to the check, and opens the check and the ledger', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, ProofFlag, views, spotlight } = client.internals;
    let session = SESSION;
    const calls = connect(kit, {
        session: () => session,
        check: ({ claimId }) => (claimId === '9:9' ? { ok: false, error: { code: 'proof/refused', message: 'The independent check is off.' } } : { key: `s#${claimId}`, state: 'queued' }),
    });
    t.after(() => kit.setConnection(undefined));
    const opened = [];
    views.openSession = (id) => opened.push(id);
    views.openPage = () => opened.push('page');
    const useProjection = (key, select) => select(VIEW);
    const flag = mount(ProofFlag, { turn: { turn: 3 }, sessionId: 's', useProjection });
    t.after(() => flag.unmount());
    assert.equal(flag.tree, null, 'nothing until Proof says flags show');
    await settle(5);
    const text = textIn(flag.tree);
    assert.equal(flag.tree.props['aria-label'], 'Proof');
    assert.equal(flag.tree.props['data-proof-flag'], 'unbacked');
    assert.match(flag.tree.props.className, /dshpf-pane dshpf-flag/);
    assert.match(text, /^Proof · Nothing in this turn shows this/);
    assert.match(text, /“Deployed to staging\.”/);
    assert.match(text, /No tool ran in this turn, and it was asked for new work, so the runs before it do not show this\./);
    assert.deepEqual(calls[0], ['session', { sessionId: 's' }]);

    // Check it: the host is asked, the flag reads the session again, and the focus goes to the check's line.
    session = { ...SESSION, checks: [{ key: 's#3:0', claimId: '3:0', state: 'running', model: 'GLM-5.3 Flash from Local Gateway', effort: 'Low', minutes: 15, checkSessionId: 'session-c' }] };
    await button(flag.tree, 'Check it').props.onClick();
    await settle(5);
    assert.deepEqual(calls.find(([m]) => m === 'check'), ['check', { sessionId: 's', claimId: '3:0' }]);
    let line = withAttr(flag.tree, 'data-proof-check')[0];
    assert.equal(line.props['data-proof-check'], 'running');
    assert.equal(line.props.role, 'status');
    assert.equal(line.props.tabIndex, -1, 'it takes the focus without being a tab stop');
    assert.equal(textIn(line), "checkingIn a read-only thread on GLM-5.3 Flash from Local Gateway at low effort, for up to 15 minutes. It waits on the model's answers; on a busy shared gateway a request can wait and be sent again.Open the check");
    const focused = [];
    line.props.ref(focusable('line', focused));
    assert.deepEqual(focused, ['line'], 'the focus goes to the new line, not to the page');
    assert.equal(withAttr(flag.tree, 'data-proof-check')[0].props.ref, undefined, 'once: a later draw leaves the focus where it is');
    assert.equal(button(flag.tree, 'Check it'), undefined, 'no second press while it runs');
    button(line, 'Open the check').props.onClick();
    assert.deepEqual(opened, ['session-c']);

    // NOT VERIFIED: the head says so, the line gives the reason under Proof's reading.
    session = { ...SESSION, checks: [{ key: 's#3:0', claimId: '3:0', state: 'not-verified', reason: 'staging still runs the old image', checkSessionId: 'session-c' }] };
    const answered = mount(ProofFlag, { turn: { turn: 3 }, sessionId: 's', useProjection });
    t.after(() => answered.unmount());
    await settle(5);
    assert.equal(answered.tree.props['data-proof-flag'], 'not-verified');
    assert.match(textIn(answered.tree), /^Proof · Not verified by an independent check“Deployed to staging\.”No tool ran in this turn/);
    line = withAttr(answered.tree, 'data-proof-check')[0];
    assert.equal(textIn(line), 'staging still runs the old image.Open the check', 'the head gives the state: the line only the reason');
    assert.equal(elementsOf(line).find((e) => e.type === 'Tag'), undefined);
    // Check again: the line takes the focus at once; it stays in place while the new check waits and runs.
    const again = button(answered.tree, 'Check again').props.onClick();
    withAttr(answered.tree, 'data-proof-check')[0].props.ref(focusable('line again', focused));
    await again;
    assert.deepEqual(focused, ['line', 'line again']);

    // VERIFIED: the flag is headed verified, and the check's reason takes the place of Proof's reading.
    session = { ...SESSION, checks: [{ key: 's#3:0', claimId: '3:0', state: 'verified', reason: 'The rollout shows `1.4.2` live', checkSessionId: 'session-c' }] };
    const verified = mount(ProofFlag, { turn: { turn: 3 }, sessionId: 's', useProjection });
    t.after(() => verified.unmount());
    await settle(5);
    assert.equal(verified.tree.props['data-proof-flag'], 'verified');
    const shown = textIn(verified.tree);
    assert.match(shown, /^Proof · Verified by an independent check“Deployed to staging\.”The rollout shows 1\.4\.2 live\.Open the check/);
    assert.doesNotMatch(shown, /No tool ran|Nothing in this turn|verified{2}/i);
    assert.deepEqual(elementsOf(verified.tree).filter((e) => e.type === 'code').map(textIn), ['1.4.2']);

    // Open in Proof: its page, on this session.
    button(answered.tree, 'Open in Proof').props.onClick();
    assert.equal(opened.at(-1), 'page');
    assert.equal(spotlight.get().sessionId, 's');
    assert.equal(spotlight.get().claimId, '3:0');
});

test('the flag: a contradiction says once what the turn showed, as code; refusals say why and take the focus; off, a check thread or no checks draw less', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, ProofFlag } = client.internals;
    let session = { ...SESSION, verifier: 'off' };
    connect(kit, {
        session: () => session,
        check: { ok: false, error: { code: 'proof/refused', message: 'The independent check is off. Turn it on in Proof\'s settings ("Independent check").' } },
    });
    t.after(() => kit.setConnection(undefined));
    const against = mount(ProofFlag, { turn: { turn: 2 }, sessionId: 's', useProjection: (key, select) => select(VIEW) });
    t.after(() => against.unmount());
    await settle(5);
    assert.equal(against.tree.props['data-proof-flag'], 'contradicted');
    const text = textIn(against.tree);
    assert.match(text, /^Proof · This turn's own output says otherwise/);
    assert.match(text, /The last test run in this turn did not pass: npm test exited 0: 4 passed, 1 failed\./);
    assert.doesNotMatch(text, /What the turn shows/, 'its why gives the run already');
    assert.doesNotMatch(text, /`/, 'no Markdown backquotes where people read');
    const code = elementsOf(against.tree).filter((e) => e.type === 'code');
    assert.deepEqual(code.map(textIn), ['npm test']);
    assert.equal(code[0].props.className, 'dshpf-code');
    assert.equal(button(against.tree, 'Check it'), undefined, 'the check is off: no Check');
    // Evidence the why does not give is shown once.
    const other = { ...AGAINST, why: 'The deploy log says otherwise.', evidence: ['`kubectl rollout status` exited 1'] };
    const more = mount(ProofFlag, { turn: { turn: 2 }, sessionId: 's', useProjection: (key, select) => select({ total: 1, flagged: [other] }) });
    t.after(() => more.unmount());
    await settle(5);
    assert.match(textIn(more.tree), /The deploy log says otherwise\.What the turn shows: kubectl rollout status exited 1/);

    session = { ...SESSION };
    const on = mount(ProofFlag, { turn: { turn: 2 }, sessionId: 's', useProjection: (key, select) => select(VIEW) });
    t.after(() => on.unmount());
    await settle(5);
    await button(on.tree, 'Check it').props.onClick();
    await settle(5);
    const alert = elementsOf(on.tree).find((e) => e.props?.role === 'alert');
    assert.equal(textIn(alert), 'Not checked: The independent check is off. Turn it on in Proof\'s settings ("Independent check").');
    const focused = [];
    alert.props.ref(focusable('alert', focused));
    assert.deepEqual(focused, ['alert'], 'what went wrong takes the focus');

    for (const quiet of [{ ...SESSION, flags: false }, { ...SESSION, isCheck: true }]) {
        session = quiet;
        const view = mount(ProofFlag, { turn: { turn: 3 }, sessionId: 's', useProjection: (key, select) => select(VIEW) });
        await settle(5);
        assert.equal(view.tree, null, JSON.stringify(quiet));
        view.unmount();
    }
});

test('a check thread: its first turn says what it checks and how it ended, with no way into itself; while it runs, a note above its message box says so', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, ProofFlag, CheckDock, views } = client.internals;
    let checkOf = { sessionId: 's', turn: 3, claim: 'Deployed to staging.', state: 'verified', reason: 'The rollout shows 1.4.2 live.', model: 'm', title: 'Release' };
    connect(kit, { session: () => ({ ...SESSION, isCheck: true, checkOf }) });
    t.after(() => kit.setConnection(undefined));
    const opened = [];
    views.openSession = (id) => opened.push(id);
    const view = { total: 0, flagged: [], check: true, first: 1 };
    const useProjection = (key, select) => select(view);
    const note = mount(ProofFlag, { turn: { turn: 1 }, sessionId: 'session-c', useProjection });
    t.after(() => note.unmount());
    await settle(5);
    assert.equal(note.tree.props['data-proof-flag'], 'check');
    const text = textIn(note.tree);
    assert.match(text, /^Proof · An independent check/);
    assert.match(text, /This thread checks “Deployed to staging\.” from turn 3 of “Release”\. It can read and run commands, but nothing it runs can write a file\./);
    assert.match(text, /verifiedThe rollout shows 1\.4\.2 live\.Open the checked session$/);
    assert.equal(button(note.tree, 'Open the check'), undefined, 'not inside the check itself');
    button(note.tree, 'Open the checked session').props.onClick();
    assert.deepEqual(opened, ['s']);
    // Later turns of the thread: nothing.
    assert.equal(ProofFlag({ turn: { turn: 2 }, sessionId: 'session-c', useProjection }), null);

    // Stopped at its limit: the minutes it was given, and nothing about opening itself.
    checkOf = { ...checkOf, state: 'unclear', reason: 'It took longer than the 20 minutes it was given, so Proof stopped it.', minutes: 20 };
    const stopped = mount(ProofFlag, { turn: { turn: 1 }, sessionId: 'session-c', useProjection });
    t.after(() => stopped.unmount());
    await settle(5);
    assert.match(textIn(stopped.tree), /unclearIt took longer than the 20 minutes it was given, so Proof stopped it\.Open the checked session$/);

    // While it waits or runs, above the message box: what it checks.
    checkOf = { ...checkOf, state: 'running', reason: '', model: 'GLM-5.3 Flash from Local Gateway', minutes: 15 };
    const dock = mount(CheckDock, { sessionId: 'session-c', useProjection });
    t.after(() => dock.unmount());
    await settle(5);
    assert.equal(dock.tree.props['data-proof-dock'], 'running');
    assert.match(dock.tree.props.className, /^dshpf-dock dshpf-pane$/);
    assert.equal(elementsOf(dock.tree).find((e) => e.props?.className === 'dshpf-dock-bar').props.role, 'status');
    assert.equal(textIn(dock.tree), 'Proof checkThis thread checks “Deployed to staging.” from turn 3 of “Release”. It can read and run commands, but nothing it runs can write a file.checkingOpen the checked session');
    button(dock.tree, 'Open the checked session').props.onClick();
    assert.deepEqual(opened, ['s', 's']);
    checkOf = { ...checkOf, state: 'queued' };
    const waiting = mount(CheckDock, { sessionId: 'session-c', useProjection });
    t.after(() => waiting.unmount());
    await settle(5);
    assert.match(textIn(waiting.tree), /waiting to checkOpen the checked session$/);
    // Once it ends, the note after its turn says how: nothing above the box.
    checkOf = { ...checkOf, state: 'verified', reason: 'The rollout shows 1.4.2 live.' };
    const ended = mount(CheckDock, { sessionId: 'session-c', useProjection });
    t.after(() => ended.unmount());
    await settle(5);
    assert.equal(ended.tree, null);
    // Any other session, or a DSH without projections: nothing, and nothing asked of Proof.
    assert.equal(CheckDock({ sessionId: 's', useProjection: (key, select) => select(VIEW) }), null);
    assert.equal(CheckDock({ sessionId: 's' }), null);
    assert.equal(CheckDock({ sessionId: 's', useProjection: () => { throw new Error('gone'); } }), null);
    assert.equal(CheckDock({ sessionId: '', useProjection }), null);
});

const RUNNING = { key: 's#2:0', sessionId: 's', claimId: '2:0', turn: 2, claim: 'Fixed the date parser.', state: 'running', reason: '', by: 'auto', model: 'GLM-5.3 Flash from Local Gateway', minutes: 15, checkSessionId: 'session-d', queuedAt: now - 15000, startedAt: now - 10000, title: 'Release' };
const VERIFIED = { key: 's#3:0', sessionId: 's', claimId: '3:0', turn: 3, claim: 'Deployed to staging.', state: 'verified', reason: 'The rollout shows 1.4.2 live.', by: 'you', model: 'm', checkSessionId: 'session-c', queuedAt: now - 50000, startedAt: now - 40000, endedAt: now - 20000, title: 'Release' };
const NEVER_RAN = { key: 'gone#1:0', sessionId: 'gone', claimId: '1:0', turn: 1, claim: 'Shipped.', state: 'failed', reason: 'The independent check was switched off before it started.', by: 'you', model: 'm', queuedAt: now - 70000, endedAt: now - 60000 };
const PAGE_STATE = {
    enabled: true,
    flags: true,
    verifier: { mode: 'ask', provider: 'local-gateway', model: 'glm-5.3-flash', providerName: 'Local Gateway', modelName: 'GLM-5.3 Flash', minutes: 15, perHour: 12, used: 1, nextAt: 0 },
    sessions: [
        { sessionId: 's', title: 'Release', cwd: '/w', updatedAt: now - 30000, running: false, total: 4, flagged: 2, contradicted: 2, verified: 1, latest: { id: '2:1', turn: 2, verdict: 'contradicted', text: 'Fixed the parser; all `npm test` runs pass.' } },
        { sessionId: 'q', title: '', cwd: '/w', updatedAt: now - 90000, running: true, total: 2, flagged: 0, contradicted: 0, verified: 0 },
        { sessionId: 'v', title: 'Hotfix', cwd: '/w', updatedAt: now - 120000, running: false, total: 1, flagged: 0, contradicted: 0, verified: 1 },
    ],
    checks: [RUNNING, VERIFIED, NEVER_RAN],
    history: [
        { id: 'h2', at: now - 20000, kind: 'check', sessionId: 's', title: 'Release', text: 'Verified: “Deployed to staging.”', why: 'The rollout shows `1.4.2` live.' },
        { id: 'h1', at: now - 50000, kind: 'settings', text: 'Settings saved: "Independent check"', why: 'It applies now.' },
    ],
};
const LEDGER = {
    session: { id: 's', title: 'Release', cwd: '/w' },
    isCheck: false,
    counts: { total: 4, backed: 1, verified: 1, unbacked: 0, contradicted: 2, flagged: 2 },
    claims: [
        { id: '1:0', turn: 1, at: now - 300000, kind: 'passed', verdict: 'backed', text: 'All 5 tests pass.', why: '', evidence: ['`npm test` exited 0: 5 passed, 0 failed'], ran: ['`npm test` exited 0: 5 passed, 0 failed'], ask: 'Run the tests.' },
        { ...AGAINST, id: '2:0', kind: 'fixed', ran: ['src/date.js changed', '`npm test` exited 0: 4 passed, 1 failed'], ask: 'Fix the date parser.' },
        { ...AGAINST, ran: ['src/date.js changed', '`npm test` exited 0: 4 passed, 1 failed'], ask: 'Fix the date parser.' },
        { ...UNSHOWN, ran: [], ask: 'Now deploy it.', check: VERIFIED },
    ],
};

test('the page: the header, the sessions, a ledger with its claims (verified counted apart), and checks in time order that open their threads', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, ProofPage, views, spotlight } = client.internals;
    let ledgerNow = LEDGER;
    const calls = connect(kit, {
        state: PAGE_STATE,
        ledger: ({ sessionId }) => (sessionId === 's' ? ledgerNow : { session: { id: sessionId, title: '', cwd: '' }, isCheck: false, counts: { total: 2, backed: 2, verified: 0, unbacked: 0, contradicted: 0, flagged: 0 }, claims: LEDGER.claims.slice(0, 1).map((c) => ({ ...c, id: `${sessionId}-${c.id}` })) }),
        check: { key: 's#2:1', state: 'queued' },
    });
    t.after(() => kit.setConnection(undefined));
    const opened = [];
    views.openSession = (id) => opened.push(id);
    const page = mount(ProofPage, {});
    t.after(() => page.unmount());
    assert.match(textIn(page.tree), /Reading the claims/);
    await settle(5);
    const header = withAttr(page.tree, 'data-proof-header')[0];
    assert.match(textIn(header), /3 sessions with claims · 2 claims flagged · 2 verified by an independent check/);
    assert.match(textIn(header), /Flags are on: a turn whose claim nothing in it shows gets a short card after it\./);
    assert.doesNotMatch(textIn(header), /read-only thread/, 'how checks run is said once, on Independent checks');
    const rows = withAttr(page.tree, 'data-proof-session');
    assert.deepEqual(rows.map((r) => r.props['data-proof-session']), ['s', 'q', 'v']);
    assert.equal(rows[0].props['aria-current'], 'true', 'the newest session with a flagged claim is open first');
    assert.match(textIn(rows[0]), /Release4 claims · latest flagged: “Fixed the parser; all npm test runs pass\.”contradicted/);
    assert.match(textIn(rows[1]), /Untitled session2 claimsshown/);
    assert.match(textIn(rows[2]), /Hotfix1 claimverified/, 'a session whose only flagged claim was verified');
    // One Tab stop for the list: the open session's row; the arrows, Home and End move between rows.
    assert.deepEqual(rows.map((r) => r.props.tabIndex), [0, -1, -1]);
    const list = withAttr(page.tree, 'aria-label').find((n) => /^Sessions with claims: up and down arrows/.test(n.props['aria-label']));
    assert.ok(list, 'the sessions list says how to move in it');
    const fake = rows.map(() => ({ tabIndex: -1, focused: false, focus() { this.focused = true; } }));
    const press = (key, at) => list.props.onKeyDown({ key, target: fake[at], currentTarget: { querySelectorAll: () => fake }, preventDefault() {} });
    press('ArrowDown', 0);
    assert.deepEqual(fake.map((f) => [f.tabIndex, f.focused]), [[-1, false], [0, true], [-1, false]]);
    press('End', 1);
    assert.deepEqual(fake.map((f) => f.tabIndex), [-1, -1, 0]);
    press('ArrowDown', 2);
    assert.deepEqual(fake.map((f) => f.tabIndex), [-1, -1, 0], 'the last row stays the stop');
    press('Home', 2);
    assert.deepEqual(fake.map((f) => f.tabIndex), [0, -1, -1]);

    // The ledger: open flagged claims first, newest at the top, each with why, evidence and what its turn ran.
    const ledger = () => withAttr(page.tree, 'data-proof-ledger')[0];
    assert.equal(ledger().props['data-proof-ledger'], 's');
    assert.match(textIn(ledger()), /^Ledger: Release4 claims: 1 shown by their turn, 1 verified by an independent check, 0 with no evidence, 2 contradicted\./);
    let claims = withAttr(ledger(), 'data-proof-verdict');
    assert.deepEqual(claims.map((c) => c.props['data-proof-claim']), ['2:0', '2:1'], 'flagged and not verified, the newest turn first, its claims in reply order');
    assert.match(textIn(claims[0]), /^Turn 2/);
    assert.doesNotMatch(textIn(ledger()), /· (passed|fixed|deployed|done)/, 'no claim kind beside the tag');
    assert.match(textIn(claims[0]), /did not pass: npm test exited 0: 4 passed, 1 failed\./);
    assert.doesNotMatch(textIn(claims[0]), /What the turn shows/, 'the why gives it already');
    assert.match(textIn(claims[0]), /What the turn ran \(2\)/);
    // All claims: the verified and the shown one too.
    const filter = elementsOf(ledger()).find((e) => e.type === 'SegmentedControl');
    assert.deepEqual(plain(filter.props.options.map((o) => o.label)), ['Flagged (2)', 'All claims (4)']);
    elementsOf(ledger()).find((e) => e.props?.['data-suite-choice']).props.onClickCapture({ target: { closest: () => ({ id: `${filter.props.id}-all` }) } });
    await settle(5);
    claims = withAttr(ledger(), 'data-proof-verdict');
    assert.deepEqual(claims.map((c) => c.props['data-proof-claim']), ['3:0', '2:0', '2:1', '1:0']);
    assert.deepEqual(claims.map((c) => c.props['data-proof-state']), ['verified', 'contradicted', 'contradicted', 'shown']);
    const verifiedRow = textIn(claims[0]);
    assert.match(verifiedRow, /“Deployed to staging\.”The rollout shows 1\.4\.2 live\.Open the checkverifiedCheck again$/, 'one tag: verified; the line gives the reason');
    assert.doesNotMatch(verifiedRow, /No tool ran/, 'the check\'s reason takes the place of Proof\'s reading');
    assert.match(textIn(claims[3]), /Shown by: npm test exited 0: 5 passed, 0 failed/);
    assert.equal(button(claims[3], 'Check'), undefined, 'a shown claim has nothing to check');

    // Check from the ledger: nothing said twice; the focus goes to the claim's new check line.
    ledgerNow = { ...LEDGER, claims: LEDGER.claims.map((c) => (c.id === '2:1' ? { ...c, check: { key: 's#2:1', claimId: '2:1', state: 'queued', reason: '' } } : c)) };
    await button(claims[2], 'Check').props.onClick();
    await settle(5);
    assert.deepEqual(calls.find(([m]) => m === 'check'), ['check', { sessionId: 's', claimId: '2:1' }]);
    const said = withAttr(ledger(), 'data-proof-said')[0];
    assert.equal(said.props.role, 'status');
    assert.equal(textIn(said), '', 'the check\'s line says it');
    const line = withAttr(withAttr(ledger(), 'data-proof-verdict')[2], 'data-proof-check')[0];
    assert.equal(textIn(line), 'waiting to checkIt starts when the check before it ends.');
    const focused = [];
    line.props.ref(focusable('line', focused));
    assert.deepEqual(focused, ['line']);

    // In the flagged view, a claim checked there stays when its check verifies it (the answer shows where Check was
    // pressed, and the focus stays on it); choosing the view again leaves only the claims still flagged.
    const choose = (value) => elementsOf(ledger()).find((e) => e.props?.['data-suite-choice']).props.onClickCapture({ target: { closest: () => ({ id: `${filter.props.id}-${value}` }) } });
    choose('flagged');
    await settle(5);
    assert.deepEqual(withAttr(ledger(), 'data-proof-verdict').map((c) => c.props['data-proof-claim']), ['2:0', '2:1']);
    ledgerNow = {
        ...LEDGER,
        counts: { ...LEDGER.counts, verified: 2, contradicted: 1, flagged: 1 },
        claims: ledgerNow.claims.map((c) => (c.id === '2:0' ? { ...c, check: { key: 's#2:0', claimId: '2:0', state: 'verified', reason: 'It passes now.', checkSessionId: 'session-e' } } : c)),
    };
    await button(withAttr(ledger(), 'data-proof-verdict')[0], 'Check').props.onClick();
    await settle(5);
    claims = withAttr(ledger(), 'data-proof-verdict');
    assert.deepEqual(claims.map((c) => c.props['data-proof-claim']), ['2:0', '2:1'], 'the verified claim stays in view');
    assert.equal(claims[0].props['data-proof-state'], 'verified');
    assert.match(textIn(claims[0]), /It passes now\.Open the checkverifiedCheck again$/);
    assert.deepEqual(plain(elementsOf(ledger()).find((e) => e.type === 'SegmentedControl').props.options.map((o) => o.label)), ['Flagged (1)', 'All claims (4)']);
    choose('all');
    await settle(5);
    choose('flagged');
    await settle(5);
    assert.deepEqual(withAttr(ledger(), 'data-proof-verdict').map((c) => c.props['data-proof-claim']), ['2:1'], 'chosen again: only the flagged one');

    // Independent checks: how they run (said once, here), newest first by the time each row shows, in one column.
    const checks = withAttr(page.tree, 'data-proof-checks')[0];
    assert.equal(checks.props['data-proof-verifier'], 'ask');
    assert.match(textIn(checks), /^Independent checksA flagged claim is checked when you press Check: a fresh read-only thread on GLM-5\.3 Flash from Local Gateway, for at most 15 minutes\. 1 of 12 this hour\./);
    const checkRows = withAttr(checks, 'data-proof-check-row');
    assert.deepEqual(checkRows.map((r) => r.props['data-proof-check-row']), ['running', 'verified', 'failed']);
    assert.deepEqual(checkRows.map((r) => elementsOf(r).find((e) => e.type === 'time').props.dateTime),
        [RUNNING.startedAt, VERIFIED.endedAt, NEVER_RAN.endedAt].map((at) => new Date(at).toISOString()), 'the time shown is the one they are ordered by');
    for (const row of checkRows) assert.equal(row.children[0].props.className, 'dshpf-log-time');
    assert.match(textIn(checkRows[0]), /“Fixed the date parser\.”Turn 2 of Release · checked by itselfIn a read-only thread on GLM-5\.3 Flash from Local Gateway, for up to 15 minutes\. It waits on the model's answers; on a busy shared gateway a request can wait and be sent again\.Open the checkchecking$/);
    assert.match(textIn(checkRows[1]), /“Deployed to staging\.”Turn 3 of Release · you askedThe rollout shows 1\.4\.2 live\.Open the checkverified$/);
    assert.match(textIn(checkRows[2]), /“Shipped\.”Turn 1 of a session · you askedThe independent check was switched off before it started\.could not check$/);
    button(checks, 'Open the check').props.onClick();
    button(checks, 'Release').props.onClick();
    assert.deepEqual(opened, ['session-d', 's']);
    // What happened: each entry names its session once, its inline code as code.
    const history = withAttr(page.tree, 'data-proof-history')[0];
    assert.match(textIn(history), /Release · Verified: “Deployed to staging\.”The rollout shows 1\.4\.2 live\./);
    assert.match(textIn(history), /Settings saved: "Independent check"It applies now\./);
    assert.deepEqual(elementsOf(history).filter((e) => e.type === 'code').map(textIn), ['1.4.2']);

    // Another session, and a flag's Open in Proof.
    rows[1].props.onClick();
    await settle(5);
    assert.equal(ledger().props['data-proof-ledger'], 'q');
    spotlight.set({ sessionId: 's', claimId: '3:0', n: 1 });
    page.update({});
    await settle(5);
    assert.equal(ledger().props['data-proof-ledger'], 's');
});

test('the page: exports download the host\'s file, Copy puts Markdown on the clipboard and is logged as a copy, and failures say so and take the focus', async (t) => {
    const { react, mount } = statefulReact();
    const clicks = [];
    const document = { createElement: (type) => ({ type, click() { clicks.push({ type, href: this.href, download: this.download, rel: this.rel }); } }) };
    const copied = [];
    const navigator = { clipboard: { writeText: async (text) => { copied.push(text); } } };
    const { client } = loadClient(CLIENT, { react, globals: { document, navigator, Blob } });
    const { kit, LedgerCard } = client.internals;
    const files = { md: { name: 'proof-ledger-release-2026-10-17.md', type: 'text/markdown', text: '# Claims ledger: Release\n' }, csv: { name: 'proof-ledger-release-2026-10-17.csv', type: 'text/csv', text: 'session\r\n' } };
    const calls = connect(kit, {
        ledger: LEDGER,
        exportLedger: ({ format }) => files[format] ?? { ok: false, error: { code: 'proof/refused', message: 'Export as Markdown, CSV or JSON.' } },
        copied: { ok: true },
    });
    t.after(() => kit.setConnection(undefined));
    const card = mount(LedgerCard, { sessionId: 's', verifier: 'ask', row: undefined });
    t.after(() => card.unmount());
    await settle(5);
    const said = () => withAttr(card.tree, 'data-proof-said')[0];
    await button(card.tree, 'Markdown').props.onClick();
    await settle(5);
    assert.deepEqual(calls.filter(([m]) => m === 'exportLedger'), [['exportLedger', { sessionId: 's', format: 'md' }]]);
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].download, 'proof-ledger-release-2026-10-17.md');
    assert.match(clicks[0].href, /^blob:/);
    assert.equal(textIn(said()), 'Downloaded proof-ledger-release-2026-10-17.md.');
    assert.equal(said().props.ref, undefined, 'news that went well leaves the focus where it is');
    await button(card.tree, 'CSV').props.onClick();
    await settle(5);
    assert.equal(clicks.at(-1).download, 'proof-ledger-release-2026-10-17.csv');
    await button(card.tree, 'JSON').props.onClick();
    await settle(5);
    assert.equal(said().props.role, 'alert');
    assert.equal(textIn(said()), 'Not exported: Export as Markdown, CSV or JSON.');
    const focused = [];
    said().props.ref(focusable('said', focused));
    assert.deepEqual(focused, ['said'], 'what went wrong takes the focus');
    await button(card.tree, 'Copy').props.onClick();
    await settle(5);
    assert.deepEqual(copied, ['# Claims ledger: Release\n']);
    assert.equal(textIn(said()), 'Copied the ledger as Markdown.');
    assert.deepEqual(calls.slice(-2), [['exportLedger', { sessionId: 's', format: 'md', copy: true }], ['copied', { sessionId: 's', claims: 4 }]],
        'a copy is logged as a copy, once it is on the clipboard');

    // A window without a clipboard: it says so, and what to do instead; nothing is logged.
    const { react: r2, mount: m2 } = statefulReact();
    const bare = loadClient(CLIENT, { react: r2 }).client;
    const calls2 = connect(bare.internals.kit, { ledger: LEDGER, exportLedger: files.md, copied: { ok: true } });
    const other = m2(bare.internals.LedgerCard, { sessionId: 's', verifier: 'ask' });
    t.after(() => { other.unmount(); bare.internals.kit.setConnection(undefined); });
    await settle(5);
    await button(other.tree, 'Copy').props.onClick();
    await settle(5);
    assert.equal(textIn(withAttr(other.tree, 'data-proof-said')[0]), 'Not copied: this window may not use the clipboard. Download it as Markdown instead.');
    assert.equal(calls2.some(([m]) => m === 'copied'), false);
    await button(other.tree, 'Markdown').props.onClick();
    await settle(5);
    assert.match(textIn(withAttr(other.tree, 'data-proof-said')[0]), /^Not exported: this window could not save the file \(/);
});

test('the page: empty, switched off, a wrong setting, the check off, and Proof not running each say what to do', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, ProofPage, TEXT } = client.internals;
    const asked = [];
    kit.setNavigation({ openBundle: (name) => asked.push(name) });
    t.after(() => kit.setNavigation(undefined));
    let state = { ...PAGE_STATE, sessions: [], checks: [], history: [], verifier: { ...PAGE_STATE.verifier, mode: 'off' } };
    connect(kit, { state: () => state });
    t.after(() => kit.setConnection(undefined));
    const empty = mount(ProofPage, {});
    t.after(() => empty.unmount());
    await settle(5);
    let text = textIn(empty.tree);
    assert.match(text, new RegExp(`${TEXT.noSessions}${TEXT.noSessionsText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(text, /The independent check is off\./);
    assert.match(text, /The independent check is offTurn it on in Proof's settings to have a fresh read-only thread on a local model re-run or re-read a flagged claim's evidence\./);
    assert.ok(button(empty.tree, 'Open Proof\'s settings'), 'a way to its settings');
    assert.match(text, /Nothing yetChecks you ask for, exports and setting changes show here\./);
    assert.equal(withAttr(empty.tree, 'data-proof-ledger').length, 0, 'no ledger without a session');

    // The check off with checks made before: they stay listed, and the way to turn it on is there too.
    state = { ...PAGE_STATE, verifier: { ...PAGE_STATE.verifier, mode: 'off' } };
    const offWithChecks = mount(ProofPage, {});
    t.after(() => offWithChecks.unmount());
    await settle(5);
    const card = withAttr(offWithChecks.tree, 'data-proof-checks')[0];
    assert.equal(card.props['data-proof-verifier'], 'off');
    assert.equal(withAttr(card, 'data-proof-check-row').length, 3);
    button(card, 'Open Proof\'s settings').props.onClick();
    assert.deepEqual(asked, ['dsh-plugin-proof']);

    state = { ...PAGE_STATE, enabled: false, sessions: [] };
    const off = mount(ProofPage, {});
    t.after(() => off.unmount());
    await settle(5);
    text = textIn(off.tree);
    assert.match(text, /Proof is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\), so it reads no claims\./);
    assert.equal(withAttr(off.tree, 'data-proof-sessions').length, 0);

    state = { ...PAGE_STATE, problem: { key: 'verifierMinutes', text: 'Minutes a check may take (verifierMinutes) must be a whole number of minutes from 1 to 60 (it is 0)', live: true } };
    const wrong = mount(ProofPage, {});
    t.after(() => wrong.unmount());
    await settle(5);
    text = textIn(wrong.tree);
    assert.match(text, /Proof is waiting for a setting to be fixed\./);
    assert.match(text, /\(it is 0\)\.Change it in Proof's settings in Plugins\. Proof starts working again as soon as you save\./);
    assert.ok(button(wrong.tree, 'Open Proof\'s settings'));
    assert.equal(withAttr(wrong.tree, 'data-proof-history').length, 1, 'what happened still shows');

    const { react: r2, mount: m2 } = statefulReact();
    const down = loadClient(CLIENT, { react: r2 }).client;
    down.internals.kit.setConnection({ rpc: { call: async () => { throw new Error('404 Not Found'); } } });
    const gone = m2(down.internals.ProofPage, {});
    t.after(() => { gone.unmount(); down.internals.kit.setConnection(undefined); });
    await settle(5);
    text = textIn(gone.tree);
    assert.match(text, /Proof is not running\./);
    assert.match(text, /Open Proof in Plugins and switch it off and on again/);
    assert.doesNotMatch(text, /Session Watch/, 'Proof needs nothing else');
});

test('the page: a number or true/false in quotes is saved without them through DSH\'s own settings call, in one press, and the page says so after', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, ProofPage, views, QuotedFix } = client.internals;
    const problem = { key: 'verifierMinutes', text: 'Minutes a check may take (verifierMinutes) must be a whole number of minutes from 1 to 60 (it is "45")', live: true, unquoted: 45 };
    let state = { ...PAGE_STATE, problem };
    connect(kit, { state: () => state, ledger: () => LEDGER });
    t.after(() => kit.setConnection(undefined));
    const writes = [];
    let accept = false;
    views.settings = {
        set: async (field, value) => {
            writes.push([field, value]);
            if (accept) state = { ...PAGE_STATE };
            return accept;
        },
    };
    t.after(() => { views.settings = undefined; });
    const page = mount(ProofPage, {});
    t.after(() => page.unmount());
    await settle(5);
    assert.match(textIn(page.tree), /Without the quotes it is right: Proof can save it as 45 for you, as the settings form would\.Save it as 45/);
    // DSH does not take it: the page says so, and the setting is as it was.
    button(page.tree, 'Save it as 45').props.onClick();
    await settle(10);
    assert.deepEqual(writes, [['verifierMinutes', 45]], 'the number, not the text');
    assert.match(textIn(page.tree), /DSH did not save it\. Change it in Proof's settings in Plugins instead\./);
    // DSH takes it: the page comes back working and says what was saved, as a status line.
    accept = true;
    button(page.tree, 'Save it as 45').props.onClick();
    await settle(20);
    assert.deepEqual(writes, [['verifierMinutes', 45], ['verifierMinutes', 45]]);
    const fixed = withAttr(page.tree, 'data-proof-fixed')[0];
    assert.equal(textIn(fixed), 'Saved “Minutes a check may take” as 45, without quotes. Proof works again.');
    assert.equal(fixed.props.role, 'status');
    assert.equal(withAttr(page.tree, 'data-proof-header')[0].props['data-proof-header'], 'on');
    // A switch in quotes: saved as true or false.
    const { react: r2, mount: m2 } = statefulReact();
    const second = loadClient(CLIENT, { react: r2 }).client.internals;
    connect(second.kit, { state: () => ({ ...PAGE_STATE, problem: { key: 'flags', text: 'Flag claims with no evidence on their turn (flags) must be true or false (it is "false")', live: true, unquoted: false } }) });
    const saved = [];
    second.views.settings = { set: async (field, value) => { saved.push([field, value]); return true; } };
    const switchPage = m2(second.ProofPage, {});
    t.after(() => { switchPage.unmount(); second.kit.setConnection(undefined); });
    await settle(5);
    button(switchPage.tree, 'Save it as off').props.onClick();
    await settle(10);
    assert.deepEqual(saved, [['flags', false]]);
    // Not offered: a value wrong without quotes too, a setting of the profile only, or a DSH without the call.
    views.settings = { set: async () => true };
    assert.equal(QuotedFix({ problem: { ...problem, unquoted: undefined }, onSaved: () => {} }), null);
    assert.equal(QuotedFix({ problem: { ...problem, live: false }, onSaved: () => {} }), null);
    views.settings = undefined;
    assert.equal(QuotedFix({ problem, onSaved: () => {} }), null);
});

test('words: a check the person switched off is not in the error colour; a running check says what it waits on; the check bar wraps a long claim', () => {
    const { client } = loadClient(CLIENT);
    const { CHECK_WORD, TONE, CSS } = client.internals;
    assert.equal(CHECK_WORD.cancelled, 'stopped');
    assert.equal(TONE[CHECK_WORD.cancelled], 'neutral');
    assert.equal(TONE[CHECK_WORD.failed], 'danger');
    const dock = CSS.find((rule) => rule.includes('-dock-text{'));
    assert.match(dock, /white-space:normal/);
    assert.doesNotMatch(dock, /text-overflow:ellipsis/);
});

test('settings in Plugins: the form has every live setting, takes what the config takes, says what a busy gateway needs, and saves through DSH', async () => {
    const { client } = loadClient(CLIENT);
    const { SETTINGS, TEXT, CSS, SETTINGS_NOTE, SETTINGS_SUMMARY } = client.internals;
    assert.deepEqual(plain(SETTINGS.map((f) => f.name).sort()), [...LIVE_SETTINGS].sort());
    for (const f of SETTINGS) {
        assert.equal(f.title, SETTING_TITLES[f.name], `${f.name}: the form and the config use the same words`);
        assert.deepEqual(plain(f.default), plain(DEFAULTS[f.name]), `${f.name}: the form's default is the config's`);
        if (f.kind === 'choice') {
            assert.deepEqual(plain(f.options.map((o) => [o.value, o.label])), Object.entries(VERIFIER_CHOICES));
            for (const o of f.options) assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: o.value }));
        }
        if (f.kind === 'number') {
            assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: f.min }), f.name);
            assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: f.max }), f.name);
            assert.throws(() => checkConfig({ ...DEFAULTS, [f.name]: f.min - 1 }), f.name);
            assert.throws(() => checkConfig({ ...DEFAULTS, [f.name]: f.max + 1 }), f.name);
            assert.match(f.hint, new RegExp(`^From ${f.min} to ${f.max}\\.`), `${f.name}: the hint gives the range the config takes`);
        }
        if (f.kind === 'text') {
            for (const value of ['local-gateway', 'glm-5.3-flash', 'org/model@v2', 'a:b+c']) {
                assert.equal(f.accepts(value), true, value);
                assert.doesNotThrow(() => checkConfig({ ...DEFAULTS, [f.name]: value }));
            }
            for (const value of ['-dash', 'two words', 'x'.repeat(121), 'a\nb']) {
                assert.equal(f.accepts(value), false, value);
                assert.throws(() => checkConfig({ ...DEFAULTS, [f.name]: value }));
            }
        }
    }
    const minutes = SETTINGS.find((f) => f.name === 'verifierMinutes');
    assert.deepEqual([minutes.default, minutes.min, minutes.max], [45, 1, 60]);
    assert.match(minutes.hint, /a busy shared gateway can take half an hour to answer one check: allow 60 then\./);
    assert.match(SETTINGS.find((f) => f.name === 'verifierModel').hint, /low effort/);
    assert.doesNotMatch(JSON.stringify(TEXT) + CSS.join('') + JSON.stringify(SETTINGS) + SETTINGS_NOTE + SETTINGS_SUMMARY, OTHER_NAMES);

    // Drawn through DSH's own settings form while DSH serves Proof's settings.
    const models = [];
    class SettingsFormModel {
        constructor(scope, specs) { this.scope = scope; this.specs = specs; models.push(this); }
        bind(project) { const value = project(); return { subscribe: () => () => {}, getSnapshot: () => value, set() {} }; }
        shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }; }
        field(name) { const spec = this.specs.find((s) => s.field === name); return { text: spec.format(this.scope.getSnapshot().value[name]), overridden: false, invalid: false }; }
        actions() { return { edit() {}, resetField() {}, save() {}, discard() {} }; }
        dispose() { this.disposed = true; }
    }
    const { client: formClient } = loadClient(CLIENT, { ui: { SettingsFormModel, SettingsForm: (props) => ({ type: 'SettingsForm', props, children: props.children }) } });
    const registered = [];
    const served = [];
    const effects = [];
    const scope = {
        configForms: {
            get: (entry) => ({ entry, getSnapshot: () => ({ status: 'ready', writable: true, value: { ...DEFAULTS } }), subscribe: () => () => {} }),
            whileServed: (entries, fn) => { served.push(entries); return fn(); },
        },
        slots: { inject: (_name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
        effect: (fn) => { effects.push(fn); },
        inject: (names, fn) => { if (names[0] === 'configForms') fn(scope); },
    };
    formClient.apply(scope);
    for (const fn of effects) fn();
    await settle();
    assert.deepEqual(plain(served), [['proof']]);
    assert.equal(models[0].scope.entry, 'proof');
    assert.deepEqual(plain(models[0].specs.map((s) => s.field).sort()), [...LIVE_SETTINGS].sort());
    const entry = registered.find((item) => item.spec.name === 'plugins.bundle.config');
    assert.equal(entry.spec.key, 'dsh-plugin-proof');
    assert.equal(entry.component({ view: 'summary' }), SETTINGS_SUMMARY);
    const page = textIn(entry.component({}));
    assert.match(page, /Independent check/);
    assert.match(page, /never write a file/);
});
