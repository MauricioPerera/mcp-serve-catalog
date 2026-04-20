import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { startServer, type StartedServer } from "../../src/index.js";

const FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1"),
  "..",
  "fixtures",
  "catalog-small",
);

async function rpc(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return null;
  return await res.json();
}

describe("HTTP transport end-to-end", () => {
  let server: StartedServer;
  let url: string;

  beforeAll(async () => {
    server = await startServer({
      catalogPath: FIXTURE,
      transport: "http",
      host: "127.0.0.1",
      port: 0, // random
      execTimeoutMs: 5000,
      pollIntervalMs: 0, // disable watcher
    });
    url = `http://127.0.0.1:${server.http!.port}/mcp`;
  });

  afterAll(async () => {
    await server.close();
  });

  it("initialize returns protocol + capabilities", async () => {
    const r = (await rpc(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "vitest", version: "0" }, capabilities: {} },
    })) as { result: { protocolVersion: string; capabilities: Record<string, unknown> } };
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities).toMatchObject({
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: false },
      prompts: { listChanged: true },
    });
  });

  it("tools/list returns echo skill as a Tool", async () => {
    const r = (await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> };
    };
    expect(r.result.tools).toHaveLength(1);
    expect(r.result.tools[0]!.name).toBe("echo");
    expect(r.result.tools[0]!.inputSchema.required).toEqual(["message"]);
  });

  it("tools/call echo returns stdout wrapped as CallToolResult", async () => {
    const r = (await rpc(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hola" } },
    })) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(r.result.isError).toBeFalsy();
    expect(r.result.content[0]!.type).toBe("text");
    expect(r.result.content[0]!.text).toContain("hola");
  });

  it("tools/call with missing required arg returns INVALID_PARAMS", async () => {
    const r = (await rpc(url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    })) as { error: { code: number } };
    expect(r.error.code).toBe(-32602);
  });

  it("tools/call for unknown tool returns INVALID_PARAMS", async () => {
    const r = (await rpc(url, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "does-not-exist", arguments: {} },
    })) as { error: { code: number } };
    expect(r.error.code).toBe(-32602);
  });

  it("resources/list returns hello doc", async () => {
    const r = (await rpc(url, { jsonrpc: "2.0", id: 6, method: "resources/list" })) as {
      result: { resources: Array<{ uri: string; mimeType: string }> };
    };
    expect(r.result.resources).toHaveLength(1);
    expect(r.result.resources[0]!.uri).toBe("catalog://docs/hello");
  });

  it("resources/read returns the file body", async () => {
    const r = (await rpc(url, {
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri: "catalog://docs/hello" },
    })) as { result: { contents: Array<{ uri: string; text: string }> } };
    expect(r.result.contents[0]!.uri).toBe("catalog://docs/hello");
    expect(r.result.contents[0]!.text).toContain("Hello");
    expect(r.result.contents[0]!.text).toContain("minimal sample doc");
  });

  it("prompts/list returns greet prompt", async () => {
    const r = (await rpc(url, { jsonrpc: "2.0", id: 8, method: "prompts/list" })) as {
      result: { prompts: Array<{ name: string; arguments: Array<{ name: string; required: boolean }> }> };
    };
    expect(r.result.prompts).toHaveLength(1);
    expect(r.result.prompts[0]!.name).toBe("greet");
    expect(r.result.prompts[0]!.arguments[0]).toMatchObject({ name: "name", required: true });
  });

  it("prompts/get renders the template with substituted vars", async () => {
    const r = (await rpc(url, {
      jsonrpc: "2.0",
      id: 9,
      method: "prompts/get",
      params: { name: "greet", arguments: { name: "mundo" } },
    })) as { result: { messages: Array<{ role: string; content: { text: string } }> } };
    expect(r.result.messages[0]!.role).toBe("user");
    expect(r.result.messages[0]!.content.text).toContain("Hola, mundo!");
    // Frontmatter should be stripped
    expect(r.result.messages[0]!.content.text).not.toContain("---");
  });

  it("unknown method returns METHOD_NOT_FOUND", async () => {
    const r = (await rpc(url, {
      jsonrpc: "2.0",
      id: 10,
      method: "sampling/createMessage",
      params: {},
    })) as { error: { code: number } };
    expect(r.error.code).toBe(-32601);
  });

  it("notification receives 204 and no body", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(204);
  });

  it("malformed JSON returns 400 with PARSE_ERROR", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("GET returns 404", async () => {
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });
});
