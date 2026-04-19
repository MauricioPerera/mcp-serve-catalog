# API — mcp-serve-catalog

Public MCP protocol surface (what clients see). Internals in ARCHITECTURE.md.

## Exports (for embedding the adapter in another Node process)

```ts
import {
  startServer,
  type ServerConfig,
  type Logger,
  noopLogger,
} from "mcp-serve-catalog";

await startServer({
  catalogPath: "/path/to/a2e-skills-checkout",
  transport: "http",         // | "sse" | "stdio"
  port: 8787,
  host: "127.0.0.1",
  logger: myLogger,          // optional
  execTimeoutMs: 30_000,
  cacheTtlMs: 60_000,
  pollIntervalMs: 10_000,
  allowlistBinaries: ["curl", "jq"],  // optional
});
```

The CLI entrypoint (`bin/mcp-serve-catalog`) reads these from env vars (see CONTRACT.md § 4).

## MCP methods implemented

All methods follow JSON-RPC 2.0 over the chosen transport. Examples use pseudo-HTTP; the same message body applies over SSE or stdio.

### `initialize`

**Request:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "clientInfo": { "name": "example-client", "version": "1.0" },
    "capabilities": {}
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "serverInfo": { "name": "mcp-serve-catalog", "version": "0.1.0" },
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": { "listChanged": true, "subscribe": false },
      "prompts": { "listChanged": true }
    }
  }
}
```

After receiving the response, the client sends `notifications/initialized` (no params), and the session is active.

### `tools/list`

**Request:**

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

**Response:**

```json
{
  "jsonrpc": "2.0", "id": 2,
  "result": {
    "tools": [
      {
        "name": "github-releases",
        "description": "when the user asks for the latest release(s) of a GitHub repo — Fetches the N most recent releases ...",
        "inputSchema": {
          "type": "object",
          "properties": {
            "repo": { "type": "string", "description": "owner/repo — e.g. microsoft/TypeScript" },
            "count": { "type": "number", "description": "How many releases to return. Defaults to 3. Max 20." }
          },
          "required": ["repo"]
        }
      }
    ]
  }
}
```

Description field: `<when_to_use> — <description.first_line>` from the SKILL.md frontmatter.

### `tools/call`

**Request:**

```json
{
  "jsonrpc": "2.0", "id": 3,
  "method": "tools/call",
  "params": {
    "name": "github-releases",
    "arguments": { "repo": "microsoft/TypeScript", "count": 3 }
  }
}
```

**Response (success):**

```json
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[\n  {\"tag_name\":\"v6.0.3\",...},\n  ...\n]"
      }
    ],
    "isError": false
  }
}
```

**Response (skill exits non-zero):**

```json
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "<stderr content or error summary>" }],
    "isError": true
  }
}
```

**Response (unknown tool):**

```json
{
  "jsonrpc": "2.0", "id": 3,
  "error": { "code": -32602, "message": "unknown tool: foo" }
}
```

### `resources/list`

```json
{
  "jsonrpc": "2.0", "id": 4,
  "result": {
    "resources": [
      {
        "uri": "catalog://docs/example-api",
        "name": "example-api",
        "description": "Reference documentation for the example API endpoints.",
        "mimeType": "text/markdown"
      }
    ]
  }
}
```

### `resources/read`

**Request:**

```json
{
  "jsonrpc": "2.0", "id": 5,
  "method": "resources/read",
  "params": { "uri": "catalog://docs/example-api" }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0", "id": 5,
  "result": {
    "contents": [
      {
        "uri": "catalog://docs/example-api",
        "mimeType": "text/markdown",
        "text": "# Example API\n\n..."
      }
    ]
  }
}
```

### `prompts/list`

```json
{
  "jsonrpc": "2.0", "id": 6,
  "result": {
    "prompts": [
      {
        "name": "code-review",
        "description": "Template for asking an LLM to review code.",
        "arguments": [
          { "name": "language", "description": "Programming language", "required": true },
          { "name": "code", "description": "Code to review", "required": true }
        ]
      }
    ]
  }
}
```

### `prompts/get`

**Request:**

```json
{
  "jsonrpc": "2.0", "id": 7,
  "method": "prompts/get",
  "params": {
    "name": "code-review",
    "arguments": { "language": "python", "code": "def foo(): pass" }
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0", "id": 7,
  "result": {
    "description": "Template for asking an LLM to review code.",
    "messages": [
      {
        "role": "user",
        "content": {
          "type": "text",
          "text": "Review the following python code:\n\ndef foo(): pass\n\nFocus on..."
        }
      }
    ]
  }
}
```

Template substitution uses `{{var_name}}` tokens in the prompt file body. Unknown tokens are left verbatim (no warning). Missing required args → `-32602`.

### Notifications (server → client)

Emitted over SSE or stdio only (not plain HTTP):

- `notifications/tools/list_changed`
- `notifications/resources/list_changed`
- `notifications/prompts/list_changed`
- `notifications/message` (adapter log events, if client subscribed via `logging/setLevel`)

**Format:**

```json
{ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }
```

No `id` field. No response expected from client.

## Methods explicitly NOT implemented

- `resources/templates/list` — v0.2
- `resources/subscribe` / `resources/unsubscribe` — v0.2
- `sampling/createMessage` — server capability, not applicable
- `roots/list` — client capability, not applicable
- `elicitation/create` — client capability, not applicable
- `completion/complete` — v0.3

Calls to these return `-32601 Method not found`.

## Transport-specific notes

### HTTP

- Every request is a new connection (short-lived). No session tracking.
- Notifications are NOT delivered — clients needing change notifications MUST use SSE.
- Ideal for stateless integrations and serverless deploys.

### SSE

- Client opens stream via POST with `Accept: text/event-stream`
- Session ID tracked per spec (exact header: `Mcp-Session-Id`, returned in initialize response)
- All server→client messages (responses + notifications) are SSE `event: message` data frames
- Client sends subsequent requests as POSTs to the same session
- Ideal for desktop clients and long-lived agent sessions

### Stdio

- Adapter reads newline-framed JSON from stdin, writes to stdout
- Parent process (e.g. Claude Desktop) manages the subprocess lifecycle
- Logs go to stderr only
- Ideal for local dev, Claude Desktop configs, MCP inspector tooling

## Claude Desktop configuration example

Put this in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent Windows path:

```json
{
  "mcpServers": {
    "my-skills": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-serve-catalog/dist/bin/stdio.js"],
      "env": {
        "CATALOG_PATH": "/absolute/path/to/a2e-skills-checkout",
        "TRANSPORT": "stdio",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

After restart, Claude Desktop shows skills/docs/prompts from the catalog as first-class MCP tools/resources/prompts.

## Error codes quick reference

| Code | Name | When |
|---|---|---|
| `-32700` | Parse error | Malformed JSON body |
| `-32600` | Invalid Request | Missing required JSON-RPC fields |
| `-32601` | Method not found | Unknown or unsupported method |
| `-32602` | Invalid params | Unknown tool/resource/prompt, arg validation failure |
| `-32603` | Internal error | Catch-all (message redacted) |
| `-32001` | Catalog error | Partition load / git rev-parse failed |
| `-32002` | Exec error | spawn failed (distinct from tool exit != 0) |
