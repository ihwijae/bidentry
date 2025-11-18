Automation Engine

간단한 JSON Lines 이벤트 프로토콜을 사용하는 입찰 참가신청 자동화용 CLI 스켈레톤입니다.

- 입력: `--job <json 파일 경로>` (선택)
- 출력: 라인당 하나의 JSON 이벤트

빠른 시작
- 데모 실행: `npm run dev` 또는 `node src/cli.js --demo`
- 도움말: `npm start`

이벤트 예시
{"type":"started","pid":1234,"ts":"2025-01-01T00:00:00.000Z"}
{"type":"progress","step":"open_site","pct":10}
{"type":"progress","step":"fill_form","pct":50}
{"type":"done","ok":true,"result":{"receiptId":"DEMO-12345"}}

구조
automation-engine/
  package.json
  src/
    cli.js
    core/orchestrator.js
    web/playwright.js
    native/uia.js
    util/logger.js
    jobs/schema.sample.json

