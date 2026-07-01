import { useCallback } from "react";
import { getFileName } from "../lib/language";

export interface TabInfo {
  path: string;
  dirty: boolean;
}

interface TabsProps {
  tabs: TabInfo[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

export function Tabs({
  tabs,
  activePath,
  onSelect,
  onClose,
}: TabsProps): React.JSX.Element | null {
  const handleCloseClick = useCallback(
    (e: React.MouseEvent, path: string) => {
      e.stopPropagation();
      onClose(path);
    },
    [onClose],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, path: string) => {
      if (e.button === 1) {
        e.preventDefault();
        onClose(path);
      }
    },
    [onClose],
  );

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.path === activePath;
        const name = getFileName(tab.path);
        const className = [
          "tab",
          isActive ? "tab--active" : "",
          tab.dirty ? "tab--dirty" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={isActive}
            title={tab.path}
            className={className}
            onClick={() => {
              onSelect(tab.path);
            }}
            onMouseDown={(e) => {
              handleMouseDown(e, tab.path);
            }}
          >
            <span className="tab__icon" aria-hidden="true">
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M3 1.5h6.5L13 5v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"
                  fill="none"
                  stroke="currentColor"
                  strokeLinejoin="round"
                  strokeWidth="1.1"
                />
                <path
                  d="M9.5 1.5V5H13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                />
              </svg>
            </span>
            <span className="tab__name">{name}</span>
            {tab.dirty ? (
              <span className="tab__dirty" aria-label="Unsaved changes">
                ●
              </span>
            ) : null}
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${name}`}
              tabIndex={isActive ? 0 : -1}
              onClick={(e) => {
                handleCloseClick(e, tab.path);
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M2 2l6 6M8 2l-6 6"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
