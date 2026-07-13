# HANDOFF — mock_kabu 작업 인수인계 (2026-07-13)

다른 AI 모델/세션이 이 프로젝트 작업을 이어받기 위한 문서. 프로젝트 개요·실행법은 [README.md](README.md), 원 기획은 `docs/superpowers/specs/2026-07-11-virtual-exchange-design.md` 참고.

## 프로젝트 한 줄 요약

로컬 모의 거래소 모노레포(pnpm + turbo): `apps/web`(Next.js 15 :3000) ↔ `apps/api`(NestJS :4000, REST + socket.io) ↔ `apps/matching-engine`(Redis Streams 매칭) + `apps/bots`(기존 흐름 봇과 전용 유동성 봇). 인프라는 docker-compose(PostgreSQL 16 + Redis 7).

## 현재 상태 (작업 로그)

- `9659626` — M1~M4 전체 구현 (main)
- `be579e5` — 웹 실시간 채널 필터링 버그 수정 + 호가창 높이 고정 (아래 "실시간 버그 수정" 참고)
- `a3a63e4` — README 실행 가이드 재구성 + HANDOFF/AGENTS 문서
- `d911a6a` — **보유종목 평단가·수익률 + 봇 역할 다양화** (아래 참고). 브라우저·DB·정합성 검사로 검증 완료.
- `4ea014d` — **차트 지표: 50/200 SMA·100 VWMA·거래량 + 토글** (아래 참고)
- (최신) — **거래 페이지 내 포지션 바 + 청산 UI** (아래 참고)
- `error.md` — 사용자가 브라우저 에러를 붙여넣는 스크래치 파일 (gitignore됨)

### 2026-07-12 후속 작업 — 시세 연속성·정산 복구·로컬 데이터 재시드

- **재기동 시세 연속성**: 체결 생성과 `market.symbols.last_price` 갱신을 같은 DB 트랜잭션으로 묶었다. 매칭 엔진 부팅은 `matching.trades`의 최신 체결가를 우선해 호가창/캐시를 복원하고, 봇 기준가는 `최신 체결 → last_price → 시초가` 순으로 이어받는다. 따라서 종료 전 1,300원이던 종목이 재시작 직후 시초가 1,000원으로 돌아가지 않는다.
- **정산 재시작 방어**: settlement consumer가 stale pending 메시지를 `XAUTOCLAIM`으로 회수하고, 실패한 금융 이벤트를 ACK로 버리지 않고 재시도한다. 캔들은 원장 체결로 다시 계산해 중복 소비에도 거래량이 누적되지 않는다.
- **복구 도구**: `pnpm recover:settlement`은 기본 dry-run이며, 안전할 때만 `pnpm run recover:settlement -- --apply --confirm=RECOVER_UNSETTLED_TRADES`로 적용한다. 전체 주문·체결 이력에서 예약금/예약수량을 재계산하고, 모순이 있으면 쓰기 없이 중단한다. `pnpm check:consistency`은 미정산 체결·예약 불일치·last_price 불일치까지 검사한다.
- **현재 로컬 DB**: 기존 DB는 주문 수량 초과 체결/terminal `filledQty` 불일치가 있어 비파괴 복구가 안전하게 차단됐다. 사용자 승인에 따라 PostgreSQL·Redis 볼륨을 초기화하고 마이그레이션·봇 시드를 다시 적용했다. 이후 봇 체결이 발생한 상태에서 `check:consistency`와 복구 dry-run 모두 통과했다.
- 검증: Vitest 30개, 봇 가격 복원 node:test 2개, 복구 플래너 node:test 6개, 전 패키지 TypeScript 검사 통과. API와 매칭 엔진의 기동/REST 접속도 확인했다.

### 2026-07-13 후속 작업 — 차트 OHLC hover·호가 유동성 강화

- **캔들 hover 정보**: `apps/web/src/components/CandleChart.tsx`가 lightweight-charts crosshair의 `seriesData`에서 실제 렌더된 봉을 읽는다. 마우스를 봉 위에 두면 차트 좌상단에 시·고·저·종 가격과 각각의 시가 대비 변동률(상승=빨강, 하락=파랑)을 표시한다. 진행 중인 마지막 봉도 실시간 체결에 맞춰 readout이 갱신되고, 차트를 벗어나면 숨긴다.
- **마켓메이커 유동성**: 새 `apps/bots/src/market-maker.ts`/`liquidity.ts`가 기존 3레벨·5~25주·전량취소 방식 대신 편당 12레벨, 최우선 160주, 총 935주의 촘촘한 호가 래더를 유지한다. REST 호가창의 상위 10단 바깥에 4단의 완충을 두고 250ms 전체 래더 재조정으로 체결 직후에도 가시 호가가 8단 아래로 내려가지 않게 한다. 새 호가를 먼저 넣되 active/retiring 주문 전체와의 반대편 교차를 엄격히 막고, 취소 요청 후에도 terminal 상태가 확인될 때까지 방어한다. 중심가는 한 번에 1틱만 이동한다.
- **봇 충격 완화**: 고래 봇은 40~120주로 제한하고 시장가 비중을 25%로 낮췄다. 따라서 작은 시장가 주문과 고래 주문이 한 번에 호가창을 소진할 가능성이 크게 줄었다.
- **호가 재조정 조회**: 봇은 이제 `/orders?symbol={SYMBOL}&status=live`로 자기 계정의 해당 종목 OPEN/PARTIAL만 읽는다. 전체 주문 이력의 200건 한도 때문에 오래된 활성 호가를 영구히 살아 있다고 판단하던 문제를 막는다. 기존 `/orders` 응답은 호환된다.
- **매칭 재기동 멱등성**: migration `20260713090000_add_matching_processed_order_events`가 `matching.processed_order_events(event_id PK)`를 추가했다. `order.placed`는 이 event id claim·체결 원장·last_price를 한 트랜잭션으로 확정해 outbox 재발행이나 Streams PEL 회수 뒤에도 두 번 매칭되지 않는다. pending은 `XAUTOCLAIM`으로 회수하며, 취소 이벤트는 close 발행 실패 시 안전하게 재시도한다. `pnpm db:migrate`는 현재 로컬 DB에 적용됨.
- **정산 순서 방어**: `order.closed`가 선행 trade 정산보다 앞서면 hold를 풀지 않고 pending으로 남긴다. `XAUTOCLAIM` 재시도 시 앞선 체결 정산이 끝난 뒤에만 종료 처리를 한다.
- **전용 유동성 계정 + 재기동 복구**: `bot16`~`bot20`만 종목별 전용 reserve 계정(MOCK/KABU/TANU/SAKU/NEKO)으로 사용한다. 과거 시험 세대인 `bot11`~`bot15`와 기존 `bot1`~`bot10`의 주문·체결 이력은 동결하며 자동 보정·재사용하지 않는다. API의 내부 reserve bootstrap은 계정·현금·재고를 멱등적으로 보충하고, matching bootstrap은 `isBot` + 정확한 reserve 이메일 + 계정 ID + 배정 종목까지 확인한 16~20 주문을 먼저 메모리 호가창에 복원한다. 그 뒤 레거시/사용자 주문은 이 기준 호가를 교차하지 않을 때만 복원한다. 이 우선순위/격리는 **DB 주문·체결·잔고를 전혀 수정하지 않는** 부팅 시 메모리 안전 경계다. 전용 reserve에 예전의 PARTIAL 또는 중복 잔존 주문이 있으면 봇은 정상 24개 래더를 먼저 채택하고, 비교차 잔존 행은 ID 기반 self-trade guard로만 보존한다. 따라서 불일치 주문을 자동 보정·강제취소하지 않고도 새 12단 호가를 유지한다. snapshot에는 없지만 DB가 `OPEN/PARTIAL`인 과거 주문도 취소 시 `matching.trades` 합계와 DB `filledQty`가 정확히 일치할 때만 정상 `order.closed`로 종결하며, 불일치는 경고만 내고 자동 보정하지 않는다.
- **체결 목록 정렬**: `TradesFeed`는 `가격 / 수량 / 일시` 헤더와 고정 CSS grid 열(`7rem / 3.5rem / minmax(0,1fr)`)을 사용한다. 수량을 가격 바로 옆에 두고 시간만 우측에 붙이며, 시간은 항상 `HH:mm:ss`로 0-padding한다.
- **실전 리플레이**: 새 메뉴 `/replay`는 기존 거래소와 완전히 분리된 가상 USD 계좌로 과거 일봉을 한 봉씩 공개한다. `GET /replay/datasets`와 `GET /replay/datasets/:id/candles`는 AAPL·MSFT·NVDA를 제공하며 기본 상태에서는 외부 시세를 요청하지 않는다. 명시적 `REPLAY_HISTORICAL_CSV_DIR`의 사용자 권한 CSV가 우선이고, 없을 때만 `ALPHA_VANTAGE_API_KEY`를 사용한다. 두 소스가 없거나 AAPL의 승인된 외부 요청이 실패하면 MIT Plotly fixture를 쓴다. `5y`·`10y`·`max`는 CSV 또는 Alpha Vantage full 일봉 권한이 필요하다. 자세한 사용·권리·검증 규칙은 `docs/replay-data-guide.md`를 참고한다.
- **혼합 리플레이**: `packages/shared/src/replay.ts`의 `HistoricalReplayEngine`/`HybridReplayEngine`이 x0.25/x0.5/x1/x2와 미래 OHLC 미노출을 담당한다. 혼합 모드는 seed 기반 가상 MM/모멘텀 압력을 실제 기준 경로의 ±1/±2.5/±5% 안으로 엄격히 제한하며, 기존 `apps/bots`, 매칭, 주문, 계좌·정산은 전혀 건드리지 않는다.
- **로컬 DB 재시드 완료**: 위의 과거 불일치 DB는 `tmp/mock-kabu-pre-reseed-20260713-2004.dump`로 PostgreSQL custom-format 백업을 보존한 뒤, 사용자 승인으로 PostgreSQL·Redis 볼륨을 초기화하고 전체 migration/seed를 다시 적용했다. 현재 새 로컬 DB에서는 `pnpm check:consistency`와 `pnpm recover:settlement` dry-run이 모두 통과한다. 과거 덤프를 자동 복구·수정하지 말고, 필요하면 별도 포렌식 DB에 복원해 검토할 것.
- **반영/검증**: 현재 웹/API는 :3000/:4000에서 기동 중이며 matching-engine과 bots도 최신 코드로 재시작했다. reserve 우선 bootstrap 회귀 테스트(오래된 TANU 8,580 매도가 완전한 `bot18` 사다리를 밀어내지 못함)를 포함한 matching recovery 9개 및 matching-engine 전체 24개 테스트와 matching TypeScript 검사를 통과했다. bots TypeScript 및 9개 테스트(12단 래더, PARTIAL guard, 정상 24단+잔존행 채택)를 통과했다. 재기동 뒤 2026-07-13에 5초 간격 5회로 MOCK/KABU/TANU/SAKU/NEKO를 확인해, 모든 샘플에서 양방향 각각 10단, 편당 최소 766주, `bestBid < bestAsk`를 유지했다. 루트 `pnpm test`는 실행 중인 서버가 Windows Prisma query-engine DLL을 잠가 `prisma generate` 단계에서만 EPERM으로 중단될 수 있으므로, 서버를 내린 뒤 재실행한다.

### 2026-07-13 후속 작업 — 전 호가 단계 변화·durable outbox·깨끗한 로컬 검증

- **모든 호가 단계의 변화**: `apps/bots/src/main.ts`의 depth-shaper가 자신의 지정가를 현재 보이는 양쪽 10단 중 임의 위치에 추가하고, 이미 낸 주문도 임의 순서로 취소한다. `chooseBookLevelIndex()`는 최우선 호가도 16% 확률로 포함하되 나머지 84%는 2~10단에서 고르므로, 수량 증감이 최고 매수가/최저 매도가에만 고정되지 않는다. 봇 단위 테스트가 이 분포를 고정 검증한다.
- **체결·호가 수량의 현실성**: 시장가 물량은 가격에 반비례해 주식 수를 조정하고, 대다수는 최우선 벽보다 작게 체결되며 일부만 가까운 최대 3단을 관통한다. 유동성 래더도 가격 정규화한 거래대금 목표를 사용하므로 저가 종목은 더 많은 주식 수로, 고가 종목은 적은 주식 수로 비슷한 호가대 거래대금을 유지한다. `VolumeActivity`의 무작위 quiet/busy pulse가 수량과 빈도를 바꾸되 매수·매도 방향 자체를 강제하지 않는다.
- **매칭-정산 전달 보장**: migration `20260713100000_add_matching_settlement_outbox`의 `matching.outbox_events`에 `trade.executed`/`order.closed` 이벤트를 체결 원장·last_price·event claim과 같은 DB 트랜잭션으로 저장한다. relay는 Redis `XADD` 성공 뒤에만 `published_at`을 표시하므로, Redis 실패 또는 재시작 사이에도 같은 event ID로 재발행되어 정산 멱등성이 유지된다. 취소 이벤트 ID도 재시도마다 고정했다.
- **자기 체결 방지**: 매칭 엔진은 동일 accountId의 교차 주문을 발견하면 들어온 주문의 잔여분만 취소하고 기존 maker 호가는 유지한다. 새 DB 런타임 관찰에서 자기 체결은 0건이었다.
- **최종 런타임 검증 (2026-07-13)**: 5개 종목 모두 양방향 10단·`bestBid < bestAsk`를 확인했다. 42초 전후 비교에서 각 종목의 양쪽 비최우선 호가가 8~18개 가격 단위로 변했다. Redis Streams의 matching/settlement 그룹은 재관찰 시 `pending=0`, `lag=0`; outbox 대기는 0; `pnpm check:consistency` 전체 통과; `pnpm recover:settlement` dry-run은 미정산 0건 SAFE였다. matching-engine 26개, bots 22개, API 26개 테스트와 shared·matching·bots·API build, 웹 TypeScript 검사를 통과했다.

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
