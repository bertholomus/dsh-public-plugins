// Offline test of the Wallpaper host: first-start import from Fleet Shell, the settings it keeps, and the library
// routes. Runs in a temporary home, so nothing real is read or written: node plugins/wallpaper/lib/impl.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'wallpaper-test-'));
process.env.HOME = home;
process.env.DSH_HOME = join(home, '.dsh');
const fleet = join(home, '.dsh', 'fleet-shell');
mkdirSync(join(fleet, 'wallpapers', 'cars'), { recursive: true });
mkdirSync(join(fleet, 'wallpapers', 'notes'), { recursive: true });
writeFileSync(join(fleet, 'wallpapers', 'cars', 'a.jpg'), 'jpeg bytes');
writeFileSync(join(fleet, 'wallpapers', 'notes', 'readme.txt'), 'not a picture');
writeFileSync(join(fleet, 'state.json'), JSON.stringify({
  prefs: { headline: 'Ship it', wallpaperRotate: 'daily', glassBlur: 30, projectsSidebar: true, hideNativeSettings: true, guardAutoRepair: true },
  projects: [{ id: 'p1', name: 'Security' }], projectOf: { w1: 'p1' }, favorites: ['m1'],
}));

const routes = {};
const ctx = {
  inject: (_deps, fn) => fn({ connection: { fetch: { register: (def) => { routes[def.path] = def; return () => {}; } } }, effect: (f) => f() }),
  effect: (f) => f(),
};
const { apply } = await import('./impl.js');
await apply(ctx, {});
const call = async (method, path, body) => {
  const r = routes[`/api/wallpaper/${path}`];
  assert.ok(r, `route ${path} registered`);
  const url = `http://x/api/wallpaper/${path}`;
  const res = await r.fetch(new Request(url, method === 'GET' ? {} : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  return { status: res.status, json: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
};

// First start: Fleet Shell's look settings and pictures come over; nothing else does; the originals stay.
const dataDir = join(home, '.dsh', 'wallpaper');
const saved = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
assert.equal(saved.prefs.headline, 'Ship it');
assert.equal(saved.prefs.glassBlur, 30);
assert.equal(saved.prefs.wallpaperRotateMin, 1440, 'old "daily" rotation becomes 1440 minutes');
assert.equal(saved.prefs.wallpaperRotate, null);
for (const k of ['projectsSidebar', 'hideNativeSettings', 'guardAutoRepair']) assert.ok(!(k in saved.prefs), `${k} is not a Wallpaper setting`);
assert.ok(!('projects' in saved) && !('favorites' in saved), 'no Projects or Fleet data');
assert.equal(saved.imported.images, 1);
assert.ok(existsSync(join(dataDir, 'wallpapers', 'cars', 'a.jpg')), 'picture copied');
assert.ok(existsSync(join(fleet, 'wallpapers', 'cars', 'a.jpg')), 'original kept');
assert.deepEqual(readdirSync(join(dataDir, 'wallpapers', 'notes')), [], 'non-pictures are not copied');

// GET state lists collections; POST state keeps only Wallpaper settings.
let r = await call('GET', 'state');
assert.deepEqual(r.json.wallpapers, { cars: ['a.jpg'], notes: [] });
r = await call('POST', 'state', { prefs: { glassTint: 70, projectsSidebar: false }, projects: [] });
assert.equal(r.json.prefs.glassTint, 70);
assert.ok(!('projectsSidebar' in r.json.prefs));
assert.ok(!('projects' in JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))));

// Library: make and rename a collection, add a picture, move it to the Trash.
assert.equal((await call('POST', 'collection-create', { name: '../evil' })).status, 400);
assert.equal((await call('POST', 'collection-create', { name: 'Space' })).json.name, 'Space');
assert.equal((await call('POST', 'collection-rename', { from: 'Space', to: 'Stars' })).json.name, 'Stars');
const png = 'data:image/png;base64,' + Buffer.from('png bytes').toString('base64');
assert.equal((await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'nebula.png', data: png })).json.file, 'nebula.png');
assert.equal((await call('POST', 'wallpaper-add', { collection: 'Stars', name: 'evil.sh', data: png })).status, 400);
assert.equal((await call('POST', 'wallpaper-remove', { collection: 'Stars', file: 'nebula.png' })).json.trashed, 'nebula.png');
assert.ok(existsSync(join(home, '.Trash', 'nebula.png')), 'removed picture is in the Trash');

// A second start does not import again.
writeFileSync(join(fleet, 'wallpapers', 'cars', 'b.jpg'), 'more bytes');
await apply(ctx, {});
assert.ok(!existsSync(join(dataDir, 'wallpapers', 'cars', 'b.jpg')), 'import runs once');
console.log('wallpaper host: all checks passed');
