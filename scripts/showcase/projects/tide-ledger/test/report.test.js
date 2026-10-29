import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthReport } from '../src/report.js';

const entries = [
    { lines: [{ account: 'Rent', side: 'debit', amount: '1200' }, { account: 'Bank', side: 'credit', amount: '1200' }] },
    { lines: [{ account: 'Bank', side: 'debit', amount: '89.9' }, { account: 'Sales', side: 'credit', amount: '89.9' }] },
];

test('the largest balance comes first', () => assert.match(monthReport(entries)[0], /^Rent/));
test('amounts show two decimals', () => assert.match(monthReport(entries)[2], /-89\.90$/));
test('every account has one line', () => assert.equal(monthReport(entries).length, 3));
