#!/usr/bin/env node
/**
 * Recall's bench: how fast its index answers on a big synthetic history.
 *
 * It writes N synthetic DSH sessions (test/fixtures/recall/corpus.mjs: the
 * file layout and event shapes DSH writes, with made-up words; no real
 * session is read), indexes them with Recall's own index thread (the same
 * worker DSH runs), and then times what Recall does:
 *
 * - the first index: how long, how big, and how long DSH's own thread was
 *   held up meanwhile (it should not be: the index has its own thread);
 * - searches while that first index is built;
 * - the page's searches (words, phrases, typing, filters, pages), each a
 *   round trip through the thread, as the page and the tool make them;
 * - reading one turn in full;
 * - a new turn, and a new session, from the moment DSH says a session moved
 *   to the moment a search finds it;
 * - a restart: the index opens again and looks for changes.
 *
 *   node scripts/recall-bench.mjs [--sessions 10000] [--rounds 20] [--dir DIR] [--keep] [--json FILE]
 *
 * @module scripts/recall-bench
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { IndexThread } from '../plugins/recall/lib/thread.js';
import { sessionFile, sessionWriter, writeCorpus } from '../test/fixtures/recall/corpus.mjs';

/** A word no other turn has, put in one turn, to check a result opens at its exact turn. */
export const RARE_WORD = 'quetzalcoatl';
/** The page's searches, as it makes them (20 results a page). */
export const QUERIES = Object.freeze([
    { name: 'one common word', q: { text: 'deploy' } },
    { name: 'two words', q: { text: 'gateway timeout' } },
    { name: 'a phrase', q: { text: '"cache index"' } },
    { name: 'typing (last word a prefix)', q: { text: 'rollback migra', prefix: true } },
    { name: 'a rare word', q: { text: RARE_WORD } },
    { name: 'either word (OR)', q: { text: 'ledger OR invoice' } },
    { name: 'a word left out', q: { text: 'deploy -staging' } },
    { name: 'sessions of the past month', q: { text: 'rollback', kind: 'session', since: 'month' } },
    { name: 'one folder', q: { text: 'parser', folder: '/work/project-7' } },
    { name: 'one model', q: { text: 'shader texture', model: 'glm-5.3-flash' } },
    { name: 'newest first', q: { text: 'kernel driver', sort: 'newest' } },
    { name: 'nothing typed (newest turns)', q: { text: '' } },
    { name: 'third page', q: { text: 'token', offset: 40 } },
]);

/** Nearest-rank percentile of numbers. */
export function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const round = (ms) => Math.round(ms * 10) / 10;
const stats = (values) => ({ n: values.length, median: round(percentile(values, 50)), p95: round(percentile(values, 95)), max: round(Math.max(0, ...values)) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `get()` gives something, for up to `ms`. */
async function until(get, ms, step = 20) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await get();
        if (value || Date.now() > end) return value;
        await sleep(step);
    }
}

/**
 * Run the bench.
 * @param {object} [options]
 * @param {number} [options.sessions] - how many synthetic sessions.
 * @param {number} [options.rounds] - how many times each search runs (after one warm-up round).
 * @param {string} [options.dir] - where to write (a new temporary folder if not given).
 * @param {boolean} [options.keep] - keep the folder.
 * @param {(text: string) => void} [options.log]
 */
export async function runBench({ sessions = 10_000, rounds = 20, dir, keep = false, log = (text) => process.stderr.write(`${text}\n`) } = {}) {
    const root = dir ?? mkdtempSync(join(tmpdir(), 'recall-bench-'));
    mkdirSync(root, { recursive: true });
    const sessionsDir = join(root, 'sessions');
    const indexFile = join(root, 'recall', 'index.sqlite');
    mkdirSync(join(root, 'recall'), { recursive: true });
    const rareSession = Math.floor(sessions * 0.4321);
    const result = { node: process.version, platform: `${process.platform}-${process.arch}`, sessions, rounds };
    let thread;
    try {
        // ── The history ──
        let t0 = performance.now();
        const corpus = writeCorpus(sessionsDir, { sessions, now: Date.now(), rare: [{ session: rareSession, turn: 2, word: RARE_WORD }] });
        // One more session, still being written to, for the "new turn" timing.
        const live = sessionWriter(sessionFile(sessionsDir, 'bench-live', 'project-live'), { id: 'bench-live', cwd: '/work/project-live', createdAt: Date.now() - 60_000 }).header();
        live.turn({ prompt: 'set up the live session', reply: 'Done.', at: Date.now() - 50_000 });
        result.corpus = { files: corpus.files + 1, turns: corpus.turns + 1, megabytes: round(corpus.bytes / 1048576), writeMs: Math.round(performance.now() - t0) };
        log(`wrote ${corpus.files} sessions, ${corpus.turns} turns, ${result.corpus.megabytes} MB of logs in ${(result.corpus.writeMs / 1000).toFixed(1)} s`);

        // ── The first index, in Recall's own thread ──
        let caughtUp;
        const onEvent = (message) => {
            if (message?.type === 'note' && message.note?.kind === 'caught-up') caughtUp?.(message.note);
        };
        thread = new IndexThread({ file: indexFile, onEvent, workerData: { rescanMs: 3_600_000 } });
        thread.start();
        if (!(await thread.ready)) throw new Error(`the index thread did not start: ${thread.problem}`);
        const delay = monitorEventLoopDelay({ resolution: 10 });
        delay.enable();
        const during = [];
        let building = true;
        const firstBuild = new Promise((resolve) => { caughtUp = resolve; });
        t0 = performance.now();
        await thread.call('configure', { sources: [{ kind: 'session', root: sessionsDir, own: true }] }, { standing: true, timeoutMs: 120_000 });
        // Searches while it builds, as a person would type them.
        const searching = (async () => {
            while (building) {
                const s = performance.now();
                await thread.call('search', { text: 'deploy', limit: 20 }, { timeoutMs: 60_000 });
                during.push(performance.now() - s);
                await sleep(200);
            }
        })();
        const note = await firstBuild;
        result.build = { ms: Math.round(performance.now() - t0) };
        building = false;
        await searching;
        delay.disable();
        const status = await thread.call('status');
        result.build = {
            ...result.build,
            files: status.totals.files,
            turns: status.totals.turns,
            indexMegabytes: round(status.bytes / 1048576),
            turnsPerSecond: Math.round(status.totals.turns / (result.build.ms / 1000)),
            read: note.read,
            mainThreadDelayMs: { p99: round(delay.percentile(99) / 1e6), max: round(delay.max / 1e6) },
            searchesMeanwhile: stats(during),
        };
        log(`indexed ${status.totals.turns} turns from ${status.totals.files} files in ${(result.build.ms / 1000).toFixed(1)} s (${result.build.indexMegabytes} MB); DSH's thread was held up at most ${result.build.mainThreadDelayMs.max} ms`);

        // ── The page's searches ──
        const rows = QUERIES.map((x) => ({ name: x.name, roundTrip: [], inIndex: [], total: 0, totalMore: false, results: 0 }));
        for (let round = 0; round <= rounds; round += 1) {
            for (const [i, x] of QUERIES.entries()) {
                const s = performance.now();
                const found = await thread.call('search', { limit: 20, ...x.q });
                const ms = performance.now() - s;
                if (round === 0) continue; // warm-up
                rows[i].roundTrip.push(ms);
                rows[i].inIndex.push(found.took);
                rows[i].total = found.total;
                rows[i].totalMore = found.totalMore;
                rows[i].results = found.results.length;
            }
        }
        result.queries = rows.map((r) => ({ name: r.name, total: r.total, totalMore: r.totalMore, results: r.results, roundTrip: stats(r.roundTrip), inIndex: stats(r.inIndex) }));
        const all = rows.flatMap((r) => r.roundTrip);
        result.search = { ...stats(all), inIndex: stats(rows.flatMap((r) => r.inIndex)) };
        log(`${all.length} searches: median ${result.search.median} ms, p95 ${result.search.p95} ms, slowest ${result.search.max} ms (round trip through the index thread)`);

        // ── Results open at their exact turn ──
        const rare = await thread.call('search', { text: RARE_WORD, limit: 5 });
        const hit = rare.results[0];
        result.rare = { total: rare.total, sessionId: hit?.sessionId, turn: hit?.turn, seq: hit?.seq, expected: { sessionId: `bench-${String(rareSession).padStart(5, '0')}`, turn: 2, seq: 8 } };
        const opens = [];
        for (let i = 0; i < Math.max(5, rounds); i += 1) {
            const s = performance.now();
            await thread.call('turn', { id: hit.id });
            opens.push(performance.now() - s);
        }
        result.turn = stats(opens);

        // ── A new turn in a session, and a new session ──
        const word = 'zyzzyvaturn';
        live.turn({ prompt: `please check the ${word} handler`, reply: 'Checked.', at: Date.now() });
        let s = performance.now();
        await thread.call('touch', { sessionIds: ['bench-live'] });
        let found = await until(async () => (await thread.call('search', { text: word, limit: 1 })).results[0], 20_000);
        result.newTurn = { ms: Math.round(performance.now() - s), found: Boolean(found), turn: found?.turn };
        const fresh = sessionWriter(sessionFile(sessionsDir, 'bench-fresh', 'project-fresh'), { id: 'bench-fresh', cwd: '/work/project-fresh', createdAt: Date.now() }).header();
        fresh.turn({ prompt: 'a zyzzyvasession appears', reply: 'Hello.', at: Date.now() });
        s = performance.now();
        await thread.call('touch', { sessionIds: ['bench-fresh'] });
        found = await until(async () => (await thread.call('search', { text: 'zyzzyvasession', limit: 1 })).results[0], 60_000);
        result.newSession = { ms: Math.round(performance.now() - s), found: Boolean(found) };
        log(`a new turn was found ${result.newTurn.ms} ms after DSH said its session moved; a new session ${result.newSession.ms} ms after`);

        // ── A restart: the index opens again and looks for changes ──
        await thread.stop();
        const again = new Promise((resolve) => { caughtUp = resolve; });
        s = performance.now();
        thread = new IndexThread({ file: indexFile, onEvent, workerData: { rescanMs: 3_600_000 } });
        thread.start();
        await thread.ready;
        const readyMs = performance.now() - s;
        await thread.call('configure', { sources: [{ kind: 'session', root: sessionsDir, own: true }] }, { standing: true, timeoutMs: 120_000 });
        const first = performance.now();
        await thread.call('search', { text: 'deploy', limit: 20 }, { timeoutMs: 60_000 });
        const firstSearchMs = performance.now() - first;
        const rescan = await again;
        result.restart = { readyMs: Math.round(readyMs), firstSearchMs: round(firstSearchMs), lookedThroughMs: Math.round(performance.now() - s), reread: rescan.read };
        // After DSH stopped without closing the index (its mark left behind), the index is checked in full first.
        await thread.stop();
        writeFileSync(`${indexFile}.open`, 'left by a stop that did not close the index\n');
        s = performance.now();
        thread = new IndexThread({ file: indexFile, onEvent, workerData: { rescanMs: 3_600_000 } });
        thread.start();
        await thread.ready;
        result.restart.afterUncleanStopReadyMs = Math.round(performance.now() - s);
        log(`restart: the index opened in ${result.restart.readyMs} ms (${result.restart.afterUncleanStopReadyMs} ms after a stop that did not close it), answered its first search in ${result.restart.firstSearchMs} ms, and looked through every file in ${(result.restart.lookedThroughMs / 1000).toFixed(1)} s (${rescan.read} read again)`);
        result.indexFileMegabytes = round(statSync(indexFile).size / 1048576);
        return result;
    } finally {
        await thread?.stop();
        if (!keep && !dir) rmSync(root, { recursive: true, force: true });
    }
}

async function main() {
    const { values } = parseArgs({
        options: {
            sessions: { type: 'string', default: '10000' },
            rounds: { type: 'string', default: '20' },
            dir: { type: 'string' },
            keep: { type: 'boolean', default: false },
            json: { type: 'string' },
        },
    });
    const sessions = Number(values.sessions);
    const rounds = Number(values.rounds);
    if (!Number.isSafeInteger(sessions) || sessions < 10 || sessions > 200_000) throw new Error('--sessions takes a whole number from 10 to 200000.');
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 1000) throw new Error('--rounds takes a whole number from 1 to 1000.');
    const result = await runBench({ sessions, rounds, dir: values.dir, keep: values.keep });
    const lines = [
        '',
        `Recall bench: ${result.corpus.files} sessions, ${result.build.turns} turns, ${result.platform}, Node ${result.node}`,
        '',
        '| Search | Matching turns | Median | p95 | In the index (median) |',
        '| --- | ---: | ---: | ---: | ---: |',
        ...result.queries.map((q) => `| ${q.name} | ${q.total.toLocaleString('en-US')}${q.totalMore ? '+' : ''} | ${q.roundTrip.median} ms | ${q.roundTrip.p95} ms | ${q.inIndex.median} ms |`),
        `| **All ${result.search.n} searches** | | **${result.search.median} ms** | **${result.search.p95} ms** | ${result.search.inIndex.median} ms |`,
        '',
        `First index: ${(result.build.ms / 1000).toFixed(1)} s (${result.build.turnsPerSecond} turns a second), ${result.build.indexMegabytes} MB; DSH's thread held up at most ${result.build.mainThreadDelayMs.max} ms (p99 ${result.build.mainThreadDelayMs.p99} ms).`,
        `Searches while it built: median ${result.build.searchesMeanwhile.median} ms, p95 ${result.build.searchesMeanwhile.p95} ms (${result.build.searchesMeanwhile.n} searches).`,
        `Reading one turn in full: median ${result.turn.median} ms, p95 ${result.turn.p95} ms.`,
        `A new turn is found ${result.newTurn.ms} ms after DSH says its session moved; a new session ${result.newSession.ms} ms after.`,
        `Restart: open ${result.restart.readyMs} ms (${result.restart.afterUncleanStopReadyMs} ms after a stop that did not close the index), first search ${result.restart.firstSearchMs} ms, every file looked at again in ${(result.restart.lookedThroughMs / 1000).toFixed(1)} s.`,
        `The rare word's result: session ${result.rare.sessionId}, turn ${result.rare.turn}, seq ${result.rare.seq} (expected ${result.rare.expected.sessionId}, turn ${result.rare.expected.turn}, seq ${result.rare.expected.seq}).`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    if (values.json) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((error) => {
        process.stderr.write(`recall bench: ${error?.stack ?? error}\n`);
        process.exit(1);
    });
}
