---
project: lantern-api
tags: [lantern-api, release]
aliases: [Lantern release checklist, Shipping lantern-api]
---
# Release checklist

lantern-api releases go out on Wednesdays, before 15:00 Pacific, and never on a Friday.

1. Run `make verify`: unit tests, lint, and the contract tests against lantern-web's fixtures.
2. Bump the version in `version.txt` and add the release notes to `CHANGELOG.md`.
3. Tag the commit `vX.Y.Z` and push the tag. CI builds the image and deploys it to staging.
4. After an hour on staging with no new errors, promote it with `deployctl promote lantern-api --to prod`.

If a release goes wrong, see the runbook for rolling back a lantern-api release.
