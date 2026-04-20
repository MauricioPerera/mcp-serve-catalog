/**
 * Skill spawn — runs the entry script with argv + timeout + stdout capture.
 * NEVER uses shell: true. Always argv arrays.
 */

import { spawn } from "node:child_process";
import { McpError, JSON_RPC_ERROR_CODES } from "../protocol/jsonrpc.js";
import type { CatalogReader } from "./reader.js";
import type { SkillEntry } from "./reader.js";
import type { McpCallToolResult } from "../protocol/mcp-types.js";

export interface ExecOptions {
  /** Milliseconds before SIGKILL. Default 30_000. */
  timeoutMs: number;
  /** cwd for the spawned skill. If undefined, defaults to content dir. */
  cwd?: string;
}

/**
 * Runs `bash <contentDir>/<skill.entry_path> <...argv>` and wraps the
 * output as an MCP CallToolResult. Exit 0 → content[0].text = stdout,
 * isError false. Non-zero exit or timeout → isError true with stderr or
 * a timeout message in content.
 */
export async function execSkill(
  reader: CatalogReader,
  skill: SkillEntry,
  argv: readonly string[],
  opts: ExecOptions,
): Promise<McpCallToolResult> {
  const scriptPath = reader.contentPath(skill.entry_path);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return await new Promise<McpCallToolResult>((resolve, reject) => {
    let timedOut = false;
    let settled = false;

    const child = spawn("bash", [scriptPath, ...argv], {
      cwd: opts.cwd ?? reader.paths.contentDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new McpError(
          JSON_RPC_ERROR_CODES.EXEC_ERROR,
          `spawn failed for skill '${skill.name}': ${err.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (timedOut) {
        resolve({
          content: [
            {
              type: "text",
              text: `skill '${skill.name}' timed out after ${opts.timeoutMs}ms`,
            },
          ],
          isError: true,
        });
        return;
      }
      if (code !== 0) {
        resolve({
          content: [{ type: "text", text: stderr.length > 0 ? stderr : `exit ${code}` }],
          isError: true,
        });
        return;
      }
      resolve({
        content: [{ type: "text", text: stdout }],
        isError: false,
      });
    });
  });
}
