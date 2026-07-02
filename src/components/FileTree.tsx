import { useCallback, useEffect, useRef, useState } from "react";
import { fs, type FileEntry } from "../lib/fs";
import { getFileName } from "../lib/language";

interface FileTreeProps {
  rootPath: string | null;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  gitStatuses: Record<string, string>;
  /** Bump to re-list every currently-loaded directory (e.g. after a write). */
  refreshToken?: number;
}

interface NodeState {
  entries: FileEntry[] | null;
  expanded: boolean;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: NodeState = {
  entries: null,
  expanded: false,
  loading: false,
  error: null,
};

export function FileTree({
  rootPath,
  selectedPath,
  onOpenFile,
  gitStatuses,
  refreshToken,
}: FileTreeProps): React.JSX.Element {
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const nodesRef = useRef<Record<string, NodeState>>({});
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    setNodes({});
    if (rootPath === null) return;
    void loadChildren(rootPath, true);
  }, [rootPath]);

  const loadChildren = useCallback(
    async (path: string, expandedAfter: boolean): Promise<void> => {
      setNodes((prev) => ({
        ...prev,
        [path]: {
          entries: prev[path]?.entries ?? null,
          expanded: expandedAfter ? true : prev[path]?.expanded ?? false,
          loading: true,
          error: null,
        },
      }));
      try {
        const entries = await fs.listDir(path);
        const sorted = [...entries].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          });
        });
        setNodes((prev) => ({
          ...prev,
          [path]: {
            entries: sorted,
            expanded: expandedAfter ? true : prev[path]?.expanded ?? true,
            loading: false,
            error: null,
          },
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setNodes((prev) => ({
          ...prev,
          [path]: {
            entries: prev[path]?.entries ?? null,
            expanded: prev[path]?.expanded ?? true,
            loading: false,
            error: msg,
          },
        }));
      }
    },
    [],
  );

  const toggle = useCallback(
    (path: string): void => {
      const current = nodes[path] ?? INITIAL_STATE;
      if (current.expanded) {
        setNodes((prev) => ({
          ...prev,
          [path]: { ...current, expanded: false },
        }));
        return;
      }
      // Always re-list on expand so freshly created/deleted entries appear;
      // cached entries stay visible while the reload is in flight.
      void loadChildren(path, true);
    },
    [nodes, loadChildren],
  );

  // Re-list every directory already loaded when the refresh token changes
  // (e.g. after the agent writes a file). Keeps the tree in sync with disk.
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === 0 || rootPath === null) {
      return;
    }
    for (const [path, state] of Object.entries(nodesRef.current)) {
      if (state.entries !== null && state.expanded) {
        void loadChildren(path, true);
      }
    }
  }, [refreshToken, rootPath, loadChildren]);

  if (rootPath === null) {
    return (
      <aside className="file-tree file-tree--empty">
        <div className="file-tree__hint">No folder open</div>
      </aside>
    );
  }

  return (
    <aside className="file-tree">
      <div className="file-tree__header">
        <span className="file-tree__header-label">Explorer</span>
        <span className="file-tree__root-name" title={rootPath}>
          {getFileName(rootPath)}
        </span>
      </div>
      <div className="file-tree__body">
        <TreeNode
          path={rootPath}
          depth={0}
          name={getFileName(rootPath)}
          isDir
          root
          nodeState={nodes[rootPath] ?? INITIAL_STATE}
          nodes={nodes}
          onToggle={toggle}
          onOpenFile={onOpenFile}
          selectedPath={selectedPath}
          gitStatuses={gitStatuses}
        />
      </div>
    </aside>
  );
}

interface TreeNodeProps {
  path: string;
  depth: number;
  name: string;
  isDir: boolean;
  root: boolean;
  nodeState: NodeState;
  nodes: Record<string, NodeState>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
  gitStatuses: Record<string, string>;
}

function TreeNode({
  path,
  depth,
  name,
  isDir,
  root,
  nodeState,
  nodes,
  onToggle,
  onOpenFile,
  selectedPath,
  gitStatuses,
}: TreeNodeProps): React.JSX.Element {
  const indent = { paddingLeft: `${depth * 16 + 8}px` };
  const isSelected = !isDir && selectedPath === path;
  const gitStatus = isDir ? undefined : gitStatuses[path];
  const className = [
    "tree-row",
    isSelected ? "tree-row--selected" : "",
    isDir ? "tree-row--dir" : "tree-row--file",
    gitStatus !== undefined ? `tree-row--git-${gitStatus}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        className={className}
        style={indent}
        onClick={() => {
          if (isDir) {
            onToggle(path);
          } else {
            onOpenFile(path);
          }
        }}
      >
        <span className="tree-row__chevron" aria-hidden="true">
          {isDir ? (nodeState.expanded ? "▾" : "▸") : ""}
        </span>
        <span className="tree-row__icon" aria-hidden="true">
          {isDir ? (
            <FolderIcon open={nodeState.expanded} />
          ) : (
            <FileIcon />
          )}
        </span>
        <span className="tree-row__name" title={path}>
          {root ? name : name}
        </span>
        {nodeState.loading ? (
          <span className="tree-row__spinner" aria-hidden="true" />
        ) : null}
      </div>
      {isDir && nodeState.expanded && nodeState.entries !== null
        ? nodeState.entries.map((entry) => (
<TreeNode
            key={entry.path}
            path={entry.path}
            depth={depth + 1}
            name={entry.name}
            isDir={entry.isDir}
            root={false}
            nodeState={nodes[entry.path] ?? INITIAL_STATE}
            nodes={nodes}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            selectedPath={selectedPath}
            gitStatuses={gitStatuses}
          />
          ))
        : null}
      {isDir && nodeState.expanded && nodeState.error !== null ? (
        <div
          className="tree-error"
          style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
        >
          {nodeState.error}
        </div>
      ) : null}
    </>
  );
}

function FolderIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {open ? (
        <path
          d="M1.5 3.5h4l1.5 1.5h7.5v8.5a1 1 0 0 1-1 1H1.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"
          fill="#dcb67a"
          stroke="#dcb67a"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M1.5 3.5h4l1.5 1.5h7.5v8.5a1 1 0 0 1-1 1H1.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"
          fill="#c5c5c5"
          stroke="#c5c5c5"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function FileIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3 1.5h6.5L13 5v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"
        fill="none"
        stroke="#8a8a8a"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 1.5V5H13"
        fill="none"
        stroke="#8a8a8a"
        strokeLinejoin="round"
      />
    </svg>
  );
}