# Claude Code / Codex 스킬 스캔 & 가져오기 (P3) — 설계 spec

- 일시: 2026-07-03
- 상태: 설계 확정(사용자 승인) — 구현 계획 대기
- 관련: opencode-desktop (Tauri v2 + React 19)

## 1. 목적 / 성공 기준

이 앱은 이미 Anthropic Agent Skills 형식(`SKILL.md` + YAML frontmatter)을 완전히 지원한다(`skill_install`/`skill_list`/`skill_read`/`skill_uninstall`, 설정 Skills 탭). 다만 가져오기가 **경로를 직접 타이핑**해야 하는 1건씩 수동 방식이라, 이미 로컬에 설치된 Claude Code·Codex의 스킬을 재사용하려면 정확한 경로를 알아야 했다. 이 기능은 **알려진 위치를 스캔해 목록으로 보여주고 선택해서 한 번에 가져오는** UX를 추가한다.

**성공 기준**:
(a) 설정 Skills 탭에서 "스캔" 버튼으로 `~/.claude/plugins/cache/**`와 `~/.codex/skills/**` 아래의 모든 `SKILL.md`를 찾아 목록으로 보여준다.
(b) 각 항목에 이름·설명(frontmatter 파싱)·출처(Claude/Codex)가 표시된다.
(c) 체크박스로 여러 개를 선택해 한 번에 가져올 수 있다.
(d) 이미 설치된 이름과 겹치면 선택 불가로 표시된다(덮어쓰기 없음 — 기존 `skill_install` 동작 유지).
(e) 스캔 결과 안에서 서로 다른 출처가 같은 스킬 이름을 쓰면(실제 사례: `skill-creator`가 Claude·Codex 양쪽에 존재) 화면 표시와 실제 설치명에 출처를 구분해 표기한다.
(f) 가져온 스킬은 `scripts/`·`assets/`·`references/` 등 서브폴더까지 통째로 복사된다(기존 `skill_install`이 이미 지원 — 폴더 전체 복사).
(g) `tsc --noEmit`·`cargo check`·`pnpm test`·프로덕션 빌드 통과.

## 2. 비목표

- Codex의 `~/.codex/plugins/`(MCP 커넥터 번들: 캔바·피그마·깃허브 등) — 실행 파일/MCP 서버 통합이 필요해 훨씬 위험하고 범위가 다름. 완전히 제외.
- Claude Code 플러그인의 commands/agents/hooks(스킬 외 구성요소) 가져오기 — SKILL.md만 대상.
- 프로젝트 로컬 `.claude/skills/`(워크스페이스 상대 경로) 스캔 — 이번 조사에서 이 머신엔 없었고, 요청 범위도 "설치된 도구의 전역 스킬"이므로 전역 경로(`~/.claude`, `~/.codex`)만 대상.
- 이미 설치된 스킬 덮어쓰기/업데이트 — 기존 `skill_install`이 "이미 설치됨" 에러를 던지는 동작을 그대로 유지. 갱신하려면 먼저 제거 후 재설치(기존 UI로 이미 가능).
- 스캔 결과 캐싱/자동 새로고침 — 버튼 클릭 시 매번 새로 스캔.

## 3. 데이터 소스 (확인된 실측 경로)

| 소스 | 경로 패턴 | 확인된 구조 |
|---|---|---|
| Claude Code 플러그인 | `%USERPROFILE%\.claude\plugins\cache\<마켓플레이스>\<플러그인>\<버전>\skills\<스킬명>\SKILL.md` | 예: `claude-plugins-official\superpowers\6.0.3\skills\brainstorming\SKILL.md` |
| Codex 스킬 | `%USERPROFILE%\.codex\skills\**\SKILL.md` | 예: `.codex\skills\.system\imagegen\SKILL.md` |

두 소스 모두 SKILL.md 옆에 `agents/`·`assets/`·`references/`·`scripts/`·`LICENSE.txt`가 함께 있는 **동일한 폴더 구조**를 쓴다(공통 Anthropic Agent Skills 규격). frontmatter도 기존 파서(`name`/`description`, 따옴표 처리)와 100% 호환 확인.

## 4. 아키텍처

### 4.1 Rust — `scan_external_skills` (신규 명령, 인자 없음)

```
#[tauri::command]
fn scan_external_skills() -> Result<Vec<ExternalSkillCandidate>, String>
```
- 임의 경로 인자를 받지 않는다(`read_opencode_auth`와 동일한 보안 원칙 — 고정된 홈 기준 경로만).
- `%USERPROFILE%\.claude\plugins\cache`와 `%USERPROFILE%\.codex\skills` 두 루트를 기존 `walkdir` 의존성으로 재귀 탐색해 `SKILL.md` 파일을 전부 찾는다.
- 개별 파일 읽기 실패는 그 항목만 건너뛰고 스캔 전체는 계속한다(한 개 깨진 스킬이 전체를 막지 않음).
- 각 루트가 존재하지 않으면(도구 미설치) 그 소스는 조용히 빈 결과로 처리 — 에러 아님.
- 반환 항목: `{ source: "claude" | "codex", label: String, path: String, preview: String }`
  - `label`: 스캔 루트 기준 상대 경로(사람이 읽을 수 있는 출처 표시용, 예: `superpowers/brainstorming`).
  - `path`: SKILL.md를 담은 **폴더**의 절대경로(가져오기 시 `skill_install`에 그대로 전달).
  - `preview`: SKILL.md 원문(기존 `skill_install`과 동일하게 1MB 상한 — 초과 시 그 항목만 제외).

### 4.2 TypeScript (`src/lib/skills.ts`)

- 기존 비공개 `parseFrontmatter`를 `export`로 전환(동작 변경 없음 — 가시성만 변경).
- 신규 `scanExternalSkills(): Promise<ExternalSkillCandidate[]>` — `invoke("scan_external_skills")` 래퍼.
- `ExternalSkillCandidate` 타입: Rust 반환 구조와 동일(camelCase).

### 4.3 UI (Skills 탭, `SettingsModal.tsx`)

- "Claude Code/Codex에서 스캔" 버튼 → `scanExternalSkills()` 호출 → 결과를 `parseFrontmatter(preview)`로 파싱해 이름·설명 추출.
- 목록: 체크박스 + 이름 + 설명(일부만, 말줄임) + 출처 배지(Claude/Codex).
- **이름 충돌 처리**:
  - 스캔 결과 안에서 동일 이름이 여러 소스에 걸쳐 나오면(예: `skill-creator`) 화면 표시와 실제 설치명 모두 `이름 (source)` 형태로 구분(예: `skill-creator (claude)`, `skill-creator (codex)`).
  - 스캔 결과의 이름(또는 위 규칙 적용 후 이름)이 **이미 설치된 스킬**과 겹치면 체크박스를 비활성화하고 "이미 설치됨" 표시.
- "선택 항목 가져오기" 버튼 → 체크된 항목마다 기존 `installSkillBackend(path, installName)`(= `skill_install`) 호출 → 완료 후 스킬 목록 새로고침(`onRefresh`, 기존 콜백 재사용).
- 개별 항목 가져오기 실패(예: 동시성으로 인한 경합)는 그 항목만 실패로 표시하고 나머지는 계속 진행.

## 5. 에러 처리

- 스캔 루트 둘 다 없음(Claude Code·Codex 모두 미설치) → 빈 목록 + "설치된 Claude Code/Codex 플러그인·스킬을 찾을 수 없습니다" 안내(에러 아님).
- 개별 SKILL.md 파싱 실패/1MB 초과 → 그 항목만 스캔 결과에서 제외, 전체 스캔은 정상 완료.
- 가져오기 중 "이미 설치됨" 에러(경합 등 예외 상황) → 그 항목만 실패 표시, 나머지 계속 진행.

## 6. 테스트

- **vitest**: `parseFrontmatter`(export 전환 후에도 기존 동작 유지 — 회귀 테스트), 이름 충돌 감지·표시명 생성 로직(순수 함수로 분리해 테스트: 동일 이름 스캔 결과 → `(source)` 접미사 부여, 이미 설치된 이름과 겹치는 항목 → 비활성 플래그).
- **Rust**: `scan_external_skills`가 존재하지 않는 루트에 대해 에러 없이 빈 결과를 반환하는지(단위 테스트 또는 수동 확인 — 이 프로젝트의 기존 Rust 테스트 관례상 파일시스템 의존 테스트는 최소화되어 있으므로 `cargo check` 통과 + 수동 스모크로 검증).
- **수동 스모크**(`pnpm tauri dev`): 스캔 → 목록에 Claude Code(superpowers 등)·Codex(imagegen 등) 스킬이 보이는지 → `skill-creator` 같은 중복 이름이 소스별로 구분되는지 → 몇 개 선택해 가져오기 → Skills 목록에 반영되고 채팅에서 활성화 시 시스템 프롬프트에 실제로 주입되는지(`buildSkillsPrompt` 경로, 기존 로직 무변경이므로 회귀 없이 동작해야 함) → 이미 설치된 항목이 재스캔 시 비활성 표시되는지.
- 게이트: `tsc --noEmit` + `cargo check` + `pnpm test` + `pnpm build`.

## 7. 보안

- `scan_external_skills`는 인자를 받지 않고 고정된 두 홈 기준 경로만 순회 — 임의 경로 스캔 표면이 아니다.
- 가져오기는 기존 `skill_install`의 검증(SKILL.md 존재 확인, 1MB 상한, 이름 검증 `validate_skill_name`)을 그대로 통과해야 한다 — 신규 우회 경로 없음.
- 가져온 스킬 본문은 기존과 동일하게 시스템 프롬프트에 텍스트로만 주입된다(코드 실행 아님) — 이번 기능이 새로운 실행 표면을 추가하지 않는다.

## 8. 리스크

1. **스캔 결과가 매우 많을 수 있음**(설치된 플러그인 수에 비례) — 목록은 스크롤 가능한 형태로 제공, 별도 페이지네이션은 MVP 범위 밖.
2. **Codex 스킬 디렉터리 구조가 향후 바뀔 가능성** — `SKILL.md` 재귀 탐색 방식(`walkdir`, 특정 하위 깊이 하드코딩 없음)이라 구조 변화에 비교적 견고.
3. **동일 이름 충돌 로직의 엣지 케이스**(3개 이상 소스가 같은 이름을 쓰는 경우는 현재 관측된 바 없음 — 발생 시에도 `(source)` 접미사가 소스별로 유일하므로 처리 가능).
