# github-core-clone-01 — a GitHub-compatible git forge in one Node process

[![competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bongekanjing/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bongekanjing/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Entry for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01): a
standalone git forge that serves git smart HTTP, GitHub's REST v3, GraphQL v4 and a Model Context
Protocol endpoint from one process and one in-memory store. It is the whole client surface the
contest's sealed suite drives — no outside service, no git binary, no package beyond Node's
standard library.

## Run it

```sh
node --experimental-strip-types main.ts     # needs MAKEFUN_ENV_URL pointing at an env
```

The platform runs `node /bot/main.ts` on Node 22, which strips the types without the flag. There is
nothing to install: no package manager, no dependencies, no network in the trial.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface that scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`, and a request without it is 401;
`/healthz` is the boot probe and takes none. A repository belongs to the login the token names, so the
same repository name under another owner is 404, never 403.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and the four timed workloads. The dev grade runs the same
suite from the kit, so every column can be measured before submitting.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts` — the lifecycle the env drives: bind port 0, POST the port to `$MAKEFUN_ENV_URL/register`,
  poll `/done`, then exit 0.
- `app.ts` — dispatch by path, the bearer-token check, and the JSON/bytes responders every reply goes
  through (each REST reply carries an `X-GitHub-Request-Id`).
- `lib/core.ts` — the SHA-1 object model (blob, tree, commit, annotated tag), pack parsing and
  building, and the store: repos, refs, issues, labels, comments, pulls.
- `lib/git.ts` — upload-pack v2 (`ls-refs`, `fetch` with `deepen`/`shallow`, side-band-64k framing)
  and receive-pack v0 (`report-status`, `delete-refs`, fast-forward-only updates).
- `lib/git-http.ts` — the smart-HTTP routes over that: service preambles, the protocol-v2
  advertisement, `application/x-git-*-request` bodies.
- `lib/rest.ts` — REST v3 with GitHub's status codes and pagination `Link` headers.
- `lib/graphql.ts` — a small GraphQL engine: the schema the suite introspects, the queries it sends,
  batched operations, and `errors` for unknown fields.
- `lib/mcp.ts` — `initialize`, `tools/list` and `tools/call` over the six tools the suite uses.

Every surface reads and writes one `Forge` object, so a repository, issue or pull request created over
MCP or GraphQL reads back over REST with the same ids.

## Grading

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

The dev grade runs one trial on `practice/trial-0` and prints the three columns that make the score:
feature checks (120 of them), agent-native MCP checks, and four timed workloads. On the practice
instance this build passes every conformance and MCP check; the remaining headroom is performance,
where push and read latency dominate the geometric mean.

