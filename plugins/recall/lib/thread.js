/**
 * The plugin's side of the index thread (lib/worker.js): start it, ask it
 * things, and start it again if it stops. DSH's own thread only posts
 * messages here; it never waits on the index.
 *
 * A thread that stops by itself is started again after 2, 8 and 30
 * seconds; after three stops in ten minutes it stays stopped, and its
 * state says why. A thread that cannot run at all (no SQLite in this
 * Node) says so and is not started again.
 *
 * @module dsh-plugin-recall/thread
 */
import { Worker } from 'node:worker_threads';

const RETRY_MS = [2000, 8000, 30000];
const WINDOW_MS = 10 * 60_000;

export class IndexThread {
    /**
     * @param {object} options
     * @param {string} options.file - the index file.
     * @param {{ info?: Function, warn?: Function }} [options.logger]
     * @param {(message: object) => void} [options.onEvent] - the thread's notes, logs and status changes.
     * @param {URL} [options.script] - the worker's module.
     * @param {object} [options.workerData] - more for the worker (sliceMs, rescanMs).
     * @param {typeof Worker} [options.WorkerClass]
     * @param {number[]} [options.retryMs] - the waits before each start again (tests make them short).
     */
    constructor({ file, logger, onEvent = () => {}, script = new URL('./worker.js', import.meta.url), workerData = {}, WorkerClass = Worker, retryMs = RETRY_MS }) {
        this.file = file;
        this.logger = logger;
        this.onEvent = onEvent;
        this.script = script;
        this.workerData = workerData;
        this.WorkerClass = WorkerClass;
        this.retryMs = retryMs;
        /** starting | running | restarting | failed | stopped */
        this.state = 'stopped';
        this.problem = '';
        this.worker = undefined;
        this.pending = new Map();
        this.seq = 0;
        this.stops = [];
        this.retry = undefined;
        this.ready = undefined;
        this.wanted = false;
        /** Calls to make again on every start (the folders to search). */
        this.standing = new Map();
    }

    start() {
        this.wanted = true;
        if (this.worker) return;
        this.state = this.state === 'restarting' ? 'restarting' : 'starting';
        let worker;
        try {
            // node:sqlite says once that it is new; the index thread does not need to.
            worker = new this.WorkerClass(this.script, { workerData: { file: this.file, ...this.workerData }, execArgv: ['--disable-warning=ExperimentalWarning'] });
        } catch {
            try {
                worker = new this.WorkerClass(this.script, { workerData: { file: this.file, ...this.workerData } });
            } catch (error) {
                this.fail(`Recall could not start its index thread: ${String(error?.message ?? error).slice(0, 300)}`);
                return;
            }
        }
        this.worker = worker;
        this.lastError = '';
        let fatal = '';
        let resolveReady;
        this.ready = new Promise((resolve) => { resolveReady = resolve; });
        worker.on('message', (message) => {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'reply') {
                const call = this.pending.get(message.id);
                if (!call) return;
                this.pending.delete(message.id);
                clearTimeout(call.timer);
                if (message.ok) call.resolve(message.value);
                else call.reject(new Error(message.error?.message || 'Recall\'s index did not answer.'));
                return;
            }
            if (message.type === 'ready') {
                this.state = 'running';
                this.problem = '';
                resolveReady(true);
                for (const [op, args] of this.standing) this.call(op, args).catch(() => {});
                this.onEvent({ type: 'ready' });
                return;
            }
            if (message.type === 'fatal') fatal = String(message.text ?? '');
            this.onEvent(message);
        });
        worker.on('error', (error) => {
            this.logger?.warn?.(`recall: the index thread failed: ${String(error?.message ?? error).slice(0, 300)}`);
            this.lastError = String(error?.message ?? error).slice(0, 300);
        });
        worker.on('exit', (code) => {
            if (this.worker !== worker) return;
            this.worker = undefined;
            resolveReady(false);
            for (const [id, call] of this.pending) {
                clearTimeout(call.timer);
                call.reject(new Error('Recall\'s index stopped while answering. It starts again by itself; try again in a moment.'));
                this.pending.delete(id);
            }
            if (!this.wanted) {
                this.state = 'stopped';
                return;
            }
            if (fatal) {
                this.fail(fatal);
                return;
            }
            const now = Date.now();
            this.stops = [...this.stops.filter((t) => now - t < WINDOW_MS), now];
            const why = this.lastError ? ` (${this.lastError})` : ` (exit code ${code})`;
            if (this.stops.length > this.retryMs.length) {
                this.fail(`Recall's index thread stopped ${this.stops.length} times in ten minutes${why}, so it was left stopped. Restart DSH, or rebuild the index from Recall's page.`);
                return;
            }
            const wait = this.retryMs[this.stops.length - 1];
            this.state = 'restarting';
            this.problem = `Recall's index thread stopped${why}; it starts again in ${Math.max(1, Math.round(wait / 1000))} second${Math.round(wait / 1000) > 1 ? 's' : ''}.`;
            this.logger?.warn?.(`recall: ${this.problem}`);
            this.onEvent({ type: 'restarting', text: this.problem });
            this.retry = setTimeout(() => {
                this.retry = undefined;
                if (this.wanted) this.start();
            }, wait);
            this.retry.unref?.();
        });
    }

    fail(text) {
        this.state = 'failed';
        this.problem = text;
        this.wanted = false;
        this.logger?.warn?.(`recall: ${text}`);
        this.onEvent({ type: 'failed', text });
    }

    /** Start again after it failed (the person asked). */
    revive() {
        this.stops = [];
        this.problem = '';
        this.state = 'starting';
        this.start();
    }

    /**
     * Ask the index thread; the answer, or an Error in words.
     * @param {string} op
     * @param {object} [args]
     * @param {{ timeoutMs?: number, standing?: boolean }} [options] - standing: make this call again after every restart.
     */
    call(op, args = {}, { timeoutMs = 15000, standing = false } = {}) {
        if (standing) this.standing.set(op, args);
        const worker = this.worker;
        if (!worker || (this.state !== 'running' && !standing)) {
            const why = this.state === 'failed' ? this.problem : this.state === 'restarting' ? this.problem : 'Recall\'s index is starting. Try again in a moment.';
            return Promise.reject(new Error(why || 'Recall\'s index is not running.'));
        }
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('Recall\'s index took too long to answer. Try again in a moment.'));
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            try {
                worker.postMessage({ type: 'call', id, op, args });
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error(`Recall could not reach its index: ${String(error?.message ?? error).slice(0, 200)}`));
            }
        });
    }

    /** Stop the thread: it closes the index first (up to 3 seconds). */
    async stop() {
        this.wanted = false;
        clearTimeout(this.retry);
        this.retry = undefined;
        const worker = this.worker;
        if (!worker) {
            this.state = 'stopped';
            return;
        }
        if (this.state === 'running') {
            await Promise.race([this.call('close', {}, { timeoutMs: 3000 }).catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref?.())]);
        }
        try { await worker.terminate(); } catch { /* already gone */ }
        this.worker = undefined;
        this.state = 'stopped';
    }
}
