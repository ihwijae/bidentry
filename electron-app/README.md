Electron Shell for Automation Engine

목적: 별도 UI 없이 Electron 메인 프로세스에서 자동화 엔진을 실행하고, JSON Lines 이벤트를 콘솔로 출력합니다.

명령
- 개발(데모): `npm run dev`
- 샘플 잡으로 실행: `npm run job`
- 일반 실행: `npm start` (인자 전달 가능, 예: `npm start -- --job ../automation-engine/src/jobs/schema.sample.json`)

동작
- `automation-engine/src/cli.js`를 Node로 스폰하여 표준출력(JSONL)을 수집합니다.
- 현재는 콘솔에만 로그합니다. 추후 렌더러/파일로 중계 가능.

