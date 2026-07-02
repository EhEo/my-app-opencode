import { useEffect, useRef, useState } from "react";

export function PptxViewer({ path }: { path: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await import("pptxviewjs");
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
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
