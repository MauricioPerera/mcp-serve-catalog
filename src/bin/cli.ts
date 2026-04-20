#!/usr/bin/env node
/**
 * CLI — reads env vars, picks the transport, starts the server.
 * Build produces dist/bin/cli.js; package.json bin field points here.
 */

import { startServer, type ServerConfig } from "../index.js";
import type { Logger } from "../logger.js";

function makeStderrLogger(level: string): Logger {
  const levels = ["debug", "info", "warn", "error"];
  const threshold = Math.max(0, levels.indexOf(level));
  const write = (lvl: string, ev: string, data?: Record<string, unknown>) => {
    if (levels.indexOf(lvl) < threshold) return;
    const entry = { level: lvl, event: ev, ...data, time: new Date().toISOString() };
    process.stderr.write(JSON.stringify(entry) + "\n");
  };
  return {
    debug: (e, d) => write("debug", e, d),
    info: (e, d) => write("info", e, d),
    warn: (e, d) => write("warn", e, d),
    error: (e, d) => write("error", e, d),
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const catalogPath = env["CATALOG_PATH"];
  if (!catalogPath) {
    process.stderr.write("CATALOG_PATH env var is required\n");
    process.exit(2);
  }
  const transport = (env["TRANSPORT"] ?? "http") as "http" | "stdio";
  if (transport !== "http" && transport !== "stdio") {
    process.stderr.write(`TRANSPORT must be 'http' or 'stdio' (got '${transport}')\n`);
    process.exit(2);
  }
  const logger = makeStderrLogger((env["LOG_LEVEL"] ?? "info").toLowerCase());

  const config: ServerConfig = { catalogPath, transport, logger };
  if (env["HOST"]) config.host = env["HOST"];
  if (env["PORT"]) config.port = Number.parseInt(env["PORT"], 10);
  if (env["EXEC_TIMEOUT_MS"]) config.execTimeoutMs = Number.parseInt(env["EXEC_TIMEOUT_MS"], 10);
  if (env["CACHE_TTL_MS"]) config.cacheTtlMs = Number.parseInt(env["CACHE_TTL_MS"], 10);
  if (env["POLL_INTERVAL_MS"])
    config.pollIntervalMs = Number.parseInt(env["POLL_INTERVAL_MS"], 10);
  if (env["ALLOWLIST_BINARIES"])
    config.allowlistBinaries = env["ALLOWLIST_BINARIES"]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const server = await startServer(config);

  const shutdown = async (signal: string) => {
    logger.info("server.shutdown", { signal });
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
