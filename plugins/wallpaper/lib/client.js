// Wallpaper and glass — client bundle (hand-written, no build step).
//
// The look: a wallpaper behind DSH (pictures from your collections, or a colour), DSH's sidebar, open chat, right
// dock and composer turned into frosted glass over it, motion, and an optional headline over DSH's hero text. One
// button in the sidebar footer opens the panel (DSH's own Modal) where all of it is set. Wallpaper is DSH's one mod
// (DESIGN.md): it changes DSH's grounds, never DSH's text, icons or controls, and it reaches DSH only through
// anchored selectors (a data-slot outlet, then structure). The one layout change is the panel list as tiles, which
// fold to a row of icons.
//
// Other plugins may follow the look through what it publishes on <body>: --wp-blur, --wp-tint, the class wp-still
// while Motion is off, and wp-on while it runs. Nothing else here is a contract.
//
// DSH joins every plugin's browser half into one script, so nothing here may throw while it loads.
if (typeof window !== "undefined" && window.__ModuleLoader__) window.__ModuleLoader__.load({
	id: "dsh-plugin-wallpaper",
	factory: (require) => {
		const React = require("react");
		const ReactDOM = require("react-dom");
		let ui = {};
		try { ui = require("@deepseek-ai/dsh-client-ui-primitives") || {}; } catch { ui = {}; }
		const h = React.createElement;
		const { useState, useEffect, useRef, useSyncExternalStore, Fragment } = React;
		const PACKAGE = "dsh-plugin-wallpaper";
		const API = (typeof window !== "undefined" && window.__WALLPAPER_API__) || "/api/wallpaper/"; // a test page may point this at its own server

		// ------------------------------------------------------------ settings (pure, unit-tested)
		const DEFAULT_PREFS = { headline: "", wallpaperCollection: "cars", wallpaperPinned: null, wallpaperRotate: null, wallpaperRotateMin: 60, wallpaperOpacity: 90, wallpaperFrost: 4, glassBlur: 22, glassTint: 55, motion: true };
		// The sliders' ranges; the host keeps the same ones (lib/impl.js).
		const RANGES = { wallpaperOpacity: [0, 100], wallpaperFrost: [0, 24], glassBlur: [0, 40], glassTint: [10, 95] };
		const HEADLINE_MAX = 120;
		// Wallpaper rotation stops in minutes; prefs.wallpaperRotate is "off", or null to rotate every wallpaperRotateMin.
		const ROTATE_STOPS = [1, 5, 15, 30, 60, 120, 240, 480, 720, 1440];
		const rotateMinOf = (p) => (p?.wallpaperRotate === "off" ? 0 : typeof p?.wallpaperRotate === "string" ? (p.wallpaperRotate === "daily" ? 1440 : 60) : (ROTATE_STOPS.includes(Number(p?.wallpaperRotateMin)) ? Number(p.wallpaperRotateMin) : 60));
		const rotateLabel = (m) => (m >= 60 ? (m / 60) + " h" : m + " min");
		const clampNumber = (v, [lo, hi], fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : fallback);
		// What the look uses from saved settings: numbers in range, a short one-line headline, known values elsewhere.
		const prefsOf = (raw) => {
			const p = { ...DEFAULT_PREFS, ...(raw && typeof raw === "object" ? raw : {}) };
			for (const [k, range] of Object.entries(RANGES)) p[k] = clampNumber(p[k], range, DEFAULT_PREFS[k]);
			p.headline = typeof p.headline === "string" ? p.headline.replace(/\s+/g, " ").trim().slice(0, HEADLINE_MAX) : "";
			p.motion = p.motion !== false;
			return p;
		};
		// macOS-style solid colours: each preset has a light and a dark tone; a custom colour is the same in both.
		const COLOUR_PRESETS = [
			{ id: "graphite", name: "Graphite", light: "#9A9DA3", dark: "#26282C" },
			{ id: "silver", name: "Silver", light: "#C9CCD1", dark: "#3A3D42" },
			{ id: "blue", name: "Blue", light: "#6FA8F7", dark: "#14315F" },
			{ id: "teal", name: "Teal", light: "#67D5C8", dark: "#0E3B38" },
			{ id: "green", name: "Green", light: "#8FD9A0", dark: "#173D25" },
			{ id: "yellow", name: "Yellow", light: "#F3D774", dark: "#4A3D0E" },
			{ id: "orange", name: "Orange", light: "#F6AE6A", dark: "#4E2A0D" },
			{ id: "red", name: "Red", light: "#F28B82", dark: "#4E1717" },
			{ id: "pink", name: "Pink", light: "#F3A6CC", dark: "#4A1A35" },
			{ id: "purple", name: "Purple", light: "#B49CF0", dark: "#2A1D52" },
		];
		const HEX = /^#[0-9a-f]{6}$/i;
		const colourCss = (c, gradient) => (gradient ? `linear-gradient(160deg, color-mix(in oklab, ${c} 78%, white) 0%, ${c} 52%, color-mix(in oklab, ${c} 62%, black) 100%)` : `linear-gradient(${c}, ${c})`);
		const swatchesOf = (p) => [...COLOUR_PRESETS, ...(Array.isArray(p?.wallpaperColours) ? p.wallpaperColours : []).filter((x) => HEX.test(x)).map((hex) => ({ id: hex, name: hex.toUpperCase(), light: hex, dark: hex, custom: true }))];
		const nameOf = (file) => String(file).replace(/\.\w+$/, "").replace(/[-_]+/g, " ");
		// A picture's address carries its file's modified time (from the host), so a file replaced under the same name is
		// fetched again, and one that couldn't be shown is tried again once it changes.
		const imageUrl = (coll, f, versions) => API + "wallpaper?c=" + encodeURIComponent(coll) + "&f=" + encodeURIComponent(f) + (versions?.[coll + "/" + f] ? "&v=" + versions[coll + "/" + f] : "");
		/**
		 * What the wallpaper shows now: a picture from the collection, or a colour (rotating through the swatches when
		 * rotation is on). A colour takes its light or dark tone from DSH's colour mode.
		 */
		const currentWallpaper = (st, dark, now = Date.now(), cantShow = null) => {
			const p = st?.prefs || {}; const walls = st?.wallpapers || {};
			const min = rotateMinOf(p);
			const slotOf = (n) => Math.floor(now / (min * 60e3)) % n;
			if (p.wallpaperKind === "colour") {
				const t = dark ? "dark" : "light";
				const sw = swatchesOf(p);
				const saved = p.wallpaperColour?.[t];
				const c = min ? sw[slotOf(sw.length)][t] : (HEX.test(saved ?? "") ? saved : COLOUR_PRESETS[0][t]);
				return { kind: "colour", key: "colour:" + c + ":" + !!p.wallpaperGradient, css: colourCss(c, p.wallpaperGradient), colour: c };
			}
			const coll = walls[p.wallpaperCollection]?.length ? p.wallpaperCollection : Object.keys(walls).find((k) => walls[k]?.length);
			// A picture the window couldn't show is passed over (rotation moves on to the next one that shows).
			const files = (walls[coll] || []).filter((f) => !cantShow?.has(imageUrl(coll, f, st?.versions)));
			if (!files.length) return null;
			const f = p.wallpaperPinned && files.includes(p.wallpaperPinned) ? p.wallpaperPinned : min ? files[slotOf(files.length)] : files[0];
			const url = imageUrl(coll, f, st?.versions);
			return { kind: "image", key: url, coll, f, url };
		};
		// The headline goes into CSS `content`: one quoted line, with quotes and backslashes escaped.
		const cssString = (t) => '"' + String(t).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r\f]/g, " ") + '"';
		const reasonOf = (e) => String(e?.message || e || "no answer").replace(/^Error:\s*/, "").slice(0, 200);

		// ------------------------------------------------------------ the veil: DSH's words stay readable (pure, unit-tested)
		// DSH's text colours are tuned for its own opaque grounds (white in light, near-black in dark; DESIGN.md section
		// 4). Over a picture of the other tone, glass at the tint lets too much of the picture through for them, and the
		// new-chat page's words sit on the wall itself. So the wall carries a veil in the colour mode's own ground: a
		// picture that fits the mode gets none, one that fights it gets just enough that, at the glass tint in use, each
		// of DSH's text colours keeps at least 4.5:1 on the glass (or 80% of what DSH gives it on its own ground, when that
		// is less: DSH's tertiary grey is 3.7:1 on its own white), and DSH's main text keeps 4.5:1 on the bare wall. A
		// higher tint needs less veil, so the tint stays the lever for how much of the picture shows.
		const TEXT = {
			light: { ground: [255, 255, 255], colours: [[15, 17, 21], [97, 102, 107], [129, 133, 140]] },
			dark: { ground: [21, 21, 23], colours: [[249, 250, 251], [207, 211, 214], [173, 178, 184]] },
		};
		const GLASS_RGB = { light: [250, 250, 246], dark: [14, 18, 17] };
		const VEIL_RGB = { light: [250, 250, 246], dark: [10, 13, 12] };
		const WALL_RGB = { light: [231, 231, 226], dark: [10, 13, 12] }; // the wall's own ground under the picture
		const SCRIM_MIN = { light: [[255, 255, 255], 0.1], dark: [[6, 8, 8], 0.15] }; // the scrim at its thinnest
		const ROW_FILL = { light: [[38, 49, 72], 0.059], dark: [[255, 255, 255], 0.078] }; // DSH's row fill (open or hovered)
		const lumOf = ([r, g, b]) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
		const contrastOf = (a, b) => { const [x, y] = [lumOf(a), lumOf(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
		const mixRgb = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
		/** The worst part of a picture for this mode: its darker parts in light mode, its lighter parts in dark. */
		const worstCell = (cells, mode) => {
			const sorted = [...cells].sort((p, q) => lumOf(p) - lumOf(q));
			return sorted[Math.min(sorted.length - 1, Math.floor((mode === "light" ? 0.2 : 0.8) * sorted.length))];
		};
		/**
		 * The veil (0 to .92) the wall needs in this mode over a picture sampled as `cells` ([r, g, b] each), shown at
		 * `opacity` (0 to 1) under glass at `tint` (.1 to .95).
		 */
		const veilFor = (cells, mode, tint, opacity = 0.9) => {
			if (!Array.isArray(cells) || !cells.length) return 0;
			const text = TEXT[mode];
			const [fill, fillA] = ROW_FILL[mode];
			// Each colour on plain glass and on a selected row, against what DSH gives it on its own ground (3% to spare).
			const need = (c, row) => 1.03 * Math.min(4.5, 0.8 * contrastOf(c, row ? mixRgb(text.ground, fill, fillA) : text.ground));
			const [scrim, scrimA] = SCRIM_MIN[mode];
			const wall0 = mixRgb(mixRgb(WALL_RGB[mode], worstCell(cells, mode), opacity), scrim, scrimA);
			const reads = (v) => {
				const wall = mixRgb(wall0, VEIL_RGB[mode], v);
				const glass = mixRgb(wall, GLASS_RGB[mode], tint);
				const row = mixRgb(glass, fill, fillA);
				return text.colours.every((c) => contrastOf(c, glass) >= need(c, false) && contrastOf(c, row) >= need(c, true)) && contrastOf(text.colours[0], wall) >= 4.5 * 1.03;
			};
			if (reads(0)) return 0;
			if (!reads(0.92)) return 0.92;
			let lo = 0; let hi = 0.92;
			for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (reads(mid)) hi = mid; else lo = mid; }
			return Math.ceil(hi * 100) / 100;
		};
		/** A colour wall's cells: the colour, or a gradient's two ends and middle (colourCss mixes toward white and black). */
		const colourCells = (hex, gradient) => {
			const rgb = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
			if (rgb.some((v) => !Number.isFinite(v))) return [];
			return gradient ? [mixRgb(rgb, [255, 255, 255], 0.22), rgb, mixRgb(rgb, [0, 0, 0], 0.38)] : [rgb];
		};
		/** A loaded picture, drawn small: [r, g, b] for each of 24 x 16 cells (empty when the browser won't say). */
		const pictureCells = (img) => {
			try {
				const c = document.createElement("canvas"); c.width = 24; c.height = 16;
				const g = c.getContext("2d", { willReadFrequently: true });
				g.drawImage(img, 0, 0, 24, 16);
				const d = g.getImageData(0, 0, 24, 16).data;
				const out = [];
				for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]);
				return out;
			} catch { return []; }
		};

		// ------------------------------------------------------------ stores
		const createStore = (init) => {
			let value = init;
			const subs = new Set();
			return {
				get: () => value,
				set: (next) => { value = typeof next === "function" ? next(value) : next; subs.forEach((f) => f()); },
				sub: (f) => { subs.add(f); return () => subs.delete(f); },
			};
		};
		const useStore = (s) => useSyncExternalStore(s.sub, s.get, s.get);
		// Until the host answers, the look uses the defaults (offline), so the glass is right from the first frame.
		const stateS = createStore({ prefs: DEFAULT_PREFS, wallpapers: {}, offline: true });
		const uiS = createStore({ panel: false, confirm: null, note: null, toast: null });
		const darkS = createStore(false);
		// Pictures the window couldn't show (a file that isn't a picture after all): their addresses.
		const cantShowS = createStore(new Set());
		const cantShow = (url) => { if (!cantShowS.get().has(url)) cantShowS.set((s) => new Set([...s, url])); };
		const isDark = () => typeof document !== "undefined" && !!document.body?.hasAttribute("data-ds-dark-theme");

		// ------------------------------------------------------------ the host
		const api = async (path, body) => {
			const res = await fetch(API + path, body === undefined ? { credentials: "same-origin", cache: "no-store" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			const text = await res.text();
			let value;
			try { value = JSON.parse(text); } catch { value = undefined; }
			if (!res.ok || !value || typeof value !== "object") throw new Error(value?.error || (res.status === 404 ? "Wallpaper's host half isn't running" : "the host answered " + res.status));
			if (value.error) throw new Error(value.error);
			return value;
		};
		const takeState = (v) => stateS.set({ ...v, prefs: prefsOf(v.prefs), wallpapers: v.wallpapers && typeof v.wallpapers === "object" ? v.wallpapers : {}, offline: false });
		const loadState = () => api("state").then(takeState);
		// Which part of the panel a setting belongs to, so a failure shows where the person is looking.
		const SECTION = { wallpaperOpacity: "glass", wallpaperFrost: "glass", glassBlur: "glass", glassTint: "glass", motion: "motion", headline: "headline", wallpaperColour: "colours", wallpaperColours: "colours", wallpaperGradient: "colours", wallpaperKind: "pictures", wallpaperCollection: "pictures", wallpaperPinned: "pictures", wallpaperRotate: "rotation", wallpaperRotateMin: "rotation" };
		const note = (section, text, tone = "ok") => uiS.set((u) => ({ ...u, note: { section, text, tone, at: Date.now() } }));
		// A change shows at once; saves go to the host one after another (a slider's run of changes as one save, a
		// quarter second after it stops). The host's answer is taken only when no newer change waits, so a dragged
		// slider never jumps back. A refused or failed save says so in the panel, which goes back to what the host has.
		let saving = Promise.resolve();
		let queued = null; let waiters = []; let timer = 0; let inflight = 0;
		const flush = () => {
			clearTimeout(timer); timer = 0;
			const patch = queued; const done = waiters;
			queued = null; waiters = [];
			if (!patch) { done.forEach((f) => f(true)); return saving; }
			const section = SECTION[Object.keys(patch)[0]] || "glass";
			inflight++;
			// Each waiter learns whether its change was saved (true) or refused (false).
			saving = saving.then(() => api("state", { prefs: patch }).then((v) => {
				inflight--;
				if (!inflight && !queued) takeState(v);
				// A save that works ends a note that one couldn't: the panel shows what is saved again.
				uiS.set((u) => (u.note?.tone === "error" && /^Couldn't save/.test(u.note.text) ? { ...u, note: null } : u));
				return true;
			}, (e) => {
				inflight--;
				note(section, "Couldn't save: " + reasonOf(e) + ".", "error");
				return loadState().catch(() => {}).then(() => false);
			})).then((ok) => { done.forEach((f) => f(ok)); });
			return saving;
		};
		const savePrefs = (patch, soon = false) => {
			stateS.set((s) => ({ ...s, prefs: prefsOf({ ...s.prefs, ...patch }) }));
			queued = { ...(queued || {}), ...patch };
			const saved = new Promise((resolve) => waiters.push(resolve));
			if (soon) { clearTimeout(timer); timer = setTimeout(flush, 250); } else flush();
			return saved;
		};
		const toast = (text) => uiS.set((u) => ({ ...u, toast: { text, at: Date.now() } }));

		// ------------------------------------------------------------ small parts (DSH's when it has them)
		const svg = (paths, size = 18) => h("svg", { className: "wp-i", viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", focusable: "false" }, ...paths.map((d, i) => (typeof d === "string" ? h("path", { key: i, d }) : d)));
		const IC = {
			image: (s) => svg([h("rect", { key: "r", x: 3.5, y: 5, width: 17, height: 14, rx: 2 }), "M3.5 16l5-5 4 4 3-3 5 5"], s),
			plus: (s) => svg(["M12 5v14M5 12h14"], s),
			trash: (s) => svg(["M5 7h14M10 7V5h4v2", "M7 7l.9 12.1a1.5 1.5 0 001.5 1.4h5.2a1.5 1.5 0 001.5-1.4L17 7", "M10.5 11v6M13.5 11v6"], s),
			up: (s) => svg(["M6 15l6-6 6 6"], s),
			down: (s) => svg(["M6 9l6 6 6-6"], s),
		};
		const cx = (...a) => a.filter(Boolean).join(" ");
		// A DSH part is a function or, for the ones that pass a ref (Button), a forwardRef object.
		const isPart = (c) => typeof c === "function" || (typeof c === "object" && c !== null && "$$typeof" in c);
		const Btn = (props) => (isPart(ui.Button) ? h(ui.Button, { variant: "outline", ...props }) : h("button", { type: "button", ...props, className: cx("wp-btn", props.className) }, props.icon, props.children));
		const Seg = ({ id, value, options, onChange, label }) => (isPart(ui.SegmentedControl)
			? h(ui.SegmentedControl, { id, value, options, onChange, label, className: "wp-seg" })
			: h("div", { role: "radiogroup", "aria-label": label, className: "wp-seg" }, options.map((o) => h("button", { key: o.value, type: "button", role: "radio", "aria-checked": o.value === value, onClick: () => onChange(o.value) }, o.label))));
		const Toggle = ({ checked, onChange, label }) => (isPart(ui.Switch)
			? h(ui.Switch, { checked, onChange, label })
			: h("input", { type: "checkbox", role: "switch", checked, "aria-label": label, onChange: (e) => onChange(e.target.checked) }));
		const Check = ({ checked, onChange, label }) => (isPart(ui.Checkbox)
			? h(ui.Checkbox, { checked, onChange, label })
			: h("label", { className: "wp-check" }, h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) }), h("span", null, label)));
		const Note = ({ section }) => {
			const n = useStore(uiS).note;
			if (!n || n.section !== section) return null;
			return h("p", { className: cx("wp-note", n.tone === "error" && "wp-note-error"), role: n.tone === "error" ? "alert" : "status" }, n.text);
		};
		// One tab stop for a set of buttons; the arrow keys, Home and End move inside it (DESIGN.md, keyboard).
		const ROVE_KEYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: "up", ArrowDown: "down", Home: "home", End: "end" };
		const rove = (e) => {
			const step = ROVE_KEYS[e.key];
			if (step === undefined) return;
			const items = [...e.currentTarget.querySelectorAll("[data-wallpaper-rove]")];
			const i = items.indexOf(document.activeElement);
			if (i < 0) return;
			e.preventDefault();
			const cols = Math.max(1, items.filter((el) => el.offsetTop === items[0].offsetTop).length);
			const to = step === "home" ? 0 : step === "end" ? items.length - 1 : i + (step === "up" ? -cols : step === "down" ? cols : step);
			const next = Math.min(items.length - 1, Math.max(0, to));
			items.forEach((el, k) => { el.tabIndex = k === next ? 0 : -1; });
			items[next].focus();
		};

		// ------------------------------------------------------------ pictures
		const readImage = (file) => new Promise((resolve, reject) => { const fr = new FileReader(); fr.onerror = () => reject(new Error("couldn't read " + file.name)); fr.onload = () => resolve(fr.result); fr.readAsDataURL(file); });
		// Big photos are scaled to 3840 px on the long edge before they are sent (the wallpaper shows them at 2880 px).
		const shrinkImage = (dataUrl) => new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				const scale = Math.min(1, 3840 / Math.max(img.naturalWidth, img.naturalHeight));
				if (scale === 1 && dataUrl.length < 12e6) return resolve(dataUrl);
				const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
				c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
				resolve(c.toDataURL("image/jpeg", 0.9));
			};
			img.onerror = () => resolve(dataUrl); // HEIC: the host converts it
			img.src = dataUrl;
		});
		const IMAGE_TYPES = /\.(jpe?g|png|webp|heic)$/i;
		const uploadWallpapers = async (collection, files) => {
			const list = [...files].filter((f) => /^image\//.test(f.type) || IMAGE_TYPES.test(f.name));
			if (!list.length) return note("pictures", "Nothing added: use JPEG, PNG, WebP or HEIC pictures.", "error");
			note("pictures", `Adding ${list.length} picture${list.length === 1 ? "" : "s"}…`);
			let ok = 0; const errs = [];
			for (const f of list) {
				try {
					const data = await readImage(f);
					const shrunk = await shrinkImage(data);
					await api("wallpaper-add", { collection, name: shrunk !== data ? f.name.replace(/\.[^.]+$/, "") + ".jpg" : f.name, data: shrunk });
					ok++;
				} catch (e) { errs.push(reasonOf(e)); }
			}
			await loadState().catch(() => {});
			if (ok) note("pictures", `Added ${ok} picture${ok === 1 ? "" : "s"} to ${collection}.${errs.length ? ` ${errs.length} not added: ${errs[0]}.` : ""}`, errs.length ? "error" : "ok");
			else note("pictures", `Nothing added: ${errs[0] || "no pictures"}.`, "error");
		};

		// ------------------------------------------------------------ the panel
		const ColourModeRow = ({ ctx }) => {
			let theme;
			try { theme = ctx?.get?.("theme"); } catch { theme = undefined; }
			useStore(darkS); // DSH's colour mode shows at once when it changes elsewhere
			const [, setTick] = useState(0);
			if (!theme?.setTheme) return null;
			const mode = theme?.snapshot?.preference ?? "system";
			const pick = (m) => { try { theme.setTheme(m); setTick((n) => n + 1); } catch (e) { note("mode", "Couldn't change the colour mode: " + reasonOf(e) + ".", "error"); } };
			return h("section", { className: "wp-field", "aria-labelledby": "wp-h-mode" },
				h("h3", { id: "wp-h-mode", className: "wp-h" }, "Colour mode"),
				h(Seg, { id: "wp-mode", value: mode, label: "Colour mode", onChange: pick, options: [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }] }),
				h("p", { className: "wp-meta" }, "DSH's own appearance setting: System follows macOS."),
				h(Note, { section: "mode" }));
		};
		const Slider = ({ p, k, label, unit }) => {
			const [lo, hi] = RANGES[k];
			const id = "wp-s-" + k;
			return h("div", { className: "wp-slider" },
				h("label", { htmlFor: id }, label),
				h("input", { id, type: "range", min: lo, max: hi, value: p[k], "aria-valuetext": p[k] + (unit === "%" ? " percent" : " pixels"), onChange: (e) => savePrefs({ [k]: Number(e.target.value) }, true) }),
				h("output", { htmlFor: id, className: "wp-num" }, p[k] + unit));
		};
		const PanelBody = ({ ctx }) => {
			const st = useStore(stateS);
			const dark = useStore(darkS);
			const [naming, setNaming] = useState(null); // { kind: "new" | "rename", value }
			const [headline, setHeadline] = useState(null); // what is typed, until it is saved
			const saveHeadline = (raw) => {
				const v = String(raw ?? "").replace(/\s+/g, " ").trim();
				if (v === stateS.get().prefs.headline) { setHeadline(null); return; }
				savePrefs({ headline: v }).then((ok) => { setHeadline(null); if (ok) note("headline", v ? "The new chat page shows your headline." : "The new chat page shows DSH's own headline."); });
			};
			const focusBack = (mark) => requestAnimationFrame(() => document.querySelector(`.wp-panel [data-wallpaper-back="${mark}"]`)?.focus());
			const [dropping, setDropping] = useState(false);
			const [slot, setSlot] = useState("both");
			const fileRef = useRef(null);
			const colourRef = useRef(null);
			const p = st.prefs;
			const walls = st.wallpapers || {};
			const names = Object.keys(walls);
			const coll = walls[p.wallpaperCollection] ? p.wallpaperCollection : names.find((k) => walls[k].length) ?? names[0];
			const kind = p.wallpaperKind === "colour" ? "colour" : "image";
			const min = rotateMinOf(p);
			const rotating = min > 0 && !(kind === "image" && p.wallpaperPinned);
			const broken = useStore(cantShowS);
			const shown = currentWallpaper(st, dark, Date.now(), broken);
			const files = (coll && walls[coll]) || [];
			const urlOf = (f) => imageUrl(coll, f, st.versions);
			const isBroken = (f) => broken.has(urlOf(f));
			const brokenHere = files.filter(isBroken);
			const commitName = async (value) => {
				const v = String(value ?? "").trim(); const n = naming; setNaming(null);
				if (!v || !n || (n.kind === "rename" && v === coll)) return;
				try {
					const r = n.kind === "new" ? await api("collection-create", { name: v }) : await api("collection-rename", { from: coll, to: v });
					const chosen = n.kind === "new" ? await savePrefs({ wallpaperCollection: r.name, wallpaperKind: "image", wallpaperPinned: null }) : true;
					await loadState();
					if (chosen) note("pictures", n.kind === "new" ? `Made ${r.name}. Add pictures with Add pictures, or drop them on the list.` : `Renamed ${coll} to ${r.name}.`);
				} catch (e) { note("pictures", (n.kind === "new" ? "Couldn't make the collection: " : "Couldn't rename it: ") + reasonOf(e) + ".", "error"); }
			};
			// The name field takes the focus once DSH's dialog has settled the focus after the button it replaces went.
			const takeFocus = (el) => { if (el && !el.dataset.wallpaperFocused) { el.dataset.wallpaperFocused = "1"; requestAnimationFrame(() => { el.focus(); el.select(); }); } };
			// Enter or Escape closes the field and puts the focus back on the button that opened it; a click elsewhere leaves the focus where it went.
			const nameField = (label) => h("input", { ref: takeFocus, className: "wp-input wp-rename", defaultValue: naming.value, maxLength: 80, "aria-label": label, onFocus: (e) => e.currentTarget.select(),
				onKeyDown: (e) => { if (e.key !== "Enter" && e.key !== "Escape") return; e.preventDefault(); if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.dataset.cancel = "1"; } e.currentTarget.dataset.back = "1"; e.currentTarget.blur(); },
				onBlur: (e) => { const el = e.currentTarget; const back = el.dataset.back && naming?.kind; commitName(el.dataset.cancel ? null : el.value); if (back) focusBack(back); } });
			const removeShown = () => {
				const f = shown?.kind === "image" ? shown.f : null;
				if (!f) return;
				uiS.set((u) => ({ ...u, confirm: { file: f, collection: shown.coll } }));
			};
			const onDrop = (e) => { e.preventDefault(); setDropping(false); if (coll) uploadWallpapers(coll, e.dataTransfer?.files || []); else note("pictures", "Make a collection first, with New collection.", "error"); };
			const tone = (sw) => (slot === "dark" ? sw.dark : sw.light);
			const selected = (sw) => kind === "colour" && (slot === "both" ? p.wallpaperColour?.light === sw.light && p.wallpaperColour?.dark === sw.dark : p.wallpaperColour?.[slot] === sw[slot]);
			const pickColour = (sw) => savePrefs({ wallpaperKind: "colour", wallpaperRotate: "off", wallpaperColour: slot === "both" ? { light: sw.light, dark: sw.dark } : { ...(p.wallpaperColour || { light: COLOUR_PRESETS[0].light, dark: COLOUR_PRESETS[0].dark }), [slot]: sw[slot] } });
			const addColour = (hex) => { if (!HEX.test(hex)) return; const list = [...new Set([...(p.wallpaperColours || []), hex.toLowerCase()])].slice(-16); savePrefs({ wallpaperColours: list }); pickColour({ light: hex.toLowerCase(), dark: hex.toLowerCase() }); };
			// Removing the colour on the wall puts the first preset in its place, in each mode that showed it, and says so.
			const removeColour = (sw) => {
				const was = p.wallpaperColour || {}; const next = { ...was };
				for (const t of ["light", "dark"]) if (String(was[t] || "").toLowerCase() === sw.id) next[t] = COLOUR_PRESETS[0][t];
				const onWall = kind === "colour" && (next.light !== was.light || next.dark !== was.dark);
				savePrefs({ wallpaperColours: (p.wallpaperColours || []).filter((x) => x !== sw.id), ...(onWall ? { wallpaperColour: next } : {}) })
					.then((ok) => { if (ok) note("colours", `Removed ${sw.name}.` + (onWall ? ` ${COLOUR_PRESETS[0].name} shows in its place.` : "")); });
				focusBack("colour");
			};
			const swatches = swatchesOf(p);
			const customOn = swatches.find((sw) => sw.custom && selected(sw));
			const thumbStop = Math.max(0, files.indexOf(shown?.kind === "image" ? shown.f : files[0]));
			const swatchStop = Math.max(0, swatches.findIndex(selected));
			const setRotate = (on) => savePrefs(on
				? { wallpaperPinned: null, wallpaperRotate: null, wallpaperRotateMin: ROTATE_STOPS.includes(Number(p.wallpaperRotateMin)) ? Number(p.wallpaperRotateMin) : 60 }
				: kind === "image" && shown?.f ? { wallpaperRotate: "off", wallpaperPinned: shown.f }
					: { wallpaperRotate: "off", ...(kind === "colour" && shown?.colour ? { wallpaperColour: { ...(p.wallpaperColour || {}), [dark ? "dark" : "light"]: shown.colour } } : {}) });
			const stopIndex = Math.max(0, ROTATE_STOPS.indexOf(min || rotateMinOf({ wallpaperRotateMin: p.wallpaperRotateMin })));
			return h(Fragment, null,
				(st.offline || st.problem) && h("p", { className: "wp-note wp-note-error", role: "alert" }, st.problem ? st.problem + ". See wallpaper.log in its data folder." : "Wallpaper's settings aren't reachable, so it shows its defaults and can't save. Restart DSH, or see wallpaper.log in its data folder."),
				st.configProblems?.length > 0 && h("p", { className: "wp-note", role: "status" }, "Wallpaper's config " + (st.configProblems.length === 1 ? "has a problem: " : "has " + st.configProblems.length + " problems: ") + st.configProblems.slice(0, 2).join("; ") + (st.configProblems.length > 2 ? "; and " + (st.configProblems.length - 2) + " more" : "") + ". It uses the defaults there; wallpaper.log in its data folder has each one."),
				h(ColourModeRow, { ctx }),
				h("section", { className: "wp-field", "aria-labelledby": "wp-h-pictures" },
					h("div", { className: "wp-row wp-between wp-wrap" },
						h("h3", { id: "wp-h-pictures", className: "wp-h" }, "Pictures"),
						h("div", { className: "wp-row wp-wrap" },
							coll && !naming && h(Btn, { variant: "ghost", "data-wallpaper-back": "rename", onClick: () => setNaming({ kind: "rename", value: coll }) }, "Rename " + coll),
							naming?.kind === "new" ? nameField("New collection name") : h(Btn, { variant: "ghost", icon: IC.plus(14), "data-wallpaper-back": "new", onClick: () => setNaming({ kind: "new", value: "" }) }, "New collection"))),
					names.length > 0 && h("div", { className: "wp-row wp-wrap", role: "group", "aria-label": "Collections" },
						names.map((c) => (naming?.kind === "rename" && c === coll
							? h("span", { key: c }, nameField("Collection name"))
							: h(Btn, { key: c, variant: kind === "image" && c === coll ? "primary" : "outline", "aria-pressed": kind === "image" && c === coll, onClick: () => savePrefs({ wallpaperCollection: c, wallpaperKind: "image", wallpaperPinned: null, wallpaperRotate: null }) }, `${c} (${walls[c].length})`)))),
					coll && h("div", { className: cx("wp-thumbs", dropping && "wp-drop"), role: "group", "aria-label": "Pictures in " + coll, onKeyDown: rove,
						onDragOver: (e) => { e.preventDefault(); if (!dropping) setDropping(true); }, onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false); }, onDrop },
						files.map((f, i) => h("button", { key: f, type: "button", "data-wallpaper-rove": "", tabIndex: i === thumbStop ? 0 : -1, className: cx("wp-thumb", kind === "image" && shown?.f === f && "wp-shown", isBroken(f) && "wp-broken"),
							"aria-pressed": !isBroken(f) && p.wallpaperPinned === f, "aria-current": kind === "image" && shown?.f === f ? "true" : undefined, "aria-disabled": isBroken(f) ? "true" : undefined,
							title: nameOf(f) + (isBroken(f) ? ": can't be shown" : ""), "aria-label": nameOf(f) + (isBroken(f) ? ", can't be shown" : p.wallpaperPinned === f ? ", kept" : ""),
							onClick: () => { if (!isBroken(f)) savePrefs(kind === "image" && p.wallpaperPinned === f ? { wallpaperCollection: coll, wallpaperKind: "image", wallpaperPinned: null, wallpaperRotate: null } : { wallpaperCollection: coll, wallpaperKind: "image", wallpaperPinned: f }); } },
							h("img", { src: urlOf(f), alt: "", loading: "lazy", draggable: false, onError: () => cantShow(urlOf(f)) }),
							isBroken(f) && h("span", { className: "wp-thumb-broken", "aria-hidden": "true" }, "Can't be shown"))),
						files.length === 0 && h("p", { className: "wp-meta wp-empty" }, "No pictures in " + coll + " yet. Add some with Add pictures, or drop them here.")),
					h("div", { className: "wp-row wp-wrap" },
						coll && h(Btn, { icon: IC.plus(14), onClick: () => fileRef.current?.click() }, "Add pictures"),
						kind === "image" && shown?.f && h(Btn, { variant: "ghost", icon: IC.trash(14), onClick: removeShown, "aria-label": `Move ${nameOf(shown.f)} to the Trash` }, "Move to the Trash"),
						h("input", { ref: fileRef, type: "file", className: "wp-file", accept: "image/jpeg,image/png,image/webp,image/heic,.heic", multiple: true, tabIndex: -1, "aria-hidden": "true", onChange: (e) => { const fl = e.target.files; if (fl?.length) uploadWallpapers(coll, [...fl]); e.target.value = ""; } })),
					brokenHere.length > 0 && h("div", { className: "wp-row wp-wrap" },
						h("p", { className: "wp-note wp-note-error", role: "status" }, (brokenHere.length === 1 ? nameOf(brokenHere[0]) + " can't be shown: the window can't read it as a picture, so rotation passes over it." : brokenHere.map(nameOf).join(", ") + " can't be shown: the window can't read them as pictures, so rotation passes over them.") + " Replace the file in the collection's folder, or move it to the Trash."),
						brokenHere.slice(0, 3).map((f) => h(Btn, { key: f, variant: "ghost", icon: IC.trash(14), onClick: () => uiS.set((u) => ({ ...u, confirm: { file: f, collection: coll } })) }, `Move ${nameOf(f)} to the Trash`))),
					h("p", { className: "wp-meta" }, coll ? "Click a picture to keep it; click it again to go back to rotating. Each collection is a folder in Wallpaper's picture folder." : "No collections yet. Make one with New collection, then add pictures to it."),
					st.skipped?.length > 0 && h("p", { className: "wp-meta" }, "Not in the panel: " + st.skipped.slice(0, 3).join("; ") + (st.skipped.length > 3 ? "; and " + (st.skipped.length - 3) + " more" : "") + "."),
					h(Note, { section: "pictures" })),
				h("section", { className: "wp-field", "aria-labelledby": "wp-h-colours" },
					h("div", { className: "wp-row wp-between wp-wrap" },
						h("h3", { id: "wp-h-colours", className: "wp-h" }, "Colours"),
						h("div", { className: "wp-row wp-wrap" },
							h(Seg, { id: "wp-slot", value: slot, label: "A colour applies to", onChange: setSlot, options: [{ value: "both", label: "Both" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }] }),
							h(Check, { checked: !!p.wallpaperGradient, onChange: (v) => savePrefs({ wallpaperGradient: !!v }), label: "Gradient" }))),
					h("div", { className: "wp-swatches", role: "group", "aria-label": "Colours" + (slot === "both" ? "" : " for " + slot + " mode"), onKeyDown: rove },
						swatches.map((sw, i) => h("button", { key: sw.id, type: "button", "data-wallpaper-rove": "", tabIndex: i === swatchStop ? 0 : -1, className: "wp-swatch", title: sw.name, "aria-label": sw.name, "aria-pressed": selected(sw),
							style: { background: slot === "both" && sw.light !== sw.dark ? `linear-gradient(135deg, ${sw.light} 50%, ${sw.dark} 50%)` : p.wallpaperGradient ? colourCss(tone(sw), true) : tone(sw) }, onClick: () => pickColour(sw) }))),
					h("div", { className: "wp-row wp-wrap" },
						h(Btn, { variant: "ghost", icon: IC.plus(14), "data-wallpaper-back": "colour", onClick: () => colourRef.current?.click() }, "Add a colour"),
						customOn && h(Btn, { variant: "ghost", onClick: () => removeColour(customOn) }, "Remove " + customOn.name),
						h("input", { ref: colourRef, type: "color", className: "wp-file", tabIndex: -1, "aria-hidden": "true", defaultValue: "#4f6fb3", onChange: (e) => addColour(e.target.value) })),
					h(Note, { section: "colours" })),
				h("section", { className: "wp-field", "aria-labelledby": "wp-h-rotation" },
					h("div", { className: "wp-row wp-between" },
						h("h3", { id: "wp-h-rotation", className: "wp-h" }, kind === "colour" ? "Rotate through the colours" : shown?.coll ? "Rotate through " + shown.coll : "Rotate"),
						h(Toggle, { checked: rotating, onChange: setRotate, label: "Rotate" })),
					h("div", { className: cx("wp-slider", !rotating && "wp-off") },
						h("label", { htmlFor: "wp-s-rotate" }, "Every"),
						h("input", { id: "wp-s-rotate", type: "range", min: 0, max: ROTATE_STOPS.length - 1, step: 1, disabled: !rotating, value: stopIndex, "aria-valuetext": "every " + rotateLabel(ROTATE_STOPS[stopIndex]), onChange: (e) => savePrefs({ wallpaperPinned: null, wallpaperRotate: null, wallpaperRotateMin: ROTATE_STOPS[Number(e.target.value)] }, true) }),
						h("output", { htmlFor: "wp-s-rotate", className: "wp-num" }, rotateLabel(ROTATE_STOPS[stopIndex]))),
					h("p", { className: "wp-meta" }, kind === "image" && !shown ? "Nothing to rotate yet: add pictures, or pick a colour." : rotating ? "A new " + (kind === "colour" ? "colour" : "picture") + " every " + rotateLabel(ROTATE_STOPS[stopIndex]) + "." : "Off: what shows now stays."),
					h(Note, { section: "rotation" })),
				h("section", { className: "wp-field", "aria-labelledby": "wp-h-glass" },
					h("h3", { id: "wp-h-glass", className: "wp-h" }, "Wallpaper and glass"),
					h(Slider, { p, k: "wallpaperOpacity", label: "Wallpaper opacity", unit: "%" }),
					h(Slider, { p, k: "wallpaperFrost", label: "Wallpaper frost", unit: "px" }),
					h(Slider, { p, k: "glassBlur", label: "Glass blur", unit: "px" }),
					h(Slider, { p, k: "glassTint", label: "Glass tint", unit: "%" }),
					h(Note, { section: "glass" })),
				h("section", { className: "wp-field", "aria-labelledby": "wp-h-motion" },
					h("div", { className: "wp-row wp-between" },
						h("h3", { id: "wp-h-motion", className: "wp-h" }, "Motion"),
						h(Toggle, { checked: p.motion !== false, onChange: (v) => savePrefs({ motion: !!v }), label: "Motion" })),
					h("p", { className: "wp-meta" }, "Off stops the wallpaper's crossfade and every transition on the page, and asks other plugins to stop theirs. The system's Reduce motion always stops Wallpaper's own."),
					h(Note, { section: "motion" })),
				h("section", { className: "wp-field", "aria-labelledby": "wp-h-headline" },
					h("h3", { id: "wp-h-headline", className: "wp-h" }, h("label", { htmlFor: "wp-headline" }, "Headline")),
					h("input", { id: "wp-headline", className: "wp-input", value: headline ?? p.headline, maxLength: HEADLINE_MAX, placeholder: "Empty shows DSH's own",
						onChange: (e) => setHeadline(e.target.value), onBlur: (e) => saveHeadline(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); saveHeadline(e.currentTarget.value); } } }),
					h("p", { className: "wp-meta" }, "Shown on the new chat page in place of DSH's own words, up to " + HEADLINE_MAX + " characters."),
					h(Note, { section: "headline" })));
		};
		const WallpaperPanel = ({ ctx }) => {
			const u = useStore(uiS);
			useEffect(() => { if (u.panel) loadState().catch(() => stateS.set((s) => ({ ...s, offline: true }))); }, [u.panel]);
			if (!u.panel) return null;
			const close = () => uiS.set((x) => ({ ...x, panel: false, note: null }));
			return h(ui.Modal, { open: true, onClose: close, title: "Wallpaper and glass", closeLabel: "Close", className: "wp-panel", contentClassName: "wp-panel-content" }, h(PanelBody, { ctx }));
		};
		// The one action here that removes something: a picture goes to the macOS Trash, where Finder can put it back.
		const ConfirmDialog = () => {
			const d = useStore(uiS).confirm;
			const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
			useEffect(() => { setBusy(false); setErr(null); }, [d]);
			if (!d) return null;
			const close = () => { if (!busy) uiS.set((x) => ({ ...x, confirm: null })); };
			const go = async () => {
				setBusy(true); setErr(null);
				try {
					const r = await api("wallpaper-remove", { collection: d.collection, file: d.file });
					await loadState().catch(() => {});
					uiS.set((x) => ({ ...x, confirm: null }));
					note("pictures", `Moved ${nameOf(d.file)} to the Trash${r.trashed && r.trashed !== d.file ? ` as ${r.trashed}` : ""}. To keep it after all, drag it from the Trash back into the collection's folder.`);
				} catch (e) { setBusy(false); setErr("Not moved: " + reasonOf(e) + "."); }
			};
			return h(ui.Modal, { open: true, onClose: close, title: "Move this picture to the Trash?", closeLabel: "Cancel", className: "wp-confirm",
				footer: h(Fragment, null,
					h(Btn, { variant: "outline", disabled: busy, onClick: close, "data-modal-autofocus": "" }, "Cancel"),
					h(Btn, { variant: "primary", disabled: busy, onClick: go }, busy ? "Moving…" : "Move to the Trash")) },
				h("p", { className: "wp-meta wp-confirm-body" }, `${nameOf(d.file)} leaves ${d.collection} and goes to the macOS Trash.`),
				err && h("p", { className: "wp-note wp-note-error", role: "alert" }, err));
		};
		const ToastSeat = () => {
			const t = useStore(uiS).toast;
			if (!t || !isPart(ui.Toast)) return null;
			return h(ui.Toast, { key: t.at, text: t.text, holdMs: 6000, onDone: () => uiS.set((x) => (x.toast?.at === t.at ? { ...x, toast: null } : x)) });
		};
		// The way in: one button in the sidebar footer, next to DSH's own footer actions.
		const WallpaperButton = () => h("button", { type: "button", className: "wp-footbtn", title: "Wallpaper and glass", "aria-label": "Wallpaper and glass", "aria-haspopup": "dialog", onClick: () => uiS.set((x) => ({ ...x, panel: true })) }, IC.image(18));

		// ------------------------------------------------------------ one watch on DSH's page
		// One MutationObserver for everything this plugin follows: DSH's colour mode (an attribute on <body>) and DSH's
		// panel list coming and going. Each listener does nothing unless what it cares about changed.
		const watchers = new Set();
		let observer = null;
		const watch = (fn) => {
			watchers.add(fn);
			if (!observer && typeof MutationObserver === "function") {
				observer = new MutationObserver((records) => watchers.forEach((w) => { try { w(records); } catch (e) { console.warn("wallpaper:", e); } }));
				observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-ds-dark-theme"] });
			}
			return () => { watchers.delete(fn); if (!watchers.size && observer) { observer.disconnect(); observer = null; } };
		};

		// ------------------------------------------------------------ the panel tiles' fold
		// DSH's panel list, laid out as tiles by the look, folds to one row of its icons and back. The choice is kept in
		// the window's storage, so it holds across reloads. DSH has no seat in its list, so the fold button is the
		// plugin's own element there (a portal), last in the list, and it goes with the plugin.
		const FOLD_KEY = PACKAGE + "/tiles-folded";
		const PANEL_LIST = '[data-slot="sidebar"] nav[class*="_panelList"]';
		const foldS = createStore((() => { try { return window.localStorage?.getItem(FOLD_KEY) === "1"; } catch { return false; } })());
		const setFolded = (folded) => {
			foldS.set(folded);
			try { if (folded) window.localStorage?.setItem(FOLD_KEY, "1"); else window.localStorage?.removeItem(FOLD_KEY); } catch {}
		};
		const usePanelList = (own) => {
			const find = () => document.querySelector(PANEL_LIST);
			const [nav, setNav] = useState(find);
			useEffect(() => {
				let current = find();
				setNav(current);
				return watch((records) => {
					if (!records.some((r) => r.type === "childList")) return;
					if (current?.isConnected) {
						const el = own.current;
						if (el && el.parentNode === current && current.lastElementChild !== el) current.appendChild(el);
						return;
					}
					const next = find();
					if (next !== current) { current = next; setNav(next); }
				});
			}, []);
			return nav;
		};
		const TilesFold = () => {
			const folded = useStore(foldS);
			const own = useRef(null);
			const nav = usePanelList(own);
			useEffect(() => { document.body.classList.toggle("wp-tiles-folded", folded); }, [folded]);
			useEffect(() => {
				// Another window of DSH folded or unfolded them.
				const onStorage = (e) => { if (e.key === FOLD_KEY) foldS.set(e.newValue === "1"); };
				window.addEventListener("storage", onStorage);
				return () => { window.removeEventListener("storage", onStorage); document.body.classList.remove("wp-tiles-folded"); };
			}, []);
			if (!nav) return null;
			return ReactDOM.createPortal(h("button", { ref: own, type: "button", className: "wp-tiles-fold", "aria-expanded": !folded, "aria-label": "Panel tiles", title: folded ? "Unfold the panel tiles" : "Fold the panel tiles", onClick: () => setFolded(!folded) }, folded ? IC.down(14) : IC.up(14)), nav);
		};

		// ------------------------------------------------------------ the look (wall, glass, headline)
		const installLook = () => {
			document.querySelectorAll(`style[data-plugin="${PACKAGE}"],#wp-wall`).forEach((el) => el.remove()); // a reload that skipped its clean-up
			const style = document.createElement("style");
			style.setAttribute("data-plugin", PACKAGE);
			style.setAttribute("data-plugin-css", PACKAGE + "/client.css");
			style.textContent = CSS;
			document.head.appendChild(style);
			const wall = document.createElement("div");
			wall.id = "wp-wall"; wall.setAttribute("aria-hidden", "true");
			wall.innerHTML = '<div class="wp-wl"></div><div class="wp-wl"></div><div class="wp-scrim"></div><div class="wp-veil"></div>';
			document.body.prepend(wall);
			document.body.classList.add("wp-on");
			darkS.set(isDark());
			let front = 0; let shownKey = null; let loading = null; let cells = null;
			// The veil for each mode, from the picture on the wall (or the colour's tone in that mode), the tint and the
			// wallpaper's opacity; the style sheet takes the one for DSH's mode.
			const setVeil = (st) => {
				const p = st.prefs;
				const t = p.glassTint / 100; const op = p.wallpaperOpacity / 100;
				for (const mode of ["light", "dark"]) {
					let c = cells;
					if (p.wallpaperKind === "colour") { const w = currentWallpaper(st, mode === "dark"); c = w ? colourCells(w.colour, p.wallpaperGradient) : null; }
					if (c) wall.style.setProperty("--wp-veil-" + mode, String(veilFor(c, mode, t, op)));
				}
			};
			const apply = () => {
				const st = stateS.get();
				const p = st.prefs;
				const b = document.body;
				b.style.setProperty("--wp-blur", p.glassBlur + "px");
				b.style.setProperty("--wp-tint", String(p.glassTint / 100));
				wall.style.setProperty("--wp-op", String(p.wallpaperOpacity / 100));
				wall.style.setProperty("--wp-frost", p.wallpaperFrost + "px");
				b.classList.toggle("wp-still", p.motion === false);
				b.classList.toggle("wp-headline", !!p.headline);
				if (p.headline) b.style.setProperty("--wp-headline", cssString(p.headline));
				else b.style.removeProperty("--wp-headline");
				setVeil(st);
				const wp = currentWallpaper(st, darkS.get(), Date.now(), cantShowS.get());
				if (!wp || wp.key === shownKey || wp.key === loading) return;
				const show = (bg, picture) => {
					const layers = wall.querySelectorAll(".wp-wl");
					front = 1 - front;
					layers[front].style.backgroundImage = bg;
					layers[front].classList.toggle("colour", wp.kind === "colour");
					layers[front].classList.add("on"); layers[1 - front].classList.remove("on");
					shownKey = wp.key;
					cells = picture;
					setVeil(stateS.get());
				};
				if (wp.kind === "colour") return show(wp.css, null);
				// The new picture shows only once it has loaded, so the wall never flashes empty. One that can't load is
				// marked as such (the panel says so), and the wall moves on to the next picture that can.
				loading = wp.key;
				const img = new Image();
				img.onload = () => { if (loading === wp.key) { loading = null; show(`url("${wp.url}")`, pictureCells(img)); } };
				img.onerror = () => { if (loading === wp.key) { loading = null; cantShow(wp.key); } };
				img.src = wp.url;
			};
			const unsub = stateS.sub(apply);
			const unsubCant = cantShowS.sub(apply);
			apply();
			const tick = setInterval(apply, 60000);
			const onVisible = () => { if (document.visibilityState === "visible") apply(); };
			document.addEventListener("visibilitychange", onVisible);
			// A colour's tone follows the colour mode: look again when DSH switches between light and dark.
			const unwatch = watch((records) => {
				if (!records.some((r) => r.type === "attributes" && r.target === document.body)) return;
				if (darkS.get() !== isDark()) { darkS.set(isDark()); apply(); }
			});
			return () => {
				unsub(); unsubCant(); clearInterval(tick); unwatch(); document.removeEventListener("visibilitychange", onVisible);
				style.remove(); wall.remove();
				document.body.classList.remove("wp-on", "wp-still", "wp-headline");
				["--wp-blur", "--wp-tint", "--wp-headline"].forEach((k) => document.body.style.removeProperty(k));
			};
		};
		// Settings from the host; a host that isn't up yet is asked again a few times (waits in ms) before the window
		// says so in DSH's toast.
		const RETRIES = [0, 1000, 3000, 8000];
		const startState = () => {
			let stopped = false; let timer = 0;
			const attempt = (n) => {
				loadState().catch((e) => {
					if (stopped) return;
					if (n + 1 < RETRIES.length) { timer = setTimeout(() => attempt(n + 1), RETRIES[n + 1]); return; }
					toast("Wallpaper couldn't load its settings, so it shows its defaults: " + reasonOf(e) + ".");
				});
			};
			attempt(0);
			return () => { stopped = true; clearTimeout(timer); };
		};

		// ------------------------------------------------------------ the style sheet
		// Every rule on DSH's elements starts at a data-slot outlet and steps by structure (DESIGN.md section 8), and
		// sits under body.wp-on, so switching off removes it all. Colours are DSH's tokens; the glass grounds are
		// DESIGN.md's recipe (tint for side columns, tint + .2 for the open chat, near-opaque under reduced
		// transparency). Nothing here hides DSH's text, icons or controls; the hero text gives way only while a
		// headline is set.
		const S = {
			frame: '[data-slot="root"] > [class*="_frame"]',
			cols: '[data-slot="root"] > [class*="_frame"] > :is([class*="_sidebarCol"],[class*="_centerCol"],[class*="_rightbarCol"])',
			handle: '[data-slot="root"] > [class*="_frame"] > [class*="_handle"][data-side]',
			sidebar: '[data-slot="sidebar"] > div',
			chat: '[data-slot="main.conversation"] > div',
			chatOpen: '[data-slot="main.conversation"] > div:has([data-slot="conversation.session"] [class*="_viewArea"])',
			chatBody: '[data-slot="main.conversation"] > div > [class*="_body"]',
			chatHeader: '[data-slot="main.conversation"] [data-slot="conversation.header"] header',
			dock: '[data-slot="rightbar.session"] > [class*="_panel"]',
			dockClosed: '[data-slot="root"] > [class*="_frame"][data-rightbar-collapsed="true"] [data-slot="rightbar.session"] > [class*="_panel"]',
			composer: '[data-slot="conversation.composer.bar"] :is([data-composer-card],[class$="_card"],[class*="_card "])',
			hero: '[data-slot="main.conversation"] [class*="_composerHero"]',
			heroText: '[data-slot="main.conversation"] [class*="_titleGroup"] > span:first-child',
			panelList: '[data-slot="sidebar"] nav[class*="_panelList"]',
			rail: '[data-slot="sidebar"] > div[class*="_collapsed"]',
		};
		const DARK_GLASS = "14,18,17"; const LIGHT_GLASS = "250,250,246"; const DARK_CONV = "10,13,12";
		const BLUR = "blur(var(--wp-blur,22px))";
		const glass = (sel, { conv = false, saturate = true } = {}) => {
			const a = conv ? "calc(var(--wp-tint,.55) + .2)" : "var(--wp-tint,.55)";
			const rt = conv ? "max(.95,calc(var(--wp-tint,.55) + .2))" : "max(.9,var(--wp-tint,.55))";
			const f = BLUR + (saturate ? " saturate(140%)" : "");
			return `body.wp-on ${sel}{background:rgba(${conv ? DARK_CONV : DARK_GLASS},${a})!important;-webkit-backdrop-filter:${f};backdrop-filter:${f}}
body.wp-on:not([data-ds-dark-theme]) ${sel}{background:rgba(${LIGHT_GLASS},${a})!important}
@media (prefers-reduced-transparency:reduce){body.wp-on ${sel}{background:rgba(${conv ? DARK_CONV : DARK_GLASS},${rt})!important}body.wp-on:not([data-ds-dark-theme]) ${sel}{background:rgba(${LIGHT_GLASS},${rt})!important}}`;
		};
		const OWN = ".wp-footbtn,.wp-tiles-fold,.wp-panel,.wp-confirm";
		const CSS = `
#wp-wall{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;background:#0a0d0c}
body:not([data-ds-dark-theme]) #wp-wall{background:#e7e7e2}
#wp-wall .wp-wl{position:absolute;inset:-32px;background-size:cover;background-position:center;filter:blur(var(--wp-frost,4px));opacity:0;transition:opacity 1.1s ease}
#wp-wall .wp-wl.on{opacity:var(--wp-op,.9)}
#wp-wall .wp-wl.colour{filter:none}
#wp-wall .wp-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(6,8,8,.35),rgba(6,8,8,.15) 40%,rgba(6,8,8,.45))}
body:not([data-ds-dark-theme]) #wp-wall .wp-scrim{background:linear-gradient(180deg,rgba(255,255,255,.28),rgba(255,255,255,.1) 40%,rgba(255,255,255,.32))}
/* the veil: as much of the mode's own ground as DSH's words need over this picture (set by the look, per mode) */
#wp-wall .wp-veil{position:absolute;inset:0;background:rgb(10,13,12);opacity:var(--wp-veil-dark,0);transition:opacity 1.1s ease}
body:not([data-ds-dark-theme]) #wp-wall .wp-veil{background:rgb(250,250,246);opacity:var(--wp-veil-light,0)}
body.wp-on #root{position:relative;z-index:1}
/* DSH's frame, its columns and the open chat's own ground go clear, so the wall shows through */
body.wp-on ${S.frame},body.wp-on ${S.cols},body.wp-on ${S.chat},body.wp-on ${S.chatBody}{background:transparent!important;border:0!important;box-shadow:none!important}
body.wp-on ${S.chatBody}{margin:0!important}
body.wp-on [data-slot="root"] > [class*="_frame"] > :is([class*="_sidebarCol"],[class*="_rightbarCol"]){overflow:hidden}
body.wp-on ${S.handle}{background:transparent!important;border:0!important;box-shadow:none!important}
body.wp-on ${S.handle}::before,body.wp-on ${S.handle}::after{display:none!important}
/* the sidebar: one frosted card */
${glass(S.sidebar)}
body.wp-on ${S.sidebar}{border:1px solid var(--dsw-alias-border-l2)!important;border-radius:18px;margin:12px 0 12px 12px;height:calc(100% - 24px)!important;width:calc(100% - 12px)!important;box-sizing:border-box;overflow:hidden}
body.wp-on ${S.sidebar} > *{min-width:0;max-width:100%}
body.wp-on [data-slot="sidebar"] [class*="_footArea"]{border:0!important}
body.wp-on [data-slot="sidebar"] [class*="_footArea"]::before,body.wp-on [data-slot="sidebar"] [class*="_footArea"]::after{display:none!important}
/* DSH's session list fades into its opaque ground at the bottom; on glass that fade is a band, so it goes */
body.wp-on [data-slot="sidebar.workspaces"] [class*="_fade"]{background:none!important}
/* the same in the open chat: DSH's composer seat fades the chat into its opaque ground behind the composer; on glass
   that is a band across the bottom of the chat, so it goes too */
body.wp-on [data-slot="main.conversation"] [class*="_composerSeat"]{background:none!important}
body.wp-on ${S.rail}{padding-left:4px!important;padding-right:4px!important;align-items:center}
/* the open chat: a card at tint + .2 (the new-chat page stays on the wall) */
body.wp-on ${S.chat}{margin:12px;height:calc(100% - 24px)!important;border-radius:18px;box-sizing:border-box;overflow:hidden}
${glass(S.chatOpen, { conv: true, saturate: false })}
body.wp-on ${S.chatOpen}{border:1px solid var(--dsw-alias-border-l2)!important}
body.wp-on ${S.chatHeader}{background:transparent!important;border:0!important;box-shadow:none!important}
body.wp-on ${S.chatOpen} [data-slot="conversation.header"] header{background-image:linear-gradient(var(--dsw-alias-border-l2),var(--dsw-alias-border-l2))!important;background-size:calc(100% - 32px) 1px!important;background-position:center bottom!important;background-repeat:no-repeat!important}
/* the right dock: a card while it is open */
body.wp-on ${S.dock} [class*="_tabHost"]{background:transparent!important;border:0!important}
${glass(S.dock)}
body.wp-on ${S.dock}{border:1px solid var(--dsw-alias-border-l2)!important;border-radius:18px;margin:12px 12px 12px 0;height:calc(100% - 24px)!important;width:calc(100% - 12px)!important;box-sizing:border-box;overflow:hidden}
body.wp-on ${S.dockClosed}{border:0!important;background:transparent!important;margin:0!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
/* the composer: frosted, with DSH's accent while it has the focus */
${glass(S.composer)}
body.wp-on ${S.composer}{border:1px solid var(--dsw-alias-border-l2)!important;border-radius:22px!important;transition:border-color .2s ease}
body.wp-on ${S.composer}:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent)!important}
/* the headline over DSH's hero text, while one is set */
body.wp-on ${S.hero}{container-type:inline-size}
body.wp-on.wp-headline ${S.heroText}{font-size:0!important;line-height:0;display:block;flex:1 1 auto;min-width:0;width:100%;text-align:center}
body.wp-on.wp-headline ${S.heroText}::after{content:var(--wp-headline);font-family:var(--dsw-font-family);font-size:clamp(30px,4.2vw,52px);line-height:1.04;font-weight:600;letter-spacing:-.035em;color:var(--dsw-alias-label-primary);text-shadow:0 2px 24px rgba(0,0,0,.35);display:block;width:min(100%,900px);margin-inline:auto;text-align:center;text-wrap:balance;white-space:normal;overflow-wrap:anywhere}
body.wp-on.wp-headline:not([data-ds-dark-theme]) ${S.heroText}::after{text-shadow:0 2px 24px rgba(255,255,255,.55)}
@container (max-width: 640px){body.wp-on.wp-headline ${S.heroText}::after{font-size:clamp(20px,6.4cqw,40px)}}
/* DSH's panel list as tiles, three to a row. Every entry stays, in DSH's order; only the layout changes. */
body.wp-on ${S.panelList}{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:4px!important;margin:0 0 10px!important;width:auto!important;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l1)!important;box-sizing:border-box}
body.wp-on ${S.panelList} > *{display:contents}
body.wp-on ${S.panelList} button[class*="_panelRow"]{display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center;gap:3px;min-width:0;width:auto!important;min-height:52px;height:auto!important;padding:5px 3px!important;margin:0!important;border-radius:9px;font:var(--dsw-font-xxxs-11);color:color-mix(in srgb,var(--dsw-alias-label-secondary) 80%,var(--dsw-alias-label-primary));overflow:hidden}
body.wp-on ${S.panelList} button[class*="_panelRow"]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
body.wp-on ${S.panelList} button[class*="_panelRow"] [class*="_panelTitle"]{margin:0!important;font:var(--dsw-font-xxxs-11);max-width:100%;text-align:center;white-space:normal;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
body.wp-on ${S.panelList} button[aria-current="page"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
body.wp-on ${S.rail} nav[class*="_panelList"]{grid-template-columns:1fr;padding:3px!important;width:100%!important}
body.wp-on ${S.rail} nav[class*="_panelList"] [class*="_panelTitle"]{display:none!important}
body.wp-on ${S.rail} nav[class*="_panelList"] button[class*="_panelRow"]{min-height:38px}
/* the tiles' fold button (the plugin's own, last in DSH's list), at the tiles' lower right; the rail has none */
body.wp-on ${S.panelList} > .wp-tiles-fold{order:1;grid-column:-2/-1;justify-self:end;align-self:end;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin:0;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 75%,var(--dsw-alias-label-primary));cursor:pointer;transition:background var(--ds-transition-duration-fast,.1s) ease,color var(--ds-transition-duration-fast,.1s) ease}
body.wp-on ${S.panelList} > .wp-tiles-fold:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
body.wp-on ${S.panelList} > .wp-tiles-fold:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
body.wp-on ${S.rail} nav[class*="_panelList"] > .wp-tiles-fold{display:none}
/* folded: one row of DSH's icons (it wraps when they don't fit), no names; the open page keeps its fill */
body.wp-on.wp-tiles-folded ${S.sidebar}:not([class*="_collapsed"]) nav[class*="_panelList"]{display:flex!important;flex-direction:row!important;flex-wrap:wrap;align-items:center;justify-content:flex-start;gap:2px;padding:3px!important}
body.wp-on.wp-tiles-folded ${S.sidebar}:not([class*="_collapsed"]) nav[class*="_panelList"] button[class*="_panelRow"]{flex:none;width:34px!important;min-height:30px;height:30px!important;padding:0!important;gap:0}
body.wp-on.wp-tiles-folded ${S.sidebar}:not([class*="_collapsed"]) nav[class*="_panelList"] [class*="_panelTitle"]{display:none!important}
body.wp-on.wp-tiles-folded ${S.sidebar}:not([class*="_collapsed"]) nav[class*="_panelList"] > .wp-tiles-fold{margin-left:auto;align-self:center}
/* the footer button */
.wp-footbtn{width:32px;height:32px;border-radius:var(--dsw-radius-md,12px);display:inline-flex;align-items:center;justify-content:center;flex:none;background:transparent;border:0;padding:0;color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 75%,var(--dsw-alias-label-primary));cursor:pointer;transition:background var(--ds-transition-duration-fast,.1s) ease,color var(--ds-transition-duration-fast,.1s) ease}
.wp-footbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wp-footbtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.wp-i{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
/* the panel: DSH's Modal; inside it DSH's parts and tokens, and the plugin's own pictures and swatches */
.wp-panel{width:min(620px,calc(100vw - 32px))!important;max-width:none!important}
.wp-panel .wp-panel-content{max-height:calc(100vh - 96px);overflow-y:auto}
.wp-panel,.wp-confirm{font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}
.wp-field{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.wp-field:first-child{border-top:0;padding-top:0}
.wp-h{margin:0;font:var(--dsw-font-xs-strong-13,500 13px/20px var(--dsw-font-family));color:var(--dsw-alias-label-primary)}
.wp-h label{font:inherit;color:inherit}
.wp-row{display:flex;align-items:center;gap:8px;min-width:0}
.wp-between{justify-content:space-between}
.wp-wrap{flex-wrap:wrap}
.wp-meta{margin:0;font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));color:var(--dsw-alias-label-secondary)}
.wp-note{margin:0;font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));color:var(--dsw-alias-label-primary)}
.wp-note-error{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary))}
.wp-num{font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);text-align:right}
.wp-input{width:100%;box-sizing:border-box;min-height:36px;padding:6px 10px;border-radius:var(--dsw-radius-md,12px);background:transparent;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family))}
.wp-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wp-rename{width:200px;min-height:32px;padding:4px 8px}
.wp-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.wp-slider{display:grid;grid-template-columns:minmax(96px,150px) minmax(0,1fr) 56px;align-items:center;gap:10px;min-height:36px;font:var(--dsw-font-xs-13,13px/20px var(--dsw-font-family))}
.wp-slider input{accent-color:var(--dsw-alias-state-business-primary);min-width:0}
.wp-slider input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.wp-slider.wp-off{opacity:.5}
.wp-check{display:inline-flex;align-items:center;gap:8px;font:var(--dsw-font-xs-13,13px/20px var(--dsw-font-family))}
.wp-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;padding:4px;margin:-4px;border-radius:var(--dsw-radius-md,12px);border:1px dashed transparent}
.wp-thumbs.wp-drop{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wp-empty{grid-column:1/-1;padding:12px 0}
.wp-thumb{position:relative;padding:0;margin:0;border-radius:var(--dsw-radius-sm,8px);overflow:hidden;border:2px solid transparent;background:var(--dsw-alias-bg-layer-2,#2c2c2e);cursor:pointer;aspect-ratio:16/9;box-sizing:border-box}
.wp-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.wp-thumb.wp-shown{border-color:var(--dsw-alias-state-business-primary)}
.wp-thumb.wp-broken{cursor:default;border:1px dashed var(--dsw-alias-border-l3)}
.wp-thumb.wp-broken img{visibility:hidden}
.wp-thumb-broken{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:4px;font:var(--dsw-font-xxxs-11,11px/16px var(--dsw-font-family));color:var(--dsw-alias-label-secondary);text-align:center}
.wp-thumb[aria-pressed="true"]::after{content:"";position:absolute;right:4px;bottom:4px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1,#fff)}
.wp-thumb:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.wp-swatches{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:2px}
.wp-swatch{width:30px;height:30px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);padding:0;margin:0;cursor:pointer;box-sizing:border-box;flex:none}
.wp-swatch[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}
.wp-swatch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.wp-confirm-body{font:var(--dsw-font-xs-13,13px/20px var(--dsw-font-family))}
@media (max-width:560px){.wp-slider{grid-template-columns:minmax(0,1fr) 56px}.wp-slider input{grid-column:1/-1;grid-row:2}}
/* motion: the crossfade and transitions stop under Motion off (every transition on the page) and reduced motion */
body.wp-still #wp-wall .wp-wl,body.wp-still #wp-wall .wp-veil,body.wp-still *,body.wp-still *::before,body.wp-still *::after{transition:none!important}
body.wp-still :is(${OWN}),body.wp-still :is(${OWN})::before,body.wp-still :is(${OWN})::after,body.wp-still :is(${OWN}) *,body.wp-still :is(${OWN}) *::before,body.wp-still :is(${OWN}) *::after{animation:none!important}
@media (prefers-reduced-motion:reduce){#wp-wall .wp-wl,#wp-wall .wp-veil,:is(${OWN}),:is(${OWN})::before,:is(${OWN})::after,:is(${OWN}) *,:is(${OWN}) *::before,:is(${OWN}) *::after{animation:none!important;transition:none!important}}
@media (prefers-reduced-motion:reduce){body.wp-on ${S.composer}{transition:none!important}}
`;

		// ------------------------------------------------------------ apply
		// Each step is caught on its own: one that throws is logged in the window's console and the rest still run.
		function apply(ctx) {
			const step = (label, fn) => ctx.effect(() => {
				try { return fn(); } catch (e) { console.warn(`wallpaper: ${label} failed`, e); return undefined; }
			}, "wallpaper: " + label);
			step("settings", startState);
			step("wallpaper and glass", installLook);
			try {
				const reg = (slot, opts, comp) => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ...opts }, comp));
				const panel = isPart(ui.Modal); // a DSH without its Modal part gets the look without the panel
				if (panel) reg("sidebar.footer.action", { id: PACKAGE + ":open", order: 90 }, WallpaperButton);
				reg("shell.overlay", { id: PACKAGE + ":overlays", order: 40, inject: () => ({ ctx }) }, (props) => h(Fragment, null, panel && h(WallpaperPanel, props), panel && h(ConfirmDialog, null), h(ToastSeat, null), h(TilesFold, null)));
			} catch (e) { console.warn("wallpaper: slots failed", e); }
		}
		return { name: PACKAGE, inject: ["slots"], apply, logic: { DEFAULT_PREFS, RANGES, HEADLINE_MAX, ROTATE_STOPS, COLOUR_PRESETS, RETRIES, prefsOf, rotateMinOf, rotateLabel, colourCss, swatchesOf, currentWallpaper, cssString, nameOf, savePrefs, veilFor, colourCells, contrastOf, mixRgb, TEXT, GLASS_RGB, VEIL_RGB, PanelBody, stores: { stateS, uiS, cantShowS }, SELECTORS: S, CSS } };
	}
});
