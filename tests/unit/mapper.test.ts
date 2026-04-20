import { describe, it, expect } from "vitest";
import {
  docToResource,
  findBlockedBinary,
  promptToMcp,
  renderPrompt,
  resolveResourceName,
  skillArgsToArgv,
  skillToTool,
} from "../../src/catalog/mapper.js";
import { McpError } from "../../src/protocol/jsonrpc.js";

describe("skillToTool", () => {
  it("translates args + combines descriptions", () => {
    const t = skillToTool({
      name: "echo",
      when_to_use: "echo a message with timestamp",
      description: "Minimal skill.\nMore detail.",
      skill_path: "skills/echo",
      entry: "run.sh",
      entry_path: "skills/echo/run.sh",
      args: [
        { name: "message", type: "string", required: true, description: "what to echo" },
        { name: "loud", type: "boolean", required: false },
      ],
      requires: ["bash"],
    });
    expect(t.name).toBe("echo");
    expect(t.description).toContain("echo a message");
    expect(t.description).toContain("Minimal skill");
    expect(t.inputSchema.type).toBe("object");
    expect(t.inputSchema.properties).toMatchObject({
      message: { type: "string", description: "what to echo" },
      loud: { type: "boolean" },
    });
    expect(t.inputSchema.required).toEqual(["message"]);
  });

  it("maps type=path to string", () => {
    const t = skillToTool({
      name: "cat",
      when_to_use: "",
      description: "",
      skill_path: "skills/cat",
      entry: "run.sh",
      entry_path: "skills/cat/run.sh",
      args: [{ name: "file", type: "path", required: true }],
      requires: [],
    });
    expect(t.inputSchema.properties).toMatchObject({ file: { type: "string" } });
  });
});

describe("skillArgsToArgv", () => {
  const skill = {
    name: "test",
    when_to_use: "",
    description: "",
    skill_path: "",
    entry: "run.sh",
    entry_path: "",
    args: [
      { name: "a", type: "string" as const, required: true },
      { name: "b", type: "number" as const, required: false },
      { name: "c", type: "boolean" as const, required: false },
    ],
    requires: [],
  };

  it("produces argv in declaration order", () => {
    expect(skillArgsToArgv(skill, { a: "hello", b: 42, c: true })).toEqual(["hello", "42", "true"]);
  });

  it("stringifies numbers + booleans", () => {
    expect(skillArgsToArgv(skill, { a: "x", b: 0, c: false })).toEqual(["x", "0", "false"]);
  });

  it("fills missing optional args with empty strings", () => {
    expect(skillArgsToArgv(skill, { a: "only" })).toEqual(["only", "", ""]);
  });

  it("throws INVALID_PARAMS on missing required", () => {
    expect(() => skillArgsToArgv(skill, { b: 1 })).toThrowError(McpError);
  });

  it("throws INVALID_PARAMS on type mismatch", () => {
    expect(() => skillArgsToArgv(skill, { a: "hi", b: "not-number" })).toThrowError(McpError);
  });

  it("silently ignores extra unknown args", () => {
    expect(skillArgsToArgv(skill, { a: "x", extra: "ignored" })).toEqual(["x", "", ""]);
  });
});

describe("findBlockedBinary", () => {
  it("returns null when allowlist is null (no restriction)", () => {
    expect(findBlockedBinary(["git", "curl"], null)).toBeNull();
  });

  it("returns null when every required binary is allowed", () => {
    expect(findBlockedBinary(["git"], ["git", "curl"])).toBeNull();
  });

  it("returns the first blocked binary", () => {
    expect(findBlockedBinary(["git", "docker", "jq"], ["git", "jq"])).toBe("docker");
  });
});

describe("docToResource / resolveResourceName", () => {
  it("builds a catalog:// URI", () => {
    const r = docToResource({
      name: "foo",
      title: "Foo",
      summary: "A foo doc",
      doc_path: "docs/foo.md",
    });
    expect(r.uri).toBe("catalog://docs/foo");
    expect(r.mimeType).toBe("text/markdown");
  });

  it("rejects URIs with wrong scheme", () => {
    expect(() => resolveResourceName("file:///tmp/x.md")).toThrowError(McpError);
  });

  it("rejects malformed resource names", () => {
    expect(() => resolveResourceName("catalog://docs/../etc/passwd")).toThrowError(McpError);
  });

  it("extracts resource name from valid URI", () => {
    expect(resolveResourceName("catalog://docs/foo-bar_baz")).toBe("foo-bar_baz");
  });
});

describe("promptToMcp / renderPrompt", () => {
  const prompt = {
    name: "greet",
    purpose: "greet",
    description: "",
    prompt_path: "prompts/greet.md",
    input_vars: [
      { name: "who", description: "target", required: true },
      { name: "tone", required: false },
    ],
  };

  it("translates arguments", () => {
    const p = promptToMcp(prompt);
    expect(p.arguments).toHaveLength(2);
    expect(p.arguments?.[0]).toMatchObject({ name: "who", required: true });
  });

  it("substitutes {{var}} tokens", () => {
    const r = renderPrompt(prompt, "Hola, {{who}}! Tone: {{tone}}", { who: "mundo", tone: "friendly" });
    expect(r.messages[0]!.content.text).toBe("Hola, mundo! Tone: friendly");
  });

  it("leaves unknown tokens verbatim", () => {
    const r = renderPrompt(prompt, "Hola {{who}} at {{place}}", { who: "x" });
    expect(r.messages[0]!.content.text).toBe("Hola x at {{place}}");
  });

  it("throws INVALID_PARAMS on missing required var", () => {
    expect(() => renderPrompt(prompt, "Hi {{who}}", {})).toThrowError(McpError);
  });

  it("stringifies non-string values", () => {
    const r = renderPrompt(prompt, "Hi {{who}} {{tone}}", { who: "x", tone: 42 });
    expect(r.messages[0]!.content.text).toBe("Hi x 42");
  });
});
