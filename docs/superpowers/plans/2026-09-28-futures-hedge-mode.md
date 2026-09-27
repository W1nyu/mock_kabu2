# 선물 양방향(헤지) 매매 · 일부 청산 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사람 계정은 같은 선물 종목에 롱·숏을 동시에 보유하고(진입/청산을 명시), 포지션을 원하는 수량만큼 청산할 수 있게 한다. 봇·옵션은 지금처럼 순포지션.

**Architecture:** `account.futures_positions`에 `position_side`(`LONG`|`SHORT`|`NET`)를 넣어 기본키를 (계좌, 종목, 방향)으로 바꾼다. 주문·조건부 주문에 `position_side`(null = 순포지션)를 넣고, 매수+LONG=롱 진입, 매도+LONG=롱 청산, 매도+SHORT=숏 진입, 매수+SHORT=숏 청산으로 해석한다. 매칭 엔진·이벤트 형식은 그대로이고, 정산은 DB의 주문 행에서 방향을 읽는다.

**Tech Stack:** pnpm/turbo 모노레포, NestJS(api), Prisma/PostgreSQL, vitest(api·settlement), node:test(shared·bots), Next.js 15 + Tailwind(web).

**Spec:** `docs/superpowers/specs/2026-09-28-futures-hedge-mode-design.md`

## Global Constraints

- 사람 계정(`auth.users.is_bot = false`)의 선물 주문은 `positionSide`(`LONG`|`SHORT`) 필수, 없으면 400 `선물 주문은 롱/숏 방향이 필요합니다`.
- 봇 계정의 선물 주문에 `positionSide`가 오면 400 `봇 계정은 롱/숏 방향 없이 주문합니다`. 옵션·현물 주문에 오면 400 `롱/숏 방향은 선물 주문에만 씁니다`. 값이 LONG/SHORT가 아니면 400 `positionSide는 LONG/SHORT`.
- 청산 주문이 청산 가능 수량(|해당 방향 보유| − 해당 방향 청산 미체결 잔량)을 넘으면 422 `청산 가능 수량이 부족합니다`. 청산 주문의 증거금은 0.
- 증거금은 롱·숏 각각 따로. 레버리지는 종목당 하나(롱·숏 행에 같은 값), 포지션·미체결이 있으면 잠김.
- 옵션은 변경 없음(NET).
- 이벤트 멱등성 불변식(`event_id`, `processed_events`) 유지.
- UI 색: 상승/매수/롱=빨강(`up`), 하락/매도/숏=파랑(`down`). 숫자 `tabular-nums`(`num` 클래스).
- 커밋 메시지 한국어, `feat:`/`fix:`/`docs:` prefix, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 실시간 구독은 `apps/web/src/lib/socket.ts`의 `subscribe()`만.
- 새 한국어 서버 문구는 `packages/shared/src/server-messages.ts`, 새 화면 문구는 `apps/web/src/lib/i18n/messages.ts`에 영·일 번역을 함께 넣는다.
- Windows 환경. `error.md`는 건드리지 않는다.

---

### Task 0: 선행 조건 — 커밋되지 않은 수수료 작업 정리

작업 트리에 커밋되지 않은 거래 수수료 작업(`apps/api/src/order/order.service.ts`, `apps/settlement/src/futures.ts`, `apps/web/src/components/FuturesOrderPanel.tsx`, `packages/shared/src/trading-fees.ts` 등)이 있고, 이 계획이 같은 파일을 고친다. 섞어 커밋하면 안 된다.

- [ ] **Step 1: 상태 확인**

Run: `git status --short`
Expected: `apps/settlement/src/trading-fees.ts`, `packages/shared/src/trading-fees.ts` 등이 `??`/`M`이면 수수료 작업이 아직 커밋되지 않은 것.

- [ ] **Step 2: 커밋되지 않았으면 멈추고 사용자에게 묻는다**

"수수료 작업을 먼저 커밋할지(누가, 어떤 커밋으로), 아니면 이 작업을 그 위에 얹어 함께 커밋할지"를 사용자에게 묻고 답을 받은 뒤 진행한다. 이 계획의 코드는 수수료 작업이 들어간 현재 작업 트리를 기준으로 쓴다(`settleTradingFees`, `isTradingFeeExempt`, `orderHoldWithFee`, `TradingFeeNotice`가 존재).

---

### Task 1: shared — 방향 타입, 양방향 체결 적용, 위험 판정 키

**Files:**
- Modify: `packages/shared/src/futures.ts` (FuturePositionState 아래, `applyFutureFill` 뒤, `FuturesRiskPosition`/`assessFuturesRisk`)
- Test: `packages/shared/test/futures.node-test.mjs`

**Interfaces:**
- Produces:
  - `type FuturesPositionSide = "LONG" | "SHORT"`
  - `type FuturesPositionRowSide = FuturesPositionSide | "NET"`
  - `isFuturesPositionSide(value: unknown): value is FuturesPositionSide`
  - `isOpeningHedgeOrder(side: "BUY" | "SELL", positionSide: FuturesPositionSide): boolean`
  - `hedgeCloseSide(positionSide: FuturesPositionSide): "BUY" | "SELL"`
  - `rowSideOf(positionSide: string | null | undefined): FuturesPositionRowSide`
  - `applyHedgeFill(def: Pick<FutureDef,"unitValue">, position: FuturePositionState, positionSide: FuturesPositionSide, side: "BUY"|"SELL", price: number, fillQty: number): FutureFillResult & { overflow: number }`
  - `futuresPositionKey(symbol: string, positionSide: FuturesPositionRowSide): string` — NET이면 `symbol`, 아니면 `symbol:LONG` 등
  - `FuturesRiskPosition.positionSide?: FuturesPositionRowSide`, `FuturesRiskAssessment.emergency`는 이제 `futuresPositionKey` 목록(NET 행은 종목 코드 그대로라 기존 호환)

- [ ] **Step 1: 실패하는 테스트 작성** — `packages/shared/test/futures.node-test.mjs` 끝에 추가하고 import 목록에 `applyHedgeFill, futuresPositionKey, hedgeCloseSide, isFuturesPositionSide, isOpeningHedgeOrder, rowSideOf`를 더한다.

```js
test("hedge order intent: buy long / sell short open, the opposite sides close", () => {
  assert.equal(isOpeningHedgeOrder("BUY", "LONG"), true);
  assert.equal(isOpeningHedgeOrder("SELL", "LONG"), false);
  assert.equal(isOpeningHedgeOrder("SELL", "SHORT"), true);
  assert.equal(isOpeningHedgeOrder("BUY", "SHORT"), false);
  assert.equal(hedgeCloseSide("LONG"), "SELL");
  assert.equal(hedgeCloseSide("SHORT"), "BUY");
  assert.equal(isFuturesPositionSide("LONG"), true);
  assert.equal(isFuturesPositionSide("NET"), false);
  assert.equal(rowSideOf(null), "NET");
  assert.equal(rowSideOf("SHORT"), "SHORT");
  assert.equal(futuresPositionKey("KABUF", "NET"), "KABUF");
  assert.equal(futuresPositionKey("KABUF", "SHORT"), "KABUF:SHORT");
});

test("hedge fill: opening adds, closing only reduces and never flips", () => {
  // 숏 −3 @ 88,000 에 숏 진입 2 @ 89,000 → −5
  const opened = applyHedgeFill(KABUF, { qty: -3, entryValue: 264_000n }, "SHORT", "SELL", 89_000, 2);
  assert.deepEqual([opened.qty, opened.entryValue, opened.closedQty, opened.overflow], [-5, 442_000n, 0, 0]);
  // 롱 3 @ 88,000 에 롱 청산 2 @ 89,000 → 1, 실현 (89,000−88,000)×2×10,000
  const closed = applyHedgeFill(KABUF, { qty: 3, entryValue: 264_000n }, "LONG", "SELL", 89_000, 2);
  assert.deepEqual([closed.qty, closed.closedQty, closed.realized, closed.overflow], [1, 2, 20_000_000n, 0]);
  // 롱 3에 롱 청산 5가 체결돼도 3만 닫고 숏을 열지 않는다
  const over = applyHedgeFill(KABUF, { qty: 3, entryValue: 264_000n }, "LONG", "SELL", 88_000, 5);
  assert.deepEqual([over.qty, over.entryValue, over.closedQty, over.overflow], [0, 0n, 3, 2]);
  // 포지션이 없으면 청산 체결은 전부 overflow
  const none = applyHedgeFill(KABUF, { qty: 0, entryValue: 0n }, "SHORT", "BUY", 88_000, 1);
  assert.deepEqual([none.qty, none.closedQty, none.overflow], [0, 0, 1]);
});

test("risk: emergency is reported per position side", () => {
  const long = { def: KABUF, qty: 1, entryValue: 88_000n, marginHeld: 1_914_000n, mark: 86_000, positionSide: "LONG" };
  const short = { def: KABUF, qty: -1, entryValue: 88_000n, marginHeld: 1_914_000n, mark: 86_000, positionSide: "SHORT" };
  const risk = assessFuturesRisk([long, short], { balance: 100_000_000n, debt: 0n });
  // 롱 평가손실 2,000만 ≥ 증거금 191.4만 × 90% → 롱만 긴급, 숏은 이익
  assert.deepEqual(risk.emergency, ["KABUF:LONG"]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd packages/shared && pnpm test`
Expected: FAIL — `applyHedgeFill`가 export되지 않음(SyntaxError: does not provide an export named ...).

- [ ] **Step 3: 구현** — `packages/shared/src/futures.ts`

`FuturePositionState` 인터페이스 바로 위에 추가:

```ts
/** 양방향(헤지) 포지션 방향. 사람 계정의 선물 주문·포지션은 LONG/SHORT, 봇·옵션은 NET(순포지션). */
export type FuturesPositionSide = "LONG" | "SHORT";
export type FuturesPositionRowSide = FuturesPositionSide | "NET";

export function isFuturesPositionSide(value: unknown): value is FuturesPositionSide {
  return value === "LONG" || value === "SHORT";
}

/** 양방향 주문의 뜻: 매수+LONG·매도+SHORT는 진입, 매도+LONG·매수+SHORT는 청산 */
export function isOpeningHedgeOrder(side: "BUY" | "SELL", positionSide: FuturesPositionSide): boolean {
  return (side === "BUY") === (positionSide === "LONG");
}

/** 그 방향 포지션을 닫는 주문 방향 */
export function hedgeCloseSide(positionSide: FuturesPositionSide): "BUY" | "SELL" {
  return positionSide === "LONG" ? "SELL" : "BUY";
}

/** 주문·조건부 주문 행의 position_side(null = 순포지션) → 포지션 행 방향 */
export function rowSideOf(positionSide: string | null | undefined): FuturesPositionRowSide {
  return isFuturesPositionSide(positionSide) ? positionSide : "NET";
}

/** 포지션 하나를 가리키는 키 — NET은 종목 코드 그대로(기존 위험 판정·알림과 호환) */
export function futuresPositionKey(symbol: string, positionSide: FuturesPositionRowSide): string {
  return positionSide === "NET" ? symbol : `${symbol}:${positionSide}`;
}
```

`applyFutureFill` 함수 바로 뒤에 추가:

```ts
/**
 * 양방향 포지션(LONG 행은 qty ≥ 0, SHORT 행은 qty ≤ 0)에 체결 하나를 적용한다.
 * 진입은 applyFutureFill과 같고, 청산은 보유만큼만 닫는다 — 반대 포지션을 열지 않는다.
 * 보유보다 많이 체결된 청산 수량은 overflow로 돌려준다(접수 단계에서 막히므로 정상이면 0).
 */
export function applyHedgeFill(
  def: Pick<FutureDef, "unitValue">,
  position: FuturePositionState,
  positionSide: FuturesPositionSide,
  side: "BUY" | "SELL",
  price: number,
  fillQty: number,
): FutureFillResult & { overflow: number } {
  if (isOpeningHedgeOrder(side, positionSide)) return { ...applyFutureFill(def, position, side, price, fillQty), overflow: 0 };
  const closeQty = Math.min(fillQty, Math.abs(position.qty));
  if (closeQty === 0) return { qty: position.qty, entryValue: position.entryValue, closedQty: 0, realized: 0n, overflow: fillQty };
  return { ...applyFutureFill(def, position, side, price, closeQty), overflow: fillQty - closeQty };
}
```

`FuturesRiskPosition`에 필드 추가:

```ts
  /** 포지션 행 방향 — 없으면 NET */
  positionSide?: FuturesPositionRowSide;
```

`FuturesRiskAssessment.emergency` 주석을 `/** 평가손실이 위탁증거금의 90%에 닿은 포지션 키(futuresPositionKey) */`로 바꾸고, `assessFuturesRisk` 안의 push를 바꾼다:

```ts
    if (p.marginHeld > 0n && -pnl * 10_000n >= p.marginHeld * BigInt(FUTURES_EMERGENCY_LOSS_BPS)) {
      emergency.push(futuresPositionKey(p.def.symbol, p.positionSide ?? "NET"));
    }
```

- [ ] **Step 4: 통과 확인**

Run: `cd packages/shared && pnpm test`
Expected: PASS (모든 node:test 통과, fail 0)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/futures.ts packages/shared/test/futures.node-test.mjs
git commit -m "feat: 선물 양방향 방향 타입·체결 적용·위험 판정 키"
```

---

### Task 2: DB — 스키마·마이그레이션·정합성 검사

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`model FuturesPosition`, `model Order`, `model ConditionalOrder`)
- Create: `packages/db/prisma/migrations/20260928090000_futures_hedge_mode/migration.sql`
- Modify: `packages/db/scripts/check-consistency.ts` (8번 검사 뒤)

**Interfaces:**
- Produces: Prisma 복합 키 `accountId_symbol_positionSide` (`{ accountId, symbol, positionSide }`), `FuturesPosition.positionSide: string`, `Order.positionSide: string | null`, `ConditionalOrder.positionSide: string | null`. 기존 `accountId_symbol` 키는 사라진다 — Task 3~6이 모든 사용처를 바꾼다.

- [ ] **Step 1: 스키마 수정**

`model FuturesPosition`:

```prisma
model FuturesPosition {
  accountId  String   @map("account_id")
  symbol     String
  /// LONG | SHORT(사람 계정 양방향 선물) | NET(봇·옵션 순포지션)
  positionSide String @default("NET") @map("position_side")
  qty        Int      @default(0)
  entryValue BigInt   @default(0) @map("entry_value")
  marginHeld BigInt   @default(0) @map("margin_held")
  /// 1~20배, null = 거래소 기준 증거금률. 같은 계좌·종목의 LONG·SHORT 행은 같은 값
  leverage   Int?
  updatedAt  DateTime @default(now()) @updatedAt @map("updated_at")

  @@id([accountId, symbol, positionSide])
  @@map("futures_positions")
  @@schema("account")
}
```

`model Order`의 `holdPerUnit` 아래와 `model ConditionalOrder`의 `limitPrice` 아래에 각각:

```prisma
  /// 양방향 선물 주문 방향 LONG | SHORT. null = 순포지션(봇·옵션·현물)
  positionSide String? @map("position_side")
```

- [ ] **Step 2: 마이그레이션 SQL 작성** — `packages/db/prisma/migrations/20260928090000_futures_hedge_mode/migration.sql`

```sql
-- 선물 양방향(헤지) 매매: 사람 계정은 롱·숏 포지션을 따로 둔다. 봇·옵션은 NET(순포지션).
-- 1) 주문·조건부 주문 방향 칸 (포지션 이전 전에 — 이전 전 순포지션으로 청산/진입을 판정한다)
ALTER TABLE "order"."orders" ADD COLUMN "position_side" TEXT;
ALTER TABLE "order"."conditional_orders" ADD COLUMN "position_side" TEXT;
ALTER TABLE "order"."orders" ADD CONSTRAINT "orders_position_side_check"
  CHECK ("position_side" IS NULL OR "position_side" IN ('LONG', 'SHORT'));
ALTER TABLE "order"."conditional_orders" ADD CONSTRAINT "conditional_orders_position_side_check"
  CHECK ("position_side" IS NULL OR "position_side" IN ('LONG', 'SHORT'));

-- 사람 계정의 살아 있는 선물 주문: 순포지션을 줄이고 잔량이 그 포지션 이내면 청산, 그 밖은 진입.
UPDATE "order"."orders" o
SET "position_side" = CASE WHEN o.side = 'BUY' THEN 'LONG' ELSE 'SHORT' END
FROM "account"."accounts" a
JOIN "auth"."users" u ON u.id = a.user_id
WHERE a.id = o.account_id AND u.is_bot = false
  AND o.symbol IN ('KABUF', 'USDF', 'OILF', 'GASF', 'CPRF', 'GOLDF', 'CORNF')
  AND o.status IN ('OPEN', 'PARTIAL');
UPDATE "order"."orders" o
SET "position_side" = CASE
  WHEN o.side = 'SELL' AND p.qty > 0 AND o.qty - o.filled_qty <= p.qty THEN 'LONG'
  WHEN o.side = 'BUY' AND p.qty < 0 AND o.qty - o.filled_qty <= -p.qty THEN 'SHORT'
  WHEN o.side = 'BUY' THEN 'LONG'
  ELSE 'SHORT'
END
FROM "account"."futures_positions" p
WHERE p.account_id = o.account_id AND p.symbol = o.symbol AND o.position_side IS NOT NULL
  AND o.status IN ('OPEN', 'PARTIAL');

-- 진입으로 바뀌었는데 증거금을 묶지 않은(청산으로 접수됐던) 주문은 취소 요청한다.
INSERT INTO "order"."outbox" ("event_id", "topic", "payload")
SELECT e.id, 'order.cancel.requested',
  jsonb_build_object('topic', 'order.cancel.requested', 'eventId', e.id, 'orderId', o.id, 'symbol', o.symbol,
                     'ts', (extract(epoch FROM now()) * 1000)::bigint)
FROM "order"."orders" o
CROSS JOIN LATERAL (SELECT gen_random_uuid()::text AS id) e
WHERE o.position_side IS NOT NULL AND o.status IN ('OPEN', 'PARTIAL') AND o.hold_per_unit = 0
  AND ((o.side = 'BUY' AND o.position_side = 'LONG') OR (o.side = 'SELL' AND o.position_side = 'SHORT'));

-- 사람 계정의 대기 중인 선물 조건부 주문은 늘 청산이다: 매도 = 롱 청산, 매수 = 숏 청산.
UPDATE "order"."conditional_orders" c
SET "position_side" = CASE WHEN c.side = 'SELL' THEN 'LONG' ELSE 'SHORT' END
FROM "account"."accounts" a
JOIN "auth"."users" u ON u.id = a.user_id
WHERE a.id = c.account_id AND u.is_bot = false
  AND c.symbol IN ('KABUF', 'USDF', 'OILF', 'GASF', 'CPRF', 'GOLDF', 'CORNF')
  AND c.status = 'WAITING';

-- 2) 포지션 방향 칸·기본키
ALTER TABLE "account"."futures_positions" ADD COLUMN "position_side" TEXT NOT NULL DEFAULT 'NET';
ALTER TABLE "account"."futures_positions" DROP CONSTRAINT "futures_positions_pkey";
UPDATE "account"."futures_positions" p
SET "position_side" = CASE WHEN p.qty < 0 THEN 'SHORT' ELSE 'LONG' END
FROM "account"."accounts" a
JOIN "auth"."users" u ON u.id = a.user_id
WHERE a.id = p.account_id AND u.is_bot = false
  AND p.symbol IN ('KABUF', 'USDF', 'OILF', 'GASF', 'CPRF', 'GOLDF', 'CORNF');
ALTER TABLE "account"."futures_positions"
  ADD CONSTRAINT "futures_positions_pkey" PRIMARY KEY ("account_id", "symbol", "position_side");
-- 레버리지 설정을 반대 방향 행에도 둔다(롱·숏이 같은 레버리지를 쓴다).
INSERT INTO "account"."futures_positions" ("account_id", "symbol", "position_side", "qty", "entry_value", "margin_held", "leverage", "updated_at")
SELECT account_id, symbol, CASE WHEN position_side = 'LONG' THEN 'SHORT' ELSE 'LONG' END, 0, 0, 0, leverage, now()
FROM "account"."futures_positions"
WHERE position_side IN ('LONG', 'SHORT')
ON CONFLICT DO NOTHING;
ALTER TABLE "account"."futures_positions" ADD CONSTRAINT "futures_positions_side_check" CHECK (
  ("position_side" = 'NET') OR ("position_side" = 'LONG' AND "qty" >= 0) OR ("position_side" = 'SHORT' AND "qty" <= 0)
);
```

첫 UPDATE는 사람 계정의 살아 있는 선물 주문을 모두 진입 방향으로 채우고, 두 번째 UPDATE가 순포지션 행이 있는 주문만 청산/진입을 다시 판정한다(이 시점의 포지션 행은 아직 옛 순포지션).

- [ ] **Step 3: 정합성 검사 추가** — `packages/db/scripts/check-consistency.ts`, 8번 검사(`futures position margin matches its entry value`) 바로 뒤

```ts
  // 9) 양방향 선물: 사람 계정은 선물을 LONG/SHORT 행에만, 봇 계정은 NET 행에만 둔다. 옵션은 늘 NET.
  const badSides = await prisma.$queryRaw<{ account_id: string; symbol: string; position_side: string; qty: number }[]>`
    SELECT p.account_id, p.symbol, p.position_side, p.qty
    FROM account.futures_positions p
    JOIN account.accounts a ON a.id = p.account_id
    JOIN auth.users u ON u.id = a.user_id
    WHERE p.qty <> 0 AND (
      (p.symbol IN (${Prisma.join(FUTURES.map((f) => f.symbol))}) AND u.is_bot = false AND p.position_side = 'NET')
      OR (u.is_bot = true AND p.position_side <> 'NET')
      OR (p.symbol NOT IN (${Prisma.join(FUTURES.map((f) => f.symbol))}) AND p.position_side <> 'NET')
    )
  `;
  check("futures position sides: humans hedge (LONG/SHORT), bots and options net", badSides.length === 0, badSides);
```

파일 상단 import에 `Prisma`(`@mock-kabu/db` 또는 이 스크립트가 쓰는 prisma 패키지에서)와 `FUTURES`(`@mock-kabu/shared`)가 없으면 추가한다. 이미 쓰는 import 줄을 확인해 같은 모듈에서 가져온다.

- [ ] **Step 4: 마이그레이션·클라이언트 생성 확인**

Run: `pnpm infra:up` (이미 떠 있으면 생략) → `pnpm --filter @mock-kabu/db exec prisma migrate deploy` → `pnpm --filter @mock-kabu/db exec prisma generate`
Expected: `20260928090000_futures_hedge_mode` 적용, generate 성공. (로컬 Redis 포트 예외는 `.claude/skills/verify/SKILL.md` 참고)

Run: `pnpm check:consistency`
Expected: 마지막 줄 `정합성 검사 전부 통과` (로컬 DB 기준. api 등 다른 코드는 아직 옛 키를 써 타입 오류가 날 수 있으나 이 스크립트는 독립 실행)

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260928090000_futures_hedge_mode packages/db/scripts/check-consistency.ts
git commit -m "feat: 선물 포지션·주문에 양방향 방향 칸(마이그레이션·정합성 검사)"
```

---

### Task 3: API 주문 접수 — positionSide 검증·청산 가능 수량·증거금

**Files:**
- Modify: `apps/api/src/order/futures-margin.ts` (`futuresOrderHoldPerUnit`, `isBotAccount` export)
- Modify: `apps/api/src/order/order.service.ts` (`PlaceOrderDto`, `place`, `amend`)
- Test: `apps/api/src/futures/__tests__/leverage.test.ts`, `apps/api/src/order/__tests__/order.service.test.ts`

**Interfaces:**
- Consumes: Task 1 `isFuturesPositionSide`, `isOpeningHedgeOrder`, `hedgeCloseSide`, `FuturesPositionSide`, `FuturesPositionRowSide`; Task 2 `accountId_symbol_positionSide`, `Order.positionSide`.
- Produces:
  - `PlaceOrderDto.positionSide?: FuturesPositionSide`
  - `futuresOrderHoldPerUnit(db, accountId, def, side, qty, priceUnits, positionSide: FuturesPositionSide | null = null): Promise<bigint>` — positionSide가 있으면 진입=증거금, 청산=0(초과면 422)
  - `export async function isBotAccount(db, accountId): Promise<boolean>` (futures-margin.ts)

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/src/futures/__tests__/leverage.test.ts`의 `db()` 헬퍼는 그대로 두고 `describe("futures order hold"` 안에 추가:

```ts
  it("hedge orders: opening holds margin, closing within the side's position holds nothing", async () => {
    // 롱 진입은 그 방향 포지션과 상관없이 증거금
    expect(await futuresOrderHoldPerUnit(db({ qty: 0, leverage: 20 }), "a", USDF, "BUY", 1, 14_000, "LONG")).toBe(700_000n);
    // 숏 진입(매도)도 증거금 — 롱을 들고 있어도 롱을 줄이지 않는다
    expect(await futuresOrderHoldPerUnit(db({ qty: 0, leverage: 20 }), "a", USDF, "SELL", 2, 14_000, "SHORT")).toBe(700_000n);
    // 숏 −3에서 숏 청산(매수) 3 → 0
    expect(await futuresOrderHoldPerUnit(db({ qty: -3, leverage: 20 }), "a", USDF, "BUY", 3, 14_000, "SHORT")).toBe(0n);
  });

  it("hedge closing beyond the side's closable quantity is rejected, not turned into an opening order", async () => {
    await expect(futuresOrderHoldPerUnit(db({ qty: 3, leverage: 20 }), "a", USDF, "SELL", 4, 14_000, "LONG")).rejects.toThrow(/청산 가능 수량이 부족/);
    const pending = [{ qty: 2, filledQty: 0 }];
    await expect(futuresOrderHoldPerUnit(db({ qty: 3, leverage: 20 }, pending), "a", USDF, "SELL", 2, 14_000, "LONG")).rejects.toThrow(/청산 가능 수량이 부족/);
    await expect(futuresOrderHoldPerUnit(db(null), "a", USDF, "BUY", 1, 14_000, "SHORT")).rejects.toThrow(/청산 가능 수량이 부족/);
  });
```

`apps/api/src/order/__tests__/order.service.test.ts`의 `describe("OrderService.place for futures"`에서:
1. `harness`에 `isBot = false` 인자를 추가하고 tx에 계좌·사용자 조회를 넣는다:

```ts
  function harness(balance: bigint, holdAmount = 0n, positionMargin = 0n, debt = 0n, isBot = false) {
    ...
    const tx = {
      $queryRawUnsafe: vi.fn(async () => [{ isBot }]),
      account: { findUnique: vi.fn(async () => ({ userId: "u" })) },
      user: { findUnique: vi.fn(async () => ({ isBot })) },
      ...기존 필드 그대로
    };
```

2. 이 describe 안의 기존 선물(`KABUF`) `service.place` 호출에 방향을 넣는다: `side: "BUY"`면 `positionSide: "LONG"`, `side: "SELL"`면 `positionSide: "SHORT"`. (예: `{ symbol: "KABUF", side: "SELL", type: "LIMIT", price: 88_000, qty: 2, positionSide: "SHORT" }`) 수수료 테스트 루프의 `for (const side of ["BUY", "SELL"] as const)`는 `positionSide: side === "BUY" ? "LONG" : "SHORT"`. 봇 경로(`bot.tx.$queryRawUnsafe.mockResolvedValue([{ isBot: true }])`)는 `harness(10_000_000n, 0n, 0n, 0n, true)`로 만들고 `positionSide`를 빼고 부른다(현물 `KABU` 호출은 그대로).
3. 새 테스트 추가:

```ts
  it("requires a position side on a human futures order and rejects one from a bot or on spot", async () => {
    const human = harness(100_000_000n);
    await expect(human.service.place("a", { symbol: "KABUF", side: "BUY", type: "LIMIT", price: 88_000, qty: 1 })).rejects.toThrow(/롱\/숏 방향이 필요/);
    const bot = harness(100_000_000n, 0n, 0n, 0n, true);
    await expect(
      bot.service.place("a", { symbol: "KABUF", side: "BUY", type: "LIMIT", price: 88_000, qty: 1, positionSide: "LONG" }),
    ).rejects.toThrow(/봇 계정은/);
    await expect(
      human.service.place("a", { symbol: "KABU", side: "BUY", type: "LIMIT", price: 100_000, qty: 1, positionSide: "LONG" }),
    ).rejects.toThrow(/선물 주문에만/);
    await expect(
      human.service.place("a", { symbol: "KABUF", side: "BUY", type: "LIMIT", price: 88_000, qty: 1, positionSide: "UP" as never }),
    ).rejects.toThrow(/LONG\/SHORT/);
  });

  it("stores the position side on the order row", async () => {
    const { service, created } = harness(100_000_000n);
    await service.place("a", { symbol: "KABUF", side: "SELL", type: "LIMIT", price: 88_000, qty: 1, positionSide: "SHORT" });
    expect(created[0].positionSide).toBe("SHORT");
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd apps/api && npx vitest run src/futures/__tests__/leverage.test.ts src/order/__tests__/order.service.test.ts`
Expected: FAIL — 새 테스트들(`청산 가능 수량이 부족`, `롱/숏 방향이 필요`)과, 기존 선물 테스트는 `positionSide`가 무시돼 `created[0].positionSide` undefined.

- [ ] **Step 3: 구현 — `apps/api/src/order/futures-margin.ts`**

import에 `isOpeningHedgeOrder, type FuturesPositionSide`를 더하고, `futuresOrderHoldPerUnit`를 바꾼다:

```ts
export async function futuresOrderHoldPerUnit(
  db: { [key: string]: any },
  accountId: string,
  def: FutureDef,
  side: OrderSide,
  qty: number,
  priceUnits: number,
  /** 양방향 주문 방향(사람 계정). null이면 순포지션(봇) */
  positionSide: FuturesPositionSide | null = null,
): Promise<bigint> {
  const position = (await db.futuresPosition.findUnique({
    where: { accountId_symbol_positionSide: { accountId, symbol: def.symbol, positionSide: positionSide ?? "NET" } },
  })) as { qty: number; leverage: number | null } | null;
  const held = position?.qty ?? 0;
  if (positionSide != null) {
    // 양방향: 진입은 늘 증거금, 청산은 그 방향 보유 − 걸린 청산 미체결 이내만(넘으면 거절 — 반대 포지션을 열지 않는다)
    if (isOpeningHedgeOrder(side, positionSide)) return futureMarginPerContract(def, priceUnits, position?.leverage ?? null);
    const pending = (await db.order.findMany({
      where: { accountId, symbol: def.symbol, side, positionSide, status: { in: ["OPEN", "PARTIAL"] } },
      select: { qty: true, filledQty: true },
    })) as { qty: number; filledQty: number }[];
    const reserved = pending.reduce((sum, order) => sum + (order.qty - order.filledQty), 0);
    if (qty > Math.abs(held) - reserved) throw new UnprocessableEntityException("청산 가능 수량이 부족합니다");
    return 0n;
  }
  const closing = (side === "SELL" && held > 0) || (side === "BUY" && held < 0);
  if (closing) {
    const pending = (await db.order.findMany({
      where: { accountId, symbol: def.symbol, side, status: { in: ["OPEN", "PARTIAL"] }, holdPerUnit: 0n },
      select: { qty: true, filledQty: true },
    })) as { qty: number; filledQty: number }[];
    const reserved = pending.reduce((sum, order) => sum + (order.qty - order.filledQty), 0);
    if (qty <= Math.abs(held) - reserved) return 0n;
  }
  return futureMarginPerContract(def, priceUnits, position?.leverage ?? null);
}
```

파일 끝의 `async function isBotAccount`를 `export async function isBotAccount`로 바꾼다. 문서 주석 첫 줄(`선물 주문 한 건의 계약당 홀드(원).`) 아래에 `양방향(positionSide 있음): 진입 = 위탁증거금, 청산 = 0(청산 가능 수량 초과는 422).` 한 줄을 추가한다.

- [ ] **Step 4: 구현 — `apps/api/src/order/order.service.ts`**

import: `@mock-kabu/shared`에서 `isFuturesPositionSide, type FuturesPositionSide`를, `./futures-margin`에서 `isBotAccount`를 추가.

`PlaceOrderDto`에:

```ts
  /** 양방향 선물 주문 방향(사람 계정 필수, 봇·옵션·현물은 없음) */
  positionSide?: FuturesPositionSide;
```

`place()`에서 `const option = optionDef(symbol);` 다음 검증 블록(`if ((future || option) && qty > MAX_FUTURES_ORDER_QTY)`) 바로 뒤에:

```ts
    const positionSide = dto.positionSide ?? null;
    if (positionSide != null && !isFuturesPositionSide(positionSide)) throw new BadRequestException("positionSide는 LONG/SHORT");
    if (positionSide != null && !future) throw new BadRequestException("롱/숏 방향은 선물 주문에만 씁니다");
```

(`future` 변수 이름은 파일에서 `futureDef(symbol)` 결과를 담는 이름을 그대로 쓴다.)

계좌 락 안의 `if (future) { holdPerUnit = await futuresOrderHoldPerUnit(...) }`를 바꾼다:

```ts
      if (future) {
        const bot = await isBotAccount(ctx.tx, accountId);
        if (!bot && positionSide == null) throw new BadRequestException("선물 주문은 롱/숏 방향이 필요합니다");
        if (bot && positionSide != null) throw new BadRequestException("봇 계정은 롱/숏 방향 없이 주문합니다");
        holdPerUnit = await futuresOrderHoldPerUnit(ctx.tx, accountId, future, side, qty, type === "LIMIT" ? price! : marketCap, positionSide);
      } else if (option) {
```

`ctx.tx.order.create({ data: { accountId, symbol, side, type, price, qty, holdPerUnit } })`에 `positionSide`를 넣는다:

```ts
      const order = await ctx.tx.order.create({
        data: { accountId, symbol, side, type, price, qty, holdPerUnit, positionSide },
      });
```

`amend()`의 재접수에 방향을 이어 준다:

```ts
    const placed = await this.place(accountId, {
      symbol: order.symbol,
      side: order.side as OrderSide,
      type: "LIMIT",
      price,
      qty: nextQty,
      ...(order.positionSide ? { positionSide: order.positionSide as FuturesPositionSide } : {}),
    });
```

- [ ] **Step 5: 통과 확인**

Run: `cd apps/api && npx vitest run src/futures/__tests__/leverage.test.ts src/order/__tests__/order.service.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/order/futures-margin.ts apps/api/src/order/order.service.ts apps/api/src/futures/__tests__/leverage.test.ts apps/api/src/order/__tests__/order.service.test.ts
git commit -m "feat: 선물 주문 접수에 롱/숏 방향·청산 가능 수량 검사"
```

---

### Task 4: 체결 정산 — 방향 포지션에 적용 (settlement)

**Files:**
- Modify: `apps/settlement/src/futures.ts` (`Leg`, `settleFuturesTrade`)
- Modify: `apps/settlement/src/options.ts` (포지션 키를 NET으로)
- Test: `apps/settlement/src/futures.test.ts`, `apps/settlement/src/options.test.ts`, `apps/settlement/src/trading-fees.test.ts`(포지션 키를 흉내 내는 곳만)

**Interfaces:**
- Consumes: Task 1 `applyHedgeFill`, `rowSideOf`, `FuturesPositionRowSide`; Task 2 키 `accountId_symbol_positionSide`.
- Produces: `settleFuturesTrade`의 주문 인자 타입에 `positionSide?: string | null`.

- [ ] **Step 1: 테스트 헬퍼를 새 키로 바꾸고 실패하는 테스트 추가** — `apps/settlement/src/futures.test.ts`

`fakeContext`의 `key`를:

```ts
  const key = (w: { accountId_symbol_positionSide: { accountId: string; symbol: string; positionSide: string } }) =>
    `${w.accountId_symbol_positionSide.accountId}:${w.accountId_symbol_positionSide.symbol}:${w.accountId_symbol_positionSide.positionSide}`;
```

기존 테스트가 `positions.get("A:KABUF")`처럼 읽는 곳은 `positions.get("A:KABUF:NET")`로 바꾼다(기존 테스트는 순포지션 경로 그대로). `order()` 헬퍼에 방향 인자를 추가:

```ts
function order(price: number, qty: number, positionSide: string | null = null) {
  return { id: "o", holdPerUnit: futureMarginPerContract(KABUF, price), status: "OPEN", qty, filledQty: 0, positionSide };
}
```

새 테스트(파일의 `describe("futures settlement"` 안):

```ts
  it("hedge: a long open never touches the same account's short", async () => {
    const f = fakeContext({ A: { balance: 100_000_000n, holdAmount: 0n }, B: { balance: 100_000_000n, holdAmount: 0n } });
    f.positions.set("A:KABUF:SHORT", { qty: -2, entryValue: 176_000n, marginHeld: futurePositionMargin(KABUF, 176_000n) });
    const event = trade(88_000, 1);
    f.accounts.A.holdAmount += futureMarginPerContract(KABUF, 88_000);
    await settleFuturesTrade(f.ctx, KABUF, event, order(88_000, 1, "LONG"), { ...order(88_000, 1), holdPerUnit: 0n });
    expect(f.positions.get("A:KABUF:SHORT")!.qty).toBe(-2);
    expect(f.positions.get("A:KABUF:LONG")!.qty).toBe(1);
    expect(f.positions.get("A:KABUF:LONG")!.marginHeld).toBe(futurePositionMargin(KABUF, 88_000n));
  });

  it("hedge: closing part of a short realizes P&L on that side only", async () => {
    const f = fakeContext({ A: { balance: 100_000_000n, holdAmount: 0n }, B: { balance: 100_000_000n, holdAmount: 0n } });
    f.positions.set("A:KABUF:SHORT", { qty: -3, entryValue: 264_000n, marginHeld: futurePositionMargin(KABUF, 264_000n) });
    f.positions.set("A:KABUF:LONG", { qty: 2, entryValue: 176_000n, marginHeld: futurePositionMargin(KABUF, 176_000n) });
    // A가 숏 청산(매수) 1 @ 87,000 — 88,000에 판 숏이라 +1,000pt×1×10,000원 = +10,000,000원. B는 순포지션 숏 진입.
    f.accounts.B.holdAmount += futureMarginPerContract(KABUF, 87_000);
    await settleFuturesTrade(f.ctx, KABUF, trade(87_000, 1), { ...order(87_000, 1, "SHORT"), holdPerUnit: 0n }, order(87_000, 1));
    expect(f.positions.get("A:KABUF:SHORT")!.qty).toBe(-2);
    expect(f.positions.get("A:KABUF:LONG")!.qty).toBe(2);
    expect(f.realized.filter((r) => r.accountId === "A").map((r) => r.realized)).toEqual([10_000_000n]);
  });

  it("hedge: one account's long open and short open matched together land on separate rows", async () => {
    const f = fakeContext({ A: { balance: 100_000_000n, holdAmount: 0n } });
    f.accounts.A.holdAmount += futureMarginPerContract(KABUF, 88_000) * 2n;
    await settleFuturesTrade(f.ctx, KABUF, trade(88_000, 1, "A", "A"), order(88_000, 1, "LONG"), order(88_000, 1, "SHORT"));
    expect(f.positions.get("A:KABUF:LONG")!.qty).toBe(1);
    expect(f.positions.get("A:KABUF:SHORT")!.qty).toBe(-1);
  });
```

수수료 작업 때문에 `settleTradingFees`가 `ctx.tx.$queryRawUnsafe` 등을 부르면, 기존 테스트가 이미 그 모양을 흉내 내고 있으니 새 테스트도 같은 `fakeContext`를 쓰면 된다. 없으면 기존 테스트가 쓰는 방법(예: `vi.spyOn(Date, "now")`로 수수료 시행 전 시각)을 그대로 따른다.

`apps/settlement/src/options.test.ts`, `apps/settlement/src/trading-fees.test.ts`에서 `accountId_symbol`로 키를 만드는 가짜 컨텍스트가 있으면 같은 방식으로 `accountId_symbol_positionSide`(positionSide `"NET"`)로 바꾼다.

- [ ] **Step 2: 실패 확인**

Run: `cd apps/settlement && npx vitest run src/futures.test.ts src/options.test.ts`
Expected: FAIL — 정산 코드가 아직 `accountId_symbol` 키를 써 `where.accountId_symbol_positionSide`가 undefined(TypeError).

- [ ] **Step 3: 구현 — `apps/settlement/src/futures.ts`**

import에 `applyHedgeFill, rowSideOf`를 더한다. `Leg`의 order 타입과 `settleFuturesTrade` 인자:

```ts
interface Leg {
  accountId: string;
  side: "BUY" | "SELL";
  order: { id: string; holdPerUnit: bigint; status: string; qty: number; filledQty: number; positionSide?: string | null };
}
```

루프 안 포지션 부분을 바꾼다:

```ts
  for (const leg of legs) {
    // 사람 계정의 양방향 주문은 그 방향 행(LONG/SHORT), 봇 주문은 순포지션 행(NET).
    const positionSide = rowSideOf(leg.order.positionSide);
    const where = { accountId_symbol_positionSide: { accountId: leg.accountId, symbol: event.symbol, positionSide } };
    const existing = await ctx.tx.futuresPosition.findUnique({ where });
    const before = existing
      ? { qty: existing.qty as number, entryValue: existing.entryValue as bigint }
      : { qty: 0, entryValue: 0n };
    const fill =
      positionSide === "NET"
        ? applyFutureFill(def, before, leg.side, event.price, event.qty)
        : applyHedgeFill(def, before, positionSide, leg.side, event.price, event.qty);
    if ("overflow" in fill && fill.overflow > 0) {
      // 접수 단계(청산 가능 수량 검사)가 막으므로 정상이면 일어나지 않는다. 반대 포지션을 열지 않고 기록만 남긴다.
      console.warn(`[settlement] hedge close overflow ${leg.accountId} ${event.symbol} ${positionSide}: ${fill.overflow} (trade ${event.tradeId})`);
    }
    const leverage = (existing?.leverage as number | null | undefined) ?? null;
    const marginHeld = fill.qty === 0 ? 0n : futurePositionMargin(def, fill.entryValue, leverage);
    await ctx.tx.futuresPosition.upsert({
      where,
      update: { qty: fill.qty, entryValue: fill.entryValue, marginHeld },
      create: { accountId: leg.accountId, symbol: event.symbol, positionSide, qty: fill.qty, entryValue: fill.entryValue, marginHeld },
    });
```

(그 아래 `futuresRealized.create`, 증거금 해제, 현금 처리는 그대로.)

- [ ] **Step 4: 구현 — `apps/settlement/src/options.ts`**

`const where = { accountId_symbol: { accountId: leg.accountId, symbol: event.symbol } };`를

```ts
    const where = { accountId_symbol_positionSide: { accountId: leg.accountId, symbol: event.symbol, positionSide: "NET" } };
```

로 바꾼다(옵션은 늘 순포지션. upsert create는 DB 기본값 NET).

- [ ] **Step 5: 통과 확인**

Run: `cd apps/settlement && npx vitest run && npx tsc --noEmit -p .`
Expected: 모든 테스트 PASS, 타입 오류 없음

- [ ] **Step 6: Commit**

```bash
git add apps/settlement/src/futures.ts apps/settlement/src/options.ts apps/settlement/src/futures.test.ts apps/settlement/src/options.test.ts apps/settlement/src/trading-fees.test.ts
git commit -m "feat: 선물 체결 정산을 롱/숏 방향 포지션에 적용"
```

---

### Task 5: API 포지션 조회·레버리지·일일 정산·반대매매

**Files:**
- Modify: `apps/api/src/futures/futures.service.ts` (`positions`, `setLeverage`)
- Modify: `apps/api/src/futures/futures-settlement.service.ts` (`settle` 루프, `settlePosition`, `settleOptionPosition` 키)
- Modify: `apps/api/src/futures/futures-risk.service.ts` (`tick`, `liquidate`)
- Modify: `apps/api/src/futures/options.service.ts` (키를 쓰는 곳이 있으면 NET)
- Test: `apps/api/src/futures/__tests__/leverage.test.ts`, `apps/api/src/futures/__tests__/futures-settlement.service.test.ts`, `apps/api/src/futures/__tests__/futures-risk.service.test.ts`

**Interfaces:**
- Consumes: Task 1 `futuresPositionKey`, `rowSideOf`, `FuturesPositionRowSide`; Task 3 `isBotAccount`.
- Produces: `/account/futures`의 `positions[]` 행에 `positionSide: "LONG" | "SHORT" | "NET"`, `closableQty: number`.

- [ ] **Step 1: 실패하는 테스트 작성**

`leverage.test.ts`의 `describe("setting leverage"`에 있는 `service()` 가짜 DB를 새 구현에 맞게 바꾼다 — `findUnique` 대신 `findMany`(그 종목 행들)와 봇 판정 조회를 준다:

```ts
  function service(position: { qty: number } | null, liveOrders = 0, isBot = false) {
    const saved: { where: unknown; update: unknown; create: unknown }[] = [];
    const tx = {
      futuresPosition: {
        findMany: async () => (position ? [position] : []),
        upsert: async (args: { where: unknown; update: unknown; create: unknown }) => saved.push(args),
      },
      order: { count: async () => liveOrders },
      account: { findUnique: async () => ({ userId: "u" }) },
      user: { findUnique: async () => ({ isBot }) },
    };
    const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    return { svc: new FuturesService(prisma as never, {} as never), saved };
  }
```

(기존 describe의 테스트가 `saved`를 검사하는 방식이 다르면 그 검사를 새 모양에 맞춘다.) 새 테스트:

```ts
  it("stores the leverage on both hedge sides for a person, and on the net row for a bot", async () => {
    const human = service(null);
    await human.svc.setLeverage("a", "USDF", 10);
    expect(human.saved.map((s) => (s.where as any).accountId_symbol_positionSide.positionSide)).toEqual(["LONG", "SHORT"]);
    const bot = service(null, 0, true);
    await bot.svc.setLeverage("a", "USDF", 10);
    expect(bot.saved.map((s) => (s.where as any).accountId_symbol_positionSide.positionSide)).toEqual(["NET"]);
  });

  it("refuses to change leverage while either side holds a position", async () => {
    await expect(service({ qty: -1 }).svc.setLeverage("a", "USDF", 10)).rejects.toThrow(/포지션이 있는 동안/);
  });
```

`futures-settlement.service.test.ts`: 이 파일의 가짜 `futuresPosition.findMany`가 돌려주는 포지션 행에 `positionSide`를 넣고, `findUnique`/`update`가 `accountId_symbol` 키를 읽는 곳을 `accountId_symbol_positionSide`로 바꾼다. 새 테스트(파일의 기존 서비스 생성 헬퍼를 그대로 써서):

```ts
  it("settles a person's long and short on the same contract separately", async () => {
    // 헬퍼로 A 계정에 KABUF LONG 2 @ 88,000, SHORT −1 @ 89,000 을 두고 결제가 88,500으로 settle()
    // 기대: 두 행 모두 qty 0, futures_realized 2행(롱 +2 × 500 × 10,000 = +10,000,000, 숏 +1 × 500 × 10,000 = +5,000,000),
    //       processed_events 키 "futures-settle:KABUF:<day>:A:LONG" 와 ":SHORT"
  });
```

이 테스트 본문은 파일의 기존 "settles open positions" 류 테스트를 복사해 포지션 두 행과 위 기대값으로 채운다(헬퍼 이름·모양이 파일마다 달라 여기서 그대로 옮길 수 없다 — 기존 테스트 하나를 복제해 행만 바꾼다).

`futures-risk.service.test.ts`: 새 테스트 — 한 계좌에 같은 종목 LONG(손실 90% 초과)과 SHORT(이익)를 두고 `tick()` → `order.create`가 한 번, `{ side: "SELL", qty: <롱 수량>, positionSide: "LONG" }`으로 불렸는지 검사. 가짜 prisma는 파일의 기존 긴급 반대매매 테스트를 복제해 포지션 행에 `positionSide`를 넣어 만든다.

- [ ] **Step 2: 실패 확인**

Run: `cd apps/api && npx vitest run src/futures`
Expected: FAIL — `setLeverage`가 아직 `findUnique`/`accountId_symbol`을 쓴다.

- [ ] **Step 3: 구현 — `futures.service.ts`**

import에 `rowSideOf`, `isFuturesPositionSide`, `hedgeCloseSide`를(shared), `isBotAccount`를(`../order/futures-margin`) 더한다.

`positions()`의 Promise.all에 살아 있는 청산 미체결 조회를 더한다:

```ts
    const [positionRows, marks, encumbrance, account, marginCall, liquidations, liveOrders] = await Promise.all([
      ...기존 6개...,
      this.prisma.order.findMany({
        where: { accountId, symbol: { in: FUTURES.map((f) => f.symbol) }, status: { in: ["OPEN", "PARTIAL"] }, holdPerUnit: 0n },
        select: { symbol: true, side: true, positionSide: true, qty: true, filledQty: true },
      }),
    ]);
```

행 매핑에 방향과 청산 가능 수량을 넣는다:

```ts
      const positionSide = position.positionSide as "LONG" | "SHORT" | "NET";
      const closeSide = positionSide === "NET" ? (qty > 0 ? "SELL" : "BUY") : hedgeCloseSide(positionSide);
      const reserved = liveOrders
        .filter((o) => o.symbol === position.symbol && o.side === closeSide && rowSideOf(o.positionSide) === positionSide)
        .reduce((sum, o) => sum + (o.qty - o.filledQty), 0);
      return {
        symbol: position.symbol,
        positionSide,
        qty,
        closableQty: Math.max(0, Math.abs(qty) - reserved),
        ...기존 필드(avgPrice, markPrice, unrealized, marginHeld, maintenanceMargin, leverage)...
      };
```

`setLeverage`의 `apply`를 바꾼다:

```ts
    const apply = async (tx: { [key: string]: any }) => {
      const rows = (await tx.futuresPosition.findMany({ where: { accountId, symbol } })) as { qty: number }[];
      if (rows.some((row) => row.qty !== 0)) {
        throw new UnprocessableEntityException("포지션이 있는 동안에는 레버리지를 바꿀 수 없습니다. 청산한 뒤 바꿔 주세요");
      }
      const live = await tx.order.count({ where: { accountId, symbol, status: { in: ["OPEN", "PARTIAL"] } } });
      if (live > 0) throw new UnprocessableEntityException("미체결 주문이 있는 동안에는 레버리지를 바꿀 수 없습니다");
      // 사람 계정은 롱·숏이 같은 레버리지를 쓰도록 두 방향 행에 모두, 봇은 순포지션 행에.
      const sides = (await isBotAccount(tx, accountId)) ? (["NET"] as const) : (["LONG", "SHORT"] as const);
      for (const positionSide of sides) {
        await tx.futuresPosition.upsert({
          where: { accountId_symbol_positionSide: { accountId, symbol, positionSide } },
          update: { leverage },
          create: { accountId, symbol, positionSide, qty: 0, entryValue: 0n, marginHeld: 0n, leverage },
        });
      }
    };
```

- [ ] **Step 4: 구현 — `futures-settlement.service.ts`**

`settle()`의 선물 루프에서 `settlePosition` 호출에 방향을 넘긴다:

```ts
        const realized = await this.settlePosition(def, tradingDay, price, position.accountId, position.positionSide as FuturesPositionRowSide);
```

`settlePosition` 시그니처와 키:

```ts
  private async settlePosition(
    def: FutureDef,
    tradingDay: string,
    price: number,
    accountId: string,
    positionSide: FuturesPositionRowSide = "NET",
  ): Promise<bigint | null> {
    // NET은 예전 키 그대로(이미 정산한 거래일을 다시 정산하지 않게), 양방향 행은 방향을 붙인다.
    const eventId = `futures-settle:${def.symbol}:${tradingDay}:${accountId}${positionSide === "NET" ? "" : `:${positionSide}`}`;
    ...
      const where = { accountId_symbol_positionSide: { accountId, symbol: def.symbol, positionSide } };
```

알림 payload에 `positionSide`를 더한다(`{ type: "futures_settled", symbol, positionSide, tradingDay, price, realized }`). `settleOptionPosition`의 `where`는 `{ accountId_symbol_positionSide: { accountId, symbol: def.symbol, positionSide: "NET" } }`. import에 `type FuturesPositionRowSide`.

- [ ] **Step 5: 구현 — `futures-risk.service.ts`**

import에 `futuresPositionKey, rowSideOf, type FuturesPositionRowSide`.

`riskPositions` 매핑에 방향을 넣는다:

```ts
          return def && mark
            ? [{ def, qty: p.qty, entryValue: p.entryValue, marginHeld: p.marginHeld, mark, leverage: p.leverage, positionSide: rowSideOf(p.positionSide) }]
            : [];
```

긴급 대상:

```ts
        const targets = riskPositions
          .filter((p) => risk.emergency.includes(futuresPositionKey(p.def.symbol, p.positionSide ?? "NET")))
          .map((p) => ({ symbol: p.def.symbol, qty: p.qty, mark: p.mark, positionSide: p.positionSide ?? "NET" }));
```

알림 `symbols: risk.emergency`는 그대로 둔다(NET은 종목 코드, 양방향은 `KABUF:LONG`). 기한 초과 대상도 `positionSide: p.positionSide ?? "NET"`을 싣는다.

`liquidate`의 target 타입에 `positionSide: FuturesPositionRowSide`를 더하고 주문 생성:

```ts
        const order = await tx.order.create({
          data: {
            accountId, symbol: target.symbol, side, type: "MARKET", price: null, qty, holdPerUnit: 0n,
            positionSide: target.positionSide === "NET" ? null : target.positionSide,
          },
        });
```

(청산 방향 `side`는 지금처럼 qty 부호로 — 롱 행은 +라 SELL, 숏 행은 −라 BUY.)

- [ ] **Step 6: options.service.ts 확인**

Run: `grep -n "accountId_symbol" apps/api/src -r`
Expected: 결과 없음. 남아 있으면 옵션 경로는 `positionSide: "NET"`, 선물은 해당 행 방향으로 바꾼다.

- [ ] **Step 7: 통과 확인**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit -p .`
Expected: 모든 테스트 PASS, 타입 오류 없음

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/futures
git commit -m "feat: 선물 포지션 조회·레버리지·일일 정산·반대매매를 롱/숏 방향별로"
```

---

### Task 6: 조건부 주문(손절·익절) 방향별

**Files:**
- Modify: `apps/api/src/order/conditional-order.service.ts` (`place`, `placeOco`, `futuresClosable`, `assertFuturesClosing`, 발동, `sweepOrphanFutures`)
- Test: 조건부 주문 테스트 파일(`apps/api/src/order/__tests__/` 아래 `conditional` 이름의 파일)

**Interfaces:**
- Consumes: Task 3 `isBotAccount`, `OrderService.place`의 `positionSide`; Task 1 `rowSideOf`.
- Produces: `ConditionalOrder.positionSide` 저장·발동 시 전달. API 요청 모양은 그대로(사람 계정 선물: 매도 = 롱 청산, 매수 = 숏 청산으로 서버가 정한다).

- [ ] **Step 1: 실패하는 테스트 작성** — 조건부 주문 테스트 파일에서 선물 예약을 만드는 기존 테스트를 복제해 두 개 추가:

1. 사람 계정, KABUF LONG 행 qty 3, SHORT 행 qty −2 인 상태에서 `place(accountId, { symbol: "KABUF", side: "BUY", qty: 2, direction: "AT_OR_ABOVE", triggerPrice: <현재가 위> })` → 생성된 행 `positionSide === "SHORT"`. `qty: 3`이면 `/청산할 수 있는 수량은 2계약/` 로 거절.
2. 발동: 위 예약 행(`positionSide: "SHORT"`)을 발동시키면 `orders.place`가 `{ symbol: "KABUF", side: "BUY", type: "MARKET", qty: 2, positionSide: "SHORT" }`로 불린다.

가짜 prisma의 `futuresPosition.findUnique`는 `where.accountId_symbol_positionSide.positionSide`로 행을 고르게, `account.findUnique`/`user.findUnique`는 `{ userId: "u" }`/`{ isBot: false }`를 돌려주게 만든다.

- [ ] **Step 2: 실패 확인**

Run: `cd apps/api && npx vitest run src/order`
Expected: FAIL — `positionSide` 미저장, 발동 시 전달 없음.

- [ ] **Step 3: 구현**

import에 `rowSideOf`(shared), `isBotAccount`(`./futures-margin`).

클래스에 도우미 추가:

```ts
  /** 선물 예약의 방향: 사람 계정은 늘 청산이라 매도 = 롱, 매수 = 숏. 봇·선물 아님은 null. */
  private async hedgeSideFor(accountId: string, symbol: string, side: OrderSide): Promise<"LONG" | "SHORT" | null> {
    if (!futureDef(symbol)) return null;
    if (await isBotAccount(this.prisma, accountId)) return null;
    return side === "SELL" ? "LONG" : "SHORT";
  }
```

`futuresClosable`을 방향을 받도록:

```ts
  private async futuresClosable(accountId: string, symbol: string, side: OrderSide, positionSide: string | null): Promise<number | null> {
    if (!futureDef(symbol)) return null;
    const position = await this.prisma.futuresPosition.findUnique({
      where: { accountId_symbol_positionSide: { accountId, symbol, positionSide: rowSideOf(positionSide) } },
      select: { qty: true },
    });
    const held = position?.qty ?? 0;
    if (positionSide != null) return Math.abs(held);
    return side === "SELL" ? Math.max(0, held) : Math.max(0, -held);
  }
```

`assertFuturesClosing(accountId, symbol, side, qty, positionSide)`로 인자를 늘려 `futuresClosable`에 넘긴다. `place()`와 OCO 등록 함수 안에서:

```ts
    const positionSide = await this.hedgeSideFor(accountId, symbol, side);
    await this.assertFuturesClosing(accountId, symbol, side, qty, positionSide);
```

그리고 `conditionalOrder.create`의 `data`에 `positionSide`를 넣는다(OCO는 두 행 모두). 발동 부분:

```ts
      const closable = await this.futuresClosable(row.accountId, row.symbol, row.side, row.positionSide ?? null);
      ...
        const order = await this.orders.place(row.accountId, {
          symbol: row.symbol,
          side: row.side,
          type: row.orderType,
          qty,
          ...(row.orderType === "LIMIT" && row.limitPrice != null ? { price: row.limitPrice } : {}),
          ...(row.positionSide ? { positionSide: row.positionSide as "LONG" | "SHORT" } : {}),
        });
```

`sweepOrphanFutures`: 제네릭 타입에 `positionSide: string | null`을 더하고, 조회 `select`에 `positionSide`, 키를 방향까지:

```ts
    const held = new Map(positions.map((p) => [`${p.accountId}|${p.symbol}|${p.positionSide}`, p.qty]));
    const orphans = futures.filter((row) => {
      const side = rowSideOf(row.positionSide);
      const qty = held.get(`${row.accountId}|${row.symbol}|${side}`) ?? 0;
      if (side !== "NET") return qty === 0;
      return row.side === "SELL" ? qty <= 0 : qty >= 0;
    });
```

`row.side`·`row.positionSide`를 쓰는 곳의 행 타입(Prisma 결과)은 스키마에 칸이 생겨 자동으로 맞는다.

- [ ] **Step 4: 통과 확인**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, 타입 오류 없음

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/order/conditional-order.service.ts apps/api/src/order/__tests__
git commit -m "feat: 선물 손절·익절 예약을 롱/숏 방향별로"
```

---

### Task 7: 서버 문구 번역·API 문서

**Files:**
- Modify: `packages/shared/src/server-messages.ts`
- Modify: `docs/api.md`

- [ ] **Step 1: 서버 문구 추가** — `server-messages.ts`의 선물 문구 근처(`포지션이 있는 동안에는 레버리지를…` 줄 아래)에:

```ts
  ["선물 주문은 롱/숏 방향이 필요합니다", "Futures orders need a long/short side", "先物注文にはロング/ショートの指定が必要です"],
  ["봇 계정은 롱/숏 방향 없이 주문합니다", "Bot accounts order without a long/short side", "ボット口座はロング/ショートを指定せずに注文します"],
  ["롱/숏 방향은 선물 주문에만 씁니다", "A long/short side is only used for futures orders", "ロング/ショートの指定は先物注文でのみ使います"],
  ["positionSide는 LONG/SHORT", "positionSide must be LONG or SHORT", "positionSideはLONG/SHORTです"],
  ["청산 가능 수량이 부족합니다", "Not enough quantity to close", "決済可能数量が不足しています"],
```

- [ ] **Step 2: 빠진 번역 확인**

Run: `cd apps/web && node scripts/i18n-missing.mjs --server`
Expected: 새 문구가 빠진 목록에 없음

- [ ] **Step 3: docs/api.md 갱신**

- `POST /orders` 행 설명에 `positionSide?: "LONG"|"SHORT"` — 사람 계정의 선물 주문 필수(매수+LONG 롱 진입, 매도+LONG 롱 청산, 매도+SHORT 숏 진입, 매수+SHORT 숏 청산), 봇·옵션·현물은 없음. 청산은 증거금 0, 청산 가능 수량 초과 422.
- `GET /account/futures`의 `positions` 모양을 `{symbol,positionSide:LONG|SHORT|NET,qty(±),closableQty,avgPrice,markPrice,unrealized,marginHeld,maintenanceMargin,leverage}`로, "사람 계정은 롱·숏이 따로 두 행" 문장 추가.
- `POST /account/futures/leverage`에 "롱·숏이 같은 레버리지, 어느 방향이든 포지션·미체결이 있으면 422".
- 조건부 주문 행에 "사람 계정 선물 예약은 매도 = 롱 청산, 매수 = 숏 청산으로 저장(`positionSide`)".

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/server-messages.ts docs/api.md
git commit -m "docs: 선물 양방향 주문 API·서버 문구 번역"
```

---

### Task 8: 웹 — 타입·주문 패널(진입/청산 탭)

**Files:**
- Modify: `apps/web/src/lib/futures.ts` (`FuturesAccount.positions` 타입)
- Modify: `apps/web/src/components/FuturesOrderPanel.tsx`
- Modify: `apps/web/src/lib/i18n/messages.ts`

**Interfaces:**
- Consumes: `/account/futures` `positions[].positionSide`, `closableQty` (Task 5); `POST /orders`의 `positionSide` (Task 3).
- Produces: `FuturesAccount.positions[]`에 `positionSide: "LONG" | "SHORT" | "NET"`, `closableQty: number` (Task 9가 씀). `FuturesOrderPanel` props는 그대로(`initialSide`는 처음 고를 방향: BUY → 롱, SELL → 숏).

- [ ] **Step 1: 타입** — `apps/web/src/lib/futures.ts`의 `FuturesAccount.positions` 항목에:

```ts
    /** LONG/SHORT(사람 계정 양방향), NET(봇) */
    positionSide: "LONG" | "SHORT" | "NET";
    /** 지금 청산 주문을 더 낼 수 있는 계약 수(보유 − 걸린 청산 미체결) */
    closableQty: number;
```

- [ ] **Step 2: 주문 패널 수정** — `FuturesOrderPanel.tsx`

상태·계산 부분(`const [side, setSide] = …`부터 `const closingOnly = …`까지, 그리고 `sizingBase`~`emergencyUnits`, `submit`)을 다음으로 바꾼다. 레버리지 블록, 가격·수량 입력, 수수료 안내(`TradingFeeNotice`), 로그인 분기는 그대로 둔다.

```tsx
  type Mode = "OPEN" | "CLOSE";
  type Dir = "LONG" | "SHORT";
  const [mode, setMode] = useState<Mode>("OPEN");
  // 청산 탭의 % 버튼·예상 실현손익 기준 방향. 처음엔 시트를 연 버튼(매수 → 롱, 매도 → 숏).
  const [dir, setDir] = useState<Dir>(initialSide === "BUY" ? "LONG" : "SHORT");
```

`leverage`/`positionRow` 계산을:

```tsx
  const leverage = futures?.leverage?.[symbol] ?? null;
  const rowOf = (d: Dir) => futures?.positions.find((p) => p.symbol === symbol && p.positionSide === d) ?? null;
  const longRow = rowOf("LONG");
  const shortRow = rowOf("SHORT");
  const held = { LONG: longRow?.qty ?? 0, SHORT: Math.abs(shortRow?.qty ?? 0) };
  const closable = { LONG: longRow?.closableQty ?? 0, SHORT: shortRow?.closableQty ?? 0 };
  // 포지션·미체결이 있으면 레버리지를 못 바꾼다(서버도 막는다).
  const leverageLocked = held.LONG > 0 || held.SHORT > 0 || liveOrders > 0;
  // 청산 탭을 열었는데 고른 방향에 포지션이 없고 반대쪽에 있으면 그쪽으로
  useEffect(() => {
    if (mode === "CLOSE" && held[dir] === 0) {
      const other: Dir = dir === "LONG" ? "SHORT" : "LONG";
      if (held[other] > 0) setDir(other);
    }
  }, [mode, dir, held.LONG, held.SHORT]); // eslint-disable-line react-hooks/exhaustive-deps
```

`sizingBase`~`emergencyUnits`를:

```tsx
  // 수량 % 버튼의 기준: 청산 탭이면 고른 방향의 청산 가능 수량, 진입 탭이면 주문 가능 금액으로 열 수 있는 최대 계약
  const sizingBase =
    mode === "CLOSE"
      ? Math.min(closable[dir], MAX_FUTURES_ORDER_QTY)
      : available != null && perContract != null && perContract > 0
        ? Math.min(MAX_FUTURES_ORDER_QTY, Math.floor(available / perContract))
        : 0;
  const [activePct, setActivePct] = useState<number | null>(null);
  function applyPct(pct: number) {
    if (sizingBase < 1) return;
    setQty(Math.max(1, Math.floor(sizingBase * pct)));
    setActivePct(pct);
  }
  const margin = perContract != null ? perContract * qty : null;
  const closeRow = dir === "LONG" ? longRow : shortRow;
  const closeQty = Math.min(qty, closable[dir]);
  // 청산 탭: 이 가격에 닫을 때의 실현손익(평균가 기준)
  const expectedRealized =
    mode === "CLOSE" && closeRow && closeQty > 0 && priceUnits != null
      ? (dir === "LONG" ? 1 : -1) * (priceUnits - closeRow.avgPrice) * closeQty * def.unitValue
      : null;
  // 진입 탭: 긴급 반대매매(평가손실 = 증거금 90%) 예상 가격 — 롱은 아래, 숏은 위
  const emergencyMove =
    mode === "OPEN" && priceUnits != null
      ? (priceUnits * (leverage != null ? Math.ceil(10_000 / leverage) : def.initialMarginBps) * FUTURES_EMERGENCY_LOSS_BPS) / 10_000 / 10_000
      : null;
```

`submit`을 방향을 받도록:

```tsx
  async function submit(target: Dir) {
    if (invalidPrice) return;
    const orderSide = mode === "OPEN" ? (target === "LONG" ? "BUY" : "SELL") : target === "LONG" ? "SELL" : "BUY";
    const label = tr(mode === "OPEN" ? (target === "LONG" ? "롱 진입" : "숏 진입") : target === "LONG" ? "롱 청산" : "숏 청산");
    setBusy(true);
    setMessage(null);
    try {
      await api("/orders", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        body: { symbol, side: orderSide, positionSide: target, type, qty, ...(type === "LIMIT" ? { price: priceUnits } : {}) },
      });
      setMessage({ ok: true, text: tr("{label} {n}계약 주문을 접수했습니다", { label, n: qty }) });
      refreshAccount();
      onPlaced();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : tr("주문에 실패했습니다") });
    } finally {
      setBusy(false);
    }
  }
```

JSX: 기존 매수/매도 탭(`grid grid-cols-2 … (["BUY", "SELL"] as const)`) 자리에 진입/청산 탭:

```tsx
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2/60 p-1" role="tablist">
        {(["OPEN", "CLOSE"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => { setMode(m); setActivePct(null); }}
            className={`min-h-10 rounded-lg text-sm font-semibold transition-colors ${mode === m ? "bg-surface-3 text-ink" : "text-ink-muted"}`}
          >
            {m === "OPEN" ? tr("진입") : tr("청산")}
          </button>
        ))}
      </div>
      {mode === "CLOSE" && (
        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={tr("청산할 포지션")}>
          {(["LONG", "SHORT"] as const).map((d) => (
            <button
              key={d}
              type="button"
              disabled={held[d] === 0}
              onClick={() => { setDir(d); setActivePct(null); }}
              aria-pressed={dir === d}
              className={`num rounded-lg border px-2 py-1.5 text-left text-[12px] disabled:opacity-40 ${
                dir === d ? (d === "LONG" ? "border-up/45 bg-up/10" : "border-down/45 bg-down/10") : "border-hairline-soft"
              }`}
            >
              <span className={`font-semibold ${d === "LONG" ? "text-up" : "text-down"}`}>{d === "LONG" ? tr("롱") : tr("숏")}</span>{" "}
              {tr("{n}계약", { n: held[d] })}
              <span className="block text-[11px] text-ink-faint">{tr("청산 가능 {n}계약", { n: closable[d] })}</span>
            </button>
          ))}
        </div>
      )}
```

% 버튼 위 라벨은 `{mode === "CLOSE" ? tr("청산 가능 수량 기준") : tr("주문 가능 금액 기준")}`, 활성 % 버튼 색은 청산 탭이면 `dir === "LONG" ? "border-up/45 bg-up/15 text-up" : "border-down/45 bg-down/15 text-down"`, 진입 탭이면 `"border-sky/45 bg-sky/12 text-sky"`.

`<dl>`의 첫 행:

```tsx
        <div className="flex justify-between">
          <dt className="text-ink-muted">{mode === "CLOSE" ? tr("필요 증거금 (청산 주문)") : tr("주문 예약금 (수수료 포함)")}</dt>
          <dd className="font-semibold">{mode === "CLOSE" ? tr("없음") : margin == null ? "—" : krw(margin)}</dd>
        </div>
```

(청산 주문도 수수료는 체결 때 현금에서 빠진다 — 예약금은 없음.) 예상 실현손익 행은 기존 JSX를 그대로 쓰되 조건을 `expectedRealized != null`로 두고 `n: closeQty`. 긴급 반대매매 행을:

```tsx
        {emergencyMove != null && priceUnits != null && (
          <div className="flex justify-between" title={tr("평가손실이 이 포지션 증거금의 90%가 되는 가격 — 여기에 닿으면 즉시 전량 반대매매")}>
            <dt className="text-ink-muted">{tr("긴급 반대매매가 (예상)")}</dt>
            <dd className="text-ink-muted">
              <span className="text-up">{tr("롱")}</span> {fmtFuture(symbol, Math.round(priceUnits - emergencyMove))} ·{" "}
              <span className="text-down">{tr("숏")}</span> {fmtFuture(symbol, Math.round(priceUnits + emergencyMove))}
            </dd>
          </div>
        )}
```

제출 버튼(기존 단일 버튼)을 두 개로:

```tsx
      <div className="grid grid-cols-2 gap-2">
        {(["LONG", "SHORT"] as const).map((d) => (
          <button
            key={d}
            type="button"
            disabled={busy || invalidPrice || (mode === "CLOSE" && closable[d] === 0)}
            onClick={() => void submit(d)}
            className={`min-h-11 rounded-xl text-sm font-semibold text-white disabled:opacity-50 ${d === "LONG" ? "bg-up" : "bg-down"}`}
          >
            {busy
              ? tr("주문 중…")
              : tr(mode === "OPEN" ? (d === "LONG" ? "롱 진입" : "숏 진입") : d === "LONG" ? "롱 청산" : "숏 청산")}
          </button>
        ))}
      </div>
```

더 이상 쓰지 않는 `side`/`setSide`/`closing`/`closingOnly`/`openingQty`/`emergencyUnits`/`sideTone` 변수와 관련 JSX는 지운다. 파일 머리 주석을 `선물 주문 — 레버리지, [진입|청산] 탭, 롱/숏, 지정가/시장가, 계약 수. 진입은 레버리지 증거금을 묶고, 청산은 증거금 없이 보유(청산 가능) 수량까지.`로 바꾼다.

- [ ] **Step 3: 화면 문구 번역 추가** — `messages.ts`

```ts
  "진입": ["Open", "新規"],
  "청산": ["Close", "決済"],
  "롱 진입": ["Open long", "ロング新規"],
  "숏 진입": ["Open short", "ショート新規"],
  "롱 청산": ["Close long", "ロング決済"],
  "숏 청산": ["Close short", "ショート決済"],
  "{label} {n}계약 주문을 접수했습니다": ["{label}: order for {n} contracts placed", "{label}：{n}枚の注文を受け付けました"],
  "청산할 포지션": ["Position to close", "決済するポジション"],
  "청산 가능 {n}계약": ["{n} closable", "決済可能 {n}枚"],
  "청산 가능 수량 기준": ["Based on closable quantity", "決済可能数量基準"],
```

`"롱"`, `"숏"`, `"{n}계약"`이 이미 있는지 `grep -n '"롱"\|"숏"\|"{n}계약"' apps/web/src/lib/i18n/messages.ts`로 확인하고 없으면 `"롱": ["Long", "ロング"]`, `"숏": ["Short", "ショート"]`를 추가한다.

- [ ] **Step 4: 타입체크·번역 확인**

Run: `cd apps/web && npx tsc --noEmit && node scripts/i18n-missing.mjs`
Expected: 타입 오류 없음(FuturesPositionPanel이 새 필드를 아직 안 써도 오류 아님), 빠진 번역 없음

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/futures.ts apps/web/src/components/FuturesOrderPanel.tsx apps/web/src/lib/i18n/messages.ts
git commit -m "feat: 선물 주문 패널을 진입/청산 탭 + 롱/숏으로"
```

---

### Task 9: 웹 — 포지션 카드(롱·숏 행, 일부 청산)·주문 내역 표시

**Files:**
- Modify: `apps/web/src/components/FuturesPositionPanel.tsx`
- Modify: `apps/web/src/components/FuturesPositionActions.tsx`
- Modify: `apps/web/src/app/orders/page.tsx` (`OrderRow`, 주문 표의 매수/매도 표시)
- Modify: `apps/web/src/lib/i18n/messages.ts`

**Interfaces:**
- Consumes: Task 8 `FuturesAccount.positions[].positionSide/closableQty`.
- Produces: `FuturesPositionActions` props에 `positionSide: "LONG" | "SHORT" | "NET"`, `closableQty: number`.

- [ ] **Step 1: 포지션 카드를 방향별 행으로** — `FuturesPositionPanel.tsx`

`const position = account?.positions.find((p) => p.symbol === symbol) ?? null;`를:

```tsx
  // 사람 계정은 같은 종목에 롱·숏 두 행이 있을 수 있다 — 롱 먼저
  const positions = (account?.positions ?? [])
    .filter((p) => p.symbol === symbol && p.qty !== 0)
    .sort((a, b) => b.qty - a.qty);
```

`{position ? (<dl …>…</dl>) : (<p>…포지션이 없습니다</p>)}`와 그 아래 `{position && (<FuturesPositionActions …/>)}`를 한 덩어리로 바꾼다:

```tsx
        {positions.length === 0 ? (
          <p className="text-ink-faint">{t("{name} 포지션이 없습니다.", { name: names.future(def.symbol, def.name) })}</p>
        ) : (
          positions.map((position) => (
            <div key={position.positionSide} className="space-y-3 rounded-xl border border-hairline-soft p-3">
              {/* 기존 <dl className="num grid grid-cols-2 …"> … </dl> 를 그대로 옮긴다(position 변수 그대로) */}
              <FuturesPositionActions
                symbol={symbol}
                qty={position.qty}
                positionSide={position.positionSide}
                closableQty={position.closableQty}
                markPrice={position.markPrice}
                avgPrice={position.avgPrice}
                refreshKey={refreshKey}
                onChanged={load}
              />
            </div>
          ))
        )}
```

- [ ] **Step 2: 일부 청산** — `FuturesPositionActions.tsx`

props 타입에 추가:

```tsx
  /** LONG/SHORT(양방향), NET(봇) — 청산 주문에 그대로 싣는다 */
  positionSide: "LONG" | "SHORT" | "NET";
  /** 지금 청산 주문을 낼 수 있는 계약 수 */
  closableQty: number;
```

`confirming`/`closeAll` 대신 수량 청산:

```tsx
  const [closeQty, setCloseQty] = useState(1);
  useEffect(() => setCloseQty((q) => Math.max(1, Math.min(q, closableQty || 1))), [closableQty]);
  const hedge = positionSide !== "NET";

  function closePart() {
    const n = Math.min(closeQty, closableQty);
    if (n < 1) return;
    void run(
      () =>
        api("/orders", {
          method: "POST",
          headers: { "idempotency-key": newIdempotencyKey() },
          body: { symbol, side: closeSide, type: "MARKET", qty: n, ...(hedge ? { positionSide } : {}) },
        }),
      t("{n}계약 시장가 청산을 접수했습니다", { n }),
    );
  }
```

두 번 누르기 확인(`confirming` 상태·타이머 effect)과 `closeAll`은 지운다. 청산 버튼 JSX를:

```tsx
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-ink-muted">
          <span>{t("청산 수량 (계약)")}</span>
          <span className="num text-[11px] text-ink-faint">{t("청산 가능 {n}계약", { n: closableQty })}</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            inputMode="numeric"
            value={closeQty}
            onChange={(e) => setCloseQty(Math.max(1, Math.min(closableQty || 1, Number(e.target.value.replace(/\D/g, "")) || 1)))}
            className="num w-20 rounded-lg border border-hairline bg-surface-2/60 px-2.5 py-1.5 text-center"
          />
          <div className="grid flex-1 grid-cols-4 gap-1">
            {[0.25, 0.5, 0.75, 1].map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={closableQty < 1}
                onClick={() => setCloseQty(Math.max(1, Math.floor(closableQty * pct)))}
                className="num rounded-md py-1 text-[11px] ring-1 ring-hairline ring-inset disabled:opacity-40"
              >
                {pct * 100}%
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={busy || closableQty < 1}
          onClick={closePart}
          className={`mt-2 min-h-10 w-full rounded-xl text-sm font-semibold text-white disabled:opacity-50 ${long ? "bg-down" : "bg-up"}`}
        >
          {t("{n}계약 시장가 청산", { n: Math.min(closeQty, closableQty) })}
        </button>
      </div>
```

손절·익절 안내 문구 `"…전량 시장가 청산)"`은 그대로 두되 요청 qty는 `Math.abs(qty)` 그대로(서버가 사람 계정 선물 예약의 방향을 매도 = 롱, 매수 = 숏으로 정한다). 걸려 있는 예약 목록은 이 행의 청산 방향만 보이게 `loadWaiting` 결과를 거른다:

```tsx
      .then((rows) => setWaiting(rows.filter((row) => row.side === closeSide)))
```

`closeSide`는 지금처럼 `long ? "SELL" : "BUY"`(롱 행 qty > 0, 숏 행 qty < 0이라 그대로 맞다).

- [ ] **Step 3: 주문 내역 표시** — `apps/web/src/app/orders/page.tsx`

`OrderRow`에 `positionSide?: "LONG" | "SHORT" | null;`. 주문 표의 매수/매도 span을:

```tsx
              <span className={`font-medium ${o.side === "BUY" ? "text-up" : "text-down"}`}>
                {o.positionSide
                  ? t(o.positionSide === "LONG" ? (o.side === "BUY" ? "롱 진입" : "롱 청산") : o.side === "SELL" ? "숏 진입" : "숏 청산")
                  : o.side === "BUY" ? t("매수") : t("매도")}
              </span>
```

- [ ] **Step 4: 문구 추가** — `messages.ts`

```ts
  "청산 수량 (계약)": ["Close quantity (contracts)", "決済数量（枚）"],
  "{n}계약 시장가 청산": ["Close {n} contracts at market", "{n}枚を成行で決済"],
```

더 이상 쓰지 않는 `"한 번 더 누르면 시장가로 전량 청산"`, `"{n}계약 전량 청산 (시장가)"` 키는 `grep -rn` 으로 다른 사용처가 없으면 지운다.

- [ ] **Step 5: 타입체크·번역 확인**

Run: `cd apps/web && npx tsc --noEmit && node scripts/i18n-missing.mjs`
Expected: 오류 없음, 빠진 번역 없음

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/FuturesPositionPanel.tsx apps/web/src/components/FuturesPositionActions.tsx apps/web/src/app/orders/page.tsx apps/web/src/lib/i18n/messages.ts
git commit -m "feat: 선물 포지션 카드 롱·숏 행과 수량 지정 청산"
```

---

### Task 10: 전체 검증·기록

**Files:**
- Modify: `HANDOFF.md` (맨 위 기록)

- [ ] **Step 1: 전체 테스트·타입체크**

Run: `pnpm test` → `cd apps/web && npx tsc --noEmit`
Expected: 전부 PASS, 타입 오류 없음. 실패하면 그 출력으로 원인을 고친 뒤 다시.

- [ ] **Step 2: 로컬 스택 검증** — `.claude/skills/verify/SKILL.md` 레시피로 스택을 띄우고(웹은 HMR, api·settlement·bots는 재시작) 새 계정으로:

1. KABUF 숏 진입 2계약(시장가) → 포지션 카드에 숏 2.
2. 롱 진입 1계약(시장가) → 카드에 롱 1·숏 2 두 행(숏이 줄지 않음).
3. 숏 행에서 50% → 1계약 시장가 청산 → 숏 1, 주문 내역에 "숏 청산".
4. 주문 패널 청산 탭에서 롱 청산 2계약 → `청산 가능 수량이 부족합니다`.
5. 레버리지 버튼이 잠겨 있고, 전부 청산 뒤 풀린다.

Run: `pnpm smoke` → `pnpm check:consistency`
Expected: 스모크 통과(실패하면 스모크가 사람 계정 선물 주문에 `positionSide`를 안 보내는지 확인하고 `scripts/smoke.mjs`의 선물 주문에 `positionSide`를 추가), 마지막 줄 `정합성 검사 전부 통과`. 봇 로그에 선물 주문 400 오류가 없는지 확인(봇은 NET 경로).

- [ ] **Step 3: HANDOFF 기록·커밋**

`HANDOFF.md` 맨 위(`# HANDOFF` 제목 다음)에 `## 2026-09-28 — 선물 양방향(헤지) 매매·일부 청산 (로컬, 운영 미적용)` 절을 추가: 변경 요약(방향 칸·마이그레이션 `20260928090000_futures_hedge_mode`, 주문 규칙, 화면), 검증 결과, 운영 반영 시 전체 절차(점검·봇 정지·DB 백업·migrate·전 서비스 교체)가 필요하다는 점.

```bash
git add HANDOFF.md scripts/smoke.mjs
git commit -m "docs: 선물 양방향 매매 인수인계 기록"
```

(`scripts/smoke.mjs`를 고치지 않았으면 add에서 뺀다.)
