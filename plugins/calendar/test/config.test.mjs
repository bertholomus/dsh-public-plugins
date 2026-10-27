// The plugin's settings, checked in words (lib/config.js): a wrong value never stops the plugin, each one is
// named with what it must be and what the plugin does meanwhile, and the safe choice holds while one is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, checkConfig, dataPath, plainFailure } from '../lib/config.js';
import { localZone } from '../lib/zones.js';

const INDEX = fileURLToPath(new URL('../lib/index.js', import.meta.url));

test('config: every key of the schema takes any value with its default, so a wrong type never stops the plugin at start', () => {
    const text = readFileSync(INDEX, 'utf8');
    const start = text.indexOf('export const Config = z.object({');
    assert.ok(start >= 0);
    const block = text.slice(start, text.indexOf('\n});', start)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const keys = [...block.matchAll(/^\s+(\w+):\s*(.+?),?\s*$/gm)].map(([, key, schema]) => ({ key, schema }));
    assert.ok(keys.length >= 12, `keys: ${keys.map((k) => k.key).join(', ')}`);
    for (const { key, schema } of keys) assert.match(schema, /^z\.any\(\)\.default\(.+\)$/, `${key} is ${schema}`);
    // The defaults in the schema are the ones the check uses.
    for (const [key, value] of Object.entries(DEFAULTS)) {
        assert.ok(block.includes(`${key}: z.any().default(${JSON.stringify(value).replaceAll('"', '\'')})`), `${key}'s default is ${JSON.stringify(value)}`);
    }
});

test('config: nothing set is every default, with no problem', () => {
    const { settings, problems } = checkConfig({});
    assert.deepEqual(problems, []);
    assert.deepEqual(settings, { ...DEFAULTS });
    assert.deepEqual(checkConfig(undefined).settings, { ...DEFAULTS });
});

test('config: right values are kept as given', () => {
    const { settings, problems } = checkConfig({
        enabled: false, tools: false, askBeforeEmails: false, reminders: false, agentChanges: 'off', syncMinutes: 1440, timeZone: ' Europe/Berlin ',
        storeFile: '/tmp/cal/calendar.json', logFile: '', googleClientId: '123-abc.apps.googleusercontent.com',
        googleClientSecretRef: 'MY_SECRET', microsoftClientId: '11111111-2222-3333-4444-555555555555', microsoftTenant: 'contoso.onmicrosoft.com',
        googleApiBase: 'http://127.0.0.1:9/',
    });
    assert.deepEqual(problems, []);
    assert.equal(settings.enabled, false);
    assert.equal(settings.tools, false);
    assert.equal(settings.askBeforeEmails, false);
    assert.equal(settings.reminders, false);
    assert.equal(settings.agentChanges, 'off');
    assert.equal(settings.syncMinutes, 1440);
    assert.equal(settings.timeZone, 'Europe/Berlin');
    assert.equal(settings.logFile, '', 'an empty log file keeps no log');
    assert.equal(settings.microsoftTenant, 'contoso.onmicrosoft.com');
    assert.equal(settings.googleApiBase, 'http://127.0.0.1:9/');
    assert.equal(checkConfig({ syncMinutes: 5 }).settings.syncMinutes, 5);
    for (const tenant of ['common', 'organizations', 'consumers', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']) assert.equal(checkConfig({ microsoftTenant: tenant }).problems.length, 0, tenant);
});

test('config: a wrong type or value is named in words, with what the plugin does meanwhile, and the safe choice holds', () => {
    const { settings, problems } = checkConfig({
        enabled: 'no', tools: 'yes', askBeforeEmails: 'false', reminders: 'on', agentChanges: 'sometimes', syncMinutes: '30', timeZone: 'Mars/Phobos',
        storeFile: 3, logFile: false, googleClientId: 'not-a-client', googleClientSecretRef: 'two words', microsoftClientId: 'abc', microsoftTenant: 5,
        microsoftGraphBase: 42,
    });
    const said = Object.fromEntries(problems.map((p) => [p.key, p.text]));
    assert.deepEqual(Object.keys(said).sort(), ['agentChanges', 'askBeforeEmails', 'enabled', 'googleClientId', 'googleClientSecretRef', 'logFile',
        'microsoftClientId', 'microsoftGraphBase', 'microsoftTenant', 'reminders', 'storeFile', 'syncMinutes', 'timeZone', 'tools']);
    // Agents get the safe choice while a setting about them is wrong.
    assert.equal(settings.tools, false);
    assert.equal(settings.agentChanges, 'ask');
    assert.equal(settings.askBeforeEmails, true);
    // A touched off switch that isn't true or false means off: the calendar stops, and says why.
    assert.equal(settings.enabled, false);
    // The rest take their defaults.
    assert.equal(settings.reminders, true);
    assert.equal(settings.syncMinutes, 15);
    assert.equal(settings.timeZone, '');
    assert.equal(settings.storeFile, DEFAULTS.storeFile);
    assert.equal(settings.logFile, DEFAULTS.logFile);
    assert.equal(settings.microsoftTenant, 'common');
    assert.equal(settings.googleClientId, '');
    assert.equal('microsoftGraphBase' in settings, false);
    assert.equal(said.tools, 'tools must be true or false (it is "yes"); chats get no calendar tools until it\'s fixed.');
    assert.equal(said.agentChanges, 'agentChanges must be "preset", "ask" or "off" (it is "sometimes"); every change from a chat asks you first until it\'s fixed.');
    assert.equal(said.syncMinutes, 'syncMinutes must be a whole number of minutes from 5 to 1440 (it is "30"); the calendar uses 15 until it\'s fixed.');
    assert.equal(said.timeZone, `timeZone must be a time zone such as Europe/Berlin, or empty for this computer's (it is "Mars/Phobos"); the calendar uses this computer's zone (${localZone()}) until it's fixed.`);
    assert.equal(said.enabled, 'enabled must be true or false (it is "no"); the calendar is switched off until it\'s fixed.');
    assert.equal(said.reminders, 'reminders must be true or false (it is "on"); reminders show in DSH until it\'s fixed.');
    for (const off of ['false', 'true', 0, 1, 'off', []]) assert.equal(checkConfig({ enabled: off }).settings.enabled, false, JSON.stringify(off));
    assert.match(said.askBeforeEmails, /it is "false"\); a chat's change that emails anyone, or reaches their Google calendars, asks you first until it's fixed\.$/);
    assert.match(said.storeFile, /^storeFile must be a file path \(it is 3\)/);
});

test('config: a sync interval outside 5 minutes to a day is refused, never left to a timer that would fire at once', () => {
    for (const minutes of [4, 0, -5, 1441, 100000, 7.5, Number.NaN]) {
        const { settings, problems } = checkConfig({ syncMinutes: minutes });
        assert.equal(settings.syncMinutes, 15, String(minutes));
        assert.equal(problems[0]?.key, 'syncMinutes', String(minutes));
    }
});

test('config: data paths are in DSH\'s data folder, and an old setting under the home\'s DSH folder follows it', () => {
    const home = join('/tmp', 'dsh-test-home');
    assert.equal(dataPath('calendar/calendar.json', home), join(home, 'calendar', 'calendar.json'));
    assert.equal(dataPath(`~/${'.dsh'}/calendar/calendar.json`, home), join(home, 'calendar', 'calendar.json'));
    assert.equal(dataPath(`~/${'.dsh'}`, home), home);
    assert.equal(dataPath(`~/${'.dsh'}-other/x.json`, home), join(homedir(), `${'.dsh'}-other`, 'x.json'), 'another folder is not DSH\'s');
    assert.equal(dataPath('~/Calendars/c.json', home), join(homedir(), 'Calendars', 'c.json'));
    assert.equal(dataPath('/var/tmp/c.json', home), '/var/tmp/c.json');
    assert.equal(dataPath('', home), '');
    assert.equal(dataPath('relative.json'), 'relative.json', 'without DSH\'s folder, a relative path stays as it is');
});

test('config: an unexpected failure says what went wrong without a private path', () => {
    assert.equal(plainFailure(new Error('EACCES: permission denied, open \'/Users/someone/.dsh/calendar/events/cal-1.json\'')), 'EACCES: permission denied, open \'cal-1.json\'');
    assert.equal(plainFailure(new Error('ENOENT: no such file or directory, rename /a/b/c.tmp -> /a/b/c')), 'ENOENT: no such file or directory, rename c.tmp -> c');
    assert.equal(plainFailure(new Error('see https://example.com/a/b for help')), 'see https://example.com/a/b for help');
    assert.equal(plainFailure(new Error('')), 'Something went wrong.');
    assert.equal(plainFailure('x'.repeat(500)).length, 300);
});
