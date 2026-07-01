// Maps file extensions (and a few filenames) to Monaco's built-in language ids.
// The id strings MUST match what `monaco-editor` ships with — they're case
// sensitive and used both for syntax highlighting and to look up the right
// tokenizer at runtime.

const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  py: "python",
  go: "go",
  toml: "ini",
  ini: "ini",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  kt: "kotlin",
  swift: "swift",
  dockerfile: "dockerfile",
  vue: "html",
  svelte: "html",
};

// Human-facing labels for the status bar. Keyed on Monaco language id.
const LABEL_MAP: Record<string, string> = {
  typescript: "TypeScript",
  typescriptreact: "TypeScript JSX",
  javascript: "JavaScript",
  javascriptreact: "JavaScript JSX",
  json: "JSON",
  markdown: "Markdown",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  xml: "XML",
  python: "Python",
  go: "Go",
  yaml: "YAML",
  shell: "Shell",
  rust: "Rust",
  ini: "INI",
  sql: "SQL",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  ruby: "Ruby",
  kotlin: "Kotlin",
  swift: "Swift",
  dockerfile: "Dockerfile",
  plaintext: "Plain Text",
};

export function getLanguageId(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? "";
  if (fileName.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = fileName.lastIndexOf(".");
  if (dot === -1 || dot === fileName.length - 1) return "plaintext";
  const ext = fileName.slice(dot + 1).toLowerCase();
  return EXT_MAP[ext] ?? "plaintext";
}

export function getLanguageLabel(filePath: string): string {
  const id = getLanguageId(filePath);
  return LABEL_MAP[id] ?? id;
}

export function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}
