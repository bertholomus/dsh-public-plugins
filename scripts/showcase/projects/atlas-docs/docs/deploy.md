# Deploying the gateway

- Staging deploys from `main` on every merge.
- Production deploys from a release tag (`v2.3.0`), after the staging smoke test passes.
- Roll back by deploying the previous tag; the gateway keeps no state of its own.
