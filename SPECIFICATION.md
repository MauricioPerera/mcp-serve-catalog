# SPECIFICATION — mcp-serve-catalog

Detailed technical specification. Read before writing code to understand the *why* behind decisions encoded in CONTRACT.md.

## 1. What this project is

`mcp-serve-catalog` is a stateless Node.js adapter that turns a mounted [a2e-skills](https://github.com/MauricioPerera/a2e-skills) catalog repo into a fully-compliant [MCP](https://modelcontextprotocol.io/specification/2025-06-18) server. Any MCP client (Claude Desktop, Cursor, custom agents, the [a2e-shell RFC 001 gateway](https://github.com/MauricioPerera/a2e-shell/blob/main/docs/rfcs/001-mcp-gateway.md)) consumes the catalog's capabilities through the standard MCP JSON-RPC protocol without knowing anything about git, a2e-skills, or the file layout underneath.

## 2. What problem it solves

The MCP ecosystem assumes every capability provider runs a **stateful process**: a Node or Python server with auth, deployment, monitoring, and per-instance state. For content catalogs — skill libraries, reference docs, prompt templates — that model is wildly over-engineered.

a2e-skills already encodes those capabilities as **files in a git repo**, versioned and reviewed via PRs. This project makes that git repo consumable as an MCP server through a ~400-line adapter with:

- **No database** — catalog partitions are files
- **No state** — each request reads files, spawns skills, returns
- **No per-server deploy** — `git clone + node` is enough
- **No server-to-server replication** — `git pull` is the replication protocol

The result: a team's skill library is versioned code, served via CDN or thin adapter, with zero ops overhead for the content.

## 3. The a2e-skills repo format (what this adapter reads)

a2e-skills uses two branches:

- `main` — full content (SKILL.md + run.sh + docs/*.md + prompts/*.md)
- `index` (orphan) — compact partitions summarizing `main`: `manifest.json`, `skills.json`, `docs.json`, `prompts.json`, `templates.json`

For adapter purposes, the **index branch partitions are the source of truth for listings** (they're pre-parsed, pre-validated, small). The content branch is only touched for:

- Reading the body of a doc (`resources/read`)
- Reading the body of a prompt template (`prompts/get`)
- Spawning a skill's entry script (`tools/call`)

The adapter expects the catalog to be checked out with both branches accessible. Supported layouts:

### Layout A — git worktrees (recommended)

```
/catalog/
├── index-worktree/       # worktree of index branch
│   ├── manifest.json
│   ├── skills.json
│   ├── docs.json
│   ├── prompts.json
│   └── templates.json
└── content-worktree/     # worktree of main branch
    ├── skills/<name>/{SKILL.md, run.sh, ...}
    ├── docs/<name>.md
    ├── prompts/<name>.md
    └── templates/<name>.md
```

`CATALOG_PATH=/catalog` — the adapter finds both worktrees via naming convention.

### Layout B — single working tree with .index-out

When someone has run `tools/gen-index.ts` locally:

```
/catalog/                 # main branch checked out
├── .index-out/           # generated partitions (from gen-index.ts)
│   ├── manifest.json
│   └── ...
├── skills/<name>/...
├── docs/<name>.md
└── prompts/<name>.md
```

`CATALOG_PATH=/catalog` — adapter reads partitions from `.index-out/` and content from repo root.

### Layout detection

The adapter probes at startup:

1. If `<CATALOG_PATH>/index-worktree/manifest.json` exists → Layout A
2. Else if `<CATALOG_PATH>/.index-out/manifest.json` exists → Layout B
3. Else fail with a clear error telling the operator to run `gen-index.ts` or set up a worktree

## 4. MCP primitives mapping (detail)

### Tools — `skills/` → MCP tools

Each entry in `skills.json` becomes an MCP `Tool`:

```ts
// a2e-skills entry
{
  name: "github-releases",
  when_to_use: "...",
  description: "...",
  args: [
    { name: "repo", type: "string", required: true, description: "..." },
    { name: "count", type: "number", required: false, description: "..." }
  ],
  requires: ["curl", "jq"],
  entry_path: "skills/github-releases/run.sh",
  entry_sha: "..."
}

// → MCP Tool
{
  name: "github-releases",
  description: "<when_to_use> — <description>",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "..." },
      count: { type: "number", description: "..." }
    },
    required: ["repo"]
  }
}
```

The mapper validates that every required arg appears in `args[]` with `required: true`.

### Resources — `docs/` → MCP resources

Each entry in `docs.json` becomes an MCP `Resource`:

```ts
{
  uri: "catalog://docs/<name>",
  name: "<name>",
  description: "<summary>",
  mimeType: "text/markdown"
}
```

`resources/read` responds with the file body from the content worktree:

```ts
{
  contents: [
    {
      uri: "catalog://docs/<name>",
      mimeType: "text/markdown",
      text: "<full markdown body>"
    }
  ]
}
```

### Prompts — `prompts/` → MCP prompts

Each entry in `prompts.json` becomes an MCP `Prompt`:

```ts
{
  name: "<name>",
  description: "<purpose>",
  arguments: input_vars.map(v => ({
    name: v.name,
    description: v.description,
    required: v.required ?? false
  }))
}
```

`prompts/get` parses the prompt file, substitutes `{{input_vars}}` placeholders with the supplied args, and returns:

```ts
{
  description: "<purpose>",
  messages: [
    { role: "user", content: { type: "text", text: "<rendered body>" } }
  ]
}
```

### Templates — `templates/` → ignored

a2e-skills has `templates/` for agent output formats. MCP has no equivalent primitive; the adapter does NOT expose them. The partition file is read for catalog-change detection (any partition changing triggers `list_changed`) but its contents are not mapped.

## 5. Tool call execution lifecycle

```
tools/call { name: "github-releases", arguments: { repo: "...", count: 3 } }
  │
  ├── Look up skills.json[entries][github-releases] from cached partition
  │   ├── Not found → JSON-RPC error -32602 Invalid params
  │   └── Found → proceed
  │
  ├── Validate arguments against args schema
  │   ├── Missing required → -32602
  │   ├── Type mismatch (e.g. count is string) → -32602
  │   └── Valid → proceed
  │
  ├── Check ALLOWLIST_BINARIES if configured
  │   └── Any `requires` not in allowlist → CallToolResult { isError: true, content: [{ type: "text", text: "blocked: requires <bin> not in allowlist" }] }
  │
  ├── Build spawn args: positional args from skill's args[] (in declaration order)
  │
  ├── spawn <catalog>/skills/<name>/<entry> <arg1> <arg2> ...
  │   ├── cwd: EXEC_CWD env or tmpdir() per call
  │   ├── env: inherit parent's env; DO NOT pass stdio from parent
  │   ├── timeout: EXEC_TIMEOUT_MS
  │   ├── Collect stdout, stderr, exit code
  │
  └── Wrap as CallToolResult:
      - Exit 0: content=[{ type: "text", text: <stdout> }], isError: false
      - Exit !=0: content=[{ type: "text", text: "<stderr tail>" }], isError: true
      - Timeout: content=[{ type: "text", text: "execution timed out after <ms>ms" }], isError: true
```

**No canonical response wrapping**. That is a2e-shell's concern in its RFC 001 gateway. This adapter speaks vanilla MCP; any client that wants discipline on top provides it.

## 6. Transport details

### HTTP transport

- Server listens on `HOST:PORT` (default `127.0.0.1:8787`)
- Single endpoint: `POST /mcp`
- Content-Type: `application/json`
- Request body: JSON-RPC 2.0 message (single request)
- Response body: JSON-RPC 2.0 response
- Connection: close after each response (no keep-alive required)
- No auth. Operators put a reverse proxy in front for auth.

Notifications (server → client for `list_changed`) are NOT supported on plain HTTP transport — no long-lived connection. If the client needs notifications, use SSE.

### SSE transport

- Endpoint: `POST /mcp/sse`
- Client opens the stream with `Accept: text/event-stream`
- Every server message (response or notification) emitted as an SSE event:
  ```
  event: message
  data: {"jsonrpc":"2.0",...}

  ```
- Client sends requests as individual POSTs to the same endpoint within the session (session id tracked via a header; exact mechanism per MCP spec appendix)

### Stdio transport

- Reads JSON-RPC messages from stdin, one per line (newline-framed)
- Writes responses + notifications to stdout, one per line
- Stderr is for logs only, never protocol messages
- Designed for local launches (Claude Desktop config: `command: "node", args: [".../dist/stdio.mjs"]`)

## 7. Catalog change detection

Polling-based. Every `POLL_INTERVAL_MS`:

1. Run `git -C <CATALOG_PATH>/index-worktree rev-parse HEAD` (or equivalent for Layout B)
2. If SHA differs from last check:
   a. Invalidate partition cache
   b. Re-read partitions
   c. Emit `notifications/tools/list_changed` (and resources/prompts list_changed)

Webhook-triggered invalidation is out of scope for v0.1 (it's an integration concern, not a protocol concern). Operators with GitHub can set up a webhook that hits the adapter's `/admin/reload` endpoint (v0.2 feature).

## 8. Error handling

The adapter distinguishes three error surfaces:

1. **Protocol-level errors** — JSON-RPC error response with standard codes (-32600 Invalid Request, -32601 Method Not Found, -32602 Invalid Params, -32603 Internal Error). Returned for malformed messages, unknown methods, arg validation failures.

2. **Tool-level errors** — `CallToolResult { isError: true }`. Returned for skill execution failures (non-zero exit, timeout, binary not allowlisted). The JSON-RPC response itself is successful; the error semantic is inside the result.

3. **Server-level errors** — adapter startup failures (catalog not found, malformed partitions, port conflicts). Logged and process exits with non-zero code. No protocol interaction.

## 9. Scale and deployment

### Memory

- Partitions cached in memory: ~1-100 KB per partition × 4 partitions = trivial
- No per-session state
- No per-request allocation beyond JSON parse + subprocess

### Latency

- Cold start: ~10 ms (parse partitions)
- `tools/list`, `resources/list`, `prompts/list`: ~1-5 ms (cache hit)
- `resources/read`: ~5-20 ms (disk read + serialize)
- `prompts/get`: ~5 ms (parse + substitute)
- `tools/call`: dominated by the skill's runtime (usually 50-2000 ms for typical skills)

### Throughput

- One Node process handles ~500 req/s on commodity hardware for list/read/get methods
- `tools/call` throughput bounded by how fast the skill runs

### Deployment targets

- **Node container**: full feature set. `CATALOG_PATH` mounted as a volume or `git clone`d at startup.
- **Local dev via stdio**: launched by Claude Desktop or similar. `CATALOG_PATH` is an absolute local path.
- **Cloudflare Workers**: HTTP transport only; `tools/call` NOT SUPPORTED (no `spawn` in Workers). v0.1 treats this as a non-goal; v0.2 explores "declarative skills" that can run without `spawn`.
- **AWS Lambda / Functions**: similar to Workers. Read-only (resources + prompts) works; tools/call requires the Lambda to be container-backed with `spawn` capability.

## 10. Non-goals

- Writes via MCP protocol. All writes go through git PRs against the a2e-skills repo. The adapter is read-only except for `tools/call` which is read-only with side effects (skills can do arbitrary things, but via subprocess, not via the adapter's own state).
- Multi-catalog serving from one process. Spin up one adapter per catalog; put them behind a shared reverse proxy.
- OAuth / authentication. Operator-layer concern.
- Language-specific MCP servers (GitHub MCP, Postgres MCP, etc.). Those expose runtime state. This project is for static content catalogs.
- Replacing the MCP SDK for general-purpose MCP servers. This is a focused adapter.

## 11. Relationship to the a2e ecosystem

- **a2e-skills** — the catalog format this adapter exposes. This project is tightly coupled to the current a2e-skills INDEX-SCHEMA.json. If that schema versions, this adapter tracks it.
- **a2e-shell** — one of the primary consumers. a2e-shell's RFC 001 (MCP gateway) connects to this adapter via HTTP or SSE transport, treating it as just another MCP server.
- **js-git-store** — orthogonal. js-git-store is the WRITE-side substrate (programmatic catalog mutation via git); this adapter is the READ-side MCP protocol face. Both can coexist: js-git-store writes to the catalog, this adapter serves it.

## 12. Open questions (for the implementer)

1. **Session affinity for SSE**. MCP spec 2025-06-18 specifies session IDs in SSE transport. Exact mechanism (header, cookie, URL param) needs careful reading of the spec before implementing. The current plan is to follow whatever the spec mandates; if ambiguous, start with a custom `Mcp-Session-Id` header and iterate.

2. **Partition regeneration when Layout B is in use**. If the catalog uses `.index-out/` (generated by `gen-index.ts`) and someone edits SKILL.md without regenerating, the adapter serves stale data. Options: (a) auto-run `gen-index.ts` on change detection (adds a write path and a dep), (b) document the limitation clearly. Plan: (b) for v0.1.

3. **URI scheme for dynamic resources**. Some skills might want to expose their output as resources (e.g., a `system-report` skill emits a doc). Out of v0.1 scope — v0.1 resources are strictly from `docs/`.

4. **Binary redaction**. If a skill's stdout contains credentials (from env vars it touched), they propagate to the client. Unlike a2e-shell (which has a redactor pipeline), this adapter doesn't. Operators wanting redaction should wrap the adapter (a2e-shell as MCP client does this automatically via RFC 001).

## 13. What to read before coding

1. [MCP spec 2025-06-18 — basic protocol](https://modelcontextprotocol.io/specification/2025-06-18/basic) — lifecycle, transports
2. [MCP spec 2025-06-18 — server features](https://modelcontextprotocol.io/specification/2025-06-18/server) — tools, resources, prompts method details
3. [a2e-skills INDEX-SCHEMA.json](https://github.com/MauricioPerera/a2e-skills/blob/main/INDEX-SCHEMA.json) — exact partition shapes
4. [a2e-skills CONVENTION.md](https://github.com/MauricioPerera/a2e-skills/blob/main/CONVENTION.md) — frontmatter rules
5. [a2e-shell RFC 001](https://github.com/MauricioPerera/a2e-shell/blob/main/docs/rfcs/001-mcp-gateway.md) — primary consumer's expectations
6. [a2e-skills RFC 001](https://github.com/MauricioPerera/a2e-skills/blob/main/docs/rfcs/001-mcp-adapter.md) — this project's full design intent
