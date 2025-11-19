# 자동화 엔진 메모

## 전체 흐름
1. `automation-engine/src/cli.js`는 선택 입력인 job JSON을 읽고 `started` · `progress` · `done/error` 이벤트를 JSON 라인으로 내보낸 뒤 오케스트레이터 `run()`을 호출합니다. 외부 프로세스(Electron 등)는 이 스트림으로 실시간 상태를 확인합니다.
2. `automation-engine/src/core/orchestrator.js`는 작업 수명주기를 관리합니다.
   - `web/playwright.js`가 자동화 전용 Edge 프로필을 띄워 사용자의 기존 브라우저와 충돌하지 않게 하고, 이후 사이트별 로그인 훅(`loginKepco`, `loginMnd`)을 호출합니다.
   - 로그인 후 NX 웹 인증서 핸들러(`handleKepcoCertificate`/`handleMndCertificate`)를 먼저 시도하고, 실패 시 PowerShell UIAutomation(`native/uia.js`)으로 인증서 선택·PIN 입력을 진행합니다.
   - 한전의 경우 `goToBidApplyAndSearch`, `applyAfterSearch`를 호출해 메뉴 이동과 신청 버튼까지 이어집니다. 최종 `submit` 단계는 아직 자리표시자이며, 성공 시 `PREPARED-<site>-<timestamp>` 형태의 결과만 반환합니다.
3. Electron 셸(`electron-app`)은 최소 UI로 CLI를 실행하고 설정(`settings.json`)을 관리하며, JSON 이벤트를 렌더러에 전달해 진행률/로그를 표시합니다.

## 한전(KEPCO) 흐름 관찰 사항
- `sites/kepco.js`에 두 가지 메뉴 이동 함수가 공존합니다.
  - `goToBidApplyAndSearch(page, emit, bidId)`: 기존 로직으로 상단 메뉴 → 좌측 트리 → 검색 폼 → 체크박스/신청 버튼을 시도합니다. 이 구간에 등장하는 한글 문자열이 모두 깨져 있어(예: `'û'`, `'ȣ'`) 지금은 어떤 요소도 찾을 수 없습니다.
  - `navigateToApplication(page, emit)`: ExtJS 트리 쿼리와 `text=입찰/계약` 같은 정리된 셀렉터를 사용한 신버전이지만, 어느 곳에서도 호출되지 않아 사실상 사장되었습니다.
- 문자열이 깨져 있기 때문에 “입찰/계약”·“입찰참가신청” 메뉴를 열지 못하고, “입찰공고번호” 입력창이나 “입찰참가신청” 버튼도 탐지하지 못합니다. 참가신청 단계가 멈춰 있는 핵심 원인입니다.

## 인증서 처리 메모
- 오케스트레이터는 `job.cert` 값을 복사하면서 `path`를 강제로 비우고(`core/orchestrator.js:101`), 경로 기반 보강 로직은 `if (false && certOpts.path)`로 막혀 있습니다. 결국 사용자가 지정한 인증서 폴더는 전혀 쓰이지 않고 Subject/Issuer/Serial 매칭만 사용됩니다.
- 렌더러(`electron-app/renderer/renderer.js`) 역시 job 구성 시 `cert.path`를 빈 문자열로 덮어써 저장된 경로가 엔진까지 전달되지 않습니다.
- `docs/handoff.md`에 언급된 것처럼 국방부 플로우는 `serialMatch`가 비어 있으면 인증서 선택에 실패합니다. UI에서 일련번호를 비워 둔 채 저장해도 경고가 없으니 동일 문제가 반복됩니다.

## UI/설정 메모
- 회사/계정/인증서 정보(비밀번호·PIN 포함)가 `%APPDATA%/automation-shell/settings.json`에 평문으로 저장됩니다. 현재는 암호화나 자격 증명 관리자 연동이 없습니다.
- “실행” 버튼을 누르자마자 `{ type:'info', msg:'Stopped by user request.' }` 로그가 찍혀 실제 중지 이벤트와 구분이 되지 않습니다.

## 즉시 개선 아이디어
1. `sites/kepco.js`에서 깨진 한글 문자열을 모두 복구하고, 오케스트레이터가 `navigateToApplication()`을 사용하도록 바꿔야 트리/메뉴 이동이 정상 동작합니다.
2. 렌더러와 오케스트레이터 모두에서 `job.cert.path`를 그대로 전달·사용할 수 있도록 경로 사용을 다시 활성화하고, 필요하면 옵션으로 제어할 수 있게 합니다.
3. UI에서 인증서 저장 시 `serialMatch`(필요 시 issuer도)가 비어 있으면 저장을 막거나 `inspectCert` 실행을 유도해 필수 값이 채워지도록 합니다.
4. 렌더러의 잘못된 초기 로그를 정리하고, 설정 파일에 민감 정보가 저장될 때 최소한 암호화/보안 저장 옵션을 검토합니다.

이 메모는 이번 세션에서 파악한 동작 방식과 문제점을 정리한 것으로, 다음 개발 단계에서 참고할 수 있습니다.
