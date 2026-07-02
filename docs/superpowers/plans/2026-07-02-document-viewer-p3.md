# 문서 뷰어 P3 (PowerPoint .pptx) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.pptx` 파일을 에디터 영역 안에서 캔버스 기반으로 렌더하고, 렌더 실패 시 "OS 앱으로 열기" 폴백을 제공한다.

**Architecture:** `fileKind`은 이미 `"pptx"`를 반환하고 DocViewer는 현재 pptx를 `UnsupportedViewer`("준비 중")로 라우팅한다(P1/P2에서 완비). P3는 `pptxviewjs`(MIT, canvas 기반 슬라이드 렌더러)를 동적 import하는 `PptxViewer` 컴포넌트를 추가하고 DocViewer가 pptx를 이 컴포넌트로 보내도록 바꾼다. pptxviewjs는 스크롤형 다중 슬라이드 DOM이 아니라 **한 번에 슬라이드 하나를 `<canvas>`에 그리는** 모델이므로, 이전/다음 네비게이션 + 슬라이드 카운터 UI가 필요하다. 렌더 실패(임포트·파싱·렌더 예외)는 반드시 OS-열기 폴백으로 떨어진다.

**Tech Stack:** React 19 + TypeScript, Vite 7 동적 `import()`, `pptxviewjs`(+ peer deps `jszip`, `chart.js`), 기존 `fs.readFileBytes`(base64 IPC) + `base64ToUint8Array`, 기존 `openInOsApp`(tauri-plugin-opener).

## Global Constraints

- 뷰어는 **읽기 전용**. 편집/저장 affordance 없음.
- 무거운 라이브러리(`pptxviewjs` 및 peer deps)는 **동적 `import()`**로만 로드 — 메인/엔트리 번들에 들어가면 안 됨(P2에서 SheetJS를 lazy 청크로 분리한 것과 동일 요구).
- `DocViewer`는 항상 마운트된 Monaco 에디터 **위의 오버레이**다. 뷰어 마운트/언마운트가 Monaco를 언마운트/리마운트하면 안 됨(과거 stale-ref 크래시 원인).
- 파일 바이트는 `fs.readFileBytes(path) → { base64 }`(Rust `read_file_bytes`, **25MB 상한**)로 받아 `base64ToUint8Array`로 `Uint8Array` 변환.
- pptx 렌더는 **베스트-에포트**다. 임포트/로드/렌더 중 어떤 예외든 반드시 **"OS 기본 앱으로 열기" 폴백**을 보여준다(spec §7).
- 새 런타임 의존성은 **허용 라이선스(MIT/Apache-2.0/BSD 등)**만 추가한다. `pptxviewjs`는 MIT로 확인됨 — peer deps(`jszip`, `chart.js`)의 라이선스도 착수 시 확인한다(둘 다 통상 MIT/Apache 계열).
- 게이트: `pnpm exec tsc --noEmit` 0 errors + `pnpm test` 전부 green(기존 47개 유지) + `pnpm build`(프로덕션 번들) 성공.
- 순수 로직이 없는 명령형 캔버스 글루이므로 **새 vitest 단위 테스트는 추가하지 않는다**(P1/P2의 ImageViewer·PdfViewer·DocxViewer도 단위 테스트 없이 tsc+build+수동 스모크로 검증됨 — 동일 선례). pptx 라우팅에 필요한 `fileKind("*.pptx")==="pptx"`는 P1에서 이미 테스트됨. 게이트는 tsc + 기존 스위트 green + build + 수동 스모크.

## File Structure

- **Create** `src/components/viewers/PptxViewer.tsx` — canvas 기반 pptx 뷰어. `{ path }`를 받아 스스로 로드/렌더, 슬라이드 네비, 에러→OS-열기 폴백.
- **Create (필요 시)** `src/types/pptxviewjs.d.ts` — `pptxviewjs`가 타입을 동봉하지 않을 경우에만 최소 모듈 선언(동봉하면 만들지 않음).
- **Modify** `src/components/viewers/DocViewer.tsx` — pptx 분기를 `UnsupportedViewer`에서 `PptxViewer`로 교체.
- **Modify** `src/styles.css` — `.doc-viewer__pptx*` 스타일 추가(기존 `.doc-viewer__*` 관례 따름).
- **Modify** `package.json` / `pnpm-lock.yaml` — `pptxviewjs`, `jszip`, `chart.js` 추가.

---

## Task 1: pptxviewjs 번들 실사 + 최소 PptxViewer 결선

**목적:** P2의 x-data-spreadsheet가 Vite 번들에서 raw `src`/`.less`/`approve-builds` 문제로 고생한 선례를 반영해, **실제 UI를 다 짓기 전에 `pptxviewjs`가 우리 Vite 셋업에서 번들되는지 먼저 증명**한다. 최소 스텁을 DocViewer에 실제로 결선해 `pnpm build`가 pptxviewjs를 lazy 청크로 끌어오게 만든다(임포트되지 않으면 tree-shake되어 번들 검증이 무의미해짐).

**Files:**
- Create: `src/components/viewers/PptxViewer.tsx` (스텁)
- Create (조건부): `src/types/pptxviewjs.d.ts`
- Modify: `src/components/viewers/DocViewer.tsx` (pptx 라우팅 교체)
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `fs.readFileBytes(path: string): Promise<{ base64: string; size: number }>` (from `../../lib/fs`), `base64ToUint8Array(b64: string): Uint8Array` (from `../../lib/bytes`), `openInOsApp(path: string): Promise<void>` (from `./openExternally`), `FileKind` (from `../../lib/fileKind`).
- Produces: `PptxViewer({ path }: { path: string }): React.JSX.Element` — DocViewer가 `kind === "pptx"`일 때 렌더.

- [ ] **Step 1: 의존성 설치 + 라이선스 확인**

```bash
pnpm add pptxviewjs jszip chart.js
```

설치 후 라이선스 확인(모두 허용 계열이어야 함):

```bash
node -e "for (const p of ['pptxviewjs','jszip','chart.js']) console.log(p, require(p+'/package.json').license)"
```

Expected: `pptxviewjs MIT`, `jszip (MIT or GPL dual → MIT 사용)`, `chart.js MIT`. 만약 `pptxviewjs`가 MIT가 아니거나 peer dep이 비허용 라이선스면 **STOP** 후 Do NOT 항목대로 오케스트레이터에 에스컬레이트.

> pnpm이 빌드 스크립트 승인 게이트를 띄우면(P2의 x-data-spreadsheet/core-js 선례) `pnpm approve-builds` 후 진행. 소스 변경 아님 — result에 플래그만.

- [ ] **Step 2: 타입 동봉 여부 확인**

```bash
node -e "const p=require('pptxviewjs/package.json'); console.log('types:', p.types || p.typings || 'NONE')"
```

- `types`/`typings`가 있으면 → `src/types/pptxviewjs.d.ts`를 만들지 않는다.
- `NONE`이면 → 아래 최소 선언을 생성한다(TypeScript가 `import { PPTXViewer } from "pptxviewjs"`를 해석하도록):

`src/types/pptxviewjs.d.ts` (조건부 생성):
```ts
declare module "pptxviewjs" {
  export interface PPTXViewerOptions {
    canvas: HTMLCanvasElement;
    autoExposeGlobals?: boolean;
  }
  export class PPTXViewer {
    constructor(options: PPTXViewerOptions);
    loadFile(file: File | ArrayBuffer): Promise<void>;
    render(canvas?: HTMLCanvasElement): Promise<void>;
    renderSlide(index: number, canvas?: HTMLCanvasElement): Promise<void>;
    nextSlide(canvas?: HTMLCanvasElement): Promise<void>;
    previousSlide(canvas?: HTMLCanvasElement): Promise<void>;
    on(event: "loadComplete", handler: (info: { slideCount: number }) => void): void;
    on(event: "slideChanged", handler: (index: number) => void): void;
    on(event: "renderComplete", handler: () => void): void;
  }
}
```

> 동봉 타입이 있으면 그 타입의 실제 시그니처가 위 가정과 다를 수 있다. 그럴 땐 Task 2에서 **동봉 타입에 맞춰** 호출부를 조정한다(가정보다 실제 타입이 우선).

- [ ] **Step 3: 최소 PptxViewer 스텁 작성**

`src/components/viewers/PptxViewer.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";

export function PptxViewer({ path }: { path: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 번들 검증용: pptxviewjs를 동적 import해 Vite가 lazy 청크로 끌어오게 한다.
      await import("pptxviewjs");
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [path]);

  return (
    <div className="doc-viewer__pptx">
      {loading ? <div className="doc-viewer__loading">로딩 중…</div> : null}
      <div className="doc-viewer__pptx-stage">
        <canvas ref={canvasRef} className="doc-viewer__pptx-canvas" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: DocViewer가 pptx를 PptxViewer로 라우팅**

`src/components/viewers/DocViewer.tsx` — 상단 import에 추가:
```tsx
import { PptxViewer } from "./PptxViewer";
```
pptx 분기를 아래로 교체(기존 `UnsupportedViewer` "준비 중" 블록 제거):
```tsx
  if (kind === "pptx") return <PptxViewer path={path} />;
```
(마지막 `return <UnsupportedViewer … "미리보기를 지원하지 않습니다." />;`는 그대로 둔다 — binary 등 폴백.)

- [ ] **Step 5: 타입 체크**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors. (에러 시 Step 2의 `.d.ts` 필요 여부/시그니처 재확인.)

- [ ] **Step 6: 번들 실사 — 프로덕션 빌드**

Run: `pnpm build`
Expected: `✓ built` 성공. 빌드 후 pptxviewjs가 **엔트리 청크가 아닌 lazy 청크**에 있는지 확인:

```bash
ls dist/assets/*.js
grep -rl "PPTXViewer" dist/assets/ | head
```
Expected: `PPTXViewer` 시그니처가 엔트리(`index-*.js`)가 아닌 별도 lazy 청크(예: `PptxViewer-*.js` 또는 pptxviewjs 벤더 청크)에만 존재. 엔트리에 있으면 실패로 간주하고 동적 import 경로 재확인.

> **폴백 프로토콜(spec의 pptx=베스트-에포트):** `pnpm build`가 pptxviewjs 때문에 실패하고 합리적 시도(약 2회 — `.less`/loader/`approve-builds` 등 P2식 원인 조사)로도 해결 불가하면: DocViewer의 pptx 라우팅을 원복(다시 `UnsupportedViewer`, 메시지 "이 환경에서는 PPTX 미리보기를 사용할 수 없습니다. OS 앱으로 열어주세요."), `pptxviewjs`/`jszip`/`chart.js`를 `pnpm remove`, **BLOCKED** 상태로 실패 원인과 함께 오케스트레이터에 보고. 무리하게 우회 패치하지 말 것.

- [ ] **Step 7: 기존 테스트 그대로 통과 확인**

Run: `pnpm test`
Expected: `Tests 47 passed (47)` (신규 테스트 없음 — Global Constraints 참조).

- [ ] **Step 8: 커밋**

```bash
git add src/components/viewers/PptxViewer.tsx src/components/viewers/DocViewer.tsx package.json pnpm-lock.yaml
git add src/types/pptxviewjs.d.ts 2>/dev/null || true
git commit -F - <<'EOF'
feat: PptxViewer 스텁 + pptxviewjs 번들 결선 (P3 Task 1)

pptxviewjs(MIT) + peer deps(jszip, chart.js) 추가. DocViewer가 pptx를
PptxViewer로 라우팅. 동적 import로 lazy 청크 분리 확인, tsc/build 통과.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: PptxViewer 전체 구현 — 로드·렌더·슬라이드 네비·에러 폴백

**목적:** Task 1의 스텁을 실제 뷰어로 완성한다. pptx 바이트를 로드해 첫 슬라이드를 캔버스에 렌더하고, 슬라이드가 여러 장이면 이전/다음 네비게이션 + 카운터를 제공하며, 어떤 실패든 OS-열기 폴백으로 떨어진다.

**Files:**
- Modify: `src/components/viewers/PptxViewer.tsx`
- Modify: `src/styles.css` (`.doc-viewer__pptx*` 추가)

**Interfaces:**
- Consumes: `fs.readFileBytes` / `base64ToUint8Array` / `openInOsApp` (Task 1 Interfaces 참조), `pptxviewjs`의 `PPTXViewer`(생성자 `{ canvas, autoExposeGlobals? }`, `loadFile(File|ArrayBuffer)`, `render()`, `renderSlide(index, canvas?)`, `on("loadComplete", ({slideCount})=>…)`).
- Produces: 변경 없음(공개 시그니처 `PptxViewer({ path })` 유지).

- [ ] **Step 1: PptxViewer 전체 구현으로 교체**

`src/components/viewers/PptxViewer.tsx` 전체를 아래로 교체:
```tsx
import { useEffect, useRef, useState } from "react";
import { fs } from "../../lib/fs";
import { base64ToUint8Array } from "../../lib/bytes";
import { openInOsApp } from "./openExternally";
import type { PPTXViewer } from "pptxviewjs";

export function PptxViewer({ path }: { path: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<PPTXViewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slideCount, setSlideCount] = useState(0);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    setError(null);
    setLoading(true);
    setSlideCount(0);
    setIndex(0);
    viewerRef.current = null;

    void (async () => {
      try {
        const { base64 } = await fs.readFileBytes(path);
        const bytes = base64ToUint8Array(base64);
        const { PPTXViewer } = await import("pptxviewjs");
        if (cancelled) return;
        const viewer = new PPTXViewer({ canvas, autoExposeGlobals: false });
        let count = 0;
        viewer.on("loadComplete", (info: { slideCount: number }) => {
          count = info.slideCount;
        });
        await viewer.loadFile(bytes.buffer);
        if (cancelled) return;
        await viewer.render();
        if (cancelled) return;
        viewerRef.current = viewer;
        setSlideCount(count);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      viewerRef.current = null;
    };
  }, [path]);

  const goTo = (next: number): void => {
    const viewer = viewerRef.current;
    const canvas = canvasRef.current;
    if (viewer === null || canvas === null) return;
    if (next < 0 || next >= slideCount) return;
    setIndex(next);
    void viewer.renderSlide(next, canvas);
  };

  if (error !== null) {
    return (
      <div className="doc-viewer__unsupported">
        <p>PPTX를 표시할 수 없습니다: {error}</p>
        <button type="button" className="toolbar__btn" onClick={() => void openInOsApp(path)}>
          OS 기본 앱으로 열기
        </button>
      </div>
    );
  }

  return (
    <div className="doc-viewer__pptx">
      {loading ? <div className="doc-viewer__loading">로딩 중…</div> : null}
      <div className="doc-viewer__pptx-stage">
        <canvas ref={canvasRef} className="doc-viewer__pptx-canvas" />
      </div>
      {slideCount > 1 ? (
        <div className="doc-viewer__pptx-nav">
          <button
            type="button"
            className="toolbar__btn"
            disabled={index <= 0}
            onClick={() => goTo(index - 1)}
          >
            이전
          </button>
          <span className="doc-viewer__pptx-count">
            {index + 1} / {slideCount}
          </span>
          <button
            type="button"
            className="toolbar__btn"
            disabled={index >= slideCount - 1}
            onClick={() => goTo(index + 1)}
          >
            다음
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

> **API 조정 주의:** 위 코드는 pptxviewjs 문서 기준 가정이다. Task 1에서 동봉 타입을 확인했다면 **동봉 타입의 실제 시그니처가 우선**이다. 특히: (a) 슬라이드 수를 `loadComplete` 이벤트 대신 뷰어의 프로퍼티/메서드(예: `viewer.slideCount`)로 얻어야 한다면 그쪽을 쓴다. (b) `loadFile`이 `ArrayBuffer`를 거부하고 `File`만 받으면 `new File([bytes], name)`로 감싼다. (c) `render()`/`renderSlide()` 인자 형태가 다르면 맞춘다. 어떤 경우든 예외는 catch되어 폴백으로 떨어져야 한다.

- [ ] **Step 2: CSS 추가**

`src/styles.css`의 `.doc-viewer__xlsx-host .x-spreadsheet { … }` 줄 **다음, `.editor-pane__preview-toggle` 규칙 앞**에 추가:
```css
.doc-viewer__pptx { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--bg-editor); overflow: hidden; }
.doc-viewer__pptx-stage { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 12px; background: #2a2a2a; }
.doc-viewer__pptx-canvas { max-width: 100%; max-height: 100%; background: #fff; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4); }
.doc-viewer__pptx-nav { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; gap: 12px; padding: 8px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 13px; }
```

- [ ] **Step 3: 타입 체크**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: 프로덕션 빌드**

Run: `pnpm build`
Expected: `✓ built` 성공(pptxviewjs 여전히 lazy 청크).

- [ ] **Step 5: 기존 테스트 통과 확인**

Run: `pnpm test`
Expected: `Tests 47 passed (47)`.

- [ ] **Step 6: 커밋**

```bash
git add src/components/viewers/PptxViewer.tsx src/styles.css
git commit -F - <<'EOF'
feat: PptxViewer 슬라이드 렌더 + 네비게이션 + 에러 폴백 (P3 Task 2)

pptx 바이트를 pptxviewjs로 로드해 캔버스에 렌더. 다중 슬라이드는
이전/다음 + 카운터. 로드/렌더 실패 시 OS-열기 폴백. 읽기 전용.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## 수동 스모크(구현 후 오케스트레이터가 `pnpm tauri dev`로 확인)

- [ ] `.pptx` 파일 탭으로 열기 → 첫 슬라이드가 캔버스에 렌더된다.
- [ ] 여러 슬라이드 pptx → "이전/다음"으로 슬라이드 전환, "N / M" 카운터 정확.
- [ ] 손상/비정상 pptx → 에러 메시지 + "OS 기본 앱으로 열기" 버튼(폴백)이 뜬다.
- [ ] pptx 여러 개 연달아 열고 전환 → 이전 캔버스 잔상·크래시 없음, Monaco 영향 없음.
- [ ] 텍스트/이미지/pdf/docx/xlsx는 기존대로 동작(회귀 없음).

## Self-Review 노트

- **Spec 커버리지:** spec §9 P3 = PowerPoint(`pptxviewjs`) + 미지원 폴백. Task 1+2가 pptxviewjs 렌더를, 에러 분기가 폴백을 구현. openExternally/UnsupportedViewer는 P1 기존 자산 재사용. ✓
- **타입 일관성:** `PptxViewer({ path })` 시그니처가 Task 1 스텁과 Task 2 전체 구현에서 동일. DocViewer import/사용 일치. `PPTXViewer` 메서드명(`loadFile`/`render`/`renderSlide`/`on`)이 Task 1의 `.d.ts`(생성 시)와 Task 2 사용부에서 일치. ✓
- **알려진 리스크:** (1) pptxviewjs Vite 번들 실패 가능성 → Task 1에서 앞단 검증 + 폴백 프로토콜. (2) destroy API 부재 → 캔버스는 React 관리라 언마운트 시 회수됨(x-data-spreadsheet 같은 window 리스너 이슈가 있으면 KNOWN_ISSUES에 기록). (3) 문서 기준 API 가정 → 동봉 타입 우선, 예외는 폴백으로 흡수.
