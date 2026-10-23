/**
 * A stand-in for the parts of DSH the session watcher reads, for the
 * suite's unit tests: sessions with event logs, agents with inboxes,
 * DSH's projection registry (folding with the watcher's own fold), the
 * session list with the values DSH saved, cold reads that close an open
 * turn as DSH's do, goals with a round driver, and a stop that cuts
 * running turns off (gracefully, or as a crash).
 *
 * The tests drive it: start a turn, end it, write as the person, stop
 * DSH and start a new watcher over the same sessions.
 */
import { KEY, foldAll, viewOf } from '../../plugins/session-watch/lib/fold.js';

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - the clock events are stamped with.
 * @param {boolean} [options.autoRead] - an idle agent reads a message as soon as it is queued (DSH's own behaviour).
 */
export function fakeDsh({ now = Date.now, autoRead = true } = {}) {
    const sessions = new Map();
    const agents = new Map();
    const flushed = [];
    let watch;
    let seq = 0;
    let messages = 0;

    const foldOf = (s) => foldAll(s.events);

    function add(id, fields = {}) {
        const known = sessions.get(id);
        if (known) return Object.assign(known, fields);
        const s = { id, events: [], title: '', cwd: `/work/${id}`, updatedAt: now(), blank: false, loaded: false, goal: undefined, saved: undefined, values: undefined, ...fields };
        // The loaded Session object: its log by position, as DSH's `seq` and `eventAt`.
        s.handle ??= { id, get seq() { return s.events.length; }, eventAt: (at) => s.events[at] };
        sessions.set(id, s);
        return s;
    }

    function save(id) {
        const s = sessions.get(id);
        s.saved = viewOf(foldOf(s));
    }

    /** Commit an event to a session's log; a loaded session's watcher hears it, as DSH's `session/event`. */
    function commit(id, type, data = {}, { quiet = false } = {}) {
        const s = add(id);
        const event = { type, time: now(), seq: ++seq, data };
        s.events.push(event);
        s.updatedAt = event.time;
        // DSH writes a session's projection values at each turn end (and on a timer, which tests call as save()).
        if (type === 'turn/end') save(id);
        if (!quiet && s.loaded) watch?.onSessionEvent(s.handle, event);
        return event;
    }

    function message(text, source = { kind: 'user' }) {
        messages += 1;
        return { id: `user-${messages}`, role: 'user', content: [{ type: 'text', text }], source };
    }

    function setStatus(agent, status) {
        agent.status = status;
        watch?.onStatus(agent, status);
    }

    function makeAgent(s) {
        return {
            id: s.id,
            status: 'idle',
            session: s.handle,
            inbox: [],
            followup(msg) {
                if (dsh.refuse) throw new Error(dsh.refuse);
                this.inbox.push(msg);
                commit(s.id, 'agent/inbox/spliced', { target: 'followup', start: 0, inserted: [msg] });
                if (autoRead && this.status === 'idle') setImmediate(() => dsh.read(s.id));
            },
            steer(msg) {
                this.steered = (this.steered ?? 0) + 1;
                this.inbox.push(msg);
                commit(s.id, 'agent/inbox/spliced', { target: 'steer', start: 0, inserted: [msg] });
                // A running turn reads a steered message at its next step.
                setImmediate(() => {
                    const at = this.inbox.indexOf(msg);
                    if (at >= 0 && this.status === 'running') {
                        this.inbox.splice(at, 1);
                        commit(s.id, 'user/message', msg);
                    }
                });
            },
        };
    }

    /** The goal driver: an armed, active goal starts a round when its agent is idle. */
    function driveGoal(id) {
        const s = sessions.get(id);
        const g = s?.goal;
        const agent = agents.get(id);
        if (!g || !agent || g.phase !== 'active' || g.activation !== 'armed' || agent.status !== 'idle') return;
        g.roundsStarted += 1;
        const turn = (foldOf(s).turn ?? 0) + 1;
        setStatus(agent, 'running');
        commit(id, 'turn/start', { turn });
        commit(id, 'user/message', message(`Continue working toward the goal (round ${g.roundsStarted}).`, { kind: 'goal', goalId: g.id, revision: g.revision, round: g.roundsStarted }));
    }

    const dsh = {
        sessions,
        agents,
        flushed,
        /** Other projections' live states by key: `(session) => state` (DSH's question box, the coordinator's roster). */
        extra: {},
        /** When set, `followup` throws with these words. */
        refuse: undefined,
        add,
        commit,
        save,
        message,
        state: (id) => foldOf(sessions.get(id)),
        /** The watcher hearing this DSH's events. */
        attach(next) {
            watch = next;
            next.goals = dsh.goals;
        },
        /** Load a session's agent, as DSH's resume does: an open turn in the log is closed as interrupted first. */
        load(id) {
            const s = add(id);
            if (s.loaded) return agents.get(id);
            const st = foldOf(s);
            if (st.open) commit(id, 'turn/end', { turn: st.turn, reason: { kind: 'interrupted' } }, { quiet: true });
            s.loaded = true;
            const agent = makeAgent(s);
            agents.set(id, agent);
            // A new agent's goal is disarmed: DSH's goal activation lives with the process.
            if (s.goal) s.goal.activation = 'disarmed';
            watch?.onAgent(agent, 'created');
            return agent;
        },
        /** The agent reads its queued messages into a new turn. */
        read(id) {
            const s = sessions.get(id);
            const agent = agents.get(id);
            if (!agent || agent.status === 'running' || agent.inbox.length === 0) return;
            const queued = agent.inbox.splice(0);
            setStatus(agent, 'running');
            commit(id, 'turn/start', { turn: (foldOf(s).turn ?? 0) + 1 });
            for (const msg of queued) commit(id, 'user/message', msg);
        },
        /** The person (or, with a source, another session) writes in a session and its turn starts. */
        write(id, text = 'Please carry on.', source = { kind: 'user' }) {
            const agent = dsh.load(id);
            const s = sessions.get(id);
            setStatus(agent, 'running');
            commit(id, 'turn/start', { turn: (foldOf(s).turn ?? 0) + 1 });
            commit(id, 'user/message', message(text, source));
        },
        /** End the running turn: todos, a reply, then the end; the goal driver then runs (or an error disarms it). */
        end(id, reason = { kind: 'completed' }, { reply, todos, tools = 0 } = {}) {
            const s = sessions.get(id);
            const agent = agents.get(id);
            const turn = foldOf(s).turn;
            for (let i = 0; i < tools; i += 1) commit(id, 'tool/call', { name: 'bash', callId: `call-${seq}` });
            if (todos) commit(id, 'todo/write', { todos });
            if (reply) commit(id, 'assistant/message', { turn, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
            commit(id, 'turn/end', { turn, reason });
            if (reason.kind === 'error' && s.goal) s.goal.activation = 'disarmed';
            if (agent) {
                setStatus(agent, 'idle');
                if (agent.inbox.length && autoRead) setImmediate(() => dsh.read(id));
                else setImmediate(() => driveGoal(id));
            }
        },
        /** Give a session a goal (as `/goal` does). */
        setGoal(id, objective, { phase = 'active', max = 20, armed = true } = {}) {
            const s = add(id);
            s.goal = { id: `goal-${id}`, revision: (s.goal?.revision ?? 0) + 1, objective, phase, roundsStarted: s.goal?.roundsStarted ?? 0, activation: armed ? 'armed' : 'disarmed', maxGoalRounds: max };
            commit(id, 'goal/change', { operation: 'create', goal: { id: s.goal.id, revision: s.goal.revision, objective, phase, maxGoalRounds: max }, roundsStarted: s.goal.roundsStarted });
        },
        /** DSH stops. Gracefully, running turns end as aborted (disposed); a crash leaves them open in the log. */
        stop({ crash = false } = {}) {
            for (const [id] of agents) {
                const s = sessions.get(id);
                const st = foldOf(s);
                if (st.open && !crash) commit(id, 'turn/end', { turn: st.turn, reason: { kind: 'aborted', reason: { kind: 'disposed' } } });
                s.loaded = false;
            }
            agents.clear();
            watch = undefined;
        },
        goals: {
            get(agent) {
                const g = sessions.get(agent.id)?.goal;
                return g ? { ...g } : undefined;
            },
            resume(agent, { id, revision }) {
                const g = sessions.get(agent.id)?.goal;
                if (!g || g.id !== id || g.revision !== revision) throw new Error('That goal changed.');
                if (g.phase === 'active' && g.activation === 'armed') throw new Error('The goal is already running.');
                g.phase = 'active';
                g.activation = 'armed';
                setImmediate(() => driveGoal(agent.id));
            },
        },
    };

    /** What the watcher gets as its context from DSH. */
    dsh.ctx = {
        sessionController: {
            async list() {
                const items = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => ({
                    sessionId: s.id,
                    updatedAt: s.updatedAt,
                    agentAvailable: true,
                    running: agents.get(s.id)?.status === 'running',
                    blank: s.blank,
                    cwd: s.cwd,
                    ...(s.parentSessionId ? { parentSessionId: s.parentSessionId, origin: 'subagent' } : {}),
                    projections: { values: { ...(s.title ? { title: { title: s.title } } : {}), ...(s.saved ? { [KEY]: s.saved } : {}), ...(s.values ?? {}) } },
                }));
                return { items };
            },
            async inspect(id) {
                const s = sessions.get(id);
                if (!s) throw new Error(`Session ${id} not found`);
                const events = [...s.events];
                const st = foldOf(s);
                // A cold read closes an open turn, as DSH's own reader does.
                if (st.open) events.push({ type: 'turn/end', time: now(), data: { turn: st.turn, reason: { kind: 'interrupted' } } });
                return { meta: { sessionId: id }, events };
            },
            async resolveAgent(id) {
                if (!sessions.has(id)) throw new Error(`Session ${id} not found`);
                return { agent: dsh.load(id) };
            },
        },
        sessions: {
            get: (id) => (sessions.get(id)?.loaded ? sessions.get(id).handle : undefined),
            flush: async (handle) => { flushed.push(handle.id); },
        },
        agents: {
            get: (id) => agents.get(id),
            list: () => [...agents.values()],
        },
        sessionProjections: {
            stateOf: (handle, key) => (key === KEY ? foldOf(sessions.get(handle.id)) : dsh.extra[key]?.(sessions.get(handle.id))),
        },
    };
    return dsh;
}
