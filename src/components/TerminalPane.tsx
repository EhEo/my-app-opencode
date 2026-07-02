import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  createSession,
  killSession,
  resizeSession,
  writeSession,
} from "../lib/terminal";

interface TerminalPaneProps {
  cwd: string | null;
}

export function TerminalPane({ cwd }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const onDataUnsubRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#aeafad",
        cursorAccent: "#1e1e1e",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f48771",
        green: "#7cb342",
        yellow: "#cca700",
        blue: "#4fc3f7",
        magenta: "#c586c0",
        cyan: "#4ec9b0",
        white: "#d4d4d4",
        brightBlack: "#858585",
        brightRed: "#f48771",
        brightGreen: "#7cb342",
        brightYellow: "#cca700",
        brightBlue: "#4fc3f7",
        brightMagenta: "#c586c0",
        brightCyan: "#4ec9b0",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let currentSessionId: string | null = null;

    const onDataDisposable = term.onData((data) => {
      void (async () => {
        if (currentSessionId === null) return;
        try {
          await writeSession(currentSessionId, data);
        } catch {
          void 0;
        }
      })();
    });
    onDataUnsubRef.current = onDataDisposable;

    // Size the PTY from the actual fitted grid, not a hardcoded px estimate.
    fit.fit();
    const initialCols = term.cols;
    const initialRows = term.rows;

    void (async () => {
      try {
        const sid = await createSession(cwd, initialCols, initialRows, {
          onData: (bytes) => {
            if (disposed) return;
            // Feed raw bytes so xterm's stateful UTF-8 decoder handles
            // multibyte chars split across chunk boundaries (한글/이모지).
            term.write(bytes);
          },
          onExit: (code) => {
            if (disposed) return;
            currentSessionId = null;
            sessionIdRef.current = null;
            term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
          },
        });
        if (disposed) {
          void killSession(sid).catch(() => {});
          return;
        }
        currentSessionId = sid;
        sessionIdRef.current = sid;
        // Resync the PTY to the fitted grid — the initial size can drift before
        // the first ResizeObserver callback fires.
        try {
          await resizeSession(sid, term.cols, term.rows);
        } catch {
          void 0;
        }
      } catch (e) {
        if (disposed) return;
        const msg = e instanceof Error ? e.message : String(e);
        term.write(`\r\n\x1b[31m[terminal error: ${msg}]\x1b[0m\r\n`);
      }
    })();

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        void 0;
      }
      const cols = term.cols;
      const rows = term.rows;
      const sid = sessionIdRef.current;
      if (sid === null) return;
      void (async () => {
        try {
          await resizeSession(sid, cols, rows);
        } catch {
          void 0;
        }
      })();
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      onDataUnsubRef.current?.dispose();
      onDataUnsubRef.current = null;
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      if (sid !== null) {
        // May already be gone (shell exited on its own); ignore the rejection.
        void killSession(sid).catch(() => {});
      }
      term.dispose();
    };
  }, [cwd]);

  return <div ref={containerRef} className="terminal-pane" />;
}