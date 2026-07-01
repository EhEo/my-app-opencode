import type { CursorPosition } from "./EditorPane";

interface StatusBarProps {
  filePath: string | null;
  language: string | null;
  position: CursorPosition | null;
  dirty: boolean;
  diskConflict: boolean;
  onReloadFromDisk: () => void;
  gitStatus: string | null;
  wrapEnabled: boolean;
  onToggleWrap: () => void;
}

export function StatusBar({
  filePath,
  language,
  position,
  dirty,
  diskConflict,
  onReloadFromDisk,
  gitStatus,
  wrapEnabled,
  onToggleWrap,
}: StatusBarProps): React.JSX.Element {
  const wrapLabel = wrapEnabled ? "Wrap: On" : "Wrap: Off";
  return (
    <footer className="status-bar">
      <div className="status-bar__group status-bar__group--left">
        <span className="status-bar__path" title={filePath ?? ""}>
          {filePath ?? "No file"}
        </span>
        {dirty ? (
          <span
            className="status-bar__dirty"
            aria-label="Unsaved changes"
            title="Unsaved changes"
          >
            ●
          </span>
        ) : null}
        {diskConflict ? (
          <button
            type="button"
            className="status-bar__conflict"
            onClick={onReloadFromDisk}
            title="디스크에서 파일이 변경되었습니다. 클릭하면 디스크 버전을 불러옵니다(저장하지 않은 편집은 사라집니다)."
          >
            ⚠ 디스크 변경 — 다시 불러오기
          </button>
        ) : null}
      </div>
      <div className="status-bar__group status-bar__group--right">
        {gitStatus !== null ? (
          <span
            className={`status-bar__git status-bar__git--${gitStatus}`}
            title={`Git status: ${gitStatus}`}
          >
            {gitStatus === "modified" || gitStatus === "staged-modified"
              ? "M"
              : gitStatus === "added" || gitStatus === "staged-added"
                ? "A"
                : gitStatus === "deleted" || gitStatus === "staged-deleted"
                  ? "D"
                  : gitStatus === "untracked"
                    ? "U"
                    : gitStatus === "renamed"
                      ? "R"
                      : gitStatus === "copied"
                        ? "C"
                        : "?"}
          </span>
        ) : null}
        {language !== null ? (
          <span className="status-bar__lang">{language}</span>
        ) : null}
        {position !== null ? (
          <span className="status-bar__pos">
            Ln {position.line}, Col {position.column}
          </span>
        ) : null}
        <button
          type="button"
          className="status-bar__btn"
          onClick={onToggleWrap}
          title="Toggle word wrap"
        >
          {wrapLabel}
        </button>
      </div>
    </footer>
  );
}
