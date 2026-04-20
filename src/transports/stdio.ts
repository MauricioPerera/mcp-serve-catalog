/**
 * Stdio transport — line-framed JSON-RPC 2.0 over stdin/stdout.
 * MUST NOT write anything protocol-related to stderr; stderr is for
 * the injectable logger only (the parent process captures it as logs).
 */

import {
  buildSuccess,
  errorToResponse,
  isNotification,
  JSON_RPC_ERROR_CODES,
  McpError,
  parseJsonRpc,
} from "../protocol/jsonrpc.js";
import { dispatch, type HandlerContext } from "../protocol/handlers.js";
import type { Logger } from "../logger.js";

export interface StdioTransportOptions {
  ctx: HandlerContext;
  logger: Logger;
  /** Read interface (default: process.stdin). Override for testing. */
  stdin?: NodeJS.ReadableStream;
  /** Write interface (default: process.stdout). */
  stdout?: NodeJS.WritableStream;
  /** Called when EOF reached on stdin. Default: process.exit(0). */
  onEof?: () => void;
}

export interface StdioTransportHandle {
  close(): void;
}

export function startStdioTransport(opts: StdioTransportOptions): StdioTransportHandle {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  let buffer = "";
  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      void handleLine(line, opts.ctx, stdout, opts.logger);
    }
  };
  const onEof = () => {
    if (buffer.trim().length > 0) {
      void handleLine(buffer.trim(), opts.ctx, stdout, opts.logger);
      buffer = "";
    }
    opts.onEof?.();
  };

  stdin.setEncoding("utf8");
  stdin.on("data", onData);
  stdin.on("end", onEof);

  opts.logger.info("transport.stdio.ready", {});

  return {
    close() {
      stdin.off("data", onData);
      stdin.off("end", onEof);
    },
  };
}

async function handleLine(
  line: string,
  ctx: HandlerContext,
  stdout: NodeJS.WritableStream,
  logger: Logger,
): Promise<void> {
  let parsed: ReturnType<typeof parseJsonRpc>;
  try {
    parsed = parseJsonRpc(line);
  } catch (e) {
    writeLine(stdout, errorToResponse(null, e));
    return;
  }

  if (isNotification(parsed)) {
    try {
      await dispatch(parsed.method, parsed.params, ctx);
    } catch (e) {
      logger.warn("notification.handler_threw", { method: parsed.method, err: String(e) });
    }
    return; // no response for notifications
  }

  const id = parsed.id;
  const start = Date.now();
  try {
    const result = await dispatch(parsed.method, parsed.params, ctx);
    const duration_ms = Date.now() - start;
    logger.info("request.handled", { method: parsed.method, id, duration_ms, status: "ok" });
    writeLine(stdout, buildSuccess(id, result));
  } catch (e) {
    const code = e instanceof McpError ? e.code : JSON_RPC_ERROR_CODES.INTERNAL_ERROR;
    logger.info("request.handled", { method: parsed.method, id, status: "error", code });
    writeLine(stdout, errorToResponse(id, e));
  }
}

function writeLine(stdout: NodeJS.WritableStream, msg: unknown): void {
  stdout.write(JSON.stringify(msg) + "\n");
}
