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
