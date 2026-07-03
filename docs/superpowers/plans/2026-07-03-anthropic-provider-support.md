# Anthropic 형식 프로바이더 지원 (P2.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** opencode에서 가져온 Anthropic 형식(`@ai-sdk/anthropic`) 프로바이더(예: minimax-coding-plan)를 채팅·파이프라인에서 도구 호출까지 포함해 정상 사용할 수 있게 한다.

**Architecture:** 이 앱의 LLM 호출 지점은 `agent.ts`의 `runAgent()` 하나뿐이다(채팅과 파이프라인 모두 이를 경유). `llm.ts`에 `createLlmClient()`를 추가해 `Settings.flavor`로 분기하고, `flavor==="anthropic"`이면 신규 `anthropicClient.ts` 어댑터를 반환한다. 이 어댑터는 OpenAI SDK와 동일한 `chat.completions.create()` 인터페이스만 구현하며 내부에서 Anthropic Messages API를 호출해 응답을 OpenAI 청크 형식으로 변환한다. `agent.ts`는 import 한 줄(`createClient`→`createLlmClient`)만 바뀌고, `pipeline.ts`·`tools.ts`·UI 컴포넌트는 전혀 수정하지 않는다.

**Tech Stack:** TypeScript, vitest, 기존 `openai` npm 타입(구조적 타입 참조용), `createTauriFetch()`(기존 프록시 fetch 재사용).

## Global Constraints

- spec: `docs/superpowers/specs/2026-07-03-anthropic-provider-support-design.md`. 아래는 그 binding 요구.
- 범위는 opencode로 가져온 Anthropic flavor 프로바이더만. 사용자 정의(custom) 프리셋 확장은 범위 밖.
- 도구 호출(read_file/write_file/list_dir/run_command)이 OpenAI 프로바이더와 동일하게 동작해야 한다.
- **agent.ts는 import 한 줄만 수정**(`createClient`→`createLlmClient`, 사용부 1곳). `pipeline.ts`·`tools.ts`·UI 컴포넌트(`SettingsModal.tsx` 등)는 **전혀 수정하지 않는다**.
- Anthropic 요청 변환: system 메시지는 최상위 `system` 필드로 추출. 같은 턴의 연속된 `role:"tool"` 메시지는 **하나의 user 메시지**(여러 `tool_result` 블록)로 병합(Anthropic이 user/assistant 엄격 교대를 요구).
- `max_tokens` 미지정 시 기본값 **8192**로 채운다(Anthropic 필수 파라미터). 호출자가 명시하면 그 값 사용.
- 엔드포인트: `${baseUrl}/messages`, 헤더 `x-api-key`, `anthropic-version: 2023-06-01`.
- opencodeImport.ts: Anthropic flavor는 대체 URL 유무와 무관하게 **usable=true**(대체 있으면 그 URL, 없으면 레지스트리 네이티브 URL을 어댑터로 호출).
- 게이트: `pnpm exec tsc --noEmit` 0, `pnpm exec vitest run` 전체 green, 최종 태스크에서 `pnpm build` 성공.

## File Structure

- Create `src/lib/anthropicClient.ts` — 타입 + 순수 변환 함수(Task 1) + 네트워크 어댑터(Task 2).
- Create `src/lib/__tests__/anthropicClient.test.ts` — Task 1의 순수 함수 테스트.
- Modify `src/lib/llm.ts` — `createLlmClient()` 추가.
- Modify `src/lib/agent.ts` — import/사용부 1곳만.
- Modify `src/lib/settings.ts` — `Settings.flavor` 필드, `resolveConnection` 전파, `testConnection` 클라이언트 교체.
- Modify `src/lib/pipelineDeps.ts` — `resolveInappSettings` flavor 전파.
- Modify `src/lib/__tests__/pipelineDeps.test.ts`, `src/lib/__tests__/settingsImported.test.ts` — 전파 테스트 추가.
- Modify `src/lib/opencodeImport.ts` — `planImport` usable 정책.
- Modify `src/lib/__tests__/opencodeImport.test.ts` — 정책 변경에 맞춰 기존 테스트 1개 갱신.

---

### Task 1: anthropicClient.ts — 순수 변환 코어 (TDD, 네트워크 없음)

**Files:**
- Create: `src/lib/anthropicClient.ts`
- Create: `src/lib/__tests__/anthropicClient.test.ts`

**Interfaces:**
- Consumes: `OpenAI.Chat.Completions.ChatCompletionMessageParam`/`ChatCompletionTool`(타입 전용, `openai` npm에서 import).
- Produces (Task 2가 같은 파일에 이어서 사용):
  - `interface LlmStreamChunk { choices?: [{ delta: { content?: string|null; tool_calls?: [{index, id?, function?:{name?,arguments?}}] } }] }`
  - `interface AnthropicMessage { role: "user"|"assistant"; content: string | AnthropicContentBlock[] }`
  - `function toAnthropicMessages(messages): { system: string|undefined; messages: AnthropicMessage[] }`
  - `interface AnthropicTool { name; description?; input_schema }`
  - `function toAnthropicTools(tools): AnthropicTool[]`
  - `type AnthropicStreamEvent`
  - `function anthropicEventToChunk(data: AnthropicStreamEvent): LlmStreamChunk | null`
  - `function parseAnthropicSSEText(text: string): LlmStreamChunk[]` (throws on an `error` event)
  - (비공개, 같은 파일 내부에서만 쓰임: `chunkFromSSELine`, `isAnthropicErrorEvent`, `safeParseToolArgs`)

- [ ] **Step 1: 실패하는 테스트 작성** — `src/lib/__tests__/anthropicClient.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run src/lib/__tests__/anthropicClient.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/lib/anthropicClient.ts` (전체 내용):

```ts
import type OpenAI from "openai";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** OpenAI-shaped streaming chunk — the only shape agent.ts's for-await loop
 *  reads from (choices[0].delta.content / .tool_calls[].index/id/function). */
export interface LlmStreamChunk {
  choices?: Array<{
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

function safeParseToolArgs(raw: string | null | undefined): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Translate an OpenAI chat message array into Anthropic's shape: the system
 *  message is pulled out into a separate string, and consecutive tool-role
 *  messages (one per tool call in a turn) are merged into a single user
 *  message with multiple tool_result blocks — Anthropic requires strict
 *  user/assistant alternation and rejects back-to-back user messages. */
export function toAnthropicMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : "",
      });
      continue;
    }
    flushToolResults();
    if (m.role === "assistant") {
      const toolCalls = m.tool_calls ?? [];
      if (toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        if (typeof m.content === "string" && m.content.length > 0) {
          blocks.push({ type: "text", text: m.content });
        }
        for (const tc of toolCalls) {
          if (tc.type !== "function") continue;
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: safeParseToolArgs(tc.function.arguments),
          });
        }
        out.push({ role: "assistant", content: blocks });
        continue;
      }
      out.push({
        role: "assistant",
        content: typeof m.content === "string" ? m.content : "",
      });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : "" });
    }
  }
  flushToolResults();

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

/** Translate OpenAI function-tool schemas into Anthropic's tool shape. */
export function toAnthropicTools(
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
): AnthropicTool[] {
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Record<
        string,
        unknown
      >,
    }));
}

interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: { type: string; id?: string; name?: string };
}
interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: string };
}
export type AnthropicStreamEvent =
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | { type: string; [key: string]: unknown };

interface AnthropicErrorEvent {
  type: "error";
  error: { type?: string; message?: string };
}
function isAnthropicErrorEvent(data: unknown): data is AnthropicErrorEvent {
  return (
    typeof data === "object" && data !== null && (data as { type?: unknown }).type === "error"
  );
}

/** Convert one parsed Anthropic SSE event into an OpenAI-shaped chunk, or
 *  null if the event carries nothing agent.ts's loop reads (message_start,
 *  content_block_stop, message_delta, message_stop, ping, text
 *  content_block_start). Stateless: Anthropic already tags every start/delta
 *  event with the content block `index`, so no cross-event accumulation is
 *  needed here — agent.ts's own tool_calls accumulator keys off that index. */
export function anthropicEventToChunk(data: AnthropicStreamEvent): LlmStreamChunk | null {
  if (data.type === "content_block_start") {
    const start = data as AnthropicContentBlockStartEvent;
    if (start.content_block.type === "tool_use") {
      return {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: start.index,
                  id: start.content_block.id,
                  function: { name: start.content_block.name },
                },
              ],
            },
          },
        ],
      };
    }
    return null;
  }
  if (data.type === "content_block_delta") {
    const d = data as AnthropicContentBlockDeltaEvent;
    if (d.delta.type === "text_delta") {
      return { choices: [{ delta: { content: (d.delta as { text: string }).text } }] };
    }
    if (d.delta.type === "input_json_delta") {
      return {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: d.index,
                  function: { arguments: (d.delta as { partial_json: string }).partial_json },
                },
              ],
            },
          },
        ],
      };
    }
    return null;
  }
  return null;
}

/** Parse one raw SSE line into a chunk, or null/throw. Shared by
 *  parseAnthropicSSEText (tests) and the real streaming reader (Task 2). */
function chunkFromSSELine(line: string): LlmStreamChunk | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data:")) return null;
  const jsonText = trimmed.slice(5).trim();
  if (jsonText.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (isAnthropicErrorEvent(data)) {
    throw new Error(data.error.message ?? "Anthropic stream error");
  }
  return anthropicEventToChunk(data as AnthropicStreamEvent);
}

/** Parse a full raw SSE text blob into a sequence of OpenAI-shaped chunks.
 *  Pure and network-free — used for testing the event-translation logic
 *  end-to-end without mocking fetch/ReadableStream. */
export function parseAnthropicSSEText(text: string): LlmStreamChunk[] {
  const out: LlmStreamChunk[] = [];
  for (const line of text.split("\n")) {
    const chunk = chunkFromSSELine(line);
    if (chunk !== null) out.push(chunk);
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run` 그리고 `pnpm exec tsc --noEmit`
Expected: 전체 green(기존 67개 + 신규 12개 = **79개**), tsc 0.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/anthropicClient.ts src/lib/__tests__/anthropicClient.test.ts
git commit -m "feat: Anthropic 메시지/도구/SSE 변환 순수 코어 (테스트)"
```

---

### Task 2: 네트워크 어댑터 + createLlmClient + flavor 전파

**Files:**
- Modify: `src/lib/anthropicClient.ts` (Task 1 파일 끝에 추가만, 기존 내용 변경 금지)
- Modify: `src/lib/llm.ts`
- Modify: `src/lib/agent.ts`
- Modify: `src/lib/settings.ts`
- Modify: `src/lib/pipelineDeps.ts`
- Modify: `src/lib/__tests__/settingsImported.test.ts`
- Modify: `src/lib/__tests__/pipelineDeps.test.ts`

**Interfaces:**
- Consumes: Task 1의 `LlmStreamChunk`, `toAnthropicMessages`, `toAnthropicTools`, `chunkFromSSELine`(같은 파일 내부).
- Produces: `createAnthropicClient(settings: Settings): LlmClient`, `interface LlmClient`, `createLlmClient(s: Settings): LlmClient`(llm.ts), `Settings.flavor?: "openai"|"anthropic"`.

### Step 1: anthropicClient.ts 상단 import 수정

기존(파일 최상단 1줄):
```ts
import type OpenAI from "openai";
```
교체 후:
```ts
import type OpenAI from "openai";
import type { Settings } from "./settings";
import { createTauriFetch } from "./tauriFetch";
```

### Step 2: anthropicClient.ts 파일 맨 끝에 추가

```ts
export interface LlmClient {
  chat: {
    completions: {
      create(
        params: {
          model: string;
          messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
          tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
          stream?: boolean;
          max_tokens?: number;
        },
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<LlmStreamChunk> | unknown>;
    };
  };
}

const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = "2023-06-01";

async function* streamAnthropicChunks(res: Response): AsyncGenerator<LlmStreamChunk> {
  if (res.body === null) throw new Error("Anthropic 응답에 본문이 없습니다");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const chunk = chunkFromSSELine(line);
      if (chunk !== null) yield chunk;
    }
  }
  if (buf.length > 0) {
    const chunk = chunkFromSSELine(buf);
    if (chunk !== null) yield chunk;
  }
}

/** Build an LlmClient backed by the Anthropic Messages API. Speaks the same
 *  OpenAI dialect in (params shape) and out (LlmStreamChunk) as the real
 *  OpenAI SDK client, so agent.ts / testConnection never branch on flavor. */
export function createAnthropicClient(settings: Settings): LlmClient {
  const tauriFetch = createTauriFetch();
  return {
    chat: {
      completions: {
        create: async (params, options) => {
          const { system, messages } = toAnthropicMessages(params.messages);
          const body: Record<string, unknown> = {
            model: params.model,
            messages,
            max_tokens: params.max_tokens ?? DEFAULT_MAX_TOKENS,
            stream: params.stream === true,
          };
          if (system !== undefined) body.system = system;
          if (params.tools !== undefined && params.tools.length > 0) {
            body.tools = toAnthropicTools(params.tools);
          }
          const res = await tauriFetch(`${settings.baseUrl}/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": settings.apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body: JSON.stringify(body),
            signal: options?.signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            let message = `HTTP ${res.status}`;
            try {
              const parsed = JSON.parse(text) as { error?: { message?: string } };
              if (parsed.error?.message !== undefined) message = parsed.error.message;
            } catch {
              if (text.length > 0) message = text;
            }
            const err = new Error(message) as Error & { status?: number };
            err.status = res.status;
            throw err;
          }
          if (params.stream === true) {
            return streamAnthropicChunks(res);
          }
          return res.json();
        },
      },
    },
  };
}
```

### Step 3: llm.ts 전체 교체

`src/lib/llm.ts` 전체 내용을 다음으로 교체:

```ts
import OpenAI from "openai";
import type { Settings } from "./settings";
import { createTauriFetch } from "./tauriFetch";
import { createAnthropicClient, type LlmClient } from "./anthropicClient";

const tauriFetch = createTauriFetch();

/**
 * Build an OpenAI-compatible SDK client from persisted user settings.
 *
 * SECURITY: `dangerouslyAllowBrowser: true` is required AND safe here.
 * opencode-desktop is a Tauri native desktop app; this code runs inside the
 * Tauri webview on the user's OWN machine — the same device that owns the API
 * key. It is NOT served over HTTP to third parties. The SDK's browser guard
 * exists to stop publishing keys to anonymous website visitors, which is not
 * our threat model. Without the flag the SDK refuses to construct in any
 * browser-like runtime (the Tauri webview counts as one), so the app could
 * never make a single LLM call.
 *
 * API key: some local servers (plain llama.cpp / Ollama) need no auth. The
 * SDK still rejects an empty string, so we substitute a dummy `"none"` — a
 * server that ignores the Authorization header won't care, and one that
 * requires auth will simply 401, surfacing via `testConnection` / `onError`.
 */
export function createClient(s: Settings): OpenAI {
  return new OpenAI({
    baseURL: s.baseUrl,
    apiKey: s.apiKey || "none",
    dangerouslyAllowBrowser: true,
    fetch: tauriFetch,
  });
}

/** Returns an LlmClient for the settings' flavor. Anthropic-flavor providers
 *  (imported from opencode, see opencodeImport.ts) get an adapter that speaks
 *  the OpenAI dialect in/out while calling the real Anthropic Messages API
 *  underneath — agent.ts and testConnection never branch on flavor. */
export function createLlmClient(s: Settings): LlmClient {
  if (s.flavor === "anthropic") return createAnthropicClient(s);
  return createClient(s) as unknown as LlmClient;
}

export type { LlmClient, LlmStreamChunk } from "./anthropicClient";
```

### Step 4: agent.ts — import/사용부 1곳씩만 교체

기존(2번째 줄):
```ts
import { createClient } from "./llm";
```
교체 후:
```ts
import { createLlmClient } from "./llm";
```

기존(`runAgent` 함수 내부):
```ts
    const client = createClient(settings);
```
교체 후:
```ts
    const client = createLlmClient(settings);
```

### Step 5: settings.ts 수정

기존(2번째 줄):
```ts
import { createClient } from "./llm";
```
교체 후:
```ts
import { createLlmClient } from "./llm";
```

`Settings` 인터페이스 교체:
```ts
export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
}
```
교체 후:
```ts
export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Wire format for createLlmClient. Undefined/"openai" = OpenAI-compatible
   *  chat completions (the default for all built-in presets). "anthropic" =
   *  routed through the Anthropic Messages API adapter (opencodeImport.ts
   *  sets this from the imported provider's flavor). */
  flavor?: "openai" | "anthropic";
}
```

`resolveConnection` 함수 전체 교체:
```ts
export function resolveConnection(store: ProviderStore): Settings | null {
  const preset = findPreset(store, store.activeProviderId);
  if (preset === undefined) return null;
  if (!isProviderUsable(store, preset.id)) return null;
  const entry = store.providers[preset.id] ?? {
    apiKey: "",
    baseUrlOverride: null,
    modelsOverride: null,
  };
  const baseUrl = entry.baseUrlOverride ?? preset.baseUrl;
  const apiKey = entry.apiKey;
  const model = store.activeModel || preset.models[0] || "";
  if (baseUrl === "" || model === "") return null;
  return { baseUrl, apiKey, model };
}
```
교체 후:
```ts
export function resolveConnection(store: ProviderStore): Settings | null {
  const preset = findPreset(store, store.activeProviderId);
  if (preset === undefined) return null;
  if (!isProviderUsable(store, preset.id)) return null;
  const entry = store.providers[preset.id] ?? {
    apiKey: "",
    baseUrlOverride: null,
    modelsOverride: null,
  };
  const baseUrl = entry.baseUrlOverride ?? preset.baseUrl;
  const apiKey = entry.apiKey;
  const model = store.activeModel || preset.models[0] || "";
  if (baseUrl === "" || model === "") return null;
  const importedFlavor = store.importedProviders?.[preset.id]?.flavor;
  return {
    baseUrl,
    apiKey,
    model,
    flavor: importedFlavor === "anthropic" ? "anthropic" : undefined,
  };
}
```

`testConnection` 함수 내부, 기존:
```ts
    const client = createClient(s);
```
교체 후:
```ts
    const client = createLlmClient(s);
```

### Step 6: pipelineDeps.ts 수정

`resolveInappSettings` 함수의 명시적 providerId 분기, 기존:
```ts
  const preset = findPreset(store, backend.providerId);
  const entry = store.providers[backend.providerId];
  if (preset === undefined || entry === undefined) return null;
  if (!isProviderUsable(store, backend.providerId)) return null;
  const baseUrl = entry.baseUrlOverride ?? preset.baseUrl;
  const model = backend.model || preset.models[0] || store.activeModel;
  if (baseUrl === "" || model === "") return null;
  return { baseUrl, apiKey: entry.apiKey, model };
```
교체 후:
```ts
  const preset = findPreset(store, backend.providerId);
  const entry = store.providers[backend.providerId];
  if (preset === undefined || entry === undefined) return null;
  if (!isProviderUsable(store, backend.providerId)) return null;
  const baseUrl = entry.baseUrlOverride ?? preset.baseUrl;
  const model = backend.model || preset.models[0] || store.activeModel;
  if (baseUrl === "" || model === "") return null;
  const importedFlavor = store.importedProviders?.[backend.providerId]?.flavor;
  return {
    baseUrl,
    apiKey: entry.apiKey,
    model,
    flavor: importedFlavor === "anthropic" ? "anthropic" : undefined,
  };
```

### Step 7: 전파 테스트 추가

`src/lib/__tests__/settingsImported.test.ts`의 `describe("imported providers in settings", ...)` 블록 안, 마지막 `it(...)` 다음에 추가:
```ts

  it("resolveConnection carries the flavor of an anthropic-flavor imported provider", () => {
    const store = storeWithImported();
    store.importedProviders!["opencode"].flavor = "anthropic";
    const s = resolveConnection(store);
    expect(s?.flavor).toBe("anthropic");
  });
```

`src/lib/__tests__/pipelineDeps.test.ts`의 `describe("resolveInappSettings", ...)` 블록 안, 마지막 `it(...)` 다음(블록을 닫는 `});` 앞)에 추가:
```ts

  it("carries the imported provider's flavor through for an explicit providerId", () => {
    const withImported: ProviderStore = {
      ...store,
      importedProviders: {
        "minimax-coding-plan": {
          label: "MiniMax Token Plan",
          baseUrl: "https://api.minimax.io/anthropic/v1",
          models: ["MiniMax-M2.7"],
          flavor: "anthropic",
          usable: true,
          importedAt: "2026-07-03T00:00:00Z",
        },
      },
      providers: {
        ...store.providers,
        "minimax-coding-plan": { apiKey: "k", baseUrlOverride: null, modelsOverride: null },
      },
    };
    const s = resolveInappSettings(withImported, { providerId: "minimax-coding-plan" });
    expect(s).toEqual({
      baseUrl: "https://api.minimax.io/anthropic/v1",
      apiKey: "k",
      model: "MiniMax-M2.7",
      flavor: "anthropic",
    });
  });
```

- [ ] **Step 8: 통과 확인**

Run: `pnpm exec vitest run` 그리고 `pnpm exec tsc --noEmit`
Expected: 전체 green(79개 + 신규 2개 = **81개**), tsc 0.

- [ ] **Step 9: 커밋**

```bash
git add src/lib/anthropicClient.ts src/lib/llm.ts src/lib/agent.ts src/lib/settings.ts src/lib/pipelineDeps.ts src/lib/__tests__/settingsImported.test.ts src/lib/__tests__/pipelineDeps.test.ts
git commit -m "feat: createLlmClient + Anthropic 어댑터 결선, Settings.flavor 전파"
```

---

### Task 3: opencodeImport.ts — usable 정책 갱신 + 게이트

**Files:**
- Modify: `src/lib/opencodeImport.ts`
- Modify: `src/lib/__tests__/opencodeImport.test.ts`

**Interfaces:** 변경 없음(기존 `planImport` 시그니처 유지, 내부 usable 계산 로직만 변경).

### Step 1: planImport 정책 수정

기존:
```ts
    const flavor = flavorOf(reg.npm);
    let baseUrl = reg.api;
    let usable = flavor === "openai";
    if (flavor === "anthropic" && ALTERNATE_OPENAI_BASE[e.id] !== undefined) {
      baseUrl = ALTERNATE_OPENAI_BASE[e.id];
      usable = true;
    }
```
교체 후:
```ts
    const flavor = flavorOf(reg.npm);
    let baseUrl = reg.api;
    // openai-compatible works directly. anthropic works either via a known
    // OpenAI-compatible alternate (preferred — simpler, already verified for
    // minimax) or via the native Anthropic endpoint through the
    // anthropicClient adapter (P2.5) — either way it's usable.
    const usable = flavor === "openai" || flavor === "anthropic";
    if (flavor === "anthropic" && ALTERNATE_OPENAI_BASE[e.id] !== undefined) {
      baseUrl = ALTERNATE_OPENAI_BASE[e.id];
    }
```

### Step 2: 기존 테스트 갱신

`src/lib/__tests__/opencodeImport.test.ts`에서 기존 테스트:
```ts
  it("marks anthropic-flavor without alternate as unusable", () => {
    const registry = {
      ...BUNDLED_REGISTRY,
      "some-anthropic": {
        name: "SomeAnthropic",
        api: "https://a.example/v1",
        npm: "@ai-sdk/anthropic",
        models: ["m"],
      },
    };
    const auth = JSON.stringify({ "some-anthropic": { type: "api", key: "k" } });
    const plan = planImport(parseAuthJson(auth), registry, NOW);
    const item = plan.items.find((i) => i.id === "some-anthropic");
    expect(item?.meta.usable).toBe(false);
    expect(item?.meta.baseUrl).toBe("https://a.example/v1");
  });
```
교체 후(P2.5로 usable=true가 된 것을 반영):
```ts
  it("marks anthropic-flavor without alternate as usable via the native endpoint (P2.5)", () => {
    const registry = {
      ...BUNDLED_REGISTRY,
      "some-anthropic": {
        name: "SomeAnthropic",
        api: "https://a.example/v1",
        npm: "@ai-sdk/anthropic",
        models: ["m"],
      },
    };
    const auth = JSON.stringify({ "some-anthropic": { type: "api", key: "k" } });
    const plan = planImport(parseAuthJson(auth), registry, NOW);
    const item = plan.items.find((i) => i.id === "some-anthropic");
    expect(item?.meta.usable).toBe(true);
    expect(item?.meta.baseUrl).toBe("https://a.example/v1");
  });
```

- [ ] **Step 3: 전체 게이트 실행**

- [ ] `pnpm exec tsc --noEmit` → 0 errors
- [ ] `pnpm exec vitest run` → 전체 green(**81개**, 순감소 없음 — 기존 테스트 1개는 기대값만 변경)
- [ ] `pnpm build` → `✓ built` 성공

Never rationalize a failing gate as a tooling artifact — 실패 시 원인 진단 또는 BLOCKED로 보고.

- [ ] **Step 4: 커밋**

```bash
git add src/lib/opencodeImport.ts src/lib/__tests__/opencodeImport.test.ts
git commit -m "feat: Anthropic flavor를 usable로 전환 (P2.5 어댑터 연동)"
```

---

## 수동 스모크 (구현 후 오케스트레이터가 `pnpm tauri dev`로 확인)

- [ ] 설정 → AI 탭에서 `minimax-coding-plan`(또는 대체 URL 없는 다른 Anthropic flavor 항목)이 선택 가능(활성화)한지 확인.
- [ ] 채팅에서 "src/App.tsx 읽고 요약해줘" 같은 요청 → `read_file` 도구 호출이 정상 수행되고 결과가 반영된 응답이 오는지 확인.
- [ ] 파일 쓰기 요청(`write_file`) → 정상 적용되는지 확인.
- [ ] 파이프라인에서 Plan/Code/Review 중 한 단계 백엔드를 Anthropic flavor 프로바이더로 설정 후 실행 → 정상 동작 확인.
- [ ] 기존 OpenAI 계열 프로바이더(zai 등)로 채팅 — 회귀 없는지 확인.
- [ ] 대체 URL이 있는 minimax-coding-plan은 여전히 OpenAI 호환 경로(어댑터 미경유)로 동작하는지 확인(로그/네트워크 상 `${baseUrl}/messages` 호출이 아니라 `/chat/completions` 호출인지는 코드상 보장되므로 별도 확인 불필요 — 동작만 확인).

## Self-Review 노트

- **Spec 커버리지**: §3 아키텍처(Task 2 createLlmClient 분기), §4 flavor 전파(Task 2 Step 5·6), §5.1 요청 변환(Task 1 toAnthropicMessages/toAnthropicTools, max_tokens 기본값 Task 2), §5.2 스트리밍 변환(Task 1 anthropicEventToChunk/parseAnthropicSSEText, Task 2 streamAnthropicChunks), §5.3 비스트리밍(Task 2 createAnthropicClient의 `stream !== true` 분기), §6 opencodeImport 정책(Task 3), §7 에러 처리(Task 2의 res.ok 체크+status 부착, Task 1의 error 이벤트 throw), §8 테스트(Task 1 12개 순수 테스트 + Task 2 2개 전파 테스트 + 수동 스모크). ✓
- **타입 일관성**: `LlmStreamChunk`/`AnthropicMessage`/`AnthropicTool`/`AnthropicStreamEvent`(Task 1 정의) → Task 2의 `LlmClient`/`createAnthropicClient`가 그대로 사용. `Settings.flavor`(Task 2 정의) → `createLlmClient`(llm.ts)·`resolveConnection`·`resolveInappSettings`가 동일 리터럴 유니언(`"openai"|"anthropic"`)으로 참조. ✓
- **agent.ts 변경 최소성 확인**: 계획 전체에서 agent.ts는 Task 2 Step 4의 2줄(import + 사용부)만 수정. pipeline.ts·tools.ts·SettingsModal.tsx는 어떤 태스크에서도 수정하지 않음(SettingsModal은 이미 usable 플래그를 제네릭하게 렌더링하므로 Anthropic 항목이 usable=true가 되는 순간 자동으로 선택 가능해짐 — 코드 변경 불필요). ✓
