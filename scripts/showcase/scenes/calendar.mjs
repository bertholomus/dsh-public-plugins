/**
 * Calendar: a week of work and personal events kept in DSH, a chat that
 * finds an hour for the retro and asks before it books it (DSH's prompt
 * saying what the change does), the week with the retro, and the month.
 */
import { demoTimezone, waitFor } from '../stage.mjs';

/** The day `n` days after `day` (YYYY-MM-DD). */
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** 0 for Sunday to 6 for Saturday. */
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

export default async function calendar(scene) {
    const zone = demoTimezone();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    // The day the chat books: the next weekday after today.
    let day = addDays(today, 1);
    while (weekday(day) === 0 || weekday(day) === 6) day = addDays(day, 1);
    const dayName = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const monday = addDays(day, -((weekday(day) + 6) % 7));

    const run = await scene.start({
        plugins: ['calendar'],
        env: { TZ: zone },
        vars: { day, dayName },
        rows: `- id: calendar
  config:
    timeZone: ${zone}
`,
    });
    const api = (method, args) => scene.api(`dsh-plugin-calendar/${method}`, args);
    const state = await waitFor(async () => {
        const s = await api('state');
        return s?.calendars?.length ? s : null;
    }, 'the calendar store', 30000, 300);
    const personal = state.calendars.find((c) => c.accountId === 'local');
    // Work, the calendar new events go to.
    const work = (await api('createCalendar', { name: 'Work' })).calendar;
    await api('setDefaultCalendar', { id: work.id });
    const add = (calendarId, title, date, from, to, more = {}) => api('createEvent', { input: { calendarId, title, start: `${date}T${from}`, end: `${date}T${to}`, timeZone: zone, ...more } });

    // The standup since five weeks ago, so the month has the weeks before this one too.
    await add(work.id, 'Standup', addDays(monday, -35), '09:30', '09:45', { repeat: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' });
    const before = [
        [-28, work, 'Sprint planning', '10:00', '11:00'], [-25, personal, 'Book club', '19:00', '20:30'],
        [-21, work, 'Gateway 2.3 release', '11:00', '12:00'], [-19, personal, 'Haircut', '17:30', '18:00'],
        [-17, work, 'Ledger audit prep', '14:00', '15:30'], [-14, work, 'Sprint planning', '10:00', '11:00'],
        [-12, personal, 'Yoga', '07:30', '08:30'], [-11, work, 'Docs review', '15:00', '16:00'],
        [-7, work, 'Rate limit design', '13:00', '14:00'], [-5, personal, 'Book club', '19:00', '20:30'],
        [-3, work, 'Ledger month-end prep', '14:00', '15:00'], [-2, personal, 'Hike', '09:00', '12:00'],
    ];
    for (const [days, cal, title, from, to] of before) await add(cal.id, title, addDays(monday, days), from, to);
    const week = [
        [work, 'Gateway 2.4 planning', '11:00', '12:00'], [personal, 'Gym', '18:00', '19:00'],
        [work, 'Ledger month-end review', '14:00', '15:00'], [personal, 'Lunch with the team', '12:30', '13:30'],
        [work, 'Handbook writing', '10:00', '11:30'], [work, 'Design review: rate limits', '15:00', '16:00'],
        [work, 'Incident review', '11:00', '11:45'], [personal, 'Dentist', '16:30', '17:30'],
    ];
    // Two events on each weekday but the one the chat books on, which has its own.
    let next = 0;
    for (let i = 0; i < 5; i += 1) {
        const date = addDays(monday, i);
        if (date === day) continue;
        for (const [cal, title, from, to] of week.slice(next, next + 2)) await add(cal.id, title, date, from, to);
        next += 2;
    }
    await add(work.id, 'Release 2.4', day, '11:00', '12:00');
    await add(personal.id, 'Lunch', day, '12:00', '13:00');
    await add(work.id, '1:1', day, '14:00', '14:30');
    await add(personal.id, 'Farmers market', addDays(monday, 5), '09:00', '10:30');

    // The chat asks before it adds the event (Workspace Write), in the open window: the prompt says what the change does.
    const page = await scene.open({ entry: 'Calendar', timezoneId: zone });
    const chat = await run.newSession({ project: 'harbor-gateway', title: 'Retro slot', prompt: scene.say('Find an hour on') });
    const row = page.locator(`[data-row-key="session:${chat}"]`).first();
    // The workspace came after the window: its folder in the session list opens to show the chat.
    if (!(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) {
        await page.locator('[data-slot="sidebar.workspaces"]').getByText('harbor-gateway', { exact: true }).first().click();
    }
    await row.click();
    const allow = page.getByRole('button', { name: 'Allow once' }).filter({ visible: true }).first();
    await allow.waitFor({ state: 'visible', timeout: 60000 });
    await scene.shoot('approval', { themes: ['dark'] });
    await allow.click();
    await run.idle(chat);

    await page.getByRole('button', { name: 'Calendar', exact: true }).first().click();
    await page.locator('[data-calendar-page]').waitFor({ state: 'visible' });
    await page.locator('[data-calendar-view="week"]').click();
    await page.locator('[data-calendar-grid="week"]').waitFor({ state: 'visible' });
    // The week of the booked day (the next one, when today is a Friday or the weekend).
    if (await page.locator(`[data-calendar-day-column="${day}"]`).count() === 0) await page.keyboard.press('n');
    await page.locator(`[data-calendar-day-column="${day}"]`).waitFor({ state: 'visible' });
    await page.locator('[data-calendar-event]', { hasText: 'Gateway 2.4 retro' }).first().waitFor({ state: 'visible' });
    await scene.shoot('week');

    await page.locator('[data-calendar-view="month"]').click();
    await page.locator('[data-calendar-grid="month"]').waitFor({ state: 'visible' });
    await scene.shoot('month', { themes: ['light'] });
    await page.locator('[data-calendar-view="week"]').click();
}
