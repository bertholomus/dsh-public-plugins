---
tags: [on-call, lantern-api, quartz-cache]
aliases: [Paging, Who is on call]
---
# On-call

Two rotations, each a week long:

- **Lantern** (lantern-api and lantern-web) hands over on Mondays at 10:00 Pacific.
- **Platform** (harbor-gateway, quartz-cache and tide-ledger) hands over on Thursdays at 09:00 Pacific.

Page whoever is on call with `pagectl page --team lantern` or `pagectl page --team platform`. A page nobody acknowledges within 10 minutes goes to the rotation's second person.

At handover, write what is still open in the #oncall channel.
