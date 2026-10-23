/**
 * The model-facing tool: `canon_capture`, which saves a note as a DRAFT in
 * the vault's drafts folder (drafts.js). DSH offers it only while Canon may
 * write drafts (lib/index.js); a call checks everything again and refuses
 * in words. The model sees the text; the view is for the window.
 *
 * @module dsh-plugin-canon/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { KINDS, MAX_BODY, MAX_TITLE } from './drafts.js';
import { errorText } from './shared/safe.js';

export const CAPTURE_TOOL = 'canon_capture';

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

/**
 * @param {(args: object, exec: object) => Promise<{ text: string, view?: object }>} save - lib/index.js: checks, writes, logs.
 */
export function captureTool(save) {
    return defineTool({
        name: CAPTURE_TOOL,
        description: 'Save something worth remembering across sessions as a DRAFT note in the shared canon vault: a decision that was made, a fact you checked, a how-to that worked, or a gotcha that cost time. Not for plans, guesses or this task\'s progress. A person reviews drafts and promotes the good ones; a draft is never added to any turn until then.',
        parameters: {
            title: { type: 'string', required: true, description: `A short title that says what the note is about, at most ${MAX_TITLE} characters.` },
            body: { type: 'string', required: true, description: `The note in Markdown: what to remember and why, with the commands, paths or numbers that matter. At most ${MAX_BODY} characters.` },
            kind: { type: 'string', required: true, enum: [...KINDS], description: 'decision (what was chosen and why), fact (something checked to be true), howto (steps that worked), gotcha (a trap and the way around it).' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional: a few tags, such as the project or the tool it is about.' },
        },
        output: OUTPUT,
        timeoutMs: 30000,
        async execute(args, exec) {
            try {
                return await save(args ?? {}, exec);
            } catch (error) {
                return { text: `Not saved: ${errorText(error, 200)}` };
            }
        },
    });
}
