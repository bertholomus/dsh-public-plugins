#!/usr/bin/env node
/**
 * Install the DSH builds the real-DSH test runs on, each in its own folder
 * under .e2e/ (ignored by git): `npm run e2e:install`. Skips a build that is
 * already there. The installed app's DSH needs no install: scripts/e2e.mjs
 * finds it in /Applications.
 *
 *   npm run e2e:install                 0.2.0-rc.2 and 0.2.1-rc.1
 *   npm run e2e:install -- 0.2.2-rc.1   another build
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../test/e2e/harness.mjs';

const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['0.2.0-rc.2', '0.2.1-rc.1'];
let failed = 0;
for (const version of versions) {
    const dir = join(repoRoot, '.e2e', `dsh-${version}`);
    if (existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
        console.log(`DSH ${version}: already in ${dir}`);
        continue;
    }
    mkdirSync(dir, { recursive: true });
    console.log(`DSH ${version}: installing into ${dir}`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['install', '--prefix', dir, '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`], { stdio: 'inherit' });
    if (result.status !== 0) {
        failed += 1;
        console.error(`DSH ${version}: npm install failed (exit ${result.status})`);
    }
}
process.exit(failed === 0 ? 0 : 1);
