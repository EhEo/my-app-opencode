import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import {
  DEFAULT_SYSTEM_PROMPT,
  runAgent,
  type ChatMessage,
  type ToolCall,
} from "../lib/agent";
import type { Settings } from "../lib/settings";
import { getFileName } from "../lib/language";
import { buildOpenFilesContext } from "../lib/openFiles";
import { PipelinePanel } from "./PipelinePanel";
import { baseMarkdownComponents } from "./markdownComponents";

interface ChatPanelProps {
  workspaceRoot: string | null;
  settings: Settings | null;
  onOpenSettings: () => void;
  onFileChanged: (path: string) => void;
  activeFilePath: string | null;
  openFilePaths: string[];
  pipelineRefreshToken?: number;
}

type UiToolCardStatus = "running" | "ok" | "error";

interface UiToolCard {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: UiToolCardStatus;
  result: string;
  error: string | null;
  expanded: boolean;
}

interface UiItem {
  kind: "user" | "assistant" | "tool" | "error" | "streaming-assistant";
  userContent?: string;
  assistantContent?: string;
  streamingContent?: string;
  errorMessage?: string;
  tool?: UiToolCard;
}

const SCROLL_BOTTOM_THRESHOLD = 80;
const EXAMPLES: string[] = [
  "Explain the structure of this workspace",
  "Read src/App.tsx and summarize it",
  "List the top-level files in the project",
];

export function ChatPanel({
  workspaceRoot,
  settings,
  onOpenSettings,
  onFileChanged,
  activeFilePath,
  openFilePaths,
  pipelineRefreshToken,
}: ChatPanelProps): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [uiItems, setUiItems] = useState<UiItem[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"chat" | "pipeline">("chat");

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setMessages([]);
    setUiItems([]);
    setInput("");
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setRunning(false);
  }, [workspaceRoot]);

  const handleScroll = useCallback((): void => {
    const el = scrollContainerRef.current;
    if (el === null) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD;
  }, []);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (el !== null) {
      el.scrollTop = el.scrollHeight;
    }
  }, [uiItems]);

  const canSend =
    settings !== null &&
    workspaceRoot !== null &&
    !running &&
    input.trim().length > 0;

  const disabledReason: "settings" | "workspace" | "input" | null =
    settings === null
      ? "settings"
      : workspaceRoot === null
        ? "workspace"
        : input.trim().length === 0
          ? "input"
          : null;

  const updateStreamingAssistant = useCallback((delta: string): void => {
    setUiItems((prev) => {
      const last = prev[prev.length - 1];
      if (last !== undefined && last.kind === "streaming-assistant") {
        const next = prev.slice();
        next[next.length - 1] = {
          ...last,
          streamingContent: (last.streamingContent ?? "") + delta,
        };
        return next;
      }
      return [
        ...prev,
        {
          kind: "streaming-assistant",
          streamingContent: delta,
        },
      ];
    });
  }, []);

  const finalizeAssistantMessage = useCallback((content: string): void => {
    setUiItems((prev) => {
      const last = prev[prev.length - 1];
      if (last !== undefined && last.kind === "streaming-assistant") {
        const next = prev.slice();
        next[next.length - 1] = {
          kind: "assistant",
          assistantContent: content,
        };
        return next;
      }
      return [...prev, { kind: "assistant", assistantContent: content }];
    });
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content },
    ]);
  }, []);

  const addToolCard = useCallback((call: ToolCall): void => {
    setUiItems((prev) => [
      ...prev,
      {
        kind: "tool",
        tool: {
          id: call.id,
          name: call.name,
          args: call.args,
          status: "running",
          result: "",
          error: null,
          expanded: false,
        },
      },
    ]);
  }, []);

  const updateToolCard = useCallback(
    (id: string, result: string, error: string | undefined): void => {
      setUiItems((prev) =>
        prev.map((item) => {
          if (item.kind !== "tool" || item.tool === undefined) return item;
          if (item.tool.id !== id) return item;
          const status: UiToolCardStatus =
            error !== undefined && error.length > 0 ? "error" : "ok";
          return {
            ...item,
            tool: {
              ...item.tool,
              status,
              result,
              error: error ?? null,
            },
          };
        }),
      );
    },
    [],
  );

  const toggleToolCard = useCallback((id: string): void => {
    setUiItems((prev) =>
      prev.map((item) => {
        if (item.kind !== "tool" || item.tool === undefined) return item;
        if (item.tool.id !== id) return item;
        return {
          ...item,
          tool: { ...item.tool, expanded: !item.tool.expanded },
        };
      }),
    );
  }, []);

  const addErrorMessage = useCallback((message: string): void => {
    setUiItems((prev) => [
      ...prev,
      { kind: "error", errorMessage: message },
    ]);
  }, []);

  const handleSend = useCallback(async (): Promise<void> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return;
    if (settings === null) {
      onOpenSettings();
      return;
    }
    if (workspaceRoot === null) return;

    stickToBottomRef.current = true;

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    const history: ChatMessage[] = [...messages, userMsg];

    setMessages(history);
    setUiItems((prev) => [
      ...prev,
      { kind: "user", userContent: trimmed },
    ]);
    setInput("");
    setRunning(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await runAgent({
        settings,
        systemPrompt:
          DEFAULT_SYSTEM_PROMPT +
          buildOpenFilesContext(workspaceRoot, activeFilePath, openFilePaths),
        messages: history,
        callbacks: {
          onToken: (delta) => updateStreamingAssistant(delta),
          onAssistantText: (content) => finalizeAssistantMessage(content),
          onToolStart: (call) => addToolCard(call),
          onToolEnd: (call, result, error) =>
            updateToolCard(call.id, result, error),
          onFileChanged: (path) => onFileChanged(path),
          onDone: (reason, finalMessages) => {
            if (finalMessages !== undefined && finalMessages.length > 0) {
              setMessages(finalMessages);
            }
            // Finalize any text left mid-stream (e.g. on Stop) so it doesn't
            // render with a perpetual blinking cursor.
            setUiItems((prev) => {
              const last = prev[prev.length - 1];
              if (last?.kind === "streaming-assistant") {
                const next = prev.slice();
                next[next.length - 1] = {
                  kind: "assistant",
                  assistantContent: last.streamingContent ?? "",
                };
                return next;
              }
              return prev;
            });
            if (reason === "max_iterations") {
              addErrorMessage(
                "Reached the step limit (25 iterations). The task may be incomplete — send another message to continue.",
              );
            }
          },
          onError: (err) => {
            addErrorMessage(err.message);
          },
        },
        signal: ac.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addErrorMessage(msg);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [
    input,
    settings,
    workspaceRoot,
    messages,
    updateStreamingAssistant,
    finalizeAssistantMessage,
    addToolCard,
    updateToolCard,
    addErrorMessage,
    onFileChanged,
    onOpenSettings,
    activeFilePath,
    openFilePaths,
  ]);

  const handleStop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (canSend) {
          void handleSend();
        }
      }
    },
    [canSend, handleSend],
  );

  const handleExample = useCallback((example: string): void => {
    setInput(example);
    const ta = textareaRef.current;
    if (ta !== null) {
      ta.focus();
    }
  }, []);

  const isEmpty = uiItems.length === 0;

  return (
    <aside className="chat-panel">
      <header className="chat-panel__header">
        <span className="chat-panel__title">opencode</span>
        <div className="chat-panel__mode" role="tablist">
          <button
            type="button"
            className={`chat-panel__mode-btn${mode === "chat" ? " chat-panel__mode-btn--active" : ""}`}
            onClick={() => setMode("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            className={`chat-panel__mode-btn${mode === "pipeline" ? " chat-panel__mode-btn--active" : ""}`}
            onClick={() => setMode("pipeline")}
          >
            Pipeline
          </button>
        </div>
        <span
          className={`chat-panel__status${
            running ? " chat-panel__status--running" : ""
          }`}
        >
          {running ? "Running" : settings !== null ? "Ready" : "Not configured"}
        </span>
      </header>

      {/* Both views stay mounted; the inactive one is hidden with display:none
          rather than unmounted. Unmounting the pipeline aborted its in-flight
          run and wiped its state on every mode switch (same reasoning as the
          always-mounted terminal in App.tsx). */}
      <div
        className="chat-panel__view"
        style={{ display: mode === "chat" ? undefined : "none" }}
      >
          <div
            ref={scrollContainerRef}
            className="chat-messages"
            onScroll={handleScroll}
          >
            {isEmpty ? (
              <EmptyState
                onExample={handleExample}
                showExamples={workspaceRoot !== null && settings !== null}
              />
            ) : (
              <MessageList items={uiItems} onToggleTool={toggleToolCard} />
            )}
            <div ref={messagesEndRef} className="chat-messages__end" />
          </div>

          <footer className="chat-input">
            {disabledReason === "settings" ? (
              <div className="chat-input__hint">
                <span>Configure settings to start.</span>
                <button
                  type="button"
                  className="chat-input__hint-btn"
                  onClick={onOpenSettings}
                >
                  Open settings
                </button>
              </div>
            ) : disabledReason === "workspace" ? (
              <div className="chat-input__hint">
                <span>Open a folder to start.</span>
              </div>
            ) : null}
            <div className="chat-input__row">
              <textarea
                ref={textareaRef}
                className="chat-input__field"
                placeholder={
                  workspaceRoot === null
                    ? "Open a folder first…"
                    : settings === null
                      ? "Configure settings first…"
                      : "Ask opencode to read, edit, or run code…"
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={2}
                spellCheck={false}
              />
            </div>
            <div className="chat-input__actions">
              <div className="chat-input__meta">
                {workspaceRoot !== null ? (
                  <span className="chat-input__meta-item" title={workspaceRoot}>
                    {getFileName(workspaceRoot)}
                  </span>
                ) : null}
                {settings !== null ? (
                  <span className="chat-input__meta-item">{settings.model}</span>
                ) : null}
              </div>
              <div className="chat-input__buttons">
                {running ? (
                  <button
                    type="button"
                    className="chat-input__btn chat-input__btn--stop"
                    onClick={handleStop}
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chat-input__btn chat-input__btn--send"
                    onClick={() => {
                      void handleSend();
                    }}
                    disabled={!canSend}
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </footer>
      </div>
      <div
        className="chat-panel__view"
        style={{ display: mode === "pipeline" ? undefined : "none" }}
      >
        <PipelinePanel
          workspaceRoot={workspaceRoot}
          activeFilePath={activeFilePath}
          openFilePaths={openFilePaths}
          refreshToken={pipelineRefreshToken}
        />
      </div>
    </aside>
  );
}

function EmptyState({
  onExample,
  showExamples,
}: {
  onExample: (s: string) => void;
  showExamples: boolean;
}): React.JSX.Element {
  return (
    <div className="chat-empty">
      <div className="chat-empty__glyph" aria-hidden="true">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect
            x="6"
            y="10"
            width="36"
            height="28"
            rx="4"
            stroke="#5a5d5e"
            strokeWidth="1.5"
            fill="none"
          />
          <path
            d="M6 18h36"
            stroke="#5a5d5e"
            strokeWidth="1.5"
          />
          <circle cx="11" cy="14" r="1.2" fill="#5a5d5e" />
          <circle cx="15" cy="14" r="1.2" fill="#5a5d5e" />
          <circle cx="19" cy="14" r="1.2" fill="#5a5d5e" />
          <path
            d="M12 26h10M12 30h18M12 34h8"
            stroke="#5a5d5e"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <h3 className="chat-empty__title">Ask opencode anything</h3>
      <p className="chat-empty__sub">
        {showExamples
          ? "Read, edit, or run code in your workspace."
          : "Open a folder and configure settings to get started."}
      </p>
      {showExamples ? (
        <div className="chat-empty__examples">
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex}
              className="chat-empty__chip"
              onClick={() => onExample(ex)}
            >
              {ex}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MessageList({
  items,
  onToggleTool,
}: {
  items: UiItem[];
  onToggleTool: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="chat-msg-list">
      {items.map((item, idx) => {
        if (item.kind === "user") {
          return (
            <div
              key={`u-${idx}`}
              className="chat-msg chat-msg--user"
            >
              <div className="chat-msg__bubble">{item.userContent}</div>
            </div>
          );
        }
        if (item.kind === "assistant") {
          return (
            <div
              key={`a-${idx}`}
              className="chat-msg chat-msg--assistant"
            >
              <MarkdownContent
                text={item.assistantContent ?? ""}
              />
            </div>
          );
        }
        if (item.kind === "streaming-assistant") {
          return (
            <div
              key={`s-${idx}`}
              className="chat-msg chat-msg--assistant chat-msg--streaming"
            >
              <MarkdownContent
                text={item.streamingContent ?? ""}
                streaming
              />
              <span className="chat-msg__cursor" aria-hidden="true" />
            </div>
          );
        }
        if (item.kind === "tool" && item.tool !== undefined) {
          return (
            <ToolCardView
              key={`t-${idx}-${item.tool.id}`}
              card={item.tool}
              onToggle={() => onToggleTool(item.tool!.id)}
            />
          );
        }
        if (item.kind === "error") {
          return (
            <div key={`e-${idx}`} className="chat-msg chat-msg--error">
              <div className="chat-msg__bubble chat-msg__bubble--error">
                <strong>Error:</strong> {item.errorMessage}
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function MarkdownContent({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}): React.JSX.Element {
  const rendered = useMemo(() => {
    if (text.length === 0 && streaming === true) {
      return (
        <span className="chat-md chat-md--empty">
          <span className="chat-md__dot-pulse" />
        </span>
      );
    }
    return (
      <Markdown
        components={{
          ...baseMarkdownComponents,
          a: ({ children, href }) => (
            <a
              className="chat-md__a"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    );
  }, [text, streaming]);

  return <div className="chat-md">{rendered}</div>;
}

function ToolCardView({
  card,
  onToggle,
}: {
  card: UiToolCard;
  onToggle: () => void;
}): React.JSX.Element {
  const statusClass =
    card.status === "running"
      ? "chat-tool-card__status--running"
      : card.status === "error"
        ? "chat-tool-card__status--error"
        : "chat-tool-card__status--ok";

  const argsText = formatToolArgs(card.name, card.args);

  return (
    <div className="chat-tool-card">
      <button
        type="button"
        className="chat-tool-card__header"
        onClick={onToggle}
        title={card.expanded ? "Collapse" : "Expand"}
      >
        <span className="chat-tool-card__chevron" aria-hidden="true">
          {card.expanded ? "▾" : "▸"}
        </span>
        <ToolIcon name={card.name} />
        <span className="chat-tool-card__name">{card.name}</span>
        <span className="chat-tool-card__args">{argsText}</span>
        <span className={`chat-tool-card__status ${statusClass}`}>
          {card.status === "running" ? (
            <span className="chat-tool-card__spinner" aria-hidden="true" />
          ) : card.status === "error" ? (
            "error"
          ) : (
            "done"
          )}
        </span>
      </button>
      {card.expanded ? (
        <div className="chat-tool-card__body">
          {card.error !== null ? (
            <pre className="chat-tool-card__error">{card.error}</pre>
          ) : card.result.length > 0 ? (
            <pre className="chat-tool-card__result">
              {truncate(card.result, 8000)}
            </pre>
          ) : card.status === "running" ? (
            <pre className="chat-tool-card__result chat-tool-card__result--muted">
              running…
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolIcon({ name }: { name: string }): React.JSX.Element {
  const ch = name === "read_file" ? "📄" : name === "write_file" ? "✎" : name === "list_dir" ? "▤" : name === "run_command" ? "$" : "·";
  return (
    <span className="chat-tool-card__icon" aria-hidden="true">
      {ch}
    </span>
  );
}

function formatToolArgs(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "read_file":
    case "list_dir": {
      const p = args.path;
      if (typeof p === "string" && p.length > 0) {
        return p.length > 60 ? `…${p.slice(-58)}` : p;
      }
      return "";
    }
    case "write_file": {
      const p = args.path;
      if (typeof p === "string" && p.length > 0) {
        return p.length > 60 ? `…${p.slice(-58)}` : p;
      }
      return "";
    }
    case "run_command": {
      const c = args.command;
      if (typeof c === "string" && c.length > 0) {
        return c.length > 60 ? `…${c.slice(-58)}` : c;
      }
      return "";
    }
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n\n… (${s.length - n} more chars)`;
}