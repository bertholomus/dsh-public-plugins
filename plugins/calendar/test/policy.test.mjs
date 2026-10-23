/**
 * The write rules for agents (lib/policy.js), without DSH: which access
 * each permission preset gives, the decision for each setting, the words
 * DSH's approval prompt shows, and the pre-execute gate's answers.
 *
 *   node --test plugins/calendar/test/policy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_TOOLS, MODES, ShownPlans, accessOf, canAsk, changeGate, decide, describeChange, planOf } from '../lib/policy.js';
import { CalendarError } from '../lib/manager.js';

/** DSH's permission presets, as the plugin sees them: the session's preset by name, and what a name means. */
function presetsWith(name, { throws = false } = {}) {
    const sandboxes = { 'read-only': 'read-only', 'workspace-write': 'workspace-write', 'danger-full-access': 'danger-full-access' };
    return {
        current(session) {
            if (throws) throw new Error('no presets here');
            return session?.preset ?? name;
        },
        resolve(preset) {
            if (!(preset in sandboxes)) throw new Error(`unknown preset ${preset}`);
            return { sandbox: sandboxes[preset], approval: preset === 'danger-full-access' ? 'never' : 'on-request' };
        },
    };
}

/** What describeChange reads from the manager: an event by id, the user's zone and the calendars. */
const manager = {
    event(id) {
        const events = {
            haircut: { title: 'Haircut', allDay: false, startLocal: '2026-10-16T17:00', timeZone: null, calendar: 'Personal' },
            standup: { title: 'Standup', allDay: false, startLocal: '2026-10-19T09:30', timeZone: 'America/New_York', calendar: 'Work' },
            trip: { title: 'Trip', allDay: true, startDay: '2026-10-20', calendar: 'Personal' },
            long: { title: `A very long title ${'x'.repeat(200)}`, allDay: false, startLocal: '2026-10-16T08:00', timeZone: 'Europe/Berlin', calendar: 'Personal' },
        };
        if (!(id in events)) throw new Error('no such event');
        return events[id];
    },
    zone: () => 'Europe/Berlin',
    defaultCalendarId: () => 'personal',
    calendar(id) {
        if (id !== 'personal' && id !== 'work') throw new Error('no such calendar');
        return { id, name: id === 'personal' ? 'Personal' : 'Work' };
    },
    calendarName: (calendar) => calendar.name,
};

test('policy: the settings and the tools that change calendars', () => {
    assert.deepEqual(MODES, ['preset', 'ask', 'off']);
    assert.deepEqual([...CHANGE_TOOLS].sort(), ['calendar_create_event', 'calendar_delete_event', 'calendar_respond', 'calendar_update_event']);
    for (const reading of ['calendar_events', 'calendar_search', 'calendar_get_event', 'calendar_free_time', 'calendar_list_calendars']) {
        assert.equal(CHANGE_TOOLS.has(reading), false, reading);
    }
});

test('policy: access from the session\'s permission preset', () => {
    const session = {};
    assert.equal(accessOf(presetsWith('read-only'), session), 'read-only');
    assert.equal(accessOf(presetsWith('workspace-write'), session), 'workspace-write');
    assert.equal(accessOf(presetsWith('danger-full-access'), session), 'danger-full-access');
    assert.equal(accessOf(presetsWith('auto'), session), 'auto');
    // A custom mix, a preset the plugin doesn't know, no presets or no session: unknown (asks).
    assert.equal(accessOf(presetsWith('custom'), session), 'unknown');
    assert.equal(accessOf(presetsWith('team-preset'), session), 'unknown');
    assert.equal(accessOf(presetsWith('read-only', { throws: true }), session), 'unknown');
    assert.equal(accessOf(undefined, session), 'unknown');
    assert.equal(accessOf(presetsWith('read-only'), undefined), 'unknown');
    assert.equal(accessOf({ current: () => 42, resolve: () => ({}) }, session), 'unknown');
    assert.equal(accessOf({ current: () => 'workspace-write', resolve: () => undefined }, session), 'unknown');
});

test('policy: the decision for each setting and access', () => {
    const accesses = ['read-only', 'workspace-write', 'danger-full-access', 'auto', 'unknown'];
    const expected = {
        preset: { 'read-only': 'deny', 'workspace-write': 'ask', 'danger-full-access': 'allow', auto: 'allow', unknown: 'ask' },
        ask: { 'read-only': 'ask', 'workspace-write': 'ask', 'danger-full-access': 'ask', auto: 'ask', unknown: 'ask' },
        off: { 'read-only': 'deny', 'workspace-write': 'deny', 'danger-full-access': 'deny', auto: 'deny', unknown: 'deny' },
    };
    for (const mode of MODES) {
        for (const access of accesses) {
            const decision = decide(mode, access);
            const kind = typeof decision === 'string' ? decision : 'deny';
            assert.equal(kind, expected[mode][access], `${mode} / ${access}`);
            if (kind === 'deny') assert.match(decision.deny, /Calendar page/, 'a refusal says where the user can make the change');
        }
    }
    assert.match(decide('preset', 'read-only').deny, /Read Only/);
    assert.match(decide('off', 'danger-full-access').deny, /switched off/);
});

test('policy: the approval prompt says what would change', () => {
    assert.equal(describeChange(manager, 'calendar_create_event', { title: 'Dentist', start: '2026-10-14 09:00', end: '2026-10-14 10:00' }),
        'Add “Dentist” (2026-10-14 09:00 to 2026-10-14 10:00) to Personal?');
    // A manager that can't say who'd be emailed: the call's own guests.
    assert.equal(describeChange(manager, 'calendar_create_event', { title: 'Review', start: 'tomorrow 15:00', repeat: 'FREQ=WEEKLY', calendar_id: 'work', guests: ['a@example.com', 'b@example.com'], notify_guests: true }),
        'Add “Review” (tomorrow 15:00, repeating) to Work, and email invitations to a@example.com and b@example.com?');
    // Guests without notify_guests: nobody is emailed, so the prompt doesn't say so.
    assert.equal(describeChange(manager, 'calendar_create_event', { title: 'Lunch', start: '2026-10-14 12:00', guests: ['a@example.com'] }),
        'Add “Lunch” (2026-10-14 12:00) to Personal?');
    assert.equal(describeChange(manager, 'calendar_create_event', { title: 'Lunch', start: '2026-10-14 12:00', guests: ['a@example.com'], notify_guests: true }),
        'Add “Lunch” (2026-10-14 12:00) to Personal, and email invitations to a@example.com?');
    assert.equal(describeChange(manager, 'calendar_create_event', { title: 'X', start: '2026-10-14', calendar_id: 'gone' }),
        'Add “X” (2026-10-14) to a calendar?');

    assert.equal(describeChange(manager, 'calendar_update_event', { id: 'haircut', start: '2026-10-16 18:00', end: '2026-10-16 19:00' }),
        'Change “Haircut” (2026-10-16 17:00, Personal): start, end?');
    assert.equal(describeChange(manager, 'calendar_update_event', { id: 'standup', scope: 'one', title: 'Standup (moved)', time_zone: 'Europe/Berlin' }),
        'Change only this occurrence of “Standup” (2026-10-19 09:30 America/New_York, Work): title, time zone?');
    assert.equal(describeChange(manager, 'calendar_update_event', { id: 'standup', scope: 'following', clear: ['repeat'] }),
        'Change this and the following occurrences of “Standup” (2026-10-19 09:30 America/New_York, Work): stop repeating?');
    // Empty strings change nothing (some models send every field); `clear` empties one.
    assert.equal(describeChange(manager, 'calendar_update_event', { id: 'haircut', title: '', location: '', repeat: '', end: '2026-10-16 18:30', clear: ['location', 'url', 'location', 'toString'] }),
        'Change “Haircut” (2026-10-16 17:00, Personal): end, no place, no link?');
    assert.equal(describeChange(manager, 'calendar_update_event', { id: 'trip', calendar_id: 'work', location: '' }),
        'Change “Trip” (2026-10-20 all day, Personal) and move it to Work?');
    const long = describeChange(manager, 'calendar_update_event', { id: 'long', description: 'more' });
    assert.ok(long.length < 140, 'a long title is cut short');
    assert.match(long, /^Change “A very long title x+…” \(2026-10-16 08:00, Personal\): description\?$/);

    assert.equal(describeChange(manager, 'calendar_delete_event', { id: 'haircut' }), 'Delete “Haircut” (2026-10-16 17:00, Personal)?');
    assert.equal(describeChange(manager, 'calendar_delete_event', { id: 'standup', scope: 'all', notify_guests: true }),
        'Delete “Standup” (2026-10-19 09:30 America/New_York, Work), and tell its guests?');
    assert.equal(describeChange(manager, 'calendar_delete_event', { id: 'nope' }), 'Delete an event?');
    assert.equal(describeChange(manager, 'calendar_respond', { id: 'standup', answer: 'declined' }),
        'Answer “Standup” (2026-10-19 09:30 America/New_York, Work): declined?');
    // Arguments that aren't an object never break the prompt.
    assert.equal(describeChange(manager, 'calendar_delete_event', null), 'Delete an event?');
    assert.equal(describeChange(manager, 'calendar_something', {}), 'Change the calendar (calendar_something)?');
});

test('policy: the gate before each tool runs', async () => {
    const lines = [];
    const gate = (preset, mode = 'preset') => changeGate({
        presets: () => presetsWith(preset),
        manager,
        mode: () => mode,
        log: (line) => lines.push(line),
    });
    const allow = async () => ({ kind: 'allow' });
    const call = (name, args = {}) => ({ name, arguments: args, agent: { session: {} } });

    // Reading tools and other plugins' tools pass straight through.
    let reached = 0;
    const counted = async () => { reached++; return { kind: 'allow' }; };
    assert.deepEqual(await gate('read-only')(call('calendar_events'), counted), { kind: 'allow' });
    assert.deepEqual(await gate('read-only')(call('shell'), counted), { kind: 'allow' });
    assert.equal(reached, 2);
    assert.equal(lines.length, 0);

    // A refusal or a question from another gate stands.
    const denied = { kind: 'deny', reason: 'another gate said no' };
    assert.deepEqual(await gate('danger-full-access')(call('calendar_delete_event', { id: 'haircut' }), async () => denied), denied);
    const asked = { kind: 'ask', reason: 'another gate asks' };
    assert.deepEqual(await gate('danger-full-access')(call('calendar_delete_event', { id: 'haircut' }), async () => asked), asked);

    assert.deepEqual(await gate('danger-full-access')(call('calendar_create_event', { title: 'A', start: '2026-10-14 09:00' }), allow), { kind: 'allow' });
    assert.deepEqual(await gate('auto')(call('calendar_create_event', { title: 'A', start: '2026-10-14 09:00' }), allow), { kind: 'allow' });

    const refused = await gate('read-only')(call('calendar_update_event', { id: 'haircut', title: 'B' }), allow);
    assert.equal(refused.kind, 'deny');
    assert.match(refused.reason, /Read Only/);

    const question = await gate('workspace-write')(call('calendar_delete_event', { id: 'haircut' }), allow);
    assert.deepEqual(question, {
        kind: 'ask',
        reason: 'Calendar: Delete “Haircut” (2026-10-16 17:00, Personal)?',
        displayReason: { en: 'Delete “Haircut” (2026-10-16 17:00, Personal)?' },
    });

    const off = await gate('danger-full-access', 'off')(call('calendar_respond', { id: 'standup', answer: 'accepted' }), allow);
    assert.equal(off.kind, 'deny');
    assert.match(off.reason, /switched off/);
    assert.equal((await gate('danger-full-access', 'ask')(call('calendar_respond', { id: 'standup', answer: 'accepted' }), allow)).kind, 'ask');

    // A session the presets can't place asks.
    const unplaced = changeGate({ presets: () => undefined, manager, mode: () => 'preset', log: (line) => lines.push(line) });
    assert.equal((await unplaced(call('calendar_create_event', { title: 'A', start: '2026-10-14' }), allow)).kind, 'ask');

    // The log has the tool, the access and the decision: no titles, no arguments.
    assert.deepEqual(lines, [
        'policy calendar_create_event access=danger-full-access allow',
        'policy calendar_create_event access=auto allow',
        'policy calendar_update_event access=read-only deny',
        'policy calendar_delete_event access=workspace-write ask',
        'policy calendar_respond access=danger-full-access deny',
        'policy calendar_respond access=danger-full-access ask',
        'policy calendar_create_event access=unknown ask',
    ]);
});

/**
 * A manager that says who a change would email (planChange, as manager.js
 * works it out, refusing what the change would refuse) for a few events: a
 * meeting the user organizes on a server that emails its guests, someone
 * else's invitation, and a repeating one.
 */
function mailingManager() {
    const events = {
        sync: { title: 'Team sync', allDay: false, startLocal: '2026-10-16T10:00', timeZone: 'Europe/Berlin', calendar: 'Work',
            attendees: [{ email: 'me@example.com', self: true }, { email: 'ann@example.com' }, { email: 'bob@example.com' }, { email: 'cy@example.com' }] },
        board: { title: 'Board review', allDay: false, startLocal: '2026-10-16T09:00', timeZone: 'Europe/Berlin', calendar: 'Work', invitation: true,
            organizer: { email: 'boss@example.com' }, attendees: [{ email: 'me@example.com', self: true }] },
        weekly: { title: 'Weekly', allDay: false, startLocal: '2026-10-19T09:00', timeZone: 'Europe/Berlin', calendar: 'Work', recurring: true,
            organizer: { email: 'boss@example.com' } },
    };
    const people = ['ann@example.com', 'bob@example.com', 'cy@example.com'];
    const asked = [];
    const mailOf = (kind, change) => {
        if (kind === 'respond') return change.id.startsWith('weekly') || change.id === 'board' ? { to: ['boss@example.com'], what: 'the answer', forced: true } : { to: [], what: '', forced: false };
        if (change.id === 'board') return { to: [], what: '', forced: false };
        if (kind === 'create') {
            if (!change.input.attendees?.length) return { to: [], what: '', forced: false };
            // A Google calendar: guests are emailed only when told, and put on their calendars either way.
            if (change.input.calendarId === 'google') return change.notify ? { to: change.input.attendees, what: 'invitations', forced: false } : { to: [], what: '', forced: false, reaches: change.input.attendees, reach: 'add' };
            return { to: change.input.attendees, what: 'invitations', forced: true, why: 'Microsoft invites the guests as soon as an event with them is saved' };
        }
        if (kind === 'update' && Object.keys(change.input).every((k) => k === 'alarms' || k === 'notify')) return { to: [], what: '', forced: false };
        const list = kind === 'update' && change.input.attendees ? [...new Set([...people, ...change.input.attendees])] : people;
        return { to: list, what: kind === 'delete' ? 'a cancellation' : 'an update', forced: true, why: 'this calendar\'s server emails a meeting\'s guests itself' };
    };
    return {
        asked,
        event(id) {
            const key = String(id).split('.')[0];
            if (!(key in events)) throw new CalendarError(`There is no event "${id}".`);
            return events[key];
        },
        locate(id) {
            const key = String(id).split('.')[0];
            if (!(key in events)) throw new CalendarError(`There is no event "${id}".`);
            const repeating = key === 'weekly';
            return { series: repeating, instance: false, recurrenceId: repeating && String(id).includes('.') ? { local: '2026-10-19T09:00:00', tz: 'Europe/Berlin' } : undefined };
        },
        zone: () => 'Europe/Berlin',
        defaultCalendarId: () => 'work',
        calendar: (id) => ({ id, name: 'Work' }),
        calendarName: (calendar) => calendar.name,
        planChange(kind, change) {
            asked.push({ kind, ...change });
            const mail = mailOf(kind, change);
            if (kind !== 'respond' && mail.forced && change.notify !== true) {
                throw new CalendarError(`This would email ${mail.what} to ${mail.to.join(', ')} (${mail.why}), so it's made only when they are to be told.`, 'needs-notify');
            }
            return { mail };
        },
    };
}

test('policy: the approval prompt names who a change emails', () => {
    const m = mailingManager();
    assert.equal(describeChange(m, 'calendar_update_event', { id: 'sync', start: '2026-10-16 11:00', notify_guests: true }),
        'Change “Team sync” (2026-10-16 10:00, Work): start, and email an update to ann@example.com, bob@example.com and cy@example.com?');
    assert.equal(describeChange(m, 'calendar_update_event', { id: 'sync', guests: ['ann@example.com', 'dee@example.com'], notify_guests: true }),
        'Change “Team sync” (2026-10-16 10:00, Work): guests (adding dee@example.com; removing bob@example.com and cy@example.com), and email an update to ann@example.com, bob@example.com, cy@example.com and dee@example.com?');
    assert.equal(describeChange(m, 'calendar_delete_event', { id: 'sync', notify_guests: true }),
        'Delete “Team sync” (2026-10-16 10:00, Work), and email a cancellation to ann@example.com, bob@example.com and cy@example.com?');
    const crowd = Array.from({ length: 8 }, (_, i) => `p${i + 1}@example.com`);
    assert.equal(describeChange(m, 'calendar_create_event', { title: 'All hands', start: '2026-10-20 15:00', guests: crowd, notify_guests: true }),
        'Add “All hands” (2026-10-20 15:00) to Work, and email invitations to p1@example.com, p2@example.com, p3@example.com, p4@example.com, p5@example.com and 3 more?');
    // Answers: which occurrences, and whether the organizer hears it.
    assert.equal(describeChange(m, 'calendar_respond', { id: 'board', answer: 'accepted' }),
        'Answer “Board review” (2026-10-16 09:00, Work): accepted? The answer is sent to the organizer, boss@example.com.');
    assert.equal(describeChange(m, 'calendar_respond', { id: 'weekly.20261019T090000', answer: 'declined', scope: 'one' }),
        'Answer only this occurrence of “Weekly” (2026-10-19 09:00, Work): declined? The answer is sent to the organizer, boss@example.com.');
    assert.equal(describeChange(m, 'calendar_respond', { id: 'weekly.20261019T090000', answer: 'declined', scope: 'all' }),
        'Answer every occurrence of “Weekly” (2026-10-19 09:00, Work): declined? The answer is sent to the organizer, boss@example.com.');
    assert.equal(describeChange(m, 'calendar_respond', { id: 'sync', answer: 'accepted' }),
        'Answer “Team sync” (2026-10-16 10:00, Work): accepted? This calendar doesn\'t send it to the organizer.');
});

test('policy: what the gate refuses before anyone is asked', () => {
    const m = mailingManager();
    // A change the server would email the guests about, without notify_guests: the tool would refuse it.
    const plan = planOf(m, 'calendar_update_event', { id: 'sync', title: 'Sync' });
    assert.match(plan.refusal, /^Not done: This would email an update to ann@example\.com, bob@example\.com, cy@example\.com \(this calendar's server emails a meeting's guests itself\), so it's made only when they are to be told\. If the user asked for them to be told, call again with notify_guests: true; otherwise ask the user first\.$/);
    // A repeating event's occurrence without a scope, and an event that isn't there.
    assert.match(planOf(m, 'calendar_delete_event', { id: 'weekly.20261019T090000' }).refusal, /^Not done: This event repeats: say scope "one"/);
    assert.match(planOf(m, 'calendar_respond', { id: 'weekly.20261019T090000', answer: 'accepted', scope: 'following' }).refusal, /say scope "one" \(this occurrence\) or "all" \(the series\)/);
    assert.match(planOf(m, 'calendar_delete_event', { id: 'gone' }).refusal, /^Not done: There is no event "gone"\.$/);
    // `clear` and the times read as the tool reads them.
    planOf(m, 'calendar_update_event', { id: 'sync', clear: ['location', 'nonsense'], start: '2026-10-16 11:00', notify_guests: true });
    assert.deepEqual(m.asked.at(-1).input.location, null);
    assert.equal(Object.hasOwn(m.asked.at(-1).input, 'nonsense'), false);
    assert.match(m.asked.at(-1).input.start, /^2026-10-16T11:00(?::00)?\+02:00$/);
    assert.equal(m.asked.at(-1).notify, true);
    // Reading tools, and a manager that can't tell: nothing to plan.
    assert.deepEqual(planOf(m, 'calendar_events', {}), {});
    assert.deepEqual(planOf(manager, 'calendar_delete_event', { id: 'haircut' }), {});
});

test('policy: a change that emails someone asks first, and a chat that can\'t ask is refused', async () => {
    const lines = [];
    const never = { effectivePolicy: () => 'never' };
    const asks = { effectivePolicy: () => 'ask' };
    const gate = (preset, { approval, mode = 'preset', askEmails = true } = {}) => changeGate({
        presets: () => presetsWith(preset),
        approval: () => approval,
        manager: mailingManager(),
        mode: () => mode,
        askEmails: () => askEmails,
        log: (line) => lines.push(line),
    });
    const allow = async () => ({ kind: 'allow' });
    const call = (name, args = {}) => ({ name, arguments: args, agent: { session: {} } });
    const tell = { id: 'sync', start: '2026-10-16 11:00', notify_guests: true };

    // Full access: no prompt can be shown, so the change is refused with what it would have sent.
    const full = await gate('danger-full-access', { approval: never })(call('calendar_update_event', tell), allow);
    assert.equal(full.kind, 'deny');
    assert.match(full.reason, /^This would email an update to ann@example\.com, bob@example\.com and cy@example\.com, and the user is asked before anything is emailed from their calendars\. This chat can't ask \(its approval prompts are off\), so nothing was done\./);
    // Auto and Workspace Write ask, naming who gets what.
    const auto = await gate('auto', { approval: asks })(call('calendar_update_event', tell), allow);
    assert.deepEqual(auto, {
        kind: 'ask',
        reason: 'Calendar: Change “Team sync” (2026-10-16 10:00, Work): start, and email an update to ann@example.com, bob@example.com and cy@example.com?',
        displayReason: { en: 'Change “Team sync” (2026-10-16 10:00, Work): start, and email an update to ann@example.com, bob@example.com and cy@example.com?' },
    });
    assert.equal((await gate('workspace-write', { approval: asks })(call('calendar_delete_event', { id: 'sync', notify_guests: true }), allow)).kind, 'ask');
    // An answer emails the organizer: asked too.
    assert.equal((await gate('danger-full-access', { approval: asks })(call('calendar_respond', { id: 'board', answer: 'accepted' }), allow)).kind, 'ask');
    // Nobody emailed: Full access goes ahead as before.
    assert.deepEqual(await gate('danger-full-access', { approval: never })(call('calendar_update_event', { id: 'sync', reminders: [10] }), allow), { kind: 'allow' });
    assert.deepEqual(await gate('danger-full-access', { approval: never })(call('calendar_delete_event', { id: 'board' }), allow), { kind: 'allow' });
    // askBeforeEmails off: emailing changes follow the chat's permission like any other.
    assert.deepEqual(await gate('danger-full-access', { approval: never, askEmails: false })(call('calendar_update_event', tell), allow), { kind: 'allow' });
    // What the tool would refuse is refused here, even where the chat would have been asked.
    const missing = await gate('workspace-write', { approval: asks })(call('calendar_update_event', { id: 'sync', title: 'Sync' }), allow);
    assert.equal(missing.kind, 'deny');
    assert.match(missing.reason, /call again with notify_guests: true/);
    // 'ask' on a chat that can't ask: refused with why, not taken for the user's no.
    const cant = await gate('danger-full-access', { approval: never, mode: 'ask' })(call('calendar_update_event', { id: 'sync', reminders: [5] }), allow);
    assert.equal(cant.kind, 'deny');
    assert.match(cant.reason, /asks the user before each change, and this chat can't ask/);
    // Read Only and off still come first.
    assert.match((await gate('read-only', { approval: asks })(call('calendar_update_event', tell), allow)).reason, /Read Only/);

    assert.deepEqual(lines, [
        'policy calendar_update_event access=danger-full-access mail=3 deny',
        'policy calendar_update_event access=auto mail=3 ask',
        'policy calendar_delete_event access=workspace-write mail=3 ask',
        'policy calendar_respond access=danger-full-access mail=1 ask',
        'policy calendar_update_event access=danger-full-access allow',
        'policy calendar_delete_event access=danger-full-access allow',
        'policy calendar_update_event access=danger-full-access mail=3 allow',
        'policy calendar_update_event access=workspace-write deny',
        'policy calendar_update_event access=danger-full-access deny',
        'policy calendar_update_event access=read-only deny',
    ]);
    assert.ok(lines.every((l) => !/@/.test(l)), 'the log has counts, never addresses');
});

test('policy: whether the chat can ask', () => {
    assert.equal(canAsk({ effectivePolicy: () => 'never' }, {}), false);
    assert.equal(canAsk({ effectivePolicy: () => 'ask' }, {}), true);
    // No approval service, or one that fails: the ask goes to DSH, which decides.
    assert.equal(canAsk(undefined, {}), true);
    assert.equal(canAsk({ effectivePolicy: () => { throw new Error('x'); } }, {}), true);
});

test('policy: who the gate named goes with the call itself to its tool, once; a refused call names no one', async () => {
    const shown = new ShownPlans();
    const gate = (preset, approval) => changeGate({
        presets: () => presetsWith(preset), approval: () => approval, manager: mailingManager(), mode: () => 'preset', shown, log: () => {},
    });
    const allow = async () => ({ kind: 'allow' });
    const asks = { effectivePolicy: () => 'ask' };
    const call = (callId, name, args) => ({ callId, name, arguments: args, agent: { session: {} } });
    const c1 = call('c1', 'calendar_update_event', { id: 'sync', start: '2026-10-16 11:00', notify_guests: true });
    assert.equal((await gate('workspace-write', asks)(c1, allow)).kind, 'ask');
    // Kept with the call, not its id: another call with the same id (or none) gets nothing.
    assert.equal(shown.take({ ...c1 }), undefined);
    assert.deepEqual(shown.take(c1), ['ann@example.com', 'bob@example.com', 'cy@example.com']);
    assert.equal(shown.take(c1), undefined, 'once');
    // A provider that sends no call id: the list still goes with the call.
    const bare = call('', 'calendar_delete_event', { id: 'sync', notify_guests: true });
    await gate('workspace-write', asks)(bare, allow);
    assert.equal(shown.take(bare).length, 3);
    // Nobody to tell: an empty list, which holds the change to nobody.
    const c2 = call('c2', 'calendar_update_event', { id: 'sync', reminders: [10] });
    assert.equal((await gate('danger-full-access', asks)(c2, allow)).kind, 'allow');
    assert.deepEqual(shown.take(c2), []);
    // Refused: nothing kept.
    const c3 = call('c3', 'calendar_update_event', { id: 'sync', title: 'Sync' });
    assert.equal((await gate('workspace-write', asks)(c3, allow)).kind, 'deny');
    assert.equal(shown.take(c3), undefined);
    // Another gate's question names no one this change reaches: allowed, the change reaches no one.
    const c4 = call('c4', 'calendar_delete_event', { id: 'sync', notify_guests: true });
    const theirs = { kind: 'ask', reason: 'Another gate asks.' };
    assert.deepEqual(await gate('workspace-write', asks)(c4, async () => theirs), theirs);
    assert.deepEqual(shown.take(c4), []);
});
