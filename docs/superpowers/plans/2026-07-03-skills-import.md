# Claude Code / Codex 스킬 스캔·가져오기 (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정 Skills 탭에서 로컬에 설치된 Claude Code 플러그인·Codex 스킬을 스캔해 목록으로 보여주고, 선택한 것만 골라 한 번에 가져올 수 있게 한다.

**Architecture:** 가져오기 자체(폴더 복사, SKILL.md 검증)는 기존 `skill_install`을 그대로 재사용한다. 새로 필요한 건 "어디에 뭐가 있는지 찾는" 스캔뿐이다. Rust에 인자 없는 고정 경로 스캔 명령을 추가하고(`~/.claude/plugins/cache`, `~/.codex/skills` 재귀 탐색), TS에서 기존 frontmatter 파서로 이름·설명을 뽑아 이름 충돌을 해소한 뒤, 설정 UI에 체크박스 목록을 붙인다.

**Tech Stack:** Rust(Tauri v2, 기존 `walkdir` 의존성), TypeScript, React 19, vitest.

## Global Constraints

- spec: `docs/superpowers/specs/2026-07-03-skills-import-design.md`. 아래는 그 binding 요구.
- 스캔 대상은 정확히 두 고정 경로만: `%USERPROFILE%\.claude\plugins\cache`, `%USERPROFILE%\.codex\skills`. Codex의 `~/.codex/plugins/`(MCP 커넥터)는 절대 스캔하지 않는다.
- `scan_external_skills`는 **인자를 받지 않는다**(`read_opencode_auth`와 동일한 고정 경로 원칙 — 일반 파일 스캔 표면이 아님).
- 가져오기는 **기존 `skill_install(srcPath, name)`을 그대로 재사용**한다(새 복사/설치 로직 작성 금지). 이미 설치된 이름과 겹치면 `skill_install`이 이미 에러를 던지므로 그 동작을 그대로 활용한다(덮어쓰기 없음).
- 스캔 결과 안에서 서로 다른 소스가 같은 스킬 이름을 쓰면(실측 사례: `skill-creator`가 Claude·Codex 양쪽에 존재), 화면 표시와 실제 설치명 **모두** `이름 (source)` 형태로 구분한다(두 후보 다 접미사 붙임, 한쪽만 붙이지 않음).
- 루트 디렉터리가 없으면(도구 미설치) 그 소스는 에러 없이 빈 결과로 처리한다.
- 게이트: `pnpm exec tsc --noEmit` 0, `cargo check` 0, `pnpm exec vitest run` 전체 green, 최종 태스크에서 `pnpm build` 성공.

## File Structure

- Modify `src-tauri/src/lib.rs` — `ExternalSkillCandidate` 구조체 + `scan_external_skills` 명령 + 핸들러 등록.
- Modify `src/lib/skills.ts` — `parseFrontmatter` export 전환, `ExternalSkillCandidate`/`ResolvedSkillCandidate` 타입, `scanExternalSkills`, `resolveImportNames`.
- Create `src/lib/__tests__/skills.test.ts` — 순수 함수 테스트.
- Modify `src/components/SettingsModal.tsx` — `SkillsSection`에 스캔/체크박스/가져오기 UI 추가.

---

### Task 1: Rust `scan_external_skills` — 고정 경로 재귀 스캔

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces (Task 2가 소비): Tauri command `scan_external_skills() -> Result<Vec<ExternalSkillCandidate>, String>`, 프런트 표준 camelCase 필드: `{ source: "claude"|"codex"; label: string; path: string; preview: string }`.

먼저 `src-tauri/src/lib.rs`에서 `skills_root`/`skill_install`/`skill_list` 함수(약 934~1015번째 줄 부근)와 `WalkDir` 사용 패턴(`WalkDir::new(root).follow_links(false).into_iter().filter_map(|e| e.ok())`, 약 906번째 줄 부근)을 Read해서 확인하세요.

- [ ] **Step 1: 구조체 + 스캔 헬퍼 + 명령 추가**

`skill_uninstall` 함수(기존) 바로 다음에 추가:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalSkillCandidate {
    source: String,
    label: String,
    path: String,
    preview: String,
}

const MAX_SKILL_PREVIEW_BYTES: usize = 1_000_000;

/// Recursively finds every SKILL.md under `root` and appends one candidate
/// per hit. Missing root is not an error (the tool just isn't installed);
/// unreadable/oversized files are skipped individually so one bad skill
/// can't abort the whole scan.
fn collect_skill_candidates(root: &Path, source: &str, out: &mut Vec<ExternalSkillCandidate>) {
    if !root.exists() {
        return;
    }
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name().to_str() != Some("SKILL.md") {
            continue;
        }
        let skill_dir = match entry.path().parent() {
            Some(p) => p,
            None => continue,
        };
        let text = match fs::read_to_string(entry.path()) {
            Ok(t) if t.len() <= MAX_SKILL_PREVIEW_BYTES => t,
            _ => continue,
        };
        let label = entry
            .path()
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.parent())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| skill_dir.to_string_lossy().into_owned());
        out.push(ExternalSkillCandidate {
            source: source.to_string(),
            label,
            path: skill_dir.to_string_lossy().into_owned(),
            preview: text,
        });
    }
}

/// Scans exactly two fixed, home-relative roots for installed Agent Skills
/// (Claude Code plugin cache, Codex skills dir). Takes no path argument —
/// this is not a general filesystem scan surface. Codex's separate
/// `~/.codex/plugins/` (MCP connector bundles) is intentionally excluded.
#[tauri::command]
fn scan_external_skills() -> Result<Vec<ExternalSkillCandidate>, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "홈 디렉터리를 찾을 수 없습니다".to_string())?;
    let home = PathBuf::from(home);
    let mut out: Vec<ExternalSkillCandidate> = Vec::new();
    collect_skill_candidates(
        &home.join(".claude").join("plugins").join("cache"),
        "claude",
        &mut out,
    );
    collect_skill_candidates(&home.join(".codex").join("skills"), "codex", &mut out);
    Ok(out)
}
```

- [ ] **Step 2: 핸들러 등록**

`tauri::generate_handler![` 목록에서 `skill_uninstall,` 다음 줄에 `scan_external_skills,` 추가.

- [ ] **Step 3: 검증**

Run: `cd src-tauri && cargo check`
Expected: 에러 0.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: scan_external_skills 명령 (Claude Code/Codex 스킬 고정경로 재귀 스캔)"
```

---

### Task 2: skills.ts — 프런트 래퍼 + 이름 충돌 해소 (TDD)

**Files:**
- Modify: `src/lib/skills.ts`
- Test: `src/lib/__tests__/skills.test.ts` (Create)

**Interfaces:**
- Consumes: Task 1의 `scan_external_skills` Tauri command.
- Produces (Task 3가 사용):
  - `export function parseFrontmatter(text): { metadata: SkillMetadata; body: string }` (기존 비공개 함수를 export로 전환, 로직 무변경)
  - `export interface ExternalSkillCandidate { source: "claude" | "codex"; label: string; path: string; preview: string }`
  - `export function scanExternalSkills(): Promise<ExternalSkillCandidate[]>`
  - `export interface ResolvedSkillCandidate { candidate: ExternalSkillCandidate; name: string; description: string; installName: string; alreadyInstalled: boolean }`
  - `export function resolveImportNames(candidates: ExternalSkillCandidate[], installedNames: string[]): ResolvedSkillCandidate[]`

먼저 `src/lib/skills.ts`를 Read해서 현재 `parseFrontmatter`(비공개), `extractYamlString`, 파일 끝 구조를 확인하세요.

- [ ] **Step 1: 실패하는 테스트 작성** — `src/lib/__tests__/skills.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  resolveImportNames,
  type ExternalSkillCandidate,
} from "../skills";

describe("parseFrontmatter (exported, regression check)", () => {
  it("parses name/description from YAML frontmatter, stripping quotes", () => {
    const { metadata, body } = parseFrontmatter(
      '---\nname: "brainstorming"\ndescription: "Turn ideas into designs"\n---\nBody text',
    );
    expect(metadata).toEqual({ name: "brainstorming", description: "Turn ideas into designs" });
    expect(body).toBe("Body text");
  });

  it("falls back to the first line as name when there is no frontmatter block", () => {
    const { metadata } = parseFrontmatter("just a plain skill body");
    expect(metadata).toEqual({ name: "just a plain skill body", description: "" });
  });
});

describe("resolveImportNames", () => {
  it("uses the frontmatter name as installName when there's no collision", () => {
    const candidates: ExternalSkillCandidate[] = [
      {
        source: "claude",
        label: "superpowers/brainstorming",
        path: "/c/brainstorming",
        preview: "---\nname: brainstorming\ndescription: Turn ideas into designs\n---\nBody",
      },
    ];
    const resolved = resolveImportNames(candidates, []);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("brainstorming");
    expect(resolved[0].installName).toBe("brainstorming");
    expect(resolved[0].description).toBe("Turn ideas into designs");
    expect(resolved[0].alreadyInstalled).toBe(false);
  });

  it("suffixes both candidates with their source when the same name comes from two sources", () => {
    const candidates: ExternalSkillCandidate[] = [
      {
        source: "claude",
        label: "claude-plugins-official/skill-creator",
        path: "/c/skill-creator",
        preview: '---\nname: "skill-creator"\ndescription: "Claude version"\n---\nBody',
      },
      {
        source: "codex",
        label: ".system/skill-creator",
        path: "/x/skill-creator",
        preview: '---\nname: "skill-creator"\ndescription: "Codex version"\n---\nBody',
      },
    ];
    const resolved = resolveImportNames(candidates, []);
    expect(resolved.map((r) => r.installName).sort()).toEqual([
      "skill-creator (claude)",
      "skill-creator (codex)",
    ]);
  });

  it("marks a candidate as already installed when its installName matches an existing skill", () => {
    const candidates: ExternalSkillCandidate[] = [
      {
        source: "claude",
        label: "superpowers/brainstorming",
        path: "/c/brainstorming",
        preview: "---\nname: brainstorming\ndescription: d\n---\nBody",
      },
    ];
    const resolved = resolveImportNames(candidates, ["brainstorming"]);
    expect(resolved[0].alreadyInstalled).toBe(true);
  });

  it("falls back to the last path segment of label when frontmatter has no name field", () => {
    const candidates: ExternalSkillCandidate[] = [
      {
        source: "codex",
        label: ".system/imagegen",
        path: "/x/imagegen",
        preview: "---\ndescription: Generate images\n---\nBody",
      },
    ];
    const resolved = resolveImportNames(candidates, []);
    expect(resolved[0].name).toBe("imagegen");
    expect(resolved[0].description).toBe("Generate images");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run src/lib/__tests__/skills.test.ts`
Expected: FAIL — `parseFrontmatter`가 아직 export 안 됨, `resolveImportNames` 없음.

- [ ] **Step 3: parseFrontmatter export 전환**

`src/lib/skills.ts`에서 기존:
```ts
function parseFrontmatter(
  text: string,
): { metadata: SkillMetadata; body: string } {
```
교체 후(본문은 한 글자도 안 바꿈, `export`만 추가):
```ts
export function parseFrontmatter(
  text: string,
): { metadata: SkillMetadata; body: string } {
```

- [ ] **Step 4: scanExternalSkills + resolveImportNames 추가**

`src/lib/skills.ts` 파일 끝(`buildSkillsPrompt` 함수 다음)에 추가:

```ts
export interface ExternalSkillCandidate {
  source: "claude" | "codex";
  label: string;
  path: string;
  preview: string;
}

/** Scans the two fixed external skill roots (Claude Code plugin cache,
 *  Codex skills dir) — see scan_external_skills in the Rust backend. */
export async function scanExternalSkills(): Promise<ExternalSkillCandidate[]> {
  return invoke<ExternalSkillCandidate[]>("scan_external_skills");
}

export interface ResolvedSkillCandidate {
  candidate: ExternalSkillCandidate;
  name: string;
  description: string;
  /** Name to pass to installSkill. Equal to `name` unless another scanned
   *  candidate shares the same name — then both get "name (source)". */
  installName: string;
  /** True when installName already matches a currently-installed skill. */
  alreadyInstalled: boolean;
}

/** Resolves display/install names for scanned candidates: parses each one's
 *  frontmatter, disambiguates same-name candidates from different sources
 *  by appending "(source)" to BOTH, and flags names that already collide
 *  with an installed skill (installSkill refuses those — never overwrites). */
export function resolveImportNames(
  candidates: ExternalSkillCandidate[],
  installedNames: string[],
): ResolvedSkillCandidate[] {
  const parsed = candidates.map((c) => {
    const { metadata } = parseFrontmatter(c.preview);
    const fallback = c.label.split("/").pop() ?? c.label;
    const name = metadata.name.length > 0 ? metadata.name : fallback;
    return { candidate: c, name, description: metadata.description };
  });
  const nameCounts = new Map<string, number>();
  for (const p of parsed) {
    nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
  }
  const installedSet = new Set(installedNames);
  return parsed.map((p) => {
    const collides = (nameCounts.get(p.name) ?? 0) > 1;
    const installName = collides ? `${p.name} (${p.candidate.source})` : p.name;
    return {
      candidate: p.candidate,
      name: p.name,
      description: p.description,
      installName,
      alreadyInstalled: installedSet.has(installName),
    };
  });
}
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm exec vitest run` 그리고 `pnpm exec tsc --noEmit`
Expected: 전체 green(기존 90개 + 신규 6개 = **96개**), tsc 0.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/skills.ts src/lib/__tests__/skills.test.ts
git commit -m "feat: 스킬 스캔 결과 파싱 + 이름 충돌 해소 로직 (테스트)"
```

---

### Task 3: SettingsModal.tsx — Skills 탭에 스캔·선택·가져오기 UI

**Files:**
- Modify: `src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: Task 2의 `scanExternalSkills`, `resolveImportNames`, `type ExternalSkillCandidate`, `type ResolvedSkillCandidate`. 기존 `installSkillBackend`(= `installSkill`), `onRefresh`, `skills: InstalledSkill[]`(이미 `SkillsSectionProps`로 전달됨).
- Produces: 변경 없음(최종 UI 태스크).

먼저 `src/components/SettingsModal.tsx`의 `SkillsSection` 함수 전체를 Read해서 현재 상태(state 훅들, `handleInstall`/`handleUninstall`, 반환 JSX)를 확인하세요.

- [ ] **Step 1: import 문 수정**

기존:
```ts
import {
  installSkill as installSkillBackend,
  loadAllInstalledSkills,
  uninstallSkill as uninstallSkillBackend,
  type InstalledSkill,
} from "../lib/skills";
```
교체 후:
```ts
import {
  installSkill as installSkillBackend,
  loadAllInstalledSkills,
  uninstallSkill as uninstallSkillBackend,
  scanExternalSkills,
  resolveImportNames,
  type InstalledSkill,
  type ExternalSkillCandidate,
} from "../lib/skills";
```

- [ ] **Step 2: state + 핸들러 추가**

`SkillsSection` 함수 내부, 기존 state 선언들(`srcPath`, `skillName`, `busy`, `error`) 다음에 추가:

```ts
  const [externalCandidates, setExternalCandidates] = useState<ExternalSkillCandidate[] | null>(
    null,
  );
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const resolvedCandidates = useMemo(
    () =>
      externalCandidates !== null
        ? resolveImportNames(
            externalCandidates,
            skills.map((s) => s.name),
          )
        : [],
    [externalCandidates, skills],
  );

  const handleScan = async (): Promise<void> => {
    setScanning(true);
    setScanError(null);
    try {
      const found = await scanExternalSkills();
      setExternalCandidates(found);
      setSelectedPaths(new Set());
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const toggleSelected = (path: string): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleImportSelected = async (): Promise<void> => {
    const toImport = resolvedCandidates.filter(
      (r) => selectedPaths.has(r.candidate.path) && !r.alreadyInstalled,
    );
    if (toImport.length === 0) return;
    setImporting(true);
    setImportError(null);
    const failures: string[] = [];
    for (const r of toImport) {
      try {
        await installSkillBackend(r.candidate.path, r.installName);
      } catch (e) {
        failures.push(`${r.installName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setImportError(failures.length > 0 ? failures.join("\n") : null);
    setSelectedPaths(new Set());
    await onRefresh();
    setImporting(false);
  };
```

`SkillsSection`가 `useMemo`를 쓰므로, `SettingsModal.tsx` 최상단 import 문에 이미 `useMemo`가 import돼 있는지 확인하세요(파일 최상단 `import { useCallback, useEffect, useMemo, useState } from "react";` — 이미 있다면 수정 불필요).

- [ ] **Step 3: JSX에 스캔 섹션 추가**

`SkillsSection`의 반환 JSX에서, 기존 설치된 스킬 목록(`{skills.length === 0 ? ... : (...)}`) 바로 다음, 기존 수동 입력 폼(`<div className="settings-modal__mcp-add">...</div>`) 바로 앞에 삽입:

```tsx
      <h3 className="settings-modal__section-title">Claude Code / Codex에서 가져오기</h3>
      <p className="settings-modal__hint">
        로컬에 설치된 Claude Code 플러그인(<code>~/.claude/plugins/cache</code>)과
        Codex 스킬(<code>~/.codex/skills</code>)을 스캔해 원하는 것만 선택해서
        가져옵니다.
      </p>
      <button
        type="button"
        className="settings-modal__btn settings-modal__btn--small"
        onClick={() => void handleScan()}
        disabled={scanning}
      >
        {scanning ? "스캔 중…" : "스캔"}
      </button>
      {scanError !== null ? (
        <div className="settings-modal__mcp-error">{scanError}</div>
      ) : null}
      {externalCandidates !== null ? (
        externalCandidates.length === 0 ? (
          <p className="settings-modal__hint">
            설치된 Claude Code 플러그인·Codex 스킬을 찾을 수 없습니다.
          </p>
        ) : (
          <>
            <ul className="settings-modal__mcp-list">
              {resolvedCandidates.map((r) => (
                <li key={r.candidate.path} className="settings-modal__mcp-item">
                  <div className="settings-modal__mcp-row1">
                    <label className="settings-modal__mcp-toggle">
                      <input
                        type="checkbox"
                        checked={selectedPaths.has(r.candidate.path)}
                        disabled={r.alreadyInstalled}
                        onChange={() => toggleSelected(r.candidate.path)}
                      />
                      <span>{r.installName}</span>
                    </label>
                    <span className="settings-modal__mcp-url">{r.candidate.source}</span>
                    {r.alreadyInstalled ? <span>(이미 설치됨)</span> : null}
                  </div>
                  <div className="settings-modal__mcp-row2">
                    {r.description.length > 0 ? (
                      <span>{r.description}</span>
                    ) : (
                      <span style={{ opacity: 0.6 }}>(description 없음)</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {importError !== null ? (
              <div className="settings-modal__mcp-error">{importError}</div>
            ) : null}
            <button
              type="button"
              className="settings-modal__btn settings-modal__btn--primary settings-modal__btn--small"
              onClick={() => void handleImportSelected()}
              disabled={importing || selectedPaths.size === 0}
            >
              {importing ? "가져오는 중…" : `선택 항목 가져오기 (${selectedPaths.size})`}
            </button>
          </>
        )
      ) : null}

```

- [ ] **Step 4: 전체 게이트 실행 (모두 필수)**

1. `pnpm exec tsc --noEmit` → 0 errors
2. `cd src-tauri && cargo check` → 0 errors
3. `pnpm exec vitest run` → 전체 green(**96개**, 이 태스크는 UI라 신규 테스트 없음)
4. `pnpm build` → `✓ built` 성공

Never rationalize a failing gate as a tooling artifact — 실패 시 원인 진단 또는 BLOCKED로 보고.

- [ ] **Step 5: 커밋**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat: Skills 탭에 Claude Code/Codex 스캔·선택·가져오기 UI"
```

---

## 수동 스모크 (구현 후 오케스트레이터가 `pnpm tauri dev`로 확인)

- [ ] 설정 → Skills 탭 → "스캔" 클릭 → Claude Code(superpowers 등)·Codex(imagegen 등) 스킬이 목록에 나타나는지.
- [ ] `skill-creator`처럼 양쪽에 있는 이름이 `skill-creator (claude)` / `skill-creator (codex)`로 구분 표시되는지.
- [ ] 몇 개 체크 후 "선택 항목 가져오기" → 설치된 Skills 목록에 반영되는지.
- [ ] 방금 가져온 항목이 스캔 목록에서 자동으로 "(이미 설치됨)" 비활성으로 바뀌는지(재스캔 없이 `skills` prop 갱신만으로).
- [ ] 가져온 스킬을 활성화 후 채팅에서 관련 요청 시 시스템 프롬프트에 반영되어 동작이 그 절차를 따르는지(`buildSkillsPrompt` 기존 경로, 회귀 없어야 함).
- [ ] Claude Code/Codex 둘 다 설치 안 된 가상의 상황을 흉내낼 수는 없지만, 최소 하나(이 머신엔 Claude·Codex 둘 다 있음)는 정상 스캔되는지로 대체 확인.

## Self-Review 노트

- **Spec 커버리지**: §3 데이터 소스(Task 1의 두 고정 경로), §4.1 Rust 스캔(Task 1), §4.2 TS 래퍼(Task 2), §4.3 UI(Task 3, 이름충돌·이미설치 처리 포함), §5 에러 처리(Task 1의 root-not-exist 무시 + 개별 파일 스킵, Task 3의 scanError/importError 표시), §6 테스트(Task 2 vitest 6개 + 수동 스모크), §7 보안(Task 1이 인자 없는 고정 경로만 순회, 기존 `skill_install` 검증 재사용 — 우회 없음). ✓
- **타입 일관성**: `ExternalSkillCandidate`(Rust Task 1 → TS Task 2 동일 필드), `ResolvedSkillCandidate`(Task 2 정의 → Task 3 `resolvedCandidates`/`r.candidate.path`/`r.installName`/`r.alreadyInstalled` 그대로 사용). ✓
- **구현 세부사항 보강**: 스펙은 "재스캔 시 이미 설치됨 반영"이라 했으나, 계획은 `onRefresh()`가 부모의 `skills` prop을 갱신하면 `useMemo`가 자동으로 `resolvedCandidates`를 재계산하도록 해 **재스캔 없이도** 즉시 반영되게 함(더 나은 UX, 동일한 최종 동작 보장 — 스펙의 의도를 강화하는 구현 선택이며 상충 아님).
