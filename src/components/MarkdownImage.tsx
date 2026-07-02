import { useEffect, useState } from "react";
import { fs } from "../lib/fs";
import { resolveRelativePath } from "../lib/paths";

const IMG_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

// Renders a markdown image. Remote/data URLs load directly; a relative/local
// path is resolved against the current file's directory and loaded through the
// workspace-confined read_file_bytes command as a data URL (the webview cannot
// otherwise read local files).
export function MarkdownImage({
  src,
  alt,
  basePath,
}: {
  src?: string;
  alt?: string;
  basePath: string | null;
}): React.JSX.Element {
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    setFailed(false);
    if (src === undefined || src === "") {
      setFailed(true);
      return;
    }
    if (/^(https?:|data:)/i.test(src)) {
      setResolved(src);
      return;
    }
    if (basePath === null) {
      setFailed(true);
      return;
    }
    void (async () => {
      try {
        const abs = resolveRelativePath(basePath, src);
        const { base64 } = await fs.readFileBytes(abs);
        const dot = abs.lastIndexOf(".");
        const ext = dot >= 0 ? abs.slice(dot + 1).toLowerCase() : "";
        const mime = IMG_MIME[ext] ?? "application/octet-stream";
        if (!cancelled) setResolved(`data:${mime};base64,${base64}`);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, basePath]);

  if (failed) {
    return <span className="chat-md__img-missing">🖼️ {alt ?? src ?? "image"}</span>;
  }
  if (resolved === null) {
    return <span className="chat-md__img-loading">🖼️ …</span>;
  }
  return <img className="chat-md__img" src={resolved} alt={alt ?? ""} />;
}
