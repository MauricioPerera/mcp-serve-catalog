# TEST-PLAN — mcp-serve-catalog

Concrete test scenarios, binary pass/fail.

## Unit tests (no subprocess, no network)

### `tests/unit/jsonrpc.test.ts`

- [ ] Valid request parses correctly
- [ ] Missing `jsonrpc: "2.0"` → -32600
- [ ] Missing `method` → -32600
- [ ] Notification (no `id`) parses without error, no response expected
- [ ] Encoding a successful response produces the spec shape `{ jsonrpc, id, result }`
- [ ] Encoding an error response produces `{ jsonrpc, id, error: { code, message } }`
- [ ] Parse errors (invalid JSON) produce -32700

### `tests/unit/mapper.test.ts`

- [ ] a2e-skills skill with 2 args (one required, one optional) → MCP Tool with correct `inputSchema`
- [ ] a2e-skills doc entry → MCP Resource with `catalog://docs/<name>` URI
- [ ] a2e-skills prompt entry → MCP Prompt with `arguments` matching `input_vars`
- [ ] Description merges `when_to_use` + `description.first_line`
- [ ] Args type `string` → JSON schema `"string"`, `number` → `"number"`, `boolean` → `"boolean"`, `path` → `"string"`

### `tests/unit/prompt-template.test.ts`

- [ ] `{{var}}` replaced with supplied value
- [ ] Multiple occurrences of the same var all replaced
- [ ] `{{unknown}}` with no supplied value → left verbatim (no throw, no warning)
- [ ] Missing required var in args → throws `McpError({ code: -32602 })`
- [ ] Values are stringified (numbers → string) before substitution

### `tests/unit/args-validation.test.ts`

- [ ] Missing required arg → throws -32602
- [ ] Extra unknown arg → passes (ignored; do NOT error)
- [ ] Type mismatch (arg `count: "three"` when schema says number) → throws -32602
- [ ] Empty `arguments` object when no args required → passes
- [ ] `null` arguments when args are required → throws -32602

### `tests/unit/watcher.test.ts`

- [ ] First check stores the SHA without emitting
- [ ] Subsequent check with same SHA does nothing
- [ ] Different SHA triggers all registered callbacks exactly once
- [ ] `stop()` clears the interval (no further polls)
- [ ] Error from `git rev-parse` is logged but does not crash the watcher

## Integration tests (real subprocess, real files, local fixtures)

### Setup — `tests/fixtures/catalog-small/`

Minimal catalog committed to the test repo:

```
catalog-small/
├── .index-out/
│   ├── manifest.json
│   ├── skills.json
│   ├── docs.json
│   ├── prompts.json
│   └── templates.json
├── skills/
│   └── echo/
│       ├── SKILL.md
│       └── run.sh           # echoes "$1" with timestamp prefix
├── docs/
│   └── hello.md             # minimal markdown
└── prompts/
    └── greet.md             # "Hola, {{name}}!"
```

Must be created by a fixture-gen script (`tests/fixtures/generate.ts`) that runs `git init`, populates, and generates index via a mini gen-index routine.

### `tests/integration/http-transport.test.ts`

- [ ] POST `/mcp` with `initialize` returns the expected protocolVersion + capabilities
- [ ] POST `/mcp` with `tools/list` returns the `echo` tool
- [ ] POST `/mcp` with `tools/call` for `echo` with `{message: "hi"}` returns `content: [{type: "text", text: "... hi"}]`
- [ ] POST `/mcp` with `resources/list` returns the `hello` doc
- [ ] POST `/mcp` with `resources/read { uri: "catalog://docs/hello" }` returns the doc body
- [ ] POST `/mcp` with `prompts/list` returns `greet`
- [ ] POST `/mcp` with `prompts/get` for `greet` with `{name: "mundo"}` returns messages with "Hola, mundo!"
- [ ] POST `/mcp` with unknown method returns -32601
- [ ] POST `/mcp` with malformed JSON returns 400 + -32700

### `tests/integration/sse-transport.test.ts`

- [ ] Open SSE stream, receive the `initialize` response as an event
- [ ] Send `tools/list` via POST, receive response on the stream
- [ ] Touch the catalog's index SHA (simulated — direct call to watcher's callback); observe `notifications/tools/list_changed` on the stream
- [ ] Close the stream → adapter removes the session from the Map (verified via admin/debug endpoint or internal state check)

### `tests/integration/stdio-transport.test.ts`

- [ ] Spawn the adapter as a subprocess with stdio transport
- [ ] Write `initialize` + `notifications/initialized` to stdin, read response from stdout
- [ ] Write `tools/list` to stdin, read response
- [ ] Kill the subprocess → no stdout garbage on exit

### `tests/integration/tool-call-e2e.test.ts`

- [ ] `tools/call` for `echo` with various args (plain, with spaces, with JSON chars) round-trips correctly
- [ ] Skill that exits non-zero → `CallToolResult { isError: true }` with stderr in content
- [ ] Skill that exceeds `EXEC_TIMEOUT_MS` → `isError: true` with "timeout" in content
- [ ] Skill requiring a binary NOT in `ALLOWLIST_BINARIES` → `isError: true`, content mentions missing binary, skill NEVER runs

### `tests/integration/change-notification.test.ts`

Uses SSE transport.

- [ ] Start adapter with `POLL_INTERVAL_MS=500`
- [ ] Connect SSE client, initialize
- [ ] Run `git commit` in the fixture catalog (adding a skill or modifying one)
- [ ] Within 1.5 seconds, client receives `notifications/tools/list_changed`
- [ ] Subsequent `tools/list` reflects the new entry

### `tests/integration/claude-desktop-contract.test.ts`

Canned transcripts from real Claude Desktop sessions. Play them into stdio transport, assert responses match the expected shape.

- [ ] Initial handshake sequence (initialize + initialized notification) completes
- [ ] Claude Desktop's typical `tools/list` call succeeds
- [ ] `tools/call` with Claude Desktop's exact argument shape works

## Spec compliance tests

Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) or equivalent to verify:

- [ ] All declared capabilities are discoverable
- [ ] All tools have valid `inputSchema`
- [ ] All resources have valid URI format
- [ ] All prompts have valid arguments declaration

These are smoke tests, not part of CI (require an external tool). Document them in README under "manual verification".

## Performance smoke (optional, not gating)

### `tests/bench/throughput.mjs`

- [ ] Fire 1000 sequential `tools/list` requests over HTTP. Target: p95 < 20 ms.
- [ ] Fire 100 concurrent `tools/call` for a fast skill (~50 ms runtime). Target: total wall-clock < (100/8 cores) × 50ms × 2 = 1.25 s on a modern machine.

## What we do NOT test

- Network flakiness at the TCP level
- Specific MCP clients beyond Claude Desktop (Cursor, others — add as they mature)
- Extremely large catalogs (> 10 000 skills — defer to load testing in v0.2)
- Windows native (use WSL; Linux + macOS are primary targets)

## Acceptance for the v0.1 release

All unit + integration tests green. Manual verification with Claude Desktop successful for at least one real a2e-skills repo. Benchmark numbers recorded (not gating).
