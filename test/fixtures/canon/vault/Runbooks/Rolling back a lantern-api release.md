---
tags: [runbook, lantern-api]
---
# Rolling back a lantern-api release

1. Find the last good tag in `CHANGELOG.md`, or with `deployctl history lantern-api`.
2. Run `deployctl rollback lantern-api --to <tag>`. It takes about 4 minutes, one zone at a time.
3. Say in #lantern what was rolled back and why, and open an incident if users saw errors.

This does not roll back database migrations: if the release had one, ask the owner first.
