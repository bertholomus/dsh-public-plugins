---
project: tide-ledger
tags: [tide-ledger, finance]
---
# Month-end close

The close runs on the first working day of each month at 06:00 UTC, with `ledgerctl close --month YYYY-MM`. Finance checks the totals and signs off by noon. Until they do, there are no migrations and no deploys.
