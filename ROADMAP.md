# ROADMAP — mcp-serve-catalog

Phased delivery. Each phase ends with a usable tag.

---

## v0.1 — MVP (current scope)

**Theme**: expose a mounted a2e-skills catalog as a protocol-compliant MCP server over HTTP and stdio transports.

### Scope

- `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`
- Three transports: HTTP, SSE, stdio
- Partition cache + TTL
- Polling-based change detection + `notifications/*/list_changed` on SSE/stdio
- Zero runtime deps
- Claude Desktop compatibility verified end-to-end

### Success criteria

- `npm test` green
- Claude Desktop, configured via stdio, successfully lists + calls tools from a real a2e-skills fixture
- a2e-shell's RFC 001 gateway (when it lands) successfully consumes this adapter over HTTP
- No file exceeds its line limit per CONTRACT.md § 7

### Out of scope

- `resources/subscribe` (v0.2)
- Authentication at the adapter layer (always ingress)
- Cloudflare Workers runtime support (requires declarative skills — v0.3)
- Webhook-triggered cache invalidation (v0.2)

---

## v0.2 — Subscribe + webhooks + multi-catalog

### Scope

- `resources/subscribe` + `resources/unsubscribe` + `notifications/resources/updated`
- HTTP POST `/admin/reload` endpoint — invalidate cache on demand (for webhook integration)
- Multi-catalog: one adapter process serves multiple catalogs, each on its own URL path prefix
- `resources/templates/list` for parametric URIs (e.g. `catalog://skills/{name}/schema`)

### Success criteria

- A client subscribed to a resource receives `notifications/resources/updated` within one poll cycle of a change
- GitHub webhook pointing at `/admin/reload?token=<secret>` triggers immediate cache invalidation
- Multi-catalog: `GET /catalog-a/mcp` and `GET /catalog-b/mcp` serve distinct catalogs

---

## v0.3 — Declarative skills + Workers compatibility

### Scope

- A declarative skill format: SKILL.md frontmatter includes a `template` field with a `curl + jq` DSL that can run without `spawn`
- The adapter interprets declarative skills inline (no subprocess) — unlocks CF Workers / serverless deploys
- HTTP transport verified on CF Workers with a catalog mounted via R2 or similar
- Fallback: skills marked `entry_type: subprocess` fail with a clear "not supported in this runtime" on Workers

### Success criteria

- At least 3 common a2e-skills (fetch, transform, format) expressible declaratively
- Deployed version running on CF Workers serving `tools/list` + declarative `tools/call`

---

## v0.4 — Observability + production hardening

### Scope

- Prometheus metrics endpoint (opt-in): `mcp_requests_total`, `mcp_request_duration_ms`, `mcp_tool_executions_total`, `mcp_cache_hit_ratio`, `mcp_active_sessions`
- Structured logging documented and stable
- Rate limiting per session (HTTP / SSE)
- Graceful shutdown: drain in-flight requests, close SSE streams cleanly
- Benchmark suite in CI, regressions gate merges

### Success criteria

- 24h soak test: stable memory, no file descriptor leaks, no hanging subprocesses
- p99 `tools/list` < 50 ms under 100 qps load

---

## v1.0 — Stability

### Scope

- Freeze config env-var names
- Freeze error code set
- Migration guide: v0.x → v1.0
- External security audit (spawn sandbox, path traversal, input sanitization)
- Published to npm

### Success criteria

- Used in production by at least one real deployment (a2e-shell pointing at this adapter for production catalog serving)
- No breaking changes without major version bump

---

## Principles guiding the roadmap

1. **The MCP spec is the contract.** If the spec evolves, this adapter tracks its stable versions. Breaking changes in the spec require a major bump here.
2. **Every phase ships a working tag.** v0.1 alone is useful; v0.2+ are additive.
3. **Zero runtime deps is a constraint, not a goal.** New features must justify any dep.
4. **a2e-skills format is the input.** If a2e-skills adds new categories or changes frontmatter conventions, this adapter adapts. It does not lead.

---

## Explicitly out of roadmap

- **Writes via MCP protocol.** All mutations happen via git PRs against the a2e-skills repo. This is the point.
- **Alternative catalog formats.** One format (a2e-skills) per adapter. If you want a different format, fork and adapt.
- **Built-in auth.** Reverse proxy concern.
- **Federation across catalogs.** Compose at the reverse-proxy layer.
- **Real-time collaborative editing.** Different product entirely.
