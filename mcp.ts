// The MCP endpoint (streamable HTTP, JSON answers). Stage 1: an authenticated
// placeholder answering a JSON-RPC method-not-found; the tools land in a later stage.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, sendJson, unauthorized } from './app.ts';

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  let id: unknown = null;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { id?: unknown };
    id = parsed.id ?? null;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
