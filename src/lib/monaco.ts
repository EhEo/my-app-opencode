import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

loader.config({ monaco });

const editorWorker = new EditorWorker();

self.MonacoEnvironment = {
  getWorker(_workerId: string, _label: string): Worker {
    void _workerId;
    void _label;
    return editorWorker;
  },
};

monaco.editor.defineTheme("opencode-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "editorLineNumber.foreground": "#858585",
    "editorLineNumber.activeForeground": "#c6c6c6",
    "editorCursor.foreground": "#aeafad",
    "editor.lineHighlightBackground": "#2a2d2e",
    "editor.selectionBackground": "#264f78",
    "editor.inactiveSelectionBackground": "#3a3d41",
    "editorIndentGuide.background": "#404040",
    "editorIndentGuide.activeBackground": "#707070",
    "editorWhitespace.foreground": "#404040",
    "editorBracketMatch.background": "#2a2d2e",
    "editorBracketMatch.border": "#888888",
  },
});

const LANGUAGE_CONTRIBUTIONS: Record<string, () => Promise<unknown>> = {
  typescript: () =>
    import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
  typescriptreact: () =>
    import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
  javascript: () =>
    import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
  javascriptreact: () =>
    import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
  json: () =>
    import("monaco-editor/esm/vs/language/json/monaco.contribution"),
  css: () =>
    import("monaco-editor/esm/vs/language/css/monaco.contribution"),
  scss: () =>
    import("monaco-editor/esm/vs/language/css/monaco.contribution"),
  less: () =>
    import("monaco-editor/esm/vs/language/css/monaco.contribution"),
  html: () =>
    import("monaco-editor/esm/vs/language/html/monaco.contribution"),
  xml: () =>
    import("monaco-editor/esm/vs/language/html/monaco.contribution"),
};

const registered = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

export async function ensureLanguageRegistered(
  langId: string,
): Promise<void> {
  if (langId === "" || langId === "plaintext") return;
  if (registered.has(langId)) return;
  let pending = inFlight.get(langId);
  if (pending === undefined) {
    const loader = LANGUAGE_CONTRIBUTIONS[langId];
    if (loader === undefined) return;
    pending = loader()
      .then(() => {
        registered.add(langId);
      })
      .catch(() => {
        void 0;
      });
    inFlight.set(langId, pending);
  }
  await pending;
}

export { monaco };