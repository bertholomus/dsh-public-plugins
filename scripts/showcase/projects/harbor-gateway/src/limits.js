/** A token bucket per client: `take(client, now)` says whether a request may pass. */
export function bucket({ perMinute, burst }) {
    const clients = new Map();
    const rate = perMinute / 60000;
    return {
        take(client, now = Date.now()) {
            const b = clients.get(client) ?? { tokens: burst, at: now };
            b.tokens = Math.min(burst, b.tokens + (now - b.at) * rate);
            b.at = now;
            const ok = b.tokens >= 1;
            if (ok) b.tokens -= 1;
            clients.set(client, b);
            return ok;
        },
    };
}
