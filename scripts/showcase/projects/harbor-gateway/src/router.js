/** The route for a request path: the longest prefix that matches, or undefined. */
export function routeFor(routes, path) {
    let best;
    for (const route of routes) {
        if (path === route.prefix || path.startsWith(`${route.prefix}/`)) {
            if (!best || route.prefix.length > best.prefix.length) best = route;
        }
    }
    return best;
}

/** A path with its query and repeated slashes taken out. */
export function cleanPath(raw) {
    const path = String(raw).split('?')[0].replace(/\/{2,}/g, '/');
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
