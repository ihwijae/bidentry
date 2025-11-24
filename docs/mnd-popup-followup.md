# 국방부 입찰서 작성안내 팝업 대응 메모

## 현재 상태 요약
- 로그인/공인인증서 자동화는 완료되어 `goToMndAgreementAndSearch`까지 진입하지만, "입찰서 작성안내" 팝업이 떠 있으면 공고번호 입력창에 접근하지 못해 실패합니다.
- DOM 기반으로 닫기 위해 `closeMndBidGuideModal`에 ExtJS window close, DOM 제거, 텍스트 버튼 클릭, watcher 등 다양한 시도를 추가했으나 팝업이 별도 창/전체 마스크로 열리는 케이스에서는 작동하지 않습니다.
- 실패 시 덤프/스크린샷을 자동으로 저장하도록 `dumpMndState`를 보강했지만, 현재까지 저장된 HTML은 `<body></body>`만 있고 스크린샷도 비어 있어 팝업 구조를 파악할 수 없습니다. (예: `engine_runs/2025-11-21T08-43-54-019Z_*`).

## 확인된 사실
- 국방부 로그인 직후 팝업이 떠 있으면 메인 페이지 전체가 검은색 오버레이로 덮이고, 팝업은 가운데 모달 형태(국방부로그인화면.png 참조).
- 팝업 DOM이 나타나는 창이 Playwright의 `page`/`frame`이 아닌 별도 팝업 탭일 가능성이 높습니다. 덤프 시 `context.pages()`를 순회하지만 여전히 빈 DOM만 저장되는 것으로 보아 로드시점/접근 권한 문제가 존재합니다.

## 다음 세션 TODO 제안
1. **정확한 팝업 구조 확보**
   - 실패 시 `browserContext.pages()`별로 URL/타이틀을 로그에 찍고, 각 페이지에서 `page.evaluate(() => document.body.innerText)`를 로그로 남겨 실제 내용 여부를 확인.
   - 가능하다면 사용자 측에서 팝업이 뜬 상태의 스크린샷/개발자도구 DOM을 직접 캡처해 공유.
2. **네이티브 UI Automation 검토**
   - DOM 접근이 계속 어려우면 pywinauto/PowerShell UIA로 Edge 창의 "확인"/"닫기" 버튼을 직접 클릭하도록 별도 모듈 작성.
3. **팝업 스크립트 무력화 가능성 조사**
   - `alertLayerOpen`, `confirmLayerClose` 등 관련 전역 함수 탐색 후, `page.addInitScript`로 override하여 팝업이 뜨지 않게 하거나 즉시 닫히도록 처리.

## 참고 로그/파일
- `engine_runs/2025-11-21T08-43-54-019Z_bid_input_missing_*` (HTML/PNG 덤프 – 현재는 빈 내용이지만, 파일 위치 참고)
- 스크린샷: `국방부로그인화면.png` (사용자 제공)

다음 작업자는 위 자료와 TODO를 참고해 팝업 구조 파악 → DOM override 또는 UI Automation 중 한 방향을 선택해 구현해 주세요.
