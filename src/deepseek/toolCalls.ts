/** Parses the text protocol used to emulate OpenAI function calling. */
import { createHash } from "node:crypto";

import { isRecord } from "../utils/json.js";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ParsedToolCalls {
  content: string;
  toolCalls: OpenAIToolCall[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function stableJson(value: unknown, pretty = false): string {
  return JSON.stringify(stableValue(value), null, pretty ? 2 : undefined) ?? "";
}

function argumentObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    // Model sometimes nests args as { arguments: { ... } }.
    if (isRecord(value.arguments) && Object.keys(value).length === 1) {
      return argumentObject(value.arguments);
    }
    return value;
  }
  if (typeof value !== "string") return value === undefined ? {} : null;
  try {
    return argumentObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function callPayload(
  value: unknown,
  attributeName = "",
): { name: string; arguments: Record<string, unknown> } | null {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.function) ? value.function : value;
  const name =
    (typeof nested.name === "string" ? nested.name.trim() : "") ||
    (typeof value.name === "string" ? value.name.trim() : "") ||
    attributeName.trim();
  let argumentsValue = argumentObject(nested.arguments);
  if (!argumentsValue) {
    const rest = Object.fromEntries(
      Object.entries(nested).filter(([key]) => key !== "name" && key !== "function"),
    );
    argumentsValue = Object.keys(rest).length > 0 ? argumentObject(rest) : null;
  }
  return name && argumentsValue ? { name, arguments: argumentsValue } : null;
}

function callId(seed: string, index: number, payload: string): string {
  const digest = createHash("sha256").update(`${seed}:${index}:${payload}`).digest("hex").slice(0, 24);
  return `call_${digest}`;
}

export function formatToolCall(name: string, argumentsValue: unknown): string | null {
  const argumentsObject = argumentObject(argumentsValue);
  if (!name.trim() || !argumentsObject) return null;
  return `<tool_call>\n${stableJson({ name: name.trim(), arguments: argumentsObject })}\n</tool_call>`;
}

function tryParseJsonObject(raw: string): unknown | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch {
    for (let end = text.length; end > 1; end -= 1) {
      const slice = text.slice(0, end).trim();
      if (!slice.endsWith("}")) continue;
      try {
        return JSON.parse(slice);
      } catch {
        // continue
      }
    }
    return null;
  }
}

/** Extract one balanced JSON object starting at `start` (string-aware). */
function extractJsonObject(
  text: string,
  start: number,
): { raw: string; end: number; value: unknown } | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = text.slice(start, index + 1);
        try {
          return { raw, end: index + 1, value: JSON.parse(raw) };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function pushUnique(
  toolCalls: OpenAIToolCall[],
  seed: string,
  payload: { name: string; arguments: Record<string, unknown> },
  seen: Set<string>,
): void {
  const argumentsText = stableJson(payload.arguments);
  const key = `${payload.name}\0${argumentsText}`;
  if (seen.has(key)) return;
  seen.add(key);
  toolCalls.push({
    id: callId(seed, toolCalls.length, `${payload.name}:${argumentsText}`),
    type: "function",
    function: { name: payload.name, arguments: argumentsText },
  });
}

function attributeName(openTagAttrs: string): string {
  const match = openTagAttrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
  return match?.[1]?.trim() ?? "";
}

function collectMatches(
  text: string,
  pattern: RegExp,
  onMatch: (match: RegExpMatchArray, index: number) => boolean,
): Array<{ start: number; end: number }> {
  const consumed: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (onMatch(match, index)) {
      consumed.push({ start: index, end: index + match[0].length });
    }
  }
  return consumed;
}

/**
 * DeepSeek often leaks tool tags into thinking/reasoning instead of final output.
 * Prefer output text; fall back to reasoning when output has no valid calls.
 */
export function parseToolCallsFromParts(
  outputText: string,
  reasoningText: string,
  seed = "tool",
): ParsedToolCalls {
  const fromOutput = parseToolCalls(outputText, seed);
  if (fromOutput.toolCalls.length > 0) return fromOutput;
  const fromReasoning = parseToolCalls(reasoningText, seed);
  if (fromReasoning.toolCalls.length === 0) return fromOutput;
  // Promote thinking-only tool calls; do not leak raw tags as assistant content.
  return { content: fromOutput.content, toolCalls: fromReasoning.toolCalls };
}

/** Scan balanced `{...}` objects that look like tool payloads (name/arguments in either order). */
function collectBareToolJson(
  text: string,
  seed: string,
  toolCalls: OpenAIToolCall[],
  seen: Set<string>,
  blocked: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const consumed: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const extracted = extractJsonObject(text, i);
    if (!extracted) continue;
    const range = { start: i, end: extracted.end };
    i = extracted.end - 1;
    if (blocked.some((item) => !(range.end <= item.start || range.start >= item.end))) continue;
    const value = extracted.value;
    if (!isRecord(value)) continue;
    const nested = isRecord(value.function) ? value.function : value;
    if (typeof nested.name !== "string" || !("arguments" in nested)) continue;
    const payload = callPayload(value);
    if (!payload) continue;
    pushUnique(toolCalls, seed, payload, seen);
    consumed.push(range);
  }
  return consumed;
}

/**
 * Parse model tool-call text into OpenAI tool_calls.
 * Handles exact tags, attribute names, nested wrappers, and bare JSON (any key order).
 */
export function parseToolCalls(text: string, seed = "tool"): ParsedToolCalls {
  const toolCalls: OpenAIToolCall[] = [];
  const consumed: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();

  // 1) Real tool_call blocks (never match bare "_call" openers that wrap them).
  const toolBlock =
    /<\s*tool[_-]?call\b([^>]*)>\s*([\s\S]*?)\s*<\s*\/\s*tool[_-]?call\s*>/gi;
  consumed.push(
    ...collectMatches(text, toolBlock, (match) => {
      const nameAttr = attributeName(match[1] ?? "");
      const body = (match[2] ?? "").trim();
      const parsed = tryParseJsonObject(body);
      const payload =
        callPayload(parsed, nameAttr) ??
        (nameAttr && isRecord(parsed)
          ? { name: nameAttr, arguments: argumentObject(parsed) ?? {} }
          : null);
      if (!payload || !payload.name) return false;
      if (!isRecord(payload.arguments)) return false;
      pushUnique(toolCalls, seed, {
        name: payload.name,
        arguments: payload.arguments,
      }, seen);
      return true;
    }),
  );

  // 2) Mangled single-call wrappers: <_call>{json}</_call> or <_call>{json}</tool_call>
  const mangled =
    /<\s*_?call\b[^>]*>\s*(\{[\s\S]*?\})\s*<\s*\/\s*(?:tool[_-]?call|_?call)\s*>/gi;
  consumed.push(
    ...collectMatches(text, mangled, (match) => {
      // Skip ranges already covered by real tool_call blocks.
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (consumed.some((range) => start >= range.start && end <= range.end)) return false;
      const payload = callPayload(tryParseJsonObject(match[1] ?? ""));
      if (!payload) return false;
      pushUnique(toolCalls, seed, payload, seen);
      return true;
    }),
  );

  // 3) Bare JSON objects with name + arguments (either key order), always.
  // Tagged blocks may coexist with leftover bare payloads in the same reply.
  consumed.push(...collectBareToolJson(text, seed, toolCalls, seen, consumed));

  if (toolCalls.length === 0) return { content: text, toolCalls };

  let content = "";
  let cursor = 0;
  for (const range of consumed.sort((a, b) => a.start - b.start)) {
    content += text.slice(cursor, range.start);
    cursor = range.end;
  }
  content += text.slice(cursor);
  content = content
    .replace(/<\s*\/?\s*(?:tool[_-]?call|_?call)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { content, toolCalls };
}

export function canonicalParsedAssistantText(parsed: ParsedToolCalls): string {
  const calls = parsed.toolCalls
    .map((call) => formatToolCall(call.function.name, call.function.arguments))
    .filter((call): call is string => call !== null);
  return [parsed.content, ...calls].filter(Boolean).join("\n");
}

/** Store a canonical assistant turn so structured client history can match it later. */
export function canonicalAssistantText(text: string): string {
  const parsed = parseToolCalls(text);
  return parsed.toolCalls.length > 0 ? canonicalParsedAssistantText(parsed) : text;
}
