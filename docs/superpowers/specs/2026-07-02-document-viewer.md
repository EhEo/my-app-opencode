# 인-에디터 문서 뷰어 — 설계 spec

- 일시: 2026-07-02
- 상태: 설계 확정(사용자 승인) — 구현 계획 대기
- 관련: opencode-desktop (Tauri v2 + React 19 + Monaco)

## 1. 목적 / 성공 기준

VS Code의 Office Viewer 확장처럼, 문서·이미지 파일을 **에디터 영역 안에서 뷰어로** 표시한다. 파일 종류를 확장자로 감지해 Monaco 대신 적절한 뷰어 컴포넌트를 렌더한다.

**대상 포맷**: 이미지(png/jpg/jpeg/gif/svg/webp/bmp/ico), Markdown(.md 미리보기), PDF, Word(.docx), Excel(.xlsx), PowerPoint(.pptx).

**성공 기준**: (a) 이미지/PDF/docx/xlsx 파일을 탭으로 열면 에디터 영역에 내용이 렌더된다. (b) .md는 편집(Monaco)과 미리보기를 토글할 수 있다. (c) 뷰어 파일은 읽기 전용이며 저장/dirty가 비활성이다. (d) pptx 및 렌더 불가 파일은 "OS 앱으로 열기" 폴백을 제공한다. (e) 기존 텍스트/코드 편집 동작은 변하지 않는다. (f) `tsc --noEmit`·`cargo check`·프로덕션 빌드 통과.

## 2. 비목표 (MVP 제외)

- 문서 **편집**(docx/xlsx/pptx는 뷰 전용; Markdown만 텍스트로 편집 가능).
- 완벽한 서식 재현(docx/xlsx는 일부 서식 손실 허용, pptx는 베스트-에포트).
- 워크스페이스 밖 파일 뷰잉(기존과 동일하게 워크스페이스 내부만).
- 대용량 최적화(스트리밍) — 크기 상한으로 제한, asset 프로토콜 최적화는 후속.

## 3. 데이터 경로 (Rust)

신규 명령 `read_file_bytes`:
- 시그니처: `read_file_bytes(path: String, state) -> Result<{ base64: String; size: u64 }, String>` (camelCase).
- `validate_path`로 워크스페이스 한정(기존 파일 명령과 동일 신뢰 모델).
- 크기 상한 `MAX_VIEW_BYTES = 25_000_000`; 초과 시 명확한 에러.
- 바이트를 base64로 인코딩해 반환. (base64 인코딩은 std로 수동 구현 or 기존 의존성 활용 — `base64` 크레이트가 이미 트랜지티브로 존재하나 직접 의존은 아님. 수동 base64(작은 함수) 또는 `base64` 직접 의존 추가 중 택1 — 구현 계획에서 확정.)
- 이유: 문서/이미지는 바이너리라 기존 `read_file`(UTF-8 텍스트, 바이너리 거부)로는 못 읽음.

프론트 `fs.ts`에 `readFileBytes(path): Promise<{ base64; size }>` 래퍼 추가. Uint8Array 변환 헬퍼 제공.

(후속 최적화 여지: PDF/이미지는 Tauri asset 프로토콜(`convertFileSrc`)로 URL 로드가 더 효율적이나, MVP는 base64 단일 경로로 단순화.)

## 4. 파일 종류 라우팅 (프론트)

`src/lib/fileKind.ts`: `fileKind(path): "text" | "image" | "markdown" | "pdf" | "docx" | "xlsx" | "pptx" | "binary"` — 확장자 기반 순수 함수(단위 테스트 대상).

| kind | 렌더 | 라이브러리 |
|------|------|-----------|
| text | Monaco (현행) | — |
| image | `<img>` 데이터 URL (svg는 안전 처리) | 없음 |
| markdown | 편집(Monaco) ↔ 미리보기(react-markdown) 토글 | 기존 react-markdown |
| pdf | 페이지 캔버스 렌더 + 스크롤 | `pdfjs-dist` (동적 import) |
| docx | HTML 변환 표시 | `docx-preview` (동적 import) |
| xlsx | 시트 탭 + HTML 표 | `xlsx`(SheetJS) (동적 import) |
| pptx | 베스트-에포트 렌더, 실패 시 폴백 | pptx 렌더러 (동적 import) + 폴백 |
| binary | "미리보기 불가 — OS 앱으로 열기" | tauri-opener |

- 무거운 라이브러리는 **동적 `import()`**로 코드 스플리팅해 초기 번들 영향 최소화.

## 5. 컴포넌트 구조

- `src/components/viewers/DocViewer.tsx` — 디스패처: `kind`에 따라 서브뷰어 렌더. 로딩/에러 상태 처리.
- 서브뷰어(각 파일): `ImageViewer`, `PdfViewer`, `DocxViewer`, `XlsxViewer`, `PptxViewer`, `MarkdownPreview`, `UnsupportedViewer`(폴백).
- 각 뷰어는 `{ path }`(+ 필요 시 bytes)를 받아 스스로 로드/렌더. 읽기 전용.
- `src/components/viewers/openExternally.ts` — `tauri-plugin-opener`로 파일을 OS 기본 앱에서 열기(폴백/미지원용).

## 6. 앱 통합 (App / EditorPane / Tabs)

- **탭 모델 확장**: `TabState`에 `kind: "text" | "viewer"` 추가(뷰어면 `content` 텍스트 불필요).
- **`handleOpenFile`**: `fileKind(path)`로 분기 — `text`/`markdown`은 기존 경로(readFile→Monaco; markdown은 편집 가능 텍스트로 열되 미리보기 토글 제공), 그 외(image/pdf/docx/xlsx/pptx/binary)는 뷰어 탭으로 열기(텍스트 read 안 함).
- **EditorPane**: 활성 탭이 viewer면 Monaco 대신 `<DocViewer path=… kind=… />` 렌더. text면 현행 Monaco.
- **읽기 전용 처리**: viewer 탭은 저장(Ctrl+S)/dirty/디스크충돌 watcher 대상에서 제외. Toolbar 저장 버튼 비활성.
- **StatusBar**: viewer 탭은 커서/언어 대신 파일 종류·크기 정도 표시(간단히).
- 기존 텍스트 편집·탭·검색 동작은 불변.

## 7. 에러 처리

- 크기 초과 / 읽기 실패 / 파싱 실패 → 뷰어 영역에 명확한 메시지 + "OS 앱으로 열기" 버튼(가능 시).
- 라이브러리 동적 import 실패 → 폴백 메시지.
- pptx 렌더 실패 → 자동으로 "OS 앱으로 열기" 안내.
- 뷰어 로딩 중 스피너.

## 8. 테스트

- **단위(vitest)**: `fileKind`(확장자→kind 매핑, 대소문자, 미지원). base64→Uint8Array 변환 헬퍼. 라우팅 결정 로직.
- **Rust**: `read_file_bytes` 크기 상한/경로 검증(작은 픽스처), base64 인코딩 정확성.
- **수동 스모크**(`pnpm tauri dev`): png·pdf·docx·xlsx·md 각각 열어 렌더 확인, pptx 폴백, 텍스트 파일은 기존대로 Monaco.
- 게이트: `tsc --noEmit` + `cargo check` + `pnpm test` + 프로덕션 빌드.

## 9. 단계 (구현 계획 분할)

- **P1 (토대 + 가벼운 뷰어)**: Rust `read_file_bytes` + `fs.readFileBytes` + `fileKind` + `DocViewer` 디스패처 + ImageViewer + MarkdownPreview 토글 + PDF(pdfjs) + 앱 라우팅/탭 kind/읽기전용. → 이미지·MD·PDF가 동작하는 완결 산출물.
- **P2 (Office)**: DocxViewer(docx-preview) + XlsxViewer(SheetJS).
- **P3 (PPTX + 폴백)**: PptxViewer 베스트-에포트 + `openExternally` + UnsupportedViewer.

## 10. 리스크

1. 번들 크기(pdf.js·SheetJS) → 동적 import로 완화.
2. pptx 웹 렌더 품질 낮음 → 폴백 필수.
3. base64 IPC 대용량 비용 → 25MB 상한; 후속 asset 프로토콜.
4. Monaco↔뷰어 전환 시 탭/상태 일관성(읽기전용 분기) → 탭 kind로 명확히.
5. SVG 이미지의 XSS 우려 → `<img src=dataURL>`로 렌더(스크립트 비실행), 인라인 삽입 금지.
