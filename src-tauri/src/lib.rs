// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use futures_util::StreamExt;
use regex::Regex;
use serde::Serialize;
use tauri::ipc::Channel;
use walkdir::WalkDir;
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

pub struct AppState {
    root: Mutex<Option<PathBuf>>,
}

/// Security gate for every filesystem command.
///
/// `canonicalize()` resolves both `..` segments and symlinks to their real
/// targets, then we confirm the result is still inside the canonical root.
/// This is what defeats path traversal AND symlink escapes — regex/string
/// checks on `..` alone would miss symlinked directories pointing outside.
///
/// For paths that do not yet exist (write/create targets), canonicalize would
/// fail, so we canonicalize the parent and re-attach the file name. The parent
/// must already exist and be inside the root.
fn validate_path(raw: &str, root: &Path) -> Result<PathBuf, String> {
    let candidate = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };

    // dunce::canonicalize avoids the Windows `\\?\` verbatim prefix that plain
    // std canonicalize emits — that prefix breaks cmd.exe cwd (UNC fallback to
    // C:\Windows) and leaks into every path handed to the frontend / Monaco.
    let canon_root = dunce::canonicalize(root)
        .map_err(|e| format!("failed to canonicalize root: {e}"))?;

    let canon = match dunce::canonicalize(&candidate) {
        Ok(p) => p,
        Err(_) => {
            // Target does not exist yet (write/create). Resolve the deepest
            // existing ancestor, then re-attach the remaining components so
            // callers can create nested directories (e.g. src/a/b/new.ts).
            // Reject `..`/`.` in the not-yet-existing tail to keep the
            // traversal guard intact.
            let mut existing = candidate.as_path();
            let mut tail: Vec<std::ffi::OsString> = Vec::new();
            loop {
                let parent = existing
                    .parent()
                    .ok_or_else(|| "failed to canonicalize parent".to_string())?;
                let name = existing
                    .file_name()
                    .ok_or_else(|| "invalid path component".to_string())?;
                tail.push(name.to_os_string());
                if parent.exists() {
                    let canon_parent = dunce::canonicalize(parent)
                        .map_err(|e| format!("failed to canonicalize parent: {e}"))?;
                    let mut resolved = canon_parent;
                    for comp in tail.iter().rev() {
                        if comp == ".." || comp == "." {
                            return Err("path outside workspace".to_string());
                        }
                        resolved.push(comp);
                    }
                    break resolved;
                }
                existing = parent;
            }
        }
    };

    if !canon.starts_with(&canon_root) {
        return Err("path outside workspace".to_string());
    }
    Ok(canon)
}

/// Suppress the console window Windows would otherwise flash for each child
/// process (git, taskkill, cmd) in a release/windowed build. No-op elsewhere.
#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// Reject skill names that could escape the skills directory.
fn validate_skill_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("skill name is empty".to_string());
    }
    if n == "." || n == ".." || n.contains('/') || n.contains('\\') {
        return Err("invalid skill name".to_string());
    }
    Ok(n.to_string())
}

fn require_root(state: &AppState) -> Result<PathBuf, String> {
    let guard = state
        .root
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;
    guard
        .clone()
        .ok_or_else(|| "no workspace root set".to_string())
}

// Serialized as camelCase so the React frontend consumes { name, path, isDir, size }.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

#[tauri::command(rename_all = "camelCase")]
fn set_workspace_root(path: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state
        .root
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;
    match path {
        Some(p) => {
            let canon = dunce::canonicalize(&p)
                .map_err(|e| format!("failed to canonicalize root: {e}"))?;
            if !canon.is_dir() {
                return Err("workspace root is not a directory".to_string());
            }
            *guard = Some(canon);
        }
        None => {
            *guard = None;
        }
    }
    Ok(())
}

// Sort order contracted to the frontend: directories first, then files,
// alphabetical case-insensitive within each group. Hidden entries included.
#[tauri::command(rename_all = "camelCase")]
fn list_dir(path: String, state: State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
    let root = require_root(&state)?;
    let target = validate_path(&path, &root)?;
    if !target.is_dir() {
        return Err("path is not a directory".to_string());
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    for entry in fs::read_dir(&target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

// Binary files are rejected: the editor is text-only in Phase 1.
const MAX_READ_BYTES: u64 = 20_000_000;

#[tauri::command(rename_all = "camelCase")]
fn read_file(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = require_root(&state)?;
    let target = validate_path(&path, &root)?;
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "file is too large to open ({} bytes, limit {MAX_READ_BYTES})",
            meta.len()
        ));
    }
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    let text =
        String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 / binary".to_string())?;
    // Strip a leading UTF-8 BOM so it doesn't surface as a stray U+FEFF glyph.
    Ok(text
        .strip_prefix('\u{feff}')
        .map(str::to_string)
        .unwrap_or(text))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileStat {
    mtime_ms: u64,
    size: u64,
}

#[tauri::command(rename_all = "camelCase")]
fn stat_file(path: String, state: State<'_, AppState>) -> Result<FileStat, String> {
    let root = require_root(&state)?;
    let target = validate_path(&path, &root)?;
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        mtime_ms,
        size: meta.len(),
    })
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GitFileStatus {
    path: String,
    status: String,
}

#[derive(serde::Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolUsage {
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    by_tool: std::collections::BTreeMap<String, ToolUsage>,
}

/// Recursively sum any nested `usage` object's token fields into `acc`.
/// Tolerant of both Claude (`input_tokens`/`output_tokens`) and
/// OpenAI/Codex (`prompt_tokens`/`completion_tokens`) shapes.
fn add_usage_from_value(v: &serde_json::Value, acc: &mut ToolUsage) {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::Object(u)) = map.get("usage") {
                let get = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                acc.input_tokens += get("input_tokens") + get("prompt_tokens");
                acc.output_tokens += get("output_tokens") + get("completion_tokens");
            }
            for (_k, val) in map {
                add_usage_from_value(val, acc);
            }
        }
        serde_json::Value::Array(arr) => {
            for val in arr {
                add_usage_from_value(val, acc);
            }
        }
        _ => {}
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn git_status(state: State<'_, AppState>) -> Result<Vec<GitFileStatus>, String> {
    let root = require_root(&state)?;
    tokio::task::spawn_blocking(move || git_status_blocking(&root))
        .await
        .map_err(|e| e.to_string())?
}

fn git_status_blocking(root: &Path) -> Result<Vec<GitFileStatus>, String> {
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }
    let mut cmd = Command::new("git");
    cmd.args([
        "-C",
        &root.to_string_lossy(),
        // quotepath=false keeps non-ASCII (e.g. Korean) filenames literal UTF-8
        // instead of C-style octal escapes that never match the tree keys.
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=1",
        "--untracked-files=all",
        "--ignored=no",
    ])
    .env("GIT_TERMINAL_PROMPT", "0");
    no_window(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut results: Vec<GitFileStatus> = Vec::new();
    // --porcelain=1 format: "XY <path>" (or "XY <orig> -> <path>" for R/C).
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let rest = &line[3..];
        let raw_path = if index == 'R' || index == 'C' {
            rest.split(" -> ").nth(1).unwrap_or(rest)
        } else {
            rest
        };
        let raw_path = raw_path.trim().trim_matches('"');
        if raw_path.is_empty() {
            continue;
        }
        let status = match (index, worktree) {
            ('?', '?') => "untracked",
            ('M', ' ') => "staged-modified",
            (' ', 'M') | ('M', 'M') => "modified",
            ('A', ' ') => "staged-added",
            (' ', 'A') | ('A', 'A') => "added",
            ('D', ' ') => "staged-deleted",
            (' ', 'D') | ('D', 'D') => "deleted",
            ('R', _) => "renamed",
            ('C', _) => "copied",
            _ if worktree == 'M' => "modified",
            _ if worktree == 'D' => "deleted",
            _ if worktree == 'A' => "added",
            _ if index != ' ' => "staged-modified",
            _ => continue,
        };
        // Normalize git's forward-slash relative path to the OS separator so it
        // matches the tree/tab keys the frontend builds from list_dir.
        let rel: PathBuf = Path::new(raw_path).components().collect();
        results.push(GitFileStatus {
            path: root.join(rel).to_string_lossy().into_owned(),
            status: status.to_string(),
        });
    }
    Ok(results)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    path: String,
    line: u32,
    column: u32,
    preview: String,
}

const MAX_RESULTS: usize = 500;
const MAX_FILE_BYTES: u64 = 5_000_000;

// Directories skipped during search: build/dependency output that would both
// slow the walk and flood the 500-result cap with junk.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".svelte-kit",
    "out",
    ".venv",
    "__pycache__",
];

fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

#[tauri::command(rename_all = "camelCase")]
async fn search_workspace(
    pattern: String,
    use_regex: bool,
    include_glob: Option<String>,
    exclude_glob: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let root = require_root(&state)?;
    tokio::task::spawn_blocking(move || {
        search_workspace_blocking(pattern, use_regex, include_glob, exclude_glob, &root)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn search_workspace_blocking(
    pattern: String,
    use_regex: bool,
    include_glob: Option<String>,
    exclude_glob: Option<String>,
    root: &Path,
) -> Result<Vec<SearchResult>, String> {
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let compiled: Regex = if use_regex {
        Regex::new(&pattern).map_err(|e| e.to_string())?
    } else {
        Regex::new(&regex::escape(&pattern)).map_err(|e| e.to_string())?
    };
    let include_re = match include_glob.as_deref() {
        Some(g) if !g.is_empty() => Some(glob_to_regex(g).map_err(|e| e.to_string())?),
        _ => None,
    };
    let exclude_re = match exclude_glob.as_deref() {
        Some(g) if !g.is_empty() => Some(glob_to_regex(g).map_err(|e| e.to_string())?),
        _ => None,
    };
    let mut results: Vec<SearchResult> = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !(e.file_type().is_dir()
                && is_ignored_dir(e.file_name().to_str().unwrap_or("")))
        });
    'outer: for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // glob patterns use '/'; normalize the Windows '\' rel path to match.
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if let Some(re) = &exclude_re {
            if re.is_match(&rel_str) {
                continue;
            }
        }
        if let Some(re) = &include_re {
            if !re.is_match(&rel_str) {
                continue;
            }
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (idx, line) in content.lines().enumerate() {
            if let Some(mat) = compiled.find(line) {
                let start = mat.start();
                let prefix_start = floor_char_boundary(line, start.saturating_sub(40));
                let suffix_end = ceil_char_boundary(line, (start + mat.len() + 40).min(line.len()));
                let prefix = &line[prefix_start..start];
                let matched = &line[start..start + mat.len()];
                let suffix = &line[start + mat.len()..suffix_end];
                let mut preview = String::new();
                if prefix_start > 0 {
                    preview.push_str("…");
                }
                preview.push_str(prefix);
                preview.push_str("⟦");
                preview.push_str(matched);
                preview.push_str("⟧");
                preview.push_str(suffix);
                if suffix_end < line.len() {
                    preview.push('…');
                }
                results.push(SearchResult {
                    path: path.to_string_lossy().to_string(),
                    line: (idx as u32) + 1,
                    column: (column_for(line, start) as u32) + 1,
                    preview,
                });
                if results.len() >= MAX_RESULTS {
                    break 'outer;
                }
            }
        }
    }
    Ok(results)
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) { i -= 1; }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) { i += 1; }
    i
}

fn glob_to_regex(glob: &str) -> Result<Regex, String> {
    let mut s = String::from("^");
    let bytes = glob.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'*' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                    s.push_str(".*");
                    i += 2;
                } else {
                    s.push_str("[^/]*");
                    i += 1;
                }
            }
            b'?' => {
                s.push_str("[^/]");
                i += 1;
            }
            b'.' | b'(' | b')' | b'+' | b'|' | b'^' | b'$' | b'\\' | b'[' | b']' | b'{' | b'}' => {
                s.push('\\');
                s.push(b as char);
                i += 1;
            }
            _ => {
                s.push(b as char);
                i += 1;
            }
        }
    }
    s.push('$');
    Regex::new(&s).map_err(|e| e.to_string())
}

fn column_for(line: &str, byte_offset: usize) -> usize {
    line[..byte_offset].chars().count()
}

#[tauri::command(rename_all = "camelCase")]
fn write_file(path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = require_root(&state)?;
    let target = validate_path(&path, &root)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Write to a sibling temp file then rename, so a crash / disk-full mid-write
    // can't truncate the existing file to garbage. rename is atomic and replaces
    // the destination on both Unix and Windows.
    let tmp = target.with_extension(format!(
        "{}.tmp",
        target
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
    ));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command(rename_all = "camelCase")]
fn create_entry(path: String, is_dir: bool, state: State<'_, AppState>) -> Result<(), String> {
    let root = require_root(&state)?;
    let target = validate_path(&path, &root)?;
    if is_dir {
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn delete_entry(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = require_root(&state)?;
    let target = validate_path(&path, &root)?;
    let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

#[tauri::command(rename_all = "camelCase")]
fn rename_entry(from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = require_root(&state)?;
    let from_path = validate_path(&from, &root)?;
    let to_path = validate_path(&to, &root)?;
    fs::rename(&from_path, &to_path).map_err(|e| e.to_string())
}

// rfd's blocking API avoids the async-callback plumbing the tauri-plugin-dialog
// pick_folder would require; the picker runs on the command thread and returns
// the choice directly.
#[tauri::command(rename_all = "camelCase")]
fn pick_folder() -> Result<Option<String>, String> {
    let choice = rfd::FileDialog::new()
        .set_title("Open Folder")
        .pick_folder();
    Ok(choice.map(|p| p.to_string_lossy().into_owned()))
}

// === Phase 3 AI agent commands ===
//
// Frontend contract (camelCase via `rename_all`):
//   invoke('run_command', { command }) -> { stdout, stderr, exitCode }
//   invoke('get_settings')             -> { baseUrl, apiKey, model } | null
//   invoke('set_settings', { settings }) -> void

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

// settings.json is stored as an opaque JSON blob (serde_json::Value): the
// frontend owns the schema (multi-provider provider store) and Rust just
// persists/loads it verbatim. This decouples the backend from provider-model
// details.

/// Spawns `sh -c <command>` with cwd pinned to the workspace root, captures
/// stdout+stderr, and enforces a 30s wall-clock timeout (kills the child on
/// expiry). The cwd confinement is the security boundary — the command string
/// itself is intentionally unfiltered, since the agent needs execution
/// flexibility within the open workspace.
/// Builds `cmd /C <command>` (Windows) or `sh -c <command>` (Unix). On Windows
/// the whole `/C <command>` is passed with raw_arg so std does not re-quote it —
/// preserving quotes/redirection the way a real shell prompt would.
fn build_shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut b = Command::new("cmd");
        b.raw_arg(format!("/C {command}"));
        b
    }
    #[cfg(not(windows))]
    {
        let mut b = Command::new("sh");
        b.arg("-c").arg(command);
        b
    }
}

/// Kills the child AND its descendants. Killing only the direct child (cmd.exe)
/// leaves grandchildren (e.g. node) alive as zombies that also keep the output
/// pipes open, hanging the reader threads.
#[cfg(windows)]
fn kill_process_tree(child: &mut std::process::Child) {
    let pid = child.id().to_string();
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid, "/T", "/F"]);
    no_window(&mut cmd);
    let _ = cmd.output();
    let _ = child.wait();
}
#[cfg(not(windows))]
fn kill_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command(rename_all = "camelCase")]
async fn run_command(command: String, state: State<'_, AppState>) -> Result<CommandResult, String> {
    let root = require_root(&state)?;
    tokio::task::spawn_blocking(move || run_command_blocking(command, root))
        .await
        .map_err(|e| e.to_string())?
}

fn run_command_blocking(command: String, root: PathBuf) -> Result<CommandResult, String> {
    let mut builder = build_shell_command(&command);
    builder
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut builder);
    let mut child = builder.spawn().map_err(|e| e.to_string())?;

    // Drain stdout/stderr on helper threads so subprocess writes never block
    // on a full OS pipe buffer (~64KB on Linux) — that would deadlock wait().
    let mut stdout_pipe = child.stdout.take().expect("stdout piped above");
    let mut stderr_pipe = child.stderr.take().expect("stderr piped above");

    let stdout_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    // wait() blocks indefinitely, so we run it in a helper thread and apply
    // recv_timeout(30s) on the main thread. We poll try_wait() (rather than
    // calling wait()) so the lock is held only briefly — letting the main
    // thread acquire it for kill() if the deadline elapses.
    let child = Arc::new(Mutex::new(child));
    let child_for_wait = Arc::clone(&child);
    let (tx, rx) = mpsc::channel::<std::io::Result<std::process::ExitStatus>>();
    thread::spawn(move || {
        let outcome = loop {
            let polled = {
                let mut guard = match child_for_wait.lock() {
                    Ok(g) => g,
                    Err(_) => break Err(std::io::Error::other("child lock poisoned")),
                };
                match guard.try_wait() {
                    Ok(opt) => opt,
                    Err(e) => break Err(e),
                }
            };
            if let Some(status) = polled {
                break Ok(status);
            }
            thread::sleep(Duration::from_millis(10));
        };
        let _ = tx.send(outcome);
    });

    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(status)) => {
            let stdout = stdout_thread.join().unwrap_or_default();
            let stderr = stderr_thread.join().unwrap_or_default();
            Ok(CommandResult {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                exit_code: status.code().unwrap_or(-1),
            })
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(RecvTimeoutError::Timeout) => {
            // Kill the whole process tree + reap so we don't leak zombies and
            // so the output pipes close, letting the reader threads finish.
            if let Ok(mut guard) = child.lock() {
                kill_process_tree(&mut guard);
            }
            // Join readers so the helper threads don't outlive the call.
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            Err("command timed out after 30s".to_string())
        }
        Err(RecvTimeoutError::Disconnected) => Err("worker thread panicked".to_string()),
    }
}

#[tauri::command(rename_all = "camelCase")]
fn get_settings(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let file = dir.join("settings.json");
    if !file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            // A truncated/corrupt settings.json (e.g. crash mid-write) must not
            // hard-fail the whole settings UI. Move it aside and start fresh.
            let _ = fs::rename(&file, dir.join("settings.json.bak"));
            Ok(None)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn set_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("settings.json");
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // Atomic replace: write temp then rename, so a crash can't leave a
    // half-written settings.json that locks the user out on next launch.
    let tmp = dir.join("settings.json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command(rename_all = "camelCase")]
fn read_usage_logs(app: AppHandle) -> Result<UsageSummary, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let mut summary = UsageSummary::default();
    let sources = [
        ("claude", home.join(".claude").join("projects")),
        ("codex", home.join(".codex").join("sessions")),
    ];
    for (tool, dir) in sources {
        if !dir.exists() {
            continue;
        }
        let mut acc = ToolUsage::default();
        for entry in WalkDir::new(&dir).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            if entry.path().extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(entry.path()) {
                for line in content.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        add_usage_from_value(&v, &mut acc);
                    }
                }
            }
        }
        summary.by_tool.insert(tool.to_string(), acc);
    }
    Ok(summary)
}

// --- Skills --------------------------------------------------------------
// User-installed Anthropic-style "Agent Skills" (SKILL.md + folders).
// Stored verbatim under <app_config_dir>/skills/<name>/ so the webview can
// read them later. Workspace-independent on purpose.

fn skills_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("skills"))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn skill_install(
    app: AppHandle,
    src_path: String,
    name: String,
) -> Result<(), String> {
    let trimmed_name = validate_skill_name(&name)?;
    let trimmed_name = trimmed_name.as_str();
    let src = PathBuf::from(&src_path);
    let skill_md = if src.is_file() {
        if src.file_name().and_then(|s| s.to_str()) != Some("SKILL.md") {
            return Err("source file must be named SKILL.md".to_string());
        }
        src.clone()
    } else if src.is_dir() {
        let candidate = src.join("SKILL.md");
        if !candidate.is_file() {
            return Err("source directory must contain SKILL.md".to_string());
        }
        candidate
    } else {
        return Err("source path does not exist".to_string());
    };
    let text = fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;
    if text.len() > 1_000_000 {
        return Err("SKILL.md is too large (>1MB)".to_string());
    }
    let root = skills_root(&app)?;
    let dest = root.join(trimmed_name);
    if dest.exists() {
        return Err(format!("skill \"{trimmed_name}\" already installed"));
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    if src.is_file() {
        fs::copy(&src, dest.join("SKILL.md")).map_err(|e| e.to_string())?;
    } else {
        copy_dir_recursive(&src, &dest)?;
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn skill_list(app: AppHandle) -> Result<Vec<String>, String> {
    let root = skills_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                if entry.path().join("SKILL.md").is_file() {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command(rename_all = "camelCase")]
fn skill_read(app: AppHandle, name: String) -> Result<String, String> {
    let name = validate_skill_name(&name)?;
    let path = skills_root(&app)?.join(&name).join("SKILL.md");
    if !path.is_file() {
        return Err(format!("SKILL.md not found for \"{name}\""));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn skill_uninstall(app: AppHandle, name: String) -> Result<(), String> {
    let name = validate_skill_name(&name)?;
    let path = skills_root(&app)?.join(&name);
    if !path.exists() {
        return Err(format!("skill \"{name}\" not found"));
    }
    fs::remove_dir_all(&path).map_err(|e| e.to_string())
}

// --- Terminal (PTY) ------------------------------------------------------
// Interactive shell spawned via portable-pty. The webview has no child_process
// API, so all PTY I/O is owned by Rust. Output bytes stream to the webview
// over a Tauri Channel<TerminalEvent>; key input flows back via terminal_write.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalEvent {
    Data { data: Vec<u8> },
    Exit { code: i32 },
}

struct TerminalSession {
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

type TerminalMap = Mutex<HashMap<String, TerminalSession>>;
static TERMINALS: std::sync::OnceLock<TerminalMap> = std::sync::OnceLock::new();
static NEXT_SESSION_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn terminals() -> &'static TerminalMap {
    TERMINALS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command(rename_all = "camelCase")]
async fn terminal_create(
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    on_event: Channel<TerminalEvent>,
) -> Result<String, String> {
    // Use the user-chosen shell if set; otherwise fall back to the platform
    // default. On Windows prefer COMSPEC and ignore SHELL — a POSIX SHELL value
    // inherited from Git Bash/MSYS (e.g. /usr/bin/bash) is not a valid
    // CreateProcess path and would make the terminal fail to spawn.
    let shell = match shell {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => {
            if cfg!(windows) {
                std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
            } else {
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
            }
        }
    };
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(c) = cwd.as_ref() {
        if !c.is_empty() {
            cmd.cwd(c);
        }
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;

    let session_id = format!(
        "term-{}",
        NEXT_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    if let Ok(mut g) = terminals().lock() {
        g.insert(
            session_id.clone(),
            TerminalSession {
                writer: Mutex::new(writer),
                master: Mutex::new(master),
                killer: Mutex::new(killer),
            },
        );
    }

    let session_id_for_task = session_id.clone();
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    if on_event
                        .send(TerminalEvent::Data { data })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let exit_code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        let _ = on_event.send(TerminalEvent::Exit { code: exit_code });
        if let Ok(mut g) = terminals().lock() {
            g.remove(&session_id_for_task);
        }
    });

    Ok(session_id)
}

#[tauri::command(rename_all = "camelCase")]
fn terminal_write(session_id: String, data: String) -> Result<(), String> {
    use std::io::Write;
    let g = terminals().lock().map_err(|e| e.to_string())?;
    let session = g
        .get(&session_id)
        .ok_or_else(|| format!("terminal session {session_id} not found"))?;
    let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let g = terminals().lock().map_err(|e| e.to_string())?;
    let session = g
        .get(&session_id)
        .ok_or_else(|| format!("terminal session {session_id} not found"))?;
    let master = session.master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn terminal_kill(session_id: String) -> Result<(), String> {
    let mut g = terminals().lock().map_err(|e| e.to_string())?;
    if let Some(session) = g.remove(&session_id) {
        if let Ok(mut killer) = session.killer.lock() {
            let _ = killer.kill();
        }
        Ok(())
    } else {
        Err(format!("terminal session {session_id} not found"))
    }
}

// --- LLM HTTP proxy ------------------------------------------------------
// The webview cannot reach certain external endpoints (e.g. api.minimax.io);
// Rust's network path works for all of them. The openai SDK is wired (in llm.ts)
// to a custom fetch (`tauriFetch`) that tunnels every request through these
// two commands. Streaming bodies come back over a Channel<ProxyEvent>; aborts
// propagate from the SDK AbortSignal -> proxy_abort -> CancellationToken.

type AbortMap = Mutex<HashMap<String, CancellationToken>>;
static ABORTS: std::sync::OnceLock<AbortMap> = std::sync::OnceLock::new();
fn aborts() -> &'static AbortMap {
    ABORTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ProxyEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        data: Vec<u8>,
    },
    Done,
    Error {
        message: String,
    },
}

#[tauri::command(rename_all = "camelCase")]
async fn proxy_request(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    stream_id: String,
    on_event: Channel<ProxyEvent>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    {
        if let Ok(mut g) = aborts().lock() {
            g.insert(stream_id.clone(), token.clone());
        }
    }

    let cleanup = || {
        if let Ok(mut g) = aborts().lock() {
            g.remove(&stream_id);
        }
    };

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut req = client.request(m, &url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = tokio::select! {
        _ = token.cancelled() => {
            let _ = on_event.send(ProxyEvent::Error { message: "aborted".to_string() });
            cleanup();
            return Ok(());
        }
        sent = req.send() => match sent {
            Ok(r) => r,
            Err(e) => {
                let _ = on_event.send(ProxyEvent::Error { message: e.to_string() });
                cleanup();
                return Ok(());
            }
        }
    };

    let status = resp.status().as_u16();
    let mut header_map = HashMap::new();
    for (name, value) in resp.headers().iter() {
        if let Ok(v) = value.to_str() {
            header_map.insert(name.as_str().to_string(), v.to_string());
        }
    }
    let _ = on_event.send(ProxyEvent::Headers {
        status,
        headers: header_map,
    });

    let body = resp.bytes_stream();
    tokio::pin!(body);
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                let _ = on_event.send(ProxyEvent::Error {
                    message: "aborted".to_string(),
                });
                break;
            }
            maybe = body.next() => {
                match maybe {
                    Some(Ok(chunk)) => {
                        let _ = on_event.send(ProxyEvent::Chunk {
                            data: chunk.to_vec(),
                        });
                    }
                    Some(Err(e)) => {
                        let _ = on_event.send(ProxyEvent::Error {
                            message: e.to_string(),
                        });
                        break;
                    }
                    None => {
                        let _ = on_event.send(ProxyEvent::Done);
                        break;
                    }
                }
            }
        }
    }
    cleanup();
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn proxy_abort(stream_id: String) -> Result<(), String> {
    if let Ok(g) = aborts().lock() {
        if let Some(token) = g.get(&stream_id) {
            token.cancel();
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            root: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            set_workspace_root,
            list_dir,
            read_file,
            stat_file,
            write_file,
            search_workspace,
            git_status,
            create_entry,
            delete_entry,
            rename_entry,
            pick_folder,
            run_command,
            get_settings,
            set_settings,
            read_usage_logs,
            proxy_request,
            proxy_abort,
            skill_install,
            skill_list,
            skill_read,
            skill_uninstall,
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod usage_tests {
    use super::{add_usage_from_value, ToolUsage};

    #[test]
    fn extracts_nested_message_usage() {
        let line = r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        let mut acc = ToolUsage::default();
        add_usage_from_value(&v, &mut acc);
        assert_eq!(acc.input_tokens, 10);
        assert_eq!(acc.output_tokens, 5);
    }

    #[test]
    fn supports_prompt_completion_aliases() {
        let line = r#"{"usage":{"prompt_tokens":3,"completion_tokens":7}}"#;
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        let mut acc = ToolUsage::default();
        add_usage_from_value(&v, &mut acc);
        assert_eq!(acc.input_tokens, 3);
        assert_eq!(acc.output_tokens, 7);
    }

    #[test]
    fn ignores_objects_without_usage() {
        let v: serde_json::Value = serde_json::from_str(r#"{"foo":1,"bar":{"baz":2}}"#).unwrap();
        let mut acc = ToolUsage::default();
        add_usage_from_value(&v, &mut acc);
        assert_eq!(acc.input_tokens, 0);
        assert_eq!(acc.output_tokens, 0);
    }
}
