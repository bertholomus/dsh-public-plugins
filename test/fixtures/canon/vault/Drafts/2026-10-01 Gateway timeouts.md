---
title: Gateway timeouts
status: draft
kind: gotcha
created: "2026-10-01T17:20:00.000Z"
source:
  session: fixture-session-1
  turn: 4
  folder: "/work/Projects/harbor-gateway"
---
# Gateway timeouts

The harbor gateway drops idle connections after 60 seconds; clients that poll must send a keepalive.
