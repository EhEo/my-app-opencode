# opencode-desktop 멀티에이전트 파이프라인 MVP — 설계 spec

- 작성일: 2026-07-02
- 상태: 설계(검토 대기)
- 참고 분석: `tasks/multiagent-integration/artifacts/direction.md`
- 참고 저장소: netwaif/multi-agent-starter(실행), steipete/CodexBar(텔레메트리), netwaif/usage-coach(가드), soulduse/ai-token-monitor(Windows 로컬 JSONL 사용량 기법)

## 1. 목적 / 성공 기준

opencode-desktop에 **결정형 3단계 파이프라인(계획→코딩→검토)** 형태의 멀티에이전트 기능을 추가한다.
- 기존 인앱 AI(OpenAI 호환 프로바이더)가 **기본**이고, 외부 CLI 에이전트(claude/codex/gemini)를 **보조**로 설정해 함께 쓴다.
- 각 단계의 워커(백엔드)를 **설정 기본값 또는 실행 시 드롭다운으로 사용자가 선택**할 수 있다.
- 사용량 모니터(인앱 토큰 회계 + CLI JSONL 파싱)를 **표시 + 소프트 가드**(예산/임계 경고, 일시정지 확인)로 제공한다.
- Windows에서 즉시 동작(CodexBar 불필요) — 로컬 JSONL 파싱 + 인앱 토큰 회계로 사용량 확보.

**성공 기준**: (a) 설정 없이 인앱-only 3단계 파이프라인이 실행/스트리밍/취소된다. (b) 한 단계를 CLI 워커로 교체해 실행된다. (c) 사용량이 표시되고, 임계 초과 시 파이프라인이 일시정지해 확인을 받는다. (d) `tsc --noEmit`·`cargo check` 통과.

## 2. 비목표 (MVP 제외)

- 검토 단계의 자동 수정 적용(리포트-only).
- usage-coach식 쿼터-리셋 인지형 하드 가드(리셋 시각 데이터 필요 → 다음 단계).
- LLM 주도 자동 위임(delegate 도구), 팬아웃/병렬 토폴로지.
- CodexBar 연동(옵션·후속). API 키 암호화(기존 하드닝 항목으로 유지).

## 3. 아키텍처 & 모듈 경계

**프론트엔드(TS)**
- `lib/workers.ts` — `WorkerBackend` 타입 + 레지스트리(설정 load/save), 역할→백엔드 해석, CLI 자동탐지(`--version`).
- `lib/agentExec.ts` — 스트리밍 Rust exec 커맨드 클라이언트(start/kill + 이벤트 스트림, stdout 누적, abort).
- `lib/pipeline.ts` — 오케스트레이터 `runPipeline(request, stages, callbacks)`. 단계 순차 실행, 브리프/결과 전달, 진행 이벤트 emit. `inapp` 단계는 `runAgent` 재사용.
- `lib/usage.ts` — 사용량 집계(인앱 `usage` 누적 + Rust JSONL 호출) + 소프트 가드 상태 계산.
- `components/PipelinePanel.tsx` — ChatPanel 내 `[Chat | Pipeline]` 모드 토글. 입력 + 3 단계 카드(상태/스트리밍/단계별 백엔드 드롭다운) + 실행/중지 + 가드 배너.
- `components/UsageStrip.tsx` — 사용량 표시 + 가드 상태.
- `SettingsModal` — "Agents" 탭 신설.

**백엔드(Rust, `src-tauri/src/lib.rs`)**
- `agent_exec_start(id, program, args[], cwd?, stdin?, env?, onEvent)` — 스트리밍 실행. 이벤트: `Stdout{data}`/`Stderr{data}`/`Exit{code}`. 실행 맵 등록(취소), `no_window`, 고정 타임아웃 없음, stdin 주입 후 닫기.
- `agent_exec_kill(id)` — 기존 `kill_process_tree` 재사용.
- `read_usage_logs()` — 읽기 전용, 알려진 경로만(`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`) 파싱 → 집계(일/세션/도구별). 깨진 라인 스킵.

**원칙**: 기존 `agent.ts`/`tools.ts`/`settings.ts` 최소 변경. 신규 기능은 새 모듈로 분리. 인앱 백엔드는 `runAgent` 호출이라 도구·MCP·프로바이더 자동 재사용.

## 4. 데이터 모델 (`ProviderStore`에 추가, 기존과 공존)

```ts
type WorkerBackend =
  | { kind: "inapp"; providerId: string; model?: string; systemPrompt?: string }
  | { kind: "cli"; command: string; argsTemplate: string[]; briefMode: "stdin" | "arg";
      cwd?: string; timeoutSec?: number; resultParse?: "raw" | "json" }
  | { kind: "mcp"; server: string; tool: string };

interface StageConfig { id: "plan" | "code" | "review"; label: string; backendRef?: string; enabled: boolean }

interface ProviderStoreAdditions {
  workers?: Record<string, WorkerBackend>;          // 역할/워커 id → 백엔드
  pipeline?: { stages: StageConfig[] };             // 미설정 시 3단계 기본, 전부 inapp
  usageGuard?: { enabled: boolean; perRunBudgetTokens?: number; warnRatio: number; providers?: string[] };
}
```

`backendRef` 미지정 = 인앱 기본. 기본 stages = `[plan, code, review]` 모두 inapp.

## 5. 런타임 흐름

```
입력 → [가드] → 계획(백엔드) → [가드] → 코딩(백엔드, 파일쓰기) → [가드] → 검토(읽기전용 리포트) → 완료
                              (각 단계 후 usage 갱신 → UsageStrip)
```

각 단계:
1. 브리프 = 단계 프롬프트 + 이전 단계 결과 + 원 요청 + 열린 파일 컨텍스트(ChatPanel의 `buildOpenFilesContext` 재사용).
2. 가드 체크(단계 전): 임계 초과 시 `onGuard` → 사용자 확인 대기(일시정지).
3. 백엔드 실행: `inapp`→`runAgent`(단계 시스템 프롬프트+프로바이더), `cli`→`agentExec`(브리프 stdin/arg, 결과 파싱), `mcp`→`callTool`.
4. 결과 전달 + file-as-memory 기록(`.opencode/pipeline/<runId>/stageN.{brief,result}.md`).
5. 취소: 현재 단계 중단(CLI kill / runAgent abort) → 정지.

**단계 책임**: 코딩만 파일 쓰기. 검토는 읽기 전용 리포트.

## 6. 사용량 & 소프트 가드

- 소스: ① 인앱 = 응답 `usage` 누적(세션 토큰). ② CLI = `read_usage_logs` JSONL 집계.
- 합산 요약 `{ byTool, session, today }` → UsageStrip.
- 소프트 가드(MVP): 실행당 예산 + 누적 경고 임계. 단계 전 초과 시 파이프라인 일시정지 + 확인. **리셋-인지 아님**(로컬 JSONL 한계).
- fail-open: 로그 없음/파싱 오류 시 가드 통과 + "사용량 확인 불가" 표시.

## 7. UI

ChatPanel 상단 `[ Chat | Pipeline ]` 토글(새 레이아웃 열 없음). Pipeline 모드:
- 입력 textarea + 실행 버튼, UsageStrip(세션/오늘 도구별/가드 상태).
- 단계 카드 3개: 라벨 + **백엔드 드롭다운(기본 inapp, 등록 CLI로 교체)** + 상태(대기/실행/완료/오류) + 접이식 스트리밍 출력 + 단계 토큰.
- 가드 일시정지 배너(계속/중지), 중지 버튼, 완료 시 검토 리포트 + 트랜스크립트 저장.

Agents 설정 탭(AI/MCP/Skills/터미널 옆):
1. 워커 레지스트리(추가/편집/삭제): inapp(프로바이더+모델+시스템프롬프트) / cli(명령+[탐지]버튼+args+브리프모드+타임아웃+결과파싱).
2. 파이프라인 기본값: 단계→워커 매핑(기본 inapp).
3. 사용량 가드: 예산/임계/추적대상/on-off.

## 8. 에러 처리 · 보안

- CLI: spawn 실패→안내, 비정상 종료→stderr+오류+인앱 폴백 제안, 대화형→비대화형 강제+타임아웃 kill.
- 인앱: 기존 `runAgent` 오류/abort 재사용.
- 파이프라인: 단계 오류 시 정지 + 재시도/백엔드 교체 후 재실행, 부분 트랜스크립트 저장.
- 보안: CLI 실행은 run_command와 동일 신뢰 모델, cwd=워크스페이스 한정, **세션 첫 CLI 실행 승인 게이트**. `read_usage_logs`는 읽기전용·알려진 경로만.

## 9. 테스트

- TS 단위: 단계 시퀀싱(목 백엔드), 브리프 구성, 사용량 합산, 가드 임계, 백엔드 해석/폴백, CLI 결과 파싱.
- Rust: `read_usage_logs` 파싱(픽스처), `agent_exec` 스트리밍(echo), `kill_process_tree`.
- 통합/수동: inapp-only 실행 → 코딩만 CLI 스텁 → 가드 일시정지 → 단계 중 abort → CLI 없음 오류.
- 게이트: 단계마다 `tsc --noEmit` + `cargo check` + 스모크.

## 10. 구현 순서 (구현 계획 청크)

1. Rust 토대: `agent_exec_start/kill` + `read_usage_logs`
2. TS 라이브러리: `workers.ts` · `agentExec.ts` · `usage.ts`
3. 오케스트레이터: `pipeline.ts`(inapp→cli/mcp) + file-as-memory
4. UI: `PipelinePanel`(모드 토글) · `UsageStrip` · 단계 드롭다운
5. 설정: Agents 탭(레지스트리 + 파이프라인 기본값 + 가드 + CLI 탐지)
6. 가드 결선 + 마무리: 소프트 가드 일시정지, 실행당 예산, 첫 CLI 승인 게이트

각 단계 tsc/cargo check + 스모크. 6까지가 MVP.

## 11. 리스크

1. CLI 인증/대화형 프롬프트 → 비대화형 강제 + 타임아웃 kill, 인증 오류 표면화.
2. CLI 출력 파싱(자유 텍스트/JSON) → 백엔드별 resultParse.
3. 비용 배증 → 소프트 가드 + 실행당 예산.
4. 로컬 JSONL은 리셋 시각 없음 → 하드 가드는 후속(CodexBar/serve 옵션).
5. 새 스트리밍 exec = 개방형 셸 → 신뢰 모델·cwd 한정·승인 게이트 유지.
