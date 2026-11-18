# github-core-clone-01 — a GitHub-compatible git forge in one process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Nawadays-ai/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Nawadays-ai/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone forge that speaks the four surfaces of GitHub's API from a single
Node process and a single in-memory store — no git binary, no external service,
no UI:

- **Git smart HTTP** — upload-pack protocol v2 (`ls-refs`, `fetch`) and v0,
  receive-pack v0 with per-ref status reports: clone, fetch (incremental,
  shallow, deepen, unshallow), push (fast-forward only, including ref-only
  pushes that carry no packfile), annotated tags.
- **REST v3** at `/api/v3` — repositories (CRUD, pagination), git refs,
  branches, commits, contents (read/write/delete), labels, issues and comments,
  pull requests with changed-files diffs and three-way squash/merge.
- **GraphQL v4** at `/api/graphql` — viewer and repository reads, issue and
  pull-request connections with cursor pagination, introspection (`__type`),
  Relay `node(id:)` and `nodes(ids:)` with opaque global ids, `rateLimit`,
  named fragments, batched operations, and the create/close/merge/comment
  mutations.
- **MCP** at `/mcp` — streamable-HTTP JSON-RPC speaking the modern
  `server/discover` era (with the legacy `initialize` handshake kept), and six
  tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

## Running it

The platform starts the program as `node /bot/main.ts` (Node ≥ 22.18, type
stripping; standard library only, nothing to install). The process binds an
ephemeral port itself, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`,
serves until the env's `/done` poll answers true, and exits 0. Requests are
authorized by the bearer token in `MAKEFUN_SHOP_TOKEN`.

Locally: `npm start` with `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` set.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | The entry↔env lifecycle: bind port 0, register, poll done, exit 0. |
| `app.ts` | The HTTP server and routing; the cross-surface rules (JSON everywhere, request ids, 401/404 shapes). |
| `store.ts` | The shared in-memory store: repositories, the git object store, refs, issues, pulls, and the tree/commit helpers every surface uses. |
| `git.ts` | The smart-HTTP protocol: pkt-lines, pack read/write (OFS/REF deltas on read), fetch planning, push handling. |
| `rest.ts` | The REST v3 resources, plus the issue/pull operations the other surfaces share. |
| `graphql.ts` | A small GraphQL lexer/parser/executor for the schema above. |
| `mcp.ts` | The MCP endpoint and its six tools. |
| `scenario.ts` | Derives the token owner's login from the public scenario seed (the token itself is opaque). |

## Design choices, honestly

- **State lives in memory.** A trial is one process lifetime and every surface
  starts from an empty forge, so persistence would only slow the timed
  workloads down. Nothing is written to disk.
- **Packs are sent without deltas.** The protocol does not require them; the
  fetch planner instead spends its effort on sending exactly the objects the
  client lacks — the have-closure is excluded snapshot-deep (trees and blobs
  of held commits are never re-sent), and shallow/deepen follow the protocol's
  total-depth semantics.
- **Merges are squash-shaped.** Every merge method produces one commit on the
  base branch whose tree is the path-level three-way merge against the merge
  base; a path changed differently on both sides (or changed vs deleted) is a
  conflict (REST 405).
- **GraphQL is a purpose-built executor**, not a general engine: it covers the
  schema the API's clients use (the documents the `gh` CLI sends), with
  field-named errors at HTTP 200 and `data.repository = null` for unknown
  repositories.
- **Deterministic by construction.** Timestamps come from a logical clock, ids
  from counters, and global ids are pure functions of the stored keys, so a
  replayed run answers byte-identically.

## Local verification

Against the practice kit's conformance runner (the same checks the closed
suite runs): **120/120 checks pass** — git 30/30, repos 15/15, issues 15/15,
pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15 — re-verified after an
external-audit fix round (ref-only pushes, GraphQL `nodes`/`rateLimit`/named
fragments, pack deflate caching, bounded diff memory). Timed workloads on
the development VM scored 189/200 perf points in the same re-verification
(push 46, clone 47, read 50, write 46 against the kit's calibrated
references; earlier runs measured 183–193, the VM is shared). The git
surface was also verified end-to-end with a real `git` client (clone,
shallow clone, deepen, unshallow, push, non-fast-forward refusal) — the
client is used for testing only; the program itself never invokes it.
