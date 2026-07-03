# Anthropic 형식 프로바이더 지원 (P2.5) — 설계 spec

- 일시: 2026-07-03
- 상태: 설계 확정(사용자 승인) — 구현 계획 대기
- 관련: opencode-desktop (Tauri v2 + React 19), 선행: P1(opencode 설정 가져오기, 커밋 405f539)

## 1. 목적 / 성공 기준

P1에서 opencode로부터 가져온 프로바이더 중 `npm` 형식이 `@ai-sdk/anthropic`인 항목(예: `minimax-coding-plan`)이 대체 OpenAI 호환 엔드포인트가 없으면 `usable:false`로 표시돼 선택할 수 없었다. 이 기능은 **Anthropic Messages API를 직접 호출하는 어댑터**를 추가해 이런 항목도 채팅·파이프라인에서 정상 사용(도구 호출 포함)할 수 있게 한다.

**성공 기준**:
(a) Anthropic flavor로 가져온 프로바이더가 프로바이더 목록에서 선택 가능(usable=true)해진다.
(b) 해당 프로바이더로 채팅 시 스트리밍 응답과 **도구 호출**(read_file/write_file/list_dir/run_command)이 OpenAI 프로바이더와 동일하게 동작한다.
(c) 파이프라인(Plan/Code/Review) 단계에서 Anthropic 프로바이더를 백엔드로 선택해도 동일하게 동작한다.
(d) 기존 OpenAI 호환 프로바이더의 동작에 회귀가 없다.
(e) `tsc --noEmit`·`pnpm test`·프로덕션 빌드 통과.

## 2. 비목표

- **범위**: opencode에서 가져온 Anthropic flavor 프로바이더만 대상. 사용자가 직접 등록하는 "사용자 정의(custom)" 프리셋에 Anthropic 형식 토글을 추가하는 것은 이번 범위 밖(후속 검토).
- 이미지/비전 입력, extended thinking(확장 사고) 블록, 프롬프트 캐싱 — 앱이 현재 텍스트+도구 호출만 사용하므로 불필요.
- Anthropic 전용 파라미터(top_k, stop_sequences 커스터마이징 등) 노출 — 필요 최소한(model, system, messages, tools, max_tokens, stream)만 지원.
- Rate limit/재시도 정책 커스터마이징 — 기존 OpenAI 경로와 동일하게 에러를 그대로 전파.

## 3. 아키텍처

**핵심 발견**: 이 앱의 LLM 호출 지점은 `agent.ts`의 `runAgent()` 단 하나다. 채팅 패널과 파이프라인(`pipelineDeps.ts`의 `runInapp`)이 모두 `runAgent()`를 경유한다. 따라서 이 함수의 클라이언트 생성부(`createClient`)만 교체하면 나머지(스트리밍 루프, 도구 실행, 히스토리 관리)는 손대지 않아도 된다.

**설계**: `agent.ts`는 항상 "OpenAI 방언"으로 요청을 만들고 응답 청크를 소비한다(현행 유지). `llm.ts`에 새 진입점 `createLlmClient(settings)`를 추가해 `settings.flavor`로 분기한다:
- `flavor !== "anthropic"` → 기존 `createClient()`(실제 OpenAI SDK 인스턴스) 그대로 반환.
- `flavor === "anthropic"` → 신규 `createAnthropicClient(settings)`(`src/lib/anthropicClient.ts`)가 반환하는 **어댑터 객체**. 이 객체는 OpenAI SDK와 동일한 최소 인터페이스(`chat.completions.create(params, options)`)만 구현하고, 내부에서 Anthropic Messages API를 호출해 응답을 OpenAI 청크 형식으로 변환해 돌려준다.

`agent.ts`·`pipeline.ts`·`tools.ts`·UI 컴포넌트는 **한 줄도 수정하지 않는다**(import를 `createClient`→`createLlmClient`로 바꾸는 것 제외).

## 4. Settings.flavor 전파

`Settings`(settings.ts) 인터페이스에 필드 추가:
```ts
export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  flavor?: "openai" | "anthropic"; // 미지정 시 openai로 취급
}
```
- `resolveConnection()`(settings.ts)과 `resolveInappSettings()`(pipelineDeps.ts) 양쪽에서, 활성 프로바이더 id가 `store.importedProviders`에 있으면 그 `flavor`를 그대로 `Settings.flavor`에 채운다. 없으면(내장 프리셋) `undefined`(= openai로 취급).

## 5. 어댑터 변환 규칙 (`src/lib/anthropicClient.ts`)

### 5.1 요청 변환
- **system**: OpenAI 메시지 배열의 `role:"system"` 항목을 Anthropic 요청의 최상위 `system` 문자열 필드로 추출(메시지 배열에서 제거).
- **user/assistant 텍스트**: 그대로 `{role, content: "..."}` 문자열 콘텐츠로 매핑.
- **assistant + tool_calls**: Anthropic의 `content: [{type:"tool_use", id, name, input}]` 블록으로 매핑(input은 OpenAI가 문자열로 들고 있는 arguments를 JSON.parse해 객체로 변환; 파싱 실패 시 `{}`).
- **tool 결과(role:"tool")**: Anthropic은 이를 `role:"user"`의 `content:[{type:"tool_result", tool_use_id, content}]` 블록으로 요구한다. **같은 턴에서 연속된 여러 `role:"tool"` 메시지는 하나의 user 메시지로 병합**한다(Anthropic이 user/assistant 엄격 교대를 요구하므로, 병합하지 않으면 400 에러).
- **tools**: OpenAI `{type:"function", function:{name, description, parameters}}` → Anthropic `{name, description, input_schema: parameters}`.
- **max_tokens**: Anthropic 필수 파라미터. 호출자(agent.ts)가 스트리밍 채팅 시 이 값을 넘기지 않으므로, 어댑터가 기본값 **8192**를 채운다. `testConnection`처럼 호출자가 `max_tokens`를 명시하면 그 값을 그대로 사용.
- **엔드포인트**: `${baseUrl}/messages`, 헤더 `x-api-key: <apiKey>`, `anthropic-version: 2023-06-01`, `content-type: application/json`. `createTauriFetch()`로 호출(CORS 우회, 기존 프록시 경로 재사용).

### 5.2 응답 변환 (스트리밍)
Anthropic SSE 이벤트 → OpenAI 청크(`{choices:[{delta:{...}}]}`) 매핑:
- `content_block_start`(type=`text`) / `content_block_delta`(type=`text_delta`) → `delta.content`에 텍스트 누적 전달.
- `content_block_start`(type=`tool_use`) → 그 블록의 `index`를 키로 `delta.tool_calls:[{index, id, function:{name}}]` 1회 전달(agent.ts의 누적 로직이 `index`별로 합치므로 그대로 맞물림).
- `content_block_delta`(type=`input_json_delta`) → 같은 `index`로 `delta.tool_calls:[{index, function:{arguments: partial_json}}]` 전달(agent.ts가 문자열로 이어붙여 최종 JSON.parse — Anthropic도 부분 JSON 문자열을 스트리밍하므로 그대로 호환).
- `message_stop` → 스트림 종료(agent.ts의 `for await` 루프가 자연 종료).
- 그 외 이벤트(`message_start`, `content_block_stop`, `message_delta`의 usage 등)는 무시.

### 5.3 응답 변환 (비스트리밍, `testConnection` 경로)
`stream`이 없거나 false인 호출은 Anthropic 비스트리밍 응답을 받아 성공 시 그대로 resolve(내용 파싱 불필요 — `testConnection`은 반환값을 읽지 않고 throw 여부만 본다). 4xx/5xx는 에러로 throw해 기존 `testConnection`의 에러 메시지 조합 로직(`err.status`, `err.message`)이 그대로 동작하도록 `Error`에 `status` 프로퍼티를 부착한다.

## 6. opencodeImport.ts 정책 변경

`planImport`의 flavor 분기(현재: anthropic + 대체 URL 있음만 usable) 변경:
- `flavor === "openai"` → usable=true(기존과 동일).
- `flavor === "anthropic"` → **항상 usable=true**. 대체 URL(`ALTERNATE_OPENAI_BASE`)이 있으면 그 URL 사용(기존 동작 유지, minimax는 계속 OpenAI 호환 경로로 — 이미 검증됨), 없으면 레지스트리의 원래 `api`(Anthropic 네이티브 엔드포인트)를 그대로 사용하고 신규 어댑터가 처리.
- `flavor === "other"` → 여전히 usable=false(대상 밖).
- `ImportedProviderMeta.flavor`는 그대로 유지(어댑터 분기에 사용).

## 7. 에러 처리

- Anthropic API 에러 응답(4xx/5xx) → 본문의 `error.message`를 포함해 `Error`로 throw(기존 OpenAI 에러 처리와 동일한 사용자 경험).
- SSE 파싱 중 예기치 못한 이벤트 타입 → 무시하고 계속(신규 이벤트 타입 추가에 견고).
- 네트워크 실패 → `createTauriFetch()`가 이미 던지는 에러 그대로 전파.

## 8. 테스트

- **vitest (순수 함수, 네트워크 없음)**:
  - OpenAI 메시지 배열 → Anthropic 요청 변환: system 추출, tool_calls→tool_use, 연속 tool 결과 병합, max_tokens 기본값.
  - OpenAI tools → Anthropic tools 스키마 변환.
  - Anthropic SSE 텍스트(고정 픽스처 문자열) → OpenAI 청크 시퀀스 파싱(텍스트만 있는 경우 / 도구 호출 포함 / 여러 도구 호출 인터리빙).
- **수동 스모크**(`pnpm tauri dev`, 실제 minimax-coding-plan 또는 유사 Anthropic flavor 키로): 채팅에서 파일 읽기 요청 → 도구 호출 정상 수행 확인. 파이프라인에서 Anthropic 백엔드 선택 후 실행 확인. 기존 OpenAI 프로바이더(zai 등) 회귀 없음 확인.
- 게이트: `tsc --noEmit` + `pnpm test` + `pnpm build`.

## 9. 리스크

1. **tool_result 병합 로직 버그** → Anthropic이 엄격한 user/assistant 교대를 요구해 병합이 틀리면 400 에러로 명확히 드러남(조용한 오동작 아님).
2. **SSE 이벤트 스키마 변경(Anthropic 쪽)** → 알 수 없는 이벤트는 무시하도록 설계해 완만한 성능 저하(무응답)로 나타나되 크래시하지 않음.
3. **max_tokens 기본값(8192)이 일부 모델 한도 초과** → 해당 모델이 400으로 명확히 거부, 필요 시 후속 조정.
4. **agent.ts의 향후 변경**(예: 새 콜백 필드 추가)이 어댑터와 암묵적으로 맞물려 있어, agent.ts를 고칠 때 어댑터의 청크 형식 계약을 함께 검토해야 함 — 이 계약은 §5.2에 명시적으로 문서화되어 있음.
