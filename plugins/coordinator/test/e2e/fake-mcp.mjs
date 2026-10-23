/**
 * A stand-in for one of the user's MCP servers, for the real-host
 * end-to-end test: DSH runs it over stdio as "lane-catalog", with one tool,
 * lanes_status. Every call is appended to the file named by argv[2], so the
 * test sees whether a call reached the server.
 *
 * @module dsh-plugin-coordinator/test/e2e/fake-mcp
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const callLog = process.argv[2];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const { id, method, params } = message;
    if (id === undefined) return;
    if (method === 'initialize') {
        send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fake-lane-catalog', version: '1.0.0' } } });
    } else if (method === 'tools/list') {
        send({ id, result: { tools: [{ name: 'lanes_status', description: 'Which of the user\'s model lanes are up.', inputSchema: { type: 'object', properties: {} } }] } });
    } else if (method === 'tools/call') {
        appendFileSync(callLog, `${new Date().toISOString()} ${params?.name}\n`);
        send({ id, result: { content: [{ type: 'text', text: 'alpha up, beta up, gamma busy, delta down' }] } });
    } else if (method === 'ping') {
        send({ id, result: {} });
    } else {
        send({ id, error: { code: -32601, message: `no method ${method}` } });
    }
});
