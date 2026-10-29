/**
 * Session Bridge: a script on the Mac makes a DSH session through the
 * bridge's socket, with a first prompt, and waits for the reply in one call.
 * The session is in DSH's window, where a person can read it and take over.
 *
 * The script's side is a real bash on this computer, in a pseudo-terminal,
 * that runs curl and jq against the bridge of this run. Its transcript is
 * drawn as a terminal window over a screenshot of DSH's window from the same
 * run, and the picture says so.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { forbiddenIn, setTheme, shownText } from '../stage.mjs';

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The script: one bash, so S and ID carry over from one command to the next as they do in a terminal. */
const commands = (prompt) => [
    'S=~/.dsh/session-bridge/bridge.sock',
    "curl -s --unix-socket $S http://bridge/health | jq -c '{ok, version, problems}'",
    `ID=$(curl -s --unix-socket $S -X POST http://bridge/sessions \\
    -H 'content-type: application/json' \\
    -d '{"workspacePath": "~/Projects/harbor-gateway",
         "title": "Nightly test run",
         "requestId": "nightly-tests-1",
         "text": "${prompt}"}' \\
    | jq -r .sessionId); echo $ID`,
    `curl -s --unix-socket $S \\
    "http://bridge/sessions/$ID/requests/nightly-tests-1?wait=600" \\
    | jq '{state, end: .end.kind, reply: .reply.text}'`,
];

/**
 * Each command and what it printed, from a bash in a pseudo-terminal (so jq colours its output as in a terminal).
 * Not synchronous: the demo model answers DSH from this process while the script waits.
 */
function runScript(list, home) {
    const show = 'show() { printf \'\\036%s\\037\' "$1"; eval "$1"; }\n';
    const script = show + list.map((c) => `show '${c.replace(/'/g, "'\\''")}'`).join('\n');
    return new Promise((resolve, reject) => {
        const child = spawn('script', ['-q', '/dev/null', '/bin/bash', '--noprofile', '--norc', '-c', script], {
            cwd: home,
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(`the script ended with ${code}: ${err || out}`));
            resolve(out.split('\x1e').slice(1).map((part) => {
                const [command, printed = ''] = part.split('\x1f');
                return { command, printed: printed.replace(/\r\n/g, '\n').replace(/\n$/, '') };
            }));
        });
    });
}

/** Terminal text with its colour codes (SGR) as spans. */
function ansi(text, colours) {
    let html = '';
    let style = { bold: false, fg: null };
    const open = () => (style.bold || style.fg ? `<span style="${style.fg ? `color:${style.fg};` : ''}${style.bold ? 'font-weight:700;' : ''}">` : '');
    const close = () => (style.bold || style.fg ? '</span>' : '');
    let at = 0;
    html += open();
    for (const m of text.matchAll(/\x1b\[([\d;]*)m/g)) {
        html += escape(text.slice(at, m.index));
        at = m.index + m[0].length;
        html += close();
        for (const code of (m[1] || '0').split(';').map(Number)) {
            if (code === 0) style = { bold: false, fg: null };
            else if (code === 1) style.bold = true;
            else if (code === 39) style.fg = null;
            else if (colours[code]) style.fg = colours[code];
        }
        html += open();
    }
    return html + escape(text.slice(at)) + close();
}

/** DSH's window from this run, with the script's terminal in front of it. */
function desk(steps, window, dark) {
    const c = dark
        ? { bg: '#171b22', term: '#1c1d21', bar: '#2a2c31', fg: '#e3e5e8', dim: '#8b929c', edge: 'rgba(255, 255, 255, 0.10)', label: 'rgba(230, 232, 235, 0.72)', sgr: { 30: '#8b929c', 90: '#8b929c', 32: '#8fd694', 34: '#7aa7ff' } }
        : { bg: '#e8ecf1', term: '#ffffff', bar: '#ececee', fg: '#1f2328', dim: '#6b7280', edge: 'rgba(0, 0, 0, 0.14)', label: 'rgba(31, 35, 40, 0.70)', sgr: { 30: '#6b7280', 90: '#6b7280', 32: '#1a7f37', 34: '#0550ae' } };
    const lines = steps.map((s) => `<div class="cmd"><span class="ps">$</span> ${escape(s.command)}</div>${s.printed ? `<div class="out">${ansi(s.printed, c.sgr)}</div>` : ''}`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
        /* Flat colours and no shadows: the picture stays small as a PNG without fewer colours. */
        body { background: ${c.bg}; color: ${c.fg}; }
        .dsh { position: absolute; left: 24px; top: 24px; width: 1152px; height: 720px; border-radius: 12px; border: 1px solid ${c.edge}; overflow: hidden; }
        .dsh img { display: block; width: 100%; height: 100%; }
        .term { position: absolute; right: 24px; bottom: 24px; width: 668px; border-radius: 12px; border: 1px solid ${c.edge}; background: ${c.term}; overflow: hidden; }
        .bar { height: 34px; display: flex; align-items: center; justify-content: center; position: relative; background: ${c.bar}; font-size: 13px; color: ${c.dim}; }
        .dots { position: absolute; left: 14px; top: 11px; display: flex; gap: 8px; }
        .dots i { width: 12px; height: 12px; border-radius: 50%; display: block; }
        .body { padding: 12px 16px 16px; font: 12.5px/1.5 Menlo, ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
        .ps { color: ${c.dim}; }
        .out { color: ${c.fg}; }
        .cursor { display: inline-block; width: 7px; height: 15px; vertical-align: -3px; background: ${c.dim}; }
        .label { position: absolute; left: 24px; top: 770px; width: 690px; font-size: 13px; line-height: 1.5; color: ${c.label}; }
    </style></head><body>
        <script>const dark = matchMedia('(prefers-color-scheme: dark)'); const mark = () => document.body.toggleAttribute('data-ds-dark-theme', dark.matches); mark(); dark.addEventListener('change', mark);</script>
        <div class="dsh"><img src="${window}" alt=""></div>
        <div class="term"><div class="bar"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>~ — bash</div>
            <div class="body">${lines}<div class="cmd"><span class="ps">$</span> <span class="cursor"></span></div></div></div>
        <div class="label">The terminal is drawn from what bash printed when it ran these commands against the bridge in this run. Behind it: DSH's window from the same run, made smaller.</div>
    </body></html>`;
}

export default async function sessionBridge(scene) {
    // The socket where the bridge puts it when its row names none: ~/.dsh/session-bridge/bridge.sock. A Unix
    // socket's path has at most about 100 bytes, so this run's demo home goes in /var/tmp, where the path is short.
    // (Not /tmp: a package file left at its top can stand in for one of DSH's own.) DSH itself starts with the
    // usual temporary folder.
    const tmp = process.env.TMPDIR;
    const usual = () => {
        if (tmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = tmp;
    };
    process.env.TMPDIR = '/var/tmp';
    let run;
    try {
        run = await scene.start({
            plugins: [],
            // The tests run with no question to a person: no one is at the window at night.
            rows: `- id: permission
  config:
    defaultPreset: workspace-write
`,
            before: (r) => {
                usual();
                r.sock = join(r.home, 'session-bridge', 'bridge.sock');
                if (Buffer.byteLength(r.sock) > 100) throw new Error(`the socket path is ${Buffer.byteLength(r.sock)} bytes`);
            },
        });
    } finally {
        usual();
    }

    // The script: a session in harbor-gateway with a first prompt, under a request id, and the wait for its reply.
    const steps = await runScript(commands(scene.say('Run the tests and sum up')), run.user);
    const session = /session-[0-9a-f-]{36}/.exec(steps[2]?.printed ?? '')?.[0];
    if (!session) throw new Error(`no session id in what the script printed: ${JSON.stringify(steps)}`);
    if (!/"answered"/.test(steps[3]?.printed ?? '')) throw new Error(`the wait did not end answered: ${steps[3]?.printed}`);

    // DSH's window: the session the script made, in the list and open.
    const page = await scene.open({ entry: 'Plugins' });
    const row = page.locator(`[data-row-key="session:${session}"]`).first();
    // The workspace came after the window: its folder in the session list opens to show the chat.
    if (!(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) {
        await page.locator('[data-slot="sidebar.workspaces"]').getByText('harbor-gateway', { exact: true }).first().click();
    }
    await row.click();
    await page.getByText('nothing to fix tonight').first().waitFor({ state: 'visible', timeout: 30000 });
    await run.idle(session);

    // The script and the window together.
    const drawn = await page.context().newPage();
    await drawn.setContent('<!doctype html><body><script>const dark = matchMedia(\'(prefers-color-scheme: dark)\'); const mark = () => document.body.toggleAttribute(\'data-ds-dark-theme\', dark.matches); mark(); dark.addEventListener(\'change\', mark);</script></body>');
    try {
        await scene.shoot('bridge', {
            page: drawn,
            prepare: async (p, dark) => {
                await setTheme(page, dark);
                await page.mouse.move(1, 899, { steps: 8 });
                await page.waitForTimeout(600);
                const hits = forbiddenIn(await shownText(page));
                if (hits.length) throw new Error(`DSH's window shows ${hits.map((h) => `${h.what}: ${h.match}`).join('; ')}`);
                const window = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
                await p.setContent(desk(steps, window, dark), { waitUntil: 'load' });
            },
        });
    } finally {
        await drawn.close();
    }

    // DSH's window at its own size: the session as the script left it, with the test run and its output open.
    await scene.shoot('session', {
        themes: ['light'],
        prepare: async (p) => {
            await p.getByText(/^Completed in/).first().click();
            await p.getByText('Ran commands', { exact: true }).first().click();
            await p.getByText('Run the tests', { exact: true }).first().click();
            await p.getByText(/pass 12/).first().waitFor({ state: 'visible', timeout: 10000 });
        },
    });
}
