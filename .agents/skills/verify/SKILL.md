---
name: verify
description: mock_kabu2 변경 검증 — 독립 포트 기동/접속/실시간 흐름 관찰 레시피
---

# mock_kabu2 검증 레시피

## 기동 확인 (이미 떠 있으면 그대로 사용)

```bash
curl -s -o /dev/null -w "web:%{http_code}\n" http://localhost:3100 --max-time 3
curl -s -o /dev/null -w "api:%{http_code}\n" http://localhost:4100/market/symbols --max-time 3
```

안 떠 있으면: `pnpm infra:up` → `pnpm dev` (백그라운드). 웹 :3100, api :4100.

## 접속·인증

- 브라우저(Codex in Chrome)로 http://localhost:3100 접속. localStorage 토큰이 남아 있으면 이미 로그인 상태.
- 로그인 필요 시 봇 계정 사용: `bot1@bots.local` / `botpassword` (회원가입 불필요).
- 종목: KABU, MOCK, NEKO, SAKU, TANU, BYE, MIRAE → 거래 페이지는 `/symbol/{심볼}`.

## 실시간 흐름 관찰 포인트

- 봇 10개가 상시 거래하므로 별도 주문 없이 관찰 가능. **주문 제출은 하지 말 것** (검증에 불필요).
- 거래 페이지에서 8~20초 간격으로 스크린샷 2장 → 현재가 라인/마지막 캔들/호가/체결 목록이 달라지는지 비교.
- 콘솔은 페이지 로드 전에 read_console_messages를 한 번 호출해 추적을 시작한 뒤 새로고침해야 로드 시점 에러가 잡힘.
- 호가 행 클릭 → 주문폼 가격 자동 입력(기존 기능 회귀 체크로 안전함).

## 주의

- 웹은 Next.js dev(HMR)라 파일 수정이 즉시 반영되지만, api/matching-engine 수정은 `pnpm dev` 재시작 필요.
- WebSocket은 단일 소켓에 `message` 이벤트 하나로 모든 채널이 들어옴 — 구독 관련 변경 시 다른 채널 페이로드 오염 여부를 콘솔 NaN/key 경고로 확인.
