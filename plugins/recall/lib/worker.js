/**
 * Recall's index thread: it alone opens the index, reads the files a slice
 * at a time (about 40 ms each) and answers the plugin's requests between
 * slices, so nothing it does can hold up DSH's own thread.
 *
 * Messages in: `{ type: 'call', id, op, args }`. Out: `{ type: 'reply', id,
 * ok, value | error }`, `{ type: 'log', level, text }`, `{ type: 'note',
 * note }` (for the person's log), `{ type: 'changed', status }` (at most
 * once a second while it reads, and when it catches up), and `{ type:
 * 'fatal', text }` when it cannot run at all.
 *
 * @module dsh-plugin-recall/worker
 */
import { parentPort, workerData } from 'node:worker_threads';
import { Engine } from './engine.js';

const post = (message) => {
    try { parentPort.postMessage(message); } catch { /* the plugin went away */ }
};

let sqlite;
try {
    sqlite = await import('node:sqlite');
} catch {
    post({ type: 'fatal', text: `This DSH runs on Node ${process.version}, which has no built-in SQLite; Recall needs Node 22.13 or newer for its index.` });
    process.exit(1);
}

let engine;
try {
    engine = new Engine({
        file: workerData.file,
        sqlite,
        log: (level, text) => post({ type: 'log', level, text }),
        note: (note) => post({ type: 'note', note }),
    });
} catch (error) {
    post({ type: 'fatal', text: `Recall could not open its index at ${workerData.file}: ${String(error?.message ?? error).slice(0, 300)}` });
    process.exit(1);
}

const SLICE_MS = Number.isFinite(workerData.sliceMs) ? workerData.sliceMs : 40;
const RESCAN_MS = Number.isFinite(workerData.rescanMs) ? workerData.rescanMs : 60_000;
let scheduled = false;
let lastReport = 0;
let closing = false;

function report(force) {
    const now = Date.now();
    if (!force && now - lastReport < 1000) return;
    lastReport = now;
    try {
        post({ type: 'changed', status: engine.status() });
    } catch (error) {
        post({ type: 'log', level: 'warn', text: `could not read the index's status: ${String(error?.message ?? error).slice(0, 200)}` });
    }
}

function tick() {
    scheduled = false;
    if (closing) return;
    let result = { more: false };
    try {
        result = engine.work(SLICE_MS);
    } catch (error) {
        post({ type: 'log', level: 'warn', text: `an indexing slice failed: ${String(error?.message ?? error).slice(0, 300)}` });
    }
    if (result.idle) {
        post({ type: 'note', note: { kind: 'caught-up', ...result.idle } });
        report(true);
    } else if (result.shrunk) report(true);
    else if (result.more) report(false);
    if (result.more) schedule();
}

function schedule() {
    if (scheduled || closing) return;
    scheduled = true;
    setImmediate(tick);
}

parentPort.on('message', (message) => {
    if (!message || message.type !== 'call') return;
    if (message.op === 'close') {
        closing = true;
        clearInterval(rescans);
        try { engine.close(); } catch { /* closing anyway */ }
        post({ type: 'reply', id: message.id, ok: true, value: true });
        parentPort.close();
        return;
    }
    try {
        const value = engine.handle(message.op, message.args ?? {});
        post({ type: 'reply', id: message.id, ok: true, value });
    } catch (error) {
        post({ type: 'reply', id: message.id, ok: false, error: { message: String(error?.message ?? error).slice(0, 400) } });
    }
    schedule();
});

const rescans = setInterval(() => {
    try { engine.handle('rescan'); } catch { /* the next one */ }
    schedule();
}, RESCAN_MS);

post({ type: 'ready' });
