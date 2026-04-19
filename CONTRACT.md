# CONTRACT — mcp-serve-catalog

Execution contract for a coding agent. The agent MUST read SPECIFICATION.md and ARCHITECTURE.md before writing code; this file alone is insufficient context.

## 1. Objective

Build `mcp-serve-catalog`: a thin, stateless adapter that exposes a mounted [a2e-skills](https://github.com/MauricioPerera/a2e-skills) catalog repository as a **protocol-compliant MCP server** (Model Context Protocol, spec version 2025-06-18).

Success: any MCP client (Claude Desktop, Cursor, the [a2e-shell RFC 001](https://github.com/MauricioPerera/a2e-shell/blob/main/docs/rfcs/001-mcp-gateway.md) gateway, or anything that implements the MCP spec) can connect to the adapter and consume the catalog's skills as **tools**, docs as **resources**, and prompts as **prompts**, without any modification to the a2e-skills repo format. Node 20+, zero runtime deps.

## 2. Upstream pins (verified 2026-04-19)

- **MCP spec**: [2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18). JSON-RPC 2.0 over HTTP / SSE / stdio.
- **a2e-skills** repo format: [INDEX-SCHEMA.json](https://github.com/MauricioPerera/a2e-skills/blob/main/INDEX-SCHEMA.json) + [CONVENTION.md](https://github.com/MauricioPerera/a2e-skills/blob/main/CONVENTION.md). Four fixed categories: `skills/`, `docs/`, `prompts/`, `templates/` (this adapter ignores `templates/` — no MCP equivalent).
- **RFC document for this project**: [a2e-skills RFC 001](https://github.com/MauricioPerera/a2e-skills/blob/main/docs/rfcs/001-mcp-adapter.md) — read it for full design intent.

## 3. Protocol mapping (exact)

| MCP method | Source in a2e-skills | Adapter behavior |
|---|---|---|
| `initialize` | static | Return `protocolVersion`, `serverInfo`, capabilities `{tools:{listChanged:true}, resources:{listChanged:true, subscribe:false}, prompts:{listChanged:true}}` |
| `tools/list` | `<catalog>/skills.json` (index branch) | Return every entry reshaped to MCP `Tool` |
| `tools/call` | `<catalog>/skills/<name>/<entry>` (content branch) | Validate args against schema, spawn entry, wrap stdout as `CallToolResult` |
| `notifications/tools/list_changed` | index commit SHA change | Emit when polling detects change |
| `resources/list` | `<catalog>/docs.json` | Return every entry reshaped to MCP `Resource` with `catalog://` URI |
| `resources/read` | `<catalog>/docs/<name>.md` | Read file, return `ResourceContents` |
| `prompts/list` | `<catalog>/prompts.json` | Reshape to MCP `Prompt` |
| `prompts/get` | `<catalog>/prompts/<name>.md` | Parse frontmatter + body, substitute `input_vars` from args, return `GetPromptResult` |
| Anything else | N/A | Return JSON-RPC error `-32601 Method not found` |

## 4. Adapter configuration

Driven entirely by env vars (no config file):

```
CATALOG_PATH        required — absolute path to a checked-out a2e-skills repo
                    Must contain at minimum a <CATALOG_PATH>/.index-out/ directory
                    with manifest.json + skills.json + docs.json + prompts.json
                    OR matching files at <CATALOG_PATH>/ root.

TRANSPORT           http | sse | stdio. Default "http".
PORT                for http/sse. Default 8787.
HOST                for http/sse bind. Default 127.0.0.1.
EXEC_TIMEOUT_MS     per tools/call. Default 30000.
EXEC_CWD            cwd for tool spawn. Default: system tmpdir per call.
CACHE_TTL_MS        partition-parse cache TTL. Default 60000.
ALLOWLIST_BINARIES  comma-separated. If set, any skill whose `requires` lists a
                    binary outside the allowlist fails tools/call with isError=true.
                    If unset, no enforcement (operator's responsibility).
LOG_LEVEL           debug | info | warn | error. Default info.
POLL_INTERVAL_MS    how often to check for catalog changes. 0 = disabled. Default 10000.
```

## 5. Pinned stack and dependencies

- Runtime: Node.js 20 LTS
- Language: TypeScript 5.6+, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Test: vitest
- Runtime deps: **zero** — matches the zero-dep philosophy of the a2e ecosystem
- DO NOT use: `@modelcontextprotocol/sdk` or any MCP client/server library. Implement JSON-RPC 2.0 directly (it's ~100 lines).
- DO NOT use: express, fastify, koa. Use `node:http` directly for HTTP transport.
- DO NOT use: any utility library (lodash, zod, etc.)

## 6. Project patterns

The pattern this project replaces/extends already exists in:

- **a2e-shell/src/http/server.ts** — Hono-based routing, error handling, observability. Not directly reusable (Hono is a dep), but the MIDDLEWARE SHAPE is the reference: requestId → logging → auth → handler. Read for structural inspiration.
- **a2e-skills/INDEX-SCHEMA.json** — the exact JSON shape of `skills.json` / `docs.json` / `prompts.json` partitions this adapter reads.
- **a2e-skills/tools/gen-index.ts** — shows how partitions are generated from source files. This adapter does the reverse: consume partitions, translate to MCP.

Conventions to match:

- Atomic file reads (no half-read files) — but since we only read (not write), this reduces to "tolerate concurrent git operations on the catalog by retrying reads once on ENOENT".
- Structured logging via an injectable `Logger` (default: noop).
- All errors have a `code` property. Map to JSON-RPC error codes per spec.

## 7. Artifacts to produce

1. `src/protocol/jsonrpc.ts` — JSON-RPC 2.0 encode/decode + error codes. ≤ 120 lines.
2. `src/protocol/mcp-types.ts` — type definitions for Tool, Resource, Prompt, CallToolResult, GetPromptResult, etc. ≤ 150 lines.
3. `src/protocol/handlers.ts` — dispatch table: method → handler fn. ≤ 200 lines.
4. `src/catalog/reader.ts` — load + cache partition files. ≤ 120 lines.
5. `src/catalog/mapper.ts` — reshape a2e-skills entries to MCP primitives (args schema translation, URI construction, prompt templating). ≤ 200 lines.
6. `src/catalog/exec.ts` — spawn entry scripts with timeout + arg binding. ≤ 150 lines.
7. `src/catalog/watcher.ts` — poll for catalog change; emit `listChanged`. ≤ 100 lines.
8. `src/transports/http.ts` — `node:http` server, POST `/mcp`, JSON body. ≤ 150 lines.
9. `src/transports/sse.ts` — POST `/mcp/sse` with event stream. ≤ 180 lines.
10. `src/transports/stdio.ts` — line-framed JSON-RPC over stdin/stdout. ≤ 100 lines.
11. `src/index.ts` — main entrypoint. Reads env, wires transport + handlers, starts listening. ≤ 100 lines.
12. `src/logger.ts` — injectable noop-default logger. ≤ 50 lines.
13. `tests/unit/**/*.test.ts` — pure-function tests for mapping, templating, arg validation.
14. `tests/integration/http-transport.test.ts` — start the server against a fixture catalog, send real JSON-RPC, assert responses.
15. `tests/integration/stdio-transport.test.ts` — spawn the adapter as child process, communicate over pipes.
16. `tests/integration/claude-desktop-contract.test.ts` — replay canned Claude Desktop session traces and verify responses match spec.
17. `examples/local-dev/README.md` — point Claude Desktop at a local catalog via stdio transport.
18. `examples/docker/Dockerfile` — container that mounts a catalog path and serves HTTP.

## 8. Acceptance criteria

- [ ] `npm test` passes with 100% tests green
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] Zero runtime deps in `dependencies` (`npm ls --prod` clean)
- [ ] Manually testing with Claude Desktop configured to launch the adapter via stdio transport: `tools/list` returns every skill from a fixture a2e-skills repo; `tools/call` for `github-releases` with `{repo:"microsoft/TypeScript", count:3}` returns real data; `resources/list` returns every doc; `resources/read` for a doc URI returns its body; `prompts/list` returns every prompt; `prompts/get` renders templates.
- [ ] HTTP transport: same assertions via `curl` + JSON-RPC body
- [ ] When catalog's index commit SHA changes (external `git commit + git checkout`), a connected client receives `notifications/tools/list_changed` within `2 × POLL_INTERVAL_MS`
- [ ] No file exceeds the line limit from section 7
- [ ] No `any` in TypeScript source
- [ ] No `console.log` — use the injectable logger

## 9. Hard constraints

- DO NOT add `@modelcontextprotocol/sdk` or any MCP library as a dep. Implement the protocol directly.
- DO NOT add an HTTP framework (express, fastify, etc.). Use `node:http` directly.
- DO NOT touch files outside `src/`, `tests/`, `examples/`, `package.json`, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`.
- DO NOT modify the a2e-skills repo format. This adapter is a CONSUMER of that format, not a co-author of it.
- DO NOT implement write-side MCP (creating/modifying skills). Writes happen via git PR, always. The adapter is read-only for tools/list, resources/read, prompts/get; tools/call is write-side only for EXECUTING tools, not for authoring them.
- DO NOT implement `sampling/createMessage` or `elicitation/create`. These are client capabilities, irrelevant to a server adapter.
- DO NOT implement auth inside the adapter. Auth lives at the reverse-proxy / ingress layer.
- DO NOT implement `resources/subscribe` in v0.1. Deferred to v0.2 (requires stateful session tracking).
- DO NOT commit. Leave changes in the working directory.
- DO NOT publish to npm. Leave `private: true` until v1.0.
- If a criterion from section 8 cannot be met, STOP and report. No silent workarounds.
- If the MCP spec version referenced in section 2 has been superseded with incompatible changes, STOP and report. Do not silently upgrade.
