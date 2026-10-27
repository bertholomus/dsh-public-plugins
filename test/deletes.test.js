import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { deletesOf, codeDeletesOf, deletesWhat, isFree, madeDirsOf, identityOf, middleCut } from '../plugins/coordinator/lib/deletes.js';

// What a project thread's command deletes (plugins/coordinator/lib/deletes.js): the plugin asks the user before one that
// deletes files the thread didn't create. Scripts the thread created are read through `read`, here from this table.
const files = {
  '/w/tidy.sh': '#!/bin/sh\nrm -rf build\n',
  '/w/gen.py': "import shutil\nshutil.rmtree('out')\n",
  '/w/cleanup.sh': '#!/bin/sh\necho done\n',
};
const at = { cwd: '/w', read: (path) => files[path] };

const DELETES = [
  'rm -rf build/',
  'rm build/a.o build/b.o',
  'rmdir build',
  'unlink build/a.o',
  'shred -u secrets.txt',
  'git clean -fdx',
  'git clean -f -- build',
  'git rm old.txt',
  "find . -name '*.o' -delete",
  'find build -type f -exec rm {} \\;',
  'find . -name "*.tmp" | xargs rm -f',
  'npx rimraf dist',
  'sudo rm -rf /var/www/old',
  'env X=1 timeout 5 nice -n 5 rm -rf build',
  '/bin/rm -rf build',
  "'r''m' -rf build",
  'r\\m -rf build',
  "bash -c 'rm -rf build'",
  'sh -lc "cd /w && rm -rf build"',
  'eval "rm -rf build"',
  "bash <<'EOF'\nrm -rf build\nEOF",
  'cat <<EOF | sh\nrm -rf build\nEOF',
  'echo "rm -rf build" | bash',
  'echo "$(rm -rf build)"',
  "python3 -c \"import shutil; shutil.rmtree('build')\"",
  "python3 - <<'EOF'\nimport os\nos.remove('a.txt')\nEOF",
  "node -e \"require('fs').rmSync('build', { recursive: true })\"",
  "node -e \"require('child_process').execSync('rm -rf build')\"",
  'pwsh -Command "Remove-Item -Recurse build"',
  'sh tidy.sh',
  'python3 gen.py',
  'npm run clean',
  'yarn clean:all',
  'make distclean',
  'cargo clean',
  'mvn -q clean install',
  './gradlew :app:clean',
  'cmake --build out --target clean',
  './scripts/cleanup.sh',
];

const NO_DELETES = [
  'ls -la build',
  'echo rm -rf build',
  "printf 'rm -rf %s\\n' build",
  '# rm -rf build',
  'git clean -n',
  'git clean --dry-run -fd',
  'git rm --cached old.txt',
  'git status',
  'rm --help',
  'command -v rm',
  'cat build/a.o > /dev/null',
  'git mv old.txt new.txt',
  'rsync -a out/ /tmp/out/',
  'cp README.md /tmp/',
  'npm run build',
  'npm ci',
  'make',
  'cargo build --release',
  'cargo remove serde',
  'mvn install',
  'dotnet test --filter CleanupTests',
  './build.sh',
  'python3 -m pytest',
  "python3 -c \"print('use os.remove to delete')\"",
  "grep -r 'shutil.rmtree' src",
  'sh cleanup.sh',
];

test('deletes: rm and the rest, through wrappers, quotes, here-documents, code and scripts', () => {
    for (const command of DELETES) assert.ok(deletesOf(command, at).length > 0, `a delete: ${command}`);
    assert.ok(deletesOf('Remove-Item -Recurse -Force build', { ...at, shell: 'pwsh' }).length > 0);
    assert.ok(deletesOf('rm build', { ...at, shell: 'pwsh' }).length > 0);
    assert.ok(deletesOf('$r = Remove-Item build', { ...at, shell: 'pwsh' }).length > 0);
});

test('deletes: commands that delete nothing', () => {
    for (const command of NO_DELETES) assert.deepEqual(deletesOf(command, at), [], `no delete: ${command}`);
    assert.deepEqual(deletesOf('Remove-Item build -WhatIf', { ...at, shell: 'pwsh' }), []);
    assert.deepEqual(deletesOf('./tidy.sh', { cwd: '/w' }), [], 'a script it may not read counts only by its name');
    assert.equal(deletesOf('./cleanup.sh', { cwd: '/w' }).length, 1, 'and that name can say it cleans');
});

test('deletes: what a delete says, after "the command"', () => {
    const said = (command) => deletesWhat(deletesOf(command, at));
    assert.equal(said('rm -rf build/'), 'deletes build/ (rm)');
    assert.equal(said('rm -rf build dist'), 'deletes build and dist (rm)');
    assert.equal(said('rm a b c d e'), 'deletes a, b and 3 more (rm)');
    assert.equal(said('git clean -fdx && rm -rf build'), 'deletes untracked and ignored files (git clean) and build (rm)');
    assert.equal(said("find . -name '*.o' -delete"), 'deletes what it finds in . (find -delete)');
    assert.equal(said('ls | xargs rm'), 'deletes the files named on its input (xargs rm)');
    assert.equal(said('sh tidy.sh'), 'runs tidy.sh, which can delete build (rm)');
    assert.equal(said('npm run clean'), 'runs npm run clean, whose name says it deletes files');
    assert.equal(said('cargo clean'), 'runs cargo clean, whose name says it deletes files');
    assert.equal(said("python3 -c \"import shutil; shutil.rmtree('build')\""), 'runs code that deletes build (python3)');
    assert.equal(said("python3 -c \"import os; os.system('rm -rf build')\""), 'runs code that deletes build (rm)');
});

test('deletes: a prompt names the file: from the thread\'s folder when it is in it, else cut in the middle, so its name stays (round-1 finding 4)', () => {
    const ws = '/Users/someone/Projects/goal95/judge/coordinator-r1/ws';
    const said = (command, folders = [ws]) => deletesWhat(deletesOf(command, { cwd: ws }), { folders });
    // Before, the path was cut from its start: "deletes /Users/someone/Projects/goal95/judge/coordinator-r1/ws/RE… (rm)".
    assert.equal(said(`rm ${ws}/README.md`), 'deletes README.md (rm)');
    assert.equal(said(`rm -rf ${ws}/notes/old ${ws}/build/`), 'deletes notes/old and build (rm)');
    assert.equal(said('cd notes && rm list.txt'), 'deletes notes/list.txt (rm)', 'from the folder, not from where it cd-ed');
    assert.equal(said('rm -rf build/'), 'deletes build/ (rm)', 'as the command names it when that is the same');
    assert.equal(said(`rm -rf ${ws}`), 'deletes the whole folder ws (rm)');
    // Outside the folders, a long path keeps its end.
    const far = '/Users/someone/Library/Application-Support/SomeLongVendorName/caches/the-file-it-deletes.db';
    const words = said(`rm ${far}`);
    assert.match(words, /^deletes \/Users\/someone\/.*….*\/the-file-it-deletes\.db \(rm\)$/);
    assert.ok(words.length <= 'deletes  (rm)'.length + 60, words);
    assert.equal(middleCut('short/path.txt'), 'short/path.txt');
    assert.equal(middleCut(`${ws}/README.md`), '/Users/someone/Projects/…/judge/coordinator-r1/ws/README.md');
    assert.equal(middleCut('x'.repeat(100)).length, 60);
    assert.ok(middleCut('x'.repeat(100)).includes('…'));
});

test('deletes: a path is said from the folder whether it or the folder is named by its real path (macOS\'s /var is /private/var)', () => {
    const work = mkdtempSync(join(tmpdir(), 'deletes-real-'));
    writeFileSync(join(work, 'a.txt'), 'x');
    const real = realpathSync(work);
    assert.equal(deletesWhat(deletesOf(`rm ${join(real, 'a.txt')}`, { cwd: work }), { folders: [work] }), 'deletes a.txt (rm)');
    assert.equal(deletesWhat(deletesOf(`rm ${join(work, 'a.txt')}`, { cwd: work }), { folders: [real] }), 'deletes a.txt (rm)');
});

test('deletes: a move out of the thread\'s folders asks as a delete of what moves; a move inside them is a rename (round-1 finding 6)', () => {
    const work = mkdtempSync(join(tmpdir(), 'deletes-moves-'));
    writeFileSync(join(work, 'README.md'), 'the user\'s');
    mkdirSync(join(work, 'notes'));
    writeFileSync(join(work, 'notes', 'list.txt'), 'the user\'s');
    mkdirSync(join(work, 'docs'));
    writeFileSync(join(work, 'mine.txt'), 'x');
    const mine = mineOf([join(work, 'mine.txt')]);
    const items = (command) => deletesOf(command, { cwd: work });
    const free = (command) => items(command).every((d) => isFree(d, { work: [work], mine }));
    // Before, mv counted as nothing at all: every one of these passed the check.
    for (const command of ['mv README.md /tmp/', 'mv -t /tmp README.md', 'mv --target-directory=/tmp README.md', 'mv README.md ../', 'mv README.md "$DEST"',
        'mv notes .git/', 'mv . /tmp/x', `mv ${work} /tmp/w`, 'mv *.md /tmp/', 'sudo mv README.md /tmp/', "bash -c 'mv notes/list.txt /tmp/'", 'd=$(mktemp -d) && mv README.md "$d"/',
        'rsync -a --remove-source-files notes/ backup:/srv/notes/', 'rsync -a --remove-source-files notes/ /tmp/notes/', 'ls | xargs mv -t /tmp', "find . -name '*.md' | xargs -I{} mv {} /tmp/"]) {
        assert.ok(items(command).length > 0, `counted: ${command}`);
        assert.ok(!free(command), `asks: ${command}`);
    }
    // Inside the folders a move is a rename; the thread's own file may go anywhere; what isn't there moves nothing.
    for (const command of ['mv README.md docs/README.md', 'mv notes notes-old', 'mv -t docs README.md', 'mv *.md docs/', 'mv notes/list.txt .', 'rsync -a --remove-source-files notes/ ./copy/',
        'mv mine.txt /tmp/', 'mv gone.txt /tmp/']) {
        assert.ok(free(command), `free: ${command}`);
    }
    // What the prompt says.
    const said = (command) => deletesWhat(items(command).filter((d) => !isFree(d, { work: [work], mine })), { folders: [work] });
    assert.equal(said('mv README.md /tmp/'), 'moves README.md to /tmp/ (mv)');
    assert.equal(said('mv README.md notes/list.txt /tmp/'), 'moves README.md and notes/list.txt to /tmp/ (mv)');
    assert.equal(said('rm -rf notes && mv README.md ~/old/'), 'deletes notes (rm) and moves README.md to ~/old/ (mv)');
    assert.equal(said('rsync -a --remove-source-files notes/ backup:/srv/notes/'), 'moves notes/ to backup:/srv/notes/ (rsync)');
    assert.equal(said('ls | xargs mv -t /tmp'), 'moves the files named on its input to /tmp (xargs mv)');
    assert.equal(said('mv README.md "$DEST"'), 'moves README.md to $DEST (mv)');
    assert.equal(said(`mv ${work} /tmp/w`), `moves the whole folder ${work.split('/').at(-1)} to /tmp/w (mv)`);
});

test('deletes: where each thing is, when that can be told', () => {
    const where = (command, options = at) => deletesOf(command, options).map((d) => (d.temp ? 'temp' : d.full ?? (d.glob !== undefined ? `glob ${d.glob}` : null)));
    assert.deepEqual(where('rm -rf build ../other /abs ~/x'), ['/w/build', '/other', '/abs', join(homedir(), 'x')]);
    assert.deepEqual(where('cd sub && rm -rf build'), ['/w/sub/build']);
    assert.deepEqual(where('cd "$DIR" && rm -rf build'), [null]);
    assert.deepEqual(where('rm -rf $DIR "$HOME/x" build/*.o'), [null, null, 'glob /w/build/']);
    assert.deepEqual(where('d=$(mktemp -d) && rm -rf "$d" "$d/sub"'), ['temp', 'temp']);
    assert.deepEqual(where('rm -f "$(mktemp)"; cd "$(mktemp -d)" && rm -rf x'), ['temp', 'temp']);
    assert.deepEqual(where('git -C sub clean -fd'), ['/w/sub']);
    assert.deepEqual(where('find /tmp/x -delete'), ['/tmp/x']);
    assert.deepEqual(where('rm -rf build', { cwd: undefined }), [null]);
});

/** What a thread made, as the plugin keeps it (projects.js mineOf): each path as the file it is now. */
const mineOf = (paths, spans = []) => ({ made: new Map(paths.map((p) => [p, identityOf(lstatSync(p))])), spans });

test('deletes: free are the files the thread created, a folder of only those, the temp folder outside the workspace and mktemp\'s; never .git', () => {
    const work = mkdtempSync(join(tmpdir(), 'deletes-work-'));
    mkdirSync(join(work, 'build'));
    writeFileSync(join(work, 'build', 'a.o'), 'x');
    mkdirSync(join(work, 'scratch'));
    writeFileSync(join(work, 'scratch', 'n.txt'), 'x');
    writeFileSync(join(work, 'mine.txt'), 'x');
    mkdirSync(join(work, 'empty'));
    const mine = mineOf([join(work, 'mine.txt'), join(work, 'scratch', 'n.txt')]);
    const free = (command, m = mine) => deletesOf(command, { cwd: work }).every((d) => isFree(d, { work: [work], mine: m }));
    for (const command of ['rm mine.txt', 'rm -rf scratch', 'rm scratch/*.txt', 'rm -rf gone/', 'rm -rf /tmp/x', 'd=$(mktemp -d) && rm -rf "$d"', 'rm -f /tmp/foo-*']) assert.ok(free(command), command);
    for (const command of ['rm -rf build', 'rm -rf .', 'rmdir empty', 'rm -f .git/index.lock', 'rm -rf build/*.o', 'rm -rf /tmp/*', 'rm -rf "$X"', `rm -rf ${work}`, 'git clean -fd', 'ls | xargs rm']) assert.ok(!free(command), command);
    // A file made again in its place isn't the thread's (it deleted its own, and the user saved one there).
    writeFileSync(join(work, 'again.txt'), 'x');
    const before = mineOf([join(work, 'again.txt')]);
    renameSync(join(work, 'again.txt'), join(work, 'kept.txt'));
    writeFileSync(join(work, 'again.txt'), 'the user\'s');
    assert.ok(!free('rm again.txt', before));
    // Nor is what another session wrote with DSH's file tools.
    assert.ok(!free('rm mine.txt', { ...mine, foreign: (path) => path === join(work, 'mine.txt') }));
    // The temp folder doesn't make a workspace inside it free, nor a folder that holds one.
    assert.equal(isFree({ program: 'rm', path: 'x', full: join(work, 'build') }, { work: [work] }), false);
    assert.equal(isFree({ program: 'rm', path: 'x', full: '/tmp' }, { work: ['/w'] }), false);
});

test('deletes: a folder the thread made is its own with what was born there while it ran; not what was moved in, linked or made by anyone else (batch 5 review M1)', () => {
    const work = mkdtempSync(join(tmpdir(), 'deletes-made-'));
    const outside = mkdtempSync(join(tmpdir(), 'deletes-docs-'));
    writeFileSync(join(outside, 'report.txt'), 'the user\'s');
    mkdirSync(join(outside, 'sub'));
    // The user's folder, from before the thread ran.
    mkdirSync(join(work, 'legacy'));
    writeFileSync(join(work, 'legacy', 'notes.txt'), 'the user\'s');
    const ran = [Date.now() + 5000, Infinity];
    // What the thread's command made, born now; the thread "runs" from a moment later, so what is here now was born before.
    mkdirSync(join(work, '_qa', 'profile', '.git'), { recursive: true });
    writeFileSync(join(work, '_qa', 'profile', 'Cookies'), 'x');
    const made = mineOf([join(work, '_qa')], [[Date.now() - 1000, Date.now() + 1000]]);
    const free = (command, m) => deletesOf(command, { cwd: work }).every((d) => isFree(d, { work: [work], mine: m }));
    // Behaviour review 5, S1 r1: a headless browser's profile in a folder the thread made goes without asking, with a
    // .git born there (a clone of its own); a .git named on its own still asks.
    for (const command of ['rm -rf _qa', 'rm -rf _qa/profile', 'rm _qa/profile/Cookies', 'rm -rf _qa/*', 'find _qa -name Cookies -delete']) assert.ok(free(command, made), command);
    assert.ok(!free('rm -rf _qa/profile/.git', made));
    assert.ok(!free('rm -rf _qa', { ...made, spans: [] }), 'not once when it ran is gone (a restart)');
    // B1: mkdir old && mv legacy old/, then rm -rf old: what was moved in was born before the thread ran.
    mkdirSync(join(work, 'old'));
    const old = mineOf([join(work, 'old')], [ran]);
    renameSync(join(work, 'legacy'), join(work, 'old', 'legacy'));
    assert.ok(!free('rm -rf old', old));
    assert.ok(!free('rm -rf old/legacy/notes.txt', old));
    // B2: mv src lib2 && mkdir -p lib2/sub: lib2 was there before (the plugin keeps only a folder born while the
    // command ran: projects.js aroundMade), so only lib2/sub is the thread's.
    mkdirSync(join(work, 'src'));
    writeFileSync(join(work, 'src', 'main.js'), 'x');
    renameSync(join(work, 'src'), join(work, 'lib2'));
    mkdirSync(join(work, 'lib2', 'sub'));
    const lib2 = mineOf([join(work, 'lib2', 'sub')], [[Date.now() - 1000, Date.now() + 1000]]);
    assert.ok(free('rm -rf lib2/sub', lib2));
    assert.ok(!free('rm -rf lib2', lib2));
    // B3: mkdir -p out; the user saves a file there between the thread's calls; rm -rf out.
    mkdirSync(join(work, 'out'));
    const out = mineOf([join(work, 'out')], [[0, 1]]);
    writeFileSync(join(work, 'out', 'theirs.txt'), 'the user\'s');
    assert.ok(!free('rm -rf out', out));
    // B4: a link in a folder the thread made leads anywhere: deleting through it, or following it, asks.
    mkdirSync(join(work, 'scratch'));
    symlinkSync(outside, join(work, 'scratch', 'docs'));
    const scratch = mineOf([join(work, 'scratch')], [[Date.now() - 1000, Date.now() + 1000]]);
    for (const command of ['rm -rf scratch/docs/sub', 'rm scratch/docs/report.txt', 'find -L scratch -name "*.txt" -delete', 'rm -rf scratch/docs', 'rm -rf scratch/docs/*', 'rm -rf scratch']) {
        assert.ok(!free(command, scratch), command);
    }
    assert.ok(!codeDeletesOf("import shutil\nshutil.rmtree('scratch/docs/sub')", { cwd: work }).every((d) => isFree(d, { work: [work], mine: scratch })));
    // A made folder replaced since (the thread removed it and the user made one there) isn't the thread's.
    mkdirSync(join(work, 'tmp1'));
    const tmp1 = mineOf([join(work, 'tmp1')], [[Date.now() - 1000, Date.now() + 1000]]);
    renameSync(join(work, 'tmp1'), join(work, 'tmp1-gone'));
    mkdirSync(join(work, 'tmp1'));
    assert.ok(!free('rm -rf tmp1', tmp1));
    // m1: a `..` out of a link is beside where the link leads, so it can't be told from the words.
    symlinkSync(join(outside, 'sub'), join(work, 'link'));
    assert.deepEqual(deletesOf('rm -rf link/../report.txt', { cwd: work }).map((d) => d.full), [null]);
    assert.deepEqual(deletesOf('rm -rf build/../x', { cwd: work }).map((d) => d.full), [join(work, 'x')]);
});

test('deletes: the folders a command makes, for the thread\'s own', () => {
    assert.deepEqual(madeDirsOf('set -e\nmkdir -p _qa\nbrowser --user-data-dir="$PWD/_qa/profile"', { cwd: '/w/site' }), ['/w/site/_qa', '/w/site', '/w']);
    assert.deepEqual(madeDirsOf('mkdir build dist && cd build && mkdir -m 700 out', { cwd: '/w' }), ['/w/build', '/w/dist', '/w/build/out']);
    assert.deepEqual(madeDirsOf('sudo mkdir -p /opt/app && bash -c "mkdir inner"', { cwd: '/w' }), ['/opt/app', '/opt', '/w/inner']);
    assert.deepEqual(madeDirsOf('mkdir "$(date +%s)" $X ~user/x "*" && cd $D && mkdir y', { cwd: '/w' }), []);
    assert.deepEqual(madeDirsOf('mkdir x', {}), [], 'a relative path with no folder to take it from');
    assert.deepEqual(madeDirsOf('New-Item -ItemType Directory -Path out\\logs -Force; New-Item -Path notes.txt; md tmp', { cwd: '/w', shell: 'pwsh' }), ['/w/out/logs', '/w/out', '/w', '/w/tmp']);
});

test('deletes: code deletes by its calls; its strings count as commands only where it runs commands', () => {
    const paths = (code) => codeDeletesOf(code, { cwd: '/w' }).map((d) => d.full ?? d.path);
    assert.deepEqual(paths("import os\nos.remove('a.txt')"), ['/w/a.txt']);
    assert.deepEqual(paths("from pathlib import Path\nPath('/w/b.txt').unlink()"), ['/w/b.txt']);
    assert.deepEqual(paths('shutil.rmtree(folder)'), ['a path the code works out']);
    assert.deepEqual(paths("await fs.promises.rm('dist', { recursive: true })"), ['/w/dist']);
    assert.deepEqual(paths("import { rm } from 'node:fs/promises'\nawait rm('dist', { recursive: true })"), ['/w/dist']);
    assert.deepEqual(paths("subprocess.run(['rm', '-rf', 'build'])"), ['/w/build']);
    assert.deepEqual(paths("FileUtils.rm_rf('tmp/cache')"), ['/w/tmp/cache']);
    assert.deepEqual(paths("console.log('rm -rf build')"), []);
    assert.deepEqual(paths("print('call os.remove on it')"), []);
});

test('a workspace in the OS temp folder, named through a link (macOS /var is /private/var), is still the workspace', () => {
    // Its user files ask before they go, whichever spelling the command or DSH uses; never "a temp file outside it".
    const base = mkdtempSync(join(tmpdir(), 'deletes-link-'));
    mkdirSync(join(base, 'real', 'ws', 'legacy'), { recursive: true });
    writeFileSync(join(base, 'real', 'ws', 'legacy', 'notes.txt'), 'the user\'s notes\n');
    symlinkSync(join(base, 'real'), join(base, 'link'), 'dir');
    const real = join(base, 'real', 'ws');
    const viaLink = join(base, 'link', 'ws');
    const asked = (command, work) => deletesOf(command, { cwd: work }).some((d) => !isFree(d, { work: [work] }));
    assert.equal(asked(`rm -rf ${join(viaLink, 'legacy')}`, real), true, 'the command names the link, DSH the real folder');
    assert.equal(asked(`rm -rf ${join(real, 'legacy')}`, viaLink), true, 'the command names the real folder, DSH the link');
    assert.equal(asked(`rm -rf ${join(viaLink, 'legacy', '*.txt')}`, real), true, 'a pattern too');
    assert.equal(asked(`rm -rf ${join(viaLink, 'legacy')}`, viaLink), true);
});
