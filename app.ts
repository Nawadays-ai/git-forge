// The forge's HTTP server: one process serving the git smart-HTTP surface, the REST v3
// API, the GraphQL v4 endpoint and the MCP endpoint over the shared in-memory store.
//
// Cross-surface rules the suite checks: every API reply is JSON (never HTML), every
// reply carries a non-empty X-GitHub-Request-Id, a request without the suite's bearer
// token is a 401 with a {message} body, and an unknown route is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { findRepo } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

/** Whether the request carries the suite's bearer token (any bearer when no token is configured). */
export function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (TOKEN !== '') return header === `Bearer ${TOKEN}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 128 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The REST branch is checked before the git route pattern: the two path
  // shapes are disjoint (a git path is /<owner>/<repo>.git/<endpoint>, never
  // /api/v3/...), and REST traffic should not pay a regex exec per request.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    // A GET or HEAD that declares no body has none to read: consuming its stream
    // anyway costs an async-iterator round trip per request and changes nothing —
    // the handlers only ever parse a body on methods that carry one, and a GET
    // that does declare a body is still read in full below.
    const declaresBody =
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    const body =
      (method === 'GET' || method === 'HEAD') && !declaresBody
        ? Buffer.alloc(0)
        : method === 'GET' || method === 'DELETE'
          ? await readBody(req).catch(() => Buffer.alloc(0))
          : await readBody(req);
    await handleRest(req, res, url, body);
    return;
  }

  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const repo = findRepo(owner, name);
    if (!repo) {
      notFound(res);
      return;
    }
    const endpoint = gitMatch[3] as string;
    if (endpoint === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        notFound(res);
        return;
      }
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const answer = handleInfoRefs(repo, service, version2);
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const answer = handleUploadPack(repo, body);
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const answer = handleReceivePack(repo, body);
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    notFound(res);
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    const body = await readBody(req);
    await handleGraphQL(req, res, body);
    return;
  }

  if (path === '/mcp') {
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    await handleMcp(req, res, body);
    return;
  }

  notFound(res);
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
