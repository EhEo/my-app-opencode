// Tells an agent which files are open in the editor so "modify this file" /
// "the open file" resolves to a concrete workspace-relative path it can
// read_file. Shared by the chat panel and the pipeline panel.
export function buildOpenFilesContext(
  root: string | null,
  active: string | null,
  open: string[],
): string {
  if (root === null || open.length === 0) return "";
  const nr = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const toRel = (abs: string): string => {
    const na = abs.replace(/\\/g, "/");
    return na.toLowerCase().startsWith(nr.toLowerCase() + "/")
      ? na.slice(nr.length + 1)
      : na;
  };
  const lines = open.map((p) => {
    const rel = toRel(p);
    return p === active
      ? `- ${rel}  (ACTIVE — the file the user is currently viewing)`
      : `- ${rel}`;
  });
  return (
    "\n\nThe user currently has these files open in the editor " +
    "(workspace-relative paths):\n" +
    lines.join("\n") +
    '\n\nWhen the user says "this file", "the open file", "the current file", ' +
    'or "the file I\'m looking at" without naming a path, they mean the ACTIVE ' +
    "file above. Use the read_file tool to read it before editing. Note that " +
    "read_file returns the last saved version on disk, not unsaved editor edits."
  );
}
