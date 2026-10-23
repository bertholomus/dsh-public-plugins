/**
 * Temp folders for a test file, removed when its tests end, so a run leaves
 * nothing behind in the system's temp folder.
 */
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];

// Imported at a file's top, so the hook belongs to the whole file, not to one test.
after(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new temp folder named after its use, removed when the file's tests end. */
export function tempDir(label) {
    const dir = mkdtempSync(join(tmpdir(), `${label}-`));
    made.push(dir);
    return dir;
}
