import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PROVIDER_PRESETS,
  emptyStore,
  loadProviderStore,
  resolveConnection,
  saveProviderStore,
  testConnection,
  SHELL_PRESETS,
  type McpServerEntry,
  type ProviderEntry,
  type ProviderPreset,
  type ProviderStore,
  type Settings,
  type WorkerBackend,
  type StageConfig,
} from "../lib/settings";
import {
  applyConfig as applyMcpConfig,
  getStatuses,
  subscribe as subscribeMcp,
  type McpServerStatus,
} from "../lib/mcp";
import { DEFAULT_STAGES, detectCli } from "../lib/workers";
import {
  installSkill as installSkillBackend,
  loadAllInstalledSkills,
  uninstallSkill as uninstallSkillBackend,
  type InstalledSkill,
} from "../lib/skills";

import type { ThemeMode } from "../lib/theme";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}

type TestState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export function SettingsModal({
  open,
  onClose,
  onSaved,
  themeMode,
  onThemeModeChange,
}: SettingsModalProps): React.JSX.Element | null {
  const [store, setStore] = useState<ProviderStore>(() => emptyStore());
  const [loaded, setLoaded] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [customModelsDraft, setCustomModelsDraft] = useState<string>("");
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([]);
  const [activeTab, setActiveTab] = useState<
    "ai" | "mcp" | "skills" | "terminal" | "agents" | "display"
  >("ai");
const [skillsInstalled, setSkillsInstalled] = useState<InstalledSkill[]>([]);

const loadSkillsInstalled = useCallback(async (): Promise<void> => {
  try {
    const all = await loadAllInstalledSkills();
    setSkillsInstalled(all);
  } catch {
    setSkillsInstalled([]);
  }
}, []);

  useEffect(() => {
    return subscribeMcp(() => {
      setMcpStatuses(getStatuses());
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    setTestState({ kind: "idle" });
    setShowKey(false);
    let cancelled = false;
    void (async () => {
      const existing = await loadProviderStore();
      if (cancelled) return;
      setStore(existing);
      setLoaded(true);
      void applyMcpConfig(existing.mcp);
      void loadSkillsInstalled();
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const activePreset: ProviderPreset = useMemo(() => {
    const found = PROVIDER_PRESETS.find((p) => p.id === store.activeProviderId);
    return found ?? PROVIDER_PRESETS[0];
  }, [store.activeProviderId]);

  const activeEntry: ProviderEntry = useMemo(() => {
    return (
      store.providers[activePreset.id] ?? {
        apiKey: "",
        baseUrlOverride: null,
        modelsOverride: null,
      }
    );
  }, [store.providers, activePreset.id]);

  const effectiveBaseUrl: string = useMemo(() => {
    if (activePreset.id === "custom") {
      return activeEntry.baseUrlOverride ?? "";
    }
    return activeEntry.baseUrlOverride ?? activePreset.baseUrl;
  }, [activePreset, activeEntry.baseUrlOverride]);

  const effectiveModels: string[] = useMemo(() => {
    const fromPreset = activePreset.models;
    const override = activeEntry.modelsOverride;
    if (override === null || override === undefined) return fromPreset;
    const merged = [...fromPreset];
    for (const m of override) {
      if (!merged.includes(m)) merged.push(m);
    }
    return merged;
  }, [activePreset.models, activeEntry.modelsOverride]);

  useEffect(() => {
    setCustomModelsDraft((activeEntry.modelsOverride ?? []).join(", "));
  }, [activeEntry.modelsOverride, activePreset.id]);

  useEffect(() => {
    if (effectiveModels.length === 0) return;
    if (
      store.activeModel === "" ||
      !effectiveModels.includes(store.activeModel)
    ) {
      setStore((s) => ({ ...s, activeModel: effectiveModels[0] }));
    }
  }, [effectiveModels, store.activeModel]);

  const setActiveProvider = useCallback((id: string): void => {
    setStore((s) => ({ ...s, activeProviderId: id }));
    setTestState({ kind: "idle" });
  }, []);

  const updateEntry = useCallback(
    (patch: Partial<ProviderEntry>): void => {
      const id = activePreset.id;
      setStore((s) => {
        const prev: ProviderEntry = s.providers[id] ?? {
          apiKey: "",
          baseUrlOverride: null,
          modelsOverride: null,
        };
        return {
          ...s,
          providers: {
            ...s.providers,
            [id]: { ...prev, ...patch },
          },
        };
      });
      setTestState({ kind: "idle" });
    },
    [activePreset.id],
  );

  const handleApiKeyChange = useCallback(
    (value: string): void => {
      updateEntry({ apiKey: value });
    },
    [updateEntry],
  );

  const handleBaseUrlChange = useCallback(
    (value: string): void => {
      updateEntry({ baseUrlOverride: value === "" ? null : value });
    },
    [updateEntry],
  );

  const handleModelChange = useCallback((value: string): void => {
    setStore((s) => ({ ...s, activeModel: value }));
    setTestState({ kind: "idle" });
  }, []);

  const handleCustomModelsCommit = useCallback((): void => {
    const parsed = customModelsDraft
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    updateEntry({ modelsOverride: parsed.length === 0 ? null : parsed });
  }, [customModelsDraft, updateEntry]);

  const openDocsLink = useCallback(async (url: string): Promise<void> => {
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      const fn = (mod as { openUrl?: (u: string) => Promise<void> }).openUrl
        ?? (mod as { open?: (u: string) => Promise<void> }).open;
      if (typeof fn === "function") {
        await fn(url);
        return;
      }
    } catch {
      void 0;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const resolved: Settings | null = useMemo(
    () => resolveConnection(store),
    [store],
  );

  const canTest: boolean =
    loaded && !saving && resolved !== null && resolved.apiKey.trim().length > 0;

  const canSave: boolean =
    loaded && !saving && resolved !== null && testState.kind !== "loading";

  const handleTest = useCallback(async (): Promise<void> => {
    if (resolved === null) {
      setTestState({
        kind: "error",
        message: "기본 URL, API 키, 모델을 모두 입력하세요.",
      });
      return;
    }
    setTestState({ kind: "loading" });
    const result = await testConnection(resolved);
    if (result.ok) {
      setTestState({ kind: "ok" });
    } else {
      setTestState({
        kind: "error",
        message: result.error ?? "알 수 없는 오류",
      });
    }
  }, [resolved]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (resolved === null) return;
    setSaving(true);
    try {
      await saveProviderStore(store);
      void applyMcpConfig(store.mcp);
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestState({ kind: "error", message: msg });
    } finally {
      setSaving(false);
    }
  }, [store, resolved, onSaved, onClose]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  if (!open) return null;

  const isCustom = activePreset.id === "custom";

  return (
    <div
      className="settings-modal__backdrop"
      onMouseDown={handleBackdrop}
      role="presentation"
    >
      <div
        className="settings-modal__card settings-modal__card--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <div className="settings-modal__header">
          <h2 id="settings-modal-title" className="settings-modal__title">
            설정
          </h2>
          <button
            type="button"
            className="settings-modal__close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-modal__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "ai"}
            className={`settings-modal__tab${activeTab === "ai" ? " settings-modal__tab--active" : ""}`}
            onClick={() => setActiveTab("ai")}
          >
            AI 설정
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "mcp"}
            className={`settings-modal__tab${activeTab === "mcp" ? " settings-modal__tab--active" : ""}`}
            onClick={() => setActiveTab("mcp")}
          >
            MCP
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "skills"}
            className={`settings-modal__tab${activeTab === "skills" ? " settings-modal__tab--active" : ""}`}
            onClick={() => setActiveTab("skills")}
          >
            Skills
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "terminal"}
            className={`settings-modal__tab${activeTab === "terminal" ? " settings-modal__tab--active" : ""}`}
            onClick={() => setActiveTab("terminal")}
          >
            터미널
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "agents"}
            className={`settings-modal__tab${activeTab === "agents" ? " settings-modal__tab--active" : ""}`}
            onClick={() => setActiveTab("agents")}
          >
            Agents
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "display"}
            className={`settings-modal__tab${activeTab === "display" ? " settings-modal__tab--active" : ""}`}
            onClick={() => setActiveTab("display")}
          >
            화면
          </button>
        </div>

        {activeTab === "ai" ? (
          <div className="settings-modal__body">
          {/* Provider list */}
          <div className="settings-modal__field">
            <span className="settings-modal__label">Provider</span>
            <div className="settings-modal__provider-list" role="radiogroup">
              {PROVIDER_PRESETS.map((preset) => {
                const selected = preset.id === store.activeProviderId;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={
                      "settings-modal__provider" +
                      (selected ? " settings-modal__provider--selected" : "")
                    }
                    onClick={() => setActiveProvider(preset.id)}
                  >
                    <span className="settings-modal__provider-radio" aria-hidden="true">
                      {selected ? "●" : "○"}
                    </span>
                    <span className="settings-modal__provider-text">
                      <span className="settings-modal__provider-label">
                        {preset.label}
                      </span>
                      {preset.hint !== null ? (
                        <span className="settings-modal__provider-hint">
                          {preset.hint}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Base URL row */}
          <div className="settings-modal__field">
            <span className="settings-modal__label">
              Base URL
              {activePreset.docsUrl !== null ? (
                <button
                  type="button"
                  className="settings-modal__docs-link"
                  onClick={() => {
                    if (activePreset.docsUrl !== null) {
                      void openDocsLink(activePreset.docsUrl);
                    }
                  }}
                  title={activePreset.docsUrl}
                >
                  API 키 발급 ↗
                </button>
              ) : null}
            </span>
            {isCustom ? (
              <input
                type="url"
                className="settings-modal__input"
                placeholder="https://your-endpoint/v1"
                value={effectiveBaseUrl}
                onChange={(e) => handleBaseUrlChange(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            ) : (
              <div className="settings-modal__readonly">
                {effectiveBaseUrl === "" ? (
                  <span className="settings-modal__readonly-muted">
                    (기본값 없음)
                  </span>
                ) : (
                  effectiveBaseUrl
                )}
              </div>
            )}
          </div>

          {/* API key */}
          <div className="settings-modal__field">
            <span className="settings-modal__label">
              API Key
              <span className="settings-modal__scope-hint">
                ({activePreset.label} 전용)
              </span>
            </span>
            <div className="settings-modal__input-group">
              <input
                type={showKey ? "text" : "password"}
                className="settings-modal__input"
                placeholder="sk-..."
                value={activeEntry.apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="settings-modal__toggle"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? "API 키 가리기" : "API 키 표시"}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {/* Model */}
          <div className="settings-modal__field">
            <span className="settings-modal__label">Model</span>
            {effectiveModels.length > 0 ? (
              <select
                className="settings-modal__input settings-modal__select"
                value={effectiveModels.includes(store.activeModel)
                  ? store.activeModel
                  : effectiveModels[0]}
                onChange={(e) => handleModelChange(e.target.value)}
              >
                {effectiveModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="settings-modal__input"
                placeholder="model-name"
                value={store.activeModel}
                onChange={(e) => handleModelChange(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </div>

          {/* Custom-only: edit raw model list */}
          {isCustom ? (
            <div className="settings-modal__field">
              <span className="settings-modal__label">
                Models (쉼표 구분)
                <span className="settings-modal__scope-hint">
                  모델 목록에 직접 추가
                </span>
              </span>
              <div className="settings-modal__input-group">
                <input
                  type="text"
                  className="settings-modal__input"
                  placeholder="my-model-a, my-model-b"
                  value={customModelsDraft}
                  onChange={(e) => setCustomModelsDraft(e.target.value)}
                  onBlur={handleCustomModelsCommit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCustomModelsCommit();
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="settings-modal__toggle"
                  onClick={handleCustomModelsCommit}
                  title="모델 목록에 반영"
                >
                  적용
                </button>
              </div>
            </div>
          ) : null}

          {/* Test connection */}
          <div className="settings-modal__test-row">
            <button
              type="button"
              className="settings-modal__btn settings-modal__btn--ghost"
              onClick={() => {
                void handleTest();
              }}
              disabled={!canTest}
            >
              {testState.kind === "loading" ? (
                <>
                  <span
                    className="settings-modal__spinner"
                    aria-hidden="true"
                  />
                  연결 테스트 중…
                </>
              ) : (
                "연결 테스트"
              )}
            </button>
            <TestResult state={testState} />
          </div>
        </div>
        ) : null}

        {activeTab === "mcp" ? (
          <McpSection
            store={store}
            setStore={setStore}
            statuses={mcpStatuses}
          />
        ) : null}

        {activeTab === "skills" ? (
          <SkillsSection
            store={store}
            setStore={setStore}
            skills={skillsInstalled}
            onRefresh={loadSkillsInstalled}
          />
        ) : null}

        {activeTab === "terminal" ? (
          <TerminalSection store={store} setStore={setStore} />
        ) : null}

        {activeTab === "agents" ? (
          <AgentsSection store={store} setStore={setStore} />
        ) : null}

        {activeTab === "display" ? (
          <div className="settings-modal__body">
            <h3 className="settings-modal__section-title">테마</h3>
            <p className="settings-modal__hint">
              적용은 즉시 반영되며 저장 버튼과 무관하게 유지됩니다.
            </p>
            <div className="settings-modal__theme-options">
              {(
                [
                  { value: "dark", label: "다크" },
                  { value: "light", label: "라이트" },
                  { value: "system", label: "시스템 설정 따르기" },
                ] as const
              ).map((opt) => (
                <label key={opt.value} className="settings-modal__theme-option">
                  <input
                    type="radio"
                    name="theme-mode"
                    value={opt.value}
                    checked={themeMode === opt.value}
                    onChange={() => onThemeModeChange(opt.value)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="settings-modal__footer">
          <button
            type="button"
            className="settings-modal__btn"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--primary"
            onClick={() => {
              void handleSave();
            }}
            disabled={!canSave}
            title={
              resolved === null
                ? "Base URL, API Key, Model을 모두 입력하세요."
                : "저장"
            }
          >
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TestResult({
  state,
}: {
  state: TestState;
}): React.JSX.Element {
  if (state.kind === "idle" || state.kind === "loading") {
    return <span className="settings-modal__test-empty" />;
  }
  if (state.kind === "ok") {
    return (
      <span className="settings-modal__test settings-modal__test--ok">
        ✓ 연결 성공
      </span>
    );
  }
  return (
    <span
      className="settings-modal__test settings-modal__test--err"
      title={state.message}
    >
      ✗ {state.message}
    </span>
  );
}

interface McpSectionProps {
  store: ProviderStore;
  setStore: React.Dispatch<React.SetStateAction<ProviderStore>>;
  statuses: McpServerStatus[];
}

function McpSection({ store, setStore, statuses }: McpSectionProps): React.JSX.Element {
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const servers = store.mcp ?? {};

  const updateServers = (next: Record<string, McpServerEntry>): void => {
    setStore((s) => ({ ...s, mcp: next }));
  };

  const handleAdd = (): void => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (name === "" || url === "") return;
    if (servers[name] !== undefined) return;
    updateServers({ ...servers, [name]: { type: "remote", url, enabled: true } });
    setNewName("");
    setNewUrl("");
  };

  const handleRemove = (name: string): void => {
    const next = { ...servers };
    delete next[name];
    updateServers(next);
  };

  const handleToggle = (name: string, enabled: boolean): void => {
    const entry = servers[name];
    if (entry === undefined) return;
    updateServers({ ...servers, [name]: { ...entry, enabled } });
  };

  const handleRestart = (): void => {
    void applyMcpConfig(servers);
  };

  const statusOf = (name: string): McpServerStatus | undefined =>
    statuses.find((s) => s.name === name);

  return (
    <div className="settings-modal__mcp">
      <div className="settings-modal__mcp-header">
        <h3 className="settings-modal__section-title">MCP 서버 (원격)</h3>
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--small"
          onClick={handleRestart}
          disabled={Object.keys(servers).length === 0}
        >
          재연결
        </button>
      </div>
      <p className="settings-modal__hint">
        MCP(Model Context Protocol) 원격 서버를 등록하면, 에이전트가 해당 도구를
        자신의 도구(read_file/write_file/list_dir/run_command)와 함께 사용합니다.
        서버가 IPv4 전용 도메인이면 자동으로 Rust 프록시를 통해 연결됩니다.
      </p>

      <ul className="settings-modal__mcp-list">
        {Object.entries(servers).map(([name, entry]) => {
          const status = statusOf(name);
          return (
            <li key={name} className="settings-modal__mcp-item">
              <div className="settings-modal__mcp-row1">
                <span className="settings-modal__mcp-name">{name}</span>
                <span className={`settings-modal__mcp-badge settings-modal__mcp-badge--${status?.status ?? "disabled"}`}>
                  {status?.status ?? "disabled"}
                </span>
                <label className="settings-modal__mcp-toggle">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={(e) => handleToggle(name, e.target.checked)}
                  />
                  <span>활성</span>
                </label>
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--small settings-modal__btn--danger"
                  onClick={() => handleRemove(name)}
                >
                  제거
                </button>
              </div>
              <div className="settings-modal__mcp-row2">
                <code className="settings-modal__mcp-url">{entry.url}</code>
              </div>
              {status?.error !== null && status?.error !== undefined ? (
                <div className="settings-modal__mcp-error">{status.error}</div>
              ) : null}
              {status !== undefined && status.toolCount > 0 ? (
                <div className="settings-modal__mcp-tools">
                  도구 {status.toolCount}개 사용 가능
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="settings-modal__mcp-add">
        <input
          type="text"
          className="settings-modal__input"
          placeholder="서버 이름 (예: github)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          type="text"
          className="settings-modal__input"
          placeholder="https://mcp-server.example.com/mcp"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
        />
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--primary settings-modal__btn--small"
          onClick={handleAdd}
          disabled={newName.trim() === "" || newUrl.trim() === ""}
        >
          추가
        </button>
      </div>
    </div>
  );
}

interface AgentsSectionProps {
  store: ProviderStore;
  setStore: React.Dispatch<React.SetStateAction<ProviderStore>>;
}

function AgentsSection({ store, setStore }: AgentsSectionProps): React.JSX.Element {
  const [newId, setNewId] = useState("");
  const [newCmd, setNewCmd] = useState("");
  const [detected, setDetected] = useState<Record<string, boolean>>({});

  const workers = store.workers ?? {};
  const stages: StageConfig[] = store.pipeline?.stages ?? DEFAULT_STAGES;
  const guard = store.usageGuard ?? { enabled: false, warnRatio: 0.8 };

  const addCliWorker = (): void => {
    const id = newId.trim();
    const command = newCmd.trim();
    if (id === "" || command === "" || workers[id] !== undefined) return;
    const backend: WorkerBackend = {
      kind: "cli",
      command,
      argsTemplate: ["exec", "@brief"],
      briefMode: "arg",
      timeoutSec: 300,
      resultParse: "raw",
    };
    setStore((s) => ({ ...s, workers: { ...(s.workers ?? {}), [id]: backend } }));
    setNewId("");
    setNewCmd("");
  };

  const removeWorker = (id: string): void => {
    setStore((s) => {
      const next = { ...(s.workers ?? {}) };
      delete next[id];
      return { ...s, workers: next };
    });
  };

  const setStageBackend = (stageId: string, backendId: string): void => {
    const nextStages = stages.map((st) =>
      st.id === stageId ? { ...st, backendId: backendId === "" ? undefined : backendId } : st,
    );
    setStore((s) => ({ ...s, pipeline: { stages: nextStages } }));
  };

  const patchGuard = (patch: Partial<NonNullable<ProviderStore["usageGuard"]>>): void => {
    setStore((s) => ({ ...s, usageGuard: { ...guard, ...patch } }));
  };

  const runDetect = async (id: string, command: string): Promise<void> => {
    const ok = await detectCli(command);
    setDetected((d) => ({ ...d, [id]: ok }));
  };

  const workerIds = Object.keys(workers);

  return (
    <div className="settings-modal__mcp">
      <h3 className="settings-modal__section-title">CLI 워커</h3>
      <p className="settings-modal__hint">
        외부 CLI 에이전트(claude/codex/gemini 등)를 등록하면 파이프라인 단계에서 인앱 AI 대신
        선택할 수 있습니다. args의 <code>@brief</code>는 단계 브리프로 치환됩니다.
      </p>
      <ul className="settings-modal__mcp-list">
        {workerIds.map((id) => {
          const w = workers[id];
          if (w.kind !== "cli") return null;
          return (
            <li key={id} className="settings-modal__mcp-item">
              <div className="settings-modal__mcp-row1">
                <span className="settings-modal__mcp-name">{id}</span>
                <code className="settings-modal__mcp-url">
                  {w.command} {w.argsTemplate.join(" ")}
                </code>
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--small"
                  onClick={() => void runDetect(id, w.command)}
                >
                  탐지
                </button>
                {detected[id] !== undefined ? (
                  <span>{detected[id] ? "✓ 사용가능" : "✗ 없음"}</span>
                ) : null}
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--small settings-modal__btn--danger"
                  onClick={() => removeWorker(id)}
                >
                  제거
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="settings-modal__mcp-add">
        <input
          className="settings-modal__input"
          placeholder="워커 id (예: codex)"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
        />
        <input
          className="settings-modal__input"
          placeholder="명령 (예: codex)"
          value={newCmd}
          onChange={(e) => setNewCmd(e.target.value)}
        />
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--primary settings-modal__btn--small"
          onClick={addCliWorker}
          disabled={newId.trim() === "" || newCmd.trim() === ""}
        >
          추가
        </button>
      </div>

      <h3 className="settings-modal__section-title">파이프라인 단계 기본 백엔드</h3>
      {stages.map((st) => (
        <div key={st.id} className="settings-modal__field">
          <span className="settings-modal__label">{st.label}</span>
          <select
            className="settings-modal__input settings-modal__select"
            value={st.backendId ?? ""}
            onChange={(e) => setStageBackend(st.id, e.target.value)}
          >
            <option value="">기본 (인앱 AI)</option>
            {workerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      ))}

      <h3 className="settings-modal__section-title">사용량 가드</h3>
      <label className="settings-modal__mcp-toggle">
        <input
          type="checkbox"
          checked={guard.enabled}
          onChange={(e) => patchGuard({ enabled: e.target.checked })}
        />
        <span>실행당 예산 경고 사용</span>
      </label>
      <div className="settings-modal__field">
        <span className="settings-modal__label">실행당 예산 (토큰, 비우면 무제한)</span>
        <input
          type="number"
          className="settings-modal__input"
          value={guard.perRunBudgetTokens ?? ""}
          onChange={(e) =>
            patchGuard({
              perRunBudgetTokens: e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
        />
      </div>
      <div className="settings-modal__field">
        <span className="settings-modal__label">경고 임계 비율 (0–1)</span>
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
          className="settings-modal__input"
          value={guard.warnRatio}
          onChange={(e) => patchGuard({ warnRatio: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}

interface TerminalSectionProps {
  store: ProviderStore;
  setStore: React.Dispatch<React.SetStateAction<ProviderStore>>;
}

function TerminalSection({
  store,
  setStore,
}: TerminalSectionProps): React.JSX.Element {
  const current = store.terminalShell ?? "";
  const matched = SHELL_PRESETS.find((p) => p.command === current);
  const [customMode, setCustomMode] = useState(
    current !== "" && matched === undefined,
  );
  const [customText, setCustomText] = useState(
    current !== "" && matched === undefined ? current : "",
  );

  const selectId = customMode ? "__custom__" : matched?.id ?? "auto";

  const handleSelect = (id: string): void => {
    if (id === "__custom__") {
      setCustomMode(true);
      setStore((s) => ({ ...s, terminalShell: customText.trim() }));
      return;
    }
    setCustomMode(false);
    const preset = SHELL_PRESETS.find((p) => p.id === id);
    setStore((s) => ({ ...s, terminalShell: preset?.command ?? "" }));
  };

  const handleCustomChange = (value: string): void => {
    setCustomText(value);
    setStore((s) => ({ ...s, terminalShell: value.trim() }));
  };

  return (
    <div className="settings-modal__body">
      <div className="settings-modal__field">
        <span className="settings-modal__label">터미널 셸</span>
        <select
          className="settings-modal__input settings-modal__select"
          value={selectId}
          onChange={(e) => handleSelect(e.target.value)}
        >
          {SHELL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="__custom__">사용자 지정 (경로 직접 입력)…</option>
        </select>
      </div>

      {customMode ? (
        <div className="settings-modal__field">
          <span className="settings-modal__label">
            셸 실행 파일 / 명령
            <span className="settings-modal__scope-hint">
              전체 경로 또는 PATH의 명령 이름
            </span>
          </span>
          <input
            type="text"
            className="settings-modal__input"
            placeholder={`예: C:\\Program Files\\PowerShell\\7\\pwsh.exe`}
            value={customText}
            onChange={(e) => handleCustomChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      ) : null}

      <p className="settings-modal__hint">
        새 터미널 세션에 사용할 셸입니다. PowerShell 7은 <code>pwsh</code>가 PATH에
        있어야 합니다(표준 설치 시 자동 등록). 없으면 사용자 지정으로 전체 경로를
        입력하세요. <strong>저장</strong>하면 현재 터미널이 새 셸로 다시 시작됩니다.
        “시스템 기본값”은 Windows에서 <code>cmd</code>(COMSPEC)를 사용합니다.
      </p>
    </div>
  );
}

interface SkillsSectionProps {
  store: ProviderStore;
  setStore: React.Dispatch<React.SetStateAction<ProviderStore>>;
  skills: InstalledSkill[];
  onRefresh: () => Promise<void>;
}

function SkillsSection({
  store,
  setStore,
  skills,
  onRefresh,
}: SkillsSectionProps): React.JSX.Element {
  const [srcPath, setSrcPath] = useState("");
  const [skillName, setSkillName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabledMap = store.skills ?? {};

  const setEnabled = (name: string, enabled: boolean): void => {
    setStore((s) => {
      const next = { ...(s.skills ?? {}) };
      if (enabled) {
        next[name] = { enabled: true };
      } else {
        next[name] = { enabled: false };
      }
      return { ...s, skills: next };
    });
  };

  const handleInstall = async (): Promise<void> => {
    const trimmedSrc = srcPath.trim();
    const trimmedName = skillName.trim();
    if (trimmedSrc === "" || trimmedName === "") return;
    setBusy(true);
    setError(null);
    try {
      await installSkillBackend(trimmedSrc, trimmedName);
      setSrcPath("");
      setSkillName("");
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async (name: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await uninstallSkillBackend(name);
      setStore((s) => {
        const next = { ...(s.skills ?? {}) };
        delete next[name];
        return { ...s, skills: next };
      });
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-modal__mcp">
      <div className="settings-modal__mcp-header">
        <h3 className="settings-modal__section-title">설치된 Skills</h3>
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--small"
          onClick={() => {
            void onRefresh();
          }}
          disabled={busy}
        >
          새로고침
        </button>
      </div>
      <p className="settings-modal__hint">
        Anthropic의 Agent Skills(<code>SKILL.md</code>) 형식 폴더를 가져옵니다.
        활성화된 Skills의 본문이 매번 시스템 프롬프트에 자동 주입되어 에이전트가
        절차/SOP를 따릅니다. 디렉토리 경로 또는 <code>SKILL.md</code> 파일 경로를
        입력하세요.
      </p>

      {error !== null ? (
        <div className="settings-modal__mcp-error">{error}</div>
      ) : null}

      {skills.length === 0 ? (
        <p className="settings-modal__hint">설치된 Skill이 없습니다.</p>
      ) : (
        <ul className="settings-modal__mcp-list">
          {skills.map((s) => {
            const enabled = enabledMap[s.name]?.enabled !== false;
            return (
              <li key={s.name} className="settings-modal__mcp-item">
                <div className="settings-modal__mcp-row1">
                  <span className="settings-modal__mcp-name">{s.name}</span>
                  <label className="settings-modal__mcp-toggle">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) =>
                        setEnabled(s.name, e.target.checked)
                      }
                    />
                    <span>활성</span>
                  </label>
                  <button
                    type="button"
                    className="settings-modal__btn settings-modal__btn--small settings-modal__btn--danger"
                    onClick={() => {
                      void handleUninstall(s.name);
                    }}
                    disabled={busy}
                  >
                    제거
                  </button>
                </div>
                <div className="settings-modal__mcp-row2">
                  {s.metadata.description.length > 0 ? (
                    <span>{s.metadata.description}</span>
                  ) : (
                    <span style={{ opacity: 0.6 }}>(description 없음)</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="settings-modal__mcp-add">
        <input
          type="text"
          className="settings-modal__input"
          placeholder="경로 (예: /home/user/my-skill 또는 .../SKILL.md)"
          value={srcPath}
          onChange={(e) => setSrcPath(e.target.value)}
          disabled={busy}
        />
        <input
          type="text"
          className="settings-modal__input"
          placeholder="Skill 이름 (예: code-review)"
          value={skillName}
          onChange={(e) => setSkillName(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--primary settings-modal__btn--small"
          onClick={() => {
            void handleInstall();
          }}
          disabled={busy || srcPath.trim() === "" || skillName.trim() === ""}
        >
          가져오기
        </button>
      </div>
    </div>
  );
}
