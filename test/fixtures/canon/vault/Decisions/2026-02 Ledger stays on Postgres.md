---
kind: decision
project: tide-ledger
date: 2026-02-20
---
# Ledger stays on Postgres

**Decision:** tide-ledger stays on Postgres 16 instead of moving to a hosted ledger database.

**Why:** the month-end close joins entries across years, finance's reports are written in SQL, and we already know how to run, back up and restore Postgres.
