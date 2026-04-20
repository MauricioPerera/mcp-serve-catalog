import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { startServer, type StartedServer } from "../../src/index.js";

const FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1"),
  "..",
  "fixtures",
  "catalog-small",
);

describe("stdio transport end-to-end", () => {
  let server: StartedServer;
  let stdin: PassThrough;
  let stdout: PassThrough;
  const responses: string[] = [];

  beforeAll(async () => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stdout.setEncoding("utf8");
    let buf = "";
    stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        responses.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });

    // Build custom stdio args via a test-only startup.
    // startServer's default wires to process.stdin/stdout; for testing we
    // construct the pieces directly.
    const { CatalogReader } = await import("../../src/catalog/reader.js");
    const { CatalogWatcher } = await import("../../src/catalog/watcher.js");
    const { startStdioTransport } = await import("../../src/transports/stdio.js");
    const { noopLogger } = await import("../../src/logger.js");

    const reader = new CatalogReader(FIXTURE, 60_000);
    const watcher = new CatalogWatcher(reader.paths, 0);
    const handle = startStdioTransport({
      ctx: { reader, allowlistBinaries: null, execTimeoutMs: 5000, logger: noopLogger },
      logger: noopLogger,
      stdin,
      stdout,
    });

    server = {
      reader,
      watcher,
      stdio: handle,
      async close() {
        handle.close();
        watcher.stop();
      },
    };
  });

  afterAll(async () => {
    await server.close();
  });

  async function request<T>(body: unknown, expectedId: number): Promise<T> {
    const lineBefore = responses.length;
    stdin.write(JSON.stringify(body) + "\n");
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const newLines = responses.slice(lineBefore);
      for (const l of newLines) {
        const parsed = JSON.parse(l) as { id?: unknown };
        if (parsed.id === expectedId) return parsed as T;
      }
    }
    throw new Error(`no response for id ${expectedId}`);
  }

  it("round-trips a tools/list request", async () => {
    const r = await request<{ result: { tools: Array<{ name: string }> } }>(
      { jsonrpc: "2.0", id: 100, method: "tools/list" },
      100,
    );
    expect(r.result.tools[0]!.name).toBe("echo");
  });

  it("round-trips a prompts/get with template substitution", async () => {
    const r = await request<{
      result: { messages: Array<{ content: { text: string } }> };
    }>(
      {
        jsonrpc: "2.0",
        id: 101,
        method: "prompts/get",
        params: { name: "greet", arguments: { name: "test" } },
      },
      101,
    );
    expect(r.result.messages[0]!.content.text).toContain("Hola, test!");
  });

  it("writes JSON-RPC error for malformed input", async () => {
    const r = await request<{ error: { code: number } }>(
      { jsonrpc: "1.0", method: "foo" } as unknown as { jsonrpc: "2.0" },
      0,
    ).catch(() => null);
    // The "0" id won't match since the server replies with id: null on invalid envelope.
    // Instead check that an error line was emitted.
    expect(responses.some((l) => /error/i.test(l) && /code":-32600/.test(l))).toBe(true);
  });
});
