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
  // Compact action bar, rendered inline at the right of the tab row so it no
  // longer needs a dedicated toolbar row (reclaims vertical space for editing).
  void fileName;
  return (
    <div className="editor-actions">
      <button
        type="button"
        className="toolbar__btn toolbar__btn--icon"
        onClick={onOpenFolder}
        title="Open a local folder"
        aria-label="Open folder"
      >
        <FolderOpenIcon />
      </button>
      <button
        type="button"
        className="toolbar__btn toolbar__btn--icon"
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
      <span className="editor-actions__divider" aria-hidden="true" />
      <button
        type="button"
        className={"toolbar__btn" + (chatVisible ? " toolbar__btn--active" : "")}
        onClick={onToggleChat}
        title={chatVisible ? "Hide chat panel" : "Show chat panel"}
        aria-pressed={chatVisible}
      >
        <ChatIcon />
        <span>Chat</span>
      </button>
      <button
        type="button"
        className={
          "toolbar__btn" + (terminalVisible ? " toolbar__btn--active" : "")
        }
        onClick={onToggleTerminal}
        title={terminalVisible ? "Hide terminal" : "Show terminal"}
        aria-pressed={terminalVisible}
      >
        <TerminalIcon />
        <span>Terminal</span>
      </button>
      <button
        type="button"
        className="toolbar__btn toolbar__btn--icon"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <GearIcon />
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