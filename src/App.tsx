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
import { loadSettings, type Settings } from "./lib/settings";

interface TabState {
  content: string;
  dirty: boolean;
}

function App(): React.JSX.Element {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Record<string, TabState>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CursorPosition | null>(null);
  const [wrapEnabled, setWrapEnabled] = useState(false);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatVisible, setChatVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [diskConflict, setDiskConflict] = useState<Record<string, boolean>>({});
  const [gitStatuses, setGitStatuses] = useState<Record<string, string>>({});
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
  const activeFile: EditorFile | null =
    activePath !== null && activeTab !== null
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
      setTabs({});
      setActivePath(null);
      tabsOrderRef.current = [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void msg;
    }
  }, []);

  const handleOpenFile = useCallback(
    async (path: string): Promise<void> => {
      if (tabs[path] !== undefined) {
        setActivePath(path);
        return;
      }

      try {
        const content = await fs.readFile(path);
        setTabs((prev) => ({ ...prev, [path]: { content, dirty: false } }));
        if (!tabsOrderRef.current.includes(path)) {
          tabsOrderRef.current = [...tabsOrderRef.current, path];
        }
        setActivePath(path);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void msg;
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
          [activePath]: { content: value, dirty: true },
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
    try {
      await fs.writeFile(activePath, tab.content);
      setTabs((prev) => {
        const existing = prev[activePath];
        if (existing === undefined) return prev;
        return { ...prev, [activePath]: { ...existing, dirty: false } };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void msg;
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
      tabsOrderRef.current = tabsOrderRef.current.filter((p) => p !== path);

      if (activePath === path) {
        const remaining = tabsOrderRef.current.filter((p) => p !== path);
        if (remaining.length === 0) {
          setActivePath(null);
        } else {
          const idx = tabsOrderRef.current.indexOf(path);
          const fallback =
            remaining[idx] ?? remaining[idx - 1] ?? remaining[0] ?? null;
          setActivePath(fallback);
        }
      }
    },
    [tabs, activePath],
  );

  const handleFileChanged = useCallback(
    async (
      path: string,
      opts: { force?: boolean } = {},
    ): Promise<void> => {
      const wasOpen = tabs[path] !== undefined;
      if (!wasOpen) return;
      if (opts.force !== true && tabs[path]?.dirty === true) {
        setDiskConflict((prev) => ({ ...prev, [path]: true }));
        return;
      }
      try {
        const fresh = await fs.readFile(path);
        setTabs((prev) => {
          if (prev[path] === undefined) return prev;
          if (prev[path]?.dirty === true && opts.force !== true) return prev;
          return {
            ...prev,
            [path]: { content: fresh, dirty: false },
          };
        });
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
    [tabs],
  );

  useEffect(() => {
    if (activePath === null) return;
    let disposed = false;
    let lastMtime: number | null = null;
    const tick = async (): Promise<void> => {
      if (disposed) return;
      try {
        const stat = await fs.statFile(activePath);
        if (disposed) return;
        if (lastMtime === null) {
          lastMtime = stat.mtimeMs;
        } else if (stat.mtimeMs !== lastMtime) {
          lastMtime = stat.mtimeMs;
          void handleFileChanged(activePath);
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
  }, [activePath, handleFileChanged]);

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
    <div className="app">
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
                onChange={handleEditorChange}
                onCursorChange={handleCursorChange}
                wrapEnabled={wrapEnabled}
                jumpRequest={jumpCounter === 0 ? null : jumpRequestRef.current}
                jumpRequestNonce={jumpCounter}
                onJumpConsumed={() => {
                  jumpRequestRef.current = null;
                }}
              />
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
            <ChatPanel
              workspaceRoot={rootPath}
              settings={settings}
              onOpenSettings={handleOpenSettings}
              onFileChanged={(p) => {
                void handleFileChanged(p);
              }}
            />
          ) : null}
        </div>
        {terminalVisible ? (
          <div className="app__bottom">
            <TerminalPane cwd={rootPath} />
          </div>
        ) : null}
      </div>
      <SettingsModal
        open={settingsOpen}
        onSaved={handleSettingsSaved}
        onClose={handleCloseSettings}
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