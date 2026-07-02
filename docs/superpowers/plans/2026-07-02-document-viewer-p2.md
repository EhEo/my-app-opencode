# Document Viewer P2 (Word + Excel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-pane viewers for Word (`.docx`) and Excel (`.xlsx`), replacing their P1 "open in OS app" fallback, and fix the P1-noted PdfViewer worker leak. Docx renders as formatted HTML (`docx-preview`); xlsx renders as an interactive read-only grid (`x-data-spreadsheet`, fed by SheetJS parsing).

**Architecture:** Two new viewer components (`DocxViewer`, `XlsxViewer`) plugged into the existing `DocViewer` dispatcher (P1). Both load bytes via `fs.readFileBytes` + `base64ToUint8Array` (P1), then hand off to their library. A pure `xlsx → x-data-spreadsheet` converter is extracted and unit-tested. PdfViewer gains proper cleanup (`doc.destroy()` + worker terminate).

**Tech Stack:** `docx-preview` (docx→HTML, MIT), `xlsx` (SheetJS, Apache-2.0, parse only), `x-data-spreadsheet` (grid render, MIT) — all dynamic-imported where they're heavy. Existing P1: `DocViewer`, `fs.readFileBytes`, `base64ToUint8Array`, `fileKind`.

## Global Constraints

- Additive to P1; do not change P1's routing/read-only/overlay behavior or Monaco mounting. Only `DocViewer.tsx` is edited (to route docx/xlsx to the new viewers) plus `PdfViewer.tsx` (cleanup fix) and new files.
- docx/xlsx viewers are **read-only** (view only; no editing/saving) — consistent with P1 viewer tabs.
- Heavy libs dynamic-imported (`await import(...)`) inside the component effect, not top-level, to keep the initial bundle small.
- **Library-version due-diligence:** after `pnpm add`, confirm the installed API matches the code below; if it differs, adapt minimally (keep the load-bytes → parse → render structure) and note it in the report — exactly as P1's pdfjs v6 adjustment was handled. **Fallbacks if a library won't integrate cleanly with Vite/TS:** docx → if `docx-preview` fails, keep the UnsupportedViewer fallback for docx and report BLOCKED; xlsx → if `x-data-spreadsheet` has Vite/ESM/type problems that can't be resolved in ~2 tries, fall back to a read-only HTML table via SheetJS `XLSX.utils.sheet_to_html` (a simpler renderer) and note the downgrade.
- TypeScript strict, `noUnusedLocals`, no `any` in exported/prop types. `x-data-spreadsheet` ships no types → add a module declaration.
- Verify gate per task: `pnpm test` green + `pnpm exec tsc --noEmit` 0 (+ `pnpm build` on the last task to confirm prod bundling of the new libs; + manual smoke where noted).

---

### Task 1: Fix PdfViewer resource cleanup (P1 debt)

**Files:**
- Modify: `src/components/viewers/PdfViewer.tsx`

**Interfaces:**
- Unchanged public component `PdfViewer({ path })`; internal cleanup now destroys the PDF document and terminates the worker on unmount/path-change.

- [ ] **Step 1: Add cleanup for the worker + document**

Rewrite the effect in `PdfViewer.tsx` so the worker and `PDFDocumentProxy` are tracked and torn down. The load/render body stays the same as P1 (byte load → getDocument → per-page canvas render, pdfjs v6 `render({canvasContext, canvas, viewport})`); only worker/doc lifecycle changes:

```tsx
useEffect(() => {
  let cancelled = false;
  let worker: Worker | null = null;
  let doc: import("pdfjs-dist").PDFDocumentProxy | null = null;
  const container = containerRef.current;
  if (container === null) return;
  container.innerHTML = "";
  setError(null);
  setLoading(true);

  void (async () => {
    try {
      const { base64 } = await fs.readFileBytes(path);
      const data = base64ToUint8Array(base64);
      const pdfjs = await import("pdfjs-dist");
      const WorkerMod = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker");
      if (cancelled) return;
      worker = new WorkerMod.default();
      pdfjs.GlobalWorkerOptions.workerPort = worker;
      doc = await pdfjs.getDocument({ data }).promise;
      if (cancelled) return;
      for (let n = 1; n <= doc.numPages; n++) {
        if (cancelled) return;
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1.3 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = "doc-viewer__pdf-page";
        const ctx = canvas.getContext("2d");
        if (ctx === null) continue;
        container.appendChild(canvas);
        await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      }
      if (!cancelled) setLoading(false);
    } catch (e) {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    }
  })();

  return () => {
    cancelled = true;
    if (doc !== null) void doc.destroy();
    if (worker !== null) worker.terminate();
  };
}, [path]);
```

(If the installed pdfjs `render()` signature differs, keep the P1 form that already compiled — the only required change here is the `worker`/`doc` tracking + the cleanup return.)

- [ ] **Step 2: Verify build**

Run: `pnpm exec tsc --noEmit` (0) and `pnpm test` (still 45 green).

- [ ] **Step 3: Manual smoke**

`pnpm tauri dev` → open a PDF, then switch to another tab and back / open a second PDF a few times → no console errors; (optionally) confirm in Task Manager the worker count doesn't grow unbounded.

- [ ] **Step 4: Commit**

```bash
git add src/components/viewers/PdfViewer.tsx
git commit -m "fix: PdfViewer terminates worker + destroys document on cleanup (P1 leak)"
```

---

### Task 2: `DocxViewer` (docx → HTML via docx-preview)

**Files:**
- Modify: `package.json` (add `docx-preview`)
- Create: `src/components/viewers/DocxViewer.tsx`
- Modify: `src/components/viewers/DocViewer.tsx` (route `kind === "docx"`)
- Modify: `src/styles.css` (append `.doc-viewer__docx*`)

**Interfaces:**
- Consumes: `fs.readFileBytes`, `base64ToUint8Array`, `docx-preview` `renderAsync`.
- Produces: `function DocxViewer({ path }: { path: string }): React.JSX.Element` (read-only).

- [ ] **Step 1: Install**

Run: `pnpm add docx-preview`

- [ ] **Step 2: Create `DocxViewer.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { fs } from "../../lib/fs";
import { base64ToUint8Array } from "../../lib/bytes";

export function DocxViewer({ path }: { path: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (container === null) return;
    container.innerHTML = "";
    setError(null);
    setLoading(true);

    void (async () => {
      try {
        const { base64 } = await fs.readFileBytes(path);
        const data = base64ToUint8Array(base64);
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        await renderAsync(data, container, undefined, {
          className: "docx",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
        });
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  return (
    <div className="doc-viewer__docx">
      {loading ? <div className="doc-viewer__loading">로딩 중…</div> : null}
      {error !== null ? <div className="doc-viewer__error">{error}</div> : null}
      <div ref={containerRef} className="doc-viewer__docx-body" />
    </div>
  );
}
```

(`renderAsync(data, bodyContainer, styleContainer?, options?)` is docx-preview's documented signature; `data` accepts `Uint8Array`/`ArrayBuffer`/`Blob`. If the installed version's options differ, pass at least `data` + `container` and drop unknown option keys.)

- [ ] **Step 3: Route in `DocViewer.tsx`**

Add an import `import { DocxViewer } from "./DocxViewer";` and change the docx branch: replace the combined `docx|xlsx|pptx → Unsupported` block so `docx` renders `<DocxViewer path={path} />`, while `xlsx`/`pptx` still go to `UnsupportedViewer` (xlsx handled in Task 4):

```tsx
  if (kind === "docx") return <DocxViewer path={path} />;
  if (kind === "xlsx" || kind === "pptx") {
    return (
      <UnsupportedViewer
        path={path}
        message={`${kind.toUpperCase()} 뷰어는 아직 준비 중입니다. OS 앱으로 열 수 있어요.`}
      />
    );
  }
```

- [ ] **Step 4: Append CSS**

```css
.doc-viewer__docx { width: 100%; height: 100%; overflow: auto; background: #525659; padding: 16px; }
.doc-viewer__docx-body { background: #fff; color: #000; margin: 0 auto; }
.doc-viewer__docx-body .docx-wrapper { background: transparent; padding: 0; }
```

- [ ] **Step 5: Verify + smoke**

`pnpm exec tsc --noEmit` (0), `pnpm test` (45). Then `pnpm tauri dev` → open a `.docx` → formatted document renders; a broken/huge docx shows the error div.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/components/viewers/DocxViewer.tsx src/components/viewers/DocViewer.tsx src/styles.css
git commit -m "feat: DocxViewer — render .docx via docx-preview"
```

---

### Task 3: `xlsxData.ts` — SheetJS workbook → x-data-spreadsheet data (TDD)

**Files:**
- Modify: `package.json` (add `xlsx`)
- Create: `src/lib/xlsxData.ts`
- Create: `src/lib/__tests__/xlsxData.test.ts`

**Interfaces:**
- Produces:
  - `interface XCell { text: string }`
  - `interface XRow { cells: Record<number, XCell> }`
  - `interface XSheet { name: string; rows: Record<number, XRow> }`
  - `function workbookToXSpreadsheet(wb: XLSX.WorkBook): XSheet[]` — each worksheet → `{ name, rows }` with cell display text (`cell.w ?? String(cell.v)`).
  - `function parseXlsx(bytes: Uint8Array): XSheet[]` — `XLSX.read(bytes, { type: "array" })` then `workbookToXSpreadsheet`.

- [ ] **Step 1: Install**

Run: `pnpm add xlsx`

- [ ] **Step 2: Write failing tests**

Create `src/lib/__tests__/xlsxData.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { workbookToXSpreadsheet } from "../xlsxData";

describe("workbookToXSpreadsheet", () => {
  it("maps cells to x-spreadsheet rows with display text", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Name", "Qty"],
      ["Apple", 3],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S1");

    const sheets = workbookToXSpreadsheet(wb);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("S1");
    expect(sheets[0].rows[0].cells[0].text).toBe("Name");
    expect(sheets[0].rows[0].cells[1].text).toBe("Qty");
    expect(sheets[0].rows[1].cells[0].text).toBe("Apple");
    expect(sheets[0].rows[1].cells[1].text).toBe("3");
  });

  it("handles an empty sheet", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    const sheets = workbookToXSpreadsheet(wb);
    expect(sheets[0].name).toBe("Empty");
    expect(Object.keys(sheets[0].rows)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `pnpm test src/lib/__tests__/xlsxData.test.ts` → FAIL (`Cannot find module '../xlsxData'`).

- [ ] **Step 4: Create `xlsxData.ts`**

```ts
import * as XLSX from "xlsx";

export interface XCell {
  text: string;
}
export interface XRow {
  cells: Record<number, XCell>;
}
export interface XSheet {
  name: string;
  rows: Record<number, XRow>;
}

export function workbookToXSpreadsheet(wb: XLSX.WorkBook): XSheet[] {
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows: Record<number, XRow> = {};
    const ref = ws["!ref"];
    if (ref !== undefined) {
      const range = XLSX.utils.decode_range(ref);
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells: Record<number, XCell> = {};
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr] as XLSX.CellObject | undefined;
          if (cell === undefined || (cell.v === undefined && cell.w === undefined)) continue;
          const text = cell.w ?? (cell.v === undefined ? "" : String(cell.v));
          cells[c - range.s.c] = { text };
        }
        if (Object.keys(cells).length > 0) {
          rows[r - range.s.r] = { cells };
        }
      }
    }
    return { name, rows };
  });
}

export function parseXlsx(bytes: Uint8Array): XSheet[] {
  const wb = XLSX.read(bytes, { type: "array" });
  return workbookToXSpreadsheet(wb);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test src/lib/__tests__/xlsxData.test.ts` (PASS). Then `pnpm exec tsc --noEmit` (0).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/xlsxData.ts src/lib/__tests__/xlsxData.test.ts
git commit -m "feat: xlsxData — SheetJS workbook to x-data-spreadsheet data (tested)"
```

---

### Task 4: `XlsxViewer` (x-data-spreadsheet grid) + route + prod-build check

**Files:**
- Modify: `package.json` (add `x-data-spreadsheet`)
- Create: `src/types/x-data-spreadsheet.d.ts` (module declaration — no shipped types)
- Create: `src/components/viewers/XlsxViewer.tsx`
- Modify: `src/components/viewers/DocViewer.tsx` (route `kind === "xlsx"`)
- Modify: `src/styles.css` (append `.doc-viewer__xlsx*`)

**Interfaces:**
- Consumes: `fs.readFileBytes`, `base64ToUint8Array`, `parseXlsx`/`XSheet` (xlsxData.ts), `x-data-spreadsheet`.
- Produces: `function XlsxViewer({ path }: { path: string }): React.JSX.Element` (read-only grid).

- [ ] **Step 1: Install + type declaration**

Run: `pnpm add x-data-spreadsheet`

Create `src/types/x-data-spreadsheet.d.ts`:

```ts
declare module "x-data-spreadsheet" {
  interface XOptions {
    mode?: "edit" | "read";
    showToolbar?: boolean;
    showGrid?: boolean;
    showContextmenu?: boolean;
    view?: { height: () => number; width: () => number };
  }
  export default class Spreadsheet {
    constructor(container: HTMLElement, options?: XOptions);
    loadData(data: unknown): this;
  }
}
declare module "x-data-spreadsheet/dist/xspreadsheet.css";
```

(If the installed version exposes richer types via a bundled `.d.ts`, delete this declaration and rely on the package's own types — verify with `pnpm exec tsc --noEmit`.)

- [ ] **Step 2: Create `XlsxViewer.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { fs } from "../../lib/fs";
import { base64ToUint8Array } from "../../lib/bytes";
import { parseXlsx } from "../../lib/xlsxData";

export function XlsxViewer({ path }: { path: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (host === null) return;
    host.innerHTML = "";
    setError(null);
    setLoading(true);

    void (async () => {
      try {
        const { base64 } = await fs.readFileBytes(path);
        const data = parseXlsx(base64ToUint8Array(base64));
        const mod = await import("x-data-spreadsheet");
        await import("x-data-spreadsheet/dist/xspreadsheet.css");
        if (cancelled) return;
        const Spreadsheet = mod.default;
        const grid = new Spreadsheet(host, {
          mode: "read",
          showToolbar: false,
          showContextmenu: false,
        });
        grid.loadData(data);
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  return (
    <div className="doc-viewer__xlsx">
      {loading ? <div className="doc-viewer__loading">로딩 중…</div> : null}
      {error !== null ? <div className="doc-viewer__error">{error}</div> : null}
      <div ref={hostRef} className="doc-viewer__xlsx-host" />
    </div>
  );
}
```

(x-data-spreadsheet is imperative: `new Spreadsheet(el, opts).loadData(sheets)`. `mode:"read"` = read-only. If the installed version's `loadData` shape rejects our data, verify with a manual smoke and adjust the `xlsxData` shape; if the library won't bundle under Vite in ~2 tries, fall back per Global Constraints to `XLSX.utils.sheet_to_html` rendered into the host `innerHTML`, and note the downgrade.)

- [ ] **Step 3: Route in `DocViewer.tsx`**

Add `import { XlsxViewer } from "./XlsxViewer";` and update the routing so `xlsx` renders `<XlsxViewer path={path} />`, leaving only `pptx` (and unknown) → `UnsupportedViewer`:

```tsx
  if (kind === "docx") return <DocxViewer path={path} />;
  if (kind === "xlsx") return <XlsxViewer path={path} />;
  if (kind === "pptx") {
    return (
      <UnsupportedViewer
        path={path}
        message="PPTX 뷰어는 아직 준비 중입니다. OS 앱으로 열 수 있어요."
      />
    );
  }
```

- [ ] **Step 4: Append CSS**

```css
.doc-viewer__xlsx { width: 100%; height: 100%; overflow: hidden; background: var(--bg-editor); position: relative; }
.doc-viewer__xlsx-host { width: 100%; height: 100%; }
.doc-viewer__xlsx-host .x-spreadsheet { height: 100%; }
```

- [ ] **Step 5: Verify + prod build + smoke**

Run: `pnpm exec tsc --noEmit` (0), `pnpm test` (all green incl. xlsxData tests), then **`pnpm build`** (confirm x-data-spreadsheet + docx-preview + xlsx bundle cleanly under Vite — this is the highest-risk integration). Then `pnpm tauri dev` → open a `.xlsx` → interactive read-only grid with sheet tabs; open a `.docx` → renders (Task 2). tsc/build must pass before commit.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/types/x-data-spreadsheet.d.ts src/components/viewers/XlsxViewer.tsx src/components/viewers/DocViewer.tsx src/styles.css
git commit -m "feat: XlsxViewer — read-only spreadsheet grid via x-data-spreadsheet + SheetJS"
```

---

## Self-Review

**Spec coverage (`2026-07-02-document-viewer.md` §11 + P2 phase):**
- P2 Excel (SheetJS parse + `x-data-spreadsheet` grid) → Tasks 3+4 ✅.
- P2 Word → Task 2 via **`docx-preview`**. Spec §11 listed `@eigenpal/docx-editor-react` first but explicitly allowed `docx-preview` as the fallback and required due-diligence; `docx-preview` is chosen because its API is stable/known, it is view-only (matches the read-only MVP), and Vite-friendly — this is the spec's documented alternative, not a conflict. `@eigenpal/docx-editor-react` remains a future swap if editing is wanted.
- P1 debt (PdfViewer worker/doc cleanup) → Task 1 ✅.
- Read-only, dynamic-import, DocViewer routing preserved → all tasks ✅.

**Placeholder scan:** No TBD/vague steps. Library-API caveats (docx-preview options, x-data-spreadsheet loadData shape/Vite bundling, pdfjs render signature) are explicit adaptation notes with concrete fallbacks (UnsupportedViewer / `sheet_to_html`), not placeholders — mirrors P1's pdfjs-v6 handling.

**Type consistency:** `XSheet`/`XRow`/`XCell` defined in `xlsxData.ts` (Task 3), consumed by `XlsxViewer` via `parseXlsx` (Task 4). `x-data-spreadsheet` `Spreadsheet` typed by the local module declaration (Task 4 Step 1). `DocxViewer`/`XlsxViewer` props `{ path: string }` match how `DocViewer` renders them. No `any` in prop types. All viewers reuse P1's `fs.readFileBytes` + `base64ToUint8Array`. DocViewer's final routing after both tasks: image→Image, pdf→Pdf, docx→Docx, xlsx→Xlsx, pptx/binary/other→Unsupported.
