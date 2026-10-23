---
project: lantern-web
tags: [lantern-web, deploy]
---
# Deploying lantern-web

Every merge to `main` deploys: CI runs `npm run build` and uploads `dist/` to the `lantern-web-static` bucket.

The CDN keeps files for 5 minutes, so a change reaches users within 5 minutes. `cdnctl purge lantern-web` clears the CDN at once.

To roll back, run the deploy job again on the last good commit.
