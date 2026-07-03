import { getCurrentWindow } from "@tauri-apps/api/window";

// The window is frameless (decorations: false) on every platform, so we draw
// our own controls. macOS convention puts the traffic-light buttons at the
// top-left; Windows keeps min/max/close at the top-right. Detect via the
// webview user agent (no @tauri-apps/plugin-os dependency needed).
const IS_MAC =
  typeof navigator !== "undefined" && /Mac OS X|Macintosh/.test(navigator.userAgent);

interface ToolbarProps {
  onOpenFolder: () => void;
  onSave: () => void;
  dirty: boolean;
  fileName: string | null;
  canSave: boolean;
  onOpenSettings: () => void;
  onToggleChat: () => void;
  chatVisible: boolean;
  onToggleTerminal: () => void;
  terminalVisible: boolean;
}

export function Toolbar({
  onOpenFolder,
  onSave,
  dirty,
  fileName,
  canSave,
  onOpenSettings,
  onToggleChat,
  chatVisible,
  onToggleTerminal,
  terminalVisible,
}: ToolbarProps): React.JSX.Element {
  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="toolbar__left" data-tauri-drag-region>
        {IS_MAC ? <MacWindowControls /> : null}
        <button
          type="button"
          className="toolbar__btn"
          onClick={onOpenFolder}
          title="Open a local folder"
          aria-label="Open Folder"
        >
          <FolderOpenIcon />
        </button>
        <button
          type="button"
          className="toolbar__btn"
          onClick={onSave}
          disabled={!canSave}
          title="Save (Ctrl+S / Cmd+S)"
          aria-label="Save"
        >
          <SaveIcon />
          {dirty && canSave ? (
            <span className="toolbar__dirty-dot" aria-label="Unsaved changes" />
          ) : null}
        </button>
      </div>
      <div className="toolbar__center" data-tauri-drag-region>
        <span className="toolbar__file" data-tauri-drag-region>
          {dirty && canSave ? (
            <span className="toolbar__dirty-mark" aria-hidden="true">
              ●
            </span>
          ) : null}
          <span className="toolbar__file-name" data-tauri-drag-region>
            {fileName ?? "opencode-desktop"}
          </span>
          {dirty && canSave ? (
            <span className="toolbar__dirty-suffix">— modified</span>
          ) : null}
        </span>
      </div>
      <div className="toolbar__right" data-tauri-drag-region>
        <button
          type="button"
          className={
            "toolbar__btn" +
            (chatVisible ? " toolbar__btn--active" : "")
          }
          onClick={onToggleChat}
          title={chatVisible ? "Hide chat panel" : "Show chat panel"}
          aria-label="Chat"
          aria-pressed={chatVisible}
        >
          <ChatIcon />
        </button>
        <button
          type="button"
          className={
            "toolbar__btn" +
            (terminalVisible ? " toolbar__btn--active" : "")
          }
          onClick={onToggleTerminal}
          title={terminalVisible ? "Hide terminal" : "Show terminal"}
          aria-label="Terminal"
          aria-pressed={terminalVisible}
        >
          <TerminalIcon />
        </button>
        <button
          type="button"
          className="toolbar__btn"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <GearIcon />
        </button>
        {IS_MAC ? null : <WindowControls />}
      </div>
    </header>
  );
}

// macOS traffic-light controls, shown at the top-left. Order matches the
// native convention: close, minimize, zoom (maximize). Glyphs reveal on hover.
function MacWindowControls(): React.JSX.Element {
  const win = getCurrentWindow();
  return (
    <div className="mac-window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="mac-window-controls__btn mac-window-controls__btn--close"
        onClick={() => {
          void win.close();
        }}
        title="Close"
        aria-label="Close"
      >
        <svg width="7" height="7" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="mac-window-controls__btn mac-window-controls__btn--min"
        onClick={() => {
          void win.minimize();
        }}
        title="Minimize"
        aria-label="Minimize"
      >
        <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="mac-window-controls__btn mac-window-controls__btn--zoom"
        onClick={() => {
          void win.toggleMaximize();
        }}
        title="Zoom"
        aria-label="Zoom"
      >
        <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// Custom window controls for the frameless window (decorations: false).
function WindowControls(): React.JSX.Element {
  const win = getCurrentWindow();
  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-controls__btn"
        onClick={() => {
          void win.minimize();
        }}
        title="Minimize"
        aria-label="Minimize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        className="window-controls__btn"
        onClick={() => {
          void win.toggleMaximize();
        }}
        title="Maximize"
        aria-label="Maximize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect
            x="0.5"
            y="0.5"
            width="9"
            height="9"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
        </svg>
      </button>
      <button
        type="button"
        className="window-controls__btn window-controls__btn--close"
        onClick={() => {
          void win.close();
        }}
        title="Close"
        aria-label="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M0 0l10 10M10 0L0 10"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      </button>
    </div>
  );
}

function FolderOpenIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M1.5 4h4l1.5 1.5h7.5v7a1 1 0 0 1-1 1H1.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

function SaveIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M2 2h9l3 3v9H2V2z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
      <path d="M5 2v4h5V2" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path
        d="M4 12h8v2H4z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

function ChatIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M2 3h12v8H6.5L4 13v-2H2V3z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TerminalIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M3.5 6.5 L6 8.5 L3.5 10.5 M7.5 10.5 L11 10.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function GearIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M7.2 1.2h1.6l.3 1.6a5.6 5.6 0 0 1 1.3.6l1.5-.7 1.1 1.1-.7 1.5c.3.4.5.8.6 1.3l1.6.3v1.6l-1.6.3a5.6 5.6 0 0 1-.6 1.3l.7 1.5-1.1 1.1-1.5-.7a5.6 5.6 0 0 1-1.3.6l-.3 1.6H7.2l-.3-1.6a5.6 5.6 0 0 1-1.3-.6l-1.5.7-1.1-1.1.7-1.5a5.6 5.6 0 0 1-.6-1.3L1.5 8V6.4l1.6-.3a5.6 5.6 0 0 1 .6-1.3l-.7-1.5 1.1-1.1 1.5.7a5.6 5.6 0 0 1 1.3-.6Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        fill="none"
      />
      <circle
        cx="8"
        cy="8"
        r="2.2"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="none"
      />
    </svg>
  );
}