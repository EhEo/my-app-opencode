# 파이프라인 단계 자유 구성 (Worker N + 심판) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 파이프라인 단계를 고정 Plan/Code/Review 3개에서, 사용자가 이름·업무 지시문·개수·순서를 자유롭게 정하는 구조로 바꾼다(예: 워커1/워커2/워커3/심판).

**Architecture:** `pipeline.ts`의 실행 루프는 이미 `StageConfig[]`를 순차 순회하며 각 단계가 이전 모든 단계 결과를 브리프에 받는 완전히 일반적인 구조다. 유일한 하드코딩 지점은 `StageConfig.id`가 `"plan"|"code"|"review"` 리터럴이라는 것과, 업무 지시문이 그 3개 키로 `STAGE_PROMPTS`에 고정돼 있다는 것뿐이다. `id`를 자유 문자열로 완화하고 `StageConfig.prompt` 필드를 추가해 그 지시문을 데이터로 옮기면, 실행 엔진 변경 없이 임의 개수·이름의 단계를 지원한다.

**Tech Stack:** TypeScript, React 19, vitest.

## Global Constraints

- spec: `docs/superpowers/specs/2026-07-03-pipeline-custom-stages-design.md`. 아래는 그 binding 요구.
- 실행 방식은 **순차 체인**만(병렬 팬아웃 없음). 심판은 구조적으로 다른 단계와 완전히 동일(특수 로직 없음).
- 기존 저장 데이터(`id:"plan"` 등)는 **마이그레이션 없이 그대로 유효**해야 한다(id가 이제 일반 문자열이므로 자동으로 성립 — 별도 변환 코드 작성 금지).
- 신규 설치 기본값(`DEFAULT_STAGES`)은 기존과 **동일한 3단계 + 동일한 지시문 텍스트**를 유지(회귀 없음).
- 단계 0개(전부 삭제)여도 `runPipeline`이 크래시 없이 빈 결과를 반환해야 한다(기존 빈 배열 순회 로직으로 이미 성립 — 확인만).
- 이 코드베이스에는 React 컴포넌트 테스트 인프라가 없다(`@testing-library/react` 등 미설치). UI 태스크는 `tsc`+수동 스모크로 검증하고 새 컴포넌트 테스트 프레임워크를 들이지 않는다.
- 게이트: `pnpm exec tsc --noEmit` 0, `pnpm exec vitest run` 전체 green, 최종 태스크에서 `pnpm build` 성공.

## File Structure

- Modify `src/lib/settings.ts` — `StageConfig.id`를 `string`으로, `prompt?: string` 추가.
- Modify `src/lib/workers.ts` — `DEFAULT_STAGES`에 기존 지시문을 `prompt`로 이관.
- Modify `src/lib/pipeline.ts` — `STAGE_PROMPTS` 제거, `buildBrief`가 `stage.prompt` 사용.
- Modify `src/lib/__tests__/pipeline.test.ts` — 신규 동작 테스트 추가(기존 테스트는 변경 없이 통과해야 함).
- Modify `src/components/PipelinePanel.tsx` — `StageView`/`initialStages`/`handleRun`에 `prompt` 필드 전파.
- Modify `src/components/SettingsModal.tsx` — 파이프라인 단계 CRUD UI(추가/삭제/순서변경/이름·지시문·백엔드 편집).
- Modify `src/styles.css` — 단계 목록/항목 레이아웃 CSS.

---

### Task 1: 데이터 모델 + buildBrief — 지시문을 하드코딩에서 데이터로 (TDD)

**Files:**
- Modify: `src/lib/settings.ts`
- Modify: `src/lib/workers.ts`
- Modify: `src/lib/pipeline.ts`
- Test: `src/lib/__tests__/pipeline.test.ts`

**Interfaces:**
- Produces (Task 2·3가 사용): `StageConfig { id: string; label: string; prompt?: string; backendId?: string; enabled: boolean }`(settings.ts). `buildBrief(request, stage, prior): string`(pipeline.ts, 시그니처 불변, 내부 로직만 변경).

- [ ] **Step 1: 현재 코드 확인**

`src/lib/settings.ts`에서 다음을 찾는다:
```ts
export interface StageConfig {
  id: "plan" | "code" | "review";
  label: string;
  backendId?: string;
  enabled: boolean;
}
```

- [ ] **Step 2: StageConfig 타입 완화 + prompt 필드 추가**

위 블록을 다음으로 교체:
```ts
export interface StageConfig {
  id: string;
  label: string;
  /** Per-stage task instructions. Empty/undefined = no instruction text is
   *  added to the brief (request + prior-stage outputs still are). */
  prompt?: string;
  backendId?: string;
  enabled: boolean;
}
```

- [ ] **Step 3: 실패하는 테스트 작성** — `src/lib/__tests__/pipeline.test.ts`의 파일 끝(기존 `describe("runPipeline", ...)` 블록 다음)에 추가:

```ts
describe("buildBrief with custom prompts", () => {
  it("includes the stage's own prompt text", () => {
    const stage: StageConfig = {
      id: "w1",
      label: "Worker 1",
      enabled: true,
      prompt: "Do the research.",
    };
    const brief = buildBrief("find bugs", stage, []);
    expect(brief).toBe("Do the research.\n\n# Request\nfind bugs");
  });

  it("omits the prompt section entirely when prompt is empty or undefined", () => {
    const noPrompt: StageConfig = { id: "w1", label: "Worker 1", enabled: true };
    expect(buildBrief("find bugs", noPrompt, [])).toBe("# Request\nfind bugs");

    const emptyPrompt: StageConfig = { id: "w2", label: "Worker 2", enabled: true, prompt: "" };
    expect(buildBrief("find bugs", emptyPrompt, [])).toBe("# Request\nfind bugs");
  });
});

describe("runPipeline with an arbitrary custom stage list", () => {
  it("runs a 4-stage worker+judge chain with free-form ids and per-stage prompts", async () => {
    const stages: StageConfig[] = [
      { id: "worker1", label: "Worker 1", enabled: true, prompt: "Research the codebase." },
      { id: "worker2", label: "Worker 2", enabled: true, prompt: "Implement the change." },
      { id: "worker3", label: "Worker 3", enabled: true, prompt: "Write tests." },
      {
        id: "judge",
        label: "Judge",
        enabled: true,
        prompt: "Review all prior outputs and give a final verdict.",
      },
    ];
    const results = await runPipeline({ request: "add auth", stages, deps: okDeps });
    expect(results.map((r) => r.stageId)).toEqual(["worker1", "worker2", "worker3", "judge"]);
    expect(results.every((r) => r.output.startsWith("inapp:"))).toBe(true);
  });

  it("runs with zero stages without crashing", async () => {
    const results = await runPipeline({ request: "x", stages: [], deps: okDeps });
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `pnpm exec vitest run src/lib/__tests__/pipeline.test.ts`
Expected: 새 테스트는 FAIL(`buildBrief`가 아직 `STAGE_PROMPTS`를 참조), 기존 테스트는 그대로 PASS.

- [ ] **Step 5: workers.ts DEFAULT_STAGES에 지시문 이관**

`src/lib/workers.ts`에서 다음을 찾는다:
```ts
export const DEFAULT_STAGES: StageConfig[] = [
  { id: "plan", label: "Plan", enabled: true },
  { id: "code", label: "Code", enabled: true },
  { id: "review", label: "Review", enabled: true },
];
```
다음으로 교체:
```ts
export const DEFAULT_STAGES: StageConfig[] = [
  {
    id: "plan",
    label: "Plan",
    enabled: true,
    prompt: "You are the PLAN stage. Produce a concise step-by-step plan. Do not write files.",
  },
  {
    id: "code",
    label: "Code",
    enabled: true,
    prompt: "You are the CODE stage. Implement the plan. Use tools to read and write files.",
  },
  {
    id: "review",
    label: "Review",
    enabled: true,
    prompt:
      "You are the REVIEW stage. Read the changes and report issues. Read-only — do not modify files.",
  },
];
```

- [ ] **Step 6: pipeline.ts — STAGE_PROMPTS 제거, buildBrief가 stage.prompt 사용**

`src/lib/pipeline.ts`에서 다음을 찾는다:
```ts
const STAGE_PROMPTS: Record<string, string> = {
  plan: "You are the PLAN stage. Produce a concise step-by-step plan. Do not write files.",
  code: "You are the CODE stage. Implement the plan. Use tools to read and write files.",
  review:
    "You are the REVIEW stage. Read the changes and report issues. Read-only — do not modify files.",
};

export function buildBrief(
  request: string,
  stage: StageConfig,
  prior: StageResult[],
): string {
  const parts: string[] = [STAGE_PROMPTS[stage.id] ?? "", `# Request\n${request}`];
  for (const p of prior) {
    parts.push(`# ${p.label} output\n${p.output}`);
  }
  return parts.filter((s) => s.length > 0).join("\n\n");
}
```
다음으로 교체(`STAGE_PROMPTS` 상수 전체 삭제, `buildBrief` 내부 한 줄만 변경):
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

- [ ] **Step 7: 통과 확인**

Run: `pnpm exec vitest run` 그리고 `pnpm exec tsc --noEmit`
Expected: 전체 green(기존 81개 + 신규 4개 = **85개**), tsc 0. 기존 `buildBrief`/`runPipeline` 테스트(3단계 고정 시나리오)도 변경 없이 그대로 통과해야 한다(DEFAULT_STAGES의 id가 여전히 "plan"/"code"/"review" 문자열이므로).

- [ ] **Step 8: 커밋**

```bash
git add src/lib/settings.ts src/lib/workers.ts src/lib/pipeline.ts src/lib/__tests__/pipeline.test.ts
git commit -m "feat: StageConfig를 자유 id+prompt로 일반화, buildBrief가 STAGE_PROMPTS 하드코딩 대신 사용"
```

---

### Task 2: PipelinePanel.tsx — 런타임에서 prompt 필드 전파

**Files:**
- Modify: `src/components/PipelinePanel.tsx`

**Interfaces:**
- Consumes: Task 1의 `StageConfig.prompt`.
- Produces: 변경 없음(내부 `StageView` 타입에 필드 추가는 이 파일 내부에서만 쓰임).

**목적:** 파이프라인 패널이 단계 목록을 store에서 읽어 `StageConfig[]`를 다시 만들어 `runPipeline`에 넘기는데, 지금은 `prompt`를 안 실어 날라서 설정에서 지시문을 적어도 실행 시 사라진다. 필드 하나만 두 지점에 추가하면 된다.

- [ ] **Step 1: StageView 타입에 prompt 추가**

기존:
```ts
type StageView = {
  id: string;
  label: string;
  backendId: string | undefined; // undefined = default in-app
  status: "pending" | "running" | "done" | "error";
  output: string;
};
```
교체 후:
```ts
type StageView = {
  id: string;
  label: string;
  prompt: string | undefined;
  backendId: string | undefined; // undefined = default in-app
  status: "pending" | "running" | "done" | "error";
  output: string;
};
```

- [ ] **Step 2: initialStages가 prompt를 함께 읽도록**

기존:
```ts
function initialStages(store: ProviderStore | null): StageView[] {
  const stages: StageConfig[] = store?.pipeline?.stages ?? DEFAULT_STAGES;
  return stages
    .filter((s) => s.enabled)
    .map((s) => ({
      id: s.id,
      label: s.label,
      backendId: s.backendId,
      status: "pending",
      output: "",
    }));
}
```
교체 후:
```ts
function initialStages(store: ProviderStore | null): StageView[] {
  const stages: StageConfig[] = store?.pipeline?.stages ?? DEFAULT_STAGES;
  return stages
    .filter((s) => s.enabled)
    .map((s) => ({
      id: s.id,
      label: s.label,
      prompt: s.prompt,
      backendId: s.backendId,
      status: "pending",
      output: "",
    }));
}
```

- [ ] **Step 3: handleRun의 stageConfigs 매핑이 prompt를 실어 나르도록**

`handleRun` 함수 내부, 기존:
```ts
    const stageConfigs: StageConfig[] = stages.map((s) => ({
      id: s.id as StageConfig["id"],
      label: s.label,
      backendId: s.backendId,
      enabled: true,
    }));
```
교체 후(불필요해진 `as StageConfig["id"]` 캐스트도 함께 제거 — `id`가 이제 양쪽 다 `string`이라 캐스트가 필요 없음):
```ts
    const stageConfigs: StageConfig[] = stages.map((s) => ({
      id: s.id,
      label: s.label,
      prompt: s.prompt,
      backendId: s.backendId,
      enabled: true,
    }));
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec tsc --noEmit` → 0 errors. `pnpm exec vitest run` → 85개 그대로(이 태스크는 순수 필드 전파라 신규 테스트 없음 — Global Constraints의 "컴포넌트 테스트 인프라 없음" 참조).

- [ ] **Step 5: 커밋**

```bash
git add src/components/PipelinePanel.tsx
git commit -m "fix: 파이프라인 패널이 단계별 커스텀 지시문(prompt)을 실행 시 전달하도록"
```

---

### Task 3: SettingsModal.tsx — 단계 추가·삭제·순서변경·지시문 편집 UI

**Files:**
- Modify: `src/components/SettingsModal.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 1의 `StageConfig`(id/label/prompt/backendId/enabled), 기존 `findPreset`.
- Produces: 변경 없음(최종 UI 태스크).

먼저 `src/components/SettingsModal.tsx`의 `AgentsSection` 함수를 Read해서 현재 정확한 내용을 확인하세요(다른 태스크에서 근처 코드가 바뀌었을 수 있음 — 아래 "현재" 블록과 실제 파일 내용이 정확히 일치하는지 대조 후 교체).

### Step 1: setStageBackend를 4개의 CRUD 핸들러로 교체

`AgentsSection` 함수 내부, 기존:
```ts
  const setStageBackend = (stageId: string, backendId: string): void => {
    const nextStages = stages.map((st) =>
      st.id === stageId ? { ...st, backendId: backendId === "" ? undefined : backendId } : st,
    );
    setStore((s) => ({ ...s, pipeline: { stages: nextStages } }));
  };
```
교체 후:
```ts
  const updateStage = (id: string, patch: Partial<StageConfig>): void => {
    const nextStages = stages.map((st) => (st.id === id ? { ...st, ...patch } : st));
    setStore((s) => ({ ...s, pipeline: { stages: nextStages } }));
  };

  const removeStage = (id: string): void => {
    const nextStages = stages.filter((st) => st.id !== id);
    setStore((s) => ({ ...s, pipeline: { stages: nextStages } }));
  };

  const moveStage = (id: string, direction: -1 | 1): void => {
    const idx = stages.findIndex((st) => st.id === id);
    if (idx === -1) return;
    const swapWith = idx + direction;
    if (swapWith < 0 || swapWith >= stages.length) return;
    const nextStages = stages.slice();
    const tmp = nextStages[idx];
    nextStages[idx] = nextStages[swapWith];
    nextStages[swapWith] = tmp;
    setStore((s) => ({ ...s, pipeline: { stages: nextStages } }));
  };

  const addStage = (): void => {
    const newStage: StageConfig = {
      id: crypto.randomUUID(),
      label: "새 단계",
      prompt: "",
      enabled: true,
    };
    setStore((s) => ({ ...s, pipeline: { stages: [...stages, newStage] } }));
  };
```

### Step 2: 렌더링 블록을 CRUD 목록으로 교체

`AgentsSection`의 반환 JSX에서, 기존:
```tsx
      <h3 className="settings-modal__section-title">파이프라인 단계 기본 백엔드</h3>
      {stages.map((st) => (
        <div key={st.id} className="settings-modal__field">
          <span className="settings-modal__label">{st.label}</span>
          <select
            className="settings-modal__input settings-modal__select"
            value={st.backendId ?? ""}
            onChange={(e) => setStageBackend(st.id, e.target.value)}
          >
            <option value="">기본 (인앱 AI)</option>
            {workerIds.map((id) => {
              const w = workers[id];
              const label =
                w.kind === "cli"
                  ? `${id} (CLI: ${w.command})`
                  : w.kind === "inapp"
                    ? `${id} (${findPreset(store, w.providerId)?.label ?? w.providerId} · ${w.model ?? ""})`
                    : id;
              return (
                <option key={id} value={id}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>
      ))}
```
교체 후(단계 이름·지시문·백엔드를 한 카드에서 편집 + 활성화 토글 + 순서변경 + 삭제 + 하단에 추가 버튼):
```tsx
      <h3 className="settings-modal__section-title">파이프라인 단계</h3>
      <p className="settings-modal__hint">
        단계를 자유롭게 추가·삭제·순서 변경할 수 있습니다. 각 단계는 자신의 업무 지시문 +
        요청 + 이전 모든 단계의 결과를 받아 실행됩니다.
      </p>
      <ul className="settings-modal__stage-list">
        {stages.map((st, idx) => (
          <li key={st.id} className="settings-modal__stage-item">
            <div className="settings-modal__mcp-row1">
              <input
                className="settings-modal__input settings-modal__stage-label"
                placeholder="단계 이름"
                value={st.label}
                onChange={(e) => updateStage(st.id, { label: e.target.value })}
              />
              <label className="settings-modal__mcp-toggle">
                <input
                  type="checkbox"
                  checked={st.enabled}
                  onChange={(e) => updateStage(st.id, { enabled: e.target.checked })}
                />
                <span>활성화</span>
              </label>
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--small"
                onClick={() => moveStage(st.id, -1)}
                disabled={idx === 0}
                title="위로 이동"
              >
                ↑
              </button>
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--small"
                onClick={() => moveStage(st.id, 1)}
                disabled={idx === stages.length - 1}
                title="아래로 이동"
              >
                ↓
              </button>
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--small settings-modal__btn--danger"
                onClick={() => removeStage(st.id)}
              >
                삭제
              </button>
            </div>
            <textarea
              className="settings-modal__input settings-modal__stage-prompt"
              placeholder="이 단계의 업무 지시문 (예: 요청을 분석해 단계별 계획을 작성하세요)"
              rows={2}
              value={st.prompt ?? ""}
              onChange={(e) => updateStage(st.id, { prompt: e.target.value })}
            />
            <select
              className="settings-modal__input settings-modal__select"
              value={st.backendId ?? ""}
              onChange={(e) =>
                updateStage(st.id, {
                  backendId: e.target.value === "" ? undefined : e.target.value,
                })
              }
            >
              <option value="">기본 (인앱 AI)</option>
              {workerIds.map((id) => {
                const w = workers[id];
                const label =
                  w.kind === "cli"
                    ? `${id} (CLI: ${w.command})`
                    : w.kind === "inapp"
                      ? `${id} (${findPreset(store, w.providerId)?.label ?? w.providerId} · ${w.model ?? ""})`
                      : id;
                return (
                  <option key={id} value={id}>
                    {label}
                  </option>
                );
              })}
            </select>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="settings-modal__btn settings-modal__btn--small"
        onClick={addStage}
      >
        + 단계 추가
      </button>
```

### Step 3: CSS 추가

`src/styles.css` 파일 맨 끝에 추가:
```css
/* ───────── Pipeline stage config (Settings → Agents) ───────── */

.settings-modal__stage-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings-modal__stage-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
}

.settings-modal__stage-label {
  flex: 1;
  min-width: 0;
}

.settings-modal__stage-prompt {
  height: auto;
  min-height: 44px;
  padding: 8px 10px;
  resize: vertical;
  font-family: inherit;
  line-height: 1.4;
}
```

### Step 4: 전체 게이트 실행 (모두 필수)

1. `pnpm exec tsc --noEmit` → 0 errors
2. `pnpm exec vitest run` → 전체 green(**85개**, 이 태스크는 UI라 신규 테스트 없음 — Global Constraints 참조)
3. `pnpm build` → `✓ built` 성공

Never rationalize a failing gate as a tooling artifact — 실패 시 원인 진단 또는 BLOCKED로 보고.

### Step 5: 커밋

```bash
git add src/components/SettingsModal.tsx src/styles.css
git commit -m "feat: 설정에 파이프라인 단계 추가·삭제·순서변경·지시문 편집 UI"
```

---

## 수동 스모크 (구현 후 오케스트레이터가 `pnpm tauri dev`로 확인)

- [ ] 설정 → Agents 탭 → "파이프라인 단계" 목록에 기존 Plan/Code/Review 3개가 그대로 보이는지(기존 사용자 데이터 호환 확인 — 회귀 없음).
- [ ] "+ 단계 추가"로 새 단계(예: "워커1") 추가 → 이름·업무 지시문 입력 → 백엔드 선택 → 저장.
- [ ] 4단계(워커1/워커2/워커3/심판)로 구성 후 ↑/↓로 순서 변경이 정상 반영되는지.
- [ ] 특정 단계 "활성화" 체크 해제 → 파이프라인 패널에서 그 단계가 실행 목록에서 빠지는지.
- [ ] 단계 "삭제" → 목록에서 사라지고 저장 후 유지되는지.
- [ ] 파이프라인 패널에서 실제 요청 실행 → 각 단계가 지정한 업무 지시문대로 동작하고, 심판(마지막 단계)이 이전 모든 단계 결과를 받아 종합하는지(각 단계의 출력에 이전 단계 내용이 브리프로 녹아들었는지는 심판의 응답 내용으로 간접 확인).
- [ ] 모든 단계를 삭제한 뒤(0개) Run을 눌러도 앱이 크래시하지 않는지(빈 결과로 조용히 끝나는지).

## Self-Review 노트

- **Spec 커버리지**: §3 데이터 모델(Task 1), §4 buildBrief(Task 1), §5 설정 UI(Task 3), §6 파이프라인 패널(Task 2), §7 에러 처리/엣지케이스(0단계는 Task 1 테스트로 검증 + Task 3 스모크로 재확인, 빈 prompt는 Task 1 테스트), §8 테스트(Task 1의 vitest 4개 신규 + 전체 스모크), §9 리스크(id 타입 완화는 Task 1에서 tsc가 즉시 검증, PipelinePanel의 불필요한 캐스트는 Task 2에서 제거). ✓
- **타입 일관성**: `StageConfig.prompt`(Task 1 정의) → Task 2의 `StageView.prompt`/`stageConfigs` 매핑, Task 3의 `updateStage(id, {prompt})`가 모두 동일 필드명 사용. `updateStage`/`removeStage`/`moveStage`/`addStage`(Task 3 정의) 이름이 서로 다른 태스크에서 재정의되지 않음. ✓
- **회귀 확인**: 기존 `pipeline.test.ts`의 3개 테스트(`buildBrief`, `runPipeline` 순차 실행, guard 일시정지, 에러 중단, disabled skip)는 Task 1에서 단 한 글자도 수정하지 않음 — DEFAULT_STAGES가 여전히 "plan"/"code"/"review" id를 쓰므로 그대로 통과. ✓
