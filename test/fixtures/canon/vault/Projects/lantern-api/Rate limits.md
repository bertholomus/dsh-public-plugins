---
project: lantern-api
tags: [lantern-api, limits]
---
# Rate limits

Each API key may make 100 requests a second, with bursts of up to 200. Past that, lantern-api answers `429 Too Many Requests` with a `Retry-After` header in seconds.

The limits live in `config/limits.yaml`. One key's limit can be raised there under `overrides:`, with a line in the pull request saying who asked and why.

## Request size

Request bodies are capped at 1 MB. Larger uploads go to the blob service first, and the request passes a link to them.
