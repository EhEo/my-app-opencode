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
