/**
 * MCP primitive types (spec 2025-06-18 subset this adapter implements).
 */

export interface McpToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: McpToolInputSchema;
}

export interface McpToolContentText {
  type: "text";
  text: string;
}

export interface McpCallToolResult {
  content: readonly McpToolContentText[];
  isError?: boolean;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface McpPromptArgumentSchema {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: readonly McpPromptArgumentSchema[];
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface McpGetPromptResult {
  description?: string;
  messages: readonly McpPromptMessage[];
}

export interface McpInitializeParams {
  protocolVersion: string;
  clientInfo?: { name: string; version?: string };
  capabilities?: Record<string, unknown>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "mcp-serve-catalog", version: "0.1.0" } as const;
