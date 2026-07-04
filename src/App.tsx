import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { Toolbar } from "./components/Toolbar";
import { FileTree } from "./components/FileTree";
import {
  EditorPane,
  type CursorPosition,
  type EditorFile,
} from "./components/EditorPane";
import { Tabs, type TabInfo } from "./components/Tabs";
import { StatusBar } from "./components/StatusBar";
import { ChatPanel } from "./components/ChatPanel";
import { TerminalPane } from "./components/TerminalPane";
import { SettingsModal } from "./components/SettingsModal";
import { SearchModal } from "./components/SearchModal";
import { fs } from "./lib/fs";
import { getFileName, getLanguageLabel } from "./lib/language";
import { loadSettings, loadProviderStore, type Settings } from "./lib/settings";
import { applyConfig as applyMcpConfig } from "./lib/mcp";
import { fileKind } from "./lib/fileKind";
import { DocViewer } from "./components/viewers/DocViewer";
import {
  applyTheme,
  loadThemeMode,
  resolveTheme,
  saveThemeMode,
  systemPrefersDark,
  type ThemeMode,
} from "./lib/theme";

interface TabState {
  content: string;
  dirty: boolean;
  kind: "text" | "viewer";
}

// Match a (possibly workspace-relative, possibly forward-slash) path against the
// absolute tab keys, case- and separator-insensitively (Windows paths differ in
// slash direction and case between the agent, git, and the OS).
function resolveOpenTabKey(
  input: string,
  tabs: Record<string, TabState>,
  rootPath: string | null,
): string | null {
  if (tabs[input] !== undefined) return input;
  const norm = (p: string): string =>
    p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const candidates = [norm(input)];
  if (rootPath !== null) {
    candidates.push(norm(rootPath + "/" + input));
  }
  for (const key of Object.keys(tabs)) {
    const nk = norm(key);
    if (candidates.includes(nk)) return key;
  }
  return null;
}

// Persisted split-pane sizes (px). Read once at mount; written on drag end.
function readLayoutPx(key: string, fallback: number): number {
  const raw = localStorage.getItem(`layout.${key}`);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Last opened workspace folder, restored on startup.
const LAST_WORKSPACE_ROOT_KEY = "lastWorkspaceRoot";

function saveLastWorkspaceRoot(path: string | null): void {
  if (path === null) {
    localStorage.removeItem(LAST_WORKSPACE_ROOT_KEY);
  } else {
    localStorage.setItem(LAST_WORKSPACE_ROOT_KEY, path);
  }
}

function clampPx(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function App(): React.JSX.Element {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Record<string, TabState>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CursorPosition | null>(null);
  const [wrapEnabled, setWrapEnabled] = useState(false);

  // Theme: dark / light / system (system follows the OS via matchMedia).
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    systemPrefersDark(),
  );
  const effectiveTheme = resolveTheme(themeMode, systemDark);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyTheme(effectiveTheme);
  }, [effectiveTheme]);

  const handleThemeModeChange = useCallback((mode: ThemeMode): void => {
    setThemeMode(mode);
    saveThemeMode(mode);
  }, []);

  // Resizable split sizes: file tree / chat panel widths, terminal height.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readLayoutPx("sidebarWidth", 260),
  );
  const [chatWidth, setChatWidth] = useState<number>(() =>
    readLayoutPx("chatWidth", 380),
  );
  const [terminalHeight, setTerminalHeight] = useState<number>(() =>
    readLayoutPx("terminalHeight", 120),
  );

  // Shared drag handler for the three pane splitters. Pointer capture routes
  // all moves to the splitter itself, so Monaco/xterm underneath never steal
  // the drag. `invert` flips the delta for panes anchored to the right/bottom.
  const startSplitterDrag = useCallback(
    (
      e: React.PointerEvent<HTMLDivElement>,
      opts: {
        axis: "x" | "y";
        start: number;
        min: number;
        max: number;
        invert?: boolean;
        key: string;
        set: (n: number) => void;
      },
    ): void => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const origin = opts.axis === "x" ? e.clientX : e.clientY;
      let latest = opts.start;
      const onMove = (ev: PointerEvent): void => {
        const pos = opts.axis === "x" ? ev.clientX : ev.clientY;
        const delta = (pos - origin) * (opts.invert === true ? -1 : 1);
        latest = clampPx(opts.start + delta, opts.min, opts.max);
        opts.set(latest);
      };
      const onUp = (): void => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        localStorage.setItem(`layout.${opts.key}`, String(Math.round(latest)));
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [],
  );

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatVisible, setChatVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [terminalShell, setTerminalShell] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [diskConflict, setDiskConflict] = useState<Record<string, boolean>>({});
  const [gitStatuses, setGitStatuses] = useState<Record<string, string>>({});
  const [fileTreeRefresh, setFileTreeRefresh] = useState(0);
  // Bumped on every settings save so PipelinePanel (which loads its own copy
  // of the store once on mount) knows to re-fetch stage config changes made
  // in the Settings modal while the panel stays mounted underneath it.
  const [pipelineRefresh, setPipelineRefresh] = useState(0);
  // Per-path mtime baseline for the external-change watcher, kept in a ref so a
  // re-render (e.g. typing) doesn't reset it and miss real external edits.
  const mtimeBaselineRef = useRef<Map<string, number>>(new Map());
  const jumpRequestRef = useRef<{
    path: string;
    line: number;
    column: number;
  } | null>(null);
  const [jumpCounter, setJumpCounter] = useState(0);

  const tabsOrderRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await loadSettings();
        if (!cancelled) {
          setSettings(s);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void msg;
        if (!cancelled) {
          setSettings(null);
        }
      }
      // Connect saved MCP servers at startup — previously they only connected
      // after the user opened the settings modal once. Also load the terminal
      // shell preference.
      try {
        const store = await loadProviderStore();
        if (!cancelled) {
          setTerminalShell(store.terminalShell ?? null);
        }
        await applyMcpConfig(store.mcp);
      } catch {
        void 0;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore the last opened folder on startup. If it no longer exists (moved
  // or deleted), fail silently and start with no folder open.
  useEffect(() => {
    const last = localStorage.getItem(LAST_WORKSPACE_ROOT_KEY);
    if (last === null) return;
    let cancelled = false;
    void (async () => {
      try {
        await fs.setWorkspaceRoot(last);
        if (!cancelled) setRootPath(last);
      } catch {
        saveLastWorkspaceRoot(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openTabs = useMemo<TabInfo[]>(() => {
    return tabsOrderRef.current
      .filter((p) => tabs[p] !== undefined)
      .map((path) => ({ path, dirty: tabs[path]?.dirty ?? false }));
  }, [tabs]);

  const activeTab = activePath !== null ? tabs[activePath] ?? null : null;
  const activeIsViewer = activeTab?.kind === "viewer";
  const activeFile: EditorFile | null =
    activePath !== null && activeTab !== null && !activeIsViewer
      ? { path: activePath, content: activeTab.content }
      : null;
  const activeDirty = activeTab?.dirty ?? false;
  const activeFileName =
    activePath !== null ? getFileName(activePath) : null;
  const activeLanguage =
    activePath !== null ? getLanguageLabel(activePath) : null;

  const handleOpenFolder = useCallback(async (): Promise<void> => {
    try {
      const picked = await fs.pickFolder();
      if (picked === null) return;
      await fs.setWorkspaceRoot(picked);
      setRootPath(picked);
      saveLastWorkspaceRoot(picked);
      setTabs({});
      setActivePath(null);
      tabsOrderRef.current = [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`Failed to open folder: ${msg}`);
    }
  }, []);

  const handleOpenFile = useCallback(
    async (path: string): Promise<void> => {
      if (tabs[path] !== undefined) {
        setActivePath(path);
        return;
      }

      const kind = fileKind(path);
      if (kind === "text" || kind === "markdown") {
        try {
          const content = await fs.readFile(path);
          setTabs((prev) => ({
            ...prev,
            [path]: { content, dirty: false, kind: "text" },
          }));
          if (!tabsOrderRef.current.includes(path)) {
            tabsOrderRef.current = [...tabsOrderRef.current, path];
          }
          setActivePath(path);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          window.alert(`Failed to open ${getFileName(path)}: ${msg}`);
        }
      } else {
        // image/pdf/docx/xlsx/pptx/binary → viewer tab (no text read)
        setTabs((prev) => ({
          ...prev,
          [path]: { content: "", dirty: false, kind: "viewer" },
        }));
        if (!tabsOrderRef.current.includes(path)) {
          tabsOrderRef.current = [...tabsOrderRef.current, path];
        }
        setActivePath(path);
      }
    },
    [tabs],
  );

  const handleEditorChange = useCallback(
    (value: string): void => {
      if (activePath === null) return;
      setTabs((prev) => {
        const existing = prev[activePath];
        if (existing === undefined) return prev;
        if (existing.content === value) return prev;
        return {
          ...prev,
          [activePath]: { ...existing, content: value, dirty: true },
        };
      });
    },
    [activePath],
  );

  const handleCursorChange = useCallback((pos: CursorPosition): void => {
    setCursor(pos);
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    if (activePath === null) return;
    const tab = tabs[activePath];
    if (tab === undefined) return;
    if (tab.kind === "viewer") return;
    const savedContent = tab.content;
    try {
      await fs.writeFile(activePath, savedContent);
      setTabs((prev) => {
        const existing = prev[activePath];
        if (existing === undefined) return prev;
        // Only clear dirty if the buffer hasn't changed since we captured it —
        // otherwise edits made during the async write would be lost silently.
        if (existing.content !== savedContent) return prev;
        return { ...prev, [activePath]: { ...existing, dirty: false } };
      });
      // Record our own write's mtime so the watcher doesn't flag it as an
      // external change on the next tick.
      try {
        const stat = await fs.statFile(activePath);
        mtimeBaselineRef.current.set(activePath, stat.mtimeMs);
      } catch {
        void 0;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`Failed to save ${getFileName(activePath)}: ${msg}`);
    }
  }, [activePath, tabs]);

  const handleSelectTab = useCallback((path: string): void => {
    setActivePath(path);
  }, []);

  const handleCloseTab = useCallback(
    (path: string): void => {
      const tab = tabs[path];
      if (tab === undefined) return;
      if (tab.dirty) {
        const ok = window.confirm(
          `Close ${getFileName(path)} without saving? Changes will be lost.`,
        );
        if (!ok) return;
      }

      setTabs((prev) => {
        if (prev[path] === undefined) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
      const closedIdx = tabsOrderRef.current.indexOf(path);
      tabsOrderRef.current = tabsOrderRef.current.filter((p) => p !== path);

      if (activePath === path) {
        const remaining = tabsOrderRef.current;
        if (remaining.length === 0) {
          setActivePath(null);
        } else {
          const fallback =
            remaining[closedIdx] ?? remaining[closedIdx - 1] ?? remaining[0] ?? null;
          setActivePath(fallback);
        }
      }
    },
    [tabs, activePath],
  );

  const handleFileChanged = useCallback(
    async (
      inputPath: string,
      opts: { force?: boolean } = {},
    ): Promise<void> => {
      // The agent reports workspace-relative paths ("src/foo.ts"); tab keys are
      // absolute. Resolve to the matching open tab key (separator-insensitive).
      const path = resolveOpenTabKey(inputPath, tabs, rootPath);
      if (path === null) return;
      if (tabs[path]?.kind === "viewer") return;
      if (opts.force !== true && tabs[path]?.dirty === true) {
        setDiskConflict((prev) => ({ ...prev, [path]: true }));
        return;
      }
      try {
        const fresh = await fs.readFile(path);
        setTabs((prev) => {
          const existing = prev[path];
          if (existing === undefined) return prev;
          if (existing.dirty === true && opts.force !== true) return prev;
          return {
            ...prev,
            [path]: { ...existing, content: fresh, dirty: false },
          };
        });
        try {
          const stat = await fs.statFile(path);
          mtimeBaselineRef.current.set(path, stat.mtimeMs);
        } catch {
          void 0;
        }
        setDiskConflict((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void msg;
      }
    },
    [tabs, rootPath],
  );

  const handleFileChangedRef = useRef(handleFileChanged);
  useEffect(() => {
    handleFileChangedRef.current = handleFileChanged;
  }, [handleFileChanged]);

  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (activePath === null) return;
    const watched = activePath;
    let disposed = false;
    const baseline = mtimeBaselineRef.current;
    const tick = async (): Promise<void> => {
      if (disposed) return;
      if (tabsRef.current[watched]?.kind === "viewer") return;
      try {
        const stat = await fs.statFile(watched);
        if (disposed) return;
        const prev = baseline.get(watched);
        if (prev === undefined) {
          baseline.set(watched, stat.mtimeMs);
        } else if (stat.mtimeMs !== prev) {
          baseline.set(watched, stat.mtimeMs);
          void handleFileChangedRef.current(watched);
        }
      } catch {
        void 0;
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 1500);
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [activePath]);

  useEffect(() => {
    if (rootPath === null) {
      setGitStatuses({});
      return;
    }
    let disposed = false;
    const refresh = async (): Promise<void> => {
      if (disposed) return;
      try {
        const list = await fs.gitStatus();
        if (disposed) return;
        const map: Record<string, string> = {};
        for (const entry of list) {
          map[entry.path] = entry.status;
        }
        setGitStatuses(map);
      } catch {
        void 0;
      }
    };
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [rootPath]);

  const handleOpenSettings = useCallback((): void => {
    setSettingsOpen(true);
  }, []);

  const handleCloseSettings = useCallback((): void => {
    setSettingsOpen(false);
  }, []);

  const handleSettingsSaved = useCallback((): void => {
    void (async () => {
      try {
        const s = await loadSettings();
        setSettings(s);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void msg;
      }
      try {
        const store = await loadProviderStore();
        setTerminalShell(store.terminalShell ?? null);
      } catch {
        void 0;
      }
      setPipelineRefresh((n) => n + 1);
    })();
  }, []);

  const handleToggleChat = useCallback((): void => {
    setChatVisible((v) => !v);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  const handleToggleWrap = useCallback((): void => {
    setWrapEnabled((v) => !v);
  }, []);

  return (
    <div
      className="app"
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--chat-width": `${chatWidth}px`,
        } as React.CSSProperties
      }
    >
      <Toolbar
        onOpenFolder={() => {
          void handleOpenFolder();
        }}
        onSave={() => {
          void handleSave();
        }}
        dirty={activeDirty}
        fileName={activeFileName}
        canSave={activeFile !== null}
        onOpenSettings={handleOpenSettings}
        onToggleChat={handleToggleChat}
        chatVisible={chatVisible}
        onToggleTerminal={() => setTerminalVisible((v) => !v)}
        terminalVisible={terminalVisible}
      />
      <div className="app__body">
        <div className="app__main">
          <FileTree
            rootPath={rootPath}
            selectedPath={activePath}
            onOpenFile={(p) => {
              void handleOpenFile(p);
            }}
            gitStatuses={gitStatuses}
            refreshToken={fileTreeRefresh}
          />
          <div
            className="splitter splitter--v"
            onPointerDown={(e) =>
              startSplitterDrag(e, {
                axis: "x",
                start: sidebarWidth,
                min: 160,
                max: 520,
                key: "sidebarWidth",
                set: setSidebarWidth,
              })
            }
          />
          <div className="editor-column">
            <Tabs
              tabs={openTabs}
              activePath={activePath}
              onSelect={handleSelectTab}
              onClose={handleCloseTab}
            />
            <div className="editor-column__body">
              <EditorPane
                file={activeFile}
                themeName={
                  effectiveTheme === "light" ? "opencode-light" : "opencode-dark"
                }
                onChange={handleEditorChange}
                onCursorChange={handleCursorChange}
                onOpenPath={(p) => {
                  void handleOpenFile(p);
                }}
                wrapEnabled={wrapEnabled}
                jumpRequest={jumpCounter === 0 ? null : jumpRequestRef.current}
                jumpRequestNonce={jumpCounter}
                onJumpConsumed={() => {
                  jumpRequestRef.current = null;
                }}
              />
              {activeIsViewer && activePath !== null ? (
                <div className="editor-column__viewer">
                  <DocViewer path={activePath} kind={fileKind(activePath)} />
                </div>
              ) : null}
            </div>
            <StatusBar
              filePath={activePath}
              language={activeLanguage}
              position={cursor}
              dirty={activeDirty}
              diskConflict={
                activePath !== null
                  ? diskConflict[activePath] === true
                  : false
              }
              onReloadFromDisk={() => {
                if (activePath !== null) {
                  void handleFileChanged(activePath, { force: true });
                }
              }}
              gitStatus={
                activePath !== null ? gitStatuses[activePath] ?? null : null
              }
              wrapEnabled={wrapEnabled}
              onToggleWrap={handleToggleWrap}
            />
          </div>
          {chatVisible ? (
            <>
              <div
                className="splitter splitter--v"
                onPointerDown={(e) =>
                  startSplitterDrag(e, {
                    axis: "x",
                    start: chatWidth,
                    min: 260,
                    max: 720,
                    invert: true,
                    key: "chatWidth",
                    set: setChatWidth,
                  })
                }
              />
              <ChatPanel
                workspaceRoot={rootPath}
                settings={settings}
                onOpenSettings={handleOpenSettings}
                activeFilePath={activePath}
                openFilePaths={openTabs.map((t) => t.path)}
                pipelineRefreshToken={pipelineRefresh}
                onFileChanged={(p) => {
                  void handleFileChanged(p);
                  setFileTreeRefresh((n) => n + 1);
                }}
              />
            </>
          ) : null}
        </div>
        {terminalVisible ? (
          <div
            className="splitter splitter--h"
            onPointerDown={(e) =>
              startSplitterDrag(e, {
                axis: "y",
                start: terminalHeight,
                min: 80,
                max: Math.round(window.innerHeight * 0.7),
                invert: true,
                key: "terminalHeight",
                set: setTerminalHeight,
              })
            }
          />
        ) : null}
        {/* Kept mounted while hidden — unmounting would kill the shell session
            (and any process running in it). Toggle visibility via CSS instead. */}
        <div
          className="app__bottom"
          style={{
            display: terminalVisible ? undefined : "none",
            height: terminalHeight,
          }}
        >
          <TerminalPane cwd={rootPath} shell={terminalShell} appTheme={effectiveTheme} />
        </div>
      </div>
      <SettingsModal
        open={settingsOpen}
        onSaved={handleSettingsSaved}
        onClose={handleCloseSettings}
        themeMode={themeMode}
        onThemeModeChange={handleThemeModeChange}
      />
      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(r) => {
          void handleOpenFile(r.path).then(() => {
            jumpRequestRef.current = {
              path: r.path,
              line: r.line,
              column: r.column,
            };
            setJumpCounter((c) => c + 1);
          });
        }}
      />
    </div>
  );
}

export default App;