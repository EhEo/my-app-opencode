# Multi-Agent Foundation (Rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two Rust Tauri commands to `opencode-desktop` that later plans depend on: `read_usage_logs` (aggregate token usage from local AI CLI JSONL logs) and `agent_exec_start`/`agent_exec_kill` (spawn a CLI process, stream stdout/stderr over a Channel, kill on demand).

**Architecture:** Both are added to the single backend file `src-tauri/src/lib.rs`, following the existing patterns already in that file (streaming `Channel<Event>` + a global `OnceLock<Mutex<HashMap>>` registry for cancellation, exactly like the existing `terminal_*` and `proxy_*` commands). Core logic is factored into plain functions (`add_usage_from_value`, `exec_stream`) so it is unit-testable with `cargo test` without a running Tauri app.

**Tech Stack:** Rust, Tauri v2, serde/serde_json (already deps), walkdir (already dep), std::process, std threads + mpsc. No new crates.

## Global Constraints

- Platform target: Windows 11 primary; code must also compile on non-Windows (use `#[cfg(windows)]` / `#[cfg(not(windows))]` for OS-specific parts). Copy this pattern from the existing `no_window` / `kill_process_tree` helpers in `lib.rs`.
- No new Cargo dependencies.
- Fail-open on telemetry/IO errors: `read_usage_logs` must never return `Err` for a missing/unreadable log dir or a malformed JSONL line — skip and continue.
- All new `#[tauri::command]` functions use `rename_all = "camelCase"` (matches every existing command) and must be added to the `tauri::generate_handler!` list.
- Verify gate after every task: `cargo test` and `cargo check` from `src-tauri/` both pass (exit 0).

---

### Task 1: `read_usage_logs` — aggregate token usage from local JSONL logs

**Files:**
- Modify: `src-tauri/src/lib.rs` (add structs, `add_usage_from_value`, `read_usage_logs` command; register in `generate_handler!`)

**Interfaces:**
- Produces (consumed by Plan 2 `lib/usage.ts`):
  - `read_usage_logs()` command → JSON `{ "byTool": { "<tool>": { "inputTokens": u64, "outputTokens": u64 } } }` where `<tool>` ∈ `"claude"`, `"codex"` (only tools whose log dir exists appear).
  - Pure fn `fn add_usage_from_value(v: &serde_json::Value, acc: &mut ToolUsage)` — recursively sums any nested `usage` object's `input_tokens`/`prompt_tokens` into `acc.input_tokens` and `output_tokens`/`completion_tokens` into `acc.output_tokens`.

- [ ] **Step 1: Write the failing tests**

Add at the very end of `src-tauri/src/lib.rs`:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test usage_tests`
Expected: FAIL to compile — `cannot find type ToolUsage` / `cannot find function add_usage_from_value`.

- [ ] **Step 3: Add the structs and pure function**

Add near the other `#[derive(Serialize)]` structs in `lib.rs` (e.g. just after the `GitFileStatus` struct, before `search_workspace`):

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test usage_tests`
Expected: PASS (3 passed).

- [ ] **Step 5: Add the command and register it**

Add the command near the settings commands (after `set_settings`):

```rust
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
```

Then add `read_usage_logs` to the `tauri::generate_handler![...]` list in `run()` (add the line `read_usage_logs,` alongside the other command names).

- [ ] **Step 6: Verify build**

Run: `cd src-tauri && cargo check`
Expected: `Finished` (exit 0). No new warnings about unused `read_usage_logs`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: read_usage_logs command — aggregate token usage from local JSONL logs"
```

---

### Task 2: `agent_exec_start` / `agent_exec_kill` — streaming CLI execution

**Files:**
- Modify: `src-tauri/src/lib.rs` (add `ExecEvent`, `execs()` registry, `kill_pid_tree`, `exec_stream`, the two commands; register both in `generate_handler!`)

**Interfaces:**
- Consumes: `no_window` helper (already in `lib.rs`).
- Produces (consumed by Plan 2 `lib/agentExec.ts`):
  - `agent_exec_start(id: String, program: String, args: Vec<String>, cwd: Option<String>, stdin: Option<String>, env: Option<HashMap<String,String>>, on_event: Channel<ExecEvent>)` — streams events tagged `{"type":"stdout","data":[u8]}`, `{"type":"stderr","data":[u8]}`, `{"type":"exit","code":i32}`.
  - `agent_exec_kill(id: String)` — kills the process tree for that id.
  - Pure-ish fn `exec_stream(program, args, cwd, stdin, env, on_spawn: FnOnce(u32), on_event: FnMut(ExecEvent)) -> Result<(), String>` (synchronous; used by tests).

- [ ] **Step 1: Write the failing test**

Add at the end of `src-tauri/src/lib.rs`:

```rust
#[cfg(test)]
mod exec_tests {
    use super::{exec_stream, ExecEvent};
    use std::collections::HashMap;

    #[test]
    fn streams_stdout_and_exit_zero() {
        let (program, args): (&str, Vec<String>) = if cfg!(windows) {
            ("cmd", vec!["/C".into(), "echo".into(), "hello".into()])
        } else {
            ("sh", vec!["-c".into(), "echo hello".into()])
        };
        let mut events: Vec<ExecEvent> = Vec::new();
        exec_stream(program, &args, None, None, HashMap::new(), |_pid| {}, |e| events.push(e))
            .unwrap();

        let stdout: Vec<u8> = events
            .iter()
            .filter_map(|e| if let ExecEvent::Stdout { data } = e { Some(data.clone()) } else { None })
            .flatten()
            .collect();
        assert!(String::from_utf8_lossy(&stdout).contains("hello"));
        assert!(matches!(events.last(), Some(ExecEvent::Exit { code: 0 })));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test exec_tests`
Expected: FAIL to compile — `cannot find function exec_stream` / `cannot find type ExecEvent`.

- [ ] **Step 3: Add the event type, registry, kill helper, and `exec_stream`**

Add near the terminal section of `lib.rs` (after the `TerminalEvent` block is fine). `HashMap`, `Mutex`, `mpsc`, `thread`, `std::io::Read`, `Stdio`, `Command` are already imported at the top of the file.

```rust
#[derive(serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ExecEvent {
    Stdout { data: Vec<u8> },
    Stderr { data: Vec<u8> },
    Exit { code: i32 },
}

// id -> child PID, for cancellation from agent_exec_kill.
type ExecMap = Mutex<HashMap<String, u32>>;
static EXECS: std::sync::OnceLock<ExecMap> = std::sync::OnceLock::new();
fn execs() -> &'static ExecMap {
    EXECS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
fn kill_pid_tree(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    no_window(&mut cmd);
    let _ = cmd.output();
}
#[cfg(not(windows))]
fn kill_pid_tree(pid: u32) {
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
}

/// Spawn `program args`, stream stdout/stderr as `ExecEvent`s to `on_event`,
/// report the spawned PID via `on_spawn`, and emit a final `Exit` event.
/// Synchronous: returns after the child exits and both pipes drain.
fn exec_stream<S, E>(
    program: &str,
    args: &[String],
    cwd: Option<String>,
    stdin: Option<String>,
    env: std::collections::HashMap<String, String>,
    on_spawn: S,
    mut on_event: E,
) -> Result<(), String>
where
    S: FnOnce(u32),
    E: FnMut(ExecEvent),
{
    let mut builder = Command::new(program);
    builder
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        builder.current_dir(dir);
    }
    for (k, v) in env {
        builder.env(k, v);
    }
    no_window(&mut builder);

    let mut child = builder.spawn().map_err(|e| e.to_string())?;
    on_spawn(child.id());

    if let Some(data) = stdin {
        if let Some(mut si) = child.stdin.take() {
            use std::io::Write;
            let _ = si.write_all(data.as_bytes());
        } // si dropped here -> stdin closed
    } else {
        child.stdin.take(); // close stdin so the child doesn't block on read
    }

    let mut out = child.stdout.take().expect("stdout piped");
    let mut err = child.stderr.take().expect("stderr piped");
    let (tx, rx) = mpsc::channel::<ExecEvent>();

    let tx_out = tx.clone();
    let h_out = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match out.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx_out.send(ExecEvent::Stdout { data: buf[..n].to_vec() }).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let tx_err = tx.clone();
    let h_err = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match err.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx_err.send(ExecEvent::Stderr { data: buf[..n].to_vec() }).is_err() {
                        break;
                    }
                }
            }
        }
    });
    drop(tx); // only the two reader threads hold senders now

    for ev in rx {
        on_event(ev);
    }
    let _ = h_out.join();
    let _ = h_err.join();

    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    on_event(ExecEvent::Exit { code });
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test exec_tests`
Expected: PASS (1 passed).

- [ ] **Step 5: Add the two commands and register them**

Add after `exec_stream`:

```rust
#[tauri::command(rename_all = "camelCase")]
async fn agent_exec_start(
    id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    stdin: Option<String>,
    env: Option<HashMap<String, String>>,
    on_event: Channel<ExecEvent>,
) -> Result<(), String> {
    let id_spawn = id.clone();
    tokio::task::spawn_blocking(move || {
        let result = exec_stream(
            &program,
            &args,
            cwd,
            stdin,
            env.unwrap_or_default(),
            |pid| {
                if let Ok(mut g) = execs().lock() {
                    g.insert(id_spawn.clone(), pid);
                }
            },
            |ev| {
                let _ = on_event.send(ev);
            },
        );
        if let Ok(mut g) = execs().lock() {
            g.remove(&id);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
fn agent_exec_kill(id: String) -> Result<(), String> {
    let pid = {
        let g = execs().lock().map_err(|e| e.to_string())?;
        g.get(&id).copied()
    };
    if let Some(pid) = pid {
        kill_pid_tree(pid);
    }
    Ok(())
}
```

Then add `agent_exec_start,` and `agent_exec_kill,` to the `tauri::generate_handler![...]` list in `run()`.

- [ ] **Step 6: Verify build**

Run: `cd src-tauri && cargo check`
Expected: `Finished` (exit 0).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: agent_exec_start/kill — streaming CLI process execution with cancellation"
```

---

## Self-Review

**Spec coverage (Plan 1 slice):** §3 backend `read_usage_logs` → Task 1 ✅. §3 backend `agent_exec_start`/`agent_exec_kill` → Task 2 ✅. §6 usage source ② (CLI JSONL) → Task 1 ✅. §8 `read_usage_logs` read-only + known paths only + skip malformed → Task 1 (only `.claude/projects`, `.codex/sessions`, `filter_map(ok)`, `if let Ok(v)`) ✅. §8 fail-open → Task 1 (dir missing `continue`, per-file/per-line skip) ✅. §11 streaming exec = open shell → cwd optional, kill by PID tree ✅. Remaining spec sections (TS libs, orchestrator, UI, settings, guard) are Plans 2–3, out of this slice.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step has complete code. ✅

**Type consistency:** `ToolUsage` (Task 1) fields `input_tokens`/`output_tokens` reused in `add_usage_from_value` and `read_usage_logs`. `ExecEvent` variants `Stdout`/`Stderr`/`Exit` consistent across `exec_stream`, both commands, and the test. `execs()`/`EXECS`/`ExecMap` names consistent. `kill_pid_tree` defined once per cfg and called in `agent_exec_kill`. ✅

**Note for implementer:** `home_dir()` requires `use tauri::Manager;` — it is already imported at the top of `lib.rs` (used by existing `app.path()` calls). No new import needed.
