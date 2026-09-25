import { describe, expect, it } from "vitest";
import { futureDef, futureMarginPerContract, futurePositionMargin, type TradeExecutedEvent } from "@mock-kabu/shared";
import { settleFuturesTrade, type FuturesLockContext } from "./futures";

const KABUF = futureDef("KABUF")!;

/** 메모리 위의 계좌·포지션·원장·미수금 — Prisma 델리게이트 모양만 흉내 낸다. */
function fakeContext(accounts: Record<string, { balance: bigint; holdAmount: bigint }>) {
  const positions = new Map<string, { qty: number; entryValue: bigint; marginHeld: bigint; leverage?: number | null }>();
  const debts = new Map<string, bigint>();
  const ledger: { accountId: string; delta: bigint; reason: string }[] = [];
  const realized: { accountId: string; side: string; realized: bigint }[] = [];
  const key = (w: { accountId_symbol: { accountId: string; symbol: string } }) =>
    `${w.accountId_symbol.accountId}:${w.accountId_symbol.symbol}`;
  const ctx: FuturesLockContext = {
    accounts,
    async updateAccount(accountId, next) {
      accounts[accountId] = { ...next };
    },
    tx: {
      futuresPosition: {
        findUnique: async ({ where }: any) => positions.get(key(where)) ?? null,
        upsert: async ({ where, update, create }: any) => {
          const k = key(where);
          positions.set(k, positions.has(k) ? { ...positions.get(k)!, ...update } : { ...create });
        },
      },
      futuresRealized: { create: async ({ data }: any) => realized.push(data) },
      futuresDebt: {
        findUnique: async ({ where }: any) => (debts.has(where.accountId) ? { amount: debts.get(where.accountId)! } : null),
        upsert: async ({ where, update }: any) => debts.set(where.accountId, update.amount),
      },
      ledgerEntry: { create: async ({ data }: any) => ledger.push(data) },
      order: { update: async () => undefined },
    },
  };
  return { ctx, positions, debts, ledger, realized, accounts };
}

function trade(price: number, qty: number, buyer = "A", seller = "B"): TradeExecutedEvent {
  return {
    topic: "trade.executed",
    eventId: `e-${price}-${qty}`,
    tradeId: `t-${price}-${qty}`,
    symbol: "KABUF",
    price,
    qty,
    buyOrderId: "bo",
    sellOrderId: "so",
    buyerAccountId: buyer,
    sellerAccountId: seller,
    takerSide: "BUY",
    ts: 0,
  } as TradeExecutedEvent;
}

function order(price: number, qty: number) {
  return { id: "o", holdPerUnit: futureMarginPerContract(KABUF, price), status: "OPEN", qty, filledQty: 0 };
}

/** 체결 전에 주문 접수가 했을 증거금 묶음을 양쪽 계좌에 반영한 뒤 정산한다. */
async function fill(f: ReturnType<typeof fakeContext>, event: TradeExecutedEvent) {
  for (const accountId of [event.buyerAccountId, event.sellerAccountId]) {
    f.accounts[accountId].holdAmount += futureMarginPerContract(KABUF, event.price) * BigInt(event.qty);
  }
  await settleFuturesTrade(f.ctx, KABUF, event, order(event.price, event.qty), order(event.price, event.qty));
}

describe("futures settlement", () => {
  it("opening a long and a short releases the order margin and holds position margin instead", async () => {
    const f = fakeContext({ A: { balance: 10_000_000n, holdAmount: 0n }, B: { balance: 10_000_000n, holdAmount: 0n } });
    await fill(f, trade(88_000, 2));

    expect(f.positions.get("A:KABUF")).toMatchObject({ qty: 2, entryValue: 176_000n, marginHeld: futurePositionMargin(KABUF, 176_000n) });
    expect(f.positions.get("B:KABUF")!.qty).toBe(-2);
    expect(f.accounts.A).toEqual({ balance: 10_000_000n, holdAmount: 0n });
    expect(f.ledger).toHaveLength(0);
  });

  it("holds position margin at the account's chosen leverage for that symbol", async () => {
    const f = fakeContext({ A: { balance: 10_000_000n, holdAmount: 0n }, B: { balance: 10_000_000n, holdAmount: 0n } });
    // A는 KABUF 20배로 미리 설정(포지션 없는 설정 행)
    f.positions.set("A:KABUF", { qty: 0, entryValue: 0n, marginHeld: 0n, leverage: 20 });
    await fill(f, trade(88_000, 2));
    // 명목 176,000 × 100원 = 1,760만 원 → 20배면 88만 원, B는 거래소 기준(21.75%)
    expect(f.positions.get("A:KABUF")!.marginHeld).toBe(880_000n);
    expect(f.positions.get("B:KABUF")!.marginHeld).toBe(futurePositionMargin(KABUF, 176_000n));
  });

  it("closing books realized P&L to cash with a FUTURES_PNL ledger row on each side", async () => {
    const f = fakeContext({ A: { balance: 10_000_000n, holdAmount: 0n }, B: { balance: 10_000_000n, holdAmount: 0n } });
    await fill(f, trade(88_000, 1));
    // A가 885.00에 되팔고, B가 885.00에 되사 청산: A +500단위×100원 = +5만, B −5만
    await fill(f, trade(88_500, 1, "B", "A"));

    expect(f.positions.get("A:KABUF")).toMatchObject({ qty: 0, entryValue: 0n, marginHeld: 0n });
    expect(f.accounts.A.balance).toBe(10_050_000n);
    expect(f.accounts.B.balance).toBe(9_950_000n);
    expect(f.ledger.map((l) => [l.accountId, l.delta, l.reason])).toEqual([
      ["B", -50_000n, "FUTURES_PNL"],
      ["A", 50_000n, "FUTURES_PNL"],
    ]);
    expect(f.realized.map((r) => [r.accountId, r.realized])).toEqual([["B", -50_000n], ["A", 50_000n]]);
  });

  it("a loss beyond the whole balance drains cash to zero and records the rest as debt", async () => {
    const f = fakeContext({ A: { balance: 2_000_000n, holdAmount: 0n }, B: { balance: 100_000_000n, holdAmount: 0n } });
    await fill(f, trade(88_000, 1));
    // A 롱 880.00 → 600.00에 청산: −28,000단위 × 100원 = −280만 원. 청산 주문 증거금은 체결 때 풀리므로
    // 현금 200만 원 전부를 내고 남은 80만 원이 미수금.
    await fill(f, trade(60_000, 1, "B", "A"));

    expect(f.accounts.A).toEqual({ balance: 0n, holdAmount: 0n });
    expect(f.debts.get("A")).toBe(800_000n);
    expect(f.ledger.find((l) => l.accountId === "A")!.delta).toBe(-2_000_000n);
    expect(f.realized.find((r) => r.accountId === "A")!.realized).toBe(-2_800_000n);
  });

  it("a self-trade nets to a flat position and no cash movement", async () => {
    const f = fakeContext({ A: { balance: 10_000_000n, holdAmount: 0n } });
    await fill(f, trade(88_000, 1, "A", "A"));
    expect(f.positions.get("A:KABUF")).toMatchObject({ qty: 0, entryValue: 0n, marginHeld: 0n });
    expect(f.accounts.A).toEqual({ balance: 10_000_000n, holdAmount: 0n });
  });
});
