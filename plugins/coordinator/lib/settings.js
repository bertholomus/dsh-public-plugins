/**
 * Model and effort settings, and access settings, for the threads a
 * coordinating chat starts. Two model settings: thread model and thread
 * effort. Each resolves from the first layer that sets it:
 *
 *   the chat's own setting (its Thread settings dialog, or the
 *   thread_settings tool) → the plugin's defaults (its page in DSH, or
 *   its row in cordis.patch.yml) → DSH default
 *
 * A thread fixes its model and effort when it starts (start arguments win
 * over the thread defaults), and keeps them until changed with
 * thread_update, the dialog or its own model picker. The coordinating chat
 * itself runs on whatever the user picks in it, as any chat does. Pure
 * functions, no host imports.
 *
 * @module dsh-plugin-coordinator/settings
 */

export const SETTING_KEYS = ['threadModel', 'threadEffort'];

/**
 * Access settings, layered the same way: which threads may use the user's
 * own tools (config.guardedTools), and the DSH permission preset new threads
 * start on.
 *
 *   yourTools: "asked" gives a thread only the user's tools their own words
 *     for it name; "always" gives every thread all of them.
 *   threadPermission: one of DSH's permission presets (read-only,
 *     workspace-write, danger-full-access), or "default" for DSH's default
 *     for new sessions.
 *
 * Without any setting they are the plugin's own defaults below, not DSH's:
 * threads start on Workspace Write. Only the user changes them (Thread
 * settings, the plugin's page, the profile); no tool does. The coordinating
 * chat keeps the user's tools and its own permission.
 */
export const ACCESS_KEYS = ['yourTools', 'threadPermission'];
export const TOOL_MODES = ['asked', 'always'];
export const ACCESS_DEFAULTS = Object.freeze({ yourTools: 'asked', threadPermission: 'workspace-write' });

const set = (v) => typeof v === 'string' && v.trim() !== '';

/** A config value DSH hands over as a live reference (`{get()}`), read now; a plain value as it is. */
export const liveValue = (v) => (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v);

/**
 * The plugin-wide defaults as plain values. DSH hands them over as live
 * references because its settings page edits them while the plugin runs; a
 * test or an older DSH hands over plain strings.
 * @param {object} config - plugin config.
 * @returns {Record<string, string|undefined>}
 */
export function pluginDefaults(config = {}) {
    return Object.fromEntries([...SETTING_KEYS, ...ACCESS_KEYS].map((key) => [key, liveValue(config[key])]));
}

/** An access value a layer sets, or undefined: yourTools takes "asked" or "always", a permission any preset name. */
function accessValue(key, v) {
    if (!set(v)) return undefined;
    const value = v.trim();
    if (key === 'yourTools') return TOOL_MODES.includes(value.toLowerCase()) ? value.toLowerCase() : undefined;
    return value;
}

/**
 * Resolve the access settings and where each came from: the chat's own
 * setting, the plugin's defaults (set on its page, or the built-in
 * ACCESS_DEFAULTS).
 * @returns {Record<string, {value: string, source: string}>}
 */
export function effectiveAccess(plugin = {}, overrides = {}) {
    const out = {};
    for (const key of ACCESS_KEYS) {
        const own = accessValue(key, overrides[key]);
        if (own !== undefined) out[key] = { value: own, source: 'chat setting' };
        else out[key] = { value: accessValue(key, plugin[key]) ?? ACCESS_DEFAULTS[key], source: 'plugin default' };
    }
    return out;
}

/**
 * Resolve the model settings and where each came from.
 * @param {object} plugin - plugin config (top-level defaults).
 * @param {object} overrides - the chat's own settings, from the store.
 * @returns {Record<string, {value: string|undefined, source: string}>}
 */
export function effectiveSettings(plugin = {}, overrides = {}) {
    const out = {};
    for (const key of SETTING_KEYS) {
        if (set(overrides[key])) out[key] = { value: overrides[key].trim(), source: 'chat setting' };
        else if (set(plugin[key])) out[key] = { value: plugin[key].trim(), source: 'plugin default' };
        else out[key] = { value: undefined, source: 'DSH default' };
    }
    return out;
}

/**
 * Parse "provider:model", "provider/model" or a bare model id.
 * @param {string} spec
 * @param {string} fallbackProvider - provider for a bare id.
 * @returns {{provider: string, model: string}|null}
 */
export function parseModelSpec(spec, fallbackProvider) {
    const value = String(spec ?? '').trim();
    if (value === '') return null;
    const m = value.match(/^([a-zA-Z0-9_-]+)[:/](.+)$/);
    if (m) return { provider: m[1], model: m[2] };
    return { provider: fallbackProvider, model: value };
}

/**
 * Rewrite one resolved model request config with a thread's route. An unset
 * model leaves the request's model alone. A set model without an effort runs
 * at that model's own default effort, as a DSH model selection does.
 * @param {object} resolved - config proposed by the `agent/request` waterfall.
 * @param {string|undefined} modelSpec
 * @param {string|undefined} effort
 */
export function applyRoute(resolved, modelSpec, effort) {
    const next = { ...resolved };
    const parsed = set(modelSpec) ? parseModelSpec(modelSpec, next.provider) : null;
    if (parsed) {
        next.provider = parsed.provider;
        next.model = parsed.model;
        delete next.reasoningEffort;
    }
    if (set(effort)) next.reasoningEffort = effort.trim();
    return next;
}

/** Every model in a catalog as {provider, model, efforts}. */
function catalogModels(catalog) {
    const out = [];
    for (const group of catalog?.groups ?? []) {
        for (const model of group.models ?? []) {
            out.push({ provider: group.id, model: model.id, efforts: (model.reasoning?.efforts ?? []).map((e) => e.id) });
        }
    }
    return out;
}

/** Effort names from least to most reasoning; others rank by where models list them. */
const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The level a model offers that comes closest to an effort it doesn't: the
 * highest one at or below it (max → high), else its lowest one.
 * @param {string[]} offered - the model's efforts.
 * @param {string} effort - the wanted effort, offered by some other model.
 * @param {string[]} known - every effort in the catalog, in listing order.
 */
function nearestEffort(offered, effort, known) {
    const rank = (e) => {
        const i = EFFORT_ORDER.indexOf(e);
        return i >= 0 ? i : EFFORT_ORDER.length + known.indexOf(e);
    };
    const below = offered.filter((e) => rank(e) <= rank(effort)).sort((a, b) => rank(b) - rank(a));
    return below[0] ?? [...offered].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Check a model spec and effort against the host model catalog, and return
 * the canonical "provider:model". With no catalog, accept as given. A model
 * with no effort levels drops the effort and says so in `note`, so a
 * chat-wide effort default does not break threads on such a model.
 *
 * `fit` says what to do with an effort the model doesn't offer. Strict
 * (false) refuses it, for a value someone is setting now. 'known' runs the
 * nearest level the model offers and says so, but still refuses an effort no
 * model offers. true never refuses over effort: an inherited default must
 * not stop a thread from starting because the DSH default model changed.
 * @param {object|undefined} catalog - sessionController.modelCatalog() value.
 * @param {string|undefined} modelSpec - requested model, or undefined to keep the default.
 * @param {string|undefined} effort - requested effort, or undefined.
 * @param {{fit?: boolean|'known'}} [options]
 * @returns {{ok: true, model?: string, effort?: string, note?: string, fitted?: boolean} | {ok: false, error: string}}
 */
export function checkSelection(catalog, modelSpec, effort, { fit = false } = {}) {
    const models = catalogModels(catalog);
    const fallbackProvider = catalog?.default?.provider ?? '';
    let entry = null;
    let model;
    if (set(modelSpec)) {
        const value = modelSpec.trim();
        const explicit = /^([a-zA-Z0-9_-]+)[:/](.+)$/.test(value);
        const parsed = parseModelSpec(value, fallbackProvider);
        if (models.length > 0) {
            const hits = explicit
                ? models.filter((m) => m.provider === parsed.provider && m.model === parsed.model)
                : models.filter((m) => m.model === parsed.model);
            entry = hits.find((m) => m.provider === fallbackProvider) ?? hits[0] ?? null;
            if (!entry) {
                const sample = models.slice(0, 12).map((m) => `${m.provider}:${m.model}`).join(', ');
                return { ok: false, error: `unknown model "${value}". Available: ${sample}${models.length > 12 ? ', ...' : ''}` };
            }
            model = `${entry.provider}:${entry.model}`;
        } else {
            model = explicit || !fallbackProvider ? value : `${fallbackProvider}:${value}`;
        }
    } else if (catalog?.default) {
        entry = models.find((m) => m.provider === catalog.default.provider && m.model === catalog.default.model) ?? null;
    }
    if (set(effort)) {
        const e = effort.trim();
        const known = [...new Set(models.flatMap((m) => m.efforts))];
        const unknown = known.length > 0 && !known.includes(e);
        const name = entry ? `${entry.provider}:${entry.model}` : '';
        if (unknown && fit !== true) {
            return { ok: false, error: `effort "${e}" is not offered by any model. Efforts in this DSH: ${known.join(', ')}` };
        }
        if (entry && entry.efforts.length === 0) {
            return { ok: true, ...(model ? { model } : {}), note: `${name} has no effort levels, so effort "${e}" is not used` };
        }
        if (entry && !entry.efforts.includes(e)) {
            if (!fit) return { ok: false, error: `effort "${e}" is not offered by ${name}. Choose one of: ${entry.efforts.join(', ')}` };
            if (unknown) return { ok: true, ...(model ? { model } : {}), fitted: true, note: `effort "${e}" is not offered by any model, so ${name} runs at its default effort` };
            const near = nearestEffort(entry.efforts, e, known);
            return { ok: true, ...(model ? { model } : {}), effort: near, fitted: true, note: `${name} doesn't offer effort "${e}", so it runs at "${near}"` };
        }
        return { ok: true, ...(model ? { model } : {}), effort: e };
    }
    return { ok: true, ...(model ? { model } : {}) };
}

/** One-line description of a model/effort pair for the model and the user. */
export function describeRoute(model, effort) {
    return `${model ?? 'DSH default model'} · effort ${effort ?? 'default'}`;
}
