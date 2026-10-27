// Reasoning pill — client bundle (hand-written, no build step).
//
// One reasoning control: a "Reasoning: …" control beside the model name in the composer (new chat and open chats).
// It opens the session's reasoning levels in DSH's own menu and changes only the session's reasoning effort, through
// the session's own model directory (`ctx.modelDirectories`), the same call DSH's Effort row makes. While it runs,
// DSH's Effort row in the model menu and the effort caption on the model button are hidden, so there is one place to
// set reasoning; switched off, both come back.
//
// DSH joins every plugin's browser half into one script, so nothing here may throw while it loads.
if (typeof window !== "undefined" && window.__ModuleLoader__) window.__ModuleLoader__.load({
	id: "dsh-plugin-reasoning-pill",
	factory: (require) => {
		const React = require("react");
		let ui = {};
		try { ui = require("@deepseek-ai/dsh-client-ui-primitives") || {}; } catch { ui = {}; }
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React;
		const PACKAGE = "dsh-plugin-reasoning-pill";
		const MARK = "data-reasoning-pill-hidden"; // the one mark this plugin puts on DSH's elements (the hidden Effort row)
		const DEFAULT_ID = "@default"; // the menu id of "Default" (the model's own default, no effort sent)

		// ------------------------------------------------------------ what the control shows (pure, unit-tested)
		// DSH's label for the Effort row in its model menu, in each language DSH ships ("menu.effort"), and the labels
		// older builds used.
		const EFFORT_LABELS = ["effort", "推理等级", "reasoning effort", "推理强度", "推理"];
		const isEffortLabel = (text) => EFFORT_LABELS.includes(String(text ?? "").trim().toLowerCase());

		/**
		 * What the control shows for a session's model directory snapshot.
		 * @param snap - ModelDirectoryState: { current, routable, groups, status, pending, error, retainedEffort }
		 * @param reasoningFor - (selection) => the catalog's last advertised reasoning metadata for it
		 * @returns null when there is nothing to show (no model selected yet), else
		 *   { state: "ready" | "none" | "unavailable", label, efforts, selectedId, busy, model }
		 */
		function viewOf(snap, reasoningFor) {
			const cur = snap?.current;
			if (!cur || typeof cur.provider !== "string" || typeof cur.model !== "string") return null;
			const group = (Array.isArray(snap.groups) ? snap.groups : []).find((g) => g?.id === cur.provider);
			const entry = Array.isArray(group?.models) ? group.models.find((m) => m?.id === cur.model) : undefined;
			let reasoning = entry?.reasoning;
			if (reasoning === undefined) { try { reasoning = reasoningFor?.(cur); } catch { reasoning = undefined; } }
			const efforts = (Array.isArray(reasoning?.efforts) ? reasoning.efforts : []).filter((e) => e && typeof e.id === "string").map((e) => ({ id: e.id, name: typeof e.name === "string" && e.name ? e.name : e.id }));
			const model = typeof entry?.name === "string" && entry.name ? entry.name : "This model";
			const busy = snap.status === "selecting" || Boolean(snap.pending);
			// While a pick is on its way, show what was picked (DSH's own seat does the same with its spinner).
			const shownSel = snap.pending && snap.pending.provider === cur.provider && snap.pending.model === cur.model ? snap.pending : cur;
			const nameOf = (id) => efforts.find((e) => e.id === id)?.name ?? id;
			if (snap.routable === false) {
				const kept = snap.retainedEffort ?? (cur.reasoningEffort ? nameOf(cur.reasoningEffort) : undefined);
				return { state: "unavailable", label: kept ?? "Default", efforts: [], selectedId: undefined, busy: false, model };
			}
			if (!efforts.length) return { state: "none", label: "None", efforts: [], selectedId: undefined, busy: false, model };
			const defaultEffort = typeof reasoning?.defaultEffort === "string" ? reasoning.defaultEffort : undefined;
			const effective = shownSel.reasoningEffort ?? defaultEffort;
			const choices = [...(defaultEffort === undefined ? [{ id: DEFAULT_ID, name: "Default" }] : []), ...efforts];
			const selectedId = effective === undefined ? DEFAULT_ID : effective;
			const label = effective === undefined ? "Default" : nameOf(effective);
			return { state: "ready", label, efforts: choices, selectedId, busy, model };
		}

		/** The selection DSH gets for a pick: the same provider and model, with that effort (none for Default). */
		function selectionFor(current, id) {
			return { provider: current.provider, model: current.model, ...(id === DEFAULT_ID || id === undefined ? {} : { reasoningEffort: id }) };
		}

		// A refused pick in plain words, with what to do next. For a session another DSH holds, DSH's own sentence (the one
		// its model button shows); DSH's raw reason goes to the console only, never where people read.
		const IN_USE = "This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.";
		const UNREACHABLE = "DSH isn't reachable. Try again when it reconnects.";
		const MODEL_GONE = "The model isn't available now. Pick a model with the model button, then try again.";
		const OTHER = "DSH didn't take the change. Try again.";
		/**
		 * Why DSH refused a pick, from what `select` gave back: a failed result `{ ok: false, error: { code, message } }`
		 * or a thrown error. A call that never reached DSH folds into `gateway/internal` with a "client api: …" message.
		 * @returns {{ kind: "in-use" | "unreachable" | "model" | "other", words: string }}
		 */
		function refusalOf(result) {
			const error = result?.error ?? result;
			const code = typeof error?.code === "string" ? error.code : "";
			const message = String((typeof result === "string" ? result : error?.message) ?? "").trim();
			if (code === "session/writer-held") return { kind: "in-use", words: IN_USE };
			if (code === "session/model-unavailable") return { kind: "model", words: MODEL_GONE };
			if (code === "gateway/cancelled" || (code === "gateway/internal" && /^client api:/i.test(message)) || /failed to fetch|network ?error|no active connection|no longer mounted|econnrefused|websocket/i.test(message)) return { kind: "unreachable", words: UNREACHABLE };
			return { kind: "other", words: OTHER };
		}
		/** A refused pick as people read it: a failure that says why and what to do next. */
		function failureText(result) {
			return "Reasoning not changed: " + refusalOf(result).words;
		}
		/** How long DSH's banner holds a refusal: long enough to read it (DSH's own default, 3 s, is for one short line). */
		const holdFor = (text) => Math.min(12000, Math.max(5000, 3000 + String(text).length * 45));

		/** Whether DSH treats the session as an addressed subagent's: DSH shows no model button there and refuses a change. */
		function isSubagent(ctx, sessionId) {
			try { return ctx?.get?.("sessions")?.subagentAddress?.(sessionId) !== undefined; } catch { return false; }
		}

		/** The control's accessible name and tooltip for a view. */
		function wordsFor(view, error) {
			if (view.state === "none") return { aria: "Reasoning effort: none. " + view.model + " has no reasoning levels.", title: view.model + " has no reasoning levels." };
			if (view.state === "unavailable") return { aria: "Reasoning effort: " + view.label + ". The selected model isn't in the model list now.", title: "The selected model isn't in the model list now, so its reasoning can't change. Pick a model with the model button." };
			const level = "Reasoning effort: " + view.label;
			return { aria: level + (view.busy ? ", changing" : "") + (error ? ". " + error : ""), title: error ? level + ". " + error : level };
		}

		// ------------------------------------------------------------ the control
		// A DSH store (getSnapshot/subscribe) as React state.
		const NO_STORE = { getSnapshot: () => null, subscribe: () => () => {} };
		const useExternal = (store) => {
			const s = store && typeof store.getSnapshot === "function" && typeof store.subscribe === "function" ? store : NO_STORE;
			const subscribe = useCallback((f) => s.subscribe(f), [s]);
			const get = useCallback(() => s.getSnapshot(), [s]);
			return useSyncExternalStore(subscribe, get, get);
		};
		const svg = (paths, size) => h("svg", { className: "rp-i", viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", focusable: "false" }, ...paths.map((d, i) => h("path", { key: i, d })));
		const gauge = () => svg(["M4.5 16a8 8 0 1115 0", "M12 16l4-5"], 16);
		const chevron = () => (typeof ui.IconChevronDownOutlineRegular === "function" ? h(ui.IconChevronDownOutlineRegular, { size: 12, className: "rp-chev" }) : svg(["M6 9l6 6 6-6"], 12));
		const warning = (size) => (typeof ui.IconWarningOutlineRegular === "function" ? h(ui.IconWarningOutlineRegular, { size }) : svg(["M12 4l9 16H3z", "M12 10v4", "M12 17v.5"], size));
		// The session's directory appears a moment after the composer mounts; look again for a while, then stop.
		const RETRY_MS = 700;
		const RETRIES = 20;
		const useDirectory = (resolver, sessionId) => {
			const [tries, setTries] = useState(0);
			let directory = null;
			try { directory = sessionId && typeof resolver?.directoryFor === "function" ? resolver.directoryFor(sessionId) ?? null : null; } catch { directory = null; }
			useEffect(() => {
				if (directory || !sessionId || tries >= RETRIES) return undefined;
				const t = setTimeout(() => setTries((n) => n + 1), RETRY_MS);
				return () => clearTimeout(t);
			}, [directory, sessionId, tries]);
			return directory;
		};

		const ReasoningPill = ({ ctx, sessionId }) => {
			const resolver = (() => { try { return ctx.get?.("modelDirectories") ?? null; } catch { return null; } })();
			const directory = useDirectory(resolver, sessionId);
			const snap = useExternal(directory?.store);
			useExternal(resolver?.catalog?.store); // a catalog refresh can change the levels shown
			const [open, setOpen] = useState(false);
			// A refused pick: the words, the chat it happened in, and DSH's own error at the time (the mark goes when DSH
			// clears it, as on a reconnect). The banner has its own lifetime.
			const [refused, setRefused] = useState(null);
			const [banner, setBanner] = useState(null);
			const [said, setSaid] = useState("");
			const alive = useRef(true);
			const trigger = useRef(null);
			const root = useRef(null);
			const seq = useRef(0);
			const here = useRef(sessionId);
			here.current = sessionId;
			useEffect(() => () => { alive.current = false; }, []);
			// DSH loads the directory when its model seat needs it; ask once more in case nothing has yet.
			useEffect(() => {
				if (!directory || snap?.status !== "idle" || typeof directory.load !== "function") return;
				try { Promise.resolve(directory.load()).catch(() => {}); } catch {}
			}, [directory, snap?.status]);
			const view = directory ? viewOf(snap, (sel) => resolver?.catalog?.reasoningFor?.(sel)) : null;
			useEffect(() => { if (open && (!view || view.state !== "ready" || view.busy)) setOpen(false); }, [open, view?.state, view?.busy]);
			// A refusal belongs to its chat, and ends when DSH clears the error it reported (a reconnect, a fresh model
			// list) or with the next pick.
			const refusal = refused && refused.sessionId === sessionId ? refused : null;
			useEffect(() => { if (refused && refused.sessionId !== sessionId) { setRefused(null); setBanner(null); } }, [sessionId, refused]);
			useEffect(() => { if (refusal?.dshError && !snap?.error && snap?.status !== "selecting") setRefused(null); }, [refusal, snap?.error, snap?.status]);
			// A subagent's chat: DSH shows no model button and can't change the model there, so neither does this.
			if (!view || isSubagent(ctx, sessionId)) return null;
			// Closing only closes. DSH's menu gives the keyboard back to the control after Escape or a pick, and a click
			// elsewhere leaves the focus where the person put it (the message box, DSH's model button).
			const close = () => setOpen(false);
			// After a pick, the focus comes back to the control only if it was lost with the menu's rows.
			const keepFocus = () => requestAnimationFrame(() => {
				const el = root.current?.querySelector(".rp-trigger");
				const active = document.activeElement;
				if (!el?.isConnected || (active && active !== document.body)) return;
				if (typeof ui.focusWithoutRing === "function") ui.focusWithoutRing(el);
				else el.focus();
			});
			const refuse = (why, picked) => {
				try { console.warn("reasoning-pill: DSH did not take the reasoning change", why?.error ?? why); } catch {}
				const text = failureText(why);
				let dshError = null;
				try { dshError = directory.store.getSnapshot()?.error ?? null; } catch {}
				setRefused({ sessionId: picked, text, dshError });
				seq.current += 1;
				if (here.current === picked) setBanner({ seq: seq.current, text });
			};
			const choose = (id) => {
				close();
				keepFocus();
				if (view.state !== "ready" || id === view.selectedId) return;
				const name = view.efforts.find((e) => e.id === id)?.name ?? id;
				const picked = sessionId;
				setRefused(null);
				setBanner(null);
				setSaid("");
				let pending;
				try { pending = Promise.resolve(directory.select(selectionFor(snap.current, id))); } catch (e) { pending = Promise.reject(e); }
				pending.then((r) => {
					if (!alive.current) return;
					if (r && r.ok === false) { refuse(r, picked); return; }
					setSaid("Reasoning effort: " + name);
				}, (e) => { if (alive.current) refuse(e, picked); });
			};
			const words = wordsFor(view, refusal?.text);
			// Never `disabled`: the control keeps the keyboard focus while a pick is on its way, and a model with no
			// levels can still be reached to hear why.
			const inert = view.state !== "ready" || view.busy;
			const button = h("button", {
				ref: trigger, type: "button", className: "rp-trigger", "aria-disabled": inert || undefined,
				"aria-haspopup": "menu", "aria-expanded": open, "aria-busy": view.busy || undefined,
				"aria-label": words.aria, title: words.title, "data-reasoning-pill-state": refusal && view.state === "ready" ? "refused" : view.state,
				onClick: () => { if (!inert) setOpen((o) => !o); },
			},
			refusal ? h("span", { className: "rp-warn", "aria-hidden": "true" }, warning(14)) : null,
			h("span", { className: "rp-gauge" }, gauge()), h("span", { className: "rp-label" }, h("span", { className: "rp-word" }, "Reasoning: "), view.label), view.state === "ready" ? chevron() : null);
			// DSH's menu marks the current level with its check; screen readers hear it in the item's name.
			const items = view.efforts.map((e) => ({ id: e.id, label: e.id === view.selectedId ? h("span", null, e.name, h("span", { className: "rp-sr" }, ", current")) : e.name }));
			// It opens above the control, as DSH's model menu does, so it never covers the control or the status line.
			const menu = typeof ui.Menu === "function"
				? h(ui.Menu, { open, items, selectedId: view.selectedId, onSelect: choose, onClose: close, align: "end", side: "top", portal: true, anchor: button, listClassName: "rp-menu" })
				: h(FallbackMenu, { open, items, selectedId: view.selectedId, onSelect: choose, onClose: close, anchor: button, trigger });
			// A refusal shows as DSH shows a refused model pick: in DSH's banner (its Toast, without an anchor, as DESIGN.md
			// asks), at the top of the window and read out at once.
			const toast = banner && typeof ui.Toast === "function"
				? h(ui.Toast, { key: banner.seq, text: banner.text, icon: warning(16), holdMs: holdFor(banner.text), onDone: () => setBanner((b) => (b && b.seq === banner.seq ? null : b)) })
				: null;
			return h("span", { ref: root, className: "rp-root", "data-reasoning-pill": "" },
				menu,
				h("span", { className: "rp-sr", role: "status" }, said),
				toast,
				banner && !toast ? h("span", { className: "rp-err", role: "alert" }, banner.text) : null);
		};

		// For a DSH without its Menu part: a menu of radio items with arrow keys, and Escape giving the keyboard back to the
		// control; a click elsewhere only closes it.
		const FallbackMenu = ({ open, items, selectedId, onSelect, onClose, anchor, trigger }) => {
			const list = useRef(null);
			useEffect(() => {
				if (!open) return undefined;
				const first = list.current?.querySelector('[aria-checked="true"]') ?? list.current?.querySelector('[role="menuitemradio"]');
				first?.focus();
				const off = (e) => { if (list.current && !list.current.contains(e.target) && !trigger.current?.contains(e.target)) onClose(); };
				document.addEventListener("pointerdown", off, true);
				return () => document.removeEventListener("pointerdown", off, true);
			}, [open]);
			const onKeyDown = (e) => {
				const all = [...(list.current?.querySelectorAll('[role="menuitemradio"]') ?? [])];
				const at = all.indexOf(document.activeElement);
				if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus(); }
				else if (e.key === "Home" || e.key === "End") { e.preventDefault(); (e.key === "Home" ? all[0] : all.at(-1))?.focus(); }
				else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); onClose(); trigger.current?.focus(); }
			};
			return h("span", { className: "rp-fb" }, anchor, open ? h("div", { ref: list, role: "menu", className: "rp-menu rp-fb-menu", "aria-label": "Reasoning effort", onKeyDown },
				items.map((it) => h("button", { key: it.id, type: "button", role: "menuitemradio", "aria-checked": it.id === selectedId, tabIndex: -1, className: "rp-fb-item", onClick: () => onSelect(it.id) }, it.label))) : null);
		};

		// ------------------------------------------------------------ one reasoning control
		// DSH's model menu has its own Effort row. While this plugin runs, the control above is the one place for it, so
		// that row is hidden (found by its label in DSH's own words); the Model row and picking a model work as before.
		// One observer of added nodes; it looks only when a menu or menu row was added, and marks in the same task, before
		// the menu is painted (no frame of the row showing, and no wait on an animation frame, which a hidden window
		// never gets). Its one mark comes off when the plugin stops.
		const hideEffortRows = (root) => {
			for (const b of root.querySelectorAll?.('[role="menu"] [role="menuitem"]') ?? []) {
				if (b.hasAttribute(MARK)) continue;
				const label = b.querySelector('[class*="_cellLabel"]')?.textContent;
				if (isEffortLabel(label)) b.setAttribute(MARK, "");
			}
		};
		const addsMenu = (records) => records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.('[role="menu"],[role="menuitem"]') || n.querySelector?.('[role="menu"],[role="menuitem"]'))));
		const installEffortRowHider = () => {
			const watch = new MutationObserver((records) => { if (addsMenu(records)) hideEffortRows(document); });
			watch.observe(document.body, { childList: true, subtree: true });
			hideEffortRows(document);
			return () => {
				watch.disconnect();
				document.querySelectorAll("[" + MARK + "]").forEach((b) => b.removeAttribute(MARK));
			};
		};

		// ------------------------------------------------------------ styles
		// The control looks like DSH's own composer controls (the model and access buttons): DSH's type, colours, size
		// and corners, no ground of its own. It sits where DSH puts composer controls, just before the model button, so the
		// order you see is the order Tab follows. DSH's effort caption on the model button hides only in a composer that
		// holds the control. In a narrow composer DSH shows its controls as icons; the control follows the same
		// switch (--dsh-composer-model-text-display / -icon-display) and shows its gauge.
		const CSS = `
.rp-root{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0}
.rp-trigger{display:inline-flex;align-items:center;gap:4px;height:28px;min-width:0;max-width:220px;padding:0 4px 0 8px;margin:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13,13px/20px system-ui,sans-serif);font-weight:400;white-space:nowrap;cursor:pointer;box-sizing:border-box;transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}
.rp-trigger:hover:not([aria-disabled="true"]),.rp-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.rp-trigger:active:not([aria-disabled="true"]){background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.rp-trigger[aria-disabled="true"]{cursor:default}
.rp-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.rp-label{display:var(--dsh-composer-model-text-display,inline);overflow:hidden;text-overflow:ellipsis;min-width:0}
.rp-gauge{display:var(--dsh-composer-model-icon-display,none);line-height:0}
.rp-i{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.rp-chev,.rp-trigger>svg{flex:none}
.rp-warn{display:inline-flex;flex:none;line-height:0;color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary))}
.rp-warn svg{width:14px;height:14px}
.rp-err{font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary));max-width:min(320px,40vw);white-space:normal}
.rp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.rp-fb{display:contents}
.rp-fb-menu{position:absolute;right:0;bottom:36px;z-index:100;display:flex;flex-direction:column;min-width:180px;padding:4px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary)}
.rp-fb-item{display:flex;align-items:center;min-height:32px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:var(--dsw-font-s-14,14px/22px system-ui,sans-serif);text-align:left;cursor:pointer}
.rp-fb-item:hover,.rp-fb-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.rp-fb-item[aria-checked="true"]{font-weight:500}
[data-slot="conversation.composer.bar"]:has(.rp-root) [data-slot="conversation.input.model"] [class*="_triggerEffort"]{display:none!important}
[${MARK}]{display:none!important}
body.wp-still .rp-trigger{transition:none!important}
@media (prefers-reduced-motion:reduce){.rp-trigger{transition:none!important}}
`;
		const installStyles = () => {
			const style = document.createElement("style");
			style.setAttribute("data-plugin", PACKAGE);
			style.setAttribute("data-plugin-css", PACKAGE + "/client.css");
			style.textContent = CSS;
			document.head.appendChild(style);
			return () => style.remove();
		};

		// ------------------------------------------------------------ apply
		function apply(ctx) {
			const safely = (what, run) => () => { try { return run(); } catch (e) { console.warn("reasoning-pill: " + what + " failed", e); return undefined; } };
			ctx.effect(safely("styles", installStyles), "reasoning-pill: styles");
			ctx.effect(safely("the Effort row", installEffortRowHider), "reasoning-pill: one reasoning control");
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({ name: "conversation.input.right", id: PACKAGE + ":control", order: 100, inject: (sessionId) => ({ ctx, sessionId }) }, ReasoningPill));
		}
		return { name: PACKAGE, inject: ["slots"], apply, logic: { viewOf, selectionFor, refusalOf, failureText, holdFor, wordsFor, isEffortLabel, isSubagent, hideEffortRows, addsMenu, EFFORT_LABELS, DEFAULT_ID, MARK, CSS } };
	},
});
