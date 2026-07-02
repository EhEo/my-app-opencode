import { useEffect, useRef, useState } from "react";
import { fs } from "../../lib/fs";
import { base64ToUint8Array } from "../../lib/bytes";

export function PdfViewer({ path }: { path: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | null = null;
    let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
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
        loadingTask = pdfjs.getDocument({ data });
        doc = await loadingTask.promise;
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
      if (loadingTask !== null) void loadingTask.destroy();
      if (worker !== null) worker.terminate();
    };
  }, [path]);

  return (
    <div className="doc-viewer__pdf">
      {loading ? <div className="doc-viewer__loading">로딩 중…</div> : null}
      {error !== null ? <div className="doc-viewer__error">{error}</div> : null}
      <div ref={containerRef} className="doc-viewer__pdf-pages" />
    </div>
  );
}
