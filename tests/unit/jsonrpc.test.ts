import { describe, it, expect } from "vitest";
import {
  buildError,
  buildSuccess,
  isNotification,
  JSON_RPC_ERROR_CODES,
  McpError,
  parseJsonRpc,
} from "../../src/protocol/jsonrpc.js";

describe("parseJsonRpc", () => {
  it("parses a valid request", () => {
    const r = parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"foo","params":{"a":1}}');
    expect(r.method).toBe("foo");
    expect((r as { id: number }).id).toBe(1);
  });

  it("parses a notification (no id)", () => {
    const r = parseJsonRpc('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(isNotification(r)).toBe(true);
    expect(r.method).toBe("notifications/initialized");
  });

  it("throws PARSE_ERROR on malformed JSON", () => {
    expect(() => parseJsonRpc("not-json")).toThrowError(McpError);
    try {
      parseJsonRpc("not-json");
    } catch (e) {
      expect((e as McpError).code).toBe(JSON_RPC_ERROR_CODES.PARSE_ERROR);
    }
  });

  it("throws INVALID_REQUEST when jsonrpc field is missing", () => {
    try {
      parseJsonRpc('{"method":"foo","id":1}');
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as McpError).code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it("throws INVALID_REQUEST when method is missing", () => {
    try {
      parseJsonRpc('{"jsonrpc":"2.0","id":1}');
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as McpError).code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it("throws INVALID_REQUEST when id is an object", () => {
    try {
      parseJsonRpc('{"jsonrpc":"2.0","id":{"a":1},"method":"foo"}');
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as McpError).code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it("rejects arrays at top level", () => {
    try {
      parseJsonRpc('[{"jsonrpc":"2.0","id":1,"method":"foo"}]');
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as McpError).code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
    }
  });
});

describe("buildSuccess / buildError", () => {
  it("success has result", () => {
    expect(buildSuccess(1, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });

  it("error without data", () => {
    expect(buildError(1, -32601, "method not found")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method not found" },
    });
  });

  it("error with data", () => {
    expect(buildError(null, -32603, "internal", { foo: "bar" })).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "internal", data: { foo: "bar" } },
    });
  });
});
