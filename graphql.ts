// The GraphQL v4 endpoint: a small lexer, parser and executor covering the schema
// the suite (and the gh CLI whose queries it mirrors) actually uses — viewer,
// repository reads, issue/pull connections with cursor pagination, the five
// mutations, Relay node(id:) and the __type introspection probes.
//
// Global ids are base64("forge:<Type>:<key>"): opaque (never the plain database
// id), stable across reads, and decodable by node(id:) and the mutations.
// Errors follow GraphQL convention: HTTP 200 with an `errors` array whose
// messages name the offending field; an unknown repository is data.repository
// null with no errors. A request without a token is the one hard failure: 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  findRepo,
  isoOfSeq,
  nextCommentId,
  nextSeq,
  repos,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { createIssue, createPull, mergePull, pullFiles, pullMergeable } from './rest.ts';
import { authorized, sendJson, unauthorized } from './app.ts';

// ---------------------------------------------------------------------------------------------
// global ids

export function globalId(type: string, key: string): string {
  return Buffer.from(`forge:${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 3 || parts[0] !== 'forge') return null;
    return { type: parts[1] as string, key: parts.slice(2).join(':') };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  const repoId = Number.parseInt(decoded.key, 10);
  for (const repo of repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function issueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Issue') return null;
  const [repoIdText, numberText] = decoded.key.split(':');
  const repoId = Number.parseInt(repoIdText ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  for (const repo of repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    if (issue) return { repo, issue };
  }
  return null;
}

function pullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'PullRequest') return null;
  const [repoIdText, numberText] = decoded.key.split(':');
  const repoId = Number.parseInt(repoIdText ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  for (const repo of repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.get(number);
    if (pull) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// schema description (introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'isPrivate', 'description',
    'url', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'url', 'author', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closed', 'repository',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'repository', 'mergeCommit',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'type', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
  __Schema: ['queryType', 'mutationType', 'types', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergePullRequestMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------------------------
// lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: input.slice(i + 3, end < 0 ? input.length : end) });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i + 1;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: Number.parseFloat(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string; selection: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('Unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const nameToken = this.peek();
        if (nameToken && nameToken.kind === 'name') {
          name = nameToken.value;
          this.next();
        }
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalancedParens();
        operations.push({ type: token.value, name, selection: this.parseSelectionSet() });
        continue;
      }
      // Fragments and anything else: skip a balanced block if present.
      this.next();
      if (this.peek()?.kind === 'name') this.next();
      if (this.peek()?.kind === 'name') this.next();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') this.parseSelectionSet();
    }
    return operations;
  }

  private skipBalancedParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (!token) throw new Error('Unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const onToken = this.next();
        if (onToken.kind === 'name' && onToken.value === 'on') {
          const typeToken = this.next();
          selections.push({ kind: 'inlineFragment', typeCondition: typeToken.kind === 'name' ? typeToken.value : '', selection: this.parseSelectionSet() });
        } else {
          // Fragment spread: not used by the suite; skip it.
          continue;
        }
        continue;
      }
      selections.push(this.parseField());
    }
  }

  private parseField(): FieldNode {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('Expected a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.skipPunct(':')) {
      alias = name;
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('Expected a field name after the alias');
      name = nameToken.value;
    }
    const args = new Map<string, Value>();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      for (;;) {
        const token = this.peek();
        if (token && token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.next();
        if (argName.kind !== 'name') throw new Error('Expected an argument name');
        this.expectPunct(':');
        args.set(argName.value, this.parseValue());
      }
    }
    // Directives are not used by the suite; skip any.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalancedParens();
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next();
      return { kind: 'variable', name: nameToken.kind === 'name' ? nameToken.value : '' };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      for (;;) {
        const peeked = this.peek();
        if (peeked && peeked.kind === 'punct' && peeked.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      for (;;) {
        const peeked = this.peek();
        if (peeked && peeked.kind === 'punct' && peeked.value === '}') {
          this.next();
          break;
        }
        const key = this.next();
        if (key.kind !== 'name') throw new Error('Expected an object key');
        this.expectPunct(':');
        fields.set(key.value, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    throw new Error('Unexpected value token');
  }
}

/** Resolve a parsed Value against the request variables into plain JS data. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution

type GqlValue =
  | { __type: string; [key: string]: unknown }
  | string
  | number
  | boolean
  | null
  | GqlValue[];

interface Ctx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function tagged(type: string, data: Record<string, unknown>): GqlValue {
  return { __type: type, ...data };
}

function repoValue(repo: Repo): GqlValue {
  return tagged('Repository', { repo });
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return tagged('Issue', { repo, issue });
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return tagged('PullRequest', { repo, pull });
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetForCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1] as string, 10) : 0;
  } catch {
    return 0;
  }
}

interface ConnectionSpec {
  type: string;
  items: GqlValue[];
}

function connection(type: string, all: GqlValue[], args: Map<string, unknown>): GqlValue {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : all.length;
  const start = offsetForCursor(args.get('after'));
  const slice = all.slice(start, start + Math.max(0, first));
  const hasNext = start + slice.length < all.length;
  return tagged(type, {
    nodes: slice,
    edges: slice.map((node, index) => tagged('Edge', { node, cursor: cursorFor(start + index + 1) })),
    pageInfo: tagged('PageInfo', {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? cursorFor(start + 1) : null,
      endCursor: slice.length ? cursorFor(start + slice.length) : null,
    }),
    totalCount: all.length,
  });
}

function issueConnection(repo: Repo, args: Map<string, unknown>): GqlValue {
  let issues = [...repo.issues.values()];
  const states = args.get('states');
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.get('orderBy');
  let descending = false;
  if (typeof orderBy === 'object' && orderBy !== null) {
    descending = (orderBy as Record<string, unknown>).direction === 'DESC';
  }
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  return connection('IssueConnection', issues.map((issue) => issueValue(repo, issue)), args);
}

function resolveField(typeName: string, source: GqlValue, field: string, args: Map<string, unknown>, ctx: Ctx): GqlValue | undefined {
  const record = typeof source === 'object' && source !== null && !Array.isArray(source) ? (source as Record<string, unknown>) : {};

  if (typeName === 'Query') {
    switch (field) {
      case 'viewer':
        return tagged('User', { login: VIEWER.login });
      case 'repository': {
        const owner = String(args.get('owner') ?? '');
        const name = String(args.get('name') ?? '');
        const repo = findRepo(owner, name);
        return repo ? repoValue(repo) : null;
      }
      case 'node': {
        const id = String(args.get('id') ?? '');
        const found = repoByGlobalId(id);
        if (found) return repoValue(found);
        const issueFound = issueByGlobalId(id);
        if (issueFound) return issueValue(issueFound.repo, issueFound.issue);
        const pullFound = pullByGlobalId(id);
        if (pullFound) return pullValue(pullFound.repo, pullFound.pull);
        return null;
      }
      case '__type': {
        const name = String(args.get('name') ?? '');
        if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
        return tagged('__Type', { name });
      }
      case '__schema':
        return tagged('__Schema', {});
      default:
        return undefined;
    }
  }

  if (typeName === 'Mutation') {
    const input = (typeof args.get('input') === 'object' && args.get('input') !== null ? args.get('input') : {}) as Record<string, unknown>;
    switch (field) {
      case 'createIssue': {
        const repo = repoByGlobalId(String(input.repositoryId ?? ''));
        if (!repo) {
          ctx.errors.push({ message: 'createIssue: repository not found' });
          return null;
        }
        const created = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) {
          ctx.errors.push({ message: `createIssue: ${created.error}` });
          return null;
        }
        return tagged('CreateIssuePayload', { issue: issueValue(repo, created) });
      }
      case 'closeIssue': {
        const found = issueByGlobalId(String(input.issueId ?? ''));
        if (!found) {
          ctx.errors.push({ message: 'closeIssue: issue not found' });
          return null;
        }
        found.issue.state = 'closed';
        return tagged('CloseIssuePayload', { issue: issueValue(found.repo, found.issue) });
      }
      case 'createPullRequest': {
        const repo = repoByGlobalId(String(input.repositoryId ?? ''));
        if (!repo) {
          ctx.errors.push({ message: 'createPullRequest: repository not found' });
          return null;
        }
        const created = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if ('error' in created) {
          ctx.errors.push({ message: `createPullRequest: ${created.error}` });
          return null;
        }
        return tagged('CreatePullRequestPayload', { pullRequest: pullValue(repo, created) });
      }
      case 'mergePullRequest': {
        const found = pullByGlobalId(String(input.pullRequestId ?? ''));
        if (!found) {
          ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
          return null;
        }
        const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase() === 'merge' ? 'merge' : 'squash';
        const result = mergePull(found.repo, found.pull, method);
        if ('error' in result) {
          ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
          return null;
        }
        return tagged('MergePullRequestPayload', { pullRequest: pullValue(found.repo, found.pull) });
      }
      case 'addComment': {
        const found = issueByGlobalId(String(input.subjectId ?? ''));
        if (!found) {
          ctx.errors.push({ message: 'addComment: subject not found' });
          return null;
        }
        const comment = { id: nextCommentId(), body: String(input.body ?? ''), seq: nextSeq() };
        found.issue.comments.push(comment);
        return tagged('AddCommentPayload', {
          commentEdge: tagged('IssueCommentEdge', {
            node: tagged('IssueComment', { comment, repo: found.repo, issue: found.issue }),
            cursor: cursorFor(comment.id),
          }),
        });
      }
      default:
        return undefined;
    }
  }

  if (typeName === 'User') {
    switch (field) {
      case 'id':
        return globalId('User', VIEWER.login);
      case 'login':
        return VIEWER.login;
      case 'name':
        return VIEWER.name;
      case 'email':
        return VIEWER.email;
      case 'url':
        return `http://forge/${VIEWER.login}`;
      default:
        return undefined;
    }
  }

  if (typeName === 'Repository') {
    const repo = record.repo as Repo;
    switch (field) {
      case 'id':
        return globalId('Repository', String(repo.id));
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return tagged('User', { login: repo.owner });
      case 'defaultBranchRef': {
        const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return oid === undefined ? null : tagged('Ref', { name: repo.defaultBranch });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'isPrivate':
        return repo.private;
      case 'description':
        return repo.description;
      case 'url':
        return `http://forge/${repo.owner}/${repo.name}`;
      case 'createdAt':
        return isoOfSeq(repo.seq);
      case 'updatedAt':
        return isoOfSeq(repo.seq);
      case 'issue': {
        const number = Number(args.get('number'));
        const issue = repo.issues.get(number);
        return issue ? issueValue(repo, issue) : null;
      }
      case 'issues':
        return issueConnection(repo, args);
      case 'pullRequest': {
        const number = Number(args.get('number'));
        const pull = repo.pulls.get(number);
        return pull ? pullValue(repo, pull) : null;
      }
      case 'pullRequests': {
        const pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
        return connection('PullRequestConnection', pulls.map((pull) => pullValue(repo, pull)), args);
      }
      default:
        return undefined;
    }
  }

  if (typeName === 'Ref') {
    if (field === 'name') return String(record.name ?? '');
    if (field === 'prefix') return 'refs/heads/';
    return undefined;
  }

  if (typeName === 'Issue') {
    const issue = record.issue as Issue;
    const repo = record.repo as Repo;
    switch (field) {
      case 'id':
        return globalId('Issue', `${repo.id}:${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'url':
        return `http://forge/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'author':
        return tagged('User', { login: VIEWER.login });
      case 'closed':
        return issue.state === 'closed';
      case 'createdAt':
        return isoOfSeq(issue.seq);
      case 'updatedAt':
        return isoOfSeq(issue.seq);
      case 'repository':
        return repoValue(repo);
      case 'labels':
        return connection('LabelConnection', issue.labels.map((name) => tagged('Label', { name })), args);
      case 'comments':
        return connection(
          'IssueCommentConnection',
          issue.comments.map((comment) => tagged('IssueComment', { comment, repo, issue })),
          args,
        );
      default:
        return undefined;
    }
  }

  if (typeName === 'PullRequest') {
    const pull = record.pull as Pull;
    const repo = record.repo as Repo;
    switch (field) {
      case 'id':
        return globalId('PullRequest', `${repo.id}:${pull.number}`);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.merged ? isoOfSeq(pull.mergedSeq) : null;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pullMergeable(repo, pull);
      case 'author':
        return tagged('User', { login: VIEWER.login });
      case 'url':
        return `http://forge/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'createdAt':
        return isoOfSeq(pull.seq);
      case 'updatedAt':
        return isoOfSeq(pull.seq);
      case 'repository':
        return repoValue(repo);
      case 'mergeCommit':
        return pull.mergeCommitSha ? tagged('Commit', { oid: pull.mergeCommitSha }) : null;
      case 'files': {
        const files = pullFiles(repo, pull).map((file) =>
          tagged('PullRequestChangedFile', {
            path: String(file.filename),
            additions: Number(file.additions),
            deletions: Number(file.deletions),
            changeType: String(file.status).toUpperCase(),
          }),
        );
        return connection('PullRequestChangedFileConnection', files, args);
      }
      default:
        return undefined;
    }
  }

  if (typeName === 'IssueComment') {
    const comment = record.comment as { id: number; body: string; seq: number };
    switch (field) {
      case 'id':
        return globalId('IssueComment', String(comment.id));
      case 'body':
        return comment.body;
      case 'author':
        return tagged('User', { login: VIEWER.login });
      case 'createdAt':
        return isoOfSeq(comment.seq);
      case 'updatedAt':
        return isoOfSeq(comment.seq);
      default:
        return undefined;
    }
  }

  if (typeName === '__Type') {
    const name = String(record.name ?? '');
    switch (field) {
      case 'name':
        return name;
      case 'kind':
        return name in ENUM_VALUES ? 'ENUM' : 'OBJECT';
      case 'description':
        return null;
      case 'fields':
        return (TYPE_FIELDS[name] ?? []).map((fieldName) => tagged('__Field', { name: fieldName }));
      case 'enumValues':
        return (ENUM_VALUES[name] ?? []).map((valueName) => tagged('__EnumValue', { name: valueName }));
      case 'possibleTypes':
        return [];
      case 'inputFields':
        return [];
      case 'ofType':
        return null;
      default:
        return undefined;
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field === 'name') return String(record.name ?? '');
    if (field === 'description') return null;
    if (field === 'isDeprecated') return false;
    if (field === 'type') return tagged('__Type', { name: 'String' });
    return undefined;
  }

  if (typeName === '__Schema') {
    if (field === 'queryType') return tagged('__Type', { name: 'Query' });
    if (field === 'mutationType') return tagged('__Type', { name: 'Mutation' });
    if (field === 'types') return Object.keys(TYPE_FIELDS).map((name) => tagged('__Type', { name }));
    if (field === 'directives') return [];
    return undefined;
  }

  // Payloads, connections, edges and page info carry their data as plain fields.
  if (field in record) return record[field] as GqlValue;
  return undefined;
}

const KNOWN_TYPES = new Set([...Object.keys(TYPE_FIELDS), 'Edge', 'Label', 'LabelConnection', 'IssueCommentConnection', 'Commit']);

function completeValue(value: GqlValue, selection: SelectionNode[] | null, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, ctx));
  if (typeof value !== 'object') return value;
  const typeName = (value as Record<string, unknown>).__type as string;
  if (!selection) return {};
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'inlineFragment') {
      if (node.typeCondition === typeName || node.typeCondition === '') {
        const inner = completeValue(value, node.selection, ctx) as Record<string, unknown>;
        Object.assign(out, inner);
      }
      continue;
    }
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const args = new Map<string, unknown>();
    for (const [argName, argValue] of node.args) args.set(argName, resolveValue(argValue, ctx.variables));
    const resolved = resolveField(typeName, value, node.name, args, ctx);
    if (resolved === undefined) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(resolved, node.selection, ctx);
  }
  return out;
}

function executeOperation(operation: Operation, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = tagged(rootType === 'Mutation' ? 'Mutation' : 'Query', {});
  const data = completeValue(root, operation.selection, ctx);
  const result: { data: unknown; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------------------------------------
// the HTTP endpoint

interface GqlRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeRequest(request: GqlRequest): { data: unknown; errors?: Array<{ message: string }> } {
  const query = typeof request.query === 'string' ? request.query : '';
  if (query === '') return { data: null, errors: [{ message: 'A query string is required' }] };
  let operations: Operation[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'No operation found' }] };
  let operation = operations[0] as Operation;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = operations.find((candidate) => candidate.name === request.operationName) ?? operation;
  }
  const variables = typeof request.variables === 'object' && request.variables !== null ? (request.variables as Record<string, unknown>) : {};
  return executeOperation(operation, variables);
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => executeRequest((entry ?? {}) as GqlRequest)));
    return;
  }
  sendJson(res, 200, executeRequest((parsed ?? {}) as GqlRequest));
}
