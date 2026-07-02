# Document Viewer P1 (bytes + image + markdown + PDF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the editor open image, PDF, and Markdown-preview files in-pane (Monaco is bypassed for binaries), plus the foundation (`read_file_bytes`, `fileKind`, `DocViewer`) the later Office viewers build on. Binary/office/unsupported files that aren't handled in P1 fall back to an "open in OS app" viewer.

**Architecture:** A new Rust command `read_file_bytes` returns base64 for binary files. Frontend `fileKind(path)` routes by extension. `DocViewer` (rendered as an overlay above the always-mounted Monaco `<Editor>`) dispatches to `ImageViewer` / `PdfViewer` / `UnsupportedViewer`. Markdown stays a normal editable text tab with a preview toggle added to `EditorPane`. `App` marks tabs `kind: "text" | "viewer"`; viewer tabs are read-only and skip save/dirty/watch.

**Tech Stack:** Rust + `base64` crate; React 19 + TS; `pdfjs-dist` (new dep, dynamic-imported); existing `react-markdown`; `@tauri-apps/plugin-opener` (already a dep) for the fallback; vitest for pure-logic tests.

## Global Constraints

- Do not break existing text/code editing. Monaco `<Editor>` must stay always-mounted (do not reintroduce unmount-on-empty — the DocViewer is an OVERLAY, not a replacement of EditorPane).
- Viewer tabs are READ-ONLY: no save (Ctrl+S no-op / disabled), `dirty` always false, excluded from the external-change mtime watcher.
- `read_file_bytes` confined to the workspace via `validate_path`; size cap `MAX_VIEW_BYTES = 25_000_000`; over-cap returns a clear error.
- Heavy libs (`pdfjs-dist`) loaded via dynamic `import()` (code-splitting), never top-level.
- TypeScript strict, `noUnusedLocals`, no `any` in exported/prop types. Rust: compiles on Windows + non-Windows; new command uses `rename_all = "camelCase"` and is registered in `generate_handler!`.
- Verify gate per task: `pnpm test` green + `pnpm exec tsc --noEmit` exit 0 (+ `cargo test`/`cargo check` for the Rust task; + manual smoke where noted).

---

### Task 1: `fileKind.ts` — route files by extension

**Files:**
- Create: `src/lib/fileKind.ts`
- Create: `src/lib/__tests__/fileKind.test.ts`

**Interfaces:**
- Produces: `type FileKind = "text" | "image" | "markdown" | "pdf" | "docx" | "xlsx" | "pptx" | "binary"`; `function fileKind(path: string): FileKind`.
- Rules: lowercased extension. image = png/jpg/jpeg/gif/svg/webp/bmp/ico; markdown = md/markdown; pdf; docx; xlsx; pptx; a known-binary set (zip/gz/tar/exe/dll/bin/wasm/mp3/mp4/mov/woff/woff2/ttf/otf/class/jar/o/so/dylib) = binary; everything else = text.

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/fileKind.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fileKind } from "../fileKind";

describe("fileKind", () => {
  it("classifies images", () => {
    expect(fileKind("a/b/pic.PNG")).toBe("image");
    expect(fileKind("x.svg")).toBe("image");
  });
  it("classifies documents", () => {
    expect(fileKind("r.pdf")).toBe("pdf");
    expect(fileKind("d.docx")).toBe("docx");
    expect(fileKind("s.xlsx")).toBe("xlsx");
    expect(fileKind("p.pptx")).toBe("pptx");
  });
  it("classifies markdown", () => {
    expect(fileKind("README.md")).toBe("markdown");
  });
  it("classifies known binaries", () => {
    expect(fileKind("a.zip")).toBe("binary");
    expect(fileKind("v.mp4")).toBe("binary");
  });
  it("defaults source/unknown to text", () => {
    expect(fileKind("src/App.tsx")).toBe("text");
    expect(fileKind("noext")).toBe("text");
    expect(fileKind("data.json")).toBe("text");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/fileKind.test.ts` → FAIL (`Cannot find module '../fileKind'`).

- [ ] **Step 3: Create `fileKind.ts`**

```ts
export type FileKind =
  | "text"
  | "image"
  | "markdown"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "binary";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]);
const BINARY = new Set([
  "zip", "gz", "tar", "exe", "dll", "bin", "wasm", "mp3", "mp4", "mov",
  "woff", "woff2", "ttf", "otf", "class", "jar", "o", "so", "dylib",
]);

export function fileKind(path: string): FileKind {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx") return "xlsx";
  if (ext === "pptx") return "pptx";
  if (IMAGE.has(ext)) return "image";
  if (BINARY.has(ext)) return "binary";
  return "text";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/fileKind.test.ts` → PASS. Then `pnpm exec tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fileKind.ts src/lib/__tests__/fileKind.test.ts
git commit -m "feat: fileKind — classify files by extension for viewer routing"
```

---

### Task 2: Rust `read_file_bytes`

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `base64`)
- Modify: `src-tauri/src/lib.rs` (add `FileBytes`, `read_file_bytes`, register; a test)

**Interfaces:**
- Produces: `read_file_bytes(path) -> { base64: String, size: u64 }` (camelCase). Workspace-confined via `validate_path`, 25MB cap.

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml` under `[dependencies]` add:

```toml
base64 = "0.22"
```

(`base64` is already in the lockfile transitively, so this adds no new download.)

- [ ] **Step 2: Write the failing test**

At the end of `src-tauri/src/lib.rs`:

```rust
#[cfg(test)]
mod file_bytes_tests {
    #[test]
    fn base64_round_trips() {
        use base64::Engine;
        let enc = base64::engine::general_purpose::STANDARD.encode(b"hi");
        assert_eq!(enc, "aGk=");
        let dec = base64::engine::general_purpose::STANDARD.decode("aGk=").unwrap();
        assert_eq!(dec, b"hi");
    }
}
```

- [ ] **Step 3: Run to verify fail**

Run: `cd src-tauri && cargo test file_bytes_tests`
Expected: FAIL to compile — `base64` not resolvable until added / used.

- [ ] **Step 4: Add the command**

Add near `read_file` in `lib.rs`:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileBytes {
    base64: String,
    size: u64,
}

const MAX_VIEW_BYTES: u64 = 25_000_000;

#[tauri::command(rename_all = "camelCase")]
fn read_file_bytes(path: String, state: State<'_, AppState>) -> Result<FileBytes, String> {
    let root = require_root(&state)?;
    let target = validate_path(&path, &root)?;
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.len() > MAX_VIEW_BYTES {
        return Err(format!(
            "file is too large to view ({} bytes, limit {MAX_VIEW_BYTES})",
            meta.len()
        ));
    }
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    use base64::Engine;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(FileBytes {
        base64,
        size: meta.len(),
    })
}
```

Add `read_file_bytes,` to the `tauri::generate_handler![...]` list in `run()`.

- [ ] **Step 5: Verify**

Run: `cd src-tauri && cargo test file_bytes_tests` (PASS) then `cargo check` (exit 0).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat: read_file_bytes command — base64 file bytes for the document viewer"
```

---

### Task 3: `bytes.ts` (base64 decode) + `fs.readFileBytes`

**Files:**
- Create: `src/lib/bytes.ts`
- Create: `src/lib/__tests__/bytes.test.ts`
- Modify: `src/lib/fs.ts` (add `readFileBytes`)

**Interfaces:**
- Produces: `function base64ToUint8Array(b64: string): Uint8Array`; `fs.readFileBytes(path): Promise<{ base64: string; size: number }>`.

- [ ] **Step 1: Write failing test**

Create `src/lib/__tests__/bytes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { base64ToUint8Array } from "../bytes";

describe("base64ToUint8Array", () => {
  it("decodes base64 to bytes", () => {
    const out = base64ToUint8Array("aGk="); // "hi"
    expect(Array.from(out)).toEqual([104, 105]);
  });
  it("handles empty", () => {
    expect(base64ToUint8Array("").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/bytes.test.ts` → FAIL (`Cannot find module '../bytes'`).

- [ ] **Step 3: Create `bytes.ts` and extend `fs.ts`**

Create `src/lib/bytes.ts`:

```ts
export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}
```

In `src/lib/fs.ts`, add to the `fs` object:

```ts
  readFileBytes: (path: string): Promise<{ base64: string; size: number }> =>
    invoke<{ base64: string; size: number }>("read_file_bytes", { path }),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/bytes.test.ts` (PASS). Then `pnpm exec tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bytes.ts src/lib/__tests__/bytes.test.ts src/lib/fs.ts
git commit -m "feat: base64ToUint8Array + fs.readFileBytes"
```

---

### Task 4: Viewers — `DocViewer` dispatcher + Image / PDF / Unsupported

**Files:**
- Create: `src/components/viewers/DocViewer.tsx`, `ImageViewer.tsx`, `PdfViewer.tsx`, `UnsupportedViewer.tsx`, `openExternally.ts`
- Modify: `package.json` (add `pdfjs-dist`)
- Modify: `src/styles.css` (append `.doc-viewer*`)

**Interfaces:**
- Consumes: `fileKind`/`FileKind` (fileKind.ts), `fs.readFileBytes`, `base64ToUint8Array` (bytes.ts).
- Produces: `function DocViewer({ path, kind }: { path: string; kind: FileKind }): React.JSX.Element` — renders the right sub-viewer; image/pdf handled here, docx/xlsx/pptx/binary → `UnsupportedViewer` (P1; real Office viewers arrive P2/P3). `openInOsApp(path): Promise<void>`.

- [ ] **Step 1: Install pdfjs-dist**

Run: `pnpm add pdfjs-dist`

- [ ] **Step 2: Create `openExternally.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

// Open a workspace-relative or absolute path in the OS default app.
export async function openInOsApp(path: string): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    const fn =
      (mod as { openPath?: (p: string) => Promise<void> }).openPath ??
      (mod as { open?: (p: string) => Promise<void> }).open;
    if (typeof fn === "function") await fn(path);
  } catch {
    void 0;
  }
}
```

- [ ] **Step 3: Create `UnsupportedViewer.tsx`**

```tsx
import { openInOsApp } from "./openExternally";

export function UnsupportedViewer({
  path,
  message,
}: {
  path: string;
  message: string;
}): React.JSX.Element {
  return (
    <div className="doc-viewer__unsupported">
      <p>{message}</p>
      <button type="button" className="toolbar__btn" onClick={() => void openInOsApp(path)}>
        OS 기본 앱으로 열기
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Create `ImageViewer.tsx`**

```tsx
import { useEffect, useState } from "react";
import { fs } from "../../lib/fs";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
};

export function ImageViewer({ path }: { path: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    void (async () => {
      try {
        const { base64 } = await fs.readFileBytes(path);
        const dot = path.lastIndexOf(".");
        const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
        const mime = MIME[ext] ?? "application/octet-stream";
        if (!cancelled) setSrc(`data:${mime};base64,${base64}`);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [path]);
  if (error !== null) return <div className="doc-viewer__error">{error}</div>;
  if (src === null) return <div className="doc-viewer__loading">로딩 중…</div>;
  return (
    <div className="doc-viewer__image-wrap">
      <img className="doc-viewer__image" src={src} alt={path} />
    </div>
  );
}
```

- [ ] **Step 5: Create `PdfViewer.tsx`**

Note: `pdfjs-dist` v4 render API is used below. If `pnpm exec tsc --noEmit` or runtime flags an API mismatch for the installed version, adjust the `getViewport`/`render` call to match that version's types (keep the byte-loading + per-page canvas structure).

```tsx
import { useEffect, useRef, useState } from "react";
import { fs } from "../../lib/fs";
import { base64ToUint8Array } from "../../lib/bytes";

export function PdfViewer({ path }: { path: string }): React.JSX.Element {
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
        const pdfjs = await import("pdfjs-dist");
        const WorkerMod = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker");
        pdfjs.GlobalWorkerOptions.workerPort = new WorkerMod.default();
        const doc = await pdfjs.getDocument({ data }).promise;
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
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
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
    <div className="doc-viewer__pdf">
      {loading ? <div className="doc-viewer__loading">로딩 중…</div> : null}
      {error !== null ? <div className="doc-viewer__error">{error}</div> : null}
      <div ref={containerRef} className="doc-viewer__pdf-pages" />
    </div>
  );
}
```

- [ ] **Step 6: Create `DocViewer.tsx`**

```tsx
import type { FileKind } from "../../lib/fileKind";
import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";
import { UnsupportedViewer } from "./UnsupportedViewer";

export function DocViewer({
  path,
  kind,
}: {
  path: string;
  kind: FileKind;
}): React.JSX.Element {
  if (kind === "image") return <ImageViewer path={path} />;
  if (kind === "pdf") return <PdfViewer path={path} />;
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    return (
      <UnsupportedViewer
        path={path}
        message={`${kind.toUpperCase()} 뷰어는 아직 준비 중입니다. OS 앱으로 열 수 있어요.`}
      />
    );
  }
  return <UnsupportedViewer path={path} message="이 파일은 미리보기를 지원하지 않습니다." />;
}
```

- [ ] **Step 7: Append CSS**

```css
.doc-viewer__loading, .doc-viewer__error, .doc-viewer__unsupported {
  padding: 16px; color: var(--text-muted); font-size: 13px;
}
.doc-viewer__error { color: var(--danger); white-space: pre-wrap; }
.doc-viewer__unsupported { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.doc-viewer__image-wrap { width: 100%; height: 100%; overflow: auto; display: flex; align-items: center; justify-content: center; background: var(--bg-editor); }
.doc-viewer__image { max-width: 100%; max-height: 100%; object-fit: contain; }
.doc-viewer__pdf { width: 100%; height: 100%; overflow: auto; background: #2a2a2a; }
.doc-viewer__pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px; }
.doc-viewer__pdf-page { max-width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,0.4); background: #fff; }
```

- [ ] **Step 8: Verify build**

Run: `pnpm exec tsc --noEmit` (0) and `pnpm test` (still green). Components are not yet wired (Task 6) — an unused-import warning is not expected since each file uses its imports.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/components/viewers src/styles.css
git commit -m "feat: DocViewer + Image/PDF/Unsupported viewers (pdfjs dynamic import)"
```

---

### Task 5: Markdown preview toggle in `EditorPane`

**Files:**
- Modify: `src/components/EditorPane.tsx`
- Modify: `src/styles.css` (append `.editor-pane__preview*`)

**Interfaces:**
- Consumes: `react-markdown` (already used by ChatPanel), `getLanguageId`/existing EditorPane props.
- Produces: When the open file is Markdown, a "미리보기/편집" toggle button appears; preview mode overlays a rendered view of the CURRENT editor content over Monaco. Non-markdown files: no toggle, unchanged.

- [ ] **Step 1: Add the toggle + preview overlay**

In `src/components/EditorPane.tsx`:
1. Add import: `import Markdown from "react-markdown";`
2. Add `const [preview, setPreview] = useState(false);` near other state.
3. Compute `const isMarkdown = file !== null && /\.(md|markdown)$/i.test(file.path);`. When `file` becomes null or a non-markdown file, reset preview: add
   ```tsx
   useEffect(() => { if (!isMarkdown) setPreview(false); }, [isMarkdown]);
   ```
4. In the returned `<section className="editor-pane">`, after the `<Editor .../>`, add (inside the section):
   ```tsx
   {isMarkdown ? (
     <button
       type="button"
       className="editor-pane__preview-toggle toolbar__btn"
       onClick={() => setPreview((v) => !v)}
       title={preview ? "편집으로" : "미리보기"}
     >
       {preview ? "편집" : "미리보기"}
     </button>
   ) : null}
   {isMarkdown && preview && file !== null ? (
     <div className="editor-pane__preview">
       <div className="chat-md">
         <Markdown>{file.content}</Markdown>
       </div>
     </div>
   ) : null}
   ```
   (The preview reads `file.content`, which App keeps in sync with the Monaco buffer via `onChange`.)

- [ ] **Step 2: Append CSS**

```css
.editor-pane__preview-toggle { position: absolute; top: 8px; right: 16px; z-index: 3; height: 22px; padding: 0 8px; font-size: 11px; }
.editor-pane__preview { position: absolute; inset: 0; z-index: 2; overflow: auto; padding: 16px 24px; background: var(--bg-editor); }
```

- [ ] **Step 3: Verify build**

Run: `pnpm exec tsc --noEmit` (0), `pnpm test` (green).

- [ ] **Step 4: Manual smoke**

`pnpm tauri dev` → open a `.md` file → a "미리보기" button shows top-right → toggling renders the markdown / returns to Monaco. Editing in Monaco then previewing shows the latest text. Non-`.md` files show no toggle.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorPane.tsx src/styles.css
git commit -m "feat: Markdown edit/preview toggle in EditorPane"
```

---

### Task 6: App integration — tab kind, viewer routing, read-only, DocViewer overlay

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `fileKind` (fileKind.ts), `DocViewer` (viewers/DocViewer.tsx).
- Produces: opening an image/pdf/docx/xlsx/pptx/binary file creates a `kind: "viewer"` tab (no text read); the editor column shows `DocViewer` as an overlay above Monaco for the active viewer tab; text/markdown open as before; viewer tabs are read-only.

- [ ] **Step 1: Extend the tab model + open routing**

In `src/App.tsx`:
1. Imports: `import { fileKind } from "./lib/fileKind";` and `import { DocViewer } from "./components/viewers/DocViewer";`.
2. Change `interface TabState { content: string; dirty: boolean; }` to:
   ```ts
   interface TabState { content: string; dirty: boolean; kind: "text" | "viewer"; }
   ```
3. In `handleOpenFile`, branch by kind. Replace the body with:
   ```ts
   if (tabs[path] !== undefined) {
     setActivePath(path);
     return;
   }
   const kind = fileKind(path);
   if (kind === "text" || kind === "markdown") {
     try {
       const content = await fs.readFile(path);
       setTabs((prev) => ({ ...prev, [path]: { content, dirty: false, kind: "text" } }));
       if (!tabsOrderRef.current.includes(path)) {
         tabsOrderRef.current = [...tabsOrderRef.current, path];
       }
       setActivePath(path);
     } catch (e) {
       const msg = e instanceof Error ? e.message : String(e);
       window.alert(`Failed to open ${getFileName(path)}: ${msg}`);
     }
   } else {
     // image/pdf/docx/xlsx/pptx/binary → viewer tab (no text read)
     setTabs((prev) => ({ ...prev, [path]: { content: "", dirty: false, kind: "viewer" } }));
     if (!tabsOrderRef.current.includes(path)) {
       tabsOrderRef.current = [...tabsOrderRef.current, path];
     }
     setActivePath(path);
   }
   ```
   (All other places that create a tab — none besides this — keep `kind: "text"`.)

- [ ] **Step 2: Gate active-file / save / watcher on kind**

1. Compute the active tab kind and a viewer flag:
   ```ts
   const activeIsViewer = activeTab?.kind === "viewer";
   ```
2. `activeFile` must be null for viewer tabs so Monaco stays idle:
   ```ts
   const activeFile: EditorFile | null =
     activePath !== null && activeTab !== null && !activeIsViewer
       ? { path: activePath, content: activeTab.content }
       : null;
   ```
3. `handleSave`: early-return for viewer tabs — at the top add `if (activeTab?.kind === "viewer") return;` (before reading `tab.content`).
4. The mtime external-change watcher effect: skip viewer tabs. At the top of the `tick` (or the effect), guard: `if (tabs[watched]?.kind === "viewer") return;` — simplest: in the effect, `if (activeTab?.kind === "viewer") return;` before starting the interval (add `activeTab` to a ref if needed, or gate inside tick using `tabsRef`). Minimal: inside `tick`, after `if (disposed) return;`, add a check via a ref to the current tabs kind. Use the existing `tabs` closure: since the watcher effect deps are `[activePath]`, capture the kind at effect start: `const isViewer = tabs[watched]?.kind === "viewer"; if (isViewer) return;` right after `const watched = activePath;`.

- [ ] **Step 3: Render DocViewer overlay in the editor column**

In the editor-column body, keep `<EditorPane .../>` as-is and add the overlay after it:
```tsx
<div className="editor-column__body">
  <EditorPane
    file={activeFile}
    onChange={handleEditorChange}
    onCursorChange={handleCursorChange}
    wrapEnabled={wrapEnabled}
    jumpRequest={jumpCounter === 0 ? null : jumpRequestRef.current}
    jumpRequestNonce={jumpCounter}
    onJumpConsumed={() => { jumpRequestRef.current = null; }}
  />
  {activeIsViewer && activePath !== null ? (
    <div className="editor-column__viewer">
      <DocViewer path={activePath} kind={fileKind(activePath)} />
    </div>
  ) : null}
</div>
```

- [ ] **Step 4: Append CSS**

```css
.editor-column__body { position: relative; }
.editor-column__viewer { position: absolute; inset: 0; z-index: 4; background: var(--bg-editor); }
```
(If `.editor-column__body` already has rules, add only `position: relative;` to it.)

- [ ] **Step 5: Verify build + manual smoke**

Run: `pnpm exec tsc --noEmit` (0), `pnpm test` (green). Then `pnpm tauri dev`:
- Open a `.png` → image shows in the editor area.
- Open a `.pdf` → pages render.
- Open a `.txt`/`.tsx` → Monaco as before (editable, savable).
- Open a `.md` → Monaco + preview toggle (Task 5).
- Open a viewer file then a text file (tab switch) → Monaco does NOT crash and edits/saves normally; viewer overlay only shows on the viewer tab.
- Ctrl+S on a viewer tab → no-op (no error).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/styles.css
git commit -m "feat: route binary/doc files to DocViewer (read-only viewer tabs) with Monaco overlay"
```

---

## Self-Review

**Spec coverage (P1 slice of `2026-07-02-document-viewer.md`):**
- §3 `read_file_bytes` → Task 2 ✅; `fs.readFileBytes` + base64 decode → Task 3 ✅.
- §4 `fileKind` routing → Task 1 ✅.
- §5 `DocViewer` + ImageViewer + PdfViewer + Unsupported + openExternally → Task 4 ✅; MarkdownPreview → Task 5 (as an EditorPane toggle, per design "편집↔미리보기 토글") ✅.
- §6 tab `kind`, open routing, read-only (save/dirty/watcher gated), Monaco-overlay render (keeps `<Editor>` mounted) → Task 6 ✅.
- §7 error/loading/fallback states → Tasks 4/5 (loading spinners, error divs, UnsupportedViewer OS-open) ✅.
- Deferred to P2/P3 (explicit): docx/xlsx real render (P2), pptx best-effort (P3) — P1 routes them to UnsupportedViewer.

**Placeholder scan:** No TBD/vague steps. PdfViewer carries an explicit version-caveat note (pdfjs render API varies) — this is guidance, not a placeholder; the byte-load + per-page-canvas structure is complete.

**Type consistency:** `FileKind` (Task 1) consumed by `DocViewer` (Task 4) and `App` (Task 6) identically. `fs.readFileBytes` return `{base64,size}` matches the Rust `FileBytes` (Task 2) and `base64ToUint8Array` input (Task 3). `TabState.kind: "text"|"viewer"` (Task 6) used consistently in `activeFile`/`handleSave`/watcher/render. No `any` in prop types. Monaco stays always-mounted (overlay approach) per the Global Constraint — the earlier reopen-crash fix is preserved.
