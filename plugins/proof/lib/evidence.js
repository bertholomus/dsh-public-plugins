/**
 * Evidence in a turn: what its tools showed, and whether it backs a claim.
 * Pure: the session projection (projection.js) calls it on every tool
 * result, and once per claim at a turn's end.
 *
 * Each tool result becomes one small item: which tool, what kind of run
 * (a test, a build, lint, a CI read, a deploy, a request to a server, a
 * checksum, another command, a change to files, a read), whether it went
 * well (the exit code, a test summary, a push that went through, an HTTP
 * status), and the facts worth quoting: test counts, a file hash or
 * commit, a metric that moved, the figures it printed.
 *
 * DSH's bash tool writes stdout, then `[stderr]`, then markers such as
 * `[exit code: 1]`, `[timed out after …ms]` or `[killed by signal: …]`; a
 * command that exits 0 gets no marker. Other tools are read by their
 * words ("exit=0", "Exit code: 0", "12 passed").
 *
 * @module dsh-plugin-proof/evidence
 */
import { CHANGE_CLAIM, WHOLE_SUITE } from './claims.js';

// ── Which tool did what ────────────────────────────────────────────

const SHELL_TOOL = /^(bash|shell|sh|zsh|exec|execute|run|run_command|run_shell|terminal|command|cmd|pwsh|powershell|bash_persistent)$|(^|_)(bash|shell|exec|command|terminal)(_|$)/i;
const CHANGE_TOOL = /(^|_)(edit|edits|multi_edit|multiedit|write|writes|create|create_file|apply_patch|patch|str_replace|replace|insert|delete|remove|rename|move|mkdir|notebook_edit|save)(_|$)/i;
const READ_TOOL = /(^|_)(read|grep|glob|ls|list|view|cat|search|find|fetch|open|stat|tree|get|lookup|inspect|query|show|diff|log|status)(_|$)/i;
/** DSH's own bookkeeping tools: never evidence of work. */
const BOOKKEEPING_TOOL = /^(todo_write|todo_read|todowrite|create_goal|get_goal|update_goal|ask_user_question|question|present|plan|think|exit_plan_mode)$/i;

const TEST_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t|e2e|test:\S+|check|verify|ci)\b|\b(node|deno|bun)\s+(--test|test)\b|\bnpx\s+(jest|vitest|mocha|playwright|ava|tap|cypress)\b|\b(jest|vitest|mocha|pytest|py\.test|tox|nox|rspec|phpunit|ctest|ava|karma|cypress\s+run|playwright\s+test)\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b|\bmvnw?\s+(\S+\s+)*(test|verify)\b|\bgradlew?\s+(\S+\s+)*(\S*:)?(test\w*|check\w*|connected\w*Test)\b|\bxcodebuild\b[^|;&]*\btest\b|\b(flutter|dart)\s+test\b|\bsbt\s+(\S+\s+)*test\b|\b(nx|turbo|lerna)\s+(run\s+)?([\w:-]+\s+)*?(\S+:)?test\b|\bpnpm\s+(-r|--recursive)\s+test\b|\b(stack|cabal)\s+test\b|\bzig\s+build\s+test\b|\bgotestsum\b|\b(python3?|uv\s+run|poetry\s+run)\s+-m\s+(pytest|unittest)\b|\bmake\s+(-\S+\s+(\S+\s+)?)*(test|check|ci|e2e)\b|\bdotnet\s+test\b|\bswift\s+test\b|\bmix\s+test\b|\brake\s+(test|spec)\b|\b(?:bin\/)?rails\s+test\b|\bbundle\s+exec\s+(rspec|rake\s+(test|spec))\b|\bscripts\/e2e|\b\S*test\S*\.(sh|mjs|js|py)\b|\be2e\.(mjs|js|sh)\b|\bbazel\s+test\b|(^|[\s/])(ci|verify|check|checks|validate|precommit|pre-commit)([-_.]\S*)?\.(sh|mjs|js|py)\b|\bscripts\/(ci|verify|check|validate)\S*|\bpre-commit\s+run\b|\bdbt\s+(test|build)\b|\bbats\b|\bprove\b|\b(npm|pnpm|yarn|bun)(\s+(--filter|-F|-C|--prefix|--cwd|--dir|--workspace|-w|workspace)\s+\S+|\s+-{1,2}[\w-]+(=\S+)?)+\s+(run\s+)?(test|t|e2e|test:\S+)\b/i;
const BUILD_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|build:\S+|compile|typecheck|type-check|tsc|bundle)\b|\btsc\b|\bcargo\s+(build|check)\b|\bgo\s+(build|vet)\b|\bmake(\s+(all|build|install|release))?\s*($|[;&|])|\bmvnw?\s+(\S+\s+)*(package|compile|install)\b|\bgradlew?\s+(\S+\s+)*(\S*:)?(build|assemble\w*|bundle\w*|jar|shadowJar|compile\w*)\b|\bdotnet\s+build\b|\bswift\s+build\b|\bwebpack\b|\bvite\s+build\b|\besbuild\b|\brollup\b|\bnext\s+build\b|\bnode\s+--check\b|\bpython3?\s+-m\s+(py_compile|compileall)\b|\bxcodebuild\b|\bcmake\s+--build\b|\bninja\b|\bdocker\s+(build|buildx\s+build|compose\s+build)\b|\bbazel\s+build\b|\bmix\s+compile\b|\bdbt\s+(run|seed|snapshot|compile)\b|\bhugo\b(?!\s+(?:server|serve|new|version|env|mod|config|list|gen|completion|help|import|deploy)\b)|\b(?:bundle\s+exec\s+)?jekyll\s+build\b|\b(?:@11ty\/)?eleventy\b|\bmkdocs\s+build\b|\bsphinx-build\b|\b(?:astro|gatsby|zola|mdbook|docusaurus|vuepress|vitepress)\s+build\b|\bnuxt\s+(?:build|generate)\b|\bhexo\s+(?:generate|g)\b|\bpelican\s+content\b|\b(nx|turbo|lerna)\s+(run\s+)?(\S+:)?build\b|\bnx\s+run-many\b[^|;&]*--target[= ]build\b|\b(npm|pnpm|yarn|bun)(\s+(--filter|-F|-C|--prefix|--cwd|--dir|--workspace|-w|workspace)\s+\S+|\s+-{1,2}[\w-]+(=\S+)?)+\s+(run\s+)?(build|build:\S+|compile|typecheck|type-check)\b/i;
const LINT_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|lint:\S+|format:check|fmt:check|check:format)\b|\b(eslint|ruff|flake8|pylint|mypy|pyright|golangci-lint|shellcheck|stylelint|rubocop|swiftlint|biome\s+(check|lint)|oxlint|phpstan|psalm)\b|\bprettier\s+(--check|-c)\b|\bblack\s+--check\b|\bcargo\s+(clippy|fmt\s+--check)\b|\bgofmt\s+-l\b|\b(bash|sh|zsh|dash|ksh)\s+-n\b|\bphp\s+-l\b|\b(ruby|perl)\s+-c\b|\bterraform\s+(validate|fmt\s+-{1,2}check)\b|\bnginx\s+-t\b|\b(yamllint|hadolint|actionlint|markdownlint(-cli2)?|ktlint|detekt|credo|standardrb|tflint|staticcheck|revive)\b|\bsqlfluff\s+lint\b|\bbuf\s+lint\b|\b(dart|flutter)\s+analyze\b/i;
const CI_CMD = /\bgh\s+(run\s+(view|list|watch)|pr\s+(checks|status)|workflow\s+view)\b|\bgh\s+pr\s+view\b(?=[^|;&]*\b(?:statusCheckRollup|checks|mergeStateStatus)\b)|\bglab\s+ci\b|\bcircleci\b|\bbuildkite\b|\bcurl\b[^|;&]*\/(actions|checks|statuses|pipelines)\b/i;
/** Where a command ships work: a repository, a package registry, or a running environment. */
const PUSH_CMD = /\bgit\s+push\b|\bgh\s+pr\s+merge\b|\bgh-pages\b|\bgh\s+release\s+(?:create|upload)\b/i;
const DEPLOY_REMOTE = /\bgit\s+push\s+(-\S+\s+)*(heroku|dokku|deploy|production|prod|staging|live|fly|render|piku)\b|\bgh-pages\b/i;
const PUBLISH_CMD = /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdocker\s+(push|buildx\s+build\b[^|;&]*--push)\b|\b(?:podman|buildah)\s+push\b|\bjib:build\b|\bgradlew?\s+(?:\S+\s+)*jib\b(?!\w)|\bko\s+(?:build|publish|apply)\b|\bcrane\s+(?:push|copy|cp)\b|\bskopeo\s+copy\b|\bgh\s+release\s+(?:create|upload)\b|\bmvnw?\s+(\S+\s+)*deploy\b|\bgradlew?\s+(\S+\s+)*publish\w*\b|\bdotnet\s+nuget\s+push\b|\b(poetry|uv|flit|hatch)\s+publish\b|\bmix\s+hex\.publish\b|\bpod\s+trunk\s+push\b|\bfastlane\s+(?:\S+\s+)*(?:pilot|upload_to_testflight|upload_to_app_store|upload_to_play_store|deliver|supply)\b|\baltool\b[^|;&]*--upload|\biTMSTransporter\b|\b(?:aws\s+s3|gsutil(?:\s+-m)?|gcloud\s+storage)\s+(?:cp|sync|mv)\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*(?!s3:|gs:)\S+\s+(?:s3|gs):\/\/\S*(?=\s*(?:$|&&|;|\|))/i;
const RELEASE_CMD = /\bkubectl\b[^|;&]*\b(apply|rollout|set\s+image|replace|scale|patch)\b|\bhelm\s+(upgrade|install|rollback)\b|\b(fly|flyctl)\s+(deploy|releases?)\b|\bvercel\b|\bnetlify\s+deploy\b|\bheroku\s+(releases|container:release|deploy)\b|\bterraform\s+apply\b|\bpulumi\s+up\b|\bwrangler\s+(deploy|publish)\b|\bfirebase\s+deploy\b|\bgcloud\s+(\S+\s+)*deploy\b|\baws\s+(s3\s+sync|deploy|ecs\s+update-service|lambda\s+update-function-code|cloudformation\s+deploy)\b|\bcap\s+\S+\s+deploy\b|\bansible-playbook\b|\bkamal\s+deploy\b|(^|[\s;&|/])deploy(\.sh)?(\s|$)|\b(npm|pnpm|yarn)\s+run\s+deploy\b|\bmake\s+deploy\b|\brsync\b[^|;&]*\s[\w.@-]+:\S*|\bscp\b[^|;&]*\s[\w.@-]+:\S*|\bdocker\s+compose\s+(\S+\s+)*up\b|\bsystemctl\s+(restart|reload)\b/i;
/** Reads of what a registry holds. */
const REGISTRY_READ_CMD = /\bnpm\s+(view|info|show)\b|\bpip3?\s+index\s+versions\b|\bcargo\s+search\b|\bgem\s+list\s+(-r|--remote)\b|\bdocker\s+(manifest\s+inspect|pull)\b|\bcrane\s+(digest|ls)\b|\bskopeo\s+inspect\b/i;
/** A request to a server, or a status read of what runs. */
const PROBE_CMD = /\b(curl|wget|httpie|xh|hey|ab)\b|\bhttp\s+(get|head|post\s+)?\S*https?:|\bkubectl\b[^|;&]*\b(get\s+(pods?|po|deploy(ments?)?|svc|services?)|describe)\b|\bsystemctl\s+status\b|\bdocker\s+(ps|compose\s+ps)\b|\b(fly|flyctl)\s+status\b|\bheroku\s+ps\b|\baws\s+[\w-]+\s+(?:describe-[\w-]+|get-[\w-]+|list-[\w-]+|wait)\b|\bgcloud\s+(?:[\w-]+\s+){1,3}(?:describe|list)\b|\baz\s+(?:[\w-]+\s+){1,3}(?:show|list)\b/i;
/** Runs that apply infrastructure, a playbook or a database migration. */
const MIGRATE_CMD = /\b(sqlite3|duckdb)\s+\S+\s*<\s*\S+|\b(psql|mysql|mariadb|sqlcmd)\b[^|;&]*(\s-f\s|\s--file[= ]|<\s*\S+)|\balembic\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*upgrade\b|\b(rails|rake)\s+db:(migrate|schema:load|setup)\b(?!:status)|\bprisma\s+(migrate\s+(deploy|dev|reset)|db\s+push)\b|\b(knex|sequelize(-cli)?)\s+(migrate:latest|db:migrate)\b|\bgoose\b[^|;&]*\bup\b|\bmigrate\b[^|;&]*\s(up|-up)\b|\bflyway\s+migrate\b|\bdbmate\s+(up|migrate)\b|\bliquibase\s+update\b|\b(php\s+artisan|manage\.py|django-admin)\s+migrate\b(?!:status)|\bdiesel\s+migration\s+run\b|\bsqlx\s+migrate\s+run\b|\bmix\s+ecto\.migrate\b|\bdotnet\s+ef\s+database\s+update\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(db:)?migrate\b|\bdrizzle-kit\s+(push|migrate)\b|\b(make|just|task)\s+(db[-:])?migrate\b|\btypeorm(-ts-node-\w+)?\s+migration:run\b|\bmikro-orm\s+migration:up\b|\batlas\s+(migrate|schema)\s+apply\b|\bsupabase\s+(db\s+(push|reset)|migration\s+up)\b|\bhasura\s+migrate\s+apply\b|\bsqitch\s+deploy\b|\bdoctrine:migrations:migrate\b|\bmix\s+ecto\.(setup|reset)\b|\b(rails|rake)\s+db:prepare\b/i;
/** A training run: a training script, a trainer launcher, or a make or npm target that trains. */
const TRAIN_CMD = /\b[\w-]*(train|finetune|fine_tune|fine-tune|sft|pretrain)[\w-]*\.(py|sh)\b|\b(torchrun|deepspeed|fairseq-train|axolotl|mlx_lm\.lora)\b|\baccelerate\s+launch\b|\bllamafactory-cli\s+train\b|\btune\s+run\b|\b(python3?|uv\s+run|poetry\s+run)\s+(-m\s+)?[\w.]*(train|finetune|sft)\w*\b|\b(make|just|task|npm\s+run|pnpm|yarn)\s+[\w:-]*(train|finetune|fine-tune)\b|\byolo\s+(\w+\s+)?train\b|\bdvc\s+(repro|exp\s+run)\b|\bmlflow\s+run\b/i;
/** Lines of a training run's own output: epochs and losses. */
const TRAIN_OUT = /\bepoch\s*[:=]?\s*\d+|\b(train(ing)?[_\s]loss|val(idation)?[_\s]loss)\b/i;
const APPLY_CMD = /\b(terraform|tofu)\s+(\S+\s+)*apply\b|\bpulumi\s+up\b|\bkubectl\b[^|;&]*\b(apply|create|replace|patch|set\s+(image|env))\b|\bhelm\s+(upgrade|install)\b|\bansible-playbook\b|\bcdk\s+deploy\b|\baws\s+cloudformation\s+deploy\b|\bkustomize\b[^|;&]*\|\s*kubectl\s+apply\b|\bargocd\s+app\s+sync\b|\bnomad\s+(job\s+)?run\b/i;
/** Commands that start a job or workflow somewhere else, which then runs on its own. */
/** A command sent to the background (`nohup train.py … &`, `setsid`, `screen -dm`): it had not ended when its exit came back. */
const BACKGROUND_CMD = /(?:^|[;&|(]\s*)(?:nohup|setsid)\s|(?<![&>|])&(?![&>])\s*(?:$|;|\)|echo\b|disown\b)|\bscreen\s+-\w*d\w*m|\btmux\s+new(?:-session)?\b[^;&|]*\s-d\b/;
const JOB_CMD = /\bargo\s+submit\b|\bgh\s+workflow\s+run\b|\bgh\s+run\s+rerun\b|\bkubectl\s+create\s+job\b|\bsbatch\b|\bqsub\b|\bbsub\b|\bairflow\s+dags\s+trigger\b|\baws\s+batch\s+submit-job\b|\baws\s+glue\s+start-job-run\b|\baws\s+stepfunctions\s+start-execution\b|\bdatabricks\s+(jobs\s+run-now|runs\s+submit)\b|\bgcloud\s+(dataflow\s+jobs\s+run|dataproc\s+jobs\s+submit|batch\s+jobs\s+submit|run\s+jobs\s+execute)\b|\bprefect\s+deployment\s+run\b|\bdagster\s+job\s+launch\b|\bnomad\s+job\s+run\b/i;
const HASH_CMD = /\b(sha\d+sum|shasum|md5sum|b2sum|cksum|gpg\s+--verify|cosign\s+verify|minisign\s+-V)\b/i;
const CHANGE_CMD = /(^|[;&|(]\s*|\s)(sed\s+-i|perl\s+-p?i|mv|cp|rm|mkdir|touch|tee|chmod|ln|patch|truncate|install|git\s+(apply|commit|checkout|restore|reset|mv|rm|merge|rebase|cherry-pick|revert|stash\s+pop|add|tag|pull|am)|(npm|pnpm|yarn|bun)(\s+(-{1,2}[\w-]+(=\S+)?|--filter\s+\S+|-F\s+\S+|-C\s+\S+|--prefix\s+\S+|--cwd\s+\S+|workspace\s+\S+))*\s+(add|install|i|uninstall|remove|rm|update|up|ci|version)\b|pip3?\s+install|uv\s+(add|pip\s+install)|poetry\s+add|cargo\s+add|go\s+get|bundle\s+(install|update)|composer\s+(require|update|install)|apply_patch|python3?\s+-c\s+.*\b(open|write)\b|alembic\s+upgrade|rails\s+db:migrate(?!:status)|prisma\s+migrate(?!\s+(?:status|diff|resolve\s+--help)\b)|eslint\s+(\S+\s+)*--fix|prettier\s+(\S+\s+)*(--write|-w)|ruff\s+(check\s+(\S+\s+)*--fix|format)|black(?!\s+(\S+\s+)*--check)|gofmt\s+-w|go\s+fmt|cargo\s+fmt(?!\s+(\S+\s+)*--check)|rubocop\s+(\S+\s+)*(-a|-A|--autocorrect\S*)|(npm|pnpm|yarn)\s+(run\s+)?(format|fmt|lint:fix|fix)\b|npm\s+audit\s+fix|codemod|jscodeshift)\b|[^2&]>\s*[^&|\s>]|>>/i;
/** A change to code that tests must run after (as against a commit, a branch, docs or notes). */
const CODE_CHANGE_CMD = /(^|[;&|(]\s*|\s)(sed\s+-i|perl\s+-p?i|patch|git\s+(apply|restore|cherry-pick|revert|stash\s+pop|checkout\s+(\S+\s+)?--\s)|apply_patch)(\s|$)/i;
/** Files and code that hold a route or a handler: `routes/`, `api/`, `*_controller.rb`, `@router.get(`, `app.post(`, `path('…'`. */
const ROUTE_FILE = /(^|[\/\s_.-])(routes?|routers?|controllers?|handlers?|endpoints?|apis?|views?|urls|server|app|main|index|resources?)(\/|\.\w+\b|[_-])/i;
const ROUTE_CODE = /\.(get|post|put|patch|delete|route|all|add_url_rule|add_api_route|api_route|handle|handlefunc|handler|register|mount)\s*\(|@(get|post|put|patch|delete|route|api_route)\b|@\w+\.(get|post|put|patch|delete|route|api_route)\s*\(|@(Get|Post|Put|Patch|Delete|Request)Mapping\b|\b(path|re_path|url)\s*\(\s*r?['"]|\bRoute::\w+\s*\(|^\s*(get|post|put|patch|delete|resources?)\s+['":\/]|\(\s*req\s*,\s*res\b|\breq\s*:\s*Request\b|\bNext(Request|Response)\b|\bhttp\.ResponseWriter\b|\b(Http|Json)Response\b|\bjsonify\s*\(|\bres\.(json|send|status)\s*\(|\bc\.JSON\s*\(|\bResponseEntity\b|@(Rest)?Controller\b|\bAPIRouter\s*\(|\bBlueprint\s*\(|\bexpress\s*\(\s*\)|\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|\bhandler\s*[:=(]/im;
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc|org)$|(^|\/)(docs?)\/|(^|\/)\.github\/|(^|\/)(CHANGELOG|README|LICENSE|NOTICE|AUTHORS|CONTRIBUTING|HANDOFF|TODO|\.gitignore|\.editorconfig)(\.|$)/i;

// ── What a tool's output says ──────────────────────────────────────

/** How a run ended: an exit code, or 'timeout', 'signal', 'stopped', 'denied' or 'error'; null when the tool does not say. */
export function exitOf(text, { isError = false, shell = false } = {}) {
    const t = typeof text === 'string' ? text : '';
    const marker = [...t.matchAll(/\[exit code: (-?\d+)\]/g)].at(-1);
    if (marker) return Number(marker[1]);
    if (/\[timed out after \d+ ?ms\]/.test(t)) return 'timeout';
    if (/\[killed by signal: [^\]]+\]/.test(t)) return 'signal';
    if (/\[stopped: [^\]]*\]/.test(t)) return 'stopped';
    if (/\[sandbox: [^\]]*(denied|failed)[^\]]*\]/.test(t)) return 'denied';
    if (isError) return 'error';
    // A test's name ("ok 6 exit 64 on unknown flag", "✓ exits 2 on bad input") says what it checks, not how the run ended.
    const said = EXIT_SAID.exec(t.replace(TEST_LINE, ''));
    if (said) return Number(said[1] ?? said[2] ?? said[3]);
    return shell ? 0 : null;
}

/** A line of a test runner's results: TAP's "ok 6 …", "✓ …", "test x ... ok". */
const TEST_LINE = /^\s*(?:(?:not\s+)?ok\s+\d+\b|[✓✔✗✘√]\s|test\s+\S+\s+\.\.\.\s).*$/gm;
/** "exited with code 2", "Exit status: 1", "rc=0", "exit=0"; a bare "exit 1" only at a line's end. */
const EXIT_SAID = /\b(?:exit(?:ed)?\s+with(?:\s+(?:code|status))?|exited(?:\s+(?:code|status))?|exit\s+(?:code|status)|exit_code|exitcode|return\s+code|returncode|rc)\s*[:=]?\s*(-?\d{1,3})\b|\bexit\s*[:=]\s*(-?\d{1,3})\b|\bexit\s+(-?\d{1,3})\s*\]?\s*$/im;

const num = (v) => (v === undefined ? undefined : Number(String(v).replace(/,/g, '')));

/**
 * Test counts in a runner's summary (the last one in the output wins):
 * `{ passed, failed, total? }`, or undefined.
 */
export function testCountsIn(text) {
    if (typeof text !== 'string' || text === '') return undefined;
    const found = [];
    const add = (passed, failed, total) => {
        const p = num(passed) ?? (total !== undefined && failed !== undefined ? num(total) - num(failed) : undefined);
        if (p === undefined || Number.isNaN(p)) return;
        found.push({ passed: p, failed: num(failed) ?? 0, ...(total !== undefined ? { total: num(total) } : {}) });
    };
    let m;
    // node --test: TAP ("# tests 12", "# pass 12", "# fail 0") or the spec reporter ("ℹ pass 12")
    const tapPass = [...text.matchAll(/^(?:#|ℹ) pass (\d+)\s*$/gm)].at(-1);
    // A loop of runs prints one summary a round: the worst round's failures, for a flake that failed once.
    const tapFails = [...text.matchAll(/^(?:#|ℹ) fail (\d+)\s*$/gm)].map((x) => Number(x[1]));
    if (tapPass) {
        const fail = [...text.matchAll(/^(?:#|ℹ) fail (\d+)\s*$/gm)].at(-1);
        const total = [...text.matchAll(/^(?:#|ℹ) tests (\d+)\s*$/gm)].at(-1);
        add(tapPass[1], fail?.[1] ?? 0, total?.[1]);
    }
    // jest: "Tests:       1 failed, 2 skipped, 10 passed, 13 total"
    for (m of text.matchAll(/Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ (?:skipped|todo|pending),\s*)*(?:(\d+) passed,\s*)?(\d+) total/g)) add(m[2] ?? 0, m[1] ?? 0, m[3]);
    // vitest: "Tests  1 failed | 10 passed (11)"
    for (m of text.matchAll(/Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|\s*\d+ (?:skipped|todo))?\s*\((\d+)\)/g)) add(m[2], m[1] ?? 0, m[3]);
    // pytest: "===== 1 failed, 4 passed, 1 skipped in 0.20s =====", "5 passed in 0.12s"
    for (m of text.matchAll(/(?:^|=+\s|\s)(?:(\d+) failed,\s*)?(\d+) passed(?:,\s*(\d+) failed)?(?:,\s*\d+ (?:skipped|warnings?|xfailed|xpassed|errors?|deselected))*\s+in\s+[\d.]+\s*s/gm)) add(m[2], m[1] ?? m[3] ?? 0);
    for (m of text.matchAll(/(?:^|=+\s)(\d+) failed(?:,\s*\d+ (?:skipped|warnings?|errors?))*\s+in\s+[\d.]+\s*s/gm)) add(0, m[1]);
    // mocha: "12 passing", "2 failing"
    const passing = [...text.matchAll(/^\s*(\d+) passing\b/gm)].at(-1);
    if (passing) add(passing[1], [...text.matchAll(/^\s*(\d+) failing\b/gm)].at(-1)?.[1] ?? 0);
    // cargo: "test result: ok. 5 passed; 0 failed;"
    const cargo = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
    if (cargo.length) {
        const passed = cargo.reduce((a, x) => a + Number(x[1]), 0);
        const failed = cargo.reduce((a, x) => a + Number(x[2]), 0);
        // Each part's own summary: "unit tests: 23 passed" is shown by a part that printed 23 passed, 0 failed (`clean`).
        found.push({ passed, failed, ...(cargo.length > 1 ? { total: passed + failed, parts: cargo.map((x) => Number(x[1])), clean: cargo.filter((x) => x[2] === '0').map((x) => Number(x[1])) } : {}) });
    }
    // rspec: "12 examples, 0 failures"
    for (m of text.matchAll(/(\d+) examples?, (\d+) failures?/g)) add(num(m[1]) - num(m[2]), m[2], m[1]);
    // minitest (`rails test`): "123 runs, 410 assertions, 0 failures, 0 errors, 0 skips"; a skipped one did not pass.
    for (m of text.matchAll(/\b(\d+) runs, \d+ assertions, (\d+) failures, (\d+) errors(?:, (\d+) skips)?/g)) add(num(m[1]) - num(m[2]) - num(m[3]) - (num(m[4]) ?? 0), num(m[2]) + num(m[3]), m[1]);
    // unittest: "Ran 12 tests in 0.003s" then "OK" or "FAILED (failures=1, errors=1)"
    for (m of text.matchAll(/Ran (\d+) tests? in [\d.]+s\s+(OK|FAILED \(([^)]*)\))/g)) {
        const failed = m[2] === 'OK' ? 0 : [...(m[3] ?? '').matchAll(/(?:failures|errors)=(\d+)/g)].reduce((a, x) => a + Number(x[1]), 0);
        add(num(m[1]) - failed, failed, m[1]);
    }
    // phpunit: "OK (12 tests, 30 assertions)", "Tests: 12, Assertions: 30, Failures: 2, Errors: 1."
    for (m of text.matchAll(/OK \((\d+) tests?, \d+ assertions?\)/g)) add(m[1], 0, m[1]);
    for (m of text.matchAll(/Tests: (\d+), Assertions: \d+((?:, (?:Failures|Errors|Skipped|Incomplete|Risky|Warnings|Deprecations|Notices): \d+)+)/g)) {
        const bad = [...m[2].matchAll(/(?:Failures|Errors): (\d+)/g)].reduce((a, x) => a + Number(x[1]), 0);
        add(num(m[1]) - bad, bad, m[1]);
    }
    // maven surefire: "Tests run: 18, Failures: 2, Errors: 1, Skipped: 0" (the last line is the total; skipped ones did not pass)
    const surefire = [...text.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)(?:, Skipped: (\d+))?/g)].at(-1);
    if (surefire) add(num(surefire[1]) - num(surefire[2]) - num(surefire[3]) - num(surefire[4] ?? 0), num(surefire[2]) + num(surefire[3]), surefire[1]);
    // gradle: "12 tests completed, 2 failed"
    for (m of text.matchAll(/(\d+) tests? completed(?:, (\d+) failed)?/g)) add(num(m[1]) - num(m[2] ?? 0), m[2] ?? 0, m[1]);
    // dotnet: "Failed:     0, Passed:    42, Skipped:     0, Total:    42"
    for (m of text.matchAll(/Failed:\s+(\d+), Passed:\s+(\d+)(?:, Skipped:\s+\d+)?, Total:\s+(\d+)/g)) add(m[2], m[1], m[3]);
    // go: "ok  	example.com/pkg	0.012s" lines, "FAIL	example.com/pkg	0.3s", "--- FAIL: TestX"
    const goOk = (text.match(/^ok[ \t]+\S+[ \t]+(?:\(cached\)|[\d.]+s)/gm) ?? []).length;
    const goFail = (text.match(/^(?:FAIL[ \t]+\S+[ \t]+(?:[\d.]+s|\[)|--- FAIL: \S+)/gm) ?? []).length;
    if (goOk || goFail) add(goOk, goFail);
    // bun: " 41 pass", " 0 fail", "Ran 41 tests across 7 files."
    const bunPass = [...text.matchAll(/^\s*(\d+) pass\s*$/gm)].at(-1);
    if (bunPass) add(bunPass[1], [...text.matchAll(/^\s*(\d+) fail\s*$/gm)].at(-1)?.[1] ?? 0);
    // deno: "ok | 12 passed | 0 failed (1s)", "FAILED | 11 passed | 1 failed"
    for (m of text.matchAll(/\b(?:ok|FAILED) \| (\d+) passed(?: \(\d+ steps?\))? \| (\d+) failed\b/g)) add(m[1], m[2]);
    // ctest: "100% tests passed, 0 tests failed out of 12"
    for (m of text.matchAll(/\d+% tests passed, (\d+) tests? failed out of (\d+)/g)) add(num(m[2]) - num(m[1]), m[1], m[2]);
    // xcodebuild and XCTest: "Executed 42 tests, with 1 failure (0 unexpected) in 1.2 (1.3) seconds"
    for (m of text.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)) add(num(m[1]) - num(m[2]), m[2], m[1]);
    // flutter and dart: "00:05 +42: All tests passed!", "00:07 +40 -2: Some tests failed."
    for (m of text.matchAll(/\+(\d+)(?: ~\d+)?(?: -(\d+))?: (?:All tests passed|Some tests failed)/g)) add(m[1], m[2] ?? 0);
    // bazel: "Executed 3 out of 3 tests: 3 tests pass.", "… 2 tests pass and 1 fails locally."
    for (m of text.matchAll(/Executed \d+ out of (\d+) tests?: (?:(\d+) tests? pass(?:es)?)?(?:\s*and\s*)?(?:(\d+) fails?)?/g)) if (m[2] || m[3]) add(m[2] ?? 0, m[3] ?? 0, m[1]);
    // sbt: "Passed: Total 42, Failed 0, Errors 0, Passed 42"
    for (m of text.matchAll(/Total (\d+), Failed (\d+), Errors (\d+), Passed (\d+)/g)) add(m[4], num(m[2]) + num(m[3]), m[1]);
    // dbt: "Done. PASS=4 WARN=0 ERROR=0 SKIP=0 TOTAL=4"
    for (m of text.matchAll(/\bPASS=(\d+) WARN=\d+ ERROR=(\d+)(?: SKIP=\d+)?(?: NO-OP=\d+)? TOTAL=(\d+)/g)) add(m[1], m[2], m[3]);
    // Plain words: "101 passed, 0 failed", "12/12 passed", "All 42 tests passed", "42 tests passed", "3 tests, 0 failures"
    for (m of text.matchAll(/\b(\d+) (?:tests? |checks? )?passed,?\s+(\d+) failed\b/gi)) add(m[1], m[2]);
    for (m of text.matchAll(/\b(\d+)\s*\/\s*(\d+) (?:tests? |checks? )?(?:passed|passing|ok|green)\b/gi)) add(m[1], num(m[2]) - num(m[1]), m[2]);
    for (m of text.matchAll(/\ball (\d+) (?:tests?|checks?|specs?) (?:passed|pass|ok)\b/gi)) add(m[1], 0, m[1]);
    for (m of text.matchAll(/\b(\d+) (?:tests?|specs?|checks?) (?:passed|ok)\b(?![,;]\s*\d+ failed)/gi)) add(m[1], 0);
    for (m of text.matchAll(/\b(\d+) tests?, (\d+) failures?\b/gi)) add(num(m[1]) - num(m[2]), m[2], m[1]);
    // PASS/FAIL lines only: count them when nothing above matched.
    if (found.length === 0) {
        // Gradle's test events print one line a test: "SettingsFragmentTest > survives configuration change PASSED".
        const passLines = (text.match(/^\s*(?:✓|✔|PASS\b|ok \d+ )|^\s*\S[^\n]* > [^\n]+ PASSED\s*$/gm) ?? []).length;
        const failLines = (text.match(/^\s*(?:✗|✘|×|FAIL\b|not ok \d+ )|^\s*\S[^\n]* > [^\n]+ FAILED\s*$/gm) ?? []).length;
        if (passLines + failLines >= 2) add(passLines, failLines);
    }
    // A workspace run prints one summary per package (`@acme/schemas: Tests 58 passed`, `@acme/api: Tests: 141 passed`):
    // the last is the run's, and each one's count was printed too.
    const last = found.at(-1);
    // `for i in 1 2 3 4 5; do npx jest cart; done`: a run of the loop that failed, though the last one passed.
    const worst = Math.max(found.reduce((n, f) => Math.max(n, f.failed), 0), tapFails.length > 1 ? Math.max(...tapFails) : 0);
    const once = last && (found.length > 1 || tapFails.length > 1) && last.failed === 0 && worst > 0 ? { failedOnce: worst } : {};
    if (last && !last.parts && found.length > 1) {
        const parts = [...new Set(found.map((f) => f.passed))];
        if (parts.length > 1) return { ...last, parts, clean: [...new Set(found.filter((f) => f.failed === 0).map((f) => f.passed))], ...once };
    }
    return last && { ...last, ...once };
}

/** The first file hash or commit in the output: sha256, a full commit id, or a short one in a push or commit line. */
export function hashIn(text) {
    if (typeof text !== 'string') return undefined;
    const long = /\b[0-9a-f]{64}\b|\b[0-9a-f]{40}\b/i.exec(text);
    if (long) return long[0].toLowerCase();
    const short = /\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b|^\[[\w./-]+ ([0-9a-f]{7,12})\]|\bcommit ([0-9a-f]{7,40})\b/m.exec(text);
    return short ? (short[2] ?? short[3] ?? short[4]).toLowerCase() : undefined;
}

const UNIT = '(?:ms|s|sec|secs|seconds|min|%|pp|MB|GB|KB|kB|B|MiB|GiB|KiB|tok\\/s|tokens\\/s|t\\/s|req\\/s|rps|qps|ops\\/s|fps|x|°C|items|rows|errors|warnings)';
const DELTA = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\s*(?:→|->|=>|⟶|\\bto\\b)\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}`, 'i');
const BEFORE_AFTER = /\bbefore\b[^\n]{0,30}?(\d+(?:\.\d+)?)[^\n]{0,60}?\bafter\b[^\n]{0,30}?(\d+(?:\.\d+)?)/i;
/** A benchmark tool's own comparison: benchstat's "-56.70% (p=0.000 n=10)", criterion's "change: [-45.1% …]", hyperfine's "2.31 ± 0.05 times faster than". */
const BENCH_CHANGE = /[-+−]\d+(?:\.\d+)?%\s*\(p\s*=\s*\d|\bchange:\s*\[\s*[-+−]?\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?\s*(?:±\s*\d+(?:\.\d+)?\s*)?times (?:faster|slower) than\b/i;

/** The first metric that moved in the output ("p50 310 ms -> 120 ms", "before 42 … after 7"), as quoted text. */
export function metricIn(text) {
    if (typeof text !== 'string') return undefined;
    const m = DELTA.exec(text) ?? BEFORE_AFTER.exec(text) ?? BENCH_CHANGE.exec(text);
    if (!m) return undefined;
    const start = Math.max(0, text.lastIndexOf('\n', m.index) + 1);
    const end = text.indexOf('\n', m.index + m[0].length);
    return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 120);
}

const NUMS = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+\.\d+|\d+)\s?(ms|µs|us|ns\/op|ns|s|sec|secs|seconds|min|mins|%|x|×|kib|mib|gib|kb|mb|gb|b|bytes|req\/s|rps|qps|ops\/s|tok\/s|fps)?(?![\w/])/gi;
const MAX_NUMS = 64;

/**
 * The figures an output prints, for checking the figures a claim quotes:
 * numbers with a unit or a decimal point first, then whole numbers. Times
 * also count in the other unit (1.8 s is 1800 ms). Capped.
 */
export function numsIn(text) {
    if (typeof text !== 'string' || text === '') return [];
    const strong = new Set();
    const weak = new Set();
    for (const m of text.matchAll(NUMS)) {
        const value = num(m[1]);
        if (!Number.isFinite(value)) continue;
        const unit = (m[2] ?? '').toLowerCase();
        if (unit || /[.,]/.test(m[1])) {
            strong.add(value);
            if (unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'seconds') strong.add(Math.round(value * 1000 * 1000) / 1000);
            if (unit === 'ms') strong.add(value / 1000);
            // 1843 ns/op is 1.8 µs; 0.28 µs is 280 ns.
            if (unit === 'ns' || unit === 'ns/op') strong.add(value / 1000);
            if (unit === 'µs' || unit === 'us') { strong.add(value * 1000); strong.add(value / 1000); }
            if (unit === 'min' || unit === 'mins') strong.add(value * 60);
        } else if (value >= 2) weak.add(value);
        if (strong.size >= MAX_NUMS) break;
    }
    return [...strong, ...[...weak].filter((v) => !strong.has(v))].slice(0, MAX_NUMS);
}

/** Readings where a lower number is better. */
const LOWER_IS_BETTER = /^(p\d+(\.\d)?|mean|median|avg|average|latency|duration|time|took|size|bundle|memory|rss|heap|cpu|errors?|ns\/op|b\/op|allocs\/op)$/;
/** Readings that are times in ms. */
const IN_MS = /^(p\d+(\.\d)?|mean|median|avg|average|latency|duration|time|took)$/;
const SERIES = /\b(p\d{2}(?:\.\d)?|p\(\d{2}(?:\.\d)?\)|mean|median|med|avg|average|latency|duration|throughput)(?![\w(])(?:\s*±\s*σ\))?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|µs|us|s|sec|req\/s|rps|qps|ops\/s|tok\/s)?|(\d+(?:\.\d+)?)\s*(req\/s|rps|qps|ops\/s|tok\/s)\b/gi;

/** Benchmark readings in output order: `[{ l: 'p50', v: 310 }]`, times in ms. */
export function seriesIn(text) {
    if (typeof text !== 'string' || text === '') return [];
    const out = [];
    for (const m of text.matchAll(SERIES)) {
        // k6 writes "med=312.06ms p(95)=588.91ms"; "Req/Sec: avg 31.8" is a rate, not a time.
        let label = (m[1] ?? m[5] ?? '').toLowerCase().replace(/[()]/g, '');
        if (label === 'med') label = 'median';
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
        if (m[1] && !m[3] && /\b(?:req(?:uests)?\s*\/\s*s(?:ec)?|rps|qps|ops\s*\/\s*s(?:ec)?|throughput)\b/i.test(line)) label = 'rps';
        let value = num(m[2] ?? m[4]);
        const unit = (m[3] ?? m[5] ?? '').toLowerCase();
        if (!Number.isFinite(value)) continue;
        if (label === 'throughput') label = unit || 'rps';
        if (unit === 's' || unit === 'sec') value *= 1000;
        if (unit === 'µs' || unit === 'us') value /= 1000;
        out.push({ l: label, v: value });
        if (out.length >= 16) break;
    }
    // go test -bench: "BenchmarkParse-8   958414   1251 ns/op   384 B/op   6 allocs/op"
    for (const m of text.matchAll(/^Benchmark\S*\s+\d+\s+(\d+(?:\.\d+)?)\s+ns\/op\b/gm)) {
        if (out.length >= 16) break;
        out.push({ l: 'ns/op', v: num(m[1]) });
    }
    return out;
}

/** Measures of a model's quality, and which way is better. */
const QUALITY = /^(?:(train|training|val|valid|validation|dev|test|eval|holdout|macro|micro|weighted|mean|best|top)[_\s-]?)*(acc|accuracy|f1|auc|roc_auc|precision|recall|bleu|rouge\w*|map|ndcg|mrr|score|top-?[15]|em|exact_match|r2|loss|perplexity|ppl|wer|cer|mae|mse|rmse)$/i;
const LOWER_QUALITY = /^(loss|perplexity|ppl|wer|cer|mae|mse|rmse)$/i;
const READING = /(?<![\w.])([a-z][\w-]{0,30}?)\s*(?:[:=]\s*|\s{1,8})(-?\d*\.\d+|-?\d+)(?![\w.%])/gi;

/**
 * A coverage report's figures in percent, `{ statements?, branches?, functions?, lines?, total? }`: istanbul's table
 * ("All files | 81.42 | 70.1 | 79.3 | 82.06") or summary ("Statements : 81.42% ( 570/700 )"), coverage.py's
 * "TOTAL … 82%", go's "coverage: 81.4% of statements", tarpaulin's "81.42% coverage, 570/700 lines covered".
 */
export function coverageIn(text) {
    if (typeof text !== 'string' || !/coverage|%\s*Stmts|Statements\s*:|^TOTAL\s/im.test(text)) return undefined;
    const cov = {};
    const all = /%\s*Stmts\s*\|\s*%\s*Branch\s*\|\s*%\s*Funcs\s*\|\s*%\s*Lines/i.test(text) ? /^\s*All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/im.exec(text) : null;
    if (all) Object.assign(cov, { statements: Number(all[1]), branches: Number(all[2]), functions: Number(all[3]), lines: Number(all[4]) });
    for (const [key, word] of [['statements', 'Statements'], ['branches', 'Branches'], ['functions', 'Functions'], ['lines', 'Lines']]) {
        const m = new RegExp(`^\\s*${word}\\s*:\\s*([\\d.]+)%`, 'im').exec(text);
        if (m && cov[key] === undefined) cov[key] = Number(m[1]);
    }
    const py = /^TOTAL\s+(?:\d+\s+){2,4}([\d.]+)%\s*$/m.exec(text);
    if (py) cov.total = Number(py[1]);
    const go = [...new Set([...text.matchAll(/\bcoverage:\s*([\d.]+)%\s+of\s+statements\b/gi)].map((m) => m[1]))];
    if (go.length === 1 && cov.statements === undefined) cov.statements = Number(go[0]);
    const tp = /\b([\d.]+)%\s+coverage,\s+\d+\/\d+\s+lines\s+covered\b/i.exec(text);
    if (tp && cov.lines === undefined) cov.lines = Number(tp[1]);
    return Object.keys(cov).length ? cov : undefined;
}

/** A model's quality readings in output order: `[{ l: 'val_acc', m: 'acc', s: 'val', v: 0.871 }]`, at most 24. */
export function readingsIn(text) {
    if (typeof text !== 'string' || text === '') return [];
    const out = [];
    for (const m of text.matchAll(READING)) {
        const label = m[1].toLowerCase();
        const q = QUALITY.exec(label);
        if (!q) continue;
        const split = /^(train|training)/.test(label) ? 'train' : /^(val|valid|validation|dev)/.test(label) ? 'val' : /^(test|eval|holdout)/.test(label) ? 'test' : '';
        out.push({ l: label, m: q[2].toLowerCase().replace(/^accuracy$/, 'acc'), s: split, v: Number(m[2]) });
        if (out.length >= 24) break;
    }
    return out;
}

/** A benchmark table's metric columns. */
const TABLE_METRIC = /^(p\d{2}(\.\d)?|mean|median|avg|average|min|max|latency|duration|time|ops\/s|req\/s|rps|qps|tok\/s|throughput|ns\/op|allocs\/op|b\/op)$/i;
/** A table row that is the baseline the other row is measured against. */
const BASELINE = /^(main|master|trunk|baseline|base|before|old|control|current|reference)$/i;
const CELL = /^(-?\d{1,3}(?:,\d{3})+|-?\d+(?:\.\d+)?)\s*(ms|µs|us|ns|s|sec)?$/i;
const RATE_CELL = /^(-?\d{1,3}(?:,\d{3})+|-?\d+(?:\.\d+)?)\s*(ms|µs|us|ns|s|sec|rps|req\/s|qps|ops\/s|tok\/s)?$/i;
/** Column names that are surely the baseline. */
const STRONG_BASELINE = /^(main|master|trunk|baseline|base|before|old|control|reference)$/i;
const cellsOf = (line) => line.replace(/^\|\s*|\s*\|$/g, '').split(/\s*\|\s*|\t+|\s{2,}/).map((c) => c.trim()).filter(Boolean);

/**
 * A benchmark table of a baseline row and one other ("store  p50  p95 /
 * main  318ms  412ms / indexed  357ms  489ms") as readings in that order,
 * baseline first: `[{ l, v }]`, times in ms; empty when there is none.
 */
export function tableIn(text) {
    if (typeof text !== 'string' || text === '') return [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
    for (let h = 0; h < lines.length - 2; h += 1) {
        const head = cellsOf(lines[h]);
        if (head.length < 2 || !head.slice(1).some((c) => TABLE_METRIC.test(c))) continue;
        const rows = [];
        for (let r = h + 1; r < lines.length && rows.length < 3; r += 1) {
            if (/^[-=|+:\s]+$/.test(lines[r])) continue;
            const cells = cellsOf(lines[r]);
            if (cells.length !== head.length) break;
            const values = cells.slice(1).map((c) => CELL.exec(c));
            if (values.some((v) => !v)) break;
            rows.push({ label: cells[0], values: values.map((v) => {
                const unit = (v[2] ?? '').toLowerCase();
                const n = num(v[1]);
                return unit === 's' || unit === 'sec' ? n * 1000 : unit === 'µs' || unit === 'us' ? n / 1000 : unit === 'ns' ? n / 1e6 : n;
            }) });
        }
        if (rows.length !== 2) continue;
        const base = rows.findIndex((r) => BASELINE.test(r.label));
        if (base < 0 || BASELINE.test(rows[1 - base].label)) continue;
        const out = [];
        for (const row of [rows[base], rows[1 - base]]) {
            head.slice(1).forEach((label, at) => { if (TABLE_METRIC.test(label)) out.push({ l: label.toLowerCase(), v: row.values[at] }); });
        }
        return out;
    }
    // The measures as rows and the two runs as columns: "        baseline    current" / "p50   310ms   118ms".
    for (let h = 0; h < lines.length - 1; h += 1) {
        const head = cellsOf(lines[h]);
        if (head.length !== 2 || head.some((c) => TABLE_METRIC.test(c))) continue;
        // "baseline" and "before" name the baseline more surely than "current" does.
        const strong = head.map((c) => STRONG_BASELINE.test(c));
        const base = strong[0] !== strong[1] ? strong.indexOf(true) : head.findIndex((c) => BASELINE.test(c));
        if (base < 0 || (strong[0] === strong[1] && BASELINE.test(head[1 - base]))) continue;
        const rows = [];
        for (let r = h + 1; r < lines.length && rows.length < 8; r += 1) {
            if (/^[-=|+:\s]+$/.test(lines[r])) continue;
            const cells = cellsOf(lines[r]);
            if (cells.length !== 3 || !TABLE_METRIC.test(cells[0])) break;
            const values = cells.slice(1).map((c) => RATE_CELL.exec(c));
            if (values.some((v) => !v)) break;
            const label = cells[0].toLowerCase();
            rows.push({ l: label === 'throughput' ? 'rps' : label, values: values.map(cellValue) });
        }
        if (rows.length === 0) continue;
        return [...rows.map((row) => ({ l: row.l, v: row.values[base] })), ...rows.map((row) => ({ l: row.l, v: row.values[1 - base] }))];
    }
    return [];
}

/** A table cell's figure in ms for times; rates as they are. */
const cellValue = (v) => {
    const unit = (v[2] ?? '').toLowerCase();
    const n = num(v[1]);
    return unit === 's' || unit === 'sec' ? n * 1000 : unit === 'µs' || unit === 'us' ? n / 1000 : unit === 'ns' ? n / 1e6 : n;
};

/** File hashes an output lists ("<sha256>  dist/app.tar.gz", "SHA256 (app.tar.gz) = <sha256>"): `[{ h, f }]`, by file name. */
export function hashPairsIn(text) {
    if (typeof text !== 'string' || text === '') return [];
    const out = [];
    for (const line of text.split(/\r?\n/).slice(0, 400)) {
        const gnu = /^\s*(?:\d+\t)?([0-9a-f]{32,128})\s+[* ]?(\S+)\s*$/i.exec(line);
        const bsd = /^\s*(?:\d+\t)?(?:SHA\d+|MD5|BLAKE2\w*)\s*\((\S+)\)\s*=\s*([0-9a-f]{32,128})\s*$/i.exec(line);
        const h = gnu?.[1] ?? bsd?.[2];
        const f = gnu?.[2] ?? bsd?.[1];
        if (h && f) out.push({ h: h.toLowerCase(), f: f.split(/[\\/]/).pop() });
        if (out.length >= 8) break;
    }
    return out;
}

const MAX_LINE = 120;
/** The line of `text` at `index`, trimmed and clipped. */
function lineAt(text, index) {
    const start = text.lastIndexOf('\n', index) + 1;
    const end = text.indexOf('\n', index);
    return clip(text.slice(start, end < 0 ? undefined : end).trim(), MAX_LINE);
}
/** An output's first two and last six lines, for checking a claim that quotes them. */
function linesOf(text) {
    const all = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !/^\[(stderr|exit code: -?\d+)\]$/.test(l));
    const keep = all.length > 8 ? [...all.slice(0, 2), ...all.slice(-6)] : all;
    return keep.map((l) => clip(l, MAX_LINE));
}

/** Output that says a deploy, push or publish went through (true), failed (false), or neither (undefined). */
export function deployIn(text) {
    if (typeof text !== 'string' || text === '') return undefined;
    if (/(\[rejected\]|\[remote rejected\]|failed to push|\bERR! (code|publish|403|404)\b|\bdeploy(ment)? failed\b|\brelease failed\b|\brollout failed\b|\berror: failed\b|^fatal:|\bpermission denied\b|\bdenied:|\bauthentication failed\b|\b403 Forbidden\b|\b401 Unauthorized\b|\bchecks failed\b|\btimed out waiting\b|\bexceeded its progress deadline\b|\bfailed to (deploy|release|publish|upload)\b|\bError: (?!0\b))/im.test(text)) return false;
    if (/^\s+[0-9a-f]{7,12}\.\.\.?[0-9a-f]{7,12}\s+\S+\s+->\s+\S+/m.test(text)) return true;
    if (/^\s*\*\s+\[new (branch|tag)\]\s+\S+\s+->\s+\S+/m.test(text)) return true;
    if (/^\+\s+[@\w./-]+@\d+\.\d+\.\d+/m.test(text)) return true;
    if (/\bEverything up-to-date\b/.test(text)) return true;
    if (/: digest: sha256:[0-9a-f]{12,}/.test(text)) return true;
    if (/\b(Merged pull request|Squashed and merged|Rebased and merged|✓ Merged)\b/i.test(text)) return true;
    if (/\b(deployed|deployment (complete|completed|succeeded|successful|is live|ready)|successfully (deployed|released|published|rolled out|uploaded)|rollout complete|release (v?\S+ )?(created|published)|published to|live at|now live|uploaded to|version \S+ is live|Released v\d+|Production: https?:|Published|Uploading distributions|View at:\s+https?:|Apply complete!|deployment "\S+" successfully rolled out)\b/i.test(text)) return true;
    if (/\bHTTP\/[\d.]+ 2\d\d\b|\b(200|201|202|204) (OK|Created|Accepted|No Content)\b|"status"\s*:\s*"(ok|healthy|success|deployed|live)"/i.test(text)) return true;
    return undefined;
}

/** The line of a CI read that shows a failure: "X  ci  main  push  1h", "build  fail  2m". */
const CI_FAILED = /^.*(?:^\s*(?:X|✗|✘|×)\s|\bfail(?:ed|ure|ing)?\b|\bcancell?ed\b|\btimed[_ ]out\b|\baction_required\b).*$/im;

/** A CI read that shows success (true), failure (false), or neither. */
export function ciIn(text) {
    if (typeof text !== 'string' || text === '') return undefined;
    // "0 cancelled, 0 failing, 4 successful": a count of none is not a failure.
    const t = text.replace(/\b(0|no|zero) (failed|failures?|failing|cancell?ed|timed[_ ]out|errors?|errored|pending|queued|skipped)\b/gi, ' ');
    if (/^\s*(X|✗|✘|×)\s|\bfail(ed|ure|ing)?\b|\bcancell?ed\b|\btimed[_ ]out\b|\baction_required\b|\bconclusion["']?\s*:\s*["']?(failure|cancelled)/im.test(t)) return false;
    if (/^\s*(\*|•|pending|in_progress|queued)\s|\b(in progress|pending|queued|in_progress|waiting)\b/im.test(t) && !/\b(success|passed|completed|successful)\b|✓|✔/i.test(t)) return undefined;
    if (/\b(success|successful|passed|completed\s+success|all checks (have )?passed|conclusion["']?\s*:\s*["']?success)\b|✓|✔/i.test(t)) return true;
    return undefined;
}

/** The HTTP status a request printed: a number, 'ok' for a healthy body, 0 for no answer; undefined when it does not say. */
export function statusIn(text) {
    if (typeof text !== 'string') return undefined;
    const head = [...text.matchAll(/\bHTTP\/[\d.]+\s+(\d{3})\b/g)].at(-1);
    if (head) return Number(head[1]);
    const curlError = /\bcurl: \(\d+\)[^\n]*?\b(?:error|returned)[^\n]*?\b([1-5]\d\d)\b/i.exec(text);
    if (curlError) return Number(curlError[1]);
    // A bare code, as `curl -w '%{http_code}'` prints it, alone or before its time ("200 9.31s", "200 0.183412").
    const bare = /^\s*(\d{3})(?:\s+\d+(?:\.\d+)?\s*(?:m?s)?)?\s*$/m.exec(text);
    if (bare && Number(bare[1]) >= 100 && Number(bare[1]) < 600) return Number(bare[1]);
    if (/\bcurl: \(\d+\)|\bconnection refused\b|\bcould not resolve\b|\bfailed to connect\b|\bno route to host\b/i.test(text)) return 0;
    const body = text.replace(/\[stderr\][\s\S]*$/, '').trim();
    if (/^("?(ok|healthy|up|pong|alive|ready|pass)"?|\{[^{}]{0,300}"(status|state|health)"\s*:\s*"(ok|healthy|up|pass|passing|ready|green|success)"[^{}]{0,300}\})$/i.test(body)) return 'ok';
    if (/^\{[^{}]{0,300}"(status|state|health)"\s*:\s*"(down|unhealthy|fail|failing|error|degraded|red)"/i.test(body)) return 503;
    return undefined;
}

/** What an output says about health checks: true when they pass, false when one fails, else undefined. */
export function healthIn(text) {
    if (typeof text !== 'string' || text === '') return undefined;
    if (/\b(health ?checks? (failed|failing)|unhealthy|failing health|readiness probe failed|liveness probe failed)\b|\b(GET|HEAD) \S+ -> [45]\d\d\b|\bCrashLoopBackOff\b/i.test(text)) return false;
    if (/\b(health ?checks? (passing|passed|ok)|all checks passing|is now in a good state|\bhealthy\b|readiness probe succeeded)\b|\b(GET|HEAD) \S+ -> 2\d\d\b/i.test(text)) return true;
    return undefined;
}

/** The word a status read reports on its own line ("Status: Succeeded"), as printed; the last one wins. */
function stateIn(text) {
    if (typeof text !== 'string' || text === '') return undefined;
    return [...text.matchAll(/(?:^|\n|[{,])\s*"?(?:status|phase|state|result|conclusion)"?\s*[:=]\s*"?([A-Za-z_]+)/gi)].at(-1)?.[1];
}

/** A job state a status read prints without a key: a line that is only the word (`success`), or one in capitals in a table (`COMPLETED`). */
function stateWordIn(text) {
    if (typeof text !== 'string' || text === '') return undefined;
    const alone = [...text.matchAll(/^\s*(success|succeeded|failed|running|queued|completed|cancell?ed)\s*$/gim)].at(-1);
    if (alone) return alone[1];
    return [...text.matchAll(/\b(COMPLETED|SUCCEEDED|FAILED|CANCELL?ED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|RUNNING|PENDING)\b/g)].at(-1)?.[1];
}

/** The state a status read reports on its own line ("Status: Succeeded", "phase: Failed", `"state": "RUNNING"`): true, false or 'running'. */
export function endedIn(text) {
    const said = (stateIn(text) ?? stateWordIn(text))?.toLowerCase();
    if (!said) {
        // `kubectl wait --for=condition=complete` and `kubectl get job` say it their own way.
        if (/\bcondition met\b/i.test(text ?? '')) return true;
        const done = /^\s*NAME\s+COMPLETIONS\b[^\n]*\n\s*\S+\s+(\d+)\/(\d+)\s/m.exec(text ?? '');
        return done ? (done[1] === done[2] ? true : 'running') : undefined;
    }
    if (/^(succeeded|success|successful|completed?|done|finished|ok|passed)$/.test(said)) return true;
    if (/^(failed|failure|error|errored|cancell?ed|aborted|timedout|timed_out|timeout|killed|crashed|lost|terminated|oomkilled)$/.test(said)) return false;
    if (/^(pending|running|queued|in_progress|inprogress|submitted|starting|started|scheduled|waiting|active|runnable)$/.test(said)) return 'running';
    return undefined;
}

/** What a benchmark run says about speed: false when it says it got slower, true when faster; else undefined. */
const SLOWER = /\b(performance has regressed|performance regression|regressed by|regression detected|got slower|is slower|slower than (?:the )?(?:baseline|main|before|previous))\b/i;
const FASTER = /\b(performance has improved|improved by|got faster|is faster|faster than (?:the )?(?:baseline|main|before|previous))\b/i;

/** A deploy's own output that shows it pushed an image: fly's "--> Pushing image done", docker's "<tag>: digest: sha256:… size: N". */
const IMAGE_PUSHED = /^-->\s+Pushing image done\b|^\S+: digest: sha256:[0-9a-f]{12,} size: \d+|\bimage pushed\b|\bpushed image\b/im;
/** The end of a run that crashed: a traceback, a panic, an exception nobody caught. */
const CRASHED = [
    // Python: a traceback whose last line is the exception
    /Traceback \(most recent call last\):[\s\S]*\n[\w.]*(?:Error|Exception|Interrupt|Exit)\b[^\n]*\s*$/,
    // Go: a panic and its goroutines
    /(?:^|\n)panic: [^\n]*\n[\s\S]*\bgoroutine \d+ \[/,
    // Rust: a thread that panicked
    /(?:^|\n)thread '[^']*' panicked at\b/,
    // Java and PHP: an exception nobody caught
    /(?:^|\n)Exception in thread "[^"]*"|(?:^|\n)(?:PHP )?Fatal error: Uncaught\b/,
    // Node: a stack, then the version line it prints when it dies
    /\n\s+at [^\n]+\n(?:\s*\n)?Node\.js v\d+[^\n]*\s*$/,
];
/** The line that names a crash: a panic's own line, else the last exception line ("ValueError: …"). */
function crashLine(text) {
    const first = /^(?:panic: |thread '[^']*' panicked at|Exception in thread |(?:PHP )?Fatal error: Uncaught).*$/m.exec(text);
    const last = [...text.matchAll(/^[\w.]*(?:Error|Exception)\b.*$/gm)].at(-1);
    return clip(((first ?? last)?.[0] ?? 'a crash').trim().replace(/[.\s]+$/, ''), 80);
}
/** A failure marked in a test run's output: "run 23: FAIL", "FAILED tests/x.py", TAP's "not ok 3", "✗ case"; not "FAIL: 0" or "0 failed". */
const FAIL_MARK = /(?<![\w-])(?<!\b(?:0|no|zero)\s)FAIL(?:ED|URE|S)?(?![\w-])(?!\s*[:=]?\s*0\b)|^\s*not ok \d+\b|^\s*[✗✘×]\s/m;

/** The names of the checks a CI read lists ("phpunit (8.2)\tpass\t4m12s\t…", "✓ build in 1m2s"): lower case, at most 16. */
export function checksIn(text) {
    if (typeof text !== 'string' || text === '') return [];
    const out = new Set();
    for (const line of text.split(/\r?\n/).slice(0, 200)) {
        const tab = /^([^\t]{1,60})\t(?:pass|fail|pending|skipping|skipped|cancell?ed|success|failure|neutral|queued|in_progress)\b/i.exec(line);
        const mark = tab ? null : /^\s*(?:✓|✔|X|✗|✘|×|\*|-)\s+(\S.{0,58}?)(?:\s{2,}|\t|\s+in\s+\d|\s+\(ID\s|\s*$)/.exec(line);
        const name = (tab?.[1] ?? mark?.[1])?.trim().toLowerCase();
        if (name) out.add(name);
        if (out.size >= 16) break;
    }
    return [...out];
}

/** Pods or services that are not well, in a status read. */
const UNWELL_STATE = /\b(CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|CreateContainerConfigError|Evicted|failed \(Result|inactive \(dead\)|Exited \(\d+\)|unhealthy|Restarting|Error|FAILED|\w*ROLLBACK_\w+|circuit breaker)\b/;
const UNWELL = new RegExp(`${UNWELL_STATE.source}|^\\S+\\s+0\\/\\d+\\s`, 'm');
/** Pods or services that are well, in the same kind of read. */
const WELL = /^\S+\s+(\d+)\/\1\s+Running\b|\bactive \(running\)|\bUp \d+ (seconds?|minutes?|hours?|days?)\b(?! \(unhealthy\))/m;

/** The warnings an output reports: its summary count, or its `warning:` lines. */
export function warningsIn(text) {
    if (typeof text !== 'string' || text === '') return 0;
    let n = 0;
    for (const m of text.matchAll(/\b(\d+)\s+warn(?:ing)?s?\b|\bwarnings?:\s*(\d+)\b|\b(\d+)\s+Warning\(s\)/gi)) n = Math.max(n, Number(m[1] ?? m[2] ?? m[3]));
    const lines = (text.match(/^[^\n]*\bwarning\b\s*(?::|\[|\s{2,})[^\n]*$/gim) ?? []).length;
    return Math.max(n, lines);
}

/** HTTP statuses a run reports having seen ("Expected status 503, got 200", "HTTP/1.1 404"), at most four. */
export function codesIn(text) {
    if (typeof text !== 'string' || text === '') return [];
    const out = new Set();
    for (const m of text.matchAll(/\b(?:got|received|returned|responded with|status(?:\s+code)?|statusCode|response code)\s*[:=]?\s*([1-5]\d\d)\b|\bHTTP\/[\d.]+\s+([1-5]\d\d)\b/gi)) {
        out.add(Number(m[1] ?? m[2]));
        if (out.size >= 4) break;
    }
    return [...out];
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Words as a message and a reply both say them: lower case, no quotes or Markdown marks, single spaces. */
const flatWords = (text) => String(text ?? '').toLowerCase().replace(/[`*_"“”'‘’]/g, '').replace(/\s+/g, ' ').trim();
/** The person's message holds the claim's whole sentence: the person dictated it ("Reply: mean latency dropped from 200 ms to 50 ms."). */
const dictated = (prompt, claim) => {
    const said = flatWords(claim?.text ?? claim?.part);
    return said.length >= 12 && flatWords(prompt).includes(said);
};
/** A command as a card shows it: a program run by its full path is named by its own name (`node --test a.test.mjs`, not `/opt/tools/node-v22/bin/node --te…`), so a long path does not hide what ran. A program starts the line, follows `&&`, `||`, `;`, `|` or `(`, or follows a word that runs the next one (a loop's `do`, `then`, `sudo`, …); a path that is only an argument stays whole. */
const shownCommand = (command) => oneLine(command).replace(/(^|&&|\|\||[;|(]|(?<![^\s;&|(])(?:do|then|else|elif|if|while|until|exec|env|nohup|sudo|xargs|!|\{)(?=\s))(\s*)\/(?:[^\s/'"]+\/)+([^\s/'"]+)(?=\s|$)/g, '$1$2$3');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The command a shell call ran, from its arguments (an object, or JSON text). */
export function commandOf(args) {
    let a = args;
    if (typeof a === 'string') {
        try { a = JSON.parse(a); } catch { return oneLine(a); }
    }
    if (!a || typeof a !== 'object') return '';
    const c = a.command ?? a.cmd ?? a.script ?? a.input ?? a.code;
    return Array.isArray(c) ? c.join(' ') : typeof c === 'string' ? c : '';
}

/** The file a change or read tool worked on, from its arguments. */
function fileOf(args) {
    let a = args;
    if (typeof a === 'string') {
        try { a = JSON.parse(a); } catch { return ''; }
    }
    if (!a || typeof a !== 'object') return '';
    const f = a.file_path ?? a.path ?? a.filePath ?? a.file ?? a.target ?? a.filename ?? a.notebook_path ?? (Array.isArray(a.paths) ? a.paths[0] : undefined);
    return typeof f === 'string' ? f : '';
}

/** The text a change tool writes, from its arguments: the new string, the content or the patch. */
function contentOf(args) {
    let a = args;
    if (typeof a === 'string') {
        try { a = JSON.parse(a); } catch { return a; }
    }
    if (!a || typeof a !== 'object') return '';
    const c = a.new_string ?? a.content ?? a.patch ?? a.diff ?? a.text ?? (Array.isArray(a.edits) ? a.edits.map((e) => e?.new_string ?? '').join('\n') : '');
    return typeof c === 'string' ? c.slice(0, 20000) : '';
}

const base = (path) => path.split(/[\\/]/).filter(Boolean).slice(-2).join('/');

/** How a run went, from its exit and what its output says. */
function outcome(exit, extra) {
    if (extra === false) return false;
    if (typeof exit === 'number') return exit === 0;
    if (exit === null) return extra ?? null;
    return false;
}

/** What kind of run a shell command is. */
/** A test run limited to some tests: a name filter, a single file or a single test. */
const FILTERED_RUN = /\s(-k|-t|--testNamePattern|--grep|-g|-run|--run|--filter|--tests|--select)\s|\s-only-testing:\S|\s-Dtest=|\s(-k|-t|--grep|--filter|--testNamePattern)=|\bpytest\b[^|;&]*\s-m\s|::\w|\.(test|spec)\.[cm]?[jt]sx?\b|_spec\.rb(:\d+)?\b|\btest_\w+\.py\b|\b\w+_test\.(?:exs|dart)(?::\d+)?\b|\b\w+(?:Test|Tests|Spec)\.(?:php|kt|java|cs|swift|scala)\b|\bcargo\s+(test|nextest\s+run)\s+(--?[\w-]+(=\S+)?\s+)*(?!--?)[a-z_][\w:]*/;
/** A package the workspace tool picks, not tests the runner picks: `pnpm --filter @acme/utils test`, `turbo run test --filter=web`. */
const PACKAGE_PICK = /(\b(?:pnpm|turbo)\b[^|;&]*?)\s(?:--filter|-F)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s|;&]+)/;
function unpicked(command) {
    let out = command;
    for (let n = 0; n < 4 && PACKAGE_PICK.test(out); n += 1) out = out.replace(PACKAGE_PICK, '$1');
    return out;
}
/** A line of a test run that names a failure: `FAIL src/date.test.ts`, `× parses ISO weeks`, `--- FAIL: TestParse`. */
const FAIL_LINE = /(?:^|\s)(?:FAIL(?:ED)?\b|[✗×✖]|not ok\b|---\s*FAIL\b|●)|\bfail(?:ed|ing|ure|ures)?\b|^\s*\d+\)\s+\S/i;
/** The words of the part a filtered run covered: its test files' own names and its name filters (`invoice mailer` for `mix test test/billing/invoice_mailer_test.exs`). */
const focusOf = (item) => (Array.isArray(item.focus) && item.focus.length ? item.focus : Array.isArray(item.filter) ? item.filter : []).filter((w) => typeof w === 'string');
/** Whether a failing run names one of the words of a part: the failure is in that part. */
const failsOn = (item, words) => {
    const lines = Array.isArray(item.failLines) ? item.failLines : Array.isArray(item.lines) ? item.lines : [];
    return lines.some((l) => typeof l === 'string' && FAIL_LINE.test(l) && words.some((w) => l.toLowerCase().includes(w)));
};
/** A test run's filter given by a flag: `-k login`, `-t "parses dates"`, `--testNamePattern=Date`, `-run TestParse`. */
const FILTER_FLAG = /(?:^|\s)(?:-k|-t|--testNamePattern|--test-name-pattern|--grep|-g|-run|--run|--filter|--tests|--select|-Dtest|-only-testing)(?:=|\s+|(?<=-only-testing):)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/g;
/** Runners that take test files or name filters as plain words: `vitest run date`, `jest src/date`, `pytest tests/test_auth.py`. */
const POSITIONAL_RUNNER = /\b(?:vitest(?:\s+run)?|jest|mocha|ava|pytest|py\.test|rspec|phpunit|bun\s+test|deno\s+test|go\s+test|mix\s+test|(?:dart|flutter)\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?:\s+--)?)((?:\s+[^\s|;&>]+)*)/i;
/** Flags of those runners that take a value, so the word after them is not a filter. */
const VALUE_FLAG = /^-(?:c|-config|-reporter|-project|-dir|-root|-environment|-env|-shard|-maxWorkers|-max-workers|-testTimeout|-test-timeout|-outputFile|-output-file|-workspace|-filter|-pool|-mode|-color|-cov-report|-cov|-tb|-junitxml|-durations|-maxfail|p|-rootdir|-basetemp|-ignore|-deselect|m|-require|r|-timeout|-format|f|o|-count|count|-parallel|parallel|-tags|tags|-run|run|k|t|g|-grep|-testNamePattern|-tests|-select|-coverprofile|coverprofile|-bench|bench)$/;
/** Words that say nothing about which tests a filter picks. */
const FILTER_GENERIC = new Set('test tests spec specs src lib app pkg cmd internal py ts js tsx jsx mjs cjs rb go rs unit integration e2e the and not or true false verbose dot json coverage run all main index'.split(' '));
/** The words a test run was limited by, lower case: `['date']` for `vitest run date`; empty for a whole run. */
function filterOf(command) {
    const words = new Set();
    const add = (text) => {
        for (const part of String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
            if (part.length >= 3 && !FILTER_GENERIC.has(part) && !/^\d+$/.test(part)) words.add(part);
        }
    };
    // `-only-testing:FeedTests/PaginationTests`: its first part names the test bundle, not the tests.
    for (const m of command.matchAll(FILTER_FLAG)) add(/-only-testing/.test(m[0]) ? String(m[1] ?? m[2] ?? m[3]).replace(/^[^/]+\//, '') : m[1] ?? m[2] ?? m[3]);
    const pos = POSITIONAL_RUNNER.exec(command);
    if (pos) {
        const args = pos[1].trim().split(/\s+/).filter(Boolean);
        for (let at = 0; at < args.length; at += 1) {
            const arg = args[at];
            if (arg === '--') continue;
            if (arg.startsWith('-')) {
                if (!arg.includes('=') && VALUE_FLAG.test(arg)) at += 1;
                continue;
            }
            if (/^[\w-]+=/.test(arg) || arg === '.' || arg === './...' || /^\.\/?$/.test(arg)) continue;
            add(arg.replace(/\/\.\.\.$/, ''));
        }
    }
    return [...words].slice(0, 6);
}
/** The words of what a filtered run covered: a name filter's words and each test file's own name, not its folders. */
function focusOf_(command) {
    const words = new Set();
    const add = (text) => {
        for (const part of String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
            if (part.length >= 3 && !FILTER_GENERIC.has(part) && !/^\d+$/.test(part)) words.add(part);
        }
    };
    // `-only-testing:FeedTests/PaginationTests`: its first part names the test bundle, not the tests.
    for (const m of command.matchAll(FILTER_FLAG)) add(/-only-testing/.test(m[0]) ? String(m[1] ?? m[2] ?? m[3]).replace(/^[^/]+\//, '') : m[1] ?? m[2] ?? m[3]);
    const pos = POSITIONAL_RUNNER.exec(command);
    if (pos) {
        const args = pos[1].trim().split(/\s+/).filter(Boolean);
        for (let at = 0; at < args.length; at += 1) {
            const arg = args[at];
            if (arg.startsWith('-')) {
                if (!arg.includes('=') && VALUE_FLAG.test(arg)) at += 1;
                continue;
            }
            if (!/\.[a-z]{1,5}(?::\d+)?$/i.test(arg)) continue;
            add(arg.replace(/:\d+$/, '').split('/').at(-1).replace(/\.[a-z]{1,5}$/i, '').replace(/(?:[._-]?(?:test|spec)s?)$|^(?:test|spec)s?[._-]/i, ''));
        }
    }
    return [...words].slice(0, 6);
}
/** A run whose counts hold more than tests: `dbt build` counts models, seeds and snapshots with them. */
const MIXED_RUN = /\bdbt\s+build\b/i;
/** A request that only reads: curl, wget or httpie with no method that writes and no body. */
const READ_REQUEST = /^\s*(curl|wget|httpie|xh|http)\b(?![^|;&]*\s(-X\s*(POST|PUT|PATCH|DELETE)\b|--request\s+(POST|PUT|PATCH|DELETE)\b|-d\b|--data|-F\b|--form\b|-T\b|--upload-file\b))[^|;&]*$/i;

function kindOfCommand(command, tests) {
    const ships = targetsOf(command).some((t) => t === 'repo' || t === 'registry' || t === 'env');
    return TEST_CMD.test(command) ? 'test'
        : LINT_CMD.test(command) ? 'lint'
            : READ_REQUEST.test(command) ? 'probe'
            : ships ? 'deploy'
                : CI_CMD.test(command) ? 'ci'
                    : BUILD_CMD.test(command) ? 'build'
                        : HASH_CMD.test(command) ? 'hash'
                            : PROBE_CMD.test(command) || REGISTRY_READ_CMD.test(command) ? 'probe'
                                : tests ? 'test'
                                    : CHANGE_CMD.test(command) ? 'change' : 'run';
}

/** A run that only shows what it would do: `npm publish --dry-run`, `kubectl apply --dry-run=client`, `ansible-playbook --check`. */
const DRY_RUN = /\s--(?:dry-?run|what-?if|build-only|no-?deploy)\b(?!=false\b)|\bansible-playbook\b[^|;&]*\s(?:--check|-C)(?:\s|$)/i;

/** Where a shipping command sends the work: repo, registry, env; tag and merge for local ones. A dry run's step sends nothing. */
function targetsOf(command) {
    const out = new Set();
    if (READ_REQUEST.test(command)) return [];
    const steps = DRY_RUN.test(command) ? command.split(/&&|\|\||;|\n/).filter((step) => !DRY_RUN.test(step)) : [command];
    for (const step of steps) {
        if (PUSH_CMD.test(step)) out.add('repo');
        if (PUBLISH_CMD.test(step)) out.add('registry');
        if (RELEASE_CMD.test(step) || DEPLOY_REMOTE.test(step)) out.add('env');
        if (/\bgit\s+tag\b/i.test(step)) out.add('tag');
        if (/\bgit\s+(merge|rebase)\b/i.test(step)) out.add('merge');
    }
    return [...out];
}

/** Shell commands that only look: they change nothing and run nothing. */
const LOOK_CMD = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:cat|head|tail|less|more|ls|ll|tree|wc|file|stat|du|df|pwd|echo|printf|which|type|whoami|date|env|printenv|uname|grep|egrep|fgrep|rg|ag|ack|find|fd|jq|yq|diff|sha\d*sum|md5sum|git\s+(?:log|status|show|diff|branch|remote|rev-parse|describe|ls-files|blame|shortlog|reflog|grep)|gh\s+(?:pr|run|issue|release|repo)\s+(?:view|list|checks|status|diff)|kubectl\s+(?:get|describe|logs|top)|docker\s+(?:ps|images|logs|inspect)|npm\s+(?:view|info|ls|list|outdated)|pip3?\s+(?:show|list|freeze)|curl\s+(?![^|;&]*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|-d|--data\S*)\b))\b/i;

/** Whether an item only looked (a read, a status read, a search): a summary turn that only looked still rests on the turn before. */
export function looksOnly(item) {
    if (!item) return true;
    if (item.change || item.shipped !== undefined) return false;
    return item.kind === 'read' || item.kind === 'probe' || item.kind === 'ci' || (item.kind === 'run' && LOOK_CMD.test(item.cmd ?? ''));
}

const SEARCH_TOOL = /^(grep|search|rg|ripgrep|search_files|find_in_files|code_search)$/i;
const SEARCH_CMD = /(?:^|[;&|(]\s*|\s)(?:git\s+grep|grep|egrep|fgrep|rg|ag|ack)\s+((?:-{1,2}[\w-]+(?:=\S+)?\s+)*)(?:-e\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|(?!-)([^"'\s|;&]+))/;

/** What a search looked for and how many lines it found: the grep tool, or grep, rg, ag or ack in a shell. */
function searchOf(tool, args, out, command) {
    let term;
    if (SEARCH_TOOL.test(tool)) {
        let a = args;
        if (typeof a === 'string') {
            try { a = JSON.parse(a); } catch { a = {}; }
        }
        term = typeof a?.pattern === 'string' ? a.pattern : typeof a?.query === 'string' ? a.query : undefined;
    }
    else if (command) {
        const m = SEARCH_CMD.exec(command);
        term = m?.[2] ?? m?.[3] ?? m?.[4];
    }
    if (!term) return undefined;
    // `grep -rl X | xargs sed -i …`: the matches went to another command, so the output is not what the search found.
    if (command && /\b(?:grep|egrep|fgrep|rg|ag|ack)\b[^|;&]*\|\s*(?:xargs|while\b|parallel|sed\b|awk\b|perl\b|tee\b|cut\b|sort\s+-u\s*\|\s*xargs)/.test(command)) return undefined;
    // `… | wc -l`, `grep -c`, `rg --count`: the search prints a count, which is read as the number it prints.
    const flags = command ? SEARCH_CMD.exec(command)?.[1] ?? '' : '';
    const wc = command ? /\|\s*wc\s+-l\b/.test(command) : false;
    const countFlag = /(?:^|\s)(?:--count(?:-matches)?|-[a-zA-Z]*c[a-zA-Z]*)(?=\s|$)/.test(flags) || (SEARCH_TOOL.test(tool) && /"output_mode"\s*:\s*"count"|"count"\s*:\s*true/.test(typeof args === 'string' ? args : JSON.stringify(args ?? {})));
    // What an `echo` chained after the search prints is not a match ("grep -n oban mix.exs; echo done").
    const echoed = new Set([...(command ?? '').matchAll(/\becho\s+(["']?)([^"';&|\n]{1,80})\1/g)].map((m) => m[2].trim()));
    const body = out.replace(/^\[(stderr|exit code: -?\d+)\]$/gm, '').split(/\r?\n/).filter((l) => !echoed.has(l.trim())).join('\n').trim();
    const none = body === '' || /^\(no output\)$/i.test(body) || /^(no (matches|files|results)( found)?\.?|found 0 (matches|files|results)|0 (matches|results))\b/i.test(body);
    if (wc || countFlag) {
        const counts = body.split(/\r?\n/).map((l) => /(?:^|:)\s*(\d+)\s*$/.exec(l.trim())).filter(Boolean).map((m) => Number(m[1]));
        const hits = none || counts.length === 0 ? 0 : wc ? counts.at(-1) : counts.reduce((a, n) => a + n, 0);
        return { term: clip(term, 80), hits, counted: true };
    }
    const hits = none ? 0 : body.split(/\r?\n/).filter((l) => l.trim() !== '' && !/^(\[|found \d+ |\(no output\))/i.test(l.trim())).length;
    return { term: clip(term, 80), hits };
}

/** What a search found, in words: "nothing found", "3 lines found", "a count of 2". */
const foundText = (search) => (search.hits === 0 ? 'nothing found' : search.counted ? `a count of ${search.hits}` : `${search.hits === 1 ? 'one line' : `${search.hits} lines`} found`);

/** Commands a tool's output says it ran itself: a deploy's release command, an npm script's echo, a CI log's "$ npm test". */
function innerRuns(out) {
    const found = [];
    for (const m of out.matchAll(/\b(?:release_command|release command|pre-?deploy command|post-?deploy command|build command|start command)\s*:\s*`?([^\n`]{2,120}?)`?\s*$/gim)) found.push(m[1].trim());
    for (const m of out.matchAll(/^\s*(?:Running|Executing)\s+(?:command\s*:?\s*)?`([^\n`]{2,120})`/gim)) found.push(m[1].trim());
    for (const m of out.matchAll(/^>\s+(?!\S+@\S+\s+\S+\s*$)([^\n]{2,120})$/gm)) found.push(m[1].trim());
    for (const m of out.matchAll(/^\s*\$\s+([^\n]{2,120})$/gm)) found.push(m[1].trim());
    return [...new Set(found)].slice(0, 8);
}

/** A command with git's own options before its subcommand dropped: `git -C app push` reads as `git push`. */
/** Git commands that print a commit record ("[main 1a2b3c4] msg") when they make a commit. */
const GIT_RECORD_CMD = /\bgit\s+(?:commit|revert|cherry-pick)\b/;
const GIT_OPTS = /\bgit((?:\s+(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--(?:git-dir|work-tree|namespace|exec-path)(?:=|\s+)\S+|\s+--no-pager|\s+--no-replace-objects|\s+--paginate|\s+-P)+)(?=\s)/g;
export const plainGit = (command) => String(command ?? '').replace(GIT_OPTS, 'git');

/** A run that failed on its coverage threshold (jest, nyc, c8, vitest, pytest-cov, coverage.py's fail-under). */
const COVERAGE_GATE = /\bcoverage threshold for \w+ \([\d.]+%\) not met\b|\bCoverage for \w+ \([\d.]+%\) does not meet (?:global |per-file )?threshold\b|\bRequired test coverage of [\d.]+% not reached\b|\bCoverage failure: total of [\d.]+ is less than fail-under\b/i;
/** A claim about the coverage or the run's exit, which a coverage threshold's failure does speak to. */
const GATE_WORDS = /\b(?:coverage|covered|exit(?:s|ed)?|exit\s+code|ci|pipeline|checks?|the\s+run|green\s+build)\b/i;
/** A line that names a test that passed: TAP's "ok 1 - name", "✔ name (0.4ms)", "✓ name", pytest's "::name PASSED", go's "--- PASS: Name", unittest's "name (mod.Case) ... ok". */
const PASS_NAME = [
    /^[ \t]*ok \d+ - (.+?)(?:[ \t]+#.*)?[ \t]*$/,
    /^[ \t]*[✔✓√][ \t]+(.+?)(?:[ \t]+\(\d[\d.]*[ \t]*m?s\))?[ \t]*$/,
    /::([\w.[\]-]+)[ \t]+PASSED\b/,
    /^[ \t]*--- PASS: (\S+)/,
    /^[ \t]*(\w+) \([\w.]+\) \.\.\. ok[ \t]*$/,
    // jest's and vitest's file lines ("PASS  src/__tests__/cart.test.ts", "✓ src/cart.test.ts (4 tests)"), go's packages, cargo's tests.
    /^[ \t]*PASS[ \t]+(\S+\.[a-z]{2,4})\b/,
    /^ok[ \t]+(\S+)[ \t]+(?:\d[\d.]*s|\(cached\))/,
    /^[ \t]*test (\S+) \.\.\. ok[ \t]*$/,
];
/** The names of the tests a run printed as passing, at most 24. */
function passNamesIn(out) {
    const names = [];
    for (const line of out.split('\n')) {
        if (names.length >= 24) break;
        for (const re of PASS_NAME) {
            const m = re.exec(line);
            if (m && m[1].trim().length >= 3) {
                names.push(clip(m[1].trim(), 80));
                break;
            }
        }
    }
    return [...new Set(names)];
}

/**
 * An output with its long runs made short: blank lines, one character over and over (a rule of "=", padding, a
 * progress bar's updates), long numbers and long blank runs. They say nothing, and every reading stays quick on
 * whatever a tool prints (16 KB of blank lines took seconds before).
 */
export const compact = (text) => (text.length < 64 ? text : text
    .replace(/\r\n?/g, '\n')
    .replace(/\n(?:[ \t]*\n){2,}/g, '\n\n')
    .replace(/([^\n])\1{63,}/g, (m, c) => c.repeat(64))
    .replace(/\d{65,}/g, (m) => m.slice(0, 64))
    .replace(/[ \t]{65,}/g, (m) => m.slice(0, 64)));

/**
 * One tool call and its result as an evidence item:
 * `{ tool, kind, ok, exit?, cmd?, change?, code?, targets?, shipped?, status?, health?, tests?, hash?, metric?, series?, nums?, text }`.
 * `kind` is test, build, lint, ci, deploy, probe, hash, run, change, read or other;
 * bookkeeping tools (todos, goals, questions) give undefined.
 */
export function itemOf({ name, args, text, isError = false }) {
    const tool = String(name ?? '');
    if (tool === '' || BOOKKEEPING_TOOL.test(tool)) return undefined;
    const out = typeof text === 'string' ? compact(text) : '';
    const shell = SHELL_TOOL.test(tool);
    const asRun = shell ? commandOf(args) : '';
    const command = plainGit(asRun);
    const tests = testCountsIn(out);
    const hash = hashIn(out);
    const metric = metricIn(out);
    const table = tableIn(out);
    const series = table.length ? table : seriesIn(out);
    const nums = numsIn(out);
    const pairs = hashPairsIn(out);
    const exit = exitOf(out, { isError, shell });
    const facts = {};
    const warnings = warningsIn(out);
    if (warnings) facts.warnings = warnings;
    const codes = codesIn(out);
    if (codes.length) facts.codes = codes;
    if (tests && !(shell && /^(deploy|probe|lint|hash|build)$/.test(kindOfCommand(command, tests)))) {
        const picked = shell ? unpicked(command) : '';
        const filter = shell ? filterOf(picked) : [];
        facts.tests = { ...tests, ...(shell && (FILTERED_RUN.test(picked) || filter.length) ? { filtered: true } : {}), ...(shell && MIXED_RUN.test(command) ? { mixed: true } : {}) };
        if (filter.length) facts.filter = filter;
        const focus = shell && filter.length ? focusOf_(picked) : [];
        if (focus.length && focus.join() !== filter.join()) facts.focus = focus;
        // The lines that name what failed, which the kept head and tail may not hold.
        const failLines = tests.failed > 0 ? out.split(/\r?\n/).filter((l) => FAIL_LINE.test(l)).slice(0, 6).map((l) => clip(l.trim(), 120)) : [];
        if (failLines.length) facts.failLines = failLines;
        // Every test passed and the run failed on a coverage threshold: the tests are fine, the coverage is not.
        if (tests.failed === 0 && tests.passed > 0 && COVERAGE_GATE.test(out)) facts.gate = true;
        // And the tests it passed, by name: "`sum of an empty list is 0` — pass" is about one of them.
        const passNames = tests.failed > 0 && tests.passed > 0 ? passNamesIn(out) : [];
        if (passNames.length) facts.passNames = passNames;
    }
    if (hash) facts.hash = hash;
    // "[main 8c41d2e] install.sh: quote PREFIX paths": git made the commit, whatever a later step of the command did.
    const record = shell && GIT_RECORD_CMD.test(command) ? /^\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,12})\]/m.exec(out) : null;
    if (record) facts.committed = record[1];
    if (metric) facts.metric = metric;
    if (series.length) facts.series = series;
    // A table of a baseline row and one other is a before-and-after in one run.
    if (table.length) facts.ab = true;
    if (nums.length) facts.nums = nums;
    if (pairs.length) facts.pairs = pairs;
    const coverage = coverageIn(out);
    if (coverage) facts.coverage = coverage;
    const readings = readingsIn(out);
    if (readings.length) facts.readings = readings;
    const search = searchOf(tool, args, out, command);
    if (search) facts.search = search;
    const inner = shell ? innerRuns(out) : [];
    if (inner.length) facts.inner = inner;
    // "release_command 3d8d7e5b1c2a98 completed successfully": the deploy's release command went through, whatever came after.
    if (inner.length && /\brelease[_ ]command\b[^\n]{0,40}\b(?:completed successfully|succeeded|finished successfully)\b/i.test(out)) facts.released = true;
    else if (inner.length && /\brelease[_ ]command\b[^\n]{0,40}\b(?:failed|exited with (?:code )?[1-9])/i.test(out)) facts.released = false;
    const ciRead = shell && CI_CMD.test(command) ? ciIn(out) : undefined;
    // The checks a CI read lists, by name: "7 passed (phpunit on 8.2 and 8.3, …)" names them, not commands run here.
    const checks = shell && CI_CMD.test(command) ? checksIn(out) : [];
    if (checks.length) facts.checks = checks;
    const ended = ciRead ?? endedIn(out) ?? (shell && CI_CMD.test(command) && /\b(in progress|in_progress|queued|pending|waiting)\b/i.test(out) ? 'running' : undefined);
    if (ended !== undefined) {
        facts.ended = ended;
        const state = stateIn(out) ?? stateWordIn(out);
        if (state) facts.state = clip(state, 24);
    }
    const slower = SLOWER.exec(out);
    if (slower) facts.perf = { ok: false, said: lineAt(out, slower.index) };
    else if (FASTER.test(out)) facts.perf = { ok: true, said: lineAt(out, FASTER.exec(out).index) };
    if (shell) {
        const changes = CHANGE_CMD.test(command);
        const targets = targetsOf(command);
        // A deploy that builds and pushes its image on the way (`fly deploy`): the registry got it too.
        if (targets.includes('env') && !targets.includes('registry') && IMAGE_PUSHED.test(out)) targets.push('registry');
        const ships = targets.some((t) => t === 'repo' || t === 'registry' || t === 'env');
        const kind = kindOfCommand(command, tests);
        // A run that ended in a crash, though a pipe (`… 2>&1 | tail`) gave back exit 0.
        const tail = out.replace(/\s*\[exit code: -?\d+\]\s*$/, '');
        const crashed = CRASHED.some((re) => re.test(tail));
        // A test run whose counts did not parse, with a failure marked on a line of its own ("run 23: FAIL").
        const failMark = kind === 'test' && !tests ? FAIL_MARK.exec(out) : null;
        const http = kind === 'probe' && /\b(curl|wget|httpie|xh|hey|ab|http)\b/i.test(command) && !/\bkubectl\b/i.test(command) ? statusIn(out) : undefined;
        const health = healthIn(out);
        const registry = kind === 'probe' && REGISTRY_READ_CMD.test(command);
        const extra = crashed || failMark ? false
            : kind === 'test' && tests ? tests.failed === 0 && tests.passed > 0
            : kind === 'deploy' ? deployIn(out)
                : kind === 'ci' ? ciIn(out)
                    : kind === 'hash' ? (/\b(FAILED|did NOT match|BAD signature|mismatch)\b/i.test(out) ? false : undefined)
                        : kind === 'probe' && !registry ? (http !== undefined ? http === 'ok' || (http >= 200 && http < 400) : (UNWELL.test(out) || health === false ? false : undefined))
                            : (kind === 'build' || kind === 'lint') && /(^|\s)(error TS\d+|error\[E\d+\]|ERROR in |BUILD FAILED|FAILURE:|Failed to compile|compiled with \d+ errors?|✖ \d+ problems? \([1-9]\d* errors?)/m.test(out) ? false
                                : undefined;
        // A probe that answered says how it went even when the exit is 0 (curl prints 502 and exits 0).
        // grep's exit 1 with nothing printed is a search that found nothing, not a failure.
        const ok = search && search.hits === 0 && exit === 1 ? true : kind === 'probe' && http !== undefined && exit === 0 ? extra : outcome(exit, extra);
        const shipped = ships ? (kind === 'deploy' ? ok : outcome(exit, deployIn(out))) : undefined;
        // A download that went through (`curl -sO …` before a checksum) is a request that answered.
        const fetched = kind !== 'probe' && /\b(curl|wget)\b/i.test(command) && exit === 0 && !/\bcurl: \(\d+\)|\b(4\d\d|5\d\d) (Not Found|Forbidden|Unauthorized|Internal Server Error|Bad Gateway|Service Unavailable)\b/i.test(out);
        const ran = `\`${clip(shownCommand(asRun) || tool, 80)}\``;
        // A run that failed though it exited 0 (a CI read that lists a failed run, `npm test | tail`) is not said to have exited 0.
        const how = ok === false && exit === 0 ? 'ran' : typeof exit === 'number' ? `exited ${exit}` : exit === null ? 'ran' : exit === 'error' ? 'failed to run' : exit === 'denied' ? 'was denied by the sandbox' : exit === 'timeout' ? 'timed out' : `ended (${exit})`;
        // A status read that lists some pods well and some not ("2 in CrashLoopBackOff, 3 Running").
        const unwell = kind === 'probe' && http === undefined && UNWELL.test(out);
        const mixed = unwell && WELL.test(out);
        const detail = http !== undefined ? (http === 0 ? 'no answer' : http === 'ok' ? 'answered ok' : `HTTP ${http}`)
            : unwell ? `it shows ${UNWELL_STATE.exec(out)?.[1] ?? 'a pod that is not ready'}${mixed ? ' next to others running' : ''}`
            : crashed ? `it ended in a crash: ${crashLine(tail)}`
            : failMark ? `it printed "${lineAt(out, failMark.index)}"`
            : kind === 'ci' && ok === false && CI_FAILED.exec(out) ? `it shows a failure: "${lineAt(out, CI_FAILED.exec(out).index)}"`
            : search && kind === 'run' ? foundText(search)
            : facts.tests ? `${tests.passed} passed, ${tests.failed} failed`
                : hash ? hash.slice(0, 12)
                    : facts.state && kind !== 'ci' ? `status ${facts.state}`
                        : metric ?? (kind === 'deploy' && extra ? 'went through' : ok === false && exit === 0 ? 'its output reports a failure' : '');
        return {
            tool, kind, ok, exit,
            cmd: clip(oneLine(command), 240),
            ...(changes ? { change: true } : {}),
            // Read on the whole command: the kept `cmd` is cut short, and a long commit message hides how it ends.
            ...(changes && GIT_RECORD.test(command) ? { record: true } : {}),
            ...(CODE_CHANGE_CMD.test(command) ? { code: true } : {}),
            ...((APPLY_CMD.test(command) || MIGRATE_CMD.test(command)) && !DRY_RUN.test(command) ? { apply: true } : {}),
            ...(mixed ? { mixed: true } : {}),
            ...(targets.length ? { targets } : {}),
            ...(ships ? { shipped } : {}),
            ...(http !== undefined ? { status: http } : {}),
            ...(health !== undefined ? { health } : {}),
            ...(kind === 'ci' && /\b(deploy|publish|upload|release|rollout|ship)/i.test(out) ? { deploys: true } : {}),
            ...(JOB_CMD.test(command) || BACKGROUND_CMD.test(command) ? { job: true } : {}),
            ...(changes && (ROUTE_FILE.test(command) || ROUTE_CODE.test(command)) ? { route: true } : {}),
            ...(registry ? { registry: true } : {}),
            ...(fetched ? { fetched: true } : {}),
            ...(ships && /\bEverything up-to-date\b/.test(out) ? { upToDate: true } : {}),
            ...(series.length && /\b(before|baseline)\b[\s\S]*\b(after|patched|now)\b/i.test(out) ? { ab: true } : {}),
            ...facts,
            ...(out.trim() ? { lines: linesOf(out) } : {}),
            text: clip(`${ran} ${how}${detail ? `: ${detail}` : ''}`, 180),
        };
    }
    if (CHANGE_TOOL.test(tool)) {
        const file = fileOf(args);
        const ok = !isError && !/^\s*(error|failed|could not|cannot|no such file)/i.test(out);
        const route = ROUTE_FILE.test(file) || ROUTE_CODE.test(contentOf(args));
        return { tool, kind: 'change', ok, change: true, ...(file ? { file: clip(file, 240) } : {}), ...(DOC_FILE.test(file) ? {} : { code: true }), ...(route ? { route: true } : {}), ...facts, text: clip(`${tool}${file ? ` ${base(file)}` : ''}${ok ? '' : ' (failed)'}`, 180) };
    }
    if (READ_TOOL.test(tool)) {
        const file = fileOf(args);
        const looked = search ? ` ${search.term}: ${foundText(search)}` : '';
        return { tool, kind: 'read', ok: !isError, ...facts, text: clip(`${tool}${file ? ` ${base(file)}` : ''}${looked}`, 180) };
    }
    // Any other tool (a plugin's or a server's): its own words say how it went.
    const said = deployIn(out);
    const ok = isError ? false : typeof exit === 'number' ? exit === 0 : tests ? tests.failed === 0 : !/^\s*(error|failed|could not|cannot)\b/i.test(out);
    const kind = tests ? 'test' : said !== undefined && /deploy|release|publish|push/i.test(tool) ? 'deploy' : 'other';
    const first = oneLine(out).slice(0, 100);
    return { tool, kind, ok, ...(typeof exit === 'number' ? { exit } : {}), ...(kind === 'deploy' ? { shipped: ok && said !== false } : {}), ...facts, ...(out.trim() ? { lines: linesOf(out) } : {}), text: clip(`${tool}${first ? `: ${first}` : ''}`, 180) };
}

// ── Does the evidence back the claim ───────────────────────────────

const RUNS = new Set(['test', 'build', 'lint', 'ci', 'deploy', 'run', 'probe', 'hash']);
const ACCEPT = {
    tests: ['test'],
    build: ['build', 'test'],
    lint: ['lint'],
    ci: ['ci'],
    hash: ['hash'],
    any: ['test', 'build', 'lint', 'ci', 'hash'],
    run: ['test', 'build', 'lint', 'ci', 'hash', 'run', 'probe', 'deploy'],
};
/** Which runs show a fix worked, by what the claim is about. */
const FIX_CHECKS = {
    tests: ['test'],
    build: ['build', 'test'],
    lint: ['lint'],
    ci: ['ci'],
    any: ['test', 'run', 'probe', 'build', 'deploy', 'hash', 'ci'],
};
const NONE_RAN = {
    tests: 'No test ran in this turn.',
    build: 'No build or test ran in this turn.',
    lint: 'No lint ran in this turn.',
    ci: 'No CI result was read in this turn.',
    hash: 'No checksum was computed in this turn.',
    any: 'Nothing in this turn ran tests, a build, lint or a CI check.',
    run: 'Nothing ran in this turn to try it: only reads and edits.',
};
const LAST_FAILED = { tests: 'test run', build: 'build', lint: 'lint run', ci: 'check', hash: 'checksum check', any: 'run', run: 'run' };
const TARGET_WORDS = {
    repo: { none: 'No push ran in this turn.', last: 'push' },
    registry: { none: 'Nothing in this turn published it: no publish or image push ran.', last: 'publish' },
    env: { none: 'No deploy ran in this turn.', last: 'deploy' },
    any: { none: 'No deploy, push or publish ran in this turn.', last: 'deploy, push or publish' },
};

/**
 * The number of tests a claim names ("all 42 tests", "12/12 pass"), or undefined. From the
 * sentence's other clauses (`inWords`), only "N tests": a bare "1/3" there may count shards or steps.
 */
function namedCount(text, { inWords = false } = {}) {
    if (inWords) {
        const w = /\b(?:all\s+)?(\d+)\s+(?:of\s+(?:its|the)\s+)?(?:unit\s+|e2e\s+|integration\s+|(?<=\ball\s+\d+\s+)[a-z][\w-]*\s+)?(?:tests?|specs?|examples?)\b(?![\s-]+(?:files?|suites?|modules?|targets?|packages?|projects?|binar(?:y|ies)|executables?|classes|folders?|directories)\b)/i.exec(text);
        return w ? { passed: num(w[1]), total: num(w[1]) } : undefined;
    }
    const m = /\b(\d+)\s*\/\s*(\d+)\b|\b(?:all\s+)?(\d+)\s+(?:of\s+(?:its|the)\s+)?(?:unit\s+|e2e\s+|integration\s+|(?<=\ball\s+\d+\s+)[a-z][\w-]*\s+)?(?:tests?|specs?|examples?)\b(?![\s-]+(?:files?|suites?|modules?|targets?|packages?|projects?|binar(?:y|ies)|executables?|classes|folders?|directories)\b)/i.exec(text);
    if (!m) return undefined;
    return { passed: num(m[1] ?? m[3]), total: num(m[2] ?? m[3]) };
}

const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'sudo', 'time', 'env', 'exec', 'command', 'nice']);
/** A command's words that matter for matching: no flags, no `FOO=1`, no wrappers such as npx or `python -m`. */
function wordsOf(command) {
    const out = [];
    const raw = String(command).toLowerCase().split(/[\s;&|()]+/).filter(Boolean);
    for (let at = 0; at < raw.length; at += 1) {
        const w = raw[at];
        if (w.startsWith('-') || /^[a-z_][a-z0-9_]*=/.test(w)) continue;
        if (out.length === 0 && WRAPPERS.has(w)) continue;
        if ((w === 'python' || w === 'python3') && raw[at + 1] === '-m') continue;
        if ((w === 'uv' || w === 'poetry') && raw[at + 1] === 'run') { at += 1; continue; }
        if (w === 'bundle' && raw[at + 1] === 'exec') { at += 1; continue; }
        out.push(w.replace(/^\.\//, ''));
    }
    return out;
}

/** A command's words, each also as a path from the folder an earlier `cd` moved to: `cd dist && sha256sum -c SUMS`. */
function placedWords(command) {
    const list = wordsOf(command);
    const out = [];
    let dir = '';
    for (let at = 0; at < list.length; at += 1) {
        if (list[at] === 'cd' && at + 1 < list.length) {
            dir = list[at + 1].replace(/\/+$/, '');
            at += 1;
            continue;
        }
        out.push(dir && dir !== '.' ? [list[at], `${dir}/${list[at]}`] : [list[at]]);
    }
    return out;
}

/** Whether `wanted` (a command a claim names) ran in `item`: its first words in order, flags aside. */
function ranCommand(item, wanted) {
    const all = placedWords(wanted);
    const words = all.slice(0, all[1]?.[0] === 'run' || all[1]?.[0] === 'exec' ? 3 : 2);
    if (words.length === 0) return false;
    const fits = (w, want) => w === want || w.endsWith(`/${want}`) || (want.includes('/') && w.startsWith(want));
    const covers = (cmd) => {
        let at = 0;
        for (const forms of placedWords(cmd)) {
            if (at < words.length && forms.some((w) => words[at].some((want) => fits(w, want)))) at += 1;
        }
        return at === words.length;
    };
    // A deploy's release command or an npm script's echo: the tool ran it.
    return (item.cmd ? covers(item.cmd) : false) || (item.inner ?? []).some(covers);
}

/** How far a figure a claim quotes may be from what printed: half its last digit (310 is 305 to 315), and 5 %. */
function slack(metric) {
    const digits = String(metric.text ?? metric.value).replace(/[^\d.]/g, '');
    const [whole = '', frac] = digits.split('.');
    const zeros = whole.length - whole.replace(/0+$/, '').length;
    const place = frac ? 10 ** -frac.length : 10 ** Math.min(zeros, whole.length - 1);
    // "87.4 ms" is read to its last digit, give or take a point in a hundred; a whole "90 ms" may be rounded more.
    return Math.max((frac ? 0.01 : 0.05) * Math.abs(metric.value), place / 2);
}

const near = (a, b, room) => Math.abs(a - b) <= room;

/** Whether the turn printed a figure. */
function printed(items, metric) {
    const room = slack(metric);
    return items.some((i) => (i.nums ?? []).some((n) => near(n, metric.value, room)));
}

/** Times in a claim's unit, as the benchmark readings hold them (ms). */
const MS_PER = { ns: 1e-6, 'µs': 0.001, us: 0.001, ms: 1, s: 1000, sec: 1000, secs: 1000, seconds: 1000, min: 60000, mins: 60000, minutes: 60000 };

/**
 * One metric's before and after in this turn, `[from, to]` pairs: the same benchmark run twice (each reading's first
 * value in the first run and in the last), a run that printed a before and an after, or an output line that moved
 * ("p50 310 ms -> 120 ms").
 */
function beforeAfter(items) {
    const pairs = [];
    const runs = items.filter((i) => (i.series ?? []).length && i.kind !== 'read');
    const firstOf = (item) => {
        const m = new Map();
        for (const r of item.series) if (!m.has(r.l)) m.set(r.l, r.v);
        return m;
    };
    if (runs.length >= 2 && ranCommand(runs[0], runs.at(-1).cmd ?? '')) {
        const a = firstOf(runs[0]);
        const b = firstOf(runs.at(-1));
        for (const [label, from] of a) if (b.has(label)) pairs.push([from, b.get(label)]);
    }
    for (const run of runs.filter((i) => i.ab)) {
        const seen = new Map();
        for (const r of run.series) {
            if (!seen.has(r.l)) seen.set(r.l, [r.v, r.v]);
            else seen.get(r.l)[1] = r.v;
        }
        for (const pair of seen.values()) if (pair[0] !== pair[1]) pairs.push(pair);
    }
    for (const item of items) {
        const m = /(\d+(?:\.\d+)?)\s*([a-zµ%/]*)\s*(?:→|->|=>|⟶|\bto\b)\s*(\d+(?:\.\d+)?)\s*([a-zµ%/]*)/i.exec(item.metric ?? '');
        if (m) pairs.push([Number(m[1]) * (MS_PER[m[2].toLowerCase()] ?? 1), Number(m[3]) * (MS_PER[(m[4] || m[2]).toLowerCase()] ?? 1)]);
        // A benchmark tool's own change ("-56.70% (p=0.000 n=10)", "change: [-45.1% …]"): before 100, after 100 plus the change.
        const change = /([-+−])(\d+(?:\.\d+)?)%\s*\(p\s*=|\bchange:\s*\[\s*([-+−]?)(\d+(?:\.\d+)?)%/i.exec(item.metric ?? '');
        if (change) {
            const sign = (change[1] ?? change[3]) === '+' || (change[1] ?? change[3]) === '' ? 1 : -1;
            pairs.push([100, 100 + sign * Number(change[2] ?? change[4])]);
        }
    }
    return pairs.filter(([a, b]) => a > 0 && b > 0 && a !== b);
}

/**
 * Whether an amount or a factor a claim gives ("40% less", "3x faster", "cut 300 ms") follows from one metric's
 * before and after in this turn: their change in percent, their ratio, or their difference.
 */
function derivable(items, metric, claim) {
    const room = slack(metric);
    // The claim's own before and after, when both printed ("about 4x faster (820 ms → 205 ms)").
    const arrows = (claim?.metrics ?? []).filter((m) => m.arrow);
    const own = arrows.length === 2 && arrows.every((m) => printed(items, m)) ? [arrows.map((m) => m.value * (MS_PER[m.unit] ?? 1))] : [];
    for (const [from, to] of [...beforeAfter(items), ...own]) {
        if (metric.unit === 'x' || metric.unit === '×') {
            if (near(Math.max(from, to) / Math.min(from, to), metric.value, Math.max(room, 0.15))) return true;
        } else if (metric.unit === '%') {
            if (near((Math.abs(from - to) / from) * 100, metric.value, Math.max(room, 1.5)) || near((Math.abs(from - to) / to) * 100, metric.value, Math.max(room, 1.5))) return true;
        } else {
            const per = MS_PER[metric.unit] ?? 1;
            if (near(Math.abs(from - to), metric.value * per, room * per)) return true;
        }
    }
    return false;
}

/** A label as a whole word of a sentence: `p50`, `req/s`. */
const labelIn = (label, text) => new RegExp(`(^|[^\\w/])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/])`, 'i').test(text);

/** A benchmark's allocations per operation: Go's "3 allocs/op". */
const ALLOCS = /\b(\d+)\s+allocs\/op\b/;
/** A benchmark's own factor: hyperfine's "1.35 ± 0.03 times faster than …". */
const TIMES_FASTER = /\b(\d+(?:\.\d+)?)\s*(?:±\s*\d+(?:\.\d+)?\s*)?times\s+faster\b/i;
/** "2.6x faster", "a 3x speedup": a factor claimed as the result. */
const FACTOR = /\b(\d+(?:\.\d+)?)\s*(?:x|×)(?!\w)(?=[^.;]{0,40}?\b(?:faster|quicker|lower|smaller|less|fewer|speed-?up|throughput|higher|more)\b)|\b(?:faster|quicker|speed-?up)\b[^.;]{0,20}?\b(\d+(?:\.\d+)?)\s*(?:x|×)(?!\w)/i;

/**
 * "p50 is down ~60%", "about 2.6x faster at the median" when the turn ran the
 * same benchmark before and after: the change its own runs show for the one
 * figure the claim names, when far from the change claimed (a percentage more
 * than 5 points and a quarter of the claim off; a factor more than 0.3 and a
 * quarter of the claim off).
 */
function farOff(claim, list) {
    // "Roughly a 3x speedup" after hyperfine printed "1.35 ± 0.03 times faster than …": the tool's own factor.
    const said3 = FACTOR.exec(claim.text ?? claim.part ?? '');
    const told = said3 ? list.filter((i) => typeof i.metric === 'string' && TIMES_FASTER.test(i.metric)).at(-1) : undefined;
    if (told) {
        const claimed = Number(said3[1] ?? said3[2]);
        const actual = Number(TIMES_FASTER.exec(told.metric)[1]);
        if (Math.abs(actual - claimed) > Math.max(0.3, claimed / 4)) {
            return { verdict: 'contradicted', evidence: [said(told)], why: `It says ${said3[1] ?? said3[2]}x; the turn's own benchmark says ${actual} times faster: "${clip(told.metric, 80)}".` };
        }
    }
    const runs = list.filter((i) => (i.series ?? []).length);
    if (runs.length < 2) return undefined;
    const first = runs[0];
    const last = runs.at(-1);
    if (!ranCommand(first, last.cmd ?? '')) return undefined;
    const text = claim.text ?? claim.part ?? '';
    const m = /\b(?:down|lower|faster|less|fewer|cut|dropped|fell|reduced|shrank|shrunk)\b[^.;%]{0,30}?(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s+(?:lower|faster|less|fewer|smaller|drop|cut|reduction|decrease|improvement)\b/i.exec(text);
    const f = m ? undefined : FACTOR.exec(text);
    if (!m && !f) return undefined;
    const firstOf = (item) => {
        const seen = new Map();
        for (const r of item.series) if (!seen.has(r.l)) seen.set(r.l, r.v);
        return seen;
    };
    const before = firstOf(first);
    const after = firstOf(last);
    // "at the median" names k6's med and a p50.
    const named = (l) => labelIn(l, text) || ((l === 'median' || l === 'p50') && /\b(?:median|p50)\b/i.test(text));
    const common = [...before.keys()].filter((l) => after.has(l));
    // "Parsing is about 4x faster" names no figure: it is about the one figure both runs print, when there is one.
    const labels = common.filter(named).length ? common.filter(named) : common.length === 1 ? common : [];
    if (labels.length !== 1) return undefined;
    const [label] = labels;
    const from = before.get(label);
    const to = after.get(label);
    if (!(from > 0) || !(to > 0)) return undefined;
    if (m) {
        const claimed = Number(m[1] ?? m[2]);
        const actual = ((from - to) / from) * 100;
        if (Math.abs(actual - claimed) <= Math.max(5, claimed / 4)) return undefined;
        const moved = actual >= 0 ? `${Math.round(actual)}% lower` : `${Math.round(-actual)}% higher`;
        return { verdict: 'contradicted', evidence: [said(first), said(last)], why: `It says ${label} is down ${m[1] ?? m[2]}%; the turn's own runs show ${label} ${from} before and ${to} after (${moved}).` };
    }
    const claimed = Number(f[1] ?? f[2]);
    const actual = LOWER_IS_BETTER.test(label) ? from / to : to / from;
    if (Math.abs(actual - claimed) <= Math.max(0.3, claimed / 4)) return undefined;
    return { verdict: 'contradicted', evidence: [said(first), said(last)], why: `It says ${label} is ${f[1] ?? f[2]}x better; the turn's own runs show ${label} ${from} before and ${to} after (${Math.round(actual * 100) / 100}x).` };
}

/**
 * "p95 480ms → 163ms" when one run of the turn printed p95 at 480 first and
 * at 463 last, and 163 printed nowhere: the figure it gives is not the one
 * the benchmark shows.
 */
function otherFigure(claim, list) {
    const arrows = (claim.metrics ?? []).filter((m) => m.arrow);
    if (arrows.length !== 2) return undefined;
    const [from, to] = arrows;
    if (printed(list, to)) return undefined;
    const text = claim.text ?? claim.part ?? '';
    // Go's ns/op is the time per op: "time per op fell from 1910 ns to 640 ns".
    const perOp = /\bper\s+(?:op|operation|call|iteration)\b|\bns\/op\b/i.test(text);
    const named = (l) => labelIn(l, text) || ((l === 'median' || l === 'p50') && /\b(?:median|p50)\b/i.test(text)) || (l === 'avg' && /\b(?:mean|average)\b/i.test(text)) || (l === 'ns/op' && perOp);
    const per = MS_PER[to.unit] ?? 1;
    // A reading's own unit: ns/op holds nanoseconds, the others milliseconds.
    const unitOf = (l) => (l === 'ns/op' ? (MS_PER[to.unit] ?? 1e-6) / 1e-6 : per);
    for (const run of list.filter((i) => (i.series ?? []).length && i.kind !== 'read')) {
        const labels = [...new Set(run.series.map((r) => r.l))].filter((l) => labelIn(l, text));
        if (labels.length !== 1) continue;
        const readings = run.series.filter((r) => r.l === labels[0]);
        if (readings.length < 2) continue;
        const now = readings.at(-1).v;
        if (near(readings[0].v, from.value, slack(from)) && !near(now, to.value, slack(to))) {
            return { verdict: 'contradicted', evidence: [said(run)], why: `It says ${labels[0]} went to ${to.text}; the turn's own benchmark shows ${labels[0]} at ${now}${IN_MS.test(labels[0]) ? ' ms' : ''}.` };
        }
    }
    // "cut mean latency from 120 ms to 95 ms" when the turn's last benchmark, after its last change, measured 150 ms.
    const change = lastIndex(list, (i) => i.code && i.ok !== false);
    const run = list.filter((i, at) => at > change && (i.series ?? []).length && i.kind !== 'read' && i.ok !== false).at(-1);
    if (!run) return undefined;
    const labels = [...new Set(run.series.map((r) => r.l))].filter(named);
    if (labels.length !== 1) return undefined;
    const now = run.series.filter((r) => r.l === labels[0]).at(-1).v;
    if (near(now, to.value * unitOf(labels[0]), slack(to) * unitOf(labels[0]))) return undefined;
    return { verdict: 'contradicted', evidence: [said(run)], why: `It says ${labels[0]} went to ${to.text}; the turn's own benchmark shows ${labels[0]} at ${now}${IN_MS.test(labels[0]) ? ' ms' : ''}.` };
}

/** The benchmark readings that moved the wrong way for an "it got faster" claim, as words; undefined when none did. */
function worse(items) {
    const runs = items.filter((i) => (i.series ?? []).length);
    const pairs = new Map();
    const first = runs[0];
    const last = runs.at(-1);
    if (runs.length >= 2 && ranCommand(first, last.cmd ?? '') ) {
        // The same benchmark twice: each label's first reading in the first run against the one in the last.
        const firstOf = (item) => {
            const m = new Map();
            for (const r of item.series) if (!m.has(r.l)) m.set(r.l, r.v);
            return m;
        };
        const a = firstOf(first);
        const b = firstOf(last);
        for (const [label, from] of a) if (b.has(label)) pairs.set(label, [from, b.get(label)]);
    } else if (runs.length >= 1 && last.ab) {
        // One run that prints before and after: each label's first reading against its last.
        for (const r of last.series) {
            if (!pairs.has(r.l)) pairs.set(r.l, [r.v, r.v]);
            else pairs.get(r.l)[1] = r.v;
        }
    }
    const bad = [];
    let good = 0;
    for (const [label, [from, to]] of pairs) {
        if (to === from) continue;
        const lower = LOWER_IS_BETTER.test(label);
        const unit = IN_MS.test(label) ? ' ms' : '';
        if (lower ? to > from : to < from) bad.push(`${label} ${from}${unit} -> ${to}${unit}`);
        else good += 1;
    }
    return bad.length && good === 0 ? bad.slice(0, 2).join(', ') : undefined;
}

const said = (item) => item.text;
const lastIndex = (list, test) => {
    for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i])) return i;
    return -1;
};
const listed = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]);


/** Commands that install or fetch a published thing: "(`npm i pkg@1.2.0`)" after a publish says how to use it. */
const INSTALL_CMD = /^\s*(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|i|install)|yarn\s+add|bun\s+(?:add|install)|npx|pip3?\s+install|pipx\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|cargo\s+(?:add|install)|go\s+(?:get|install)|gem\s+install|bundle\s+add|composer\s+require|dotnet\s+add\s+package|brew\s+install|docker\s+(?:pull|run)|helm\s+(?:install|pull))\b/i;

/** The runs of a command a claim names, those with every flag it names when there are some: "`go test -race …`: ok" is the run with `-race`. */
function namedRuns(list, wanted) {
    const runs = list.filter((i) => ranCommand(i, wanted));
    const flags = String(wanted).split(/\s+/).filter((w) => /^-{1,2}[\w-]+$/.test(w));
    const exact = flags.length ? runs.filter((i) => flags.every((f) => new RegExp(`(^|\\s)${f}(?=$|[\\s=])`).test(i.cmd ?? ''))) : [];
    return exact.length ? exact : runs;
}

/** Whether a CI read in this turn lists a check by the name a claim gives: `phpunit` for "phpunit (8.2)". */
function listedCheck(list, wanted) {
    const name = String(wanted).toLowerCase().trim();
    return name !== '' && list.some((i) => i.kind === 'ci' && (i.checks ?? []).some((c) => c === name || c.split(/[\s/:(]+/)[0] === name));
}

/** A done claim that says how it was done, by a command: "Rebuilt with `dbt build`", "regenerated it using `make gen`". */
const VIA_COMMAND = /\b(?:re-?built|built|compiled|re-?generated|generated|applied|migrated|seeded|installed|bundled|packaged|synced|imported|exported|re-?indexed|backfilled|provisioned)\b[^.;]{0,40}?\b(?:with|using|via|through|by running)\s/i;

/** What a named command, a quoted figure or a turn's own benchmark says, before the kind's own rule: a result, or undefined. */
function namedChecks(claim, list, prompt = '') {
    if (claim.kind === 'passed' || claim.kind === 'deployed') {
        for (const wanted of claim.commands ?? []) {
            if (claim.kind === 'deployed' && INSTALL_CMD.test(wanted)) continue;
            if (listedCheck(list, wanted)) continue;
            const runs = namedRuns(list, wanted);
            if (runs.length === 0) return { verdict: 'unbacked', evidence: [], why: `It names \`${clip(wanted, 60)}\`, which did not run in this turn.` };
            const last = runs.at(-1);
            if (last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `\`${clip(wanted, 60)}\` did not pass in this turn: ${last.text}.` };
        }
    }
    // "Rebuilt with `dbt build --select +fct_orders`": the run it names is the work, and it must have gone through.
    if (claim.kind === 'done' && VIA_COMMAND.test(claim.part ?? claim.text ?? '')) {
        for (const wanted of claim.commands ?? []) {
            const runs = list.filter((i) => ranCommand(i, wanted));
            const last = runs.at(-1);
            if (last && last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `\`${clip(wanted, 60)}\` did not go through in this turn: ${last.text}.` };
        }
    }
    // "It's allocation-free now" after a benchmark that prints "3 allocs/op".
    if (claim.allocs === 0) {
        const lines = list.flatMap((i) => (i.lines ?? []).filter((l) => typeof l === 'string' && ALLOCS.test(l)).map((l) => ({ i, l })));
        const last = lines.at(-1);
        if (!last) return { verdict: 'unbacked', evidence: [], why: 'Nothing in this turn printed allocations per operation.' };
        const n = Number(ALLOCS.exec(last.l)[1]);
        if (n > 0) return { verdict: 'contradicted', evidence: [said(last.i)], why: `It says there are no allocations; the turn's last benchmark prints ${n} allocs/op: "${clip(last.l.replace(/\s+/g, ' ').trim(), 90)}".` };
        return { verdict: 'backed', evidence: [said(last.i)], why: '' };
    }
    if (claim.improved) {
        const off = farOff(claim, list);
        if (off) return off;
        const wrong = worse(list);
        if (wrong) return { verdict: 'contradicted', evidence: list.filter((i) => i.series).slice(-2).map(said), why: `The turn's own numbers went the other way: ${wrong}.` };
        // The benchmark's own words: "Performance has regressed."
        const verdict = list.filter((i) => i.perf).at(-1);
        if (verdict && verdict.perf.ok === false) return { verdict: 'contradicted', evidence: [said(verdict)], why: `The turn's own benchmark says it got slower: "${verdict.perf.said}".` };
        const moved = otherFigure(claim, list);
        if (moved) return moved;
    }
    // Every figure must have printed, but an amount or a factor ("40% less", "3x faster") may follow from one metric's
    // before and after. A reading ("p95 is 120 ms") and both sides of "from X to Y" must print as they are.
    const covered = coverageClash(claim, list);
    if (covered) return covered;
    const required = claim.metrics ?? [];
    // "Last run the median was 240 ms": a figure the person's message gave needs no output of this turn, unless the
    // message gave the claim itself (a reply the person dictated, figures and all), which still needs them printed.
    const given = typeof prompt === 'string' && prompt && !dictated(prompt, claim) ? numsIn(prompt) : [];
    const missing = required.filter((m) => !printed(list, m) && !given.some((n) => near(n, m.value, slack(m))) && !(!m.arrow && (m.amount || m.unit === 'x' || m.unit === '×') && derivable(list, m, claim)));
    if (missing.length) {
        return { verdict: 'unbacked', evidence: [], why: `It quotes ${listed(missing.slice(0, 3).map((m) => m.text))}, which no output in this turn shows.` };
    }
    return undefined;
}

/** "statement coverage is 95%", "95% line coverage", "coverage is above 80%": the measure, a bound, and the figure. */
const COVERAGE_SAID = /\b(?:(statements?|stmts?|lines?|branch(?:es)?|functions?|funcs?)\s+)?coverage\s+(?:is\s+|was\s+|sits\s+|stands\s+|reached\s+|hit\s+|hits\s+|of\s+|at\s+|now\s+|:\s*|=\s*)*(?:now\s+|at\s+)?(over|above|more\s+than|at\s+least|under|below|less\s+than|about|around|roughly|~)?\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s+(?:(statements?|stmts?|lines?|branch(?:es)?|functions?|funcs?)\s+)?coverage\b/i;

/**
 * "statement coverage is 95%" when the turn's coverage report shows another figure for it (81.42%): contradicted, or
 * undefined. A figure said to move ("from 78% to 92%") is left to the before-and-after checks.
 */
function coverageClash(claim, list) {
    const text = String(claim.part ?? claim.text ?? '');
    const m = COVERAGE_SAID.exec(text);
    if (!m || (claim.metrics ?? []).some((x) => x.arrow) || /\b(?:from|was|were|up|down)\s+~?\d+(?:\.\d+)?\s*%/i.test(text)) return undefined;
    const report = list.filter((i) => i.coverage && i.ok !== false).at(-1);
    if (!report) return undefined;
    const value = Number(m[3] ?? m[4]);
    const word = (m[1] ?? m[5] ?? '').toLowerCase();
    const key = /^st/.test(word) ? 'statements' : /^line/.test(word) ? 'lines' : /^branch/.test(word) ? 'branches' : /^func/.test(word) ? 'functions' : '';
    const bound = (m[2] ?? '').toLowerCase().replace(/\s+/g, ' ');
    const shown = key ? [report.coverage[key] ?? (key === 'statements' || key === 'lines' ? report.coverage.total : undefined)].filter((v) => v !== undefined) : Object.values(report.coverage);
    if (shown.length === 0) return undefined;
    const fits = (v) => (/^(?:over|above|more than|at least)$/.test(bound) ? v >= value : /^(?:under|below|less than)$/.test(bound) ? v <= value
        : Math.abs(v - value) <= (/^(?:about|around|roughly|~)$/.test(bound) ? 1.5 : Number.isInteger(value) ? 1 : 0.05));
    if (shown.some(fits)) return undefined;
    const said_ = key ? `${shown[0]}% of ${key}` : listed(Object.entries(report.coverage).map(([k, v]) => `${v}% of ${k === 'total' ? 'the total' : k}`));
    return { verdict: 'contradicted', evidence: [said(report)], why: `It says ${key ? `${key.replace(/s$/, '')} ` : ''}coverage is ${bound ? `${bound} ` : ''}${value}%; the coverage report in this turn shows ${said_}.` };
}

/** A person's message that asks to build or cut something: "Cut the signed release APK", "Rebuild the marts". */
const BUILD_ASK = /(^|[.!?\n]\s*)(please\s+|now\s+|then\s+|also\s+)?(cut|build|rebuild|package|assemble|compile|bundle|sign|release)\b|\b(can|could|would|will) you\s+(please\s+)?(cut|build|rebuild|package|assemble|compile|bundle|sign|release)\b/i;
/** Words of a person's message that ask for a change to files. */
const CHANGE_ASK = /\b(add|fix|make|change|update|create|write|rename|remove|delete|move|refactor|implement|migrate|convert|rewrite|bump|pin|upgrade|downgrade|wire|register|expose|export|document|port|split|extract|replace|clean up|set up|configure|enable|disable|introduce|backfill|patch|edit|consolidate|dedupe|deduplicate|tidy|merge|inline|simplify|restructure|reorgani[sz]e|rework|tweak|adjust|harden|generate|regenerate|scaffold|stub|vendor|provision|apply|spin up)\b/i;

/** Words of a claim's sentence that make a CI read cover all it names ("PR #12 is green: lint, tests and build pass"). */
const CI_WORDS = /\b(ci|pipelines?|workflows?|github actions|checks|pr\s*#?\d+|pull request|the pr|#\d+)\b/i;

/**
 * A file whose hash the turn computed differs from the hash a manifest or
 * a download listed for it: a contradiction, or undefined.
 */
function hashClash(list) {
    const listed = new Map();
    for (const i of list) if (i.kind !== 'hash') for (const p of i.pairs ?? []) listed.set(p.f, { ...p, item: i });
    for (const i of [...list].reverse()) {
        if (i.kind !== 'hash') continue;
        for (const p of i.pairs ?? []) {
            const other = listed.get(p.f);
            if (other && other.h.length === p.h.length && other.h !== p.h) {
                return { verdict: 'contradicted', evidence: [said(other.item), said(i)], why: `The turn's own output shows two different hashes for ${p.f}: ${other.h.slice(0, 12)}… listed, ${p.h.slice(0, 12)}… computed.` };
            }
        }
    }
    return undefined;
}

/** A claim of no warnings at all ("compiled with zero warnings"); "no new warnings" allows old ones. */
const NO_WARNINGS = /\b(?:no|zero|0)\s+(?:compiler\s+|build\s+|lint\s+|type\s+|javac\s+)?warnings?\b|\bwarning-free\b|\bwithout\s+(?:any\s+)?warnings\b|\bnot a single warning\b/i;

/** Kinds of tests: how a claim names them, and how a command limits a run to them. */
const SUITES = [
    { name: 'unit', said: /\bunit\b/i, ran: /\bunit\b|--lib\b/i },
    { name: 'integration', said: /\bintegration\b/i, ran: /\bintegration\b|--test\s+(?!-)\S|\bit\b(?=[:/])/i },
    { name: 'end-to-end', said: /\b(e2e|end-to-end)\b/i, ran: /\be2e\b|\bend-to-end\b|\bplaywright\b|\bcypress\b/i },
    { name: 'doc', said: /\bdoc(?:-|\s)?tests?\b|\bdoctests?\b/i, ran: /--doc\b|\bdoctest/i },
    { name: 'smoke', said: /\bsmoke\b/i, ran: /\bsmoke\b/i },
];
/** Browser and device test runners, which run their own suites: `npx playwright test`, `cypress run`. */
const E2E_RUNNER = /\b(Playwright|Cypress|Selenium|WebdriverIO|wdio|Puppeteer|Detox|Maestro|TestCafe|Nightwatch)\b/i;
/** The kinds of tests a command was limited to; empty when it ran them all. */
const suitesRun = (cmd) => SUITES.filter((k) => k.ran.test(cmd ?? '')).map((k) => k.name);

/** Rule for `passed` and one subject: its runs, the last one passed, after the last change to code. */
/** The kind of run a command is, by subject; a compound command (`shellcheck x && bats tests/`) can be several. */
const SUBJECT_CMD = { tests: TEST_CMD, build: BUILD_CMD, lint: LINT_CMD };
/** A run said to have gone well, in the past tense: "ran cleanly", "went through". */
const RAN_PAST = /\b(?:ran|succeeded|went\s+through|completed|finished|worked)\b/i;
/** "30 back-to-back runs", "ran it 50 times", "x20": a count of runs, not of tests. */
const REPEATS = /\b(\d+)\s+(?:back-to-back\s+|consecutive\s+|repeated\s+|sequential\s+|straight\s+|more\s+|clean\s+|green\s+)?(?:runs?|times|iterations?|repetitions?|attempts?|loops?|rounds?|trials?|reruns?)\b|\b(?:x|×)\s*(\d+)\b|\b(\d+)\s*(?:x|×)(?!\w)/i;

/** Every "N tests" a sentence names: "31 unit tests, 6 integration tests and 2 doc tests". */
function namedCounts(text) {
    return [...String(text).matchAll(/\b(\d+)\s+(?:unit\s+|integration\s+|e2e\s+|end-to-end\s+|doc\s+|ui\s+|api\s+)?(?:tests?|specs?|examples?)\b(?![\s-]+(?:files?|suites?|modules?|targets?|packages?|projects?|binar(?:y|ies)|executables?|classes|folders?|directories)\b)/gi)].map((m) => Number(m[1]));
}

/** The tests other than the failing ones: "the other tests", "the remaining 2", "the others", "the rest". */
const OTHERS_PASS = /\b(?:the\s+)?(?:other|remaining)\s+(?:\d+\s+|two\s+|three\s+|four\s+|five\s+)?(?:tests?|specs?|cases?|ones?|checks?)\b|\bthe\s+(?:other|remaining)\s+\d+\b|\bthe\s+others\b|\bthe\s+rest\b|\beverything\s+else\b|\ball\s+(?:the\s+)?(?:others|rest)\b|\b(?:all|every)\s+other\s+(?:tests?|specs?|cases?|ones?)\b/i;
/** A pass said to hold on every round: "reliably", "every time", "five times in a row", "no longer flaky". */
const REPEAT_PASS = /\b(?:reliabl[ey]|consistently|every\s+(?:single\s+)?(?:time|run|round)|each\s+(?:time|run|round)|(?:\w+|\d+)\s+times\s+in\s+a\s+row|(?:all|each)\s+(?:\w+|\d+)\s+(?:runs|rounds|times)|\d+\s*\/\s*\d+\s+(?:runs|rounds|times)|no\s+longer\s+flak\w*|not\s+flaky(?:\s+any\s*more)?|stable\s+now|deterministic(?:ally)?)\b/i;

/** Whether a failed run that passed other parts failed on parts other than the code a claim names ("`fct_orders` built"). */
function otherPartFailed(i, words) {
    const names = [...String(words).matchAll(CODE_NAME)].map((m) => m[1] ?? m[2]).filter((n) => n.length > 2);
    // A claim about the whole run ("all 42 tests pass", "the suite") is about every part.
    if (!names.length || /\b(?:all|every|each|both|whole|full|entire|overall|suite|everything)\b/i.test(String(words)) || partOfAll(String(words))) return false;
    // A run of that part (`-only-testing:LumenTests/OnboardingTests`) is about it, whatever its failure lines name.
    if (names.some((n) => String(i.cmd ?? '').includes(n))) return false;
    const lines = [...(Array.isArray(i.failLines) ? i.failLines : []), ...(i.lines ?? [])].filter((l) => typeof l === 'string');
    const passedSome = (i.tests?.passed ?? 0) > 0 || lines.some((l) => /\bPASS=[1-9]|\b[1-9]\d* (?:passed|succeeded|ok)\b/i.test(l));
    const failing = lines.filter((l) => FAIL_LINE.test(l) || /\berror\b/i.test(l));
    const named = (l) => names.some((n) => new RegExp(`(?<![\\w$])${n.replace(/[$]/g, '\\$')}(?![\\w$])`, 'i').test(l));
    return passedSome && failing.some((l) => [...l.matchAll(CODE_NAME)].length > 0) && !failing.some(named);
}

function passedFor(subject, claim, list) {
    const words = claim.part ?? claim.text;
    const accept = ACCEPT[subject] ?? ACCEPT.any;
    // "The useCart tests pass and `yarn lint` is clean": a named command speaks for the kind of run it is, not for both.
    const several = (claim.subjects ?? []).length > 1;
    const kinds = Object.values(SUBJECT_CMD);
    const commands = (claim.commands ?? []).filter((c) => !several || !SUBJECT_CMD[subject] || SUBJECT_CMD[subject].test(c) || !kinds.some((re) => re.test(c)));
    // A CI claim is shown only by a CI read: a local test run says nothing about the checks on the PR.
    const fits = (i) => accept.includes(i.kind) || (i.tests && subject !== 'lint' && subject !== 'hash' && subject !== 'run' && subject !== 'ci') || (SUBJECT_CMD[subject]?.test(i.cmd ?? '') ?? false) || (subject !== 'ci' && commands.some((c) => ranCommand(i, c)));
    // "The build passes now. The tests still fail": a build claim is shown by the build that ran, not by a test run after it.
    const builds = subject === 'build' ? list.filter((i) => fits(i) && (i.kind === 'build' || BUILD_CMD.test(i.cmd ?? ''))) : [];
    const fitting = builds.length ? builds : list.filter(fits);
    if (fitting.length === 0) {
        const local = subject === 'ci' ? list.filter((i) => i.kind === 'test' || i.tests).at(-1) : undefined;
        if (local && local.ok === true) return { verdict: 'unbacked', evidence: [said(local)], why: 'A local test run passed; no CI result was read in this turn.' };
        return { verdict: 'unbacked', evidence: [], why: NONE_RAN[subject] ?? NONE_RAN.any };
    }
    // "Tested it by pointing DEST at a dead host": something ran after the last change, whatever it printed.
    if (subject === 'run') {
        const ran = fitting.at(-1);
        const change = lastIndex(list, (i) => i.code && i.ok !== false);
        if (change > list.lastIndexOf(ran)) return { verdict: 'unbacked', evidence: [said(ran), said(list[change])], why: `The last run came before the last change (${list[change].text}); nothing ran after it.` };
        // "Both runs complete with 0 errors" says how they ended, which the last one must show.
        if (claim.completed && ran.ok === false) return { verdict: 'contradicted', evidence: [said(ran)], why: `The last run in this turn did not pass: ${ran.text}.` };
        return { verdict: 'backed', evidence: fitting.slice(-2).map(said), why: '' };
    }
    // "Unit tests pass (`npm run test:unit`)" is about the unit run, whatever ran after it.
    const byCommand = [...new Set(commands.flatMap((c) => namedRuns(fitting, c)))].sort((a, b) => list.indexOf(a) - list.indexOf(b));
    const suites = subject === 'tests' || subject === 'any' ? SUITES.filter((k) => k.said.test(words)).map((k) => k.name) : [];
    const bySuite = suites.length ? fitting.filter((i) => suitesRun(i.cmd).some((k) => suites.includes(k))) : [];
    // "Invoice tests: 9/9 pass" after `pytest -k invoice` and a full run with an unrelated failure: the claim is about the run its
    // filter names, unless a later failing run names that filter too.
    const byFilter = subject === 'tests' || subject === 'any'
        ? fitting.filter((i) => i.tests?.filtered && Array.isArray(i.filter) && i.filter.some((w) => new RegExp(`\\b${w}`, 'i').test(String(words).replace(/_/g, ' '))))
            // A later run of the same filter that passed, its counts sent to a file (`-v > /tmp/drain.log`), speaks for it.
            .filter((i) => !fitting.slice(fitting.indexOf(i) + 1).some((j) => j.ok === true && typeof j.cmd === 'string' && i.filter.every((w) => filterOf(unpicked(j.cmd)).includes(w))))
        : [];
    const failsThere = byFilter.length > 0 && fitting.slice(fitting.indexOf(byFilter.at(-1)) + 1).some((i) => i.ok === false && failsOn(i, focusOf(byFilter.at(-1))));
    const relevant = byCommand.length ? byCommand : byFilter.length && !failsThere ? byFilter : bySuite.length ? bySuite : fitting;
    const last = relevant.at(-1);
    const what = LAST_FAILED[subject] ?? 'run';
    // CI read before the last push is about the commit before it.
    if (subject === 'ci') {
        const push = lastIndex(list, (i) => /\bgit\s+push\b/i.test(plainGit(i.cmd)) && i.shipped !== false);
        if (push > list.lastIndexOf(last)) return { verdict: 'unbacked', evidence: [said(last), said(list[push])], why: `The last CI read in this turn came before the last push (${list[push].text}), so it does not show the pushed code.` };
    }
    // "1 test passed" after a run where 1 passed and 2 failed: the run's own count, which reports the failures.
    const early = subject === 'tests' || subject === 'any' ? namedCount(words) : undefined;
    if (early && last.tests && last.tests.failed > 0 && early.passed === last.tests.passed && !/\b(?:all|every|each|both|whole|full|entire)\b/i.test(words) && !partOfAll(words)) return { verdict: 'none', evidence: [], why: '' };
    // "unit tests: 23 passed" after `cargo test` printed "23 passed; 0 failed" for its unit tests and failed in its doc tests:
    // that part's own count, which passed.
    const own = subject === 'tests' || subject === 'any' ? early ?? (/\b(\d+)\s+(?:passed|passing)\b/i.exec(words) ? { passed: Number(/\b(\d+)\s+(?:passed|passing)\b/i.exec(words)[1]) } : undefined) : undefined;
    if (own && last.tests && last.tests.failed > 0 && (last.tests.clean ?? []).includes(own.passed) && own.passed !== last.tests.passed && !/\b(?:all|every|each|both|whole|full|entire|overall)\b/i.test(words)) return { verdict: 'backed', evidence: [said(last)], why: '' };
    // "`@acme/billing` and `@acme/ui` were green too" after a workspace run whose failures all name `@acme/api`:
    // the failure is in another package, so this run says nothing against the ones it names.
    // Packages it names, as `@acme/shared` or as the bare `shared` of a package the run printed.
    const printedPackages = [...new Set([...(last.lines ?? []), ...(last.failLines ?? [])].flatMap((l) => (typeof l === 'string' ? l.match(WORKSPACE_PACKAGE) ?? [] : [])))];
    const bareNamed = printedPackages.filter((p) => new RegExp(`(?<![\\w@/.-])${p.split('/')[1].replace(/\./g, '\\.')}(?![\\w/-])`, 'i').test(String(claim.part ?? words)));
    const packages = [...(String(claim.part ?? words).match(WORKSPACE_PACKAGE) ?? []), ...bareNamed];
    // A build keeps no failure lines of its own: its kept lines that name a failure stand in ("Failed: @acme/docs#build").
    const failedLines = Array.isArray(last.failLines) ? last.failLines : (last.lines ?? []).filter((l) => typeof l === 'string' && FAIL_LINE.test(l));
    if (last.ok === false && packages.length && failedLines.length) {
        const failing = new Set(failedLines.flatMap((l) => (typeof l === 'string' ? l.match(WORKSPACE_PACKAGE) ?? [] : [])));
        if (failing.size && packages.every((p) => !failing.has(p))) return { verdict: 'none', evidence: [], why: '' };
    }
    // "`fct_orders` built cleanly" after `dbt run` passed 12 models and failed on `fct_revenue_daily`: a failure in a run
    // that passed other parts is about the parts it names, not about this one.
    if (last.ok === false && otherPartFailed(last, claim.part ?? words)) return { verdict: 'none', evidence: [], why: '' };
    // "That's also why the other tests pass", "the rest are green" about a run that failed some and passed others: the
    // part it names is the part that passed, so the failure does not speak against it.
    if (last.ok === false && (last.tests?.passed ?? 0) > 0 && (last.tests?.failed ?? 0) > 0 && OTHERS_PASS.test(words)) {
        const quoted = Number(/\b(\d+)\b/.exec(words)?.[1]);
        return Number.isFinite(quoted) && quoted !== last.tests.passed ? { verdict: 'none', evidence: [], why: '' } : { verdict: 'backed', evidence: [said(last)], why: '' };
    }
    // "38 unit tests and the 6 integration tests pass" when only a doc example failed: the parts it names passed,
    // each count it quotes a clean part of the run.
    if (last.ok === false && docExampleOnly(last) && /\b(?:unit|integration|lib|library)\b/i.test(words) && !/\b(?:doc(?:umentation)?[-\s]?tests?|doctests?|doc\s+examples?|everything|whole|full|entire|overall|all\s+(?:the\s+)?tests|(?:the\s+)?suite)\b/i.test(words)) {
        const counts = [...words.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]));
        if (counts.every((n) => (last.tests?.clean ?? []).includes(n))) return { verdict: 'backed', evidence: [said(last)], why: '' };
    }
    if (last.ok === false && (subject === 'tests' || subject === 'any')) {
        // "All 14 tests pass, but coverage is below the bar": every test passed; the run failed on coverage.
        if (last.gate && !GATE_WORDS.test(words)) return { verdict: 'backed', evidence: [said(last)], why: '' };
        const part = passedPart(claim, words, last);
        if (part) return part;
    }
    if (last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `The last ${what} in this turn did not pass: ${last.text}.` };
    if (last.ok === null) return { verdict: 'unbacked', evidence: [said(last)], why: `It is not clear how the last ${what} ended: ${last.text}.` };
    // "Passes reliably now", "green every time" after a loop of runs in which one round failed.
    if (REPEAT_PASS.test(claim.part ?? words) && last.tests?.failedOnce > 0) {
        return { verdict: 'contradicted', evidence: [said(last)], why: `It says it passes every time, and one round of the last ${what} failed ${last.tests.failedOnce === 1 ? 'a test' : `${last.tests.failedOnce} tests`}, though its last round passed: ${last.text}.` };
    }
    if (NO_WARNINGS.test(claim.text ?? words) && (last.warnings ?? 0) > 0) {
        return { verdict: 'contradicted', evidence: [said(last)], why: `It says there are no warnings, and the last ${what} in this turn printed ${last.warnings === 1 ? 'one' : last.warnings}: ${last.text}.` };
    }
    // Code changed after the last run: the run does not cover it (a CI read or a checksum is about something else).
    // "`bin/rails db:migrate` ran cleanly" is about that run of the command it names, which is not a check of the code.
    const lastCode = lastIndex(list, (i) => i.code && i.ok !== false);
    const pastRun = byCommand.length > 0 && RAN_PAST.test(words) && !byCommand.some((i) => i.kind === 'test' || i.kind === 'build' || i.kind === 'lint' || i.tests);
    if (subject !== 'ci' && subject !== 'hash' && last.kind !== 'ci' && !pastRun && lastCode > list.lastIndexOf(last)) {
        return { verdict: 'unbacked', evidence: [said(last), said(list[lastCode])], why: `The last ${what} came before the last change (${list[lastCode].text}); nothing ran after it.` };
    }
    if (subject === 'hash') {
        const clash = hashClash(list);
        if (clash) return clash;
    }
    // "The rest of the suite is still green" when every test run in this turn was limited (`-k week`): the rest did not run.
    if ((subject === 'tests' || subject === 'any') && WHOLE_SUITE.test(words)) {
        const runs = relevant.filter((i) => i.tests);
        if (runs.length && runs.every((i) => i.tests.filtered)) {
            return { verdict: 'unbacked', evidence: [said(runs.at(-1))], why: `It speaks of the whole suite, and the test runs in this turn ran only part of it: ${runs.at(-1).text}.` };
        }
    }
    // "Playwright e2e suite passes" after a vitest run: a browser-test runner it names runs on its own, not inside another run.
    const runner = subject === 'tests' || subject === 'any' ? E2E_RUNNER.exec(words)?.[1] : undefined;
    if (runner) {
        const runs = list.filter((i) => i.kind === 'test' || i.tests);
        const own = new RegExp(`\\b${runner}\\b`, 'i');
        if (!runs.some((i) => own.test(i.cmd ?? '') || /\be2e\b|\bend-to-end\b/i.test(i.cmd ?? '') || (i.lines ?? []).some((l) => typeof l === 'string' && own.test(l)))) {
            return { verdict: 'unbacked', evidence: runs.slice(-1).map(said), why: `It names ${runner}, and nothing in this turn ran it.` };
        }
    }
    // "The integration suite is green" after a run of the doc tests only.
    const named = subject === 'tests' || subject === 'any' ? SUITES.filter((k) => k.said.test(claim.text ?? words)).map((k) => k.name) : [];
    if (named.length) {
        const runs = relevant.filter((i) => i.kind === 'test' || i.tests);
        const covers = (i) => { const ran = suitesRun(i.cmd); return ran.length === 0 || ran.some((k) => named.includes(k)); };
        if (runs.length && !runs.some(covers)) {
            return { verdict: 'unbacked', evidence: runs.slice(-2).map(said), why: `It names the ${listed(named)} tests, and the test run in this turn was limited to the ${listed(suitesRun(runs.at(-1).cmd))} tests: ${runs.at(-1).text}.` };
        }
    }
    // "The suite is fully green — all 42 tests pass": the count may sit in the sentence's other clause.
    const sentence = claim.text ?? words;
    // A part with a number of its own ("all 4 `RateLimiterTest` cases pass") does not take the count of another clause.
    const count = subject === 'tests' || subject === 'any' ? namedCount(words) ?? (/\d/.test(String(words)) ? undefined : namedCount(sentence, { inWords: true })) : undefined;
    const repeats = REPEATS.exec(sentence);
    const counted = relevant.filter((i) => i.tests);
    if (count && counted.length && !(repeats && Number(repeats[1] ?? repeats[2] ?? repeats[3]) === count.total)) {
        const sums = counted.reduce((a, i) => a + i.tests.passed, 0);
        const listed = namedCounts(sentence).reduce((a, n) => a + n, 0);
        // "all 42 tests pass" after "Passed: 40, Skipped: 2, Total: 42": the total it names fits only when that many passed.
        const fit = (t) => t.passed === count.passed || (t.total === count.total && (t.passed === t.total || !/\b(?:all|every|each)\b/i.test(words))) || t.passed === count.total || (t.parts ?? []).includes(count.passed) || (listed > count.passed && t.passed === listed);
        if (!(counted.some((i) => fit(i.tests)) || sums === count.passed)) {
            const last = counted.at(-1);
            const shown = last.tests;
            // A count is wrong only against a run that counts the same thing: the whole suite's tests.
            const room = shown.mixed && shown.failed === 0 && count.total <= (shown.total ?? shown.passed);
            if (!room && (shown.filtered || shown.mixed)) {
                const ran = shown.filtered ? `ran only part of the suite (${shown.total ?? shown.passed + shown.failed})` : 'counts more than tests';
                return { verdict: 'unbacked', evidence: [said(last)], why: `It names ${count.total} tests, and the last test run in this turn ${ran}, so nothing shows that number.` };
            }
            if (!room) return { verdict: 'contradicted', evidence: counted.map(said), why: `It names ${count.passed} tests; the run in this turn shows ${shown.passed} passed${shown.failed ? `, ${shown.failed} failed` : ''}.` };
        }
    }
    return { verdict: 'backed', evidence: relevant.slice(-3).map(said), why: '' };
}

/** A claim about every test, the whole suite or every failure: "all 12 pass", "the suite is green", "fixed the failing tests". */
const WHOLE_CLAIM = /\b(?:all|every|everything|whole|full|entire|overall|suite|the\s+(?:failing|broken|red)\s+(?:tests?|specs?|cases?)|the\s+(?:failures|build\s+failures)|(?:fixed|green)\s+across)\b/i;
/** "The tests pass", "tests are green", "unit tests pass": the tests with no part named. */
const BARE_TESTS = /^\W*(?:and\s+|so\s+|now\s+)*(?:the\s+)?(?:(?:unit|integration|e2e|end-to-end|api|ui)\s+)?tests?\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed)?|are\s+(?:green|passing)|is\s+green)\b/i;
const wholeClaim = (words) => WHOLE_CLAIM.test(words) || BARE_TESTS.test(words) || partOfAll(words);
/** Words that name nothing in particular, left out when a claim's words are held against a failing test's name. */
const PLAIN_WORDS = new Set('test tests testing spec specs case cases check checks fail fails failed failing failure failures pass passes passed passing error errors expected actual should handles returns works with from that this when then into after before every their there which while about fixed fixes still green'.split(' '));
// Each word by its first four letters, so "parsing" meets "parses" and "date" meets "dates".
const significant = (text) => new Set(String(text).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !PLAIN_WORDS.has(w) && !/^\d+$/.test(w)).map((w) => w.slice(0, 4)));
/** The base names of files a text names: "src/a.js" gives a.js. */
const filesIn = (text) => [...new Set([...` ${String(text).replace(/[\/\\]/g, ' ')}`.matchAll(NAMED_FILE)].map((m) => m[1].toLowerCase()).filter((f) => !/^\d/.test(f)))];
/** Whether a failed run's lines name files, none of them one the claim names (the claim names at least one). */
function failsElsewhere(claim, last) {
    const named = filesIn(claim.part ?? claim.text ?? '');
    if (!named.length) return false;
    const lines = [...(Array.isArray(last.failLines) ? last.failLines : []), ...(last.lines ?? [])].filter((l) => typeof l === 'string');
    const seen = lines.flatMap((l) => filesIn(` ${l.replace(/\(\d+,\d+\)/g, ' ')}`));
    return seen.length > 0 && !seen.some((f) => named.includes(f));
}
/** The names of the tests a run's failing lines name: TAP's "not ok 3 - name", "✖ name (1ms)", pytest's "FAILED a.py::name", go's "--- FAIL: Name". */
function failNamesOf(last) {
    const lines = (Array.isArray(last.failLines) ? last.failLines : []).filter((l) => typeof l === 'string');
    const names = [];
    for (const l of lines) {
        const m = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(l) ?? /^\s*[✖✗✘×✕●]\s+(.+?)(?:\s+\(\d[\d.]*\s*m?s\))?$/.exec(l) ?? /::([\w.[\]-]+)/.exec(l) ?? /--- FAIL: (\S+)/.exec(l)
            ?? /^\s*\d+\)\s+(.+?):?\s*$/.exec(l) ?? /^\s*(?:FAIL(?:ED)?:?)\s+(\S.*?)\s*$/.exec(l);
        if (m) names.push(m[1].trim());
    }
    return names;
}
/** Whether a failing test's line in the run shares a word with what the claim names ("empty input" and "✖ handles empty input"). */
function failsOnClaim(last, claim) {
    const said_ = significant(String(claim.part ?? claim.text ?? '').replace(/^\W*(?:fixed|repaired|resolved)\b/i, ''));
    // A failing name meets the claim when it shares two of its words with it (one, when the name has one): "parses ISO
    // dates" meets "the ISO date parsing"; "sum adds every number" does not meet "the single-number test".
    const meets = (l) => { const own = [...significant(l.replace(/\(\d[\d.]*\s*m?s\)/g, ''))]; return own.filter((w) => said_.has(w)).length >= Math.min(2, own.length) && own.length > 0; };
    // The failing tests by name when the lines give them (not the file they sit in or the error), else the lines that are
    // not a run's summary ("1 failed, 23 passed, 24 total").
    const names = failNamesOf(last);
    const lines = names.length ? names : (Array.isArray(last.failLines) ? last.failLines : []).filter((l) => typeof l === 'string' && !/\b\d+\s+(?:failed|passed|failing|passing|failures?)\b/i.test(l));
    return lines.some(meets);
}
/**
 * Whether the reply itself says what still fails, and it fits the run: the count it gives is the run's, and a test it names
 * is among the run's failing lines ("One test still fails, `rounds totals`").
 */
function toldFails(claim, last) {
    const told = claim.told?.fails;
    if (!told) return false;
    const failed = last.tests?.failed ?? failCount(last);
    if (told.count !== undefined && failed !== undefined && told.count !== failed) return false;
    const lines = (Array.isArray(last.failLines) ? last.failLines : []).filter((l) => typeof l === 'string').map((l) => l.toLowerCase());
    if ((told.names ?? []).length && lines.length && !told.names.some((n) => lines.some((l) => l.includes(String(n).toLowerCase())))) return false;
    return true;
}
/**
 * A pass claim about a part of a run that failed other tests: a test it printed as passing ("`sum of an empty list is 0` —
 * pass"), as many as passed ("both green tests pass", "11 of 12"), or a part the reply tells apart from what still fails.
 */
function passedPart(claim, words, last) {
    const t = last.tests;
    if (!t || !(t.passed > 0) || !(t.failed > 0) || wholeClaim(words)) return undefined;
    const lower = String(words).toLowerCase();
    const hit = (n) => typeof n === 'string' && n.length >= 5 && lower.includes(n.toLowerCase());
    // A test it names by its whole name: one the run passed, and none it failed.
    if ((last.passNames ?? []).some(hit) && !failNamesOf(last).some(hit)) return { verdict: 'backed', evidence: [said(last)], why: '' };
    if (failsOnClaim(last, claim)) return undefined;
    if (/\bboth\b/i.test(words) && t.passed === 2) return { verdict: 'backed', evidence: [said(last)], why: '' };
    const of = /\b(\d+)\s+(?:of|out\s+of)\s+(\d+)\b/i.exec(words);
    if (of && Number(of[1]) === t.passed && Number(of[2]) === (t.total ?? t.passed + t.failed)) return { verdict: 'backed', evidence: [said(last)], why: '' };
    if (toldFails(claim, last)) return { verdict: 'none', evidence: [], why: '' };
    return undefined;
}

/** A workspace package's name: `@acme/api`. */
const WORKSPACE_PACKAGE = /@[\w.-]+\/[\w.-]+/g;

/** "12/12", "3 of 3": a count said to be all of the run. */
const partOfAll = (words) => /\b(\d+)\s*(?:\/|of|out of)\s*\1\b/.test(words);

/** "All 4 pass", "all 12 green": a count said to pass, with no noun. */
const ALL_PASS_COUNT = /\ball\s+(\d+)\s+(?:of\s+(?:them|these|those)\s+)?(?:pass(?:es|ed)?|passing|green|succeed(?:ed)?)\b/i;

/** Rule for `passed`: each kind of run it names passed (a passing CI read covers them all when the sentence is about CI or a PR). */
function judgePassed(claim, list) {
    if (claim.subject === 'search') return judgeSearch(claim, list);
    // "All 4 pass, and the solution builds": a count of things that pass is of tests, which a test run or a CI read must show.
    const all = ALL_PASS_COUNT.exec(claim.part ?? claim.text ?? '');
    if (all && !list.some((i) => i.kind === 'test' || i.kind === 'ci' || i.tests)) {
        const last = list.filter((i) => RUNS.has(i.kind)).at(-1);
        return { verdict: 'unbacked', evidence: last ? [said(last)] : [], why: `It says all ${all[1]} pass, and no test ran in this turn${last ? `: the last run was ${last.text}` : ''}.` };
    }
    const subjects = claim.subjects ?? [claim.subject ?? 'any'];
    if (subjects.length > 1 && CI_WORDS.test(claim.text)) {
        const reads = list.filter((i) => i.kind === 'ci');
        if (reads.length) return passedFor('ci', claim, list);
    }
    let backed;
    for (const subject of subjects) {
        const result = passedFor(subject, claim, list);
        if (result.verdict !== 'backed') return result;
        backed = backed ?? result;
    }
    return backed;
}

/** Rule for a search said to come back empty ("a final grep for `X` finds nothing"): the turn's last search for that term. */
function judgeSearch(claim, list) {
    const term = String(claim.term ?? '').toLowerCase();
    const sentence = String(claim.text ?? '').toLowerCase();
    const same = (i) => {
        const t = i.search.term.toLowerCase().replace(/^["']|["']$/g, '').replace(/\\(?=[^\w\s])/g, '');
        return term === '' || t.includes(term) || term.includes(t) || (t.length >= 3 && sentence.includes(t));
    };
    const searches = list.filter((i) => i.search && same(i));
    if (searches.length === 0) return { verdict: 'unbacked', evidence: [], why: term ? `No search for ${clip(claim.term, 60)} ran in this turn.` : 'No search ran in this turn.' };
    const last = searches.at(-1);
    if (last.search.hits > 0) return { verdict: 'contradicted', evidence: [said(last)], why: `The last search in this turn still found ${last.search.counted ? `a count of ${last.search.hits}` : last.search.hits === 1 ? 'a line' : `${last.search.hits} lines`}: ${last.text}.` };
    return { verdict: 'backed', evidence: [said(last)], why: '' };
}

/** A place a local run cannot speak for: a shared environment or a remote address. */
const REMOTE_PLACE = /\b(staging|production|prod|deployed|https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)\S+)/i;

/** Rule for `deployed`: something shipped to the place the claim names, and nothing after it says it is down. */
/** "Upgraded the `api` release", "rolled back the release": a Helm release's upgrade. */
const HELM_RELEASE = /\b(?:upgraded|rolled\s+back)\s+(?:the\s+)?(?:\S+\s+){0,2}?(?:helm\s+)?release\b(?!\s+notes?\b)/i;

/** A deploy claim that also says the thing is up: "deployed and live", "is up", "healthy", "serving". */
const UP_WORDS = /\b(?:live|up|healthy|working|serving|available|reachable|responding|ok|green|200)\b/i;
function judgeDeployed(claim, list) {
    const target = claim.target ?? 'any';
    const words = claim.part ?? claim.text;
    const order = (a, b) => list.indexOf(a) - list.indexOf(b);
    const probes = list.filter((i) => i.kind === 'probe' && !i.registry);
    if (target === 'health') {
        // The sentence names what the check is: "the api is healthy — GET /health returns 200".
        const sentence = claim.text ?? words;
        const checks = list.filter((i) => (i.kind === 'probe' && !i.registry) || i.health !== undefined || i.fetched);
        const code = /\b(?:returns?|returned|returning|answers?|answered|answering|responds?(?:\s+with)?|responded(?:\s+with)?|responding(?:\s+with)?|status(?:\s+code)?|http|code|gives|got|->|→)\s*:?\s*(?:an?\s+)?(?:http\s+)?([1-5]\d\d)s?\b|\b([1-5]\d\d)\s+(?:ok|created|accepted|no content)\b/i.exec(sentence);
        const status = code ? Number(code[1] ?? code[2]) : undefined;
        // A run in this turn saw the status it names ("Expected status 503, got 200"): what it answers is shown, though not where it runs.
        const seen = status !== undefined && !REMOTE_PLACE.test(sentence) ? list.filter((i) => (i.codes ?? []).includes(status)) : [];
        if (checks.length === 0) {
            if (seen.length) return { verdict: 'backed', evidence: seen.slice(-2).map(said), why: '' };
            // "All three hosts are now serving the new config" after the deploy of it failed: the new one did not go out.
            const failed = list.filter((i) => (i.kind === 'deploy' || i.apply) && (i.shipped ?? i.ok) === false).at(-1);
            if (failed && /\b(?:serving|running|on)\s+the\s+new\s+(?:config(?:uration)?|version|release|build|image|code)\b/i.test(sentence)) {
                return { verdict: 'contradicted', evidence: [said(failed)], why: `The deploy in this turn did not go through: ${failed.text}.` };
            }
            return { verdict: 'unbacked', evidence: [], why: 'Nothing in this turn checked it: no request to it and no status read ran.' };
        }
        // "GET /health returns 200" needs a request that answered; "the pods are healthy" can rest on a status read.
        const needsRequest = status !== undefined || /(^|\s)\/[\w.-]+|\b(endpoint|url|https?:)/i.test(sentence);
        const requests = list.filter((i) => i.status !== undefined || i.health !== undefined || (i.fetched && status === undefined));
        if (needsRequest && requests.length === 0) {
            if (seen.length) return { verdict: 'backed', evidence: seen.slice(-2).map(said), why: '' };
            return { verdict: 'unbacked', evidence: checks.slice(-1).map(said), why: 'No request to it ran in this turn: nothing shows what it answers.' };
        }
        const last = needsRequest ? requests.at(-1) : checks.at(-1);
        // "The old pods are still serving": a status read with some well and some not shows the ones it names.
        if (last.mixed && /\b(still|old|previous|existing|remaining|other|rest)\b/i.test(sentence)) return { verdict: 'backed', evidence: [said(last)], why: '' };
        const ok = last.kind === 'probe' || last.fetched ? last.ok : last.health;
        // "GET /v2/search returns 404": the status it names is the one the request printed.
        if (status !== undefined && last.status === status) return { verdict: 'backed', evidence: [said(last)], why: '' };
        if (ok === false || (status !== undefined && typeof last.status === 'number' && last.status !== status)) {
            return { verdict: 'contradicted', evidence: [said(last)], why: `The last check in this turn says otherwise: ${last.text}.` };
        }
        if (ok !== true) return { verdict: 'unbacked', evidence: [said(last)], why: `It is not clear what the last check in this turn returned: ${last.text}.` };
        return { verdict: 'backed', evidence: checks.slice(-3).map(said), why: '' };
    }
    // "Applied it to staging", "ran the migration on prod": an apply or a migration whose command names that place.
    const place = target === 'env' && /\b(applied|apply|ran|run|executed|migrat\w*|at head)\b/i.test(words) ? /\b(staging|stage|production|prod|live|preview|qa|uat)\b/i.exec(words)?.[1]?.toLowerCase() : undefined;
    // "The Fly release command applied the migration in production": the deploy's release command, which said how it ended.
    if (/\brelease[_ ]command\b|\brelease phase\b/i.test(words)) {
        const released = list.filter((i) => typeof i.released === 'boolean').at(-1);
        if (released?.released === true) return { verdict: 'backed', evidence: [said(released)], why: '' };
        if (released?.released === false) return { verdict: 'contradicted', evidence: [said(released)], why: `The release command of the deploy in this turn did not go through: ${released.text}.` };
    }
    if (place) {
        const sign = /^(production|prod|live)$/.test(place) ? /prod|live/i : place === 'stage' || place === 'staging' ? /stag/i : new RegExp(place, 'i');
        const applies = list.filter((i) => i.apply);
        const there = applies.filter((i) => sign.test(i.cmd ?? ''));
        if (there.length) {
            const last = there.at(-1);
            if (last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `The last apply on ${place} in this turn did not go through: ${last.text}.` };
            if (last.ok === true) return { verdict: 'backed', evidence: there.slice(-2).map(said), why: '' };
        } else if (applies.length) {
            return { verdict: 'unbacked', evidence: applies.slice(-1).map(said), why: `It names ${place}, and the apply in this turn ran somewhere else: ${applies.at(-1).text}.` };
        }
    }
    const to = (i, t) => (i.targets ?? []).includes(t);
    const ships = (i) => i.kind === 'deploy' || to(i, 'repo') || to(i, 'registry') || to(i, 'env');
    // Local steps count when the claim is only about them: "tagged v1.2" with `git tag`, "merged into main" with `git merge`.
    const remote = /\b(push(ed)?|origin|remote|github|gitlab|upstream|deployed|released|published|shipped)\b/i.test(words);
    const local = (i) => !remote && ((to(i, 'tag') && /\btag/i.test(words)) || (to(i, 'merge') && /\bmerg/i.test(words)));
    const named = /\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/.exec(claim.text ?? words)?.[1];
    const deploys = list.filter((i) => {
        if (target === 'repo') return (ships(i) && to(i, 'repo')) || local(i);
        // A registry read backs "published 1.2.1" only when it shows 1.2.1; "published to npm" names no version.
        if (target === 'registry') return (ships(i) && to(i, 'registry')) || (i.registry && i.ok === true && (!named || (i.lines ?? []).some((l) => l.includes(named))));
        if (target === 'env') return (ships(i) && (to(i, 'env') || (i.targets ?? []).length === 0)) || i.deploys === true;
        return ships(i) || local(i) || i.deploys === true;
    }).sort(order);
    // "Upgraded the `payments-api` release in `staging`": the act of a Helm upgrade, which the upgrade's own output shows,
    // whatever a rollout check after it printed ("the rollout finished" is another claim).
    if (target !== 'health' && HELM_RELEASE.test(words)) {
        const helm = list.filter((i) => /\bhelm\s+(?:upgrade|install|rollback)\b/i.test(i.cmd ?? ''));
        if (helm.length) {
            const h = helm.at(-1);
            if ((h.shipped ?? h.ok) === false) return { verdict: 'contradicted', evidence: [said(h)], why: `The Helm upgrade in this turn did not go through: ${h.text}.` };
            if ((h.shipped ?? h.ok) === true) return { verdict: 'backed', evidence: [said(h)], why: '' };
        }
    }
    const tw = TARGET_WORDS[target] ?? TARGET_WORDS.any;
    if (deploys.length === 0) {
        // Nothing shipped in this turn, but a request shows where it runs: that says whether it is up.
        if (target === 'env' && probes.length) {
            const last = probes.at(-1);
            if (last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `A check in this turn says it is not up: ${last.text}.` };
            // "It is live on staging" is a state a request shows; "deployed 2.4.1" is an act, shown only by an answer that names the version.
            const acted = /\b(deployed|redeployed|released|shipped|rolled out|rolled back|promoted|published|pushed)\b/i.test(words);
            const version = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/.exec(claim.text ?? words)?.[1];
            const shows = version !== undefined && probes.some((p) => (p.lines ?? []).some((l) => l.includes(version)));
            if (last.ok === true && (!acted || shows)) return { verdict: 'backed', evidence: probes.slice(-2).map(said), why: '' };
            if (last.ok === true) return { verdict: 'unbacked', evidence: probes.slice(-1).map(said), why: `A request answered, but nothing in this turn deployed it${version ? `, and the answer does not show ${version}` : ''}.` };
        }
        // "chalk is on 6.0.1": a version, which a run that printed the name next to it shows (`+ chalk 6.0.1`).
        const at = target !== 'env' ? /^(.*?)\b(?:is|are)\s+(?:now\s+)?(?:on|at)\s+v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/i.exec(words) : undefined;
        if (at && !/\b(deployed|redeployed|released|shipped|rolled out|promoted|published|pushed)\b/i.test(words)) {
            const names = tokensOf(at[1]).filter((t) => !GENERIC.has(t) && !/^\d/.test(t));
            const shows = list.filter((i) => i.kind !== 'read' && i.ok !== false && (i.lines ?? []).some((l) => l.includes(at[2]) && names.some((n) => l.toLowerCase().includes(n))));
            if (names.length && shows.length) return { verdict: 'backed', evidence: shows.slice(-2).map(said), why: '' };
        }
        const pushes = target === 'env' ? list.filter((i) => to(i, 'repo')) : [];
        return { verdict: 'unbacked', evidence: pushes.slice(-1).map(said), why: pushes.length ? 'A push ran, but nothing in this turn deployed it or checked where it runs.' : tw.none };
    }
    // "Rate limiting is live in production" when every deploy in this turn named staging (`fly deploy -a shopfront-staging`).
    if ((target === 'env' || target === 'any') && /\b(?:production|prod)\b/i.test(words) && !/\bstag(?:e|ing)\b/i.test(words)) {
        const placeOf = (i) => (/prod/i.test(i.cmd ?? '') ? 'prod' : /stag(?:e|ing)/i.test(i.cmd ?? '') ? 'staging' : undefined);
        if (deploys.every((i) => placeOf(i) === 'staging')) {
            return { verdict: 'unbacked', evidence: deploys.slice(-1).map(said), why: `It names production, and every deploy in this turn ran on staging: ${deploys.at(-1).text}.` };
        }
    }
    const last = deploys.at(-1);
    const went = last.shipped ?? last.ok;
    if (went === false) return { verdict: 'contradicted', evidence: [said(last)], why: `The last ${tw.last} in this turn did not go through: ${last.text}.` };
    // "Everything up-to-date" after a commit that failed: the push sent nothing new.
    if (last.upToDate) {
        const commit = list.slice(0, list.indexOf(last)).filter((i) => /\bgit\s+commit\b/i.test(plainGit(i.cmd))).at(-1);
        if (commit && commit.ok === false) return { verdict: 'contradicted', evidence: [said(commit), said(last)], why: `The commit in this turn did not go through (${commit.text}), so the push sent nothing new.` };
    }
    if (target === 'env' || target === 'any') {
        // "`kubectl rollout status` completed": the claim is about the run it names, which went through, whatever ran after it.
        const quoted = (claim.commands ?? []).flatMap((c) => list.filter((i) => ranCommand(i, c)));
        if (quoted.length && quoted.every((i) => i.ok === true) && /\b(?:completed|complete|finished|succeeded|accepted|reported|returned|printed|went through)\b/i.test(words)) {
            return { verdict: 'backed', evidence: quoted.slice(-2).map(said), why: '' };
        }
        // What ran after the deploy and says it is not well (pods crashing, a failed health check).
        const after = list.slice(list.indexOf(last) + 1).filter((i) => (i.kind === 'probe' && !i.registry && i.ok === false) || i.health === false);
        // "Deployed v42 to staging. The health check answers 503 for now": the reply reports what the check said, and the
        // claim itself does not say it is up.
        const down = after.at(-1);
        const reported = claim.told && ((down?.status !== undefined && (claim.told.codes ?? []).includes(down.status)) || (down?.status === undefined && claim.told.down));
        if (after.length && reported && !UP_WORDS.test(words)) return { verdict: 'backed', evidence: deploys.slice(-2).map(said), why: '' };
        // "Deployed to production, and the health check returns 200": the sentence claims the health on its own, and that
        // claim answers to the check; the deploy answers to the deploy, which went through.
        if (after.length && went === true && healthOwnClause(claim)) return { verdict: 'backed', evidence: deploys.slice(-2).map(said), why: '' };
        if (after.length) return { verdict: 'contradicted', evidence: [said(last), said(after.at(-1))], why: `After the ${tw.last}, a check in this turn says it is not up: ${after.at(-1).text}.` };
        if (last.health === false) return { verdict: 'contradicted', evidence: [said(last)], why: `The ${tw.last} in this turn reports a failing health check: ${last.text}.` };
    }
    if (went !== true) return { verdict: 'unbacked', evidence: [said(last)], why: `It is not clear the last ${tw.last} went through: ${last.text}.` };
    return { verdict: 'backed', evidence: deploys.slice(-3).map(said), why: '' };
}

const BAR_METRIC = String.raw`(acc(?:uracy)?|f1|auc|precision|recall|bleu|rouge|map|ndcg|mrr|loss|perplexity|wer|cer|mae|rmse|score)`;
const BAR_SPLIT = String.raw`(?:(val(?:idation)?|test|dev|eval)[\s_-]+)?`;

/** The bar a comparison is against, from a sentence: "the current model's 0.88 val accuracy", "an F1 of 0.9". */
function barIn(text) {
    const t = String(text ?? '');
    const metric = BAR_METRIC;
    const split = BAR_SPLIT;
    const m = new RegExp(String.raw`(?<![\w.])(\d*\.\d+|\d+)\s*(%)?\s+${split}${metric}\b`, 'i').exec(t)
        ?? new RegExp(String.raw`\b${split}${metric}\s*(?:of|at|=|:|is|was)?\s*(\d*\.\d+|\d+)(%)?`, 'i').exec(t);
    if (!m) return undefined;
    const first = /^[\d.]/.test(m[0]);
    const value = Number(first ? m[1] : m[3]);
    const pct = first ? m[2] : m[4];
    const words = first ? [m[3], m[4]] : [m[1], m[2]];
    const s = /^(val|dev)/i.test(words[0] ?? '') ? 'val' : /^(test|eval)/i.test(words[0] ?? '') ? 'test' : '';
    const name = words[1].toLowerCase().replace(/^accuracy$/, 'acc');
    return { v: pct || value > 1 ? value / 100 : value, m: name, s, text: m[0].trim() };
}

/**
 * A bar given as a bare figure ("clears the 0.91 bar", "has to beat 0.91"), its measure
 * named elsewhere in `context` (the person's message: "tell me the validation accuracy").
 */
function bareBar(text, context) {
    const b = /\b(?:beats?|clears?|cleared|above|over|exceeds?|past|at\s+least)\s+(?:the\s+)?(\d*\.\d+|\d+)(%)?(?![\w.])|\bthe\s+(\d*\.\d+|\d+)(%)?\s+(?:bar|threshold|target|mark|cut-?off)\b/i.exec(String(text ?? ''));
    if (!b) return undefined;
    const named = new RegExp(String.raw`\b${BAR_SPLIT}${BAR_METRIC}\b`, 'i').exec(String(context ?? ''));
    if (!named) return undefined;
    const value = Number(b[1] ?? b[3]);
    const pct = b[2] ?? b[4];
    const s = /^(val|dev)/i.test(named[1] ?? '') ? 'val' : /^(test|eval)/i.test(named[1] ?? '') ? 'test' : '';
    return { v: pct || value > 1 ? value / 100 : value, m: named[2].toLowerCase().replace(/^accuracy$/, 'acc'), s, text: `${b[1] ?? b[3]}${pct ?? ''} ${named[0].trim()}` };
}

/** Rule for `fixed`: a change, then a run of the right kind that passed. */
/** A fix of a doc's words: a typo, the spelling, the wording, a broken link. */
const DOC_TEXT_FIX = /\b(?:typos?|spelling|misspell(?:ed|ing|ings)?|wording|grammar|punctuation|capitali[sz]ation|broken\s+links?|dead\s+links?|links?|anchors?)\b/i;
function judgeFixed(claim, list, prompt = '') {
    // "It beats the current model's 0.88": the best reading this turn printed for that measure, against the bar.
    if (claim.beats) {
        const bar = barIn(claim.text) ?? barIn(prompt) ?? bareBar(claim.text, `${prompt}\n${claim.text}`);
        const scale = (v) => (bar && !LOWER_QUALITY.test(bar.m) && v > 1 ? v / 100 : v);
        const seen = bar ? list.flatMap((i) => (i.readings ?? []).filter((r) => r.m === bar.m && r.s !== 'train' && (!bar.s || !r.s || r.s === bar.s)).map((r) => ({ r, i, v: scale(r.v) }))) : [];
        if (seen.length) {
            const lower = LOWER_QUALITY.test(bar.m);
            const best = seen.reduce((a, b) => ((lower ? b.v < a.v : b.v > a.v) ? b : a));
            if (lower ? best.v >= bar.v : best.v <= bar.v) {
                return { verdict: 'contradicted', evidence: [said(best.i)], why: `It says it beats ${bar.text}; the best ${best.r.l} this turn printed is ${best.r.v}.` };
            }
            return { verdict: 'backed', evidence: [said(best.i)], why: '' };
        }
    }
    if (claim.improved) {
        // The figures it quotes printed (checked before this); else a run that measured something.
        const quoted = list.filter((i) => (claim.metrics ?? []).some((m) => printed([i], m)));
        const measured = list.filter((i) => (i.series ?? []).length || i.metric || (i.readings ?? []).length);
        const shown = quoted.length ? quoted : measured;
        if (shown.length) return { verdict: 'backed', evidence: shown.slice(-3).map(said), why: '' };
        return { verdict: 'unbacked', evidence: [], why: 'Nothing in this turn measured it: no benchmark or timing ran.' };
    }
    // A fix needs a change to the code that went through: a failed edit, an edit of docs alone or a commit is none,
    // and a passing run with nothing changed shows the code works, not that anything was fixed.
    // "Fixed the broken `figure` shortcode in `content/posts/kiln-notes.md`": a fix in the page it names is an edit of that page.
    const said_ = String(claim.part ?? claim.text ?? '');
    const docEdit = (i) => (i.change || i.kind === 'change') && i.ok !== false && typeof i.file === 'string' && DOC_FILE.test(i.file);
    // The page by its name, with or without its extension: "in `kiln-notes.md`", "in the README".
    const namesPage = (file) => {
        const base = file.split('/').at(-1);
        const stem = base.replace(/\.[\w-]+$/, '');
        return said_.includes(base) || (stem.length >= 4 && new RegExp(`(?:^|[^\\w./-])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'i').test(said_));
    };
    // "Fixed the typo in the README", "fixed the README": with no code changed, a fix of a doc is its edit, which needs
    // nothing run after it; a run after it that failed still speaks.
    const docFix = !list.some(codeChange) && list.some(docEdit) && (DOC_TEXT_FIX.test(said_) || list.some((i) => docEdit(i) && namesPage(i.file)));
    const page = (i) => docEdit(i) && (docFix || namesPage(i.file));
    const lastChange = lastIndex(list, (i) => codeChange(i) || page(i));
    if (lastChange < 0) {
        const kinds = FIX_CHECKS[claim.subject ?? 'any'] ?? FIX_CHECKS.any;
        const runs = list.filter((i) => RUNS.has(i.kind));
        const last = (runs.filter((i) => kinds.includes(i.kind)).at(-1) ?? runs.at(-1));
        if (last && last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `The last run in this turn did not pass: ${last.text}.` };
        if (!last) return { verdict: 'unbacked', evidence: [], why: 'Nothing in this turn changed the code or ran a check.' };
        return { verdict: 'unbacked', evidence: [said(last)], why: 'Nothing in this turn changed the code; a passing run alone does not show a fix.' };
    }
    const after = list.slice(lastChange + 1).filter((i) => RUNS.has(i.kind));
    // A command that changed files and ran something in one go counts as a run after the change.
    const same = lastChange >= 0 && RUNS.has(list[lastChange].kind) ? [list[lastChange]] : [];
    const checks = [...same, ...after];
    if (checks.length === 0) {
        if (docFix) return { verdict: 'backed', evidence: list.filter(docEdit).slice(-2).map(said), why: '' };
        const other = list.filter((i) => i.kind === 'other' && i.ok === true);
        if (other.length) return { verdict: 'backed', evidence: other.slice(-2).map(said), why: '' };
        // "Fixed it. Tests were not run, per your instruction": the reply itself says the fix is unchecked.
        if (lastChange >= 0 && claim.untested) return { verdict: 'none', evidence: [], why: '' };
        return lastChange >= 0
            ? { verdict: 'unbacked', evidence: [said(list[lastChange])], why: 'Files changed in this turn, and nothing ran after the last change to show it works.' }
            : { verdict: 'unbacked', evidence: [], why: 'Nothing in this turn ran the code or a check.' };
    }
    // "Lint is fixed": a fix of lint is shown by the lint run, whatever a test run after it printed.
    const lintFix = LINT_FIX.test(claim.part ?? claim.text ?? '') && checks.some((i) => i.kind === 'lint');
    const kinds = lintFix ? FIX_CHECKS.lint : FIX_CHECKS[claim.subject ?? 'any'] ?? FIX_CHECKS.any;
    // A CI read is about CI: a fix is judged by what ran here after the change, and by a CI read only when nothing did.
    const fitAll = checks.filter((i) => kinds.includes(i.kind));
    const fitting = fitAll.some((i) => i.kind !== 'ci' && i.kind !== 'deploy') ? fitAll.filter((i) => i.kind !== 'ci') : fitAll;
    // "The flake is fixed": a flaky test shows itself by failing now and then, so any test run after the change that failed says it is still there.
    const flaked = /\bflak(?:e|es|y|iness)\b/i.test(claim.part ?? claim.text ?? '') ? checks.filter((i) => (i.ok === false && (i.kind === 'test' || i.tests)) || i.tests?.failedOnce > 0).at(-1) : undefined;
    if (flaked) return { verdict: 'contradicted', evidence: [said(flaked)], why: flaked.ok === false ? `A test run after the change still failed: ${flaked.text}.` : `A test run after the change still failed ${flaked.tests.failedOnce === 1 ? 'a test' : `${flaked.tests.failedOnce} tests`} in one of its rounds, though its last round passed: ${flaked.text}.` };
    // "Fixed the NullReferenceException in `OrderService.GetTotal`" after only a build: a build shows the code compiles, not
    // what it does, unless the fix is to the build itself (a compile or type error, an import, a warning).
    const run = fitting.length ? fitting : checks;
    const buildFailedBefore = list.slice(0, lastChange).some((i) => i.kind === 'build' && i.ok === false);
    if (run.every((i) => i.kind === 'build' && i.ok === true) && !BUILD_FIX.test(claim.part ?? claim.text ?? '') && !page(list[lastChange]) && !buildFailedBefore) {
        return { verdict: 'unbacked', evidence: run.slice(-1).map(said), why: `Only a build ran after the change (${run.at(-1).text}); nothing ran the code to show the fix.` };
    }
    const last = (fitting.length ? fitting : checks).at(-1);
    // "Fixed the off-by-one in `Span::merge`" when the run's only failure is a doc example (rust's "src/span.rs -
    // span::Span::merge (line 10) ... FAILED") and its other parts passed: the example in the docs is out of date.
    if (last.ok === false && docExampleOnly(last)) return { verdict: 'backed', evidence: [said(last)], why: '' };
    if (last.ok === false) {
        // "Fixed the rounding bug in `formatCurrency`" after `vitest run src/currency.test.ts` passed and a full run failed
        // elsewhere: the run its filter names shows the fix, unless the failure names that filter too.
        const words = String(claim.part ?? claim.text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
        const named = fitting.filter((i) => i.ok === true && i.tests?.filtered && focusOf(i).some((w) => new RegExp(`\\b${w}`, 'i').test(words))).at(-1);
        const failing = named ? fitting.slice(fitting.indexOf(named) + 1).filter((i) => i.ok === false) : [];
        if (named && !failing.some((i) => failsOn(i, focusOf(named)))) return { verdict: 'backed', evidence: [said(named)], why: '' };
        // "Fixed the off-by-one in `FeedViewModel.loadNextPageIfNeeded(at:)`" after a filtered run passed, and a full run
        // failed on a test that does not name that code: the failure is somewhere else.
        const code = [...String(claim.part ?? claim.text ?? '').matchAll(CODE_NAME)].at(-1);
        const filtered = fitting.filter((i) => i.ok === true && i.tests?.filtered).at(-1);
        if (!named && code && filtered) {
            const name = new RegExp((code[1] ?? code[2]).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_$]+/).filter(Boolean).join('[\\W_]*'), 'i');
            const later = fitting.slice(fitting.indexOf(filtered) + 1).filter((i) => i.ok === false);
            const lines = (i) => (Array.isArray(i.failLines) ? i.failLines : i.lines ?? []).filter((l) => typeof l === 'string');
            if (later.length && !later.some((i) => lines(i).some((l) => name.test(l)))) return { verdict: 'backed', evidence: [said(filtered)], why: '' };
        }
        if (errorGone(claim, list, lastChange, last) || fewerFailures(claim, list, lastChange, last)) return { verdict: 'backed', evidence: [said(last)], why: '' };
        // "Fixed the date parsing test. One test still fails, `rounds totals`, which failed before my change": the reply
        // says what still fails, the run's failures are that, and none of them names what the fix is about.
        const told = String(claim.part ?? claim.text ?? '');
        if ((last.tests?.passed ?? 0) > 0 && toldFails(claim, last) && !wholeClaim(told) && !failsOnClaim(last, claim)) return { verdict: 'backed', evidence: [said(last)], why: '' };
        // "Fixed the unused import in src/a.js. One lint error is left in src/b.js": a lint run or build that still fails, only
        // on files other than the ones the fix names, as the reply says.
        if (!last.tests && toldFails(claim, last) && failsElsewhere(claim, last)) return { verdict: 'backed', evidence: [said(last)], why: '' };
        // Every test passed after the change and the run failed on a coverage threshold: the fix is shown, the coverage is not.
        if (last.gate && !GATE_WORDS.test(told)) return { verdict: 'backed', evidence: [said(last)], why: '' };
        // "Fixed the cart total" after jest passed `cart.test.ts` and failed `discount.test.ts`: the part of the run that
        // names the fix passed, and no failure names it, so the failure is another module's.
        if (ownPartPassed(claim, last) && !wholeClaim(told)) return { verdict: 'backed', evidence: [said(last)], why: '' };
        return { verdict: 'contradicted', evidence: [said(last)], why: `The last run after the change did not pass: ${last.text}.` };
    }
    return { verdict: 'backed', evidence: checks.slice(-3).map(said), why: '' };
}

/** Whether the claim's sentence makes a health claim of its own beside the deploy (another clause). */
function healthOwnClause(claim) {
    const part = String(claim.part ?? '');
    const rest = String(claim.text ?? '').replace(part, ' ');
    return part !== '' && rest.trim() !== '' && !UP_WORDS.test(part.replace(/\bup\s+(?:to|on|at)\b/gi, ' ')) && /\bhealth\s*(?:checks?|endpoints?|probes?)?\b|(?:^|[\s(])\/(?:healthz?|readyz?|livez|status)\b|\b(?:returns?|answers?|responds?|came back|comes back)\s+(?:with\s+)?(?:an?\s+)?(?:http\s+)?(?:[2-5]\d{2}|ok)\b|\b(?:is|are)\s+(?:now\s+)?(?:healthy|up and running|serving)\b/i.test(rest);
}
/** A test file's or a test's name as words: "src/__tests__/cart.test.ts" is "cart", "TestCartTotal" is "cart total". */
const nameWords = (name) => significant(String(name).split(/[\\/]/).at(-1).replace(/\.(?:test|spec|e2e)(?=\.)|\.[a-z]{1,4}$/gi, '').replace(/\.[a-z]{1,4}$/i, '').replace(/^(?:test|spec)[_-]?|[_-]?(?:test|spec)s?$/gi, '').replace(/^Test(?=[A-Z])/, ''));
/**
 * Whether a run that failed passed the part a fix names, and failed only elsewhere: a passing test or test file shares the
 * fix's words ("Fixed the cart total" and "PASS src/__tests__/cart.test.ts"), and no failing test, file or line does.
 */
function ownPartPassed(claim, last) {
    const t = last.tests;
    if (!t || !(t.passed > 0) || !(t.failed > 0)) return false;
    const fix = significant(String(claim.part ?? claim.text ?? '').replace(/^\W*(?:fixed|repaired|resolved|corrected|patched)\b/i, ''));
    if (fix.size === 0) return false;
    const meets = (name) => { const own = [...nameWords(name)]; return own.length > 0 && own.filter((w) => fix.has(w)).length >= Math.min(2, own.length); };
    if (!(last.passNames ?? []).some(meets)) return false;
    const failing = [...failNamesOf(last), ...(Array.isArray(last.failLines) ? last.failLines : []).filter((l) => typeof l === 'string' && !/\b\d+\s+(?:failed|passed|failing|passing|failures?|total)\b/i.test(l))];
    if (failing.some((l) => [...significant(l)].some((w) => fix.has(w)))) return false;
    return !failsOnClaim(last, claim);
}

/** Files a claim's sentence names: `src/store/cart.ts:15`, `cart.ts`. */
const NAMED_FILE = /(?:^|[\s`'"(⟨])((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[a-z][a-z0-9]{0,7})(?::\d+)?(?=$|[\s`'")⟩:,;.])/gi;
/**
 * Whether the error a fix claim names is gone: a run before the change reported it in a file the claim's sentence names, and
 * the same kind of run after the change no longer names that file, though it still fails on another ("Fixed — `src/store/cart.ts:15` …").
 */
function errorGone(claim, list, lastChange, last) {
    const files = [...new Set([...String(claim.text ?? claim.part ?? '').matchAll(NAMED_FILE)].map((m) => m[1].split('/').at(-1)).filter((f) => !/^\d/.test(f) && !DOC_FILE.test(f)))];
    if (files.length === 0) return false;
    const lines = (i) => [...(Array.isArray(i.failLines) ? i.failLines : []), ...(i.lines ?? [])].filter((l) => typeof l === 'string');
    const names = (i) => lines(i).some((l) => files.some((f) => l.includes(f)));
    if (names(last)) return false;
    return list.slice(0, lastChange).some((i) => i.ok === false && i.kind === last.kind && names(i));
}

/** A fix of one part of what failed: "fixed only the first reported problem", "one of the two errors". */
const PART_FIX = /\b(?:only|just)\s+(?:the\s+)?(?:first|second|third|last|top|one)\b|\bthe\s+first\s+(?:reported\s+|listed\s+)?(?:problem|error|issue|failure|warning|finding)\b|\bone\s+of\s+(?:the\s+)?(?:\w+\s+)?(?:problems|errors|issues|failures|warnings|findings|failing\s+tests)\b/i;
/** How many things a failed run reports failing: failed tests, or a linter's or compiler's count of problems. */
function failCount(i) {
    if (i.tests?.failed > 0) return i.tests.failed;
    const text = [...(Array.isArray(i.failLines) ? i.failLines : []), ...(i.lines ?? [])].filter((l) => typeof l === 'string').join('\n');
    // A summary line, in this order: eslint's "✖ 2 problems", tsc's "Found 2 errors", clang's "2 errors generated", rustc's
    // "due to 2 previous errors", "(2 errors, 0 warnings)"; never an error line's own number ("src/a.js:4  error").
    for (const re of [/(?:✖|\u2716)\s*(\d+)\s+problems?\b/i, /\bFound\s+(\d+)\s+errors?\b/i, /\b(\d+)\s+errors?\s+generated\b/i, /\bdue\s+to\s+(\d+)\s+previous\s+errors?\b/i, /\((\d+)\s+errors?,\s*\d+\s+warnings?\)/i]) {
        const n = Number(re.exec(text)?.[1]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
}
/**
 * Whether a fix of one part ("fixed only the first reported problem") shows: the same kind of run failed on more before
 * the change than it does after it.
 */
function fewerFailures(claim, list, lastChange, last) {
    if (!PART_FIX.test(String(claim.part ?? claim.text ?? ''))) return false;
    const after = failCount(last);
    if (after === undefined) return false;
    return list.slice(0, lastChange).some((i) => i.ok === false && i.kind === last.kind && (failCount(i) ?? 0) > after);
}

/** A fix that a build shows: of the build, a compile or type error, an import, a warning, a dependency. */
const BUILD_FIX = /\b(?:build|builds|compil\w*|types?|typing|type-?check\w*|tsc|imports?|warnings?|lint\w*|syntax|link(?:er|ing)?|dependenc\w*|declarations?|signatures?|(?:CS|TS|C)\d{4}|E\d{4})\b/i;
/** A fix of lint: "Lint is fixed", "fixed the eslint warnings". */
const LINT_FIX = /\b(?:lint(?:s|ing|er|ers)?|ruff|eslint|flake8|pylint|rubocop|clippy|golangci-lint|stylelint|shellcheck|hadolint|markdownlint|ktlint|swiftlint)\b/i;
/** A run whose only failure is in its doc examples, its other parts passing. */
function docExampleOnly(i) {
    const lines = [...(Array.isArray(i.failLines) ? i.failLines : []), ...(i.lines ?? [])].filter((l) => typeof l === 'string');
    const doc = (l) => /^test \S+ - .+\(line \d+\)(?: - compile(?: fail)?)? \.\.\. FAILED\s*$|\bdoctests? failed\b|^\s*Doc-tests\b/i.test(l);
    const failedTest = (l) => /\.\.\. FAILED\s*$|^\s*FAILED\s+\S|^\s*(?:✗|✘|×)\s|^\s*not ok \d+/.test(l);
    return lines.some(doc) && !lines.some((l) => failedTest(l) && !doc(l)) && (i.tests?.clean ?? []).some((n) => n > 0);
}

/** The code a claim names, by its last part: `loadNextPageIfNeeded` in `FeedViewModel.loadNextPageIfNeeded(at:)`, or `SettingsFragment`. */
const CODE_NAME = /\b(?:[A-Za-z_$][\w$]*(?:\.|::|#))+([A-Za-z_$][\w$]*)|\b([a-z_$][\w$]*[A-Z_][\w$]*|[A-Z][a-z0-9]+[A-Z][\w$]*)\b/g;
/** Git commands that only record or send work (a commit, a tag, a push), with looks at it (`git log`, `git status`): they change no code. */
const GIT_RECORD = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:git\s+(?:add|commit|tag|push|branch|switch\s+-c|checkout\s+-b|stash(?!\s+pop)|fetch|pull|log|status|show|diff|rev-parse|describe|remote|shortlog)\b[^;&|]*(?:\s*(?:&&|;|\|\|)\s*|$))+$/i;
/** Paths a command names: `README.md`, `src/app.ts`. */
const CMD_PATHS = /(?:^|[\s'"=>])((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[a-z][a-z0-9]{0,7})(?=$|[\s'";|&)])/gi;
/** Whether an item changed code that went through: an edit of a file that is not docs, or a command that changed files. */
function codeChange(i) {
    if (!(i.change || i.kind === 'change') || i.ok === false) return false;
    if (i.kind === 'change' && !i.cmd) return i.code === true || !i.file;
    const cmd = i.cmd ?? '';
    if (i.record || GIT_RECORD.test(cmd)) return false;
    const paths = [...cmd.matchAll(CMD_PATHS)].map((m) => m[1]);
    return !(paths.length > 0 && paths.every((f) => DOC_FILE.test(f)));
}

/** Verbs of a done claim whose output is a build or a generated file, not an edit. */
const BUILT = /\b(built|rebuilt|generated|regenerated|compiled|bundled|packaged)\b/i;
/** A done claim in the first person or led by its verb ("I added", "Added the flag"), as against a description ("X is wired to Y"). */
const ACTIVE = new RegExp(String.raw`^(i|we)\b|\b(i'?ve|i have|we'?ve|we have|i|we)\s+(now\s+|also\s+|just\s+|then\s+)?\w+ed\b|^(?:${CHANGE_CLAIM.source.replace(/^\\b\(/, '(').replace(/\)\\b$/, ')')})`, 'i');

/** Runs that ended: "lint and unit-tests finished", "the nightly jobs completed". */
const RUN_DONE = /\b(lint|[\w-]*tests?|specs?|builds?|checks?|ci|jobs?|pipelines?|workflows?|e2e|suites?|runs?|benchmarks?)\s+(?:(?:have|has|all|both|also|now|just)\s+)*(finished|completed|ended)\b/i;
/** Work that is a run, said to have finished: "Backfill complete", "Training finished for v7". */
const RAN_DONE = /\b(training|backfill|import|export|sync|ingest(?:ion)?|crawl|scrape|reindex(?:ing)?|indexing|seed(?:ing)?|etl|batch|script|load test|dry run|replay|transcode|render(?:ing)?|conversion|dump|restore|backup|upload|download|eval(?:uation)?|fine-?tun(?:e|ing)|simulation|sweep)\s+(?:[\w.+&-]+\s+){0,2}?(?:is\s+|has\s+|have\s+|was\s+)?(?:now\s+|all\s+)?(finished|completed|complete|done|succeeded|ran to completion)\b/i;
/** "Applied it to dev.db", "the playbook is applied to both hosts": an apply to infrastructure or a database, not a patch or a suggestion. */
const APPLIED = /\bapplied\b(?!\s+(?:the\s+|your\s+|its\s+|their\s+|all\s+|both\s+|my\s+|these\s+|those\s+)?(?:patch(?:es)?|diffs?|suggestions?|fix(?:es)?|edits?|review|feedback|formatting|format|rename|codemod|lint|autofix(?:es)?|stash|style|changes? to (?:the\s+)?(?:file|code)))/i;
const APPLY_PLACE = /\b(terraform|tofu|pulumi|vpc|subnets?|buckets?|clusters?|staging|production|prod|manifests?|helm|charts?|playbooks?|hosts|servers?|migrations?|schema|databases?|db|k8s|kubernetes|infra(?:structure)?|stacks?|namespaces?|ingress|security groups?|iam|dns)\b|[\w-]+\.(tf|tfvars|hcl|sql|db|sqlite3?)\b/i;
/** Files whose change counts once it is applied. */
const INFRA_FILE = /\.(tf|tfvars|hcl|sql)\b|\b(playbooks?|manifests?|k8s|charts?|helm|migrations?)\//i;

/** A job said to have finished: "it has since finished", "the run completed successfully". */
const FINISHED = /\b(?:has|have|had)\s+(?:since\s+|now\s+|already\s+|just\s+)?(?:finished|completed|succeeded|ended)\b|\b(?:finished|completed|succeeded)\s+(?:successfully|ok|fine|cleanly|without errors)\b|\b(?:it|the (?:job|run|workflow|pipeline|dag|batch|backfill|task))\s+(?:finished|completed|succeeded|ended)\b/i;
/** "Migrated the dev database", "ran the migrations", "the migration is applied": a migration said to have run. */
const MIGRATED = /\bmigrated\s+(?:the\s+|both\s+|all\s+|our\s+|your\s+)?(?:(?:dev|local|test|staging|prod|production|development)\s+)?(?:databases?|dbs?|schemas?)\b|\b(?:ran|re-?ran|run|executed)\s+(?:the\s+|both\s+|all\s+|its\s+|that\s+|this\s+|these\s+)?(?:new\s+|pending\s+)?(?:[\w-]+\s+)?migrations?\b(?!\s+(?:files?|generators?|scaffold))|\bmigrations?\s+(?:is|are|was|were|has been|have been)\s+(?:now\s+|all\s+)?(?:applied|run)\b|\b(?:database|db|schema)\s+(?:is|has been)\s+(?:now\s+)?migrated\b/i;
/** "Retrained on v7", "fine-tuned the model", "the model is retrained": a training said to have run. */
const TRAINED = /(?:^|\band\s+|\bthen\s+|[,;]\s*|\b(?:i|we)\s+(?:have\s+|'ve\s+|just\s+|also\s+|then\s+)?)(?:re-?trained|fine-?tuned)\b|(?:^|\band\s+|\bthen\s+|\b(?:i|we)\s+(?:have\s+|'ve\s+|just\s+|also\s+|then\s+)?)trained\b(?=\s+(?:it|the|a|an|on|for|with|from|both|all|them|\d))|\b(?:is|was|has been|have been|got)\s+(?:now\s+)?(?:re-?trained|fine-?tuned)\b/i;
/** "Ran it on staging", "ran the migration against prod": a run the claim names. */
const RAN_ON = /\b(?:ran|re-?ran|executed)\s+(?:it|them|this|that|the\s+[\w-]+(?:\s+[\w-]+)?)\s+(?:on|against|in|into)\s+/i;
/** An endpoint by its method and path: "GET /api/reports/summary". */
const ROUTE_NAMED = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[\w\/{}:.*-]*/;
/** Counts of what a run handled: "1,384,002 rows", "5000 users". */
const COUNT = /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)\s+(rows|records|documents|docs|events|messages|items|entries|objects|users|orders|files|keys|vectors|embeddings|samples|examples|pages|chunks|tickets|accounts|customers|products|images|videos|emails)\b/gi;
/** The counts a sentence quotes, as figures to find in the turn's output. */
function countsIn(text) {
    const out = [];
    for (const m of String(text).matchAll(COUNT)) {
        const value = num(m[1]);
        if (value >= 2) out.push({ value, unit: '', raw: m[1], text: `${m[1]} ${m[2]}` });
        if (out.length >= 4) break;
    }
    return out;
}

/** Rule for `done`: a change for a claim that says it changed something (or a bare "Done" after a request for one); else any tool that worked. */
/** Places an apply can run on, as a claim names them and as a command or its output shows them ("$DEV_DB", "shop_dev"). */
const PLACES = [
    { name: 'production', said: /\b(?:production|prod)\b/i, sign: /(?:^|[^a-z])(?:prod|production|live)(?![a-z])/i },
    { name: 'staging', said: /\bstag(?:e|ing)\b/i, sign: /(?:^|[^a-z])(?:stag(?:e|ing)?|stg)(?![a-z])/i },
];
const OTHER_PLACE = /(?:^|[^a-z])(dev|devel|development|local|localhost|staging|stage|stg|qa|uat|sandbox|preview|prod|production)(?![a-z])/i;
/** The lines of an apply that say where it ran: the command, and output lines about the database, host or context. */
const WHERE_LINE = /\b(?:database|datasource|db|host|server|cluster|context|namespace|env(?:ironment)?|target|workspace|project|url)\b/i;

/**
 * "Applied the refunds migration to the production database" when every
 * apply in this turn showed another place (`DATABASE_URL=$DEV_DB`, database
 * "shop_dev") and none showed that one: unbacked, or undefined.
 */
function appliedElsewhere(words, applies) {
    const place = PLACES.find((p) => p.said.test(words));
    if (!place) return undefined;
    const where = (i) => [i.cmd ?? '', ...(i.lines ?? []).filter((l) => WHERE_LINE.test(l))];
    if (applies.some((i) => where(i).some((l) => place.sign.test(l)))) return undefined;
    for (const i of applies) {
        for (const l of where(i)) {
            const other = OTHER_PLACE.exec(l);
            if (other && !place.sign.test(other[0])) {
                return { verdict: 'unbacked', evidence: [said(i)], why: `It names ${place.name}, and the apply in this turn ran on ${other[1].toLowerCase()}: ${i.text}.` };
            }
        }
    }
    return undefined;
}

function judgeDone(claim, list, prompt) {
    const words = (claim.part ?? claim.text).trim();
    const bare = /^(all\s+)?(done|complete|completed|finished|sorted|all set|all wrapped up|wrapped up)\W*$/i.test(words);
    // "Cut the release APK" asks for a build: the claim that it is built is then this turn's work, not a description.
    const asked = CHANGE_ASK.test(prompt) || (BUILT.test(words) && BUILD_ASK.test(prompt));
    const changeClaim = CHANGE_CLAIM.test(words) || (bare && asked);
    // "Submitted the backfill; it has since finished": a job that runs elsewhere, shown finished by a status read after it started.
    const started = lastIndex(list, (i) => i.job && i.ok !== false);
    if (started >= 0 && !bare && (FINISHED.test(words) || RAN_DONE.test(words))) {
        const read = list.slice(started).filter((i) => i.ended !== undefined).at(-1);
        if (read?.ended === true) return { verdict: 'backed', evidence: [said(list[started]), said(read)], why: '' };
        if (read?.ended === false) return { verdict: 'contradicted', evidence: [said(read)], why: `The last status read in this turn says it did not finish well: ${read.text}.` };
        return { verdict: 'unbacked', evidence: read ? [said(read)] : [said(list[started])], why: read ? `It was started in this turn, and the last status read says it is still going: ${read.text}.` : 'It was started in this turn, and nothing after that shows it finished.' };
    }
    // "Added the migration and ran it on staging": when the turn applied something, the run it names is that apply.
    const applies = list.filter((i) => i.apply);
    // "Applied the change" to infrastructure or a database: an apply that ran and went through, not only an edit of its files.
    // "Migrated the dev database", "ran the migrations": a migration that ran, not only a migration file written.
    const migrated = MIGRATED.test(words);
    if ((APPLIED.test(words) && (APPLY_PLACE.test(claim.text ?? words) || list.some((i) => i.kind === 'change' && INFRA_FILE.test(i.text)))) || (RAN_ON.test(words) && applies.length) || migrated) {
        if (applies.length === 0) {
            return { verdict: 'unbacked', evidence: [], why: migrated ? 'No migration ran in this turn: writing or editing a migration file does not apply it.' : 'Nothing in this turn applied it: no terraform or kubectl apply, playbook, helm upgrade or migration ran.' };
        }
        const last = applies.at(-1);
        if (last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `The last apply in this turn did not go through: ${last.text}.` };
        if (last.ok !== true) return { verdict: 'unbacked', evidence: [said(last)], why: `It is not clear the last apply went through: ${last.text}.` };
        const away = appliedElsewhere(words, applies);
        if (away) return away;
        return { verdict: 'backed', evidence: applies.slice(-2).map(said), why: '' };
    }
    // "Retrained on v7", "fine-tuned the model": a training run in this turn, which must have ended well.
    if (TRAINED.test(words)) {
        const looks = (i) => i.kind === 'read' || i.kind === 'change' || (i.kind === 'run' && LOOK_CMD.test(i.cmd ?? ''));
        const runs = list.filter((i) => TRAIN_CMD.test(i.cmd ?? '') || (i.inner ?? []).some((c) => TRAIN_CMD.test(c)) || (!looks(i) && (i.lines ?? []).some((l) => TRAIN_OUT.test(l))));
        if (runs.length === 0) return { verdict: 'unbacked', evidence: [], why: 'No training ran in this turn: no training script or trainer was started.' };
        const last = runs.at(-1);
        if (last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `The last training run in this turn did not finish well: ${last.text}.` };
        if (last.job) {
            // Submitted to a cluster: a status read after it must show it finished.
            const read = list.slice(list.indexOf(last)).filter((i) => i.ended !== undefined).at(-1);
            if (read?.ended === false) return { verdict: 'contradicted', evidence: [said(read)], why: `The last status read in this turn says the training did not finish well: ${read.text}.` };
            if (read?.ended !== true) return { verdict: 'unbacked', evidence: [said(read ?? last)], why: 'The training was started in this turn, and nothing after that shows it finished.' };
        } else if (last.ok !== true) {
            return { verdict: 'unbacked', evidence: [said(last)], why: `It is not clear the last training run finished: ${last.text}.` };
        }
        // The training ran and ended well; a change it also names ("switched the loss and retrained") must show too.
        if (!CHANGE_CLAIM.test(words.replace(TRAINED, ' '))) return { verdict: 'backed', evidence: [said(last)], why: '' };
    }
    // "Backfill complete", "Training finished": the run itself, which must have ended well.
    if (RAN_DONE.test(words) && !RUN_DONE.test(words)) {
        // An `ls` of the output folder after the run is a look, not the run.
        const runs = list.filter((i) => RUNS.has(i.kind) && i.kind !== 'probe' && i.kind !== 'hash' && !(i.kind === 'run' && LOOK_CMD.test(i.cmd ?? '')));
        if (runs.length === 0) return { verdict: 'unbacked', evidence: [], why: 'Nothing in this turn ran it, so nothing shows it finished.' };
        const last = runs.at(-1);
        if (last.ok === false) return { verdict: 'contradicted', evidence: [said(last)], why: `The last run in this turn did not finish well: ${last.text}.` };
        // "October backfill complete: 1,384,002 rows": counts of what it handled, which a run must have printed.
        const unshown = countsIn(claim.text ?? words).filter((c) => !printed(list, c) && !String(prompt).includes(c.raw));
        if (unshown.length) return { verdict: 'unbacked', evidence: runs.slice(-1).map(said), why: `It quotes ${listed(unshown.slice(0, 2).map((c) => c.text))}, which no output in this turn shows.` };
        return { verdict: 'backed', evidence: runs.slice(-2).map(said), why: '' };
    }
    // "The IE11 path is wired through legacyPlugin" after a question describes the code; after "wire it" it claims the work.
    if (changeClaim && !bare && prompt !== '' && !asked && !ACTIVE.test(words)) {
        return { verdict: 'backed', evidence: list.filter((i) => i.kind === 'read' || i.ok === true).slice(-2).map(said), why: '' };
    }
    // "lint and unit-tests finished": runs that ended, which a run or a CI read in this turn shows.
    if (RUN_DONE.test(words)) {
        const runs = list.filter((i) => i.kind === 'ci' || i.kind === 'test' || i.kind === 'lint' || i.kind === 'build');
        if (runs.length) return { verdict: 'backed', evidence: runs.slice(-2).map(said), why: '' };
    }
    // "Committed the fix" after a `git commit` that failed.
    const commit = /\bcommitted\b/i.test(words) ? list.filter((i) => /\bgit\s+commit\b/i.test(plainGit(i.cmd))).at(-1) : undefined;
    if (commit && commit.ok === false && !commit.committed) return { verdict: 'contradicted', evidence: [said(commit)], why: `The commit in this turn did not go through: ${commit.text}.` };
    if (changeClaim) {
        // An apply or a deploy to an environment changes things too ("created the bucket" with `terraform apply`).
        const acts = (i) => i.change || i.kind === 'change' || i.apply || (i.kind === 'deploy' && (i.targets ?? []).includes('env'));
        const builds = (i) => BUILT.test(words) && (i.kind === 'build' || i.kind === 'run');
        // "[main 1a2b3c4] Guard against empty cart" before a rejected push: the commit went through, whatever came after.
        const went = (i) => i.ok !== false || (i.committed !== undefined && GIT_RECORD_CMD.test(plainGit(i.cmd)));
        const made = (i) => (acts(i) || i.kind === 'other' || builds(i)) && went(i);
        const changes = list.filter(made);
        // "Added `GET /api/reports/summary`": an endpoint needs a change to a route or a handler, not only to its types.
        const route = asked || ACTIVE.test(words) ? ROUTE_NAMED.exec(`${claim.text ?? words} ${claim.next ?? ''}`) : null;
        const edits = changes.filter((i) => i.change || i.kind === 'change');
        if (route && edits.length && !edits.some((i) => i.route)) {
            return { verdict: 'unbacked', evidence: edits.slice(-2).map(said), why: `It names the endpoint ${route[0]}, and no change in this turn touched a route or a handler: ${listed(edits.slice(-2).map(said))}.` };
        }
        if (changes.length) return { verdict: 'backed', evidence: changes.slice(-3).map(said), why: '' };
        const failed = list.filter((i) => (acts(i) || builds(i)) && i.ok === false);
        const what = failed.length && !acts(failed.at(-1)) ? (failed.at(-1).kind === 'build' ? 'build' : 'run') : 'change';
        if (failed.length) return { verdict: 'contradicted', evidence: failed.slice(-2).map(said), why: `The ${what} in this turn did not go through: ${failed.at(-1).text}.` };
        return { verdict: 'unbacked', evidence: [], why: bare ? 'You asked for a change, and nothing in this turn changed a file.' : 'Nothing in this turn changed a file or ran a change.' };
    }
    const worked = list.filter((i) => i.ok !== false);
    if (worked.length) return { verdict: 'backed', evidence: worked.slice(-3).map(said), why: '' };
    return { verdict: 'unbacked', evidence: list.slice(-2).map(said), why: 'Every tool in this turn failed.' };
}

// ── A claim that quotes the output ─────────────────────────────────

const STOP = new Set('a an and or of to in on at for with is are was were be been being it its this that these those now all both each every from by as so then than our your my we i you they has have had do does did also just still only here there which who what into onto via per out up over after before since when while new same one'.split(' '));
/** Words every success claim uses: they do not tie a claim to one output. */
const GENERIC = new Set('pass passed passes passing test tests testing build builds built ok okay green clean cleanly success successful successfully fine works working work worked done complete completed finished fixed deployed deploy pushed push released release shipped merged live healthy ready check checks checked run ran runs error errors fail failed failure failures true false yes no none zero everything returns returned return status code verified verify 0'.split(' '));
const HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{7,}$/;
const tokensOf = (text) => (String(text).toLowerCase().replace(/[⟨⟩`*_"“”'’]/g, ' ').match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? [])
    .map((t) => t.replace(/^v(?=\d)/, ''))
    .filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)));
const stem = (t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t);
const holds = (set, word) => set.has(word) || set.has(stem(word)) || (HEX.test(word) && [...set].some((t) => t.startsWith(word)));

/**
 * Whether a claim only restates what the turn's runs printed ("e2e / smoke
 * — successful in 3m10s" under `gh pr checks`): every word of it is in a
 * run's command or output, and one line holds two of its words that are not
 * stock success words. A backed result, or undefined. Reads do not count: a
 * file that says "all tests pass" shows nothing ran.
 */
export function quotedBy(claim, items) {
    const words = [...new Set(tokensOf(claim.text ?? claim.part ?? ''))];
    const special = words.filter((w) => !GENERIC.has(w) && !GENERIC.has(stem(w)));
    if (special.length < 2) return undefined;
    const sources = (Array.isArray(items) ? items : []).filter((i) => i && i.kind !== 'read' && i.kind !== 'change' && i.ok !== false);
    const sets = [];
    for (const i of sources) {
        for (const line of [i.cmd ?? '', ...(i.lines ?? [])]) {
            if (!line) continue;
            const set = new Set();
            for (const t of tokensOf(line)) { set.add(t); set.add(stem(t)); }
            sets.push({ set, item: i });
        }
    }
    if (!words.every((w) => sets.some(({ set }) => holds(set, w)))) return undefined;
    if (!sets.some(({ set }) => special.filter((w) => holds(set, w)).length >= 2)) return undefined;
    const from = [...new Set(sets.filter(({ set }) => special.some((w) => holds(set, w))).map(({ item }) => item))];
    return { verdict: 'backed', evidence: from.slice(-3).map(said), why: '' };
}

// ── A description, not a claim ─────────────────────────────────────

/** Whatever changes something: an edit, a command that writes, an apply, a deploy or a push, a job started. */
const CHANGES = (i) => i.change || i.kind === 'change' || i.apply || i.kind === 'deploy' || i.shipped !== undefined || i.job;
/** A message about the agent's own work ("did that work?", "what did you change?", "write the PR description"). */
const ABOUT_OWN_WORK = /\b(?:did|have|had|were)\s+you\b|\bwhat\s+(?:did\s+|have\s+)?you\b|\byou(?:'ve|\s+have)?\s+(?:just\s+)?(?:did|done|changed|fixed|made|added|deployed|pushed)\b|\byour\s+(?:changes?|fix(?:es)?|edits?|work|commits?|pr|patch|branch)\b|\bdid\s+(?:that|it|this)\s+(?:work|go through|land|deploy|pass)\b|\bis\s+(?:it|that|this)\s+(?:done|fixed|deployed|pushed|merged|live|finished|working)\b|\bsummar|\bwrite[- ]?up\b|\bpr description\b|\brelease notes\b|\bchangelog\b|\bstand-?up\b|\brecap\b/i;
/** A message that asks a question or asks to be shown something: "How are retries set up?", "Explain `applyDiscount`". */
const LOOK_ASK = /\?\s*(?:$|\S)|^(?:(?:please|now|also|ok|okay|so|hey)\s*,?\s+)*(?:explain|describe|tell\s+me|show\s+me|walk\s+me\s+through|look\s+(?:at|into|over)|have\s+a\s+look|take\s+a\s+look|check\s+(?:how|what|where|whether|if|which|why|when)|compare|review|find\s+out|figure\s+out|investigate|diagnose|audit|inspect|help\s+me\s+understand)\b|\b(?:and|then)\s+(?:explain|describe|tell\s+me|show\s+me|walk\s+me\s+through|summari[sz]e\s+(?:how|what|why|where))\b|\b(?:just|only)\s+(?:look|read|explain|answer)\b|\b(?:do\s+not|don'?t)\s+(?:change|edit|touch|modify)\s+anything\b|\bwithout\s+changing\s+anything\b|\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:explain|describe|tell|show|look|compare|review|walk|find\s+out|figure\s+out|investigate|diagnose|inspect)\b|\bi\s+(?:want|need|would\s+like|'d\s+like)\s+to\s+(?:know|understand|see|learn)\b/i;
/** A request for a write-up of the work ("write a short note for #releases"): its claims are the work's, not descriptions. */
const WRITE_UP_ASK = /\bwrite\s+(?:it|that|this|these|them|those|everything)\s+up\b|\b(?:write|draft|put together|prepare|compose|give me|make)\s+(?:me\s+|us\s+)?(?:a|an|the|my|our|some)?\s*(?:short|quick|brief|one-line|small|little|tight|final)?\s*(?:pr description|pull request description|description|summary|recap|note|notes|message|update|status update|standup|stand-up|changelog entry|changelog|release notes?|commit message|email|post|announcement|one-?liner|report|write-?up|paragraph)\b/i;
/** A clause led by this turn's own work ("Deployed it again", "I updated", "Rolled 2.5.0 out", "Just fixed …"). */
const OWN_WORK = new RegExp(String.raw`^(?:i|we)\b|\b(?:i'?ve|i\s+have|we'?ve|we\s+have|i|we)\s+(?:now\s+|also\s+|just\s+|then\s+|already\s+)?\w+(?:ed|t|wn|en)\b|^(?:(?:just|also|then|now|and|so)\s+)?(?:edited|modified|tweaked|adjusted|amended|altered|reworked|reverted|restored|added|created|updated|wrote|implemented|renamed|removed|deleted|moved|changed|replaced|refactored|set\s+up|configured|installed|migrated|converted|extracted|merged|rewrote|built|rebuilt|generated|registered|wired|hooked\s+up|exposed|exported|introduced|bumped|pinned|upgraded|downgraded|enabled|disabled|documented|ported|switched|swapped|applied|committed|regenerated|backfilled|raised|lowered|deployed|redeployed|released|shipped|rolled|promoted|published|pushed|tagged|provisioned|uploaded|fixed|resolved|repaired|patched|corrected|addressed|ran|re-?ran|cherry-?picked|rebased|reran|retried|restarted)\b`, 'i');
/** Words that say something changed just now: "is now configured", "returns 0 now", "after my edit". */
const CHANGED_NOW = /(?<![.\w])now\b(?!\s*\()|\bjust\b|\bno longer\b|\banymore\b|\bany more\b|\bafter\s+(?:my|this|the|that)\s+(?:change|edit|fix|patch|commit|update)\b|\bsince\s+(?:my|this)\s+(?:change|edit|fix)\b/i;
/** How a thing is, in the present or as history: "is configured in", "are applied there", "is deployed on", "was added in". */
const STATIVE = /\b(?:is|are|was|were|has\s+been|have\s+been|'s|’s|stays?|remains?)\s+(?:(?:already|still|also|currently|only|all|both|each|indeed|properly|correctly|fully|automatically|actually)\s+)*(?:[a-z]+ed|[a-z]+en|set|built|run|kept|held|made|done|in\s+place|in(?=\s+(?:the\s+)?[\w.\/⟨-]+)|on\s+(?=[\w.\/⟨-]))\b/i;
/** A fix named as history: "is already fixed upstream in `b2c3d4e`", "was fixed in v2.3.1", "is fixed on main". */
const FIX_HISTORY = /\balready\b|\bupstream\b|\b(?:in|by|on|since|with)\s+(?:its|their)\s+(?:latest|next|new|newer|current|upcoming|later|following)\s+(?:major|minor|patch|release|version|update)\b|\b(?:in|by|on|since)\s+(?:(?:commit|release|version|pr|tag)\s+)?(?:⟨\s*)?(?:v?\d+\.\d+(?:\.\d+)?|(?=[0-9a-f]{0,39}\d)(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}|#\d+|main|master|trunk|the\s+(?:latest|next|new|current|\d[\w.]*)\b)/i;
/** A look at where a thing runs: its deploy config read, or a status command of the place it runs. */
const DEPLOY_FILE = /(?:^|[\s\/])(?:fly\.toml|Dockerfile|Containerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|vercel\.json|netlify\.toml|render\.ya?ml|app\.ya?ml|Procfile|serverless\.ya?ml|[\w.-]+\.tf|[\w.-]+\.service|values[\w.-]*\.ya?ml|Chart\.ya?ml|kustomization\.ya?ml|[\w.-]*(?:deploy|deployment|release|k8s|manifest|workflow|pipeline|ci|cd)[\w.-]*\.(?:ya?ml|json|toml))$|(?:^|[\s\/])(?:k8s|kube|kubernetes|deploy|deployments?|manifests|helm|charts|infra|ops|\.github|workflows)\//i;
const DEPLOY_LOOK_CMD = /\b(?:prisma\s+migrate\s+status|alembic\s+(?:current|history|heads)|(?:rails|rake)\s+db:migrate:status|flyway\s+info|knex\s+migrate:(?:status|list)|showmigrations|dbmate\s+status|goose\b[^|;&]*\bstatus|sqitch\s+status|atlas\s+migrate\s+status|kubectl\s+(?:get|describe|rollout\s+(?:status|history))|helm\s+(?:status|list|ls|history|get)|fly(?:ctl)?\s+(?:status|releases|info|apps\s+list|config\s+show|machines?\s+list)|gh\s+(?:run|release|api)\s|docker\s+(?:ps|inspect|compose\s+ps|images)|systemctl\s+(?:status|is-active|show|cat)|vercel\s+(?:ls|list|inspect)|heroku\s+(?:ps|releases|apps:info)|aws\s+\w+\s+describe|gcloud\s+\S+\s+(?:services\s+)?describe|terraform\s+(?:show|output|state\s+(?:list|show))|curl\b|wget\b|nomad\s+(?:status|job\s+status)|argocd\s+app\s+get|cat\s+\S*(?:fly\.toml|Dockerfile|\.ya?ml|\.service|\.tf))\b/i;
const deployLook = (i) => (i.kind === 'read' && DEPLOY_FILE.test(String(i.text ?? '').replace(/^\S+\s+/, ''))) || DEPLOY_LOOK_CMD.test(i.cmd ?? '') || i.kind === 'ci' || i.kind === 'probe';

/**
 * Whether a claim only describes how things are: in a turn that changed nothing, after a message that asks a
 * question and no work about the agent's own doing, a clause in the present or past passive ("Retries are
 * configured in `config/retry.yml`", "pct is documented as a percentage", "It is deployed on Fly as `acme-api`",
 * "all 3 migrations are applied there", "it is already fixed upstream in `b2c3d4e`"), not led by a verb of the
 * turn's own work and not marked "now". Where a thing runs needs a look at where it runs; a fix, a mark of history.
 * Pass claims and health claims are never descriptions: they say how a run or a service went.
 */
export function described(claim, items, prompt = '') {
    if (!claim) return false;
    // A pass, a health check or a ship says how a run or a service went, unless it is told as how a thing behaves.
    const ran = claim.kind === 'passed' || (claim.kind === 'deployed' && (claim.target === 'health' || claim.ship));
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const ask = typeof prompt === 'string' ? prompt.trim() : '';
    if (list.length === 0 || !LOOK_ASK.test(ask) || list.some(CHANGES) || BUILD_ASK.test(ask) || WRITE_UP_ASK.test(ask) || ABOUT_OWN_WORK.test(ask)) return false;
    // A run of the tests or a status read asked for is a look ("run the export tests once so I can see"); a run that does
    // work (a training run, an import, a backfill) is work.
    // "I want to know before I merge the PR": what the person will do, not what they ask for.
    const asked = ask.replace(LOOK_RUN, ' ').replace(/\bi\s+(?:want|need|'d\s+like|would\s+like)\s+to\s+(?:know|see|understand|check|find\s+out|learn|confirm|make\s+sure)\b[^.!?\n]*/gi, ' ')
        .replace(/\b(?:before|after|when|once|until|while|so\s+that|so)\s+(?:i|we)\s+[^.!?\n]*/gi, ' ');
    if (asksForWork(asked)) return false;
    // A change asked for outside a question ("Document it in the README."), not "does anything document how pct works?".
    // "Explain how you would fix it" asks how, not for the fix.
    const told = asked.split(/(?<=[.!?\n])\s+/).filter((x) => !/\?\s*$/.test(x.trim())).join(' ')
        .replace(/\b(?:how|what|where|why|which|whether)\s+(?:you|we|i|one|they|it)\s+(?:would|could|should|might|can|will|'d)\s+(?:\w+\s+){0,2}?\w+/gi, ' ');
    // A change or a ship asked for, by its verb in a request's place: "Fix the retries", "can you deploy it", not "the export
    // tests" or "before I merge the PR".
    if (CHANGE_REQUEST.test(told.replace(/\b(?:do\s+not|don'?t|never|without|no\s+need\s+to)\s+(?:[\w-]+\s+){0,3}?[\w-]+[^.!?\n]*/gi, ' '))) return false;
    const words = String(claim.part ?? claim.text ?? '').replace(/[`*]/g, '').trim();
    if (words === '' || CHANGED_NOW.test(words)) return false;
    // "passes when it runs alone", "usually passes on the second try", "builds fine on Node 20 but fails on Node 18",
    // "the rollout completes in about four minutes", "is deployed behind the gateway", "the fix landed in 3.1.0":
    // how a thing behaves or what its history is, after a why or how question, not "Is it deployed?".
    if (behaves(claim, words, String(claim.text ?? '').replace(/[`*]/g, ''), ask) && !statusAsked(ask)) return true;
    // "- `build` — compiles the TypeScript and copies `public/` into `dist/`": a list that says what each named thing does.
    if (DEF_ITEM.test(String(claim.text ?? '').replace(/[`*]/g, '').trim()) && !statusAsked(ask)) return true;
    if (ran) return false;
    // "`test_export_csv` built its header before the call", "`aws_s3_bucket_versioning.assets` — replaced along with it":
    // code is the subject, so the clause says what the code does or did, or what a plan does to it.
    const sentence = String(claim.text ?? '').replace(/[`*]/g, '').trim();
    if ((claim.kind === 'done' || claim.kind === 'fixed') && (CODE_LED.test(words) || (FRAGMENT.test(words) && CODE_ITEM.test(sentence)))) return true;
    if (OWN_WORK.test(words)) return false;
    // "Already fixed — `b72e0d4` switches the test to a frozen clock": a fix named as history.
    if (claim.kind === 'fixed' && FIX_HISTORY.test(words) && !/^(?:i|we)\b/i.test(words)) return true;
    if (!STATIVE.test(words)) return false;
    if (claim.kind === 'deployed') return list.some(deployLook);
    if (claim.kind === 'fixed') return FIX_HISTORY.test(words);
    return true;
}
/** How a thing behaves: a condition, a habit, a generic subject ("each shard"), a time it takes, a sequence, or a pass set against a failure. */
const HABIT = /\b(?:when|whenever|as\s+soon\s+as|unless|automatically|on\s+(?:a\s+)?(?:retry|rerun|re-run)s?|as\s+long\s+as|only\s+(?:when|if|with|on|after|once|under)|usually|often|sometimes|always|occasionally|typically|normally|generally|mostly|rarely|every\s+(?:time|run|push|deploy|release|merge|build|night|day|morning|hour)|each\s+time|on\s+(?:every|each)\s+\w+|in\s+(?:about|around|roughly|under)\s+\w+\s+(?:seconds?|minutes?|hours?|s|ms|min)|takes\s+(?:about|around|roughly)\b)\b|^(?:after|once|when|whenever|before|until|if)\b|^(?:each|every)\s+(?!(?:\d+\s+)?(?:tests?|specs?|examples?|checks?|suites?|runs?|packages?)\b)[a-z]/i;
const AGAINST_FAIL = /\b(?:but|and|while|whereas|yet)\s+(?:it\s+|they\s+|then\s+)?(?:fails|breaks|errors|crashes|times\s+out|hangs|flakes|panics)\b/i;
/** How a thing is deployed ("behind the gateway", "as a sidecar", "with 3 replicas"), not whether it went out. */
const DEPLOY_MANNER = /\b(?:deployed|runs?|running)\s+(?:behind|as\s+an?\b|alongside|next\s+to|inside|in\s+front\s+of|per\b|with\s+\d+|to\s+each|on\s+each|on\s+every)/i;
/** History named by a release, a pull request or a commit: "landed in 3.1.0", "shipped in #1234", "went out with `a1b2c3d`". */
const NAMED_HISTORY = /\b(?:in|by|since|with|as\s+of)\s+(?:(?:commit|release|version|pr|tag)\s+)?(?:v?\d+\.\d+(?:\.\d+)?\b|#\d+\b|(?=[0-9a-f]{0,39}\d)(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}\b)/i;
/** A run or a count of this turn: "I ran it", "all 212 examples pass", "14 passed". */
const RUN_RESULT = /^(?:i|we)\b|\b(?:i|we)\s+(?:ran|re-?ran|tried|checked|tested)\b|\b\d+\s+(?:of\s+\d+\s+)?(?:tests?|specs?|examples?|cases?|checks?|suites?|passed|passing|green)\b|\b(?:all|both|every)\s+(?:\d+\s+)?(?:tests?|specs?|examples?|checks?)\b/i;
/** A cause given right after the clause: "is green on main because …", "works locally due to …". */
const CAUSE_NEXT = /^\W{0,3}(?:only\s+)?(?:because|due\s+to|thanks\s+to)\b/i;
const CAUSE_IN = /\b(?:because|due\s+to|thanks\s+to)\b/i;
const PLAIN = new Set(['the', 'and', 'but', 'this', 'that', 'these', 'those', 'its', 'are', 'was', 'were', 'has', 'have', 'had', 'been', 'only', 'still', 'also', 'just', 'all', 'any', 'for', 'with', 'from', 'into', 'onto', 'our', 'your', 'their', 'there', 'here', 'then', 'than', 'which', 'when', 'what', 'why', 'how', 'doe', 'did', 'can', 'will', 'would', 'could', 'should', 'not', 'one', 'out', 'yet', 'very', 'really', 'job', 'thing']);
const stemOf = (w) => w.toLowerCase().replace(/(?:ing|ed|es|s)$/, '');
/** Whether a why question takes the clause as given: "Why does it work locally?" before "It works locally because …". */
function presupposed(words, ask) {
    if (!/\bwhy\b|\bhow\s+come\b|\bwhat\s+makes\b/i.test(ask)) return false;
    const asked = new Set((ask.match(/[A-Za-z][\w.-]{1,}/g) ?? []).map(stemOf));
    return (words.match(/[A-Za-z][\w.-]{1,}/g) ?? []).map(stemOf).filter((w) => w.length > 1 && !PLAIN.has(w)).some((w) => asked.has(w));
}
function behaves(claim, words, sentence, ask) {
    if (RUN_RESULT.test(words) || OWN_WORK.test(words)) return false;
    if (HABIT.test(words) || AGAINST_FAIL.test(sentence)) return true;
    // "It works locally because your .env sets API_URL" after "Why does it work locally but not on CI?": the cause of
    // what the question takes as given, not a new claim; "because I fixed the import" is the turn's own work.
    const at = sentence.indexOf(words);
    const rest = at >= 0 ? sentence.slice(at + words.length) : '';
    if ((CAUSE_NEXT.test(rest) || CAUSE_IN.test(words)) && !/\b(?:i|we)\b/i.test(rest.split(/[.;!?]/)[0]) && presupposed(words, ask)) return true;
    // "you are on 3.0.4": the person's own setup, as read.
    return claim.kind === 'deployed' && !claim.ship && claim.target !== 'health' && (DEPLOY_MANNER.test(words) || NAMED_HISTORY.test(words) || /^(?:you|your)\b/i.test(words));
}
/** A definition list's item: a name, a dash, and what it does in the present ("build — compiles …"), not "lint — passes". */
const DEF_ITEM = /^(?:\d+[.)]\s+|[-*•]\s+)?[\w.\/:@$#-]{1,48}(?:\s*\([^)]*\))?\s+[—–]\s+(?!(?:passes|fails|succeeds|works|errors|breaks|is|are|was|were|has|have|now|still|all|both|ok|green|red|clean)\b)[a-z]+s\b/;
/** A question or a check of how something stands now: "Is it deployed?", "Did the tests pass?", "Check whether CI is green". */
const STATUS_WORDS = String.raw`(?:deployed|deploy|live|out|released|shipped|ship|merged|pushed|up|running|green|red|passing|pass|passed|built|build|builds|done|fixed|finished|applied|landed|land|working|work|healthy|succeed(?:ed)?|go(?:ne)?\s+(?:out|through|green)|in\s+prod(?:uction)?|on\s+(?:staging|prod(?:uction)?|main))`;
const STATUS_ASK = new RegExp(String.raw`^(?:(?:so|and|ok|okay|also|quick\s+one|hey)\s*,?\s+)*(?:is|are|was|were|has|have|had|did|does|do|can\s+you\s+(?:confirm|check|verify)|could\s+you\s+(?:confirm|check|verify))\b[^?]*\b${STATUS_WORDS}\b|\b(?:check|confirm|verify|tell\s+me|find\s+out|see)\s+(?:whether|if)\b[^.?!]*\b${STATUS_WORDS}\b|\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:status|state)\b|\bwhat\s+(?:version|build|commit|sha|tag|release)\s+(?:is|are)\b`, 'i');
const statusAsked = (ask) => ask.split(/(?<=[.!?\n])\s+/).some((x) => STATUS_ASK.test(x.trim()));
/** A run of tests, checks or a status read, asked for: "run the export tests once", "run `node --test`", "check the status". */
const LOOK_RUN = /\b(?:run|rerun|re-run|execute|try)\s+(?:the\s+|a\s+|all\s+|its\s+|those\s+|these\s+|my\s+|our\s+|them\s+)?(?:`[^`]{1,80}`\s*|[\w./-]+\s+){0,3}?(?:tests?|specs?|suites?|checks?|lint(?:er|ers)?|type\s*checks?|tsc|pytest|jest|vitest|status|`[^`]*\b(?:test|tests|spec|lint|status|check)\b[^`]*`)(?:\s+(?:once|again|now))?\b|\brun\s+`[^`]*\b(?:test|tests|spec|lint|status|check|log|diff|show)\b[^`]*`/gi;
/** A change or a ship asked for, its verb leading a request ("Fix …", "and then deploy …", "can you push …", "I want you to add …"). */
const REQUEST_VERBS = String.raw`(?:add|fix|make|change|update|create|write|rename|remove|delete|move|refactor|implement|migrate|convert|rewrite|bump|pin|upgrade|downgrade|wire|register|expose|document|port|split|extract|replace|clean\s+up|set\s+up|configure|enable|disable|introduce|backfill|patch|edit|consolidate|dedupe|tidy|merge|inline|simplify|restructure|rework|tweak|adjust|harden|generate|regenerate|scaffold|stub|vendor|provision|apply|spin\s+up|deploy|redeploy|push|publish|release|ship|commit|tag|roll\s+(?:it\s+|them\s+)?(?:out|back)|rollback|promote|rebase|cherry-?pick|backport|revert|restart|reboot|install|uninstall)`;
const CHANGE_REQUEST = new RegExp(String.raw`(?:^|[.!;:\n—–]\s*|\b(?:and|then|also|please|now|first|just|next)\s+)(?:please\s+|go\s+ahead\s+and\s+)?${REQUEST_VERBS}\b|\b(?:can|could|would|will)\s+you\s+(?:please\s+|also\s+|just\s+|quickly\s+|go\s+ahead\s+and\s+)*${REQUEST_VERBS}\b|\b(?:i\s+want\s+you|i'?d\s+like\s+you|i\s+need\s+you)\s+to\s+${REQUEST_VERBS}\b|\blet'?s\s+${REQUEST_VERBS}\b`, 'i');
/** A ship or a repository change asked for: "deploy it", "push the branch", "tag the release". */
const SHIP_ASK = /\b(?:deploy|redeploy|push|publish|release|ship|commit|tag|roll\s+(?:it\s+|them\s+)?(?:out|back)|rollback|promote|merge|rebase|cherry-?pick|backport|revert|restart|reboot|install|uninstall|upgrade|downgrade)\b/i;
/** A clause led by code: an identifier with a dot, an underscore, "::", a slash or a call, then its verb. */
const CODE_LED = /^(?:the\s+)?(?:[A-Za-z_$][\w$]*(?:(?:\.|::|->|#|\/)[A-Za-z_$][\w$]*)+(?:\(\))?|[A-Za-z$]*_[\w$]+(?:\(\))?|[A-Za-z_$][\w$]*\(\))\s+(?:also\s+|then\s+|first\s+|still\s+|only\s+|never\s+|always\s+)?[a-z]+(?:ed|es|s|t)\b/;
/** A clause with no subject, led by a past participle: "replaced along with it", "updated in place to point at …". */
const FRAGMENT = /^(?:also\s+|then\s+|both\s+)?[a-z]+(?:ed|en|t)\b/;
/** A list item that names code before a dash: "aws_s3_bucket_versioning.assets — replaced along with it". */
const CODE_ITEM = /^(?:\d+[.)]\s+|[-*•]\s+)?(?:[A-Za-z_$][\w$]*(?:(?:\.|::|->|#|\/)[\w$-]+)+|[A-Za-z$]*_[\w$]+|[\w.-]+\.[a-z]{1,5})(?:\s*\([^)]*\))?\s*[—–:-]\s/;

/**
 * Whether `items` (this turn's evidence, in order) back `claim`:
 * `{ verdict: 'backed'|'unbacked'|'contradicted', evidence: string[], why }`.
 * `why` is one plain sentence a person reads under the claim. `prompt` is
 * the person's message that started the turn: a bare "Done" after "add X"
 * needs a change.
 */
export function judge(claim, items, { prompt = '' } = {}) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (list.length === 0) return { verdict: 'unbacked', evidence: [], why: 'No tool ran in this turn.' };
    // "Retries are configured in `config/retry.yml`" after "How are retries set up?": a description, not a claim.
    if (described(claim, list, typeof prompt === 'string' ? prompt : '')) return { verdict: 'none', evidence: [], why: '' };
    const result = namedChecks(claim, list, prompt)
        ?? failedEdit(claim, list)
        ?? filesCount(claim, list)
        ?? stillFound(claim, list)
        ?? (claim.kind === 'passed' ? judgePassed(claim, list)
            : claim.kind === 'deployed' ? judgeDeployed(claim, list)
                : claim.kind === 'fixed' ? judgeFixed(claim, list, typeof prompt === 'string' ? prompt : '')
                    : judgeDone(claim, list, typeof prompt === 'string' ? prompt : ''));
    // Nothing of the right kind ran, but the claim restates a run's own output word for word.
    if (result.verdict === 'unbacked' && result.evidence.length === 0) return quotedBy(claim, list) ?? result;
    return result;
}

/** Paths a sentence names: `config/runtime.exs`, src/app.ts, "README.md". */
const PATH_NAMED = /(?:^|[\s`'"(\[])((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[a-z][a-z0-9]{0,7})(?=$|[\s`'"),:;\]!?]|\.(?:\s|$))/gi;

/**
 * "Bumped the pool size in config/runtime.exs" when every edit of that file in
 * this turn failed and no command changed it: the change it describes is not
 * there. Also a change claim when every edit in the turn failed and nothing
 * else changed anything.
 */
function failedEdit(claim, list) {
    if (claim.kind !== 'done' && claim.kind !== 'fixed') return undefined;
    const edits = list.filter((i) => i.kind === 'change' && i.tool !== undefined && !i.cmd);
    if (edits.length === 0 || !edits.some((i) => i.ok === false)) return undefined;
    const sentence = claim.text ?? claim.part ?? '';
    const same = (file, named) => {
        const f = file.toLowerCase().replace(/^\.\//, '');
        const n = named.toLowerCase().replace(/^\.\//, '');
        return f === n || f.endsWith(`/${n}`) || (!n.includes('/') && f.split('/').at(-1) === n);
    };
    const leaf = (named) => named.split('/').at(-1).toLowerCase();
    for (const m of sentence.matchAll(PATH_NAMED)) {
        const named = m[1];
        if (/^[\d.]+$/.test(named) || /^v?\d+(\.\d+)+/.test(named)) continue;
        const tried = edits.filter((i) => i.file && same(i.file, named));
        if (tried.length === 0 || tried.some((i) => i.ok !== false)) continue;
        // A shell command that wrote it (`sed -i`, a redirect) may have made the change instead.
        const shell = list.some((i) => i.cmd && i.change && i.ok !== false && i.cmd.toLowerCase().includes(leaf(named)));
        if (shell) continue;
        return { verdict: 'contradicted', evidence: tried.slice(-2).map(said), why: `It names ${named}, and every edit of it in this turn failed: ${tried.at(-1).text}.` };
    }
    // "Updated the handler to retry" when no edit in the turn went through and no command changed anything.
    // "Fixed the hang" claims a change as much as "updated the handler" does.
    const changed = list.some((i) => (i.cmd && i.change && i.ok !== false) || ((i.apply || i.kind === 'deploy') && i.ok !== false));
    if (!claim.improved && !claim.beats && edits.every((i) => i.ok === false) && !changed && (claim.kind === 'fixed' || CHANGE_CLAIM.test(claim.part ?? sentence))) {
        return { verdict: 'contradicted', evidence: edits.slice(-2).map(said), why: `Every edit in this turn failed, and no command changed a file: ${edits.at(-1).text}.` };
    }
    return undefined;
}

/**
 * "Removed every use of `moment`", "got rid of all `console.log` calls": the removal of each use of one name, which
 * the name after "use of" or a name that reads as code ("console.log", "getUser") gives.
 */
const REMOVED_ALL = /\b(?:removed|deleted|dropped|stripped|eliminated|purged|replaced|got\s+rid\s+of|ripped\s+out|cleaned\s+out)\s+(?:every|all|each|any)\s+(?:(?:the\s+)?(?:remaining\s+|last\s+|other\s+|old\s+)?(?:uses?|usages?|references?|imports?|calls?|occurrences?|instances?|mentions?|traces?)\s+(?:of|to)\s+(?:the\s+)?([A-Za-z_@$][\w.@\/$-]*)|(?:the\s+)?([A-Za-z_@$][\w@\/$-]*(?:\.[\w$]+)+|[a-z][a-z0-9]*[A-Z][\w$]*|[A-Za-z$]+_[\w$]+))/;
/** Files whose lines a search may still find after a removal of code: docs, notes and lock files. */
const NOT_CODE = /(?:^|\/)(?:[^\/]*\.(?:md|mdx|markdown|txt|rst|adoc|lock)|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG[^\/]*|README[^\/]*)$/i;

/**
 * "Removed every use of `moment`" when a search for `moment` after the last
 * change still found it in code: contradicted, or undefined.
 */
function stillFound(claim, list) {
    if (claim.kind !== 'done') return undefined;
    // The pattern keeps case to tell code names ("getUser") from words, so the sentence's first word is lowered.
    const m = REMOVED_ALL.exec(String(claim.part ?? claim.text ?? '').replace(/^\s*[A-Z](?=[a-z])/, (c) => c.toLowerCase()));
    const name = (m?.[1] ?? m?.[2])?.replace(/[.,;:]+$/, '');
    if (!name || name.length < 3) return undefined;
    const lastChange = lastIndex(list, (i) => (i.change || i.kind === 'change') && i.ok !== false);
    if (lastChange < 0) return undefined;
    const own = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'i');
    for (const i of list.slice(lastChange + 1).reverse()) {
        if (!i.search || i.search.counted || i.search.hits === 0 || i.ok === false) continue;
        if (!own.test(i.search.term.replace(/\\[bBwWsS]|[\\^$]/g, ' '))) continue;
        // The lines it found, by the file each names; lines in docs or lock files are not uses in code.
        const files = (i.lines ?? []).map((l) => /^([^\s:]+):(?:\d+:)?/.exec(String(l))?.[1]).filter(Boolean);
        const inCode = files.filter((f) => !NOT_CODE.test(f));
        if (files.length && inCode.length === 0) continue;
        return { verdict: 'contradicted', evidence: [said(i)], why: `A search after the last change still finds ${name}${inCode.length ? ` in ${[...new Set(inCode)].slice(0, 2).join(' and ')}` : ''}: ${i.text}.` };
    }
    return undefined;
}

/** "4 files changed", "updated 3 files": a count of files this turn changed. */
const FILES_CHANGED = /\b(\d+)\s+files?\s+(?:changed|updated|edited|modified|touched|rewritten)\b|\b(?:changed|updated|edited|modified|touched)\s+(\d+)\s+files?\b/i;

/**
 * "4 files changed" when this turn's edits went through for fewer files and
 * the edit of another one failed. Only when edits are all there is: a
 * command that changed files (`sed -i`, a commit) may account for more.
 */
function filesCount(claim, list) {
    if (claim.kind !== 'done' && claim.kind !== 'fixed') return undefined;
    const m = FILES_CHANGED.exec(claim.part ?? claim.text ?? '');
    if (!m) return undefined;
    const n = Number(m[1] ?? m[2]);
    const edits = list.filter((i) => i.kind === 'change' && !i.cmd);
    if (edits.length === 0 || edits.some((i) => !i.file) || list.some((i) => i.cmd && i.change && i.ok !== false)) return undefined;
    const done = new Set(edits.filter((i) => i.ok !== false).map((i) => i.file));
    if (done.size >= n) return undefined;
    const failed = edits.filter((i) => i.ok === false && !done.has(i.file));
    if (failed.length === 0) return undefined;
    const went = done.size === 1 ? 'one' : String(done.size);
    return { verdict: 'contradicted', evidence: failed.slice(-2).map(said), why: `It says ${n} files changed; edits went through for ${went} in this turn, and the edit of ${listed([...new Set(failed.map((i) => base(i.file)))].slice(0, 2))} failed.` };
}

/** A request for a write-up of what was done: a summary, a note, a PR description, a standup line. */
const WRITE_UP = /\bwrite\s+(?:it|that|this|these|them|those|everything|all of (?:it|that|this))\s+up\b|\b(?:write|draft|put together|prepare|compose|give me|make|turn (?:it|that|this) into)\s+(?:me\s+|us\s+)?(?:(?:it|that|this)\s+(?:up\s+)?(?:into|as)\s+)?(?:a|an|the|my|our|some)?\s*(?:short|quick|brief|one-line|small|little|tight|final)?\s*(?:pr description|pull request description|description|summary|recap|note|notes|message|update|status update|standup|stand-up|changelog entry|changelog|release notes?|commit message|email|post|tweet|blurb|announcement|one-?liner|tl;?dr|report|write-?up|paragraph)\b/gi;

/** Whether a person's message asks for a change to files ("fix the race", "add a test"); "do not change any file" does not. */
export function asksForChange(text) {
    if (typeof text !== 'string' || text.trim() === '') return false;
    const t = text.replace(WRITE_UP, ' ').replace(/\b(?:do\s+not|don'?t|never|without|no\s+need\s+to)\s+(?:[\w-]+\s+){0,3}?(?:change|edit|touch|modify|fix|add|write|update|create|delete|remove)\w*[^.!?\n]*/gi, ' ');
    return CHANGE_ASK.test(t);
}

/** Whether a person's message asks for new work (then an earlier turn's evidence does not back this turn's claims). */
export function asksForWork(text) {
    if (typeof text !== 'string' || text.trim() === '') return false;
    // "Write that up as a PR description", "draft a note for #releases": words about the work done, not new work.
    const t = text.trim().replace(WRITE_UP, ' ');
    if (/^(thanks|thank you|thx|great|nice|cool|ok|okay|perfect|awesome|got it|sounds good)\b[^a-z]*$/i.test(t)) return false;
    const VERB = '(add|fix|make|change|update|create|write|rename|remove|delete|move|refactor|implement|build|deploy|ship|release|publish|push|run|rerun|re-run|test|retest|install|set up|configure|migrate|convert|rewrite|try|redo|revert|merge|bump|clean|split|extract|replace|finish|do|continue|carry on|go ahead|proceed|start|consolidate|dedupe|deduplicate|tidy|upgrade|downgrade|pin|enable|disable|wire|hook up|port|document|optimi[sz]e|speed up|improve|reduce|harden|patch|tweak|adjust|tune|simplify|restructure|reorgani[sz]e|rework|polish|format|resolve|handle|support|integrate|scaffold|generate|regenerate|backfill|seed|rotate|roll back|rollback|commit|tag|apply|rebase|squash|sync|vendor|stub|mock|train|retrain|provision|spin up|kick off|execute|import|export|reindex|restore|load)';
    // "Do the tests pass?" asks about the state; "Can you run them?" (below) still asks for work.
    const told = t.split(/(?<=[.!?\n])\s+/).map((x) => x.trim()).filter((x) => !/\?\s*$/.test(x));
    // "Do not run anything", "do the tests pass": `do` as a helper verb asks for nothing.
    // "Do the tests pass" without its question mark is a question; "Do the migration now", "Do it" ask for work.
    const asking = '(?:the|these|those|all|any|both|my|our|your|its|their)\\s+(?:[\\w.-]+\\s+){0,3}?(?:pass|work|run|fail|exist|match|look|need|have|still|compile|build|apply)\\b';
    const imperative = new RegExp(`^(please\\s+|now\\s+|then\\s+|also\\s+|and\\s+)?(?!do\\s+(?:not|n't)\\b|do\\s+(?:you|we|they|i)\\b|do\\s+${asking})${VERB}\\b`, 'i');
    return told.some((x) => imperative.test(x))
        || new RegExp(`\\b(can|could|would|will) you\\s+(?:(?:please|also|just|now|quickly|then|first|still|maybe|go ahead and|kindly)\\s+)*${VERB}\\b`, 'i').test(t)
        || new RegExp(`\\b(i want|i'd like|i need|we need|let's)\\b[^.?!]{0,40}\\b${VERB}\\b`, 'i').test(t);
}
