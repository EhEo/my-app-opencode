import { describe, it, expect } from "vitest";
import {
  toAnthropicMessages,
  toAnthropicTools,
  anthropicEventToChunk,
  parseAnthropicSSEText,
} from "../anthropicClient";
import type OpenAI from "openai";

describe("toAnthropicMessages", () => {
  it("extracts system messages into a separate system string", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("You are helpful.");
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("passes plain user/assistant text through unchanged", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("converts an assistant tool_calls message into tool_use blocks", () => {
    const { messages } = toAnthropicMessages([
      {
        role: "assistant",
        content: "checking the file",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking the file" },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ]);
  });

  it("merges consecutive tool-role messages into one user message with multiple tool_result blocks", () => {
    const { messages } = toAnthropicMessages([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "list_dir", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "file contents" },
      { role: "tool", tool_call_id: "c2", content: "dir listing" },
      { role: "user", content: "thanks" },
    ]);
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "file contents" },
        { type: "tool_result", tool_use_id: "c2", content: "dir listing" },
      ],
    });
    expect(messages[2]).toEqual({ role: "user", content: "thanks" });
  });
});

describe("toAnthropicTools", () => {
  it("converts an OpenAI function tool to Anthropic's name/description/input_schema shape", () => {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];
    expect(toAnthropicTools(tools)).toEqual([
      {
        name: "read_file",
        description: "Read a file.",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });
});

describe("anthropicEventToChunk", () => {
  it("maps a tool_use content_block_start to a tool_calls delta chunk", () => {
    const chunk = anthropicEventToChunk({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "read_file" },
    });
    expect(chunk).toEqual({
      choices: [
        { delta: { tool_calls: [{ index: 1, id: "toolu_1", function: { name: "read_file" } }] } },
      ],
    });
  });

  it("ignores a text content_block_start", () => {
    const chunk = anthropicEventToChunk({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    });
    expect(chunk).toBeNull();
  });

  it("maps a text_delta to a content chunk", () => {
    const chunk = anthropicEventToChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
    expect(chunk).toEqual({ choices: [{ delta: { content: "Hello" } }] });
  });

  it("maps an input_json_delta to a tool_calls arguments chunk", () => {
    const chunk = anthropicEventToChunk({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    });
    expect(chunk).toEqual({
      choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":' } }] } }],
    });
  });

  it("ignores message_stop and unknown event types", () => {
    expect(anthropicEventToChunk({ type: "message_stop" })).toBeNull();
    expect(anthropicEventToChunk({ type: "ping" })).toBeNull();
  });
});

describe("parseAnthropicSSEText", () => {
  it("parses a text-only SSE stream into a sequence of content chunks", () => {
    const sse = [
      'data: {"type":"message_start","message":{}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    expect(parseAnthropicSSEText(sse)).toEqual([
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { content: " there" } }] },
    ]);
  });

  it("throws on an error event", () => {
    const sse = 'data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}';
    expect(() => parseAnthropicSSEText(sse)).toThrow("busy");
  });
});
