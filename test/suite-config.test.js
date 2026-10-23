/**
 * A wrong type in DSH's profile never stops a suite plugin.
 *
 * DSH checks a plugin's entry against its `Config` schema before the plugin
 * starts: a value of the wrong type (a number in quotes, "yes" for a switch,
 * one folder where a list belongs) makes the plugin fail to start, with only
 * "Problem" in Plugins, and is dropped without a word on a live edit. So
 * every key of every suite plugin's schema takes any value, with its default,
 * and the plugin's own `checkConfig` names a wrong type in words, as it names
 * a value out of range: the plugin starts, does no work, and its page says
 * which setting is wrong and where to change it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sessionWatch from '../plugins/session-watch/lib/config.js';
import * as autopilot from '../plugins/autopilot/lib/config.js';
import * as decisions from '../plugins/decisions/lib/config.js';
import * as proof from '../plugins/proof/lib/config.js';
import * as recall from '../plugins/recall/lib/config.js';
import { checkCommand } from '../plugins/decisions/lib/mirror.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The keys of a plugin's `Config` schema in its lib/index.js, each with the schema text it is given. */
function schemaKeys(plugin) {
    const text = readFileSync(`${ROOT}plugins/${plugin}/lib/index.js`, 'utf8');
    const start = text.indexOf('export const Config = z.object({');
    assert.ok(start >= 0, `${plugin}: lib/index.js has a Config schema`);
    const end = text.indexOf('\n});', start);
    const block = text.slice(start, end)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    return [...block.matchAll(/^\s+(\w+):\s*(.+?),?\s*$/gm)].map(([, key, schema]) => ({ key, schema }));
}

for (const plugin of ['session-watch', 'autopilot', 'decisions', 'proof', 'canon', 'recall']) {
    test(`${plugin}: every key of its Config schema takes any value, so a wrong type never stops it at start`, () => {
        const keys = schemaKeys(plugin);
        assert.ok(keys.length > 0, `${plugin}: its Config has keys`);
        for (const { key, schema } of keys) {
            assert.match(schema, /^(?:live\()?(?:keyRef\()?z\.any\(\)\)?\.default\(.+\)\)?$/, `${plugin}: ${key} is ${schema}`);
        }
    });
}

/** A value of the wrong type for a setting whose default is `value`. */
function wrongType(value) {
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.length ? String(value[0]) : 'one';
    if (typeof value === 'string') return 5;
    return 'text';
}

const PLUGINS = [
    ['session-watch', sessionWatch, [], ')'],
    ['autopilot', autopilot, [], ')'],
    // Checked by the mirror alone, while new cards go to a command (below).
    ['decisions', decisions, ['mirrorCommand'], ')'],
    ['proof', proof, [], ')'],
    // Recall says after the value what kind of value it is: (it is "yes", which is text).
    ['recall', recall, [], ', '],
];

for (const [plugin, config, elsewhere, after] of PLUGINS) {
    test(`${plugin}: a wrong type for each setting is named in words, with the value as the profile has it`, () => {
        assert.doesNotThrow(() => config.checkConfig({ ...config.DEFAULTS }), `${plugin}: its defaults are right`);
        const keys = schemaKeys(plugin).map((k) => k.key);
        assert.deepEqual([...keys].sort(), Object.keys(config.DEFAULTS).sort(), `${plugin}: DEFAULTS lists every key of its schema`);
        for (const key of keys.filter((k) => !elsewhere.includes(k))) {
            const value = wrongType(config.DEFAULTS[key]);
            assert.throws(() => config.checkConfig({ ...config.DEFAULTS, [key]: value }), (error) => {
                assert.equal(error.name, 'SettingError', `${plugin}: ${key}`);
                assert.equal(error.key, key, `${plugin}: ${key}`);
                assert.ok(error.message.includes(`(${key})`), `${plugin}: the words name ${key}: ${error.message}`);
                assert.ok(error.message.includes(`(it is ${JSON.stringify(value)}${after}`), `${plugin}: the words show the value: ${error.message}`);
                return true;
            }, `${plugin}: ${key} = ${JSON.stringify(value)}`);
        }
    });
}

test('decisions: a command given as one string instead of a list is named by the mirror, in words that say where to change it', () => {
    assert.throws(() => checkCommand('/usr/local/bin/notify-me --from dsh'), /^Error: The command must be a list of the program's full path and then its arguments, such as \[\/usr\/local\/bin\/notify-me, --from, dsh\] \(it is "\/usr\/local\/bin\/notify-me --from dsh"\): change mirrorCommand in Decisions' entry in DSH's profile \(cordis\.patch\.yml\)$/);
});
