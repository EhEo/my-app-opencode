# opencode-desktop macOS 지원 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows 기준으로만 검증돼온 Tauri 앱 `opencode-desktop`을 이 Mac(darwin)에서 처음으로 빌드·실행되게 만들고, 핵심 기능을 실측 검증한다.

**Architecture:** 새 아키텍처를 설계하지 않는다. Rust 백엔드는 이미 `#[cfg(windows)]` / `#[cfg(not(windows))]`로 분기돼 있어 macOS 코드 경로가 존재한다. 이 계획은 **실행 → 관찰 → 수정** 루프다. 알 수 없는 런타임 실패는 미리 코드를 지어내지 않고, 실제 출력에서 진단해 기존 `cfg` 컨벤션대로 최소 수정 후 같은 게이트를 다시 통과시킨다.

**Tech Stack:** Tauri v2, Rust (portable-pty, reqwest+rustls, rfd, dunce, walkdir), React 19 + Vite + TypeScript, pnpm, vitest.

**작업 원칙 (전 태스크 공통):**
- Windows 코드 경로(`#[cfg(windows)]` 블록: `taskkill`, `cmd /C`, OEM 코드페이지, `CREATE_NO_WINDOW`)는 **절대 수정하지 않는다**. macOS 수정은 `#[cfg(not(windows))]` / `#[cfg(target_os = "macos")]` 쪽에만.
- 각 태스크 끝에서 커밋. 아무 코드 수정 없이 검증만 통과한 태스크는 커밋할 게 없으면 건너뛴다(문서/체크박스 갱신은 마지막에 일괄 커밋).
- 실패가 재현되면 systematic-debugging 스킬로 원인부터 확인한 뒤 고친다.

---

## 파일 구조 (수정 가능성이 있는 파일)

- `src-tauri/src/lib.rs` — 백엔드 전체. macOS에서 문제가 나올 경우 여기의 `#[cfg(not(windows))]` 분기를 실측·보강.
- `src-tauri/tauri.conf.json` — 창 설정(`decorations: false`). macOS 창 UX 확인 대상.
- `src/components/Toolbar.tsx` — 커스텀 창 컨트롤(`WindowControls`). macOS 창 컨트롤 UX 확인 대상.
- `src/styles.css` — `.window-controls`, `.toolbar` 스타일. UI 조정이 필요하면 여기.
- 그 외 파일은 실측에서 문제가 드러난 경우에만 수정.

---

## Task 1: macOS 툴체인 환경 점검

**Files:** (없음 — 환경 확인만)

- [ ] **Step 1: Rust 툴체인 확인**

Run:
```bash
rustc --version && cargo --version
```
Expected: 버전이 출력됨. `command not found`면 `https://rustup.rs`로 rustup 설치 필요(설치 후 새 셸에서 재확인).

- [ ] **Step 2: Xcode Command Line Tools 확인 (macOS 링커/SDK 필수)**

Run:
```bash
xcode-select -p
```
Expected: `/Library/Developer/CommandLineTools` 또는 Xcode.app 경로 출력. 에러(`error: unable to find utility`)면 `xcode-select --install` 실행 후 완료될 때까지 대기.

- [ ] **Step 3: 현재 아키텍처에 맞는 Rust 타깃 확인**

Run:
```bash
rustup target list --installed && uname -m
```
Expected: Apple Silicon이면 `uname -m`이 `arm64`, 설치 타깃에 `aarch64-apple-darwin` 포함. Intel이면 `x86_64` / `x86_64-apple-darwin`. 없으면 `rustup target add aarch64-apple-darwin`(또는 x86_64) 실행. (rustup 기본 설치 시 호스트 타깃은 보통 이미 포함됨.)

- [ ] **Step 4: pnpm 확인**

Run:
```bash
pnpm --version
```
Expected: 버전 출력. 없으면 `corepack enable pnpm` 또는 `npm i -g pnpm`.

(이 태스크는 코드 변경이 없으므로 커밋하지 않는다.)

---

## Task 2: 의존성 설치 & Rust 백엔드 컴파일 확인

프론트엔드 dev 서버를 띄우기 전에 Rust가 macOS에서 컴파일되는지 먼저 격리 확인한다(가장 큰 미검증 리스크).

**Files:**
- 잠재 수정: `src-tauri/src/lib.rs` (컴파일 에러가 나는 경우만)
- 잠재 수정: `src-tauri/Cargo.toml` (크레이트 feature 문제인 경우만)

- [ ] **Step 1: JS 의존성 설치**

Run:
```bash
pnpm install
```
Expected: lockfile(`pnpm-lock.yaml`) 기준 설치 완료, 에러 없음.

- [ ] **Step 2: Rust 백엔드 타입/컴파일 체크**

Run:
```bash
cd src-tauri && cargo check 2>&1 | tail -40; cd ..
```
Expected: `Finished` 로 끝남. 첫 실행은 의존성 빌드로 수 분 소요될 수 있음(정상).

- [ ] **Step 3: 컴파일 에러가 있으면 진단·수정**

에러가 없으면 이 스텝을 건너뛴다. 에러가 있으면:
- 에러 메시지에서 어느 크레이트/심볼이 문제인지 확인한다.
- Windows 전용 API를 `#[cfg(not(windows))]` 블록에서 실수로 참조하는 경우 → 해당 분기 수정.
- 크레이트의 macOS 미지원/feature 누락이면 → `Cargo.toml`에서 feature 조정 또는 대안 검토.
- **미리 코드를 지어내지 않는다.** 실제 에러 텍스트에 근거해 최소 수정하고 Step 2를 다시 통과시킨다.

- [ ] **Step 4: 수정이 있었다면 cargo check 재통과 후 커밋**

Run:
```bash
cd src-tauri && cargo check 2>&1 | tail -5; cd ..
```
Expected: `Finished`.

수정한 경우에만:
```bash
git add src-tauri/
git commit -m "fix(macos): <실제 수정 내용 한 줄>"
```

---

## Task 3: dev 실행 — 앱 창 띄우기 (성공 기준 a)

**Files:** (없음 — 실행 확인. 문제 시 후속 스텝에서 수정)

- [ ] **Step 1: dev 실행**

Run (백그라운드로 띄우고 로그를 파일로):
```bash
pnpm tauri dev
```
Expected: Vite dev 서버(`http://localhost:1420`)가 뜨고, Rust가 빌드된 뒤 데스크톱 창이 나타난다. 창 제목 `opencode-desktop`.

- [ ] **Step 2: 창이 뜨는지 육안 확인**

Expected: 1100x720 창이 열리고 상단 툴바(Open Folder / Save / 파일명 / Chat / Terminal / Settings / 창 컨트롤)가 보인다.

- [ ] **Step 3: 창 컨트롤 동작·배치 확인 (성공 기준: 창 UX)**

`Toolbar.tsx`의 `WindowControls`(우측 상단 최소화/최대화/닫기)를 클릭해본다.
- `decorations: false`라 macOS 네이티브 신호등은 그려지지 않는다 → 커스텀 컨트롤과의 시각적 충돌은 없을 것으로 예상.
- 최소화/최대화/닫기 버튼이 실제로 동작하는지 확인(capability에 `allow-minimize`/`allow-maximize`/`allow-close` 이미 있음).
- `data-tauri-drag-region`으로 상단바 드래그로 창 이동이 되는지 확인.

Expected: 세 버튼 모두 동작, 드래그 이동 동작.

- [ ] **Step 4: 문제가 있으면 최소 조정**

버튼이 동작하지 않으면 콘솔 에러 확인 → capability/권한 또는 API 호출 경로 진단. 시각적으로 macOS에서 어색한 부분(예: 창 컨트롤 위치)은 이번 범위상 **기능이 되면 통과**로 보고, 조정이 필요하면 `styles.css`에서 최소한만 손본다. 전면 재디자인은 하지 않는다(비목표).

- [ ] **Step 5: 수정이 있었다면 커밋**

수정한 경우에만:
```bash
git add src/ src-tauri/
git commit -m "fix(macos): <창 UX 조정 내용>"
```

---

## Task 4: 워크스페이스 & 파일 I/O 스모크 (성공 기준 b)

dev 앱이 떠 있는 상태에서 진행. 각 항목은 실제 클릭/조작으로 확인한다.

**Files:** 잠재 수정 `src-tauri/src/lib.rs` (실패하는 커맨드가 있을 때만)

- [ ] **Step 1: 폴더 열기 (`pick_folder` → `set_workspace_root`)**

앱에서 "Open Folder" 클릭 → macOS 네이티브 폴더 선택 다이얼로그(`rfd`)가 뜨는지 확인 → 이 저장소 폴더(`/Users/michael/Documents/GitHub/my-app-opencode`)를 선택.
Expected: 다이얼로그가 뜨고, 선택 후 좌측 파일 트리에 저장소 내용이 나타난다.

- [ ] **Step 2: 파일 트리 탐색 (`list_dir` / `stat_file`)**

트리에서 폴더를 펼치고 파일을 클릭한다.
Expected: 하위 항목이 표시되고, 텍스트 파일(예: `README.md`)을 열면 에디터(Monaco)에 내용이 뜬다. 경로 구분자(`/`) 관련 깨짐 없음.

- [ ] **Step 3: 파일 읽기/쓰기 (`read_file` / `write_file`)**

임시 파일을 하나 만들어(예: 트리 컨텍스트 메뉴의 새 파일, 또는 기존 파일을 열어) 편집 후 저장(Cmd+S).
Expected: 저장되고 dirty 표시가 사라진다. 셸에서 내용이 실제로 반영됐는지 확인 가능.

- [ ] **Step 4: 바이너리 읽기 경로 (`read_file_bytes`)**

이미지나 xlsx 등 바이너리 파일을 하나 열어 뷰어가 뜨는지 확인(뷰어 상세는 Task 6).
Expected: 바이너리 로드 에러 없음.

- [ ] **Step 5: 실패 항목이 있으면 진단·수정 후 커밋**

실패하는 커맨드가 있으면 dev 콘솔/터미널 로그에서 에러 확인 → `lib.rs`의 해당 함수와 경로 처리(`canonicalize`, `dunce`) 진단 → 기존 컨벤션대로 수정 → 재확인.
수정한 경우에만 커밋:
```bash
git add src-tauri/ src/
git commit -m "fix(macos): <파일 I/O 수정 내용>"
```

---

## Task 5: 터미널(PTY) & 셸/에이전트 실행 스모크 (성공 기준 c, d)

가장 OS 의존적인 부분. 반드시 실측한다.

**Files:** 잠재 수정 `src-tauri/src/lib.rs`

- [ ] **Step 1: 터미널 열기 (`terminal_create`, portable-pty)**

툴바 "Terminal" 토글 → 터미널 패널이 뜨는지 확인.
Expected: macOS 로그인 셸(zsh) 프롬프트가 뜬다. portable-pty가 pty를 열고 xterm.js에 연결됨.

- [ ] **Step 2: 입출력 (`terminal_write`) & 리사이즈 (`terminal_resize`)**

터미널에 `ls -la` 입력 → 출력 확인. 패널 크기를 조절해 리플로우 확인.
Expected: 명령 출력이 정상 표시(한글 파일명 등 UTF-8 깨짐 없음), 리사이즈 시 열 수가 맞춰짐.

- [ ] **Step 3: 셸 명령 실행 (`run_command`, `sh -c`)**

앱의 명령 실행 경로(채팅 에이전트의 셸 도구 또는 해당 UI)로 간단한 명령(`echo hi && pwd`)을 실행.
Expected: `build_shell_command`의 `sh -c` 경로로 실행되어 stdout이 반환됨. 30초 타임아웃 로직 정상.

- [ ] **Step 4: 프로세스 트리 종료 확인 (`kill_process_tree` / `kill_pid_tree`) — 좀비 없음 검증**

긴 실행 명령(예: `sleep 60` 또는 하위 프로세스를 낳는 명령)을 실행한 뒤 취소/kill한다. 별도 셸에서 확인:
```bash
ps aux | grep -E "sleep 60" | grep -v grep
```
Expected: kill 후 해당 프로세스가 남아있지 않다(`kill -9` / `child.kill()` 경로가 동작). 좀비/고아 프로세스 없음.

- [ ] **Step 5: 에이전트 실행 스트리밍 (`agent_exec_start` / `agent_exec_kill`)**

에이전트 실행 기능(있다면)으로 스트리밍 exec를 시작하고 중간에 kill.
Expected: 이벤트가 스트리밍되고, kill 시 프로세스가 정리됨.

- [ ] **Step 6: 터미널 종료 (`terminal_kill`)**

터미널 패널을 닫거나 앱 종료.
Expected: pty와 자식 프로세스가 정리됨.

- [ ] **Step 7: 실패 항목이 있으면 진단·수정 후 커밋**

수정한 경우에만:
```bash
git add src-tauri/
git commit -m "fix(macos): <터미널/프로세스 수정 내용>"
```

---

## Task 6: 문서 뷰어 스모크 (성공 기준 e)

**Files:** 잠재 수정 `src/components/viewers/*`

- [ ] **Step 1: 각 뷰어 열기**

저장소 안 또는 임의의 샘플 파일로 다음을 각각 열어본다: xlsx(`XlsxViewer`), docx, pdf, pptx.
Expected: 각 뷰어가 macOS에서 렌더링됨. 이들은 웹 기반(exceljs, docx-preview, pdfjs-dist, pptxviewjs)이라 OS 비종속 — 문제 가능성 낮음. 단 `pdfjs-dist` worker 경로 등 번들 관련 이슈가 없는지 확인.

- [ ] **Step 2: 문제가 있으면 콘솔 에러 기준 진단·수정 후 커밋**

수정한 경우에만:
```bash
git add src/
git commit -m "fix(macos): <뷰어 수정 내용>"
```

---

## Task 7: 스킬 스캔/설치 스모크 (성공 기준 f)

**Files:** 잠재 수정 `src-tauri/src/lib.rs` (`scan_external_skills` 경로)

- [ ] **Step 1: 스킬 스캔**

Settings → Skills 탭 → "스캔" 실행.
Expected: `~/.claude/plugins/cache/**`와 `~/.codex/skills/**`(존재하는 것)의 `SKILL.md`가 목록에 뜬다. macOS 홈 경로(`/Users/michael`) 기준으로 정상 탐색되는지 확인(코드는 홈 기준 상대이므로 문제 없을 것으로 예상).

- [ ] **Step 2: 몇 개 선택해 가져오기 (`skill_install`)**

Expected: 선택 스킬이 설치되고 목록에 반영됨. 이미 설치된 항목은 비활성.

- [ ] **Step 3: 문제가 있으면 진단·수정 후 커밋**

수정한 경우에만:
```bash
git add src-tauri/ src/
git commit -m "fix(macos): <스킬 스캔 수정 내용>"
```

---

## Task 8: 빌드 게이트 (성공 기준 g)

모든 스모크가 끝난 뒤 자동 검증 게이트를 통과시킨다.

**Files:** (없음 — 게이트 실행. 실패 시 해당 태스크로 돌아가 수정)

- [ ] **Step 1: TypeScript 타입 체크**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: 에러 없음.

- [ ] **Step 2: 프론트엔드 테스트**

Run:
```bash
pnpm test
```
Expected: 기존 vitest 스위트 전부 통과.

- [ ] **Step 3: Rust 체크 + 테스트**

Run:
```bash
cd src-tauri && cargo check && cargo test 2>&1 | tail -20; cd ..
```
Expected: `cargo check` Finished, `cargo test`의 기존 단위 테스트(`lib.rs`의 `#[cfg(test)]` 3곳) 통과.

- [ ] **Step 4: 게이트 실패 시**

실패한 게이트가 있으면 해당 원인을 고치고(관련 Task로 회귀) 이 태스크를 다시 통과시킨다.

---

## Task 9 (선택): 프로덕션 번들 빌드 (성공 기준 h)

로컬 배포 아티팩트까지 확인하고 싶을 때만.

**Files:** (없음)

- [ ] **Step 1: 릴리스 빌드**

Run:
```bash
pnpm tauri build 2>&1 | tail -40
```
Expected: `src-tauri/target/release/bundle/macos/opencode-desktop.app`(및 `dmg/`)가 생성됨. 코드 서명 없이 빌드 자체가 성공하는지만 확인(공증·서명은 비목표).

- [ ] **Step 2: 생성된 .app 실행 확인**

Run:
```bash
open "src-tauri/target/release/bundle/macos/opencode-desktop.app"
```
Expected: dev와 동일하게 창이 뜨고 기본 동작함. (macOS Gatekeeper 경고가 나오면 로컬 확인 목적상 우클릭 → 열기.)

---

## Task 10: 계획 체크박스 갱신 & 마무리 커밋

- [ ] **Step 1: 이 계획 문서의 체크박스를 실제 수행 결과대로 갱신**

- [ ] **Step 2: 발견/수정 요약을 커밋**

```bash
git add docs/superpowers/plans/2026-07-03-macos-support.md
git commit -m "docs: macOS 지원 검증 결과 반영"
```

- [ ] **Step 3: (있다면) 남은 이슈를 KNOWN_ISSUES.md에 기록**

macOS에서만 재현되는 미해결 이슈가 있으면 기존 KI 형식으로 `KNOWN_ISSUES.md`에 추가.
