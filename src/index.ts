/**
 * mcp-serve-catalog — thin MCP server that exposes an a2e-skills catalog.
 *
 * Library entry: construct + start a server programmatically.
 * CLI entry: src/bin/cli.ts (reads env, wires defaults).
 */

import { CatalogReader } from "./catalog/reader.js";
import { CatalogWatcher } from "./catalog/watcher.js";
import type { HandlerContext } from "./protocol/handlers.js";
import { noopLogger, type Logger } from "./logger.js";
import { startHttpTransport, type HttpTransportHandle } from "./transports/http.js";
import { startStdioTransport, type StdioTransportHandle } from "./transports/stdio.js";

export interface ServerConfig {
  catalogPath: string;
  transport: "http" | "stdio";
  host?: string;
  port?: number;
  execTimeoutMs?: number;
  cacheTtlMs?: number;
  pollIntervalMs?: number;
  allowlistBinaries?: readonly string[] | null;
  logger?: Logger;
}

export interface StartedServer {
  http?: HttpTransportHandle;
  stdio?: StdioTransportHandle;
  readonly reader: CatalogReader;
  readonly watcher: CatalogWatcher;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig): Promise<StartedServer> {
  const logger = config.logger ?? noopLogger;
  const reader = new CatalogReader(config.catalogPath, config.cacheTtlMs ?? 60_000);
  const watcher = new CatalogWatcher(reader.paths, config.pollIntervalMs ?? 10_000);
  watcher.onChange(() => {
    reader.invalidate();
    logger.info("catalog.changed", {});
  });
  watcher.start();

  const ctx: HandlerContext = {
    reader,
    allowlistBinaries: config.allowlistBinaries ?? null,
    execTimeoutMs: config.execTimeoutMs ?? 30_000,
    logger,
  };

  logger.info("server.start", {
    transport: config.transport,
    catalog_path: config.catalogPath,
    index_dir: reader.paths.indexDir,
    content_dir: reader.paths.contentDir,
  });

  const started: Partial<StartedServer> & { reader: CatalogReader; watcher: CatalogWatcher } = {
    reader,
    watcher,
    async close() {
      watcher.stop();
      if (started.http) await started.http.close();
      if (started.stdio) started.stdio.close();
    },
  };

  if (config.transport === "http") {
    started.http = await startHttpTransport({
      host: config.host ?? "127.0.0.1",
      port: config.port ?? 8787,
      ctx,
      logger,
    });
  } else if (config.transport === "stdio") {
    started.stdio = startStdioTransport({ ctx, logger });
  } else {
    const _never: never = config.transport;
    throw new Error(`unknown transport: ${String(_never)}`);
  }

  return started as StartedServer;
}

// Public exports
export { noopLogger } from "./logger.js";
export type { Logger } from "./logger.js";
export { McpError, JSON_RPC_ERROR_CODES } from "./protocol/jsonrpc.js";
export type { HandlerContext } from "./protocol/handlers.js";
export { CatalogReader } from "./catalog/reader.js";
