# opencode-desktop macOS 지원 — 검증 & 수정 spec

- 일시: 2026-07-03
- 상태: 설계 확정(사용자 승인 대기) — 구현 계획 대기
- 관련: opencode-desktop (Tauri v2 + React 19)

## 1. 목적 / 성공 기준

이 저장소는 지금까지 Windows 기준으로 개발·검증되어 왔고, 이 Mac(`darwin`)에서는 한 번도 실행해본 적이 없다. 별도 브랜치 없이 main 코드베이스를 그대로 macOS에서 빌드·실행되게 만드는 것이 목표다. 새 기능 추가가 아니라 **기존 앱을 macOS 환경에서 검증하고, 막히는 부분을 고쳐서 동작시키는** 작업이다.

**성공 기준**:
(a) `pnpm install` → `pnpm tauri dev`로 앱 창이 뜬다.
(b) 워크스페이스 폴더 열기(`pick_folder`/`set_workspace_root`), 파일 트리(`list_dir`/`stat_file`), 파일 읽기/쓰기(`read_file`/`read_file_bytes`/`write_file`)가 동작한다.
(c) 터미널(`terminal_create`/`terminal_write`/`terminal_resize`/`terminal_kill`, portable-pty 기반)이 macOS 셸(zsh/bash)로 정상 동작한다.
(d) 셸 명령 실행(`run_command`)과 에이전트 실행(`agent_exec_start`/`agent_exec_kill`)이 `sh -c` 경로로 동작하고, 프로세스 트리 종료(`kill_process_tree`/`kill_pid_tree`)가 좀비 없이 이루어진다.
(e) 문서 뷰어(xlsx/docx/pdf/pptx — `XlsxViewer` 등 `src/components/viewers/`)가 macOS에서도 동일하게 렌더링된다.
(f) 스킬 스캔/설치(`scan_external_skills`, `skill_install` 등)가 macOS 경로(`~/.claude/plugins/cache`, `~/.codex/skills`)를 대상으로 정상 동작한다.
(g) `cargo check` + `tsc --noEmit` + `pnpm test` 통과.
(h) (선택) `pnpm tauri build`로 macOS `.app`/`.dmg` 번들이 생성된다.

## 2. 비목표

- Windows 코드 경로 변경/리팩터링 — 기존 `#[cfg(windows)]` 분기는 그대로 두고 손대지 않는다. 이번 작업은 `#[cfg(not(windows))]` 쪽(현재는 사실상 미검증 상태)을 macOS에서 실측하고 필요한 만큼만 고친다.
- CI/CD 파이프라인 구축(GitHub Actions 등으로 macOS 빌드 자동화) — 저장소에 현재 워크플로우가 전혀 없으며, 이번 범위는 로컬에서 수동으로 빌드·실행되는 것까지다. 필요해지면 별도 작업으로 분리.
- 코드 서명/공증(notarization) — 배포용 서명 없이 로컬 빌드·실행 확인까지만.
- Linux 지원 검증 — `#[cfg(not(windows))]`가 Linux도 포함하지만 이번 작업은 macOS 실측에 한정. (참고: `kill_process_tree`/`kill_pid_tree`의 `kill -9` 방식은 Linux에서도 이미 유효하므로 부수적으로 개선될 수는 있음.)
- README/mat 관련 macOS 안내 문구 추가 — 이번 스펙 범위는 앱 자체 동작이며, 문서화는 완료 후 필요 시 별도로.

## 3. 현재 상태 (코드 조사 결과)

이미 크로스플랫폼 대응이 상당 부분 되어 있음이 확인됨:

| 영역 | 현황 |
|---|---|
| 프로세스 종료 | `kill_process_tree`/`kill_pid_tree`: Windows는 `taskkill`, 그 외는 `child.kill()`/`kill -9` — macOS 경로 이미 존재 |
| 셸 실행 | `build_shell_command`: Windows는 `cmd /C`, 그 외는 `sh -c` — macOS 경로 이미 존재 |
| 콘솔 숨김 | `no_window`: Windows 전용 `CREATE_NO_WINDOW`, 그 외는 no-op |
| 인코딩 | `decode_os_bytes`: UTF-8 우선, 실패 시 Windows는 OEM 코드페이지, 그 외는 lossy UTF-8 |
| PTY | `portable-pty` 크레이트 — Windows/macOS/Linux 모두 지원하는 크로스플랫폼 구현체 |
| 파일 다이얼로그 | `rfd` 크레이트 — macOS 네이티브 다이얼로그 지원 |
| 경로 canonicalize | `dunce` — Windows `\\?\` prefix 회피용이며 비-Windows에서는 `std::fs::canonicalize`로 그대로 동작 |
| 번들 설정 | `tauri.conf.json`에 `icon.icns` 포함, `bundle.targets: "all"` |
| 권한(capabilities) | `default.json`의 권한이 OS 종속적이지 않음(창 제어, opener, dialog) |

**미확인/리스크 영역** (실행해봐야 아는 것):
- Rust 의존성(`reqwest` rustls-tls, `tokio`, `walkdir` 등)이 macOS에서 컴파일되는지 — 이론상 전부 크로스플랫폼 크레이트라 문제 없을 가능성이 높으나 실측 전 확신 불가.
- Xcode Command Line Tools / Rust 타깃(`aarch64-apple-darwin` 등) 설치 여부.
- `decorations: false`(커스텀 타이틀바)가 macOS에서 창 컨트롤(신호등 버튼) 렌더링과 충돌하는지 — Windows 전용 UI를 가정한 프론트엔드 코드(예: 커스텀 창 컨트롤 버튼)가 있다면 macOS에서 트래픽 라이트와 겹칠 수 있음.
- 경로 구분자(`\` vs `/`)를 하드코딩한 프론트엔드/백엔드 코드가 있는지.
- xterm.js/Monaco 등 웹 기반 컴포넌트는 OS 비종속적이라 문제 가능성 낮음.

## 4. 작업 절차

새 아키텍처를 설계하는 게 아니라 **실행 → 관찰 → 수정**의 반복이므로, 절차를 다음과 같이 정의한다.

1. **환경 점검**: `rustc --version`, `xcode-select -p`, Rust 타깃(`rustup target list --installed`) 확인. 없으면 설치 안내.
2. **의존성 설치 & dev 실행**: `pnpm install` → `pnpm tauri dev`. 컴파일 에러가 나면 원인별로 수정(크레이트 macOS 미지원, feature flag 문제 등).
3. **핵심 기능 수동 스모크** (성공 기준 (b)~(f) 항목별로 하나씩): 워크스페이스 열기 → 파일 트리/읽기/쓰기 → 터미널 → 셸 명령 실행/종료 → 문서 뷰어 각각 열어보기 → 스킬 스캔.
4. **창 UI 확인**: `decorations: false` 커스텀 타이틀바가 macOS에서 신호등 버튼과 겹치지 않는지, 프론트엔드 커스텀 창 컨트롤(`src/components/`)이 Windows 전용 가정(예: 우측 상단 X/최소화/최대화 버튼 배치)을 갖고 있으면 macOS 관례(좌측 신호등)와 조율이 필요한지 확인 — 필요 시 최소한의 조정만.
5. **발견된 이슈 수정**: 기존 컨벤션(`#[cfg(windows)]` / `#[cfg(not(windows))]`)을 그대로 따라 분기 추가. 새로운 크로스플랫폼 유틸이 필요하면 최소 범위로 추가.
6. **빌드 게이트**: `cargo check`, `tsc --noEmit`, `pnpm test` 통과 확인.
7. **(선택) 배포 빌드 확인**: `pnpm tauri build`로 `.app` 생성 여부 확인.

## 5. 에러 처리 방침

- 컴파일이 안 되는 의존성을 만나면: 해당 크레이트의 macOS 지원 여부를 먼저 확인하고, 대안 크레이트나 `#[cfg(target_os)]` 분기로 최소 수정.
- 런타임에서 깨지는 기능은: 재현 → 원인 파악(systematic-debugging) → 기존 Windows 분기 컨벤션에 맞춰 macOS/`not(windows)` 쪽 코드 추가 또는 수정.
- Windows 전용으로 이미 있던 동작(`taskkill`, `cmd /C`, OEM 코드페이지 등)은 절대 건드리지 않는다 — `cfg` 분기로 완전히 격리되어 있으므로 macOS 수정이 Windows에 영향을 줄 수 없어야 한다.

## 6. 테스트

- **cargo check / cargo test**: 기존 Rust 단위 테스트(`#[cfg(test)]` 블록, `lib.rs` 3곳) 통과 확인.
- **tsc --noEmit / pnpm test (vitest)**: 프론트엔드 회귀 없는지 확인.
- **수동 스모크** (`pnpm tauri dev`): 3장 성공 기준 (b)~(f) 각 항목을 실제로 클릭/입력해보며 확인. 특히 터미널(PTY)과 셸 명령 실행(프로세스 트리 종료 포함, 예: 긴 실행 중 명령을 kill했을 때 좀비 프로세스가 남지 않는지)은 반드시 실측.
- **(선택) pnpm tauri build**: 생성된 `.app`을 더블클릭으로 직접 실행해 dev와 동일하게 동작하는지 확인.

## 7. 리스크

1. **Xcode/Rust 툴체인 미설치**로 인한 초기 셋업 시간 — 최초 1회성 비용, 코드 문제 아님.
2. **커스텀 타이틀바(`decorations: false`)의 플랫폼별 UX 차이** — Windows 관례로 만들어진 창 컨트롤이 macOS에서 어색하거나 신호등과 겹칠 수 있음. 기능적으로는 문제없어도 시각적 조정이 필요할 수 있음 (범위: 최소 조정만, 전면 재디자인은 비목표).
3. **실측 전에는 알 수 없는 이슈**가 있을 수 있음 — 이 스펙은 알려진 리스크까지만 다루고, 3장의 "미확인/리스크 영역"에서 언급한 것 외의 문제가 나오면 같은 원칙(기존 컨벤션 준수, Windows 경로 불변)으로 대응.
