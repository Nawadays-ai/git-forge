// The REST v3 surface: repositories, contents, branches, commits, labels, issues,
// comments and pull requests (with squash/merge). Everything reads and writes the
// shared store, so an object created here is the same object the git surface, the
// GraphQL endpoint and the MCP tools see.
//
// Conventions (the suite's contract): creation answers 201, a repo delete 204, a
// stale contents sha 409, an unknown issue label 422, a conflicted merge 405, and
// every error body is a JSON object with a string `message`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  buildCommitData,
  buildTreeFromFiles,
  createRepo,
  filesAtCommit,
  findRepo,
  flattenTree,
  getCommit,
  isoOfSeq,
  mergeBase,
  mergeFileMaps,
  nextCommentId,
  nextIssueId,
  nextSeq,
  parseCommit,
  parseTree,
  peelToCommit,
  refCommit,
  repos,
  setRef,
  storeObject,
  ZERO_OID,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { authorized, notFound, sendJson, sendJsonText, unauthorized } from './app.ts';

type Json = Record<string, unknown>;

function message(res: ServerResponse, status: number, text: string): void {
  sendJson(res, status, { message: text });
}

/** Parse a JSON request body: `{}` for an empty body, null (and a 400 sent) for malformed JSON. */
function parseBody(res: ServerResponse, body: Buffer): Json | null {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Json;
  } catch {
    message(res, 400, 'Problems parsing JSON');
    return null;
  }
}

function stringField(body: Json, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function userObject(): Json {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

export function repoObject(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOfSeq(repo.seq),
    updated_at: isoOfSeq(repo.seq),
    html_url: `http://forge/${repo.owner}/${repo.name}`,
    clone_url: `http://forge/${repo.owner}/${repo.name}.git`,
  };
}

function labelObject(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return { id: 0, name, color: label?.color ?? 'ededed', description: label?.description ?? '', default: false };
}

export function issueObject(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelObject(repo, name)),
    user: userObject(),
    comments: issue.comments.length,
    created_at: isoOfSeq(issue.seq),
    updated_at: isoOfSeq(issue.seq),
    html_url: `http://forge/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/**
 * The issue's REST representation, serialized — cached on the issue itself and
 * reused while `issue.jsonVersion` stands. Every handler that mutates an issue
 * bumps that version (the REST edit and comment routes below, and the GraphQL
 * close and comment mutations), and a label's name, color and description never
 * change after the label is created, so the serialized form — labels embedded —
 * is a pure function of the issue at its version. The read workload re-reads one
 * issue thousands of times; without this it re-serializes the same object, and
 * re-derives every label object in it, on every request.
 */
export function issueJson(repo: Repo, issue: Issue): string {
  const cached = issue.jsonCache;
  if (cached !== undefined && cached.version === issue.jsonVersion) return cached.text;
  const text = JSON.stringify(issueObject(repo, issue));
  issue.jsonCache = { version: issue.jsonVersion, text };
  return text;
}

/** Mark an issue mutated: its cached serialization no longer stands. */
export function touchIssue(issue: Issue): void {
  issue.jsonVersion += 1;
}

function branchTip(repo: Repo, branch: string): string | null {
  return refCommit(repo, `refs/heads/${branch}`);
}

export function pullObject(repo: Repo, pull: Pull): Json {
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userObject(),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, user: userObject() },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, user: userObject() },
    merged: pull.merged,
    merged_at: pull.merged ? isoOfSeq(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: isoOfSeq(pull.seq),
    updated_at: isoOfSeq(pull.merged ? pull.mergedSeq : pull.seq),
    html_url: `http://forge/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

interface Page {
  page: number;
  perPage: number;
}

function pageOf(url: URL): Page {
  const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function paginate<T>(items: readonly T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

/** A Link header for the next page, when one exists (absolute, on the request's own origin). */
function nextLink(req: IncomingMessage, url: URL, page: Page, total: number): Record<string, string> {
  if (page.page * page.perPage >= total) return {};
  const host = req.headers.host ?? 'forge';
  const next = new URL(url.pathname, `http://${host}`);
  next.searchParams.set('per_page', String(page.perPage));
  next.searchParams.set('page', String(page.page + 1));
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  const last = new URL(url.pathname, `http://${host}`);
  last.searchParams.set('per_page', String(page.perPage));
  last.searchParams.set('page', String(lastPage));
  return { link: `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"` };
}

// ---------------------------------------------------------------------------------------------
// commits over the object store

/** Walk a branch (or sha) history, newest first by traversal order. */
function listCommits(repo: Repo, startOid: string): Array<{ sha: string; view: ReturnType<typeof parseCommit> }> {
  const out: Array<{ sha: string; view: ReturnType<typeof parseCommit> }> = [];
  const seen = new Set<string>();
  const stack = [startOid];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    seen.add(oid);
    out.push({ sha: oid, view: commit });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

function commitObject(repo: Repo, sha: string, view: ReturnType<typeof parseCommit>): Json {
  const authorLine = view.author;
  const match = /^(.*) <(.*)> (\d+)/.exec(authorLine);
  return {
    sha,
    commit: {
      message: view.message.replace(/\n$/, ''),
      tree: { sha: view.tree },
      author: { name: match?.[1] ?? '', email: match?.[2] ?? '', date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString() },
      committer: { name: match?.[1] ?? '', email: match?.[2] ?? '', date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString() },
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
    author: userObject(),
    committer: userObject(),
  };
}

/** Resolve a ref-ish value (branch name or commit sha) to a commit oid. */
function resolveCommitish(repo: Repo, value: string): string | null {
  const byBranch = refCommit(repo, `refs/heads/${value}`);
  if (byBranch !== null) return byBranch;
  if (/^[0-9a-f]{40}$/.test(value)) {
    const peeled = peelToCommit(repo, value);
    if (peeled !== null) return peeled;
  }
  return null;
}

/** Commit `files` (path -> content, or null to delete) onto `branch`; returns the commit sha. */
function commitFiles(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, messageText: string): string {
  const ref = `refs/heads/${branch}`;
  const tip = refCommit(repo, ref);
  const files = filesAtCommit(repo, tip);
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, { oid: storeObject(repo, 'blob', content), mode: '100644' });
  }
  const tree = buildTreeFromFiles(repo, files);
  const seq = nextSeq();
  const commit = storeObject(repo, 'commit', buildCommitData(tree, tip !== null ? [tip] : [], messageText, seq));
  setRef(repo, ref, commit);
  return commit;
}

// ---------------------------------------------------------------------------------------------
// the router

export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  // segments: ['api', 'v3', ...]
  const tail = segments.slice(2);

  if (!authorized(req)) {
    unauthorized(res);
    return;
  }

  if (tail.length === 0 && method === 'GET') {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', current_user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, user' },
    );
    return;
  }
  if (tail.length === 1 && tail[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', api_version: '3' });
    return;
  }
  if (tail.length === 1 && tail[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userObject());
    return;
  }
  if (tail[0] === 'user' && tail[1] === 'repos' && tail.length === 2) {
    if (method === 'GET') {
      const page = pageOf(url);
      const all = [...repos.values()].sort((a, b) => a.id - b.id);
      sendJson(res, 200, paginate(all, page).map(repoObject), nextLink(req, url, page, all.length));
      return;
    }
    if (method === 'POST') {
      const parsed = parseBody(res, body);
      if (parsed === null) return;
      const name = stringField(parsed, 'name');
      if (name === undefined || name === '' || name.includes('/') || name.endsWith('.git')) {
        message(res, 422, 'Repository creation failed: name is invalid');
        return;
      }
      if (repos.has(name)) {
        message(res, 422, `Repository creation failed: name already exists on this account`);
        return;
      }
      const repo = createRepo(name, stringField(parsed, 'description') ?? '', parsed.private !== false);
      sendJson(res, 201, repoObject(repo));
      return;
    }
  }

  if (tail[0] === 'repos' && tail.length >= 3) {
    const owner = tail[1] as string;
    const name = tail[2] as string;
    const repo = findRepo(owner, name);
    if (!repo) {
      notFound(res);
      return;
    }
    const rest = tail.slice(3);
    routeRepo(req, res, url, body, repo, rest);
    return;
  }

  notFound(res);
}

function routeRepo(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer, repo: Repo, rest: string[]): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoObject(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseBody(res, body);
      if (parsed === null) return;
      const description = stringField(parsed, 'description');
      if (description !== undefined) repo.description = description;
      const renamed = stringField(parsed, 'name');
      if (renamed !== undefined && renamed !== repo.name && !repos.has(renamed)) {
        repos.delete(repo.name);
        repo.name = renamed;
        repos.set(renamed, repo);
      }
      if (typeof parsed.private === 'boolean') repo.private = parsed.private;
      if (typeof parsed.has_issues === 'boolean') {
        // Accepted and ignored: issues are always enabled on this forge.
      }
      sendJson(res, 200, repoObject(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repo.name);
      res.writeHead(204, { 'x-github-request-id': `forge-${nextSeq().toString(36)}` });
      res.end();
      return;
    }
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseBody(res, body);
      if (parsed === null) return;
      const ref = stringField(parsed, 'ref');
      const sha = stringField(parsed, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
        message(res, 422, 'Invalid ref or sha');
        return;
      }
      if (!repo.objects.has(sha)) {
        message(res, 422, `Object ${sha} does not exist`);
        return;
      }
      if (repo.refs.has(ref)) {
        message(res, 422, `Reference already exists: ${ref}`);
        return;
      }
      setRef(repo, ref, sha);
      sendJson(res, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref, node_id: `REF_${ref}`, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
      return;
    }
  }

  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches: Json[] = [];
      for (const [ref, oid] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
      branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sendJson(res, 200, branches);
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
      return;
    }
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const start = shaParam !== null ? resolveCommitish(repo, shaParam) : refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (start === null) {
      message(res, 409, 'Git Repository is empty.');
      return;
    }
    const page = pageOf(url);
    const all = listCommits(repo, start);
    sendJson(res, 200, paginate(all, page).map((entry) => commitObject(repo, entry.sha, entry.view)));
    return;
  }

  if (rest[0] === 'contents') {
    routeContents(req, res, url, body, repo, rest.slice(1).join('/'));
    return;
  }

  if (rest[0] === 'labels') {
    routeLabels(req, res, body, repo, rest);
    return;
  }

  if (rest[0] === 'issues') {
    routeIssues(req, res, url, body, repo, rest);
    return;
  }

  if (rest[0] === 'pulls') {
    routePulls(req, res, url, body, repo, rest);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// contents

function routeContents(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer, repo: Repo, path: string): void {
  const method = req.method ?? 'GET';
  const refParam = url.searchParams.get('ref');

  if (method === 'GET') {
    const commitOid = refParam !== null ? resolveCommitish(repo, refParam) : refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (commitOid === null) {
      notFound(res);
      return;
    }
    const commit = getCommit(repo, commitOid);
    if (!commit) {
      notFound(res);
      return;
    }
    if (path === '') {
      sendJson(res, 200, directoryListing(repo, commit.tree, ''));
      return;
    }
    const found = lookupPath(repo, commit.tree, path);
    if (found === null) {
      notFound(res);
      return;
    }
    if (found.kind === 'dir') {
      sendJson(res, 200, directoryListing(repo, found.oid, path));
      return;
    }
    const blob = repo.objects.get(found.oid);
    if (!blob) {
      notFound(res);
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      name: path.split('/').pop(),
      path,
      sha: found.oid,
      size: blob.data.length,
    });
    return;
  }

  if (method === 'PUT') {
    const parsed = parseBody(res, body);
    if (parsed === null) return;
    const contentB64 = stringField(parsed, 'content');
    const messageText = stringField(parsed, 'message') ?? 'Update file';
    if (contentB64 === undefined || path === '') {
      message(res, 422, 'content and path are required');
      return;
    }
    const branch = stringField(parsed, 'branch') ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = refCommit(repo, ref);
    const existing = tip !== null ? filesAtCommit(repo, tip).get(path) : undefined;
    const givenSha = stringField(parsed, 'sha');
    if (existing !== undefined) {
      if (givenSha === undefined || givenSha !== existing.oid) {
        message(res, 409, `${path} has changed since ${givenSha ?? 'the version read'}`);
        return;
      }
    }
    const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobOid = storeObject(repo, 'blob', data);
    const commit = commitFiles(repo, branch, new Map([[path, data]]), messageText);
    sendJson(res, existing !== undefined ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit, message: messageText },
    });
    return;
  }

  if (method === 'DELETE') {
    const parsed = parseBody(res, body);
    if (parsed === null) return;
    const branch = stringField(parsed, 'branch') ?? repo.defaultBranch;
    const tip = refCommit(repo, `refs/heads/${branch}`);
    const existing = tip !== null ? filesAtCommit(repo, tip).get(path) : undefined;
    if (existing === undefined) {
      notFound(res);
      return;
    }
    const givenSha = stringField(parsed, 'sha');
    if (givenSha !== undefined && givenSha !== existing.oid) {
      message(res, 409, 'The sha does not match the current file');
      return;
    }
    const commit = commitFiles(repo, branch, new Map([[path, null]]), stringField(parsed, 'message') ?? 'Delete file');
    sendJson(res, 200, { content: null, commit: { sha: commit } });
    return;
  }

  notFound(res);
}

function lookupPath(repo: Repo, treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string } | null {
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function directoryListing(repo: Repo, treeOid: string, prefix: string): Json[] {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return [];
  const entries: Json[] = [];
  for (const entry of parseTree(tree.data)) {
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : repo.objects.get(entry.oid);
    entries.push({
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: blob ? blob.data.length : 0,
    });
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return entries;
}

// ---------------------------------------------------------------------------------------------
// labels

function routeLabels(req: IncomingMessage, res: ServerResponse, body: Buffer, repo: Repo, rest: string[]): void {
  const method = req.method ?? 'GET';
  if (method === 'POST' && rest.length === 1) {
    const parsed = parseBody(res, body);
    if (parsed === null) return;
    const name = stringField(parsed, 'name');
    if (name === undefined || name === '') {
      message(res, 422, 'A label name is required');
      return;
    }
    if (repo.labels.has(name)) {
      message(res, 422, `Label ${name} already exists`);
      return;
    }
    repo.labels.set(name, { name, color: stringField(parsed, 'color') ?? 'ededed', description: stringField(parsed, 'description') ?? '' });
    sendJson(res, 201, labelObject(repo, name));
    return;
  }
  if (method === 'GET' && rest.length === 1) {
    sendJson(res, 200, [...repo.labels.keys()].map((name) => labelObject(repo, name)));
    return;
  }
  if (method === 'GET' && rest.length === 2) {
    const name = rest[1] as string;
    if (!repo.labels.has(name)) {
      notFound(res);
      return;
    }
    sendJson(res, 200, labelObject(repo, name));
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// issues and comments

function labelNamesOf(parsed: Json): string[] | null {
  const labels = parsed.labels;
  if (labels === undefined) return [];
  if (!Array.isArray(labels)) return null;
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as Json).name === 'string') names.push((entry as Json).name as string);
    else return null;
  }
  return names;
}

export function createIssue(repo: Repo, title: string, bodyText: string, labels: string[]): Issue | { error: string } {
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Label ${name} does not exist` };
  }
  const issue: Issue = {
    number: repo.nextNumber,
    id: nextIssueId(),
    title,
    body: bodyText,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: nextSeq(),
    jsonVersion: 0,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function routeIssues(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer, repo: Repo, rest: string[]): void {
  const method = req.method ?? 'GET';

  if (rest.length === 1) {
    if (method === 'POST') {
      const parsed = parseBody(res, body);
      if (parsed === null) return;
      const title = stringField(parsed, 'title');
      if (title === undefined || title === '') {
        message(res, 422, 'A title is required');
        return;
      }
      const labels = labelNamesOf(parsed);
      if (labels === null) {
        message(res, 422, 'Invalid labels');
        return;
      }
      const created = createIssue(repo, title, stringField(parsed, 'body') ?? '', labels);
      if ('error' in created) {
        message(res, 422, created.error);
        return;
      }
      sendJsonText(res, 201, issueJson(repo, created));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(issues, pageOf(url));
      sendJsonText(res, 200, `[${page.map((issue) => issueJson(repo, issue)).join(',')}]`);
      return;
    }
  }

  const number = Number.parseInt(rest[1] ?? '', 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 2 && issue !== undefined) {
    if (method === 'GET') {
      sendJsonText(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseBody(res, body);
      if (parsed === null) return;
      // Bump before applying anything: the fields below are applied one by one
      // and a later label check can still refuse the request, so the cached
      // serialization must fall the moment any field may have moved.
      touchIssue(issue);
      const state = stringField(parsed, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = stringField(parsed, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = stringField(parsed, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      const labels = labelNamesOf(parsed);
      if (labels !== null && parsed.labels !== undefined) {
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            message(res, 422, `Label ${name} does not exist`);
            return;
          }
        }
        issue.labels = labels;
      }
      sendJsonText(res, 200, issueJson(repo, issue));
      return;
    }
  }

  if (rest.length === 3 && rest[2] === 'comments' && issue !== undefined) {
    if (method === 'POST') {
      const parsed = parseBody(res, body);
      if (parsed === null) return;
      const bodyText = stringField(parsed, 'body');
      if (bodyText === undefined) {
        message(res, 422, 'A comment body is required');
        return;
      }
      const comment = { id: nextCommentId(), body: bodyText, seq: nextSeq() };
      issue.comments.push(comment);
      touchIssue(issue);
      sendJson(res, 201, commentObject(issue, comment));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentObject(issue, comment)));
      return;
    }
  }

  notFound(res);
}

function commentObject(issue: Issue, comment: { id: number; body: string; seq: number }): Json {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userObject(),
    created_at: isoOfSeq(comment.seq),
    updated_at: isoOfSeq(comment.seq),
    issue_url: `http://forge/issues/${issue.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// pull requests

export function createPull(repo: Repo, title: string, bodyText: string, head: string, base: string): Pull | { error: string; status: number } {
  const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
  const baseBranch = base.includes(':') ? (base.split(':').pop() as string) : base;
  if (refCommit(repo, `refs/heads/${headBranch}`) === null) return { error: `Head branch ${headBranch} does not exist`, status: 422 };
  if (refCommit(repo, `refs/heads/${baseBranch}`) === null) return { error: `Base branch ${baseBranch} does not exist`, status: 422 };
  for (const existing of repo.pulls.values()) {
    if (existing.headRef === headBranch && existing.baseRef === baseBranch && existing.state === 'open') {
      return { error: `A pull request already exists for ${headBranch} into ${baseBranch}`, status: 422 };
    }
  }
  const pull: Pull = {
    number: repo.nextNumber,
    id: nextIssueId(),
    title,
    body: bodyText,
    state: 'open',
    headRef: headBranch,
    baseRef: baseBranch,
    merged: false,
    mergeCommitSha: null,
    mergedSeq: 0,
    seq: nextSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Above this many cells, the LCS length is computed with a two-row table instead. */
const DIFF_TABLE_LIMIT = 4_194_304;

/** Length of the longest common subsequence of two line arrays. */
function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  if ((m + 1) * (n + 1) <= DIFF_TABLE_LIMIT) {
    const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i * (n + 1) + j] = a[i] === b[j] ? (dp[(i + 1) * (n + 1) + j + 1] as number) + 1 : Math.max(dp[(i + 1) * (n + 1) + j] as number, dp[i * (n + 1) + j + 1] as number);
      }
    }
    return dp[0] as number;
  }
  // The same recurrence evaluated with two rows: identical result, O(n) memory
  // instead of a quadratic table of numbers (a 10k-by-10k table is ~800 MB).
  let below = new Uint32Array(n + 1);
  let row = new Uint32Array(n + 1);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
    [below, row] = [row, below];
  }
  return below[0] as number;
}

/** Line counts of a text diff (LCS over lines). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Identical leading and trailing lines belong to every longest common
  // subsequence, so trimming them before the quadratic step never changes the
  // counts — and a small edit inside a large file stops costing a full
  // (m+1)*(n+1) table.
  let start = 0;
  const minLength = Math.min(oldLines.length, newLines.length);
  while (start < minLength && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const trimmed = start + (oldLines.length - oldEnd);
  const common = trimmed + lcsLength(oldLines.slice(start, oldEnd), newLines.slice(start, newEnd));
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export function pullFiles(repo: Repo, pull: Pull): Json[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const from = filesAtCommit(repo, base);
  const to = filesAtCommit(repo, headTip);
  const files: Json[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before ? (repo.objects.get(before.oid)?.data.toString('utf8') ?? '') : '';
    const newText = after ? (repo.objects.get(after.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.oid ?? before?.oid ?? ZERO_OID,
    });
  }
  return files;
}

/** Merge a pull request into its base branch. Returns the merge commit sha, or a failure. */
export function mergePull(repo: Repo, pull: Pull, method: string): { sha: string } | { error: string; status: number } {
  if (pull.state !== 'open') return { error: 'Pull Request is not open', status: 405 };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { error: 'A branch is missing', status: 405 };
  const base = mergeBase(repo, baseTip, headTip);
  const mergedFiles = mergeFileMaps(filesAtCommit(repo, baseTip), filesAtCommit(repo, headTip), filesAtCommit(repo, base));
  if (mergedFiles === null) return { error: 'Pull Request is not mergeable: conflicts', status: 405 };
  const tree = buildTreeFromFiles(repo, mergedFiles);
  const seq = nextSeq();
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const messageText = method === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}` : `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}`;
  const commit = storeObject(repo, 'commit', buildCommitData(tree, parents, messageText, seq));
  setRef(repo, `refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commit;
  pull.mergedSeq = seq;
  return { sha: commit };
}

/** Whether a pull request would merge cleanly right now (GraphQL's mergeable). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  const merged = mergeFileMaps(filesAtCommit(repo, baseTip), filesAtCommit(repo, headTip), filesAtCommit(repo, base));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function routePulls(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer, repo: Repo, rest: string[]): void {
  const method = req.method ?? 'GET';

  if (rest.length === 1) {
    if (method === 'POST') {
      const parsed = parseBody(res, body);
      if (parsed === null) return;
      const title = stringField(parsed, 'title');
      const head = stringField(parsed, 'head');
      const base = stringField(parsed, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        message(res, 422, 'title, head and base are required');
        return;
      }
      const created = createPull(repo, title, stringField(parsed, 'body') ?? '', head, base);
      if ('error' in created) {
        message(res, created.status, created.error);
        return;
      }
      sendJson(res, 201, pullObject(repo, created));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      sendJson(res, 200, paginate(pulls, pageOf(url)).map((pull) => pullObject(repo, pull)));
      return;
    }
  }

  const number = Number.parseInt(rest[1] ?? '', 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 2) {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, pullObject(repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseBody(res, body);
      if (parsed === null) return;
      const state = stringField(parsed, 'state');
      if (state === 'closed' && pull.state === 'open') pull.state = 'closed';
      if (state === 'open' && pull.state === 'closed' && !pull.merged) pull.state = 'open';
      const title = stringField(parsed, 'title');
      if (title !== undefined) pull.title = title;
      sendJson(res, 200, pullObject(repo, pull));
      return;
    }
  }

  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    sendJson(res, 200, pullFiles(repo, pull));
    return;
  }

  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    const parsed = parseBody(res, body);
    if (parsed === null) return;
    const mergeMethod = stringField(parsed, 'merge_method') ?? 'merge';
    const result = mergePull(repo, pull, mergeMethod === 'merge' ? 'merge' : 'squash');
    if ('error' in result) {
      message(res, result.status, result.error);
      return;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  notFound(res);
}
