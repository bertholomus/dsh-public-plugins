/**
 * The only writes Canon ever makes into the vault, each allowed only by its
 * settings:
 *
 * - **Capture** (`access: drafts`): one new note in the drafts folder, with
 *   frontmatter `status: draft`, its kind, and where it came from (session,
 *   turn, folder). A fresh name every time (" 2", " 3" when one is taken),
 *   written with an exclusive create, so nothing is ever overwritten; the
 *   drafts folder and the folders on the way to it may not be links, and
 *   the file is checked to have landed inside it.
 * - **Promote** (`access: drafts` and `promote: true`, and only when a
 *   person presses Promote on Canon's page): the draft moves out of the
 *   drafts folder (which is never added to turns) into the promoted notes'
 *   folder, with `status: active` and the time it was promoted; every other
 *   line stays as written. The new file is made first (exclusive create),
 *   then the draft is removed; if that fails the new file goes again.
 *
 * Every refusal is a sentence that says why and what a person can do.
 *
 * @module dsh-plugin-canon/drafts
 */
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { within } from './config.js';
import { setFields, yamlLines } from './frontmatter.js';
import { folderKeys } from './search.js';

/** The kinds of note an agent may save. */
export const KINDS = Object.freeze(['decision', 'fact', 'howto', 'gotcha']);
export const MAX_TITLE = 120;
export const MAX_BODY = 20000;
const MAX_TAGS = 10;
/** A draft larger than this is not promoted (it is not a note Canon wrote). */
const MAX_PROMOTE_BYTES = 2 * 1024 * 1024;

/** A refusal: `{ ok: false, reason }`, the reason a sentence for people and models. */
const no = (reason) => ({ ok: false, reason });

/** The words for why Canon may not write, or undefined when it may. */
export function writeRefusal(settings, what) {
    if (!settings.vault) return `no canon vault is set. A person sets one in Canon's settings (“Vault folder”).`;
    if (settings.access !== 'drafts') {
        return what === 'promote'
            ? 'Canon is read only (“What Canon may write” is Read only). To promote drafts, set it to Drafts and turn on “Allow promoting drafts” in Canon\'s settings.'
            : 'Canon is read only (“What Canon may write” is Read only in Canon\'s settings). A person can allow drafts there.';
    }
    if (what === 'promote' && !settings.promote) {
        return 'promoting is off (“Allow promoting drafts” in Canon\'s settings). Turn it on to promote drafts; until then Promote changes nothing.';
    }
    return undefined;
}

/** A title as one line, or undefined when there is none. */
export function cleanTitle(title) {
    if (typeof title !== 'string') return undefined;
    const one = title.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return one && one.length <= MAX_TITLE ? one : undefined;
}

/** Tags as Obsidian writes them: letters, digits, _ - /, at most ten. */
export function cleanTags(tags) {
    if (tags === undefined || tags === null) return [];
    const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
    const out = [];
    for (const tag of list) {
        if (typeof tag !== 'string') continue;
        const t = tag.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_/-]/gu, '').replace(/^[-/]+|[-/]+$/g, '').toLowerCase().slice(0, 40);
        if (t && !/^\d+$/.test(t) && !out.includes(t)) out.push(t);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/** A file name from a title: letters, digits, spaces, - and _, at most 80 characters, never hidden. */
export function slugOf(title) {
    const slug = String(title ?? '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
    return slug.replace(/^[-_ ]+/, '') || 'Note';
}

/** Today as YYYY-MM-DD in the computer's own time zone. */
export function dayOf(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A folder inside the vault, made when missing; refused when it, or a
 * folder on the way to it, is a link or a file.
 * @param {string} root - the vault's real path.
 * @param {string} rel - a checked relative folder ('' for the vault itself).
 * @param {{ make?: boolean }} [options]
 * @returns {Promise<string>} its full path.
 */
export async function folderInVault(root, rel, { make = true } = {}) {
    let at = root;
    for (const part of rel ? rel.split('/') : []) {
        if (!part || part === '.' || part === '..' || part.startsWith('.')) throw new Error(`the folder ${rel} is not a plain folder inside the vault`);
        at = join(at, part);
        let st;
        try {
            st = await lstat(at);
        } catch (error) {
            if (error?.code !== 'ENOENT' || !make) throw error;
            await mkdir(at);
            st = await lstat(at);
        }
        if (st.isSymbolicLink()) throw new Error(`the folder ${rel} is a link, and Canon writes only into plain folders inside the vault`);
        if (!st.isDirectory()) throw new Error(`${rel} in the vault is a file, not a folder`);
    }
    const real = await realpath(at);
    if (!within(real, root)) throw new Error(`the folder ${rel} leads outside the vault`);
    return real;
}

/** Write `text` to a new file in `dir` named `name` (or "name 2", "name 3"…), never over one that is there. */
async function writeNew(dir, name, text) {
    const stem = name.replace(/\.md$/i, '');
    for (let n = 1; n <= 200; n += 1) {
        const file = join(dir, `${n === 1 ? stem : `${stem} ${n}`}.md`);
        try {
            await writeFile(file, text, { flag: 'wx', mode: 0o644 });
            return file;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
    }
    throw new Error('too many notes with this name already');
}

/** A vault path for a full path inside the vault (always with /). */
const relIn = (root, file) => file.slice(root.length + 1).split(sep).join('/');

/**
 * Save an agent's note as a draft.
 * @param {object} options
 * @param {{ vault: string, access: string, draftsFolder: string }} options.settings - as Canon uses them (config.js resolved).
 * @param {{ title?: unknown, body?: unknown, kind?: unknown, tags?: unknown }} options.note - the tool's arguments.
 * @param {{ sessionId?: string, turn?: number, folder?: string }} options.from - where it came from.
 * @param {() => number} [options.now]
 * @param {string} [options.home]
 * @returns {Promise<{ ok: true, path: string, title: string, kind: string } | { ok: false, reason: string }>}
 */
export async function capture({ settings, note, from = {}, now = Date.now, home = '' }) {
    const refused = writeRefusal(settings, 'capture');
    if (refused) return no(refused);
    const title = cleanTitle(note?.title);
    if (!title) return no(`give the note a title of 1 to ${MAX_TITLE} characters, on one line.`);
    const body = typeof note?.body === 'string' ? note.body.replace(/\r\n/g, '\n').trim() : '';
    if (!body) return no('give the note a body: what to remember, in a few lines.');
    if (body.length > MAX_BODY) return no(`the note is ${body.length} characters; keep it to ${MAX_BODY}.`);
    const kind = typeof note?.kind === 'string' ? note.kind.trim().toLowerCase() : '';
    if (!KINDS.includes(kind)) return no(`say what kind of note it is: ${KINDS.join(', ')}.`);
    const tags = cleanTags(note?.tags);
    let root;
    try {
        root = await realpath(settings.vault);
    } catch {
        return no('Canon cannot reach the vault folder now. A person can see why on Canon\'s page.');
    }
    let dir;
    try {
        dir = await folderInVault(root, settings.draftsFolder);
    } catch (error) {
        return no(`Canon cannot write into the drafts folder: ${String(error?.message ?? error).slice(0, 200)}.`);
    }
    const at = now();
    const repo = typeof from.folder === 'string' ? folderKeys(from.folder, home).repo : '';
    const head = yamlLines({
        title,
        status: 'draft',
        kind,
        ...(tags.length ? { tags } : {}),
        ...(repo ? { project: repo } : {}),
        created: new Date(at).toISOString(),
        source: {
            session: typeof from.sessionId === 'string' ? from.sessionId : undefined,
            turn: Number.isSafeInteger(from.turn) ? from.turn : undefined,
            folder: typeof from.folder === 'string' && from.folder ? from.folder : undefined,
            by: 'canon_capture',
        },
    });
    const text = `---\n${head.join('\n')}\n---\n\n# ${title}\n\n${body}\n`;
    let file;
    try {
        file = await writeNew(dir, `${dayOf(at)} ${slugOf(title)}.md`, text);
    } catch (error) {
        return no(`Canon could not write the draft: ${String(error?.message ?? error).slice(0, 200)}.`);
    }
    if (!within(await realpath(dirname(file)), dir)) {
        await unlink(file).catch(() => {});
        return no('the draft did not land inside the drafts folder, so Canon removed it again.');
    }
    return { ok: true, path: relIn(root, file), title, kind };
}

/** Whether a vault path names a note in the drafts folder (and nothing hidden or outside). */
export function isDraftPath(rel, draftsFolder) {
    if (typeof rel !== 'string' || rel.length > 600 || !/\.md$/i.test(rel) || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return false;
    const folder = draftsFolder.toLowerCase();
    return rel.toLowerCase().startsWith(`${folder}/`);
}

/**
 * Promote a draft to an active note: only from Canon's page, by a person.
 * @param {object} options
 * @param {{ vault: string, access: string, promote: boolean, draftsFolder: string, promoteFolder: string }} options.settings
 * @param {string} options.path - the draft's vault path.
 * @param {() => number} [options.now]
 * @returns {Promise<{ ok: true, from: string, path: string, title?: string } | { ok: false, reason: string }>}
 */
export async function promote({ settings, path, now = Date.now }) {
    const refused = writeRefusal(settings, 'promote');
    if (refused) return no(refused);
    if (!isDraftPath(path, settings.draftsFolder)) return no(`that is not a note in the drafts folder (${settings.draftsFolder}).`);
    let root;
    let drafts;
    try {
        root = await realpath(settings.vault);
        drafts = await folderInVault(root, settings.draftsFolder, { make: false });
    } catch {
        return no('Canon cannot reach the vault\'s drafts folder now. Read the vault again, then try once more.');
    }
    const file = join(root, ...path.split('/'));
    let text;
    try {
        const st = await lstat(file);
        if (st.isSymbolicLink() || !st.isFile()) return no('that draft is not a plain file, so Canon leaves it as it is.');
        if (st.size > MAX_PROMOTE_BYTES) return no('that draft is larger than 2 MB, so Canon leaves it as it is.');
        if (!within(await realpath(dirname(file)), drafts)) return no('that draft is not inside the drafts folder.');
        text = await readFile(file, 'utf8');
    } catch (error) {
        return no(error?.code === 'ENOENT' ? 'that draft is no longer there. Read the vault again to see the drafts as they are.' : `Canon could not read that draft (${String(error?.message ?? error).slice(0, 160)}).`);
    }
    let dir;
    try {
        dir = await folderInVault(root, settings.promoteFolder);
    } catch (error) {
        return no(`Canon cannot write into the promoted notes' folder: ${String(error?.message ?? error).slice(0, 200)}.`);
    }
    const next = setFields(text, { status: 'active', promoted: new Date(now()).toISOString() });
    let made;
    try {
        made = await writeNew(dir, basename(file), next);
    } catch (error) {
        return no(`Canon could not write the promoted note: ${String(error?.message ?? error).slice(0, 200)}.`);
    }
    try {
        await unlink(file);
    } catch (error) {
        await unlink(made).catch(() => {});
        return no(`Canon could not move the draft (${String(error?.message ?? error).slice(0, 160)}), so nothing changed.`);
    }
    return { ok: true, from: path, path: relIn(root, made) };
}
