/**
 * Test only: a stand-in for a plugin whose tool reaches something of the
 * user's, as the calendar plugin's do. It registers notes_read with a
 * `personal` mark on its definition, which no guardedTools entry names, so
 * the end-to-end test sees the projects plugin read the mark from DSH's
 * own registry.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'e2e-personal-tool';
export const inject = ['tools'];

export function apply(ctx) {
    const tool = defineTool({
        name: 'notes_read',
        description: 'Read the user\'s notes.',
        parameters: { query: { type: 'string', description: 'What to look for' } },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        execute: async () => ({ text: 'NOTES: buy milk' }),
    });
    // After defineTool, which keeps only the keys it knows.
    ctx.tools.register({ ...tool, personal: { name: 'notes-app', words: ['my notes app'] } });
}
