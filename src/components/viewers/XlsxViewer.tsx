import { useEffect, useRef, useState } from "react";
import { fs } from "../../lib/fs";
import { base64ToUint8Array } from "../../lib/bytes";

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
        const { parseXlsx } = await import("../../lib/xlsxData");
        const data = await parseXlsx(base64ToUint8Array(base64));
        const mod = await import("x-data-spreadsheet");
        await import("x-data-spreadsheet/dist/xspreadsheet.css");
        if (cancelled) return;
        const Spreadsheet = mod.default;
        const grid = new Spreadsheet(host, {
          mode: "read",
          showToolbar: false,
          showContextmenu: false,
          view: { height: () => host.clientHeight, width: () => host.clientWidth },
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
    return () => {
      cancelled = true;
      if (host !== null) host.innerHTML = "";
    };
  }, [path]);

  return (
    <div className="doc-viewer__xlsx">
      {loading ? <div className="doc-viewer__loading">로딩 중…</div> : null}
      {error !== null ? <div className="doc-viewer__error">{error}</div> : null}
      <div ref={hostRef} className="doc-viewer__xlsx-host" />
    </div>
  );
}
