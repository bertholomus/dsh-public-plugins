---
project: lantern-web
tags: [lantern-web, flags]
---
# Feature flags

Flags are declared in `src/flags.ts` and switched per environment in the flag service: `flagctl set <flag> --env prod on`.

A flag that has been on everywhere for 30 days is removed in the next clean-up.
