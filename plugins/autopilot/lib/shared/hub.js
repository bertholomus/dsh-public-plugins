/**
 * Change numbers for the suite's windows. Each plugin names a channel and
 * bumps it when what its window shows changes; a window holds one request
 * open (`wait`) and reads a plugin's state only when its number moves.
 * One open request per window serves every suite plugin, so nothing polls.
 *
 * @module suite/shared/hub
 */

export class Hub {
    constructor() {
        /** @type {Record<string, number>} */
        this.versions = {};
        /** @type {Set<() => void>} */
        this.waiters = new Set();
        /** Changes to one start of this process: a window that sees a new epoch reads everything again. */
        this.epoch = Date.now().toString(36);
    }

    /** Mark a channel changed. */
    bump(channel) {
        this.versions[channel] = (this.versions[channel] ?? 0) + 1;
        const waiters = [...this.waiters];
        this.waiters.clear();
        for (const wake of waiters) {
            try { wake(); } catch { /* a closed request never stops the others */ }
        }
    }

    snapshot() {
        return { epoch: this.epoch, versions: { ...this.versions } };
    }

    /** Whether `since` (a window's last snapshot) is behind on any channel. */
    behind(since) {
        if (!since || since.epoch !== this.epoch) return true;
        const seen = since.versions ?? {};
        return Object.entries(this.versions).some(([channel, n]) => (seen[channel] ?? 0) !== n);
    }

    /**
     * Answer at once when `since` is behind, else when a channel moves or
     * `timeoutMs` passes, whichever is first.
     * @param {{ epoch?: string, versions?: Record<string, number> } | undefined} since
     * @param {number} timeoutMs
     * @param {AbortSignal} [signal]
     */
    wait(since, timeoutMs, signal) {
        if (this.behind(since)) return Promise.resolve(this.snapshot());
        return new Promise((resolve) => {
            let timer;
            const done = () => {
                clearTimeout(timer);
                this.waiters.delete(done);
                signal?.removeEventListener?.('abort', done);
                resolve(this.snapshot());
            };
            timer = setTimeout(done, Math.max(0, timeoutMs));
            timer.unref?.();
            this.waiters.add(done);
            signal?.addEventListener?.('abort', done, { once: true });
        });
    }

    /** Answer every open request now (the plugin is stopping). */
    close() {
        const waiters = [...this.waiters];
        this.waiters.clear();
        for (const wake of waiters) {
            try { wake(); } catch { /* ignore */ }
        }
    }
}
