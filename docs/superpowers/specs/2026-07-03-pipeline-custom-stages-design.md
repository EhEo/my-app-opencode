# 파이프라인 단계 자유 구성 (Worker N + 심판) — 설계 spec

- 일시: 2026-07-03
- 상태: 설계 확정(사용자 승인) — 구현 계획 대기
- 관련: opencode-desktop (Tauri v2 + React 19)

## 1. 목적 / 성공 기준

지금 파이프라인은 Plan/Code/Review 3단계가 고정돼 있다(`StageConfig.id: "plan"|"code"|"review"`, 각 단계 업무 지시문도 `STAGE_PROMPTS`에 하드코딩). 이 기능은 사용자가 **단계를 자유롭게 추가·삭제·순서 변경**하고, **각 단계에 원하는 업무 지시문을 직접 작성**할 수 있게 한다. 예: 워커1(리서치)→워커2(구현)→워커3(테스트)→심판(종합판단) 처럼 임의 개수·역할로 구성.

**성공 기준**:
(a) 설정에서 단계를 추가/삭제/순서 변경할 수 있다.
(b) 각 단계에 이름·업무 지시문(자유 텍스트)·백엔드(기본 인앱/다른 프로바이더·모델/CLI 워커)를 지정할 수 있다.
(c) 파이프라인 실행 시 각 단계는 자신의 지시문 + 요청 + **이전 모든 단계의 결과**를 받아 실행된다(현재 Review 단계와 동일한 방식 — 신규 로직 아님).
(d) 기존 사용자의 저장된 Plan/Code/Review 설정이 데이터 손실 없이 그대로 동작한다(마이그레이션 불필요).
(e) 신규 설치 기본값은 기존과 동일한 Plan/Code/Review 3단계 + 기존 지시문.
(f) `tsc --noEmit`·`pnpm test`·프로덕션 빌드 통과.

## 2. 비목표

- 병렬 팬아웃 실행(여러 워커가 동시에 같은 요청을 처리) — 순차 체인만 지원.
- 심판(마지막 단계)의 특수 동작(재실행 결정, 점수 매기기 등) — 구조적으로 다른 단계와 완전히 동일하게 취급. 사용자가 지시문에 "종합판단"이라고 적으면 그것으로 충분.
- 단계 템플릿/프리셋 갤러리 — 빈 지시문으로 추가 후 사용자가 직접 작성.
- 단계별 다른 모델 파라미터(temperature 등) 노출 — 범위 밖.

## 3. 데이터 모델 변경

`src/lib/settings.ts`의 `StageConfig`:
```ts
export interface StageConfig {
  id: string; // 기존: "plan" | "code" | "review" 리터럴 → 자유 문자열
  label: string;
  prompt?: string; // 신규 — 단계 업무 지시문. 비어 있으면 지시문 없이 요청+이전 결과만 전달.
  backendId?: string;
  enabled: boolean;
}
```
- `id`가 리터럴 유니언에서 일반 `string`으로 완화되므로, 기존 저장 데이터(`id:"plan"` 등)는 **그대로 유효한 값**이 되어 별도 마이그레이션이 필요 없다.
- 신규 단계의 `id`는 생성 시 `crypto.randomUUID()`로 부여(충돌 없는 고유 키, 표시에는 쓰이지 않음 — `label`이 표시용).

`src/lib/workers.ts`의 `DEFAULT_STAGES`(신규 설치 기본값)는 기존 3단계에 지금 `pipeline.ts`의 `STAGE_PROMPTS`에 있던 지시문을 `prompt` 필드로 그대로 옮겨 유지한다(동작 회귀 없음):
```ts
export const DEFAULT_STAGES: StageConfig[] = [
  { id: "plan", label: "Plan", enabled: true,
    prompt: "You are the PLAN stage. Produce a concise step-by-step plan. Do not write files." },
  { id: "code", label: "Code", enabled: true,
    prompt: "You are the CODE stage. Implement the plan. Use tools to read and write files." },
  { id: "review", label: "Review", enabled: true,
    prompt: "You are the REVIEW stage. Read the changes and report issues. Read-only — do not modify files." },
];
```

## 4. buildBrief 변경 (`src/lib/pipeline.ts`)

하드코딩된 `STAGE_PROMPTS: Record<string, string>` 조회 제거. `buildBrief`가 `stage.prompt`를 직접 사용:
```ts
export function buildBrief(
  request: string,
  stage: StageConfig,
  prior: StageResult[],
): string {
  const parts: string[] = [stage.prompt ?? "", `# Request\n${request}`];
  for (const p of prior) {
    parts.push(`# ${p.label} output\n${p.output}`);
  }
  return parts.filter((s) => s.length > 0).join("\n\n");
}
```
`runPipeline`의 실행 루프 자체(순차 순회, `prior` 누적, 백엔드 분기)는 이미 완전히 일반적이라 변경 불필요 — 단계 개수·id에 대한 가정이 `STAGE_PROMPTS` 조회 한 곳뿐이었다.

## 5. 설정 UI (Agents 탭)

지금의 고정 3행(`stages.map(st => <select .../>)`, §SettingsModal.tsx "파이프라인 단계 기본 백엔드")을 **단계 목록 CRUD**로 교체:
- 각 행: 이름(텍스트 입력) · 업무 지시문(텍스트영역) · 백엔드 선택(기존 드롭다운 — 기본 인앱/인앱 워커/CLI 워커 재사용) · 활성화 체크박스 · 삭제 버튼 · ↑/↓ 순서 변경 버튼.
- 목록 하단 "+ 단계 추가" 버튼 — 새 `StageConfig`를 빈 이름/빈 지시문/`enabled:true`로 append.
- 삭제는 확인 없이 즉시(가역적 — 저장 전까지는 취소 가능, 기존 설정 모달의 "취소" 버튼으로 되돌릴 수 있음).

## 6. 파이프라인 패널 (`PipelinePanel.tsx`)

`StageView`(런타임 표시용 내부 타입)에 `prompt?: string` 필드 추가해 `initialStages`에서 `store.pipeline.stages`로부터 그대로 실어온다. `handleRun`이 `StageConfig[]`를 만들 때 `prompt: s.prompt`를 포함하도록 한 줄 추가. 그 외 렌더링·상태 관리 로직은 이미 배열을 일반적으로 순회하므로 변경 없음.

## 7. 에러 처리 / 엣지 케이스

- 단계가 0개(전부 삭제) → 파이프라인 실행 시 `runPipeline`이 빈 배열을 순회해 즉시 빈 결과 반환(크래시 없음). UI에서 "Run" 버튼을 단계 0개일 때 비활성화하는 것을 권장(사용자가 실수로 빈 파이프라인을 돌리지 않도록).
- 업무 지시문을 비워둔 단계 → `buildBrief`가 자동으로 그 부분을 건너뜀(기존 `filter(s.length>0)` 로직 그대로 재사용).
- id 충돌 없음(신규 단계는 `crypto.randomUUID()`로 생성).

## 8. 테스트

- **vitest**: `buildBrief`가 `stage.prompt`를 그대로 사용하는지(기존 테스트가 `STAGE_PROMPTS` 딕셔너리 기반이었다면 `prompt` 필드 기반으로 갱신), 빈 `prompt`일 때 그 파트가 생략되는지, 임의 개수(4개 이상)의 단계로 `runPipeline`이 정상 순차 실행되는지(기존 mock 기반 파이프라인 테스트 확장).
- **수동 스모크**(`pnpm tauri dev`): 설정에서 단계 추가(워커1/워커2/워커3/심판, 각기 다른 지시문) → 순서 변경 → 파이프라인 실행 → 각 단계가 지시문대로 동작하고 심판이 이전 결과를 받아 종합하는지 확인. 기존 Plan/Code/Review 기본값도 회귀 없이 동작 확인.
- 게이트: `tsc --noEmit` + `pnpm test` + `pnpm build`.

## 9. 리스크

1. **StageConfig.id 타입 완화**가 다른 곳에서 `"plan"|"code"|"review"` 리터럴에 의존하는 코드가 있으면 컴파일 에러로 즉시 드러남(조용한 오동작 없음) — 구현 시 전체 사용처 확인 필요(PipelinePanel.tsx의 `id as StageConfig["id"]` 캐스트는 이제 불필요해지므로 제거 가능).
2. **긴 지시문 텍스트영역**이 설정 모달 레이아웃을 늘릴 수 있음 — 기존 필드 패턴(`settings-modal__field`)과 일관된 스타일로 처리.
3. **빈 파이프라인(단계 0개)** — 위 §7에서 방어 처리.
