# Bid Automation Overview

## Repository Layout
- `automation-engine/` – Playwright 기반 자동화 엔진. CLI 진입점(`src/cli.js`)을 통해 단일 작업(job) JSON을 입력받아 실행하며 공용 로직은 `src/core`, 사이트 구현은 `src/sites`에 위치합니다.
- `electron-app/` – Electron UI 셸. 메인 프로세스(`main.js`)가 엔진 CLI를 서브프로세스로 실행하고, 렌더러(`renderer/`)가 설정 관리·실행 제어 UI를 제공합니다.
- 루트 `package.json` – 두 워크스페이스를 연결하고 `npm run app:dev`, `npm run engine:demo` 등의 스크립트를 노출합니다.

## Automation Engine (automation-engine)
- **CLI 파이프라인**: `src/cli.js`가 job 파일을 로드한 뒤 `orchestrator.run` 호출 전/후에 JSON 이벤트를 stdout으로 내보냅니다.
- **오케스트레이션**: `src/core/orchestrator.js` – 브라우저 준비 → 로그인 → 인증서 처리 → 사이트별 후속 단계 순으로 진행하며, `emit` 콜백을 통해 UI에 진행률/로그를 전달합니다. 실패 시 브라우저 유지 여부, 데모 모드 등의 옵션을 job에서 읽습니다.
- **Playwright 레이어**: `src/web/playwright.js` – Edge 프로필 재사용, 팝업 자동 닫기(`attachPopupAutoCloser`), 공통 오버레이 정리 등을 처리하고 사이트별 로그인 훅(`loginKepco`, `loginMnd`)을 호출합니다.
- **사이트 모듈**:
  - `src/sites/kepco.js` – 한전 로그인, 메뉴 이동(`goToBidApplyAndSearch`), 입찰 검색 및 신청 버튼 클릭 등 복잡한 프레임/ExtJS 조작을 캡슐화합니다.
  - `src/sites/mnd.js` – 국방부 사이트 로그인 및 공인인증 흐름을 담당합니다.
  - `src/sites/nxCertificate.js` – 웹 NX 인증 모달을 탐지하고 인증서 행 선택, 매체 선택, PIN 입력을 자동화합니다.
- **네이티브 자동화**:
  - `src/native/uia.js` – PowerShell UIAutomation 스크립트를 생성해 윈도우 공인인증 창에서 인증서를 선택하고 비밀번호를 입력합니다.
  - `src/native/scanCerts.js` – 로컬 `NPKI` 디렉터리(USB 포함)를 스캔해 인증서 Subject/Issuer/Serial 정보를 수집, job 설정 보강에 활용합니다.

## Electron Shell (electron-app)
- **메인 프로세스 (`main.js`)**
  - 작업 실행: job JSON을 `userData/jobs/`에 저장 후 Node 런타임으로 엔진 CLI를 spawn하여 stdout을 이벤트로 변환합니다.
  - IPC 채널: `settings:load/save`, `dialog:selectPath`, `cert:inspect`(PowerShell로 인증서 메타 추출), `engine:run/stop`.
  - 설정 저장: `userData/settings.json` 파일에 회사·사이트 URL·옵션 정보를 직렬화합니다.
- **프리로드 (`preload.js`)** – `window.api`로 IPC 래핑을 노출하여 렌더러에서 안전하게 사용합니다.
- **렌더러 (`renderer/renderer.js`)**
  - 탭 UI/설정 폼: 회사/인증서/계정 정보를 편집하고 저장합니다.
  - 실행 버튼: 선택된 회사·사이트 정보로 job payload 생성 후 `window.api.runEngine` 호출.
  - 진행 상황: `engine:event` 수신 시 게이지, 단계 배지, 로그 패널, 토스트 메시지를 갱신하며, 종료 이벤트로 버튼 상태를 초기화합니다.

## Job 실행 흐름
1. 사용자가 UI에서 사이트·URL·회사 정보를 선택 후 실행을 누릅니다.
2. 렌더러가 job JSON을 구성하고 IPC로 전송합니다.
3. 메인 프로세스가 job 파일을 저장하고 엔진 CLI를 실행합니다.
4. `orchestrator.run`이 Playwright 브라우저를 띄워 로그인·인증을 자동화하고, 진행 중 이벤트를 stdout(JSON)으로 송신합니다.
5. 메인 프로세스가 해당 JSON을 렌더러로 브릿지하여 UI가 실시간 상태를 표시합니다.
6. 작업 종료 시 엔진은 `done` 이벤트와 결과(`PREPARED-<site>-timestamp`)를 내보내며, 현재는 실제 “신청 완료” 확인/증빙 저장은 자리표시자 상태입니다.

## 설정 & 데이터
- **설정 파일**: `settings.json`에 회사 목록, 사이트 URL, 인증서·계정 정보, 기본 옵션(`certTimeoutSec` 등)이 저장됩니다. 비밀번호/PIN은 현재 평문 저장이므로 보안 대책이 필요합니다.
- **인증서 검사**: 렌더러에서 “경로 찾기”를 누르면 `cert:inspect` IPC를 통해 PowerShell이 인증서 Subject/Issuer/Serial 메타데이터를 추출하여 폼에 자동 채움합니다.
- **로그/아웃풋**: 엔진 실행 중 캡처 HTML, 스크린샷 등은 `electron-app/engine_runs/<timestamp>/`에 저장되며, CLI는 `engine_runs/` 디렉터리를 자동 생성합니다.

## 한계 및 후속 작업 아이디어
1. **신청 완료 검증** – `orchestrator` 및 `sites/kepco.js`·`sites/mnd.js`에 최종 제출 확인, 결과 캡처/리포트 저장 로직 보강.
2. **다중 작업 관리** – Job 큐, 실행 이력(UI 탭) 추가 및 JSONL 기반 로그 저장으로 재현성 확보.
3. **보안 강화** – 회사별 계정/인증서 PIN 암호화(Windows DPAPI, 자격 증명 관리자 등) 및 UI 재인증 플로우 도입.
4. **오류 복구성** – Playwright 브라우저 채널 fallback, Edge 프로필 잠김 시 재시도/가이드 개선, 사이트 구조 변화 대비 추가 셀렉터 확보.
5. **테스트/모듈화** – 주요 함수에 대한 단위 테스트(예: 인증서 필터링, 설정 유효성 검사)와 로그 스키마 정의로 유지보수성을 향상.

## 개발/운영 메모
- 데모 모드: 루트에서 `npm run engine:demo` 또는 Electron `npm run app:dev` 실행 후 “데모” 옵션을 job에 넣으면 브라우저 없이 진행률만 시뮬레이션합니다.
- Playwright 설치: `automation-engine` 디렉터리에서 `npm install` 후 `npx playwright install chromium` 실행이 필요합니다.
- 인증서 스크립트: PowerShell 실행 정책 문제 시 `Set-ExecutionPolicy -Scope Process Bypass` 또는 관리자 권한으로 실행해야 할 수 있습니다.

