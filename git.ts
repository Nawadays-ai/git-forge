// The git smart-HTTP surface: ref advertisements (protocol v2 for upload-pack when the
// client asks, v0 otherwise and always for receive-pack), the v2 ls-refs and fetch
// commands, v0 fetch, and receive-pack pushes with report-status.
//
// Protocol choices the suite's client dictates:
//   - upload-pack answers v2 only when the Git-Protocol header asks for it; the v2
//     advertisement offers agent, ls-refs=unborn, fetch=shallow and object-format=sha1.
//   - fetch is a single round (the client sends `done` at once): an acknowledgments
//     section, a shallow-info section when a boundary moved, then the packfile in
//     sideband band 1. Packs carry plain objects, never deltas (the client resolves
//     deltas when sent, but does not require them).
//   - receive-pack advertises report-status, side-band-64k, delete-refs and ofs-delta;
//     the report stream rides band 1 when the client negotiates side-band-64k.
//   - updates are fast-forward only; the refusal reason is exactly "non-fast-forward".

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  buildTreeData,
  deleteRef,
  getCommit,
  hashObject,
  insertObject,
  isAncestor,
  parseCommit,
  parseTagTarget,
  parseTree,
  peelToCommit,
  setRef,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode pkt-lines from `body` starting at `start`; `next` is the offset just past the last packet read. */
export function decodePackets(body: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// packfiles

/** Inflate one zlib stream at `offset` in `buffer`; returns its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = (inflateSync as (chunk: Buffer, options: { info: true }) => { buffer: Buffer; engine: { bytesWritten: number } })(view, { info: true });
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta payload to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile into a map of resolved objects. Delta bases may live in the pack
 * itself or in the repository (a thin pack). Throws on any structural problem.
 */
export function readPack(repo: Repo, pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let value = (pack[offset] as number) & 0x7f;
      let b = pack[offset] as number;
      offset += 1;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  const resolved = new Map<string, GitObject>();
  const byOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObject => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid as string);
      let base: GitObject;
      if (baseEntry) base = resolve(baseEntry);
      else {
        const external = repo.objects.get(entry.baseOid as string) ?? resolved.get(entry.baseOid as string);
        if (!external) throw new Error('ref-delta base missing');
        base = external;
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    resolving.delete(entry.offset);
    const oid = hashObject(object.type, object.data);
    byOid.set(oid, entry);
    if (!resolved.has(oid)) resolved.set(oid, object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return resolved;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain objects (no deltas), with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    // Reuse the object's cached zlib stream when present: under concurrent
    // clones the same objects are packed again and again, and re-deflating
    // them per request is pure repeated CPU. The stream is a pure function of
    // the immutable object data, so the pack bytes (and the trailer checksum
    // computed over them below) are exactly what a fresh deflate would write.
    parts.push((object.deflated ??= deflateSync(object.data, { level: 1 })));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// advertisements

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const capabilities =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`
      : `multi_ack_detailed side-band-64k thin-pack ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refLines: string[] = [];
  if (headOid !== undefined) refLines.push(`${headOid} HEAD`);
  for (const [name, oid] of sortedRefs(repo)) {
    refLines.push(`${oid} ${name}`);
    const peeled = peeledOf(repo, oid);
    if (peeled !== null) refLines.push(`${peeled} ${name}^{}`);
  }
  if (refLines.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}`));
  } else {
    refLines.forEach((line, index) => {
      lines.push(pktLine(index === 0 ? `${line}\0${capabilities}` : line));
    });
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function v2Advertisement(service: string): Buffer {
  return Buffer.concat([
    pktLine(`# service=${service}\n`),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

export function handleInfoRefs(repo: Repo, service: string, version2: boolean): GitResponse {
  // The advertisement is a pure function of the refs (and the default branch,
  // which never changes after creation), so it is one of the answers the
  // version-keyed cache below replays verbatim while the repo version stands.
  const cache = gitCacheFor(repo).infoRefs;
  const key = `${service}|${version2 ? 'v2' : 'v0'}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const body = service === 'git-upload-pack' && version2 ? v2Advertisement(service) : v0Advertisement(repo, service);
  const answer: GitResponse = { status: 200, contentType: `application/x-${service}-advertisement`, body };
  cache.set(key, answer);
  return answer;
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsLines(repo: Repo, args: LsRefsArgs): string[] {
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const headMatches = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headMatches) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

interface FetchPlan {
  /** Commit oids to send, in BFS (newest-first) order, plus any tag objects. */
  sendCommits: string[];
  tagObjects: string[];
  /** Every object the client already holds (excluded commits and their snapshots). */
  heldObjects: ReadonlySet<string>;
  boundary: string[];
  unshallow: string[];
  common: string | null;
}

/**
 * Plan a fetch. The semantics that matter, all observable from the clients:
 *
 * - The exclusion set is the closure of the client's haves, except that a shallow
 *   have contributes only itself — its history is exactly what the client lacks.
 *   Nothing in the excluded commits' snapshots (trees and blobs) is re-sent either.
 * - Depth is always a total measured from the wants: depth N sends the N newest
 *   layers. A deepen fetch is just a fetch with a larger N against a client whose
 *   tip is both a want and a have; the want is still traversed, which is how the
 *   history below the client's tip is reached.
 * - Boundary commits are the deepest sent layer, plus client shallow commits we
 *   reached but did not expand; a shallow commit whose parents are all being sent
 *   (or were already had) is unshallowed instead.
 */
export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const isCommit = (oid: string): boolean => repo.objects.get(oid)?.type === 'commit';
  const clientShallow = new Set(args.shallow.filter(isCommit));
  const depth = args.depth !== null && args.depth > 0 ? args.depth : null;
  const common = args.haves.find((oid) => isCommit(oid)) ?? null;

  // Wants may name annotated tags: peel them for traversal, send the tag objects too.
  const tagObjects: string[] = [];
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    let current = want;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = repo.objects.get(current);
      if (!object) break;
      if (object.type === 'tag') {
        tagObjects.push(current);
        current = parseTagTarget(object.data).object;
        continue;
      }
      break;
    }
    if (isCommit(current) && !wantCommits.includes(current)) wantCommits.push(current);
  }
  const wantSet = new Set(wantCommits);

  // Exclusion: closure of the haves, never expanding a shallow have.
  const excluded = new Set<string>();
  {
    const stack = args.haves.filter(isCommit);
    while (stack.length) {
      const oid = stack.pop() as string;
      if (excluded.has(oid)) continue;
      excluded.add(oid);
      if (clientShallow.has(oid)) continue;
      const commit = getCommit(repo, oid);
      if (commit) stack.push(...commit.parents);
    }
  }

  // Everything the client holds: the excluded commits plus their whole snapshots.
  const heldObjects = new Set<string>(excluded);
  {
    const stack: string[] = [];
    for (const oid of excluded) {
      const commit = getCommit(repo, oid);
      if (commit) stack.push(commit.tree);
    }
    while (stack.length) {
      const oid = stack.pop() as string;
      if (heldObjects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      heldObjects.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  }

  // Window BFS by generation from the wants; the deepest layer is generation depth-1.
  const limit = depth === null ? Number.POSITIVE_INFINITY : depth - 1;
  const generations = new Map<string, number>();
  const expanded = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = wantCommits.map((oid) => ({ oid, gen: 0 }));
  while (queue.length) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    const previous = generations.get(oid);
    if (previous !== undefined && previous <= gen) continue;
    generations.set(oid, gen);
    if (gen > limit) continue;
    const blocked = (excluded.has(oid) || clientShallow.has(oid)) && !wantSet.has(oid);
    if (blocked || gen >= limit) continue;
    expanded.add(oid);
    for (const parent of commit.parents) {
      if (isCommit(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  const sendCommits: string[] = [];
  const boundary = new Set<string>();
  const unshallow = new Set<string>();
  for (const [oid, gen] of generations) {
    if (gen > limit) continue;
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    if (!excluded.has(oid)) sendCommits.push(oid);
    const parentsSentOrHad = commit.parents.every((parent) => excluded.has(parent) || (generations.has(parent) && !excluded.has(parent)));
    if (clientShallow.has(oid) && parentsSentOrHad) unshallow.add(oid);
    if (depth !== null && gen === limit && !excluded.has(oid)) boundary.add(oid);
    if (clientShallow.has(oid) && !unshallow.has(oid)) boundary.add(oid);
  }
  sendCommits.sort((a, b) => (generations.get(a) ?? 0) - (generations.get(b) ?? 0) || (a < b ? -1 : 1));
  return {
    sendCommits,
    tagObjects: tagObjects.filter((oid) => repo.objects.has(oid) && !heldObjects.has(oid)),
    heldObjects,
    boundary: [...boundary].sort(),
    unshallow: [...unshallow].sort(),
    common,
  };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return packets;
}

function fetchPack(repo: Repo, plan: FetchPlan): Buffer {
  const objects: GitObject[] = [];
  const seen = new Set<string>();
  const push = (oid: string): void => {
    if (seen.has(oid) || plan.heldObjects.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    seen.add(oid);
    objects.push(object);
  };
  const addTree = (treeOid: string): void => {
    if (seen.has(treeOid)) return;
    push(treeOid);
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else push(entry.oid);
    }
  };
  for (const oid of plan.sendCommits) {
    push(oid);
    const commit = getCommit(repo, oid);
    if (commit) addTree(commit.tree);
  }
  for (const oid of plan.tagObjects) push(oid);
  return writePack(objects);
}

function v2FetchResponse(repo: Repo, plan: FetchPlan, done: boolean): Buffer {
  const parts: Buffer[] = [];
  // With `done` in the request the negotiation is over: real git goes straight to
  // the packfile sections and refuses an acknowledgments section, and so do we.
  // Without it, the acknowledgments section is the whole answer.
  if (!done) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  if (plan.boundary.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(fetchPack(repo, plan)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
  parts.push(...sidebandPackets(fetchPack(repo, plan)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// git-surface answers, reused

/**
 * The clone-phase answers — the info/refs advertisement, the v2 ls-refs reply
 * and the fetch reply — are pure functions of the repository's objects and refs
 * (fetch planning reads the objects alone; the advertisement and ls-refs read
 * the refs and the default branch, which is set once at creation and never
 * changes). The store is append-only and content-addressed, and store.ts bumps
 * `repo.version` on every object insert and every ref set or delete, so the
 * version names the state exactly: while it stands, a computed answer can be
 * replayed byte for byte, and the moment it moves every cached answer is
 * dropped at once (which also bounds how long a burst's answers are retained).
 * A burst of identical requests (concurrent clones of one tip) therefore reuses
 * the first answer's bytes instead of replanning, repacking and re-serializing
 * per request. Only a handful of answers are kept per repository, oldest first
 * out. Fetch keys carry their protocol: the v2 and v0 request shapes are
 * dispatched on the body's first line, but the key says which planner produced
 * the answer, so no two protocols can ever share an entry.
 */
interface RepoGitCache {
  version: number;
  fetch: Map<string, GitResponse>;
  infoRefs: Map<string, GitResponse>;
  lsRefs: Map<string, GitResponse>;
}

const repoGitCaches = new WeakMap<Repo, RepoGitCache>();
const FETCH_ANSWER_CACHE_MAX = 4;
const LS_REFS_CACHE_MAX = 8;

/** The repo's answer cache, reset wholesale whenever the repo version has moved. */
function gitCacheFor(repo: Repo): RepoGitCache {
  let cache = repoGitCaches.get(repo);
  if (cache === undefined || cache.version !== repo.version) {
    cache = { version: repo.version, fetch: new Map(), infoRefs: new Map(), lsRefs: new Map() };
    repoGitCaches.set(repo, cache);
  }
  return cache;
}

function cachedFetchAnswer(repo: Repo, protocol: 'v2' | 'v0', body: Buffer, compute: () => GitResponse): GitResponse {
  const cache = gitCacheFor(repo).fetch;
  const key = `${protocol}|${createHash('sha1').update(body).digest('hex')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const answer = compute();
  if (answer.status === 200) {
    cache.set(key, answer);
    while (cache.size > FETCH_ANSWER_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  return answer;
}

// ---------------------------------------------------------------------------------------------
// upload-pack / receive-pack POSTs

export function handleUploadPack(repo: Repo, body: Buffer): GitResponse {
  const { packets } = decodePackets(body);
  const lines = packetLines(packets);
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (first === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/\n$/, '');
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    // The reply is a function of the refs, the default branch and these args:
    // replay it while the repo version stands (see the cache's note above).
    const cache = gitCacheFor(repo).lsRefs;
    const key = JSON.stringify([args.peel, args.symrefs, args.unborn, args.prefixes]);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const out = lsRefsLines(repo, args).map((line) => pktLine(`${line}\n`));
    out.push(PKT_FLUSH);
    const answer: GitResponse = { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
    cache.set(key, answer);
    while (cache.size > LS_REFS_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return answer;
  }
  if (first === 'command=fetch') {
    const args = parseFetchArgs(lines);
    return cachedFetchAnswer(repo, 'v2', body, () => {
      const plan = planFetch(repo, args);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(repo, plan, args.done) };
    });
  }
  if (first.startsWith('want ')) {
    return cachedFetchAnswer(repo, 'v0', body, () => {
      const plan = planFetch(repo, parseFetchArgs(lines));
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(repo, plan) };
    });
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from('unsupported upload-pack request\n') };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  const { packets, next } = decodePackets(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }

  let unpackError: string | null = null;
  const packStart = sawFlush ? next : body.length;
  if (packStart < body.length && body.subarray(packStart, packStart + 4).toString('ascii') === 'PACK') {
    try {
      const objects = readPack(repo, body.subarray(packStart));
      for (const [oid, object] of objects) insertObject(repo, oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (packStart < body.length && commands.some((command) => command.newOid !== ZERO_OID)) {
    // Trailing bytes that do not start a packfile: the push body is malformed.
    unpackError = 'no packfile received';
  }
  // No trailing bytes at all is a legal ref-only push: a new branch or tag pointing
  // at a commit the server already has (some clients omit the packfile entirely in
  // that case), or pure ref deletions. There is nothing to unpack, and
  // applyPushCommand verifies each new oid exists in the store before applying it.

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    results.push(applyPushCommand(repo, command));
  }

  const reportParts: Buffer[] = [pktLine(unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n')];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);

  let responseBody: Buffer;
  if (capabilities.split(' ').includes('side-band-64k')) {
    const chunks: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
    }
    chunks.push(PKT_FLUSH);
    responseBody = Buffer.concat(chunks);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

function applyPushCommand(repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const { ref, oldOid, newOid } = command;
  if (!ref.startsWith('refs/')) return { ref, ok: false, reason: 'invalid ref' };
  const current = repo.refs.get(ref) ?? ZERO_OID;

  if (newOid === ZERO_OID) {
    deleteRef(repo, ref);
    return { ref, ok: true, reason: '' };
  }
  const newObject = repo.objects.get(newOid);
  if (!newObject) return { ref, ok: false, reason: 'new object not found' };

  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID && current !== newOid) return { ref, ok: false, reason: 'reference already exists' };
    setRef(repo, ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
  if (ref.startsWith('refs/heads/')) {
    const oldCommit = peelToCommit(repo, oldOid);
    const newCommit = peelToCommit(repo, newOid);
    if (newCommit === null) return { ref, ok: false, reason: 'new value is not a commit' };
    if (oldCommit !== null && oldCommit !== newCommit && !isAncestor(repo, oldCommit, newCommit)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  setRef(repo, ref, newOid);
  return { ref, ok: true, reason: '' };
}

// ---------------------------------------------------------------------------------------------
// startup warm-up

/**
 * A few hundred iterations over the helpers every request path exercises —
 * hashing, commit and tree parsing, tree building, pack writing, packet
 * framing, JSON — on fixed synthetic data, run once before the server accepts
 * (main.ts calls it before createApp). V8 tiers functions up as they run;
 * without this, the first requests a fresh process serves — which is all a
 * benchmark's opening rounds are — pay the interpreter-to-compiler climb that
 * steady-state requests do not. The data is synthetic and local, nothing is
 * stored anywhere, and the result is discarded.
 */
export function warmUp(): void {
  const blob = Buffer.alloc(1024, 0x61);
  const blobOid = hashObject('blob', blob);
  const treeData = buildTreeData([
    { mode: '100644', name: 'a.ts', oid: blobOid },
    { mode: '100644', name: 'b.ts', oid: blobOid },
    { mode: '40000', name: 'src', oid: blobOid },
  ]);
  const treeOid = hashObject('tree', treeData);
  const commitData = Buffer.from(
    `tree ${treeOid}\nauthor Dev <dev@example.com> 1700000000 +0000\ncommitter Dev <dev@example.com> 1700000000 +0000\n\nwarm-up\n`,
    'utf8',
  );
  const objects: GitObject[] = [
    { type: 'blob', data: blob },
    { type: 'tree', data: treeData },
  ];
  const sample = { title: 'Warm-up issue', body: 'x'.repeat(256), labels: [{ name: 'bug', color: 'd73a4a' }] };
  let sink = 0;
  for (let i = 0; i < 300; i += 1) {
    const commit = parseCommit(commitData);
    const tree = parseTree(treeData);
    const pack = writePack(objects);
    const line = pktLine(`${blobOid} HEAD\0report-status\n`);
    const text = JSON.stringify(sample);
    sink += commit.parents.length + tree.length + pack.length + line.length + text.length + hashObject('blob', blob).length;
  }
  if (sink === 0) throw new Error('unreachable');
}
