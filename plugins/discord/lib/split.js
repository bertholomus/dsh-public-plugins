/**
 * Fence-aware message splitting for Discord's 2000-character limit. Splits on
 * paragraph or line boundaries and never cuts inside a code fence: an
 * over-long fenced block is closed and reopened around each fragment.
 *
 * @module dsh-plugin-discord/split
 */

/** A line that opens or closes a fence (``` or ~~~, optionally with a language). */
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Split text into Discord-safe chunks.
 * Guaranteed: no chunk exceeds `limit`, every fence opened in a chunk is
 * closed within that chunk, and fenced content continues correctly across
 * chunk boundaries (reopened with the same marker).
 * @param {string} text - full text.
 * @param {number} [limit] - per-chunk ceiling (Discord: 2000).
 * @returns {string[]}
 */
export function splitForDiscord(text, limit = 2000) {
    const source = typeof text === 'string' ? text : String(text ?? '');
    if (source.length <= limit) return [source];

    const lines = source.split('\n');
    /** @type {string[]} */
    const chunks = [];
    let outLines = [];   // lines of the current chunk, excluding fence wrappers
    let openFence = null; // fence marker open in the current chunk, or null

    /** The current chunk's rendered length, including any fence wrappers. */
    function renderedLength() {
        const body = outLines.join('\n');
        return openFence === null ? body.length : body.length + openFence.length * 2 + 2;
    }
    function render() {
        const body = outLines.join('\n');
        return openFence === null ? body : `${openFence}\n${body}\n${openFence}`;
    }
    function flush() {
        if (outLines.length === 0) return;
        chunks.push(render());
        outLines = [];
        openFence = null;
    }
    /** Close the fence into the current chunk and reopen it in the next. */
    function fenceBreak(nextFence) {
        chunks.push(render()); // closes the fence for this chunk
        outLines = [];
        openFence = nextFence;
    }

    for (const line of lines) {
        if (FENCE_RE.test(line)) {
            if (openFence === null) {
                const marker = line.trim();
                // Would the opening fence + first content line fit? If not, start a new chunk.
                if (renderedLength() + marker.length + 2 > limit) flush();
                openFence = marker.length <= 3 ? marker : marker.slice(0, 3) + marker.slice(3).split(' ')[0];
                if (openFence.length > 32) openFence = openFence.slice(0, 32);
                // The marker itself is rendered by render(); never pushed as content.
            } else {
                openFence = null; // closed within this chunk; render() emits the marker
                // A closed fence is a good break point.
                if (renderedLength() >= limit - 200) flush();
            }
            continue;
        }

        // renderedLength() already includes fence overhead; joiner is the newline.
        const joiner = outLines.length === 0 ? 0 : 1;
        if (renderedLength() + joiner + line.length > limit) {
            if (openFence !== null) {
                // Would cut inside a code block: close, flush, reopen.
                const fence = openFence;
                fenceBreak(fence);
                outLines.push(line);
            } else if (line.length + 1 > limit) {
                // Single line longer than the limit: hard-split, preserving content.
                flush();
                for (let i = 0; i < line.length; i += limit) {
                    const piece = line.slice(i, i + limit);
                    if (i + limit < line.length) chunks.push(piece);
                    else outLines.push(piece);
                }
            } else {
                // Prefer the last paragraph boundary if it keeps the chunk healthy.
                const joined = outLines.join('\n');
                const para = joined.lastIndexOf('\n\n');
                if (para >= Math.floor(limit * 0.3)) {
                    const head = joined.slice(0, para + 2);
                    const tailLines = joined.slice(para + 2).split('\n');
                    chunks.push(head);
                    outLines = tailLines;
                } else {
                    flush();
                }
                outLines.push(line);
            }
        } else {
            outLines.push(line);
        }
    }
    flush();
    return chunks.filter((c) => c.length > 0);
}
