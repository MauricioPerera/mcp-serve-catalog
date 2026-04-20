# Changelog

All notable changes to mcp-serve-catalog.

---

## [0.1.1] - 2026-04-19

### Fixed

- **Doc / prompt path field**: the reader expected `doc_path` and `prompt_path` but a2e-skills' `tools/gen-index.ts` actually emits the unified field name `path` (matching the canonical frontmatter schema). A backward-compatible normalizer now accepts both — partitions using the legacy field names still work, new partitions using `path` work directly. Surfaced when running end-to-end against a real a2e-skills repo at `/bin/mcp-read catalog://docs/<name>` (was throwing `-32603 path must be string, got undefined`).

### Changed

- `DocEntry.doc_path` → `DocEntry.path`
- `PromptEntry.prompt_path` → `PromptEntry.path`
- Fixture files updated to use the new field names
- `mapper.test.ts` updated accordingly

No functional regression. `tools/list` and `tools/call` paths were already correct (skills use `entry_path` which matched).

---

## [0.1.0] - 2026-04-19

Initial release. Implements the full CONTRACT.md § 7 artifact list for v0.1.

### Added

- **JSON-RPC 2.0 protocol** — hand-rolled (zero deps). Parse + validate envelope, dispatch to handler, build success/error responses.
- **MCP method handlers**:
  - `initialize` → returns protocol version + server info + capabilities `{tools:{listChanged:true}, resources:{listChanged:true, subscribe:false}, prompts:{listChanged:true}}`
  - `tools/list` → returns a2e-skills `skills/` as MCP Tools
  - `tools/call` → validates args against schema, spawns `run.sh` with positional argv, wraps stdout as `CallToolResult { content, isError }`
  - `resources/list` → returns a2e-skills `docs/` with `catalog://docs/<name>` URIs
  - `resources/read` → reads the doc body from the content tree
  - `prompts/list` → returns a2e-skills `prompts/` as MCP Prompts
  - `prompts/get` → parses frontmatter, strips it, substitutes `{{var}}` tokens, returns `{messages: [{role:"user", content:...}]}`
  - Unknown methods → JSON-RPC `-32601 Method not found`
- **Catalog layout auto-detection**: supports two a2e-skills layouts:
  1. `<CATALOG_PATH>/index-worktree/` + `content-worktree/` (git worktree layout)
  2. `<CATALOG_PATH>/.index-out/` + content at repo root (`tools/gen-index.ts` output)
- **Transports**:
  - **HTTP**: `POST /mcp` with JSON body, JSON or 204 response. No framework (direct `node:http`).
  - **stdio**: line-framed JSON-RPC on stdin/stdout. Logs go to stderr only (protocol safety).
- **Catalog change watcher**: polls manifest mtime, invalidates the partition cache on change. Configurable interval.
- **Skill executor**: `spawn("bash", [script, ...argv])` with timeout + stdout/stderr capture. Never uses `shell: true`. Non-zero exit → `isError: true`.
- **Operator allowlist**: `ALLOWLIST_BINARIES` env var — any skill whose `requires` includes a binary outside the allowlist returns `isError: true` at `tools/call` time, never spawns.
- **Injectable logger**: noop by default. CLI entrypoint (`src/bin/cli.ts`) wires a stderr-JSON logger respecting `LOG_LEVEL`.

### Configuration (env vars)

- `CATALOG_PATH` (required) — absolute path to checked-out a2e-skills repo
- `TRANSPORT` (default `http`) — `http | stdio`
- `HOST` / `PORT` (HTTP only) — default `127.0.0.1:8787`
- `EXEC_TIMEOUT_MS` (default `30_000`)
- `CACHE_TTL_MS` (default `60_000`)
- `POLL_INTERVAL_MS` (default `10_000`, `0` disables)
- `ALLOWLIST_BINARIES` — comma-separated. Unset = no restriction.
- `LOG_LEVEL` (default `info`) — `debug | info | warn | error`

### Tests

53/53 green on first run. Unit tests for `jsonrpc`, `mapper`, `reader`. Integration tests for both transports driven via real JSON-RPC.

### Deferred to v0.2

- **SSE transport** with per-request event stream responses
- **Resource subscriptions** + `notifications/resources/updated`
- **Multi-catalog serving** from one process
- **`/admin/reload`** HTTP endpoint for webhook-triggered cache invalidation

[0.1.1]: https://github.com/MauricioPerera/mcp-serve-catalog/releases/tag/v0.1.1
[0.1.0]: https://github.com/MauricioPerera/mcp-serve-catalog/releases/tag/v0.1.0
