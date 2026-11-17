# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/wishbeyond1-design/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/wishbeyond1-design/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: the smart-HTTP git protocol (v0/v2 upload-pack and receive-pack), the GitHub REST v3 API, the GraphQL v4 API, and an MCP server over streamable HTTP — all backed by one in-memory store, no dependencies, no git binary, no database.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. Locally, `node --experimental-strip-types main.ts` works on older Node too. There is nothing to install: the program imports `node:http`, `node:crypto` and `node:zlib` only, and its own files.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The env records the address the request came from plus that port as your base URL and dials it from then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards, and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP checks again as the agent-native column, and four timed workloads. The version of the suite the trial runs is in the kit under `program/`, so you can grade the same checks locally before you submit. Local `grade-local` on this entry: **976/1000** — feature 600/600 (120/120 checks), agent 200/200, perf 176/200, working 1.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach. The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the router — one in-memory store, dispatched to the REST, GraphQL, MCP and git handlers.
- `store.ts`: the store itself — repositories, objects, refs, labels, issues, pull requests, comments, tree surgery, commits, three-way and squash merges.
- `gitcore.ts`: SHA-1 object ids, pkt-lines, pack read/write, commit/tree/tag parse and build.
- `githttp.ts`: git smart HTTP — v0/v2 advertisements, ls-refs, fetch (v0/v2, shallow, incremental), receive-pack with fast-forward checks and report-status.
- `rest.ts`: GitHub REST v3.
- `graphql.ts`: a small GraphQL tokenizer, parser and executor for the documents `gh` and `github-mcp-server` send.
- `mcp.ts`: MCP over streamable HTTP.
- `scenario.ts`: the deterministic scenario identities (viewer, teammate, stranger, org) derived from the seed.
- `httputil.ts`: shared request shape, JSON answers, bearer-token parsing.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=e2bmjnhv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
