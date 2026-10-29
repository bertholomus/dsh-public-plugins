import { createServer } from 'node:http';
import { cleanPath, routeFor } from './router.js';
import { bucket } from './limits.js';

const routes = [
    { prefix: '/api/orders', upstream: 'orders.internal:7001' },
    { prefix: '/api/ledger', upstream: 'ledger.internal:7002' },
    { prefix: '/status', upstream: 'local' },
];
const limit = bucket({ perMinute: 600, burst: 40 });

createServer((req, res) => {
    if (!limit.take(req.socket.remoteAddress)) {
        res.writeHead(429, { 'retry-after': '1' }).end();
        return;
    }
    const route = routeFor(routes, cleanPath(req.url));
    res.writeHead(route ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstream: route?.upstream ?? null }));
}).listen(8443);
