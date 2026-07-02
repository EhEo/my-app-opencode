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
