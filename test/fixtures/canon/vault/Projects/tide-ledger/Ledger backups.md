---
status: active
project: tide-ledger
tags: [tide-ledger, backups, postgres]
---
# Ledger backups

The ledger's Postgres database listens on port 5432 and is backed up every night at 02:00 UTC to the tide-backups bucket.

To restore, run `ledgerctl restore --date YYYY-MM-DD` on the standby, then make the standby the main database.
