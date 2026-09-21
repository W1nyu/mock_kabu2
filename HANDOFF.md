# HANDOFF — mock_kabu 작업 인수인계 (2026-09-22)

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

## 2026-09-22 — 계정 설정 (최신 작업)

- `PATCH /auth/me {nickname}`(1~20자, 새 token/user 발급 — 닉네임이 JWT에 들어 있어서)와 `POST /auth/password {currentPassword, newPassword}`(현재 비밀번호 검증, 4자 이상).
- 웹 `/settings` 페이지: 닉네임 저장은 `saveSession()`으로 세션을 갈아 끼우고, `lib/api.ts`의 새 `onSessionChange()`를 Nav가 구독해 경로 이동 없이 우상단 칩이 바뀐다. 진입은 **Nav 우상단 사용자 칩 클릭**뿐 — 기본 메뉴 목록(LEGACY MENU LOCK)은 그대로.

## 2026-09-22 — 주문 정정

- `PATCH /orders/:id {price?, qty?}` (`OrderService.amend`): 지정가 미체결만. 취소 요청 → 최대 4초 동안 100ms 간격으로 DB에서 종결을 확인 → 종결 확인 시 남은 수량(요청 qty와 실제 미체결 중 작은 값)으로 새 지정가 접수. 확인 전 전량 체결이면 `{amended:false, reason}`, 확인 지연이면 422(새 주문 없음). 호가 단위·변경 없음 검증. 응답 `{amended, reason, canceled, order}`. 단일 writer 매칭이라 원자적 교체가 아니며 취소와 재접수 사이에 다른 참가자가 먼저 체결될 수 있다(의도된 한계).
- 웹 `MyOpenOrders.tsx`: 지정가 행의 **정정** 버튼 → 인라인 가격/남은 수량 입력(호가 단위·남은 수량 검증, 변경 없으면 비활성) → 확인. 테스트 `order.service.test.ts` amend 3건.

## 2026-09-22 — 스모크 스크립트

- `pnpm smoke` (`scripts/smoke.mjs`, 의존성 없음): 기동 중인 API에 임시 사용자(`smoke-*@smoke.local`)를 만들어 시장가 매수→체결→호가 단위 400→매도→실현손익/체결 내역→조건부(이미 만족 400·대기·취소)→OCO 짝 취소→트레일링→브래킷 ARMED→자산/일별/랭킹/헬스 background까지 18개 체크. 봇이 돌고 있어야 시장가가 체결된다. 끝나면 남은 보유를 청산하지만 계정 자체는 남는다(랭킹에 보임 — 필요하면 DB에서 지울 것).

## 2026-09-22 — 브래킷 주문: 매수 체결 후 손절/익절 자동 등록

- **DB**: migration `20260922140000_add_bracket_intents` → `order.bracket_intents` (`order_id` unique, `stop_bps` 10~5000, `take_bps` 10~10000, `status` PENDING/ARMED/CANCELED, `armed_qty`, `avg_fill_price`, `note`).
- **API**: `POST /orders`에 선택 필드 `bracket: {stopBps, takeBps}` — 매수에만 허용(매도면 400, 주문 전에 검증). 주문이 커밋된 뒤 `BracketService.attach()`가 의도를 저장하고 응답에 `bracket`을 실어 준다. `GET /orders/bracket?symbol=`, `DELETE /orders/bracket/:id`(PENDING만).
- **`apps/api/src/order/bracket.service.ts`**: 3초마다 PENDING을 훑어 부모 주문이 종결(FILLED/CANCELED/REJECTED)되면 `updateMany(PENDING→ARMED)`로 claim 후: 체결 0이면 CANCELED("체결 없이 종결된 주문"); 체결 있으면 `matching.trades`의 평균가로 손절 `floor(avg×(1−stop))`·익절 `ceil(avg×(1+take))`를 계산해 **체결 수량만큼** `ConditionalOrderService.placeOco()`. 체결과 등록 사이에 이미 선을 넘었으면 OCO 대신 **즉시 시장가 매도**(note에 사유·주문 ID). 등록 실패는 PENDING으로 되돌려 재시도. 헬스 `background.bracketIntents`. 테스트 `bracket.service.test.ts`(미종결 무시·평균가 OCO·부분 체결·무체결 취소·즉시 매도), `order.controller.test.ts`.
- **웹**: 주문폼 매수(지정가/시장가)에 "체결 후 손절/익절 자동 등록" 체크박스 + 손절/익절 % 입력(기본 5/10). 예약 주문 패널 맨 위에 PENDING 의도를 "대기 · 체결 후 자동 보호 · 손절 −5.0% · 익절 +10.0% [취소]"로 표시, ARMED push는 상단 notice. 런타임 검증: MOCK 20주 시장가 + 3%/8% → 수 초 내 평균가 42,750 기준 OCO 41,467/46,170 등록; 미체결 지정가 취소 시 의도 CANCELED.

## 2026-09-22 — 매매 성과·투자자 랭킹·종목 추세선

- **매매 성과**: `GET /account/realized`가 `stats {fills, wins, losses, winRate, avgWin, avgLoss, profitFactor, best, worst}`를 추가로 돌려준다(실현손익 테이블 집계, 손익 0 체결은 승/패 제외). 웹 `PerformanceCard.tsx`가 대시보드 자산 추이 오른쪽(lg 3열 중 1열)에 표시.
- **투자자 랭킹**: `GET /account/leaderboard?limit=` — 사용자(non-bot) 계정을 수익률 `(총자산 − 순입금) / 순입금` 순으로. 순입금 = `SIGNUP_BONUS/SEED/TRANSFER_IN/TRANSFER_OUT` 원장 합, 총자산 = 현금 + Σ보유×`last_price`(실시간 평가). 순입금 ≤ 0은 수익률 null로 맨 뒤. 응답 `{total, rows}`이며 내 행(`me:true`)은 상위 밖이어도 마지막에 붙는다. 웹 `Leaderboard.tsx`가 대시보드 뉴스 아래·보유 자산 위에 표시(30초 폴링). **Nav 메뉴는 LEGACY MENU LOCK 때문에 추가하지 않았다** — 별도 페이지가 필요하면 제품 결정 후 추가.
- **종목 추세선**: 대시보드 종목 표에 `Sparkline.tsx`(인라인 SVG) 열 "6시간 흐름" — 5분봉 종가 72개, 실시간 가격이 마지막 점을 대체, 5분마다 재조회.
- 웹 코드 포맷 주의: 저장소에 prettier 설정이 없어 기본(80열)으로 돌리면 기존 100열 스타일 파일이 통째로 바뀐다. 포맷이 필요하면 `npx prettier --print-width 100`을 쓰거나 패치 범위만 손보기.

## 2026-09-22 — 체결/예약 발동 토스트 알림

- **정산 push 확장**: `apps/settlement/src/main.ts`가 `account:{id}` 채널에 체결 정보를 실어 보낸다 — 매수자에 `{type:"trade", side:"BUY", symbol, price, qty, tradeId}`, 매도자에 `side:"SELL"`(자기 체결이면 한 번). 기존 `account_update`는 `order.closed`에서만 계속 쓰인다. 어떤 payload든 "내 계좌가 바뀌었다"는 신호이므로 기존 구독자(대시보드·주문폼 등)는 그대로 동작한다.
- **`apps/web/src/components/Toaster.tsx`**(layout에 전역 마운트): 로그인 상태면 `account:{id}`를 구독해 우하단 토스트. 체결은 종목·방향별 1.5초 창에서 합산(`N건 · 평균가`) — 봇 계정으로 로그인해도 폭주하지 않는다. 예약 주문 `TRIGGERED`/`FAILED`도 표시. 최대 4개, 6초 뒤 자동 소멸, `tradeId` 중복 무시. pathname 변화 때 재구독(로그인/로그아웃 대응).

## 2026-09-22 — 자산 추이 스냅샷 + 대시보드 차트

- **DB**: migration `20260922110000_add_equity_snapshots` → `account.equity_snapshots` (`account_id`, 분 단위 `ts`, `cash`, `stock_value`, `equity`; `(account_id, ts)` unique).
- **기록** `apps/api/src/account/equity-snapshot.service.ts`: 부팅 직후 1회 + 매 분 경계(+250ms)에 **한 SQL**로 모든 **사용자(non-bot) 계정**을 기록(현금 + Σ보유수량×`market.symbols.last_price`). `ON CONFLICT DO NOTHING`이라 API 복제본이 여러 개여도 중복 없음. 봇 계정은 제외(유동성 풀이라 의미 없음). 보존: 부팅 시와 하루 한 번 `compact()`가 7일 지난 행은 10분 격자(각 버킷의 마지막 분 :09/:19/…), 90일 지난 행은 1시간 격자(:59)만 남기고 지운다 — 조회가 "버킷의 마지막 행"을 쓰므로 과거 차트 모양이 유지된다.
- **API**: `GET /account/equity?range=1d|1w|all` → `[{ts, cash, stockValue, equity}]`. 버킷 폭 1분/10분/1시간, 버킷당 **마지막** 스냅샷(종가 방식) — `DISTINCT ON (bucket) … ORDER BY bucket, ts DESC`.
- **웹** `apps/web/src/components/EquityChart.tsx`: 대시보드 hero 아래 면적 차트(lightweight-charts `AreaSeries`). 첫 점 대비 증감으로 색(상승 빨강/하락 파랑/보합 sky), 헤더에 hover 시점(또는 현재)의 자산·증감·현금/주식 내역, 1일/1주/전체 토글은 `localStorage("dashboard:equity-range")`(마운트 후 읽음). 60초 폴링. 스냅샷 2개 미만이면 안내 문구.
- 주의: 스냅샷은 `last_price` 기준이라 대시보드 hero의 실시간 총자산과 최대 1분 차이가 난다(의도). 차트 제거는 CandleChart와 같은 "숨기고 다음 프레임에 remove" 패턴.

## 2026-09-22 — 조건부(예약) 주문

- **DB**: migration `20260922100000_add_conditional_orders` → `order.conditional_orders` (`direction` AT_OR_ABOVE/AT_OR_BELOW, `trigger_price`, `order_type` MARKET/LIMIT, `status` WAITING/TRIGGERED/CANCELED/FAILED, 발동 체결가·접수 주문 ID·실패 사유). **대기 중에는 아무것도 홀드하지 않는다.**
- **감시자** `apps/api/src/order/conditional-order.service.ts`: 부팅 시 WAITING 행을 메모리 인덱스(symbol→id)로 적재하고 `trades:*` Pub/Sub을 구독(REDIS_SUB 공유; Redis가 클라이언트별 패턴 중복을 제거). 체결가가 조건을 만족하면 인덱스에서 먼저 빼고 `updateMany(WAITING→TRIGGERED)`로 **정확히 한 번** claim한 뒤 `OrderService.place()`로 일반 주문 접수. 접수 거부(잔액/수량 부족 등)는 `FAILED`+사유. 부팅 직후와 10초마다 인덱스를 재적재하고 `market.symbols.last_price`로도 검사해 내려가 있던 동안 지나친 조건을 잡는다. 계정당 대기 50건 제한. 현재가가 이미 조건을 만족하면 400으로 거부(일반 주문 안내).
- **OCO(손절+익절 한 쌍)**: migration `20260922120000_add_conditional_oco_group`가 `oco_group_id`를 추가. `POST /orders/conditional/oco {symbol, side, qty, lowerPrice, upperPrice}`가 AT_OR_BELOW/AT_OR_ABOVE 두 다리를 같은 그룹으로 만든다(둘 다 현재가를 넘기면 안 됨). 한 다리가 claim되면 `cancelOcoSiblings()`가 짝 WAITING 행을 `CANCELED`(fail_reason에 사유)로 바꾸고 인덱스에서 제거하며, 한 다리를 사용자가 취소해도 짝을 함께 취소한다. 웹: 포지션 바의 **손절/익절 설정** 버튼이 인라인 폼(기본값 평단 −5%/+10%, 현재가 안쪽으로 보정)을 열어 OCO를 등록하고, 예약 목록에 `OCO` chip. 런타임 검증: NEKO 100주에 18,900/19,000 OCO → 익절 발동·손절 자동 취소·시장가 체결·실현손익 −25,000원 기록 확인.
- **트레일링 스탑**: migration `20260922130000_add_conditional_trailing`이 `trail_bps`(10~5000, CHECK)·`watermark`를 추가. `POST /orders/conditional`에 `trailBps`를 주면 `direction`/`triggerPrice`는 무시되고 매도=AT_OR_BELOW(고점 추적)/매수=AT_OR_ABOVE(저점 추적)로 고정, 등록 시점 `last_price`가 watermark. 감시자 `onTick`은 새 극값이면 메모리의 watermark·trigger를 먼저 옮기고(`trailingTrigger`, 매도 내림/매수 올림) `persistTrail()`로 WAITING 행만 DB에 반영(실패해도 메모리 값이 판정 기준) — 그 tick에서는 발동 검사를 건너뛴다. 재시작 시 DB의 watermark/trigger로 복원. 갱신은 단조 보장: `persistTrail`은 DB watermark가 뒤처진 경우에만 쓰고(`OR: [{watermark:null},{watermark:{lt|gt}}]`), 10초 `reloadIndex`는 메모리 극값이 DB보다 앞서면 메모리 값을 유지한다(테스트 "trailing reload"). 웹 주문폼 조건부 모드에 **고정 가격 | 트레일링** 토글(%, 트리거 미리보기), 예약 목록/탭에는 "트레일링 손절 3%"와 현재 트리거(툴팁에 추적 기준). 런타임 검증: SAKU 0.2% 트레일링 → 고점 260,500→261,000 따라 트리거 259,979→260,478 상승, 260,000 체결에 발동.
- **호가 단위 강제**: `OrderService.place`와 조건부 LIMIT 접수가 `tickSizeOf(symbol)` 격자 밖 지정가를 400(`"SAKU의 호가 단위는 500원입니다"`)으로 거부한다(shared `isOnTick`). 봇은 이미 `alignToTick`으로 정렬하므로 영향 없음(DB 확인: 격자 밖 지정가 0건). 주문폼은 가격 라벨에 단위를 보여주고, 어긋나면 "N원으로 맞추기" 링크와 함께 버튼을 잠근다.
- **일별 성과**: `GET /account/daily?days=` (`EquitySnapshotService.daily`) — KST 날짜별로 그날 마지막 스냅샷의 종가 자산·전일 종가 대비 증감·실현손익 합·매도 체결 수. 스냅샷과 실현손익을 FULL OUTER JOIN 해 둘 중 하나만 있는 날도 나온다. 웹 `DailyPerformance.tsx`가 대시보드에서 투자자 랭킹 옆(lg 2열)에 최근 14일 표시, 첫 행에 "오늘" chip.
- **거래 페이지 UI**: 상단에 `SymbolStrip.tsx`(5종목 현재가·등락률 실시간, 클릭 전환), 호가창 `Orderbook.tsx`의 `useMyDepth`가 `/orders?symbol&status=live`로 내 미체결 지정가 단계에 파란 점 표시(계정 push + 15초 폴백).
- **차트 가격선**: `apps/web/src/lib/usePositionLines.ts`가 내 평단가(흰 파선, "평단 N주")와 이 종목의 대기 중 예약 트리거(손절 파랑/익절 빨강 점선, 트레일링 노랑)를 읽어 `CandleChart`가 `createPriceLine`으로 그린다. 계정 push + 15초 폴백으로 갱신, 차트 재생성(심볼/봉 전환) 시 `chartEpoch`로 다시 그림. 가격선은 자동 스케일에 포함되지 않아 화면 밖에 있을 수 있다(의도).
- **헬스**: `GET /health/ready`(및 `/health/trading`) 응답에 `background` 필드 — `apps/api/src/core/background-status.ts`의 `BackgroundStatusRegistry`(CoreModule 전역)에 감시자(`conditionalOrders: waiting/lastTickAt/triggered/failed`)와 스냅샷(`equitySnapshots: status up|degraded|starting, lastSnapshotAt, lastInserted, lastError`)이 자기 상태를 등록한다. 정보용이며 readiness 판정에는 관여하지 않는다.
- `pnpm check:consistency`에 두 검사 추가: `realized_pnl` 행이 같은 tradeId의 매도자·수량·가격과 일치하고 `realized = price×qty − cost_basis`인지, 조건부 주문의 TRIGGERED 행에 접수 주문 ID(60초 유예)·FAILED 행에 사유가 있는지, 고정 트리거 WAITING 행이 `last_price`를 2분 넘게 만족한 채 남아 있지 않은지(감시자 정지 감지).
- 포지션 바에 **보호** 항목: 이 종목의 대기 중 매도 예약을 "손절 6,940 · 익절 8,940 · 트레일링 10% (현재 7,155)"로 요약.
- `/orders` 페이지에 **예약** 탭(전 종목 조건부 주문 이력, 대기 행 취소, OCO chip·발동가·취소/실패 사유). 탭 저장 키 `orders:tab`.
- **API**: `POST /orders/conditional {symbol, side, direction, triggerPrice, qty, orderType?, limitPrice?}`, `GET /orders/conditional?symbol=&status=&limit=`, `DELETE /orders/conditional/:id`(WAITING만). 발동/실패 시 `account:{id}` 채널에 `{type:"conditional", status, label, orderId, failReason…}` push.
- **공통 규칙** `packages/shared/src/conditional.ts`: `conditionMet`(경계 포함), `inferTriggerDirection`(현재가 대비 위치로 이상/이하 추론), `describeCondition`(손절/익절/돌파/눌림 라벨). 테스트: `apps/api/src/order/__tests__/conditional.test.ts`, `conditional-order.service.test.ts`(claim 1회·다른 인스턴스 선점·FAILED 기록·LIMIT 전달).
- **웹**: `OrderForm` 주문 유형에 **조건부** 추가(트리거 가격·이상/이하 토글, 방향은 자동 추론 후 수동 고정 가능, 이미 만족 시 경고+버튼 비활성, 호가 클릭은 트리거 칸에 입력). `MyConditionalOrders.tsx`가 거래 페이지 미체결 주문 아래에 대기 목록(취소)과 최근 이력 5건(발동 체결가·실패 사유 title)을 보여주며, push 알림 문구를 상단에 띄운다. 행이 없으면 렌더하지 않는다.
- 런타임 검증(2026-09-22): TANU 현재가 ±10원에 손절/익절 예약 → 봇 체결로 수 초 내 둘 다 TRIGGERED, 접수된 시장가 주문 FILLED 확인. 이미 만족 조건 400, 취소 경합 처리 확인. UI에서 등록·취소·이력 표시 확인, 콘솔 에러 없음.

## 2026-09-22 — 실현손익 추적

- **DB**: migration `20260922090000_add_realized_pnl` → `account.realized_pnl` (계정·종목·`trade_id` unique·수량·가격·차감 원가·실현손익·체결시각). 정산 컨슈머(`apps/settlement/src/main.ts` `settleTrade`)가 매도자 `costBasis` 비례 차감과 **같은 트랜잭션**에 한 행을 남긴다. `trade_id` unique가 재전달을 한 번 더 막는다. 불변식: 누적 `realized` + 남은 `costBasis` = 총 매입원가.
- **공통 계산**: `packages/shared/src/settlement.ts` `realizedPnlForSale()` — 컨슈머와 복구 플래너(`packages/db/scripts/settlement-recovery-plan.ts`, `plan.realizedPnl`)가 같은 BigInt 내림 규칙을 쓴다. 테스트: `apps/api/src/account/__tests__/settlement-state.test.ts`, `packages/db/scripts/__tests__/settlement-recovery-plan.node-test.ts`.
- **API**: `GET /account/realized?limit=` → `{ today, todayQty, total, totalQty, bySymbol[], recent[] }` (KST 당일 경계는 `apps/api/src/common/market-time.ts` `koreaDayStart`, market summary와 공유). `GET /account/trades?limit=&symbol=` → 내 체결(매수/매도/자전, taker 여부, 매도 행에 `realized`·`costBasis`).
- **웹**: 대시보드 hero에 "오늘 실현손익 / 누적 실현손익" 타일, `/orders`에 **주문 | 체결** 탭(체결 탭은 실현손익·수익률 열, 탭 선택은 `localStorage("orders:tab")`), 거래 페이지 포지션 바에 종목 누적 실현손익.
- 주의: 테이블 도입 전의 매도는 행이 없어 집계에서 빠진다(의도). 봇 시드 보유(원가 0)의 매도는 대금 전체가 실현으로 잡히고 `realizedRate`는 null.

## 거래 페이지 포지션 바 + 청산

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
