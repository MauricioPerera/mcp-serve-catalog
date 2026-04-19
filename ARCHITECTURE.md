# ARCHITECTURE — mcp-serve-catalog

Module layout, request lifecycles, error boundaries. Read AFTER CONTRACT.md + SPECIFICATION.md.

## Module layout

```
src/
├── index.ts                        main — reads env, wires transport + handlers, starts listening
├── logger.ts                       injectable noop-default Logger
├── protocol/
│   ├── jsonrpc.ts                  JSON-RPC 2.0 encode/decode + error types
│   ├── mcp-types.ts                MCP primitive types (Tool, Resource, Prompt, etc.)
│   └── handlers.ts                 method → handler dispatch; protocol-level validation
├── catalog/
│   ├── reader.ts                   partition loading + TTL cache + layout detection
│   ├── mapper.ts                   a2e-skills → MCP type translation + prompt templating
│   ├── exec.ts                     skill invocation (spawn + arg binding + timeout)
│   └── watcher.ts                  git SHA polling + list_changed emission
└── transports/
    ├── http.ts                     node:http POST /mcp
    ├── sse.ts                      node:http POST /mcp/sse with event-stream
    └── stdio.ts                    line-framed stdin/stdout JSON-RPC

tests/
├── unit/
│   ├── jsonrpc.test.ts             malformed messages, error codes
│   ├── mapper.test.ts              a2e-skills entry → MCP shape translation
│   ├── prompt-template.test.ts     input_vars substitution edge cases
│   ├── args-validation.test.ts     arg schema check (required, types, unknowns)
│   └── watcher.test.ts             SHA change detection (mocked git)
├── integration/
│   ├── http-transport.test.ts      real HTTP server + JSON-RPC client
│   ├── sse-transport.test.ts       real SSE stream
│   ├── stdio-transport.test.ts     spawn adapter as subprocess, pipe communication
│   ├── tool-call-e2e.test.ts       tools/call on real fixture skill (github-releases)
│   └── change-notification.test.ts mutate fixture, wait for notification
└── fixtures/
    ├── catalog-small/              minimal a2e-skills fixture (1 skill, 1 doc, 1 prompt)
    └── catalog-realistic/          larger fixture mirroring a real a2e-skills

examples/
├── local-dev/                      Claude Desktop stdio config
├── docker/                         containerized HTTP server
└── a2e-shell-gateway/              connect a2e-shell to this adapter via HTTP
```

## Request lifecycle

### HTTP transport

```
POST /mcp
  ├── parse body as JSON
  │   └── malformed → 400 + JSON-RPC error -32700 Parse error
  ├── validate JSON-RPC envelope (jsonrpc: "2.0", method, id)
  │   └── invalid → -32600 Invalid Request
  ├── dispatch to handlers.handle(method, params)
  │   ├── unknown method → -32601 Method Not Found
  │   ├── handler throws → -32603 Internal Error (with redacted message)
  │   └── handler returns result → JSON-RPC response
  └── write response body, close connection
```

### Stdio transport

```
while (line = readLine(stdin)):
  parse line as JSON
    malformed → emit -32700 to stdout
  dispatch (same as HTTP)
  write response as single-line JSON to stdout + "\n"
```

### Tools/call handler

```
handlers.handle("tools/call", { name, arguments })
  ├── catalog.reader.getSkill(name)
  │   └── not found → throw Error with code -32602 "unknown tool: <name>"
  ├── catalog.mapper.validateArgs(skill.args, arguments)
  │   └── throws -32602 on schema mismatch
  ├── catalog.mapper.checkAllowlist(skill.requires, process.env.ALLOWLIST_BINARIES)
  │   └── blocked → return CallToolResult { isError: true, content: [...] }
  ├── catalog.exec.run(skill, arguments)
  │   ├── spawn entry with positional args
  │   ├── timeout: EXEC_TIMEOUT_MS
  │   ├── collect stdout/stderr/exit
  │   └── return { stdout, stderr, exitCode }
  └── wrap as CallToolResult:
      {
        content: [{ type: "text", text: exitCode === 0 ? stdout : stderr }],
        isError: exitCode !== 0
      }
```

## Partition cache

The reader maintains a per-partition cache keyed by file path:

```ts
interface CachedPartition<T> {
  data: T;
  loadedAt: number;  // ms since epoch
  fileSha: string;   // sha of the partition file at load time
}
```

On each access:

1. Check `loadedAt + CACHE_TTL_MS > now` → return cached
2. Read file, hash it
3. If hash === cached.fileSha → update `loadedAt`, return cached
4. Else → parse, validate against INDEX-SCHEMA.json, store, return

Validation uses a hand-rolled schema check (no `ajv` dep). The schema is simple enough to encode as ~50 lines of type guards.

## Watcher

```ts
interface Watcher {
  start(): void;        // start polling
  stop(): void;         // clear interval
  onChange(fn): void;   // register callback
}
```

Implementation:

```
every POLL_INTERVAL_MS:
  sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: indexWorktreePath }).stdout
  if sha !== lastKnownSha:
    lastKnownSha = sha
    for each registered callback: callback()
```

Callbacks invalidate the partition cache and emit `notifications/tools/list_changed` + `resources/list_changed` + `prompts/list_changed` on all active SSE/stdio sessions.

HTTP transport has no active sessions — notifications are dropped for HTTP-only deployments. Document this as a limitation.

## Exec sandbox

The spawn in `catalog/exec.ts` is intentionally minimal:

- **cwd**: `EXEC_CWD` env or `os.tmpdir() + /mcp-serve-catalog-<random>` created+removed per call
- **env**: inherits `process.env` (operator's responsibility to pre-scrub secrets)
- **stdio**: pipe all three streams
- **signal**: timeout via `AbortController`, kills the process + tree (using `detached: false` + `process.kill(-pid)` on Unix for group termination)
- **shell**: never. Always argv-array.

Arg binding:

```ts
// a2e-skills args (ordered)
[
  { name: "repo", type: "string", required: true },
  { name: "count", type: "number", required: false }
]

// MCP arguments (unordered object)
{ repo: "microsoft/TypeScript", count: 3 }

// → spawn argv (ordered by args[])
["microsoft/TypeScript", "3"]  // count stringified
```

Omitted optional args: passed as empty string (not omitted) so positional indices remain stable. Skill scripts are expected to handle empty args gracefully (or set defaults).

Alternative considered: pass args as JSON on stdin. Rejected for v0.1 — positional args match the existing a2e-skills convention (`run.sh $1 $2`).

## Error model

```ts
class McpError extends Error {
  code: number;         // JSON-RPC error code
  data?: unknown;       // optional extra info (spec allows)
  constructor(code: number, message: string, data?: unknown);
}
```

Standard codes used:

- `-32700` Parse error (malformed JSON)
- `-32600` Invalid Request (valid JSON, bad envelope)
- `-32601` Method not found (or method not supported by this adapter)
- `-32602` Invalid params (wrong arg shape, unknown tool/resource/prompt name)
- `-32603` Internal error (catch-all; message redacted for security)

Application-specific codes (> -32000, reserved range per JSON-RPC spec):

- `-32001` Catalog error (partition read failed, git ops failed)
- `-32002` Exec error (spawn failure distinct from tool-level exit != 0)

Tool-level errors use `CallToolResult.isError: true`, not JSON-RPC errors.

## Logging

```ts
interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}
```

Events emitted (minimum set):

- `server.start` (transport, port, catalog_path)
- `server.stop`
- `request.received` (method, id)
- `request.handled` (method, id, duration_ms, status)
- `tool.executed` (name, exit_code, duration_ms)
- `tool.blocked` (name, missing_binaries)
- `catalog.loaded` (partitions_count, path)
- `catalog.changed` (old_sha, new_sha)
- `catalog.reload_failed` (reason)

Default logger: noop. Callers plug console / pino / anything.

Stdio transport MUST NOT log to stdout (protocol collision). Stdio transport logs to stderr only.

## Session handling (SSE transport)

Per MCP spec 2025-06-18, SSE sessions have lifetime tracked via a session id. The adapter keeps a Map:

```ts
Map<sessionId, {
  stream: http.ServerResponse,  // the SSE stream to write to
  subscriptions: Set<string>,   // any subscribed resource URIs (v0.2)
  createdAt: number
}>
```

When a change notification fires, iterate all active sessions and write the notification event to each stream.

On stream close (client disconnects), remove the session from the Map.

Graceful shutdown: close all streams, clear the Map, exit.

## Concurrency

- Catalog reads are idempotent. Multiple in-flight `tools/list` calls can race on cache refresh; the last write wins, which is fine (all refreshes produce the same result for the same SHA).
- Tool executions can run concurrently. No global lock. Operators concerned about load configure a reverse proxy with rate limiting.
- Watcher polling runs on a single timer. Callback emission is synchronous within a tick (no queueing).

## Things NOT to do

- Do not use `spawn` with `shell: true`. Always argv arrays.
- Do not parse `git log` output. Use `git rev-parse` and `git show --stat` only — their output is stable.
- Do not keep per-session state on HTTP transport. Every request is independent.
- Do not leak tool stdout/stderr into the adapter's own logs unless `LOG_LEVEL=debug`.
- Do not buffer entire SSE streams in memory. Write and flush.
- Do not auto-regenerate `.index-out/` in v0.1. Operator's responsibility.
- Do not mix transports in one process. Pick one at startup. Running all three requires three adapter instances.
