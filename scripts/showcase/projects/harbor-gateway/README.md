# harbor-gateway

The edge gateway in front of the Harbor services. It routes `/api/orders` and `/api/ledger` to their upstreams,
limits each client to 600 requests a minute (bursts of 40), and answers health checks on port 8080.

    npm test      # router and rate-limit tests
    npm start     # listens on 8443

Settings live in `gateway.toml`.
