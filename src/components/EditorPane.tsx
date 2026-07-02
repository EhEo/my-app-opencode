import Editor, { OnChange, OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as monacoTypes from "monaco-editor";
import { getLanguageId } from "../lib/language";
import { ensureLanguageRegistered, monaco } from "../lib/monaco";

export interface EditorFile {
  path: string;
  content: string;
}

export interface CursorPosition {
  line: number;
  column: number;
}

interface EditorPaneProps {
  file: EditorFile | null;
  onChange: (value: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
  wrapEnabled: boolean;
  jumpRequest?: { path: string; line: number; column: number } | null;
  jumpRequestNonce?: number;
  onJumpConsumed?: () => void;
}

type MonacoEditor = monacoTypes.editor.ICodeEditor;
type MonacoTextModel = monacoTypes.editor.ITextModel;
type MonacoViewState = monacoTypes.editor.ICodeEditorViewState;

function buildModelUri(path: string): monacoTypes.Uri {
  const normalized = path.replace(/\\/g, "/");
  // encodeURI leaves `?` and `#` unescaped; in a URI those start the query /
  // fragment and would corrupt (or collide) the model URI, so escape them too.
  const encoded = encodeURI(normalized).replace(
    /[?#]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return monaco.Uri.parse("file:///" + encoded);
}

export function EditorPane({
  file,
  onChange,
  onCursorChange,
  wrapEnabled,
  jumpRequest,
  jumpRequestNonce,
  onJumpConsumed,
}: EditorPaneProps): React.JSX.Element {
  const editorRef = useRef<MonacoEditor | null>(null);
  const modelsRef = useRef<Map<string, MonacoTextModel>>(new Map());
  const viewStatesRef = useRef<Map<string, MonacoViewState | null>>(new Map());
  const activePathRef = useRef<string | null>(null);
  const wrapEnabledRef = useRef(wrapEnabled);
  const settingModelRef = useRef(false);
  const [mounted, setMounted] = useState(false);

  const handleMount: OnMount = useCallback(
    (editor, _monacoInstance) => {
      void _monacoInstance;
      editorRef.current = editor;
      editor.updateOptions({ wordWrap: wrapEnabledRef.current ? "on" : "off" });

      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
        () => {
          const action = editor.getAction("actions.find");
          if (action !== null) void action.run();
        },
      );
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH,
        () => {
          const action = editor.getAction("editor.action.replace");
          if (action !== null) void action.run();
        },
      );

      editor.onDidChangeCursorPosition((e) => {
        onCursorChange?.({
          line: e.position.lineNumber,
          column: e.position.column,
        });
      });

      setMounted(true);
    },
    [onCursorChange],
  );

  const handleChange: OnChange = useCallback(
    (value) => {
      if (settingModelRef.current) return;
      onChange(value ?? "");
    },
    [onChange],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!mounted || editor === null) return;

    if (file === null) {
      settingModelRef.current = true;
      editor.setModel(null);
      settingModelRef.current = false;
      activePathRef.current = null;
      return;
    }

    const prevPath = activePathRef.current;
    const pathChanged = prevPath !== file.path;

    if (prevPath !== null && pathChanged) {
      viewStatesRef.current.set(prevPath, editor.saveViewState());
    }

    let model = modelsRef.current.get(file.path);
    if (model !== undefined && model.isDisposed()) {
      modelsRef.current.delete(file.path);
      model = undefined;
    }
    if (model === undefined) {
      const languageId = getLanguageId(file.path);
      model = monaco.editor.createModel(
        file.content,
        languageId,
        buildModelUri(file.path),
      );
      modelsRef.current.set(file.path, model);
      void ensureLanguageRegistered(languageId);
    } else if (model.getValue() !== file.content) {
      settingModelRef.current = true;
      model.setValue(file.content);
      settingModelRef.current = false;
    }

    if (editor.getModel() !== model) {
      settingModelRef.current = true;
      editor.setModel(model);
      settingModelRef.current = false;
    }

    // Only restore view state and steal focus when switching to a different
    // file. Re-running on unrelated App re-renders (git polling, mtime watch)
    // must NOT refocus the editor — that was stealing focus from the chat input.
    if (pathChanged) {
      const stored = viewStatesRef.current.get(file.path);
      if (stored !== undefined) {
        editor.restoreViewState(stored);
      }
      editor.focus();
    }

    activePathRef.current = file.path;
  }, [file?.path, file?.content, mounted]);

  useEffect(() => {
    wrapEnabledRef.current = wrapEnabled;
    const editor = editorRef.current;
    if (editor !== null) {
      editor.updateOptions({ wordWrap: wrapEnabled ? "on" : "off" });
    }
  }, [wrapEnabled]);

  useEffect(() => {
    return () => {
      for (const model of modelsRef.current.values()) {
        model.dispose();
      }
      modelsRef.current.clear();
      viewStatesRef.current.clear();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (jumpRequestNonce === 0) return;
    if (file === null) return;
    const request: { path: string; line: number; column: number } | null | undefined =
      jumpRequest;
    if (request === null || request === undefined) return;
    if (file.path !== request.path) return;
    const editor = editorRef.current;
    if (editor === null) return;
    const model = editor.getModel();
    if (model === null) return;
    const lineCount = model.getLineCount();
    const targetLine = Math.max(1, Math.min(request.line, lineCount));
    const maxColumn = model.getLineMaxColumn(targetLine);
    const targetColumn = Math.max(1, Math.min(request.column, maxColumn));
    editor.setPosition({ lineNumber: targetLine, column: targetColumn });
    editor.revealPositionInCenter({ lineNumber: targetLine, column: targetColumn });
    editor.focus();
    onJumpConsumed?.();
  }, [jumpRequestNonce, jumpRequest, file, onJumpConsumed]);

  // The Monaco <Editor> stays mounted even with no file open (empty state is an
  // overlay). Unmounting/remounting it — which is what a `file === null` early
  // return did — disposed the editor and left a stale ref, crashing on reopen.
  return (
    <section className="editor-pane">
      <Editor
        height="100%"
        width="100%"
        theme="opencode-dark"
        onMount={handleMount}
        onChange={handleChange}
        options={{
          minimap: { enabled: true },
          fontSize: 14,
          fontLigatures: true,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: wrapEnabled ? "on" : "off",
          scrollBeyondLastLine: false,
          renderWhitespace: "selection",
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          padding: { top: 8, bottom: 8 },
        }}
      />
      {file === null ? (
        <div className="editor-pane__empty-state">
          <div className="editor-pane__empty-glyph" aria-hidden="true">
            <svg
              width="64"
              height="64"
              viewBox="0 0 64 64"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M14 8h26l14 14v34a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z"
                stroke="#5a5d5e"
                strokeWidth="1.5"
                fill="none"
              />
              <path
                d="M40 8v14h14"
                stroke="#5a5d5e"
                strokeWidth="1.5"
                fill="none"
              />
            </svg>
          </div>
          <h2 className="editor-pane__empty-title">
            Open a folder to get started
          </h2>
          <p className="editor-pane__empty-sub">
            Use the Open Folder button in the title bar.
          </p>
        </div>
      ) : null}
    </section>
  );
}
