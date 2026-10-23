/**
 * Canon's host half: its settings in words, the notes it reads from a vault
 * (a copy of the synthetic fixture vault, never a real one), the search and
 * the block a turn gets, the drafts it may write and promote, the card's
 * projection, its page, and the whole plugin with DSH stood in for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCESS_CHOICES, DEFAULTS, LIVE_SETTINGS, RANGES, SETTING_TITLES, checkConfig, displayPath, folderIn, resolved, savedEntry, sessionFolder, vaultPath } from '../plugins/canon/lib/config.js';
import { ABOUT_THE_VAULT, distinctTerms, promptTerms, stem, terms, wordsOf } from '../plugins/canon/lib/text.js';
import { noteOf, parseNote, setFields, statusOf, yamlLines } from '../plugins/canon/lib/frontmatter.js';
import { Index, MIN_SCORE, folderKeys, projectsOf, questionsOf } from '../plugins/canon/lib/search.js';
import { MAX_NOTE_BYTES, Vault, bestPassage, cut, folderProblem, paragraphs, plainText } from '../plugins/canon/lib/vault.js';
import { HEADER, KIND, Recall, SUMMARY_MAX, buildBlock, entryBudget, notesThatFit, promptOf, summaryOf } from '../plugins/canon/lib/recall.js';
import { KINDS, capture, cleanTags, cleanTitle, isDraftPath, promote, slugOf, writeRefusal } from '../plugins/canon/lib/drafts.js';
import { INITIAL, KEY, applyEvent, canonProjection, foldAll, parseState, parseView, viewOf } from '../plugins/canon/lib/projection.js';
import { Switches, pageState, parseSwitches, recentSessions, sessionState, working } from '../plugins/canon/lib/page.js';
import { JsonStore } from '../plugins/canon/lib/shared/files.js';
import { Journal } from '../plugins/canon/lib/shared/journal.js';
import { SettingsCheck } from '../plugins/canon/lib/shared/settings.js';
import { settle } from './helpers/clock.mjs';
import { tempDir } from './helpers/temp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, 'test', 'fixtures', 'canon', 'vault');
const HOME = '/Users/someone';

/** A fresh copy of the fixture vault in a temp folder: tests write only there. */
function vaultCopy(label = 'canon-vault') {
    const dir = join(tempDir(label), 'Canon');
    cpSync(FIXTURE, dir, { recursive: true });
    return dir;
}

/** Every file under a folder, as vault paths, sorted. */
function filesIn(dir, rel = '') {
    const out = [];
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...filesIn(dir, path));
        else out.push(path);
    }
    return out.sort();
}

/** The settings as Canon uses them, for a vault. */
const using = (vault, more = {}) => ({ ...resolved({ ...DEFAULTS, vault }, HOME), ...more });

async function readVault(dir, { draftsFolder = 'Drafts', now } = {}) {
    const vault = new Vault({ where: () => ({ vault: dir, draftsFolder }), home: HOME, ...(now ? { now } : {}) });
    await vault.refresh();
    return vault;
}

// ── Settings ──────────────────────────────────────────────────────────

test('config: a vault is a full path or ~/…; the home folder, the disk and DSH\'s data folder are refused, in words', () => {
    const ok = (settings, env = { home: HOME, dshHome: `${HOME}/.dsh` }) => checkConfig({ ...DEFAULTS, ...settings }, env);
    assert.doesNotThrow(() => ok({}), 'no vault yet is not an error: Canon waits for one');
    assert.doesNotThrow(() => ok({ vault: '~/Obsidian/Canon' }));
    assert.doesNotThrow(() => ok({ vault: '/Volumes/Notes/Canon' }));
    assert.equal(vaultPath('~/Obsidian/Canon/', HOME), `${HOME}/Obsidian/Canon`);
    assert.equal(vaultPath('  ', HOME), '');
    assert.equal(vaultPath('Obsidian/Canon', HOME), undefined);
    assert.equal(displayPath(`${HOME}/Obsidian/Canon`, HOME), '~/Obsidian/Canon');
    const refused = (settings, words) => assert.throws(() => ok(settings), (error) => {
        assert.equal(error.key, 'vault');
        assert.match(error.message, words);
        assert.match(error.message, /^Vault folder \(vault\)/);
        return true;
    });
    refused({ vault: 'Obsidian/Canon' }, /full path of your Obsidian vault's folder.*\(it is “Obsidian\/Canon”\)/);
    refused({ vault: '~' }, /not your home folder/);
    refused({ vault: '/' }, /not the whole disk/);
    refused({ vault: '~/.dsh/canon' }, /must not be in DSH's data folder \(~\/\.dsh\)/);
    refused({ vault: '~/.dsh' }, /must not be in DSH's data folder/);
    assert.throws(() => ok({ vault: '/Users' }), /must not hold DSH's data folder/);
    refused({ vault: 42 }, /\(it is 42\)/);
    // The try-out's session folder: a full path or ~/…, as a turn's session has it; '' for none; anything else is no place.
    assert.equal(sessionFolder('~/Projects/app', HOME), `${HOME}/Projects/app`);
    assert.equal(sessionFolder(' /work/Projects/app/ ', HOME), '/work/Projects/app');
    assert.equal(sessionFolder('~', HOME), HOME);
    for (const none of ['', '  ', undefined, null]) assert.equal(sessionFolder(none, HOME), '', String(none));
    for (const bad of ['Projects/app', './app', '~user/app', 42, 'x'.repeat(1001)]) assert.equal(sessionFolder(bad, HOME), undefined, String(bad).slice(0, 20));
});

test('config: drafts and promoted folders stay inside the vault and apart; numbers in range; the log says what changed', () => {
    const ok = (settings) => checkConfig({ ...DEFAULTS, ...settings }, { home: HOME });
    assert.equal(folderIn(' Canon/Drafts/ '), 'Canon/Drafts');
    assert.equal(folderIn(''), undefined);
    assert.equal(folderIn('', { optional: true }), '');
    for (const bad of ['../Drafts', 'Drafts/..', '.obsidian', 'a//b', 'Drafts/.hidden', 'Dr*fts']) assert.equal(folderIn(bad), undefined, bad);
    const wrong = (settings, key, words) => assert.throws(() => ok(settings), (error) => error.key === key && words.test(error.message));
    wrong({ access: 'everything' }, 'access', /What Canon may write/);
    wrong({ draftsFolder: '../Outside' }, 'draftsFolder', /must be a folder inside the vault/);
    wrong({ draftsFolder: '' }, 'draftsFolder', /must be a folder inside the vault/);
    wrong({ promoteFolder: 'drafts/Kept' }, 'promoteFolder', /must be outside the drafts folder/);
    wrong({ promoteFolder: '.trash' }, 'promoteFolder', /must be empty \(the vault's top level\) or a folder inside the vault/);
    wrong({ promote: 'yes' }, 'promote', /Allow promoting drafts/);
    wrong({ maxNotes: 0 }, 'maxNotes', /Notes a turn, at most/);
    wrong({ maxNotes: 11 }, 'maxNotes', /1/);
    wrong({ maxChars: 399 }, 'maxChars', /Characters a turn, at most/);
    wrong({ maxChars: 2000.5 }, 'maxChars', /Characters/);
    // A wrong type is said in words as a wrong range is; a number or true/false in quotes is text, and the words say so.
    const said = (settings) => {
        try {
            ok(settings);
            return '';
        } catch (error) {
            return `${error.key}: ${error.message}`;
        }
    };
    assert.equal(said({ maxChars: '900' }), 'maxChars: Characters a turn, at most (maxChars) must be a whole number of characters from 400 to 8000, written without quotes (it is “900”, which is text)');
    assert.equal(said({ maxNotes: ' 5 ' }), 'maxNotes: Notes a turn, at most (maxNotes) must be a whole number from 1 to 10, written without quotes (it is “ 5 ”, which is text)');
    assert.equal(said({ maxNotes: 'five' }), 'maxNotes: Notes a turn, at most (maxNotes) must be a whole number from 1 to 10 (it is “five”)');
    assert.equal(said({ maxChars: [900] }), 'maxChars: Characters a turn, at most (maxChars) must be a whole number of characters from 400 to 8000 (it is [900])');
    assert.equal(said({ recall: 'false' }), 'recall: Add notes to turns (recall) must be true or false, written without quotes (it is “false”, which is text)');
    assert.equal(said({ promote: 'yes' }), 'promote: Allow promoting drafts (promote) must be true or false (it is “yes”)');
    assert.equal(said({ enabled: 'TRUE' }), 'enabled: Canon on (enabled) must be true or false, written without quotes (it is “TRUE”, which is text)');
    assert.equal(said({ access: true }), 'access: What Canon may write (access) must be Read only (read-only) or Drafts (drafts) (it is true)');
    assert.equal(said({ access: 'write' }), 'access: What Canon may write (access) must be Read only (read-only) or Drafts (drafts) (it is “write”)');
    assert.equal(said({ draftsFolder: 7 }), 'draftsFolder: Drafts folder (draftsFolder) must be a folder inside the vault, such as Drafts or Canon/Drafts: letters, digits and spaces, no part starting with a dot, no .. (it is 7)');
    assert.equal(said({ promoteFolder: 'Drafts/Kept' }), 'promoteFolder: Promoted notes go to (promoteFolder) must be outside the drafts folder (Drafts): notes there are never added to turns (it is “Drafts/Kept”)');
    assert.equal(said({ vault: true }), 'vault: Vault folder (vault) must be the full path of your Obsidian vault\'s folder, such as ~/Obsidian/Canon or /Users/you/Canon (it is true)');
    assert.doesNotThrow(() => ok({ access: 'drafts', promote: true, promoteFolder: 'Notes/Promoted', maxNotes: 10, maxChars: 8000 }));
    assert.deepEqual(Object.keys(ACCESS_CHOICES), ['read-only', 'drafts']);
    assert.deepEqual(RANGES, { maxNotes: [1, 10], maxChars: [400, 8000] });
    assert.ok(!LIVE_SETTINGS.includes('enabled') && LIVE_SETTINGS.every((key) => SETTING_TITLES[key]));
    const r = resolved({ ...DEFAULTS, vault: '~/Canon', access: 'nonsense', maxNotes: 'x' }, HOME);
    assert.deepEqual(r, { vault: `${HOME}/Canon`, draftsFolder: 'Drafts', promoteFolder: '', access: 'read-only', promote: false, recall: true, maxNotes: 3, maxChars: 2000 });
    // After a save: what changed, in the settings' own words.
    const settings = { ...DEFAULTS, vault: '~/Canon' };
    const check = new SettingsCheck({ settings, check: (s) => checkConfig(s, { home: HOME }), liveKeys: LIVE_SETTINGS, label: 'canon' });
    check.run();
    assert.deepEqual(savedEntry(check, [['access']]), { kind: 'settings', text: 'Settings changed: “What Canon may write”', why: 'They apply now.', state: 'done' });
    settings.maxNotes = 50;
    const entry = savedEntry(check, [['maxNotes']]);
    assert.equal(entry.state, 'waiting on a setting');
    assert.match(entry.why, /Notes a turn, at most/);
    assert.equal(check.problem.live, true, 'its page in Plugins can fix it');
});

// ── Words and notes ───────────────────────────────────────────────────

test('text: the words a prompt shares with a note, and chat filler that shares none', () => {
    assert.deepEqual(terms('Thanks, looks good! Please carry on.'), []);
    assert.deepEqual(terms('ok, go ahead'), []);
    assert.deepEqual(distinctTerms('What port does the harbor-gateway listen on? sessionController 8443'),
        ['port', 'harbor', 'gateway', 'listen', 'sessioncontroller', 'session', 'controller', '8443']);
    for (const [a, b] of [['rotate', 'rotating'], ['rotated', 'rotates'], ['certificates', 'certificate'], ['stored', 'store'], ['listens', 'listening']]) {
        assert.equal(stem(a), stem(b), `${a} and ${b}`);
    }
    assert.notEqual(stem('port'), stem('portal'));
    // A prompt's words about the vault and about answering from it are left out; a note keeps them.
    assert.deepEqual(promptTerms('Check the team\'s shared notes in the canon vault, answer and cite the note: which ports?'), ['check', 'port']);
    assert.ok(['note', 'vault', 'canon', 'team'].every((t) => ABOUT_THE_VAULT.has(t)));
    assert.deepEqual(terms('The team\'s shared vault notes'), ['team', 'shar', 'vault', 'note']);
    // "Who owns it" keeps its verb; "called" and "named" only name a thing.
    assert.deepEqual(distinctTerms('Who owns quartz-cache?'), ['own', 'quartz', 'cache'].map((w) => stem(w)));
    assert.deepEqual(promptTerms('What is the mascot called? A service named quartz'), ['mascot', 'servic', 'quartz']);
    assert.deepEqual(promptTerms('Remember that the gateway always listens, unless someone stops it'), ['remember', 'gateway', 'listen', 'stop']);
    // The words as the prompt wrote them, by their terms.
    assert.deepEqual([...wordsOf('Rotating the certificates, rotated again').entries()], [['rotat', 'rotating'], ['certificat', 'certificates']]);
});

test('frontmatter: the YAML notes use, read without throwing; titles, tags, aliases, projects and status', () => {
    const text = [
        '---',
        'title: "Gateway ports: the list"',
        'Status: Active',
        'tags: [harbor-gateway, "networking"]',
        'aliases:',
        '  - HGW ports',
        '  - ports of the gateway',
        'repo: Harbor Gateway',
        'source:',
        '  session: s-1',
        '  turn: 4',
        'summary: |',
        '  Two lines',
        '  of text.',
        '---',
        '# Heading one',
        'Body with an #inline-tag and `#not-a-tag` in code.',
        '```',
        '# not a heading',
        '```',
        '## Second',
    ].join('\n');
    const note = noteOf('Projects/harbor-gateway/Gateway ports.md', text);
    assert.equal(note.title, 'Gateway ports: the list');
    assert.equal(note.status, 'active');
    assert.equal(note.active, true);
    assert.deepEqual(note.tags, ['harbor-gateway', 'networking', 'inline-tag']);
    assert.deepEqual(note.aliases, ['HGW ports', 'ports of the gateway']);
    assert.deepEqual(note.projects, ['harbor-gateway']);
    assert.deepEqual(note.headings, ['Heading one', 'Second']);
    assert.deepEqual(note.data.source, { session: 's-1', turn: 4 });
    assert.equal(note.data.summary, 'Two lines\nof text.');
    // Titles: frontmatter, else the first H1, else the file name.
    assert.equal(noteOf('a/Plain.md', '# From the heading\ntext').title, 'From the heading');
    assert.equal(noteOf('a/Plain.md', 'just text').title, 'Plain');
    // Status: none or active is active; anything else never is.
    for (const [status, active] of [['', true], ['active', true], ['ACTIVE', true], ['draft', false], ['archived', false], ['[draft]', false]]) {
        const n = noteOf('x.md', status ? `---\nstatus: ${status}\n---\nbody` : 'body');
        assert.equal(n.active, active, status || '(none)');
    }
    assert.equal(statusOf({ status: ['Draft'] }), 'draft');
    // Broken frontmatter is a note without one; nothing throws.
    for (const broken of ['---\nno end', '---\n: : :\n---\nbody', '\u0000\u0001', '---\nkey: [unclosed\n---\n', '']) {
        assert.doesNotThrow(() => noteOf('b.md', broken));
    }
    assert.equal(parseNote('---\nno end').frontmatter, false);
});

test('frontmatter: setting a status keeps every other line as written; written values are quoted when they must be', () => {
    const draft = '---\ntitle: Gateway timeouts\nstatus: draft\ntags:\n  - gateway\nkind: gotcha\n---\n\n# Gateway timeouts\n\nBody text.\n';
    const next = setFields(draft, { status: 'active', promoted: '2026-10-17T20:00:00.000Z' });
    assert.equal(next, '---\ntitle: Gateway timeouts\nstatus: active\ntags:\n  - gateway\nkind: gotcha\npromoted: "2026-10-17T20:00:00.000Z"\n---\n\n# Gateway timeouts\n\nBody text.\n');
    assert.equal(setFields('Just a body.\n', { status: 'active' }), '---\nstatus: active\n---\nJust a body.\n');
    const crlf = '---\r\nstatus: draft\r\n---\r\nBody\r\n';
    assert.equal(setFields(crlf, { status: 'active' }), '---\r\nstatus: active\r\n---\r\nBody\r\n');
    assert.deepEqual(yamlLines({ title: 'yes', a: 'plain words', b: '/a/path', n: 3, list: ['x', 'y z'], nested: { k: 'v', skip: undefined }, gone: undefined }),
        ['title: "yes"', 'a: plain words', 'b: "/a/path"', 'n: 3', 'list: [x, y z]', 'nested:', '  k: v']);
    // What Canon writes reads back the same.
    const back = parseNote(`---\n${yamlLines({ title: 'Quotes " and: colons', when: '2026-10-17T20:00:00.000Z' }).join('\n')}\n---\n`).data;
    assert.deepEqual(back, { title: 'Quotes " and: colons', when: '2026-10-17T20:00:00.000Z' });
});

// ── The vault and its search ──────────────────────────────────────────

test('vault: only active notes are searched; drafts, other statuses, hidden folders, the trash, links and other files never', async () => {
    const dir = vaultCopy();
    // A link to a note outside the vault, and a link to a folder: both skipped.
    const outside = join(tempDir('canon-outside'), 'Secret.md');
    writeFileSync(outside, '# Harbor gateway port secret\n\nThe harbor gateway listens on port 2222.\n');
    symlinkSync(outside, join(dir, 'Linked note.md'));
    symlinkSync(join(dir, 'Projects'), join(dir, 'Linked folder'));
    const vault = await readVault(dir);
    const status = vault.status();
    assert.equal(status.state, 'ok');
    assert.deepEqual(status.counts, { notes: 42, active: 35, drafts: 2, other: 5, unreadable: 0 });
    assert.deepEqual(vault.index.notes().map((n) => n.path).sort(), [
        'Decisions/2026-02 Ledger stays on Postgres.md', 'Decisions/2026-03 Lantern job queue on NATS JetStream.md', 'Decisions/2026-04 Lantern API versioning.md',
        'Decisions/2026-06 Quartz eviction policy.md', 'Home.md', 'Ideas/Warming the quartz cache.md', 'Misc/Lantern mascot.md', 'Misc/Office.md',
        'People/Glossary.md', 'People/On-call.md', 'People/Onboarding.md', 'People/Owners.md',
        'Projects/harbor-gateway/Deploying the gateway.md', 'Projects/harbor-gateway/Gateway ports.md', 'Projects/harbor-gateway/Routing rules.md',
        'Projects/lantern-api/Authentication.md', 'Projects/lantern-api/Lantern ports.md', 'Projects/lantern-api/Local development.md',
        'Projects/lantern-api/Rate limits.md', 'Projects/lantern-api/Release checklist.md',
        'Projects/lantern-web/Browser support.md', 'Projects/lantern-web/Deploying lantern-web.md', 'Projects/lantern-web/Feature flags.md',
        'Projects/lantern-web/Running lantern-web locally.md',
        'Projects/quartz-cache/Client settings.md', 'Projects/quartz-cache/Cluster layout.md', 'Projects/quartz-cache/Quartz ports.md',
        'Projects/tide-ledger/Ledger backups.md', 'Projects/tide-ledger/Month-end close.md', 'Projects/tide-ledger/Schema migrations.md',
        'Runbooks/Disk full on a build agent.md', 'Runbooks/Flushing the quartz cache.md', 'Runbooks/Restarting a quartz-cache node.md',
        'Runbooks/Rolling back a lantern-api release.md', 'Runbooks/Rotating TLS certificates.md',
    ]);
    // Superseded decisions, an idea with another status and the archived runbook are never searched.
    for (const path of ['Decisions/2025-11 Lantern job queue on Redis lists.md', 'Decisions/2026-01 Quartz keys kept for an hour.md', 'Ideas/Lantern GraphQL endpoint.md']) {
        assert.equal(vault.index.has(path), false, path);
    }
    const { results, others } = vault.search('What port does the harbor gateway listen on?', { limit: 10 });
    const seen = [...results, ...others].map((r) => r.path);
    assert.equal(results[0].path, 'Projects/harbor-gateway/Gateway ports.md');
    for (const never of ['Drafts/', 'Ideas/', '.trash/', '.obsidian/', 'Runbooks/Archived', 'Linked', 'Attachments/']) {
        assert.ok(!seen.some((p) => p.startsWith(never)), `${never} is never found`);
    }
    // Reading never wrote: the copy holds exactly the fixture's files, plus the two links made here.
    assert.deepEqual(filesIn(dir).filter((p) => !p.startsWith('Linked')), filesIn(FIXTURE));
});

test('vault: the drafts folder\'s notes are listed for the page with their kind, session and turn, newest first', async () => {
    const vault = await readVault(vaultCopy());
    const drafts = vault.drafts();
    assert.deepEqual(drafts.map((d) => d.path), ['Drafts/Port notes.md', 'Drafts/2026-10-01 Gateway timeouts.md'].sort((a, b) => {
        const at = (p) => drafts.find((d) => d.path === p).created;
        return at(b) - at(a);
    }));
    const timeouts = drafts.find((d) => d.title === 'Gateway timeouts');
    assert.equal(timeouts.kind, 'gotcha');
    assert.equal(timeouts.status, 'draft');
    assert.equal(timeouts.sessionId, 'fixture-session-1');
    assert.equal(timeouts.turn, 4);
    assert.equal(timeouts.folder, '/work/Projects/harbor-gateway');
    assert.equal(timeouts.created, Date.parse('2026-10-01T17:20:00.000Z'));
    assert.match(timeouts.preview, /drops idle connections after 60 seconds/);
    // A note in the drafts folder without a status is still a draft.
    assert.equal(drafts.find((d) => d.title === 'Port notes').status, 'draft');
    // A preview is the draft's plain words cut at a word: no Markdown marks, no link addresses, no title line.
    const marked = vaultCopy();
    writeFileSync(join(marked, 'Drafts', 'Body cap.md'), '---\ntitle: Body cap\nstatus: draft\n---\n# Lantern API request body cap\n\n**Decided 2026-10-17 (Pacific):** cap request bodies at 2 MB, because larger uploads go through the blob service (`blobctl put`). See [[Rate limits]] and [the limits file](https://example.com/limits).\n\n**Implications:**\n- clients send larger files to the blob service first and pass its id\n- the gateway answers 413 with a link to this note\n- the limit is checked again every quarter by the owners of the lantern API and its gateway\n');
    const preview = (await readVault(marked)).drafts().find((d) => d.path === 'Drafts/Body cap.md').preview;
    assert.equal(preview, 'Decided 2026-10-17 (Pacific): cap request bodies at 2 MB, because larger uploads go through the blob service (blobctl put). See Rate limits and the limits file. Implications: clients send larger files to the blob service first and pass…');
    assert.ok(preview.length <= 240);
    assert.equal(plainText('Plain words with snake_case_name, 2*3*4, *emphasis*, _this_, ~~that~~ and <b>tags</b>.'), 'Plain words with snake_case_name, 2*3*4, emphasis, this, that and tags.');
    assert.equal(plainText('## Steps\n\n1. Run `make verify`\n2. Tag it\n\n> Quoted\n\n```sh\nmake tag\n```'), 'Run make verify Tag it Quoted make tag');
    // Another drafts folder: those notes are notes again, and the old drafts folder's are searched.
    const other = await readVault(vaultCopy(), { draftsFolder: 'Ideas' });
    assert.deepEqual(other.drafts().map((d) => d.path).sort(), ['Ideas/Gateway rewrite.md', 'Ideas/Lantern GraphQL endpoint.md', 'Ideas/Warming the quartz cache.md']);
    assert.ok(other.index.has('Drafts/Port notes.md'));
});

test('vault: a changed, added or removed note is read again by its time and size; a missing folder says what to do', async () => {
    const dir = vaultCopy();
    let now = 1_000_000;
    const vault = await readVault(dir, { now: () => now });
    const changes = [];
    vault.onChange = (change) => changes.push(change.kind);
    const ports = join(dir, 'Projects/harbor-gateway/Gateway ports.md');
    writeFileSync(ports, readFileSync(ports, 'utf8').replace('8443', '8553 (moved in October)'));
    utimesSync(ports, new Date(), new Date(Date.now() + 5000));
    writeFileSync(join(dir, 'Runbooks/Paging.md'), '# Paging the on-call\n\nPage the on-call with `pagectl page --team gateway`.\n');
    rmSync(join(dir, 'Home.md'));
    now += 10_000;
    await vault.ready();
    assert.equal(vault.status().state, 'ok');
    assert.equal(vault.status().changed, 2, 'only the changed and the new note were read');
    assert.ok(vault.index.has('Runbooks/Paging.md'));
    assert.ok(!vault.index.has('Home.md'));
    const passage = await vault.passage('Projects/harbor-gateway/Gateway ports.md', ['port', 'listen'], 300);
    assert.match(passage, /8553 \(moved in October\)/, 'a passage is read fresh from the file');
    assert.deepEqual(changes, ['changed']);
    // Fresh enough: no read at all.
    const before = vault.state.readAt;
    await vault.ready();
    assert.equal(vault.state.readAt, before);
    // The folder goes away: a state with words, not a throw; and back again.
    const moved = `${dir}-moved`;
    cpSync(dir, moved, { recursive: true });
    rmSync(dir, { recursive: true });
    now += 10_000;
    await vault.ready();
    const gone = vault.status();
    assert.equal(gone.state, 'error');
    assert.equal(gone.error.code, 'missing');
    assert.match(gone.error.text, /does not exist\. Check the folder in Canon's settings, or create it\./);
    assert.equal(gone.counts.active, 0, 'nothing from a vault that is not there is searched');
    assert.deepEqual(vault.search('harbor gateway port').results, []);
    cpSync(moved, dir, { recursive: true });
    now += 10_000;
    await vault.ready();
    assert.equal(vault.status().state, 'ok');
    assert.equal(vault.status().counts.active, 35);
    assert.deepEqual(changes, ['changed', 'error', 'ok']);
    // The other folder problems, in words.
    assert.match(folderProblem({ code: 'EACCES' }, '~/Canon').text, /DSH may not read ~\/Canon\. Give DSH access to it/);
    assert.match(folderProblem({ code: 'ENOTDIR' }, '~/Canon').text, /is a file, not a folder/);
    // A file that is a vault: refused as not a folder.
    const file = join(tempDir('canon-file'), 'vault.md');
    writeFileSync(file, '# not a folder');
    const notFolder = await readVault(file);
    assert.equal(notFolder.status().error.code, 'not-a-folder');
});

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('vault: a vault folder Canon may not list is an error in words, logged once; access given, it reads as usual', async (t) => {
    // The folder can be looked up but not listed: a copy made unreadable in this test's own temp folder.
    const dir = vaultCopy('canon-locked');
    chmodSync(dir, 0o000);
    t.after(() => chmodSync(dir, 0o755));
    const changes = [];
    const vault = new Vault({ where: () => ({ vault: dir, draftsFolder: 'Drafts' }), home: HOME, onChange: (change) => changes.push(change) });
    await vault.refresh();
    const status = vault.status();
    assert.equal(status.state, 'error');
    assert.equal(status.error.code, 'no-access');
    assert.equal(status.error.text, `DSH may not read ${dir}. Give DSH access to it (on a Mac: System Settings, Privacy & Security, Files and Folders), or choose another folder.`);
    assert.deepEqual(status.counts, { notes: 0, active: 0, drafts: 0, other: 0, unreadable: 0 });
    assert.deepEqual(changes.map((c) => [c.kind, c.after.state, c.after.error?.code]), [['error', 'error', 'no-access']]);
    assert.deepEqual(vault.search('harbor gateway port').results, [], 'a turn gets nothing from it');
    assert.equal(await vault.passage('Projects/harbor-gateway/Gateway ports.md', ['port'], 300), undefined);
    // Read again while it still cannot be listed: the same words, and no second entry.
    await vault.again();
    assert.equal(vault.status().error.code, 'no-access');
    assert.equal(changes.length, 1);
    // Access given: read as usual, and the change is told once.
    chmodSync(dir, 0o755);
    await vault.again();
    assert.deepEqual([vault.status().state, vault.status().counts.active, vault.status().error], ['ok', 35, undefined]);
    assert.deepEqual(changes.map((c) => c.kind), ['error', 'ok']);
    // A Mac's privacy rules refuse the listing with EPERM, any other system with EACCES: the same words for both.
    for (const code of ['EPERM', 'EACCES']) {
        class Refused extends Vault {
            async walk() { throw Object.assign(new Error(`${code}: operation not permitted, scandir`), { code }); }
        }
        const refused = new Refused({ where: () => ({ vault: dir, draftsFolder: 'Drafts' }), home: dirname(dir) });
        await refused.refresh();
        assert.deepEqual([refused.status().state, refused.status().error.code], ['error', 'no-access'], code);
        assert.equal(refused.status().error.text, 'DSH may not read ~/Canon. Give DSH access to it (on a Mac: System Settings, Privacy & Security, Files and Folders), or choose another folder.', code);
    }
});

test('vault: when the vault folder changes, the earlier folder\'s words and counts go at once; the new folder is reading until its read ends', async (t) => {
    const file = join(tempDir('canon-file'), 'vault.md');
    writeFileSync(file, '# not a folder');
    const locked = vaultCopy('canon-locked');
    chmodSync(locked, 0o000);
    t.after(() => chmodSync(locked, 0o755));
    let where = { vault: file, draftsFolder: 'Drafts' };
    const vault = new Vault({ where: () => where, home: HOME });
    await vault.refresh();
    assert.equal(vault.status().error.code, 'not-a-folder');
    // Moved to a folder it may not list: the file's words are not shown under the new folder.
    where = { vault: locked, draftsFolder: 'Drafts' };
    let status = vault.status();
    assert.deepEqual([status.state, status.error, status.path, status.reading], ['reading', undefined, locked, true]);
    await vault.again();
    status = vault.status();
    assert.equal(status.error.code, 'no-access');
    assert.match(status.error.text, new RegExp(`^DSH may not read ${escaped(locked)}\\.`));
    // From a folder read well to another: its counts are not the new folder's.
    chmodSync(locked, 0o755);
    await vault.again();
    assert.deepEqual([vault.status().state, vault.status().counts.active], ['ok', 35]);
    const empty = tempDir('canon-empty');
    where = { vault: empty, draftsFolder: 'Drafts' };
    assert.deepEqual([vault.status().state, vault.status().counts.active], ['reading', 0]);
    await vault.again();
    assert.deepEqual([vault.status().state, vault.status().counts], ['ok', { notes: 0, active: 0, drafts: 0, other: 0, unreadable: 0 }]);
    // No vault at all: unset, at once.
    where = { vault: '', draftsFolder: '' };
    await vault.again();
    assert.equal(vault.status().state, 'unset');
});

test('vault: after Canon writes, the read that follows sees the write, even with a read under way that listed the folder before it', async () => {
    const dir = vaultCopy();
    let open;
    let gate = Promise.resolve();
    class SlowVault extends Vault {
        async walk(root) {
            const listed = await super.walk(root);
            await gate;
            return listed;
        }
    }
    const vault = new SlowVault({ where: () => ({ vault: dir, draftsFolder: 'Drafts' }), home: HOME });
    await vault.refresh();
    gate = new Promise((resolve) => { open = resolve; });
    const under = vault.refresh();
    await settle();
    writeFileSync(join(dir, 'Runbooks/Paging.md'), '# Paging the on-call\n\nPage the on-call with pagectl.\n');
    assert.equal(vault.refresh(), under, 'a plain refresh shares the read under way');
    const after = vault.again();
    open();
    await under;
    assert.equal(vault.index.has('Runbooks/Paging.md'), false, 'the read under way listed the folder before the write');
    await after;
    assert.ok(vault.index.has('Runbooks/Paging.md'), 'again() reads once more after the read under way');
});

test('vault: a note larger than Canon reads is read up to its cap; notes are passages, not whole files', async () => {
    const dir = vaultCopy();
    const big = `---\nstatus: active\n---\n# Huge log\n\n${'filler words here. '.repeat(20000)}\n\nThe needle sentence about zircon.\n`;
    writeFileSync(join(dir, 'Huge.md'), big);
    const vault = await readVault(dir);
    assert.ok(vault.index.has('Huge.md'));
    assert.ok(Buffer.byteLength(big) > MAX_NOTE_BYTES);
    assert.deepEqual(vault.search('zircon needle').results, [], 'past the cap is not read');
    // The passage: the best paragraph under its heading, cut at a word.
    const body = '# Ports\n\nIntro words.\n\n## Listening\n\nThe gateway listens on 8443.\nAnd on 8080 for checks.\n\nUnrelated last paragraph.';
    assert.deepEqual(paragraphs(body).map((p) => p.heading), ['Ports', 'Listening', 'Listening']);
    assert.equal(bestPassage(body, ['listen', '8443'], 200), 'Listening: The gateway listens on 8443.\nAnd on 8080 for checks.\nUnrelated last paragraph.');
    assert.equal(bestPassage(body, ['nothing'], 200), 'Intro words.');
    assert.equal(cut('one two three four five six', 15), 'one two three…');
    assert.ok(cut('x'.repeat(50), 10).length <= 10);
});

test('search: the session\'s folder lifts its project\'s notes; one shared body word never makes a match', async () => {
    const vault = await readVault(vaultCopy());
    const ask = (prompt, folder) => vault.search(prompt, { folder, limit: 3 });
    assert.deepEqual(folderKeys('/Users/someone/Projects/harbor-gateway', HOME), { repo: 'harbor-gateway', parent: '' });
    assert.deepEqual(folderKeys('/Users/someone/src', HOME), { repo: '', parent: '' }, 'generic names and the person\'s own name say nothing');
    assert.deepEqual(folderKeys('/work/clients/Tide Ledger', HOME), { repo: 'tide-ledger', parent: 'clients' });
    // An ambiguous question: the folder decides what else comes with it.
    const fromGateway = ask('which port do we listen on', '/work/Projects/harbor-gateway');
    const fromLedger = ask('which port do we listen on', '/work/Projects/tide-ledger');
    assert.deepEqual(fromGateway.results.map((r) => r.path), ['Projects/harbor-gateway/Gateway ports.md']);
    assert.equal(fromGateway.results[0].folder, 'repo');
    assert.ok(fromLedger.results.some((r) => r.path === 'Projects/tide-ledger/Ledger backups.md' && r.folder === 'repo'));
    assert.ok(!fromGateway.results.some((r) => r.path === 'Projects/tide-ledger/Ledger backups.md'));
    // Titles, aliases and tags count for more than the body.
    assert.equal(ask('How do I rotate the TLS certificates?', '').results[0].path, 'Runbooks/Rotating TLS certificates.md');
    assert.equal(ask('certificate renewal steps', '').results[0].path, 'Runbooks/Rotating TLS certificates.md', 'by its alias');
    assert.equal(ask('restore the ledger database from last night', '/work/Projects/tide-ledger').results[0].path, 'Projects/tide-ledger/Ledger backups.md');
    // Nothing for filler, for prompts about something else, and for one shared body word.
    assert.deepEqual(ask('Thanks, looks good! Please carry on.', '').results, []);
    assert.deepEqual(ask('translate this paragraph into French', '/work/Projects/other-thing').results, []);
    const one = ask('what does bastion mean', '');
    assert.deepEqual(one.results, []);
    assert.equal(one.others[0]?.path, 'People/Glossary.md', 'listed as a near miss for the page');
    assert.equal(one.others[0]?.fits, false);
    for (const r of ask('What port does the harbor gateway listen on?', '').results) assert.ok(r.score >= MIN_SCORE);
});

test('search: a project\'s name is one word and a note needs another; words about the vault are left out; another project\'s notes stay out', async () => {
    const vault = await readVault(vaultCopy());
    const ask = (prompt, folder = '') => vault.search(prompt, { folder, limit: 3 });
    const paths = (prompt, folder) => ask(prompt, folder).results.map((r) => r.path);
    const lantern = '/Users/someone/Projects/lantern-api';
    // The project's name alone, or with one word in a note's body, is not a match.
    assert.deepEqual(paths('Does the lantern API support websockets?', lantern), []);
    const renamed = ask('Rename the lantern API\'s logger variable to log.', lantern);
    assert.deepEqual(renamed.results, []);
    assert.equal(renamed.others.find((o) => o.path === 'Decisions/2026-04 Lantern API versioning.md')?.why, 'few', 'its body says "renaming"');
    assert.ok(renamed.others.some((o) => o.why === 'name'), 'and others share only the name');
    // With a word beyond the name in the title, it is ("called" is not On-call's "call").
    assert.deepEqual(paths('What is the lantern team\'s mascot called?'), ['Misc/Lantern mascot.md']);
    // Words about the vault say where to look, not what about.
    assert.deepEqual(ask('Answer from the team\'s shared notes, and cite the note you used.', lantern), { terms: [], results: [], others: [], folder: { repo: 'lantern-api', parent: '' } });
    assert.deepEqual(paths('What ports does quartz use? Answer from the team\'s shared notes and cite the note you used.', '/Users/someone/work/quartz-cache'), ['Projects/quartz-cache/Quartz ports.md']);
    // In a project's folder, another project's notes stay out unless the prompt names that project.
    const here = ask('Which ports does this service listen on, and where is its health check?', lantern);
    assert.deepEqual(here.results.map((r) => r.path), ['Projects/lantern-api/Lantern ports.md']);
    assert.equal(here.others.find((o) => o.path === 'Projects/harbor-gateway/Gateway ports.md')?.why, 'other');
    assert.deepEqual(paths('What timeout and retry settings should our quartz client use?', lantern), ['Projects/quartz-cache/Client settings.md'], 'named, so it comes');
    // "The lantern API" names lantern-api, not lantern-web; a superseded decision never comes.
    assert.deepEqual(paths('Why did we move the lantern job queue off Redis?', '/Users/someone/src/tide-ledger'), ['Decisions/2026-03 Lantern job queue on NATS JetStream.md']);
    // The page gets the prompt's words, never their stems.
    assert.deepEqual(ask('How do I rotate the TLS certificates?').results[0].words, ['rotate', 'tls', 'certificates']);
    // The project's name is known from a note's project or repo field and from its folder under Projects/.
    assert.deepEqual(projectsOf({ path: 'Projects/lantern-api/Lantern ports.md', projects: [] }), ['lantern-api']);
    assert.deepEqual(projectsOf({ path: 'Runbooks/Paging.md', projects: ['harbor-gateway'] }), ['harbor-gateway']);
    assert.deepEqual(projectsOf({ path: 'Home.md', projects: [] }), []);
    assert.deepEqual([...vault.index.projects.keys()].sort(), ['harbor-gateway', 'lantern-api', 'lantern-web', 'quartz-cache', 'tide-ledger']);
});

test('search: a session in a project\'s folder names that project; a prompt that asks two things gets the best note for each', async () => {
    const vault = await readVault(vaultCopy());
    const ask = (prompt, folder = '') => vault.search(prompt, { folder, limit: 3 });
    const paths = (prompt, folder) => ask(prompt, folder).results.map((r) => r.path);
    // "This service" in quartz-cache's folder is quartz-cache, so its ports note fits on "ports" alone ...
    assert.deepEqual(paths('Which ports does this service listen on?', '/Users/someone/work/quartz-cache'), ['Projects/quartz-cache/Quartz ports.md']);
    // ... and not from a folder that is no project of the vault's.
    assert.equal(ask('Which ports does this service listen on?', '/Users/someone/Elsewhere/scratch').others.find((o) => o.path === 'Projects/quartz-cache/Quartz ports.md')?.why, 'few');
    // Two questions: each one's best note comes, though the queue decision scores far above On-call.
    const two = 'When does the lantern on-call rotation hand over, and why did we choose NATS JetStream for the lantern job queue?';
    assert.deepEqual(questionsOf(two), ['When does the lantern on-call rotation hand over', 'why did we choose NATS JetStream for the lantern job queue']);
    assert.deepEqual(questionsOf('Which port? And the health check? Thanks.'), ['Which port', 'And the health check', 'Thanks.']);
    assert.deepEqual(questionsOf('Restore the ledger, then tell me why it failed.'), ['Restore the ledger, then tell me why it failed.']);
    const both = ask(two, '/Users/someone/Elsewhere/scratch').results;
    assert.deepEqual(both.map((r) => r.path), ['Decisions/2026-03 Lantern job queue on NATS JetStream.md', 'People/On-call.md']);
    assert.ok(both[1].score < both[0].score * 0.5, 'On-call is under half the best, kept as its question\'s best note');
    // When not all fit, each question's best note comes before the rest.
    const index = new Index();
    const note = (path, title, body) => ({ path, title, aliases: [], tags: [], projects: [], headings: [], body });
    for (const i of [1, 2, 3, 4]) index.add(note(`n/Alpha ${i}.md`, `Alpha beta epsilon zeta ${i}`, 'alpha beta epsilon zeta'));
    index.add(note('n/Gamma.md', 'Odd one', 'a short word on gamma and delta'));
    for (let i = 0; i < 8; i += 1) index.add(note(`n/Other ${i}.md`, `Other ${i}`, `filler words ${i}`));
    const many = index.search('What about alpha beta epsilon zeta, and why gamma delta?', { limit: 3 }).results.map((r) => r.path);
    assert.equal(many.length, 3);
    assert.deepEqual(many, ['n/Alpha 1.md', 'n/Alpha 2.md', 'n/Gamma.md'], 'the second question\'s note, though four notes score higher');
    // A question must fit on its own: "what must I run before one?" fits no note, so a note with "run" in a heading stays out.
    const weekday = paths('On which weekday do lantern releases go out, and what must I run before one?', '/Users/someone/Projects/lantern-api');
    assert.equal(weekday[0], 'Projects/lantern-api/Release checklist.md');
    assert.ok(!weekday.includes('Projects/lantern-api/Lantern ports.md'));
});

test('search: the index forgets removed notes and compacts itself; scores never depend on removed ones', () => {
    const index = new Index();
    const note = (i, body) => ({ path: `n/${i}.md`, title: `Note ${i}`, aliases: [], tags: [], projects: [], headings: [], body });
    for (let i = 0; i < 2100; i += 1) index.add(note(i, `common words ${i}`));
    index.add(note('x', 'zircon quartz feldspar'));
    for (let i = 0; i < 2100; i += 1) index.remove(`n/${i}.md`);
    assert.equal(index.size, 1);
    assert.ok(index.docs.length < 2100, 'compacted');
    assert.equal(index.search('zircon quartz').results[0].path, 'n/x.md');
    assert.deepEqual(index.search('common words').results, []);
});

// ── The block a turn gets ─────────────────────────────────────────────

test('recall: the block stays within its characters and notes, cites each note\'s path and quotes its words', () => {
    const entries = (n, size) => Array.from({ length: n }, (_, i) => ({ path: `Projects/p${i}/Note ${i}.md`, title: `Title ${i}`, passage: `Line one of ${i} ${'word '.repeat(size)}\nLine two.` }));
    for (const maxChars of [400, 700, 2000, 8000]) {
        for (const n of [1, 3, 10]) {
            for (const size of [5, 200, 3000]) {
                const block = buildBlock(entries(n, size), { maxChars });
                assert.ok(block, `${maxChars}/${n}/${size}`);
                assert.ok(block.text.length <= maxChars, `${block.text.length} > ${maxChars}`);
                assert.equal(block.chars, block.text.length);
                assert.ok(block.text.startsWith(HEADER));
                assert.ok(block.notes.length >= 1 && block.notes.length <= n);
                for (const [i, note] of block.notes.entries()) assert.ok(block.text.includes(`[${i + 1}] ${note.path} (“${note.title}”)`));
                for (const line of block.text.split('\n\n').slice(1).flatMap((part) => part.split('\n').slice(1))) assert.match(line, /^>( |$)/, 'every note line is quoted');
                assert.ok(block.summary.length <= SUMMARY_MAX);
            }
        }
    }
    // Fewer notes rather than notes with no room to say anything.
    assert.equal(notesThatFit(10, 400), 1);
    assert.ok(entryBudget(notesThatFit(10, 2000), 2000) >= 160);
    assert.equal(summaryOf([{ path: 'a/Gateway ports.md', title: 'Gateway ports' }, { path: 'b/x.md', title: '' }]), '2 notes from the canon vault: Gateway ports, x');
    assert.ok(summaryOf(Array.from({ length: 10 }, (_, i) => ({ path: `p${i}.md`, title: `A rather long title number ${i}` }))).endsWith('…'));
    // A title the same as the file name is not said twice.
    assert.match(buildBlock([{ path: 'Runbooks/Paging.md', title: 'Paging', passage: 'Page them.' }], { maxChars: 2000 }).text, /\[1\] Runbooks\/Paging\.md\n> Page them\./);
});

/** DSH's pre-step for one step: what it claimed, and the decision `next()` gives. */
function step({ text = 'What port does the harbor gateway listen on?', id = 'm-1', session = 's-1', cwd = '/work/Projects/harbor-gateway', n = 1, turn = 1, source = { kind: 'user' }, decision, signal } = {}) {
    const prompt = { id, role: 'user', source, content: [{ type: 'text', text }] };
    const earlier = { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'before' }] };
    const payload = { agent: { id: session, session: { id: session, header: { cwd } } }, messages: [prompt], step: n, turn, signal };
    const made = decision ?? { kind: 'enter', messages: [earlier, prompt, { id: 'after', role: 'user', source: { kind: 'runtime-context' }, content: [] }] };
    return { payload, prompt, next: async () => made };
}

function recallOver(vault, { settings = {}, off = new Set(), working: on = () => true, logger } = {}) {
    const found = [];
    const recall = new Recall({
        vault,
        settings: () => ({ recall: true, vault: vault.where().vault, maxNotes: 3, maxChars: 2000, ...settings }),
        working: on,
        isOff: (id) => off.has(id),
        makeMessage: (text, source) => ({ id: `canon-${found.length + 1}`, role: 'user', content: [{ type: 'text', text }], source }),
        onRecall: (f) => found.push(f),
        logger,
    });
    return { recall, found };
}

test('recall: a person\'s new prompt gets the notes once, right after it, as one message of Canon\'s own kind', async () => {
    const vault = await readVault(vaultCopy());
    const { recall, found } = recallOver(vault);
    const { payload, prompt, next } = step();
    const decision = await recall.preStep(payload, next);
    assert.equal(decision.kind, 'enter');
    const at = decision.messages.indexOf(prompt);
    const added = decision.messages[at + 1];
    assert.equal(added.source.kind, KIND);
    assert.equal(added.source.form, 'notice');
    assert.equal(added.role, 'user');
    assert.equal(added.source.summary, '1 note from the canon vault: Gateway ports');
    assert.deepEqual(added.source.notes.map((n) => n.path), ['Projects/harbor-gateway/Gateway ports.md'], 'the project\'s other notes share only its name and a word in their body');
    assert.equal(added.source.turn, 1);
    const text = added.content[0].text;
    assert.ok(text.startsWith(HEADER));
    assert.match(text, /\[1\] Projects\/harbor-gateway\/Gateway ports\.md\n> Gateway ports: The harbor gateway listens on port 8443/);
    assert.ok(text.length <= 2000);
    assert.equal(decision.messages.length, 4, 'one message added, nothing else changed');
    assert.equal(decision.messages.at(-1).id, 'after', 'DSH\'s own context after the prompt stays after Canon\'s');
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].boosted, ['Projects/harbor-gateway/Gateway ports.md']);
    // The same prompt again (a retried step): nothing more.
    const again = step();
    assert.deepEqual((await recall.preStep(again.payload, again.next)).messages.map((m) => m.id), ['old', 'm-1', 'after']);
    assert.equal(found.length, 1);
});

test('recall: later steps, others\' messages, a rejected step, an aborted turn and errors leave DSH\'s step as it was', async () => {
    const vault = await readVault(vaultCopy());
    const warnings = [];
    const { recall, found } = recallOver(vault, { logger: { warn: (line) => warnings.push(line) } });
    const untouched = async (options) => {
        const s = step(options);
        const decision = await s.next();
        const out = await recall.preStep(s.payload, async () => decision);
        assert.equal(out, decision, JSON.stringify(options));
    };
    await untouched({ n: 2, id: 'a' });
    await untouched({ id: 'b', source: { kind: 'dsh-plugin-autopilot' } });
    await untouched({ id: 'c', source: { kind: 'steer' } });
    await untouched({ id: 'd', decision: { kind: 'reject' } });
    await untouched({ id: 'e', decision: { kind: 'enter', messages: [] } });
    await untouched({ id: 'f', text: 'Thanks, looks good!' });
    const aborted = new AbortController();
    aborted.abort();
    await untouched({ id: 'g', signal: aborted.signal });
    // A decision that already holds Canon's message (another copy of Canon in the chain): no second one.
    const s = step({ id: 'h' });
    const own = { kind: 'enter', messages: [s.prompt, { role: 'user', source: { kind: KIND }, content: [] }] };
    assert.equal(await recall.preStep(s.payload, async () => own), own);
    // A search that throws: DSH's step goes on, the error is a warning.
    const broken = recallOver({ ...vault, ready: async () => { throw new Error('disk on fire'); }, where: () => vault.where() }, { logger: { warn: (line) => warnings.push(line) } });
    const b = step({ id: 'i' });
    const decision = await b.next();
    assert.equal(await broken.recall.preStep(b.payload, async () => decision), decision);
    assert.match(warnings.at(-1), /canon: recall: disk on fire/);
    // A next() that throws is DSH's own error, passed on as it is.
    const t = step({ id: 'j' });
    await assert.rejects(recall.preStep(t.payload, async () => { throw new Error('model down'); }), /model down/);
    assert.equal(found.length, 0);
});

test('recall: switched off for the session, recall off, Canon not working or nothing that fits: nothing is added', async () => {
    const vault = await readVault(vaultCopy());
    const off = new Set(['s-off']);
    const cases = [
        [{ off }, { session: 's-off' }],
        [{ settings: { recall: false } }, {}],
        [{ settings: { vault: '' } }, {}],
        [{ working: () => false }, {}],
        [{}, { text: 'translate this paragraph into French', cwd: '/work/other' }],
    ];
    for (const [options, stepOptions] of cases) {
        const { recall, found } = recallOver(vault, options);
        const s = step(stepOptions);
        const decision = await s.next();
        assert.equal(await recall.preStep(s.payload, async () => decision), decision, JSON.stringify(stepOptions));
        assert.equal(found.length, 0);
    }
    // Back on for the session: the next prompt gets its notes.
    off.delete('s-off');
    const { recall, found } = recallOver(vault, { off });
    const s = step({ session: 's-off', id: 'later' });
    assert.equal((await recall.preStep(s.payload, s.next)).messages.length, 4);
    assert.equal(found.length, 1);
    assert.equal(promptOf([{ role: 'user', source: { kind: 'user' }, content: '  ' }]), undefined);
});

test('recall: the page\'s try-out shows the notes, why each fits, the near misses and the exact block', async () => {
    const vault = await readVault(vaultCopy());
    const { recall } = recallOver(vault);
    const view = await recall.preview('What port does the harbor gateway listen on?', '/work/Projects/harbor-gateway');
    assert.deepEqual(view.terms, ['port', 'harbor', 'gateway', 'listen']);
    assert.deepEqual(view.folder, { repo: 'harbor-gateway', parent: '' });
    assert.deepEqual(view.results.map((r) => [r.path, r.folder]), [['Projects/harbor-gateway/Gateway ports.md', 'repo']]);
    assert.deepEqual(view.results[0].words, ['port', 'harbor', 'gateway', 'listen'], 'the prompt\'s own words, for the page');
    assert.equal(view.others.find((o) => o.path === 'Projects/harbor-gateway/Routing rules.md')?.why, 'few', 'the project\'s name and one word in its body');
    assert.ok(view.results.every((r) => typeof r.score === 'number' && r.matched.length > 0 && r.passage));
    assert.ok(view.others.some((o) => o.path === 'Projects/tide-ledger/Ledger backups.md'));
    assert.ok(view.block.text.startsWith(HEADER) && view.block.chars === view.block.text.length);
    // The README's block is the one a turn gets for its prompt and folder.
    const readme = readFileSync(join(ROOT, 'plugins', 'canon', 'README.md'), 'utf8');
    const sample = /```text\n([\s\S]*?)\n```/.exec(readme)?.[1];
    const shown = await recall.preview('Which port does the load balancer use for the gateway\'s health check, and how do I roll out a new build?', `${HOME}/Projects/harbor-gateway`);
    assert.equal(shown.block?.text, sample, 'the README shows the block exactly as a turn gets it');
    const none = await recall.preview('Thanks!', '');
    assert.deepEqual([none.results, none.block], [[], null]);
});

// ── Drafts ────────────────────────────────────────────────────────────

const NOTE = { title: 'Gateway health check port', body: 'The load balancer checks the gateway on port 8080.\nKeep it as it is when moving the HTTPS port.', kind: 'fact', tags: ['harbor-gateway', '#Networking', 'two words', '123'] };
const FROM = { sessionId: 's-1', turn: 3, folder: '/work/Projects/harbor-gateway' };
const AT = () => Date.UTC(2026, 9, 17, 20, 0, 0);

test('drafts: capture writes one new draft in the drafts folder, with status draft, its kind and where it came from', async () => {
    const dir = vaultCopy();
    const before = filesIn(dir);
    const result = await capture({ settings: using(dir, { access: 'drafts' }), note: NOTE, from: FROM, now: AT, home: HOME });
    assert.equal(result.ok, true, result.reason);
    assert.match(result.path, /^Drafts\/2026-10-1[78] Gateway health check port\.md$/);
    const added = filesIn(dir).filter((p) => !before.includes(p));
    assert.deepEqual(added, [result.path], 'one file, in the drafts folder, nothing else touched');
    const text = readFileSync(join(dir, result.path), 'utf8');
    const { data, body } = parseNote(text);
    assert.equal(data.status, 'draft');
    assert.equal(data.kind, 'fact');
    assert.equal(data.title, 'Gateway health check port');
    assert.deepEqual(data.tags, ['harbor-gateway', 'networking', 'two-words']);
    assert.equal(data.project, 'harbor-gateway');
    assert.equal(data.created, '2026-10-17T20:00:00.000Z');
    assert.deepEqual(data.source, { session: 's-1', turn: 3, folder: '/work/Projects/harbor-gateway', by: 'canon_capture' });
    assert.match(body, /^\n# Gateway health check port\n\nThe load balancer checks the gateway on port 8080\./);
    // The same title again: a new file beside it, never over it.
    const second = await capture({ settings: using(dir, { access: 'drafts' }), note: NOTE, from: FROM, now: AT, home: HOME });
    assert.equal(second.path, result.path.replace('.md', ' 2.md'));
    assert.equal(readFileSync(join(dir, result.path), 'utf8'), text, 'the first is as it was');
    // A drafts folder that is not there yet is made, inside the vault.
    const nested = await capture({ settings: using(dir, { access: 'drafts', draftsFolder: 'Canon/New drafts' }), note: { ...NOTE, kind: 'gotcha' }, from: {}, now: AT, home: HOME });
    assert.equal(nested.ok, true);
    assert.ok(nested.path.startsWith('Canon/New drafts/'));
    assert.ok(statSync(join(dir, 'Canon/New drafts')).isDirectory());
    // A new draft is listed on the page once the vault is read, and never searched.
    const vault = await readVault(dir);
    assert.ok(vault.drafts().some((d) => d.path === result.path && d.kind === 'fact' && d.sessionId === 's-1' && d.turn === 3));
    assert.ok(!vault.search('gateway health check port load balancer').results.some((r) => r.path.startsWith('Drafts/')));
});

test('drafts: capture refuses in words while Canon is read only, for a note it cannot keep, and into a linked folder', async () => {
    const dir = vaultCopy();
    const before = filesIn(dir);
    const refused = async (settings, note, words) => {
        const result = await capture({ settings, note, from: FROM, now: AT, home: HOME });
        assert.equal(result.ok, false);
        assert.match(result.reason, words);
    };
    await refused(using(dir), NOTE, /Canon is read only \(“What Canon may write” is Read only in Canon's settings\)\. A person can allow drafts there\./);
    await refused(using(''), NOTE, /no canon vault is set/);
    const drafts = using(dir, { access: 'drafts' });
    await refused(drafts, { ...NOTE, title: '' }, /give the note a title/);
    await refused(drafts, { ...NOTE, title: 'x'.repeat(121) }, /title of 1 to 120 characters/);
    await refused(drafts, { ...NOTE, body: '   ' }, /give the note a body/);
    await refused(drafts, { ...NOTE, body: 'y'.repeat(20001) }, /keep it to 20000/);
    await refused(drafts, { ...NOTE, kind: 'opinion' }, /decision, fact, howto, gotcha/);
    assert.deepEqual(filesIn(dir), before, 'nothing written');
    // A drafts folder that is a link (to anywhere): refused, nothing written there.
    const elsewhere = tempDir('canon-elsewhere');
    symlinkSync(elsewhere, join(dir, 'Linked drafts'));
    await refused(using(dir, { access: 'drafts', draftsFolder: 'Linked drafts' }), NOTE, /is a link, and Canon writes only into plain folders inside the vault/);
    assert.deepEqual(readdirSync(elsewhere), []);
    // Names and tags as files and Obsidian take them.
    assert.equal(slugOf('../../etc/passwd: "x"'), 'etc passwd x');
    assert.equal(slugOf('...'), 'Note');
    assert.equal(cleanTitle('two\nlines'), 'two lines');
    assert.deepEqual(cleanTags('a, #b ,c d'), ['a', 'b', 'c-d']);
    assert.deepEqual(KINDS, ['decision', 'fact', 'howto', 'gotcha']);
});

test('drafts: Promote changes nothing unless the settings allow it, then moves the draft out of drafts as an active note', async () => {
    const dir = vaultCopy();
    const draft = 'Drafts/2026-10-01 Gateway timeouts.md';
    const original = readFileSync(join(dir, draft), 'utf8');
    const before = filesIn(dir);
    for (const [settings, words] of [
        [using(dir), /Canon is read only.*To promote drafts, set it to Drafts and turn on “Allow promoting drafts”/],
        [using(dir, { access: 'drafts' }), /promoting is off \(“Allow promoting drafts” in Canon's settings\)\. Turn it on to promote drafts; until then Promote changes nothing\./],
        [using(dir, { promote: true }), /Canon is read only/],
    ]) {
        const result = await promote({ settings, path: draft, now: AT });
        assert.equal(result.ok, false);
        assert.match(result.reason, words);
        assert.deepEqual(filesIn(dir), before);
        assert.equal(readFileSync(join(dir, draft), 'utf8'), original);
    }
    assert.match(writeRefusal(using(dir, { access: 'drafts' }), 'capture') ?? 'allowed', /allowed/);
    // Allowed: out of the drafts folder, active, with when; every other line as written.
    const allowed = using(dir, { access: 'drafts', promote: true, promoteFolder: 'Notes' });
    const result = await promote({ settings: allowed, path: draft, now: AT });
    assert.deepEqual(result, { ok: true, from: draft, path: 'Notes/2026-10-01 Gateway timeouts.md' });
    assert.ok(!existsSync(join(dir, draft)));
    const promoted = readFileSync(join(dir, result.path), 'utf8');
    assert.equal(promoted, original.replace('status: draft', 'status: active').replace('\n---\n# ', '\npromoted: "2026-10-17T20:00:00.000Z"\n---\n# '));
    // Now it is a note: found for a prompt.
    const vault = await readVault(dir);
    assert.ok(vault.search('gateway idle connections keepalive').results.some((r) => r.path === result.path));
    // A name already taken where it goes: " 2", never over the other.
    writeFileSync(join(dir, 'Drafts/Gateway ports.md'), '---\nstatus: draft\n---\n# Gateway ports\n\nA newer list.\n');
    const second = await promote({ settings: using(dir, { access: 'drafts', promote: true, promoteFolder: 'Projects/harbor-gateway' }), path: 'Drafts/Gateway ports.md', now: AT });
    assert.equal(second.path, 'Projects/harbor-gateway/Gateway ports 2.md');
    assert.match(readFileSync(join(dir, 'Projects/harbor-gateway/Gateway ports.md'), 'utf8'), /8443/, 'the note that was there is untouched');
});

test('drafts: Promote refuses anything that is not a plain note in the drafts folder', async () => {
    const dir = vaultCopy();
    const settings = using(dir, { access: 'drafts', promote: true });
    const before = filesIn(dir);
    for (const [path, words] of [
        ['Home.md', /not a note in the drafts folder/],
        ['Drafts/../Home.md', /not a note in the drafts folder/],
        ['/etc/hosts.md', /not a note in the drafts folder/],
        ['Drafts/.hidden.md', /not a note in the drafts folder/],
        ['Drafts/Missing.md', /no longer there/],
        ['Drafts/notes.txt', /not a note in the drafts folder/],
    ]) {
        const result = await promote({ settings, path, now: AT });
        assert.equal(result.ok, false, path);
        assert.match(result.reason, words, path);
    }
    assert.equal(isDraftPath('drafts/Port notes.md', 'Drafts'), true, 'a Mac\'s disk ignores case');
    // A draft that is a link to a note elsewhere: left as it is.
    const outside = join(tempDir('canon-outside'), 'Elsewhere.md');
    writeFileSync(outside, '# Elsewhere\n');
    symlinkSync(outside, join(dir, 'Drafts/Linked.md'));
    const linked = await promote({ settings, path: 'Drafts/Linked.md', now: AT });
    assert.match(linked.reason, /not a plain file/);
    assert.equal(readFileSync(outside, 'utf8'), '# Elsewhere\n');
    assert.deepEqual(filesIn(dir).filter((p) => p !== 'Drafts/Linked.md'), before);
});

// ── The card's projection and the page ────────────────────────────────

test('projection: the card\'s view holds the count and the last recall; the session\'s turn comes from DSH\'s turns', () => {
    const recallEvent = (turn, notes, time = 5) => ({ type: 'user/message', time, data: { role: 'user', source: { kind: KIND, turn, notes } } });
    const events = [
        { type: 'turn/start', data: { turn: 1 } },
        recallEvent(1, [{ path: 'a.md', title: 'A' }]),
        { type: 'user/message', data: { source: { kind: 'user' } } },
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'turn/start', data: { turn: 3 } },
        recallEvent(3, [{ path: 'b.md', title: 'B' }, { path: 'c.md', title: '' }], 9),
        recallEvent(3, []),
        { type: 'nonsense' },
        null,
    ];
    const state = foldAll(events);
    assert.deepEqual(state, { v: 1, turn: 3, recall: { count: 2, last: { turn: 3, at: 9, notes: [{ path: 'b.md', title: 'B' }, { path: 'c.md', title: '' }] } } });
    assert.equal(viewOf(state), state.recall);
    const same = applyEvent(state, { type: 'assistant/message', data: {} });
    assert.equal(same, state, 'an event that changes nothing gives back the same state');
    assert.deepEqual(parseState({ v: 2 }), INITIAL);
    assert.deepEqual(parseState(JSON.parse(JSON.stringify(state))), state);
    assert.deepEqual(parseView({ count: -1, last: { turn: 'x' } }), { count: 0, last: null });
    const p = canonProjection();
    assert.equal(p.key, KEY);
    assert.equal(p.key, 'canonRecall');
    assert.deepEqual(p.init(), INITIAL);
    assert.doesNotThrow(() => p.apply(undefined, { type: 'turn/start', data: { turn: 'x' } }));
});

test('page: per-session switches survive a restart; recent sessions; why a session gets no notes', async () => {
    const dir = tempDir('canon-state');
    const file = join(dir, 'state.json');
    let store = new JsonStore(file, { parse: parseSwitches });
    let clock = 100;
    const switches = new Switches(store, () => clock);
    assert.equal(switches.set('s-1', false), true);
    clock = 200;
    assert.equal(switches.set('s-2', false), true);
    assert.equal(switches.set('s-2', false), false, 'already off');
    store.flush();
    store = new JsonStore(file, { parse: parseSwitches });
    const again = new Switches(store);
    assert.equal(again.isOff('s-1'), true);
    assert.deepEqual(again.list().map((s) => s.sessionId), ['s-2', 's-1']);
    assert.equal(again.set('s-1', true), true);
    assert.equal(again.isOff('s-1'), false);
    assert.deepEqual(parseSwitches({ v: 1, off: { ok: 5, bad: 'x', '': 3 } }), { v: 1, off: { ok: 5 } });
    assert.deepEqual(parseSwitches('broken'), { v: 1, off: {} });
    // Recent recall: newest session first, its last three recalls, and sessions only switched off.
    const recalls = new Journal(join(dir, 'recall.jsonl'), { now: () => clock });
    for (const [sessionId, turn] of [['a', 1], ['b', 1], ['a', 2], ['a', 3], ['a', 4]]) {
        clock += 1;
        recalls.add({ kind: 'recall', sessionId, turn, notes: [{ path: `${sessionId}${turn}.md`, title: '' }] });
    }
    const rows = recentSessions(recalls.list({ limit: 300 }), again);
    assert.deepEqual(rows.map((r) => [r.sessionId, r.count, r.recalls.map((x) => x.turn), r.off]), [['a', 4, [4, 3, 2], false], ['b', 1, [1], false], ['s-2', 0, [], true]]);
    // The page's state, and one session's card.
    const settings = { ...DEFAULTS, vault: vaultCopy() };
    const check = new SettingsCheck({ settings, check: (s) => checkConfig(s, { home: HOME }), liveKeys: LIVE_SETTINGS, label: 'canon' });
    check.run();
    const vault = await readVault(settings.vault);
    const events = new Journal(join(dir, 'events.jsonl'));
    events.add({ kind: 'settings', text: 'Settings changed', why: 'They apply now.' });
    const parts = { config: settings, check, current: () => resolved(settings, HOME), vault, events, recalls, switches: again, titles: async (ids) => new Map(ids.map((id) => [id, `Title of ${id}`])) };
    const page = await pageState(parts);
    assert.equal(page.enabled, true);
    assert.equal(page.problem, undefined);
    assert.equal(page.vault.state, 'ok');
    assert.equal(page.settings.access, 'read-only');
    assert.deepEqual(page.sessions.map((s) => s.title), ['Title of a', 'Title of b', 'Title of s-2']);
    assert.deepEqual(page.drafts.map((d) => d.sessionTitle).sort(), ['', 'Title of fixture-session-1']);
    assert.equal(page.history[0].text, 'Settings changed');
    assert.deepEqual(sessionState(parts, 's-2'), { on: true, off: true, why: '', access: 'read-only' });
    settings.recall = false;
    assert.equal(sessionState(parts, 'x').why, 'Adding notes to turns is off in Canon\'s settings.');
    settings.recall = true;
    settings.maxNotes = 99;
    check.run();
    assert.equal(working(parts), false);
    assert.match(sessionState(parts, 'x').why, /waiting for a setting to be fixed/);
    const waiting = await pageState(parts);
    assert.match(waiting.problem.text, /Notes a turn, at most/);
    assert.deepEqual([waiting.sessions, waiting.drafts, waiting.vault.state], [[], [], 'unset'], 'nothing is read while a setting is wrong');
    settings.maxNotes = 3;
    settings.enabled = false;
    check.run();
    assert.equal(sessionState(parts, 'x').why, 'Canon is switched off in DSH\'s profile.');
});

// ── The whole plugin, with DSH stood in for ───────────────────────────

/** DSH as Canon's apply() meets it: events, effects, services, projections, tools and the session list. */
function standInDsh() {
    const handlers = new Map();
    const disposers = [];
    const provided = new Map();
    const tools = new Map();
    const projections = [];
    const states = new Map();
    const warnings = [];
    const scope = {
        tools: {
            register(tool) {
                if (tools.has(tool.name)) throw new Error(`tool ${tool.name} is registered twice`);
                tools.set(tool.name, tool);
                return () => tools.delete(tool.name);
            },
        },
        provide: (name, value) => provided.set(name, value),
    };
    const ctx = {
        logger: { warn: (line) => warnings.push(line), info: () => {} },
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event).push(fn);
            return () => {};
        },
        effect(fn) {
            const off = fn();
            if (typeof off === 'function') disposers.push(off);
        },
        inject(names, fn) {
            // Session Watch is not running here: Canon works without it.
            if (names.includes('sessionWatch')) return;
            const off = fn(scope);
            if (typeof off === 'function') disposers.push(off);
        },
        sessionProjections: {
            register: (projection) => projections.push(projection),
            stateOf: (session, key) => states.get(`${session?.id}\0${key}`),
            // DSH folds a title lazily: s-2's list row has none until its open session is asked.
            snapshot: (session, keys) => (session?.id === 's-2' && keys.includes('title') ? { values: { title: 'Open title' } } : { values: {} }),
        },
        sessionController: {
            list: async () => ({ items: [{ sessionId: 's-1', projections: { values: { title: 'Gateway work' } } }, { sessionId: 's-2', projections: { values: {} } }] }),
        },
        get: (name) => (name === 'sessions' ? { get: (id) => (id === 's-2' ? { id } : undefined) } : undefined),
    };
    return {
        ctx, provided, tools, projections, states, warnings,
        emit: (event, ...args) => Promise.all((handlers.get(event) ?? []).map((fn) => fn(...args))),
        preStep: (payload, next) => handlers.get('agent/pre-step')[0](payload, next),
        stop: () => { for (const off of disposers.splice(0).reverse()) off(); },
    };
}

test('plugin: a prompt gets the cited block; per-session off stops it; capture and Promote follow the settings and are logged', async () => {
    await import('./fixtures/canon/stubs/hooks.mjs');
    const canon = await import('../plugins/canon/lib/index.js');
    const { marked } = await import('./fixtures/canon/stubs/dsh-typert-protocol.mjs');
    const dshHome = tempDir('canon-dsh');
    process.env.CANON_TEST_DSH_HOME = dshHome;
    const vault = vaultCopy();
    const before = filesIn(vault);
    assert.equal(canon.name, 'canon');
    assert.deepEqual(Object.keys(canon.Config.shape), ['enabled', ...LIVE_SETTINGS]);
    assert.ok(LIVE_SETTINGS.every((key) => canon.Config.shape[key].live), 'every setting but enabled is live');
    assert.equal(canon.Config.shape.enabled.live, false);
    for (const [key, value] of Object.entries(DEFAULTS)) assert.equal(canon.Config.shape[key].value, value, key);
    // Every setting takes any value, so a wrong type is said in words (checkConfig), never dropped or a failed start.
    for (const key of Object.keys(DEFAULTS)) assert.equal(canon.Config.shape[key].type, 'any', key);
    assert.deepEqual([...marked].sort(), ['promote', 'refresh', 'search', 'session', 'setSession', 'state']);

    const dsh = standInDsh();
    const config = { ...DEFAULTS, vault };
    canon.apply(dsh.ctx, config);
    assert.deepEqual(dsh.projections.map((p) => p.key), ['canonRecall']);
    assert.equal(dsh.tools.size, 0, 'read only: agents are offered no capture tool');
    const remote = dsh.provided.get('dshPluginCanonRemote');
    assert.ok(remote);

    // A person's prompt in a session in the harbor-gateway folder.
    const s = step();
    const decision = await dsh.preStep(s.payload, s.next);
    const added = decision.messages[decision.messages.indexOf(s.prompt) + 1];
    assert.equal(added.source.kind, 'dsh-plugin-canon');
    assert.match(added.content[0].text, /\[1\] Projects\/harbor-gateway\/Gateway ports\.md/);
    const page = await remote.state();
    assert.deepEqual(page.sessions.map((r) => [r.sessionId, r.title, r.count]), [['s-1', 'Gateway work', 1]]);
    assert.deepEqual(page.vault.counts, { notes: 42, active: 35, drafts: 2, other: 5, unreadable: 0 });
    const recallLog = readFileSync(join(dshHome, 'canon', 'recall.jsonl'), 'utf8');
    assert.match(recallLog, /"text":"Added 1 note to turn 1"/);

    // Off for this session: the next prompt gets nothing, and it is logged.
    assert.deepEqual(await remote.setSession('s-1', false), { sessionId: 's-1', off: true, changed: true });
    assert.deepEqual(await remote.session('s-1'), { on: true, off: true, why: '', access: 'read-only' });
    const off = step({ id: 'm-2', turn: 2 });
    const offDecision = await off.next();
    assert.equal(await dsh.preStep(off.payload, async () => offDecision), offDecision);
    const offState = await remote.state();
    assert.match(offState.history[0].why, /Canon adds nothing to “Gateway work” until it is turned back on\./);
    assert.deepEqual([offState.history[0].sessionTitle, offState.history[0].sessionKnown], ['Gateway work', true], 'what happened names the session as DSH does now');
    await remote.setSession('s-1', true);
    // A session whose list row has no title yet: its title is read from the open session.
    await remote.setSession('s-2', false);
    assert.match((await remote.state()).history[0].why, /Canon adds nothing to “Open title” until it is turned back on\./);
    await remote.setSession('s-2', true);
    const on = step({ id: 'm-3', turn: 3 });
    assert.equal((await dsh.preStep(on.payload, on.next)).messages.length, 4, 'back on: notes again');

    // The page's try-out.
    const tried = await remote.search('How do I rotate the TLS certificates?', '');
    assert.equal(tried.results[0].path, 'Runbooks/Rotating TLS certificates.md');
    await assert.rejects(remote.search('   '), (error) => error.code === 'canon/refused' && /Type a prompt to try\./.test(error.message));
    // Its folder: ~/ is the home folder, as a turn's session has it; a folder that is not a full path is refused in words.
    const portPrompt = 'What port does the harbor gateway listen on?';
    const typed = await remote.search(portPrompt, ' ~/Projects/harbor-gateway ');
    assert.deepEqual(typed, await remote.search(portPrompt, join(homedir(), 'Projects', 'harbor-gateway')));
    assert.equal(typed.place, '~/Projects/harbor-gateway');
    assert.deepEqual([typed.results[0].path, typed.results[0].folder, typed.folder.repo], ['Projects/harbor-gateway/Gateway ports.md', 'repo', 'harbor-gateway']);
    assert.equal((await remote.search(portPrompt, '')).place, '');
    for (const folder of ['Projects/harbor-gateway', './harbor-gateway', '~someone/x']) {
        await assert.rejects(remote.search(portPrompt, folder), (error) => error.code === 'canon/refused'
            && error.message === `The session folder must be a full path, such as /Users/you/Projects/app, or start with ~/, such as ~/Projects/app (it is “${folder}”). Leave it empty for a session with no folder.`, folder);
    }

    // Promote while read only: refused in words, logged, nothing changed.
    const draft = 'Drafts/2026-10-01 Gateway timeouts.md';
    await assert.rejects(remote.promote(draft), (error) => error.code === 'canon/refused' && /Not promoted: Canon is read only/.test(error.message));
    assert.deepEqual(filesIn(vault), before);
    assert.equal((await remote.state()).history[0].state, 'refused');

    // Drafts allowed (a save in Plugins): the capture tool is offered, and a call writes one draft.
    config.access = 'drafts';
    await dsh.emit('loader/volatile-update', [['access']]);
    assert.deepEqual([...dsh.tools.keys()], ['canon_capture']);
    const tool = dsh.tools.get('canon_capture');
    assert.deepEqual(Object.keys(tool.parameters), ['title', 'body', 'kind', 'tags']);
    dsh.states.set('s-1\0canonRecall', { v: 1, turn: 3, recall: { count: 2, last: null } });
    const exec = { agent: { session: { id: 's-1', header: { cwd: '/work/Projects/harbor-gateway' } } } };
    const saved = await tool.execute({ title: 'Gateway health check port', body: 'The load balancer checks port 8080.', kind: 'fact' }, exec);
    assert.match(saved.text, /^Saved a draft to the canon vault: Drafts\/\d{4}-\d\d-\d\d Gateway health check port\.md\. It is a draft/);
    assert.equal(saved.view.ok, true);
    const written = filesIn(vault).filter((p) => !before.includes(p));
    assert.equal(written.length, 1);
    const draftData = parseNote(readFileSync(join(vault, written[0]), 'utf8')).data;
    assert.deepEqual([draftData.status, draftData.kind, draftData.source.session, draftData.source.turn], ['draft', 'fact', 's-1', 3]);
    // The page names a draft's session while DSH has it, and offers it as a link only then.
    await remote.refresh();
    const listedDrafts = (await remote.state()).drafts;
    const fresh = listedDrafts.find((d) => d.path === written[0]);
    const old = listedDrafts.find((d) => d.path === 'Drafts/2026-10-01 Gateway timeouts.md');
    assert.deepEqual([fresh?.sessionId, fresh?.sessionTitle, fresh?.sessionKnown], ['s-1', 'Gateway work', true]);
    assert.deepEqual([old?.sessionId, old?.sessionTitle, old?.sessionKnown], ['fixture-session-1', '', false]);
    let history = (await remote.state()).history;
    assert.equal(history[0].kind, 'capture');
    assert.equal(history[0].text, 'Draft saved: “Gateway health check port”');
    assert.equal(history[1].text, 'Settings changed: “What Canon may write”');
    // A Read Only session saves nothing.
    dsh.states.set('s-ro\0sandboxMode', 'read-only');
    const ro = await tool.execute({ title: 'Anything', body: 'Body.', kind: 'fact' }, { agent: { session: { id: 's-ro', header: { cwd: '/work' } } } });
    assert.match(ro.text, /^Not saved: this session is Read Only, so Canon saves nothing from it\./);
    assert.equal(filesIn(vault).length, before.length + 1);

    // Promote with drafts but promoting off: refused; then allowed: the draft becomes a note that turns get.
    await assert.rejects(remote.promote(draft), /Not promoted: promoting is off/);
    assert.ok(existsSync(join(vault, draft)));
    config.promote = true;
    await dsh.emit('loader/volatile-update', [['promote']]);
    const promoted = await remote.promote(draft);
    assert.equal(promoted.path, '2026-10-01 Gateway timeouts.md');
    assert.ok(!existsSync(join(vault, draft)));
    history = (await remote.state()).history;
    assert.equal(history[0].text, 'Draft promoted to an active note');
    const later = step({ id: 'm-4', turn: 4, text: 'Why do idle gateway connections drop?' });
    const laterDecision = await dsh.preStep(later.payload, later.next);
    assert.ok(laterDecision.messages.some((m) => m.source?.kind === 'dsh-plugin-canon' && m.source.notes.some((n) => n.path === promoted.path)));

    // A wrong setting: Canon adds and offers nothing, and says which setting; fixed, it works again.
    config.maxChars = 5;
    await dsh.emit('loader/volatile-update', [['maxChars']]);
    assert.equal(dsh.tools.size, 0);
    const waiting = await remote.state();
    assert.match(waiting.problem.text, /Characters a turn, at most \(maxChars\)/);
    const w = step({ id: 'm-5', turn: 5 });
    const wDecision = await w.next();
    assert.equal(await dsh.preStep(w.payload, async () => wDecision), wDecision);
    await assert.rejects(remote.promote('Drafts/Port notes.md'), /waiting for a setting to be fixed/);
    config.maxChars = 2000;
    await dsh.emit('loader/volatile-update', [['maxChars']]);
    assert.deepEqual([...dsh.tools.keys()], ['canon_capture']);
    assert.equal((await remote.state()).history[0].text, 'Settings fixed: Canon is working again');

    // Stopped: the tool goes, the switches are saved, nothing throws; the vault holds only what Canon was asked to write.
    dsh.stop();
    assert.equal(dsh.tools.size, 0);
    assert.ok(JSON.parse(readFileSync(join(dshHome, 'canon', 'state.json'), 'utf8')).v === 1);
    assert.deepEqual(dsh.warnings, ['canon: not working until a setting is fixed: Characters a turn, at most (maxChars) must be a whole number of characters from 400 to 8000 (it is 5)']);
    const events = readFileSync(join(dshHome, 'canon', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).add?.kind).filter(Boolean);
    assert.deepEqual([...new Set(events)].sort(), ['capture', 'promote', 'session', 'settings']);
    await settle();
});

test('plugin: switched off in the profile, Canon reads no vault, offers no tool and says so', async () => {
    await import('./fixtures/canon/stubs/hooks.mjs');
    const canon = await import('../plugins/canon/lib/index.js');
    process.env.CANON_TEST_DSH_HOME = tempDir('canon-dsh-off');
    const dsh = standInDsh();
    canon.apply(dsh.ctx, { ...DEFAULTS, enabled: false, vault: vaultCopy(), access: 'drafts' });
    assert.equal(dsh.tools.size, 0);
    assert.deepEqual(dsh.projections, []);
    const remote = dsh.provided.get('dshPluginCanonRemote');
    const page = await remote.state();
    assert.equal(page.enabled, false);
    assert.equal(page.vault.state, 'unset');
    await assert.rejects(remote.refresh(), /switched off in DSH's profile \(enabled: false\)/);
    dsh.stop();
});

test('plugin: a vault folder Canon may not list: its page says so and what to do, What happened notes it once, Read again recovers', async (t) => {
    await import('./fixtures/canon/stubs/hooks.mjs');
    const canon = await import('../plugins/canon/lib/index.js');
    process.env.CANON_TEST_DSH_HOME = tempDir('canon-dsh-locked');
    // A copy made unreadable in this test's own temp folder; its access is given back when the test ends.
    const locked = vaultCopy('canon-locked');
    chmodSync(locked, 0o000);
    t.after(() => chmodSync(locked, 0o755));
    const dsh = standInDsh();
    canon.apply(dsh.ctx, { ...DEFAULTS, vault: locked });
    const remote = dsh.provided.get('dshPluginCanonRemote');
    const failed = await remote.refresh();
    assert.deepEqual([failed.state, failed.error.code], ['error', 'no-access']);
    assert.match(failed.error.text, /^DSH may not read .+\. Give DSH access to it \(on a Mac: System Settings, Privacy & Security, Files and Folders\), or choose another folder\.$/);
    let page = await remote.state();
    assert.equal(page.vault.state, 'error');
    assert.deepEqual(page.history.filter((e) => e.kind === 'vault').map((e) => [e.state, e.text, e.why]), [['failed', 'Couldn\'t read the vault', failed.error.text]]);
    // Meanwhile a prompt gets nothing, and the card says why.
    const s = step();
    const decision = await s.next();
    assert.equal(await dsh.preStep(s.payload, async () => decision), decision);
    assert.equal((await remote.session('s-1')).why, 'Canon cannot read the vault now: see its page.');
    // Read again while it still cannot: the same words, logged once.
    await remote.refresh();
    assert.equal((await remote.state()).history.filter((e) => e.kind === 'vault').length, 1);
    // Access given: Read again reads it, and What happened says so.
    chmodSync(locked, 0o755);
    const back = await remote.refresh();
    assert.deepEqual([back.state, back.counts.active], ['ok', 35]);
    page = await remote.state();
    assert.deepEqual([page.history[0].state, page.history[0].text, page.history[0].why], ['done', 'Reading the vault again', '35 active notes, 2 drafts.']);
    const again = step({ id: 'm-2', turn: 2 });
    assert.ok((await dsh.preStep(again.payload, again.next)).messages.some((m) => m.source?.kind === 'dsh-plugin-canon'));
    dsh.stop();
});

test('plugin: a number in quotes in the profile never stops Canon: it starts, says which setting in words, and works once fixed', async () => {
    await import('./fixtures/canon/stubs/hooks.mjs');
    const canon = await import('../plugins/canon/lib/index.js');
    process.env.CANON_TEST_DSH_HOME = tempDir('canon-dsh-quoted');
    const dsh = standInDsh();
    const config = { ...DEFAULTS, vault: vaultCopy(), maxChars: '900' };
    assert.doesNotThrow(() => canon.apply(dsh.ctx, config));
    const remote = dsh.provided.get('dshPluginCanonRemote');
    const page = await remote.state();
    assert.deepEqual(page.problem, { key: 'maxChars', text: 'Characters a turn, at most (maxChars) must be a whole number of characters from 400 to 8000, written without quotes (it is “900”, which is text)', live: true });
    const s = step();
    const decision = await s.next();
    assert.equal(await dsh.preStep(s.payload, async () => decision), decision, 'no block while it is wrong');
    config.maxChars = 900;
    await dsh.emit('loader/volatile-update', [['maxChars']]);
    const fixed = await remote.state();
    assert.equal(fixed.problem, undefined);
    assert.equal(fixed.settings.maxChars, 900);
    assert.equal(fixed.history[0].text, 'Settings fixed: Canon is working again');
    dsh.stop();
});

// ── The package ───────────────────────────────────────────────────────

test('package: DSH lists Canon with one plain sentence and its icon; every file parses', () => {
    const dir = join(ROOT, 'plugins', 'canon');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const meta = JSON.parse(readFileSync(join(dir, 'locale', 'en.json'), 'utf8')).meta;
    assert.equal(pkg.name, 'dsh-plugin-canon');
    assert.equal(meta.title, 'Canon');
    assert.match(meta.description, /^[^.\n]+\.$/);
    assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
    assert.ok(pkg.files.includes('locale') && pkg.files.includes(pkg.icon.replace(/^\.\//, '')));
    const icon = readFileSync(join(dir, pkg.icon), 'utf8');
    assert.match(icon, /^<svg [^>]*viewBox="0 0 36 36"/);
    assert.match(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), /name: dsh-plugin-canon/);
    for (const file of readdirSync(join(dir, 'lib'), { recursive: true }).filter((f) => f.endsWith('.js'))) {
        assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(dir, 'lib', file)]), file);
    }
});
