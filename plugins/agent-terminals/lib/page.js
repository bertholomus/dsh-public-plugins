/**
 * What Agent Terminals' page shows, read in one go (no DSH imports, so its
 * tests run anywhere).
 *
 * @module dsh-plugin-agent-terminals/page
 */
import { STYLES, STYLE_IDS } from './launch.js';

/** Log entries the page's history lists, newest first. */
const HISTORY = 150;

/** Whether Agent Terminals works now: switched on in the profile, and every setting right. */
export const working = ({ config, check }) => config.enabled !== false && (check?.ok ?? true);

/** The ways a program can start and resume, as the start form offers them. */
export const STYLE_CHOICES = Object.freeze(STYLE_IDS.map((id) => ({ id, label: STYLES[id].label, detail: STYLES[id].detail, resumes: Boolean(STYLES[id].resume), keepsTranscript: STYLES[id].format !== 'none' })));

/** The page's view of the agents. */
export async function pageState({ agents, journal, config, check, watch, terminals, detected, workspaces }) {
    const problem = check?.problem;
    const watchProblem = watch?.settings?.problem;
    const on = working({ config, check });
    return {
        ...(problem ? { problem } : {}),
        ...(watchProblem ? { watchProblem } : {}),
        enabled: config.enabled !== false,
        terminals: Boolean(terminals?.()),
        agents: on || config.enabled !== false ? agents.list() : [],
        recent: agents.recent,
        detected: await detected(),
        workspaces: workspaces(),
        styles: STYLE_CHOICES,
        settings: {
            resumeAfterRestart: config.resumeAfterRestart !== false,
            listNewSessions: config.listNewSessions !== false,
            openTabs: config.openTabs !== false,
            typeWhileWorking: config.typeWhileWorking === true,
            proofSeconds: config.proofSeconds,
            enterRetries: config.enterRetries,
            askAfterSeconds: config.askAfterSeconds,
            notify: config.notify !== false,
            typing: config.typing,
        },
        history: journal.list({ limit: HISTORY }),
    };
}
