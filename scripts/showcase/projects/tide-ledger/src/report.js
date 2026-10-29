import { balances } from './ledger.js';

/** One line per account, largest balance first, as "Account  1,234.56". */
export function monthReport(entries) {
    return [...balances(entries)]
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .map(([account, value]) => `${account.padEnd(16)}${(value / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
}
