/**
 * Recall's plugin as DSH starts it (lib/index.js `apply`, with stand-ins
 * for DSH's packages): any value in the profile starts it; a wrong one is
 * named on its page, in its log and in every refusal, offers agents no
 * tool, and a save fixes it without a restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, LIVE_SETTINGS } from '../plugins/recall/lib/config.js';
import { tempDir } from './helpers/temp.mjs';
import { sessionFile, sessionWriter } from './fixtures/recall/corpus.mjs';

await import('./fixtures/recall/stubs/hooks.mjs');
const recall = await import('../plugins/recall/lib/index.js');
const { SERVICE } = await import('../plugins/recall/lib/remote.js');

/** A live setting as DSH hands it over: a reference whose value a save changes in place. */
const ref = (value) => ({ value, get() { return this.value; } });

/** Recall's config as DSH resolves it from the profile: the live settings as references. */
function configOf(patch = {}) {
    const values = { ...DEFAULTS, transcriptFolders: [], handoffFolders: [], sessionFolders: [], ...patch };
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, LIVE_SETTINGS.includes(key) ? ref(value) : value]));
}

/**
 * Enough of DSH for `apply`: events, effects, the tools and the gateway (Session Watch is not running: Recall needs
 * nothing else). `agents`: DSH's agents service (which sessions run), when the test gives one.
 */
function standInDsh({ agents } = {}) {
    const handlers = new Map();
    const disposers = [];
    const provided = new Map();
    const tools = new Map();
    const warnings = [];
    const scope = {
        tools: {
            register(tool) {
                if (tools.has(tool.name)) throw new Error(`tool ${tool.name} is registered twice`);
                tools.set(tool.name, tool);
                return () => tools.delete(tool.name);
            },
        },
        provide: (name, value) => provided.set(name, value),
        agents,
    };
    const ctx = {
        logger: { warn: (line) => warnings.push(line), info: () => {} },
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event).push(fn);
            return () => {};
        },
        effect(fn) {
            const off = fn();
            if (typeof off === 'function') disposers.push(off);
        },
        inject(names, fn) {
            if (names.includes('sessionWatch') || (names.includes('agents') && !agents)) return;
            const off = fn(scope);
            if (typeof off === 'function') disposers.push(off);
        },
    };
    return {
        ctx, provided, tools, warnings,
        remote: () => provided.get(SERVICE),
        emit: (event, ...args) => Promise.all((handlers.get(event) ?? []).map((fn) => fn(...args))),
        stop: () => { for (const off of disposers.splice(0).reverse()) off(); },
    };
}

const until = async (fn, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if (await fn()) return true; } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
};

test('plugin: every setting takes any value, so DSH never stops Recall over a wrong type; only enabled waits for the next start', () => {
    assert.equal(recall.name, 'recall');
    assert.deepEqual(Object.keys(recall.Config.shape), ['enabled', ...LIVE_SETTINGS]);
    for (const [key, value] of Object.entries(DEFAULTS)) {
        assert.equal(recall.Config.shape[key].type, 'any', key);
        assert.deepEqual(recall.Config.shape[key].value, value, key);
        assert.equal(recall.Config.shape[key].live, key !== 'enabled', key);
    }
});

test('plugin: one folder without the brackets, or "yes" for a switch: Recall starts, names it on its page, in its log and in each refusal, offers no tool, and a save fixes it', async (t) => {
    const home = tempDir('recall-plugin');
    process.env.RECALL_TEST_DSH_HOME = home;
    const config = configOf({ transcriptFolders: '~/agent-logs' });
    let dsh = standInDsh();
    t.after(() => dsh.stop());
    assert.doesNotThrow(() => recall.apply(dsh.ctx, config));
    let remote = dsh.remote();
    let state = await remote.state();
    const words = 'Coding-agent transcript folders (transcriptFolders) must be a list of folders in square brackets, such as ["~/agent-logs"] (it is "~/agent-logs", one folder without the brackets)';
    assert.deepEqual(state.problem, { text: words, key: 'transcriptFolders', live: true });
    assert.equal(state.history[0].text, 'Started with a wrong setting; Recall waits until it is fixed');
    assert.equal(state.history[0].why, `${words}.`);
    await assert.rejects(remote.search({ text: 'gateway' }), { message: `Recall is waiting for a setting to be fixed: ${words}.` });
    assert.equal(dsh.tools.size, 0, 'agents get no recall_search while a setting is wrong');
    assert.ok(dsh.warnings.some((line) => line.includes('one folder without the brackets')), 'and DSH\'s log says so');

    // Saved right on its page in Plugins (or in the profile): Recall works again at once, and its log says so.
    config.transcriptFolders.value = ['~/agent-logs'];
    await dsh.emit('loader/volatile-update', [['transcriptFolders']]);
    state = await remote.state();
    assert.equal(state.problem, undefined);
    assert.equal(state.history[0].text, 'Settings fixed: Recall is working again');
    assert.ok(dsh.tools.has('recall_search'));
    assert.ok(await until(async () => (await remote.search({ text: 'gateway' })).total === 0), 'it searches');

    // "yes" for a switch, saved while it runs: named the same way, and the tool goes until it is fixed.
    config.tool.value = 'yes';
    await dsh.emit('loader/volatile-update', [['tool']]);
    state = await remote.state();
    assert.deepEqual(state.problem, { text: 'Let agents search past work (tool) must be true or false, written without quotes (it is "yes", which is text)', key: 'tool', live: true });
    assert.equal(state.history[0].text, 'Settings changed: “Let agents search past work”; Recall waits until a wrong one is fixed');
    assert.equal(dsh.tools.size, 0);
    config.tool.value = true;
    await dsh.emit('loader/volatile-update', [['tool']]);
    assert.ok(dsh.tools.has('recall_search'));
    dsh.stop();

    // Started again with a wrong value: said once, not again at each start; started right: its fix is said.
    const again = configOf({ tool: 'yes' });
    for (let i = 0; i < 2; i += 1) {
        dsh = standInDsh();
        recall.apply(dsh.ctx, again);
        state = await dsh.remote().state();
        dsh.stop();
    }
    assert.equal(state.history.filter((e) => e.text === 'Started with a wrong setting; Recall waits until it is fixed').length, 2, 'one for each wrong value, not one per start');
    assert.equal(state.history[0].why, 'Let agents search past work (tool) must be true or false, written without quotes (it is "yes", which is text).');
    dsh = standInDsh();
    recall.apply(dsh.ctx, configOf());
    state = await dsh.remote().state();
    assert.equal(state.problem, undefined);
    assert.deepEqual([state.history[0].text, state.history[0].why], ['Settings fixed: Recall is working again', 'Its settings were right when DSH started it again.']);
});

test('plugin: two starts in one millisecond keep both entries of What happened (a wrong setting, then its fix)', async (t) => {
    const home = tempDir('recall-plugin-same-ms');
    process.env.RECALL_TEST_DSH_HOME = home;
    // The suite's log names an entry by its millisecond and a count from each start: frozen, the clock gives both the same.
    const realNow = Date.now;
    const frozen = realNow();
    t.after(() => { Date.now = realNow; });
    Date.now = () => frozen;
    let dsh = standInDsh();
    recall.apply(dsh.ctx, configOf({ tool: 'yes' }));
    dsh.stop();
    dsh = standInDsh();
    t.after(() => dsh.stop());
    recall.apply(dsh.ctx, configOf());
    Date.now = realNow;
    const { history } = await dsh.remote().state();
    assert.deepEqual(history.slice(0, 2).map((e) => e.text), ['Settings fixed: Recall is working again', 'Started with a wrong setting; Recall waits until it is fixed']);
    assert.notEqual(history[0].id, history[1].id);
    assert.ok(history[0].at > history[1].at, 'the fix is timed after the entry before it');
});

test('plugin: every setting wrong at once still starts; enabled written as text keeps Recall idle with no index, named as a profile setting', async (t) => {
    const home = tempDir('recall-plugin-idle');
    process.env.RECALL_TEST_DSH_HOME = home;
    const dsh = standInDsh();
    t.after(() => dsh.stop());
    const config = configOf({ enabled: 'yes', sessions: 'on', sessionFolders: 3, transcriptFolders: { work: '~/logs' }, handoffFolders: '', tool: 1 });
    assert.doesNotThrow(() => recall.apply(dsh.ctx, config));
    const remote = dsh.remote();
    const state = await remote.state();
    assert.deepEqual(state.problem, { text: 'Recall on (enabled) must be true or false, written without quotes (it is "yes", which is text); Search this DSH\'s sessions (sessions) and 4 more are wrong too', key: 'enabled', live: false });
    assert.notEqual(state.thread.state, 'running');
    assert.equal(state.index, undefined);
    await assert.rejects(remote.search({ text: 'x' }), /Recall is waiting for a setting to be fixed: Recall on \(enabled\)/);
    await assert.rejects(remote.turn('1.1'), /Recall is waiting for a setting to be fixed/);
    assert.equal(dsh.tools.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(join(home, 'recall', 'index.sqlite')), false, 'no index is made while enabled is not true');
    // A save of the live ones while enabled is wrong: checked and logged, still idle.
    config.sessions.value = true;
    await dsh.emit('loader/volatile-update', [['sessions']]);
    assert.equal((await remote.state()).problem.key, 'enabled');
});

test('plugin: a turn runs only while DSH says its session runs; a session DSH stopped under (a crash it never reopened) is cut off', async (t) => {
    const home = tempDir('recall-plugin-live');
    process.env.RECALL_TEST_DSH_HOME = home;
    const sessions = join(home, 'sessions');
    const at = Date.now() - 3_600_000;
    sessionWriter(sessionFile(sessions, 's-live'), { id: 's-live', createdAt: at }).header().turn({ prompt: 'osprey, asked now', end: false });
    sessionWriter(sessionFile(sessions, 's-dead'), { id: 's-dead', createdAt: at }).header().turn({ prompt: 'osprey, asked before a crash', end: false });
    const list = [{ id: 's-live', status: 'running' }];
    const dsh = standInDsh({ agents: { list: () => list } });
    t.after(() => dsh.stop());
    recall.apply(dsh.ctx, configOf());
    const remote = dsh.remote();
    const states = async () => Object.fromEntries((await remote.search({ text: 'osprey' })).results.map((r) => [r.sessionId, r.state]));
    assert.ok(await until(async () => JSON.stringify(await states()) === JSON.stringify({ 's-live': 'running', 's-dead': 'cut-off' })), JSON.stringify(await states().catch((e) => e.message)));
    // DSH says it stopped: its end is read a moment later, so no word for now, and never "running".
    list[0].status = 'idle';
    await dsh.emit('agent/status', { agent: list[0], status: 'idle' });
    assert.ok(await until(async () => (await states())['s-live'] === ''), JSON.stringify(await states()));
    list[0].status = 'running';
    await dsh.emit('agent/status', { agent: list[0], status: 'running' });
    assert.ok(await until(async () => (await states())['s-live'] === 'running'));
});
