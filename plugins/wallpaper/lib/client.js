// Wallpaper and glass — client bundle (hand-written, no build step).
// Loaded by DSH's module loader; React comes from the shared platform modules.
// This plugin only changes how DSH looks: the wallpaper, colours, frosted glass, motion and the headline.
// It never hides or rearranges DSH's controls. Its skins section repaints the grounds of named surfaces that
// bring their own opaque page (a plugin's, or DSH's own), so the glass reads the same there; it changes no
// content. Other plugins may follow the look through what it publishes on <body>: --wp-blur, --wp-tint, and
// the wp-still class while Motion is off.
window.__ModuleLoader__.load({
	id: "dsh-plugin-wallpaper",
	factory: (require) => {
		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;
		const { useState, useEffect, useRef, useSyncExternalStore, Fragment } = React;
		const NS = "wallpaper";
		const API = (typeof window !== "undefined" && window.__WALLPAPER_API__) || "/api/wallpaper/"; // dev hook: point a test page at a local server
		const OLD_LOCALE_ID = "en-x-fleet"; // the locale an early Fleet Shell build switched DSH to (see installHeadline)

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
		const DEFAULT_PREFS = { headline: "Quit fucking around and do something", wallpaperCollection: "cars", wallpaperPinned: null, wallpaperRotate: null, wallpaperRotateMin: 60, wallpaperOpacity: 90, wallpaperFrost: 4, glassBlur: 22, glassTint: 55, motion: true };
		// Wallpaper rotation stops in minutes; prefs.wallpaperRotate is "off" or null (rotate).
		const ROTATE_STOPS = [1, 5, 15, 30, 60, 120, 240, 480, 720, 1440];
		const rotateMinOf = (p) => (p?.wallpaperRotate === "off" ? 0 : typeof p?.wallpaperRotate === "string" ? (p.wallpaperRotate === "daily" ? 1440 : 60) : (Number(p?.wallpaperRotateMin) || 60));
		const rotateLabel = (m) => (m >= 60 ? "Every " + (m / 60) + " h" : "Every " + m + " min");
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
		const isDark = () => document.body.hasAttribute("data-ds-dark-theme");
		const colourCss = (c, gradient) => (gradient ? `linear-gradient(160deg, color-mix(in oklab, ${c} 78%, white) 0%, ${c} 52%, color-mix(in oklab, ${c} 62%, black) 100%)` : `linear-gradient(${c}, ${c})`);
		const swatchesOf = (p) => [...COLOUR_PRESETS, ...(p?.wallpaperColours || []).map((hex) => ({ id: hex, name: hex, light: hex, dark: hex, custom: true }))];
		// Until the host answers, the look uses the defaults (offline: true), so the glass is right from the first frame.
		const stateS = createStore({ prefs: DEFAULT_PREFS, wallpapers: {}, offline: true });
		const uiS = createStore({ panel: false, toast: null, confirm: null });

		const api = async (path, body) => {
			const res = await fetch(API + path, body === undefined ? { credentials: "same-origin", cache: "no-store" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			const text = await res.text();
			try { return JSON.parse(text); } catch { return { error: text || "HTTP " + res.status }; }
		};
		const refresh = {
			state: () => api("state").then((v) => { if (!v.error) stateS.set(v); }).catch(() => {}),
		};
		const savePrefs = (prefs) => {
			stateS.set((s) => ({ ...(s || {}), prefs: { ...(s?.prefs || {}), ...prefs } }));
			return api("state", { prefs });
		};
		const toast = (text) => { const at = Date.now(); uiS.set((u) => ({ ...u, toast: { text, at } })); setTimeout(() => uiS.set((u) => (u.toast?.at === at ? { ...u, toast: null } : u)), 4000); };
		const confirmFirst = (d) => uiS.set((u) => ({ ...u, confirm: d }));
		const cx = (...a) => a.filter(Boolean).join(" ");

		// ------------------------------------------------------------ icons and small parts
		const svg = (paths, size = 18) => h("svg", { className: "wp-i", viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true" }, ...paths.map((d, i) => (typeof d === "string" ? h("path", { key: i, d }) : d)));
		const IC = {
			image: (s) => svg([h("rect", { key: "r", x: 3.5, y: 5, width: 17, height: 14, rx: 2 }), "M3.5 16l5-5 4 4 3-3 5 5"], s),
			plus: (s) => svg(["M12 5v14M5 12h14"], s),
			x: (s) => svg(["M6 6l12 12M18 6L6 18"], s),
			trash: (s) => svg(["M5 7h14M10 7V5h4v2", "M7 7l.9 12.1a1.5 1.5 0 001.5 1.4h5.2a1.5 1.5 0 001.5-1.4L17 7", "M10.5 11v6M13.5 11v6"], s),
		};
		const Pill = ({ onClick, children, on, quiet, title, disabled, label }) => h("button", { type: "button", className: cx("wp-pill", on && "on", quiet && "quiet"), onClick, title, disabled, "aria-label": label, "aria-pressed": on === undefined ? undefined : !!on }, children);
		const useEscape = (active, fn) => useEffect(() => {
			if (!active) return;
			const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); fn(); } };
			document.addEventListener("keydown", onKey, true);
			return () => document.removeEventListener("keydown", onKey, true);
		}, [active]);

		// ------------------------------------------------------------ the wallpaper panel (colour mode, pictures, colours, glass, motion, headline)
		const readImage = (file) => new Promise((resolve, reject) => { const fr = new FileReader(); fr.onerror = () => reject(new Error("could not read " + file.name)); fr.onload = () => resolve(fr.result); fr.readAsDataURL(file); });
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
		const uploadWallpapers = async (collection, files) => {
			const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
			if (!list.length) return toast("Drop JPEG, PNG, WebP or HEIC images.");
			let ok = 0; const errs = [];
			for (const f of list) {
				try {
					const data = await readImage(f);
					const shrunk = await shrinkImage(data);
					const r = await api("wallpaper-add", { collection, name: shrunk !== data ? f.name.replace(/\.[^.]+$/, "") + ".jpg" : f.name, data: shrunk });
					if (r.error) errs.push(r.error); else ok++;
				} catch (e) { errs.push(String(e?.message || e)); }
			}
			await refresh.state();
			toast(ok ? `Added ${ok} image${ok === 1 ? "" : "s"} to ${collection}.${errs.length ? ` ${errs.length} failed: ${errs[0]}` : ""}` : `Nothing added: ${errs[0] || "no images"}`);
		};
		const ColourModeRow = ({ ctx }) => {
			const theme = ctx?.get?.("theme");
			const [, setTick] = useState(0);
			const mode = theme?.snapshot?.preference ?? "system";
			const pick = (m) => { try { theme.setTheme(m); setTick((n) => n + 1); } catch (e) { toast("Couldn't change the colour mode: " + (e?.message || e)); } };
			if (!theme?.setTheme) return null;
			return h("div", { className: "wp-field" },
				h("span", { className: "wp-meta" }, "Colour mode"),
				h("div", { className: "wp-seg", role: "radiogroup", "aria-label": "Colour mode" }, [["dark", "Dark"], ["light", "Light"], ["system", "System"]].map(([k, l]) => h("button", { key: k, type: "button", role: "radio", "aria-checked": mode === k, className: cx("wp-segb", mode === k && "on"), onClick: () => pick(k) }, l))),
				h("span", { className: "wp-meta wp-small" }, "System follows macOS. This is DSH's own appearance setting, so DSH's screens change with the wallpaper and glass."));
		};
		const WallpaperPanel = ({ ctx }) => {
			const ui = useStore(uiS);
			const st = useStore(stateS);
			const [naming, setNaming] = useState(null); // { kind: "new" | "rename", value }
			const [dropping, setDropping] = useState(false);
			const [slot, setSlot] = useState("both");
			const fileRef = useRef(null);
			const colourRef = useRef(null);
			const close = () => uiS.set((u) => ({ ...u, panel: false }));
			useEscape(!!ui.panel && !ui.confirm, close);
			useEffect(() => { if (ui.panel) refresh.state(); }, [ui.panel]);
			if (!ui.panel || !st) return null;
			const p = st.prefs || {};
			const walls = st.wallpapers || {};
			const names = Object.keys(walls);
			const coll = walls[p.wallpaperCollection] ? p.wallpaperCollection : names.find((k) => walls[k].length) ?? names[0];
			const kind = p.wallpaperKind === "colour" ? "colour" : "image";
			const min = rotateMinOf(p);
			const rotating = min > 0 && !(kind === "image" && p.wallpaperPinned);
			const shown = currentWallpaper(st);
			const slider = (key, label, mn, mx, unit) => h("label", { className: "wp-slider" }, h("span", null, label), h("input", { type: "range", min: mn, max: mx, value: p[key] ?? 0, onChange: (e) => savePrefs({ [key]: Number(e.target.value) }) }), h("span", { className: "wp-mono wp-small" }, (p[key] ?? 0) + unit));
			const commitName = async (value) => {
				const v = String(value ?? "").trim(); const n = naming; setNaming(null);
				if (!v || !n || (n.kind === "rename" && v === coll)) return;
				const r = n.kind === "new" ? await api("collection-create", { name: v }) : await api("collection-rename", { from: coll, to: v });
				if (r.error) return toast(r.error);
				if (n.kind === "new") await savePrefs({ wallpaperCollection: r.name, wallpaperKind: "image", wallpaperPinned: null });
				await refresh.state();
				toast(n.kind === "new" ? `Made the collection ${r.name}. Add images by dropping them here or with Add images.` : `Renamed ${coll} to ${r.name}.`);
			};
			const nameField = (label) => h("input", { className: "wp-input wp-rename", autoFocus: true, defaultValue: naming.value, "aria-label": label, onFocus: (e) => e.currentTarget.select(), onKeyDown: (e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.dataset.cancel = "1"; e.currentTarget.blur(); } }, onBlur: (e) => commitName(e.currentTarget.dataset.cancel ? null : e.currentTarget.value) });
			const removeImage = (f) => confirmFirst({ title: "Move this wallpaper to the Trash?", action: "Move to Trash", danger: true, pending: "Moving…", body: `“${f}” leaves ${coll} and goes to the macOS Trash, where you can put it back.`, run: async () => { const r = await api("wallpaper-remove", { collection: coll, file: f }); if (r.error) throw new Error(r.error); await refresh.state(); toast(`Moved ${f} to the Trash.`); } });
			const onDrop = (e) => { e.preventDefault(); setDropping(false); if (coll) uploadWallpapers(coll, e.dataTransfer?.files || []); else toast("Make a collection first."); };
			const tone = (sw) => (slot === "dark" ? sw.dark : sw.light);
			const selected = (sw) => kind === "colour" && (slot === "both" ? p.wallpaperColour?.light === sw.light && p.wallpaperColour?.dark === sw.dark : p.wallpaperColour?.[slot] === sw[slot]);
			const pickColour = (sw) => savePrefs({ wallpaperKind: "colour", wallpaperRotate: "off", wallpaperColour: slot === "both" ? { light: sw.light, dark: sw.dark } : { ...(p.wallpaperColour || { light: COLOUR_PRESETS[0].light, dark: COLOUR_PRESETS[0].dark }), [slot]: sw[slot] } });
			const addColour = (hex) => { const list = [...new Set([...(p.wallpaperColours || []), hex])].slice(-16); savePrefs({ wallpaperColours: list }); pickColour({ light: hex, dark: hex }); };
			const removeColour = (hex) => savePrefs({ wallpaperColours: (p.wallpaperColours || []).filter((x) => x !== hex) });
			return h("div", { className: "wp-modal-wrap", onClick: (e) => { if (e.target === e.currentTarget) close(); } },
				h("div", { role: "dialog", "aria-modal": "true", "aria-label": "Wallpaper and glass", className: "wp-modal wp-rise wp-panel" },
					h("div", { className: "wp-row wp-between" }, h("h2", null, "Wallpaper and glass"), h("button", { type: "button", className: "wp-iconbtn", "aria-label": "Close", onClick: close }, IC.x(16))),
					h(ColourModeRow, { ctx }),
					h("div", { className: "wp-field" },
						h("div", { className: "wp-row wp-between wp-wrap" }, h("span", { className: "wp-meta" }, "Pictures"), coll && !naming && h("button", { type: "button", className: "wp-link", onClick: () => setNaming({ kind: "rename", value: coll }) }, "Rename " + coll)),
						h("div", { className: "wp-row wp-wrap" },
							names.map((c) => naming?.kind === "rename" && c === coll ? h("span", { key: c }, nameField("Collection name")) : h(Pill, { key: c, on: kind === "image" && c === coll, onClick: () => savePrefs({ wallpaperCollection: c, wallpaperKind: "image", wallpaperPinned: null }) }, c[0].toUpperCase() + c.slice(1) + " · " + walls[c].length)),
							naming?.kind === "new" ? nameField("New collection name") : h(Pill, { quiet: true, onClick: () => setNaming({ kind: "new", value: "" }), label: "New collection" }, IC.plus(14), "New"))),
					coll && h("div", { className: cx("wp-thumbs", dropping && "drop"), onDragOver: (e) => { e.preventDefault(); if (!dropping) setDropping(true); }, onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false); }, onDrop, "aria-label": "Pictures in " + coll },
						(walls[coll] || []).map((f) => h("div", { key: f, className: cx("wp-thumb", kind === "image" && shown?.f === f && "on") },
							h("button", { type: "button", className: "wp-thumb-pick", onClick: () => savePrefs({ wallpaperCollection: coll, wallpaperKind: "image", wallpaperPinned: p.wallpaperPinned === f ? null : f }), "aria-pressed": p.wallpaperPinned === f, "aria-label": (p.wallpaperPinned === f ? "Unpin " : "Pin ") + f.replace(/\.\w+$/, "").replace(/-/g, " ") }, h("img", { src: API + "wallpaper?c=" + encodeURIComponent(coll) + "&f=" + encodeURIComponent(f), alt: "", loading: "lazy" })),
							h("button", { type: "button", className: "wp-thumb-x", "aria-label": "Move " + f + " to the Trash", title: "Move to the Trash", onClick: () => removeImage(f) }, IC.trash(13)))),
						h("button", { type: "button", className: "wp-thumb wp-thumb-add", onClick: () => fileRef.current?.click() }, IC.plus(16), h("span", null, "Add images")),
						h("input", { ref: fileRef, type: "file", accept: "image/jpeg,image/png,image/webp,image/heic,.heic", multiple: true, hidden: true, onChange: (e) => { const fl = e.target.files; if (fl?.length) uploadWallpapers(coll, fl); e.target.value = ""; } })),
					coll ? h("div", { className: "wp-meta wp-small" }, "Drop images here to add them to " + coll + ". Removing one moves it to the Trash. Collections are the folders in " + (st.wallpaperDir || "the wallpaper folder") + ".")
						: h("div", { className: "wp-meta wp-small" }, "No collections yet. Make one with New, then drop images on it."),
					h("div", { className: "wp-field" },
						h("div", { className: "wp-row wp-between wp-wrap" }, h("span", { className: "wp-meta" }, "Colours"),
							h("div", { className: "wp-row wp-wrap" },
								h("div", { className: "wp-seg wp-seg-sm", role: "radiogroup", "aria-label": "Colour applies to" }, [["both", "Both"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => h("button", { key: k, type: "button", role: "radio", "aria-checked": slot === k, className: cx("wp-segb", slot === k && "on"), onClick: () => setSlot(k) }, l))),
								h("label", { className: "wp-check" }, h("input", { type: "checkbox", checked: !!p.wallpaperGradient, onChange: (e) => savePrefs({ wallpaperGradient: e.target.checked }) }), "Gradient"))),
						h("div", { className: "wp-swatches", role: "group", "aria-label": "Colours" },
							swatchesOf(p).map((sw) => h("span", { key: sw.id, className: "wp-swatchwrap" },
								h("button", { type: "button", className: cx("wp-swatch", selected(sw) && "on"), title: sw.name, "aria-label": sw.name + (slot === "both" ? "" : " for " + slot + " mode"), "aria-pressed": selected(sw), style: { background: slot === "both" && sw.light !== sw.dark ? `linear-gradient(135deg, ${sw.light} 50%, ${sw.dark} 50%)` : p.wallpaperGradient ? colourCss(tone(sw), true) : tone(sw) }, onClick: () => pickColour(sw) }),
								sw.custom && h("button", { type: "button", className: "wp-swatch-x", "aria-label": "Remove " + sw.name, onClick: () => removeColour(sw.id) }, IC.x(10)))),
							h("button", { type: "button", className: "wp-swatch wp-swatch-add", title: "Add a colour", "aria-label": "Add a colour", onClick: () => colourRef.current?.click() }, IC.plus(14)),
							h("input", { ref: colourRef, type: "color", hidden: true, defaultValue: "#4f6fb3", onChange: (e) => addColour(e.target.value) }))),
					h("div", { className: "wp-field" },
						h("span", { className: "wp-meta" }, "Rotation"),
						h("div", { className: "wp-row wp-wrap" },
							h(Pill, { on: rotating, onClick: () => savePrefs({ wallpaperPinned: null, wallpaperRotate: null, wallpaperRotateMin: p.wallpaperRotateMin || 60 }) }, "Rotate " + (kind === "colour" ? "colours" : coll ? coll : "")),
							h(Pill, { on: !rotating, onClick: () => savePrefs(kind === "image" && shown?.f ? { wallpaperRotate: "off", wallpaperPinned: shown.f } : { wallpaperRotate: "off", ...(kind === "colour" && shown?.colour ? { wallpaperColour: { ...(p.wallpaperColour || {}), [isDark() ? "dark" : "light"]: shown.colour } } : {}) }), title: "Keep what shows now" }, "Off · keep this one")),
						h("label", { className: cx("wp-slider", !rotating && "off") }, h("span", null, "Rotate every"), h("input", { type: "range", min: 0, max: ROTATE_STOPS.length - 1, step: 1, disabled: !rotating, value: Math.max(0, ROTATE_STOPS.indexOf(Number(p.wallpaperRotateMin) || 60)), "aria-label": "Rotation interval", onChange: (e) => savePrefs({ wallpaperPinned: null, wallpaperRotate: null, wallpaperRotateMin: ROTATE_STOPS[Number(e.target.value)] }) }), h("span", { className: "wp-mono wp-small" }, rotateLabel(Number(p.wallpaperRotateMin) || 60).replace("Every ", "")))),
					slider("wallpaperOpacity", "Wallpaper opacity", 0, 100, "%"),
					slider("wallpaperFrost", "Wallpaper frost", 0, 24, "px"),
					slider("glassBlur", "Glass blur", 0, 40, "px"),
					slider("glassTint", "Glass tint", 10, 95, "%"),
					h("label", { className: "wp-check" }, h("input", { type: "checkbox", checked: p.motion !== false, onChange: (e) => savePrefs({ motion: e.target.checked }) }), "Motion (always off when macOS Reduce Motion is on)"),
					h("label", { className: "wp-field" }, h("span", { className: "wp-meta" }, "Headline"), h("input", { className: "wp-input", defaultValue: p.headline, placeholder: "Empty shows DSH's own headline", onBlur: (e) => savePrefs({ headline: e.target.value }), onKeyDown: (e) => { if (e.key === "Enter") e.currentTarget.blur(); } }))));
		};
		// Confirmation for the one action here that removes something (a picture goes to the Trash).
		const ConfirmDialog = () => {
			const ui = useStore(uiS); const d = ui.confirm;
			const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
			const ref = useRef(null);
			useEffect(() => { setBusy(false); setErr(null); if (d) setTimeout(() => ref.current?.querySelector(".wp-pill")?.focus(), 30); }, [d]);
			const close = () => { if (!busy) uiS.set((u) => ({ ...u, confirm: null })); };
			useEscape(!!d, close);
			if (!d) return null;
			const go = () => { setBusy(true); setErr(null); Promise.resolve().then(d.run).then(() => { setBusy(false); uiS.set((u) => ({ ...u, confirm: null })); }, (e) => { setBusy(false); setErr(String(e?.message || e)); }); };
			return h("div", { className: "wp-modal-wrap wp-top", onClick: (e) => { if (e.target === e.currentTarget) close(); } },
				h("div", { ref, role: "alertdialog", "aria-modal": "true", "aria-labelledby": "wp-confirm-title", "aria-describedby": "wp-confirm-desc", className: "wp-modal wp-confirm wp-rise" },
					h("h2", { id: "wp-confirm-title" }, d.title),
					h("div", { id: "wp-confirm-desc", className: "wp-meta wp-confirm-body" }, d.body),
					busy && d.pending && h("div", { className: "wp-meta", role: "status" }, d.pending),
					err && h("div", { className: "wp-meta wp-warntext", role: "alert" }, err),
					h("div", { className: "wp-row wp-wrap wp-confirm-actions" },
						h("button", { type: "button", className: "wp-pill quiet", disabled: busy, onClick: close }, "Cancel"),
						h("button", { type: "button", className: cx("wp-pill", d.danger ? "danger" : "on"), disabled: busy, onClick: go }, d.action))));
		};
		const Toast = () => {
			const ui = useStore(uiS);
			if (!ui.toast) return null;
			return h("div", { className: "wp-toast wp-pop", role: "status" }, ui.toast.text);
		};
		// The way in: one button in the sidebar footer, next to DSH's own footer actions.
		const WallpaperButton = () => h("button", { type: "button", className: "wp-footbtn", title: "Wallpaper and glass", "aria-label": "Wallpaper and glass", onClick: () => uiS.set((u) => ({ ...u, panel: true })) }, IC.image(18));

		// ------------------------------------------------------------ the look (wallpaper, glass, headline)
		// What the wallpaper shows now: a picture from the collection, or a colour (rotating through the swatches when
		// rotation is on). Colours pick their light or dark tone from the colour mode.
		const currentWallpaper = (st) => {
			const p = st?.prefs || {}; const walls = st?.wallpapers || {};
			const min = rotateMinOf(p);
			if (p.wallpaperKind === "colour") {
				const t = isDark() ? "dark" : "light";
				const sw = swatchesOf(p);
				const c = min ? sw[Math.floor(Date.now() / (min * 60e3)) % sw.length][t] : (p.wallpaperColour?.[t] || COLOUR_PRESETS[0][t]);
				return { kind: "colour", key: "colour:" + c + ":" + !!p.wallpaperGradient, css: colourCss(c, p.wallpaperGradient), colour: c };
			}
			const coll = walls[p.wallpaperCollection]?.length ? p.wallpaperCollection : Object.keys(walls).find((k) => walls[k].length);
			const files = walls[coll] || [];
			if (!files.length) return null;
			const f = p.wallpaperPinned && files.includes(p.wallpaperPinned) ? p.wallpaperPinned : min ? files[Math.floor(Date.now() / (min * 60e3)) % files.length] : files[0];
			const url = API + "wallpaper?c=" + encodeURIComponent(coll) + "&f=" + encodeURIComponent(f);
			return { kind: "image", key: url, coll, f, url };
		};
		const installLook = () => {
			const style = document.createElement("style");
			style.setAttribute("data-plugin", "dsh-plugin-wallpaper");
			style.textContent = CSS;
			document.head.appendChild(style);
			const fonts = document.createElement("link");
			fonts.rel = "stylesheet"; fonts.href = "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap";
			fonts.setAttribute("data-plugin", "dsh-plugin-wallpaper");
			document.head.appendChild(fonts);
			const wall = document.createElement("div");
			wall.id = "wp-wall"; wall.setAttribute("aria-hidden", "true");
			wall.innerHTML = '<div class="wp-wl"></div><div class="wp-wl"></div><div class="wp-scrim"></div>';
			document.body.prepend(wall);
			document.body.classList.add("wp-on");
			let front = 0; let shownKey = null;
			const apply = () => {
				const st = stateS.get(); if (!st) return;
				const p = st.prefs || {};
				const b = document.body.style;
				b.setProperty("--wp-op", String((p.wallpaperOpacity ?? 90) / 100));
				b.setProperty("--wp-frost", (p.wallpaperFrost ?? 4) + "px");
				b.setProperty("--wp-blur", (p.glassBlur ?? 22) + "px");
				b.setProperty("--wp-tint", String((p.glassTint ?? 55) / 100));
				document.body.classList.toggle("wp-still", p.motion === false);
				const wp = currentWallpaper(st);
				if (wp && wp.key !== shownKey) {
					const show = (bg) => {
						const layers = wall.querySelectorAll(".wp-wl");
						front = 1 - front;
						layers[front].style.backgroundImage = bg;
						layers[front].classList.toggle("colour", wp.kind === "colour");
						layers[front].classList.add("on"); layers[1 - front].classList.remove("on");
						shownKey = wp.key;
					};
					if (wp.kind === "colour") show(wp.css);
					else { const img = new Image(); img.onload = () => show(`url("${wp.url}")`); img.src = wp.url; }
				}
			};
			const unsub = stateS.sub(apply);
			apply();
			const tick = setInterval(apply, 60000);
			// A colour's tone follows the colour mode: re-apply when DSH switches between light and dark.
			const themeWatch = new MutationObserver(apply);
			themeWatch.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
			return () => { unsub(); clearInterval(tick); themeWatch.disconnect(); style.remove(); fonts.remove(); wall.remove(); document.body.classList.remove("wp-on", "wp-still"); ["--wp-op", "--wp-frost", "--wp-blur", "--wp-tint"].forEach((k) => document.body.style.removeProperty(k)); };
		};
		// The headline is drawn with CSS over DSH's own hero text; an empty headline leaves DSH's own text alone.
		// Nothing here writes DSH settings, except one undo: an early Fleet Shell build switched DSH to a custom locale
		// to change this text, and DSH saved that by re-writing the whole profile patch. If that locale is still active,
		// the language goes back to English once.
		const cssString = (t) => '"' + String(t).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ") + '"';
		const installHeadline = (ctx) => {
			const apply = () => {
				const text = stateS.get()?.prefs?.headline;
				document.body.classList.toggle("wp-headline", !!text);
				if (text) document.body.style.setProperty("--wp-headline", cssString(text));
				else document.body.style.removeProperty("--wp-headline");
			};
			const unsub = stateS.sub(apply);
			apply();
			try {
				const loc = ctx.locale;
				const active = (loc?.getSnapshot?.() ?? loc?.snapshot)?.active;
				if (loc && (loc.preference === OLD_LOCALE_ID || active === OLD_LOCALE_ID)) loc.setLocale("en");
			} catch (e) { console.warn("wallpaper: locale reset", e); }
			return () => { unsub(); document.body.classList.remove("wp-headline"); document.body.style.removeProperty("--wp-headline"); };
		};

		// ------------------------------------------------------------ styles
		// Tokens follow DSH's colour mode (data-ds-dark-theme on <body>). Rules on DSH's own surfaces only make them
		// transparent or frosted; nothing is hidden except DSH's hero text while a headline is set.
		const CSS = `
body.wp-on{--wp-ground:#0a0d0c;--wp-text:#ECEAE4;--wp-strong:#DADDD7;--wp-soft:#C9CDC7;--wp-meta:#A9AEA8;--wp-faint:#8E948E;--wp-accent:#7FA7F5;--wp-accent-text:#C9D8FA;--wp-accent-strong:#E4ECFD;--wp-warn-text:#E8C48C;--wp-danger-text:#F2ABA2;--wp-glass:rgba(14,18,17,var(--wp-tint,.55));--wp-conv:rgba(10,13,12,calc(var(--wp-tint,.55) + .2));--wp-pop:rgba(20,24,23,.95);--wp-modal:rgba(16,20,19,.82);--wp-shadow:rgba(0,0,0,.45);--wp-backdrop:rgba(6,8,8,.45);--wp-headline-shadow:rgba(0,0,0,.35);--wp-scrim:linear-gradient(180deg,rgba(6,8,8,.35),rgba(6,8,8,.15) 40%,rgba(6,8,8,.45));--wp-line:rgba(255,255,255,.09);--wp-ease:cubic-bezier(.2,.7,.2,1);--wp-w04:rgba(255,255,255,.04);--wp-w05:rgba(255,255,255,.05);--wp-w06:rgba(255,255,255,.06);--wp-w07:rgba(255,255,255,.07);--wp-w08:rgba(255,255,255,.08);--wp-w10:rgba(255,255,255,.1);--wp-w18:rgba(255,255,255,.18);--wp-w20:rgba(255,255,255,.2);--wp-a08:rgba(127,167,245,.08);--wp-a14:rgba(127,167,245,.14);--wp-a35:rgba(127,167,245,.35);--wp-a45:rgba(127,167,245,.45);--wp-a50:rgba(127,167,245,.5);--wp-a70:rgba(127,167,245,.7);--wp-d12:rgba(242,120,107,.12);--wp-d45:rgba(242,120,107,.45);background:var(--wp-ground)!important}
body.wp-on:not([data-ds-dark-theme]){--wp-ground:#E7E7E2;--wp-text:#191E1B;--wp-strong:#232926;--wp-soft:#38403B;--wp-meta:#55605A;--wp-faint:#68716B;--wp-accent:#3F6FD8;--wp-accent-text:#2A56BE;--wp-accent-strong:#1C45A8;--wp-warn-text:#8A5410;--wp-danger-text:#B3261E;--wp-glass:rgba(250,250,246,var(--wp-tint,.55));--wp-conv:rgba(250,250,246,calc(var(--wp-tint,.55) + .2));--wp-pop:rgba(250,250,247,.97);--wp-modal:rgba(250,250,247,.9);--wp-shadow:rgba(0,0,0,.16);--wp-backdrop:rgba(40,44,42,.22);--wp-headline-shadow:rgba(255,255,255,.55);--wp-scrim:linear-gradient(180deg,rgba(255,255,255,.28),rgba(255,255,255,.1) 40%,rgba(255,255,255,.32));--wp-line:rgba(0,0,0,.1);--wp-w04:rgba(20,26,22,0.044);--wp-w05:rgba(20,26,22,0.055);--wp-w06:rgba(20,26,22,0.066);--wp-w07:rgba(20,26,22,0.077);--wp-w08:rgba(20,26,22,0.088);--wp-w10:rgba(20,26,22,0.110);--wp-w18:rgba(20,26,22,0.198);--wp-w20:rgba(20,26,22,0.220);--wp-a08:rgba(63,111,216,.08);--wp-a14:rgba(63,111,216,.14);--wp-a35:rgba(63,111,216,.35);--wp-a45:rgba(63,111,216,.45);--wp-a50:rgba(63,111,216,.5);--wp-a70:rgba(63,111,216,.7);--wp-d12:rgba(179,38,30,.12);--wp-d45:rgba(179,38,30,.45)}
#wp-wall{position:fixed;inset:0;z-index:0;pointer-events:none;background:var(--wp-ground);overflow:hidden}
#wp-wall .wp-wl{position:absolute;inset:-32px;background-size:cover;background-position:center;filter:blur(var(--wp-frost,4px));opacity:0;transition:opacity 1.1s ease}
#wp-wall .wp-wl.on{opacity:var(--wp-op,.9)}
#wp-wall .wp-wl.colour{filter:none}
#wp-wall .wp-scrim{position:absolute;inset:0;background:var(--wp-scrim)}
body.wp-on #root{position:relative;z-index:1}
body.wp-on{--wp-gap:12px;--wp-hair:1px solid var(--wp-line)}
/* DSH's frame goes transparent so the wallpaper shows through */
body.wp-on [class*="_frame"],body.wp-on [class*="_centerCol"],body.wp-on [class*="_sidebarCol"],body.wp-on [class*="_rightbarCol"],body.wp-on [data-slot="main"],body.wp-on [data-slot="main.conversation"]>div{background:transparent!important;border:0!important;box-shadow:none!important}
body.wp-on [class*="_sidebarCol"],body.wp-on [class*="_rightbarCol"]{overflow:hidden}
body.wp-on [class*="_6Qf49G_handle"]{background:transparent!important;border:0!important;box-shadow:none!important}
body.wp-on [class*="_6Qf49G_handle"]::before,body.wp-on [class*="_6Qf49G_handle"]::after{display:none!important}
/* sidebar: one frosted card */
body.wp-on [data-slot="sidebar"]>div{background:var(--wp-glass)!important;backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);-webkit-backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);border:var(--wp-hair)!important;border-radius:18px;margin:var(--wp-gap) 0 var(--wp-gap) var(--wp-gap);height:calc(100% - 2 * var(--wp-gap))!important;width:calc(100% - var(--wp-gap))!important;box-sizing:border-box;overflow:hidden}
body.wp-on [data-slot="sidebar"]>div>*{min-width:0;max-width:100%}
body.wp-on [data-slot="sidebar"] [class*="_footArea"]{border:0!important}
/* DSH's list fades into its own opaque background at the bottom; on glass that fade is a dark bar, so it goes */
body.wp-on [data-slot="sidebar.workspaces"] [class*="_fade"]{background:none!important}
body.wp-on [data-slot="sidebar"] [class*="_footArea"]::before,body.wp-on [data-slot="sidebar"] [class*="_footArea"]::after{display:none!important}
/* main card: the conversation (not the empty hero) */
body.wp-on [data-slot="main.conversation"]>div{margin:var(--wp-gap);height:calc(100% - 2 * var(--wp-gap))!important;border-radius:18px;box-sizing:border-box;overflow:hidden}
body.wp-on [data-slot="main.conversation"]>div:has([data-slot="conversation.session"] [class*="_viewArea"]){background:var(--wp-conv)!important;backdrop-filter:blur(var(--wp-blur,22px));-webkit-backdrop-filter:blur(var(--wp-blur,22px));border:var(--wp-hair)!important}
body.wp-on header[class*="_header"]{background:transparent!important;border:0!important;box-shadow:none!important}
body.wp-on [data-slot="main.conversation"]>div:has([data-slot="conversation.session"] [class*="_viewArea"]) header[class*="_header"]{background-image:linear-gradient(var(--wp-w08),var(--wp-w08))!important;background-size:calc(100% - 32px) 1px!important;background-position:center bottom!important;background-repeat:no-repeat!important}
body.wp-on [data-slot="main.conversation"] [class*="_body"]{background:transparent!important;border:0!important;margin:0!important}
/* right dock card, only while open */
body.wp-on [data-slot="rightbar"] [class*="_tabHost"]{background:transparent!important;border:0!important}
body.wp-on [data-slot="rightbar"] [class*="irMxjq_panel"]:not([class*="_panelBody"]){background:var(--wp-glass)!important;backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);-webkit-backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);border:var(--wp-hair)!important;border-radius:18px;margin:var(--wp-gap) var(--wp-gap) var(--wp-gap) 0;height:calc(100% - 2 * var(--wp-gap))!important;width:calc(100% - var(--wp-gap))!important;box-sizing:border-box;overflow:hidden}
body.wp-on [data-rightbar-collapsed="true"] [data-slot="rightbar"] [class*="irMxjq_panel"]{border:0!important;background:transparent!important;margin:0!important;backdrop-filter:none!important}
body.wp-on [data-slot="rightbar"] [class*="_tabLayout"] *{border-color:var(--wp-w07)}
/* composer: frosted, with a focus ring */
body.wp-on [class*="yhfFVG_card"],body.wp-on [data-slot="conversation.composer.bar"] [class*="_card"]{background:var(--wp-glass)!important;backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);-webkit-backdrop-filter:blur(var(--wp-blur,22px)) saturate(140%);border:1px solid var(--wp-w10)!important;border-radius:22px!important;transition:border-color .2s ease}
body.wp-on [class*="yhfFVG_card"]:focus-within{border-color:var(--wp-a50)!important}
/* hero: the headline over DSH's own hero text, while one is set */
body.wp-on [class*="_composerHero"]{container-type:inline-size}
body.wp-on.wp-headline [class*="_titleGroup"]>span:first-child{font-size:0!important;line-height:0;display:block;flex:1 1 auto;min-width:0;width:100%;text-align:center}
body.wp-on.wp-headline [class*="_titleGroup"]>span:first-child::after{content:var(--wp-headline);font-family:Geist,system-ui,sans-serif;font-size:clamp(30px,4.2vw,52px);line-height:1.04;font-weight:600;letter-spacing:-.035em;color:var(--wp-text);text-shadow:0 2px 24px var(--wp-headline-shadow);display:block;width:min(100%,900px);margin-inline:auto;text-align:center;text-wrap:balance;white-space:normal}
@container (max-width: 640px){body.wp-on.wp-headline [class*="_titleGroup"]>span:first-child::after{font-size:clamp(20px,6.4cqw,40px)}}
body.wp-on [class*="_previewBadge"],body.wp-on [class*="_fishHitbox"]{display:none!important}
/* collapsed rail: a slimmer card */
body.wp-on [data-slot="sidebar"]>div[class*="_collapsed"]{padding-left:4px!important;padding-right:4px!important;align-items:center}
/* DSH's panel list as a compact menu of tiles, three to a row. Every entry stays (DSH's, Fleet's, Projects', any
   plugin's); only the layout changes. Long names take two lines. */
body.wp-on nav[class*="_panelList"]{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:4px!important;margin:0 0 10px!important;width:auto!important;border-radius:12px;background:var(--wp-w04);border:1px solid var(--wp-w06)!important;box-sizing:border-box}
body.wp-on nav[class*="_panelList"]>*{display:contents}
body.wp-on nav[class*="_panelList"] button[class*="_panelRow"]{display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center;gap:3px;min-width:0;width:auto!important;min-height:52px;height:auto!important;padding:5px 3px!important;margin:0!important;border-radius:9px;font-size:11.5px;color:var(--wp-meta);overflow:hidden}
body.wp-on nav[class*="_panelList"] button[class*="_panelRow"]:hover{background:var(--wp-w06);color:var(--wp-text)}
body.wp-on nav[class*="_panelList"] button[class*="_panelRow"] [class*="_panelTitle"]{margin:0!important;font-size:11.5px;line-height:1.15;max-width:100%;text-align:center;white-space:normal;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
body.wp-on nav[class*="_panelList"] button[aria-current="page"]{background:var(--wp-w10);color:var(--wp-text)}
body.wp-on [data-slot="sidebar"]>div[class*="_collapsed"] nav[class*="_panelList"]{grid-template-columns:1fr;padding:3px!important;width:100%!important}
body.wp-on [data-slot="sidebar"]>div[class*="_collapsed"] nav[class*="_panelList"] [class*="_panelTitle"]{display:none!important}
body.wp-on [data-slot="sidebar"]>div[class*="_collapsed"] nav[class*="_panelList"] button[class*="_panelRow"]{min-height:38px}
/* the footer button */
.wp-footbtn{width:32px;height:32px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex:none;background:transparent;border:0;padding:0;color:var(--wp-soft,currentColor);cursor:pointer;transition:background .16s ease,color .16s ease}
.wp-footbtn:hover{background:var(--wp-w07,rgba(127,127,127,.14));color:var(--wp-text,currentColor)}
.wp-footbtn:focus-visible{outline:2px solid var(--wp-accent,#7FA7F5);outline-offset:2px}
/* the panel */
.wp-i{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.wp-row{display:flex;align-items:center;gap:8px;min-width:0}
.wp-between{justify-content:space-between}
.wp-wrap{flex-wrap:wrap}
.wp-meta{font-size:12.5px;color:var(--wp-meta);line-height:1.4}
.wp-small{font-size:11.5px}
.wp-mono{font-family:'Geist Mono',ui-monospace,monospace}
.wp-warntext{color:var(--wp-warn-text)}
.wp-modal-wrap{position:fixed;inset:0;z-index:1000;background:var(--wp-backdrop);display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;overflow:auto;pointer-events:auto}
.wp-modal-wrap.wp-top{z-index:1010}
.wp-modal{width:600px;max-width:100%;display:flex;flex-direction:column;gap:16px;padding:26px;border-radius:22px;background:var(--wp-modal);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);border:1px solid var(--wp-w10);box-shadow:0 30px 60px var(--wp-shadow);color:var(--wp-text);font-family:Geist,system-ui,sans-serif;box-sizing:border-box}
.wp-modal h2{margin:4px 0 2px;font-size:24px;font-weight:600;letter-spacing:-.02em}
.wp-iconbtn{width:40px;height:40px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;color:var(--wp-soft);cursor:pointer;flex:none;transition:background .16s ease}
.wp-iconbtn:hover{background:var(--wp-w07)}
.wp-pill{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 12px;border-radius:999px;border:1px solid var(--wp-w10);background:transparent;color:var(--wp-strong);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;box-sizing:border-box;transition:background .18s ease,border-color .18s ease,transform .12s ease}
.wp-pill:hover{background:var(--wp-w08)}.wp-pill:active{transform:scale(.98)}
.wp-pill.on{background:var(--wp-a14);border-color:var(--wp-a45);color:var(--wp-accent-strong)}
.wp-pill.quiet{border-color:transparent;color:var(--wp-meta)}
.wp-pill.danger{color:var(--wp-danger-text);border-color:var(--wp-d45)}.wp-pill.danger:hover{background:var(--wp-d12)}
.wp-pill:disabled{opacity:.45;cursor:default}
.wp-pill:focus-visible,.wp-iconbtn:focus-visible,.wp-link:focus-visible{outline:2px solid var(--wp-accent);outline-offset:2px}
.wp-link{white-space:nowrap;background:none;border:0;padding:4px 2px;font:inherit;font-size:13px;color:var(--wp-accent-text);cursor:pointer;min-height:32px}
.wp-link:hover{color:var(--wp-accent-strong);text-decoration:underline}
.wp-seg{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:12px;background:var(--wp-w04);border:1px solid var(--wp-w06)}
.wp-segb{min-height:36px;padding:0 12px;border-radius:9px;border:0;background:transparent;color:var(--wp-meta);font:inherit;font-size:13px;cursor:pointer;transition:background .16s ease,color .16s ease}
.wp-segb:hover{background:var(--wp-w06);color:var(--wp-text)}.wp-segb.on{background:var(--wp-w10);color:var(--wp-text)}
.wp-seg-sm .wp-segb{min-height:30px;padding:0 10px;font-size:12.5px}
.wp-field{display:flex;flex-direction:column;gap:6px}
.wp-input{width:100%;box-sizing:border-box;min-height:40px;padding:8px 10px;border-radius:10px;background:var(--wp-w05);border:1px solid var(--wp-w10);color:var(--wp-text);font:inherit;font-size:14px;outline:none}
.wp-input:focus{border-color:var(--wp-a50)}
.wp-rename{min-height:32px;height:32px;padding:2px 8px;font-size:13px;border-radius:8px;width:180px}
.wp-slider{display:grid;grid-template-columns:150px minmax(0,1fr) 52px;align-items:center;gap:10px;font-size:13.5px;min-height:40px}
.wp-slider input{accent-color:var(--wp-accent)}
.wp-slider.off{opacity:.5}
.wp-check{display:flex;align-items:center;gap:10px;font-size:13.5px;min-height:36px}
.wp-check input{accent-color:var(--wp-accent);width:16px;height:16px}
.wp-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;padding:4px;margin:-4px;border-radius:12px;border:1px dashed transparent;transition:border-color .16s ease,background .16s ease}
.wp-thumbs.drop{border-color:var(--wp-a70);background:var(--wp-a08)}
.wp-thumb{position:relative;padding:0;border-radius:10px;overflow:hidden;border:2px solid transparent;background:#111;cursor:pointer;aspect-ratio:16/9;box-sizing:border-box}
.wp-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.wp-thumb.on{border-color:var(--wp-accent)}
.wp-thumb-pick{all:unset;display:block;width:100%;height:100%;cursor:pointer}.wp-thumb-pick:focus-visible{outline:2px solid var(--wp-accent);outline-offset:-2px}
.wp-thumb-x{position:absolute;top:4px;right:4px;width:24px;height:24px;border-radius:7px;border:0;background:rgba(10,13,12,.72);color:#ECEAE4;display:none;align-items:center;justify-content:center;cursor:pointer;padding:0}
.wp-thumb:hover .wp-thumb-x,.wp-thumb:focus-within .wp-thumb-x{display:inline-flex}.wp-thumb-x:hover{background:rgba(160,40,30,.85)}
.wp-thumb-add{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:var(--wp-w04);border:1.5px dashed var(--wp-w20);color:var(--wp-meta);font:inherit;font-size:12px}
.wp-thumb-add:hover{background:var(--wp-w08);color:var(--wp-text)}
.wp-swatches{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wp-swatchwrap{position:relative;display:inline-flex}
.wp-swatch{width:30px;height:30px;border-radius:50%;border:2px solid var(--wp-w18);padding:0;cursor:pointer;box-sizing:border-box;flex:none}
.wp-swatch.on{border-color:var(--wp-accent);box-shadow:0 0 0 2px var(--wp-a35)}
.wp-swatch:focus-visible{outline:2px solid var(--wp-accent);outline-offset:2px}
.wp-swatch-add{display:inline-flex;align-items:center;justify-content:center;background:var(--wp-w05);color:var(--wp-soft);border-style:dashed}
.wp-swatch-x{position:absolute;top:-5px;right:-5px;width:16px;height:16px;border-radius:50%;border:0;padding:0;background:rgba(10,13,12,.85);color:#ECEAE4;display:none;align-items:center;justify-content:center;cursor:pointer}
.wp-swatchwrap:hover .wp-swatch-x,.wp-swatchwrap:focus-within .wp-swatch-x{display:inline-flex}
.wp-confirm{width:440px;gap:12px;padding:22px}.wp-confirm h2{font-size:19px}
.wp-confirm-body{font-size:13.5px;line-height:1.5;color:var(--wp-soft)}
.wp-confirm-actions{justify-content:flex-end;gap:8px;margin-top:4px}
.wp-toast{position:fixed;right:24px;bottom:24px;z-index:1100;max-width:420px;padding:12px 16px;border-radius:14px;background:var(--wp-pop);border:1px solid var(--wp-w10);color:var(--wp-text);font:14px Geist,system-ui,sans-serif;box-shadow:0 18px 40px var(--wp-shadow);pointer-events:auto}
/* --- skins: grounds for surfaces that bring their own opaque page ---
   A page that paints DSH's --dsw-alias-bg-base over the wall gets the conversation card's treatment: one glass
   card at tint + .2, with DSH's card tokens remapped inside it so the surface's own cards, wells and inputs read
   as faint fills (blur once). Anchored on each surface's own hand-written root class or DSH's structure, never a
   hash. Every rule here sits under body.wp-on: switching Wallpaper off leaves nothing behind. */

/* dsh-context: its overview page in main. Its right-sidebar pane (.lc-root) already sits on the dock's glass and
   needs only the token remap. Its version-gate modal takes Wallpaper's floating material; the page's own
   container-type already made it the modal's containing block, so the blur adds no new trap. */
body.wp-on .lc-ov-page{background:var(--wp-conv)!important;-webkit-backdrop-filter:blur(var(--wp-blur,22px));backdrop-filter:blur(var(--wp-blur,22px));border:var(--wp-hair)!important;border-radius:18px;margin:var(--wp-gap);height:calc(100% - 2 * var(--wp-gap))!important;width:calc(100% - 2 * var(--wp-gap));box-sizing:border-box}
body.wp-on :is(.lc-ov-page,.lc-root){--dsw-alias-bg-layer-1:var(--wp-w06);--dsw-alias-bg-layer-2:var(--wp-w08);--dsw-alias-bg-layer-3:var(--wp-w10)}
body.wp-on .lc-modal-card{background:var(--wp-pop)!important;-webkit-backdrop-filter:blur(28px);backdrop-filter:blur(28px)}

/* categories: its page in main. The hover token it reads is one DSH doesn't define, so it gets Wallpaper's fill. */
body.wp-on .dshc-pg{background:var(--wp-conv)!important;-webkit-backdrop-filter:blur(var(--wp-blur,22px));backdrop-filter:blur(var(--wp-blur,22px));border:var(--wp-hair)!important;border-radius:18px;margin:var(--wp-gap);height:calc(100% - 2 * var(--wp-gap))!important;width:calc(100% - 2 * var(--wp-gap));box-sizing:border-box}
body.wp-on .dshc-pg{--dsh-color-bg-hover:var(--wp-w07)}
/* motion */
.wp-rise{animation:wp-rise .32s var(--wp-ease) both}
.wp-pop{animation:wp-pop .16s var(--wp-ease) both}
@keyframes wp-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes wp-pop{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
body.wp-still .wp-rise,body.wp-still .wp-pop{animation:none!important}
body.wp-still *{transition:none!important}
@media (prefers-reduced-motion:reduce){.wp-rise,.wp-pop{animation:none!important}#wp-wall .wp-wl{transition:none}}
`;

		// ------------------------------------------------------------ apply
		function apply(ctx) {
			ctx.effect(() => { refresh.state(); }, "wallpaper: settings");
			ctx.effect(() => installLook(), "wallpaper: wallpaper and glass");
			ctx.effect(() => installHeadline(ctx), "wallpaper: headline");
			const reg = (slot, opts, comp) => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, locale: NS, ...opts }, comp));
			reg("sidebar.footer.action", { id: "wp-open", order: 90 }, WallpaperButton);
			reg("shell.overlay", { id: "wp-overlays", order: 40, inject: () => ({ ctx }) }, (props) => h(Fragment, null, h(WallpaperPanel, props), h(ConfirmDialog, null), h(Toast, null)));
		}
		return { name: "dsh-plugin-wallpaper", inject: ["slots", "locale"], apply };
	}
});
