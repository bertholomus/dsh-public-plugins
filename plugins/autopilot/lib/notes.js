/**
 * Autopilot's words: the notes it puts into a session (for the agent), and
 * the "why" line it logs with every action (for the person). Each note
 * starts with "[Autopilot]" so the agent and the person reading the chat
 * both see who wrote it.
 *
 * @module dsh-plugin-autopilot/notes
 */
import { clip } from './shared/safe.js';
import { count, spanWords, timeWords } from './shared/words.js';

const DECISION_HINT = 'If something blocks you, end your reply with one line: DECISION NEEDED: <question> — recommend: <your pick>.';

/** A goal's rounds so far, in brackets: " (round 2 of 6)", " (no round begun yet, up to 6)". */
function roundsSoFar(goal) {
    // Before its first round a goal has no round to name: "round 0 of 6" would read as nonsense.
    return goal.rounds > 0 ? (goal.max ? ` (round ${goal.rounds} of ${goal.max})` : '') : goal.max ? ` (no round begun yet, up to ${goal.max})` : ' (no round begun yet)';
}

/**
 * What is still open in a session, in a few words: "3 open todos (next:
 * “Write the test”)". `plain` drops the word "open" for a sentence that
 * says it already ("Still open: 3 todos (next: …)").
 */
export function openWork(state, { plain = false } = {}) {
    const parts = [];
    const todos = state?.todos;
    if (todos?.open > 0) parts.push(`${count(todos.open, plain ? 'todo' : 'open todo')}${todos.next ? ` (next: “${clip(todos.next, 80)}”)` : ''}`);
    const goal = state?.goal;
    if (goal?.phase === 'active') parts.push(`the goal “${clip(goal.objective, 80)}”${roundsSoFar(goal)}`);
    return parts.join(' and ');
}

/** What is still open, for a why line: "3 todos still open (next: “Write the test”)", "the goal “Ship it” still active (round 2 of 6)". */
export function stillOpen(state) {
    const parts = [];
    const todos = state?.todos;
    if (todos?.open > 0) parts.push(`${count(todos.open, 'todo')} still open${todos.next ? ` (next: “${clip(todos.next, 80)}”)` : ''}`);
    const goal = state?.goal;
    if (goal?.phase === 'active') parts.push(`the goal “${clip(goal.objective, 80)}” still active${roundsSoFar(goal)}`);
    return parts.join(' and ');
}

/**
 * An error as DSH gave it, for the middle of a sentence: cut short, with
 * no closing full stop (DSH's own errors often end with one, and the
 * sentence adds its own).
 */
export function errorWords(error, max = 160) {
    return clip(String(error ?? ''), max).replace(/[\s.]+$/, '');
}

/** A sentence's end: a full stop, unless the words already end one ("…", "!" or "?"). */
const ended = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** What a cut-off turn left waiting, for the note: a tool that did not run, a question with no answer. */
export function leftWords(left) {
    if (left?.kind === 'approval') {
        const what = left.tool ? `your ${clip(left.tool, 60)} call` : 'your tool call';
        const more = left.more ? ` (and ${count(left.more, 'other call')})` : '';
        return `When DSH stopped, ${what}${more} was waiting for approval, so it did not run: make it again if you still need it, and DSH asks for approval again.`;
    }
    if (left?.kind === 'question') {
        const what = left.question ? `your question in DSH's question box (“${clip(left.question, 140)}”)` : 'your question in DSH\'s question box';
        return `When DSH stopped, ${what} had no answer yet: ask it again if you still need the answer.`;
    }
    return '';
}

/** The note for a session whose turn DSH cut off when it stopped. */
export function carryOnNote(end, state, now = Date.now()) {
    const work = openWork(state, { plain: true });
    return [
        `[Autopilot] DSH stopped while you were working: turn ${end.turn} was cut off (its last step was at ${timeWords(end.at, now)}).`,
        leftWords(end.left),
        'Check what already finished (files, commands, todos), then carry on from where you stopped.',
        work ? `Still open: ${work}.` : '',
        DECISION_HINT,
    ].filter(Boolean).join(' ');
}

/** The note for an idle session with open todos. */
export function nudgeNote(state) {
    const todos = state?.todos ?? {};
    return [
        `[Autopilot] You stopped with ${count(todos.open ?? 0, 'open todo')}${todos.next ? ` (next: “${clip(todos.next, 100)}”)` : ''}.`,
        'Carry on with the next one, or mark the ones that are done.',
        DECISION_HINT,
    ].join(' ');
}

/**
 * The note after a turn that failed, for a session with open work. With
 * `carry` (the turn was carrying on after DSH stopped under an earlier
 * one), it says so, as the carry-on note did.
 */
export function errorNote(end, state, { carry } = {}) {
    const work = openWork(state, { plain: true });
    return [
        ended(`[Autopilot] Your last turn (turn ${end.turn}) failed${end.error ? `: ${errorWords(end.error, 160)}` : ''}`),
        carry && !work
            ? `You were carrying on after DSH stopped under turn ${carry.cut ?? 'an earlier turn'}: check what already finished (files, commands, todos), then carry on from where you stopped.`
            : 'Carry on from where you stopped.',
        work ? `Still open: ${work}.` : '',
        'If the same error comes back, stop and end your reply with one line: DECISION NEEDED: <question> — recommend: <your pick>.',
    ].filter(Boolean).join(' ');
}

/** The note that carries a person's own answer into the session. */
export function answerNote(text) {
    return `[Autopilot] The user answered: ${text}`;
}

// ── Why lines, for the event log ─────────────────────────────────────

export function whyResume(end, now = Date.now()) {
    // DSH closes a running turn as interrupted on its next start, after a quit, a restart or a crash alike.
    const how = end.kind === 'interrupted' ? 'DSH stopped before it finished (a quit, a restart or a crash)' : 'DSH shut down under it';
    // The time is DSH's stamp on the cut-off turn: its last step, not the moment DSH stopped.
    const left = end.left?.kind === 'approval' ? ' A tool was waiting for approval when it stopped; the note says it did not run.'
        : end.left?.kind === 'question' ? ' Its question in DSH\'s question box had no answer; the note says to ask again.' : '';
    return `Turn ${end.turn} was cut off: ${how}. Its last step was at ${timeWords(end.at, now)}, and nobody has written in the session since.${left}`;
}

export function whyNudge(state, idleMs) {
    return `It has been idle for ${spanWords(idleMs)} after turn ${state.end?.turn ?? state.turn} with ${count(state.todos?.open ?? 0, 'open todo')}, and its last reply asked you nothing.`;
}

/** "round 3 of 4": the round a start of this goal begins. */
function roundWords(goal) {
    const next = (goal?.rounds ?? 0) + 1;
    return goal?.max ? `round ${next} of ${goal.max}` : `round ${next}`;
}

export function whyRearmIdle(state, idleMs) {
    return `Its goal “${clip(state.goal?.objective, 80)}” is active but stopped (a DSH restart or an error stops a goal), and it has been idle for ${spanWords(idleMs)}. This start begins ${roundWords(state.goal)}.`;
}

/** A failed turn stopped a goal: a note goes first (it costs no goal round), and the goal starts again only after a turn without an error. */
export function whyRearmError(end, state) {
    return `Turn ${end.turn} failed${end.error ? ` (${errorWords(end.error, 120)})` : ''}, which stops a goal; the goal “${clip(state.goal?.objective, 80)}” is still active. A note costs no goal round, so it goes first; the goal starts again (${roundWords(state.goal)}) once a turn ends without an error.`;
}

/** Why a failed turn gets a carry-on note: what is still open, or (`carry`) the carry-on after a stop that it was. */
export function whyErrorNote(end, state, { carry } = {}) {
    const failed = `Turn ${end.turn} failed${end.error ? ` (${errorWords(end.error, 120)})` : ''}`;
    const open = stillOpen(state);
    if (open) return `${failed} with ${open}.`;
    if (carry) return `${failed} while it carried on after DSH stopped under turn ${carry.cut ?? 'an earlier turn'}, so the work that stop cut off is still open.`;
    return `${failed} with work still open.`;
}

export function whyBackOff(maxNudges) {
    return `${maxNudges === 1 ? 'A note' : `${maxNudges} notes in a row`} brought no progress (no todo done, no goal round), so Autopilot leaves this session to you until you write in it or it moves on its own.`;
}

export function whyGiveUp(tries) {
    return `It failed again after ${count(tries, 'try', 'tries')}, so Autopilot stops retrying and leaves it to you.`;
}

export function whyHeld(limit) {
    return `Autopilot already sent ${count(limit, 'note')} in the last hour, the most it sends; it tries again when the hour has room.`;
}

// ── Questions, for the "Ask first" rule ───────────────────────────────

export function question(plan, title) {
    const name = title ? `“${clip(title, 60)}”` : 'This session';
    switch (plan.kind) {
        case 'resume': return `${name} was cut off when DSH stopped. Tell it to carry on?`;
        case 'nudge': return `${name} stopped with ${openWork(plan.state) || 'open work'}. Tell it to carry on?`;
        case 'rearm': return `${name} has an active goal that stopped. Start the goal again?`;
        case 'error': return plan.carry && !openWork(plan.state)
            ? `${name} failed (${errorWords(plan.end?.error || 'an error', 80)}) while it carried on after DSH stopped. Tell it to carry on?`
            : `${name} failed (${errorWords(plan.end?.error || 'an error', 80)}) with work open. Tell it to carry on?`;
        default: return `${name} may need a push. Go ahead?`;
    }
}

/** The button for doing what a plan does. */
export function actionLabel(plan) {
    return plan.action === 'rearm' ? 'Start the goal again' : 'Tell it to carry on';
}
