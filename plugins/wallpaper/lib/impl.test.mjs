// Offline test of the Wallpaper host: the first-start import from Fleet Shell, the settings it keeps and refuses,
// the config row's checks, an unreadable settings file, and the library routes (with the Trash across disks, a file
// that only has a picture's name, names in any script, and the answers for a refused value and a disk's fault).
// Runs in a temporary home that it removes, so nothing real is read or written:
//
//   node plugins/wallpaper/lib/impl.test.mjs
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync, utimesSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradientPng } from '../test/e2e/png.mjs';

const home = mkdtempSync(join(tmpdir(), 'wallpaper-test-'));
process.env.HOME = home;
process.env.DSH_HOME = join(home, '.dsh');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const fleet = join(home, '.dsh', 'fleet-shell');
mkdirSync(join(fleet, 'wallpapers', 'cars'), { recursive: true });
mkdirSync(join(fleet, 'wallpapers', 'notes'), { recursive: true });
writeFileSync(join(fleet, 'wallpapers', 'cars', 'a.jpg'), 'jpeg bytes');
writeFileSync(join(fleet, 'wallpapers', 'notes', 'readme.txt'), 'not a picture');
writeFileSync(join(fleet, 'state.json'), JSON.stringify({
  prefs: { headline: 'Ship  it\n', wallpaperRotate: 'daily', glassBlur: 30, glassTint: 'lots', projectsSidebar: true, hideNativeSettings: true },
  projects: [{ id: 'p1', name: 'Security' }], projectOf: { w1: 'p1' }, favorites: ['m1'],
}));

/** Start the host as DSH does, with this config row; returns a caller for its routes. */
async function start(config = {}, module = './impl.js') {
  const routes = {};
  const ctx = {
    inject: (_deps, fn) => fn({ connection: { fetch: { register: (def) => { routes[def.path] = def; return () => {}; } } }, effect: (f) => f() }),
    effect: (f) => f(),
  };
  const host = await import(module);
  await host.apply(ctx, config);
  const call = async (method, path, body) => {
    const r = routes[`/api/wallpaper/${path.split('?')[0]}`];
    assert.ok(r, `route ${path} registered`);
    const res = await r.fetch(new Request(`http://x/api/wallpaper/${path}`, method === 'GET' ? {} : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, json: type.includes('json') ? await res.json() : null, bytes: type.startsWith('image/') ? Buffer.from(await res.arrayBuffer()) : null };
  };
  return { call, host, routes };
}
const dataDir = join(home, '.dsh', 'wallpaper');
const saved = () => JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
const logText = () => readFileSync(join(dataDir, 'wallpaper.log'), 'utf8');
const { call, host } = await start({});

test('first start: Fleet Shell\'s look settings come over, checked; nothing else does; the originals stay', () => {
  const s = saved();
  assert.equal(s.prefs.headline, 'Ship it', 'the headline is one trimmed line');
  assert.equal(s.prefs.glassBlur, 30);
  assert.equal(s.prefs.glassTint, 55, 'a tint that is not a number is not imported');
  assert.equal(s.prefs.wallpaperRotateMin, 1440, 'old "daily" rotation becomes 1440 minutes');
  assert.equal(s.prefs.wallpaperRotate, null);
  for (const k of ['projectsSidebar', 'hideNativeSettings']) assert.ok(!(k in s.prefs), `${k} is not a Wallpaper setting`);
  assert.ok(!('projects' in s) && !('favorites' in s), 'no Projects or Fleet data');
  assert.equal(s.imported.images, 1);
  assert.ok(existsSync(join(dataDir, 'wallpapers', 'cars', 'a.jpg')), 'picture copied');
  assert.ok(existsSync(join(fleet, 'wallpapers', 'cars', 'a.jpg')), 'original kept');
  assert.deepEqual(readdirSync(join(dataDir, 'wallpapers', 'notes')), [], 'non-pictures are not copied');
  assert.match(logText(), /import: glassTint must be a number from 10 to 95; using the default/);
  assert.match(logText(), /first start: imported \d+ settings and 1 pictures/);
});

test('a fresh install starts with no headline of its own (DSH\'s hero text shows)', () => {
  assert.equal(host.PREF_DEFAULTS.headline, '');
});

test('GET state lists the collections; POST state saves a good change and logs it', async () => {
  let r = await call('GET', 'state');
  assert.deepEqual(r.json.wallpapers, { cars: ['a.jpg'], notes: [] });
  assert.equal(r.json.wallpaperDir, '~/.dsh/wallpaper/wallpapers');
  r = await call('POST', 'state', { prefs: { glassTint: 70, motion: false, wallpaperColour: { light: '#6FA8F7', dark: '#14315F' } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.prefs.glassTint, 70);
  assert.equal(saved().prefs.motion, false);
  assert.match(logText(), /settings: glassTint 55 -> 70, motion true -> false/);
});

test('POST state is all or nothing: a wrong kind or an unknown key refuses the whole change, in words', async () => {
  const before = JSON.stringify(saved().prefs);
  for (const [prefs, words] of [
    [{ glassTint: 'lots', glassBlur: 10 }, /glassTint must be a number from 10 to 95/],
    [{ motion: 'yes' }, /motion must be true or false/],
    [{ projectsSidebar: false }, /projectsSidebar is not a Wallpaper setting/],
    [{ wallpaperRotateMin: 7 }, /wallpaperRotateMin must be one of 1, 5, 15/],
    [{ wallpaperColour: { light: 'red' } }, /wallpaperColour must be/],
    [{ wallpaperColours: ['#zzzzzz'] }, /wallpaperColours must be/],
    [{ wallpaperPinned: '../state.json' }, /wallpaperPinned must be/],
    [{ wallpaperCollection: '../x' }, /wallpaperCollection must be/],
    [{ headline: 42 }, /headline must be text/],
  ]) {
    const r = await call('POST', 'state', { prefs });
    assert.equal(r.status, 400, JSON.stringify(prefs));
    assert.match(r.json.error, words);
    assert.ok(r.json.prefs, 'the answer carries what is saved, so the panel can go back to it');
  }
  assert.equal(JSON.stringify(saved().prefs), before, 'nothing saved');
  assert.equal((await call('POST', 'state', null)).status, 400, 'no body');
  assert.match(logText(), /settings not saved: glassTint must be a number/);
});

test('numbers are held to their ranges; the headline to one line of 120 characters', async () => {
  await call('POST', 'state', { prefs: { glassTint: 500, glassBlur: -3, wallpaperOpacity: 55.6, headline: `  ${'x'.repeat(200)}\n` } });
  const p = saved().prefs;
  assert.deepEqual([p.glassTint, p.glassBlur, p.wallpaperOpacity, p.headline.length], [95, 0, 56, 120]);
  await call('POST', 'state', { prefs: { glassTint: 55, glassBlur: 22, headline: '' } });
});

test('library: make and rename a collection, add a picture, refuse bad names and empty data', async () => {
  assert.equal((await call('POST', 'collection-create', { name: '../evil' })).status, 400);
  assert.equal((await call('POST', 'collection-create', { name: 'Space' })).json.name, 'Space');
  assert.match((await call('POST', 'collection-create', { name: 'Space' })).json.error, /already exists/);
  assert.equal((await call('POST', 'collection-rename', { from: 'Space', to: 'Stars' })).json.name, 'Stars');
  const png = 'data:image/png;base64,' + gradientPng(64, 36, [200, 40, 40], [100, 20, 20]).toString('base64');
  assert.equal((await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'nebula.png', data: png })).json.file, 'nebula.png');
  assert.equal((await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'nebula.png', data: png })).json.file, 'nebula 2.png', 'a second copy gets its own name');
  assert.match((await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'evil.sh', data: png })).json.error, /not a JPEG, PNG, WebP or HEIC picture/);
  assert.match((await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'x.png', data: 'data:image/png;base64,' })).json.error, /no picture data|empty/);
  assert.match((await call('POST', 'wallpaper-add', { collection: 'Nope', name: 'x.png', data: png })).json.error, /pick a collection first/);
});

test('pictures are served resized as JPEG, a.png and a.jpg each their own; nothing outside the library is served', async () => {
  const light = 'data:image/png;base64,' + gradientPng(96, 54, [250, 250, 250], [220, 220, 220]).toString('base64');
  const dark = 'data:image/png;base64,' + gradientPng(96, 54, [10, 10, 10], [30, 30, 30]).toString('base64');
  await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'twin.png', data: light });
  await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'twin.jpg', data: dark });
  const a = await call('GET', 'wallpaper?c=Stars&f=twin.png');
  const b = await call('GET', 'wallpaper?c=Stars&f=twin.jpg');
  assert.equal(a.status, 200);
  assert.equal(a.type, 'image/jpeg');
  assert.ok(!a.bytes.equals(b.bytes), 'two pictures with one stem are two cache entries');
  assert.ok(existsSync(join(dataDir, 'wp-cache', 'Stars--twin.png.jpg')));
  assert.equal((await call('GET', 'wallpaper?c=..&f=state.json')).status, 404);
  assert.equal((await call('GET', 'wallpaper?c=Stars&f=..%2F..%2Fstate.json')).status, 404);
});

test('Move to the Trash: into the user\'s Trash, the kept picture let go, the cached copy dropped', async () => {
  await call('POST', 'state', { prefs: { wallpaperCollection: 'Stars', wallpaperPinned: 'twin.png' } });
  const r = await call('POST', 'wallpaper-remove', { collection: 'Stars', file: 'twin.png' });
  assert.equal(r.json.trashed, 'twin.png');
  assert.ok(existsSync(join(home, '.Trash', 'twin.png')), 'in the Trash');
  assert.ok(!existsSync(join(dataDir, 'wallpapers', 'Stars', 'twin.png')), 'gone from the library');
  assert.ok(!existsSync(join(dataDir, 'wp-cache', 'Stars--twin.png.jpg')), 'cached copy dropped');
  assert.equal(saved().prefs.wallpaperPinned, null);
  assert.match((await call('POST', 'wallpaper-remove', { collection: 'Stars', file: 'twin.png' })).json.error, /no such picture/);
});

test('Move to the Trash works when the library is on another disk than the Trash (copy, then remove)', async () => {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).includes('.Trash')) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const r = await call('POST', 'wallpaper-remove', { collection: 'Stars', file: 'nebula.png' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(existsSync(join(home, '.Trash', 'nebula.png')));
    assert.ok(!existsSync(join(dataDir, 'wallpapers', 'Stars', 'nebula.png')));
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
});

test('a Trash that can\'t be written: the picture stays and the answer says why', async () => {
  rmSync(join(home, '.Trash'), { recursive: true, force: true });
  writeFileSync(join(home, '.Trash'), 'a file where the folder should be');
  try {
    const r = await call('POST', 'wallpaper-remove', { collection: 'Stars', file: 'nebula 2.png' });
    assert.equal(r.status, 500, 'a fault of the disk is the host\'s (500), not a refused value (400)');
    assert.match(r.json.error, /couldn't move it to the Trash/);
    assert.ok(existsSync(join(dataDir, 'wallpapers', 'Stars', 'nebula 2.png')), 'still in the library');
  } finally {
    rmSync(join(home, '.Trash'), { force: true });
    mkdirSync(join(home, '.Trash'));
  }
});

test('a file that only has a picture\'s name is refused by its bytes, in words; real pictures of each kind go in', async () => {
  const text = 'data:image/jpeg;base64,' + Buffer.from('this is a text file, not a picture at all.\n').toString('base64');
  const r = await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'notes.jpg', data: text });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /notes\.jpg isn't a JPEG, PNG, WebP or HEIC picture \(only its name is\)/);
  assert.ok(!existsSync(join(dataDir, 'wallpapers', 'Stars', 'notes.jpg')), 'nothing written');
  const { pictureKind } = host;
  const head = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);
  assert.equal(pictureKind(head([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(pictureKind(gradientPng(4, 4, [0, 0, 0], [9, 9, 9])), 'png');
  assert.equal(pictureKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp');
  for (const brand of ['heic', 'heix', 'mif1']) assert.equal(pictureKind(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + brand), Buffer.alloc(8)])), 'heic', brand);
  assert.equal(pictureKind(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8)])), null, 'a video is not a picture');
  assert.equal(pictureKind(Buffer.from('GIF89a......')), null);
  // A HEIC that the browser hands over without a picture type still goes in by its bytes.
  const heic = 'data:application/octet-stream;base64,' + Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(64)]).toString('base64');
  assert.equal((await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'phone.heic', data: heic })).json.file, 'phone.heic');
  rmSync(join(dataDir, 'wallpapers', 'Stars', 'phone.heic'));
});

test('a file in a collection that sips can\'t read is served as it is and logged once, until it changes', async () => {
  const bad = join(dataDir, 'wallpapers', 'Stars', 'scan.jpg');
  writeFileSync(bad, 'this is a text file, not a picture at all.\n');
  const lines = () => logText().split('\n').filter((l) => l.includes('resize Stars/scan.jpg failed')).length;
  for (let i = 0; i < 3; i++) {
    const r = await call('GET', 'wallpaper?c=Stars&f=scan.jpg');
    assert.equal(r.status, 200);
    assert.equal(r.type, 'image/jpeg');
    assert.equal(r.bytes.toString(), 'this is a text file, not a picture at all.\n', 'the file as it is');
  }
  assert.equal(lines(), 1, 'one line in the log for three requests');
  const v1 = (await call('GET', 'state')).json.versions['Stars/scan.jpg'];
  assert.ok(!logText().split('\n').some((l) => l.includes('resize Stars/scan.jpg') && l.includes('Error 13')), 'one line of words, without sips\'s own output');
  const t = new Date(Date.now() + 5000);
  utimesSync(bad, t, t);
  await call('GET', 'wallpaper?c=Stars&f=scan.jpg');
  assert.equal(lines(), 2, 'tried again once the file changed');
  const v2 = (await call('GET', 'state')).json.versions['Stars/scan.jpg'];
  assert.ok(v1 > 0 && v2 > v1, 'the listing carries each picture\'s modified time, so the window asks again once it changes');
  rmSync(bad);
});

test('a settings file that can\'t be written answers 500 in words and keeps nothing; a refused value stays 400', async () => {
  const before = saved().prefs.glassTint;
  chmodSync(dataDir, 0o555);
  let r;
  try {
    r = await call('POST', 'state', { prefs: { glassTint: before === 61 ? 62 : 61 } });
  } finally {
    chmodSync(dataDir, 0o755);
  }
  assert.equal(r.status, 500);
  assert.match(r.json.error, /couldn't write the settings file \(no permission\)/);
  assert.equal(r.json.prefs.glassTint, before, 'the answer has what is saved');
  assert.ok(!('fault' in r.json), 'the answer carries no inner flags');
  assert.equal((await call('POST', 'state', { prefs: { glassTint: 'lots' } })).status, 400);
});

test('collections: names in any script, a change of case only, and folders left out are named with the reason', async () => {
  for (const n of ['Café', 'Märchen', '写真', 'Ñandú 2']) assert.equal((await call('POST', 'collection-create', { name: n })).json.name, n, n);
  for (const n of ['.hidden', 'a/b', 'x:y', '-dash', 'a..b', 'é'.repeat(81)]) {
    const r = await call('POST', 'collection-create', { name: n });
    assert.equal(r.status, 400, n);
    assert.match(r.json.error, /start with a letter or a number/);
  }
  const png = 'data:image/png;base64,' + gradientPng(32, 18, [20, 120, 200], [10, 60, 100]).toString('base64');
  assert.equal((await call('POST', 'wallpaper-add', { collection: 'Café', name: 'été à Paris.png', data: png })).json.file, 'été à Paris.png', 'letters outside ASCII are kept in a picture\'s name');
  assert.equal((await call('POST', 'collection-create', { name: 'Judge' })).json.name, 'Judge');
  await call('POST', 'state', { prefs: { wallpaperCollection: 'Judge' } });
  const r = await call('POST', 'collection-rename', { from: 'Judge', to: 'judge' });
  assert.equal(r.status, 200, JSON.stringify(r.json.error));
  assert.ok(readdirSync(join(dataDir, 'wallpapers')).includes('judge') && !readdirSync(join(dataDir, 'wallpapers')).includes('Judge'), 'the folder has the new case');
  assert.equal(saved().prefs.wallpaperCollection, 'judge', 'the setting follows');
  assert.match((await call('POST', 'collection-rename', { from: 'judge', to: 'Café' })).json.error, /Café already exists/, 'another folder is still refused');
  mkdirSync(join(dataDir, 'wallpapers', '#old'));
  writeFileSync(join(dataDir, 'wallpapers', 'loose.jpg'), 'x');
  writeFileSync(join(dataDir, 'wallpapers', '.DS_Store'), 'x');
  const g = await call('GET', 'state');
  assert.ok(g.json.wallpapers['写真'] && g.json.wallpapers['Café'].includes('été à Paris.png'), 'shown in the panel');
  assert.equal(g.json.skipped.length, 2, JSON.stringify(g.json.skipped));
  assert.match(g.json.skipped.join('\n'), /#old \(a collection's name must start with a letter or a number/);
  assert.match(g.json.skipped.join('\n'), /loose\.jpg \(pictures go inside a collection's folder\)/);
  rmSync(join(dataDir, 'wallpapers', '#old'), { recursive: true });
  rmSync(join(dataDir, 'wallpapers', 'loose.jpg'));
  await call('POST', 'state', { prefs: { wallpaperCollection: 'Stars' } });
});

test('a second start does not import again', async () => {
  writeFileSync(join(fleet, 'wallpapers', 'cars', 'b.jpg'), 'more bytes');
  await start({});
  assert.ok(!existsSync(join(dataDir, 'wallpapers', 'cars', 'b.jpg')), 'import runs once');
});

test('an unreadable state.json is kept aside and logged; the defaults are used and nothing is imported again', async () => {
  writeFileSync(join(dataDir, 'state.json'), '{ this is not json');
  const { call: c2 } = await start({});
  const kept = readdirSync(dataDir).filter((f) => f.startsWith('state.json.unreadable-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dataDir, kept[0]), 'utf8'), '{ this is not json');
  assert.match(logText(), /state.json couldn't be read .* kept it as state.json.unreadable-/);
  assert.equal((await c2('GET', 'state')).json.prefs.glassTint, 55);
  assert.ok(!existsSync(join(dataDir, 'wallpapers', 'cars', 'b.jpg')), 'no second import');
  assert.equal((await c2('POST', 'state', { prefs: { glassTint: 60 } })).status, 200, 'saving works again');
});

test('config: values of the wrong kind fall back to their defaults with a line in the log; it never throws', async () => {
  const { checkConfig } = host;
  assert.deepEqual(checkConfig(undefined).problems, []);
  let r = checkConfig({ dataDir: 42, wallpaperDir: 'relative/path', importFrom: false, colour: 'blue' });
  assert.equal(r.config.dataDir, join(home, '.dsh', 'wallpaper'));
  assert.equal(r.config.wallpaperDir, null);
  assert.equal(r.config.importFrom, null, 'false switches the import off');
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.join('\n'), /dataDir must be a folder path/);
  assert.match(r.problems.join('\n'), /unknown key colour ignored/);
  r = checkConfig('nonsense');
  assert.match(r.problems[0], /must be a set of keys/);
  await assert.doesNotReject(start({ dataDir: 42, wallpaperDir: [], importFrom: {} }));
  assert.match(logText(), /config: dataDir must be a folder path/);
  const { call: c4 } = await start({ colour: 'blue' });
  const g = await c4('GET', 'state');
  assert.equal(g.json.configProblems.length, 1, 'the panel is told of each problem');
  assert.match(g.json.configProblems[0], /unknown key colour ignored/);
});

test('a dataDir that can\'t be made falls back to the default, and says so', async () => {
  writeFileSync(join(home, 'not-a-folder'), 'x');
  await start({ dataDir: join(home, 'not-a-folder', 'wallpaper') });
  assert.match(logText(), /config: dataDir .*not-a-folder.* can't be used .*; using /);
});

test('when no folder can be written, the routes answer in words and the panel is told', async () => {
  const other = join(home, 'broken-home');
  mkdirSync(other);
  writeFileSync(join(other, 'wallpaper'), 'a file where the folder should be');
  process.env.DSH_HOME = other;
  try {
    const { call: c3 } = await start({}, './impl.js?broken');
    const g = await c3('GET', 'state');
    assert.equal(g.status, 200);
    assert.match(g.json.problem, /can't write its folder/);
    const p = await c3('POST', 'state', { prefs: { glassTint: 60 } });
    assert.equal(p.status, 500);
    assert.match(p.json.error, /can't write its folder/);
  } finally {
    process.env.DSH_HOME = join(home, '.dsh');
  }
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}\n    ${String(error.stack).split('\n').slice(0, 5).join('\n    ')}`);
  }
}
rmSync(home, { recursive: true, force: true });
console.log(`\n# wallpaper host: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
