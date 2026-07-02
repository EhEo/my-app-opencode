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

    void (async () => {
      let viewer: PPTXViewer | null = null;
      try {
        const { base64 } = await fs.readFileBytes(path);
        const bytes = base64ToUint8Array(base64);
        const { PPTXViewer } = await import("pptxviewjs");
        // pptxviewjs's bundled JSZip resolver checks window/globalThis first;
        // its require('jszip') path is undefined under Vite ESM and its CDN
        // fallback is unreachable in the Tauri WebView. Expose the bundled
        // jszip on globalThis so PPTX (ZIP) parsing works offline.
        const g = globalThis as { JSZip?: unknown };
        if (g.JSZip === undefined) {
          const jszip = await import("jszip");
          g.JSZip = jszip.default ?? jszip;
        }
        if (cancelled) return;
        viewer = new PPTXViewer({ canvas, slideSizeMode: "fit" });
        await viewer.loadFile(bytes);
        if (cancelled) { viewer.destroy(); return; }
        await viewer.render(canvas, { slideIndex: 0 });
        if (cancelled) { viewer.destroy(); return; }
        viewerRef.current = viewer;
        setSlideCount(viewer.getSlideCount());
        setIndex(viewer.getCurrentSlideIndex());
        setLoading(false);
      } catch (e) {
        if (viewer !== null) viewer.destroy();
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (viewerRef.current !== null) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, [path]);

  const goTo = (next: number): void => {
    const viewer = viewerRef.current;
    const canvas = canvasRef.current;
    if (viewer === null || canvas === null) return;
    if (next < 0 || next >= slideCount) return;
    void viewer.renderSlide(next, canvas).then(() => {
      setIndex(viewer.getCurrentSlideIndex());
    });
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
