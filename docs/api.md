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
| POST | `/auth/signup` | – | `{email, password(4+), nickname}` → `{token, user}`. 가입 보너스 1,000만 원. IP당 10분 5회 초과 시 **429** |
| POST | `/auth/login` | – | `{email, password}` → `{token, user}`. IP+이메일당 60초 10회 초과 시 **429** |
| GET | `/auth/me` | ✓ | 토큰의 사용자 정보 `{userId, accountId, email, nickname}` |
| PATCH | `/auth/me` | ✓ | `{nickname}`(1~20자) → 새 `{token, user}` (닉네임이 토큰에 들어 있음) |
| POST | `/auth/password` | ✓ | `{currentPassword, newPassword(4+)}` → `{ok:true}` |

## 시세 `/market` (공개)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/market/symbols` | 활성 종목 `[{symbol, name, initialPrice, tickSize, lastPrice}]` |
| GET | `/market/summary/:symbol` | KST 당일 요약 `{referencePrice, lastPrice, high, low, volume, turnover, buyVolume, sellVolume, lastTradeTs}` |
| GET | `/market/orderbook/:symbol` | 호가 스냅샷 `{bids, asks, lastPrice, seq}` (각 10단) |
| GET | `/market/candles/:symbol?interval=1m|5m|15m|1h|4h|1d&limit=` | 봉. 1분만 저장, 나머지는 조회 시 집계 |
| GET | `/market/trades/:symbol?limit=` | 최근 체결 |
| GET | `/market/index?range=1d|1w|all` | 모의 시장 지수 `[{ts, value}]` — 5종목 동일가중, 기준가 대비 ×1000 |
| GET | `/market/news?symbol=&limit=` | 가상 뉴스(호재/악재·강도는 응답에서 제외) |

## 주문 `/orders` (인증)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/orders` | `{symbol, side: BUY|SELL, type: LIMIT|MARKET, price?, qty, bracket?: {stopBps, takeBps}}`. 지정가는 **호가 단위 배수**여야 하고 수량 ≤ 1천만, 가격 ≤ 10억. 헤더 `Idempotency-Key`(1~128자)를 주면 같은 키의 재시도는 기존 주문을 `idempotentReplay:true`로 돌려준다. `bracket`은 매수에만 — 체결 후 손절/익절 OCO 자동 등록 의도(응답 `bracket`) |
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
| GET | `/account` | `{id, balance, holdAmount, available}` |
| GET | `/account/holdings` | 보유 `[{symbol, qty, holdQty, availableQty, lastPrice, value, costBasis, avgCost, pnl, pnlRate}]` |
| GET | `/account/trades?symbol=&limit=` | 내 체결 `[{tradeId, symbol, side: BUY|SELL|SELF, price, qty, amount, taker, realized, costBasis, ts}]` |
| GET | `/account/realized?limit=` | 실현손익 `{today, todayQty, total, totalQty, bySymbol[], recent[], stats: {fills, wins, losses, winRate, avgWin, avgLoss, profitFactor, best, worst}}` |
| GET | `/account/equity?range=1d|1w|all` | 분 단위 자산 스냅샷 `[{ts, cash, stockValue, equity}]` (1분/10분/1시간 버킷의 마지막 값) |
| GET | `/account/daily?days=` | KST 일별 `[{date, closeEquity, closeCash, change, changeRate, realized, fills}]` 최신순 |
| GET | `/account/leaderboard?limit=&period=all|today|week` | 사용자 계정 수익률 순위 `{total, rows: [{rank, nickname, equity, deposits, pnl, returnRate, indexRate, alpha, realized, me}]}` — `period`가 today/week면 기간 첫 스냅샷 대비 수익률(기간 중 입출금 제외)·기간 실현손익·기간 지수 등락; `alpha = returnRate − indexRate` (봇·`@smoke.local` 제외, 내 행은 항상 포함) |
| GET | `/account/ledger?limit=` | 현금 원장 |
| POST | `/account/transfer` | `{toEmail, amount}` 계좌 이체 |

## 운영

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health`, `/health/live` | 프로세스 생존 |
| GET | `/health/ready` | DB·Redis + 워커 heartbeat + `background`(조건부 감시자·자산 스냅샷·브래킷) |
| GET | `/health/trading` | ready + 매칭·정산 워커가 모두 up일 때만 ok |
| GET | `/admin/lock-info` | 락 전략·충돌/재시도 카운터 |
| POST | `/internal/liquidity/ensure`, `/internal/news/publish` | 봇 프로세스 전용(부트스트랩 토큰) |
| GET | `/replay/datasets`, `/replay/datasets/:id/candles` | 실전 리플레이(레거시 메뉴) |

## 계정 채널 push 페이로드 (`account:{accountId}`)

- `{type:"trade", side, symbol, price, qty, tradeId}` — 정산 완료된 내 체결 (매수자/매도자 각각)
- `{type:"account_update"}` — 주문 종결(홀드 해제)
- `{type:"balance"}` — 이체
- `{type:"conditional", id, status, symbol?, side?, qty?, triggerPrice?, label?, orderId?, failReason?}` — 예약 주문 등록/발동/실패/취소
- `{type:"bracket", id, status, symbol?, qty?, avgFillPrice?, lowerPrice?, upperPrice?, note?}` — 브래킷 의도 상태

어떤 payload든 "내 계좌가 바뀌었다"는 신호로 취급해 다시 조회하면 안전하다.
