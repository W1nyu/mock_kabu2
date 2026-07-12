# HANDOFF — mock_kabu 작업 인수인계 (2026-07-12)

다른 AI 모델/세션이 이 프로젝트 작업을 이어받기 위한 문서. 프로젝트 개요·실행법은 [README.md](README.md), 원 기획은 `docs/superpowers/specs/2026-07-11-virtual-exchange-design.md` 참고.

## 프로젝트 한 줄 요약

로컬 모의 거래소 모노레포(pnpm + turbo): `apps/web`(Next.js 15 :3000) ↔ `apps/api`(NestJS :4000, REST + socket.io) ↔ `apps/matching-engine`(Redis Streams 매칭) + `apps/bots`(봇 10개 상시 거래). 인프라는 docker-compose(PostgreSQL 16 + Redis 7).

## 현재 상태 (작업 로그)

- `9659626` — M1~M4 전체 구현 (main)
- `be579e5` — 웹 실시간 채널 필터링 버그 수정 + 호가창 높이 고정 (아래 "실시간 버그 수정" 참고)
- `a3a63e4` — README 실행 가이드 재구성 + HANDOFF/AGENTS 문서
- `d911a6a` — **보유종목 평단가·수익률 + 봇 역할 다양화** (아래 참고). 브라우저·DB·정합성 검사로 검증 완료.
- `4ea014d` — **차트 지표: 50/200 SMA·100 VWMA·거래량 + 토글** (아래 참고)
- (최신) — **거래 페이지 내 포지션 바 + 청산 UI** (아래 참고)
- `error.md` — 사용자가 브라우저 에러를 붙여넣는 스크래치 파일 (gitignore됨)

## 거래 페이지 포지션 바 + 청산 (최신 작업)

`apps/web/src/components/MyPosition.tsx` (신규) — 거래 페이지(`/symbol/{symbol}`)의 차트와 주문폼 사이에 배치. **해당 종목 보유가 있을 때만 렌더** (없으면 null).

- 표시: 보유 수량(매도 대기 별도 표기)·평단가·현재가·평가손익(수익률, 이익=빨강/손실=파랑)
- **실시간 수익률**: `/account/holdings`의 costBasis 기반 + `trades:{symbol}` tick의 가격으로 클라이언트에서 재계산. 잔액·보유 변화는 `account:{id}` push + 5초 폴링으로 갱신
- **청산**: `availableQty`(매도 대기 제외) 전량 시장가 매도. 오클릭 방지 2단계 확인 — 첫 클릭에 "N주 전량 매도 확인"으로 바뀌고 4초 내 재클릭 시 실행. 매도 대기 수량만 남으면 버튼 비활성
- 주의: browser `confirm()`은 쓰지 않았음(브라우저 자동화·UX 모두에 나쁨) — 같은 패턴 유지할 것

## 차트 지표

`apps/web/src/components/CandleChart.tsx` — 캔들차트에 지표 4종 추가, 차트 위 버튼으로 개별 on/off:

- **50 SMA**(초록 #22c55e)·**200 SMA**(빨강 #ef4444): 종가 단순이동평균. **100 VWMA**(하양 #f5f5f5): 거래량가중이동평균 Σ(종가×거래량)/Σ거래량. **거래량**: 차트 하단 18% 별도 스케일의 히스토그램(캔들 방향색, 알파 0.45).
- 전부 **클라이언트 계산** — 서버 수정 없음. 과거 데이터는 `/market/candles`(volume 포함, limit 500), 실시간은 `trades:{symbol}` tick의 price·qty로 마지막 캔들·지표 포인트만 갱신.
- 토글 상태는 `localStorage("chart:indicators")`에 저장. **주의: localStorage는 반드시 마운트 후 useEffect에서 읽어 setState할 것** — useState 초기값에서 읽으면 SSR(기본값)과 클라이언트 첫 렌더가 어긋나 hydration mismatch 발생 (이번에 실제로 밟고 수정한 함정).
- 윈도우 미달 구간은 선을 그리지 않음 — 1분봉이므로 200 SMA는 거래 이력 200분, 100 VWMA는 100분 누적 후에야 나타남. 갓 시드한 DB에서 안 보이는 건 정상.

## 평단가·수익률 기능

**목표**: 대시보드에서 종목별 평단가·평가손익·수익률과 전체 수익률을 보여준다.

- **DB**: `Holding.costBasis BigInt` (총 매입원가, 원) 추가 — 평단가 = costBasis/qty. 마이그레이션 `20260712100000_add_holding_cost_basis`는 기존 보유분을 종목 `initial_price`로 근사 백필. 시드도 costBasis 포함(`packages/db/prisma/seed.ts`).
- **정산**(`apps/api/src/account/settlement.consumer.ts`): 매수 시 costBasis += 체결금액, 매도 시 비례 차감 `costBasis × 매도수량 / 보유수량` (BigInt 내림 — qty가 0이 되면 costBasis도 정확히 0). 정산 컨슈머는 단일 프로세스 순차 처리라 이 read-then-update가 안전함.
- **API**(`account.service.ts` getHoldings): `costBasis, avgCost, pnl, pnlRate` 필드 추가. BigInt는 api main.ts의 전역 toJSON으로 number 직렬화.
- **웹**(`apps/web/src/app/page.tsx`): 보유 자산 테이블에 평단가·평가손익(수익률) 컬럼, 상단 Stat에 "평가손익 (전체 수익률)" 타일. 이익=빨강, 손실=파랑.

## 봇 역할 다양화

`apps/bots/src/main.ts` — 10계정 역할 재배치: **마켓메이커 x3**(5종목 분담, 3레벨 양측 호가), **소액개미 x3**(1~5주, 최근 체결 추세를 65% 확률로 추종), **고래 x1**(15~45초 간격 100~400주, 시장가 또는 호가 관통 지정가 — 가격 충격 생성), **노이즈 x2**(순수 랜덤), **모멘텀 x1**. 고래의 대량 시장가는 호가 잔량을 소진하면 잔여분 CANCELED — 의도된 동작(IOC성 잔여 취소).

## 이전 세션에서 한 일

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

## Prisma 마이그레이션 주의 (중요)

- **`prisma migrate dev`는 쓰지 말 것** — init 마이그레이션(`20260712000000_init`)이 적용 후 UTF-16→UTF-8로 재인코딩되어 체크섬이 불일치, migrate dev가 DB 리셋을 요구함. 대신 **마이그레이션 SQL을 수동 작성**(`prisma/migrations/<timestamp>_<name>/migration.sql`)하고 `pnpm db:migrate`(migrate deploy)로 적용할 것. deploy는 체크섬을 재검증하지 않음.
- **`prisma generate`는 `pnpm dev` 실행 중이면 EPERM으로 실패** — 실행 중인 api/matching-engine이 query engine DLL을 잠그기 때문. 엔진 버전이 같으면 생성된 client JS/타입은 이미 갱신된 상태라 무해하지만, `pnpm build`/`pnpm test`(turbo가 db build를 선행)는 dev를 끄고 돌려야 통과함. 테스트만 빨리 돌리려면 각 패키지 디렉토리에서 `npx vitest run`.

## 주의사항 (이 코드베이스 특유)

- **socket.io는 단일 소켓·단일 `"message"` 이벤트**로 모든 채널이 들어온다. 새 실시간 컴포넌트는 반드시 `subscribe()`(필터 내장)를 쓰고, 직접 `socket.on("message")`을 달지 말 것.
- 웹은 HMR로 즉시 반영되지만 api/matching-engine/bots 수정은 `pnpm dev` 재시작 필요.
- Windows 환경 (PowerShell/Git Bash). git이 LF→CRLF 경고를 내지만 무해.
- UI 색 관례: 상승/매수=빨강, 하락/매도=파랑 (한국식).
- 커밋 메시지 컨벤션: 한국어, `feat:`/`docs:` prefix (git log 참조).
