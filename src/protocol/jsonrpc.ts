/**
 * JSON-RPC 2.0 codec + error semantics. Minimal, hand-rolled (zero deps).
 *
 * Spec: https://www.jsonrpc.org/specification
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  id?: never; // discriminator: absence of id distinguishes from JsonRpcRequest
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcErrorResponse;

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Reserved application range: -32000 to -32099
  CATALOG_ERROR: -32001,
  EXEC_ERROR: -32002,
} as const;

export type McpErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * Parse a JSON-RPC envelope from an incoming string. Returns the parsed
 * message or throws an McpError with PARSE_ERROR / INVALID_REQUEST as
 * appropriate. Accepts both requests and notifications.
 */
export function parseJsonRpc(body: string): JsonRpcRequest | JsonRpcNotification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.PARSE_ERROR,
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new McpError(JSON_RPC_ERROR_CODES.INVALID_REQUEST, "envelope must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["jsonrpc"] !== "2.0") {
    throw new McpError(JSON_RPC_ERROR_CODES.INVALID_REQUEST, "jsonrpc field must be '2.0'");
  }
  if (typeof obj["method"] !== "string" || obj["method"].length === 0) {
    throw new McpError(JSON_RPC_ERROR_CODES.INVALID_REQUEST, "method must be a non-empty string");
  }
  const id = obj["id"];
  if (id !== undefined && typeof id !== "number" && typeof id !== "string") {
    throw new McpError(JSON_RPC_ERROR_CODES.INVALID_REQUEST, "id must be number, string, or absent");
  }
  return parsed as JsonRpcRequest | JsonRpcNotification;
}

export function isNotification(
  msg: JsonRpcRequest | JsonRpcNotification,
): msg is JsonRpcNotification {
  return (msg as { id?: unknown }).id === undefined;
}

export function buildSuccess<T>(id: number | string, result: T): JsonRpcSuccess<T> {
  return { jsonrpc: "2.0", id, result };
}

export function buildError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const err: JsonRpcErrorResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  if (data !== undefined) err.error.data = data;
  return err;
}

export function errorToResponse(
  id: number | string | null,
  err: unknown,
): JsonRpcErrorResponse {
  if (err instanceof McpError) return buildError(id, err.code, err.message, err.data);
  const msg = err instanceof Error ? err.message : String(err);
  return buildError(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, msg);
}
