// Unit tests of Wallpaper's browser half, offline: the file runs the way DSH runs it (one script that hands DSH's
// module loader a factory given `require`), with a stand-in React, DSH parts and page. Its pure logic, its style
// sheet against DESIGN.md, its saving and its set-up and switch-off are checked. The look itself is tested in real
// DSH by test/e2e/run.mjs; the host half by lib/impl.test.mjs.
//
//   node plugins/wallpaper/test/unit.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const clientFile = join(dir, '..', 'lib', 'client.js');
const source = readFileSync(clientFile, 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Run client.js as one script with this `window` (in this realm, so the page stand-ins below are its globals). */
const run = (window) => new Function('window', source)(window);
const PARTS = { Modal() {}, Button: { $$typeof: Symbol.for('react.forward_ref'), render() {} }, Toast() {}, Switch() {}, SegmentedControl() {}, Checkbox() {} };

/** Load client.js as DSH does; `parts` stands in for @deepseek-ai/dsh-client-ui-primitives (null: a require that throws). */
function load(parts = PARTS) {
    let registered;
    const React = {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {},
        useRef: (v) => ({ current: v }),
        useSyncExternalStore: (_s, get) => get(),
        Fragment: 'Fragment',
    };
    run({ __ModuleLoader__: { load: (m) => { registered = m; } } });
    assert.equal(registered.id, 'dsh-plugin-wallpaper');
    const require = (name) => {
        if (name === 'react') return React;
        if (name === 'react-dom') return { createPortal: (el) => el };
        if (name === '@deepseek-ai/dsh-client-ui-primitives') {
            if (parts === null) throw new Error('no such module');
            return parts;
        }
        throw new Error(`unexpected require ${name}`);
    };
    return registered.factory(require);
}

/** A stand-in page: <head>, <body> with classes and style, elements, one MutationObserver count, and a fetch. */
function page({ fetch } = {}) {
    const head = [];
    const make = (tag) => {
        const classes = new Set();
        const props = {};
        const el = {
            tag, id: '', attrs: {}, layers: [],
            style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; }, getPropertyValue: (k) => props[k] ?? '', props },
            classList: {
                add: (...c) => c.forEach((x) => classes.add(x)),
                remove: (...c) => c.forEach((x) => classes.delete(x)),
                toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
                contains: (c) => classes.has(c),
                list: () => [...classes],
            },
            setAttribute(k, v) { this.attrs[k] = String(v); },
            hasAttribute(k) { return k in this.attrs; },
            remove() {
                if (head.includes(el)) head.splice(head.indexOf(el), 1);
                if (body.children.includes(el)) body.children.splice(body.children.indexOf(el), 1);
            },
            querySelectorAll(sel) { return sel === '.wp-wl' ? el.layers : []; },
        };
        Object.defineProperty(el, 'innerHTML', { set() { el.layers = [make('div'), make('div')]; } });
        return el;
    };
    const body = make('body');
    body.children = [];
    body.prepend = (el) => body.children.unshift(el);
    const state = { observers: 0, requests: [] };
    globalThis.document = {
        head: { appendChild: (el) => head.push(el) }, body, createElement: make, visibilityState: 'visible',
        querySelector: () => null,
        querySelectorAll: () => [...head, ...body.children].filter((el) => (el.tag === 'style' && el.attrs['data-plugin'] === 'dsh-plugin-wallpaper') || el.id === 'wp-wall'),
        addEventListener() {}, removeEventListener() {},
    };
    globalThis.MutationObserver = class { observe() { state.observers += 1; } disconnect() { state.observers -= 1; } };
    globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
    globalThis.fetch = async (url, init) => {
        state.requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        return fetch(url, init);
    };
    const restore = () => { for (const k of ['document', 'MutationObserver', 'requestAnimationFrame', 'fetch']) delete globalThis[k]; };
    return { head, body, state, restore };
}
const answer = (status, value) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) });
const ctxFor = () => {
    const effects = [];
    const slots = [];
    const ctx = {
        effect: (fn, label) => effects.push({ label, dispose: fn() }),
        slots: { inject: (_name, fn) => fn(), register: (opts, comp) => { slots.push({ opts, comp }); return () => {}; } },
        get: () => undefined,
    };
    return { ctx, effects, slots, dispose: () => effects.forEach((e) => e.dispose?.()) };
};

const plugin = load();
const { DEFAULT_PREFS, COLOUR_PRESETS, RETRIES, prefsOf, rotateMinOf, rotateLabel, swatchesOf, currentWallpaper, cssString, nameOf, savePrefs, stores, SELECTORS, CSS, veilFor, colourCells, contrastOf, mixRgb, TEXT, GLASS_RGB, VEIL_RGB, PanelBody } = plugin.logic;
/** The strings and elements of a tree made by the stand-in React (parts are not called, only listed). */
const walk = (node, out = { text: [], els: [] }) => {
    if (node == null || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out; }
    if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
    out.els.push(node);
    walk(node.children, out);
    return out;
};
const byText = (tree, text) => tree.els.find((e) => (e.children ?? []).flat(9).includes(text));

test('the file passes node --check (one plugin\'s syntax error would stop every plugin loading)', () => {
    execFileSync(process.execPath, ['--check', clientFile]);
});

test('loading needs no window parts and never throws without a module loader', () => {
    run({});
    run(undefined);
});

test('a fresh install has no headline of its own, so DSH\'s hero text shows', () => {
    assert.equal(DEFAULT_PREFS.headline, '');
    assert.equal(prefsOf({}).headline, '');
});

test('saved settings are held to what the look can use: ranges, one short line, true/false', () => {
    const p = prefsOf({ glassTint: 500, glassBlur: -4, wallpaperOpacity: 'lots', wallpaperFrost: 3.6, headline: `  Ship\n\n it ${'x'.repeat(200)}`, motion: 'no' });
    assert.equal(p.glassTint, 95);
    assert.equal(p.glassBlur, 0);
    assert.equal(p.wallpaperOpacity, 90, 'a word falls back to the default');
    assert.equal(p.wallpaperFrost, 4);
    assert.equal(p.headline.length, 120);
    assert.ok(p.headline.startsWith('Ship it x'));
    assert.equal(p.motion, true, 'only false turns motion off');
    assert.equal(prefsOf(null).glassTint, 55);
});

test('rotation: off, Fleet Shell\'s old words, and the stops', () => {
    assert.equal(rotateMinOf({ wallpaperRotate: 'off' }), 0);
    assert.equal(rotateMinOf({ wallpaperRotate: 'daily' }), 1440);
    assert.equal(rotateMinOf({ wallpaperRotate: 'hourly' }), 60);
    assert.equal(rotateMinOf({ wallpaperRotate: null, wallpaperRotateMin: 15 }), 15);
    assert.equal(rotateMinOf({ wallpaperRotate: null, wallpaperRotateMin: 7 }), 60, 'not a stop: hourly');
    assert.equal(rotateLabel(1440), '24 h');
    assert.equal(rotateLabel(5), '5 min');
});

test('what the wall shows: a colour in the colour mode\'s tone, rotating by the clock when rotation is on', () => {
    const blue = { light: '#6FA8F7', dark: '#14315F' };
    let w = currentWallpaper({ prefs: { wallpaperKind: 'colour', wallpaperRotate: 'off', wallpaperColour: blue } }, false);
    assert.equal(w.colour, '#6FA8F7');
    assert.match(w.css, /linear-gradient\(#6FA8F7, #6FA8F7\)/);
    w = currentWallpaper({ prefs: { wallpaperKind: 'colour', wallpaperRotate: 'off', wallpaperColour: blue } }, true);
    assert.equal(w.colour, '#14315F');
    w = currentWallpaper({ prefs: { wallpaperKind: 'colour', wallpaperRotate: 'off', wallpaperColour: { light: 'red' } } }, false);
    assert.equal(w.colour, COLOUR_PRESETS[0].light, 'a colour that is not #rrggbb falls back to Graphite');
    w = currentWallpaper({ prefs: { wallpaperKind: 'colour', wallpaperRotate: null, wallpaperRotateMin: 60 } }, false, 3 * 3600e3);
    assert.equal(w.colour, COLOUR_PRESETS[3].light, 'hour 3 shows the fourth colour');
    w = currentWallpaper({ prefs: { wallpaperKind: 'colour', wallpaperRotate: 'off', wallpaperColour: blue, wallpaperGradient: true } }, false);
    assert.match(w.css, /linear-gradient\(160deg/);
});

test('what the wall shows: a kept picture, else the collection by the clock, else the first collection with pictures', () => {
    const walls = { cars: ['a.jpg', 'b.jpg', 'c.jpg'], empty: [] };
    let w = currentWallpaper({ prefs: { wallpaperCollection: 'cars', wallpaperPinned: 'b.jpg' }, wallpapers: walls }, false);
    assert.equal(w.f, 'b.jpg');
    assert.equal(w.url, '/api/wallpaper/wallpaper?c=cars&f=b.jpg');
    w = currentWallpaper({ prefs: { wallpaperCollection: 'cars', wallpaperPinned: 'gone.jpg', wallpaperRotateMin: 60 }, wallpapers: walls }, false, 2 * 3600e3);
    assert.equal(w.f, 'c.jpg', 'a kept picture that is gone: rotation, hour 2 is the third');
    w = currentWallpaper({ prefs: { wallpaperCollection: 'empty' }, wallpapers: walls }, false, 0);
    assert.equal(w.coll, 'cars');
    assert.equal(currentWallpaper({ prefs: {}, wallpapers: { empty: [] } }, false), null);
    assert.equal(currentWallpaper({ prefs: { wallpaperCollection: 'my folder' }, wallpapers: { 'my folder': ['x y.png'] } }, false).url, '/api/wallpaper/wallpaper?c=my%20folder&f=x%20y.png');
});

test('what the wall shows: a picture the window couldn\'t show is passed over, kept or not', () => {
    const walls = { cars: ['a.jpg', 'b.jpg', 'c.jpg'] };
    const cant = new Set(['/api/wallpaper/wallpaper?c=cars&f=a.jpg']);
    assert.equal(currentWallpaper({ prefs: { wallpaperCollection: 'cars', wallpaperRotate: 'off' }, wallpapers: walls }, false, 0).f, 'a.jpg', 'without the mark, the first');
    assert.equal(currentWallpaper({ prefs: { wallpaperCollection: 'cars', wallpaperRotate: 'off' }, wallpapers: walls }, false, 0, cant).f, 'b.jpg', 'the next one that shows');
    assert.equal(currentWallpaper({ prefs: { wallpaperCollection: 'cars', wallpaperPinned: 'a.jpg', wallpaperRotateMin: 60 }, wallpapers: walls }, false, 0, cant).f, 'b.jpg', 'a kept one that can\'t show: rotation instead');
    for (let hour = 0; hour < 6; hour++) assert.notEqual(currentWallpaper({ prefs: { wallpaperCollection: 'cars', wallpaperRotateMin: 60 }, wallpapers: walls }, false, hour * 3600e3, cant).f, 'a.jpg', `hour ${hour}`);
    assert.equal(currentWallpaper({ prefs: { wallpaperCollection: 'cars' }, wallpapers: { cars: ['a.jpg'] } }, false, 0, cant), null, 'nothing that can show: nothing to show');
    const versioned = (v) => ({ prefs: { wallpaperCollection: 'cars', wallpaperRotate: 'off' }, wallpapers: walls, versions: { 'cars/a.jpg': v } });
    assert.equal(currentWallpaper(versioned(111), false, 0).url, '/api/wallpaper/wallpaper?c=cars&f=a.jpg&v=111', 'the address carries the file\'s modified time');
    const failedThen = new Set(['/api/wallpaper/wallpaper?c=cars&f=a.jpg&v=111']);
    assert.equal(currentWallpaper(versioned(111), false, 0, failedThen).f, 'b.jpg');
    assert.equal(currentWallpaper(versioned(222), false, 0, failedThen).f, 'a.jpg', 'changed since it failed: tried again');
});

test('the veil: none for a picture that fits the mode, enough for one that fights it, less at a higher tint', () => {
    const night = Array.from({ length: 384 }, (_, i) => [26 - (i % 20), 32 - (i % 24), 56 - (i % 40)]); // dark blue to near black
    const dune = Array.from({ length: 384 }, (_, i) => [244 - (i % 38), 236 - (i % 52), 220 - (i % 74)]); // sand
    const paper = Array.from({ length: 384 }, () => [240, 240, 236]);
    assert.equal(veilFor(paper, 'light', 0.55), 0, 'a light picture in light mode: no veil');
    assert.ok(veilFor(dune, 'light', 0.55) <= 0.25, 'sand, darker toward the bottom, in light mode: a little at most');
    assert.equal(veilFor(night, 'dark', 0.55), 0, 'a dark picture in dark mode: no veil');
    const vl = veilFor(night, 'light', 0.55);
    const vd = veilFor(dune, 'dark', 0.55);
    assert.ok(vl > 0.3 && vl <= 0.92, `light over a dark picture: ${vl}`);
    assert.ok(vd > 0.2 && vd <= 0.92, `dark over a light picture: ${vd}`);
    assert.ok(veilFor(night, 'light', 0.8) < vl && veilFor(dune, 'dark', 0.8) < vd, 'a higher tint needs less veil');
    assert.equal(veilFor([], 'light', 0.55), 0, 'nothing sampled: nothing added');
    // At the veil it gives, each of DSH's text colours reads on the glass: 4.5:1, or 80% of DSH's own when that is less.
    for (const [cells, mode, v] of [[night, 'light', vl], [dune, 'dark', vd]]) {
        const sorted = [...cells].sort((a, b) => contrastOf(a, [0, 0, 0]) - contrastOf(b, [0, 0, 0]));
        const worst = sorted[Math.floor((mode === 'light' ? 0.2 : 0.8) * sorted.length)];
        const wall0 = mixRgb(mixRgb(mode === 'light' ? [231, 231, 226] : [10, 13, 12], worst, 0.9), mode === 'light' ? [255, 255, 255] : [6, 8, 8], mode === 'light' ? 0.1 : 0.15);
        const glass = mixRgb(mixRgb(wall0, VEIL_RGB[mode], v), GLASS_RGB[mode], 0.55);
        for (const c of TEXT[mode].colours) assert.ok(contrastOf(c, glass) >= Math.min(4.5, 0.8 * contrastOf(c, TEXT[mode].ground)), `${mode} ${c}: ${contrastOf(c, glass).toFixed(2)}`);
    }
    // A colour wall: Graphite's light tone needs some in light mode; its dark tone none in dark.
    assert.ok(veilFor(colourCells(COLOUR_PRESETS[0].light, false), 'light', 0.55) > 0);
    assert.equal(veilFor(colourCells(COLOUR_PRESETS[0].dark, false), 'dark', 0.55), 0);
    assert.equal(colourCells('#336699', true).length, 3, 'a gradient: its light end, the colour, its dark end');
    assert.deepEqual(colourCells('nope', false), []);
});

test('the headline is one CSS string with quotes and backslashes escaped; names read as words', () => {
    assert.equal(cssString('a"b\\c\nd'), '"a\\"b\\\\c d"');
    assert.equal(nameOf('my-car_2.jpg'), 'my car 2');
    assert.deepEqual(swatchesOf({ wallpaperColours: ['#123456', 'red', 7] }).filter((s) => s.custom).map((s) => s.id), ['#123456']);
});

test('style sheet: every rule on DSH starts at a data-slot outlet and sits under body.wp-on (DESIGN.md section 8)', () => {
    assert.ok(!/(?<!\[data-slot="root"\] > )\[class\*="_frame"\]/.test(CSS), 'no broad _frame');
    assert.ok(!CSS.includes('[class*="_card"]'), 'no broad _card (it matched the workspace chip)');
    assert.ok(!/header\[class\*="_header"\](?!.*data-slot)/.test(CSS.split('\n').find((l) => l.includes('header[class*="_header"]')) ?? ''), 'no bare header rule');
    assert.ok(!/\[class\*="_tabLayout"\] \*/.test(CSS), 'no re-colouring of every line in the dock');
    for (const [name, sel] of Object.entries(SELECTORS)) {
        assert.match(sel, /^\[data-slot="[^"]+"\]/, `${name} starts at an outlet`);
        assert.ok(CSS.includes(sel), `${name} is used`);
    }
    const dshRules = CSS.split('\n').filter((l) => /\[data-slot=|\[class\*=|\[class\$=/.test(l));
    for (const line of dshRules) {
        const selectors = line.replace(/^@(media|container)[^{]*\{/, '').split('{')[0];
        assert.match(selectors, /^body\.wp-(on|still)/, `under body.wp-on: ${line.slice(0, 120)}`);
    }
});

test('style sheet: no DSH hash, nothing on :root or html, no tokens defined on body, no other plugin\'s classes', () => {
    assert.ok(!/\.[A-Za-z0-9-]{5,6}_[a-z]/.test(CSS), 'no hashed class name');
    assert.ok(!/_[a-z]+_[0-9a-z]{5}_\d+/.test(CSS), 'no CSS-module class name');
    assert.ok(!/(^|[\s,}]):root|(^|[\s,}])html[\s,{[]/.test(CSS), 'nothing on :root or html');
    assert.ok(!/body[^{]*\{(?:[^}]*;)?\s*--[\w-]+\s*:/.test(CSS), 'no custom property defined on body by the sheet');
    for (const other of ['.lc-', '.dshc-', '.dshp-', '.dshcal-', '.fs-', '.rp-']) assert.ok(!CSS.includes(other), `no ${other} classes`);
});

test('style sheet: DSH\'s content stays; the only things hidden are tile names, the rail\'s fold, and decoration', () => {
    assert.ok(!/_previewBadge|_fishHitbox/.test(CSS));
    const hides = [...CSS.matchAll(/([^{}]+)\{[^}]*display:none/g)].map((m) => m[1].trim());
    for (const sel of hides) assert.match(sel, /_panelTitle|wp-tiles-fold|::before|::after/, sel);
    assert.match(CSS, /body\.wp-on\.wp-headline \[data-slot="main\.conversation"\] \[class\*="_titleGroup"\] > span:first-child\{font-size:0/, 'the hero text gives way only while a headline is set');
});

test('style sheet: DSH\'s type and tokens only; no web font, no colour of its own on the panel', () => {
    assert.ok(!/fonts\.googleapis|@import|url\(http|geist/i.test(CSS + source.replace(/\/\/.*$/gm, '')), 'no web font or remote style');
    const vars = new Set([...CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    for (const v of vars) assert.match(v, /^--(dsw-|ds-transition|wp-(blur|tint|op|frost|headline|veil-light|veil-dark)$)/, v);
    const hex = [...CSS.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase());
    for (const h of hex) assert.ok(['#0a0d0c', '#e7e7e2', '#fff', '#2c2c2e'].includes(h), h);
    for (const m of CSS.matchAll(/(#fff|#2c2c2e)\b/gi)) assert.equal(CSS[m.index - 1], ',', `${m[0]} only as a var() fallback`);
    assert.match(CSS, /font-family:var\(--dsw-font-family\)/);
});

test('style sheet: glass near-opaque under reduced transparency on all four surfaces', () => {
    const blocks = [...CSS.matchAll(/@media \(prefers-reduced-transparency:reduce\)\{(.*)\}$/gm)].map((m) => m[1]);
    for (const key of ['sidebar', 'chatOpen', 'dock', 'composer']) {
        const b = blocks.find((x) => x.includes(SELECTORS[key]));
        assert.ok(b, `${key} has a reduced-transparency rule`);
        assert.match(b, key === 'chatOpen' ? /max\(\.95,/ : /max\(\.9,/);
    }
});

test('style sheet: motion stops under wp-still and reduced motion, pseudo-elements included', () => {
    assert.match(CSS, /body\.wp-still \*,body\.wp-still \*::before,body\.wp-still \*::after\{transition:none!important\}/);
    assert.match(CSS, /body\.wp-still :is\([^)]+\) \*::after\{animation:none!important\}|body\.wp-still :is\([^)]+\) \*::after[^{]*\{animation:none!important/);
    const reduced = /@media \(prefers-reduced-motion:reduce\)\{([^\n]*)\}/.exec(CSS)?.[1] ?? '';
    for (const part of ['#wp-wall .wp-wl', '::before', '::after', 'animation:none!important', 'transition:none!important']) assert.ok(reduced.includes(part), part);
});

test('a DSH part is a function or a forwardRef object; a DSH without the parts still loads and shows the look', () => {
    const p = load(null);
    const { ctx, slots, dispose } = ctxFor();
    const pg = page({ fetch: async () => answer(200, { prefs: {}, wallpapers: {} }) });
    try {
        p.apply(ctx);
        assert.deepEqual(slots.map((s) => s.opts.name), ['shell.overlay'], 'no footer button without DSH\'s Modal');
        assert.equal(pg.head.length, 1, 'the look is there');
        dispose();
    } finally { pg.restore(); }
});

test('apply: one style sheet, one wall, the published values, two slot entries; switch-off undoes all of it', async () => {
    const pg = page({ fetch: async () => answer(200, { prefs: { glassTint: 70, glassBlur: 30, motion: false, headline: 'Hi "you"', wallpaperKind: 'colour', wallpaperRotate: 'off', wallpaperColour: { light: '#6FA8F7', dark: '#14315F' } }, wallpapers: {} }) });
    const { ctx, effects, slots, dispose } = ctxFor();
    try {
        plugin.apply(ctx);
        await tick(10);
        assert.deepEqual(effects.map((e) => e.label), ['wallpaper: settings', 'wallpaper: wallpaper and glass']);
        assert.equal(pg.head.length, 1);
        assert.equal(pg.head[0].attrs['data-plugin'], 'dsh-plugin-wallpaper');
        assert.equal(pg.head[0].attrs['data-plugin-css'], 'dsh-plugin-wallpaper/client.css');
        assert.equal(pg.body.children[0].id, 'wp-wall');
        assert.equal(pg.body.children[0].attrs['aria-hidden'], 'true');
        assert.deepEqual(pg.body.classList.list().sort(), ['wp-headline', 'wp-on', 'wp-still']);
        assert.equal(pg.body.style.getPropertyValue('--wp-tint'), '0.7');
        assert.equal(pg.body.style.getPropertyValue('--wp-blur'), '30px');
        assert.equal(pg.body.style.getPropertyValue('--wp-headline'), '"Hi \\"you\\""');
        assert.equal(pg.body.children[0].style.getPropertyValue('--wp-op'), '0.9', 'the wall\'s own values sit on the wall');
        assert.match(pg.body.children[0].layers.find((l) => l.classList.contains('on')).style.backgroundImage, /#6FA8F7/);
        assert.equal(pg.state.observers, 1, 'one MutationObserver');
        assert.deepEqual(slots.map((s) => [s.opts.name, s.opts.id, s.opts.order]), [['sidebar.footer.action', 'dsh-plugin-wallpaper:open', 90], ['shell.overlay', 'dsh-plugin-wallpaper:overlays', 40]]);
        dispose();
        assert.equal(pg.head.length, 0, 'style sheet removed');
        assert.equal(pg.body.children.length, 0, 'wall removed');
        assert.deepEqual(pg.body.classList.list(), [], 'no class left');
        assert.deepEqual(Object.keys(pg.body.style.props), [], 'no value left');
        assert.equal(pg.state.observers, 0, 'observer stopped');
        const again = ctxFor();
        plugin.apply(again.ctx);
        await tick(10);
        assert.equal(pg.head.length, 1, 'on again: one style sheet');
        assert.equal(pg.body.children.filter((e) => e.id === 'wp-wall').length, 1, 'on again: one wall');
        again.dispose();
    } finally { pg.restore(); }
});

test('a host that doesn\'t answer at start is asked again, then DSH\'s toast says so in words', async () => {
    const saved = [...RETRIES];
    RETRIES.splice(0, RETRIES.length, 0, 5, 5);
    const pg = page({ fetch: async () => { throw new Error('connection refused'); } });
    const { ctx, dispose } = ctxFor();
    try {
        stores.uiS.set((u) => ({ ...u, toast: null }));
        plugin.apply(ctx);
        await tick(60);
        assert.equal(pg.state.requests.length, 3, 'three tries');
        assert.match(stores.uiS.get().toast?.text ?? '', /Wallpaper couldn't load its settings, so it shows its defaults: connection refused\./);
        dispose();
    } finally { pg.restore(); RETRIES.splice(0, RETRIES.length, ...saved); }
});

test('a refused save says so in that part of the panel and the panel goes back to what is saved', async () => {
    const pg = page({ fetch: async (_url, init) => (init?.method === 'POST' ? answer(400, { error: 'glassTint must be a number from 10 to 95' }) : answer(200, { prefs: { glassTint: 55 }, wallpapers: {} })) });
    try {
        stores.stateS.set({ prefs: prefsOf({ glassTint: 55 }), wallpapers: {}, offline: false });
        const done = savePrefs({ glassTint: 70 });
        assert.equal(stores.stateS.get().prefs.glassTint, 70, 'shown at once');
        assert.equal(await done, false, 'the caller learns it was not saved');
        await tick(5);
        const note = stores.uiS.get().note;
        assert.deepEqual([note.section, note.tone, note.text], ['glass', 'error', 'Couldn\'t save: glassTint must be a number from 10 to 95.']);
        assert.equal(stores.stateS.get().prefs.glassTint, 55, 'back to what the host has');
    } finally { pg.restore(); }
});

test('a save that works after one that couldn\'t clears the "Couldn\'t save" note', async () => {
    let fail = true;
    const pg = page({ fetch: async (_url, init) => (init?.method === 'POST'
        ? (fail ? answer(500, { error: 'couldn\'t write the settings file (no permission)' }) : answer(200, { ok: true, prefs: { glassTint: 64 }, wallpapers: {} }))
        : answer(200, { prefs: { glassTint: 55 }, wallpapers: {} })) });
    try {
        stores.stateS.set({ prefs: prefsOf({ glassTint: 55 }), wallpapers: {}, offline: false });
        assert.equal(await savePrefs({ glassTint: 70 }), false);
        await tick(5);
        assert.match(stores.uiS.get().note?.text ?? '', /^Couldn't save: couldn't write the settings file \(no permission\)\.$/);
        fail = false;
        assert.equal(await savePrefs({ wallpaperOpacity: 80 }), true);
        assert.equal(stores.uiS.get().note, null, 'the note is gone once a save works');
    } finally { pg.restore(); }
});

test('the panel names what it can\'t use: the config\'s problems at the top, folders left out, a picture that can\'t be shown', () => {
    const pg = page({ fetch: async () => answer(200, {}) });
    try {
        stores.stateS.set({ prefs: prefsOf({ wallpaperCollection: 'cars' }), wallpapers: { cars: ['a.jpg', 'b.jpg'] }, offline: false,
            skipped: ['#old (a collection\'s name must start with a letter or a number)'], configProblems: ['unknown key colour ignored (keys: dataDir, wallpaperDir, importFrom)'] });
        stores.cantShowS.set(new Set(['/api/wallpaper/wallpaper?c=cars&f=a.jpg']));
        const tree = walk(PanelBody({ ctx: null }));
        const all = tree.text.join(' ');
        assert.match(all, /Wallpaper's config has a problem: unknown key colour ignored \(keys: dataDir, wallpaperDir, importFrom\)\. It uses the defaults there; wallpaper\.log in its data folder has each one\./);
        assert.match(all, /Not in the panel: #old \(a collection's name must start with a letter or a number\)\./);
        assert.match(all, /a can't be shown: the window can't read it as a picture, so rotation passes over it\. Replace the file in the collection's folder, or move it to the Trash\./);
        const tile = tree.els.find((e) => e.props?.['aria-label'] === 'a, can\'t be shown');
        assert.ok(tile && tile.props['aria-disabled'] === 'true' && tile.props['aria-pressed'] === false && /wp-broken/.test(tile.props.className), 'its tile says so');
        assert.ok(byText(tree, 'Move a to the Trash'), 'a Trash button of its own');
        assert.equal(tree.els.find((e) => e.props?.['aria-current'] === 'true')?.props['aria-label'], 'b', 'the picture on the wall is the next one');
    } finally { stores.cantShowS.set(new Set()); pg.restore(); }
});

test('a click on the kept picture rotates again (after Rotate off too); choosing a collection rotates through it', async () => {
    const posts = [];
    const pg = page({ fetch: async (_url, init) => { if (init?.method === 'POST') posts.push(JSON.parse(init.body).prefs); return answer(200, { ok: true, prefs: {}, wallpapers: { cars: ['a.jpg', 'b.jpg'], sea: ['c.jpg'] } }); } });
    try {
        stores.stateS.set({ prefs: prefsOf({ wallpaperCollection: 'cars', wallpaperPinned: 'b.jpg', wallpaperRotate: 'off' }), wallpapers: { cars: ['a.jpg', 'b.jpg'], sea: ['c.jpg'] }, offline: false });
        let tree = walk(PanelBody({ ctx: null }));
        tree.els.find((e) => e.props?.['aria-label'] === 'b, kept').props.onClick();
        await tick(10);
        assert.deepEqual(posts.at(-1), { wallpaperCollection: 'cars', wallpaperKind: 'image', wallpaperPinned: null, wallpaperRotate: null });
        stores.stateS.set({ prefs: prefsOf({ wallpaperKind: 'colour', wallpaperRotate: 'off' }), wallpapers: { cars: ['a.jpg', 'b.jpg'], sea: ['c.jpg'] }, offline: false });
        tree = walk(PanelBody({ ctx: null }));
        byText(tree, 'sea (1)').props.onClick();
        await tick(10);
        assert.deepEqual(posts.at(-1), { wallpaperCollection: 'sea', wallpaperKind: 'image', wallpaperPinned: null, wallpaperRotate: null }, 'a colour had switched rotation off');
    } finally { pg.restore(); }
});

test('removing your own colour while it is on the wall puts Graphite in its place, and says so', async () => {
    let server = { wallpaperKind: 'colour', wallpaperRotate: 'off', wallpaperColour: { light: '#123456', dark: '#123456' }, wallpaperColours: ['#123456'] };
    const pg = page({ fetch: async (_url, init) => { if (init?.method === 'POST') server = { ...server, ...JSON.parse(init.body).prefs }; return answer(200, { ok: true, prefs: server, wallpapers: {} }); } });
    try {
        stores.stateS.set({ prefs: prefsOf(server), wallpapers: {}, offline: false });
        stores.uiS.set((u) => ({ ...u, note: null }));
        byText(walk(PanelBody({ ctx: null })), 'Remove #123456').props.onClick();
        await tick(20);
        assert.deepEqual(server.wallpaperColour, { light: COLOUR_PRESETS[0].light, dark: COLOUR_PRESETS[0].dark }, 'Graphite in both modes');
        assert.deepEqual(server.wallpaperColours, []);
        assert.equal(currentWallpaper(stores.stateS.get(), false).colour, COLOUR_PRESETS[0].light, 'the wall shows it');
        assert.equal(stores.uiS.get().note?.text, 'Removed #123456. Graphite shows in its place.');
    } finally { pg.restore(); }
});

test('a slider run is one save of its last value, and the host\'s answer never pulls the slider back mid-run', async () => {
    const pg = page({ fetch: async (_url, init) => answer(200, { ok: true, prefs: { glassTint: JSON.parse(init.body).prefs.glassTint }, wallpapers: {} }) });
    try {
        stores.stateS.set({ prefs: prefsOf({}), wallpapers: {}, offline: false });
        const runs = [60, 61, 62].map((v) => savePrefs({ glassTint: v }, true));
        assert.equal(stores.stateS.get().prefs.glassTint, 62);
        assert.deepEqual(await Promise.all(runs), [true, true, true], 'each caller learns it was saved');
        const posts = pg.state.requests.filter((r) => r.method === 'POST');
        assert.equal(posts.length, 1);
        assert.deepEqual(posts[0].body, { prefs: { glassTint: 62 } });
        assert.equal(stores.stateS.get().prefs.glassTint, 62);
    } finally { pg.restore(); }
});

test('README, manifest and locale agree; the README documents every config key and the published values', () => {
    const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf8'));
    const locale = JSON.parse(readFileSync(join(dir, '..', 'locale', 'en.json'), 'utf8'));
    const readme = readFileSync(join(dir, '..', 'README.md'), 'utf8');
    assert.equal(pkg.name, 'dsh-plugin-wallpaper');
    assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'), 'DSH\'s parts are injected');
    assert.equal(locale.meta.title, 'Wallpaper');
    assert.match(readme, /^# Wallpaper/);
    assert.match(readFileSync(join(dir, '..', 'cordis.patch.yml'), 'utf8'), /id: wallpaper\n\s+name: dsh-plugin-wallpaper/);
    for (const key of ['dataDir', 'wallpaperDir', 'importFrom']) assert.match(readme, new RegExp(`\\| \`${key}\` \\|`), `config table row for ${key}`);
    for (const pub of ['--wp-blur', '--wp-tint', 'wp-still', 'wp-on']) assert.ok(readme.includes(pub), pub);
});

test('no assistant or vendor names in the plugin\'s files or the test bench (house rule)', () => {
    // The words are put together here so this file doesn't match itself. Lower-case DSH identifiers such as the
    // `openai-completions` provider kind are DSH's own names and are not prose.
    const words = new RegExp([['cla', 'ude'], ['anthr', 'opic'], ['chat', 'gpt'], ['co', 'pilot'], ['gem', 'ini']].map((w) => w.join('')).join('|'), 'i');
    const prose = new RegExp(['Open', 'AI'].join(' ?'));
    const repo = join(dir, '..', '..', '..');
    const files = [];
    const walk = (folder) => {
        for (const e of readdirSync(folder, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const p = join(folder, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(m?js|json|md|ya?ml|css|html|sh|txt|svg)$/.test(e.name)) files.push(p);
        }
    };
    walk(join(dir, '..'));
    for (const f of readdirSync(join(repo, 'test', 'e2e'), { withFileTypes: true })) if (f.isFile()) files.push(join(repo, 'test', 'e2e', f.name));
    files.push(join(repo, 'scripts', 'e2e.mjs'));
    const hits = [];
    for (const f of files) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (words.test(line) || prose.test(line)) hits.push(`${relative(repo, f)}:${i + 1}`);
        });
    }
    assert.deepEqual(hits, []);
    assert.ok(files.length >= 12, `scanned ${files.length} files`);
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
        console.log(`not ok - ${name}\n    ${String(error.stack).split('\n').slice(0, 4).join('\n    ')}`);
    }
}
console.log(`\n# wallpaper client: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
