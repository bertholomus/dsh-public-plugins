import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

for (const f of ['plugins/dsh-site/lib/index.js', 'plugins/dsh-site/lib/cidr.js', 'plugins/session-bridge/lib/index.js', ...['index','client','router','store','llm','titles','split','tools','trace'].map((n) => `plugins/discord/lib/${n}.js`), ...['index','projects','store','settings','prompts','tools'].map((n) => `plugins/coordinator/lib/${n}.js`), ...['index','notifier','backends','remote','client'].map((n) => `plugins/notifications/lib/${n}.js`), ...['index','categories','store','plan','remote','client'].map((n) => `plugins/categories/lib/${n}.js`), ...['index','manager','store','model','zones','http','recur','ical','expand','oauth','remote','tools','args','policy','client','sources/index','sources/local','sources/subscription','sources/caldav','sources/google','sources/microsoft'].map((n) => `plugins/calendar/lib/${n}.js`), ...['index','config','fold','watch','remote','client'].map((n) => `plugins/session-watch/lib/${n}.js`), ...['index','config','pilot','notes','page','remote','client'].map((n) => `plugins/autopilot/lib/${n}.js`), ...['index','config','cards','holds','inbox','mirror','page','remote','client'].map((n) => `plugins/decisions/lib/${n}.js`), 'shared/client-kit.js', 'scripts/sync-shared.mjs', 'scripts/e2e.mjs', 'test/e2e/harness.mjs', 'test/e2e/fake-model.mjs', 'plugins/autopilot/test/e2e/run.mjs', 'plugins/decisions/test/e2e/run.mjs']) {
    test(`syntax ${f}`, () => {
        assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', f]));
    });
}
