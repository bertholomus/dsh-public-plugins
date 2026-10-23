/**
 * Small guards for the suite's host halves: no handler of theirs may throw
 * into DSH. A listener that throws inside DSH's event dispatch can fail the
 * host call that emitted the event (a session's turn, a tool call), so every
 * listener and timer the suite installs runs through `guard`.
 *
 * @module suite/shared/safe
 */

/** A short, readable line for an error: its message, never a stack, at most `max` characters. */
export function errorText(error, max = 300) {
    let text;
    if (error instanceof Error) text = error.message || error.name;
    else if (typeof error === 'string') text = error;
    else {
        try { text = JSON.stringify(error); } catch { text = String(error); }
    }
    text = String(text ?? 'unknown error').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Cut a string to at most `max` characters, at a word when one is near, with "…". */
export function clip(text, max) {
    if (typeof text !== 'string') return '';
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    const cut = flat.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Wrap a handler so nothing it does reaches the caller: a thrown error or a
 * rejected promise is logged as one warning line and swallowed.
 * @template {(...args: any[]) => any} F
 * @param {{ warn: Function } | undefined} logger
 * @param {string} label - what the handler is, for the log line.
 * @param {F} fn
 * @returns {(...args: Parameters<F>) => void}
 */
export function guard(logger, label, fn) {
    return (...args) => {
        try {
            const result = fn(...args);
            if (result && typeof result.then === 'function') {
                result.then(undefined, (error) => logger?.warn?.(`${label}: ${errorText(error)}`));
            }
        } catch (error) {
            logger?.warn?.(`${label}: ${errorText(error)}`);
        }
    };
}

/** Run `fn` and give its value, or `fallback` when it throws. */
export function attempt(fn, fallback) {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

/** A timer that never keeps the process alive and never throws into it. */
export function later(logger, label, ms, fn) {
    const timer = setTimeout(guard(logger, label, fn), Math.max(0, ms));
    timer.unref?.();
    return timer;
}

/** Whether a value is a plain object (not null, not an array). */
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
