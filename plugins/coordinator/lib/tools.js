/**
 * Model-facing tools, registered in one agent's scope. A coordinating chat
 * gets the thread, message and settings tools, a thread gets
 * thread_handback and thread_ask, and both get shared_notes. Each tool is
 * bound to its chat (and thread) when it is registered, so a call can never
 * reach another chat's threads.
 *
 * @module dsh-plugin-coordinator/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HANDBACK_STATUSES, threadMarkdown } from './prompts.js';

/**
 * Every tool returns its text for the model and a view for the DSH
 * window. The view becomes the result's presentation meta, which the
 * `coordinatorSession` projection folds into thread cards and rosters
 * (projection.js); the model sees only the text.
 */
const OUTPUT = {
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            text: { type: 'string', required: true },
            view: { type: 'json' },
        },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
    presentationMeta: (_args, value) => value.view ?? null,
};

/** Ordinary failures come back as text so the model can correct itself. */
async function guarded(run) {
    try {
        return await run();
    } catch (error) {
        return { text: `Failed: ${error?.message ?? String(error)}` };
    }
}

function tool(spec) {
    return defineTool({ output: OUTPUT, timeoutMs: 90000, ...spec, execute: (args, exec) => guarded(() => spec.execute(args, exec)) });
}

/** An optional text argument; an empty string counts as not given, as some models send one for every field. */
const given = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

// Model and effort are settings: the tools take them only when the user asks, and a wrong value's error lists the valid ones.
const MODEL_HELP = 'Model as "provider:model" or a bare model id; "default" clears it.';
const EFFORT_HELP = 'A reasoning effort the model offers; a wrong one fails with the list. "default" clears it.';
const ONLY_ASKED = 'Only when the user asks for one.';

/**
 * Build the tools for one coordinating chat or thread.
 * @param {import('./projects.js').ProjectManager} manager
 * @param {{projectId: string, role: 'coordinator'|'thread', threadId?: string}} who
 */
export function projectTools(manager, who) {
    const { projectId, role, threadId } = who;
    /** The model's text plus the view the DSH window draws from (see projects.js view()). */
    const result = (text, details) => ({ text, view: manager.view(projectId, who, details) });
    /** A thread id as the model typed it (" t3 " is t3). */
    const id = (value) => String(value ?? '').trim();
    const shared = [
        tool({
            name: 'shared_notes',
            description: 'Read or write the shared notes of this chat and its threads, which all of them read. Write only facts the user stated or you checked: decisions, conventions, how the user wants to work. Never plans or guesses.',
            parameters: {
                action: { type: 'string', required: true, enum: ['read', 'append', 'replace'], description: 'read, append (add lines at the end), or replace (rewrite the whole file)' },
                text: { type: 'string', description: 'Text to append, or the full new content for replace' },
            },
            async execute(args) {
                return result(manager.memory(projectId, args.action, args.text));
            },
        }),
    ];

    if (role === 'thread') {
        return [
            ...shared,
            tool({
                name: 'thread_handback',
                description: 'Your report to the user, through the coordinator. Call it once, as your last step: done when finished, blocked when stuck, needs_decision when the user must choose.',
                parameters: {
                    status: { type: 'string', required: true, enum: HANDBACK_STATUSES, description: 'done, blocked or needs_decision; progress only for news the coordinator needs before you finish' },
                    summary: { type: 'string', required: true, description: 'At most 300 characters, what your card shows (a longer one comes back to you to shorten): the result first, then where (paths, links), then what you need, if anything. Only what your tools showed; mark a guess "(guess)".' },
                },
                async execute(args) {
                    const text = await manager.handback(projectId, threadId, args.status, args.summary);
                    return result(text, { action: { kind: 'handback', thread: threadId, status: args.status } });
                },
            }),
            tool({
                name: 'thread_ask',
                description: 'Ask your coordinator a question while you work, when you are unsure and no sensible default fits. Its answer arrives here as a message from the coordinator. Not for results: those go in thread_handback.',
                parameters: {
                    question: { type: 'string', required: true, description: 'One short question, with the options you see and the one you would pick' },
                },
                async execute(args) {
                    const text = await manager.askCoordinator(projectId, threadId, args.question);
                    return result(text, { action: { kind: 'question', thread: threadId } });
                },
            }),
        ];
    }

    return [
        ...shared,
        tool({
            name: 'thread_start',
            description: 'Start a thread: a separate DSH session in this folder that does one task and reports back to you with a handback. For work that runs long, splits into parts or runs in parallel, or when the user asks for a thread. One thread per distinct ask.',
            parameters: {
                title: { type: 'string', required: true, description: 'A few plain words naming the task, in the user\'s words' },
                ask: { type: 'string', required: true, description: 'The user\'s request, copied word for word from their message. The thread reads it as "The user asked: …".' },
                brief: { type: 'string', required: true, description: 'What the thread needs beyond the ask: the goal, the scope, what done looks like and what not to touch; facts from this chat and the shared notes; and the default you picked where the ask is unclear. No deliverables the user did not ask for.' },
                model: { type: 'string', description: `A model for this thread only, as "provider:model" or a bare model id. ${ONLY_ASKED} Leave it out otherwise.` },
                effort: { type: 'string', description: `An effort for this thread only, one the model offers. ${ONLY_ASKED} Leave it out otherwise.` },
            },
            async execute(args) {
                const r = await manager.startThread(projectId, { ...args, ask: given(args.ask), model: given(args.model), effort: given(args.effort) });
                // It names what the thread runs on only when the coordinator chose that (r.route).
                const runs = r.route ? ` It runs on ${r.route}.` : '';
                const notes = r.notes?.length ? ` Note: ${r.notes.join('; ')}.` : '';
                const has = r.tools?.length ? ` The user's words give it ${r.tools.join(', ')}.` : '';
                return result(
                    `Started ${r.threadId} "${r.title}". It reports back when done.${runs}${has}${notes} Link it as ${threadMarkdown(r.threadId, r.title)}.`,
                    { action: { kind: 'start', thread: r.threadId }, threads: [r.threadId] },
                );
            },
        }),
        tool({
            name: 'thread_send',
            description: 'Send a message to a thread. A running thread reads it in the turn it is running, at its next step; steer=false queues it until that turn ends. An idle thread starts its next turn with it.',
            parameters: {
                thread: { type: 'string', required: true, description: 'Thread id, e.g. "t3"' },
                text: { type: 'string', required: true, description: 'The message' },
                ask: { type: 'string', description: 'When the message passes on a request of the user\'s: their words, copied word for word' },
                steer: { type: 'boolean', description: 'For a running thread: true (the default) delivers it into the running turn, false queues it until that turn ends' },
            },
            async execute(args) {
                const sent = await manager.sendToThread(projectId, args.thread, args.text, args.steer !== false, { ask: given(args.ask), guard: true });
                return result(sent.text, { action: { kind: 'send', thread: id(args.thread), ...(sent.mode === 'steer' ? { status: 'steer' } : {}) }, threads: [id(args.thread)] });
            },
        }),
        tool({
            name: 'chat_message',
            description: 'Send a message to another chat when the user asks you to. That chat stays as it is: it gets no thread, card or tools. Its reply comes back to you once, as a note. For your own threads, use thread_send.',
            parameters: {
                to: { type: 'string', required: true, description: 'The chat\'s title as DSH lists it, or its session id' },
                ask: { type: 'string', required: true, description: 'The user\'s request to send it, copied word for word from their message' },
                text: { type: 'string', required: true, description: 'The message' },
            },
            async execute(args) {
                const target = await manager.sendMessage(projectId, { to: args.to, ask: given(args.ask), text: args.text });
                return result(`Sent to ${target.name}. Its reply comes back to you once, as a note.`);
            },
        }),
        tool({
            name: 'thread_list',
            description: 'List this chat\'s threads with live status and last handback.',
            parameters: {
                include_resolved: { type: 'boolean', description: 'Also list resolved threads' },
            },
            async execute(args) {
                return result(manager.listThreads(projectId, args.include_resolved === true), { full: true });
            },
        }),
        tool({
            name: 'thread_read',
            description: 'Read how a thread is doing: the files it changed so far, its latest steps, and its latest messages (user and assistant text).',
            parameters: {
                thread: { type: 'string', required: true, description: 'Thread id, e.g. "t3"' },
                count: { type: 'number', description: 'How many recent messages (default 6, max 30)' },
            },
            async execute(args) {
                return result(await manager.readThread(projectId, args.thread, args.count), { threads: [id(args.thread)] });
            },
        }),
        tool({
            name: 'thread_update',
            description: 'Change a thread when the user asks: rename it, change its model or effort, resolve or reopen it, or stop its current turn.',
            parameters: {
                thread: { type: 'string', required: true, description: 'Thread id, e.g. "t3"' },
                title: { type: 'string', description: 'New title' },
                model: { type: 'string', description: `${MODEL_HELP} "default" returns to the thread default. ${ONLY_ASKED}` },
                effort: { type: 'string', description: `${EFFORT_HELP} "default" returns to the thread default. ${ONLY_ASKED}` },
                resolved: { type: 'boolean', description: 'true to resolve, false to reopen' },
                stop: { type: 'boolean', description: 'Stop the running turn; queued messages are kept' },
            },
            async execute(args) {
                const title = given(args.title);
                const text = await manager.updateThread(projectId, args.thread, { ...args, title, model: given(args.model), effort: given(args.effort) });
                // The change a card names: the one the user most needs to see. A stop counts only if a turn was running.
                const stopped = args.stop === true && text.includes('current turn stopped');
                const status = stopped ? 'stopped' : args.resolved === true ? 'resolved' : args.resolved === false ? 'reopened' : title ? 'renamed' : null;
                return result(text, { ...(status ? { action: { kind: 'update', thread: id(args.thread), status } } : {}), threads: [id(args.thread)] });
            },
        }),
        tool({
            name: 'thread_settings',
            description: 'Show or change which model and effort new threads use, or pause threads. With no arguments it shows them, and the user\'s tools and permission settings, which only the user changes. Only when the user asks.',
            parameters: {
                thread_model: { type: 'string', description: `Default model for new threads. ${MODEL_HELP}` },
                thread_effort: { type: 'string', description: `Default effort for new threads. ${EFFORT_HELP}` },
                paused: { type: 'boolean', description: 'true pauses new threads and holds handbacks; false resumes and delivers held handbacks' },
            },
            async execute(args) {
                return result(await manager.updateSettings(projectId, {
                    threadModel: given(args.thread_model),
                    threadEffort: given(args.thread_effort),
                    paused: args.paused,
                }));
            },
        }),
    ];
}
