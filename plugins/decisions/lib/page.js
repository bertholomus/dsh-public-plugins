/**
 * What Decisions' page shows, read in one go (no DSH imports, so its tests
 * run anywhere).
 *
 * @module dsh-plugin-decisions/page
 */

/** Log entries the page's history lists, newest first. */
const HISTORY = 150;

/** Whether Decisions works now: switched on in the profile, and every setting right. */
export const working = ({ config, check }) => config.enabled !== false && (check?.ok ?? true);

/** The page's view of the inbox. */
export async function pageState({ inbox, journal, config, check, mirror, watch, notifications }) {
    const problem = check?.problem;
    const watchProblem = watch?.settings?.problem;
    const { waiting, dismissed } = working({ config, check }) ? await inbox.list() : { waiting: [], dismissed: [] };
    return {
        ...(problem ? { problem } : {}),
        ...(watchProblem ? { watchProblem } : {}),
        enabled: config.enabled !== false,
        sources: {
            approvals: config.approvals !== false,
            questions: config.questions !== false,
            replies: config.replies !== false,
            threads: config.threads !== false,
        },
        notify: config.notify !== false,
        notifications: Boolean(notifications?.()),
        windowHours: config.windowHours,
        waiting,
        dismissed: dismissed.slice(0, 60),
        history: journal.list({ limit: HISTORY }),
        mirror: await mirror.describe(),
    };
}
