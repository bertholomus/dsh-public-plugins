# Runbook

## The gateway answers 429 too often
The rate limit is per client: 600 requests a minute with bursts of 40 (`[limits]` in `gateway.toml`).
Raise `burst` before `requests_per_minute`; most spikes are short.

## Health checks fail
The load balancer reads port 8080. A restart of the gateway takes about 3 seconds.
