// A stand-in neighbour for Wallpaper's real-DSH test: one entry in DSH's panel list with its own page, and one
// button in the sidebar footer, added the way other plugins add theirs. The test checks that Wallpaper's look keeps
// each where DSH puts it, working and readable, and that switching Wallpaper off and on leaves them as they are.
if (typeof window !== "undefined" && window.__ModuleLoader__) window.__ModuleLoader__.load({
	id: "dsh-plugin-wallpaper-neighbour",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		const ID = "wpn-page";
		const Page = () => h("div", { "data-wallpaper-neighbour": "page", style: { padding: "32px 40px", maxWidth: 640 } },
			h("h1", { style: { margin: "0 0 12px", font: "var(--dsw-font-l-strong-20, 600 20px/28px var(--dsw-font-family))" } }, "Neighbour page"),
			h("p", { style: { margin: "0 0 8px", font: "var(--dsw-font-s-14, 14px/22px var(--dsw-font-family))" } }, "A page another plugin adds to DSH's panel list. Its words are in DSH's main text colour."),
			h("p", { "data-wallpaper-neighbour": "secondary", style: { margin: 0, font: "var(--dsw-font-xxs-12, 12px/18px var(--dsw-font-family))", color: "var(--dsw-alias-label-secondary)" } }, "A quieter line in DSH's secondary text colour."));
		const Icon = ({ size }) => h("svg", { viewBox: "0 0 24 24", width: size || 16, height: size || 16, "aria-hidden": "true", fill: "none", stroke: "currentColor", strokeWidth: 1.7 }, h("circle", { cx: 12, cy: 12, r: 7 }));
		const Foot = () => h("button", {
			type: "button", className: "wpn-foot", "aria-label": "Neighbour", title: "Neighbour",
			style: { width: 32, height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center", border: 0, padding: 0, background: "transparent", color: "inherit", cursor: "pointer" },
			onClick: () => { document.body.dataset.wpnClicked = String(Number(document.body.dataset.wpnClicked || 0) + 1); },
		}, h(Icon, { size: 18 }));
		function apply(ctx) {
			const reg = (slot, opts, comp) => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ...opts }, comp));
			reg("main", { key: ID }, Page);
			reg("sidebar.panellist", { id: ID, order: 20, label: () => "Neighbour" }, Icon);
			reg("sidebar.footer.action", { id: "wpn:foot", order: 80 }, Foot);
		}
		return { name: "dsh-plugin-wallpaper-neighbour", inject: ["slots"], apply };
	},
});
