/**
 * The write rules for agents: whether a chat may add, change, answer or
 * delete events, decided per call before the tool runs (DSH's
 * `tools/pre-execute`). Reading is never gated here.
 *
 * The plugin setting `agentChanges`:
 *   'preset' (default) - by the session's permission: Read Only can't
 *            change calendars; Full access changes them without asking; Auto
 *            leaves each change to its reviewer; anything else (Workspace
 *            Write, a custom mix) asks the user first, in DSH's approval
 *            prompt, saying what would change.
 *   'ask'    - every change asks the user first.
 *   'off'    - agents can't change calendars; the window still can.
 *
 * A change that emails someone (an invitation, an update, a cancellation,
 * an answer), or that puts an event on other people's calendars or takes
 * it off them without emailing them (Google), asks the user first whatever
 * the setting, naming who, unless `askBeforeEmails` is off. A chat whose
 * approval prompts are off (Full access) can't ask, so it gets a refusal
 * that says why, as it does for any change that would ask. So does a
 * change the tool would refuse anyway (a missing scope, guests who'd be
 * emailed without the call saying to tell them), in the tool's own words:
 * nobody is asked about something that won't happen.
 *
 * Who the user was told of goes to the tool with the call (ShownPlans): the
 * event can change on its server while the prompt waits, and a change that
 * would by then email or reach someone else stops instead. A call the gate
 * kept no list for is held to nobody.
 *
 * @module dsh-plugin-calendar/policy
 */
import { CalendarError, peopleOf, peopleWords } from './manager.js';
import { changeInput, refusalText, scopeArg } from './args.js';

export const MODES = ['preset', 'ask', 'off'];

/** The tools that change calendars (tools.js); the rest only read. */
export const CHANGE_TOOLS = new Set(['calendar_create_event', 'calendar_update_event', 'calendar_delete_event', 'calendar_respond']);

/**
 * What a session may do, from its permission preset: the preset's sandbox
 * ('read-only', 'workspace-write', 'danger-full-access'), 'auto', or
 * 'unknown' (a custom mix, or a DSH without presets).
 */
export function accessOf(presets, session) {
    if (!presets || !session) return 'unknown';
    try {
        const name = presets.current(session);
        if (name === 'auto') return 'auto';
        if (typeof name !== 'string' || name === 'custom') return 'unknown';
        const sandbox = presets.resolve(name)?.sandbox;
        return ['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox) ? sandbox : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * The decision for one change, without DSH: 'allow', 'ask', or a refusal
 * ({deny: reason for the model}).
 */
export function decide(mode, access) {
    if (mode === 'off') {
        return { deny: 'Changing the user\'s calendars from chats is switched off in the calendar plugin\'s settings. Tell the user what you would change; they can do it on the Calendar page.' };
    }
    if (mode === 'ask') return 'ask';
    if (access === 'read-only') {
        return { deny: 'This session\'s permission is Read Only: it can read the user\'s calendars but not change them. Tell the user what you would change; they can do it on the Calendar page, or give this session more access.' };
    }
    if (access === 'danger-full-access' || access === 'auto') return 'allow';
    return 'ask';
}

/**
 * Whether DSH's approval prompt can ask the user in this session: not when
 * its approval policy is 'never' (Full access), where an ask is turned
 * down as if the user said no.
 */
export function canAsk(approval, session) {
    try {
        return approval?.effectivePolicy?.(session) !== 'never';
    } catch {
        return true;
    }
}

const clip = (text, n = 80) => {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const SCOPE_WORDS = { one: 'only this occurrence of ', following: 'this and the following occurrences of ', all: '' };

/** calendar_update_event's `clear`, in words. */
const CLEAR_WORDS = { location: 'no place', description: 'no notes', url: 'no link', repeat: 'stop repeating' };

const KINDS = { calendar_create_event: 'create', calendar_update_event: 'update', calendar_delete_event: 'delete', calendar_respond: 'respond' };

/**
 * What a call would do as far as other people go, worked out by the very
 * check the tool makes first (manager.planChange): {mail} (who it emails
 * or reaches: manager.mailOf), or {refusal}, in the tool's own words, when
 * the tool would refuse it before changing anything. {} when that can't be
 * told here (the tool then decides). Never throws.
 */
export function planOf(manager, name, args) {
    const kind = KINDS[name];
    if (kind === undefined || typeof manager?.planChange !== 'function') return {};
    const a = args !== null && typeof args === 'object' ? args : {};
    const notify = a.notify_guests === true;
    try {
        const id = String(a.id ?? '');
        const change = kind === 'create' ? { input: changeInput(a, manager.zone()), notify }
            : kind === 'update' ? { id, input: changeInput(a, manager.zone()), scope: scopeArg(manager, id, a.scope), notify }
            : kind === 'delete' ? { id, scope: scopeArg(manager, id, a.scope), notify }
            : { id, scope: scopeArg(manager, id, a.scope, { answer: true }), status: a.answer };
        return { mail: manager.planChange(kind, change).mail };
    } catch (error) {
        return error instanceof CalendarError ? { refusal: refusalText(error) } : {};
    }
}

/** How a change reaches guests' calendars without emailing them, as an instruction. */
const REACH_WORDS = { add: 'put it on', remove: 'take it off', change: 'change it on' };

/**
 * ", and email an update to a, b and c" for a change that emails people,
 * and ", and put it on the calendars of d without emailing them" for one
 * that reaches them without email.
 */
const emailWords = (mail) => {
    const emailed = mail?.to?.length > 0 ? `, and email ${mail.what} to ${peopleWords(mail.to)}` : '';
    const reached = mail?.reaches?.length > 0 ? `, and ${REACH_WORDS[mail.reach] ?? 'change it on'} the calendars of ${peopleWords(mail.reaches)} without emailing them` : '';
    return `${emailed}${reached}`;
};

/**
 * A change in words for the approval prompt: what, which event, where, and
 * who it emails. `mail` is planOf's; without it the words go by the call
 * alone. Never throws.
 */
export function describeChange(manager, name, args = {}, mail = planOf(manager, name, args).mail) {
    const a = args !== null && typeof args === 'object' ? args : {};
    let event;
    try {
        event = manager.event(String(a.id ?? ''));
    } catch {
        event = undefined;
    }
    const eventWords = () => {
        if (event === undefined) return 'an event';
        try {
            const zone = manager.zone();
            const day = event.allDay ? event.startDay : event.startLocal?.slice(0, 10);
            const time = event.allDay ? 'all day' : `${event.startLocal?.slice(11, 16)}${event.timeZone && event.timeZone !== zone ? ` ${event.timeZone}` : ''}`;
            return `“${clip(event.title)}” (${day} ${time}, ${event.calendar})`;
        } catch {
            return 'an event';
        }
    };
    const calendarWords = () => {
        try {
            const id = a.calendar_id || manager.defaultCalendarId();
            return id ? manager.calendarName(manager.calendar(id)) : 'the default calendar';
        } catch {
            return 'a calendar';
        }
    };
    const guests = Array.isArray(a.guests) ? a.guests.map((g) => String(g).trim()).filter(Boolean) : [];
    // Without the manager's word on it, the call's own: it says to tell them.
    const told = mail !== undefined ? emailWords(mail) : '';
    switch (name) {
        case 'calendar_create_event': {
            const when = [a.start, a.end].filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => clip(t, 30)).join(' to ');
            const invite = mail === undefined && a.notify_guests === true && guests.length > 0 ? `, and email invitations to ${peopleWords(guests)}` : told;
            return `Add “${clip(a.title)}” (${when}${a.repeat ? ', repeating' : ''}) to ${calendarWords()}${invite}?`;
        }
        case 'calendar_update_event': {
            const fields = ['title', 'start', 'end', 'all_day', 'time_zone', 'location', 'description', 'url', 'repeat', 'reminders', 'guests', 'busy', 'private']
                .filter((k) => a[k] !== undefined && a[k] !== null && !(typeof a[k] === 'string' && a[k].trim() === ''))
                .map((k) => (k === 'guests' ? guestChange(event, guests) : k.replace('_', ' ')));
            const cleared = Array.isArray(a.clear) ? [...new Set(a.clear)].filter((k) => Object.hasOwn(CLEAR_WORDS, k)).map((k) => CLEAR_WORDS[k]) : [];
            const moving = typeof a.calendar_id === 'string' && a.calendar_id.trim() !== ''
                ? ` and move it to ${calendarWords()}${a.drop_changes === true ? ', without its occurrences changed on their own' : ''}` : '';
            const what = fields.length + cleared.length ? `: ${[...fields, ...cleared].join(', ')}` : '';
            const tell = mail === undefined && a.notify_guests === true ? ', and email its guests' : told;
            return `Change ${SCOPE_WORDS[a.scope] ?? ''}${eventWords()}${what}${moving}${tell}?`;
        }
        case 'calendar_delete_event': {
            const tell = mail === undefined && a.notify_guests === true ? ', and tell its guests' : told;
            return `Delete ${SCOPE_WORDS[a.scope] ?? ''}${eventWords()}${tell}?`;
        }
        case 'calendar_respond': {
            const which = a.scope === 'one' ? 'only this occurrence of ' : event?.recurring ? 'every occurrence of ' : '';
            const organizer = event?.organizer?.email;
            const heard = mail === undefined ? '' : mail.to.length > 0 ? ` The answer is sent to the organizer, ${mail.to[0]}.` : ` This calendar doesn't send it to the organizer${organizer ? ` (${organizer})` : ''}.`;
            return `Answer ${which}${eventWords()}: ${clip(a.answer, 20)}?${heard}`;
        }
        default:
            return `Change the calendar (${name})?`;
    }
}

/** A new guest list in words: who it adds and who it takes off. */
function guestChange(event, guests) {
    const had = (event?.attendees ?? []).filter((p) => p.self !== true).map((p) => String(p.email));
    const hadLower = new Set(had.map((e) => e.toLowerCase()));
    const nowLower = new Set(guests.map((e) => e.toLowerCase()));
    const added = guests.filter((e) => !hadLower.has(e.toLowerCase()));
    const removed = had.filter((e) => !nowLower.has(e.toLowerCase()));
    const parts = [...(added.length ? [`adding ${peopleWords(added)}`] : []), ...(removed.length ? [`removing ${peopleWords(removed)}`] : [])];
    return parts.length ? `guests (${parts.join('; ')})` : 'guests';
}

/** The refusal for a change that would ask in a chat that can't. */
function cantAsk(mail) {
    if (mail?.to?.length > 0) {
        return `This would email ${mail.what} to ${peopleWords(mail.to)}, and the user is asked before anything is emailed from their calendars. `
            + 'This chat can\'t ask (its approval prompts are off), so nothing was done. Tell the user what would be sent and to whom; they can do it on the Calendar page or in their calendar app.';
    }
    if (mail?.reaches?.length > 0) {
        return `This would ${REACH_WORDS[mail.reach] ?? 'change it on'} the calendars of ${peopleWords(mail.reaches)} (Google does that without emailing them), and the user is asked before a change reaches other people. `
            + 'This chat can\'t ask (its approval prompts are off), so nothing was done. Tell the user what you would change and who it reaches; they can do it on the Calendar page or in their calendar app.';
    }
    return 'The calendar plugin asks the user before each change, and this chat can\'t ask (its approval prompts are off), so nothing was done. Tell the user what you would change; they can do it on the Calendar page.';
}

/**
 * Who the gate told the user a call's change emails or reaches, kept with
 * the call itself (the ToolExecution DSH hands both the gate and the tool)
 * until its tool runs (take()), which then stops the change rather than
 * email or reach anyone else. Kept as long as the call is, however long a
 * prompt waits, whatever id the provider gave the call.
 */
export class ShownPlans {
    constructor() {
        this.plans = new WeakMap();
    }

    /** Keep who `mail` names for this call; none for a call whose change reaches no one, or that the gate showed nobody for. */
    set(exec, mail) {
        if (exec !== null && typeof exec === 'object') this.plans.set(exec, peopleOf(mail));
    }

    /** The people shown for this call, once; undefined when the gate kept nothing for it. */
    take(exec) {
        if (exec === null || typeof exec !== 'object') return undefined;
        const people = this.plans.get(exec);
        this.plans.delete(exec);
        return people;
    }
}

/**
 * The `tools/pre-execute` gate for the calendar's change tools. Other gates
 * run first; a refusal or a question from them stands.
 * @param {{presets: () => object|undefined, approval?: () => object|undefined, manager: object, mode: () => string,
 *          askEmails?: () => boolean, shown?: ShownPlans, log: (line: string) => void}} deps
 */
export function changeGate({ presets, approval = () => undefined, manager, mode, askEmails = () => true, shown, log }) {
    return async (exec, next) => {
        if (!CHANGE_TOOLS.has(exec?.name)) return next();
        const downstream = await next();
        if (downstream?.kind !== 'allow') {
            // Another gate's question names nobody this change reaches: allowed, it reaches no one.
            if (downstream?.kind === 'ask') shown?.set(exec, undefined);
            return downstream;
        }
        const session = exec.agent?.session;
        const access = accessOf(presets(), session);
        let decision = decide(mode(), access);
        let mail;
        if (typeof decision === 'string') {
            const plan = planOf(manager, exec.name, exec.arguments);
            mail = plan.mail;
            if (plan.refusal !== undefined) decision = { deny: plan.refusal };
            else if (peopleOf(mail).length > 0 && askEmails()) decision = 'ask';
        }
        if (decision === 'ask' && !canAsk(approval(), session)) decision = { deny: cantAsk(mail) };
        log(`policy ${exec.name} access=${access}${mail?.to?.length > 0 ? ` mail=${mail.to.length}` : ''}${mail?.reaches?.length > 0 ? ` reach=${mail.reaches.length}` : ''} ${typeof decision === 'string' ? decision : 'deny'}`);
        // The tool holds the change to who this said it reaches (nobody, when it couldn't tell).
        if (typeof decision === 'string') shown?.set(exec, mail);
        if (decision === 'allow') return { kind: 'allow' };
        if (decision === 'ask') {
            const text = describeChange(manager, exec.name, exec.arguments, mail);
            return { kind: 'ask', reason: `Calendar: ${text}`, displayReason: { en: text } };
        }
        return { kind: 'deny', reason: decision.deny };
    };
}
