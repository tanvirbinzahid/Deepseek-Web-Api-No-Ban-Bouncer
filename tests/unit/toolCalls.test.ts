/** Verifies parsing of the text protocol into OpenAI-compatible tool calls. */
import { describe, expect, it } from "vitest";

import {
  canonicalAssistantText,
  canonicalParsedAssistantText,
  parseToolCalls,
  parseToolCallsFromParts,
} from "../../src/deepseek/toolCalls.js";

describe("parseToolCalls", () => {
  it("maps tagged JSON to OpenAI tool_calls while preserving normal content", () => {
    const result = parseToolCalls(
      'Checking first.\n<tool_call>\n{"name":"get_weather","arguments":{"city":"Hefei"}}\n</tool_call>',
      "response-1",
    );

    expect(result.content).toBe("Checking first.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Hefei"}' },
    });
  });

  it("leaves malformed call text as ordinary content", () => {
    const text = "<tool_call>{not json}</tool_call>";
    expect(parseToolCalls(text)).toEqual({ content: text, toolCalls: [] });
  });

  it("leaves pure prose unchanged", () => {
    const text = 'Use JSON like {"name":"example"} when documenting payloads.';
    expect(parseToolCalls(text)).toEqual({ content: text, toolCalls: [] });
  });

  it("accepts attribute-name tags used by DeepSeek/Pi hybrid output", () => {
    const sample = `<_call>
<tool_call name="read">
{"arguments": {"path": "/tmp/README.md", "limit": 100}}
</tool_call>
<tool_call name="read">
{"arguments": {"path": "/tmp/SPEC.md", "limit": 100}}
</tool_call>
<tool_call name="read">
{"arguments": {"arguments": {"path": "/tmp/package.json"}}}
</tool_call>
<tool_call name="bash">
{"arguments": {"command": "find src -type f | head -5", "timeout": 10}}
</tool_call>
</tool_call>`;

    const result = parseToolCalls(sample, "seed");
    expect(result.toolCalls.map((call) => call.function.name)).toEqual([
      "read",
      "read",
      "read",
      "bash",
    ]);
    expect(JSON.parse(result.toolCalls[0]?.function.arguments ?? "{}")).toEqual({
      path: "/tmp/README.md",
      limit: 100,
    });
    expect(JSON.parse(result.toolCalls[2]?.function.arguments ?? "{}")).toEqual({
      path: "/tmp/package.json",
    });
    expect(JSON.parse(result.toolCalls[3]?.function.arguments ?? "{}")).toEqual({
      command: "find src -type f | head -5",
      timeout: 10,
    });
    expect(result.content).toBe("");
  });

  it("parses name-first bare JSON and preserves canonical arguments-name key order", () => {
    const bare = '{"name":"bash","arguments":{"timeout":10,"command":"pwd"}}';
    const result = parseToolCalls(bare, "seed");

    expect(result.content).toBe("");
    expect(result.toolCalls[0]?.function).toEqual({
      name: "bash",
      arguments: '{"command":"pwd","timeout":10}',
    });
    expect(canonicalAssistantText(bare)).toBe(
      '<tool_call>\n{"arguments":{"command":"pwd","timeout":10},"name":"bash"}\n</tool_call>',
    );
  });

  it("accepts mangled tags and bare JSON tool payloads", () => {
    const mangled = parseToolCalls(
      '<_call>\n{"name":"list_files","arguments":{"path":"."}}\n</tool_call>',
      "seed",
    );
    expect(mangled.toolCalls).toHaveLength(1);
    expect(mangled.toolCalls[0]?.function).toEqual({
      name: "list_files",
      arguments: '{"path":"."}',
    });

    const bare = parseToolCalls('{"name":"read_file","arguments":{"path":"README.md"}}', "seed");
    expect(bare.toolCalls[0]?.function.name).toBe("read_file");
  });

  it("harvests args-before-name bare JSON alongside tagged calls", () => {
    const result = parseToolCalls(`<tool_call>
{"name":"read","arguments":{"path":"README.md"}}
</tool_call>
{"arguments":{"path":"package.json"},"name":"read"}`);

    expect(result.content).toBe("");
    expect(result.toolCalls.map((call) => call.function)).toEqual([
      { name: "read", arguments: '{"path":"README.md"}' },
      { name: "read", arguments: '{"path":"package.json"}' },
    ]);
  });

  it("deduplicates identical tagged and bare calls while stripping both", () => {
    const payload = '{"arguments":{"path":"package.json"},"name":"read"}';
    const result = parseToolCalls(`<tool_call>${payload}</tool_call>\n${payload}`);

    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function).toEqual({
      name: "read",
      arguments: '{"path":"package.json"}',
    });
  });

  it("promotes tool tags leaked into reasoning when output has none", () => {
    const result = parseToolCallsFromParts(
      "",
      'I should list files.\n<tool_call>\n{"name":"bash","arguments":{"command":"ls"}}\n</tool_call>',
      "seed",
    );
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function).toEqual({
      name: "bash",
      arguments: '{"command":"ls"}',
    });
    expect(canonicalParsedAssistantText(result)).not.toContain("I should list files.");
  });

  it("prefers output tool calls over reasoning ones", () => {
    const result = parseToolCallsFromParts(
      '<tool_call>\n{"name":"read","arguments":{"path":"a"}}\n</tool_call>',
      '<tool_call>\n{"name":"bash","arguments":{"command":"ls"}}\n</tool_call>',
      "seed",
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.name).toBe("read");
  });
});
