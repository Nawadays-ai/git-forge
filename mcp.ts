// The MCP endpoint: streamable HTTP JSON-RPC 2.0, stateless (no session header).
// It speaks the modern era first — `server/discover` answers the server's identity,
// capabilities and supported revisions in one result — and keeps the legacy
// `initialize` handshake working for older clients. The six tools share the REST
// surface's store operations, so anything created here is the same object REST,
// GraphQL and git see.
//
// Wire rules the suite holds us to: a non-JSON body is HTTP 400 with a -32700
// parse error (judged before auth); a missing token is 401; an unknown tool is a
// JSON-RPC error, never an HTTP 500; a tool call missing a required argument
// answers isError; notifications get an empty 204; tools/list is built from one
// static definition so two calls answer byte-identically.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import { createRepo, findRepo, repos, type Repo } from './store.ts';
import { createIssue, createPull, issueObject, mergePull, pullObject, repoObject } from './rest.ts';
import { authorized, sendJson, unauthorized } from './app.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Json = Record<string, unknown>;

function stringProp(description: string): Json {
  return { type: 'string', description };
}

const TOOLS: Json[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open or closed.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch to merge from.'),
        base: stringProp('The base branch to merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_LIST_RESULT: Json = { tools: TOOLS };

function toolResult(value: unknown): Json {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(messageText: string): Json {
  return { content: [{ type: 'text', text: messageText }], isError: true };
}

function requiredOf(toolName: string): string[] {
  const tool = TOOLS.find((candidate) => candidate.name === toolName);
  const schema = (tool?.inputSchema ?? {}) as Json;
  return Array.isArray(schema.required) ? (schema.required as string[]) : [];
}

function callTool(name: string, args: Json): Json | null {
  const missing = requiredOf(name).filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (missing.length > 0) return toolError(`Missing required argument(s): ${missing.join(', ')}`);

  const repoOf = (): Repo | null => findRepo(String(args.owner ?? VIEWER.login), String(args.repo ?? ''));

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (repos.has(repoName)) return toolError(`Repository ${repoName} already exists`);
      const repo = createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private !== false);
      return toolResult(repoObject(repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(repoObject(repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const created = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return toolError(created.error);
      return toolResult(issueObject(repo, created));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (args.state === 'open' || args.state === 'closed') issues = issues.filter((issue) => issue.state === args.state);
      return toolResult(issues.map((issue) => issueObject(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const created = createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
      if ('error' in created) return toolError(created.error);
      return toolResult(pullObject(repo, created));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolError(`Pull request #${String(args.pull_number)} not found`);
      const result = mergePull(repo, pull, 'squash');
      if ('error' in result) return toolError(result.error);
      return toolResult(pullObject(repo, pull));
    }
    default:
      return null;
  }
}

interface RpcOutcome {
  status: number;
  payload: Json | null;
}

function rpcResult(id: unknown, result: Json): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, messageText: string): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id, error: { code, message: messageText } } };
}

function dispatch(request: Json): RpcOutcome {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';

  // Notifications carry no id: accept them with an empty 204.
  if (id === undefined || id === null) return { status: 204, payload: null };

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Json;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Json;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Json;
      if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const result = callTool(name, args);
      if (result === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  // A body that is not JSON is a parse error before anything else: the suite
  // judges that answer on its own, token or not.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const outcome = dispatch(parsed as Json);
  if (outcome.status === 204 || outcome.payload === null) {
    res.writeHead(204, { 'x-github-request-id': `forge-mcp-${Date.now().toString(36)}` });
    res.end();
    return;
  }
  sendJson(res, outcome.status, outcome.payload);
}
