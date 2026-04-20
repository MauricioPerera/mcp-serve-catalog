/**
 * Translate a2e-skills entries into MCP primitives.
 *
 *   skills/   → tools
 *   docs/     → resources (with catalog:// URI scheme)
 *   prompts/  → prompts (with input_var substitution on get)
 */

import { McpError, JSON_RPC_ERROR_CODES } from "../protocol/jsonrpc.js";
import type {
  DocEntry,
  PromptEntry,
  SkillEntry,
} from "./reader.js";
import type {
  McpGetPromptResult,
  McpPrompt,
  McpResource,
  McpTool,
  McpToolInputSchema,
} from "../protocol/mcp-types.js";

const RESOURCE_URI_PREFIX = "catalog://docs/";

// --- Skills → Tools ---------------------------------------------------------

export function skillToTool(skill: SkillEntry): McpTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of skill.args) {
    properties[arg.name] = buildPropertySchema(arg.type, arg.description);
    if (arg.required) required.push(arg.name);
  }
  const inputSchema: McpToolInputSchema = { type: "object", properties };
  if (required.length > 0) inputSchema.required = required;
  const description = [skill.when_to_use, firstLine(skill.description)]
    .filter((s) => s.length > 0)
    .join(" — ");
  const tool: McpTool = {
    name: skill.name,
    inputSchema,
  };
  if (description.length > 0) tool.description = description;
  return tool;
}

function buildPropertySchema(
  type: "string" | "number" | "boolean" | "path",
  description?: string,
): Record<string, unknown> {
  const t = type === "path" ? "string" : type;
  const schema: Record<string, unknown> = { type: t };
  if (description !== undefined && description.length > 0) schema["description"] = description;
  return schema;
}

/**
 * Validate arguments against a skill's schema. Returns positional argv
 * suitable for the entry script — ordered by the skill's args declaration.
 * Missing optional args become empty strings so positional indices stay
 * stable.
 */
export function skillArgsToArgv(
  skill: SkillEntry,
  args: Record<string, unknown>,
): string[] {
  const argv: string[] = [];
  for (const spec of skill.args) {
    const raw = args[spec.name];
    if (raw === undefined || raw === null) {
      if (spec.required) {
        throw new McpError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          `missing required argument: '${spec.name}'`,
        );
      }
      argv.push("");
      continue;
    }
    // Type narrow + coerce
    if (spec.type === "string" || spec.type === "path") {
      if (typeof raw !== "string") {
        throw new McpError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          `'${spec.name}' must be a string (got ${typeof raw})`,
        );
      }
      argv.push(raw);
    } else if (spec.type === "number") {
      if (typeof raw !== "number") {
        throw new McpError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          `'${spec.name}' must be a number (got ${typeof raw})`,
        );
      }
      argv.push(String(raw));
    } else if (spec.type === "boolean") {
      if (typeof raw !== "boolean") {
        throw new McpError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          `'${spec.name}' must be a boolean (got ${typeof raw})`,
        );
      }
      argv.push(raw ? "true" : "false");
    }
  }
  return argv;
}

/**
 * Check each of `requires` against the operator's allowlist. Returns the
 * first binary that's blocked, or null if all are allowed. An undefined
 * allowlist means "no restriction".
 */
export function findBlockedBinary(
  requires: readonly string[],
  allowlist: readonly string[] | null,
): string | null {
  if (allowlist === null) return null;
  const allowed = new Set(allowlist);
  for (const bin of requires) if (!allowed.has(bin)) return bin;
  return null;
}

// --- Docs → Resources -------------------------------------------------------

export function docToResource(doc: DocEntry): McpResource {
  const r: McpResource = {
    uri: `${RESOURCE_URI_PREFIX}${doc.name}`,
    name: doc.name,
    mimeType: "text/markdown",
  };
  if (doc.summary.length > 0) r.description = doc.summary;
  return r;
}

export function resolveResourceName(uri: string): string {
  if (!uri.startsWith(RESOURCE_URI_PREFIX)) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      `unknown URI scheme: '${uri}' (expected '${RESOURCE_URI_PREFIX}...')`,
    );
  }
  const name = uri.slice(RESOURCE_URI_PREFIX.length);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      `malformed resource name in URI: '${name}'`,
    );
  }
  return name;
}

// --- Prompts → Prompts ------------------------------------------------------

export function promptToMcp(prompt: PromptEntry): McpPrompt {
  const out: McpPrompt = { name: prompt.name };
  if (prompt.purpose.length > 0) out.description = prompt.purpose;
  if (prompt.input_vars.length > 0) {
    out.arguments = prompt.input_vars.map((v) => {
      const arg: { name: string; description?: string; required?: boolean } = { name: v.name };
      if (v.description !== undefined) arg.description = v.description;
      if (v.required !== undefined) arg.required = v.required;
      return arg as McpPrompt["arguments"] extends readonly (infer A)[] ? A : never;
    });
  }
  return out;
}

/**
 * Render a prompt template by substituting {{var_name}} tokens with
 * the supplied values. Missing required vars → INVALID_PARAMS.
 * Missing optional vars leave the placeholder verbatim (no warning).
 */
export function renderPrompt(
  prompt: PromptEntry,
  body: string,
  args: Record<string, unknown>,
): McpGetPromptResult {
  // Validate required args
  for (const v of prompt.input_vars) {
    if (v.required && (args[v.name] === undefined || args[v.name] === null)) {
      throw new McpError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `prompt '${prompt.name}': missing required argument '${v.name}'`,
      );
    }
  }

  // Substitute {{name}} tokens
  let rendered = body;
  for (const [name, raw] of Object.entries(args)) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    const token = new RegExp(`\\{\\{\\s*${escapeRegex(name)}\\s*\\}\\}`, "g");
    rendered = rendered.replace(token, value);
  }

  const result: McpGetPromptResult = {
    messages: [{ role: "user", content: { type: "text", text: rendered } }],
  };
  if (prompt.purpose.length > 0) result.description = prompt.purpose;
  return result;
}

// --- utilities --------------------------------------------------------------

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i < 0 ? s : s.slice(0, i)).trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
