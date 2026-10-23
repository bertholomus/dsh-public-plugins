---
project: tide-ledger
tags: [tide-ledger, postgres]
---
# Schema migrations

Write a migration with `ledgerctl migrate new <name>`. CI runs it against a copy of last night's backup before it may merge. Never run one during the month-end close.

A migration that locks a big table (entries, accounts) goes out on a weekend, announced in #ledger a week ahead.
