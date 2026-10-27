/**
 * Whether a reply's end waits on the person, so a nudge would talk over
 * them: Autopilot's own reading of a session's last reply, before it tells
 * an idle session with open todos to carry on. Measured on a corpus of
 * reply endings (test/fixtures/autopilot/endings.json, test/autopilot-ends.test.js).
 *
 * It waits on the person when the reply's last lines:
 *
 * - ask for an answer (the suite's `asksForAnswer`): a question at the end,
 *   a `DECISION NEEDED` or `BLOCKED:` line, or a plain request for the
 *   person's word ("waiting for your go", "your call", "please confirm",
 *   "should I", "do you want", "would you like");
 * - or hand the next step to the person: "let me know if you want me to
 *   go on", "tell me which one", "say the word and I'll run them", "… if
 *   you'd like", "once you confirm, I'll …", "I'll wait for your review",
 *   "I can add retries too, if that's useful", "I'm holding off until you
 *   confirm", "I'd like your review first", "I need the API token",
 *   "Your pick.", "Can you check whether the DB is up?".
 *
 * An offer that hands nothing over does not count: "happy to keep going",
 * "feel free to review the diff", "let me know if you have any questions",
 * "let me know if you hit any snags", advice ("If you want a stricter
 * check, use …", "Run it again if you want") and where a thing is ("The
 * logs are in /tmp if you want to look"). Nor does
 * any offer when the reply's last sentence says what the agent does next
 * itself ("Next: the CLI.", "Moving on to the docs.", "I will carry on with
 * the remaining todos."), unless that sentence hands over too.
 *
 * @module dsh-plugin-autopilot/ends
 */
import { asksForAnswer } from './shared/words.js';

/** How many of a reply's last non-empty lines are read, as the suite's words read them. */
const TAIL_LINES = 6;

/** "If that's useful", "if it helps": what an offer that waits for a yes may end with. */
const IF_HELPS = "if (?:it|that|this)(?: helps| would help| works for you| is (?:useful|helpful)| would be (?:useful|helpful)|['’]s (?:useful|helpful))";

/** Offers that hand the session's next step to the person. */
const HANDS_OVER = [
    // "Let me know if you want me to continue", "Tell me which one", "Let me know when you are ready" (not "I'll
    // keep going until you tell me to stop").
    /\b(?:let me know|(?<!\b(?:until|unless) you )tell me|ping me)\b/i,
    // "Say the word and I'll run them", "If you'd rather, say so".
    /\bsay (?:the word|so)\b/i,
    // "If you'd like me to…", "If you want, I can…", "If you prefer, I'll…".
    /\bif you(?:['’]d| would)? (?:like|want|prefer)(?: me\b| us\b|,? I\b)/i,
    // "Once you confirm, I'll…", "When you've had a look, I'll…", "whenever you give the go-ahead".
    /\b(?:once|when|whenever|after|as soon as) you(?:['’]ve| have)? (?:confirm|approve|review|decide|reply|answer|choose|pick|say|give|tell|check|look|had a look)/i,
    // "If you'd prefer tabs, I can reformat it": a choice the agent offers to act on (not advice: "If you want
    // to try it, run npm start").
    /^if you(?:['’]d| would)? (?:like|want|prefer|rather)\b.*\bI(?:['’]ll| will| can| could|['’]d| would)\b/i,
    // "Pick one and I'll apply it", "Give me a thumbs up and I'll publish".
    /^(?:just )?(?:pick|choose|give|send|tell|say|confirm|approve|reply|answer|decide)\b.*\band I(?:['’]ll| will| can)\b/i,
    // "I'll wait for your review", "I'll hold off until you…", "I'll stop here".
    /\bI(?:['’]ll| will| am going to|['’]m going to) (?:wait|hold off|hold|pause|stop here)\b/i,
    // "It's up to you", "whichever you prefer".
    /\b(?:up to you|whichever you (?:prefer|like|want))\b/i,
    // "Ready for your review", "Awaiting your feedback", "When you're ready, I can deploy it".
    /\b(?:ready for your|awaiting your|(?:when|once|whenever) you(?:['’]re| are) ready)\b/i,
    // "I've paused here so you can check it".
    /\bI(?:['’]ve| have) (?:paused|stopped) here\b/i,
    // "Happy to try another colour next": an offer of more work, which waits for a yes. Not "happy to keep going"
    // (the agent goes on), nor "happy to report" or "happy to help" (words of course).
    /\bhappy to (?!(?:keep|continue|carry|proceed|move|go on|report|say|confirm|share|help|announce|note|see|hear)\b)[a-z]/i,
    // "I can add retries too, if that's useful", "If it helps, I can draft the notes": an offer that waits for a yes.
    new RegExp(`\\bI (?:can|could)\\b[^.!?]*\\b${IF_HELPS}`, 'i'),
    new RegExp(`^${IF_HELPS},? I(?:['’]ll| will| can| could|['’]d| would)\\b`, 'i'),
    // "If you're OK with the rename, I'll update the imports".
    /^if you(?:['’]re| are) (?:ok|okay|happy|fine|good|comfortable|alright|all right)\b.*\bI(?:['’]ll| will| can| could)\b/i,
    // "I'm holding off on the deploy until you confirm", "I won't push until you've had a look": a wait on the
    // person (not "I'll keep going until you say stop").
    /^(?!.*\b(?:keep (?:going|at it)|continue|carry on|go on)\b).*\buntil you(?:['’]ve| have)? (?:confirm|approve|review|decide|reply|answer|choose|pick|say|give|tell|check|look|had|sign|OK|okay)/i,
    // "I'd like your review on the API first", "I need you to add the key".
    /\bI(?:['’]d| would) (?:like|appreciate|need|want) (?:your|you to)\b/i,
    /\bI need you to\b/i,
    // "I need the API token for the sandbox before I can go on": what only the person can give.
    /\bI need (?:the |an? |your |some )?(?:(?:api|access|auth|sandbox|deploy|admin|ssh) )?(?:token|key|password|credential|access|permission|approval|sign-?off|go-?ahead|login|secret)s?\b/i,
    /\bI need\b[^.!?]*\bfrom you\b/i,
    // "I'll leave it for you to approve".
    /\b(?:for you to|up to you to) (?:approve|decide|confirm|choose|pick|sign off|review|OK|okay)\b/i,
    // "Two ways to fix it: retry, or mock the clock. Your pick."
    /^your (?:pick|choice|call)\s*[.!]?$/i,
    // "Can you check whether the staging DB is up?": a request to act, even before a last line that explains it.
    /^(?:can|could|would) you (?:please )?(?:check|confirm|look|run|send|share|tell|give|add|grant|approve|review|try|restart|enable|set|create|provide|paste|upload)\b[^?]*\?$/i,
];

/** A closing courtesy hands nothing over: "Let me know if you have any questions." */
const COURTESY = /\b(?:any (?:other |more |further )?(?:questions?|issues?|problems?|feedback|concerns?|snags?|hiccups?|errors?|bugs?|trouble|glitch(?:es)?|failures?|surprises?|regressions?)|anything else|(?:have|got) (?:any )?questions?|run into (?:any )?(?:issues?|problems?|trouble)|if you (?:see|spot|notice|find|hit|run into|come across|encounter) (?:anything|something)|(?:anything|something)(?: else)?(?: (?:that(?:['’]s| is| looks| seems)|is|looks|seems|feels))? (?:unclear|odd|weird|strange|off|wrong|broken|missing|unexpected|confusing|amiss)|(?:anything|something) (?:comes up|breaks|goes wrong)|need (?:anything|any help|help|more)|how (?:it|that) (?:goes|works))\b/i;

/** What keeps a sentence a hand-over beside a courtesy: it asks about the next step itself. */
const NEXT_STEP = /\b(?:me to|I should|whether|which|when you|once you|how you(?:['’]d| would)? like|what you(?:['’]d| would)? like|if you want (?:me|it|that|them)|go ahead|proceed|continue|carry on)\b/i;

/** A sentence that says what the agent does next, itself: "Next: the CLI.", "Moving on to the docs.", "I will carry on with …". */
const GOES_ON = [
    /^(?:next(?: up)?|up next|then|now|after that)\s*[:—–-]/i,
    /^(?:next|then|now|after that),? I(?:['’]ll| will| am going to|['’]m going to)\b/i,
    /^next I (?:will|['’]ll|am going to)\b/i,
    /\b(?:moving on|carrying on|continuing|proceeding|going on|turning to|starting on|getting started)\b/i,
    /\bI(?:['’]ll| will| am going to|['’]m going to|['’]m| am) (?:now |next |then |also )?(?:carry on|continue|keep going|keep at it|move on|proceed|go on|start|get (?:on|started)|work on|tackle|turn to|pick up|begin|do|write|add|fix|run|update|implement|build|create|make|finish|handle|look at|check|test|deploy|commit|push|read|wire)\b/i,
    /^(?:(?:now|next|then),? )?let me (?:now )?(?:continue|carry on|move on|check|look|run|start|read|try|fix|write|add|open|inspect|confirm|verify)\b/i,
    /^on to\b/i,
];

/** A sentence that tells the person what they can do: advice, not an offer ("Run it again if you want"). */
const ADVICE = /^(?:you (?:can|could|may|might|should)|(?:just )?(?:run|use|try|see|check|open|read|look|install|set|pass|call|edit|change|rerun|re-run|start|stop|view|inspect|compare|search|grep|tail|cat)\b)/i;

/** Where a thing is, then "if you want": "The logs are in /tmp if you want to look" (a fact, not an offer). */
const WHERE_IF = /\b(?:is|are|['’]re|['’]s|lives?|sits?) (?:saved |stored |kept |written |left )?(?:in|at|under)\b[^,;]*\bif you(?:['’]d| would)? (?:like|want|prefer)\b/i;

/** What may start a line before its words: quote marks, a bullet, a list number, a heading mark. */
const LEAD = /^[\s>*_`#-]*(?:\d{1,3}[.)]\s+)?/;

/** The last lines' sentences, each without its lead or the bold and code marks around words. */
function tailSentences(text) {
    const lines = text.trim().split('\n').map((line) => line.trim()).filter(Boolean).slice(-TAIL_LINES);
    const out = [];
    for (const line of lines) {
        const plain = line.replace(LEAD, '').replace(/\*\*|__|`+/g, '').trim();
        for (const part of plain.split(/(?<=[.!?])["'”’)\]]*\s+/)) {
            const sentence = part.replace(LEAD, '').trim();
            if (sentence) out.push(sentence);
        }
    }
    return out;
}

/** Whether one sentence hands the next step to the person. */
export function handsOver(sentence) {
    // "If you want …" after an offer ("Happy to try another colour if you'd like", "… if you want it") leaves the
    // choice to the person; at a sentence's start it is advice ("If you want a stricter check, use …"), unless it
    // asks them for the go ("If you'd like me to…", "If you want, I can…").
    // Nor after an instruction to the person ("Run make bench if you want more numbers", "You can rerun it if you
    // like"), nor after where a thing is ("The logs are in /tmp if you want to look"): those are advice too.
    const trailingIf = /\S.*?\bif you(?:['’]d| would)? (?:like|want|prefer)\b/i.test(sentence) && !/^if you/i.test(sentence) && !ADVICE.test(sentence) && !WHERE_IF.test(sentence);
    if (!trailingIf && !HANDS_OVER.some((pattern) => pattern.test(sentence))) return false;
    return !COURTESY.test(sentence) || NEXT_STEP.test(sentence);
}

/** Whether one sentence says what the agent does next, itself. */
export function goesOn(sentence) {
    return GOES_ON.some((pattern) => pattern.test(sentence));
}

/**
 * The sentence in a reply's last lines that hands the next step to the
 * person ("Let me know if you want me to continue."), or undefined: none
 * does, or the last sentence says what the agent does next itself.
 * @param {unknown} text - the reply's text.
 */
export function handOverIn(text) {
    if (typeof text !== 'string' || text.trim() === '') return undefined;
    const sentences = tailSentences(text);
    const last = sentences.at(-1);
    if (!last) return undefined;
    // The agent says what it does next: an offer before that leaves nothing waiting.
    if (goesOn(last) && !handsOver(last)) return undefined;
    return [...sentences].reverse().find(handsOver);
}

/**
 * Whether a reply's end waits on the person (see the module's words):
 * Autopilot leaves a session alone while its last reply does.
 * @param {unknown} text - the reply's text.
 */
export function waitsOnPerson(text) {
    if (typeof text !== 'string' || text.trim() === '') return false;
    return asksForAnswer(text) || handOverIn(text) !== undefined;
}
