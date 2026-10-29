/** Amounts are whole cents, so sums never drift. */
export const cents = (amount) => Math.round(Number(amount) * 100);

/** A ledger entry balances when its debits equal its credits. */
export function balanced(entry) {
    const debit = entry.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + cents(l.amount), 0);
    const credit = entry.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + cents(l.amount), 0);
    return debit === credit;
}

/** Each account's balance after the entries, in cents. */
export function balances(entries) {
    const out = new Map();
    for (const entry of entries) {
        for (const line of entry.lines) {
            const sign = line.side === 'debit' ? 1 : -1;
            out.set(line.account, (out.get(line.account) ?? 0) + sign * cents(line.amount));
        }
    }
    return out;
}
