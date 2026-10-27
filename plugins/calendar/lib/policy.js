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
import { addDays, dayIn, toLocal } from './zones.js';

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
const CLEAR_SHORT = { location: 'its place', description: 'its notes', url: 'its link', repeat: 'how it repeats' };

const KINDS = { calendar_create_event: 'create', calendar_update_event: 'update', calendar_delete_event: 'delete', calendar_respond: 'respond' };

/**
 * What a call would do, worked out by the very check the tool makes first
 * (manager.planChange): {mail} (who it emails or reaches: manager.mailOf)
 * and {shape} (its times before and after, its calendar: manager.shapeOf),
 * or {refusal}, in the tool's own words, when the tool would refuse it
 * before changing anything. {} when that can't be told here (the tool then
 * decides). Never throws.
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
        const plan = manager.planChange(kind, change);
        return { mail: plan.mail, ...(plan.shape ? { shape: plan.shape } : {}) };
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

// ── Times in words, for the prompt ─────────────────────────────────────
// The prompt is English (its displayReason is `en`), so days and times are
// written as en-US writes them, as the window does in an English browser:
// 'Mon, Nov 2', '10:00 – 10:30 AM'.

const formats = new Map();
function format(options) {
    const key = JSON.stringify(options);
    let f = formats.get(key);
    if (f === undefined) {
        f = new Intl.DateTimeFormat('en-US', options);
        formats.set(key, f);
    }
    return f;
}
/** Intl's narrow and thin spaces as plain ones. */
const plain = (text) => String(text).replace(/[   ]/g, ' ');
/** A day in words: 'Mon, Nov 2', with its year when it isn't `year`. */
const dayWords = (day, year) => plain(format({ weekday: 'short', month: 'short', day: 'numeric', ...(day.slice(0, 4) !== year ? { year: 'numeric' } : {}), timeZone: 'UTC' })
    .format(Date.parse(`${day}T12:00:00Z`)));
/** A clock time from minutes into a day: '9:30 AM'. */
const clockWords = (minutes) => plain(format({ hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(Date.UTC(2000, 0, 3, 0, minutes)));
/** From one clock time to another on a day: '10:00 – 10:30 AM', '11:00 AM – 1:00 PM'; 1440 is the midnight that ends it. */
function clockRange(from, to) {
    if (to === from) return clockWords(from);
    const f = format({ hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    if (to >= 1440 || to < from || typeof f.formatRange !== 'function') return `${clockWords(from)} – ${clockWords(to % 1440)}`;
    return plain(f.formatRange(Date.UTC(2000, 0, 3, 0, from), Date.UTC(2000, 0, 3, 0, to)));
}
/** An instant on a zone's clock: its day, and the minutes into it. */
function wallAt(ms, zone) {
    const local = toLocal(ms, zone);
    return { day: local.slice(0, 10), minutes: Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)) };
}
/** A timed span on one zone's clock: 'Mon, Nov 2, 10:00 – 10:30 AM', or 'Mon, Nov 2, 11:00 PM – Tue, Nov 3, 1:00 AM'; `day` false leaves the day out of a one-day span. */
function clockSpan(start, end, zone, year, day) {
    const a = wallAt(start, zone);
    const b = wallAt(Math.max(start, end), zone);
    const toMidnight = b.minutes === 0 && b.day === addDays(a.day, 1);
    if (a.day === b.day || toMidnight) {
        const range = clockRange(a.minutes, toMidnight ? 1440 : b.minutes);
        return day ? `${dayWords(a.day, year)}, ${range}` : range;
    }
    return `${dayWords(a.day, year)}, ${clockWords(a.minutes)} – ${dayWords(b.day, year)}, ${clockWords(b.minutes)}`;
}
/** A zone by its place: 'Europe/Berlin' is 'Berlin', 'America/New_York' 'New York'. */
const placeOf = (tz) => String(tz).split('/').pop().replace(/_/g, ' ');
/** The zone a span's clock is read on: its own, else the user's. */
const clockZone = (span, zone) => (span.tz && span.tz !== zone ? span.tz : zone);

/**
 * When a span is, on the user's clock: 'Mon, Nov 2, 10:00 – 10:30 AM',
 * 'Tue, Oct 20, all day', 'Tue, Oct 20 – Thu, Oct 22, all day'. An event
 * kept in another zone is said on its own clock first, then the user's:
 * 'Tue, Oct 27, 9:00 – 10:00 AM Berlin time, 1:00 – 2:00 AM your time'
 * (in parentheses with `paren`), the user's day said only when it differs.
 * `day` false leaves out the day the words before said already.
 */
function whenWords(span, zone, year, { day = true, paren = false } = {}) {
    if (span.allDay) {
        const last = span.lastDay ?? span.startDay;
        return `${last !== span.startDay ? `${dayWords(span.startDay, year)} – ${dayWords(last, year)}` : dayWords(span.startDay, year)}, all day`;
    }
    if (!Number.isFinite(span.start) || !Number.isFinite(span.end)) throw new Error('no time');
    const own = clockZone(span, zone);
    if (own === zone) return clockSpan(span.start, span.end, zone, year, day);
    const theirs = `${clockSpan(span.start, span.end, own, year, day)} ${placeOf(own)} time`;
    const mine = `${clockSpan(span.start, span.end, zone, year, wallAt(span.start, zone).day !== wallAt(span.start, own).day)} your time`;
    return paren ? `${theirs} (${mine})` : `${theirs}, ${mine}`;
}

/** Whether a new time starts on the day, and the clock, the old one did, so its words can leave the day out. */
function sameStart(before, after, zone) {
    if (before.allDay || after.allDay) return false;
    const z = clockZone(before, zone);
    return z === clockZone(after, zone) && wallAt(before.start, z).day === wallAt(after.start, z).day;
}

/** An event's view (manager.event) as a span; undefined without its times. */
function viewSpan(event) {
    if (event?.allDay) return event.startDay ? { allDay: true, startDay: event.startDay, lastDay: event.lastDay ?? event.startDay } : undefined;
    return Number.isFinite(event?.start) && Number.isFinite(event?.end) ? { allDay: false, start: event.start, end: event.end, tz: event.timeZone ?? null } : undefined;
}

const listWords = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
/** Minutes before a start in words: '10 minutes', '1 hour', '2 days'. */
const aheadWords = (m) => (m % 1440 === 0 ? plural(m / 1440, 'day') : m % 60 === 0 ? plural(m / 60, 'hour') : plural(m, 'minute'));
/** A reminder list in words: 'reminders 10 minutes and 1 hour before', 'a reminder at the start', 'no reminders'. */
function reminderWords(list) {
    const minutes = [...new Set(list.map(Number).filter((m) => Number.isInteger(m) && m >= 0))].sort((x, y) => x - y);
    if (minutes.length === 0) return 'no reminders';
    const ahead = minutes.filter((m) => m > 0).map(aheadWords);
    const parts = [...(ahead.length ? [`${listWords(ahead)} before`] : []), ...(minutes.includes(0) ? ['at the start'] : [])];
    return `${minutes.length === 1 ? 'a reminder' : 'reminders'} ${parts.join(' and ')}`;
}
const lowerFirst = (text) => (text ? text[0].toLowerCase() + text.slice(1) : text);

/** Which occurrences a change reaches, as words before the event's: a whole series says so. */
function scopeWords(scope, shape, event) {
    const series = shape !== undefined ? shape.series === true : event?.recurring === true;
    if (!series) return '';
    return scope === 'one' || scope === 'following' ? SCOPE_WORDS[scope] : 'every occurrence of ';
}

/**
 * A change in words for the approval prompt: what it does, to which event
 * (or occurrences), where, and who it emails. Times are the change's own,
 * worked out as the change is (planOf's shape): the old and the new, on the
 * user's clock, and on the event's own when it is kept in another zone; a
 * new title, place, reminders or repeat rule says what it will be. `plan`
 * is planOf's (an older caller's mail alone is taken too); without one the
 * words go by the call. Never throws.
 */
export function describeChange(manager, name, args = {}, plan = planOf(manager, name, args)) {
    const a = args !== null && typeof args === 'object' ? args : {};
    const p = plan !== null && typeof plan === 'object' ? (Array.isArray(plan.to) ? { mail: plan } : plan) : {};
    const { mail, shape } = p;
    let zone = 'UTC';
    let year = '';
    try {
        zone = manager.zone();
        year = dayIn(typeof manager.now === 'function' ? manager.now() : Date.now(), zone).slice(0, 4);
    } catch {}
    let event;
    if (name !== 'calendar_create_event') {
        try {
            event = manager.event(String(a.id ?? ''));
        } catch {
            event = undefined;
        }
    }
    const when = (span, options) => {
        try {
            return span ? whenWords(span, zone, year, options) : undefined;
        } catch {
            return undefined;
        }
    };
    const title = shape?.title ?? event?.title;
    const calendar = shape?.calendar ?? event?.calendar;
    const before = shape?.before ?? viewSpan(event);
    /** The event as it is: “Title” (when, calendar). */
    const eventWords = () => {
        if (title === undefined) return 'an event';
        const was = when(before);
        return `“${clip(title)}” (${[was, calendar].filter(Boolean).join(', ')})`;
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
    const given = (k) => a[k] !== undefined && a[k] !== null && !(typeof a[k] === 'string' && a[k].trim() === '');
    /** A time the call gives as it gives it, for a change the plan couldn't work out. */
    const asGiven = (t) => clip(String(t).trim().replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 '), 30);
    // Without the manager's word on it, the call's own: it says to tell them.
    const told = mail !== undefined ? emailWords(mail) : '';
    switch (name) {
        case 'calendar_create_event': {
            const at = when(shape?.after) ?? [a.start, a.end].filter((t) => typeof t === 'string' && t.trim() !== '').map(asGiven).join(' to ');
            const repeat = shape?.repeats ? `, repeating ${lowerFirst(shape.repeats)}` : a.repeat ? ', repeating' : '';
            const invite = mail === undefined && a.notify_guests === true && guests.length > 0 ? `, and email invitations to ${peopleWords(guests)}` : told;
            const inside = `${at}${repeat}`.replace(/^, /, '');
            return `Add “${clip(a.title)}”${inside ? ` (${inside})` : ''} to ${shape?.calendar ?? calendarWords()}${invite}?`;
        }
        case 'calendar_update_event': {
            const scope = scopeWords(a.scope, shape, event);
            const tell = mail === undefined && a.notify_guests === true ? ', and email its guests' : told;
            // A move to another calendar goes alone (the tool refuses one with other changes); the plan says whether it is one.
            if (shape !== undefined ? shape.target !== undefined : given('calendar_id')) {
                const lose = a.drop_changes === true ? ', without its occurrences changed on their own' : '';
                const to = shape?.target ?? calendarWords();
                if (title === undefined) return `Move an event to ${to}${lose}${tell}?`;
                const was = when(before);
                return `Move ${scope}“${clip(title)}”${was ? ` (${was})` : ''}${calendar ? ` from ${calendar}` : ''} to ${to}${lose}${tell}?`;
            }
            const timed = ['start', 'end', 'all_day', 'time_zone'].some(given);
            const after = timed ? shape?.after : undefined;
            const newTime = (options) => (after && before ? when(after, { ...options, day: !sameStart(before, after, zone) }) : undefined);
            // The plan couldn't work the new time out: the call's own words for it.
            const asked = `a new time (${[...(given('start') ? [`start ${asGiven(a.start)}`] : []), ...(given('end') ? [`end ${asGiven(a.end)}`] : []),
                ...(typeof a.all_day === 'boolean' ? [a.all_day ? 'all day' : 'not all day'] : []), ...(given('time_zone') ? [`in ${clip(a.time_zone, 40)} time`] : [])].join(', ')})`;
            const renamed = given('title') ? clip(shape?.newTitle ?? a.title) : undefined;
            // Each other change: what it will be, and a short name for it past the third.
            const others = [];
            if (Array.isArray(a.guests)) others.push([guestChange(event, guests), 'its guests']);
            if (given('location')) others.push([`set the place to “${clip(a.location, 40)}”`, 'its place']);
            if (given('description')) others.push(['new notes', 'its notes']);
            if (given('url')) others.push([`set the link to ${clip(a.url, 60)}`, 'its link']);
            if (given('repeat')) others.push([shape?.repeats ? `repeat ${lowerFirst(shape.repeats)}` : 'a new repeat rule', 'how it repeats']);
            if (Array.isArray(a.reminders)) others.push([reminderWords(a.reminders), 'its reminders']);
            if (typeof a.busy === 'boolean') others.push([a.busy ? 'show as busy' : 'show as free', 'busy or free']);
            if (typeof a.private === 'boolean') others.push([a.private ? 'make it private' : 'make it public', 'its privacy']);
            const cleared = Array.isArray(a.clear) ? [...new Set(a.clear)].filter((k) => Object.hasOwn(CLEAR_WORDS, k) && !given(k)) : [];
            for (const k of cleared) others.push([CLEAR_WORDS[k], CLEAR_SHORT[k]]);
            if (timed && renamed === undefined && others.length === 0) {
                // A new time alone: from when to when.
                const to = newTime({ paren: true });
                if (to !== undefined && title !== undefined) {
                    return `Move ${scope}“${clip(title)}”${calendar ? ` (${calendar})` : ''} from ${when(before, { paren: true })} to ${to}${tell}?`;
                }
                return `Change ${scope}${eventWords()}: ${asked}${tell}?`;
            }
            if (renamed !== undefined && !timed && others.length === 0) return `Rename ${scope}${eventWords()} to “${renamed}”${tell}?`;
            const list = [
                ...(timed ? [[newTime() !== undefined ? `move it to ${newTime()}` : asked, 'its time']] : []),
                ...(renamed !== undefined ? [[`rename it “${renamed}”`, 'its title']] : []),
                ...others,
            ];
            // Short past three: the first three in full, the rest by name.
            const shown = list.length > 3 ? [...list.slice(0, 3).map(([full]) => full), `and also ${listWords(list.slice(3).map(([, short]) => short))}`] : list.map(([full]) => full);
            return `Change ${scope}${eventWords()}${shown.length ? `: ${shown.join('; ')}` : ''}${tell}?`;
        }
        case 'calendar_delete_event': {
            const tell = mail === undefined && a.notify_guests === true ? ', and tell its guests' : told;
            return `Delete ${scopeWords(a.scope, shape, event)}${eventWords()}${tell}?`;
        }
        case 'calendar_respond': {
            const which = scopeWords(a.scope === 'following' ? 'all' : a.scope, shape, event);
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
    return parts.length ? `guests (${parts.join('; ')})` : 'the same guests';
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
        let plan;
        if (typeof decision === 'string') {
            plan = planOf(manager, exec.name, exec.arguments);
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
            const text = describeChange(manager, exec.name, exec.arguments, plan ?? {});
            return { kind: 'ask', reason: `Calendar: ${text}`, displayReason: { en: text } };
        }
        return { kind: 'deny', reason: decision.deny };
    };
}
