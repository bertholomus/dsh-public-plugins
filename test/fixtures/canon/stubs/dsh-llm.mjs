/** DSH's user message maker: an id, the role, the content and the source. */
let made = 0;
export function createUserMessage({ content, source }) {
    made += 1;
    return { id: `stub-message-${made}`, role: 'user', content, source };
}
