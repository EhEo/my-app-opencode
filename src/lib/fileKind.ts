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
