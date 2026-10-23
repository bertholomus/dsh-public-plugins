/**
 * The window's changes to events, each held to what the user was asked
 * about it. A change that would email or reach people is refused first,
 * naming them all ('needs-notify', 'needs-approval', 'changed', with
 * details.people); the window asks the user, and on yes makes the same
 * change again with `approved`, who it showed. That list counts only for
 * the very change it was asked about (the same event, scope and fields,
 * and whether it tells the guests: a 'needs-notify' question is about the
 * change that tells them, as the window's yes to it says to), once,
 * within half an hour, and only as far as it names people that question
 * did. Any other `approved` counts as none: the change is refused again,
 * naming everyone, and asked about again. Kept in memory only.
 *
 * @module dsh-plugin-calendar/asked
 */
import { CalendarError, stableJson } from './manager.js';

/** The refusals that ask the user about people. */
const ASKING = new Set(['needs-notify', 'needs-approval', 'changed']);
/** How long a question's answer counts. */
const ANSWER_FOR = 30 * 60_000;
/** The most questions kept at once. */
const MOST = 100;

export class WindowChanges {
    /**
     * @param {import('./manager.js').CalendarManager} manager
     * @param {{now?: () => number}} [opts]
     */
    constructor(manager, { now = () => Date.now() } = {}) {
        this.manager = manager;
        this.now = now;
        this.asked = new Map();
    }

    /** A new event: manager.createEvent, input as the window gives it (with notify and approved). */
    create(input = {}) {
        const { approved, notify, ...fields } = input;
        return this.held(['create', fields], notify, approved, (told) => this.manager.createEvent({ ...fields, ...(notify !== undefined ? { notify } : {}) }, 'window', { approved: told, confirm: true }));
    }

    /** A change to an event (or a move to another calendar): manager.updateEvent. */
    update(id, patch = {}, scope = 'all') {
        const { approved, notify, ...fields } = patch;
        return this.held(['update', id, scope, fields], notify, approved, (told) => this.manager.updateEvent(id, { ...fields, ...(notify !== undefined ? { notify } : {}) }, scope, 'window', { approved: told, confirm: true }));
    }

    /** A delete: manager.deleteEvent. */
    delete(id, scope = 'all', notify = false, approved = undefined) {
        return this.held(['delete', id, scope], notify, approved, (told) => this.manager.deleteEvent(id, scope, 'window', { notify, approved: told, confirm: true }));
    }

    /**
     * Make a change held to the answer to its question, and keep the
     * question it is refused with: by the change and whether it tells the
     * guests, which a 'needs-notify' question is about doing.
     */
    async held(change, notify, approved, make) {
        const keyOf = (telling) => stableJson([...change, telling === true]);
        const told = this.answer(keyOf(notify), approved);
        try {
            return await make(told);
        } catch (error) {
            if (error instanceof CalendarError && ASKING.has(error.code) && Array.isArray(error.people)) {
                this.ask(keyOf(error.code === 'needs-notify' || notify), error.people);
            }
            throw error;
        }
    }

    /** Keep the question a change was refused with: who it named. */
    ask(key, people) {
        const now = this.now();
        for (const [k, question] of this.asked) if (now - question.at > ANSWER_FOR) this.asked.delete(k);
        this.asked.delete(key);
        this.asked.set(key, { people: people.map(String), at: now });
        while (this.asked.size > MOST) this.asked.delete(this.asked.keys().next().value);
    }

    /**
     * Who of `approved` the user was asked about for this change, once:
     * undefined when the change wasn't asked about (or not lately), or
     * approved isn't a list.
     */
    answer(key, approved) {
        const question = this.asked.get(key);
        this.asked.delete(key);
        if (question === undefined || this.now() - question.at > ANSWER_FOR || !Array.isArray(approved)) return undefined;
        const named = new Set(question.people.map((p) => p.toLowerCase()));
        return approved.filter((p) => typeof p === 'string' && named.has(p.toLowerCase()));
    }
}
