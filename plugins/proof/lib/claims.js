/**
 * Claims in a reply: the statements that say work is done, passed, fixed or
 * deployed. Pure and quick: it runs once on each finished turn's last reply.
 *
 * A claim is a plain statement of success. Questions, plans, conditions
 * ("once the tests pass"), negations ("the build still fails"), code blocks,
 * quotes and reports of what a document says are not claims, so they never
 * get flagged. "No failures", "zero errors" and "nothing left to fix" are
 * not negations: they back a claim up.
 *
 * A sentence is read clause by clause ("Pushed to main — CI should pick it
 * up" claims the push, not the CI run), and gives at most one claim of each
 * kind. Each claim keeps the sentence (`text`) and the clause that makes it
 * (`part`).
 *
 * Kinds, from the strongest evidence they need to the weakest:
 *
 *   passed    tests, a build, lint or checks pass ("all 42 tests pass", "the build is green")
 *   deployed  shipped somewhere ("deployed to staging", "pushed to main", "published 1.2.0",
 *             "the health endpoint returns 200")
 *   fixed     a fault is gone, or a number got better ("fixed the crash", "no longer panics",
 *             "p50 310 ms -> 120 ms")
 *   done      work carried out ("done", "I added the endpoint", "renamed the files")
 *
 * A claim can also carry what it names, which the turn must show: commands
 * in inline code (`commands`, "`go test -race ./...` is clean") and figures
 * (`metrics`, "coverage is at 92%").
 *
 * @module dsh-plugin-proof/claims
 */

export const KINDS = ['passed', 'deployed', 'fixed', 'done'];

/** What a `passed` claim is about: which runs can back it. */
export const SUBJECTS = ['tests', 'build', 'lint', 'ci', 'hash', 'search', 'run', 'any'];

/** Where a `deployed` claim says the work went: which runs can back it. */
export const TARGETS = ['repo', 'registry', 'env', 'health', 'any'];

const MAX_SENTENCE = 400;
const MAX_PART = 200;
/** Inline code is kept between these marks while a sentence is read. */
const OPEN = '⟨';
const CLOSE = '⟩';

/** Markdown's marks around words, so "**All tests pass**" reads as the words; inline code is marked. */
function plain(line) {
    return line
        .replace(/!\[[^\][\n]*\]\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)/g, '')
        .replace(/\[([^\][\n]+)\]\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)/g, '$1')
        .replace(/`([^`]*)`/g, `${OPEN}$1${CLOSE}`)
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/~~(.*?)~~/g, '')
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
        .replace(/[✅✔☑️🎉🚀]+/gu, '')
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/** A marked sentence as a person reads it. */
const shown = (s) => s.replaceAll(OPEN, '').replaceAll(CLOSE, '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A table's separator row: `|---|:---:|`. */
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** A table row's cells. */
const cellsOf = (raw) => raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** Header cells of a before-and-after table ("| | before | after |"). */
const BEFORE_COL = /^(?:before|baseline|old|previous|was|original|unpatched)$/i;
const AFTER_COL = /^(?:after|patched|new|now|optimi[sz]ed)$/i;
/** A cell that is one figure: "312 ms", "1.4 s", "~101". */
const CELL_FIGURE = /^~?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([a-zµ%/]*)$/i;
/** Units of time and size, in ms and bytes, so "1.4 s" and "290 ms" compare. */
const TIME_UNITS = { ns: 0.000001, 'µs': 0.001, us: 0.001, ms: 1, s: 1000, sec: 1000, secs: 1000, seconds: 1000, min: 60000, mins: 60000, minutes: 60000 };
const SIZE_UNITS = { b: 1, bytes: 1, kb: 1000, kib: 1024, mb: 1e6, mib: 1048576, gb: 1e9, gib: 1073741824 };

/** A figure in a cell, in its unit's base (1.4 s as 1400 ms), or undefined. */
function cellFigure(cell) {
    const m = CELL_FIGURE.exec(plain(cell));
    if (!m) return undefined;
    const unit = m[2].toLowerCase();
    const value = Number(m[1].replace(/,/g, ''));
    if (unit in TIME_UNITS) return { value: value * TIME_UNITS[unit], unit: 'time' };
    if (unit in SIZE_UNITS) return { value: value * SIZE_UNITS[unit], unit: 'size' };
    return { value, unit };
}

/**
 * A table row read as a sentence: a key and its value ("| Rollout | complete, 3/3 replicas |"),
 * or a row of a before-and-after table whose figure went down ("| p50 | 310 ms | 120 ms |"
 * reads "p50 310 ms → 120 ms."); undefined for any other row.
 */
function rowSentence(raw, header) {
    const cells = cellsOf(raw);
    const heads = (header ?? []).map((c) => plain(c));
    const before = heads.findIndex((h) => BEFORE_COL.test(h));
    const after = heads.findIndex((h) => AFTER_COL.test(h));
    if (before > 0 && after > 0 && cells.length === heads.length && cells[0] !== '') {
        const from = cellFigure(cells[before]);
        const to = cellFigure(cells[after]);
        if (!from || !to || from.unit !== to.unit || !(to.value < from.value)) return undefined;
        return `${cells[0]} ${cells[before]} → ${cells[after]}.`;
    }
    if (cells.length !== 2 || cells[0] === '' || cells[1] === '') return undefined;
    const said = `${cells[0]} ${cells[1]}`;
    return /[.!?]$/.test(said) ? said : `${said}.`;
}

/** A list item's line: "- Push the branch", "2. Run it on staging". */
const LIST_ITEM = /^\s{0,6}(?:[-*+]|\d+[.)])\s+/;
/** A heading that names a plan: "## Next steps". */
const PLAN_HEADING = /^\s{0,3}#{1,6}\s+(?:next\s+steps?|plan|proposed\s+(?:fix|changes?|plan)|todo|to-?do|follow-?ups?|open\s+questions?|left\s+to\s+do|remaining\s+work|options?)\b/i;
/** A line that leads a plan's items: "Plan:", "Here's how I'd do it:", "To release:", "Next steps:". */
function leadsPlan(line) {
    if (!/:\s*$/.test(line)) return false;
    return PLAN_LEAD.test(`${line} `) || NOT_YET.test(line) || /\b(?:here'?s how|how (?:i|we|you)|steps?|plan|to-?dos?|options?|proposal|approach|i'?d|we'?d|ideas?|suggestions?|recommend\w*|choices|alternatives|ways?\s+(?:out|forward|around\s+it|to\s+(?:fix|do|handle|solve|go|get|make|keep|stop|avoid|prevent|speed))(?=[^:]*:\s*$)|means)\b/i.test(line) || /^to\s+[a-z]+(?:\s+[\w.-]+){0,4}\s*:\s*$/i.test(line);
}

/** The reply's sentences outside code blocks, quotes and wide tables, in order, inline code marked. */
function marked(text) {
    return markedWithPlans(text).sentences;
}

/** The reply's sentences, and which of them are items of a plan (each one under a line that leads a plan). */
function markedWithPlans(text) {
    if (typeof text !== 'string' || text.trim() === '') return { sentences: [], plan: new Set() };
    const out = [];
    const plan = new Set();
    let fenced = false;
    let header;
    let planned = false;
    // One character over and over says nothing past 64 ("====…", "[[[[…"), and keeps each reading quick.
    const lines = text.replace(/([^\n])\1{63,}/g, (m, c) => c.repeat(64)).split(/\r?\n/);
    for (let at = 0; at < lines.length; at += 1) {
        let raw = lines[at];
        if (/^\s{0,3}(```|~~~)/.test(raw)) {
            fenced = !fenced;
            continue;
        }
        if (fenced || /^\s{0,3}>/.test(raw) || /^ {4,}\S/.test(raw)) continue;
        // Items under a plan's lead are the plan, until a line that is not an item.
        if (raw.trim() === '') {
            header = undefined;
            continue;
        }
        const item = LIST_ITEM.test(raw);
        if (!item) planned = PLAN_HEADING.test(raw) || leadsPlan(plain(raw));
        if (/^\s*\|/.test(raw)) {
            // A key and its value ("| Helm status | deployed |") says what it says, and so does a before-and-after
            // row whose figure went down; a header row or another wide row is data.
            if (TABLE_RULE.test(raw)) continue;
            if (TABLE_RULE.test(lines[at + 1] ?? '')) {
                header = cellsOf(raw);
                continue;
            }
            const row = rowSentence(raw, header);
            if (row === undefined) continue;
            raw = row;
        } else {
            header = undefined;
        }
        const line = plain(raw);
        if (line === '') continue;
        // Split after a sentence's end, keeping "v1.2.0", "e.g." and "3.5 s" whole.
        for (const part of line.split(/(?<=[.!?])\s+(?=["“(⟨]?[A-Z0-9⟨])/)) {
            const s = part.trim();
            if (s.length <= 1) continue;
            if (item && planned) plan.add(out.length);
            out.push(s.length > MAX_SENTENCE ? `${s.slice(0, MAX_SENTENCE - 1)}…` : s);
        }
    }
    return { sentences: out, plan };
}

/** The reply's sentences outside code blocks, quotes and tables, in order. */
export function sentencesOf(text) {
    return marked(text).map(shown);
}

/** A sentence's clauses: split at dashes, semicolons, colons and ", so"/", and"/", but"/", ready to". */
/** Code, quotes and brackets: what they hold is one piece ("`signal: AbortSignal.timeout(ms)`", `("install.sh: quote paths")`). */
const HELD = new RegExp(String.raw`${OPEN}[^${CLOSE}\n]{1,200}${CLOSE}|"[^"\n]{1,200}"|“[^”\n]{1,200}”|\([^()\n]{1,200}\)`, 'g');
const HOLD = { ':': '\u0001', ';': '\u0002', ',': '\u0003', '—': '\u0004', '–': '\u0005', ' - ': ' \u0006 ' };
const hold = (s) => s.replace(HELD, (m) => m.replace(/ - |[:;,—–]/g, (c) => HOLD[c]));
// Each held mark back as it was: " - " was held as " \u0006 ", so "\u0006" alone gives back "-" ("`x - 1`", not "x undefined 1").
const UNHOLD = Object.fromEntries(Object.entries(HOLD).map(([k, v]) => [v.trim(), k.trim()]));
const unhold = (s) => s.replace(/[\u0001-\u0006]/g, (c) => UNHOLD[c] ?? c);

function clausesOf(sentence) {
    return hold(sentence)
        // "`mix test test/x_test.exs`: 3 tests, 0 failures": a command and its result are one clause.
        .split(/\s+[—–]\s+|\s+-\s+|;\s+|(?<!^\s*(?:still|all|everything(?:\s+(?:is|still))?|now)\s+(?:green|passing|clean))(?<!^\s*(?:green|passing))(?<!^\s*(?:[-*]\s+)?(?:(?:the\s+)?(?:full|whole|filtered|focused|targeted|local|new)\s+)?⟨[^⟩]{1,200}⟩)\s*:\s+(?=\S)(?!(?:all\s+)?(?:\d+\s*(?:\/\s*\d+\s+)?(?:tests?\s+)?)?(?:ok|okay|pass|passed|passes|passing|green|clean|success|successful|succeeded)\b)|,\s+(?=(?:so|and|but|while|which|because|since|although|though|yet|then|plus|with|ready\s+(?:to|for))\b)|\s+(?=(?:but|because|although|though)\s)/i)
        .map((s) => unhold(s).trim())
        .filter((s) => s.length > 1);
}

// ── What makes a clause not a claim ────────────────────────────────

/** A "when …" part, up to a comma or the clause's end: when something happens, not what this turn did ("423 when the order is shipped"). */
const WHEN_PART = /\bwhen\b[^,;]*(?:,\s*|$)/gi;
/** A plan, a condition or a hope: success not yet had. */
const NOT_YET = /\b(if|whether|once|until|unless|whenever|should|shall|will|would|could|might|may|must|can(?!\s+(?:now|again|confirm|verify|see|report)\b)|need(s)? to|needed to|has to|have to|going to|gonna|want(s)? to|try(ing)? to|plan(ned|s)? to|hope(fully)?|expect(ed)? to|supposed to|let me|let['’]s|i['’]ll|we['’]ll|you'?ll|it['’]ll|that['’]ll|they'?ll|i['’]d|we['’]d|next,? i|to be (done|fixed|deployed|tested)|can then|in order to|so that|ready to|safe to|good to|able to|in case|(?:you|we|they) can|suggests?|suggesting|seems?|seemingly|appears?|apparently|probably|likely|presumably|perhaps|maybe|i think|i suspect|i believe|i guess|looks like)\b/i;
/** A sentence that says the opposite of success, or reports a failure. */
const NEGATED = /\b(not|n't|never|neither|nor|nothing|yet|without (?:running|testing|checking|verifying)|yet to|still (?:fail|failing|broken|red|erroring|crash)|fail(s|ed|ing|ure|ures)?|broken|break(s|ing)?|red\b|error(s|ed)?\b|regress(ed|ion)?|flak(y|iness)|skipped|cannot|unable|couldn'?t|didn'?t|doesn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|haven'?t|hasn'?t|won'?t|\w+n't|instead of|rejected|denied|timed out|stalled|crashloop\w*|pending|in progress|queued)\b/i;
/** "No failures", "zero errors", "nothing left to fix": words that back a claim up, not negations. */
const POSITIVE = [
    /\b(with\s+)?(no|zero|0)\s+(new\s+|remaining\s+|more\s+|type\s+|lint\s+|test\s+|compile\s+|build\s+)?(errors?|failures?|failing (tests?|specs?)|warnings?|problems?|issues?|findings?|diagnostics?|regressions?|flakes?|offen[cs]es?)\b(\s+(left|remaining|anywhere|reported|found|to worry about)\b)?/gi,
    /\bnothing (left |else )?(to (fix|worry about|do|report|change)|(is|was) (left|blocking|failing|broken|missing|pending))\b/gi,
    /\bnothing\s+(is\s+|was\s+|left\s+)?(fail(s|ed|ing)?|broken|broke|red|regress(ed|es|ing)?|skipped)\b/gi,
    /\bnone\s+(of them\s+)?(fail(s|ed|ing)?|skipped|broke)\b/gi,
    /\b(zero|no)\s+(skipped|skips|failing|failed)\b/gi,
    /\bnothing (else )?(is )?(needed|blocking)\b/gi,
    /\bwithout (any )?(errors?|warnings?|failures?|issues?|problems?)\b/gi,
    /\b0 (fail|failed|failures?|errors?|failing)\b/gi,
    /\b\d+ (skipped|skips|xfailed|xpassed|deselected|pending|todo|ignored)\b/gi,
    /\bfail(ed|ures|ing|s)?\s*[:=]?\s*0\b/gi,
    /\berrors?\s*[:=]\s*0\b/gi,
    /\b(not a single|not one) (failure|error|warning)\b/gi,
    // "Fixed the failing test", "resolved the two build errors": the fault is what the fix acted on.
    /\b(?:fix(?:ed|es)?|repair(?:ed|s)?|resolv(?:ed|es)|address(?:ed|es)|patch(?:ed|es)?|correct(?:ed|s)?|solv(?:ed|es)|squash(?:ed|es)?|clear(?:ed|s)?|eliminat(?:ed|es)|silenc(?:ed|es)|unblock(?:ed|s)?)\s+(?:(?:the|a|an|that|this|those|these|its|their|our|your|both|all|each|every|remaining|last|one|two|three|four|five|\d+)\s+)*(?:[\w.\/⟨⟩-]+\s+){0,2}?(?:failing|failed|broken|erroring|flaky|crashing|red|regressed|errors?|failures?|crash(?:es)?|regressions?|breakages?|exceptions?|panics?|timeouts?)\b/gi,
    // "The failing test now passes", "the broken import is fixed": the fault word says which thing; the clause says it works.
    /\b(?:the|a|an|that|this|those|these|its|their|our|both|all|each|every|previously|formerly)\s+(?:previously\s+|formerly\s+|\d+\s+|two\s+|three\s+)?(?:failing|failed|broken|erroring|flaky|crashing|red|regressed)\b(?=(?:\s+[\w.\/⟨⟩-]+){0,5}?\s+(?:now\s+|all\s+|also\s+)?(?:pass(?:es|ed)?|passing|green|works?|working|succeeds?|compiles?|builds?|(?:is|are|was|were|has been|have been)\s+(?:now\s+)?(?:fixed|resolved|green|passing|working|gone))\b)/gi,
];
/** A changelog section by name, as Keep a Changelog spells it: "under **Unreleased → Fixed**", "in the Fixed section". */
const CHANGELOG_SECTION = /\b(?:[Uu]nder|[Ii]n|[Tt]o)\s+(?:the\s+)?(?:[\w.-]+\s*(?:→|->|>|\/|›)\s*)?(?:Added|Changed|Deprecated|Removed|Fixed|Security)\b(?:\s+(?:section|heading))?/g;
/** "Fixed" as an adjective or as "set": "a fixed window", "fixed-size buffers", "a fixed seed", "the port is fixed at 8080". */
const FIXED_ADJ = /\b(?:a|an)\s+fixed\s+(?=[a-z0-9])|\b(?:is|are|was|were|stays?|remains?|be|been|being|kept|gets?)\s+fixed\s+(?=(?:at|to)\s+(?!(?:work|use|handle|return|accept|skip|ignore|run|show|read|write|allow|reject|pass|stop|avoid|prevent|keep|make|support|match|include|exclude|load|save|send|call|wait|retry|check|catch|treat|respect|parse|emit|log|close|open|flush|drop|retain|clear)\b))|\b(?:the|this|these|those|its|their|our|your|my|each|every)\s+fixed\s+(?!(?:it|them|this|that|these|those|the|a|an|everything|all|both|in|on|by|with|for|to|and|but|so|now|again|properly|correctly|already)\b)(?=[a-z])|\bfixed-(?=[a-z])|\b[a-z0-9]+-(?:guarded|patched|fixed|sorted|corrected|resolved)\b|\bfixed\s+(?=(?:window|size|width|height|point|rate|price|cost|delay|interval|timeout|length|number|seed|order|format|position|schedule|budget|fee|amount|set|string|header|offset|port|address|value|key|salt|term|layout|pitch|capacity|duration|frame|step|cadence|cap|ratio|limit|quota|pool|count|mtime|timestamp|date|time|clock|epoch|locale|timezone|tz|umask|mode|margin|padding|font|dimension|shape|temperature|tar|zip|gzip|build id|ordering)s?\b)/gi;
/** A quoted phrase that holds a claim's words: what someone or something said, not this turn's claim ('the bot posts "all checks passed"'). */
const QUOTED_CLAIM = /"[^"\n]{1,120}"|“[^”\n]{1,120}”/g;
const CLAIM_WORDS = /\b(pass(es|ed|ing)?|green|deployed|released|published|shipped|fixed|done|succeeded|successful(ly)?|merged|live|clean|healthy|ok)\b/i;
/** "no longer fails", "doesn't crash any more": a negation that claims a fix. */
const FIX_BY_NEGATION = /\bno longer\s+(fails?|failing|crash(es)?|errors?|throws?|breaks?|hangs?|panics?|leaks?|times? out|overruns?|drops?|loses?|happens?|reproduces?|deadlocks?|races?|blocks?|flaky|flakes?|flaking)\b|\b(doesn'?t|does not|won'?t|will not|can'?t|cannot)\s+(fail|crash|error|throw|break|hang|panic|leak|time out|happen|reproduce|deadlock|race)\s+(any ?more|now|again)\b|\bno (more|longer any) (errors|failures|crashes|warnings|panics|races)\b|\b(the )?(bug|issue|error|problem|crash|regression|failure|leak|warning|panic|race|npe|exception)s? (is|are) (now )?(gone|fixed|resolved)\b/i;
/** A deploy's state read back: "rollout `COMPLETED`", "4/4 tasks running". */
const ROLLED = /\b(?:rollouts?|deployments?|deploys?)\b[^.;]{0,40}?\b(?:complete[d]?|done|finished|succeeded|successful|went through|goes through(?=\s*$|\s*[.,;:!)]|\s+(?:now|again|fine|cleanly|clean|ok|okay|without|green|successfully|for\s+(?:the\s+)?(?:whole|full|entire|all)|across)\b))|\b\d+\s*\/\s*\d+\s+(?:tasks?|pods?|replicas?|instances?|containers?)\b(?:\s+on\s+[^.;,]{0,40}?)?\s+(?:are\s+)?(?:running|ready|available|healthy|up|live)\b/i;
/** "Tested it by pointing DEST at a dead host": something was run to try it. */
const TRIED = /\b(?:tested|tried|exercised|smoke[- ]tested|re-?tested)\s+(?:it|this|that|them|the\s+(?:fix|change|script|endpoint|flow|patch|command|binary|cli|tool|function|migration|hook|job))\b/i;
/** A question. */
const ASKED = /\?\s*$|^(do|does|did|is|are|was|were|can|could|should|would|will|shall|have|has)\s+(you|we|i|it|they|the)\b/i;
/**
 * What a document or a person says, not this turn's work: "the README says it is done", "the vendor claims it
 * is fixed". "Claim" is reported speech only as a verb with a speaker and what it says ("it claimed that …",
 * "the README claims the build passes"); job claims, JWT claims and insurance claims are things.
 */
const REPORTED = /\b(the|this|that|its|their|your|his|her|our|[a-z]+'s)\s+(?:(?:v?\d[\w.-]*|release|latest|current|new|old|original|updated|upstream|vendor|project|repo|repository|package|library|official|top|last|first)\s+){0,2}(readme|docs?|documentation|changelog|(?:changelog\s+)?entry|entries|pr|pull request|description|ticket|issue|comment|commit message|author|reviewer|team|user|checklist|wiki|spec|plan|notes?|release notes|approvals?|reviews?|messages?|reply|replies|summary|email|handoff|thread|page|post|article|docstring)\b[^.;]{0,50}\b(says?|said|claims?|claimed|states?|stated|reports?|reported|mentions?|mentioned|promises?|promised|lists?|listed)\b|\baccording to\b|\b(allegedly|supposedly|reportedly)\b|\b(?:it|he|she|they|someone|somebody|[a-z]+(?:'s)?)\s+(?:also\s+|still\s+|now\s+|even\s+)?(?:claims|claimed)\s+(?:that\b|to\s+(?:be|have)\b|(?:[\w-]+\s+){1,4}?(?:is|are|was|were|has|have|had|passes|passed|pass|works|worked|runs|ran|succeeds|succeeded|builds|built|fixes|fixed)\b)/i;
/**
 * A pass count that reports a failure: "only 1 passed", "just one test passes", "only `parses a port` passed".
 * Not "not only"; a count, a name or a few words between "only" and the pass word, without another clause between.
 */
const ONLY_PASSED = /(?<!\bnot\s)\b(?:only|just(?=\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple|a handful|half)\b))(?:\s+(?!(?:and|but|so|then|while|because)\b)[^\s,;:]+){0,5}?\s+(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|green|ok)\b/i;
/** Counts as words, for "two of the three". */
/** A pass that the reply explains away: "pass only by accident", "pass by coincidence", "passes vacuously". */
const ACCIDENTAL = /\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|works?|worked)\s+(?:only\s+|merely\s+|just\s+|purely\s+)?(?:by\s+(?:accident|coincidence|luck|chance)|accidentally|coincidentally|vacuously|trivially|for\s+the\s+wrong\s+reasons?)\b|\b(?:accidentally|coincidentally|vacuously|trivially)\s+(?:pass(?:es|ed|ing)?|green)\b/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const COUNTED = String.raw`(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
/**
 * "1 of 3 tests passed", "1 out of 3", "1/3 pass", "passed 2 of 3": part of a run said to pass, which reports the rest
 * failing. Not "shard 1/3" or "step 2 of 4", which number one of several.
 */
const SOME_OF = new RegExp(String.raw`(?<!\b(?:shards?|steps?|stages?|parts?|phases?|batch(?:es)?|chunks?|pages?|attempts?|tries|try|rounds?|iterations?|nodes?|workers?|day|week)\s*#?)\b${COUNTED}\s+(?:of|out\s+of)\s+(?:the\s+|its\s+|all\s+|their\s+)?${COUNTED}\b|(?<!\b(?:shards?|steps?|stages?|parts?|phases?|batch(?:es)?|chunks?|pages?|attempts?|tries|try|rounds?|iterations?|nodes?|workers?)\s*#?)(?<![\w.\/])(\d+)\s*\/\s*(\d+)(?![\w.\/])`, 'gi');
const SOME_PASS_AFTER = /^\s+(?:[\w-]+\s+){0,4}?(?:pass(?:es|ed|ing)?|green|ok|succeed(?:s|ed)?)\b/i;
const SOME_PASS_BEFORE = /\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\s+(?:only\s+|just\s+)?$/i;
const countOf = (w) => (w === undefined ? undefined : /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w.toLowerCase()]);
/** Whether a clause with a pass word says only part of the run passed: a failure report, not a claim. */
function partPassed(words) {
    if (!/\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|green|ok)\b/i.test(words)) return false;
    if (ONLY_PASSED.test(words)) return true;
    for (const m of words.matchAll(SOME_OF)) {
        const part = countOf(m[1] ?? m[3]);
        const whole = countOf(m[2] ?? m[4]);
        if (part === undefined || whole === undefined || !(part < whole)) continue;
        if (SOME_PASS_AFTER.test(words.slice(m.index + m[0].length)) || SOME_PASS_BEFORE.test(words.slice(0, m.index))) return true;
    }
    return false;
}
/**
 * An instruction, not a report: a clause that opens with a verb's plain form and its object ("Run it on staging
 * first", "Deploy to production once staging looks fine", "Push the tag with `git push --tags`"), with no finite
 * verb after it. "Build passes" and "Deploy succeeded" use the verb as a noun.
 */
const IMPERATIVE_VERB = String.raw`(?:run|rerun|re-run|deploy|redeploy|push|publish|release|ship|merge|tag|roll\s+(?:it\s+|them\s+)?(?:out|back)|promote|apply|migrate|add|fix|update|create|write|rename|remove|delete|move|change|replace|refactor|build|rebuild|test|retest|check|verify|install|configure|bump|open|review|watch|start|restart|wait|make|use|try|backfill|upload|commit|revert|enable|disable|wire|document|implement)`;
const IMPERATIVE = new RegExp(String.raw`^(?:(?:please|then|now|first|next|finally|also|and)\s*,?\s+)*${IMPERATIVE_VERB}\s+(?:it|them|this|that|these|those|the|a|an|your|our|my|its|their|all|every|each|both|one|to|on|in|into|against|out|back|up|down|with|from|${OPEN}|v?\d|[\w-]+\/|[\w-]+\.[a-z]{1,6}\b)`, 'i');
/** A finite or past verb after the opening verb: "Deploy to staging succeeded", "Tag v1.2.0 pushed to origin". */
const FINITE = /\b(?:is|are|was|were|has|have|had|passes|passed|succeeded|succeeds|failed|fails|went|goes|completed|finished|worked|works|returned|returns|ran|exited|exits|shows|showed|printed|prints|answered|answers|came|comes|reports|reported|stays|stayed|landed|lands|done|complete|\w{3,}ed)\b/i;
/** Whether a clause is an instruction: its verb opens it, takes an object, and nothing after it reports a result. */
const imperative = (words) => {
    const m = IMPERATIVE.exec(words);
    return m !== null && !FINITE.test(words.slice(m[0].length));
};
/** A sentence that says what something means: "A green build means every job succeeded", "Exit code 0 means …". */
const MEANS = /^(?!(?:this|that|it|which|so|and)\b)[^,;]{1,80}?\b(?:means|meant|indicates|signals|stands for|is shorthand for|refers to|tells you)\b/i;
/** How a build is set up, not how it went: "still compiles with `maven.compiler.release` = `11`", "builds against a target set to es2019". */
const CONFIGURED = /\b(?:builds?|compiles?)\s+(?:with|against|for)\s+(?:[^.;=]|\.(?=\S)){1,60}?(?:\s*=\s*\S|\s+set\s+to\s)/i;
/** Deploy words used as adjectives: "the published checksum" claims nothing. */
const ADJECTIVE = /\b(the|a|an|its|our|their|this|that|these|those|every|each|any|your|my|his|her|previously|last|earlier)\s+(\w+\s+)?$|\b(that|which|who)('s|\s+(is|was|are|were|has been|had been|have been|got))\s+(already\s+|just\s+|been\s+)?$/i;
/** Whether a point in a marked clause is inside inline code. */
const inCode = (before) => before.split(OPEN).length > before.split(CLOSE).length;
/** What code does to its own things: a lock released, a job pushed onto a queue, an event published, two maps merged. */
const CODE_ACT = [
    /^(?:released|pushed|published|merged|shipped|promoted)\s+(?:the|a|an|its|their|that|this|each|every|any|both|all|two|three)?\s*(?:[\w-]+\s+){0,2}?(?:mutex(?:es)?|locks?|semaphores?|latch(?:es)?|connections?|handles?|memory|resources?|buffers?|pointers?|references?|refs?|gil|leases?|slots?|events?|messages?|frames?|items?|elements?|entries|entry|nodes?|maps?|dicts?|dictionaries|hashmaps?|keys?|values?|objects?|structs?|records?|rows?|arrays?|lists?|sets?)\b/i,
    /^pushed\s+(?:[\w-]+\s+){0,3}?(?:onto|on to|into|to)\s+(?:the|a|an|its|their)\s+(?:[\w-]+\s+)?(?:stack|queue|heap|list|array|buffer|channel|deque|ring|slice)\b/i,
];
/** A resource as the subject of a release or a push ("Locks are released", "the connection gets released"): code at work. */
const RESOURCE_PASSIVE = /\b(?:mutex(?:es)?|locks?|semaphores?|latch(?:es)?|connections?|handles?|memory|resources?|buffers?|pointers?|references?|refs?|gil|leases?|slots?|file\s+descriptors?|fds?|sockets?|permits?)\s+(?:is|are|was|were|gets?|got|get|being|been|will\s+be|must\s+be)\s+(?:(?:then|also|always|only|never|now|still|properly|correctly|automatically|immediately|eventually)\s+)?$/i;
/** A clause whose subject is a function or method in inline code ("`LRU.Get` released …"): it describes the code. */
function codeSubject(before) {
    const m = new RegExp(`${OPEN}([^${CLOSE}]+)${CLOSE}\\s+(?:now\\s+|also\\s+|still\\s+|then\\s+|always\\s+|only\\s+|never\\s+)?$`).exec(before);
    if (!m) return false;
    const code = m[1].trim();
    if (/\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rb|rs|java|kt|swift|md|json|ya?ml|toml|html|css|sh|tar|gz|tgz|zip|whl|jar|apk|aab|ipa|dmg|exe|so|dll|wasm|lock|txt|sql|tf|png|svg)$/i.test(code)) return false;
    return /^[A-Za-z_$][\w$]*(?:(?:\.|::|#|->)[A-Za-z_$][\w$]*)+(?:\(\))?$|^[A-Za-z_$][\w$]*\(\)$/.test(code);
}
/** "tagged `release`", "tagged docs": a label, not a version tag ("tagged v1.2.0", "tagged it", "tagged the release"). */
const TAG_LABEL = new RegExp(String.raw`^tagged\s+(?:with\s+|as\s+)?(?:${OPEN}(?!v?\d)|(?!(?:[\w.-]*\d+\.\d+|v\d|it|this|that|them|these|those|and|then|on|in|at|to|for|from|with|the|a|an|release|version|main|master|head)\b)[a-z])`, 'i');
/**
 * A description, not this turn's claim: code that returns a status ("the
 * early `return 200`"), a mismatch with what the tests expect, a commit's or
 * a person's work ("`b2f1c88` renamed the param", "Tomas's change landed"),
 * and other people's results ("42 passing on their side").
 */
const DESCRIBED = /\b(where|whereas|while)\s+(the\s+)?(tests?|specs?|callers?|clients?|it|they|we|you|users?)\s+expects?\b|\b(an?|the|that|this|its)\s+(early\s+)?return\s+\d{3}\b|\bearly\s+return\s+\d{3}\b|^[A-Z][a-z]+['’]s\s+(change|pr|commit|branch|fix|patch|work|refactor|rewrite)\b|\bon their (side|end)\b|\b(their|his|her) (suite|ci|tests?|builds?|runs?|machines?|laptops?|setup|team|side|end)\b|\bthey (say|said|report|reported|claim|claimed|believe|see|saw)\b|\bper the (issue|report|ticket|dashboards?|logs?)\b/i;
/** Uses of "pass" that hand something over, not a test result: "`load()` passes `true`", "passes the token through",
 * "passes `.Values.x` straight through", "now pass `series={[…]}`" (code holding a value or a call). */
const TRANSITIVE = new RegExp(String.raw`\bpass(?:es|ed|ing)?\s+(?:${OPEN}?(?:true|false|null|nil|none|undefined|nothing|it|them)${CLOSE}?|along|through|back|down|control|ownership|in\s+(?:a|an|the)\b|(?:only\s+|just\s+|also\s+)?(?:${OPEN}[^${CLOSE}]{1,60}${CLOSE}(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)){0,5}${OPEN}[^${CLOSE}]{1,60}${CLOSE}\s+(?:straight\s+|right\s+|directly\s+|unchanged\s+|as-is\s+)?(?:to|into|through|along|down|in|as|on|from)\b|(?:only\s+|just\s+|also\s+)?${OPEN}[^${CLOSE}]{0,60}[={(\[][^${CLOSE}]{0,60}${CLOSE}|(?:a|an|the|its|their|this|that)\s+(?:token|value|flag|param(?:eter)?s?|arg(?:ument)?s?|context|ctx|callback|handler|request|response|config|options?|opts|signal|pointer|reference|ref|buffer|string|object|map|list|array|struct|error|err|id|key|header|cookie|session|user|payload|message|event|result|func(?:tion)?|closure|promise|channel|stream|writer|reader|file|path|url|uri)s?\b)`, 'gi');

// ── What makes a clause a claim ────────────────────────────────────

const SUBJECT = String.raw`(?:(?:the\s+)?pr(?:\s*#?\d+)?|pull request(?:\s*#?\d+)?|checksums?|sha-?\d*sums?|md5sums?|digests?|signatures?|tests?|pytest|jest|vitest|mocha|rspec|phpunit|ctest|specs?|test ?suites?|suites?|e2e|checks?|assertions?|examples?|cases?|builds?|bundle|lint(?:ing|er|ers)?|ci|pipelines?|workflows?|(?:ci|deploy|build|test|lint|release|e2e|nightly)\s+jobs?|runs?|type ?checks?|typecheck(?:s|ing)?|types|tsc|clippy|eslint|ruff|mypy|flake8|rubocop|pylint|golangci-lint|prettier|vet|go vet|webpack|vite|esbuild|rollup|everything|${OPEN}[^${CLOSE}]{1,80}${CLOSE})`;
const PASS_VERB = String.raw`(?:(?<!-)pass(?:es|ed|ing)?|green|(?<!\b(?:stops?|stopped|exits?|exited|shuts?\s+down|shut\s+down|terminates?|terminated|closes?|closed|cancels?|cancell?ed|unmounts?|unmounted|disconnects?|disconnected|tears?\s+down|tore\s+down|recovers?|recovered|restarts?|restarted|handles?|handled|separates?|separated|splits?|applies|applied|merges?|merged|rebases?|rebased|reverts?|reverted|drains?|drained|unwinds?|unwound|rolls?\s+back|rolled\s+back)\s)clean(?:ly)?|ok|okay|successful(?:ly)?|succeed(?:s|ed)?|went through|goes through(?=\s*$|\s*[.,;:!)]|\s+(?:now|again|fine|cleanly|clean|ok|okay|without|green|successfully|for\s+(?:the\s+)?(?:whole|full|entire|all)|across)\b)|(?:finished|completed|ran|went|exited|exits)\s+(?:successfully|green|clean(?:ly)?|fine|ok|with 0|0|with (?:an? )?exit(?: code| status)? (?:of )?0)|complete[sd]?(?:\s+successfully)?|compiles?(?:\s+(?:cleanly|fine|successfully))?)`;
const PASS_WORD = /\b(0 (?:failures?|failed|errors?)|pass(es|ed|ing)?|green|succeed(s|ed)?|success(ful(ly)?)?|clean(ly)?|ok|okay|good|compiles?|builds|assembles|went through|goes through(?=\s*$|\s*[.,;:!)]|\s+(?:now|again|fine|cleanly|clean|ok|okay|without|green|successfully|for\s+(?:the\s+)?(?:whole|full|entire|all)|across)\b)|complete[sd]?|verified|verif(y|ies)|match(es|ed)?|exit(?: code| status)? (?:of )?0|(?:exits?|exited|returns?|returned)\s+(?:with\s+)?(?:(?:an?\s+)?(?:exit\s+)?(?:code|status)\s+(?:of\s+)?)?0|exit\s+(?:code|status)\s+(?:is|was)\s+(?:now\s+)?0)\b/i;

const PASSED = [
    // "The script now exits 0 on an empty file", "It exits with code 0 now", "Exit code is 0 now", "the job exited 0":
    // an exit code, with "now" or in the past; "exits 0 on success" alone says how a program behaves.
    /\b(?:now\s+)?(?:exits?|returns?)\s+(?:with\s+)?(?:(?:an?\s+)?(?:exit\s+)?(?:code|status)\s+(?:of\s+)?)?0\b(?=[^.;]*\bnow\b)|\bnow\s+(?:exits?|returns?)\s+(?:with\s+)?(?:(?:an?\s+)?(?:exit\s+)?(?:code|status)\s+(?:of\s+)?)?0\b|\b(?:exited|returned)\s+(?:with\s+)?(?:(?:an?\s+)?(?:exit\s+)?(?:code|status)\s+(?:of\s+)?)?0\b|\bexit\s+(?:code|status)\s+(?:is|was)\s+(?:now\s+)?0\b(?=[^.;]*\bnow\b|\s*now\b)|\bexit\s+(?:code|status)\s+(?:is|was)\s+now\s+0\b/i,
    // "Still green: `./mvnw test` → 67 tests", "All passing."
    /^(?:still|all|everything(?:\s+(?:is|still))?|now)\s+(?:green|passing|clean)\b/i,
    // "67 tests, 0 failures", "Tests run: 12, 0 failures"
    /\b\d+\s+tests?(?:\s+run)?,\s+0\s+(?:failures?|failed|errors?)\b/i,
    // "all 42 tests pass", "the test suite is green", "`go test ./...` is clean", "CI on main is green"
    new RegExp(String.raw`(^|\b|${OPEN})${SUBJECT}(?!\w)[^.;:]{0,40}?\b(?:(?:is|are|was|were|stays?|stayed|came back|comes back|looks?|now|all|still|both|also|is now|are now)\s+){0,3}${PASS_VERB}\b`, 'i'),
    // "passes all 12 tests", "passing all 18 of its tests"
    // "it passed all 20 runs": a repeated run, each time passing
    /\b(pass(es|ed)?|passing)\s+(all\s+|every\s+|the\s+)?(\d+\s+)?(of\s+(its|the|their)\s+)?(tests?|specs?|checks?|cases?|suites?|examples?|runs|iterations|attempts)\b/i,
    // "12/12 pass", "Range tests pass 6/6", "3/3 green"
    /\b\d+\s*\/\s*\d+\s+(\w+\s+){0,2}(pass(ed|es|ing)?|green|ok)\b|\b(pass(es|ed)?|passing)\s+\d+\s*\/\s*\d+\b/i,
    // "4 of 4 packages pass", "12 out of 12 specs passed": all of a count
    new RegExp(String.raw`\b(\d+)\s+(?:of|out\s+of)\s+\1\s+(?:[\w-]+\s+){0,3}?${PASS_VERB}\b`, 'i'),
    // "12 passed", "1 passed", "7 passing, 0 failing", "12 pass, 0 fail"
    /\b\d+\s+(tests?\s+|specs?\s+|checks?\s+|examples?\s+|cases?\s+)?(passed|passing|pass(?=[,;.]|\s+(and\s+)?0\b))/i,
    // "`SlugTest`: OK", "`go vet`: clean"
    new RegExp(String.raw`${OPEN}[^${CLOSE}]{1,80}${CLOSE}\s*:\s*(all\s+)?(\d+\s*(\/\s*\d+\s+)?(tests?\s+)?)?(ok|okay|pass(es|ed)?|passing|green|clean|success(ful)?)\b`, 'i'),
    // "`ansible-playbook site.yml` ran clean", "`make check` finished successfully"
    new RegExp(String.raw`${OPEN}[^${CLOSE}]{2,160}${CLOSE}\s+(?:now\s+|also\s+|then\s+)?(?:ran|runs|finished|completed|went through|exited|exits)\s+(?:clean(?:ly)?|successfully|green|ok|okay|with (?:exit (?:code |status )?)?0)\b|${OPEN}[^${CLOSE}]{2,160}${CLOSE}\s+(?:now\s+|also\s+|still\s+)?goes through(?=\s*$|\s*[.,;:!)]|\s+(?:now|again|fine|cleanly|clean|ok|okay|without|green|successfully|for\s+(?:the\s+)?(?:whole|full|entire|all)|across)\b)`, 'i'),
    // "tests: 101/101 passed", "Tests = 12 ok"
    /\b(\d+\s+)?(tests?|checks?)\s*[:=]\s*\d+\s*(\/\s*\d+\s*)?(pass(ed)?|ok|green)\b/i,
    // "builds cleanly", "the bundle builds", "the crate compiles"
    /\b(builds?|built|compiles?|compiled)\s+(cleanly|successfully|fine|without (errors|warnings))\b|\b(build|bundle|app|project|crate|package|module|code|binary|site|image|service|tree|apk|aab|ipa|jar|archive|artifact)\s+(now\s+|still\s+|also\s+)?(builds|compiles|assembles)\b/i,
    // "everything is green", "all green"
    /\b(everything|all)\s+(is\s+|are\s+)?(green|passing|passes)\b/i,
    // "9 examples, 0 failures", "OK (36 tests", "BUILD SUCCESSFUL", "lints clean"
    /\b\d+ examples?, 0 failures\b|\bok\b\W{1,4}\d+ tests?\b|\bbuild successful\b|\blints?\s+clean\b|\btests?,?\s+ok\b/i,
    // "checksums verified", "every artifact matches its published SHA-256", "the signature verifies"
    /\b(checksums?|hash(es)?|digests?|signatures?|sha-?\d*(sums?)?)\b[^.;:]{0,30}?\b(verified|verif(y|ies)|match(es|ed)?|check(s|ed)? out|(is|are) (valid|correct|ok))\b/i,
    /\b(match(es|ed)?|verified against)\s+(its|their|the)\s+(published\s+|expected\s+|recorded\s+|listed\s+)?(checksums?|hash(es)?|digests?|sha-?\d*(sums?)?|signatures?)\b/i,
    // "the strict config now passes with zero errors"
    /\b(now\s+)?pass(es|ed)?\s+(with\s+)?(zero|no|0)\s+(errors?|warnings?|failures?|issues?|problems?|findings?|offen[cs]es?)\b/i,
    // "every ledger package passed"
    /\b(every|all|each|both)\s+(\w+\s+){0,2}(packages?|modules?|crates?|targets?|projects?)\s+(\w+\s+){0,1}(pass(es|ed)?|green|succeeded)\b/i,
    // "the same 12 green tests", "all 40 passing specs"
    /\b(all\s+)?\d+\s+(green|passing)\s+(unit\s+|e2e\s+|integration\s+)?(tests?|specs?|checks?|cases?|examples?)\b/i,
];

/** An exit code said to be 0: "exits with code 0", "exit code is 0", "exited 0". */
const EXIT_ZERO = /\b(?:exits?|exited|returns?|returned)\s+(?:with\s+)?(?:(?:an?\s+)?(?:exit\s+)?(?:code|status)\s+(?:of\s+)?)?0\b|\bexit\s+(?:code|status)\s+(?:is|was)\s+(?:now\s+)?0\b/i;
/** "The suite is still 34/34", "tests are 12/12": all of a count, said without a pass word. */
const ALL_PASS = new RegExp(String.raw`(?:^|\b)${SUBJECT}(?!\w)\s+(?:is|are|was|were|stays?|stayed|remains?|remained)\s+(?:still\s+|now\s+|back\s+(?:to|at)\s+|at\s+)?(\d+)\s*\/\s*\1(?![\d/])`, 'i');

// "Uploaded build 213 to App Store Connect": an upload to a place ships it.
const DEPLOY_WORD = /\b(deployed|redeployed|released|shipped|rolled out|rolled\s+(?:it|them|this|that|these|those|everything)\s+out|rolled\s+(?:(?:the|a|an|our|your|its|their|both|all)\s+)?(?:\S+\s+){0,3}?out(?=\s+(?:to|on|onto|across|everywhere)\b)|rolled back|promoted|published|pushed|merged|tagged|provisioned|uploaded(?=[^.;]{0,80}?\bto\s))\b/gi;
const DEPLOYED_OTHER = [
    // "staging is stable on the new version", "prod is healthy on 3.1.0": where the new version runs
    /\b(?:is|are)\s+(?:now\s+)?(?:stable|healthy|up|serving|running)\s+(?:on|with)\s+(?:the\s+)?(?:new\s+(?:version|release|build|image)|v?\d+\.\d+(?:\.\d+)?)\b/i,
    /\b(is|are)\s+(now\s+)?live\b|\bgo(es)? live\b|\bwent live\b|\b(and|now)\s+live\b|^live\b(?![\s-]+(?:check|query|read|test|look|probe|smoke|run|lookup|request|call|curl|verification|validation)s?\b)|\blive\s+(on|in)\s+(staging|production|prod)\b/i,
    /\b(is|are)\s+(now\s+)?((built|pushed|published|up) and\s+)?(on|in)\s+(the\s+)?(registry|npm|pypi|crates\.io|docker ?hub|ghcr|ecr|gcr|rubygems|packagist|origin|production|prod|staging)\b/i,
    /\b(is|are)\s+(now\s+)?(on|at)\s+(v?\d+\.\d+(\.\d+)?|release v?\d+|the new (version|release|build|image))\b/i,
    /\b(created|cut)\s+the\s+(tag|release)\b/i,
    // "Upgraded the `api` release in `staging`": a Helm release is a deploy.
    /\b(?:upgraded|rolled\s+back)\s+(?:the\s+)?(?:\S+\s+){0,2}?(?:helm\s+)?release\b(?!\s+notes?\b)/i,
    /\b(is|are)\s+(now\s+)?(up|live|out|deployed)\s+(on|at|to)\s+(a|an|the|its)?\s*(new\s+)?([\w.-]+\s+){0,2}(preview|staging|production|prod|vercel|netlify|fly|heroku|render|cloud run|app engine|pages)\b/i,
    /\b(applied|ran|run|executed)\s+(it\s+|them\s+|the migrations?\s+)?(on|to|against|in)\s+(the\s+)?(staging|production|prod|live|preview|qa|uat)\b/i,
    /\b(staging|production|prod)\s*(db|database)?\s+(is|are)\s+(now\s+)?(at|on)\s+(head|the latest (migration|revision))\b/i,
];
/** "Live" as where something sits, not a deploy: "the tests now live in `tests/`", "the index is live locally". */
const LIVES_IN = /\b(?:now\s+)?lives?\s+(?:in|under|inside|within|alongside|next to|beside)\s+(?:the\s+|a\s+|its\s+|their\s+)?(?:code\b|[\w-]*\/[\w./-]*|[\w-]+\.[a-z]{1,6}\b|(?:same|new|shared|separate|own|one)\s+\w+|(?:file|folder|directory|module|package|repo|class|component|crate|namespace|workspace)s?\b)|\blive\s+locally\b|\blive\s+(?:on|in)\s+(?:my|your|this|the local)\s+(?:machine|laptop|box|db|database|checkout)\b/gi;

const HEALTH = [
    /\b(is|are)\s+(now\s+)?(healthy|up and running|serving)\b|\bserving (traffic|requests|the new (build|version|release))\b/i,
    // "the service is stable (2/2 tasks)", "the new deployment is up": not "is up to date", "up next", "up for review" or "up on a preview" (a place)
    /\b(?:services?|deployments?|deploys?|rollouts?|apps?|clusters?|pods?|tasks?|nodes?|sites?|servers?|instances?|containers?)\s+(?:is|are)\s+(?:now\s+)?(?:stable|steady|up(?![\s-]+(?:on|at|in|with|and)\b))\b(?!\s+(?:to|for|next|against|front|in the air)\b)/i,
    // An HTTP status, not arithmetic or a value: "returns 200", not "returns `100 - 100*10`" or "returns 100" (code at work).
    /\b(returns?|answers?|responds?|responded|came back|comes back)\s+(with\s+)?(an?\s+)?(http\s+)?([2-5]\d{2}(?!\d|\.\d|\s*[-+*\/×÷=^%])|ok)\b/i,
    // "the health endpoint is returning 200", "it's answering with a 200"
    /\b(?:is|are|'s|’s)\s+(?:now\s+|still\s+|back\s+)?(?:returning|answering|responding)\s+(?:with\s+)?(?:an?\s+)?(?:http\s+)?(?:[2-5]\d{2}s?(?!\d|\.\d|\s*[-+*\/×÷=^%])|ok)\b/i,
    /\bhealth\s*(checks?|endpoint|probe)?\s+(pass(es|ed)?|is ok|ok|is green|returns? ok|came back ok)\b|\bhealth checks? (are )?(passing|green)\b/i,
    // "/healthz is ok and reports 2.7.0", "`/ready` came back healthy"
    /(?:^|[\s(⟨])\/(?:healthz?|readyz?|livez|_health|health-?check|status)\b[^.;]{0,30}?\b(?:is|are|was|were|reports?|returns?|says?|shows?|answers?|came back|comes back)\s+(?:still\s+|now\s+|back\s+)?(?:ok|okay|up|green|healthy|good|fine|passing|200)\b/i,
];
/** A health endpoint by its path. */
const HEALTH_PATH = /(?:^|[\s(⟨])\/(?:healthz?|readyz?|livez|_health|health-?check)\b/i;

const FIXED = [
    // "Sorted" fixes only as "sorted it out", "all sorted" or "got it sorted": "the slice is left sorted" describes the data.
    /\b(fixed|resolved(?!\s+(?:to|inside|into|as|against|relative|via|from|correctly\s+to)\b)|repaired|patched|corrected|addressed|stabili[sz]ed|guarded)\b|\bsorted\s+(?:(?:it|that|this|them|everything|things)\s+)?out\b|\b(?:all|got\s+(?:it|that|this|them|everything))\s+sorted\b/i,
    /\b(now|it|this|that|everything)\s+works\b/i,
    /\bworks\s+(now|again|correctly|as expected|fine)\b/i,
    /\b(is|are)\s+(now\s+)?working( again| correctly| as expected)?\b/i,
    /\brenders? again\b|\bhandles? (it|them|this) (now|correctly)\b/i,
    // "removed the loss spike around step 200", "got rid of the deadlock": not "removed the error handling"
    /\b(?:removed|eliminated|got rid of|killed|cured|stopped)\s+(?:the|a|an|that|this|those|these|its|their|both|all|any)\s+(?:[\w-]+\s+){0,2}?(?:spikes?|leaks?|crash(?:es)?|races?|race conditions?|flakes?|flakiness|deadlocks?|ooms?|oomkills?|regressions?|slowdowns?|stalls?|hangs?|panics?|retry storms?|segfaults?)(?=\s*(?:$|[.,;:)!])|\s+(?:around|at|in|on|when|that|which|from|for|after|during|under|with|seen|caused|reported)\b)/i,
    // "The fix is in and verified" claims it works; "The fix is in" alone is a change (done).
    /\bthe fix(?:es)?\s+(?:is|are|was|were|has been|have been)\s+(?:now\s+)?(?:in\s+(?:place\s+)?and\s+)?(?:verified|tested|working|confirmed)\b/i,
];
/** An arrow between figures ("310 ms → 120 ms"), with the units on either side. */
const ARROW = /(?<![\w.])\d+(?:\.\d+)?\s*([a-zµ%/]*)\s*(?:→|->|=>|⟶)\s*\d+(?:\.\d+)?\s*([a-zµ%/]*)/gi;
const ARROW_UNIT = /^(?:ms|µs|us|ns|s|sec|secs|seconds|min|mins|minutes|h|hrs|%|kib|mib|gib|kb|mb|gb|b|bytes|req\/s|rps|qps|ops\/s|tok\/s|fps|k)$/i;
/** Names of a measure, so an arrow between bare figures is a result: "p50 310 → 120", "errors 12 → 0". */
const MEASURE = /\b(coverage|p\d{2,3}|median|mean|avg|average|latency|throughput|faster|slower|quicker|speed(?:up)?|bench(?:mark)?s?|memory|rss|cpu|heap|bundle|size|time|duration|runtime|took|errors?|warnings?|failures?|failing|flak\w*|allocs?|allocations?|queries|requests?|round[- ]?trips?|calls|hits?|misses|loc|score|accuracy|acc|f1|precision|recall|loss|perplexity|wer|cer|rmse|mse|mae|auc|qps|rps|fps|ttfb|lcp|fcp|tbt|cold starts?|startup)\b/i;
/**
 * "p50 310 ms → 120 ms", "errors 12 → 0": an arrow between figures with a unit or a measure's name;
 * not "0.125 → 0.13" or "TTL 300 → 60", and not a worked example ("10% + 15% → 15% off").
 */
const MEASURED_ARROW = {
    test(text) {
        const t = String(text);
        for (const m of t.matchAll(ARROW)) {
            if (/[+×*]\s*$/.test(t.slice(0, m.index))) continue;
            // "Annual discount 15% → 20%", "timeout 30 s → 60 s": a setting changed, not a figure measured.
            if (SETTING_BEFORE.test(t.slice(0, m.index).replace(/[*_`]/g, ''))) continue;
            if (ARROW_UNIT.test(m[1]) || ARROW_UNIT.test(m[2]) || MEASURE.test(t)) return true;
        }
        return false;
    },
};
/** A setting, not a measurement: "the timeout went from 30 s to 60 s" is a change to it. */
const SETTING_BEFORE = /\b(?:discounts?|prices?|pricing|fees?|tax|vat|tiers?|seats?|timeouts?|delays?|intervals?|ttls?|limits?|caps?|retries|retry|thresholds?|ports?|versions?|defaults?|settings?|budgets?|quotas?|windows?|backoffs?|concurrency|replicas?|workers?|pool(?:\s+size)?|max(?:imum)?|min(?:imum)?)\b[^.;]{0,30}$/i;
/**
 * "p95 went from 900 ms to 120 ms", "Dropping moment.js took the main chunk from 412 kB to 296 kB": a measured
 * before and after, with a unit or a measure's name; not a setting that went from one value to another.
 */
const MOVED_FROM_TO = {
    test(text) {
        const t = String(text);
        const re = /\b(?:went|goes|go|came|comes|got|gets|took|takes|brought|brings|moved|moves|fell|falls|dropped|drops|rose|rises|shrank|shrinks|grew|grows)\s+(?:[\w.$-]+\s+){0,4}?from\s+(?:(?:about|around|roughly|nearly|almost|approximately)\s+)?~?\d[\d.,]*\s*([a-zµ%/]*)\s+(?:to|down\s+to|up\s+to)\s+(?:(?:about|around|roughly|nearly|almost|approximately)\s+)?~?\d[\d.,]*\s*([a-zµ%/]*)/gi;
        for (const m of t.matchAll(re)) {
            if (SETTING_BEFORE.test(t.slice(0, m.index + m[0].indexOf('from')))) continue;
            const unit = (u) => ARROW_UNIT.test(u) || /^(?:ns|b|allocs)\/op$/i.test(u);
            if (unit(m[1]) || unit(m[2]) || MEASURE.test(t)) return true;
        }
        return false;
    },
};
/**
 * "92%, up from 78%", "p95 is down from 310": a figure it moved from, with a unit or a measure's name; not a line that
 * "shifted up from 5".
 */
const UP_DOWN_FROM = {
    test(text) {
        const t = String(text);
        const m = /\b(?:down|up)\s+from\s+~?\d[\d.,]*\s*([a-zµ%/]*)/i.exec(t);
        if (!m) return false;
        return ARROW_UNIT.test(m[1]) || /^(?:ns|b|allocs)\/op$/i.test(m[1]) || MEASURE.test(t);
    },
};
/** A number that got better: "p50 310 ms -> 120 ms", "2.5x faster", "cut the bundle to 182 KiB". */
const IMPROVED = [
    MEASURED_ARROW,
    MOVED_FROM_TO,
    // "p50 is down ~60%", "latency is now down by 40%"
    /\b(?:is|are|was|were|went|came|now)\s+(?:now\s+)?down\s+(?:by\s+)?(?:about\s+|around\s+|roughly\s+|nearly\s+|almost\s+|over\s+|~\s*)?\d+(?:\.\d+)?\s*%/i,
    /\b\d+(\.\d+)?\s*(x|×)\s+(faster|quicker|smaller|less|fewer|lower|higher|more throughput)\b/i,
    /\b(faster|quicker|smaller|lighter|leaner|speed(ed)? up|sped up|halved|reduced|shaved|lowered|improved)\b[^.;]{0,60}\d/i,
    // "dropped to 120 ms", "cut the bundle by 40%": a figure it went to, by or from, not "cut off" or "cut the release"
    /\b(dropped|cut|fell|went down|came down|shrank|shrunk)\b(?!\s+(?:it\s+|them\s+)?off\b)\s+(?:\w+\s+){0,3}?(?:by|to|from|down to|under|below)\s+~?\d/i,
    new RegExp(String.raw`\d(?:\.\d+)?\s?(?:ms|µs|us|ns|s|sec|secs|seconds|min|mins|minutes|%|x|×|kib|mib|gib|kb|mb|gb|bytes|req\/s|rps|qps|ops\/s|tok\/s|fps)(?![\w/])[^.;]{0,40}\b(faster|quicker|smaller|lower|down from|up from|halved|reduced|dropped)\b`, 'i'),
    UP_DOWN_FROM,
    /\b(much|far|a lot|way|significantly)\s+(faster|quicker|smaller|lighter)\b/i,
    // "Roughly 2.6x on ASCII and 2x on UTF-8": a factor given as the result
    /^(?:that'?s\s+|it'?s\s+|so\s+|overall\s+)?(?:roughly|about|around|approximately|nearly|almost|~)\s*(?:an?\s+)?\d+(?:\.\d+)?\s*(?:x|×)(?!\w)/i,
];

/** "allocation-free", "zero allocations", "0 allocs/op": a benchmark's allocations per operation at none. */
const ALLOC_FREE = /\b(?:allocation[- ]free|alloc[- ]free|zero[- ]alloc(?:ation)?s?|no\s+(?:more\s+|heap\s+)?allocations|0\s+allocs?(?:\/op)?)(?![\w-])/i;

/** "It beats the current model", "v3 outperforms the baseline": a result better than a bar. */
const BEATS = /\b(beats?|outperforms?|exceeds?|surpass(?:es)?|better than (?:the )?(?:current|baseline|old|previous|existing|last)|clears the (?:\d+(?:\.\d+)?\s*%?\s+)?(?:bar|threshold))\b|\b(?:comfortably\s+|well\s+|just\s+|safely\s+)?(?:over|above|past)\s+the\s+\d+(?:\.\d+)?\s*%?\s+(?:bar|threshold|target|mark|goal|baseline)\b|\b(?:we|it|this|the model|that)\s+(?:now\s+)?(?:clear|clears|cleared)\s+(?:it|that|the\s+(?:\d+(?:\.\d+)?\s*%?\s+)?(?:bar|threshold|target|mark|goal))\b/i;

/** A search said to come back empty: "a final grep for `X` comes back empty", "no references to `X` remain". */
const SEARCH_EMPTY = [
    /\b(?:grep|rg|ripgrep|ag|ack|search(?:es|ed)?|find)\b[^.;]{0,100}?\b(?:comes?\s+back\s+empty|came\s+back\s+empty|(?:now\s+|still\s+)?(?:returns?|returned|finds?|found|shows?|showed|prints?|printed|turns?\s+up|turned\s+up|gives?|gave)\s+(?:nothing|no\s+(?:matches|results|hits|references|uses|usages|lines|occurrences))|is\s+(?:now\s+)?empty)\b/i,
    /\bno\s+(?:more\s+|remaining\s+|other\s+)?(?:references|uses|usages|mentions|imports|occurrences|callers|calls|matches)\s+(?:to\s+|of\s+)?\S+\s+(?:remain|are\s+left|left)\b/i,
    // "no `console.log` calls remain", "none are left in `src/`", "`src/app.js` has none left"
    /\bno\s+(?:more\s+|remaining\s+|other\s+)?\S+\s+(?:calls|references|uses|usages|imports|occurrences|callers|matches|mentions|reads|instances)\s+(?:remain|are\s+left|left)\b/i,
    /\bnone\s+(?:are\s+|is\s+|were\s+|was\s+)?(?:now\s+)?(?:left|remain(?:s|ing)?)\b|\b(?:has|have)\s+none\s+(?:left|remaining)\b/i,
    /\bnothing\s+(?:else\s+)?(?:references|uses|imports|calls|mentions)\s+\S+\s+(?:any\s?more|now)\b/i,
];
const SEARCH_CODE = /^(?:git\s+grep|grep|egrep|fgrep|rg|ag|ack)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:-e\s+)?(["']?)([^"'\s]+)\1/;

/** What a search claim searched for: the name in its inline code, or the term of a grep it names. */
function searchTermOf(clause) {
    for (const m of clause.matchAll(new RegExp(`${OPEN}([^${CLOSE}]{1,160})${CLOSE}`, 'g'))) {
        const code = m[1].trim();
        const grep = SEARCH_CODE.exec(code);
        if (grep) return grep[2];
        if (!/\s/.test(code) && !/\//.test(code)) return code;
    }
    const m = /\b(?:for|to|of)\s+["']?([A-Za-z_$][\w.$-]{2,60})["']?/.exec(shown(clause));
    return m?.[1];
}

/** "is in" claims at the end of a clause ("the fix is in", "is in on main"), not "is in play". */
const IS_IN = String.raw`in(?=\s*(?:$|[.,;:!)]|now\b|on\s+(?:main|master|the branch)))`;
const CHANGE_VERBS = 'cherry-picked|cherry picked|backported|rebased|squashed|edited|modified|tweaked|adjusted|amended|altered|revised|reworked|rewired|restructured|reorgani[sz]ed|reformatted|reworded|cleaned|reverted|restored|simplified|trimmed|reordered|inlined|deduplicated|consolidated|normali[sz]ed|parameteri[sz]ed|vendored|scaffolded|stubbed|added|created|updated|wrote|written|implemented|renamed|removed|deleted|moved|changed|replaced|refactored|cleaned up|set up|configured|installed|migrated|converted|extracted|split|merged|rewrote|rewritten|built|rebuilt|generated|completed|finished|registered|wired|hooked up|exposed|exported|introduced|bumped|pinned|upgraded|downgraded|enabled|disabled|documented|gated|ported|switched|swapped|applied|committed|regenerated|recorded|backfilled|pruned|tightened|raised|lowered|made';
/** The change verbs after a subject ("Report regenerated", "handlers.go split into three files"): "split" alone is a noun ("that split", "Test split"). */
const SUBJECT_VERBS = CHANGE_VERBS.replace('|split|', String.raw`|split(?=\s+(?:into|in\s+(?:two|three|four|five|half|halves|\d+)|up|out|off|across|by|between|apart|along)\b)|`);
/** A clause led by a change: "I edited …", "Changed …". */
const CHANGE_HEAD = new RegExp(String.raw`^(?:i\s+|we\s+)?(?:have\s+|'ve\s+|just\s+|also\s+|now\s+|then\s+)?(?:${CHANGE_VERBS})\b`, 'i');
/** What a change is for: "… so non-numeric entries are skipped", "… so that it doesn't throw". */
const PURPOSE_TAIL = /\s(?:so\s+that|so|in\s+order\s+to|such\s+that)\s.*$/i;
const DONE = [
    /^(all\s+)?(done|complete|completed|finished|sorted|all set|all wrapped up|wrapped up)\b/i,
    // "Ran the migrations", "Retrained on v7", "I fine-tuned the base model": a run that does the work.
    /^(?:i\s+|we\s+)?(?:have\s+|'ve\s+|just\s+|also\s+|then\s+)?(?:ran|re-?ran|executed)\s+(?:the\s+|both\s+|all\s+|its\s+|that\s+|this\s+|these\s+)?(?:new\s+|pending\s+)?(?:[\w-]+\s+)?migrations?\b(?!\s+(?:files?|generators?))/i,
    /^(?:i\s+|we\s+)?(?:have\s+|'ve\s+|just\s+|also\s+|then\s+)?(?:re-?trained|fine-?tuned|trained)\s+(?:it|them|the|a|an|on|for|with|both|all|our|your|\w+\s+(?:on|for|with))\b/i,
    /\b(?:i|we)\s+(?:have\s+|'ve\s+|just\s+|also\s+|then\s+)?(?:re-?trained|fine-?tuned)\b/i,
    // "Backfill complete", "Index rebuild done", "Training finished for v7"
    /^(?:the\s+)?[\w-]+(?:\s+(?:[\w-]+|[+&])){0,3}\s+(?:is\s+|are\s+|has\s+|have\s+)?(?:now\s+|all\s+)?(?:done|complete|completed|finished)\b/i,
    new RegExp(String.raw`\b(is|are|it'?s|that'?s|everything'?s|all)\s+(now\s+|also\s+)?(done|complete|completed|finished|in place|implemented|${IS_IN}|registered|wired( up)?|exported|added|configured|enabled|pinned|updated|documented|set|cleaned up|ported|migrated|bumped|merged|committed|built|rebuilt|generated|regenerated|compiled|bundled|packaged)\b`, 'i'),
    new RegExp(String.raw`\b(i'?ve|i have|we'?ve|we have|i|we)\s+(now\s+|also\s+|just\s+|then\s+)?(${CHANGE_VERBS})\b`, 'i'),
    new RegExp(String.raw`^(${CHANGE_VERBS})\b`, 'i'),
    /\b(task|work|change|changes|refactor|migration|implementation|feature|fix|rename|update|upgrade|bump|backfill|patch)\s+(is|are)\s+(now\s+)?(done|complete|finished|in place|applied|in(?=\s*(?:$|[.,;:!)]|now\b|on\s+(?:main|master))))/i,
    // "Report regenerated at docs/api.md", "Dev image rebuilt as app-dev:latest", "1,834 rows updated";
    // not "the rule is replaced" (how a plan or the code behaves) or "worth keeping that split" (a noun).
    new RegExp(String.raw`^(?!(?:which|that|who|so|and|but|because|since|while|as|if|when|where|whether|although|though)\b)(?:the\s+|a\s+|an\s+|all\s+)?[\w.,/${OPEN}${CLOSE}-]+(?:\s+[\w.,/${OPEN}${CLOSE}-]+){0,3}\s+(?:now\s+|also\s+)?(?<!\b(?:is|are|gets?|getting)\s+)(?:${SUBJECT_VERBS})\b(?!\s+(?:to\s+be|by\s+the\s+user))`, 'i'),
    // "Worker config now points at redis-2", ".env.example documents CACHE_URL now"
    /\bnow\s+(points|uses|returns|reads|lists|documents|leads|has|includes|contains|imports|exports|calls|sets|defaults|handles|accepts|supports|logs|retries|throws|falls back|guards|checks|skips|validates|redirects|caches|goes through|go through|routes? through)\b/i,
    /\b(points|uses|returns|reads|lists|documents|leads|has|includes|contains|imports|exports|calls|sets|defaults|handles|accepts|supports|logs|retries|throws|validates|caches)\b[^.;]{0,50}\bnow\b/i,
    /\b(is|are)\s+(now\s+)?applied\b/i,
    // "The three retry helpers are consolidated into one shared lib/retry.go", "is now gated behind a flag"
    new RegExp(String.raw`^(?!(?:which|that|who|so|and|but|because|since|while|as|if|when|where|whether|although|though)\b)(?:the\s+|a\s+|an\s+|all\s+|both\s+)?[\w.,/${OPEN}${CLOSE}-]+(?:\s+[\w.,/${OPEN}${CLOSE}-]+){0,4}\s+(?:is|are|was|were|has been|have been)\s+(?:now\s+|all\s+)*(?:${CHANGE_VERBS})\b(?:\s+\S+){0,3}?\s+(?:into|to|as|under|behind|onto)\b`, 'i'),
    new RegExp(String.raw`\b(?:is|are|has been|have been)\s+now\s+(?:${CHANGE_VERBS})\b`, 'i'),
];
/** A commit's own history, not this turn's work: "`b2f1c88` renamed the param". */
const HISTORY = new RegExp(String.raw`^(?:commit\s+)?(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\s+(?:also\s+|first\s+|originally\s+)?(?:${CHANGE_VERBS}|broke|introduced|landed|touched)\b`, 'i');
/** "The lock file was made with Node 22", "these were generated by protoc 3.21": where a thing came from, by a tool and its version. */
const PROVENANCE = /\b(?:was|were|is|are|has\s+been|have\s+been)\s+(?:originally\s+|first\s+|last\s+)?(?:made|created|generated|written|authored|locked|resolved)\s+(?:with|by|using|under|on)\s+(?:an?\s+|the\s+)?(?:older\s+|newer\s+|different\s+|later\s+|earlier\s+)?[A-Za-z][\w.+-]*\s+v?\d+(?:\.\d+)*\b/i;
/** Words in a claim that say it changed something, so a change must show. */
export const CHANGE_CLAIM = new RegExp(String.raw`\b(${CHANGE_VERBS}|in place|(?:is|are) ${IS_IN}|now (points|uses|returns|throws|falls back|guards|reads|writes|retries|leads|lists|documents|has|includes|contains|imports|exports|calls|sets|defaults|handles|accepts|supports|logs|checks|skips|validates|redirects|caches)|(points|uses|returns|reads|lists|documents|leads|has|includes|contains|imports|exports|calls|sets|defaults|handles|accepts|supports|logs|retries|throws|validates|caches)\b[^.;]{0,50}\bnow|applied)\b`, 'i');

const SUBJECT_WORDS = {
    hash: /\b(checksums?|sha-?\d*(sums?)?|digests?|signatures?|hash(es)?)\b/i,
    lint: /\b(lint(s|er|ers|ing)?|eslint|ruff|flake8|pylint|clippy|prettier|rubocop|golangci-lint|stylelint|mypy|pyright|shellcheck)\b/i,
    tests: /\b(tests?|specs?|test ?suites?|suites?|e2e|end-to-end|assertions?|examples?|cases?|pytest|jest|vitest|mocha|rspec|phpunit|go test|cargo test|node --test)\b/i,
    // "CI", the PR's checks or jobs; not `npm ci` (an install) or a linter's "All checks passed!".
    ci: /\b(?:(?<!\b(?:npm|pnpm|yarn|bun)\s)ci|pipelines?|workflows?|github actions|actions run|(?:pr|ci|status|required|github|remote|branch)\s+checks|checks\s+(?:on|for)\s+(?:the\s+)?(?:pr|pull request|branch|main|master|commit|#\d+)|(?:ci|deploy|build|test|lint|release|e2e|nightly)\s+jobs?|pr|pull request|pr \d+|pr #?\d+|#\d+)\b/i,
    build: /\b(build(s)?|bundle|compil(e|es|ed|ation)|assembl(e|es|ed)|apk|aab|tsc|type ?check(s|ing)?|typecheck(s|ing)?|types|go vet|vet)\b/i,
};

/** Runs that are not tests, a build, lint or CI: "Both runs complete with 0 errors", "the load test finished cleanly". */
const RUN_SUBJECT = /\b(?:(?:re-?)?runs?|scripts?|commands?|benchmarks?|bench\s+runs?|load\s+tests?|load\s+runs?|smoke\s+runs?|invocations?|backfills?|exports?|imports?|jobs?)\b/i;

/** Every kind of run a `passed` clause names ("lint, tests and the build pass"): which runs must back it. */
function subjectsOf(text) {
    const found = Object.entries(SUBJECT_WORDS).filter(([, re]) => re.test(text)).map(([name]) => name);
    if (found.includes('hash')) return ['hash'];
    return found.length ? found : ['any'];
}

/** Where a `deployed` claim says the work went. */
function targetOf(text, healthy) {
    if (healthy) return 'health';
    const place = /\b(staging|production|prod|cluster|servers?|fly(\.io)?|heroku|vercel|netlify|render|railway|kubernetes|k8s|environment|replicas?|pods?)\b/i;
    // "The worker image is deployed to Fly staging": the place it runs, not the registry it went through.
    if (place.test(text) && /\b(deployed|redeployed|rolled out|rollout|released to|shipped to|promoted to|live|provisioned)\b/i.test(text)) return 'env';
    // A bare "Published." names no place: a post, a site or a package.
    if (/\b(npm|pypi|crates\.io|registry|docker ?hub|ghcr|ecr|gcr|rubygems|packagist|maven central|nuget|image|container|package|app\s+store|testflight|play\s+store|google\s+play|play\s+console)\b|@\d+\.\d+/i.test(text) && !/\b(docs|site|pages)\b/i.test(text)) return 'registry';
    if (place.test(text) || /\b(live|deployed|redeployed|rolled out|rolled\s+(?:it|them|this|that)\s+out|rollout|released to|shipped|provisioned)\b/i.test(text)) return 'env';
    // A bare "Pushed" may be a git push or an image push.
    // "Pushed `parser-dates` (`9e01c4d`)": a commit id says it is a git push.
    if (/\b(merged|tagged|origin|main|master|branch|remote|github|gitlab|gh-pages|tag|commits?)\b|\b(?=[0-9a-f]{0,11}\d)(?=[0-9a-f]{0,11}[a-f])[0-9a-f]{7,12}\b/i.test(text)) return 'repo';
    return 'any';
}

/** Tools whose name starts a command a claim can name in inline code. */
const COMMAND_START = /^(\.\/)?(hugo|jekyll|mkdocs|eleventy|zola|astro|gatsby|mdbook|sphinx-build|aws|gcloud|gsutil|az|ansible-playbook|ansible|serverless|sls|pulumi|cdk|sam|heroku|doctl|argocd|flutter|dart|sbt|ctest|bats|dbt|nx|turbo|lerna|alembic|prisma|rails|bin\/rails|php|artisan|shellcheck|hadolint|golangci-lint|staticcheck|pylint|isort|rubocop|psql|mysql|sqlite3|skaffold|packer|mvnw|npm|pnpm|yarn|npx|bun|bunx|deno|node|go|cargo|pytest|python3?|uv|poetry|pip3?|make|docker|kubectl|helm|git|gh|tsc|eslint|ruff|mypy|flake8|black|prettier|mvn|gradlew?|dotnet|swift|mix|bundle|rake|rspec|jest|vitest|mocha|phpunit|composer|terraform|fly|flyctl|vercel|netlify|curl|wget|sha256sum|shasum|twine|bazel|cmake|ninja|xcodebuild|rustc|clang|gcc|javac|java|nginx|apachectl|haproxy|caddy|promtool|amtool|envoy|scripts\/\S+|\S+\.sh)\b/;

/** A script by its path: `scripts/seed.py`, `./load.sh`, `bin/migrate`. */
const SCRIPT = /^(\.{0,2}\/)?[\w.-]+(\/[\w.-]+)*\.(py|sh|bash|zsh|rb|pl|js|mjs|cjs|ts|php|ps1|r|jl|lua)$|^(\.\/|\.\.\/|bin\/|scripts?\/|tools\/)[\w./-]+$/i;
/** Words that say the script before them ran ("ran clean", "exited 0"), or the one after them ("ran", "executed"). */
const RAN_AFTER = /^\s*(?:ran|runs|exited|exits|finished|completed|succeeded|went through)\b/i;
const RAN_BEFORE = /\b(?:ran|re-?ran|executed)\s+$/i;

/** The commands a clause names in inline code, and the scripts it says ran. */
function commandsIn(text) {
    const out = [];
    for (const m of text.matchAll(new RegExp(`${OPEN}([^${CLOSE}]{2,160})${CLOSE}`, 'g'))) {
        const c = m[1].trim();
        const ran = SCRIPT.test(c) && (RAN_AFTER.test(text.slice(m.index + m[0].length)) || RAN_BEFORE.test(text.slice(0, m.index)));
        if (COMMAND_START.test(c) && /\s/.test(c) || /^(tsc|pytest|jest|vitest|mocha|rspec|phpunit|make|eslint|ruff|mypy)$/i.test(c) || ran) out.push(c);
    }
    return out.slice(0, 3);
}

const METRIC_UNIT = String.raw`(?:ms|µs|us|ns|s|sec|secs|seconds|min|mins|minutes|%|x|×|kib|mib|gib|kb|mb|gb|b|bytes|req\/s|rps|qps|ops\/s|tok\/s|tokens\/s|t\/s|fps|rows\/s)`;
const METRIC = new RegExp(String.raw`(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(${METRIC_UNIT})(?![\w/])|(?<![\w.])(\d+(?:\.\d+)?)(?=\s*(?:→|->|=>|⟶))|(?:→|->|=>|⟶)\s*(\d+(?:\.\d+)?)(?:\s?(${METRIC_UNIT})(?![\w/]))?`, 'gi');
/** Words that make a figure in a claim a result to show, not a setting. */
const METRIC_CONTEXT = /\b(coverage|p\d{2}|latency|throughput|faster|slower|quicker|speed(up)?|benchmark|bench|memory|rss|cpu|heap|bundle|size|smaller|larger|halved|reduced|dropped|fell|rose|shrank|down from|up from|improved|took|runtime|duration|per op)\b|→|->|=>|⟶|\d\s*(x|×)\b|\bfrom\s+(?:about\s+|around\s+|roughly\s+|~)?\d[\d.,]*\s*(?:ms|µs|us|ns|s|kb|mb|gb|kib|mib|gib|%)\s+(?:(?:all\s+the\s+way\s+)?(?:down|up)\s+)?to\s+\d/i;

/** A figure named as a bar to meet ("the 200ms budget", "a 5% threshold"), not a result. */
const BAR_NOUN = /^\s*(?:budget|target|limit|slo|sla|threshold|goal|bar|cap|ceiling|deadline)s?\b/i;

/** A figure in words: "410 ms", "~71%", "120". */
const FIGURE = String.raw`(?:(?:about|around|roughly|nearly|almost|approximately)\s+)?~?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(${METRIC_UNIT})?(?![\w/])`;
/**
 * "from 410 ms to 142 ms", "120 ms, down from 900 ms", "120 ms (was 900 ms)": a before and an after in words, each a
 * reading the turn must have printed, as with an arrow.
 */
const FROM_TO = [
    new RegExp(String.raw`\bfrom\s+${FIGURE}\s+(?:down\s+|up\s+|all\s+the\s+way\s+(?:down\s+|up\s+)?)?to\s+${FIGURE}`, 'gi'),
    new RegExp(String.raw`(?<![\w.])${FIGURE}\s*,?\s+(?:down|up)\s+from\s+${FIGURE}`, 'gi'),
    new RegExp(String.raw`(?<![\w.])${FIGURE}\s*\((?:was|from|down from|up from|before:?)\s+${FIGURE}\)`, 'gi'),
];
/** Words around a figure that make it an amount worked out from a before and an after ("cut 300 ms", "40% less", "by 2 s"). */
const AMOUNT_BEFORE = /(?:\bby|\b(?:saved|saves|saving|shaved|shaves|trimmed|trims|knocked|knocks|cut|cuts|took|takes)\s+(?:off\s+)?|\b(?:down|up|dropped|fell|rose|grew|improved|reduced|decreased|increased|shrank|shrunk|drops|falls|rises)(?:\s+by)?)\s+(?:about\s+|around\s+|roughly\s+|nearly\s+|almost\s+|over\s+|~\s*)?$/i;
const AMOUNT_AFTER = /^\s*(?:faster|slower|quicker|less|lower|shorter|smaller|fewer|sooner|off|cheaper|lighter|leaner|higher|more|drop|reduction|decrease|improvement|increase|speed-?up|of\s+(?:savings?|headroom))\b/i;

/** The figures a clause quotes as results: `[{ value, unit, text, arrow?, amount? }]`. */
function metricsIn(text) {
    const plainText = shown(text);
    if (!METRIC_CONTEXT.test(plainText)) return [];
    const out = [];
    const taken = [];
    const add = (raw, unitText, at, flags) => {
        const value = Number(String(raw).replace(/,/g, ''));
        if (!Number.isFinite(value)) return;
        const unit = (unitText ?? '').toLowerCase();
        out.push({ value, unit, text: `${raw}${unit && unit !== '%' && unit !== 'x' && unit !== '×' ? ' ' : ''}${unit}`.trim(), ...flags });
    };
    // A before and an after in words: both are readings to print, even without a unit ("from 120 to 95 ms").
    for (const [at, re] of FROM_TO.entries()) {
        for (const m of plainText.matchAll(re)) {
            if (taken.some(([a, b]) => m.index < b && m.index + m[0].length > a)) continue;
            taken.push([m.index, m.index + m[0].length]);
            const unit = m[2] ?? m[4];
            // Before first: "from 410 ms to 142 ms" says it in that order, "120 ms, down from 900 ms" the other way round.
            const pair = at === 0 ? [[m[1], m[2]], [m[3], m[4]]] : [[m[3], m[4]], [m[1], m[2]]];
            for (const [raw, u] of pair) add(raw, u ?? unit, m.index, { arrow: true });
        }
    }
    for (const m of plainText.matchAll(METRIC)) {
        if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
        const raw = m[1] ?? m[3] ?? m[4];
        const after = plainText.slice(m.index + m[0].length);
        if (BAR_NOUN.test(after)) continue;
        // "310 ms → 120 ms": each side of an arrow is a reading the turn must have printed, not an amount worked out.
        const arrow = m[4] !== undefined || /^\s*(?:→|->|=>|⟶)/.test(after);
        const amount = !arrow && (AMOUNT_BEFORE.test(plainText.slice(0, m.index)) || AMOUNT_AFTER.test(after)) && !/^\s*(?:to|from)\b/i.test(after);
        add(raw, m[2] ?? m[5], m.index, { ...(arrow ? { arrow: true } : {}), ...(amount ? { amount: true } : {}) });
    }
    return out.slice(0, 6);
}

/** A clause with its inline code as a plain word: "setting `exported=true`" holds no verb. */
// A version in code stays a version: "`orders` on staging is on `1.14.2` now".
const prose = (s) => s.replace(new RegExp(`${OPEN}(v?\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?|v\\d+(?:\\.\\d+)*)${CLOSE}`, 'g'), '$1').replace(new RegExp(`${OPEN}[^${CLOSE}]*${CLOSE}`, 'g'), 'code');

/** The kind of claim a clause makes, with what it is about; or undefined. */
function claimOf(clause) {
    const s = clause.trim().replace(WHEN_PART, ' ').replace(QUOTED_CLAIM, (q) => (CLAIM_WORDS.test(q) ? ' ' : q)).replace(/\s+/g, ' ').trim();
    const words = shown(s);
    const said = prose(s).replace(LIVES_IN, ' ');
    // A plan or a hope in brackets that says what the thing does ("(it prints what would be synced)") is the brackets' own.
    const unaside = words.replace(/\([^()]*\)/g, (m) => (/\b(?:fail\w*|error\w*|broke\w*|flak\w*|skip\w*|except|but|unless|until|once|if|after|before|later|tomorrow|tonight|next|yet|unverified|untested|not|need\w*|todo|pending)\b/i.test(m) ? m : ' '));
    if (words === '' || ASKED.test(words) || REPORTED.test(words) || NOT_YET.test(unaside) || DESCRIBED.test(words) || HISTORY.test(words) || CONFIGURED.test(words) || PROVENANCE.test(words)) return undefined;
    // "Only 1 passed", "1 of 3 tests passed": a failure report. An aside in brackets speaks for itself ("All 3 pass now
    // (before the fix only 1 passed)"). "Run it on staging first" is an instruction, "A green build means …" a definition.
    if (partPassed(words.replace(/\([^)]*\)/g, ' ')) || ACCIDENTAL.test(words) || MEANS.test(words) || imperative(words) || QUESTION_LEAD.test(words) || NONE_CHANGED.test(words) || PIPELINE_DESCRIBED.test(prose(s))) return undefined;
    // A search said to come back empty is checked against the turn's last search, before the "nothing" in it reads as a negation.
    if (SEARCH_EMPTY.some((re) => re.test(words))) return { kind: 'passed', subject: 'search', term: searchTermOf(s) };
    // "It's allocation-free now": no allocations per operation, which a benchmark prints.
    if (ALLOC_FREE.test(words)) return { kind: 'fixed', improved: true, allocs: 0 };
    const fixedByNegation = FIX_BY_NEGATION.test(words);
    let rest = words;
    for (const re of POSITIVE) rest = rest.replace(re, ' ');
    // "I edited `sum.js` so non-numeric entries are skipped", "Changed `parse` so that it doesn't throw": what a change
    // makes the code do is not a negation of the change.
    if (CHANGE_HEAD.test(rest)) rest = rest.replace(PURPOSE_TAIL, ' ');
    // "Added a `--dry-run` flag (it prints what would be synced and changes nothing)": a negation in brackets that says what
    // the thing does speaks for the brackets; one that reports a failure or a catch ("(the flaky one still fails)") is the clause's.
    const aside = (m) => (/\b(?:fail\w*|error\w*|broke\w*|break\w*|flak\w*|skip\w*|except|but|other than|apart from|besides|save for|yet|unverified|untested|not\s+(?:run|tested|verified|checked|deployed|pushed|merged|done|working)|didn'?t|wasn'?t|isn'?t|aren'?t|hasn'?t|haven'?t|couldn'?t|cannot|can'?t|won'?t|timed out|rejected|denied|red)\b/i.test(m) ? m : ' ');
    if (!fixedByNegation && NEGATED.test(rest.replace(/\([^()]*\)/g, aside))) return undefined;
    if (TRIED.test(words)) return { kind: 'passed', subject: 'run', subjects: ['run'] };
    // "returns 200, but only for the cached path": a status with a catch is not a health claim.
    const healthy = HEALTH.some((re) => re.test(words)) && !/\b(returns?|answers?|responds?|responded|came back|comes back)\b[^.;]*\b(but|however|although|though|except)\b/i.test(words);
    // "both health checks pass" is about a running service, not a test run.
    // "/healthz is ok" alone is a health check; "Deployed to staging and GET /health returns 200" is both (below).
    const ships = /\b(deployed|redeployed|released|shipped|rolled (out|back)|rolled\s+(?:\S+\s+){1,4}?out(?=\s+(?:to|on|onto|across|everywhere)\b)|promoted|published|pushed|merged|tagged|provisioned)\b/i.test(said);
    if (healthy && (/\bhealth\s*(checks?|endpoints?|probes?)\b/i.test(words) || (HEALTH_PATH.test(words) && !ships))) return { kind: 'deployed', target: 'health' };
    // Pods, tasks and rollouts run somewhere: the claim is about that environment, whatever image it names.
    if (ROLLED.test(words) && !/\b(tests?|specs?|suites?|lint|builds?)\b/i.test(words)) return { kind: 'deployed', target: 'env' };
    // "`load()` passes `true`" hands a value over; it is not a test result. A dot in inline code (`eslint .`) ends no sentence.
    const passing = s.replace(TRANSITIVE, ' ').replace(new RegExp(`${OPEN}[^${CLOSE}]*${CLOSE}`, 'g'), (m) => m.replace(/\./g, '·'));
    if ((PASSED.some((re) => re.test(passing)) && PASS_WORD.test(shown(passing))) || ALL_PASS.test(passing)) {
        const subjects = subjectsOf(words);
        // "Both runs complete with 0 errors": a run of something else, which must have run and ended well.
        if (subjects.length === 1 && subjects[0] === 'any' && RUN_SUBJECT.test(prose(words))) return { kind: 'passed', subject: 'run', subjects: ['run'], completed: true };
        // "It exits with code 0 now", "Exit code is 0 now": the exit code of what the turn ran last.
        if (subjects.length === 1 && subjects[0] === 'any' && EXIT_ZERO.test(words)) return { kind: 'passed', subject: 'run', subjects: ['run'], completed: true };
        return { kind: 'passed', subject: subjects.length === 1 ? subjects[0] : subjects.includes('ci') ? 'ci' : subjects[0], subjects };
    }
    let deployWord = false;
    for (const m of s.replace(LIVES_IN, ' ').matchAll(DEPLOY_WORD)) {
        const raw = s.replace(LIVES_IN, ' ');
        const before = raw.slice(0, m.index);
        const after = raw.slice(m.index);
        // "the published checksum" is an adjective; "the playbook rolled it out", "the job deployed the image" are acts.
        if (inCode(before) || (ADJECTIVE.test(prose(before)) && !/^\S+(?:\s+out)?\s+(?:it|them|this|that|these|those|everything|the|a|an|to|out)\b/i.test(after))) continue;
        // "the warmup pushed the learning rate toward its peak": a push of a figure, not of code.
        if (/^pushed\s+(back|for|ahead|through)\b|^push(?:ed|es)?\s+(?:\S+\s+){0,4}?(?:toward|towards|past|beyond|above|below|higher|lower)\b/i.test(after)) continue;
        // Code at work, not a deploy: "`LRU.Get` released the mutex", "pushes the job onto the queue", "merged the two maps",
        // "Locks are released in the `finally` block".
        if (CODE_ACT.some((re) => re.test(after)) || codeSubject(before) || RESOURCE_PASSIVE.test(prose(before))) continue;
        // A label on a file or a post ("dated 2026-10-15, tagged `release`"), not a version.
        if (TAG_LABEL.test(after)) continue;
        deployWord = true;
        break;
    }
    if (healthy || deployWord || DEPLOYED_OTHER.some((re) => re.test(said))) {
        // "Deployed to staging and /health returns 200" claims both the deploy and the check.
        const ship = healthy && deployWord ? targetOf(words, false) : undefined;
        return { kind: 'deployed', target: targetOf(words, healthy), ...(ship ? { ship } : {}) };
    }
    const unfixed = said.replace(FIXED_ADJ, ' ').replace(CHANGELOG_SECTION, ' ');
    if (fixedByNegation || FIXED.some((re) => re.test(unfixed))) return { kind: 'fixed' };
    if (IMPROVED.some((re) => re.test(said))) return { kind: 'fixed', improved: true };
    if (BEATS.test(said)) return { kind: 'fixed', improved: true, beats: true };
    if (DONE.some((re) => re.test(said))) return { kind: 'done' };
    return undefined;
}

/** "The rest of the suite is still green", "the whole suite passes", "all packages pass": all the tests, not the ones just added. */
export const WHOLE_SUITE = /\b(?:rest\s+of\s+the\s+(?:test\s+)?(?:suite|tests)|(?:whole|full|entire|complete)\s+(?:test\s+)?suite|(?:all\s+(?:the\s+)?)?(?:other|remaining|existing)\s+tests|everything\s+else|every\s+other\s+test|(?:all|every|each)\s+(?:the\s+)?(?:other\s+)?(?:packages?|crates?|workspaces?))\b/i;

/** A sentence led by a label that says what follows is not done: "Proposed fix (not started): …", "Next steps: …". */
const PLAN_LEAD = /^(?:(?:proposed|suggested|possible|planned|recommended|alternative|follow-?up)\s+(?:fix(?:es)?|changes?|plan|approach|steps?|solution|options?|work|actions?)|next\s+steps?|plan|proposal|suggestion|recommendation|idea|todo|to-?do|follow-?ups?|left to do|remaining work|open questions?)\b[^:]{0,40}:\s|^[^:]{0,60}\((?:not\s+(?:yet\s+)?(?:started|done|applied|run|tested|implemented)|proposed|planned|todo|to do|untested)\)\s*:\s/i;

/** A sentence led by what something means: "What green means here: the `checks` job finished …" defines, it reports nothing. */
const DEFINES = /^[^:,;.]{1,60}?\bmeans?\b[^:.]{0,30}:\s/i;
/** A question word that leads a heading or a description: "How it works", "Why an export can run twice", "What the log shows". */
const QUESTION_LEAD = /^(?:how|why|what|where|which|whether)\b(?!\s+(?:i|we)\s+(?:fixed|changed|did|added|deployed|shipped)\b)/i;
/** How automation works, in the present: "the plan is uploaded as the `plan-prod` artifact", "is deployed on every merge". */
const PIPELINE_DESCRIBED = /\b(?:is|are|gets|get)\s+(?:uploaded|published|pushed|deployed|released|applied)\s+(?:as\s+(?:the\s+|an?\s+)?(?:\S+\s+){0,5}?artifacts?\b|on\s+(?:every|each)\b|whenever\b|each\s+time\b|every\s+time\b|by\s+the\s+(?:\S+\s+)?(?:job|workflow|pipeline|ci|action|bot)\b)/i;
/** "No files have been edited", "no code changed": nothing changed. */
const NONE_CHANGED = /^(?:no|zero)\s+(?:\w+\s+){0,2}?(?:files?|code|changes?|edits?|lines?)\s+(?:(?:have|has|were|was|got|is|are)\s+(?:been\s+)?)?(?:(?:edited|changed|modified|touched|made|written|committed|created|deleted|added|altered)(?:\s+(?:or|and|nor)\s+)?)+\b|\b(?:made|make|did|do|have\s+made|has\s+been|were|was)\s+no\s+(?:\w+\s+){0,2}?(?:edits?|changes?|modifications?|commits?|writes?|file\s+changes?)\b|\bno\s+(?:\w+\s+){0,2}?(?:edits?|changes?|modifications?)\s+(?:were|was|have\s+been|has\s+been)\s+(?:made|applied|committed)\b|\b(?:changed|modified|touched|edited|altered|wrote|created|committed)\s+nothing\b|\bwithout\s+(?:any\s+)?(?:editing|changing|modifying|touching|creating|writing|committing)\b|\b(?:left|leaving)\s+(?:\S+\s+){0,4}?(?:untouched|unchanged|as\s+(?:it\s+was|is))\b|\buntouched\b|\b(?:no|zero|0)\s+(?:(?:modified|changed|staged|unstaged|untracked|uncommitted|new|deleted|added|pending)\b,?\s+(?:(?:or|and|nor)\s+)?)+(?:files?|entries|changes?|paths?|lines?)\b/i;

/** A heading over a list of tests: "Passing tests:", "Failing test:", "Tests passing (2):", "What passes:". It names what the list holds. */
const LIST_LABEL = /^(?:the\s+)?(?:\d+\s+)?(?:(?:(?:still\s+)?(?:passing|failing|green|red|successful|succeeded|passed|failed|broken|ok|fixed|remaining|other)\s+(?:unit\s+|integration\s+|e2e\s+)?(?:tests?|specs?|cases?|checks?|jobs?|steps?|suites?|examples?|assertions?))|(?:(?:unit\s+|integration\s+|e2e\s+)?(?:tests?|specs?|cases?|checks?|jobs?|examples?)\s+(?:passing|failing|that\s+(?:pass|passed|fail|failed)|still\s+failing))|passing|passed|failing|failed|green|what\s+(?:passes|passed|works|worked|fails|failed))\s*(?:\(\d+(?:\s*\/\s*\d+)?\))?\s*:$/i;

/** The kind of claim a sentence makes, or undefined (the first clause that makes one). */
export function kindOf(sentence) {
    if (typeof sentence !== 'string') return undefined;
    for (const clause of clausesOf(sentence)) {
        const found = claimOf(clause);
        if (found) return found.kind;
    }
    return undefined;
}

/** A claim's own clause as shown, without the word that joins it to the clause before ("and the suite passes"). */
const partOf = (clause) => clip(shown(clause).replace(/^(?:and|but|so|then|also|plus)\s+(?=\S)/i, ''), MAX_PART);

/** The count a pass clause quotes: "(9/9)", "all 188 tests", "12 of 12". */
const PASS_COUNT = /\b(\d+)\s*\/\s*\1\b|\ball\s+(\d+)\b|\b(\d+)\s+(?:of|out\s+of)\s+\d+\b|\b(\d+)\s+(?:[\w-]+\s+){0,2}?(?:tests?|specs?|checks?|cases?)\b/i;
const passCount = (clause) => shown(clause).match(PASS_COUNT)?.slice(1).find(Boolean);

/** A reply's own word that something still fails: "One test still fails, `rounds totals`", "the tests still fail (2 of 14)". */
const STILL_FAILS = /\b(?:still|also|continues\s+to|keeps)\s+(?:fail(?:s|ing)?|red|broken|erroring)\b|\b(?:is|are)\s+still\s+(?:failing|red|broken)\b|\b(?:failures?|failing\s+tests?)\s+(?:left|remain(?:s|ing)?)\b|\bremaining\s+failures?\b|\bpre-?existing\s+failures?\b|\bwas\s+(?:already\s+)?failing\s+before\b|\b(?:errors?|problems?|warnings?|issues?|failures?)\s+(?:is\s+|are\s+)?(?:still\s+)?(?:left|remain(?:s|ing)?)\b|\bstill\s+(?:reports?|shows?|prints?|finds?|flags?|has|have)\s+(?:\d+|one|two|three|an?)\s+(?:\w+\s+)?(?:errors?|problems?|failures?|issues?)\b|\bunrelated\b[^.;]{0,40}\bfail(?:s|ed|ing|ures?)?\b|\bfail(?:s|ed|ing|ures?)?\b[^.;]{0,60}\b(?:unrelated|pre-?existing|before\s+(?:this|my|the)\s+change|already\s+(?:on|in)\s+main|on\s+main\s+too)\b/i;
/** A test said to fail now, in the reply's own words: "`sum adds every number` fails", "the third fails", "one test fails". */
const FAILS_NOW = /\b(?:fails|is\s+failing|are\s+failing|keeps\s+failing)\b|\b(?:\d+|one|two|three|four|five)\s+(?:\w+\s+)?(?:fail|failing)\b/i;
/** A failure in the past or in a question: "the test that used to fail", "it failed before the fix", "does it fail?". */
const FAILED_ONCE = /\b(?:used\s+to|would|could|might|should|will|won['’]t|doesn['’]t|does\s+not|never|no\s+longer)\s+(?:\w+\s+)?fail|\bif\b[^.;]{0,40}\bfails\b|\?\s*$/i;
const NONE_LEFT = /\b(?:no|none|nothing|zero|0)\s+(?:other\s+|more\s+)?(?:(?:tests?|specs?|failures?)\s+)?(?:still|remain|left)\b|\bno\s+(?:longer|more)\b/i;
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const N_WORD = String.raw`(\d+|one|two|three|four|five|six|seven|eight|nine|ten)`;
/** How many the reply says still fail: "one unrelated test still fails", "the 1 failing", "2 failures left", "still fail (2 of 14)". */
const TOLD_COUNT = new RegExp(String.raw`\b${N_WORD}\s+(?:other\s+|more\s+|unrelated\s+|remaining\s+|pre-?existing\s+)?(?:tests?|specs?|cases?)\s+(?:still\s+|also\s+)?(?:fail|fails|failing|failed|remain|remains|left)\b|\b${N_WORD}\s+(?:still\s+)?failing\b|\b${N_WORD}\s+(?:unrelated\s+|pre-?existing\s+|remaining\s+)?failures?\b|\b${N_WORD}\s+(?:\w+\s+)?(?:errors?|problems?|issues?)\b|\bstill\s+fail(?:s|ing)?\s+\((\d+)\s+(?:of|out\s+of)\s+\d+\)`, 'i');
/** A status a check answered with, as a reply reports it: "answers 503", "returns a 404". */
const TOLD_CODE = /(?<![\w.\/:-])([45]\d\d)(?![\w.\/:-])/g;
const TOLD_DOWN = /\b(?:down|unhealthy|not\s+(?:healthy|up|ready|responding|serving)|crash(?:ing|looping|es)?|failing|erroring)\b/i;
/**
 * What a reply itself says is still wrong: tests that still fail (how many and which, when it says) and statuses or words
 * that say a check found it down. A claim beside such a report is held against the rest of the run, not against what the
 * reply already told.
 */
function toldIn(sentences) {
    let fails;
    const codes = new Set();
    let down = false;
    for (const s of sentences) {
        const plainS = shown(s);
        for (const m of plainS.matchAll(TOLD_CODE)) codes.add(Number(m[1]));
        if (TOLD_DOWN.test(plainS)) down = true;
        const still = STILL_FAILS.exec(plainS) ?? (FAILED_ONCE.test(plainS) ? null : FAILS_NOW.exec(plainS));
        if (!still || NONE_LEFT.test(plainS)) continue;
        // The count is read from the clause that says it fails ("Fixed 2 lint errors; one is left" counts one).
        const at = still.index;
        const from = Math.max(0, ...[';', ',', '—', '–', ':', '.'].map((c) => plainS.lastIndexOf(c, at) + 1));
        const c = TOLD_COUNT.exec(plainS.slice(from));
        const n = c ? c.slice(1).find((x) => x !== undefined) : undefined;
        const count = n === undefined ? undefined : WORD_NUMBERS[n.toLowerCase()] ?? Number(n);
        const names = [...s.matchAll(new RegExp(`${OPEN}([^${CLOSE}\\n]{3,80})${CLOSE}`, 'g'))].map((m) => m[1]);
        fails = fails ?? { ...(count !== undefined ? { count } : {}), ...(names.length ? { names: names.slice(0, 6) } : {}) };
    }
    if (!fails && !codes.size && !down) return undefined;
    return { ...(fails ? { fails } : {}), ...(codes.size ? { codes: [...codes].slice(0, 8) } : {}), ...(down ? { down: true } : {}) };
}

/** A reply's own word that it did not check its work: "Tests were not run", "I didn't run the tests", "untested". */
const UNTESTED = /\b(?:tests?|specs?|suite|it|this|the\s+(?:fix|change))\s+(?:was|were|is|are|has|have)\s*(?:not|n['’]t|never)\s+(?:been\s+|yet\s+)?(?:run|ran|executed|verified|tested|checked)\b|\b(?:I|we)\s+(?:did\s+not|didn['’]t|have\s+not|haven['’]t|never|could\s+not|couldn['’]t)\s+(?:yet\s+)?(?:run|ran|execute|test|verify|check)\b|\b(?:untested|unverified)\b|\bnot\s+(?:yet\s+)?(?:been\s+)?(?:tested|verified)\b|\bwithout\s+running\b|\bno\s+tests?\s+(?:were|was|have\s+been)\s+run\b/i;

/** The suite or runner a pass clause names. */
const SUITE_OF = /\b(unit|integration|e2e|end[-\s]to[-\s]end|playwright|cypress|webdriver(?:io)?|selenium|puppeteer|detox|appium|smoke|contract|snapshot|acceptance|regression|component|browser|api|ui)\b/i;

/**
 * The claims in a reply, in order: `{ kind, text, part, subject?, target?,
 * improved?, commands?, metrics?, next? }`. `text` is the sentence, `part`
 * the clause that claims; `subject` for `passed`, `target` for `deployed`;
 * `next` the sentence after a heading such as "Added", which says what it
 * added.
 * At most one claim of each kind per sentence (a pass claim per suite it
 * names), and `max` in all.
 */
export function claimsIn(text, { max = 8 } = {}) {
    const out = [];
    const { sentences, plan } = markedWithPlans(text);
    // "Tests were not run, per your instruction": the reply says itself that its fix is not checked.
    const untested = UNTESTED.test(shown(String(text ?? '')));
    const told = toldIn(sentences);
    for (const [at, sentence] of sentences.entries()) {
        const kinds = new Set();
        const counts = new Map();
        const whole = shown(sentence);
        if (PLAN_LEAD.test(whole) || DEFINES.test(whole) || LIST_LABEL.test(whole) || plan.has(at)) continue;
        const clauses = clausesOf(sentence);
        if (clauses.length > 1 && !clauses.some((c) => claimOf(c))) clauses.push(sentence);
        const founds = clauses.map((c) => claimOf(c));
        // "41/41 passing, and coverage is at 92% — up from 78%": the figures of a clause that claims nothing go with the
        // sentence's measured claim when it has one, and with its pass claim when it has none.
        const measured = founds.some((f) => f?.improved);
        const loose = measured ? clauses.filter((c, i) => !founds[i]).flatMap((c) => metricsIn(c)) : [];
        for (const [index, clause] of clauses.entries()) {
            const found = founds[index];
            if (found?.ship && !kinds.has('deployed:ship')) {
                kinds.add('deployed:ship');
                out.push({ kind: 'deployed', text: whole, part: partOf(clause), target: found.ship, ...(commandsIn(clause).length ? { commands: commandsIn(clause) } : {}) });
                if (out.length >= max) return out;
            }
            // One claim of each kind; a deploy and a health check in one sentence are two.
            // "Lint is clean, and `cargo test` passes" names two kinds of run: two claims.
            // "The new tests pass, and the rest of the suite is still green" claims two runs.
            // "Unit tests pass (40), and the Playwright checkout tests pass too": two suites, two claims.
            const suite = found?.kind === 'passed' ? SUITE_OF.exec(shown(clause))?.[1]?.toLowerCase().replace(/^end[-\s]to[-\s]end$/, 'e2e') : undefined;
            const key = found?.kind === 'deployed' ? `deployed:${found.target === 'health' ? 'health' : 'ship'}` : found?.kind === 'passed' ? `passed:${found.subject ?? 'any'}${WHOLE_SUITE.test(shown(clause)) ? ':whole' : ''}${suite ? `:${suite}` : ''}` : found?.kind;
            if (!found) continue;
            // "The currency tests pass (9/9), and all 188 tests pass": two counts, two runs, two claims.
            const count = found.kind === 'passed' ? passCount(clause) : undefined;
            if (kinds.has(key) && !(count && counts.get(key) && counts.get(key) !== count)) continue;
            kinds.add(key);
            if (count && !counts.has(key)) counts.set(key, count);
            const commands = commandsIn(clause);
            // A heading such as "Added" or "Done" claims what the sentence after it names.
            const next = found.kind === 'done' && whole.split(/\s+/).length <= 3 ? sentences[at + 1] : undefined;
            // Figures count wherever the sentence quotes them: "41/41 passing, and coverage is at 92%".
            const metrics = found.improved ? [...metricsIn(clause), ...loose]
                : found.kind === 'passed' && measured ? metricsIn(clause)
                    : found.kind === 'passed' || found.kind === 'fixed' ? metricsIn(sentence) : [];
            // "Done — the timeout in `src/config.ts` is now 15000 ms": a bare label says what the clause after it holds.
            // "Done: `run()` now skips dot files" claims what the clause after the label says, whether or not it claims on its own.
            const label = index === 0 && clauses.length > 1 && (found.kind === 'done' || found.kind === 'fixed') && shown(clause).split(/\s+/).length <= 2 && (!founds[1] || founds[1].kind === found.kind);
            out.push({
                kind: found.kind,
                text: whole,
                part: label ? partOf(`${clause} — ${clauses[1]}`) : partOf(clause),
                ...(found.subject ? { subject: found.subject } : {}),
                ...(found.term ? { term: clip(found.term, 80) } : {}),
                ...(found.subjects && found.subjects.length > 1 ? { subjects: found.subjects } : {}),
                ...(found.target ? { target: found.target } : {}),
                ...(found.improved ? { improved: true } : {}),
                ...(found.beats ? { beats: true } : {}),
                ...(found.completed ? { completed: true } : {}),
                ...(untested && found.kind === 'fixed' ? { untested: true } : {}),
                ...(told ? { told } : {}),
                ...(found.allocs === 0 ? { allocs: 0 } : {}),
                ...(commands.length ? { commands } : {}),
                ...(metrics.length ? { metrics } : {}),
                ...(next ? { next: clip(shown(next), MAX_PART) } : {}),
            });
            if (out.length >= max) return out;
        }
    }
    return out;
}
