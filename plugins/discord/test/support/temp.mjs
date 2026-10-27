/**
 * Temporary folders for one test file, removed when the file's tests are
 * done, so `npm test` leaves nothing behind in the system's temp folder.
 *
 * @module test/support/temp
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const made = [];

after(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A new empty folder in the system's temp folder, removed after the file's tests.
 * @param {string} prefix - the start of its name, such as `discord-store-`.
 * @returns {string} its path.
 */
export function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
}
