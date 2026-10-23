/**
 * dsh-plugin-neighbour, browser half: one entry in each place the suite's
 * plugins draw, so a test can prove a suite plugin shares them (DESIGN.md:
 * "Prove you coexist").
 *
 * - An entry in the panel list (order 1) and its page.
 * - A mark in the leading seat of the session rows a test names in
 *   localStorage (`dsh-plugin-neighbour/marked`, a JSON list of session
 *   ids), ahead of the suite's marks (order 5).
 * - An item in each session's ⋯ menu (order 55).
 * - A button in the sidebar's footer.
 *
 * Each carries a `data-neighbour` attribute for the test to find.
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({
    id: 'dsh-plugin-neighbour',
    factory: (require) => {
        const module = { exports: {} };
        Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const ui = require('@deepseek-ai/dsh-client-ui-primitives');
        const h = React.createElement;
        const PAGE = 'dsh-plugin-neighbour:page';
        const KEY = 'dsh-plugin-neighbour/marked';

        const marked = (sessionId) => {
            try {
                const list = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
                return Array.isArray(list) && list.includes(sessionId);
            } catch {
                return false;
            }
        };

        const Icon = () => h('span', { 'data-neighbour': 'icon', style: { display: 'inline-flex', width: '16px', height: '16px', borderRadius: '4px', border: '1.5px solid currentColor', boxSizing: 'border-box' } });
        const Page = () => h('div', { 'data-neighbour': 'page', style: { padding: '24px' } }, h('h1', null, 'Neighbour'));
        const Mark = ({ sessionId }) => (marked(sessionId)
            ? h('span', { 'data-neighbour': 'mark', style: { flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '16px', height: '20px' } },
                h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: 'currentColor' } }),
                h('span', { style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)' } }, 'Neighbour mark'))
            : null);
        function MenuItem({ useMenuOpenState }) {
            let close = () => {};
            try {
                const state = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined;
                if (Array.isArray(state) && typeof state[1] === 'function') close = () => state[1](false);
            } catch {}
            return ui.MenuItemButton ? h(ui.MenuItemButton, { onSelect: () => close(), 'data-neighbour': 'menu' }, 'Neighbour action') : null;
        }
        const Footer = () => h('button', { type: 'button', 'data-neighbour': 'footer', 'aria-label': 'Neighbour footer', style: { all: 'unset', cursor: 'pointer', padding: '4px' } }, h(Icon));

        function apply(ctx) {
            ctx.inject(['uiWorkspace'], (scope) => {
                scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: PAGE }, Page));
                scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: PAGE, order: 1, label: 'Neighbour' }, Icon));
                scope.slots.inject('sidebar.session.row.leading', () => scope.slots.register({ name: 'sidebar.session.row.leading', id: 'dsh-plugin-neighbour:mark', order: 5 }, Mark));
                scope.slots.inject('sidebar.workspaces.session.menu.item', () => scope.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'dsh-plugin-neighbour:menu', order: 55 }, MenuItem));
                scope.slots.inject('sidebar.footer.action', () => scope.slots.register({ name: 'sidebar.footer.action', id: 'dsh-plugin-neighbour:footer', order: 50 }, Footer));
            });
        }

        module.exports.inject = ['slots'];
        module.exports.apply = apply;
        return module.exports;
    },
});
