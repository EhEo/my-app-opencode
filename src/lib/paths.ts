// Resolve a markdown link/image href (relative or absolute) against the
// directory of the currently-open file, preserving `fromFile`'s separator
// style (Windows uses backslashes). Any query/anchor suffix is stripped.
export function resolveRelativePath(fromFile: string, href: string): string {
  const clean = href.replace(/[?#].*$/, "");
  const isWin = fromFile.includes("\\");
  const norm = fromFile.replace(/\\/g, "/");
  const dir = norm.slice(0, norm.lastIndexOf("/"));
  const combined = clean.startsWith("/") ? clean : `${dir}/${clean}`;
  const out: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  let result = out.join("/");
  if (combined.startsWith("/")) result = `/${result}`;
  return isWin ? result.replace(/\//g, "\\") : result;
}
