/**
 * The coordinator runtime. Any chat coordinates once the user runs
 * /coordinate in it (or clicks Coordinate in its header): from then on it
 * starts thread sessions with the plugin's tools, threads report back to it
 * with handbacks, and both are ordinary DSH sessions, so they show live in
 * the DSH window. The store keeps each coordinating chat under its own
 * session id, as a "project" of its threads, and /coordinate off stops it
 * (its threads keep running; their reports wait until it coordinates again).
 *
 * The behaviour is attached to the live Agent, not to the session file: on
 * every `agent/created` (fresh, resumed, cleared) the manager looks the
 * session up in the store and installs agent-scoped tools, a system prompt
 * section and, for threads, the idle watcher and the guards. Other sessions
 * never see any of it.
 *
 * The coordinating chat keeps the user's own access: its model, permission
 * and tools stay whatever the user gives it, as in any chat. Threads are
 * held to more. Their models and effort are set the way the DSH model
 * picker sets them: a durable `model/selection` on the one session, so the
 * DSH window shows the right model. The picker's public path
 * (`sessionController.selectModel`) also overwrites the global default
 * model, so the manager calls the controller's per-session step directly.
 * When a Host does not have that step, it falls back to rewriting every
 * model request of thread sessions. A model or permission the user picks in
 * DSH's own menus for a thread becomes that thread's.
 *
 * The user's own tools (config.guardedTools: their MCP servers for
 * passwords, notes, lanes and the like) stay out of threads under yourTools
 * "asked": the manager leaves them out of what a thread's model is offered
 * (DSH's per-agent tools.restrict) and refuses a call to one anyway
 * (tools.guard). A thread gets the ones the user's own words for it name,
 * checked against what the user wrote in the coordinating chat.
 *
 * The plugin's messages go into a session the way DSH's own agents and
 * plugins send theirs, not as the user's: a brief or a coordinator's message
 * is an agent's message from the coordinating chat, a handback one from the
 * thread, and the automatic notes are a plugin's message. DSH draws each as
 * a collapsed notice ("Task message received", "Plugin status updated")
 * instead of a user bubble; the model reads the same text.
 *
 * @module dsh-plugin-coordinator/projects
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ProjectStore, expand, dataPath, ensurePrivateDir } from './store.js';
import {
    SETTING_KEYS, ACCESS_KEYS, TOOL_MODES, effectiveSettings, effectiveAccess, applyRoute, checkSelection, describeRoute, parseModelSpec, pluginDefaults, liveValue,
} from './settings.js';
import {
    coordinatorPolicy, threadPolicy, rosterLines, briefMessage, coordinatorMessage, cardSummary,
    handbackMessage, idleMessage, approvalMessage, questionMessage, userMustFix, describeEnding, endingStateOf, continueMessage, HANDBACK_STATUSES, TAGS, STOPPED_BY_USER, NUDGE,
    IDLE_NUDGE, outsideMessage, replyMessage, declinedResult, UNTITLED_CHAT,
} from './prompts.js';
import { META_MARK, MAX_THREADS, PROJECTION_KEY } from './projection.js';
import { changeRecord, changeTotals, withChange, editsIn, editOf, editSummary, FILE_TOOLS, diffFiles, subagentsIn, placeIn, MAX_NET_CHARS, MAX_VIEW_CHARS } from './changes.js';
import { NetTexts, changedPath, canonicalPath, notKept, expectedAfter, NET_SWEEP_MS } from './net.js';
import { sendOf, codeSendOf, described, withoutCredentials } from './sends.js';
import { grantsIn, asksFor as asksToDo, doing } from './grants.js';
import { deletesOf, codeDeletesOf, deletesWhat, isFree, madeDirsOf, identityOf, isSame, bornOf, CLOCK_SLACK_MS } from './deletes.js';
import { SHELL_TOOLS, MUTATING_TOOLS, snapshotFolder, diffFolder, Mutations } from './shell.js';

/** Order of the project section in the assembled system prompt (after first-party guidance). */
const SECTION_ORDER = 9500;
const HOUR = 60 * 60 * 1000;
/** DSH keeps a session title to 80 bytes of UTF-8 (`maxTitleBytes` in its base profile) and cuts anything longer. */
const TITLE_BYTES = 80;
/** The command that makes a chat coordinate: `/coordinate`, and `/coordinate off` to stop. */
export const COMMAND = 'coordinate';

/**
 * A thread's one title, used for its session and everywhere the plugin names it. It fits DSH's session-title
 * limit, so DSH never cuts it again; a longer title is cut once, after the last whole word that fits, with "…".
 * `cut` says the text was already cut short (by an older version), so it ends at a word with "…" even if it fits.
 */
export function clipTitle(value, { cut = false } = {}) {
    const line = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!cut && Buffer.byteLength(line) <= TITLE_BYTES) return line;
    const room = TITLE_BYTES - Buffer.byteLength('…');
    let fit = '';
    let bytes = 0;
    for (const char of line) {
        bytes += Buffer.byteLength(char);
        if (bytes > room) break;
        fit += char;
    }
    // Back up to the end of the last whole word, unless that would leave less than half.
    if (fit.length < line.length ? line[fit.length] !== ' ' : cut) {
        const space = fit.lastIndexOf(' ');
        if (space >= fit.length / 2) fit = fit.slice(0, space);
    }
    const end = fit.replace(/[\s.,;:!?…–—-]+$/u, '');
    return `${end === '' ? fit : end}…`;
}

/** Delivery retry delays for a coordinator that cannot take a message; tests shorten them. */
export const timing = { retryMs: 60000, maxRetryMs: 15 * 60000 };

/** What thread_handback returns. The idle review counts a turn as handed back by these texts. */
const HANDBACK_SENT = 'Handback delivered to the coordinator.';
const HANDBACK_HELD = 'Handback saved; the coordinator gets it when it takes reports again.';
const HANDBACK_RETRY = 'Handback saved; the coordinator could not take it just now, and it is sent again automatically.';
const QUESTION_SENT = 'Asked. Carry on with what doesn\'t depend on the answer; it arrives here as a message from the coordinator. If nothing can go on without it, end your turn with one short line.';
const QUESTION_HELD = 'Saved; the coordinator gets it when it takes reports again. Pick a sensible default, say which, and carry on.';
const QUESTION_RETRY = 'Saved; the coordinator could not take it just now, and it is sent again automatically. Carry on with what doesn\'t depend on the answer.';
/** Why work for an archived chat is refused, by its tools and in the window. */
const ARCHIVED = 'this chat is archived; unarchive it first';
/** Why work for a chat that stopped coordinating is refused in the window. */
const STOPPED = 'this chat stopped coordinating; run /coordinate in it first';
/** DSH's tools that run a command or code: what they send outside the workspace waits for the user (holdSend). */
const SEND_TOOLS = new Set(['bash', 'pwsh', 'run_code']);
/** The largest script or package.json the send check reads to see what a command runs. */
const MAX_SCRIPT_BYTES = 256 * 1024;
/** What a thread hears of a send held or refused: another route to it is still it (behaviour run S3 r2 copied the script and ran the copy). */
const SAME_SEND = 'a copy or a wrapper of it (another script, a copied file, a different client) is the same send, and waits for the same answer';
/** Why a thread's command that sends didn't run, by who tried it; `what` says what it sends ("sends a POST to …"). */
const SEND_REASONS = {
    subagent: (what) => `Not run: the command ${what}. A subagent doesn't send anything outside the workspace: say in your result what you would send, and the thread you work for asks the user first.`,
    never: (what) => `Not run: the command ${what}. A thread asks the user before each command that sends outside the workspace, and this thread's permission never asks. Hand back with status needs_decision and say exactly what you would send; the user can put this thread on Workspace Write so it can ask. Don't send it another way: ${SAME_SEND}.`,
    pending: (what) => `Not run: the command ${what}. Another command of yours that sends, from the same step, went to the user first, and a thread asks them about one send at a time, so nobody was asked about this one. Read their answer in that command's result: if they allowed it, run this one again only if it is still needed; if they rejected it, hand back and don't send another way. Here too, ${SAME_SEND}.`,
};
/** Why a thread's command that deletes didn't run, by who tried it; `what` says what it deletes ("deletes build/ (rm)"). */
const DELETE_REASONS = {
    subagent: (what) => `Not run: the command ${what}. A subagent doesn't delete files its thread didn't create: say in your result what you would delete, and the thread you work for asks the user first.`,
    never: (what) => `Not run: the command ${what}. A thread asks the user before each command that deletes files it didn't create, and this thread's permission never asks. Hand back with status needs_decision and say exactly what you would delete; the user can put this thread on Workspace Write so it can ask. Don't delete it another way.`,
};

/**
 * What the thread says its call is for, for the prompt: its description and,
 * when it asks for a wider sandbox, its justification, each one line, quoted
 * and without credentials. The plugin's own line comes before it.
 */
function threadWords(args) {
    const line = (value, max) => (typeof value === 'string' ? cardSummary(withoutCredentials(value).replace(/\s+/g, ' ').trim(), max) : '');
    const said = line(args?.description, 160);
    const why = typeof args?.sandbox_permissions === 'string' ? line(args.justification, 200) : '';
    if (!why) return said && `"${said}"`;
    return said ? `"${said}" and, for wider access, "${why}"` : `for wider access, "${why}"`;
}

/** DSH's tools that reach an MCP server named in their `server` argument, not in their own name. */
const SERVER_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A coordinating chat's name as the store keeps it (its title), trimmed; '' when the store holds none. */
const storedName = (stored) => (typeof stored?.name === 'string' ? stored.name.trim() : '');

/** The newest manager per store file. One left over from a config reload hands late work to it. */
const managers = new Map();
/** Every manager not yet disposed. */
const liveManagers = new Set();
/** Archives and restores in flight, by store file and project: one at a time, and DSH's own archive set changing meanwhile is theirs. */
const archiving = new Map();

/** Whether a session read failed because the session does not exist, not for another reason. */
function isNotFound(error) {
    return error?.constructor?.name === 'ApiSessionNotFound' || error?.code === 'session/not-found'
        || /not[ -]found/i.test(String(error?.message ?? ''));
}

/**
 * config.guardedTools as [name, aliases] pairs. It is a list of MCP server
 * (or tool) names, or a map from each name to the words the user may call
 * it by, such as "lane-catalog": ["lanes", "model lanes"].
 */
export function guardList(guardedTools) {
    const entries = Array.isArray(guardedTools) ? guardedTools.map((name) => [name, []]) : Object.entries(guardedTools ?? {});
    return entries
        .map(([name, aliases]) => [String(name ?? '').trim(), (Array.isArray(aliases) ? aliases : []).map((a) => String(a ?? '').trim()).filter(Boolean)])
        .filter(([name]) => name);
}

/** Text as lower-case words between spaces: "-", "_" and other marks all separate words. */
const wordsOf = (text) => ` ${String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** Whether words (from wordsOf) hold a name as whole words, also in the plural. */
function holds(words, name) {
    const w = wordsOf(name).trim();
    return w !== '' && [` ${w} `, ` ${w}s `, ` ${w}es `].some((form) => words.includes(form));
}

/**
 * Whether the user's words ask for a name: as whole words, in any case and
 * also in the plural, and never inside a file or identifier name. A dot,
 * hyphen or underscore with a letter or digit on both sides joins them, so
 * "my calendar.js" and "my-calendar" don't ask for "my calendar". A mark in
 * the name itself may be a space too: "lane catalog" asks for lane-catalog.
 */
function asksFor(text, name) {
    const parts = String(name ?? '').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').split(/([^\p{L}\p{N}]+)/u).filter(Boolean);
    if (parts.length === 0) return false;
    const body = parts.map((part) => (/^[\p{L}\p{N}]+$/u.test(part) ? part : /\s/u.test(part) ? '\\s+' : '[\\s._-]+')).join('');
    return new RegExp(`(?<![\\p{L}\\p{N}]|[\\p{L}\\p{N}][._-])${body}(?:e?s)?(?![\\p{L}\\p{N}]|[._-][\\p{L}\\p{N}])`, 'iu').test(String(text ?? ''));
}

/**
 * The user's answers in DSH's question box (ask_user_question) in a
 * session's log: the options they picked and what they typed. The tool's
 * result is the answers as JSON ({answers: [{id, selected, custom?}]}).
 */
export function questionAnswers(events) {
    const asked = new Set();
    const out = [];
    for (const event of Array.isArray(events) ? events : []) {
        const data = event?.data;
        if (event?.type === 'tool/call' && data?.name === 'ask_user_question' && typeof data.callId === 'string') {
            asked.add(data.callId);
            continue;
        }
        if (event?.type !== 'tool/result' || !asked.has(data?.message?.toolCallId) || data.error !== undefined || data.message.isError === true) continue;
        const text = (Array.isArray(data.message.content) ? data.message.content : []).find((b) => b?.type === 'text')?.text;
        let parsed;
        try { parsed = JSON.parse(text); } catch { continue; }
        for (const answer of Array.isArray(parsed?.answers) ? parsed.answers : []) {
            for (const picked of Array.isArray(answer?.selected) ? answer.selected : []) if (typeof picked === 'string') out.push(picked);
            if (typeof answer?.custom === 'string') out.push(answer.custom);
        }
    }
    return out;
}

/**
 * The guarded tools a text names: by name, also inside a tool id such as
 * mcp__lane-catalog__lanes_status, and with `aliases`, the user's words
 * asking for one by its name or the words they may call it by (asksFor:
 * never inside a file or identifier name). A brief uses a tool when it
 * names it; the user's words ask for one when they name it or an alias. A
 * group another plugin marks as the user's own (withPersonal) is named
 * only by its words, never by its bare name: a brief about a date picker
 * doesn't use "calendar".
 */
export function guardedIn(text, guard, { aliases = false } = {}) {
    if (aliases) return guard.filter(([name, alias, mark]) => (mark ? alias : [name, ...alias]).some((a) => asksFor(text, a))).map(([name]) => name);
    const words = wordsOf(text);
    return guard.filter(([name, alias, mark]) => (mark ? alias.some((a) => holds(words, a)) : holds(words, name))).map(([name]) => name);
}

/**
 * A tool's `personal` mark, as the plugin that registers the tool sets it
 * on its definition: the group of the user's own tools it belongs to, and
 * the words that count as the user asking for them. `personal: 'calendar'`
 * is `{ name: 'calendar' }`, whose word is "my calendar". A mark that names
 * no group puts the tool in a group of its own.
 * @returns {{name: string, words: string[]}|undefined}
 */
export function personalMark(value, toolName) {
    if (value === undefined || value === null || value === false) return undefined;
    const given = typeof value === 'string' ? value : isObject(value) && typeof value.name === 'string' ? value.name : '';
    const name = wordsOf(given).trim().replace(/ /g, '-') || String(toolName ?? '').trim();
    if (name === '') return undefined;
    const listed = isObject(value) && Array.isArray(value.words) ? value.words.map((w) => String(w ?? '').trim()).filter(Boolean) : [];
    return { name, words: listed.length > 0 ? listed : [`my ${name.replace(/-/g, ' ')}`] };
}

/**
 * The guard list with the tools other plugins mark as the user's own
 * (personalMark), whether or not guardedTools lists them. Each group
 * covers the tools that carry its mark and is named only by its words; a
 * guardedTools entry of the same name adds its words, and keeps covering
 * the tools its name names.
 * @param {Array} guard - guardList's [name, aliases] pairs.
 * @param {Array} marked - [tool name, mark] pairs.
 * @returns {Array} [name, words, {tools, listed}?] entries; the third only for a marked group.
 */
export function withPersonal(guard, marked) {
    if (marked.length === 0) return guard;
    const groups = new Map();
    for (const [tool, mark] of marked) {
        const group = groups.get(mark.name) ?? { words: [], tools: new Set() };
        for (const word of mark.words) if (!group.words.includes(word)) group.words.push(word);
        group.tools.add(tool);
        groups.set(mark.name, group);
    }
    const out = guard.map(([name, aliases]) => {
        const key = wordsOf(name).trim().replace(/ /g, '-');
        const group = groups.get(key);
        if (!group) return [name, aliases];
        groups.delete(key);
        return [name, [...new Set([...aliases, ...group.words])], { tools: group.tools, listed: true }];
    });
    for (const [name, group] of groups) out.push([name, group.words, { tools: group.tools, listed: false }]);
    return out;
}

/** A thread's latest tool calls, newest last, each with the argument that says what it touched: 'bash "npm test"; read "src/a.js"'. */
function stepsOf(events, max = 8) {
    const calls = events.filter((e) => e?.type === 'tool/call' && typeof e.data?.name === 'string').slice(-max);
    return calls.map((e) => {
        const args = argsOf(e.data.arguments);
        const what = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'thread', 'question']
            .map((key) => args?.[key]).find((v) => typeof v === 'string' && v.trim() !== '');
        return what ? `${e.data.name} ${JSON.stringify(what.replace(/\s+/g, ' ').slice(0, 80))}` : e.data.name;
    }).join('; ');
}

/** The files a thread's turns changed, merged by path: "src/a.js (+3 −1), README.md (+10 −0)", or ''. */
function changedFiles(records, max = 12) {
    const byPath = new Map();
    for (const r of Array.isArray(records) ? records : []) {
        for (const f of Array.isArray(r?.files) ? r.files : []) {
            if (typeof f?.path !== 'string' || f.path === '') continue;
            const was = byPath.get(f.path) ?? { added: 0, deleted: 0 };
            byPath.set(f.path, { added: was.added + (Number(f.added) || 0), deleted: was.deleted + (Number(f.deleted) || 0) });
        }
    }
    const list = [...byPath].slice(0, max).map(([path, n]) => `${path} (+${n.added} −${n.deleted})`);
    return list.length === 0 ? '' : `${list.join(', ')}${byPath.size > max ? `, and ${byPath.size - max} more` : ''}`;
}

/** Whether a folder is the user's home folder, where threads must not scatter files. */
const isHome = (folder) => typeof folder === 'string' && expand(folder).replace(/\/+$/, '') === homedir().replace(/\/+$/, '');

/** The plugin's own tools, never taken for one of the user's even when a guarded name is a word in them. */
const OWN_TOOLS = new Set(['shared_notes', 'thread_handback', 'thread_ask', 'thread_start', 'thread_send', 'thread_list', 'thread_read', 'thread_update', 'thread_settings', 'chat_message']);

/** Text as its words alone (lower case, no punctuation), to find an ask in what the user wrote. */
const wordsKey = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The first sentence of an `ask` that isn't in what the user wrote, or '':
 * each must be there word for word (case and punctuation aside), so the
 * user's sentences may come from different messages but none may be the
 * coordinator's own.
 */
export function unsaidPart(ask, said) {
    const corpus = ` ${wordsKey(said)} `;
    for (const part of String(ask ?? '').split(/[.!?;…]+(?=\s|$)|\n+/)) {
        const key = wordsKey(part);
        if (key !== '' && !corpus.includes(` ${key} `)) return part.trim();
    }
    return '';
}

/** What a handback's card shows of its summary, in characters. */
const CARD_CHARS = 300;

/** Messages to other chats that wait for their reply: at most this many per coordinating chat, for this long. */
const MAX_AWAITING = 20;
/**
 * What the user hears about from anywhere in the window (the coordinating
 * chat's row mark and a notice): a thread handed back, finished its turn
 * without one, waits on the user's approval, or failed or stopped after its
 * nudge. The newest are kept per coordinating chat.
 */
export const NEWS_KINDS = ['handback', 'finished', 'approval', 'failed', 'stopped'];
const MAX_NEWS = 20;
const AWAIT_MS = 24 * 60 * 60 * 1000;

/**
 * The guarded names a tool falls under: the ones its name holds
 * (mcp__lane-catalog__lanes_status holds lane-catalog), and the group its
 * own `personal` mark puts it in.
 */
const guardsOfTool = (name, guard) => (typeof name === 'string' && !OWN_TOOLS.has(name)
    ? guard.filter(([g, , mark]) => mark?.tools.has(name) || ((!mark || mark.listed) && holds(wordsOf(name), g))).map(([g]) => g)
    : []);

/** What a thread's call to one of the user's tools it may not use returns, before the call reaches the tool. */
const WALL_REASON = 'This is one of the user\'s own tools, and the user\'s words for this thread don\'t name it. If the task needs it, hand back with status blocked and say so.';

/** One thread as the DSH window shows it in a roster (see projection.js). */
function rosterEntry(id, t) {
    const entry = { id, session: t.sessionId, title: t.title, resolved: t.resolved === true };
    if (t.createdAt) entry.created = t.createdAt;
    if (t.lastHandback) entry.handback = { status: t.lastHandback.status, summary: cardSummary(t.lastHandback.summary, 300), at: t.lastHandback.at ?? null };
    return entry;
}

/** Thread ids for a full roster: every open thread, then the newest resolved ones. */
function rosterIds(threads) {
    const ids = Object.keys(threads ?? {}).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const open = ids.filter((id) => !threads[id].resolved);
    const resolved = ids.filter((id) => threads[id].resolved).slice(-Math.max(MAX_THREADS - open.length, 0));
    const keep = new Set([...open, ...resolved]);
    return ids.filter((id) => keep.has(id));
}

/** The handbacks among the messages a pause holds: which thread, with what status. */
function heldHandbacks(pending) {
    const out = [];
    for (const item of Array.isArray(pending) ? pending : []) {
        const text = typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '';
        const m = /^\[Handback from thread (t\d+) · ".*" · status: ([a-z_]+)\]$/.exec(text.split('\n', 1)[0]);
        if (m) out.push({ thread: m[1], status: m[2] });
    }
    return out;
}

/**
 * A file's text for the send check: a regular file of at most
 * MAX_SCRIPT_BYTES inside one of the folders (links followed), else
 * undefined. Nothing outside the workspace is read.
 */
function textInside(roots, path) {
    try {
        const full = realpathSync(path);
        const inside = roots.some((root) => {
            let real;
            try { real = realpathSync(root); } catch { return false; }
            return full === real || full.startsWith(real.endsWith(sep) ? real : `${real}${sep}`);
        });
        if (!inside) return undefined;
        const stat = statSync(full);
        return stat.isFile() && stat.size <= MAX_SCRIPT_BYTES ? readFileSync(full, 'utf8') : undefined;
    } catch {
        return undefined;
    }
}

/** Arguments of a logged tool call: an object, or JSON text. */
function argsOf(value) {
    if (typeof value !== 'string') return value ?? {};
    try { return JSON.parse(value); } catch { return {}; }
}

/** A session's own events from DSH's inspect: a forked session's log starts with its parent's, which aren't its own. */
function ownEvents(inspected) {
    const events = Array.isArray(inspected?.events) ? inspected.events : [];
    const inherited = Number.isSafeInteger(inspected?.inheritedEventCount) ? inspected.inheritedEventCount : 0;
    return inherited > 0 ? events.slice(inherited) : events;
}

/** Text of one message-like session event, or ''. */
function textOf(event) {
    const content = (event?.data?.message ?? event?.data)?.content;
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

/** Role of one message-like session event, or null. */
function roleOf(event) {
    const role = event?.data?.message?.role;
    if (role) return role;
    if (event?.type === 'assistant/message') return 'assistant';
    if (event?.type === 'user/message') return 'user';
    return null;
}

/** Request ids of the prompts earlier versions sent as the user's; they mark coordinator-driven turns. */
const RPC_PREFIX = 'projects-';

/** Who a plugin message comes from, as DSH records its own: an agent (a session) or a plugin. */
const agentSource = (senderSessionId) => ({ kind: 'agent-message', form: 'relay', senderSessionId });
const PLUGIN_SOURCE = Object.freeze({ kind: 'cordis-host-runner' });
const PLUGIN_KINDS = new Set(['agent-message', PLUGIN_SOURCE.kind]);
const PROJECT_TAGS = Object.values(TAGS);

/**
 * A prompt someone sent to the session, or null. The user's own messages
 * have source kind "user"; so did this plugin's before it sent them as an
 * agent's or a plugin's message. Other user-role messages DSH adds (runtime
 * context, model-change notices, its own agents' messages) are not prompts.
 */
function promptOf(event) {
    if (roleOf(event) !== 'user') return null;
    const source = (event?.data?.message ?? event?.data)?.source;
    const text = textOf(event);
    if (!text) return null;
    if (source?.kind === undefined || source.kind === 'user') {
        const fromProject = String(source?.rpcId ?? '').startsWith(RPC_PREFIX) || text.startsWith(TAGS.brief) || text.startsWith(TAGS.coordinator);
        return { text, fromProject };
    }
    if (PLUGIN_KINDS.has(source.kind) && PROJECT_TAGS.some((tag) => text.startsWith(tag))) return { text, fromProject: true };
    return null;
}

/**
 * Where one turn sits in a session log. `current` is the turn running now;
 * otherwise the last turn that ended. A log without turn markers counts as
 * one turn. Returns event indexes [start, end), the end reason and whether
 * the turn has ended.
 */
function turnRange(events, current) {
    const lastIndex = (type, before) => {
        for (let i = before - 1; i >= 0; i--) if (events[i]?.type === type) return i;
        return -1;
    };
    const lastEnd = lastIndex('turn/end', events.length);
    if (current) {
        const lastStart = lastIndex('turn/start', events.length);
        return { start: lastStart > lastEnd ? lastStart : lastEnd + 1, end: events.length, ended: false };
    }
    if (lastEnd < 0) return { start: Math.max(lastIndex('turn/start', events.length), 0), end: events.length, ended: false };
    const start = Math.max(lastIndex('turn/start', lastEnd), lastIndex('turn/end', lastEnd) + 1);
    return { start, end: lastEnd + 1, reason: events[lastEnd].data?.reason ?? null, ended: true };
}

/** A model selection as one comparable string. */
function selectionKey(selection) {
    return `${selection?.provider}\u0000${selection?.model}\u0000${selection?.reasoningEffort ?? ''}`;
}

export class ProjectError extends Error {}

export class ProjectManager {
    /**
     * @param {object} options
     * @param {object} options.ctx - plugin context (sessionController, workspaceRegistry, agents).
     * @param {object} options.config - validated plugin config.
     * @param {Function} options.buildTools - (manager, who) => tool definitions for one agent.
     */
    constructor({ ctx, config, buildTools }) {
        this.ctx = ctx;
        this.config = config;
        this.buildTools = buildTools;
        /** The store's file; its copy is `store`. */
        this.storeFile = dataPath(config.storeFile);
        // With no other manager running on the file (the plugin was switched off, or this is the first), read it
        // again: it may have changed while the plugin was off. One still running (a config reload) shares its copy.
        if (![...liveManagers].some((m) => m.storeFile === this.storeFile)) ProjectStore.release(this.storeFile);
        liveManagers.add(this);
        managers.set(this.storeFile, this);
        this.disposed = false;
        this.logFile = config.logFile ? dataPath(config.logFile) : '';
        /** Set by apply when the notifications plugin is around: one news item, for a system notification (noteNews). */
        this.newsSink = undefined;
        if (this.logFile) {
            try { ensurePrivateDir(dirname(this.logFile)); } catch {}
        }
        /**
         * 'session': set thread models with the controller's per-session selection.
         * 'override': this Host lacks it; rewrite each thread model request.
         */
        this.selectionMode = typeof ctx.sessionController?.agents?.selectForNextRequest === 'function' ? 'session' : 'override';
        /** The coordinating chat's session id → the chat and its threads, as the store keeps them (addStored). */
        this.projects = new Map();
        for (const id of Object.keys(this.store.projects)) this.addStored(id);
        /** Agent → disposer for its installed project scope. */
        this.installed = new Map();
        /** sessionId → {running, stopped?: {key}} for thread turn tracking. */
        this.turns = new Map();
        /** sessionId → (approval id → timer) for permission prompts not yet answered. */
        this.approvals = new Map();
        /** Thread sessionId → {callId, turn, step}: the send it asked the user about in its current step (holdSend). */
        this.pendingSends = new Map();
        /** Thread sessionId → (callId → {turn, step}), from its tool/call events: the model step each call came in. */
        this.callSteps = new Map();
        /** Thread sessionId → (callId → what it does): the calls of its turn the plugin asked the user about (declined). */
        this.askedCalls = new Map();
        /** projectId → tail of its delivery chain, so messages reach the coordinator in order. */
        this.chains = new Map();
        /** projectId → {timer, attempt} for held messages waiting on a retry. */
        this.retries = new Map();
        /** sessionId → the selection the manager just made there, so its own `model/selection` is not taken for the user's pick. */
        this.ownSelections = new Map();
        /** Agent → who it is ({projectId, role, threadId?}), for every agent the manager installed on. */
        this.roles = new Map();
        /** Agent → {key, dispose}: the user's tools it doesn't see (tools.restrict), as a sorted key. */
        this.walls = new Map();
        /** sessionId → the permission preset the manager just put it on, so its own `permission/preset` is not taken for the user's pick. */
        this.ownPermissions = new Map();
        /** The pending pass over every wall after DSH's tool list changed. */
        this.wallTimer = undefined;
        /** Session ids of chats that owe a coordinating chat the reply to its message (chat_message). */
        this.awaited = new Set();
        /** sessionId → the check of its replies running now, so one reply is never delivered twice. */
        this.replyChecks = new Map();
        /** Thread sessionId → (turn → the seq of DSH's announcement of that turn's changes), so its Review tab opens the turn. */
        this.announced = new Map();
        /** Thread sessionId → its turn now (the last `turn/start`), for what its subagents change meanwhile. */
        this.threadTurns = new Map();
        /** Thread sessionId → its subagents' edits, newest last: [{turn, path, added, deleted}]. */
        this.subEdits = new Map();
        /** `${sessionId}\n${callId}` → a subagent's file-tool call waiting for its result: {name, args, thread}. */
        this.subCalls = new Map();
        /** A subagent's sessionId → the thread session it works for, or null when none. */
        this.subThreads = new Map();
        /**
         * Thread sessionId → what it and its subagents made since DSH started: the files they created with DSH's file
         * tools and the folders their commands made, by absolute path, each as the file it was then (deletes.js
         * identityOf), for the delete check (holdDelete).
         */
        this.made = new Map();
        /** Thread sessionId → when it or its subagents ran calls: {running, since, list: [[start, end]]} (whileRunning). */
        this.spans = new Map();
        /** Absolute path → the thread session that wrote it with DSH's file tools, or '' once any other session did too. */
        this.writers = new Map();
        /** A session's id → the project session it works for as a subagent ({projectId, role, threadId?}), or null. */
        this.subProjects = new Map();
        /** How long a thread turn's changes wait for DSH's announcement before they are kept without it. */
        this.announceWaitMs = 3000;
        /** Each file's text before a thread's first edit of it and after its latest, for its Changes tab's net diffs. */
        // A store file of another name keeps its own (net-<name>/), so it never sweeps away another store's threads.
        const storeName = basename(this.storeFile, '.json');
        this.net = NetTexts.open(join(dirname(this.storeFile), storeName === 'coordinator' ? 'net' : `net-${storeName}`), (line) => this.log(line));
        /** Thread sessionId → its turn's folder snapshot (shell.js), taken before the turn's first shell command. */
        this.shellSnaps = new Map();
        /** Every session's mutating calls in flight, so a shell window knows whose changes it may hold (shell.js). */
        this.mutations = new Mutations();
    }

    /** One action line, mode 600. Sizes and ids only, never prompt text. */
    log(line) {
        if (!this.logFile) return;
        try { appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {}
    }

    get sc() {
        return this.ctx.sessionController;
    }

    /**
     * The file's shared copy, looked up on each use: a tool call that
     * outlives this manager (a config reload, the plugin switched off) writes
     * into the copy the newest manager reads, never over it.
     */
    get store() {
        return ProjectStore.open(this.storeFile);
    }

    project(projectId) {
        const p = this.projects.get(projectId);
        if (!p) throw new ProjectError(`"${String(projectId).slice(0, 80)}" doesn't coordinate threads`);
        return p;
    }

    /**
     * Add a coordinating chat the store keeps to the running set: its name
     * is its title, and its threads work in its folder. One that stopped
     * coordinating stays, so its threads keep their guards and their place.
     */
    addStored(projectId) {
        const stored = this.store.projects[projectId];
        if (!isObject(stored) || this.projects.has(projectId)) return;
        if (typeof stored.coordinatorSessionId !== 'string' || stored.coordinatorSessionId === '') return;
        const manager = this;
        this.projects.set(projectId, {
            id: projectId,
            get name() { return storedName(manager.store.projects[projectId]) || UNTITLED_CHAT; },
            get workspacePath() {
                const folder = manager.store.projects[projectId]?.folder;
                return typeof folder === 'string' && folder !== '' ? folder : manager.homeOf(projectId)?.path;
            },
        });
    }

    /** Whether a chat in the store coordinates now: not stopped with /coordinate off. */
    coordinating(projectId) {
        return this.projects.has(projectId) && this.store.projects[projectId]?.off !== true;
    }

    /** DSH's workspace with this id, or undefined. */
    workspace(workspaceId) {
        try {
            return typeof workspaceId === 'string' && workspaceId !== '' ? this.ctx.workspaceRegistry?.get?.(workspaceId) : undefined;
        } catch {
            return undefined;
        }
    }

    /** DSH's workspaces in its own (sidebar) order. */
    workspaceList() {
        try {
            const list = this.ctx.workspaceRegistry?.list?.();
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    /** The DSH workspace a coordinating chat and its threads work in, once DSH has it. */
    homeOf(projectId) {
        return this.workspace(this.store.projects[projectId]?.home);
    }

    /** Note which DSH workspace a coordinating chat's folder is, once DSH has one there. */
    async noteHome(projectId) {
        const folder = this.store.projects[projectId]?.folder;
        if (typeof folder !== 'string' || folder === '') return;
        let ws;
        try { ws = await this.ctx.workspaceRegistry.resolveByPath(folder); } catch { ws = undefined; }
        if (!ws?.id) return;
        if (this.store.projects[projectId]?.home !== ws.id) this.store.putProject(projectId, { home: ws.id });
    }

    /** The thread model and effort a coordinating chat's new threads start on, each with its source. */
    settings(projectId) {
        this.project(projectId);
        return effectiveSettings(pluginDefaults(this.config), this.store.project(projectId).settings);
    }

    /** A coordinating chat's access settings for its threads: the user's tools and the thread permission, each with its source. */
    access(projectId) {
        this.project(projectId);
        return effectiveAccess(pluginDefaults(this.config), this.store.project(projectId).settings);
    }

    /**
     * The user's tools as guard entries, read now: config.guardedTools
     * (live config) and the tools other plugins mark as the user's own.
     */
    guards() {
        return withPersonal(guardList(liveValue(this.config.guardedTools)), this.personalTools());
    }

    /**
     * The tools other plugins mark as the user's own (`personal` on the
     * definition they register), as [tool name, mark]. Read from DSH's
     * registry as it is before any session's restriction, so a wall never
     * hides one from the next check.
     */
    personalTools() {
        let visible;
        try { visible = this.ctx.tools?.view?.()?.visible; } catch { return []; }
        if (!(visible instanceof Map)) return [];
        const out = [];
        for (const [name, definition] of visible) {
            const mark = personalMark(definition?.personal, name);
            if (mark) out.push([name, mark]);
        }
        return out;
    }

    // ── the user's own tools ──────────────────────────────────────────────

    /**
     * The user's tools (guarded names) one session may use. The coordinating
     * chat has them all, as any chat does. Under "always" a thread has every
     * one; under "asked" the ones the user's own words for it named (its
     * `tools`: checked against what the user wrote when it started or got a
     * message, or typed in the thread itself).
     * @param {{projectId: string, role: string, threadId?: string}} who
     * @returns {Set<string>|'all'}
     */
    toolsFor(who) {
        if (who.role === 'coordinator') return 'all';
        if (!this.projects.has(who.projectId) || who.role !== 'thread') return new Set();
        if (this.access(who.projectId).yourTools.value === 'always') return 'all';
        const guard = this.guards();
        const known = new Set(guard.map(([name]) => name));
        const names = new Set();
        const t = this.store.thread(who.projectId, who.threadId);
        for (const name of Array.isArray(t?.tools) ? t.tools : []) if (known.has(name)) names.add(name);
        return names;
    }

    /**
     * Every tool name DSH offers a session before any restriction (its own
     * tools and the user's MCP servers), as tools.restrict() knows them.
     */
    toolNames(agent) {
        const tools = this.ctx.tools;
        try {
            const known = tools?.view?.(agent)?.restrictableNames;
            if (known instanceof Set) return [...known];
        } catch {}
        try {
            return (tools?.schemas?.() ?? []).map((s) => s?.name).filter((name) => typeof name === 'string');
        } catch {
            return [];
        }
    }

    /** The tools of the user's that a thread may not use, by tool name. */
    walledTools(agent, who) {
        const guard = this.guards();
        if (guard.length === 0) return [];
        const allowed = this.toolsFor(who);
        if (allowed === 'all') return [];
        return this.toolNames(agent).filter((name) => {
            const hits = guardsOfTool(name, guard);
            return hits.length > 0 && !hits.some((g) => allowed.has(g));
        });
    }

    /**
     * Keep the user's tools a thread may not use out of what its model is
     * offered (DSH's per-agent tools.restrict). Done again whenever the
     * answer can change: settings, the thread's tools, DSH's tool list.
     */
    applyWall(agent, who) {
        if (this.disposed || who.role !== 'thread' || typeof agent?.ctx?.tools?.restrict !== 'function') return;
        const label = `${who.projectId}/${who.threadId}`;
        let deny;
        try {
            deny = this.walledTools(agent, who).sort();
        } catch (error) {
            this.log(`error wall ${label} ${String(error?.message ?? error).slice(0, 200)}`);
            return;
        }
        const key = deny.join('\n');
        const was = this.walls.get(agent);
        // Nothing to hide and nothing hidden: no wall, and no log line.
        if ((was?.key ?? '') === key) return;
        let dispose;
        if (deny.length > 0) {
            try {
                dispose = agent.ctx.tools.restrict({ deny });
            } catch (error) {
                // The old wall stays; the guard refuses these tools' calls meanwhile.
                this.log(`error wall ${label} ${String(error?.message ?? error).slice(0, 200)}`);
                return;
            }
        }
        // The new wall is up before the old one comes down.
        this.walls.set(agent, { key, dispose });
        try { was?.dispose?.(); } catch {}
        const allowed = this.toolsFor(who);
        const kept = allowed === 'all' ? 'all' : [...allowed].join(',') || '-';
        this.log(`wall ${label} ${agent.id} hid=${deny.length} allowed=${kept}`);
    }

    dropWall(agent) {
        const wall = this.walls.get(agent);
        this.walls.delete(agent);
        try { wall?.dispose?.(); } catch {}
    }

    /**
     * Why a thread's call to one of the user's tools is refused, or
     * undefined. DSH asks before every call of the session, so this holds
     * even in the moment before a wall is updated.
     */
    wallReason(who, name) {
        try {
            if (who.role !== 'thread') return undefined;
            const guard = this.guards();
            if (guard.length === 0) return undefined;
            const hits = guardsOfTool(name, guard);
            if (hits.length === 0) return undefined;
            const allowed = this.toolsFor(who);
            if (allowed === 'all' || hits.some((g) => allowed.has(g))) return undefined;
            this.log(`wall-refused ${who.projectId}/${who.threadId} ${String(name).slice(0, 80)}`);
            return WALL_REASON;
        } catch {
            return undefined;
        }
    }

    /**
     * Why a thread's call is refused, or undefined: wallReason by the tool's
     * name, and for DSH's MCP resource tools by the server their `server`
     * argument names, so the user's servers can't be read around the wall.
     */
    callReason(who, exec) {
        const name = exec?.name;
        const byName = this.wallReason(who, name);
        if (byName !== undefined || !SERVER_TOOLS.has(name)) return byName;
        try {
            const server = exec.arguments?.server;
            return typeof server === 'string' && server.trim() !== '' ? this.wallReason(who, `mcp__${server.trim()}__${name}`) : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Rule 6, held here and not only in the prompts: a command that sends
     * outside the workspace (lib/sends.js: a request that does more than
     * read, a push, a publish, a deploy, a command on another machine, an
     * email, or a script or task that does one) waits for the user. A
     * thread's asks them in DSH's approval prompt, every time, so a retry
     * or a check asks again; the prompt says what it sends, then what the
     * thread says it is for, as the thread's words. A thread asks about one
     * send at a time: DSH asks about a step's calls one after another, so a
     * second send from the step of one already asked is refused, unasked,
     * and the thread sees the answer before it sends again (settleSend).
     * A thread whose approvals never ask and a thread's subagent are
     * refused. A send that reaches only machines the user trusts
     * (config.trustedHosts: ssh to one, scp or rsync to or from one, a web
     * request to one) is none, for them too: a command that also sends
     * elsewhere asks about the rest alone, and one with no other send
     * runs, logged as send-trusted. Called for every session's calls
     * (index.js) once DSH's own checks let one run, or ask about it
     * (`asked`: a hook's or a review's ask): then DSH's words follow the
     * plugin's on the one prompt. DSH asks to widen a call's sandbox later,
     * in the tool itself, once this prompt is answered. Undefined leaves
     * DSH's decision: any other call, a coordinating chat and its
     * subagents (they keep the user's own access), any session outside
     * them, and any error (a check against a mistake, not a sandbox).
     * `out`, when given, gets what it sends (holdCommand). Never logs the
     * command.
     */
    holdSend(exec, asked, out = undefined) {
        try {
            if (this.disposed || !SEND_TOOLS.has(exec?.name) || !exec.agent) return undefined;
            const session = exec.agent.session;
            const own = this.store.lookup(exec.agent.id);
            const who = own ?? this.projectAbove(session);
            if (who?.role !== 'thread' || !this.projects.has(who.projectId)) return undefined;
            const args = argsOf(exec.arguments);
            const project = this.project(who.projectId);
            const folder = (who.role === 'thread' ? this.store.thread(who.projectId, who.threadId)?.folder : undefined) ?? project.workspacePath;
            const first = typeof session?.header?.cwd === 'string' ? session.header.cwd : folder;
            const roots = [first, folder, project.workspacePath].filter((root) => typeof root === 'string' && root !== '').map(expand);
            // Where the command runs: on DSH 0.2.1, the session's working directory.
            const cwd = this.cwdOf(session) ?? first;
            const here = typeof args.workdir === 'string' && args.workdir.trim() !== '' ? resolve(expand(cwd), expand(args.workdir.trim())) : expand(cwd);
            // The machines the user trusts (config.trustedHosts, read now): a send that reaches only these is no send.
            const trustedHosts = liveValue(this.config.trustedHosts);
            const trustedSends = [];
            const found = exec.name === 'run_code'
                ? codeSendOf(String(args.code ?? ''), { depth: 0, cwd: here, read: (path) => textInside(roots, path), trustedHosts, trustedSends }, 'run_code')
                : sendOf(String(args.command ?? ''), { shell: exec.name, cwd: here, read: (path) => textInside(roots, path), trustedHosts, trustedSends });
            const whose = `${who.projectId}/${who.threadId}${own ? '' : ' subagent'}`;
            if (!found) {
                // Its sends reach only trusted machines: it runs, a subagent's and one whose approvals never ask too.
                if (trustedSends.length > 0) this.log(`send-trusted ${whose} ${[...new Set(trustedSends.map((s) => s.program))].join('+').slice(0, 40)}`);
                return undefined;
            }
            const label = `${whose} ${found.kind} ${String(found.program).slice(0, 40)}`;
            if (!own) {
                this.log(`send-refused ${label}`);
                return { kind: 'deny', reason: SEND_REASONS.subagent(found.what) };
            }
            if (this.approvalPolicyOf(session) !== 'ask') {
                this.log(`send-refused ${label} never-asks`);
                return { kind: 'deny', reason: SEND_REASONS.never(found.what) };
            }
            const step = this.callSteps.get(exec.agent.id)?.get(exec.callId);
            const pending = this.pendingSends.get(exec.agent.id);
            if (step && pending && pending.callId !== exec.callId && pending.turn === step.turn && pending.step === step.step) {
                this.log(`send-refused ${label} one-at-a-time`);
                return { kind: 'deny', reason: SEND_REASONS.pending(found.what) };
            }
            this.pendingSends.set(exec.agent.id, { callId: exec.callId, ...step });
            this.noteAsked(exec, found.what);
            this.log(`send-ask ${label}`);
            const said = described(found);
            const words = threadWords(args);
            if (out) Object.assign(out, { what: found.what, said, words });
            const theirs = asked?.kind === 'ask' ? asked : undefined;
            const also = withoutCredentials(theirs?.displayReason?.en ?? theirs?.reason).trim();
            return {
                kind: 'ask',
                reason: `the command ${said}${words ? `. The thread says: ${words}` : ''}${theirs?.reason ? `; ${withoutCredentials(theirs.reason)}` : ''}`,
                displayReason: { en: `This command ${said}. A thread asks you before each command that sends outside the workspace.${words ? `\nThe thread says: ${words}` : ''}${also ? `\n${also}` : ''}` },
            };
        } catch (error) {
            this.log(`error send-check ${String(error?.message ?? error).slice(0, 200)}`);
            return undefined;
        }
    }

    /**
     * Rule 6 for deletes, held the way holdSend holds sends: a command that
     * deletes files (lib/deletes.js) its thread didn't create waits for the
     * user in DSH's approval prompt, every time; a thread whose approvals
     * never ask and a thread's subagent are refused. Free to delete:
     * what the thread (or its subagents) can be shown to have made (mineOf):
     * a file it created, a folder its command made with what was born there
     * while it ran, a folder of only those; and what is in the OS temp
     * folder outside the workspace or made by mktemp. The workspace's .git
     * never is, and what can't be told (a variable, a pattern, a list on the
     * input, a cleaning script, something moved into its folder or reached
     * through a link) asks. A script the thread created is read for what it
     * deletes. Undefined lets it run, as in holdSend, and an ask DSH's own
     * checks made (`asked`) keeps its words after the plugin's; `out`, when
     * given, gets what it deletes (holdCommand). Never logs the command or a
     * path.
     */
    holdDelete(exec, asked, out = undefined) {
        try {
            if (this.disposed || !SEND_TOOLS.has(exec?.name) || !exec.agent) return undefined;
            const session = exec.agent.session;
            const own = this.store.lookup(exec.agent.id);
            const who = own ?? this.projectAbove(session);
            // The coordinating chat and its subagents keep the user's own access, as in holdSend.
            if (who?.role !== 'thread' || !this.projects.has(who.projectId)) return undefined;
            const args = argsOf(exec.arguments);
            const project = this.project(who.projectId);
            const t = who.role === 'thread' ? this.store.thread(who.projectId, who.threadId) : undefined;
            const folder = t?.folder ?? project.workspacePath;
            const first = typeof session?.header?.cwd === 'string' ? session.header.cwd : folder;
            const work = [first, folder, project.workspacePath].filter((root) => typeof root === 'string' && root !== '').map((root) => resolve(expand(root)));
            // Where the command runs: on DSH 0.2.1, the session's working directory, which can be outside them; in a shell
            // that keeps its folder from one command to the next (DSH's persistent bash), a relative path can't be told.
            const cwd = this.cwdOf(session) ?? first;
            const here = typeof args.workdir === 'string' && args.workdir.trim() !== '' ? resolve(expand(cwd), expand(args.workdir.trim())) : expand(cwd);
            const mine = this.mineOf(t?.sessionId, t, first);
            const read = (path) => (mine.made.has(path) ? textInside([dirname(path)], path) : undefined);
            const found = exec.name === 'run_code' ? codeDeletesOf(String(args.code ?? ''), { cwd: here, read })
                : deletesOf(String(args.command ?? ''), { shell: exec.name, cwd: this.keepsFolder(exec) ? undefined : here, read });
            const held = found.filter((d) => !isFree(d, { work, mine }));
            if (held.length === 0) return undefined;
            const what = deletesWhat(held);
            if (out) out.what = what;
            const programs = [...new Set(held.map((d) => String(d.program).replace(/\s+/g, '-')))].join(',').slice(0, 40);
            const label = `${who.projectId}/${who.threadId}${own ? '' : ' subagent'} ${programs}`;
            if (!own) {
                this.log(`delete-refused ${label}`);
                return { kind: 'deny', reason: DELETE_REASONS.subagent(what) };
            }
            if (this.approvalPolicyOf(session) !== 'ask') {
                this.log(`delete-refused ${label} never-asks`);
                return { kind: 'deny', reason: DELETE_REASONS.never(what) };
            }
            this.noteAsked(exec, what);
            this.log(`delete-ask ${label}`);
            const theirs = asked?.kind === 'ask' ? asked : undefined;
            const also = withoutCredentials(theirs?.displayReason?.en ?? theirs?.reason).trim();
            return {
                kind: 'ask',
                reason: `the command ${what}; if the user doesn't allow it, hand back with status needs_decision${theirs?.reason ? `; ${withoutCredentials(theirs.reason)}` : ''}`,
                displayReason: { en: `This command ${what}. A thread asks you before each command that deletes files it didn't create.${also ? `\n${also}` : ''}` },
            };
        } catch (error) {
            this.log(`error delete-check ${String(error?.message ?? error).slice(0, 200)}`);
            return undefined;
        }
    }

    /**
     * Rule 6 for one command (index.js): holdSend, then holdDelete. A
     * refusal of either stands; a command that both sends and deletes asks
     * once, saying both (batch 5 review m2: it said only the send, and one
     * Allow ran both). Undefined leaves DSH's decision.
     */
    holdCommand(exec, asked) {
        const sent = {};
        const send = this.holdSend(exec, asked, sent);
        if (send?.kind === 'deny') return send;
        const gone = {};
        const del = this.holdDelete(exec, asked, gone);
        if (send === undefined || del === undefined) return send ?? del;
        if (del.kind !== 'ask') return del;
        try {
            this.noteAsked(exec, `${sent.what} and ${gone.what}`);
            const theirs = asked?.kind === 'ask' ? asked : undefined;
            const also = withoutCredentials(theirs?.displayReason?.en ?? theirs?.reason).trim();
            return {
                kind: 'ask',
                reason: `the command ${sent.said} and ${gone.what}${sent.words ? `. The thread says: ${sent.words}` : ''}; if the user doesn't allow it, hand back with status needs_decision${theirs?.reason ? `; ${withoutCredentials(theirs.reason)}` : ''}`,
                displayReason: { en: `This command ${sent.said} and ${gone.what}. A thread asks you before each command that sends outside the workspace or deletes files it didn't create.${sent.words ? `\nThe thread says: ${sent.words}` : ''}${also ? `\n${also}` : ''}` },
            };
        } catch (error) {
            this.log(`error delete-check ${String(error?.message ?? error).slice(0, 200)}`);
            return send;
        }
    }

    /**
     * What a thread can be shown to have made, for the delete check
     * (deletes.js isFree): the files it and its subagents created and the
     * folders their commands made since DSH started, and the files its
     * change records say it created, each as the file it was then; when it
     * ran calls; and which paths other sessions wrote with DSH's file tools.
     * @param {string} [thread] - the thread's session id; none for a subagent's own check.
     * @param {object} [t] - its store record, for its change records.
     * @param {string} [first] - the folder its change records' paths are from.
     * @returns {import('./deletes.js').Mine}
     */
    mineOf(thread, t, first) {
        const made = new Map(typeof thread === 'string' ? this.made.get(thread) ?? [] : []);
        for (const r of Array.isArray(t?.changes) ? t.changes : []) {
            for (const f of Array.isArray(r?.files) ? r.files : []) {
                if (f?.created !== true || typeof f.path !== 'string' || !isObject(f.identity) || typeof first !== 'string') continue;
                const path = resolve(expand(first), expand(f.path));
                if (!made.has(path)) made.set(path, f.identity);
            }
        }
        const s = typeof thread === 'string' ? this.spans.get(thread) : undefined;
        const spans = s ? [...s.list, ...(s.running > 0 ? [[s.since, Infinity]] : [])] : [];
        const foreign = (path) => {
            const by = this.writers.get(path);
            return by !== undefined && by !== thread;
        };
        return { made, spans, foreign };
    }

    /**
     * Whether a call's shell keeps its folder from one command to the next
     * (DSH's persistent bash and pwsh, in its Minimal agent: no `workdir`),
     * so where a relative path is can't be told from the session.
     */
    keepsFolder(exec) {
        if (exec?.name !== 'bash' && exec?.name !== 'pwsh') return false;
        try {
            const props = this.ctx.tools?.view?.(exec.agent)?.visible?.get?.(exec.name)?.parameters?.properties;
            return isObject(props) && Object.hasOwn(props, 'command') && !Object.hasOwn(props, 'workdir');
        } catch {
            return false;
        }
    }

    /**
     * The model step of each of a thread's calls, from its tool/call events,
     * which DSH logs just before a call's checks. A send asked in one step
     * holds the rest of that step's sends (holdSend); the next step, which
     * reads the user's answer, may ask again. The turn's end clears it
     * (here, and onThreadStatus), so a stopped or failed turn leaves no hold.
     */
    settleSend(sessionId, event) {
        const data = event?.data;
        if (event?.type === 'tool/call' && typeof data?.callId === 'string' && Number.isSafeInteger(data.step)) {
            const steps = this.callSteps.get(sessionId) ?? new Map();
            steps.set(data.callId, { turn: data.turn, step: data.step });
            for (const key of [...steps.keys()].slice(0, -50)) steps.delete(key);
            this.callSteps.set(sessionId, steps);
        } else if (event?.type === 'turn/end') {
            this.pendingSends.delete(sessionId);
            this.callSteps.delete(sessionId);
            this.askedCalls.delete(sessionId);
        }
    }

    /** What a thread's call the plugin asked the user about does, for the result if they decline it (declined). */
    noteAsked(exec, what) {
        if (typeof exec.callId !== 'string') return;
        const asked = this.askedCalls.get(exec.agent.id) ?? new Map();
        asked.set(exec.callId, String(what ?? ''));
        for (const key of [...asked.keys()].slice(0, -20)) asked.delete(key);
        this.askedCalls.set(exec.agent.id, asked);
    }

    /**
     * A thread's call the user rejected at DSH's prompt (DSH's result is
     * `the user rejected tool "bash"`), as DSH's `tools/post-execute` sees it
     * (index.js). The thread reads, as the call's result, what the user
     * declined and to hand back needs_decision saying so; its coordinator
     * reads it in the thread's next handback or idle note, so its reply
     * says so too (behaviour review 5, S3 r4: a done handback and "That's
     * the script working" after a Reject). A rejection DSH made itself, for
     * a session whose approvals never ask, isn't the user's.
     * @returns {{kind: 'accept', content: object[]} | undefined} the result's new content, or undefined to leave it.
     */
    declined(exec, result) {
        try {
            if (this.disposed || !exec?.agent) return undefined;
            const asked = this.askedCalls.get(exec.agent.id);
            const what = asked?.get(exec.callId);
            asked?.delete(exec.callId);
            if (!result?.isError || result.error?.message !== `the user rejected tool "${exec.name}"`) return undefined;
            const who = this.store.lookup(exec.agent.id);
            if (who?.role !== 'thread' || !this.projects.has(who.projectId) || this.approvalPolicyOf(exec.agent.session) !== 'ask') return undefined;
            const t = this.store.thread(who.projectId, who.threadId);
            if (!t) return undefined;
            const said = withoutCredentials(what ?? '').trim();
            this.store.putThread(who.projectId, who.threadId, { declined: [...(Array.isArray(t.declined) ? t.declined : []), said ? `a command that ${said}` : `a ${exec.name} call`].slice(-3) });
            this.log(`declined ${who.projectId}/${who.threadId} ${exec.name}`);
            return { kind: 'accept', content: [{ type: 'text', text: declinedResult(said) }] };
        } catch (error) {
            this.log(`error declined ${String(error?.message ?? error).slice(0, 200)}`);
            return undefined;
        }
    }

    /** "ask" when DSH would put an approval prompt in front of the user for this session, else "never". */
    approvalPolicyOf(session) {
        try {
            const approval = this.ctx.get?.('approval');
            if (typeof approval?.effectivePolicy !== 'function') return 'never';
            return approval.effectivePolicy(session) === 'ask' ? 'ask' : 'never';
        } catch {
            return 'never';
        }
    }

    /**
     * The project session a subagent works for, through subagents of
     * subagents: {projectId, role, threadId?}, or null for any other session
     * (one the user forked from a thread is the user's own chat).
     */
    projectAbove(session) {
        const id = session?.id;
        if (typeof id !== 'string') return null;
        if (this.subProjects.has(id)) return this.subProjects.get(id);
        let header = session.header;
        let found = null;
        for (let depth = 0; depth < 8 && header?.origin === 'subagent' && typeof header.parentSession === 'string'; depth++) {
            const who = this.store.lookup(header.parentSession);
            if (who) {
                found = who;
                break;
            }
            header = this.ctx.agents.get(header.parentSession)?.session?.header;
        }
        this.subProjects.set(id, found);
        for (const key of [...this.subProjects.keys()].slice(0, -500)) this.subProjects.delete(key);
        return found;
    }

    /** Every installed session's wall again (of one project, or all). */
    rewall(projectId) {
        for (const [agent, who] of this.roles) {
            if (projectId === undefined || who.projectId === projectId) this.applyWall(agent, who);
        }
    }

    /** DSH's tool list changed (an MCP server came or went): walls again, once the changes settle. */
    onToolsChanged() {
        if (this.disposed || this.wallTimer !== undefined) return;
        this.wallTimer = setTimeout(() => {
            this.wallTimer = undefined;
            // A throw in a timer would end DSH's Host.
            try { this.rewall(); } catch (error) { this.log(`error wall ${String(error?.message ?? error).slice(0, 200)}`); }
        }, 50);
        this.wallTimer.unref?.();
    }

    /**
     * What the user wrote in the coordinating chat: their own messages and
     * their answers in DSH's question box, not the plugin's or the threads'.
     * '' when its log can't be read.
     */
    async userText(projectId) {
        const sessionId = this.store.project(projectId).coordinatorSessionId;
        if (!sessionId) return '';
        try {
            const events = (await this.sc.inspect(sessionId, AbortSignal.timeout(20000))).events ?? [];
            return [...events.map(promptOf).filter((p) => p && !p.fromProject).map((p) => p.text), ...questionAnswers(events)].join('\n');
        } catch (error) {
            this.log(`error user-words ${projectId} ${String(error?.message ?? error).slice(0, 200)}`);
            return '';
        }
    }

    /**
     * The user's tools an `ask` names, checked against what the user wrote:
     * each must also be named in the user's own messages in the coordinating
     * chat. An ask that names one the user never wrote is not the user's
     * words, so it is refused.
     * @returns {Promise<string[]>} the guarded names the ask gives its thread.
     */
    async askedTools(projectId, ask) {
        const guard = this.guards();
        if (guard.length === 0 || !ask) return [];
        const named = guardedIn(ask, guard, { aliases: true });
        if (named.length === 0) return [];
        const said = new Set(guardedIn(await this.userText(projectId), guard, { aliases: true }));
        const unsaid = named.filter((name) => !said.has(name));
        if (unsaid.length > 0) {
            this.log(`guard ${projectId} ask-unsaid ${unsaid.join(',')}`);
            throw new ProjectError(`ask names ${unsaid.join(', ')}, but the user's messages don't. Put only the user's own words in ask, copied from their message, or ask the user first`);
        }
        return named;
    }

    /**
     * An `ask` holds only the user's words: each of its sentences copied
     * from what they wrote in the coordinating chat (their messages, their
     * answers in DSH's question box), so a thread never reads the
     * coordinator's own words after "The user asked:". Before the user has
     * written anything (or when the log can't be read) there is nothing to
     * check against, and it passes.
     */
    async requireUserWords(projectId, ask, kind) {
        const wrote = await this.userText(projectId);
        if (wrote.trim() === '') return;
        const part = unsaidPart(ask, wrote);
        if (part === '') return;
        this.log(`guard ${projectId} ask-not-theirs ${kind}`);
        const shown = part.length > 80 ? `${part.slice(0, 79)}…` : part;
        throw new ProjectError(`ask holds only the user's own words, copied from their messages, and they didn't write "${shown}". Put what you add (the task you picked, the scope) in ${kind === 'start' ? 'brief' : 'text'}`);
    }

    /** Give a thread more of the user's tools, named by the user's words; its wall follows at once. */
    addThreadTools(projectId, threadId, names, why) {
        const t = this.store.thread(projectId, threadId);
        if (!t || names.length === 0) return;
        const have = Array.isArray(t.tools) ? t.tools : [];
        const added = names.filter((name) => !have.includes(name));
        if (added.length === 0) return;
        this.store.putThread(projectId, threadId, { tools: [...have, ...added] });
        this.log(`tools ${projectId}/${threadId} +${added.join(',')} ${why}`);
        const agent = this.ctx.agents.get(t.sessionId);
        if (agent && this.roles.has(agent)) this.applyWall(agent, this.roles.get(agent));
    }

    // ── permissions ───────────────────────────────────────────────────────

    /** DSH's permission presets service, or undefined on a DSH without it. */
    presets() {
        try {
            const pp = this.ctx.get?.('permissionPresets');
            return pp && typeof pp.set === 'function' && typeof pp.current === 'function' ? pp : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * The presets DSH offers for new sessions, in its order ({value, name,
     * description?}, as its permission menu lists them, without the
     * experimental Auto), and the one new sessions get. null without them.
     */
    permissionCatalog() {
        const pp = this.presets();
        if (!pp) return null;
        try {
            const c = pp.catalog();
            const options = (Array.isArray(c?.defaultOptions) ? c.defaultOptions : [])
                .filter((o) => typeof o?.value === 'string' && o.value !== 'custom' && o.value !== 'auto')
                .map((o) => ({ value: o.value, name: typeof o.name === 'string' ? o.name : o.value, ...(typeof o.description === 'string' ? { description: o.description } : {}) }));
            return { options, defaultPreset: typeof c?.defaultPreset === 'string' ? c.defaultPreset : null };
        } catch {
            return null;
        }
    }

    /**
     * The preset a permission setting puts a session on: DSH's default for
     * new sessions for "default", undefined for a name DSH doesn't offer.
     */
    presetOf(value) {
        const catalog = this.permissionCatalog();
        if (!catalog) return undefined;
        if (value === 'default') return catalog.defaultPreset ?? undefined;
        return catalog.options.some((o) => o.value === value) ? value : undefined;
    }

    /** A loaded session's permission preset now (DSH's name, or "custom"), or undefined. */
    permissionOf(sessionId) {
        try {
            const session = typeof sessionId === 'string' ? this.ctx.agents.get(sessionId)?.session : undefined;
            const preset = session ? this.presets()?.current(session) : undefined;
            return typeof preset === 'string' ? preset : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Put one session on a permission preset, the way DSH's permission menu
     * does, marked as the manager's own change.
     * @returns whether the session is on it now.
     */
    setPermission(agent, preset, label) {
        const pp = this.presets();
        if (!pp || !agent?.session || typeof preset !== 'string') return false;
        try {
            if (pp.current(agent.session) === preset) return true;
            this.ownPermissions.set(agent.id, preset);
            pp.set(agent.session, preset);
            this.log(`permission ${label} ${preset}`);
            return pp.current(agent.session) === preset;
        } catch (error) {
            this.ownPermissions.delete(agent.id);
            this.log(`error permission ${label} ${String(error?.message ?? error).slice(0, 200)}`);
            return false;
        }
    }

    /**
     * A `permission/preset` on a thread that the manager didn't make: the
     * user's pick in DSH's own permission menu becomes that thread's, so
     * Thread settings say what it runs with.
     */
    onPermission(who, agent, data) {
        try {
            const preset = data?.preset;
            if (who.role !== 'thread' || typeof preset !== 'string' || preset === 'custom' || !this.projects.has(who.projectId)) return;
            if (this.ownPermissions.get(agent.id) === preset) {
                this.ownPermissions.delete(agent.id);
                return;
            }
            if (!this.store.thread(who.projectId, who.threadId)) return;
            this.store.putThread(who.projectId, who.threadId, { permission: preset });
            this.log(`picked-permission ${who.projectId}/${who.threadId} ${preset}`);
        } catch (error) {
            this.log(`error picked-permission ${who.projectId} ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /**
     * The plugin defaults changed while the plugin runs (DSH's settings page
     * saved them, or the profile's live fields were edited). New threads
     * start with the new defaults, and running threads keep theirs; a
     * chat's own settings stay. Every thread's wall follows the user's tools
     * as they are now.
     */
    async onDefaultsChanged() {
        this.log('defaults saved');
        // Your tools, or the list of them, may have changed.
        try { this.rewall(); } catch (error) { this.log(`error wall ${String(error?.message ?? error).slice(0, 200)}`); }
    }

    /** Whether the user paused a coordinating chat's threads: no new ones start, and their reports wait. */
    paused(projectId) {
        return this.store.project(projectId).settings.paused === true;
    }

    /** Whether a coordinating chat is archived with its threads in DSH (archiveProject). */
    archived(projectId) {
        return isObject(this.store.projects[projectId]?.archived);
    }

    /**
     * Paused, archived, stopped coordinating, or gone from DSH: what is sent
     * to the chat waits, and no thread starts.
     */
    held(projectId) {
        const stored = this.store.projects[projectId];
        return this.archived(projectId) || this.paused(projectId) || stored?.off === true || stored?.gone === true;
    }

    liveStatus(sessionId) {
        const agent = this.ctx.agents.get(sessionId);
        return agent ? agent.status : 'idle';
    }

    /** The Host model catalog, cached briefly; undefined when unavailable. */
    async catalog() {
        let value;
        if (this.catalogCache && Date.now() - this.catalogCache.at < 30000) {
            value = this.catalogCache.value;
        } else {
            try { value = await this.sc.modelCatalog(); } catch { value = undefined; }
            this.catalogCache = value ? { value, at: Date.now() } : null;
        }
        // The DSH default changes with every pick in DSH's model picker, so
        // checks use the current one, the same one fullSelection builds on.
        let current;
        try { current = this.ctx.get?.('agentDefaultModel')?.currentSelection?.(); } catch {}
        if (!value || !current?.provider || !current?.model) return value;
        if (value.default?.provider === current.provider && value.default?.model === current.model) return value;
        return { ...value, default: { provider: current.provider, model: current.model } };
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    /**
     * Attach to live agents, bring every coordinating chat up, deliver held
     * messages, and review thread turns that ended while the plugin was not
     * watching (DSH stopped or the plugin reloaded mid-turn).
     */
    async start() {
        // The Changes tab's kept texts (net.js): none for threads gone from the store or from DSH, none unused for 30
        // days, and not past their limit; swept again every hour.
        void this.sweepNet();
        clearInterval(this.netTimer);
        this.netTimer = setInterval(() => void this.sweepNet(), NET_SWEEP_MS);
        this.netTimer.unref?.();
        for (const agent of this.ctx.agents.list?.() ?? []) this.maybeInstall(agent);
        await this.refreshRecords();
        if (this.disposed) return;
        // A coordinating chat archived or unarchived in DSH while the plugin was off: its threads follow it now.
        await this.matchArchive();
        for (const id of [...this.projects.keys()]) {
            if (this.disposed) return;
            await this.resume(id);
        }
        if (!this.disposed) await this.catchUpReplies();
    }

    /**
     * Bring a coordinating chat up as at a start: its tools on, then what
     * was held for it delivered and the turns its threads ended meanwhile
     * reviewed. Not while it is archived or stopped coordinating; a chat DSH
     * no longer has is marked gone, and what its threads send it waits.
     */
    async resume(id) {
        if (this.archived(id) || !this.coordinating(id)) return;
        const sessionId = this.store.projects[id]?.coordinatorSessionId;
        if (typeof sessionId !== 'string' || sessionId === '') return;
        try {
            const live = this.ctx.agents.get(sessionId);
            if (live) this.maybeInstall(live);
            else if (!await this.exists(sessionId)) {
                if (this.store.projects[id]?.gone !== true) {
                    this.store.putProject(id, { gone: true });
                    this.log(`coordinator ${id} gone`);
                }
                return;
            }
            if (this.store.projects[id]?.gone === true) this.store.putProject(id, { gone: undefined });
            this.seeArchive(id, sessionId);
            await this.noteHome(id);
            this.log(`coordinator ${id} ${sessionId} resumed`);
        } catch (error) {
            this.log(`error coordinator ${id} ${String(error?.message ?? error).slice(0, 300)}`);
            return;
        }
        // Reloaded meanwhile: the new manager delivers and reviews.
        if (this.disposed) return;
        await this.flushPending(id);
        await this.catchUp(id);
    }

    /**
     * /coordinate in a chat, or its Coordinate button: from now on the chat
     * runs work in threads that report back to it, or with `on` false it
     * stops (its threads keep running; their reports wait until it
     * coordinates again). A thread can't coordinate, nor a subagent's
     * session: their work reports to the chat above them.
     * @returns {Promise<{kind: 'success'|'error', text: string}>} what DSH shows under the command.
     */
    async coordinate(agent, on) {
        const sessionId = agent?.id;
        if (typeof sessionId !== 'string' || sessionId === '') return { kind: 'error', text: 'There is no chat here to coordinate from.' };
        const who = this.store.lookup(sessionId);
        if (who?.role === 'thread') {
            return { kind: 'error', text: `This chat is a thread: it reports to "${this.projects.get(who.projectId)?.name ?? UNTITLED_CHAT}", which coordinates it.` };
        }
        const header = agent.session?.header;
        if (!who && header?.origin === 'subagent') return { kind: 'error', text: 'This is a subagent\'s session: its work reports to the chat it works for.' };
        if (!on) {
            if (who?.role !== 'coordinator' || !this.coordinating(who.projectId)) return { kind: 'success', text: 'This chat isn\'t coordinating threads.' };
            this.store.putProject(who.projectId, { off: true });
            clearTimeout(this.retries.get(who.projectId)?.timer);
            this.retries.delete(who.projectId);
            this.forget(agent);
            this.log(`coordinate ${who.projectId} off`);
            const open = Object.values(this.store.project(who.projectId).threads).filter((t) => !t.resolved).length;
            return { kind: 'success', text: open > 0 ? `Stopped coordinating. Its ${open === 1 ? 'thread keeps' : `${open} threads keep`} running; reports wait until you run /coordinate here again.` : 'Stopped coordinating.' };
        }
        if (who?.role === 'coordinator' && this.coordinating(who.projectId)) return { kind: 'success', text: 'This chat already coordinates threads.' };
        const projectId = who?.projectId ?? sessionId;
        const was = this.store.projects[projectId];
        const folder = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : was?.folder;
        if (typeof folder !== 'string' || folder === '') return { kind: 'error', text: 'This chat has no folder for threads to work in.' };
        const title = clipTitle(await this.currentTitle(sessionId).catch(() => undefined) ?? '');
        this.store.putProject(projectId, {
            coordinatorSessionId: sessionId, folder, off: undefined, gone: undefined,
            ...(title ? { name: title } : {}),
            ...(typeof was?.createdAt === 'string' ? {} : { createdAt: new Date().toISOString() }),
        });
        this.addStored(projectId);
        this.maybeInstall(agent);
        this.log(`coordinate ${projectId} on${who ? ' again' : ''}`);
        // After DSH logs the command's result, so what was held for the chat comes after it.
        const later = setTimeout(() => {
            void this.resume(projectId).catch((error) => this.log(`error coordinate ${projectId} ${String(error?.message ?? error).slice(0, 200)}`));
        }, 0);
        later.unref?.();
        return { kind: 'success', text: 'Coordinating. Ask for work here as usual: what runs long or splits into parts goes to threads that report back to this chat.' };
    }

    /** What the user typed after /coordinate: nothing or "on" starts, "off" or "stop" stops. */
    onCommand(agent, rawInput) {
        const arg = String(rawInput ?? '').trim().toLowerCase();
        if (arg === '' || arg === 'on') return this.coordinate(agent, true);
        if (arg === 'off' || arg === 'stop') return this.coordinate(agent, false);
        return { kind: 'error', text: '/coordinate starts coordinating threads from this chat; /coordinate off stops.' };
    }

    /**
     * The Coordinate button, or Stop coordinating in the Threads menu: the
     * same as typing the command in the chat, so DSH shows it there and the
     * window's record of the chat follows from it.
     * @returns {Promise<{coordinating: boolean, session: string, text: string}>}
     */
    async coordinateFromWindow(target, on) {
        const sessionId = typeof target === 'string' ? target.trim() : '';
        if (sessionId === '') throw new ProjectError('no chat given');
        let agent;
        try { agent = (await this.sc.resolveAgent(sessionId))?.agent; } catch { agent = undefined; }
        if (!agent) throw new ProjectError('DSH has no such chat right now');
        let result;
        try {
            const commands = this.ctx.get?.('commands');
            if (typeof commands?.execute === 'function' && typeof commands.find === 'function' && commands.find(agent, COMMAND)) {
                result = (await commands.execute(agent, on ? `/${COMMAND}` : `/${COMMAND} off`, [], AbortSignal.timeout(30000)))?.result;
            }
        } catch (error) {
            throw new ProjectError(String(error?.message ?? error).slice(0, 200));
        }
        result ??= await this.coordinate(agent, on);
        if (result?.kind !== 'success') throw new ProjectError(result?.text || 'the chat could not start coordinating');
        const who = this.store.lookup(sessionId);
        return { coordinating: who?.role === 'coordinator' && this.coordinating(who.projectId), session: sessionId, text: result.text ?? '' };
    }

    async dispose() {
        this.disposed = true;
        liveManagers.delete(this);
        if (managers.get(this.storeFile) === this) managers.delete(this.storeFile);
        for (const dispose of this.installed.values()) {
            try { dispose(); } catch {}
        }
        this.installed.clear();
        this.roles.clear();
        clearTimeout(this.wallTimer);
        this.wallTimer = undefined;
        clearInterval(this.netTimer);
        this.netTimer = undefined;
        for (const sessionId of [...this.approvals.keys()]) this.clearApprovals(sessionId);
        this.pendingSends.clear();
        this.callSteps.clear();
        for (const { timer } of this.retries.values()) clearTimeout(timer);
        this.retries.clear();
        // The last manager on the file lets its copy go, so the plugin switched on again reads the file anew.
        if (![...liveManagers].some((m) => m.storeFile === this.storeFile)) ProjectStore.release(this.storeFile);
    }

    /** DSH's session list: [{sessionId, projections: {values}}, …]; [] when it can't be read. */
    async listed() {
        try {
            const { items } = await this.sc.list({}, AbortSignal.timeout(20000));
            return Array.isArray(items) ? items : [];
        } catch (error) {
            this.log(`error list ${String(error?.message ?? error).slice(0, 200)}`);
            return [];
        }
    }

    /**
     * Every coordinating chat and thread the store knows, for the session
     * list while DSH has no value of this plugin's projection for one.
     * @returns {Record<string, {role: 'coordinator'|'thread', project: string, name: string, thread?: string, coordinator?: string, off?: true}>}
     */
    knownSessions() {
        const out = {};
        for (const projectId of this.projects.keys()) {
            const stored = this.store.project(projectId);
            const coordinator = typeof stored.coordinatorSessionId === 'string' && stored.coordinatorSessionId !== '' ? stored.coordinatorSessionId : undefined;
            const name = this.project(projectId).name;
            if (coordinator) out[coordinator] = { role: 'coordinator', project: projectId, name, ...(stored.off === true ? { off: true } : {}) };
            for (const [threadId, t] of Object.entries(stored.threads ?? {})) {
                if (typeof t?.sessionId !== 'string' || t.sessionId === '' || out[t.sessionId]) continue;
                out[t.sessionId] = { role: 'thread', project: projectId, name, thread: threadId, ...(coordinator ? { coordinator } : {}) };
            }
        }
        return out;
    }

    /**
     * DSH keeps each session's value of this plugin's projection from the
     * version of the plugin that last folded it, and drops a value from
     * another version when it lists the session, until that session is next
     * loaded. So after an update a thread nobody opened since showed flat in
     * the session list, with no mark. Once per start, every project session
     * DSH lists without a value is read again from its log, starting from
     * the store's view (the projection's init), and DSH saves the result as
     * it saves any cold read. Sessions DSH has loaded fold as they run.
     */
    async refreshRecords() {
        let cache;
        try { cache = this.ctx.get?.('sessionProjectionCache'); } catch { cache = undefined; }
        if (typeof cache?.coldSnapshot !== 'function') return;
        const known = Object.keys(this.knownSessions());
        if (known.length === 0) return;
        const items = new Map((await this.listed()).map((item) => [item?.sessionId, item]));
        const loaded = (id) => {
            try { return this.ctx.get?.('sessions')?.get?.(id) !== undefined; } catch { return false; }
        };
        let refreshed = 0;
        for (const sessionId of known) {
            if (this.disposed) return;
            const item = items.get(sessionId);
            if (!item || loaded(sessionId)) continue;
            const value = item.projections?.values?.[PROJECTION_KEY];
            if (value !== null && typeof value === 'object' && (value.role === 'coordinator' || value.role === 'thread')) continue;
            try {
                const { meta, inheritedEventCount, events } = await this.sc.inspect(sessionId, AbortSignal.timeout(20000));
                if (loaded(sessionId)) continue;
                cache.coldSnapshot(meta, inheritedEventCount ?? 0, Array.isArray(events) ? events : []);
                refreshed += 1;
            } catch (error) {
                this.log(`error record ${sessionId} ${String(error?.message ?? error).slice(0, 200)}`);
            }
        }
        if (refreshed > 0) this.log(`records refreshed=${refreshed}`);
    }

    /** A session's title as DSH lists it, else as its log has it; undefined when neither says. */
    async currentTitle(sessionId) {
        try {
            const { items } = await this.sc.list({}, AbortSignal.timeout(20000));
            const title = (Array.isArray(items) ? items : []).find((item) => item?.sessionId === sessionId)?.projections?.values?.title;
            if (typeof title === 'string') return title;
        } catch {}
        return this.sessionTitle(sessionId).catch(() => undefined);
    }

    /** A session's title as its log has it (its newest title event), or undefined. */
    async sessionTitle(sessionId) {
        const { events } = await this.sc.inspect(sessionId, AbortSignal.timeout(20000));
        for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
            if (events[i]?.type === 'session/title' && typeof events[i].data?.title === 'string') return events[i].data.title;
        }
        return undefined;
    }

    /** Whether a session exists. Only "not found" means no; any other read error is thrown. */
    async exists(sessionId) {
        if (!sessionId) return false;
        try {
            await this.sc.inspect(sessionId, AbortSignal.timeout(20000));
            return true;
        } catch (error) {
            if (isNotFound(error)) return false;
            throw error;
        }
    }

    /** Create one ordinary session in a folder: a thread, in its coordinating chat's folder. */
    async createSession(folder) {
        const ws = await this.ctx.workspaceRegistry.create(folder);
        const created = await this.sc.create({ workspaceId: ws.id });
        return created.sessionId;
    }

    /** Resolve a session's live agent and install project behaviour on it. */
    async attach(sessionId) {
        const r = await this.sc.resolveAgent(sessionId);
        if (r?.agent) this.maybeInstall(r.agent);
        return r?.agent;
    }

    /**
     * Send a session a message, waking it when idle, as DSH's own agents and
     * scheduled tasks do. Done once the session log has it.
     * @param {'queue'|'steer'} mode - its next turn, or into the turn running now.
     * @param {string} [from] - the session it comes from (an agent's message,
     *   which also tells a thread's projection its coordinator), or none for
     *   the plugin's own notes.
     */
    async prompt(sessionId, text, mode = 'queue', from = undefined) {
        const found = await this.sc.resolveAgent(sessionId);
        if (!found?.agent) throw new Error(`session ${sessionId} is not available: ${found?.error?.message ?? found?.error?.code ?? 'not found'}`);
        this.maybeInstall(found.agent);
        const message = createUserMessage({ content: [{ type: 'text', text }], source: from ? agentSource(from) : PLUGIN_SOURCE });
        if (mode === 'steer') found.agent.steer(message);
        else found.agent.followup(message);
        const sessions = this.ctx.get?.('sessions');
        if (typeof sessions?.flush === 'function' && found.agent.session && !await sessions.flush(found.agent.session)) {
            throw new Error(`session ${sessionId} did not save the message`);
        }
    }

    // ── agent scope ────────────────────────────────────────────────────────

    maybeInstall(agent) {
        // A tool call that outlived a config reload hands its new session to the new manager.
        if (this.disposed) {
            managers.get(this.storeFile)?.maybeInstall(agent);
            return;
        }
        if (!agent || this.installed.has(agent)) return;
        const who = this.store.lookup(agent.id);
        if (!who || !this.projects.has(who.projectId)) return;
        // A chat that stopped coordinating is a plain chat again; its threads keep theirs.
        if (who.role === 'coordinator' && !this.coordinating(who.projectId)) return;
        // Runs inside the serial `agent/created` listener chain, where a throw
        // would fail the session's creation: log and leave the session plain.
        try {
            this.installed.set(agent, this.install(agent, who));
        } catch (error) {
            this.log(`error attach ${agent.id} ${String(error?.message ?? error).slice(0, 300)}`);
            this.ctx.logger?.warn?.('coordinator: could not attach to session %s: %s', agent.id, error?.message ?? error);
            return;
        }
        this.roles.set(agent, who);
        this.log(`attach ${who.role} ${who.projectId}${who.threadId ? `/${who.threadId}` : ''} ${agent.id}`);
    }

    forget(agent) {
        const dispose = this.installed.get(agent);
        if (!dispose) return;
        this.installed.delete(agent);
        this.roles.delete(agent);
        try { dispose(); } catch {}
    }

    /**
     * Install tools and the prompt section in one agent scope; for a thread
     * also its route override, status watcher and guards. The coordinating
     * chat gets no guard: it keeps the user's own access.
     */
    install(agent, who) {
        const scoped = agent.ctx;
        const disposers = [];
        const add = (d) => { if (typeof d === 'function') disposers.push(d); };
        const { projectId, role, threadId } = who;
        try {
            add(scoped.systemPrompt?.section({
                name: `coordinator:${role}`,
                order: SECTION_ORDER,
                interpolate: false,
                text: () => (role === 'coordinator' ? this.coordinatorText(projectId) : this.threadText(projectId, threadId)),
            }));
            for (const tool of this.buildTools(this, who)) add(scoped.tools.register(tool));
            if (role !== 'thread') return () => { for (const d of disposers.reverse()) { try { d(); } catch {} } };
            if (this.selectionMode === 'override') {
                // Outermost, so the Host's own selection listener cannot undo it.
                add(scoped.on('agent/request', async (_event, next) => {
                    const resolved = await next();
                    const route = await this.checkedRoute(who);
                    return route ? applyRoute(resolved, route.model, route.effort) : resolved;
                }, { prepend: true }));
            }
            if (agent.status === 'running') {
                // Attached mid-turn (the plugin reloaded): review the turn when it ends,
                // and watch the permission prompts it is already waiting on.
                this.turns.set(agent.id, { running: true });
                const t = this.store.thread(projectId, threadId);
                if (t && !t.busy) this.store.putThread(projectId, threadId, { busy: true });
                void this.rearmApprovals(projectId, threadId, agent).catch((error) => {
                    this.log(`error approval ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
                });
            }
            add(scoped.on('agent/status', ({ status }) => {
                void this.onThreadStatus(projectId, threadId, agent, status).catch((error) => {
                    this.log(`error status ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
                });
            }));
            add(scoped.on('session/event', (_session, event) => this.onThreadEvent(projectId, threadId, agent, event)));
            add(() => this.clearApprovals(agent.id));
            add(() => { this.pendingSends.delete(agent.id); this.callSteps.delete(agent.id); this.askedCalls.delete(agent.id); });
            add(() => this.ownSelections.delete(agent.id));
            add(() => this.ownPermissions.delete(agent.id));
            // The user's tools it may not use: left out of what its model is offered, and refused if called anyway.
            if (typeof scoped.tools?.guard === 'function') add(scoped.tools.guard((exec) => this.callReason(who, exec)));
            add(() => this.dropWall(agent));
            this.applyWall(agent, who);
        } catch (error) {
            for (const d of disposers.reverse()) { try { d(); } catch {} }
            throw error;
        }
        return () => { for (const d of disposers.reverse()) { try { d(); } catch {} } };
    }

    /** The model route for one thread, read live so a change applies on the next request. */
    routeFor(who) {
        if (who.role !== 'thread' || !this.projects.has(who.projectId)) return null;
        const t = this.store.thread(who.projectId, who.threadId);
        return t ? { model: t.model, effort: t.effort } : null;
    }

    /**
     * The route checked against the catalog. An effort the model lacks is
     * dropped or fitted to the nearest level it offers, so a default model
     * that changed under an inherited effort still runs.
     */
    async checkedRoute(who) {
        const route = this.routeFor(who);
        if (!route || (!route.model && !route.effort)) return route;
        const check = checkSelection(await this.catalog(), route.model, route.effort, { fit: true });
        if (check.ok && check.fitted) this.log(`fit ${who.projectId}/${who.threadId} ${check.note}`);
        return check.ok ? { model: check.model ?? route.model, effort: check.effort } : route;
    }

    /**
     * The complete selection for a route. An unset model means the DSH
     * default model; an unset effort means the model's own default, and a
     * fully unset route means the DSH default selection.
     */
    fullSelection(route) {
        let base = {};
        try { base = this.ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {}; } catch {}
        if (!route?.model && !route?.effort) return base.provider && base.model ? { ...base } : null;
        const parsed = route.model ? parseModelSpec(route.model, base.provider) : { provider: base.provider, model: base.model };
        if (!parsed?.provider || !parsed.model) return null;
        return { provider: parsed.provider, model: parsed.model, ...(route.effort ? { reasoningEffort: route.effort } : {}) };
    }

    /** Validate a selection and fill in the adapter's default effort, as the DSH picker does. */
    async resolveSelection(selection) {
        const llm = this.ctx.get?.('llm');
        if (typeof llm?.resolveCallConfig !== 'function') return selection;
        const r = await llm.resolveCallConfig(selection, AbortSignal.timeout(20000));
        return { provider: r.provider, model: r.model, ...(r.reasoningEffort === undefined ? {} : { reasoningEffort: String(r.reasoningEffort) }) };
    }

    /**
     * Put one thread on its route from its next model request, the way the
     * DSH model picker does, without saving a global default.
     * @returns the selection recorded, or false.
     */
    async selectRoute(agent, who) {
        if (this.selectionMode !== 'session' || !agent) return false;
        const label = `${who.projectId}/${who.threadId}`;
        try {
            const wanted = this.fullSelection(await this.checkedRoute(who));
            if (!wanted) throw new Error('no DSH default model to build on');
            const selection = await this.resolveSelection(wanted);
            this.ownSelections.set(agent.id, selectionKey(selection));
            this.sc.agents.selectForNextRequest(agent, selection);
            this.log(`select ${label} ${selection.provider}:${selection.model} effort=${selection.reasoningEffort ?? '-'}`);
            return selection;
        } catch (error) {
            this.ownSelections.delete(agent.id);
            this.log(`error select ${label} ${String(error?.message ?? error).slice(0, 200)}`);
            this.ctx.logger?.warn?.('coordinator: could not set the model for %s: %s', label, error?.message ?? error);
            return false;
        }
    }

    /**
     * A `model/selection` on a thread. One the manager made itself is
     * skipped. Any other is the user's pick in DSH's own model picker (the
     * composer's model menu or /model): it becomes that thread's model and
     * effort, so Thread settings say what it runs on.
     */
    onSelection(who, agent, data) {
        try {
            if (who.role !== 'thread' || typeof data?.provider !== 'string' || typeof data?.model !== 'string' || !this.projects.has(who.projectId)) return;
            if (this.ownSelections.get(agent.id) === selectionKey(data)) {
                this.ownSelections.delete(agent.id);
                return;
            }
            const model = `${data.provider}:${data.model}`;
            const effort = typeof data.reasoningEffort === 'string' && data.reasoningEffort !== '' ? data.reasoningEffort : undefined;
            if (!this.store.thread(who.projectId, who.threadId)) return;
            this.store.putThread(who.projectId, who.threadId, { model, effort });
            this.log(`picked ${who.projectId}/${who.threadId} ${model} effort=${effort ?? '-'}`);
        } catch (error) {
            this.log(`error picked ${who.projectId} ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    readMemory(projectId) {
        try { return readFileSync(this.memoryPath(projectId), 'utf8'); } catch { return ''; }
    }

    coordinatorText(projectId) {
        const project = this.project(projectId);
        return coordinatorPolicy({
            workspacePath: project.workspacePath,
            home: isHome(project.workspacePath),
            guarded: this.guards().map(([name]) => name),
            yourTools: this.access(projectId).yourTools.value,
            paused: this.paused(projectId),
            threads: this.store.project(projectId).threads,
            memory: this.readMemory(projectId),
            liveStatus: (sid) => this.liveStatus(sid),
        });
    }

    threadText(projectId, threadId) {
        const project = this.project(projectId);
        const t = this.store.thread(projectId, threadId);
        const tools = this.toolsFor({ projectId, role: 'thread', threadId });
        return threadPolicy({
            name: project.name,
            threadId,
            title: t?.title ?? threadId,
            home: isHome(t?.folder ?? project.workspacePath),
            guarded: this.guards().map(([name]) => name),
            yourTools: tools === 'all' ? 'always' : 'asked',
            // Under "asked", the user's tools this thread has.
            tools: tools === 'all' ? undefined : [...tools],
            memory: this.readMemory(projectId),
        });
    }

    /**
     * Track thread turns. DSH runs queued messages as back-to-back turns and
     * goes idle once at the end, so the review looks at the last turn only.
     */
    async onThreadStatus(projectId, threadId, agent, status) {
        const state = this.turns.get(agent.id) ?? { running: false };
        if (status === 'running') {
            if (state.running) return;
            this.turns.set(agent.id, { running: true });
            // Marks a turn in flight, so one cut off by a DSH stop is reviewed at the next start.
            const t = this.store.thread(projectId, threadId);
            if (t && !t.busy) this.store.putThread(projectId, threadId, { busy: true });
            return;
        }
        if (status !== 'idle') return;
        // A turn that ended, however it ended, holds back no send (holdSend).
        this.pendingSends.delete(agent.id);
        this.callSteps.delete(agent.id);
        if (!state.running) return;
        this.turns.set(agent.id, { running: false });
        if (this.store.thread(projectId, threadId)?.busy) this.store.putThread(projectId, threadId, { busy: false });
        await this.reviewTurn(projectId, threadId, agent.id, { stopped: state.stopped });
    }

    /**
     * Review a thread's last ended turn once. A turn the coordinator started
     * that ended without a handback sends the automatic note. A turn the user
     * started by talking to the thread directly is only recorded for the
     * coordinator's roster: the user is already there, and a note would make
     * the coordinator take a turn for nothing.
     * @param {object} [options]
     * @param {{key: unknown}} [options.stopped] - the turn the coordinator stopped.
     * @param {boolean} [options.catchUp] - reviewing at start: only a turn that really ended.
     */
    async reviewTurn(projectId, threadId, sessionId, { stopped, catchUp = false } = {}) {
        const turn = await this.readTurn(sessionId);
        // What the turn changed, from the thread's own edits, whatever happens below.
        if (turn.ended) {
            try {
                await this.recordOwnChanges(projectId, threadId, sessionId, turn.number, { ...turn.read, waitForDsh: true });
            } catch (error) {
                this.log(`error changes ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
            }
        }
        const t = this.store.thread(projectId, threadId);
        if (!t || t.resolved || (catchUp && !turn.ended)) return;
        // The coordinator stopped this turn itself, so a note would only echo that back.
        const byCoordinator = Boolean(stopped && stopped.key === turn.key && turn.endKind === 'aborted');
        // A person stopped it, in DSH or through the session bridge: it stays stopped until they resume it.
        const byUser = !byCoordinator && turn.endKind === 'aborted' && turn.stopCause === 'user';
        if (turn.ended) {
            if (t.seenTurn === turn.key) return;
            // How the turn ended, for the coordinator's roster: kept while it failed or stopped.
            const text = byUser ? STOPPED_BY_USER : turn.ending;
            const ending = !turn.handedBack && endingStateOf(text) ? text.slice(0, 400) : undefined;
            this.store.putThread(projectId, threadId, {
                seenTurn: turn.key,
                lastEnding: ending ? { text: ending, kind: turn.endKind, at: new Date().toISOString() } : undefined,
            });
        }
        if (turn.handedBack || byCoordinator) return;
        if (this.archived(projectId)) {
            // Archiving stopped it, or the user brought it back alone and talked to it: nothing for the coordinator.
            this.log(`archived-turn ${projectId}/${threadId}`);
            return;
        }
        if (byUser) {
            // No note, so the coordinator takes no turn and can't send it on by itself.
            this.log(`user-stop ${projectId}/${threadId}`);
            return;
        }
        if (!turn.fromProject) {
            // The user talked to it there, so a question it had asked the coordinator is theirs to answer now.
            this.store.putThread(projectId, threadId, { lastDirect: { at: new Date().toISOString(), reply: turn.reply.slice(0, 500) }, question: undefined });
            this.log(`direct-turn ${projectId}/${threadId} chars=${turn.reply.length}`);
            return;
        }
        if (t.question && !turn.ending) {
            // It ended its turn to wait for the answer to its question, which the coordinator already has.
            this.log(`idle-question ${projectId}/${threadId}`);
            return;
        }
        if (this.config.autoHandback !== 'idle' || !this.allowHandback(projectId, threadId)) return;
        // One nudge in a row for a turn that ended without a handback, counted apart for a turn that failed or stopped
        // and one that just ended, so each note says what happened; the user hears when it didn't help, or when only they
        // can fix it, and the coordinator sends nothing more. The plugin sends the nudge itself, since a coordinator turn
        // would only say so (and tell the user); while the project is paused its note waits like any other, and the
        // coordinator nudges it on resume. A handback, the user's words, their Retry or their answer to its prompt
        // start the count again. A turn cut off because DSH closed while it ran (a quit, or a crash: its log can't
        // tell them apart) gets no nudge and doesn't count, so nothing starts again on its own after the user quits:
        // the note tells them, and the thread waits for their Resume.
        const ended = Boolean(endingStateOf(turn.ending));
        const cutOff = turn.endKind === 'interrupted' || (turn.endKind === 'aborted' && turn.stopCause === 'disposed');
        const again = !cutOff && (ended ? t.nudged === true : t.stalled === true);
        const nudge = !again && !cutOff && !(ended && userMustFix(turn.ending));
        if (!cutOff) this.store.putThread(projectId, threadId, ended ? { nudged: nudge ? true : undefined } : { nudged: undefined, stalled: true });
        if (nudge && !this.held(projectId) && await this.nudgeThread(projectId, threadId, turn, ended)) return;
        const news = nudge && ended ? undefined : { kind: ended ? endingStateOf(turn.ending) : 'finished', thread: threadId };
        const declined = Array.isArray(this.store.thread(projectId, threadId)?.declined) ? this.store.thread(projectId, threadId).declined : [];
        if (declined.length > 0) this.store.putThread(projectId, threadId, { declined: undefined });
        await this.deliver(projectId, idleMessage(threadId, t.title, turn.reply, turn.ending, { nudge: nudge && ended, again, declined }), undefined, news);
        this.log(`idle-note ${projectId}/${threadId} chars=${turn.reply.length}${turn.ending ? ` ended=${turn.endKind}` : ''}${nudge && ended ? ' nudge' : ''}${again ? ' again' : ''}`);
    }

    /**
     * The one nudge after a turn that ended without a handback (NUDGE after one that failed or stopped, IDLE_NUDGE
     * after one that just ended), sent to the thread as from its coordinator (the next turn's end is reviewed as the
     * coordinator's).
     * @param {boolean} ended - the turn failed or stopped.
     * @returns whether it went; when it didn't, the coordinator gets the note and nudges it.
     */
    async nudgeThread(projectId, threadId, turn, ended) {
        try {
            await this.sendToThread(projectId, threadId, ended ? NUDGE : IDLE_NUDGE, false);
        } catch (error) {
            this.log(`error nudge ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
            return false;
        }
        this.log(`nudge ${projectId}/${threadId} ${ended ? `ended=${turn.endKind}` : 'idle'}`);
        return true;
    }

    /**
     * At start: review the turns of threads that were mid-turn when the
     * plugin last looked, unless they are running now (their end is watched).
     */
    async catchUp(projectId) {
        for (const [threadId, t] of Object.entries(this.store.project(projectId).threads)) {
            if (this.disposed) return;
            if (!t.busy || t.resolved) continue;
            if (this.ctx.agents.get(t.sessionId)?.status === 'running') continue;
            this.store.putThread(projectId, threadId, { busy: false });
            try {
                await this.reviewTurn(projectId, threadId, t.sessionId, { catchUp: true });
            } catch (error) {
                this.log(`error catch-up ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
            }
        }
    }

    /**
     * Watch a thread's permission prompts. Each tells the coordinator, at
     * once or when still unanswered after approvalNoticeSeconds, so a thread
     * it started does not sit on a prompt nobody sees.
     */
    onThreadEvent(projectId, threadId, agent, event) {
        this.settleSend(agent.id, event);
        if (event?.type === 'model/selection') {
            this.onSelection({ projectId, role: 'thread', threadId }, agent, event.data);
            return;
        }
        if (event?.type === 'permission/preset') {
            this.onPermission({ projectId, role: 'thread', threadId }, agent, event.data);
            return;
        }
        if (event?.type === 'turn/start') {
            if (Number.isSafeInteger(event.data?.turn)) this.threadTurns.set(agent.id, event.data.turn);
            return;
        }
        if (event?.type === 'workspace/changes') {
            this.noteChanges(projectId, threadId, agent.id, event.seq, event.data?.turn);
            return;
        }
        // DSH queues a message (agent/inbox/spliced) before the turn that reads it gathers its
        // tools, and logs it (user/message) once that turn already has them: the queued copy
        // is what lets the user's words give a tool to the very turn that answers them.
        if (event?.type === 'agent/inbox/spliced') {
            for (const message of Array.isArray(event.data?.inserted) ? event.data.inserted : []) this.onThreadPrompt(projectId, threadId, promptOf({ type: 'user/message', data: message }));
            return;
        }
        const prompt = promptOf(event);
        if (prompt) {
            this.onThreadPrompt(projectId, threadId, prompt);
            return;
        }
        const id = event?.data?.id;
        if (!id) return;
        if (event.type === 'approval/decided') {
            clearTimeout(this.approvals.get(agent.id)?.get(id));
            this.approvals.get(agent.id)?.delete(id);
            // The user answered its prompt (Allow once or Reject; a policy that never asks rejects by itself), so what
            // it does next is new: a turn that then ends without a handback gets its own nudge, as after their words.
            const outcome = event.data?.outcome;
            if ((outcome === 'allowed-once' || outcome === 'rejected') && this.approvalPolicyOf(agent.session) === 'ask') {
                const t = this.store.thread(projectId, threadId);
                if (t?.nudged || t?.stalled) {
                    this.store.putThread(projectId, threadId, { nudged: undefined, stalled: undefined });
                    this.log(`prompt-answered ${projectId}/${threadId} ${outcome}`);
                }
            }
            return;
        }
        if (event.type !== 'approval/asked') return;
        const notice = () => {
            void this.noticeApproval(projectId, threadId, agent, event.data).catch((error) => {
                this.log(`error approval ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
            });
        };
        // At once by default: each send a thread makes waits on a prompt, and the user should hear of it then.
        if (!(this.config.approvalNoticeSeconds > 0)) {
            notice();
            return;
        }
        const pending = this.approvals.get(agent.id) ?? new Map();
        this.approvals.set(agent.id, pending);
        const timer = setTimeout(() => {
            pending.delete(id);
            notice();
        }, this.config.approvalNoticeSeconds * 1000);
        timer.unref?.();
        pending.set(id, timer);
    }

    /** The user writing to a thread directly: the tools their words name are theirs to give it. */
    onThreadPrompt(projectId, threadId, prompt) {
        if (!prompt || prompt.fromProject) return;
        try {
            const guard = this.guards();
            if (guard.length > 0) this.addThreadTools(projectId, threadId, guardedIn(prompt.text, guard, { aliases: true }), 'from the user in the thread');
        } catch (error) {
            this.log(`error tools ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /**
     * DSH announced a thread turn's changes. Its summary diffs the whole
     * folder, so it would credit the thread with what other threads and
     * chats there changed meanwhile: the plugin counts the turn from the
     * thread's own edits instead, and keeps DSH's announcement only so its
     * Review tab opens that turn.
     */
    noteChanges(projectId, threadId, sessionId, seq, turn) {
        if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(turn)) return;
        const turns = this.announced.get(sessionId) ?? new Map();
        turns.set(turn, seq);
        // The newest few turns are enough: a turn is announced at its end.
        for (const key of [...turns.keys()].slice(0, -8)) turns.delete(key);
        this.announced.set(sessionId, turns);
        void this.recordOwnChanges(projectId, threadId, sessionId, turn).catch((error) => {
            this.log(`error changes ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
        });
    }

    /**
     * Keep one turn's changes with the thread, counted from its own
     * file-tool records (write, edit, str_replace_editor) and its
     * subagents': lines added and deleted per file, so the totals outlive a
     * DSH restart. A turn that changed nothing of its own keeps no record.
     * @param {{events: object[], folder?: string, endSeq?: number, waitForDsh?: boolean}} [read] - the thread's log, when the caller
     *   already read it; `waitForDsh` at the turn's end, when DSH may still announce the turn.
     */
    async recordOwnChanges(projectId, threadId, sessionId, turn, read = undefined) {
        if (!Number.isSafeInteger(turn) || !this.store.thread(projectId, threadId)) return;
        let { events, folder, endSeq } = read ?? {};
        if (!Array.isArray(events)) {
            const inspected = await this.sc.inspect(sessionId, AbortSignal.timeout(20000));
            events = ownEvents(inspected);
            folder = inspected?.meta?.cwd;
        }
        // The turn's shell edits, computed here once per turn (shell.js), before anything waits on DSH's announcement.
        let shell = [];
        try {
            shell = (await this.shellEdits(sessionId, turn)) ?? [];
        } catch (error) {
            this.log(`error shell ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
        }
        // From here on nothing waits, so what was announced meanwhile and the stored records are read as they are now.
        const t = this.store.thread(projectId, threadId);
        if (!t) return;
        const own = editsIn(events).filter((e) => e.turn === turn);
        const sub = (this.subEdits.get(sessionId) ?? []).filter((e) => e.turn === turn);
        // Subagent edits of turns long over are no longer needed.
        if (this.subEdits.has(sessionId)) this.subEdits.set(sessionId, this.subEdits.get(sessionId).filter((e) => Number.isSafeInteger(e.turn) && e.turn >= turn - 2));
        const was = (Array.isArray(t.changes) ? t.changes : []).find((r) => r?.turn === turn);
        // A file the turn's file tools already counted is left to their records, so a file a shell command and a file
        // tool both changed counts once, under the record that has its hunks.
        const cwd = folder ?? this.ctx.agents.get(sessionId)?.session?.header?.cwd;
        const counted = new Set([...own, ...sub].map((e) => resolve(expand(typeof cwd === 'string' ? cwd : '/'), expand(e.path))));
        const summary = editSummary(turn, [...own, ...sub, ...shell.filter((e) => !counted.has(e.path))], cwd);
        if (!summary && !was) return;
        const announced = this.announced.get(sessionId)?.get(turn);
        // DSH announces a turn's changes a moment after the turn ends: wait for that, so the record
        // carries its seq and Review opens the turn. Without one (nothing changed in the folder as
        // DSH sees it, or no DSH service), the turn's end stands in.
        if (announced === undefined && read?.waitForDsh && summary && this.ctx.get?.('workspaceChanges')) {
            const timer = setTimeout(() => {
                if (this.disposed || this.announced.get(sessionId)?.has(turn)) return;
                void this.recordOwnChanges(projectId, threadId, sessionId, turn, { ...read, waitForDsh: false }).catch((error) => {
                    this.log(`error changes ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
                });
            }, this.announceWaitMs);
            timer.unref?.();
            return;
        }
        const seq = announced ?? (Number.isSafeInteger(endSeq) ? endSeq : undefined) ?? own.at(-1)?.seq ?? was?.seq ?? 0;
        // A created file keeps which file it was (noteCreated), so after a restart the delete check still knows it is the thread's.
        const base = folder ?? this.ctx.agents.get(sessionId)?.session?.header?.cwd;
        const made = this.made.get(sessionId);
        for (const f of summary?.files ?? []) {
            const id = f.created === true && typeof base === 'string' ? made?.get(resolve(expand(base), expand(f.path))) : undefined;
            if (id) f.identity = id;
        }
        const record = summary ? changeRecord(seq, summary) : { turn, seq, added: 0, deleted: 0, total: 0, files: [] };
        if (!record) return;
        const changes = withChange(t.changes, record);
        if (JSON.stringify(changes) === JSON.stringify(t.changes ?? [])) return;
        try {
            this.store.putThread(projectId, threadId, { changes });
        } catch (error) {
            this.log(`error changes ${projectId}/${threadId} ${String(error?.message ?? error).slice(0, 200)}`);
            return;
        }
        this.log(`changes ${projectId}/${threadId} turn=${turn} files=${record.total} +${record.added} -${record.deleted}${sub.length > 0 ? ` subagents=${sub.length}` : ''}${shell.length > 0 ? ` shell=${shell.length}` : ''}`);
    }

    /**
     * A coordinating chat goes by its title, whoever gave it (DSH from its
     * first message, or the user), so briefs and notes name it as DSH does.
     * A thread renamed in DSH (Rename on its row in the session list) takes
     * that name here too, so the plugin's lists and the coordinator's roster
     * say what DSH says; for a thread only a name someone gave counts: a
     * title DSH makes from the first message never replaces the one it
     * started with. Never throws: this runs inside DSH's event delivery.
     */
    followTitle(session, event) {
        try {
            if (typeof event.data?.title !== 'string') return;
            const who = this.store.lookup(session?.id);
            if (!who || !this.projects.has(who.projectId)) return;
            if (who.role === 'coordinator') {
                const name = clipTitle(event.data.title);
                if (!name || name === storedName(this.store.projects[who.projectId])) return;
                this.store.putProject(who.projectId, { name });
                this.log(`chat-title ${who.projectId}`);
                return;
            }
            if (who.role !== 'thread' || event.data?.source?.kind !== 'user') return;
            const title = clipTitle(event.data.title);
            if (!title || title === this.store.thread(who.projectId, who.threadId)?.title) return;
            this.store.putThread(who.projectId, who.threadId, { title });
            this.log(`thread-title ${who.projectId}/${who.threadId} from-dsh`);
        } catch (error) {
            this.log(`error thread-title ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /**
     * Every session's events, as DSH's own change recorder hears them: a
     * file edit by a subagent (or a teammate) that works for a thread counts
     * for that thread's turn. The thread's own edits are read from its log.
     * Never throws: this runs inside DSH's event delivery.
     */
    onSessionEvent(session, event) {
        const type = event?.type;
        if (type === 'session/title') {
            this.followTitle(session, event);
            return;
        }
        if (type !== 'tool/call' && type !== 'tool/result') return;
        try {
            const id = session?.id;
            if (typeof id !== 'string') return;
            if (type === 'tool/call') {
                if (!FILE_TOOLS.has(event.data?.name) || typeof event.data.callId !== 'string') return;
                // A thread's own calls too, for the files it creates (its edits are read from its log); any other
                // session's for who wrote what, which the delete check never counts as a thread's.
                const self = this.store.lookup(id)?.role === 'thread';
                const thread = self ? id : this.threadAbove(session);
                this.subCalls.set(`${id}\n${event.data.callId}`, { name: event.data.name, args: event.data.arguments, thread, self, cwd: this.cwdOf(session) });
                for (const key of [...this.subCalls.keys()].slice(0, -500)) this.subCalls.delete(key);
                return;
            }
            const message = event.data?.message;
            const key = `${id}\n${message?.toolCallId ?? message?.source?.callId}`;
            const call = this.subCalls.get(key);
            if (!call) return;
            this.subCalls.delete(key);
            if (message?.isError === true || event.data?.error !== undefined) return;
            let args = call.args;
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
            const edit = editOf(call.name, args, event.data?.meta);
            if (!edit) return;
            this.noteWritten(call.thread, edit.path, call.cwd, edit.created === true);
            if (!call.thread || !(edit.added + edit.deleted > 0 || edit.created)) return;
            if (call.self) return;
            const list = this.subEdits.get(call.thread) ?? [];
            list.push({ turn: this.threadTurns.get(call.thread) ?? null, seq: event.seq, ...edit });
            this.subEdits.set(call.thread, list.slice(-500));
        } catch (error) {
            this.log(`error subagent-edit ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /** The session of every thread the store has, archived projects' too. */
    threadSessions() {
        const sessions = new Set();
        for (const project of Object.values(this.store.projects ?? {})) {
            for (const thread of Object.values(project?.threads ?? {})) {
                if (typeof thread?.sessionId === 'string' && thread.sessionId !== '') sessions.add(thread.sessionId);
            }
        }
        return sessions;
    }

    /**
     * The thread sessions whose kept texts stay (net.js prune): every thread
     * the store has, archived projects' too (Restore brings their
     * diffs back), but not one whose chat DSH no longer has. Only threads
     * with kept texts that DSH's list leaves out are looked up; when the list
     * or a session can't be read, the thread stays.
     */
    async netKeep() {
        const sessions = this.threadSessions();
        const unlisted = [...sessions].filter((id) => existsSync(this.net.dir(id)));
        if (unlisted.length === 0) return sessions;
        let items;
        try {
            ({ items } = await this.sc.list({}, AbortSignal.timeout(20000)));
        } catch (error) {
            this.log(`error list ${String(error?.message ?? error).slice(0, 200)}`);
            return sessions;
        }
        const known = new Set((Array.isArray(items) ? items : []).map((item) => item?.sessionId));
        for (const id of unlisted) {
            if (this.disposed) break;
            if (!known.has(id) && await this.exists(id).catch(() => true) === false) sessions.delete(id);
        }
        return sessions;
    }

    /** Sweep the Changes tab's kept texts (net.js prune): at start, then every NET_SWEEP_MS. */
    async sweepNet() {
        try {
            const keep = await this.netKeep();
            if (!this.disposed) await this.net.prune(keep);
        } catch (error) {
            this.log(`error net-sweep ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /**
     * The folder a session's relative paths resolve in, as DSH's tools
     * resolve them: on DSH 0.2.1 its working directory (working_directory
     * changes it), else the folder it started in; undefined without one.
     */
    cwdOf(session) {
        const first = session?.header?.cwd;
        if (typeof first !== 'string' || first === '') return undefined;
        try {
            const now = this.ctx.get?.('workingDirectory')?.get?.(session);
            if (typeof now === 'string' && isAbsolute(now)) return now;
        } catch {}
        return first;
    }

    /** The folders a thread's kept texts may come from (net.js notKept): the folder it started in, its own and its project's workspace. */
    netRoots(thread, t, projectId, first = this.ctx.agents.get(thread)?.session?.header?.cwd) {
        return [first, t?.folder, this.projects.get(projectId)?.workspacePath].filter((root) => typeof root === 'string' && root !== '').map((root) => resolve(expand(root)));
    }

    /**
     * One tool call as DSH runs it (`tools/execute`): a file-tool call of a
     * thread, or of a subagent working for one, on a file in its folders
     * keeps the file's text from before the thread's first edit of it and
     * after each that succeeds (net.js), for the one diff per file its
     * Changes tab shows; their bash or pwsh command
     * that makes folders keeps the ones it made as the thread's own, for
     * the delete check (madeTarget). A thread's first shell command of a
     * turn snapshots its folder first, for that turn's shell counts
     * (shell.js); and every session's command or file edit is kept as
     * running while it is, so a shell window knows whose changes it may
     * hold. Any other call runs as it is, and keeping either never fails a
     * call.
     */
    aroundTool(exec, next) {
        let thread = null;
        let target = null;
        let made = null;
        let owner = null;
        try {
            thread = this.threadOfCall(exec);
            owner = thread ?? this.callerOf(exec);
            if (thread) {
                target = this.netTarget(exec, thread);
                if (!target) made = this.madeTarget(exec, thread);
            }
        } catch (error) {
            this.log(`error net-target ${String(error?.message ?? error).slice(0, 200)}`);
        }
        const run = () => {
            if (!thread) return next();
            return this.whileRunning(thread, () => (made ? this.aroundMade(made, next)
                : target ? this.net.around(target.thread, target.file, next, typeof exec.callId === 'string' ? exec.callId : undefined, target.expect)
                : next()));
        };
        // A call that cannot write holds no window; one whose owner can't be told is nobody's to attribute.
        if (owner === null || !MUTATING_TOOLS.has(exec?.name)) return run();
        return this.whileMutating(owner, thread, async () => {
            if (thread && SHELL_TOOLS.has(exec?.name)) await this.shellSnapshot(thread, exec);
            return run();
        });
    }

    /** The session a call belongs to, when no thread does: its own agent's, or null when there is none. */
    callerOf(exec) {
        const id = exec?.agent?.session?.id ?? exec?.agent?.id;
        return typeof id === 'string' && id !== '' ? id : null;
    }

    /** One mutating call as its owner runs it (shell.js Mutations): counted while it is, outcome as it is. */
    async whileMutating(owner, thread, run) {
        this.mutations.begin(owner, thread !== null ? this.threadTurns.get(thread) ?? null : null);
        try {
            return await run();
        } finally {
            this.mutations.end(owner);
        }
    }

    /**
     * The thread's folder as its turn's first shell command is about to run
     * (shell.js snapshotFolder): the side its shell edits are counted
     * against. A turn without a shell command never snapshots, a second
     * command of the same turn keeps the first one's, and this never fails
     * the call. The snapshot lives in memory only — a turn that spans a
     * restart counts no shell edits.
     */
    async shellSnapshot(thread, exec) {
        try {
            const turn = this.threadTurns.get(thread) ?? null;
            if (turn === null) return;
            const was = this.shellSnaps.get(thread);
            if (was && was.turn === turn) return;
            const root = this.shellFolder(thread);
            if (root === undefined) return;
            const files = await snapshotFolder(resolve(expand(root)));
            this.shellSnaps.set(thread, { turn, root: resolve(expand(root)), at: Date.now(), files, edits: null });
            for (const key of [...this.shellSnaps.keys()].slice(0, -200)) this.shellSnaps.delete(key);
        } catch (error) {
            this.log(`error shell-snap ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /**
     * The folder a thread's snapshot walks: its working directory (as DSH's
     * tools resolve it, cwdOf), else the folder it started in, else its
     * chat's workspace; undefined without one.
     */
    shellFolder(thread) {
        const who = this.store.lookup(thread);
        const t = who?.role === 'thread' ? this.store.thread(who.projectId, who.threadId) : null;
        const agent = this.ctx.agents.get(thread);
        return [agent ? this.cwdOf(agent.session) : undefined, t?.folder, this.projects.get(who?.projectId)?.workspacePath]
            .find((p) => typeof p === 'string' && p !== '');
    }

    /**
     * A turn's shell-command edits (shell.js diffFolder): the folder now
     * against the snapshot its first shell command took, counted only when
     * no other session's mutating call ran in the window, and the thread's
     * own in no turn but this one. Computed once per turn; a turn without a
     * snapshot (no shell command, or a restart) has none.
     * @returns {Promise<Array<{path: string, added: number, deleted: number, created?: true, binary?: true, oversized?: true}>>}
     */
    shellEdits(thread, turn) {
        const snap = this.shellSnaps.get(thread);
        if (!snap || snap.turn !== turn) return Promise.resolve([]);
        if (snap.edits === null) {
            const { root, at, turn: countedTurn } = snap;
            snap.edits = (async () => {
                try {
                    const before = snap.files;
                    snap.files = null;
                    const edits = await diffFolder(root, before);
                    if (!this.mutations.overlapped(thread, at, Date.now(), countedTurn)) return edits;
                    this.log(`shell-window ${thread} turn=${countedTurn} shared`);
                    return [];
                } catch (error) {
                    this.log(`error shell-diff ${thread} ${String(error?.message ?? error).slice(0, 200)}`);
                    return [];
                }
            })();
        }
        return snap.edits;
    }

    /** The thread session a call works for: a thread's own call, or a subagent's of one; null for any other. */
    threadOfCall(exec) {
        if (this.disposed || !exec?.agent) return null;
        const session = exec.agent.session;
        const id = session?.id ?? exec.agent.id;
        const own = this.store.lookup(id);
        return own?.role === 'thread' ? id : own ? null : this.threadAbove(session);
    }

    /**
     * Run one of a thread's calls (or its subagent's), keeping when the
     * thread ran calls: what is born in a folder it made while it ran is its
     * own, for the delete check (mineOf). The call's outcome as it is.
     */
    async whileRunning(thread, run) {
        let s = this.spans.get(thread);
        if (!s) {
            s = { running: 0, since: 0, list: [] };
            this.spans.set(thread, s);
            for (const key of [...this.spans.keys()].slice(0, -200)) {
                if (this.spans.get(key).running === 0) this.spans.delete(key);
            }
        }
        if (s.running++ === 0) s.since = Date.now();
        try {
            return await run();
        } finally {
            if (--s.running === 0) {
                const end = Date.now();
                const last = s.list.at(-1);
                if (last && s.since - last[1] <= CLOCK_SLACK_MS) last[1] = end;
                else s.list.push([s.since, end]);
                if (s.list.length > 2000) s.list.splice(0, s.list.length - 2000);
            }
        }
    }

    /**
     * The folders a thread's (or its subagent's) bash or pwsh command
     * makes (deletes.js madeDirsOf) that aren't there yet, not even as a
     * link: {thread, dirs}, or null. In a shell that keeps its folder
     * between commands, only those named by full path.
     */
    madeTarget(exec, thread) {
        if (exec?.name !== 'bash' && exec?.name !== 'pwsh') return null;
        const args = argsOf(exec.arguments);
        const command = typeof args.command === 'string' ? args.command : '';
        if (!/\b(?:mkdir|md|new-item|ni)\b/i.test(command)) return null;
        const session = exec.agent.session;
        const who = this.store.lookup(thread);
        const t = who?.role === 'thread' ? this.store.thread(who.projectId, who.threadId) : null;
        const cwd = [this.cwdOf(session), t?.folder, this.projects.get(who?.projectId)?.workspacePath].find((p) => typeof p === 'string' && p !== '');
        if (cwd === undefined) return null;
        const here = typeof args.workdir === 'string' && args.workdir.trim() !== '' ? resolve(expand(cwd), expand(args.workdir.trim())) : resolve(expand(cwd));
        const absent = (dir) => {
            try {
                lstatSync(dir);
                return false;
            } catch (error) {
                return error?.code === 'ENOENT';
            }
        };
        const dirs = madeDirsOf(command, { shell: exec.name, cwd: this.keepsFolder(exec) ? undefined : here }).filter(absent);
        return dirs.length > 0 ? { thread, dirs } : null;
    }

    /**
     * Run a command, then keep the folders it made as its thread's own
     * (noteCreated), whether or not it failed: each that is there now as a
     * real folder born while it ran. Not a link (`ln -s ~/Documents d &&
     * mkdir -p d`), nor a folder from before that it renamed or moved there
     * (`mv src d && mkdir -p d/sub`): batch 5 review M1, B5 and B2.
     */
    async aroundMade({ thread, dirs }, next) {
        const start = Date.now();
        try {
            return await next();
        } finally {
            try {
                let n = 0;
                for (const dir of dirs) {
                    let stat;
                    try { stat = lstatSync(dir); } catch { continue; }
                    const birth = bornOf(stat);
                    if (!stat.isDirectory() || birth === undefined || birth < start - CLOCK_SLACK_MS) continue;
                    this.noteCreated(thread, dir, undefined, stat);
                    n += 1;
                }
                const who = this.store.lookup(thread);
                if (n > 0) this.log(`made-dirs ${who?.projectId}/${who?.threadId} ${n}`);
            } catch (error) {
                this.log(`error made-dirs ${String(error?.message ?? error).slice(0, 200)}`);
            }
        }
    }

    /**
     * The thread whose net texts a file-tool call changes, its file as a
     * real path (links resolved) and what the call should leave (net.js
     * expectedAfter): {thread, file, expect}, or null, as for a file whose
     * texts aren't kept (notKept: outside the thread's folders, or a secret).
     */
    netTarget(exec, thread) {
        if (!FILE_TOOLS.has(exec?.name)) return null;
        const args = argsOf(exec.arguments);
        const named = changedPath(exec.name, args);
        if (!named) return null;
        const session = exec.agent.session;
        const who = this.store.lookup(thread);
        const t = who?.role === 'thread' ? this.store.thread(who.projectId, who.threadId) : null;
        const cwd = [this.cwdOf(session), t?.folder, this.projects.get(who?.projectId)?.workspacePath].find((p) => typeof p === 'string' && p !== '');
        const path = expand(named);
        if (!isAbsolute(path) && cwd === undefined) return null;
        const file = canonicalPath(resolve(expand(cwd ?? '/'), path));
        if (notKept(file, this.netRoots(thread, t, who?.projectId))) return null;
        return { thread, file, expect: expectedAfter(exec.name, args) };
    }

    /** A path as an absolute one, relative paths from `cwd` or else the thread's folder; undefined when it can't be told. */
    fullPath(thread, path, cwd) {
        const base = typeof cwd === 'string' ? cwd : this.ctx.agents.get(thread)?.session?.header?.cwd;
        if (typeof path !== 'string' || path === '' || (!isAbsolute(expand(path)) && typeof base !== 'string')) return undefined;
        return resolve(expand(base ?? '/'), expand(path));
    }

    /**
     * A file a thread (or its subagent) created, or a folder its command
     * made, kept for the delete check as the file it is now (`stat`, or
     * read), so one made again in its place later isn't its own: it may
     * delete it without asking. Nothing where the file system keeps no
     * birth time.
     */
    noteCreated(thread, path, cwd, stat = undefined) {
        const full = this.fullPath(thread, path, cwd);
        if (full === undefined) return;
        let id;
        try { id = identityOf(stat ?? lstatSync(full)); } catch {}
        if (id === undefined) return;
        const files = this.made.get(thread) ?? new Map();
        files.delete(full);
        files.set(full, id);
        for (const old of [...files.keys()].slice(0, -500)) files.delete(old);
        this.made.delete(thread);
        this.made.set(thread, files);
        for (const key of [...this.made.keys()].slice(0, -200)) this.made.delete(key);
    }

    /**
     * A file a session wrote with DSH's file tools (`thread`: the thread it
     * works for, or null for any other): who wrote it, so the delete check
     * never counts what another session wrote as a thread's, the user's own
     * chats included; and, for a thread, the file it made as DSH wrote it
     * again (DSH writes a new file in its place).
     */
    noteWritten(thread, path, cwd, created) {
        const full = this.fullPath(thread, path, cwd);
        if (full === undefined) return;
        const by = thread ?? '';
        const was = this.writers.get(full);
        this.writers.delete(full);
        this.writers.set(full, was === undefined || was === by ? by : '');
        for (const old of [...this.writers.keys()].slice(0, -5000)) this.writers.delete(old);
        if (!thread) return;
        if (created || (this.made.get(thread)?.has(full) && this.writers.get(full) === thread)) this.noteCreated(thread, full);
        else this.made.get(thread)?.delete(full);
    }

    /**
     * The thread session a subagent's session works for: its nearest
     * ancestor that is a thread, through subagents of subagents, or null.
     * A chat the user forked from a thread is the user's own (batch 5
     * review M1, B6), as in projectAbove.
     */
    threadAbove(session) {
        const id = session?.id;
        if (this.subThreads.has(id)) return this.subThreads.get(id);
        let header = session?.header;
        let found = null;
        for (let depth = 0; depth < 8 && header?.origin === 'subagent' && typeof header.parentSession === 'string' && header.parentSession !== ''; depth++) {
            const parent = header.parentSession;
            const who = this.store.lookup(parent);
            if (who) {
                if (who.role === 'thread') found = parent;
                break;
            }
            header = this.ctx.agents.get(parent)?.session?.header;
        }
        this.subThreads.set(id, found);
        for (const key of [...this.subThreads.keys()].slice(0, -500)) this.subThreads.delete(key);
        return found;
    }

    /**
     * A thread's changes as the window shows them: totals over its turns,
     * and whether DSH can still show the newest turn's diff.
     */
    threadChanges(t) {
        const totals = changeTotals(t.changes);
        if (!totals) return null;
        let reviewable = false;
        try { reviewable = typeof t.sessionId === 'string' && this.ctx.get?.('workspaceChanges')?.summary?.(t.sessionId, totals.last.seq) !== undefined; } catch {}
        return { ...totals, reviewable };
    }

    /**
     * A thread's changes as its Changes tab shows them: each file it changed
     * through DSH's file tools, or a subagent working for it did, with lines
     * added and deleted and each edit's hunks, read from their logs, and
     * what the edits came to (`net`, from the texts kept around them, or
     * `netWhy` when there is none: net.js); the project's other threads that
     * changed the same files (from their records); and the turns whose diff
     * DSH can still show in its Review.
     * @param {string} target - the thread's session, or a session of its project with `threadId`.
     */
    async threadDiffs(target, threadId = undefined) {
        const projectId = this.projectFor(target);
        const named = typeof threadId === 'string' && threadId.trim() !== '' ? threadId : this.store.lookup(String(target))?.threadId;
        if (!named) throw new ProjectError('not a thread: name one of this chat\'s threads');
        const { id: own, t } = this.requireThread(projectId, named);
        const base = { project: projectId, thread: own, title: t.title ?? '', session: t.sessionId ?? null };
        if (typeof t.sessionId !== 'string') return { ...base, files: [], turns: [] };
        let inspected;
        try {
            inspected = await this.sc.inspect(t.sessionId, AbortSignal.timeout(20000));
        } catch (error) {
            throw new ProjectError(`couldn't read ${own}'s records: ${String(error?.message ?? error).slice(0, 200)}`);
        }
        const events = ownEvents(inspected);
        const folder = inspected?.meta?.cwd ?? t.folder ?? this.project(projectId).workspacePath;
        const edits = editsIn(events, { hunks: true });
        // Its subagents' edits, from their own logs (two levels down), at the turn that started them.
        const children = subagentsIn(events).map((child) => ({ ...child, depth: 1 }));
        let unread = 0;
        for (let i = 0; i < children.length && i < 40; i++) {
            const child = children[i];
            let log;
            try {
                log = ownEvents(await this.sc.inspect(child.id, AbortSignal.timeout(10000)));
            } catch {
                unread += 1;
                continue;
            }
            const by = child.label || 'a subagent';
            for (const edit of editsIn(log, { hunks: true })) edits.push({ ...edit, turn: child.turn ?? edit.turn, by });
            if (child.depth < 2) children.push(...subagentsIn(log).map((c) => ({ ...c, turn: child.turn, label: c.label || child.label, depth: child.depth + 1 })));
        }
        // The thread's own edits came first in its log; a subagent's go with the turn that started it.
        const ordered = edits.map((edit, i) => ({ edit, i })).sort((a, b) => (a.edit.turn ?? 0) - (b.edit.turn ?? 0) || a.i - b.i).map(({ edit }) => edit);
        const files = diffFiles(ordered, folder);
        // Each file's net change, what the thread's edits came to, from the texts kept around them (net.js), if they
        // were kept around every one of its edits; past MAX_NET_CHARS for the file, or MAX_VIEW_CHARS in all, its
        // counts without its hunks.
        const callsOf = new Map();
        for (const edit of ordered) {
            if (typeof edit.path !== 'string' || edit.path === '' || typeof edit.call !== 'string') continue;
            const path = placeIn(folder, edit.path);
            callsOf.set(path, [...(callsOf.get(path) ?? []), edit.call]);
        }
        let budget = MAX_VIEW_CHARS;
        const roots = this.netRoots(t.sessionId, t, projectId, inspected?.meta?.cwd);
        for (const file of files) {
            const named = expand(file.path);
            const at = canonicalPath(isAbsolute(named) ? named : resolve(expand(typeof folder === 'string' ? folder : '/'), named));
            // A file outside the thread's folders, or a secret, has no kept texts (net.js notKept): edit by edit, and why.
            const not = notKept(at, roots);
            if (not) {
                file.netWhy = not;
                continue;
            }
            let seen;
            try {
                seen = await this.net.view(t.sessionId, at, callsOf.get(file.path) ?? []);
            } catch (error) {
                this.log(`error net-view ${projectId}/${own} ${String(error?.message ?? error).slice(0, 200)}`);
                seen = { why: 'none' };
            }
            if (!seen.net) {
                file.netWhy = seen.why;
                continue;
            }
            const size = seen.net.hunks.reduce((n, hunk) => n + (hunk.oldText?.length ?? 0) + hunk.newText.length, 0);
            if (size > MAX_NET_CHARS || size > budget) file.net = { ...seen.net, hunks: [], clipped: true };
            else {
                budget -= size;
                file.net = seen.net;
            }
        }
        // The project's other threads whose records name a file this one changed.
        for (const [otherId, other] of Object.entries(this.store.project(projectId)?.threads ?? {})) {
            if (otherId === own || !Array.isArray(other?.changes)) continue;
            const theirs = new Set(other.changes.flatMap((r) => (Array.isArray(r?.files) ? r.files.map((f) => placeIn(folder, String(f?.path ?? ''))) : [])));
            for (const file of files) {
                if (!theirs.has(file.path)) continue;
                const who = { thread: otherId, title: String(other.title ?? '').slice(0, 120), ...(typeof other.sessionId === 'string' ? { session: other.sessionId } : {}) };
                file.alsoBy = [...(file.alsoBy ?? []), who];
            }
        }
        const workspaceChanges = this.ctx.get?.('workspaceChanges');
        const turns = (Array.isArray(t.changes) ? t.changes : []).filter((r) => Number.isSafeInteger(r?.turn) && Number.isSafeInteger(r?.seq)).map((r) => {
            let reviewable = false;
            try { reviewable = workspaceChanges?.summary?.(t.sessionId, r.seq) !== undefined; } catch {}
            return { turn: r.turn, seq: r.seq, ...(reviewable ? { reviewable: true } : {}) };
        });
        return { ...base, folder: typeof folder === 'string' ? folder : null, files, turns, ...(unread > 0 ? { unread } : {}) };
    }

    clearApprovals(sessionId) {
        for (const timer of this.approvals.get(sessionId)?.values() ?? []) clearTimeout(timer);
        this.approvals.delete(sessionId);
    }

    /** Watch the permission prompts a running turn already waits on (after a reload). */
    async rearmApprovals(projectId, threadId, agent) {
        const events = (await this.sc.inspect(agent.id, AbortSignal.timeout(20000))).events ?? [];
        const { start } = turnRange(events, true);
        // The turn it is in, for what its subagents change before it ends.
        const turnNow = events[start]?.type === 'turn/start' ? events[start].data?.turn : undefined;
        if (Number.isSafeInteger(turnNow) && !this.threadTurns.has(agent.id)) this.threadTurns.set(agent.id, turnNow);
        const open = new Map();
        for (const event of events.slice(start)) {
            if (event?.type === 'approval/asked' && event.data?.id) open.set(event.data.id, event);
            else if (event?.type === 'approval/decided') open.delete(event.data?.id);
        }
        for (const event of open.values()) this.onThreadEvent(projectId, threadId, agent, event);
    }

    async noticeApproval(projectId, threadId, agent, data) {
        const t = this.store.thread(projectId, threadId);
        if (!t || t.resolved || !this.projects.has(projectId) || this.archived(projectId)) return;
        // Told once: a reload or a restart watches the prompts a turn still waits on again, but the
        // coordinator already heard about this one, and each note would start a turn of its own.
        const id = String(data.id ?? '');
        if (id !== '' && t.approvalsNoted?.includes(id)) return;
        const turn = await this.readTurn(agent.id, { current: true });
        // The user is talking to the thread directly, so the prompt is in front of them.
        if (!turn.fromProject || !this.allowHandback(projectId, threadId)) return;
        if (id !== '') this.store.putThread(projectId, threadId, { approvalsNoted: [...(this.store.thread(projectId, threadId)?.approvalsNoted ?? []), id].slice(-20) });
        // What it waits on goes to the coordinator without a password or token a URL in it carries.
        const reason = typeof data.reason === 'string' ? withoutCredentials(data.reason) : data.reason;
        await this.deliver(projectId, approvalMessage(threadId, t.title, t.title, String(data.toolName ?? 'a tool'), reason), undefined, { kind: 'approval', thread: threadId });
        this.log(`approval-note ${projectId}/${threadId} tool=${String(data.toolName ?? '').slice(0, 60)}`);
    }

    /** Rate cap: at most maxHandbacksPerHour per thread, explicit and automatic together. */
    allowHandback(projectId, threadId) {
        const t = this.store.thread(projectId, threadId);
        const now = Date.now();
        const recent = (t?.handbackTimes ?? []).filter((ms) => now - ms < HOUR);
        if (recent.length >= this.config.maxHandbacksPerHour) return false;
        this.store.putThread(projectId, threadId, { handbackTimes: [...recent, now] });
        return true;
    }

    /**
     * One turn of a session, read from its log: the last one that ended, or
     * with `current` the one running now. Returns its `key` (the seq of its
     * first event), whether it `ended`, how (`endKind`, and `ending` as a line
     * when that was not a normal completion), its last reply, whether it
     * handed back, and whether its prompt came from this project (the
     * coordinator) rather than from the user directly.
     */
    async readTurn(sessionId, { current = false } = {}) {
        const inspected = await this.sc.inspect(sessionId, AbortSignal.timeout(20000));
        const events = inspected?.events ?? [];
        const { start, end, reason, ended } = turnRange(events, current);
        let reply = '';
        let prompt = null;
        const handbacks = new Map();
        let handedBack = false;
        for (let i = start; i < end; i++) {
            const event = events[i];
            if (roleOf(event) === 'assistant') reply = textOf(event) || reply;
            prompt = promptOf(event) ?? prompt;
            if (event?.type === 'tool/call' && event.data?.name === 'thread_handback') {
                handbacks.set(event.data.callId, argsOf(event.data.arguments)?.status);
            } else if (event?.type === 'tool/result') {
                const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId;
                const status = handbacks.get(callId);
                if (status && status !== 'progress' && textOf(event).startsWith('Handback ')) handedBack = true;
            }
        }
        // A turn with no prompt of its own (woken by the Host) belongs to the last prompt before it.
        for (let i = start - 1; !prompt && i >= 0; i--) prompt = promptOf(events[i]);
        return {
            key: events[start]?.seq ?? start,
            ended,
            endKind: reason?.kind,
            // Who stopped a stopped turn: 'user' when a person did (DSH's stop button, the session bridge) or the coordinator did.
            stopCause: reason?.kind === 'aborted' && typeof reason.reason?.kind === 'string' ? reason.reason.kind : undefined,
            ending: describeEnding(reason),
            reply,
            handedBack,
            fromProject: prompt ? prompt.fromProject : true,
            // The turn's number, and the log as recordOwnChanges reads it.
            number: events.slice(start, end).find((e) => Number.isSafeInteger(e?.data?.turn))?.data.turn,
            read: { events: ownEvents(inspected), folder: inspected?.meta?.cwd, endSeq: ended ? events[end - 1]?.seq : undefined },
        };
    }

    /** Run one delivery step after the ones before it, so the coordinator gets messages in order. */
    serial(projectId, step) {
        const run = (this.chains.get(projectId) ?? Promise.resolve()).then(step);
        this.chains.set(projectId, run.catch(() => {}));
        return run;
    }

    /**
     * Send text to the coordinator after anything held before it. It is
     * held while the project is paused, and retried when the coordinator
     * cannot take it.
     * @param {string} [from] - the thread session it comes from; none for the plugin's own notes.
     * @param {{kind: string, thread: string, status?: string}} [news] - what the user hears about once the coordinator has it (noteNews).
     * @returns {Promise<'delivered'|'held'>}
     */
    deliver(projectId, text, from = undefined, news = undefined) {
        return this.serial(projectId, async () => {
            const pending = this.store.project(projectId).pendingHandbacks;
            const item = from || news ? { text, ...(from ? { from } : {}), ...(news ? { news } : {}) } : text;
            this.store.putProject(projectId, { pendingHandbacks: [...pending, item] });
            if (this.held(projectId)) return 'held';
            return (await this.sendHeld(projectId)) === 0 ? 'delivered' : 'held';
        });
    }

    /** Deliver held messages now, unless paused or archived. @returns how many were sent. */
    flushPending(projectId) {
        return this.serial(projectId, async () => {
            const before = this.store.project(projectId).pendingHandbacks.length;
            if (before === 0 || this.held(projectId)) return 0;
            const sent = before - await this.sendHeld(projectId);
            this.log(`flush ${projectId} sent=${sent}`);
            return sent;
        });
    }

    /** Send held messages in order until one fails; then retry later. Runs inside `serial`. @returns how many are left. */
    async sendHeld(projectId) {
        const sessionId = this.store.project(projectId).coordinatorSessionId;
        // No coordinator yet: the next start makes one and sends them.
        if (!sessionId) return this.store.project(projectId).pendingHandbacks.length;
        while (this.store.project(projectId).pendingHandbacks.length > 0 && !this.held(projectId)) {
            // A held message is its text (the plugin's own note) or {text, from?, news?} (a thread's handback, or a note the user hears about).
            const next = this.store.project(projectId).pendingHandbacks[0];
            const text = typeof next === 'string' ? next : typeof next?.text === 'string' ? next.text : '';
            try {
                if (text.trim() !== '') await this.prompt(sessionId, text, 'queue', typeof next?.from === 'string' ? next.from : undefined);
            } catch (error) {
                this.log(`error deliver ${projectId} ${String(error?.message ?? error).slice(0, 200)}`);
                this.retryLater(projectId);
                break;
            }
            this.store.putProject(projectId, { pendingHandbacks: this.store.project(projectId).pendingHandbacks.slice(1) });
            if (text.trim() !== '' && next?.news) this.noteNews(projectId, next.news);
        }
        const left = this.store.project(projectId).pendingHandbacks.length;
        if (left === 0) {
            clearTimeout(this.retries.get(projectId)?.timer);
            this.retries.delete(projectId);
        }
        return left;
    }

    /** Try held messages again later, backing off up to timing.maxRetryMs. */
    retryLater(projectId) {
        const retry = this.retries.get(projectId) ?? { attempt: 0 };
        if (retry.timer || this.disposed) return;
        const delay = Math.min(timing.retryMs * 2 ** retry.attempt, timing.maxRetryMs);
        retry.attempt += 1;
        retry.timer = setTimeout(() => {
            retry.timer = undefined;
            // DSH quits on any unhandled rejection in the Host, so a failed flush is only logged.
            void this.flushPending(projectId).catch((error) => {
                this.log(`error flush ${projectId} ${String(error?.message ?? error).slice(0, 200)}`);
            });
        }, delay);
        retry.timer.unref?.();
        this.retries.set(projectId, retry);
    }

    /**
     * Something the user should hear about wherever they are in the window,
     * kept once the coordinating chat has it: its row shows it unread and
     * the window shows a notice, until the user opens the chat (seeNews).
     * @param {{kind: string, thread: string, status?: string}} news - kind from NEWS_KINDS.
     */
    noteNews(projectId, news) {
        if (!NEWS_KINDS.includes(news?.kind) || typeof news.thread !== 'string') return;
        const stored = this.store.project(projectId);
        const old = isObject(stored.news) ? stored.news : {};
        const seq = (Number.isInteger(old.seq) ? old.seq : 0) + 1;
        const item = {
            seq, kind: news.kind, thread: news.thread, title: this.store.thread(projectId, news.thread)?.title ?? news.thread,
            ...(typeof news.status === 'string' ? { status: news.status } : {}), at: new Date().toISOString(),
        };
        const items = [...(Array.isArray(old.items) ? old.items : []), item].slice(-MAX_NEWS);
        this.store.putProject(projectId, { news: { seq, seen: Number.isInteger(old.seen) ? old.seen : 0, items } });
        this.log(`news ${projectId}/${news.thread} ${news.kind}${item.status ? ` ${item.status}` : ''} seq=${seq}`);
        // The notifications plugin's sink (apply sets it), for a system notification while no window
        // is looking. That plugin gates the kinds on its own settings; absent, nothing sends.
        try {
            this.newsSink?.({ ...item, session: this.store.thread(projectId, news.thread)?.sessionId, projectId });
        } catch (error) {
            // The message is already with the coordinator: a failed notification must not fail it.
            this.log(`error news-sink ${projectId}/${news.thread} ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }

    /** The user has seen a coordinating chat's news up to `seq` (all of it when omitted): they opened the chat. */
    seeNews(projectId, seq = undefined) {
        const news = this.store.project(projectId).news;
        if (!isObject(news) || !Number.isInteger(news.seq)) return;
        const upTo = Number.isInteger(seq) ? Math.min(seq, news.seq) : news.seq;
        if (upTo <= (news.seen ?? 0)) return;
        this.store.putProject(projectId, { news: { ...news, seen: upTo } });
    }

    /**
     * Every coordinating chat and its news the user hasn't seen:
     * [{project, name, coordinator, seq, seen, unread: [{seq, kind, thread, title, status?, at}]}].
     */
    listNews() {
        const out = [];
        for (const projectId of this.projects.keys()) {
            const stored = this.store.project(projectId);
            if (typeof stored.coordinatorSessionId !== 'string' || this.archived(projectId)) continue;
            const news = isObject(stored.news) ? stored.news : {};
            const seq = Number.isInteger(news.seq) ? news.seq : 0;
            const seen = Number.isInteger(news.seen) ? news.seen : 0;
            const unread = (Array.isArray(news.items) ? news.items : []).filter((item) => isObject(item) && item.seq > seen);
            out.push({ project: projectId, name: this.project(projectId).name, coordinator: stored.coordinatorSessionId, seq, seen, unread });
        }
        return out;
    }

    // ── what the DSH window draws ──────────────────────────────────────────

    /**
     * What a tool result records for the DSH window: its presentation meta,
     * which the `coordinatorSession` projection folds (projection.js). It
     * names the coordinating chat (as `project`) and the session's role; for
     * a coordinator it carries the roster entries the call touched (all of
     * them with `full`) and whether it stopped coordinating, and `action` is
     * the card the call's turn shows. Never throws: a tool's result must not
     * fail over its picture.
     * @param {string} projectId
     * @param {{role: 'coordinator'|'thread', threadId?: string}} who
     * @param {{action?: object, threads?: string[], full?: boolean}} [details]
     * @returns {object|null}
     */
    view(projectId, who, details = {}) {
        try {
            const project = this.projects.get(projectId);
            if (!project) return null;
            const stored = this.store.project(projectId);
            const out = { [META_MARK]: 1, role: who.role, project: { id: projectId, name: project.name } };
            if (stored.coordinatorSessionId) out.coordinator = stored.coordinatorSessionId;
            if (who.role === 'thread') {
                out.thread = { id: who.threadId, title: stored.threads[who.threadId]?.title ?? who.threadId };
            } else {
                const ids = details.full ? rosterIds(stored.threads) : (details.threads ?? []).filter((id) => stored.threads[id]);
                out.threads = ids.map((id) => rosterEntry(id, stored.threads[id]));
                if (details.full) out.full = true;
                if (stored.off === true) out.off = true;
            }
            if (details.action) out.action = details.action;
            return out;
        } catch (error) {
            this.log(`error view ${projectId} ${String(error?.message ?? error).slice(0, 200)}`);
            return null;
        }
    }

    /**
     * The projection's starting value for a session this store knows, so a
     * coordinating chat or thread whose value DSH dropped (an update) shows
     * its threads, or its chat, the first time DSH folds it again.
     * @param {string} sessionId
     */
    seedView(sessionId) {
        const who = this.store.lookup(sessionId);
        if (!who || !this.projects.has(who.projectId)) return null;
        return this.view(who.projectId, who, who.role === 'coordinator' ? { full: true } : {});
    }

    // ── operations behind the tools ────────────────────────────────────────

    /** The thread for an id as the model typed it (" t3 " is t3), or an error that lists the threads. */
    requireThread(projectId, threadId) {
        const id = String(threadId ?? '').trim();
        const t = this.store.thread(projectId, id);
        if (!t) {
            const known = Object.keys(this.store.project(projectId).threads).join(', ') || 'none';
            throw new ProjectError(`no thread "${id}" here (threads: ${known})`);
        }
        return { id, t };
    }

    /**
     * Refuse a thread start or message that would use a guarded tool
     * (config.guardedTools, or a tool another plugin marks as the user's
     * own) the user's words don't call for: `allowed` (the user's tools
     * their checked words give the thread) must name it. The first real run
     * drifted from a test task the coordinator picked itself into the
     * user's model lanes; this holds whatever the model makes of its
     * prompt, under either yourTools.
     */
    guard(projectId, what, text, allowed) {
        const guard = this.guards();
        if (guard.length === 0) return;
        const ok = new Set(allowed);
        const blocked = guardedIn(text, guard).filter((name) => !ok.has(name));
        if (blocked.length === 0) return;
        this.log(`guard ${projectId} ${what} ${blocked.join(',')}`);
        const them = blocked.length > 1 ? 'them' : 'it';
        const how = what === 'send' ? 'put their words in ask, or start a thread for it with their words in ask' : 'put their words in ask';
        throw new ProjectError(`this would use ${blocked.join(', ')}, and the user's words do not ask for ${them}. Keep the work inside the workspace, or ask the user first. If the user did ask, ${how}. If the text only says not to use ${them}, leave that out: threads already have that rule`);
    }

    /**
     * Refuse a brief or message that gives a thread leave for what rule 6
     * holds back ("delete only clearly safe junk", "so that is authorized":
     * grants.js), unless the user's words in `asks` name that action. In
     * behaviour review 4 a thread deleted build/ because its brief said it
     * could; only the user's words allow that, so the thread lists what it
     * would do and the coordinator asks. The refusal names the words that
     * matched, so the coordinator changes those and not the whole brief
     * (review 5, S10 r1).
     */
    guardGrants(projectId, what, text, asks) {
        const granted = grantsIn(text).filter(({ action }) => !asks.some((ask) => asksToDo(ask, action)));
        if (granted.length === 0) return;
        const actions = granted.map((g) => g.action);
        this.log(`grant ${projectId} ${what} ${actions.join(',')}`);
        const sentences = new Map();
        for (const { sentence, words: [action, grant], excerpt } of granted) {
            const one = sentences.get(sentence) ?? sentences.set(sentence, { excerpt, actions: [], grants: [] }).get(sentence);
            one.actions.push(`"${action}"`);
            if (!one.grants.includes(`"${grant}"`)) one.grants.push(`"${grant}"`);
        }
        const found = [...sentences.values()].map((one) => `"${one.excerpt}" (${one.actions.join(' and ')} with ${one.grants.join(' and ')})`).join('; ');
        const where = what === 'start' ? 'the brief' : 'the text';
        throw new ProjectError(`${where} allows ${doing(actions)}: ${found}. Only the user's words can allow that (rule 6). If they asked for it, put their words in ask. If not, take that out of ${where} (words that only forbid it are fine): have the thread list what it would do and hand back needs_decision, then ask the user`);
    }

    async startThread(projectId, { title, ask, brief, model, effort }) {
        const project = this.project(projectId);
        if (this.archived(projectId)) throw new ProjectError(ARCHIVED);
        if (!this.coordinating(projectId)) throw new ProjectError(STOPPED);
        if (this.paused(projectId)) throw new ProjectError('threads are paused here; new ones are blocked until the user resumes them in Thread settings');
        const cleanTitle = clipTitle(title);
        if (!cleanTitle) throw new ProjectError('title is required');
        if (!String(brief ?? '').trim()) throw new ProjectError('brief is required');
        const userWords = typeof ask === 'string' ? ask.trim().slice(0, 4000) : '';
        if (!userWords) throw new ProjectError('ask is required: copy the user\'s words from their message');
        // A thread works where its chat does, in the same DSH workspace.
        const where = project.workspacePath;
        if (!where) throw new ProjectError('this chat has no folder for threads to work in');
        // The user's tools the thread gets: the ones the ask names that the user really wrote.
        const tools = await this.askedTools(projectId, userWords);
        this.guard(projectId, 'start', `${cleanTitle}\n${userWords}\n${brief}`, tools);
        await this.requireUserWords(projectId, userWords, 'start');
        this.guardGrants(projectId, 'start', `${cleanTitle}\n${brief}`, [userWords]);
        const access = this.access(projectId);
        // Its permission preset; one DSH doesn't offer (any more) is not one to start a thread on.
        const preset = this.presets() ? this.presetOf(access.threadPermission.value) : undefined;
        if (this.presets() && !preset) {
            this.log(`permission ${projectId} unknown preset ${access.threadPermission.value}`);
            throw new ProjectError(`threads here start on the permission "${access.threadPermission.value}", which DSH doesn't offer. Tell the user to choose another in Thread settings`);
        }
        const s = this.settings(projectId);
        // Not given, or "default": the chat's thread default.
        const given = (value) => value !== undefined && value !== 'default';
        const or = (value, fallback) => (given(value) ? value : fallback);
        // An effort the model lacks never stops a start: it runs at the nearest
        // level and the result says so. Only an effort no model offers is refused.
        const check = checkSelection(await this.catalog(), or(model, s.threadModel.value), or(effort, s.threadEffort.value),
            { fit: given(effort) ? 'known' : true });
        if (!check.ok) throw new ProjectError(check.error);
        // Every attempt counts, so a coordinator caught in a loop stops even when starts fail.
        const now = Date.now();
        const starts = (this.store.project(projectId).threadStarts ?? []).filter((ms) => now - ms < HOUR);
        if (starts.length >= this.config.maxThreadsPerHour) {
            this.log(`thread-limit ${projectId} ${starts.length}`);
            throw new ProjectError(`thread limit reached: this chat started ${starts.length} threads in the last hour (maxThreadsPerHour). Tell the user, and continue in existing threads with thread_send`);
        }
        this.store.putProject(projectId, { threadStarts: [...starts, now] });

        const threadId = this.store.reserveThreadId(projectId);
        const sessionId = await this.createSession(where);
        this.store.putThread(projectId, threadId, {
            sessionId, title: cleanTitle, model: check.model, effort: check.effort,
            resolved: false, createdAt: new Date().toISOString(), handbackTimes: [], seenTurn: null, ownCounts: true,
            ...(userWords ? { ask: userWords } : {}),
            tools,
        });
        const agent = await this.attach(sessionId);
        // On the thread permission before it reads its brief; a thread that can't be put there doesn't start.
        if (preset) {
            if (!agent || !this.setPermission(agent, preset, `${projectId}/${threadId}`)) {
                this.store.putThread(projectId, threadId, { resolved: true });
                this.log(`thread-start ${projectId}/${threadId} ${sessionId} not started: permission`);
                throw new ProjectError(`${threadId} could not be put on the permission "${preset}", so it did not start. Tell the user (details in the coordinator log)`);
            }
            this.store.putThread(projectId, threadId, { permission: this.permissionOf(sessionId) ?? preset });
        }
        const notes = check.note ? [check.note] : [];
        if (this.selectionMode === 'session') {
            const applied = await this.selectRoute(agent, { projectId, role: 'thread', threadId });
            if (!applied) {
                if (check.model || check.effort) notes.push('the model could not be set, so the thread runs on the DSH default (details in the coordinator log)');
            } else if (!check.model || (!check.effort && applied.reasoningEffort)) {
                // The thread keeps what it started on, even when the DSH default changes later, so record it.
                this.store.putThread(projectId, threadId, {
                    model: check.model ?? `${applied.provider}:${applied.model}`,
                    effort: check.effort ?? applied.reasoningEffort,
                });
            }
        }
        await this.sc.rename({ sessionId, title: cleanTitle }).catch(() => {});
        await this.prompt(sessionId, briefMessage(project.name, threadId, cleanTitle, brief.trim(), userWords), 'queue', this.store.project(projectId).coordinatorSessionId);
        this.log(`thread-start ${projectId}/${threadId} ${sessionId} brief-chars=${brief.length} ask-chars=${userWords.length}`);
        // What it runs on is named only when the coordinator asked for a model or effort: otherwise it is a setting the coordinator needs no word of.
        const asked = given(model) || given(effort);
        return {
            threadId, sessionId, title: cleanTitle, route: asked ? describeRoute(check.model, check.effort) : undefined, notes: asked ? notes : [],
            // The user's tools it has because the user's words name them, which the coordinator may tell the user.
            tools: access.yourTools.value === 'asked' ? tools : [],
        };
    }

    /**
     * Send a thread a message. `ask` is the user's words when the message
     * passes on their request; the coordinator's own messages (`ask`
     * undefined) and the plugin's (`guard` false) say only what they say.
     * The user's tools the checked ask names join the thread's before it
     * reads the message. A thread in the middle of a turn reads it in that
     * turn, at its next step, unless `steer` is false: then it waits for the
     * turn to end. An idle thread starts its next turn with it.
     * @returns {{text: string, mode: 'steer'|'queue'}} what happened, in the words the coordinator reads.
     */
    async sendToThread(projectId, threadId, text, steer, { ask, guard = false } = {}) {
        const { id, t } = this.requireThread(projectId, threadId);
        if (this.archived(projectId)) throw new ProjectError(ARCHIVED);
        if (!String(text ?? '').trim()) throw new ProjectError('text is required');
        const userWords = typeof ask === 'string' ? ask.trim().slice(0, 4000) : '';
        let tools = [];
        if (guard) {
            // More of the user's tools only when the user's checked words for this message name them.
            tools = await this.askedTools(projectId, userWords);
            this.guard(projectId, 'send', `${userWords}\n${text}`, [...(Array.isArray(t.tools) ? t.tools : []), ...tools]);
            if (userWords !== '') await this.requireUserWords(projectId, userWords, 'send');
            this.guardGrants(projectId, 'send', text, [userWords, t.ask ?? '']);
        }
        if (t.resolved) this.store.putThread(projectId, id, { resolved: false });
        await this.attach(t.sessionId);
        this.addThreadTools(projectId, id, tools, 'from the user\'s words in a message');
        // Whatever the coordinator sends answers the thread's open question, if it had one.
        if (t.question) this.store.putThread(projectId, id, { question: undefined });
        // The user's words make it new work: a turn that then ends without a handback gets its own nudge.
        if (userWords !== '' && (t.nudged || t.stalled)) this.store.putThread(projectId, id, { nudged: undefined, stalled: undefined });
        // A user's answer or change of plan reaches a running turn now, not when the turn ends.
        const running = this.liveStatus(t.sessionId) === 'running';
        const mode = steer && running ? 'steer' : 'queue';
        // The coordinator's own words (thread_send) carry rule 3's bar under them, as a brief does.
        await this.prompt(t.sessionId, coordinatorMessage(text.trim(), userWords, { note: guard }), mode, this.store.project(projectId).coordinatorSessionId);
        this.log(`thread-send ${projectId}/${id} mode=${mode}${running && mode === 'queue' ? ' after-turn' : ''} chars=${text.length}`);
        const reopened = t.resolved ? ' (reopened)' : '';
        if (mode === 'steer') return { mode, text: `Steered into ${id}'s running turn${reopened}.` };
        return { mode, text: running ? `Queued: ${id} sees this when its turn ends${reopened}; steer=true redirects it now.` : `Sent to ${id}${reopened}.` };
    }

    // ── messages to other chats ────────────────────────────────────────────

    /**
     * Whether the coordinator's turn now is one the user started: the
     * newest prompt in it is the user's own message, not a note from a
     * thread, the plugin or another chat. A message to another chat goes
     * only from such a turn, so two coordinating chats can't keep answering
     * each other's replies.
     */
    async userTurn(projectId) {
        const sessionId = this.store.project(projectId).coordinatorSessionId;
        if (!sessionId) return false;
        return (await this.readTurn(sessionId, { current: true })).fromProject === false;
    }

    /** The chats DSH lists (newest first), without subagents' sessions or empty ones. */
    async chatList() {
        const { items } = await this.sc.list({}, AbortSignal.timeout(20000));
        return (Array.isArray(items) ? items : [])
            .filter((item) => typeof item?.sessionId === 'string' && typeof item.cwd === 'string' && !item.parentSessionId && item.blank !== true)
            .map((item) => ({
                sessionId: item.sessionId,
                title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
                cwd: item.cwd,
                updatedAt: item.updatedAt,
            }));
    }

    /**
     * The chat chat_message names: its title as DSH lists it, or its session
     * id. A thread takes messages only from the chat that started it, so
     * naming one is refused with where to send instead; so is a title
     * several chats share, and this chat itself.
     * @returns {Promise<{sessionId: string, name: string, kind: 'chat'}>}
     */
    async messageTarget(projectId, to) {
        const raw = String(to ?? '').trim();
        if (!raw) throw new ProjectError('to is required: a chat\'s title as DSH lists it, or its session id');
        const bare = raw.replace(/^"([^]*)"$/, '$1').trim();
        const key = bare.toLowerCase();
        const own = this.store.project(projectId).coordinatorSessionId;
        const chats = await this.chatList();
        const byId = chats.find((c) => c.sessionId === bare);
        const found = byId ? [byId] : chats.filter((c) => c.title.trim().toLowerCase() === key);
        if (found.length === 0) {
            const recent = chats.filter((c) => c.sessionId !== own && this.store.lookup(c.sessionId)?.role !== 'thread' && c.title).slice(0, 8).map((c) => `"${c.title}"`);
            throw new ProjectError(`no chat here is called "${clipTitle(bare)}".${recent.length ? ` Recent chats: ${recent.join(', ')}.` : ''}`
                + ' Put one of these in to as it is written, or ask the user which chat they mean');
        }
        if (found.length > 1) {
            const list = found.slice(0, 8).map((c) => `${c.sessionId} (in ${c.cwd}${Number.isFinite(c.updatedAt) && c.updatedAt > 0 ? `, last active ${new Date(c.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''})`);
            throw new ProjectError(`${found.length} chats are called "${clipTitle(bare)}": ${list.join('; ')}. Put the id of the one the user means in to, or ask the user`);
        }
        const chat = found[0];
        if (chat.sessionId === own) throw new ProjectError('that is this chat');
        const who = this.store.lookup(chat.sessionId);
        if (who?.role === 'thread' && this.projects.has(who.projectId)) {
            if (who.projectId === projectId) throw new ProjectError(`that is your thread ${who.threadId}: use thread_send`);
            const name = this.project(who.projectId).name;
            throw new ProjectError(`that is a thread of the chat "${name}", and a thread takes messages only from the chat that started it. Send it to "${name}" instead`);
        }
        if (who?.role === 'coordinator' && this.archived(who.projectId)) throw new ProjectError(`"${chat.title || chat.sessionId}" is archived; the user can unarchive it in DSH`);
        return { sessionId: chat.sessionId, name: `"${chat.title || chat.sessionId}"`, kind: 'chat' };
    }

    /** The seq of a session's newest logged event, or -1. */
    async lastSeq(sessionId) {
        const events = (await this.sc.inspect(sessionId, AbortSignal.timeout(20000))).events ?? [];
        const last = events.length - 1;
        return last < 0 ? -1 : Number.isSafeInteger(events[last]?.seq) ? events[last].seq : last;
    }

    /**
     * chat_message: send another chat a message the user asked for. It goes
     * only in a turn the user started, with their words (`ask`) as they
     * wrote them, and a guarded tool in it needs the user's words for it, as
     * a thread's start does. The other chat stays as it is: it gets no
     * thread, card or tools. Its answer to the message comes back to this
     * chat once, as a note (collectReplies).
     * @returns the chat it went to.
     */
    async sendMessage(projectId, { to, ask, text }) {
        const body = String(text ?? '').trim();
        if (!body) throw new ProjectError('text is required');
        const userWords = typeof ask === 'string' ? ask.trim().slice(0, 4000) : '';
        if (!userWords) throw new ProjectError('ask is required: copy the user\'s words from their message');
        const from = this.store.project(projectId).coordinatorSessionId;
        if (!from) throw new ProjectError('this chat doesn\'t coordinate threads');
        if (!await this.userTurn(projectId)) {
            this.log(`guard ${projectId} message-not-asked`);
            throw new ProjectError('a message goes to another chat only in a turn the user started. Tell the user what came in, and send it when they ask');
        }
        if (!wordsKey(await this.userText(projectId)).includes(wordsKey(userWords))) {
            this.log(`guard ${projectId} message-unsaid`);
            throw new ProjectError('ask must be the user\'s own words, copied from their message here');
        }
        const target = await this.messageTarget(projectId, to);
        // The user's tools: another chat has all of them, so the message may name only the ones the user's words do.
        const tools = await this.askedTools(projectId, userWords);
        this.guard(projectId, 'message', `${userWords}\n${body}`, tools);
        const after = await this.lastSeq(target.sessionId);
        await this.prompt(target.sessionId, outsideMessage(this.project(projectId).name, userWords, body), 'queue', from);
        const waiting = this.store.project(projectId).awaiting ?? [];
        if (!waiting.some((w) => w.to === target.sessionId)) {
            const entry = { to: target.sessionId, name: target.name, from, after, at: new Date().toISOString() };
            this.store.putProject(projectId, { awaiting: [...waiting, entry].slice(-MAX_AWAITING) });
        }
        this.awaited.add(target.sessionId);
        this.log(`message ${projectId} to=${target.kind} ${target.sessionId} chars=${body.length} ask-chars=${userWords.length}`);
        return target;
    }

    /**
     * The turn in which a chat answered a coordinating chat's message: the
     * first of its messages from `from` after `after`, and the turn that
     * took it.
     */
    async messageTurn(sessionId, after, from) {
        const events = (await this.sc.inspect(sessionId, AbortSignal.timeout(20000))).events ?? [];
        const seqOf = (event, i) => (Number.isSafeInteger(event?.seq) ? event.seq : i);
        const at = events.findIndex((event, i) => seqOf(event, i) > after && roleOf(event) === 'user'
            && (event.data?.message ?? event.data)?.source?.senderSessionId === from && textOf(event).startsWith(TAGS.message));
        if (at < 0) return { found: false, ended: false };
        const end = events.findIndex((event, i) => i > at && event?.type === 'turn/end');
        if (end < 0) return { found: true, ended: false };
        let reply = '';
        for (let i = at + 1; i < end; i++) if (roleOf(events[i]) === 'assistant') reply = textOf(events[i]) || reply;
        return { found: true, ended: true, reply: reply.trim(), ending: describeEnding(events[end].data?.reason ?? null) };
    }

    /** A session went idle: if it owes a coordinating chat a reply, look for it, one check at a time. */
    onAgentStatus(agent, status) {
        const id = agent?.id;
        if (status !== 'idle' || this.disposed || !this.awaited.has(id)) return;
        const run = (this.replyChecks.get(id) ?? Promise.resolve()).then(() => this.collectReplies(id)).catch((error) => {
            this.log(`error message-reply ${id} ${String(error?.message ?? error).slice(0, 200)}`);
        });
        this.replyChecks.set(id, run);
        void run.finally(() => { if (this.replyChecks.get(id) === run) this.replyChecks.delete(id); });
    }

    /**
     * Deliver each reply a chat owes a coordinating chat, once: the answer
     * of the turn that took the message, once that turn ended. A chat DSH
     * no longer has owes nothing.
     */
    async collectReplies(target) {
        for (const projectId of [...this.projects.keys()]) {
            const mine = (this.store.project(projectId).awaiting ?? []).find((w) => w?.to === target);
            if (!mine) continue;
            let turn;
            try {
                turn = await this.messageTurn(target, mine.after, mine.from);
            } catch (error) {
                if (await this.exists(target).catch(() => true)) throw error;
                turn = undefined;
            }
            if (turn && !turn.ended) continue;
            this.store.putProject(projectId, { awaiting: (this.store.project(projectId).awaiting ?? []).filter((w) => w?.to !== target) });
            if (!turn) {
                this.log(`message-gone ${projectId} ${target}`);
                continue;
            }
            const outcome = await this.deliver(projectId, replyMessage(mine.name, turn.reply, turn.ending), target);
            this.log(`message-reply ${projectId} ${target} ${outcome} chars=${turn.reply.length}${turn.ending ? ' ended=other' : ''}`);
        }
        if (![...this.projects.keys()].some((id) => (this.store.project(id).awaiting ?? []).some((w) => w?.to === target))) this.awaited.delete(target);
    }

    /**
     * At start: the replies still owed. One that came while DSH was off is
     * delivered now; one older than a day is let go.
     */
    async catchUpReplies() {
        const now = Date.now();
        for (const projectId of this.projects.keys()) {
            const waiting = this.store.projects[projectId]?.awaiting;
            if (!Array.isArray(waiting) || waiting.length === 0) continue;
            const fresh = waiting.filter((w) => typeof w?.to === 'string' && now - Date.parse(w.at) < AWAIT_MS);
            if (fresh.length !== waiting.length) {
                this.store.putProject(projectId, { awaiting: fresh });
                this.log(`message-expired ${projectId} n=${waiting.length - fresh.length}`);
            }
            for (const w of fresh) this.awaited.add(w.to);
        }
        for (const target of [...this.awaited]) {
            if (this.disposed) return;
            if (this.ctx.agents.get(target)?.status === 'running') continue;
            await this.collectReplies(target).catch((error) => {
                this.log(`error message-reply ${target} ${String(error?.message ?? error).slice(0, 200)}`);
            });
        }
    }

    /**
     * Run a thread again after its last turn failed or stopped: Retry and
     * Resume in the DSH window. The thread hears it from its coordinator,
     * so its handback, or the idle note, reaches the coordinator as usual.
     * Refused for a resolved or running thread, and for one whose last turn
     * finished.
     * @returns the project as describeProject shows it.
     */
    async continueThread(projectId, threadKey) {
        const { id, t } = this.requireThread(projectId, threadKey);
        if (t.resolved) throw new ProjectError(`${id} is resolved`);
        if (this.ctx.agents.get(t.sessionId)?.status === 'running') throw new ProjectError(`${id} is running already`);
        const turn = await this.readTurn(t.sessionId);
        const state = turn.ended && !turn.handedBack ? endingStateOf(turn.ending) : undefined;
        if (!state) throw new ProjectError(`${id}'s last turn finished, so there is nothing to retry`);
        // As the roster tells it (a person's stop says so), once that turn was reviewed.
        const ending = t.seenTurn === turn.key && t.lastEnding?.text ? t.lastEnding.text : turn.ending;
        // The user asked for it, so a turn that then ends without a handback gets its own nudge.
        if (t.nudged || t.stalled) this.store.putThread(projectId, id, { nudged: undefined, stalled: undefined });
        await this.sendToThread(projectId, id, continueMessage(ending, state === 'failed'), false);
        this.log(`thread-continue ${projectId}/${id} after=${turn.endKind}`);
        return this.describeProject(projectId);
    }

    listThreads(projectId, includeResolved) {
        const all = this.store.project(projectId).threads;
        const threads = includeResolved ? all : Object.fromEntries(Object.entries(all).filter(([, t]) => !t.resolved));
        const hidden = Object.keys(all).length - Object.keys(threads).length;
        return [...rosterLines(threads, (sid) => this.liveStatus(sid)), hidden > 0 ? `(${hidden} resolved hidden)` : '']
            .filter(Boolean).join('\n');
    }

    async readThread(projectId, threadId, count = 6) {
        const { id, t } = this.requireThread(projectId, threadId);
        const r = await this.sc.inspect(t.sessionId, AbortSignal.timeout(20000));
        const msgs = (r.events ?? [])
            .map((e) => (roleOf(e) === 'user' ? { role: 'user', text: promptOf(e)?.text } : { role: roleOf(e), text: textOf(e) }))
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text);
        const n = Math.max(1, Math.min(Number(count) || 6, 30));
        const lines = msgs.slice(-n).map((m) => `## ${m.role}\n${m.text.length > 3000 ? `${m.text.slice(0, 3000)}…` : m.text}`);
        // What it is doing and what it changed, so the coordinator can follow it between handbacks.
        const steps = stepsOf(r.events ?? []);
        const files = changedFiles(t.changes);
        return [
            `${id} · "${t.title}" · ${t.resolved ? 'resolved' : this.liveStatus(t.sessionId)}`,
            files ? `Changed so far: ${files}` : null,
            steps ? `Latest steps: ${steps}` : null,
            ...lines,
        ].filter((line) => line !== null).join('\n\n');
    }

    /**
     * Rename a thread, change its route, resolve or reopen it, or stop its
     * turn: the coordinator's thread_update, or (`by: 'user'`) the
     * user's own from a row's ⋯ in the window. The user's stop is DSH's own
     * stop, so the thread waits for them as after DSH's stop button, and a
     * stop that fails is refused rather than noted.
     * @returns a note of what changed.
     */
    async updateThread(projectId, threadKey, changes, { by = 'coordinator' } = {}) {
        const { id: threadId, t } = this.requireThread(projectId, threadKey);
        const out = [];
        const fields = {};
        if (changes.title !== undefined && String(changes.title).trim()) {
            fields.title = clipTitle(changes.title);
            await this.sc.rename({ sessionId: t.sessionId, title: fields.title }).catch(() => {});
            out.push(`renamed to "${fields.title}"`);
        }
        if (changes.model !== undefined || changes.effort !== undefined) {
            const s = this.settings(projectId);
            const wantModel = changes.model === undefined ? t.model : changes.model === 'default' ? s.threadModel.value : changes.model;
            const wantEffort = changes.effort === undefined ? t.effort : changes.effort === 'default' ? s.threadEffort.value : changes.effort;
            // A new model fits the effort the thread already had; an effort given now must be offered.
            const check = checkSelection(await this.catalog(), wantModel, wantEffort,
                { fit: changes.effort === undefined || changes.effort === 'default' });
            if (!check.ok) throw new ProjectError(check.error);
            fields.model = check.model;
            fields.effort = check.effort;
            out.push(`route ${describeRoute(check.model, check.effort)} from the next request`);
            if (check.note) out.push(check.note);
        }
        if (changes.resolved !== undefined) {
            fields.resolved = changes.resolved === true;
            out.push(fields.resolved ? 'resolved' : 'reopened');
        }
        if (Object.keys(fields).length > 0) this.store.putThread(projectId, threadId, fields);
        if ('model' in fields && this.selectionMode === 'session'
            && !await this.selectRoute(await this.attach(t.sessionId), { projectId, role: 'thread', threadId })) {
            out.push('but the model could not be set, so it keeps its current one (details in the coordinator log)');
        }
        if (changes.stop === true) {
            if (this.ctx.agents.get(t.sessionId)?.status !== 'running') {
                out.push('no turn was running');
            } else {
                const state = this.turns.get(t.sessionId);
                // The coordinator's stop is marked, so its turn's end isn't news to it; the user's reads as theirs.
                if (state?.running && by !== 'user') state.stopped = { key: (await this.readTurn(t.sessionId, { current: true })).key };
                try {
                    await this.sc.cancel({ sessionId: t.sessionId });
                    out.push('current turn stopped (queued messages kept)');
                } catch (error) {
                    if (state) state.stopped = undefined;
                    const why = String(error?.message ?? error).slice(0, 200);
                    if (by === 'user') throw new ProjectError(`the turn could not be stopped (${why})`);
                    out.push(`the turn could not be stopped (${why})`);
                }
            }
        }
        this.log(`thread-update ${projectId}/${threadId} ${Object.keys(fields).join(',')}${changes.stop ? ',stop' : ''}${by === 'user' ? ' by-user' : ''}`);
        return out.length ? `${threadId}: ${out.join('; ')}.` : `${threadId}: nothing to change.`;
    }

    /**
     * Change a coordinating chat's own settings for its threads. A model or
     * effort of "default" clears it, so the plugin default applies again;
     * `paused: null` does the same for pause.
     * @param {object} changes - threadModel, threadEffort, paused.
     * @returns {Promise<{notes: string[], flushed: number}>}
     */
    async changeSettings(projectId, changes) {
        const next = {};
        const current = this.settings(projectId);
        const val = (v) => (v === 'default' ? undefined : v);
        const notes = [];
        if (changes.threadModel !== undefined || changes.threadEffort !== undefined) {
            const catalog = await this.catalog();
            // A cleared setting is checked as what it falls back to.
            const inherited = effectiveSettings(pluginDefaults(this.config), {});
            const model = changes.threadModel === undefined ? current.threadModel.value : changes.threadModel === 'default' ? inherited.threadModel.value : changes.threadModel;
            const effort = changes.threadEffort === undefined ? current.threadEffort.value : changes.threadEffort === 'default' ? inherited.threadEffort.value : changes.threadEffort;
            // An effort set now must be offered; one kept from before or inherited is fitted.
            const effortGiven = changes.threadEffort !== undefined && changes.threadEffort !== 'default';
            const check = checkSelection(catalog, model, effort, { fit: !effortGiven });
            if (!check.ok) throw new ProjectError(check.error);
            if (changes.threadModel !== undefined) next.threadModel = changes.threadModel === 'default' ? undefined : check.model;
            if (changes.threadEffort !== undefined) next.threadEffort = changes.threadEffort === 'default' ? undefined : (check.effort ?? val(effort)?.trim());
            // The chat's own effort follows a new model: fitted, or cleared when the model has no levels.
            else if (changes.threadModel !== undefined && current.threadEffort.source === 'chat setting' && (check.fitted || check.effort === undefined)) next.threadEffort = check.effort;
            if (check.note) notes.push(`Threads: ${check.note}.`);
        }
        const wasPaused = this.paused(projectId);
        if (changes.paused === null) next.paused = undefined;
        else if (typeof changes.paused === 'boolean') next.paused = changes.paused;
        this.store.putSettings(projectId, next);
        let flushed = 0;
        if (wasPaused && !this.paused(projectId)) flushed = await this.flushPending(projectId);
        this.log(`settings ${projectId} ${Object.keys(next).join(',')}`);
        return { notes, flushed };
    }

    /**
     * Change settings through the coordinator's thread_settings tool.
     * @returns {Promise<string>} the settings after the change, as the tool reports them.
     */
    async updateSettings(projectId, changes) {
        const { notes, flushed } = await this.changeSettings(projectId, changes);
        const s = this.settings(projectId);
        return [
            `New threads: ${describeRoute(s.threadModel.value, s.threadEffort.value)} (${s.threadModel.source} / ${s.threadEffort.source})`,
            `Paused: ${this.paused(projectId) ? 'yes' : 'no'}${flushed ? ` (delivered ${flushed} held handbacks)` : ''}`,
            ...this.accessLines(projectId),
            ...notes,
        ].join('\n');
    }

    /** The access settings as thread_settings shows them; only the user changes them, in Thread settings. */
    accessLines(projectId) {
        const a = this.access(projectId);
        const guarded = this.guards().map(([name]) => name);
        const permission = (value) => (value === 'default' ? `DSH's default (${this.permissionCatalog()?.defaultPreset ?? 'unknown'})` : value);
        return [
            // Without their names: the chat mentions the user's tools only when asked.
            guarded.length === 0 ? null
                : `The user's tools: you have them; ${a.yourTools.value === 'always' ? 'every thread has them' : 'a thread has the ones the user\'s words for it name'}`,
            this.presets() ? `Permissions: new threads ${permission(a.threadPermission.value)}` : null,
            'The user changes these in Thread settings; thread_settings can\'t.',
        ].filter((line) => line !== null);
    }

    /**
     * Change a coordinating chat's access settings for its threads, from the
     * window only: the user's tools ("asked" or "always") and the permission
     * new threads start on (a preset DSH offers, or "default"). null clears
     * the chat's own, so the plugin default applies. Walls follow at once;
     * running threads keep their permission.
     * @returns {string[]} notes.
     */
    changeAccess(projectId, changes) {
        const next = {};
        if (changes.yourTools !== undefined) {
            if (changes.yourTools !== null && !TOOL_MODES.includes(changes.yourTools)) throw new ProjectError('your tools must be "asked" or "always"');
            next.yourTools = changes.yourTools ?? undefined;
        }
        const value = changes.threadPermission;
        if (value !== undefined) {
            if (value !== null && (typeof value !== 'string' || !this.presetOf(value))) {
                const offered = this.permissionCatalog()?.options.map((o) => o.value) ?? [];
                throw new ProjectError(offered.length ? `"${String(value).slice(0, 40)}" is not one of DSH's permissions (${['default', ...offered].join(', ')})` : 'this DSH has no permission presets');
            }
            next.threadPermission = value ?? undefined;
        }
        if (Object.keys(next).length === 0) return [];
        this.store.putSettings(projectId, next);
        this.log(`access ${projectId} ${Object.keys(next).join(',')}`);
        if ('yourTools' in next) this.rewall(projectId);
        return [];
    }

    /** Put one thread on another permission preset ("default": DSH's default for new sessions), from the window. */
    async changeThreadPermission(projectId, threadKey, value) {
        const { id, t } = this.requireThread(projectId, threadKey);
        const preset = typeof value === 'string' ? this.presetOf(value) : undefined;
        if (!preset) throw new ProjectError(`"${String(value).slice(0, 40)}" is not one of DSH's permissions`);
        const agent = await this.attach(t.sessionId);
        if (!agent || !this.setPermission(agent, preset, `${projectId}/${id}`)) throw new ProjectError(`${id}'s permission could not be changed (details in the coordinator log)`);
        this.store.putThread(projectId, id, { permission: preset });
        return `${id}: permission ${preset}.`;
    }

    // ── archive: a coordinating chat leaves DSH's session list with its threads ──

    /** A coordinating chat's sessions: its own, then each thread's, resolved ones too. */
    projectSessions(projectId) {
        const stored = this.store.project(projectId);
        const ids = typeof stored.coordinatorSessionId === 'string' && stored.coordinatorSessionId !== '' ? [stored.coordinatorSessionId] : [];
        for (const id of rosterIds(stored.threads)) {
            const sessionId = stored.threads[id]?.sessionId;
            if (typeof sessionId === 'string' && sessionId !== '' && !ids.includes(sessionId)) ids.push(sessionId);
        }
        return ids;
    }

    /** DSH's archive set now; empty when this DSH has none. */
    archivedNow() {
        try {
            const ids = this.ctx.workspaceRegistry?.archivedSessionIds;
            return new Set(Array.isArray(ids) ? ids.map(String) : []);
        } catch {
            return new Set();
        }
    }

    /** Run one archive or restore of a coordinating chat after any still running, across managers. */
    archiveStep(projectId, step) {
        const key = `${this.storeFile}#${projectId}`;
        const run = (archiving.get(key) ?? Promise.resolve()).then(step);
        const tail = run.then(() => {}, () => {});
        archiving.set(key, tail);
        void tail.then(() => { if (archiving.get(key) === tail) archiving.delete(key); });
        return run;
    }

    /**
     * Archive a coordinating chat with its threads: whatever runs in them
     * stops, and DSH archives each one, so they leave the session list
     * together. Nothing is deleted. While archived the chat starts no
     * threads, and what a thread sends it waits; restoreProject brings them
     * all back.
     * @param {object} [options]
     * @param {'window'|'dsh'|'start'} [options.via] - the plugin's own action; DSH's own Archive on the chat's row; or found so at a start.
     * @returns {{archived: number, failed: number}} how many sessions DSH archived now, and how many it refused.
     */
    async archiveProject(projectId, { via = 'window' } = {}) {
        this.project(projectId);
        const registry = this.ctx.workspaceRegistry;
        if (typeof registry?.archiveSession !== 'function') throw new ProjectError('this DSH can\'t archive sessions');
        return this.archiveStep(projectId, async () => {
            // Marked first, so nothing is sent to the coordinator meanwhile, and its own archive (below) is this one.
            const mark = this.archived(projectId) ? this.store.projects[projectId].archived : { at: new Date().toISOString(), via };
            this.store.putProject(projectId, { archived: mark });
            clearTimeout(this.retries.get(projectId)?.timer);
            this.retries.delete(projectId);
            const before = this.archivedNow();
            /** The sessions this archive has seen to: archived in DSH, or gone from it. */
            const done = new Set();
            let archived = 0;
            let failed = 0;
            for (const sessionId of this.projectSessions(projectId)) {
                this.clearApprovals(sessionId);
                if (before.has(sessionId)) {
                    done.add(sessionId);
                    continue;
                }
                try {
                    await registry.archiveSession(sessionId, { stopActivity: true });
                    done.add(sessionId);
                    archived += 1;
                } catch (error) {
                    // A session DSH no longer has (deleted there) has nothing to archive.
                    if (error?.name === 'WorkspaceUnknownSessionError') done.add(sessionId);
                    else failed += 1;
                    this.log(`error archive ${projectId} ${sessionId} ${String(error?.message ?? error).slice(0, 200)}`);
                }
            }
            this.store.putProject(projectId, { archived: { ...mark, sessions: [...done] } });
            this.log(`archive ${projectId} via=${via} sessions=${archived}${failed ? ` failed=${failed}` : ''}`);
            if (failed > 0 && via === 'window') throw new ProjectError(`DSH didn't archive ${failed} of the sessions of "${this.project(projectId).name}"; try again`);
            return { archived, failed };
        });
    }

    /**
     * Bring an archived coordinating chat back with its threads: DSH
     * unarchives each one, and the chat gets what waited for it. Work that
     * archiving stopped stays stopped.
     * @param {object} [options]
     * @param {'window'|'dsh'|'start'} [options.via] - as for archiveProject.
     * @param {boolean} [options.resume] - bring the chat up now (false at a start, which does that next).
     * @returns {{restored: number}} how many sessions DSH unarchived now.
     */
    async restoreProject(projectId, { via = 'window', resume = true } = {}) {
        this.project(projectId);
        const registry = this.ctx.workspaceRegistry;
        if (typeof registry?.unarchiveSession !== 'function') throw new ProjectError('this DSH can\'t archive sessions');
        return this.archiveStep(projectId, async () => {
            const before = this.archivedNow();
            let restored = 0;
            for (const sessionId of this.projectSessions(projectId)) {
                if (!before.has(sessionId)) continue;
                try {
                    await registry.unarchiveSession(sessionId);
                    restored += 1;
                } catch (error) {
                    this.log(`error restore ${projectId} ${sessionId} ${String(error?.message ?? error).slice(0, 200)}`);
                }
            }
            const was = this.archived(projectId);
            if (was) this.store.putProject(projectId, { archived: undefined });
            this.log(`restore ${projectId} via=${via} sessions=${restored}`);
            if (was && resume && !this.disposed) await this.resume(projectId);
            return { restored };
        });
    }

    /**
     * At a start, what changed while the plugin was off: a coordinating chat
     * DSH archived takes its threads with it; an archived one DSH unarchived
     * comes back with its threads, as when either happens while the plugin
     * runs (onWorkspaceState); and an archived one with sessions DSH never
     * archived (it refused, or it was archived by hand in the file) has them
     * archived now. A thread the user unarchived on its own stays as they
     * left it.
     *
     * Only a change counts: a chat DSH already had archived when the plugin
     * last looked, or before it ever looked (the first start of this
     * version, or a DSH home copied from another), or one DSH doesn't know,
     * archives nothing. Only the chat's own mark, or DSH archiving a chat it
     * knows while the plugin was off, does.
     */
    async matchArchive() {
        const archived = this.archivedNow();
        this.archivedSeen = archived;
        if (typeof this.ctx.workspaceRegistry?.archiveSession !== 'function') return;
        for (const projectId of [...this.projects.keys()]) {
            if (this.disposed) return;
            const coordinator = this.store.projects[projectId]?.coordinatorSessionId;
            if (typeof coordinator !== 'string' || coordinator === '') continue;
            const mark = this.archived(projectId) ? this.store.projects[projectId].archived : undefined;
            const done = Array.isArray(mark?.sessions) ? mark.sessions : [];
            try {
                if (!mark) {
                    if (archived.has(coordinator) && this.seenArchived(projectId, coordinator) === false && await this.exists(coordinator)) {
                        await this.archiveProject(projectId, { via: 'start' });
                    }
                } else if (done.includes(coordinator) && !archived.has(coordinator)) {
                    await this.restoreProject(projectId, { via: 'start', resume: false });
                } else if (!Array.isArray(mark.sessions) || this.projectSessions(projectId).some((id) => !archived.has(id) && !done.includes(id))) {
                    // A mark made by hand lists no sessions yet: this archives what DSH hasn't and lists them all, so a
                    // later start knows which ones the archive saw to, even when DSH already had every one archived.
                    await this.archiveProject(projectId, { via: 'start' });
                }
            } catch (error) {
                this.log(`error archive-match ${projectId} ${String(error?.message ?? error).slice(0, 200)}`);
            }
            this.seeArchive(projectId, coordinator);
        }
    }

    /**
     * Whether a coordinating chat was archived in DSH when the plugin last
     * looked: true or false, or undefined when it never looked at this one.
     */
    seenArchived(projectId, coordinator) {
        const seen = this.store.projects[projectId]?.dshArchive;
        return seen?.coordinator === coordinator ? seen.archived === true : undefined;
    }

    /** Keep whether DSH has a coordinating chat archived now, for the next start to compare with. */
    seeArchive(projectId, coordinator, archived = this.archivedNow().has(coordinator)) {
        const seen = this.store.projects[projectId]?.dshArchive;
        if (seen?.coordinator === coordinator && seen.archived === archived) return;
        this.store.putProject(projectId, { dshArchive: { coordinator, archived } });
    }

    /**
     * DSH's archive set changed (its domain/changed event for the workspace
     * registry). A coordinating chat archived there, from its row's Archive
     * or the shortcut, takes its threads with it; unarchived there, from its
     * row or the Undo on DSH's notice, it brings them back. A chat whose own
     * archive or restore is running is left to it.
     */
    onWorkspaceState(change) {
        if (this.disposed || change?.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
        const ids = change.value?.archivedSessionIds;
        if (!Array.isArray(ids)) return;
        const before = this.archivedSeen;
        const now = new Set(ids.map(String));
        this.archivedSeen = now;
        // Not started yet: the start matches the set as it is then.
        if (!before) return;
        for (const projectId of this.projects.keys()) {
            const coordinator = this.store.projects[projectId]?.coordinatorSessionId;
            if (typeof coordinator !== 'string' || coordinator === '' || now.has(coordinator) === before.has(coordinator)) continue;
            this.seeArchive(projectId, coordinator, now.has(coordinator));
            if (archiving.has(`${this.storeFile}#${projectId}`)) continue;
            const step = now.has(coordinator)
                ? (this.archived(projectId) ? undefined : () => this.archiveProject(projectId, { via: 'dsh' }))
                : (this.archived(projectId) ? () => this.restoreProject(projectId, { via: 'dsh' }) : undefined);
            // DSH quits on any unhandled rejection in the Host, so a failure is only logged.
            if (step) void step().catch((error) => this.log(`error archive-follow ${projectId} ${String(error?.message ?? error).slice(0, 200)}`));
        }
    }

    /**
     * What DSH's own Archive on a coordinating chat's row stops besides the
     * chat's own work: its threads that are running now, which go with it.
     * DSH asks before stopping them and names them. Undefined when there are
     * none, or the session coordinates no threads.
     * @returns {{kind: string, items: {id: string, label: string}[]}|undefined}
     */
    archiveActivity(sessionId) {
        try {
            const who = typeof sessionId === 'string' ? this.store.lookup(sessionId) : null;
            if (who?.role !== 'coordinator' || !this.projects.has(who.projectId) || this.archived(who.projectId)) return undefined;
            const stored = this.store.project(who.projectId);
            const archived = this.archivedNow();
            const items = rosterIds(stored.threads)
                .filter((id) => !archived.has(stored.threads[id].sessionId) && this.ctx.agents.get(stored.threads[id].sessionId)?.status === 'running')
                .map((id) => ({ id: stored.threads[id].sessionId, label: stored.threads[id].title || id }));
            return items.length > 0 ? { kind: 'threads', items } : undefined;
        } catch {
            return undefined;
        }
    }

    // ── the Thread settings dialog (remote.js) ─────────────────────────────

    /** The coordinating chat a window call names: its session id, or the id of one of its threads. */
    projectFor(target) {
        const value = typeof target === 'string' ? target.trim() : '';
        if (this.projects.has(value)) return value;
        const who = value ? this.store.lookup(value) : null;
        if (who && this.projects.has(who.projectId)) return who.projectId;
        throw new ProjectError(value ? `"${value.slice(0, 80)}" doesn't coordinate threads, nor is it one of their threads` : 'no chat given');
    }

    /**
     * The model a loaded session runs its next request on, from DSH's own
     * model selection record; undefined when the session is not loaded.
     */
    liveSelection(sessionId) {
        try {
            const session = this.ctx.agents.get(sessionId)?.session;
            const state = session ? this.ctx.get?.('sessionProjections')?.stateOf?.(session, 'modelSelection') : undefined;
            const picked = state?.pending ?? state?.lastUsed;
            if (!picked?.provider || !picked?.model) return undefined;
            return { provider: picked.provider, model: picked.model, ...(picked.reasoningEffort ? { reasoningEffort: String(picked.reasoningEffort) } : {}) };
        } catch {
            return undefined;
        }
    }

    /**
     * A coordinating chat as its Thread settings dialog shows it: the
     * thread model and effort and the access settings, each with its source
     * and what it falls back to without the chat's own, pause (with how many
     * messages it holds and whose handbacks), and every thread with its
     * model, its permission and the user's tools it has.
     */
    describeProject(projectId) {
        const project = this.project(projectId);
        const stored = this.store.project(projectId);
        const settings = this.settings(projectId);
        const inherited = effectiveSettings(pluginDefaults(this.config), {});
        const access = this.access(projectId);
        const inheritedAccess = effectiveAccess(pluginDefaults(this.config), {});
        const own = typeof stored.settings.paused === 'boolean';
        const toolsOf = (who) => {
            const tools = this.toolsFor(who);
            return tools === 'all' ? 'all' : [...tools];
        };
        return {
            project: {
                id: projectId,
                name: project.name,
                workspace: project.workspacePath ?? null,
                // The window's first asks stay out of the rest of the user's home folder.
                homeFolder: isHome(project.workspacePath),
                coordinator: stored.coordinatorSessionId ?? null,
                archived: this.archived(projectId),
                off: stored.off === true,
            },
            settings: Object.fromEntries(SETTING_KEYS.map((key) => [key, { ...settings[key], inherited: inherited[key] }])),
            access: Object.fromEntries(ACCESS_KEYS.map((key) => [key, { ...access[key], inherited: inheritedAccess[key] }])),
            // The user's tools (guardedTools), and the permissions DSH offers, for the dialog's menus.
            guarded: this.guards().map(([name]) => name),
            permissions: this.permissionCatalog(),
            paused: {
                value: this.paused(projectId), source: own ? 'chat setting' : 'plugin default', inherited: false,
                held: stored.pendingHandbacks.length, handbacks: heldHandbacks(stored.pendingHandbacks),
            },
            threads: rosterIds(stored.threads).map((id) => {
                const t = stored.threads[id];
                return {
                    id, title: t.title, session: t.sessionId ?? null, resolved: t.resolved === true,
                    model: t.model ?? null, effort: t.effort ?? null, live: this.liveSelection(t.sessionId) ?? null,
                    handback: t.lastHandback?.status ?? null,
                    changes: this.threadChanges(t),
                    permission: this.permissionOf(t.sessionId) ?? t.permission ?? null,
                    tools: toolsOf({ projectId, role: 'thread', threadId: id }),
                };
            }),
        };
    }

    /**
     * Every coordinating chat as the plugin's page lists it: the thread
     * settings and access settings with their sources, pause, whether it
     * stopped coordinating, and how many threads are open. In DSH's
     * workspace order, then oldest first.
     */
    listProjects() {
        const workspaceAt = new Map(this.workspaceList().map((ws, i) => [ws.id, i]));
        const listed = [...this.projects.keys()].map((projectId) => {
            const project = this.project(projectId);
            const stored = this.store.project(projectId);
            const settings = this.settings(projectId);
            const ids = rosterIds(stored.threads);
            const open = ids.filter((id) => stored.threads[id].resolved !== true).length;
            const home = this.homeOf(projectId);
            const access = this.access(projectId);
            return {
                id: projectId,
                name: project.name,
                workspace: project.workspacePath ?? null,
                home: home?.id ?? null,
                coordinator: stored.coordinatorSessionId ?? null,
                paused: this.paused(projectId),
                archived: this.archived(projectId),
                off: stored.off === true,
                settings: Object.fromEntries(SETTING_KEYS.map((key) => [key, { value: settings[key].value ?? null, source: settings[key].source }])),
                access: Object.fromEntries(ACCESS_KEYS.map((key) => [key, { value: access[key].value, source: access[key].source }])),
                threads: { open, resolved: ids.length - open },
                order: [home && workspaceAt.has(home.id) ? workspaceAt.get(home.id) : workspaceAt.size, String(stored.createdAt ?? '')],
            };
        });
        const by = (a, b) => a.order[0] - b.order[0] || (a.order[1] < b.order[1] ? -1 : a.order[1] > b.order[1] ? 1 : 0);
        return listed.sort(by).map(({ order, ...project }) => project);
    }

    /**
     * A change from the window: from the Thread settings dialog, the chat's
     * settings or one thread's model, effort and permission (null puts a
     * value back to its default); from a thread row's ⋯, the thread renamed,
     * stopped, resolved or reopened as the user's own (updateThread).
     * @param {object} changes - {threadModel?, threadEffort?, paused?, yourTools?, threadPermission?}
     *   or {thread, model?, effort?, permission?, title?, resolved?, stop?}.
     * @returns the chat as describeProject shows it, with `notes` from the change.
     */
    async changeFromWindow(projectId, changes) {
        const text = (value) => (value === null ? 'default' : typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
        // An access value: a word, or null to clear the chat's own.
        const word = (value) => (value === null ? null : typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
        let notes = [];
        if (changes.thread !== undefined) {
            const { id } = this.requireThread(projectId, changes.thread);
            // A row's ⋯: Rename, Stop, Mark resolved or Reopen, the user's own.
            const resolved = typeof changes.resolved === 'boolean' ? changes.resolved : undefined;
            const stop = changes.stop === true;
            const title = typeof changes.title === 'string' ? changes.title : undefined;
            if (title !== undefined && !clipTitle(title)) throw new ProjectError('a thread\'s name can\'t be empty');
            if (resolved !== undefined || stop || title !== undefined) notes.push(await this.updateThread(projectId, id, { resolved, stop, title }, { by: 'user' }));
            const other = resolved !== undefined || stop || title !== undefined;
            if (changes.model !== undefined || changes.effort !== undefined || (changes.permission === undefined && !other)) {
                notes.push(await this.updateThread(projectId, id, { model: text(changes.model), effort: text(changes.effort) }));
            }
            if (changes.permission !== undefined) notes.push(await this.changeThreadPermission(projectId, id, word(changes.permission)));
        } else {
            const access = this.changeAccess(projectId, {
                yourTools: word(changes.yourTools),
                threadPermission: word(changes.threadPermission),
            });
            ({ notes } = await this.changeSettings(projectId, {
                threadModel: text(changes.threadModel),
                threadEffort: text(changes.threadEffort),
                paused: changes.paused === null || typeof changes.paused === 'boolean' ? changes.paused : undefined,
            }));
            notes = [...access, ...notes];
        }
        return { ...this.describeProject(projectId), notes };
    }

    /** A coordinating chat's shared notes: one file per chat, named by its session id. */
    memoryPath(projectId) {
        this.project(projectId);
        return `${dataPath(this.config.memoryDir)}/${projectId}.md`;
    }

    memory(projectId, action, text) {
        const path = this.memoryPath(projectId);
        if (action === 'read') {
            const body = this.readMemory(projectId);
            return body.trim() ? body : '(the shared notes are empty)';
        }
        if (action !== 'append' && action !== 'replace') throw new ProjectError('action must be read, append or replace');
        const add = String(text ?? '').trim();
        // Also for replace: an empty replace would erase the whole memory.
        if (!add) throw new ProjectError('text is required');
        const body = action === 'append' ? `${this.readMemory(projectId).replace(/\s*$/, '')}\n${add}\n`.replace(/^\n/, '') : `${add}\n`;
        if (Buffer.byteLength(body) > this.config.maxMemoryBytes) {
            throw new ProjectError(`the notes would exceed ${this.config.maxMemoryBytes} bytes; summarize them with action "replace"`);
        }
        ensurePrivateDir(dirname(path));
        writeFileSync(path, body, { mode: 0o600 });
        this.log(`memory ${projectId} ${action} bytes=${statSync(path).size}`);
        return `Shared notes ${action === 'append' ? 'appended' : 'replaced'} (${Buffer.byteLength(body)} bytes).`;
    }

    /**
     * A thread's report to the coordinator. The idle review finds it in the
     * thread's log, by the result text this returns.
     */
    async handback(projectId, threadId, status, summary) {
        if (!HANDBACK_STATUSES.includes(status)) throw new ProjectError(`status must be one of ${HANDBACK_STATUSES.join(', ')}`);
        const text = String(summary ?? '').trim();
        if (!text) throw new ProjectError('summary is required');
        const { t } = this.requireThread(projectId, threadId);
        // The card shows CARD_CHARS: a longer summary goes back once to be shortened, and the next one is taken as it is.
        const length = cardSummary(text, Number.MAX_SAFE_INTEGER).length;
        if (length > CARD_CHARS && !t.shorten) {
            this.store.putThread(projectId, threadId, { shorten: true });
            this.log(`handback-long ${projectId}/${threadId} chars=${length}`);
            throw new ProjectError(`summary is ${length} characters, and your card shows ${CARD_CHARS}. Call thread_handback again with at most ${CARD_CHARS}: the result first, then where (paths, links), then what you need, keeping any request sent or file left outside the workspace; leave out how you got there`);
        }
        if (!this.allowHandback(projectId, threadId)) {
            throw new ProjectError(`handback limit reached (${this.config.maxHandbacksPerHour} per hour); finish the work and hand back once`);
        }
        const declined = Array.isArray(t.declined) ? t.declined : [];
        this.store.putThread(projectId, threadId, { lastHandback: { status, summary: cardSummary(text, 500), at: new Date().toISOString() }, nudged: undefined, stalled: undefined, question: undefined, shorten: undefined, declined: undefined });
        // With no other thread at work, the reply to this one also closes what the user asked for.
        const others = Object.entries(this.store.project(projectId).threads).filter(([id, o]) => id !== threadId && !o.resolved);
        const last = status !== 'progress' && !others.some(([, o]) => this.liveStatus(o.sessionId) !== 'idle');
        const news = status === 'progress' ? undefined : { kind: 'handback', thread: threadId, status };
        const outcome = await this.deliver(projectId, handbackMessage(threadId, t.title, status, text, { last, declined }), t.sessionId, news);
        this.log(`handback ${projectId}/${threadId} status=${status} chars=${text.length}${length > CARD_CHARS ? ' long' : ''} ${outcome}`);
        if (outcome === 'delivered') return HANDBACK_SENT;
        return this.held(projectId) ? HANDBACK_HELD : HANDBACK_RETRY;
    }

    /**
     * A thread's question to its coordinator while it works. It counts
     * against the thread's handbacks per hour, and stays on the
     * coordinator's roster until something is sent to the thread.
     */
    async askCoordinator(projectId, threadId, question) {
        const text = String(question ?? '').trim();
        if (!text) throw new ProjectError('question is required');
        const { t } = this.requireThread(projectId, threadId);
        if (!this.allowHandback(projectId, threadId)) {
            throw new ProjectError(`limit reached (${this.config.maxHandbacksPerHour} messages to the coordinator per hour); pick a sensible default, say which, and carry on`);
        }
        this.store.putThread(projectId, threadId, { question: { text: text.slice(0, 500), at: new Date().toISOString() } });
        const outcome = await this.deliver(projectId, questionMessage(threadId, t.title, text), t.sessionId);
        this.log(`question ${projectId}/${threadId} chars=${text.length} ${outcome}`);
        if (outcome === 'delivered') return QUESTION_SENT;
        return this.held(projectId) ? QUESTION_HELD : QUESTION_RETRY;
    }
}
