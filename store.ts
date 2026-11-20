// The forge's store: every repository's git objects, refs, labels, issues, pull requests
// and comments, held in memory. One process serves one trial and the suite always starts
// from an empty forge, so nothing is persisted; the maps below are the whole database.
//
// The git object helpers here (hashing, tree build/parse, reachability, ancestry) are
// shared by the smart-HTTP surface, the contents API and the merge machinery.

import { createHash } from 'node:crypto';
import { VIEWER } from './scenario.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  /**
   * Lazily filled by writePack in git.ts: the zlib stream of `data` at level 1.
   * An object is immutable once stored (its data is never reassigned or mutated
   * in place anywhere in the forge), so the cached stream stays valid for the
   * object's whole life and repeated packs of the same object reuse it verbatim.
   */
  deflated?: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  /**
   * Serialization bookkeeping for rest.ts's issue cache: `jsonVersion` is bumped by
   * every handler that mutates the issue (an edit, a state change, a label change,
   * a comment added), and `jsonCache` holds the REST representation serialized at
   * that version. A cached body is served only while the two agree.
   */
  jsonVersion: number;
  jsonCache?: { version: number; text: string };
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  seq: number;
  /**
   * A monotone counter bumped on every change a git-surface answer can observe:
   * an object inserted, a ref set or deleted. (The default branch never changes
   * after creation, and issues/pulls/labels are invisible to the git surface.)
   * git.ts keys its per-repository answer caches by it: a cached advertisement,
   * ls-refs or fetch answer is served only while the version stands.
   */
  version: number;
}

/** All repositories, keyed by name; every repository belongs to the token's owner. */
export const repos = new Map<string, Repo>();

let repoIdCounter = 0;
let issueIdCounter = 0;
let commentIdCounter = 0;
let seqCounter = 0;

/** A logical clock: a monotone sequence turned into deterministic ISO timestamps. */
export function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

const EPOCH_BASE_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's day one.

export function isoOfSeq(seq: number): string {
  return new Date((EPOCH_BASE_SEC + seq) * 1000).toISOString();
}

export function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  repoIdCounter += 1;
  const repo: Repo = {
    id: repoIdCounter,
    owner: VIEWER.login,
    name,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    seq: nextSeq(),
    version: 0,
  };
  repos.set(name, repo);
  return repo;
}

/** The repository `owner/name` for this token, or null (a foreign owner is a 404). */
export function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return repos.get(name) ?? null;
}

export function nextIssueId(): number {
  issueIdCounter += 1;
  return issueIdCounter;
}

export function nextCommentId(): number {
  commentIdCounter += 1;
  return commentIdCounter;
}

// ---------------------------------------------------------------------------------------------
// git objects

export const ZERO_OID = '0'.repeat(40);

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Insert an object the store does not hold yet (objects are content-addressed and
 * immutable, so an oid already present is never replaced) and bump the repo
 * version the git-surface caches key on. Returns whether the object was new.
 */
export function insertObject(repo: Repo, oid: string, object: GitObject): boolean {
  if (repo.objects.has(oid)) return false;
  repo.objects.set(oid, object);
  repo.version += 1;
  return true;
}

export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  insertObject(repo, oid, { type, data });
  return oid;
}

/** Set a ref and bump the repo version (a git-surface answer may observe it). */
export function setRef(repo: Repo, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
  repo.version += 1;
}

/** Delete a ref, bumping the repo version when the ref existed. */
export function deleteRef(repo: Repo, ref: string): void {
  if (repo.refs.delete(ref)) repo.version += 1;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/**
 * Parse caches keyed by the object data buffer itself. A stored object's data is
 * never mutated or replaced (the same invariant the zlib-stream cache in git.ts
 * relies on), and no caller mutates a returned view or entry list, so a parse is a
 * pure function of the buffer and can be reused for the buffer's whole life. The
 * WeakMap lets buffers the store has dropped (a deleted repository's objects) be
 * collected with their parses.
 */
const treeParseCache = new WeakMap<Buffer, TreeEntry[]>();
const commitParseCache = new WeakMap<Buffer, CommitView>();

export function parseTree(data: Buffer): TreeEntry[] {
  const cached = treeParseCache.get(data);
  if (cached !== undefined) return cached;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  // The cached result is shared by every reader for the buffer's whole life, so
  // it is frozen before it is stored: the audit of every call site (object
  // walks, tree flattening, contents lookups, listings) found readers only, and
  // the freeze turns any future in-place mutation of a shared parse into a loud
  // TypeError at the mutation site instead of a silent corruption of the cache.
  for (const entry of entries) Object.freeze(entry);
  Object.freeze(entries);
  treeParseCache.set(data, entries);
  return entries;
}

/** git's tree-entry order: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const cached = commitParseCache.get(data);
  if (cached !== undefined) return cached;
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const lines = data.subarray(0, headerEnd).toString('utf8').split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const view: CommitView = { tree, parents, author, committer, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  // Frozen for the same reason parseTree's result is (see there): the view and
  // its parent list are shared by every walk that touches this commit.
  Object.freeze(view.parents);
  Object.freeze(view);
  commitParseCache.set(data, view);
  return view;
}

export function parseTagTarget(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  let object = '';
  let type = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
  }
  return { object, type };
}

/** The identity REST-created commits carry: the token owner, at the logical clock. */
export function forgeIdentity(seq: number): string {
  const stamp = EPOCH_BASE_SEC + seq;
  return `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
}

export function buildCommitData(tree: string, parents: readonly string[], message: string, seq: number): Buffer {
  const identity = forgeIdentity(seq);
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`, `committer ${identity}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function getCommit(repo: Repo, oid: string): CommitView | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Peel a tag (or return a commit) to the commit it names; null when it is neither. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTagTarget(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a ref names (peeled), or null. */
export function refCommit(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  return peelToCommit(repo, oid);
}

/**
 * Every object reachable from `tips`. When a commit is in `stopAtCommits` it is included
 * with its tree, but its parents are not walked: that is a shallow client's boundary.
 */
export function collectReachable(repo: Repo, tips: Iterable<string>, stopAtCommits?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (stopAtCommits === undefined || !stopAtCommits.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTagTarget(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Every commit reachable from `tip` through parent links, `tip` included. */
export function commitAncestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    seen.add(oid);
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

/**
 * True when `ancestor` is `descendant` itself or one of its ancestors. The walk
 * stops the moment the ancestor is met: building the descendant's whole ancestry
 * set first (what this used to do) made every fast-forward check on a branch cost
 * a full history walk, so a chain of N pushes paid N history walks — quadratic in
 * the chain length.
 *
 * The two validations up front keep the early-exit's answers identical to the
 * old set-membership ones. The ancestry set only ever held commits that exist in
 * the store (commitAncestors adds an oid only when getCommit succeeds), so a
 * missing oid, the zero oid, a blob or a tree was never "an ancestor" — not even
 * of itself — and a parent entry naming an object the store does not hold was
 * never in the set either. Without the checks, the `ancestor === descendant`
 * shortcut and meeting a dangling parent mid-walk would both answer true where
 * the set answered false. Two cached parses keep the fast-forward fast path
 * (two real commits, met one step in) at O(1) before the walk starts.
 */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (getCommit(repo, ancestor) === null || getCommit(repo, descendant) === null) return false;
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The best common ancestor of two commits (least total distance), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = commitAncestors(repo, a);
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 0 }];
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// trees as path maps (contents API, diffs, merges)

/** Flatten a tree into path -> {oid, mode} for files (blobs) only. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Rebuild nested tree objects from a flat path -> blob oid map; returns the root tree oid. */
export function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

/** The flattened file map at a commit (empty for null). */
export function filesAtCommit(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
  if (commitOid === null) return new Map();
  const commit = getCommit(repo, commitOid);
  if (!commit) return new Map();
  return flattenTree(repo, commit.tree);
}

/**
 * Three-way merge of flattened file maps. Returns the merged map, or null on a conflict
 * (a path both sides changed differently, or changed on one side and deleted on the other).
 */
export function mergeFileMaps(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
  ancestor: ReadonlyMap<string, { oid: string; mode: string }>,
): Map<string, { oid: string; mode: string }> | null {
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...ancestor.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const a = ancestor.get(path);
    const sameBlob = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (sameBlob(h, b)) {
      if (b) merged.set(path, b);
    } else if (sameBlob(a, b)) {
      if (h) merged.set(path, h);
    } else if (sameBlob(a, h)) {
      if (b) merged.set(path, b);
    } else {
      return null;
    }
  }
  return merged;
}
