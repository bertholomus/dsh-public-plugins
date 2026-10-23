// Reasoning pill — client bundle (hand-written, no build step).
// One reasoning control: a "Reasoning: …" pill beside the model name in the composer. While the pill shows, DSH's own
// Effort row in the model menu and the effort badge on the model button are hidden, so there is one place to set it.
// The pill changes only the session's reasoning effort, through DSH's own model directory, as DSH's Effort row does.
window.__ModuleLoader__.load({
	id: "dsh-plugin-reasoning-pill",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useSyncExternalStore } = React;
		const NS = "reasoning-pill";
		const cx = (...a) => a.filter(Boolean).join(" ");
		// A DSH store (getSnapshot/subscribe) as React state.
		const useExternal = (store) => {
			const subscribe = React.useCallback((f) => (store?.subscribe ? store.subscribe(f) : () => {}), [store]);
			const get = React.useCallback(() => (store?.getSnapshot ? store.getSnapshot() : null), [store]);
			return useSyncExternalStore(subscribe, get, get);
		};
		const useEscape = (active, fn) => useEffect(() => {
			if (!active) return;
			const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); fn(); } };
			document.addEventListener("keydown", onKey, true);
			return () => document.removeEventListener("keydown", onKey, true);
		}, [active]);
		const svg = (paths, size = 18) => h("svg", { className: "rp-i", viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true" }, ...paths.map((d, i) => h("path", { key: i, d })));
		const IC = {
			gauge: (s) => svg(["M4.5 16a8 8 0 1115 0", "M12 16l4-5"], s),
			down: (s) => svg(["M6 9l6 6 6-6"], s),
			check: (s) => svg(["M5 12.5l4.5 4.5L19 7.5"], s),
		};

		// ------------------------------------------------------------ the pill
		// It mounts twice (right of the composer, and a compact copy on the left for composers that have no right side);
		// CSS hides the left copy whenever the right one is there.
		const ReasoningPill = ({ ctx, sessionId, where }) => {
			const resolver = ctx.get?.("modelDirectories");
			const [tick, setTick] = useState(0);
			let directory = null;
			try { directory = sessionId ? resolver?.directoryFor(sessionId) ?? null : null; } catch { directory = null; }
			// The session's scope can appear a moment after the composer mounts; retry until it does.
			useEffect(() => { if (directory) return; const t = setTimeout(() => setTick((n) => n + 1), 700); return () => clearTimeout(t); }, [directory, tick]);
			const snap = useExternal(directory?.store);
			const cat = useExternal(resolver?.catalog?.store);
			const [open, setOpen] = useState(false);
			const [err, setErr] = useState(null);
			const ref = useRef(null);
			useEffect(() => { if (!open) return; const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("pointerdown", off); return () => document.removeEventListener("pointerdown", off); }, [open]);
			useEffect(() => { if (!err) return; const t = setTimeout(() => setErr(null), 6000); return () => clearTimeout(t); }, [err]);
			useEscape(open, () => setOpen(false));
			if (!directory || !snap?.current) return null;
			void cat;
			const cur = snap.current;
			const fromGroups = (snap.groups || []).find((g) => g.id === cur.provider)?.models?.find((m) => m.id === cur.model)?.reasoning;
			const reasoning = fromGroups ?? resolver.catalog.reasoningFor(cur);
			const efforts = reasoning?.efforts || [];
			const effective = cur.reasoningEffort ?? reasoning?.defaultEffort;
			const label = !efforts.length ? "None" : effective === undefined ? "Default" : (efforts.find((x) => x.id === effective)?.name ?? effective);
			const choices = [...(efforts.length && reasoning?.defaultEffort === undefined ? [{ id: undefined, name: "Default" }] : []), ...efforts];
			const pick = async (id) => {
				setOpen(false);
				if (id === effective) return;
				const r = await directory.select({ provider: cur.provider, model: cur.model, ...(id === undefined ? {} : { reasoningEffort: id }) });
				if (r && r.ok === false) setErr("Couldn't change reasoning: " + (r.error?.message || "unknown error"));
			};
			const busy = snap.status === "selecting";
			return h("div", { className: "rp-wrap " + (where === "left" ? "l" : "r"), ref },
				h("button", { type: "button", className: "rp-pill", disabled: !efforts.length || busy, title: err || (efforts.length ? "Reasoning effort" : "This model provides no reasoning effort levels."), "aria-haspopup": "listbox", "aria-expanded": open, "aria-label": "Reasoning: " + label, onClick: () => setOpen((o) => !o) },
					IC.gauge(15), h("span", { className: "rp-clip" }, "Reasoning: " + label), efforts.length ? IC.down(12) : null),
				err && h("span", { className: "rp-err", role: "alert" }, err),
				open && h("div", { className: "rp-menu rp-pop", role: "listbox", "aria-label": "Reasoning effort" },
					h("div", { className: "rp-mhead" }, "Reasoning effort"),
					choices.map((c) => h("button", { key: String(c.id), type: "button", role: "option", "aria-selected": c.id === effective, className: cx("rp-mi", c.id === effective && "sel"), onClick: () => pick(c.id) }, h("span", { className: "rp-grow" }, c.name), c.id === effective && IC.check(14)))));
		};

		// DSH's model menu has its own Effort row. While this plugin runs, the pill is the one control for it, so that row
		// is hidden by its label; the Model row and picking a model work as before.
		const installEffortRowHider = () => {
			let queued = false;
			const sweep = () => {
				queued = false;
				document.querySelectorAll('[role="menu"] button[role="menuitem"]:not(.rp-hidden-effort)').forEach((b) => {
					const label = b.querySelector('[class*="_cellLabel"]')?.textContent?.trim() ?? "";
					if (/^(effort|reasoning effort|推理强度|推理)$/i.test(label)) { b.classList.add("rp-hidden-effort"); b.setAttribute("aria-hidden", "true"); b.tabIndex = -1; }
				});
			};
			const mo = new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(sweep); } });
			mo.observe(document.body, { childList: true, subtree: true });
			return () => {
				mo.disconnect();
				document.querySelectorAll(".rp-hidden-effort").forEach((b) => { b.classList.remove("rp-hidden-effort"); b.removeAttribute("aria-hidden"); b.removeAttribute("tabindex"); });
			};
		};

		// ------------------------------------------------------------ styles
		// Tokens sit on the pill itself and follow DSH's colour mode. The composer rules apply only to a composer that
		// holds the pill: the model button comes first, then the pill, and DSH's effort badge on the model button hides.
		const CSS = `
.rp-wrap{--rp-text:#ECEAE4;--rp-strong:#DADDD7;--rp-soft:#C9CDC7;--rp-faint:#8E948E;--rp-warn:#E8C48C;--rp-pop:rgba(20,24,23,.95);--rp-shadow:rgba(0,0,0,.45);--rp-w04:rgba(255,255,255,.04);--rp-w07:rgba(255,255,255,.07);--rp-w08:rgba(255,255,255,.08);--rp-w10:rgba(255,255,255,.1);--rp-a14:rgba(127,167,245,.14);--rp-ease:cubic-bezier(.2,.7,.2,1)}
body:not([data-ds-dark-theme]) .rp-wrap{--rp-text:#191E1B;--rp-strong:#232926;--rp-soft:#38403B;--rp-faint:#68716B;--rp-warn:#8A5410;--rp-pop:rgba(250,250,247,.97);--rp-shadow:rgba(0,0,0,.16);--rp-w04:rgba(20,26,22,0.044);--rp-w07:rgba(20,26,22,0.077);--rp-w08:rgba(20,26,22,0.088);--rp-w10:rgba(20,26,22,0.110);--rp-a14:rgba(63,111,216,.14)}
.rp-wrap{position:relative;display:inline-flex;align-items:center;gap:6px;order:3;min-width:0}
[data-slot="conversation.composer.bar"]:has(.rp-wrap.r) .rp-wrap.l{display:none}
[class*="_standardControls"]:has(.rp-wrap){display:flex;align-items:center;gap:6px;min-width:0}
[class*="_standardControls"]:has(.rp-wrap) [data-slot="conversation.input.model"]>*{order:2}
[data-slot="conversation.composer.bar"]:has(.rp-wrap) [data-slot="conversation.input.model"] [class*="_triggerEffort"]{display:none!important}
.rp-hidden-effort{display:none!important}
.rp-i{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.rp-pill{display:inline-flex;align-items:center;gap:6px;min-height:30px;max-width:180px;padding:0 10px;border-radius:999px;border:1px solid var(--rp-w10);background:var(--rp-w04);color:var(--rp-soft);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;min-width:0;box-sizing:border-box;transition:background .16s ease}
.rp-pill:hover:not(:disabled){background:var(--rp-w08)}
.rp-pill:disabled{opacity:.5;cursor:default}
.rp-pill:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.rp-clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.rp-grow{flex:1;min-width:0}
.rp-err{font-size:12px;color:var(--rp-warn);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-menu{position:absolute;z-index:50;bottom:40px;right:0;width:220px;padding:6px;border-radius:14px;background:var(--rp-pop);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid var(--rp-w10);box-shadow:0 18px 40px var(--rp-shadow);color:var(--rp-text);font-family:inherit;box-sizing:border-box}
.rp-wrap.l .rp-menu{left:0;right:auto}
.rp-mhead{padding:6px 10px 4px;font-size:11.5px;color:var(--rp-faint);letter-spacing:.02em}
.rp-mi{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:0 10px;border-radius:10px;text-align:left;font:inherit;font-size:13.5px;color:var(--rp-strong);background:transparent;border:0;cursor:pointer;box-sizing:border-box;transition:background .16s ease}
.rp-mi:hover{background:var(--rp-w07)}
.rp-mi.sel{background:var(--rp-a14)}
.rp-mi:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
/* a narrow composer keeps only the gauge */
[class*="yhfFVG_card"]{container-type:inline-size}
@container (max-width: 340px){.rp-wrap .rp-pill .rp-clip{display:none}.rp-wrap .rp-pill{padding:0 8px}}
.rp-pop{animation:rp-pop .16s var(--rp-ease) both}
@keyframes rp-pop{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
body.wp-still .rp-pop{animation:none!important}
@media (prefers-reduced-motion:reduce){.rp-pop{animation:none!important}}
`;
		const installStyles = () => {
			const style = document.createElement("style");
			style.setAttribute("data-plugin", "dsh-plugin-reasoning-pill");
			style.textContent = CSS;
			document.head.appendChild(style);
			return () => style.remove();
		};

		// ------------------------------------------------------------ apply
		function apply(ctx) {
			ctx.effect(() => installStyles(), "reasoning-pill: styles");
			ctx.effect(() => installEffortRowHider(), "reasoning-pill: one reasoning control");
			const reg = (slot, opts, comp) => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, locale: NS, ...opts }, comp));
			reg("conversation.input.right", { id: "rp-pill", order: 100, inject: (sessionId) => ({ ctx, sessionId, where: "right" }) }, ReasoningPill);
			reg("conversation.input.left", { id: "rp-pill-compact", order: 60, inject: (sessionId) => ({ ctx, sessionId, where: "left" }) }, ReasoningPill);
		}
		return { name: "dsh-plugin-reasoning-pill", inject: ["slots"], apply };
	}
});
