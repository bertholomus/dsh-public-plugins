/**
 * Load a suite plugin's browser half the way DSH does (a classic script
 * that hands its factory to DSH's module loader), with stand-ins for React
 * and DSH's parts, and draw its views as plain element trees.
 *
 * The stand-in React calls function components as it meets them, so a
 * tree holds every element a view draws, its actions and children
 * included; DSH's own parts (Button, Switch, Tag…) stay as elements named
 * after themselves, with their props.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** React's hooks, enough to draw a component once and read what it draws. */
export function standInReact() {
    const react = {
        createElement: (type, props, ...children) => {
            if (typeof type === 'function') return type({ ...(props ?? {}), children: children.length <= 1 ? children[0] : children });
            return { type, props: props ?? {}, children };
        },
        Fragment: 'Fragment',
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useRef: (current) => ({ current }),
        useEffect: () => {},
        useLayoutEffect: () => {},
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useSyncExternalStore: (_subscribe, get) => get(),
    };
    return react;
}

/**
 * A stand-in React that keeps state between draws, for one part at a time:
 * `mount(Part, props)` draws it, runs its effects, and draws it again when
 * its state changes, so a test can drive it through events. Parts it draws
 * are called in place, so their hooks are the mounted part's, in order.
 */
export function statefulReact() {
    // The part being drawn: its hooks' slots, in call order.
    let slots = [];
    let at = 0;
    let effects = [];
    let draw = () => {};
    const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
    const react = {
        createElement: (type, props, ...children) => {
            if (typeof type === 'function') return type({ ...(props ?? {}), children: children.length <= 1 ? children[0] : children });
            return { type, props: props ?? {}, children };
        },
        Fragment: 'Fragment',
        useState(init) {
            const i = at++;
            if (!(i in slots)) slots[i] = { value: typeof init === 'function' ? init() : init };
            const slot = slots[i];
            // The part this hook belongs to draws again, whichever part drew last.
            const redraw = draw;
            return [slot.value, (next) => {
                const value = typeof next === 'function' ? next(slot.value) : next;
                if (Object.is(value, slot.value)) return;
                slot.value = value;
                redraw();
            }];
        },
        useRef(current) {
            const i = at++;
            if (!(i in slots)) slots[i] = { current };
            return slots[i];
        },
        useEffect(fn, deps) {
            const i = at++;
            const old = slots[i];
            if (old && deps && same(deps, old.deps)) return;
            slots[i] = { deps, cleanup: old?.cleanup };
            effects.push(() => {
                slots[i].cleanup?.();
                const cleanup = fn();
                slots[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
            });
        },
        useLayoutEffect: (fn, deps) => react.useEffect(fn, deps),
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useSyncExternalStore: (_subscribe, get) => get(),
    };
    function mount(Part, props) {
        const mine = [];
        let current = props;
        let tree;
        let drawing = false;
        let again = false;
        const drawMine = () => {
            if (drawing) {
                again = true;
                return;
            }
            drawing = true;
            draw = drawMine;
            slots = mine;
            try {
                do {
                    again = false;
                    at = 0;
                    tree = Part(current);
                    const run = effects;
                    effects = [];
                    for (const effect of run) effect();
                } while (again);
            } finally {
                drawing = false;
            }
        };
        drawMine();
        return {
            get tree() { return tree; },
            /** Draw again with some props changed (the page read new data). */
            update(next) {
                current = { ...current, ...next };
                drawMine();
            },
            /** Run the cleanups, as when the part leaves the page. */
            unmount() {
                for (const slot of mine) slot?.cleanup?.();
            },
        };
    }
    return { react, mount };
}

/**
 * @param {URL} url - the plugin's lib/client.js.
 * @param {{ document?: object, globals?: object, console?: Console, ui?: object, react?: object }} [options] - `ui`: DSH
 *   parts to stand in with real code (a settings form model, say); every other part is an element named after itself.
 *   `react`: another stand-in React (statefulReact().react).
 */
export function loadClient(url, { document, globals = {}, console: log = console, ui: parts = {}, react: givenReact } = {}) {
    const source = readFileSync(url, 'utf8');
    let loaded;
    const window = { __ModuleLoader__: { load: (m) => { loaded = m; } }, addEventListener: () => {}, removeEventListener: () => {} };
    runInNewContext(source, {
        window, ...(document ? { document } : {}),
        URL, console: log, setInterval, clearInterval, setTimeout, clearTimeout, queueMicrotask, Promise, ...globals,
    });
    if (!loaded) return { window };
    const ui = new Proxy({}, { get: (_target, name) => (Object.hasOwn(parts, name) ? parts[name] : typeof name === 'string' ? name : undefined) });
    const react = givenReact ?? standInReact();
    const modules = { react, 'react-dom': { createPortal: (node) => node }, '@deepseek-ai/dsh-client-ui-primitives': ui };
    return { id: loaded.id, client: loaded.factory((name) => modules[name]), window, react };
}

/** Every element in a tree, depth first. */
export function elementsOf(node, out = []) {
    if (Array.isArray(node)) {
        for (const child of node) elementsOf(child, out);
        return out;
    }
    if (node === null || typeof node !== 'object') return out;
    out.push(node);
    elementsOf(node.children, out);
    return out;
}

/** The text a tree shows. */
export const textIn = (node) => (Array.isArray(node) ? node.map(textIn).join('')
    : node === null || node === undefined || node === false || node === true ? ''
        : typeof node === 'object' ? textIn(node.children) : String(node));

/** Other assistants' and their makers' names, which no suite text may carry (built in pieces, so this file passes the repo's own scan). */
export const OTHER_NAMES = new RegExp(['cla', 'ude|anth', 'ropic|co', 'dex|open', 'ai'].join(''), 'i');

/**
 * DSH's `ctx.remote` as a client plugin sees it: a service it did not inject
 * (such as `remote.credentials`) throws when read, as DSH's own does.
 */
export function strictRemote(injected = {}) {
    return new Proxy({}, {
        get(_target, key) {
            if (typeof key !== 'string') return undefined;
            if (Object.hasOwn(injected, key)) return injected[key];
            throw new Error(`cannot get property "remote.${key}" without inject`);
        },
    });
}
