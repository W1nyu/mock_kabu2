# HANDOFF — mock_kabu 작업 인수인계 (2026-07-12)

다른 AI 모델/세션이 이 프로젝트 작업을 이어받기 위한 문서. 프로젝트 개요·실행법은 [README.md](README.md), 원 기획은 `docs/superpowers/specs/2026-07-11-virtual-exchange-design.md` 참고.

## 프로젝트 한 줄 요약

로컬 모의 거래소 모노레포(pnpm + turbo): `apps/web`(Next.js 15 :3000) ↔ `apps/api`(NestJS :4000, REST + socket.io) ↔ `apps/matching-engine`(Redis Streams 매칭) + `apps/bots`(봇 10개 상시 거래). 인프라는 docker-compose(PostgreSQL 16 + Redis 7).

## 현재 상태

- 베이스 커밋: `9659626` (M1~M4 전체 구현 완료, main 브랜치)
- **미커밋 변경 5개 파일 존재** (아래 "이번 세션에서 한 일"). 검증 완료 상태이며 커밋만 안 됨. 사용자가 커밋을 요청하지 않아 보류 중.
- `error.md` — 사용자가 브라우저 에러를 붙여넣는 스크래치 파일 (커밋 대상 아님). 기록된 2개 이슈는 해결 완료.
- `apps/web/tsconfig.tsbuildinfo` — `tsc --noEmit` 부산물 (커밋 대상 아님).

## 이번 세션에서 한 일 (미커밋 diff의 의도)

### 1. WebSocket 채널 필터링 버그 수정 — 근본 원인

증상: 캔들차트에 NaN assertion(lightweight-charts) 발생 + 차트 실시간 갱신 정지, TradesFeed에 React key 경고와 NaN 행.

원인: 게이트웨이(`apps/api/src/gateway/realtime.gateway.ts:38`)는 모든 채널을 단일 `"message"` 이벤트 `{channel, data}`로 emit하는데, `apps/web/src/lib/socket.ts`의 `subscribe()`가 채널 필터 없이 모든 메시지를 핸들러에 넘겼음. 같은 페이지의 호가창이 `orderbook:{symbol}`을 join하므로 호가 스냅샷(`price` 필드 없음, `lastPrice`만 있음)이 차트/체결피드 핸들러에 흘러들어 `undefined → NaN`.

수정 (`apps/web/src/lib/socket.ts` 전면 재작성):
- 핸들러 래핑으로 자기 채널 메시지만 전달
- 채널별 refcount — 같은 채널을 쓰는 컴포넌트(CandleChart와 TradesFeed 모두 `trades:{symbol}`) 중 하나만 해제돼도 룸에서 leave되던 결함 수정. 마지막 구독자 해제 시에만 leave
- 재연결 시 전체 채널 재-join을 `getSocket()`에서 중앙 처리

### 2. 방어 코드

- `apps/web/src/components/CandleChart.tsx`: trade 핸들러에 `Number.isFinite(price/ts)` 가드 (오염 페이로드가 차트를 죽이지 않게)
- `apps/web/src/components/TradesFeed.tsx`: 목록 맨 앞과 같은 `tradeId` 중복 수신 무시

### 3. 호가창 높이 고정 (UX)

`apps/web/src/components/Orderbook.tsx`: asks/bids를 항상 8행씩 렌더(부족분은 `EmptyRow` 패딩) — 호가 수 변동으로 아래 매수/매도 주문폼이 위아래로 움직이던 문제 해결.

### 4. README 실행 방법 재구성

최초 1회 설정(`cp .env.example .env` 추가) / 2번째 실행부터(`docker compose up -d` + `pnpm dev`) / 종료 방법(`Ctrl+C` + `docker compose stop`, 완전 초기화는 `down -v`) 3단계로 분리.

## 검증 방법 (완료된 검증의 재현법)

`.claude/skills/verify/SKILL.md`에 상세 레시피 있음. 요약:

1. `docker compose up -d` + `pnpm dev` (이미 떠 있는지 `curl localhost:3000`, `localhost:4000/market/symbols`로 확인)
2. 봇이 상시 거래하므로 주문 없이 관찰 가능. 로그인 필요 시 `bot1@bots.local` / `botpassword`
3. `/symbol/KABU` (종목: KABU·MOCK·NEKO·SAKU·TANU)에서 확인:
   - 마지막 캔들·현재가 라인이 체결마다 실시간으로 움직임
   - 브라우저 콘솔에 NaN assertion / key 경고 없음
   - 실시간 체결 목록에 NaN 행 없음
   - 호가 행 수가 변해도 주문폼 위치 고정
4. `pnpm test` (21개) + `apps/web`에서 `npx tsc --noEmit` — 이번 세션에서 전부 통과 확인함

## 다음 후보 작업 (사용자 미승인 — 착수 전 확인 필요)

이번 세션에서 제안했으나 사용자가 선택하지 않은 편의성 개선:
- 거래 페이지 상단 실시간 현재가·등락률 헤더
- 주문폼: 잔액/보유량 4초 폴링 → `account:{accountId}` 채널 push 기반 즉시 갱신 (`notifyAccount`가 주문/정산/이체 시 이미 발행 중), 수량 10/25/50/최대 % 버튼
- 대시보드 종목 시세 5초 폴링 → WebSocket 실시간화

스펙상 후속 마일스톤(README 하단): k3d/Helm(M5), k6+Grafana(M6), isolation-lab, AWS(M7+).

## 주의사항 (이 코드베이스 특유)

- **socket.io는 단일 소켓·단일 `"message"` 이벤트**로 모든 채널이 들어온다. 새 실시간 컴포넌트는 반드시 `subscribe()`(필터 내장)를 쓰고, 직접 `socket.on("message")`을 달지 말 것.
- 웹은 HMR로 즉시 반영되지만 api/matching-engine/bots 수정은 `pnpm dev` 재시작 필요.
- Windows 환경 (PowerShell/Git Bash). git이 LF→CRLF 경고를 내지만 무해.
- UI 색 관례: 상승/매수=빨강, 하락/매도=파랑 (한국식).
- 커밋 메시지 컨벤션: 한국어, `feat:`/`docs:` prefix (git log 참조).
