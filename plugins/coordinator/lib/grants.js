/**
 * Leave that a coordinator's brief or message gives a thread for what
 * rule 6 holds back: a delete, deploy, post, push, publish or probe word
 * next to grant wording ("only", "safe to", "is fine", "you may",
 * "allowed", "authorized", "go ahead", "in scope"), and whether the user's
 * own words name that action. Text that only forbids ("Do not deploy",
 * "never delete anything") grants nothing, and neither does grant wording
 * quoted as text (a label: "safe to delete") or a probe kept to reads. It
 * reads plain words, not grammar: it catches the grants behaviour reviews
 * 4 and 5 found, and the send and delete checks hold what it misses. Pure
 * functions.
 *
 * @module dsh-plugin-coordinator/grants
 */

/** Each action, by the words that name it (verbs and nouns); the first is how a refusal says it. */
const ACTIONS = [
    ['delete', ['delete', 'deletes', 'deleted', 'deleting', 'deletion', 'deletions', 'remove', 'removes', 'removed', 'removing', 'removal', 'rm', 'wipe', 'wipes', 'wiped', 'wiping', 'purge', 'purges', 'purged', 'purging', 'erase', 'erases', 'erased', 'erasing']],
    ['deploy', ['deploy', 'deploys', 'deployed', 'deploying', 'deployment', 'deployments', 'redeploy', 'redeploys', 'redeployed', 'redeploying']],
    ['post', ['post', 'posts', 'posted', 'posting']],
    ['push', ['push', 'pushes', 'pushed', 'pushing', 'force-push', 'force-pushing']],
    ['publish', ['publish', 'publishes', 'published', 'publishing']],
    ['probe', ['probe', 'probes', 'probed', 'probing']],
];
const ACTION_OF = new Map(ACTIONS.flatMap(([action, words]) => words.map((word) => [word, action])));
/** Each action's plain verbs, as the user asks for one: "delete build/", "push the fix". */
const VERBS = { delete: ['delete', 'remove', 'rm', 'wipe', 'purge', 'erase'], deploy: ['deploy', 'redeploy'], post: ['post'], push: ['push', 'force-push'], publish: ['publish'], probe: ['probe'] };
/** How a refusal says what the text lets the thread do. */
const DOING = { delete: 'deleting', deploy: 'deploying', post: 'posting', push: 'pushing', publish: 'publishing', probe: 'probing' };

/** Words that turn what follows in their clause into a "don't". */
const NEGATIONS = new Set(['not', 'no', 'never', 'nothing', 'none', 'nobody', 'without', 'avoid', 'nor', 'neither', 'cannot', 'forbidden', 'prohibited', 'refrain',
    "can't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "won't", "wouldn't", "shouldn't", "mustn't", "couldn't", "mayn't",
    'cant', 'dont', 'doesnt', 'isnt', 'arent', 'wont', 'shouldnt', 'mustnt']);

/** Leave that takes the action right after it: "you may delete", "safe to push", "go ahead and deploy". */
const MODAL = [['you', 'may'], ['you', 'can'], ['feel', 'free', 'to'], ['free', 'to'], ['go', 'ahead', 'and'], ['ok', 'to'], ['okay', 'to'], ['safe', 'to'], ['fine', 'to'],
    ['cleared', 'to'], ['welcome', 'to'], ['permission', 'to']];
/** Leave said of an action anywhere in its sentence: "deleting caches is fine", "so that is authorized". */
const PREDICATE = [['is', 'fine'], ['are', 'fine'], ['is', 'ok'], ['are', 'ok'], ['is', 'okay'], ['are', 'okay'], ['is', 'safe'], ['are', 'safe'], ['is', 'acceptable'], ['are', 'acceptable'],
    ['allowed'], ['authorized'], ['authorised'], ['approved'], ['permitted'], ['sanctioned'], ['go', 'ahead'], ['green', 'light']];
/**
 * Leave said of an action as part of the work: "running the deploy is in scope". Only of the action
 * itself, never of a name with its word in it: "the deploy script is in scope" is work on the script.
 */
const SCOPE = [['in', 'scope'], ['within', 'scope'], ['part', 'of', 'the', 'task'], ['part', 'of', 'the', 'job'], ['part', 'of', 'the', 'work'], ['part', 'of', 'your', 'task']];
/** Words before a quote of what someone said, wrote or asked. */
const SPEECH = new Set(['said', 'says', 'say', 'saying', 'asked', 'asks', 'ask', 'confirmed', 'confirms', 'wrote', 'writes', 'replied', 'replies', 'reply', 'answered', 'answers', 'answer', 'told', 'tells', 'approved', 'agreed', 'typed', 'words', 'request', 'requested', 'instruction', 'instructions']);
/** A probe kept to reads names a read method, or says it reads only, and names no method that sends. */
const READ_METHODS = /\b(?:GET|HEAD|OPTIONS)\b|\bread[- ]only\b|\breads? only\b|\bonly (?:to )?reads?\b/i;
const SEND_METHODS = /\b(?:POST|PUT|PATCH|DELETE)\b/;

/**
 * Words right after an action word that make it part of a name, not the
 * action, per action: "the deploy script", "push notifications", "the
 * delete button". What the action acts on isn't one: "delete files",
 * "publish the docs", "post requests".
 */
const COMMON = ['script', 'scripts', 'config', 'configs', 'configuration', 'settings', 'step', 'steps', 'job', 'jobs', 'pipeline', 'pipelines', 'workflow', 'workflows',
    'command', 'commands', 'tool', 'tools', 'tooling', 'hook', 'hooks', 'button', 'buttons', 'process', 'logic', 'function', 'functions', 'handler', 'handlers', 'route', 'routes',
    'permission', 'permissions', 'access', 'guide', 'status', 'token', 'tokens', 'key', 'keys'];
const NAMES = {
    delete: new Set([...COMMON, 'endpoint', 'endpoints', 'method', 'methods', 'operation', 'operations', 'api', 'action', 'actions', 'confirmation', 'dialog', 'modal']),
    deploy: new Set([...COMMON, 'log', 'logs', 'target', 'targets', 'docs', 'doc', 'notes', 'url', 'urls', 'endpoint', 'endpoints', 'output', 'results', 'files', 'file', 'folder', 'directory', 'dir', 'environment', 'branch']),
    push: new Set([...COMMON, 'notification', 'notifications', 'rights', 'event', 'events', 'url', 'target', 'protection', 'rules', 'log', 'logs', 'output', 'results']),
    publish: new Set([...COMMON, 'date', 'target', 'targets', 'log', 'logs', 'output', 'results']),
    post: new Set([...COMMON, 'office', 'date', 'mortem', 'install', 'build', 'merge', 'processing', 'title', 'content', 'id', 'type']),
    probe: new Set([...COMMON, 'result', 'results', 'output', 'timeout', 'interval', 'log', 'logs']),
};

/** Verbs that work on such a name without doing the action: "editing the deploy script", "read the deploy logs". */
const BENIGN = new Set(['read', 'reads', 'reading', 'edit', 'edits', 'editing', 'fix', 'fixes', 'fixing', 'review', 'reviewing', 'check', 'checking', 'inspect', 'inspecting', 'update',
    'updating', 'change', 'changing', 'debug', 'debugging', 'test', 'testing', 'look', 'looking', 'open', 'opening', 'write', 'writing', 'rewrite', 'rewriting', 'document',
    'documenting', 'explain', 'explaining', 'study', 'studying', 'compare', 'comparing']);
/** Verbs a "don't" covers across a list: "Do not delete, move or publish anything". */
const LISTED = new Set(['move', 'rename', 'change', 'modify', 'edit', 'touch', 'send', 'run', 'write', 'overwrite', 'copy', 'commit', 'merge', 'install', 'upgrade', 'create',
    'upload', 'download', 'share', 'email', 'message', 'call', 'contact', 'buy', 'pay', 'spend', 'sign', 'release', 'tag', 'ship']);
/** Words right after an action that say none of it: "delete nothing", "push no branches". */
const NONE = new Set(['nothing', 'none', 'no', 'neither']);
/** Words in a clause that keep a delete to what the thread made itself, which rule 3 already lets it remove. */
const OWN = [['you', 'created'], ['you', 'made'], ['you', 'wrote'], ['you', 'added'], ['your', 'own'], ['your', 'scratch'], ['scratch']];

/** Words before a plain verb that still leave it the user's ask: "please delete", "can you push", "I want you to deploy". */
const LEADS = new Set(['please', 'pls', 'plz', 'kindly', 'just', 'only', 'also', 'then', 'and', 'now', 'go', 'so', 'ok', 'okay', 'yes', 'yeah', 'yep', 'sure', 'first', 'finally',
    'to', 'can', 'could', 'would', 'will', 'should', 'must', 'may', 'you', 'we', 'i', "let's", 'lets', 'ahead', 'right', 'safely']);
/** Verbs that ask for an action named as a noun: "run the real deploy", "I approve the deploy". */
const STARTS = new Set(['run', 'do', 'start', 'trigger', 'kick', 'perform', 'execute', 'proceed', 'approve', 'make']);

/**
 * A text's sentences, each with its words: `word` in lower case without
 * the marks around it; `stop` when a comma, colon, dash or "…" ends its clause;
 * `named` when it is a file, path or other name ("deploy.sh", "build/");
 * `raw` as written without the marks around it, `token` with them;
 * `quoted`, the number of the double-quoted span it is in (0 for none, or
 * for words someone is said to have said: `The user said: "Only delete build/"`).
 */
function sentencesOf(text) {
    const out = [];
    let span = 0;
    for (const sentence of String(text ?? '').replace(/[’‘]/g, "'").split(/[.!?;]+(?=\s|$)|\n+/)) {
        const words = [];
        let open = false;
        let speech = false;
        for (const raw of sentence.split(/\s+/)) {
            if (/^([-–—]+|…|\.{2,})$/.test(raw)) {
                if (words.length > 0) Object.assign(words[words.length - 1], { stop: true, token: `${words[words.length - 1].token} ${raw}` });
                continue;
            }
            // A double quote opens a span at the start of a word and closes it at the end of one: "safe to delete".
            // Words quoted as someone's ("the user confirmed: "…"") are still read as leave.
            let quoted = 0;
            const lead = /^[(\[{<*_]*["“]/.exec(raw);
            if (open) {
                quoted = speech ? 0 : span;
                if (/["”][)\]}>*_,:.!?;]*$/.test(raw)) open = false;
            } else if (lead) {
                span += 1;
                speech = SPEECH.has(words[words.length - 1]?.word);
                quoted = speech ? 0 : span;
                open = !/["”][)\]}>*_,:.!?;]*$/.test(raw.slice(lead[0].length));
            }
            const core = raw.replace(/^["'`(\[{<*_“]+|["'`)\]}>*_,:”]+$/g, '');
            const word = core.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
            if (word === '') continue;
            words.push({ word, stop: /[,:]["'`)\]}>*_”]*$/.test(raw), named: /[/\\.=@~]/.test(core), raw: core, token: raw, quoted });
        }
        if (words.length > 0) out.push({ text: sentence.trim(), words });
    }
    return out;
}

/**
 * Whether a "don't" comes earlier in the word's clause, or a "nothing" or
 * "is not" right after it. A comma after a verb in a list doesn't end the
 * clause: "Do not delete, push or deploy anything".
 */
function negated(words, at) {
    if (NONE.has(words[at + 1]?.word)) return true;
    // "POST is not", "deploying isn't allowed"
    for (let i = at + 1; i <= at + 3 && i < words.length && !words[i - 1].stop; i++) {
        if (NEGATIONS.has(words[i].word) && (/^(is|are|was|be)$/.test(words[i - 1].word) || /^(isn't|aren't|isnt|arent)$/.test(words[i].word))) return true;
    }
    for (let i = at - 1; i >= 0; i--) {
        if (words[i].stop && !ACTION_OF.has(words[i].word) && !LISTED.has(words[i].word)) return false;
        if (NEGATIONS.has(words[i].word)) return true;
    }
    return false;
}

/** The words of the clause around a word: from after the stop before it to the stop that ends it. */
function clauseOf(words, at) {
    let from = at;
    while (from > 0 && !words[from - 1].stop) from--;
    let to = at;
    while (to < words.length - 1 && !words[to].stop) to++;
    return { from, to };
}

/**
 * Whether an action word is part of a name there, not the action: one of
 * its NAMES right after it ("the deploy script"), unless a verb before it
 * runs the thing ("run the deploy script"). With `benign`, only when a verb
 * before it works on the name without doing the action ("editing the
 * deploy script").
 */
function named(words, at, { benign = false } = {}) {
    if (!NAMES[ACTION_OF.get(words[at].word)]?.has(words[at + 1]?.word)) return false;
    const before = words.slice(Math.max(0, at - 3), at);
    if (before.some((w) => BENIGN.has(w.word))) return true;
    return !benign && !before.some((w) => STARTS.has(w.word) || /^(running|executing|triggering|invoking|calling)$/.test(w.word));
}

/**
 * Where each of a list's phrases starts in the words, unless a "don't" comes within two words before it, or
 * it is quoted: grant wording in quotes is text the thread is given ("label each "safe to delete""), not leave.
 */
function phrasesIn(words, phrases) {
    const out = [];
    for (let i = 0; i < words.length; i++) {
        for (const phrase of phrases) {
            if (!phrase.every((part, k) => words[i + k]?.word === part)) continue;
            if (words.slice(i, i + phrase.length).some((w) => w.quoted > 0)) continue;
            if (words.slice(Math.max(0, i - 2), i).some((w) => NEGATIONS.has(w.word))) continue;
            out.push({ at: i, end: i + phrase.length - 1 });
        }
    }
    return out;
}

/**
 * Whether a predicate ("is fine", "authorized") is said of the clause
 * `from`..`to`: it is in that clause, it ends the clause just before it
 * ("Allowed: deleting caches"), or it comes later with a word that points
 * back ("..., so that is authorized", "which is fine").
 */
function says(words, p, from, to) {
    if (p.at >= from && p.end <= to) return true;
    if (p.end === from - 1) return true;
    if (p.at <= to) return false;
    const { from: start } = clauseOf(words, p.at);
    return words.slice(start, p.at).some((w) => /^(that|this|it|which|these|those|both|that's|it's|this's)$/.test(w.word));
}

/**
 * The words around the ones that matched, as written, with double quotes made single so the excerpt can be
 * quoted: "… running the staging deploy to confirm success is in scope".
 */
function excerpt(words, at) {
    const from = Math.max(0, Math.min(...at) - 4);
    const to = Math.min(words.length - 1, Math.max(...at) + 4);
    const said = words.slice(from, to + 1).map((w) => w.token).join(' ').replace(/[,:;\s–—-]+$/, '').replace(/["“”]/g, "'");
    return `${from > 0 ? '… ' : ''}${said}${to < words.length - 1 ? ' …' : ''}`;
}

/**
 * The leave a text gives for what rule 6 holds back: each sentence where
 * an action word that no "don't" covers meets grant wording. "only" takes
 * the action next to it or before it in its clause, a modal ("you may",
 * "safe to") the action just after it, and "is fine", "allowed",
 * "authorized" and the like the action they are said of (`says`), even
 * as part of a name ("get the deploy script working, so that is
 * authorized") unless a verb like "edit" or "read" works on it; "in
 * scope" and "part of the task" the action itself, never a name. Grant
 * wording in quotes is text, not leave, and a probe kept to reads ("only
 * with GET or HEAD") is a read. Deleting what the thread made itself
 * isn't held back.
 * @returns {{action: string, sentence: string, words: string[], excerpt: string}[]} each action once, with the
 *   first sentence that grants it, the words that matched (the action's, then the grant's) and the text around them.
 */
export function grantsIn(text) {
    const found = new Map();
    for (const { text: sentence, words } of sentencesOf(text)) {
        const modals = phrasesIn(words, MODAL);
        const predicates = phrasesIn(words, PREDICATE);
        const scopes = phrasesIn(words, SCOPE);
        const readsOnly = READ_METHODS.test(sentence) && !SEND_METHODS.test(sentence);
        for (let i = 0; i < words.length; i++) {
            const action = words[i].named ? undefined : ACTION_OF.get(words[i].word);
            if (!action || found.has(action) || negated(words, i) || named(words, i, { benign: true })) continue;
            if (action === 'probe' && readsOnly) continue;
            const { from, to } = clauseOf(words, i);
            const clause = words.slice(from, to + 1);
            if (action === 'delete' && phrasesIn(clause, OWN).length > 0) continue;
            // "only" just before it, or after it in its clause: "delete only clearly safe junk", "probe it with unauthenticated requests only".
            const only = clause.findIndex((w, k) => w.word === 'only' && w.quoted === 0 && (from + k === i - 1 || from + k === i - 2 || (from + k > i && from + k - i <= 8)));
            const modal = modals.find((m) => m.end < i && i - m.end <= 3 && m.at >= from);
            const leave = !named(words, i) ? (only >= 0 ? { at: from + only, end: from + only } : modal) ?? scopes.find((p) => says(words, p, from, to)) : undefined;
            const grant = leave ?? predicates.find((p) => says(words, p, from, to));
            if (!grant) continue;
            const at = [i, grant.at, grant.end];
            found.set(action, { sentence, words: [words[i].raw, words.slice(grant.at, grant.end + 1).map((w) => w.raw).join(' ')], excerpt: excerpt(words, at) });
        }
    }
    return [...found].map(([action, g]) => ({ action, ...g }));
}

/**
 * Whether the user's words ask for an action themselves: one of its plain
 * verbs at the start of a clause or after "please", "can you", "to" and
 * the like ("Only delete build/.", "deploy 1.4.2 to staging"), or its noun
 * after a verb that asks for it ("run the real deploy"). Its word as part
 * of a name ("Get the staging deploy script working") or under a "don't"
 * doesn't count.
 */
export function asksFor(ask, action) {
    const verbs = VERBS[action] ?? [];
    for (const { words } of sentencesOf(ask)) {
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (w.named || ACTION_OF.get(w.word) !== action || negated(words, i)) continue;
            const before = i === 0 || words[i - 1].stop ? undefined : words[i - 1].word;
            if (verbs.includes(w.word) && (before === undefined || LEADS.has(before))) return true;
            if (!named(words, i) && words.slice(Math.max(0, i - 3), i).some((b, k, list) => STARTS.has(b.word) && !list.slice(k).some((x) => x.stop))) return true;
        }
    }
    return false;
}

/** "deleting", "deleting and pushing": what a refusal says the text lets the thread do. */
export function doing(actions) {
    const said = actions.map((a) => DOING[a] ?? a);
    return said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said.at(-1)}` : said[0] ?? '';
}
