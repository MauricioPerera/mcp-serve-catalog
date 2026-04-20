/**
 * HTTP transport — POST /mcp with JSON-RPC 2.0 body. node:http directly,
 * no framework. Response is always application/json (single request/response).
 *
 * Notifications are ACCEPTED but not responded to (204). Since HTTP has
 * no long-lived connection, server → client notifications are NOT
 * delivered via this transport — clients needing them should use SSE.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  buildError,
  errorToResponse,
  isNotification,
  JSON_RPC_ERROR_CODES,
  McpError,
  parseJsonRpc,
  buildSuccess,
} from "../protocol/jsonrpc.js";
import { dispatch, type HandlerContext } from "../protocol/handlers.js";
import type { Logger } from "../logger.js";

export interface HttpTransportOptions {
  host: string;
  port: number;
  ctx: HandlerContext;
  logger: Logger;
}

export interface HttpTransportHandle {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

export function startHttpTransport(
  opts: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const { ctx, logger } = opts;
  const server = createServer((req, res) => handleRequest(req, res, ctx, logger));

  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      logger.info("transport.http.listening", { host: opts.host, port: boundPort });
      resolve({
        server,
        port: boundPort,
        close() {
          return new Promise<void>((done) => {
            server.close(() => done());
          });
        },
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
  logger: Logger,
): Promise<void> {
  if (req.method !== "POST" || (req.url !== "/mcp" && req.url !== "/mcp/")) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const body = await readBody(req);
  let parsed: ReturnType<typeof parseJsonRpc>;
  try {
    parsed = parseJsonRpc(body);
  } catch (e) {
    const errResp = errorToResponse(null, e);
    sendJson(res, 400, errResp);
    return;
  }

  if (isNotification(parsed)) {
    // Fire-and-forget; fine to dispatch to keep side-effects (e.g. the
    // "notifications/initialized" handler is a no-op).
    try {
      await dispatch(parsed.method, parsed.params, ctx);
    } catch (e) {
      logger.warn("notification.handler_threw", { method: parsed.method, err: String(e) });
    }
    res.statusCode = 204;
    res.end();
    return;
  }

  const id = parsed.id;
  const start = Date.now();
  try {
    const result = await dispatch(parsed.method, parsed.params, ctx);
    const duration_ms = Date.now() - start;
    logger.info("request.handled", { method: parsed.method, id, duration_ms, status: "ok" });
    sendJson(res, 200, buildSuccess(id, result));
  } catch (e) {
    const duration_ms = Date.now() - start;
    const code = e instanceof McpError ? e.code : JSON_RPC_ERROR_CODES.INTERNAL_ERROR;
    logger.info("request.handled", {
      method: parsed.method,
      id,
      duration_ms,
      status: "error",
      code,
    });
    sendJson(res, 200, errorToResponse(id, e));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

// Placate TS unused import check when buildError isn't referenced in some build modes.
export { buildError };
