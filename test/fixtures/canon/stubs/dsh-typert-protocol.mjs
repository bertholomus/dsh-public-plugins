/** DSH's endpoint marks: which methods are marked, and the error the window gets. */
export const marked = new Set();
export function Remote(_method, context) {
    marked.add(context.name);
}
export class RemoteError extends Error {
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
    }
}
export function bindTypertRemote(target, service, options) {
    return { target, service, options };
}
