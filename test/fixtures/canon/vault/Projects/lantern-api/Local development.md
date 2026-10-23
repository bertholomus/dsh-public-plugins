---
project: lantern-api
---
# Local development

You need Go 1.23 and Docker.

- `make deps` starts NATS and Postgres in Docker Compose.
- `make seed` loads the test accounts.
- `make dev` runs the service and reloads it when a file changes.

`make test` runs the unit tests; `make verify` runs everything CI runs. The contract tests need lantern-web's fixtures, which `make deps` fetches.
