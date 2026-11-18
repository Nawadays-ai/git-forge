// The GraphQL v4 endpoint. Stage 1: an authenticated placeholder that answers a
// GraphQL-shaped error; the schema and executor land in a later stage.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, sendJson, unauthorized } from './app.ts';

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, _body: Buffer): Promise<void> {
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  sendJson(res, 200, { data: null, errors: [{ message: 'GraphQL is not implemented yet' }] });
}
