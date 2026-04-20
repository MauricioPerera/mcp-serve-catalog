/**
 * MCP method dispatch. Each handler is pure: takes params + a context,
 * returns the result object (or throws McpError). Protocol-level
 * error mapping lives in the transport layer.
 */

import * as fs from "node:fs/promises";
import { McpError, JSON_RPC_ERROR_CODES } from "./jsonrpc.js";
import {
  MCP_PROTOCOL_VERSION,
  SERVER_INFO,
  type McpCallToolResult,
  type McpGetPromptResult,
  type McpInitializeResult,
  type McpPrompt,
  type McpResource,
  type McpResourceContents,
  type McpTool,
} from "./mcp-types.js";
import type { CatalogReader, SkillEntry } from "../catalog/reader.js";
import {
  docToResource,
  findBlockedBinary,
  promptToMcp,
  renderPrompt,
  resolveResourceName,
  skillArgsToArgv,
  skillToTool,
} from "../catalog/mapper.js";
import { execSkill } from "../catalog/exec.js";
import type { Logger } from "../logger.js";

export interface HandlerContext {
  reader: CatalogReader;
  allowlistBinaries: readonly string[] | null;
  execTimeoutMs: number;
  logger: Logger;
}

/**
 * Dispatch a JSON-RPC method to its handler. Returns the result value
 * (to be wrapped in JsonRpcSuccess). Unknown methods throw METHOD_NOT_FOUND.
 * Handler exceptions propagate unchanged.
 */
export async function dispatch(
  method: string,
  params: unknown,
  ctx: HandlerContext,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return handleInitialize();
    case "initialized":
    case "notifications/initialized":
      // Notification — caller should not have routed it here for a response,
      // but if they did, return empty.
      return {};
    case "tools/list":
      return handleToolsList(ctx);
    case "tools/call":
      return await handleToolsCall(params, ctx);
    case "resources/list":
      return handleResourcesList(ctx);
    case "resources/read":
      return await handleResourcesRead(params, ctx);
    case "prompts/list":
      return handlePromptsList(ctx);
    case "prompts/get":
      return await handlePromptsGet(params, ctx);
    default:
      throw new McpError(
        JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
        `method not supported: '${method}'`,
      );
  }
}

// --- handlers ---------------------------------------------------------------

function handleInitialize(): McpInitializeResult {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: { ...SERVER_INFO },
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: false },
      prompts: { listChanged: true },
    },
  };
}

function handleToolsList(ctx: HandlerContext): { tools: McpTool[] } {
  const skills = ctx.reader.readSkills();
  const tools: McpTool[] = [];
  for (const skill of Object.values(skills)) {
    tools.push(skillToTool(skill));
  }
  return { tools };
}

async function handleToolsCall(
  params: unknown,
  ctx: HandlerContext,
): Promise<McpCallToolResult> {
  const p = validateObject(params, "tools/call params");
  const name = requireString(p, "name");
  const argsRaw = p["arguments"];
  const args =
    argsRaw === undefined || argsRaw === null
      ? {}
      : (validateObject(argsRaw, "tools/call.arguments") as Record<string, unknown>);

  const skills = ctx.reader.readSkills();
  const skill = skills[name];
  if (!skill) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      `unknown tool: '${name}'`,
    );
  }
  // Enforce allowlist BEFORE running — return a tool-level error so the
  // client sees isError rather than a JSON-RPC failure.
  const blocked = findBlockedBinary(skill.requires, ctx.allowlistBinaries);
  if (blocked !== null) {
    return {
      content: [
        {
          type: "text",
          text: `skill '${name}' requires '${blocked}' which is not in the allowlist`,
        },
      ],
      isError: true,
    };
  }

  const argv = skillArgsToArgv(skill, args);
  ctx.logger.debug("tool.exec", { name, argv_length: argv.length });
  const result = await execSkill(ctx.reader, skill, argv, {
    timeoutMs: ctx.execTimeoutMs,
  });
  ctx.logger.info("tool.executed", {
    name,
    isError: result.isError ?? false,
  });
  return result;
}

function handleResourcesList(ctx: HandlerContext): { resources: McpResource[] } {
  const docs = ctx.reader.readDocs();
  const resources: McpResource[] = [];
  for (const doc of Object.values(docs)) resources.push(docToResource(doc));
  return { resources };
}

async function handleResourcesRead(
  params: unknown,
  ctx: HandlerContext,
): Promise<{ contents: McpResourceContents[] }> {
  const p = validateObject(params, "resources/read params");
  const uri = requireString(p, "uri");
  const name = resolveResourceName(uri);
  const docs = ctx.reader.readDocs();
  const doc = docs[name];
  if (!doc) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      `unknown resource: '${uri}'`,
    );
  }
  const filePath = ctx.reader.contentPath(doc.doc_path);
  let body: string;
  try {
    body = await fs.readFile(filePath, "utf8");
  } catch (e) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.CATALOG_ERROR,
      `failed to read resource '${uri}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return {
    contents: [{ uri, mimeType: "text/markdown", text: body }],
  };
}

function handlePromptsList(ctx: HandlerContext): { prompts: McpPrompt[] } {
  const prompts = ctx.reader.readPrompts();
  const out: McpPrompt[] = [];
  for (const prompt of Object.values(prompts)) out.push(promptToMcp(prompt));
  return { prompts: out };
}

async function handlePromptsGet(
  params: unknown,
  ctx: HandlerContext,
): Promise<McpGetPromptResult> {
  const p = validateObject(params, "prompts/get params");
  const name = requireString(p, "name");
  const argsRaw = p["arguments"];
  const args =
    argsRaw === undefined || argsRaw === null
      ? {}
      : (validateObject(argsRaw, "prompts/get.arguments") as Record<string, unknown>);

  const prompts = ctx.reader.readPrompts();
  const prompt = prompts[name];
  if (!prompt) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      `unknown prompt: '${name}'`,
    );
  }
  const filePath = ctx.reader.contentPath(prompt.prompt_path);
  let body: string;
  try {
    body = await fs.readFile(filePath, "utf8");
  } catch (e) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.CATALOG_ERROR,
      `failed to read prompt '${name}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Strip frontmatter (everything between first and second "---" at start of file).
  const stripped = stripFrontmatter(body);
  return renderPrompt(prompt, stripped, args);
}

// --- validators -------------------------------------------------------------

function validateObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new McpError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, `${where}: expected object`);
  }
  return v as Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      `missing or non-string '${key}'`,
    );
  }
  return v;
}

function stripFrontmatter(body: string): string {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return body;
  const afterFirst = body.indexOf("\n", 3);
  if (afterFirst < 0) return body;
  const end = body.indexOf("\n---", afterFirst);
  if (end < 0) return body;
  const lineEnd = body.indexOf("\n", end + 4);
  if (lineEnd < 0) return body.slice(end + 4);
  return body.slice(lineEnd + 1);
}
