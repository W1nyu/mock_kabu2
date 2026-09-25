# REST API 레퍼런스 (apps/api, :4100)

모든 응답은 JSON. BigInt 컬럼(잔액·금액)은 number로 직렬화된다. 인증이 필요한 엔드포인트는
`Authorization: Bearer <token>` (로그인/가입 응답의 `token`, 7일 만료). 시각은 ISO 8601(UTC) 또는
epoch ms(`ts`)이며, "당일"은 항상 **KST**(UTC+9) 기준이다. 오류는 Nest 형식
`{ statusCode, message, error }`.

WebSocket(socket.io, 같은 포트)은 단일 `"message"` 이벤트로 `{channel, data}`를 보낸다. 채널은
`orderbook:{symbol}`, `trades:{symbol}`, `news:all|{symbol}`, `account:{accountId}`(본인만). 웹은
`apps/web/src/lib/socket.ts`의 `subscribe()`만 쓴다.

## 인증 `/auth`

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/auth/signup` | – | `{nickname(2~20자, 한글·영문·숫자·_ - .), password(4+)}` → `{token, user}`. 이메일 없음. 닉네임은 대소문자 무시 유일(중복 **409**). 가입 보너스 1,000만 원. IP당 10분 5회 초과 시 **429** |
| POST | `/auth/login` | – | `{nickname, password}` → `{token, user}` (봇·관리자 같은 시스템 계정은 `{email, password}`). IP+로그인 ID당 60초 10회 초과 시 **429** |
| GET | `/auth/me` | ✓ | 토큰의 사용자 정보 `{userId, accountId, nickname}` |
| PATCH | `/auth/me` | ✓ | `{nickname}`(1~20자) → 새 `{token, user}` (닉네임이 토큰에 들어 있음) |
| POST | `/auth/password` | ✓ | `{currentPassword, newPassword(4+)}` → `{ok:true}` |

## 시세 `/market` (공개)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/market/symbols` | 활성 종목 `[{symbol, name, initialPrice, referencePrice, sessionStart, tickSize, lastPrice}]`. `referencePrice`는 매일 09:00 KST 이후 첫 체결가(첫 체결 전에는 직전 체결가, 체결 이력이 없으면 `initialPrice`), `sessionStart`는 UTC 밀리초 |
| GET | `/market/overview` | 전 종목 시세 + 09:00 KST 세션 요약 한 번에 (`symbols` + `summary` 필드 합집합, 2초 캐시) — 대시보드용 |
| GET | `/market/summary/:symbol` | 09:00 KST 시작 세션 요약 `{referencePrice, sessionStart, lastPrice, high, low, volume, turnover, buyVolume, sellVolume, lastTradeTs}`. `sessionStart`는 UTC 밀리초 |
| GET | `/market/orderbook/:symbol` | 호가 스냅샷 `{bids, asks, lastPrice, seq}` (각 10단) |
| GET | `/market/candles/:symbol?interval=1m|5m|15m|1h|4h|1d&limit=` | 봉. 1분만 저장, 나머지는 조회 시 집계 |
| GET | `/market/trades/:symbol?limit=` | 최근 체결 |
| GET | `/market/index?range=1d|1w|all` | 모의 시장 지수 `[{ts, value}]` — 시가총액 가중: Σ(종가 × 발행주식수) ÷ 제수. 발행주식수는 상장 시가총액이 종목마다 1.2조 원(상장 시 각 20%)이 되도록 정했다(`SYMBOLS.listedShares`). 편입 종목·제수는 `market.index_epochs` 구간이 정하며 첫 구간은 상장 시 1,000, 재상장 등 편입 변경 시에는 지수 수준이 이어지도록 새 구간의 제수를 정한다. KST 09:00 점은 해당 1분봉 시가(체결이 없는 종목은 직전가, 거래 전 종목은 상장가)를 사용하고 기간 조회 시작 전 가격도 이어받는다. |
| GET | `/market/index/meta` | 현재 지수 구간 `{startsAt, divisor, members: [{symbol, listedShares}]}` — 웹이 실시간 체결가로 현재 지수를 같은 식으로 계산할 때 쓴다 (10초 캐시) |
| GET | `/market/news?symbol=&industry=&scope=&reference=&limit=` | 가상 뉴스(호재/악재·강도는 응답에서 제외). `symbol`은 그 종목·시장 전반·소속 산업군 기사(`scope=own`이면 그 종목 기사만), `industry=<산업군 id>`는 그 산업군 종목 기사와 산업군 기사(`INDUSTRIES`: tech·battery·industrial·mobility·media·health·energy·consumer·finance), `industry=market`은 시장 전반 기사만, `reference=<USDKRW|OIL|GAS|COPPER|GOLD|CORN>`은 그 기초자산을 움직인 기사. 응답에 `referenceCodes[]` |
| GET | `/market/sparks` | 전 종목 미니 추세선 `{ 종목: [5분봉 종가…] }` (최근 72개). 1분 공유 캐시 — 화면마다 종목 수만큼 봉을 요청하지 않게 한 묶음 API |
| GET | `/market/reference` | 선물 기초자산 가상 지수(원/달러·원유·천연가스·구리) `[{code,name,unit,scale,decimals,value,ts,base,spark}]`. 값은 실제값 × scale 정수, `base`는 09:00 KST 이후 첫 1분봉 시가(없으면 직전 종가). 5초 공유 캐시. 실시간은 소켓 `ref:{code}` |
| GET | `/market/futures` | 선물 5종(KABUF·USDF·OILF·GASF·CPRF) `[{symbol,name,unit,priceScale,decimals,tickUnits,unitValue,initialMarginBps,maintenanceMarginBps,lastPrice,base,underlying,volume}]`. 가격은 정수 단위(실제 × priceScale), `underlying`은 기초자산(KABU 지수는 현물 최근가로 계산). 2초 공유 캐시 |
| GET | `/account/futures` 🔒 | 내 선물 포지션 `{positions:[{symbol,qty(±),avgPrice,markPrice,unrealized,marginHeld,maintenanceMargin,leverage}],marginHeld,debt,unrealized,maintenanceMargin,initialMargin,equity,leverage:{[symbol]:1~20|null},marginCall:{startedAt,deadline,required,shortfall}|null,liquidations:[{orderId,symbol,side,qty,reason:DEADLINE|EMERGENCY,createdAt}]}` — 추가증거금·반대매매 상태 포함. 계좌 채널 push `{type:"futures_margin_call",status:OPEN|RESOLVED|LIQUIDATED|EMERGENCY}` |
| POST | `/account/futures/leverage` 🔒 | `{symbol, leverage: 1~20 | null}` 종목 레버리지 설정(null = 거래소 기준 증거금). 그 종목에 포지션·미체결 주문이 있으면 422. 위탁증거금률 = 1/레버리지, 유지 = 위탁의 2/3 |
| GET | `/market/reference/:code/candles?interval=&limit=` | 기초자산 봉(1분만 저장, 나머지 조회 시 집계, 30일 지난 1분봉은 1시간봉으로 압축) |
| GET | `/market/trades/latest?limit=` | 전 종목 최근 체결 `{ 종목: [최신순…] }` (봇 시장 관찰용, 0.25초 공유 캐시) |

## 주문 `/orders` (인증)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/orders` | `{symbol, side: BUY|SELL, type: LIMIT|MARKET, price?, qty, bracket?: {stopBps?, takeBps?}}`. 지정가는 **호가 단위 배수**여야 하고 수량 ≤ 1천만, 가격 ≤ 10억. 헤더 `Idempotency-Key`(1~128자)를 주면 같은 키의 재시도는 기존 주문을 `idempotentReplay:true`로 돌려준다. `bracket`은 매수에만 — 체결 후 손절/익절 자동 등록 의도(응답 `bracket`). 둘 다면 OCO, 하나만이면 단일 예약 |
| GET | `/orders?symbol=&status=live&limit=` | 내 주문. `status=live`는 OPEN/PARTIAL만 |
| DELETE | `/orders/:id` | 취소 요청(비동기, 매칭 엔진이 `order.closed`로 확정) |
| PATCH | `/orders/:id` | 지정가 정정 `{price?, qty?}` — 취소 확인 후 남은 수량으로 재접수. `{amended, reason, canceled, order}` |
| GET | `/orders/quote-state?symbol=` | 마켓메이커용: 내 활성 주문 + 호가 스냅샷 한 번에 |
| GET | `/orders/bracket?symbol=&limit=` | 브래킷 의도 목록 (`PENDING|ARMED|CANCELED`, `armedQty`, `avgFillPrice`, `note`) |
| DELETE | `/orders/bracket/:id` | PENDING 의도 취소 |

### 조건부(예약) 주문 `/orders/conditional` (인증)

대기 중에는 아무것도 홀드하지 않는다. 체결가가 조건을 만족하는 순간 API가 한 번만 발동시켜
일반 주문으로 접수하며, 접수 거부(잔액/수량 부족)는 `FAILED`+`failReason`.

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/orders/conditional` | 고정: `{symbol, side, direction: AT_OR_ABOVE|AT_OR_BELOW, triggerPrice, qty, orderType?: MARKET|LIMIT, limitPrice?}`. 트레일링: `{symbol, side, qty, trailBps(10~5000)}` — 매도는 고점, 매수는 저점을 따라 `triggerPrice`가 움직인다(`watermark`). 현재가가 이미 조건을 만족하면 **400** |
| POST | `/orders/conditional/oco` | `{symbol, side, qty, lowerPrice, upperPrice}` → 두 다리(같은 `ocoGroupId`). 한쪽 발동/취소 시 다른 쪽 자동 취소 |
| GET | `/orders/conditional?symbol=&status=&limit=` | 목록 (`WAITING|TRIGGERED|CANCELED|FAILED`, `triggerTradePrice`, `triggeredOrderId`) |
| DELETE | `/orders/conditional/:id` | WAITING 취소 (OCO면 짝도 취소) |

계정당 대기 50건 한도.

## 계좌 `/account` (인증)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/account` | `{id, balance, balanceExact, holdAmount, available, availableExact}` (`*Exact`는 큰 잔액의 정확한 십진 문자열) |
| GET | `/account/holdings` | 보유 `[{symbol, qty, holdQty, availableQty, lastPrice, value, costBasis, avgCost, pnl, pnlRate}]` |
| GET | `/account/trades?symbol=&limit=` | 내 체결 `[{tradeId, symbol, side: BUY|SELL|SELF, price, qty, amount, taker, realized, costBasis, ts}]` |
| GET | `/account/realized?limit=` | 실현손익 `{today, todayQty, total, totalQty, bySymbol[], recent[], stats: {fills, wins, losses, winRate, avgWin, avgLoss, profitFactor, best, worst}, futures: {today, todayQty, total, totalQty, stats}}` — `futures`는 선물 청산(반대매매·일일 정산 포함) 실현손익, 주식과 같은 모양 |
| GET | `/account/equity?range=1d|1w|all` | 분 단위 자산 스냅샷 `[{ts, cash, stockValue, equity}]` (1분/10분/1시간 버킷의 마지막 값) |
| GET | `/account/daily?days=` | KST 일별 `[{date, closeEquity, closeCash, change, changeRate, realized, fills}]` 최신순 |
| GET | `/account/leaderboard?limit=&period=all|today|week` | 사용자 계정 수익률 순위 `{total, rows: [{rank, nickname, equity, deposits, pnl, returnRate, indexRate, indexBase, indexCurrent, alpha, realized, me}]}` — 지수 수준은 `/market/index`와 같은 시가총액 가중(기준 시각의 지수 구간 사용). `indexRate = indexCurrent / indexBase − 1`; `alpha = returnRate − indexRate`. today/week는 첫 자산 스냅샷을 기준으로, 전체는 가입 시점을 기준으로 비교한다. 봇·관리자·`smoke-*` 제외 |
| GET | `/account/ledger?limit=` | 현금 원장 (`deltaExact`, `balanceAfterExact` 십진 문자열 포함) |

## 운영

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health`, `/health/live` | 프로세스 생존 |
| GET | `/health/ready` | DB·Redis + 워커 heartbeat + `background`(조건부 감시자·자산 스냅샷·브래킷) |
| GET | `/health/trading` | ready + 매칭·정산 워커가 모두 up일 때만 ok |
| GET | `/health/maintenance` | 점검 상태 `{active, startAt, endAt, timezone, manual, message, upcoming}` — 매일 04:10~04:20 KST 또는 운영자 임시 점검(Redis `maintenance:manual`). `upcoming`은 시작 전 임시 점검 예고 (캐시 없음) |
| GET | `/admin/lock-info` | 락 전략·충돌/재시도 카운터 |
| GET | `/internal/operations` | API 컨테이너 loopback 전용 소켓 동접·프로세스 메모리 (공개 프록시에서 404) |
| POST | `/internal/liquidity/ensure`, `/internal/news/publish` | 봇 프로세스 전용(부트스트랩 토큰) |
| POST | `/internal/news/force` | 운영자 도구(내부 토큰) `{templateId: "macro.oil.spike"}` — 봇이 5초 안에 그 시장 기사를 평소 경로로 발행(주가 영향·기초자산 반응 포함). 봇은 `/internal/news/force/take`로 꺼내 간다 |
| GET | `/replay/datasets`, `/replay/datasets/:id/candles` | 실전 리플레이(레거시 메뉴) |

## 계정 채널 push 페이로드 (`account:{accountId}`)

- `{type:"trade", side, symbol, price, qty, tradeId}` — 정산 완료된 내 체결 (매수자/매도자 각각)
- `{type:"account_update"}` — 주문 종결(홀드 해제)
- `{type:"conditional", id, status, symbol?, side?, qty?, triggerPrice?, label?, orderId?, failReason?}` — 예약 주문 등록/발동/실패/취소
- `{type:"bracket", id, status, symbol?, qty?, avgFillPrice?, lowerPrice?, upperPrice?, note?}` — 브래킷 의도 상태

어떤 payload든 "내 계좌가 바뀌었다"는 신호로 취급해 다시 조회하면 안전하다.
