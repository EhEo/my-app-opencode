import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
}

export const fs = {
  listDir: (path: string): Promise<FileEntry[]> =>
    invoke<FileEntry[]>("list_dir", { path }),
  readFile: (path: string): Promise<string> =>
    invoke<string>("read_file", { path }),
  statFile: (path: string): Promise<FileStat> =>
    invoke<FileStat>("stat_file", { path }),
  writeFile: (path: string, content: string): Promise<void> =>
    invoke<void>("write_file", { path, content }),
  createEntry: (path: string, isDir: boolean): Promise<void> =>
    invoke<void>("create_entry", { path, isDir }),
  deleteEntry: (path: string): Promise<void> =>
    invoke<void>("delete_entry", { path }),
  renameEntry: (from: string, to: string): Promise<void> =>
    invoke<void>("rename_entry", { from, to }),
  pickFolder: (): Promise<string | null> =>
    invoke<string | null>("pick_folder"),
  setWorkspaceRoot: (path: string | null): Promise<void> =>
    invoke<void>("set_workspace_root", { path }),
  searchWorkspace: (
    pattern: string,
    useRegex: boolean,
    includeGlob: string | null,
    excludeGlob: string | null,
  ): Promise<SearchResult[]> =>
    invoke<SearchResult[]>("search_workspace", {
      pattern,
      useRegex,
      includeGlob,
      excludeGlob,
    }),
  gitStatus: (): Promise<GitFileStatus[]> =>
    invoke<GitFileStatus[]>("git_status"),
  readFileBytes: (path: string): Promise<{ base64: string; size: number }> =>
    invoke<{ base64: string; size: number }>("read_file_bytes", { path }),
};