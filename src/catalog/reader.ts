/**
 * Catalog partition loader with layout detection and TTL-based cache.
 *
 * Supports two a2e-skills catalog layouts:
 *   A) Worktree layout:
 *        <CATALOG_PATH>/index-worktree/   (partition files at root)
 *        <CATALOG_PATH>/content-worktree/ (content tree)
 *   B) gen-index.ts layout:
 *        <CATALOG_PATH>/.index-out/       (partition files from tools/gen-index.ts)
 *        <CATALOG_PATH>/                  (content at repo root)
 *
 * The reader is stateful (holds the cache) but concurrency-safe — readers
 * race on invalidation but the last one wins with the same disk data.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpError, JSON_RPC_ERROR_CODES } from "../protocol/jsonrpc.js";

export interface CatalogLayout {
  /** Directory containing manifest.json + per-category partition files. */
  indexDir: string;
  /** Directory containing skills/ docs/ prompts/ templates/ trees. */
  contentDir: string;
}

export interface SkillEntry {
  name: string;
  when_to_use: string;
  description: string;
  skill_path: string;
  entry: string;
  entry_path: string;
  entry_sha?: string;
  entry_bytes?: number;
  estimated_tokens?: number;
  args: readonly {
    name: string;
    type: "string" | "number" | "boolean" | "path";
    required: boolean;
    description?: string;
  }[];
  requires: readonly string[];
}

export interface DocEntry {
  name: string;
  title: string;
  summary: string;
  doc_path: string;
  tokens?: number;
}

export interface PromptEntry {
  name: string;
  purpose: string;
  description: string;
  prompt_path: string;
  input_vars: readonly {
    name: string;
    description?: string;
    required?: boolean;
  }[];
}

interface CachedPartition<T> {
  data: T;
  loadedAt: number;
  mtimeMs: number;
}

export class CatalogReader {
  private readonly layout: CatalogLayout;
  private readonly cacheTtlMs: number;
  private skillsCache: CachedPartition<{ entries: Record<string, SkillEntry> }> | null = null;
  private docsCache: CachedPartition<{ entries: Record<string, DocEntry> }> | null = null;
  private promptsCache: CachedPartition<{ entries: Record<string, PromptEntry> }> | null = null;

  constructor(catalogPath: string, cacheTtlMs: number) {
    this.layout = detectLayout(catalogPath);
    this.cacheTtlMs = cacheTtlMs;
  }

  get paths(): CatalogLayout {
    return this.layout;
  }

  readSkills(): Record<string, SkillEntry> {
    this.skillsCache = this.readPartition("skills.json", this.skillsCache);
    return this.skillsCache.data.entries;
  }

  readDocs(): Record<string, DocEntry> {
    this.docsCache = this.readPartition("docs.json", this.docsCache);
    return this.docsCache.data.entries;
  }

  readPrompts(): Record<string, PromptEntry> {
    this.promptsCache = this.readPartition("prompts.json", this.promptsCache);
    return this.promptsCache.data.entries;
  }

  /** Invalidate all cached partitions. */
  invalidate(): void {
    this.skillsCache = null;
    this.docsCache = null;
    this.promptsCache = null;
  }

  /** Absolute path to a content file relative to the content worktree. */
  contentPath(...parts: string[]): string {
    return path.join(this.layout.contentDir, ...parts);
  }

  private readPartition<T extends { entries: Record<string, unknown> }>(
    filename: string,
    existing: CachedPartition<T> | null,
  ): CachedPartition<T> {
    const filePath = path.join(this.layout.indexDir, filename);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      // Missing partition files mean "no entries of that kind". Return empty.
      return { data: { entries: {} } as T, loadedAt: Date.now(), mtimeMs: 0 };
    }
    const now = Date.now();
    if (
      existing &&
      existing.mtimeMs === stat.mtimeMs &&
      now - existing.loadedAt < this.cacheTtlMs
    ) {
      return existing;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      throw new McpError(
        JSON_RPC_ERROR_CODES.CATALOG_ERROR,
        `failed to parse ${filename}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new McpError(
        JSON_RPC_ERROR_CODES.CATALOG_ERROR,
        `${filename}: expected an object at top level`,
      );
    }
    const shape = parsed as { entries?: unknown };
    if (typeof shape.entries !== "object" || shape.entries === null) {
      throw new McpError(
        JSON_RPC_ERROR_CODES.CATALOG_ERROR,
        `${filename}: missing or non-object 'entries' field`,
      );
    }
    return { data: parsed as T, loadedAt: now, mtimeMs: stat.mtimeMs };
  }
}

export function detectLayout(catalogPath: string): CatalogLayout {
  const abs = path.resolve(catalogPath);
  if (!fs.existsSync(abs)) {
    throw new McpError(
      JSON_RPC_ERROR_CODES.CATALOG_ERROR,
      `catalog path does not exist: ${abs}`,
    );
  }

  // Layout A: worktrees
  const indexWorktree = path.join(abs, "index-worktree");
  if (fs.existsSync(path.join(indexWorktree, "manifest.json"))) {
    const contentWorktree = path.join(abs, "content-worktree");
    if (!fs.existsSync(contentWorktree)) {
      throw new McpError(
        JSON_RPC_ERROR_CODES.CATALOG_ERROR,
        `layout A detected (index-worktree present) but content-worktree missing at ${contentWorktree}`,
      );
    }
    return { indexDir: indexWorktree, contentDir: contentWorktree };
  }

  // Layout B: .index-out with content at repo root
  const indexOut = path.join(abs, ".index-out");
  if (fs.existsSync(path.join(indexOut, "manifest.json"))) {
    return { indexDir: indexOut, contentDir: abs };
  }

  throw new McpError(
    JSON_RPC_ERROR_CODES.CATALOG_ERROR,
    `catalog at ${abs} has neither index-worktree/manifest.json nor .index-out/manifest.json — run tools/gen-index.ts first or set up worktrees`,
  );
}
