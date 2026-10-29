import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanced, balances, cents } from '../src/ledger.js';

const rent = { lines: [{ account: 'Rent', side: 'debit', amount: '1200.00' }, { account: 'Bank', side: 'credit', amount: '1200.00' }] };
const sale = { lines: [{ account: 'Bank', side: 'debit', amount: '89.90' }, { account: 'Sales', side: 'credit', amount: '89.90' }] };

test('amounts become whole cents', () => assert.equal(cents('0.1') + cents('0.2'), 30));
test('a balanced entry balances', () => assert.equal(balanced(rent), true));
test('an entry with one side short does not', () => assert.equal(balanced({ lines: [rent.lines[0]] }), false));
test('balances add up per account', () => assert.deepEqual([...balances([rent, sale])], [['Rent', 120000], ['Bank', -111010], ['Sales', -8990]]));
