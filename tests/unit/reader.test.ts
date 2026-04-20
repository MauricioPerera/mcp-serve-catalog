import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { CatalogReader, detectLayout } from "../../src/catalog/reader.js";
import { McpError } from "../../src/protocol/jsonrpc.js";

const FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1"),
  "..",
  "fixtures",
  "catalog-small",
);

describe("detectLayout", () => {
  it("detects the .index-out layout in the fixture", () => {
    const layout = detectLayout(FIXTURE);
    expect(layout.indexDir).toContain(".index-out");
    expect(layout.contentDir).toBe(path.resolve(FIXTURE));
  });

  it("throws when catalog does not exist", () => {
    expect(() => detectLayout("/nonexistent/path/abc")).toThrowError(McpError);
  });

  it("throws when neither layout is present", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-empty-"));
    try {
      expect(() => detectLayout(empty)).toThrowError(McpError);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("CatalogReader", () => {
  it("reads all partitions from the fixture", () => {
    const reader = new CatalogReader(FIXTURE, 60_000);
    const skills = reader.readSkills();
    expect(skills["echo"]).toBeDefined();
    expect(skills["echo"]!.requires).toContain("bash");

    const docs = reader.readDocs();
    expect(docs["hello"]).toBeDefined();

    const prompts = reader.readPrompts();
    expect(prompts["greet"]).toBeDefined();
    expect(prompts["greet"]!.input_vars).toHaveLength(1);
  });

  it("caches reads within TTL (no re-parse)", () => {
    const reader = new CatalogReader(FIXTURE, 60_000);
    const a = reader.readSkills();
    const b = reader.readSkills();
    expect(a).toBe(b); // same object reference means cached
  });

  it("invalidate() forces re-read", () => {
    const reader = new CatalogReader(FIXTURE, 60_000);
    const a = reader.readSkills();
    reader.invalidate();
    const b = reader.readSkills();
    expect(a).not.toBe(b);
    expect(a["echo"]).toEqual(b["echo"]);
  });

  it("returns empty entries if partition file is missing", () => {
    const partial = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-partial-"));
    try {
      fs.mkdirSync(path.join(partial, ".index-out"), { recursive: true });
      fs.writeFileSync(
        path.join(partial, ".index-out", "manifest.json"),
        '{"schema_version":"1.0"}',
      );
      // no skills/docs/prompts partitions
      const reader = new CatalogReader(partial, 60_000);
      expect(reader.readSkills()).toEqual({});
      expect(reader.readDocs()).toEqual({});
      expect(reader.readPrompts()).toEqual({});
    } finally {
      fs.rmSync(partial, { recursive: true, force: true });
    }
  });
});
