/**
 * The showcase's stage: a DSH from the test bench (test/e2e/harness.mjs) in a
 * throwaway folder that reads like a person's computer, the demo model, and
 * the window the pictures are taken from.
 *
 * - The throwaway folder holds a demo home (HOME for DSH and everything it
 *   starts), so DSH shows its paths as `~/…`: DSH's own home is `~/.dsh`
 *   there, and the demo projects are `~/Projects/<name>`, copied from
 *   scripts/showcase/projects. Nothing reads or writes your own ~/.dsh.
 * - The model is `local-model` on a provider named Local, played by the demo
 *   model (scripts/showcase/demo-model.mjs) from scripts/showcase/demo.json.
 * - The window is 1440 by 900 at device scale 2, in a time zone where the
 *   clock reads mid-morning, so the times in the pictures look like a working
 *   day whenever the pictures are made.
 * - Before each picture the window's text is read for words that must never
 *   show (test wording, temporary paths, private names); a picture that
 *   shows one is still kept, and the run lists it as a problem.
 *
 * @module scripts/showcase/stage
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshRun, dismissNotices, launchChromium, sleep, waitFor } from '../../test/e2e/harness.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');
export const shotsDir = join(repoRoot, 'docs', 'screenshots');

/** The demo projects, in ~/Projects: the same three in every picture. */
export const PROJECTS = ['harbor-gateway', 'tide-ledger', 'atlas-docs'];

/** The model every picture shows: neutral, and not a real vendor's. */
export const MODEL = { provider: 'local', providerName: 'Local', id: 'local-model', name: 'local-model' };

/**
 * Names that say whose computer made the pictures: a home folder's path, this account's name, and the words in
 * SHOWCASE_PRIVATE (comma-separated, such as the names of your other machines). They stay out of this file.
 */
function privateNames() {
    const words = [userInfo().username, ...(process.env.SHOWCASE_PRIVATE ?? '').split(',')].map((w) => w.trim()).filter((w) => w.length >= 3);
    const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(['\\/Users\\/', '\\/home\\/', ...words.map((w) => `\\b${escape(w)}`)].join('|'), 'i');
}

/** Words that must never show in a picture: test wording, temporary paths and private names. */
export const FORBIDDEN = [
    [/E2E/, 'test marker'],
    [/MISSING TOOL|No demo reply|No \w+ tool in this session/, 'unscripted turn'],
    [/\bfake[- ]?(model|check|llm)?\b/i, 'fake'],
    [/stand-in/i, 'stand-in'],
    [/\/var\/folders|\/private\/|\/tmp\/|-e2e-/, 'temporary path'],
    [/(^|[\s(“"'])ws([\s)”"',.]|$)|work-a/m, 'test workspace name'],
    [privateNames(), 'private name'],
    [/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'tailnet address'],
    [/\b\d{17,20}\b/, 'long id'],
    [/[\w.+-]+@[\w-]+\.[\w.]+/, 'email address'],
];

/** The forbidden words in a text: `[{ what, match }]`. */
export function forbiddenIn(text) {
    const hits = [];
    for (const [re, what] of FORBIDDEN) {
        const m = re.exec(text);
        if (m) hits.push({ what, match: text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ') });
    }
    return hits;
}

/** A time zone where the clock reads closest to 10:30 now (the same few zones every run). */
export function demoTimezone(now = new Date()) {
    const zones = ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
        'Europe/London', 'Europe/Berlin', 'Europe/Athens', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore',
        'Asia/Tokyo', 'Australia/Brisbane', 'Pacific/Auckland', 'Pacific/Honolulu'];
    const minutesIn = (zone) => {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
        return Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
    };
    return zones.map((zone) => ({ zone, off: Math.abs(minutesIn(zone) - 630) })).sort((a, b) => a.off - b.off)[0].zone;
}

/**
 * A DSH from the test bench whose HOME is a demo home in its throwaway folder.
 * Everything else (the bridge, the plugins linked into the web profile, the
 * stop and the clean-up) is the bench's own.
 */
export class ShowcaseRun extends DshRun {
    /**
     * @param {{ label: string, bin: string, plugins: Record<string, string>, rows?: string, model?: object, env?: object }} options
     *   model: changes to MODEL, such as `efforts` ({ low: 'low', high: 'high' }) or `more` (other models of the same provider)
     */
    constructor({ label, bin, plugins, rows = '', model = {}, env = {} }) {
        super({ label: `showcase-${label}`, bin, plugins, rows, env });
        this.user = join(realpathSync(this.root), 'home');
        this.home = join(this.user, '.dsh');
        if (this.home === join(homedir(), '.dsh') || this.user === homedir()) throw new Error('the demo home may not be yours');
        this.projects = join(this.user, 'Projects');
        this.ws = join(this.projects, PROJECTS[0]);
        this.model = { ...MODEL, ...model };
        this.env = { ...this.env, HOME: this.user, LOCAL_MODEL_KEY: 'local', ...env };
        seedHome(this.user);
    }

    /** The web profile: the plugins, the demo model as DSH's default, the bridge, and `rows`. */
    writeProfile(modelPort) {
        super.writeProfile(modelPort);
        const m = this.model;
        const entry = (x) => `          - id: ${x.id}
            name: ${x.name ?? x.id}
            contextWindow: 131072
            reasoningEfforts: ${x.efforts ? JSON.stringify(x.efforts) : 'false'}
`;
        const patch = readFileSync(join(this.profile, 'cordis.patch.yml'), 'utf8')
            .replace(/- id: agent-default-model[\s\S]*?(?=- id: session-bridge)/, `- id: agent-default-model
  config:
    provider: ${m.provider}
    model: ${m.id}
- id: llm-pi-ai
  config:
    providers:
      ${m.provider}:
        displayName: ${m.providerName}
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        apiKeyEnv: LOCAL_MODEL_KEY
        models:
${[m, ...(m.more ?? [])].map(entry).join('')}`);
        writeFileSync(join(this.profile, 'cordis.patch.yml'), patch);
        // Each plugin linked as the README installs it, from a clone at ~/.dsh-plugins/dsh-public-plugins (here a
        // link to this repo), so a plugin's page in Plugins names that source, not this computer's folders.
        const clone = join(this.user, '.dsh-plugins', 'dsh-public-plugins');
        if (!existsSync(clone)) {
            mkdirSync(dirname(clone), { recursive: true });
            symlinkSync(repoRoot, clone, 'dir');
        }
        const pkg = JSON.parse(readFileSync(join(this.profile, 'package.json'), 'utf8'));
        for (const [name, spec] of Object.entries(pkg.dependencies)) {
            const at = spec.indexOf('/plugins/');
            if (spec.startsWith('link:') && at !== -1) pkg.dependencies[name] = `link:~/.dsh-plugins/dsh-public-plugins${spec.slice(at)}`;
        }
        writeFileSync(join(this.profile, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    }

    /** A new session in a demo project: its id. */
    async newSession({ project = PROJECTS[0], title, prompt }) {
        const made = await this.bridge('POST', '/sessions', { workspacePath: join(this.projects, project), ...(title ? { title } : {}), ...(prompt ? { text: prompt } : {}) });
        return made.sessionId;
    }

    /** A prompt into a session that is already there. */
    prompt(sessionId, text) {
        return this.bridge('POST', `/sessions/${encodeURIComponent(sessionId)}/prompt`, { text });
    }

    /** Wait until a session's turns have all ended (at least `turns` of them): its summary. */
    idle(sessionId, { turns = 1, timeout = 60000 } = {}) {
        return waitFor(async () => {
            const s = await this.session(sessionId);
            return s.status !== 'running' && s.turns.started >= turns && s.turns.started === s.turns.ended ? s : null;
        }, `${sessionId} to finish its turns`, timeout, 250);
    }
}

/** The demo home: the projects (each a git repository with a short history), and the folders a person has. */
export function seedHome(user) {
    const projects = join(user, 'Projects');
    mkdirSync(projects, { recursive: true });
    for (const name of PROJECTS) {
        const from = join(here, 'projects', name);
        const to = join(projects, name);
        mkdirSync(to, { recursive: true });
        if (existsSync(from)) cpSync(from, to, { recursive: true });
        gitHistory(to, user);
    }
}

/** A git repository with the commits that `.history` lists (one "<date>|<message>" a line), every file in the first. */
function gitHistory(dir, user) {
    const list = join(dir, '.history');
    if (!existsSync(list)) return;
    const lines = readFileSync(list, 'utf8').split('\n').filter(Boolean);
    rmSync(list);
    // A name and no address: nothing in a picture reads as someone's email.
    const env = { ...process.env, HOME: user, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Sam Rivera', GIT_COMMITTER_NAME: 'Sam Rivera', GIT_AUTHOR_EMAIL: 'sam', GIT_COMMITTER_EMAIL: 'sam' };
    const git = (args, more = {}) => execFileSync('git', args, { cwd: dir, env: { ...env, ...more }, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q', '-b', 'main']);
    lines.forEach((line, i) => {
        const [date, message] = line.split('|');
        if (i === 0) git(['add', '-A']);
        git(['commit', '-q', '--allow-empty', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    });
}

/**
 * The window, signed in, 1440 by 900 at scale 2, with `entry` (a sidebar
 * entry's name) showing and DSH's first-run notices out of the way. `init`
 * is a script that runs in it before DSH's own.
 */
export async function openShowcaseWindow(run, pw, { entry, dark = true, width = 1440, height = 900, scale = 2, timezoneId = demoTimezone(), init } = {}) {
    const web = await run.signIn();
    const browser = await launchChromium(pw);
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, locale: 'en-US', colorScheme: dark ? 'dark' : 'light', timezoneId });
    if (init) await context.addInitScript({ content: init });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(web.link, { waitUntil: 'domcontentloaded' });
    if (entry) await page.getByRole('button', { name: entry, exact: true }).first().waitFor({ state: 'visible', timeout: 90000 });
    const end = Date.now() + 30000;
    let calm = Date.now();
    while (Date.now() < end && Date.now() - calm < 4000) {
        if (await dismissNotices(page)) calm = Date.now();
        await page.waitForTimeout(400);
    }
    return { browser, context, page, errors, timezoneId };
}

/** DSH's light or dark theme, as the system setting chooses it. */
export async function setTheme(page, dark) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await waitFor(() => page.evaluate((want) => document.body.hasAttribute('data-ds-dark-theme') === want, dark), `DSH's ${dark ? 'dark' : 'light'} theme`, 10000).catch(() => {});
    await page.waitForTimeout(350);
}

/** The window once its animations have settled. */
async function settle(page, { still = false } = {}) {
    // No caret and no hover left over from the last click: the pointer goes to a corner in steps, so what it
    // passed over sees it leave, and a tooltip a layout shift put under it closes.
    if (!still) {
        await page.mouse.move(1, 899, { steps: 8 }).catch(() => {});
        await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
    }
    await page.waitForTimeout(400);
    await Promise.race([
        page.evaluate(() => Promise.all(document.getAnimations()
            .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})))),
        page.waitForTimeout(2500),
    ]).catch(() => {});
    if (!still) await page.locator('[role="tooltip"]').filter({ visible: true }).first().waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(150);
}

/** A PNG made smaller: lossless first, and 256 colours only when that is still over the limit. */
export function optimise(file, limit = 700 * 1024) {
    const tmp = `${file}.tmp.png`;
    execFileSync('magick', [file, '-strip', '-define', 'png:compression-level=9', '-define', 'png:compression-filter=5', tmp]);
    renameSync(tmp, file);
    if (statSync(file).size <= limit) return { bytes: statSync(file).size, colours: 'full' };
    execFileSync('magick', [file, '-strip', '-dither', 'FloydSteinberg', '-colors', '256', '-define', 'png:compression-level=9', `PNG8:${tmp}`]);
    renameSync(tmp, file);
    return { bytes: statSync(file).size, colours: '256' };
}

/**
 * The words a picture of the window shows: every text node drawn inside the
 * window's bounds (an element scrolled out of view is not in the picture,
 * so a word there cannot be either), and each field's own value.
 */
export function shownText(page) {
    return page.evaluate(() => {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const inView = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
        const parts = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent.trim()) continue;
            const el = node.parentElement;
            if (!el || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
            range.selectNodeContents(node);
            if ([...range.getClientRects()].some(inView)) parts.push(node.textContent);
        }
        for (const field of document.querySelectorAll('input, textarea')) {
            if (field.value && inView(field.getBoundingClientRect())) parts.push(field.value);
        }
        return parts.join('\n');
    });
}

/**
 * One picture of the window: docs/screenshots/<plugin>/<view>-<theme>.png,
 * after a check of the window's text for words that must never show.
 * `still` leaves the pointer and the keyboard where they are (a menu open
 * under them stays open).
 */
export async function capture(page, { plugin, view, dark, report, still = false }) {
    await settle(page, { still });
    const text = await shownText(page).catch(() => '');
    const hits = forbiddenIn(text);
    const dir = join(shotsDir, plugin);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${view}-${dark ? 'dark' : 'light'}.png`);
    await page.screenshot({ path: file });
    const size = optimise(file);
    report?.push({ plugin, file: file.slice(repoRoot.length + 1), ...size, hits });
    for (const hit of hits) console.log(`# ${plugin}/${view}-${dark ? 'dark' : 'light'}: ${hit.what}: …${hit.match}…`);
    return file;
}

/** Every picture of a plugin that this run did not make (so a view that was dropped does not linger). */
export function dropOthers(plugin, kept) {
    const dir = join(shotsDir, plugin);
    if (!existsSync(dir)) return [];
    const gone = readdirSync(dir).filter((n) => n.endsWith('.png') && !kept.includes(join(dir, n)));
    for (const n of gone) rmSync(join(dir, n));
    return gone;
}

/** Unfold a finished turn's steps ("Completed in …") and its runs of calls, as a person opens them to see the calls. */
export async function unfold(page) {
    const folded = page.locator('button[data-turn-process][aria-expanded="false"], [data-step-process] button[aria-expanded="false"]').filter({ visible: true });
    for (let i = 0; i < 8 && (await folded.count()) > 0; i += 1) {
        await folded.first().click();
        await sleep(300);
    }
}

export { sleep, waitFor };
