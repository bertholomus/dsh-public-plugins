/**
 * Words for Canon's search: one way to cut text into terms, used for the
 * notes and for the prompts, so a note's "Deploying" meets a prompt's
 * "deploys". Light stemming, and stop words that include the filler of a
 * chat ("thanks", "looks good", "please carry on"), so a prompt that asks
 * nothing finds nothing.
 *
 * @module dsh-plugin-canon/text
 */

/**
 * Words that say nothing about what a note or a prompt is about ("called"
 * and "named" only name a thing: "what is the mascot called?").
 */
export const STOP = new Set(`
a about above after again against all almost also am an and another any anyone anything anyway are aren around as at
away back be because been before being below between both but by can cannot could couldn did didn do does doesn doing
don done down during each either else enough etc even ever every few for from further get gets getting give given go
goes going gone got had has hasn have haven having he her here hers herself him himself his how however i if in into is
isn it its itself just keep kind know last least let lets like likely made make makes many may maybe me might mine more
most much must my myself need needs neither never new next no nor not now of off often oh ok okay on once one only onto
or other others our ours ourselves out over per perhaps please pretty quite rather re really right said same say
says see seem seems shall she should shouldn show since so some something sometimes soon still such sure take tell than
thank thanks thats the their theirs them themselves then there these they thing things think this those though through
thus to too try trying two under until up upon us use used uses using very via want wants was wasn way we well were
weren what whatever when where whether which while who whom whose why will with within without won would wouldn yeah
yes yet you your yours yourself yourselves
hi hello hey thx ty cool nice great good fine awesome perfect looks look looking sounds sound ahead carry continue
proceed lgtm sorry wait hmm hm ah ugh anyway also again stuff bit lot lots really actually basically just
called named that although unless already always usually none nothing everything someone everyone somebody anybody
everybody less
`.split(/\s+/).filter(Boolean));

/**
 * A word's stem: plural and verb endings off, "-ation" cut to its verb,
 * and a last "e" off longer words, so forms of one word meet ("rotate",
 * "rotated", "rotating", "rotation" → "rotat"; "stores", "stored" →
 * "stor"; "moving", "move" → "move"; "authenticate", "Authentication" →
 * "authenticat"). Numbers stay as they are, but for a plural's "s"
 * ("429s" → "429").
 */
export function stem(word) {
    let w = word;
    if (/^\d{3,}s$/.test(w)) return w.slice(0, -1);
    if (w.length <= 3 || /\d/.test(w)) return w;
    if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
    else if (/(?:ss|sh|ch|x|z)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
    else if (w.endsWith('s') && !/(?:ss|us|is|ous)$/.test(w)) w = w.slice(0, -1);
    if (w.endsWith('ing') && w.length - 3 >= 4) w = undouble(w.slice(0, -3));
    else if (w.endsWith('ing') && w.length === 6) w = shortRoot(w.slice(0, -3), w);
    else if (w.endsWith('ed') && w.length - 2 >= 4) w = undouble(w.slice(0, -2));
    else if (w.endsWith('ed') && w.length === 5) w = shortRoot(w.slice(0, -2), w);
    else if (w.endsWith('ly') && w.length > 5) w = w.slice(0, -2);
    else if (w.endsWith('ation') && w.length >= 8) w = w.slice(0, -3);
    if (w.endsWith('e') && w.length >= 5) w = w.slice(0, -1);
    return w;
}

/**
 * The word a root of three letters comes from: "mov" of "moving" and "hir"
 * of "hired" lost an "e"; "fix", "say" and "add", "ask" are whole; any other
 * ("str" of "string") was no root, and the word stays as it was.
 */
function shortRoot(root, word) {
    if (/^[b-df-hj-np-tv-z][aeiou][b-df-hj-np-tvz]$/.test(root)) return `${root}e`;
    if (/^[b-df-hj-np-tv-z][aeiou][wxy]$/.test(root) || /^[aeiou][b-df-hj-np-tv-z]{2}$/.test(root)) return root;
    return word;
}

/** "runn" → "run", "stopp" → "stop"; "fall" and "pass" keep theirs. */
function undouble(w) {
    return /([b-df-hj-np-tv-z])\1$/.test(w) && !/(?:ll|ss|zz|ff)$/.test(w) ? w.slice(0, -1) : w;
}

/**
 * Short forms people write for words notes spell out, and the reverse:
 * read as the whole word, in notes and prompts alike, so "certs" meets
 * "certificates", "DB" meets "database" and "auth" meets "Authentication".
 */
export const SHORT_FORMS = Object.freeze(Object.fromEntries(Object.entries({
    authentication: 'auth authn',
    authorization: 'authz',
    certificate: 'cert certs',
    configuration: 'config configs cfg conf',
    database: 'db dbs',
    dependency: 'dep deps',
    documentation: 'docs',
    environment: 'env envs',
    error: 'err errs',
    function: 'func fn',
    implementation: 'impl',
    information: 'info',
    kubernetes: 'k8s',
    infrastructure: 'infra',
    library: 'lib libs',
    message: 'msg msgs',
    millisecond: 'ms msec',
    operations: 'ops',
    package: 'pkg pkgs',
    performance: 'perf',
    production: 'prod',
    repository: 'repo repos',
    request: 'req reqs',
    response: 'resp',
    second: 'secs',
    minute: 'mins',
    tls: 'ssl',
}).flatMap(([word, shorts]) => shorts.split(' ').map((short) => [short, word]))));

/**
 * Words people use for what notes call by another name, common in
 * operations, read as the note's word (in notes and prompts alike, as short
 * forms are): "revert" and "undo" a release are rolling it back, "reboot"
 * is restart, "RAM" memory, "TTL" expiry, "handoff" handover, a "dump" a
 * backup, a CI "runner" a build agent, "storage" disk.
 */
export const OTHER_WORDS = Object.freeze(Object.fromEntries(Object.entries({
    roll: 'revert reverting reverted undo',
    restart: 'reboot rebooting rebooted bounce bouncing bounced',
    memory: 'ram',
    expire: 'ttl ttls',
    hand: 'handoff handoffs',
    backup: 'dump dumps snapshot snapshots',
    agent: 'runner runners',
    disk: 'storage',
    door: 'entrance',
    owner: 'responsible maintainer maintainers',
    flush: 'nuke nuking nuked wipe wiping wiped',
}).flatMap(([word, others]) => others.split(' ').map((other) => [other, word]))));

/**
 * Phrases people use for what notes call by one word, read as that word
 * (in notes and prompts alike): putting a new version out is deploying it
 * ("go live", "get this live", "push it live", "roll it out", "a rollout",
 * "ship a new build", "ship it to prod");
 * "who looks after" a project is its owner. "Routes live in routes.yaml"
 * is no deploy: "live" is one only after go, get, push, put or make, and
 * only where it ends the phrase.
 */
const PHRASES = Object.freeze([
    [/\b(?:go|goes|going|gone|went)[\s-]+live\b/gi, ' deploy '],
    // "Get a new version of this live", "push it live to prod"; not "make the live config", not "get it from where they live".
    [/\b(?:get|gets|getting|got|push|pushes|pushed|pushing|put|puts|putting|make|makes|making)\s+((?:(?!(?:where|which|who|when|while|if|because|we|you|they|i|he|she)\b)[\w.-]+\s+){0,6})live(?=\s*$|\s*[.?!,;:)]|\s+(?:to|on|in|for|before|after|without|with|by|so|and|but|or|then|once|this|next|today|tonight|tomorrow|now|again|soon|safely|quickly|please|asap|first)\b)/gi, (_, what) => ` deploy ${what} `],
    [/\broll(?:s|ed|ing)?\s+(?:(?:it|this|that|them)\s+)?out\b/gi, ' deploy '],
    [/\brollouts?\b/gi, ' deploy '],
    // "Ship a new build", "ship this fix", "ship it to prod": deploying; "once v2 ships" says when, not how.
    [/\bship(?:s|ped|ping)?(?=\s+(?:(?:a|an|the|this|that|it|our|my|new|next)\s+){0,3}(?:build|version|release|image|change|fix|update)s?\b|\s+(?:it|this|that|them)\s+(?:to|out|live)\b)/gi, 'deploy'],
    [/\blooks?\s+after\b|\blooking\s+after\b/gi, ' owner '],
]);

/** A text with PHRASES read as their one word. */
const phrased = (text) => PHRASES.reduce((t, [re, word]) => t.replace(re, word), text);

/** Short forms and other words, each read as the note's word. */
const READ_AS = Object.freeze({ ...SHORT_FORMS, ...OTHER_WORDS });

const SPLIT = /[^\p{L}\p{N}]+/u;
const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/**
 * The terms of a text, in order, repeats kept: lower case, stemmed, stop
 * words and one-letter words dropped; a camelCase word also gives its parts.
 * @param {string} text
 * @param {{ max?: number }} [options] - stop after this many terms.
 */
export function terms(text, { max = Infinity } = {}) {
    const out = [];
    if (typeof text !== 'string' || text === '') return out;
    for (const raw of phrased(text).split(SPLIT)) {
        if (raw === '') continue;
        const parts = raw.length > 3 && CAMEL.test(raw) ? [raw, ...raw.split(CAMEL)] : [raw];
        for (const part of parts) {
            const lower = READ_AS[part.toLowerCase()] ?? part.toLowerCase();
            if (lower.length < 2 || lower.length > 40 || STOP.has(lower)) continue;
            if (/^\d+$/.test(lower) && lower.length < 2) continue;
            const s = stem(lower);
            if (s.length < 2 || STOP.has(s)) continue;
            out.push(s);
            if (out.length >= max) return out;
        }
    }
    return out;
}

/** The distinct terms of a text, in first-seen order. */
export function distinctTerms(text, options) {
    return [...new Set(terms(text, options))];
}

/**
 * Words about the vault itself and about answering from it ("answer from
 * the team's shared notes and cite the note", "is it in the canon vault?"),
 * as terms: they say where to look and how to answer, not what about, so a
 * prompt's are left out (a note may still use them). "Team" is one of them
 * only just before one of these ("the team's shared notes"): "When is team
 * lunch?" asks about the team.
 */
export const ABOUT_THE_VAULT = new Set(['note', 'vault', 'canon', 'shar', 'answer', 'cite', 'cited', 'citation', 'reply', 'repli']);
const BEFORE_THE_VAULT = new Set(['team']);

/**
 * The words of a text as a person wrote them, by their term: the first
 * word that gave each term, in lower case ("rotating" for "rotat"), so the
 * page shows words, never stems.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function wordsOf(text) {
    const out = new Map();
    if (typeof text !== 'string' || text === '') return out;
    for (const raw of phrased(text).split(SPLIT)) {
        if (raw === '') continue;
        const parts = raw.length > 3 && CAMEL.test(raw) ? [raw, ...raw.split(CAMEL)] : [raw];
        for (const part of parts) {
            const lower = part.toLowerCase();
            const whole = READ_AS[lower] ?? lower;
            if (whole.length < 2 || whole.length > 40 || STOP.has(whole)) continue;
            const s = stem(whole);
            if (s.length < 2 || STOP.has(s) || out.has(s)) continue;
            out.set(s, lower);
        }
    }
    return out;
}

/**
 * Everyday request words, as terms: what a coding request asks to do
 * ("write", "add", "fix", "test", "check", "run"), the parts of code it
 * names ("function", "file", "script", "regex") and how big or good
 * ("small", "simple", "faster"). They say what to do, not what about, so
 * a note never fits a prompt on them alone (search.js): a coding request
 * leaves them out of the words in common (they still weigh in what it
 * asks), and a question needs a word beyond them.
 */
export const EVERYDAY = new Set(`
add adds added adding write writes wrote written writing create make set setup fix fixes fixed fixing update change
save saved modify edit remove delete rename refactor rewrite convert generate implement run runs ran running check
test explain describe mean means meant meaning help improve optimize split format print return handle parse validate
debug translate upgrade bump
function method class file script code line snippet program module component helper util utility variable parameter
argument value string number list array object type regex loop condition statement spec unit bug issue exception
warning comment doc docs readme import package library folder directory example
small short simple quick little tiny faster slow better proper correct
`.split(/\s+/).filter(Boolean).flatMap((word) => terms(word)));

/**
 * Words every software project uses for its everyday parts and doings
 * ("port", "endpoint", "deploy", "build", "server", "request", "log",
 * "commit"), as terms. They are everyday in coding requests, so they never
 * carry a fit on their own, whatever the vault says about them (search.js):
 * a coding request leaves them out of the words in common, as it does its
 * everyday request words (they still weigh in what it asks), and a question
 * whose words in common are all of these fits only a note of a project it
 * or the session names.
 */
export const COMMON = new Set(`
port ports endpoint endpoints server servers service services client clients request requests response responses
deploy deploys deployed deploying deployment build builds built building install installed installing release
version versions commit commits push pull merge branch log logs logging call calls error errors local locally dev
prod production staging env config setting settings database table tables query queries column index data user users
page time date read reads start started stop restart host url path header token timeout retry retries health job jobs
task queue worker handler middleware http https container image process memory cpu network listen listens listening ci
laptop machine computer second seconds minute minutes hour hours day days week weeks cache caches web app apps proxy
fail fails failed failing failure crash crashes crashed broken
`.split(/\s+/).filter(Boolean).flatMap((word) => terms(word)));

/**
 * Verbs that ask for work on code when a sentence starts with them ("Write
 * a function…", "Fix the failing test", "Can you add retries…"). Verbs that
 * ask to be told something ("tell", "show", "explain", "list") are not here,
 * and one of these asks to be told when the person is its object: "Run me
 * through a release", "Update me on…", "Read me the restore steps".
 */
export const WORK = new Set(`
add write create make set fix update change save modify edit remove delete rename refactor rewrite convert generate
implement run check test improve optimize optimise split format print return handle parse validate debug translate
upgrade bump clean review profile lint mock simplify extract wrap sort replace read kill
`.split(/\s+/).filter(Boolean));

/**
 * What "this …" or "my …" names when it is code in front of the person
 * ("this function", "my regex", "this SQL query", "my Docker container").
 * "This repo" and "this app" name a project, not code: "Who owns this
 * repo?" is a question.
 */
export const CODE_THINGS = new Set(`
function method class file script code line snippet program module component helper variable parameter argument
value string array object type regex loop condition statement spec test bug issue exception warning comment import
package library error query build image container diff commit branch trace stack log output config endpoint handler
callback promise goroutine thread process hook form css html json yaml sql dockerfile makefile
`.split(/\s+/).filter(Boolean));

/** Words a request may start with before its verb ("please", "can you", "could you also"). */
const LEAD_IN = /^(?:(?:please|pls|plz|kindly|hey|hi|hello|ok|okay|so|now|also|and|then|just|quickly|first|next|go ahead and|can you|could you|would you|will you|can u|could u|help me|i need you to|i want you to|i'd like you to|let's|lets|try to)\b[\s,]*)+/i;

/** Whether "this", "these" or "my" names code within the next three words. */
function speaksOfCode(text) {
    const words = text.toLowerCase().split(/[^a-z0-9.'-]+/).filter(Boolean);
    for (let i = 0; i < words.length; i += 1) {
        if (words[i] !== 'this' && words[i] !== 'these' && words[i] !== 'my') continue;
        for (const word of words.slice(i + 1, i + 4)) {
            const bare = word.replace(/[.']+$/, '');
            if (CODE_THINGS.has(bare) || CODE_THINGS.has(bare.replace(/e?s$/, ''))) return true;
        }
    }
    return false;
}

/**
 * A sentence's first word after its lead-in, and whether that word asks to
 * be told: the person is its object ("Run me through…", "Update us on…",
 * "Read me the steps"), not something to make ("Write me a function").
 */
const HEAD = /^([A-Za-z]+)(?:\s+(?:me|us)\b(\s+(?:through|on|in|about)\b)?)?/i;

/**
 * Where in the code a program's output says it was: a source file and a
 * line ("writer.go:57", "src/list.js:14:22") or a traceback's line
 * (`File "report.py", line 57`).
 */
const WHERE_IN_CODE = /[\w./-]\.(?:c|cc|cjs|cpp|cs|dart|ex|exs|go|h|java|js|jsx|kt|lua|mjs|php|py|rb|rs|scala|sh|svelte|swift|ts|tsx|vue):\d+\b|\bFile "[^"]+", line \d+/;

/**
 * Names of programming languages, tools, libraries, services and file
 * formats, as everyday coding requests name them ("kubectl command to
 * restart a deployment", "pandas groupby month", "redis-cli command to…",
 * "health check endpoint in fastapi"). Words that are also everyday English
 * ("go", "make", "express", "spark") are left out.
 */
export const CODE_NAMES = new Set(`
python py javascript js typescript ts nodejs node.js deno golang rust rustc cargo java kotlin scala swiftui objective-c
ruby rails php perl lua haskell elixir erlang clojure dart flutter csharp c# c++ cpp bash zsh sh shell powershell
sql plsql tsql regex regexp html css scss sass json yaml yml toml xml csv tsv markdown graphql protobuf proto
grpc wasm jsx tsx
git github gitlab bitbucket docker dockerfile docker-compose podman kubectl kubernetes k8s helm kustomize terraform
ansible nginx apache caddy haproxy envoy traefik systemd systemctl journalctl cron crontab ssh scp rsync curl wget jq
yq sed awk grep xargs tar gzip openssl makefile cmake npm npx yarn pnpm pip pip3 pipenv poetry conda virtualenv venv
gradle maven mvn webpack vite rollup esbuild babel eslint prettier jest mocha vitest pytest unittest junit playwright
cypress selenium puppeteer react reactjs vue vuejs angular svelte nextjs next.js nuxt fastapi flask django sqlalchemy
alembic prisma sequelize typeorm knex pandas numpy scipy matplotlib tensorflow pytorch sklearn kafka rabbitmq redis
redis-cli memcached postgres postgresql psql pg_dump mysql mariadb sqlite sqlite3 mongodb mongo mongoose elasticsearch
dynamodb s3 aws gcp azure ec2 alb elb cloudfront cloudflare vercel heroku netlify firebase supabase tailwind tailwindcss
bootstrap jquery lodash axios websocket websockets socket.io tmux vim neovim vscode xcode homebrew brew apt apt-get yum
dnf ubuntu debian alpine wsl bazel protoc gofmt golangci-lint rustfmt clippy black flake8 mypy ruff pylint tsc
storybook zod joi moment.js date-fns luxon tokio serde slog logrus prometheus grafana datadog sentry opentelemetry
nvm pyenv rbenv uvicorn gunicorn celery sidekiq pm2 jupyter ipython devtools node_modules
`.split(/\s+/).filter(Boolean));

/** The tools' and languages' names of CODE_NAMES that are one word, as terms ("node.js" is not "node"). */
export const CODE_TERMS = new Set([...CODE_NAMES].filter((name) => /^[a-z][a-z0-9]*$/.test(name)).flatMap((name) => terms(name)));

/** A file name with a source, configuration or data extension ("utils.py", "docker-compose.yml", ".proto", ".env"). */
const FILE_NAME = /(?:^|[\s(`'"/])[\w.-]*\.(?:c|cc|cjs|cpp|cs|css|csv|dart|env|ex|exs|go|gradle|h|hpp|html|ini|ipynb|java|js|json|jsx|kt|lock|lua|mjs|php|proto|ps1|py|rb|rs|scala|scss|sh|sql|svelte|swift|tf|toml|ts|tsx|vue|xml|yaml|yml|zsh)\b|(?:^|\s)\.(?:env|gitignore|nvmrc|npmrc|dockerignore|bashrc|zshrc|eslintrc)\b/i;

/** A flag on a command line ("--verbose", "-run", "rm -rf"). */
const FLAG = /(?:^|\s)(?:--[a-z][\w-]*|-[a-z]{1,4})(?=[\s=]|$)/i;

/**
 * What a program prints when it fails, or the name it gives a fault
 * ("TypeError", "EADDRINUSE", "ERR_OSSL_EVP_UNSUPPORTED", "npm ERR!",
 * "fatal: refusing to merge", "panic:", "permission denied (publickey)").
 */
const ERROR_NAME = /\b[A-Z][a-zA-Z]*(?:Error|Exception)\b|\bE[A-Z]{4,}\b|\bERR(?:_[A-Z_]+|!)/;
const ERROR_WORDS = /\b(?:error|fatal|panic|traceback|exception|segfault)\s*:|\bpermission denied\b|\bcommand not found\b|\bno such file or directory\b|\bconnection refused\b|\bsegmentation fault\b|\bstack ?trace\b|\bexit (?:code|status)\b|\bcrashloopbackoff\b/i;

/**
 * Code written into a sentence: a backquoted part, an identifier in
 * camelCase or snake_case ("useEffect", "node_modules", "unit_price"), or a
 * call or member of a package ("time.Now", "errors.Join", "sync.Map").
 */
const CODE_WORD = /`[^`\n]+`|\b[a-z]{2,}[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[a-z]\w*\.(?:[A-Z]\w*|\w+\()/;

/** Names people write in camelCase that are not code. */
/** A line of pasted code or output: code's braces, a call, a statement's end, a shell's prompt, an indented line, a log's "systemd[1]:". */
const CODE_LINE = /[{}]|\w\([^)]*\)|;\s*$|^\s*(?:\$|>|#!)\s|^\s{4,}\S|\w\[\d+\]:/;

/**
 * The lines of a prompt the person wrote, without pasted code or output
 * (a fenced block, or a line CODE_LINE marks): what they say in their own
 * words ("convert to slog pls", not the pasted `Warn("rate limited")`).
 * @param {string} prompt
 */
export function proseOf(prompt) {
    let fenced = false;
    const kept = [];
    for (const line of String(prompt ?? '').split('\n')) {
        if (/^\s*```/.test(line)) fenced = !fenced;
        else if (!fenced && !CODE_LINE.test(line)) kept.push(line);
    }
    return kept.join('\n');
}

/** A language and its version ("go 1.23", "python 3.12"). */
const VERSIONED = /\b(?:go|node|python|ruby|java|rust|php|deno|bun|swift|kotlin)\s?v?\d+\.\d+\b/i;
/** A custom header's name ("X-Request-ID"). */
const HEADER = /\bX-[A-Z][A-Za-z]*(?:-[A-Za-z]+)*\b/;
const NOT_CODE = /\b(?:macos|iphone|ipad|ipados|ios|tvos|watchos)\b/gi;

/**
 * Whether a text has code-shaped words: a language, tool or library's name
 * (CODE_NAMES), a file name, a command line's flag, an error, or code
 * written into a sentence. A prompt with one asks about code or a tool,
 * whatever its first word ("how do i check if a port is free from a shell
 * script").
 * @param {string} text
 */
export function codeShaped(text) {
    const plain = String(text ?? '').replace(NOT_CODE, ' ');
    if (FILE_NAME.test(plain) || FLAG.test(plain) || VERSIONED.test(plain) || HEADER.test(plain) || ERROR_NAME.test(plain) || ERROR_WORDS.test(plain) || CODE_WORD.test(plain)) return true;
    for (const raw of plain.toLowerCase().split(/[\s,;:!?()[\]{}"'`<>|=]+/)) {
        const word = raw.replace(/^[./]+|[./]+$/g, '');
        if (CODE_NAMES.has(word) || CODE_NAMES.has(word.replace(/\d+$/, ''))) return true;
    }
    return false;
}

/**
 * Whether a prompt is a coding request: one of its sentences starts with a
 * verb that asks for work on code (after "please", "can you" and the like),
 * it speaks of code in front of the person ("Why does my regex match too
 * much?", "How can I make this SQL query faster?"), it pastes output that
 * says where in the code it was (a stack trace, a failing test, a
 * traceback: "writer.go:57"), or it has code-shaped words, whatever its
 * first word (codeShaped: a tool's name, a file name, a flag, an error). A
 * question about how the team works ("Can I run a migration during the
 * close?") is not one, nor is a request to be told ("Run me through a
 * release").
 * @param {string} prompt
 */
export function isCodingRequest(prompt) {
    return asksForWork(prompt) || (codeShaped(prompt) && !asksTheTeam(prompt) && !asksAFact(prompt));
}

/** A question for a fact ("When is the `newCheckout` flag taken out?", "Which port does redis use here?"), not for help with code. */
const FACT = /^(?:when|which|where|who|whose|how (?:many|much|long|often|old)|what (?:is|are|was|were|does|do)\s+(?:the|our|its|this|that)\b(?![^?]*\b(?:my|wrong|mean|means)\b))\b[^?]*\?\s*$/i;

/** Whether a sentence of the prompt asks for a fact (FACT). */
export function asksAFact(prompt) {
    return String(prompt ?? '').split(/(?<=[.!?])\s+|\n+/).some((sentence) => FACT.test(sentence.trim().replace(LEAD_IN, '')));
}

/**
 * A question about how the team or its systems work, which a tool's name
 * does not make a coding request: what was decided and why ("Why did we
 * move the job queue off Redis?"), what we do ("Do we lose keys if an AWS
 * zone goes down?"), who to ask ("My laptop has no Docker. Who do I ask?"),
 * whether it is allowed ("Is it OK to deploy on Friday?"), or a guess to
 * confirm ("background jobs still go through redis right").
 */
const TEAM = /\b(?:why (?:did|do|does|is|are|was|were) (?:we|our|the team|they|jobs?|it)\b|(?:do|did|are|were|should|can|could|will|would|have|has) (?:we|our|the team)\b|who (?:do|should|can|would) (?:i|we)\b|who(?:'s| is| are)? (?:on call|on-call|owns?|approves?|signs?)\b|who owns\b|what if\b|explain why\b|can i (?:get|have)\b|is it (?:ok|okay|safe|fine|allowed|alright)\b|am i allowed\b|are we allowed\b|still\b[^.?!]*\bright\s*\??\s*$)/i;

/** Whether a prompt asks how the team or its systems work (TEAM), not for work on code. */
export function asksTheTeam(prompt) {
    return TEAM.test(String(prompt ?? ''));
}

/**
 * Whether a prompt asks for work on code, as isCodingRequest says, leaving
 * aside its code-shaped words: a sentence starts with a verb of work, it
 * speaks of code in front of the person, it pastes where in the code
 * something failed, or it asks for a thing to be made ("need a …").
 * @param {string} prompt
 */
export function asksForWork(prompt) {
    const text = String(prompt ?? '');
    if (speaksOfCode(text) || WHERE_IN_CODE.test(text) || ASKS_FOR_CODE.test(text)) return true;
    for (const sentence of text.split(/(?<=[.!?;:])\s+|\n+/)) {
        const head = sentence.trim().replace(LEAD_IN, '').match(HEAD);
        const first = head?.[1]?.toLowerCase();
        // "Check how long keys last", "check whether the backup ran": asked to find out and tell, not to work on code.
        const finds = /^(?:check|test|find)\s+(?:how|what|when|where|which|who|whether)\b/i.test(sentence.trim().replace(LEAD_IN, ''));
        const told = finds || (head !== null && /\s(?:me|us)\b/i.test(head[0]) && (head[2] !== undefined || first === 'read'));
        if (first && WORK.has(first) && !told) return true;
    }
    return false;
}

/**
 * A statement of a decision or a lesson, usually to be recorded ("we
 * decided to keep v1 for a year, put that in the notes", "decision: …",
 * "lesson learned: …"). Its words that say it was decided and should be
 * recorded (RECORDING) say what to do with it, not what it is about.
 */
const DECIDED = /\b(?:we|i|team|they)(?:\s+(?:have|just|finally|all|now))?(?:'ve)?\s+(?:decided|agreed|chose|settled|picked|went with|landed on|switched)\b|^\s*(?:decision|lesson(?:s)? learned|lesson)\s*:|\blessons? learned\b|\b(?:we|i)(?:'ve| have)? learned\b/i;

/**
 * A request to keep what the prompt says ("save that", "record it", "note
 * it down", "write that down", "put it in the notes", "update the notes",
 * "add that to the runbook", "fyi …", "for the record"), or a lesson told
 * ("lesson from tonight: …").
 */
const RECORD_ASK = /\b(?:save|record|note|jot)\s+(?:that|this|it)\b(?!\s+(?:to|in|into|on)\s+(?:a\s+|the\s+)?(?:disk|file|db|database|cache|redis|s3|bucket|table|db)\b)|\b(?:write|jot|note|put|get)\s+(?:that|this|it)\s+down\b|\b(?:put|add|write|log|keep|save|record)\s+(?:that|this|it)\s+(?:in|into|to|on)\s+(?:the\s+|our\s+)?(?:notes|vault|canon|runbooks?|docs|wiki|records?)\b|\b(?:update|add\s+(?:it|that|this)\s+to)\s+the\s+(?:notes|vault|canon|runbooks?|docs)\b|\b(?:in|into)\s+the\s+(?:notes|vault|canon)\b\s*[.!]?\s*$|^\s*fyi\b|\bfor the record\b|^\s*lessons?\s+(?:from|of)\b/i;

/**
 * Whether a prompt states a decision or a lesson to keep ("we decided …",
 * "we agreed …", "decision: …", "lesson learned: …", "fyi …, save that"),
 * not asking about one.
 * @param {string} prompt
 */
export function isDecision(prompt) {
    const text = String(prompt ?? '').trim();
    if (text.endsWith('?') || !(DECIDED.test(text) || RECORD_ASK.test(text))) return false;
    // "Save this: we use pnpm now" keeps; "Write a helper and add it to the docs" asks for work.
    return !asksForWork(text.replace(new RegExp(RECORD_ASK.source, 'gi'), ' '));
}

/**
 * How to save a decision, said in its statement: which tool ("with the
 * canon_capture tool", "use the capture tool"), as what ("as a draft
 * decision note", "as a decision draft", "kind decision"), and what not to
 * do ("do not edit any files", "don't touch the repo", "no code changes",
 * "nothing else").
 */
const HOW_TO_SAVE = /\bcanon_capture\b|\bcapture\s+tool\b|\b(?:as|in)\s+an?\s+(?:draft|decision)\b|\bdraft\s+(?:decision\s+)?note\b|\bdecision\s+draft\b|\bdraft\s+decision\b|\bkind\s*[:=]?\s*decision\b|\b(?:do\s+not|don['’]?t|never)\s+(?:edit|touch|change|modify)\b|\bno\s+code\s+changes\b|\bnothing\s+else\b/i;

/**
 * What a decision statement is about: its sentences and clauses (a clause
 * ends at a colon, "Record this as a decision draft (canon_capture): we
 * decided …") without the ones that say how to save it (HOW_TO_SAVE), so
 * "Save that as a draft decision note with the canon_capture tool. Do not
 * edit any files yourself." weighs nothing in what the decision is about.
 * The whole statement when every part says how to save it.
 * @param {string} prompt
 */
export function decisionSubject(prompt) {
    const parts = String(prompt ?? '').split(/(?<=[.!?;])\s+|\n+|:\s+/).map((part) => part.trim()).filter(Boolean);
    const kept = parts.filter((part) => !HOW_TO_SAVE.test(part));
    // When it changed says nothing of what changed: "we moved the health check to 8081 last night".
    return (kept.length ? kept.join('\n') : String(prompt ?? '')).replace(WHEN_IT_CHANGED, ' ');
}

/** The words of a decision statement that say when it was made, not what about. */
const WHEN_IT_CHANGED = /\b(?:(?:last|this|tomorrow|yesterday)\s+(?:night|morning|afternoon|evening)|(?:last|this)\s+(?:week|month)|yesterday|tonight|today|earlier\s+today)\b/gi;

/** The words of a decision statement that say it was decided and should be recorded, as terms. */
export const RECORDING = new Set(`
decide decided decision decisions agree agreed choose chose chosen settle settled pick picked lesson lessons learn
learned record recorded remember going forward write down put save add document jot log update fyi somewhere
`.split(/\s+/).filter(Boolean).flatMap((word) => terms(word)));

/**
 * A request for a thing to be made, written without a verb of work: "need a
 * bash loop that…", "i need a regex for…", "looking for a script to…",
 * "one-liner to find…", "example of a…".
 */
const ASKS_FOR_CODE = /^\s*(?:(?:i\s+)?(?:need|want)|(?:i'm\s+|im\s+)?looking\s+for|gimme|give\s+me)\s+(?:a|an|some)\b|^\s*(?:(?:a\s+)?one-liner|(?:an?\s+)?example\s+of)\b|^\s*(?:an?\s+)?(?:[\w./+#-]+\s+){0,2}(?:script|function|query|regex|middleware|handler|hook|component|helper|class|method|endpoint|loop|snippet|alias|wrapper|decorator|parser|validator|reducer|cron\s?job)s?\s+(?:that|which|to|for)\s+\w[^?]*$/i;

/** Words that end what a work verb acts on ("a migration | that adds…", "a route | to tide-ledger"). */
const OBJECT_ENDS = new Set(`
that which who whose so to with for in on into onto from at by when where if and or but instead before after until using
via of than as
`.split(/\s+/).filter(Boolean));

/**
 * The terms of what a coding request's first work verb acts on: the words
 * after it up to the next clause or preposition ("Write a migration that
 * adds a column" → migration; "Add a route to tide-ledger" → rout).
 * @param {string} prompt
 */
export function workObject(prompt) {
    for (const sentence of String(prompt ?? '').split(/(?<=[.!?;:])\s+|\n+/)) {
        const words = sentence.trim().replace(LEAD_IN, '').split(/\s+/);
        const verb = words[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
        if (!WORK.has(verb) || /^(?:me|us)$/i.test(words[1] ?? '')) continue;
        const out = [];
        for (const word of words.slice(1)) {
            const bare = word.replace(/[^\p{L}\p{N}'-]+$/u, '');
            if (OBJECT_ENDS.has(bare.toLowerCase())) break;
            out.push(bare);
            if (/[.!?;:,]$/.test(word)) break;
        }
        return terms(out.join(' '));
    }
    return [];
}

/**
 * A prompt's distinct terms, without its words about the vault and, unless
 * `everyday` is set, without its everyday request words.
 * @param {string} text
 * @param {{ max?: number, everyday?: boolean }} [options]
 */
export function promptTerms(text, options = {}) {
    const all = terms(text, options);
    const vault = (t, i) => ABOUT_THE_VAULT.has(t) || (BEFORE_THE_VAULT.has(t) && ABOUT_THE_VAULT.has(all[i + 1]));
    return [...new Set(all.filter((t, i) => !vault(t, i) && (options.everyday || !EVERYDAY.has(t))))];
}

/** How often each term comes in a text. */
export function counts(text) {
    const out = new Map();
    for (const t of terms(text)) out.set(t, (out.get(t) ?? 0) + 1);
    return out;
}

/** A name as folders and projects are compared: lower case, runs of other characters as one "-". */
export const nameKey = (text) => String(text ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
