/**
 * Contrast measured from the window's pixels, the way a person sees it: every visible run of text inside the given
 * parts of the page, against the ground drawn under it. The ground is read from a second picture of the window taken
 * with all text made transparent for a moment (so a run is measured against what is really behind it: glass, wall,
 * picture), and the text's own colour is laid over that ground with its opacity.
 *
 * @module plugins/wallpaper/test/e2e/pixels
 */
import { inflateSync } from 'node:zlib';

/** A PNG (8-bit RGB or RGBA, as Chromium writes them) as { w, h, data } with 4 bytes a pixel. */
export function decodePng(buf) {
    let pos = 8;
    let w = 0;
    let h = 0;
    let type = 2;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const kind = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (kind === 'IHDR') {
            w = data.readUInt32BE(0);
            h = data.readUInt32BE(4);
            type = data[9];
        } else if (kind === 'IDAT') idat.push(data);
        else if (kind === 'IEND') break;
        pos += 12 + len;
    }
    const bpp = type === 6 ? 4 : type === 2 ? 3 : type === 4 ? 2 : 1;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * bpp;
    const out = Buffer.alloc(w * h * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const filter = raw[y * (stride + 1)];
        const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? line[i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            let v = line[i];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            line[i] = v & 255;
        }
        for (let x = 0; x < w; x++) {
            const s = x * bpp;
            const d = (y * w + x) * 4;
            if (bpp >= 3) {
                out[d] = line[s];
                out[d + 1] = line[s + 1];
                out[d + 2] = line[s + 2];
            } else out[d] = out[d + 1] = out[d + 2] = line[s];
            out[d + 3] = 255;
        }
        prev = line;
    }
    return { w, h, data: out };
}

/** Relative luminance of an [r, g, b] in 0..255 (WCAG). */
export const luminance = ([r, g, b]) => {
    const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** The contrast ratio of two [r, g, b]. */
export const ratioOf = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

/** The text runs inside `scopes`, read from the page: text, where, colour, size, weight, box. */
const runsIn = (page, scopes) => page.evaluate((sels) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const rgba = (c) => {
        g.clearRect(0, 0, 1, 1);
        g.fillStyle = '#000';
        g.fillStyle = c;
        g.fillRect(0, 0, 1, 1);
        const d = g.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
    };
    const word = (el) => {
        const cls = typeof el.className === 'string' ? (/_([a-zA-Z]+)/.exec(el.className)?.[1] ?? el.className.split(' ')[0]) : '';
        return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    // Something drawn over the text that paints a ground of its own hides it; a clear layer (an editor over its
    // placeholder) does not.
    const paints = (el) => {
        const c = getComputedStyle(el);
        return c.backgroundImage !== 'none' || !/rgba\(0, 0, 0, 0\)|transparent/.test(c.backgroundColor) || el.tagName === 'IMG';
    };
    const out = [];
    const seen = new Set();
    for (const sel of sels) {
        for (const root of document.querySelectorAll(sel)) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if (seen.has(n)) continue;
                seen.add(n);
                const text = n.textContent.trim();
                if (!text) continue;
                const el = n.parentElement;
                const cs = getComputedStyle(el);
                if (cs.visibility === 'hidden' || parseFloat(cs.fontSize) < 6 || el.closest('[aria-hidden="true"],[role="dialog"],[role="tooltip"],[role="menu"]')) continue;
                let op = 1;
                for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
                const col = rgba(cs.color);
                col[3] *= op;
                // Text DSH paints some other way (a gradient clipped to the glyphs, colour transparent) is left out.
                if (col[3] < 0.1) continue;
                const r = document.createRange();
                r.selectNodeContents(n);
                for (const b of r.getClientRects()) {
                    if (b.width < 4 || b.height < 6 || b.top < 1 || b.bottom > innerHeight - 1 || b.left < 1 || b.right > innerWidth - 1) continue;
                    const stack = document.elementsFromPoint(b.x + Math.min(b.width / 2, 6), b.y + b.height / 2);
                    const at = stack.findIndex((x) => x === el || el.contains(x) || x.contains(el));
                    if (at < 0 || stack.slice(0, at).some((x) => !x.contains(el) && paints(x))) continue;
                    out.push({ text: text.slice(0, 40), where: word(el), color: col, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), box: [b.x, b.y, b.width, b.height] });
                }
            }
        }
    }
    return out;
}, scopes);

/**
 * Every visible text run inside `scopes` (CSS selectors), with the contrast of its colour against the ground under
 * it. A run is one line of one text node; runs smaller than 6 px, outside the window or covered are left out.
 * Returns rows `{ text, where, size, weight, large, fg, bg, ratio }` (large: 24 px, or 18.66 px at weight 700).
 */
export async function textContrast(page, scopes) {
    const items = await runsIn(page, scopes);
    // The same window with every glyph transparent: what is left under the text is its ground.
    await page.addStyleTag({ content: '*,*::before,*::after,*::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;transition:none!important}' }).then((h) => h.evaluate((el) => el.setAttribute('data-wallpaper-test', 'ground')));
    await page.waitForTimeout(150);
    const ground = decodePng(await page.screenshot());
    await page.evaluate(() => document.querySelectorAll('style[data-wallpaper-test="ground"]').forEach((el) => el.remove()));
    const px = (img, x, y) => {
        const i = (Math.min(img.h - 1, Math.max(0, Math.round(y))) * img.w + Math.min(img.w - 1, Math.max(0, Math.round(x)))) * 4;
        return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    const rows = [];
    for (const it of items) {
        const [x, y, w, h] = it.box;
        const samples = [];
        for (let sx = x + 1; sx < x + w - 1; sx += Math.max(1, w / 24)) for (let sy = y + 2; sy < y + h - 2; sy += Math.max(1, h / 4)) samples.push(px(ground, sx, sy));
        if (!samples.length) continue;
        // The ground's worse quarter for this text: the samples nearest the text's own luminance.
        const textL = luminance(it.color);
        samples.sort((a, b) => Math.abs(luminance(a) - textL) - Math.abs(luminance(b) - textL));
        const bg = samples[Math.floor(samples.length / 4)];
        const [r, g, b, a] = it.color;
        const fg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)].map(Math.round);
        const large = it.size >= 24 || (it.size >= 18.66 && it.weight >= 700);
        rows.push({ text: it.text, where: it.where, size: it.size, weight: it.weight, large, fg: fg.join(','), bg: bg.join(','), ratio: Number(ratioOf(fg, bg).toFixed(2)) });
    }
    return rows;
}

/**
 * DSH's text with Wallpaper's look against the same text as DSH draws it alone (the look taken off in the page for a
 * moment: no wp-on, no wall). Each run needs 4.5:1 (3:1 large), or 80% of what DSH alone gives it when that is less
 * (DSH's own grey labels are 3.7:1 on its own white). Returns `{ rows, under }`; each row adds `own` and `need`.
 */
export async function contrastAgainstDsh(page, scopes) {
    const withLook = await textContrast(page, scopes);
    await page.evaluate(() => {
        document.body.classList.remove('wp-on');
        document.body.dataset.wallpaperTest = 'off';
        for (const el of document.querySelectorAll('#wp-wall,.wp-tiles-fold')) el.style.display = 'none';
    });
    await page.waitForTimeout(500);
    let alone;
    try {
        alone = await textContrast(page, scopes);
    } finally {
        await page.evaluate(() => {
            document.body.classList.add('wp-on');
            delete document.body.dataset.wallpaperTest;
            for (const el of document.querySelectorAll('#wp-wall,.wp-tiles-fold')) el.style.display = '';
        });
        await page.waitForTimeout(500);
    }
    const key = (r) => `${r.where}|${r.text}`;
    const pool = new Map();
    for (const r of alone) pool.set(key(r), [...(pool.get(key(r)) ?? []), r]);
    // Text that changed between the two pictures (a live count) is matched by its kind of element and colour.
    const sameKind = (r) => alone.filter((x) => x.where === r.where && x.size === r.size && x.text !== r.text).map((x) => x.ratio).sort((p, q) => p - q);
    const rows = withLook.map((r) => {
        const kin = sameKind(r);
        const own = (pool.get(key(r)) ?? []).shift()?.ratio ?? kin[Math.floor(kin.length / 2)];
        const full = r.large ? 3 : 4.5;
        const need = Number((own === undefined ? full : Math.min(full, 0.8 * own)).toFixed(2));
        return { ...r, own, need };
    });
    return { rows, under: rows.filter((r) => r.ratio < r.need) };
}
