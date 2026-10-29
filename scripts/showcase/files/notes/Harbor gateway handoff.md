---
title: Harbor gateway handoff
---
# Harbor gateway handoff

## Doing now

Raising the burst limit from 40 to 60 for the partner API, and bringing the
runbook's rate-limit section in line with it.

## Next steps

1. Run the gateway tests: `npm test`.
2. Tag v2.3.1 and deploy it to staging first.
3. Watch the 429 rate for an hour before production.

## Gotchas

- The load balancer drops idle connections after 60 seconds. Keep the
  upstream keepalive at 30 seconds, or clients see connection resets every
  few minutes.
- The health check stays on port 8080; only HTTPS moved to 8443.
