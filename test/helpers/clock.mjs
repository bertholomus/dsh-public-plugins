/**
 * A clock and timers the suite's tests move by hand, so a ten-minute idle
 * wait or a half-hour retry runs in a moment and always in the same order.
 */

/** Let promises, `setImmediate` work and what they start run to rest. */
export async function settle(rounds = 25) {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {number} [start] - the clock's first reading (a fixed Friday evening, Pacific time).
 */
export function manualClock(start = Date.UTC(2026, 9, 17, 4, 0, 0)) {
    let now = start;
    const timers = new Set();
    const clock = {
        now: () => now,
        /** `setTimeout` on this clock. */
        setTimer: (ms, fn) => {
            const timer = { at: now + Math.max(0, Number(ms) || 0), fn };
            timers.add(timer);
            return timer;
        },
        clearTimer: (timer) => {
            timers.delete(timer);
        },
        /** The watcher's `after(logger, label, ms, fn)`, on this clock. */
        after: (logger, label, ms, fn) => clock.setTimer(ms, () => {
            try {
                fn();
            } catch (error) {
                logger?.warn?.(`${label}: ${error?.message ?? error}`);
            }
        }),
        /** Timers still waiting, soonest first. */
        pending: () => [...timers].sort((a, b) => a.at - b.at),
        /** Move time on by `ms`, running each timer as it comes due, in order, and letting what it starts settle. */
        async advance(ms) {
            const until = now + ms;
            for (;;) {
                // What earlier steps started may set timers of its own: let it run first.
                await settle();
                const next = clock.pending().find((timer) => timer.at <= until);
                if (!next) break;
                timers.delete(next);
                now = Math.max(now, next.at);
                await next.fn();
            }
            now = until;
            await settle();
        },
    };
    return clock;
}
