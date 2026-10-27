// Wallpaper and glass — host side.
// Keeps the look's settings and the wallpaper library, and serves both to the client bundle on /api/wallpaper/*.
// Everything lives in this plugin's own folder (<DSH home>/wallpaper). The one exception is a one-time import when
// the plugin first starts: Fleet Shell's wallpaper settings and picture library are copied in (APFS clones, so no
// extra disk until a file changes). The originals are left as they were.
//
// Nothing here throws while DSH loads the plugin: a bad config value is logged and its default used, a settings
// file that can't be read is kept aside and logged, and a folder that can't be written turns into a plain error on
// every route.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, appendFileSync, copyFileSync, unlinkSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename, isAbsolute } from 'node:path';

export const name = 'wallpaper';
export const inject = [];

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DEFAULTS = {
  dataDir: join(DSH_HOME, 'wallpaper'), // state.json, wp-cache/, wallpaper.log
  wallpaperDir: null, // one folder per collection; null = <dataDir>/wallpapers. Nothing else is ever shown as wallpaper.
  importFrom: join(DSH_HOME, 'fleet-shell'), // read once, on first start: its state.json prefs and wallpapers/ folder
};
export const PREF_DEFAULTS = {
  headline: '',
  wallpaperCollection: 'cars', wallpaperPinned: null, wallpaperRotate: null, wallpaperRotateMin: 60,
  wallpaperOpacity: 90, wallpaperFrost: 4, glassBlur: 22, glassTint: 55, motion: true,
};
// The sliders' ranges (the panel has the same ones), the rotation stops in minutes, and the headline's length.
export const RANGES = { wallpaperOpacity: [0, 100], wallpaperFrost: [0, 24], glassBlur: [0, 40], glassTint: [10, 95] };
export const ROTATE_STOPS = [1, 5, 15, 30, 60, 120, 240, 480, 720, 1440];
export const HEADLINE_MAX = 120;
const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' };
const HEX = /^#[0-9a-f]{6}$/i;
// A collection is a folder: it starts with a letter or a digit (any script), then letters, digits, spaces and a few
// marks, up to 80. No slash, colon or control character, no leading dot, no "..".
const SAFE_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_ .,'()+&-]{0,79}$/u;
const NAME_RULE = "start with a letter or a number, then use letters, numbers, spaces and - _ . , ' ( ) + & (up to 80)";
const safeName = (n) => typeof n === 'string' && SAFE_NAME.test(n) && !n.includes('..') && n.trim() === n;
// What a file's first bytes say it is, so a file that only has a picture's name is refused.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
export function pictureKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(buf.toString('latin1', 8, 12))) return 'heic';
  return null;
}
const safeFile = (f) => typeof f === 'string' && f.length <= 160 && basename(f) === f && !f.startsWith('.') && IMG.has(extname(f).toLowerCase());

/**
 * Check one settings change: `{ value }` to keep, or `{ error }` in words. Keys this plugin doesn't keep are
 * `{ skip: true }` (Fleet Shell's other settings, for example), so they are never stored.
 */
export function checkPref(key, v) {
  if (key in RANGES) {
    const [lo, hi] = RANGES[key];
    return typeof v === 'number' && Number.isFinite(v) ? { value: Math.min(hi, Math.max(lo, Math.round(v))) } : { error: `${key} must be a number from ${lo} to ${hi}` };
  }
  switch (key) {
    case 'headline':
      return typeof v === 'string' ? { value: v.replace(/\s+/g, ' ').trim().slice(0, HEADLINE_MAX) } : { error: 'headline must be text' };
    case 'motion': case 'wallpaperGradient':
      return typeof v === 'boolean' ? { value: v } : { error: `${key} must be true or false` };
    case 'wallpaperCollection':
      return safeName(v) ? { value: v } : { error: 'wallpaperCollection must be a collection name' };
    case 'wallpaperPinned':
      return v === null || safeFile(v) ? { value: v } : { error: 'wallpaperPinned must be a picture\'s file name, or null' };
    case 'wallpaperRotate':
      return v === null || v === 'off' ? { value: v } : { error: 'wallpaperRotate must be "off" or null' };
    case 'wallpaperRotateMin':
      return ROTATE_STOPS.includes(v) ? { value: v } : { error: `wallpaperRotateMin must be one of ${ROTATE_STOPS.join(', ')}` };
    case 'wallpaperKind':
      return v === 'image' || v === 'colour' ? { value: v } : { error: 'wallpaperKind must be "image" or "colour"' };
    case 'wallpaperColour':
      return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => (k === 'light' || k === 'dark') && HEX.test(v[k]))
        ? { value: { ...(v.light ? { light: v.light } : {}), ...(v.dark ? { dark: v.dark } : {}) } } : { error: 'wallpaperColour must be { light, dark } colours like #4f6fb3' };
    case 'wallpaperColours':
      return Array.isArray(v) && v.length <= 32 && v.every((x) => HEX.test(x)) ? { value: [...new Set(v.map((x) => x.toLowerCase()))].slice(-16) } : { error: 'wallpaperColours must be a list of colours like #4f6fb3' };
    default:
      return { skip: true };
  }
}

/** Settings from a file or an import: the good ones kept, the rest named. */
export function cleanPrefs(raw) {
  const prefs = {}; const dropped = [];
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const r = checkPref(k, v);
    if (r.skip) continue;
    if (r.error) dropped.push(r.error); else prefs[k] = r.value;
  }
  return { prefs, dropped };
}

/** The config row's values, each checked: `{ config, problems }`; a value of the wrong kind falls back to its default. */
export function checkConfig(raw) {
  const problems = [];
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw != null && given !== raw) problems.push('the config must be a set of keys; using the defaults');
  const config = { ...DEFAULTS };
  for (const [k, v] of Object.entries(given)) {
    if (!(k in DEFAULTS)) { problems.push(`unknown key ${k} ignored (keys: ${Object.keys(DEFAULTS).join(', ')})`); continue; }
    const optional = k !== 'dataDir';
    if (v === null && optional) config[k] = null;
    else if (v === false && k === 'importFrom') config[k] = null;
    else if (typeof v === 'string' && v.trim() && (isAbsolute(v) || v.startsWith('~/'))) config[k] = v;
    else problems.push(`${k} must be a folder path (absolute or ~/…)${optional ? ' or null' : ''}; using ${config[k] ?? 'null'}`);
  }
  return { config, problems };
}

const expand = (p) => (typeof p === 'string' && p.startsWith('~/') ? homedir() + p.slice(1) : p);
const now = () => new Date().toISOString();
// A file-system error in words, without the private path Node puts in its message.
const WORDS = { ENOENT: 'not found', EACCES: 'no permission', EPERM: 'no permission', EEXIST: 'a file is in the way', ENOTDIR: 'a file is in the way', ENOSPC: 'the disk is full', EROFS: 'the disk is read-only' };
const say = (e) => WORDS[e?.code] ?? String(e?.message ?? e).replace(/^E[A-Z]+: /, '').replace(/,? (open|mkdir|rename|copyfile|unlink|scandir|stat|lstat) '[^']*'( -> '[^']*')?/g, '');

export async function apply(ctx, rawConfig) {
  const { config, problems } = checkConfig(rawConfig);
  let dataDir = expand(config.dataDir);
  let broken = null; // why the plugin can't keep anything, in words
  const tryDir = (dir) => { try { mkdirSync(join(dir, 'wp-cache'), { recursive: true }); return null; } catch (e) { return say(e); } };
  const firstTry = tryDir(dataDir);
  if (firstTry && dataDir !== DEFAULTS.dataDir) {
    problems.push(`dataDir ${dataDir} can't be used (${firstTry}); using ${DEFAULTS.dataDir}`);
    dataDir = DEFAULTS.dataDir;
    broken = tryDir(dataDir);
  } else broken = firstTry;
  const wpDir = expand(config.wallpaperDir || join(dataDir, 'wallpapers'));
  const logFile = join(dataDir, 'wallpaper.log');
  const log = (msg) => { try { appendFileSync(logFile, `${now()} ${msg}\n`); } catch {} };
  for (const p of problems) log(`config: ${p}`);
  if (broken) log(`can't write ${dataDir}: ${broken}; settings and pictures can't be kept`);
  const writeJson = (p, v) => { const tmp = p + '.tmp'; writeFileSync(tmp, JSON.stringify(v, null, 1)); renameSync(tmp, p); };

  // ---------------------------------------------------------------- settings
  const statePath = join(dataDir, 'state.json');
  const firstStart = !broken && !existsSync(statePath);
  let saved = {};
  if (!broken && !firstStart) {
    try {
      saved = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not a settings object');
    } catch (e) {
      const aside = `${statePath}.unreadable-${Date.now()}`;
      try { copyFileSync(statePath, aside); } catch {}
      log(`state.json couldn't be read (${say(e)}); kept it as ${basename(aside)} and started from the defaults`);
      saved = {};
    }
  }
  const loaded = cleanPrefs(saved.prefs);
  for (const d of loaded.dropped) log(`state.json: ${d}; using the default`);
  const state = { ...saved, prefs: { ...PREF_DEFAULTS, ...loaded.prefs } };
  const saveState = () => writeJson(statePath, state);

  // ---------------------------------------------------------------- one-time import from Fleet Shell
  const importDir = config.importFrom ? expand(config.importFrom) : null;
  if (firstStart && importDir && existsSync(importDir)) {
    let old = null;
    try { old = JSON.parse(readFileSync(join(importDir, 'state.json'), 'utf8')); } catch (e) { if (existsSync(join(importDir, 'state.json'))) log(`import: Fleet Shell's state.json couldn't be read (${say(e)})`); }
    const raw = { ...(old?.prefs && typeof old.prefs === 'object' ? old.prefs : {}) };
    // Fleet Shell's old rotate modes: "hourly" -> 60 min, "daily" -> 1440 min; "off" stays.
    if (typeof raw.wallpaperRotate === 'string' && raw.wallpaperRotate !== 'off') {
      raw.wallpaperRotateMin = raw.wallpaperRotate === 'daily' ? 1440 : 60;
      raw.wallpaperRotate = null;
    }
    const { prefs, dropped } = cleanPrefs(raw);
    for (const d of dropped) log(`import: ${d}; using the default`);
    state.prefs = { ...state.prefs, ...prefs };
    let images = 0; let failed = 0;
    const from = join(importDir, 'wallpapers');
    try {
      if (existsSync(from) && !(existsSync(wpDir) && readdirSync(wpDir).some((c) => !c.startsWith('.')))) {
        for (const c of readdirSync(from)) {
          const dir = join(from, c);
          try { if (!safeName(c) || !statSync(dir).isDirectory()) continue; } catch { continue; }
          mkdirSync(join(wpDir, c), { recursive: true });
          for (const f of readdirSync(dir)) {
            if (!safeFile(f) || existsSync(join(wpDir, c, f))) continue;
            try { copyFileSync(join(dir, f), join(wpDir, c, f), constants.COPYFILE_FICLONE); images++; } catch (e) { failed++; log(`import ${c}/${f} failed: ${say(e)}`); }
          }
        }
      }
    } catch (e) { log(`import: the pictures couldn't be read (${say(e)})`); }
    state.imported = { from: importDir, at: now(), prefs: Object.keys(prefs).length, images, failed };
    log(`first start: imported ${Object.keys(prefs).length} settings and ${images} pictures from ${importDir}${failed ? ` (${failed} failed)` : ''}; the originals stay`);
  }
  if (!broken) {
    try { mkdirSync(wpDir, { recursive: true }); } catch (e) { log(`can't make the picture folder ${wpDir}: ${say(e)}`); }
    if (firstStart) { try { saveState(); } catch (e) { log(`can't save settings: ${say(e)}`); } }
  }

  // ---------------------------------------------------------------- wallpaper library
  // Collections are the folders in wpDir. Nothing else counts, so screenshots and other image folders are never
  // wallpaper. Removing a picture moves it to the macOS Trash.
  // The collections, what was left out and why, and each picture's modified time (the window's addresses carry it).
  const library = () => {
    const out = {}; const skipped = []; const versions = {};
    try {
      for (const c of readdirSync(wpDir)) {
        if (c.startsWith('.') || c === 'Icon\r') continue;
        const dir = join(wpDir, c);
        let folder = false;
        try { folder = statSync(dir).isDirectory(); } catch { continue; }
        if (!folder) { if (safeFile(c)) skipped.push(`${c} (pictures go inside a collection's folder)`); continue; }
        if (!safeName(c)) { skipped.push(`${c.slice(0, 80)} (a collection's name must ${NAME_RULE})`); continue; }
        try { out[c] = readdirSync(dir).filter(safeFile).sort(); } catch (e) { out[c] = []; skipped.push(`the pictures in ${c} (${say(e)})`); }
        for (const f of out[c]) { try { versions[`${c}/${f}`] = Math.round(statSync(join(dir, f)).mtimeMs); } catch {} }
      }
    } catch {}
    return { wallpapers: out, skipped, versions };
  };
  const wallpapers = () => library().wallpapers;
  const cacheOf = (collection, file) => join(dataDir, 'wp-cache', `${collection}--${file}.jpg`);
  // Pictures are served at 2880 px on the long edge as JPEG, made once with sips and cached in wp-cache/. One sips
  // can't read is served as it is, and remembered (with its modified time), so it is tried and logged once.
  const unreadable = new Map(); // "collection/file" -> mtimeMs
  const wallpaperFile = (collection, file) => new Promise((resolve) => {
    if (!safeName(collection) || !safeFile(file) || !wallpapers()[collection]?.includes(file)) return resolve(null);
    const src = join(wpDir, collection, file);
    const out = cacheOf(collection, file);
    const original = { path: src, type: TYPES[extname(file).toLowerCase()] };
    let mtime = 0;
    try { mtime = statSync(src).mtimeMs; if (existsSync(out) && statSync(out).mtimeMs >= mtime) return resolve({ path: out, type: 'image/jpeg' }); } catch {}
    const id = `${collection}/${file}`;
    if (unreadable.get(id) === mtime) return resolve(original);
    execFile('/usr/bin/sips', ['-Z', '2880', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', out], { timeout: 30000 }, (err) => {
      if (!err) { unreadable.delete(id); return resolve({ path: out, type: 'image/jpeg' }); }
      unreadable.set(id, mtime);
      log(`resize ${id} failed (sips couldn't read it as a picture${err.killed ? ' in 30 s' : ''}); serving the file as it is, and not trying again until it changes`);
      resolve(original);
    });
  });
  const uniqueIn = (dir, n0) => {
    const ext = extname(n0); const stem = n0.slice(0, n0.length - ext.length);
    let n = n0; let i = 2;
    while (existsSync(join(dir, n))) n = `${stem} ${i++}${ext}`;
    return n;
  };
  const wallpaperAdd = ({ collection, name: given, data }) => {
    if (!safeName(collection) || !existsSync(join(wpDir, collection))) return { error: 'pick a collection first' };
    const shown = String(given ?? 'that file').slice(0, 80);
    const base = basename(String(given ?? '')).normalize('NFC').replace(/[^\p{L}\p{N}\p{M}_ .,'()+&-]/gu, '-').replace(/^[^\p{L}\p{N}_]+/u, '').slice(0, 120);
    if (!IMG.has(extname(base).toLowerCase()) || !safeName(base.replace(/\.[^.]+$/, ''))) return { error: `${shown} is not a JPEG, PNG, WebP or HEIC picture` };
    const m = String(data ?? '').match(/^data:[\w.+/-]*;base64,(.+)$/);
    if (!m) return { error: 'no picture data' };
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length === 0) return { error: `${shown} is empty` };
    if (buf.length > 60 * 1024 * 1024) return { error: `${shown} is larger than 60 MB` };
    if (!pictureKind(buf)) { log(`wallpaper not added: ${shown} isn't a picture by its bytes`); return { error: `${shown} isn't a JPEG, PNG, WebP or HEIC picture (only its name is)` }; }
    const file = uniqueIn(join(wpDir, collection), base);
    try { writeFileSync(join(wpDir, collection, file), buf); } catch (e) { log(`wallpaper not added: ${collection}/${file}: ${say(e)}`); return { error: `couldn't save it in ${collection} (${say(e)})`, fault: true }; }
    log(`wallpaper added: ${collection}/${file} (${Math.round(buf.length / 1024)} KB)`);
    return { ok: true, collection, file };
  };
  const wallpaperRemove = ({ collection, file }) => {
    if (!safeName(collection) || !safeFile(file) || !wallpapers()[collection]?.includes(file)) return { error: 'no such picture' };
    const trash = join(homedir(), '.Trash');
    const src = join(wpDir, collection, file);
    let dest;
    try {
      mkdirSync(trash, { recursive: true });
      dest = uniqueIn(trash, file);
      try { renameSync(src, join(trash, dest)); } catch (e) {
        if (e?.code !== 'EXDEV') throw e;
        // The library is on another disk than the Trash: copy, then remove the original.
        copyFileSync(src, join(trash, dest));
        unlinkSync(src);
      }
    } catch (e) {
      log(`wallpaper not moved to the Trash: ${collection}/${file}: ${say(e)}`);
      return { error: `couldn't move it to the Trash (${say(e)})`, fault: true };
    }
    try { unlinkSync(cacheOf(collection, file)); } catch {}
    if (state.prefs.wallpaperPinned === file) { state.prefs.wallpaperPinned = null; try { saveState(); } catch {} }
    log(`wallpaper moved to the Trash: ${collection}/${file} -> ~/.Trash/${dest}`);
    return { ok: true, trashed: dest };
  };
  const collectionCreate = ({ name: given }) => {
    const n = String(given ?? '').normalize('NFC').trim();
    if (!safeName(n)) return { error: NAME_RULE };
    if (existsSync(join(wpDir, n))) return { error: `${n} already exists` };
    try { mkdirSync(join(wpDir, n)); } catch (e) { log(`wallpaper collection not made: ${n}: ${say(e)}`); return { error: `couldn't make the folder (${say(e)})`, fault: true }; }
    log(`wallpaper collection created: ${n}`);
    return { ok: true, name: n };
  };
  // The same folder under another name (a disk that ignores case says "judge" exists when "Judge" does).
  const sameFolder = (a, b) => { try { const x = statSync(a); const y = statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch { return false; } };
  const collectionRename = ({ from, to }) => {
    const t = String(to ?? '').normalize('NFC').trim();
    if (!safeName(from) || !existsSync(join(wpDir, from))) return { error: 'no such collection' };
    if (!safeName(t)) return { error: NAME_RULE };
    if (t === from) return { ok: true, name: t };
    const caseOnly = existsSync(join(wpDir, t)) && sameFolder(join(wpDir, from), join(wpDir, t));
    if (existsSync(join(wpDir, t)) && !caseOnly) return { error: `${t} already exists` };
    try {
      if (caseOnly) {
        // Through a name of its own first, so the disk takes the new case.
        const tmp = join(wpDir, `.rename-${process.pid}-${Date.now()}`);
        renameSync(join(wpDir, from), tmp);
        renameSync(tmp, join(wpDir, t));
      } else renameSync(join(wpDir, from), join(wpDir, t));
    } catch (e) { log(`wallpaper collection not renamed: ${from} -> ${t}: ${say(e)}`); return { error: `couldn't rename the folder (${say(e)})`, fault: true }; }
    try { for (const f of readdirSync(join(dataDir, 'wp-cache'))) if (f.startsWith(`${from}--`)) unlinkSync(join(dataDir, 'wp-cache', f)); } catch {}
    if (state.prefs.wallpaperCollection === from) { state.prefs.wallpaperCollection = t; saveState(); }
    log(`wallpaper collection renamed: ${from} -> ${t}`);
    return { ok: true, name: t };
  };
  // A settings change is all or nothing: one value that doesn't fit and nothing is saved; the answer says which.
  const changePrefs = (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'no settings sent' };
    const next = {}; const errors = [];
    for (const [k, v] of Object.entries(patch)) {
      const r = checkPref(k, v);
      if (r.skip) errors.push(`${k} is not a Wallpaper setting`);
      else if (r.error) errors.push(r.error);
      else next[k] = r.value;
    }
    if (errors.length) { log(`settings not saved: ${errors.join('; ')}`); return { error: errors.join('; ') }; }
    const changed = Object.keys(next).filter((k) => JSON.stringify(state.prefs[k]) !== JSON.stringify(next[k]));
    if (!changed.length) return { ok: true };
    const before = { ...state.prefs };
    state.prefs = { ...state.prefs, ...next };
    try { saveState(); } catch (e) { state.prefs = before; log(`settings not saved: ${say(e)}`); return { error: `couldn't write the settings file (${say(e)})`, fault: true }; }
    log(`settings: ${changed.map((k) => `${k} ${k === 'headline' ? '(text)' : JSON.stringify(before[k])} -> ${k === 'headline' ? `(${next[k].length} characters)` : JSON.stringify(next[k])}`).join(', ')}`);
    return { ok: true };
  };

  // ---------------------------------------------------------------- routes
  const tilde = (p) => (p.startsWith(homedir() + '/') ? '~' + p.slice(homedir().length) : p);
  const json = (v, status = 200) => Response.json(v, { status, headers: { 'cache-control': 'no-store' } });
  const body = async (req) => { try { return await req.json(); } catch { return null; } };
  const configProblems = problems.map((p) => p.split(homedir() + '/').join('~/'));
  const view = () => {
    const lib = library();
    return { prefs: state.prefs, wallpapers: lib.wallpapers, versions: lib.versions, wallpaperDir: tilde(wpDir), ...(lib.skipped.length ? { skipped: lib.skipped } : {}), ...(configProblems.length ? { configProblems } : {}), ...(broken ? { problem: `Wallpaper can't write its folder (${broken}), so changes aren't kept` } : {}) };
  };
  // A value that doesn't fit is the sender's (400); a disk that won't take a change is the host's (500).
  const answer = ({ fault, ...r }) => json({ ...r, ...view() }, r.error ? (fault ? 500 : 400) : 200);
  const unwritable = () => json({ error: `Wallpaper can't write its folder (${broken}); see wallpaper.log`, ...view() }, 500);
  const routes = [
    ['GET', 'state', () => json(view())],
    ['POST', 'state', async (req) => {
      if (broken) return unwritable();
      const patch = await body(req);
      return answer(changePrefs(patch?.prefs));
    }],
    ['POST', 'wallpaper-add', async (req) => (broken ? unwritable() : answer(wallpaperAdd((await body(req)) ?? {})))],
    ['POST', 'wallpaper-remove', async (req) => (broken ? unwritable() : answer(wallpaperRemove((await body(req)) ?? {})))],
    ['POST', 'collection-create', async (req) => (broken ? unwritable() : answer(collectionCreate((await body(req)) ?? {})))],
    ['POST', 'collection-rename', async (req) => (broken ? unwritable() : answer(collectionRename((await body(req)) ?? {})))],
    ['GET', 'wallpaper', async (req) => {
      const u = new URL(req.url);
      const found = await wallpaperFile(u.searchParams.get('c') || '', u.searchParams.get('f') || '');
      if (!found) return new Response('not found', { status: 404 });
      return new Response(readFileSync(found.path), { headers: { 'content-type': found.type, 'cache-control': 'max-age=86400' } });
    }],
  ];
  // One exact route per path (the registry is keyed by path); dispatch on method.
  const byPath = new Map();
  for (const [method, path, handler] of routes) {
    const entry = byPath.get(path) ?? {};
    entry[method] = handler;
    byPath.set(path, entry);
  }
  ctx.inject(['connection'], (c) => {
    try {
      const connection = c.get?.('connection') ?? c.connection;
      if (typeof connection?.fetch?.register !== 'function') { log('connection.fetch.register missing'); return; }
      for (const [path, handlers] of byPath) {
        c.effect(() => connection.fetch.register({
          path: `/api/wallpaper/${path}`, methods: Object.keys(handlers), requestBody: 'buffered',
          fetch: async (req) => {
            const handler = handlers[req.method];
            if (!handler) return new Response('method not allowed', { status: 405 });
            try { return await handler(req); } catch (e) { log(`route ${path} failed: ${e?.stack ?? e}`); return json({ error: say(e) }, 500); }
          },
        }), `wallpaper: ${path}`);
      }
      log(`started; ${byPath.size} routes; library ${tilde(wpDir)}`);
    } catch (e) { log(`route registration failed: ${e?.stack ?? e}`); }
  });
}
