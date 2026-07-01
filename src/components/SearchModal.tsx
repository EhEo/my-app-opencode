import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fs, type SearchResult } from "../lib/fs";

interface SearchModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (result: SearchResult) => void;
}

export function SearchModal({
  open,
  onClose,
  onSelect,
}: SearchModalProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const runSearch = useCallback(async (): Promise<void> => {
    if (query.trim() === "") {
      setResults([]);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fs.searchWorkspace(
        query,
        useRegex,
        includeGlob.trim() === "" ? null : includeGlob.trim(),
        excludeGlob.trim() === "" ? null : excludeGlob.trim(),
      );
      setResults(r);
      setActiveIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, [query, useRegex, includeGlob, excludeGlob]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      void runSearch();
    }, 200);
    return () => {
      window.clearTimeout(id);
    };
  }, [open, runSearch]);

  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const arr = map.get(r.path);
      if (arr === undefined) map.set(r.path, [r]);
      else arr.push(r);
    }
    return Array.from(map.entries());
  }, [results]);

  const flatIndex = useCallback(
    (fileIdx: number, hitIdx: number): number => {
      let n = 0;
      for (let i = 0; i < fileIdx; i++) {
        const entry = grouped[i];
        if (entry !== undefined) n += entry[1].length;
      }
      return n + hitIdx;
    },
    [grouped],
  );

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIndex];
      if (r !== undefined) {
        onSelect(r);
        onClose();
      }
    }
  };

  return (
    <div
      className="search-modal__backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="search-modal__panel"
        role="dialog"
        aria-modal="true"
        onKeyDown={handleKeyDown}
      >
        <div className="search-modal__input-row">
          <input
            ref={inputRef}
            type="text"
            className="search-modal__input"
            placeholder="Search workspace…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="search-modal__checkbox">
            <input
              type="checkbox"
              checked={useRegex}
              onChange={(e) => setUseRegex(e.target.checked)}
            />
            <span>regex</span>
          </label>
          <input
            type="text"
            className="search-modal__glob"
            placeholder="include glob"
            value={includeGlob}
            onChange={(e) => setIncludeGlob(e.target.value)}
          />
          <input
            type="text"
            className="search-modal__glob"
            placeholder="exclude glob"
            value={excludeGlob}
            onChange={(e) => setExcludeGlob(e.target.value)}
          />
          <button
            type="button"
            className="search-modal__close"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        {error !== null ? (
          <div className="search-modal__error">{error}</div>
        ) : null}
        <div className="search-modal__results">
          {busy ? <div className="search-modal__hint">검색 중…</div> : null}
          {!busy && query.trim() !== "" && results.length === 0 ? (
            <div className="search-modal__hint">결과 없음</div>
          ) : null}
          {grouped.map(([path, hits], fileIdx) => (
            <div key={path} className="search-modal__file">
              <div className="search-modal__file-name" title={path}>
                {path}
              </div>
              {hits.map((r, hitIdx) => {
                const idx = flatIndex(fileIdx, hitIdx);
                return (
                  <button
                    type="button"
                    key={`${r.path}:${r.line}:${r.column}`}
                    className={`search-modal__hit${
                      idx === activeIndex ? " search-modal__hit--active" : ""
                    }`}
                    onClick={() => {
                      onSelect(r);
                      onClose();
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <span className="search-modal__hit-pos">
                      {r.line}:{r.column}
                    </span>
                    <span className="search-modal__hit-preview">{r.preview}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}