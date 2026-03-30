# PC 백업/복구 + Codex 인계 가이드 (Windows)

## 목적
포맷 후 새 PC에서 이 프로젝트(`bidentry`)를 즉시 이어서 개발하고, 다음 세션 Codex에게도 같은 파일 하나로 바로 인계할 수 있게 정리한다.

## 프로젝트 구조
- 루트 워크스페이스: `package.json` (workspaces: `automation-engine`, `electron-app`)
- 엔진: `automation-engine` (Playwright 포함)
- 앱 셸: `electron-app` (Electron + Vite + React)

## 사전 준비
- Git 설치
- Node.js LTS 설치 (권장: 20.x 이상)
- npm 사용 가능 상태 확인
- (선택) Visual Studio Build Tools / Python: 일부 네이티브 모듈 이슈 대비

## 백업 체크리스트 (기존 PC)
1. 원격 저장소에 모든 코드 push
2. `.env` 별도 백업 (민감정보 포함, git에 올리지 않음)
3. 필요 시 `%APPDATA%/automation-shell/settings.json` 백업
4. 필요 시 `docs/`, `engine_runs/` 내 로컬 참고 로그 백업

## 새 PC 복구 절차
1. 저장소 클론
2. 루트 폴더로 이동
3. 복구 스크립트 실행
   - `powershell -ExecutionPolicy Bypass -File .\scripts\setup-new-pc.ps1`
4. Playwright 브라우저 설치를 건너뛰려면
   - `powershell -ExecutionPolicy Bypass -File .\scripts\setup-new-pc.ps1 -SkipPlaywrightInstall`
5. `.env` 복원
   - 백업한 `.env`를 루트에 배치
6. 개발 실행
   - `npm run dev`

## 핵심 실행 커맨드
- 앱 개발 실행: `npm run dev`
- 엔진 데모 실행: `npm run engine:demo`
- 앱 빌드: `npm run build`

## 주의사항
- `.env`의 API 키/시크릿은 절대 저장소 커밋 금지
- `node_modules/`, `dist/`, `out/`는 재설치/재빌드로 복구 가능하므로 백업 불필요
- 인코딩 문제 방지를 위해 소스/문서는 UTF-8 유지 권장

---

## Codex 인계 메모 (다음 세션용)

### 현재 목표
- KEPCO/MND 자동화 프로젝트를 Electron UI + automation-engine 구조로 유지 개발
- 포맷 후 복구 가능한 개발환경으로 정리

### 프로젝트 핵심 구조
- 루트: workspace 관리
- `automation-engine`: CLI, 오케스트레이터, 사이트 자동화(Playwright/UIA)
- `electron-app`: 실행 UI 셸, renderer(Vite/React)

### 실행 기준
- 개발 실행: `npm run dev`
- 엔진 단독 점검: `npm run engine:demo`
- 빌드: `npm run build`

### 의존성/환경 포인트
- root / automation-engine / electron-app 각각 npm 설치 필요
- `automation-engine`는 Playwright 사용
- `.env` 필수(민감정보 포함, git 미포함)
- `%APPDATA%/automation-shell/settings.json`에 로컬 설정 저장될 수 있음

### 최근 맥락(문서 기준)
- `docs/2026.02.24.md`: KEPCO 로그인 안정화/속도개선, Edge 로컬 네트워크 이슈 우회
- `docs/2026.02.25.md`: 참가신청 버튼/팝업/체크박스 흐름 안정화
- `docs/2026.02.27.md`: 최종 제출 단계 안정화 및 다건 처리 정책 정리
- `docs/automation-notes.md`: KEPCO 문자열 깨짐/인증서 path 전달 등 잔여 이슈 메모

### 다음 Codex 우선 작업
1. `automation-engine/src/sites/kepco.js` 문자열 깨짐 여부 및 인코딩 문제 재점검
2. 인증서 선택 로직에서 `job.cert.path` 전달/사용 경로 점검
3. 최신 실행 로그 기준 실패 지점 재현 후 최소 수정
4. 수정 후 `npm run dev` 및 `npm run engine:demo` 스모크 확인

### 복구 스크립트
- `scripts/setup-new-pc.ps1` 실행으로 설치/기본 점검 자동화
