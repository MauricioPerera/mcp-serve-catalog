# mcp-serve-catalog

Thin, stateless [MCP](https://modelcontextprotocol.io) server that exposes an [a2e-skills](https://github.com/MauricioPerera/a2e-skills) catalog to any MCP-compliant client (Claude Desktop, Cursor, [a2e-shell's RFC 001 gateway](https://github.com/MauricioPerera/a2e-shell/blob/main/docs/rfcs/001-mcp-gateway.md), custom agents).

Zero runtime dependencies. Node 20+. TypeScript strict.

## Status

**Pre-v0.1.** The artifacts in this repo are the execution contract for a coding agent to build the implementation. No code has been written yet.

## What it does

Mounts a checked-out a2e-skills repo and translates MCP JSON-RPC requests into:

- `tools/list` + `tools/call` — backed by `skills/` entries (spawn the entry script)
- `resources/list` + `resources/read` — backed by `docs/` markdown files
- `prompts/list` + `prompts/get` — backed by `prompts/` templates (input_var substitution)
- `notifications/*/list_changed` — on catalog git SHA change

Three transports: HTTP, SSE, stdio. Pick one at startup.

## Why it exists

MCP assumes every capability provider runs a **stateful process**. For content catalogs (skill libraries, reference docs, prompt templates), that's wildly over-engineered. a2e-skills already stores those as files in a git repo, versioned and reviewed via PRs. This adapter makes that git repo consumable as an MCP server through a ~400-line program with no database, no per-server state, no deploy story beyond `git clone + node`.

Your team's skill library becomes versioned code, served via CDN or a thin adapter, with zero ops overhead for the content.

## How to use this repo if you're an AI coding agent

1. Read `CONTRACT.md` — execution contract, 9 sections, binary acceptance criteria
2. Read `SPECIFICATION.md` — the technical "why"
3. Read `ARCHITECTURE.md` — module layout, lifecycles, error model
4. Read `API.md` — MCP methods implemented, transports, Claude Desktop config
5. Read `TEST-PLAN.md` — concrete test scenarios
6. Read `ROADMAP.md` — what's in scope for v0.1 vs later phases
7. Cross-reference the MCP spec (linked in CONTRACT.md)
8. Cross-reference a2e-skills's INDEX-SCHEMA.json + CONVENTION.md
9. Cross-reference the two companion RFCs (a2e-shell RFC 001 and a2e-skills RFC 001) for the design context

Write code under `src/`, tests under `tests/`, examples under `examples/`, per the contract's line limits. Do not deviate from hard constraints without stopping and reporting.

## How to use this repo if you're a human

Same as above. The artifacts are self-describing.

## Repository layout

```
.
├── CONTRACT.md              # Execution contract — READ FIRST
├── SPECIFICATION.md         # Technical spec — the "why"
├── ARCHITECTURE.md          # Module layout + lifecycles
├── API.md                   # MCP methods + transports + Claude Desktop config
├── TEST-PLAN.md             # Concrete test scenarios
├── ROADMAP.md               # Phased delivery plan
├── README.md                # This file
├── LICENSE                  # MIT
├── package.json             # Starter metadata, no runtime deps
├── tsconfig.json            # Strict TS config
├── .gitignore
├── src/                     # (empty) implementation goes here
├── tests/                   # (empty) tests go here
└── examples/                # (empty) reference integrations go here
```

## Related

- [a2e-skills](https://github.com/MauricioPerera/a2e-skills) — the catalog format this adapter exposes
- [a2e-shell](https://github.com/MauricioPerera/a2e-shell) — primary consumer; its RFC 001 connects to this adapter over HTTP
- [js-git-store](https://github.com/MauricioPerera/js-git-store) — orthogonal; write-side substrate for programmatic catalog mutation via git
- [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18) — the protocol contract

## License

MIT (see LICENSE).
