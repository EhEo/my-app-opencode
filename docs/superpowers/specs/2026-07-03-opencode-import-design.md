# opencode 설정 가져오기 (P1) — 설계 spec

- 일시: 2026-07-03
- 상태: 설계 확정(사용자 승인) — 구현 계획 대기
- 관련: opencode-desktop (Tauri v2 + React 19), 참고: anomalyco/opencode (MIT)

## 1. 목적 / 성공 기준

사용자가 opencode(opencode.ai)에 등록해 둔 AI 프로바이더 연결(API 키)을 **버튼 한 번으로 이 앱에 가져와** 그 프로바이더·모델을 채팅/파이프라인에서 선택해 쓸 수 있게 한다.

**워크플로**: opencode에서 연결 등록 → 이 앱 설정에서 "opencode에서 가져오기" 클릭 → 기존 항목은 **업데이트**, 새 항목은 **추가**(upsert).

**성공 기준**:
(a) auth.json의 모든 `type:"api"` 항목이 가져와져 설정 AI 탭 프로바이더 목록에 나타난다.
(b) 가져온 프로바이더의 **전체 모델 목록**(models.dev 기준)에서 모델을 선택할 수 있다.
(c) 재실행(재가져오기) 시 기존 항목의 키·모델·baseUrl이 갱신되고 새 항목이 추가된다. opencode에서 삭제된 항목은 자동 삭제하지 않는다.
(d) OpenAI 호환 프로바이더는 가져온 즉시 "연결 테스트"와 채팅이 동작한다.
(e) 가져오기 결과 요약이 표시된다: 추가 N · 갱신 N · 건너뜀 N(사유별).
(f) `tsc --noEmit`·`cargo check`·`pnpm test`·프로덕션 빌드 통과.

## 2. 비목표 (P1 제외 — 후속 단계)

- **P2**: OAuth 항목(openai=ChatGPT 구독, google=Gemini) 토큰 재사용·갱신·전용 요청 어댑터. P1에서는 건너뛰고 요약에 "P2에서 지원 예정"으로 표시.
- **P2.5**: Anthropic Messages 형식 어댑터(우리 엔진은 현재 OpenAI `/chat/completions`만 사용).
- **P3**: Claude Code / Codex 스킬·플러그인 로딩.
- 실시간 참조(파일 감시) — 일회성 가져오기 버튼만(사용자 선택).
- opencode 쪽 파일 수정 — auth.json은 **읽기 전용**.

## 3. 데이터 소스

### 3.1 opencode auth.json
경로(고정): `%USERPROFILE%\.local\share\opencode\auth.json`
관측된 실제 구조(값은 redacted):
```json
{
  "opencode":            { "type": "api",   "key": "..." },
  "opencode-go":         { "type": "api",   "key": "..." },
  "minimax-coding-plan": { "type": "api",   "key": "..." },
  "zai-coding-plan":     { "type": "api",   "key": "..." },
  "openai":              { "type": "oauth", "refresh": "...", "access": "...", "expires": 178..., "accountId": "..." },
  "google":              { "type": "oauth", "refresh": "...", "access": "...", "expires": 178..., "email": "...", "projectId": "" }
}
```
- `type:"api"` → 가져오기 대상. `type:"oauth"` → P1에서는 건너뜀(요약에 표시). 그 외 type → 건너뜀(요약에 표시).

### 3.2 models.dev 레지스트리
`https://models.dev/api.json` — opencode가 쓰는 것과 동일한 공개 레지스트리(149개 프로바이더).
구조: `{ [providerId]: { id, name, api, npm, env, doc, models: { [modelId]: {...} } } }`
- `api` = base URL, `npm` = API 형식(flavor), `models` 키 목록 = 모델 ID들.

확인된 실측값(내장 스냅샷 폴백에 사용):
| id | name | api | npm(형식) |
|---|---|---|---|
| `opencode` | OpenCode Zen | `https://opencode.ai/zen/v1` | `@ai-sdk/openai-compatible` |
| `opencode-go` | OpenCode Go | `https://opencode.ai/zen/go/v1` | `@ai-sdk/openai-compatible` |
| `zai-coding-plan` | Z.AI Coding Plan | `https://api.z.ai/api/coding/paas/v4` | `@ai-sdk/openai-compatible` |
| `minimax-coding-plan` | MiniMax Token Plan | `https://api.minimax.io/anthropic/v1` | `@ai-sdk/anthropic` |
| `kilo` | Kilo Gateway | `https://api.kilo.ai/api/gateway` | `@ai-sdk/openai-compatible` |

### 3.3 형식(flavor) 정책
- `npm`이 `@ai-sdk/openai-compatible`(또는 openai 계열) → **usable**: 즉시 사용 가능.
- `@ai-sdk/anthropic` 등 비호환 형식 → **대체 매핑 테이블** 확인:
  - `minimax-coding-plan` → base URL을 `https://api.minimax.io/v1`(동사 OpenAI 호환 엔드포인트)로 대체하고 usable로 가져온다. 연결 테스트로 검증(키가 해당 엔드포인트를 거부하면 사용자에게 그 항목 한계 안내).
  - 대체가 없는 비호환 형식 → 가져오되 `unsupported` 플래그로 표시(목록에 "형식 미지원" 배지, 선택 불가). 이후 어댑터 추가 시 배지 해제.

## 4. 저장 구조 (ProviderStore 확장)

```ts
// settings.ts
export interface ImportedProvider {
  label: string;          // models.dev name (없으면 id)
  baseUrl: string;        // models.dev api (또는 대체 매핑)
  models: string[];       // models.dev 모델 ID 전체
  flavor: "openai" | "anthropic" | "other";
  usable: boolean;        // flavor 정책 결과
  apiKey: string;
  importedAt: string;     // ISO 문자열 (표시용)
}
export interface ProviderStore {
  // ...기존 필드...
  importedProviders?: Record<string, ImportedProvider>;
}
```
- 프로바이더 선택 목록 = 기존 `PROVIDER_PRESETS` + `importedProviders`(라벨에 "(opencode)" 접미). ID 충돌 시(예: `zai-coding-plan`은 프리셋에도 존재) **imported 항목이 해당 프리셋의 `providers[id].apiKey`를 갱신**하고 별도 imported 항목은 만들지 않는다(중복 노출 방지). 모델 목록은 `modelsOverride`로 갱신.
- `resolveConnection()`이 imported 프로바이더도 해석하도록 확장(usable=false는 선택 불가).

## 5. 컴포넌트 구조

- **Rust** `read_opencode_auth` 명령(신규): 고정 경로의 auth.json을 읽어 문자열 반환. 임의 경로 인자 없음(최소 권한). 파일 없으면 명확한 에러 문자열.
- **TS** `src/lib/opencodeImport.ts`(신규):
  - `parseAuthJson(raw): AuthEntry[]` — 순수 함수(테스트 대상).
  - `fetchRegistry(): Promise<Registry>` — 기존 Rust `proxy_request` 경유로 models.dev 조회. 실패 시 `BUNDLED_REGISTRY`(§3.2 표의 스냅샷) 폴백.
  - `planImport(entries, registry, store): ImportPlan` — 순수 함수(테스트 대상). upsert 계획 산출: added / updated / skipped(사유: oauth-p2 | unknown-provider | unsupported-flavor).
  - `applyImport(plan, store): ProviderStore` — 순수 함수(테스트 대상).
- **UI** `SettingsModal` AI 탭 상단: "opencode에서 가져오기" 버튼 + 실행 후 요약 한 줄("추가 2 · 갱신 2 · 건너뜀 2 (OAuth는 P2 예정)"). 가져온 프로바이더는 선택 목록에 표시. 키 값은 화면·로그에 마스킹.

## 6. 에러 처리

- auth.json 없음 → "opencode 설치/로그인 기록을 찾을 수 없습니다" 안내.
- auth.json 파싱 실패 → 실패 안내(부분 진행 없음).
- models.dev 실패 → 내장 스냅샷으로 알려진 5개는 처리, 스냅샷에 없는 항목은 skipped(unknown-provider) 처리 + "레지스트리 접속 실패, 알려진 프로바이더만 가져옴" 안내.
- 개별 항목 오류는 그 항목만 skip하고 나머지 진행(요약에 표시).

## 7. 테스트

- **vitest**: `parseAuthJson`(정상/이상 구조), `planImport`(추가/갱신/건너뜀·프리셋 충돌 병합·flavor 정책·대체 매핑), `applyImport`(upsert 불변성).
- **Rust**: `read_opencode_auth` — 파일 없음 에러 경로(고정 경로라 픽스처 불가; 존재 검사 로직만).
- **수동 스모크**: 가져오기 → 요약 확인 → zen/go/zai/minimax 각각 연결 테스트 → 채팅 1회. 재가져오기로 갱신 동작 확인.
- 게이트: `tsc --noEmit` + `cargo check` + `pnpm test` + `pnpm build`.

## 8. 보안

- API 키는 기존 저장 방식과 동일하게 로컬 설정 저장소에 보관(신규 노출면 없음). 화면 표시는 기존 키 필드와 동일한 마스킹.
- auth.json 읽기 전용, 고정 경로만. 키를 콘솔/로그에 출력하지 않음.
- models.dev 조회에는 키를 포함하지 않음(공개 레지스트리 GET).

## 9. 단계 로드맵 (이 spec은 P1만 다룸)

- **P1(이 문서)**: API 키 프로바이더 범용 가져오기 + 동적 프로바이더 + upsert.
- **P2**: OAuth(ChatGPT·Google) 토큰 재사용 — 갱신 플로우 + 프로바이더별 요청 어댑터. ToS 회색지대(벤더 공식 클라이언트용 엔드포인트) 명시적 수용 필요.
- **P2.5**: Anthropic Messages 어댑터 → unsupported 배지 해제.
- **P3**: Claude Code/Codex 스킬·플러그인 로딩(별도 브레인스토밍).

## 10. 리스크

1. minimax-coding-plan 키가 OpenAI 호환 엔드포인트를 거부할 가능성 → 연결 테스트로 검증, 실패 시 해당 항목만 한계 안내(P2.5에서 해소).
2. models.dev 스키마 변경 → 내장 스냅샷 폴백 + 조회 실패 항목 skip.
3. opencode가 auth.json 위치/형식 변경 → 고정 경로·형식 검사에서 명확히 실패(조용한 오동작 없음).
4. 두 앱이 같은 키를 공유 → API 키는 다중 사용 무해(OAuth와 달리 세션 충돌 없음).
