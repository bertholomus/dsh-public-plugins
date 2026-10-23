#!/usr/bin/env node
/**
 * Copy the suite's shared code into each suite plugin, so every package
 * stands on its own when DSH installs it:
 *
 * - shared/host/*.js → plugins/<plugin>/lib/shared/ (byte for byte);
 * - the block between the kit markers in shared/client-kit.js → the same
 *   markers in plugins/<plugin>/lib/client.js;
 * - a few files one plugin borrows from another (BORROWED), byte for byte.
 *
 * `--check` changes nothing and exits 1 when a copy differs (npm test runs it).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The suite's plugins, in build order; ones not written yet are skipped. */
export const SUITE = ['session-watch', 'autopilot', 'decisions', 'agent-terminals', 'proof', 'canon', 'recall'];
/**
 * Files a suite plugin uses from another plugin of this repository, copied
 * byte for byte: [source, plugin, target inside the plugin]. Proof's check
 * threads refuse what the coordinator's send reader calls a send.
 */
export const BORROWED = [['plugins/coordinator/lib/sends.js', 'proof', 'lib/shared/sends.js']];
export const KIT_START = '// <suite-kit>';
export const KIT_END = '// </suite-kit>';

/** The kit block (markers included) from a file's text, or undefined. */
export function kitBlock(text) {
    const start = text.indexOf(KIT_START);
    const end = text.indexOf(KIT_END);
    if (start < 0 || end < start) return undefined;
    return text.slice(start, end + KIT_END.length);
}

/** Every copy the suite should have: [{ target, text }]. */
export function plannedCopies() {
    const out = [];
    const hostDir = join(root, 'shared', 'host');
    const hostFiles = readdirSync(hostDir).filter((name) => name.endsWith('.js')).sort();
    const kit = kitBlock(readFileSync(join(root, 'shared', 'client-kit.js'), 'utf8'));
    for (const plugin of SUITE) {
        const dir = join(root, 'plugins', plugin);
        if (!existsSync(join(dir, 'package.json'))) continue;
        for (const name of hostFiles) out.push({ target: join(dir, 'lib', 'shared', name), text: readFileSync(join(hostDir, name), 'utf8') });
        const client = join(dir, 'lib', 'client.js');
        if (kit && existsSync(client)) {
            const text = readFileSync(client, 'utf8');
            const current = kitBlock(text);
            if (current !== undefined) out.push({ target: client, text: text.replace(current, () => kit) });
        }
    }
    for (const [source, plugin, target] of BORROWED) {
        const dir = join(root, 'plugins', plugin);
        if (existsSync(join(dir, 'package.json'))) out.push({ target: join(dir, target), text: readFileSync(join(root, source), 'utf8') });
    }
    return out;
}

function main() {
    const check = process.argv.includes('--check');
    const stale = [];
    for (const { target, text } of plannedCopies()) {
        const now = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
        if (now === text) continue;
        stale.push(target.slice(root.length + 1));
        if (!check) {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, text);
        }
    }
    if (check && stale.length > 0) {
        console.error(`These copies of the shared code are out of date; run node scripts/sync-shared.mjs:\n${stale.map((p) => `  ${p}`).join('\n')}`);
        process.exit(1);
    }
    if (!check) console.log(stale.length ? `Updated:\n${stale.map((p) => `  ${p}`).join('\n')}` : 'All copies are current.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
