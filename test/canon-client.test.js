/**
 * Canon's browser half: loaded as DSH loads it, the card after a turn that
 * got notes, its page (the vault, the try-out, the sessions with their
 * switches, the drafts with Promote, what happened) drawn as plain element
 * trees, and its settings form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_CHOICES, DEFAULTS, LIVE_SETTINGS, SETTING_TITLES, checkConfig } from '../plugins/canon/lib/config.js';
import { OTHER_NAMES, elementsOf, loadClient, statefulReact, textIn } from './helpers/client.mjs';

const CLIENT = new URL('../plugins/canon/lib/client.js', import.meta.url);
const HOME = '/Users/someone';
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const buttons = (tree) => elementsOf(tree).filter((e) => e.type === 'Button' || e.type === 'button');
const button = (tree, label) => buttons(tree).find((e) => textIn(e) === label);
const withAttr = (tree, name) => elementsOf(tree).filter((e) => e.props?.[name] !== undefined);

const now = Date.now();
const NOTES = [{ path: 'Projects/harbor-gateway/Gateway ports.md', title: 'Gateway ports' }, { path: 'Home.md', title: 'Canon vault' }];
const VIEW = { count: 2, last: { turn: 3, at: now - 60000, notes: NOTES } };
const SETTINGS = { vault: `${HOME}/Canon`, access: 'read-only', draftsFolder: 'Drafts', promote: false, promoteFolder: '', recall: true, maxNotes: 3, maxChars: 2000 };
const VAULT = { state: 'ok', readAt: now - 30000, took: 5, truncated: false, changed: 0, path: `${HOME}/Canon`, display: '~/Canon', draftsFolder: 'Drafts', counts: { notes: 10, active: 6, drafts: 2, other: 2, unreadable: 0 }, reading: false };
const DRAFT = { path: 'Drafts/2026-10-01 Gateway timeouts.md', title: 'Gateway timeouts', kind: 'gotcha', status: 'draft', created: now - 3600000, sessionId: 's', turn: 4, folder: '/work/Projects/harbor-gateway', preview: 'The harbor gateway drops idle connections after 60 seconds.', sessionTitle: 'Gateway work' };
const PAGE_STATE = {
    enabled: true,
    settings: SETTINGS,
    vault: VAULT,
    sessions: [
        { sessionId: 's', at: now - 60000, count: 2, recalls: [{ turn: 3, at: now - 60000, notes: NOTES }], off: false, title: 'Gateway work' },
        { sessionId: 'q', at: now - 120000, count: 0, recalls: [], off: true, title: '' },
    ],
    drafts: [DRAFT],
    history: [
        { id: 'h1', at: now - 5000, kind: 'capture', state: 'done', sessionId: 's', text: 'Draft saved: “Gateway timeouts”', why: 'A gotcha note in Drafts/2026-10-01 Gateway timeouts.md. It waits for a person to promote it.' },
        { id: 'h2', at: now - 9000, kind: 'promote', state: 'refused', text: 'Not promoted', why: 'Drafts/x.md: Promoting is off' },
    ],
};
const TRY = {
    terms: ['port', 'harbor', 'gateway', 'listen'],
    folder: { repo: 'harbor-gateway', parent: '' },
    results: [{ path: 'Projects/harbor-gateway/Gateway ports.md', title: 'Gateway ports', score: 15.3, matched: ['port', 'harbor', 'gateway', 'listen'], folder: 'repo', passage: 'Gateway ports: The harbor gateway listens on port 8443.' }],
    others: [{ path: 'Projects/tide-ledger/Ledger backups.md', title: 'Ledger backups', score: 2.9, matched: ['port', 'listen'], words: ['port', 'listen'], folder: '', fits: true, why: 'less' }, { path: 'People/Glossary.md', title: 'Glossary', score: 1.2, matched: ['zone'], words: ['zone'], folder: '', fits: false, why: 'few' }],
    block: { text: 'Background from the canon vault: shared long-term notes.\n\n[1] Projects/harbor-gateway/Gateway ports.md\n> Gateway ports: The harbor gateway listens on port 8443.', chars: 140, summary: '1 note from the canon vault: Gateway ports' },
    place: '~/Projects/harbor-gateway',
};

/** DSH's connection as the window has it: answers by method name; anything else never answers (the hub's wait). */
function connect(kit, answers) {
    const calls = [];
    kit.setConnection({ rpc: { call: async (_path, method, payload) => {
        const name = method.replace('dsh-plugin-canon/', '');
        calls.push([name, plain(payload.args)]);
        const answer = answers[name];
        if (answer === undefined) return new Promise(() => {});
        const value = typeof answer === 'function' ? await answer(payload.args) : answer;
        return value?.ok === false ? value : { ok: true, value };
    } } });
    return calls;
}
const refused = (message) => ({ ok: false, error: { code: 'canon/refused', message } });

test('browser half: loads as DSH loads it, adds its entry (order 8), its page, its card (order 45) and one style sheet', () => {
    const heads = [];
    const document = {
        querySelector: () => null,
        createElement: (type) => ({ type, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
        head: { appendChild: (tag) => { heads.push(tag); } },
    };
    const { id, client } = loadClient(CLIENT, { document });
    assert.equal(id, 'dsh-plugin-canon');
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
    assert.equal(heads[0].attributes['data-plugin'], 'dsh-plugin-canon');
    assert.equal(heads[0].attributes['data-plugin-css'], 'dsh-plugin-canon/client.css');
    const css = heads[0].textContent;
    assert.match(css, /\.dshcn-turn\{/);
    assert.match(css, /background:var\(--dsw-alias-bg-layer-1\);border:\.5px solid var\(--dsw-alias-border-l4\);border-radius:var\(--dsw-radius-lg\)/, 'a card in a chat is drawn as DSH draws its own there');
    assert.doesNotMatch(css.split('\n').filter((rule) => rule.startsWith('.dshcn-turn')).join('\n'), /backdrop-filter/, 'no blur in the chat');
    assert.match(css, /font-size:var\(--dsh-content-font-size,14px\)/, 'the notes follow the chat\'s text size');
    assert.match(css, /body\.wp-still/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /prefers-reduced-transparency/);
    assert.doesNotMatch(css, /:has\(/);
    assert.doesNotMatch(css, /(^|\})\s*(:root|html|body)\s*\{/m, 'nothing on the page root');
    for (const rule of client.internals.CSS) assert.match(rule, /^(\.dshcn-|@media)/, `every rule is Canon's own: ${rule.slice(0, 60)}`);
    const entry = registered.find((r) => r.spec.name === 'sidebar.panellist');
    assert.deepEqual(plain(entry.spec), { name: 'sidebar.panellist', id: 'dsh-plugin-canon:page', order: 8, label: 'Canon' });
    const page = registered.find((r) => r.spec.name === 'main');
    assert.equal(page.spec.key, 'dsh-plugin-canon:page');
    const card = registered.find((r) => r.spec.name === 'conversation.chat.turnTail');
    assert.deepEqual(plain(card.spec), { name: 'conversation.chat.turnTail', id: 'dsh-plugin-canon:card', order: 45, label: 'Canon' });
    // The views it opens: a session in DSH's workspace, its own page through DSH's layout.
    client.internals.views.openSession('s1');
    client.internals.views.openSession('');
    client.internals.views.openPage();
    assert.deepEqual(opened, ['s1'], 'an empty id opens nothing');
    assert.deepEqual(panels, ['dsh-plugin-canon:page']);
    const icon = client.internals.CanonIcon({});
    assert.equal(icon.props['data-canon-icon'], '');
});

test('the card: only the session\'s latest turn that got notes has one; the same empty list elsewhere', () => {
    const { client } = loadClient(CLIENT);
    const { notesOf, sameNotes, CanonTurn } = client.internals;
    assert.deepEqual(plain(notesOf(VIEW, 3)), NOTES);
    assert.equal(notesOf(VIEW, 2), notesOf(VIEW, 4), 'no notes: the same empty list every time, so the turn does not draw again');
    assert.equal(notesOf(undefined, 3).length, 0);
    assert.equal(notesOf({ count: 1, last: null }, 3).length, 0);
    assert.equal(notesOf({ count: 1, last: { turn: 3, notes: [{ title: 'no path' }] } }, 3).length, 0);
    assert.equal(notesOf(VIEW, Number.NaN).length, 0);
    assert.equal(sameNotes(notesOf(VIEW, 3), notesOf(plain(VIEW), 3)), true, 'a new view with the same notes is the same card');
    assert.equal(sameNotes(notesOf(VIEW, 3), [NOTES[0]]), false);
    const asked = [];
    const useProjection = (view) => (key, select, equal) => { asked.push([key, typeof equal]); return select(view); };
    assert.equal(CanonTurn({ turn: { turn: 2 }, sessionId: 's', useProjection: useProjection(VIEW) }), null, 'a turn that got no notes draws nothing');
    assert.deepEqual(asked[0], ['canonRecall', 'function']);
    assert.equal(CanonTurn({ turn: { turn: 3 }, sessionId: 's' }), null, 'no projections in this DSH: nothing');
    assert.equal(CanonTurn({ turn: { turn: 3 }, sessionId: 's', useProjection: () => { throw new Error('gone'); } }), null);
    assert.equal(CanonTurn({ turn: { turn: 3 }, sessionId: '', useProjection: useProjection(VIEW) }), null);
});

test('the card: names the notes and their folders, turns the session off and back on, and says when a change failed', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, CanonTurn, views } = client.internals;
    let session = { on: true, off: false, why: '', access: 'read-only' };
    let fail = false;
    const calls = connect(kit, {
        session: () => session,
        setSession: ({ on }) => {
            if (fail) return refused('Canon is waiting for a setting to be fixed: see the top of its page.');
            session = { ...session, off: !on };
            return { sessionId: 's', off: !on, changed: true };
        },
    });
    t.after(() => kit.setConnection(undefined));
    const opened = [];
    views.openPage = () => opened.push('page');
    const useProjection = (_key, select) => select(VIEW);
    const card = mount(CanonTurn, { turn: { turn: 3 }, sessionId: 's', useProjection });
    t.after(() => card.unmount());
    assert.equal(card.tree.props['aria-label'], 'Canon');
    assert.match(card.tree.props.className, /dshcn-pane dshcn-turn/);
    assert.equal(button(card.tree, 'Turn off for this session'), undefined, 'the switch waits for the session\'s state');
    await settle(5);
    let text = textIn(card.tree);
    assert.match(text, /^Canon · 2 notes from the canon vault added to this turn/);
    assert.match(text, /Gateway ports · in Projects\/harbor-gateway/);
    assert.match(text, /Canon vault · at the vault's top level/);
    assert.deepEqual(withAttr(card.tree, 'data-canon-note').map((e) => e.props['data-canon-note']), NOTES.map((n) => n.path));
    assert.equal(card.tree.props['data-canon-turn'], 'on');
    // The session's state is said in one live line that is there from the start.
    const statusOf = (tree) => elementsOf(tree).find((e) => e.props?.role === 'status');
    assert.equal(textIn(statusOf(card.tree)), '');
    assert.equal(statusOf(card.tree).props.className, 'dshcn-sr');
    const before = button(card.tree, 'Turn off for this session');
    assert.equal(before.props.disabled, undefined, 'never disabled: the focus stays on it');
    await before.props.onClick();
    await settle(5);
    assert.deepEqual(calls.find(([m]) => m === 'setSession'), ['setSession', { sessionId: 's', on: false }]);
    text = textIn(card.tree);
    assert.equal(card.tree.props['data-canon-turn'], 'off');
    assert.match(text, /Turned off for this session: its later turns get no notes\./);
    assert.equal(textIn(statusOf(card.tree)), 'Turned off for this session: its later turns get no notes.');
    assert.ok(button(card.tree, 'Turn back on'));
    assert.equal(button(card.tree, 'Turn back on').props.key, before.props.key, 'the same button, with its new words, keeps the focus');
    fail = true;
    await button(card.tree, 'Turn back on').props.onClick();
    await settle(5);
    const alert = elementsOf(card.tree).find((e) => e.props?.role === 'alert');
    assert.equal(textIn(alert), 'Not changed: Canon is waiting for a setting to be fixed: see the top of its page.');
    button(card.tree, 'Open Canon').props.onClick();
    assert.deepEqual(opened, ['page']);
    // Recall off in Canon's settings: the card says why no later turn gets notes.
    session = { on: false, off: false, why: 'Adding notes to turns is off in Canon\'s settings.', access: 'read-only' };
    const quiet = mount(CanonTurn, { turn: { turn: 3 }, sessionId: 's', useProjection });
    t.after(() => quiet.unmount());
    await settle(5);
    assert.match(textIn(quiet.tree), /Adding notes to turns is off in Canon's settings\./);
});

test('the page: the vault, the try-out, the sessions with their switches, the drafts with Promote, and what happened', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, CanonPage, views } = client.internals;
    kit.setNavigation({ openBundle: () => {} });
    t.after(() => kit.setNavigation(undefined));
    let state = PAGE_STATE;
    let promoteAnswer = refused('Not promoted: promoting is off (“Allow promoting drafts” in Canon\'s settings). Turn it on to promote drafts; until then Promote changes nothing.');
    const calls = connect(kit, {
        state: () => state,
        search: ({ text }) => (text.includes('thanks') ? { terms: [], folder: { repo: '', parent: '' }, results: [], others: [], block: null } : TRY),
        setSession: ({ sessionId, on }) => ({ sessionId, off: !on, changed: true }),
        promote: () => promoteAnswer,
        refresh: () => VAULT,
    });
    t.after(() => kit.setConnection(undefined));
    const opened = [];
    views.openSession = (id) => opened.push(id);
    const page = mount(CanonPage, {});
    t.after(() => page.unmount());
    assert.match(textIn(page.tree), /Reading Canon/);
    await settle(5);
    const header = withAttr(page.tree, 'data-canon-header')[0];
    assert.equal(header.props['data-canon-header'], 'ok');
    let text = textIn(header);
    assert.match(text, /The vault ~\/Canon holds 6 active notes and 2 drafts\./);
    assert.match(text, /Read just now\./);
    assert.match(text, /2 notes with another status \(archived, draft and the like\) are never added\./);
    assert.match(text, /Read only: Canon writes nothing to the vault\./);
    assert.match(text, /A turn that starts from your prompt gets at most 3 notes and 2,000 characters\./);
    await button(header, 'Read again').props.onClick();
    await settle(5);
    assert.ok(calls.some(([m]) => m === 'refresh'));

    // The try-out: what a prompt would get, why, the near misses, and the exact block.
    const tryCard = () => withAttr(page.tree, 'data-canon-try')[0];
    elementsOf(tryCard()).find((e) => e.props?.['data-canon-try-prompt'] !== undefined).props.onChange({ target: { value: 'What port does the harbor gateway listen on?' } });
    elementsOf(tryCard()).find((e) => e.props?.['data-canon-try-folder'] !== undefined).props.onChange({ target: { value: ' ~/Projects/harbor-gateway ' } });
    await button(tryCard(), 'Try it').props.onClick();
    await settle(5);
    assert.deepEqual(calls.find(([m]) => m === 'search'), ['search', { text: 'What port does the harbor gateway listen on?', folder: '~/Projects/harbor-gateway' }]);
    text = textIn(tryCard());
    assert.match(text, /For a session in ~\/Projects\/harbor-gateway\.A turn with this prompt gets 1 note/, 'it says the folder it used');
    assert.match(text, /Gateway portsProjects\/harbor-gateway\/Gateway ports\.mdShares the words “port”, “harbor”, “gateway” and “listen”\. It belongs to this folder's project, so it counts for more\./);
    assert.match(text, /this project/);
    assert.match(text, /The exact text the turn gets \(140 characters\)/);
    assert.match(text, /Close, but not addedLedger backupsIt fits less well than the notes above, or too little to add\.GlossaryToo little in common: one word besides a project's name, and not in its title, tags, aliases, path or headings\./);
    assert.equal(withAttr(tryCard(), 'data-canon-block')[0].children.join(''), TRY.block.text);
    // A prompt with nothing to search for, and an empty one.
    elementsOf(tryCard()).find((e) => e.props?.['data-canon-try-prompt'] !== undefined).props.onChange({ target: { value: 'thanks, looks good' } });
    await button(tryCard(), 'Try it').props.onClick();
    await settle(5);
    assert.match(textIn(tryCard()), /Nothing to search forThat prompt has no words Canon searches for/);
    elementsOf(tryCard()).find((e) => e.props?.['data-canon-try-prompt'] !== undefined).props.onChange({ target: { value: '   ' } });
    await button(tryCard(), 'Try it').props.onClick();
    await settle(5);
    assert.match(textIn(tryCard()), /Type a prompt to try\./);

    // The sessions that got notes, each with its switch.
    const sessions = withAttr(page.tree, 'data-canon-session');
    assert.deepEqual(sessions.map((r) => [r.props['data-canon-session'], r.props['data-canon-session-off']]), [['s', 'false'], ['q', 'true']]);
    assert.match(textIn(sessions[0]), /Gateway workTurn 3: Gateway ports and Canon vault · 1 min ago2 turns got notes\./);
    assert.match(textIn(sessions[1]), /Untitled sessionNo notes added yet\./);
    const toggle = elementsOf(sessions[0]).find((e) => e.type === 'Switch');
    assert.equal(toggle.props.checked, true);
    assert.equal(toggle.props.label, 'Add notes to Gateway work', 'each switch is named for its session');
    assert.equal(elementsOf(sessions[1]).find((e) => e.type === 'Switch').props.label, 'Add notes to Untitled session');
    assert.equal(toggle.props.disabled, undefined, 'never disabled: the focus stays on it');
    await toggle.props.onChange(false);
    await settle(5);
    assert.deepEqual(calls.find(([m]) => m === 'setSession'), ['setSession', { sessionId: 's', on: false }]);
    assert.match(textIn(withAttr(page.tree, 'data-canon-sessions')[0]), /“Gateway work” gets no notes from now on\./);
    button(sessions[0], 'Gateway work').props.onClick();
    assert.deepEqual(opened, ['s']);

    // The drafts: Promote with promoting off changes nothing and says why; allowed, it says what it did.
    const drafts = () => withAttr(page.tree, 'data-canon-drafts')[0];
    assert.equal(drafts().props['data-canon-promote'], 'off');
    text = textIn(drafts());
    assert.match(text, /^DraftsThe notes in the drafts folder, Drafts\. Canon is read only, so agents save none there, and none is ever added to a turn\./);
    assert.match(text, /Promoting is off while Canon is read only: Promote changes nothing\./);
    assert.match(text, /Gateway timeouts/);
    assert.match(text, /Saved 1 h ago from Gateway work, turn 4 · Drafts\/2026-10-01 Gateway timeouts\.md/);
    assert.match(text, /gotcha/);
    const draftRow = withAttr(drafts(), 'data-canon-draft')[0];
    assert.equal(button(draftRow, 'Promote').props['aria-label'], 'Promote Gateway timeouts');
    assert.equal(button(draftRow, 'Promote').props.disabled, undefined);
    await button(draftRow, 'Promote').props.onClick();
    await settle(5);
    assert.deepEqual(calls.find(([m]) => m === 'promote'), ['promote', { path: DRAFT.path }]);
    let said = withAttr(drafts(), 'data-canon-said')[0];
    assert.equal(said.props['data-canon-said'], 'refused');
    assert.equal(said.props.role, 'alert');
    assert.equal(said.props.tabIndex, -1, 'the refusal takes the focus');
    assert.match(textIn(said), /^Not promoted: promoting is off/);
    promoteAnswer = { ok: true, from: DRAFT.path, path: 'Gateway timeouts.md' };
    await button(withAttr(drafts(), 'data-canon-draft')[0], 'Promote').props.onClick();
    await settle(5);
    said = withAttr(drafts(), 'data-canon-said')[0];
    assert.equal(said.props['data-canon-said'], 'done');
    assert.equal(textIn(said), 'Promoted “Gateway timeouts”: it is now an active note, Gateway timeouts.md, and turns can get it.');
    assert.equal(said.props.tabIndex, -1, 'the promoted draft\'s row goes: the focus goes to what Promote did');
    assert.equal(said.props.role, 'status');

    // What happened: newest first, refusals marked.
    text = textIn(withAttr(page.tree, 'data-canon-history')[0]);
    assert.match(text, /Gateway work · Draft saved: “Gateway timeouts”A gotcha note in Drafts\/2026-10-01 Gateway timeouts\.md\. It waits for a person to promote it\./);
    assert.match(text, /Not promotedDrafts\/x\.md: Promoting is off\.not changed/);
    // Past 30 entries, "Show all": it goes, and the focus moves to the first entry it brought into view.
    const many = Array.from({ length: 35 }, (_, i) => ({ id: `e${i}`, at: now - i * 1000, kind: 'session', state: 'done', text: `Entry ${i + 1}` }));
    const long = mount(client.internals.HistoryCard, { data: { history: many }, titles: new Map() });
    t.after(() => long.unmount());
    assert.equal(withAttr(long.tree, 'data-canon-entry').length, 30);
    button(long.tree, 'Show all 35').props.onClick();
    const entries = withAttr(long.tree, 'data-canon-entry');
    assert.equal(entries.length, 35);
    assert.equal(button(long.tree, 'Show all 35'), undefined);
    assert.deepEqual([entries[30].props.tabIndex, typeof entries[30].props.ref, entries.filter((e) => e.props.tabIndex !== undefined).length], [-1, 'object', 1]);
    assert.match(textIn(entries[30]), /Entry 31/);
    // Every entry's time in one column of the same width, so the words start at the same place.
    assert.ok(client.internals.CSS.some((rule) => rule.startsWith('.dshcn-log-time{flex:0 0 7.5em;width:7.5em;')));
    // An entry from a session DSH no longer has names it without a link.
    const gone = mount(client.internals.HistoryCard, { data: { history: [{ id: 'h9', at: now, kind: 'session', state: 'done', sessionId: 'gone', sessionTitle: 'Old work', sessionKnown: false, text: 'Notes turned off for a session' }] }, titles: new Map() });
    t.after(() => gone.unmount());
    assert.match(textIn(gone.tree), /Old work · Notes turned off for a session/);
    assert.equal(buttons(gone.tree).filter((b) => textIn(b) === 'Old work').length, 0);

    // Drafts and promoting allowed: the card says so.
    state = { ...PAGE_STATE, settings: { ...SETTINGS, access: 'drafts', promote: true, promoteFolder: 'Notes' } };
    page.update({});
    const fresh = mount(CanonPage, {});
    t.after(() => fresh.unmount());
    await settle(5);
    text = textIn(withAttr(fresh.tree, 'data-canon-drafts')[0]);
    assert.match(text, /Notes agents saved in Drafts\. None is added to a turn until a person promotes it\./);
    assert.match(text, /Promoting is on: Promote makes a draft an active note in Notes\./);
    assert.match(textIn(withAttr(fresh.tree, 'data-canon-header')[0]), /Drafts: agents may save draft notes in Drafts, and none is added to a turn until a person promotes it\./);
});

test('the page: no vault, a vault it cannot read, empty lists, switched off, a wrong setting and Canon not running each say what to do', async (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { kit, CanonPage, TEXT } = client.internals;
    const asked = [];
    kit.setNavigation({ openBundle: (name) => asked.push(name) });
    t.after(() => kit.setNavigation(undefined));
    let state = { ...PAGE_STATE, settings: { ...SETTINGS, vault: '' }, vault: { state: 'unset', counts: { notes: 0, active: 0, drafts: 0, other: 0, unreadable: 0 } }, sessions: [], drafts: [], history: [] };
    let hang = false;
    const calls = connect(kit, { state: () => state, refresh: () => (hang ? new Promise(() => {}) : VAULT) });
    t.after(() => kit.setConnection(undefined));
    const unset = mount(CanonPage, {});
    t.after(() => unset.unmount());
    await settle(5);
    let text = textIn(unset.tree);
    assert.match(text, /No vault yetSet “Vault folder” in Canon's settings to your Obsidian vault's folder, such as ~\/Obsidian\/Canon\. Canon only reads it unless you allow drafts\./);
    button(unset.tree, 'Open Canon\'s settings').props.onClick();
    assert.deepEqual(asked, ['dsh-plugin-canon']);
    assert.equal(withAttr(unset.tree, 'data-canon-try').length, 0, 'nothing to try without a vault');
    assert.equal(withAttr(unset.tree, 'data-canon-drafts').length, 0);
    assert.match(text, new RegExp(`${TEXT.noSessions}${TEXT.noSessionsText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(text, /Nothing yetDrafts agents save, drafts you promote, sessions you switch off and setting changes show here\./);

    state = { ...PAGE_STATE, vault: { ...VAULT, state: 'error', error: { code: 'missing', text: 'The vault folder ~/Canon does not exist. Check the folder in Canon\'s settings, or create it.' }, counts: { notes: 0, active: 0, drafts: 0, other: 0, unreadable: 0 } } };
    const missing = mount(CanonPage, {});
    t.after(() => missing.unmount());
    await settle(5);
    const line = withAttr(missing.tree, 'data-canon-vault')[0];
    assert.equal(line.props['data-canon-vault'], 'error');
    const alert = elementsOf(line).find((e) => e.props?.role === 'alert');
    assert.equal(textIn(alert), 'The vault folder ~/Canon does not exist. Check the folder in Canon\'s settings, or create it.', 'only the words are the alert: the time beside them changes');
    assert.match(textIn(line), /^The vault folder ~\/Canon does not exist\. Check the folder in Canon's settings, or create it\.Tried just now\.Read againOpen Canon's settings$/);
    assert.doesNotMatch(textIn(missing.tree), /Read just now/, 'a read that failed is never "read"');
    assert.equal(withAttr(missing.tree, 'data-canon-try').length, 0, 'nothing to try while the vault cannot be read');
    // Read again during its read: the same button (its key), never disabled, so the focus stays on it; a second press waits.
    hang = true;
    assert.equal(button(line, 'Read again').props.key, 'read');
    button(line, 'Read again').props.onClick();
    await settle(5);
    const busy = button(withAttr(missing.tree, 'data-canon-vault')[0], 'Reading…');
    assert.equal(busy.props.key, 'read');
    assert.equal(busy.props.disabled, undefined, 'a disabled button would drop the focus');
    assert.equal(busy.props['aria-disabled'], 'true');
    busy.props.onClick();
    await settle(5);
    assert.equal(calls.filter(([m]) => m === 'refresh').length, 1, 'pressed during its read, it reads once');
    hang = false;

    // The vault folder changed: its read is under way, and nothing of the earlier folder shows.
    state = { ...PAGE_STATE, vault: { state: 'reading', path: `${HOME}/Other`, display: '~/Other', draftsFolder: 'Drafts', counts: { notes: 0, active: 0, drafts: 0, other: 0, unreadable: 0 }, reading: true } };
    const reading = mount(CanonPage, {});
    t.after(() => reading.unmount());
    await settle(5);
    const readingLine = withAttr(reading.tree, 'data-canon-vault')[0];
    assert.equal(readingLine.props['data-canon-vault'], 'reading');
    assert.equal(textIn(readingLine), 'Reading the vault ~/Other…');
    assert.equal(elementsOf(readingLine).find((e) => e.props?.role === 'status') !== undefined, true);
    assert.equal(withAttr(reading.tree, 'data-canon-try').length, 0);

    state = { ...PAGE_STATE, settings: { ...SETTINGS, access: 'read-only' }, drafts: [] };
    const empty = mount(CanonPage, {});
    t.after(() => empty.unmount());
    await settle(5);
    text = textIn(withAttr(empty.tree, 'data-canon-drafts')[0]);
    assert.match(text, /No draftsCanon is read only, so agents save no drafts\. To let them, set “What Canon may write” to Drafts in Canon's settings\./);
    state = { ...PAGE_STATE, settings: { ...SETTINGS, access: 'drafts' }, drafts: [] };
    const none = mount(CanonPage, {});
    t.after(() => none.unmount());
    await settle(5);
    assert.match(textIn(withAttr(none.tree, 'data-canon-drafts')[0]), /No draftsWhen an agent saves something worth keeping, its draft shows here for you to read and promote\./);

    state = { ...PAGE_STATE, enabled: false, sessions: [], drafts: [], vault: { state: 'unset', counts: VAULT.counts } };
    const off = mount(CanonPage, {});
    t.after(() => off.unmount());
    await settle(5);
    text = textIn(off.tree);
    assert.match(text, /Canon is switched off in DSH's profile \(enabled: false in its entry in cordis\.patch\.yml\), so it reads no vault\./);
    assert.equal(withAttr(off.tree, 'data-canon-sessions').length, 0);

    state = { ...PAGE_STATE, problem: { key: 'maxChars', text: 'Characters a turn, at most (maxChars) must be a whole number of characters from 400 to 8000 (it is 5)', live: true } };
    const wrong = mount(CanonPage, {});
    t.after(() => wrong.unmount());
    await settle(5);
    text = textIn(wrong.tree);
    assert.match(text, /Canon is waiting for a setting to be fixed\./);
    assert.match(text, /\(it is 5\)\.Change it in Canon's settings in Plugins\. Canon starts working again as soon as you save\./);
    assert.equal(withAttr(wrong.tree, 'data-canon-history').length, 1, 'what happened still shows');
    assert.equal(withAttr(wrong.tree, 'data-canon-try').length, 0);

    const { react: r2, mount: m2 } = statefulReact();
    const down = loadClient(CLIENT, { react: r2 }).client;
    down.internals.kit.setConnection({ rpc: { call: async () => { throw new Error('404 Not Found'); } } });
    const gone = m2(down.internals.CanonPage, {});
    t.after(() => { gone.unmount(); down.internals.kit.setConnection(undefined); });
    await settle(5);
    text = textIn(gone.tree);
    assert.match(text, /Canon is not running\./);
    assert.match(text, /Open Canon in Plugins and switch it off and on again/);
    assert.doesNotMatch(text, /Session Watch/, 'Canon needs nothing else');
});

test('a draft from a session DSH no longer has names it in words, with no link to open', (t) => {
    const { react, mount } = statefulReact();
    const { client } = loadClient(CLIENT, { react });
    const { DraftsCard } = client.internals;
    const gone = { ...DRAFT, path: 'Drafts/Old.md', title: 'Old', sessionId: 'gone', sessionTitle: '', sessionKnown: false };
    const card = mount(DraftsCard, { data: { ...PAGE_STATE, drafts: [gone, DRAFT] }, onChanged: () => {} });
    t.after(() => card.unmount());
    const rows = withAttr(card.tree, 'data-canon-draft');
    assert.match(textIn(rows[0]), /from a session, turn 4/);
    assert.equal(buttons(rows[0]).filter((b) => textIn(b) === 'a session').length, 0);
    assert.ok(button(rows[1], 'Gateway work'), 'a session DSH has opens from its name');
});

test('settings in Plugins: the form has every live setting, takes what the config takes, and saves through DSH', async () => {
    const { client } = loadClient(CLIENT);
    const { SETTINGS: FIELDS, TEXT, CSS, SETTINGS_NOTE, SETTINGS_SUMMARY } = client.internals;
    assert.deepEqual(plain(FIELDS.map((f) => f.name)), [...LIVE_SETTINGS]);
    const check = (settings) => checkConfig({ ...DEFAULTS, ...settings }, { home: HOME, dshHome: `${HOME}/.dsh` });
    for (const f of FIELDS) {
        assert.equal(f.title, SETTING_TITLES[f.name], `${f.name}: the form and the config use the same words`);
        assert.deepEqual(plain(f.default), plain(DEFAULTS[f.name]), `${f.name}: the form's default is the config's`);
        if (f.kind === 'choice') {
            assert.deepEqual(plain(f.options.map((o) => [o.value, o.label])), Object.entries(ACCESS_CHOICES));
            for (const o of f.options) assert.doesNotThrow(() => check({ [f.name]: o.value }));
        }
        if (f.kind === 'number') {
            assert.doesNotThrow(() => check({ [f.name]: f.min }), f.name);
            assert.doesNotThrow(() => check({ [f.name]: f.max }), f.name);
            assert.throws(() => check({ [f.name]: f.min - 1 }), f.name);
            assert.throws(() => check({ [f.name]: f.max + 1 }), f.name);
        }
    }
    const field = (name) => FIELDS.find((f) => f.name === name);
    for (const value of ['~/Obsidian/Canon', '/Volumes/Notes/Canon']) {
        assert.equal(field('vault').accepts(value), true, value);
        assert.doesNotThrow(() => check({ vault: value }));
    }
    for (const value of ['Obsidian/Canon', 'Canon']) {
        assert.equal(field('vault').accepts(value), false, value);
        assert.throws(() => check({ vault: value }));
    }
    for (const name of ['draftsFolder', 'promoteFolder']) {
        for (const value of ['Drafts', 'Canon/Drafts', 'Notes (kept)']) {
            assert.equal(field(name).accepts(value), true, `${name} ${value}`);
            assert.doesNotThrow(() => check({ [name]: value, ...(name === 'promoteFolder' ? { draftsFolder: 'Elsewhere' } : {}) }), `${name} ${value}`);
        }
        for (const value of ['../Out', '.trash', 'a//b', 'Dr*fts', 'a/.hidden']) {
            assert.equal(field(name).accepts(value), false, `${name} ${value}`);
            assert.throws(() => check({ [name]: value }), `${name} ${value}`);
        }
    }
    // Promoted notes go outside the drafts folder (as saved): the form refuses it as Canon does, in the same words.
    const { kit: formKit, settingsFields } = client.internals;
    const promoteField = settingsFields(() => 'Drafts').find((f) => f.name === 'promoteFolder');
    const promoteSpec = formKit.fieldSpec(promoteField);
    for (const value of ['Drafts', 'Drafts/Kept', 'drafts/kept']) {
        assert.equal(promoteSpec.parse(value), undefined, value);
        assert.equal(formKit.invalidWords(promoteField), 'Must be outside the drafts folder (Drafts): notes there are never added to turns. Leave it empty for the vault\'s top level.', value);
        assert.throws(() => check({ promoteFolder: value }), (error) => /must be outside the drafts folder \(Drafts\): notes there are never added to turns/.test(error.message), value);
    }
    assert.deepEqual(plain(promoteSpec.parse('Drafts old/Kept')), { kind: 'set', value: 'Drafts old/Kept' });
    assert.equal(promoteSpec.parse('.trash'), undefined);
    assert.equal(formKit.invalidWords(promoteField), field('promoteFolder').invalid, 'a folder that is not one gets the folder words');
    // Another drafts folder as saved: Drafts/Kept fits there, and a folder inside Inbox does not.
    const inbox = formKit.fieldSpec(settingsFields(() => ' Inbox/ ').find((f) => f.name === 'promoteFolder'));
    assert.deepEqual(plain(inbox.parse('Drafts/Kept')), { kind: 'set', value: 'Drafts/Kept' });
    assert.equal(inbox.parse('Inbox/Kept'), undefined);
    // None saved (or not a folder): the default, Drafts.
    assert.equal(formKit.fieldSpec(settingsFields(() => undefined).find((f) => f.name === 'promoteFolder')).parse('Drafts/Kept'), undefined);
    assert.doesNotMatch(JSON.stringify(TEXT) + CSS.join('') + JSON.stringify(FIELDS) + SETTINGS_NOTE + SETTINGS_SUMMARY, OTHER_NAMES);

    // Drawn through DSH's own settings form while DSH serves Canon's settings.
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
    assert.deepEqual(plain(served), [['canon']]);
    assert.equal(models[0].scope.entry, 'canon');
    assert.deepEqual(plain(models[0].specs.map((s) => s.field)), [...LIVE_SETTINGS]);
    const entry = registered.find((item) => item.spec.name === 'plugins.bundle.config');
    assert.equal(entry.spec.key, 'dsh-plugin-canon');
    assert.equal(entry.component({ view: 'summary' }), SETTINGS_SUMMARY);
    const form = entry.component({});
    const page = textIn(form);
    for (const group of ['Vault', 'Promoting', 'Turns']) assert.match(page, new RegExp(group));
    assert.match(page, /never promotes a draft by itself/);
    assert.deepEqual(withAttr(form, 'data-suite-setting').map((e) => e.props['data-suite-setting']), [...LIVE_SETTINGS]);
    // An empty vault (the default) shows empty, not as a value that does not fit.
    assert.equal(withAttr(form, 'data-suite-invalid').length, 0);
    // The drafts folder as DSH has it saved: a promote folder typed inside it does not fit.
    const drawnPromote = models[0].specs.find((spec) => spec.field === 'promoteFolder');
    assert.equal(drawnPromote.parse('Drafts/Kept'), undefined);
    assert.deepEqual(plain(drawnPromote.parse('Decisions')), { kind: 'set', value: 'Decisions' });
});

test('words: the page\'s sentences for each setting, and no other assistant\'s names anywhere in the window', () => {
    const { client } = loadClient(CLIENT);
    const { writesText, promoteText, turnsText, vaultText, vaultNotes, whyText, missText } = client.internals;
    assert.equal(writesText({ access: 'read-only' }), 'Read only: Canon writes nothing to the vault.');
    assert.equal(promoteText({ access: 'drafts', promote: true, promoteFolder: '' }), 'Promoting is on: Promote makes a draft an active note at the vault\'s top level.');
    assert.equal(promoteText({ access: 'drafts', promote: false }), 'Promoting is off: Promote changes nothing until “Allow promoting drafts” is on in Canon\'s settings.');
    assert.equal(turnsText({ recall: false }), 'Adding notes to turns is off: no turn gets notes.');
    assert.equal(turnsText({ recall: true, maxNotes: 1, maxChars: 8000 }), 'A turn that starts from your prompt gets at most 1 note and 8,000 characters.');
    assert.equal(vaultText({ display: '~/Canon', counts: { active: 1, drafts: 0 } }), 'The vault ~/Canon holds 1 active note and 0 drafts.');
    assert.deepEqual(plain(vaultNotes({ truncated: true, counts: { other: 1, unreadable: 2 } })), ['1 note with another status (archived, draft and the like) is never added.', '2 notes could not be read.', 'Only the first 20,000 notes are read.']);
    assert.equal(whyText({ matched: ['tls'], folder: 'parent' }), 'Shares the word “tls”. It belongs to the folder above this one, so it counts a little more.');
    // The prompt's own words, never stems.
    assert.equal(whyText({ matched: ['rotat', 'certificat'], words: ['rotating', 'certificates'], folder: '' }), 'Shares the words “rotating” and “certificates”.');
    assert.equal(missText({ fits: false, why: 'name' }), 'It shares only a project\'s name with the prompt.');
    assert.match(missText({ fits: false, why: 'few' }), /^Too little in common: one word besides a project's name/);
    assert.equal(missText({ fits: false, why: 'other' }), 'It belongs to another project than the one this folder or the prompt points at.');
    assert.equal(missText({ fits: true, why: 'less' }), 'It fits less well than the notes above, or too little to add.');
    const source = (url) => import('node:fs').then((fs) => fs.readFileSync(url, 'utf8'));
    return source(CLIENT).then((text) => assert.doesNotMatch(text, OTHER_NAMES));
});
